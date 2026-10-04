require("dotenv").config();

const http = require("http");

const {
    Client,
    Collection,
    Events,
    GatewayIntentBits,
    MessageFlags,
} = require("discord.js");

const {
    triviaCommand,
    handleTriviaCommand,
} = require("./services/trivia");

const {
    cooldownCommand,
    handleCooldownCommand,
} = require("./services/cooldown");
const {
    handleDropCommand,
    handleDropButton,
} = require("./services/drop/dropEvent");
const {
    statsCommand,
    handleStatsCommand,
} = require("./services/stats");

const {
    handleTriviaStartButton,
    handleTriviaAnswer,
} = require("./services/interactionService");

const {
    handlePaymentButton,
} = require("./services/paymentService");

const {
    startBackgroundRefill,
} = require("./services/questionManager");

const {
    log,
} = require("./utils/logger");
const {
    handleGiveawayCommand,
    handleGiveawayButton,
    restoreGiveaway,
} = require("./services/giveaway/giveaway");
const client =
    new Client({
        intents: [
            GatewayIntentBits.Guilds,
        ],
    });

client.commands =
    new Collection();

client.commands.set(
    "trivia",
    triviaCommand
);

client.commands.set(
    "cooldown",
    cooldownCommand
);

client.commands.set(
    "stats",
    statsCommand
);

/*
|--------------------------------------------------------------------------
| OPTIONAL HOSTING HTTP SERVER
|--------------------------------------------------------------------------
|
| Same simple keep-alive pattern used by WAC-QuizBot deployments.
|
|--------------------------------------------------------------------------
*/

const PORT =
    Number(
        process.env.PORT
    ) || 4000;

http.createServer(
    (req, res) => {
        res.writeHead(
            200,
            {
                "Content-Type":
                    "text/plain",
            }
        );

        res.end(
            "Pierro is running"
        );
    }
).listen(
    PORT,
    () => {
        log(
            `HTTP server running on port ${PORT}`
        );
    }
);

/*
|--------------------------------------------------------------------------
| READY
|--------------------------------------------------------------------------
*/

client.once(
    Events.ClientReady,
    async readyClient => {
        log(
            `Logged in as ${readyClient.user.tag}`
        );
        await restoreGiveaway(client);
        /*
        Start background generation without blocking Discord login.
        If Redis already contains questions, this returns immediately.
        */
        void startBackgroundRefill()
            .catch(error => {
                console.error(
                    `❌ INITIAL QUESTION REFILL FAILED | ${error.message}`
                );
            });
    }
);

/*
|--------------------------------------------------------------------------
| INTERACTION ROUTER
|--------------------------------------------------------------------------
*/

client.on(
    Events.InteractionCreate,
    async interaction => {
        try {
            /*
            |--------------------------------------------------------------------------
            | SLASH COMMANDS
            |--------------------------------------------------------------------------
            */

            if (
                interaction.isChatInputCommand()
            ) {

                if (interaction.commandName === "drop") {
                    await handleDropCommand(interaction);
                    return;
                }
                if (interaction.commandName === "giveaway") {
                    await handleGiveawayCommand(interaction);
                    return;
                }

                if (
                    interaction.commandName ===
                    "trivia"
                ) {
                    await handleTriviaCommand(
                        interaction
                    );

                    return;
                }

                if (
                    interaction.commandName ===
                    "cooldown"
                ) {
                    await handleCooldownCommand(
                        interaction
                    );

                    return;
                }

                if (
                    interaction.commandName ===
                    "stats"
                ) {
                    await handleStatsCommand(
                        interaction
                    );

                    return;
                }

                return;
            }

            /*
            |--------------------------------------------------------------------------
            | BUTTONS
            |--------------------------------------------------------------------------
            */

            if (
                !interaction.isButton()
            ) {
                return;
            }
            if (
                interaction.customId.startsWith(
                    "pierro:drop:claim:"
                )
            ) {
                await handleDropButton(interaction);
                return;
            }
            if (
                interaction.customId.startsWith(
                    "pierro:giveaway:participate:"
                )
            ) {
                await handleGiveawayButton(interaction);
                return;
            }

            if (
                interaction.customId.startsWith(
                    "pierro:payment:paid:"
                )
            ) {
                await handlePaymentButton(
                    interaction
                );

                return;
            }

            if (
                interaction.customId ===
                "pierro:trivia:start"
            ) {
                await handleTriviaStartButton(
                    interaction
                );

                return;
            }

            if (
                interaction.customId.startsWith(
                    "pierro:answer:"
                )
            ) {
                await handleTriviaAnswer(
                    interaction
                );
            }
        } catch (error) {
            console.error(
                "❌ PIERRO INTERACTION ERROR:",
                error
            );

            const payload = {
                content:
                    "⚠️ Something went wrong while processing this interaction.",
                flags:
                    MessageFlags.Ephemeral,
            };

            try {
                if (
                    interaction.deferred ||
                    interaction.replied
                ) {
                    await interaction.followUp(
                        payload
                    );
                } else {
                    await interaction.reply(
                        payload
                    );
                }
            } catch (_) {
                // Interaction may already have expired.
            }
        }
    }
);

/*
|--------------------------------------------------------------------------
| PROCESS ERROR HANDLERS
|--------------------------------------------------------------------------
*/

process.on(
    "unhandledRejection",
    reason => {
        console.error(
            "❌ UNHANDLED REJECTION:",
            reason
        );
    }
);

process.on(
    "uncaughtException",
    error => {
        console.error(
            "❌ UNCAUGHT EXCEPTION:",
            error
        );
    }
);

client.login(
    process.env.DISCORD_TOKEN
).catch(
    error => {
        console.error(
            `❌ DISCORD LOGIN FAILED | ${error.message}`
        );

        process.exit(
            1
        );
    }
);
