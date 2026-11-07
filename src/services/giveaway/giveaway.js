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
    getPreviousWinnerId,
    setPreviousWinnerId,
    acquireGiveawayLock,
    releaseGiveawayLock,
} = require("./giveawayRedis");

const { hasCommandAccess } = require("../COMMAND_ACCESS");

const activeInteractions = new Map();
const giveawayTimers = new Map();

const MAX_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

// ============================================================
// STAFF IDS
// .env example:
// STAFF_USER_IDS=123456789012345678,234567890123456789
// ============================================================

function getStaffUserIds() {
    return [
        ...new Set(
            (process.env.STAFF_USER_IDS || "")
                .split(",")
                .map(id => id.trim())
                .filter(id => /^\d{17,20}$/.test(id))
        ),
    ];
}

// ============================================================
// DURATION
// ============================================================

function parseDuration(input) {
    if (!input) return null;

    const match = String(input)
        .trim()
        .toLowerCase()
        .match(/^(\d+)\s*(s|sec|secs|m|min|mins|h|hr|hrs|d|day|days)$/);

    if (!match) return null;

    const amount = Number(match[1]);
    const unit = match[2];

    const multipliers = {
        s: 1000,
        sec: 1000,
        secs: 1000,
        m: 60 * 1000,
        min: 60 * 1000,
        mins: 60 * 1000,
        h: 60 * 60 * 1000,
        hr: 60 * 60 * 1000,
        hrs: 60 * 60 * 1000,
        d: 24 * 60 * 60 * 1000,
        day: 24 * 60 * 60 * 1000,
        days: 24 * 60 * 60 * 1000,
    };

    const duration = amount * multipliers[unit];

    if (
        !Number.isSafeInteger(duration) ||
        duration <= 0 ||
        duration > MAX_DURATION_MS
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
        crypto.randomBytes(4).toString("hex")
    );
}

// ============================================================
// EMBEDS / COMPONENTS
// ============================================================

function createGiveawayEmbed(giveaway, participantCount) {
    return new EmbedBuilder()
        .setColor(giveaway.expired ? 0xE67E22 : 0x5865F2)
        .setTitle(`🎉 ${giveaway.name}`)
        .setDescription(giveaway.description)
        .addFields(
            {
                name: "👥 Participants",
                value: String(participantCount),
                inline: true,
            },
            {
                name: giveaway.expired ? "⏰ Expired" : "⏳ Expires",
                value: `<t:${Math.floor(giveaway.endsAt / 1000)}:R>`,
                inline: true,
            }
        )
        .setFooter({
            text: giveaway.expired
                ? "Entries are closed. Staff will select the winner."
                : "Press Participate to enter!",
        });
}

function createWinnerEmbed(giveaway) {
    return new EmbedBuilder()
        .setColor(0xF1C40F)
        .setTitle("🏆 GIVEAWAY WINNER!")
        .setDescription(
            `**${giveaway.name}**\n\n` +
            (
                giveaway.winnerId
                    ? `Congratulations <@${giveaway.winnerId}>! 🎉\nYou won the giveaway!`
                    : "No one participated in this giveaway."
            )
        )
        .addFields({
            name: "👥 Total Participants",
            value: String(giveaway.participantCountAtEnd),
            inline: true,
        })
        .setTimestamp();
}

function createParticipateRow(giveawayId, disabled = false) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`pierro:giveaway:participate:${giveawayId}`)
            .setLabel("Participate")
            .setEmoji("🎟️")
            .setStyle(ButtonStyle.Primary)
            .setDisabled(disabled)
    );
}

// ============================================================
// STAFF EXPIRATION NOTIFICATION (DM)
// ============================================================

async function notifyStaffGiveawayExpired(client, giveawayId) {
    const locked = await acquireGiveawayLock();

    if (!locked) {
        console.warn("⚠️ Giveaway expiry lock is busy; retrying shortly.");
        const retryTimer = setTimeout(() => {
            notifyStaffGiveawayExpired(client, giveawayId).catch(error =>
                console.error("❌ Giveaway expiry retry failed:", error)
            );
        }, 5000);
        retryTimer.unref?.();
        return;
    }

    let giveaway = null;

    try {
        giveaway = await getGiveaway(giveawayId);

        if (
            !giveaway ||
            giveaway.status !== "active" ||
            Date.now() < giveaway.endsAt ||
            giveaway.expirationNotifiedAt
        ) {
            return;
        }

        // Save the notification marker before sending DMs to prevent
        // duplicate notifications after a restart or repeated timer.
        giveaway.expired = true;
        giveaway.expiredAt = Date.now();
        giveaway.expirationNotifiedAt = Date.now();

        await saveGiveaway(giveaway);
    } finally {
        await releaseGiveawayLock();
    }

    const staffIds = getStaffUserIds();

    if (staffIds.length === 0) {
        console.warn(
            "⚠️ STAFF_USER_IDS is empty or contains no valid Discord IDs."
        );
        return;
    }

    const guild = client.guilds.cache.get(giveaway.guildId);
    const channelName = guild?.channels?.cache?.get(giveaway.channelId)?.name;
    const messageLink =
        `https://discord.com/channels/${giveaway.guildId}/${giveaway.channelId}/${giveaway.messageId}`;

    const participantCount = await getParticipantCount(giveawayId);

    const notificationEmbed = new EmbedBuilder()
        .setColor(0xE67E22)
        .setTitle("⏰ GIVEAWAY EXPIRED")
        .setDescription(
            "Entries are now closed. The giveaway and its participant list are safely in Redis.\n\n" +
            "Run **/giveaway action:end** in the server to select and announce the winner."
        )
        .addFields(
            {
                name: "🎁 Giveaway",
                value: giveaway.name,
                inline: false,
            },
            {
                name: "👥 Participants",
                value: String(participantCount),
                inline: true,
            },
            {
                name: "📢 Channel",
                value: channelName ? `#${channelName}` : `<#${giveaway.channelId}>`,
                inline: true,
            },
            {
                name: "🔗 Giveaway Message",
                value: `[Jump to giveaway](${messageLink})`,
                inline: false,
            }
        )
        .setFooter({
            text: "Staff action required • Use /giveaway action:end",
        })
        .setTimestamp();

    for (const staffId of staffIds) {
        try {
            const staffUser = await client.users.fetch(staffId);
            await staffUser.send({
                embeds: [notificationEmbed],
            });
        } catch (error) {
            console.error(
                `❌ Could not DM giveaway expiry notification to staff ${staffId}:`,
                error.message
            );
        }
    }
}

// ============================================================
// EXPIRATION TIMER
// ============================================================

function scheduleGiveawayExpiry(client, giveaway) {
    const existingTimer = giveawayTimers.get(giveaway.id);

    if (existingTimer) {
        clearTimeout(existingTimer);
        giveawayTimers.delete(giveaway.id);
    }

    const delay = Math.max(0, giveaway.endsAt - Date.now());

    const timer = setTimeout(async () => {
        giveawayTimers.delete(giveaway.id);

        try {
            await notifyStaffGiveawayExpired(client, giveaway.id);
        } catch (error) {
            console.error("❌ Giveaway expiry handler failed:", error);
        }
    }, delay);

    giveawayTimers.set(giveaway.id, timer);
}

// ============================================================
// START GIVEAWAY
// ============================================================

async function startGiveaway(interaction) {
    const name = interaction.options.getString("title");
    const description = interaction.options.getString("description");
    const durationInput = interaction.options.getString("duration");
    const durationMs = parseDuration(durationInput);

    if (!name || !description || !durationMs) {
        await interaction.editReply(
            "❌ Provide a **title**, **description**, and valid **duration** (`30s`, `10m`, `2h`, `1d`). Maximum duration is 30 days."
        );
        return;
    }

    const locked = await acquireGiveawayLock();

    if (!locked) {
        await interaction.editReply(
            "⚠️ Another giveaway operation is currently running. Try again shortly."
        );
        return;
    }

    let giveaway;

    try {
        const activeId = await getActiveGiveawayId();

        if (activeId) {
            await interaction.editReply("⚠️ A giveaway is already active.");
            return;
        }

        const now = Date.now();

        giveaway = {
            id: generateGiveawayId(),
            guildId: interaction.guildId,
            channelId: interaction.channelId,
            messageId: null,
            name,
            description,
            durationMs,
            startedAt: now,
            endsAt: now + durationMs,
            status: "active",
            expired: false,
            expiredAt: null,
            expirationNotifiedAt: null,
            startedBy: interaction.user.id,
            winnerId: null,
            participantCountAtEnd: 0,
            endingReason: null,
            finishedAt: null,
        };

        await saveGiveaway(giveaway);
        await setActiveGiveawayId(giveaway.id);
    } finally {
        await releaseGiveawayLock();
    }

    try {
        // This is the public deferred slash-command response.
        // No channel.send() or elevated channel permissions are needed.
        const message = await interaction.editReply({
            embeds: [createGiveawayEmbed(giveaway, 0)],
            components: [createParticipateRow(giveaway.id)],
        });

        giveaway.messageId = message.id;
        await saveGiveaway(giveaway);

        activeInteractions.set(giveaway.id, interaction);
        scheduleGiveawayExpiry(interaction.client, giveaway);
    } catch (error) {
        console.error("❌ Giveaway public message error:", error);

        const lockedAgain = await acquireGiveawayLock();

        if (lockedAgain) {
            try {
                await clearActiveGiveawayId();

                if (giveaway) {
                    giveaway.status = "cancelled";
                    await saveGiveaway(giveaway);
                }
            } finally {
                await releaseGiveawayLock();
            }
        }

        await interaction.editReply(
            "❌ The giveaway could not be published."
        );
    }
}

// ============================================================
// PARTICIPATE BUTTON
// ============================================================

async function handleGiveawayButton(interaction) {
    try {
        await interaction.deferUpdate();
    } catch (error) {
        console.error("❌ Failed to acknowledge giveaway button:", error);
        return;
    }

    const giveawayId = interaction.customId.split(":")[3];

    const replyPrivately = async (content) => {
        try {
            await interaction.followUp({
                content,
                flags: MessageFlags.Ephemeral,
            });
        } catch (error) {
            console.error("❌ Failed to send giveaway button response:", error);
        }
    };

    if (!giveawayId) {
        await replyPrivately("❌ Invalid giveaway button.");
        return;
    }

    if (interaction.user.bot) {
        await replyPrivately("❌ Bots cannot participate.");
        return;
    }

    const locked = await acquireGiveawayLock();

    if (!locked) {
        await replyPrivately("⚠️ Please try again in a moment.");
        return;
    }

    let successMessage = null;
    let updatedGiveaway = null;
    let updatedCount = 0;

    try {
        const giveaway = await getGiveaway(giveawayId);

        if (!giveaway || giveaway.status !== "active") {
            successMessage = "❌ This giveaway is no longer active.";
        } else if (Date.now() >= giveaway.endsAt || giveaway.expired) {
            // The giveaway remains stored and active for staff to end,
            // but participants can no longer enter after its expiry.
            successMessage = "⏰ This giveaway has expired. Entries are closed.";
        } else {
            const added = await addParticipant(
                giveawayId,
                interaction.user.id
            );

            if (added === 0) {
                successMessage =
                    "⚠️ You are already participating in this giveaway!";
            } else {
                updatedCount = await getParticipantCount(giveawayId);
                updatedGiveaway = giveaway;
                successMessage =
                    "✅ You have entered the giveaway! Good luck! 🎉";
            }
        }
    } catch (error) {
        console.error("❌ GIVEAWAY BUTTON ERROR:", error);
        successMessage =
            "❌ Something went wrong while joining the giveaway.";
    } finally {
        await releaseGiveawayLock();
    }

    if (updatedGiveaway) {
        try {
            await interaction.editReply({
                embeds: [
                    createGiveawayEmbed(updatedGiveaway, updatedCount),
                ],
                components: [createParticipateRow(giveawayId)],
            });
        } catch (error) {
            console.error(
                "⚠️ Participant saved, but giveaway count could not refresh:",
                error
            );
        }
    }

    await replyPrivately(successMessage);
}

// ============================================================
// END GIVEAWAY / SELECT WINNER
// ============================================================

async function endGiveaway(
    client,
    giveawayId,
    reason = "manual",
    announcementInteraction = null
) {
    const locked = await acquireGiveawayLock();

    if (!locked) {
        if (announcementInteraction) {
            await announcementInteraction.editReply(
                "⚠️ Another giveaway operation is currently running. Try again shortly."
            ).catch(() => {});
        }
        return null;
    }

    let completedGiveaway = null;

    try {
        const current = await getGiveaway(giveawayId);

        if (!current || current.status !== "active") {
            return null;
        }

        const participants = await getParticipants(giveawayId);
        let winnerId = null;

        if (participants.length > 0) {
            const previousWinnerId = await getPreviousWinnerId();

            const previousWinnerParticipated =
                previousWinnerId &&
                participants.includes(previousWinnerId);

            const otherParticipants = previousWinnerParticipated
                ? participants.filter(id => id !== previousWinnerId)
                : participants;

            if (
                previousWinnerParticipated &&
                otherParticipants.length > 0
            ) {
                // Previous winner has a 1% chance.
                // Everyone else shares the remaining 99%.
                if (crypto.randomInt(0, 100) === 0) {
                    winnerId = previousWinnerId;
                } else {
                    winnerId = otherParticipants[
                        crypto.randomInt(0, otherParticipants.length)
                    ];
                }
            } else {
                winnerId = participants[
                    crypto.randomInt(0, participants.length)
                ];
            }
        }

        current.status = "completed";
        current.winnerId = winnerId;
        current.participantCountAtEnd = participants.length;
        current.endingReason = reason;
        current.finishedAt = Date.now();

        await saveGiveaway(current);

        if (winnerId) {
            await setPreviousWinnerId(winnerId);
        }

        await clearActiveGiveawayId();
        completedGiveaway = current;

        const timer = giveawayTimers.get(giveawayId);

        if (timer) {
            clearTimeout(timer);
            giveawayTimers.delete(giveawayId);
        }
    } finally {
        await releaseGiveawayLock();
    }

    if (!completedGiveaway) return null;

    await showWinner(client, completedGiveaway, announcementInteraction);
    activeInteractions.delete(completedGiveaway.id);

    return completedGiveaway;
}

// ============================================================
// PUBLIC WINNER ANNOUNCEMENT
// ============================================================

async function showWinner(
    client,
    giveaway,
    announcementInteraction = null
) {
    const originalInteraction =
        activeInteractions.get(giveaway.id) || null;

    if (announcementInteraction) {
        try {
            // Public /giveaway end interaction response becomes the
            // winner announcement. No channel.send() permission needed.
            await announcementInteraction.editReply({
                content: giveaway.winnerId
                    ? `🎉 Congratulations <@${giveaway.winnerId}>!`
                    : "The giveaway has ended.",
                embeds: [createWinnerEmbed(giveaway)],
            });
        } catch (error) {
            console.error("❌ Could not publish winner announcement:", error);
        }
    }

    // Best-effort update of the original giveaway post. Its interaction
    // webhook may have expired; this is not required for winner selection.
    if (originalInteraction?.webhook && giveaway.messageId) {
        try {
            await originalInteraction.webhook.editMessage(
                giveaway.messageId,
                {
                    embeds: [
                        createGiveawayEmbed(
                            giveaway,
                            giveaway.participantCountAtEnd
                        ),
                    ],
                    components: [createParticipateRow(giveaway.id, true)],
                }
            );
        } catch (error) {
            console.warn(
                "⚠️ Could not update original giveaway post:",
                error.message
            );
        }
    }
}

// ============================================================
// COMMAND HANDLER
// ============================================================

async function handleGiveawayCommand(interaction) {
    if (!hasCommandAccess("giveaway", interaction.user.id)) {
        await interaction.reply({
            content: "❌ You are not authorized to manage Pierro.",
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const action = interaction.options.getString("action", true);

    // Public response, sent through the slash-command interaction webhook.
    await interaction.deferReply();

    if (action === "start") {
        await startGiveaway(interaction);
        return;
    }

    if (action === "end") {
        const activeId = await getActiveGiveawayId();

        if (!activeId) {
            await interaction.editReply(
                "ℹ️ There is no active giveaway."
            );
            return;
        }

        const result = await endGiveaway(
            interaction.client,
            activeId,
            "manual",
            interaction
        );

        if (!result) {
            await interaction.editReply(
                "⚠️ The giveaway could not be ended. Please try again."
            );
        }
        // On success, showWinner() has already edited this public response.
    }
}

// ============================================================
// RESTORE AFTER RESTART
// ============================================================

async function restoreGiveaway(client) {
    try {
        const activeId = await getActiveGiveawayId();

        if (!activeId) return;

        const giveaway = await getGiveaway(activeId);

        if (!giveaway || giveaway.status !== "active") {
            await clearActiveGiveawayId();
            return;
        }

        console.log(
            `🎁 Restored giveaway ${giveaway.id} | ` +
            `Expires: ${new Date(giveaway.endsAt).toISOString()}`
        );

        if (Date.now() >= giveaway.endsAt) {
            // Expired while the bot was offline: notify staff now.
            await notifyStaffGiveawayExpired(client, giveaway.id);
        } else {
            scheduleGiveawayExpiry(client, giveaway);
        }
    } catch (error) {
        console.error("❌ Giveaway restore failed:", error);
    }
}

// ============================================================
// SLASH COMMAND
// ============================================================

const giveawayCommand = new SlashCommandBuilder()
    .setName("giveaway")
    .setDescription("Manage a Pierro giveaway.")
    .addStringOption(option =>
        option
            .setName("action")
            .setDescription("Start or end the giveaway.")
            .setRequired(true)
            .addChoices(
                { name: "start", value: "start" },
                { name: "end", value: "end" }
            )
    )
    .addStringOption(option =>
        option
            .setName("title")
            .setDescription("Giveaway title (required for start).")
            .setRequired(false)
    )
    .addStringOption(option =>
        option
            .setName("description")
            .setDescription("Giveaway description (required for start).")
            .setRequired(false)
    )
    .addStringOption(option =>
        option
            .setName("duration")
            .setDescription("Examples: 30s, 10m, 2h, 1d (maximum 30 days).")
            .setRequired(false)
    );

module.exports = {
    giveawayCommand,
    handleGiveawayCommand,
    handleGiveawayButton,
    restoreGiveaway,
    endGiveaway,
};
