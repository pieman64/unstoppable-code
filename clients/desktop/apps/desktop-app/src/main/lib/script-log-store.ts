import { randomUUID } from 'node:crypto';
import {
  access,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type {
  ScriptDescriptor,
  ScriptRunResponse,
  ScriptStartedEvent,
} from '@canopy/desktop-shared/types';
import {
  MAX_SCRIPT_DEV_SERVER_LABEL_LENGTH,
  MAX_SCRIPT_DEV_SERVER_PATTERN_LENGTH,
  MAX_SCRIPT_DEV_SERVER_PATTERNS,
} from '@canopy/desktop-shared/scripts';
import { logMainProcessWarn } from './main-process-logging';
import { buildScriptRunFileStem, resolveScriptRunDir } from './paths';
import {
  appendRunLogLines,
  completeRunLogFiles,
  createRunLogCoordinator,
  readRunLogTailLines,
  startRunLogFiles,
} from './run-log-store';
import { isRecord } from './type-guards';

const runLogs = createRunLogCoordinator();

export interface PersistedScriptRunFile {
  version: 1;
  runId: string;
  script: ScriptDescriptor;
  invocation: ScriptStartedEvent['invocation'];
  status: 'running' | 'success' | 'failed' | 'cancelled';
  startedAt: string;
  // This advances when metadata changes, not on every log append.
  updatedAt: string;
  completedAt?: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}

export interface ScriptRunLogRef {
  projectId: string;
  worktreeId: string;
  script: ScriptDescriptor;
  runId: string;
}

function getScriptRunPaths(
  projectId: string,
  worktreeId: string,
  scriptKey: string,
): {
  dirPath: string;
  metaPath: string;
  logPath: string;
} {
  const dirPath = resolveScriptRunDir(projectId, worktreeId);
  const stem = buildScriptRunFileStem(scriptKey);
  return {
    dirPath,
    metaPath: join(dirPath, `${stem}.json`),
    logPath: join(dirPath, `${stem}.log`),
  };
}

function isScriptInvocation(
  value: unknown,
): value is ScriptStartedEvent['invocation'] {
  return (
    value === 'automatic-setup' ||
    value === 'manual-run' ||
    value === 'manual-lifecycle' ||
    value === 'workspace-lifecycle'
  );
}

function isScriptLifecycle(
  value: unknown,
): value is ScriptDescriptor['lifecycle'] {
  return (
    value === 'custom' ||
    value === 'setup' ||
    value === 'launch' ||
    value === 'teardown' ||
    value === 'before-setup' ||
    value === 'after-setup' ||
    value === 'before-launch' ||
    value === 'after-launch' ||
    value === 'before-teardown' ||
    value === 'after-teardown'
  );
}

function isScriptTarget(value: unknown): value is ScriptDescriptor['target'] {
  return (
    value === 'project' ||
    value === 'workspace-root' ||
    value === 'workspace-repo'
  );
}

function isScriptDevServerPatternEntry(value: unknown): boolean {
  if (typeof value === 'string') {
    return isValidScriptDevServerPatternSource(value);
  }
  if (!isRecord(value)) {
    return false;
  }
  for (const key of Object.keys(value)) {
    if (
      key !== 'pattern' &&
      key !== 'label' &&
      key !== 'openTarget' &&
      key !== 'autoOpen'
    ) {
      return false;
    }
  }
  if (
    typeof value.pattern !== 'string' ||
    !isValidScriptDevServerPatternSource(value.pattern)
  ) {
    return false;
  }
  if (value.label !== undefined && typeof value.label !== 'string') {
    return false;
  }
  if (
    typeof value.label === 'string' &&
    !isValidScriptDevServerPatternLabel(value.label)
  ) {
    return false;
  }
  if (
    value.openTarget !== undefined &&
    value.openTarget !== 'in-app' &&
    value.openTarget !== 'external'
  ) {
    return false;
  }
  if (value.autoOpen !== undefined && typeof value.autoOpen !== 'boolean') {
    return false;
  }
  return true;
}

function isScriptDevServerPattern(value: unknown): boolean {
  if (Array.isArray(value)) {
    if (value.length === 0 || value.length > MAX_SCRIPT_DEV_SERVER_PATTERNS) {
      return false;
    }
    return value.every(isScriptDevServerPatternEntry);
  }
  return isScriptDevServerPatternEntry(value);
}

function isValidScriptDevServerPatternSource(value: string): boolean {
  const pattern = value.trim();
  if (
    pattern.length === 0 ||
    pattern.length > MAX_SCRIPT_DEV_SERVER_PATTERN_LENGTH
  ) {
    return false;
  }
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

function isValidScriptDevServerPatternLabel(value: string): boolean {
  const label = value.trim();
  return label.length > 0 && label.length <= MAX_SCRIPT_DEV_SERVER_LABEL_LENGTH;
}

function isScriptDescriptor(value: unknown): value is ScriptDescriptor {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.scriptKey === 'string' &&
    typeof value.scriptName === 'string' &&
    typeof value.label === 'string' &&
    typeof value.command === 'string' &&
    isScriptLifecycle(value.lifecycle) &&
    isScriptTarget(value.target) &&
    (value.repoId === undefined || typeof value.repoId === 'string') &&
    (value.repoName === undefined || typeof value.repoName === 'string') &&
    (value.devServerPattern === undefined ||
      isScriptDevServerPattern(value.devServerPattern))
  );
}

function isPersistedScriptRunFile(
  value: unknown,
): value is PersistedScriptRunFile {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.version === 1 &&
    typeof value.runId === 'string' &&
    isScriptDescriptor(value.script) &&
    isScriptInvocation(value.invocation) &&
    (value.status === 'running' ||
      value.status === 'success' ||
      value.status === 'failed' ||
      value.status === 'cancelled') &&
    typeof value.startedAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    (value.completedAt === undefined ||
      typeof value.completedAt === 'string') &&
    (value.exitCode === null || typeof value.exitCode === 'number') &&
    typeof value.timedOut === 'boolean' &&
    typeof value.durationMs === 'number'
  );
}

async function readMeta(
  metaPath: string,
): Promise<PersistedScriptRunFile | null> {
  try {
    const raw = await readFile(metaPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return isPersistedScriptRunFile(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isUnreadableMetaText(raw: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return true;
  }
  return !isPersistedScriptRunFile(parsed);
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

/**
 * Keep metadata this version cannot read, with its log, as
 * `{stem}.json.unreadable-<ms>` / `{stem}.log.unreadable-<ms>` instead of
 * overwriting it. Only the newest pair is kept per script.
 */
async function setAsideUnreadableScriptRun(paths: {
  dirPath: string;
  metaPath: string;
  logPath: string;
}): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(paths.metaPath, 'utf8');
  } catch {
    return;
  }
  if (!isUnreadableMetaText(raw)) {
    return;
  }

  const metaAsidePrefix = `${basename(paths.metaPath)}.unreadable-`;
  const logAsidePrefix = `${basename(paths.logPath)}.unreadable-`;
  const names = await readdir(paths.dirPath);
  await Promise.all(
    names
      .filter(
        (name) =>
          name.startsWith(metaAsidePrefix) || name.startsWith(logAsidePrefix),
      )
      .map((name) => rm(join(paths.dirPath, name), { force: true })),
  );

  const suffix = `.unreadable-${Date.now()}`;
  await rename(paths.metaPath, `${paths.metaPath}${suffix}`);
  try {
    await rename(paths.logPath, `${paths.logPath}${suffix}`);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
}

export async function startScriptRunLog(args: {
  projectId: string;
  worktreeId: string;
  script: ScriptDescriptor;
  invocation: ScriptStartedEvent['invocation'];
}): Promise<ScriptRunLogRef> {
  const runId = randomUUID();
  const { dirPath, metaPath, logPath } = getScriptRunPaths(
    args.projectId,
    args.worktreeId,
    args.script.scriptKey,
  );
  const now = new Date().toISOString();
  const payload: PersistedScriptRunFile = {
    version: 1,
    runId,
    script: args.script,
    invocation: args.invocation,
    status: 'running',
    startedAt: now,
    updatedAt: now,
    exitCode: null,
    timedOut: false,
    durationMs: 0,
  };

  await startRunLogFiles({
    coordinator: runLogs,
    projectId: args.projectId,
    worktreeId: args.worktreeId,
    runKey: args.script.scriptKey,
    runId,
    paths: { dirPath, metaPath, logPath },
    meta: payload,
    beforeStart: async () => {
      await setAsideUnreadableScriptRun({ dirPath, metaPath, logPath }).catch(
        (error: unknown) => {
          logMainProcessWarn(
            '[script-log-store] Failed to set aside unreadable script run metadata',
            { error: error instanceof Error ? error.message : String(error) },
          );
        },
      );
    },
  });

  return {
    projectId: args.projectId,
    worktreeId: args.worktreeId,
    script: args.script,
    runId,
  };
}

export async function appendScriptRunLogLines(args: {
  ref: ScriptRunLogRef;
  lines: string[];
}): Promise<void> {
  const { metaPath, logPath } = getScriptRunPaths(
    args.ref.projectId,
    args.ref.worktreeId,
    args.ref.script.scriptKey,
  );
  await appendRunLogLines({
    coordinator: runLogs,
    projectId: args.ref.projectId,
    worktreeId: args.ref.worktreeId,
    runKey: args.ref.script.scriptKey,
    runId: args.ref.runId,
    logPath,
    lines: args.lines,
    isCurrentRun: async () => {
      const meta = await readMeta(metaPath);
      return Boolean(meta && meta.runId === args.ref.runId);
    },
  });
}

export async function completeScriptRunLog(args: {
  ref: ScriptRunLogRef;
  response: ScriptRunResponse;
}): Promise<void> {
  const { metaPath, logPath } = getScriptRunPaths(
    args.ref.projectId,
    args.ref.worktreeId,
    args.ref.script.scriptKey,
  );
  await completeRunLogFiles({
    coordinator: runLogs,
    projectId: args.ref.projectId,
    worktreeId: args.ref.worktreeId,
    runKey: args.ref.script.scriptKey,
    runId: args.ref.runId,
    paths: { metaPath, logPath },
    readMeta: () => readMeta(metaPath),
    buildNextMeta: (meta, now): PersistedScriptRunFile => ({
      ...meta,
      status: args.response.success
        ? 'success'
        : args.response.exitCode === null && !args.response.timedOut
          ? 'cancelled'
          : 'failed',
      updatedAt: now,
      completedAt: now,
      exitCode: args.response.exitCode,
      timedOut: args.response.timedOut,
      durationMs: args.response.durationMs,
    }),
  });
}

export async function readScriptRunLogTail(args: {
  projectId: string;
  worktreeId: string;
  scriptKey: string;
  maxLines: number;
}): Promise<{
  meta: PersistedScriptRunFile | null;
  lines: string[];
}> {
  await runLogs.awaitPendingWrite(
    args.projectId,
    args.worktreeId,
    args.scriptKey,
  );

  const { metaPath, logPath } = getScriptRunPaths(
    args.projectId,
    args.worktreeId,
    args.scriptKey,
  );
  const meta = await readMeta(metaPath);
  if (!meta) {
    return { meta: null, lines: [] };
  }

  return { meta, lines: await readRunLogTailLines(logPath, args.maxLines) };
}

export async function listScriptRunLogTails(args: {
  projectId: string;
  worktreeId: string;
  maxLines: number;
}): Promise<
  Array<{
    meta: PersistedScriptRunFile;
    lines: string[];
  }>
> {
  const dirPath = resolveScriptRunDir(args.projectId, args.worktreeId);
  const entries = await readdir(dirPath, { withFileTypes: true }).catch(
    () => [],
  );

  const runs = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map(async (entry) => {
        const metaPath = join(dirPath, entry.name);
        const meta = await readMeta(metaPath);
        if (!meta) {
          return null;
        }

        await runLogs.awaitPendingWrite(
          args.projectId,
          args.worktreeId,
          meta.script.scriptKey,
        );

        const logPath = join(
          dirPath,
          `${entry.name.slice(0, -'.json'.length)}.log`,
        );
        return {
          meta,
          lines: await readRunLogTailLines(logPath, args.maxLines),
        };
      }),
  );

  return runs.flatMap((run) => (run ? [run] : []));
}

export async function deleteScriptRunLogsForWorktree(
  projectId: string,
  worktreeId: string,
): Promise<void> {
  await runLogs.deleteWorktreeLogs(projectId, worktreeId, async () => {
    await rm(resolveScriptRunDir(projectId, worktreeId), {
      recursive: true,
      force: true,
    });
  });
}

export type ScriptRunLogSnapshotResult =
  | { status: 'copied' }
  | { status: 'superseded' }
  | { status: 'missing' }
  | { status: 'error'; message: string };

function describeFileError(error: unknown): string {
  if (isRecord(error) && typeof error.code === 'string') {
    return error.code;
  }
  return error instanceof Error ? error.name : 'unknown error';
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy one script run's canonical log to `targetPath` without letting a later
 * run substitute its output.
 *
 * - Runs on the script key's write chain, so pending appends and completion
 *   for this run land first, and no new run can replace the log mid-copy.
 * - `superseded` when the canonical metadata now names a different run;
 *   `missing` when no metadata or log exists (or the worktree's logs are
 *   being deleted). A running script yields a partial copy.
 * - The copy is written to a sibling temp file and renamed into place. An
 *   existing `targetPath` is never overwritten: finalized copies are
 *   immutable, so the call returns `error` and leaves the file untouched.
 *   Callers use a fresh target per attempt; the existence check and rename are
 *   not atomic against a concurrent writer of the same target.
 * - Any filesystem failure, including a source the writer holds open on
 *   Windows (`EBUSY`/`EPERM`), resolves as `error` with the error code; it
 *   never throws. Messages carry error codes only, never paths or log text.
 */
export async function snapshotScriptRunLog(args: {
  ref: ScriptRunLogRef;
  targetPath: string;
}): Promise<ScriptRunLogSnapshotResult> {
  const { projectId, worktreeId, script, runId } = args.ref;
  const { metaPath, logPath } = getScriptRunPaths(
    projectId,
    worktreeId,
    script.scriptKey,
  );
  const tempPath = join(
    dirname(args.targetPath),
    `.${basename(args.targetPath)}.${randomUUID()}.tmp`,
  );
  try {
    if (runLogs.isDeletingWorktreeLogs(projectId, worktreeId)) {
      return { status: 'missing' };
    }
    return await runLogs.withWriteChain(
      runLogs.getWriteKey(projectId, worktreeId, script.scriptKey),
      async (): Promise<ScriptRunLogSnapshotResult> => {
        if (runLogs.isDeletingWorktreeLogs(projectId, worktreeId)) {
          return { status: 'missing' };
        }
        const meta = await readMeta(metaPath);
        if (!meta) {
          return { status: 'missing' };
        }
        if (meta.runId !== runId) {
          return { status: 'superseded' };
        }
        if (!(await pathExists(logPath))) {
          return { status: 'missing' };
        }
        if (await pathExists(args.targetPath)) {
          return {
            status: 'error',
            message: 'script log copy target already exists',
          };
        }
        await mkdir(dirname(args.targetPath), { recursive: true });
        await copyFile(logPath, tempPath);
        await rename(tempPath, args.targetPath);
        return { status: 'copied' };
      },
    );
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    return {
      status: 'error',
      message: `script log copy failed: ${describeFileError(error)}`,
    };
  }
}

/**
 * Read a script key's canonical run metadata after its pending writes settle.
 * Callers compare `runId` with their recorded run and read `status`
 * (`running` until completion) and `exitCode`.
 */
export async function readScriptRunMeta(
  ref: Pick<ScriptRunLogRef, 'projectId' | 'worktreeId'> & {
    scriptKey: string;
  },
): Promise<PersistedScriptRunFile | null> {
  await runLogs.awaitPendingWrite(ref.projectId, ref.worktreeId, ref.scriptKey);
  const { metaPath } = getScriptRunPaths(
    ref.projectId,
    ref.worktreeId,
    ref.scriptKey,
  );
  return readMeta(metaPath);
}
