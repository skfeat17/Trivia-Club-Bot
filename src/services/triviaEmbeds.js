const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} = require("discord.js");

function permanentTriviaEmbed() {
    return new EmbedBuilder()
        .setTitle(
            "🎭 Pierro — Permanent Trivia"
        )
        .setDescription(
            "Test your knowledge across **Genshin Impact**, **Honkai: Star Rail**, **Wuthering Waves**, **Zenless Zone Zero**, and **Pokémon**.\n\n" +
            "Click the button below to receive one trivia question.\n\n" +
            "⏳ **Cooldown:** 24 hours\n" +
            "💰 **Reward:** 20–50 Mora for a correct answer\n\n" +
            "❌ Incorrect answers receive no Mora."
        )
        .setFooter({
            text:
                "Permanent Trivia • One attempt every 24 hours.",
        });
}

function permanentTriviaRow() {
    return new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(
                    "pierro:trivia:start"
                )
                .setLabel(
                    "What's My Trivia Today?"
                )
                .setEmoji("🎲")
                .setStyle(
                    ButtonStyle.Primary
                )
        );
}

function questionEmbed(
    question
) {
    return new EmbedBuilder()
        .setTitle(
            `🎭 ${question.game} Trivia`
        )
        .setDescription(
            `### ${question.question}\n\n` +
            "Choose an answer below.\n" +
            "Your 24h cooldown starts when you answer."
        );
}

function resultEmbed(
    question,
    {
        correct,
        reward = 0,
    }
) {
    const embed =
        questionEmbed(
            question
        );

    if (correct) {
        embed
            .setColor(
                0x57F287
            )
            .setTitle(
                `🎭 ${question.game} Trivia — Correct!`
            )
            .setDescription(
                `${question.question}\n\n` +
                `✅ **Correct!** You earned **${reward} Mora**.`
            )
            .addFields({
                name:
                    "Explanation",
                value:
                    question.explanation,
            }).setFooter({
                text: "💳 Payment staff have been notified. Please wait for your payment!",
            });;
    } else {
        embed
            .setColor(
                0xED4245
            )
            .setTitle(
                `🎭 ${question.game} Trivia — Incorrect`
            )
            .setDescription(
                `${question.question}\n\n` +
                "❌ **Incorrect.** No Mora reward this time."
            )
            .addFields(
                {
                    name:
                        "Correct Answer",
                    value:
                        question.options[
                        question.correctAnswer
                        ],
                },
                {
                    name:
                        "Explanation",
                    value:
                        question.explanation,
                }
            );
    }

    return embed;
}

function answerRow(
    question
) {
    const buttons =
        question.options.map(
            (option, index) =>
                new ButtonBuilder()
                    .setCustomId(
                        `pierro:answer:${question.id}:${index}`
                    )
                    .setLabel(
                        option
                    )
                    .setStyle(
                        ButtonStyle.Secondary
                    )
        );

    return new ActionRowBuilder()
        .addComponents(
            buttons
        );
}

module.exports = {
    permanentTriviaEmbed,
    permanentTriviaRow,
    questionEmbed,
    resultEmbed,
    answerRow,
};
