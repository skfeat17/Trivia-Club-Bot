function log(
    message,
    ...args
) {
    console.log(
        `[PIERRO] ${message}`,
        ...args
    );
}

function error(
    message,
    ...args
) {
    console.error(
        `[PIERRO ERROR] ${message}`,
        ...args
    );
}

module.exports = {
    log,
    error,
};
