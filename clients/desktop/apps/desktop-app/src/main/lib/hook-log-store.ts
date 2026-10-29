import { randomUUID } from 'node:crypto';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  HookDescriptor,
  HookRunResponse,
} from '@canopy/desktop-shared/types';
import { getHookInvocationDir, getHookInvocationsDir } from './paths';
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

export interface PersistedHookRunFile {
  version: 1;
  runId: string;
  hook: HookDescriptor;
  invocation: 'automatic' | 'manual';
  status: 'running' | 'success' | 'failed' | 'cancelled';
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** Zero-based index of the action currently producing output. */
  activeActionIndex?: number;
}

export interface HookRunLogRef {
  projectId: string;
  worktreeId: string;
  hook: HookDescriptor;
  runId: string;
}

function getHookRunPaths(
  projectId: string,
  worktreeId: string,
  runId: string,
): {
  dirPath: string;
  metaPath: string;
  logPath: string;
} {
  const dirPath = getHookInvocationDir(projectId, worktreeId, runId);
  return {
    dirPath,
    metaPath: join(dirPath, 'meta.json'),
    logPath: join(dirPath, 'output.log'),
  };
}

function isHookTarget(value: unknown): value is HookDescriptor['target'] {
  return (
    value === 'project' ||
    value === 'workspace-root' ||
    value === 'workspace-repo'
  );
}

function isHookDescriptor(value: unknown): value is HookDescriptor {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.hookKey === 'string' &&
    typeof value.triggerName === 'string' &&
    typeof value.label === 'string' &&
    Array.isArray(value.actions) &&
    isHookTarget(value.target) &&
    (value.repoId === undefined || typeof value.repoId === 'string') &&
    (value.repoName === undefined || typeof value.repoName === 'string')
  );
}

function isPersistedHookRunFile(value: unknown): value is PersistedHookRunFile {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.version === 1 &&
    typeof value.runId === 'string' &&
    isHookDescriptor(value.hook) &&
    (value.invocation === 'automatic' || value.invocation === 'manual') &&
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
    typeof value.durationMs === 'number' &&
    (value.activeActionIndex === undefined ||
      (typeof value.activeActionIndex === 'number' &&
        Number.isInteger(value.activeActionIndex) &&
        value.activeActionIndex >= 0))
  );
}

async function readMeta(
  metaPath: string,
): Promise<PersistedHookRunFile | null> {
  try {
    const raw = await readFile(metaPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return isPersistedHookRunFile(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

interface HookRunLogEntry {
  meta: PersistedHookRunFile;
  logPath: string;
}

async function listHookRunLogEntries(args: {
  projectId: string;
  worktreeId: string;
}): Promise<HookRunLogEntry[]> {
  const dirPath = getHookInvocationsDir(args.projectId, args.worktreeId);
  const entries = await readdir(dirPath, { withFileTypes: true }).catch(
    () => [],
  );

  const runs = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const { metaPath, logPath } = getHookRunPaths(
          args.projectId,
          args.worktreeId,
          entry.name,
        );
        const meta = await readMeta(metaPath);
        return meta ? { meta, logPath } : null;
      }),
  );

  return runs.flatMap((run) => (run ? [run] : []));
}

async function readHookRunLogEntryTail(args: {
  projectId: string;
  worktreeId: string;
  entry: HookRunLogEntry;
  maxLines: number;
}): Promise<{
  meta: PersistedHookRunFile;
  lines: string[];
}> {
  await runLogs.awaitPendingWrite(
    args.projectId,
    args.worktreeId,
    args.entry.meta.hook.hookKey,
  );

  const raw = await readFile(args.entry.logPath, 'utf8').catch(() => '');
  const allLines = args.maxLines === 0 ? [] : parseLogLines(raw);
  const lines =
    allLines.length > args.maxLines ? allLines.slice(-args.maxLines) : allLines;
  return { meta: args.entry.meta, lines };
}

export async function startHookRunLog(args: {
  projectId: string;
  worktreeId: string;
  hook: HookDescriptor;
  invocation: 'automatic' | 'manual';
}): Promise<HookRunLogRef> {
  const runId = randomUUID();
  const { dirPath, metaPath, logPath } = getHookRunPaths(
    args.projectId,
    args.worktreeId,
    runId,
  );
  const now = new Date().toISOString();
  const payload: PersistedHookRunFile = {
    version: 1,
    runId,
    hook: args.hook,
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
    runKey: args.hook.hookKey,
    runId,
    paths: { dirPath, metaPath, logPath },
    meta: payload,
  });

  return {
    projectId: args.projectId,
    worktreeId: args.worktreeId,
    hook: args.hook,
    runId,
  };
}

export async function appendHookRunLogLines(args: {
  ref: HookRunLogRef;
  lines: string[];
  activeActionIndex?: number;
}): Promise<void> {
  const { metaPath, logPath } = getHookRunPaths(
    args.ref.projectId,
    args.ref.worktreeId,
    args.ref.runId,
  );
  await appendRunLogLines({
    coordinator: runLogs,
    projectId: args.ref.projectId,
    worktreeId: args.ref.worktreeId,
    runKey: args.ref.hook.hookKey,
    runId: args.ref.runId,
    logPath,
    lines: args.lines,
    isCurrentRun: async () => {
      const meta = await readMeta(metaPath);
      return Boolean(meta && meta.runId === args.ref.runId);
    },
  });

  if (args.activeActionIndex === undefined) {
    return;
  }
  const writeKey = runLogs.getWriteKey(
    args.ref.projectId,
    args.ref.worktreeId,
    args.ref.hook.hookKey,
  );
  await runLogs.withWriteChain(writeKey, async () => {
    if (
      runLogs.isDeletingWorktreeLogs(args.ref.projectId, args.ref.worktreeId)
    ) {
      return;
    }
    const meta = await readMeta(metaPath);
    if (!meta || meta.runId !== args.ref.runId) {
      return;
    }
    await writeFile(
      metaPath,
      JSON.stringify(
        {
          ...meta,
          activeActionIndex: args.activeActionIndex,
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      'utf8',
    );
  });
}

export async function completeHookRunLog(args: {
  ref: HookRunLogRef;
  response: HookRunResponse;
}): Promise<void> {
  const { metaPath, logPath } = getHookRunPaths(
    args.ref.projectId,
    args.ref.worktreeId,
    args.ref.runId,
  );
  await completeRunLogFiles({
    coordinator: runLogs,
    projectId: args.ref.projectId,
    worktreeId: args.ref.worktreeId,
    runKey: args.ref.hook.hookKey,
    runId: args.ref.runId,
    paths: { metaPath, logPath },
    readMeta: () => readMeta(metaPath),
    buildNextMeta: (meta, now): PersistedHookRunFile => ({
      ...meta,
      status: args.response.success
        ? 'success'
        : args.response.stopped || args.response.exitCode === null
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

export async function readHookRunLogTail(args: {
  projectId: string;
  worktreeId: string;
  runId: string;
  maxLines: number;
}): Promise<{
  meta: PersistedHookRunFile | null;
  lines: string[];
}> {
  const { metaPath, logPath } = getHookRunPaths(
    args.projectId,
    args.worktreeId,
    args.runId,
  );
  const meta = await readMeta(metaPath);
  if (!meta) return { meta: null, lines: [] };

  const safeMaxLines = Math.max(0, Math.min(args.maxLines, MAX_RUN_LOG_LINES));
  if (safeMaxLines === 0) return { meta, lines: [] };

  const raw = await readFile(logPath, 'utf8').catch(() => '');
  const allLines = parseLogLines(raw);
  const lines =
    allLines.length > safeMaxLines ? allLines.slice(-safeMaxLines) : allLines;
  return { meta, lines };
}

export async function listHookRunLogTails(args: {
  projectId: string;
  worktreeId: string;
  maxLines: number;
}): Promise<
  Array<{
    meta: PersistedHookRunFile;
    lines: string[];
  }>
> {
  const safeMaxLines = Math.max(0, Math.min(args.maxLines, MAX_RUN_LOG_LINES));
  const entries = await listHookRunLogEntries({
    projectId: args.projectId,
    worktreeId: args.worktreeId,
  });

  const runs = await Promise.all(
    entries.map((entry) =>
      readHookRunLogEntryTail({
        projectId: args.projectId,
        worktreeId: args.worktreeId,
        entry,
        maxLines: safeMaxLines,
      }),
    ),
  );

  return runs;
}

export async function listLatestHookRunLogTails(args: {
  projectId: string;
  worktreeId: string;
  maxLines: number;
}): Promise<
  Array<{
    meta: PersistedHookRunFile;
    lines: string[];
  }>
> {
  const safeMaxLines = Math.max(0, Math.min(args.maxLines, MAX_RUN_LOG_LINES));
  const entries = await listHookRunLogEntries({
    projectId: args.projectId,
    worktreeId: args.worktreeId,
  });

  const latestByHookKey = new Map<string, HookRunLogEntry>();
  for (const entry of entries) {
    const existing = latestByHookKey.get(entry.meta.hook.hookKey);
    if (!existing || entry.meta.startedAt > existing.meta.startedAt) {
      latestByHookKey.set(entry.meta.hook.hookKey, entry);
    }
  }

  return Promise.all(
    Array.from(latestByHookKey.values()).map((entry) =>
      readHookRunLogEntryTail({
        projectId: args.projectId,
        worktreeId: args.worktreeId,
        entry,
        maxLines: safeMaxLines,
      }),
    ),
  );
}

export async function deleteHookRunLogsForWorktree(
  projectId: string,
  worktreeId: string,
): Promise<void> {
  await runLogs.deleteWorktreeLogs(projectId, worktreeId, async () => {
    await rm(getHookInvocationsDir(projectId, worktreeId), {
      recursive: true,
      force: true,
    });
  });
}
