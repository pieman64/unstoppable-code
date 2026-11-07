import { logMainProcessWarn } from '../lib/main-process-logging';
import type { AppAdvisorToolRuntimeSurfaces } from './runtime';

export type AppAdvisorPresentationReason =
  | 'user_send'
  | 'watcher_turn'
  | 'queued_send';

/**
 * CAN-4133 D13: the App Advisor window opens as a presentation reaction to a
 * turn, never as a precondition. Schedules ensureAppAdvisorWindow() on a later
 * microtask and returns at once; a failure is logged and never reaches the turn.
 */
export function requestAppAdvisorPresentation(
  surfaces:
    | Pick<AppAdvisorToolRuntimeSurfaces, 'ensureAppAdvisorWindow'>
    | undefined,
  reason: AppAdvisorPresentationReason,
): void {
  if (!surfaces) return;
  void Promise.resolve()
    .then(() => surfaces.ensureAppAdvisorWindow())
    .catch((error: unknown) => {
      logMainProcessWarn('Opening the App Advisor window for a turn failed', {
        reason,
        error,
      });
    });
}
