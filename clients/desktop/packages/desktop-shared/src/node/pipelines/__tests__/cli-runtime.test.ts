import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface CliCodexThreadRequestForTest {
  params: { config?: unknown; developerInstructions?: string };
}
const mockCliRunCodexTurn = jest.fn<Promise<unknown>, [unknown]>();
const mockCliUnsubscribeCodexThread = jest.fn(() => Promise.resolve());
const mockCliStartCodexThread = jest.fn(
  (request: CliCodexThreadRequestForTest) => {
    void request;
    return Promise.resolve({
      threadId: 'cli-thread',
      runTurn: mockCliRunCodexTurn,
      unsubscribe: mockCliUnsubscribeCodexThread,
    });
  },
);
const mockCliResumeCodexThread = jest.fn(
  (request: CliCodexThreadRequestForTest) => {
    void request;
    return Promise.resolve({
      threadId: 'cli-thread',
      runTurn: mockCliRunCodexTurn,
      unsubscribe: mockCliUnsubscribeCodexThread,
    });
  },
);
const mockCliRevokeStdioMcpRoutes = jest.fn(() => Promise.resolve());

jest.mock('../../codex-runtime', () => {
  const actual = jest.requireActual<Record<string, unknown>>(
    '../../codex-runtime',
  );
  return {
    ...actual,
    createCodexRuntimeService: (): unknown => ({
      startThread: mockCliStartCodexThread,
      resumeThread: mockCliResumeCodexThread,
      revokeStdioMcpRoutes: mockCliRevokeStdioMcpRoutes,
    }),
  };
});

// Cursor execution dynamically loads `runCursorPromptWithDriver`, which
// reaches the ESM-only `@agentclientprotocol/sdk` through the turn driver.
// Stub that lazy boundary for the installed-runtime cases below.
const mockRunCursorPromptWithDriver = jest.fn<
  Promise<unknown>,
  [unknown, unknown]
>();

jest.mock('../cursor-prompt-runner', () => ({
  runCursorPromptWithDriver: mockRunCursorPromptWithDriver,
}));

import {
  initClaudeModels,
  initCursorModels,
} from '@canopy/desktop-shared/types';
import { CURSOR_RUNTIME_VERSION } from '../../cursor/runtime-metadata';
import {
  CLI_CODEX_TURN_START_TIMEOUT_MS,
  CLI_ORG_MODEL_POLICY_NOT_ENFORCEABLE_REASON,
  cliHttpMcpAuthorityId,
  createCliCodexCapabilitySnapshotId,
  createCliExecutionRuntime,
  cursorEnabledInPreferencesFile,
  createCliStdioMcpServerConfig,
  getCliCodexTurnTimeoutOptions,
} from '../cli-runtime';
import { runStep } from '../executor/step-runner';
import type { NormalizedStep } from '../executor/types';
import { createCodexCapabilitySnapshotId } from '../../codex-runtime';
import { getPipelineExecutionPluginRuntimeDir } from '../../lib/paths';
import { buildCodexPipelineThreadConfig } from '../codex-preferences';
import { CODEX_PROJECT_DOC_THREAD_CONFIG } from '../../codex-runtime/thread-config';
import { brandEnvName } from '../../../brand/env';
import { toOllamaModelId } from '../../../types';

describe('cliHttpMcpAuthorityId', () => {
  it('changes when the upstream URL or credentials change', () => {
    const original = cliHttpMcpAuthorityId('https://mcp.example.test/api', {
      Authorization: 'Bearer one',
    });

    expect(
      cliHttpMcpAuthorityId('https://other.example.test/api', {
        Authorization: 'Bearer one',
      }),
    ).not.toBe(original);
    expect(
      cliHttpMcpAuthorityId('https://mcp.example.test/api', {
        Authorization: 'Bearer two',
      }),
    ).not.toBe(original);
  });

  it('normalizes header names and ordering', () => {
    expect(
      cliHttpMcpAuthorityId('https://mcp.example.test/api', {
        Authorization: 'Bearer one',
        'X-Scope': 'repo',
      }),
    ).toBe(
      cliHttpMcpAuthorityId('https://mcp.example.test/api', {
        'x-scope': 'repo',
        authorization: 'Bearer one',
      }),
    );
  });
});

describe('CLI host steps', () => {
  it('supplies no pipeline host actions port', () => {
    expect(
      createCliExecutionRuntime({ cwd: process.cwd() }).pipelineHostActions,
    ).toBeUndefined();
  });

  it('fails the bundled move-to-group step with needs_desktop', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-host-step-'));
    try {
      const runtime = createCliExecutionRuntime({
        cwd: tempDir,
        executionsDir: path.join(tempDir, 'executions'),
        bundledActionsDir: path.resolve(
          __dirname,
          '../../../../resources/actions',
        ),
      });
      const result = await runStep({
        executionId: 'exec-cli',
        jobId: 'build',
        step: {
          id: 'move',
          shell: 'bash',
          continue_on_error: false,
          timeout_minutes: 1,
          skip_on_missing_action: false,
          uses: 'builtin/move-to-group',
          with: { project_id: 'ws-1', task_id: 'wt-1', group: 'Reviews' },
        },
        cwd: tempDir,
        env: {},
        runtime,
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('failure');
      expect(result.error).toBe('This step needs the desktop app.');
      expect(result.outputs.failure_reason).toBe('needs_desktop');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('Cursor prompt runner module boundary', () => {
  it('uses a dynamic import so the ESM-only ACP SDK stays out of eager CLI consumers', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../cli-runtime.ts'),
      'utf8',
    );

    expect(source).not.toMatch(
      /^import\s+.*from\s+'\.\/cursor-prompt-runner';/m,
    );
    expect(source).toMatch(/await import\(\s*'\.\/cursor-prompt-runner'\s*\)/);
  });
});

describe('CLI Codex turn startup', () => {
  it('bounds an unanswered turn/start with the desktop pipeline timeout', () => {
    expect(getCliCodexTurnTimeoutOptions()).toEqual({
      startupTimeoutMs: CLI_CODEX_TURN_START_TIMEOUT_MS,
    });
    expect(CLI_CODEX_TURN_START_TIMEOUT_MS).toBe(10 * 60_000);
  });
});

describe('CLI Ollama harness compatibility', () => {
  it('rejects an outdated Ollama server before launching the Claude harness', async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ version: '0.13.0' }), { status: 200 }),
      ),
    );
    const runtime = createCliExecutionRuntime({ cwd: process.cwd() });

    try {
      await expect(
        runtime.resolveModelHarnessInvocation(toOllamaModelId('qwen3'), {
          harness: 'claude',
        }),
      ).rejects.toThrow('Upgrade Ollama to 0.14.0 or newer');
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe('CLI Cursor harness compatibility', () => {
  it('resolves a Cursor-managed model to the cursor harness', async () => {
    initCursorModels([
      {
        id: 'cursor-default',
        rawModelId: 'default[]',
        label: 'Cursor default',
      },
    ]);
    const runtime = createCliExecutionRuntime({ cwd: process.cwd() });

    await expect(
      runtime.resolveModelHarnessInvocation?.('cursor-default', {
        harness: 'cursor',
      }),
    ).resolves.toEqual({
      source: 'cursor-managed',
      harness: 'cursor',
      runtimeModel: 'cursor-default',
      aiCreditsRouted: false,
    });
  });
});

describe('Codex pipeline feature preferences', () => {
  it('projects a desktop limit and clears caller overrides for Codex default', () => {
    const key = brandEnvName('PREF_CODEX_MAX_CONCURRENT_SUBAGENTS');
    expect(buildCodexPipelineThreadConfig({ [key]: '2' })).toEqual({
      ...CODEX_PROJECT_DOC_THREAD_CONFIG,
      agents: { max_concurrent_threads_per_session: 2 },
    });
    expect(
      buildCodexPipelineThreadConfig(
        { [key]: 'default' },
        { agents: { max_threads: 4 } },
      ),
    ).toEqual(CODEX_PROJECT_DOC_THREAD_CONFIG);
  });

  const preferenceEnvName = brandEnvName(
    'PREF_CODEX_MULTI_AGENT_PIPELINES_ENABLED',
  );

  it('projects explicit enabled and disabled values into thread config', () => {
    expect(
      buildCodexPipelineThreadConfig({ [preferenceEnvName]: 'true' }),
    ).toEqual({
      ...CODEX_PROJECT_DOC_THREAD_CONFIG,
      features: { multi_agent: true, multi_agent_v2: true },
      agents: { enabled: true },
    });
    expect(
      buildCodexPipelineThreadConfig({ [preferenceEnvName]: 'false' }),
    ).toEqual({
      ...CODEX_PROJECT_DOC_THREAD_CONFIG,
      features: { multi_agent: false, multi_agent_v2: false },
      agents: { enabled: false },
    });
  });

  it('preserves other config and leaves canonical Codex behavior alone when absent', () => {
    expect(
      buildCodexPipelineThreadConfig(
        { [preferenceEnvName]: 'true' },
        {
          features: { code_mode: true },
          model_provider: 'gateway',
        },
      ),
    ).toEqual({
      ...CODEX_PROJECT_DOC_THREAD_CONFIG,
      features: {
        code_mode: true,
        multi_agent: true,
        multi_agent_v2: true,
      },
      model_provider: 'gateway',
      agents: { enabled: true },
    });
    expect(buildCodexPipelineThreadConfig({})).toEqual(
      CODEX_PROJECT_DOC_THREAD_CONFIG,
    );
  });

  it('always supplies repository instruction delivery, overriding caller config', () => {
    expect(
      buildCodexPipelineThreadConfig(
        {},
        { project_doc_max_bytes: 1, project_doc_fallback_filenames: [] },
      ),
    ).toEqual({
      project_doc_max_bytes: 131_072,
      project_doc_fallback_filenames: ['CLAUDE.md'],
    });
  });
});

describe('CLI Codex launcher thread config', () => {
  // Each case reads the first recorded thread request.
  beforeEach(() => {
    mockCliStartCodexThread.mockClear();
    mockCliResumeCodexThread.mockClear();
  });

  it('does not inject current global instructions when resuming a thread', async () => {
    mockCliRunCodexTurn.mockResolvedValue({
      status: 'completed',
      threadId: 'cli-thread',
      finalText: 'done',
      usage: {},
    });
    const runtime = createCliExecutionRuntime({ cwd: process.cwd() });
    const globalInstructionsEnvName = brandEnvName(
      'PREF_GLOBAL_INSTRUCTIONS_PIPELINES',
    );

    await runtime.codexPromptRunner?.runCodexPrompt({
      cwd: '/workspace/repo',
      prompt: 'continue',
      resumeSessionId: 'existing-thread',
      environment: {
        [globalInstructionsEnvName]: JSON.stringify({
          overall: 'Do not inject this.',
          scoped: [],
        }),
      },
      model: 'gpt-6-sol',
      fastMode: false,
      totalTimeoutMs: 60_000,
      permissionPreset: 'read_only',
      executionId: 'execution-1',
      jobId: 'job-1',
      stepId: 'step-1',
      attempt: 1,
      stepLabel: 'Codex',
    });

    const resumeRequest = mockCliResumeCodexThread.mock.calls[0]?.[0];
    expect(resumeRequest?.params).not.toHaveProperty('developerInstructions');
  });

  it('supplies the project doc config on thread start and resume', async () => {
    mockCliRunCodexTurn.mockResolvedValue({
      status: 'completed',
      threadId: 'cli-thread',
      finalText: 'done',
      usage: {},
    });
    const runtime = createCliExecutionRuntime({ cwd: process.cwd() });
    const baseRequest = {
      cwd: '/workspace/repo',
      prompt: 'do the work',
      environment: {},
      model: 'gpt-6-sol',
      fastMode: false,
      totalTimeoutMs: 60_000,
      permissionPreset: 'read_only' as const,
      executionId: 'execution-1',
      jobId: 'job-1',
      stepId: 'step-1',
      attempt: 1,
      stepLabel: 'Codex',
    };

    await runtime.codexPromptRunner?.runCodexPrompt(baseRequest);
    await runtime.codexPromptRunner?.runCodexPrompt({
      ...baseRequest,
      resumeSessionId: 'existing-thread',
    });

    const startRequest = mockCliStartCodexThread.mock.calls[0]?.[0];
    const resumeRequest = mockCliResumeCodexThread.mock.calls[0]?.[0];
    const projectDocConfig = {
      project_doc_max_bytes: 131_072,
      project_doc_fallback_filenames: ['CLAUDE.md'],
    };
    expect(startRequest?.params.config).toEqual(projectDocConfig);
    expect(resumeRequest?.params.config).toEqual(projectDocConfig);
  });

  it('resolves Ollama-scoped global instructions for an Ollama Codex invocation', async () => {
    mockCliRunCodexTurn.mockResolvedValue({
      status: 'completed',
      threadId: 'cli-thread',
      finalText: 'done',
      usage: {},
    });
    const runtime = createCliExecutionRuntime({ cwd: process.cwd() });
    const globalInstructionsEnvName = brandEnvName(
      'PREF_GLOBAL_INSTRUCTIONS_PIPELINES',
    );

    await runtime.codexPromptRunner?.runCodexPrompt({
      cwd: '/workspace/repo',
      prompt: 'do the work',
      environment: {
        [globalInstructionsEnvName]: JSON.stringify({
          overall: '',
          scoped: [
            {
              id: 'ollama-only',
              text: 'Use the local Ollama workflow.',
              mode: 'append',
              harnesses: ['ollama'],
              models: [],
              workspaceTypes: [],
            },
          ],
        }),
      },
      model: toOllamaModelId('qwen3'),
      harnessInvocation: {
        source: 'ollama',
        harness: 'codex',
        runtimeModel: 'qwen3',
        aiCreditsRouted: false,
      },
      fastMode: false,
      totalTimeoutMs: 60_000,
      permissionPreset: 'read_only',
      executionId: 'execution-1',
      jobId: 'job-1',
      stepId: 'step-1',
      attempt: 1,
      stepLabel: 'Ollama',
    });

    const startRequest = mockCliStartCodexThread.mock.calls[0]?.[0];
    expect(startRequest?.params.developerInstructions).toContain(
      'Use the local Ollama workflow.',
    );
  });

  it('suppresses Codex-native memories only when the desktop-provided local memory preference is on', async () => {
    const original = process.env.CANOPY_HARNESS_NATIVE_MEMORY;
    delete process.env.CANOPY_HARNESS_NATIVE_MEMORY;
    mockCliRunCodexTurn.mockResolvedValue({
      status: 'completed',
      threadId: 'cli-thread',
      finalText: 'done',
      usage: {},
    });
    const runtime = createCliExecutionRuntime({ cwd: process.cwd() });
    const baseRequest = {
      cwd: '/workspace/repo',
      prompt: 'do the work',
      environment: {},
      model: 'gpt-6-sol',
      fastMode: false,
      totalTimeoutMs: 60_000,
      permissionPreset: 'read_only' as const,
      executionId: 'execution-1',
      jobId: 'job-1',
      stepId: 'step-1',
      attempt: 1,
      stepLabel: 'Codex',
    };

    if (!runtime.codexPromptRunner) {
      throw new Error('Expected CLI Codex prompt runner');
    }

    try {
      // CLI-native execution: no preference env var, local memory treated as
      // OFF (the opt-in default) — canonical Codex memory config untouched.
      const result = await runtime.codexPromptRunner.runCodexPrompt({
        ...baseRequest,
      });
      expect(result.status).toBe('success');
      const startRequest = mockCliStartCodexThread.mock.calls[0]?.[0];
      expect(startRequest?.params.config).toEqual(
        CODEX_PROJECT_DOC_THREAD_CONFIG,
      );

      // Desktop-launched execution with local memory enabled: the branded
      // preference env var carries the opt-in and suppresses Codex memories.
      mockCliStartCodexThread.mockClear();
      await runtime.codexPromptRunner.runCodexPrompt({
        ...baseRequest,
        environment: { CANOPY_PREF_LOCAL_MEMORY_ENABLED: 'true' },
      });
      const suppressedRequest = mockCliStartCodexThread.mock.calls[0]?.[0];
      expect(suppressedRequest?.params.config).toEqual({
        ...CODEX_PROJECT_DOC_THREAD_CONFIG,
        'features.memories': false,
      });

      // Escape hatch force-allows native memory even while local memory is
      // enabled.
      mockCliStartCodexThread.mockClear();
      process.env.CANOPY_HARNESS_NATIVE_MEMORY = '1';
      await runtime.codexPromptRunner.runCodexPrompt({
        ...baseRequest,
        environment: { CANOPY_PREF_LOCAL_MEMORY_ENABLED: 'true' },
      });
      const allowedRequest = mockCliStartCodexThread.mock.calls[0]?.[0];
      expect(allowedRequest?.params.config).toEqual(
        CODEX_PROJECT_DOC_THREAD_CONFIG,
      );
    } finally {
      if (original === undefined) {
        delete process.env.CANOPY_HARNESS_NATIVE_MEMORY;
      } else {
        process.env.CANOPY_HARNESS_NATIVE_MEMORY = original;
      }
    }
  });
});

describe('CLI org model policy enforcement', () => {
  const POLICY_MODEL = 'claude-cli-policy-test';

  beforeAll(() => {
    initClaudeModels([
      {
        id: POLICY_MODEL,
        label: 'Claude CLI Policy Test',
        supportedThinkingLevels: ['low', 'medium'],
      },
    ]);
  });

  function writeAgentPromptAction(actionsDir: string): void {
    const actionDir = path.join(actionsDir, 'agent-prompt');
    fs.mkdirSync(actionDir, { recursive: true });
    fs.writeFileSync(
      path.join(actionDir, 'action.yml'),
      [
        'name: Agent Prompt',
        'log_format_hint: agent',
        'inputs:',
        '  model: {}',
        '  prompt: {}',
        '  system_prompt: {}',
        '  fast_mode: {}',
        'outputs: {}',
        'runs:',
        '  using: node',
        '  main: index.js',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(actionDir, 'index.js'),
      'process.exitCode = 0;',
      'utf8',
    );
  }

  function agentStep(): NormalizedStep {
    return {
      id: 'agent-policy',
      uses: 'builtin/agent-prompt',
      with: { model: POLICY_MODEL },
      shell: 'bash',
      continue_on_error: false,
      timeout_minutes: 1,
      skip_on_missing_action: false,
    };
  }

  it('always supplies the gate so the step-runner guard cannot be skipped', async () => {
    const runtime = createCliExecutionRuntime({ cwd: process.cwd() });

    // Regression: this member used to be optional and the CLI runtime never
    // set it, which silently disabled org model-policy enforcement for every
    // `apps/desktop-cli` pipeline run.
    expect(typeof runtime.isModelBlockedByOrgPolicy).toBe('function');
    await expect(runtime.isModelBlockedByOrgPolicy(POLICY_MODEL)).resolves.toBe(
      false,
    );
    expect(CLI_ORG_MODEL_POLICY_NOT_ENFORCEABLE_REASON).toContain(
      'safeStorage',
    );
  });

  it('always supplies the policy-active signal, reporting no active policy', async () => {
    const runtime = createCliExecutionRuntime({ cwd: process.cwd() });

    // Required for the same reason as the gate above: an omitted member would
    // be an invisible behavior difference rather than a compile error. A CLI
    // process cannot read the policy, so it reports no active policy and the
    // step-runner leaves unnamed-model steps exactly as they are today.
    expect(typeof runtime.isOrgModelPolicyActive).toBe('function');
    await expect(runtime.isOrgModelPolicyActive()).resolves.toBe(false);
  });

  it('uses an injected policy-active signal when a host supplies one', async () => {
    const isOrgModelPolicyActive = jest.fn(() => Promise.resolve(true));
    const runtime = createCliExecutionRuntime({
      cwd: process.cwd(),
      isOrgModelPolicyActive,
    });

    await expect(runtime.isOrgModelPolicyActive()).resolves.toBe(true);
    expect(isOrgModelPolicyActive).toHaveBeenCalled();
  });

  it('runs an agent step unblocked when no host gate is injected', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-cli-model-policy-'),
    );
    try {
      const actionsDir = path.join(tempDir, 'actions');
      writeAgentPromptAction(actionsDir);
      const runtime = createCliExecutionRuntime({
        cwd: tempDir,
        executionsDir: path.join(tempDir, 'executions'),
        bundledActionsDir: actionsDir,
      });

      const result = await runStep({
        executionId: 'exec-cli-allow',
        jobId: 'job-cli-allow',
        step: agentStep(),
        cwd: tempDir,
        env: {},
        runtime,
        signal: new AbortController().signal,
      });

      expect(result.error ?? '').not.toContain(
        'blocked by your organization policy',
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('refuses a blocked model when a host injects a real policy gate', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-cli-model-policy-'),
    );
    const isModelBlockedByOrgPolicy = jest.fn(() => Promise.resolve(true));
    try {
      const actionsDir = path.join(tempDir, 'actions');
      writeAgentPromptAction(actionsDir);
      const runtime = createCliExecutionRuntime({
        cwd: tempDir,
        executionsDir: path.join(tempDir, 'executions'),
        bundledActionsDir: actionsDir,
        isModelBlockedByOrgPolicy,
      });

      const result = await runStep({
        executionId: 'exec-cli-policy',
        jobId: 'job-cli-policy',
        step: agentStep(),
        cwd: tempDir,
        env: {},
        runtime,
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('failure');
      expect(result.error).toContain('blocked by your organization policy');
      expect(isModelBlockedByOrgPolicy).toHaveBeenCalledWith(POLICY_MODEL, {});
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('CLI Codex stdio MCP configuration', () => {
  it('forwards only the opaque broker route to the launcher', () => {
    expect(
      createCliStdioMcpServerConfig({
        routeId: 'route-id',
        capabilityId: 'capability-id',
        command: '/path/to/launcher',
        args: ['mcp-stdio'],
      }),
    ).toEqual({
      command: '/path/to/launcher',
      args: ['mcp-stdio'],
    });
  });
});

describe('CLI Codex capability snapshots', () => {
  it('uses the canonical cross-host fingerprint', () => {
    const options = {
      roots: [
        {
          id: 'root-1',
          location: {
            type: 'environment' as const,
            environmentId: 'local',
            path: 'file:///capability/root-1',
          },
        },
      ],
      mcpServers: {
        github: {
          type: 'http',
          url: 'http://127.0.0.1:43111/canopy/mcp/proxy/random-route',
        },
      },
      mcpAuthorityIds: ['github:authority-digest'],
    };

    expect(createCliCodexCapabilitySnapshotId(options)).toBe(
      createCodexCapabilitySnapshotId(options),
    );
  });
});

describe('pipeline plugin runtime paths', () => {
  it('keeps non-foreach paths stable and isolates foreach siblings', () => {
    const executionsDir = path.join('tmp', 'executions');
    expect(
      getPipelineExecutionPluginRuntimeDir(
        executionsDir,
        'exec',
        'job',
        'step',
      ),
    ).toBe(path.join(executionsDir, 'exec', 'plugin-runtime', 'job', 'step'));
    expect(
      getPipelineExecutionPluginRuntimeDir(
        executionsDir,
        'exec',
        'job',
        'step',
        'child-000001',
      ),
    ).toBe(
      path.join(
        executionsDir,
        'exec',
        'plugin-runtime',
        'job',
        'child-000001',
        'step',
      ),
    );
  });
});

describe('CLI Cursor runner', () => {
  // Isolate the data dir so a developer's real Cursor install (or lack of
  // one) can never make the "not installed" assertion below pass or fail
  // spuriously: getCanopyDataDir() resolves against process.env.CANOPY_DATA_DIR
  // and caches by that value, so pointing it at a fresh empty temp dir per
  // test guarantees cursorRuntimeInstalled() finds nothing there.
  const originalCanopyDataDir = process.env.CANOPY_DATA_DIR;
  let cursorTestDataDir: string;

  // Pin process.platform/process.arch so this suite is deterministic across
  // hosts. runCliCursorPrompt calls getCursorRuntimeTargetForHost() and
  // cursorRuntimeInstalled() with no arguments, so both fall back to the
  // real host. CURSOR_RUNTIME_TARGETS has no Linux entry, and the required
  // PR test shards run on ubuntu-latest (.github/workflows/lint.yml), so an
  // unstubbed run would silently resolve to "unsupported" there and change
  // which failure message the assertions below expect. Mirrors the explicit
  // platform/arch convention in
  // packages/desktop-shared/src/node/cursor/__tests__/runtime-status.test.ts
  // and the defineProperty stub/restore pattern in
  // apps/desktop-app/src/main/__tests__/config-paths.test.ts.
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
    process,
    'platform',
  );
  const originalArchDescriptor = Object.getOwnPropertyDescriptor(
    process,
    'arch',
  );

  function setHost(platform: string, arch: string): void {
    Object.defineProperty(process, 'platform', {
      value: platform,
      configurable: true,
    });
    Object.defineProperty(process, 'arch', {
      value: arch,
      configurable: true,
    });
  }

  beforeEach(() => {
    cursorTestDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-cli-cursor-runner-'),
    );
    process.env.CANOPY_DATA_DIR = cursorTestDataDir;
    // Default to a supported target (darwin-arm64); individual tests may
    // override this to exercise the unsupported-host path.
    setHost('darwin', 'arm64');
  });

  afterEach(() => {
    if (originalCanopyDataDir === undefined) {
      delete process.env.CANOPY_DATA_DIR;
    } else {
      process.env.CANOPY_DATA_DIR = originalCanopyDataDir;
    }
    fs.rmSync(cursorTestDataDir, { recursive: true, force: true });
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
    if (originalArchDescriptor) {
      Object.defineProperty(process, 'arch', originalArchDescriptor);
    }
  });

  it('fails with the connect message when the desktop runtime is not installed', async () => {
    const runtime = createCliExecutionRuntime({ cwd: process.cwd() });
    const result = await runtime.cursorPromptRunner?.runCursorPrompt({
      cwd: process.cwd(),
      prompt: 'x',
      environment: {},
      model: 'cursor-default',
      totalTimeoutMs: 1000,
      permissionPreset: 'read_only',
      executionsDir: '',
      executionId: 'e',
      jobId: 'j',
      stepId: 's',
      attempt: 1,
    });
    expect(result).toMatchObject({
      status: 'failure',
      failure: {
        provider: 'cursor',
        agent_harness: 'cursor',
        message: expect.stringContaining(
          'Connect Cursor in the desktop app first',
        ) as unknown,
      },
    });
  });

  it('fails with the connect message when the runtime is installed but the user disconnected Cursor in Settings', async () => {
    const versionDir = path.join(
      cursorTestDataDir,
      'cursor-runtime',
      CURSOR_RUNTIME_VERSION,
    );
    fs.mkdirSync(versionDir, { recursive: true });
    fs.writeFileSync(path.join(versionDir, 'cursor-agent'), '#!/bin/sh\n', {
      mode: 0o755,
    });
    fs.writeFileSync(path.join(versionDir, 'node'), '#!/bin/sh\n', {
      mode: 0o755,
    });
    fs.writeFileSync(
      path.join(cursorTestDataDir, 'preferences.json'),
      JSON.stringify({ version: 1, preferences: { cursorEnabled: false } }),
      'utf8',
    );
    mockRunCursorPromptWithDriver.mockReset();
    const runtime = createCliExecutionRuntime({ cwd: process.cwd() });
    const result = await runtime.cursorPromptRunner?.runCursorPrompt({
      cwd: process.cwd(),
      prompt: 'x',
      environment: {},
      model: 'cursor-default',
      totalTimeoutMs: 1000,
      permissionPreset: 'read_only',
      executionsDir: '',
      executionId: 'e',
      jobId: 'j',
      stepId: 's',
      attempt: 1,
    });
    expect(result).toMatchObject({
      status: 'failure',
      failure: {
        provider: 'cursor',
        agent_harness: 'cursor',
        message: expect.stringContaining(
          'Connect Cursor in the desktop app first',
        ) as unknown,
      },
    });
    expect(mockRunCursorPromptWithDriver).not.toHaveBeenCalled();
  });

  it('fails with the unsupported-device message on a host with no pinned Cursor target', async () => {
    setHost('linux', 'x64');
    const runtime = createCliExecutionRuntime({ cwd: process.cwd() });
    const result = await runtime.cursorPromptRunner?.runCursorPrompt({
      cwd: process.cwd(),
      prompt: 'x',
      environment: {},
      model: 'cursor-default',
      totalTimeoutMs: 1000,
      permissionPreset: 'read_only',
      executionsDir: '',
      executionId: 'e',
      jobId: 'j',
      stepId: 's',
      attempt: 1,
    });
    expect(result).toMatchObject({
      status: 'failure',
      failure: {
        provider: 'cursor',
        agent_harness: 'cursor',
        message: 'Cursor is not available on this device.',
      },
    });
  });
});

describe('the Cursor connection the desktop saved', () => {
  it.each([
    [
      'the desktop envelope, connected',
      { version: 1, preferences: { cursorEnabled: true } },
      true,
    ],
    [
      'the desktop envelope, disconnected',
      { version: 1, preferences: { cursorEnabled: false } },
      false,
    ],
    [
      'the desktop envelope without the field',
      { version: 1, preferences: {} },
      false,
    ],
    ['a flat file the desktop never writes', { cursorEnabled: true }, false],
    [
      'another version',
      { version: 2, preferences: { cursorEnabled: true } },
      false,
    ],
    [
      'a non-boolean value',
      { version: 1, preferences: { cursorEnabled: 'true' } },
      false,
    ],
    [
      'preferences that are not an object',
      { version: 1, preferences: [true] },
      false,
    ],
    ['not an object', 'cursorEnabled', false],
  ])('reads %s', (_name, parsed, expected) => {
    expect(cursorEnabledInPreferencesFile(parsed)).toBe(expected);
  });
});

describe('Copilot CLI host authority', () => {
  it('fails closed without a trusted rollout/account host and never substitutes a provider', async () => {
    const runtime = createCliExecutionRuntime({ cwd: process.cwd() });
    const result = await runtime.copilotPromptRunner?.runCopilotPrompt({
      cwd: process.cwd(),
      prompt: 'x',
      model: 'copilot:fixture',
      environment: {},
      totalTimeoutMs: 1000,
      permissionPreset: 'read_only',
      executionsDir: '',
      executionId: 'e',
      jobId: 'j',
      stepId: 's',
      attempt: 1,
    });
    expect(result).toMatchObject({
      status: 'failure',
      transcript: '',
      failure: {
        provider: 'copilot',
        agent_harness: 'copilot',
        had_agent_activity: false,
        message:
          'Copilot requires a connected desktop execution host with the rollout enabled.',
      },
    });
  });
});
