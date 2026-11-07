const { SlashCommandBuilder, AttachmentBuilder } = require("discord.js");
const { createCanvas, loadImage } = require("@napi-rs/canvas");
const {
    getTopEarners,
    recordMoraSpent,
    getSpendingSummary,
    getDailySpendingSeries,
    getTriviaSummary,
} = require("./leaderboardService");

const leaderboardCommand = new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("View the Permanent Trivia leaderboard and Mora statistics.");

const number = value => Number(value || 0).toLocaleString("en-IN");

function roundedRect(ctx, x, y, w, h, r, color) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.fillStyle = color;
    ctx.fill();
}

function label(ctx, text, x, y, size, color, weight = "normal", font = "sans-serif") {
    ctx.font = `${weight} ${size}px ${font}`;
    ctx.fillStyle = color;
    ctx.fillText(String(text), x, y);
}

function fitText(ctx, text, maxWidth) {
    let value = String(text ?? "");
    if (ctx.measureText(value).width <= maxWidth) return value;
    while (value.length > 1 && ctx.measureText(`${value}…`).width > maxWidth) {
        value = value.slice(0, -1);
    }
    return `${value}…`;
}

async function resolvePlayers(client, entries) {
    return Promise.all(entries.map(async entry => {
        try {
            const user = await client.users.fetch(entry.userId);
            // Use Discord username (unique handle), not global display name.
            return {
                ...entry,
                displayName: user.username,
                avatarURL: user.displayAvatarURL({ extension: "png", size: 128 }),
            };
        } catch {
            return {
                ...entry,
                displayName: `Unknown user (${entry.userId.slice(-4)})`,
                avatarURL: null,
            };
        }
    }));
}

async function renderLeaderboardImage({ earners, spending, series, trivia }) {
    const width = 1500;
    const height = 1000;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");

    const bg = ctx.createLinearGradient(0, 0, width, height);
    bg.addColorStop(0, "#10131d");
    bg.addColorStop(1, "#1b2232");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);

    // Header
    label(ctx, "PIERRO  /  PERMANENT TRIVIA", 55, 58, 18, "#d8b66a", "bold");
    label(ctx, "LEADERBOARD & ECONOMY", 55, 108, 38, "#ffffff", "bold");
    label(ctx, `UPDATED ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST`, 1080, 65, 13, "#8e9ab0");

    // Leaderboard panel
    roundedRect(ctx, 48, 140, 475, 790, 18, "#20283a");
    label(ctx, "TOP 10 MORA EARNERS", 78, 190, 22, "#f2d58a", "bold");
    label(ctx, "Permanent Trivia • retained activity (up to 400 days)", 78, 218, 13, "#93a0b7");

    if (!earners.length) {
        label(ctx, "No recorded Mora rewards yet.", 78, 285, 17, "#c3cada");
    }

    for (let index = 0; index < earners.length; index++) {
        const player = earners[index];
        const y = 270 + index * 62;
        const avatarX = 132;
        const avatarY = y - 10;
        const rankColor = index < 3 ? "#f2d58a" : "#aeb9cc";

        // Rank marker and circular avatar.
        label(ctx, `#${index + 1}`, 78, y + 7, 16, rankColor, "bold");
        ctx.save();
        ctx.beginPath();
        ctx.arc(avatarX, avatarY, 21, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();

        let avatar = null;
        if (player.avatarURL) {
            try { avatar = await loadImage(player.avatarURL); } catch { /* use fallback */ }
        }
        if (avatar) {
            ctx.drawImage(avatar, avatarX - 21, avatarY - 21, 42, 42);
        } else {
            ctx.fillStyle = "#39465e";
            ctx.fillRect(avatarX - 21, avatarY - 21, 42, 42);
            ctx.fillStyle = "#e5c477";
            ctx.beginPath();
            ctx.arc(avatarX, avatarY - 5, 7, 0, Math.PI * 2);
            ctx.fill();
            ctx.beginPath();
            ctx.ellipse(avatarX, avatarY + 17, 13, 10, 0, Math.PI, 0);
            ctx.fill();
        }
        ctx.restore();

        ctx.font = "bold 17px sans-serif";
        const name = fitText(ctx, player.displayName, 175);
        label(ctx, name, 170, y + 7, 16, "#f1f4fa", "bold");
        label(ctx, `${number(player.mora)} Mora`, 365, y + 7, 15, "#f2d58a", "bold");

        if (index !== earners.length - 1) {
            ctx.strokeStyle = "#343e52";
            ctx.beginPath();
            ctx.moveTo(78, y + 29);
            ctx.lineTo(490, y + 29);
            ctx.stroke();
        }
    }

    // Spending chart
    roundedRect(ctx, 550, 140, 902, 455, 18, "#20283a");
    label(ctx, "MORA SPENDING", 585, 190, 22, "#ffffff", "bold");
    label(ctx, `Daily spending • ${series[0]?.date || "—"} to ${series[series.length - 1]?.date || "—"} (IST)`, 585, 218, 13, "#93a0b7");

    const plot = { x: 650, y: 265, w: 740, h: 245 };
    const maxValue = Math.max(0, ...series.map(point => Number(point.mora) || 0));
    const hasSpendingData = maxValue > 0;
    const scaleMax = hasSpendingData ? maxValue * 1.15 : 1;

    for (let i = 0; i <= 4; i++) {
        const y = plot.y + (plot.h / 4) * i;
        ctx.strokeStyle = "#354055";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(plot.x, y);
        ctx.lineTo(plot.x + plot.w, y);
        ctx.stroke();
        const tick = hasSpendingData ? Math.round(scaleMax * (4 - i) / 4) : 0;
        label(ctx, number(tick), 585, y + 4, 11, "#8e9ab0");
    }

    if (!hasSpendingData) {
        label(ctx, "NO SPENDING DATA RECORDED YET", 820, 380, 17, "#aeb9cc", "bold");
        label(ctx, "The graph populates as reward payments are marked PAID.", 770, 408, 13, "#8e9ab0");
    }

    if (series.length && hasSpendingData) {
        const points = series.map((point, index) => ({
            x: plot.x + (series.length === 1 ? 0 : index * plot.w / (series.length - 1)),
            y: plot.y + plot.h - ((Number(point.mora) || 0) / scaleMax) * (plot.h - 10),
        }));

        ctx.beginPath();
        ctx.moveTo(points[0].x, plot.y + plot.h);
        points.forEach(point => ctx.lineTo(point.x, point.y));
        ctx.lineTo(points[points.length - 1].x, plot.y + plot.h);
        ctx.closePath();
        const area = ctx.createLinearGradient(0, plot.y, 0, plot.y + plot.h);
        area.addColorStop(0, "rgba(216,182,106,0.28)");
        area.addColorStop(1, "rgba(216,182,106,0.01)");
        ctx.fillStyle = area;
        ctx.fill();

        ctx.beginPath();
        points.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
        ctx.strokeStyle = "#e0bd70";
        ctx.lineWidth = 3;
        ctx.stroke();

        points.forEach(point => {
            ctx.beginPath();
            ctx.arc(point.x, point.y, 3, 0, Math.PI * 2);
            ctx.fillStyle = "#f5d995";
            ctx.fill();
        });
    }

    const dateLabel = value => value ? `${value.slice(8, 10)}/${value.slice(5, 7)}` : "";
    label(ctx, dateLabel(series[0]?.date), plot.x, 548, 11, "#8e9ab0");
    label(ctx, dateLabel(series[Math.floor(series.length / 2)]?.date), plot.x + 340, 548, 11, "#8e9ab0");
    label(ctx, dateLabel(series[series.length - 1]?.date), plot.x + plot.w - 42, 548, 11, "#8e9ab0");

    // Summary cards: previous calendar month replaces lifetime.
    roundedRect(ctx, 550, 620, 902, 310, 18, "#20283a");
    label(ctx, "SPENDING SUMMARY", 585, 665, 22, "#ffffff", "bold");

    const metrics = [
        ["LAST 24 HOURS", spending.last24Hours],
        ["THIS WEEK", spending.thisWeek],
        ["THIS MONTH", spending.thisMonth],
        ["LIFETIME", spending.lifetime],
    ];
    const cardW = 195;
    const cardGap = 18;
    metrics.forEach((metric, index) => {
        const x = 585 + index * (cardW + cardGap);
        roundedRect(ctx, x, 690, cardW, 100, 12, "#2a354b");
        label(ctx, metric[0], x + 14, 723, 11, "#9eabc1", "bold");
        label(ctx, `${number(metric[1])} Mora`, x + 14, 765, 20, "#f2d58a", "bold");
    });

    label(
        ctx,
        `24H TRIVIA: ${number(trivia.attempts24Hours)} attempts  •  ${number(trivia.uniquePlayers24Hours)} players  •  ${number(trivia.correct24Hours)} correct  •  ${number(trivia.incorrect24Hours)} incorrect`,
        585, 850, 13, "#aeb9cc"
    );
    label(ctx, "PIERRO • PERMANENT TRIVIA STATISTICS", 55, 970, 12, "#66738d");

    return canvas.toBuffer("image/png");
}

async function handleLeaderboardCommand(interaction) {
    await interaction.deferReply();
    try {
        const [rawEarners, spending, series, trivia] = await Promise.all([
            getTopEarners(10),
            getSpendingSummary(),
            getDailySpendingSeries(Date.now(), 30),
            getTriviaSummary(),
        ]);

        const earners = await resolvePlayers(interaction.client, rawEarners);
        const buffer = await renderLeaderboardImage({ earners, spending, series, trivia });
        const attachment = new AttachmentBuilder(buffer, { name: "pierro-leaderboard.png" });

        await interaction.editReply({
            content: "🏆 **Pierro — Permanent Trivia Leaderboard**",
            files: [attachment],
        });
    } catch (error) {
        console.error("❌ LEADERBOARD ERROR:", error);
        await interaction.editReply({
            content: "❌ Could not generate the leaderboard. Check the bot logs.",
            files: [],
        }).catch(() => {});
    }
}

module.exports = {
    leaderboardCommand,
    handleLeaderboardCommand,
    renderLeaderboardImage,
    // Exported for use at the successful Mora deduction point in the economy.
    recordMoraSpent,
};
