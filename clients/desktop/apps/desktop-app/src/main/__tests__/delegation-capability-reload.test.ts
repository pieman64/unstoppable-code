import type * as LedgerModule from '../observability/claude-session-cost-ledger';
const queryMock = jest.fn<unknown, unknown[]>();
let mockClaudeSessionCostLedger: ClaudeSessionCostLedger | undefined;

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]): unknown => queryMock(...args),
  createSdkMcpServer: jest.fn(() => ({ type: 'sdk' })),
  tool: jest.fn((name: string) => ({ name })),
}));

jest.mock('../agents/claude-process-host-runner', () => ({
  spawnClaudeCodeProcessOffMain: jest.fn(),
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

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRunRequest } from '@canopy/desktop-shared/node/delegation';
import type { NativeRunHandle } from '@canopy/desktop-shared/node/delegation/types';
import { BRAND } from '@canopy/brand/current';
import { ClaudeSessionCostLedger } from '../observability/claude-session-cost-ledger';
import { DEFERRED_TOOLS_RELOAD_CONTINUATION_TEMPLATE } from '@canopy/desktop-shared/types';
import {
  createClaudeDelegationRunner,
  type ClaudeDelegationPreparation,
} from '../agents/delegation/claude-runner';
import type {
  DelegateCanopyTool,
  DelegateCanopyTools,
} from '../agents/delegation/canopy-tools';
import type { DelegationNativePolicy } from '../agents/delegation/native-policy';
import {
  DELEGATION_CAPABILITY_RELOADS_PER_RUN,
  DelegationCapabilityReloadController,
  DelegationCapabilityReloadFailure,
  delegationCapabilityReloadFailedContinuation,
  isDelegationCapabilityReloadContinuation,
  type DelegationCapabilityReloadHost,
  type DelegationCapabilityReloadRequest,
} from '../agents/delegation/capability-reload';

let ledgerTempDirectory: string | undefined;

beforeEach(async () => {
  queryMock.mockClear();
  ledgerTempDirectory = await mkdtemp(join(tmpdir(), 'claude-reload-cost-'));
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

// ---------------------------------------------------------------------------
// Pure DelegationCapabilityReloadController unit tests (no SDK involved).
// ---------------------------------------------------------------------------

function reloadRequest(toolCallId: string): DelegationCapabilityReloadRequest {
  return {
    toolCallId,
    refs: ['deferred:v1:skill:test'],
    additions: { skillRefs: [], pluginRefs: [], mcpServerRefs: [] },
    enabledResources: [
      { ref: 'deferred:v1:skill:test', kind: 'skill', name: 'Test Skill' },
    ],
  };
}

describe('DelegationCapabilityReloadController', () => {
  it('refuses a 4th reload in the same run generation with reload_limit', async () => {
    const controller = new DelegationCapabilityReloadController(
      DELEGATION_CAPABILITY_RELOADS_PER_RUN,
    );
    const host: DelegationCapabilityReloadHost<string> = {
      apply: () => Promise.resolve('prepared'),
      restore: () => Promise.resolve('restored'),
    };
    for (
      let index = 0;
      index < DELEGATION_CAPABILITY_RELOADS_PER_RUN;
      index++
    ) {
      const admission = controller.request(reloadRequest(`call-${index}`));
      expect(admission).toMatchObject({ accepted: true });
      controller.markDelivered(`call-${index}`);
      await controller.perform(host, new AbortController().signal);
    }
    expect(controller.count).toBe(DELEGATION_CAPABILITY_RELOADS_PER_RUN);
    expect(controller.request(reloadRequest('call-overflow'))).toMatchObject({
      accepted: false,
      code: 'reload_limit',
    });
  });

  it('refuses a second pending reload with reload_in_progress', () => {
    const controller = new DelegationCapabilityReloadController();
    expect(controller.request(reloadRequest('call-a'))).toMatchObject({
      accepted: true,
    });
    expect(controller.request(reloadRequest('call-b'))).toMatchObject({
      accepted: false,
      code: 'reload_in_progress',
    });
  });

  it('ignores markDelivered with a mismatched tool-call id', () => {
    const controller = new DelegationCapabilityReloadController();
    controller.request(reloadRequest('call-a'));
    expect(controller.markDelivered('call-wrong')).toBeUndefined();
    expect(controller.pending).toBeDefined();
    expect(controller.delivered).toBe(false);
    expect(controller.markDelivered('call-a')).toMatchObject({
      toolCallId: 'call-a',
    });
    expect(controller.delivered).toBe(true);
  });

  it('perform() loads: commits through host.apply and returns the fixed continuation', async () => {
    const controller = new DelegationCapabilityReloadController();
    controller.request(reloadRequest('call-a'));
    controller.markDelivered('call-a');
    const apply = jest.fn(() => Promise.resolve('new-prepared'));
    const restore = jest.fn(() => Promise.reject(new Error('unused')));
    const result = await controller.perform(
      { apply, restore },
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      status: 'loaded',
      prepared: 'new-prepared',
      continuation: DEFERRED_TOOLS_RELOAD_CONTINUATION_TEMPLATE,
    });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(restore).not.toHaveBeenCalled();
    expect(controller.pending).toBeUndefined();
  });

  it('perform() partially loads: the continuation names what could not be enabled', async () => {
    const controller = new DelegationCapabilityReloadController();
    controller.request(reloadRequest('call-a'));
    controller.markDelivered('call-a');
    const reason =
      'The skill "Missing skill" can\'t be given to this delegate: it is no longer installed.';
    const host: DelegationCapabilityReloadHost<string> = {
      apply: () => Promise.resolve('partial-prepared'),
      restore: () => Promise.reject(new Error('unused')),
      skipped: () => [reason],
    };
    const result = await controller.perform(host, new AbortController().signal);
    if (result.status !== 'loaded')
      throw new Error('Expected the reload to load the enabled items');
    expect(result.prepared).toBe('partial-prepared');
    expect(result.skipped).toEqual([reason]);
    // The child is not told every requested item is enabled.
    expect(result.continuation).not.toBe(
      DEFERRED_TOOLS_RELOAD_CONTINUATION_TEMPLATE,
    );
    expect(result.continuation).toContain(reason);
    expect(isDelegationCapabilityReloadContinuation(result.continuation)).toBe(
      true,
    );
  });

  it('perform() fails: restores the previous preparation and the continuation carries a safe, path-free reason', async () => {
    const controller = new DelegationCapabilityReloadController();
    controller.request(reloadRequest('call-a'));
    controller.markDelivered('call-a');
    const leakyPath = '/Users/secret-account/leaked-worktree';
    const apply = jest.fn(() =>
      Promise.reject(new Error(`${leakyPath} could not be staged`)),
    );
    const restore = jest.fn(() => Promise.resolve('restored-prepared'));
    const result = await controller.perform(
      { apply, restore },
      new AbortController().signal,
    );
    expect(result.status).toBe('failed');
    expect(result.prepared).toBe('restored-prepared');
    expect(restore).toHaveBeenCalledTimes(1);
    if (result.status !== 'failed')
      throw new Error('Expected a failed reload result');
    expect(result.message).not.toContain(leakyPath);
    expect(result.continuation).not.toContain(leakyPath);
    expect(isDelegationCapabilityReloadContinuation(result.continuation)).toBe(
      true,
    );
    expect(delegationCapabilityReloadFailedContinuation(result.message)).toBe(
      result.continuation,
    );
  });

  it('perform() fails with a DelegationCapabilityReloadFailure: its public message is used verbatim', async () => {
    const controller = new DelegationCapabilityReloadController();
    controller.request(reloadRequest('call-a'));
    controller.markDelivered('call-a');
    const apply = jest.fn(() =>
      Promise.reject(
        new DelegationCapabilityReloadFailure('Review MCP is unavailable.'),
      ),
    );
    const restore = jest.fn(() => Promise.resolve('restored-prepared'));
    const result = await controller.perform(
      { apply, restore },
      new AbortController().signal,
    );
    expect(result.status).toBe('failed');
    if (result.status !== 'failed')
      throw new Error('Expected a failed reload result');
    expect(result.message).toBe('Review MCP is unavailable.');
    expect(result.continuation).toContain('Review MCP is unavailable.');
  });

  it('perform() propagates an abort without calling restore', async () => {
    const controller = new DelegationCapabilityReloadController();
    controller.request(reloadRequest('call-a'));
    controller.markDelivered('call-a');
    const abortController = new AbortController();
    const apply = jest.fn(() => {
      abortController.abort();
      return Promise.reject(new Error('apply aborted mid-flight'));
    });
    const restore = jest.fn(() => Promise.resolve('restored-prepared'));
    await expect(
      controller.perform({ apply, restore }, abortController.signal),
    ).rejects.toThrow('apply aborted mid-flight');
    expect(restore).not.toHaveBeenCalled();
  });

  it('cancel() refuses further requests', () => {
    const controller = new DelegationCapabilityReloadController();
    controller.request(reloadRequest('call-a'));
    controller.markDelivered('call-a');
    controller.cancel();
    expect(controller.pending).toBeUndefined();
    expect(controller.request(reloadRequest('call-b'))).toMatchObject({
      accepted: false,
    });
  });

  it('discardUndelivered() drops only a reload whose result never reached the provider', () => {
    const controller = new DelegationCapabilityReloadController();
    controller.request(reloadRequest('call-a'));
    expect(controller.pending).toBeDefined();
    controller.discardUndelivered();
    expect(controller.pending).toBeUndefined();

    controller.request(reloadRequest('call-b'));
    controller.markDelivered('call-b');
    controller.discardUndelivered();
    expect(controller.pending).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Claude reload flow: mocked SDK, exercised through createClaudeDelegationRunner.
// ---------------------------------------------------------------------------

const request = {
  delegationId: 'delegation-reload',
  runGeneration: 1,
  launchKey: 'launch-reload',
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

const loadToolClaudeName = `mcp__${BRAND.tools.namespace}__LoadDeferredTools`;

function loadDeferredToolsFixture(): DelegateCanopyTools {
  const loadTool: DelegateCanopyTool = {
    key: 'load_deferred_tools',
    name: 'LoadDeferredTools',
    codexName: `${BRAND.tools.namespace}_load_deferred_tools`,
    description: 'Load deferred tools for this delegated task.',
    inputSchema: { type: 'object', properties: {} },
    readOnly: true,
  };
  return {
    tools: [loadTool],
    isolated: false,
    toolForClaudeName: (name: string) =>
      name === loadToolClaudeName ? loadTool : undefined,
    toolForCodexName: () => undefined,
    authorize: () => Promise.resolve(true),
    run: () => Promise.resolve({ text: 'Enabled.' }),
    execute: () => Promise.resolve({ text: 'Enabled.' }),
  };
}

function nativePolicyForReloadTest(): DelegationNativePolicy {
  const policy: Pick<
    DelegationNativePolicy,
    'authorize' | 'mode' | 'instructions'
  > = {
    authorize: () => Promise.resolve(true),
    mode: 'auto',
    instructions: () => '',
  };
  // Reload coverage only exercises these three native-policy members.
  return policy as DelegationNativePolicy;
}

type MockSegment = AsyncGenerator<Record<string, unknown>, void, void> & {
  close: jest.Mock;
  interrupt?: jest.Mock;
};

function withMockControls(
  generator: AsyncGenerator<Record<string, unknown>>,
  interrupt?: jest.Mock,
): MockSegment {
  return Object.assign(generator, {
    close: jest.fn(),
    ...(interrupt ? { interrupt } : {}),
  });
}

it('performs an in-run reload: exactly one terminal event, the resumed query carries resume + the new plugins/mcpServers + the fixed continuation, and no extra started event', async () => {
  const controller = new DelegationCapabilityReloadController();
  const appTools = loadDeferredToolsFixture();
  const initialPrepared: ClaudeDelegationPreparation = {
    model: 'claude-test',
    environment: { PATH: '' },
    appTools,
    capabilityReload: {
      controller,
      host: {
        apply: () => Promise.resolve(secondPrepared),
        restore: () => Promise.reject(new Error('restore must not run')),
      },
    },
    tools: nativePolicyForReloadTest(),
  };
  const secondPrepared: ClaudeDelegationPreparation = {
    model: 'claude-test',
    environment: { PATH: '' },
    plugins: [{ type: 'local', path: '/reloaded/plugin' }],
    mcpServers: {
      reloaded_server: {
        type: 'http',
        url: 'http://127.0.0.1:1234/reloaded',
      },
    },
    appTools,
    tools: nativePolicyForReloadTest(),
  };

  async function* segment1(): AsyncGenerator<Record<string, unknown>> {
    await Promise.resolve();
    yield {
      type: 'system',
      subtype: 'init',
      session_id: 'native-session',
      capabilities: [],
    };
    yield {
      type: 'assistant',
      message: {
        id: 'assistant-1',
        content: [
          {
            type: 'tool_use',
            id: 'load-call-1',
            name: loadToolClaudeName,
            input: { items: [{ ref: 'deferred:v1:skill:test' }] },
          },
        ],
      },
    };
    // Simulates the (separately-wired) Load executor recording a pending
    // reload as it produces this tool's result.
    controller.request({
      toolCallId: 'load-call-1',
      refs: ['deferred:v1:skill:test'],
      additions: {
        skillRefs: [{ sourceId: 'source', skillName: 'test' }],
        pluginRefs: [],
        mcpServerRefs: [],
      },
      enabledResources: [
        { ref: 'deferred:v1:skill:test', kind: 'skill', name: 'Test Skill' },
      ],
    });
    yield {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'load-call-1',
            content: [{ type: 'text', text: 'Enabled.' }],
            is_error: false,
          },
        ],
      },
    };
    // Per the SDK's own doc, the CLI emits exactly one result per turn, even
    // an interrupted one. The runner must suppress this as the outcome.
    yield {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'draft answer before the reload',
      session_id: 'native-session',
      total_cost_usd: 1,
      usage: { input_tokens: 5, output_tokens: 5 },
    };
  }
  async function* segment2(): AsyncGenerator<Record<string, unknown>> {
    await Promise.resolve();
    yield {
      type: 'system',
      subtype: 'init',
      session_id: 'native-session',
      capabilities: [],
    };
    yield {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'final answer after the reload',
      session_id: 'native-session',
      // The resumed query restores the session's running total of 1.
      total_cost_usd: 3,
      usage: { input_tokens: 3, output_tokens: 4 },
    };
  }
  const seg1 = withMockControls(
    segment1(),
    jest.fn(() => Promise.resolve(undefined)),
  );
  const seg2 = withMockControls(segment2());
  queryMock.mockReturnValueOnce(seg1).mockReturnValueOnce(seg2);

  const runner = createClaudeDelegationRunner({
    available: () => Promise.resolve({ available: true }),
    prepare: () => Promise.resolve(initialPrepared),
    reportError: jest.fn(),
  });
  const events: Array<{ type: string; [key: string]: unknown }> = [];
  const terminal = new Promise<void>((resolve) => {
    void runner.start(request, (event) => {
      events.push(event.event);
      if (event.event.type === 'terminal') resolve();
      return Promise.resolve();
    });
  });
  await terminal;

  const terminalEvents = events.filter((event) => event.type === 'terminal');
  expect(terminalEvents).toHaveLength(1);
  expect(terminalEvents[0]).toMatchObject({
    status: 'completed',
    finalText: 'final answer after the reload',
    usage: { inputTokens: 8, outputTokens: 9, costUsd: 3 },
  });
  expect(events.filter((event) => event.type === 'started')).toHaveLength(1);

  expect(queryMock).toHaveBeenCalledTimes(2);
  const secondCall: unknown = queryMock.mock.calls[1]?.[0];
  expect(secondCall).toMatchObject({
    prompt: DEFERRED_TOOLS_RELOAD_CONTINUATION_TEMPLATE,
    options: {
      resume: 'native-session',
      plugins: [{ type: 'local', path: '/reloaded/plugin' }],
      mcpServers: {
        reloaded_server: {
          type: 'http',
          url: 'http://127.0.0.1:1234/reloaded',
        },
      },
    },
  });
  expect(seg1.interrupt).toHaveBeenCalledTimes(1);
  expect(controller.count).toBe(1);
  expect(controller.pending).toBeUndefined();
});

it('continues without the failed capability when re-preparation fails, using restore and a failure continuation', async () => {
  const controller = new DelegationCapabilityReloadController();
  const appTools = loadDeferredToolsFixture();
  const restoredPrepared: ClaudeDelegationPreparation = {
    model: 'claude-test',
    environment: { PATH: '' },
    appTools,
    tools: nativePolicyForReloadTest(),
  };
  const restore = jest.fn(() => Promise.resolve(restoredPrepared));
  const initialPrepared: ClaudeDelegationPreparation = {
    model: 'claude-test',
    environment: { PATH: '' },
    appTools,
    capabilityReload: {
      controller,
      host: {
        apply: () =>
          Promise.reject(
            new DelegationCapabilityReloadFailure('Review MCP is unavailable.'),
          ),
        restore,
      },
    },
    tools: nativePolicyForReloadTest(),
  };

  async function* segment1(): AsyncGenerator<Record<string, unknown>> {
    await Promise.resolve();
    yield {
      type: 'system',
      subtype: 'init',
      session_id: 'native-session',
      capabilities: [],
    };
    yield {
      type: 'assistant',
      message: {
        id: 'assistant-1',
        content: [
          {
            type: 'tool_use',
            id: 'load-call-1',
            name: loadToolClaudeName,
            input: {},
          },
        ],
      },
    };
    controller.request({
      toolCallId: 'load-call-1',
      refs: ['deferred:v1:mcp:review'],
      additions: { skillRefs: [], pluginRefs: [], mcpServerRefs: [] },
      enabledResources: [
        { ref: 'deferred:v1:mcp:review', kind: 'mcp', name: 'Review MCP' },
      ],
    });
    yield {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'load-call-1',
            content: [{ type: 'text', text: 'Enabled.' }],
            is_error: false,
          },
        ],
      },
    };
  }
  async function* segment2(): AsyncGenerator<Record<string, unknown>> {
    await Promise.resolve();
    yield {
      type: 'system',
      subtype: 'init',
      session_id: 'native-session',
      capabilities: [],
    };
    yield {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'continued without the review MCP server',
      total_cost_usd: 1,
      usage: { input_tokens: 2, output_tokens: 2 },
    };
  }
  const seg1 = withMockControls(
    segment1(),
    jest.fn(() => Promise.resolve(undefined)),
  );
  const seg2 = withMockControls(segment2());
  queryMock.mockReturnValueOnce(seg1).mockReturnValueOnce(seg2);

  const runner = createClaudeDelegationRunner({
    available: () => Promise.resolve({ available: true }),
    prepare: () => Promise.resolve(initialPrepared),
    reportError: jest.fn(),
  });
  const events: Array<{ type: string; [key: string]: unknown }> = [];
  const terminal = new Promise<void>((resolve) => {
    void runner.start(request, (event) => {
      events.push(event.event);
      if (event.event.type === 'terminal') resolve();
      return Promise.resolve();
    });
  });
  await terminal;

  expect(restore).toHaveBeenCalledTimes(1);
  const secondCall: unknown = queryMock.mock.calls[1]?.[0];
  const continuation =
    secondCall !== null &&
    typeof secondCall === 'object' &&
    'prompt' in secondCall &&
    typeof secondCall.prompt === 'string'
      ? secondCall.prompt
      : '';
  expect(continuation).toContain('could not be enabled');
  expect(continuation).toContain('Review MCP is unavailable.');
  expect(isDelegationCapabilityReloadContinuation(continuation)).toBe(true);
  const terminalEvents = events.filter((event) => event.type === 'terminal');
  expect(terminalEvents).toHaveLength(1);
  expect(terminalEvents[0]).toMatchObject({
    status: 'completed',
    finalText: 'continued without the review MCP server',
  });
});

it('cancels cleanly when Stop arrives during perform(), and the controller is cancelled', async () => {
  const controller = new DelegationCapabilityReloadController();
  const appTools = loadDeferredToolsFixture();
  const restore = jest.fn(() =>
    Promise.reject(new Error('restore must not run')),
  );
  const handle: NativeRunHandle = { runId: 'delegation-reload-abort' };
  // `apply` below closes over `runner`, declared with `const` further down:
  // the closure only runs once `runner.start(...)` is under way, well after
  // this block-scoped binding is initialized.
  const initialPrepared: ClaudeDelegationPreparation = {
    model: 'claude-test',
    environment: { PATH: '' },
    appTools,
    capabilityReload: {
      controller,
      host: {
        apply: () => {
          // Synchronously aborts `context.signal` before `apply` settles,
          // simulating Stop arriving mid-reload.
          void runner.stop(handle, 'user_cancelled');
          return Promise.reject(new Error('apply aborted mid-flight'));
        },
        restore,
      },
    },
    tools: nativePolicyForReloadTest(),
  };

  async function* segment1(): AsyncGenerator<Record<string, unknown>> {
    await Promise.resolve();
    yield {
      type: 'system',
      subtype: 'init',
      session_id: 'native-session',
      capabilities: [],
    };
    yield {
      type: 'assistant',
      message: {
        id: 'assistant-1',
        content: [
          {
            type: 'tool_use',
            id: 'load-call-1',
            name: loadToolClaudeName,
            input: {},
          },
        ],
      },
    };
    controller.request({
      toolCallId: 'load-call-1',
      refs: ['deferred:v1:skill:test'],
      additions: { skillRefs: [], pluginRefs: [], mcpServerRefs: [] },
      enabledResources: [
        { ref: 'deferred:v1:skill:test', kind: 'skill', name: 'Test Skill' },
      ],
    });
    yield {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'load-call-1',
            content: [{ type: 'text', text: 'Enabled.' }],
            is_error: false,
          },
        ],
      },
    };
  }
  const seg1 = withMockControls(
    segment1(),
    jest.fn(() => Promise.resolve(undefined)),
  );
  queryMock.mockReturnValueOnce(seg1);

  const runner = createClaudeDelegationRunner({
    available: () => Promise.resolve({ available: true }),
    prepare: () => Promise.resolve(initialPrepared),
    reportError: jest.fn(),
  });
  const events: Array<{ type: string; [key: string]: unknown }> = [];
  const terminal = new Promise<void>((resolve) => {
    void runner.start(
      { ...request, delegationId: handle.runId, launchKey: 'launch-abort' },
      (event) => {
        events.push(event.event);
        if (event.event.type === 'terminal') resolve();
        return Promise.resolve();
      },
    );
  });
  await terminal;

  const terminalEvents = events.filter((event) => event.type === 'terminal');
  expect(terminalEvents).toHaveLength(1);
  expect(terminalEvents[0]).toMatchObject({ status: 'cancelled' });
  expect(restore).not.toHaveBeenCalled();
  expect(controller.pending).toBeUndefined();
  // cancel() closes the controller: a later request is refused.
  expect(
    controller.request({
      toolCallId: 'call-after-cancel',
      refs: [],
      additions: { skillRefs: [], pluginRefs: [], mcpServerRefs: [] },
      enabledResources: [],
    }),
  ).toMatchObject({ accepted: false });
});
