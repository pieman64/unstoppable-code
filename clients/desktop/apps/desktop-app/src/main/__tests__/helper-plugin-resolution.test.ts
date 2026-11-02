jest.mock('../plugins/plugin-resolver', () => ({
  resolvePlugins: jest.fn(),
}));

jest.mock('../plugins/plugin-cleanup', () => ({
  cleanupChatSkillPluginDir: jest.fn(),
}));

const mockUnregisterRoutesForSession = jest.fn();
const mockMcpHttpProxyService = {
  ensureStarted: jest.fn(),
  registerRoute: jest.fn(),
  getProxyUrl: jest.fn(),
  unregisterRoutesForSession: mockUnregisterRoutesForSession,
};
jest.mock('../mcp/http-proxy-service', () => ({
  getMcpHttpProxyService: jest.fn(() => mockMcpHttpProxyService),
}));

import {
  initClaudeModels,
  initCodexModels,
  initModelAliases,
  type ChatTabPluginSelections,
} from '@canopy/desktop-shared/types';
import type { HelperAgentPluginRuntime } from '@canopy/desktop-shared/lib/helper-agent-plugins';
import { cleanupChatSkillPluginDir } from '../plugins/plugin-cleanup';
import { resolvePlugins } from '../plugins/plugin-resolver';
import {
  mergeHelperCodexMcpServers,
  runWithOptionalHelperPlugins,
  withResolvedHelperPlugins,
} from '../lib/helper-plugin-resolution';

const mockedResolvePlugins = jest.mocked(resolvePlugins);
const mockedCleanupChatSkillPluginDir = jest.mocked(cleanupChatSkillPluginDir);

initCodexModels([{ id: 'gpt-5.5', label: 'GPT 5.5' }]);
initClaudeModels([{ id: 'sonnet', label: 'Sonnet' }]);
initModelAliases({
  'claude-sonnet-4-6': 'sonnet',
  'gpt-6-sol': 'gpt-5.5',
});

const selections: ChatTabPluginSelections = {
  collectionIds: ['bundle-a'],
  skillRefs: [],
  pluginRefs: [],
  mcpServerRefs: [],
};

describe('mergeHelperCodexMcpServers', () => {
  it('preserves routed servers and lets routed config win name collisions', () => {
    expect(
      mergeHelperCodexMcpServers(
        {
          model_provider: 'canopy-ai-credits',
          mcp_servers: {
            routed: { command: 'routed-mcp' },
            shared: { command: 'routed-shared-mcp' },
          },
        },
        {
          plugin: { command: 'plugin-mcp' },
          shared: { command: 'plugin-shared-mcp' },
        },
      ),
    ).toEqual({
      model_provider: 'canopy-ai-credits',
      mcp_servers: {
        plugin: { command: 'plugin-mcp' },
        routed: { command: 'routed-mcp' },
        shared: { command: 'routed-shared-mcp' },
      },
    });
  });
});

describe('withResolvedHelperPlugins', () => {
  let emitWarningSpy: jest.SpiedFunction<typeof process.emitWarning>;

  beforeEach(() => {
    jest.clearAllMocks();
    emitWarningSpy = jest
      .spyOn(process, 'emitWarning')
      .mockImplementation((): void => {});
  });

  afterEach(() => {
    emitWarningSpy.mockRestore();
  });

  it('falls back to an empty runtime when plugin resolution fails', async () => {
    mockedResolvePlugins.mockRejectedValue(new Error('resolver failed'));
    const run = jest.fn(
      (runtime: HelperAgentPluginRuntime): Promise<string> => {
        expect(runtime).toEqual({
          claudePlugins: [],
          claudeMcpServers: {},
          codexCapabilityRoots: [],
          codexMcpServers: {},
        });
        return Promise.resolve('ok');
      },
    );

    const result = await withResolvedHelperPlugins(
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        helperName: 'commit-message',
        model: 'claude-sonnet-4-6',
        selections,
      },
      run,
    );

    expect(result).toBe('ok');
    expect(run).toHaveBeenCalledTimes(1);
    expect(mockedCleanupChatSkillPluginDir).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
      expect.stringMatching(/^helper-commit-message-/),
    );
    expect(emitWarningSpy).toHaveBeenCalledWith(
      'Failed to resolve plugins for commit-message: resolver failed',
      { type: 'CanopyHelperPluginResolverWarning' },
    );
  });

  it('does not let cleanup failure mask a successful helper run', async () => {
    mockedResolvePlugins.mockResolvedValue({
      sdkPlugins: [{ type: 'local', path: '/plugins/helper' }],
      skillPluginDir: '/plugins/helper',
      selectedCapabilityRoots: [],
      codexMcpServers: {
        helper: { command: 'helper-mcp', args: [] },
      },
      mcpServers: {},
      mcpServerBindings: {},
      warnings: [],
      cursorNotices: [],
      cursorCapabilities: { skills: [], commands: [] },
    });
    mockedCleanupChatSkillPluginDir.mockImplementationOnce((): void => {
      throw new Error('cleanup failed');
    });

    const result = await withResolvedHelperPlugins(
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        helperName: 'commit-message',
        model: 'claude-sonnet-4-6',
        selections,
      },
      (runtime: HelperAgentPluginRuntime): Promise<string> => {
        expect(runtime.claudePlugins).toEqual([
          { type: 'local', path: '/plugins/helper' },
        ]);
        expect(runtime.codexMcpServers).toEqual({
          helper: { command: 'helper-mcp', args: [] },
        });
        return Promise.resolve('ok');
      },
    );

    expect(result).toBe('ok');
    expect(emitWarningSpy).toHaveBeenCalledWith(
      'Failed to clean up plugins for commit-message: cleanup failed',
      { type: 'CanopyHelperPluginResolverWarning' },
    );
  });

  it('uses a scoped HTTP credential proxy for Codex helper plugins', async () => {
    mockedResolvePlugins.mockResolvedValue({
      sdkPlugins: [],
      skillPluginDir: null,
      selectedCapabilityRoots: [],
      codexMcpServers: {},
      mcpServers: {},
      mcpServerBindings: {},
      warnings: [],
      cursorNotices: [],
      cursorCapabilities: { skills: [], commands: [] },
    });

    await withResolvedHelperPlugins(
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        helperName: 'commit-message',
        model: 'gpt-5.5',
        selections,
      },
      (): Promise<void> => Promise.resolve(),
    );

    const chatId = mockedResolvePlugins.mock.calls[0]?.[3];
    expect(chatId).toMatch(/^helper-commit-message-/);
    expect(mockedResolvePlugins.mock.calls[0]?.[4]).toEqual(
      expect.objectContaining({
        purpose: 'codex-session',
        enableHttpMcpProxy: true,
        mcpHttpProxyService: mockMcpHttpProxyService,
        sessionId: chatId,
      }),
    );
    expect(mockUnregisterRoutesForSession).toHaveBeenCalledWith(chatId);
  });

  it('ignores unsafe MCP server names when building Claude config', async () => {
    mockedResolvePlugins.mockResolvedValue({
      sdkPlugins: [],
      skillPluginDir: null,
      selectedCapabilityRoots: [],
      codexMcpServers: {},
      mcpServers: {
        safe: { type: 'stdio', command: 'safe-mcp' },
        ['__proto__']: { type: 'stdio', command: 'unsafe-mcp' },
      },
      mcpServerBindings: {},
      warnings: [],
      cursorNotices: [],
      cursorCapabilities: { skills: [], commands: [] },
    });

    await withResolvedHelperPlugins(
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        helperName: 'commit-message',
        model: 'claude-sonnet-4-6',
        selections,
      },
      (runtime: HelperAgentPluginRuntime): Promise<void> => {
        expect(Object.keys(runtime.claudeMcpServers)).toEqual(['safe']);
        expect(runtime.claudeMcpServers).toEqual({
          safe: { type: 'stdio', command: 'safe-mcp' },
        });
        return Promise.resolve();
      },
    );

    expect(emitWarningSpy).toHaveBeenCalledWith(
      'Ignoring unsafe MCP server name "__proto__".',
      { type: 'CanopyHelperPluginResolverWarning' },
    );
  });

  it('warns when configured selections cannot resolve without audit context', async () => {
    const result = await runWithOptionalHelperPlugins(
      {
        helperName: 'commit-message',
        model: 'claude-sonnet-4-6',
        selections,
      },
      (runtime: HelperAgentPluginRuntime): Promise<string> => {
        expect(runtime).toEqual({
          claudePlugins: [],
          claudeMcpServers: {},
          codexCapabilityRoots: [],
          codexMcpServers: {},
        });
        return Promise.resolve('ok');
      },
    );

    expect(result).toBe('ok');
    expect(mockedResolvePlugins).not.toHaveBeenCalled();
    expect(mockedCleanupChatSkillPluginDir).not.toHaveBeenCalled();
    expect(emitWarningSpy).toHaveBeenCalledWith(
      'Skipping configured plugins for commit-message: audit context is required.',
      { type: 'CanopyHelperPluginResolverWarning' },
    );
  });
});
