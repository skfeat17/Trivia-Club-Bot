function randomInt(min, max) {
    const low = Math.ceil(Number(min));
    const high = Math.floor(Number(max));

    return (
        Math.floor(
            Math.random() * (high - low + 1)
        ) + low
    );
}

function generateReward() {
    const chance = Math.random() * 100;

    if (chance < 80) {
        // 80% chance: 20–30
        return randomInt(20, 30);
    }

    if (chance < 90) {
        // 10% chance: 31–40
        return randomInt(31, 40);
    }

    if (chance < 96) {
        // 6% chance: 41–45
        return randomInt(41, 45);
    }

    // 4% chance: 46–50
    return randomInt(46, 50);
}

module.exports = {
    randomInt,
    generateReward,
};

