import type {
  ScriptAction,
  ScriptActionTarget,
  ScriptActionsSnapshot,
} from '@canopy/protocol/script-actions';
import {
  WORKSPACE_ROOT_REPO_ID,
  WORKSPACE_ROOT_REPO_NAME,
} from '@canopy/protocol/ui-labels';
import { terminalDraftBody } from '../../code/composer/terminal-mode/terminal-command';

/**
 * The repository id script actions use for a single-repository project. The
 * desktop resolves a single repository's checkout from an omitted
 * `selectedRepoId`, so this id is never sent as a terminal target. Mirrors
 * `SINGLE_REPO_USAGE_REPO_ID` in `@canopy/desktop-shared`, which browser
 * packages cannot import.
 */
export const SINGLE_REPOSITORY_TARGET_ID = '__single_repo__';

/** Where the composer would run a raw command. */
export interface ScriptInvocationContext {
  readonly projectId: string;
  readonly worktreeId: string;
  /** The composer's selected repository; null for the project's default. */
  readonly selectedRepoId: string | null;
}

/**
 * A script picked from the `!` typeahead, kept separately from the draft text.
 * It only applies while the draft still starts with `command`.
 */
export interface ScriptInvocation {
  readonly actionId: string;
  readonly revision: string;
  readonly target: ScriptActionTarget;
  readonly repoId: string | null;
  readonly repoName: string | null;
  readonly packagePath: string | null;
  /** The picked command, trimmed; the draft reads `!<command>`. */
  readonly command: string;
  readonly context: ScriptInvocationContext;
}

export function createScriptInvocation(
  action: ScriptAction,
  context: ScriptInvocationContext,
): ScriptInvocation {
  return {
    actionId: action.id,
    revision: action.revision,
    target: action.target,
    repoId: action.repoId,
    repoName: action.repoName,
    packagePath: action.packagePath,
    command: action.command.trim(),
    context,
  };
}

/** The draft a picked script leaves in the composer. */
export function scriptInvocationDraft(invocation: ScriptInvocation): string {
  return `!${invocation.command}`;
}

/**
 * Text appended after the picked command, or null when the draft no longer
 * starts with the command at a whitespace boundary (or equals it). Appended
 * arguments stay on the command's last line: a new line of input ends the
 * invocation, so a raw multiline draft keeps first-line semantics.
 */
export function scriptInvocationArguments(
  invocation: ScriptInvocation,
  draftText: string,
): string | null {
  if (!/^\s*!/.test(draftText)) return null;
  const body = terminalDraftBody(draftText).replace(/\s+$/, '');
  if (!body.startsWith(invocation.command)) return null;
  const rest = body.slice(invocation.command.length);
  if (rest === '') return '';
  if (!/^[^\S\r\n]/.test(rest) || /[\r\n]/.test(rest)) return null;
  return rest;
}

export function scriptInvocationContextMatches(
  invocation: ScriptInvocation,
  context: ScriptInvocationContext,
): boolean {
  return (
    invocation.context.projectId === context.projectId &&
    invocation.context.worktreeId === context.worktreeId &&
    invocation.context.selectedRepoId === context.selectedRepoId
  );
}

export type ScriptInvocationStaleReason =
  | 'missing'
  | 'changed'
  | 'not-approved'
  | 'unavailable';

export type ScriptInvocationCheck =
  | { readonly ok: true; readonly action: ScriptAction }
  | { readonly ok: false; readonly reason: ScriptInvocationStaleReason };

/** Re-check a picked script against a snapshot before it may run. */
export function checkScriptInvocation(
  invocation: ScriptInvocation,
  snapshot: ScriptActionsSnapshot,
): ScriptInvocationCheck {
  const action = snapshot.actions.find(
    (candidate) => candidate.id === invocation.actionId,
  );
  if (!action) return { ok: false, reason: 'missing' };
  if (
    action.revision !== invocation.revision ||
    action.command.trim() !== invocation.command ||
    action.packagePath !== invocation.packagePath ||
    JSON.stringify(action.target) !== JSON.stringify(invocation.target)
  )
    return { ok: false, reason: 'changed' };
  if (action.status !== 'approved')
    return { ok: false, reason: 'not-approved' };
  if (action.unavailableReason !== undefined)
    return { ok: false, reason: 'unavailable' };
  return { ok: true, action };
}

/** Why a picked script did not run; shown in the terminal mode label's place. */
export function scriptInvocationStaleMessage(
  reason: ScriptInvocationStaleReason | 'unverified',
): string {
  switch (reason) {
    case 'missing':
      return "Couldn't run: the script is gone";
    case 'changed':
      return "Couldn't run: the script changed";
    case 'not-approved':
      return "Couldn't run: the script needs review";
    case 'unavailable':
      return "Couldn't run: the script is unavailable";
    case 'unverified':
      return "Couldn't check the script";
  }
}

function terminalRepoId(repoId: string): string | undefined {
  return repoId === SINGLE_REPOSITORY_TARGET_ID ? undefined : repoId;
}

/** The repository a picked script's terminal opens in, as a spawn `selectedRepoId`. */
export function scriptInvocationRepoId(
  invocation: ScriptInvocation,
): string | undefined {
  switch (invocation.target.kind) {
    case 'repository':
      return terminalRepoId(invocation.target.repoId);
    case 'workspace-root':
      // An explicit root, so a selected repository is never used instead.
      return WORKSPACE_ROOT_REPO_ID;
    case 'selected-repository':
      return invocation.context.selectedRepoId === null
        ? undefined
        : terminalRepoId(invocation.context.selectedRepoId);
  }
}

export interface ScriptInvocationSubmission {
  /** The full picked body plus appended arguments. */
  readonly command: string;
  readonly selectedRepoId?: string;
  readonly relativeCwd?: string;
}

/** What a valid invocation sends, or null when the draft no longer carries it. */
export function scriptInvocationSubmission(
  invocation: ScriptInvocation,
  draftText: string,
): ScriptInvocationSubmission | null {
  const args = scriptInvocationArguments(invocation, draftText);
  if (args === null) return null;
  const selectedRepoId = scriptInvocationRepoId(invocation);
  return {
    command: `${invocation.command}${args}`,
    ...(selectedRepoId === undefined ? {} : { selectedRepoId }),
    ...(invocation.packagePath ? { relativeCwd: invocation.packagePath } : {}),
  };
}

/**
 * `Runs in <repo>/<package>` when a picked script runs somewhere other than
 * the composer's own directory; null when that needs no clarification.
 * `multiRepo` false means the project has one repository to run in.
 */
export function scriptInvocationHint(
  invocation: ScriptInvocation,
  multiRepo: boolean,
): string | null {
  const selected = invocation.context.selectedRepoId;
  let repoLabel: string | null = null;
  let differs = false;
  switch (invocation.target.kind) {
    case 'repository': {
      const repoId = invocation.target.repoId;
      repoLabel =
        repoId === WORKSPACE_ROOT_REPO_ID
          ? WORKSPACE_ROOT_REPO_NAME
          : (invocation.repoName ?? null);
      differs =
        multiRepo &&
        repoId !== SINGLE_REPOSITORY_TARGET_ID &&
        (selected ?? WORKSPACE_ROOT_REPO_ID) !== repoId;
      break;
    }
    case 'workspace-root':
      repoLabel = WORKSPACE_ROOT_REPO_NAME;
      differs =
        multiRepo && selected !== null && selected !== WORKSPACE_ROOT_REPO_ID;
      break;
    case 'selected-repository':
      break;
  }
  if (!differs && !invocation.packagePath) return null;
  const location = [repoLabel, invocation.packagePath]
    .filter((part): part is string => typeof part === 'string' && part !== '')
    .join('/');
  return location ? `Runs in ${location}` : null;
}
