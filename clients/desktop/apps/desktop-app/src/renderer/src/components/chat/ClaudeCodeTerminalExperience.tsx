import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type RefObject,
} from 'react';
import { TerminalPane } from '@/components/terminal/TerminalPane';
import { reportRendererConsoleError } from '@/lib/renderer-error-logging';
import { requestTerminalFocus } from '@/lib/terminal-focus-intent';
import { useChatStore, useChatTabRenderState } from '@/stores/chatStore';
import {
  useClaudeTerminalStore,
  type ClaudeTerminalClientState,
} from '@/stores/claudeTerminalStore';
import { useCancelRunningChatShortcut } from './useCancelRunningChatShortcut';
import type { ClaudeTerminalLaunchRequest } from '@canopy/desktop-shared/types';

const COPY_STARTING = 'Starting Claude Code…';
const COPY_LAUNCH_FAILED =
  'Unable to start Claude Code. Check the bundled Claude binary and try again.';
const COPY_UNAVAILABLE =
  'Claude Code terminal mode is unavailable on this platform.';

/**
 * Alternate chat experience that mounts the managed Claude Code terminal in
 * place of the Canopy-native composer/transcript pair. The component is
 * declarative: it asks {@link useChatStore.ensureClaudeTerminal} to make sure
 * a terminal is alive for the active chat, then watches
 * {@link useClaudeTerminalStore} to decide which copy / pane to render.
 *
 * Switching back to Canopy unmounts this component without tearing down the
 * managed terminal — the chatStore is the only renderer caller of
 * `cleanupClaudeTerminalForNativeSend`, and that path runs from the
 * Canopy-native send pipeline (Phase F5).
 */
export interface ClaudeCodeTerminalExperienceProps {
  projectId: string;
  worktreeId: string;
  chatId: string;
  assistantMode?: ClaudeTerminalLaunchRequest['assistantMode'];
  /** Optional platform-availability flag from a feature gate. */
  unsupported?: boolean;
  /**
   * Whether this experience is rendered inside the panel the user currently
   * has active. Gates the Escape-to-cancel shortcut, whose listener is
   * document-level: without this, a second mounted Claude-terminal chat in
   * another panel would interrupt its agent from an Escape pressed anywhere
   * in the app (CAN-2309). Defaults to `true` for single-instance hosts
   * (modals, drawers) where exactly one surface is mounted.
   */
  isActivePanel?: boolean;
  /** Owning document for Escape handling when rendered in a popped-out panel. */
  cancelShortcutOwnerDocument?: Document;
  /** Active chat-panel root used to reject Escape from sibling surfaces. */
  cancelShortcutTargetRootRef?: RefObject<HTMLElement | null>;
}

export function ClaudeCodeTerminalExperience({
  projectId,
  worktreeId,
  chatId,
  assistantMode,
  unsupported,
  isActivePanel = true,
  cancelShortcutOwnerDocument,
  cancelShortcutTargetRootRef,
}: ClaudeCodeTerminalExperienceProps): JSX.Element {
  const ensureClaudeTerminal = useChatStore((s) => s.ensureClaudeTerminal);
  const runtime: ClaudeTerminalClientState | undefined = useClaudeTerminalStore(
    (state) => state.byChat[`${projectId}/${worktreeId}/${chatId}`],
  );
  const [launchAttempt, setLaunchAttempt] = useState(0);
  const experienceRootRef = useRef<HTMLDivElement | null>(null);
  const handleCancelRunningTurn = useCallback((): void => {
    if (runtime?.turnState !== 'running' || !runtime.terminalId) {
      return;
    }
    const terminalId = runtime.terminalId;

    void (async (): Promise<void> => {
      try {
        await window.api.terminal.write({
          terminalId,
          data: '\x03',
        });
      } catch (error) {
        reportRendererConsoleError('Claude terminal Ctrl-C write failed', {
          error,
        });
      }
      try {
        await window.api.claudeTerminal.interrupt({
          projectId,
          worktreeId,
          chatId,
        });
      } catch (error) {
        reportRendererConsoleError('Claude terminal interrupt failed', {
          error,
        });
      }
    })();
    useClaudeTerminalStore
      .getState()
      .markUserInterrupted(projectId, worktreeId, chatId);
  }, [chatId, projectId, runtime?.terminalId, runtime?.turnState, worktreeId]);

  useCancelRunningChatShortcut({
    enabled:
      isActivePanel &&
      runtime?.turnState === 'running' &&
      Boolean(runtime.terminalId),
    onCancel: handleCancelRunningTurn,
    chatKey: `${projectId}/${worktreeId}/${chatId}`,
    ownerDocument: cancelShortcutOwnerDocument,
    targetRootRef: cancelShortcutTargetRootRef ?? experienceRootRef,
  });

  // CAN-2309: a managed Claude terminal may take the caret when THIS mount
  // launched it (the user opened Claude Code here), but not when it is simply
  // re-rendered for an already-running runtime — returning to a task must
  // leave the caret where the user left it.
  // Restart is an explicit gesture, but it does NOT remount this component —
  // it only bumps `launchAttempt`. The launch entitlement below is one-shot
  // and armed only at first mount, so restart needs its own intent record or
  // the user clicks Restart and the caret stays wherever it was (CAN-2309).
  const restartPendingRef = useRef(false);
  const restartRelaunchSeenRef = useRef(false);
  const observedFirstRuntimeRef = useRef(false);
  const launchedDuringThisMountRef = useRef(false);
  const launchAlreadyInProgressOnMountRef = useRef(
    runtime?.launchStatus === 'starting' && !runtime.terminalId,
  );
  useEffect(() => {
    if (runtime === undefined) return;
    if (!observedFirstRuntimeRef.current) {
      observedFirstRuntimeRef.current = true;
      launchedDuringThisMountRef.current =
        !runtime.terminalId && !launchAlreadyInProgressOnMountRef.current;
      return;
    }
    if (!launchedDuringThisMountRef.current) return;
    if (!runtime.terminalId) return;
    // Keep the claim pending while this panel is inactive rather than
    // consuming it. The launch is asynchronous, so the terminal id routinely
    // arrives after the user has switched away; clearing the flag first would
    // permanently forget that this mount launched the terminal, and coming
    // back to the task would never focus it. `isActivePanel` is in this
    // effect's deps, so returning here re-runs the claim when it flips true.
    if (!isActivePanel) return;
    launchedDuringThisMountRef.current = false;
    requestTerminalFocus(
      runtime.terminalId,
      experienceRootRef.current?.ownerDocument ?? document,
    );
  }, [isActivePanel, runtime]);

  const handleRestart = useCallback((): void => {
    restartPendingRef.current = true;
    restartRelaunchSeenRef.current = false;
    setLaunchAttempt((value) => value + 1);
  }, []);

  // Honor a restart gesture once the relaunch has actually produced a ready
  // runtime. Waiting for a non-ready phase first matters because the runtime
  // that was on screen when Restart was clicked can still read `ready` for a
  // tick, and claiming off that one would target the terminal being replaced.
  // Deferral while inactive mirrors the launch path above.
  useEffect(() => {
    if (!restartPendingRef.current) return;
    if (runtime === undefined) return;
    if (!restartRelaunchSeenRef.current) {
      if (runtime.launchStatus !== 'ready' || !runtime.terminalId) {
        restartRelaunchSeenRef.current = true;
      }
      return;
    }
    if (runtime.launchStatus !== 'ready' || !runtime.terminalId) return;
    if (!isActivePanel) return;
    restartPendingRef.current = false;
    restartRelaunchSeenRef.current = false;
    requestTerminalFocus(
      runtime.terminalId,
      experienceRootRef.current?.ownerDocument ?? document,
    );
  }, [isActivePanel, runtime]);

  // The send path owns the launch only when it queued a prompt to ride along
  // as the CLI's initial argument. A pending auto send WITHOUT a queued
  // message means the prompt was written directly into a live terminal (e.g.
  // after a renderer reload) — this mount effect must still run then, because
  // it doubles as the renderer's rehydration path for live runtimes.
  const hasQueuedMessages = useChatTabRenderState(
    { projectId, worktreeId, chatId },
    ({ tab }) => (tab?.queuedMessages.length ?? 0) > 0,
  );
  const autoSendOwnsLaunch =
    runtime?.autoSendPending === true &&
    !runtime.terminalId &&
    hasQueuedMessages;
  useEffect(() => {
    if (unsupported) return;
    // While an auto-mode send is pending and no terminal exists yet, the
    // send path owns the launch and passes the prompt as the CLI's initial
    // argument. Launching from here would race it with a promptless launch,
    // win the in-flight dedupe, and strand the prompt (it would then be
    // pasted into a TUI that is still booting and get swallowed).
    if (autoSendOwnsLaunch) return;
    // The store guarantees idempotency, so re-running this effect on
    // dependency changes simply resolves with the already-launched runtime.
    void ensureClaudeTerminal(
      chatId,
      { projectId, worktreeId },
      undefined,
      undefined,
      assistantMode ? { assistantMode } : undefined,
    ).catch(() => undefined);
  }, [
    ensureClaudeTerminal,
    chatId,
    projectId,
    worktreeId,
    assistantMode,
    unsupported,
    autoSendOwnsLaunch,
    // Re-fire when the user clicks Restart — `setLaunchAttempt` bumps the
    // counter so the store gets another `ensureLaunch` call.
    launchAttempt,
  ]);

  if (unsupported) {
    return (
      <StatusMessage
        testId="claude-code-experience-unsupported"
        message={COPY_UNAVAILABLE}
      />
    );
  }

  const launchStatus = runtime?.launchStatus ?? 'idle';
  const turnState = runtime?.turnState ?? 'uninitialized';

  if (launchStatus === 'error') {
    return (
      <StatusMessage
        testId="claude-code-experience-launch-error"
        message={runtime?.errorMessage ?? COPY_LAUNCH_FAILED}
        actionLabel="Restart Claude Code"
        onAction={handleRestart}
      />
    );
  }

  if (turnState === 'exited') {
    return (
      <StatusMessage
        testId="claude-code-experience-exited"
        message="Claude Code exited."
        actionLabel="Restart Claude Code"
        onAction={handleRestart}
      />
    );
  }

  if (
    launchStatus !== 'ready' ||
    !runtime?.terminalId ||
    turnState === 'starting' ||
    turnState === 'uninitialized'
  ) {
    return (
      <StatusMessage
        testId="claude-code-experience-starting"
        message={COPY_STARTING}
        spinner
      />
    );
  }

  return (
    <div
      ref={experienceRootRef}
      data-testid="claude-code-experience-ready"
      className="relative flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <TerminalPane
        terminalId={runtime.terminalId}
        // We only reach this branch once the runtime is `ready` and the
        // turn-state has narrowed away from the `'exited'` / `'starting'`
        // variants above, so the PTY is always live here.
        live
        // The managed PTY is created (and lazy-attached) by the launch
        // pathway in the main process; the renderer never restores it on
        // mount the way the drawer terminals do.
        restoreOnMount={false}
        readOnlyMessage={null}
        addToChatSelectionHelper={false}
        pasteDroppedFiles
        focused={isActivePanel}
        onFocus={(): void => {}}
      />
      {runtime.firstOutputAt === undefined ? (
        // A freshly spawned CLI boots silently for seconds (binary cold
        // read, plugin/config load, session resume). Keep the starting copy
        // over the pane until the PTY produces output so the user never
        // stares at a blank screen; the pane stays mounted underneath so it
        // attaches and sizes the PTY correctly while hidden.
        <div
          data-testid="claude-code-experience-booting"
          className="absolute inset-0 z-10 flex items-center justify-center bg-base"
        >
          <div className="flex items-center gap-2 text-s fg-secondary">
            <span
              aria-hidden="true"
              className="inline-block h-3 w-3 animate-pulse rounded-full bg-fg-primary/20"
            />
            <span>{COPY_STARTING}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

interface StatusMessageProps {
  testId: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  spinner?: boolean;
}

function StatusMessage({
  testId,
  message,
  actionLabel,
  onAction,
  spinner,
}: StatusMessageProps): JSX.Element {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6"
      data-testid={testId}
    >
      <div className="flex items-center gap-2 text-s fg-secondary">
        {spinner ? (
          <span
            aria-hidden="true"
            className="inline-block h-3 w-3 animate-pulse rounded-full bg-fg-primary/20"
          />
        ) : null}
        <span>{message}</span>
      </div>
      {actionLabel && onAction ? (
        <button
          type="button"
          onClick={onAction}
          className="focus-ring rounded-md border bg-fg-primary/[0.04] px-3 py-1 text-xs font-medium fg-primary/80 transition hover:bg-fg-primary/[0.08]"
          data-testid={`${testId}-action`}
        >
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}
