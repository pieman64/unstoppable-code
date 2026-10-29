import { randomUUID } from 'node:crypto';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
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
import { buildScriptRunFileStem, resolveScriptRunDir } from './paths';
import {
  appendRunLogLines,
  completeRunLogFiles,
  createRunLogCoordinator,
  MAX_RUN_LOG_LINES,
  parseLogLines,
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

  const safeMaxLines = Math.max(0, Math.min(args.maxLines, MAX_RUN_LOG_LINES));
  if (safeMaxLines === 0) {
    return { meta, lines: [] };
  }

  const raw = await readFile(logPath, 'utf8').catch(() => '');
  const allLines = parseLogLines(raw);
  const lines =
    allLines.length > safeMaxLines ? allLines.slice(-safeMaxLines) : allLines;
  return { meta, lines };
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
  const safeMaxLines = Math.max(0, Math.min(args.maxLines, MAX_RUN_LOG_LINES));

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
        const raw = await readFile(logPath, 'utf8').catch(() => '');
        const allLines = safeMaxLines === 0 ? [] : parseLogLines(raw);
        const lines =
          allLines.length > safeMaxLines
            ? allLines.slice(-safeMaxLines)
            : allLines;
        return { meta, lines };
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
