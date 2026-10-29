import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

interface MockDiscoveryQueryInput {
  options?: {
    allowDangerouslySkipPermissions?: boolean;
    abortController?: AbortController;
    cwd?: string;
    env?: Record<string, string>;
    mcpServers?: Record<string, unknown>;
    model?: string;
    pathToClaudeCodeExecutable?: string;
    permissionMode?: string;
    settingSources?: string[];
    settings?: {
      apiKeyHelper?: string;
      autoMemoryEnabled?: boolean;
      awsAuthRefresh?: string;
      awsCredentialExport?: string;
      disableAllHooks?: boolean;
      env?: Record<string, string>;
      fileSuggestion?: { type: 'command'; command: string };
      gcpAuthRefresh?: string;
      otelHeadersHelper?: string;
      proxyAuthHelper?: string;
    };
    sandbox?: { ripgrep?: { command?: string } };
    spawnClaudeCodeProcess?: unknown;
    strictMcpConfig?: boolean;
  };
  prompt?: unknown;
}

const mockQuery = jest.fn<unknown, [MockDiscoveryQueryInput]>();
const mockSupportedCommands = jest.fn();
const mockMcpServerStatus = jest.fn();
const mockInterrupt = jest.fn();
const mockSpawnClaudeCodeProcessOffMain = jest.fn();

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: mockQuery,
}));
jest.mock('../agents/claude-process-host-runner', () => ({
  spawnClaudeCodeProcessOffMain: mockSpawnClaudeCodeProcessOffMain,
}));
// Local memory is opt-in (CAN-1969); resolve synchronously (no fs I/O).
// Default off; individual tests flip the mock to assert suppression.
jest.mock('../lib/preferences-store', () => ({
  ...jest.requireActual<typeof PreferencesStoreModule>(
    '../lib/preferences-store',
  ),
  readLocalMemoryEnabledPreference: jest.fn(() => Promise.resolve(false)),
}));
jest.mock('../pipelines/config-paths', () => ({
  getBundledClaudeBinaryPath: jest.fn(() => '/mock/claude'),
  getBundledRgBinaryPath: jest.fn(() => '/mock/rg'),
  getEnhancedEnv: jest.fn(() => ({ ...process.env })),
}));

import { discoverWorktreeEnvironment } from '../agents/sdk-discovery';
import {
  discoverProjectInvocableSources,
  discoverProjectSlashCommands,
} from '../agents/project-slash-command-discovery';
import { getEnhancedEnv } from '../pipelines/config-paths';
import type * as PreferencesStoreModule from '../lib/preferences-store';
import { readLocalMemoryEnabledPreference } from '../lib/preferences-store';

const mockedReadLocalMemoryEnabledPreference = jest.mocked(
  readLocalMemoryEnabledPreference,
);

describe('sdk-discovery', () => {
  it('tracks an absent repo-local root for later staleness checks', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'sdk-invocable-absent-'));
    try {
      await expect(discoverProjectInvocableSources(cwd)).resolves.toEqual({
        entries: [],
        scannedDirectories: [path.join(cwd, '.claude')],
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('returns distinct repo-local command and skill sources', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'sdk-invocable-sources-'));
    try {
      await mkdir(path.join(cwd, '.claude', 'commands', 'nested'), {
        recursive: true,
      });
      await mkdir(path.join(cwd, '.claude', 'skills', 'review'), {
        recursive: true,
      });
      await writeFile(
        path.join(cwd, '.claude', 'commands', 'nested', 'repair.md'),
        '# Repair\n',
      );
      await writeFile(
        path.join(cwd, '.claude', 'skills', 'review', 'SKILL.md'),
        '# Review\n',
      );

      const result = await discoverProjectInvocableSources(cwd);
      expect(result.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'nested:repair',
            kind: 'command',
            absolutePath: path.join(
              cwd,
              '.claude',
              'commands',
              'nested',
              'repair.md',
            ),
          }),
          expect.objectContaining({
            name: 'review',
            kind: 'skill',
            absolutePath: path.join(cwd, '.claude', 'skills', 'review'),
          }),
        ]),
      );
      expect(result.scannedDirectories).toEqual(
        expect.arrayContaining([
          path.join(cwd, '.claude'),
          path.join(cwd, '.claude', 'commands'),
          path.join(cwd, '.claude', 'commands', 'nested'),
          path.join(cwd, '.claude', 'skills'),
        ]),
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('uses a project skill when a legacy command has the same invocation name', async () => {
    const cwd = await mkdtemp(
      path.join(os.tmpdir(), 'sdk-invocable-collision-'),
    );
    const skillDir = path.join(cwd, '.claude', 'skills', 'collision');
    const commandPath = path.join(cwd, '.claude', 'commands', 'collision.md');
    try {
      await mkdir(skillDir, { recursive: true });
      await mkdir(path.dirname(commandPath), { recursive: true });
      await writeFile(path.join(skillDir, 'SKILL.md'), '# Project skill\n');
      await writeFile(commandPath, '# Legacy command\n');

      const result = await discoverProjectInvocableSources(cwd);

      expect(
        result.entries.filter((entry) => entry.name === 'collision'),
      ).toEqual([
        {
          name: 'collision',
          kind: 'skill',
          absolutePath: skillDir,
        },
      ]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    mockQuery.mockReset();
    mockSupportedCommands.mockReset();
    mockMcpServerStatus.mockReset();
    mockInterrupt.mockReset();
    jest.mocked(getEnhancedEnv).mockClear();

    mockSupportedCommands.mockResolvedValue([]);
    mockMcpServerStatus.mockResolvedValue([]);
    mockInterrupt.mockResolvedValue(undefined);
    mockQuery.mockReturnValue({
      supportedCommands: mockSupportedCommands,
      mcpServerStatus: mockMcpServerStatus,
      interrupt: mockInterrupt,
    });
  });

  it('passes the bundled Claude path to the discovery query', async () => {
    const result = await discoverWorktreeEnvironment('/tmp/repo');
    const firstCall = mockQuery.mock.calls[0]?.[0];

    expect(result).toEqual({ slashCommands: [], mcpServers: [] });
    expect(firstCall?.prompt).toBeDefined();
    expect(firstCall?.options?.cwd).toBe('/tmp/repo');
    expect(firstCall?.options?.pathToClaudeCodeExecutable).toBe('/mock/claude');
    expect(firstCall?.options?.spawnClaudeCodeProcess).toBe(
      mockSpawnClaudeCodeProcessOffMain,
    );
    expect(firstCall?.options?.permissionMode).toBe('bypassPermissions');
    expect(firstCall?.options?.allowDangerouslySkipPermissions).toBe(true);
    expect(firstCall?.options?.settingSources).toEqual([
      'user',
      'project',
      'local',
    ]);
    expect(firstCall?.options?.sandbox?.ripgrep?.command).toBe('/mock/rg');
    expect(mockInterrupt).toHaveBeenCalled();
  });

  it('can force discovery to ignore project MCP config without changing setting sources', async () => {
    await discoverWorktreeEnvironment(
      '/tmp/repo-shadow',
      undefined,
      undefined,
      undefined,
      undefined,
      'workspace-1',
      { strictEmptyMcpConfig: true },
    );

    const firstCall = mockQuery.mock.calls[0]?.[0];

    expect(firstCall?.options?.settingSources).toEqual([
      'user',
      'project',
      'local',
    ]);
    expect(firstCall?.options?.strictMcpConfig).toBe(true);
    expect(firstCall?.options?.mcpServers).toEqual({});
  });

  it('discovers project commands without loading repository settings or managed secrets', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'sdk-discovery-safe-'));
    const skillDir = path.join(cwd, '.claude', 'skills', 'project-skill');
    const collisionSkillDir = path.join(cwd, '.claude', 'skills', 'collision');
    const commandDir = path.join(cwd, '.claude', 'commands', 'release');
    await Promise.all([
      mkdir(skillDir, { recursive: true }),
      mkdir(collisionSkillDir, { recursive: true }),
      mkdir(commandDir, { recursive: true }),
    ]);
    await writeFile(
      path.join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: project-skill',
        'description: Project skill discovered without repository settings',
        'argument-hint: <target>',
        '---',
        '',
        '# Project skill',
      ].join('\n'),
    );
    await writeFile(
      path.join(collisionSkillDir, 'SKILL.md'),
      [
        '---',
        'name: collision-alias',
        'description: Project skill wins over legacy command',
        '---',
      ].join('\n'),
    );
    await writeFile(
      path.join(commandDir, 'run.md'),
      [
        '---',
        'name: ship',
        'description: Run the release workflow',
        'argument-hint: <version>',
        '---',
        '',
        '# Release command',
      ].join('\n'),
    );
    await writeFile(
      path.join(cwd, '.claude', 'commands', 'collision.md'),
      ['---', 'description: Legacy command loses to project skill', '---'].join(
        '\n',
      ),
    );
    mockSupportedCommands.mockResolvedValueOnce([
      {
        name: 'project-skill',
        description: 'User skill wins over project skill',
        argumentHint: '<user-target>',
      },
    ]);

    let result;
    try {
      result = await discoverWorktreeEnvironment(
        cwd,
        undefined,
        undefined,
        undefined,
        undefined,
        'workspace-1',
        {
          strictEmptyMcpConfig: true,
          safeProjectDiscovery: true,
        },
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }

    const firstCall = mockQuery.mock.calls[0]?.[0];

    expect(result.slashCommands).toContainEqual({
      name: 'project-skill',
      description: 'User skill wins over project skill',
      argumentHint: '<user-target>',
    });
    expect(result.slashCommands).toContainEqual({
      name: 'release:run',
      description: 'Run the release workflow',
      argumentHint: '<version>',
    });
    expect(result.slashCommands).toContainEqual({
      name: 'collision',
      description: 'Project skill wins over legacy command',
      argumentHint: '',
    });
    expect(result.slashCommands).not.toContainEqual(
      expect.objectContaining({ name: 'ship' }),
    );
    expect(result.slashCommands).not.toContainEqual(
      expect.objectContaining({ name: 'collision-alias' }),
    );
    expect(firstCall?.options?.settingSources).toEqual(['user']);
    expect(firstCall?.options?.settings).toBeUndefined();
    expect(firstCall?.options?.strictMcpConfig).toBe(true);
    expect(getEnhancedEnv).toHaveBeenCalledWith({
      includeCanopySecrets: false,
      environment: false,
    });
  });

  it.each([
    [
      '---\nargument-hint: <repository>\n---\n\n# Research a GitHub Repository\n\nDetailed instructions.',
      'Research a GitHub Repository',
      '<repository>',
    ],
    ['\n\nResearch a repository.\nMore details.', 'Research a repository.', ''],
    [
      '---\ndescription: Explicit description\n---\n# Fallback title',
      'Explicit description',
      '',
    ],
    ['---\nargument-hint: <repository>\n---\n\n', '', '<repository>'],
    [
      '---\n---\n# Description after empty frontmatter',
      'Description after empty frontmatter',
      '',
    ],
    [
      '---\nargument-hint: <repository>\n# Description after unclosed frontmatter',
      'Description after unclosed frontmatter',
      '',
    ],
    [
      '---\nname: research\n# Metadata comment\nallowed-tools: Bash\n# Description after extended frontmatter\n\nPrompt body',
      'Description after extended frontmatter',
      '',
    ],
    [
      '#\n\n## First meaningful prompt line',
      'First meaningful prompt line',
      '',
    ],
    ['---\ndescription: ""\n---\n  ## Fallback title', 'Fallback title', ''],
    ['x'.repeat(200), `${'x'.repeat(97)}...`, ''],
  ])(
    'uses command content when the description is omitted (%s)',
    async (content, description, argumentHint) => {
      const cwd = await mkdtemp(
        path.join(os.tmpdir(), 'sdk-discovery-description-'),
      );
      const commandDir = path.join(cwd, '.claude', 'commands');
      try {
        await mkdir(commandDir, { recursive: true });
        await writeFile(path.join(commandDir, 'research-repo.md'), content);
        expect(await discoverProjectSlashCommands(cwd)).toContainEqual({
          name: 'research-repo',
          description,
          argumentHint,
        });
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
  );

  it('bounds and cancels repository metadata scanning', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'sdk-discovery-bounds-'));
    const skillsRoot = path.join(cwd, '.claude', 'skills');
    await mkdir(skillsRoot, { recursive: true });

    try {
      const largeDescription = 'x'.repeat(5_000);
      await mkdir(path.join(skillsRoot, 'oversized-fields'));
      await writeFile(
        path.join(skillsRoot, 'oversized-fields', 'SKILL.md'),
        [
          '---',
          'name: oversized-fields',
          `description: ${largeDescription}`,
          '---',
        ].join('\n'),
      );

      for (let index = 0; index < 6; index += 1) {
        const skillDir = path.join(skillsRoot, `large-${index}`);
        await mkdir(skillDir);
        await writeFile(
          path.join(skillDir, 'SKILL.md'),
          [
            '---',
            `name: large-${index}`,
            `description: ${'y'.repeat(900_000)}`,
            '---',
          ].join('\n'),
        );
      }

      const commands = await discoverProjectSlashCommands(cwd);
      expect(
        commands.find((command) => command.name === 'oversized-fields')
          ?.description.length,
      ).toBeLessThanOrEqual(1_000);
      expect(
        commands.filter((command) => command.name.startsWith('large-')),
      ).toHaveLength(4);

      const abortController = new AbortController();
      abortController.abort();
      await expect(
        discoverProjectSlashCommands(cwd, abortController.signal),
      ).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not resolve aliases or merge keys in repository frontmatter', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'sdk-discovery-yaml-'));
    const skillDir = path.join(cwd, '.claude', 'skills', 'alias-chain');
    await mkdir(skillDir, { recursive: true });

    try {
      const mergeChain = Array.from({ length: 20 }, (_, index) =>
        index === 0
          ? 'node-0: &node-0 { value: x }'
          : `node-${index}: &node-${index} { <<: *node-${index - 1}, value: x }`,
      );
      await writeFile(
        path.join(skillDir, 'SKILL.md'),
        [
          '---',
          ...mergeChain,
          'disabled: &disabled false',
          'user-invocable: *disabled',
          'description: *disabled',
          '---',
        ].join('\n'),
      );

      await expect(discoverProjectSlashCommands(cwd)).resolves.toContainEqual({
        name: 'alias-chain',
        description: '',
        argumentHint: '',
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('honors Claude-compatible false scalars in repository frontmatter', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'sdk-discovery-false-'));
    const skillsRoot = path.join(cwd, '.claude', 'skills');

    try {
      for (const [name, userInvocable] of [
        ['capitalized-false', 'False'],
        ['uppercase-false', 'FALSE'],
        ['commented-false', 'false # hidden from users'],
        ['visible-skill', 'true # visible to users'],
      ] as const) {
        const skillDir = path.join(skillsRoot, name);
        await mkdir(skillDir, { recursive: true });
        await writeFile(
          path.join(skillDir, 'SKILL.md'),
          [
            '---',
            `description: ${name}`,
            `user-invocable: ${userInvocable}`,
            '---',
          ].join('\n'),
        );
      }

      const commands = await discoverProjectSlashCommands(cwd);
      expect(commands.map((command) => command.name)).toEqual([
        'visible-skill',
      ]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('aborts discovery work when the timeout expires', async () => {
    mockSupportedCommands.mockReturnValueOnce(new Promise(() => {}));

    await expect(
      discoverWorktreeEnvironment(
        '/tmp/repo-shadow',
        undefined,
        1,
        undefined,
        undefined,
        'workspace-1',
        { safeProjectDiscovery: true },
      ),
    ).rejects.toThrow('Discovery timed out');

    expect(
      mockQuery.mock.calls[0]?.[0]?.options?.abortController?.signal.aborted,
    ).toBe(true);
  });

  it("matches Claude's exact project skill file-size boundary", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'sdk-discovery-size-'));
    const skillsRoot = path.join(cwd, '.claude', 'skills');

    try {
      for (const [name, size] of [
        ['accepted-skill', 1_000_000],
        ['rejected-skill', 1_000_001],
      ] as const) {
        const skillDir = path.join(skillsRoot, name);
        await mkdir(skillDir, { recursive: true });
        const frontmatter = [
          '---',
          `name: ${name}`,
          `description: ${name}`,
          '---',
          '',
        ].join('\n');
        await writeFile(
          path.join(skillDir, 'SKILL.md'),
          frontmatter.padEnd(size, 'x'),
        );
      }

      const commands = await discoverProjectSlashCommands(cwd);
      expect(commands).toContainEqual(
        expect.objectContaining({ name: 'accepted-skill' }),
      );
      expect(commands).not.toContainEqual(
        expect.objectContaining({ name: 'rejected-skill' }),
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('keeps native-memory suppression during safe project discovery', async () => {
    mockedReadLocalMemoryEnabledPreference.mockResolvedValueOnce(true);

    await discoverWorktreeEnvironment(
      '/tmp/repo-shadow',
      undefined,
      undefined,
      undefined,
      undefined,
      'workspace-1',
      {
        strictEmptyMcpConfig: true,
        safeProjectDiscovery: true,
      },
    );

    expect(mockQuery.mock.calls[0]?.[0]?.options?.settingSources).toEqual([
      'user',
    ]);
    expect(mockQuery.mock.calls[0]?.[0]?.options?.settings).toEqual({
      autoMemoryEnabled: false,
    });
  });

  it('applies Claude-compatible invocation overrides for ollama discovery', async () => {
    await discoverWorktreeEnvironment(
      '/tmp/repo',
      undefined,
      undefined,
      undefined,
      {
        providerType: 'ollama',
        sdkModel: 'qwen3-coder',
        envOverride: {
          ANTHROPIC_BASE_URL: 'http://127.0.0.1:11534',
          ANTHROPIC_AUTH_TOKEN: 'ollama',
        },
      },
    );

    const firstCall = mockQuery.mock.calls[0]?.[0];

    expect(firstCall?.options?.model).toBe('qwen3-coder');
    expect(firstCall?.options?.env).toEqual(
      expect.objectContaining({
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:11534',
        ANTHROPIC_AUTH_TOKEN: 'ollama',
      }),
    );
  });

  it('suppresses native memory on discovery sessions only while local memory is enabled', async () => {
    const original = process.env.CANOPY_HARNESS_NATIVE_MEMORY;
    delete process.env.CANOPY_HARNESS_NATIVE_MEMORY;
    try {
      // Default: local memory is opt-in and off — provider defaults apply.
      await discoverWorktreeEnvironment('/tmp/repo');
      expect(mockQuery.mock.calls[0]?.[0]?.options?.settings).toBeUndefined();

      // Enabled: harness-native auto-memory is suppressed.
      mockQuery.mockClear();
      mockedReadLocalMemoryEnabledPreference.mockResolvedValueOnce(true);
      await discoverWorktreeEnvironment('/tmp/repo');
      expect(mockQuery.mock.calls[0]?.[0]?.options?.settings).toEqual({
        autoMemoryEnabled: false,
      });

      // Escape hatch force-allows native memory even while enabled.
      mockQuery.mockClear();
      mockedReadLocalMemoryEnabledPreference.mockResolvedValueOnce(true);
      process.env.CANOPY_HARNESS_NATIVE_MEMORY = '1';
      await discoverWorktreeEnvironment('/tmp/repo');
      expect(mockQuery.mock.calls[0]?.[0]?.options?.settings).toBeUndefined();
    } finally {
      if (original === undefined) {
        delete process.env.CANOPY_HARNESS_NATIVE_MEMORY;
      } else {
        process.env.CANOPY_HARNESS_NATIVE_MEMORY = original;
      }
    }
  });

  it('resolves agent runtime env with project scope when provided', async () => {
    await discoverWorktreeEnvironment(
      '/tmp/repo',
      undefined,
      undefined,
      undefined,
      undefined,
      'workspace-1',
    );

    expect(getEnhancedEnv).toHaveBeenCalledWith({
      environment: { runtime: 'agent', workspaceId: 'workspace-1' },
    });
  });
});
