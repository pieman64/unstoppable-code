import type * as LedgerModule from '../observability/claude-session-cost-ledger';
import type * as MainLogModule from '../lib/main-process-logging';
const queryMock = jest.fn<unknown, [unknown]>();
let mockClaudeSessionCostLedger: ClaudeSessionCostLedger | undefined;
interface SelectedMcpHookOptions {
  options: {
    hooks: {
      PreToolUse: Array<{
        hooks: Array<(input: unknown, id?: string) => Promise<unknown>>;
      }>;
    };
    canUseTool: (
      name: string,
      input: unknown,
      permission: { toolUseID: string },
    ) => Promise<unknown>;
  };
}

function hasSelectedMcpHookOptions(
  value: unknown,
): value is SelectedMcpHookOptions {
  if (typeof value !== 'object' || value === null || !('options' in value))
    return false;
  const options = value.options;
  if (
    typeof options !== 'object' ||
    options === null ||
    !('hooks' in options) ||
    !('canUseTool' in options)
  )
    return false;
  const hooks = options.hooks;
  return (
    typeof options.canUseTool === 'function' &&
    typeof hooks === 'object' &&
    hooks !== null &&
    'PreToolUse' in hooks &&
    Array.isArray(hooks.PreToolUse) &&
    hooks.PreToolUse.every(
      (entry: unknown) =>
        typeof entry === 'object' &&
        entry !== null &&
        'hooks' in entry &&
        Array.isArray(entry.hooks) &&
        entry.hooks.every((hook: unknown) => typeof hook === 'function'),
    )
  );
}
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]): unknown => queryMock(...args),
  createSdkMcpServer: jest.fn(() => ({ type: 'sdk' })),
  tool: jest.fn((name: string) => ({ name })),
}));

jest.mock('../agents/claude-process-host-runner', () => ({
  spawnClaudeCodeProcessOffMain: jest.fn(),
}));

jest.mock('../lib/main-process-logging', () => ({
  ...jest.requireActual<typeof MainLogModule>('../lib/main-process-logging'),
  logMainProcessWarn: jest.fn(),
}));

jest.mock('../pipelines/config-paths', () => ({
  getBundledClaudeBinaryPath: jest.fn(() => '/fake/claude'),
}));

jest.mock('../observability/claude-session-cost-ledger', () => {
  const actual = jest.requireActual<typeof LedgerModule>(
    '../observability/claude-session-cost-ledger',
  );
  return {
    ...actual,
    getClaudeSessionCostLedger: (): ClaudeSessionCostLedger => {
      if (!mockClaudeSessionCostLedger)
        throw new Error('Claude session cost ledger is not initialized');
      return mockClaudeSessionCostLedger;
    },
  };
});

import type { AgentRunRequest } from '@canopy/desktop-shared/node/delegation';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentDelegationEvent,
  AgentDelegationSnapshot,
} from '@canopy/protocol/delegation';
import {
  createSdkMcpServer,
  tool as mockedSdkTool,
} from '@anthropic-ai/claude-agent-sdk';
import { BRAND } from '@canopy/brand/current';
import { DEFERRED_TOOLS_RELOAD_CONTINUATION_TEMPLATE } from '@canopy/desktop-shared/types';
import { DelegationCapabilityReloadController } from '../agents/delegation/capability-reload';
import {
  createClaudeDelegationRunner,
  type ClaudeDelegationPreparation,
} from '../agents/delegation/claude-runner';
import type { ChildLedgerTools } from '../agents/delegation/ledger-tools';
import {
  DelegationParent,
  type DelegationParentBroker,
} from '@canopy/desktop-shared/node/delegation/parent';
import { DELEGATION_TRANSCRIPT_RECORDER_LIMITS } from '../agents/delegation/transcript-recorder';
import { ClaudeSessionCostLedger } from '../observability/claude-session-cost-ledger';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { inspect } from 'node:util';
import type { SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import {
  LocalDelegationCleanupError,
  type LocalDelegationCleanupResource,
} from '@canopy/desktop-shared/node/delegation/cleanup-diagnostics';
import {
  LocalDelegationRunner,
  type LocalDelegationContext,
} from '@canopy/desktop-shared/node/delegation/local-runner';
import type { NativeRunHandle } from '@canopy/desktop-shared/node/delegation/types';
import { spawnClaudeCodeProcessOffMain } from '../agents/claude-process-host-runner';
import { reportDelegationError } from '../agents/delegation/report-error';
import { logMainProcessWarn } from '../lib/main-process-logging';
import {
  CLEANUP_CANARY,
  CLEANUP_RESOURCES as resource,
  cleanupRecord,
  cleanupRecords,
  errorFields,
  failure,
  reportedCleanupDiagnostics,
} from './helpers/delegation-cleanup-records';

let ledgerTempDirectory: string | undefined;

beforeEach(async () => {
  queryMock.mockClear();
  ledgerTempDirectory = await mkdtemp(
    join(tmpdir(), 'claude-delegation-cost-'),
  );
  mockClaudeSessionCostLedger = new ClaudeSessionCostLedger({
    filePath: join(ledgerTempDirectory, 'session-costs.json'),
    persistDelayMs: 0,
  });
});

afterEach(async () => {
  await mockClaudeSessionCostLedger?.flush();
  if (ledgerTempDirectory)
    await rm(ledgerTempDirectory, { recursive: true, force: true });
  ledgerTempDirectory = undefined;
  mockClaudeSessionCostLedger = undefined;
});

function successfulQuery(): AsyncGenerator<
  Record<string, unknown>,
  void,
  void
> & { close: jest.Mock } {
  async function* events(): AsyncGenerator<Record<string, unknown>> {
    await Promise.resolve();
    yield {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'done',
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  }
  return Object.assign(events(), { close: jest.fn() });
}

const request = {
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
    modelId: 'claude-test',
    description: 'Inspect code',
    prompt: 'Inspect the requested code.',
    executionMode: 'foreground',
    contextPolicy: 'task_only',
    isolation: 'shared_worktree',
  },
  route: {
    selectedModelId: 'claude-test',
    runtimeModelId: 'claude-test',
    harnessId: 'claude',
    runtimeKind: 'claude-sdk',
    runnerRegistrationId: 'claude-local',
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
  cwd: '/worktree',
  effectivePermission: 'read-only',
  signal: new AbortController().signal,
} satisfies AgentRunRequest;

async function failureTerminal(
  events: Iterable<Record<string, unknown>>,
): Promise<AgentDelegationEvent['event']> {
  queryMock.mockReturnValue(Object.assign(events, { close: jest.fn() }));
  const runner = createClaudeDelegationRunner({
    available: () => Promise.resolve({ available: true }),
    prepare: () =>
      Promise.resolve({
        model: 'claude-test',
        environment: { PATH: '' },
        tools: {
          authorize: () => Promise.resolve(true),
          mode: 'auto',
          instructions: () => 'Read-only instructions',
        },
      }),
    reportError: jest.fn(),
  });
  const terminal = new Promise<AgentDelegationEvent['event']>((resolve) => {
    void runner.start(request, (event) => {
      if (event.event.type === 'terminal') resolve(event.event);
      return Promise.resolve();
    });
  });
  return terminal;
}

function costedQuery(
  totalCostUsd: number,
): AsyncGenerator<Record<string, unknown>, void, void> & { close: jest.Mock } {
  async function* events(): AsyncGenerator<Record<string, unknown>> {
    await Promise.resolve();
    yield {
      type: 'system',
      subtype: 'init',
      session_id: 'native-session',
    };
    yield {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'done',
      session_id: 'native-session',
      total_cost_usd: totalCostUsd,
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  }
  return Object.assign(events(), { close: jest.fn() });
}

function costTestRunner(): ReturnType<typeof createClaudeDelegationRunner> {
  return createClaudeDelegationRunner({
    available: () => Promise.resolve({ available: true }),
    prepare: () =>
      Promise.resolve({
        model: 'claude-test',
        environment: { PATH: '' },
        tools: {
          authorize: () => Promise.resolve(true),
          mode: 'auto',
          instructions: () => '',
        },
      }),
    reportError: jest.fn(),
  });
}

async function runToTerminal(
  runRequest: AgentRunRequest,
): Promise<AgentDelegationEvent['event']> {
  const runner = costTestRunner();
  let resolveTerminal: (event: AgentDelegationEvent['event']) => void = () =>
    undefined;
  const terminal = new Promise<AgentDelegationEvent['event']>((resolve) => {
    resolveTerminal = resolve;
  });
  const handle = await runner.start(runRequest, (event) => {
    if (event.event.type === 'terminal') resolveTerminal(event.event);
    return Promise.resolve();
  });
  const event = await terminal;
  await runner.close(handle);
  return event;
}

it.each([
  {
    result: {
      subtype: 'success',
      is_error: true,
      result: "You've hit your session limit · resets 2:40pm",
    },
    reason: "You've hit your session limit · resets 2:40pm",
  },
  {
    result: {
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['Provider could not authenticate.'],
    },
    reason: 'Provider could not authenticate.',
  },
  {
    result: { subtype: 'error_max_turns', is_error: true, errors: [] },
    reason: 'error_max_turns',
  },
])(
  'preserves the SDK failure reason in the retained parent result: $reason',
  async ({ result, reason }) => {
    function* events(): Generator<Record<string, unknown>> {
      yield {
        type: 'result',
        ...result,
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    }
    const terminal = failureTerminal(events());
    const reasonMatcher: unknown = expect.stringContaining(reason);
    await expect(terminal).resolves.toMatchObject({
      type: 'terminal',
      status: 'failed',
      error: {
        code: 'runtime_error',
        message: reasonMatcher,
      },
    });
    const event = await terminal;
    if (event.type !== 'terminal') throw new Error('Expected terminal event');
    expect(event.error?.message).not.toContain('Retained partial output');
    expect(event).not.toHaveProperty('finalText');
  },
);

it('retains a synthetic rate-limit reason when the result has no error detail', async () => {
  function* events(): Generator<Record<string, unknown>> {
    yield {
      type: 'assistant',
      error: 'rate_limit',
      message: {
        id: 'quota-error',
        content: [
          {
            type: 'text',
            text: "You've hit your session limit · resets 2:40pm",
          },
        ],
      },
    };
    yield {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: [],
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }
  const terminal = failureTerminal(events());
  const reasonMatcher: unknown = expect.stringContaining(
    "rate_limit: You've hit your session limit",
  );
  await expect(terminal).resolves.toMatchObject({
    type: 'terminal',
    status: 'failed',
    error: {
      message: reasonMatcher,
    },
  });
});

it('redacts and bounds provider errors before returning them to the parent', async () => {
  function* events(): Generator<Record<string, unknown>> {
    yield {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: [
        'Provider failure: api_key=super-secret-value ' +
          'detail '.repeat(1000),
      ],
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }
  const terminal = failureTerminal(events());
  const event = await terminal;
  if (event.type !== 'terminal') throw new Error('Expected terminal event');
  expect(event.error?.message).toContain(
    'Provider failure: api_key=<redacted>',
  );
  expect(event.error?.message).not.toContain('super-secret-value');
  expect(event.error?.message.length).toBeLessThanOrEqual(4096);
});

it('launches native Claude file tools with authoritative approval hooks', async () => {
  queryMock.mockReturnValue(successfulQuery());
  const runner = createClaudeDelegationRunner({
    available: () => Promise.resolve({ available: true }),
    prepare: () =>
      Promise.resolve({
        model: 'claude-test',
        environment: { PATH: '' },
        tools: {
          authorize: () => Promise.resolve(true),
          mode: 'auto',
          instructions: () => 'Read-only instructions',
        },
      }),
    reportError: jest.fn(),
  });
  const terminal = new Promise<void>((resolve) => {
    void runner.start(request, (event) => {
      if (event.event.type === 'terminal') resolve();
      return Promise.resolve();
    });
  });
  await terminal;

  const queryCall: unknown = queryMock.mock.calls[0]?.[0];
  expect(queryCall).toHaveProperty('options');
  expect(queryCall).toHaveProperty('options.tools', [
    'Read',
    'Grep',
    'Glob',
    'Edit',
    'Write',
    'Bash',
    'TaskStop',
  ]);
  expect(queryCall).toHaveProperty('options.hooks.PreToolUse');
  expect(queryCall).toHaveProperty('options.mcpServers', {});
  expect(queryCall).toHaveProperty('options.skills', []);
});

it("starts Claude in the policy's canonical working directory", async () => {
  // Windows keeps the spelling a process was started with, such as an 8.3
  // short name, so Claude must resolve relative tool paths against the same
  // canonical directory that the native policy checks them against.
  queryMock.mockReturnValue(successfulQuery());
  const runner = createClaudeDelegationRunner({
    available: () => Promise.resolve({ available: true }),
    prepare: () =>
      Promise.resolve({
        model: 'claude-test',
        environment: { PATH: '' },
        tools: {
          cwd: '/canonical/worktree',
          authorize: () => Promise.resolve(true),
          mode: 'auto',
          instructions: () => 'Read-only instructions',
        },
      }),
    reportError: jest.fn(),
  });
  const terminal = new Promise<void>((resolve) => {
    void runner.start(request, (event) => {
      if (event.event.type === 'terminal') resolve();
      return Promise.resolve();
    });
  });
  await terminal;
  expect(queryMock.mock.calls[0]?.[0]).toHaveProperty(
    'options.cwd',
    '/canonical/worktree',
  );
});

it('renders current system-level capability instructions on a resumed run', async () => {
  queryMock.mockReturnValue(successfulQuery());
  const runner = createClaudeDelegationRunner({
    available: () => Promise.resolve({ available: true }),
    prepare: () =>
      Promise.resolve({
        model: 'claude-test',
        environment: { PATH: '' },
        plugins: [{ type: 'local', path: '/retained/current/plugin' }],
        tools: {
          authorize: () => Promise.resolve(true),
          mode: 'auto',
          instructions: () =>
            'Retained Agent instructions; read only /retained/current/plugin.',
        },
      }),
    reportError: jest.fn(),
  });
  const terminal = new Promise<void>((resolve) => {
    void runner.start(
      { ...request, runGeneration: 2, resumeSessionId: 'native-session' },
      (event) => {
        if (event.event.type === 'terminal') resolve();
        return Promise.resolve();
      },
    );
  });
  await terminal;
  expect(queryMock.mock.calls[0]?.[0]).toMatchObject({
    options: {
      resume: 'native-session',
      systemPrompt: {
        type: 'custom',
        snapshot: false,
      },
      plugins: [{ type: 'local', path: '/retained/current/plugin' }],
    },
  });
  expect(queryMock.mock.calls[0]?.[0]).toHaveProperty(
    'options.systemPrompt.prompt',
    expect.stringContaining('/retained/current/plugin'),
  );
});

it('reports the result total for a single-segment Claude run', async () => {
  queryMock.mockReturnValueOnce(costedQuery(0.12));

  const terminal = await runToTerminal(request);

  expect(terminal).toMatchObject({
    type: 'terminal',
    status: 'completed',
    usage: { costUsd: 0.12 },
  });
});

it('reports only this follow-up run generation cost when resuming a saved session', async () => {
  const initialLedger = mockClaudeSessionCostLedger;
  const directory = ledgerTempDirectory;
  if (!initialLedger || !directory)
    throw new Error('Claude cost test ledger is not initialized');
  const filePath = join(directory, 'session-costs.json');

  queryMock.mockReturnValueOnce(costedQuery(0.4));
  const first = await runToTerminal({ ...request, runGeneration: 1 });
  expect(first).toMatchObject({ usage: { costUsd: 0.4 } });
  await initialLedger.flush();

  mockClaudeSessionCostLedger = new ClaudeSessionCostLedger({
    filePath,
    persistDelayMs: 0,
  });
  queryMock.mockReturnValueOnce(costedQuery(0.65));
  const followUp = await runToTerminal({
    ...request,
    runGeneration: 2,
    resumeSessionId: 'native-session',
  });

  expect(followUp).toMatchObject({
    type: 'terminal',
    status: 'completed',
    usage: { costUsd: 0.25 },
  });
});

it('treats a leading slash in the delegated task as text instead of SDK command dispatch', async () => {
  queryMock.mockReturnValue(successfulQuery());
  const runner = createClaudeDelegationRunner({
    available: () => Promise.resolve({ available: true }),
    prepare: () =>
      Promise.resolve({
        model: 'claude-test',
        environment: { PATH: '' },
        tools: {
          authorize: () => Promise.resolve(true),
          mode: 'auto',
          instructions: () => '',
        },
      }),
    reportError: jest.fn(),
  });
  const terminal = new Promise<void>((resolve) => {
    void runner.start(
      { ...request, task: { ...request.task, prompt: '/code-review' } },
      (event) => {
        if (event.event.type === 'terminal') resolve();
        return Promise.resolve();
      },
    );
  });
  await terminal;
  expect(queryMock.mock.calls[0]?.[0]).toHaveProperty(
    'prompt',
    'Managed delegated task:\n/code-review',
  );
});

it('mounts only retained Agent plugin roots and scoped MCP servers', async () => {
  queryMock.mockReturnValue(successfulQuery());
  const runner = createClaudeDelegationRunner({
    available: () => Promise.resolve({ available: true }),
    prepare: () =>
      Promise.resolve({
        model: 'claude-test',
        environment: { PATH: '' },
        plugins: [{ type: 'local', path: '/retained/claude-plugin' }],
        skillNames: ['reviewer:reviewer'],
        mcpServers: {
          selected_review: {
            type: 'http',
            url: 'http://127.0.0.1:1234/selected',
          },
        },
        tools: {
          authorize: (name: string) => Promise.resolve(name === 'Skill'),
          mode: 'auto',
          instructions: () => 'Selected Agent instructions',
        },
      }),
    reportError: jest.fn(),
  });
  const terminal = new Promise<void>((resolve) => {
    void runner.start(request, (event) => {
      if (event.event.type === 'terminal') resolve();
      return Promise.resolve();
    });
  });
  await terminal;

  expect(queryMock.mock.calls[0]?.[0]).toMatchObject({
    options: {
      plugins: [{ type: 'local', path: '/retained/claude-plugin' }],
      mcpServers: {
        selected_review: {
          type: 'http',
          url: 'http://127.0.0.1:1234/selected',
        },
      },
      settingSources: ['user', 'project', 'local'],
      skills: ['reviewer:reviewer'],
      strictMcpConfig: true,
    },
  });
  expect(queryMock.mock.calls[0]?.[0]).toHaveProperty(
    'options.tools',
    expect.arrayContaining(['Skill']),
  );
  const queryCall: unknown = queryMock.mock.calls[0]?.[0];
  if (!hasSelectedMcpHookOptions(queryCall))
    throw new Error('Missing selected MCP hooks');
  const options = queryCall.options;
  const hook = options.hooks.PreToolUse[0]?.hooks[0];
  expect(hook).toBeDefined();
  await expect(
    hook?.(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'mcp__selected_review__review_evidence',
        tool_input: { id: 1 },
      },
      'selected-mcp',
    ),
  ).resolves.toMatchObject({
    hookSpecificOutput: { permissionDecision: 'allow' },
  });
  await expect(
    options.canUseTool(
      'mcp__selected_review__review_evidence',
      { id: 1 },
      { toolUseID: 'selected-mcp' },
    ),
  ).resolves.toMatchObject({ behavior: 'allow' });
  await expect(
    options.canUseTool(
      'mcp__selected_review__check__deep',
      { id: 2 },
      { toolUseID: 'selected-mcp-underscores' },
    ),
  ).resolves.toMatchObject({ behavior: 'allow' });
  await expect(
    options.canUseTool('mcp__ambient__read', {}, { toolUseID: 'ambient-mcp' }),
  ).resolves.toMatchObject({ behavior: 'deny' });
  // A refused shell detachment tells the child what to use instead.
  const detached = { command: 'npm run dev &' };
  const hookDenial = await hook?.(
    {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: detached,
    },
    'detached-shell',
  );
  expect(hookDenial).toMatchObject({
    hookSpecificOutput: { permissionDecision: 'deny' },
  });
  expect(JSON.stringify(hookDenial)).toContain('run_in_background');
  const permissionDenial = await options.canUseTool('Bash', detached, {
    toolUseID: 'detached-shell',
  });
  expect(permissionDenial).toMatchObject({ behavior: 'deny' });
  expect(JSON.stringify(permissionDenial)).toContain('run_in_background');
});

it('loads the parent chat settings sources behind a policy-tier approval guard', async () => {
  queryMock.mockReturnValue(successfulQuery());
  const runner = createClaudeDelegationRunner({
    available: () => Promise.resolve({ available: true }),
    prepare: () =>
      Promise.resolve({
        model: 'claude-test',
        environment: { PATH: '' },
        ambientPluginIds: ['formatter@tools', 'linter@tools'],
        tools: {
          authorize: () => Promise.resolve(true),
          mode: 'auto',
          instructions: () => '',
        },
      }),
    reportError: jest.fn(),
  });
  const terminal = new Promise<void>((resolve) => {
    void runner.start(request, (event) => {
      if (event.event.type === 'terminal') resolve();
      return Promise.resolve();
    });
  });
  await terminal;
  const options: unknown = queryMock.mock.calls[0]?.[0];
  expect(options).toMatchObject({
    options: {
      settingSources: ['user', 'project', 'local'],
      strictMcpConfig: true,
      managedSettings: { permissions: { ask: ['*'] } },
      settings: {
        permissions: { ask: ['*'] },
        // Only the Agent's selected plugins reach the child.
        enabledPlugins: { 'formatter@tools': false, 'linter@tools': false },
      },
    },
  });
  expect(options).toHaveProperty(
    'options.managedSettings.permissions.deny',
    expect.arrayContaining([expect.stringMatching(/^Read\(/)]),
  );
});

it('serves app-owned tools beside delegation tools and approves them when they run', async () => {
  queryMock.mockReturnValue(successfulQuery());
  const appTool = {
    key: 'get_script_output' as const,
    name: 'GetScriptOutput',
    codexName: `${BRAND.tools.namespace}_get_script_output`,
    description: 'Read script output.',
    inputSchema: {
      type: 'object',
      properties: { scriptId: { type: 'string' } },
      required: ['scriptId'],
    },
    readOnly: true,
  };
  const execute = jest.fn(() => Promise.resolve({ text: 'output' }));
  const authorizeNative = jest.fn(() => Promise.resolve(false));
  const runner = createClaudeDelegationRunner({
    available: () => Promise.resolve({ available: true }),
    prepare: () =>
      Promise.resolve({
        model: 'claude-test',
        environment: { PATH: '' },
        appTools: {
          tools: [appTool],
          isolated: false,
          toolForClaudeName: (name: string) =>
            name === `mcp__${BRAND.tools.namespace}__GetScriptOutput`
              ? appTool
              : undefined,
          toolForCodexName: () => undefined,
          authorize: () => Promise.resolve(true),
          run: execute,
          execute,
        },
        tools: {
          authorize: authorizeNative,
          mode: 'auto',
          instructions: () => '',
        },
      }),
    reportError: jest.fn(),
  });
  const terminal = new Promise<void>((resolve) => {
    void runner.start(request, (event) => {
      if (event.event.type === 'terminal') resolve();
      return Promise.resolve();
    });
  });
  await terminal;
  expect(jest.mocked(createSdkMcpServer)).toHaveBeenCalledWith(
    expect.objectContaining({
      name: BRAND.tools.namespace,
      tools: [expect.objectContaining({ name: 'GetScriptOutput' })],
    }),
  );
  const queryCall: unknown = queryMock.mock.calls[0]?.[0];
  expect(queryCall).toHaveProperty(
    ['options', 'mcpServers', BRAND.tools.namespace],
    { type: 'sdk' },
  );
  if (!hasSelectedMcpHookOptions(queryCall))
    throw new Error('Missing app tool hooks');
  const hook = queryCall.options.hooks.PreToolUse[0]?.hooks[0];
  await expect(
    hook?.(
      {
        hook_event_name: 'PreToolUse',
        tool_name: `mcp__${BRAND.tools.namespace}__GetScriptOutput`,
        tool_input: { scriptId: 'test' },
      },
      'app-tool',
    ),
  ).resolves.toMatchObject({
    hookSpecificOutput: { permissionDecision: 'allow' },
  });
  await expect(
    queryCall.options.canUseTool(
      `mcp__${BRAND.tools.namespace}__GetScriptOutput`,
      { scriptId: 'test' },
      { toolUseID: 'app-tool' },
    ),
  ).resolves.toMatchObject({ behavior: 'allow' });
  // A chat-only app tool the child was not given falls through to the
  // native policy and is denied.
  await expect(
    queryCall.options.canUseTool(
      `mcp__${BRAND.tools.namespace}__SetupWatchers`,
      {},
      { toolUseID: 'chat-only' },
    ),
  ).resolves.toMatchObject({ behavior: 'deny' });
});

it('sends Claude steering with a correlatable UUID and native session', async () => {
  const attemptId = '123e4567-e89b-42d3-a456-426614174000';
  let resolveSent: (message: Record<string, unknown>) => void = () => undefined;
  const sent = new Promise<Record<string, unknown>>((resolve) => {
    resolveSent = resolve;
  });
  async function* events(): AsyncGenerator<Record<string, unknown>> {
    yield {
      type: 'system',
      subtype: 'init',
      session_id: 'native-session',
      capabilities: [
        'msg_lifecycle_v1',
        'interrupt_receipt_v1',
        'interrupt_cancel_queued_v1',
      ],
    };
    const message = await sent;
    yield {
      type: 'command_lifecycle',
      command_uuid: message.uuid,
      state: 'queued',
      parent_tool_use_id: null,
    };
    yield {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'done',
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  }
  queryMock.mockReturnValue(
    Object.assign(events(), {
      close: jest.fn(),
      cancelAsyncMessage: jest.fn(),
      interrupt: jest.fn(),
      streamInput: jest.fn(
        async (input: AsyncIterable<Record<string, unknown>>) => {
          for await (const message of input) resolveSent(message);
        },
      ),
    }),
  );
  const runner = createClaudeDelegationRunner({
    available: () => Promise.resolve({ available: true }),
    prepare: () =>
      Promise.resolve({
        model: 'claude-test',
        environment: { PATH: '' },
        tools: {
          authorize: () => Promise.resolve(true),
          mode: 'auto',
          instructions: () => '',
        },
      }),
    reportError: jest.fn(),
  });
  let resolveStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const handle = await runner.start(request, (event) => {
    if (event.event.type === 'started') resolveStarted();
    return Promise.resolve();
  });
  await started;
  const admission = await runner.steer(handle, {
    delegationId: request.delegationId,
    runGeneration: request.runGeneration,
    attemptId,
    message: '/code-review',
  });
  expect(admission).toMatchObject({ kind: 'accepted', attemptId });
  await expect(sent).resolves.toMatchObject({
    uuid: attemptId,
    session_id: 'native-session',
    message: { role: 'user', content: 'Managed delegated task:\n/code-review' },
  });
  await runner.close(handle);
});

describe('a steer queued when the Claude turn ends', () => {
  const attemptId = '123e4567-e89b-42d3-a456-426614174003';
  const capabilities = [
    'msg_lifecycle_v1',
    'interrupt_receipt_v1',
    'interrupt_cancel_queued_v1',
  ];

  function result(text: string, totalCostUsd = 0): Record<string, unknown> {
    return {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: text,
      session_id: 'native-session',
      total_cost_usd: totalCostUsd,
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  }

  function steeredQuery(
    afterResult: (uuid: unknown) => Record<string, unknown>[],
  ): {
    query: AsyncGenerator<Record<string, unknown>> & Record<string, unknown>;
    sent: Promise<Record<string, unknown>>;
  } {
    let resolveSent: (message: Record<string, unknown>) => void = () =>
      undefined;
    const sent = new Promise<Record<string, unknown>>((resolve) => {
      resolveSent = resolve;
    });
    async function* events(): AsyncGenerator<Record<string, unknown>> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'native-session',
        capabilities,
      };
      const message = await sent;
      yield {
        type: 'command_lifecycle',
        command_uuid: message.uuid,
        state: 'queued',
        parent_tool_use_id: null,
      };
      yield result('First answer.', 0.1);
      for (const event of afterResult(message.uuid)) yield event;
    }
    return {
      sent,
      query: Object.assign(events(), {
        close: jest.fn(),
        cancelAsyncMessage: jest.fn(),
        interrupt: jest.fn(),
        streamInput: jest.fn(
          async (input: AsyncIterable<Record<string, unknown>>) => {
            for await (const message of input) resolveSent(message);
          },
        ),
      }),
    };
  }

  async function steerAndFinish(): Promise<AgentDelegationEvent['event']> {
    const runner = createClaudeDelegationRunner({
      available: () => Promise.resolve({ available: true }),
      prepare: () =>
        Promise.resolve({
          model: 'claude-test',
          environment: { PATH: '' },
          tools: {
            authorize: () => Promise.resolve(true),
            mode: 'auto',
            instructions: () => '',
          },
        }),
      reportError: jest.fn(),
    });
    let resolveStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    let resolveTerminal: (event: AgentDelegationEvent['event']) => void = () =>
      undefined;
    const terminal = new Promise<AgentDelegationEvent['event']>((resolve) => {
      resolveTerminal = resolve;
    });
    const handle = await runner.start(request, (event) => {
      if (event.event.type === 'started') resolveStarted();
      if (event.event.type === 'terminal') resolveTerminal(event.event);
      return Promise.resolve();
    });
    await started;
    await expect(
      runner.steer(handle, {
        delegationId: request.delegationId,
        runGeneration: request.runGeneration,
        attemptId,
        message: 'Make that three.',
      }),
    ).resolves.toMatchObject({ kind: 'accepted', attemptId });
    const event = await terminal;
    await runner.close(handle);
    return event;
  }

  it('keeps reading the stream so the SDK runs the steer as the next turn', async () => {
    const { query } = steeredQuery((uuid) => [
      {
        type: 'command_lifecycle',
        command_uuid: uuid,
        state: 'started',
        parent_tool_use_id: null,
      },
      result('Three answers.'),
    ]);
    queryMock.mockReturnValue(query);

    await expect(steerAndFinish()).resolves.toMatchObject({
      type: 'terminal',
      status: 'completed',
      finalText: 'Three answers.',
    });
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('counts a steered turn cost once, since the SDK reports a running total', async () => {
    const { query } = steeredQuery((uuid) => [
      {
        type: 'command_lifecycle',
        command_uuid: uuid,
        state: 'started',
        parent_tool_use_id: null,
      },
      // `total_cost_usd` covers every turn of this query: 0.1 + 0.2.
      result('Three answers.', 0.3),
    ]);
    queryMock.mockReturnValue(query);

    const terminal = await steerAndFinish();
    expect(terminal).toMatchObject({
      type: 'terminal',
      status: 'completed',
      usage: { costUsd: 0.3, inputTokens: 2, outputTokens: 2 },
    });
  });

  it('counts only new spend when a queued steer resumes the same session in a second segment', async () => {
    const { query } = steeredQuery(() => []);
    async function* resumed(): AsyncGenerator<Record<string, unknown>> {
      await Promise.resolve();
      yield result('Three answers.', 0.3);
    }
    queryMock
      .mockReturnValueOnce(query)
      .mockReturnValueOnce(Object.assign(resumed(), { close: jest.fn() }));

    const terminal = await steerAndFinish();

    expect(terminal).toMatchObject({
      type: 'terminal',
      status: 'completed',
      usage: { costUsd: 0.3 },
    });
    expect(queryMock.mock.calls[1]?.[0]).toMatchObject({
      options: { resume: 'native-session' },
    });
  });

  it('does not report the earlier answer when the steered turn never finishes', async () => {
    const { query } = steeredQuery((uuid) => [
      {
        type: 'command_lifecycle',
        command_uuid: uuid,
        state: 'started',
        parent_tool_use_id: null,
      },
    ]);
    queryMock.mockReturnValue(query);

    const terminal = await steerAndFinish();
    expect(terminal).toMatchObject({ type: 'terminal', status: 'failed' });
    expect(terminal).not.toHaveProperty('finalText');
  });

  it('keeps steering live while the steered turn runs', async () => {
    const secondAttemptId = '123e4567-e89b-42d3-a456-426614174004';
    const sent: Record<string, unknown>[] = [];
    let wake: () => void = () => undefined;
    let closed = false;
    const nextSent = async (
      count: number,
    ): Promise<Record<string, unknown> | undefined> => {
      while (sent.length < count && !closed)
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      return sent[count - 1];
    };
    let resolveContinued: () => void = () => undefined;
    const continued = new Promise<void>((resolve) => {
      resolveContinued = resolve;
    });
    async function* events(): AsyncGenerator<Record<string, unknown>> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'native-session',
        capabilities,
      };
      const first = await nextSent(1);
      yield {
        type: 'command_lifecycle',
        command_uuid: first?.uuid,
        state: 'queued',
        parent_tool_use_id: null,
      };
      yield result('First answer.', 0.1);
      yield {
        type: 'command_lifecycle',
        command_uuid: first?.uuid,
        state: 'started',
        parent_tool_use_id: null,
      };
      resolveContinued();
      const second = await nextSent(2);
      if (!second) return;
      yield {
        type: 'command_lifecycle',
        command_uuid: second.uuid,
        state: 'queued',
        parent_tool_use_id: null,
      };
      yield {
        type: 'command_lifecycle',
        command_uuid: second.uuid,
        state: 'started',
        parent_tool_use_id: null,
      };
      yield result('Four answers.', 0.3);
    }
    queryMock.mockReturnValue(
      Object.assign(events(), {
        close: jest.fn(() => {
          closed = true;
          wake();
        }),
        cancelAsyncMessage: jest.fn(),
        interrupt: jest.fn(),
        streamInput: jest.fn(
          async (input: AsyncIterable<Record<string, unknown>>) => {
            for await (const message of input) {
              sent.push(message);
              wake();
            }
          },
        ),
      }),
    );
    const runner = createClaudeDelegationRunner({
      available: () => Promise.resolve({ available: true }),
      prepare: () =>
        Promise.resolve({
          model: 'claude-test',
          environment: { PATH: '' },
          tools: {
            authorize: () => Promise.resolve(true),
            mode: 'auto',
            instructions: () => '',
          },
        }),
      reportError: jest.fn(),
    });
    let resolveStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    let resolveTerminal: (event: AgentDelegationEvent['event']) => void = () =>
      undefined;
    const terminal = new Promise<AgentDelegationEvent['event']>((resolve) => {
      resolveTerminal = resolve;
    });
    const handle = await runner.start(request, (event) => {
      if (event.event.type === 'started') resolveStarted();
      if (event.event.type === 'terminal') resolveTerminal(event.event);
      return Promise.resolve();
    });
    try {
      await started;
      await expect(
        runner.steer(handle, {
          delegationId: request.delegationId,
          runGeneration: request.runGeneration,
          attemptId,
          message: 'Make that three.',
        }),
      ).resolves.toMatchObject({ kind: 'accepted', attemptId });
      await continued;
      await expect(
        runner.steer(handle, {
          delegationId: request.delegationId,
          runGeneration: request.runGeneration,
          attemptId: secondAttemptId,
          message: 'Make that four.',
        }),
      ).resolves.toMatchObject({
        kind: 'accepted',
        attemptId: secondAttemptId,
      });
      await expect(terminal).resolves.toMatchObject({
        type: 'terminal',
        status: 'completed',
        finalText: 'Four answers.',
      });
    } finally {
      await runner.close(handle);
    }
  });

  it('keeps an accepted unstarted steer when recovering a quota failure', async () => {
    const { query } = steeredQuery(() => [
      {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        api_error_status: 429,
        errors: ['Quota reached'],
      },
    ]);
    queryMock.mockReturnValueOnce(query).mockReturnValueOnce(successfulQuery());
    const waitForQuotaRecovery = jest.fn(() => Promise.resolve());
    const runner = createClaudeDelegationRunner({
      available: () => Promise.resolve({ available: true }),
      prepare: () =>
        Promise.resolve({
          model: 'claude-test',
          environment: { PATH: '' },
          waitForQuotaRecovery,
          tools: {
            authorize: () => Promise.resolve(true),
            mode: 'auto',
            instructions: () => '',
          },
        }),
      reportError: jest.fn(),
    });
    let start: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    let finish: (event: AgentDelegationEvent['event']) => void = () =>
      undefined;
    const terminal = new Promise<AgentDelegationEvent['event']>((resolve) => {
      finish = resolve;
    });
    const handle = await runner.start(request, (event) => {
      if (event.event.type === 'started') start();
      if (event.event.type === 'terminal') finish(event.event);
      return Promise.resolve();
    });
    try {
      await started;
      await expect(
        runner.steer(handle, {
          delegationId: request.delegationId,
          runGeneration: request.runGeneration,
          attemptId,
          message: 'Keep the migration backwards compatible.',
        }),
      ).resolves.toMatchObject({ kind: 'accepted' });
      await expect(terminal).resolves.toMatchObject({ status: 'completed' });
      expect(waitForQuotaRecovery).toHaveBeenCalledTimes(1);
      expect(queryMock.mock.calls[1]?.[0]?.prompt).toContain(
        'Keep the migration backwards compatible.',
      );
      expect(queryMock.mock.calls[1]?.[0]?.options).toMatchObject({
        resume: 'native-session',
      });
    } finally {
      await runner.close(handle);
    }
  });

  it('resumes the native session with a steer the SDK never started', async () => {
    const { query } = steeredQuery(() => []);
    queryMock.mockReturnValueOnce(query).mockReturnValueOnce(
      Object.assign(
        (async function* (): AsyncGenerator<Record<string, unknown>> {
          await Promise.resolve();
          yield result('Three answers.');
        })(),
        { close: jest.fn() },
      ),
    );

    await expect(steerAndFinish()).resolves.toMatchObject({
      type: 'terminal',
      status: 'completed',
      finalText: 'Three answers.',
    });
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(queryMock.mock.calls[1]?.[0]).toMatchObject({
      prompt: 'Make that three.',
      options: { resume: 'native-session' },
    });
  });
});

it('routes steering after the Claude result to an ordinary follow-up', async () => {
  async function* events(): AsyncGenerator<Record<string, unknown>> {
    await Promise.resolve();
    yield {
      type: 'system',
      subtype: 'init',
      session_id: 'native-session',
      capabilities: [
        'msg_lifecycle_v1',
        'interrupt_receipt_v1',
        'interrupt_cancel_queued_v1',
      ],
    };
    yield {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'done',
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  }
  const streamInput = jest.fn(() => Promise.reject(new Error('stdin closed')));
  queryMock.mockReturnValue(
    Object.assign(events(), {
      close: jest.fn(),
      cancelAsyncMessage: jest.fn(),
      interrupt: jest.fn(),
      streamInput,
    }),
  );
  const runner = createClaudeDelegationRunner({
    available: () => Promise.resolve({ available: true }),
    prepare: () =>
      Promise.resolve({
        model: 'claude-test',
        environment: { PATH: '' },
        tools: {
          authorize: () => Promise.resolve(true),
          mode: 'auto',
          instructions: () => '',
        },
      }),
    reportError: jest.fn(),
  });
  let resolveTerminal: () => void = () => undefined;
  const terminal = new Promise<void>((resolve) => {
    resolveTerminal = resolve;
  });
  const handle = await runner.start(request, (event) => {
    if (event.event.type === 'terminal') resolveTerminal();
    return Promise.resolve();
  });
  await terminal;
  const attemptId = '123e4567-e89b-42d3-a456-426614174001';
  await expect(
    runner.steer(handle, {
      delegationId: request.delegationId,
      runGeneration: request.runGeneration,
      attemptId,
      message: 'Follow up after completion.',
    }),
  ).resolves.toMatchObject({
    kind: 'rejected',
    attemptId,
    fallback: 'ordinary',
  });
  expect(streamInput).not.toHaveBeenCalled();
  await runner.close(handle);
});

it('rejects steering when the Claude SDK refuses the input stream', async () => {
  let finish: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  async function* events(): AsyncGenerator<Record<string, unknown>> {
    yield {
      type: 'system',
      subtype: 'init',
      session_id: 'native-session',
      capabilities: [
        'msg_lifecycle_v1',
        'interrupt_receipt_v1',
        'interrupt_cancel_queued_v1',
      ],
    };
    await finished;
    yield {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'done',
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  }
  queryMock.mockReturnValue(
    Object.assign(events(), {
      close: jest.fn(),
      cancelAsyncMessage: jest.fn(),
      interrupt: jest.fn(),
      streamInput: jest.fn(() => Promise.reject(new Error('stdin closed'))),
    }),
  );
  const runner = createClaudeDelegationRunner({
    available: () => Promise.resolve({ available: true }),
    prepare: () =>
      Promise.resolve({
        model: 'claude-test',
        environment: { PATH: '' },
        tools: {
          authorize: () => Promise.resolve(true),
          mode: 'auto',
          instructions: () => '',
        },
      }),
    reportError: jest.fn(),
  });
  let started: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const handle = await runner.start(request, (event) => {
    if (event.event.type === 'started') started();
    return Promise.resolve();
  });
  await ready;
  const attemptId = '123e4567-e89b-42d3-a456-426614174002';
  try {
    await expect(
      runner.steer(handle, {
        delegationId: request.delegationId,
        runGeneration: request.runGeneration,
        attemptId,
        message: 'Input after stdin closes.',
      }),
    ).resolves.toMatchObject({
      kind: 'rejected',
      attemptId,
      fallback: 'ordinary',
    });
  } finally {
    finish();
    await runner.close(handle);
  }
});

it('completes a run without capturing its workspace writes', async () => {
  async function* completedWithTranscript(): AsyncGenerator<
    Record<string, unknown>,
    void,
    void
  > {
    await Promise.resolve();
    yield {
      type: 'assistant',
      message: {
        id: 'assistant-1',
        content: [{ type: 'text', text: 'Retained transcript tail' }],
      },
    };
    yield {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'done',
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  }
  queryMock.mockReturnValue(
    Object.assign(completedWithTranscript(), { close: jest.fn() }),
  );
  const reportError = jest.fn();
  const runner = createClaudeDelegationRunner({
    available: () => Promise.resolve({ available: true }),
    prepare: () =>
      Promise.resolve({
        model: 'claude-test',
        environment: { PATH: '' },
        tools: {
          authorize: () => Promise.resolve(true),
          mode: 'auto' as const,
          flushWrites: () => Promise.reject(new Error('unrepresentable write')),
          instructions: () => '',
        },
      }),
    reportError,
  });
  const events: Array<{ type: string; status?: string }> = [];
  const terminal = new Promise<void>((resolve) => {
    void runner.start(
      {
        delegationId: 'delegation-2',
        runGeneration: 1,
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
          modelId: 'claude-test',
          description: 'Inspect code',
          prompt: 'Inspect the requested code.',
          executionMode: 'foreground',
          contextPolicy: 'task_only',
          isolation: 'shared_worktree',
        },
        route: {
          selectedModelId: 'claude-test',
          runtimeModelId: 'claude-test',
          harnessId: 'claude',
          runtimeKind: 'claude-sdk',
          runnerRegistrationId: 'claude-local',
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
        cwd: '/worktree',
        effectivePermission: 'read-only',
        signal: new AbortController().signal,
      },
      (event) => {
        events.push(event.event);
        if (event.event.type === 'terminal') resolve();
        return Promise.resolve();
      },
    );
  });
  await terminal;
  // Git and checkpoints track a delegate's edits; the run never fails
  // because a host-side copy of them could not be kept.
  expect(events.find((event) => event.type === 'terminal')).toMatchObject({
    type: 'terminal',
    status: 'completed',
  });
  expect(events).toContainEqual(
    expect.objectContaining({ type: 'transcript' }),
  );
  expect(reportError).not.toHaveBeenCalled();
});

it('stops the native Claude turn when transcript retention exceeds its budget', async () => {
  async function* oversizedTranscript(): AsyncGenerator<
    Record<string, unknown>,
    void,
    void
  > {
    await Promise.resolve();
    yield {
      type: 'assistant',
      message: {
        id: 'assistant-oversized',
        content: [
          {
            type: 'text',
            text: 'x'.repeat(
              DELEGATION_TRANSCRIPT_RECORDER_LIMITS.itemBytes + 1,
            ),
          },
        ],
      },
    };
    yield {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'must not complete',
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  }
  const close = jest.fn();
  queryMock.mockReturnValue(Object.assign(oversizedTranscript(), { close }));
  const reportError = jest.fn();
  const runner = createClaudeDelegationRunner({
    available: () => Promise.resolve({ available: true }),
    prepare: () =>
      Promise.resolve({
        model: 'claude-test',
        environment: { PATH: '' },
        tools: {
          authorize: () => Promise.resolve(true),
          mode: 'auto' as const,
          instructions: () => '',
        },
      }),
    reportError,
  });
  const events: Array<{ type: string; status?: string }> = [];
  await new Promise<void>((resolve) => {
    void runner.start(
      {
        delegationId: 'delegation-overflow',
        runGeneration: 1,
        launchKey: 'launch-overflow',
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
          modelId: 'claude-test',
          description: 'Inspect code',
          prompt: 'Inspect the requested code.',
          executionMode: 'foreground',
          contextPolicy: 'task_only',
          isolation: 'shared_worktree',
        },
        route: {
          selectedModelId: 'claude-test',
          runtimeModelId: 'claude-test',
          harnessId: 'claude',
          runtimeKind: 'claude-sdk',
          runnerRegistrationId: 'claude-local',
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
        cwd: '/worktree',
        effectivePermission: 'read-only',
        signal: new AbortController().signal,
      },
      (event) => {
        events.push(event.event);
        if (event.event.type === 'terminal') resolve();
        return Promise.resolve();
      },
    );
  });

  expect(close).toHaveBeenCalled();
  expect(events.find((event) => event.type === 'terminal')).toMatchObject({
    type: 'terminal',
    status: 'failed',
  });
  expect(reportError).toHaveBeenCalledWith(
    expect.objectContaining({
      message:
        'Delegated transcript exceeded the safe retention budget. The native turn was stopped.',
    }),
  );
});

describe('provider-gated MCP servers', () => {
  it('gates a provider-selected server through one shared decision per tool-use id in the hook and canUseTool, honouring both an allow and a deny decision', async () => {
    queryMock.mockReturnValue(successfulQuery());
    const authorizeMcpToolUse = jest.fn(
      (server: string, tool: string): Promise<boolean> =>
        Promise.resolve(server === 'gated_review' && tool === 'allowed_tool'),
    );
    const authorizeMcp = jest.fn(() => Promise.resolve(true));
    const runner = createClaudeDelegationRunner({
      available: () => Promise.resolve({ available: true }),
      prepare: () =>
        Promise.resolve({
          model: 'claude-test',
          environment: { PATH: '' },
          providerGatedMcpServers: ['gated_review'],
          mcpServers: {
            gated_review: {
              type: 'http',
              url: 'http://127.0.0.1:1234/gated',
            },
          },
          tools: {
            authorize: () => Promise.resolve(true),
            authorizeMcp,
            authorizeMcpToolUse,
            mode: 'auto',
            instructions: () => '',
          },
        }),
      reportError: jest.fn(),
    });
    const terminal = new Promise<void>((resolve) => {
      void runner.start(request, (event) => {
        if (event.event.type === 'terminal') resolve();
        return Promise.resolve();
      });
    });
    await terminal;
    const queryCall: unknown = queryMock.mock.calls[0]?.[0];
    if (!hasSelectedMcpHookOptions(queryCall))
      throw new Error('Missing provider-gated MCP hooks');
    const hook = queryCall.options.hooks.PreToolUse[0]?.hooks[0];

    await expect(
      hook?.(
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'mcp__gated_review__allowed_tool',
          tool_input: { id: 1 },
        },
        'gated-call-allow',
      ),
    ).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: 'allow' },
    });
    await expect(
      queryCall.options.canUseTool(
        'mcp__gated_review__allowed_tool',
        { id: 1 },
        { toolUseID: 'gated-call-allow' },
      ),
    ).resolves.toMatchObject({ behavior: 'allow' });
    expect(authorizeMcpToolUse).toHaveBeenNthCalledWith(
      1,
      'gated_review',
      'allowed_tool',
      { id: 1 },
      'gated-call-allow',
    );
    expect(authorizeMcpToolUse).toHaveBeenNthCalledWith(
      2,
      'gated_review',
      'allowed_tool',
      { id: 1 },
      'gated-call-allow',
    );

    const hookDenial = await hook?.(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'mcp__gated_review__denied_tool',
        tool_input: { id: 2 },
      },
      'gated-call-deny',
    );
    expect(hookDenial).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    expect(
      hookDenial &&
        typeof hookDenial === 'object' &&
        'hookSpecificOutput' in hookDenial
        ? hookDenial.hookSpecificOutput
        : undefined,
    ).toHaveProperty(
      'permissionDecisionReason',
      'Delegated task permissions and parent approval policy',
    );
    const canUseToolDenial = await queryCall.options.canUseTool(
      'mcp__gated_review__denied_tool',
      { id: 2 },
      { toolUseID: 'gated-call-deny' },
    );
    expect(canUseToolDenial).toMatchObject({ behavior: 'deny' });
    expect(JSON.stringify(canUseToolDenial)).toContain(
      'This tool is unavailable under the delegated task permissions.',
    );
    expect(authorizeMcpToolUse).toHaveBeenNthCalledWith(
      3,
      'gated_review',
      'denied_tool',
      { id: 2 },
      'gated-call-deny',
    );
    expect(authorizeMcpToolUse).toHaveBeenNthCalledWith(
      4,
      'gated_review',
      'denied_tool',
      { id: 2 },
      'gated-call-deny',
    );
    expect(authorizeMcpToolUse).toHaveBeenCalledTimes(4);
    expect(authorizeMcp).not.toHaveBeenCalled();

    // A hook call without a tool-use id has no canUseTool check to pair with,
    // so it is decided on its own rather than shared under a placeholder.
    await expect(
      hook?.({
        hook_event_name: 'PreToolUse',
        tool_name: 'mcp__gated_review__allowed_tool',
        tool_input: { id: 3 },
      }),
    ).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: 'allow' },
    });
    expect(authorizeMcp).toHaveBeenCalledWith(
      'gated_review',
      'allowed_tool',
      { id: 3 },
      'native',
    );
    expect(authorizeMcpToolUse).toHaveBeenCalledTimes(4);
  });

  it('keeps a transport-gated MCP server on the existing allow path and never calls authorizeMcp', async () => {
    queryMock.mockReturnValue(successfulQuery());
    const authorizeMcp = jest.fn(() => Promise.resolve(false));
    const runner = createClaudeDelegationRunner({
      available: () => Promise.resolve({ available: true }),
      prepare: () =>
        Promise.resolve({
          model: 'claude-test',
          environment: { PATH: '' },
          // Not listed in providerGatedMcpServers: the host transport (HTTP
          // proxy / stdio broker) is this server's single gate.
          mcpServers: {
            transport_review: {
              type: 'http',
              url: 'http://127.0.0.1:1234/transport',
            },
          },
          tools: {
            authorize: () => Promise.resolve(true),
            authorizeMcp,
            authorizeMcpToolUse: authorizeMcp,
            mode: 'auto',
            instructions: () => '',
          },
        }),
      reportError: jest.fn(),
    });
    const terminal = new Promise<void>((resolve) => {
      void runner.start(request, (event) => {
        if (event.event.type === 'terminal') resolve();
        return Promise.resolve();
      });
    });
    await terminal;
    const queryCall: unknown = queryMock.mock.calls[0]?.[0];
    if (!hasSelectedMcpHookOptions(queryCall))
      throw new Error('Missing transport-gated MCP hooks');
    const hook = queryCall.options.hooks.PreToolUse[0]?.hooks[0];
    await expect(
      hook?.(
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'mcp__transport_review__anything',
          tool_input: {},
        },
        'transport-call',
      ),
    ).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: 'allow' },
    });
    await expect(
      queryCall.options.canUseTool(
        'mcp__transport_review__anything',
        {},
        { toolUseID: 'transport-call' },
      ),
    ).resolves.toMatchObject({ behavior: 'allow' });
    expect(authorizeMcp).not.toHaveBeenCalled();
  });

  it('denies an ambiguous provider-gated server/tool split instead of guessing', async () => {
    queryMock.mockReturnValue(successfulQuery());
    const authorizeMcp = jest.fn(() => Promise.resolve(true));
    const runner = createClaudeDelegationRunner({
      available: () => Promise.resolve({ available: true }),
      prepare: () =>
        Promise.resolve({
          model: 'claude-test',
          environment: { PATH: '' },
          // "mcp__a__b__toolX" could be server "a" + tool "b__toolX", or
          // server "a__b" + tool "toolX" — both are gated here.
          providerGatedMcpServers: ['a', 'a__b'],
          mcpServers: {
            a: { type: 'http', url: 'http://127.0.0.1:1234/a' },
            a__b: { type: 'http', url: 'http://127.0.0.1:1234/a-b' },
          },
          tools: {
            authorize: () => Promise.resolve(true),
            authorizeMcp,
            authorizeMcpToolUse: authorizeMcp,
            mode: 'auto',
            instructions: () => '',
          },
        }),
      reportError: jest.fn(),
    });
    const terminal = new Promise<void>((resolve) => {
      void runner.start(request, (event) => {
        if (event.event.type === 'terminal') resolve();
        return Promise.resolve();
      });
    });
    await terminal;
    const queryCall: unknown = queryMock.mock.calls[0]?.[0];
    if (!hasSelectedMcpHookOptions(queryCall))
      throw new Error('Missing ambiguous MCP hooks');
    const hook = queryCall.options.hooks.PreToolUse[0]?.hooks[0];
    const hookDenial = await hook?.(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'mcp__a__b__toolX',
        tool_input: {},
      },
      'ambiguous-call',
    );
    expect(hookDenial).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    expect(JSON.stringify(hookDenial)).toContain(
      'Ambiguous MCP server/tool identity',
    );
    await expect(
      queryCall.options.canUseTool(
        'mcp__a__b__toolX',
        {},
        { toolUseID: 'ambiguous-call' },
      ),
    ).resolves.toMatchObject({ behavior: 'deny' });
    expect(authorizeMcp).not.toHaveBeenCalled();
  });
});

describe('in-run capability reload', () => {
  it('reloads after a Load result whose in-process call id is not the provider tool_use id', async () => {
    const ref = `deferred:v1:${'a'.repeat(43)}`;
    const loadName = `mcp__${BRAND.tools.namespace}__LoadDeferredTools`;
    const loadTool = {
      key: 'load_deferred_tools' as const,
      name: 'LoadDeferredTools',
      codexName: `${BRAND.tools.namespace}_load_deferred_tools`,
      description: 'Load deferred tools.',
      inputSchema: { type: 'object', properties: {} },
      readOnly: true,
    };
    const execute = jest.fn(() => Promise.resolve({ text: 'loaded' }));
    const controller = new DelegationCapabilityReloadController();
    const preparation = (): ClaudeDelegationPreparation => ({
      model: 'claude-test',
      environment: { PATH: '' },
      appTools: {
        tools: [loadTool],
        isolated: false,
        toolForClaudeName: (name: string) =>
          name === loadName ? loadTool : undefined,
        toolForCodexName: () => undefined,
        authorize: () => Promise.resolve(true),
        run: execute,
        execute,
      },
      tools: {
        authorize: () => Promise.resolve(true),
        mode: 'auto',
        instructions: () => '',
      },
    });
    const apply = jest.fn(() => Promise.resolve(preparation()));
    const restore = jest.fn(() => Promise.reject(new Error('unused')));
    const interrupt = jest.fn(() => Promise.resolve());

    async function* loadingTurn(): AsyncGenerator<Record<string, unknown>> {
      await Promise.resolve();
      yield { type: 'system', subtype: 'init', session_id: 'session-1' };
      yield {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'toolu_load', name: loadName, input: {} },
          ],
        },
      };
      // The in-process tool handler records the reload under its own call id;
      // it never sees the provider's tool_use id.
      expect(
        controller.request({
          toolCallId: 'in-process-call',
          refs: [ref],
          additions: { skillRefs: [], pluginRefs: [], mcpServerRefs: [] },
          enabledResources: [{ ref, kind: 'skill', name: 'Review' }],
        }).accepted,
      ).toBe(true);
      yield {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_load',
              content: '{"status":"success"}',
            },
          ],
        },
      };
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'before reload',
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    }
    async function* resumedTurn(): AsyncGenerator<Record<string, unknown>> {
      await Promise.resolve();
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'after reload',
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    }
    queryMock
      .mockReturnValueOnce(
        Object.assign(loadingTurn(), { close: jest.fn(), interrupt }),
      )
      .mockReturnValueOnce(
        Object.assign(resumedTurn(), { close: jest.fn(), interrupt }),
      );
    const runner = createClaudeDelegationRunner({
      available: () => Promise.resolve({ available: true }),
      prepare: () =>
        Promise.resolve({
          ...preparation(),
          capabilityReload: { controller, host: { apply, restore } },
        }),
      reportError: jest.fn(),
    });
    const terminals: unknown[] = [];
    const terminal = new Promise<void>((resolve) => {
      void runner.start(request, (event) => {
        if (event.event.type === 'terminal') {
          terminals.push(event.event);
          resolve();
        }
        return Promise.resolve();
      });
    });
    await terminal;

    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(restore).not.toHaveBeenCalled();
    expect(queryMock).toHaveBeenCalledTimes(2);
    const resumed: unknown = queryMock.mock.calls[1]?.[0];
    expect(resumed).toMatchObject({
      prompt: DEFERRED_TOOLS_RELOAD_CONTINUATION_TEMPLATE,
      options: { resume: 'session-1' },
    });
    expect(terminals).toEqual([
      expect.objectContaining({
        status: 'completed',
        finalText: 'after reload',
      }),
    ]);
    expect(controller.pending).toBeUndefined();
  });
});

describe('Agent Ledger tools for a delegated Claude run', () => {
  function leafParent(): DelegationParent {
    const snapshot: AgentDelegationSnapshot = {
      delegationId: 'grandchild',
      status: 'pending',
      outputTruncated: false,
    };
    const broker: DelegationParentBroker = {
      spawn: () => Promise.resolve({ ok: true, value: snapshot }),
      watch: () =>
        Promise.resolve({
          ok: true,
          value: {
            watcherId: 'watcher',
            mode: 'any',
            deadlineAt: 1,
            targets: [],
          },
        }),
      getOutput: () => ({
        ok: true,
        value: {
          delegationId: 'grandchild',
          currentRunGeneration: 1,
          currentStatus: 'pending',
          latestResultIndex: null,
          result: null,
        },
      }),
      inspect: () => undefined,
      list: () => [],
      stop: () => ({ ok: true, value: snapshot }),
      closeOwner: () => Promise.resolve(),
    };
    return new DelegationParent({
      owner: {
        harnessId: 'claude',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        sessionKey: 'session',
        runtimeGeneration: 1,
        depth: 1,
        parentDelegationId: 'delegation-1',
        parentRunGeneration: 1,
      },
      harness: 'claude',
      namespace: 'canopy',
      names: {
        spawn: 'DelegateTask',
        inspect: 'InspectDelegate',
        list: 'ListDelegates',
        watch: 'WatchDelegates',
        output: 'GetDelegateOutput',
        stop: 'StopDelegate',
        requestSteering: 'RequestSteering',
      },
      broker,
      currentTurn: () => 'owned-turn',
      removeQueued: () => Promise.resolve(),
      reportError: jest.fn(),
      enableDelegationTools: false,
      requestSteering: () => Promise.resolve({ ok: true, value: {} }),
    });
  }

  const authorizeAppTool = jest.fn<
    Promise<boolean>,
    [string, string, boolean, string, AbortSignal?]
  >(() => Promise.resolve(false));

  async function runToTerminal(
    ledger: () => Promise<ChildLedgerTools | undefined>,
    delegation: DelegationParent = leafParent(),
  ): Promise<{
    queryCall: unknown;
    terminal: AgentDelegationEvent['event'];
    reported: readonly unknown[];
    close: () => Promise<void>;
  }> {
    authorizeAppTool.mockClear();
    queryMock.mockReturnValue(successfulQuery());
    jest.mocked(mockedSdkTool).mockClear();
    const reported: unknown[] = [];
    const runner = createClaudeDelegationRunner({
      available: () => Promise.resolve({ available: true }),
      prepare: () =>
        Promise.resolve({
          model: 'claude-test',
          environment: { PATH: '' },
          tools: {
            authorize: () => Promise.resolve(false),
            authorizeAppTool,
            mode: 'auto',
            flushWrites: () => Promise.resolve(),
            instructions: () => 'Read-only instructions',
          },
        }),
      reportError: (error) => {
        reported.push(error);
        reportDelegationError(error);
      },
      delegation: () => delegation,
      ledger,
    });
    let handle: NativeRunHandle | undefined;
    const terminal = await new Promise<AgentDelegationEvent['event']>(
      (resolve) => {
        void runner
          .start(request, (event) => {
            if (event.event.type === 'terminal') resolve(event.event);
            return Promise.resolve();
          })
          .then((started) => {
            handle = started;
          });
      },
    );
    const queryCall: unknown = queryMock.mock.calls[0]?.[0];
    return {
      queryCall,
      terminal,
      reported,
      close: () =>
        handle ? runner.close(handle) : Promise.reject(new Error('No run')),
    };
  }

  it('serves the Ledger tools to a run that has them, and revokes them when the run ends', async () => {
    const ledger = {
      execute: jest.fn(),
      systemPrompt: (): string => 'Delegate Ledger block',
      dispose: jest.fn(),
    };
    const ledgerHook = jest.fn(
      (): Promise<ChildLedgerTools> => Promise.resolve(ledger),
    );

    const { queryCall } = await runToTerminal(ledgerHook);

    expect(ledgerHook).toHaveBeenCalledTimes(1);
    expect(queryCall).toHaveProperty(
      'options.systemPrompt.prompt',
      expect.stringContaining('\nDelegate Ledger block'),
    );
    expect(queryCall).toHaveProperty('options.mcpServers.canopy');
    expect(jest.mocked(mockedSdkTool).mock.calls.map(([name]) => name)).toEqual(
      [
        'RequestSteering',
        'AddFeedEntry',
        'SearchFeedEntries',
        'UpdateFeedEntry',
      ],
    );
    if (!hasSelectedMcpHookOptions(queryCall))
      throw new Error('Missing child hooks');
    const hook = queryCall.options.hooks.PreToolUse[0]?.hooks[0];
    const input = { type: 'TASK', title: 'Review', content: 'Review it.' };
    await expect(
      hook?.(
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'mcp__canopy__AddFeedEntry',
          tool_input: input,
        },
        'toolu_ledger',
      ),
    ).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: 'allow' },
    });
    await expect(
      queryCall.options.canUseTool(
        'mcp__canopy__SearchFeedEntries',
        {},
        { toolUseID: 'toolu_search' },
      ),
    ).resolves.toMatchObject({ behavior: 'allow' });
    // Like app-owned tools, a Ledger call is approved when it runs, under
    // the parent chat's policy: a denial runs nothing.
    const add = jest
      .mocked(mockedSdkTool)
      .mock.calls.find(([name]) => name === 'AddFeedEntry');
    const handler = add?.[3];
    if (handler === undefined) throw new Error('Missing handler');
    await expect(
      handler(input, { _meta: { 'claudecode/toolUseId': 'toolu_ledger' } }),
    ).resolves.toMatchObject({ isError: true });
    expect(authorizeAppTool).toHaveBeenCalledWith(
      'canopy',
      'AddFeedEntry',
      false,
      'toolu_ledger',
      undefined,
    );
    expect(ledger.execute).not.toHaveBeenCalled();
    expect(ledger.dispose).toHaveBeenCalledTimes(1);
  });

  it('leaves the child as it was when the Ledger is not exposed to its run', async () => {
    const { queryCall } = await runToTerminal(() => Promise.resolve(undefined));

    expect(JSON.stringify(queryCall)).not.toContain('Ledger');
    expect(JSON.stringify(queryCall)).not.toContain('Feed');
    expect(jest.mocked(mockedSdkTool).mock.calls.map(([name]) => name)).toEqual(
      ['RequestSteering'],
    );
    if (!hasSelectedMcpHookOptions(queryCall))
      throw new Error('Missing child hooks');
    await expect(
      queryCall.options.canUseTool(
        'mcp__canopy__AddFeedEntry',
        {},
        { toolUseID: 'toolu_unexposed' },
      ),
    ).resolves.toMatchObject({ behavior: 'deny' });
  });

  it('reports a failed detach and Ledger disposal under their parent resources', async () => {
    const C = CLEANUP_CANARY;
    const warn = jest.mocked(logMainProcessWarn);
    warn.mockClear();
    const delegation = leafParent();
    const detach = jest
      .spyOn(delegation, 'detach')
      .mockImplementationOnce(() => {
        throw Object.assign(new Error(`session:delegated:sk-ant-${C}`), {
          code: 'ERR_DETACHED',
        });
      });
    const ledger = {
      execute: jest.fn(),
      systemPrompt: (): string => 'Delegate Ledger block',
      dispose: jest.fn<void, []>().mockImplementationOnce(() => {
        // eslint-disable-next-line no-throw-literal, @typescript-eslint/only-throw-error
        throw `/Users/someone/sk-ant-${C}`;
      }),
    };

    const { terminal, reported, close } = await runToTerminal(
      () => Promise.resolve(ledger),
      delegation,
    );

    expect(terminal).toEqual({
      type: 'terminal',
      status: 'failed',
      finalText: 'done',
      usage: { inputTokens: 1, outputTokens: 1 },
      error: {
        code: 'launch_uncertain',
        message: 'Delegated runner cleanup could not be confirmed.',
        retryable: false,
      },
    });
    // `ERR_DETACHED` is not a listed code, so it logs as `other`.
    const failures = [
      failure(resource.detach, 'threw', errorFields('Error', 'other')),
      failure(resource.ledger, 'threw', { valueType: 'string' }),
    ];
    expect(reportedCleanupDiagnostics(reported)).toEqual([
      expect.objectContaining({ attempt: 1, retained: 2, failures }),
    ]);
    expect(cleanupRecords(warn)).toEqual([cleanupRecord({ failures })]);
    await expect(close()).resolves.toBeUndefined();
    expect(cleanupRecords(warn)).toHaveLength(1);
    expect(detach).toHaveBeenCalledTimes(2);
    expect(ledger.dispose).toHaveBeenCalledTimes(2);
  });
});

it('continues the retained proxy session after a quota reset inside one delegated run', async () => {
  function* limited(): Generator<Record<string, unknown>> {
    yield { type: 'system', subtype: 'init', session_id: 'proxy-session' };
    yield {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      api_error_status: 429,
      errors: ['Quota reached'],
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 0 },
    };
  }
  queryMock.mockReset();
  queryMock
    .mockReturnValueOnce(Object.assign(limited(), { close: jest.fn() }))
    .mockReturnValueOnce(successfulQuery());
  const waitForQuotaRecovery = jest.fn(() => Promise.resolve());
  const runner = createClaudeDelegationRunner({
    available: () => Promise.resolve({ available: true }),
    prepare: () =>
      Promise.resolve({
        model: 'claude-test',
        environment: { PATH: '' },
        waitForQuotaRecovery,
        tools: {
          authorize: () => Promise.resolve(true),
          mode: 'auto',
          instructions: () => 'Read-only instructions',
        },
      }),
    reportError: jest.fn(),
  });
  const events: AgentDelegationEvent['event'][] = [];
  const terminal = new Promise<AgentDelegationEvent['event']>((resolve) => {
    void runner.start(request, (event) => {
      events.push(event.event);
      if (event.event.type === 'terminal') resolve(event.event);
      return Promise.resolve();
    });
  });
  await expect(terminal).resolves.toMatchObject({ status: 'completed' });
  expect(waitForQuotaRecovery).toHaveBeenCalledTimes(1);
  expect(queryMock.mock.calls[1][0]).toMatchObject({
    options: { resume: 'proxy-session' },
  });
  expect(events.filter((event) => event.type === 'terminal')).toHaveLength(1);
});

describe('local cleanup failure diagnostics', () => {
  const C = CLEANUP_CANARY;
  const warn = jest.mocked(logMainProcessWarn);
  const terminalCleanupFailure = {
    type: 'terminal',
    status: 'failed',
    finalText: 'done',
    usage: { inputTokens: 1, outputTokens: 1 },
    error: {
      code: 'launch_uncertain',
      message: 'Delegated runner cleanup could not be confirmed.',
      retryable: false,
    },
  };

  beforeEach(() => {
    warn.mockClear();
    queryMock.mockImplementation(() => successfulQuery());
  });
  afterEach(() => {
    queryMock.mockReset();
  });

  function fsError(code: string): Error {
    const path = `/Users/someone/.canopy/${C}`;
    const error = new Error(`${code}: rmdir '${path}'`);
    return Object.assign(error, { code, path, cause: new Error(C) });
  }
  const enotempty = errorFields('Error', 'ENOTEMPTY');

  /** Rejects with each value once, then resolves. */
  function failing(...values: unknown[]): jest.Mock<Promise<void>, []> {
    const close = jest.fn<Promise<void>, []>();
    for (const value of values) close.mockRejectedValueOnce(value);
    return close.mockResolvedValue(undefined);
  }

  function cleanupRunner(
    retain: (context: LocalDelegationContext) => void,
  ): LocalDelegationRunner {
    return createClaudeDelegationRunner({
      available: () => Promise.resolve({ available: true }),
      prepare: (context) => {
        retain(context);
        return Promise.resolve({
          model: 'claude-test',
          environment: { PATH: '' },
          tools: {
            authorize: () => Promise.resolve(true),
            mode: 'auto',
            instructions: () => '',
          },
        });
      },
      reportError: reportDelegationError,
    });
  }

  async function launch(
    runner: LocalDelegationRunner,
    runRequest: AgentRunRequest = request,
  ): Promise<{ handle: NativeRunHandle; events: unknown[] }> {
    const events: unknown[] = [];
    const handle = await runner.start(runRequest, (event) => {
      events.push(event.event);
      return Promise.resolve();
    });
    return { handle, events };
  }

  it('reports every rejected cleanup once per attempt and retries only what failed', async () => {
    const approval = failing().mockImplementationOnce(() => {
      throw fsError('EPERM');
    });
    const background = failing(fsError('ENOTEMPTY'), fsError('ENOTEMPTY'));
    const overlay = failing(`sk-ant-${C}`);
    const mcp = failing({ mcpServers: { github: { env: { TOKEN: C } } } });
    const temporary = failing();
    const runner = cleanupRunner((context) => {
      context.retain(approval, resource.approval);
      context.retain(background, resource.background);
      context.retain(overlay, resource.overlay);
      context.retain(mcp, resource.mcp);
      context.retain(temporary, resource.temporary);
    });
    const { handle, events } = await launch(runner);

    // Concurrent closes share one attempt and one report.
    const closing = [runner.close(handle), runner.close(handle)];
    const remainOpen = new Error('Local delegation resources remain open');
    await expect(closing[0]).rejects.toThrow(remainOpen);
    await expect(closing[1]).rejects.toThrow(remainOpen);
    await expect(runner.close(handle)).resolves.toBeUndefined();
    await expect(runner.close(handle)).resolves.toBeUndefined();

    expect(events).toContainEqual(terminalCleanupFailure);
    const retried = [failure(resource.background, 'rejected', enotempty)];
    expect(cleanupRecords(warn)).toEqual([
      cleanupRecord({
        failures: [
          failure(resource.approval, 'threw', errorFields('Error', 'EPERM')),
          ...retried,
          failure(resource.overlay, 'rejected', { valueType: 'string' }),
          failure(resource.mcp, 'rejected', { valueType: 'object' }),
        ],
      }),
      cleanupRecord({ attempt: 2, failures: retried }),
    ]);
    const [first, second] = await Promise.all(
      closing.map((close) => close.catch((error: unknown) => error)),
    );
    expect(second).toBe(first);
    expect(first).toBeInstanceOf(LocalDelegationCleanupError);
    expect(first).toHaveProperty('diagnostic.failures', retried);
    const calls = [approval, background, overlay, mcp, temporary].map(
      (close) => close.mock.calls.length,
    );
    expect(calls).toEqual([2, 3, 2, 2, 1]);
  });

  it('bounds the record and never copies a rejected value, identity or resource', async () => {
    const max = Number.MAX_SAFE_INTEGER;
    const resources: readonly (LocalDelegationCleanupResource | undefined)[] = [
      ...Object.values(resource).map((entry) =>
        'preparation' in entry ? { ...entry, preparation: max } : entry,
      ),
      undefined,
    ];
    const throwing = (): never => {
      throw new Error(C);
    };
    const values: readonly (readonly [unknown, Record<string, string>])[] = [
      [
        Object.assign(new Error(C), {
          name: C,
          code: C,
          path: `/tmp/${C}`,
          cause: new Error(C),
        }),
        errorFields('other', 'other'),
      ],
      [
        Object.assign(new TypeError(C), { code: 'ENOTEMPTY' }),
        errorFields('TypeError', 'ENOTEMPTY'),
      ],
      [
        Object.defineProperty(new Error(C), 'name', { get: throwing }),
        { valueType: 'unreadable' },
      ],
      [new Proxy(new Error(C), { get: throwing }), { valueType: 'unreadable' }],
      [
        Object.assign(new Error(C), { code: 20 }),
        errorFields('Error', 'other'),
      ],
      [new AggregateError([new Error(C)], C), errorFields('AggregateError')],
      [C, { valueType: 'string' }],
      [{ toJSON: () => C, toString: () => C }, { valueType: 'object' }],
      [Symbol(C), { valueType: 'symbol' }],
      [null, { valueType: 'null' }],
    ];
    const hostile: LocalDelegationCleanupResource = {
      ...resource.native,
      preparation: 1.5,
    };
    Reflect.set(hostile, 'label', C);
    Reflect.set(hostile, 'phase', C);
    const expected = Array.from({ length: 20 }, (_, index) =>
      failure(
        resources[index % resources.length],
        'rejected',
        values[index % values.length]?.[1],
      ),
    );
    expected.push({
      label: 'other',
      phase: 'other',
      preparation: -1,
      settlement: 'rejected',
      ...errorFields('other', 'other'),
    });
    const runner = new LocalDelegationRunner(
      C,
      C,
      () => Promise.resolve({ available: true }),
      (context) => {
        for (let index = 0; index < 20; index += 1)
          context.retain(
            jest
              .fn<Promise<void>, []>()
              .mockRejectedValue(values[index % values.length]?.[0]),
            resources[index % resources.length],
          );
        const close = jest.fn<Promise<void>, []>();
        context.retain(close.mockRejectedValue(values[0]?.[0]), hostile);
        return Promise.resolve({ status: 'completed', finalText: C });
      },
      reportDelegationError,
    );
    const { handle } = await launch(runner, {
      ...request,
      delegationId: C,
      runGeneration: max,
    });
    const thrown: unknown = await runner
      .close(handle)
      .catch((rejected: unknown) => rejected);

    // Both canary checks run before any structural assertion.
    expect(inspect(thrown, { depth: null, showHidden: true })).not.toContain(C);
    const records = cleanupRecords(warn);
    expect(thrown).toBeInstanceOf(LocalDelegationCleanupError);
    expect(thrown).toHaveProperty('diagnostic.failures.length', 21);
    expect(thrown).toHaveProperty('diagnostic.failures', expected);
    const record = cleanupRecord({
      harnessId: 'other',
      runtimeKind: 'other',
      runGeneration: max,
      retained: 21,
      failureCount: 21,
      omittedFailures: 9,
      labels: {
        'approval-session': 3,
        'background-task-dir': 3,
        'capability-overlay': 2,
        'claude-temp-dir': 2,
        'delegation-detach': 2,
        'ledger-tools': 2,
        'mcp-session': 2,
        'native-process': 2,
        unlabelled: 2,
        other: 1,
      },
      failures: expected.slice(0, 12),
    });
    expect(records).toEqual([record, { ...record, attempt: 2 }]);
  });

  it('keeps simultaneous delegates in separate records', async () => {
    const first = '0f8fad5b-d9cb-469f-a165-70867728950e';
    const second = '7C9E6679-7425-40DE-944B-E07FC1F90AE7';
    let open = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const started = new Set<string>();
    const runner = cleanupRunner((context) => {
      const { delegationId } = context.request;
      const close = failing().mockImplementationOnce(async () => {
        started.add(delegationId);
        await gate;
        throw fsError('ENOTEMPTY');
      });
      context.retain(
        close,
        delegationId === first ? resource.background : resource.temporary,
      );
    });
    const runs = await Promise.all(
      [first, second].map((id) =>
        launch(runner, { ...request, delegationId: id }),
      ),
    );
    while (started.size < 2)
      await new Promise<void>((resolve) => setImmediate(resolve));
    open();
    for (const { handle, events } of runs) {
      await runner.close(handle);
      expect(events).toContainEqual(terminalCleanupFailure);
    }

    const records = cleanupRecords(warn);
    expect(records).toHaveLength(2);
    expect(records).toEqual(
      expect.arrayContaining([
        cleanupRecord({
          delegationId: first,
          failures: [failure(resource.background, 'rejected', enotempty)],
        }),
        cleanupRecord({
          delegationId: second,
          failures: [failure(resource.temporary, 'rejected', enotempty)],
        }),
      ]),
    );
  });

  const isSpawn = (
    value: unknown,
  ): value is (options: SpawnOptions) => unknown => typeof value === 'function';
  function spawnOption(input: unknown): unknown {
    const options: unknown =
      typeof input === 'object' && input !== null
        ? Reflect.get(input, 'options')
        : undefined;
    return typeof options === 'object' && options !== null
      ? Reflect.get(options, 'spawnClaudeCodeProcess')
      : undefined;
  }

  it('reports a never-exiting native child at the cleanup bound with earlier rejections', async () => {
    let killed = (): void => undefined;
    const kill = new Promise<void>((resolve) => {
      killed = resolve;
    });
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      killed: false,
      exitCode: null,
      kill: jest.fn(() => {
        killed();
        return true;
      }),
    });
    jest.mocked(spawnClaudeCodeProcessOffMain).mockReturnValueOnce(child);
    const temporary = failing(fsError('ENOTEMPTY'));
    const runner = cleanupRunner((context) => {
      context.retain(temporary, resource.temporary);
    });
    queryMock.mockImplementation((input: unknown) => {
      const spawn = spawnOption(input);
      if (isSpawn(spawn))
        spawn({
          command: '/fake/claude',
          args: [],
          env: {},
          signal: new AbortController().signal,
        });
      return successfulQuery();
    });
    const { handle, events } = await launch(runner);
    // In-task cleanup killed the child and awaits an exit that never comes.
    await kill;

    jest.useFakeTimers({
      doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
    });
    try {
      const closing = runner.close(handle);
      const settled = jest.fn();
      void closing.then(settled, settled);
      await jest.advanceTimersByTimeAsync(14_999);
      expect(settled).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      await expect(closing).rejects.toThrow(
        new Error('Delegation cleanup timed out'),
      );
      const stopping = runner.stop(handle, 'deadline_exceeded');
      await jest.advanceTimersByTimeAsync(15_000);
      await expect(stopping).resolves.toEqual({
        stopped: false,
        error: {
          code: 'launch_uncertain',
          message: 'The delegated runner has not confirmed cancellation.',
          retryable: false,
        },
      });
    } finally {
      jest.useRealTimers();
    }
    const rejected = failure(resource.temporary, 'rejected', enotempty);
    const timeout = cleanupRecord({
      outcome: 'timeout',
      failures: [rejected, failure(resource.native, 'pending')],
    });
    expect(cleanupRecords(warn)).toEqual([timeout, timeout]);
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: 'terminal' }),
    );

    child.emit('exit', 0, null);
    await expect(runner.close(handle)).resolves.toBeUndefined();
    expect(events).toContainEqual(terminalCleanupFailure);
    const late = cleanupRecord({ failures: [rejected] });
    expect(cleanupRecords(warn)).toEqual([timeout, timeout, late]);
    expect(temporary).toHaveBeenCalledTimes(2);
  });
});
