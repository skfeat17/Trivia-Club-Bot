require("dotenv").config();

const { Redis } = require("@upstash/redis");


/* =========================================================
   REDIS CONNECTION
========================================================= */

const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
});


/* =========================================================
   CONSTANTS
========================================================= */

const DROP_TTL_SECONDS =
    30 * 60;

const DROP_CLAIM_LOCK_SECONDS =
    30;

const DROP_USER_COOLDOWN_SECONDS =
    20;


/* =========================================================
   KEY BUILDERS
========================================================= */

function getDropKey(eventId) {
    return `pierro:drop:${eventId}`;
}

function getDropClaimKey(eventId) {
    return `pierro:drop:claim:${eventId}`;
}

function getDropCooldownKey(userId) {
    return `pierro:drop:cooldown:${userId}`;
}


/* =========================================================
   DROP DATA
========================================================= */

async function saveDrop(drop) {

    await redis.set(
        getDropKey(drop.eventId),
        drop,
        {
            ex: DROP_TTL_SECONDS,
        }
    );

    return true;
}


async function getDrop(eventId) {

    return await redis.get(
        getDropKey(eventId)
    );
}


async function deleteDrop(eventId) {

    await redis.del(
        getDropKey(eventId)
    );

    return true;
}


/* =========================================================
   ATOMIC CLAIM
========================================================= */

async function claimMysteryDrop(
    eventId,
    userId
) {

    const result =
        await redis.set(
            getDropClaimKey(eventId),
            {
                userId,
                claimedAt: Date.now(),
            },
            {
                nx: true,
                ex: DROP_CLAIM_LOCK_SECONDS,
            }
        );

    return result === "OK";
}


/* =========================================================
   USER COOLDOWN
========================================================= */

async function getDropCooldown(userId) {

    const ttl =
        await redis.ttl(
            getDropCooldownKey(userId)
        );

    if (
        !Number.isFinite(ttl) ||
        ttl <= 0
    ) {
        return 0;
    }

    return ttl;
}


async function startDropCooldown(userId) {

    const result =
        await redis.set(
            getDropCooldownKey(userId),
            {
                startedAt: Date.now(),
            },
            {
                nx: true,
                ex: DROP_USER_COOLDOWN_SECONDS,
            }
        );

    return result === "OK";
}


/* =========================================================
   EXPORTS
========================================================= */

module.exports = {

    DROP_TTL_SECONDS,
    DROP_CLAIM_LOCK_SECONDS,
    DROP_USER_COOLDOWN_SECONDS,

    saveDrop,
    getDrop,
    deleteDrop,

    claimMysteryDrop,

    getDropCooldown,
    startDropCooldown,
};
