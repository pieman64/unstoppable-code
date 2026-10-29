/**
 * Turn-level thumbs up/down feedback wire contract (CAN-1521).
 *
 * A rating is anchored on the renderer's per-turn `userMessageId`
 * (`msg-{n}-{epochMs}` from `stores/chat/ids.ts`), threaded through main →
 * audit → telemetry as `clientUserMessageId`. The desktop `clientTurnId` is
 * deliberately NOT the correlation key: it is rewritten by the telemetry
 * mapping layer's `clampId` whenever it exceeds 128 chars, and `apps/web`
 * cannot import `@canopy/desktop-shared` to reproduce that transform.
 *
 * Nothing is uploaded with a rating. The row is the rating, an optional
 * single-select reason, and an optional free-text comment.
 */

/** Thumbs up / thumbs down. */
export const TURN_FEEDBACK_RATINGS = ['up', 'down'] as const;

export type TurnFeedbackRating = (typeof TURN_FEEDBACK_RATINGS)[number];

/**
 * Reason codes offered on a thumbs-down. Kebab-case wire values; the server
 * stores them in a child table so multi-select becomes possible later without
 * a migration.
 */
export const TURN_FEEDBACK_REASONS = [
  'incorrect-or-didnt-work',
  'ignored-instructions',
  'changed-more-than-asked',
  'broke-something',
  'got-stuck',
  'missed-context',
  'unsafe-action',
  'other',
] as const;

export type TurnFeedbackReason = (typeof TURN_FEEDBACK_REASONS)[number];

/** Maximum accepted length of the optional free-text comment. */
export const MAX_TURN_FEEDBACK_COMMENT_LENGTH = 4000;

/** Maximum accepted length of the client correlation ids on the wire. */
export const MAX_TURN_FEEDBACK_CLIENT_ID_LENGTH = 128;

export function isTurnFeedbackRating(
  value: unknown,
): value is TurnFeedbackRating {
  // `.some()` with an equality check rather than `.includes(value as T)`:
  // narrowing a readonly tuple's `includes` needs a cast, and the repo forbids
  // `as`. This is sound without one.
  return (
    typeof value === 'string' &&
    TURN_FEEDBACK_RATINGS.some((rating) => rating === value)
  );
}

export function isTurnFeedbackReason(
  value: unknown,
): value is TurnFeedbackReason {
  // See `isTurnFeedbackRating` — `.some()` avoids the forbidden `as` cast.
  return (
    typeof value === 'string' &&
    TURN_FEEDBACK_REASONS.some((reason) => reason === value)
  );
}

/**
 * Optional technical context denormalized onto the row so the warehouse can
 * slice ratings without joining `transcript_turns` (which does not exist when
 * telemetry is disabled). Unknown values are dropped server-side, never
 * rejected — a rating must not 400 because a newer desktop shipped a new
 * provider or chat mode.
 */
export interface TurnFeedbackContext {
  provider?: string;
  model?: string;
  eventType?: string;
  chatMode?: string;
  appVersion?: string;
  /** Chat this turn belongs to; guards the `nextMsgId()` collision case. */
  clientChatId?: string;
}

/** `POST /api/v1/feedback/turns` — records (or re-records) the rating. */
export interface TurnFeedbackRateRequest extends TurnFeedbackContext {
  clientUserMessageId: string;
  rating: TurnFeedbackRating;
}

/**
 * `PATCH /api/v1/feedback/turns/{feedbackId}` — amends an existing rating with
 * the thumbs-down reason and/or comment. Skipping the dialog simply never
 * calls this, so skip can never undo the rating.
 */
export interface TurnFeedbackDetailRequest {
  reason?: TurnFeedbackReason;
  comment?: string;
}

/** The rating as the client needs to render it. Never carries the comment. */
export interface TurnFeedbackSummary {
  feedbackId: string;
  clientUserMessageId: string;
  rating: TurnFeedbackRating;
  reason?: TurnFeedbackReason;
  hasComment: boolean;
  createdAt: string;
  updatedAt: string;
}

/** `GET /api/v1/feedback/turns?clientChatId=…` */
export interface TurnFeedbackListResponse {
  feedback: TurnFeedbackSummary[];
}

/**
 * `GET /api/v1/feedback/turns/{feedbackId}` — the author's own row, or any row
 * for a system admin (`User.role === 'ADMIN'`). Org admins get nothing, ever.
 * Denial is a 404, not a 403, so the endpoint is not an existence oracle.
 */
export interface TurnFeedbackDetailRecord extends TurnFeedbackSummary {
  comment?: string;
  provider?: string;
  model?: string;
  eventType?: string;
  chatMode?: string;
  appVersion?: string;
  clientChatId?: string;
}
