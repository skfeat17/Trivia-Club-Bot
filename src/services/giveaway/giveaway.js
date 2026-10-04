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
    getActiveGiveawayId,
    setActiveGiveawayId,
    clearActiveGiveawayId,

    getGiveaway,
    saveGiveaway,

    addParticipant,
    getParticipants,
    getParticipantCount,

    acquireGiveawayLock,
    releaseGiveawayLock,
} = require("./giveawayRedis");

const {
    hasCommandAccess,
} = require("../COMMAND_ACCESS");


// ============================================================
// TIMERS
// ============================================================

const timers = new Map();

// Keeps the original slash interaction available while the bot stays online.
// It cannot survive a process restart. Post-restart Discord UI updates are
// therefore skipped rather than using normal channel permissions.
const activeInteractions = new Map();


// ============================================================
// DURATION PARSER
// ============================================================

function parseDuration(input) {

    if (!input) {
        return null;
    }

    const match =
        String(input)
            .trim()
            .toLowerCase()
            .match(
                /^(\d+)\s*(s|sec|secs|m|min|mins|h|hr|hrs|d|day|days)$/
            );

    if (!match) {
        return null;
    }

    const amount =
        Number(match[1]);

    const unit =
        match[2];

    let multiplier;

    if (
        ["s", "sec", "secs"].includes(unit)
    ) {
        multiplier = 1000;
    }

    else if (
        ["m", "min", "mins"].includes(unit)
    ) {
        multiplier = 60 * 1000;
    }

    else if (
        ["h", "hr", "hrs"].includes(unit)
    ) {
        multiplier = 60 * 60 * 1000;
    }

    else {
        multiplier =
            24 * 60 * 60 * 1000;
    }

    const duration =
        amount * multiplier;

    // Maximum 30 days
    const MAX_DURATION =
        30 * 24 * 60 * 60 * 1000;

    if (
        duration <= 0 ||
        duration > MAX_DURATION
    ) {
        return null;
    }

    return duration;
}


// ============================================================
// ID
// ============================================================

function generateGiveawayId() {

    return (
        "gw_" +
        Date.now().toString(36) +
        "_" +
        crypto
            .randomBytes(4)
            .toString("hex")
    );
}


// ============================================================
// EMBED
// ============================================================

function createGiveawayEmbed(
    giveaway,
    participantCount
) {

    const baseDescription =
        `**Giveaway for:** ${giveaway.name}\n\n` +
        giveaway.description;

    const embed =
        new EmbedBuilder()
            .setTitle("🎉 Giveaway")
            .setDescription(baseDescription)
            .addFields({
                name: "⏳ Ends",
                value:
                    `<t:${Math.floor(
                        giveaway.endsAt / 1000
                    )}:R>`,
                inline: true,
            });

    if (giveaway.status === "completed") {
        if (giveaway.winnerId) {
            embed
                .setTitle("🏆 Giveaway")
                .setDescription(baseDescription)
                .addFields(
                    {
                        name: "🏆 Winner",
                        value: `<@${giveaway.winnerId}>`,
                        inline: false,
                    },
                    {
                        name: "👥 Total Participants",
                        value: String(giveaway.participantCountAtEnd),
                        inline: true,
                    }
                );
        } else {
            embed
                .setTitle("❌ Giveaway")
                .setDescription(
                    baseDescription +
                    "\n\nNo one participated in this giveaway."
                );
        }
    }

    return embed;
}

// ============================================================
// PARTICIPATE BUTTON
// ============================================================

function createParticipateRow(
    giveawayId,
    disabled = false
) {

    const button =
        new ButtonBuilder()
            .setCustomId(
                `pierro:giveaway:participate:${giveawayId}`
            )
            .setLabel("Participate")
            .setEmoji("🎟️")
            .setStyle(
                ButtonStyle.Primary
            )
            .setDisabled(disabled);

    return new ActionRowBuilder()
        .addComponents(button);
}


// ============================================================
// START COMMAND
// ============================================================

async function startGiveaway(
    interaction
) {

    const name =
        interaction.options.getString(
            "name"
        );

    const description =
        interaction.options.getString(
            "description"
        );

    const durationInput =
        interaction.options.getString(
            "duration"
        );

    if (!name) {

        await interaction.editReply(
            "❌ You must provide a giveaway name."
        );

        return;
    }

    if (!description) {

        await interaction.editReply(
            "❌ You must provide a giveaway description."
        );

        return;
    }

    const durationMs =
        parseDuration(
            durationInput
        );

    if (!durationMs) {

        await interaction.editReply(
            "❌ Invalid duration. Use formats like `30s`, `10m`, `2h`, or `1d`."
        );

        return;
    }


    // --------------------------------------------------------
    // LOCK
    // --------------------------------------------------------

    const locked =
        await acquireGiveawayLock();

    if (!locked) {

        await interaction.editReply(
            "⚠️ Another giveaway operation is currently running."
        );

        return;
    }


    try {

        const activeId =
            await getActiveGiveawayId();

        if (activeId) {

            await interaction.editReply(
                "⚠️ A giveaway is already active."
            );

            return;
        }


        const now =
            Date.now();

        const giveaway = {

            id:
                generateGiveawayId(),

            guildId:
                interaction.guildId,

            channelId:
                interaction.channelId,

            messageId:
                null,

            name,

            description,

            durationMs,

            startedAt:
                now,

            endsAt:
                now + durationMs,

            status:
                "active",

            startedBy:
                interaction.user.id,

            winnerId:
                null,

            participantCountAtEnd:
                0,

            endingReason:
                null,

            finishedAt:
                null,
        };


        // Save state FIRST
        await saveGiveaway(
            giveaway
        );

        await setActiveGiveawayId(
            giveaway.id
        );


        // ----------------------------------------------------
        // PRIVATE START CONFIRMATION
        // ----------------------------------------------------

        // The original /giveaway interaction stays private.
        // This is ONLY the staff/admin confirmation.
        await interaction.editReply({

            content:
                `✅ **Giveaway started!**\n\n` +
                `🎁 **${name}**\n` +
                `⏳ Ends <t:${Math.floor(giveaway.endsAt / 1000)}:R>`,
        });


        // ----------------------------------------------------
        // PUBLIC GIVEAWAY MESSAGE
        // ----------------------------------------------------

        // IMPORTANT:
        // Do NOT use channel.send().
        // The bot operates through user-level interaction/webhook
        // permissions only. The public giveaway is a NON-EPHEMERAL
        // follow-up sent after the private confirmation above.
        const message =
            await interaction.followUp({

                content: null,

                embeds: [
                    createGiveawayEmbed(
                        giveaway,
                        0
                    ),
                ],

                components: [
                    createParticipateRow(
                        giveaway.id
                    ),
                ],

                ephemeral: false,

                fetchReply: true,
            });


        giveaway.messageId =
            message.id;

        await saveGiveaway(
            giveaway
        );


        // ----------------------------------------------------
        // KEEP ORIGINAL INTERACTION FOR FOLLOW-UP
        // ----------------------------------------------------

        activeInteractions.set(
            giveaway.id,
            interaction
        );

        // ----------------------------------------------------
        // START TIMER
        // ----------------------------------------------------

        scheduleGiveawayEnd(
            interaction.client,
            giveaway
        );


        await interaction.editReply(
            `✅ Giveaway **${name}** started successfully.`
        );

    }

    catch (error) {

        console.error(
            "❌ Giveaway start error:",
            error
        );

        await clearActiveGiveawayId();

        await interaction.editReply(
            "❌ Failed to start the giveaway."
        );

    }

    finally {

        await releaseGiveawayLock();
    }
}


// ============================================================
// END TIMER
// ============================================================

function scheduleGiveawayEnd(
    client,
    giveaway
) {

    const existing =
        timers.get(
            giveaway.id
        );

    if (existing) {
        clearTimeout(existing);
    }

    const delay =
        Math.max(
            0,
            giveaway.endsAt -
            Date.now()
        );

    const timer =
        setTimeout(
            () => {

                endGiveaway(
                    client,
                    giveaway.id,
                    "expired",
                    activeInteractions.get(giveaway.id) || null
                ).catch(error =>
                    console.error(
                        "❌ Automatic giveaway ending failed:",
                        error
                    )
                );

            },
            delay
        );

    timers.set(
        giveaway.id,
        timer
    );
}


// ============================================================
// BUTTON HANDLER
// ============================================================

async function handleGiveawayButton(interaction) {

    // --------------------------------------------------------
    // ACKNOWLEDGE IMMEDIATELY
    // --------------------------------------------------------

    try {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral,
        });
    } catch (error) {
        console.error(
            "❌ Failed to acknowledge giveaway button:",
            error
        );

        return;
    }


    const client =
        interaction.client;


    try {

        // ----------------------------------------------------
        // GET GIVEAWAY ID
        // ----------------------------------------------------

        const giveawayId =
            interaction.customId.split(":")[3];


        if (!giveawayId) {

            await interaction.editReply(
                "❌ Invalid giveaway button."
            );

            return;
        }


        // ----------------------------------------------------
        // BLOCK BOTS
        // ----------------------------------------------------

        if (interaction.user.bot) {

            await interaction.editReply(
                "❌ Bots cannot participate."
            );

            return;
        }


        // ----------------------------------------------------
        // GET GIVEAWAY
        // ----------------------------------------------------

        const giveaway =
            await getGiveaway(
                giveawayId
            );


        if (
            !giveaway ||
            giveaway.status !== "active"
        ) {

            await interaction.editReply(
                "❌ This giveaway is no longer active."
            );

            return;
        }


        // ----------------------------------------------------
        // CHECK EXPIRY
        // ----------------------------------------------------

        if (
            Date.now() >=
            giveaway.endsAt
        ) {

            await interaction.editReply(
                "⏰ This giveaway has ended."
            );

            return;
        }


        // ----------------------------------------------------
        // ACQUIRE LOCK
        // ----------------------------------------------------

        const locked =
            await acquireGiveawayLock();


        if (!locked) {

            await interaction.editReply(
                "⚠️ Please try again in a moment."
            );

            return;
        }


        try {

            // ------------------------------------------------
            // RE-CHECK AFTER LOCK
            // ------------------------------------------------

            const current =
                await getGiveaway(
                    giveawayId
                );


            if (
                !current ||
                current.status !== "active"
            ) {

                await interaction.editReply(
                    "❌ This giveaway is no longer active."
                );

                return;
            }


            if (
                Date.now() >=
                current.endsAt
            ) {

                await interaction.editReply(
                    "⏰ This giveaway has ended."
                );

                return;
            }


            // ------------------------------------------------
            // ADD PARTICIPANT
            // ------------------------------------------------

            const added =
                await addParticipant(
                    giveawayId,
                    interaction.user.id
                );


            if (added === 0) {

                await interaction.editReply(
                    "⚠️ You are already participating in this giveaway!"
                );

                return;
            }


            // ------------------------------------------------
            // SUCCESS
            // ------------------------------------------------

            await interaction.editReply(
                "✅ You have entered the giveaway! Good luck! 🎉"
            );

        } finally {

            await releaseGiveawayLock();

        }

    } catch (error) {

        console.error(
            "❌ GIVEAWAY BUTTON ERROR:",
            error
        );


        try {

            await interaction.editReply(
                "❌ Something went wrong while joining the giveaway."
            );

        } catch (replyError) {

            console.error(
                "❌ Failed to send giveaway error response:",
                replyError
            );

        }

    }
}


// ============================================================
// END GIVEAWAY
// ============================================================

async function endGiveaway(
    client,
    giveawayId,
    reason = "manual",
    followUpInteraction = null
) {

    const locked =
        await acquireGiveawayLock();

    if (!locked) {
        console.log(
            "⚠️ Giveaway end lock busy."
        );
        return;
    }

    let completedGiveaway = null;
    let participants = [];

    try {

        const current =
            await getGiveaway(
                giveawayId
            );

        if (!current) {
            return;
        }

        // Another end operation may have already completed it.
        if (current.status === "completed") {
            return;
        }

        // Pull the complete participant list directly from Redis.
        participants =
            await getParticipants(
                giveawayId
            );

        console.log(
            `🎟️ GIVEAWAY PARTICIPANTS | ${participants.length}`
        );

        // --------------------------------------------------------
        // SELECT WINNER DIRECTLY
        // --------------------------------------------------------

        let winnerId = null;

        if (participants.length > 0) {
            const winnerIndex =
                crypto.randomInt(
                    0,
                    participants.length
                );

            winnerId =
                participants[winnerIndex];
        }

        // --------------------------------------------------------
        // COMPLETE STATE FIRST
        // --------------------------------------------------------

        current.status =
            "completed";

        current.winnerId =
            winnerId;

        current.participantCountAtEnd =
            participants.length;

        current.endingReason =
            reason;

        current.finishedAt =
            Date.now();

        // Redis is updated BEFORE any Discord announcement.
        await saveGiveaway(
            current
        );

        await clearActiveGiveawayId();

        completedGiveaway = current;

        // Stop the in-memory timer.
        const timer =
            timers.get(current.id);

        if (timer) {
            clearTimeout(timer);
            timers.delete(current.id);
        }

    } finally {

        await releaseGiveawayLock();
    }

    if (!completedGiveaway) {
        return;
    }

    // ------------------------------------------------------------
    // DISCORD UI / ANNOUNCEMENT
    // ------------------------------------------------------------

    await showWinner(
        client,
        completedGiveaway,
        followUpInteraction ||
            activeInteractions.get(completedGiveaway.id) ||
            null
    );

    activeInteractions.delete(
        completedGiveaway.id
    );
}


// ============================================================
// NO WINNER / COMPLETED MESSAGE
// ============================================================

async function showWinner(
    client,
    giveaway,
    followUpInteraction = null
) {

    const uiInteraction =
        followUpInteraction ||
        activeInteractions.get(giveaway.id) ||
        null;

    if (!uiInteraction?.webhook) {
        return;
    }

    // --------------------------------------------------------
    // NO PARTICIPANTS
    // --------------------------------------------------------

    if (!giveaway.winnerId) {

        try {
            await uiInteraction.webhook.editMessage(
                giveaway.messageId,
                {
                    content: null,
                    embeds: [
                        createGiveawayEmbed(
                            giveaway,
                            giveaway.participantCountAtEnd
                        ),
                    ],
                    components: [],
                }
            );
        } catch {
            // Expected if the interaction webhook has expired.
        }

        return;
    }

    const embed =
        new EmbedBuilder()
            .setTitle("🏆 Giveaway")
            .setDescription(
                `**Giveaway for:** ${giveaway.name}\n\n` +
                `Congratulations <@${giveaway.winnerId}>! 🎉\n` +
                `You won this giveaway!`
            )
            .addFields({
                name: "👥 Participants",
                value: String(
                    giveaway.participantCountAtEnd
                ),
                inline: true,
            });

    // Announce through the interaction webhook only.
    try {
        await uiInteraction.followUp({
            content: `<@${giveaway.winnerId}>`,
            embeds: [embed],
            ephemeral: false,
        });
    } catch {
        // Expected if the interaction webhook has expired.
    }

    // Replace the original giveaway message with the completed state.
    if (giveaway.messageId) {
        try {
            await uiInteraction.webhook.editMessage(
                giveaway.messageId,
                {
                    content: null,
                    embeds: [
                        createGiveawayEmbed(
                            giveaway,
                            giveaway.participantCountAtEnd
                        ),
                    ],
                    components: [],
                }
            );
        } catch {
            // Expected if the interaction webhook has expired.
        }
    }
}


// ============================================================
// COMMAND HANDLER
// ============================================================

async function handleGiveawayCommand(
    interaction
) {

    if (
        !hasCommandAccess(
            "giveaway",
            interaction.user.id
        )
    ) {

        await interaction.reply({

            content:
                "❌ You are not authorized to manage Pierro.",

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


    await interaction.deferReply({
        flags:
            MessageFlags.Ephemeral,
    });


    if (
        action === "start"
    ) {

        await startGiveaway(
            interaction
        );

        return;
    }


    if (
        action === "end"
    ) {

        const activeId =
            await getActiveGiveawayId();

        if (!activeId) {

            await interaction.editReply(
                "ℹ️ There is no active giveaway."
            );

            return;
        }


        await endGiveaway(
            interaction.client,
            activeId,
            "manual",
            interaction
        );


        await interaction.editReply(
            "🏆 Giveaway ended successfully."
        );

        return;
    }
}


// ============================================================
// RESTORE AFTER RESTART
// ============================================================

async function restoreGiveaway(
    client
) {

    try {

        const activeId =
            await getActiveGiveawayId();

        if (!activeId) {
            return;
        }


        const giveaway =
            await getGiveaway(
                activeId
            );

        if (!giveaway) {

            await clearActiveGiveawayId();

            return;
        }


        console.log(
            `🎁 Restoring giveaway ${giveaway.id} | Status: ${giveaway.status}`
        );


        if (
            giveaway.status ===
            "completed"
        ) {

            await clearActiveGiveawayId();

            return;
        }


        if (
            Date.now() >=
            giveaway.endsAt
        ) {

            await endGiveaway(
                client,
                giveaway.id,
                "expired"
            );

            return;
        }


        // Giveaway still active
        scheduleGiveawayEnd(
            client,
            giveaway
        );


    }

    catch (error) {

        console.error(
            "❌ Giveaway restore failed:",
            error
        );
    }
}

const giveawayCommand =
    new SlashCommandBuilder()
        .setName("giveaway")
        .setDescription(
            "Manage a Pierro giveaway."
        )
        .addStringOption(option =>
            option
                .setName("action")
                .setDescription(
                    "Start or end the giveaway."
                )
                .setRequired(true)
                .addChoices(
                    {
                        name: "start",
                        value: "start",
                    },
                    {
                        name: "end",
                        value: "end",
                    }
                )
        )
        .addStringOption(option =>
            option
                .setName("name")
                .setDescription(
                    "Giveaway name."
                )
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName("description")
                .setDescription(
                    "Giveaway description."
                )
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName("duration")
                .setDescription(
                    "Examples: 30s, 10m, 2h, 1d."
                )
                .setRequired(true)
        );
module.exports = {
    giveawayCommand,
    handleGiveawayCommand,
    handleGiveawayButton,
    restoreGiveaway,
    endGiveaway,
};