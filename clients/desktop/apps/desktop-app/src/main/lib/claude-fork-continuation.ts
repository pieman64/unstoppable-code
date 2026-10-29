import type { ClaudeForkToolResult } from '@canopy/desktop-shared/types';

/** The session identity a Claude dispatch hands to its provider session. */
export interface ClaudeContinuationSession {
  sdkSessionId?: string;
  claudeForkSession?: boolean;
  claudeForkResumeAt?: string;
  claudeForkToolResults?: ClaudeForkToolResult[];
}

/**
 * Session identity for a same-turn continuation that recreates the provider
 * session, such as the resume after a deferred-tools reload.
 *
 * A forked Claude chat's first dispatch resumes the source session once with
 * one-shot fork options, and the provider then reports the fork's own session
 * id. The continuation must resume that child in place: replaying the fork
 * options would fork the source again, and the resume anchor would cut the
 * turn being continued out of the model's context. Only a fork whose child
 * never started repeats the original fork.
 *
 * Spread the result after the original dispatch options; once the child
 * exists it overrides the one-shot fork fields with `undefined`.
 */
export function claudeContinuationSession(
  dispatched: ClaudeContinuationSession,
  current: { requestedSessionId?: string; providerSessionId?: string },
): ClaudeContinuationSession {
  if (!dispatched.claudeForkSession) {
    return {
      sdkSessionId:
        current.requestedSessionId ??
        current.providerSessionId ??
        dispatched.sdkSessionId,
    };
  }
  // The provider-owned id is authoritative; a renderer-captured id can still
  // name the source when it was read before the child's init event.
  const forkSessionId = [
    current.providerSessionId,
    current.requestedSessionId,
  ].find(
    (sessionId): sessionId is string =>
      sessionId !== undefined && sessionId !== dispatched.sdkSessionId,
  );
  if (forkSessionId === undefined) {
    return { sdkSessionId: dispatched.sdkSessionId };
  }
  return {
    sdkSessionId: forkSessionId,
    claudeForkSession: undefined,
    claudeForkResumeAt: undefined,
    claudeForkToolResults: undefined,
  };
}
