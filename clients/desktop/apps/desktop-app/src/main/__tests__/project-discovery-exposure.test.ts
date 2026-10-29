import {
  projectDiscoveryActionSchema,
  PROJECT_DISCOVERY_ACTION_TYPES,
  type ProjectDiscoveryAction,
} from '@canopy/desktop-shared/lib/project-discovery';
import {
  projectReadActionSchema,
  PROJECT_READ_ACTION_TYPES,
  type ProjectReadAction,
} from '@canopy/desktop-shared/lib/project-reads';
import { PROJECT_MESSAGE_CONTROL_ACTION_TYPES } from '@canopy/desktop-shared/lib/chat-send-actions';
import type { AppAdvisorActionResponse } from '@canopy/desktop-shared/types';
import type { ProjectDiscoveryCaller } from '../project-discovery';

type ServiceResponse = Omit<AppAdvisorActionResponse, 'requestId'>;

const mockDispatchProjectDiscoveryAction = jest.fn<
  Promise<ServiceResponse>,
  [ProjectDiscoveryAction, ProjectDiscoveryCaller]
>();
const mockDispatchProjectReadAction = jest.fn<
  Promise<ServiceResponse>,
  [ProjectReadAction, ProjectDiscoveryCaller]
>();

jest.mock('../project-discovery', (): object => ({
  dispatchProjectDiscoveryAction: mockDispatchProjectDiscoveryAction,
}));
jest.mock('../project-discovery/reads', (): object => ({
  dispatchProjectReadAction: mockDispatchProjectReadAction,
}));

import { appAdvisorActionSchema } from '../app-advisor/definitions';
import type { CanopyInjectedToolRuntime } from '../canopy-tools/core';
import { executeCanopyInjectedTool } from '../canopy-tools/core';
import {
  coworkDispatchActionJsonSchema,
  dispatchActionJsonSchema,
} from '../canopy-tools/definitions';
import {
  createDelegateCanopyTools,
  DELEGATE_SCRIPT_ACTION_TYPES,
} from '../agents/delegation/canopy-tools';

const readActions = PROJECT_READ_ACTION_TYPES.map((type) => ({
  type,
  projectId: 'other-project',
  taskId: 'other-task',
  chatId: 'other-chat',
}));
const actions = [
  ...readActions,
  { type: 'projects.list' },
  { type: 'projects.list_tasks', projectId: 'other-project' },
  {
    type: 'projects.list_task_chats',
    projectId: 'other-project',
    taskId: 'other-task',
  },
];
const caller: Extract<ProjectDiscoveryCaller, { kind: 'project_agent' }> = {
  kind: 'project_agent',
  projectId: 'origin-project',
  worktreeId: 'origin-task',
  chatId: 'origin-chat',
};

function makeRuntime(
  executionScope: 'worktree' | 'directory',
  allowedActionTypes?: readonly string[],
): CanopyInjectedToolRuntime {
  return {
    requestUserAnswers: jest.fn().mockResolvedValue([]),
    loadScriptOutput: jest.fn().mockResolvedValue({ found: true, lines: [] }),
    worktreeActionRuntime: {
      projectId: caller.projectId,
      worktreeId: caller.worktreeId,
      chatId: caller.chatId,
      cwd: '/repo',
      executionScope,
      getWindow: () => null,
      ...(allowedActionTypes ? { allowedActionTypes } : {}),
    },
  };
}

function isDiscoveryType(type: string): boolean {
  return PROJECT_DISCOVERY_ACTION_TYPES.some((entry) => entry === type);
}

function parsed(action: { type: string }): object {
  return isDiscoveryType(action.type)
    ? projectDiscoveryActionSchema.parse(action)
    : projectReadActionSchema.parse(action);
}

/** The action the project service received for the last dispatch. */
function lastServiceAction(): unknown {
  const calls = [
    ...mockDispatchProjectDiscoveryAction.mock.calls,
    ...mockDispatchProjectReadAction.mock.calls,
  ];
  return calls.at(-1)?.[0];
}

function serviceCallCount(): number {
  return (
    mockDispatchProjectDiscoveryAction.mock.calls.length +
    mockDispatchProjectReadAction.mock.calls.length
  );
}

interface SearchedAction {
  type: string;
  notes?: string[];
  fields: { name: string }[];
  requiredFields: string[];
  optionalFields: string[];
  example: Record<string, unknown>;
}

async function search(
  input: object,
  runtime: CanopyInjectedToolRuntime,
): Promise<{ categories: string[]; actions: SearchedAction[] }> {
  const result = await executeCanopyInjectedTool(
    'search_actions',
    input,
    runtime,
  );
  const value: unknown = JSON.parse(result.text);
  if (typeof value !== 'object' || value === null)
    throw new Error('SearchActions returned no object');
  const categories = 'categories' in value ? value.categories : [];
  const found = 'actions' in value ? value.actions : [];
  return {
    categories: Array.isArray(categories)
      ? categories.filter((entry): entry is string => typeof entry === 'string')
      : [],
    actions: Array.isArray(found)
      ? found.filter(
          (entry): entry is SearchedAction =>
            typeof entry === 'object' && entry !== null && 'type' in entry,
        )
      : [],
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDispatchProjectDiscoveryAction.mockResolvedValue({
    ok: true,
    result: { items: [] },
  });
  mockDispatchProjectReadAction.mockResolvedValue({
    ok: true,
    result: { message: null },
  });
});

describe('project discovery exposure', () => {
  it.each(actions)(
    'uses the shared strict parser for $type on both root surfaces',
    async (action) => {
      for (const executionScope of ['worktree', 'directory'] as const)
        await expectStrictRootParse(action, makeRuntime(executionScope));
    },
  );

  async function expectStrictRootParse(
    action: { type: string },
    runtime: CanopyInjectedToolRuntime,
  ): Promise<void> {
    const expected = parsed(action);
    const response = await executeCanopyInjectedTool(
      'dispatch_action',
      { action },
      runtime,
    );
    expect(response.isError).toBe(false);
    expect(lastServiceAction()).toEqual(expected);
    const lastCaller = isDiscoveryType(action.type)
      ? mockDispatchProjectDiscoveryAction.mock.calls.at(-1)?.[1]
      : mockDispatchProjectReadAction.mock.calls.at(-1)?.[1];
    expect(lastCaller).toEqual(caller);
    expect(appAdvisorActionSchema.parse(action)).toEqual(expected);

    const dispatched = serviceCallCount();
    for (const field of [
      'worktreeId',
      'expectedUiRevision',
      'ui',
      'selectedProjectId',
      'unexpected',
    ]) {
      const rejected = await executeCanopyInjectedTool(
        'dispatch_action',
        { action: { ...action, [field]: 'no' } },
        runtime,
      );
      expect(rejected.isError).toBe(true);
      expect(
        appAdvisorActionSchema.safeParse({ ...action, [field]: 'no' }).success,
      ).toBe(false);
    }
    expect(serviceCallCount()).toBe(dispatched);
  }

  it.each(['worktree', 'directory'] as const)(
    'advertises explicit targets in %s catalogs',
    async (executionScope) => {
      const result = await search(
        { category: 'projects', limit: 50 },
        makeRuntime(executionScope),
      );
      expect(result.categories).toContain('projects');
      expect(result.actions.map(({ type }) => type).sort()).toEqual(
        [
          ...PROJECT_DISCOVERY_ACTION_TYPES,
          ...PROJECT_READ_ACTION_TYPES,
          ...PROJECT_MESSAGE_CONTROL_ACTION_TYPES,
          'projects.send_message',
          'projects.create_task',
          'projects.create_task_chat',
        ].sort(),
      );
      const advertised = JSON.stringify(
        executionScope === 'worktree'
          ? dispatchActionJsonSchema
          : coworkDispatchActionJsonSchema,
      );
      for (const action of result.actions) {
        expect(action.notes ?? []).not.toContainEqual(
          expect.stringContaining('Do not provide projectId'),
        );
        const names = action.fields.map(({ name }) => name);
        expect(names).not.toContain('worktreeId');
        expect(names).not.toContain('expectedUiRevision');
        if (action.type !== 'projects.list') {
          expect(action.requiredFields).toContain('projectId');
          expect(action.example.projectId).toEqual(expect.any(String));
        }
        if (PROJECT_READ_ACTION_TYPES.some((type) => type === action.type)) {
          expect(action.requiredFields).toEqual(
            expect.arrayContaining(['projectId', 'taskId', 'chatId']),
          );
          expect(names).toContain('chatId');
        }
        if (action.type === 'projects.list_task_chats')
          expect(action.optionalFields).toContain('taskId');
        expect(advertised).toContain(action.type);
      }
    },
  );

  it('rejects unknown project action types', async () => {
    const runtime = makeRuntime('worktree');
    for (const type of ['projects.foo', 'projects.read_history_extra']) {
      const result = await executeCanopyInjectedTool(
        'dispatch_action',
        { action: { type } },
        runtime,
      );
      expect(result.isError).toBe(true);
    }
    expect(serviceCallCount()).toBe(0);
    expect(JSON.stringify(dispatchActionJsonSchema)).toContain(
      'projects.list_task_chats',
    );
  });

  it.each(actions)(
    'keeps $type outside delegate dispatch and restricted discovery',
    async (action) => {
      expect(DELEGATE_SCRIPT_ACTION_TYPES).not.toContain(action.type);
      const restricted = makeRuntime('worktree', ['worktree.list_scripts']);
      expect(
        (await search({ actionType: action.type }, restricted)).actions,
      ).toEqual([]);
      expect((await search({}, restricted)).categories).not.toContain(
        'projects',
      );
      const result = await executeCanopyInjectedTool(
        'dispatch_action',
        { action },
        restricted,
      );
      expect(result.isError).toBe(true);
      expect(serviceCallCount()).toBe(0);
    },
  );
});

it('rejects project discovery direct calls through the private delegate executor', async () => {
  const delegate = createDelegateCanopyTools(
    {
      projectId: 'origin',
      worktreeId: 'origin-task',
      chatId: 'root-chat',
      delegationId: 'delegate',
      provider: 'codex',
      isolated: false,
      parentCwd: '/repo',
      executionCwd: '/repo',
      codeGraphAvailable: false,
      getWindow: () => null,
      authorizeCommand: jest.fn().mockResolvedValue(true),
    },
    () => Promise.resolve(true),
  );
  const tool = delegate.tools.find((entry) => entry.key === 'dispatch_action');
  expect(tool).toBeDefined();
  if (!tool) throw new Error('Missing delegate DispatchAction');
  for (const action of actions) {
    const result = await delegate.execute(
      tool,
      { action },
      { callId: 'discovery' },
    );
    expect(result.isError).toBe(true);
  }
  expect(serviceCallCount()).toBe(0);
  const isolated = createDelegateCanopyTools(
    {
      projectId: 'origin',
      worktreeId: 'task',
      chatId: 'root-chat',
      delegationId: 'isolated',
      provider: 'codex',
      isolated: true,
      parentCwd: '/repo',
      executionCwd: '/isolated',
      codeGraphAvailable: false,
      getWindow: () => null,
      authorizeCommand: jest.fn().mockResolvedValue(true),
    },
    () => Promise.resolve(true),
  );
  expect(isolated.tools.some((entry) => entry.key === 'dispatch_action')).toBe(
    false,
  );
});

it.each(readActions)(
  'requires the full canonical address for $type',
  async (action) => {
    const runtime = makeRuntime('worktree');
    for (const field of ['projectId', 'taskId', 'chatId']) {
      const incomplete = Object.fromEntries(
        Object.entries(action).filter(([name]) => name !== field),
      );
      const result = await executeCanopyInjectedTool(
        'dispatch_action',
        { action: incomplete },
        runtime,
      );
      expect(result.isError).toBe(true);
      expect(appAdvisorActionSchema.safeParse(incomplete).success).toBe(false);
    }
    expect(serviceCallCount()).toBe(0);
  },
);

it('retains normalized history filters identically on both root surfaces', async () => {
  const action = {
    type: 'projects.read_history',
    projectId: 'target',
    taskId: 'task',
    chatId: 'chat',
    query: ' visible ',
    roles: ['assistant'],
    order: 'asc',
    pageSize: 7,
    cursor: 'opaque',
  };
  const expected = projectReadActionSchema.parse(action);
  expect(expected).toMatchObject({
    query: 'visible',
    order: 'asc',
    pageSize: 7,
    roles: ['assistant'],
    cursor: 'opaque',
  });
  const result = await executeCanopyInjectedTool(
    'dispatch_action',
    { action },
    makeRuntime('directory'),
  );
  expect(result.isError).toBe(false);
  expect(lastServiceAction()).toEqual(expected);
  expect(appAdvisorActionSchema.parse(action)).toEqual(expected);
});
