const redis = require("./pierroRedis");

const VALID_RESULTS =
    new Set([
        "correct",
        "incorrect",
    ]);

const STATS_TTL_SECONDS =
    400 * 24 * 60 * 60;

function userStatsKey(userId) {
    return `pierro:stats:trivia:user:${userId}`;
}

function globalStatsKey() {
    return "pierro:stats:trivia:global";
}

function getDateKey(
    timestamp = Date.now()
) {
    return new Intl.DateTimeFormat(
        "en-CA",
        {
            timeZone:
                "Asia/Kolkata",
            year:
                "numeric",
            month:
                "2-digit",
            day:
                "2-digit",
        }
    ).format(
        new Date(timestamp)
    );
}

function dailyStatsKey(
    dateKey
) {
    return `pierro:stats:trivia:day:${dateKey}`;
}

async function recordParticipation(
    userId,
    result,
    timestamp = Date.now()
) {
    if (
        !VALID_RESULTS.has(result)
    ) {
        throw new Error(
            `Invalid trivia result: ${result}`
        );
    }

    if (!userId) {
        throw new Error(
            "userId is required."
        );
    }

    const dateKey =
        getDateKey(timestamp);

    const activityId =
        `${timestamp}:${userId}:` +
        Math.random()
            .toString(36)
            .slice(2, 8);

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
            globalStatsKey(),
            result,
            1
        ),

        redis.hincrby(
            globalStatsKey(),
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
            `pierro:stats:trivia:days`,
            dateKey
        ),

        redis.zadd(
            `pierro:stats:trivia:activity`,
            {
                score:
                    timestamp,
                member:
                    activityId,
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
            `pierro:stats:trivia:days`,
            STATS_TTL_SECONDS
        ),

        redis.expire(
            `pierro:stats:trivia:activity`,
            STATS_TTL_SECONDS
        ),
    ]);

    return {
        userId,
        result,
        dateKey,
        timestamp,
    };
}

async function recordCooldown(
    userId
) {
    await Promise.all([
        redis.incr(
            `pierro:stats:trivia:cooldowns:${userId}`
        ),

        redis.hincrby(
            globalStatsKey(),
            "cooldownsStarted",
            1
        ),
    ]);
}

async function recordMora(
    userId,
    amount,
    timestamp = Date.now()
) {
    const value =
        Number(amount);

    if (
        !Number.isFinite(value) ||
        value <= 0
    ) {
        return;
    }

    const dateKey =
        getDateKey(timestamp);

    await Promise.all([
        redis.hincrby(
            userStatsKey(userId),
            "mora",
            value
        ),

        redis.hincrby(
            globalStatsKey(),
            "mora",
            value
        ),

        redis.hincrby(
            dailyStatsKey(dateKey),
            "mora",
            value
        ),
    ]);
}

async function getParticipationStats(
    userId
) {
    const stats =
        await redis.hgetall(
            userStatsKey(userId)
        );

    return {
        total:
            Number(stats?.total || 0),
        correct:
            Number(stats?.correct || 0),
        incorrect:
            Number(stats?.incorrect || 0),
        mora:
            Number(stats?.mora || 0),
    };
}

async function getGlobalParticipationStats() {
    const stats =
        await redis.hgetall(
            globalStatsKey()
        );

    return {
        total:
            Number(stats?.total || 0),
        correct:
            Number(stats?.correct || 0),
        incorrect:
            Number(stats?.incorrect || 0),
        mora:
            Number(stats?.mora || 0),
    };
}

async function getCooldownStats(
    userId
) {
    const value =
        await redis.get(
            `pierro:stats:trivia:cooldowns:${userId}`
        );

    return {
        cooldownsStarted:
            Number(value || 0),
    };
}

async function getGlobalCooldownStats() {
    const stats =
        await redis.hgetall(
            globalStatsKey()
        );

    return {
        cooldownsStarted:
            Number(
                stats?.cooldownsStarted || 0
            ),
    };
}

async function getLast24Hours(
    now = Date.now()
) {
    const activity =
        await redis.zrange(
            "pierro:stats:trivia:activity",
            now - 86400000,
            now,
            {
                byScore:
                    true,
            }
        );

    return {
        totalParticipations:
            Array.isArray(activity)
                ? activity.length
                : 0,
    };
}

module.exports = {
    recordParticipation,
    recordCooldown,
    recordMora,
    getParticipationStats,
    getGlobalParticipationStats,
    getCooldownStats,
    getGlobalCooldownStats,
    getLast24Hours,
    getDateKey,
};
