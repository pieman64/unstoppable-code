// ---------------------------------------------------------------------------
// Claude Code terminal store (renderer-only, per chat)
// ---------------------------------------------------------------------------
//
// Owns the renderer-side runtime state for the managed Claude Code terminal
// experience. The store is the single subscriber to the
// `window.api.claudeTerminal.on*` event surfaces and the only renderer entry
// point that calls `window.api.claudeTerminal.launch` / `.cleanup`.
//
// The store is keyed by `${projectId}/${worktreeId}/${chatId}` so the same
// chat key resolves consistently with the rest of the renderer's chat
// addressing conventions. Subscriptions are registered exactly once on
// module load and torn down on `disposeClaudeTerminalSubscriptions()` — the
// teardown helper is exported for tests that need to verify no listeners
// leak across hot reloads.

import { create } from 'zustand';
import type {
  ClaudeTerminalCleanupReason,
  ClaudeTerminalLaunchRequest,
  ClaudeTerminalRuntimeState,
  ClaudeTerminalTurnState,
  TranscriptSyncResult,
  TerminalExitEvent,
} from '@canopy/desktop-shared/types';

/**
 * Per-chat snapshot tracked by the renderer. Mirrors the persisted runtime
 * state but also tracks the launch lifecycle the renderer cares about
 * (`'idle' | 'starting' | 'ready' | 'error'`).
 */
export interface ClaudeTerminalClientState {
  projectId: string;
  worktreeId: string;
  chatId: string;
  terminalId?: string;
  sessionKey?: string;
  sdkSessionId?: string;
  turnState: ClaudeTerminalTurnState;
  /**
   * Mirror of {@link ClaudeTerminalRuntimeState.readyForInput}: true once the
   * CLI has issued its first hook callback, proving the TUI can accept pasted
   * input. Fresh launches report `turnState: 'idle'` before this flips.
   */
  readyForInput?: boolean;
  /**
   * Mirror of {@link ClaudeTerminalRuntimeState.firstOutputAt}: set once the
   * spawned CLI has written anything to the PTY. The terminal surface keeps a
   * "starting" overlay until this lands so cold CLI startup never shows a
   * blank screen.
   */
  firstOutputAt?: number;
  launchStatus: 'idle' | 'starting' | 'ready' | 'error';
  errorMessage?: string;
  /** Most recent transcript-sync result for surfacing UI hints. */
  lastSync?: TranscriptSyncResult;
  /**
   * True between an auto-mode prompt dispatch and the next turn-idle (or
   * terminal exit/error). Bridges the gap before the `UserPromptSubmit` hook
   * flips `turnState` to `'running'` so the auto surface can switch to the
   * terminal immediately.
   */
  autoSendPending?: boolean;
  /**
   * Echo of {@link ClaudeTerminalLaunchResponse.initialPromptSubmitted} from
   * the most recent launch resolved by `ensureLaunch`.
   */
  lastLaunchConsumedInitialPrompt?: boolean;
  /**
   * Set after the renderer sends an explicit user interrupt. Some Claude Code
   * cancellation paths do not emit a hook/output signal promptly; keep the UI
   * unlocked locally until the backend reports a terminal settled state or a
   * new prompt is dispatched.
   */
  userInterruptPending?: boolean;
  /** Unix-ms when the renderer most recently sent an explicit interrupt. */
  userInterruptPendingAt?: number;
}

export interface ClaudeTerminalStoreState {
  /** Keyed by `${projectId}/${worktreeId}/${chatId}`. */
  byChat: Record<string, ClaudeTerminalClientState>;
  /** Map from `terminalId` → owning chat key, for fast event routing. */
  terminalIdIndex: Record<string, string>;
  /**
   * In-flight `launch` promises keyed by chat. `ensureLaunch` returns the
   * existing promise instead of issuing a duplicate IPC so the call is safe
   * to fire from React effects without debouncing.
   */
  inFlightLaunch: Record<string, Promise<ClaudeTerminalClientState>>;

  /**
   * Launch (or rehydrate) the managed Claude Code terminal for `chatId`.
   * Idempotent: repeated calls for the same chat resolve to the same state
   * snapshot while a launch is in flight, and become a no-op once the
   * runtime has reached `launchStatus: 'ready'`.
   */
  ensureLaunch(
    request: ClaudeTerminalLaunchRequest,
  ): Promise<ClaudeTerminalClientState>;

  /**
   * Tear down the managed Claude Code terminal for `chatId` and remove the
   * client state from the store. Reports `reason` to telemetry/logs via the
   * IPC contract.
   */
  cleanup(
    projectId: string,
    worktreeId: string,
    chatId: string,
    reason: ClaudeTerminalCleanupReason,
  ): Promise<void>;

  /** Lookup helper for callers that already know the chat key. */
  getStateForChat(
    projectId: string,
    worktreeId: string,
    chatId: string,
  ): ClaudeTerminalClientState | undefined;

  /**
   * Mark that an auto-mode prompt has been dispatched to (or queued for) the
   * managed terminal so the auto surface locks to the terminal view until
   * the turn settles back to idle.
   */
  markAutoSendPending(
    projectId: string,
    worktreeId: string,
    chatId: string,
  ): void;

  /**
   * Release a pending auto-send surface lock. Used when the user manually
   * switches interface modes: a paste that never submitted (no
   * `UserPromptSubmit` follows) would otherwise pin the auto surface to the
   * terminal forever, with the mode toggle as the only escape hatch.
   */
  clearAutoSendPending(
    projectId: string,
    worktreeId: string,
    chatId: string,
  ): void;

  /**
   * Optimistically settle a running terminal turn after the user explicitly
   * interrupts it. This releases the auto-mode terminal surface and unlocks
   * the mode toggle without waiting for Claude Code hooks.
   */
  markUserInterrupted(
    projectId: string,
    worktreeId: string,
    chatId: string,
  ): void;
}

function makeChatKey(
  projectId: string,
  worktreeId: string,
  chatId: string,
): string {
  return `${projectId}/${worktreeId}/${chatId}`;
}

function emptyState(
  projectId: string,
  worktreeId: string,
  chatId: string,
): ClaudeTerminalClientState {
  return {
    projectId,
    worktreeId,
    chatId,
    turnState: 'uninitialized',
    launchStatus: 'idle',
  };
}

export const useClaudeTerminalStore = create<ClaudeTerminalStoreState>(
  (set, get) => ({
    byChat: {},
    terminalIdIndex: {},
    inFlightLaunch: {},

    ensureLaunch: async (request): Promise<ClaudeTerminalClientState> => {
      const { projectId, worktreeId, chatId } = request;
      const key = makeChatKey(projectId, worktreeId, chatId);

      const existingPromise = get().inFlightLaunch[key];
      if (existingPromise !== undefined) {
        return existingPromise;
      }
      const existingState = get().byChat[key];
      if (
        existingState &&
        existingState.launchStatus === 'ready' &&
        existingState.terminalId
      ) {
        // The renderer snapshot can outlive the process (idle reaping, missed
        // exit events, renderer reloads) — confirm with the main process
        // before reusing it. When the runtime is gone, fall through to a
        // fresh launch so this call's initialPrompt reaches the CLI.
        const liveState = await window.api.claudeTerminal
          .getState(projectId, worktreeId, chatId)
          .catch(() => undefined);
        if (
          liveState?.terminalId &&
          liveState.turnState !== 'exited' &&
          liveState.turnState !== 'error' &&
          liveState.turnState !== 'cleaning_up'
        ) {
          // No launch was performed, so this call's initialPrompt (if any)
          // was NOT consumed — don't let a stale echo from an earlier launch
          // tell the caller to drop its queued copy.
          return {
            ...existingState,
            terminalId: liveState.terminalId,
            turnState: liveState.turnState,
            readyForInput: liveState.readyForInput === true,
            ...(liveState.firstOutputAt !== undefined
              ? { firstOutputAt: liveState.firstOutputAt }
              : {}),
            lastLaunchConsumedInitialPrompt: false,
          };
        }
        // The liveness check awaited an IPC roundtrip — a concurrent caller
        // may have started a launch in the meantime.
        const racedPromise = get().inFlightLaunch[key];
        if (racedPromise !== undefined) {
          return racedPromise;
        }
      }

      set((state) => ({
        byChat: {
          ...state.byChat,
          [key]: {
            ...(state.byChat[key] ?? emptyState(projectId, worktreeId, chatId)),
            launchStatus: 'starting',
            errorMessage: undefined,
          },
        },
      }));

      const launchPromise = (async (): Promise<ClaudeTerminalClientState> => {
        try {
          const response = await window.api.claudeTerminal.launch(request);
          const previousState = get().byChat[key];
          const nextState: ClaudeTerminalClientState = {
            projectId,
            worktreeId,
            chatId,
            terminalId: response.terminalId,
            sessionKey: response.sessionKey,
            sdkSessionId: response.sdkSessionId,
            turnState: response.state.turnState,
            ...(response.state.readyForInput === true
              ? { readyForInput: true }
              : {}),
            ...(response.state.firstOutputAt !== undefined
              ? { firstOutputAt: response.state.firstOutputAt }
              : {}),
            launchStatus: 'ready',
            ...(previousState?.autoSendPending
              ? { autoSendPending: true }
              : {}),
            ...(previousState?.userInterruptPending
              ? { userInterruptPending: true }
              : {}),
            lastLaunchConsumedInitialPrompt:
              response.initialPromptSubmitted === true,
          };
          set((state) => {
            const previousTerminalId = state.byChat[key]?.terminalId;
            const terminalIdIndex = { ...state.terminalIdIndex };
            if (
              previousTerminalId &&
              previousTerminalId !== response.terminalId
            ) {
              delete terminalIdIndex[previousTerminalId];
            }
            terminalIdIndex[response.terminalId] = key;
            return {
              byChat: { ...state.byChat, [key]: nextState },
              terminalIdIndex,
            };
          });
          return nextState;
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : 'Launch failed';
          set((state) => ({
            byChat: {
              ...state.byChat,
              [key]: {
                ...(state.byChat[key] ??
                  emptyState(projectId, worktreeId, chatId)),
                launchStatus: 'error',
                errorMessage,
                // A failed launch settles any pending auto-mode send so the
                // surface (and launch ownership) isn't stuck on a terminal
                // that never came up.
                autoSendPending: false,
              },
            },
          }));
          throw error;
        } finally {
          set((state) => {
            const inFlightLaunch = { ...state.inFlightLaunch };
            delete inFlightLaunch[key];
            return { inFlightLaunch };
          });
        }
      })();

      set((state) => ({
        inFlightLaunch: { ...state.inFlightLaunch, [key]: launchPromise },
      }));
      return launchPromise;
    },

    cleanup: async (projectId, worktreeId, chatId, reason): Promise<void> => {
      const key = makeChatKey(projectId, worktreeId, chatId);
      try {
        await window.api.claudeTerminal.cleanup({
          projectId,
          worktreeId,
          chatId,
          reason,
        });
      } finally {
        set((state) => {
          const previousTerminalId = state.byChat[key]?.terminalId;
          const byChat = { ...state.byChat };
          delete byChat[key];
          const terminalIdIndex = { ...state.terminalIdIndex };
          if (previousTerminalId) {
            delete terminalIdIndex[previousTerminalId];
          }
          return { byChat, terminalIdIndex };
        });
      }
    },

    getStateForChat: (
      projectId,
      worktreeId,
      chatId,
    ): ClaudeTerminalClientState | undefined =>
      get().byChat[makeChatKey(projectId, worktreeId, chatId)],

    markAutoSendPending: (projectId, worktreeId, chatId): void => {
      const key = makeChatKey(projectId, worktreeId, chatId);
      set((state) => ({
        byChat: {
          ...state.byChat,
          [key]: {
            ...(state.byChat[key] ?? emptyState(projectId, worktreeId, chatId)),
            autoSendPending: true,
            userInterruptPending: false,
            userInterruptPendingAt: undefined,
          },
        },
      }));
    },

    clearAutoSendPending: (projectId, worktreeId, chatId): void => {
      const key = makeChatKey(projectId, worktreeId, chatId);
      set((state) => {
        const existing = state.byChat[key];
        if (!existing || existing.autoSendPending !== true) {
          return state;
        }
        return {
          byChat: {
            ...state.byChat,
            [key]: { ...existing, autoSendPending: false },
          },
        };
      });
    },

    markUserInterrupted: (projectId, worktreeId, chatId): void => {
      const key = makeChatKey(projectId, worktreeId, chatId);
      set((state) => {
        const existing = state.byChat[key];
        if (!existing) {
          return state;
        }
        return {
          byChat: {
            ...state.byChat,
            [key]: {
              ...existing,
              turnState: 'idle',
              autoSendPending: false,
              userInterruptPending: true,
              userInterruptPendingAt: Date.now(),
            },
          },
        };
      });
    },
  }),
);

/**
 * Whether auto interface mode should currently present the managed terminal
 * surface instead of the Canopy-native transcript: a launch is in flight, a
 * dispatched prompt has not settled, or a turn is actively executing.
 */
export function isAutoTerminalSurfaceActive(
  state: ClaudeTerminalClientState | undefined,
): boolean {
  if (!state) return false;
  if (state.autoSendPending === true) return true;
  if (state.launchStatus === 'starting') return true;
  // `cleaning_up` is intentionally NOT active: settings-change restarts tear
  // down idle hidden terminals, and treating teardown as active flashed the
  // terminal surface over the Canopy view for the cleanup instant.
  return state.turnState === 'starting' || state.turnState === 'running';
}

/**
 * Resolve which chat surface a tab should render for its interface mode.
 * `'claude-code'` always shows the terminal; `'auto'` shows the terminal only
 * while {@link isAutoTerminalSurfaceActive} holds.
 */
export function resolveChatInterfaceSurface(
  mode: 'canopy' | 'claude-code' | 'auto',
  state: ClaudeTerminalClientState | undefined,
): 'canopy' | 'terminal' {
  if (mode === 'claude-code') return 'terminal';
  if (mode === 'auto') {
    return isAutoTerminalSurfaceActive(state) ? 'terminal' : 'canopy';
  }
  return 'canopy';
}

// ---------------------------------------------------------------------------
// IPC subscriptions
// ---------------------------------------------------------------------------

let storedUnsubscribeCallbacks: Array<() => void> = [];

/**
 * Apply a `state-changed` event from the main process to the store. The
 * runtime state shape does not embed routing IDs because the backend
 * publishes per-chat — the matching chat is found by `terminalId` or, for
 * pre-launch runtimes, kept as a no-op.
 */
function applyStateChangedEvent(state: ClaudeTerminalRuntimeState): void {
  const terminalId = state.terminalId;
  if (!terminalId) {
    return;
  }
  const { terminalIdIndex, byChat } = useClaudeTerminalStore.getState();
  const key = terminalIdIndex[terminalId];
  if (!key) {
    return;
  }
  const existing = byChat[key];
  if (!existing) {
    return;
  }
  // A dispatched auto-mode prompt has settled once the turn returns to idle
  // after running, or the terminal leaves the live state entirely.
  const autoSendSettled =
    state.turnState === 'exited' ||
    state.turnState === 'error' ||
    (existing.turnState === 'running' && state.turnState === 'idle');
  const interruptSafetyExpired =
    existing.userInterruptPending === true &&
    state.turnState === 'running' &&
    typeof existing.userInterruptPendingAt === 'number' &&
    Date.now() - existing.userInterruptPendingAt > 5_000;
  const ignoreRunningAfterUserInterrupt =
    existing.userInterruptPending === true &&
    state.turnState === 'running' &&
    !interruptSafetyExpired;
  const interruptSettled =
    existing.userInterruptPending === true &&
    (state.turnState === 'idle' ||
      state.turnState === 'error' ||
      state.turnState === 'exited');
  useClaudeTerminalStore.setState({
    byChat: {
      ...byChat,
      [key]: {
        ...existing,
        terminalId: state.terminalId ?? existing.terminalId,
        sessionKey: state.sessionKey ?? existing.sessionKey,
        sdkSessionId: state.sdkSessionId ?? existing.sdkSessionId,
        turnState: ignoreRunningAfterUserInterrupt
          ? existing.turnState
          : state.turnState,
        readyForInput: state.readyForInput === true,
        ...(state.firstOutputAt !== undefined
          ? { firstOutputAt: state.firstOutputAt }
          : {}),
        ...(autoSendSettled || ignoreRunningAfterUserInterrupt
          ? { autoSendPending: false }
          : {}),
        ...(interruptSettled || interruptSafetyExpired
          ? { userInterruptPending: false, userInterruptPendingAt: undefined }
          : {}),
        launchStatus:
          state.turnState === 'error'
            ? 'error'
            : state.turnState === 'exited'
              ? 'idle'
              : existing.launchStatus === 'starting'
                ? 'ready'
                : existing.launchStatus,
        ...(state.lastError ? { errorMessage: state.lastError } : {}),
      },
    },
  });
}

function applySyncCompletedEvent(result: TranscriptSyncResult): void {
  const { byChat } = useClaudeTerminalStore.getState();
  for (const [key, value] of Object.entries(byChat)) {
    const projectMatches =
      result.projectId === undefined || value.projectId === result.projectId;
    const worktreeMatches =
      result.worktreeId === undefined || value.worktreeId === result.worktreeId;
    if (value.chatId === result.chatId && projectMatches && worktreeMatches) {
      useClaudeTerminalStore.setState({
        byChat: {
          ...byChat,
          [key]: { ...value, lastSync: result },
        },
      });
      return;
    }
  }
}

function applyErrorEvent(event: { chatId: string; message: string }): void {
  const { byChat } = useClaudeTerminalStore.getState();
  for (const [key, value] of Object.entries(byChat)) {
    if (value.chatId === event.chatId) {
      useClaudeTerminalStore.setState({
        byChat: {
          ...byChat,
          [key]: {
            ...value,
            launchStatus: 'error',
            errorMessage: event.message,
          },
        },
      });
      return;
    }
  }
}

function applyTerminalExitEvent(event: TerminalExitEvent): void {
  const { terminalIdIndex, byChat } = useClaudeTerminalStore.getState();
  const key = terminalIdIndex[event.terminalId];
  if (!key) {
    return;
  }
  const existing = byChat[key];
  if (!existing) {
    return;
  }
  useClaudeTerminalStore.setState({
    byChat: {
      ...byChat,
      [key]: {
        ...existing,
        turnState: 'exited',
        readyForInput: false,
        launchStatus: 'idle',
        autoSendPending: false,
      },
    },
  });
}

/**
 * Register the renderer-side subscriptions for the managed Claude Code
 * terminal. Returns the disposer so tests can call it explicitly. The
 * disposer is idempotent.
 */
export function initClaudeTerminalSubscriptions(): () => void {
  // Defensive: the module guards against double-init so hot-reloaded modules
  // don't accumulate listeners. The first init claims ownership; subsequent
  // calls become no-ops until the previous disposer runs.
  if (storedUnsubscribeCallbacks.length > 0) {
    return disposeClaudeTerminalSubscriptions;
  }
  // `window.api.claudeTerminal` may be undefined inside non-renderer
  // contexts (unit tests, type-check probes). Bail out gracefully.
  const api =
    typeof window === 'undefined'
      ? undefined
      : (window.api?.claudeTerminal ?? undefined);
  if (!api) {
    return disposeClaudeTerminalSubscriptions;
  }
  const unsubState = api.onStateChanged(applyStateChangedEvent);
  const unsubSync = api.onSyncCompleted(applySyncCompletedEvent);
  const unsubError = api.onError(applyErrorEvent);
  const unsubExit =
    typeof window.api.terminal?.onExit === 'function'
      ? window.api.terminal.onExit(applyTerminalExitEvent)
      : (): void => {};
  storedUnsubscribeCallbacks = [unsubState, unsubSync, unsubError, unsubExit];
  return disposeClaudeTerminalSubscriptions;
}

export function disposeClaudeTerminalSubscriptions(): void {
  const callbacks = storedUnsubscribeCallbacks;
  storedUnsubscribeCallbacks = [];
  for (const cb of callbacks) {
    try {
      cb();
    } catch {
      // Swallow — unsubscribe handlers are best-effort during teardown.
    }
  }
}
