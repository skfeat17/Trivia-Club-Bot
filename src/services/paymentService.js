const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
} = require("discord.js");

const {
    savePaymentTransaction,
    getPaymentTransaction,
    updatePaymentTransaction,
} = require("./paymentRedis");

const {
    PAYMENT_STAFF,
    hasPaymentAccess,
} = require("./COMMAND_ACCESS");

const MORA_EMOJI = "<:mora:1503931162525962333>";
const PAYMENT_CHANNEL_URL = process.env.PAYMENT_CHANNEL_URL;

function createTransactionId() {
    return (
        `TX-${Date.now().toString(36).toUpperCase()}-` +
        Math.random().toString(36).slice(2, 8).toUpperCase()
    );
}

function buildPaymentEmbed(transaction) {
    const isPaid = transaction.status === "paid";

    const embed = new EmbedBuilder()
        .setColor(isPaid ? 0x57F287 : 0xED4245)
        .setTitle(
            isPaid
                ? "💰 TRANSACTION COMPLETED"
                : "💰 PENDING TRANSACTION"
        )
        .addFields(
            {
                name: "Winner",
                value: `<@${transaction.winnerId}>`,
                inline: true,
            },
            {
                name: "Username",
                value: transaction.username || "Unknown",
                inline: true,
            },
            {
                name: "Game",
                value: transaction.game || "Unknown",
                inline: true,
            },
            {
                name: "Reward",
                value: `**${transaction.reward} Mora**`,
                inline: true,
            },
            {
                name: "Payment Status",
                value: isPaid ? "✅ Paid" : "❌ Unpaid",
                inline: true,
            }
        )
        .setFooter({
            text: `Pierro • ${transaction.transactionId}`,
        })
        .setTimestamp(transaction.createdAt || Date.now());

    if (transaction.paidBy) {
        embed.addFields({
            name: "Paid By",
            value: `<@${transaction.paidBy}>`,
            inline: true,
        });
    }

    return embed;
}

function buildPaymentButtons(transaction) {
    const row = new ActionRowBuilder();

    if (PAYMENT_CHANNEL_URL) {
        row.addComponents(
            new ButtonBuilder()
                .setLabel("Pay User")
                .setEmoji("💸")
                .setStyle(ButtonStyle.Link)
                .setURL(PAYMENT_CHANNEL_URL)
        );
    }

    row.addComponents(
        new ButtonBuilder()
            .setCustomId(
                `pierro:payment:paid:${transaction.transactionId}`
            )
            .setLabel("Mark Paid")
            .setEmoji("✅")
            .setStyle(ButtonStyle.Success)
            .setDisabled(transaction.status === "paid")
    );

    return [row];
}

async function createPaymentTransaction({
    client,
    winnerId,
    username,
    game,
    reward,
    question,
}) {
    if (!client) {
        throw new Error(
            "Payment service requires the Discord client."
        );
    }

    if (!PAYMENT_STAFF.length) {
        console.warn(
            "⚠️ PAYMENT_STAFF_USER_IDS is empty. " +
            "Payment transaction will be stored but no DM will be sent."
        );
    }

    const transaction = {
        transactionId: createTransactionId(),
        winnerId,
        username: username || "Unknown",
        game: game || "Unknown",
        reward: Number(reward) || 0,
        question: question || "Unknown question",
        status: "unpaid",
        paidBy: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        staffMessages: [],
    };

    await savePaymentTransaction(transaction);

    // Send staff DMs concurrently rather than one at a time.
    const dmResults = await Promise.allSettled(
        PAYMENT_STAFF.map(async (staffId) => {
            const staff = await client.users.fetch(staffId);

            const message = await staff.send({
                embeds: [buildPaymentEmbed(transaction)],
                components: buildPaymentButtons(transaction),
            });

            return {
                staffId,
                channelId: message.channelId,
                messageId: message.id,
            };
        })
    );

    for (let index = 0; index < dmResults.length; index++) {
        const result = dmResults[index];
        const staffId = PAYMENT_STAFF[index];

        if (result.status === "fulfilled") {
            transaction.staffMessages.push(result.value);
        } else {
            console.error(
                `❌ PAYMENT DM FAILED | Staff: ${staffId} | ` +
                `${result.reason?.message || result.reason}`
            );
        }
    }

    await savePaymentTransaction(transaction);

    console.log(
        `💳 PAYMENT CREATED | ${transaction.transactionId} | ` +
        `Winner: ${winnerId} | Reward: ${transaction.reward} Mora`
    );

    return transaction;
}

/**
 * Edits the clicked message first, then updates other staff copies
 * concurrently. The clicked message is not fetched again.
 */
async function updateAllPaymentMessages(
    client,
    transaction,
    clickedInteraction = null
) {
    const embed = buildPaymentEmbed(transaction);
    const components = buildPaymentButtons(transaction);

    const clickedMessageId =
        clickedInteraction?.message?.id || null;

    // Update the exact message the staff member clicked first.
    if (clickedInteraction?.message) {
        try {
            await clickedInteraction.message.edit({
                embeds: [embed],
                components,
            });
        } catch (error) {
            console.error(
                `❌ CLICKED PAYMENT MESSAGE UPDATE FAILED | ` +
                `${transaction.transactionId} | ${error.message}`
            );
        }
    }

    const otherMessages = (
        transaction.staffMessages || []
    ).filter(
        (staffMessage) =>
            staffMessage.messageId !== clickedMessageId
    );

    // Update all other staff messages concurrently.
    const results = await Promise.allSettled(
        otherMessages.map(async (staffMessage) => {
            const channel = await client.channels.fetch(
                staffMessage.channelId
            );

            if (!channel || !channel.isTextBased()) {
                throw new Error(
                    "Payment message channel is unavailable or not text-based."
                );
            }

            const message = await channel.messages.fetch(
                staffMessage.messageId
            );

            await message.edit({
                embeds: [embed],
                components,
            });
        })
    );

    results.forEach((result, index) => {
        if (result.status === "rejected") {
            const staffMessage = otherMessages[index];

            console.error(
                `❌ PAYMENT MESSAGE UPDATE FAILED | ` +
                `Staff: ${staffMessage.staffId} | ` +
                `Transaction: ${transaction.transactionId} | ` +
                `${result.reason?.message || result.reason}`
            );
        }
    });
}

async function handlePaymentButton(interaction) {
    const prefix = "pierro:payment:paid:";

    if (!interaction.customId.startsWith(prefix)) {
        return false;
    }

    if (!hasPaymentAccess(interaction.user.id)) {
        await interaction.reply({
            content:
                "❌ You are not authorized to manage Pierro payments.",
            flags: MessageFlags.Ephemeral,
        });

        return true;
    }

    // Acknowledge the interaction immediately.
    await interaction.deferUpdate();

    const transactionId = interaction.customId.slice(
        prefix.length
    );

    try {
        const transaction = await getPaymentTransaction(
            transactionId
        );

        if (!transaction) {
            console.warn(
                `⚠️ PAYMENT NOT FOUND | ${transactionId}`
            );

            await interaction.followUp({
                content:
                    "⚠️ This payment transaction could not be found.",
                flags: MessageFlags.Ephemeral,
            });

            return true;
        }

        if (transaction.status === "paid") {
            // Keep the clicked message consistent if its button is stale.
            await interaction.message.edit({
                embeds: [
                    buildPaymentEmbed(transaction),
                ],
                components:
                    buildPaymentButtons(transaction),
            }).catch(() => {});

            return true;
        }

        const updated = await updatePaymentTransaction(
            transactionId,
            {
                status: "paid",
                paidBy: interaction.user.id,
                paidAt: Date.now(),
                updatedAt: Date.now(),
            }
        );

        if (!updated) {
            await interaction.followUp({
                content:
                    "⚠️ The transaction could not be updated. Please try again.",
                flags: MessageFlags.Ephemeral,
            });

            return true;
        }

        // Update the clicked DM first; other staff DMs update concurrently.
        await updateAllPaymentMessages(
            interaction.client,
            updated,
            interaction
        );

        console.log(
            `✅ PAYMENT MARKED PAID | ${transactionId} | ` +
            `Paid By: ${interaction.user.id}`
        );
    } catch (error) {
        console.error(
            `❌ PAYMENT BUTTON ERROR | ${transactionId} |`,
            error
        );

        try {
            await interaction.followUp({
                content:
                    "❌ Something went wrong while updating this payment.",
                flags: MessageFlags.Ephemeral,
            });
        } catch (followUpError) {
            console.error(
                `❌ PAYMENT ERROR FOLLOW-UP FAILED | ${transactionId} | ` +
                `${followUpError.message}`
            );
        }
    }

    return true;
}

module.exports = {
    PAYMENT_STAFF,
    createPaymentTransaction,
    handlePaymentButton,
    buildPaymentEmbed,
    buildPaymentButtons,
};