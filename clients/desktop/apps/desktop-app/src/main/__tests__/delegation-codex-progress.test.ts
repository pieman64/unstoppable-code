import { CodexDelegationProgress } from '../agents/delegation/codex-progress';
import {
  buildCodexDelegationThreadParams,
  createCodexDelegationRunner,
} from '../agents/delegation/codex-runner';
import type { AgentRunRequest } from '@canopy/desktop-shared/node/delegation';
import {
  DelegationParent,
  type DelegationParentBroker,
} from '@canopy/desktop-shared/node/delegation/parent';
import {
  flattenCodexThreadConfig,
  type CodexRuntimeService,
  type CodexThreadHandle,
} from '@canopy/desktop-shared/node/codex-runtime';
import type { AgentDelegationSnapshot } from '@canopy/protocol/delegation';
import { CANOPY_INJECTED_TOOL_REGISTRY } from '@canopy/desktop-shared/lib/canopy-injected-tools';
import type { ChildLedgerTools } from '../agents/delegation/ledger-tools';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { tools as makeDelegationTools } from './helpers/delegation-runner-fixtures/codex';

function runnerTools(
  overrides: Partial<Record<string, unknown>>,
): ReturnType<typeof makeDelegationTools> {
  const fixture = makeDelegationTools(overrides);
  // Preserve these older, deliberately partial runner doubles exactly.
  Reflect.deleteProperty(fixture, 'codexSandboxWritesRevoked');
  Reflect.deleteProperty(fixture, 'policyContextKey');
  Reflect.deleteProperty(fixture, 'observeCodex');
  Reflect.deleteProperty(fixture, 'approveCodex');
  Reflect.deleteProperty(fixture, 'authorizeMcp');
  return fixture;
}

function codexRuntimeFixture(runtime: object): () => CodexRuntimeService {
  // These tests exercise a narrow runtime subset, as in the shared runner fixture.
  return (): CodexRuntimeService => runtime as never;
}

function delegationParent(enableDelegationTools = true): DelegationParent {
  const snapshot: AgentDelegationSnapshot = {
    delegationId: 'grandchild',
    status: 'pending',
    outputTruncated: false,
  };
  const broker: DelegationParentBroker = {
    spawn: () => Promise.resolve({ ok: true, value: snapshot }),
    getOutput: () =>
      Promise.resolve({
        ok: true,
        value: {
          delegationId: 'grandchild',
          currentRunGeneration: 1,
          currentStatus: 'pending',
          latestResultIndex: null,
          result: null,
        },
      } as const),
    inspect: () => undefined,
    list: () => [],
    stop: () => ({ ok: true, value: snapshot }),
    closeOwner: () => Promise.resolve(),
    manageWorktree: () => Promise.resolve({ ok: true, value: snapshot }),
    message: () => Promise.resolve({ ok: true, value: snapshot }),
  };
  return new DelegationParent({
    owner: {
      harnessId: 'codex',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'session',
      runtimeGeneration: 1,
      depth: 1,
      parentDelegationId: 'delegation-1',
      parentRunGeneration: 2,
    },
    harness: 'codex',
    namespace: 'canopy',
    names: {
      spawn: 'delegate_task',
      inspect: 'inspect_delegate',
      list: 'list_delegates',
      output: 'get_delegate_output',
      stop: 'stop_delegate',
      manageWorktree: 'manage_delegate_worktree',
      message: 'message_delegate',
      requestSteering: 'request_steering',
    },
    broker,
    currentTurn: () => 'owned-turn',
    removeQueued: () => Promise.resolve(),
    reportError: jest.fn(),
    enableDelegationTools,
    requestSteering: () => Promise.resolve({ ok: true, value: {} }),
  });
}

describe('delegated native Codex route confinement', () => {
  it('requests host approval before native commands even inside the read sandbox', () => {
    const params = buildCodexDelegationThreadParams({
      cwd: '/worktree',
      model: 'gpt-6-sol',
      config: {},
      instructions: 'Review',
      ambientMcp: {},
    });
    expect(params.approvalPolicy).toBe('untrusted');
    expect(params.approvalsReviewer).toBe('user');
    expect(params.selectedCapabilityRoots).toEqual([]);
  });
  it('runs native commands with the login-shell PATH, its toolchains and a private TMPDIR', () => {
    const params = buildCodexDelegationThreadParams({
      cwd: '/worktree',
      model: 'gpt-6-sol',
      config: {},
      instructions: 'Review',
      ambientMcp: {},
      commandDirectories: ['/opt/git/bin'],
      commandPath: '/Users/me/.nvm/versions/node/v24.21.0/bin:/usr/bin',
      toolchainReadRoots: [
        '/Users/me/.nvm/versions/node/v24.21.0/bin',
        '/Users/me/.nvm/versions/node/v24.21.0/lib',
        '/System/Library',
      ],
      temporaryDirectory: '/private/var/folders/run/delegated-runtime-1',
    });
    const set = params.config?.shell_environment_policy;
    expect(set).toMatchObject({
      set: {
        PATH: '/opt/git/bin:/Users/me/.nvm/versions/node/v24.21.0/bin:/usr/bin:/bin:/usr/sbin:/sbin',
        TMPDIR: '/private/var/folders/run/delegated-runtime-1',
      },
    });
    const recordOf = (value: unknown): Record<string, unknown> =>
      value !== null && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value))
        : {};
    const profile = recordOf(
      recordOf(params.config?.permissions)[params.permissions ?? ''],
    );
    expect(profile).toMatchObject({
      filesystem: {
        '/Users/me/.nvm/versions/node/v24.21.0/bin': 'read',
        '/Users/me/.nvm/versions/node/v24.21.0/lib': 'read',
        '/System/Library': 'read',
        '/private/var/folders/run/delegated-runtime-1': 'write',
        '/worktree': 'read',
      },
      network: { enabled: false },
    });
    // No deny globs beneath the toolchains: on macOS the sandbox profile
    // grows with deny patterns times read roots, and past the argument limit
    // the delegate cannot start.
    expect(
      Object.entries(recordOf(profile.filesystem)).filter(
        ([entry, access]) =>
          access === 'deny' && entry.startsWith('/Users/me/.nvm'),
      ),
    ).toEqual([]);
  });
  it('mounts only retained Agent capability roots and scoped MCP config', () => {
    const selectedCapabilityRoots = [
      {
        id: 'retained-skill',
        location: {
          type: 'environment' as const,
          environmentId: 'local',
          path: 'file:///retained/skill-plugin',
        },
      },
    ];
    const params = buildCodexDelegationThreadParams({
      cwd: '/worktree',
      model: 'gpt-6-sol',
      config: {},
      instructions: 'Review',
      ambientMcp: { foreign: { command: 'ambient-tool' } },
      selectedCapabilityRoots,
      selectedMcpServers: {
        selected_review: {
          url: 'http://127.0.0.1:1234/selected',
          enabled: true,
        },
      },
    });
    expect(params.selectedCapabilityRoots).toEqual(selectedCapabilityRoots);
    expect(params.config?.features).toMatchObject({
      plugins: true,
      skill_search: true,
      skip_host_skill_discovery: true,
    });
    expect(params.config?.skills).toEqual({ max_context_tokens: 1 });
    expect(params.config?.mcp_servers).toMatchObject({
      foreign: { enabled: false },
      selected_review: {
        url: 'http://127.0.0.1:1234/selected',
        enabled: true,
      },
    });
  });
  it.each([true, false, undefined])(
    'pins fast mode %s in the native thread',
    (fastMode) => {
      const params = buildCodexDelegationThreadParams({
        cwd: '/worktree',
        model: 'gpt-6-sol',
        config: {},
        instructions: 'Review',
        ambientMcp: {},
        fastMode,
      });
      expect(params.serviceTier).toBe(fastMode ? 'priority' : 'default');
    },
  );
  // POSIX fixture paths; the Windows form is the native-path case below.
  const itPosix = process.platform === 'win32' ? it.skip : it;
  const itWindows = process.platform === 'win32' ? it : it.skip;
  itWindows(
    'grants selected Git metadata reads with native Windows paths',
    () => {
      // The pinned Codex parses mixed separators in absolute keys and matches
      // Windows deny globs case-insensitively after normalizing `\` to `/`.
      const params = buildCodexDelegationThreadParams({
        cwd: 'C:\\worktree',
        model: 'gpt-6-sol',
        instructions: 'Inspect Git',
        ambientMcp: {},
        config: {},
        gitRoots: ['C:\\worktree\\.git'],
        gitPrivateRoots: ['C:\\worktree\\.git\\worktrees'],
        runtimeRoots: ['C:\\Program Files\\Git\\cmd'],
        commandDirectories: ['C:\\Program Files\\Git\\cmd'],
      });
      expect(params.config).toMatchObject({
        shell_environment_policy: {
          inherit: 'core',
          set: { GIT_CONFIG_GLOBAL: 'NUL' },
        },
        permissions: {
          delegated_read_only: {
            filesystem: {
              'C:\\worktree': 'read',
              'C:\\worktree\\.git': 'read',
              'C:\\worktree\\.git\\worktrees': 'deny',
              'C:\\worktree\\.git/modules': 'deny',
              'C:\\worktree\\.git/modules/**': 'deny',
              'C:\\worktree/*/.git': 'deny',
              'C:\\worktree/.env': 'deny',
              'C:\\Program Files\\Git\\cmd': 'read',
            },
            network: { enabled: false },
          },
        },
      });
      // A validated root .git is granted once, never also denied.
      expect(params.config).not.toHaveProperty([
        'permissions',
        'delegated_read_only',
        'filesystem',
        'C:\\worktree/.git',
      ]);
    },
  );
  itPosix(
    'grants selected Git metadata reads without inheriting shell snapshots or secrets',
    () => {
      const params = buildCodexDelegationThreadParams({
        cwd: '/worktree',
        model: 'gpt-6-sol',
        instructions: 'Inspect Git',
        ambientMcp: {},
        config: {
          shell_environment_policy: {
            inherit: 'all',
            set: { GH_TOKEN: 'untrusted' },
          },
        },
        gitRoots: [
          '/worktree/.git',
          '/repository/.git/worktrees/selected',
          '/repository/.git/config',
          '/repository/.git/objects',
          '/repository/.git/refs',
        ],
        gitPrivateRoots: [],
        runtimeRoots: ['/runtime/git'],
        commandDirectories: ['/runtime/git/bin'],
      });
      expect(params.config).toMatchObject({
        features: { shell_snapshot: false },
        shell_environment_policy: {
          inherit: 'core',
          experimental_use_profile: false,
          set: { GIT_CONFIG_GLOBAL: '/dev/null' },
        },
        permissions: {
          delegated_read_only: {
            filesystem: {
              '/worktree/.git': 'read',
              '/repository/.git/config': 'read',
              '/repository/.git/objects': 'read',
              '/repository/.git/refs': 'read',
              '/repository/.git/worktrees/selected': 'read',
              '/worktree/.git/modules': 'deny',
              '/worktree/.git/modules/**': 'deny',
              '/worktree/*/.git': 'deny',
              '/worktree/*/.git/**': 'deny',
              '/runtime/git': 'read',
              '/worktree/.env': 'deny',
            },
            network: { enabled: false },
          },
        },
      });
      expect(params.config).not.toHaveProperty(
        'shell_environment_policy.set.GH_TOKEN',
      );
      const serializedConfig = JSON.stringify(params.config);
      // Linked checkouts grant only the selected admin directory plus safe
      // common metadata roots, so future siblings never inherit access.
      expect(serializedConfig).not.toContain('worktrees/*/config');
      expect(serializedConfig.match(/"\/worktree\/\.git":/g)).toHaveLength(1);
      expect(serializedConfig).toContain('"/worktree/.git":"read"');
      expect(serializedConfig).not.toContain('"/repository/.git":"read"');
    },
  );
  it('denies the complete linked-worktree collection for a primary checkout', () => {
    const params = buildCodexDelegationThreadParams({
      cwd: '/worktree',
      model: 'gpt-6-sol',
      config: {},
      instructions: 'Inspect Git',
      ambientMcp: {},
      gitRoots: ['/worktree/.git'],
      gitPrivateRoots: ['/worktree/.git/worktrees'],
    });
    expect(params.config).toMatchObject({
      permissions: {
        delegated_read_only: {
          filesystem: {
            '/worktree/.git': 'read',
            '/worktree/.git/worktrees': 'deny',
          },
        },
      },
    });
  });
  itPosix(
    'adds write grants only to the write profile, leaving every deny and Git metadata entry unchanged under a whole-worktree grant',
    () => {
      const recordOf = (value: unknown): Record<string, unknown> =>
        value !== null && typeof value === 'object' && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value))
          : {};
      const params = buildCodexDelegationThreadParams({
        cwd: '/worktree',
        model: 'gpt-5.4',
        config: {},
        instructions: 'Edit',
        ambientMcp: {},
        gitRoots: ['/worktree/.git'],
        gitPrivateRoots: ['/worktree/.git/worktrees'],
        temporaryDirectory: '/private/tmp/delegated-runtime-1',
        writePaths: [
          '/worktree',
          '/worktree/src/file.ts',
          // Never valid grants; the builder still refuses to widen them.
          '/worktree/.env',
          '/worktree/.git',
        ],
        permissionProfile: 'delegated_write',
      });
      const profiles = recordOf(params.config?.permissions);
      expect(Object.keys(profiles).sort()).toEqual([
        'delegated_read_only',
        'delegated_write',
      ]);
      expect(params.permissions).toBe('delegated_write');
      const readOnly = recordOf(
        recordOf(profiles.delegated_read_only).filesystem,
      );
      const write = recordOf(recordOf(profiles.delegated_write).filesystem);
      // The read-only profile writes only the private TMPDIR.
      expect(
        Object.entries(readOnly).filter(([, access]) => access === 'write'),
      ).toEqual([['/private/tmp/delegated-runtime-1', 'write']]);
      // Only the two literal grants differ between the profiles.
      expect(
        Object.keys(write)
          .filter((entry) => write[entry] !== readOnly[entry])
          .sort(),
      ).toEqual(['/worktree', '/worktree/src/file.ts']);
      expect(Object.keys(write).length).toBe(Object.keys(readOnly).length + 1);
      expect(write['/worktree']).toBe('write');
      expect(write['/worktree/src/file.ts']).toBe('write');
      for (const name of [
        '.env',
        '.codex',
        '.claude',
        '.ssh',
        '.aws',
        '.npmrc',
        '.netrc',
      ])
        expect(write[`/worktree/${name}`]).toBe('deny');
      expect(write).toMatchObject({
        '/worktree/.git': 'read',
        '/worktree/.git/worktrees': 'deny',
        '/worktree/.git/modules': 'deny',
        '/worktree/.git/modules/**': 'deny',
        '/worktree/*/.git': 'deny',
        '/worktree/*/.git/**': 'deny',
        '/worktree/**/.env*': 'deny',
        '/worktree/**/.ssh/**': 'deny',
        '/worktree/**/*.pem': 'deny',
        '/worktree/**/.canopy': 'deny',
      });
      expect(recordOf(profiles.delegated_write).network).toEqual({
        enabled: false,
      });
      expect(params.approvalPolicy).toBe('untrusted');
    },
  );
  it('starts under the read-only profile, with no write profile, when there are no grants', () => {
    const params = buildCodexDelegationThreadParams({
      cwd: '/worktree',
      model: 'gpt-5.4',
      config: {},
      instructions: 'Read',
      ambientMcp: {},
      permissionProfile: 'delegated_write',
    });
    expect(params.permissions).toBe('delegated_read_only');
    expect(Object.keys(params.config?.permissions ?? {})).toEqual([
      'delegated_read_only',
    ]);
  });
  it('disables provider-native memories with the canonical flattened feature key', () => {
    const params = buildCodexDelegationThreadParams({
      cwd: '/worktree',
      model: 'gpt-5.6-sol',
      config: {},
      instructions: 'Use native harness tools within the task permissions.',
      ambientMcp: {},
    });

    expect(params.config).toMatchObject({ 'features.memories': false });
    expect(params.config).not.toHaveProperty('features.memory_tool');
  });

  it.each([
    {
      agents: { enabled: true },
      'agents.enabled': true,
      features: { multi_agent: true },
      'features.multi_agent': true,
      'features.code_mode_host': true,
      'features.apps': true,
    },
    {
      'agents.enabled': true,
      agents: { enabled: true },
      'features.multi_agent': true,
      'features.code_mode_host': true,
      'features.apps': true,
      features: { multi_agent: true },
    },
  ])('pins native agent recursion off for inherited key order %#', (config) => {
    const params = buildCodexDelegationThreadParams({
      cwd: '/worktree',
      model: 'gpt-6-sol',
      config,
      instructions: 'Read source',
      ambientMcp: {},
    });
    expect(flattenCodexThreadConfig(params.config)).toMatchObject({
      'agents.enabled': false,
      'features.multi_agent': false,
      'features.multi_agent_v2': false,
      'features.code_mode_host': false,
      'features.apps': false,
    });
    expect(params.config?.features).toMatchObject({
      multi_agent: false,
      multi_agent_v2: false,
    });
  });

  it('leaves settings-configured hooks to the user Codex config, as in a parent chat', () => {
    const params = buildCodexDelegationThreadParams({
      cwd: '/worktree',
      model: 'gpt-5.6-sol',
      config: {},
      instructions: 'Use native harness tools within the task permissions.',
      ambientMcp: {},
    });
    expect(params.config).not.toHaveProperty(['features', 'hooks']);
    // Native recursion and app surfaces stay off for children.
    expect(params.config).toMatchObject({
      features: { multi_agent: false, apps: false, plugins: false },
    });
  });

  it('keeps the default local execution environment and native tools while disabling inherited MCP and recursion', () => {
    const params = buildCodexDelegationThreadParams({
      cwd: '/worktree',
      model: 'gpt-6-sol',
      config: {},
      instructions: 'Read source',
      ambientMcp: { foreign: { command: 'external-tool' } },
    });
    expect(params).not.toHaveProperty('environments');
    expect(params.dynamicTools).toEqual([]);
    expect(params.config).toMatchObject({
      features: {
        shell_tool: true,
        unified_exec: true,
        request_permissions_tool: true,
        multi_agent: false,
        multi_agent_v2: false,
      },
      mcp_servers: { foreign: { enabled: false } },
      permissions: {
        delegated_read_only: {
          filesystem: { '/worktree': 'read', '/worktree/.env': 'deny' },
          network: { enabled: false },
        },
      },
    });
  });

  it.each([
    [{}, 'openai'],
    [{ model_provider: 'canopy_ai_credits' }, 'canopy_ai_credits'],
  ])(
    'pins the captured model provider over ambient project config',
    (config, expected) => {
      const params = buildCodexDelegationThreadParams({
        cwd: '/worktree',
        model: 'gpt-5.6-sol',
        config,
        instructions: 'Use native harness tools within the task permissions.',
        ambientMcp: {},
      });

      expect(params.modelProvider).toBe(expected);
    },
  );
});

describe('native command rules are honored on delegated start and resume', () => {
  it('rebinds retained Agent capabilities on a Codex follow-up', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'delegation-capabilities-'),
    );
    try {
      const handle = {
        threadId: 'rebound-thread',
        runTurn: jest.fn(
          (request: Parameters<CodexThreadHandle['runTurn']>[0]) => {
            void request;
            return Promise.resolve({
              status: 'completed',
              finalText: 'done',
              usage: { inputTokens: 1, outputTokens: 1 },
            });
          },
        ),
        unsubscribe: jest.fn(),
        interrupt: jest.fn(() => Promise.resolve()),
      };
      const selectedCapabilityRoots = [
        {
          id: 'retained-plugin',
          location: {
            type: 'environment' as const,
            environmentId: 'local',
            path: 'file:///retained/plugin',
          },
        },
      ];
      const resumeThread = jest.fn(() => Promise.resolve(handle));
      const materializeThread = jest.fn(
        (_request: Parameters<CodexRuntimeService['materializeThread']>[0]) => {
          void _request;
          return Promise.resolve(handle);
        },
      );
      const runner = createCodexDelegationRunner({
        available: () => Promise.resolve({ available: true }),
        prepare: () =>
          Promise.resolve({
            model: 'test',
            profile: {
              environmentPolicy: 'restricted',
              includeCanopySecrets: false,
            },
            selectedCapabilityRoots,
            selectedMcpServers: {
              selected_review: {
                url: 'http://127.0.0.1:1234/selected',
                enabled: true,
              },
            },
            tools: runnerTools({
              cwd: root,
              instructions: (): string => 'Retained Agent instructions',
              readRoots: [],
              gitAccess: {
                metadataRoots: [],
                privateMetadataRoots: [],
                runtimeRoots: [],
                commandDirectories: [],
              },
              flushWrites: (): Promise<void> => Promise.resolve(),
              writePaths: [],
              writable: (): boolean => true,
              prepareCodexSandboxWrites: (): Promise<string[]> =>
                Promise.resolve([]),
              setCodexTurnWrites: (): void => undefined,
            }),
          }),
        loadResumeItems: () =>
          Promise.resolve([{ type: 'message', role: 'user', content: [] }]),
        runtime: codexRuntimeFixture({
          resumeThread,
          materializeThread,
          admin: (): object => ({
            request: (): Promise<object> =>
              Promise.resolve({ config: {}, layers: [] }),
          }),
        }),
        reportError: jest.fn(),
      });
      const request: AgentRunRequest = {
        delegationId: 'delegation-1',
        runGeneration: 2,
        launchKey: 'launch-2',
        parent: {
          harnessId: 'codex',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
          sessionKey: 'session',
          turnId: 'turn',
          toolCallId: 'call',
          runtimeGeneration: 1,
          depth: 0,
        },
        task: {
          modelId: 'codex-test',
          description: 'Inspect code',
          prompt: 'Inspect the requested code.',
          executionMode: 'foreground',
          contextPolicy: 'task_only',
          isolation: 'shared_worktree',
        },
        route: {
          selectedModelId: 'codex-test',
          runtimeModelId: 'codex-test',
          harnessId: 'codex',
          runtimeKind: 'codex-app-server',
          runnerRegistrationId: 'codex-local',
          runtimeVersion: '1',
          adapterVersion: '1',
          modelSource: 'test',
          providerType: 'subscription',
          assignmentRevision: 'assignment-1',
          billingAuthority: 'subscription',
          aiCreditsRouted: false,
          capabilities: ['read'],
          supportedThinkingLevels: [],
          capabilitySnapshotHash: 'hash',
          capabilityGeneration: 1,
          policyRevision: 'read-only-1',
        },
        cwd: root,
        effectivePermission: 'read-only',
        resumeSessionId: 'retained-thread',
        signal: new AbortController().signal,
      };
      const terminal = await new Promise<unknown>((resolve) => {
        void runner.start(request, (event) => {
          if (event.event.type === 'terminal') resolve(event.event);
          return Promise.resolve();
        });
      });
      expect(terminal).toMatchObject({ status: 'completed' });
      expect(resumeThread).not.toHaveBeenCalled();
      const materializedRequest: unknown = materializeThread.mock.calls[0]?.[0];
      expect(materializedRequest).toMatchObject({
        params: {
          selectedCapabilityRoots,
          config: {
            mcp_servers: {
              selected_review: {
                url: 'http://127.0.0.1:1234/selected',
                enabled: true,
              },
            },
          },
        },
      });
      const turn = handle.runTurn.mock.calls[0]?.[0];
      expect(turn?.mcpElicitationPolicy?.allowExternalMutation).toBe(true);
      expect(
        turn?.mcpElicitationPolicy?.evaluate({
          serverName: 'selected_review',
          toolName: 'review_evidence',
          arguments: {},
          normalizedArguments: '{}',
          approvalKind: 'mcp_tool_call',
        }),
      ).toMatchObject({ approved: true });
      expect(
        turn?.mcpElicitationPolicy?.evaluate({
          serverName: 'ambient',
          toolName: 'read',
          arguments: {},
          normalizedArguments: '{}',
          approvalKind: 'mcp_tool_call',
        }),
      ).toMatchObject({ approved: false });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it.each([false, true])(
    'runs with native rules (resume=%s)',
    async (resume) => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'delegation-rules-'));
      try {
        await mkdir(path.join(root, 'rules'));
        await writeFile(
          path.join(root, 'rules/saved.rules'),
          'prefix_rule(pattern=["cat"], decision="allow")',
        );
        const runTurn = jest.fn(() =>
          Promise.resolve({
            status: 'completed',
            finalText: 'done',
            usage: { inputTokens: 1, outputTokens: 1 },
          }),
        );
        const handle = {
          threadId: 'retained-thread',
          runTurn,
          unsubscribe: jest.fn(),
          interrupt: jest.fn(() => Promise.resolve()),
        };
        const startThread = jest.fn(() => Promise.resolve(handle));
        const resumeThread = jest.fn(() => Promise.resolve(handle));
        const runner = createCodexDelegationRunner({
          available: () => Promise.resolve({ available: true }),
          prepare: () =>
            Promise.resolve({
              model: 'test',
              profile: {
                environmentPolicy: 'restricted',
                includeCanopySecrets: false,
              },
              tools: runnerTools({
                cwd: root,
                instructions: (): string => 'Test',
                readRoots: [],
                gitAccess: {
                  metadataRoots: [],
                  privateMetadataRoots: [],
                  runtimeRoots: [],
                  commandDirectories: [],
                },
                flushWrites: (): Promise<void> => Promise.resolve(),
                writePaths: [],
                writable: (): boolean => true,
                prepareCodexSandboxWrites: (): Promise<string[]> =>
                  Promise.resolve([]),
                setCodexTurnWrites: (): void => undefined,
              }),
            }),
          runtime: codexRuntimeFixture({
            startThread,
            resumeThread,
            admin: (): object => ({
              request: (): Promise<object> =>
                Promise.resolve({
                  config: {},
                  layers: [
                    {
                      name: {
                        type: 'user',
                        file: path.join(root, 'config.toml'),
                      },
                    },
                  ],
                }),
            }),
          }),
          reportError: jest.fn(),
        });
        const request = {
          ...(resume ? { resumeSessionId: 'retained-thread' } : {}),
          delegationId: 'delegation-1',
          runGeneration: 1,
          launchKey: 'launch-1',
          parent: {
            harnessId: 'codex',
            projectId: 'project',
            worktreeId: 'worktree',
            chatId: 'chat',
            sessionKey: 'session',
            turnId: 'turn',
            toolCallId: 'call',
            runtimeGeneration: 1,
            depth: 0,
          },
          task: {
            modelId: 'codex-test',
            description: 'Inspect code',
            prompt: 'Inspect the requested code.',
            executionMode: 'foreground',
            contextPolicy: 'task_only',
            isolation: 'shared_worktree',
          },
          route: {
            selectedModelId: 'codex-test',
            runtimeModelId: 'codex-test',
            harnessId: 'codex',
            runtimeKind: 'codex-app-server',
            runnerRegistrationId: 'codex-local',
            runtimeVersion: '1',
            adapterVersion: '1',
            modelSource: 'test',
            providerType: 'subscription',
            assignmentRevision: 'assignment-1',
            billingAuthority: 'subscription',
            aiCreditsRouted: false,
            capabilities: ['read'],
            supportedThinkingLevels: [],
            capabilitySnapshotHash: 'hash',
            capabilityGeneration: 1,
            policyRevision: 'read-only-1',
          },
          cwd: root,
          effectivePermission: 'read-only',
          signal: new AbortController().signal,
        } satisfies AgentRunRequest;
        const terminal = await new Promise<unknown>((resolve) => {
          void runner.start(request, (event) => {
            if (event.event.type === 'terminal') resolve(event.event);
            return Promise.resolve();
          });
        });
        expect(terminal).toMatchObject({ status: 'completed' });
        expect(resume ? resumeThread : startThread).toHaveBeenCalledTimes(1);
        expect(runTurn).toHaveBeenCalledTimes(1);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ['gains', true],
    ['loses', false],
  ])(
    'materializes retained history when a resumed child %s nested tools',
    async (_transition, eligible) => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'delegation-tools-'));
      try {
        const runTurn = jest.fn(() =>
          Promise.resolve({
            status: 'completed',
            finalText: 'done',
            usage: { inputTokens: 1, outputTokens: 1 },
          }),
        );
        const handle = (
          threadId: string,
        ): {
          threadId: string;
          runTurn: typeof runTurn;
          unsubscribe: jest.Mock;
          interrupt: jest.Mock<Promise<void>, []>;
        } => ({
          threadId,
          runTurn,
          unsubscribe: jest.fn(),
          interrupt: jest.fn(() => Promise.resolve()),
        });
        const replacement = handle('replacement-thread-1');
        const startThread = jest.fn(() => Promise.resolve(replacement));
        const resumeThread = jest.fn(() => Promise.resolve(replacement));
        let materialization = 0;
        const materializeThread = jest.fn(
          (
            _request: Parameters<CodexRuntimeService['materializeThread']>[0],
          ) => {
            void _request;
            materialization += 1;
            return Promise.resolve(
              handle(`replacement-thread-${materialization}`),
            );
          },
        );
        const delegation = delegationParent(eligible);
        const runner = createCodexDelegationRunner({
          available: () => Promise.resolve({ available: true }),
          prepare: () =>
            Promise.resolve({
              model: 'test',
              profile: {
                environmentPolicy: 'restricted',
                includeCanopySecrets: false,
              },
              tools: runnerTools({
                cwd: root,
                instructions: (): string => 'Test',
                readRoots: [],
                gitAccess: {
                  metadataRoots: [],
                  runtimeRoots: [],
                  commandDirectories: [],
                },
                flushWrites: (): Promise<void> => Promise.resolve(),
                writePaths: [],
                writable: (): boolean => true,
                prepareCodexSandboxWrites: (): Promise<string[]> =>
                  Promise.resolve([]),
                setCodexTurnWrites: (): void => undefined,
              }),
            }),
          delegation: () => delegation,
          loadResumeItems: () =>
            Promise.resolve([{ type: 'message', role: 'user', content: [] }]),
          runtime: codexRuntimeFixture({
            startThread,
            resumeThread,
            materializeThread,
            admin: (): object => ({
              request: (): Promise<object> =>
                Promise.resolve({ config: {}, layers: [] }),
            }),
          }),
          reportError: jest.fn(),
        });
        const request = {
          resumeSessionId: 'retained-thread',
          delegationId: 'delegation-1',
          runGeneration: 2,
          launchKey: 'launch-2',
          parent: {
            harnessId: 'codex',
            projectId: 'project',
            worktreeId: 'worktree',
            chatId: 'chat',
            sessionKey: 'session',
            turnId: 'turn',
            toolCallId: 'call',
            runtimeGeneration: 1,
            depth: 0,
          },
          task: {
            modelId: 'codex-test',
            description: 'Inspect code',
            prompt: 'Inspect the requested code.',
            executionMode: 'foreground',
            contextPolicy: 'task_only',
            isolation: 'shared_worktree',
            allowNestedDelegation: true,
          },
          route: {
            selectedModelId: 'codex-test',
            runtimeModelId: 'codex-test',
            harnessId: 'codex',
            runtimeKind: 'codex-app-server',
            runnerRegistrationId: 'codex-local',
            runtimeVersion: '1',
            adapterVersion: '1',
            modelSource: 'test',
            providerType: 'subscription',
            assignmentRevision: 'assignment-1',
            billingAuthority: 'subscription',
            aiCreditsRouted: false,
            capabilities: ['read'],
            supportedThinkingLevels: [],
            capabilitySnapshotHash: 'hash',
            capabilityGeneration: 1,
            policyRevision: 'read-only-1',
          },
          cwd: root,
          effectivePermission: 'read-only',
          signal: new AbortController().signal,
        } satisfies AgentRunRequest;

        const startedIds: string[] = [];
        const terminal = await new Promise<unknown>((resolve) => {
          void runner.start(request, (event) => {
            if (event.event.type === 'started') {
              const nativeSessionId = event.event.nativeSessionId;
              if (nativeSessionId === undefined)
                throw new Error('Started event omitted nativeSessionId');
              startedIds.push(nativeSessionId);
            }
            if (event.event.type === 'terminal') resolve(event.event);
            return Promise.resolve();
          });
        });

        expect(terminal).toMatchObject({ status: 'completed' });
        expect(resumeThread).not.toHaveBeenCalled();
        const [materializeRequest] = materializeThread.mock.calls[0];
        expect(materializeRequest.items).toEqual([
          { type: 'message', role: 'user', content: [] },
        ]);
        const dynamicToolNames = materializeRequest.params.dynamicTools?.map(
          ({ name }) => name,
        );
        if (eligible) expect(dynamicToolNames).toContain('delegate_task');
        else expect(dynamicToolNames).not.toContain('delegate_task');
        expect(dynamicToolNames).toContain('request_steering');
        expect(materializeThread).toHaveBeenCalledTimes(1);
        expect(runTurn).toHaveBeenCalledTimes(1);
        expect(startedIds).toEqual(['replacement-thread-1']);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

describe('Agent Ledger tools for a delegated Codex run', () => {
  async function runToTerminal(
    ledger: () => Promise<ChildLedgerTools | undefined>,
  ): Promise<{
    started: Parameters<CodexRuntimeService['startThread']>[0] | undefined;
    turn: Parameters<CodexThreadHandle['runTurn']>[0] | undefined;
  }> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'delegation-ledger-'));
    try {
      const runTurn = jest.fn(
        (turnRequest: Parameters<CodexThreadHandle['runTurn']>[0]) => {
          void turnRequest;
          return Promise.resolve({
            status: 'completed',
            finalText: 'done',
            usage: { inputTokens: 1, outputTokens: 1 },
          });
        },
      );
      const handle = {
        threadId: 'child-thread',
        runTurn,
        unsubscribe: jest.fn(),
        interrupt: jest.fn(() => Promise.resolve()),
      };
      const startThread = jest.fn(
        (startRequest: Parameters<CodexRuntimeService['startThread']>[0]) => {
          void startRequest;
          return Promise.resolve(handle);
        },
      );
      const runner = createCodexDelegationRunner({
        available: () => Promise.resolve({ available: true }),
        prepare: () =>
          Promise.resolve({
            model: 'test',
            profile: {
              environmentPolicy: 'restricted',
              includeCanopySecrets: false,
            },
            tools: runnerTools({
              cwd: root,
              instructions: (): string => 'Delegated instructions',
              readRoots: [],
              gitAccess: {
                metadataRoots: [],
                privateMetadataRoots: [],
                runtimeRoots: [],
                commandDirectories: [],
              },
              flushWrites: (): Promise<void> => Promise.resolve(),
              writePaths: [],
              writable: (): boolean => true,
              prepareCodexSandboxWrites: (): Promise<string[]> =>
                Promise.resolve([]),
              setCodexTurnWrites: (): void => undefined,
            }),
          }),
        runtime: codexRuntimeFixture({
          startThread,
          admin: (): object => ({
            request: (): Promise<object> =>
              Promise.resolve({ config: {}, layers: [] }),
          }),
        }),
        delegation: () => delegationParent(false),
        ledger,
        reportError: jest.fn(),
      });
      const request: AgentRunRequest = {
        delegationId: 'delegation-1',
        runGeneration: 1,
        launchKey: 'launch-1',
        parent: {
          harnessId: 'codex',
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
          sessionKey: 'session',
          turnId: 'turn',
          toolCallId: 'call',
          runtimeGeneration: 1,
          depth: 0,
        },
        task: {
          modelId: 'codex-test',
          description: 'Inspect code',
          prompt: 'Inspect the requested code.',
          executionMode: 'background',
          contextPolicy: 'task_only',
          isolation: 'shared_worktree',
        },
        route: {
          selectedModelId: 'codex-test',
          runtimeModelId: 'codex-test',
          harnessId: 'codex',
          runtimeKind: 'codex-app-server',
          runnerRegistrationId: 'codex-local',
          runtimeVersion: '1',
          adapterVersion: '1',
          modelSource: 'test',
          providerType: 'subscription',
          assignmentRevision: 'assignment-1',
          billingAuthority: 'subscription',
          aiCreditsRouted: false,
          capabilities: ['read', 'resume'],
          supportedThinkingLevels: [],
          capabilitySnapshotHash: 'hash',
          capabilityGeneration: 1,
          policyRevision: 'read-only-1',
        },
        cwd: root,
        effectivePermission: 'read-only',
        signal: new AbortController().signal,
      };
      await new Promise<void>((resolve) => {
        void runner.start(request, (event) => {
          if (event.event.type === 'terminal') resolve();
          return Promise.resolve();
        });
      });
      return {
        started: startThread.mock.calls[0]?.[0],
        turn: runTurn.mock.calls[0]?.[0],
      };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  it('adds the Ledger tools and block to the thread and serves calls from the delegate runtime', async () => {
    const ledger = {
      execute: jest.fn(() => Promise.resolve({ text: '{"ok":true}' })),
      systemPrompt: (): string => 'Delegate Ledger block',
      dispose: jest.fn(),
    };

    const { started, turn } = await runToTerminal(() =>
      Promise.resolve(ledger),
    );

    expect(started?.params.baseInstructions).toContain(
      '\nDelegate Ledger block',
    );
    expect(started?.params.dynamicTools?.map((spec) => spec.name)).toEqual([
      'request_steering',
      CANOPY_INJECTED_TOOL_REGISTRY.add_ledger_entry.codexToolName,
      CANOPY_INJECTED_TOOL_REGISTRY.search_ledger_entries.codexToolName,
      CANOPY_INJECTED_TOOL_REGISTRY.update_ledger_entry.codexToolName,
    ]);
    const policy = turn?.hostToolPolicy;
    if (!policy) throw new Error('Expected the host tool policy');
    const signal = new AbortController().signal;
    await expect(
      policy.execute(
        {
          threadId: 'child-thread',
          turnId: 'native-turn',
          callId: 'native-call',
          namespace: null,
          tool: CANOPY_INJECTED_TOOL_REGISTRY.search_ledger_entries
            .codexToolName,
          arguments: { owner: 'self' },
        },
        signal,
      ),
    ).resolves.toEqual({
      success: true,
      contentItems: [{ type: 'inputText', text: '{"ok":true}' }],
    });
    expect(ledger.execute).toHaveBeenCalledWith(
      'search_ledger_entries',
      { owner: 'self' },
      { invocationId: 'codex:child-thread:native-turn:native-call', signal },
    );
    // The run ended, so its caller binding was revoked.
    expect(ledger.dispose).toHaveBeenCalledTimes(1);
  });

  it('keeps the thread as it was when the Ledger is not exposed to its run', async () => {
    const { started, turn } = await runToTerminal(() =>
      Promise.resolve(undefined),
    );

    expect(started?.params.baseInstructions).not.toContain('Ledger');
    expect(started?.params.baseInstructions).not.toContain('Feed');
    expect(started?.params.dynamicTools?.map((spec) => spec.name)).toEqual([
      'request_steering',
    ]);
    expect(turn?.hostToolPolicy?.allowedTools).toEqual([
      { namespace: null, tool: 'request_steering' },
    ]);
  });
});

describe('delegated native Codex progress', () => {
  it('caches assembled text until an accepted item update invalidates it', () => {
    const progress = new CodexDelegationProgress();
    progress.receive({
      method: 'item/agentMessage/delta',
      params: { itemId: 'first', delta: 'one' },
    });
    const from = jest.spyOn(Array, 'from');
    try {
      expect(progress.text).toBe('one');
      expect(progress.text).toBe('one');
      expect(from).toHaveBeenCalledTimes(1);

      progress.receive({
        method: 'item/agentMessage/delta',
        params: { itemId: 'first', delta: ' two' },
      });
      from.mockClear();
      expect(progress.text).toBe('one two');
      expect(progress.text).toBe('one two');
      expect(from).toHaveBeenCalledTimes(1);
    } finally {
      from.mockRestore();
    }
  });

  it('replaces streamed text with completed text and ignores duplicate completion and late deltas', () => {
    const progress = new CodexDelegationProgress();
    progress.receive({
      method: 'item/agentMessage/delta',
      params: { itemId: 'first', delta: 'Partial' },
    });
    expect(progress.text).toBe('Partial');
    const complete = {
      method: 'item/completed',
      params: {
        item: {
          type: 'agentMessage',
          id: 'first',
          text: 'Full finding',
          phase: 'commentary',
        },
      },
    };
    progress.receive(complete);
    progress.receive(complete);
    progress.receive({
      method: 'item/agentMessage/delta',
      params: { itemId: 'first', delta: 'late' },
    });
    progress.receive({
      method: 'item/completed',
      params: {
        item: {
          type: 'agentMessage',
          id: 'second',
          text: 'Second finding',
          phase: 'final_answer',
        },
      },
    });
    expect(progress.text).toBe('Full finding\nSecond finding');
  });

  it('retains cumulative usage without double counting repeated native snapshots', () => {
    const progress = new CodexDelegationProgress();
    const event = {
      method: 'thread/tokenUsage/updated',
      params: {
        tokenUsage: {
          total: { inputTokens: 40, outputTokens: 12, cachedInputTokens: 8 },
          last: { inputTokens: 10, outputTokens: 4 },
        },
      },
    };
    progress.receive(event);
    progress.receive(event);
    expect(progress.usage).toEqual({
      inputTokens: 40,
      outputTokens: 12,
      cachedInputTokens: 8,
    });
  });

  it('retains oversized output and ignores tools and reasoning text', () => {
    const progress = new CodexDelegationProgress();
    progress.receive({
      method: 'item/reasoning/textDelta',
      params: { itemId: 'reasoning', delta: 'private reasoning' },
    });
    progress.receive({
      method: 'item/completed',
      params: {
        item: { type: 'commandExecution', id: 'tool', text: 'tool text' },
      },
    });
    expect(progress.text).toBe('');
    progress.receive({
      method: 'item/agentMessage/delta',
      params: { itemId: 'first', delta: 'x'.repeat(100_000) },
    });
    expect(progress.text).toHaveLength(100_000);
    expect(progress.truncated).toBe(false);
  });

  it('retains the complete message inventory', () => {
    const progress = new CodexDelegationProgress();
    for (let index = 0; index < 1000; index++)
      progress.receive({
        method: 'item/completed',
        params: {
          item: {
            type: 'agentMessage',
            id: String(index),
            text: 'Finding',
            phase: 'commentary',
          },
        },
      });
    expect(progress.text.split('\n')).toHaveLength(1000);
    expect(progress.truncated).toBe(false);
  });
});
