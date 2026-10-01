const crypto = require("crypto");

const redis = require("./pierroRedis");

const POOL_KEY =
    "pierro:pool:trivia";

const QUESTION_PREFIX =
    "pierro:question:";

const FACT_PREFIX =
    "pierro:fact:";

const REFILL_LOCK_KEY =
    "pierro:lock:question-refill";

const POOL_SIZE = 20;

const REFILL_THRESHOLD = 5;

const REFILL_LOCK_TTL = 120;

function normalizeQuestion(
    value
) {
    return String(value || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(
            /[\u0300-\u036f]/g,
            ""
        )
        .replace(
            /[^a-z0-9\s]/g,
            ""
        )
        .replace(
            /\s+/g,
            " "
        )
        .trim();
}

function normalizeFactKey(
    value
) {
    return String(value || "")
        .toLowerCase()
        .trim()
        .replace(
            /[^a-z0-9_]/g,
            "_"
        )
        .replace(
            /_+/g,
            "_"
        )
        .replace(
            /^_+|_+$/g,
            ""
        );
}

function questionId(
    question
) {
    return crypto
        .createHash(
            "sha256"
        )
        .update(
            normalizeQuestion(
                question
            )
        )
        .digest("hex")
        .slice(0, 16);
}

function shuffleQuestionOptions(
    question
) {
    if (
        !question ||
        !Array.isArray(
            question.options
        ) ||
        question.options.length !== 4
    ) {
        return question;
    }

    const options =
        question.options.map(
            (text, index) => ({
                text,
                correct:
                    index ===
                    question.correctAnswer,
            })
        );

    for (
        let i =
            options.length - 1;
        i > 0;
        i--
    ) {
        const j =
            Math.floor(
                Math.random() *
                    (i + 1)
            );

        [
            options[i],
            options[j],
        ] = [
            options[j],
            options[i],
        ];
    }

    return {
        ...question,

        options:
            options.map(
                option =>
                    option.text
            ),

        correctAnswer:
            options.findIndex(
                option =>
                    option.correct
            ),
    };
}

function questionKey(
    id
) {
    return `${QUESTION_PREFIX}${id}`;
}

function factKey(
    fact
) {
    return `${FACT_PREFIX}${normalizeFactKey(fact)}`;
}

async function addQuestion({
    game,
    question,
    factKey: fact,
    options,
    correctAnswer,
    explanation,
}) {
    if (
        !game ||
        !question ||
        !fact ||
        !Array.isArray(options) ||
        options.length !== 4
    ) {
        return false;
    }

    const id =
        questionId(
            question
        );

    const canonicalQuestionKey =
        questionKey(id);

    const canonicalFactKey =
        factKey(fact);

    /*
    |--------------------------------------------------------------------------
    | Atomic duplicate protection
    |--------------------------------------------------------------------------
    |
    | WAC-style architecture stores canonical questions separately from the
    | pool. The pool contains only IDs, so Redis values are never double
    | serialized JSON strings.
    |
    |--------------------------------------------------------------------------
    */

    const questionStored =
        await redis.set(
            canonicalQuestionKey,
            {
                id,
                game,
                question,
                factKey:
                    normalizeFactKey(
                        fact
                    ),
                options,
                correctAnswer,
                explanation,
                createdAt:
                    Date.now(),
            },
            {
                nx: true,
            }
        );

    if (
        questionStored !==
        "OK"
    ) {
        console.warn(
            `⚠️ DUPLICATE QUESTION | ${question}`
        );

        return false;
    }

    const factStored =
        await redis.set(
            canonicalFactKey,
            id,
            {
                nx: true,
            }
        );

    if (
        factStored !==
        "OK"
    ) {
        await redis.del(
            canonicalQuestionKey
        );

        console.warn(
            `⚠️ DUPLICATE FACT | ${fact}`
        );

        return false;
    }

    await redis.rpush(
        POOL_KEY,
        id
    );

    return true;
}

async function getPoolSize() {
    return Number(
        await redis.llen(
            POOL_KEY
        )
    );
}

async function getFromPool() {
    const id =
        await redis.lpop(
            POOL_KEY
        );

    if (!id) {
        return null;
    }

    const remaining =
        await getPoolSize();

    console.log(
        `📦 QUESTION POOL | Remaining: ${remaining}/${POOL_SIZE}`
    );

    if (
        remaining <=
        REFILL_THRESHOLD
    ) {
        void startBackgroundRefill();
    }

    const question =
        await redis.get(
            questionKey(
                id
            )
        );

    if (!question) {
        console.warn(
            `⚠️ MISSING QUESTION DATA | ID: ${id}`
        );

        return getFromPool();
    }

    return shuffleQuestionOptions(
        question
    );
}

async function startBackgroundRefill() {
    const current =
        await getPoolSize();

    if (
        current >=
        POOL_SIZE
    ) {
        return;
    }

    const lock =
        await redis.set(
            REFILL_LOCK_KEY,
            Date.now(),
            {
                nx: true,
                ex:
                    REFILL_LOCK_TTL,
            }
        );

    if (
        lock !==
        "OK"
    ) {
        console.log(
            "⏳ QUESTION REFILL | Another generator is already running."
        );

        return;
    }

    try {
        const latest =
            await getPoolSize();

        if (
            latest >=
            POOL_SIZE
        ) {
            return;
        }

        const needed =
            POOL_SIZE -
            latest;

        console.log(
            `🔄 QUESTION REFILL STARTED | Current: ${latest} | Needed: ${needed}`
        );

        const {
            generateQuestionBatch,
        } = require("./ai");

        let saved = 0;
        let attempts = 0;

        while (
            saved < needed &&
            attempts < 4
        ) {
            attempts++;

            const target =
                Math.min(
                    20,
                    needed -
                        saved
                );

            try {
                saved +=
                    await generateQuestionBatch(
                        target
                    );
            } catch (error) {
                console.error(
                    `❌ QUESTION REFILL ATTEMPT FAILED | ${error.message}`
                );
            }

            const actual =
                await getPoolSize();

            if (
                actual >=
                POOL_SIZE
            ) {
                break;
            }
        }

        console.log(
            `✅ QUESTION REFILL FINISHED | Pool: ${await getPoolSize()}/${POOL_SIZE}`
        );
    } finally {
        await redis.del(
            REFILL_LOCK_KEY
        );
    }
}

async function waitForExistingRefill() {
    for (let attempt = 0; attempt < 20; attempt++) {
        const poolSize = await getPoolSize();

        if (poolSize > 0) {
            return true;
        }

        const lockExists =
            await redis.exists(
                REFILL_LOCK_KEY
            );

        if (!lockExists) {
            return false;
        }

        await new Promise(
            resolve =>
                setTimeout(
                    resolve,
                    500
                )
        );
    }

    return false;
}

async function generateFirstQuestion() {
    const lock =
        await redis.set(
            REFILL_LOCK_KEY,
            Date.now(),
            {
                nx: true,
                ex:
                    REFILL_LOCK_TTL,
            }
        );

    /*
    If another generator is already running, wait for it rather than
    starting a second Gemini generation at the same time.
    */
    if (lock !== "OK") {
        return await waitForExistingRefill();
    }

    try {
        const {
            generateQuestionBatch,
        } = require("./ai");

        let attempts = 0;

        while (
            attempts < 3
        ) {
            attempts++;

            try {
                const saved =
                    await generateQuestionBatch(
                        1
                    );

                if (
                    saved > 0
                ) {
                    return true;
                }
            } catch (error) {
                console.error(
                    `❌ FIRST QUESTION GENERATION FAILED | ${error.message}`
                );
            }
        }

        return false;
    } finally {
        await redis.del(
            REFILL_LOCK_KEY
        );
    }
}

async function getQuestion() {
    let question =
        await getFromPool();

    if (question) {
        return question;
    }

    /*
    |--------------------------------------------------------------------------
    | Empty pool
    |--------------------------------------------------------------------------
    |
    | If a background refill is already running, wait for it. Otherwise
    | acquire the same distributed lock and generate one usable question.
    | This prevents multiple users from starting parallel Gemini batches.
    |
    |--------------------------------------------------------------------------
    */

    console.log(
        "📭 QUESTION POOL EMPTY | Waiting for existing refill or generating one question..."
    );

    const generated =
        await generateFirstQuestion();

    if (!generated) {
        throw new Error(
            "No trivia question is currently available."
        );
    }

    question =
        await getFromPool();

    if (!question) {
        throw new Error(
            "A question was generated but could not be loaded."
        );
    }

    void startBackgroundRefill();

    return question;
}

async function getTotalQuestionCount() {
    const keys =
        await redis.keys(
            `${QUESTION_PREFIX}*`
        );

    return Array.isArray(keys)
        ? keys.length
        : 0;
}

module.exports = {
    POOL_KEY,
    POOL_SIZE,
    REFILL_THRESHOLD,
    addQuestion,
    getQuestion,
    getPoolSize,
    getTotalQuestionCount,
    startBackgroundRefill,
    normalizeQuestion,
    normalizeFactKey,
};
