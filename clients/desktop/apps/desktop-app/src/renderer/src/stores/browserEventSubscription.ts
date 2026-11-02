// ---------------------------------------------------------------------------
// Browser event subscription (renderer)
// ---------------------------------------------------------------------------
//
// Single global subscription to `window.api.browser.onEvent` that fans the
// main → renderer `BrowserServiceEvent` union out to the `browserStore`, the
// panel lifecycle coordinator, and the Pick & Polish attachment flow. Mounted
// once (idempotently) by Browser panel surfaces.

import type {
  BrowserEvent,
  BrowserHandoff,
  BrowserHandoffEvent,
  BrowserServiceEvent,
  BrowserSessionSnapshot,
} from '@canopy/desktop-shared/types';
import {
  ensureBrowserWorktreeHydrated,
  findWorktreeKeyForBrowser,
  isBrowserOpenCancelled,
  type OpenBrowserOptions,
  selectBrowserHandoff,
  useBrowserStore,
} from './browserStore';
import { stageBrowserElementPick } from '@/lib/browserPickAttachment';
import { requestBrowserUrlFocus } from '@/lib/browserUrlFocus';
import { requestBrowserPanel } from '@/lib/browserPanelActivation';
import { useSidebarStore } from '@/stores/sidebarStore';
import {
  getBrowserUserInteractionGeneration,
  noteBrowserUserInteraction,
} from '@/lib/browserUserInteraction';
import { useChatStore } from '@/stores/chatStore';
import { raiseLocalOnlyConflictToast } from '@/lib/localOnlyConflictToast';
import { showLinkOpenFailureToast } from '@/lib/linkOpenFailureToast';
import {
  openSettingsPathInApp,
  settingsPathOpensInApp,
} from '@/lib/navigation/settings-destinations';
import { routeBrowserFindResult } from '@/stores/browserFindController';
import { isLinkBrowserTargetAvailable } from './linkBrowserTargetReporter';
import { useSurfaceFindStore } from '@/stores/surfaceFindStore';

let unsubscribe: (() => void) | null = null;
const pendingAppLinkOpens = new Map<string, Promise<AppLinkPlacement>>();

function isCurrentBrowserEvent(event: BrowserEvent): boolean {
  if (!('browserId' in event)) return true;
  // A transfer record's owner was captured when the download started, so it
  // stays this browser's after a profile switch: accept it by browser id.
  if (event.type === 'transfer' || event.type === 'download-blocked') {
    return true;
  }
  const current = Object.values(useBrowserStore.getState().worktrees)
    .map((bucket) => bucket.browsers[event.browserId])
    .find(Boolean);
  if (!current?.profile) return true;
  const snapshotEvent =
    event.type === 'snapshot' ||
    event.type === 'load-failed' ||
    event.type === 'open-requested' ||
    event.type === 'shortcut' ||
    event.type === 'new-tab-requested';
  const generation =
    event.runtimeGeneration ??
    (snapshotEvent ? event.snapshot.profile?.runtimeGeneration : undefined);
  return (
    generation !== undefined &&
    (snapshotEvent
      ? generation >= current.profile.runtimeGeneration
      : generation === current.profile.runtimeGeneration)
  );
}

function handleBrowserEvent(event: BrowserServiceEvent): void {
  if (event.type === 'handoff-requested' || event.type === 'handoff-released') {
    // Ordered by main's handoff revision, not by runtime generation: a release
    // must apply even after its browser is gone.
    handleBrowserHandoffEvent(event);
    return;
  }
  if (!isCurrentBrowserEvent(event)) return;
  const store = useBrowserStore.getState();
  switch (event.type) {
    case 'snapshot':
    case 'load-failed':
      store.applySnapshot(event.snapshot);
      return;
    case 'open-pending':
      // Main is creating this session for an agent. Place its tab now; the
      // matching `open-requested` (or `destroyed`) event settles it.
      void revealPendingBrowser(event).catch(() => undefined);
      return;
    case 'open-requested':
      // Push handlers must never leak rejected promises into Electron's event
      // loop. The action already receives its main-process result; renderer
      // placement/rollback failures are contained here.
      trackRequestedReveal(
        event.browserId,
        revealRequestedBrowser(event).catch(() => undefined),
      );
      return;
    case 'shortcut':
      void handleBrowserShortcutEvent(event).catch(() => undefined);
      return;
    case 'new-tab-requested':
      // A page's `target="_blank"` link or `window.open` (CAN-4831). An
      // agent's popup, like its browser.open, never takes the user's focus.
      void openBrowserTab(
        event.snapshot,
        { url: event.url, browserId: event.newBrowserId },
        event.presentation === 'background'
          ? { focus: false, preserveSelection: true }
          : undefined,
      ).catch(() => undefined);
      return;
    case 'user-interaction':
      noteBrowserUserInteraction();
      return;
    case 'find-result':
      // Native find-in-page counts (CAN-3048); consumed by the find bar.
      routeBrowserFindResult(event);
      return;
    case 'app-link-open-requested':
      // Main is waiting on an acknowledgement and falls back to the system
      // browser when one never arrives, so this must never reject.
      void handleAppLinkOpenRequest(event).catch(() => undefined);
      return;
    case 'settings-link-open-requested':
      void handleSettingsLinkOpenRequest(event).catch(() => undefined);
      return;
    case 'app-link-local-only-conflict':
      raiseLocalOnlyConflictToast(event.url);
      return;
    case 'destroyed':
      pendingHandoffFocus.get(event.browserId)?.();
      // Exact-ID: remove only this browser's panel/session, without looping
      // back into another destroy request. Lazily imported so this module
      // does not pull the panel-grid graph in at subscription time.
      void import('@/lib/panels/browser-panel-activation')
        .then((activation) => {
          // A placement still queued for a layout must not place the tab of
          // a session that no longer exists.
          activation.cancelQueuedBrowserActivation(event.browserId);
        })
        .catch(() => undefined);
      void import('@/lib/panels/browser-panel-sync')
        .then((sync) => {
          if (isCurrentBrowserEvent(event))
            sync.handleBrowserDestroyedEvent(event.browserId);
        })
        .catch(() => undefined);
      // Also ends a main-driven open whose create failed.
      if (pendingAgentOpens.delete(event.browserId)) {
        destroyedAgentOpens.add(event.browserId);
        // Bounded: forget it if no reveal ever checks it.
        setTimeout(() => destroyedAgentOpens.delete(event.browserId), 60_000);
      }
      store.settleExternalBrowserOpen(event.browserId);
      return;
    case 'console':
      store.appendConsoleEntry(event.browserId, event.entry);
      return;
    case 'network':
      store.upsertNetworkEntry(event.browserId, event.entry);
      return;
    case 'recording-step':
      store.appendRecordingStep(event.browserId, event.step);
      return;
    case 'recording-state':
      store.setRecordingState(event.browserId, event.recording);
      return;
    case 'dialog-opened':
      store.setDialog(event.browserId, event.dialog);
      return;
    case 'dialog-closed':
      store.clearDialog(event.browserId, event.dialogId);
      return;
    case 'file-chooser':
      store.setFileChooser(event.browserId, event.chooser);
      return;
    case 'print-request':
      store.setPrintRequest(event.browserId, event.request);
      return;
    case 'auth-request':
      store.setAuthRequest(event.browserId, event.request);
      return;
    case 'element-picked':
      void stageBrowserElementPick(event.snapshot);
      return;
    case 'transfer':
      store.upsertTransfer(event.browserId, event.transfer);
      return;
    case 'download-blocked':
      store.noteDownloadsBlocked(event.browserId, event.blockedCount);
      return;
    default: {
      // Exhaustiveness guard: a new `BrowserEvent` variant should add a case.
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

/**
 * A browser-page hotkey forwarded by the main process (ECW-7984): the chord
 * was pressed while the native `WebContentsView` owned keyboard focus, so the
 * renderer never saw the keydown. `new-tab` creates exactly one new browser
 * tab in the same worktree context, selects it, and focuses its address bar;
 * `focus-address-bar` focuses the pressed tab's address bar;
 * `toggle-sidebar` toggles the app sidebar; `find-in-page` opens the find bar
 * in browser mode; `close-tab` closes the pressed browser's own panel (not the
 * layout's active panel, which a click into the native page may not have
 * updated) through the same path as the tab "X". `select-next-tab` /
 * `select-previous-tab` (CAN-4616) cycle from the pressed browser's own tab,
 * for the same reason. The main process already returned keyboard focus to
 * this window before emitting, except for `toggle-sidebar` and the tab-cycle
 * actions: those leave it in the page, and main hands it to this window when
 * the cycle hides the page by selecting another tab.
 */
async function handleBrowserShortcutEvent(
  event: Extract<BrowserEvent, { type: 'shortcut' }>,
): Promise<void> {
  if (event.action === 'focus-address-bar') {
    requestBrowserUrlFocus(event.browserId);
    return;
  }
  if (event.action === 'toggle-sidebar') {
    useSidebarStore.getState().toggleHidden();
    return;
  }
  // Opens the find bar in browser mode (CAN-3048). It must never fall through
  // to the new-tab path below.
  if (event.action === 'find-in-page') {
    useSurfaceFindStore.getState().openFor('browser', event.browserId);
    return;
  }
  // Closes every panel bound to this browser. It must never fall through to
  // the new-tab path below. Lazily imported so this module does not pull the
  // panel-grid graph in at subscription time.
  if (event.action === 'close-tab') {
    const [{ findBrowserPanelBindings }, { closePanelTab }] = await Promise.all(
      [
        import('@/lib/panels/browser-panel-sync'),
        import('@/lib/panels/chat-panel-sync'),
      ],
    );
    // Snapshot once: the first close can trigger the panel sync sweep and
    // mutate layouts.
    for (const { layoutKey, groupId, panelId } of findBrowserPanelBindings(
      event.browserId,
    )) {
      closePanelTab(layoutKey, groupId, panelId);
    }
    return;
  }
  // One press moves one tab, so only the first layout bound to this browser
  // cycles. It must never fall through to the new-tab path below.
  if (
    event.action === 'select-next-tab' ||
    event.action === 'select-previous-tab'
  ) {
    const [{ findBrowserPanelBindings }, { selectAdjacentPanelTab }] =
      await Promise.all([
        import('@/lib/panels/browser-panel-sync'),
        import('@/lib/panels/commands'),
      ]);
    const [binding] = findBrowserPanelBindings(event.browserId);
    if (binding !== undefined) {
      selectAdjacentPanelTab(
        binding.layoutKey,
        { groupId: binding.groupId, panelId: binding.panelId },
        event.action === 'select-next-tab' ? 'next' : 'previous',
      );
    }
    return;
  }
  if (!isCurrentBrowserEvent(event)) return;
  const browserId = await openBrowserTab(event.snapshot);
  if (browserId !== null) requestBrowserUrlFocus(browserId);
}

/**
 * Opens and selects a new tab in `opener`'s worktree. Its session is created
 * in the background; the tab is discarded when its panel cannot be placed.
 */
async function openBrowserTab(
  opener: BrowserSessionSnapshot,
  options?: OpenBrowserOptions,
  placement?: Parameters<typeof requestBrowserPanel>[4],
): Promise<string | null> {
  const { projectId, worktreeId } = opener;
  const opened = useBrowserStore
    .getState()
    .openBrowser(projectId, worktreeId, options);
  if (opened === null) return null;
  const { browserId } = opened;
  const activated = await requestBrowserPanel(
    projectId,
    worktreeId,
    browserId,
    undefined,
    placement,
  ).catch(() => false);
  if (activated) return browserId;
  const { discardOpenedBrowser } =
    await import('@/lib/panels/browser-panel-sync');
  await discardOpenedBrowser(projectId, worktreeId, browserId);
  return null;
}

/** `open-requested` reveals still placing their panel, by browser id. */
const requestedReveals = new Map<string, Promise<void>>();
/** Cancellation only; handoff authority remains in main and its store mirror. */
const pendingHandoffFocus = new Map<string, () => void>();

function trackRequestedReveal(browserId: string, reveal: Promise<void>): void {
  requestedReveals.set(browserId, reveal);
  void reveal.finally(() => {
    if (requestedReveals.get(browserId) === reveal) {
      requestedReveals.delete(browserId);
    }
  });
}

function handleBrowserHandoffEvent(event: BrowserHandoffEvent): void {
  const outcome = useBrowserStore.getState().applyBrowserHandoffEvent(event);
  // Duplicates, hydration, and releases never move focus: the user may have
  // switched away on purpose, and protection does not trap them.
  if (outcome !== 'requested' || event.type !== 'handoff-requested') return;
  void focusRequestedHandoff(event.handoff).catch(() => undefined);
}

function isHandoffAttentionCurrent(handoff: BrowserHandoff): boolean {
  const selected = useChatStore.getState().selectedWorktree;
  return (
    selected?.projectId === handoff.projectId &&
    selected.worktreeId === handoff.worktreeId &&
    selectBrowserHandoff(
      useBrowserStore.getState(),
      handoff.projectId,
      handoff.worktreeId,
    )?.handoffId === handoff.handoffId
  );
}

/**
 * Selects the handoff browser once, only in the selected worktree. Another
 * worktree's handoff stays pending attention: switching worktrees or the OS
 * window is never done for the user, and nothing is queued to steal focus
 * when they return later.
 */
async function focusRequestedHandoff(handoff: BrowserHandoff): Promise<void> {
  if (!isHandoffAttentionCurrent(handoff)) return;
  let superseded = false;
  const cancel = (): void => {
    superseded = true;
  };
  pendingHandoffFocus.get(handoff.browserId)?.();
  pendingHandoffFocus.set(handoff.browserId, cancel);
  const key = `${handoff.projectId}/${handoff.worktreeId}`;
  const interactionGeneration = getBrowserUserInteractionGeneration();
  // Observe transitions, not just the final selection: leaving and returning
  // while placement waits must not revive an old attention request.
  const unsubscribeSelection = useChatStore.subscribe((state, previous) => {
    if (
      state.selectedWorktree?.projectId !==
        previous.selectedWorktree?.projectId ||
      state.selectedWorktree?.worktreeId !==
        previous.selectedWorktree?.worktreeId ||
      state.worktreeChats[key]?.activeTabId !==
        previous.worktreeChats[key]?.activeTabId
    )
      cancel();
  });
  const onUserInput = (event: Event): void => {
    if (event.isTrusted) cancel();
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('pointerdown', onUserInput, true);
    document.addEventListener('keydown', onUserInput, true);
  }
  let expiry: ReturnType<typeof setTimeout> | undefined;
  try {
    // The matching open places the panel first, but an expired placement must
    // never turn into attention when a background worktree is mounted later.
    const placed = await Promise.race([
      Promise.resolve(requestedReveals.get(handoff.browserId)).then(() => true),
      new Promise<boolean>((resolve) => {
        expiry = setTimeout(() => resolve(false), 5_000);
      }),
    ]);
    const browser =
      useBrowserStore.getState().worktrees[key]?.browsers[handoff.browserId];
    if (
      !placed ||
      superseded ||
      !isHandoffAttentionCurrent(handoff) ||
      !browser ||
      browser.status === 'failed' ||
      browser.profile?.runtimeGeneration !== handoff.runtimeGeneration ||
      getBrowserUserInteractionGeneration() !== interactionGeneration
    )
      return;
    const sameWorktreeOrigin =
      handoff.origin.projectId === handoff.projectId &&
      handoff.origin.worktreeId === handoff.worktreeId;
    await requestBrowserPanel(
      handoff.projectId,
      handoff.worktreeId,
      handoff.browserId,
      sameWorktreeOrigin ? handoff.origin.chatTabId : undefined,
      { focus: true, queue: false },
    );
  } finally {
    if (expiry !== undefined) clearTimeout(expiry);
    unsubscribeSelection();
    if (pendingHandoffFocus.get(handoff.browserId) === cancel)
      pendingHandoffFocus.delete(handoff.browserId);
    if (typeof document !== 'undefined') {
      document.removeEventListener('pointerdown', onUserInput, true);
      document.removeEventListener('keydown', onUserInput, true);
    }
  }
}

/** Agent opens announced by `open-pending` and not yet settled. */
const pendingAgentOpens = new Set<string>();
/**
 * Agent opens destroyed before their `open-requested` reveal finished. Kept
 * until that reveal checks it, so a reveal still waiting on hydration cannot
 * register the destroyed session again.
 */
const destroyedAgentOpens = new Set<string>();

async function revealPendingBrowser(
  event: Extract<BrowserEvent, { type: 'open-pending' }>,
): Promise<void> {
  const { projectId, worktreeId, browserId } = event;
  pendingAgentOpens.add(browserId);
  useBrowserStore.getState().trackExternalBrowserOpen({
    projectId,
    worktreeId,
    browserId,
    ...(event.url !== undefined ? { url: event.url } : {}),
  });
  // Placement failure is not rolled back here: main still owns the create,
  // and its `open-requested` event retries placement with rollback.
  await requestBrowserPanel(
    projectId,
    worktreeId,
    browserId,
    event.originChatTabId,
    {
      focus: false,
      ...(event.presentation === 'background'
        ? { preserveSelection: true }
        : {}),
    },
  );
}

async function revealRequestedBrowser(
  event: Extract<BrowserEvent, { type: 'open-requested' }>,
): Promise<void> {
  // Register the pending activation BEFORE publishing the session snapshot so
  // lifecycle sweeps/reconciliation cannot treat the not-yet-bound session as
  // an orphan while the panel is being placed. (Lazily imported to keep the
  // panel-grid module graph out of this store-level module.)
  const { registerPendingBrowserActivation } =
    await import('@/lib/panels/browser-panel-activation');
  const release = registerPendingBrowserActivation(event.browserId);
  try {
    await ensureBrowserWorktreeHydrated(
      event.snapshot.projectId,
      event.snapshot.worktreeId,
    ).catch(() => undefined);
    if (!isCurrentBrowserEvent(event)) return;
    if (destroyedAgentOpens.delete(event.browserId)) {
      // Main destroyed this session while the reveal waited on hydration.
      return;
    }
    if (
      pendingAgentOpens.delete(event.browserId) &&
      (isBrowserOpenCancelled(event.browserId) ||
        findWorktreeKeyForBrowser(
          useBrowserStore.getState(),
          event.browserId,
        ) === null)
    ) {
      // The user closed this tab while main was still opening it; that close
      // destroys the session. Do not bring it back.
      return;
    }
    useBrowserStore.getState().registerBrowserSnapshot(event.snapshot);
    useBrowserStore.getState().settleExternalBrowserOpen(event.browserId);
    const activated = await requestBrowserPanel(
      event.snapshot.projectId,
      event.snapshot.worktreeId,
      event.browserId,
      event.originChatTabId,
      {
        focus: false,
        ...(event.presentation === 'background'
          ? { preserveSelection: true }
          : {}),
      },
    );
    if (!activated && event.createdNewSession) {
      // The main action cannot observe renderer panel placement through its
      // push event. Roll back only a session that action freshly created;
      // failure to reveal an existing target must never destroy user state.
      try {
        await useBrowserStore
          .getState()
          .destroyBrowser(
            event.snapshot.projectId,
            event.snapshot.worktreeId,
            event.browserId,
          );
      } catch {
        const { requestBrowserSessionDestruction } =
          await import('@/lib/panels/browser-panel-sync');
        requestBrowserSessionDestruction(
          event.snapshot.projectId,
          event.snapshot.worktreeId,
          event.browserId,
        );
      }
    }
  } finally {
    release();
  }
}

/**
 * Main asked the renderer to take an ordinary content link into the built-in
 * browser (CAN-2305). The target is the **currently selected worktree's**
 * browser, creating one if none exists; with no worktree in context we decline
 * and main opens the link externally exactly as it does today.
 *
 * The acknowledgement is sent as soon as the worktree context is known. For a
 * system-default request, a second response reserves ownership before any
 * browser mutation and a third reports placement completion. A context-only
 * request (`openInApp: false`) stops after the acknowledgement so main can
 * apply the local-only outcome. Main retains the buffered OS URL and owns the
 * external fallback until that final completion succeeds.
 *
 * A `link-context-menu` request is the user's explicit "Open in browser"
 * (CAN-2632): main has no external fallback for it, so any failure to place it
 * raises the failure toast and nothing opens externally on its own.
 */
async function handleAppLinkOpenRequest(
  event: Extract<BrowserEvent, { type: 'app-link-open-requested' }>,
): Promise<void> {
  const selection = useChatStore.getState().selectedWorktree;
  // An ordinary in-app link on the main window takes the worktree browser
  // only where it can show (CAN-5271): from Customize, Home, Settings or the
  // Portal, decline so main opens it externally. App Advisor and the other
  // sources keep their routing.
  const mainWindowAppLink =
    event.source === 'app-link' &&
    (typeof document === 'undefined' ||
      document.body.dataset.rendererSurface !== 'app-advisor');
  const handled =
    selection !== null &&
    (!mainWindowAppLink || isLinkBrowserTargetAvailable());
  const accepted = await window.api.browser
    .resolveOpenLinkRequest({
      requestId: event.requestId,
      handled,
      phase: 'acknowledge',
    })
    .catch(() => false);
  const fromLinkMenu = event.source === 'link-context-menu';
  // `false` means main stopped waiting (its short deadline lapsed, or the
  // answer never reached it) and has already taken the link externally
  // itself. Placing a panel now would open the same link twice.
  if (selection === null || !handled || !accepted || !event.openInApp) {
    if (fromLinkMenu) showLinkOpenFailureToast(event.url);
    return;
  }
  if (!event.awaitCompletion) {
    const placement = await openAppLinkOnce(
      selection.projectId,
      selection.worktreeId,
      event.url,
      !fromLinkMenu,
    );
    if (fromLinkMenu && placement === null) {
      showLinkOpenFailureToast(event.url);
    }
    return;
  }

  // Transfer ownership before creating, activating, or navigating a browser.
  // If main's completion lease already expired, it rejects this commit and no
  // renderer browser state changes. Once committed, this renderer owns both
  // panel placement and the external fallback.
  const reserved = await window.api.browser
    .resolveOpenLinkRequest({
      requestId: event.requestId,
      handled: true,
      phase: 'reserve',
    })
    .catch(() => false);
  if (!reserved) return;

  const placement = await openAppLinkOnce(
    selection.projectId,
    selection.worktreeId,
    event.url,
    false,
  ).catch(() => null);
  const completed = await window.api.browser
    .resolveOpenLinkRequest({
      requestId: event.requestId,
      handled: placement !== null,
      phase: 'complete',
    })
    .catch(() => false);
  if (!completed && placement !== null) {
    await rollbackAppLinkPlacement(
      selection.projectId,
      selection.worktreeId,
      placement,
    );
  }
}

/**
 * Main asks to open a link to a web settings page inside Settings. The
 * renderer decides without navigating, acknowledges, and opens Settings only
 * once main accepts the answer. Declining leaves main's ordinary app-link
 * routing in charge, which keeps flag-off and Remote Control windows on
 * today's behavior. The App Advisor window routes its own chat links but
 * mounts no Settings, so it always declines.
 */
async function handleSettingsLinkOpenRequest(
  event: Extract<BrowserEvent, { type: 'settings-link-open-requested' }>,
): Promise<void> {
  let handled = false;
  try {
    const settingsMounted =
      typeof document === 'undefined' ||
      document.body.dataset.rendererSurface !== 'app-advisor';
    handled = settingsMounted && settingsPathOpensInApp(event.path);
  } catch {
    // Answer anyway: an unanswered request holds the link until main's timeout.
  }
  const accepted = await window.api.browser
    .resolveOpenLinkRequest({
      requestId: event.requestId,
      handled,
      phase: 'acknowledge',
    })
    .catch(() => false);
  // `false` means main stopped waiting and already routed the link itself.
  // Opening Settings now would open the same link twice.
  if (!handled || !accepted || openSettingsPathInApp(event.path)) return;
  // We already told main we would take it, so the external fallback is ours.
  // Like the app-link placement fallback, it does not re-apply the app-link
  // preference.
  await window.api.browser.openExternal({ url: event.url });
}

type AppLinkPlacement = {
  browserId: string;
  createdNewSession: boolean;
  previousActiveBrowserId: string | null;
} | null;

function openAppLinkOnce(
  projectId: string,
  worktreeId: string,
  url: string,
  fallbackExternally: boolean,
): Promise<AppLinkPlacement> {
  const key = JSON.stringify([projectId, worktreeId, url, fallbackExternally]);
  const pending = pendingAppLinkOpens.get(key);
  if (pending) return pending;
  const opening = (async (): Promise<AppLinkPlacement> => {
    const placed = await placeAppLinkBrowser(projectId, worktreeId, url).catch(
      () => null,
    );
    if (placed === null && fallbackExternally) {
      // We already told main we would take it, so the external fallback is
      // ours. Keeping this inside the single-flight prevents duplicate system
      // browser opens when concurrent requests share a failed placement.
      await window.api.browser.openExternal({ url });
    }
    return placed;
  })().finally(() => {
    if (pendingAppLinkOpens.get(key) === opening) {
      pendingAppLinkOpens.delete(key);
    }
  });
  pendingAppLinkOpens.set(key, opening);
  return opening;
}

/**
 * Opens an app link in a new tab with the URL prefilled and reveals its panel
 * at once. Completion waits for the backend session, so a failed open still
 * rolls back (removing the tab) and leaves the external fallback in charge.
 */
async function placeAppLinkBrowser(
  projectId: string,
  worktreeId: string,
  url: string,
): Promise<AppLinkPlacement> {
  const previousActiveBrowserId =
    useBrowserStore.getState().worktrees[`${projectId}/${worktreeId}`]
      ?.activeBrowserId ?? null;
  const opened = useBrowserStore
    .getState()
    .openUrlFromDevServer(projectId, worktreeId, { url });
  if (opened === null) {
    return null;
  }
  const placement: NonNullable<AppLinkPlacement> = {
    browserId: opened.browserId,
    createdNewSession: opened.createdNewSession,
    previousActiveBrowserId,
  };
  let activated = false;
  try {
    activated = await requestBrowserPanel(
      projectId,
      worktreeId,
      opened.browserId,
    );
  } catch {
    // A renderer reload can dispose the layout between session creation and
    // placement. Treat that as a declined placement so rollback/fallback run.
  }
  if (activated && (await opened.ready) !== null) {
    return placement;
  }
  await rollbackAppLinkPlacement(projectId, worktreeId, placement);
  return null;
}

async function rollbackAppLinkPlacement(
  projectId: string,
  worktreeId: string,
  placement: NonNullable<AppLinkPlacement>,
): Promise<void> {
  if (placement.createdNewSession) {
    await destroyCreatedAppLinkBrowser(
      projectId,
      worktreeId,
      placement.browserId,
    );
    return;
  }
  await useBrowserStore
    .getState()
    .setActiveBrowser(projectId, worktreeId, placement.previousActiveBrowserId)
    .catch(() => undefined);
}

async function destroyCreatedAppLinkBrowser(
  projectId: string,
  worktreeId: string,
  browserId: string,
): Promise<void> {
  const { discardOpenedBrowser } =
    await import('@/lib/panels/browser-panel-sync');
  await discardOpenedBrowser(projectId, worktreeId, browserId);
}

/**
 * The chat message menu's "Open in browser" (CAN-2632): opens `url` in the
 * message's own worktree browser, which may differ from the selected one.
 * Resolves whether the tab was placed; a failure raises the failure toast and
 * never opens the link externally.
 */
export async function openAppLinkInWorktreeBrowser(
  projectId: string,
  worktreeId: string,
  url: string,
): Promise<boolean> {
  const placement = await openAppLinkOnce(
    projectId,
    worktreeId,
    url,
    false,
  ).catch(() => null);
  if (placement === null) {
    showLinkOpenFailureToast(url);
    return false;
  }
  return true;
}

/** Idempotently subscribe to browser events for the lifetime of the app. */
export function ensureBrowserEventSubscription(): void {
  if (unsubscribe !== null) {
    return;
  }
  // Some isolated renderer/test hosts expose a deliberately partial preload
  // bridge. The full desktop preload always supplies this method; no-op here
  // so those hosts can initialize the rest of the app independently.
  if (typeof window.api.browser.onEvent !== 'function') {
    return;
  }
  unsubscribe = window.api.browser.onEvent(handleBrowserEvent);
}
