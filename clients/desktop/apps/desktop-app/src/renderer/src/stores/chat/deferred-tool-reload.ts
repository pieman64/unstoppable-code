// ---------------------------------------------------------------------------
// Deferred Skills, Plugins, and MCP Tooling — renderer reload store.
//
// This is the renderer's half of the deferred-tools reload lifecycle (the
// backend coordinator owns the other half). When an agent's LoadDeferredTools
// call enables at least one already-installed skill / plugin / MCP server
// mid-turn, the backend interrupts the originating provider turn and resumes it
// with a hidden `<system_instruction>` continuation. This module makes those
// two provider segments read as ONE continuous logical UX turn and makes the
// renderer the authoritative writer that merges the newly enabled selections
// into the originating tab.
//
// Boundary: this module is transport-agnostic and store-agnostic. It contains
// the pure merge/predicate/copy helpers plus an event-driven controller that
// drives the handshake through an injected {@link DeferredToolsReloadStoreSurface}.
// The chat store implements that surface (marker writes, timer/streaming
// reducers, `chat.updatePlugins`) and owns the IPC subscription. Keeping the
// orchestration behind the surface lets it be unit-tested without the whole
// store.
//
// Continuous-UX invariants this module upholds (frontend completion contract):
//   - no second visible user message and no second turn timer (the resumed
//     segment reuses the original logical user message id);
//   - the intermediate internal cancellation never closes the timer, clears
//     streaming, or appears as the final result;
//   - newly enabled selections are merged ADDITIVELY into the ORIGINATING tab
//     only (never removed, never leaked to another tab);
//   - App Advisor sentinel tabs are written only by the App Advisor renderer.
// ---------------------------------------------------------------------------

import type {
  AgentProviderType,
  ChatInterfaceMode,
  ChatTabPluginSelections,
  ChatUpdatePluginsRequest,
  ChatUpdatePluginsResponse,
  DeferredToolsReloadAck,
  DeferredToolsReloadAdditions,
  DeferredToolsReloadBeginRequest,
  DeferredToolsReloadCancelRequest,
  DeferredToolsReloadEvent,
  DeferredToolsReloadFinishRequest,
  DeferredToolsReloadLifecycle,
  DeferredToolsReloadResumeSettings,
  DeferredToolsReloadScopeKey,
} from '@canopy/desktop-shared/types';
import {
  buildDeferredToolsReloadContinuation,
  isTerminalDeferredToolsReloadLifecycle,
} from '@canopy/desktop-shared/types';
import { mergeChatPluginSelections } from '@/lib/chatPluginSelections';
import { isUserCancellationTerminal } from './turn-events';
import type { ChatTab } from './types';

// ---------------------------------------------------------------------------
// User-visible failure copy (owned by this plan)
// ---------------------------------------------------------------------------
//
// These are the only user-visible strings this feature adds. There is no new
// modal / toast / progress stepper — a failure appends a single `role: 'system'`
// message and closes the original turn timer.

/**
 * Shown when the deferred items could not be enabled at all (the original turn
 * was interrupted but never resumed). Closes the original timer.
 */
export const DEFERRED_TOOLS_ENABLE_FAILURE_MESSAGE =
  'Couldn’t enable the requested deferred items. The chat was not resumed.';

/**
 * Shown when the selections WERE persisted/enabled but the automatic resume
 * failed. The enabled selections remain active; the user can type "Continue" to
 * retry. Closes the original timer.
 */
export const DEFERRED_TOOLS_RESUME_FAILURE_MESSAGE =
  'The requested items were enabled, but the chat could not resume automatically. Send “Continue” to retry.';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Additively merge the reload's typed additions into a tab's current plugin
 * selections. Delegates to {@link mergeChatPluginSelections} so Collections,
 * the required Pipeline Assistant skill, MCP HTTP auth preferences, and every
 * unrelated selection already on `base` are preserved — merge is additive only,
 * nothing is ever removed.
 */
export function mergeDeferredToolsReloadAdditions(
  base: ChatTabPluginSelections,
  additions: DeferredToolsReloadAdditions,
): ChatTabPluginSelections {
  return mergeChatPluginSelections(base, {
    collectionIds: [],
    skillRefs: additions.skillRefs,
    pluginRefs: additions.pluginRefs,
    mcpServerRefs: additions.mcpServerRefs,
  });
}

/** True when a deferred-tools reload is currently in progress for `tab`. */
export function isDeferredToolsReloadActive(tab: ChatTab): boolean {
  return tab.deferredToolsReload !== undefined;
}

/**
 * True when `data` is the intermediate, INTERNAL cancellation produced by
 * interrupting the original provider turn during a deferred-tools reload — the
 * terminal the renderer must NOT let close the timer, clear streaming state, or
 * appear as the final result.
 *
 * Scoped deliberately:
 * - only fires while a reload is active for `tab` (its request id is live);
 * - only fires for a cancellation-shaped terminal (the interruption aborts the
 *   turn; the final resumed completion is a normal, non-cancellation result and
 *   therefore passes through and closes the timer);
 * - a user Stop takes precedence: when `cancelRequestedByUser` is set the
 *   cancellation is honored normally (never auto-resumed).
 */
export function isInternalDeferredToolsReloadInterruption(
  tab: ChatTab,
  data: Record<string, unknown>,
): boolean {
  if (tab.deferredToolsReload === undefined) return false;
  if (tab.cancelRequestedByUser === true) return false;
  return isUserCancellationTerminal(data);
}

/**
 * Return the fixed hidden `<system_instruction>` continuation. Enabled resource
 * identities are carried separately in structured transcript metadata.
 */
export function buildDeferredToolsReloadContinuationText(): string {
  return buildDeferredToolsReloadContinuation();
}

// ---------------------------------------------------------------------------
// Store surface (implemented by chatStore)
// ---------------------------------------------------------------------------

/** The subset of `window.api.chat` the reload controller drives. */
export interface DeferredToolsReloadChatApi {
  beginDeferredToolsReload(
    req: DeferredToolsReloadBeginRequest,
  ): Promise<DeferredToolsReloadAck>;
  finishDeferredToolsReload(
    req: DeferredToolsReloadFinishRequest,
  ): Promise<DeferredToolsReloadAck>;
  cancelDeferredToolsReload(
    req: DeferredToolsReloadCancelRequest,
  ): Promise<DeferredToolsReloadAck>;
  updatePlugins(
    req: ChatUpdatePluginsRequest,
  ): Promise<ChatUpdatePluginsResponse>;
}

/**
 * Snapshot the controller captures when it marks a tab reload-in-progress. The
 * resume inputs (`sdkSessionId` especially) are read BEFORE `chat.updatePlugins`
 * destroys the active provider session so the backend can recreate + resume it.
 */
export interface DeferredToolsReloadTabPreparation {
  /** The tab's current selections, used as the base for the additive merge. */
  baseSelections: ChatTabPluginSelections;
  /** Persisted provider session id captured before `updatePlugins` teardown. */
  sdkSessionId?: string;
  providerType?: AgentProviderType;
  interfaceMode?: ChatInterfaceMode;
  /**
   * The original logical user message id of the open turn, reused for the
   * hidden continuation so no second user bubble is created. Undefined only if
   * no open turn could be located (defensive).
   */
  userMessageId?: string;
}

/**
 * The store operations the reload controller needs. The chat store implements
 * these against its zustand state, enforcing the sentinel single-writer policy
 * and keeping every mutation immutable + persisted.
 */
export interface DeferredToolsReloadStoreSurface {
  api: DeferredToolsReloadChatApi;
  /**
   * Enforce the single-writer policy and mark the target tab reload-in-progress
   * atomically. Returns the captured resume inputs, or `null` when this
   * renderer must NOT write the tab (App Advisor read-only mirror), the tab no
   * longer exists, or a different reload is already in progress on it.
   */
  beginReloadOnTab(
    event: DeferredToolsReloadEvent,
  ): DeferredToolsReloadTabPreparation | null;
  /**
   * Additively merge `additions` into the tab's selections, persist the tab,
   * and return the merged selections (to pass to `updatePlugins` + resume).
   * Returns `null` if the tab vanished.
   */
  mergeSelectionsOnTab(
    scope: DeferredToolsReloadScopeKey,
    additions: DeferredToolsReloadAdditions,
  ): ChatTabPluginSelections | null;
  /** Apply the thread id atomically committed by a Codex materialization. */
  applyCommittedSessionId(
    scope: DeferredToolsReloadScopeKey,
    sdkSessionId: string,
  ): void;
  /** Refresh this tab's slash-command/skill discovery with merged selections. */
  refreshDiscovery(
    scope: DeferredToolsReloadScopeKey,
    selections: ChatTabPluginSelections,
    providerType?: AgentProviderType,
  ): void;
  /** Record the latest non-terminal lifecycle on the tab marker (UI/debug). */
  updateReloadLifecycle(
    scope: DeferredToolsReloadScopeKey,
    requestId: string,
    lifecycle: DeferredToolsReloadLifecycle,
  ): void;
  /**
   * Clear the reload marker without any failure copy. Used on success
   * (`completed`) and on normal cancellation / rejection — the resumed turn
   * settles through the normal terminal path. No-op if the tab's marker no
   * longer matches `requestId`.
   */
  clearReloadOnTab(scope: DeferredToolsReloadScopeKey, requestId: string): void;
  /**
   * Settle a FAILED reload: close the original turn timer, append `message` as a
   * single `role: 'system'` bubble, clear the marker, and drop the tab back to
   * `idle`. No-op if the tab's marker no longer matches `requestId`.
   */
  failReloadOnTab(
    scope: DeferredToolsReloadScopeKey,
    requestId: string,
    message: string,
  ): void;
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

type FailureKind = 'enable' | 'resume';

interface ReloadRegistryEntry {
  /** Set when the user hits Stop mid-flight; the drive loop bails after aborts. */
  aborted: boolean;
  /** Set once a terminal (success/failure/cancel) has been applied. */
  settled: boolean;
}

export interface DeferredToolsReloadController {
  /** Handle one main → renderer reload lifecycle event. */
  handleEvent(event: DeferredToolsReloadEvent): void;
  /**
   * Abort the in-flight reload for a scope (user Stop) and tell the coordinator
   * not to resume. Safe to call when no reload is active.
   */
  cancel(
    scope: DeferredToolsReloadScopeKey,
    marker: { requestId: string; toolCallId: string },
    reason?: string,
  ): void;
  /** Test-only: true when a reload with `requestId` is being tracked. */
  __isTracking(requestId: string): boolean;
}

export function createDeferredToolsReloadController(
  surface: DeferredToolsReloadStoreSurface,
): DeferredToolsReloadController {
  // Keyed by the globally-unique reload request id so duplicate begin events
  // are ignored and terminal handling is idempotent.
  const registry = new Map<string, ReloadRegistryEntry>();

  function settleFailure(
    scope: DeferredToolsReloadScopeKey,
    requestId: string,
    entry: ReloadRegistryEntry,
    kind: FailureKind,
  ): void {
    if (entry.settled) return;
    entry.settled = true;
    registry.delete(requestId);
    surface.failReloadOnTab(
      scope,
      requestId,
      kind === 'enable'
        ? DEFERRED_TOOLS_ENABLE_FAILURE_MESSAGE
        : DEFERRED_TOOLS_RESUME_FAILURE_MESSAGE,
    );
  }

  function safeCancelCoordinator(
    scope: DeferredToolsReloadScopeKey,
    requestId: string,
    toolCallId: string,
    reason: string,
  ): void {
    void surface.api
      .cancelDeferredToolsReload({ scope, requestId, toolCallId, reason })
      .catch(() => {
        // Best-effort: the coordinator also fails the reload on its own timers.
      });
  }

  async function drive(
    event: DeferredToolsReloadEvent,
    prep: DeferredToolsReloadTabPreparation,
    entry: ReloadRegistryEntry,
  ): Promise<void> {
    const { scope, requestId, toolCallId } = event;
    const additions = event.additions;
    let enablementCompleted = false;
    if (!additions) {
      settleFailure(scope, requestId, entry, 'enable');
      safeCancelCoordinator(
        scope,
        requestId,
        toolCallId,
        'Deferred-tools reload event did not include additions.',
      );
      return;
    }

    try {
      // 1. Begin: hand the coordinator the additions the renderer will write.
      const beginAck = await surface.api.beginDeferredToolsReload({
        scope,
        requestId,
        toolCallId,
        additions,
        enabledResources: event.enabledResources ?? [],
      });
      if (entry.aborted) return;
      if (!beginAck.accepted) {
        settleFailure(scope, requestId, entry, 'enable');
        return;
      }

      // 2. Merge + persist the additive selections (authoritative write).
      const merged = surface.mergeSelectionsOnTab(scope, additions);
      if (entry.aborted) return;
      if (!merged) {
        settleFailure(scope, requestId, entry, 'enable');
        safeCancelCoordinator(scope, requestId, toolCallId, 'enable_failed');
        return;
      }

      // 3. `updatePlugins` — destroys the active session so the backend can
      //    recreate it with the merged selections (sdkSessionId was captured in
      //    `prep`, before this call, so the recreated session resumes history).
      let updateResponse: ChatUpdatePluginsResponse;
      try {
        updateResponse = await surface.api.updatePlugins({
          projectId: scope.projectId,
          worktreeId: scope.worktreeId,
          chatId: scope.chatId,
          pluginSelections: merged,
          materializeCodexThread: prep.providerType === 'codex',
          ...(prep.providerType === 'codex' && prep.sdkSessionId
            ? { expectedCurrentThreadId: prep.sdkSessionId }
            : {}),
        });
        if (updateResponse.sdkSessionId) {
          surface.applyCommittedSessionId(scope, updateResponse.sdkSessionId);
        }
      } catch {
        if (entry.aborted) return;
        settleFailure(scope, requestId, entry, 'enable');
        safeCancelCoordinator(scope, requestId, toolCallId, 'enable_failed');
        return;
      }
      if (entry.aborted) return;
      enablementCompleted = true;

      // Rebuild the tab's discovered skill/command list using the newly
      // persisted selections. This keeps the slash menu in sync with the
      // plugin picker without requiring a manual refresh.
      surface.refreshDiscovery(scope, merged, prep.providerType);

      // 4. Finish: hand the backend the resume settings + reused user message
      //    id + hidden continuation so it can resume the interrupted turn.
      if (!prep.userMessageId) {
        settleFailure(scope, requestId, entry, 'resume');
        safeCancelCoordinator(scope, requestId, toolCallId, 'resume_failed');
        return;
      }
      const resume: DeferredToolsReloadResumeSettings = {
        sdkSessionId: updateResponse.sdkSessionId ?? prep.sdkSessionId,
        providerType: prep.providerType,
        interfaceMode: prep.interfaceMode,
        pluginSelections: merged,
      };
      const finishAck = await surface.api.finishDeferredToolsReload({
        scope,
        requestId,
        toolCallId,
        userMessageId: prep.userMessageId,
        resume,
        continuationText: buildDeferredToolsReloadContinuationText(),
      });
      if (entry.aborted) return;
      if (!finishAck.accepted) {
        // Selections are already persisted/enabled; only the resume failed.
        settleFailure(scope, requestId, entry, 'resume');
        return;
      }

      // Success: leave the marker in place until a terminal lifecycle event
      // (`completed` / an outcome) arrives, so the tab stays streaming across
      // the session gap and the intermediate cancellation stays ignored.
    } catch {
      if (entry.aborted) return;
      const phase = enablementCompleted ? 'resume' : 'enable';
      settleFailure(scope, requestId, entry, phase);
      safeCancelCoordinator(scope, requestId, toolCallId, `${phase}_failed`);
    }
  }

  function handleTerminal(event: DeferredToolsReloadEvent): void {
    const { scope, requestId, lifecycle } = event;
    const entry = registry.get(requestId);
    const alreadySettled = entry?.settled === true;

    if (lifecycle.kind === 'outcome') {
      switch (lifecycle.outcome) {
        case 'enable_failed':
          if (!alreadySettled) {
            surface.failReloadOnTab(
              scope,
              requestId,
              DEFERRED_TOOLS_ENABLE_FAILURE_MESSAGE,
            );
          }
          break;
        case 'resume_failed':
          if (!alreadySettled) {
            surface.failReloadOnTab(
              scope,
              requestId,
              DEFERRED_TOOLS_RESUME_FAILURE_MESSAGE,
            );
          }
          break;
        // `cancelled` (user Stop) and `rejected` use the normal cancellation
        // presentation — just clear the marker, no failure copy.
        case 'cancelled':
        case 'rejected':
          surface.clearReloadOnTab(scope, requestId);
          break;
      }
    } else {
      // `completed` — the resumed provider's own final result closes the timer
      // through the normal terminal path; here we just clear the marker.
      surface.clearReloadOnTab(scope, requestId);
    }

    if (entry) {
      entry.settled = true;
      entry.aborted = true;
      registry.delete(requestId);
    }
  }

  return {
    handleEvent(event: DeferredToolsReloadEvent): void {
      if (isTerminalDeferredToolsReloadLifecycle(event.lifecycle)) {
        handleTerminal(event);
        return;
      }

      const existing = registry.get(event.requestId);
      if (existing) {
        // Already driving this reload; just reflect the lifecycle progress.
        surface.updateReloadLifecycle(
          event.scope,
          event.requestId,
          event.lifecycle,
        );
        return;
      }

      // A reload cannot proceed without the typed additions to merge.
      if (event.additions === undefined) {
        return;
      }

      const prep = surface.beginReloadOnTab(event);
      if (!prep) {
        // App Advisor read-only mirror, missing tab, or a conflicting reload —
        // this renderer is not the authoritative writer, so ignore the event.
        return;
      }

      const entry: ReloadRegistryEntry = { aborted: false, settled: false };
      registry.set(event.requestId, entry);
      void drive(event, prep, entry);
    },

    cancel(scope, marker, reason): void {
      const entry = registry.get(marker.requestId);
      if (entry) {
        entry.aborted = true;
        entry.settled = true;
        registry.delete(marker.requestId);
      }
      // The normal user-cancellation terminal settles the tab UI; clear the
      // marker defensively so streaming re-verification stops holding it.
      surface.clearReloadOnTab(scope, marker.requestId);
      safeCancelCoordinator(
        scope,
        marker.requestId,
        marker.toolCallId,
        reason ?? 'user_stop',
      );
    },

    __isTracking(requestId: string): boolean {
      return registry.has(requestId);
    },
  };
}
