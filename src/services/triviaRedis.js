const redis = require("./pierroRedis");


const ACTIVE_KEY =
    "pierro:trivia:active";

const PANEL_KEY =
    "pierro:trivia:panel";

const START_LOCK_KEY =
    "pierro:trivia:start-lock";

const START_LOCK_TTL =
    30;


/*
|--------------------------------------------------------------------------
| How long an unanswered question remains valid.
|--------------------------------------------------------------------------
|
| This is NOT the 24h cooldown.
|
| It only prevents an old unanswered question from staying around forever.
|
|--------------------------------------------------------------------------
*/

const ATTEMPT_TTL =
    10 * 60;


function attemptKey(
    userId
) {
    return `pierro:trivia:attempt:${userId}`;
}


/*
|--------------------------------------------------------------------------
| ACTIVE TRIVIA
|--------------------------------------------------------------------------
*/

async function getActiveTrivia() {
    return await redis.get(
        ACTIVE_KEY
    );
}


/*
|--------------------------------------------------------------------------
| START LOCK
|--------------------------------------------------------------------------
*/

async function acquireStartLock() {
    return (
        await redis.set(
            START_LOCK_KEY,
            Date.now(),
            {
                nx: true,
                ex:
                    START_LOCK_TTL,
            }
        )
    ) === "OK";
}


async function releaseStartLock() {
    await redis.del(
        START_LOCK_KEY
    );
}


/*
|--------------------------------------------------------------------------
| ACTIVATE TRIVIA
|--------------------------------------------------------------------------
*/

async function activateTrivia(
    panel
) {
    await redis.set(
        ACTIVE_KEY,
        {
            active:
                true,

            startedAt:
                Date.now(),
        }
    );

    await redis.set(
        PANEL_KEY,
        panel
    );
}


/*
|--------------------------------------------------------------------------
| KILL TRIVIA
|--------------------------------------------------------------------------
*/

async function killTrivia() {
    await redis.del(
        ACTIVE_KEY
    );

    await redis.del(
        PANEL_KEY
    );
}


async function getPanel() {
    return await redis.get(
        PANEL_KEY
    );
}


/*
|--------------------------------------------------------------------------
| SAVE / REPLACE QUESTION
|--------------------------------------------------------------------------
|
| Calling this multiple times for the same user simply replaces their
| previous unanswered question.
|
|--------------------------------------------------------------------------
*/

async function saveAttempt(
    userId,
    question
) {
    const attempt = {
        userId,

        questionId:
            question.id,

        question,

        createdAt:
            Date.now(),
    };

    await redis.set(
        attemptKey(userId),
        attempt,
        {
            ex:
                ATTEMPT_TTL,
        }
    );

    return attempt;
}


/*
|--------------------------------------------------------------------------
| GET CURRENT QUESTION
|--------------------------------------------------------------------------
*/

async function getAttempt(
    userId
) {
    return await redis.get(
        attemptKey(userId)
    );
}


/*
|--------------------------------------------------------------------------
| ATOMICALLY CONSUME QUESTION
|--------------------------------------------------------------------------
|
| Redis GETDEL means:
|
|     GET + DELETE
|
| happens as one Redis operation.
|
| This guarantees that only one answer request can consume the attempt.
|
|--------------------------------------------------------------------------
*/

async function consumeAttempt(
    userId
) {
    const key =
        attemptKey(userId);

    /*
    |--------------------------------------------------------------------------
    | Upstash Redis supports GETDEL.
    |--------------------------------------------------------------------------
    */

    const attempt =
        await redis.getdel(
            key
        );

    return attempt || null;
}


/*
|--------------------------------------------------------------------------
| DELETE QUESTION
|--------------------------------------------------------------------------
|
| Kept for compatibility with any other Pierro code.
|--------------------------------------------------------------------------
*/

async function deleteAttempt(
    userId
) {
    await redis.del(
        attemptKey(userId)
    );
}


module.exports = {
    ATTEMPT_TTL,

    getActiveTrivia,

    acquireStartLock,

    releaseStartLock,

    activateTrivia,

    killTrivia,

    getPanel,

    saveAttempt,

    getAttempt,

    consumeAttempt,

    deleteAttempt,
};