// ---------------------------------------------------------------------------
// Deferred Skills, Plugins, and MCP Tooling — renderer reload store.
//
// The core drives the deferred-tools reload lifecycle in Electron main
// (CAN-4127). When an agent's LoadDeferredTools call enables at least one
// already-installed skill / plugin / MCP server mid-turn, main interrupts the
// originating provider turn, enables the selections and resumes it with a
// hidden `<system_instruction>` continuation. This module only reflects that
// lifecycle so the two provider segments read as ONE continuous logical UX
// turn: it marks the tab, mirrors the merged selections into renderer state
// when the reload resumes, and presents failures for scopes main does not
// commit for.
//
// Boundary: this module is transport-agnostic and store-agnostic. It contains
// the pure predicate helpers plus an event-driven controller that reflects
// events through an injected {@link DeferredToolsReloadStoreSurface}. The chat
// store implements that surface (marker writes, timer/streaming reducers) and
// owns the IPC subscription.
//
// Continuous-UX invariants this module upholds (frontend completion contract):
//   - no second visible user message and no second turn timer (the resumed
//     segment reuses the original logical user message id);
//   - the intermediate internal cancellation never closes the timer, clears
//     streaming, or appears as the final result;
//   - newly enabled selections are mirrored ADDITIVELY into the ORIGINATING
//     tab only (never removed, never leaked to another tab);
//   - App Advisor sentinel tabs are written only by the App Advisor renderer.
// ---------------------------------------------------------------------------

import type {
  AgentProviderType,
  ChatInterfaceMode,
  ChatTabPluginSelections,
  DeferredToolsReloadAck,
  DeferredToolsReloadAdditions,
  DeferredToolsReloadCancelRequest,
  DeferredToolsReloadEvent,
  DeferredToolsReloadLifecycle,
  DeferredToolsReloadScopeKey,
} from '@canopy/desktop-shared/types';
import {
  DEFERRED_TOOLS_ENABLE_FAILURE_MESSAGE,
  DEFERRED_TOOLS_RESUME_FAILURE_MESSAGE,
  isTerminalDeferredToolsReloadLifecycle,
} from '@canopy/desktop-shared/types';
import { isUserCancellationTerminal } from './turn-events';
import type { ChatTab } from './types';

// ---------------------------------------------------------------------------
// User-visible failure copy (owned by this plan)
// ---------------------------------------------------------------------------
//
// These are the only user-visible strings this feature adds. There is no new
// modal / toast / progress stepper — a failure appends a single `role: 'system'`
// message and closes the original turn timer.

export {
  DEFERRED_TOOLS_ENABLE_FAILURE_MESSAGE,
  DEFERRED_TOOLS_RESUME_FAILURE_MESSAGE,
} from '@canopy/desktop-shared/types';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Store surface (implemented by chatStore)
// ---------------------------------------------------------------------------

/** The subset of `window.api.chat` the reload controller calls. */
export interface DeferredToolsReloadChatApi {
  cancelDeferredToolsReload(
    req: DeferredToolsReloadCancelRequest,
  ): Promise<DeferredToolsReloadAck>;
}

/** Snapshot the controller captures when it marks a tab reload-in-progress. */
export interface DeferredToolsReloadTabPreparation {
  /** The tab's current selections. */
  baseSelections: ChatTabPluginSelections;
  sdkSessionId?: string;
  providerType?: AgentProviderType;
  interfaceMode?: ChatInterfaceMode;
  /** The original logical user message id of the open turn, when found. */
  userMessageId?: string;
}

/**
 * The store operations the reload controller needs. The chat store implements
 * these against its zustand state, enforcing the sentinel single-writer policy
 * and keeping every mutation immutable.
 */
export interface DeferredToolsReloadStoreSurface {
  api: DeferredToolsReloadChatApi;
  /**
   * Enforce the single-writer policy and mark the target tab reload-in-progress
   * atomically. Returns the captured tab state, or `null` when this renderer
   * must NOT write the tab (App Advisor read-only mirror), the tab no longer
   * exists, or a different reload is already in progress on it.
   */
  beginReloadOnTab(
    event: DeferredToolsReloadEvent,
  ): DeferredToolsReloadTabPreparation | null;
  /**
   * Mirror the additive merge into this renderer's tab state and return the
   * merged selections. Returns `null` if the tab vanished.
   */
  mergeSelectionsOnTab(
    scope: DeferredToolsReloadScopeKey,
    additions: DeferredToolsReloadAdditions,
  ): ChatTabPluginSelections | null;
  /** Apply the provider session id the continuation resumes. */
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
  /** Whether main commits this scope's chat state (it then commits failure copy). */
  isRevisionedScope(scope: DeferredToolsReloadScopeKey): boolean;
  /**
   * Clear the reload marker without any failure copy. No-op if the tab's
   * marker no longer matches `requestId`.
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

interface ReloadRegistryEntry {
  settled: boolean;
  providerType?: AgentProviderType;
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
  // Keyed by the globally-unique reload request id so duplicate events are
  // ignored and terminal handling is idempotent.
  const registry = new Map<string, ReloadRegistryEntry>();

  function safeCancelCoordinator(
    scope: DeferredToolsReloadScopeKey,
    requestId: string,
    toolCallId: string,
    reason: string,
  ): void {
    void surface.api
      .cancelDeferredToolsReload({ scope, requestId, toolCallId, reason })
      .catch(() => {
        // Best-effort: the core also fails the reload on its own timers.
      });
  }

  function handleTerminal(event: DeferredToolsReloadEvent): void {
    const { scope, requestId, lifecycle } = event;
    if (
      lifecycle.kind === 'outcome' &&
      (lifecycle.outcome === 'enable_failed' ||
        lifecycle.outcome === 'resume_failed')
    ) {
      // Main commits the failure copy for revisioned scopes (CAN-4127).
      if (surface.isRevisionedScope(scope))
        surface.clearReloadOnTab(scope, requestId);
      else
        surface.failReloadOnTab(
          scope,
          requestId,
          lifecycle.outcome === 'enable_failed'
            ? DEFERRED_TOOLS_ENABLE_FAILURE_MESSAGE
            : DEFERRED_TOOLS_RESUME_FAILURE_MESSAGE,
        );
    } else {
      // `cancelled`, `rejected` and `completed`: the turn settles through the
      // normal terminal path; here we just clear the marker.
      surface.clearReloadOnTab(scope, requestId);
    }
    const entry = registry.get(requestId);
    if (entry) entry.settled = true;
    registry.delete(requestId);
  }

  return {
    handleEvent(event: DeferredToolsReloadEvent): void {
      if (isTerminalDeferredToolsReloadLifecycle(event.lifecycle)) {
        handleTerminal(event);
        return;
      }

      let entry = registry.get(event.requestId);
      if (entry) {
        surface.updateReloadLifecycle(
          event.scope,
          event.requestId,
          event.lifecycle,
        );
      } else {
        if (event.additions === undefined) return;
        // A renderer that first sees a reload at a later stage (it reloaded
        // mid-reload) marks the tab the same way.
        const prep = surface.beginReloadOnTab(event);
        if (!prep) return;
        entry = { settled: false, providerType: prep.providerType };
        registry.set(event.requestId, entry);
      }

      if (
        event.lifecycle.kind === 'state' &&
        event.lifecycle.state === 'resuming'
      ) {
        const merged = event.additions
          ? surface.mergeSelectionsOnTab(event.scope, event.additions)
          : null;
        if (event.sdkSessionId)
          surface.applyCommittedSessionId(event.scope, event.sdkSessionId);
        if (merged)
          surface.refreshDiscovery(event.scope, merged, entry.providerType);
      }
    },

    cancel(scope, marker, reason): void {
      const entry = registry.get(marker.requestId);
      if (entry) {
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
