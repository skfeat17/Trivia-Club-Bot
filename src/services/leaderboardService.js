const redis = require("./pierroRedis");

const ACTIVITY_KEY = "pierro:stats:trivia:activity";
const ACTIVITY_DATA_PREFIX = "pierro:stats:trivia:activity:data:";

const SPENDING_KEY = "pierro:leaderboard:trivia:spending";
const SPENDING_DATA_PREFIX = "pierro:leaderboard:trivia:spending:data:";
const SPENDING_TXN_GUARD_PREFIX = "pierro:leaderboard:trivia:spending:paid:";
const LIFETIME_SPENDING_KEY = "pierro:leaderboard:trivia:spending:lifetime";

const RETENTION_SECONDS = 400 * 24 * 60 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 330 * 60 * 1000;

function parseRedisValue(value) {
    if (value == null) return null;

    if (typeof value === "object") return value;

    if (typeof value !== "string") return null;

    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

function getDateKey(timestamp = Date.now()) {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(new Date(timestamp));

    const p = Object.fromEntries(parts.map(x => [x.type, x.value]));

    return `${p.year}-${p.month}-${p.day}`;
}

function startOfISTDate(dateKey) {
    const [year, month, day] = dateKey.split("-").map(Number);

    return Date.UTC(year, month - 1, day) - IST_OFFSET_MS;
}

function shiftDate(dateKey, days) {
    const [year, month, day] = dateKey.split("-").map(Number);

    const date = new Date(Date.UTC(year, month - 1, day + days));

    return [
        date.getUTCFullYear(),
        String(date.getUTCMonth() + 1).padStart(2, "0"),
        String(date.getUTCDate()).padStart(2, "0"),
    ].join("-");
}

function startOfWeekIST(now = Date.now()) {
    const today = getDateKey(now);

    const weekday = new Date(
        startOfISTDate(today) + IST_OFFSET_MS
    ).getUTCDay();

    return startOfISTDate(
        shiftDate(today, -((weekday + 6) % 7))
    );
}

function startOfMonthIST(now = Date.now()) {
    const [year, month] = getDateKey(now).split("-").map(Number);

    return Date.UTC(year, month - 1, 1) - IST_OFFSET_MS;
}

/**
 * Fetch activity records from Redis.
 *
 * Missing detail records are ignored.
 */
async function getTriviaActivityRecords(start, end) {
    const ids = await redis.zrange(
        ACTIVITY_KEY,
        start,
        end,
        { byScore: true }
    );

    if (!Array.isArray(ids) || ids.length === 0) {
        return [];
    }

    const records = [];

    const BATCH_SIZE = 50;

    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
        const batch = ids.slice(i, i + BATCH_SIZE);

        const raw = await Promise.all(
            batch.map(id =>
                redis.get(`${ACTIVITY_DATA_PREFIX}${id}`)
            )
        );

        for (const value of raw) {
            const record = parseRedisValue(value);

            if (!record || typeof record !== "object") continue;

            const timestamp = Number(record.timestamp);
            const mora = Math.max(0, Number(record.mora) || 0);

            if (
                !Number.isFinite(timestamp) ||
                timestamp < start ||
                timestamp > end
            ) {
                continue;
            }

            if (!record.userId) continue;

            records.push({
                activityId: String(record.activityId || ""),
                userId: String(record.userId),
                result: String(record.result || "").toLowerCase(),
                mora,
                timestamp,
            });
        }
    }

    return records;
}

/**
 * Apply rolling 24-hour cooldown.
 *
 * Rules:
 * - Only correct answers consume cooldown.
 * - First correct win is accepted.
 * - Further correct wins within 24 hours are excluded.
 * - After 24 hours, the next correct win is accepted.
 * - Cooldown is based on activity timestamp, not payment timestamp.
 *
 * IMPORTANT:
 * Records are processed chronologically before any date filtering.
 */
function applyWinCooldown(records) {
    const sorted = [...records].sort(
        (a, b) => a.timestamp - b.timestamp
    );

    const lastAcceptedWin = new Map();
    const accepted = [];
    const excluded = [];

    for (const record of sorted) {
        if (record.result !== "correct") continue;

        const previous = lastAcceptedWin.get(record.userId);

        if (
            previous !== undefined &&
            record.timestamp - previous < DAY_MS
        ) {
            excluded.push(record);
            continue;
        }

        lastAcceptedWin.set(record.userId, record.timestamp);

        accepted.push(record);
    }

    return {
        accepted,
        excluded,
    };
}

/**
 * Get all available activity records and apply cooldown.
 *
 * We intentionally fetch the complete retained history before
 * filtering by date. This prevents period-boundary errors.
 */
async function getAcceptedTriviaWins(now = Date.now()) {
    const retentionStart = now - RETENTION_SECONDS * 1000;

    const records = await getTriviaActivityRecords(
        retentionStart,
        now
    );

    return applyWinCooldown(records);
}

/**
 * TOP 10 MORA EARNERS
 */
async function getTopEarners(limit = 10) {
    const { accepted } = await getAcceptedTriviaWins();

    const totals = new Map();

    for (const record of accepted) {
        if (record.mora <= 0) continue;

        totals.set(
            record.userId,
            (totals.get(record.userId) || 0) + record.mora
        );
    }

    return [...totals.entries()]
        .map(([userId, mora]) => ({
            userId,
            mora,
        }))
        .sort((a, b) => b.mora - a.mora)
        .slice(0, Math.max(1, Math.min(10, Number(limit) || 10)));
}

/**
 * Record an outgoing Mora payment once.
 * Kept for existing economy integration.
 */
async function recordMoraSpent(
    userId,
    amount,
    source = "unknown",
    timestamp = Date.now(),
    transactionId = null
) {
    const value = Number(amount);

    if (!userId) {
        throw new Error("userId is required");
    }

    if (!String(source).toLowerCase().includes("trivia")) {
        return {
            ignored: true,
            reason: "non_trivia_source",
        };
    }

    if (!Number.isFinite(value) || value <= 0) {
        throw new Error("amount must be a positive number");
    }

    const id = transactionId
        ? String(transactionId)
        : `${timestamp}:${userId}:${Math.random().toString(36).slice(2, 10)}`;

    if (transactionId) {
        const lock = await redis.set(
            `${SPENDING_TXN_GUARD_PREFIX}${id}`,
            "1",
            { nx: true }
        );

        if (lock !== "OK") {
            return {
                duplicate: true,
                id,
            };
        }
    }

    const record = {
        id,
        userId: String(userId),
        amount: value,
        source: String(source),
        timestamp: Number(timestamp),
    };

    await Promise.all([
        redis.zadd(SPENDING_KEY, {
            score: record.timestamp,
            member: id,
        }),

        redis.set(
            `${SPENDING_DATA_PREFIX}${id}`,
            JSON.stringify(record),
            { ex: RETENTION_SECONDS }
        ),

        redis.expire(SPENDING_KEY, RETENTION_SECONDS),

        redis.incrbyfloat(LIFETIME_SPENDING_KEY, value),
    ]);

    return record;
}

const sum = records =>
    records.reduce(
        (total, record) => total + (Number(record.mora) || 0),
        0
    );

/**
 * Filter accepted wins by timestamp.
 */
function filterByRange(records, start, end) {
    return records.filter(
        record =>
            record.timestamp >= start &&
            record.timestamp <= end
    );
}

/**
 * MORA EARNED SUMMARY
 *
 * Every period uses the same cooldown-filtered records.
 */
async function getSpendingSummary(now = Date.now()) {
    const { accepted } = await getAcceptedTriviaWins(now);

    const last24 = filterByRange(
        accepted,
        now - DAY_MS,
        now
    );

    const week = filterByRange(
        accepted,
        startOfWeekIST(now),
        now
    );

    const month = filterByRange(
        accepted,
        startOfMonthIST(now),
        now
    );

    return {
        last24Hours: sum(last24),
        thisWeek: sum(week),
        thisMonth: sum(month),

        // Lifetime means all available retained activity.
        lifetime: sum(accepted),
    };
}

/**
 * DAILY MORA EARNED GRAPH
 */
async function getDailySpendingSeries(
    now = Date.now(),
    days = 30
) {
    const count = Math.max(
        1,
        Math.min(90, Number(days) || 30)
    );

    const todayKey = getDateKey(now);

    const dateKeys = Array.from(
        { length: count },
        (_, index) =>
            shiftDate(todayKey, index - (count - 1))
    );

    const firstDayStart = startOfISTDate(dateKeys[0]);
    const endExclusive = startOfISTDate(
        shiftDate(todayKey, 1)
    );

    // Fetch all retained history first to apply cooldown correctly.
    const { accepted } = await getAcceptedTriviaWins(now);

    const windowRecords = filterByRange(
        accepted,
        firstDayStart,
        endExclusive - 1
    );

    const totals = new Map(
        dateKeys.map(date => [date, 0])
    );

    for (const record of windowRecords) {
        if (record.mora <= 0) continue;

        const date = getDateKey(record.timestamp);

        if (totals.has(date)) {
            totals.set(
                date,
                totals.get(date) + record.mora
            );
        }
    }

    return dateKeys.map(date => ({
        date,
        mora: totals.get(date) || 0,
    }));
}

/**
 * ATTEMPT STATISTICS
 *
 * Attempts remain raw activity counts.
 * Correct/incorrect counts are not cooldown-filtered.
 */
async function getTriviaSummary(now = Date.now()) {
    const records = await getTriviaActivityRecords(
        now - DAY_MS,
        now
    );

    return {
        attempts24Hours: records.length,

        correct24Hours: records.filter(
            record => record.result === "correct"
        ).length,

        incorrect24Hours: records.filter(
            record => record.result === "incorrect"
        ).length,

        uniquePlayers24Hours: new Set(
            records.map(record => record.userId)
        ).size,
    };
}

/**
 * Original payment backfill retained.
 * Not used for leaderboard earnings.
 */
async function backfillHistoricalPayments() {
    let cursor = "0";

    let scanned = 0;
    let imported = 0;
    let skipped = 0;

    do {
        const page = await redis.scan(cursor, {
            match: "pierro:payment:transaction:*",
            count: 100,
        });

        cursor = String(page?.[0] ?? "0");

        const keys = Array.isArray(page?.[1])
            ? page[1]
            : [];

        if (keys.length) {
            const transactions = await Promise.all(
                keys.map(key => redis.get(key))
            );

            for (const raw of transactions) {
                scanned++;

                const transaction = parseRedisValue(raw);

                if (
                    !transaction ||
                    transaction.status !== "paid" ||
                    !transaction.transactionId ||
                    !transaction.winnerId ||
                    !String(transaction.game || "")
                        .toLowerCase()
                        .includes("trivia") ||
                    Number(transaction.reward) <= 0
                ) {
                    skipped++;
                    continue;
                }

                const result = await recordMoraSpent(
                    transaction.winnerId,
                    transaction.reward,
                    "permanent_trivia_reward_historical",
                    Number(
                        transaction.paidAt ||
                        transaction.updatedAt ||
                        transaction.createdAt ||
                        Date.now()
                    ),
                    transaction.transactionId
                );

                if (result?.duplicate) skipped++;
                else imported++;
            }
        }
    } while (cursor !== "0");

    return {
        scanned,
        imported,
        skipped,
    };
}

/**
 * Original spending ledger recalculation retained.
 * Not used for Permanent Trivia earnings.
 */
async function recalculateTriviaLifetimeSpending() {
    const ids = await redis.zrange(
        SPENDING_KEY,
        0,
        -1
    );

    const rawRecords = await Promise.all(
        (Array.isArray(ids) ? ids : []).map(id =>
            redis.get(`${SPENDING_DATA_PREFIX}${id}`)
        )
    );

    const records = rawRecords
        .map(parseRedisValue)
        .filter(record =>
            record &&
            String(record.source || "")
                .toLowerCase()
                .includes("trivia") &&
            Number(record.amount) > 0
        );

    const total = records.reduce(
        (sum, record) => sum + Number(record.amount || 0),
        0
    );

    await redis.set(
        LIFETIME_SPENDING_KEY,
        String(total)
    );

    return {
        indexedTransactions: Array.isArray(ids)
            ? ids.length
            : 0,

        triviaTransactions: records.length,

        lifetimeTriviaSpending: total,
    };
}

module.exports = {
    getTopEarners,
    recordMoraSpent,
    getSpendingSummary,
    getDailySpendingSeries,
    getTriviaSummary,
    backfillHistoricalPayments,
    recalculateTriviaLifetimeSpending,

    // Available for testing/debugging.
    getAcceptedTriviaWins,
    applyWinCooldown,
};