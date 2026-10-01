const redis = require("./pierroRedis");

const PREFIX = "pierro:payment:";
const TRANSACTION_TTL_SECONDS = 30 * 24 * 60 * 60;

function transactionKey(transactionId) {
    return `${PREFIX}transaction:${transactionId}`;
}

async function savePaymentTransaction(transaction) {
    await redis.set(
        transactionKey(transaction.transactionId),
        transaction,
        {
            ex: TRANSACTION_TTL_SECONDS,
        }
    );

    return true;
}

async function getPaymentTransaction(transactionId) {
    return await redis.get(
        transactionKey(transactionId)
    );
}

async function updatePaymentTransaction(
    transactionId,
    updates
) {
    const transaction =
        await getPaymentTransaction(transactionId);

    if (!transaction) {
        return null;
    }

    const updated = {
        ...transaction,
        ...updates,
        updatedAt: Date.now(),
    };

    await savePaymentTransaction(updated);

    return updated;
}

module.exports = {
    TRANSACTION_TTL_SECONDS,
    savePaymentTransaction,
    getPaymentTransaction,
    updatePaymentTransaction,
};
