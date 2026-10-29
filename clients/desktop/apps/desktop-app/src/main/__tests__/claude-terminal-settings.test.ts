import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  brandEnvCandidates,
  brandEnvName,
} from '@canopy/desktop-shared/brand/env';

// Local memory is opt-in (CAN-1969); default off so the settings file omits
// the native-memory suppression key. Tests flip the mock to assert it.
jest.mock('../lib/preferences-store', () => ({
  ...jest.requireActual<typeof PreferencesStoreModule>(
    '../lib/preferences-store',
  ),
  readLocalMemoryEnabledPreference: jest.fn(() => Promise.resolve(false)),
}));
jest.mock('../pipelines/config-paths', () => ({
  getBundledClaudeBinaryPath: jest.fn(() => '/bin/claude'),
  getBundledRgBinaryPath: jest.fn(() => '/bin/rg'),
  getBundledRtkBinaryPath: jest.fn(() => '/bin/rtk'),
  getRtkManagedEnv: jest.fn(() => ({ RTK_ENV: '1' })),
}));

jest.mock('../plugins/plugin-resolver', () => ({
  resolvePlugins: jest.fn(() =>
    Promise.resolve({
      mcpServers: {
        canopy: { type: 'stdio', command: 'reserved-collision' },
        extra: { type: 'stdio', command: 'extra' },
      },
      warnings: [],
    }),
  ),
}));
jest.mock('../plugins/global-plugin-overlay', () => ({
  resolveEffectiveChatPluginContext: jest.fn(
    (selections?: {
      collectionIds?: string[];
      skillRefs?: unknown[];
      pluginRefs?: unknown[];
      mcpServerRefs?: unknown[];
    }) =>
      Promise.resolve({
        selections: selections ?? {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
        },
      }),
  ),
}));

jest.mock('../lib/paths', () => ({
  getElectronAsNodeBinaryPath: jest.fn(
    () => '/Applications/Canopy.app/Contents/MacOS/Canopy',
  ),
}));

const mockIsModelBlockedByStoredPolicy = jest.fn<
  Promise<boolean>,
  [string | undefined]
>(() => Promise.resolve(false));

const mockIsOrgModelPolicyActive = jest.fn(() => Promise.resolve(false));
jest.mock('../lib/model-policy-state', () => ({
  isModelBlockedByStoredPolicy: (
    modelId: string | undefined,
  ): Promise<boolean> => mockIsModelBlockedByStoredPolicy(modelId),
  isOrgModelPolicyActiveForStoredAccount: (): Promise<boolean> =>
    mockIsOrgModelPolicyActive(),
}));

jest.mock('../integration/desktop-integration-server', () => ({
  getDesktopIntegrationServer: jest.fn(() => ({
    getCanopyWorktreeMcpUrl: (sessionKey: string): string =>
      `http://127.0.0.1:3210/canopy/mcp/worktree-session/${sessionKey}`,
    getClaudeTerminalHookUrl: (sessionKey: string): string =>
      `http://127.0.0.1:3210/canopy/hooks/claude-terminal/worktree-session/${sessionKey}`,
  })),
}));

import { DEFAULT_CLAUDE_MODEL } from '@canopy/desktop-shared/types';
import { z } from 'zod';
import { buildClaudeTerminalLaunchConfig } from '../integration/claude-terminal-settings';
import type * as PreferencesStoreModule from '../lib/preferences-store';
import { readLocalMemoryEnabledPreference } from '../lib/preferences-store';

const mockedReadLocalMemoryEnabledPreference = jest.mocked(
  readLocalMemoryEnabledPreference,
);

// Loose object schemas: validate the shape the assertions rely on while
// preserving any additional keys, so `Object.keys(...)` assertions still see
// the full written JSON. Typed parsing without `as` casts (CAN-1969 review).
const hookGroupSchema = z.looseObject({
  hooks: z.array(
    z.looseObject({ command: z.string(), timeout: z.number().optional() }),
  ),
});

const claudeTerminalSettingsSchema = z.looseObject({
  autoMemoryEnabled: z.boolean().optional(),
  permissions: z.looseObject({
    ask: z.array(z.string()),
    skipDangerousModePermissionPrompt: z.boolean(),
  }),
  hooks: z.looseObject({
    PostCompact: z.array(hookGroupSchema),
    PreToolUse: z.array(hookGroupSchema),
    SessionStart: z.array(hookGroupSchema),
    SubagentStart: z.array(hookGroupSchema),
  }),
  sandbox: z.looseObject({
    ripgrep: z.looseObject({ command: z.string() }),
  }),
});

const claudeTerminalMcpSchema = z.looseObject({
  mcpServers: z.looseObject({
    canopy: z.looseObject({
      headers: z.looseObject({ Authorization: z.string() }),
    }),
    canopy_resolved: z.looseObject({ command: z.string() }),
    extra: z.looseObject({ command: z.string() }),
  }),
});

function parseClaudeTerminalSettingsJson(
  raw: string,
): z.infer<typeof claudeTerminalSettingsSchema> {
  return claudeTerminalSettingsSchema.parse(JSON.parse(raw));
}

function parseClaudeTerminalMcpJson(
  raw: string,
): z.infer<typeof claudeTerminalMcpSchema> {
  return claudeTerminalMcpSchema.parse(JSON.parse(raw));
}

describe('claude-terminal-settings', () => {
  let runtimeDir: string;
  const nativeMemoryEnvNames = brandEnvCandidates('HARNESS_NATIVE_MEMORY');
  let nativeMemoryEnvSnapshot: Record<string, string | undefined>;

  beforeEach(async () => {
    mockIsModelBlockedByStoredPolicy.mockReset();
    mockIsModelBlockedByStoredPolicy.mockResolvedValue(false);
    mockIsOrgModelPolicyActive.mockReset();
    mockIsOrgModelPolicyActive.mockResolvedValue(false);
    nativeMemoryEnvSnapshot = {};
    for (const name of nativeMemoryEnvNames) {
      nativeMemoryEnvSnapshot[name] = process.env[name];
      delete process.env[name];
    }
    runtimeDir = await mkdtemp(
      path.join(os.tmpdir(), 'canopy claude terminal-'),
    );
  });

  afterEach(async () => {
    for (const name of nativeMemoryEnvNames) {
      const value = nativeMemoryEnvSnapshot[name];
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    await rm(runtimeDir, { recursive: true, force: true });
  });

  it('writes Canopy-owned settings and strict MCP config without leaking base process env into managed overrides', async () => {
    const warnSpy = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);

    const config = await buildClaudeTerminalLaunchConfig({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'c',
      cwd: runtimeDir,
      runtimeDir,
      sessionKey: 'session-key',
      authToken: 'token',
      sdkSessionId: 'sdk',
      resumeExistingSession: true,
      planMode: true,
      model: 'claude-sonnet-4-6',
      thinkingLevel: 'medium',
      systemPromptAppend: 'system append',
      initialPrompt: 'Review failures',
      pluginSelections: {
        bundleIds: [],
        skillRefs: [],
        pluginRefs: [{ marketplaceId: 'marketplace', pluginName: 'plugin' }],
      },
    });

    expect(config.executable).toBe('/bin/claude');
    expect(config.args).toEqual(
      expect.arrayContaining([
        '--settings',
        config.settingsPath,
        '--mcp-config',
        config.mcpConfigPath,
        '--strict-mcp-config',
        '--setting-sources',
        'user,project,local',
        '--permission-mode',
        'plan',
        '--resume',
        'sdk',
      ]),
    );
    expect(config.args.slice(-2)).toEqual(['--', 'Review failures']);
    expect(
      config.args[config.args.indexOf('--disallowedTools') + 1].split(','),
    ).toContain('ScheduleWakeup');
    expect(config.args).not.toContain('--session-id');
    expect(config.env.PATH).toBeUndefined();
    expect(config.env.SHELL).toBeUndefined();
    expect(config.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(config.env.CANOPY_ELECTRON_NODE_PATH).toBe(
      '/Applications/Canopy.app/Contents/MacOS/Canopy',
    );
    expect(config.env.RTK_ENV).toBe('1');
    expect(config.pathPrepend).toEqual(
      process.platform === 'darwin' ? [path.join(runtimeDir, 'bin')] : [],
    );

    const settings = parseClaudeTerminalSettingsJson(
      await readFile(config.settingsPath, 'utf8'),
    );
    // Local memory is opt-in and off by default, so the settings file does
    // not carry the native-memory suppression key (CAN-1969).
    expect(Object.keys(settings).sort()).toEqual([
      'hooks',
      'permissions',
      'sandbox',
    ]);
    expect(settings.autoMemoryEnabled).toBeUndefined();
    expect(settings.permissions.skipDangerousModePermissionPrompt).toBe(true);
    expect(settings.permissions.ask).toEqual(['*']);
    expect(settings.hooks).toHaveProperty('PostCompact');
    expect(settings.hooks.SubagentStart[0].hooks[0].command).toContain(
      'SubagentStart',
    );
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain(
      'rtk-hook-wrapper',
    );
    if (process.platform === 'win32') {
      expect(settings.hooks.SessionStart[0].hooks[0].command).toMatch(
        /^".*canopy-hook-callback\.cmd" SessionStart$/,
      );
      expect(settings.hooks.PreToolUse[0].hooks[0].command).toMatch(
        /^".*rtk-hook-wrapper\.cmd"$/,
      );
    } else {
      expect(settings.hooks.SessionStart[0].hooks[0].command).toMatch(
        /^'.*canopy-hook-callback\.sh' SessionStart$/,
      );
      expect(settings.hooks.PreToolUse[0].hooks[0].command).toMatch(
        /^'.*rtk-hook-wrapper\.sh'$/,
      );
    }
    expect(settings.sandbox.ripgrep.command).toBe('/bin/rg');
    expect(settings.hooks.PreToolUse[1].hooks[0].timeout).toBe(600);

    const mcpConfig = parseClaudeTerminalMcpJson(
      await readFile(config.mcpConfigPath, 'utf8'),
    );
    expect(mcpConfig.mcpServers.canopy.headers.Authorization).toBe(
      'Bearer token',
    );
    expect(mcpConfig.mcpServers.canopy_resolved.command).toBe(
      'reserved-collision',
    );
    expect(mcpConfig.mcpServers.extra.command).toBe('extra');
    expect(warnSpy).toHaveBeenCalledWith(
      '[claude-terminal-settings]',
      'Resolved MCP server "canopy" conflicts with the reserved terminal Canopy entry; renamed to "canopy_resolved".',
    );

    if (process.platform !== 'win32') {
      const runtimeStats = await stat(runtimeDir);
      const mcpConfigStats = await stat(config.mcpConfigPath);
      expect(runtimeStats.mode & 0o777).toBe(0o700);
      expect(mcpConfigStats.mode & 0o777).toBe(0o600);
    }
    if (process.platform === 'darwin') {
      const shimPath = path.join(runtimeDir, 'bin', 'caffeinate');
      await expect(readFile(shimPath, 'utf8')).resolves.toBe(
        '#!/bin/sh\nexit 0\n',
      );
      const shimStats = await stat(shimPath);
      expect(shimStats.mode & 0o777).toBe(0o755);
    }

    warnSpy.mockRestore();
  });

  it('writes the native-memory suppression while local memory is enabled', async () => {
    mockedReadLocalMemoryEnabledPreference.mockResolvedValueOnce(true);
    const config = await buildClaudeTerminalLaunchConfig({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'c',
      cwd: runtimeDir,
      runtimeDir,
      sessionKey: 'session-key',
      authToken: 'token',
      sdkSessionId: 'sdk',
      resumeExistingSession: true,
    });

    const settings = parseClaudeTerminalSettingsJson(
      await readFile(config.settingsPath, 'utf8'),
    );
    expect(settings.autoMemoryEnabled).toBe(false);
  });

  it('leaves native memory unspecified when the branded override is enabled', async () => {
    mockedReadLocalMemoryEnabledPreference.mockResolvedValueOnce(true);
    process.env[brandEnvName('HARNESS_NATIVE_MEMORY')] = '1';
    const config = await buildClaudeTerminalLaunchConfig({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'c',
      cwd: runtimeDir,
      runtimeDir,
      sessionKey: 'session-key',
      authToken: 'token',
      sdkSessionId: 'sdk',
      resumeExistingSession: true,
    });

    const settings = parseClaudeTerminalSettingsJson(
      await readFile(config.settingsPath, 'utf8'),
    );
    expect(settings.autoMemoryEnabled).toBeUndefined();
    expect(settings).not.toHaveProperty('autoMemoryEnabled');
  });

  it('omits the caffeinate shim when disabled', async () => {
    const config = await buildClaudeTerminalLaunchConfig({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'c',
      cwd: runtimeDir,
      runtimeDir,
      sessionKey: 'session-key',
      authToken: 'token',
      sdkSessionId: 'sdk',
      resumeExistingSession: true,
      preventClaudeNativeCaffeinate: false,
    });

    expect(config.pathPrepend).toEqual([]);
    await expect(
      readFile(path.join(runtimeDir, 'bin', 'caffeinate'), 'utf8'),
    ).rejects.toThrow();
  });

  it('omits the approval callback for callers without an approval session', async () => {
    const config = await buildClaudeTerminalLaunchConfig({
      projectId: 'workers',
      worktreeId: 'workers',
      chatId: 'worker',
      cwd: runtimeDir,
      runtimeDir,
      sessionKey: 'worker-session',
      authToken: 'token',
      sdkSessionId: 'sdk',
      resumeExistingSession: false,
      approvalHookEnabled: false,
    });
    const settings = parseClaudeTerminalSettingsJson(
      await readFile(config.settingsPath, 'utf8'),
    );

    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain(
      'rtk-hook-wrapper',
    );
    expect(settings.permissions.ask).toEqual(['*']);
  });

  it('keeps the native approval fallback for constrained workers when hooks are disabled', async () => {
    const config = await buildClaudeTerminalLaunchConfig({
      projectId: 'workers',
      worktreeId: 'workers',
      chatId: 'constrained-worker',
      cwd: runtimeDir,
      runtimeDir,
      sessionKey: 'constrained-worker-session',
      authToken: 'token',
      sdkSessionId: 'sdk',
      resumeExistingSession: false,
      approvalMode: 'auto',
      approvalHookEnabled: false,
      permission: { tools: ['Read', 'Glob', 'Grep'] },
      mcpServers: {
        selected: { type: 'http', url: 'https://example.test/mcp' },
      },
    });
    const settings = parseClaudeTerminalSettingsJson(
      await readFile(config.settingsPath, 'utf8'),
    );

    expect(settings.permissions.ask).toEqual(['*']);
    expect(settings.hooks.PreToolUse).toHaveLength(1);
  });

  it('keeps the native approval fallback for governed constrained workers', async () => {
    const config = await buildClaudeTerminalLaunchConfig({
      projectId: 'workers',
      worktreeId: 'workers',
      chatId: 'governed-worker',
      cwd: runtimeDir,
      runtimeDir,
      sessionKey: 'governed-worker-session',
      authToken: 'token',
      sdkSessionId: 'sdk',
      resumeExistingSession: false,
      approvalMode: 'auto',
      approvalHookEnabled: true,
      permission: { tools: ['Read', 'Glob', 'Grep'] },
    });
    const settings = parseClaudeTerminalSettingsJson(
      await readFile(config.settingsPath, 'utf8'),
    );

    expect(settings.permissions.ask).toEqual(['*']);
    expect(settings.hooks.PreToolUse).toHaveLength(2);
  });

  describe('approvalMode terminal flag mapping', () => {
    async function buildArgs(input: {
      planMode?: boolean;
      approvalMode?: 'ask' | 'auto' | 'full-access';
    }): Promise<string[]> {
      const config = await buildClaudeTerminalLaunchConfig({
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'c',
        cwd: runtimeDir,
        runtimeDir,
        sessionKey: 'session-key',
        authToken: 'token',
        sdkSessionId: 'sdk',
        resumeExistingSession: false,
        ...input,
      });
      return config.args;
    }

    it('routes full-access through the Canopy hook without native bypass flags', async () => {
      const args = await buildArgs({ approvalMode: 'full-access' });
      expect(args).not.toContain('--allow-dangerously-skip-permissions');
      expect(args).not.toContain('--permission-mode');
    });

    it('maps ask to neither the skip flag nor a permission mode', async () => {
      const args = await buildArgs({ approvalMode: 'ask' });
      expect(args).not.toContain('--allow-dangerously-skip-permissions');
      expect(args).not.toContain('--permission-mode');
    });

    it('defaults to ask when approvalMode is omitted', async () => {
      const args = await buildArgs({});
      expect(args).not.toContain('--allow-dangerously-skip-permissions');
      expect(args).not.toContain('--permission-mode');
    });

    it('routes auto through the Canopy hook without native acceptEdits', async () => {
      const args = await buildArgs({ approvalMode: 'auto' });
      expect(args).not.toContain('--allow-dangerously-skip-permissions');
      expect(args).not.toContain('--permission-mode');
    });

    it('keeps project instructions available in hook-governed sessions', async () => {
      const config = await buildClaudeTerminalLaunchConfig({
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'c',
        cwd: runtimeDir,
        runtimeDir,
        sessionKey: 'session-key',
        authToken: 'token',
        sdkSessionId: 'sdk',
        resumeExistingSession: false,
        approvalMode: 'auto',
        settingSources: ['user', 'project', 'local'],
      });

      expect(config.args).toEqual(
        expect.arrayContaining(['--setting-sources', 'user,project,local']),
      );
    });

    it('maps plan mode + ask to plan mode without the skip flag', async () => {
      const args = await buildArgs({ planMode: true, approvalMode: 'ask' });
      expect(args).not.toContain('--allow-dangerously-skip-permissions');
      expect(args).toEqual(
        expect.arrayContaining(['--permission-mode', 'plan']),
      );
    });

    it('keeps plan mode without enabling the native skip flag', async () => {
      const args = await buildArgs({
        planMode: true,
        approvalMode: 'full-access',
      });
      expect(args).not.toContain('--allow-dangerously-skip-permissions');
      expect(args).toEqual(
        expect.arrayContaining(['--permission-mode', 'plan']),
      );
    });

    it('lets an explicit permission override win regardless of approvalMode', async () => {
      const config = await buildClaudeTerminalLaunchConfig({
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'c',
        cwd: runtimeDir,
        runtimeDir,
        sessionKey: 'session-key',
        authToken: 'token',
        sdkSessionId: 'sdk',
        resumeExistingSession: false,
        approvalMode: 'full-access',
        permission: { permissionMode: 'acceptEdits' },
        settingSources: ['user', 'project', 'local'],
      });
      expect(config.args).not.toContain('--allow-dangerously-skip-permissions');
      expect(config.args).toEqual(
        expect.arrayContaining(['--permission-mode', 'acceptEdits']),
      );
      expect(config.args).toEqual(
        expect.arrayContaining(['--setting-sources', 'user,project,local']),
      );
    });
  });

  // The renderer's model-registry reconciliation is a best-effort UI filter on a
  // slow re-probe, so the managed Claude Code terminal must be gated in main —
  // `input.model` is handed straight to the CLI as `--model`.
  it('refuses to build a launch config when an org policy blocks the model', async () => {
    mockIsModelBlockedByStoredPolicy.mockResolvedValue(true);

    await expect(
      buildClaudeTerminalLaunchConfig({
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'c',
        cwd: runtimeDir,
        runtimeDir,
        sessionKey: 'session-key',
        authToken: 'token',
        sdkSessionId: 'sdk',
        resumeExistingSession: true,
        model: 'claude-sonnet-4-6',
      }),
    ).rejects.toThrow('This model is blocked by your organization policy.');

    expect(mockIsModelBlockedByStoredPolicy).toHaveBeenCalledWith(
      'claude-sonnet-4-6',
    );
    // Refused before anything is written: no settings, MCP config, or auth token
    // lands on disk.
    await expect(readdir(runtimeDir)).resolves.toEqual([]);
  });

  // `model` is optional and `--model` is omitted when absent, so the CLI would
  // pick an implicit default no check ever sees. Under an active policy the
  // default is PINNED and evaluated (mirroring the pipeline runtime's
  // `provider-default` pin) rather than refused outright — a model-less tab is
  // genuinely reachable, so blanket refusal would reject launches for a model
  // the user never picked.
  it('pins and runs the default model for a model-less policed launch', async () => {
    mockIsOrgModelPolicyActive.mockResolvedValue(true);

    const config = await buildClaudeTerminalLaunchConfig({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'c',
      cwd: runtimeDir,
      runtimeDir,
      sessionKey: 'session-key',
      authToken: 'token',
      sdkSessionId: 'sdk',
      resumeExistingSession: true,
    });

    // The pinned default is what was checked AND what the CLI receives — the
    // two must not diverge, or the check validated a model that never runs.
    expect(mockIsModelBlockedByStoredPolicy).toHaveBeenCalledWith(
      DEFAULT_CLAUDE_MODEL,
    );
    expect(config.args).toContain('--model');
    expect(config.args[config.args.indexOf('--model') + 1]).toBe(
      DEFAULT_CLAUDE_MODEL,
    );
  });

  it('refuses a model-less policed launch when the default is blocked', async () => {
    mockIsOrgModelPolicyActive.mockResolvedValue(true);
    mockIsModelBlockedByStoredPolicy.mockResolvedValue(true);

    await expect(
      buildClaudeTerminalLaunchConfig({
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'c',
        cwd: runtimeDir,
        runtimeDir,
        sessionKey: 'session-key',
        authToken: 'token',
        sdkSessionId: 'sdk',
        resumeExistingSession: true,
      }),
    ).rejects.toThrow('This model is blocked by your organization policy.');

    // Still fails closed, and still before anything is written to disk.
    await expect(readdir(runtimeDir)).resolves.toEqual([]);
  });

  it('leaves a model-less launch unpinned when no org policy is active', async () => {
    // An ungoverned account keeps the previous behavior exactly.
    mockIsOrgModelPolicyActive.mockResolvedValue(false);

    const config = await buildClaudeTerminalLaunchConfig({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'c',
      cwd: runtimeDir,
      runtimeDir,
      sessionKey: 'session-key',
      authToken: 'token',
      sdkSessionId: 'sdk',
      resumeExistingSession: true,
    });

    expect(config.args).not.toContain('--model');
  });

  it('passes the model through to the CLI when no policy blocks it', async () => {
    const config = await buildClaudeTerminalLaunchConfig({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'c',
      cwd: runtimeDir,
      runtimeDir,
      sessionKey: 'session-key',
      authToken: 'token',
      sdkSessionId: 'sdk',
      resumeExistingSession: true,
      model: 'claude-sonnet-4-6',
    });

    expect(mockIsModelBlockedByStoredPolicy).toHaveBeenCalledWith(
      'claude-sonnet-4-6',
    );
    expect(config.args).toEqual(
      expect.arrayContaining(['--model', 'claude-sonnet-4-6']),
    );
  });
});
