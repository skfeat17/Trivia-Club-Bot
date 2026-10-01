function formatCooldown(
    seconds
) {
    let total =
        Math.max(
            0,
            Math.floor(
                Number(seconds) || 0
            )
        );

    const days =
        Math.floor(
            total / 86400
        );

    total %= 86400;

    const hours =
        Math.floor(
            total / 3600
        );

    total %= 3600;

    const minutes =
        Math.floor(
            total / 60
        );

    const secs =
        total % 60;

    const parts = [];

    if (days) {
        parts.push(
            `${days}d`
        );
    }

    if (hours) {
        parts.push(
            `${hours}h`
        );
    }

    if (minutes) {
        parts.push(
            `${minutes}m`
        );
    }

    if (
        secs ||
        parts.length === 0
    ) {
        parts.push(
            `${secs}s`
        );
    }

    return parts.join(" ");
}

module.exports = {
    formatCooldown,
};
