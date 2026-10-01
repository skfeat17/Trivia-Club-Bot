const redis = require("./pierroRedis");
const {
    recordCooldown,
} = require("./statsService");

const COOLDOWN_SECONDS =
    24 * 60 * 60;

const PREFIX =
    "pierro:trivia:";

function cooldownKey(userId) {
    return `${PREFIX}cooldown:${userId}`;
}

const INDEX_KEY =
    `${PREFIX}cooldown:index`;

async function getCooldown(
    userId
) {
    const ttl =
        await redis.ttl(
            cooldownKey(userId)
        );

    return ttl > 0
        ? ttl
        : 0;
}

async function hasCooldown(
    userId
) {
    return (
        await getCooldown(
            userId
        )
    ) > 0;
}

async function startCooldown(
    userId,
    seconds = COOLDOWN_SECONDS
) {
    const duration =
        Math.max(
            1,
            Math.floor(
                Number(seconds) ||
                COOLDOWN_SECONDS
            )
        );

    const expiresAt =
        Date.now() +
        duration * 1000;

    await redis.set(
        cooldownKey(userId),
        {
            userId,
            createdAt:
                Date.now(),
            expiresAt,
        },
        {
            ex:
                duration,
        }
    );

    await redis.zadd(
        INDEX_KEY,
        {
            score:
                expiresAt,
            member:
                String(userId),
        }
    );

    await recordCooldown(
        userId
    );

    console.log(
        `⏳ TRIVIA COOLDOWN STARTED | User: ${userId} | Seconds: ${duration}`
    );

    return expiresAt;
}

async function removeCooldown(
    userId
) {
    await redis.del(
        cooldownKey(userId)
    );

    await redis.zrem(
        INDEX_KEY,
        String(userId)
    );
}

async function modifyCooldown(
    userId,
    seconds = COOLDOWN_SECONDS
) {
    const duration =
        Math.floor(
            Number(seconds) || 0
        );

    if (duration <= 0) {
        await removeCooldown(
            userId
        );

        return 0;
    }

    const expiresAt =
        Date.now() +
        duration * 1000;

    await redis.set(
        cooldownKey(userId),
        {
            userId,
            createdAt:
                Date.now(),
            expiresAt,
            modifiedByStaff:
                true,
        },
        {
            ex:
                duration,
        }
    );

    await redis.zadd(
        INDEX_KEY,
        {
            score:
                expiresAt,
            member:
                String(userId),
        }
    );

    return expiresAt;
}

async function clearAllCooldowns() {
    let cursor = 0;
    let deleted = 0;

    do {
        const result =
            await redis.scan(
                cursor,
                {
                    match:
                        `${PREFIX}cooldown:*`,
                    count:
                        200,
                }
            );

        let nextCursor;
        let found;

        if (
            Array.isArray(result)
        ) {
            nextCursor =
                result[0];
            found =
                result[1] || [];
        } else {
            nextCursor =
                result?.cursor ?? 0;
            found =
                result?.keys || [];
        }

        cursor =
            Number(nextCursor) || 0;

        if (
            Array.isArray(found) &&
            found.length
        ) {
            for (
                let i = 0;
                i < found.length;
                i += 100
            ) {
                const chunk =
                    found.slice(
                        i,
                        i + 100
                    );

                await redis.del(
                    ...chunk
                );

                deleted +=
                    chunk.length;
            }
        }
    } while (
        cursor !== 0
    );

    await redis.del(
        INDEX_KEY
    );

    console.log(
        `🧹 TRIVIA COOLDOWNS CLEARED | Count: ${deleted}`
    );

    return deleted;
}

async function countActiveCooldowns() {
    const now =
        Date.now();

    await redis.zremrangebyscore(
        INDEX_KEY,
        0,
        now
    );

    return Number(
        await redis.zcard(
            INDEX_KEY
        )
    );
}

async function listActiveCooldowns() {
    const now =
        Date.now();

    await redis.zremrangebyscore(
        INDEX_KEY,
        0,
        now
    );

    const entries =
        await redis.zrange(
            INDEX_KEY,
            0,
            -1,
            {
                withScores:
                    true,
            }
        );

    if (
        !Array.isArray(entries)
    ) {
        return [];
    }

    const output = [];

    for (
        let i = 0;
        i < entries.length;
        i++
    ) {
        const item =
            entries[i];

        if (
            typeof item ===
            "object"
        ) {
            output.push({
                userId:
                    item.member,
                expiresAt:
                    Number(
                        item.score
                    ),
            });
            continue;
        }

        if (
            i + 1 <
            entries.length
        ) {
            output.push({
                userId:
                    item,
                expiresAt:
                    Number(
                        entries[++i]
                    ),
            });
        }
    }

    return output
        .map(entry => ({
            ...entry,
            ttl:
                Math.max(
                    0,
                    Math.ceil(
                        (
                            entry.expiresAt -
                            Date.now()
                        ) / 1000
                    )
                ),
        }))
        .filter(
            entry =>
                entry.ttl > 0
        )
        .sort(
            (a, b) =>
                b.ttl - a.ttl
        );
}

module.exports = {
    COOLDOWN_SECONDS,
    getCooldown,
    hasCooldown,
    startCooldown,
    removeCooldown,
    modifyCooldown,
    clearAllCooldowns,
    countActiveCooldowns,
    listActiveCooldowns,
};
