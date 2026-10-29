'use client';

import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react';
import type { CanopyClient } from '@canopy/app-core';
import { useCanopyClient } from '@canopy/app-state';
import type { ScriptAction } from '@canopy/protocol/script-actions';
import type { TerminalSession } from '@canopy/protocol/terminal';
import { runCommandInTerminal } from '../run-command-in-terminal';
import {
  resolveScriptActionTarget,
  scriptActionExecutionSupported,
  scriptActionRunBlock,
  ScriptActionRunError,
  type ScriptActionRunVia,
} from './script-action-eligibility';
import {
  scriptActionRunKey,
  scriptActionRunRegistryFor,
  type ScriptActionRunOutcome,
} from './script-action-run-registry';

/** Host terminal integration injected by each platform. */
export interface ScriptActionRunHost {
  /** Terminal-store hydration before the new PTY joins the layout. */
  readonly hydrate?: () => Promise<void>;
  /** Add a new session to the host layout and show it. */
  readonly reveal?: (session: TerminalSession) => void;
  /** Show and focus a still-running session instead of spawning. */
  readonly revealExisting?: (session: TerminalSession) => void;
  /** PTY size for a new session; defaults to 80x24. */
  readonly spawnSize?: () => { readonly cols: number; readonly rows: number };
}

export interface UseRunScriptActionOptions {
  readonly projectId: string | null | undefined;
  readonly worktreeId: string | null | undefined;
  /** Current snapshot actions; runs always use the current definition. */
  readonly actions: readonly ScriptAction[] | null | undefined;
  /** The worktree is on screen and focused enough to take a run. */
  readonly active: boolean;
  /** False while the worktree is locked (split, archive). Defaults to true. */
  readonly writable?: boolean;
  /** The host's current selected repository, for `selected-repository` aliases. */
  readonly selectedRepoId?: string | null;
  readonly host: ScriptActionRunHost;
}

export interface UseRunScriptActionResult {
  /** `scriptActions` and `terminalPty` are both available. */
  readonly supported: boolean;
  /** Supported, with an active and writable worktree context. */
  readonly enabled: boolean;
  /**
   * Reveal the action's still-running terminal or start it in a new one.
   * Rejects with {@link ScriptActionRunError} when refused, or the runner's
   * `TerminalRunError` when the terminal failed. Never retries.
   */
  readonly run: (
    action: ScriptAction,
    via: ScriptActionRunVia,
  ) => Promise<ScriptActionRunOutcome>;
  /** Whether the terminal last started for `action` reports a running command. */
  readonly isRunning: (action: ScriptAction) => boolean;
  /** Whether a run for `action` is being started. */
  readonly isPending: (action: ScriptAction) => boolean;
}

const DEFAULT_SPAWN_SIZE = { cols: 80, rows: 24 } as const;

let runSequence = 0;
function nextIdempotencyKey(): string {
  runSequence += 1;
  return `script-action-${Date.now().toString(36)}-${runSequence}-${Math.random().toString(36).slice(2)}`;
}

function runKeyFor(
  projectId: string | null | undefined,
  worktreeId: string | null | undefined,
  action: ScriptAction,
  selectedRepoId: string | null | undefined,
): string | null {
  if (!projectId || !worktreeId) return null;
  const target = resolveScriptActionTarget(action, selectedRepoId);
  return scriptActionRunKey({
    projectId,
    worktreeId,
    targetKey: target.targetKey,
    relativeCwd: target.relativeCwd,
    actionId: action.id,
    revision: action.revision,
  });
}

/** {@link useRunScriptActionWithClient} with the provider's client. */
export function useRunScriptAction(
  options: UseRunScriptActionOptions,
): UseRunScriptActionResult {
  return useRunScriptActionWithClient(useCanopyClient(), options);
}

/**
 * Pin and shortcut execution for one worktree. Every call re-checks the
 * capabilities, the context, and the CURRENT definition's approval, target
 * and package directory, so a hidden or stale control cannot run anything
 * the service no longer approves. Runs reuse a still-running terminal for the
 * same action, revision and execution target; composer sends do not use this.
 */
export function useRunScriptActionWithClient(
  client: CanopyClient,
  {
    projectId,
    worktreeId,
    actions,
    active,
    writable = true,
    selectedRepoId,
    host,
  }: UseRunScriptActionOptions,
): UseRunScriptActionResult {
  const registry = scriptActionRunRegistryFor(client);
  const runState = useSyncExternalStore(
    registry.subscribe,
    registry.getState,
    registry.getState,
  );
  const supported = scriptActionExecutionSupported(client.capabilities);
  const context =
    typeof projectId === 'string' &&
    projectId !== '' &&
    typeof worktreeId === 'string' &&
    worktreeId !== ''
      ? { projectId, worktreeId }
      : null;
  const enabled = supported && active && writable && context !== null;

  // `run` reads the latest render's inputs, so a pin rendered before an
  // approval change still checks the definition current at click time.
  const latest = useRef({
    enabled,
    supported,
    context,
    actions,
    selectedRepoId,
    host,
  });
  latest.current = {
    enabled,
    supported,
    context,
    actions,
    selectedRepoId,
    host,
  };

  const run = useCallback(
    async (
      requested: ScriptAction,
      via: ScriptActionRunVia,
    ): Promise<ScriptActionRunOutcome> => {
      const state = latest.current;
      if (!state.supported) throw new ScriptActionRunError('unsupported');
      if (!state.enabled || state.context === null)
        throw new ScriptActionRunError('inactive');
      const rendered = state.actions?.find(
        (candidate) => candidate.id === requested.id,
      );
      if (rendered === undefined) throw new ScriptActionRunError('not-found');
      if (rendered.revision !== requested.revision)
        throw new ScriptActionRunError('stale');
      const renderedBlock = scriptActionRunBlock(rendered, via);
      if (renderedBlock !== null) throw renderedBlock;
      const action = rendered;

      const { projectId: runProjectId, worktreeId: runWorktreeId } =
        state.context;
      const target = resolveScriptActionTarget(action, state.selectedRepoId);
      const key = scriptActionRunKey({
        projectId: runProjectId,
        worktreeId: runWorktreeId,
        targetKey: target.targetKey,
        relativeCwd: target.relativeCwd,
        actionId: action.id,
        revision: action.revision,
      });
      const runHost = state.host;
      const size = runHost.spawnSize?.() ?? DEFAULT_SPAWN_SIZE;
      return registry.run(
        key,
        {
          projectId: runProjectId,
          worktreeId: runWorktreeId,
          actionId: action.id,
        },
        () =>
          runCommandInTerminal({
            client,
            spawn: {
              projectId: runProjectId,
              worktreeId: runWorktreeId,
              ...(target.selectedRepoId !== undefined
                ? { selectedRepoId: target.selectedRepoId }
                : {}),
              relativeCwd: target.relativeCwd,
              cols: size.cols,
              rows: size.rows,
            },
            command: action.command,
            ...(runHost.hydrate ? { hydrate: runHost.hydrate } : {}),
            ...(runHost.reveal ? { reveal: runHost.reveal } : {}),
            idempotencyKey: nextIdempotencyKey(),
          }),
        runHost.revealExisting,
        async () => {
          const snapshot = await client.command('scriptActions.rescan', {
            projectId: runProjectId,
            worktreeId: runWorktreeId,
          });
          const current = latest.current;
          if (
            !current.enabled ||
            current.context?.projectId !== runProjectId ||
            current.context.worktreeId !== runWorktreeId ||
            current.selectedRepoId !== state.selectedRepoId
          )
            throw new ScriptActionRunError('inactive');
          const freshAction = snapshot.actions.find(
            (candidate) => candidate.id === requested.id,
          );
          if (!freshAction) throw new ScriptActionRunError('not-found');
          if (freshAction.revision !== requested.revision)
            throw new ScriptActionRunError('stale');
          const block = scriptActionRunBlock(freshAction, via);
          if (block !== null) throw block;
        },
      );
    },
    [client, registry],
  );

  const keyFor = useCallback(
    (action: ScriptAction): string | null =>
      runKeyFor(projectId, worktreeId, action, selectedRepoId),
    [projectId, worktreeId, selectedRepoId],
  );
  const isRunning = useCallback(
    (action: ScriptAction): boolean => {
      const key = keyFor(action);
      return key !== null && runState.running.has(key);
    },
    [keyFor, runState],
  );
  const isPending = useCallback(
    (action: ScriptAction): boolean => {
      const key = keyFor(action);
      return key !== null && runState.pending.has(key);
    },
    [keyFor, runState],
  );

  return useMemo(
    () => ({ supported, enabled, run, isRunning, isPending }),
    [supported, enabled, run, isRunning, isPending],
  );
}
