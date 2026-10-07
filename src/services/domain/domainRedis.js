// domainRedis.js

const redis = require("../pierroRedis");

const ACTIVE_KEY = "pierro:domain:active";
const LOCK_KEY = "pierro:domain:lock";

const DOMAIN_TTL_SECONDS = 30 * 60;
const LOCK_TTL_SECONDS = 30;

function domainKey(domainId) {
    return `pierro:domain:${domainId}`;
}

// ============================================================
// ACTIVE DOMAIN
// ============================================================

async function getActiveDomainId() {
    return await redis.get(ACTIVE_KEY);
}

async function setActiveDomainId(domainId) {
    await redis.set(
        ACTIVE_KEY,
        domainId,
        {
            ex: DOMAIN_TTL_SECONDS,
        }
    );
}

async function clearActiveDomainId() {
    await redis.del(ACTIVE_KEY);
}

// ============================================================
// DOMAIN DATA
// ============================================================

async function getDomain(domainId) {
    if (!domainId) {
        return null;
    }

    return await redis.get(
        domainKey(domainId)
    );
}

async function saveDomain(domain) {
    if (!domain || !domain.id) {
        throw new Error(
            "Cannot save Domain: missing domain.id"
        );
    }

    await redis.set(
        domainKey(domain.id),
        domain,
        {
            ex: DOMAIN_TTL_SECONDS,
        }
    );

    return domain;
}

async function deleteDomain(domainId) {
    if (!domainId) {
        return false;
    }

    await redis.del(
        domainKey(domainId)
    );

    return true;
}

// ============================================================
// DOMAIN LOCK
// ============================================================

async function acquireDomainLock() {
    const result = await redis.set(
        LOCK_KEY,
        Date.now().toString(),
        {
            nx: true,
            ex: LOCK_TTL_SECONDS,
        }
    );

    return result === "OK";
}

async function releaseDomainLock() {
    await redis.del(LOCK_KEY);
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    DOMAIN_TTL_SECONDS,

    getActiveDomainId,
    setActiveDomainId,
    clearActiveDomainId,

    getDomain,
    saveDomain,
    deleteDomain,

    acquireDomainLock,
    releaseDomainLock,
};