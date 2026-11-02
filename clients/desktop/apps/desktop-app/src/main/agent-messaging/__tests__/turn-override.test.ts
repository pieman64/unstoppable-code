import type * as PreferencesStoreModule from '../../lib/preferences-store';
import {
  initAgentModels,
  initClaudeModels,
  initCodexModels,
  initModelAliases,
  type ChatTabPluginSelections,
  type PreferencesData,
} from '@canopy/desktop-shared/types';
import type { ShareablePluginMatch } from '../../plugins/shareable-plugin-resolution';
import {
  resolveChatTurnOverride,
  type ExistingTabDispatchOptions,
} from '../turn-override';

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
let mockOpenCodeGeneration = 0;

jest.mock('../../lib/preferences-store', () => ({
  ...jest.requireActual<typeof PreferencesStoreModule>(
    '../../lib/preferences-store',
  ),
  peekPreferencesLoadError: (): null => null,
  readPreferencesFile: (): Promise<PreferencesData> => mockReadPreferences(),
}));
jest.mock('../../lib/default-model-lane-resolver', () => ({
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
jest.mock('../../opencode/connection', () => ({
  getOpenCodeConnectionGeneration: (): number => mockOpenCodeGeneration,
  assertOpenCodeConnectionGeneration: (expected: number): void => {
    if (expected !== mockOpenCodeGeneration)
      throw new Error('OpenCode connection changed. Try again.');
  },
  assertOpenCodeModelAvailable: (model: string | undefined): Promise<void> =>
    mockAssertOpenCodeModelAvailable(model),
}));

const TARGET = {
  projectId: 'workspace-1',
  worktreeId: 'worktree-1',
  chatId: 'chat-1',
};

const TAB_PLUGINS: ChatTabPluginSelections = {
  collectionIds: ['tab-collection'],
  skillRefs: [],
  pluginRefs: [],
  mcpServerRefs: [],
};

function codexTab(
  overrides: Partial<ExistingTabDispatchOptions> = {},
): ExistingTabDispatchOptions {
  return {
    providerType: 'codex',
    executionHarness: 'codex',
    model: 'gpt-5.5',
    modelConfig: { thinkingLevel: 'xhigh', fastMode: true },
    pluginSelections: TAB_PLUGINS,
    deferredToolsAllowed: true,
    planMode: false,
    sdkSessionId: 'thread-1',
    ...overrides,
  };
}

const CLAUDE_TAB = codexTab({
  model: 'sonnet',
  providerType: 'claude',
  executionHarness: 'claude',
  modelConfig: { thinkingLevel: 'high' },
});

beforeAll(() => {
  initClaudeModels([{ id: 'sonnet', label: 'Claude Sonnet' }]);
  initCodexModels([
    { id: 'gpt-5.5', label: 'GPT 5.5' },
    { id: 'gpt-5.4', label: 'GPT 5.4' },
  ]);
  initModelAliases({ 'claude-sonnet-4-6': 'sonnet' });
});

beforeEach(() => {
  jest.clearAllMocks();
  initAgentModels([]);
  mockOpenCodeGeneration = 0;
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
});

describe('resolveChatTurnOverride', () => {
  it('returns only the version for an empty request', async () => {
    await expect(
      resolveChatTurnOverride(TARGET, codexTab(), {}),
    ).resolves.toStrictEqual({ version: 1 });
    expect(mockReadPreferences).not.toHaveBeenCalled();
    expect(mockReadWorkspaceApprovals).not.toHaveBeenCalled();
  });

  it('switches to another model on the same harness and resets the runtime', async () => {
    await expect(
      resolveChatTurnOverride(TARGET, codexTab(), { model: 'gpt-5.4' }),
    ).resolves.toStrictEqual({
      version: 1,
      resetRuntime: true,
      providerType: 'codex',
      executionHarness: 'codex',
      model: 'gpt-5.4',
      modelConfig: { thinkingLevel: 'xhigh', fastMode: true, speed: 'fast' },
    });
  });

  it('keeps the runtime when the requested model is the chat model', async () => {
    await expect(
      resolveChatTurnOverride(TARGET, codexTab(), { model: 'gpt-5.5' }),
    ).resolves.toStrictEqual({
      version: 1,
      model: 'gpt-5.5',
      modelConfig: { thinkingLevel: 'xhigh', fastMode: true, speed: 'fast' },
    });
  });

  it('switches to another provider without the chat config', async () => {
    await expect(
      resolveChatTurnOverride(TARGET, codexTab(), {
        model: 'sonnet',
        modelConfig: { thinkingLevel: 'low' },
      }),
    ).resolves.toStrictEqual({
      version: 1,
      resetRuntime: true,
      providerType: 'claude',
      executionHarness: 'claude',
      model: 'sonnet',
      modelConfig: { thinkingLevel: 'low', fastMode: false, speed: 'standard' },
    });
  });

  it('merges a requested model config over the chat config', async () => {
    await expect(
      resolveChatTurnOverride(TARGET, codexTab(), {
        modelConfig: { thinkingLevel: 'low' },
      }),
    ).resolves.toStrictEqual({
      version: 1,
      modelConfig: { thinkingLevel: 'low', fastMode: true, speed: 'fast' },
    });
  });

  it('pins an inheriting Agent to the destination default', async () => {
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
    await expect(
      resolveChatTurnOverride(TARGET, codexTab(), {
        model: 'agent_model_inherit',
      }),
    ).resolves.toStrictEqual({
      version: 1,
      resetRuntime: true,
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

  it('refuses a model it does not know', async () => {
    await expect(
      resolveChatTurnOverride(TARGET, codexTab(), { model: 'not-a-model' }),
    ).rejects.toThrow('The automation model is unavailable.');
  });

  it('carries a requested plan mode', async () => {
    await expect(
      resolveChatTurnOverride(TARGET, codexTab(), { planMode: false }),
    ).resolves.toStrictEqual({ version: 1, planMode: false });
  });

  it('resolves a requested approval mode through the workspace and manifest defaults', async () => {
    mockReadWorkspaceApprovals.mockResolvedValue({
      version: 1,
      rules: [],
      defaultMode: 'full-access',
    });
    mockReadWorkspaceApprovalsManifest.mockResolvedValue({
      rules: [],
      defaultMode: 'ask',
    });
    await expect(
      resolveChatTurnOverride(TARGET, codexTab(), { approvalMode: 'auto' }),
    ).resolves.toStrictEqual({ version: 1, approvalMode: 'auto' });
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
    await expect(
      resolveChatTurnOverride(
        TARGET,
        codexTab(),
        {
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
        },
        {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [{ marketplaceId: 'm', pluginName: 'referenced' }],
          mcpServerRefs: [],
        },
      ),
    ).resolves.toStrictEqual({
      version: 1,
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

  it('merges prompt references over the chat selections when nothing else is requested', async () => {
    const override = await resolveChatTurnOverride(
      TARGET,
      codexTab(),
      {},
      {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [{ marketplaceId: 'm', pluginName: 'referenced' }],
        mcpServerRefs: [],
      },
    );
    expect(override).toMatchObject({
      version: 1,
      pluginSelections: {
        collectionIds: ['tab-collection'],
        pluginRefs: [{ marketplaceId: 'm', pluginName: 'referenced' }],
      },
    });
  });

  it.each([
    ['a requested Cursor model', codexTab(), 'cursor-default'],
    ['a Cursor chat', codexTab({ executionHarness: 'cursor' }), undefined],
  ])('refuses %s', async (_label, tab, model) => {
    await expect(
      resolveChatTurnOverride(TARGET, tab, model ? { model } : {}),
    ).rejects.toThrow(
      'Scheduled messages are not available for Cursor chats. Choose another model.',
    );
  });

  it('refuses an unavailable OpenCode model', async () => {
    mockAssertOpenCodeModelAvailable.mockRejectedValue(
      new Error('This OpenCode model is unavailable. Choose another model.'),
    );
    await expect(
      resolveChatTurnOverride(
        TARGET,
        codexTab({
          model: 'opencode:fixture%2Fmodel',
          providerType: 'opencode',
          executionHarness: 'opencode',
        }),
        {},
      ),
    ).rejects.toThrow(
      'This OpenCode model is unavailable. Choose another model.',
    );
    expect(mockAssertOpenCodeModelAvailable).toHaveBeenCalledWith(
      'opencode:fixture%2Fmodel',
    );
  });

  it('refuses an OpenCode connection that changes while the model is checked', async () => {
    mockAssertOpenCodeModelAvailable.mockImplementation(() => {
      mockOpenCodeGeneration += 1;
      return Promise.resolve();
    });
    await expect(
      resolveChatTurnOverride(
        TARGET,
        codexTab({
          model: 'opencode:fixture%2Fmodel',
          providerType: 'opencode',
          executionHarness: 'opencode',
        }),
        {},
      ),
    ).rejects.toThrow('OpenCode connection changed. Try again.');
  });

  // Review Focus 4: the override is a function of the chat it is given, so a
  // caller resolving against the chat at delivery time gets that chat's answer.
  it('resolves the same request against the chat it is given', async () => {
    const request = { model: 'gpt-5.5' };
    await expect(
      resolveChatTurnOverride(TARGET, CLAUDE_TAB, request),
    ).resolves.toMatchObject({
      resetRuntime: true,
      providerType: 'codex',
      model: 'gpt-5.5',
    });
    await expect(
      resolveChatTurnOverride(TARGET, codexTab(), request),
    ).resolves.not.toHaveProperty('resetRuntime');
  });
});
