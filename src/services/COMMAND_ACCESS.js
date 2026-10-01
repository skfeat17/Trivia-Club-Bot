require("dotenv").config();

/*
|--------------------------------------------------------------------------
| PIERRO COMMAND ACCESS
|--------------------------------------------------------------------------
|
| Same concept as WAC-QuizBot's COMMAND_ACCESS:
| command management is controlled by explicit Discord user IDs.
|
|--------------------------------------------------------------------------
*/

function parseUserIds(value) {
    return String(value || "")
        .split(",")
        .map(id => id.trim())
        .filter(Boolean);
}

const COMMAND_ACCESS = {
    trivia: parseUserIds(process.env.STAFF_USER_IDS),
    cooldown: parseUserIds(process.env.STAFF_USER_IDS),
    stats: parseUserIds(process.env.STAFF_USER_IDS),
};

const PAYMENT_STAFF = parseUserIds(
    process.env.PAYMENT_STAFF_USER_IDS
);

function hasCommandAccess(command, userId) {
    const allowed = COMMAND_ACCESS[command] || [];
    return allowed.includes(String(userId));
}

function hasPaymentAccess(userId) {
    return PAYMENT_STAFF.includes(String(userId));
}

module.exports = {
    COMMAND_ACCESS,
    PAYMENT_STAFF,
    hasCommandAccess,
    hasPaymentAccess,
};
