const {
    GoogleGenAI,
} = require("@google/genai");

const redis = require("./pierroRedis");
const {
    addQuestion,
    normalizeQuestion,
    normalizeFactKey,
} = require("./questionManager");

const GEMINI_MODEL =
    "gemini-3.1-flash-lite";

const GAMES = [
    "Genshin Impact",
    "Honkai: Star Rail",
    "Wuthering Waves",
    "Zenless Zone Zero",
    "Pokémon",
];

const BATCH_SIZE = 20;

const MAX_OUTPUT_TOKENS =
    10000;

const ai =
    new GoogleGenAI({
        apiKey:
            process.env.GEMINI_API_KEY,
    });

function createResponseSchema(
    target
) {
    return {
        type:
            "object",

        properties: {
            questions: {
                type:
                    "array",
                minItems:
                    target,
                maxItems:
                    target,

                items: {
                    type:
                        "object",

                    properties: {
                        game: {
                            type:
                                "string",
                            enum:
                                GAMES,
                        },

                        question: {
                            type:
                                "string",
                        },

                        factKey: {
                            type:
                                "string",
                        },

                        options: {
                            type:
                                "array",
                            minItems:
                                4,
                            maxItems:
                                4,
                            items: {
                                type:
                                    "string",
                            },
                        },

                        correctAnswer: {
                            type:
                                "integer",
                            minimum:
                                0,
                            maximum:
                                3,
                        },

                        explanation: {
                            type:
                                "string",
                        },
                    },

                    required: [
                        "game",
                        "question",
                        "factKey",
                        "options",
                        "correctAnswer",
                        "explanation",
                    ],

                    additionalProperties:
                        false,
                },
            },
        },

        required: [
            "questions",
        ],

        additionalProperties:
            false,
    };
}

function validateQuestion(
    question
) {
    if (
        !question ||
        !GAMES.includes(
            question.game
        )
    ) {
        throw new Error(
            "Invalid game."
        );
    }

    if (
        typeof question.question !==
            "string" ||
        question.question
            .trim()
            .length < 10
    ) {
        throw new Error(
            "Question text is invalid."
        );
    }

    if (
        question.question
            .length > 300
    ) {
        throw new Error(
            "Question text is too long."
        );
    }

    if (
        !question.factKey ||
        typeof question.factKey !==
            "string"
    ) {
        throw new Error(
            "factKey is missing."
        );
    }

    if (
        !Array.isArray(
            question.options
        ) ||
        question.options.length !==
            4
    ) {
        throw new Error(
            "Question must contain exactly 4 options."
        );
    }

    const normalizedOptions =
        question.options.map(
            option =>
                String(option)
                    .trim()
                    .toLowerCase()
        );

    if (
        new Set(
            normalizedOptions
        ).size !== 4
    ) {
        throw new Error(
            "Question contains duplicate options."
        );
    }

    if (
        question.options.some(
            option =>
                !String(option)
                    .trim() ||
                String(option)
                    .length > 70
        )
    ) {
        throw new Error(
            "Every answer option must be between 1 and 70 characters."
        );
    }

    if (
        !Number.isInteger(
            question.correctAnswer
        ) ||
        question.correctAnswer <
            0 ||
        question.correctAnswer >
            3
    ) {
        throw new Error(
            "correctAnswer must be 0, 1, 2, or 3."
        );
    }

    if (
        typeof question.explanation !==
            "string" ||
        !question.explanation
            .trim() ||
        question.explanation
            .length > 500
    ) {
        throw new Error(
            "Explanation is invalid."
        );
    }
}

function buildPrompt(
    target
) {
    return `
You are the permanent trivia question generator for Pierro, a Discord trivia bot.

Generate exactly ${target} unique multiple-choice trivia question${target === 1 ? "" : "s"}.

ONLY use these franchises:
- Genshin Impact
- Honkai: Star Rail
- Wuthering Waves
- Zenless Zone Zero
- Pokémon

RULES:
- Use established, verifiable game knowledge.
- Do not use leaks, rumors, unreleased content, fan theories, or speculative information.
- Questions may cover characters, locations, lore, items, abilities, mechanics, regions, terminology, gameplay, history, and notable facts.
- Exactly 4 plausible answer options per question.
- Exactly 1 correct answer.
- correctAnswer is the zero-based index of the correct option.
- Keep each option short enough for a Discord button.
- Do not make the correct answer obviously longer or more detailed than the other options.
- Do not put the answer inside the question wording.
- Avoid trick questions and ambiguous questions.
- Do not create multiple questions about the same underlying fact.
- Do not repeat questions.
- factKey must identify the underlying fact and use lowercase_snake_case.
- Explanations must be concise and factual.
- Mix the five franchises naturally. Do not force equal distribution.
- Do not number the questions.
- Return ONLY the JSON object matching the supplied schema.

The current target is ${target}.
`;
}

function parseGeminiResponse(
    response
) {
    if (
        !response ||
        !response.text
    ) {
        throw new Error(
            "Gemini returned an empty response."
        );
    }

    try {
        return JSON.parse(
            response.text
        );
    } catch (error) {
        console.error(
            "❌ GEMINI RAW RESPONSE:",
            response.text
        );

        throw new Error(
            `Gemini returned invalid JSON: ${error.message}`
        );
    }
}

async function generateQuestionBatch(
    target = BATCH_SIZE
) {
    const requested =
        Math.max(
            1,
            Math.min(
                BATCH_SIZE,
                Math.floor(
                    Number(target) ||
                        1
                )
            )
        );

    console.log(
        `🤖 GEMINI GENERATION STARTED | Target: ${requested} | Model: ${GEMINI_MODEL}`
    );

    const response =
        await ai.models.generateContent({
            model:
                GEMINI_MODEL,

            contents:
                buildPrompt(
                    requested
                ),

            config: {
                responseMimeType:
                    "application/json",

                responseSchema:
                    createResponseSchema(
                        requested
                    ),

                maxOutputTokens:
                    requested === 1
                        ? 1800
                        : MAX_OUTPUT_TOKENS,
            },
        });

    const parsed =
        parseGeminiResponse(
            response
        );

    if (
        !parsed ||
        !Array.isArray(
            parsed.questions
        )
    ) {
        throw new Error(
            "Gemini response does not contain a questions array."
        );
    }

    let saved = 0;

    const seenQuestions =
        new Set();

    const seenFacts =
        new Set();

    for (
        const question
        of parsed.questions
    ) {
        if (
            saved >= requested
        ) {
            break;
        }

        try {
            validateQuestion(
                question
            );

            const normalizedQuestion =
                normalizeQuestion(
                    question.question
                );

            const normalizedFact =
                normalizeFactKey(
                    question.factKey
                );

            if (
                seenQuestions.has(
                    normalizedQuestion
                )
            ) {
                console.warn(
                    `⚠️ AI DUPLICATE QUESTION SKIPPED | ${question.question}`
                );
                continue;
            }

            if (
                seenFacts.has(
                    normalizedFact
                )
            ) {
                console.warn(
                    `⚠️ AI DUPLICATE FACT SKIPPED | ${question.factKey}`
                );
                continue;
            }

            seenQuestions.add(
                normalizedQuestion
            );

            seenFacts.add(
                normalizedFact
            );

            const added =
                await addQuestion(
                    {
                        game:
                            question.game,
                        question:
                            question.question,
                        factKey:
                            question.factKey,
                        options:
                            question.options,
                        correctAnswer:
                            question.correctAnswer,
                        explanation:
                            question.explanation,
                    }
                );

            if (added) {
                saved++;

                console.log(
                    `✅ QUESTION SAVED | ${question.game} | ${question.question}`
                );
            }
        } catch (error) {
            console.warn(
                `⚠️ INVALID AI QUESTION SKIPPED | ${error.message}`
            );
        }
    }

    console.log(
        `🤖 GEMINI GENERATION FINISHED | Saved: ${saved}/${requested}`
    );

    return saved;
}

module.exports = {
    GAMES,
    BATCH_SIZE,
    GEMINI_MODEL,
    generateQuestionBatch,
};
