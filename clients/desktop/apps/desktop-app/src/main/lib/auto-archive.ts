import { ORCHESTRATOR_LABEL } from '@canopy/protocol';
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  type AppAdvisorWatcherSummary,
  type AutoArchiveNotification,
  type AutomationAction,
  type ScheduledActivity,
  type SidebarItem,
  type WorktreeData,
} from '@canopy/desktop-shared/types';
import { resolveAutoArchiveDays } from '@canopy/desktop-shared/lib/archive-retention';
import {
  pipelineAutomationTaskId,
  pipelineAutomationWorkspaceId,
} from '@canopy/desktop-shared/lib/automation-pipeline-target';
import {
  listBackgroundWorkTargets,
  subscribeBackgroundWork,
  worktreeBlocksClose,
} from '../agents/background-work';
import {
  LiveDelegationsError,
  listDelegationActivity,
  parseDelegationSessionKey,
  subscribeDelegationActivity,
  worktreeHasLiveDelegations,
} from '../agents/delegation/activity';
import {
  getAllActiveSessionInfos,
  subscribeChatSessionActivity,
} from '../agents/session-manager';
import { getAppAdvisorWatcherService } from '../app-advisor/watchers';
import { getAutomationsService } from '../automations/service';
import {
  getActivePipelineExecutionHandles,
  subscribeToActiveCountChange,
} from '../pipelines/pipeline-execution-registry';
import { getWorktreeRuntimeStatuses } from '../services/worktree-runtime-status-service';
import {
  assertNotSplitDestinationWorktreeClaimed,
  assertNotSplitLocked,
  isSplitDestinationWorktreeClaimed,
  isSplitLocked,
} from '../services/split-lock-service';
import type { WorkerTerminalEventType } from '@canopy/core-runtime/node/terminal';
import { workerTerminal } from '../terminal/worker-terminal';
import { readAppAdvisorWorkspaceSettings } from './app-advisor-workspace';
import { listWorkEntryChatSummaries } from './cowork-work-entries';
import { readWorkEntriesFile } from './cowork-work-entries-file';
import { archiveWorkEntry } from './work-entry-archive';
import {
  cleanupLiveWorktreeState,
  purgeLiveWorktreeObservabilityData,
} from './worktree-live-cleanup';
import {
  archiveMultiRepoWorktree,
  archiveSingleRepoWorktree,
} from './worktree-service';
import { readAllSidebarItems } from './sidebar-items';
import { resolveCoworkWorkspaceId } from './cowork-migration-map';
import {
  listActiveHookRunTargets,
  subscribeActiveHookRunsChanged,
} from './hook-runner';
import {
  listTrackedShellScripts,
  subscribeTrackedScriptsChanged,
} from './script-runner';
import { touchWorkspaceTarget } from './workspace-activity';
import {
  WorkspaceTargetAutoArchiveExcludedError,
  withWorkspaceTargetAutoArchiveLease,
  withWorkspaceTargetAutoArchiveTeardown,
  isWorkspaceTargetAutoArchiveTeardown,
} from './workspace-target-exclusion';

const DAY_MS = 24 * 60 * 60 * 1_000;
const AUTO_ARCHIVE_SWEEP_INTERVAL_MS = 12 * 60 * 60 * 1_000;

type AutoArchiveSurface =
  | 'single-repo'
  | 'multi-repo'
  | 'cowork'
  | 'app-advisor';

export interface AutoArchiveCandidate {
  surface: AutoArchiveSurface;
  workspaceId: string;
  workspaceName: string;
  targetId: string;
  targetName: string;
  createdAt: string;
  lastTouchedAt?: string;
  inactivityDays: number;
  deleteBranch?: boolean;
  worktree?: WorktreeData;
}

export interface AutoArchiveResult {
  candidate: AutoArchiveCandidate;
  status: 'success' | 'failure';
  error?: string;
  warnings?: string[];
}

interface CurrentAutoArchivePolicy {
  deleteBranch?: boolean;
}

let autoArchiveResultListener:
  | ((notification: AutoArchiveNotification) => void)
  | null = null;

export function setAutoArchiveResultListener(
  listener: ((notification: AutoArchiveNotification) => void) | null,
): void {
  autoArchiveResultListener = listener;
}

export interface AutoArchiveDependencies {
  listSidebarItems: () => Promise<SidebarItem[]>;
  readWorkEntries: (
    workspaceId: string,
  ) => ReturnType<typeof readWorkEntriesFile>;
  listWorkEntryChatSummaries: (
    workspaceId: string,
  ) => ReturnType<typeof listWorkEntryChatSummaries>;
  readAppAdvisorSettings: () => ReturnType<
    typeof readAppAdvisorWorkspaceSettings
  >;
  listWatchers: () => Promise<AppAdvisorWatcherSummary[]>;
  listAutomations: () => ReturnType<
    ReturnType<typeof getAutomationsService>['list']
  >;
  archive: (
    candidate: AutoArchiveCandidate,
  ) => Promise<void | { warnings?: string[] }>;
  isRuntimeBusy: (candidate: AutoArchiveCandidate) => Promise<boolean>;
  touch: (workspaceId: string, targetId: string, now: number) => Promise<void>;
  onResult: (result: AutoArchiveResult) => void;
}

function targetKey(workspaceId: string, targetId: string): string {
  return `${workspaceId}\0${targetId}`;
}

function isValidTimestamp(value: string | undefined): boolean {
  return value !== undefined && Number.isFinite(Date.parse(value));
}

function workEntryDisplayName(entry: {
  id: string;
  title?: string;
  summary?: { title: string };
}): string {
  return entry.title?.trim() || entry.summary?.title || entry.id;
}

export async function collectAutoArchiveCandidates(
  deps: Pick<
    AutoArchiveDependencies,
    'listSidebarItems' | 'readWorkEntries' | 'readAppAdvisorSettings'
  >,
): Promise<AutoArchiveCandidate[]> {
  const candidates: AutoArchiveCandidate[] = [];
  const items = await deps.listSidebarItems();
  for (const item of items) {
    if (item.type === 'cowork') {
      const inactivityDays = resolveAutoArchiveDays(
        'cowork',
        item.archiveRetentionDays,
        item.autoArchiveDays,
      );
      if (inactivityDays === null) continue;
      const entries = await deps.readWorkEntries(item.id);
      for (const entry of entries.entries) {
        candidates.push({
          surface: 'cowork',
          workspaceId: item.id,
          workspaceName: item.name,
          targetId: entry.id,
          targetName: workEntryDisplayName(entry),
          createdAt: entry.createdAt,
          ...(entry.lastTouchedAt
            ? { lastTouchedAt: entry.lastTouchedAt }
            : {}),
          inactivityDays,
        });
      }
      continue;
    }

    const inactivityDays = resolveAutoArchiveDays(
      item.type,
      item.archiveRetentionDays,
      item.autoArchiveDays,
    );
    if (inactivityDays === null) continue;
    for (const worktree of item.worktrees) {
      candidates.push({
        surface: item.type,
        workspaceId: item.id,
        workspaceName: item.name,
        targetId: worktree.id,
        targetName: worktree.label?.trim() || worktree.branchName,
        createdAt: worktree.createdAt,
        ...(worktree.lastTouchedAt
          ? { lastTouchedAt: worktree.lastTouchedAt }
          : {}),
        inactivityDays,
        deleteBranch: item.autoArchiveDeleteBranch === true,
        worktree,
      });
    }
  }

  const appAdvisorSettings = await deps.readAppAdvisorSettings();
  const appAdvisorDays = resolveAutoArchiveDays(
    'app-advisor',
    appAdvisorSettings.archiveRetentionDays,
    appAdvisorSettings.autoArchiveDays,
  );
  if (appAdvisorDays !== null) {
    const entries = await deps.readWorkEntries(APP_ADVISOR_PROJECT_ID);
    for (const entry of entries.entries) {
      if (entry.id === APP_ADVISOR_WORKTREE_ID) continue;
      candidates.push({
        surface: 'app-advisor',
        workspaceId: APP_ADVISOR_PROJECT_ID,
        workspaceName: ORCHESTRATOR_LABEL,
        targetId: entry.id,
        targetName: workEntryDisplayName(entry),
        createdAt: entry.createdAt,
        ...(entry.lastTouchedAt ? { lastTouchedAt: entry.lastTouchedAt } : {}),
        inactivityDays: appAdvisorDays,
      });
    }
  }
  return candidates;
}

export async function resolveCurrentAutoArchivePolicy(
  candidate: AutoArchiveCandidate,
  evaluatedAt: number,
  deps: Pick<
    AutoArchiveDependencies,
    'listSidebarItems' | 'readAppAdvisorSettings'
  >,
): Promise<CurrentAutoArchivePolicy> {
  let inactivityDays: number | null = null;
  let deleteBranch: boolean | undefined;
  if (candidate.surface === 'app-advisor') {
    const settings = await deps.readAppAdvisorSettings();
    inactivityDays = resolveAutoArchiveDays(
      'app-advisor',
      settings.archiveRetentionDays,
      settings.autoArchiveDays,
    );
  } else {
    const item = (await deps.listSidebarItems()).find(
      (entry) =>
        entry.id === candidate.workspaceId && entry.type === candidate.surface,
    );
    if (item) {
      inactivityDays = resolveAutoArchiveDays(
        item.type,
        item.archiveRetentionDays,
        item.autoArchiveDays,
      );
      if (item.type === 'single-repo' || item.type === 'multi-repo') {
        deleteBranch = item.autoArchiveDeleteBranch === true;
      }
    }
  }
  const activityAt = candidate.lastTouchedAt ?? candidate.createdAt;
  if (
    inactivityDays === null ||
    !isValidTimestamp(activityAt) ||
    Date.parse(activityAt) > evaluatedAt - inactivityDays * DAY_MS
  ) {
    throw new WorkspaceTargetAutoArchiveExcludedError(
      'Auto Delete policy changed before deletion',
    );
  }
  return deleteBranch === undefined ? {} : { deleteBranch };
}

function addAutomationTarget(
  keys: Set<string>,
  action: AutomationAction,
): void {
  if (action.type === 'worktree_session_prompt') {
    keys.add(targetKey(action.workspaceId, action.worktreeId));
  } else if (action.type === 'worktree_prompt' && action.existingWorktreeId) {
    keys.add(targetKey(action.workspaceId, action.existingWorktreeId));
  } else if (action.type === 'worktree_prompt' && action.baseWorktreeId) {
    keys.add(targetKey(action.workspaceId, action.baseWorktreeId));
  } else if (action.type === 'worktree_pipeline') {
    const workspaceId = pipelineAutomationWorkspaceId(action);
    const worktreeId =
      pipelineAutomationTaskId(action) ?? action.baseWorktreeId;
    if (workspaceId && worktreeId) keys.add(targetKey(workspaceId, worktreeId));
  } else if (action.type === 'standalone_prompt' && action.workEntryId) {
    keys.add(
      targetKey(
        resolveCoworkWorkspaceId(action.chatProjectId),
        action.workEntryId,
      ),
    );
  } else if (action.type === 'app_advisor_prompt' && action.workEntryId) {
    keys.add(targetKey(APP_ADVISOR_PROJECT_ID, action.workEntryId));
  } else if (
    action.type === 'pipeline_execution_resume' &&
    action.projectId &&
    action.worktreeId
  ) {
    keys.add(targetKey(action.projectId, action.worktreeId));
  }
}

export function collectScheduledAutomationTargetKeys(
  activities: ScheduledActivity[],
  runningActivityIds: ReadonlySet<string>,
): Set<string> {
  const keys = new Set<string>();
  for (const activity of activities) {
    if (!activity.enabled && !runningActivityIds.has(activity.id)) continue;
    addAutomationTarget(keys, activity.action);
  }
  return keys;
}

export function collectWatcherTargetKeys(
  watchers: AppAdvisorWatcherSummary[],
  chatOwners: ReadonlyMap<string, string>,
): Set<string> {
  const keys = new Set<string>();
  for (const watcher of watchers) {
    if (watcher.status !== 'active' && watcher.status !== 'firing') continue;
    const destinationOwner = chatOwners.get(
      `${watcher.destination.projectId}\0${watcher.destination.chatId}`,
    );
    keys.add(
      targetKey(
        watcher.destination.projectId,
        destinationOwner ?? watcher.destination.worktreeId,
      ),
    );
    const target = watcher.target;
    if (
      target.kind === 'worktree_chat' ||
      target.kind === 'worktree_chat_scope' ||
      target.kind === 'worktree_pipeline' ||
      target.kind === 'worktree_hook'
    ) {
      keys.add(targetKey(target.projectId, target.worktreeId));
    } else if (target.kind === 'standalone_chat') {
      const owner = chatOwners.get(`${target.projectId}\0${target.chatId}`);
      if (owner) keys.add(targetKey(target.projectId, owner));
    }
  }
  return keys;
}

/** Live runtime work that keeps a due target from Auto Delete. */
export async function isAutoArchiveRuntimeBusy(
  candidate: AutoArchiveCandidate,
): Promise<boolean> {
  // Queued, starting or running delegates keep their root chat's target.
  if (
    worktreeHasLiveDelegations(candidate.workspaceId, candidate.targetId) ||
    worktreeBlocksClose(candidate.workspaceId, candidate.targetId)
  )
    return true;
  const activeSession = getAllActiveSessionInfos().some(
    (session) =>
      session.projectId === candidate.workspaceId &&
      session.worktreeId === candidate.targetId &&
      (session.turnActive ||
        session.pendingMessageCount > 0 ||
        (session.activeBackgroundTaskCount ?? 0) > 0),
  );
  if (activeSession) return true;
  const worktree =
    candidate.worktree ??
    ({
      id: candidate.targetId,
      branchName: candidate.targetName,
      createdAt: candidate.createdAt,
    } satisfies WorktreeData);
  const statuses = await getWorktreeRuntimeStatuses([
    { workspaceId: candidate.workspaceId, worktree },
  ]);
  const status = statuses.get(
    targetKey(candidate.workspaceId, candidate.targetId),
  );
  return Boolean(
    status?.isStreaming ||
    status?.pipelineStatus ||
    status?.terminalStatus ||
    status?.scriptStatus ||
    status?.hookStatus ||
    status?.isRunningRun,
  );
}

async function defaultArchive(
  candidate: AutoArchiveCandidate,
): Promise<{ warnings?: string[] }> {
  const revalidateAutoArchivePolicy = (): Promise<CurrentAutoArchivePolicy> =>
    resolveCurrentAutoArchivePolicy(candidate, Date.now(), {
      listSidebarItems: defaultDependencies.listSidebarItems,
      readAppAdvisorSettings: defaultDependencies.readAppAdvisorSettings,
    });
  if (candidate.surface === 'cowork' || candidate.surface === 'app-advisor') {
    return archiveWorkEntry({
      workspaceId: candidate.workspaceId,
      entryId: candidate.targetId,
      requireArchivedContainer: true,
      expectedLastTouchedAt: candidate.lastTouchedAt,
      revalidateAutoArchivePolicy,
    });
  }
  assertNotSplitLocked(
    candidate.workspaceId,
    candidate.targetId,
    'automatically deleting the worktree',
  );
  assertNotSplitDestinationWorktreeClaimed(
    candidate.workspaceId,
    candidate.targetId,
    'automatically deleting the worktree',
  );
  const archive =
    candidate.surface === 'single-repo'
      ? archiveSingleRepoWorktree
      : archiveMultiRepoWorktree;
  return archive({
    sourceAdmission: 'required',
    workspaceId: candidate.workspaceId,
    worktreeId: candidate.targetId,
    expectedCreatedAt: candidate.createdAt,
    expectedLastTouchedAt: candidate.lastTouchedAt,
    ...(candidate.worktree?.branchName
      ? { expectedBranchName: candidate.worktree.branchName }
      : {}),
    deleteBranch: candidate.deleteBranch === true,
    revalidateAutoArchivePolicy,
    runAutoArchiveTeardown: () =>
      withWorkspaceTargetAutoArchiveTeardown(
        candidate.workspaceId,
        candidate.targetId,
        async () => {
          const { runAutoArchiveTeardown } =
            await import('./auto-archive-teardown');
          await runAutoArchiveTeardown(
            candidate.workspaceId,
            candidate.targetId,
            candidate.surface === 'multi-repo',
          );
        },
      ),
    requireArchivedContainer: true,
    observabilityMode: 'live-service',
    liveServices: {
      cleanupLiveState: cleanupLiveWorktreeState,
      purgeObservabilityData: purgeLiveWorktreeObservabilityData,
    },
  });
}

const defaultDependencies: AutoArchiveDependencies = {
  listSidebarItems: async () => (await readAllSidebarItems()).items,
  readWorkEntries: readWorkEntriesFile,
  listWorkEntryChatSummaries,
  readAppAdvisorSettings: readAppAdvisorWorkspaceSettings,
  listWatchers: () => getAppAdvisorWatcherService().list(),
  listAutomations: () => getAutomationsService().list(),
  archive: defaultArchive,
  isRuntimeBusy: isAutoArchiveRuntimeBusy,
  touch: (workspaceId, targetId, now) =>
    touchWorkspaceTarget(workspaceId, targetId, now),
  onResult: (result) => {
    autoArchiveResultListener?.({
      workspaceId: result.candidate.workspaceId,
      workspaceName: result.candidate.workspaceName,
      targetId: result.candidate.targetId,
      targetName: result.candidate.targetName,
      surface: result.candidate.surface,
      inactivityDays: result.candidate.inactivityDays,
      status: result.status,
      ...(result.error ? { error: result.error } : {}),
      ...(result.warnings?.length ? { warnings: result.warnings } : {}),
    });
    if (result.status === 'failure') {
      // eslint-disable-next-line no-console
      console.warn('Auto Delete failed.', {
        workspaceId: result.candidate.workspaceId,
        targetId: result.candidate.targetId,
        error: result.error,
      });
    }
  },
};

export async function applyAutoArchive(
  now = Date.now(),
  deps: AutoArchiveDependencies = defaultDependencies,
): Promise<AutoArchiveResult[]> {
  const candidates = await collectAutoArchiveCandidates(deps);
  const due = candidates.filter((candidate) => {
    const activityAt = candidate.lastTouchedAt ?? candidate.createdAt;
    return (
      isValidTimestamp(activityAt) &&
      Date.parse(activityAt) <= now - candidate.inactivityDays * DAY_MS
    );
  });
  if (due.length === 0) return [];

  // Work Entry summaries map chat ids to their owning entry. Candidate
  // collection intentionally stays small; hydrate this map from registry rows.
  const chatOwners = new Map<string, string>();
  const ownerErrors = new Map<string, unknown>();
  for (const workspaceId of Array.from(
    new Set(
      due
        .filter((candidate) => candidate.worktree === undefined)
        .map((candidate) => candidate.workspaceId),
    ),
  )) {
    try {
      const summaries = await deps.listWorkEntryChatSummaries(workspaceId);
      for (const summary of summaries) {
        for (const chat of summary.chats) {
          chatOwners.set(`${workspaceId}\0${chat.id}`, summary.entryId);
        }
      }
    } catch (error) {
      ownerErrors.set(workspaceId, error);
    }
  }
  const results: AutoArchiveResult[] = [];
  for (const candidate of due) {
    const refreshBusyTarget = async (): Promise<void> => {
      try {
        await deps.touch(candidate.workspaceId, candidate.targetId, now);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn('Failed to refresh busy Auto Delete target.', {
          workspaceId: candidate.workspaceId,
          targetId: candidate.targetId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    try {
      if (
        candidate.worktree === undefined &&
        ownerErrors.has(candidate.workspaceId)
      ) {
        throw ownerErrors.get(candidate.workspaceId);
      }
      let busy = false;
      let warnings: string[] | undefined;
      await withWorkspaceTargetAutoArchiveLease(
        candidate.workspaceId,
        candidate.targetId,
        async () => {
          const [watchers, automations] = await Promise.all([
            deps.listWatchers(),
            deps.listAutomations(),
          ]);
          const watcherTargets = collectWatcherTargetKeys(watchers, chatOwners);
          const runningActivityIds = new Set(
            automations.recentRuns
              .filter((run) => run.status === 'running')
              .map((run) => run.activityId),
          );
          const automationTargets = collectScheduledAutomationTargetKeys(
            automations.activities,
            runningActivityIds,
          );
          const key = targetKey(candidate.workspaceId, candidate.targetId);
          busy =
            watcherTargets.has(key) ||
            automationTargets.has(key) ||
            isSplitLocked(candidate.workspaceId, candidate.targetId) ||
            isSplitDestinationWorktreeClaimed(
              candidate.workspaceId,
              candidate.targetId,
            ) ||
            (await deps.isRuntimeBusy(candidate));
          if (!busy) warnings = (await deps.archive(candidate))?.warnings;
        },
      );
      if (busy) {
        await refreshBusyTarget();
        continue;
      }
      const result: AutoArchiveResult = {
        candidate,
        status: 'success',
        ...(warnings?.length ? { warnings } : {}),
      };
      results.push(result);
      deps.onResult(result);
    } catch (error) {
      if (
        error instanceof WorkspaceTargetAutoArchiveExcludedError ||
        error instanceof LiveDelegationsError
      ) {
        await refreshBusyTarget();
        continue;
      }
      const result: AutoArchiveResult = {
        candidate,
        status: 'failure',
        error: error instanceof Error ? error.message : String(error),
      };
      results.push(result);
      deps.onResult(result);
    }
  }
  return results;
}

export function shouldTouchAutoArchiveTargetsForTerminalEvent(
  type: WorkerTerminalEventType,
): boolean {
  return type !== 'output';
}

export function createActiveTargetActivityTracker(deps: {
  collectActiveTargetKeys: () => Set<string>;
  touch: (
    workspaceId: string,
    targetId: string,
    touchedAt: number,
  ) => Promise<void>;
  now: () => number;
}): () => void {
  let previousActiveTargetKeys = new Set<string>();
  return (): void => {
    const currentActiveTargetKeys = deps.collectActiveTargetKeys();
    const targetsToTouch = new Set(
      Array.from(previousActiveTargetKeys).concat(
        Array.from(currentActiveTargetKeys),
      ),
    );
    previousActiveTargetKeys = currentActiveTargetKeys;
    const touchedAt = deps.now();
    for (const key of Array.from(targetsToTouch)) {
      const separator = key.indexOf('\0');
      void deps
        .touch(key.slice(0, separator), key.slice(separator + 1), touchedAt)
        .catch(() => undefined);
    }
  };
}

export function collectActiveAutoArchiveTargetKeys(): Set<string> {
  const targets = new Set<string>();
  for (const session of getAllActiveSessionInfos()) {
    if (
      session.turnActive ||
      session.pendingMessageCount > 0 ||
      (session.activeBackgroundTaskCount ?? 0) > 0
    ) {
      targets.add(targetKey(session.projectId, session.worktreeId));
    }
  }
  for (const handle of getActivePipelineExecutionHandles()) {
    const state = handle.getState();
    if (state.project_id && state.worktree_id) {
      targets.add(targetKey(state.project_id, state.worktree_id));
    }
  }
  for (const target of workerTerminal.runningWorktrees()) {
    targets.add(targetKey(target.projectId, target.worktreeId));
  }
  for (const target of listTrackedShellScripts()) {
    targets.add(targetKey(target.projectId, target.worktreeId));
  }
  for (const target of listActiveHookRunTargets()) {
    targets.add(targetKey(target.projectId, target.worktreeId));
  }
  for (const entry of listDelegationActivity()) {
    const chat = parseDelegationSessionKey(entry.sessionKey);
    if (chat) targets.add(targetKey(chat.projectId, chat.worktreeId));
  }
  for (const target of listBackgroundWorkTargets()) {
    if (target.blocksClose) {
      targets.add(targetKey(target.projectId, target.worktreeId));
    }
  }
  return new Set(
    Array.from(targets).filter(
      (target) => !isWorkspaceTargetAutoArchiveTeardown(target),
    ),
  );
}

export async function touchActiveAutoArchiveTargets(
  now = Date.now(),
): Promise<void> {
  const touches: Promise<void>[] = [];
  for (const activeTargetKey of Array.from(
    collectActiveAutoArchiveTargetKeys(),
  )) {
    const separator = activeTargetKey.indexOf('\0');
    touches.push(
      touchWorkspaceTarget(
        activeTargetKey.slice(0, separator),
        activeTargetKey.slice(separator + 1),
        now,
      ).catch(() => undefined),
    );
  }
  await Promise.all(touches);
}

export function startDrainableAutoArchiveSweeps(params: {
  sweep: () => Promise<unknown>;
  intervalMs: number;
  onError: (error: unknown) => void;
}): () => Promise<void> {
  let stopped = false;
  let activeSweep: Promise<void> | null = null;
  const runSweep = (): void => {
    if (stopped || activeSweep) return;
    try {
      activeSweep = params
        .sweep()
        .then(() => undefined)
        .catch(params.onError)
        .finally(() => {
          activeSweep = null;
        });
    } catch (error) {
      params.onError(error);
    }
  };
  runSweep();
  const timer = setInterval(runSweep, params.intervalMs);
  timer.unref?.();
  return async (): Promise<void> => {
    stopped = true;
    clearInterval(timer);
    await activeSweep;
  };
}

export interface AutoArchiveSchedulerController {
  stopScheduling: () => Promise<void>;
  disposeActivitySubscriptions: () => void;
}

export function startAutoArchiveScheduler(): AutoArchiveSchedulerController {
  const touchActiveTargets = createActiveTargetActivityTracker({
    collectActiveTargetKeys: collectActiveAutoArchiveTargetKeys,
    touch: touchWorkspaceTarget,
    now: Date.now,
  });
  const unsubscribers = [
    subscribeChatSessionActivity(touchActiveTargets),
    subscribeToActiveCountChange(touchActiveTargets),
    workerTerminal.addEventListener((event) => {
      if (shouldTouchAutoArchiveTargetsForTerminalEvent(event.type)) {
        touchActiveTargets();
      }
    }),
    subscribeTrackedScriptsChanged(touchActiveTargets),
    subscribeActiveHookRunsChanged(touchActiveTargets),
    subscribeDelegationActivity(touchActiveTargets),
    subscribeBackgroundWork(touchActiveTargets),
  ];
  touchActiveTargets();
  const stopSweeps = startDrainableAutoArchiveSweeps({
    sweep: applyAutoArchive,
    intervalMs: AUTO_ARCHIVE_SWEEP_INTERVAL_MS,
    onError: (error: unknown): void => {
      // eslint-disable-next-line no-console
      console.warn('Failed to apply Auto Delete.', error);
    },
  });
  return {
    stopScheduling: stopSweeps,
    disposeActivitySubscriptions: (): void => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    },
  };
}
