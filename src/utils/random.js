function randomInt(
    min,
    max
) {
    const low =
        Math.ceil(
            Number(min)
        );

    const high =
        Math.floor(
            Number(max)
        );

    return (
        Math.floor(
            Math.random() *
                (high - low + 1)
        ) + low
    );
}

function generateReward(
    min = 10,
    max = 100
) {
    return randomInt(
        min,
        max
    );
}

module.exports = {
    randomInt,
    generateReward,
};
