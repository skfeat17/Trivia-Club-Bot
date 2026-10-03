require("dotenv").config();

const {
    REST,
    Routes,
} = require("discord.js");

const {
    triviaCommand,
} = require("./src/services/trivia");

const {
    cooldownCommand,
} = require("./src/services/cooldown");

const {
    statsCommand,
} = require("./src/services/stats");

const {
    giveawayCommand,
} = require("./src/services/giveaway/giveaway");

const commands = [
    triviaCommand.toJSON(),
    cooldownCommand.toJSON(),
    statsCommand.toJSON(),
    giveawayCommand.toJSON(),
];

const rest =
    new REST({
        version:
            "10",
    }).setToken(
        process.env.DISCORD_TOKEN
    );

(async () => {
    try {
        console.log(
            `🚀 Deploying ${commands.length} Pierro command(s) globally...`
        );

        await rest.put(
            Routes.applicationCommands(
                process.env.DISCORD_CLIENT_ID
            ),
            {
                body:
                    commands,
            }
        );

        console.log(
            "✅ Pierro global commands deployed successfully."
        );
    } catch (error) {
        console.error(
            "❌ COMMAND DEPLOYMENT FAILED:",
            error
        );

        process.exitCode =
            1;
    }
})();
