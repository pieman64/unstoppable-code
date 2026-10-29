jest.mock('../codex/runtime-service', () => ({
  getCodexRuntimeService: jest.fn(() => {
    throw new Error('tests inject the runtime');
  }),
}));
jest.mock('../agents/delegation/canopy-tools', () => ({
  delegateAppToolGuidance: (): string => '',
}));

import type { AgentDelegationEvent } from '@canopy/protocol/delegation';
import type { AgentRunRequest } from '@canopy/desktop-shared/node/delegation';
import { CANOPY_INJECTED_TOOL_REGISTRY } from '@canopy/desktop-shared/lib/canopy-injected-tools';
import { DEFERRED_TOOLS_RELOAD_CONTINUATION_TEMPLATE } from '@canopy/desktop-shared/types';
import {
  CODEX_DELEGATION_GRANTS_REVOKED_CONTINUATION,
  CODEX_DELEGATION_PLANNING_CONTINUATION,
  createCodexDelegationRunner,
  type CodexDelegationPreparation,
} from '../agents/delegation/codex-runner';
import {
  DelegationCapabilityReloadController,
  DelegationCapabilityReloadFailure,
  type DelegationCapabilityReloadHost,
} from '../agents/delegation/capability-reload';
import {
  clearDelegationModelRejections,
  isDelegationModelRejected,
} from '../agents/delegation/model-rejections';

const LOAD_TOOL =
  CANOPY_INJECTED_TOOL_REGISTRY.load_deferred_tools.codexToolName;

interface TurnRequest {
  input: { text: string }[];
  permissions?: string;
  signal?: AbortSignal;
  onEvent?: (event: {
    method: string;
    params: Record<string, unknown>;
  }) => void;
  mcpElicitationPolicy?: {
    evaluate(call: {
      serverName: string;
      toolName: string;
      approvalKind: string;
    }): Promise<{ approved: boolean }> | { approved: boolean };
  };
}

type TurnScript = (
  request: TurnRequest,
  interrupted: Promise<void>,
) => Promise<{
  status: 'completed' | 'interrupted' | 'failed';
  text: string;
  error?: string;
  errorInfo?: string;
}>;

interface FakeHandle {
  threadId: string;
  runTurn: jest.Mock;
  interrupt: jest.Mock;
  unsubscribe: jest.Mock;
  submitSteeringInput: jest.Mock;
  turns: TurnRequest[];
}

function fakeHandle(threadId: string, script: TurnScript): FakeHandle {
  let interruptTurn: () => void = () => undefined;
  const handle: FakeHandle = {
    threadId,
    turns: [],
    interrupt: jest.fn(() => {
      interruptTurn();
      return Promise.resolve();
    }),
    unsubscribe: jest.fn(() => Promise.resolve()),
    submitSteeringInput: jest.fn(),
    runTurn: jest.fn(async (request: TurnRequest) => {
      handle.turns.push(request);
      const interrupted = new Promise<void>((resolve) => {
        interruptTurn = resolve;
      });
      const result = await script(request, interrupted);
      return {
        status: result.status,
        threadId,
        finalText: result.text,
        usage: { inputTokens: 2, outputTokens: 3 },
        ...(result.error ? { error: result.error } : {}),
        ...(result.errorInfo ? { errorInfo: result.errorInfo } : {}),
      };
    }),
  };
  return handle;
}

function tools(
  overrides: Partial<Record<string, unknown>> = {},
): CodexDelegationPreparation['tools'] {
  const value: unknown = {
    cwd: '/worktree',
    readRoots: [],
    gitAccess: {
      metadataRoots: [],
      privateMetadataRoots: [],
      runtimeRoots: [],
      commandDirectories: [],
    },
    instructions: () => 'Delegated instructions',
    writePaths: [],
    writable: () => true,
    prepareCodexSandboxWrites: () => Promise.resolve([]),
    codexSandboxWritesRevoked: () => Promise.resolve(false),
    policyContextKey: () => 'policy-1',
    setCodexTurnWrites: jest.fn(),
    observeCodex: jest.fn(),
    approveCodex: jest.fn(() => Promise.resolve({ decision: 'decline' })),
    authorizeMcp: jest.fn(() => Promise.resolve(true)),
    ...overrides,
  };
  // Tests are not type-checked; the runner uses only these members.
  return value as CodexDelegationPreparation['tools'];
}

function preparation(
  extra: Partial<CodexDelegationPreparation> = {},
): CodexDelegationPreparation {
  return {
    model: 'gpt-test',
    profile: { environmentPolicy: 'restricted', includeCanopySecrets: false },
    tools: tools(),
    ...extra,
  };
}

const request = {
  delegationId: 'delegation-1',
  runGeneration: 1,
  launchKey: 'launch-1',
  parent: {
    harnessId: 'claude',
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
    modelId: 'gpt-test',
    description: 'Inspect code',
    prompt: 'Inspect the requested code.',
    executionMode: 'foreground',
    contextPolicy: 'task_only',
    isolation: 'shared_worktree',
  },
  route: {
    selectedModelId: 'gpt-test',
    runtimeModelId: 'gpt-test',
    harnessId: 'codex',
    runtimeKind: 'codex-app-server',
    runnerRegistrationId: 'codex-local',
    runtimeVersion: '1',
    adapterVersion: '1',
    modelSource: 'test',
    providerType: 'codex',
    assignmentRevision: 'assignment-1',
    billingAuthority: 'native',
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

interface Harness {
  events: AgentDelegationEvent['event'][];
  terminal: Promise<AgentDelegationEvent['event']>;
  runtime: {
    startThread: jest.Mock;
    materializeThread: jest.Mock;
    resumeThread: jest.Mock;
  };
  materialized: unknown[];
  resumed: unknown[];
  started: unknown[];
  stop: () => Promise<void>;
}

function run(options: {
  prepare: () => Promise<CodexDelegationPreparation>;
  handles: FakeHandle[];
  runRequest?: AgentRunRequest;
}): Harness {
  const handles = [...options.handles];
  const materialized: unknown[] = [];
  const resumed: unknown[] = [];
  const started: unknown[] = [];
  const next = (): Promise<FakeHandle> => {
    const handle = handles.shift();
    return handle
      ? Promise.resolve(handle)
      : Promise.reject(new Error('No fake thread left'));
  };
  const runtime = {
    admin: (): { request: jest.Mock } => ({
      request: jest.fn(() => Promise.resolve({ config: { mcp_servers: {} } })),
    }),
    startThread: jest.fn((startRequest: unknown) => {
      started.push(startRequest);
      return next();
    }),
    materializeThread: jest.fn((materializeRequest: unknown) => {
      materialized.push(materializeRequest);
      return next();
    }),
    resumeThread: jest.fn((resumeRequest: unknown) => {
      resumed.push(resumeRequest);
      return next();
    }),
    getCanonicalState: jest.fn(() => Promise.resolve({ codexHome: '/codex' })),
  };
  const runner = createCodexDelegationRunner({
    available: () => Promise.resolve({ available: true }),
    prepare: options.prepare,
    reportError: jest.fn(),
    // Tests are not type-checked; the runner uses only these members.
    runtime: () => runtime as never,
    loadResumeItems: () => Promise.resolve([{ type: 'message' }]),
  });
  const events: AgentDelegationEvent['event'][] = [];
  const runRequest = options.runRequest ?? request;
  const terminal = new Promise<AgentDelegationEvent['event']>((resolve) => {
    void runner.start(runRequest, (envelope: AgentDelegationEvent) => {
      events.push(envelope.event);
      if (envelope.event.type === 'terminal') resolve(envelope.event);
      return Promise.resolve();
    });
  });
  return {
    events,
    terminal,
    runtime,
    materialized,
    resumed,
    started,
    stop: async (): Promise<void> => {
      await runner.stop({ runId: runRequest.delegationId }, 'user_cancelled');
    },
  };
}

function completes(text: string): TurnScript {
  return () => Promise.resolve({ status: 'completed', text });
}

/** A turn that calls Load, delivers its result, then waits for interrupt. */
function loads(controller: DelegationCapabilityReloadController): TurnScript {
  return async (turn, interrupted) => {
    const admission = controller.request({
      toolCallId: 'load-call',
      refs: ['deferred:v1:' + 'a'.repeat(43)],
      additions: { skillRefs: [], pluginRefs: [], mcpServerRefs: [] },
      enabledResources: [
        { ref: 'deferred:v1:' + 'a'.repeat(43), kind: 'skill', name: 'Review' },
      ],
    });
    expect(admission.accepted).toBe(true);
    turn.onEvent?.({
      method: 'item/completed',
      params: {
        item: {
          type: 'dynamicToolCall',
          id: 'load-call',
          namespace: null,
          tool: LOAD_TOOL,
          arguments: {},
          status: 'completed',
          contentItems: [{ type: 'inputText', text: '{"status":"success"}' }],
          success: true,
          durationMs: 1,
        },
      },
    });
    await interrupted;
    return { status: 'interrupted', text: '' };
  };
}

it('continues the same proxy thread after a quota reset without publishing an intermediate result', async () => {
  let turn = 0;
  const handle = fakeHandle('thread-1', () => {
    turn += 1;
    return Promise.resolve(
      turn === 1
        ? {
            status: 'failed' as const,
            text: '',
            error: 'Quota reached',
            errorInfo: 'usageLimitExceeded',
          }
        : { status: 'completed' as const, text: 'done' },
    );
  });
  const waitForQuotaRecovery = jest.fn(() => Promise.resolve());
  const harness = run({
    prepare: () => Promise.resolve(preparation({ waitForQuotaRecovery })),
    handles: [handle],
  });
  await expect(harness.terminal).resolves.toMatchObject({
    type: 'terminal',
    status: 'completed',
    finalText: 'done',
  });
  expect(waitForQuotaRecovery).toHaveBeenCalledTimes(1);
  expect(handle.runTurn).toHaveBeenCalledTimes(2);
  expect(harness.runtime.startThread).toHaveBeenCalledTimes(1);
  expect(
    harness.events.filter((event) => event.type === 'terminal'),
  ).toHaveLength(1);
});

it('runs one turn and publishes one terminal result', async () => {
  const handle = fakeHandle('thread-1', completes('done'));
  const harness = run({
    prepare: () => Promise.resolve(preparation()),
    handles: [handle],
  });
  const terminal = await harness.terminal;
  expect(terminal).toMatchObject({
    type: 'terminal',
    status: 'completed',
    finalText: 'done',
  });
  expect(
    harness.events.filter((event) => event.type === 'terminal'),
  ).toHaveLength(1);
});

// Delegated children do not support Ultra fast and never inherit the parent
// chat's speed: the run request carries no parent model config, so the child
// tier comes only from the task's explicit `fast_mode` boolean.
it.each([
  [undefined, 'default'],
  [false, 'default'],
  [true, 'priority'],
] as const)(
  'maps only the explicit task fast_mode=%s to the %s child tier',
  async (fastMode, serviceTier) => {
    const handle = fakeHandle('thread-1', completes('done'));
    const harness = run({
      prepare: () => Promise.resolve(preparation()),
      handles: [handle],
      runRequest: {
        ...request,
        task: {
          ...request.task,
          ...(fastMode === undefined ? {} : { fastMode }),
        },
      },
    });
    await harness.terminal;

    expect(recordOf(recordOf(harness.started[0]).params).serviceTier).toBe(
      serviceTier,
    );
    expect(recordOf(handle.turns[0]).serviceTier).toBe(serviceTier);
  },
);

it('reloads capabilities inside the run generation and resumes on a rebuilt thread', async () => {
  const controller = new DelegationCapabilityReloadController();
  const reloadedTools = tools();
  const apply = jest.fn(() =>
    Promise.resolve(
      preparation({
        tools: reloadedTools,
        selectedCapabilityRoots: [
          {
            location: {
              type: 'environment',
              environmentId: 'local',
              path: 'file:///staged/review',
            },
          },
        ] as never,
      }),
    ),
  );
  const restore = jest.fn(() => Promise.reject(new Error('unused')));
  const host: DelegationCapabilityReloadHost<CodexDelegationPreparation> = {
    apply,
    restore,
  };
  const first = fakeHandle('thread-1', loads(controller));
  const second = fakeHandle('thread-2', completes('after reload'));
  const initialTools = tools();
  const harness = run({
    prepare: () =>
      Promise.resolve(
        preparation({
          tools: initialTools,
          capabilityReload: { controller, host },
        }),
      ),
    handles: [first, second],
  });
  const terminal = await harness.terminal;

  expect(first.interrupt).toHaveBeenCalledTimes(1);
  expect(first.unsubscribe).toHaveBeenCalled();
  expect(apply).toHaveBeenCalledTimes(1);
  expect(harness.runtime.materializeThread).toHaveBeenCalledTimes(1);
  expect(harness.materialized[0]).toMatchObject({
    params: {
      selectedCapabilityRoots: [
        { location: { path: 'file:///staged/review' } },
      ],
    },
    items: [{ type: 'message' }],
  });
  expect(second.turns[0]?.input[0]?.text).toBe(
    DEFERRED_TOOLS_RELOAD_CONTINUATION_TEMPLATE,
  );
  // One published result for the whole run generation.
  expect(harness.events.filter((event) => event.type === 'terminal')).toEqual([
    terminal,
  ]);
  expect(terminal).toMatchObject({
    status: 'completed',
    finalText: 'after reload',
    usage: { inputTokens: 4, outputTokens: 6 },
  });
  expect(
    harness.events
      .filter((event) => event.type === 'started')
      .map((event) => (event.type === 'started' ? event.nativeSessionId : '')),
  ).toEqual(['thread-1', 'thread-2']);
  expect(controller.count).toBe(1);
  expect(controller.pending).toBeUndefined();
});

it('continues without the items when re-preparation fails', async () => {
  const controller = new DelegationCapabilityReloadController();
  const apply = jest.fn(() =>
    Promise.reject(
      new DelegationCapabilityReloadFailure('Review MCP is unavailable.'),
    ),
  );
  const restore = jest.fn(() => Promise.resolve(preparation()));
  const host: DelegationCapabilityReloadHost<CodexDelegationPreparation> = {
    apply,
    restore,
  };
  const first = fakeHandle('thread-1', loads(controller));
  const second = fakeHandle('thread-2', completes('without items'));
  const harness = run({
    prepare: () =>
      Promise.resolve(preparation({ capabilityReload: { controller, host } })),
    handles: [first, second],
  });
  const terminal = await harness.terminal;
  expect(restore).toHaveBeenCalledTimes(1);
  const continuation = second.turns[0]?.input[0]?.text ?? '';
  expect(continuation).toContain('could not be enabled');
  expect(continuation).toContain('Review MCP is unavailable.');
  expect(terminal).toMatchObject({
    status: 'completed',
    finalText: 'without items',
  });
});

it('cancels cleanly when stopped during a reload', async () => {
  const controller = new DelegationCapabilityReloadController();
  let releaseApply: () => void = () => undefined;
  const apply = jest.fn(
    (_reload: unknown, signal: AbortSignal) =>
      new Promise<CodexDelegationPreparation>((_resolve, reject) => {
        releaseApply = (): void => reject(new Error('aborted'));
        signal.addEventListener('abort', () => releaseApply(), {
          once: true,
        });
      }),
  );
  const restore = jest.fn(() => Promise.resolve(preparation()));
  const host: DelegationCapabilityReloadHost<CodexDelegationPreparation> = {
    apply,
    restore,
  };
  const first = fakeHandle('thread-1', loads(controller));
  const harness = run({
    prepare: () =>
      Promise.resolve(preparation({ capabilityReload: { controller, host } })),
    handles: [first],
  });
  while (!apply.mock.calls.length)
    await new Promise((resolve) => setTimeout(resolve, 1));
  await harness.stop();
  const terminal = await harness.terminal;
  expect(terminal).toMatchObject({ status: 'cancelled' });
  expect(restore).not.toHaveBeenCalled();
  expect(harness.runtime.materializeThread).not.toHaveBeenCalled();
  expect(
    controller.request({
      toolCallId: 'late',
      refs: [],
      additions: { skillRefs: [], pluginRefs: [], mcpServerRefs: [] },
      enabledResources: [],
    }),
  ).toMatchObject({ accepted: false, code: 'reload_in_progress' });
  expect(
    harness.events.filter((event) => event.type === 'terminal'),
  ).toHaveLength(1);
});

it('drops a reload whose Load result never reached the provider', async () => {
  const controller = new DelegationCapabilityReloadController();
  const apply = jest.fn(() => Promise.resolve(preparation()));
  const restore = jest.fn(() => Promise.resolve(preparation()));
  const host: DelegationCapabilityReloadHost<CodexDelegationPreparation> = {
    apply,
    restore,
  };
  const handle = fakeHandle('thread-1', () => {
    controller.request({
      toolCallId: 'load-call',
      refs: [],
      additions: { skillRefs: [], pluginRefs: [], mcpServerRefs: [] },
      enabledResources: [],
    });
    return Promise.resolve({ status: 'completed', text: 'done' });
  });
  const harness = run({
    prepare: () =>
      Promise.resolve(preparation({ capabilityReload: { controller, host } })),
    handles: [handle],
  });
  expect(await harness.terminal).toMatchObject({
    status: 'completed',
    finalText: 'done',
  });
  expect(apply).not.toHaveBeenCalled();
  expect(controller.pending).toBeUndefined();
});

it('approves provider-handled MCP calls in the runner and leaves transport-gated ones to the host gate', async () => {
  const authorizeMcp = jest.fn(() => Promise.resolve(false));
  let decisions: { approved: boolean }[] = [];
  const handle = fakeHandle('thread-1', async (turn) => {
    const policy = turn.mcpElicitationPolicy;
    decisions = [
      await policy?.evaluate({
        serverName: 'direct',
        toolName: 'search',
        approvalKind: 'mcp_tool_call',
      }),
      await policy?.evaluate({
        serverName: 'proxied',
        toolName: 'search',
        approvalKind: 'mcp_tool_call',
      }),
      await policy?.evaluate({
        serverName: 'unselected',
        toolName: 'search',
        approvalKind: 'mcp_tool_call',
      }),
    ].map((decision) => decision ?? { approved: false });
    return { status: 'completed', text: 'done' };
  });
  const harness = run({
    prepare: () =>
      Promise.resolve(
        preparation({
          tools: tools({ authorizeMcp }),
          selectedMcpServers: {
            direct: { url: 'https://mcp.example.test', required: false },
            proxied: { url: 'http://127.0.0.1:1/p', required: false },
          },
          providerGatedMcpServers: ['direct'],
        }),
      ),
    handles: [handle],
  });
  await harness.terminal;
  expect(authorizeMcp).toHaveBeenCalledTimes(1);
  expect(authorizeMcp).toHaveBeenCalledWith(
    'direct',
    'search',
    undefined,
    expect.any(String),
    expect.any(AbortSignal),
  );
  expect(decisions.map((decision) => decision.approved)).toEqual([
    false,
    true,
    false,
  ]);
});

function recordOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

/** The named filesystem profiles of one thread start/materialize request. */
function filesystemProfiles(
  call: unknown,
): Record<string, Record<string, unknown>> {
  const permissions = recordOf(
    recordOf(recordOf(recordOf(call).params).config).permissions,
  );
  return Object.fromEntries(
    Object.entries(permissions).map(([name, profile]) => [
      name,
      recordOf(recordOf(profile).filesystem),
    ]),
  );
}

describe('Codex sandbox write grants', () => {
  it.each([false, true])(
    'retains the selected sandbox in config reloads (write grants: %s)',
    async (withWrites) => {
      const handle = fakeHandle('thread-1', completes('read'));
      const harness = run({
        prepare: () =>
          Promise.resolve(
            preparation({
              tools: tools({
                prepareCodexSandboxWrites: () =>
                  Promise.resolve(withWrites ? ['/worktree/src'] : []),
              }),
            }),
          ),
        handles: [handle],
      });
      await harness.terminal;
      const params = recordOf(recordOf(harness.started[0]).params);
      expect(recordOf(params.config).default_permissions).toBe(
        params.permissions,
      );
      expect(params.permissions).toBe(
        withWrites ? 'delegated_write' : 'delegated_read_only',
      );
    },
  );

  it('grants the delegate write paths to shell commands through the write profile', async () => {
    const setCodexTurnWrites = jest.fn();
    const handle = fakeHandle('thread-1', completes('written'));
    const harness = run({
      prepare: () =>
        Promise.resolve(
          preparation({
            tools: tools({
              writePaths: ['/worktree/notes.txt'],
              prepareCodexSandboxWrites: () =>
                Promise.resolve(['/worktree/notes.txt']),
              setCodexTurnWrites,
            }),
          }),
        ),
      handles: [handle],
    });
    await expect(harness.terminal).resolves.toMatchObject({
      status: 'completed',
    });
    const started: unknown = harness.started[0];
    const profiles = filesystemProfiles(started);
    expect(profiles.delegated_write?.['/worktree/notes.txt']).toBe('write');
    // The read-only profile never carries the grant.
    expect(profiles.delegated_read_only?.['/worktree/notes.txt']).toBe(
      undefined,
    );
    expect(recordOf(recordOf(started).params).permissions).toBe(
      'delegated_write',
    );
    // The bundled runtime rejects `turn/start` profile selection, so the
    // thread carries it.
    expect(handle.turns[0]?.permissions).toBeUndefined();
    expect(setCodexTurnWrites).toHaveBeenCalledWith(true);
  });

  it('runs a turn under the read-only profile while the root chat plans', async () => {
    const setCodexTurnWrites = jest.fn();
    const handle = fakeHandle('thread-1', completes('planned'));
    const harness = run({
      prepare: () =>
        Promise.resolve(
          preparation({
            tools: tools({
              writePaths: ['/worktree/notes.txt'],
              writable: () => false,
              prepareCodexSandboxWrites: () =>
                Promise.resolve(['/worktree/notes.txt']),
              setCodexTurnWrites,
            }),
          }),
        ),
      handles: [handle],
    });
    await harness.terminal;
    const started: unknown = harness.started[0];
    // The write profile stays defined so a later turn can select it.
    expect(
      filesystemProfiles(started).delegated_write?.['/worktree/notes.txt'],
    ).toBe('write');
    expect(recordOf(recordOf(started).params).permissions).toBe(
      'delegated_read_only',
    );
    expect(setCodexTurnWrites).toHaveBeenCalledWith(false);
  });

  it('defines no write profile without validated write grants', async () => {
    const handle = fakeHandle('thread-1', completes('read'));
    const harness = run({
      prepare: () => Promise.resolve(preparation()),
      handles: [handle],
    });
    await harness.terminal;
    const started: unknown = harness.started[0];
    expect(Object.keys(filesystemProfiles(started))).toEqual([
      'delegated_read_only',
    ]);
    expect(recordOf(recordOf(started).params).permissions).toBe(
      'delegated_read_only',
    );
  });

  it('selects each thread profile from the live plan state across a capability reload', async () => {
    const controller = new DelegationCapabilityReloadController();
    let writable = true;
    const setCodexTurnWrites = jest.fn();
    const prepareCodexSandboxWrites = jest.fn(() =>
      Promise.resolve(['/worktree/src']),
    );
    const sharedTools = tools({
      writePaths: ['/worktree/src'],
      writable: () => writable,
      prepareCodexSandboxWrites,
      setCodexTurnWrites,
    });
    const host: DelegationCapabilityReloadHost<CodexDelegationPreparation> = {
      apply: jest.fn(() => {
        writable = false;
        return Promise.resolve(preparation({ tools: sharedTools }));
      }),
      restore: jest.fn(() => Promise.reject(new Error('unused'))),
    };
    const first = fakeHandle('thread-1', loads(controller));
    const second = fakeHandle('thread-2', completes('after reload'));
    const harness = run({
      prepare: () =>
        Promise.resolve(
          preparation({
            tools: sharedTools,
            capabilityReload: { controller, host },
          }),
        ),
      handles: [first, second],
    });
    await harness.terminal;
    const started: unknown = harness.started[0];
    expect(recordOf(recordOf(started).params).permissions).toBe(
      'delegated_write',
    );
    // A still-loaded thread keeps its profile on resume, so a run with write
    // grants continues on a rebuilt thread under the profile the plan
    // state allows now.
    expect(harness.runtime.resumeThread).not.toHaveBeenCalled();
    expect(recordOf(recordOf(harness.materialized[0]).params).permissions).toBe(
      'delegated_read_only',
    );
    expect(setCodexTurnWrites.mock.calls).toEqual([[true], [false]]);
    // The child learns why it can no longer write.
    expect(second.turns[0]?.input.map((item) => item.text)).toEqual([
      DEFERRED_TOOLS_RELOAD_CONTINUATION_TEMPLATE,
      CODEX_DELEGATION_PLANNING_CONTINUATION,
    ]);
    // The grants' preimages are captured once for the policy.
    expect(prepareCodexSandboxWrites).toHaveBeenCalledTimes(1);
  });
});

const grants = ['/worktree/src'];

function writeTools(
  state: { writable: boolean },
  extra: Partial<Record<string, unknown>> = {},
): CodexDelegationPreparation['tools'] {
  return tools({
    writePaths: grants,
    writable: () => state.writable,
    prepareCodexSandboxWrites: () => Promise.resolve(grants),
    ...extra,
  });
}

/** The runtime learns the native turn id from this notification. */
function turnStarted(turn: TurnRequest, threadId: string): void {
  turn.onEvent?.({
    method: 'turn/started',
    params: { threadId, turn: { id: `${threadId}-turn` } },
  });
}

function itemStarted(turn: TurnRequest, threadId: string): void {
  turn.onEvent?.({
    method: 'item/started',
    params: { threadId, item: { type: 'reasoning', id: 'reasoning-1' } },
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True once the turn is interrupted; false when `ms` passes first. */
async function interruptedWithin(
  interrupted: Promise<void>,
  ms: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const result = await Promise.race([
    interrupted.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    }),
  ]);
  clearTimeout(timer);
  return result;
}

/** A write turn that keeps writing unless the runner stops it. */
function stoppable(
  interrupted: Promise<void>,
  ms: number,
): Promise<{ status: 'completed' | 'interrupted'; text: string }> {
  return interruptedWithin(interrupted, ms).then((stopped) =>
    stopped
      ? { status: 'interrupted', text: '' }
      : { status: 'completed', text: 'kept the write profile' },
  );
}

function startedThreads(harness: Harness): string[] {
  return harness.events.flatMap((event) =>
    event.type === 'started' ? [event.nativeSessionId] : [],
  );
}

describe('Root chat planning during a write-profile turn', () => {
  it('stops the provider turn and continues the run read-only on a new thread', async () => {
    const state = { writable: true };
    const setCodexTurnWrites = jest.fn();
    const first = fakeHandle('thread-1', (turn, interrupted) => {
      turnStarted(turn, 'thread-1');
      state.writable = false;
      itemStarted(turn, 'thread-1');
      return stoppable(interrupted, 1_000);
    });
    const second = fakeHandle('thread-2', completes('finished read-only'));
    const harness = run({
      prepare: () =>
        Promise.resolve(
          preparation({
            tools: writeTools(state, { setCodexTurnWrites }),
          }),
        ),
      handles: [first, second],
    });
    const terminal = await harness.terminal;

    expect(recordOf(recordOf(harness.started[0]).params).permissions).toBe(
      'delegated_write',
    );
    expect(first.interrupt).toHaveBeenCalledTimes(1);
    expect(first.unsubscribe).toHaveBeenCalled();
    // A loaded thread cannot change profile, so the history continues on a
    // thread rebuilt under the read-only profile.
    expect(harness.runtime.resumeThread).not.toHaveBeenCalled();
    expect(harness.runtime.materializeThread).toHaveBeenCalledTimes(1);
    expect(harness.materialized[0]).toMatchObject({
      params: { permissions: 'delegated_read_only' },
      items: [{ type: 'message' }],
    });
    expect(second.turns[0]?.input.map((item) => item.text)).toEqual([
      CODEX_DELEGATION_PLANNING_CONTINUATION,
    ]);
    expect(setCodexTurnWrites.mock.calls).toEqual([[true], [false]]);
    // Same run generation: one published result, usage across both threads.
    expect(harness.events.filter((event) => event.type === 'terminal')).toEqual(
      [terminal],
    );
    expect(terminal).toMatchObject({
      status: 'completed',
      finalText: 'finished read-only',
      usage: { inputTokens: 4, outputTokens: 6 },
    });
    expect(startedThreads(harness)).toEqual(['thread-1', 'thread-2']);
  });

  it('notices planning during a turn that emits no further events', async () => {
    const state = { writable: true };
    const first = fakeHandle('thread-1', async (turn, interrupted) => {
      turnStarted(turn, 'thread-1');
      await delay(20);
      state.writable = false;
      return stoppable(interrupted, 2_000);
    });
    const second = fakeHandle('thread-2', completes('finished read-only'));
    const harness = run({
      prepare: () => Promise.resolve(preparation({ tools: writeTools(state) })),
      handles: [first, second],
    });
    expect(await harness.terminal).toMatchObject({
      status: 'completed',
      finalText: 'finished read-only',
    });
    expect(first.interrupt).toHaveBeenCalledTimes(1);
    expect(recordOf(recordOf(harness.materialized[0]).params).permissions).toBe(
      'delegated_read_only',
    );
  });

  it('waits for the native turn id before stopping the turn', async () => {
    const state = { writable: true };
    let interruptsBeforeTurnStarted = -1;
    const first: FakeHandle = fakeHandle(
      'thread-1',
      async (turn, interrupted) => {
        state.writable = false;
        turn.onEvent?.({
          method: 'thread/status/changed',
          params: { threadId: 'thread-1' },
        });
        await delay(600);
        interruptsBeforeTurnStarted = first.interrupt.mock.calls.length;
        turnStarted(turn, 'thread-1');
        return stoppable(interrupted, 1_000);
      },
    );
    const second = fakeHandle('thread-2', completes('finished read-only'));
    const harness = run({
      prepare: () => Promise.resolve(preparation({ tools: writeTools(state) })),
      handles: [first, second],
    });
    await harness.terminal;
    // Interrupting before `turn/start` resolves would restart the shared
    // app-server process instead of stopping this turn.
    expect(interruptsBeforeTurnStarted).toBe(0);
    expect(first.interrupt).toHaveBeenCalledTimes(1);
    expect(second.turns).toHaveLength(1);
  });

  it('publishes a turn that finished before the stop took effect', async () => {
    const state = { writable: true };
    const handle = fakeHandle('thread-1', (turn) => {
      turnStarted(turn, 'thread-1');
      state.writable = false;
      itemStarted(turn, 'thread-1');
      return Promise.resolve({ status: 'completed', text: 'already done' });
    });
    const harness = run({
      prepare: () => Promise.resolve(preparation({ tools: writeTools(state) })),
      handles: [handle],
    });
    expect(await harness.terminal).toMatchObject({
      status: 'completed',
      finalText: 'already done',
    });
    expect(handle.interrupt).toHaveBeenCalledTimes(1);
    expect(harness.runtime.materializeThread).not.toHaveBeenCalled();
    expect(startedThreads(harness)).toEqual(['thread-1']);
  });

  it('cancels without a new thread when stopped during the planning switch', async () => {
    const state = { writable: true };
    const first = fakeHandle('thread-1', async (turn, interrupted) => {
      turnStarted(turn, 'thread-1');
      state.writable = false;
      itemStarted(turn, 'thread-1');
      await interrupted;
      // The user's stop aborts synchronously, before this turn settles.
      void harness.stop();
      return { status: 'interrupted', text: '' };
    });
    const harness = run({
      prepare: () => Promise.resolve(preparation({ tools: writeTools(state) })),
      handles: [first],
    });
    expect(await harness.terminal).toMatchObject({ status: 'cancelled' });
    expect(harness.runtime.materializeThread).not.toHaveBeenCalled();
    expect(startedThreads(harness)).toEqual(['thread-1']);
    expect(
      harness.events.filter((event) => event.type === 'terminal'),
    ).toHaveLength(1);
  });

  it('never stops a thread that opened read-only because the root was already planning', async () => {
    const state = { writable: false };
    const handle = fakeHandle('thread-1', async (turn) => {
      turnStarted(turn, 'thread-1');
      itemStarted(turn, 'thread-1');
      await delay(600);
      itemStarted(turn, 'thread-1');
      return { status: 'completed', text: 'planned' };
    });
    const harness = run({
      prepare: () => Promise.resolve(preparation({ tools: writeTools(state) })),
      handles: [handle],
    });
    expect(await harness.terminal).toMatchObject({
      status: 'completed',
      finalText: 'planned',
    });
    expect(recordOf(recordOf(harness.started[0]).params).permissions).toBe(
      'delegated_read_only',
    );
    expect(handle.interrupt).not.toHaveBeenCalled();
    expect(harness.runtime.materializeThread).not.toHaveBeenCalled();
  });

  it('leaves a write-profile turn alone while the root is not planning', async () => {
    const state = { writable: true };
    const handle = fakeHandle('thread-1', async (turn) => {
      turnStarted(turn, 'thread-1');
      itemStarted(turn, 'thread-1');
      await delay(600);
      itemStarted(turn, 'thread-1');
      return { status: 'completed', text: 'written' };
    });
    const harness = run({
      prepare: () => Promise.resolve(preparation({ tools: writeTools(state) })),
      handles: [handle],
    });
    expect(await harness.terminal).toMatchObject({
      status: 'completed',
      finalText: 'written',
    });
    expect(handle.interrupt).not.toHaveBeenCalled();
    expect(harness.runtime.materializeThread).not.toHaveBeenCalled();
  });
});

describe('Parent rules denying a grant during a write-profile turn', () => {
  /**
   * Grants the parent's live policy allows until `state.denied` is set (a
   * deny rule or protected path inside a grant, or a failed path check).
   */
  function grantTools(
    state: { denied: boolean; key: string },
    extra: Partial<Record<string, unknown>> = {},
  ): CodexDelegationPreparation['tools'] {
    return writeTools(
      { writable: true },
      {
        codexSandboxWritesRevoked: jest.fn(() => Promise.resolve(state.denied)),
        policyContextKey: () => state.key,
        ...extra,
      },
    );
  }

  it.each(['grants', 'planning'])(
    'rechecks %s before a quota continuation can execute',
    async (reason) => {
      const state = { denied: false, key: 'policy-1' };
      const plan = { writable: true };
      let calls = 0;
      const first = fakeHandle('thread-1', () => {
        calls += 1;
        return Promise.resolve(
          calls === 1
            ? {
                status: 'failed' as const,
                text: '',
                error: 'Quota reached',
                errorInfo: 'usageLimitExceeded',
              }
            : { status: 'completed' as const, text: 'unsafe continuation' },
        );
      });
      const second = fakeHandle('thread-2', completes('finished read-only'));
      const sharedTools = grantTools(state, { writable: () => plan.writable });
      const waitForQuotaRecovery = jest.fn((): Promise<void> => {
        if (reason === 'grants') state.denied = true;
        else plan.writable = false;
        return Promise.resolve();
      });
      const harness = run({
        prepare: () =>
          Promise.resolve(
            preparation({ tools: sharedTools, waitForQuotaRecovery }),
          ),
        handles: [first, second],
      });
      expect(await harness.terminal).toMatchObject({
        status: 'completed',
        finalText: 'finished read-only',
      });
      expect(first.runTurn).toHaveBeenCalledTimes(1);
      expect(harness.materialized[0]).toMatchObject({
        params: { permissions: 'delegated_read_only' },
      });
      if (reason === 'grants')
        expect(
          filesystemProfiles(harness.materialized[0]).delegated_write,
        ).toBeUndefined();
      expect(second.turns[0]?.input.map((item) => item.text)).toContain(
        reason === 'grants'
          ? CODEX_DELEGATION_GRANTS_REVOKED_CONTINUATION
          : CODEX_DELEGATION_PLANNING_CONTINUATION,
      );
      expect(
        harness.events.filter((event) => event.type === 'terminal'),
      ).toHaveLength(1);
    },
  );

  it('stops the provider turn and continues the run read-only on a new thread', async () => {
    const state = { denied: false, key: 'policy-1' };
    const setCodexTurnWrites = jest.fn();
    const first = fakeHandle('thread-1', (turn, interrupted) => {
      turnStarted(turn, 'thread-1');
      // The parent saves a deny rule inside the grant. Commands native
      // `.rules` approve would keep writing without an approval callback.
      state.denied = true;
      state.key = 'policy-2';
      itemStarted(turn, 'thread-1');
      return stoppable(interrupted, 1_000);
    });
    const second = fakeHandle('thread-2', completes('finished read-only'));
    const harness = run({
      prepare: () =>
        Promise.resolve(
          preparation({ tools: grantTools(state, { setCodexTurnWrites }) }),
        ),
      handles: [first, second],
    });
    const terminal = await harness.terminal;

    expect(recordOf(recordOf(harness.started[0]).params).permissions).toBe(
      'delegated_write',
    );
    expect(first.interrupt).toHaveBeenCalledTimes(1);
    expect(harness.runtime.resumeThread).not.toHaveBeenCalled();
    expect(harness.materialized[0]).toMatchObject({
      params: { permissions: 'delegated_read_only' },
      items: [{ type: 'message' }],
    });
    // The denied grant no longer defines a write profile at all.
    expect(
      filesystemProfiles(harness.materialized[0]).delegated_write,
    ).toBeUndefined();
    expect(second.turns[0]?.input.map((item) => item.text)).toEqual([
      CODEX_DELEGATION_GRANTS_REVOKED_CONTINUATION,
    ]);
    expect(setCodexTurnWrites.mock.calls).toEqual([[true], [false]]);
    // Same run generation: one published result.
    expect(harness.events.filter((event) => event.type === 'terminal')).toEqual(
      [terminal],
    );
    expect(terminal).toMatchObject({
      status: 'completed',
      finalText: 'finished read-only',
    });
    expect(startedThreads(harness)).toEqual(['thread-1', 'thread-2']);
  });

  it('notices a denied grant the policy key does not reflect during a silent turn', async () => {
    const state = { denied: false, key: 'policy-1' };
    const first = fakeHandle('thread-1', async (turn, interrupted) => {
      turnStarted(turn, 'thread-1');
      await delay(20);
      // A session rule, say: the policy context key stays the same.
      state.denied = true;
      return stoppable(interrupted, 3_000);
    });
    const second = fakeHandle('thread-2', completes('finished read-only'));
    const harness = run({
      prepare: () => Promise.resolve(preparation({ tools: grantTools(state) })),
      handles: [first, second],
    });
    expect(await harness.terminal).toMatchObject({
      status: 'completed',
      finalText: 'finished read-only',
    });
    expect(first.interrupt).toHaveBeenCalledTimes(1);
    expect(recordOf(recordOf(harness.materialized[0]).params).permissions).toBe(
      'delegated_read_only',
    );
  });

  it('leaves a write-profile turn alone while the parent still allows its grants', async () => {
    const state = { denied: false, key: 'policy-1' };
    const codexSandboxWritesRevoked = jest.fn(() => Promise.resolve(false));
    const handle = fakeHandle('thread-1', async (turn) => {
      turnStarted(turn, 'thread-1');
      itemStarted(turn, 'thread-1');
      // An unrelated rule or mode change.
      state.key = 'policy-2';
      await delay(600);
      itemStarted(turn, 'thread-1');
      return { status: 'completed', text: 'written' };
    });
    const harness = run({
      prepare: () =>
        Promise.resolve(
          preparation({
            tools: grantTools(state, { codexSandboxWritesRevoked }),
          }),
        ),
      handles: [handle],
    });
    expect(await harness.terminal).toMatchObject({
      status: 'completed',
      finalText: 'written',
    });
    expect(handle.interrupt).not.toHaveBeenCalled();
    expect(harness.runtime.materializeThread).not.toHaveBeenCalled();
    // Evaluated when the thread opened and again during the turn.
    expect(codexSandboxWritesRevoked.mock.calls.length).toBeGreaterThan(1);
  });

  it('runs one grant evaluation at a time however often the turn is checked', async () => {
    const state = { denied: false, key: 'policy-1' };
    let release: (revoked: boolean) => void = () => undefined;
    let evaluations = 0;
    const codexSandboxWritesRevoked = jest.fn((): Promise<boolean> => {
      evaluations += 1;
      // The check when the thread opens settles; the next one hangs.
      return evaluations === 1
        ? Promise.resolve(false)
        : new Promise<boolean>((resolve) => {
            release = resolve;
          });
    });
    let callsWhileInFlight = -1;
    const handle = fakeHandle('thread-1', async (turn) => {
      turnStarted(turn, 'thread-1');
      // Events, policy changes and timer ticks while one evaluation hangs.
      for (let index = 0; index < 30; index += 1) {
        state.key = `policy-${index + 2}`;
        itemStarted(turn, 'thread-1');
        await delay(20);
      }
      callsWhileInFlight = evaluations;
      release(false);
      return { status: 'completed', text: 'written' };
    });
    const harness = run({
      prepare: () =>
        Promise.resolve(
          preparation({
            tools: grantTools(state, { codexSandboxWritesRevoked }),
          }),
        ),
      handles: [handle],
    });
    expect(await harness.terminal).toMatchObject({
      status: 'completed',
      finalText: 'written',
    });
    expect(callsWhileInFlight).toBe(2);
    expect(handle.interrupt).not.toHaveBeenCalled();
  });

  it('opens the next thread read-only when a grant is denied by the time it opens', async () => {
    const controller = new DelegationCapabilityReloadController();
    const state = { denied: false, key: 'policy-1' };
    const setCodexTurnWrites = jest.fn();
    const prepareCodexSandboxWrites = jest.fn(() => Promise.resolve(grants));
    const sharedTools = grantTools(state, {
      setCodexTurnWrites,
      prepareCodexSandboxWrites,
    });
    const host: DelegationCapabilityReloadHost<CodexDelegationPreparation> = {
      apply: jest.fn(() => {
        state.denied = true;
        return Promise.resolve(preparation({ tools: sharedTools }));
      }),
      restore: jest.fn(() => Promise.reject(new Error('unused'))),
    };
    const first = fakeHandle('thread-1', loads(controller));
    const second = fakeHandle('thread-2', completes('after reload'));
    const harness = run({
      prepare: () =>
        Promise.resolve(
          preparation({
            tools: sharedTools,
            capabilityReload: { controller, host },
          }),
        ),
      handles: [first, second],
    });
    await harness.terminal;
    expect(recordOf(recordOf(harness.started[0]).params).permissions).toBe(
      'delegated_write',
    );
    expect(harness.runtime.resumeThread).not.toHaveBeenCalled();
    expect(recordOf(recordOf(harness.materialized[0]).params).permissions).toBe(
      'delegated_read_only',
    );
    expect(
      filesystemProfiles(harness.materialized[0]).delegated_write,
    ).toBeUndefined();
    expect(setCodexTurnWrites.mock.calls).toEqual([[true], [false]]);
    expect(second.turns[0]?.input.map((item) => item.text)).toEqual([
      DEFERRED_TOOLS_RELOAD_CONTINUATION_TEMPLATE,
      CODEX_DELEGATION_GRANTS_REVOKED_CONTINUATION,
    ]);
    // Preimages are still captured once for the policy.
    expect(prepareCodexSandboxWrites).toHaveBeenCalledTimes(1);
  });

  it('admits grants on a later thread once the parent allows them again', async () => {
    const controller = new DelegationCapabilityReloadController();
    const state = { denied: true, key: 'policy-1' };
    // Denied grants are omitted when preparing, which then captures nothing.
    const prepareCodexSandboxWrites = jest.fn(() =>
      Promise.resolve(state.denied ? [] : grants),
    );
    const sharedTools = grantTools(state, { prepareCodexSandboxWrites });
    const host: DelegationCapabilityReloadHost<CodexDelegationPreparation> = {
      apply: jest.fn(() => {
        state.denied = false;
        return Promise.resolve(preparation({ tools: sharedTools }));
      }),
      restore: jest.fn(() => Promise.reject(new Error('unused'))),
    };
    const first = fakeHandle('thread-1', loads(controller));
    const second = fakeHandle('thread-2', completes('after reload'));
    const harness = run({
      prepare: () =>
        Promise.resolve(
          preparation({
            tools: sharedTools,
            capabilityReload: { controller, host },
          }),
        ),
      handles: [first, second],
    });
    await harness.terminal;
    expect(recordOf(recordOf(harness.started[0]).params).permissions).toBe(
      'delegated_read_only',
    );
    expect(
      filesystemProfiles(harness.started[0]).delegated_write,
    ).toBeUndefined();
    expect(recordOf(recordOf(harness.materialized[0]).params).permissions).toBe(
      'delegated_write',
    );
    expect(prepareCodexSandboxWrites).toHaveBeenCalledTimes(2);
    expect(second.turns[0]?.input.map((item) => item.text)).toEqual([
      DEFERRED_TOOLS_RELOAD_CONTINUATION_TEMPLATE,
    ]);
  });
});

describe('Codex provider turn errors', () => {
  const failing =
    (error: string, text = '', errorInfo?: string): TurnScript =>
    () =>
      Promise.resolve({
        status: 'failed',
        text,
        error,
        ...(errorInfo ? { errorInfo } : {}),
      });

  beforeEach(() => {
    clearDelegationModelRejections();
  });

  it('reports a model the account cannot use as an unavailable route and remembers it', async () => {
    const harness = run({
      prepare: () => Promise.resolve(preparation()),
      handles: [
        fakeHandle(
          'thread-1',
          failing(
            JSON.stringify({
              type: 'error',
              status: 400,
              error: {
                type: 'invalid_request_error',
                message:
                  "The 'gpt-test' model is not supported when using Codex with a ChatGPT account.",
              },
            }),
            '',
            'other',
          ),
        ),
      ],
      runRequest: {
        ...request,
        route: { ...request.route, authAccountKey: 'account-1' },
      },
    });
    const terminal = await harness.terminal;
    expect(terminal).toMatchObject({
      status: 'failed',
      error: { code: 'route_unavailable', retryable: false },
    });
    const message =
      terminal.type === 'terminal' ? (terminal.error?.message ?? '') : '';
    expect(message).toContain(
      "The 'gpt-test' model is not supported when using Codex with a ChatGPT account.",
    );
    expect(message).not.toContain('partial output');
    expect(
      isDelegationModelRejected({
        accountKey: 'account-1',
        modelId: 'gpt-test',
      }),
    ).toBe(true);
    expect(
      isDelegationModelRejected({
        accountKey: 'account-2',
        modelId: 'gpt-test',
      }),
    ).toBe(false);
  });

  it('reports a provider authentication failure as sign-in required', async () => {
    const harness = run({
      prepare: () => Promise.resolve(preparation()),
      handles: [
        fakeHandle(
          'thread-1',
          failing('unexpected status 401 Unauthorized', '', 'unauthorized'),
        ),
      ],
    });
    expect(await harness.terminal).toMatchObject({
      status: 'failed',
      error: { code: 'auth_required', retryable: false },
    });
  });

  it('carries a bounded, redacted provider message and mentions partial output only when there is some', async () => {
    const secret = 'sk-proj-' + 'A1b2C3d4'.repeat(6);
    const harness = run({
      prepare: () => Promise.resolve(preparation()),
      handles: [
        fakeHandle(
          'thread-1',
          failing(
            `stream disconnected: Authorization: Bearer ${secret} ${'x'.repeat(2000)}`,
            'Half an answer',
          ),
        ),
      ],
    });
    const terminal = await harness.terminal;
    expect(terminal).toMatchObject({
      status: 'failed',
      finalText: 'Half an answer',
      error: { code: 'runtime_error', retryable: false },
    });
    const message =
      terminal.type === 'terminal' ? (terminal.error?.message ?? '') : '';
    expect(message).toContain('stream disconnected');
    expect(message).not.toContain(secret);
    expect(message).toContain('Retained partial output is available.');
    expect(message.length).toBeLessThanOrEqual(700);

    const empty = run({
      prepare: () => Promise.resolve(preparation()),
      handles: [fakeHandle('thread-2', failing('Upstream overloaded'))],
    });
    const emptyTerminal = await empty.terminal;
    const emptyMessage =
      emptyTerminal.type === 'terminal'
        ? (emptyTerminal.error?.message ?? '')
        : '';
    expect(emptyMessage).toContain('Upstream overloaded');
    expect(emptyMessage).not.toContain('partial output');
  });
});

describe('Codex delegate repository instructions', () => {
  const projectDocConfig = {
    project_doc_max_bytes: 131_072,
    project_doc_fallback_filenames: ['CLAUDE.md'],
  };

  it('re-supplies the project doc config on thread start and resume', async () => {
    const started = run({
      prepare: () =>
        Promise.resolve(preparation({ config: { model_provider: 'openai' } })),
      handles: [fakeHandle('thread-1', completes('started'))],
    });
    await started.terminal;
    expect(recordOf(started.started[0]).params).toMatchObject({
      config: { ...projectDocConfig, model_provider: 'openai' },
    });

    const resumed = run({
      prepare: () => Promise.resolve(preparation()),
      handles: [fakeHandle('thread-0', completes('resumed'))],
      runRequest: { ...request, resumeSessionId: 'thread-0' },
    });
    await resumed.terminal;
    expect(resumed.resumed).toHaveLength(1);
    expect(recordOf(resumed.resumed[0]).params).toMatchObject({
      threadId: 'thread-0',
      config: projectDocConfig,
    });
  });
});
