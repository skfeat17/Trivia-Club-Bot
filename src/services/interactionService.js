const {
    MessageFlags,
} = require("discord.js");

const {
    getActiveTrivia,
    saveAttempt,
    consumeAttempt,
} = require("./triviaRedis");

const {
    getCooldown,
    startCooldown,
} = require("./cooldownService");

const {
    recordParticipation,
    recordMora,
} = require("./statsService");

const {
    getQuestion,
} = require("./questionManager");

const {
    generateReward,
} = require("../utils/random");

const {
    formatCooldown,
} = require("../utils/time");

const {
    questionEmbed,
    resultEmbed,
    answerRow,
} = require("./triviaEmbeds");

const {
    createPaymentTransaction,
} = require("./paymentService");


/*
|--------------------------------------------------------------------------
| STAFF / COOLDOWN IMMUNITY
|--------------------------------------------------------------------------
*/

function getStaffUserIds() {
    return (
        process.env.STAFF_USER_IDS || ""
    )
        .split(",")
        .map(id => id.trim())
        .filter(Boolean);
}


function isCooldownImmune(userId) {
    return getStaffUserIds().includes(
        userId
    );
}


/*
|--------------------------------------------------------------------------
| REQUEST TRIVIA QUESTION
|--------------------------------------------------------------------------
|
| Users can request unlimited questions.
|
| Requesting a question:
| - Does NOT start cooldown
| - Does NOT count as participation
| - Replaces the previous unanswered question
|
|--------------------------------------------------------------------------
*/

async function handleTriviaStartButton(
    interaction
) {
    await interaction.deferReply({
        flags: MessageFlags.Ephemeral,
    });

    try {
        const active =
            await getActiveTrivia();

        if (!active) {
            return interaction.editReply({
                content:
                    "🔮 Permanent Trivia is currently offline.",
            });
        }


        /*
        |--------------------------------------------------------------------------
        | CHECK COOLDOWN
        |--------------------------------------------------------------------------
        */

        const cooldownImmune =
            isCooldownImmune(
                interaction.user.id
            );

        if (!cooldownImmune) {
            const remaining =
                await getCooldown(
                    "trivia",
                    interaction.user.id
                );

            if (remaining > 0) {
                return interaction.editReply({
                    content:
                        `⏳ You are on cooldown. You can answer trivia again in **${formatCooldown(remaining)}**.`,
                });
            }
        }


        /*
        |--------------------------------------------------------------------------
        | GET QUESTION
        |--------------------------------------------------------------------------
        */

        let question;

        try {
            question =
                await getQuestion();
        } catch (error) {
            console.error(
                `❌ TRIVIA QUESTION FAILED | ${error.message}`
            );

            return interaction.editReply({
                content:
                    "⚠️ I couldn't get a trivia question right now. Please try again in a moment.",
            });
        }


        /*
        |--------------------------------------------------------------------------
        | SAVE CURRENT ATTEMPT
        |--------------------------------------------------------------------------
        |
        | Requesting a question does not start cooldown.
        | Only the latest question can be answered.
        |
        |--------------------------------------------------------------------------
        */

        await saveAttempt(
            interaction.user.id,
            question
        );

        console.log(
            `🎲 TRIVIA QUESTION SENT | User: ${interaction.user.id} | Game: ${question.game} | Question: ${question.id}`
        );

        return interaction.editReply({
            embeds: [
                questionEmbed(question),
            ],
            components: [
                answerRow(question),
            ],
        });

    } catch (error) {
        console.error(
            "❌ TRIVIA START BUTTON ERROR:",
            error
        );

        return interaction.editReply({
            content:
                "❌ Something went wrong while getting your trivia question. Please try again.",
            embeds: [],
            components: [],
        });
    }
}


/*
|--------------------------------------------------------------------------
| ANSWER TRIVIA
|--------------------------------------------------------------------------
|
| CORRECT ANSWER:
| - Starts the 24-hour cooldown for regular users
| - Generates a Mora reward
| - Records the reward statistics
| - Creates a payment transaction
|
| INCORRECT ANSWER:
| - Does NOT start cooldown
| - Does NOT generate a reward
| - Restores the same question
| - Allows the user to try again
|
|--------------------------------------------------------------------------
*/

async function handleTriviaAnswer(
    interaction
) {
    const parts =
        interaction.customId.split(":");

    if (parts.length !== 4) {
        return;
    }

    const questionId =
        parts[2];

    const selectedIndex =
        Number(parts[3]);


    /*
    |--------------------------------------------------------------------------
    | VALIDATE ANSWER
    |--------------------------------------------------------------------------
    */

    if (
        !Number.isInteger(selectedIndex) ||
        selectedIndex < 0 ||
        selectedIndex > 3
    ) {
        return interaction.reply({
            content:
                "❌ Invalid answer.",
            flags:
                MessageFlags.Ephemeral,
        });
    }


    /*
    |--------------------------------------------------------------------------
    | CONSUME CURRENT QUESTION
    |--------------------------------------------------------------------------
    |
    | The attempt is consumed atomically to prevent
    | multiple simultaneous answers and duplicate rewards.
    |
    |--------------------------------------------------------------------------
    */

    let attempt;

    try {
        attempt =
            await consumeAttempt(
                interaction.user.id
            );
    } catch (error) {
        console.error(
            `❌ TRIVIA ATTEMPT CONSUMPTION FAILED | ${error.message}`
        );

        return interaction.reply({
            content:
                "⚠️ Something went wrong checking your answer. Please try again.",
            flags:
                MessageFlags.Ephemeral,
        });
    }


    if (!attempt) {
        return interaction.reply({
            content:
                "⚠️ This trivia question is no longer active. Request a new question.",
            flags:
                MessageFlags.Ephemeral,
        });
    }


    /*
    |--------------------------------------------------------------------------
    | VERIFY QUESTION ID
    |--------------------------------------------------------------------------
    */

    if (
        attempt.questionId !== questionId
    ) {
        // Restore the current attempt because this click
        // belongs to an older question.
        await saveAttempt(
            interaction.user.id,
            attempt.question
        );

        return interaction.reply({
            content:
                "⚠️ This question has expired because you requested a newer trivia question.",
            flags:
                MessageFlags.Ephemeral,
        });
    }


    const question =
        attempt.question;

    const correct =
        selectedIndex === question.correctAnswer;


    /*
    |--------------------------------------------------------------------------
    | RECORD PARTICIPATION
    |--------------------------------------------------------------------------
    */

    try {
        await recordParticipation(
            interaction.user.id,
            correct
                ? "correct"
                : "incorrect"
        );
    } catch (error) {
        console.error(
            `❌ TRIVIA PARTICIPATION RECORD FAILED | ${error.message}`
        );
    }


    /*
    |--------------------------------------------------------------------------
    | INCORRECT ANSWER
    |--------------------------------------------------------------------------
    |
    | IMPORTANT:
    | No cooldown is started.
    | No Mora reward is generated.
    | The same question is restored so the user can retry.
    |
    |--------------------------------------------------------------------------
    */

    if (!correct) {
        try {
            await saveAttempt(
                interaction.user.id,
                question
            );
        } catch (error) {
            console.error(
                `❌ FAILED TO RESTORE TRIVIA ATTEMPT | ${error.message}`
            );

            return interaction.reply({
                content:
                    "⚠️ I couldn't restore your question. Please request a new one.",
                flags:
                    MessageFlags.Ephemeral,
            });
        }


        await interaction.update({
            content:
                "❌ Incorrect answer! Try again!",

            embeds: [
                resultEmbed(
                    question,
                    {
                        correct: false,
                    }
                ),
            ],

            components: [
                answerRow(question),
            ],
        });


        console.log(
            `❌ TRIVIA INCORRECT | User: ${interaction.user.id} | Cooldown: NOT STARTED`
        );

        return;
    }


    /*
    |--------------------------------------------------------------------------
    | CORRECT ANSWER
    |--------------------------------------------------------------------------
    */

    const cooldownImmune =
        isCooldownImmune(
            interaction.user.id
        );


    /*
    |--------------------------------------------------------------------------
    | START 24-HOUR COOLDOWN
    |--------------------------------------------------------------------------
    |
    | Only a correct answer starts the cooldown.
    | Staff members remain cooldown-immune.
    |
    |--------------------------------------------------------------------------
    */

    if (!cooldownImmune) {
        try {
            await startCooldown(
                "trivia",
                interaction.user.id
            );
        } catch (error) {
            console.error(
                `❌ TRIVIA COOLDOWN SAVE FAILED | ${error.message}`
            );
        }
    }


    /*
    |--------------------------------------------------------------------------
    | GENERATE REWARD
    |--------------------------------------------------------------------------
    */

    const reward =
        generateReward();


    /*
    |--------------------------------------------------------------------------
    | RECORD MORA STATISTICS
    |--------------------------------------------------------------------------
    */

    try {
        await recordMora(
            interaction.user.id,
            reward
        );
    } catch (error) {
        console.error(
            `❌ TRIVIA MORA STATS FAILED | ${error.message}`
        );
    }


    /*
    |--------------------------------------------------------------------------
    | UPDATE TRIVIA MESSAGE
    |--------------------------------------------------------------------------
    */

    await interaction.update({
        content: "",

        embeds: [
            resultEmbed(
                question,
                {
                    correct: true,
                    reward,
                }
            ),
        ],

        components: [],
    });


    /*
    |--------------------------------------------------------------------------
    | CREATE PAYMENT REQUEST
    |--------------------------------------------------------------------------
    */

    try {
        await createPaymentTransaction({
            client:
                interaction.client,

            winnerId:
                interaction.user.id,

            username:
                interaction.user.username,

            game:
                question.game,

            reward,

            question:
                question.question,
        });

    } catch (error) {
        console.error(
            `❌ TRIVIA PAYMENT CREATION FAILED | ${error.message}`
        );
    }


    /*
    |--------------------------------------------------------------------------
    | LOG RESULT
    |--------------------------------------------------------------------------
    */

    console.log(
        `🏆 TRIVIA CORRECT | User: ${interaction.user.id} | Reward: ${reward} Mora | Cooldown Immune: ${cooldownImmune}`
    );
}


/*
|--------------------------------------------------------------------------
| EXPORTS
|--------------------------------------------------------------------------
*/

module.exports = {
    handleTriviaStartButton,
    handleTriviaAnswer,
};