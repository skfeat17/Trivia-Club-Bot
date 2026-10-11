
const {
    SlashCommandBuilder,
    MessageFlags,
} = require("discord.js");

const {
    hasCommandAccess,
} = require("./COMMAND_ACCESS");

const {
    getLast24Hours,
    getCooldownStats,
    getGlobalCooldownStats,
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
        .addStringOption(option =>
            option
                .setName("event")
                .setDescription("The event.")
                .setRequired(true)
                .addChoices({
                    name: "trivia",
                    value: "trivia",
                })
        )
        .addStringOption(option =>
            option
                .setName("type")
                .setDescription("Statistic category.")
                .setRequired(true)
                .addChoices(
                    {
                        name: "participations",
                        value: "participations",
                    },
                    {
                        name: "cooldown",
                        value: "cooldown",
                    }
                )
        )
        .addUserOption(option =>
            option
                .setName("user")
                .setDescription(
                    "Optional user to check."
                )
                .setRequired(false)
        );

function formatNumber(value) {
    return Number(value || 0)
        .toLocaleString("en-IN");
}

function formatStats(title, stats) {
    return (
        `## 📊 ${title}\n\n` +
        `👥 **Unique Participants:** ${formatNumber(stats.participants)}\n` +
        `📝 **Total Attempts:** ${formatNumber(stats.total)}\n` +
        `✅ **Correct Answers:** ${formatNumber(stats.correct)}\n` +
        `❌ **Incorrect Answers:** ${formatNumber(stats.incorrect)}\n` +
        `💰 **Mora Awarded:** ${formatNumber(stats.mora)} Mora\n` +
        `📈 **Average Mora per Attempt:** ${formatNumber(stats.averageMora)} Mora`
    );
}

async function handleStatsCommand(interaction) {
    if (
        !hasCommandAccess(
            "stats",
            interaction.user.id
        )
    ) {
        await interaction.reply({
            content:
                "❌ You are not authorized to view Pierro stats.",
            flags: MessageFlags.Ephemeral,
        });

        return;
    }

    const type =
        interaction.options.getString(
            "type",
            true
        );

    const user =
        interaction.options.getUser("user");

    if (type === "participations") {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral,
        });

        try {
            const stats = await getLast24Hours(
                Date.now(),
                user?.id || null
            );

            const title = user
                ? `${user.username}'s Trivia — Last 24 Hours`
                : "Global Trivia — Last 24 Hours";

            await interaction.editReply({
                content: formatStats(
                    title,
                    stats
                ),
            });
        } catch (error) {
            console.error(
                "❌ LAST 24 HOURS STATS FAILED:",
                error
            );

            await interaction.editReply({
                content:
                    "❌ Failed to retrieve trivia statistics. Please try again.",
            });
        }

        return;
    }

    if (type === "cooldown") {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral,
        });

        try {
            if (user) {
                const stats =
                    await getCooldownStats(user.id);

                await interaction.editReply({
                    content:
                        `## ⏳ ${user.username}'s Trivia Cooldowns\n\n` +
                        `Cooldowns Started: **${formatNumber(stats.cooldownsStarted)}**`,
                });

                return;
            }

            const [
                stats,
                active,
            ] = await Promise.all([
                getGlobalCooldownStats(),
                countActiveCooldowns(),
            ]);

            await interaction.editReply({
                content:
                    "# ⏳ Global Trivia Cooldowns\n\n" +
                    `Cooldowns Started: **${formatNumber(stats.cooldownsStarted)}**\n` +
                    `Currently Active: **${formatNumber(active)}**`,
            });
        } catch (error) {
            console.error(
                "❌ COOLDOWN STATS FAILED:",
                error
            );

            await interaction.editReply({
                content:
                    "❌ Failed to retrieve cooldown statistics.",
            });
        }
    }
}

module.exports = {
    statsCommand,
    handleStatsCommand,
};

