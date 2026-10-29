// CAN-2359: the SSE command transport fallback must not be sticky for the
// whole session — after a cooldown the desktop re-probes SSE so one bad patch
// of network/edge weather cannot lock a session into long-polling forever.
import {
  SSE_COMMAND_FALLBACK_COOLDOWN_CAP_MS,
  SSE_COMMAND_FALLBACK_COOLDOWN_MS,
  nextSseCommandRetryAfter,
  shouldAttemptSseCommands,
} from '../portal-session-manager';

describe('SSE command cooldown (CAN-2359)', () => {
  it('allows SSE when no fallback has occurred', () => {
    expect(shouldAttemptSseCommands(1_000, 0, true)).toBe(true);
  });

  it('blocks SSE during the cooldown window and re-probes after it', () => {
    const retryAfter = nextSseCommandRetryAfter(60_000, 1);
    expect(retryAfter).toBe(60_000 + SSE_COMMAND_FALLBACK_COOLDOWN_MS);
    expect(shouldAttemptSseCommands(retryAfter - 1, retryAfter, true)).toBe(
      false,
    );
    expect(shouldAttemptSseCommands(retryAfter, retryAfter, true)).toBe(true);
  });

  it('never attempts SSE while the feature flag is off', () => {
    expect(shouldAttemptSseCommands(1_000, 0, false)).toBe(false);
  });

  it('escalates the cooldown on consecutive fallbacks up to the cap', () => {
    expect(nextSseCommandRetryAfter(0, 1)).toBe(
      SSE_COMMAND_FALLBACK_COOLDOWN_MS,
    );
    expect(nextSseCommandRetryAfter(0, 2)).toBe(
      2 * SSE_COMMAND_FALLBACK_COOLDOWN_MS,
    );
    expect(nextSseCommandRetryAfter(0, 3)).toBe(
      4 * SSE_COMMAND_FALLBACK_COOLDOWN_MS,
    );
    expect(nextSseCommandRetryAfter(0, 4)).toBe(
      SSE_COMMAND_FALLBACK_COOLDOWN_CAP_MS,
    );
    expect(nextSseCommandRetryAfter(0, 20)).toBe(
      SSE_COMMAND_FALLBACK_COOLDOWN_CAP_MS,
    );
  });
});
