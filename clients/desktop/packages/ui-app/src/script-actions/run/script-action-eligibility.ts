import type { CanopyCapabilities } from '@canopy/app-core';
import type { ScriptAction } from '@canopy/protocol/script-actions';
import { SINGLE_REPOSITORY_TARGET_ID } from '../typeahead/invocation';

/** How a run was requested. Shortcuts additionally require a conflict-free binding. */
export type ScriptActionRunVia = 'pin' | 'shortcut';

export type ScriptActionRunErrorCode =
  /** The host lacks `scriptActions` or `terminalPty`. */
  | 'unsupported'
  /** No active, writable worktree context. */
  | 'inactive'
  /** The action is missing from the current snapshot. */
  | 'not-found'
  /** The caller's revision is older than the current definition. */
  | 'stale'
  /** The current definition is pending or dismissed. */
  | 'not-approved'
  /** The current definition cannot run here (`unavailableReason`). */
  | 'unavailable'
  /** The binding is shared with another action or a reserved chord. */
  | 'shortcut-conflict'
  /** `terminal.list` failed, so reuse could not be decided safely. */
  | 'status-unavailable';

const DEFAULT_MESSAGES: Record<ScriptActionRunErrorCode, string> = {
  unsupported: "Scripts can't run in a terminal here.",
  inactive: 'Open this worktree to run its scripts.',
  'not-found': 'This script is no longer available.',
  stale: 'This script changed. Review it, then run it again.',
  'not-approved': 'Review this script before running it.',
  unavailable: "This script can't run here.",
  'shortcut-conflict': 'This shortcut is already used.',
  'status-unavailable':
    "Couldn't check whether this script is still running. Try again.",
};

/** A run refused before any terminal work, or a reuse check that failed. */
export class ScriptActionRunError extends Error {
  readonly code: ScriptActionRunErrorCode;
  // `declare`: only some programs' libs (via type-fest) give Error a `cause`.
  declare readonly cause: unknown;

  constructor(
    code: ScriptActionRunErrorCode,
    message?: string,
    cause?: unknown,
  ) {
    super(message ?? DEFAULT_MESSAGES[code]);
    this.name = 'ScriptActionRunError';
    this.code = code;
    this.cause = cause;
  }
}

/** Execution needs both the review API and a local PTY. Portal and cloud have no PTY. */
export function scriptActionExecutionSupported(
  capabilities: Pick<CanopyCapabilities, 'scriptActions' | 'terminalPty'>,
): boolean {
  return (
    capabilities.scriptActions === true && capabilities.terminalPty === true
  );
}

/**
 * Why `action` cannot run through `via`, or null when it can. Approval is the
 * current definition's own: a pending, dismissed or unavailable action never
 * runs, and a shortcut also needs a binding the service did not mark as
 * conflicting.
 */
export function scriptActionRunBlock(
  action: ScriptAction,
  via: ScriptActionRunVia,
): ScriptActionRunError | null {
  if (action.status !== 'approved')
    return new ScriptActionRunError('not-approved');
  if (action.unavailableReason !== undefined)
    return new ScriptActionRunError('unavailable', action.unavailableReason);
  if (via === 'shortcut' && action.shortcutConflict !== undefined)
    return new ScriptActionRunError(
      'shortcut-conflict',
      action.shortcutConflict,
    );
  return null;
}

/** An approved, available, pinned action: the only kind a top bar may render as runnable. */
export function isRunnablePinnedScriptAction(action: ScriptAction): boolean {
  return action.pinned && scriptActionRunBlock(action, 'pin') === null;
}

/** Spawn target for one run of an action. */
export interface ResolvedScriptActionTarget {
  /** Omitted for the workspace root (the service's default cwd). */
  readonly selectedRepoId?: string;
  /** Package directory beneath the target; null for none. */
  readonly relativeCwd: string | null;
  /**
   * Stable identity of the execution target. Alias runs in different selected
   * repositories resolve to different values, so they never share a terminal.
   */
  readonly targetKey: string;
}

/**
 * Maps the action's execution target onto terminal spawn arguments:
 * `repository` runs in that repository; `selected-repository` (aliases) runs
 * in the host's current selected repository, or the default directory when
 * none is selected; `workspace-root` omits the repository so the service
 * spawns in the worktree root.
 */
export function resolveScriptActionTarget(
  action: Pick<ScriptAction, 'target' | 'packagePath'>,
  selectedRepoId: string | null | undefined,
): ResolvedScriptActionTarget {
  const relativeCwd =
    action.packagePath === null || action.packagePath === ''
      ? null
      : action.packagePath;
  const target = action.target;
  if (target.kind === 'repository')
    return {
      // A single-repository checkout is the worktree itself, not a named repository.
      ...(target.repoId === SINGLE_REPOSITORY_TARGET_ID
        ? {}
        : { selectedRepoId: target.repoId }),
      relativeCwd,
      targetKey: `repository:${target.repoId}`,
    };
  if (
    target.kind === 'selected-repository' &&
    typeof selectedRepoId === 'string' &&
    selectedRepoId !== ''
  )
    return {
      selectedRepoId,
      relativeCwd,
      targetKey: `selected:${selectedRepoId}`,
    };
  return {
    relativeCwd,
    targetKey:
      target.kind === 'workspace-root' ? 'workspace-root' : 'selected:',
  };
}
