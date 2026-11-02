import { BRAND } from '@canopy/brand/current';
import type {
  LedgerContainer,
  LedgerGlobalOwner,
} from '@canopy/protocol/canopy-core';
import { CANOPY_INJECTED_TOOL_REGISTRY } from '@canopy/desktop-shared/lib/canopy-injected-tools';
import type { PipelineLedgerAttemptRequest } from '@canopy/desktop-shared/node/pipelines/executor/types';
import type {
  ApprovalSessionContext,
  ApprovalSessionHandle,
} from '../../approvals/approval-service';
import type { openLedgerPipelineAgentTools } from '../../canopy-tools/ledger-tools-runtime';
import { getLedgerPipelineAgentOwners } from '../../ledger/pipeline-agent-owners';
import type { CanopyWorktreeSessionRoute } from '../../mcp/http-proxy-service';
import {
  createDesktopPipelineLedgerPort,
  getPipelineLedgerAttemptTools,
  openPipelineLedgerCodexTools,
  pipelineLedgerClaudeToolNames,
  pipelineLedgerCodexTools,
} from '../pipeline-ledger';

const mockOpenPipelineAgentTools = jest.fn<
  Promise<unknown>,
  Parameters<typeof openLedgerPipelineAgentTools>
>();
const mockRegisterRoute = jest.fn<
  Promise<string>,
  [CanopyWorktreeSessionRoute]
>();
const mockUnregisterRoute = jest.fn<void, [string]>();
const mockCreateApprovalSession = jest.fn<
  Pick<ApprovalSessionHandle, 'check' | 'dispose'>,
  [ApprovalSessionContext]
>();

jest.mock('../../approvals/approval-service', () => ({
  createApprovalSession: (
    context: ApprovalSessionContext,
  ): Pick<ApprovalSessionHandle, 'check' | 'dispose'> =>
    mockCreateApprovalSession(context),
}));

jest.mock('../../canopy-tools/ledger-tools-runtime', () => ({
  openLedgerPipelineAgentTools: (
    ...args: Parameters<typeof openLedgerPipelineAgentTools>
  ): Promise<unknown> => mockOpenPipelineAgentTools(...args),
}));

const mockResolveGlobalScope = jest.fn<
  Promise<{ readonly containerCreatedAt: string }>,
  [LedgerGlobalOwner]
>();

jest.mock('../../ledger/core-ledger-adapter', () => ({
  resolveDesktopGlobalLedgerScope: (
    owner: LedgerGlobalOwner,
  ): Promise<{ readonly containerCreatedAt: string }> =>
    mockResolveGlobalScope(owner),
}));

jest.mock('../../mcp/http-proxy-service', () => ({
  getMcpHttpProxyService: (): unknown => ({
    registerCanopyWorktreeSessionRoute: (
      route: CanopyWorktreeSessionRoute,
    ): Promise<string> => mockRegisterRoute(route),
    unregisterCanopyWorktreeSessionRoute: (sessionKey: string): void =>
      mockUnregisterRoute(sessionKey),
    getCanopyWorktreeMcpUrl: (sessionKey: string): string =>
      `http://127.0.0.1:4545/canopy/mcp/worktree-session/${sessionKey}`,
  }),
}));

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const CONTAINER: LedgerContainer = {
  kind: 'code_worktree',
  workspaceId: 'workspace-1',
  worktreeId: 'worktree-1',
};

interface FakeSession {
  readonly scope: { container: LedgerContainer; containerCreatedAt: string };
  readonly systemPrompt: jest.Mock<string, []>;
  readonly execute: jest.Mock;
  readonly dispose: jest.Mock;
}

function fakeSession(): FakeSession {
  return {
    scope: { container: CONTAINER, containerCreatedAt: '2026-09-01T00:00:00Z' },
    systemPrompt: jest.fn(() => 'LEDGER BLOCK'),
    execute: jest.fn(() => Promise.resolve({ text: '{"ok":true}' })),
    dispose: jest.fn(),
  };
}

function request(
  overrides: Partial<PipelineLedgerAttemptRequest> = {},
): PipelineLedgerAttemptRequest {
  return {
    executionId: 'execution-1',
    pipelineName: 'Release',
    target: {
      kind: 'task',
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
    },
    projectId: 'workspace-1',
    worktreeId: 'worktree-1',
    physicalJobId: 'build__variant_1',
    logicalJobId: 'build',
    jobName: 'Build',
    stepId: 'implement',
    stepName: 'Implement',
    attempt: 1,
    iteration: 1,
    harness: 'claude',
    model: 'claude-sonnet',
    thinkingEffort: 'high',
    permissionPreset: 'read_only',
    ...overrides,
  };
}

const ORG_ID = '0b4f8a52-7c1d-4e8a-9f3b-2d6c1e5a7b90';

/**
 * An attempt of a run without a worktree, recording to its owner's global
 * Ledger: a directory run keeps its project, a global run has none.
 */
function globalRequest(
  owner: LedgerGlobalOwner,
  projectId?: string,
): PipelineLedgerAttemptRequest {
  const {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    projectId: _project,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    worktreeId: _worktree,
    ...rest
  } = request({ target: { kind: 'global', owner } });
  return projectId === undefined ? rest : { ...rest, projectId };
}

describe('desktop pipeline Ledger port', () => {
  const port = createDesktopPipelineLedgerPort();

  beforeEach(() => {
    jest.clearAllMocks();
    mockRegisterRoute.mockResolvedValue('registered');
    getLedgerPipelineAgentOwners().retireExecution('execution-1');
  });

  it('opens nothing when the Ledger is not exposed to the attempt', async () => {
    mockOpenPipelineAgentTools.mockResolvedValue(null);

    await expect(port.openAttempt(request())).resolves.toBeNull();
    expect(mockRegisterRoute).not.toHaveBeenCalled();
  });

  it('binds the attempt to its execution worktree and step', async () => {
    const session = fakeSession();
    mockOpenPipelineAgentTools.mockResolvedValue(session);

    const attempt = await port.openAttempt(
      request({
        attempt: 2,
        predecessorAgentSessionId: '22222222-2222-4222-8222-222222222222',
      }),
    );
    if (attempt === null) throw new Error('Expected an attempt');
    // The host mints the new attempt's session.
    expect(attempt.agentSessionId).toMatch(UUID);

    const [options] = mockOpenPipelineAgentTools.mock.calls[0] ?? [];
    if (options === undefined) throw new Error('Expected the gate to run');
    expect(options).toMatchObject({
      target: {
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'pipeline:execution-1',
      },
      harness: 'claude',
      pipelineAgent: {
        executionId: 'execution-1',
        physicalJobId: 'build__variant_1',
        logicalJobId: 'build',
        stepId: 'implement',
        attempt: 2,
        iteration: 1,
        agentSessionId: attempt.agentSessionId,
        predecessorAgentSessionId: '22222222-2222-4222-8222-222222222222',
        displayName: 'Implement · Release (attempt 2)',
      },
    });
    expect(options.readSettings()).toEqual({
      model: 'claude-sonnet',
      thinkingEffort: 'high',
      planMode: false,
      mode: 'read_only',
    });
    expect(options.pipelineAgent.isLive()).toBe(true);
    expect(attempt.instructions).toBe('LEDGER BLOCK');
    expect(getPipelineLedgerAttemptTools(attempt.attemptKey)).toBe(session);

    attempt.close({ kind: 'settled' });

    expect(options.pipelineAgent.isLive()).toBe(false);
    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(getPipelineLedgerAttemptTools(attempt.attemptKey)).toBeUndefined();
    attempt.close({ kind: 'settled' });
    expect(session.dispose).toHaveBeenCalledTimes(1);
  });

  it("opens a global run's attempt in its owner's global Ledger", async () => {
    mockOpenPipelineAgentTools.mockResolvedValue(fakeSession());
    const owner: LedgerGlobalOwner = {
      kind: 'organization',
      organizationId: ORG_ID,
    };

    const attempt = await port.openAttempt(globalRequest(owner));

    const [options] = mockOpenPipelineAgentTools.mock.calls[0] ?? [];
    if (options === undefined) throw new Error('Expected the gate to run');
    expect(options.globalOwner).toEqual(owner);
    // A projectless run is keyed by the executor's synthetic pipeline route.
    expect(options.target).toEqual({
      projectId: 'pipeline',
      worktreeId: 'execution-1',
      chatId: 'pipeline:execution-1',
    });
    // The host binds the owner's global Ledger for the signed-in account.
    mockResolveGlobalScope.mockResolvedValue({
      containerCreatedAt: '2026-10-21T00:00:00.000Z',
    });
    await expect(
      options.host?.containerCreatedAt({ kind: 'global', owner }),
    ).resolves.toBe('2026-10-21T00:00:00.000Z');
    expect(mockResolveGlobalScope).toHaveBeenCalledWith(owner);
    attempt?.close({ kind: 'settled' });
  });

  it('keeps a task run in its worktree, whoever owns the run', async () => {
    mockOpenPipelineAgentTools.mockResolvedValue(fakeSession());

    const attempt = await port.openAttempt(request());

    const [options] = mockOpenPipelineAgentTools.mock.calls[0] ?? [];
    expect(options).not.toHaveProperty('globalOwner');
    attempt?.close({ kind: 'settled' });
  });

  it("passes the step's configured secrets to the agent's binding", async () => {
    mockOpenPipelineAgentTools.mockResolvedValue(fakeSession());

    const attempt = await port.openAttempt(
      request({ secretValues: ['correct horse battery staple'] }),
    );

    expect(
      mockOpenPipelineAgentTools.mock.calls[0]?.[0].pipelineAgent?.secretValues,
    ).toEqual(['correct horse battery staple']);
    attempt?.close({ kind: 'settled' });
  });

  it('mints a new agent for every run that does not resume one', async () => {
    mockOpenPipelineAgentTools.mockImplementation(() =>
      Promise.resolve(fakeSession()),
    );

    const first = await port.openAttempt(request());
    const retry = await port.openAttempt(request({ attempt: 2 }));
    const resumed = await port.openAttempt(
      request({
        resumedAgentSessionId: first?.agentSessionId,
        checkpointId: 'checkpoint-1',
      }),
    );

    expect(retry?.agentSessionId).toMatch(UUID);
    expect(retry?.agentSessionId).not.toBe(first?.agentSessionId);
    expect(resumed?.agentSessionId).toBe(first?.agentSessionId);
    for (const attempt of [first, retry, resumed]) {
      attempt?.close({ kind: 'settled' });
    }
  });

  it('serves a subprocess one route on the worker surface until it closes', async () => {
    const session = fakeSession();
    mockOpenPipelineAgentTools.mockResolvedValue(session);
    const attempt = await port.openAttempt(request());
    if (attempt === null) throw new Error('Expected an attempt');

    const tools = await attempt.openSubprocessTools('/repo');
    await expect(attempt.openSubprocessTools('/repo')).resolves.toBe(tools);

    expect(mockRegisterRoute).toHaveBeenCalledTimes(1);
    const [route] = mockRegisterRoute.mock.calls[0] ?? [];
    if (route === undefined) throw new Error('Expected a route');
    expect(route).toMatchObject({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      chatId: 'pipeline:execution-1',
      toolSurface: 'claude-worker',
      ledgerTools: session,
    });
    // No memory tools and no structured-result tool on this route.
    expect(route).not.toHaveProperty('workerMemoryToolExposure');
    expect(route).not.toHaveProperty('reportStructuredResultSchema');
    const [token] = tools.secretValues;
    expect(route.authToken).toBe(token);
    expect(Object.values(tools.mcpServers)).toEqual([
      {
        type: 'http',
        url: `http://127.0.0.1:4545/canopy/mcp/worktree-session/${route.sessionKey}`,
        headers: { Authorization: `Bearer ${token}` },
        alwaysLoad: true,
      },
    ]);
    expect(tools.allowedTools).toEqual(pipelineLedgerClaudeToolNames());

    attempt.close({ kind: 'settled' });

    expect(mockUnregisterRoute).toHaveBeenCalledWith(route.sessionKey);
    await expect(attempt.openSubprocessTools('/repo')).rejects.toThrow('ended');
  });

  it('offers a paused attempt as an owner until it runs again', async () => {
    const session = fakeSession();
    mockOpenPipelineAgentTools.mockResolvedValue(session);
    const attempt = await port.openAttempt(request());
    if (attempt === null) throw new Error('Expected an attempt');

    attempt.close({
      kind: 'paused',
      checkpointId: 'checkpoint-1',
      pausedAt: '2026-09-30T00:00:00.000Z',
    });

    const owners = getLedgerPipelineAgentOwners();
    expect(owners.list(CONTAINER)).toEqual([
      expect.objectContaining({
        agentSessionId: attempt.agentSessionId,
        executionId: 'execution-1',
        // The physical job the attempt ran in, for owner pickers.
        jobId: 'build__variant_1',
        stepId: 'implement',
        attempt: 1,
        checkpointId: 'checkpoint-1',
        displayName: 'Implement · Release',
      }),
    ]);

    // Resuming the same checkpoint reopens the same agent, which then runs.
    const resumed = await port.openAttempt(
      request({
        resumedAgentSessionId: attempt.agentSessionId,
        checkpointId: 'checkpoint-1',
      }),
    );
    expect(resumed?.agentSessionId).toBe(attempt.agentSessionId);
    expect(owners.list(CONTAINER)).toEqual([]);
    resumed?.close({ kind: 'settled' });
  });

  it('retires only the agents paused on the checkpoints a resume consumes', async () => {
    mockOpenPipelineAgentTools.mockImplementation(() =>
      Promise.resolve(fakeSession()),
    );
    const resuming = await port.openAttempt(request());
    const waiting = await port.openAttempt(request({ stepId: 'review' }));
    if (resuming === null || waiting === null) {
      throw new Error('Expected two attempts');
    }
    resuming.close({
      kind: 'paused',
      checkpointId: 'checkpoint-1',
      pausedAt: '2026-09-30T00:00:00.000Z',
    });
    waiting.close({
      kind: 'paused',
      checkpointId: 'checkpoint-2',
      pausedAt: '2026-09-30T00:00:01.000Z',
    });
    const owners = getLedgerPipelineAgentOwners();
    // An owner commit checking a paused agent holds the execution's fence.
    let releaseCommit: () => void = (): void => undefined;
    const commit = owners.withAdmission(
      'execution-1',
      () =>
        new Promise<void>((resolve) => {
          releaseCommit = resolve;
        }),
    );

    const noted = port.noteResuming('execution-1', ['checkpoint-1']);
    await Promise.resolve();

    // The resume waits for the commit before retiring the agent.
    expect(owners.find(resuming.agentSessionId)).toBeDefined();
    releaseCommit();
    await commit;
    await noted;
    expect(owners.find(resuming.agentSessionId)).toBeUndefined();
    expect(owners.list(CONTAINER)).toEqual([
      expect.objectContaining({
        agentSessionId: waiting.agentSessionId,
        checkpointId: 'checkpoint-2',
      }),
    ]);
  });
});

describe('pipeline Ledger subprocess approval', () => {
  const port = createDesktopPipelineLedgerPort();
  const check = jest.fn<
    ReturnType<ApprovalSessionHandle['check']>,
    Parameters<ApprovalSessionHandle['check']>
  >();
  const dispose = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockRegisterRoute.mockResolvedValue('registered');
    mockOpenPipelineAgentTools.mockImplementation(() =>
      Promise.resolve(fakeSession()),
    );
    check.mockResolvedValue({ decision: 'allow' });
    mockCreateApprovalSession.mockReturnValue({ check, dispose });
  });

  async function openRoute(
    overrides: Partial<PipelineLedgerAttemptRequest> = {},
  ): Promise<{
    readonly route: CanopyWorktreeSessionRoute;
    readonly close: () => void;
  }> {
    const attempt = await port.openAttempt(request(overrides));
    if (attempt === null) throw new Error('Expected an attempt');
    await attempt.openSubprocessTools('/repo/app');
    const [route] = mockRegisterRoute.mock.calls[0] ?? [];
    if (route === undefined) throw new Error('Expected a route');
    return { route, close: () => attempt.close({ kind: 'settled' }) };
  }

  it('gates every Ledger call on an unattended session allowing exactly the Ledger tools', async () => {
    const { route, close } = await openRoute();
    if (route.authorizeToolCall === undefined) {
      throw new Error('Expected an approval gate on the route');
    }

    const [context] = mockCreateApprovalSession.mock.calls[0] ?? [];
    if (context === undefined) throw new Error('Expected a session');
    expect(context).toMatchObject({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      chatId: 'pipeline:execution-1',
      provider: 'claude',
      workspaceRoot: '/repo/app',
      mode: 'auto',
      trackChatTurn: false,
    });
    expect(context.getWindow()).toBeNull();
    expect(
      context.sessionRules.map(({ behavior, target }) => ({
        behavior,
        target,
      })),
    ).toEqual(
      [
        CANOPY_INJECTED_TOOL_REGISTRY.add_ledger_entry.displayName,
        CANOPY_INJECTED_TOOL_REGISTRY.search_ledger_entries.displayName,
        CANOPY_INJECTED_TOOL_REGISTRY.update_ledger_entry.displayName,
      ].map((tool) => ({
        behavior: 'allow',
        target: { kind: 'mcp', server: BRAND.tools.namespace, tool },
      })),
    );

    await expect(
      route.authorizeToolCall('add_ledger_entry', {}, { requestId: '7' }),
    ).resolves.toBe(true);
    expect(check).toHaveBeenCalledWith(
      {
        kind: 'mcp',
        server: BRAND.tools.namespace,
        tool: CANOPY_INJECTED_TOOL_REGISTRY.add_ledger_entry.displayName,
      },
      expect.objectContaining({ toolUseId: 'pipeline-ledger-7' }),
    );

    close();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('refuses a Ledger call a project or global rule denies, and any other tool', async () => {
    const { route, close } = await openRoute();
    if (route.authorizeToolCall === undefined) {
      throw new Error('Expected an approval gate on the route');
    }
    check.mockResolvedValueOnce({ decision: 'deny', message: 'Denied.' });

    await expect(route.authorizeToolCall('add_ledger_entry', {})).resolves.toBe(
      false,
    );
    await expect(route.authorizeToolCall('watch_command', {})).resolves.toBe(
      false,
    );
    expect(check).toHaveBeenCalledTimes(1);
    close();
  });

  it("keys a directory run's session by its project, so its deny rules apply", async () => {
    const attempt = await port.openAttempt(
      globalRequest({ kind: 'personal' }, 'workspace-1'),
    );
    if (attempt === null) throw new Error('Expected an attempt');
    await attempt.openSubprocessTools('/repo/app');

    expect(mockCreateApprovalSession.mock.calls[0]?.[0]).toMatchObject({
      projectId: 'workspace-1',
      worktreeId: 'execution-1',
      chatId: 'pipeline:execution-1',
    });
    expect(mockRegisterRoute.mock.calls[0]?.[0]).toMatchObject({
      projectId: 'workspace-1',
      worktreeId: 'execution-1',
    });
    attempt.close({ kind: 'settled' });
  });

  it('follows the step preset', async () => {
    const { close } = await openRoute({ permissionPreset: 'dangerous_all' });

    expect(mockCreateApprovalSession.mock.calls[0]?.[0].mode).toBe(
      'full-access',
    );
    close();
  });
});

describe('pipeline Ledger Codex tools', () => {
  const tools = {
    execute: jest.fn(() => Promise.resolve({ text: '{"ok":true}' })),
  };
  const check = jest.fn<
    ReturnType<ApprovalSessionHandle['check']>,
    Parameters<ApprovalSessionHandle['check']>
  >();
  const { specs, policy } = pipelineLedgerCodexTools(tools, { check });
  const addName = CANOPY_INJECTED_TOOL_REGISTRY.add_ledger_entry.codexToolName;

  beforeEach(() => {
    check.mockReset();
    check.mockResolvedValue({ decision: 'allow' });
  });

  function call(
    overrides: Partial<{ threadId: string; tool: string }> = {},
  ): Parameters<ReturnType<typeof policy>['execute']>[0] {
    return {
      threadId: overrides.threadId ?? 'thread-1',
      turnId: 'turn-1',
      callId: 'call-1',
      namespace: null,
      tool: overrides.tool ?? addName,
      arguments: { type: 'TASK', title: 'Work', content: 'Do it.' },
    };
  }

  it('advertises only the three Ledger tools', () => {
    expect(specs.map((spec) => spec.name)).toEqual([
      addName,
      CANOPY_INJECTED_TOOL_REGISTRY.search_ledger_entries.codexToolName,
      CANOPY_INJECTED_TOOL_REGISTRY.update_ledger_entry.codexToolName,
    ]);
  });

  it('runs a call on its own thread with a replay-safe invocation', async () => {
    const signal = new AbortController().signal;
    const threadPolicy = policy('thread-1');

    await expect(threadPolicy.authorize(call(), signal)).resolves.toBe(true);
    // Checked as an exact tool target, as a native chat's injected tools are.
    expect(check).toHaveBeenCalledWith(
      { kind: 'tool', toolName: addName },
      {
        title: `Use ${addName}?`,
        details: { kind: 'tool', toolName: addName },
        toolUseId: 'codex-call-1',
      },
    );
    await expect(threadPolicy.execute(call(), signal)).resolves.toEqual({
      success: true,
      contentItems: [{ type: 'inputText', text: '{"ok":true}' }],
    });
    expect(tools.execute).toHaveBeenCalledWith(
      'add_ledger_entry',
      { type: 'TASK', title: 'Work', content: 'Do it.' },
      { invocationId: 'codex:thread-1:turn-1:call-1', signal },
    );
  });

  it('refuses another thread or tool', async () => {
    const signal = new AbortController().signal;
    const threadPolicy = policy('thread-1');
    tools.execute.mockClear();

    await expect(
      threadPolicy.authorize(call({ threadId: 'thread-2' }), signal),
    ).resolves.toBe(false);
    await expect(
      threadPolicy.authorize(call({ tool: 'shell' }), signal),
    ).resolves.toBe(false);
    await expect(
      threadPolicy.execute(call({ threadId: 'thread-2' }), signal),
    ).resolves.toEqual({ success: false, contentItems: [] });
    expect(tools.execute).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
  });

  it('refuses a call its approval session denies', async () => {
    check.mockResolvedValue({ decision: 'deny', message: 'Denied by rule.' });

    await expect(
      policy('thread-1').authorize(call(), new AbortController().signal),
    ).resolves.toBe(false);
  });
});

describe('pipeline Ledger Codex approval session', () => {
  const port = createDesktopPipelineLedgerPort();
  const dispose = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockOpenPipelineAgentTools.mockImplementation(() =>
      Promise.resolve(fakeSession()),
    );
    mockCreateApprovalSession.mockReturnValue({
      check: () => Promise.resolve({ decision: 'allow' }),
      dispose,
    });
  });

  it('opens an unattended session allowing exactly the Ledger tools', async () => {
    const attempt = await port.openAttempt(request({ harness: 'codex' }));
    if (attempt === null) throw new Error('Expected an attempt');

    const codex = openPipelineLedgerCodexTools(attempt.attemptKey, '/repo');
    if (codex === undefined) throw new Error('Expected Codex tools');

    const [context] = mockCreateApprovalSession.mock.calls[0] ?? [];
    if (context === undefined) throw new Error('Expected a session');
    expect(context).toMatchObject({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      chatId: 'pipeline:execution-1',
      provider: 'codex',
      workspaceRoot: '/repo',
      mode: 'auto',
      trackChatTurn: false,
    });
    expect(context.getWindow()).toBeNull();
    expect(
      context.sessionRules.map(({ behavior, target }) => ({
        behavior,
        target,
      })),
    ).toEqual(
      [
        CANOPY_INJECTED_TOOL_REGISTRY.add_ledger_entry.codexToolName,
        CANOPY_INJECTED_TOOL_REGISTRY.search_ledger_entries.codexToolName,
        CANOPY_INJECTED_TOOL_REGISTRY.update_ledger_entry.codexToolName,
      ].map((toolName) => ({
        behavior: 'allow',
        target: { kind: 'tool', toolName },
      })),
    );
    expect(codex.instructions).toBe('LEDGER BLOCK');

    codex.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
    attempt.close({ kind: 'settled' });
  });

  it('follows the step preset, and needs an open attempt', async () => {
    const attempt = await port.openAttempt(
      request({ harness: 'codex', permissionPreset: 'dangerous_all' }),
    );
    if (attempt === null) throw new Error('Expected an attempt');

    openPipelineLedgerCodexTools(attempt.attemptKey, '/repo')?.dispose();
    expect(mockCreateApprovalSession.mock.calls[0]?.[0].mode).toBe(
      'full-access',
    );

    attempt.close({ kind: 'settled' });
    expect(
      openPipelineLedgerCodexTools(attempt.attemptKey, '/repo'),
    ).toBeUndefined();
    expect(openPipelineLedgerCodexTools(undefined, '/repo')).toBeUndefined();
    expect(mockCreateApprovalSession).toHaveBeenCalledTimes(1);
  });
});
