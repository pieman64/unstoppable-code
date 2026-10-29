import type { SpaceNotificationClass } from '@canopy/protocol/space-notifications';
import type {
  ExecutionEvent,
  PipelineStatusReasonKind,
} from '../types/pipeline';
import { getToastType } from './get-toast-type';

/** Typed pause reasons that need the user: input, sign-in or credentials,
 * a usage limit, or an action holding the run until someone resumes it. */
const ATTENTION_PAUSE_REASONS: ReadonlySet<PipelineStatusReasonKind> =
  new Set<PipelineStatusReasonKind>([
    'provider_sign_in',
    'input_required',
    'action_paused',
    'provider_authentication_required',
    'provider_usage_limit',
  ]);

/**
 * The typed meaning of a root run's toast for per-space notification choices
 * (CAN-3615). Failures are failures; a pause is attention only when a typed
 * reason or input request says the user is needed (an app shutdown or a
 * transient provider outage is routine); completion is routine.
 */
export function getPipelineNotificationClass(
  event: ExecutionEvent,
): SpaceNotificationClass | null {
  const toastType = getToastType(event);
  if (toastType === null) return null;
  if (toastType === 'error') return 'failure';
  if (toastType === 'success') return 'routine';
  // An event state that skipped load-time migration can lack these fields, so
  // read them the way the main-process projections do.
  const needsUser =
    (event.state.status_reasons ?? []).some((reason) =>
      ATTENTION_PAUSE_REASONS.has(reason.kind),
    ) ||
    (event.state.pending_pauses ?? []).some((pause) => pause.kind === 'input');
  return needsUser ? 'attention' : 'routine';
}
