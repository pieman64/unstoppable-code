import { create } from 'zustand';
import type { AiCreditsScopeRequest } from '@canopy/desktop-shared/types';
import { succeedClientOperation } from '@canopy/desktop-instrumentation/client';
import {
  isBillingIntentIdentifier,
  isModelLibraryUnlockSource,
  type ModelLibraryUnlockSource,
} from '@canopy/protocol/billing';
import type { DesktopBillingDeepLink } from '@canopy/protocol/billing';
import { announceAiCreditsChanged } from '@/lib/aiCreditsChanged';
import {
  refreshModelLibraryAccess,
  type ModelLibraryAccessRead,
} from '@/lib/modelLibraryAccess';
import type { PersonalBalanceReading } from '@/lib/aiCreditsConfirmationBalance';

/**
 * The pending "unlock advanced models" purchase (CAN-4028).
 *
 * Checkout happens in the browser, so the desktop has to remember what the
 * user was trying to do, notice when the server says the account is unlocked,
 * and then finish the job. This module is that memory and that decision.
 *
 * Three rules shape everything below:
 *
 *  1. **Only an authoritative server read unlocks anything.** A return link,
 *     a window focus, and the poll timer are all just reasons to ask again.
 *     None of them carries authority, and a retained (last-known) value never
 *     confirms a payment.
 *  2. **The pending model is applied at most once**, and only while the
 *     account, the owner, the chat's selection, and this exact request are
 *     all still what they were when checkout opened. A newer manual selection
 *     or a newer intent always wins.
 *  3. **Nothing is resent.** Unlocking changes what can be selected; the user
 *     sends their own message, through the normal send path.
 *
 * Bounded to ONE intent. A second purchase attempt replaces the first, which
 * is what makes "never over a newer intent" structural.
 */

export interface PendingModelUnlockIntent {
  /** Satisfies `isBillingRequestId`; also names this attempt in the link. */
  readonly requestId: string;
  /** Account identity checkout was opened for. */
  readonly accountId: string;
  /** Billing owner checkout was opened for; the bound refresh reads this owner. */
  readonly owner: string;
  readonly chatId: string | null;
  /** Originating work identity; chat ids can repeat across renderer sessions. */
  readonly scope?: AiCreditsScopeRequest;
  readonly modelId: string | null;
  readonly startedAt: number;
  readonly source?: ModelLibraryUnlockSource;
  /**
   * The buyer's balance read before checkout opened, when that read finished
   * first. Lets the confirmation name the credits added (CAN-5160).
   */
  readonly startingBalance?: PersonalBalanceReading;
}

/**
 * - `waiting`: checkout is open in the browser and the poll loop is running.
 * - `timed-out`: the poll loop stopped. NOT a payment failure — the payment
 *   may still complete — so the user is offered a re-check and a reopen.
 * - `applying`: unlock confirmed, the pending model is being applied.
 * - `unlocked`: confirmed, and nothing further is owed to the user.
 * - `apply-failed`: confirmed, but the pending model did not land. The unlock
 *   stands; only the selection is offered again.
 */
export type ModelUnlockPhase =
  | 'waiting'
  | 'timed-out'
  | 'applying'
  | 'unlocked'
  | 'apply-failed';

/**
 * Behavior bound to the surface that started the intent. Kept out of the
 * store because none of it is serializable, and because a handler must die
 * with the intent it belongs to.
 */
export interface ModelUnlockIntentHandlers {
  /**
   * Apply the pending model through the surface's normal model-change path
   * and report whether it landed. Absent when there is no model to apply (a
   * transcript notice, whose chat is already on the model).
   */
  readonly apply?: () => Promise<boolean>;
  /**
   * Is applying still what the user wants? False once the chat's selection
   * moved, the chat is gone, or the model can no longer be selected.
   */
  readonly isStillWanted?: () => boolean;
  /** The billing owner right now, or null when it cannot be established. */
  readonly resolveOwner?: () => Promise<string | null>;
  readonly refreshAccess?: () => Promise<ModelLibraryAccessRead | null>;
}

interface ModelUnlockIntentState {
  readonly intent: PendingModelUnlockIntent | null;
  readonly phase: ModelUnlockPhase | null;
}

export const useModelUnlockIntentStore = create<ModelUnlockIntentState>(() => ({
  intent: null,
  phase: null,
}));

/** How often the server is asked while checkout is open. */
export const MODEL_UNLOCK_POLL_INTERVAL_MS = 3_000;
/** How long the loop runs before handing the re-check back to the user. */
export const MODEL_UNLOCK_POLL_MAX_MS = 10 * 60_000;
/** Ceiling for the failed-read backoff. */
export const MODEL_UNLOCK_POLL_MAX_BACKOFF_MS = 30_000;

let handlers: ModelUnlockIntentHandlers = {};
let confirmedListener: ((intent: PendingModelUnlockIntent) => void) | null =
  null;

/**
 * Called once per intent when its unlock is confirmed, whichever of the poll,
 * a focus, or a return link got there first, and before the pending model is
 * applied. The app root uses it for the confirmation toast and the in-chat
 * confirmation (CAN-5027).
 */
export function setModelUnlockConfirmedListener(
  listener: ((intent: PendingModelUnlockIntent) => void) | null,
): void {
  confirmedListener = listener;
}

function isCurrent(requestId: string): boolean {
  return useModelUnlockIntentStore.getState().intent?.requestId === requestId;
}

/** Remember a checkout that was just opened. Replaces any earlier intent. */
export function beginModelUnlockIntent(
  intent: PendingModelUnlockIntent,
  intentHandlers: ModelUnlockIntentHandlers = {},
): void {
  handlers = intentHandlers;
  useModelUnlockIntentStore.setState({ intent, phase: 'waiting' });
  succeedClientOperation('canopy.model_recovery', {
    context: {
      recovery_source: isModelLibraryUnlockSource(intent.source)
        ? intent.source
        : 'desktop',
      ...(isBillingIntentIdentifier(intent.modelId)
        ? { model_id: intent.modelId }
        : {}),
      library_access: 'needs_purchase',
    },
  });
}

/**
 * Forget the intent. With a `requestId`, only that intent is cleared, so a
 * surface dismissing its own finished attempt cannot cancel a newer one.
 */
export function clearModelUnlockIntent(requestId?: string): void {
  if (requestId !== undefined && !isCurrent(requestId)) return;
  handlers = {};
  useModelUnlockIntentStore.setState({ intent: null, phase: null });
}

/**
 * Drop the intent if it belongs to another account. Sign-out and an account
 * switch both land here: the purchase was for someone who is no longer the
 * saved credential, and nothing about it may carry over.
 */
export function reconcileModelUnlockIntentAccount(
  accountKey: string | null,
): void {
  const { intent } = useModelUnlockIntentStore.getState();
  if (intent !== null && intent.accountId !== accountKey) {
    clearModelUnlockIntent();
  }
}

async function applyPendingModel(
  intent: PendingModelUnlockIntent,
): Promise<void> {
  const { apply, isStillWanted, resolveOwner } = handlers;
  // Latch BEFORE the first await. Every later check sees `applying` and
  // returns, which is what makes the application happen at most once even
  // when the poll and a return link confirm on the same tick.
  useModelUnlockIntentStore.setState({ phase: 'applying' });
  let applied: boolean | null = null;
  if (apply !== undefined) {
    let ownerStands = true;
    if (resolveOwner !== undefined) {
      try {
        ownerStands = (await resolveOwner()) === intent.owner;
      } catch {
        ownerStands = false;
      }
    }
    // Re-checked after the owner read, which awaits: the selection may have
    // moved, or a newer intent may have replaced this one, in that window.
    if (
      ownerStands &&
      isCurrent(intent.requestId) &&
      (isStillWanted === undefined || isStillWanted())
    ) {
      try {
        applied = await apply();
      } catch {
        applied = false;
      }
    }
  }
  // A newer intent owns the store now. Leave it exactly as it is.
  if (!isCurrent(intent.requestId)) return;
  // `null` means nothing was attempted: there was no model to apply, or
  // applying is no longer wanted. The unlock itself stands either way, so only
  // a real failed attempt offers the retry.
  useModelUnlockIntentStore.setState({
    phase: applied === false ? 'apply-failed' : 'unlocked',
  });
}

async function evaluate(
  read: ModelLibraryAccessRead | null,
): Promise<'unlocked' | 'pending' | 'failed'> {
  const { intent, phase } = useModelUnlockIntentStore.getState();
  if (intent === null) return 'pending';
  if (phase !== 'waiting' && phase !== 'timed-out') return 'pending';
  if (read === null) return 'failed';
  if (read.accountKey !== intent.accountId) {
    clearModelUnlockIntent(intent.requestId);
    return 'pending';
  }
  // A scoped answer confirms only its echoed owner. Legacy personal reads
  // cannot confirm organization access.
  if (
    intent.owner !== (read.ownerKey ?? 'personal') ||
    !read.authoritative ||
    read.access !== 'unlocked'
  ) {
    return 'pending';
  }
  const applying = applyPendingModel(intent);
  succeedClientOperation('canopy.model_access', {
    context: {
      recovery_source: isModelLibraryUnlockSource(intent.source)
        ? intent.source
        : 'desktop',
      ...(isBillingIntentIdentifier(intent.modelId)
        ? { model_id: intent.modelId }
        : {}),
      library_access: 'unlocked',
    },
  });
  // Announced here rather than inside the application, so a later retry of a
  // failed selection does not confirm the same unlock a second time. The
  // credits refresh comes first and stands on its own (CAN-5026): the purchase
  // moved the balance whether or not a toast is mounted or the model lands.
  try {
    announceAiCreditsChanged();
  } catch {
    // A subscriber's failure must not strand the intent or the application.
  }
  try {
    confirmedListener?.(intent);
  } finally {
    // Preserve observer error propagation, but always settle the application
    // before this check finishes (including clearing its single-flight latch).
    await applying;
  }
  return 'unlocked';
}

let checkInFlight: Promise<'unlocked' | 'pending' | 'failed'> | null = null;

/**
 * Ask the server once and act on the answer. Single-flight, so the poll, a
 * focus, a return link, and a **Check again** press never overlap.
 */
export function checkModelUnlockNow(): Promise<
  'unlocked' | 'pending' | 'failed'
> {
  if (checkInFlight !== null) return checkInFlight;
  const requestId = useModelUnlockIntentStore.getState().intent?.requestId;
  const started = (handlers.refreshAccess ?? refreshModelLibraryAccess)()
    .then((read) =>
      requestId !== undefined && !isCurrent(requestId)
        ? ('pending' as const)
        : evaluate(read),
    )
    .finally((): void => {
      if (checkInFlight === started) checkInFlight = null;
    });
  checkInFlight = started;
  return started;
}

/**
 * A billing return link arrived.
 *
 * It never authorizes anything. A link naming the pending request is a prompt
 * to check now instead of at the next tick. Any other link — expired, replayed
 * from an earlier attempt, or hand-crafted — only refreshes access: it cannot
 * move the pending intent along, and it cannot name a model to select.
 */
export function handleBillingReturnLink(link: DesktopBillingDeepLink): void {
  const intent = useModelUnlockIntentStore.getState().intent;
  if (
    isCurrent(link.requestId) &&
    intent &&
    Date.now() - intent.startedAt < MODEL_UNLOCK_POLL_MAX_MS
  ) {
    void checkModelUnlockNow();
    return;
  }
  void refreshModelLibraryAccess();
}

/**
 * Try the pending model again after a failed application. The unlock is
 * already confirmed, so this never re-reads access.
 */
export async function retryModelUnlockApply(): Promise<boolean> {
  const { intent, phase } = useModelUnlockIntentStore.getState();
  if (intent === null || phase !== 'apply-failed') return false;
  await applyPendingModel(intent);
  return (
    isCurrent(intent.requestId) &&
    useModelUnlockIntentStore.getState().phase === 'unlocked'
  );
}

/**
 * Run the poll loop for one intent. Returns its cleanup.
 *
 * ONE loop, never overlapping: the next tick is scheduled only after the
 * previous check settles, so a slow read stretches the interval instead of
 * stacking requests. A failed read doubles the wait up to
 * {@link MODEL_UNLOCK_POLL_MAX_BACKOFF_MS}; an answered one resets it.
 *
 * The loop ends on its own when the intent completes, is replaced, or is
 * cleared, and at {@link MODEL_UNLOCK_POLL_MAX_MS} it marks the intent
 * `timed-out` and stops. The caller's cleanup covers unmount.
 */
export function runModelUnlockPolling(requestId: string): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let delay = MODEL_UNLOCK_POLL_INTERVAL_MS;

  const schedule = (): void => {
    timer = setTimeout((): void => {
      timer = null;
      void tick();
    }, delay);
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const { intent, phase } = useModelUnlockIntentStore.getState();
    if (intent?.requestId !== requestId || phase !== 'waiting') return;
    if (Date.now() - intent.startedAt >= MODEL_UNLOCK_POLL_MAX_MS) {
      useModelUnlockIntentStore.setState({ phase: 'timed-out' });
      return;
    }
    const outcome = await checkModelUnlockNow();
    if (stopped) return;
    delay =
      outcome === 'failed'
        ? Math.min(delay * 2, MODEL_UNLOCK_POLL_MAX_BACKOFF_MS)
        : MODEL_UNLOCK_POLL_INTERVAL_MS;
    const after = useModelUnlockIntentStore.getState();
    if (after.intent?.requestId === requestId && after.phase === 'waiting') {
      schedule();
    }
  };

  schedule();
  return (): void => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
  };
}
