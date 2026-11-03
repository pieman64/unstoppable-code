/**
 * Characterizes the per-turn settings a `worktree_session_prompt` automation
 * sends with its message: the exact `sendWorktreeChatMessage` request for each
 * kind of saved setting. These pin today's behavior so the resolution can move
 * into `agent-messaging/turn-override.ts` without changing it.
 *
 * Since CAN-4549 only D4 sends keep that native request; an automation's own
 * send goes through the shared project and bot port. The resolution is shared,
 * so the rows below run on the native route (`mockSharedPort` off) with their
 * values unchanged, and "through the shared port" pins the moved route.
 */
import type * as SidebarModule from '../../lib/sidebar-items';
import type * as PathsModule from '../../lib/paths';
import type * as BackgroundContextModule from '../../services/background-execution-context';
import type * as ChatServiceModule from '../../services/chat-service';
import type * as ChatTabsReaderModule from '../../lib/chat-tabs-reader';
import type * as PreferencesStoreModule from '../../lib/preferences-store';
import type * as LaneResolverModule from '../../lib/default-model-lane-resolver';
import type * as GlobalPluginOverlayModule from '../../plugins/global-plugin-overlay';
import type * as AutomationSendModule from '../automation-send';
import type * as ProjectBotPortModule from '../../agent-actions/desktop-project-bot-port';
import type { PipelineProjectBotOptions } from '../../agent-actions/desktop-project-bot-port';
import { AgentChatSendError } from '../../agent-messaging/send-orchestration';
import type * as ProjectOwnerModule from '../../lib/project-owner';
import type * as UsageLimitedRegistryModule from '../../lib/usage-limited-chats-registry';
import type * as UsageLimitedIpcModule from '../../ipc/usage-limited-chats';
import { automationDispatchRequestFields } from '../../agent-messaging/automation-dispatch';
import { APP_ADVISOR_BOT_ID } from '@canopy/desktop-shared/lib/bot-discovery';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  APP_ADVISOR_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
  initAgentModels,
  initClaudeModels,
  initCodexModels,
  initModelAliases,
  type ChatSendMessageRequest,
  type ChatTabPluginSelections,
  type ChatTabsFile,
  type PersistedChatTab,
  type PreferencesData,
  type ScheduledActivity,
} from '@canopy/desktop-shared/types';
import type { ShareablePluginMatch } from '../../plugins/shareable-plugin-resolution';
import { AutomationsService } from '../service';
import {
  CODEX_TAB_OPTIONS,
  RUNTIME_RESET,
  codexTab,
  envelope,
  sessionAction,
  type SessionAction,
} from './session-prompt-override.fixtures';
import {
  AUTOMATION_OWNED_PARITY_FIELDS,
  INTENDED_DELTAS,
  parityView,
} from './automation-send-parity';

let mockDir = '';
let mockTab: PersistedChatTab | undefined;
const mockSend = jest.fn<
  Promise<{ ok: true; chatId: string }>,
  [ChatSendMessageRequest]
>();
const mockReadPreferences = jest.fn<Promise<PreferencesData>, []>();
const mockReadWorkspaceApprovals = jest.fn<
  Promise<{ version: 1; rules: []; defaultMode?: string }>,
  [string]
>();
const mockReadWorkspaceApprovalsManifest = jest.fn<
  Promise<{ rules: []; defaultMode?: string }>,
  [string]
>();
const mockResolveRefs = jest.fn<ShareablePluginMatch[], []>();
const mockAssertOpenCodeModelAvailable = jest.fn<
  Promise<void>,
  [string | undefined]
>();
const mockPromptSelections = jest.fn<ChatTabPluginSelections | undefined, []>();
let mockSharedPort = false;
let mockOpenCodeGeneration = 0;
/** Runs while the automation's owner resolves, after resolution. */
let mockOnOwnerResolve: () => void = () => undefined;
const mockRunPort = jest.fn<
  Promise<object>,
  Required<Parameters<typeof ProjectBotPortModule.runPipelineProjectBotAction>>
>();
const mockEnsureAdvisor = jest.fn();
const mockSendOptions = jest.fn<void, [{ executionContext?: string }]>();
const mockWatcherEvent = jest.fn<void, [Record<string, unknown>]>();
const mockAdmitScheduled = jest.fn<Promise<void>, []>();
const mockUsageLimitedChats = jest.fn<Promise<object[]>, []>();
const mockResumeUsageLimited = jest.fn<
  Promise<{ resumedCount: number }>,
  [object, unknown, string]
>();

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
  admitScheduledProjectMessage: (): Promise<void> => mockAdmitScheduled(),
}));
jest.mock('../../lib/usage-limited-chats-registry', () => ({
  ...jest.requireActual<typeof UsageLimitedRegistryModule>(
    '../../lib/usage-limited-chats-registry',
  ),
  readUsageLimitedChats: (): Promise<object[]> => mockUsageLimitedChats(),
}));
jest.mock('../../ipc/usage-limited-chats', () => ({
  ...jest.requireActual<typeof UsageLimitedIpcModule>(
    '../../ipc/usage-limited-chats',
  ),
  handleResumeUsageLimitedChats: (
    request: object,
    getWindow: unknown,
    userMessageId: string,
  ): Promise<{ resumedCount: number }> =>
    mockResumeUsageLimited(request, getWindow, userMessageId),
}));
jest.mock('../../lib/project-owner', () => ({
  ...jest.requireActual<typeof ProjectOwnerModule>('../../lib/project-owner'),
  resolveProjectSavedOwner: (): Promise<object> => {
    mockOnOwnerResolve();
    return Promise.resolve({ kind: 'personal' });
  },
}));

jest.mock('../../lib/paths', () => ({
  ...jest.requireActual<typeof PathsModule>('../../lib/paths'),
  getDataDir: (): string => mockDir,
  getAutomationsFilePath: (): string => join(mockDir, 'automations.json'),
  getAutomationRunArchiveFilePath: (id: string): string =>
    join(mockDir, 'automation-runs', `${id}.jsonl`),
}));
jest.mock('../../lib/resource-context', () => ({
  resourceContextEnabled: (): boolean => false,
}));
jest.mock('../../services/background-execution-context', () => ({
  ...jest.requireActual<typeof BackgroundContextModule>(
    '../../services/background-execution-context',
  ),
  backgroundExecutionContextEnabled: (): boolean => false,
  captureBackgroundExecutionContext: (): Promise<undefined> =>
    Promise.resolve(undefined),
  automationContextRefusal: (): Promise<null> => Promise.resolve(null),
  describeAutomationContextMismatch: (): Promise<null> => Promise.resolve(null),
}));
jest.mock('../../lib/sidebar-items', () => ({
  getWorkspaceIndexRepository: (): ReturnType<
    typeof SidebarModule.getWorkspaceIndexRepository
  > =>
    jest
      .requireActual<typeof SidebarModule>('../../lib/sidebar-items')
      .getWorkspaceIndexRepository(),
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
jest.mock('../../lib/chat-tabs-reader', () => ({
  ...jest.requireActual<typeof ChatTabsReaderModule>(
    '../../lib/chat-tabs-reader',
  ),
  readChatTabsFile: (): Promise<ChatTabsFile> =>
    Promise.resolve({
      version: 1,
      tabs: mockTab ? [mockTab] : [],
      activeTabId: mockTab?.id ?? '',
    }),
}));
jest.mock('../../services/chat-service', () => ({
  // `buildExistingTabDispatchOptions` stays real: the override is computed
  // against the tab as it reads at run time.
  ...jest.requireActual<typeof ChatServiceModule>(
    '../../services/chat-service',
  ),
  sendWorktreeChatMessage: (
    request: ChatSendMessageRequest,
    options: { executionContext?: string },
  ): Promise<{ ok: true; chatId: string }> => {
    mockSendOptions(options);
    return mockSend(request);
  },
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
  requireLaneAwareDefaultSelection: (): Promise<object> =>
    Promise.resolve({ model: 'claude-sonnet-4-6', thinkingLevel: 'high' }),
}));
jest.mock('../../lib/approvals-persistence', () => ({
  readWorkspaceApprovals: (projectId: string): Promise<object> =>
    mockReadWorkspaceApprovals(projectId),
}));
jest.mock('../../lib/workspace-approvals-manifest', () => ({
  readWorkspaceApprovalsManifest: (projectId: string): Promise<object> =>
    mockReadWorkspaceApprovalsManifest(projectId),
}));
jest.mock('../../plugins/shareable-plugin-resolution', () => ({
  loadShareablePluginCatalog: (): Promise<object> =>
    Promise.resolve({ skills: [], marketplaces: [] }),
  resolveShareablePluginRefs: (): ShareablePluginMatch[] => mockResolveRefs(),
}));
jest.mock('../../plugins/global-plugin-overlay', () => ({
  ...jest.requireActual<typeof GlobalPluginOverlayModule>(
    '../../plugins/global-plugin-overlay',
  ),
  resolveBackgroundChatPluginSelections: (
    local: ChatTabPluginSelections | undefined,
  ): Promise<ChatTabPluginSelections | undefined> => Promise.resolve(local),
}));
jest.mock('../../lib/configured-prompt-resolution', () => ({
  resolveConfiguredPrompt: (args: { prompt: string }): Promise<object> => {
    const referencedPluginSelections = mockPromptSelections();
    return Promise.resolve({
      prompt: args.prompt,
      ...(referencedPluginSelections ? { referencedPluginSelections } : {}),
    });
  },
}));
jest.mock('../../opencode/connection', () => ({
  getOpenCodeConnectionGeneration: (): number => mockOpenCodeGeneration,
  assertOpenCodeConnectionGeneration: (expected: number): void => {
    if (expected !== mockOpenCodeGeneration)
      throw new Error('OpenCode connection changed. Try again.');
  },
  assertOpenCodeModelAvailable: (model: string | undefined): Promise<void> =>
    mockAssertOpenCodeModelAvailable(model),
}));
jest.mock('../../cursor/runtime-availability', () => ({
  isCursorRuntimeAvailable: (): Promise<boolean> => Promise.resolve(false),
}));

function service(): AutomationsService {
  const result = new AutomationsService();
  result.configure({
    getMainWindow: () => null,
    getAppAdvisorWindow: () => null,
    openAppAdvisorWindow: jest.fn(),
    ensureAppAdvisorWindow: mockEnsureAdvisor,
    sendAppAdvisorWindowCommand: jest.fn(),
  });
  return result;
}

async function create(
  instance: AutomationsService,
  action: SessionAction,
): Promise<string> {
  const created = await instance.create({
    name: 'Session settings',
    enabled: false,
    schedule: {
      kind: 'one_time',
      runAt: '2099-01-01T00:00:00.000Z',
      timezone: 'local',
    },
    action,
  });
  if (!created.ok || !created.activity)
    throw new Error(JSON.stringify(created));
  return created.activity.id;
}

async function runAndCapture(
  instance: AutomationsService,
  id: string,
): Promise<ChatSendMessageRequest> {
  const result = await instance.runNow({ id });
  if (!result.ok || !result.run) throw new Error(JSON.stringify(result));
  expect(result.run).toMatchObject({ status: 'success' });
  expect(mockSend).toHaveBeenCalledTimes(1);
  return mockSend.mock.calls[0][0];
}

async function sent(
  action: SessionAction,
  tab: PersistedChatTab = codexTab(),
): Promise<ChatSendMessageRequest> {
  mockTab = tab;
  const instance = service();
  return runAndCapture(instance, await create(instance, action));
}

async function refused(
  action: SessionAction,
  tab: PersistedChatTab,
): Promise<string | undefined> {
  mockTab = tab;
  const instance = service();
  const result = await instance.runNow({ id: await create(instance, action) });
  if (!result.ok || !result.run) throw new Error(JSON.stringify(result));
  expect(result.run.status).toBe('failure');
  expect(mockSend).not.toHaveBeenCalled();
  return result.run.error;
}

beforeAll(() => {
  initClaudeModels([{ id: 'sonnet', label: 'Claude Sonnet' }]);
  initCodexModels([
    { id: 'gpt-5.5', label: 'GPT 5.5' },
    { id: 'gpt-5.4', label: 'GPT 5.4' },
  ]);
  initModelAliases({ 'claude-sonnet-4-6': 'sonnet' });
});

beforeEach(async () => {
  mockDir = await mkdtemp(join(tmpdir(), 'session-prompt-override-'));
  mockTab = undefined;
  mockSharedPort = false;
  mockOpenCodeGeneration = 0;
  mockOnOwnerResolve = (): void => undefined;
  jest.clearAllMocks();
  initAgentModels([]);
  mockSend.mockImplementation((request) =>
    Promise.resolve({ ok: true, chatId: request.chatId ?? '' }),
  );
  mockReadPreferences.mockResolvedValue({
    ...jest.requireActual<typeof PreferencesStoreModule>(
      '../../lib/preferences-store',
    ).DEFAULT_PREFERENCES,
    providerModelConfigDefaults: { codex: { fastMode: false } },
  });
  mockReadWorkspaceApprovals.mockResolvedValue({ version: 1, rules: [] });
  mockReadWorkspaceApprovalsManifest.mockResolvedValue({ rules: [] });
  mockResolveRefs.mockReturnValue([]);
  mockAssertOpenCodeModelAvailable.mockResolvedValue(undefined);
  mockPromptSelections.mockReturnValue(undefined);
});

afterEach(async () => {
  await rm(mockDir, { recursive: true, force: true });
});

describe('worktree_session_prompt per-turn settings', () => {
  it('sends the chat as it is when the automation saves no settings', async () => {
    const request = await sent(sessionAction());
    expect(request).toStrictEqual({
      ...envelope(request),
      ...CODEX_TAB_OPTIONS,
    });
    expect(mockReadWorkspaceApprovals).not.toHaveBeenCalled();
  });

  it('switches to another model on the same harness and clears the session', async () => {
    const request = await sent(sessionAction({ model: 'gpt-5.4' }));
    expect(request).toStrictEqual({
      ...envelope(request),
      ...CODEX_TAB_OPTIONS,
      ...RUNTIME_RESET,
      providerType: 'codex',
      executionHarness: 'codex',
      model: 'gpt-5.4',
      modelConfig: { thinkingLevel: 'xhigh', fastMode: true, speed: 'fast' },
    });
  });

  it('keeps the session when the saved model is the chat model', async () => {
    const request = await sent(sessionAction({ model: 'gpt-5.5' }));
    expect(request).toStrictEqual({
      ...envelope(request),
      ...CODEX_TAB_OPTIONS,
      model: 'gpt-5.5',
      modelConfig: { thinkingLevel: 'xhigh', fastMode: true, speed: 'fast' },
    });
  });

  it('switches to another provider with its own settings and clears the runtime', async () => {
    const request = await sent(
      sessionAction({ model: 'sonnet', modelConfig: { thinkingLevel: 'low' } }),
    );
    expect(request).toStrictEqual({
      ...envelope(request),
      ...CODEX_TAB_OPTIONS,
      ...RUNTIME_RESET,
      providerType: 'claude',
      executionHarness: 'claude',
      model: 'sonnet',
      modelConfig: { thinkingLevel: 'low', fastMode: false, speed: 'standard' },
    });
  });

  it('merges a saved model config over the chat config', async () => {
    const request = await sent(
      sessionAction({ modelConfig: { thinkingLevel: 'low' } }),
    );
    expect(request).toStrictEqual({
      ...envelope(request),
      ...CODEX_TAB_OPTIONS,
      modelConfig: { thinkingLevel: 'low', fastMode: true, speed: 'fast' },
    });
  });

  it('pins an inheriting Agent to the workspace default', async () => {
    initAgentModels([
      {
        id: 'agent_model_inherit',
        name: 'Inherit',
        baseModel: 'default',
        instructions: '',
        pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
        createdAt: '2026-10-12T00:00:00.000Z',
        updatedAt: '2026-10-12T00:00:00.000Z',
        available: true,
      },
    ]);
    const request = await sent(sessionAction({ model: 'agent_model_inherit' }));
    expect(request).toStrictEqual({
      ...envelope(request),
      ...CODEX_TAB_OPTIONS,
      ...RUNTIME_RESET,
      providerType: 'claude',
      executionHarness: 'claude',
      model: 'agent_model_inherit@claude-sonnet-4-6',
      modelConfig: {
        thinkingLevel: 'high',
        fastMode: false,
        speed: 'standard',
      },
    });
  });

  it('sends a saved plan mode', async () => {
    const request = await sent(sessionAction({ planMode: true }));
    expect(request).toStrictEqual({
      ...envelope(request),
      ...CODEX_TAB_OPTIONS,
      planMode: true,
    });
  });

  it('resolves a saved approval mode through the workspace and manifest defaults', async () => {
    mockReadWorkspaceApprovals.mockResolvedValue({
      version: 1,
      rules: [],
      defaultMode: 'full-access',
    });
    mockReadWorkspaceApprovalsManifest.mockResolvedValue({
      rules: [],
      defaultMode: 'ask',
    });
    const request = await sent(sessionAction({ approvalMode: 'auto' }));
    expect(request).toStrictEqual({
      ...envelope(request),
      ...CODEX_TAB_OPTIONS,
      approvalMode: 'auto',
    });
    expect(mockReadWorkspaceApprovals).toHaveBeenCalledWith('workspace-1');
    expect(mockReadWorkspaceApprovalsManifest).toHaveBeenCalledWith(
      'workspace-1',
    );
  });

  it('adds matched plugin refs, direct selections and prompt references, skipping unmatched refs', async () => {
    mockResolveRefs.mockReturnValue([
      {
        matchState: 'matched',
        ref: {
          type: 'skill',
          source: { type: 'builtin', id: 'app' },
          skill_name: 'a',
        },
        catalogKey: 'skill:a',
        selection: { kind: 'skill', sourceId: 'app', skillName: 'a' },
      },
      {
        matchState: 'unmatched',
        ref: {
          type: 'skill',
          source: { type: 'builtin', id: 'app' },
          skill_name: 'b',
        },
        displayName: 'b',
        displaySource: 'app',
      },
      {
        matchState: 'matched',
        ref: {
          type: 'skill',
          source: { type: 'builtin', id: 'app' },
          skill_name: 'c',
        },
        catalogKey: 'plugin:c',
        selection: { kind: 'plugin', marketplaceId: 'm', pluginName: 'c' },
      },
    ]);
    mockPromptSelections.mockReturnValue({
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [{ marketplaceId: 'm', pluginName: 'referenced' }],
      mcpServerRefs: [],
    });
    const request = await sent(
      sessionAction({
        plugins: [
          {
            type: 'skill',
            source: { type: 'builtin', id: 'app' },
            skill_name: 'a',
          },
        ],
        pluginSelections: {
          collectionIds: ['direct-collection'],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [],
        },
      }),
    );
    expect(request).toStrictEqual({
      ...envelope(request),
      ...CODEX_TAB_OPTIONS,
      pluginSelections: {
        collectionIds: ['tab-collection', 'direct-collection'],
        skillRefs: [{ sourceId: 'app', skillName: 'a' }],
        pluginRefs: [
          { marketplaceId: 'm', pluginName: 'c' },
          { marketplaceId: 'm', pluginName: 'referenced' },
        ],
        mcpServerRefs: [],
        mcpHttpAuthPreferences: [],
      },
    });
  });

  it('refuses a Cursor model before sending', async () => {
    expect(
      await refused(sessionAction({ model: 'cursor-default' }), codexTab()),
    ).toBe(
      'Scheduled messages are not available for Cursor chats. Choose another model.',
    );
  });

  it('refuses an unavailable OpenCode model before sending', async () => {
    mockAssertOpenCodeModelAvailable.mockRejectedValue(
      new Error('This OpenCode model is unavailable. Choose another model.'),
    );
    expect(
      await refused(
        sessionAction(),
        codexTab({
          model: 'opencode:fixture%2Fmodel',
          providerType: 'opencode',
          executionHarness: 'opencode',
        }),
      ),
    ).toBe('This OpenCode model is unavailable. Choose another model.');
    expect(mockAssertOpenCodeModelAvailable).toHaveBeenCalledWith(
      'opencode:fixture%2Fmodel',
    );
  });

  // Review Focus 4: the override is computed against the chat as it is at
  // run time and spread over the chat's own settings, so a chat that changed
  // model after the automation was saved still runs with the saved settings.
  it('applies the saved model over a chat that changed provider after the automation was saved', async () => {
    mockTab = codexTab();
    const instance = service();
    const id = await create(
      instance,
      sessionAction({ model: 'gpt-5.5', planMode: true }),
    );
    mockTab = codexTab({
      model: 'sonnet',
      providerType: 'claude',
      executionHarness: 'claude',
      modelConfig: { thinkingLevel: 'high' },
      sdkSessionId: 'claude-session',
      codexReconstructionSeedId: undefined,
    });
    const request = await runAndCapture(instance, id);
    expect(request).toStrictEqual({
      ...envelope(request),
      ...CODEX_TAB_OPTIONS,
      ...RUNTIME_RESET,
      providerType: 'codex',
      executionHarness: 'codex',
      model: 'gpt-5.5',
      // A provider change drops the chat's config; the new provider's
      // defaults resolve over the saved settings.
      modelConfig: {
        thinkingLevel: 'high',
        fastMode: false,
        speed: 'standard',
      },
      planMode: true,
    });
  });

  it('keeps the session of a chat that moved onto the saved model after the automation was saved', async () => {
    mockTab = codexTab({
      model: 'sonnet',
      providerType: 'claude',
      executionHarness: 'claude',
      modelConfig: { thinkingLevel: 'high' },
    });
    const instance = service();
    const id = await create(instance, sessionAction({ model: 'gpt-5.5' }));
    mockTab = codexTab({ sdkSessionId: 'thread-2' });
    const request = await runAndCapture(instance, id);
    expect(request).toStrictEqual({
      ...envelope(request),
      ...CODEX_TAB_OPTIONS,
      sdkSessionId: 'thread-2',
      model: 'gpt-5.5',
      modelConfig: { thinkingLevel: 'xhigh', fastMode: true, speed: 'fast' },
    });
  });
});

describe('worktree_session_prompt through the shared port (CAN-4549)', () => {
  function accepted(chatId = 'chat-1'): object {
    return {
      address: { projectId: 'workspace-1', taskId: 'worktree-1', chatId },
      acceptedAt: '2026-10-28T00:00:00.000Z',
      watcherReceipts: [],
      disposition: 'started',
      messageId: 'accepted-1',
    };
  }

  beforeEach(() => {
    mockSharedPort = true;
    mockRunPort.mockResolvedValue(accepted());
  });

  async function runShared(
    action: SessionAction,
    /** `null`: the chat no longer exists. */
    tab: PersistedChatTab | null = codexTab(),
  ): Promise<{
    run: { status: string; error?: string; result?: object; id: string };
    id: string;
  }> {
    mockTab = codexTab();
    const instance = service();
    const id = await create(instance, action);
    // The chat as it reads at run time.
    mockTab = tab ?? undefined;
    const result = await instance.runNow({ id });
    if (!result.ok || !result.run) throw new Error(JSON.stringify(result));
    return { run: result.run, id };
  }

  it('sends a project chat prompt as the automation, with its native facts', async () => {
    const { run, id } = await runShared(sessionAction());
    expect(run.status).toBe('success');
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockRunPort).toHaveBeenCalledTimes(1);
    const [action, caller, options] = mockRunPort.mock.calls[0];
    expect(action).toStrictEqual({
      type: 'projects.send_message',
      projectId: 'workspace-1',
      taskId: 'worktree-1',
      chatId: 'chat-1',
      text: 'Continue',
    });
    expect(caller).toStrictEqual({
      kind: 'pipeline',
      source: {
        kind: 'automation',
        automationId: id,
        automationName: 'Session settings',
        owner: { kind: 'personal' },
      },
    });
    expect(options).toMatchObject({
      composition: {
        fileReferences: undefined,
        attachmentPaths: undefined,
        attachmentPromptContexts: undefined,
        inputMode: 'typed',
      },
      // Run now is the user's own: its chat comes forward.
      automationDispatch: {
        version: 1,
        automationName: 'Session settings',
        presentation: 'foreground',
        executionContext: 'personal',
      },
      turnOverride: { version: 1 },
    });
    expect(options.surfaces).toBeUndefined();
    expect(options.fixedIds?.userMessageId).toMatch(/^automation-/);
    expect(run.result).toStrictEqual({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      userMessageId: options.fixedIds?.userMessageId,
    });
  });

  it('carries a runtime switch on the turn override', async () => {
    await runShared(sessionAction({ model: 'gpt-5.4', planMode: true }));
    const [, , options] = mockRunPort.mock.calls[0];
    expect(options.turnOverride).toMatchObject({
      version: 1,
      model: 'gpt-5.4',
      resetRuntime: true,
      planMode: true,
    });
  });

  it('keeps a composer scheduled send on the native path (D4)', async () => {
    const { run } = await runShared(
      sessionAction({ purpose: 'scheduled_send' }),
    );
    expect(run.status).toBe('success');
    expect(mockRunPort).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0].agentSent).toBeUndefined();
  });

  // The shared port resolves only indexed projects; a session prompt saved
  // against a legacy standalone chat project keeps its native send.
  it('keeps a legacy standalone-addressed session prompt on the native path', async () => {
    const { run } = await runShared(
      sessionAction({
        workspaceId: STANDALONE_CHAT_PROJECT_ID,
        worktreeId: 'cowork-1',
      }),
    );
    expect(run.status).toBe('success');
    expect(mockRunPort).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0].projectId).toBe(
      STANDALONE_CHAT_PROJECT_ID,
    );
  });

  it('keeps today’s text for a missing chat and dispatches nothing', async () => {
    const { run } = await runShared(sessionAction(), null);
    expect(run.status).toBe('failure');
    // The target compatibility check reads the chat before the action runs.
    expect(run.error).toBe('Choose an existing chat in the automation editor.');
    expect(mockRunPort).not.toHaveBeenCalled();
  });

  it('keeps today’s text for an archived chat and dispatches nothing', async () => {
    const { run } = await runShared(
      sessionAction(),
      codexTab({ readOnly: true }),
    );
    expect(run.error).toBe(
      'That chat is archived and cannot receive automation messages. Edit this automation and pick another destination.',
    );
    expect(mockRunPort).not.toHaveBeenCalled();
  });

  // Every writer of `staleSessionDetected` also sets `readOnly`, so an expired
  // session is refused by the service's own check, never by the port.
  it('keeps today’s text for an expired session and dispatches nothing', async () => {
    const { run } = await runShared(
      sessionAction(),
      codexTab({
        readOnly: true,
        staleSessionDetected: { droppedMessageText: 'Continue' },
      }),
    );
    expect(run.error).toBe(
      'That chat is archived and cannot receive automation messages. Edit this automation and pick another destination.',
    );
    expect(mockRunPort).not.toHaveBeenCalled();
  });

  it('refuses an OpenCode send whose connection changes while its owner resolves', async () => {
    mockOnOwnerResolve = (): void => {
      mockOpenCodeGeneration += 1;
    };
    const { run } = await runShared(
      sessionAction(),
      codexTab({
        model: 'opencode:fixture%2Fmodel',
        providerType: 'opencode',
        executionHarness: 'opencode',
      }),
    );
    expect(run.status).toBe('failure');
    expect(run.error).toBe('OpenCode connection changed. Try again.');
    expect(mockRunPort).not.toHaveBeenCalled();
  });

  it.each(['inventory', 'after inventory', 'during config'] as const)(
    'persists storage-unavailable guidance when the index fails %s (CAN-5565)',
    async (failureStage) => {
      const sidebar = jest.requireActual<typeof SidebarModule>(
        '../../lib/sidebar-items',
      );
      const { __setDesktopW5FileStoreForTests } =
        await import('../../lib/w5-commit-log-file-store');
      const persistence = await import('../../lib/workspace-persistence');
      const { readEffectiveWorkspaceConfig } =
        await import('../../lib/workspace-source');
      const { createDesktopRuntime } =
        await import('../../canopy-runtime/desktop-runtime');
      const actualPort = jest.requireActual<typeof ProjectBotPortModule>(
        '../../agent-actions/desktop-project-bot-port',
      );
      let unreadable = failureStage === 'inventory';
      const indexReads: string[] = [];
      __setDesktopW5FileStoreForTests({
        read: (filePath) => {
          if (filePath.endsWith('index.json')) {
            indexReads.push(unreadable ? 'unreadable' : 'present');
            return Promise.resolve(
              unreadable
                ? { state: 'unreadable' }
                : {
                    state: 'present',
                    raw: JSON.stringify({
                      version: 1,
                      workspaces: [
                        {
                          id: 'workspace-1',
                          type: 'single-repo',
                          name: 'Workspace',
                          color: 'blue',
                          collapsed: false,
                          order: 0,
                        },
                      ],
                    }),
                  },
            );
          }
          return Promise.resolve({
            state: 'present',
            raw: JSON.stringify(
              filePath.endsWith('workspace.json')
                ? {
                    version: 1,
                    type: 'single-repo',
                    repoPath: '/repo',
                    repos: [],
                  }
                : {
                    version: 1,
                    worktrees: [
                      {
                        id: 'worktree-1',
                        branchName: 'main',
                        createdAt: '2026-05-28T00:00:00Z',
                      },
                    ],
                  },
            ),
          });
        },
        replace: () => Promise.reject(new Error('Read must not write')),
        remove: () => Promise.reject(new Error('Read must not write')),
      });
      const runtime = createDesktopRuntime({
        workspaceServices: {
          readAllSidebarItems: sidebar.readAllSidebarItems,
          readAllSidebarItemsSnapshot: sidebar.readAllSidebarItemsSnapshot,
          readWorkspaceIndexEntry: sidebar.readWorkspaceIndexEntry,
          readWorkspaceIndexEntryDetailed:
            sidebar.readWorkspaceIndexEntryDetailed,
          readWorkspaceConfig: persistence.readWorkspaceConfig,
          readWorkspaceWorktrees: persistence.readWorkspaceWorktrees,
          readEffectiveWorkspaceConfig,
        },
      });
      const readInventory =
        runtime.queryWorkspaceListForLegacyIpc.bind(runtime);
      const inventory = jest
        .spyOn(runtime, 'queryWorkspaceListForLegacyIpc')
        .mockImplementation(async (...args) => {
          const result = await readInventory(...args);
          if (failureStage === 'after inventory') {
            expect(result.legacyAuthority?.indexAuthority).toBe('ok');
            expect(result.legacyResult.items.map((item) => item.id)).toContain(
              'workspace-1',
            );
            unreadable = true;
          }
          return result;
        });
      const readConfig = runtime.queryWorkspaceGetForLegacyIpc.bind(runtime);
      const config = jest
        .spyOn(runtime, 'queryWorkspaceGetForLegacyIpc')
        .mockImplementation((...args) => {
          if (failureStage === 'during config') unreadable = true;
          return readConfig(...args);
        });
      mockRunPort.mockImplementation(actualPort.runPipelineProjectBotAction);
      try {
        mockTab = codexTab();
        const instance = service();
        const id = await create(instance, sessionAction());
        const result = await instance.runNow({ id });
        if (!result.ok || !result.run) throw new Error(JSON.stringify(result));
        expect(result.run.status).toBe('failure');
        expect(result.run.error).toMatch(/storage.*unavailable/i);
        expect(result.run.error).toMatch(/try again/i);
        expect(result.run.error).not.toContain('can no longer reach that chat');
        expect(mockSend).not.toHaveBeenCalled();
        expect(mockRunPort).toHaveBeenCalledTimes(1);
        expect(inventory).toHaveBeenCalled();
        expect(indexReads).toContain('unreadable');
        if (failureStage !== 'inventory') {
          expect(indexReads.indexOf('present')).toBeLessThan(
            indexReads.indexOf('unreadable'),
          );
        }
        if (failureStage === 'during config') {
          expect(config).toHaveBeenCalled();
        }
        // A new service must read the durable failure, not the original in-memory run.
        const restarted = service();
        const history = await restarted.listRuns({ activityId: id });
        expect(history.runs).toHaveLength(1);
        expect(history.runs[0]).toMatchObject({
          id: result.run.id,
          status: 'failure',
          error: result.run.error,
        });
      } finally {
        config.mockRestore();
        inventory.mockRestore();
        await runtime.shutdown();
        __setDesktopW5FileStoreForTests(undefined);
      }
    },
  );

  it('reads a hidden target as an owner mismatch', async () => {
    mockRunPort.mockRejectedValue(
      new AgentChatSendError('not_found', 'The target chat is not available.'),
    );
    const { run } = await runShared(sessionAction());
    expect(run.status).toBe('failure');
    expect(run.error).toBe(
      'This automation can no longer reach that chat. Edit this automation and pick another destination.',
    );
  });
});

// Task 5 parity: each non-D4 row reaches the shared port with what its native
// send carried. The port's command mapping (`admittedSendRequest` and the
// retained Orchestrator branch) is pinned in the chat-state and orchestration
// suites, so this composes the request from the port inputs with the same
// helper both branches apply, and compares the fields the automation states
// itself. The chat's settings come from the canonical tab plus the turn
// override and are compared through `turnOverride` above.
describe('worktree_session_prompt parity with its native send (CAN-4549)', () => {
  const ATTACHED = {
    fileReferences: [
      { displayPath: 'src/a.ts', absolutePath: '/repo/src/a.ts' },
    ],
    attachmentPaths: ['/tmp/shot.png'],
    attachmentPromptContexts: [
      {
        attachmentPath: '/tmp/shot.png',
        promptKind: 'linear-ticket' as const,
      },
    ],
    inputMode: 'voice' as const,
  };

  function accepted(): object {
    return {
      address: {
        projectId: 'workspace-1',
        taskId: 'worktree-1',
        chatId: 'chat-1',
      },
      acceptedAt: '2026-10-28T00:00:00.000Z',
      watcherReceipts: [],
      disposition: 'started',
      messageId: 'accepted-1',
    };
  }

  beforeEach(() => {
    mockRunPort.mockResolvedValue(accepted());
    mockAdmitScheduled.mockResolvedValue(undefined);
    mockResumeUsageLimited.mockResolvedValue({ resumedCount: 1 });
  });

  interface Run {
    id: string;
    status: string;
    error?: string;
    result?: object;
  }

  async function flushWatchers(): Promise<void> {
    for (let turn = 0; turn < 20; turn++) await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
  }

  async function runNowOn(
    route: 'native' | 'shared',
    action: SessionAction,
    tab: PersistedChatTab = codexTab(),
  ): Promise<Run> {
    mockSharedPort = route === 'shared';
    mockTab = tab;
    const instance = service();
    const result = await instance.runNow({
      id: await create(instance, action),
    });
    if (!result.ok || !result.run) throw new Error(JSON.stringify(result));
    await flushWatchers();
    return result.run;
  }

  function stored(
    action: SessionAction,
    overrides: Partial<ScheduledActivity> = {},
  ): ScheduledActivity {
    const now = new Date().toISOString();
    return {
      version: 1,
      id: 'automation-1',
      name: 'Session settings',
      enabled: false,
      schedule: {
        kind: 'one_time',
        runAt: '2099-01-01T00:00:00.000Z',
        timezone: 'local',
      },
      action,
      createdAt: now,
      updatedAt: now,
      failureCount: 0,
      ...overrides,
    };
  }

  async function seed(activity: ScheduledActivity): Promise<void> {
    await writeFile(
      join(mockDir, 'automations.json'),
      JSON.stringify({
        version: 1,
        updatedAt: activity.updatedAt,
        activities: [activity],
        recentRuns: [],
      }),
      'utf8',
    );
  }

  /** A run the due check started: not the user's own. */
  async function runScheduledOn(
    route: 'native' | 'shared',
    action: SessionAction,
  ): Promise<Run> {
    mockSharedPort = route === 'shared';
    mockTab = codexTab();
    await seed(
      stored(action, {
        enabled: true,
        schedule: {
          kind: 'one_time',
          runAt: new Date(Date.now() - 1_000).toISOString(),
          timezone: 'local',
        },
      }),
    );
    const instance = service();
    const completed = Promise.withResolvers<string>();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    mockWatcherEvent.mockImplementation((event) => {
      if (
        event.activityId === 'automation-1' &&
        event.manual === false &&
        typeof event.runId === 'string'
      ) {
        completed.resolve(event.runId);
      }
    });
    try {
      await instance.start();
      // The in-memory status becomes terminal before the final disk write.
      // Watcher delivery follows persistence, so reseeding cannot race it.
      const runId = await Promise.race([
        completed.promise,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error('The scheduled run did not finish.')),
            2_000,
          );
        }),
      ]);
      await flushWatchers();
      const run = (await instance.list()).recentRuns.find(
        (entry) => entry.id === runId,
      );
      if (!run) throw new Error('The scheduled run was not retained.');
      expect(run.status).toBe('success');
      return run;
    } finally {
      clearTimeout(timeout);
      instance.stop();
      mockWatcherEvent.mockImplementation(() => undefined);
    }
  }

  function portCall(): {
    action: object;
    caller: object;
    options: PipelineProjectBotOptions;
  } {
    expect(mockRunPort).toHaveBeenCalledTimes(1);
    const [action, caller, options] = mockRunPort.mock.calls[0];
    return { action, caller, options };
  }

  /** The automation-stated request fields both port branches produce. */
  function composedRequest(
    action: object,
    options: PipelineProjectBotOptions,
  ): Record<string, unknown> {
    return {
      projectId: Reflect.get(action, 'projectId'),
      worktreeId: Reflect.get(action, 'taskId'),
      chatId: Reflect.get(action, 'chatId'),
      text: Reflect.get(action, 'text'),
      userMessageId: options.fixedIds?.userMessageId,
      ...options.composition,
      ...automationDispatchRequestFields(options.automationDispatch),
    };
  }

  /** The run-specific message ID is compared separately. */
  const OWNED_FIELDS = AUTOMATION_OWNED_PARITY_FIELDS.filter(
    (field) => field !== 'userMessageId',
  );

  function owned(request: object): Record<string, unknown> {
    return parityView(request, OWNED_FIELDS);
  }

  it('adds only named deltas through the automation carrier', () => {
    const fields = Object.keys(
      automationDispatchRequestFields({
        version: 1,
        automationName: 'Session settings',
        presentation: 'background',
        packageOverlay: { packageDigest: 'digest', resources: [] },
      }),
    );
    const allowed: ReadonlyArray<string> = [
      ...AUTOMATION_OWNED_PARITY_FIELDS,
      ...Object.keys(INTENDED_DELTAS),
    ];
    expect(fields.filter((field) => !allowed.includes(field))).toStrictEqual(
      [],
    );
  });

  it.each([
    { label: 'Run now', settings: {} },
    {
      label: 'references, attachments and voice input',
      settings: ATTACHED,
    },
  ])('$label: states the same request fields', async ({ settings }) => {
    const nativeRun = await runNowOn('native', sessionAction(settings));
    expect(mockSend).toHaveBeenCalledTimes(1);
    const native = mockSend.mock.calls[0][0];
    const nativeOptions = mockSendOptions.mock.calls[0][0];
    const sharedRun = await runNowOn('shared', sessionAction(settings));
    const { action, options } = portCall();
    const shared = composedRequest(action, options);
    expect(owned(shared)).toStrictEqual(owned(native));
    // Each route keeps the run's own message ID.
    expect(native.userMessageId).toBe(`automation-${nativeRun.id}`);
    expect(shared.userMessageId).toBe(`automation-${sharedRun.id}`);
    expect(options.automationDispatch?.executionContext).toBe(
      nativeOptions.executionContext,
    );
    expect(sharedRun.result).toStrictEqual({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      userMessageId: shared.userMessageId,
    });
    expect(mockWatcherEvent.mock.calls.at(-1)?.[0]).toMatchObject({
      dispatched: sharedRun.result,
    });
  });

  it('keeps a scheduled run behind the current tab', async () => {
    await runScheduledOn('native', sessionAction());
    expect(mockSend).toHaveBeenCalledTimes(1);
    const native = mockSend.mock.calls[0][0];
    expect(native.preserveActiveTab).toBe(true);
    await runScheduledOn('shared', sessionAction());
    const { action, options } = portCall();
    expect(options.automationDispatch).toStrictEqual({
      version: 1,
      automationName: 'Session settings',
      presentation: 'background',
      executionContext: 'personal',
    });
    expect(owned(composedRequest(action, options))).toStrictEqual(
      owned(native),
    );
  });

  it('keeps OpenCode’s message ID as the run ID', async () => {
    const tab = codexTab({
      model: 'opencode:fixture%2Fmodel',
      providerType: 'opencode',
      executionHarness: 'opencode',
    });
    const run = await runNowOn('shared', sessionAction(), tab);
    expect(run.status).toBe('success');
    const { options } = portCall();
    expect(options.fixedIds?.userMessageId).toBe(run.id);
    expect(run.result).toMatchObject({ userMessageId: run.id });
  });

  it('sends a Cowork chat as a project send on its Work Entry', async () => {
    const run = await runNowOn(
      'shared',
      sessionAction({ workspaceId: 'cowork-1', worktreeId: 'entry-1' }),
    );
    expect(run.status).toBe('success');
    const { action } = portCall();
    expect(action).toStrictEqual({
      type: 'projects.send_message',
      projectId: 'cowork-1',
      taskId: 'entry-1',
      chatId: 'chat-1',
      text: 'Continue',
    });
    expect(run.result).toStrictEqual({
      projectId: 'cowork-1',
      worktreeId: 'entry-1',
      chatId: 'chat-1',
      userMessageId: `automation-${run.id}`,
    });
  });

  it('opens the Orchestrator window, then sends to its bot with the window surfaces', async () => {
    const run = await runNowOn(
      'shared',
      sessionAction({
        workspaceId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'advisor-entry-1',
      }),
    );
    expect(run.status).toBe('success');
    expect(mockEnsureAdvisor).toHaveBeenCalledTimes(1);
    expect(mockEnsureAdvisor).toHaveBeenCalledWith();
    const { action, options } = portCall();
    expect(mockEnsureAdvisor.mock.invocationCallOrder[0]).toBeLessThan(
      mockRunPort.mock.invocationCallOrder[0],
    );
    expect(action).toStrictEqual({
      type: 'bots.send_message',
      botId: APP_ADVISOR_BOT_ID,
      taskId: 'advisor-entry-1',
      chatId: 'chat-1',
      text: 'Continue',
    });
    expect(options.surfaces).toMatchObject({
      ensureAppAdvisorWindow: mockEnsureAdvisor,
    });
    expect(options.automationDispatch?.presentation).toBe('foreground');
    expect(run.result).toStrictEqual({
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: 'advisor-entry-1',
      chatId: 'chat-1',
      userMessageId: `automation-${run.id}`,
    });
  });

  it('keeps a usage-limit resume on its native path (D4)', async () => {
    mockUsageLimitedChats.mockResolvedValue([
      {
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        detectedAt: 0,
        resumeReason: 'usage_limit',
      },
    ]);
    const run = await runNowOn(
      'shared',
      sessionAction({ purpose: 'usage_limit_resume' }),
    );
    expect(run.status).toBe('success');
    expect(mockRunPort).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockResumeUsageLimited).toHaveBeenCalledWith(
      {
        targets: [
          {
            projectId: 'workspace-1',
            worktreeId: 'worktree-1',
            chatId: 'chat-1',
          },
        ],
      },
      expect.any(Function),
      `automation-${run.id}`,
    );
  });

  it('keeps an agent’s scheduled message on its native path, as that agent (D4)', async () => {
    const sender = {
      kind: 'project' as const,
      projectType: 'code' as const,
      projectId: 'workspace-1',
      taskId: 'worktree-1',
      chatId: 'chat-2',
    };
    mockSharedPort = true;
    mockTab = codexTab();
    await seed(
      stored(sessionAction(), {
        agentScheduledSend: {
          version: 1,
          agentSent: { sender, chatTitle: 'Planner', projectLabel: 'Repo' },
          provenance: {
            version: 1,
            capturedAt: '2026-10-28T00:00:00.000Z',
            acceptedInputId: 'input-1',
            sender,
            owner: { kind: 'personal' },
          },
        },
      }),
    );
    const result = await service().runNow({ id: 'automation-1' });
    if (!result.ok || !result.run) throw new Error(JSON.stringify(result));
    expect(result.run.status).toBe('success');
    expect(mockRunPort).not.toHaveBeenCalled();
    expect(mockAdmitScheduled).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0].agentSent).toMatchObject({ sender });
  });
});
