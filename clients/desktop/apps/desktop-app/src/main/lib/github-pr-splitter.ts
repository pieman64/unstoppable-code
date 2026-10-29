import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type {
  PrDiffSnapshot,
  RepoPrTrackingData,
  SplitPlan,
  SplitPlanChild,
  SplitPrChild,
  SplitPrExecutionErrorCode,
  SplitPrMap,
  SplitPrPhase,
  SplitPrProgressEvent,
} from '@canopy/desktop-shared/types/github';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type { HunkRun } from '@canopy/desktop-shared/node/lib/pr-split-diff';
import {
  buildPatchFromRuns,
  computeChildBaseDiffU0,
  matchRunsToOriginalHunks,
  planChildCarve,
} from '@canopy/desktop-shared/node/lib/pr-split-diff';
import {
  deriveSplitBranchNames,
  topologicalChildOrder,
  validateSplitPlan,
} from '@canopy/desktop-shared/lib/pr-split-plan';
import { getEnhancedEnv } from '@canopy/desktop-shared/pipelines/config-paths';
import { findExecutableOnPath } from '@canopy/desktop-shared/node/lib/path-lookup';
import {
  addDetachedWorktree,
  applyIndexPatch,
  checkoutBranch,
  checkoutPathsFromRef,
  cleanUntrackedFiles,
  commitWithMessage,
  createBranchWithEmptyCommit,
  doesRemoteBranchExist,
  fetchOrigin,
  getCheckedOutBranch,
  getTreeSha,
  hasUncommittedChanges,
  isAncestor,
  isBranchNameAvailable,
  mergeBranch,
  pushNamedBranch,
  removeGitWorktree,
  removePaths,
  resetHardTo,
  resolveRefSha,
  stageAllChanges,
} from './git';
import {
  closePrForRepo,
  createPrForRepo,
  fetchRepoPrTrackingData,
  listOpenPrsBasedOnBranchForRepo,
  updatePrBaseBranchForRepo,
  updatePrBodyForRepo,
} from './github-pr';
import { getCommitLog, getFullDiff } from './git';
import { generatePrContent } from './github-pr-generator';
import { readPreferencesFile } from './preferences-store';
import { resolveWorktreeCwd } from './resolve-worktree';
import { readSplitPrMap, writeSplitPrMap } from './split-pr-persistence';
import { createSingleRepoWorktree } from './worktree-service';
import { sendToWindow } from './window-send';
import { runProjectWorktreePostCreateSetup } from './project-worktree-runtime';
import { readWorkspaceConfig } from './workspace-persistence';
import { observeWorktreeGit } from './worktree-git-observations';
import type { BrowserWindow } from 'electron';
import { settleAll } from '@canopy/desktop-shared/node/lib/detached-work';

const VERIFY_TAIL_MAX_CHARS = 4000;
const VERIFY_MAX_BUFFER_BYTES = 1024 * 1024 * 16;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when a git or matcher step fails while carving a child branch. Carries
 * the file and the involved hunk headers so callers can surface a precise
 * failure to the user. The child worktree is restored to `childBaseRef` before
 * this is thrown.
 */
export class CarveError extends Error {
  readonly file: string;
  readonly hunkHeaders: string[];

  constructor(message: string, file: string, hunkHeaders: string[]) {
    super(message);
    this.name = 'CarveError';
    this.file = file;
    this.hunkHeaders = hunkHeaders;
  }
}

/**
 * Thrown when a carve is aborted between major steps via the supplied signal.
 * Named `AbortError` so it matches the repo-wide convention
 * (`error.name === 'AbortError'`) for distinguishing cancellations.
 */
export class CarveAbortError extends Error {
  constructor(message = 'Carve aborted') {
    super(message);
    this.name = 'AbortError';
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new CarveAbortError();
  }
}

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface SplitterDeps {
  createWorktree: (opts: {
    workspaceId: string;
    branchName: string;
    baseBranch: string;
    startPostCreateSetup: boolean;
  }) => Promise<{ id: string }>;
  /**
   * Run the project's post-create setup script to completion inside the child
   * worktree and report the outcome. Called by `processChild` after the child
   * worktree exists and before the carve/verify runs so the verify command
   * observes a set-up worktree (e.g. `node_modules` installed) rather than a
   * bare checkout.
   *
   * Semantics:
   * - `skipped` — no setup script configured; proceed silently.
   * - `completed` — setup exited 0; proceed.
   * - `failed` — setup exited non-zero, timed out, or threw. The split
   *   intentionally PROCEEDS to carve/verify anyway (recording a progress
   *   message): the verify result should then reflect the real, partially
   *   set-up environment instead of hard-failing the whole split on a setup
   *   hiccup.
   *
   * `signal` is honored: aborting during setup kills the running setup process
   * (the underlying runner kills the process group) and the split routes to the
   * standard cancellation path before carving.
   */
  runWorktreeSetup: (
    worktreeId: string,
    signal: AbortSignal,
  ) => Promise<{
    status: 'completed' | 'failed' | 'skipped';
    detail?: string;
  }>;
  setWorktreeGrouping: (
    workspaceId: string,
    worktreeId: string,
  ) => Promise<void>;
  createPr: typeof createPrForRepo;
  closePr: typeof closePrForRepo;
  updatePrBody: typeof updatePrBodyForRepo;
  /**
   * List open PRs whose base branch is the given branch. Used at finalize time
   * to find sibling PRs still based on the original head branch so they can be
   * retargeted onto the new integration branch (nested/mid-stack splits).
   */
  listOpenPrsBasedOnBranch: typeof listOpenPrsBasedOnBranchForRepo;
  updatePrBase: typeof updatePrBaseBranchForRepo;
  updateOriginalWorktree: (
    workspaceId: string,
    worktreeId: string,
    patch: { branchName: string; trackedBaseBranch: string },
  ) => Promise<void>;
  readMap: (
    workspaceId: string,
    worktreeId: string,
  ) => Promise<SplitPrMap | null>;
  writeMap: (
    workspaceId: string,
    worktreeId: string,
    map: SplitPrMap,
  ) => Promise<boolean>;
  runVerifyCommand: (
    cwd: string,
    command: string,
    signal: AbortSignal,
  ) => Promise<{ exitCode: number; tail: string }>;
  resolveChildWorktreePath: (worktreeId: string) => Promise<string>;
  resolveOriginalWorktreePath: (worktreeId: string) => Promise<string>;
  fetchPrData: (
    repoPath: string,
    branchName?: string,
  ) => Promise<RepoPrTrackingData>;
  /**
   * Generate a title/body for a child PR using the SAME rules as the normal
   * "Create PR" flow (honoring the user's Git PR-generation settings: model,
   * thinking level, instructions, and the repo's PR template), diffing the
   * child worktree/branch against the child's base. Runs right before a child
   * PR is opened, once the child has carved+verified green and both it and its
   * dependencies are pushed (so `origin/<childBase>` and the child branch exist
   * for the diff).
   *
   * Returns `{ title, body }` where `title` is WITHOUT the `[X/Y]` prefix and
   * `body` is WITHOUT the appended stack block — the splitter prepends the
   * numbering and appends the stack block itself. Returns `null` when
   * generation is unavailable or failed, in which case the splitter falls back
   * to the planner-derived title and the provisional stack-only body. The
   * default implementation self-observes as a `pr_generation` audit task, one
   * per child, exactly like a normal Create PR.
   */
  generateChildPrContent: (args: {
    worktreePath: string;
    branchName: string;
    baseBranch: string;
  }) => Promise<{ title: string; body: string } | null>;
  validatePlan: typeof validateSplitPlan;
}

// ---------------------------------------------------------------------------
// Verify runner (allowlisted env)
// ---------------------------------------------------------------------------

/**
 * POSIX verify-env allowlist beyond PATH: a home directory, a temp directory,
 * and the locale. Never inherit the broad ambient environment or Canopy
 * secrets.
 */
const POSIX_VERIFY_ENV_KEYS = ['HOME', 'TMPDIR', 'LANG'] as const;

/**
 * Windows verify-env allowlist beyond PATH. Windows subprocesses need a
 * baseline set of system variables the POSIX list does not cover:
 * `SystemRoot`/`windir` (many CRT/network calls fail without them), `ComSpec`
 * (the command interpreter), and `PATHEXT` (so extensionless executables like
 * `npm` resolve). Home/temp come from `USERPROFILE` and `TEMP`/`TMP` rather than
 * `HOME`/`TMPDIR`. `LANG` is preserved when present but is not typical on
 * Windows. This is still an explicit allowlist — `process.env` is never spread.
 */
const WINDOWS_VERIFY_ENV_KEYS = [
  'SystemRoot',
  'windir',
  'ComSpec',
  'PATHEXT',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'TEMP',
  'TMP',
  'LANG',
] as const;

/**
 * Build the environment handed to the verify subprocess. This is an explicit
 * allowlist, NOT inherited `process.env`: the resolved login-shell PATH (with
 * the bundled bin dir prepended, via `getEnhancedEnv`) plus a small
 * platform-appropriate set of variables the child process needs to function.
 * A user-authored build/test command must be able to find tools on PATH and
 * reach a home/temp directory, but must not inherit Canopy secrets or the broad
 * ambient environment.
 *
 * PATH key casing: `getEnhancedEnv` always emits the canonical uppercase `PATH`
 * key on every platform (it explicitly sets `PATH: pathValue`), so mirroring
 * `env.PATH` here matches the repo-wide convention. Node's Windows
 * `child_process` treats env var names case-insensitively when resolving the
 * executable, so a single uppercase `PATH` entry is sufficient there.
 */
export function buildVerifyEnv(): Record<string, string> {
  const env: Record<string, string> = {};

  // getEnhancedEnv resolves the login-shell PATH with the bundled bin dir
  // prepended. `environment: false` skips user-environment injection so we do
  // not fold Canopy-managed user vars/secrets into the allowlist.
  const enhanced = getEnhancedEnv({
    environment: false,
    includeCanopySecrets: false,
  });
  const resolvedPath = enhanced.PATH;
  if (resolvedPath) {
    env.PATH = resolvedPath;
  }

  const keys =
    process.platform === 'win32'
      ? WINDOWS_VERIFY_ENV_KEYS
      : POSIX_VERIFY_ENV_KEYS;
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }

  return env;
}

/**
 * Resolve the shell invocation for the verify command: `/bin/sh -c <command>`
 * on POSIX, and on win32 a PowerShell-7-first / cmd.exe-fallback strategy —
 * deliberately **not** Windows PowerShell (`powershell.exe`) at all.
 *
 * Rationale: verify commands are user-authored shell strings, and the split
 * PR planner explicitly recommends chained forms like `npm ci && npm test`.
 * Windows PowerShell 5.1 (the `powershell.exe` that ships on every stock
 * Windows install) treats `&&`/`||` as **parse errors** — that operator syntax
 * was only added in PowerShell 7 (`pwsh.exe`). Routing verify through
 * `powershell.exe -Command` therefore fails every such command at the parser
 * before it runs anything, and the split PR runner would misreport that as a
 * red/failing verify rather than a shell incompatibility. So win32 resolution
 * order is:
 *
 * 1. `pwsh.exe` on PATH (via `findExecutableOnPath`, matching the repo's
 *    terminals-prefer-pwsh convention) → `pwsh.exe -NoProfile -NonInteractive
 *    -Command <command>`. PS7 supports `&&`/`||` natively, so the
 *    recommended command shape works unmodified.
 * 2. Otherwise, `cmd.exe` (resolved via the `ComSpec` env var when set, else
 *    the literal `cmd.exe` name so the OS resolver finds it via PATH) →
 *    `cmd.exe /d /s /c "<command>"`, following Node's own `shell: true`
 *    convention on Windows: the entire command is wrapped in one extra pair of
 *    quotes and passed as a SINGLE verbatim argument (`windowsVerbatimArguments:
 *    true`), rather than as a plain `execFile` arg that libuv would re-quote
 *    itself. libuv's default argument quoting (`windowsVerbatimArguments`
 *    unset/false) escapes embedded quotes in a way that mangles command
 *    strings containing quotes, so callers MUST pass `windowsVerbatimArguments:
 *    true` to `execFile`/`spawn` when using this cmd branch. `%VAR%` and
 *    embedded newlines are rejected up front (mirroring
 *    `quoteCmdArgument` in `packages/desktop-shared/src/node/lib/windows-process.ts`)
 *    because cmd.exe silently expands `%VAR%` references and cannot represent
 *    a literal newline inside a single command line — both would otherwise run
 *    something other than what the user authored without any error.
 */
export interface VerifyShellSpec {
  file: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

const CMD_REJECTED_CHARACTERS_MESSAGE =
  'Verify command contains "%" or a newline, which cannot be safely passed through cmd.exe (environment variables would be expanded or the command line would be truncated). Install PowerShell 7 (pwsh.exe) or rewrite the command to avoid these characters.';

export function resolveVerifyShellSpec(command: string): VerifyShellSpec {
  if (process.platform === 'win32') {
    const pwsh = findExecutableOnPath('pwsh.exe');
    if (pwsh) {
      return {
        file: pwsh,
        args: ['-NoProfile', '-NonInteractive', '-Command', command],
      };
    }
    if (
      command.includes('%') ||
      command.includes('\n') ||
      command.includes('\r')
    ) {
      throw new Error(CMD_REJECTED_CHARACTERS_MESSAGE);
    }
    const cmd = process.env.ComSpec || 'cmd.exe';
    return {
      file: cmd,
      args: ['/d', '/s', '/c', `"${command}"`],
      windowsVerbatimArguments: true,
    };
  }
  return { file: '/bin/sh', args: ['-c', command] };
}

function tailString(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(text.length - maxChars) : text;
}

/**
 * Run a user-authored shell command string in `cwd`, honoring `signal`.
 *
 * The command is executed via the platform-appropriate shell resolved by
 * `resolveVerifyShellSpec` — `/bin/sh -c <command>` on POSIX, `pwsh.exe`
 * (falling back to `cmd.exe`) on Windows — with the allowlisted verify
 * environment. The cmd.exe branch's `windowsVerbatimArguments` flag is passed
 * through to `execFile` unmodified so its manually-wrapped single verbatim
 * argument is not re-quoted by libuv's default Windows argument escaping.
 * Combined stdout+stderr is captured; only the last ~4000 chars are returned
 * as `tail`. On abort the subprocess is killed and the runner resolves with
 * the observed exit code (non-zero), letting `carveChild` classify the result
 * — abort BETWEEN steps is handled by the caller.
 *
 * If `resolveVerifyShellSpec` rejects the command (cmd.exe branch only, for
 * `%`/newline-containing commands), that is reported as a synchronous
 * non-zero-exit-code verify failure (`tail` carries the rejection detail)
 * rather than throwing, so it is classified the same way as any other red
 * verify instead of aborting the whole split.
 *
 * Kill portability: `child.kill('SIGTERM')` is portable per the Node docs —
 * on Windows the signal name is accepted but process termination is
 * unconditional (there is no graceful SIGTERM), which is acceptable for a
 * cancelled verify.
 */
function defaultRunVerifyCommand(
  cwd: string,
  command: string,
  signal: AbortSignal,
): Promise<{ exitCode: number; tail: string }> {
  let shellSpec: VerifyShellSpec;
  try {
    shellSpec = resolveVerifyShellSpec(command);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return Promise.resolve({ exitCode: 1, tail: detail });
  }

  return new Promise((resolvePromise) => {
    let combined = '';
    let settled = false;

    const child = execFile(
      shellSpec.file,
      shellSpec.args,
      {
        cwd,
        env: buildVerifyEnv(),
        maxBuffer: VERIFY_MAX_BUFFER_BYTES,
        windowsHide: process.platform === 'win32',
        windowsVerbatimArguments: shellSpec.windowsVerbatimArguments,
      },
      (error, stdout, stderr) => {
        signal.removeEventListener('abort', onAbort);
        combined += `${stdout ?? ''}${stderr ?? ''}`;
        const tail = tailString(combined, VERIFY_TAIL_MAX_CHARS);
        if (settled) {
          return;
        }
        settled = true;
        const exitCode =
          error && typeof error.code === 'number' ? error.code : error ? 1 : 0;
        resolvePromise({ exitCode, tail });
      },
    );

    const onAbort = (): void => {
      child.kill('SIGTERM');
    };

    if (signal.aborted) {
      child.kill('SIGTERM');
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

// ---------------------------------------------------------------------------
// buildDefaultSplitterDeps
// ---------------------------------------------------------------------------

/**
 * Wire the production `SplitterDeps` from concrete main-process helpers.
 *
 * `resolveWorktreeCwd` needs the owning workspace id to resolve a worktree
 * checkout path, so `resolveChildWorktreePath` closes over `workspaceId` while
 * keeping the dep's public shape `(worktreeId) => Promise<string>`.
 */
export function buildDefaultSplitterDeps(
  workspaceId: string,
  originalWorktreeId: string,
  getWindow: () => BrowserWindow | null = () => null,
): SplitterDeps {
  // The split engine mutates `worktrees.json` entirely main-side (child
  // creation, grouping, original retarget) with no IPC response for the
  // renderer to fold in. Broadcasting `workspaceWorktreesUpdated` after each
  // persist tells the sidebar store to silently re-read the workspace so the
  // child rows, their integration-branch grouping, and the retargeted original
  // branch label appear live as the split progresses. The fake deps used by
  // the engine's unit/integration tests do not go through this builder, so the
  // harness is unaffected.
  const notifyWorktreesUpdated = (eventWorkspaceId: string): void => {
    const window = getWindow();
    if (!window) {
      return;
    }
    sendToWindow(window, IPC_CHANNELS.workspaceWorktreesUpdated, {
      workspaceId: eventWorkspaceId,
    });
  };
  return {
    createWorktree: async (opts): Promise<{ id: string }> => {
      const response = await createSingleRepoWorktree({
        workspaceId: opts.workspaceId,
        branchName: opts.branchName,
        baseBranch: opts.baseBranch,
        startPostCreateSetup: opts.startPostCreateSetup,
      });
      notifyWorktreesUpdated(opts.workspaceId);
      return { id: response.id };
    },
    runWorktreeSetup: async (
      worktreeId: string,
      signal: AbortSignal,
    ): Promise<{
      status: 'completed' | 'failed' | 'skipped';
      detail?: string;
    }> => {
      const config = await readWorkspaceConfig(workspaceId);
      if (config.type !== 'single-repo' || !config.repoPath) {
        // Split PR is single-repo only; a non-single-repo config has no
        // project setup script to run, so treat it as a no-op.
        return { status: 'skipped' };
      }
      return runProjectWorktreePostCreateSetup({
        projectId: workspaceId,
        worktreeId,
        project: { repoPath: config.repoPath, scripts: config.scripts },
        getWindow,
        signal,
      });
    },
    setWorktreeGrouping: async (
      wsId: string,
      worktreeId: string,
    ): Promise<void> => {
      await observeWorktreeGit({
        kind: 'split-child-grouping',
        workspaceId: wsId,
        worktreeId,
      });
      notifyWorktreesUpdated(wsId);
    },
    createPr: createPrForRepo,
    closePr: closePrForRepo,
    updatePrBody: updatePrBodyForRepo,
    listOpenPrsBasedOnBranch: listOpenPrsBasedOnBranchForRepo,
    updatePrBase: updatePrBaseBranchForRepo,
    updateOriginalWorktree: async (
      wsId: string,
      worktreeId: string,
      patch: { branchName: string; trackedBaseBranch: string },
    ): Promise<void> => {
      await observeWorktreeGit({
        kind: 'split-original-retarget',
        workspaceId: wsId,
        worktreeId,
        branchName: patch.branchName,
        trackedBaseBranch: patch.trackedBaseBranch,
      });
      notifyWorktreesUpdated(wsId);
    },
    readMap: readSplitPrMap,
    writeMap: writeSplitPrMap,
    runVerifyCommand: defaultRunVerifyCommand,
    resolveChildWorktreePath: (worktreeId: string): Promise<string> =>
      Promise.resolve(resolveWorktreeCwd(workspaceId, worktreeId)),
    resolveOriginalWorktreePath: (worktreeId: string): Promise<string> =>
      Promise.resolve(resolveWorktreeCwd(workspaceId, worktreeId)),
    fetchPrData: async (
      repoPath: string,
      branchName?: string,
    ): Promise<RepoPrTrackingData> => {
      // When a branch is supplied (resume path), detect against THAT branch's
      // PR regardless of the current checkout — after retarget the checkout is
      // the integration branch, whose open PR is the integration PR, not the
      // original. When omitted (fresh run), resolve the checked-out branch as
      // before.
      const branch = branchName ?? (await getCheckedOutBranch(repoPath));
      if (!branch) {
        throw new SplitPrExecutionError(
          'Cannot split a detached HEAD; check out the PR branch first',
        );
      }
      return fetchRepoPrTrackingData(repoPath, branch, { priority: 'high' });
    },
    generateChildPrContent: async (args: {
      worktreePath: string;
      branchName: string;
      baseBranch: string;
    }): Promise<{ title: string; body: string } | null> => {
      // Mirror the normal Create PR flow (`processRepoForPr` in
      // `ipc/github.ts`): read the user's PR-generation settings, gather the
      // diff/commit log of the child branch against ITS base, and invoke the
      // same observed `generatePrContent` helper (which self-observes as a
      // `pr_generation` audit task and honors the repo PR template + PR
      // instructions). `origin/<baseBranch>` and the child branch are already
      // pushed before this runs, so the base-relative diff resolves. Any
      // failure returns null so the splitter falls back to its provisional
      // title/body rather than aborting the split.
      try {
        const prefs = await readPreferencesFile();
        const prGenerationModel = prefs.prGenerationModel;
        const [diff, commitLog] = await settleAll([
          getFullDiff(args.worktreePath, args.baseBranch),
          getCommitLog(args.worktreePath, args.baseBranch),
        ]);
        if (!diff.trim() && !commitLog.trim()) {
          return null;
        }
        const content = await generatePrContent({
          repoPath: args.worktreePath,
          branchName: args.branchName,
          baseBranch: args.baseBranch,
          diff,
          commitLog,
          model: prGenerationModel,
          thinkingLevel: prefs.prGenerationThinkingLevel,
          instructions: prefs.prInstructions,
          instructionMode: prefs.prInstructionMode,
          pluginSelections: prefs.prGenerationPluginSelections,
          auditContext: {
            projectId: workspaceId,
            worktreeId: originalWorktreeId,
            repoLabel: basename(args.worktreePath),
          },
        });
        return { title: content.title, body: content.body };
      } catch {
        // Generation is best-effort. Swallow and fall back to the provisional
        // title/body so a transient LLM/settings failure never aborts a split.
        return null;
      }
    },
    validatePlan: validateSplitPlan,
  };
}

// ---------------------------------------------------------------------------
// carveChild
// ---------------------------------------------------------------------------

export interface CarveChildResult {
  commitSha: string;
  verify: { status: 'green' | 'red' | 'skipped'; tail?: string };
}

/**
 * Materialize a single child branch's exact slice of the original PR inside its
 * own worktree (which must be clean at `childBaseRef`).
 *
 * **Load-bearing precondition:** on entry, BEFORE any mutation, `repoPath`
 * must have no uncommitted changes and must have `HEAD` resolving to the same
 * SHA as `childBaseRef`. This is verified first and, on violation, throws a
 * `CarveError` without running the failure-path restore. The restore path
 * (`resetHardTo` + `git clean -fd`) is destructive: if a future caller ever
 * wired the user's original worktree in as `repoPath` while it still had
 * uncommitted work, running the restore against it would irreversibly delete
 * that work. Enforcing the precondition first means the restore path only
 * ever runs after this function's own mutations, against a worktree it has
 * already established is safe to reset.
 *
 * 1. `planChildCarve` splits the child's changes into whole files and
 *    hunk-split files.
 * 2. Whole files: deletes via `removePaths`; renames remove the old path and
 *    check out the new path from head; added/modified/binary check out from
 *    head.
 * 3. Hunk files: `computeChildBaseDiffU0` recomputes the zero-context diff
 *    against THIS child's base, `matchRunsToOriginalHunks` maps recomputed runs
 *    to original hunks, only this child's owned runs are kept, and the assembled
 *    patch is applied to the index.
 * 4. `stageAllChanges` then `commitWithMessage` produce the child commit.
 * 5. On any failure after the precondition check passes, the worktree is
 *    restored (`resetHardTo` + `cleanUntrackedFiles`) and a `CarveError` is
 *    thrown.
 * 6. Verification: empty command is `skipped`; otherwise exit code 0 is
 *    `green`, non-zero is `red` (carrying the output tail). If `signal` fires
 *    while verification is running, the abort takes precedence over the
 *    observed exit code so a killed verify surfaces as an abort, not a red
 *    result.
 *
 * `signal` is checked between major steps; an abort throws a `CarveAbortError`.
 * This never runs `git stash` and never touches branches other than the
 * checked-out child branch.
 */
export async function carveChild(args: {
  repoPath: string;
  childBaseRef: string;
  headSha: string;
  child: SplitPlanChild;
  snapshot: PrDiffSnapshot;
  buildTestCommand: string;
  commitMessage: string;
  signal: AbortSignal;
  deps: Pick<SplitterDeps, 'runVerifyCommand'>;
  /**
   * Invoked after the child commit succeeds and immediately before the verify
   * command runs. NOT invoked when verification is skipped (empty command), so
   * callers can emit a `verifying_child` progress event only when a verify
   * actually happens. Carve and verify are one call, so this callback is the
   * only accurate signal for when carving has finished and verifying begins.
   */
  onVerifyStart?: () => void;
}): Promise<CarveChildResult> {
  const {
    repoPath,
    childBaseRef,
    headSha,
    child,
    snapshot,
    buildTestCommand,
    commitMessage,
    signal,
    deps,
    onVerifyStart,
  } = args;

  throwIfAborted(signal);

  // Precondition check sits outside the restore-wrapped region below: nothing
  // has been mutated yet, so a violation here must not trigger the
  // destructive restore path (see doc comment above).
  await assertCleanAtChildBase(repoPath, childBaseRef);

  const plan = planChildCarve(child, snapshot);

  try {
    await applyWholeFiles(repoPath, headSha, plan.wholeFiles);

    throwIfAborted(signal);

    await applyHunkFiles({
      repoPath,
      childBaseRef,
      headSha,
      hunkFiles: plan.hunkFiles,
      snapshot,
      signal,
    });

    await stageAllChanges(repoPath);
    const commitSha = await commitWithMessage(repoPath, commitMessage);

    throwIfAborted(signal);

    const verify = await runVerify(
      repoPath,
      buildTestCommand,
      signal,
      deps.runVerifyCommand,
      onVerifyStart,
    );

    return { commitSha, verify };
  } catch (error) {
    // Any failure or abort restores the worktree to a clean state at the child
    // base before propagating.
    await bestEffortRestore(repoPath, childBaseRef);

    // Abort is a control-flow signal, not a carve failure — rethrow as-is so
    // callers can distinguish it via `error.name === 'AbortError'`. A CarveError
    // already carries its file/hunk context, so it also passes through unchanged.
    if (error instanceof CarveAbortError || error instanceof CarveError) {
      throw error;
    }
    throw new CarveError(
      error instanceof Error ? error.message : String(error),
      '',
      [],
    );
  }
}

/**
 * Enforce `carveChild`'s destructive-restore precondition. Must be called
 * before any mutation in `carveChild` — see the doc comment on `carveChild`
 * for why.
 */
async function assertCleanAtChildBase(
  repoPath: string,
  childBaseRef: string,
): Promise<void> {
  await assertCleanAtRef(repoPath, childBaseRef, {
    expectedDescription: 'the child base',
    operation: 'carving',
  });
}

async function assertCleanAtRef(
  repoPath: string,
  expectedRef: string,
  context: { expectedDescription: string; operation: string },
): Promise<void> {
  if (await hasUncommittedChanges(repoPath)) {
    throw new CarveError(
      `Worktree at "${repoPath}" is not clean; commit or discard uncommitted changes before retrying ${context.operation}`,
      '',
      [],
    );
  }

  const [headSha, expectedSha] = await settleAll([
    resolveRefSha(repoPath, 'HEAD'),
    resolveRefSha(repoPath, expectedRef),
  ]);
  if (headSha !== expectedSha) {
    throw new CarveError(
      `Worktree at "${repoPath}" is not checked out at ${context.expectedDescription} (HEAD is "${headSha}", expected "${expectedRef}" ("${expectedSha}")); refusing to continue ${context.operation} against the wrong commit`,
      '',
      [],
    );
  }
}

async function applyWholeFiles(
  repoPath: string,
  headSha: string,
  wholeFiles: { path: string; kind: string; oldPath?: string }[],
): Promise<void> {
  for (const file of wholeFiles) {
    if (file.kind === 'deleted') {
      await removePaths(repoPath, [file.path]);
      continue;
    }
    if (file.kind === 'renamed') {
      if (file.oldPath) {
        await removePaths(repoPath, [file.oldPath]);
      }
      await checkoutPathsFromRef(repoPath, headSha, [file.path]);
      continue;
    }
    // added / modified (including binary, which the planner routes here).
    await checkoutPathsFromRef(repoPath, headSha, [file.path]);
  }
}

async function applyHunkFiles(params: {
  repoPath: string;
  childBaseRef: string;
  headSha: string;
  hunkFiles: { path: string; ownedHunkIndices: number[] }[];
  snapshot: PrDiffSnapshot;
  signal: AbortSignal;
}): Promise<void> {
  const { repoPath, childBaseRef, headSha, hunkFiles, snapshot, signal } =
    params;
  if (hunkFiles.length === 0) {
    return;
  }

  const paths = hunkFiles.map((f) => f.path);
  const recomputed = await computeChildBaseDiffU0(
    repoPath,
    childBaseRef,
    headSha,
    paths,
  );
  const recomputedByPath = new Map(recomputed.map((f) => [f.path, f]));
  const snapshotByPath = new Map(snapshot.files.map((f) => [f.path, f]));

  for (const hunkFile of hunkFiles) {
    throwIfAborted(signal);

    const recomputedFile = recomputedByPath.get(hunkFile.path);
    const snapshotFile = snapshotByPath.get(hunkFile.path);
    if (!recomputedFile || !snapshotFile) {
      // Nothing to apply for this base (e.g. all hunks already present in the
      // child base). Skip; whole-file materialization is unaffected.
      continue;
    }

    const match = matchRunsToOriginalHunks(recomputedFile, snapshotFile);
    if (!match.ok) {
      throw new CarveError(
        `${match.reason} in ${match.file}: ${match.detail}`,
        match.file,
        [match.runHeader],
      );
    }

    const owned = new Set(hunkFile.ownedHunkIndices);
    const selected: HunkRun[] = match.runs.filter((run) =>
      owned.has(run.ownerHunkIndex),
    );
    if (selected.length === 0) {
      continue;
    }

    const patch = buildPatchFromRuns(
      hunkFile.path,
      snapshotFile.oldPath,
      selected,
    );
    await applyIndexPatch(repoPath, patch, { unidiffZero: true });
  }
}

async function runVerify(
  repoPath: string,
  buildTestCommand: string,
  signal: AbortSignal,
  runVerifyCommand: SplitterDeps['runVerifyCommand'],
  onVerifyStart?: () => void,
): Promise<CarveChildResult['verify']> {
  if (buildTestCommand.trim().length === 0) {
    // Verification skipped: do not fire onVerifyStart so callers never emit a
    // spurious `verifying_child` for a child with no verify command.
    return { status: 'skipped' };
  }
  onVerifyStart?.();
  const result = await runVerifyCommand(repoPath, buildTestCommand, signal);
  // `runVerifyCommand` resolves (rather than rejects) with a non-zero exit
  // code when the subprocess is killed via `signal`. Check for abort here so
  // a SIGTERM-killed verify surfaces as the abort error, not a red verify.
  throwIfAborted(signal);
  if (result.exitCode === 0) {
    return { status: 'green' };
  }
  return { status: 'red', tail: result.tail };
}

async function bestEffortRestore(
  repoPath: string,
  childBaseRef: string,
): Promise<void> {
  try {
    await resetHardTo(repoPath, childBaseRef);
    // `resetHardTo` reverts tracked changes but leaves files the carve
    // materialized via checkout that did not exist at the base. Clean them so
    // the worktree is genuinely clean at `childBaseRef` for a retry.
    await cleanUntrackedFiles(repoPath);
  } catch {
    // Best-effort: swallow restore failures so the original carve error (or
    // abort) propagates to the caller unmasked.
  }
}

// ---------------------------------------------------------------------------
// executePrSplit — Phase B orchestrator (publish, finalize, resume, cancel)
// ---------------------------------------------------------------------------

const INTEGRATION_INIT_MESSAGE =
  'chore: initialize split PR integration branch';
const RED_VERIFY_STATUS: SplitPrChild['verifyStatus'] = 'red';

/**
 * Thrown by `executePrSplit` for typed, user-actionable pre-flight/execution
 * refusals (plan re-validation failure, PR-head drift, sync drift, cross-repo,
 * reconstructed-tip mismatch, first-red stop). Distinct from `CarveError` so
 * callers can surface a split-level message.
 */
/**
 * Distinguishable execution-refusal codes. `plan_mismatch` marks the specific
 * refusal raised when a resume's approved plan no longer matches the plan the
 * in-progress split was started from (fingerprint drift). Renderer surfaces the
 * "Discard split state" affordance on this code. Undefined for generic
 * execution failures.
 *
 * Re-exported from `@canopy/desktop-shared/types/github` (`SplitPrExecutionErrorCode`)
 * so the shared IPC envelope type and this class stay in lockstep instead of
 * risking a duplicated, driftable union.
 */
export type { SplitPrExecutionErrorCode };

export class SplitPrExecutionError extends Error {
  readonly childIndex?: number;
  readonly verifyTail?: string;
  readonly code?: SplitPrExecutionErrorCode;

  constructor(
    message: string,
    options: {
      childIndex?: number;
      verifyTail?: string;
      code?: SplitPrExecutionErrorCode;
    } = {},
  ) {
    super(message);
    this.name = 'SplitPrExecutionError';
    this.childIndex = options.childIndex;
    this.verifyTail = options.verifyTail;
    this.code = options.code;
  }
}

/**
 * Deterministic sha256 fingerprint of the *executable* plan surface. Only the
 * fields that affect the carve are hashed: each child's index, type, dependsOn
 * (sorted), changes (files sorted; per-file hunks either `'all'` or sorted
 * indices), and renames (sorted), plus the derived integration branch name
 * (which is title-independent: it comes from the PR head branch). The per-child
 * branch names are NOT hashed because they are a deterministic function of the
 * child title — hashing them would make a purely cosmetic title edit look like
 * a carve change. Title/testProof/risk/rationale are likewise excluded so a
 * title-only re-approval resumes rather than refusing. Canonicalization is
 * order-independent so two plans that carve identically fingerprint identically.
 */
export function computePlanFingerprint(
  plan: SplitPlan,
  branchNames: ReturnType<typeof deriveSplitBranchNames>,
): string {
  const children = plan.children
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((child) => ({
      index: child.index,
      type: child.type,
      dependsOn: [...child.dependsOn].sort((a, b) => a - b),
      changes: child.changes
        .slice()
        .sort((a, b) => a.file.localeCompare(b.file))
        .map((change) => ({
          file: change.file,
          hunks:
            change.hunks === 'all'
              ? 'all'
              : [...change.hunks].sort((a, b) => a - b),
        })),
      renames: child.renames
        .slice()
        .sort(
          (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
        )
        .map((rename) => ({ from: rename.from, to: rename.to })),
    }));

  const canonical = {
    integrationBranch: branchNames.integrationBranch,
    children,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export interface ExecutePrSplitOptions {
  projectId: string;
  worktreeId: string;
  plan: SplitPlan;
  snapshot: PrDiffSnapshot;
  signal: AbortSignal;
  onProgress: (event: SplitPrProgressEvent) => void;
  deps?: SplitterDeps;
  /**
   * Resolves the main window used to stream setup-script progress events while
   * a child worktree runs its post-create setup. Only consulted when `deps` is
   * not supplied (production path); tests inject `deps` directly.
   */
  getWindow?: () => BrowserWindow | null;
}

/**
 * Phase B of Split PR: publish the planned child branches/PRs, wire an
 * integration branch/PR, retarget and close the original PR, and persist a
 * resumable `SplitPrMap`. Every external side effect is immediately checkpointed
 * to the map so a crash/cancel/resume never duplicates work.
 *
 * Integration-branch git ops and the reconstructed-tip check are performed
 * WITHOUT switching the user's original worktree checkout: the integration
 * branch is created via `git branch` + `git commit-tree` plumbing off the
 * repo's git database, and leaf-branch merges for the tip check happen in a
 * throwaway detached `git worktree` that is always removed in a finally. The
 * only intentional checkout mutation is the final retarget step.
 *
 * Cancellation via `signal` writes `status:'cancelled'`, emits `cancelled`, and
 * RETURNS the map (does not throw) so already-created artifacts remain recorded
 * for resume. Any other throw writes `status:'failed'`, emits `error`, and
 * rethrows a typed error.
 */
export async function executePrSplit(
  options: ExecutePrSplitOptions,
): Promise<SplitPrMap> {
  const { projectId, worktreeId, plan, snapshot, signal, onProgress } = options;
  const deps =
    options.deps ??
    buildDefaultSplitterDeps(projectId, worktreeId, options.getWindow);

  const emit = (
    phase: SplitPrPhase,
    extra: Omit<
      SplitPrProgressEvent,
      'projectId' | 'worktreeId' | 'phase'
    > = {},
  ): void => {
    onProgress({ projectId, worktreeId, phase, ...extra });
  };

  // Holder so the catch below can persist status on the in-progress map even
  // when runSplit throws before returning it.
  const mapRef: { current: SplitPrMap | null } = { current: null };

  try {
    const repoPath = await deps.resolveOriginalWorktreePath(worktreeId);

    return await runSplit({
      projectId,
      worktreeId,
      repoPath,
      plan,
      snapshot,
      signal,
      deps,
      emit,
      mapRef,
    });
  } catch (error) {
    const map = mapRef.current;
    // Cancellation is a control-flow signal, not a failure: record the
    // artifacts, mark cancelled, emit, and RETURN the map.
    if (isAbortError(error) && map) {
      map.status = 'cancelled';
      map.updatedAt = new Date().toISOString();
      await deps.writeMap(projectId, worktreeId, map);
      emit('cancelled');
      return map;
    }
    if (isAbortError(error)) {
      // Aborted before the map was initialized: nothing to persist.
      emit('cancelled');
      throw toSplitPrError(error);
    }

    // Any other throw is a failure. Persist status:'failed' when we have a map.
    if (map) {
      map.status = 'failed';
      map.updatedAt = new Date().toISOString();
      await deps.writeMap(projectId, worktreeId, map);
    }
    const typed = toSplitPrError(error);
    emit('error', {
      error: typed.message,
      ...(typed.childIndex !== undefined
        ? { childIndex: typed.childIndex }
        : {}),
    });
    throw typed;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function toSplitPrError(error: unknown): SplitPrExecutionError {
  if (error instanceof SplitPrExecutionError) {
    return error;
  }
  if (error instanceof CarveError) {
    // CarveError has no verify-tail concept of its own (it carries `file` and
    // `hunkHeaders`, both already folded into `message` by every throw site).
    // Forcing `verifyTail: undefined` here previously implied a tail was
    // being deliberately stripped; omit the option entirely instead so the
    // constructor's own default applies and the message (the only failure
    // detail CarveError actually carries) passes through unchanged.
    return new SplitPrExecutionError(error.message);
  }
  return new SplitPrExecutionError(
    error instanceof Error ? error.message : String(error),
  );
}

function throwIfExecAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new CarveAbortError();
  }
}

interface RunSplitArgs {
  projectId: string;
  worktreeId: string;
  repoPath: string;
  plan: SplitPlan;
  snapshot: PrDiffSnapshot;
  signal: AbortSignal;
  deps: SplitterDeps;
  emit: (
    phase: SplitPrPhase,
    extra?: Omit<SplitPrProgressEvent, 'projectId' | 'worktreeId' | 'phase'>,
  ) => void;
  mapRef: { current: SplitPrMap | null };
}

async function runSplit(args: RunSplitArgs): Promise<SplitPrMap> {
  const {
    projectId,
    worktreeId,
    repoPath,
    plan,
    snapshot,
    signal,
    deps,
    emit,
    mapRef,
  } = args;

  // --- Pre-flight (re-run on resume) --------------------------------------
  throwIfExecAborted(signal);
  const validation = deps.validatePlan(plan, snapshot);
  if (!validation.valid) {
    const firstError = validation.issues.find((i) => i.severity === 'error');
    throw new SplitPrExecutionError(
      `Split plan is invalid and cannot be executed: ${
        firstError?.message ?? 'validation failed'
      }`,
    );
  }

  // --- Map lifecycle (read FIRST) -----------------------------------------
  // Read the persisted map before detecting the PR so detection can target the
  // ORIGINAL head branch on resume regardless of the current checkout. After
  // the retarget step the original worktree is checked out on the integration
  // branch, whose open PR is the integration PR — detecting from the checkout
  // there would misidentify the original PR and make matchingMap null, which in
  // turn defeats the post-retarget-resume gate skip. When a map exists it is
  // the authoritative source of PR identity; when it does not, detection uses
  // the checked-out branch (fetchPrData with no branch argument).
  const existing = await deps.readMap(projectId, worktreeId);

  const prData = await deps.fetchPrData(repoPath, existing?.originalHeadBranch);
  // Live detection (re-run every time) is authoritative: it targets the map's
  // recorded original head branch on resume, so a fresh run and a resume
  // normally agree. The map's recorded identity is only a FALLBACK, used when
  // live detection cannot find an open PR (e.g. a prior run's `closePr`
  // already succeeded, or the PR was retargeted) — see `detectOriginalPr`.
  const detected = detectOriginalPr(prData, existing);
  if (detected.isCrossRepository) {
    throw new SplitPrExecutionError(
      'Split PR does not support fork or cross-repository pull requests',
    );
  }

  // Prune so stale `origin/<b>` refs from deleted remote branches do not feed
  // false positives into `doesRemoteBranchExist` (branch-availability and
  // integration-branch resume signals both consult remote-tracking refs).
  await fetchOrigin(repoPath, { prune: true });

  const branchNames = deriveSplitBranchNames(detected.headBranch, plan);
  const childOrder = topologicalChildOrder(plan);
  const planFingerprint = computePlanFingerprint(plan, branchNames);

  // Read the currently checked-out branch before the HEAD-match and
  // clean-checkout gates so a resume after the retarget step — where the
  // original worktree has already been switched to the integration branch —
  // can skip those gates. Post-retarget failures (updateOriginalWorktree,
  // closePr) would otherwise be permanently unresumable: local HEAD sits on the
  // integration branch, never the recorded PR head.
  const matchingMap =
    existing !== null && existing.originalPrNumber === detected.prNumber
      ? existing
      : null;
  const preflightCheckedOutBranch = await getCheckedOutBranch(repoPath);
  const resumingAfterRetarget =
    matchingMap !== null &&
    preflightCheckedOutBranch === matchingMap.integrationBranch;

  const detectedBase = detected.baseBranch;

  if (!resumingAfterRetarget) {
    // The checkpoint skip-rules cover everything up to retarget, and the
    // retarget checkout itself is idempotent, so these pre-retarget invariants
    // only need to hold on a first/pre-retarget run.
    const localHead = await resolveRefSha(repoPath, 'HEAD');
    if (localHead !== snapshot.headRef) {
      throw new SplitPrExecutionError(
        'Local checkout no longer matches the PR head; sync/push before splitting',
      );
    }
    if (await hasUncommittedChanges(repoPath)) {
      throw new SplitPrExecutionError(
        'The worktree has uncommitted changes; commit or discard before splitting',
      );
    }

    const baseSha = await resolveRefSha(repoPath, `origin/${detectedBase}`);
    if (!(await isAncestor(repoPath, baseSha, snapshot.headRef))) {
      throw new SplitPrExecutionError(
        `PR head is not up to date with origin/${detectedBase}; rebase before splitting`,
      );
    }
  }

  let map: SplitPrMap;
  const isResume = matchingMap !== null;
  if (matchingMap !== null) {
    if (matchingMap.originalHeadSha !== snapshot.headRef) {
      throw new SplitPrExecutionError('PR changed since split started');
    }
    // Refuse when the approved plan no longer matches the split already in
    // progress. The resume path would otherwise execute the persisted map's
    // child composition and silently ignore the edited plan. A missing
    // fingerprint (old map from before this field existed) is treated as a
    // mismatch — we cannot prove the persisted composition matches the plan.
    if (matchingMap.planFingerprint !== planFingerprint) {
      throw new SplitPrExecutionError(
        'The approved plan differs from the split already in progress — discard the previous split state or resume the original plan',
        { code: 'plan_mismatch' },
      );
    }
    map = matchingMap;
    map.status = 'executing';
  } else {
    map = initSplitMap({
      detected,
      detectedBase,
      integrationBranch: branchNames.integrationBranch,
      worktreeId,
      plan,
      branchNames,
      headSha: snapshot.headRef,
      planFingerprint,
    });
    const [integrationAvailableLocally, integrationExistsOnOrigin] =
      await settleAll([
        isBranchNameAvailable(repoPath, map.integrationBranch),
        doesRemoteBranchExist(repoPath, map.integrationBranch),
      ]);
    if (!integrationAvailableLocally || integrationExistsOnOrigin) {
      throw new SplitPrExecutionError(
        `Integration branch "${map.integrationBranch}" already exists; refusing to overwrite it`,
      );
    }
  }
  mapRef.current = map;

  const persist = async (): Promise<void> => {
    map.updatedAt = new Date().toISOString();
    const persisted = await deps.writeMap(projectId, worktreeId, map);
    if (!persisted) {
      throw new SplitPrExecutionError(
        'Unable to persist Split PR progress checkpoint',
        { code: 'checkpoint_write_failed' },
      );
    }
  };
  await persist();

  const childByIndex = new Map(map.children.map((c) => [c.index, c]));

  // Validate branch-name availability for any child branch with no recorded
  // artifact yet. On resume, a branch we already created is intentionally ours
  // (its worktree/PR is recorded), so those are skipped; a genuinely foreign
  // collision on a brand-new branch is a hard error.
  await assertBranchNamesAvailableForNew(repoPath, map);

  // --- Integration branch -------------------------------------------------
  throwIfExecAborted(signal);
  emit('creating_integration_branch');
  // Origin, not local refs/heads/, is the authoritative resume signal: a
  // pruned worktree or fresh clone can have no local branch even though the
  // branch (and its push) already happened. `fetchOrigin` already ran above,
  // so the remote-tracking ref this consults is current.
  const originHasIntegration = await doesRemoteBranchExist(
    repoPath,
    map.integrationBranch,
  );
  if (originHasIntegration) {
    if (!isResume) {
      throw new SplitPrExecutionError(
        `Integration branch "${map.integrationBranch}" already exists; refusing to overwrite it`,
      );
    }
    // Origin already has it: both create and push are already done, skip both.
  } else {
    const integrationExistsLocally = !(await isBranchNameAvailable(
      repoPath,
      map.integrationBranch,
    ));
    if (integrationExistsLocally && !isResume) {
      throw new SplitPrExecutionError(
        `Integration branch "${map.integrationBranch}" already exists; refusing to overwrite it`,
      );
    }
    if (!integrationExistsLocally) {
      await createBranchWithEmptyCommit(
        repoPath,
        map.integrationBranch,
        `origin/${detectedBase}`,
        INTEGRATION_INIT_MESSAGE,
      );
    }
    // Always push when origin lacks the branch, even if it already existed
    // locally from a prior run that crashed before the push landed. Pushing
    // an already-pushed branch is a no-op fast-forward, so this is safe to
    // repeat and checkpoints the push instead of leaving it unconfirmed.
    await pushNamedBranch(repoPath, map.integrationBranch);
    await persist();
  }

  // --- Children in topological order --------------------------------------
  const childTotal = childOrder.length;
  // Per-run record of child worktrees whose post-create setup has already run
  // during THIS execution. It is intentionally kept in memory (not persisted to
  // the map): "already set up" is only true for the lifetime of a single run's
  // worktrees. On a fresh resume where a worktree was recreated, the set starts
  // empty so setup runs again before that worktree's first verify/re-verify; a
  // worktree that survived a prior run was set up then, but this run cannot
  // cheaply prove that, so the rule is simply "run setup once per worktree per
  // run before any verify in it". Re-running an idempotent setup script (e.g.
  // `npm ci`) is safe and cheap relative to a wrong verify.
  const setupDoneWorktreeIds = new Set<string>();
  for (const childIndex of childOrder) {
    throwIfExecAborted(signal);
    const child = childByIndex.get(childIndex);
    if (!child) {
      continue;
    }
    await processChild({
      projectId,
      worktreeId,
      repoPath,
      map,
      child,
      childTotal,
      snapshot,
      buildTestCommand: plan.buildTestCommand,
      signal,
      deps,
      emit,
      persist,
      setupDoneWorktreeIds,
    });
  }

  // --- Reconstructed-tip check --------------------------------------------
  throwIfExecAborted(signal);
  emit('reconstructing_tip');
  await verifyReconstructedTip({
    repoPath,
    map,
    snapshot,
  });

  // --- Integration PR -----------------------------------------------------
  throwIfExecAborted(signal);
  if (map.integrationPrNumber === undefined) {
    emit('opening_integration_pr');
    const integrationBody = buildIntegrationBody(map);
    const result = await deps.createPr(
      repoPath,
      map.integrationBranch,
      buildIntegrationPrTitle(map),
      integrationBody,
      map.originalBaseBranch,
    );
    map.integrationPrNumber = result.prNumber;
    map.integrationPrUrl = result.prUrl;
    await persist();
  }

  // --- Body-update pass ---------------------------------------------------
  throwIfExecAborted(signal);
  emit('updating_pr_bodies');
  await updateAllPrBodies(repoPath, map, deps);

  // --- Retarget original + close ------------------------------------------
  throwIfExecAborted(signal);
  emit('retargeting_original');
  // Skip the checkout when the original worktree is already on the
  // integration branch (e.g. a resume after the retarget step already ran
  // but a later step failed/aborted before persist recorded completion).
  const checkedOutBranch = await getCheckedOutBranch(repoPath);
  if (checkedOutBranch !== map.integrationBranch) {
    await checkoutBranch(repoPath, map.integrationBranch);
  }
  await deps.updateOriginalWorktree(projectId, worktreeId, {
    branchName: map.integrationBranch,
    trackedBaseBranch: map.originalBaseBranch,
  });
  await persist();

  // --- Retarget dependent PRs ----------------------------------------------
  // A nested/mid-stack split: another open PR may already be stacked on the
  // original head branch (e.g. a downstream sibling in a manually-managed
  // stack). That branch is about to be superseded by the integration branch
  // and the original PR closed, so any PR still based on it needs to move
  // too, or it is left pointing at a dead branch.
  throwIfExecAborted(signal);
  const ownedPrNumbers = new Set<number>([
    map.originalPrNumber,
    ...(map.integrationPrNumber !== undefined ? [map.integrationPrNumber] : []),
    ...map.children
      .map((child) => child.prNumber)
      .filter((prNumber): prNumber is number => prNumber !== undefined),
  ]);
  const dependents = (
    await deps.listOpenPrsBasedOnBranch(repoPath, map.originalHeadBranch)
  ).filter((dependent) => !ownedPrNumbers.has(dependent.prNumber));
  if (dependents.length > 0) {
    emit('retargeting_dependents', {
      message: `Retargeting #${dependents
        .map((dependent) => dependent.prNumber)
        .join(', #')} onto ${map.integrationBranch}`,
    });
    // No map guard is needed for resume safety: once retargeted, the
    // dependent's base is no longer `originalHeadBranch`, so a resumed run's
    // `listOpenPrsBasedOnBranch` query simply finds nothing to redo. The
    // recorded list is checkpointed per PR (append + persist after each base
    // update) so a crash mid-batch never drops an already-retargeted PR from
    // the record, and appends accumulate across resumed batches.
    for (const dependent of dependents) {
      await deps.updatePrBase(
        repoPath,
        dependent.prNumber,
        map.integrationBranch,
      );
      map.retargetedDependentPrs = [
        ...(map.retargetedDependentPrs ?? []).filter(
          (recorded) => recorded.prNumber !== dependent.prNumber,
        ),
        dependent,
      ];
      await persist();
    }
  }

  throwIfExecAborted(signal);
  emit('closing_original');
  await deps.closePr(
    repoPath,
    map.originalPrNumber,
    `Split into #${map.integrationPrNumber} and its stacked child PRs.`,
  );

  map.status = 'completed';
  await persist();
  emit('done');
  return map;
}

interface DetectedOriginalPr {
  prNumber: number;
  prUrl: string;
  baseBranch: string;
  headBranch: string;
  isCrossRepository: boolean;
  /**
   * Title of the original PR from live tracking data, used to build the
   * integration PR title (`` `${title} (split)` ``). Undefined when live
   * detection could not read a title (e.g. resume falling back to a legacy map
   * that predates `originalPrTitle`); callers then fall back to the
   * branch-derived title.
   */
  title?: string;
}

/**
 * Resolve the original PR's identity for the run.
 *
 * Fresh runs (`existingMap === null`) require a detectable OPEN pull request on
 * the checked-out branch: the live tracking data must carry a PR number, url,
 * and base ref, or the split refuses.
 *
 * Resume runs (`existingMap !== null`) treat the persisted map as authoritative
 * for PR identity. This matters for the closed-original-PR resume case: if a
 * prior run's final `closePr` succeeded but the subsequent map write failed (or
 * a later step failed after retarget), re-detecting the original head branch
 * returns a CLOSED PR or no open PR at all. Because the map already recorded the
 * PR number/url/base/head at start time, we resume from that recorded identity
 * and let the run finish (writing the completed status / re-issuing the
 * idempotent close) rather than refusing. The open-PR requirement only applies
 * to fresh runs.
 */
function detectOriginalPr(
  prData: RepoPrTrackingData,
  existingMap: SplitPrMap | null,
): DetectedOriginalPr {
  const status = prData.status;
  const snapshot = prData.snapshot;
  const prNumber = status?.prNumber ?? snapshot?.pr.number;
  const prUrl = status?.prUrl ?? snapshot?.pr.htmlUrl;
  const baseBranch = snapshot?.branch.baseRefName;
  const headBranch = prData.branchName;
  const isCrossRepository = snapshot?.pr.isCrossRepository ?? false;
  const title = status?.title ?? snapshot?.pr.title;

  if (
    prNumber === undefined ||
    !prUrl ||
    !baseBranch ||
    baseBranch.length === 0
  ) {
    if (existingMap !== null) {
      // Resume with the map as authoritative identity. Live detection could not
      // find an open PR (already closed/retargeted by a prior run), so fall
      // back to the recorded identity so the split can still complete. The
      // recorded `originalPrTitle` (if any) is preferred over a re-detect.
      return {
        prNumber: existingMap.originalPrNumber,
        prUrl: existingMap.originalPrUrl,
        baseBranch: existingMap.originalBaseBranch,
        headBranch: existingMap.originalHeadBranch,
        isCrossRepository: false,
        title: existingMap.originalPrTitle,
      };
    }
    throw new SplitPrExecutionError(
      'Could not detect an open pull request to split for this branch',
    );
  }

  return { prNumber, prUrl, baseBranch, headBranch, isCrossRepository, title };
}

function initSplitMap(params: {
  detected: DetectedOriginalPr;
  detectedBase: string;
  integrationBranch: string;
  worktreeId: string;
  plan: SplitPlan;
  branchNames: ReturnType<typeof deriveSplitBranchNames>;
  headSha: string;
  planFingerprint: string;
}): SplitPrMap {
  const {
    detected,
    detectedBase,
    integrationBranch,
    worktreeId,
    plan,
    branchNames,
    headSha,
    planFingerprint,
  } = params;
  const now = new Date().toISOString();
  const children: SplitPrChild[] = plan.children
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((child) => ({
      index: child.index,
      title: child.title,
      type: child.type,
      branchName: branchNames.childBranches[child.index],
      // `validateSplitPlan` (`multi-parent-unsupported`) rejects any child with
      // more than one parent before we reach execution, and server-side
      // re-validation runs on every execute — so `dependsOn` is length 0 or 1
      // here and `dependsOn[0]` is the single parent (or undefined for a root).
      baseBranch:
        child.dependsOn.length === 0
          ? integrationBranch
          : branchNames.childBranches[child.dependsOn[0]],
      dependsOn: child.dependsOn,
      changes: child.changes,
      renames: child.renames,
      verifyStatus: 'pending',
    }));

  return {
    version: 1,
    originalPrNumber: detected.prNumber,
    originalPrUrl: detected.prUrl,
    originalBaseBranch: detectedBase,
    originalHeadBranch: detected.headBranch,
    originalHeadSha: headSha,
    ...(detected.title !== undefined && detected.title.length > 0
      ? { originalPrTitle: detected.title }
      : {}),
    integrationBranch,
    originalWorktreeId: worktreeId,
    children,
    buildTestCommand: plan.buildTestCommand,
    planFingerprint,
    status: 'executing',
    createdAt: now,
    updatedAt: now,
  };
}

async function assertBranchNamesAvailableForNew(
  repoPath: string,
  map: SplitPrMap,
): Promise<void> {
  for (const child of map.children) {
    // A recorded worktree/PR means this branch is intentionally ours already —
    // skip availability enforcement so resume does not treat it as a collision.
    if (child.worktreeId || child.prNumber) {
      continue;
    }
    // Origin-only branches with no recorded artifact are still a collision:
    // `isBranchNameAvailable` only inspects local `refs/heads/`, so a branch
    // that was pushed by someone/something else (or that we pushed in a run
    // whose map write was lost) would otherwise pass as "available" and get
    // silently recreated/overwritten.
    const [availableLocally, existsOnOrigin] = await settleAll([
      isBranchNameAvailable(repoPath, child.branchName),
      doesRemoteBranchExist(repoPath, child.branchName),
    ]);
    if (!availableLocally || existsOnOrigin) {
      throw new SplitPrExecutionError(
        `Child branch "${child.branchName}" already exists; refusing to overwrite it`,
      );
    }
  }
}

interface ProcessChildArgs {
  projectId: string;
  worktreeId: string;
  repoPath: string;
  map: SplitPrMap;
  child: SplitPrChild;
  childTotal: number;
  snapshot: PrDiffSnapshot;
  buildTestCommand: string;
  signal: AbortSignal;
  deps: SplitterDeps;
  emit: RunSplitArgs['emit'];
  persist: () => Promise<void>;
  /**
   * Child worktree ids whose post-create setup has already run this execution.
   * `processChild` runs setup once per worktree per run before the first
   * verify/re-verify happens in it, and records the id here.
   */
  setupDoneWorktreeIds: Set<string>;
}

/**
 * Run the child worktree's post-create setup script to completion the first
 * time it is needed this run, so the verify command sees a set-up worktree
 * (dependencies installed, build performed) rather than a bare checkout.
 *
 * Setup-failure policy: a `failed` (non-zero exit / timeout) or thrown setup
 * result does NOT hard-fail the split. We record a progress `message` and let
 * carve/verify proceed, so the verify outcome reflects the real (possibly
 * partially set-up) environment instead of the split dying on a setup hiccup.
 * A genuine build breakage will still surface as a red verify. `skipped` (no
 * setup script configured) proceeds silently.
 *
 * This intentionally runs BEFORE `carveChild`'s clean-worktree precondition
 * check. Real setup scripts create gitignored artifacts (e.g. `node_modules`),
 * which do not trip `git status --porcelain --untracked-files=normal`. A setup
 * script that produces NON-ignored files would leave the worktree dirty and the
 * carve precondition would then fail loudly (a `CarveError`) rather than
 * silently committing those files into the child — the correct, visible
 * failure mode.
 *
 * Aborts propagate: `runWorktreeSetup` honors `signal` and kills the running
 * setup process, and the thrown abort routes to the standard cancellation path
 * before any carve happens.
 */
async function ensureWorktreeSetup(params: {
  worktreeId: string;
  childIndex: number;
  childTotal: number;
  signal: AbortSignal;
  deps: SplitterDeps;
  emit: RunSplitArgs['emit'];
  setupDoneWorktreeIds: Set<string>;
}): Promise<void> {
  const { worktreeId, childIndex, childTotal, signal, deps, emit } = params;
  if (params.setupDoneWorktreeIds.has(worktreeId)) {
    return;
  }
  throwIfExecAborted(signal);
  emit('running_setup', { childIndex, childTotal });
  const result = await deps.runWorktreeSetup(worktreeId, signal);
  // Mark done regardless of outcome: a failed setup is not retried within the
  // same run, and a skipped setup has nothing to run again.
  params.setupDoneWorktreeIds.add(worktreeId);
  if (result.status === 'failed') {
    emit('running_setup', {
      childIndex,
      childTotal,
      message:
        result.detail && result.detail.length > 0
          ? `setup script failed (${result.detail}) — verify may not reflect a working environment`
          : 'setup script failed — verify may not reflect a working environment',
    });
  }
}

async function processChild(argsIn: ProcessChildArgs): Promise<void> {
  const {
    projectId,
    repoPath,
    map,
    child,
    childTotal,
    snapshot,
    buildTestCommand,
    signal,
    deps,
    emit,
    persist,
    setupDoneWorktreeIds,
  } = argsIn;

  // 1. Worktree ------------------------------------------------------------
  if (!child.worktreeId) {
    const created = await deps.createWorktree({
      workspaceId: projectId,
      branchName: child.branchName,
      baseBranch: child.baseBranch,
      startPostCreateSetup: true,
    });
    child.worktreeId = created.id;
    await persist();
    await deps.setWorktreeGrouping(projectId, created.id);
  }

  const childWorktreeId = child.worktreeId;
  const childCwd = await deps.resolveChildWorktreePath(childWorktreeId);

  // 2. Carve ---------------------------------------------------------------
  throwIfExecAborted(signal);
  // Skip the carve when the child branch tip already matches the recorded
  // carve sha. The child branch is checked out in its own worktree, so query
  // that worktree's HEAD rather than the original checkout.
  const carveAlreadyDone =
    child.carveCommitSha !== undefined &&
    (await resolveRefSha(childCwd, 'HEAD').catch(() => null)) ===
      child.carveCommitSha;

  if (!carveAlreadyDone) {
    // Run the worktree's setup script to completion BEFORE carving. carveChild
    // asserts a clean worktree at the child base first, so setup — which may
    // create gitignored artifacts like node_modules — must land before that
    // check. A setup that writes NON-ignored files would fail the carve
    // precondition loudly rather than being committed into the child.
    await ensureWorktreeSetup({
      worktreeId: childWorktreeId,
      childIndex: child.index,
      childTotal,
      signal,
      deps,
      emit,
      setupDoneWorktreeIds,
    });

    emit('carving_child', { childIndex: child.index, childTotal });
    const planChild: SplitPlanChild = {
      index: child.index,
      title: child.title,
      type: child.type,
      dependsOn: child.dependsOn,
      changes: child.changes,
      renames: child.renames ?? [],
      testProof: '',
      risk: 'low',
      rationale: '',
    };

    const carve = await carveChild({
      repoPath: childCwd,
      childBaseRef: child.baseBranch,
      headSha: snapshot.headRef,
      child: planChild,
      snapshot,
      buildTestCommand,
      commitMessage: `[${child.index}/${childTotal}] ${child.title}`,
      signal,
      deps: { runVerifyCommand: deps.runVerifyCommand },
      // Emit `verifying_child` only once the commit has landed and the verify
      // command is actually about to run (carve+verify are one call).
      onVerifyStart: () =>
        emit('verifying_child', { childIndex: child.index, childTotal }),
    });

    // Record the carve sha alongside the verify status even on red. The carve
    // commit itself succeeded (only verification failed), and `carveChild`
    // deliberately leaves the child worktree at that commit for a red result
    // (its restore only runs on a git/matcher failure or abort). Persisting the
    // sha lets a resume recognize the already-carved child and re-verify it
    // standalone instead of re-running the carve against a HEAD that no longer
    // sits at the child base.
    child.carveCommitSha = carve.commitSha;
    child.verifyStatus = carve.verify.status;
    await persist();

    // Stop at the first red node before pushing or opening a PR. The failure
    // wrapper marks the map failed and emits the single `error` progress event.
    if (carve.verify.status === RED_VERIFY_STATUS) {
      throw new SplitPrExecutionError(
        `Child ${child.index} ("${child.title}") failed verification; stopping the split`,
        { childIndex: child.index, verifyTail: carve.verify.tail },
      );
    }

    await pushNamedBranch(childCwd, child.branchName);
    await persist();
  } else if (
    child.verifyStatus !== 'green' &&
    child.verifyStatus !== 'skipped'
  ) {
    // Resume of an already-carved child whose verify was never recorded green
    // (a prior run stopped at its red verify). The carve is intact at the
    // recorded tip, so re-run verification standalone against the child
    // worktree instead of re-carving. `runVerify` honors `signal` exactly like
    // the carve-time verify: an abort surfaces as the cancellation path, not a
    // red result.
    //
    // Run setup before the standalone re-verify too. If the worktree was
    // recreated this run it has not been set up yet, so `ensureWorktreeSetup`
    // runs it now; if it was already set up earlier this run, the per-run set
    // makes this a no-op. Either way the re-verify sees a set-up worktree.
    await ensureWorktreeSetup({
      worktreeId: childWorktreeId,
      childIndex: child.index,
      childTotal,
      signal,
      deps,
      emit,
      setupDoneWorktreeIds,
    });

    const recordedCarveCommitSha = child.carveCommitSha;
    if (recordedCarveCommitSha === undefined) {
      throw new SplitPrExecutionError(
        `Child ${child.index} ("${child.title}") cannot resume verification because its carve commit is missing`,
        { childIndex: child.index },
      );
    }
    await assertCleanAtRef(childCwd, recordedCarveCommitSha, {
      expectedDescription: 'the recorded carve commit',
      operation: 'red-verify resume',
    });

    emit('verifying_child', { childIndex: child.index, childTotal });
    const verify = await runVerify(
      childCwd,
      buildTestCommand,
      signal,
      deps.runVerifyCommand,
    );
    child.verifyStatus = verify.status;
    await persist();

    if (verify.status === RED_VERIFY_STATUS) {
      throw new SplitPrExecutionError(
        `Child ${child.index} ("${child.title}") failed verification; stopping the split`,
        { childIndex: child.index, verifyTail: verify.tail },
      );
    }

    // The red run stopped before pushing this child's branch, so push it now
    // that it verifies green. A no-op fast-forward if it was somehow already
    // pushed, so this is safe to repeat and checkpoints the push.
    await pushNamedBranch(childCwd, child.branchName);
    await persist();
  } else if (child.prNumber === undefined) {
    // Resume of an already-carved AND already-green/skipped child whose PR was
    // never opened. Both branches above persist `carveCommitSha`+`verifyStatus`
    // BEFORE `pushNamedBranch`, so a crash in that window leaves a green child
    // whose branch was never pushed to origin — and the PR-creation step below
    // would then fail against a missing origin branch. Push here so every path
    // into PR creation has pushed exactly once first. Push is idempotent (a
    // no-op fast-forward when the branch was already pushed), so re-running it
    // after a successful earlier push is harmless.
    await pushNamedBranch(childCwd, child.branchName);
    await persist();
  }

  // 3. Child PR ------------------------------------------------------------
  throwIfExecAborted(signal);
  if (child.prNumber === undefined) {
    // Generate the child's title/body via the standard Create PR flow just
    // before opening — only now (post carve/verify-green, post-push) does the
    // child branch + its base exist on origin for the base-relative diff. A
    // null result (generation unavailable/failed) falls back to the provisional
    // shape. Persist the generated base title/body so the mandatory
    // body-update pass can rebuild `prBodyBase + separator + freshStackBlock`
    // without losing the generated content on resume.
    emit('opening_child_pr', {
      childIndex: child.index,
      childTotal,
      message: 'Generating PR description…',
    });
    const generated = await deps.generateChildPrContent({
      worktreePath: childCwd,
      branchName: child.branchName,
      baseBranch: child.baseBranch,
    });
    if (generated) {
      child.prTitleGenerated = generated.title;
      child.prBodyBase = generated.body;
      await persist();
    }

    const body = buildChildBody(map, child);
    const result = await deps.createPr(
      repoPath,
      child.branchName,
      buildChildPrTitle(map, child, childTotal),
      body,
      child.baseBranch,
    );
    child.prNumber = result.prNumber;
    child.prUrl = result.prUrl;
    await persist();
  }
}

// ---------------------------------------------------------------------------
// Reconstructed-tip check (no user-checkout mutation)
// ---------------------------------------------------------------------------

async function verifyReconstructedTip(params: {
  repoPath: string;
  map: SplitPrMap;
  snapshot: PrDiffSnapshot;
}): Promise<void> {
  const { repoPath, map, snapshot } = params;

  const leafBranches = computeLeafChildBranches(map);
  // A detached temp worktree off the integration branch keeps all merge
  // mutation off the user's checkout; it is always removed in the finally.
  const tempDir = await mkdtemp(join(tmpdir(), 'canopy-split-tip-'));
  const tempWorktreePath = join(tempDir, 'wt');
  try {
    await addDetachedWorktree(
      repoPath,
      tempWorktreePath,
      map.integrationBranch,
    );
    for (const branch of leafBranches) {
      await mergeBranch(
        tempWorktreePath,
        branch,
        `merge ${branch} for reconstructed-tip check`,
      );
    }

    const [headTree, tipTree] = await settleAll([
      getTreeSha(repoPath, snapshot.headRef),
      getTreeSha(tempWorktreePath, 'HEAD'),
    ]);
    if (headTree !== tipTree) {
      throw new SplitPrExecutionError(
        'Reconstructed tip does not match the original PR head; the split does not reproduce the original diff',
      );
    }
  } finally {
    await removeGitWorktree(repoPath, tempWorktreePath).catch(() => {
      // Best-effort cleanup; do not mask the primary error.
    });
    await rm(tempDir, { recursive: true, force: true }).catch(() => {
      // Best-effort cleanup.
    });
  }
}

/**
 * Leaf children are those no other child depends on (the tip of each dependency
 * chain). Merging every leaf reconstructs the full tree because shared-file
 * children are stacked (deepest owner holds the final state) and independent
 * children are file-disjoint.
 */
function computeLeafChildBranches(map: SplitPrMap): string[] {
  const dependedOn = new Set<number>();
  for (const child of map.children) {
    for (const dep of child.dependsOn) {
      dependedOn.add(dep);
    }
  }
  return map.children
    .filter((child) => !dependedOn.has(child.index))
    .map((child) => child.branchName);
}

// ---------------------------------------------------------------------------
// Body composition
// ---------------------------------------------------------------------------

/**
 * Horizontal rule separating a child's generated PR body from the appended
 * stack-description block. A markdown thematic break on its own line.
 */
const CHILD_BODY_SEPARATOR = '\n\n---\n\n';

/**
 * The integration PR title: the ORIGINAL PR's title plus `" (split)"`, falling
 * back to the head-branch-derived title (`` `${originalHeadBranch} (split)` ``)
 * when `originalPrTitle` is absent (legacy maps / resume where the title could
 * not be re-detected). GitHub allows long titles, so this is never truncated.
 */
function buildIntegrationPrTitle(map: SplitPrMap): string {
  const base =
    map.originalPrTitle && map.originalPrTitle.length > 0
      ? map.originalPrTitle
      : map.originalHeadBranch;
  return `${base} (split)`;
}

/**
 * The child PR title: `[X/Y]` prepended to the generated title when generation
 * produced one (`prTitleGenerated`), else to the planner-derived `child.title`
 * (the current/fallback shape, unchanged behavior).
 */
function buildChildPrTitle(
  map: SplitPrMap,
  child: SplitPrChild,
  childTotal: number,
): string {
  const base =
    child.prTitleGenerated && child.prTitleGenerated.length > 0
      ? child.prTitleGenerated
      : child.title;
  return `[${child.index}/${childTotal}] ${base}`;
}

/**
 * Compose the child PR body: when the standard PR-generation flow produced a
 * base body (`prBodyBase`), it becomes `generatedBody + '\n\n---\n\n' +
 * stackBlock`; otherwise (generation unavailable/failed, or a legacy map) the
 * body is the provisional stack-only block, preserving the pre-generation
 * behavior. Used both at PR-creation time (where sibling PR numbers may not all
 * be known yet — the stack block gracefully renders branch names) and rebuilt
 * with final numbers by the body-update pass.
 */
function buildChildBody(map: SplitPrMap, child: SplitPrChild): string {
  const stackBlock = buildStackBlock(map, child.index);
  if (child.prBodyBase && child.prBodyBase.length > 0) {
    return `${child.prBodyBase}${CHILD_BODY_SEPARATOR}${stackBlock}`;
  }
  return stackBlock;
}

/**
 * The shared stack description block placed in every child PR after all PR
 * numbers are known (spec 03 §"Shared stack description block").
 * `currentChildIndex` marks "← this change" for the child whose body this is.
 * The integration PR uses `buildIntegrationStackBody` instead so it keeps its
 * "Splits #N" header framing.
 */
function buildStackBlock(map: SplitPrMap, currentChildIndex: number): string {
  const total = map.children.length;
  const ordered = map.children.slice().sort((a, b) => a.index - b.index);
  const lines = ordered.map((child) => {
    const prRef = child.prNumber ? `#${child.prNumber}` : child.branchName;
    const parents = child.dependsOn
      .map((dep) => ordered.find((c) => c.index === dep))
      .filter((c): c is SplitPrChild => c !== undefined)
      .map((c) => (c.prNumber ? `#${c.prNumber}` : c.branchName));
    const needs = parents.length > 0 ? `  (needs ${parents.join(', ')})` : '';
    const marker =
      child.index === currentChildIndex ? '        ← this change' : '';
    return `  ${prRef} [${child.index}/${total}] ${child.title}${needs}${marker}`;
  });

  const integrationRef = map.integrationPrNumber
    ? `#${map.integrationPrNumber}`
    : map.integrationBranch;

  const current = ordered.find((c) => c.index === currentChildIndex);
  const parents = (current?.dependsOn ?? [])
    .map((dep) => ordered.find((c) => c.index === dep))
    .filter((c): c is SplitPrChild => c !== undefined)
    .map((c) => (c.prNumber ? `#${c.prNumber}` : c.branchName));
  const trailer: string[] = [
    `Base: ${current?.baseBranch ?? map.integrationBranch}`,
    `Depends on: ${parents.length > 0 ? parents.join(', ') : 'none'}`,
  ];

  return [
    `Part of a Split PR of #${map.originalPrNumber} (integration: ${integrationRef}).`,
    '',
    `Stack (merge into ${map.integrationBranch}, in order):`,
    ...lines,
    '',
    ...trailer,
  ].join('\n');
}

function buildIntegrationBody(map: SplitPrMap): string {
  const childList = map.children
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((child) => {
      const ref = child.prNumber ? `#${child.prNumber}` : child.branchName;
      return `- ${ref} [${child.index}/${map.children.length}] ${child.title}`;
    });
  return [
    `Splits #${map.originalPrNumber} into a stack of smaller PRs.`,
    '',
    'Children:',
    ...childList,
  ].join('\n');
}

/**
 * The integration PR's final (post-all-numbers-known) body. Unlike a child
 * body — which uses the child-oriented "Part of a Split PR of #N" framing from
 * `buildStackBlock` — the integration PR keeps its "Splits #N into a stack of
 * smaller PRs" header framing so it stays recognizable as the integration
 * point, while still rendering the fully-resolved stack (now that every child
 * PR number is known). Child bodies are unchanged.
 */
function buildIntegrationStackBody(map: SplitPrMap): string {
  const total = map.children.length;
  const ordered = map.children.slice().sort((a, b) => a.index - b.index);
  const lines = ordered.map((child) => {
    const prRef = child.prNumber ? `#${child.prNumber}` : child.branchName;
    const parents = child.dependsOn
      .map((dep) => ordered.find((c) => c.index === dep))
      .filter((c): c is SplitPrChild => c !== undefined)
      .map((c) => (c.prNumber ? `#${c.prNumber}` : c.branchName));
    const needs = parents.length > 0 ? `  (needs ${parents.join(', ')})` : '';
    return `  ${prRef} [${child.index}/${total}] ${child.title}${needs}`;
  });

  return [
    `Splits #${map.originalPrNumber} into a stack of smaller PRs.`,
    '',
    `Stack (merge into ${map.integrationBranch}, in order):`,
    ...lines,
    '',
    `Base: ${map.originalBaseBranch}`,
  ].join('\n');
}

async function updateAllPrBodies(
  repoPath: string,
  map: SplitPrMap,
  deps: SplitterDeps,
): Promise<void> {
  for (const child of map.children) {
    if (child.prNumber === undefined) {
      continue;
    }
    // Reconstruct the final body from the persisted generated base plus a
    // freshly-rebuilt stack block (now that every PR number is known).
    // `buildChildBody` handles children WITHOUT a `prBodyBase` (legacy/fallback)
    // by emitting the stack-only body, matching the pre-generation behavior.
    // The generated content is preserved — only the block below the separator
    // is refreshed.
    await deps.updatePrBody(
      repoPath,
      child.prNumber,
      buildChildBody(map, child),
    );
  }
  if (map.integrationPrNumber !== undefined) {
    await deps.updatePrBody(
      repoPath,
      map.integrationPrNumber,
      buildIntegrationStackBody(map),
    );
  }
}
