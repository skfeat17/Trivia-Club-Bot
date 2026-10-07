require("dotenv").config();

/*
|--------------------------------------------------------------------------
| PIERRO COMMAND ACCESS
|--------------------------------------------------------------------------
|
| Command management is controlled by explicit Discord user IDs.
|
|--------------------------------------------------------------------------
*/

function parseUserIds(value) {
    return String(value || "")
        .split(",")
        .map(id => id.trim())
        .filter(Boolean);
}


// ============================================================
// COMMAND ACCESS
// ============================================================

const COMMAND_ACCESS = {

    trivia:
        parseUserIds(
            process.env.STAFF_USER_IDS
        ),

    cooldown:
        parseUserIds(
            process.env.STAFF_USER_IDS
        ),

    stats:
        parseUserIds(
            process.env.STAFF_USER_IDS
        ),

    giveaway:
        parseUserIds(
            process.env.STAFF_USER_IDS
        ),
    drop: parseUserIds(process.env.STAFF_USER_IDS),
    domain: parseUserIds(process.env.STAFF_USER_IDS),
};


// ============================================================
// PAYMENT STAFF
// ============================================================

const PAYMENT_STAFF =
    parseUserIds(
        process.env.PAYMENT_STAFF_USER_IDS
    );


// ============================================================
// COMMAND PERMISSION
// ============================================================

function hasCommandAccess(
    command,
    userId
) {

    const allowed =
        COMMAND_ACCESS[command] || [];

    return allowed.includes(
        String(userId)
    );
}


// ============================================================
// PAYMENT PERMISSION
// ============================================================

function hasPaymentAccess(
    userId
) {

    return PAYMENT_STAFF.includes(
        String(userId)
    );
}


// ============================================================
// EXPORTS
// ============================================================

module.exports = {

    COMMAND_ACCESS,
    PAYMENT_STAFF,

    hasCommandAccess,
    hasPaymentAccess,

};