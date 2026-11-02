import {
  startClientOperation,
  succeedClientOperation,
} from '@canopy/desktop-instrumentation/client';

/**
 * No-credits recovery funnel (CAN-4633): `billing:credits_recovery_view` when
 * a surface tells the user nothing can pay, and
 * `billing:credits_recovery_click` for the way out they pick. "Left" is a view
 * with no click, sign-in, or send within the analysis window, so it is never
 * emitted. Context is the fixed surface, trigger, and action only.
 */

const VIEW_OPERATION = 'canopy.credits_recovery';
const CLICK_OPERATION = 'canopy.credits_recovery_action';

/** Where the no-credits state was shown. */
export type CreditsRecoverySurface =
  | 'chat_banner'
  | 'turn_error'
  | 'model_recovery';

/** What raised it. */
export type CreditsRecoveryTrigger =
  | 'preflight'
  | 'failed_turn'
  | 'no_dispatchable_model'
  | 'model_select'
  | 'billing_mode_switch';

/** The way out the user picked. */
export type CreditsRecoveryAction =
  | 'drip_opt_in'
  | 'provider_sign_in'
  | 'account_sign_in'
  | 'credits_purchase'
  | 'retry'
  | 'dismiss';

/**
 * A surface that hides and reappears for the same dead end (an auth probe
 * refresh, a tab switch) is one view, not several.
 */
export const CREDITS_RECOVERY_VIEW_WINDOW_MS = 10 * 60 * 1000;
const MAX_TRACKED_VIEWS = 200;

const lastViewAt = new Map<string, number>();

/** Test seam: forget recorded views. */
export function resetCreditsRecoveryTelemetryForTests(): void {
  lastViewAt.clear();
}

function emit(
  name: typeof VIEW_OPERATION | typeof CLICK_OPERATION,
  context: Record<string, string>,
): void {
  startClientOperation(name, { context });
  succeedClientOperation(name, { context });
}

/**
 * Record that a no-credits surface was shown. `dedupeKey` names what the
 * view is about (a chat, a failure); it never leaves the renderer.
 */
export function trackCreditsRecoveryView(options: {
  surface: CreditsRecoverySurface;
  trigger: CreditsRecoveryTrigger;
  dedupeKey: string;
  now?: number;
}): void {
  const now = options.now ?? Date.now();
  const key = `${options.surface}|${options.trigger}|${options.dedupeKey}`;
  const previous = lastViewAt.get(key);
  if (
    previous !== undefined &&
    now - previous < CREDITS_RECOVERY_VIEW_WINDOW_MS
  )
    return;
  lastViewAt.delete(key);
  lastViewAt.set(key, now);
  if (lastViewAt.size > MAX_TRACKED_VIEWS) {
    const oldest = lastViewAt.keys().next();
    if (!oldest.done) lastViewAt.delete(oldest.value);
  }
  emit(VIEW_OPERATION, {
    recovery_surface: options.surface,
    recovery_trigger: options.trigger,
  });
}

/** Record the recovery action the user clicked. */
export function trackCreditsRecoveryClick(options: {
  surface: CreditsRecoverySurface;
  action: CreditsRecoveryAction;
}): void {
  emit(CLICK_OPERATION, {
    recovery_surface: options.surface,
    recovery_action: options.action,
  });
}
