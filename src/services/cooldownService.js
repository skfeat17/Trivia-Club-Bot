const redis = require("./pierroRedis");

const {
    recordCooldown,
} = require("./statsService");


/* =========================================================
   COOLDOWN DURATIONS
========================================================= */

const COOLDOWN_SECONDS =
    24 * 60 * 60;

const DROP_COOLDOWN_SECONDS =
    60 * 60;


/* =========================================================
   EVENT CONFIG
========================================================= */

const EVENT_CONFIG = {
    trivia: {
        prefix: "pierro:trivia:",
        cooldownSeconds:
            COOLDOWN_SECONDS,
    },

    drop: {
        prefix: "pierro:drop:",
        cooldownSeconds:
            DROP_COOLDOWN_SECONDS,
    },
};


/* =========================================================
   HELPERS
========================================================= */

function getEventConfig(event) {

    const config =
        EVENT_CONFIG[event];

    if (!config) {
        throw new Error(
            `Unsupported cooldown event: ${event}`
        );
    }

    return config;
}


function cooldownKey(
    event,
    userId
) {
    const config =
        getEventConfig(event);

    return `${config.prefix}cooldown:${userId}`;
}


function indexKey(event) {
    const config =
        getEventConfig(event);

    return `${config.prefix}cooldown:index`;
}


/* =========================================================
   GET COOLDOWN
========================================================= */

async function getCooldown(
    event,
    userId
) {
    const ttl =
        await redis.ttl(
            cooldownKey(
                event,
                userId
            )
        );

    return ttl > 0
        ? ttl
        : 0;
}


/* =========================================================
   HAS COOLDOWN
========================================================= */

async function hasCooldown(
    event,
    userId
) {
    return (
        await getCooldown(
            event,
            userId
        )
    ) > 0;
}


/* =========================================================
   START COOLDOWN
========================================================= */

async function startCooldown(
    event,
    userId,
    seconds
) {

    const config =
        getEventConfig(event);

    const duration =
        Math.max(
            1,
            Math.floor(
                Number(
                    seconds ??
                    config.cooldownSeconds
                ) ||
                config.cooldownSeconds
            )
        );

    const expiresAt =
        Date.now() +
        duration * 1000;

    await redis.set(
        cooldownKey(
            event,
            userId
        ),
        {
            userId,
            event,
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
        indexKey(event),
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
        `⏳ ${event.toUpperCase()} COOLDOWN STARTED | User: ${userId} | Seconds: ${duration}`
    );

    return expiresAt;
}


/* =========================================================
   REMOVE COOLDOWN
========================================================= */

async function removeCooldown(
    event,
    userId
) {

    await redis.del(
        cooldownKey(
            event,
            userId
        )
    );

    await redis.zrem(
        indexKey(event),
        String(userId)
    );
}


/* =========================================================
   MODIFY COOLDOWN
========================================================= */

async function modifyCooldown(
    event,
    userId,
    seconds
) {

    const duration =
        Math.floor(
            Number(seconds) || 0
        );

    if (duration <= 0) {

        await removeCooldown(
            event,
            userId
        );

        return 0;
    }

    const expiresAt =
        Date.now() +
        duration * 1000;

    await redis.set(
        cooldownKey(
            event,
            userId
        ),
        {
            userId,
            event,
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
        indexKey(event),
        {
            score:
                expiresAt,
            member:
                String(userId),
        }
    );

    return expiresAt;
}


/* =========================================================
   CLEAR ALL COOLDOWNS FOR ONE EVENT
========================================================= */

async function clearAllCooldowns(
    event
) {

    const config =
        getEventConfig(event);

    const prefix =
        config.prefix;

    const index =
        indexKey(event);

    let cursor = 0;
    let deleted = 0;

    do {

        const result =
            await redis.scan(
                cursor,
                {
                    match:
                        `${prefix}cooldown:*`,
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
        index
    );

    console.log(
        `🧹 ${event.toUpperCase()} COOLDOWNS CLEARED | Count: ${deleted}`
    );

    return deleted;
}


/* =========================================================
   COUNT ACTIVE COOLDOWNS
========================================================= */

async function countActiveCooldowns(
    event
) {

    const now =
        Date.now();

    const index =
        indexKey(event);

    await redis.zremrangebyscore(
        index,
        0,
        now
    );

    return Number(
        await redis.zcard(
            index
        )
    );
}


/* =========================================================
   LIST ACTIVE COOLDOWNS
========================================================= */

async function listActiveCooldowns(
    event
) {

    const now =
        Date.now();

    const index =
        indexKey(event);

    await redis.zremrangebyscore(
        index,
        0,
        now
    );

    const entries =
        await redis.zrange(
            index,
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


/* =========================================================
   EXPORTS
========================================================= */

module.exports = {

    COOLDOWN_SECONDS,
    DROP_COOLDOWN_SECONDS,

    getCooldown,
    hasCooldown,

    startCooldown,
    removeCooldown,
    modifyCooldown,

    clearAllCooldowns,

    countActiveCooldowns,
    listActiveCooldowns,
};