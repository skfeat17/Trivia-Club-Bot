require("dotenv").config();

const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
    SlashCommandBuilder,
} = require("discord.js");

const {
    createPaymentTransaction,
} = require("../paymentService");

const {
    recordParticipation,
    recordMora,
} = require("../statsService");

const {
    saveDrop,
    getDrop,
    deleteDrop,
    claimMysteryDrop,
    getDropCooldown,
    startDropCooldown,
} = require("./dropRedis");

const {
    hasCommandAccess,
} = require("../COMMAND_ACCESS");

const MORA_EMOJI =
    process.env.MORA_EMOJI || "🪙";


/* =========================================================
   MYSTERY DROP EMBED
========================================================= */

function buildDropEmbed(drop) {
    const completed =
        drop.status === "completed";

    return new EmbedBuilder()
        .setTitle(
            completed
                ? "❄️━━━━━━━━━━━━━━━━━━❄️\n        🏆 𝗠𝗬𝗦𝗧𝗘𝗥𝗬 𝗗𝗥𝗢𝗣\n❄️━━━━━━━━━━━━━━━━━━❄️"
                : "❄️━━━━━━━━━━━━━━━━━━❄️\n        ✨ 𝗠𝗬𝗦𝗧𝗘𝗥𝗬 𝗗𝗥𝗢𝗣\n❄️━━━━━━━━━━━━━━━━━━❄️"
        )
        .setDescription(
            "A forgotten treasure has surfaced...\n\n" +
            `🎁 **Reward:** ${completed
                ? `**${drop.amount} ${MORA_EMOJI}**`
                : "???"
            }\n\n` +
             (
        completed
            ? `🏆 **Claimed by:** <@${drop.winnerId}>\n\nThe mystery has been claimed!`
            : "🏃 Be the first to claim it!\n\n" +
              '*"Only the swift shall know what fortune awaits."*\n\n' +
              `**Mystery Drop By:** <@${drop.createdBy}>`
    )

        )
}


/* =========================================================
   CLAIM BUTTON
========================================================= */

function buildClaimRow(eventId) {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(
                    `pierro:drop:claim:${eventId}`
                )
                .setLabel(
                    "🎁 Claim Mystery Drop"
                )
                .setStyle(
                    ButtonStyle.Primary
                )
        ),
    ];
}


/* =========================================================
   /DROP COMMAND
========================================================= */

const dropCommand =
    new SlashCommandBuilder()
        .setName("drop")
        .setDescription(
            "Create a Mystery Drop."
        )
        .addIntegerOption(option =>
            option
                .setName("amount")
                .setDescription(
                    "Mora reward for the winner."
                )
                .setRequired(true)
                .setMinValue(1)
        );


/* =========================================================
   HANDLE /DROP
========================================================= */

async function handleDropCommand(interaction) {

    /* -----------------------------------------
       ACKNOWLEDGE INTERACTION IMMEDIATELY
       KEEP THIS PRIVATE
    ----------------------------------------- */

    try {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral,
        });
    } catch (error) {
        console.error(
            "❌ DROP COMMAND ACKNOWLEDGEMENT FAILED:",
            error.code,
            error.message
        );
        return;
    }


    /* -----------------------------------------
       USER-LEVEL PERMISSION
    ----------------------------------------- */

    if (
        !hasCommandAccess(
            "drop",
            interaction.user.id
        )
    ) {
        await interaction.editReply({
            content:
                "❌ You do not have permission to use this command.",
        });

        return;
    }


    /* -----------------------------------------
       GET REWARD AMOUNT
    ----------------------------------------- */

    const amount =
        interaction.options.getInteger(
            "amount",
            true
        );


    /* -----------------------------------------
       VALIDATE AMOUNT
    ----------------------------------------- */

    if (
        !Number.isInteger(amount) ||
        amount <= 0
    ) {
        await interaction.editReply({
            content:
                "❌ The drop amount must be a positive whole number.",
        });

        return;
    }


    /* -----------------------------------------
       CREATE DROP ID
    ----------------------------------------- */

    const eventId =
        `drop_${interaction.id}`;


    /* -----------------------------------------
       CREATE DROP OBJECT
    ----------------------------------------- */

    const drop = {
        eventId,
        amount,
        status: "active",
        winnerId: null,

        guildId:
            interaction.guildId || null,

        channelId:
            interaction.channelId,

        messageId: null,

        createdAt:
            Date.now(),

        createdBy:
            interaction.user.id,
    };


    /* -----------------------------------------
       SAVE DROP
    ----------------------------------------- */
    try {
        await saveDrop(drop);

        // PRIVATE command acknowledgement
        await interaction.editReply({
            content:
                `✅ Mystery Drop created for **${amount} ${MORA_EMOJI}**.`,
        });

        // PUBLIC Mystery Drop message
        const message =
            await interaction.followUp({
                embeds: [
                    buildDropEmbed(drop),
                ],
                components:
                    buildClaimRow(eventId),
                ephemeral: false,
                wait: true,
            });

        drop.messageId = message.id;

        await saveDrop(drop);

    } catch (error) {
        await deleteDrop(eventId);

        console.error(
            "❌ Failed to create Mystery Drop:",
            error
        );

        await interaction.editReply({
            content:
                "❌ I couldn't create the Mystery Drop.",
        });
    }
}
/* =========================================================
   HANDLE CLAIM BUTTON
========================================================= */

async function handleDropButton(interaction) {

    /* -----------------------------------------
       MAKE SURE THIS IS OUR BUTTON
    ----------------------------------------- */

    if (
        !interaction.customId.startsWith(
            "pierro:drop:claim:"
        )
    ) {
        return;
    }


    /* -----------------------------------------
       ACKNOWLEDGE BUTTON IMMEDIATELY
    ----------------------------------------- */

    try {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral,
        });
    } catch (error) {
        console.error(
            "❌ DROP BUTTON ACKNOWLEDGEMENT FAILED:",
            error.code,
            error.message
        );
        return;
    }


    /* -----------------------------------------
       EXTRACT EVENT ID
    ----------------------------------------- */

    const eventId =
        interaction.customId.replace(
            "pierro:drop:claim:",
            ""
        );


    /* -----------------------------------------
       LOAD DROP
    ----------------------------------------- */

    const drop =
        await getDrop(eventId);


    /* -----------------------------------------
       CHECK DROP STATUS
    ----------------------------------------- */

    if (
        !drop ||
        drop.status !== "active"
    ) {
        await interaction.editReply({
            content:
                "❄️ This Mystery Drop has already been claimed!",
        });

        return;
    }


    const userId =
        interaction.user.id;


    /* -----------------------------------------
       STAFF ARE IMMUNE TO COOLDOWN
    ----------------------------------------- */

    const isStaff = false
    // hasCommandAccess(
    //     "drop",
    //     userId
    // );


    /* -----------------------------------------
       USER COOLDOWN
    ----------------------------------------- */

    if (!isStaff) {

        const cooldown =
            await getDropCooldown(userId);

        if (cooldown > 0) {

            const hours =
                Math.floor(cooldown / 3600);

            const minutes =
                Math.floor(
                    (cooldown % 3600) / 60
                );

            const seconds =
                cooldown % 60;

            const time =
                hours > 0
                    ? `${hours}h ${minutes}m`
                    : minutes > 0
                        ? `${minutes}m ${seconds}s`
                        : `${seconds}s`;

            await interaction.editReply({
                content:
                    `⏳ You are on cooldown!\n\n` +
                    `You can open another Mystery Drop in **${time}**.`,
            });

            return;
        }

    }


    /* -----------------------------------------
       ATOMIC CLAIM
    ----------------------------------------- */

    const claimed =
        await claimMysteryDrop(
            eventId,
            userId
        );


    if (!claimed) {
        await interaction.editReply({
            content:
                "❄️ Someone was faster! This Mystery Drop has already been claimed.",
        });

        return;
    }


    /* -----------------------------------------
       START COOLDOWN ONLY AFTER WINNING
    ----------------------------------------- */

    if (!isStaff) {
        try {
            await startDropCooldown(userId);
        } catch (error) {
            console.error(
                "❌ Failed to start Mystery Drop cooldown:",
                error.message
            );
        }
    }


    /* -----------------------------------------
       MARK WINNER
    ----------------------------------------- */

    drop.status =
        "completed";

    drop.winnerId =
        userId;

    drop.claimedAt =
        Date.now();


    await saveDrop(drop);


    /* -----------------------------------------
       ACKNOWLEDGE WINNER IMMEDIATELY
    ----------------------------------------- */

    await interaction.editReply({
        content:
            `🎉 You won **${drop.amount} ${MORA_EMOJI}** from the Mystery Drop!`,
    });


    /* -----------------------------------------
       PUBLIC WINNER ANNOUNCEMENT
    ----------------------------------------- */

    try {

        await interaction.followUp({
            content:
                `🎉 <@${userId}> **Congratulations on winning ${drop.amount} ${MORA_EMOJI} from the Mystery Drop!**`,
            allowedMentions: {
                users: [userId],
            },
        });

    } catch (error) {

        console.error(
            "⚠️ Mystery Drop winner announcement failed:",
            error.message
        );
    }


    /* -----------------------------------------
       PARTICIPATION STATS
       RUN AFTER WINNER ACKNOWLEDGEMENT
    ----------------------------------------- */

    try {

        await recordParticipation(
            "drop",
            userId
        );

    } catch (error) {

        console.error(
            "❌ Mystery Drop participation stats failed:",
            error.message
        );
    }


    /* -----------------------------------------
       PAYMENT STAFF + MORA
       RUN AFTER WINNER ACKNOWLEDGEMENT
    ----------------------------------------- */

    try {

        const winnerUser =
            await interaction.client.users.fetch(
                userId
            );

        await createPaymentTransaction({
            client:
                interaction.client,

            winnerId:
                userId,

            displayName:
                winnerUser.globalName ||
                winnerUser.username,

            username:
                winnerUser.username,

            eventName:
                "Mystery Drop",

            eventType:
                "Mystery Drop",

            reward:
                drop.amount,

            sourceChannelId:
                interaction.channelId,

            sourceMessageId:
                interaction.message?.id ||
                drop.messageId ||
                null,
        });

        await recordMora(
            "drop",
            userId,
            drop.amount
        );

    } catch (error) {

        console.error(
            "❌ Mystery Drop payment transaction failed:",
            error.message
        );
    }


    /* -----------------------------------------
       UPDATE ORIGINAL DROP MESSAGE
    ----------------------------------------- */

    try {

        if (
            interaction.webhook &&
            drop.messageId
        ) {

            await interaction.webhook.editMessage(
                drop.messageId,
                {
                    embeds: [
                        buildDropEmbed(drop),
                    ],

                    components: [],
                }
            );
        }

    } catch (error) {

        console.error(
            "⚠️ Could not update Mystery Drop message:",
            error.message
        );
    }


    /* -----------------------------------------
       REMOVE DROP DATA
    ----------------------------------------- */

    await deleteDrop(eventId);
}


/* =========================================================
   EXPORTS
========================================================= */

module.exports = {
    dropCommand,
    handleDropCommand,
    handleDropButton,
};
