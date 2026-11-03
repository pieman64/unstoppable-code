/**
 * Characterizes what each automation chat action does on its native path
 * (CAN-4549 Task 1): the request and options its turn is sent with, the
 * Orchestrator window request, sidebar group assignment, worktree creation and
 * disposal, the run result and the `automation_run` watcher payload. The
 * expectations live in `automation-send-parity.ts` so each move reuses them
 * unchanged.
 *
 * `worktree_session_prompt` moved in 5c-1; its native rows (the D4 sends) and
 * its moved route are pinned in `session-prompt-override.characterization.test.ts`.
 * `worktree_prompt` and `standalone_prompt` moved in 5c-2 (CAN-5379). The
 * worktree rows still run natively with `mockSharedPort` off, as the Home
 * composer's scheduled task does (D4), and "through the shared port" proves
 * the moved route sends the same. The Cowork native send is gone, so its rows
 * compare the moved route with the recorded expectation.
 */
import type * as NodeCryptoModule from 'node:crypto';
import type * as PathsModule from '../../lib/paths';
import type * as BackgroundContextModule from '../../services/background-execution-context';
import type * as ChatServiceModule from '../../services/chat-service';
import type * as PreferencesStoreModule from '../../lib/preferences-store';
import type * as LaneResolverModule from '../../lib/default-model-lane-resolver';
import type * as GlobalPluginOverlayModule from '../../plugins/global-plugin-overlay';
import type * as AutomationSendModule from '../automation-send';
import type * as ProjectBotPortModule from '../../agent-actions/desktop-project-bot-port';
import type { PipelineProjectBotOptions } from '../../agent-actions/desktop-project-bot-port';
import type * as ProjectOwnerModule from '../../lib/project-owner';
import type * as CoworkWorkEntriesModule from '../../lib/cowork-work-entries';
import type * as WorkspacePersistenceModule from '../../lib/workspace-persistence';
import { automationDispatchRequestFields } from '../../agent-messaging/automation-dispatch';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  initAgentModels,
  initClaudeModels,
  initCodexModels,
  initModelAliases,
  type AppAdvisorWindowOpenRequest,
  type AutomationAction,
  getExecutionHarnessForModel,
  type AutomationRunResult,
  type ChatSendMessageRequest,
  type PreferencesData,
  type ScheduledActivity,
} from '@canopy/desktop-shared/types';
import type { ShareablePluginMatch } from '../../plugins/shareable-plugin-resolution';
import { AutomationsService } from '../service';
import {
  AUTOMATION_OWNER_MISMATCH_MESSAGE,
  AUTOMATION_SEND_REFUSED_MESSAGE,
} from '../automation-send';
import { AgentChatSendError } from '../../agent-messaging/send-orchestration';
import {
  CLAUDE_DEFAULT_PROMPT_SETTINGS,
  NATIVE_CHAT_ACTION_ERRORS,
  PARITY_FIELDS,
  parityView,
  appAdvisorPromptExpectation,
  standalonePromptExpectation,
  worktreePromptExpectation,
  type ChatActionExpectation,
  type MintedIds,
} from './automation-send-parity';

let mockDir = '';
let mockUuidCount = 0;
let mockContextsEnabled = false;
let mockCursorAvailable = true;
const mockSendWorktree = jest.fn<
  Promise<{ ok: true; chatId: string }>,
  [ChatSendMessageRequest, { executionContext?: string }]
>();
const mockSendStandalone = jest.fn<
  Promise<{
    ok: true;
    chatId: string;
    userMessageId: string;
    workEntryId?: string;
    delivery: 'accepted';
  }>,
  [Record<string, unknown>, { executionContext?: string }]
>();
const mockAssignGroup = jest.fn<Promise<void>, [object]>();
interface CreateWorktreeOptions {
  workspaceId: string;
  onGitReady?: (payload: object) => void;
  onGitSetupSettled?: (payload: {
    projectId: string;
    worktreeId: string;
    outcome: 'ready' | 'cancelled' | 'failed';
  }) => void;
}
const mockCreateWorktree = jest.fn<Promise<object>, [CreateWorktreeOptions]>();
const mockArchiveWorktree = jest.fn<Promise<object>, [object]>();
const mockWatcherEvent = jest.fn<void, [Record<string, unknown>]>();
const mockReadPreferences = jest.fn<Promise<PreferencesData>, []>();
const mockAppAdvisorDefault = jest.fn<Promise<string>, []>();
/** Off: every action takes its native path. On: moved actions take the shared port. */
let mockSharedPort = false;
const mockRunPort = jest.fn<
  Promise<object>,
  [
    { type: string } & Record<string, unknown>,
    object,
    PipelineProjectBotOptions,
  ]
>();
const mockWorkEntryIds = jest.fn<Promise<string[]>, [string]>();
/** The saved owner of an automation's target, read when no context is bound. */
let mockTargetOwner: { kind: string } = { kind: 'personal' };

jest.mock('../automation-send', () => {
  const actual =
    jest.requireActual<typeof AutomationSendModule>('../automation-send');
  return {
    ...actual,
    staysNativeAutomationSend: (
      activity: Parameters<typeof actual.staysNativeAutomationSend>[0],
    ): boolean => !mockSharedPort || actual.staysNativeAutomationSend(activity),
  };
});
jest.mock('../../agent-actions/desktop-project-bot-port', () => ({
  ...jest.requireActual<typeof ProjectBotPortModule>(
    '../../agent-actions/desktop-project-bot-port',
  ),
  runPipelineProjectBotAction: (
    ...args: Parameters<typeof mockRunPort>
  ): Promise<object> => mockRunPort(...args),
}));
jest.mock('../../lib/project-owner', () => ({
  ...jest.requireActual<typeof ProjectOwnerModule>('../../lib/project-owner'),
  resolveProjectSavedOwner: (): Promise<object> =>
    Promise.resolve(mockTargetOwner),
}));
jest.mock('../../lib/cowork-work-entries', () => ({
  ...jest.requireActual<typeof CoworkWorkEntriesModule>(
    '../../lib/cowork-work-entries',
  ),
  listWorkEntryIds: (projectId: string): Promise<string[]> =>
    mockWorkEntryIds(projectId),
}));

jest.mock('node:crypto', () => ({
  ...jest.requireActual<typeof NodeCryptoModule>('node:crypto'),
  randomUUID: (): string => {
    mockUuidCount += 1;
    return `00000000-0000-4000-8000-${String(mockUuidCount).padStart(12, '0')}`;
  },
}));
jest.mock('../../lib/paths', () => ({
  ...jest.requireActual<typeof PathsModule>('../../lib/paths'),
  getDataDir: (): string => mockDir,
  getAutomationsFilePath: (): string => join(mockDir, 'automations.json'),
}));
jest.mock('../../lib/resource-context', () => ({
  resourceContextEnabled: (): boolean => false,
}));
jest.mock('../../services/background-execution-context', () => ({
  ...jest.requireActual<typeof BackgroundContextModule>(
    '../../services/background-execution-context',
  ),
  backgroundExecutionContextEnabled: (): boolean => mockContextsEnabled,
  captureBackgroundExecutionContext: (): Promise<undefined> =>
    Promise.resolve(undefined),
  automationContextRefusal: (): Promise<null> => Promise.resolve(null),
  describeAutomationContextMismatch: (): Promise<null> => Promise.resolve(null),
  authorizeBackgroundExecution: (): Promise<object> =>
    Promise.resolve({ allow: true }),
}));
jest.mock('../../lib/sidebar-items', () => ({
  readAllSidebarItems: (): Promise<object> =>
    Promise.resolve({
      items: [
        {
          type: 'single-repo',
          id: 'workspace-1',
          repoPath: '/repo',
          worktrees: [{ id: 'worktree-1' }],
        },
        { type: 'cowork', id: 'cowork-1', worktrees: [] },
      ],
    }),
}));
jest.mock('../../services/chat-service', () => ({
  ...jest.requireActual<typeof ChatServiceModule>(
    '../../services/chat-service',
  ),
  sendWorktreeChatMessage: (
    request: ChatSendMessageRequest,
    options: { executionContext?: string },
  ): Promise<{ ok: true; chatId: string }> =>
    mockSendWorktree(request, options),
}));
jest.mock('../../services/standalone-chat-service', () => ({
  sendStandaloneChatMessage: (
    request: Record<string, unknown>,
    options: { executionContext?: string },
  ): Promise<object> => mockSendStandalone(request, options),
}));
jest.mock('../../services/sidebar-item-groups-service', () => ({
  sidebarItemGroupsService: {
    assignItemToNamedGroup: (args: object): Promise<void> =>
      mockAssignGroup(args),
  },
}));
jest.mock('../../lib/worktree-service', () => ({
  createSingleRepoWorktree: (options: CreateWorktreeOptions): object =>
    mockCreateWorktree(options),
  createMultiRepoWorktree: (options: CreateWorktreeOptions): object =>
    mockCreateWorktree(options),
  archiveSingleRepoWorktree: (args: object): object =>
    mockArchiveWorktree(args),
  archiveMultiRepoWorktree: (args: object): object => mockArchiveWorktree(args),
}));
jest.mock('../../app-advisor/watchers', () => ({
  getAppAdvisorWatcherService: (): object => ({
    handleAutomationRunEvent: (event: Record<string, unknown>): void =>
      mockWatcherEvent(event),
  }),
}));
jest.mock('../../lib/preferences-store', () => ({
  ...jest.requireActual<typeof PreferencesStoreModule>(
    '../../lib/preferences-store',
  ),
  peekPreferencesLoadError: (): null => null,
  readPreferencesFile: (): Promise<PreferencesData> => mockReadPreferences(),
}));
jest.mock('../../lib/default-model-lane-resolver', () => ({
  ...jest.requireActual<typeof LaneResolverModule>(
    '../../lib/default-model-lane-resolver',
  ),
  resolveAppAdvisorDefaultModel: (): Promise<string> => mockAppAdvisorDefault(),
  resolveOptionalLaneAwareDefaultSelection: (): Promise<object> => {
    const selection = { model: 'sonnet', thinkingLevel: 'high' };
    return Promise.resolve({ selection, requireModel: () => selection });
  },
}));
jest.mock('../../lib/approvals-persistence', () => ({
  readWorkspaceApprovals: (): Promise<object> =>
    Promise.resolve({ version: 1, rules: [] }),
}));
jest.mock('../../lib/workspace-approvals-manifest', () => ({
  readWorkspaceApprovalsManifest: (): Promise<object> =>
    Promise.resolve({ rules: [] }),
}));
jest.mock('../../plugins/shareable-plugin-resolution', () => ({
  loadShareablePluginCatalog: (): Promise<object> =>
    Promise.resolve({ skills: [], marketplaces: [] }),
  resolveShareablePluginRefs: (): ShareablePluginMatch[] => [],
}));
jest.mock('../../plugins/global-plugin-overlay', () => ({
  ...jest.requireActual<typeof GlobalPluginOverlayModule>(
    '../../plugins/global-plugin-overlay',
  ),
  resolveBackgroundChatPluginSelections: (local: unknown): Promise<unknown> =>
    Promise.resolve(local),
}));
jest.mock('../../lib/configured-prompt-resolution', () => ({
  resolveConfiguredPrompt: (args: { prompt: string }): Promise<object> =>
    Promise.resolve({ prompt: args.prompt }),
}));
jest.mock('../../cursor/runtime-availability', () => ({
  isCursorRuntimeAvailable: (): Promise<boolean> =>
    Promise.resolve(mockCursorAvailable),
}));

const mockEnsureAdvisor = jest.fn<
  Promise<{ open: boolean; focused: boolean }>,
  [AppAdvisorWindowOpenRequest?]
>();

function service(): AutomationsService {
  const result = new AutomationsService();
  result.configure({
    getMainWindow: () => null,
    getAppAdvisorWindow: () => null,
    openAppAdvisorWindow: mockEnsureAdvisor,
    ensureAppAdvisorWindow: mockEnsureAdvisor,
    sendAppAdvisorWindowCommand: jest.fn(),
  });
  return result;
}

const NOW = '2026-10-28T00:00:00.000Z';

function storedActivity(
  name: string,
  action: AutomationAction,
  overrides: Partial<ScheduledActivity> = {},
): ScheduledActivity {
  return {
    version: 1,
    id: 'automation-1',
    name,
    enabled: false,
    schedule: {
      kind: 'one_time',
      runAt: '2099-01-01T00:00:00.000Z',
      timezone: 'local',
    },
    action,
    createdAt: NOW,
    updatedAt: NOW,
    failureCount: 0,
    ...overrides,
  };
}

async function seed(activity: ScheduledActivity): Promise<void> {
  await writeFile(
    join(mockDir, 'automations.json'),
    JSON.stringify({
      version: 1,
      updatedAt: NOW,
      activities: [activity],
      recentRuns: [],
    }),
    'utf8',
  );
}

interface Observed {
  status: string;
  error?: string;
  result?: AutomationRunResult;
  dispatched?: unknown;
}

async function flushWatchers(): Promise<void> {
  for (let turn = 0; turn < 20; turn++) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

/** A Run now: the user's own run. */
async function runNow(
  name: string,
  action: AutomationAction,
  overrides: Partial<ScheduledActivity> = {},
): Promise<Observed> {
  await seed(storedActivity(name, action, overrides));
  const result = await service().runNow({ id: 'automation-1' });
  if (!result.ok || !result.run) throw new Error(JSON.stringify(result));
  await flushWatchers();
  return observed(result.run);
}

/** A scheduled run, dispatched by the due check behind the current tab. */
async function runScheduled(
  name: string,
  action: AutomationAction,
): Promise<Observed> {
  await seed(
    storedActivity(name, action, {
      enabled: true,
      schedule: {
        kind: 'one_time',
        runAt: new Date(Date.now() - 1_000).toISOString(),
        timezone: 'local',
      },
    }),
  );
  const instance = service();
  await instance.start();
  try {
    for (let attempt = 0; attempt < 200; attempt++) {
      const [run] = (await instance.list()).recentRuns;
      if (run && run.status !== 'running') {
        // The automation_run event follows the run record and can lag a fixed
        // flush when every suite runs in parallel.
        for (
          let wait = 0;
          wait < 500 && mockWatcherEvent.mock.calls.length === 0;
          wait++
        )
          await new Promise((resolve) => setTimeout(resolve, 10));
        await flushWatchers();
        return observed(run);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('The scheduled run did not finish.');
  } finally {
    instance.stop();
  }
}

function observed(run: {
  status: string;
  error?: string;
  result?: AutomationRunResult;
}): Observed {
  const event = mockWatcherEvent.mock.calls.at(-1)?.[0];
  return {
    status: run.status,
    ...(run.error === undefined ? {} : { error: run.error }),
    ...(run.result === undefined ? {} : { result: run.result }),
    ...(event && 'dispatched' in event ? { dispatched: event.dispatched } : {}),
  };
}

beforeAll(() => {
  initClaudeModels([{ id: 'sonnet', label: 'Claude Sonnet' }]);
  initCodexModels([{ id: 'gpt-5.5', label: 'GPT 5.5' }]);
  initModelAliases({ 'claude-sonnet-4-6': 'sonnet' });
});

beforeEach(async () => {
  mockDir = await mkdtemp(join(tmpdir(), 'chat-actions-characterization-'));
  mockUuidCount = 0;
  mockSharedPort = false;
  mockTargetOwner = { kind: 'personal' };
  mockContextsEnabled = false;
  mockCursorAvailable = true;
  jest.clearAllMocks();
  jest
    .spyOn(
      jest.requireActual<typeof WorkspacePersistenceModule>(
        '../../lib/workspace-persistence',
      ),
      'readWorkspaceWorktreesDetailed',
    )
    .mockResolvedValue({ authority: 'ok', worktrees: [] });
  initAgentModels([]);
  mockSendWorktree.mockImplementation((request) =>
    Promise.resolve({ ok: true, chatId: request.chatId ?? 'starter-chat' }),
  );
  mockSendStandalone.mockImplementation((request) =>
    Promise.resolve({
      ok: true,
      chatId: String(request.chatId),
      userMessageId: 'standalone-message-1',
      ...(request.workEntryId === undefined
        ? { workEntryId: 'entry-new' }
        : {}),
      delivery: 'accepted',
    }),
  );
  mockAssignGroup.mockResolvedValue(undefined);
  mockCreateWorktree.mockImplementation((options) => {
    options.onGitReady?.({
      projectId: options.workspaceId,
      worktreeId: 'worktree-new',
      branchName: 'worktree-new',
    });
    options.onGitSetupSettled?.({
      projectId: options.workspaceId,
      worktreeId: 'worktree-new',
      outcome: 'ready',
    });
    return Promise.resolve({
      id: 'worktree-new',
      branchName: 'worktree-new',
      createdAt: NOW,
    });
  });
  mockArchiveWorktree.mockResolvedValue({ success: true, warnings: [] });
  mockEnsureAdvisor.mockResolvedValue({ open: true, focused: false });
  mockReadPreferences.mockResolvedValue({
    ...jest.requireActual<typeof PreferencesStoreModule>(
      '../../lib/preferences-store',
    ).DEFAULT_PREFERENCES,
    appAdvisorModel: 'gpt-5.5',
  });
  mockAppAdvisorDefault.mockResolvedValue('claude-sonnet-4-6');
  mockRunPort.mockImplementation(createdChatReceipt);
  mockWorkEntryIds.mockResolvedValue(['entry-1']);
});

afterEach(async () => {
  jest.restoreAllMocks();
  await rm(mockDir, { recursive: true, force: true });
});

const MINTED = /^00000000-0000-4000-8000-\d{12}$/;

/** The IDs the action minted, read back from what it sent. */
function minted(chatId: unknown, userMessageId: unknown): MintedIds {
  if (typeof userMessageId !== 'string') throw new Error('No message ID.');
  expect(userMessageId).toMatch(MINTED);
  if (chatId === undefined) return { userMessageId };
  if (typeof chatId !== 'string') throw new Error('No chat ID.');
  expect(chatId).toMatch(MINTED);
  expect(chatId).not.toBe(userMessageId);
  return { chatId, userMessageId };
}

function expectGroup(expected: ChatActionExpectation['groupAssignment']): void {
  if (!expected) {
    expect(mockAssignGroup).not.toHaveBeenCalled();
    return;
  }
  expect(mockAssignGroup).toHaveBeenCalledTimes(1);
  expect(mockAssignGroup.mock.calls[0][0]).toMatchObject(expected);
}

function expectRun(run: Observed, expected: ChatActionExpectation): void {
  expect(run).toStrictEqual({
    status: 'success',
    result: expected.result,
    dispatched: expected.dispatched,
  });
  expectGroup(expected.groupAssignment);
}

function expectNothingSent(): void {
  expect(mockSendWorktree).not.toHaveBeenCalled();
  expect(mockSendStandalone).not.toHaveBeenCalled();
  expect(mockEnsureAdvisor).not.toHaveBeenCalled();
  expect(mockRunPort).not.toHaveBeenCalled();
}

/** The receipt of a chat the shared port created at the run's planned IDs. */
function createdChatReceipt(
  action: { type: string } & Record<string, unknown>,
  _caller: object,
  options: PipelineProjectBotOptions,
): Promise<object> {
  const createsTask =
    action.type === 'projects.create_task' ||
    action.type === 'bots.create_task';
  const taskId = createsTask ? options.plannedTaskId : action.taskId;
  const address = {
    projectId: action.projectId ?? action.botId,
    taskId,
    chatId: createsTask ? taskId : options.fixedIds?.tabId,
  };
  return Promise.resolve({
    address,
    taskCreated: createsTask,
    chatCreated: true,
    input: {
      address,
      acceptedAt: NOW,
      watcherReceipts: [],
      disposition: 'started',
      messageId: options.fixedIds?.userMessageId,
    },
  });
}

/** The one shared-port creation the run dispatched. */
function portCreation(): {
  action: { type: string } & Record<string, unknown>;
  caller: object;
  options: PipelineProjectBotOptions;
} {
  expect(mockRunPort).toHaveBeenCalledTimes(1);
  const [action, caller, options] = mockRunPort.mock.calls[0];
  return { action, caller, options };
}

/**
 * The turn settings a moved creation states, in the native request's terms.
 * A new chat's harness follows its model and its thinking level is its model
 * config's, as `resolveAutomationPromptModelSettings` made the native ones.
 */
function seededSettings(
  options: PipelineProjectBotOptions,
): Record<string, unknown> {
  const seed = options.newChatSeed ?? {};
  return {
    planMode: seed.planMode,
    ...(seed.model !== undefined
      ? {
          model: seed.model,
          executionHarness: getExecutionHarnessForModel(seed.model),
        }
      : {}),
    providerType: seed.providerType,
    modelConfig: seed.modelConfig,
    thinkingLevel: seed.modelConfig?.thinkingLevel,
    approvalMode: seed.approvalMode,
    ...(seed.pluginSelections
      ? { pluginSelections: seed.pluginSelections }
      : {}),
    ...(seed.interfaceMode ? { interfaceMode: seed.interfaceMode } : {}),
    ...automationDispatchRequestFields(options.automationDispatch),
  };
}

/** A moved `worktree_prompt`'s request, minus its run-specific IDs. */
function composedWorktreeRequest(
  action: Record<string, unknown>,
  options: PipelineProjectBotOptions,
): Record<string, unknown> {
  return parityView(
    {
      projectId: action.projectId,
      worktreeId: action.taskId,
      text: action.initialMessage,
      fileReferences: options.composition?.fileReferences,
      ...seededSettings(options),
    },
    PARITY_FIELDS.filter(
      (field) => field !== 'chatId' && field !== 'userMessageId',
    ),
  );
}

/** A moved `standalone_prompt`'s request, in `sendStandaloneChatMessage`'s shape. */
function composedStandaloneRequest(
  action: Record<string, unknown>,
  options: PipelineProjectBotOptions,
  chatId: string,
): Record<string, unknown> {
  const settings = seededSettings(options);
  const { automationDispatch: _block, ...requestSettings } = settings;
  void _block;
  return {
    chatId,
    message: action.initialMessage,
    fileReferences: options.composition?.fileReferences,
    projectLocalId: action.projectId,
    ...(action.type === 'projects.create_task_chat'
      ? { workEntryId: action.taskId }
      : {}),
    ...requestSettings,
  };
}

/** The one worktree send, and the IDs the action minted for it. */
function worktreeSend(): {
  request: ChatSendMessageRequest;
  options: { executionContext?: string };
  ids: MintedIds;
} {
  expect(mockSendWorktree).toHaveBeenCalledTimes(1);
  const [request, options] = mockSendWorktree.mock.calls[0];
  return {
    request,
    options: { executionContext: options.executionContext },
    ids: minted(request.chatId, request.userMessageId),
  };
}

const PROMPT = {
  type: 'worktree_prompt',
  workspaceId: 'workspace-1',
  prompt: 'Implement',
  model: 'gpt-5.5',
} as const satisfies AutomationAction;

describe('worktree_prompt on its native path', () => {
  it.each([
    {
      label: 'a new worktree from a base branch, with a group',
      action: { ...PROMPT, baseBranch: 'main', sidebarGroupName: 'Build' },
      created: { baseBranch: 'main' },
      group: { itemId: 'worktree-new', name: 'Build' },
    },
    {
      label: 'a new worktree from an existing branch',
      action: { ...PROMPT, existingBranch: 'feature/x' },
      created: { existingBranch: 'feature/x' },
      group: null,
    },
    {
      label: 'a worktree stacked on a base worktree, which cannot join a group',
      action: {
        ...PROMPT,
        baseWorktreeId: 'worktree-1',
        sidebarGroupName: 'Build',
      },
      created: { baseWorktreeId: 'worktree-1' },
      group: null,
    },
  ])('$label: reuses the starter chat', async ({ action, created, group }) => {
    const run = await runNow('Build prompt', action);
    const { request, options, ids } = worktreeSend();
    // No `chatId`: the send reuses the fresh worktree's empty starter chat.
    expect(ids.chatId).toBeUndefined();
    const expected = worktreePromptExpectation({
      ids,
      worktreeId: 'worktree-new',
      sentChatId: 'starter-chat',
      automationName: 'Build prompt',
      groupAssignment: group,
    });
    expect(request).toStrictEqual(expected.request);
    expect(options).toStrictEqual(expected.options);
    expectRun(run, expected);
    expect(mockCreateWorktree).toHaveBeenCalledTimes(1);
    expect(mockCreateWorktree.mock.calls[0][0]).toMatchObject({
      workspaceId: 'workspace-1',
      existingWorktreeIds: ['worktree-1'],
      deferGitSetup: true,
      ...created,
    });
    expect(mockArchiveWorktree).not.toHaveBeenCalled();
  });

  it('gives an existing worktree a new chat and no group', async () => {
    const run = await runNow('Build prompt', {
      ...PROMPT,
      existingWorktreeId: 'worktree-1',
      sidebarGroupName: 'Build',
    });
    const { request, options, ids } = worktreeSend();
    expect(ids.chatId).toBeDefined();
    const expected = worktreePromptExpectation({
      ids,
      worktreeId: 'worktree-1',
      sentChatId: ids.chatId ?? '',
      automationName: 'Build prompt',
    });
    expect(request).toStrictEqual(expected.request);
    expect(options).toStrictEqual(expected.options);
    expectRun(run, expected);
    expect(mockCreateWorktree).not.toHaveBeenCalled();
  });

  it('sends plan mode, an approval and plugin selections', async () => {
    const run = await runNow('Build prompt', {
      ...PROMPT,
      existingWorktreeId: 'worktree-1',
      planMode: true,
      approvalMode: 'auto',
      pluginSelections: {
        collectionIds: ['c'],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
    });
    const { request, ids } = worktreeSend();
    const expected = worktreePromptExpectation({
      ids,
      worktreeId: 'worktree-1',
      sentChatId: ids.chatId ?? '',
      automationName: 'Build prompt',
      request: {
        planMode: true,
        approvalMode: 'auto',
        pluginSelections: {
          collectionIds: ['c'],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [],
          mcpHttpAuthPreferences: [],
        },
      },
    });
    expect(request).toStrictEqual(expected.request);
    expectRun(run, expected);
  });

  it('sends a Claude interface mode and drops it on Codex', async () => {
    await runNow('Build prompt', {
      ...PROMPT,
      model: 'sonnet',
      interfaceMode: 'claude-code',
    });
    const claude = worktreeSend();
    expect(claude.request).toStrictEqual(
      worktreePromptExpectation({
        ids: claude.ids,
        worktreeId: 'worktree-new',
        sentChatId: 'starter-chat',
        automationName: 'Build prompt',
        request: {
          ...CLAUDE_DEFAULT_PROMPT_SETTINGS,
          interfaceMode: 'claude-code',
        },
      }).request,
    );
    mockSendWorktree.mockClear();
    await runNow('Build prompt', { ...PROMPT, interfaceMode: 'claude-code' });
    const codex = worktreeSend();
    expect(codex.request).not.toHaveProperty('interfaceMode');
  });

  it('keeps the Home composer’s scheduled task on the same request', async () => {
    const run = await runNow('Build prompt', {
      ...PROMPT,
      purpose: 'scheduled_task',
    });
    const { request, ids } = worktreeSend();
    const expected = worktreePromptExpectation({
      ids,
      worktreeId: 'worktree-new',
      sentChatId: 'starter-chat',
      automationName: 'Build prompt',
    });
    expect(request).toStrictEqual(expected.request);
    expectRun(run, expected);
  });

  it('keeps a scheduled run’s chat behind the current tab', async () => {
    const run = await runScheduled('Build prompt', PROMPT);
    const { request, options, ids } = worktreeSend();
    const expected = worktreePromptExpectation({
      ids,
      worktreeId: 'worktree-new',
      sentChatId: 'starter-chat',
      automationName: 'Build prompt',
      request: { preserveActiveTab: true },
    });
    expect(request).toStrictEqual(expected.request);
    expect(options).toStrictEqual(expected.options);
    expectRun(run, expected);
  });

  it('disposes of the fresh worktree when Cursor is disconnected', async () => {
    mockCursorAvailable = false;
    const run = await runNow('Build prompt', {
      ...PROMPT,
      model: 'cursor-default',
    });
    expect(run).toStrictEqual({
      status: 'failure',
      error: NATIVE_CHAT_ACTION_ERRORS.cursorDisconnected,
    });
    expectNothingSent();
    expect(mockArchiveWorktree).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      worktreeId: 'worktree-new',
      expectedCreatedAt: NOW,
      retainAsArchivedContainer: false,
      sourceAdmission: 'required',
    });
  });

  it('sends nothing when the worktree cannot be created', async () => {
    mockCreateWorktree.mockRejectedValue(new Error('Worktree setup failed.'));
    const run = await runNow('Build prompt', PROMPT);
    expect(run).toStrictEqual({
      status: 'failure',
      error: 'Worktree setup failed.',
    });
    expectNothingSent();
    expect(mockArchiveWorktree).not.toHaveBeenCalled();
    expect(mockAssignGroup).not.toHaveBeenCalled();
  });

  it('keeps the worktree when the send fails after it started', async () => {
    mockSendWorktree.mockRejectedValue(new Error('The chat could not start.'));
    const run = await runNow('Build prompt', PROMPT);
    expect(run).toStrictEqual({
      status: 'failure',
      error: 'The chat could not start.',
    });
    expect(mockSendWorktree).toHaveBeenCalledTimes(1);
    expect(mockArchiveWorktree).not.toHaveBeenCalled();
  });
});

/** The run IDs a moved worktree creation used, read from the port call. */
function sharedRunIds(options: PipelineProjectBotOptions): {
  chatId: string;
  userMessageId: string;
} {
  const chatId = options.fixedIds?.tabId;
  const userMessageId = options.fixedIds?.userMessageId;
  if (chatId === undefined || userMessageId === undefined)
    throw new Error('The creation carries no run IDs.');
  return { chatId, userMessageId };
}

/** The moved route's request fields compared with the native send's. */
const WORKTREE_PARITY_FIELDS = PARITY_FIELDS.filter(
  (field) => field !== 'chatId' && field !== 'userMessageId',
);

describe('worktree_prompt through the shared port (CAN-5379)', () => {
  /**
   * Runs the action natively, then through the shared port, and returns both
   * sends with each route's group assignments and worktree disposals.
   */
  async function nativeThenShared(
    action: AutomationAction,
    start: typeof runNow = runNow,
  ): Promise<{
    native: {
      run: Observed;
      request: ChatSendMessageRequest;
      options: { executionContext?: string };
      groups: object[];
    };
    shared: {
      run: Observed;
      action: Record<string, unknown>;
      options: PipelineProjectBotOptions;
      groups: object[];
    };
  }> {
    mockSharedPort = false;
    const nativeRun = await start('Build prompt', action);
    const { request, options } = worktreeSend();
    const nativeGroups = mockAssignGroup.mock.calls.map(([args]) => args);
    jest.clearAllMocks();
    mockSharedPort = true;
    const sharedRun = await start('Build prompt', action);
    const creation = portCreation();
    return {
      native: { run: nativeRun, request, options, groups: nativeGroups },
      shared: {
        run: sharedRun,
        action: creation.action,
        options: creation.options,
        groups: mockAssignGroup.mock.calls.map(([args]) => args),
      },
    };
  }

  function expectSameSend(
    native: Awaited<ReturnType<typeof nativeThenShared>>['native'],
    shared: Awaited<ReturnType<typeof nativeThenShared>>['shared'],
  ): void {
    expect(
      composedWorktreeRequest(shared.action, shared.options),
    ).toStrictEqual(parityView(native.request, WORKTREE_PARITY_FIELDS));
    expect(shared.options.automationDispatch?.executionContext).toBe(
      native.options.executionContext,
    );
    expect(shared.groups).toStrictEqual(native.groups);
    // Each route keeps its own run's chat and message IDs.
    const ids = sharedRunIds(shared.options);
    const result = {
      projectId: native.run.result?.projectId,
      worktreeId: native.run.result?.worktreeId,
      chatId: ids.chatId,
      userMessageId: ids.userMessageId,
    };
    expect(shared.run).toStrictEqual({
      status: 'success',
      result,
      dispatched: result,
    });
  }

  it.each([
    {
      label: 'a new worktree from a base branch, with a group',
      action: { ...PROMPT, baseBranch: 'main', sidebarGroupName: 'Build' },
    },
    {
      label: 'a new worktree from an existing branch',
      action: { ...PROMPT, existingBranch: 'feature/x' },
    },
    {
      label: 'a stacked worktree, which cannot join a group',
      action: {
        ...PROMPT,
        baseWorktreeId: 'worktree-1',
        sidebarGroupName: 'Build',
      },
    },
  ])(
    '$label: one chat in the fresh worktree, replacing its blank starter',
    async ({ action }) => {
      const { native, shared } = await nativeThenShared(action);
      expectSameSend(native, shared);
      expect(shared.action).toStrictEqual({
        type: 'projects.create_task_chat',
        projectId: 'workspace-1',
        taskId: 'worktree-new',
        initialMessage: 'Implement',
      });
      expect(shared.options.reuseStarterChat).toBe(true);
      expect(mockCreateWorktree).toHaveBeenCalledTimes(1);
      expect(mockArchiveWorktree).not.toHaveBeenCalled();
    },
  );

  it('gives an existing worktree a new chat beside its others', async () => {
    const { native, shared } = await nativeThenShared({
      ...PROMPT,
      existingWorktreeId: 'worktree-1',
      sidebarGroupName: 'Build',
    });
    expectSameSend(native, shared);
    expect(shared.action).toMatchObject({ taskId: 'worktree-1' });
    expect(shared.options).not.toHaveProperty('reuseStarterChat');
    expect(mockCreateWorktree).not.toHaveBeenCalled();
  });

  it('sends plan mode, an approval and plugin selections', async () => {
    const { native, shared } = await nativeThenShared({
      ...PROMPT,
      existingWorktreeId: 'worktree-1',
      planMode: true,
      approvalMode: 'auto',
      pluginSelections: {
        collectionIds: ['c'],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
    });
    expectSameSend(native, shared);
  });

  it.each([
    { label: 'keeps a Claude interface mode', model: 'sonnet' },
    { label: 'drops an interface mode on Codex', model: 'gpt-5.5' },
  ])('$label', async ({ model }) => {
    const { native, shared } = await nativeThenShared({
      ...PROMPT,
      model,
      interfaceMode: 'claude-code',
    });
    expectSameSend(native, shared);
  });

  it('keeps a scheduled run’s chat behind the current tab', async () => {
    const { native, shared } = await nativeThenShared(PROMPT, (name, action) =>
      runScheduled(name, action),
    );
    expect(native.request.preserveActiveTab).toBe(true);
    expect(shared.options.automationDispatch?.presentation).toBe('background');
    expectSameSend(native, shared);
  });

  it('disposes of the fresh worktree when Cursor is disconnected', async () => {
    mockSharedPort = true;
    mockCursorAvailable = false;
    const run = await runNow('Build prompt', {
      ...PROMPT,
      model: 'cursor-default',
    });
    expect(run).toStrictEqual({
      status: 'failure',
      error: NATIVE_CHAT_ACTION_ERRORS.cursorDisconnected,
    });
    expectNothingSent();
    expect(mockArchiveWorktree).toHaveBeenCalledTimes(1);
  });

  it('disposes of the fresh worktree when its owner cannot be resolved before the send', async () => {
    mockSharedPort = true;
    mockTargetOwner = { kind: 'unknown' };
    const run = await runNow('Build prompt', PROMPT);
    expect(run).toStrictEqual({
      status: 'failure',
      error: AUTOMATION_OWNER_MISMATCH_MESSAGE,
    });
    expectNothingSent();
    expect(mockArchiveWorktree).toHaveBeenCalledTimes(1);
  });

  it('keeps the worktree when the creation fails after it started', async () => {
    mockSharedPort = true;
    mockRunPort.mockRejectedValue(new Error('The chat could not start.'));
    const run = await runNow('Build prompt', PROMPT);
    expect(run).toStrictEqual({
      status: 'failure',
      error: 'The chat could not start.',
    });
    expect(mockRunPort).toHaveBeenCalledTimes(1);
    expect(mockArchiveWorktree).not.toHaveBeenCalled();
  });

  it('keeps the Home composer’s scheduled task on its native send (D4)', async () => {
    mockSharedPort = true;
    await runNow('Build prompt', { ...PROMPT, purpose: 'scheduled_task' });
    expect(mockSendWorktree).toHaveBeenCalledTimes(1);
    expect(mockRunPort).not.toHaveBeenCalled();
  });
});

const NOTES = {
  type: 'standalone_prompt',
  chatProjectId: 'cowork-1',
  prompt: 'Organize notes',
  model: 'gpt-5.5',
} as const satisfies AutomationAction;

/**
 * The one Cowork creation the run dispatched, in the native send's shape, and
 * the chat it named: a new Work Entry's founding chat shares the run's planned
 * task ID, as the native send's entry shared its chat's ID.
 */
function standaloneCreation(): {
  request: Record<string, unknown>;
  options: PipelineProjectBotOptions;
  ids: { chatId: string };
  sentUserMessageId: string;
} {
  const { action, options } = portCreation();
  const chatId =
    action.type === 'projects.create_task'
      ? options.plannedTaskId
      : options.fixedIds?.tabId;
  const sentUserMessageId = options.fixedIds?.userMessageId;
  if (typeof chatId !== 'string' || typeof sentUserMessageId !== 'string')
    throw new Error('The creation carries no run IDs.');
  return {
    request: composedStandaloneRequest(action, options, chatId),
    options,
    ids: { chatId },
    sentUserMessageId,
  };
}

describe('standalone_prompt through the shared port (CAN-5379)', () => {
  beforeEach(() => {
    mockSharedPort = true;
  });

  it('creates a Work Entry and puts it in the named group', async () => {
    const run = await runNow('Notes prompt', {
      ...NOTES,
      sidebarGroupName: 'Notes',
    });
    const { request, options, ids, sentUserMessageId } = standaloneCreation();
    const expected = standalonePromptExpectation({
      ids,
      sentUserMessageId,
      groupAssignment: { itemId: ids.chatId, name: 'Notes' },
    });
    expect(portCreation().action).toStrictEqual({
      type: 'projects.create_task',
      projectId: 'cowork-1',
      initialMessage: 'Organize notes',
    });
    // The entry gets no title: the native send titled it from its chat.
    expect(request).toStrictEqual(expected.request);
    expect(options.automationDispatch?.executionContext).toBe(
      expected.options.executionContext,
    );
    expectRun(run, expected);
    expect(mockAssignGroup.mock.calls[0][0]).toStrictEqual({
      scope: { workspaceLocalId: 'cowork-1' },
      itemId: ids.chatId,
      name: 'Notes',
    });
  });

  it('sends into an existing Work Entry without a group', async () => {
    const run = await runNow('Notes prompt', {
      ...NOTES,
      workEntryId: 'entry-1',
      sidebarGroupName: 'Notes',
    });
    const { request, ids, sentUserMessageId } = standaloneCreation();
    const expected = standalonePromptExpectation({
      ids,
      sentUserMessageId,
      request: { workEntryId: 'entry-1' },
    });
    expect(portCreation().action).toStrictEqual({
      type: 'projects.create_task_chat',
      projectId: 'cowork-1',
      taskId: 'entry-1',
      initialMessage: 'Organize notes',
    });
    expect(request).toStrictEqual(expected.request);
    expectRun(run, expected);
  });

  it('keeps the native text for a deleted Work Entry and creates nothing', async () => {
    mockWorkEntryIds.mockResolvedValue([]);
    const run = await runNow('Notes prompt', {
      ...NOTES,
      workEntryId: 'entry-gone',
    });
    expect(run).toStrictEqual({
      status: 'failure',
      error: NATIVE_CHAT_ACTION_ERRORS.workEntryUnavailable,
    });
    expectNothingSent();
    expect(mockAssignGroup).not.toHaveBeenCalled();
  });

  it('runs on the chat lane default with the Cowork approval default', async () => {
    const run = await runNow('Notes prompt', {
      type: 'standalone_prompt',
      chatProjectId: 'cowork-1',
      prompt: 'Organize notes',
    });
    const { request, ids, sentUserMessageId } = standaloneCreation();
    const expected = standalonePromptExpectation({
      ids,
      sentUserMessageId,
      request: { ...CLAUDE_DEFAULT_PROMPT_SETTINGS },
    });
    expect(request).toStrictEqual(expected.request);
    expectRun(run, expected);
  });

  it('sends added plugins and leaves inherited defaults to the chat', async () => {
    await runNow('Notes prompt', {
      ...NOTES,
      pluginSelections: {
        collectionIds: ['c'],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
    });
    const { request, ids, sentUserMessageId } = standaloneCreation();
    expect(request).toStrictEqual(
      standalonePromptExpectation({
        ids,
        sentUserMessageId,
        request: {
          pluginSelections: {
            collectionIds: ['c'],
            skillRefs: [],
            pluginRefs: [],
            mcpServerRefs: [],
            mcpHttpAuthPreferences: [],
          },
        },
      }).request,
    );
  });

  it('sends a scheduled run in the foreground, as the native send did', async () => {
    const run = await runScheduled('Notes prompt', NOTES);
    const { request, options, ids, sentUserMessageId } = standaloneCreation();
    const expected = standalonePromptExpectation({ ids, sentUserMessageId });
    expect(request).toStrictEqual(expected.request);
    expect(request).not.toHaveProperty('preserveActiveTab');
    expect(options.automationDispatch?.presentation).toBe('foreground');
    expectRun(run, expected);
  });

  it('refuses Cursor before anything is created', async () => {
    mockCursorAvailable = false;
    const run = await runNow('Notes prompt', {
      ...NOTES,
      model: 'cursor-default',
    });
    expect(run).toStrictEqual({
      status: 'failure',
      error: NATIVE_CHAT_ACTION_ERRORS.cursorDisconnected,
    });
    expectNothingSent();
  });
});

const ADVISOR = {
  type: 'app_advisor_prompt',
  prompt: 'Review the app',
} as const satisfies AutomationAction;

/**
 * The one Orchestrator creation the run dispatched, in the native quick
 * prompt's shape. A new Work Entry is the run's planned task, and its founding
 * chat shares the ID, as the native quick prompt's entry shared its chat's.
 */
function advisorCreation(): {
  request: Record<string, unknown>;
  options: PipelineProjectBotOptions;
  ids: Required<MintedIds>;
} {
  const { action, options } = portCreation();
  const chatId =
    action.type === 'bots.create_task'
      ? options.plannedTaskId
      : options.fixedIds?.tabId;
  const userMessageId = options.fixedIds?.userMessageId;
  if (typeof chatId !== 'string' || typeof userMessageId !== 'string')
    throw new Error('The creation carries no run IDs.');
  const seed = options.newChatSeed ?? {};
  const fields = automationDispatchRequestFields(options.automationDispatch);
  const group = mockAssignGroup.mock.calls.find(
    ([args]) =>
      JSON.stringify(Reflect.get(args, 'scope')) === '{"appAdvisor":true}',
  )?.[0];
  return {
    request: {
      quickPrompt: action.initialMessage,
      quickPromptFileReferences: options.composition?.fileReferences,
      quickPromptPlanMode: seed.planMode,
      ...(action.type === 'bots.create_task'
        ? { quickPromptTitle: action.title }
        : { quickPromptWorkEntryId: action.taskId }),
      quickPromptChatId: chatId,
      ...(group
        ? { quickPromptSidebarGroupName: Reflect.get(group, 'name') }
        : {}),
      quickPromptUserMessageId: userMessageId,
      quickPromptModel: seed.model,
      quickPromptProviderType: seed.providerType,
      quickPromptModelConfig: seed.modelConfig,
      quickPromptThinkingLevel: seed.modelConfig?.thinkingLevel,
      quickPromptInitiationSource: fields.initiationSource,
      quickPromptAutomationName: fields.automationName,
      ...(seed.pluginSelections
        ? { quickPromptPluginSelections: seed.pluginSelections }
        : {}),
      ...(fields.packageOverlay
        ? { quickPromptPackageOverlay: fields.packageOverlay }
        : {}),
      quickPromptApprovalMode: seed.approvalMode,
    },
    options,
    ids: { chatId, userMessageId },
  };
}

/** The Orchestrator window is brought up with no quick prompt of its own. */
/**
 * The Orchestrator window is brought up with no quick prompt of its own, then
 * selects the run's chat once it is accepted, as the quick prompt selected it.
 */
function expectAdvisorWindowOn(chatId: string): void {
  expect(mockEnsureAdvisor.mock.calls).toStrictEqual([[], [{ chatId }]]);
}

describe('app_advisor_prompt through the shared port (CAN-5380)', () => {
  beforeEach(() => {
    mockSharedPort = true;
  });

  it.each([
    { label: 'Run now', run: runNow },
    { label: 'a scheduled run', run: runScheduled },
  ])(
    '$label: creates the titled Work Entry and its chat with the whole prompt',
    async ({ run: start }) => {
      const run = await start('Advisor prompt', {
        ...ADVISOR,
        model: 'gpt-5.5',
        sidebarGroupName: 'Reviews',
        planMode: true,
      });
      const { request, options, ids } = advisorCreation();
      const expected = appAdvisorPromptExpectation({
        ids,
        request: {
          quickPromptPlanMode: true,
          quickPromptSidebarGroupName: 'Reviews',
        },
      });
      expect(portCreation().action).toStrictEqual({
        type: 'bots.create_task',
        botId: 'app_advisor',
        title: 'Advisor prompt',
        initialMessage: 'Review the app',
      });
      expect(request).toStrictEqual(expected.request);
      // The quick prompt always brought its chat forward in the window.
      expect(options.automationDispatch?.presentation).toBe('foreground');
      expect(options.surfaces).toBeDefined();
      expectAdvisorWindowOn(ids.chatId);
      expect(run).toStrictEqual({
        status: 'success',
        result: expected.result,
        dispatched: expected.dispatched,
      });
      expect(mockAssignGroup.mock.calls[0][0]).toStrictEqual({
        scope: { appAdvisor: true },
        itemId: ids.chatId,
        name: 'Reviews',
      });
    },
  );

  it('cuts an automation name over the title limit for its Work Entry', async () => {
    const name = 'n'.repeat(250);
    await runNow(name, { ...ADVISOR, model: 'gpt-5.5' });
    const { action, options } = portCreation();
    expect(action.title).toBe(`${'n'.repeat(199)}…`);
    // The sender and banner keep the whole name.
    expect(options.automationDispatch?.automationName).toBe(name);
  });

  it('sends into an existing Work Entry with no group, and never retitles it', async () => {
    mockWorkEntryIds.mockResolvedValue(['advisor-entry-1']);
    const run = await runNow('Advisor prompt', {
      ...ADVISOR,
      model: 'gpt-5.5',
      workEntryId: 'advisor-entry-1',
      sidebarGroupName: 'Reviews',
    });
    const { request, ids } = advisorCreation();
    const expected = appAdvisorPromptExpectation({
      ids,
      request: { quickPromptWorkEntryId: 'advisor-entry-1' },
    });
    // A targeted entry was never retitled, so its creation names no title.
    const { quickPromptTitle: _title, ...untitled } = expected.request;
    void _title;
    expect(request).toStrictEqual(untitled);
    expect(portCreation().action).toStrictEqual({
      type: 'bots.create_task_chat',
      botId: 'app_advisor',
      taskId: 'advisor-entry-1',
      initialMessage: 'Review the app',
    });
    expectRun(run, expected);
    expectAdvisorWindowOn(ids.chatId);
  });

  it('keeps the native text for a Work Entry that is gone and creates nothing', async () => {
    mockWorkEntryIds.mockResolvedValue([]);
    const run = await runNow('Advisor prompt', {
      ...ADVISOR,
      model: 'gpt-5.5',
      workEntryId: 'advisor-entry-unknown',
    });
    expect(run).toStrictEqual({
      status: 'failure',
      error: 'Unknown App Advisor work entry advisor-entry-unknown.',
    });
    expectNothingSent();
  });

  it('runs an inheriting Agent on the model a new Orchestrator chat starts on', async () => {
    initAgentModels([
      {
        id: 'agent_model_inherit',
        name: 'Inherit',
        baseModel: 'default',
        instructions: '',
        pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
        createdAt: NOW,
        updatedAt: NOW,
        available: true,
      },
    ]);
    await runNow('Advisor prompt', {
      ...ADVISOR,
      model: 'agent_model_inherit',
    });
    const { request, ids } = advisorCreation();
    expect(request).toStrictEqual(
      appAdvisorPromptExpectation({
        ids,
        request: {
          quickPromptModel: 'agent_model_inherit@claude-sonnet-4-6',
          quickPromptProviderType: 'claude',
        },
      }).request,
    );
    expect(mockAppAdvisorDefault).toHaveBeenCalledTimes(1);
  });

  // The quick prompt trimmed its text, as `index.ts` sent it to the window.
  it('sends the prompt trimmed, as the quick prompt did', async () => {
    await runNow('Advisor prompt', {
      ...ADVISOR,
      model: 'gpt-5.5',
      prompt: '  Review the app\n',
    });
    expect(portCreation().action.initialMessage).toBe('Review the app');
  });

  it('refuses Cursor before the window opens', async () => {
    mockCursorAvailable = false;
    const run = await runNow('Advisor prompt', {
      ...ADVISOR,
      model: 'cursor-default',
    });
    expect(run).toStrictEqual({
      status: 'failure',
      error: NATIVE_CHAT_ACTION_ERRORS.cursorDisconnected,
    });
    expectNothingSent();
  });

  // Named delta: the native quick prompt recorded success when the window took
  // the prompt, before the Orchestrator accepted it. A refused send now fails
  // the run.
  it('fails the run when the Orchestrator refuses the message', async () => {
    mockRunPort.mockRejectedValue(
      new AgentChatSendError('target_not_ready', 'The chat is busy.'),
    );
    const run = await runNow('Advisor prompt', {
      ...ADVISOR,
      model: 'gpt-5.5',
    });
    expect(run).toStrictEqual({
      status: 'failure',
      error: `${AUTOMATION_SEND_REFUSED_MESSAGE} The chat is busy.`,
    });
  });
});

// Review Focus 2: the run's tab lineage with background contexts on and off.
describe('an organization automation’s tab lineage', () => {
  const ORG = 'org:5f0c7a4e-1b2d-4c3e-9f8a-0b1c2d3e4f5a';

  it.each([
    { contexts: true, executionContext: ORG },
    { contexts: false, executionContext: 'personal' },
  ])(
    'with background contexts $contexts: $executionContext',
    async ({ contexts, executionContext }) => {
      mockContextsEnabled = contexts;
      const run = await runNow(
        'Org prompt',
        { ...PROMPT, existingWorktreeId: 'worktree-1' },
        { enabled: true, executionContext: ORG },
      );
      const { request, options, ids } = worktreeSend();
      const expected = worktreePromptExpectation({
        ids,
        worktreeId: 'worktree-1',
        sentChatId: ids.chatId ?? '',
        automationName: 'Org prompt',
        executionContext,
      });
      expect(request).toStrictEqual(expected.request);
      expect(options).toStrictEqual(expected.options);
      expectRun(run, expected);
    },
  );

  it.each([
    {
      contexts: true,
      executionContext: ORG,
      owner: {
        kind: 'organization',
        organizationId: '5f0c7a4e-1b2d-4c3e-9f8a-0b1c2d3e4f5a',
      },
    },
    // With no bound context, the owner is the target project's own.
    {
      contexts: false,
      executionContext: 'personal',
      owner: { kind: 'personal' },
    },
  ])(
    'through the shared port with background contexts $contexts: $executionContext',
    async ({ contexts, executionContext, owner }) => {
      mockContextsEnabled = contexts;
      mockSharedPort = true;
      const run = await runNow(
        'Org prompt',
        { ...PROMPT, existingWorktreeId: 'worktree-1' },
        { enabled: true, executionContext: ORG },
      );
      expect(run.status).toBe('success');
      const { caller, options } = portCreation();
      expect(options.automationDispatch?.executionContext).toBe(
        executionContext,
      );
      expect(caller).toMatchObject({
        kind: 'pipeline',
        source: { kind: 'automation', owner },
      });
    },
  );
});
