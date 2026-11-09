import { isOrchestratorLabel, ORCHESTRATOR_LABEL } from '@canopy/protocol';
import { brandText } from '@/lib/brand';
import type { AppError } from '@canopy/protocol/app-errors';
import { captureToastFailure } from '@/lib/renderer-app-error';
import {
  maybeFireOsNotification,
  shouldShowInAppNotification,
  toastCategoryLabel,
} from '@/lib/osNotifications';
import {
  createToastQueue,
  recordSurfacedError,
  toastQueueLifetimeMs,
  type ToastFailure,
  type ToastOrigin,
  type ToastType,
} from '@canopy/ui-shared/lib';
import type { ReactNode } from 'react';
import { create } from 'zustand';
import {
  isScopedNotificationDeliverable,
  type ScopedNotificationDescriptor,
} from './spaceNotificationStore';

export type ToastCategory =
  | 'Chat'
  | 'Script'
  | 'Hook'
  | 'Git Commit'
  | 'Git Push'
  | 'Git Pull'
  | 'Git Merge'
  | 'PR Create'
  | 'Split PR'
  | 'Pipeline'
  | 'Worktree'
  | 'Terminal'
  | 'Automation'
  | 'GitHub'
  | 'Run Comment'
  // Sign-in / account state changes. Deliberately absent from
  // `CATEGORY_TO_PREF_KEY` in `lib/osNotifications.ts`: signing in happens with
  // the app in the foreground, so a native banner would be pure noise.
  | 'Account'
  // Activity-sharing changes applied by a plan transition (paid ⇄ free).
  // Unmapped in `CATEGORY_TO_PREF_KEY` for the same reason as `Account`: the
  // in-app toast carries the action, and a native banner cannot.
  | 'Privacy';

/**
 * A shareable link surfaced on a toast/notification (e.g. after sharing a plan
 * or a run) so the user can copy or open it without hunting for the URL.
 */
export interface ToastLink {
  /** The full, shareable URL. Copied only by a click on Copy link. */
  url: string;
  /**
   * The URL is a page of the signed-in cloud account (a share it just made):
   * Open signs the browser in to that account first, as other account pages
   * do. Copy link still copies the plain URL.
   */
  signedIn?: boolean;
}

/**
 * A single labeled recovery action on a toast. Rendered with the shared
 * `NoticeButton` styling so it reads as the same family as inline notices.
 * Session-scoped: the handler lives only as long as the running renderer.
 */
export interface ToastAction {
  label: ReactNode;
  /**
   * Runs the action. Return a promise for work that takes a while (`Try
   * again` on a failed action): the button spins inside its capsule until it
   * settles, then the toast closes.
   */
  onClick: () => unknown;
  /** The label while a returned promise runs (`Trying again…`). */
  busyLabel?: string;
}

export interface ToastMeta {
  /** A short closing sentence kept visible below the compact message preview. */
  messageContext?: string;
  category?: ToastCategory;
  workspaceName?: string;
  projectId?: string;
  worktreeId?: string;
  chatId?: string;
  /**
   * Optional shareable link surfaced as copy/open actions on the toast and its
   * detail modal. Set by share flows so the "shared" notification carries the
   * link the user needs to actually share the resource.
   */
  link?: ToastLink;
  /**
   * Display-only bold lead rendered in place of `category` on the toast and in
   * its detail modal. Lets a toast carry a headline ("Sign in successful")
   * while `category` stays the routing/preference key.
   */
  title?: string;
  /**
   * Optional labeled recovery action rendered on the toast and in its detail
   * modal. Use it when the toast explains a blocked outcome the user can undo
   * in one step (e.g. turning off "Only allow local sites").
   */
  action?: ToastAction;
  /** Use an extended one-minute lifetime instead of the default 15 seconds. */
  persistent?: boolean;
  /** Transactional offer: available until use, explicit dismissal or invalidation. */
  keepUntilDismissed?: boolean;
  /**
   * Deliver this in-app even when the in-app notification master toggle is
   * disabled. Reserve for transactional outcomes that would otherwise have no
   * visible confirmation or recovery signal after their originating surface
   * closes. Share toasts set it: a share dialog closes on success, so its
   * toast is feedback to the click rather than a notification, and must show
   * even with in-app notifications off.
   */
  forceInApp?: boolean;
  /**
   * Never raise a native OS banner for this toast. Share toasts set it with
   * `forceInApp`: the user just clicked Share with the app in the foreground,
   * so a banner would be noise, like the `Account` and `Privacy` categories.
   */
  suppressOsNotification?: boolean;
  /**
   * Body for the native OS banner when it should differ from the toast
   * message. A chat toast's headline names its worktree, so its message
   * leaves the branch out; the native banner has no such headline and keeps
   * it here.
   */
  osNotificationBody?: string;
  /**
   * Block the message from session replay. Set when the message names a
   * person (for example "Invited {name}"); other messages are recorded unless
   * `toastMessageReplayClass` blocks their type or category.
   */
  blockMessageFromReplay?: boolean;
  /**
   * The chat or pipeline occurrence this toast reports (CAN-3615). When its
   * space's notification choice does not allow it, the toast is still
   * recorded in notification history but raises no popup and no native
   * banner.
   */
  notificationScope?: ScopedNotificationDescriptor;
  /**
   * The toast reports a finished chat turn or pipeline run. Passed to the OS
   * notification gate, where it can arm the one-time notification offer
   * (CAN-4005) while notifications are off.
   */
  agentCompletion?: boolean;
}

export interface Toast {
  id: string;
  message: string;
  type: ToastType;
  onClick?: () => void;
  onDismiss?: () => void;
  createdAt: number;
  meta?: ToastMeta;
  /** A visible toast with the same key is replaced; see {@link clearFailureToast}. */
  key?: string;
  /** Set by {@link addFailureToast}. */
  failure?: ToastFailure;
}

export type Notification = Toast;

/**
 * Maximum number of unread notifications retained for the overview
 * notifications panel. Older notifications are evicted when new ones arrive.
 */
const MAX_NOTIFICATIONS = 50;
// Legacy uncategorized toasts are primarily pipeline/action feedback. Route
// them through the Pipeline preference instead of silently skipping OS alerts.
const UNCATEGORIZED_TOAST_CATEGORY: ToastCategory = 'Pipeline';

/** How long a toast stays on screen. */
const TOAST_LIFETIME_MS = 15_000;
/** How long a `meta.persistent` toast stays on screen. */
const PERSISTENT_TOAST_LIFETIME_MS = 60_000;

/**
 * A toast's on-screen lifetime: a failure stays until it is closed, a success
 * leaves after 6 s, and a `meta.persistent` toast stays a minute.
 */
export function toastLifetimeMs(toast: Pick<Toast, 'meta' | 'type'>): number {
  return toastQueueLifetimeMs(
    toast.type,
    TOAST_LIFETIME_MS,
    toast.meta?.keepUntilDismissed === true
      ? 0
      : toast.meta?.persistent === true
        ? PERSISTENT_TOAST_LIFETIME_MS
        : undefined,
  );
}

// The window's visible toasts. Private so that every addition passes the
// notification gate and every removal keeps history right.
const queue = createToastQueue<Omit<Toast, 'id'>>();

/** Read access to the visible stack, for `useSyncExternalStore`. */
export const toastStack = {
  subscribe: queue.subscribe,
  getSnapshot: queue.getSnapshot,
};

/** Empties the visible stack. History stays and no dismiss callback runs. */
export function resetToastStack(): void {
  queue.reset();
}

interface ToastHistoryState {
  notifications: Notification[];
  /** Remove a toast from the visible stack AND mark it as read (user clicked X). */
  dismissToast: (id: string) => void;
  /**
   * Remove a toast from the visible stack only, as running out of time does:
   * it stays in notification history and its `onDismiss` does not run. The
   * early-access notification stack calls it when a toast expires or is
   * swiped away.
   */
  expireToast: (id: string) => void;
  /** Remove a notification from the overview's unread list. */
  dismissNotification: (id: string) => void;
}

export const useToastStore = create<ToastHistoryState>((set, get) => ({
  notifications: [],
  dismissToast: (id): void => {
    const toast =
      toastStack.getSnapshot().find((entry) => entry.id === id) ??
      get().notifications.find((entry) => entry.id === id);
    toast?.onDismiss?.();
    queue.dismiss(id);
    set((state) => ({
      notifications: state.notifications.filter((n) => n.id !== id),
    }));
  },
  expireToast: (id): void => {
    queue.dismiss(id);
  },
  dismissNotification: (id): void => {
    const notification = get().notifications.find((entry) => entry.id === id);
    notification?.onDismiss?.();
    set((state) => ({
      notifications: state.notifications.filter((n) => n.id !== id),
    }));
  },
}));

let toastCounter = 0;

/** The stack and history keep separate copies; dismissing runs this once. */
function runOnce(callback: () => void): () => void {
  let ran = false;
  return (): void => {
    if (ran) return;
    ran = true;
    callback();
  };
}

function createToastEntry(
  message: string,
  type: ToastType,
  onClick: (() => void) | undefined,
  meta: ToastMeta | undefined,
  onDismiss: (() => void) | undefined,
): Toast {
  return {
    id: `toast-${++toastCounter}`,
    message,
    type,
    onClick,
    onDismiss: onDismiss && runOnce(onDismiss),
    createdAt: Date.now(),
    meta,
  };
}

interface ToastGate {
  category: ToastCategory;
  showInApp: boolean;
  deliverable: boolean;
}

function readToastGate(meta: ToastMeta | undefined): ToastGate {
  const category = meta?.category ?? UNCATEGORIZED_TOAST_CATEGORY;
  const scope = meta?.notificationScope;
  return {
    category,
    showInApp:
      meta?.forceInApp === true || shouldShowInAppNotification(category),
    deliverable: !scope || isScopedNotificationDeliverable(scope),
  };
}

function rememberNotification(entry: Toast): void {
  useToastStore.setState((state) => ({
    notifications: [entry, ...state.notifications].slice(0, MAX_NOTIFICATIONS),
  }));
}

function deliverToast(
  entry: Toast,
  { category, showInApp, deliverable }: ToastGate,
): void {
  if (!deliverable) {
    // Recording is unchanged: history keeps exactly what it would have
    // held, with no popup, timer, or native banner.
    if (showInApp) rememberNotification(entry);
    return;
  }
  if (showInApp) {
    rememberNotification(entry);
    queue.add(entry);
    // ToastStack owns expiry and pauses its clock on hover or in the background.
  }
  if (entry.meta?.suppressOsNotification === true) return;
  maybeFireOsNotification({
    title:
      // Orchestrator chat toasts carry no projectId (getChatToastAttribution);
      // project chat toasts always do, so a project named "Orchestrator"
      // keeps its chat title.
      category === 'Chat' &&
      entry.meta?.projectId === undefined &&
      isOrchestratorLabel(entry.meta?.workspaceName)
        ? ORCHESTRATOR_LABEL
        : (entry.meta?.title ??
          (entry.meta?.category === undefined
            ? brandText.appName
            : toastCategoryLabel(entry.meta.category))),
    body: entry.meta?.osNotificationBody ?? entry.message,
    category,
    toastId: entry.id,
    projectId: entry.meta?.projectId,
    worktreeId: entry.meta?.worktreeId,
    chatId: entry.meta?.chatId,
    onClick: entry.onClick,
    ...(entry.meta?.agentCompletion === true ? { agentCompletion: true } : {}),
  });
}

/** Raises a toast, subject to the person's notification choices. */
export function addToast(
  message: string,
  type: ToastType,
  onClick?: () => void,
  meta?: ToastMeta,
  onDismiss?: () => void,
): void {
  const gate = readToastGate(meta);
  const entry = createToastEntry(message, type, onClick, meta, onDismiss);
  if (type === 'error') {
    recordSurfacedError({
      chokePoint: 'toast',
      // Not the routing default above: a missing category stays visible.
      identifier: meta?.category ?? 'uncategorized',
      // Omitted when no popup shows, so nothing claims it was displayed.
      ...(gate.deliverable && gate.showInApp
        ? { surface: 'toast' as const }
        : {}),
      text: message,
      // Every error toast is blocked from replay (toastMessageReplayClass);
      // showing it locally does not clear it for export.
      textIsSensitive: true,
    });
  }
  deliverToast(entry, gate);
}

export interface FailureToastInput {
  /** The card's text. `error` supplies classification, not copy. */
  message: string;
  error: AppError;
  origin: ToastOrigin;
  /**
   * Replaces the visible failure with this key, and lets
   * {@link clearFailureToast} take it down. Only for stable identities whose
   * events can tell a newer success from a stale one; never a display name.
   */
  key?: string;
  meta?: ToastMeta;
}

/**
 * The sanctioned error toast: a failure with no on-screen origin, raised while
 * the person is elsewhere. It stays until dismissed or cleared and links to
 * where it happened. The error ratchet detects every call
 * (docs/design/feedback.md#legacy-error-ratchet).
 */
export function addFailureToast({
  message,
  error,
  origin,
  key,
  meta,
}: FailureToastInput): void {
  const gate = readToastGate(meta);
  const { error: recorded, telemetry } = captureToastFailure(
    error,
    // Not the routing default: a missing category stays visible.
    meta?.category ?? 'uncategorized',
    gate.deliverable && gate.showInApp,
  );
  deliverToast(
    {
      ...createToastEntry(message, 'error', origin.open, meta, undefined),
      ...(key === undefined ? {} : { key }),
      failure: {
        error: recorded,
        origin,
        ...(telemetry === undefined ? {} : { telemetry }),
      },
    },
    gate,
  );
}

/** The failure's condition cleared. History stays and no callback runs. */
export function clearFailureToast(key: string): void {
  queue.dismissKey(key);
}
