//domain.js
const crypto = require("crypto");

const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
} = require("discord.js");

const {
    getActiveDomainId,
    setActiveDomainId,
    clearActiveDomainId,
    getDomain,
    saveDomain,
    deleteDomain,
    acquireDomainLock,
    releaseDomainLock,
} = require("./domainRedis");

const {
    hasCommandAccess,
} = require("../COMMAND_ACCESS");

const {
    createPaymentTransaction,
} = require("../paymentService");

const {
    recordMora,
} = require("../statsService");

const MORA_EMOJI =
    process.env.MORA_EMOJI || "<:mora:1503931162525962333>";

/*
|--------------------------------------------------------------------------
| DOMAIN IMMUNITY
|--------------------------------------------------------------------------
|
| Add Discord user IDs to this array to make those users immune to death
| inside every Domain. Keep IDs as strings.
|
*/
const DOMAIN_IMMUNE_USER_IDS = [
"1242132608574292118"
];

function isDomainImmune(playerOrId) {
    const userId =
        typeof playerOrId === "string"
            ? playerOrId
            : playerOrId?.userId;

    return Boolean(
        userId &&
        DOMAIN_IMMUNE_USER_IDS.includes(userId)
    );
}

/*
|--------------------------------------------------------------------------
| DIFFICULTY
|--------------------------------------------------------------------------
|
| All Domain modes currently run for 30 seconds.
|
| Deaths are randomized within each difficulty while always leaving
| at least one survivor.
|--------------------------------------------------------------------------
*/

const DIFFICULTIES = {
    easy: {
        value: 0,
        label: "EASY",
        emoji: "🟢",
        durationMs: 30 * 1000,
        minDeaths: 0,
        maxDeaths: 0,
    },

    medium: {
        value: 1,
        label: "MEDIUM",
        emoji: "🟡",
        durationMs: 30 * 1000,
        minDeaths: 1,
        maxDeaths: 1,
    },

    hard: {
        value: 2,
        label: "HARD",
        emoji: "🔴",
        durationMs: 30 * 1000,
        minDeaths: 1,
        maxDeaths: 2,
    },

    dire: {
        value: 3,
        label: "DIRE",
        emoji: "☠️",
        durationMs: 30 * 1000,
        minDeaths: 1,
        maxDeaths: 3,
    },
};

const domainTimers = new Map();
const deathTimers = new Map();
const activeInteractions = new Map();

// Serialize battle/death/finalization operations for each domain.
// This prevents a death callback from saving stale state after the
// completion handler has already finalized the domain.
const domainOperationQueues = new Map();

function runDomainOperation(domainId, operation) {
    const previous =
        domainOperationQueues.get(domainId) ||
        Promise.resolve();

    const current = previous
        .catch(() => {})
        .then(operation);

    domainOperationQueues.set(domainId, current);

    current
        .finally(() => {
            if (domainOperationQueues.get(domainId) === current) {
                domainOperationQueues.delete(domainId);
            }
        })
        .catch(() => {});

    return current;
}

function generateDomainId() {
    return (
        "domain_" +
        Date.now().toString(36) +
        "_" +
        crypto.randomBytes(4).toString("hex")
    );
}

function getDifficulty(value) {
    const numeric = Number(value);

    return Object.values(DIFFICULTIES)
        .find(difficulty => difficulty.value === numeric)
        || null;
}

function formatDuration(durationMs) {
    const totalSeconds =
        Math.ceil(durationMs / 1000);

    if (totalSeconds < 60) {
        return `${totalSeconds}s`;
    }

    const minutes =
        Math.floor(totalSeconds / 60);

    const seconds =
        totalSeconds % 60;

    return seconds
        ? `${minutes}m ${seconds}s`
        : `${minutes}m`;
}

function randomInt(min, max) {
    return Math.floor(
        Math.random() * (max - min + 1)
    ) + min;
}

function shuffle(array) {
    return [...array].sort(
        () => Math.random() - 0.5
    );
}

/*
|--------------------------------------------------------------------------
| DEVELOPER TEST PARTY
|--------------------------------------------------------------------------
|
| This does NOT create Discord accounts.
| It creates internal fake players so one developer account can test
| a Domain without needing extra Discord accounts.
|
| Test players:
|   - never receive Mora
|   - cannot be paid through paymentService
|   - can die normally
|   - appear in the Domain UI as 🧪 Test Player
|--------------------------------------------------------------------------
*/

const TEST_PLAYER_NAMES = [
    "Test Player 1",
    "Test Player 2",
    "Test Player 3",
    "Test Player 4",
    "Test Player 5",
    "Test Player 6",
    "Test Player 7",
    "Test Player 8",
    "Test Player 9",
];

function createTestPlayer(name, index) {
    return {
        userId:
            `TEST_PLAYER_${index + 1}`,
        username:
            name,
        displayName:
            name,
        isTest:
            true,
        status:
            "alive",
        joinedAt:
            Date.now(),
        reward:
            0,
    };
}

function isTestPlayer(player) {
    return player?.isTest === true;
}

function playerDisplay(player) {
    // Immunity is intentionally hidden from public Domain messages.
    if (isTestPlayer(player)) {
        return `🧪 **${player.displayName || player.username}**`;
    }

    return `<@${player.userId}>`;
}

// Scale the difficulty's death range linearly from a 4-player party.
// Larger parties therefore have proportionally more planned deaths.
function chooseDeathCount(difficulty, playerCount) {
    const scale =
        Math.max(1, playerCount) / 4;

    const minDeaths =
        Math.round(difficulty.minDeaths * scale);

    const maxDeaths =
        Math.round(difficulty.maxDeaths * scale);

    if (maxDeaths <= minDeaths) {
        return minDeaths;
    }

    return randomInt(
        minDeaths,
        maxDeaths
    );
}

function partyLines(domain, players = domain.players || []) {
    if (!players.length) {
        return "No players have joined yet.";
    }

    return players
        .map(
            (player, index) =>
                `${index + 1}. ${playerDisplay(player)}` +
                (
                    player.status === "dead"
                        ? " 💀"
                        : ""
                )
        )
        .join("\n");
}

function createJoinRow(domain, disabled = false) {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(
                    `pierro:domain:join:${domain.id}`
                )
                .setLabel("Join the Party")
                .setEmoji("🏰")
                .setStyle(ButtonStyle.Primary)
                .setDisabled(disabled)
        ),
    ];
}

function createWaitingEmbed(domain) {
    const difficulty =
        getDifficulty(domain.mode);

    const maxPlayers =
        Number(domain.maxPlayers) || 4;

    const ready =
        domain.players.length >= maxPlayers;

    return new EmbedBuilder()
        .setTitle(
            "🏰 A MYSTERICAL DOMAIN HAS APPEARED"
        )
        .setDescription(
            `Form a **Party of ${maxPlayers}** and conquer this ` +
            "domain to claim the bounty reward!"
        )
        .addFields(
            {
                name: "💰 Bounty",
                value:
                    `**${domain.reward} ${MORA_EMOJI}**`,
                inline: true,
            },
            {
                name: `${difficulty.emoji} Difficulty`,
                value:
                    `**${difficulty.label}**`,
                inline: true,
            },
            {
                name: "👥 PARTY",
                value:
                    partyLines(domain),
                inline: false,
            },
        )
        .setFooter({
            text: ready
                ? "⚔️ Party is ready!"
                : `${domain.players.length}/${maxPlayers} players`,
        });
}

function createBattleEmbed(domain) {
    const difficulty =
        getDifficulty(domain.mode);

    return new EmbedBuilder()
        .setTitle(
            "⚔️ THE PARTY IS FIGHTING THE DOMAIN"
        )
        .setDescription(
            "The party is currently fighting inside the domain.\n\n" +
            "Survive the battle and claim the bounty!"
        )
        .addFields(
            {
                name: "👥 Party",
                value:
                    partyLines(domain),
                inline: false,
            },
            {
                name: "⚔️ Status",
                value:
                    domain.players.some(
                        player => player.status === "dead"
                    )
                        ? "Some party members have fallen. The battle continues..."
                        : "The party is still fighting...",
                inline: false,
            },
            {
                name: `${difficulty.emoji} Difficulty`,
                value:
                    `**${difficulty.label}**`,
                inline: true,
            },
        );
}

function createCompletedEmbed(domain) {
    const deadPlayerIds =
        new Set(
            Array.isArray(domain.deadPlayers)
                ? domain.deadPlayers
                : []
        );

    const survivors =
        domain.players.filter(
            player =>
                player.status !== "dead" &&
                !deadPlayerIds.has(player.userId)
        );

    const fallen =
        domain.players.filter(
            player =>
                player.status === "dead" ||
                deadPlayerIds.has(player.userId)
        );

    if (domain.status === "destroyed") {
        return new EmbedBuilder()
            .setTitle("🛑 DOMAIN DESTROYED")
            .setDescription(
                "The active domain was destroyed by staff."
            )
            .addFields({
                name: "👥 Party",
                value: partyLines(domain),
            });
    }

    return new EmbedBuilder()
        .setTitle("🏆 DOMAIN CONQUERED")
        .setDescription(
            "The party successfully conquered " +
            "the mysterious domain!"
        )
        .addFields(
            {
                name: "💰 Bounty",
                value:
                    `**${domain.reward} ${MORA_EMOJI}**`,
                inline: true,
            },
            {
                name: "🏆 Survivors",
                value:
                    survivors.length
                        ? survivors
                            .map(player =>
                                playerDisplay(player)
                            )
                            .join("\n")
                        : "None",
                inline: false,
            },
            {
                name: "💀 Fallen",
                value:
                    fallen.length
                        ? fallen
                            .map(player =>
                                playerDisplay(player)
                            )
                            .join("\n")
                        : "None",
                inline: false,
            },
            {
                name: "💰 Reward",
                value:
                    domain.rewardPerSurvivor > 0
                        ? `The bounty was divided equally among ${survivors.length} survivor(s).\n` +
                          `Each survivor receives **${domain.rewardPerSurvivor} ${MORA_EMOJI}**.`
                        : "No reward was paid.",
                inline: false,
            }
        );
}

async function updatePublicDomainMessage(
    interaction,
    domain,
    components
) {
    if (!domain.messageId) {
        return false;
    }

    if (
        !interaction ||
        !interaction.webhook
    ) {
        return false;
    }

    await interaction.webhook.editMessage(
        domain.messageId,
        {
            embeds: [
                domain.status === "waiting"
                    ? createWaitingEmbed(domain)
                    : domain.status === "fighting"
                        ? createBattleEmbed(domain)
                        : createCompletedEmbed(domain),
            ],
            components:
                components === undefined
                    ? createJoinRow(
                        domain,
                        domain.status !== "waiting"
                    )
                    : components,
        }
    );

    return true;
}

async function finalizeDomain(
    client,
    domainId,
    reason = "completed",
    interaction = null
) {
    const domain =
        await getDomain(domainId);

    if (!domain) {
        return null;
    }

    // Prevent multiple timer ticks from finalizing the same domain.
    if (
        domain.status === "completed" ||
        domain.status === "completing" ||
        domain.status === "destroyed"
    ) {
        return domain;
    }

    // Claim completion before doing rewards/message work.
    if (reason !== "destroyed") {
        domain.status = "completing";
        await saveDomain(domain);
    }

    const domainTimer =
        domainTimers.get(domainId);

    if (domainTimer) {
        clearInterval(domainTimer);
        clearTimeout(domainTimer);
        domainTimers.delete(domainId);
    }

    const deaths =
        deathTimers.get(domainId) || [];

    for (const timer of deaths) {
        clearTimeout(timer);
    }

    deathTimers.delete(domainId);

    domain.status =
        reason === "destroyed"
            ? "destroyed"
            : "completed";

    domain.endedAt =
        Date.now();

    if (domain.status === "completed") {
        // Use the explicit death record, not a loose status check.
        // This guarantees a player who died can NEVER be rewarded or
        // shown in the survivor list.
        // The player's live status is the source of truth.
        // A player marked "dead" during the battle can NEVER be a survivor.
        const deadPlayerIds = new Set(
            Array.isArray(domain.deadPlayers)
                ? domain.deadPlayers
                : []
        );

        const survivors =
            domain.players.filter(
                player =>
                    player.status !== "dead" &&
                    !deadPlayerIds.has(player.userId)
            );

        const fallen =
            domain.players.filter(
                player =>
                    player.status === "dead" ||
                    deadPlayerIds.has(player.userId)
            );

        // Normalize the stored state for the final result.
        domain.players =
            domain.players.map(player => ({
                ...player,
                status:
                    player.status === "dead" ||
                    deadPlayerIds.has(player.userId)
                        ? "dead"
                        : "alive",
            }));

        domain.deadPlayers = fallen.map(
            player => player.userId
        );

        if (!survivors.length) {
            // Safety guard. The death scheduler never intentionally
            // kills the whole party, but never pay a reward if it happens.
            domain.rewardPerSurvivor = 0;
        } else {
            const base =
                Math.floor(
                    domain.reward /
                    survivors.length
                );

            const remainder =
                domain.reward %
                survivors.length;

            domain.rewardPerSurvivor =
                base;

            /*
             * The bounty is shared as evenly as possible.
             * If it does not divide exactly, the first survivor(s)
             * receive the extra 1 Mora so no Mora is lost.
             */
            domain.rewardShares =
                survivors.map(
                    (_, index) =>
                        base +
                        (index < remainder ? 1 : 0)
                );

            for (
                let index = 0;
                index < survivors.length;
                index++
            ) {
                const survivor =
                    survivors[index];

                const reward =
                    domain.rewardShares[index];

                survivor.reward =
                    reward;

                // Developer test players are simulated only.
                // NEVER create transactions or Mora for them.
                if (isTestPlayer(survivor)) {
                    console.log(
                        `🧪 TEST PLAYER REWARD SKIPPED | ${survivor.username} | ${reward} Mora`
                    );
                    continue;
                }

                try {
                    const user =
                        await client.users.fetch(
                            survivor.userId
                        );

                    await createPaymentTransaction({
                        client,
                        winnerId:
                            survivor.userId,
                        username:
                            user.username,
                        game:
                            "Pierro Domain",
                        reward,
                        question:
                            `Domain ${domain.id} — ${getDifficulty(domain.mode)?.label || "Unknown"} difficulty`,
                    });

                    await recordMora(
                        survivor.userId,
                        reward
                    );
                } catch (error) {
                    console.error(
                        `❌ DOMAIN PAYMENT FAILED | ${survivor.userId} | ${error.message}`
                    );
                }
            }
        }
    }

    await saveDomain(domain);

    try {
        await updatePublicDomainMessage(
            interaction ||
                activeInteractions.get(domainId),
            domain,
            []
        );
    } catch (error) {
        console.error(
            `⚠️ DOMAIN MESSAGE UPDATE FAILED | ${domainId} | ${error.message}`
        );
    }

    activeInteractions.delete(domainId);
    await clearActiveDomainId();

    // Keep the completed state briefly so late button presses receive
    // a useful response instead of "not found".
    setTimeout(
        () =>
            deleteDomain(domainId)
                .catch(error =>
                    console.error(
                        "❌ DOMAIN CLEANUP FAILED:",
                        error.message
                    )
                ),
        60 * 1000
    );

    return domain;
}

async function endDomain(
    client,
    domainId,
    reason = "completed",
    interaction = null
) {
    return runDomainOperation(
        domainId,
        () => finalizeDomain(
            client,
            domainId,
            reason,
            interaction
        )
    );
}

function scheduleBattle(
    client,
    domain,
    interaction
) {
    const existing =
        domainTimers.get(domain.id);

    if (existing) {
        clearTimeout(existing);
        clearInterval(existing);
    }

    /*
     * IMPORTANT:
     * Do not use a 5-second interval here.
     * The domain must remain in the fighting state for the
     * full configured duration: 30 seconds.
     *
     * There is also NO countdown shown in the embed.
     */
    const delay = Math.max(
        0,
        domain.endsAt - Date.now()
    );

    const timer =
        setTimeout(
            async () => {
                try {
                    const current =
                        await getDomain(domain.id);

                    if (
                        !current ||
                        current.status !== "fighting"
                    ) {
                        return;
                    }

                    await endDomain(
                        client,
                        current.id,
                        "completed",
                        interaction
                    );
                } catch (error) {
                    console.error(
                        `❌ DOMAIN BATTLE TIMER FAILED | ${domain.id} | ${error.message}`
                    );
                }
            },
            delay
        );

    domainTimers.set(
        domain.id,
        timer
    );
}

function scheduleDeaths(
    client,
    domain,
    interaction
) {
    const difficulty =
        getDifficulty(domain.mode);

    const requestedDeathCount =
        chooseDeathCount(
            difficulty,
            domain.players.length
        );

    // Immune players are never placed in the death queue.
    const eligiblePlayers =
        domain.players.filter(
            player =>
                !isDomainImmune(player) &&
                player.status === "alive"
        );

    const immunePlayers =
        domain.players.filter(
            player => isDomainImmune(player)
        );

    // Always leave at least one survivor. If nobody is immune, leave one
    // non-immune player alive; if immune players exist, they guarantee
    // at least one survivor, so all non-immune players may be eligible.
    const maximumPossibleDeaths =
        immunePlayers.length > 0
            ? eligiblePlayers.length
            : Math.max(0, eligiblePlayers.length - 1);

    const deathCount =
        Math.min(
            requestedDeathCount,
            maximumPossibleDeaths
        );

    domain.plannedDeaths =
        deathCount;

    if (deathCount <= 0) {
        return;
    }

    const shuffledPlayers =
        shuffle(eligiblePlayers);

    /*
     * Deaths happen before the end, but never so late that the final
     * state is not visible. They are spread through the battle.
     */
    // Randomize each death time across the battle, while ensuring
    // deaths happen one at a time and before the final battle ends.
    // We generate unique random offsets, then sort them chronologically.
    const availableTimes = [];

    for (let second = 3; second < Math.floor(domain.durationMs / 1000) - 2; second++) {
        availableTimes.push(second * 1000);
    }

    const randomizedTimes = shuffle(availableTimes)
        .slice(0, deathCount)
        .sort((a, b) => a - b);

    const slots = randomizedTimes.map(time => time);

    const timers = [];

    for (
        let index = 0;
        index < deathCount;
        index++
    ) {
        const userId =
            shuffledPlayers[index].userId;

        const timer =
            setTimeout(
                () =>
                    runDomainOperation(
                        domain.id,
                        async () => {
                            const current =
                                await getDomain(domain.id);

                            // The completion operation is serialized with this
                            // callback. If completion already happened, this
                            // death is ignored and can never alter the final result.
                            if (
                                !current ||
                                current.status !== "fighting"
                            ) {
                                return;
                            }

                            const player =
                                current.players.find(
                                    entry =>
                                        entry.userId === userId
                                );

                            if (
                                !player ||
                                player.status !== "alive"
                            ) {
                                return;
                            }

                            player.status =
                                "dead";

                            player.diedAt =
                                Date.now();

                            if (!Array.isArray(current.deadPlayers)) {
                                current.deadPlayers = [];
                            }

                            if (!current.deadPlayers.includes(userId)) {
                                current.deadPlayers.push(userId);
                            }

                            await saveDomain(current);

                            // Track the death first.
                            // Each death is announced individually so the battle
                            // feels active and realistic. The main battle embed is
                            // NOT edited here; only the death announcement is sent.
                            const fallenPlayer =
                                current.players.find(
                                    entry =>
                                        entry.userId === userId
                                );

                            const deathMessage =
                                isTestPlayer(fallenPlayer)
                                    ? `💀 **${fallenPlayer.displayName || fallenPlayer.username}** was defeated inside the domain!`
                                    : `💀 <@${userId}> was defeated inside the domain!`;

                            try {
                                await interaction.followUp({
                                    content: deathMessage,
                                    ...(isTestPlayer(fallenPlayer)
                                        ? {}
                                        : {
                                            allowedMentions: {
                                                users: [userId],
                                            },
                                        }),
                                });
                            } catch (error) {
                                console.error(
                                    `⚠️ DOMAIN DEATH ANNOUNCEMENT FAILED | ${domain.id} | ${error.message}`
                                );
                            }
                        }
                    ).catch(error => {
                        console.error(
                            `❌ DOMAIN DEATH HANDLER FAILED | ${domain.id} | ${error.message}`
                        );
                    }),
                slots[index]
            );

        timers.push(timer);
    }

    deathTimers.set(
        domain.id,
        timers
    );
}

async function startDomainBattle(
    interaction,
    domain
) {
    domain.status =
        "fighting";

    domain.startedAt =
        Date.now();

    domain.endsAt =
        domain.startedAt +
        domain.durationMs;

    domain.deadPlayers = [];

    domain.players =
        domain.players.map(
            player => ({
                ...player,
                status: "alive",
                joinedAt:
                    player.joinedAt ||
                    Date.now(),
                diedAt: null,
                reward: 0,
            })
        );

    await saveDomain(domain);

    activeInteractions.set(
        domain.id,
        interaction
    );

    try {
        await updatePublicDomainMessage(
            interaction,
            domain
        );
    } catch (error) {
        console.error(
            `⚠️ DOMAIN BATTLE MESSAGE UPDATE FAILED | ${error.message}`
        );
    }

    scheduleDeaths(
        interaction.client,
        domain,
        interaction
    );

    scheduleBattle(
        interaction.client,
        domain,
        interaction
    );
}

async function fillDomainWithTestPlayers(interaction) {
    const activeId =
        await getActiveDomainId();

    if (!activeId) {
        await interaction.editReply({
            content:
                "❌ There is no active Domain. Spawn a Domain first.",
        });
        return;
    }

    const domain =
        await getDomain(activeId);

    if (!domain) {
        await clearActiveDomainId();

        await interaction.editReply({
            content:
                "❌ The active Domain could not be found.",
        });
        return;
    }

    if (domain.status !== "waiting") {
        await interaction.editReply({
            content:
                "⚔️ The Domain is already fighting or has finished.",
        });
        return;
    }

    const maxPlayers =
        Number(domain.maxPlayers) || 4;

    if (domain.players.length >= maxPlayers) {
        await interaction.editReply({
            content:
                "⚠️ The party is already full.",
        });
        return;
    }

    const needed =
        maxPlayers - domain.players.length;

    const availableNames =
        TEST_PLAYER_NAMES.filter(
            name =>
                !domain.players.some(
                    player =>
                        player.isTest &&
                        player.username === name
                )
        );

    const added =
        availableNames
            .slice(0, needed)
            .map(
                name =>
                    createTestPlayer(
                        name,
                        Number(name.match(/(\\d+)$/)?.[1] || 1) - 1
                    )
            );

    domain.players.push(...added);

    await saveDomain(domain);

    const addedText =
        added.length
            ? added
                .map(
                    player =>
                        `🧪 **${player.username}**`
                )
                .join("\n")
            : "None";

    await interaction.editReply({
        content:
            `🧪 **Developer Test Party Created**\n\n` +
            `Added:\n${addedText}\n\n` +
            `Party: **${domain.players.length}/${maxPlayers}**\n\n` +
            `The test players will **never receive Mora**.`,
    });

    /*
     * Use this interaction as the current webhook for public updates.
     */
    activeInteractions.set(
        domain.id,
        interaction
    );

    if (domain.players.length >= maxPlayers) {
        await startDomainBattle(
            interaction,
            domain
        );
    } else {
        try {
            await updatePublicDomainMessage(
                interaction,
                domain
            );
        } catch (error) {
            console.error(
                `⚠️ DOMAIN TEST PARTY MESSAGE UPDATE FAILED | ${domain.id} | ${error.message}`
            );
        }
    }
}

async function handleDomainCommand(interaction) {
    await interaction.deferReply({
        flags: MessageFlags.Ephemeral,
    });

    if (
        !hasCommandAccess(
            "domain",
            interaction.user.id
        )
    ) {
        await interaction.editReply({
            content:
                "❌ You do not have permission to use this command.",
        });
        return;
    }

    const action =
        interaction.options.getString(
            "action",
            true
        );

    const locked =
        await acquireDomainLock();

    if (!locked) {
        await interaction.editReply({
            content:
                "⚠️ Another domain operation is currently running.",
        });
        return;
    }

    try {
        if (action === "spawn") {
            await spawnDomain(interaction);
            return;
        }

        if (action === "destroy") {
            await destroyDomain(interaction);
            return;
        }

        if (action === "testparty") {
            await fillDomainWithTestPlayers(
                interaction
            );
            return;
        }

        await interaction.editReply({
            content:
                "❌ Invalid domain action.",
        });
    } catch (error) {
        console.error(
            "❌ DOMAIN COMMAND ERROR:",
            error
        );

        await interaction.editReply({
            content:
                "❌ Failed to process the domain command.",
        });
    } finally {
        await releaseDomainLock();
    }
}

async function spawnDomain(interaction) {
    const activeId =
        await getActiveDomainId();

    if (activeId) {
        const active =
            await getDomain(activeId);

        if (
            active &&
            (
                active.status === "waiting" ||
                active.status === "fighting"
            )
        ) {
            await interaction.editReply({
                content:
                    "⚠️ A domain is already active!\n\n" +
                    "Destroy the current domain before spawning another one.",
            });
            return;
        }

        await clearActiveDomainId();
    }

    const reward =
        interaction.options.getInteger(
            "reward"
        );

    const mode =
        interaction.options.getInteger(
            "mode"
        );

    const maxPlayers =
        interaction.options.getInteger(
            "players"
        );

    if (
        !Number.isInteger(maxPlayers) ||
        maxPlayers < 4 ||
        maxPlayers > 10
    ) {
        await interaction.editReply({
            content:
                "❌ Party size is required when spawning a Domain and must be between 4 and 10 players.",
        });
        return;
    }

    if (reward === null || reward === undefined) {
        await interaction.editReply({
            content:
                "❌ You must provide a Mora reward when spawning a domain.",
        });
        return;
    }

    if (mode === null || mode === undefined) {
        await interaction.editReply({
            content:
                "❌ You must provide a difficulty when spawning a domain.",
        });
        return;
    }

    const difficulty =
        getDifficulty(mode);

    if (!difficulty) {
        await interaction.editReply({
            content:
                "❌ Invalid domain difficulty.",
        });
        return;
    }

    if (
        !Number.isInteger(reward) ||
        reward <= 0
    ) {
        await interaction.editReply({
            content:
                "❌ Reward must be a positive whole number.",
        });
        return;
    }

    const domain = {
        id:
            generateDomainId(),
        guildId:
            interaction.guildId || null,
        channelId:
            interaction.channelId,
        messageId:
            null,
        reward,
        maxPlayers,
        immuneUserIds: [...DOMAIN_IMMUNE_USER_IDS],
        mode:
            difficulty.value,
        status:
            "waiting",
        players: [],
        deadPlayers: [],
        plannedDeaths: 0,
        rewardPerSurvivor: 0,
        rewardShares: [],
        createdBy:
            interaction.user.id,
        createdAt:
            Date.now(),
        startedAt:
            null,
        endsAt:
            null,
        endedAt:
            null,
    };

    await saveDomain(domain);
    await setActiveDomainId(domain.id);

    await interaction.editReply({
        content:
            `✅ **${difficulty.emoji} ${difficulty.label} Domain** spawned with a bounty of **${reward} ${MORA_EMOJI}**.`,
    });

    try {
        const message =
            await interaction.followUp({
                embeds: [
                    createWaitingEmbed(domain),
                ],
                components:
                    createJoinRow(domain),
                ephemeral: false,
                fetchReply: true,
            });

        domain.messageId =
            message.id;

        await saveDomain(domain);

        activeInteractions.set(
            domain.id,
            interaction
        );
    } catch (error) {
        await deleteDomain(domain.id);
        await clearActiveDomainId();

        throw error;
    }

    await interaction.editReply({
        content:
            `✅ **${difficulty.emoji} ${difficulty.label} Domain** spawned successfully.`,
    });
}

async function destroyDomain(interaction) {
    const activeId =
        await getActiveDomainId();

    if (!activeId) {
        await interaction.editReply({
            content:
                "ℹ️ There is no active domain.",
        });
        return;
    }

    const domain =
        await getDomain(activeId);

    if (!domain) {
        await clearActiveDomainId();

        await interaction.editReply({
            content:
                "ℹ️ There is no active domain.",
        });
        return;
    }

    await endDomain(
        interaction.client,
        domain.id,
        "destroyed",
        activeInteractions.get(domain.id) ||
            interaction
    );

    await interaction.editReply({
        content:
            "🛑 The active domain has been destroyed.",
    });
}

async function handleDomainJoinButton(interaction) {
    // Acknowledge the button immediately so Discord never shows
    // "This interaction failed" while the party state is being saved.
    await interaction.deferReply({
        flags: MessageFlags.Ephemeral,
    });

    const prefix =
        "pierro:domain:join:";

    if (
        !interaction.customId.startsWith(prefix)
    ) {
        await interaction.editReply({
            content:
                "❌ Invalid domain button.",
        });
        return;
    }

    const domainId =
        interaction.customId.slice(
            prefix.length
        );

    /*
     * DO NOT use the Redis domain lock for Join buttons.
     *
     * The old flow tried to acquire the global lock and immediately
     * rejected the click when another join/update was happening. That
     * produced the annoying:
     *
     *   "The party is being updated. Please try again."
     *
     * Join requests are now serialized per-domain instead. Multiple
     * people can press Join at the same time and their requests wait
     * their turn instead of being rejected.
     */
    return runDomainOperation(
        domainId,
        async () => {
            const domain =
                await getDomain(domainId);

            if (!domain) {
                await interaction.editReply({
                    content:
                        "🏰 This domain no longer exists.",
                });
                return;
            }

            if (domain.status !== "waiting") {
                await interaction.editReply({
                    content:
                        "⚔️ This domain is no longer accepting party members.",
                });
                return;
            }

            if (
                domain.players.some(
                    player =>
                        player.userId === interaction.user.id
                )
            ) {
                await interaction.editReply({
                    content:
                        "⚔️ You are already in this Domain party.",
                });
                return;
            }

            const maxPlayers =
                Number(domain.maxPlayers) || 4;

            if (domain.players.length >= maxPlayers) {
                await interaction.editReply({
                    content:
                        "⚔️ The party is already full.",
                });
                return;
            }

            domain.players.push({
                userId:
                    interaction.user.id,
                username:
                    interaction.user.username,
                status:
                    "alive",
                joinedAt:
                    Date.now(),
                reward:
                    0,
            });

            const partyCount =
                domain.players.length;

            await saveDomain(domain);

            /*
             * Confirm the join BEFORE editing the public message.
             * The user gets an instant response even if Discord takes
             * a little longer to update the public Domain embed.
             */
            await interaction.editReply({
                content:
                    `⚔️ **You joined the Domain party!**

` +
                    `Party: **${partyCount}/${maxPlayers}**`,
            });

            /*
             * Keep the newest interaction as the webhook used for
             * public Domain message updates. No channel.send() is used.
             */
            activeInteractions.set(
                domain.id,
                interaction
            );

            const publicInteraction =
                activeInteractions.get(domain.id);

            if (partyCount >= maxPlayers) {
                // The final required join starts the battle while still inside the
                // per-domain queue, so another click cannot race it.
                await startDomainBattle(
                    publicInteraction ||
                        interaction,
                    domain
                );
            } else {
                try {
                    await updatePublicDomainMessage(
                        publicInteraction ||
                            interaction,
                        domain
                    );
                } catch (error) {
                    console.error(
                        `⚠️ DOMAIN PARTY MESSAGE UPDATE FAILED | ${domain.id} | ${error.message}`
                    );
                }
            }
        }
    ).catch(async error => {
        console.error(
            `❌ DOMAIN JOIN FAILED | ${domainId} | ${error.message}`
        );

        try {
            await interaction.editReply({
                content:
                    "❌ Failed to join the Domain. Please try again.",
            });
        } catch (replyError) {
            console.error(
                `❌ DOMAIN JOIN REPLY FAILED | ${domainId} | ${replyError.message}`
            );
        }
    });
}

module.exports = {
    DIFFICULTIES,
    domainCommand:
        new SlashCommandBuilder()
            .setName("domain")
            .setDescription(
                "Spawn or destroy a temporary 4-player Pierro Domain."
            )
            .addStringOption(option =>
                option
                    .setName("action")
                    .setDescription(
                        "Domain action."
                    )
                    .setRequired(true)
                    .addChoices(
                        {
                            name: "Spawn",
                            value: "spawn",
                        },
                        {
                            name: "Destroy",
                            value: "destroy",
                        }
                    )
            )
            .addIntegerOption(option =>
                option
                    .setName("players")
                    .setDescription(
                        "Required when spawning. Party size from 4 to 10 players."
                    )
                    .setRequired(false)
                    .setMinValue(4)
                    .setMaxValue(10)
            )
            .addIntegerOption(option =>
                option
                    .setName("reward")
                    .setDescription(
                        "Total Mora bounty. Required when spawning."
                    )
                    .setRequired(false)
                    .setMinValue(1)
            )
            .addIntegerOption(option =>
                option
                    .setName("mode")
                    .setDescription(
                        "Difficulty. Required when spawning."
                    )
                    .setRequired(false)
                    .addChoices(
                        {
                            name: "🟢 Easy",
                            value: 0,
                        },
                        {
                            name: "🟡 Medium",
                            value: 1,
                        },
                        {
                            name: "🔴 Hard",
                            value: 2,
                        },
                        {
                            name: "☠️ Dire",
                            value: 3,
                        }
                    )
            ),
    handleDomainCommand,
    handleDomainJoinButton,
};
