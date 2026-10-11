
const redis = require("./pierroRedis");

const VALID_RESULTS = new Set([
    "correct",
    "incorrect",
]);

const STATS_TTL_SECONDS =
    400 * 24 * 60 * 60;

const DAY_MS =
    24 * 60 * 60 * 1000;

const ACTIVITY_KEY =
    "pierro:stats:trivia:activity";

const DAYS_KEY =
    "pierro:stats:trivia:days";

const GLOBAL_KEY =
    "pierro:stats:trivia:global";

function userStatsKey(userId) {
    return `pierro:stats:trivia:user:${userId}`;
}

function dailyStatsKey(dateKey) {
    return `pierro:stats:trivia:day:${dateKey}`;
}

function userCooldownKey(userId) {
    return `pierro:stats:trivia:cooldowns:${userId}`;
}

function activityDataKey(activityId) {
    return `pierro:stats:trivia:activity:data:${activityId}`;
}

function parseNumber(value) {
    const number = Number(value || 0);

    return Number.isFinite(number)
        ? number
        : 0;
}
function parseRedisValue(value) {
    if (value == null) return null;

    // Upstash may already return a parsed object.
    if (typeof value === "object") {
        return value;
    }

    if (typeof value === "string") {
        try {
            return JSON.parse(value);
        } catch (error) {
            console.error("❌ REDIS JSON PARSE FAILED:", error.message);
            return null;
        }
    }

    return null;
}
function getDateKey(timestamp = Date.now()) {
    const parts = new Intl.DateTimeFormat(
        "en-CA",
        {
            timeZone: "Asia/Kolkata",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
        }
    ).formatToParts(new Date(timestamp));

    const values = Object.fromEntries(
        parts.map(part => [
            part.type,
            part.value,
        ])
    );

    return (
        `${values.year}-` +
        `${values.month}-` +
        `${values.day}`
    );
}

function getDateOffset(dateKey, daysBack) {
    const [year, month, day] =
        dateKey.split("-").map(Number);

    const date = new Date(
        Date.UTC(
            year,
            month - 1,
            day - daysBack
        )
    );

    return [
        date.getUTCFullYear(),
        String(
            date.getUTCMonth() + 1
        ).padStart(2, "0"),
        String(
            date.getUTCDate()
        ).padStart(2, "0"),
    ].join("-");
}

function startOfIndiaDate(dateKey) {
    const [year, month, day] =
        dateKey.split("-").map(Number);

    return (
        Date.UTC(
            year,
            month - 1,
            day
        ) - 330 * 60 * 1000
    );
}

function endOfIndiaDate(dateKey) {
    return (
        startOfIndiaDate(dateKey) +
        DAY_MS -
        1
    );
}

function calculateAverageMora(
    mora,
    attempts
) {
    if (attempts <= 0) {
        return 0;
    }

    return Number(
        (mora / attempts).toFixed(2)
    );
}

/**
 * Record one trivia attempt.
 *
 * The returned activityId can be passed to recordMora()
 * to associate a reward with this particular attempt.
 */
async function recordParticipation(
    userId,
    result,
    timestamp = Date.now()
) {
    if (!userId) {
        throw new Error(
            "userId is required."
        );
    }

    if (!VALID_RESULTS.has(result)) {
        throw new Error(
            `Invalid trivia result: ${result}`
        );
    }

    const dateKey =
        getDateKey(timestamp);

    const activityId =
        `${timestamp}:${userId}:` +
        Math.random()
            .toString(36)
            .slice(2, 10);

    const activityRecord = {
        activityId,
        userId: String(userId),
        result,
        mora: 0,
        timestamp,
    };

    await Promise.all([
        redis.hincrby(
            userStatsKey(userId),
            result,
            1
        ),

        redis.hincrby(
            userStatsKey(userId),
            "total",
            1
        ),

        redis.hincrby(
            dailyStatsKey(dateKey),
            result,
            1
        ),

        redis.hincrby(
            dailyStatsKey(dateKey),
            "total",
            1
        ),

        redis.sadd(
            DAYS_KEY,
            dateKey
        ),

        redis.zadd(
            ACTIVITY_KEY,
            {
                score: timestamp,
                member: activityId,
            }
        ),

        redis.set(
            activityDataKey(activityId),
            JSON.stringify(activityRecord),
            {
                ex: STATS_TTL_SECONDS,
            }
        ),

        redis.expire(
            userStatsKey(userId),
            STATS_TTL_SECONDS
        ),

        redis.expire(
            dailyStatsKey(dateKey),
            STATS_TTL_SECONDS
        ),

        redis.expire(
            DAYS_KEY,
            STATS_TTL_SECONDS
        ),

        redis.expire(
            ACTIVITY_KEY,
            STATS_TTL_SECONDS
        ),
    ]);

    return {
        userId: String(userId),
        result,
        dateKey,
        timestamp,
        activityId,
    };
}

/**
 * Record Mora awarded for trivia.
 *
 * Pass activityId from recordParticipation() whenever
 * possible so the reward is attached to the correct attempt.
 *
 * Without activityId, Mora is still included in the daily
 * total but cannot be assigned accurately to a rolling
 * 24-hour window.
 */
async function recordMora(
    userId,
    amount,
    activityId = null,
    timestamp = Date.now()
) {
    if (!userId) {
        throw new Error(
            "userId is required."
        );
    }

    const value = Number(amount);

    if (
        !Number.isFinite(value) ||
        value <= 0
    ) {
        return;
    }

    const dateKey =
        getDateKey(timestamp);

    const operations = [
        redis.hincrby(
            userStatsKey(userId),
            "mora",
            value
        ),

        redis.hincrby(
            dailyStatsKey(dateKey),
            "mora",
            value
        ),

        redis.expire(
            userStatsKey(userId),
            STATS_TTL_SECONDS
        ),

        redis.expire(
            dailyStatsKey(dateKey),
            STATS_TTL_SECONDS
        ),
    ];

    if (activityId) {
        operations.push(
            updateActivityMora(
                userId,
                activityId,
                value
            )
        );
    }

    await Promise.all(operations);
}

/**
 * Attach Mora to a specific trivia attempt.
 */
async function updateActivityMora(
    userId,
    activityId,
    amount
) {
    const key =
        activityDataKey(activityId);

    const raw =
        await redis.get(key);

    if (!raw) {
        throw new Error(
            "Trivia activity record not found."
        );
    }

    const record =
        parseRedisValue(raw);

    if (
        String(record.userId) !==
        String(userId)
    ) {
        throw new Error(
            "Trivia activity belongs to another user."
        );
    }

    record.mora =
        parseNumber(record.mora) +
        amount;

    await redis.set(
        key,
        JSON.stringify(record),
        {
            ex: STATS_TTL_SECONDS,
        }
    );
}

/**
 * Record a cooldown start.
 */
async function recordCooldown(userId) {
    if (!userId) {
        throw new Error(
            "userId is required."
        );
    }

    await Promise.all([
        redis.incr(
            userCooldownKey(userId)
        ),

        redis.hincrby(
            GLOBAL_KEY,
            "cooldownsStarted",
            1
        ),

        redis.expire(
            userCooldownKey(userId),
            STATS_TTL_SECONDS
        ),
    ]);
}

/**
 * Retrieve activity records for a time window.
 */
async function getActivityRecords(
    start,
    end,
    userId = null
) {
    const members = await redis.zrange(
        ACTIVITY_KEY,
        start,
        end,
        {
            byScore: true,
        }
    );

    if (
        !Array.isArray(members) ||
        members.length === 0
    ) {
        return [];
    }

    const rawRecords = await Promise.all(
        members.map(member =>
            redis.get(
                activityDataKey(member)
            )
        )
    );

    const records = [];

    for (const raw of rawRecords) {
        if (!raw) {
            continue;
        }

        try {
            const record = parseRedisValue(raw);

            if (!record || typeof record !== "object") {
                continue;
            }

            if (
                userId &&
                String(record.userId) !==
                String(userId)
            ) {
                continue;
            }

            records.push({
                activityId:
                    record.activityId,
                userId:
                    String(record.userId),
                result:
                    record.result,
                mora:
                    parseNumber(record.mora),
                timestamp:
                    parseNumber(record.timestamp),
            });
        } catch {
            // Ignore malformed activity records.
        }
    }

    return records;
}

/**
 * Calculate summary statistics from activity records.
 */
function summarizeRecords(
    records,
    userId = null
) {
    const total = records.length;

    const correct = records.filter(
        record =>
            record.result === "correct"
    ).length;

    const incorrect = records.filter(
        record =>
            record.result === "incorrect"
    ).length;

    const mora = records.reduce(
        (sum, record) =>
            sum + record.mora,
        0
    );

    const participants = userId
        ? (total > 0 ? 1 : 0)
        : new Set(
            records.map(
                record => record.userId
            )
        ).size;

    return {
        participants,
        total,
        correct,
        incorrect,
        mora,
        averageMora:
            calculateAverageMora(
                mora,
                total
            ),
    };
}

/**
 * Last rolling 24 hours.
 */
async function getLast24Hours(
    now = Date.now(),
    userId = null
) {
    const records =
        await getActivityRecords(
            now - DAY_MS,
            now,
            userId
        );

    return summarizeRecords(
        records,
        userId
    );
}

/**
 * Today in Asia/Kolkata.
 *
 * Activity records are used to calculate participants,
 * attempts, Mora, and averages consistently.
 */
async function getTodayStats(
    userId = null,
    now = Date.now()
) {
    const dateKey =
        getDateKey(now);

    const records =
        await getActivityRecords(
            startOfIndiaDate(dateKey),
            now,
            userId
        );

    return {
        date: dateKey,
        ...summarizeRecords(
            records,
            userId
        ),
    };
}

/**
 * Past three calendar dates, including today.
 */
async function getPastThreeDays(
    userId = null,
    now = Date.now()
) {
    const today =
        getDateKey(now);

    const dates = [
        getDateOffset(today, 2),
        getDateOffset(today, 1),
        today,
    ];

    const results = [];

    for (const date of dates) {
        const records =
            await getActivityRecords(
                startOfIndiaDate(date),
                Math.min(
                    endOfIndiaDate(date),
                    now
                ),
                userId
            );

        results.push({
            date,
            ...summarizeRecords(
                records,
                userId
            ),
        });
    }

    return results;
}

/**
 * Cooldown statistics.
 */
async function getCooldownStats(userId) {
    const value = await redis.get(
        userCooldownKey(userId)
    );

    return {
        cooldownsStarted:
            parseNumber(value),
    };
}

async function getGlobalCooldownStats() {
    const stats = await redis.hgetall(
        GLOBAL_KEY
    );

    return {
        cooldownsStarted:
            parseNumber(
                stats?.cooldownsStarted
            ),
    };
}

module.exports = {
    recordParticipation,
    recordCooldown,
    recordMora,

    getLast24Hours,
    getTodayStats,
    getPastThreeDays,

    getCooldownStats,
    getGlobalCooldownStats,

    getDateKey,
};

