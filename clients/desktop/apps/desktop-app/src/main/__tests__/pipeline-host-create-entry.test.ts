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
jest.mock('../lib/chat-tabs-reader', () => ({
  readChatTabsFile: jest.fn(),
}));
jest.mock('../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
  logMainProcessError: jest.fn(),
}));

import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AgentPortError,
  createInMemoryAgentActionReceipts,
  type AgentActionResponse,
  type AgentProjectBotPort,
} from '@canopy/agent-actions';
import type {
  PipelineHostActionCaller,
  PipelineHostActionControls,
  PipelineHostActionRequest,
  PipelineHostActionResult,
} from '@canopy/desktop-shared/node/pipelines/executor/types';
import { PipelineHostRefusal } from '@canopy/desktop-shared/pipelines/host-actions';
import type {
  CreateBotEntryInputs,
  CreateProjectEntryInputs,
} from '@canopy/desktop-shared/pipelines/host-create-entry';
import type {
  ChatTabsFile,
  CoworkWorkEntriesFile,
  WorkspaceConfigFile,
} from '@canopy/desktop-shared/types';
import type { SidebarItemGroup } from '@canopy/protocol/sidebar';
import type { PipelineTrustedCaller } from '../agent-messaging/pipeline-caller';
import type { CanopyInjectedToolRuntime } from '../canopy-tools/core';
import { ADVISOR_ACCESS_DISABLED_MESSAGE } from '../lib/app-advisor-project-agent-access';
import { readChatTabsFile } from '../lib/chat-tabs-reader';
import { resolveCoworkWorkspaceId } from '../lib/cowork-migration-map';
import { readWorkEntriesFileStrict } from '../lib/cowork-work-entries';
import {
  logMainProcessError,
  logMainProcessWarn,
} from '../lib/main-process-logging';
import { readWorkspaceConfigDetailed } from '../lib/workspace-persistence';
import { createDesktopPipelineHostActions } from '../pipelines/host-actions';
import {
  createEntryFingerprint,
  ENTRY_ATTEMPT_JOURNAL_FILE,
  writeEntryAttempt,
  type EntryAttemptRecord,
} from '../pipelines/host-create-entry-state';
import type * as SidebarItemGroupsServiceModule from '../services/sidebar-item-groups-service';
import {
  sidebarItemGroupsService,
  SidebarItemGroupRefusalError,
} from '../services/sidebar-item-groups-service';

type PortAction = Parameters<
  AgentProjectBotPort<CanopyInjectedToolRuntime>['dispatch']
>[0];
type PortResponse = Omit<AgentActionResponse<string>, 'requestId'>;

const readConfig = jest.mocked(readWorkspaceConfigDetailed);
const readEntries = jest.mocked(readWorkEntriesFileStrict);
const readTabs = jest.mocked(readChatTabsFile);
const assignNamed = jest.mocked(
  sidebarItemGroupsService.assignItemToNamedGroup,
);
const warn = jest.mocked(logMainProcessWarn);
const logError = jest.mocked(logMainProcessError);

const TITLE = 'Nightly';
const GROUP = 'Reports';

function config(
  type: WorkspaceConfigFile['type'],
): Awaited<ReturnType<typeof readWorkspaceConfigDetailed>> {
  return {
    config: { version: 1, type, repos: [] } satisfies WorkspaceConfigFile,
    authority: 'ok',
    ownerMalformed: false,
    memoryMalformed: false,
  };
}

function entries(...ids: string[]): CoworkWorkEntriesFile {
  return {
    version: 1,
    entries: ids.map((id) => ({
      id,
      createdAt: '2026-10-26T00:00:00.000Z',
    })),
  };
}

function tabs(...ids: string[]): ChatTabsFile {
  return {
    version: 1,
    tabs: ids.map((id) => ({
      id,
      title: 'Chat',
      createdAt: '2026-10-26T00:00:00.000Z',
      messages: [],
    })),
    activeTabId: ids[0] ?? null,
  };
}

function group(overrides: Partial<SidebarItemGroup> = {}): SidebarItemGroup {
  return {
    id: 'grp-9',
    name: GROUP,
    color: 'categorical-2',
    collapsed: false,
    memberIds: [],
    ...overrides,
  };
}

let artifactsDir: string;
let key: string;
let keySeq = 0;
let dispatch: jest.Mock<Promise<PortResponse>, [PortAction, unknown]>;
let portFor: jest.Mock<
  AgentProjectBotPort<CanopyInjectedToolRuntime>,
  [PipelineTrustedCaller, string]
>;
let assertTargetOwner: jest.Mock<Promise<void>, [unknown, unknown]>;

function caller(
  overrides: Partial<PipelineHostActionCaller> = {},
): PipelineHostActionCaller {
  return {
    executionId: 'exec-1',
    jobId: 'job',
    stepId: 'create',
    attempt: 0,
    iteration: 0,
    idempotencyKey: key,
    ...overrides,
  };
}

function controls(): PipelineHostActionControls {
  return {
    deadlineAt: Date.now() + 60_000,
    artifactsDir,
    registerTimeoutFinalizer: jest.fn(),
  };
}

function host(): ReturnType<typeof createDesktopPipelineHostActions> {
  return createDesktopPipelineHostActions({
    assertTargetOwner,
    projectBotPortFor: portFor,
    receipts: createInMemoryAgentActionReceipts(),
  });
}

/** The task ID the adapter journaled before dispatching. */
function plannedId(): string {
  const stored: unknown = JSON.parse(
    readFileSync(path.join(artifactsDir, ENTRY_ATTEMPT_JOURNAL_FILE), 'utf8'),
  );
  if (
    typeof stored !== 'object' ||
    stored === null ||
    !('taskId' in stored) ||
    typeof stored.taskId !== 'string'
  )
    throw new Error('No planned task id');
  return stored.taskId;
}

function journal(): unknown {
  return JSON.parse(
    readFileSync(path.join(artifactsDir, ENTRY_ATTEMPT_JOURNAL_FILE), 'utf8'),
  );
}

function created(action: PortAction, taskId = plannedId()): PortResponse {
  return {
    ok: true,
    result: {
      address:
        'projectId' in action
          ? { projectId: action.projectId, taskId, chatId: taskId }
          : {
              botId: 'botId' in action ? action.botId : '',
              taskId,
              chatId: taskId,
            },
      taskCreated: true,
      chatCreated: true,
    },
  };
}

function refused(code: string, message = 'Refused.'): PortResponse {
  return { ok: false, error: { code, message } };
}

function project(
  inputs: CreateProjectEntryInputs,
  hostActions = host(),
  signal = new AbortController().signal,
  callerOverrides: Partial<PipelineHostActionCaller> = {},
): Promise<PipelineHostActionResult> {
  return hostActions.run(
    { action: 'create-project-entry', inputs },
    caller(callerOverrides),
    signal,
    controls(),
  );
}

function bot(
  inputs: CreateBotEntryInputs,
  hostActions = host(),
): Promise<PipelineHostActionResult> {
  return hostActions.run(
    { action: 'create-bot-entry', inputs },
    caller(),
    new AbortController().signal,
    controls(),
  );
}

async function seedJournal(
  request: PipelineHostActionRequest,
  overrides: Partial<EntryAttemptRecord>,
): Promise<void> {
  await writeEntryAttempt(artifactsDir, {
    version: 1,
    idempotencyKey: key,
    fingerprint: createEntryFingerprint(request),
    phase: 'creating',
    taskId: 't1',
    ...overrides,
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const PROJECT_EMPTY = {
  project_id: 'cowork-default',
  task_id: '',
  chat_id: '',
  task_created: 'false',
  chat_created: 'false',
  group_id: '',
  group_created: 'false',
  grouped: 'false',
  not_grouped_reason: '',
};

beforeEach(() => {
  jest.resetAllMocks();
  artifactsDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-entry-host-'));
  key = `pipeline-host:exec-1:job::create:${++keySeq}:0`;
  readConfig.mockResolvedValue(config('cowork'));
  jest.mocked(resolveCoworkWorkspaceId).mockImplementation((id) => id);
  readEntries.mockResolvedValue(entries());
  readTabs.mockResolvedValue(tabs());
  assignNamed.mockResolvedValue({ group: group(), created: true });
  dispatch = jest.fn((action: PortAction, context: unknown) => {
    void context;
    return Promise.resolve(created(action));
  });
  portFor = jest.fn((caller: PipelineTrustedCaller, operation: string) => {
    void caller;
    void operation;
    return { dispatch };
  });
  assertTargetOwner = jest.fn((target: unknown, owner: unknown) => {
    void target;
    void owner;
    return Promise.resolve();
  });
});

afterEach(() => {
  chmodSync(artifactsDir, 0o700);
  rmSync(artifactsDir, { recursive: true, force: true });
  // Titles and group names are user text: never in any log argument.
  for (const call of [...warn.mock.calls, ...logError.mock.calls]) {
    const text = JSON.stringify(call, (_key, value: unknown) =>
      value instanceof Error ? value.message : value,
    );
    expect(text).not.toContain(TITLE);
    expect(text).not.toContain(GROUP);
  }
});

describe('create-project-entry', () => {
  it('creates a cowork task, groups it and returns every output', async () => {
    const result = await project({
      projectId: 'cowork-default',
      title: TITLE,
      group: GROUP,
    });

    expect(dispatch).toHaveBeenCalledWith(
      {
        type: 'projects.create_task',
        projectId: 'cowork-default',
        title: TITLE,
      },
      expect.objectContaining({ actorKey: 'pipeline:exec-1' }),
    );
    expect(dispatch.mock.calls[0]?.[1]).not.toHaveProperty('scope');
    expect(portFor).toHaveBeenCalledWith(
      { executionId: 'exec-1', stepId: 'create', owner: { kind: 'personal' } },
      plannedId(),
    );
    expect(result).toEqual({
      status: 'success',
      outputs: {
        project_id: 'cowork-default',
        task_id: plannedId(),
        chat_id: plannedId(),
        task_created: 'true',
        chat_created: 'true',
        group_id: 'grp-9',
        group_created: 'true',
        grouped: 'true',
        not_grouped_reason: '',
      },
    });
    expect(assignNamed).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { workspaceLocalId: 'cowork-default' },
        itemId: plannedId(),
        name: GROUP,
      }),
    );
    expect(journal()).toMatchObject({ phase: 'finalized' });
  });

  it('sends no title or initialMessage when none is given', async () => {
    await project({ projectId: 'cowork-default' });
    expect(dispatch.mock.calls[0]?.[0]).toEqual({
      type: 'projects.create_task',
      projectId: 'cowork-default',
    });
    expect(assignNamed).not.toHaveBeenCalled();
  });

  it('journals only the fingerprint, never the title or group name', async () => {
    await project({ projectId: 'cowork-default', title: TITLE, group: GROUP });
    const text = readFileSync(
      path.join(artifactsDir, ENTRY_ATTEMPT_JOURNAL_FILE),
      'utf8',
    );
    expect(text).not.toContain(TITLE);
    expect(text).not.toContain(GROUP);
  });

  it('refuses a code project with unsupported_action pointing to create-worktree, without dispatch or journal', async () => {
    readConfig.mockResolvedValue(config('single-repo'));
    const result = await project({ projectId: 'code-project' });
    expect(result).toMatchObject({
      status: 'failure',
      failureReason: 'unsupported_action',
      error: 'Project `code-project` uses worktrees. Use create-worktree.',
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(() => journal()).toThrow();
  });

  it('runs the owner check before the project type and never dispatches on a refusal', async () => {
    readConfig.mockResolvedValue(config('single-repo'));
    assertTargetOwner.mockRejectedValue(
      new PipelineHostRefusal(
        'not_found',
        "Project `code-project` isn't available to this pipeline",
      ),
    );
    const result = await project({ projectId: 'code-project' });
    expect(result).toMatchObject({
      status: 'failure',
      failureReason: 'not_found',
    });
    expect(assertTargetOwner).toHaveBeenCalledWith(caller(), {
      kind: 'project',
      projectId: 'code-project',
      workspaceType: 'single-repo',
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(() => journal()).toThrow();
  });

  it('refuses the App Advisor project id as not_found', async () => {
    const result = await project({ projectId: 'app-advisor' });
    expect(result).toMatchObject({
      status: 'failure',
      failureReason: 'not_found',
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('refuses an unparseable run owner as owner_context_unavailable', async () => {
    const result = await project(
      { projectId: 'cowork-default' },
      host(),
      new AbortController().signal,
      { executionContext: 'garbage' },
    );
    expect(result).toMatchObject({
      status: 'failure',
      failureReason: 'owner_context_unavailable',
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each([
    [
      'not_found',
      'not_found',
      "Project `cowork-default` isn't available to this pipeline",
    ],
    ['invalid_target', 'target_not_ready', 'Refused.'],
    [
      'idempotency_conflict',
      'authorization_conflict',
      'This step already ran with different inputs',
    ],
    [
      'owner_context_unavailable',
      'owner_context_unavailable',
      "Project `cowork-default` can't be checked right now. Try again.",
    ],
    ['validation_failed', 'validation_failed', 'Refused.'],
  ])(
    'maps a %s refusal to %s and keeps every output',
    async (code, failureReason, error) => {
      dispatch.mockResolvedValue(refused(code));
      const result = await project({
        projectId: 'cowork-default',
        title: TITLE,
      });
      expect(result).toEqual({
        status: 'failure',
        failureReason,
        error,
        outputs: PROJECT_EMPTY,
      });
      expect(journal()).toMatchObject({ phase: 'finalized', result });
    },
  );

  it('maps a thrown AgentPortError like a response code', async () => {
    dispatch.mockRejectedValue(
      new AgentPortError('unsupported_action', 'Not for pipelines.'),
    );
    await expect(project({ projectId: 'cowork-default' })).resolves.toEqual({
      status: 'failure',
      failureReason: 'unsupported_action',
      error: 'Not for pipelines.',
      outputs: PROJECT_EMPTY,
    });
  });

  it('rethrows an unknown port error code and leaves the journal at creating', async () => {
    dispatch.mockResolvedValue(refused('execution_failed'));
    await expect(project({ projectId: 'cowork-default' })).rejects.toThrow(
      'unexpected execution_failed refusal',
    );
    expect(journal()).toMatchObject({ phase: 'creating' });
  });

  it('rethrows an unexpected dispatch error, clears the live operation and re-dispatches with the same id on the next call', async () => {
    dispatch.mockRejectedValueOnce(new Error('disk full'));
    const hostActions = host();
    await expect(
      project({ projectId: 'cowork-default' }, hostActions),
    ).rejects.toThrow('disk full');
    const planned = plannedId();
    expect(journal()).toMatchObject({ phase: 'creating' });

    const result = await project({ projectId: 'cowork-default' }, hostActions);

    expect(result).toMatchObject({
      status: 'success',
      outputs: { task_id: planned },
    });
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(portFor.mock.calls.map(([, taskId]) => taskId)).toEqual([
      planned,
      planned,
    ]);
  });

  it('keeps the step successful when the group limit is reached', async () => {
    assignNamed.mockRejectedValue(
      new SidebarItemGroupRefusalError('group_limit_reached', 'Too many'),
    );
    const result = await project({ projectId: 'cowork-default', group: GROUP });
    expect(result).toMatchObject({
      status: 'success',
      outputs: {
        group_id: '',
        group_created: 'false',
        grouped: 'false',
        not_grouped_reason: 'group_limit_reached',
      },
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('maps an unexpected group error to group_assignment_failed and never logs the group name', async () => {
    assignNamed.mockRejectedValue(new Error(`no group ${GROUP}`));
    const result = await project({ projectId: 'cowork-default', group: GROUP });
    expect(result).toMatchObject({
      status: 'success',
      outputs: {
        grouped: 'false',
        not_grouped_reason: 'group_assignment_failed',
      },
    });
    expect(warn).toHaveBeenCalledWith(
      '[pipeline-host] create-project-entry group assignment failed',
      { errorType: 'Error' },
    );
  });

  it('keeps the result when the finalize write fails', async () => {
    assignNamed.mockImplementation(() => {
      // Every journal write after `created` now fails.
      chmodSync(artifactsDir, 0o500);
      return Promise.resolve({ group: group(), created: false });
    });
    const result = await project({ projectId: 'cowork-default', group: GROUP });
    expect(result).toMatchObject({
      status: 'success',
      outputs: { grouped: 'true' },
    });
    expect(warn.mock.calls.map(([message]) => message)).toContain(
      '[pipeline-host] create-project-entry could not record its result',
    );
  });

  it('does not dispatch once the step was withdrawn before the journal was written', async () => {
    const controller = new AbortController();
    readConfig.mockImplementation(() => {
      controller.abort();
      return Promise.resolve(config('cowork'));
    });
    await expect(
      project({ projectId: 'cowork-default' }, host(), controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    // Give an operation that wrongly kept going time to journal and dispatch.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(dispatch).not.toHaveBeenCalled();
    expect(() => journal()).toThrow();
  });

  it('ignores an abort raised after the journal was written and completes the operation', async () => {
    const held = deferred<void>();
    dispatch.mockImplementation(async (action) => {
      await held.promise;
      return created(action);
    });
    const controller = new AbortController();
    const hostActions = host();
    const first = project(
      { projectId: 'cowork-default' },
      hostActions,
      controller.signal,
    );
    await waitFor(() => dispatch.mock.calls.length === 1);
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });

    held.resolve();
    const replay = await project({ projectId: 'cowork-default' }, hostActions);

    expect(replay).toMatchObject({
      status: 'success',
      outputs: { task_id: plannedId() },
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(journal()).toMatchObject({ phase: 'finalized' });
  });
});

describe('create-bot-entry', () => {
  it('creates an App Advisor task in the App Advisor group scope', async () => {
    const result = await bot({ botId: 'app_advisor', group: GROUP });
    expect(dispatch.mock.calls[0]?.[0]).toEqual({
      type: 'bots.create_task',
      botId: 'app_advisor',
    });
    expect(assignNamed).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { appAdvisor: true },
        itemId: plannedId(),
      }),
    );
    expect(result).toEqual({
      status: 'success',
      outputs: {
        bot_id: 'app_advisor',
        task_id: plannedId(),
        chat_id: plannedId(),
        task_created: 'true',
        chat_created: 'true',
        group_id: 'grp-9',
        group_created: 'true',
        grouped: 'true',
        not_grouped_reason: '',
      },
    });
  });

  it('refuses an unknown bot as not_found without dispatch', async () => {
    await expect(bot({ botId: 'other_bot' })).resolves.toMatchObject({
      status: 'failure',
      failureReason: 'not_found',
      error: "Bot `other_bot` isn't available to this pipeline",
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('maps advisor_access_disabled with the shared message', async () => {
    dispatch.mockResolvedValue(
      refused('advisor_access_disabled', 'The target chat is not available.'),
    );
    const result = await bot({ botId: 'app_advisor' });
    expect(result).toMatchObject({
      status: 'failure',
      failureReason: 'advisor_access_disabled',
      error: ADVISOR_ACCESS_DISABLED_MESSAGE,
      outputs: { bot_id: 'app_advisor', task_id: '' },
    });
  });

  it('skips the project owner check', async () => {
    await bot({ botId: 'app_advisor' });
    expect(assertTargetOwner).not.toHaveBeenCalled();
  });

  it('recovers a creating journal against the App Advisor entries', async () => {
    await seedJournal(
      { action: 'create-bot-entry', inputs: { botId: 'app_advisor' } },
      {},
    );
    readEntries.mockResolvedValue(entries('t1'));
    readTabs.mockResolvedValue(tabs('t1'));
    await expect(bot({ botId: 'app_advisor' })).resolves.toMatchObject({
      status: 'success',
      outputs: { task_id: 't1', chat_id: 't1' },
    });
    expect(readEntries).toHaveBeenCalledWith('app-advisor');
    expect(readTabs).toHaveBeenCalledWith('app-advisor', 't1');
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('replay', () => {
  const inputs = { projectId: 'cowork-default', group: GROUP };
  const request: PipelineHostActionRequest = {
    action: 'create-project-entry',
    inputs,
  };

  it('returns a finalized success without dispatching or regrouping', async () => {
    const result: PipelineHostActionResult = {
      status: 'success',
      outputs: { ...PROJECT_EMPTY, task_id: 't1', chat_id: 't1' },
    };
    await seedJournal(request, { phase: 'finalized', chatId: 't1', result });
    await expect(project(inputs)).resolves.toEqual(result);
    expect(dispatch).not.toHaveBeenCalled();
    expect(assignNamed).not.toHaveBeenCalled();
  });

  it('returns a finalized typed failure without dispatching', async () => {
    const result: PipelineHostActionResult = {
      status: 'failure',
      failureReason: 'not_found',
      error: "Project `cowork-default` isn't available to this pipeline",
      outputs: PROJECT_EMPTY,
    };
    await seedJournal(request, { phase: 'finalized', result });
    await expect(project(inputs)).resolves.toEqual(result);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('reconstructs a created task after a crash between creation and the result', async () => {
    await seedJournal(request, {});
    readEntries.mockResolvedValue(entries('t1'));
    readTabs.mockResolvedValue(tabs('t1'));
    const result = await project(inputs);
    expect(result).toMatchObject({
      status: 'success',
      outputs: {
        task_id: 't1',
        chat_id: 't1',
        task_created: 'true',
        chat_created: 'true',
        grouped: 'true',
      },
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(assignNamed).toHaveBeenCalledTimes(1);
  });

  it('resumes a created phase without dispatching and reuses recorded group outputs', async () => {
    const recorded = {
      group_id: 'grp-1',
      group_created: 'true',
      grouped: 'true',
      not_grouped_reason: '',
    };
    await seedJournal(request, {
      phase: 'created',
      chatId: 't1',
      group: recorded,
    });
    await expect(project(inputs)).resolves.toMatchObject({
      status: 'success',
      outputs: { task_id: 't1', ...recorded },
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(assignNamed).not.toHaveBeenCalled();
  });

  it('assigns the group once when a created phase has no group recorded', async () => {
    await seedJournal(request, { phase: 'created', chatId: 't1' });
    await project(inputs);
    expect(assignNamed).toHaveBeenCalledTimes(1);
    expect(journal()).toMatchObject({
      phase: 'finalized',
      group: { group_id: 'grp-9' },
    });
  });

  it('fails target_not_ready with task_id when the entry exists without its chat', async () => {
    await seedJournal(request, {});
    readEntries.mockResolvedValue(entries('t1'));
    readTabs.mockResolvedValue(tabs('other'));
    await expect(project(inputs)).resolves.toEqual({
      status: 'failure',
      failureReason: 'target_not_ready',
      error:
        "Task `t1` was created but its first chat isn't confirmed. Check the project.",
      outputs: { ...PROJECT_EMPTY, task_id: 't1' },
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('fails target_not_ready with task_id when the tabs file cannot be read', async () => {
    await seedJournal(request, {});
    readEntries.mockResolvedValue(entries('t1'));
    readTabs.mockRejectedValue(new Error('unreadable'));
    await expect(project(inputs)).resolves.toMatchObject({
      status: 'failure',
      failureReason: 'target_not_ready',
      outputs: { task_id: 't1' },
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('dispatches again with the journaled task id when nothing was created', async () => {
    await seedJournal(request, {});
    await expect(project(inputs)).resolves.toMatchObject({
      status: 'success',
      outputs: { task_id: 't1' },
    });
    expect(portFor).toHaveBeenCalledWith(expect.anything(), 't1');
  });

  it('returns the planned task when an unconfirmed creation refusal follows a commit', async () => {
    dispatch.mockImplementation(() => {
      readEntries.mockResolvedValue(entries(plannedId()));
      readTabs.mockResolvedValue(tabs(plannedId()));
      return Promise.resolve(
        refused('invalid_target', 'Creation could not be confirmed.'),
      );
    });
    const result = await project(inputs);
    expect(result).toMatchObject({
      status: 'success',
      outputs: {
        task_id: plannedId(),
        chat_id: plannedId(),
        task_created: 'true',
        grouped: 'true',
      },
    });
    expect(journal()).toMatchObject({ phase: 'finalized', result });
  });

  it('returns the created task when its created record cannot be written', async () => {
    let planned = '';
    dispatch.mockImplementation((action: PortAction) => {
      planned = plannedId();
      chmodSync(artifactsDir, 0o500);
      return Promise.resolve(created(action, planned));
    });
    const result = await project(inputs);
    expect(result).toMatchObject({
      status: 'success',
      outputs: { task_id: planned, chat_id: planned, grouped: 'true' },
    });
    expect(warn.mock.calls.map(([message]) => message)).toContain(
      '[pipeline-host] create-project-entry could not record its task',
    );
    // The journal still reads `creating`, which a resume recovers.
    expect(journal()).toMatchObject({ phase: 'creating', taskId: planned });
  });

  it('fails with task_id when an unconfirmed creation refusal leaves the entry without its chat', async () => {
    dispatch.mockImplementation(() => {
      readEntries.mockResolvedValue(entries(plannedId()));
      return Promise.resolve(
        refused('invalid_target', 'Creation could not be confirmed.'),
      );
    });
    const result = await project(inputs);
    expect(result).toEqual({
      status: 'failure',
      failureReason: 'target_not_ready',
      error: `Task \`${plannedId()}\` was created but its first chat isn't confirmed. Check the project.`,
      outputs: { ...PROJECT_EMPTY, task_id: plannedId() },
    });
    expect(assignNamed).not.toHaveBeenCalled();
  });

  it('treats a journal from another attempt key as absent and creates again', async () => {
    await seedJournal(request, {
      idempotencyKey: 'pipeline-host:exec-1:job::create:0:0',
      phase: 'finalized',
      result: { status: 'success', outputs: { task_id: 't0' } },
    });
    const result = await project(inputs);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(plannedId()).not.toBe('t1');
    expect(result).toMatchObject({ outputs: { task_id: plannedId() } });
  });

  it('fails authorization_conflict when the same key ran with different inputs', async () => {
    await seedJournal(
      {
        action: 'create-project-entry',
        inputs: { projectId: 'cowork-default' },
      },
      {},
    );
    await expect(project(inputs)).resolves.toMatchObject({
      status: 'failure',
      failureReason: 'authorization_conflict',
      error: 'This step already ran with different inputs',
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('fails target_not_ready on a corrupt journal without dispatch', async () => {
    await writeFile(
      path.join(artifactsDir, ENTRY_ATTEMPT_JOURNAL_FILE),
      '{nope',
      'utf8',
    );
    await expect(project(inputs)).resolves.toMatchObject({
      status: 'failure',
      failureReason: 'target_not_ready',
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('makes one dispatch for two concurrent calls with the same key and returns the same result to both', async () => {
    const held = deferred<void>();
    dispatch.mockImplementation(async (action) => {
      await held.promise;
      return created(action);
    });
    const hostActions = host();
    const first = project(inputs, hostActions);
    await waitFor(() => dispatch.mock.calls.length === 1);
    const second = project(inputs, hostActions);
    held.resolve();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(assignNamed).toHaveBeenCalledTimes(1);
  });

  it('refuses a concurrent call with the same key and different inputs', async () => {
    const held = deferred<void>();
    dispatch.mockImplementation(async (action) => {
      await held.promise;
      return created(action);
    });
    const hostActions = host();
    const first = project(inputs, hostActions);
    await waitFor(() => dispatch.mock.calls.length === 1);
    await expect(
      project({ projectId: 'cowork-default' }, hostActions),
    ).resolves.toMatchObject({
      status: 'failure',
      failureReason: 'authorization_conflict',
    });
    held.resolve();
    await expect(first).resolves.toMatchObject({ status: 'success' });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('gives an attached caller AbortError without affecting the operation', async () => {
    const held = deferred<void>();
    dispatch.mockImplementation(async (action) => {
      await held.promise;
      return created(action);
    });
    const hostActions = host();
    const first = project(inputs, hostActions);
    await waitFor(() => dispatch.mock.calls.length === 1);
    const controller = new AbortController();
    const attached = project(inputs, hostActions, controller.signal);
    controller.abort();
    await expect(attached).rejects.toMatchObject({ name: 'AbortError' });
    held.resolve();
    await expect(first).resolves.toMatchObject({ status: 'success' });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(journal()).toMatchObject({ phase: 'finalized' });
  });
});

describe('agent-originated runs', () => {
  it('builds the pipeline caller with the origin agent', async () => {
    const agentOrigin = { projectId: 'p', worktreeId: 'w', chatId: 'c' };
    await project(
      { projectId: 'cowork-default' },
      host(),
      new AbortController().signal,
      { agentOrigin },
    );
    expect(portFor).toHaveBeenCalledWith(
      expect.objectContaining({ agentOrigin }),
      expect.any(String),
    );
  });
});

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (!condition()) throw new Error('Condition not met');
}
