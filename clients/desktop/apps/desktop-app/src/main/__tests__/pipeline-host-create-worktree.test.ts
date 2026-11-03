import type * as ScriptExecutionModule from '@canopy/core-runtime/node/script/execution';
import type { WorkerScriptExecutionGetResult } from '@canopy/protocol/canopy-core';
import type * as ScriptLogStore from '../lib/script-log-store';
// Setup replay reads the recorded run through worker.script.execution.get.
jest.mock('../lib/script-execution', () => ({
  readScriptRun: async (request: {
    projectId: string;
    worktreeId: string;
    scriptKey: string;
  }): Promise<WorkerScriptExecutionGetResult> => {
    const logStore = jest.requireMock<typeof ScriptLogStore>(
      '../lib/script-log-store',
    );
    const execution = jest.requireActual<typeof ScriptExecutionModule>(
      '@canopy/core-runtime/node/script/execution',
    );
    const meta = await logStore.readScriptRunMeta(request);
    return {
      run: meta
        ? { execution: execution.toWorkerScriptExecution(meta), lines: [] }
        : null,
    };
  },
}));

jest.mock('../lib/worktree-creation', () => ({
  createWorktreeFromSelection: jest.fn(),
}));
jest.mock('../lib/project-worktree-runtime', () => ({
  runProjectWorktreePostCreateSetup: jest.fn(),
}));
jest.mock('../lib/workspace-worktree-runtime', () => ({
  runWorkspaceWorktreePostCreateSetup: jest.fn(),
}));
jest.mock('../lib/script-log-store', () => ({
  snapshotScriptRunLog: jest.fn(),
  readScriptRunMeta: jest.fn(),
}));
jest.mock('../lib/window-send', () => ({
  sendToWindow: jest.fn(),
  sendToAllWindows: jest.fn(),
}));
jest.mock('../services/sidebar-item-groups-service', () => ({
  SidebarItemGroupRefusalError: jest.requireActual<
    typeof SidebarItemGroupsServiceModule
  >('../services/sidebar-item-groups-service').SidebarItemGroupRefusalError,
  sidebarItemGroupsService: {
    assignItemToNamedGroup: jest.fn(),
    moveItem: jest.fn(),
    list: jest.fn(),
  },
}));
jest.mock('../lib/workspace-persistence', () => ({
  readWorkspaceConfigDetailed: jest.fn(),
  readWorkspaceWorktreesDetailed: jest.fn(),
}));
jest.mock('../lib/cowork-migration-map', () => ({
  resolveCoworkWorkspaceId: jest.fn(),
}));
jest.mock('../lib/cowork-work-entries', () => ({
  readWorkEntriesFileStrict: jest.fn(),
}));
jest.mock('../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
  logMainProcessError: jest.fn(),
}));
jest.mock('../lib/paths', () => ({
  ...jest.requireActual<typeof PathsModule>('../lib/paths'),
  getWorktreeDir: (projectId: string, worktreeId: string): string =>
    `/canopy-test/project-worktrees/${projectId}/${worktreeId}`,
  getWorkspaceWorktreeDir: (workspaceId: string, worktreeId: string): string =>
    `/canopy-test/workspace-worktrees/${workspaceId}/${worktreeId}`,
}));

import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { BrowserWindow } from 'electron';
import type * as PathsModule from '../lib/paths';
import type * as SidebarItemGroupsServiceModule from '../services/sidebar-item-groups-service';
import type { SidebarItemGroup } from '@canopy/protocol/sidebar';
import {
  IPC_CHANNELS,
  type ScriptDescriptor,
  type WorkspaceRepoData,
  type WorkspaceType,
  type WorktreeData,
} from '@canopy/desktop-shared/types';
import { W5CommitRefusedError } from '@canopy/desktop-shared/node/w5-commit-log/errors';
import { PipelineHostRefusal } from '@canopy/desktop-shared/pipelines/host-actions';
import {
  emptyCreateWorktreeOutputs,
  type CreateWorktreeInputs,
} from '@canopy/desktop-shared/pipelines/host-create-worktree';
import type {
  PipelineHostActionCaller,
  PipelineHostActionControls,
  PipelineHostActionResult,
} from '@canopy/desktop-shared/node/pipelines/executor/types';
import { createWorktreeFromSelection } from '../lib/worktree-creation';
import type {
  WorktreeCreationOutcome,
  WorktreeCreationRequest,
} from '../lib/worktree-creation';
import {
  runProjectWorktreePostCreateSetup,
  type ProjectWorktreeSetupResult,
} from '../lib/project-worktree-runtime';
import { runWorkspaceWorktreePostCreateSetup } from '../lib/workspace-worktree-runtime';
import {
  readScriptRunMeta,
  snapshotScriptRunLog,
  type PersistedScriptRunFile,
} from '../lib/script-log-store';
import { sendToAllWindows, sendToWindow } from '../lib/window-send';
import {
  sidebarItemGroupsService,
  SidebarItemGroupRefusalError,
} from '../services/sidebar-item-groups-service';
import {
  readWorkspaceConfigDetailed,
  readWorkspaceWorktreesDetailed,
} from '../lib/workspace-persistence';
import { resolveCoworkWorkspaceId } from '../lib/cowork-migration-map';
import {
  logMainProcessError,
  logMainProcessWarn,
} from '../lib/main-process-logging';
import { IdentifierValidationError } from '../lib/validation';
import { WorktreeCreationRefusedError } from '../lib/worktree-creation-selection';
import type {
  WorktreeSetupObserver,
  WorktreeSetupRunResult,
  WorktreeSetupScriptRef,
  WorktreeSetupScriptResult,
} from '../lib/worktree-setup-result';
import {
  runCreateWorktreeHostAction,
  SETUP_RESULTS_FILE,
} from '../pipelines/host-create-worktree';
import {
  ATTEMPT_JOURNAL_FILE,
  newAttemptRecord,
  readAttemptRecord,
  setBeforeJournalWriteForTests,
  writeAttemptRecord,
  type AttemptRecord,
} from '../pipelines/host-create-worktree-state';
import type { PipelineHostOwnerCheck } from '../pipelines/host-task-resolution';

const create = jest.mocked(createWorktreeFromSelection);
const runProject = jest.mocked(runProjectWorktreePostCreateSetup);
const runWorkspace = jest.mocked(runWorkspaceWorktreePostCreateSetup);
const snapshot = jest.mocked(snapshotScriptRunLog);
const readMeta = jest.mocked(readScriptRunMeta);
const send = jest.mocked(sendToWindow);
const sendAll = jest.mocked(sendToAllWindows);
const groups = jest.mocked(sidebarItemGroupsService);
const readConfig = jest.mocked(readWorkspaceConfigDetailed);
const readWorktrees = jest.mocked(readWorkspaceWorktreesDetailed);
const resolveCowork = jest.mocked(resolveCoworkWorkspaceId);
const logWarn = jest.mocked(logMainProcessWarn);
const logError = jest.mocked(logMainProcessError);
const assertOwner: jest.MockedFunction<PipelineHostOwnerCheck> = jest.fn();

const PROJECT = 'proj-1';
const TASK = 'task-1';
const BRANCH = 'task-1-branch';
const CREATED_AT = '2026-10-21T00:00:00.000Z';
const REPO_PATH = '/repos/app';
const SINGLE_PATH = `/canopy-test/project-worktrees/${PROJECT}/${TASK}`;
const MULTI_PATH = `/canopy-test/workspace-worktrees/${PROJECT}/${TASK}`;

// ---------------------------------------------------------------------------
// Small async helpers
// ---------------------------------------------------------------------------

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function tick(ms = 0): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await tick(attempt < 20 ? 0 : 5);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/** Lets fire-and-forget work (fs writes included) land. */
async function quiesce(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await tick(10);
}

// ---------------------------------------------------------------------------
// Step harness
// ---------------------------------------------------------------------------

let keySeq = 0;
let tempRoots: string[] = [];

interface Step {
  artifactsDir: string;
  caller: PipelineHostActionCaller;
  finalizers: Array<() => Promise<PipelineHostActionResult>>;
  controls: PipelineHostActionControls;
}

function newStep(): Step {
  keySeq += 1;
  const root = mkdtempSync(path.join(os.tmpdir(), 'host-create-worktree-'));
  tempRoots.push(root);
  // Not created up front: the adapter creates it on its first write.
  const artifactsDir = path.join(root, 'host', 'artifacts');
  const finalizers: Array<() => Promise<PipelineHostActionResult>> = [];
  return {
    artifactsDir,
    caller: {
      executionId: 'exec-1',
      jobId: 'job-a',
      stepId: 'create',
      attempt: 0,
      iteration: 1,
      idempotencyKey: `pipeline-host:exec-1:job-a::create:${keySeq}:1`,
    },
    finalizers,
    controls: {
      deadlineAt: Date.now() + 60_000,
      artifactsDir,
      registerTimeoutFinalizer: (finalize): void => {
        finalizers.push(finalize);
      },
    },
  };
}

function runStep(
  step: Step,
  stepInputs: CreateWorktreeInputs,
  options: {
    signal?: AbortSignal;
    owner?: PipelineHostOwnerCheck;
    getWindow?: () => BrowserWindow | null;
  } = {},
): Promise<PipelineHostActionResult> {
  return runCreateWorktreeHostAction(
    stepInputs,
    step.caller,
    {
      assertTargetOwner: options.owner ?? assertOwner,
      getWindow: options.getWindow ?? ((): BrowserWindow | null => null),
    },
    options.signal ?? new AbortController().signal,
    step.controls,
  );
}

function inputs(
  overrides: Partial<CreateWorktreeInputs> = {},
): CreateWorktreeInputs {
  return {
    projectId: PROJECT,
    branch: { kind: 'default' },
    repair: false,
    setup: 'skip',
    ...overrides,
  };
}

async function journalOf(step: Step): Promise<AttemptRecord> {
  const read = await readAttemptRecord(step.artifactsDir);
  if (read.kind !== 'ok') throw new Error(`journal is ${read.kind}`);
  return read.record;
}

function hasJournal(step: Step): boolean {
  return existsSync(path.join(step.artifactsDir, ATTEMPT_JOURNAL_FILE));
}

/** File name to `mtime:content`, so any later write shows up. */
function artifactListing(step: Step): Record<string, string> {
  if (!existsSync(step.artifactsDir)) return {};
  const listing: Record<string, string> = {};
  for (const name of readdirSync(step.artifactsDir)) {
    const filePath = path.join(step.artifactsDir, name);
    listing[name] =
      `${statSync(filePath).mtimeMs}:${readFileSync(filePath, 'utf8')}`;
  }
  return listing;
}

function readResultsFile(step: Step): unknown {
  const body: unknown = JSON.parse(
    readFileSync(path.join(step.artifactsDir, SETUP_RESULTS_FILE), 'utf8'),
  );
  return body;
}

function artifact(step: Step, name: string): string {
  return path.join(step.artifactsDir, name);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type ConfigDetail = Awaited<ReturnType<typeof readWorkspaceConfigDetailed>>;

function configDetail(
  type: WorkspaceType,
  repos: WorkspaceRepoData[] = [],
): ConfigDetail {
  return {
    config: {
      version: 1,
      type,
      repos,
      ...(type === 'single-repo' ? { repoPath: REPO_PATH } : {}),
    },
    authority: 'ok',
    ownerMalformed: false,
    memoryMalformed: false,
  };
}

const REPOS: WorkspaceRepoData[] = [
  { id: 'repo-a', name: 'Repo A', repoPath: '/repos/a' },
  { id: 'repo-b', name: 'Repo B', repoPath: '/repos/b' },
];

function worktreeRow(id: string): WorktreeData {
  return { id, branchName: `feature/${id}`, createdAt: CREATED_AT };
}

function group(overrides: Partial<SidebarItemGroup> = {}): SidebarItemGroup {
  return {
    id: 'grp-1',
    name: 'Reviews',
    color: 'categorical-2',
    collapsed: false,
    memberIds: [TASK],
    ...overrides,
  };
}

function createdOutcome(
  kind: 'single-repo' | 'multi-repo',
  taskId = TASK,
  branchName = BRANCH,
): WorktreeCreationOutcome {
  const record = {
    worktreeId: taskId,
    branchName,
    createdAt: CREATED_AT,
    setupPhase: 'git-ready' as const,
    trackedBaseBranch: null,
    trackedRepoBaseBranches: {},
    includedRepoIds: null,
  };
  const response = { id: taskId, branchName, createdAt: CREATED_AT };
  return kind === 'single-repo'
    ? { status: 'created', workspaceKind: 'single-repo', record, response }
    : { status: 'created', workspaceKind: 'multi-repo', record, response };
}

function needsRepairOutcome(): WorktreeCreationOutcome {
  return {
    status: 'needs-repair',
    workspaceKind: 'multi-repo',
    worktreeId: TASK,
    branchName: BRANCH,
    repairIssues: [],
    response: {
      id: TASK,
      branchName: BRANCH,
      needsRepair: true,
      repairIssues: [],
    },
  };
}

type ServiceSetupState = 'pending' | 'launched' | 'refused';

/** The promises the fake service holds for post-create setup. */
let serviceSetups: Array<{ state: ServiceSetupState }> = [];

function watchServiceSetup(promise: Promise<void>): void {
  const box: { state: ServiceSetupState } = { state: 'pending' };
  serviceSetups.push(box);
  promise.then(
    () => {
      box.state = 'launched';
    },
    () => {
      box.state = 'refused';
    },
  );
}

interface FakeCreation {
  kind?: 'single-repo' | 'multi-repo';
  outcome?: WorktreeCreationOutcome;
  replay?: boolean;
  /** Holds the creation until released. */
  gate?: Promise<void>;
  error?: Error;
  repos?: WorkspaceRepoData[];
}

/** Emulates the service: setup starts synchronously right before the outcome returns. */
function fakeCreation(options: FakeCreation = {}): void {
  create.mockImplementation(async (request: WorktreeCreationRequest) => {
    if (options.gate) await options.gate;
    if (options.error) throw options.error;
    const outcome =
      options.outcome ?? createdOutcome(options.kind ?? 'single-repo');
    if (options.replay) {
      request.onKeyedReplay?.();
      return outcome;
    }
    if (outcome.status === 'created' && request.startPostCreateSetup) {
      const getWindow = request.getWindow ?? ((): BrowserWindow | null => null);
      const launched =
        outcome.workspaceKind === 'single-repo'
          ? request.startProjectPostCreateSetup?.({
              projectId: request.workspaceId,
              worktreeId: outcome.record.worktreeId,
              project: { repoPath: REPO_PATH },
              getWindow,
            })
          : request.startWorkspacePostCreateSetup?.({
              workspaceId: request.workspaceId,
              worktreeId: outcome.record.worktreeId,
              workspaceRootPath: MULTI_PATH,
              repos: options.repos ?? REPOS,
              getWindow,
            });
      if (launched) watchServiceSetup(launched);
    }
    return outcome;
  });
}

type ProjectRunParams = Parameters<typeof runProjectWorktreePostCreateSetup>[0];
type WorkspaceRunParams = Parameters<
  typeof runWorkspaceWorktreePostCreateSetup
>[0];

interface RunnerCall<Params, Result> {
  params: Params;
  result: Deferred<Result>;
}

let projectRuns: Array<
  RunnerCall<ProjectRunParams, ProjectWorktreeSetupResult>
> = [];
let workspaceRuns: Array<
  RunnerCall<WorkspaceRunParams, WorktreeSetupRunResult>
> = [];

function observerOf(call: {
  params: { observer?: WorktreeSetupObserver };
}): WorktreeSetupObserver {
  const { observer } = call.params;
  if (!observer) throw new Error('the runner received no observer');
  return observer;
}

function descriptor(ref: {
  scriptKey: string;
  lifecycle: WorktreeSetupScriptRef['lifecycle'];
  target: WorktreeSetupScriptRef['target'];
  repoId?: string;
}): ScriptDescriptor {
  return {
    scriptKey: ref.scriptKey,
    scriptName: ref.lifecycle,
    label: ref.lifecycle,
    command: 'echo setup',
    lifecycle: ref.lifecycle,
    target: ref.target,
    ...(ref.repoId !== undefined ? { repoId: ref.repoId } : {}),
  };
}

function scriptRef(
  runId: string,
  options: {
    scriptKey?: string;
    lifecycle?: WorktreeSetupScriptRef['lifecycle'];
    target?: WorktreeSetupScriptRef['target'];
    repoId?: string;
    logProjectId?: string;
  } = {},
): WorktreeSetupScriptRef {
  const lifecycle = options.lifecycle ?? 'setup';
  const target = options.target ?? 'project';
  const scriptKey =
    options.scriptKey ??
    (options.repoId !== undefined
      ? `${lifecycle}:${options.repoId}`
      : lifecycle);
  return {
    scriptKey,
    runId,
    target,
    lifecycle,
    ...(options.repoId !== undefined ? { repoId: options.repoId } : {}),
    logRef: {
      projectId: options.logProjectId ?? PROJECT,
      worktreeId: TASK,
      script: descriptor({
        scriptKey,
        lifecycle,
        target,
        ...(options.repoId !== undefined ? { repoId: options.repoId } : {}),
      }),
      runId,
    },
  };
}

function finished(
  ref: WorktreeSetupScriptRef,
  status: WorktreeSetupScriptResult['status'],
  exitCode: number | null,
  timedOut = false,
): WorktreeSetupScriptResult {
  return { ...ref, status, exitCode, timedOut };
}

function runMeta(
  runId: string,
  status: PersistedScriptRunFile['status'],
  exitCode: number | null,
): PersistedScriptRunFile {
  return {
    version: 1,
    runId,
    script: descriptor({
      scriptKey: 'setup',
      lifecycle: 'setup',
      target: 'project',
    }),
    invocation: 'automatic-setup',
    status,
    startedAt: CREATED_AT,
    updatedAt: CREATED_AT,
    completedAt: CREATED_AT,
    exitCode,
    timedOut: false,
    durationMs: 10,
  };
}

/** The outputs of a created single-repo worktree with no group requested. */
function createdOutputs(
  overrides: Record<string, string> = {},
  worktreePath = SINGLE_PATH,
): Record<string, string> {
  return {
    ...emptyCreateWorktreeOutputs(),
    project_id: PROJECT,
    workspace_id: PROJECT,
    task_id: TASK,
    worktree_id: TASK,
    path: worktreePath,
    branch_name: BRANCH,
    created_at: CREATED_AT,
    ...overrides,
  };
}

function projectOnlyOutputs(): Record<string, string> {
  return {
    ...emptyCreateWorktreeOutputs(),
    project_id: PROJECT,
    workspace_id: PROJECT,
  };
}

function allLogCalls(): string {
  return JSON.stringify([...logWarn.mock.calls, ...logError.mock.calls]);
}

// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.resetAllMocks();
  serviceSetups = [];
  projectRuns = [];
  workspaceRuns = [];
  assertOwner.mockResolvedValue(undefined);
  resolveCowork.mockImplementation((id) => id);
  readConfig.mockResolvedValue(configDetail('single-repo'));
  // The recorded task stays listed unless a test replaces or removes it.
  readWorktrees.mockResolvedValue({
    worktrees: [worktreeRow('base-task'), worktreeRow(TASK)],
    authority: 'ok',
  });
  groups.assignItemToNamedGroup.mockResolvedValue({
    group: group(),
    created: true,
  });
  // Like the real sender: only a live window receives the event.
  send.mockImplementation((window) => window !== null);
  fakeCreation();
  runProject.mockImplementation((params) => {
    const result = deferred<ProjectWorktreeSetupResult>();
    projectRuns.push({ params, result });
    return result.promise;
  });
  runWorkspace.mockImplementation((params) => {
    const result = deferred<WorktreeSetupRunResult>();
    workspaceRuns.push({ params, result });
    return result.promise;
  });
  snapshot.mockImplementation(async ({ ref, targetPath }) => {
    // Like the real copier: finalized copies are never overwritten.
    if (existsSync(targetPath)) {
      return {
        status: 'error',
        message: 'script log copy target already exists',
      };
    }
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, `log of ${ref.runId}\n`, 'utf8');
    return { status: 'copied' };
  });
});

afterEach(async () => {
  setBeforeJournalWriteForTests(undefined);
  // Late work from detached setups must not hit a removed directory loudly.
  await quiesce();
  await Promise.all(
    tempRoots.map((root) => rm(root, { recursive: true, force: true })),
  );
  tempRoots = [];
});

describe('runCreateWorktreeHostAction creation', () => {
  it('creates through the keyed boundary and returns both identifier pairs', async () => {
    const step = newStep();

    const result = await runStep(step, inputs({ baseBranch: 'main' }));

    expect(create).toHaveBeenCalledTimes(1);
    const request = create.mock.calls[0][0];
    expect(request).toMatchObject({
      workspaceId: PROJECT,
      workspaceKind: 'single-repo',
      branch: { kind: 'default' },
      base: { kind: 'branch', baseBranch: 'main' },
      idempotencyKey: step.caller.idempotencyKey,
      callerSource: 'pipeline-host',
      deferGitSetup: false,
      surfaceNeedsRepairInResponse: true,
      repairWorkspaceRoot: false,
      startPostCreateSetup: false,
      defaultBranchNaming: 'worktree-id',
    });
    expect(request).not.toHaveProperty('restoreClaudeMd');
    expect(result).toEqual({
      status: 'success',
      outputs: createdOutputs({ setup_state: 'skipped' }),
    });
    expect(send).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.workspaceWorktreesUpdated,
      { workspaceId: PROJECT },
    );
    const record = await journalOf(step);
    expect(record.phase).toBe('finalized');
    expect(record.result).toEqual(result);
    expect(record.worktree).toEqual({
      taskId: TASK,
      branchName: BRANCH,
      createdAt: CREATED_AT,
      path: SINGLE_PATH,
      workspaceKind: 'single-repo',
    });
    expect(record.attempt).toEqual({
      executionId: 'exec-1',
      jobId: 'job-a',
      stepId: 'create',
      attempt: 0,
      iteration: 1,
    });
  });

  it.each([
    [
      'a new branch',
      { branch: { kind: 'new', name: 'feature/x' } },
      {
        branch: { kind: 'new', branchName: 'feature/x' },
        base: { kind: 'repository-default' },
      },
    ],
    [
      'an existing branch',
      { branch: { kind: 'existing', name: 'feature/y' } },
      {
        branch: { kind: 'existing', branchName: 'feature/y' },
        base: { kind: 'repository-default' },
      },
    ],
    [
      'a base task',
      { branch: { kind: 'new', name: 'stacked' }, baseTaskId: 'base-task' },
      {
        branch: { kind: 'new', branchName: 'stacked' },
        base: { kind: 'worktree', baseWorktreeId: 'base-task' },
      },
    ],
  ] satisfies Array<
    [string, Partial<CreateWorktreeInputs>, Partial<WorktreeCreationRequest>]
  >)(
    'maps %s without the worktree-id default naming',
    async (_label, overrides, expected) => {
      const step = newStep();

      await runStep(step, inputs(overrides));

      const request = create.mock.calls[0][0];
      expect(request).toMatchObject(expected);
      expect(request).not.toHaveProperty('defaultBranchNaming');
    },
  );

  it('passes repair and restoreClaudeMd through and asks for setup unless skipped', async () => {
    const step = newStep();

    const pending = runStep(
      step,
      inputs({ repair: true, restoreClaudeMd: false, setup: 'run' }),
    );
    await waitFor(() => projectRuns.length === 1, 'setup launch');
    observerOf(projectRuns[0]).onResolved?.(false);
    await pending;

    expect(create.mock.calls[0][0]).toMatchObject({
      repairWorkspaceRoot: true,
      restoreClaudeMd: false,
      startPostCreateSetup: true,
    });
  });

  it('broadcasts the worktree update to the main window', async () => {
    const step = newStep();
    const window = new BrowserWindow();

    await runStep(step, inputs(), { getWindow: () => window });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      window,
      IPC_CHANNELS.workspaceWorktreesUpdated,
      { workspaceId: PROJECT },
    );
    expect(sendAll).not.toHaveBeenCalled();
  });

  it('broadcasts the worktree update to every window when none started the run', async () => {
    const step = newStep();

    await runStep(step, inputs());

    expect(send).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.workspaceWorktreesUpdated,
      { workspaceId: PROJECT },
    );
    expect(sendAll).toHaveBeenCalledTimes(1);
    expect(sendAll).toHaveBeenCalledWith(
      IPC_CHANNELS.workspaceWorktreesUpdated,
      { workspaceId: PROJECT },
    );
  });

  it('runs the owner check after project resolution and stops every effect on refusal', async () => {
    const step = newStep();
    assertOwner.mockRejectedValue(
      new PipelineHostRefusal(
        'not_found',
        "Project `proj-1` isn't available to this pipeline",
      ),
    );

    await expect(
      runStep(step, inputs({ baseTaskId: 'base-task', setup: 'run_and_wait' })),
    ).rejects.toMatchObject({
      failureReason: 'not_found',
      message: "Project `proj-1` isn't available to this pipeline",
    });

    expect(assertOwner).toHaveBeenCalledWith(step.caller, {
      kind: 'project',
      projectId: PROJECT,
      workspaceType: 'single-repo',
    });
    expect(readConfig.mock.invocationCallOrder[0]).toBeLessThan(
      assertOwner.mock.invocationCallOrder[0],
    );
    expect(readWorktrees).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(hasJournal(step)).toBe(false);
    expect(existsSync(step.artifactsDir)).toBe(false);
  });

  it('refuses a cowork project with unsupported_action after the owner check', async () => {
    const step = newStep();
    readConfig.mockResolvedValue(configDetail('cowork'));

    await expect(runStep(step, inputs())).rejects.toMatchObject({
      failureReason: 'unsupported_action',
      message:
        "Project `proj-1` doesn't support worktrees. Use create-project-entry.",
    });

    expect(assertOwner).toHaveBeenCalledWith(step.caller, {
      kind: 'project',
      projectId: PROJECT,
      workspaceType: 'cowork',
    });
    expect(create).not.toHaveBeenCalled();
    expect(hasJournal(step)).toBe(false);
  });

  it('hides a cross-owner cowork project as not_found', async () => {
    const step = newStep();
    readConfig.mockResolvedValue(configDetail('cowork'));
    assertOwner.mockRejectedValue(
      new PipelineHostRefusal('not_found', 'hidden'),
    );

    await expect(
      runStep(step, inputs({ baseTaskId: 'base-task' })),
    ).rejects.toMatchObject({ failureReason: 'not_found', message: 'hidden' });

    expect(readWorktrees).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses a base task the project does not list', async () => {
    const step = newStep();
    readWorktrees.mockResolvedValue({
      worktrees: [worktreeRow('other')],
      authority: 'ok',
    });

    await expect(
      runStep(step, inputs({ baseTaskId: 'b' })),
    ).rejects.toMatchObject({
      failureReason: 'not_found',
      message: "Task `b` isn't in project `proj-1`",
    });

    expect(readWorktrees).toHaveBeenCalledWith(PROJECT, {
      persistRemovalCleanup: false,
    });
    expect(create).not.toHaveBeenCalled();
    expect(hasJournal(step)).toBe(false);
  });

  it.each(['partial', 'unreadable'] as const)(
    'treats a %s worktree list as an error, not a missing base task',
    async (authority) => {
      const step = newStep();
      readWorktrees.mockResolvedValue({
        worktrees: [worktreeRow('other')],
        authority,
      });

      const failure = runStep(step, inputs({ baseTaskId: 'b' }));

      await expect(failure).rejects.toThrow(
        "Worktrees for project `proj-1` couldn't be fully read",
      );
      await expect(failure).rejects.not.toBeInstanceOf(PipelineHostRefusal);
      expect(create).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      'a refused selection',
      (): Error =>
        new WorktreeCreationRefusedError(
          'branch-reserved',
          'Branch `x` is already in use',
        ),
      'validation_failed',
      'Branch `x` is already in use',
    ],
    [
      'an invalid identifier',
      (): Error => new IdentifierValidationError('Invalid worktreeId'),
      'validation_failed',
      'Invalid worktreeId',
    ],
    [
      'a reused key',
      (): Error => new W5CommitRefusedError('key-reused', 'key reused'),
      'authorization_conflict',
      'This step already ran with different inputs',
    ],
    [
      'an in-progress key',
      (): Error => new W5CommitRefusedError('in-progress', 'busy'),
      'target_not_ready',
      "Task creation in project `proj-1` can't continue right now; check the project and try again",
    ],
    [
      'an expired outcome',
      (): Error => new W5CommitRefusedError('outcome-expired', 'expired'),
      'target_not_ready',
      "Task creation in project `proj-1` can't continue right now; check the project and try again",
    ],
    [
      'a recovery-required key',
      (): Error => new W5CommitRefusedError('recovery-required', 'recover'),
      'target_not_ready',
      "Task creation in project `proj-1` can't continue right now; check the project and try again",
    ],
  ])(
    'maps %s to a typed failure with the project ids',
    async (_label, makeError, reason, message) => {
      const step = newStep();
      fakeCreation({ error: makeError() });

      const result = await runStep(step, inputs());

      expect(result).toEqual({
        status: 'failure',
        failureReason: reason,
        error: message,
        outputs: projectOnlyOutputs(),
      });
      expect(send).not.toHaveBeenCalled();
      const record = await journalOf(step);
      expect(record.phase).toBe('finalized');
      expect(record.result).toEqual(result);
    },
  );

  it('rethrows an unexpected creation error and leaves the journal at creating', async () => {
    const step = newStep();
    fakeCreation({
      error: new W5CommitRefusedError('revision-conflict', 'moved'),
    });

    await expect(runStep(step, inputs())).rejects.toThrow('moved');

    const record = await journalOf(step);
    expect(record.phase).toBe('creating');
    expect(record.result).toBeUndefined();
  });

  it('returns target_not_ready for a needs-repair root without setup or grouping', async () => {
    const step = newStep();
    readConfig.mockResolvedValue(configDetail('multi-repo', REPOS));
    fakeCreation({ outcome: needsRepairOutcome() });

    const result = await runStep(
      step,
      inputs({ setup: 'run_and_wait', group: 'Reviews' }),
    );

    expect(result).toEqual({
      status: 'failure',
      failureReason: 'target_not_ready',
      error:
        'Project `proj-1` needs its workspace root repaired; run again with repair: true or repair it in the app',
      outputs: {
        ...emptyCreateWorktreeOutputs(),
        project_id: PROJECT,
        workspace_id: PROJECT,
        task_id: TASK,
        worktree_id: TASK,
        branch_name: BRANCH,
      },
    });
    expect(runWorkspace).not.toHaveBeenCalled();
    expect(runProject).not.toHaveBeenCalled();
    expect(groups.assignItemToNamedGroup).not.toHaveBeenCalled();
    expect((await journalOf(step)).phase).toBe('finalized');
  });
});

describe('runCreateWorktreeHostAction grouping', () => {
  it('assigns the new worktree to the named group', async () => {
    const step = newStep();

    const result = await runStep(step, inputs({ group: 'Reviews' }));

    expect(groups.assignItemToNamedGroup).toHaveBeenCalledWith({
      scope: { workspaceLocalId: PROJECT },
      itemId: TASK,
      name: 'Reviews',
    });
    const groupOutputs = {
      group_id: 'grp-1',
      group_created: 'true',
      grouped: 'true',
      not_grouped_reason: '',
    };
    expect(result).toEqual({
      status: 'success',
      outputs: createdOutputs({ setup_state: 'skipped', ...groupOutputs }),
    });
    expect((await journalOf(step)).group).toEqual(groupOutputs);
  });

  it.each(['group_limit_reached', 'item_not_groupable'] as const)(
    'succeeds ungrouped when the sidebar refuses with %s',
    async (code) => {
      const step = newStep();
      groups.assignItemToNamedGroup.mockRejectedValue(
        new SidebarItemGroupRefusalError(code, 'refused'),
      );

      const result = await runStep(step, inputs({ group: 'Reviews' }));

      expect(result).toEqual({
        status: 'success',
        outputs: createdOutputs({
          setup_state: 'skipped',
          group_id: '',
          group_created: 'false',
          grouped: 'false',
          not_grouped_reason: code,
        }),
      });
      expect(logWarn).not.toHaveBeenCalled();
    },
  );

  it('reports group_assignment_failed for an unexpected error without logging the name', async () => {
    const step = newStep();
    groups.assignItemToNamedGroup.mockRejectedValue(
      new Error('Secret Group could not be saved'),
    );

    const result = await runStep(step, inputs({ group: 'Secret Group' }));

    expect(result.status).toBe('success');
    expect(result.outputs).toMatchObject({
      grouped: 'false',
      group_created: 'false',
      group_id: '',
      not_grouped_reason: 'group_assignment_failed',
    });
    expect(logWarn).toHaveBeenCalledWith(
      '[pipeline-host] create-worktree group assignment failed',
      { errorType: 'Error' },
    );
    expect(allLogCalls()).not.toContain('Secret Group');
  });

  it('groups after launching setup and before setup finishes', async () => {
    const step = newStep();

    const pending = runStep(
      step,
      inputs({ setup: 'run_and_wait', group: 'Reviews' }),
    );
    await waitFor(
      () => groups.assignItemToNamedGroup.mock.calls.length === 1,
      'group assignment',
    );

    expect(runProject).toHaveBeenCalledTimes(1);
    expect(runProject.mock.invocationCallOrder[0]).toBeLessThan(
      groups.assignItemToNamedGroup.mock.invocationCallOrder[0],
    );
    observerOf(projectRuns[0]).onResolved?.(false);
    projectRuns[0].result.resolve({ status: 'skipped' });
    const result = await pending;
    expect(result.outputs).toMatchObject({
      grouped: 'true',
      setup_state: 'none_configured',
    });
  });
});

describe('runCreateWorktreeHostAction setup', () => {
  it('returns started in run mode once setup resolves, without waiting for it', async () => {
    const step = newStep();

    const pending = runStep(step, inputs({ setup: 'run' }));
    await waitFor(() => projectRuns.length === 1, 'setup launch');
    const run = projectRuns[0];
    expect(run.params).toMatchObject({
      projectId: PROJECT,
      worktreeId: TASK,
      project: { repoPath: REPO_PATH },
    });
    expect(run.params).not.toHaveProperty('signal');
    await waitFor(
      () => serviceSetups[0]?.state === 'launched',
      'service launch',
    );
    const ref = scriptRef('run-1');
    observerOf(run).onResolved?.(true);
    void observerOf(run).onScriptStarted?.(ref);

    const result = await pending;

    expect(result).toEqual({
      status: 'success',
      outputs: createdOutputs({
        setup_state: 'started',
        setup_results_file: artifact(step, SETUP_RESULTS_FILE),
      }),
    });
    expect(readResultsFile(step)).toMatchObject({
      setup_state: 'started',
      scripts: [
        { run_id: 'run-1', state: 'running', exit_code: null, log_file: '' },
      ],
    });
    const record = await journalOf(step);
    expect(record.phase).toBe('finalized');
    expect(record.setupConfigured).toBe(true);
    expect(record.scripts).toEqual([
      {
        scriptKey: 'setup',
        runId: 'run-1',
        target: 'project',
        lifecycle: 'setup',
        logProjectId: PROJECT,
      },
    ]);

    // The setup keeps running; its later events write nothing here.
    const before = artifactListing(step);
    void observerOf(run).onScriptCompleted?.(finished(ref, 'succeeded', 0));
    run.result.resolve({
      status: 'completed',
      script: finished(ref, 'succeeded', 0),
    });
    await quiesce();
    expect(artifactListing(step)).toEqual(before);
    expect(snapshot).not.toHaveBeenCalled();
  });

  it('returns none_configured in run mode when no script is configured', async () => {
    const step = newStep();

    const pending = runStep(step, inputs({ setup: 'run' }));
    await waitFor(() => projectRuns.length === 1, 'setup launch');
    observerOf(projectRuns[0]).onResolved?.(false);

    const result = await pending;

    expect(result).toEqual({
      status: 'success',
      outputs: createdOutputs({ setup_state: 'none_configured' }),
    });
    expect(existsSync(artifact(step, SETUP_RESULTS_FILE))).toBe(false);
    const before = artifactListing(step);
    projectRuns[0].result.resolve({ status: 'skipped' });
    await quiesce();
    expect(artifactListing(step)).toEqual(before);
  });

  it('waits for a successful single-repo setup and copies its log', async () => {
    const step = newStep();

    const pending = runStep(step, inputs({ setup: 'run_and_wait' }));
    await waitFor(() => projectRuns.length === 1, 'setup launch');
    const run = projectRuns[0];
    const observer = observerOf(run);
    const ref = scriptRef('run-1');
    observer.onResolved?.(true);
    void observer.onScriptStarted?.(ref);
    const done = finished(ref, 'succeeded', 0);
    void observer.onScriptCompleted?.(done);
    run.result.resolve({ status: 'completed', script: done });

    const result = await pending;

    expect(result).toEqual({
      status: 'success',
      outputs: createdOutputs({
        setup_state: 'succeeded',
        setup_exit_code: '0',
        setup_log_file: artifact(step, 'setup.log'),
        setup_results_file: artifact(step, SETUP_RESULTS_FILE),
      }),
    });
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(snapshot).toHaveBeenCalledWith({
      ref: ref.logRef,
      targetPath: artifact(step, 'setup.log'),
    });
    expect(readFileSync(artifact(step, 'setup.log'), 'utf8')).toBe(
      'log of run-1\n',
    );
    expect(readResultsFile(step)).toEqual({
      version: 1,
      project_id: PROJECT,
      task_id: TASK,
      setup_state: 'succeeded',
      scripts: [
        {
          script_key: 'setup',
          run_id: 'run-1',
          target: 'project',
          lifecycle: 'setup',
          repo_id: null,
          state: 'succeeded',
          exit_code: 0,
          timed_out: false,
          log_file: 'setup.log',
        },
      ],
    });
    const record = await journalOf(step);
    expect(record).toMatchObject({
      phase: 'finalized',
      setupConfigured: true,
      setupSettled: true,
      scripts: [{ runId: 'run-1', logFile: 'setup.log' }],
      result,
    });
  });

  it('keeps the worktree outputs when setup fails', async () => {
    const step = newStep();

    const pending = runStep(
      step,
      inputs({ setup: 'run_and_wait', group: 'Reviews' }),
    );
    await waitFor(() => projectRuns.length === 1, 'setup launch');
    const observer = observerOf(projectRuns[0]);
    const ref = scriptRef('run-1');
    observer.onResolved?.(true);
    void observer.onScriptStarted?.(ref);
    const done = finished(ref, 'failed', 3);
    void observer.onScriptCompleted?.(done);
    projectRuns[0].result.resolve({ status: 'failed', script: done });

    const result = await pending;

    expect(result).toEqual({
      status: 'failure',
      failureReason: 'setup_failed',
      error: 'Setup for task `task-1` failed; check its setup log',
      outputs: createdOutputs({
        group_id: 'grp-1',
        group_created: 'true',
        grouped: 'true',
        not_grouped_reason: '',
        setup_state: 'failed',
        setup_exit_code: '3',
        setup_log_file: artifact(step, 'setup.log'),
        setup_results_file: artifact(step, SETUP_RESULTS_FILE),
      }),
    });
  });

  it('reports a script timeout as setup_timed_out', async () => {
    const step = newStep();

    const pending = runStep(step, inputs({ setup: 'run_and_wait' }));
    await waitFor(() => projectRuns.length === 1, 'setup launch');
    const observer = observerOf(projectRuns[0]);
    const ref = scriptRef('run-1');
    observer.onResolved?.(true);
    void observer.onScriptStarted?.(ref);
    const done = finished(ref, 'timed_out', null, true);
    void observer.onScriptCompleted?.(done);
    projectRuns[0].result.resolve({ status: 'failed', script: done });

    const result = await pending;

    expect(result).toEqual({
      status: 'failure',
      failureReason: 'setup_timed_out',
      error: 'Setup for task `task-1` timed out; check its setup log',
      outputs: createdOutputs({
        setup_state: 'timed_out',
        setup_exit_code: '',
        setup_log_file: artifact(step, 'setup.log'),
        setup_results_file: artifact(step, SETUP_RESULTS_FILE),
      }),
    });
  });

  it('folds in script results the observer missed', async () => {
    const step = newStep();

    const pending = runStep(step, inputs({ setup: 'run_and_wait' }));
    await waitFor(() => projectRuns.length === 1, 'setup launch');
    const ref = scriptRef('run-1');
    projectRuns[0].result.resolve({
      status: 'completed',
      script: finished(ref, 'succeeded', 0),
    });

    const result = await pending;

    expect(result.outputs).toMatchObject({
      setup_state: 'succeeded',
      setup_exit_code: '0',
      setup_log_file: artifact(step, 'setup.log'),
    });
    expect(existsSync(artifact(step, 'setup.log'))).toBe(true);
  });

  it('reports a setup runner that rejects as setup_failed', async () => {
    const step = newStep();

    const pending = runStep(step, inputs({ setup: 'run_and_wait' }));
    await waitFor(() => projectRuns.length === 1, 'setup launch');
    projectRuns[0].result.reject(new Error('spawn failed'));

    const result = await pending;

    expect(result).toEqual({
      status: 'failure',
      failureReason: 'setup_failed',
      error: "Setup for task `task-1` couldn't start",
      outputs: createdOutputs({ setup_state: 'failed' }),
    });
    expect(logWarn).toHaveBeenCalledWith(
      '[pipeline-host] create-worktree setup failed',
      { errorType: 'Error' },
    );
  });

  it('lists multi-repo scripts in lifecycle and configured repo order', async () => {
    const step = newStep();
    readConfig.mockResolvedValue(configDetail('multi-repo', REPOS));
    fakeCreation({ kind: 'multi-repo' });

    const pending = runStep(step, inputs({ setup: 'run_and_wait' }));
    await waitFor(() => workspaceRuns.length === 1, 'setup launch');
    const run = workspaceRuns[0];
    expect(run.params).toMatchObject({
      workspaceId: PROJECT,
      worktreeId: TASK,
      workspaceRootPath: MULTI_PATH,
      repos: REPOS,
    });
    const observer = observerOf(run);
    const before = scriptRef('run-before', {
      lifecycle: 'before-setup',
      target: 'workspace-root',
    });
    const repoB = scriptRef('run-b', {
      target: 'workspace-repo',
      repoId: 'repo-b',
    });
    const repoA = scriptRef('run-a', {
      target: 'workspace-repo',
      repoId: 'repo-a',
    });
    const after = scriptRef('run-after', {
      lifecycle: 'after-setup',
      target: 'workspace-root',
    });
    observer.onResolved?.(true);
    void observer.onScriptStarted?.(before);
    const beforeDone = finished(before, 'succeeded', 0);
    void observer.onScriptCompleted?.(beforeDone);
    // Repo B starts and finishes first; repo A is configured first.
    void observer.onScriptStarted?.(repoB);
    void observer.onScriptStarted?.(repoA);
    const repoBDone = finished(repoB, 'succeeded', 0);
    void observer.onScriptCompleted?.(repoBDone);
    const repoADone = finished(repoA, 'failed', 2);
    void observer.onScriptCompleted?.(repoADone);
    void observer.onScriptStarted?.(after);
    const afterDone = finished(after, 'succeeded', 0);
    void observer.onScriptCompleted?.(afterDone);
    run.result.resolve({
      status: 'failed',
      scripts: [beforeDone, repoADone, repoBDone, afterDone],
    });

    const result = await pending;

    expect(result).toEqual({
      status: 'failure',
      failureReason: 'setup_failed',
      error: 'Setup for task `task-1` failed; check its setup log',
      outputs: createdOutputs(
        {
          setup_state: 'failed',
          setup_exit_code: '2',
          setup_log_file: artifact(step, '03-setup-repo-a.log'),
          setup_results_file: artifact(step, SETUP_RESULTS_FILE),
        },
        MULTI_PATH,
      ),
    });
    expect(readResultsFile(step)).toMatchObject({
      setup_state: 'failed',
      scripts: [
        {
          run_id: 'run-before',
          repo_id: null,
          state: 'succeeded',
          log_file: '01-before-setup.log',
        },
        {
          run_id: 'run-a',
          repo_id: 'repo-a',
          state: 'failed',
          exit_code: 2,
          log_file: '03-setup-repo-a.log',
        },
        {
          run_id: 'run-b',
          repo_id: 'repo-b',
          state: 'succeeded',
          exit_code: 0,
          log_file: '02-setup-repo-b.log',
        },
        {
          run_id: 'run-after',
          repo_id: null,
          state: 'succeeded',
          log_file: '04-after-setup.log',
        },
      ],
    });
    for (const name of [
      '01-before-setup.log',
      '02-setup-repo-b.log',
      '03-setup-repo-a.log',
      '04-after-setup.log',
    ]) {
      expect(existsSync(artifact(step, name))).toBe(true);
    }
  });

  it('names the first failure in configured repo order, not start order', async () => {
    const step = newStep();
    readConfig.mockResolvedValue(configDetail('multi-repo', REPOS));
    fakeCreation({ kind: 'multi-repo' });

    const pending = runStep(step, inputs({ setup: 'run_and_wait' }));
    await waitFor(() => workspaceRuns.length === 1, 'setup launch');
    const observer = observerOf(workspaceRuns[0]);
    const repoB = scriptRef('run-b', {
      target: 'workspace-repo',
      repoId: 'repo-b',
    });
    const repoA = scriptRef('run-a', {
      target: 'workspace-repo',
      repoId: 'repo-a',
    });
    observer.onResolved?.(true);
    void observer.onScriptStarted?.(repoB);
    void observer.onScriptStarted?.(repoA);
    const repoBDone = finished(repoB, 'failed', 4);
    const repoADone = finished(repoA, 'failed', 2);
    void observer.onScriptCompleted?.(repoBDone);
    void observer.onScriptCompleted?.(repoADone);
    workspaceRuns[0].result.resolve({
      status: 'failed',
      scripts: [repoADone, repoBDone],
    });

    const result = await pending;

    expect(result.outputs).toMatchObject({
      setup_exit_code: '2',
      setup_log_file: artifact(step, '02-setup-repo-a.log'),
    });
  });

  it('leaves the multi-repo setup log empty on success', async () => {
    const step = newStep();
    readConfig.mockResolvedValue(configDetail('multi-repo', REPOS));
    fakeCreation({ kind: 'multi-repo' });

    const pending = runStep(step, inputs({ setup: 'run_and_wait' }));
    await waitFor(() => workspaceRuns.length === 1, 'setup launch');
    const observer = observerOf(workspaceRuns[0]);
    const repoA = scriptRef('run-a', {
      target: 'workspace-repo',
      repoId: 'repo-a',
    });
    observer.onResolved?.(true);
    void observer.onScriptStarted?.(repoA);
    const repoADone = finished(repoA, 'succeeded', 0);
    void observer.onScriptCompleted?.(repoADone);
    workspaceRuns[0].result.resolve({
      status: 'completed',
      scripts: [repoADone],
    });

    const result = await pending;

    expect(result).toEqual({
      status: 'success',
      outputs: createdOutputs(
        {
          setup_state: 'succeeded',
          setup_exit_code: '0',
          setup_log_file: '',
          setup_results_file: artifact(step, SETUP_RESULTS_FILE),
        },
        MULTI_PATH,
      ),
    });
    expect(existsSync(artifact(step, '01-setup-repo-a.log'))).toBe(true);
  });

  it('keeps the verdict and an empty log path when the log copy fails', async () => {
    const step = newStep();
    snapshot.mockResolvedValue({
      status: 'error',
      message: 'script log copy failed: EBUSY',
    });

    const pending = runStep(step, inputs({ setup: 'run_and_wait' }));
    await waitFor(() => projectRuns.length === 1, 'setup launch');
    const observer = observerOf(projectRuns[0]);
    const ref = scriptRef('run-1');
    observer.onResolved?.(true);
    void observer.onScriptStarted?.(ref);
    const done = finished(ref, 'failed', 3);
    void observer.onScriptCompleted?.(done);
    projectRuns[0].result.resolve({ status: 'failed', script: done });

    const result = await pending;

    expect(result).toMatchObject({
      status: 'failure',
      failureReason: 'setup_failed',
      outputs: {
        setup_state: 'failed',
        setup_exit_code: '3',
        setup_log_file: '',
        setup_results_file: artifact(step, SETUP_RESULTS_FILE),
      },
    });
    expect(readResultsFile(step)).toMatchObject({
      scripts: [{ run_id: 'run-1', log_file: '' }],
    });
    expect(logWarn).toHaveBeenCalledWith(
      '[pipeline-host] create-worktree setup log not saved',
      { status: 'error', message: 'script log copy failed: EBUSY' },
    );
    expect(existsSync(artifact(step, 'setup.log'))).toBe(false);
  });
});

describe('runCreateWorktreeHostAction replay', () => {
  it('returns the stored result for the same key and re-runs the owner check', async () => {
    const step = newStep();
    const stepInputs = inputs({ group: 'Reviews' });

    const first = await runStep(step, stepInputs);
    const stored = artifactListing(step);
    const second = await runStep(step, stepInputs);

    expect(second).toEqual(first);
    expect(create).toHaveBeenCalledTimes(1);
    expect(groups.assignItemToNamedGroup).toHaveBeenCalledTimes(1);
    expect(assertOwner).toHaveBeenCalledTimes(2);
    expect(artifactListing(step)).toEqual(stored);

    assertOwner.mockRejectedValue(
      new PipelineHostRefusal('not_found', 'hidden'),
    );
    await expect(runStep(step, stepInputs)).rejects.toMatchObject({
      failureReason: 'not_found',
      message: 'hidden',
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('returns identifiers for a replayed skip creation with no journal', async () => {
    const step = newStep();
    fakeCreation({ replay: true });

    const result = await runStep(step, inputs());

    expect(result).toEqual({
      status: 'success',
      outputs: createdOutputs({ setup_state: 'skipped' }),
    });
  });

  it('fails a replayed setup creation with no journal as interrupted and skips grouping', async () => {
    const step = newStep();
    fakeCreation({ replay: true });

    const result = await runStep(
      step,
      inputs({ setup: 'run_and_wait', group: 'Reviews' }),
    );

    expect(result).toEqual({
      status: 'failure',
      failureReason: 'setup_failed',
      error: 'Setup for task `task-1` was interrupted; check its setup log',
      outputs: createdOutputs({
        setup_state: 'failed',
        not_grouped_reason: 'replay_uncertain',
      }),
    });
    expect(groups.assignItemToNamedGroup).not.toHaveBeenCalled();
    expect(runProject).not.toHaveBeenCalled();
  });

  it('resumes setup and grouping when a W5 replay finds the journal still at creating', async () => {
    const step = newStep();
    const stepInputs = inputs({ setup: 'run_and_wait', group: 'Reviews' });
    await writeAttemptRecord(
      step.artifactsDir,
      newAttemptRecord(stepInputs, step.caller),
    );
    fakeCreation({ replay: true });

    const pending = runStep(step, stepInputs);
    await waitFor(() => projectRuns.length === 1, 'setup launch');
    expect(projectRuns[0].params).toMatchObject({
      projectId: PROJECT,
      worktreeId: TASK,
      project: { repoPath: REPO_PATH },
    });
    const observer = observerOf(projectRuns[0]);
    const ref = scriptRef('run-1');
    observer.onResolved?.(true);
    void observer.onScriptStarted?.(ref);
    const done = finished(ref, 'succeeded', 0);
    void observer.onScriptCompleted?.(done);
    projectRuns[0].result.resolve({ status: 'completed', script: done });

    const result = await pending;

    expect(result).toEqual({
      status: 'success',
      outputs: createdOutputs({
        group_id: 'grp-1',
        group_created: 'true',
        grouped: 'true',
        setup_state: 'succeeded',
        setup_exit_code: '0',
        setup_log_file: artifact(step, 'setup.log'),
        setup_results_file: artifact(step, SETUP_RESULTS_FILE),
      }),
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(groups.assignItemToNamedGroup).toHaveBeenCalledTimes(1);
  });

  it('refuses different inputs under the same key without creating', async () => {
    const step = newStep();
    await runStep(step, inputs());
    const stored = artifactListing(step);

    const result = await runStep(step, inputs({ group: 'Reviews' }));

    expect(result).toEqual({
      status: 'failure',
      failureReason: 'authorization_conflict',
      error: 'This step already ran with different inputs',
      outputs: projectOnlyOutputs(),
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(artifactListing(step)).toEqual(stored);
  });

  it('refuses different inputs while the same key is still running', async () => {
    const step = newStep();
    const gate = deferred<void>();
    fakeCreation({ gate: gate.promise });

    const first = runStep(step, inputs());
    await expect(
      runStep(step, inputs({ group: 'Reviews' })),
    ).rejects.toMatchObject({ failureReason: 'authorization_conflict' });
    gate.resolve();
    await expect(first).resolves.toMatchObject({ status: 'success' });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('resumes a created journal by launching setup without creating again', async () => {
    const step = newStep();
    const stepInputs = inputs({ setup: 'run_and_wait' });
    const record = newAttemptRecord(stepInputs, step.caller);
    record.phase = 'created';
    record.worktree = {
      taskId: TASK,
      branchName: BRANCH,
      createdAt: CREATED_AT,
      path: SINGLE_PATH,
      workspaceKind: 'single-repo',
    };
    await writeAttemptRecord(step.artifactsDir, record);

    const pending = runStep(step, stepInputs);
    await waitFor(() => projectRuns.length === 1, 'setup launch');
    expect(projectRuns[0].params).toMatchObject({
      projectId: PROJECT,
      worktreeId: TASK,
      project: { repoPath: REPO_PATH },
    });
    const observer = observerOf(projectRuns[0]);
    const ref = scriptRef('run-1');
    observer.onResolved?.(true);
    void observer.onScriptStarted?.(ref);
    const done = finished(ref, 'succeeded', 0);
    void observer.onScriptCompleted?.(done);
    projectRuns[0].result.resolve({ status: 'completed', script: done });

    const result = await pending;

    expect(create).not.toHaveBeenCalled();
    expect(result.outputs).toMatchObject({
      task_id: TASK,
      setup_state: 'succeeded',
      setup_exit_code: '0',
    });
  });

  function createdRecord(
    stepInputs: CreateWorktreeInputs,
    step: Step,
  ): AttemptRecord {
    const record = newAttemptRecord(stepInputs, step.caller);
    record.phase = 'created';
    record.worktree = {
      taskId: TASK,
      branchName: BRANCH,
      createdAt: CREATED_AT,
      path: SINGLE_PATH,
      workspaceKind: 'single-repo',
    };
    return record;
  }

  const replacedOrRemoved = [
    {
      label: 'replaced',
      rows: [{ ...worktreeRow(TASK), createdAt: '2026-10-22T00:00:00.000Z' }],
    },
    { label: 'removed', rows: [worktreeRow('base-task')] },
  ];

  it.each(replacedOrRemoved)(
    'refuses to resume a created journal whose task was $label',
    async ({ rows }) => {
      const step = newStep();
      const stepInputs = inputs({ setup: 'run_and_wait', group: 'Reviews' });
      await writeAttemptRecord(
        step.artifactsDir,
        createdRecord(stepInputs, step),
      );
      readWorktrees.mockResolvedValue({ worktrees: rows, authority: 'ok' });

      const result = await runStep(step, stepInputs);

      expect(result).toEqual({
        status: 'failure',
        failureReason: 'target_not_ready',
        error:
          'Task `task-1` in project `proj-1` was removed or replaced after this step created it; check the project',
        outputs: createdOutputs(),
      });
      expect(create).not.toHaveBeenCalled();
      expect(runProject).not.toHaveBeenCalled();
      expect(groups.assignItemToNamedGroup).not.toHaveBeenCalled();
      expect((await journalOf(step)).phase).toBe('finalized');
    },
  );

  it.each(replacedOrRemoved)(
    'refuses to reconcile a recorded setup whose task was $label',
    async ({ rows }) => {
      const step = newStep();
      const stepInputs = inputs({ setup: 'run', group: 'Reviews' });
      const record = createdRecord(stepInputs, step);
      record.phase = 'setup_running';
      record.setupConfigured = true;
      await writeAttemptRecord(step.artifactsDir, record);
      readWorktrees.mockResolvedValue({ worktrees: rows, authority: 'ok' });

      const result = await runStep(step, stepInputs);

      expect(result).toMatchObject({
        status: 'failure',
        failureReason: 'target_not_ready',
        outputs: createdOutputs(),
      });
      expect(groups.assignItemToNamedGroup).not.toHaveBeenCalled();
      expect((await journalOf(step)).phase).toBe('finalized');
    },
  );

  it.each(replacedOrRemoved)(
    'refuses to resume a W5 replay at creating whose task was $label',
    async ({ rows }) => {
      const step = newStep();
      const stepInputs = inputs({ setup: 'run_and_wait', group: 'Reviews' });
      await writeAttemptRecord(
        step.artifactsDir,
        newAttemptRecord(stepInputs, step.caller),
      );
      readWorktrees.mockResolvedValue({ worktrees: rows, authority: 'ok' });
      fakeCreation({ replay: true });

      const result = await runStep(step, stepInputs);

      expect(result).toMatchObject({
        status: 'failure',
        failureReason: 'target_not_ready',
        outputs: createdOutputs(),
      });
      expect(runProject).not.toHaveBeenCalled();
      expect(groups.assignItemToNamedGroup).not.toHaveBeenCalled();
      expect((await journalOf(step)).phase).toBe('finalized');
    },
  );

  function settledSetupRecord(
    stepInputs: CreateWorktreeInputs,
    step: Step,
  ): AttemptRecord {
    const record = newAttemptRecord(stepInputs, step.caller);
    record.phase = 'setup_running';
    record.worktree = {
      taskId: TASK,
      branchName: BRANCH,
      createdAt: CREATED_AT,
      path: SINGLE_PATH,
      workspaceKind: 'single-repo',
    };
    record.setupConfigured = true;
    record.setupSettled = true;
    record.group = {
      group_id: 'grp-1',
      group_created: 'true',
      grouped: 'true',
      not_grouped_reason: '',
    };
    record.scripts = [
      {
        scriptKey: 'setup',
        runId: 'run-1',
        target: 'project',
        lifecycle: 'setup',
        logProjectId: PROJECT,
        logFile: 'setup.log',
      },
    ];
    return record;
  }

  it('reuses a recorded setup whose canonical run completed', async () => {
    const step = newStep();
    const stepInputs = inputs({ setup: 'run_and_wait', group: 'Reviews' });
    await writeAttemptRecord(
      step.artifactsDir,
      settledSetupRecord(stepInputs, step),
    );
    readMeta.mockResolvedValue(runMeta('run-1', 'success', 0));

    const result = await runStep(step, stepInputs);

    expect(readMeta).toHaveBeenCalledWith({
      projectId: PROJECT,
      worktreeId: TASK,
      scriptKey: 'setup',
      tailLines: 0,
    });
    expect(result).toEqual({
      status: 'success',
      outputs: createdOutputs({
        group_id: 'grp-1',
        group_created: 'true',
        grouped: 'true',
        setup_state: 'succeeded',
        setup_exit_code: '0',
        setup_log_file: artifact(step, 'setup.log'),
        setup_results_file: artifact(step, SETUP_RESULTS_FILE),
      }),
    });
    expect(create).not.toHaveBeenCalled();
    expect(runProject).not.toHaveBeenCalled();
    expect(groups.assignItemToNamedGroup).not.toHaveBeenCalled();
  });

  it('keeps a runner failure with succeeded scripts failed on replay after a crash', async () => {
    const step = newStep();
    const stepInputs = inputs({ setup: 'run_and_wait' });
    setBeforeJournalWriteForTests((record) => {
      if (record.phase === 'finalized')
        throw new Error('crash before finalized');
    });

    const pending = runStep(step, stepInputs);
    await waitFor(() => projectRuns.length === 1, 'setup launch');
    const observer = observerOf(projectRuns[0]);
    const ref = scriptRef('run-1');
    observer.onResolved?.(true);
    void observer.onScriptStarted?.(ref);
    const done = finished(ref, 'succeeded', 0);
    void observer.onScriptCompleted?.(done);
    projectRuns[0].result.resolve({
      status: 'failed',
      detail: 'post-setup error',
      script: done,
    });
    await expect(pending).rejects.toThrow('crash before finalized');
    setBeforeJournalWriteForTests(undefined);
    expect(await journalOf(step)).toMatchObject({
      setupSettled: true,
      setupRunFailed: true,
    });
    readMeta.mockResolvedValue(runMeta('run-1', 'success', 0));

    const replay = await runStep(step, stepInputs);

    expect(replay).toMatchObject({
      status: 'failure',
      failureReason: 'setup_failed',
      outputs: { setup_state: 'failed' },
    });
    expect(runProject).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['adopts the copy already on disk', true],
    ['copies the canonical log again', false],
  ])(
    'when a crash lost a settled setup log copy name, replay %s',
    async (_label, copiedBeforeCrash) => {
      const step = newStep();
      const stepInputs = inputs({ setup: 'run_and_wait' });
      setBeforeJournalWriteForTests((record) => {
        if (
          record.setupSettled &&
          record.scripts.some((script) => script.logFile !== undefined)
        )
          throw new Error('crash before log copies were journaled');
      });

      const pending = runStep(step, stepInputs);
      await waitFor(() => projectRuns.length === 1, 'setup launch');
      const observer = observerOf(projectRuns[0]);
      const ref = scriptRef('run-1');
      observer.onResolved?.(true);
      void observer.onScriptStarted?.(ref);
      const done = finished(ref, 'succeeded', 0);
      void observer.onScriptCompleted?.(done);
      projectRuns[0].result.resolve({ status: 'completed', script: done });
      await expect(pending).rejects.toThrow(
        'crash before log copies were journaled',
      );
      setBeforeJournalWriteForTests(undefined);
      const crashed = await journalOf(step);
      expect(crashed.setupSettled).toBe(true);
      expect(crashed.scripts.map((script) => script.logFile)).toEqual([
        undefined,
      ]);
      expect(existsSync(artifact(step, 'setup.log'))).toBe(true);
      if (!copiedBeforeCrash) await rm(artifact(step, 'setup.log'));
      readMeta.mockResolvedValue(runMeta('run-1', 'success', 0));
      snapshot.mockClear();

      const replay = await runStep(step, stepInputs);

      expect(snapshot).toHaveBeenCalledTimes(copiedBeforeCrash ? 0 : 1);
      expect(replay).toEqual({
        status: 'success',
        outputs: createdOutputs({
          setup_state: 'succeeded',
          setup_exit_code: '0',
          setup_log_file: artifact(step, 'setup.log'),
          setup_results_file: artifact(step, SETUP_RESULTS_FILE),
        }),
      });
      expect(readFileSync(artifact(step, 'setup.log'), 'utf8')).toBe(
        'log of run-1\n',
      );
      expect(await journalOf(step)).toMatchObject({
        phase: 'finalized',
        scripts: [{ runId: 'run-1', logFile: 'setup.log' }],
      });
      expect(runProject).toHaveBeenCalledTimes(1);
    },
  );

  it('fails a recorded setup whose canonical run changed as interrupted', async () => {
    const step = newStep();
    const stepInputs = inputs({ setup: 'run_and_wait', group: 'Reviews' });
    await writeAttemptRecord(
      step.artifactsDir,
      settledSetupRecord(stepInputs, step),
    );
    readMeta.mockResolvedValue(runMeta('run-2', 'success', 0));

    const result = await runStep(step, stepInputs);

    expect(result).toMatchObject({
      status: 'failure',
      failureReason: 'setup_failed',
      error: 'Setup for task `task-1` was interrupted; check its setup log',
      outputs: { task_id: TASK, grouped: 'true', setup_state: 'failed' },
    });
    expect(runProject).not.toHaveBeenCalled();
  });

  it('fails closed on a corrupt journal', async () => {
    const step = newStep();
    await mkdir(step.artifactsDir, { recursive: true });
    await writeFile(artifact(step, ATTEMPT_JOURNAL_FILE), '{not json', 'utf8');

    const result = await runStep(step, inputs());

    expect(result).toEqual({
      status: 'failure',
      failureReason: 'target_not_ready',
      error:
        "This step's earlier attempt in project `proj-1` can't be checked; check the project",
      outputs: projectOnlyOutputs(),
    });
    expect(create).not.toHaveBeenCalled();
    expect(readFileSync(artifact(step, ATTEMPT_JOURNAL_FILE), 'utf8')).toBe(
      '{not json',
    );
  });

  it('fails closed on an uncertain journal, keeping its identifiers', async () => {
    const step = newStep();
    const stepInputs = inputs({ setup: 'run_and_wait' });
    const record = newAttemptRecord(stepInputs, step.caller);
    record.phase = 'uncertain';
    record.worktree = {
      taskId: TASK,
      branchName: BRANCH,
      createdAt: CREATED_AT,
      path: SINGLE_PATH,
      workspaceKind: 'single-repo',
    };
    await writeAttemptRecord(step.artifactsDir, record);

    const result = await runStep(step, stepInputs);

    expect(result).toEqual({
      status: 'failure',
      failureReason: 'target_not_ready',
      error:
        "This step's earlier attempt in project `proj-1` can't be checked; check the project",
      outputs: createdOutputs(),
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('records uncertain when setup launch fails unexpectedly, so replay fails closed', async () => {
    const step = newStep();
    const stepInputs = inputs({ setup: 'run_and_wait' });
    runProject.mockImplementation(() => {
      throw new Error('runner exploded');
    });

    await expect(runStep(step, stepInputs)).rejects.toThrow('runner exploded');

    const record = await journalOf(step);
    expect(record.phase).toBe('uncertain');
    expect(record.worktree?.taskId).toBe(TASK);

    runProject.mockClear();
    const replay = await runStep(step, stepInputs);

    expect(replay).toMatchObject({
      status: 'failure',
      failureReason: 'target_not_ready',
      outputs: createdOutputs(),
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(runProject).not.toHaveBeenCalled();
  });
});

describe('runCreateWorktreeHostAction cancellation and deadlines', () => {
  it('has no effects when the signal is already aborted', async () => {
    const step = newStep();
    const controller = new AbortController();
    controller.abort();

    await expect(
      runStep(step, inputs({ setup: 'run_and_wait' }), {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(readConfig).not.toHaveBeenCalled();
    expect(assertOwner).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(step.finalizers).toHaveLength(0);
    expect(existsSync(step.artifactsDir)).toBe(false);
  });

  it('keeps the created phase when cancelled while grouping', async () => {
    const step = newStep();
    const controller = new AbortController();
    const assignment = deferred<{
      group: SidebarItemGroup;
      created: boolean;
    }>();
    groups.assignItemToNamedGroup.mockReturnValue(assignment.promise);

    const pending = runStep(step, inputs({ group: 'Reviews' }), {
      signal: controller.signal,
    });
    await waitFor(
      () => groups.assignItemToNamedGroup.mock.calls.length === 1,
      'group assignment',
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    assignment.resolve({ group: group(), created: true });
    await quiesce();

    const record = await journalOf(step);
    expect(record.phase).toBe('created');
    expect(record.group).toBeUndefined();
    expect(record.result).toBeUndefined();
    expect(existsSync(artifact(step, SETUP_RESULTS_FILE))).toBe(false);
  });

  it('starts no creation when cancelled while the creating phase is written', async () => {
    const step = newStep();
    const controller = new AbortController();
    setBeforeJournalWriteForTests((record) => {
      if (record.phase === 'creating') controller.abort();
    });

    const pending = runStep(step, inputs({ setup: 'run_and_wait' }), {
      signal: controller.signal,
    });

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    // The abort rejects the step at once; the creating write still lands.
    await waitFor(() => hasJournal(step), 'creating journal');
    await quiesce();
    expect(create).not.toHaveBeenCalled();
    expect((await journalOf(step)).phase).toBe('creating');
  });

  it('starts no creation when the deadline lands while the creating phase is written', async () => {
    const step = newStep();
    const controller = new AbortController();
    let finalized: Promise<PipelineHostActionResult> | undefined;
    setBeforeJournalWriteForTests((record) => {
      if (record.phase !== 'creating' || finalized) return;
      controller.abort();
      finalized = step.finalizers[0]?.();
    });

    const pending = runStep(step, inputs({ setup: 'run_and_wait' }), {
      signal: controller.signal,
    });

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(await finalized).toMatchObject({
      status: 'failure',
      failureReason: 'target_not_ready',
    });
    await quiesce();
    expect(create).not.toHaveBeenCalled();
  });

  it('launches no setup when cancelled while creating', async () => {
    const step = newStep();
    const controller = new AbortController();
    const gate = deferred<void>();
    fakeCreation({ gate: gate.promise });

    const pending = runStep(
      step,
      inputs({ setup: 'run_and_wait', group: 'Reviews' }),
      {
        signal: controller.signal,
      },
    );
    await waitFor(() => create.mock.calls.length === 1, 'creation');
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    gate.resolve();
    await waitFor(() => serviceSetups.length === 1, 'service setup request');
    await waitFor(
      () => serviceSetups[0].state !== 'pending',
      'service setup settle',
    );

    expect(serviceSetups[0].state).toBe('refused');
    expect(runProject).not.toHaveBeenCalled();
    expect(groups.assignItemToNamedGroup).not.toHaveBeenCalled();
    const record = await journalOf(step);
    expect(record.phase).toBe('creating');
    expect(record.result).toBeUndefined();
  });

  it('leaves setup running and writes nothing after cancellation during setup', async () => {
    const step = newStep();
    const controller = new AbortController();

    const pending = runStep(step, inputs({ setup: 'run_and_wait' }), {
      signal: controller.signal,
    });
    await waitFor(() => projectRuns.length === 1, 'setup launch');
    const observer = observerOf(projectRuns[0]);
    const ref = scriptRef('run-1');
    observer.onResolved?.(true);
    void observer.onScriptStarted?.(ref);
    await quiesce();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await quiesce();
    const before = artifactListing(step);

    const done = finished(ref, 'succeeded', 0);
    void observer.onScriptCompleted?.(done);
    projectRuns[0].result.resolve({ status: 'completed', script: done });
    await quiesce();

    expect(artifactListing(step)).toEqual(before);
    expect(snapshot).not.toHaveBeenCalled();
    const record = await journalOf(step);
    expect(record.phase).toBe('setup_running');
    expect(record.result).toBeUndefined();
    expect(existsSync(artifact(step, SETUP_RESULTS_FILE))).toBe(false);
  });

  it('finalizes a deadline during creation as target_not_ready', async () => {
    const step = newStep();
    const controller = new AbortController();
    const gate = deferred<void>();
    fakeCreation({ gate: gate.promise });

    const pending = runStep(step, inputs({ setup: 'run_and_wait' }), {
      signal: controller.signal,
    });
    await waitFor(() => create.mock.calls.length === 1, 'creation');
    expect(step.finalizers).toHaveLength(1);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });

    const result = await step.finalizers[0]();

    expect(result).toEqual({
      status: 'failure',
      failureReason: 'target_not_ready',
      error:
        "Task creation in project `proj-1` didn't finish before the step timed out; check the project",
      outputs: projectOnlyOutputs(),
    });
    expect(result.outputs.setup_state).toBe('');
    const record = await journalOf(step);
    expect(record.phase).toBe('finalized');
    expect(record.result).toEqual(result);

    const before = artifactListing(step);
    gate.resolve();
    await waitFor(() => serviceSetups.length === 1, 'service setup request');
    await quiesce();
    expect(serviceSetups[0].state).toBe('refused');
    expect(runProject).not.toHaveBeenCalled();
    expect(artifactListing(step)).toEqual(before);
  });

  it('finalizes a deadline during setup with the partial log of the running script', async () => {
    const step = newStep();
    const controller = new AbortController();
    snapshot.mockImplementation(async ({ targetPath }) => {
      await mkdir(path.dirname(targetPath), { recursive: true });
      await writeFile(targetPath, 'partial output\n', 'utf8');
      return { status: 'copied' };
    });

    const pending = runStep(step, inputs({ setup: 'run_and_wait' }), {
      signal: controller.signal,
    });
    await waitFor(() => projectRuns.length === 1, 'setup launch');
    const observer = observerOf(projectRuns[0]);
    const ref = scriptRef('run-1');
    observer.onResolved?.(true);
    void observer.onScriptStarted?.(ref);
    await quiesce();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });

    const result = await step.finalizers[0]();

    expect(result).toEqual({
      status: 'failure',
      failureReason: 'setup_timed_out',
      error:
        "Setup for task `task-1` didn't finish before the step timed out; it keeps running in the app",
      outputs: createdOutputs({
        setup_state: 'timed_out',
        setup_exit_code: '',
        setup_log_file: artifact(step, 'setup.log'),
        setup_results_file: artifact(step, SETUP_RESULTS_FILE),
      }),
    });
    expect(readFileSync(artifact(step, 'setup.log'), 'utf8')).toBe(
      'partial output\n',
    );
    expect(readResultsFile(step)).toMatchObject({
      setup_state: 'timed_out',
      scripts: [{ run_id: 'run-1', state: 'running', log_file: 'setup.log' }],
    });
    const record = await journalOf(step);
    expect(record).toMatchObject({
      phase: 'finalized',
      result,
      scripts: [{ runId: 'run-1', logFile: 'setup.log' }],
    });

    const before = artifactListing(step);
    const done = finished(ref, 'failed', 1);
    void observer.onScriptCompleted?.(done);
    projectRuns[0].result.resolve({ status: 'failed', script: done });
    await quiesce();
    expect(artifactListing(step)).toEqual(before);
    expect(snapshot).toHaveBeenCalledTimes(1);
    await expect(step.finalizers[0]()).resolves.toBe(result);
  });

  it('says setup never started when the deadline lands before the setup launch', async () => {
    const step = newStep();
    const controller = new AbortController();
    const grouping = deferred<{ group: SidebarItemGroup; created: boolean }>();
    groups.assignItemToNamedGroup.mockReturnValue(grouping.promise);

    const pending = runStep(step, inputs({ group: 'Reviews' }), {
      signal: controller.signal,
    });
    await waitFor(
      () => groups.assignItemToNamedGroup.mock.calls.length === 1,
      'grouping',
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });

    const result = await step.finalizers[0]();

    expect(result).toMatchObject({
      status: 'failure',
      failureReason: 'setup_timed_out',
      error:
        'The step timed out after task `task-1` was created, before setup started',
      outputs: { task_id: TASK, setup_state: 'skipped' },
    });
    grouping.resolve({ group: group(), created: false });
  });

  it('returns the completed result to a finalizer that runs afterwards', async () => {
    const step = newStep();

    const result = await runStep(step, inputs());
    const before = artifactListing(step);

    await expect(step.finalizers[0]()).resolves.toBe(result);
    expect(artifactListing(step)).toEqual(before);
  });

  it('gives completion and a racing finalizer the same result object', async () => {
    const step = newStep();

    const pending = runStep(step, inputs({ setup: 'run_and_wait' }));
    await waitFor(() => projectRuns.length === 1, 'setup launch');
    const observer = observerOf(projectRuns[0]);
    const ref = scriptRef('run-1');
    observer.onResolved?.(true);
    void observer.onScriptStarted?.(ref);
    const done = finished(ref, 'succeeded', 0);
    void observer.onScriptCompleted?.(done);
    await quiesce();
    projectRuns[0].result.resolve({ status: 'completed', script: done });
    const finalized = step.finalizers[0]();

    const [completed, deadline] = await Promise.all([pending, finalized]);

    expect(completed).toBe(deadline);
    expect((await journalOf(step)).result).toEqual(completed);
  });

  it('shares one creation between concurrent same-key callers', async () => {
    const step = newStep();
    const gate = deferred<void>();
    fakeCreation({ gate: gate.promise });
    const firstController = new AbortController();

    const first = runStep(step, inputs(), { signal: firstController.signal });
    const second = runStep(step, inputs());
    await waitFor(() => create.mock.calls.length === 1, 'creation');
    firstController.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    gate.resolve();

    await expect(second).resolves.toEqual({
      status: 'success',
      outputs: createdOutputs({ setup_state: 'skipped' }),
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(step.finalizers).toHaveLength(2);
    expect((await journalOf(step)).phase).toBe('finalized');
  });
});

describe('runCreateWorktreeHostAction logging', () => {
  it('never logs branch or group names', async () => {
    const step = newStep();
    const branchName = 'secret-branch-name';
    const groupName = 'Secret Group Name';
    fakeCreation({ outcome: createdOutcome('single-repo', TASK, branchName) });
    groups.assignItemToNamedGroup.mockRejectedValue(
      new Error(`${groupName} is broken`),
    );
    snapshot.mockResolvedValue({
      status: 'error',
      message: 'script log copy failed: EIO',
    });

    const pending = runStep(
      step,
      inputs({
        branch: { kind: 'new', name: branchName },
        group: groupName,
        setup: 'run_and_wait',
      }),
    );
    await waitFor(() => projectRuns.length === 1, 'setup launch');
    const observer = observerOf(projectRuns[0]);
    const ref = scriptRef('run-1');
    observer.onResolved?.(true);
    void observer.onScriptStarted?.(ref);
    void observer.onScriptCompleted?.(finished(ref, 'failed', 1));
    projectRuns[0].result.reject(new Error(`${branchName} checkout failed`));

    const result = await pending;

    expect(result.status).toBe('failure');
    expect(result.outputs.branch_name).toBe(branchName);
    expect(logWarn.mock.calls.length).toBeGreaterThanOrEqual(3);
    const logged = allLogCalls();
    expect(logged).not.toContain(branchName);
    expect(logged).not.toContain(groupName);
  });
});

describe('runCreateWorktreeHostAction runner verdicts', () => {
  it('fails setup when the single-repo runner fails before any script starts', async () => {
    const step = newStep();

    const pending = runStep(step, inputs({ setup: 'run_and_wait' }));
    await waitFor(() => projectRuns.length === 1, 'setup launch');
    projectRuns[0].result.resolve({
      status: 'failed',
      detail: 'script resolution failed',
    });

    await expect(pending).resolves.toEqual({
      status: 'failure',
      failureReason: 'setup_failed',
      error: 'Setup for task `task-1` failed; check its setup log',
      outputs: createdOutputs({ setup_state: 'failed' }),
    });
    expect(existsSync(artifact(step, SETUP_RESULTS_FILE))).toBe(false);
  });

  it('fails setup when the multi-repo lifecycle stops on an error after a script succeeded', async () => {
    const step = newStep();
    readConfig.mockResolvedValue(configDetail('multi-repo', REPOS));
    fakeCreation({ kind: 'multi-repo' });

    const pending = runStep(step, inputs({ setup: 'run_and_wait' }));
    await waitFor(() => workspaceRuns.length === 1, 'setup launch');
    const observer = observerOf(workspaceRuns[0]);
    const before = scriptRef('run-before', {
      lifecycle: 'before-setup',
      target: 'workspace-root',
    });
    observer.onResolved?.(true);
    void observer.onScriptStarted?.(before);
    const done = finished(before, 'succeeded', 0);
    void observer.onScriptCompleted?.(done);
    workspaceRuns[0].result.resolve({
      status: 'failed',
      scripts: [done],
      detail: 'after-setup resolution failed',
    });

    const result = await pending;

    expect(result).toEqual({
      status: 'failure',
      failureReason: 'setup_failed',
      error: 'Setup for task `task-1` failed; check its setup log',
      outputs: createdOutputs(
        {
          setup_state: 'failed',
          setup_results_file: artifact(step, SETUP_RESULTS_FILE),
        },
        MULTI_PATH,
      ),
    });
    expect(readResultsFile(step)).toMatchObject({
      setup_state: 'failed',
      scripts: [{ run_id: 'run-before', state: 'succeeded' }],
    });
  });

  it('fails run mode when the runner errors before resolving its scripts', async () => {
    const step = newStep();

    const pending = runStep(step, inputs({ setup: 'run' }));
    await waitFor(() => projectRuns.length === 1, 'setup launch');
    projectRuns[0].result.resolve({
      status: 'failed',
      detail: 'script resolution failed',
    });

    await expect(pending).resolves.toMatchObject({
      status: 'failure',
      failureReason: 'setup_failed',
      outputs: { setup_state: 'failed' },
    });
  });
});

describe('runCreateWorktreeHostAction late finalization races', () => {
  it('broadcasts the kept worktree when admission closes during creation', async () => {
    const step = newStep();
    const window = new BrowserWindow();
    const controller = new AbortController();
    const gate = deferred<void>();
    fakeCreation({ gate: gate.promise });

    const pending = runStep(step, inputs({ setup: 'run_and_wait' }), {
      signal: controller.signal,
      getWindow: () => window,
    });
    await waitFor(() => create.mock.calls.length === 1, 'creation');
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await step.finalizers[0]();
    gate.resolve();
    await waitFor(() => serviceSetups.length === 1, 'service setup request');
    await quiesce();

    expect(send).toHaveBeenCalledWith(
      window,
      IPC_CHANNELS.workspaceWorktreesUpdated,
      { workspaceId: PROJECT },
    );
    expect(runProject).not.toHaveBeenCalled();
  });

  it('never records the resumable created phase for an unverified replay', async () => {
    const step = newStep();
    const phases: string[] = [];
    setBeforeJournalWriteForTests((record) => phases.push(record.phase));
    fakeCreation({ replay: true });

    const result = await runStep(step, inputs({ setup: 'run_and_wait' }));

    expect(result).toMatchObject({ failureReason: 'setup_failed' });
    expect(phases).toEqual(['creating', 'finalized']);
    expect((await journalOf(step)).worktree).toMatchObject({ taskId: TASK });
  });

  it('keeps the finalized phase when setup resolves during the final journal write', async () => {
    const step = newStep();
    const controller = new AbortController();

    const pending = runStep(step, inputs({ setup: 'run_and_wait' }), {
      signal: controller.signal,
    });
    await waitFor(() => projectRuns.length === 1, 'setup launch');
    const observer = observerOf(projectRuns[0]);
    void observer.onScriptStarted?.(scriptRef('run-1'));
    await quiesce();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    let lateResolve = false;
    setBeforeJournalWriteForTests((record) => {
      if (record.phase === 'finalized' && !lateResolve) {
        lateResolve = true;
        observer.onResolved?.(true);
      }
    });

    const result = await step.finalizers[0]();
    await quiesce();

    expect(lateResolve).toBe(true);
    const record = await journalOf(step);
    expect(record.phase).toBe('finalized');
    expect(record.result).toEqual(result);
  });

  it('copies the log of a script that completed after withdrawal', async () => {
    const step = newStep();
    const controller = new AbortController();

    const pending = runStep(step, inputs({ setup: 'run_and_wait' }), {
      signal: controller.signal,
    });
    await waitFor(() => projectRuns.length === 1, 'setup launch');
    const observer = observerOf(projectRuns[0]);
    const ref = scriptRef('run-1');
    observer.onResolved?.(true);
    void observer.onScriptStarted?.(ref);
    await quiesce();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    void observer.onScriptCompleted?.(finished(ref, 'failed', 3));
    await quiesce();
    expect(snapshot).not.toHaveBeenCalled();

    const result = await step.finalizers[0]();

    expect(result.outputs).toMatchObject({
      setup_state: 'timed_out',
      setup_exit_code: '3',
      setup_log_file: artifact(step, 'setup.log'),
    });
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(readResultsFile(step)).toMatchObject({
      scripts: [{ run_id: 'run-1', state: 'failed', log_file: 'setup.log' }],
    });
  });

  it('shares a finalizing attempt with a same-key call instead of starting another', async () => {
    const step = newStep();
    const controller = new AbortController();
    const copy = deferred<void>();
    snapshot.mockImplementation(async ({ targetPath }) => {
      await copy.promise;
      await mkdir(path.dirname(targetPath), { recursive: true });
      await writeFile(targetPath, 'partial output\n', 'utf8');
      return { status: 'copied' };
    });

    const pending = runStep(step, inputs({ setup: 'run_and_wait' }), {
      signal: controller.signal,
    });
    await waitFor(() => projectRuns.length === 1, 'setup launch');
    const observer = observerOf(projectRuns[0]);
    observer.onResolved?.(true);
    void observer.onScriptStarted?.(scriptRef('run-1'));
    await quiesce();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const finalizing = step.finalizers[0]();
    await waitFor(() => snapshot.mock.calls.length === 1, 'partial copy');

    const again = runStep(step, inputs({ setup: 'run_and_wait' }));
    copy.resolve();
    const result = await finalizing;

    await expect(again).resolves.toBe(result);
    expect(create).toHaveBeenCalledTimes(1);
    expect(runProject).toHaveBeenCalledTimes(1);
    expect((await journalOf(step)).result).toEqual(result);
  });
});
