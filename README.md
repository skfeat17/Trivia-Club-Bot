# 🎭 Pierro — Permanent Trivia

Pierro is a standalone trivia bot for:

- Genshin Impact
- Honkai: Star Rail
- Wuthering Waves
- Zenless Zone Zero
- Pokémon

This version follows the same practical architecture used by the World Adventure Club bot:

- `src/index.js` owns Discord startup and interaction routing.
- Persistent state is handled by small Redis-oriented services.
- AI generation is isolated in `services/ai.js`.
- Question storage/pooling is isolated in `services/questionManager.js`.
- Payment storage and payment workflow are separate services.
- Stats and cooldowns are separate services.
- Commands are defined inside the service modules and registered globally.
- Redis values are stored and read as native objects; there is no blind `JSON.parse()` of Upstash results.

## Commands

```text
/trivia event:trivia action:start
/trivia event:trivia action:kill

/cooldown event:trivia action:check user:@user
/cooldown event:trivia action:remove user:@user
/cooldown event:trivia action:modify user:@user
/cooldown event:trivia action:check clear_all:true

/stats event:trivia type:participations
/stats event:trivia type:participations user:@user
/stats event:trivia type:cooldown
/stats event:trivia type:cooldown user:@user
```

Only user IDs from `STAFF_USER_IDS` can manage commands. Pierro does not use a staff role, `Administrator`, or a guild ID.

## Permanent Trivia flow

1. Staff starts one persistent panel.
2. A player clicks **🎲 What's My Trivia Today?**
3. Pierro checks the player's 24-hour cooldown.
4. One question is removed atomically from the Redis pool.
5. The question is shown ephemerally with the four answer choices as buttons.
6. The attempt is stored in Redis for 10 minutes.
7. The player clicks an answer.
8. The attempt is deleted before processing, preventing double rewards.
9. Participation is recorded as correct or incorrect.
10. A 24-hour cooldown starts.
11. Correct answers receive 10–100 Mora and create a staff payment request.
12. Incorrect answers receive no Mora and see the correct answer plus explanation.

## Question architecture

Pierro keeps a target pool of 20 question IDs in Redis.

Each question is stored separately as a canonical object:

```text
pierro:question:<sha256>
pierro:fact:<normalized-fact-key>
pierro:pool:trivia
```

The pool stores question IDs, not serialized JSON blobs.

When a question is consumed, the ID is removed with Redis `LPOP`. The canonical question is then loaded and its options are shuffled before the attempt is created.

The question/fact keys remain permanently, preventing the same question or underlying fact from being inserted again.

When the pool reaches the refill threshold, background generation starts behind a Redis NX lock. If the pool is empty, Pierro generates one usable question first so the player does not wait for the whole refill batch.

## AI

The generator uses:

```text
gemini-3.1-flash-lite
```

The AI must return structured JSON containing:

- game
- question
- factKey
- options
- correctAnswer
- explanation

Questions are validated before they enter Redis.

## Payment workflow

For every correct answer, Pierro creates a transaction in Redis and DMs every ID in `PAYMENT_STAFF_USER_IDS`.

Each staff DM contains:

- winner
- game
- reward
- question
- transaction ID
- **Pay User** link button
- **Mark Paid** button

The **Pay User** button opens `PAYMENT_CHANNEL_URL`.

## Setup

Requirements: Node.js 20+.

```bash
npm install
```

Copy `.env.example` to `.env` and fill every required value.

Register commands:

```bash
npm run deploy
```

Start:

```bash
npm start
```

Development:

```bash
npm run dev
```

No `DISCORD_GUILD_ID` is required because commands are deployed globally and the bot is designed for user-level installation.
