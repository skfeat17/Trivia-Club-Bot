const {
    SlashCommandBuilder,
    MessageFlags,
    EmbedBuilder,
} = require("discord.js");

const {
    hasCommandAccess,
} = require("./COMMAND_ACCESS");

const {
    acquireStartLock,
    releaseStartLock,
    activateTrivia,
    killTrivia,
    getPanel,
} = require("./triviaRedis");

const {
    permanentTriviaEmbed,
    permanentTriviaRow,
} = require("./triviaEmbeds");

const {
    POOL_SIZE,
    getPoolSize,
    getTotalQuestionCount,
} = require("./questionManager");


// ============================================================
// COMMAND
// ============================================================

const triviaCommand =
    new SlashCommandBuilder()
        .setIntegrationTypes(1)
        .setContexts(0, 1, 2)
        .setName("trivia")
        .setDescription(
            "Manage Pierro's Permanent Trivia."
        )
        .addStringOption(option =>
            option
                .setName("event")
                .setDescription(
                    "The trivia event."
                )
                .setRequired(true)
                .addChoices({
                    name: "trivia",
                    value: "trivia",
                })
        )
        .addStringOption(option =>
            option
                .setName("action")
                .setDescription(
                    "Start or kill Permanent Trivia."
                )
                .setRequired(true)
                .addChoices(
                    {
                        name: "start",
                        value: "start",
                    },
                    {
                        name: "kill",
                        value: "kill",
                    }
                )
        );


// ============================================================
// COMMAND HANDLER
// ============================================================

async function handleTriviaCommand(
    interaction
) {

    /*
    |--------------------------------------------------------------------------
    | IMPORTANT
    |--------------------------------------------------------------------------
    |
    | Acknowledge the interaction immediately.
    |
    | Do NOT perform Redis/channel work before this.
    |
    |--------------------------------------------------------------------------
    */

    await interaction.deferReply();


    try {

        // --------------------------------------------------------
        // COMMAND ACCESS
        // --------------------------------------------------------

        if (
            !hasCommandAccess(
                "trivia",
                interaction.user.id
            )
        ) {

            await interaction.editReply({
                content:
                    "❌ You are not authorized to manage Pierro.",
                embeds: [],
                components: [],
            });

            return;
        }


        const action =
            interaction.options.getString(
                "action",
                true
            );


        // --------------------------------------------------------
        // START
        // --------------------------------------------------------

        if (
            action === "start"
        ) {

            await startTrivia(
                interaction
            );

            return;
        }


        // --------------------------------------------------------
        // KILL
        // --------------------------------------------------------

        if (
            action === "kill"
        ) {

            await killTriviaPanel(
                interaction
            );

            return;
        }


        await interaction.editReply({
            content:
                "❌ Invalid trivia action.",
            embeds: [],
            components: [],
        });

    } catch (error) {

        console.error(
            "❌ TRIVIA COMMAND ERROR:",
            error
        );


        /*
        |--------------------------------------------------------------------------
        | Interaction is already deferred.
        |--------------------------------------------------------------------------
        */

        try {

            await interaction.editReply({
                content:
                    "❌ Something went wrong while processing Permanent Trivia.",
                embeds: [],
                components: [],
            });

        } catch (editError) {

            console.error(
                "❌ FAILED TO EDIT TRIVIA ERROR:",
                editError
            );


            /*
            |--------------------------------------------------------------------------
            | LAST RESORT
            |--------------------------------------------------------------------------
            |
            | If the original response cannot be edited,
            | try a follow-up.
            |
            |--------------------------------------------------------------------------
            */

            try {

                await interaction.followUp({
                    content:
                        "❌ Something went wrong while processing Permanent Trivia.",
                    flags:
                        MessageFlags.Ephemeral,
                });

            } catch (followUpError) {

                console.error(
                    "❌ FAILED TO SEND TRIVIA FOLLOW-UP:",
                    followUpError
                );
            }
        }
    }
}


// ============================================================
// START TRIVIA
// ============================================================
//
// IMPORTANT:
//
// The slash-command interaction itself becomes the
// public Permanent Trivia message.
//
// We DO NOT use:
//
//     interaction.channel.send()
//
// This is important for user-installed applications where
// interaction.channel may be null or inaccessible.
//
// ============================================================

async function startTrivia(
    interaction
) {

    console.log(
        "\n========================================"
    );

    console.log(
        "🎭 STARTING PERMANENT TRIVIA"
    );


    let acquired = false;
    let activated = false;


    try {

        // --------------------------------------------------------
        // CHECK CURRENT PANEL
        // --------------------------------------------------------

        const existingPanel =
            await getPanel();


        if (existingPanel) {

            console.log(
                "⚠️ TRIVIA ALREADY ACTIVE"
            );


            /*
            |--------------------------------------------------------------------------
            | The interaction has already been deferred by
            | handleTriviaCommand().
            |--------------------------------------------------------------------------
            */

            await interaction.editReply({
                content:
                    "⚠️ Permanent Trivia is already active.",
                embeds: [],
                components: [],
            });

            return;
        }


        // --------------------------------------------------------
        // DISTRIBUTED START LOCK
        // --------------------------------------------------------

        acquired =
            await acquireStartLock();


        if (!acquired) {

            console.log(
                "⚠️ TRIVIA START LOCK ALREADY HELD"
            );


            await interaction.editReply({
                content:
                    "⚠️ Permanent Trivia is already being started.",
                embeds: [],
                components: [],
            });

            return;
        }


        // --------------------------------------------------------
        // DOUBLE CHECK AFTER LOCK
        // --------------------------------------------------------

        const activeAfterLock =
            await getPanel();


        if (activeAfterLock) {

            await interaction.editReply({
                content:
                    "⚠️ Permanent Trivia is already active.",
                embeds: [],
                components: [],
            });

            return;
        }


        // --------------------------------------------------------
        // QUESTION POOL
        // --------------------------------------------------------

        const poolSize =
            await getPoolSize();

        const totalQuestions =
            await getTotalQuestionCount();


        console.log(
            `📦 TRIVIA POOL: ${poolSize}/${POOL_SIZE}`
        );

        console.log(
            `📚 TOTAL QUESTIONS: ${totalQuestions}`
        );


        // --------------------------------------------------------
        // CREATE PUBLIC PANEL
        // --------------------------------------------------------
        //
        // This edits the original slash-command response.
        //
        // It does NOT require channel.send().
        //
        // --------------------------------------------------------

        const message =
            await interaction.editReply({

                content: "",

                embeds: [
                    permanentTriviaEmbed(),
                ],

                components: [
                    permanentTriviaRow(),
                ],
            });


        // --------------------------------------------------------
        // SAVE PANEL
        // --------------------------------------------------------
        //
        // channelId may be null for user-installed apps.
        // That is completely fine.
        //
        // messageId is still available from the interaction
        // response.
        //
        // --------------------------------------------------------

        await activateTrivia({

            channelId:
                interaction.channelId ??
                null,

            messageId:
                message?.id ??
                null,

            startedBy:
                interaction.user.id,

            startedAt:
                Date.now(),
        });


        activated = true;


        console.log(
            "✅ PERMANENT TRIVIA ACTIVE"
        );

        console.log(
            `📦 Question Pool: ${poolSize}/${POOL_SIZE}`
        );

        console.log(
            `📚 Total Questions: ${totalQuestions}`
        );

        console.log(
            `📢 Public Trivia panel created | Message: ${message?.id ?? "unknown"}`
        );


        // --------------------------------------------------------
        // OPTIONAL STAFF CONFIRMATION
        // --------------------------------------------------------
        //
        // The panel above is PUBLIC.
        //
        // This follow-up is PRIVATE to the person who summoned it.
        //
        // --------------------------------------------------------

        try {

            await interaction.followUp({
                content:
                    "✅ Permanent Trivia has been summoned successfully.",
                flags:
                    MessageFlags.Ephemeral,
            });

        } catch (followUpError) {

            console.error(
                "⚠️ TRIVIA CONFIRMATION FOLLOW-UP FAILED:",
                followUpError
            );
        }


        console.log(
            "========================================\n"
        );

    } catch (error) {

        console.error(
            "❌ TRIVIA START FAILED:",
            error
        );


        // --------------------------------------------------------
        // CLEAN ACTIVE STATE
        // --------------------------------------------------------

        if (activated) {

            try {

                await killTrivia();

            } catch (cleanupError) {

                console.error(
                    "❌ TRIVIA CLEANUP FAILED:",
                    cleanupError
                );
            }
        }


        // --------------------------------------------------------
        // ORIGINAL INTERACTION WAS ALREADY DEFERRED
        // --------------------------------------------------------

        try {

            await interaction.editReply({

                content:
                    "❌ Failed to start Permanent Trivia.",

                embeds: [],

                components: [],
            });

        } catch (editError) {

            console.error(
                "❌ FAILED TO EDIT TRIVIA ERROR:",
                editError
            );


            // ----------------------------------------------------
            // LAST RESORT FOLLOW-UP
            // ----------------------------------------------------

            try {

                await interaction.followUp({

                    content:
                        "❌ Failed to start Permanent Trivia.",

                    flags:
                        MessageFlags.Ephemeral,
                });

            } catch (followUpError) {

                console.error(
                    "❌ FAILED TO SEND TRIVIA ERROR FOLLOW-UP:",
                    followUpError
                );
            }
        }

    } finally {

        if (acquired) {

            try {

                await releaseStartLock();

            } catch (lockError) {

                console.error(
                    "❌ FAILED TO RELEASE TRIVIA START LOCK:",
                    lockError
                );
            }
        }
    }
}


// ============================================================
// KILL TRIVIA
// ============================================================
//
// We intentionally do NOT try:
//
//     interaction.client.channels.fetch()
//     channel.messages.fetch()
//     message.edit()
//
// because user-installed applications may not have normal
// channel access.
//
// The Redis state is what controls whether the panel works.
//
// ============================================================

async function killTriviaPanel(
    interaction
) {

    try {

        const panel =
            await getPanel();


        // --------------------------------------------------------
        // NOTHING ACTIVE
        // --------------------------------------------------------

        if (!panel) {

            await killTrivia();


            await interaction.editReply({
                content:
                    "ℹ️ Permanent Trivia is already offline.",
                embeds: [],
                components: [],
            });

            return;
        }


        // --------------------------------------------------------
        // DISABLE REDIS STATE
        // --------------------------------------------------------

        await killTrivia();


        console.log(
            `🛑 TRIVIA KILLED | By: ${interaction.user.id}`
        );

        console.log(
            "📦 QUESTION POOL PRESERVED"
        );

        console.log(
            "📚 QUESTION HISTORY PRESERVED"
        );


        // --------------------------------------------------------
        // CONFIRM
        // --------------------------------------------------------

        await interaction.editReply({

            content:
                "🛑 Permanent Trivia has been forcefully terminated.\n\n" +
                "📦 The question pool and question history were preserved.",

            embeds: [],

            components: [],
        });


        /*
        |--------------------------------------------------------------------------
        | Optional private confirmation.
        |--------------------------------------------------------------------------
        */

        try {

            await interaction.followUp({

                content:
                    "Permanent Trivia is now offline.",

                flags:
                    MessageFlags.Ephemeral,
            });

        } catch (followUpError) {

            console.error(
                "⚠️ TRIVIA KILL FOLLOW-UP FAILED:",
                followUpError
            );
        }

    } catch (error) {

        console.error(
            "❌ TRIVIA KILL FAILED:",
            error
        );


        try {

            await interaction.editReply({

                content:
                    "❌ Failed to terminate Permanent Trivia.",

                embeds: [],

                components: [],
            });

        } catch (editError) {

            console.error(
                "❌ FAILED TO EDIT TRIVIA KILL ERROR:",
                editError
            );


            try {

                await interaction.followUp({

                    content:
                        "❌ Failed to terminate Permanent Trivia.",

                    flags:
                        MessageFlags.Ephemeral,
                });

            } catch (followUpError) {

                console.error(
                    "❌ FAILED TO SEND TRIVIA KILL FOLLOW-UP:",
                    followUpError
                );
            }
        }
    }
}


// ============================================================
// OFFLINE EMBED
// ============================================================

function buildOfflineEmbed() {

    return new EmbedBuilder()

        .setTitle(
            "🎭 Pierro — Permanent Trivia"
        )

        .setDescription(
            "Permanent Trivia is currently offline."
        );
}


// ============================================================
// EXPORTS
// ============================================================

module.exports = {

    triviaCommand,

    isTriviaCommand:
        interaction =>
            interaction.commandName ===
            "trivia",

    handleTriviaCommand,

    startTrivia,

    killTriviaPanel,

    buildOfflineEmbed,
};