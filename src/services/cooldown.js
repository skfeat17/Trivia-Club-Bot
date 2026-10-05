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
    DROP_COOLDOWN_SECONDS,
} = require("./cooldownService");

const {
    formatCooldown,
} = require("../utils/time");


/* =========================================================
   /COOLDOWN COMMAND
========================================================= */

const cooldownCommand =
    new SlashCommandBuilder()
        .setIntegrationTypes(1)
        .setContexts(0, 1, 2)
        .setName("cooldown")
        .setDescription(
            "Manage Pierro event cooldowns."
        )

        /* EVENT */
        .addStringOption(
            option =>
                option
                    .setName("event")
                    .setDescription(
                        "The event."
                    )
                    .setRequired(true)
                    .addChoices(
                        {
                            name:
                                "trivia",
                            value:
                                "trivia",
                        },
                        {
                            name:
                                "drop",
                            value:
                                "drop",
                        }
                    )
        )

        /* ACTION */
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

        /* USER */
        .addUserOption(
            option =>
                option
                    .setName("user")
                    .setDescription(
                        "User to manage."
                    )
                    .setRequired(true)
        )

        /* CLEAR ALL */
        .addBooleanOption(
            option =>
                option
                    .setName("clear_all")
                    .setDescription(
                        "Clear every active cooldown for this event."
                    )
                    .setRequired(false)
        );


/* =========================================================
   HANDLE /COOLDOWN
========================================================= */

async function handleCooldownCommand(
    interaction
) {

    /* -----------------------------------------
       USER-LEVEL PERMISSION
    ----------------------------------------- */

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


    /* -----------------------------------------
       GET OPTIONS
    ----------------------------------------- */

    const event =
        interaction.options.getString(
            "event",
            true
        );

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


    /* -----------------------------------------
       CLEAR ALL
    ----------------------------------------- */

    if (clearAll) {

        const count =
            await clearAllCooldowns(
                event
            );

        await interaction.reply({
            content:
                `🧹 Cleared **${count}** active ${event} cooldown(s).`,
            flags:
                MessageFlags.Ephemeral,
        });

        return;
    }


    /* -----------------------------------------
       USER REQUIRED
    ----------------------------------------- */

    if (!user) {

        await interaction.reply({
            content:
                "❌ Select a user unless you are using `clear_all:true`.",
            flags:
                MessageFlags.Ephemeral,
        });

        return;
    }


    /* =====================================================
       CHECK
    ===================================================== */

    if (
        action ===
        "check"
    ) {

        const remaining =
            await getCooldown(
                event,
                user.id
            );


        if (
            remaining <= 0
        ) {

            await interaction.reply({
                content:
                    `🟢 <@${user.id}> has no active ${event} cooldown.`,
                flags:
                    MessageFlags.Ephemeral,
            });

            return;
        }


        await interaction.reply({
            content:
                `⏳ <@${user.id}> has **${formatCooldown(remaining)}** remaining on their ${event} cooldown.`,
            flags:
                MessageFlags.Ephemeral,
        });

        return;
    }


    /* =====================================================
       REMOVE
    ===================================================== */

    if (
        action ===
        "remove"
    ) {

        const previous =
            await getCooldown(
                event,
                user.id
            );


        await removeCooldown(
            event,
            user.id
        );


        await interaction.reply({
            content:
                previous > 0

                    ? `🧹 Removed <@${user.id}>'s ${event} cooldown. Previous remaining time: **${formatCooldown(previous)}**.`

                    : `ℹ️ <@${user.id}> did not have an active ${event} cooldown.`,

            flags:
                MessageFlags.Ephemeral,
        });

        return;
    }


    /* =====================================================
       MODIFY
    ===================================================== */

    if (
        action ===
        "modify"
    ) {

        const duration =
            event === "drop"
                ? DROP_COOLDOWN_SECONDS
                : COOLDOWN_SECONDS;


        const expiresAt =
            await modifyCooldown(
                event,
                user.id,
                duration
            );


        const durationText =
            event === "drop"
                ? "1 hour"
                : "24 hours";


        await interaction.reply({
            content:
                `🔧 Reset <@${user.id}>'s ${event} cooldown to **${durationText}**.\n` +
                `Expires <t:${Math.floor(expiresAt / 1000)}:R>.`,

            flags:
                MessageFlags.Ephemeral,
        });

        return;
    }
}


/* =========================================================
   EXPORTS
========================================================= */

module.exports = {
    cooldownCommand,
    handleCooldownCommand,
    getActiveCooldownList:
        listActiveCooldowns,
};