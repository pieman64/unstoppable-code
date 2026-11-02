import { logMainProcessWarn } from '../lib/main-process-logging';

type SteeringEligibilityListener = (sessionKey: string) => void;

const listeners = new Set<SteeringEligibilityListener>();

/**
 * A chat session's ability to take steered input may have changed.
 *
 * Providers and the session manager call this after every change they make to
 * an input of that ability, so a notification can be spurious. One input has
 * no change event: the AI Credits routing a session was created under. A
 * consumer therefore reads the live capability at each of its own decisions
 * and treats a notification as one more reason to read it.
 *
 * It runs inside the caller's state change: a listener re-reads the live
 * state later and must not act inline.
 */
export function notifySteeringEligibilityChanged(sessionKey: string): void {
  for (const listener of Array.from(listeners)) {
    try {
      listener(sessionKey);
    } catch (error) {
      logMainProcessWarn(
        '[steering-eligibility] A listener failed for a chat session:',
        error,
      );
    }
  }
}

export function subscribeSteeringEligibility(
  listener: SteeringEligibilityListener,
): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}
