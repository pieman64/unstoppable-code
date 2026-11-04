import { randomUUID } from 'node:crypto';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import {
  appendRunLogLines,
  completeRunLogFiles,
  createRunLogCoordinator,
  readRunLogTailLines,
  startRunLogFiles,
  writeRunLogMeta,
  type RunLogCoordinator,
  type RunLogFiles,
} from '../script/execution/run-log-files';

/*
 * The hook run ledger's owned store, `hook_invocations` (CAN-4144, qualified
 * by CAN-5069): one directory per run with `meta.json` and `output.log`. The
 * initiated-work engine's hook source writes it; each run names the
 * `core.initiatedWork.run` operation it belongs to. The host supplies the
 * directory and the atomic writer.
 */

/** Finished runs kept per hook key; older ones are pruned when a run starts. */
export const MAX_RETAINED_HOOK_RUNS_PER_HOOK = 20;

/** The hook fields the store reads; hosts keep their own descriptor type. */
export interface HookInvocationDescriptor {
  readonly hookKey: string;
  readonly triggerName: string;
  readonly label: string;
  readonly actions: readonly unknown[];
  readonly target: 'project' | 'workspace-root' | 'workspace-repo';
  readonly repoId?: string;
  readonly repoName?: string;
}

export interface PersistedHookInvocation<
  THook extends HookInvocationDescriptor,
> {
  version: 1;
  runId: string;
  /** The `core.initiatedWork.run` operation; absent on runs before CAN-4144. */
  operationId?: string;
  hook: THook;
  invocation: 'automatic' | 'manual';
  status: 'running' | 'success' | 'failed' | 'cancelled';
  /** A `cancelled` run its command gate stopped on purpose, not a stop request. */
  stoppedBy?: 'commandGate';
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** Zero-based index of the action currently producing output. */
  activeActionIndex?: number;
}

export interface HookInvocationRef<THook extends HookInvocationDescriptor> {
  projectId: string;
  worktreeId: string;
  hook: THook;
  runId: string;
}

export interface HookInvocationResponse {
  success: boolean;
  stopped?: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}

export interface HookInvocationStoreHost {
  /** The worktree's `hook-invocations` directory. */
  invocationsDir(projectId: string, worktreeId: string): string;
  files: RunLogFiles;
  warn?(message: string, details: Record<string, unknown>): void;
}

interface HookInvocationEntry<THook extends HookInvocationDescriptor> {
  dirName: string;
  meta: PersistedHookInvocation<THook>;
  logPath: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTarget(value: unknown): boolean {
  return (
    value === 'project' ||
    value === 'workspace-root' ||
    value === 'workspace-repo'
  );
}

function hasHookFields(value: Record<string, unknown>): boolean {
  return (
    typeof value.hookKey === 'string' &&
    typeof value.triggerName === 'string' &&
    typeof value.label === 'string' &&
    Array.isArray(value.actions) &&
    isTarget(value.target) &&
    (value.repoId === undefined || typeof value.repoId === 'string') &&
    (value.repoName === undefined || typeof value.repoName === 'string')
  );
}

export class HookInvocationStore<THook extends HookInvocationDescriptor> {
  private readonly runLogs: RunLogCoordinator;
  private readonly liveRunIds = new Set<string>();

  constructor(private readonly host: HookInvocationStoreHost) {
    this.runLogs = createRunLogCoordinator(host.files);
  }

  private paths(
    projectId: string,
    worktreeId: string,
    runId: string,
  ): { dirPath: string; metaPath: string; logPath: string } {
    const dirPath = join(
      this.host.invocationsDir(projectId, worktreeId),
      runId,
    );
    return {
      dirPath,
      metaPath: join(dirPath, 'meta.json'),
      logPath: join(dirPath, 'output.log'),
    };
  }

  private isPersisted(value: unknown): value is PersistedHookInvocation<THook> {
    if (!isRecord(value) || !isRecord(value.hook)) return false;
    const hook = value.hook;
    return (
      value.version === 1 &&
      typeof value.runId === 'string' &&
      (value.operationId === undefined ||
        typeof value.operationId === 'string') &&
      hasHookFields(hook) &&
      (value.invocation === 'automatic' || value.invocation === 'manual') &&
      (value.status === 'running' ||
        value.status === 'success' ||
        value.status === 'failed' ||
        value.status === 'cancelled') &&
      (value.stoppedBy === undefined || value.stoppedBy === 'commandGate') &&
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

  private async readMeta(
    metaPath: string,
  ): Promise<PersistedHookInvocation<THook> | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(metaPath, 'utf8'));
      return this.isPersisted(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  /**
   * A run persisted as running that no run in this process owns was
   * interrupted (for example by a crash); report it as cancelled. Liveness
   * is checked before the metadata is read: completion writes its final
   * status before the run stops being live.
   */
  private async readResolvedMeta(
    metaPath: string,
    runId: string,
  ): Promise<PersistedHookInvocation<THook> | null> {
    const live = this.liveRunIds.has(runId);
    const meta = await this.readMeta(metaPath);
    if (!meta || meta.status !== 'running' || live) return meta;
    return {
      ...meta,
      status: 'cancelled',
      completedAt: meta.completedAt ?? meta.updatedAt,
    };
  }

  private async listEntries(
    projectId: string,
    worktreeId: string,
  ): Promise<HookInvocationEntry<THook>[]> {
    const entries = await readdir(
      this.host.invocationsDir(projectId, worktreeId),
      { withFileTypes: true },
    ).catch(() => []);
    const runs = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const { metaPath, logPath } = this.paths(
            projectId,
            worktreeId,
            entry.name,
          );
          const meta = await this.readMeta(metaPath);
          return meta ? { dirName: entry.name, meta, logPath } : null;
        }),
    );
    return runs.flatMap((run) => (run ? [run] : []));
  }

  private async pruneFinished(
    projectId: string,
    worktreeId: string,
    hookKey: string,
  ): Promise<void> {
    const finished = (await this.listEntries(projectId, worktreeId))
      .filter(
        (entry) =>
          entry.meta.hook.hookKey === hookKey &&
          entry.meta.status !== 'running' &&
          !this.liveRunIds.has(entry.meta.runId),
      )
      .sort(
        (left, right) =>
          right.meta.startedAt.localeCompare(left.meta.startedAt) ||
          right.dirName.localeCompare(left.dirName),
      );
    const invocationsDir = this.host.invocationsDir(projectId, worktreeId);
    await Promise.all(
      finished.slice(MAX_RETAINED_HOOK_RUNS_PER_HOOK).map(async (entry) => {
        try {
          await rm(join(invocationsDir, entry.dirName), {
            recursive: true,
            force: true,
          });
        } catch (error) {
          this.host.warn?.('[hook-log-store] Failed to prune a hook run', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    );
  }

  private async readEntryTail(
    projectId: string,
    worktreeId: string,
    entry: HookInvocationEntry<THook>,
    maxLines: number,
  ): Promise<{ meta: PersistedHookInvocation<THook>; lines: string[] }> {
    await this.runLogs.awaitPendingWrite(
      projectId,
      worktreeId,
      entry.meta.hook.hookKey,
    );
    const lines = await readRunLogTailLines(entry.logPath, maxLines);
    const { metaPath } = this.paths(projectId, worktreeId, entry.dirName);
    const meta =
      (await this.readResolvedMeta(metaPath, entry.meta.runId)) ?? entry.meta;
    return { meta, lines };
  }

  async start(args: {
    projectId: string;
    worktreeId: string;
    hook: THook;
    invocation: 'automatic' | 'manual';
    operationId?: string;
  }): Promise<HookInvocationRef<THook>> {
    const runId = randomUUID();
    const paths = this.paths(args.projectId, args.worktreeId, runId);
    const now = new Date().toISOString();
    const payload: PersistedHookInvocation<THook> = {
      version: 1,
      runId,
      ...(args.operationId !== undefined
        ? { operationId: args.operationId }
        : {}),
      hook: args.hook,
      invocation: args.invocation,
      status: 'running',
      startedAt: now,
      updatedAt: now,
      exitCode: null,
      timedOut: false,
      durationMs: 0,
    };

    this.liveRunIds.add(runId);
    try {
      await startRunLogFiles({
        coordinator: this.runLogs,
        projectId: args.projectId,
        worktreeId: args.worktreeId,
        runKey: args.hook.hookKey,
        runId,
        paths,
        meta: payload,
        beforeStart: () =>
          this.pruneFinished(
            args.projectId,
            args.worktreeId,
            args.hook.hookKey,
          ),
      });
    } catch (error) {
      this.liveRunIds.delete(runId);
      throw error;
    }
    return {
      projectId: args.projectId,
      worktreeId: args.worktreeId,
      hook: args.hook,
      runId,
    };
  }

  async appendLines(args: {
    ref: HookInvocationRef<THook>;
    lines: string[];
    activeActionIndex?: number;
  }): Promise<void> {
    const { ref } = args;
    const { metaPath, logPath } = this.paths(
      ref.projectId,
      ref.worktreeId,
      ref.runId,
    );
    await appendRunLogLines({
      coordinator: this.runLogs,
      projectId: ref.projectId,
      worktreeId: ref.worktreeId,
      runKey: ref.hook.hookKey,
      runId: ref.runId,
      logPath,
      lines: args.lines,
      isCurrentRun: async () => {
        const meta = await this.readMeta(metaPath);
        return Boolean(meta && meta.runId === ref.runId);
      },
    });

    if (args.activeActionIndex === undefined) return;
    const writeKey = this.runLogs.getWriteKey(
      ref.projectId,
      ref.worktreeId,
      ref.hook.hookKey,
    );
    await this.runLogs.withWriteChain(writeKey, async () => {
      if (this.runLogs.isDeletingWorktreeLogs(ref.projectId, ref.worktreeId))
        return;
      const meta = await this.readMeta(metaPath);
      if (!meta || meta.runId !== ref.runId) return;
      await writeRunLogMeta(this.host.files, metaPath, {
        ...meta,
        activeActionIndex: args.activeActionIndex,
        updatedAt: new Date().toISOString(),
      });
    });
  }

  async complete(args: {
    ref: HookInvocationRef<THook>;
    response: HookInvocationResponse;
    stoppedBy?: 'commandGate';
  }): Promise<void> {
    const { ref, response } = args;
    const { metaPath, logPath } = this.paths(
      ref.projectId,
      ref.worktreeId,
      ref.runId,
    );
    try {
      await completeRunLogFiles({
        coordinator: this.runLogs,
        projectId: ref.projectId,
        worktreeId: ref.worktreeId,
        runKey: ref.hook.hookKey,
        runId: ref.runId,
        paths: { metaPath, logPath },
        readMeta: () => this.readMeta(metaPath),
        buildNextMeta: (meta, now): PersistedHookInvocation<THook> => ({
          ...meta,
          status: response.success
            ? 'success'
            : response.stopped ||
                (response.exitCode === null && !response.timedOut)
              ? 'cancelled'
              : 'failed',
          updatedAt: now,
          completedAt: now,
          exitCode: response.exitCode,
          timedOut: response.timedOut,
          durationMs: response.durationMs,
          ...(args.stoppedBy ? { stoppedBy: args.stoppedBy } : {}),
        }),
      });
    } finally {
      this.liveRunIds.delete(ref.runId);
    }
  }

  /**
   * The run started under an operation, as persisted: a run still marked
   * running that no run in this process owns was interrupted.
   */
  async findByOperation(args: {
    projectId: string;
    worktreeId: string;
    operationId: string;
  }): Promise<PersistedHookInvocation<THook> | null> {
    const entries = await this.listEntries(args.projectId, args.worktreeId);
    return (
      entries.find((entry) => entry.meta.operationId === args.operationId)
        ?.meta ?? null
    );
  }

  async readTail(args: {
    projectId: string;
    worktreeId: string;
    runId: string;
    maxLines: number;
  }): Promise<{
    meta: PersistedHookInvocation<THook> | null;
    lines: string[];
  }> {
    const { metaPath, logPath } = this.paths(
      args.projectId,
      args.worktreeId,
      args.runId,
    );
    if (!(await this.readMeta(metaPath))) return { meta: null, lines: [] };
    const lines = await readRunLogTailLines(logPath, args.maxLines);
    return { meta: await this.readResolvedMeta(metaPath, args.runId), lines };
  }

  async listTails(args: {
    projectId: string;
    worktreeId: string;
    maxLines: number;
  }): Promise<
    Array<{ meta: PersistedHookInvocation<THook>; lines: string[] }>
  > {
    const entries = await this.listEntries(args.projectId, args.worktreeId);
    return Promise.all(
      entries.map((entry) =>
        this.readEntryTail(
          args.projectId,
          args.worktreeId,
          entry,
          args.maxLines,
        ),
      ),
    );
  }

  async listLatestTails(args: {
    projectId: string;
    worktreeId: string;
    maxLines: number;
  }): Promise<
    Array<{ meta: PersistedHookInvocation<THook>; lines: string[] }>
  > {
    const entries = await this.listEntries(args.projectId, args.worktreeId);
    const latestByHookKey = new Map<string, HookInvocationEntry<THook>>();
    for (const entry of entries) {
      const existing = latestByHookKey.get(entry.meta.hook.hookKey);
      if (!existing || entry.meta.startedAt > existing.meta.startedAt)
        latestByHookKey.set(entry.meta.hook.hookKey, entry);
    }
    return Promise.all(
      Array.from(latestByHookKey.values()).map((entry) =>
        this.readEntryTail(
          args.projectId,
          args.worktreeId,
          entry,
          args.maxLines,
        ),
      ),
    );
  }

  async deleteForWorktree(
    projectId: string,
    worktreeId: string,
  ): Promise<void> {
    await this.runLogs.deleteWorktreeLogs(projectId, worktreeId, async () => {
      await rm(this.host.invocationsDir(projectId, worktreeId), {
        recursive: true,
        force: true,
      });
    });
  }
}
