const {
    SlashCommandBuilder,
    MessageFlags,
} = require("discord.js");

const {
    hasCommandAccess,
} = require("./COMMAND_ACCESS");

const {
    getParticipationStats,
    getGlobalParticipationStats,
    getCooldownStats,
    getGlobalCooldownStats,
    getLast24Hours,
} = require("./statsService");

const {
    countActiveCooldowns,
} = require("./cooldownService");

const statsCommand =
    new SlashCommandBuilder()
        .setIntegrationTypes(1)
        .setContexts(0, 1, 2)
        .setName("stats")
        .setDescription(
            "View Pierro Permanent Trivia statistics."
        )
        .addStringOption(
            option =>
                option
                    .setName("event")
                    .setDescription(
                        "The event."
                    )
                    .setRequired(true)
                    .addChoices({
                        name:
                            "trivia",
                        value:
                            "trivia",
                    })
        )
        .addStringOption(
            option =>
                option
                    .setName("type")
                    .setDescription(
                        "Statistic category."
                    )
                    .setRequired(true)
                    .addChoices(
                        {
                            name:
                                "participations",
                            value:
                                "participations",
                        },
                        {
                            name:
                                "cooldown",
                            value:
                                "cooldown",
                        }
                    )
        )
        .addUserOption(
            option =>
                option
                    .setName("user")
                    .setDescription(
                        "Optional user."
                    )
                    .setRequired(false)
        );

async function handleStatsCommand(
    interaction
) {
    if (
        !hasCommandAccess(
            "stats",
            interaction.user.id
        )
    ) {
        await interaction.reply({
            content:
                "❌ You are not authorized to view Pierro stats.",
            flags:
                MessageFlags.Ephemeral,
        });

        return;
    }

    const type =
        interaction.options.getString(
            "type",
            true
        );

    const user =
        interaction.options.getUser(
            "user"
        );

    if (
        type ===
        "participations"
    ) {
        const stats =
            user
                ? await getParticipationStats(
                    user.id
                )
                : await getGlobalParticipationStats();

        const last24 =
            await getLast24Hours();

        const target =
            user
                ? `${user}'s`
                : "Global";

        await interaction.reply({
            content:
                `📊 **${target} Trivia Participations**\n\n` +
                `Total: **${stats.total}**\n` +
                `Correct: **${stats.correct}**\n` +
                `Incorrect: **${stats.incorrect}**\n` +
                `Mora Awarded: **${stats.mora}**\n\n` +
                `Last 24h: **${last24.totalParticipations}** participations`,
            flags:
                MessageFlags.Ephemeral,
        });

        return;
    }

    if (
        type ===
        "cooldown"
    ) {
        if (user) {
            const stats =
                await getCooldownStats(
                    user.id
                );

            await interaction.reply({
                content:
                    `⏳ **${user}'s Trivia Cooldowns**\n\n` +
                    `Cooldowns started: **${stats.cooldownsStarted}**`,
                flags:
                    MessageFlags.Ephemeral,
            });

            return;
        }

        const stats =
            await getGlobalCooldownStats();

        const active =
            await countActiveCooldowns();

        await interaction.reply({
            content:
                `⏳ **Global Trivia Cooldowns**\n\n` +
                `Cooldowns started: **${stats.cooldownsStarted}**\n` +
                `Currently active: **${active}`,
            flags:
                MessageFlags.Ephemeral,
        });
    }
}

module.exports = {
    statsCommand,
    handleStatsCommand,
};
