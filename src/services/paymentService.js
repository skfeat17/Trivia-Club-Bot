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

const MORA_EMOJI =
    "<:mora:1503931162525962333>";

const PAYMENT_CHANNEL_URL =
    process.env.PAYMENT_CHANNEL_URL;

function createTransactionId() {
    return (
        `TX-${Date.now().toString(36).toUpperCase()}-` +
        Math.random()
            .toString(36)
            .slice(2, 8)
            .toUpperCase()
    );
}

function buildPaymentEmbed(transaction) {
    const status =
        transaction.status === "paid"
            ? "✅ Paid"
            : "❌ Unpaid";

    const embed =
        new EmbedBuilder()
            .setColor(
                transaction.status === "paid"
                    ? 0x57F287
                    : 0xED4245
            )
            .setTitle(
                transaction.status === "paid"
                    ? "💰 TRANSACTION COMPLETED"
                    : "💰 PENDING TRANSACTION"
            )
            .addFields(
                {
                    name: "Winner",
                    value:
                        `<@${transaction.winnerId}>`,
                    inline: true,
                },
                {
                    name: "Username",
                    value:
                        transaction.username,
                    inline: true,
                },
                {
                    name: "Game",
                    value:
                        transaction.game,
                    inline: true,
                },
                {
                    name: "Reward",
                    value:
                        `**${transaction.reward} Mora**`,
                    inline: true,
                },
                {
                    name: "Payment Status",
                    value: status,
                    inline: true,
                }
            )
            .setFooter({
                text:
                    `Pierro • ${transaction.transactionId}`,
            })
            .setTimestamp(
                transaction.createdAt
            );

    if (transaction.paidBy) {
        embed.addFields({
            name: "Paid By",
            value:
                `<@${transaction.paidBy}>`,
            inline: true,
        });
    }

    return embed;
}

function buildPaymentButtons(transaction) {
    const row =
        new ActionRowBuilder();

    if (PAYMENT_CHANNEL_URL) {
        row.addComponents(
            new ButtonBuilder()
                .setLabel("Pay User")
                .setEmoji("💸")
                .setStyle(ButtonStyle.Link)
                .setURL(
                    PAYMENT_CHANNEL_URL
                )
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
            .setDisabled(
                transaction.status === "paid"
            )
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
            "⚠️ PAYMENT_STAFF_USER_IDS is empty. Payment transaction will be stored but no DM will be sent."
        );
    }

    const transaction = {
        transactionId:
            createTransactionId(),
        winnerId,
        username:
            username || "Unknown",
        game:
            game || "Unknown",
        reward:
            Number(reward) || 0,
        question:
            question || "Unknown question",
        status:
            "unpaid",
        paidBy:
            null,
        createdAt:
            Date.now(),
        updatedAt:
            Date.now(),
        staffMessages: [],
    };

    await savePaymentTransaction(
        transaction
    );

    for (const staffId of PAYMENT_STAFF) {
        try {
            const staff =
                await client.users.fetch(
                    staffId
                );

            const message =
                await staff.send({
                    embeds: [
                        buildPaymentEmbed(
                            transaction
                        ),
                    ],
                    components:
                        buildPaymentButtons(
                            transaction
                        ),
                });

            transaction.staffMessages.push({
                staffId,
                channelId:
                    message.channelId,
                messageId:
                    message.id,
            });
        } catch (error) {
            console.error(
                `❌ PAYMENT DM FAILED | Staff: ${staffId} | ${error.message}`
            );
        }
    }

    await savePaymentTransaction(
        transaction
    );

    console.log(
        `💳 PAYMENT CREATED | ${transaction.transactionId} | Winner: ${winnerId} | Reward: ${reward} Mora`
    );

    return transaction;
}

async function updateAllPaymentMessages(
    client,
    transaction
) {
    for (
        const staffMessage
        of transaction.staffMessages || []
    ) {
        try {
            const channel =
                await client.channels.fetch(
                    staffMessage.channelId
                );

            const message =
                await channel.messages.fetch(
                    staffMessage.messageId
                );

            await message.edit({
                embeds: [
                    buildPaymentEmbed(
                        transaction
                    ),
                ],
                components:
                    buildPaymentButtons(
                        transaction
                    ),
            });
        } catch (error) {
            console.error(
                `❌ PAYMENT MESSAGE UPDATE FAILED | Staff: ${staffMessage.staffId} | ${error.message}`
            );
        }
    }
}

async function handlePaymentButton(
    interaction
) {
    const prefix =
        "pierro:payment:paid:";

    if (
        !interaction.customId.startsWith(
            prefix
        )
    ) {
        return false;
    }

    if (
        !hasPaymentAccess(
            interaction.user.id
        )
    ) {
        await interaction.reply({
            content:
                "❌ You are not authorized to manage Pierro payments.",
            flags:
                MessageFlags.Ephemeral,
        });

        return true;
    }

    await interaction.deferUpdate();

    const transactionId =
        interaction.customId.slice(
            prefix.length
        );

    const transaction =
        await getPaymentTransaction(
            transactionId
        );

    if (!transaction) {
        console.warn(
            `⚠️ PAYMENT NOT FOUND | ${transactionId}`
        );

        return true;
    }

    if (
        transaction.status === "paid"
    ) {
        return true;
    }

    const updated =
        await updatePaymentTransaction(
            transactionId,
            {
                status:
                    "paid",
                paidBy:
                    interaction.user.id,
                paidAt:
                    Date.now(),
            }
        );

    if (updated) {
        await updateAllPaymentMessages(
            interaction.client,
            updated
        );

        console.log(
            `✅ PAYMENT MARKED PAID | ${transactionId} | Paid By: ${interaction.user.id}`
        );
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
