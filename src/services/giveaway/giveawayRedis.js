require("dotenv").config();

const { Redis } = require("@upstash/redis");

const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
});


// ============================================================
// KEYS
// ============================================================

const ACTIVE_KEY =
    "pierro:giveaway:active";

const LOCK_KEY =
    "pierro:giveaway:lock";

const giveawayKey = (id) =>
    `pierro:giveaway:${id}`;

const participantsKey = (id) =>
    `pierro:giveaway:${id}:participants`;


// ============================================================
// ACTIVE GIVEAWAY
// ============================================================

async function getActiveGiveawayId() {
    return await redis.get(
        ACTIVE_KEY
    );
}

async function setActiveGiveawayId(id) {
    await redis.set(
        ACTIVE_KEY,
        id
    );
}

async function clearActiveGiveawayId() {
    await redis.del(
        ACTIVE_KEY
    );
}


// ============================================================
// GIVEAWAY DATA
// ============================================================

async function getGiveaway(id) {
    return await redis.get(
        giveawayKey(id)
    );
}

async function saveGiveaway(giveaway) {
    await redis.set(
        giveawayKey(giveaway.id),
        giveaway
    );

    return giveaway;
}


// ============================================================
// PARTICIPANTS
// ============================================================

async function addParticipant(
    giveawayId,
    userId
) {
    return await redis.sadd(
        participantsKey(giveawayId),
        userId
    );
}

async function getParticipants(
    giveawayId
) {
    return await redis.smembers(
        participantsKey(giveawayId)
    );
}

async function getParticipantCount(
    giveawayId
) {
    return await redis.scard(
        participantsKey(giveawayId)
    );
}


// ============================================================
// LOCK
// ============================================================

async function acquireGiveawayLock() {

    const result =
        await redis.set(
            LOCK_KEY,
            Date.now().toString(),
            {
                nx: true,
                ex: 30,
            }
        );

    return result === "OK";
}

async function releaseGiveawayLock() {
    await redis.del(
        LOCK_KEY
    );
}


// ============================================================
// EXPORTS
// ============================================================

module.exports = {

    getActiveGiveawayId,
    setActiveGiveawayId,
    clearActiveGiveawayId,

    getGiveaway,
    saveGiveaway,

    addParticipant,
    getParticipants,
    getParticipantCount,

    acquireGiveawayLock,
    releaseGiveawayLock,
};