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
} = require("./dropRedis");

const {
    hasCommandAccess,
} = require("../COMMAND_ACCESS");

const MORA_EMOJI =
    process.env.MORA_EMOJI || "🪙";


/* =========================================================
   CHEST IMAGE CONFIG
========================================================= */

const DROP_CHEST_IMAGES = {
    luxurious:"https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcTFycdeqFtD1w-9ZNkA0Rvs71t2zZ6-1eCVd1-oUmR73Q&s",

    precious:"https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcTNgNV8sgrB-e00XjjhT2ijzd0GgTKOKDXuEz1xJ2UFFjBvOvMQkeHBLPA&s=10",

    exquisite:"https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcRj0lWao2e4njusJTAIq30VLtUXysO0heOdZ3Gns-xvzV43yOOM8fSzwF0&s=10",

    common:"https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcQaOplmKt-MQrc3R9N--n9eRfJB-8Q4km4oDhFPd6y1H4nIphwrBRFiCbMz&s=10",
};


/* =========================================================
   MYSTERY DROP EMBED
========================================================= */

function buildDropEmbed(drop) {
    const completed =
        drop.status === "completed";

    const chestNames = {
        luxurious: "💎 Luxurious Chest",
        precious: "💎 Precious Chest",
        exquisite: "💎 Exquisite Chest",
        common: "📦 Common Chest",
    };

    const embed =
        new EmbedBuilder()
            .setTitle(
                completed
                    ? "❄️━━━━━━━━━━━━━━━━━━❄️\n        🏆 𝗠𝗬𝗦𝗧𝗘𝗥𝗬 𝗗𝗥𝗢𝗣\n❄️━━━━━━━━━━━━━━━━━━❄️"
                    : "❄️━━━━━━━━━━━━━━━━━━❄️\n        ✨ 𝗠𝗬𝗦𝗧𝗘𝗥𝗬 𝗗𝗥𝗢𝗣\n❄️━━━━━━━━━━━━━━━━━━❄️"
            )
            .setDescription(
                "A forgotten treasure has surfaced...\n\n" +
                `🗝️ **Chest:** ${chestNames[drop.chest] || drop.chest}\n\n` +
                `🎁 **Reward:** ${
                    completed
                        ? `**${drop.amount} ${MORA_EMOJI}**`
                        : "???"
                }\n\n` +
                (
                    completed
                        ? `🏆 **Claimed by:** <@${drop.winnerId}>\n\nThe mystery has been solved!`
                        : "🏃 Be the first to claim it!\n\n" +
                          '*"Only the swift shall know what fortune awaits."*'
                )
            );

    if (drop.imageUrl) {
        embed.setImage(drop.imageUrl);
    }

    return embed;
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
        )
        .addStringOption(option =>
            option
                .setName("chest")
                .setDescription(
                    "Choose the Mystery Drop chest."
                )
                .setRequired(true)
                .addChoices(
                    {
                        name: "💎 Luxurious",
                        value: "luxurious",
                    },
                    {
                        name: "💎 Precious",
                        value: "precious",
                    },
                    {
                        name: "💎 Exquisite",
                        value: "exquisite",
                    },
                    {
                        name: "📦 Common",
                        value: "common",
                    }
                )
        );


/* =========================================================
   HANDLE /DROP
========================================================= */

async function handleDropCommand(interaction) {

    /* -----------------------------------------
       USER-LEVEL PERMISSION
    ----------------------------------------- */

    if (
        !hasCommandAccess(
            "drop",
            interaction.user.id
        )
    ) {
        await interaction.reply({
            content:
                "❌ You do not have permission to use this command.",
            flags: MessageFlags.Ephemeral,
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

    const chest =
        interaction.options.getString(
            "chest",
            true
        );


    /* -----------------------------------------
       VALIDATE AMOUNT
    ----------------------------------------- */

    if (
        !Number.isInteger(amount) ||
        amount <= 0
    ) {
        await interaction.reply({
            content:
                "❌ The drop amount must be a positive whole number.",
            flags: MessageFlags.Ephemeral,
        });

        return;
    }


    /* -----------------------------------------
       GET CHEST IMAGE
    ----------------------------------------- */

    const imageUrl =
        DROP_CHEST_IMAGES[chest];

    if (!imageUrl) {
        await interaction.reply({
            content:
                `❌ No image has been configured for the **${chest}** chest.`,
            flags: MessageFlags.Ephemeral,
        });

        return;
    }


    /* -----------------------------------------
       ACKNOWLEDGE INTERACTION IMMEDIATELY
       KEEP THIS PRIVATE
    ----------------------------------------- */

    await interaction.deferReply({
        flags: MessageFlags.Ephemeral,
    });


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
        chest,
        imageUrl,
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
                `✅ ${chest === "luxurious" ? "💎" : chest === "precious" ? "💎" : chest === "exquisite" ? "💎" : "📦"} Mystery Drop created for **${amount} ${MORA_EMOJI}** using the **${chest} chest**.`,
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
       EXTRACT EVENT ID
    ----------------------------------------- */

    const eventId =
        interaction.customId.replace(
            "pierro:drop:claim:",
            ""
        );


    /* -----------------------------------------
       DEFER BUTTON RESPONSE
    ----------------------------------------- */

    await interaction.deferReply({
        flags: MessageFlags.Ephemeral,
    });


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
       PARTICIPATION STATS
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
       PRIVATE WINNER CONFIRMATION
    ----------------------------------------- */

    await interaction.editReply({
        content:
            `🎉 You won **${drop.amount} ${MORA_EMOJI}** from the Mystery Drop!`,
    });


    /* -----------------------------------------
       PUBLIC WINNER ANNOUNCEMENT
    ----------------------------------------- */

    await interaction.followUp({
        content:
            `🎉 <@${userId}> **Congratulations on winning ${drop.amount} ${MORA_EMOJI} from the Mystery Drop!**`,
        allowedMentions: {
            users: [userId],
        },
    });


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
