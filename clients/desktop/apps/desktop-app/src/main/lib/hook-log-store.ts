import { randomUUID } from 'node:crypto';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  HookDescriptor,
  HookRunResponse,
} from '@canopy/desktop-shared/types';
import { logMainProcessWarn } from './main-process-logging';
import { getHookInvocationDir, getHookInvocationsDir } from './paths';
import {
  appendRunLogLines,
  completeRunLogFiles,
  createRunLogCoordinator,
  readRunLogTailLines,
  startRunLogFiles,
  writeRunLogMeta,
} from './run-log-store';
import { isRecord } from './type-guards';

const runLogs = createRunLogCoordinator();
const liveRunIds = new Set<string>();

/** Finished runs kept per hook key; older ones are pruned when a run starts. */
export const MAX_RETAINED_HOOK_RUNS_PER_HOOK = 20;

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

/**
 * A run persisted as running that no hook run in this process owns was
 * interrupted (for example by a crash); report it as cancelled. Liveness is
 * checked before the metadata is read: completion writes its final status
 * before the run stops being live, so a run seen as not live already has its
 * final status on disk.
 */
async function readResolvedRunMeta(
  metaPath: string,
  runId: string,
): Promise<PersistedHookRunFile | null> {
  const live = liveRunIds.has(runId);
  const meta = await readMeta(metaPath);
  if (!meta || meta.status !== 'running' || live) {
    return meta;
  }
  return {
    ...meta,
    status: 'cancelled',
    completedAt: meta.completedAt ?? meta.updatedAt,
  };
}

interface HookRunLogEntry {
  dirName: string;
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
        return meta ? { dirName: entry.name, meta, logPath } : null;
      }),
  );

  return runs.flatMap((run) => (run ? [run] : []));
}

async function pruneFinishedHookRuns(args: {
  projectId: string;
  worktreeId: string;
  hookKey: string;
}): Promise<void> {
  const entries = await listHookRunLogEntries(args);
  const finished = entries
    .filter(
      (entry) =>
        entry.meta.hook.hookKey === args.hookKey &&
        entry.meta.status !== 'running' &&
        !liveRunIds.has(entry.meta.runId),
    )
    .sort(
      (left, right) =>
        right.meta.startedAt.localeCompare(left.meta.startedAt) ||
        right.dirName.localeCompare(left.dirName),
    );
  const invocationsDir = getHookInvocationsDir(args.projectId, args.worktreeId);
  await Promise.all(
    finished.slice(MAX_RETAINED_HOOK_RUNS_PER_HOOK).map(async (entry) => {
      try {
        await rm(join(invocationsDir, entry.dirName), {
          recursive: true,
          force: true,
        });
      } catch (error) {
        logMainProcessWarn('[hook-log-store] Failed to prune a hook run', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  );
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

  const lines = await readRunLogTailLines(args.entry.logPath, args.maxLines);
  const { metaPath } = getHookRunPaths(
    args.projectId,
    args.worktreeId,
    args.entry.dirName,
  );
  const meta =
    (await readResolvedRunMeta(metaPath, args.entry.meta.runId)) ??
    args.entry.meta;
  return { meta, lines };
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

  liveRunIds.add(runId);
  try {
    await startRunLogFiles({
      coordinator: runLogs,
      projectId: args.projectId,
      worktreeId: args.worktreeId,
      runKey: args.hook.hookKey,
      runId,
      paths: { dirPath, metaPath, logPath },
      meta: payload,
      beforeStart: () =>
        pruneFinishedHookRuns({
          projectId: args.projectId,
          worktreeId: args.worktreeId,
          hookKey: args.hook.hookKey,
        }),
    });
  } catch (error) {
    liveRunIds.delete(runId);
    throw error;
  }

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
    await writeRunLogMeta(metaPath, {
      ...meta,
      activeActionIndex: args.activeActionIndex,
      updatedAt: new Date().toISOString(),
    });
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
  try {
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
          : args.response.stopped ||
              (args.response.exitCode === null && !args.response.timedOut)
            ? 'cancelled'
            : 'failed',
        updatedAt: now,
        completedAt: now,
        exitCode: args.response.exitCode,
        timedOut: args.response.timedOut,
        durationMs: args.response.durationMs,
      }),
    });
  } finally {
    liveRunIds.delete(args.ref.runId);
  }
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
  if (!(await readMeta(metaPath))) return { meta: null, lines: [] };

  const lines = await readRunLogTailLines(logPath, args.maxLines);
  return { meta: await readResolvedRunMeta(metaPath, args.runId), lines };
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
  const entries = await listHookRunLogEntries({
    projectId: args.projectId,
    worktreeId: args.worktreeId,
  });

  return Promise.all(
    entries.map((entry) =>
      readHookRunLogEntryTail({
        projectId: args.projectId,
        worktreeId: args.worktreeId,
        entry,
        maxLines: args.maxLines,
      }),
    ),
  );
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
        maxLines: args.maxLines,
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
