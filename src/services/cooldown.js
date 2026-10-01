const {
    SlashCommandBuilder,
    MessageFlags,
} = require("discord.js");

const {
    hasCommandAccess,
} = require("./COMMAND_ACCESS");

const {
    getCooldown,
    removeCooldown,
    modifyCooldown,
    clearAllCooldowns,
    listActiveCooldowns,
    COOLDOWN_SECONDS,
} = require("./cooldownService");

const {
    formatCooldown,
} = require("../utils/time");

const cooldownCommand =
    new SlashCommandBuilder()
        .setIntegrationTypes(1)
        .setContexts(0, 1, 2)
        .setName("cooldown")
        .setDescription(
            "Manage Permanent Trivia cooldowns."
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
                    .setName("action")
                    .setDescription(
                        "Cooldown action."
                    )
                    .setRequired(true)
                    .addChoices(
                        {
                            name:
                                "check",
                            value:
                                "check",
                        },
                        {
                            name:
                                "remove",
                            value:
                                "remove",
                        },
                        {
                            name:
                                "modify",
                            value:
                                "modify",
                        }
                    )
        )
        .addUserOption(
            option =>
                option
                    .setName("user")
                    .setDescription(
                        "User to manage."
                    )
                    .setRequired(false)
        )
        .addBooleanOption(
            option =>
                option
                    .setName("clear_all")
                    .setDescription(
                        "Clear every active trivia cooldown."
                    )
                    .setRequired(false)
        );

async function handleCooldownCommand(
    interaction
) {
    if (
        !hasCommandAccess(
            "cooldown",
            interaction.user.id
        )
    ) {
        await interaction.reply({
            content:
                "❌ You are not authorized to manage Pierro cooldowns.",
            flags:
                MessageFlags.Ephemeral,
        });

        return;
    }

    const action =
        interaction.options.getString(
            "action",
            true
        );

    const user =
        interaction.options.getUser(
            "user"
        );

    const clearAll =
        interaction.options.getBoolean(
            "clear_all"
        ) === true;

    if (clearAll) {
        const count =
            await clearAllCooldowns();

        await interaction.reply({
            content:
                `🧹 Cleared **${count}** active trivia cooldown(s).`,
            flags:
                MessageFlags.Ephemeral,
        });

        return;
    }

    if (!user) {
        await interaction.reply({
            content:
                "❌ Select a user unless you are using `clear_all:true`.",
            flags:
                MessageFlags.Ephemeral,
        });

        return;
    }

    if (
        action ===
        "check"
    ) {
        const remaining =
            await getCooldown(
                user.id
            );

        if (
            remaining <= 0
        ) {
            await interaction.reply({
                content:
                    `🟢 <@${user.id}> has no active trivia cooldown.`,
                flags:
                    MessageFlags.Ephemeral,
            });

            return;
        }

        await interaction.reply({
            content:
                `⏳ <@${user.id}> has **${formatCooldown(remaining)}** remaining on their trivia cooldown.`,
            flags:
                MessageFlags.Ephemeral,
        });

        return;
    }

    if (
        action ===
        "remove"
    ) {
        const previous =
            await getCooldown(
                user.id
            );

        await removeCooldown(
            user.id
        );

        await interaction.reply({
            content:
                previous > 0
                    ? `🧹 Removed <@${user.id}>'s trivia cooldown. Previous remaining time: **${formatCooldown(previous)}**.`
                    : `ℹ️ <@${user.id}> did not have an active trivia cooldown.`,
            flags:
                MessageFlags.Ephemeral,
        });

        return;
    }

    if (
        action ===
        "modify"
    ) {
        const expiresAt =
            await modifyCooldown(
                user.id,
                COOLDOWN_SECONDS
            );

        await interaction.reply({
            content:
                `🔧 Reset <@${user.id}>'s trivia cooldown to **24 hours**.\nExpires <t:${Math.floor(expiresAt / 1000)}:R>.`,
            flags:
                MessageFlags.Ephemeral,
        });
    }
}

module.exports = {
    cooldownCommand,
    handleCooldownCommand,
    getActiveCooldownList: listActiveCooldowns,
};
