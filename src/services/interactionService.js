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
    /*
    |--------------------------------------------------------------------------
    | ACKNOWLEDGE IMMEDIATELY
    |--------------------------------------------------------------------------
    |
    | Gemini generation can take several seconds.
    | Defer before doing Redis/Gemini work.
    |
    |--------------------------------------------------------------------------
    */

    await interaction.deferReply({
        flags: MessageFlags.Ephemeral,
    });

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
    |
    | STAFF_USER_IDS are immune to cooldown.
    |
    |--------------------------------------------------------------------------
    */

    const cooldownImmune =
        isCooldownImmune(
            interaction.user.id
        );

    if (!cooldownImmune) {
        const remaining =
            await getCooldown(
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
    |
    | There is intentionally NO active-attempt restriction.
    |
    | Users can request as many questions as they want.
    |
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
    | REPLACE PREVIOUS QUESTION
    |--------------------------------------------------------------------------
    |
    | Only this latest question can be answered.
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
            questionEmbed(
                question
            ),
        ],
        components: [
            answerRow(
                question
            ),
        ],
    });
}


/*
|--------------------------------------------------------------------------
| ANSWER TRIVIA
|--------------------------------------------------------------------------
|
| A user can answer exactly ONE question.
|
| consumeAttempt() removes the attempt atomically, preventing:
| - double clicks
| - multiple simultaneous answers
| - multiple rewards
|
|--------------------------------------------------------------------------
*/

async function handleTriviaAnswer(
    interaction
) {
    const parts =
        interaction.customId.split(":");

    if (
        parts.length !== 4
    ) {
        return;
    }

    const questionId =
        parts[2];

    const selectedIndex =
        Number(parts[3]);


    if (
        !Number.isInteger(
            selectedIndex
        ) ||
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
    | Only ONE request can successfully consume it.
    |
    |--------------------------------------------------------------------------
    */

    const attempt =
        await consumeAttempt(
            interaction.user.id
        );


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
    | MAKE SURE THIS IS THE LATEST QUESTION
    |--------------------------------------------------------------------------
    */

    if (
        attempt.questionId !==
        questionId
    ) {
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
        selectedIndex ===
        question.correctAnswer;


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
    | START 24H COOLDOWN
    |--------------------------------------------------------------------------
    |
    | STAFF_USER_IDS DO NOT RECEIVE COOLDOWN.
    |
    |--------------------------------------------------------------------------
    */

    const cooldownImmune =
        isCooldownImmune(
            interaction.user.id
        );

    if (!cooldownImmune) {
        try {
            await startCooldown(
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
    | CORRECT ANSWER
    |--------------------------------------------------------------------------
    */

    if (correct) {
        const reward =
            generateReward(
                20,
                50
            );


        /*
        | Record Mora statistics
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
        | Update user's trivia message
        */

        await interaction.update({
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


        console.log(
            `🏆 TRIVIA CORRECT | User: ${interaction.user.id} | Reward: ${reward} Mora | Cooldown Immune: ${cooldownImmune}`
        );

        return;
    }


    /*
    |--------------------------------------------------------------------------
    | INCORRECT ANSWER
    |--------------------------------------------------------------------------
    */

    await interaction.update({
        embeds: [
            resultEmbed(
                question,
                {
                    correct: false,
                }
            ),
        ],
        components: [],
    });


    console.log(
        `❌ TRIVIA INCORRECT | User: ${interaction.user.id} | Cooldown Immune: ${cooldownImmune}`
    );
}


module.exports = {
    handleTriviaStartButton,
    handleTriviaAnswer,
};