import {
  runCopilotPipelinePrompt,
  type CopilotPromptHost,
  type CopilotPipelineCapabilities,
} from '@canopy/desktop-shared/node/pipelines/copilot-prompt-runner';
import { emptyCursorCapabilityProjection } from '@canopy/desktop-shared/lib/cursor-capabilities';
import { materializeSelectedCapabilityRoot } from '@canopy/desktop-shared/node/cursor/capability-root';
import { discoverInheritedCursorCapabilities } from '@canopy/desktop-shared/node/cursor/inherited-capabilities';
import { createApprovalSession } from '../approvals/approval-service';
import { resolvePlugins } from '../plugins/plugin-resolver';
import {
  getMcpHttpProxyService,
  type McpProxiedToolCallGate,
} from '../mcp/http-proxy-service';
import { runDesktopCopilotPipelinePrompt } from '../pipelines/copilot-prompt-runner';

jest.mock(
  '@canopy/desktop-shared/node/pipelines/copilot-prompt-runner',
  () => ({ runCopilotPipelinePrompt: jest.fn() }),
);
const mockSetSessionToolCallGate = jest.fn<
  void,
  [string, McpProxiedToolCallGate]
>();
const mockUnregisterRoutes = jest.fn<void, [string]>();
const mockCapabilityDigests = jest.fn(() => ({ selected: 'a'.repeat(64) }));
jest.mock('@canopy/desktop-shared/node/cursor/capability-root', () => ({
  materializeSelectedCapabilityRoot: jest.fn(),
}));
jest.mock('../plugins/plugin-resolver', () => ({ resolvePlugins: jest.fn() }));
jest.mock('../copilot/connection', () => ({
  openManagedCopilotRuntime: jest.fn(() => Promise.resolve({ generation: 7 })),
  assertCopilotConnectionGeneration: jest.fn(),
}));
jest.mock('../mcp/http-proxy-service', () => ({
  getMcpHttpProxyService: jest.fn(() => ({
    setSessionToolCallGate: mockSetSessionToolCallGate,
    unregisterRoutesForSession: mockUnregisterRoutes,
    getMcpCapabilityDigests: mockCapabilityDigests,
  })),
}));
const mockInherited = {
  skills: [
    {
      origin: 'claude' as const,
      name: 'home-review',
      sourceDir: '/home/user/.claude/skills/home-review',
      description: 'Home review',
      userInvocable: true,
    },
  ],
  commands: [
    {
      origin: 'claude' as const,
      name: 'review',
      markdown: 'Review from home',
      description: 'Home review',
    },
  ],
  skipped: [],
  fingerprint: 'home-fixture',
};
jest.mock('@canopy/desktop-shared/node/cursor/inherited-capabilities', () => ({
  discoverInheritedCursorCapabilities: jest.fn(() =>
    Promise.resolve(mockInherited),
  ),
  emptyInheritedCursorCapabilities: (): typeof mockInherited => ({
    skills: [],
    commands: [],
    skipped: [],
    fingerprint: 'empty',
  }),
}));
jest.mock('../cursor/inherited-roots', () => ({
  resolveInheritedCursorRoots: (): {
    userHome: string;
    claudeConfigDir: string;
    codexHome: string;
  } => ({
    userHome: '/home/user',
    claudeConfigDir: '/home/user/.claude',
    codexHome: '/home/user/.codex',
  }),
}));
jest.mock('../plugins/claude-enabled-plugins', () => ({
  readClaudeDisabledInstalledPlugins: (): string[] => [],
  readClaudeEnabledPlugins: (): Map<string, string> =>
    new Map([
      ['home-plugin@fixture', '/home/user/.claude/plugins/home-plugin'],
    ]),
}));
jest.mock('../plugins/plugin-service', () => ({
  loadMarketplacesCacheOnly: (): Promise<{
    success: boolean;
    data: { marketplaces: { id: string; plugins: { name: string }[] }[] };
  }> =>
    Promise.resolve({
      success: true,
      data: {
        marketplaces: [{ id: 'fixture', plugins: [{ name: 'home-plugin' }] }],
      },
    }),
}));

jest.mock('../approvals/approval-service', () => ({
  createApprovalSession: jest.fn(),
}));

const check = jest.fn(() =>
  Promise.resolve({ decision: 'allow' as 'allow' | 'deny' }),
);
const dispose = jest.fn();
const invalidatePending = jest.fn();
let proxy: jest.Mocked<ReturnType<typeof getMcpHttpProxyService>>;
const request = {
  cwd: '/workspace',
  projectId: 'project',
  executionId: 'execution',
  jobId: 'job',
  stepId: 'step',
  attempt: 1,
  executionsDir: '/executions',
  model: 'copilot:gpt-4.1',
  prompt: 'do it',
  environment: {},
  permissionPreset: 'dangerous_all' as const,
  totalTimeoutMs: 1000,
};
beforeEach(() => {
  jest.clearAllMocks();
  jest
    .mocked(discoverInheritedCursorCapabilities)
    .mockResolvedValue(mockInherited);
  mockCapabilityDigests.mockReturnValue({ selected: 'a'.repeat(64) });
  check.mockResolvedValue({ decision: 'allow' });
  jest.mocked(createApprovalSession).mockReturnValue({
    check,
    dispose,
    invalidatePending,
    setMode: jest.fn(),
    reevaluatePendingApprovals: jest.fn(),
  });
  jest.mocked(resolvePlugins).mockResolvedValue({
    cursorCapabilities: emptyCursorCapabilityProjection(),
    mcpServers: {
      selected: {
        type: 'http',
        url: 'http://localhost/selected',
        allowedTools: ['change'],
      },
    },
    warnings: [],
    cursorNotices: [],
  } as unknown as Awaited<ReturnType<typeof resolvePlugins>>);
  jest
    .mocked(materializeSelectedCapabilityRoot)
    .mockResolvedValue({ skillIds: [], commandIds: [], warnings: [] });
  proxy = getMcpHttpProxyService() as jest.Mocked<
    ReturnType<typeof getMcpHttpProxyService>
  >;
  jest.mocked(getMcpHttpProxyService).mockReturnValue(proxy);
});
async function withCapabilities(
  run: (host: CopilotPromptHost) => Promise<void>,
): Promise<void> {
  jest
    .mocked(runCopilotPipelinePrompt)
    .mockImplementation(async (_request, host) => {
      await host.open(new AbortController().signal);
      await run(host);
      throw new Error('fixture complete');
    });
  await expect(runDesktopCopilotPipelinePrompt(request)).rejects.toThrow(
    'fixture complete',
  );
}
function gate(): McpProxiedToolCallGate {
  const call = mockSetSessionToolCallGate.mock.calls[0];
  if (!call) throw new Error('Missing proxy gate');
  return call[1];
}
const toolCall = {
  proxyUrl: 'http://localhost/selected',
  tool: 'change',
  args: { value: 'write' },
};
test.each(['allow', 'deny'] as const)(
  'proxy honors shared approval %s',
  async (decision) => {
    check.mockResolvedValue({ decision });
    await withCapabilities(async (host) => {
      const capabilities = await host.prepareCapabilities?.(
        '/profile',
        new AbortController().signal,
      );
      expect(await gate()(toolCall)).toBe(decision === 'allow');
      expect(check).toHaveBeenCalledWith(
        { kind: 'mcp', server: 'selected', tool: 'change' },
        expect.anything(),
      );
      expect(createApprovalSession).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'project',
          workspaceRoot: '/workspace',
          mode: 'full-access',
          trackChatTurn: false,
          provider: 'copilot',
        }),
      );
      expect(
        jest.mocked(createApprovalSession).mock.calls[0][0].getWindow(),
      ).toBeNull();
      await capabilities?.dispose();
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(await gate()(toolCall)).toBe(false);
    });
  },
);
test('unknown routes and unselected tools never reach shared approval', async () => {
  await withCapabilities(async (host) => {
    const capabilities = await host.prepareCapabilities?.(
      '/profile',
      new AbortController().signal,
    );
    expect(
      await gate()({ ...toolCall, proxyUrl: 'http://localhost/unknown' }),
    ).toBe(false);
    expect(await gate()({ ...toolCall, tool: 'unselected' })).toBe(false);
    expect(check).not.toHaveBeenCalled();
    await capabilities?.dispose();
  });
});
test('withdrawal while shared policy is pending cannot allow a tool', async () => {
  let release!: (value: { decision: 'allow' | 'deny' }) => void;
  check.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await withCapabilities(async (host) => {
    const controller = new AbortController();
    const capabilities = await host.prepareCapabilities?.(
      '/profile',
      controller.signal,
    );
    const result = gate()(toolCall);
    controller.abort();
    release({ decision: 'allow' });
    expect(await result).toBe(false);
    expect(invalidatePending).toHaveBeenCalled();
    await capabilities?.dispose();
  });
});
test('failed capability preparation disposes shared policy and routes', async () => {
  jest
    .mocked(resolvePlugins)
    .mockRejectedValueOnce(new Error('projection failed'));
  await withCapabilities(async (host) => {
    await expect(
      host.prepareCapabilities?.('/profile', new AbortController().signal),
    ).rejects.toThrow('projection failed');
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(mockUnregisterRoutes).toHaveBeenCalledTimes(1);
  });
});

test('pipeline capability identity tracks materialized content and selected MCP identity', async () => {
  await withCapabilities(async (host) => {
    const prepare = async (
      fingerprint: string,
    ): Promise<
      CopilotPipelineCapabilities['capabilitySnapshot'] | undefined
    > => {
      jest.mocked(materializeSelectedCapabilityRoot).mockResolvedValue({
        fingerprint,
        skillIds: ['selected-skill'],
        commandIds: [],
        warnings: [],
      });
      const capabilities = await host.prepareCapabilities?.(
        '/profile',
        new AbortController().signal,
      );
      const snapshot =
        capabilities && 'capabilitySnapshot' in capabilities
          ? capabilities.capabilitySnapshot
          : undefined;
      await capabilities?.dispose();
      return snapshot;
    };
    const first = await prepare('content-one');
    expect(first).toMatchObject({ version: 1 });
    expect(first).toHaveProperty(
      'digest',
      expect.stringMatching(/^[a-f0-9]{64}$/),
    );
    expect(await prepare('content-one')).toEqual(first);
    expect(await prepare('content-two')).not.toEqual(first);
    mockCapabilityDigests.mockReturnValue({ selected: 'b'.repeat(64) });
    expect(await prepare('content-one')).not.toEqual(first);
  });
});

test('pipeline preparation includes the user home skills and commands', async () => {
  await withCapabilities(async (host) => {
    const capabilities = await host.prepareCapabilities?.(
      '/profile',
      new AbortController().signal,
    );
    expect(resolvePlugins).toHaveBeenCalledWith(
      expect.anything(),
      'project',
      'execution',
      expect.any(String),
      expect.objectContaining({ inheritedCursorCapabilities: mockInherited }),
    );
    await capabilities?.dispose();
  });
});

test('pipeline preparation resolves enabled home plugins from their actual install', async () => {
  await withCapabilities(async (host) => {
    const capabilities = await host.prepareCapabilities?.(
      '/profile',
      new AbortController().signal,
    );
    expect(resolvePlugins).toHaveBeenCalledWith(
      expect.anything(),
      'project',
      'execution',
      expect.any(String),
      expect.objectContaining({
        inheritedPluginRefs: [
          {
            marketplaceId: 'fixture',
            pluginName: 'home-plugin',
            installPath: '/home/user/.claude/plugins/home-plugin',
          },
        ],
      }),
    );
    await capabilities?.dispose();
  });
});

test('pipeline cancellation before discovery does not resolve or materialize capabilities', async () => {
  await withCapabilities(async (host) => {
    const abort = new AbortController();
    abort.abort(new Error('pipeline cancelled'));
    await expect(
      host.prepareCapabilities?.('/profile', abort.signal),
    ).rejects.toThrow('pipeline cancelled');
    expect(discoverInheritedCursorCapabilities).not.toHaveBeenCalled();
    expect(resolvePlugins).not.toHaveBeenCalled();
    expect(materializeSelectedCapabilityRoot).not.toHaveBeenCalled();
  });
});

test('pipeline cancellation during home discovery prevents plugin resolution and releases its approval owner', async () => {
  await withCapabilities(async (host) => {
    const abort = new AbortController();
    jest
      .mocked(discoverInheritedCursorCapabilities)
      .mockImplementationOnce(() => {
        abort.abort(new Error('pipeline cancelled'));
        return Promise.resolve(mockInherited);
      });
    await expect(
      host.prepareCapabilities?.('/profile', abort.signal),
    ).rejects.toThrow('pipeline cancelled');
    expect(resolvePlugins).not.toHaveBeenCalled();
    expect(materializeSelectedCapabilityRoot).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(mockUnregisterRoutes).toHaveBeenCalledTimes(1);
  });
});

test('an unreadable home skill source does not remove the separately enabled plugin', async () => {
  const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest
    .mocked(discoverInheritedCursorCapabilities)
    .mockRejectedValueOnce(new Error('unreadable home skills'));
  try {
    await withCapabilities(async (host) => {
      const capabilities = await host.prepareCapabilities?.(
        '/profile',
        new AbortController().signal,
      );
      expect(jest.mocked(resolvePlugins).mock.calls.at(-1)?.[4]).toMatchObject({
        inheritedCursorCapabilities: {
          skills: [],
          commands: [],
        },
        inheritedPluginRefs: [
          {
            marketplaceId: 'fixture',
            pluginName: 'home-plugin',
            installPath: '/home/user/.claude/plugins/home-plugin',
          },
        ],
      });
      await capabilities?.dispose();
    });
  } finally {
    log.mockRestore();
  }
});

test.each([true, false])(
  'pipeline binds the effective MCP table when a selected server is enabled=%s',
  async (enabled) => {
    const resolved = await resolvePlugins(
      { collectionIds: [], pluginRefs: [], skillRefs: [] },
      'project',
      'worktree',
      'chat',
    );
    jest.mocked(resolvePlugins).mockResolvedValue({
      ...resolved,
      mcpServers: {
        selected: { type: 'stdio', command: 'fixture-server', enabled },
      },
    });
    await withCapabilities(async (host) => {
      const capabilities = await host.prepareCapabilities?.(
        '/profile',
        new AbortController().signal,
      );
      expect(capabilities?.mcpServers).toEqual(
        enabled
          ? {
              selected: {
                type: 'stdio',
                command: 'fixture-server',
                workingDirectory: '/workspace',
                env: {},
                tools: ['*'],
              },
            }
          : {},
      );
      expect(mockCapabilityDigests).toHaveBeenLastCalledWith(
        capabilities?.mcpServers,
      );
      await capabilities?.dispose();
    });
  },
);

test('pipeline binds the translated MCP tool allowlist', async () => {
  await withCapabilities(async (host) => {
    const capabilities = await host.prepareCapabilities?.(
      '/profile',
      new AbortController().signal,
    );
    expect(mockCapabilityDigests).toHaveBeenLastCalledWith({
      selected: {
        type: 'http',
        url: 'http://localhost/selected',
        headers: {},
        tools: ['change'],
      },
    });
    await capabilities?.dispose();
  });
});
