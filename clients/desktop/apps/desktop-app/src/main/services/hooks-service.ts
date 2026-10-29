import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  HookDescriptor,
  HookRunRequest,
  HookRunResponse,
  HookRunSnapshot,
  HookSourceInfoRequest,
  HookSourceInfoResponse,
  HookStopRequest,
  SaveProjectHooksRequest,
  SaveWorkspaceHooksRequest,
  SaveWorkspaceRepoHooksRequest,
  PortalEntityEnvelope,
  PortalHookRun,
  PortalHookSummary,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import { worktreeScopedParentLocalId } from '@canopy/protocol/portal';
import { getHookTriggerDisplayName } from '@canopy/desktop-shared/types';
import { validateId } from '../lib/validation';
import { assertNotSplitLocked } from './split-lock-service';
import {
  runHook,
  stopRunningHook,
  type RunHookOptions,
} from '../lib/hook-runner';
import { PortalServiceError } from './portal-service-error';
import {
  collectProjectHookLayers,
  collectWorkspaceRepoHookLayers,
  collectWorkspaceRootHookLayers,
  getResolvedHookActions,
  resolveProjectHooks,
  resolveWorkspaceRepoHooks,
  resolveWorkspaceRootHooks,
} from '../lib/hook-resolver';
import {
  createProjectHookDescriptor,
  createWorkspaceRepoHookDescriptor,
  createWorkspaceRootHookDescriptor,
} from '../lib/hook-events';
import {
  readWorkspaceConfig,
  readWorkspaceWorktrees,
} from '../lib/workspace-persistence';
import {
  normalizePausedHookKeys,
  ScriptHookSettingsRefusedError,
  setWorktreeHooksPaused,
  updateWorkspaceHooks,
  type ScriptHookSettingsSource,
  type WorktreeHookPauseChange,
} from '../lib/workspace-script-hook-settings';
import {
  getProjectRepoStorageKey,
  getWorkspaceRepoStorageKey,
  getWorkspaceRootRepoStorageKey,
  readCurrentPrTrackingSnapshot,
} from '../lib/github-pr-hook-state';
import {
  getWorktreeDir,
  getHookInvocationsDir,
  getWorkspaceWorktreeRepoDir,
  getWorkspaceWorktreeRootRepoDir,
} from '../lib/paths';
import { readPreferencesFile } from '../lib/preferences-store';
import { readAllSidebarItems } from '../lib/sidebar-items';
import type { HookRunLogRef } from '../lib/hook-log-store';
import {
  listLatestHookRunLogTails,
  readHookRunLogTail,
} from '../lib/hook-log-store';
import { emitPortalFeatureUpsert } from './portal-feature-event-service';
import {
  settleAll,
  trackDetachedWork,
} from '@canopy/desktop-shared/node/lib/detached-work';

export async function getWorktreePausedHookKeys(input: {
  projectId: string;
  worktreeId: string;
}): Promise<string[]> {
  validateId(input.projectId, 'projectId');
  validateId(input.worktreeId, 'worktreeId');
  const worktree = (await readWorkspaceWorktrees(input.projectId)).find(
    (candidate) => candidate.id === input.worktreeId,
  );
  if (!worktree) {
    throw new PortalServiceError(
      'not_found',
      `Worktree ${input.worktreeId} not found in project ${input.projectId}`,
    );
  }
  return normalizePausedHookKeys(worktree.pausedHookKeys ?? []);
}

/**
 * `core.worktree.hooks.setPaused` for the hooks service's callers: the
 * renderer's `worktree:set-paused-hooks` replaces the whole set, and the
 * portal and App Advisor pause or resume named keys. An unknown worktree is
 * refused as `not_found`, as it always was.
 */
export async function changeWorktreeHookPause(input: {
  projectId: string;
  worktreeId: string;
  change: WorktreeHookPauseChange;
  source: ScriptHookSettingsSource;
}): Promise<{ worktree: WorktreeData; pausedHookKeys: string[] }> {
  try {
    const outcome = await setWorktreeHooksPaused({
      workspaceId: input.projectId,
      worktreeId: input.worktreeId,
      change: input.change,
      source: input.source,
    });
    return {
      worktree: outcome.worktree,
      pausedHookKeys: outcome.pausedHookKeys,
    };
  } catch (error) {
    if (
      error instanceof ScriptHookSettingsRefusedError &&
      error.reason === 'not-found'
    ) {
      throw new PortalServiceError('not_found', error.message);
    }
    throw error;
  }
}

export async function setWorktreePausedHookKeys(input: {
  projectId: string;
  worktreeId: string;
  pausedHookKeys: readonly unknown[];
}): Promise<WorktreeData> {
  const { worktree } = await changeWorktreeHookPause({
    projectId: input.projectId,
    worktreeId: input.worktreeId,
    change: { kind: 'replace', pausedHookKeys: input.pausedHookKeys },
    source: 'desktop',
  });
  return worktree;
}

const NOOP_SUCCESS: HookRunResponse = {
  success: true,
  stopped: false,
  exitCode: 0,
  output: '',
  timedOut: false,
  durationMs: 0,
};
const RUN_TAIL_MAX_BYTES = 8 * 1024;
const MANUAL_RUN_REQUIRES_ACTIVE_PR = 'Manual run requires an active PR';

export async function portalHookRunAvailability(
  input: {
    projectId: string;
    worktreeId: string;
    target: HookDescriptor['target'];
    repoId?: string;
  },
  readSnapshot: typeof readCurrentPrTrackingSnapshot = readCurrentPrTrackingSnapshot,
): Promise<Pick<PortalHookSummary, 'runDisabled' | 'runDisabledReason'>> {
  const repoStorageKey =
    input.target === 'project'
      ? getProjectRepoStorageKey()
      : input.target === 'workspace-root'
        ? getWorkspaceRootRepoStorageKey()
        : input.repoId
          ? getWorkspaceRepoStorageKey(input.repoId)
          : null;
  const hasActivePr =
    repoStorageKey !== null &&
    (
      await readSnapshot({
        projectId: input.projectId,
        worktreeId: input.worktreeId,
        repoStorageKey,
      }).catch(() => ({ snapshot: null }))
    ).snapshot !== null;

  // Keep this predicate aligned with hasActivePrForHookEntry and the
  // runDisabledTitle mapping in renderer activity/HooksSection.tsx.
  return hasActivePr
    ? {}
    : {
        runDisabled: true,
        runDisabledReason: MANUAL_RUN_REQUIRES_ACTIVE_PR,
      };
}

export async function runHookCommand(
  request: HookRunRequest,
  options: {
    portalCommandId?: string;
    onRunUpdate?: (run: PortalHookRun) => void;
    getWindow?: RunHookOptions['getWindow'];
    onEnqueued?: RunHookOptions['onEnqueued'];
    onStarted?: RunHookOptions['onStarted'];
    onOutput?: RunHookOptions['onOutput'];
    onComplete?: RunHookOptions['onComplete'];
  } = {},
): Promise<HookRunResponse> {
  const hookWorkspaceId =
    request.target === 'project' ? request.projectId : request.workspaceId;
  assertNotSplitLocked(hookWorkspaceId, request.worktreeId, 'running a hook');
  const prefs = await readPreferencesFile();
  if (request.target === 'project') {
    validateId(request.projectId, 'projectId');
    validateId(request.worktreeId, 'worktreeId');
    const config = await readWorkspaceConfig(request.projectId);
    const cwd = getWorktreeDir(request.projectId, request.worktreeId);
    const resolvedHooks = await resolveProjectHooks(
      {
        id: request.projectId,
        owner: config.owner,
        repoPath: config.repoPath ?? cwd,
        hooks: config.hooks,
      },
      cwd,
    );
    const actions = getResolvedHookActions(resolvedHooks, request.triggerName);
    if (!Array.isArray(actions) || actions.length === 0) return NOOP_SUCCESS;
    const snapshotRef = await readCurrentPrTrackingSnapshot({
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      repoStorageKey: getProjectRepoStorageKey(),
    });
    if (!snapshotRef.snapshot) {
      throw new PortalServiceError(
        'execution_failed',
        'No current PR snapshot exists for this worktree.',
      );
    }
    return runResolvedHook({
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      hook: createProjectHookDescriptor(request.triggerName, actions),
      cwd,
      timeoutSeconds: prefs.scriptTimeoutMinutes * 60,
      snapshotRef,
      portalCommandId: options.portalCommandId,
      onRunUpdate: options.onRunUpdate,
      getWindow: options.getWindow,
      onEnqueued: options.onEnqueued,
      onStarted: options.onStarted,
      onOutput: options.onOutput,
      onComplete: options.onComplete,
    });
  }

  validateId(request.workspaceId, 'workspaceId');
  validateId(request.worktreeId, 'worktreeId');
  if (request.target === 'workspace-root') {
    const cwd = getWorkspaceWorktreeRootRepoDir(
      request.workspaceId,
      request.worktreeId,
    );
    const resolvedHooks = await resolveWorkspaceRootHooks(request.workspaceId, {
      workspaceRootPath: cwd,
    });
    const actions = getResolvedHookActions(resolvedHooks, request.triggerName);
    if (!Array.isArray(actions) || actions.length === 0) return NOOP_SUCCESS;
    const snapshotRef = await readCurrentPrTrackingSnapshot({
      projectId: request.workspaceId,
      worktreeId: request.worktreeId,
      repoStorageKey: getWorkspaceRootRepoStorageKey(),
    });
    if (!snapshotRef.snapshot) {
      throw new PortalServiceError(
        'execution_failed',
        'No current PR snapshot exists for this repo target.',
      );
    }
    return runResolvedHook({
      projectId: request.workspaceId,
      worktreeId: request.worktreeId,
      hook: createWorkspaceRootHookDescriptor(request.triggerName, actions),
      cwd,
      timeoutSeconds: prefs.scriptTimeoutMinutes * 60,
      snapshotRef,
      portalCommandId: options.portalCommandId,
      onRunUpdate: options.onRunUpdate,
      getWindow: options.getWindow,
      onEnqueued: options.onEnqueued,
      onStarted: options.onStarted,
      onOutput: options.onOutput,
      onComplete: options.onComplete,
    });
  }

  validateId(request.repoId, 'repoId');
  const config = await readWorkspaceConfig(request.workspaceId);
  const repo = config.repos.find(
    (candidate) => candidate.id === request.repoId,
  );
  if (!repo) {
    throw new PortalServiceError('not_found', 'Repo not found.');
  }
  const workspaceRootPath = getWorkspaceWorktreeRootRepoDir(
    request.workspaceId,
    request.worktreeId,
  );
  const cwd = getWorkspaceWorktreeRepoDir(
    request.workspaceId,
    request.worktreeId,
    request.repoId,
  );
  const resolvedHooks = await resolveWorkspaceRepoHooks(
    request.workspaceId,
    request.repoId,
    { workspaceRootPath, repoPath: cwd },
  );
  const actions = getResolvedHookActions(resolvedHooks, request.triggerName);
  if (!Array.isArray(actions) || actions.length === 0) return NOOP_SUCCESS;
  const snapshotRef = await readCurrentPrTrackingSnapshot({
    projectId: request.workspaceId,
    worktreeId: request.worktreeId,
    repoStorageKey: getWorkspaceRepoStorageKey(request.repoId),
  });
  if (!snapshotRef.snapshot) {
    throw new PortalServiceError(
      'execution_failed',
      'No current PR snapshot exists for this repo target.',
    );
  }
  return runResolvedHook({
    projectId: request.workspaceId,
    worktreeId: request.worktreeId,
    hook: createWorkspaceRepoHookDescriptor(
      repo.id,
      repo.name,
      request.triggerName,
      actions,
    ),
    cwd,
    timeoutSeconds: prefs.scriptTimeoutMinutes * 60,
    snapshotRef,
    portalCommandId: options.portalCommandId,
    onRunUpdate: options.onRunUpdate,
    getWindow: options.getWindow,
    onEnqueued: options.onEnqueued,
    onStarted: options.onStarted,
    onOutput: options.onOutput,
    onComplete: options.onComplete,
  });
}

function runResolvedHook(args: {
  projectId: string;
  worktreeId: string;
  hook: HookDescriptor;
  cwd: string;
  timeoutSeconds: number | null;
  snapshotRef: Awaited<ReturnType<typeof readCurrentPrTrackingSnapshot>>;
  portalCommandId?: string;
  onRunUpdate?: (run: PortalHookRun) => void;
  getWindow?: RunHookOptions['getWindow'];
  onEnqueued?: RunHookOptions['onEnqueued'];
  onStarted?: RunHookOptions['onStarted'];
  onOutput?: RunHookOptions['onOutput'];
  onComplete?: RunHookOptions['onComplete'];
}): Promise<HookRunResponse> {
  if (!args.snapshotRef.snapshot) return Promise.resolve(NOOP_SUCCESS);
  const emit = async (
    ref: HookRunLogRef,
    status: PortalHookRun['status'],
    finishedAt?: string,
    activeActionIndex?: number,
  ): Promise<void> => {
    const { lines } = await readHookRunLogTail({
      projectId: args.projectId,
      worktreeId: args.worktreeId,
      runId: ref.runId,
      maxLines: 80,
    }).catch(() => ({ lines: [] }));
    const run = buildPortalHookRun({
      projectId: args.projectId,
      worktreeId: args.worktreeId,
      hook: args.hook,
      runId: ref.runId,
      status,
      outputTail: trimUtf8Tail(lines.join('\n'), RUN_TAIL_MAX_BYTES),
      finishedAt,
      activeActionIndex,
    });
    args.onRunUpdate?.(run);
    emitHookRun(run, args.portalCommandId);
  };
  return runHook({
    projectId: args.projectId,
    worktreeId: args.worktreeId,
    hook: args.hook,
    cwd: args.cwd,
    invocation: 'manual',
    timeoutSeconds: args.timeoutSeconds,
    currentSnapshot: args.snapshotRef.snapshot,
    currentSnapshotPath: args.snapshotRef.currentSnapshotPath,
    previousSnapshotPath: args.snapshotRef.previousSnapshotPath,
    getWindow: args.getWindow ?? ((): null => null),
    onEnqueued: args.onEnqueued,
    onStarted: (hook, ref) => {
      args.onStarted?.(hook, ref);
      trackDetachedWork(() => emit(ref, 'running'));
    },
    onOutput: (hook, lines, ref, activeActionIndex) => {
      args.onOutput?.(hook, lines, ref, activeActionIndex);
      if (ref)
        trackDetachedWork(() =>
          emit(ref, 'running', undefined, activeActionIndex),
        );
    },
    onComplete: (hook, result, ref) => {
      args.onComplete?.(hook, result, ref);
      trackDetachedWork(() =>
        emit(
          ref,
          result.timedOut
            ? 'timed_out'
            : result.stopped
              ? 'cancelled'
              : result.success
                ? 'success'
                : 'failed',
          new Date().toISOString(),
        ),
      );
    },
  });
}

export async function cancelHook(
  request: HookStopRequest,
  options: { portalCommandId?: string } = {},
): Promise<HookRunResponse | null> {
  validateId(request.projectId, 'projectId');
  validateId(request.worktreeId, 'worktreeId');
  const result = await stopRunningHook({
    projectId: request.projectId,
    worktreeId: request.worktreeId,
    hookKey: request.hookKey,
  });
  if (result) {
    const tail = await readLatestHookRunTail({
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      hookKey: request.hookKey,
    }).catch(() => null);
    if (tail?.run) {
      emitHookRun(
        { ...tail.run, status: 'cancelled' },
        options.portalCommandId,
      );
    }
  }
  return result;
}

export async function readLatestHookRunTail(request: {
  projectId: string;
  worktreeId: string;
  hookKey: string;
  maxLines?: number;
}): Promise<{ lines: string[]; run?: PortalHookRun }> {
  validateId(request.projectId, 'projectId');
  validateId(request.worktreeId, 'worktreeId');
  const runs = await listHookRuns({
    projectId: request.projectId,
    worktreeId: request.worktreeId,
  });
  const latest = runs
    .filter((run) => run.hookId === request.hookKey)
    .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))[0];
  if (!latest?.runId) return { lines: [] };
  return readHookRunTail({
    projectId: request.projectId,
    worktreeId: request.worktreeId,
    runId: latest.runId,
    maxLines: request.maxLines,
  });
}

export async function readHookRunTail(request: {
  projectId: string;
  worktreeId: string;
  runId: string;
  maxLines?: number;
}): Promise<{ lines: string[]; run?: PortalHookRun }> {
  validateId(request.projectId, 'projectId');
  validateId(request.worktreeId, 'worktreeId');
  validateId(request.runId, 'runId');
  const { meta, lines } = await readHookRunLogTail({
    projectId: request.projectId,
    worktreeId: request.worktreeId,
    runId: request.runId,
    maxLines: request.maxLines ?? 500,
  });
  if (!meta) return { lines };
  return {
    lines,
    run: buildPortalHookRun({
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      hook: meta.hook,
      runId: meta.runId,
      status: meta.timedOut ? 'timed_out' : meta.status,
      outputTail: trimUtf8Tail(lines.join('\n'), RUN_TAIL_MAX_BYTES),
      finishedAt: meta.completedAt,
      startedAt: meta.startedAt,
    }),
  };
}

export async function loadWorktreeHookRuns(request: {
  projectId: string;
  worktreeId: string;
  maxLines?: number;
}): Promise<HookRunSnapshot[]> {
  validateId(request.projectId, 'projectId');
  validateId(request.worktreeId, 'worktreeId');
  const runs = await listLatestHookRunLogTails({
    projectId: request.projectId,
    worktreeId: request.worktreeId,
    maxLines: request.maxLines ?? 1000,
  });

  const latestByHookKey = new Map<string, HookRunSnapshot>();
  for (const { meta, lines } of runs) {
    const snapshot: HookRunSnapshot = {
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      hook: meta.hook,
      status: meta.status,
      outputLines: lines,
      exitCode: meta.exitCode,
      timedOut: meta.timedOut,
      durationMs: meta.durationMs,
      startedAt: meta.startedAt,
      activeActionIndex: meta.activeActionIndex,
      ...(meta.completedAt ? { completedAt: meta.completedAt } : {}),
    };
    const existing = latestByHookKey.get(meta.hook.hookKey);
    if (!existing || snapshot.startedAt > existing.startedAt) {
      latestByHookKey.set(meta.hook.hookKey, snapshot);
    }
  }

  return Array.from(latestByHookKey.values()).sort((left, right) =>
    left.startedAt.localeCompare(right.startedAt),
  );
}

function buildPortalHookRun(input: {
  projectId: string;
  worktreeId: string;
  hook: HookDescriptor;
  runId: string;
  status: PortalHookRun['status'];
  outputTail: string;
  startedAt?: string;
  finishedAt?: string;
  activeActionIndex?: number;
}): PortalHookRun {
  return {
    workspaceLocalId: input.projectId,
    worktreeLocalId: input.worktreeId,
    localId: input.runId,
    runId: input.runId,
    hookId: input.hook.hookKey,
    // Transport plan §1.3: hookKey is canonical; hookId is a legacy alias
    // that MUST equal hookKey while the rollout is in flight.
    hookKey: input.hook.hookKey,
    name: input.hook.label,
    triggerName: input.hook.triggerName,
    target: input.hook.target,
    repoId: input.hook.repoId,
    repoName: input.hook.repoName,
    status: input.status,
    startedAt: input.startedAt ?? new Date().toISOString(),
    finishedAt: input.finishedAt,
    outputTail: input.outputTail,
    activeActionIndex: input.activeActionIndex,
  };
}

function emitHookRun(run: PortalHookRun, commandId?: string): void {
  emitPortalFeatureUpsert({
    type: 'portal.hook.event',
    commandId,
    entity: {
      entityType: 'hook_run',
      localId: run.localId,
      parentLocalId: worktreeScopedParentLocalId(
        run.workspaceLocalId,
        run.worktreeLocalId,
      ),
      payload: run,
    },
  });
}

function trimUtf8Tail(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength <= maxBytes) return value;
  let start = bytes.byteLength - maxBytes;
  while (start < bytes.byteLength && (bytes[start] & 0xc0) === 0x80) {
    start += 1;
  }
  return bytes.subarray(start).toString('utf8');
}

export async function listHooks(input?: {
  workspaceLocalId?: string;
  worktreeLocalId?: string;
  workspaceId?: string;
  projectId?: string;
  worktreeId?: string;
}): Promise<PortalHookSummary[]> {
  const workspaceLocalId =
    input?.workspaceLocalId ?? input?.workspaceId ?? input?.projectId;
  const worktreeLocalId = input?.worktreeLocalId ?? input?.worktreeId;
  if (!workspaceLocalId || !worktreeLocalId) return [];
  const { items } = await readAllSidebarItems();
  const item = items.find((candidate) => candidate.id === workspaceLocalId);
  if (!item) return [];
  if (item.type === 'cowork') return [];
  const worktree = item.worktrees.find(
    (candidate) => candidate.id === worktreeLocalId,
  );
  const pausedHookKeys = new Set(worktree?.pausedHookKeys ?? []);
  if (item.type === 'single-repo') {
    const config = await readWorkspaceConfig(workspaceLocalId).catch(
      () => null,
    );
    const cwd = getWorktreeDir(workspaceLocalId, worktreeLocalId);
    const hooks = await resolveProjectHooks(
      {
        id: workspaceLocalId,
        owner: config?.owner,
        repoPath: config?.repoPath ?? cwd,
        hooks: config?.hooks,
      },
      cwd,
    ).catch(() => ({}));
    const rows = Object.entries(hooks).flatMap(([triggerName, field]) => {
      const actions = field.actions;
      if (!actions || actions.length === 0) return [];
      const descriptor = createProjectHookDescriptor(triggerName, actions);
      return [
        {
          workspaceLocalId,
          worktreeLocalId,
          hookId: descriptor.hookKey,
          // Transport plan §1.3 canonical fields.
          hookKey: descriptor.hookKey,
          name: descriptor.label,
          triggerName,
          target: descriptor.target,
          repoId: descriptor.repoId,
          repoName: descriptor.repoName,
          source: 'project',
          paused: pausedHookKeys.has(descriptor.hookKey),
        },
      ];
    });
    return settleAll(
      rows.map(async (row) => ({
        ...row,
        ...(await portalHookRunAvailability({
          projectId: workspaceLocalId,
          worktreeId: worktreeLocalId,
          target: row.target,
          repoId: row.repoId,
        })),
      })),
    );
  }
  const rootPath = getWorkspaceWorktreeRootRepoDir(
    workspaceLocalId,
    worktreeLocalId,
  );
  const rootHooks = await resolveWorkspaceRootHooks(workspaceLocalId, {
    workspaceRootPath: rootPath,
  }).catch(() => ({}));
  const rootRows = Object.entries(rootHooks).flatMap(([triggerName, field]) => {
    const actions = field.actions;
    if (!actions || actions.length === 0) return [];
    const descriptor = createWorkspaceRootHookDescriptor(triggerName, actions);
    return [
      {
        workspaceLocalId,
        worktreeLocalId,
        hookId: descriptor.hookKey,
        // Transport plan §1.3 canonical fields.
        hookKey: descriptor.hookKey,
        name: descriptor.label,
        triggerName,
        target: descriptor.target,
        repoId: descriptor.repoId,
        repoName: descriptor.repoName,
        source: 'workspace-root',
        paused: pausedHookKeys.has(descriptor.hookKey),
      },
    ];
  });
  const repoRows = await settleAll(
    item.repos.map(async (repo) => {
      const repoPath = getWorkspaceWorktreeRepoDir(
        workspaceLocalId,
        worktreeLocalId,
        repo.id,
      );
      const hooks = await resolveWorkspaceRepoHooks(workspaceLocalId, repo.id, {
        workspaceRootPath: rootPath,
        repoPath,
      }).catch(() => ({}));
      return Object.entries(hooks).flatMap(([triggerName, field]) => {
        const actions = field.actions;
        if (!actions || actions.length === 0) return [];
        const descriptor = createWorkspaceRepoHookDescriptor(
          repo.id,
          repo.name,
          triggerName,
          actions,
        );
        return [
          {
            workspaceLocalId,
            worktreeLocalId,
            hookId: descriptor.hookKey,
            // Transport plan §1.3 canonical fields.
            hookKey: descriptor.hookKey,
            name: descriptor.label,
            triggerName,
            target: descriptor.target,
            repoId: descriptor.repoId,
            repoName: descriptor.repoName,
            source: repo.name,
            paused: pausedHookKeys.has(descriptor.hookKey),
          },
        ];
      });
    }),
  );
  const rows = [...rootRows, ...repoRows.flat()];
  return settleAll(
    rows.map(async (row) => ({
      ...row,
      ...(await portalHookRunAvailability({
        projectId: workspaceLocalId,
        worktreeId: worktreeLocalId,
        target: row.target,
        repoId: row.repoId,
      })),
    })),
  );
}

export async function listHookRuns(input?: {
  workspaceLocalId?: string;
  worktreeLocalId?: string;
  workspaceId?: string;
  projectId?: string;
  worktreeId?: string;
}): Promise<PortalHookRun[]> {
  const workspaceLocalId =
    input?.workspaceLocalId ?? input?.workspaceId ?? input?.projectId;
  const worktreeLocalId = input?.worktreeLocalId ?? input?.worktreeId;
  if (!workspaceLocalId || !worktreeLocalId) return [];
  const dir = getHookInvocationsDir(workspaceLocalId, worktreeLocalId);
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const runs = await settleAll(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry): Promise<PortalHookRun | null> => {
        const runDir = join(dir, entry.name);
        const meta = await readHookRunMeta(join(runDir, 'meta.json'));
        if (!meta) return null;
        const outputTail = await readFile(join(runDir, 'output.log'), 'utf8')
          .then((raw) => raw.split(/\r?\n/).slice(-80).join('\n'))
          .catch(() => '');
        return {
          workspaceLocalId,
          worktreeLocalId,
          localId: meta.runId,
          runId: meta.runId,
          hookId: meta.hook.hookKey,
          // Transport plan §1.3 canonical fields.
          hookKey: meta.hook.hookKey,
          name: meta.hook.label,
          triggerName: meta.hook.triggerName,
          target: meta.hook.target,
          repoId: meta.hook.repoId,
          repoName: meta.hook.repoName,
          status: meta.timedOut ? 'timed_out' : meta.status,
          startedAt: meta.startedAt,
          finishedAt: meta.completedAt,
          outputTail,
        };
      }),
  );
  return runs.flatMap((run) => (run ? [run] : []));
}

async function readHookRunMeta(pathValue: string): Promise<{
  runId: string;
  hook: HookDescriptor;
  status: 'running' | 'success' | 'failed' | 'cancelled';
  startedAt: string;
  completedAt?: string;
  timedOut: boolean;
} | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(pathValue, 'utf8'));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('runId' in parsed) ||
      !('hook' in parsed) ||
      !('status' in parsed)
    ) {
      return null;
    }
    const record = parsed as {
      runId?: unknown;
      hook?: unknown;
      status?: unknown;
      startedAt?: unknown;
      completedAt?: unknown;
      timedOut?: unknown;
    };
    const hook = record.hook as HookDescriptor;
    if (
      typeof record.runId !== 'string' ||
      typeof hook?.hookKey !== 'string' ||
      typeof hook.label !== 'string' ||
      typeof hook.triggerName !== 'string' ||
      (record.status !== 'running' &&
        record.status !== 'success' &&
        record.status !== 'failed' &&
        record.status !== 'cancelled') ||
      typeof record.startedAt !== 'string'
    ) {
      return null;
    }
    return {
      runId: record.runId,
      hook,
      status: record.status,
      startedAt: record.startedAt,
      ...(typeof record.completedAt === 'string'
        ? { completedAt: record.completedAt }
        : {}),
      timedOut: record.timedOut === true,
    };
  } catch {
    return null;
  }
}

export async function getHookSourceInfo(
  request: HookSourceInfoRequest,
): Promise<HookSourceInfoResponse> {
  if (request.target === 'project') {
    validateId(request.projectId, 'projectId');
    const config = await readWorkspaceConfig(request.projectId);
    const layers = await collectProjectHookLayers(
      {
        repoPath:
          config.repoPath ??
          (request.worktreeId
            ? getWorktreeDir(request.projectId, request.worktreeId)
            : ''),
        hooks: config.hooks,
      },
      request.triggerName,
      request.worktreeId
        ? getWorktreeDir(request.projectId, request.worktreeId)
        : undefined,
    );
    return hookSourceInfoResponse(request.triggerName, layers);
  }
  validateId(request.workspaceId, 'workspaceId');
  const layers =
    request.target === 'workspace-root'
      ? await collectWorkspaceRootHookLayers(
          request.workspaceId,
          request.triggerName,
          request.worktreeId
            ? {
                workspaceRootPath: getWorkspaceWorktreeRootRepoDir(
                  request.workspaceId,
                  request.worktreeId,
                ),
              }
            : undefined,
        )
      : await collectWorkspaceRepoHookLayers(
          request.workspaceId,
          request.repoId,
          request.triggerName,
          request.worktreeId
            ? {
                workspaceRootPath: getWorkspaceWorktreeRootRepoDir(
                  request.workspaceId,
                  request.worktreeId,
                ),
                repoPath: getWorkspaceWorktreeRepoDir(
                  request.workspaceId,
                  request.worktreeId,
                  request.repoId,
                ),
              }
            : undefined,
        );
  return hookSourceInfoResponse(request.triggerName, layers);
}

/**
 * `project:save-hooks`, `workspace:save-hooks` and
 * `workspace:save-repo-hooks`: compatibility adapters over the W5
 * `core.workspace.hooks.update` boundary (CAN-3816).
 */
export async function saveProjectHooksFromService(
  request: SaveProjectHooksRequest,
): Promise<void> {
  validateId(request.projectId, 'projectId');
  await updateWorkspaceHooks({
    workspaceId: request.projectId,
    change: { kind: 'replace', hooks: request.hooks },
    source: 'desktop',
  });
}

export async function saveWorkspaceHooksFromService(
  request: SaveWorkspaceHooksRequest,
): Promise<void> {
  validateId(request.workspaceId, 'workspaceId');
  await updateWorkspaceHooks({
    workspaceId: request.workspaceId,
    change: { kind: 'replace', hooks: request.hooks },
    source: 'desktop',
  });
}

export async function saveWorkspaceRepoHooksFromService(
  request: SaveWorkspaceRepoHooksRequest,
): Promise<void> {
  validateId(request.workspaceId, 'workspaceId');
  try {
    await updateWorkspaceHooks({
      workspaceId: request.workspaceId,
      change: { kind: 'repositories', repos: request.repos },
      source: 'desktop',
    });
  } catch (error) {
    if (
      error instanceof ScriptHookSettingsRefusedError &&
      error.reason === 'not-found'
    ) {
      throw new PortalServiceError('not_found', error.message);
    }
    throw error;
  }
}

function hookSourceInfoResponse(
  triggerName: HookSourceInfoRequest['triggerName'],
  layers: HookSourceInfoResponse['layers'],
): HookSourceInfoResponse {
  return {
    triggerName,
    triggerDisplayName: getHookTriggerDisplayName(triggerName),
    effectiveActions:
      layers.find(
        (layer) => layer.status === 'active' || layer.status === 'disabled',
      )?.actions ?? null,
    layers,
  };
}

export function hookToPortalEntity(
  hook: PortalHookSummary,
): PortalEntityEnvelope {
  return {
    entityType: 'hook_descriptor',
    localId: hook.hookId,
    parentLocalId: worktreeScopedParentLocalId(
      hook.workspaceLocalId,
      hook.worktreeLocalId,
    ),
    payload: hook,
  };
}
