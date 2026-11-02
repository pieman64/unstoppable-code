import { createCopilotSessionConfig } from '../session-policy';

describe('Copilot host policy boundary', () => {
  const controller = new AbortController();
  const options = {
    workingDirectory: '/workspace',
    configDirectory: '/state',
    model: 'vendor-model',
    signal: controller.signal,
    authorize: jest.fn(() => Promise.resolve({ decision: 'allow' as const })),
  };
  const input = {
    sessionId: 'session',
    timestamp: new Date(0),
    workingDirectory: '/workspace',
    toolName: 'view',
    toolArgs: { path: '/workspace/file' },
  };

  it('uses explicit capability selections and disables ambient authorities on create and resume', () => {
    const config = createCopilotSessionConfig(options);
    expect(config).toMatchObject({
      model: 'vendor-model',
      enableConfigDiscovery: false,
      skipCustomInstructions: true,
      enableFileHooks: false,
      enableOnDemandInstructionDiscovery: false,
      enableSessionStore: false,
      enableHostGitOperations: false,
      enableSessionTelemetry: false,
      remoteSession: 'off',
      requestExtensions: false,
      pluginDirectories: [],
      customAgents: [],
      includedBuiltinSkills: [],
      mcpServers: {},
      disabledMcpServers: ['github-mcp-server'],
      memory: { enabled: false },
    });
    expect(config.availableTools).toContain('builtin:view');
    expect(config.availableTools).not.toContain('builtin:task');
    expect(config.availableTools).not.toContain('builtin:cron');
    expect(config.availableTools).not.toContain('mcp:*');
  });

  it('keeps the built-in GitHub MCP server out when host servers enable MCP tools', () => {
    const config = createCopilotSessionConfig({
      ...options,
      mcpServers: {
        selected: { type: 'http', url: 'https://mcp.example', tools: ['*'] },
      },
    });
    expect(config.availableTools).toContain('mcp:*');
    expect(config.disabledMcpServers).toEqual(['github-mcp-server']);
  });

  it('disables a built-in name even when a host server reuses it', () => {
    const config = createCopilotSessionConfig({
      ...options,
      mcpServers: {
        'github-mcp-server': {
          type: 'http',
          url: 'https://mcp.example',
          tools: ['*'],
        },
      },
    });
    expect(config.disabledMcpServers).toEqual(['github-mcp-server']);
  });

  it('explicitly denies a policy error because the SDK swallows thrown hook errors', async () => {
    const config = createCopilotSessionConfig({
      ...options,
      authorize: () => Promise.reject(new Error('policy unavailable')),
    });
    await expect(
      config.hooks?.onPreToolUse?.(input, { sessionId: 'session' }),
    ).resolves.toMatchObject({ permissionDecision: 'deny' });
  });

  it('revokes a pending approval when the turn is cancelled', async () => {
    const turn = new AbortController();
    let allow!: (value: { decision: 'allow' }) => void;
    const config = createCopilotSessionConfig({
      ...options,
      signal: turn.signal,
      authorize: () =>
        new Promise((resolve) => {
          allow = resolve;
        }),
    });
    const pending = config.hooks?.onPreToolUse?.(input, {
      sessionId: 'session',
    });
    turn.abort();
    allow({ decision: 'allow' });
    await expect(pending).resolves.toMatchObject({
      permissionDecision: 'deny',
    });
  });

  it('does not grant a provider permission request outside the shared hook decision', async () => {
    const config = createCopilotSessionConfig(options);
    await expect(
      config.onPermissionRequest?.(
        { kind: 'read', path: '/outside', intention: 'Read a file' },
        { sessionId: 'session' },
      ),
    ).resolves.toMatchObject({ kind: 'reject' });
  });

  it('settles cancellation without waiting for an unavailable approval service', async () => {
    const turn = new AbortController();
    const config = createCopilotSessionConfig({
      ...options,
      signal: turn.signal,
      authorize: () => new Promise(() => {}),
    });
    const pending = config.hooks?.onPreToolUse?.(input, {
      sessionId: 'session',
    });
    turn.abort();
    const settled = await Promise.race([
      pending,
      new Promise((resolve) => setTimeout(() => resolve('still pending'), 50)),
    ]);
    expect(settled).toMatchObject({ permissionDecision: 'deny' });
  });

  it('does not let the runtime switch models when quota is exhausted', async () => {
    const config = createCopilotSessionConfig(options);
    await expect(
      config.onAutoModeSwitchRequest?.({}, { sessionId: 'session' }),
    ).resolves.toBe('no');
  });

  it('passes the host token provider through to the session config', () => {
    const gitHubTokenProvider = jest.fn(
      (): Promise<{
        kind: 'token';
        accessToken: string;
        expiresIn: number;
      }> =>
        Promise.resolve({
          kind: 'token' as const,
          accessToken: 'ghu_x',
          expiresIn: 3600,
        }),
    );
    const config = createCopilotSessionConfig({
      ...options,
      gitHubTokenProvider,
    });
    expect(config.gitHubTokenProvider).toBe(gitHubTokenProvider);
    expect(config.gitHubToken).toBeUndefined();
  });
});
