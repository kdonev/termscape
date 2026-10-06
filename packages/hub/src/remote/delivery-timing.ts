/**
 * How long a delivery may wait for a starting agent before going in regardless.
 *
 * There has to be a bound. A session's readiness gate deliberately outlasts
 * its own cap while a question is on screen - the instruction is still wanted
 * once the human answers - but a `send_message` that blocks its caller until
 * somebody walks over to a window is worse than a message that arrives badly.
 * So the wait is bounded here, and past it delivery is what it always was:
 * immediate, recorded, and the CLI's business.
 */
export const DELIVERY_WAIT_CAP_MS = 20_000;

/*
 * The two timeouts below outlast that wait, and each is longer than the one
 * inside it. A request that gives up while the message is still being held
 * reports a failure and then delivers anyway, which is worse than either.
 *
 *   attached hub --(UPLINK)--> canvas --(PEER)--> machine holding the agent
 *
 * The machine holding the agent waits at most the cap. The canvas asking it
 * waits that plus a margin for the round trip, and an attached hub asking the
 * canvas waits for that plus another, because the canvas may itself be
 * passing the message on.
 */

/** How long the canvas waits on a machine it attached for a delivery. */
export const PEER_DELIVER_TIMEOUT_MS = DELIVERY_WAIT_CAP_MS + 10_000;

/** How long an attached hub waits on the canvas for a delivery. */
export const UPLINK_DELIVER_TIMEOUT_MS = PEER_DELIVER_TIMEOUT_MS + 10_000;
