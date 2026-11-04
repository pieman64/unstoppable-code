import { BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import type {
  CodeGraphGenerationQueueSnapshot,
  CodeGraphIpcError,
  CodeGraphRepositoryUiSummary,
  CodeGraphUiState,
  CodeGraphUiSummary,
  CodeGraphUiSummaryResponse,
  CodeGraphWorkspaceSummaryRequest,
  CodeGraphWorktreeSummaryRequest,
  SidebarItem,
} from '@canopy/desktop-shared/types';
import {
  IPC_CHANNELS,
  WORKSPACE_ROOT_REPO_ID,
} from '@canopy/desktop-shared/types';
import type { CodeGraphSummaryProjectionV1 } from '@canopy/code-graph/summary-projection';
import type {
  CodeGraphBuildState,
  CodeGraphReadFailure,
} from '@canopy/desktop-shared/types/code-graph-tools';

import { getWorktreeCodeGraphDbPath } from '@canopy/desktop-shared/node/code-graph/worktree-paths';
import {
  getCodeGraphSourceBuildState,
  isCodeGraphSummaryRepairActive,
  requestCodeGraphSummaryRepair,
  setCodeGraphGenerationQueueListener,
} from '../code-graph/build-runner';
import {
  buildCodeGraphThroughWorker,
  readGenerationQueue,
  reorderGenerationQueue,
  type WorkerCodeGraphDispatcher,
} from '../canopy-runtime/worker-code-graph-adapter';
import { CanopyOperationError } from '@canopy/core-runtime';
import { CanopyClientError } from '@canopy/core-client';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import {
  CodeGraphReadFailureError,
  codeGraphReadFailure,
} from '../code-graph/read-runner';
import { recordCodeGraphSummaryFanoutDiagnostic } from '../lib/code-graph-telemetry';
import {
  readWorkspaceBaseCodeGraphSummaries,
  readWorktreeCodeGraph,
  type CodeGraphReadAnswer,
} from '../code-graph/graph-reads';
import { repairWorkspaceBaseCodeGraphSummary } from '../code-graph/graph-builds';
import { withDaemonCodeGraphRoute } from '../code-graph/daemon-code-graph-route-context';
import {
  combinedCodeGraphBuildState,
  selectDaemonCodeGraph,
  type DaemonCodeGraphRouteContext,
} from '../code-graph/daemon-code-graph-route';
import { resolveRemoteBridgeSender } from '../remote-control/host/bridge-window';
import {
  CODE_GRAPH_UNAVAILABLE_MESSAGE,
  isCodeGraphAvailableForWorkspace,
} from '../lib/code-graph-availability';
import { isCodeGraphFeatureEnabled } from '../lib/code-graph-feature-flag';
import { describeCodeGraphBaseWorkspace } from '../lib/code-graph-base-manager';
import {
  isCodeGraphPerformanceSchedulerEnabled,
  runCodeGraphPerformanceBuild,
} from '../lib/code-graph-scheduler';
import { readAllSidebarItems } from '../lib/sidebar-items';
import { sendToWindow } from '../lib/window-send';
import { validateId } from '../lib/validation';
import { registerIpcHandler } from './register';

const ZERO_TOTALS = {
  fileCount: 0,
  symbolCount: 0,
  edgeCount: 0,
  unresolvedEdgeCount: 0,
  filesWithErrors: 0,
  communityCount: 0,
  flowCount: 0,
};

function ipcError(
  code: CodeGraphIpcError['code'],
  message: string,
): CodeGraphIpcError {
  return { ok: false, code, message };
}

function baseOutcomeMessage(
  outcome: 'failed' | 'timed_out' | 'unavailable',
): string {
  if (outcome === 'unavailable') return CODE_GRAPH_UNAVAILABLE_MESSAGE;
  if (outcome === 'timed_out') {
    return 'Generation timed out. Increase the timeout in Code Graph settings and try again.';
  }
  return 'Generation failed for this repository. Try again.';
}

/**
 * The `worker.codeGraph.build` refusal code, when the build was refused, in
 * process or by the daemon (CAN-5089).
 */
function workerBuildRefusal(error: unknown): string | undefined {
  return error instanceof CanopyOperationError ||
    error instanceof CanopyClientError
    ? error.payload.code
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

function validateRequestId(value: string, label: string): void {
  try {
    validateId(value, label);
  } catch {
    throw new Error('invalid-request');
  }
}

function validateWorktreeRequest(
  value: unknown,
): CodeGraphWorktreeSummaryRequest {
  if (
    !isRecord(value) ||
    typeof value.workspaceId !== 'string' ||
    typeof value.worktreeId !== 'string'
  ) {
    throw new Error('invalid-request');
  }
  validateRequestId(value.workspaceId, 'project id');
  validateRequestId(value.worktreeId, 'worktree id');
  return { workspaceId: value.workspaceId, worktreeId: value.worktreeId };
}

function validateWorkspaceRequest(
  value: unknown,
): CodeGraphWorkspaceSummaryRequest {
  if (!isRecord(value) || typeof value.workspaceId !== 'string') {
    throw new Error('invalid-request');
  }
  validateRequestId(value.workspaceId, 'project id');
  return { workspaceId: value.workspaceId };
}

async function resolveWorkspace(workspaceId: string): Promise<{
  item: Exclude<SidebarItem, { type: 'cowork' }>;
  items: SidebarItem[];
}> {
  const { items } = await readAllSidebarItems();
  const item = items.find((candidate) => candidate.id === workspaceId);
  if (item === undefined || item.type === 'cowork') {
    throw new Error('workspace-not-found');
  }
  return { item, items };
}

function repositoryName(
  item: Exclude<SidebarItem, { type: 'cowork' }>,
  repoId: string,
): string {
  if (item.type === 'single-repo') return item.name;
  if (repoId === WORKSPACE_ROOT_REPO_ID) return 'Project root';
  return (
    item.repos.find((repository) => repository.id === repoId)?.name ?? repoId
  );
}

function aggregateRepositories(
  scope: CodeGraphUiSummary['scope'],
  enabled: boolean,
  repositories: CodeGraphRepositoryUiSummary[],
  message?: string,
  stateOverride?: CodeGraphUiState,
): CodeGraphUiSummary {
  const totals = repositories.reduce(
    (sum, repository) => ({
      fileCount: sum.fileCount + repository.fileCount,
      symbolCount: sum.symbolCount + repository.symbolCount,
      edgeCount: sum.edgeCount + repository.edgeCount,
      unresolvedEdgeCount:
        sum.unresolvedEdgeCount + repository.unresolvedEdgeCount,
      filesWithErrors: sum.filesWithErrors + repository.filesWithErrors,
      communityCount: sum.communityCount + repository.communityCount,
      flowCount: sum.flowCount + repository.flowCount,
    }),
    { ...ZERO_TOTALS },
  );
  const states = new Set(repositories.map((repository) => repository.state));
  let state: CodeGraphUiState;
  if (stateOverride !== undefined) {
    state = stateOverride;
  } else if (
    repositories.length === 0 ||
    states.size === 0 ||
    (states.has('missing') && states.size === 1)
  ) {
    state = 'missing';
  } else if (states.size > 1) {
    state = 'partial';
  } else {
    state = repositories[0]?.state ?? 'missing';
  }
  return {
    scope,
    enabled,
    state,
    repositories,
    totals,
    lastBuildAt: repositories.reduce<number | null>(
      (latest, repository) =>
        repository.lastBuildAt !== null &&
        (latest === null || repository.lastBuildAt > latest)
          ? repository.lastBuildAt
          : latest,
      null,
    ),
    ...(message ? { message } : {}),
  };
}

/** No snapshot is an actionable empty state, not a failed read. */
function missingSummary(
  scope: CodeGraphUiSummary['scope'],
  workspaceId: string,
  buildState: CodeGraphBuildState,
): CodeGraphUiSummary {
  return {
    ...aggregateRepositories(
      scope,
      isCodeGraphAvailableForWorkspace(workspaceId),
      [],
    ),
    snapshotState: 'missing',
    buildState,
  };
}

/**
 * A retained graph whose summary is not measured, in a project where Code
 * Graph is off. No repair or build runs for that project, so a pending result
 * could never become ready. Report the disabled empty state instead.
 */
function disabledUnmeasuredSummary(
  scope: CodeGraphUiSummary['scope'],
  buildState: CodeGraphBuildState,
  lastBuildAt: number | null,
): CodeGraphUiSummary {
  return {
    ...aggregateRepositories(scope, false, []),
    snapshotState: 'missing',
    buildState,
    lastBuildAt,
  };
}

type RequiredRepositoryOutcome =
  | {
      state: 'ready';
      repoId: string;
      summary: CodeGraphRepositoryUiSummary;
      projection: CodeGraphSummaryProjectionV1;
    }
  | { state: 'pending' | 'missing'; repoId: string; lastBuildAt: number | null }
  | {
      state: 'error';
      repoId: string;
      readFailure: CodeGraphReadFailure;
      lastBuildAt: number | null;
    };

/** Safe failure messages from the refresh that preceded a read, by repository. */
interface RefreshFailures {
  item: Exclude<SidebarItem, { type: 'cowork' }>;
  messages: ReadonlyMap<string, string>;
}

function unavailableSummary(
  snapshotState: 'missing' | 'summary-pending' | 'read-error',
  buildState: CodeGraphBuildState,
  lastBuildAt: number | null,
  readFailure?: CodeGraphReadFailure,
): CodeGraphIpcError {
  return {
    ok: false,
    code: snapshotState === 'read-error' ? 'internal' : 'unavailable',
    snapshotState,
    buildState,
    lastBuildAt,
    message:
      snapshotState === 'read-error'
        ? 'The retained Code Graph could not be read. Try again.'
        : snapshotState === 'missing'
          ? 'No retained Code Graph is available.'
          : 'The retained Code Graph summary is not ready. Try again.',
    ...(snapshotState === 'read-error' && readFailure !== undefined
      ? { readFailure }
      : {}),
  };
}

function repositorySummary(
  item: Exclude<SidebarItem, { type: 'cowork' }>,
  projection: CodeGraphSummaryProjectionV1,
  repo: CodeGraphSummaryProjectionV1['repositories'][number],
  stale = false,
): CodeGraphRepositoryUiSummary {
  return {
    repoId: repo.repoId,
    name: repositoryName(item, repo.repoId),
    state: stale ? 'stale' : 'ready',
    fileCount: repo.counts.fileCount,
    symbolCount: repo.counts.symbolCount,
    edgeCount: repo.counts.edgeCount,
    unresolvedEdgeCount: repo.counts.legacyUnresolvedEdgeCount,
    filesWithErrors: repo.counts.legacyFilesWithErrors,
    communityCount: repo.counts.communityCount,
    flowCount: repo.counts.flowCount,
    lastBuildAt: projection.lastBuildAt,
    gitHead: repo.gitHead,
    ...(stale
      ? { message: 'The published graph is behind the shadow checkout.' }
      : {}),
  };
}

function completeRequiredRepositorySummary(
  scope: CodeGraphUiSummary['scope'],
  workspaceId: string,
  worktreeId: string,
  outcomes: RequiredRepositoryOutcome[],
  buildState: CodeGraphBuildState,
  refreshFailures?: RefreshFailures,
): CodeGraphUiSummaryResponse {
  // Retain successes and each unavailable identity internally. Never publish partial totals as complete.
  recordCodeGraphSummaryFanoutDiagnostic({
    projectId: workspaceId,
    worktreeId,
    outcomes: outcomes.map((outcome) =>
      outcome.state === 'ready'
        ? {
            repoId: outcome.repoId,
            state: outcome.state,
            fileCount: outcome.summary.fileCount,
            symbolCount: outcome.summary.symbolCount,
            edgeCount: outcome.summary.edgeCount,
          }
        : {
            repoId: outcome.repoId,
            state: outcome.state,
            ...(outcome.state === 'error'
              ? { readFailure: outcome.readFailure }
              : {}),
          },
    ),
  });
  const failure = outcomes.find((outcome) => outcome.state === 'error');
  const lastBuildAt = outcomes.reduce<number | null>((latest, outcome) => {
    const value =
      outcome.state === 'ready'
        ? outcome.summary.lastBuildAt
        : outcome.lastBuildAt;
    return value !== null && (latest === null || value > latest)
      ? value
      : latest;
  }, null);
  if (failure?.state === 'error')
    return unavailableSummary(
      'read-error',
      buildState,
      lastBuildAt,
      failure.readFailure,
    );
  if (outcomes.every((outcome) => outcome.state === 'missing'))
    return missingSummary(scope, workspaceId, buildState);
  // A refresh that just failed for a repository with no published base
  // leaves nothing to read for it. That is a reported failure, not a summary
  // that is still being prepared.
  const refreshFailure = (
    outcome: RequiredRepositoryOutcome,
  ): string | undefined =>
    outcome.state === 'missing'
      ? refreshFailures?.messages.get(outcome.repoId)
      : undefined;
  if (
    outcomes.some(
      (outcome) =>
        outcome.state !== 'ready' && refreshFailure(outcome) === undefined,
    )
  )
    return isCodeGraphAvailableForWorkspace(workspaceId)
      ? unavailableSummary('summary-pending', buildState, lastBuildAt)
      : disabledUnmeasuredSummary(scope, buildState, lastBuildAt);
  const repositories: CodeGraphRepositoryUiSummary[] = [];
  for (const outcome of outcomes) {
    if (outcome.state === 'ready') {
      repositories.push(outcome.summary);
      continue;
    }
    const message = refreshFailure(outcome);
    if (refreshFailures !== undefined && message !== undefined)
      repositories.push({
        repoId: outcome.repoId,
        name: repositoryName(refreshFailures.item, outcome.repoId),
        state: 'error',
        ...ZERO_TOTALS,
        lastBuildAt: null,
        gitHead: null,
        message,
      });
  }
  return {
    ...aggregateRepositories(
      scope,
      isCodeGraphAvailableForWorkspace(workspaceId),
      repositories,
    ),
    snapshotState: 'readable',
    buildState,
  };
}

/**
 * The summary read, from the daemon when the renderer request is routed
 * there (CAN-5089), or in process. An unreachable daemon reads in process.
 */
async function readWorktreeSummary(
  request: CodeGraphWorktreeSummaryRequest,
  routed: boolean,
): Promise<{ answer: CodeGraphReadAnswer; daemon: boolean }> {
  // The dispatcher's read takes the daemon route when it is selected.
  const { value, daemon } = await withDaemonCodeGraphRoute(routed, () =>
    readWorktreeCodeGraph(
      { projectId: request.workspaceId, worktreeId: request.worktreeId },
      'ui-summary',
      { kind: 'summary' },
    ),
  );
  return { answer: value, daemon };
}

async function loadWorktreeSummary(
  request: CodeGraphWorktreeSummaryRequest,
  routed = false,
): Promise<CodeGraphUiSummaryResponse> {
  const { item } = await resolveWorkspace(request.workspaceId);
  if (!item.worktrees.some((worktree) => worktree.id === request.worktreeId))
    throw new Error('worktree-not-found');
  const key = `${request.workspaceId}/${request.worktreeId}`;
  try {
    const { answer, daemon } = await readWorktreeSummary(request, routed);
    if (answer.result.kind !== 'readonly-summary')
      throw new CodeGraphReadFailureError('invalid-response');
    const read = answer.result.value;
    const state = daemon
      ? combinedCodeGraphBuildState(
          getCodeGraphSourceBuildState(key),
          answer.buildState,
        )
      : getCodeGraphSourceBuildState(key);
    if (read.state === 'error')
      return unavailableSummary(
        'read-error',
        state,
        null,
        read.classification === 'busy' ? 'busy' : 'database-error',
      );
    if (read.state === 'missing')
      return missingSummary('worktree', request.workspaceId, state);
    if (read.state === 'pending') {
      if (!isCodeGraphAvailableForWorkspace(request.workspaceId))
        return disabledUnmeasuredSummary(
          'worktree',
          state,
          read.observed.lastBuildAt,
        );
      // No build or seed has committed, so there is no summary to repair.
      // Generation is the way forward.
      if (read.reason === 'build-incomplete')
        return missingSummary('worktree', request.workspaceId, state);
      void requestCodeGraphSummaryRepair({
        key,
        projectId: request.workspaceId,
        worktreeId: request.worktreeId,
        dbPath: getWorktreeCodeGraphDbPath(
          request.workspaceId,
          request.worktreeId,
        ),
      }).catch(() => undefined);
      // Pending means a repair or a build is working on the summary. A repair
      // that was refused, or is cooling down after a failure, will not make it
      // ready: report it as unreadable, which keeps Update available.
      if (!isCodeGraphSummaryRepairActive(key) && state === 'idle')
        return unavailableSummary(
          'read-error',
          state,
          read.observed.lastBuildAt,
          'database-error',
        );
      return unavailableSummary(
        'summary-pending',
        state,
        read.observed.lastBuildAt,
      );
    }
    if (read.projection.repositories.length === 0)
      return {
        ...aggregateRepositories(
          'worktree',
          isCodeGraphAvailableForWorkspace(request.workspaceId),
          [],
          undefined,
          'ready',
        ),
        snapshotState: 'readable',
        buildState: state,
        lastBuildAt: read.projection.lastBuildAt,
      };
    return completeRequiredRepositorySummary(
      'worktree',
      request.workspaceId,
      request.worktreeId,
      read.projection.repositories.map((repo) => ({
        state: 'ready',
        repoId: repo.repoId,
        summary: repositorySummary(item, read.projection, repo),
        projection: read.projection,
      })),
      state,
    );
  } catch (error) {
    return unavailableSummary(
      'read-error',
      getCodeGraphSourceBuildState(key),
      null,
      codeGraphReadFailure(error),
    );
  }
}

async function loadWorkspaceSummary(
  request: CodeGraphWorkspaceSummaryRequest,
  refreshFailureMessages?: ReadonlyMap<string, string>,
): Promise<CodeGraphUiSummaryResponse> {
  const { item } = await resolveWorkspace(request.workspaceId);
  if (describeCodeGraphBaseWorkspace(item) === null)
    return missingSummary('workspace-shadow', request.workspaceId, 'idle');
  const bases = await readWorkspaceBaseCodeGraphSummaries(request.workspaceId);
  const sourceStates: CodeGraphBuildState[] = [];
  const outcomes = bases.repositories.map((base): RequiredRepositoryOutcome => {
    const { repoId } = base;
    if (base.buildState !== null) sourceStates.push(base.buildState);
    if (base.state === 'failed')
      return {
        state: 'error',
        repoId,
        lastBuildAt: null,
        readFailure: base.failure,
      };
    // Nothing is published, or Code Graph was never prepared for this
    // project: an empty state, not a summary that is being prepared.
    if (!base.published) return { state: 'missing', repoId, lastBuildAt: null };
    const read = base.summary;
    if (read.state === 'error')
      return {
        state: 'error',
        repoId,
        lastBuildAt: null,
        readFailure: read.classification === 'busy' ? 'busy' : 'database-error',
      };
    if (read.state === 'missing')
      return { state: 'missing', repoId, lastBuildAt: null };
    // No build or seed has committed: there is no summary to repair.
    if (read.state === 'pending' && read.reason === 'build-incomplete')
      return { state: 'missing', repoId, lastBuildAt: null };
    if (read.state === 'pending') {
      // Immutable generation: maintenance stages a successor through the existing base writer.
      void repairWorkspaceBaseCodeGraphSummary({
        workspaceId: request.workspaceId,
        repoId,
      }).catch(() => undefined);
      return {
        state: 'pending',
        repoId,
        lastBuildAt: read.observed.lastBuildAt,
      };
    }
    const repo =
      read.projection.repositories.length === 1
        ? read.projection.repositories[0]
        : undefined;
    if (repo === undefined || repo.repoId !== repoId)
      return {
        state: 'error',
        repoId,
        lastBuildAt: read.projection.lastBuildAt,
        readFailure: 'database-error',
      };
    return {
      state: 'ready',
      repoId,
      projection: read.projection,
      summary: repositorySummary(
        item,
        read.projection,
        repo,
        base.behindCheckout,
      ),
    };
  });
  const buildState: CodeGraphBuildState = sourceStates.includes('running')
    ? 'running'
    : sourceStates.includes('queued')
      ? 'queued'
      : 'idle';
  return completeRequiredRepositorySummary(
    'workspace-shadow',
    request.workspaceId,
    '',
    outcomes,
    buildState,
    refreshFailureMessages === undefined
      ? undefined
      : { item, messages: refreshFailureMessages },
  );
}

async function safeSummaryRequest(
  load: () => Promise<CodeGraphUiSummaryResponse>,
): Promise<CodeGraphUiSummaryResponse> {
  try {
    return await load();
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    return ipcError(
      message === 'workspace-not-found' ||
        message === 'worktree-not-found' ||
        message === 'invalid-request'
        ? 'invalid-request'
        : 'internal',
      message === 'worktree-not-found'
        ? 'Worktree not found in this project.'
        : message === 'workspace-not-found'
          ? 'Project not found.'
          : message === 'invalid-request'
            ? 'The Code Graph request is invalid.'
            : 'The Code Graph request could not be completed.',
    );
  }
}

function broadcastQueue(snapshot: CodeGraphGenerationQueueSnapshot): void {
  const safeSnapshot = isCodeGraphFeatureEnabled()
    ? snapshot
    : { revision: snapshot.revision, entries: [] };
  for (const window of BrowserWindow.getAllWindows()) {
    sendToWindow(
      window,
      IPC_CHANNELS.codeGraphGenerationQueueChanged,
      safeSnapshot,
    );
  }
}

export function registerCodeGraphHandlers(
  runtime: {
    dispatcher: WorkerCodeGraphDispatcher;
    resolveCaller: (event: IpcMainInvokeEvent) => CanopyCallerDescriptor;
  },
  windows: {
    getMainWindow: () => BrowserWindow | null;
    getAppAdvisorWindow: () => BrowserWindow | null;
  } = {
    getMainWindow: () => null,
    getAppAdvisorWindow: () => null,
  },
): void {
  setCodeGraphGenerationQueueListener(broadcastQueue);

  // CAN-5089: only this app's own windows may build or read in the daemon;
  // the remote-control bridge and Portal keep Electron main's graph hosts.
  const routeContext = (
    event: Pick<IpcMainInvokeEvent, 'sender'> | null | undefined,
  ): DaemonCodeGraphRouteContext => ({
    localWindow:
      event !== null &&
      event !== undefined &&
      resolveRemoteBridgeSender(event.sender) === null &&
      [windows.getMainWindow(), windows.getAppAdvisorWindow()].some(
        (window) =>
          window !== null &&
          window.webContents === event.sender &&
          !window.isDestroyed(),
      ),
  });

  registerIpcHandler(IPC_CHANNELS.codeGraphGetWorktreeSummary, (event, raw) =>
    safeSummaryRequest(() =>
      loadWorktreeSummary(
        validateWorktreeRequest(raw),
        selectDaemonCodeGraph(routeContext(event)),
      ),
    ),
  );
  registerIpcHandler(
    IPC_CHANNELS.codeGraphBuildWorktree,
    // worker.codeGraph.build (CAN-4149).
    async (event, raw) => {
      let request: CodeGraphWorktreeSummaryRequest;
      try {
        request = validateWorktreeRequest(raw);
        await resolveWorkspace(request.workspaceId).then(({ item }) => {
          if (
            !item.worktrees.some(
              (worktree) => worktree.id === request.worktreeId,
            )
          ) {
            throw new Error('worktree-not-found');
          }
        });
      } catch {
        return ipcError(
          'invalid-request',
          'The project or worktree is invalid.',
        );
      }
      if (!isCodeGraphAvailableForWorkspace(request.workspaceId)) {
        return ipcError('unavailable', CODE_GRAPH_UNAVAILABLE_MESSAGE);
      }
      const graphScope = {
        kind: 'worktree' as const,
        workspaceId: request.workspaceId,
        worktreeId: request.worktreeId,
        mode: 'verified' as const,
      };
      try {
        // The dispatcher's build takes the daemon route when it is selected.
        const { daemon } = await withDaemonCodeGraphRoute(
          selectDaemonCodeGraph(routeContext(event)),
          () =>
            buildCodeGraphThroughWorker(
              runtime.dispatcher,
              runtime.resolveCaller(event),
              graphScope,
            ),
        );
        return await loadWorktreeSummary(request, daemon);
      } catch (error) {
        const code = workerBuildRefusal(error);
        if (code === 'worker.codeGraph.unavailable') {
          return ipcError('unavailable', CODE_GRAPH_UNAVAILABLE_MESSAGE);
        }
        if (code === 'worker.codeGraph.buildTimedOut') {
          return ipcError(
            'internal',
            'Code Graph generation timed out. Increase the timeout in Code Graph settings and try again.',
          );
        }
        if (isRecord(error) && error.reason === 'unavailable') {
          return ipcError('unavailable', CODE_GRAPH_UNAVAILABLE_MESSAGE);
        }
        if (isRecord(error) && error.reason === 'timeout') {
          return ipcError(
            'internal',
            'Code Graph generation timed out. Increase the timeout in Code Graph settings and try again.',
          );
        }
        return ipcError('internal', 'The Code Graph build failed.');
      }
    },
  );
  registerIpcHandler(
    IPC_CHANNELS.codeGraphSchedulePerformanceBuild,
    async (_event, raw) => {
      if (!isCodeGraphPerformanceSchedulerEnabled()) {
        return ipcError('unavailable', CODE_GRAPH_UNAVAILABLE_MESSAGE);
      }
      let request: CodeGraphWorktreeSummaryRequest;
      try {
        request = validateWorktreeRequest(raw);
        await resolveWorkspace(request.workspaceId).then(({ item }) => {
          if (
            !item.worktrees.some(
              (worktree) => worktree.id === request.worktreeId,
            )
          ) {
            throw new Error('worktree-not-found');
          }
        });
      } catch {
        return ipcError(
          'invalid-request',
          'The project or worktree is invalid.',
        );
      }
      if (!isCodeGraphAvailableForWorkspace(request.workspaceId)) {
        return ipcError('unavailable', CODE_GRAPH_UNAVAILABLE_MESSAGE);
      }
      await runCodeGraphPerformanceBuild({
        projectId: request.workspaceId,
        worktreeId: request.worktreeId,
      });
      return { ok: true as const };
    },
  );
  registerIpcHandler(IPC_CHANNELS.codeGraphGetWorkspaceSummary, (_event, raw) =>
    safeSummaryRequest(() =>
      loadWorkspaceSummary(validateWorkspaceRequest(raw)),
    ),
  );
  registerIpcHandler(
    IPC_CHANNELS.codeGraphBuildWorkspace,
    // worker.codeGraph.build (CAN-4149).
    async (event, raw) => {
      let request: CodeGraphWorkspaceSummaryRequest;
      try {
        request = validateWorkspaceRequest(raw);
        const { items } = await readAllSidebarItems();
        if (
          !items.some(
            (item) => item.id === request.workspaceId && item.type !== 'cowork',
          )
        ) {
          throw new Error('workspace-not-found');
        }
      } catch {
        return ipcError('invalid-request', 'The project is invalid.');
      }
      if (!isCodeGraphAvailableForWorkspace(request.workspaceId)) {
        return ipcError('unavailable', CODE_GRAPH_UNAVAILABLE_MESSAGE);
      }
      try {
        const result = await buildCodeGraphThroughWorker(
          runtime.dispatcher,
          runtime.resolveCaller(event),
          { kind: 'workspace_base', workspaceId: request.workspaceId },
        );
        const outcomes =
          result.kind === 'workspace_base' ? result.repositories : [];
        if (outcomes.every((outcome) => outcome.outcome !== 'built')) {
          const unavailable = outcomes.some(
            (outcome) => outcome.outcome === 'unavailable',
          );
          return ipcError(
            unavailable ? 'unavailable' : 'internal',
            unavailable
              ? CODE_GRAPH_UNAVAILABLE_MESSAGE
              : 'No repository graph could be generated.',
          );
        }
        const failures = new Map<string, string>();
        for (const outcome of outcomes)
          if (outcome.outcome !== 'built')
            failures.set(
              outcome.repositoryId,
              baseOutcomeMessage(outcome.outcome),
            );
        const summary = await loadWorkspaceSummary(request, failures);
        if ('ok' in summary) return summary;
        const repositories = summary.repositories.map((repository) => {
          const message = failures.get(repository.repoId);
          return message === undefined
            ? repository
            : { ...repository, state: 'error' as const, message };
        });
        return aggregateRepositories(
          summary.scope,
          summary.enabled,
          repositories,
          failures.size > 0
            ? 'Some repository graphs could not be generated.'
            : undefined,
        );
      } catch (error) {
        if (workerBuildRefusal(error) === 'worker.codeGraph.unavailable') {
          return ipcError('unavailable', CODE_GRAPH_UNAVAILABLE_MESSAGE);
        }
        if (isRecord(error) && error.reason === 'unavailable') {
          return ipcError('unavailable', CODE_GRAPH_UNAVAILABLE_MESSAGE);
        }
        return ipcError('internal', 'The Code Graph build failed.');
      }
    },
  );
  // worker.codeGraph.buildQueue.get (CAN-4149).
  registerIpcHandler(
    IPC_CHANNELS.codeGraphGetGenerationQueue,
    async (event) => {
      const snapshot = await readGenerationQueue(
        runtime.dispatcher,
        runtime.resolveCaller(event),
      );
      return isCodeGraphFeatureEnabled()
        ? snapshot
        : { revision: snapshot.revision, entries: [] };
    },
  );
  registerIpcHandler(
    IPC_CHANNELS.codeGraphReorderGenerationQueue,
    // worker.codeGraph.buildQueue.update (CAN-4149).
    async (event, raw) => {
      if (!isCodeGraphFeatureEnabled()) {
        return ipcError('unavailable', 'Code Graph controls are unavailable.');
      }
      if (
        !isRecord(raw) ||
        !isSafeInteger(raw.revision) ||
        !isStringArray(raw.orderedQueuedEntryIds)
      ) {
        return ipcError(
          'invalid-request',
          'The queue reorder request is invalid.',
        );
      }
      try {
        raw.orderedQueuedEntryIds.forEach((id) =>
          validateId(id, 'queue entry id'),
        );
      } catch {
        return ipcError(
          'invalid-request',
          'The queue reorder request is invalid.',
        );
      }
      return reorderGenerationQueue(
        runtime.dispatcher,
        runtime.resolveCaller(event),
        {
          revision: raw.revision,
          orderedQueuedEntryIds: raw.orderedQueuedEntryIds,
        },
      );
    },
  );
}
