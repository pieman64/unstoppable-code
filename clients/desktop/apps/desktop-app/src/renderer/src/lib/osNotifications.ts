import { CHAT_UNIT_LABEL } from '@canopy/protocol';
import { WORKFLOW_ITEM_LABEL } from '@canopy/ui-shared/lib/workflow-labels';
import type {
  InAppNotificationPlacement,
  InAppNotificationPreferences,
  NotificationCategoryKey,
  OsNotificationCategorySound,
  OsNotificationClickEvent,
  OsNotificationCloseEvent,
  OsNotificationNamedSound,
  OsNotificationPreferences,
  OsNotificationTopLevelSound,
} from '@canopy/desktop-shared/types';
import type { ToastCategory } from '@/stores/githubStore';
import { brandText } from '@/lib/brand';
import { noteOsNotificationOfferCompletion } from '@/lib/osNotificationOffer';

/**
 * Maps the display-string `ToastCategory` values to the boolean keys in
 * `OsNotificationPreferences.categories`. A `ToastCategory` without an entry
 * here (currently `Automation`, which has no dedicated preference category,
 * and `Account`, which is deliberately unmapped so a sign-in completed inside
 * the app never fires a native banner) has no per-category toggle in the
 * notification settings, so the two surfaces treat it differently:
 *
 * - OS notifications fail closed: `maybeFireOsNotification` never fires
 *   without an explicit opt-in category, because native notifications are
 *   intrusive and must not be smuggled through an unrelated category's
 *   preference (e.g. gating automation toasts behind the "Workflow" toggle).
 * - In-app notifications fall back to the master toggle only:
 *   `shouldShowInAppNotification` returns `prefs.enabled`, so the toast
 *   still renders in-app (githubStore's `addToast` gates toast rendering on
 *   this check — failing closed here would silently swallow the toast
 *   entirely).
 *
 * Share toasts (`lib/share-toast.ts`) bypass both gates through `ToastMeta`
 * instead of a category: `forceInApp` shows them with in-app notifications
 * off, because the share dialog closes on success and the toast is the only
 * confirmation of the click, and `suppressOsNotification` keeps them from
 * ever raising a native banner, for the same reason as `Account`.
 */
const CATEGORY_TO_PREF_KEY: Partial<
  Record<ToastCategory, NotificationCategoryKey>
> = {
  Chat: 'chat',
  Script: 'script',
  Hook: 'hook',
  'Git Commit': 'gitCommit',
  'Git Push': 'gitPush',
  'Git Pull': 'gitPush',
  'Git Merge': 'gitCommit',
  'PR Create': 'prCreate',
  // A Split PR is a PR-creation flow; reuse the `prCreate` opt-in rather than
  // introducing a separate preference key (same many-to-one precedent as
  // `Git Push`/`Git Pull` → `gitPush`).
  'Split PR': 'prCreate',
  Pipeline: 'pipeline',
  Terminal: 'terminal',
  // Somebody else commented on a run you shared (CAN-397). Its own opt-in:
  // this is another person's activity on a finished session, not your agent.
  'Run Comment': 'runComment',
};

export interface OsNotificationPayload {
  title: string;
  body: string;
  category?: ToastCategory;
  toastId?: string;
  projectId?: string;
  worktreeId?: string;
  chatId?: string;
  onClick?: () => void;
  /**
   * Direct silent/sound overrides. When provided, they bypass the
   * preference-driven sound resolution. Used by the test-notification
   * buttons in the settings UI which need to preview an arbitrary sound.
   */
  silent?: boolean;
  sound?: OsNotificationNamedSound;
  /**
   * Set by the chat-turn and pipeline-run completion producers only. A
   * completion withheld because notifications are off can arm the one-time
   * notification offer (CAN-4005); progress, approvals, and questions never do.
   */
  agentCompletion?: boolean;
  /**
   * Whether the notification's content is on screen, for payloads the chat
   * ids cannot place, such as App Advisor's. Overrides the visible-context
   * check behind `skipWhenFocused`.
   */
  visible?: boolean;
}

/**
 * The text a toast category renders as. `ToastCategory` values double as
 * display strings, but the `Pipeline` member (kept as an identifier because it
 * keys the `pipeline` preference) reads as the workflow item noun (CAN-4651).
 */
export function toastCategoryLabel(category: ToastCategory): string {
  return category === 'Pipeline' ? WORKFLOW_ITEM_LABEL : category;
}

/** Categories whose completions can arm the notification offer. */
const OFFER_CATEGORIES: ReadonlySet<ToastCategory> = new Set<ToastCategory>([
  'Chat',
  'Pipeline',
]);

interface ResolvedSound {
  silent: boolean;
  sound?: OsNotificationNamedSound;
}

function resolveSoundFromTopLevel(
  value: OsNotificationTopLevelSound,
): ResolvedSound {
  if (value === 'None') return { silent: true };
  if (value === 'System') return { silent: false };
  return { silent: false, sound: value };
}

function resolveCategorySound(
  prefs: OsNotificationPreferences,
  categoryKey: keyof OsNotificationPreferences['categorySounds'],
): ResolvedSound {
  const raw: OsNotificationCategorySound = prefs.categorySounds[categoryKey];
  if (raw === 'Default') {
    return resolveSoundFromTopLevel(prefs.defaultSound);
  }
  return resolveSoundFromTopLevel(raw);
}

export interface OsNotificationNavigationTarget {
  projectId: string;
  worktreeId: string;
  chatId?: string;
}

interface VisibleContext {
  worktreeKey: string | null;
  chatId: string | null;
}

interface PendingNotification {
  onClick?: () => void;
  navigationTarget: OsNotificationNavigationTarget | null;
  firedAt: number;
}

// Module-level state. The helper is a pure consumer of these values; producers
// (chatStore subscriber, NotificationsTab after save, App.tsx startup) push
// updates via the exported setters below. This avoids a render-store dependency
// cycle (chatStore -> githubStore -> osNotifications -> chatStore).
let cachedOsPreferences: OsNotificationPreferences | null = null;
let cachedInAppPreferences: InAppNotificationPreferences | null = null;
let visibleContext: VisibleContext = { worktreeKey: null, chatId: null };
let navigationHandler:
  | ((target: OsNotificationNavigationTarget) => void)
  | null = null;
const inAppNotificationListeners = new Set<() => void>();

// Outstanding notifications awaiting a click or close event from the main
// process. Keyed by a client-generated id. Entries are removed on click or
// close, and a TTL sweep catches any events the OS never delivered.
const pendingNotifications = new Map<string, PendingNotification>();
const PENDING_TTL_MS = 5 * 60 * 1000;
let pendingSweepTimer: ReturnType<typeof setInterval> | null = null;
let clickListenerUnsubscribe: (() => void) | null = null;
let closeListenerUnsubscribe: (() => void) | null = null;
let notificationCounter = 0;

function generateNotificationId(): string {
  notificationCounter += 1;
  return `osn-${Date.now()}-${notificationCounter}`;
}

function sweepPending(): void {
  const now = Date.now();
  const expiredIds: string[] = [];
  pendingNotifications.forEach((entry, id) => {
    if (now - entry.firedAt > PENDING_TTL_MS) {
      expiredIds.push(id);
    }
  });
  for (const id of expiredIds) {
    pendingNotifications.delete(id);
  }
  if (pendingNotifications.size === 0 && pendingSweepTimer) {
    clearInterval(pendingSweepTimer);
    pendingSweepTimer = null;
  }
}

function ensureSweepTimer(): void {
  if (pendingSweepTimer || typeof setInterval === 'undefined') return;
  pendingSweepTimer = setInterval(sweepPending, PENDING_TTL_MS);
  // Browser timers are numeric, but Jest supplies Node timers. Do not let this
  // best-effort stale-entry sweep keep a Node-backed renderer test alive.
  if (
    typeof pendingSweepTimer === 'object' &&
    'unref' in pendingSweepTimer &&
    typeof pendingSweepTimer.unref === 'function'
  ) {
    pendingSweepTimer.unref();
  }
}

function ensureEventSubscriptions(): void {
  if (typeof window === 'undefined' || !window.api) return;

  if (!clickListenerUnsubscribe && window.api.onOsNotificationClicked) {
    clickListenerUnsubscribe = window.api.onOsNotificationClicked(
      (event: OsNotificationClickEvent) => {
        const entry = pendingNotifications.get(event.id);
        if (!entry) return;
        pendingNotifications.delete(event.id);
        if (entry.onClick) {
          entry.onClick();
          return;
        }
        if (entry.navigationTarget) {
          navigationHandler?.(entry.navigationTarget);
        }
      },
    );
  }

  if (!closeListenerUnsubscribe && window.api.onOsNotificationClosed) {
    closeListenerUnsubscribe = window.api.onOsNotificationClosed(
      (event: OsNotificationCloseEvent) => {
        pendingNotifications.delete(event.id);
      },
    );
  }
}

/**
 * Update the cached preferences after the user saves from
 * `NotificationsTab`, and from `App.tsx` startup preference loading. Called
 * synchronously so subsequent toasts see the latest value without a round-trip.
 */
export function refreshOsNotificationPrefs(
  next: OsNotificationPreferences,
): void {
  cachedOsPreferences = next;
}

export function refreshInAppNotificationPrefs(
  next: InAppNotificationPreferences,
): void {
  cachedInAppPreferences = next;
  inAppNotificationListeners.forEach((listener) => {
    listener();
  });
}

export function subscribeToInAppNotificationPrefs(
  listener: () => void,
): () => void {
  inAppNotificationListeners.add(listener);
  return (): void => {
    inAppNotificationListeners.delete(listener);
  };
}

/**
 * The corner the user picked, or `undefined` for the app's default. Windows
 * resolve the default with `useInAppNotificationPlacement`.
 */
export function getInAppNotificationPlacement():
  | InAppNotificationPlacement
  | undefined {
  return cachedInAppPreferences?.placement;
}

export function shouldShowInAppNotification(category: ToastCategory): boolean {
  const prefs = cachedInAppPreferences;
  if (!prefs?.enabled) return false;

  // Categories without a preference key (see CATEGORY_TO_PREF_KEY) have no
  // per-category toggle; only the in-app master toggle gates them. This must
  // NOT fail closed: githubStore's addToast renders the in-app toast only
  // when this returns true, so failing closed would swallow the toast.
  const prefKey = CATEGORY_TO_PREF_KEY[category];
  if (!prefKey) return true;

  return prefs.categories[prefKey];
}

/**
 * Called from a chatStore subscriber whenever the selected worktree or the
 * active tab within the selected worktree changes. The helper does NOT import
 * chatStore; chatStore pushes the value in. `worktreeKey` is formatted as
 * `${projectId}/${worktreeId}` by the producer, matching the format used for
 * payload comparisons.
 */
export function setVisibleContext(
  worktreeKey: string | null,
  chatId: string | null,
): void {
  visibleContext = { worktreeKey, chatId };
}

/**
 * True when the given `${projectId}/${worktreeId}` key is the worktree the user
 * is currently viewing (the same "visible context" that suppresses OS
 * notifications for the active chat). Consumers use this to suppress in-app
 * activity toasts for a worktree that is already in the foreground.
 */
export function isWorktreeKeyVisible(worktreeKey: string): boolean {
  return visibleContext.worktreeKey === worktreeKey;
}

export function setOsNotificationNavigationHandler(
  handler: ((target: OsNotificationNavigationTarget) => void) | null,
): void {
  navigationHandler = handler;
}

function composePayloadWorktreeKey(
  payload: OsNotificationPayload,
): string | null {
  if (payload.projectId && payload.worktreeId) {
    return `${payload.projectId}/${payload.worktreeId}`;
  }
  return null;
}

function isAlreadyVisible(payload: OsNotificationPayload): boolean {
  if (payload.visible !== undefined) return payload.visible;
  const payloadWorktreeKey = composePayloadWorktreeKey(payload);

  if (payload.chatId) {
    return (
      visibleContext.chatId === payload.chatId &&
      visibleContext.worktreeKey === payloadWorktreeKey
    );
  }

  if (payloadWorktreeKey) {
    return visibleContext.worktreeKey === payloadWorktreeKey;
  }

  return true;
}

function buildNavigationTarget(
  payload: OsNotificationPayload,
): OsNotificationNavigationTarget | null {
  if (!payload.projectId || !payload.worktreeId) return null;
  return {
    projectId: payload.projectId,
    worktreeId: payload.worktreeId,
    chatId: payload.chatId,
  };
}

function isWindowFocused(): boolean {
  if (typeof document === 'undefined') return false;
  return typeof document.hasFocus === 'function' ? document.hasFocus() : false;
}

/**
 * A completion that would have raised a banner if the master toggle were on.
 * Only the main window arms the offer; auxiliary windows never do.
 */
function noteWithheldCompletion(
  payload: OsNotificationPayload,
  prefs: OsNotificationPreferences,
): void {
  if (payload.agentCompletion !== true) return;
  const category = payload.category;
  if (!category || !OFFER_CATEGORIES.has(category)) return;
  const prefKey = CATEGORY_TO_PREF_KEY[category];
  if (!prefKey || !prefs.categories[prefKey]) return;
  if (typeof document === 'undefined') return;
  if (document.body.dataset.rendererSurface !== 'main') return;
  noteOsNotificationOfferCompletion(isWindowFocused());
}

/**
 * Central helper called from the toast dispatcher and the chat-activity path.
 * Enforces the preference gates (master, category, focus/context) and only
 * dispatches the IPC show request when every gate passes. The main process
 * creates the native `Notification` via `electron`'s `Notification` class,
 * which properly integrates with the macOS Notification Center permission
 * flow.
 *
 * Gate order (any failure returns without firing):
 *   1. IPC surface missing (non-Electron / tests without preload).
 *   2. Preference cache missing or master toggle off. With the master toggle
 *      off, an agent completion may arm the notification offer instead.
 *   3. Category missing/unknown or category toggle off.
 *   4. Focus-context match (only when `skipWhenFocused` is true AND the
 *      window is focused).
 */
export function maybeFireOsNotification(payload: OsNotificationPayload): void {
  if (typeof window === 'undefined' || !window.api?.showOsNotification) {
    return;
  }

  const prefs = cachedOsPreferences;
  if (!prefs) return;
  if (!prefs.enabled) {
    noteWithheldCompletion(payload, prefs);
    return;
  }

  const category = payload.category;
  if (!category) return;

  const prefKey = CATEGORY_TO_PREF_KEY[category];
  if (!prefKey) return;
  if (!prefs.categories[prefKey]) return;

  if (prefs.skipWhenFocused && isWindowFocused() && isAlreadyVisible(payload)) {
    return;
  }

  ensureEventSubscriptions();
  ensureSweepTimer();

  const id = payload.toastId ?? generateNotificationId();
  pendingNotifications.set(id, {
    onClick: payload.onClick,
    navigationTarget: buildNavigationTarget(payload),
    firedAt: Date.now(),
  });

  // Payload-level overrides win; otherwise resolve from preferences.
  const explicitSilent = payload.silent;
  const explicitSound = payload.sound;
  const resolved: ResolvedSound =
    explicitSilent !== undefined || explicitSound !== undefined
      ? { silent: explicitSilent ?? false, sound: explicitSound }
      : resolveCategorySound(prefs, prefKey);

  void window.api
    .showOsNotification({
      id,
      title: payload.title,
      body: payload.body,
      silent: resolved.silent,
      ...(resolved.sound ? { sound: resolved.sound } : {}),
    })
    .then((response) => {
      if (!response.shown) {
        pendingNotifications.delete(id);
      }
    })
    .catch(() => {
      pendingNotifications.delete(id);
    });
}

export interface FireTestOsNotificationOptions {
  /**
   * When provided, resolve the sound for this category (honoring the
   * Default/None/system-sound settings). When absent, the top-level
   * defaultSound is used.
   */
  categoryKey?: keyof OsNotificationPreferences['categorySounds'];
  /**
   * Used to override the audible feedback directly, bypassing preference
   * lookup. Useful when previewing a sound choice from the settings UI
   * before the user has saved it.
   */
  soundOverride?: OsNotificationCategorySound;
  title?: string;
  body?: string;
}

const CATEGORY_LABELS: Record<
  keyof OsNotificationPreferences['categorySounds'],
  string
> = {
  chat: CHAT_UNIT_LABEL,
  script: 'Script',
  hook: 'Hook',
  gitCommit: 'Git commit',
  gitPush: 'Git push',
  prCreate: 'Create PR',
  pipeline: WORKFLOW_ITEM_LABEL,
  terminal: 'Terminal',
  runComment: 'Run comment',
  activation: 'Getting started',
};

/**
 * Fires a test notification bypassing the category/focus gates, so the user
 * can trigger the macOS Notification Center permission prompt from the
 * settings UI predictably and preview sounds per category. The master toggle
 * still gates this so we do not post unwanted alerts.
 */
export async function fireTestOsNotification(
  options: FireTestOsNotificationOptions = {},
): Promise<'unsupported' | 'disabled' | 'shown' | 'error'> {
  if (typeof window === 'undefined' || !window.api?.showOsNotification) {
    return 'unsupported';
  }

  const prefs = cachedOsPreferences;
  if (!prefs?.enabled) return 'disabled';

  ensureEventSubscriptions();
  ensureSweepTimer();

  let resolved: ResolvedSound;
  if (options.soundOverride !== undefined) {
    resolved =
      options.soundOverride === 'Default'
        ? resolveSoundFromTopLevel(prefs.defaultSound)
        : resolveSoundFromTopLevel(options.soundOverride);
  } else if (options.categoryKey) {
    resolved = resolveCategorySound(prefs, options.categoryKey);
  } else {
    resolved = resolveSoundFromTopLevel(prefs.defaultSound);
  }

  const title =
    options.title ??
    (options.categoryKey
      ? `${brandText.appName} — ${CATEGORY_LABELS[options.categoryKey]}`
      : brandText.appName);
  const body =
    options.body ??
    (options.categoryKey
      ? `Test ${CATEGORY_LABELS[options.categoryKey]} notification.`
      : 'Notifications are working. You will be alerted when enabled events occur.');

  const id = generateNotificationId();
  pendingNotifications.set(id, {
    navigationTarget: null,
    firedAt: Date.now(),
  });

  try {
    const response = await window.api.showOsNotification({
      id,
      title,
      body,
      silent: resolved.silent,
      ...(resolved.sound ? { sound: resolved.sound } : {}),
    });
    if (!response.shown) {
      pendingNotifications.delete(id);
      return response.reason === 'unsupported' ? 'unsupported' : 'error';
    }
    return 'shown';
  } catch {
    pendingNotifications.delete(id);
    return 'error';
  }
}
