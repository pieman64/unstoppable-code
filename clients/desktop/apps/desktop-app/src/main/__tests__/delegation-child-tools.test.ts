import {
  DelegationParent,
  type DelegationParentBroker,
} from '@canopy/desktop-shared/node/delegation/parent';
import type { AgentRunRequest } from '@canopy/desktop-shared/node/delegation';
import { routeFixture } from '@canopy/desktop-shared/node/delegation/__tests__/fixtures';
import { CANOPY_INJECTED_TOOL_REGISTRY } from '@canopy/desktop-shared/lib/canopy-injected-tools';
import type { WorkspaceType } from '@canopy/desktop-shared/types';
import type {
  AgentDelegationSnapshot,
  AgentDelegationError,
} from '@canopy/protocol/delegation';
import type { DelegateCanopyToolCallContext } from '../agents/delegation/canopy-tools';
import {
  createClaudeChildTools,
  createClaudeDelegateTools,
  createCodexChildTools,
  createCodexDelegateTools,
  childDelegationGuidance,
} from '../agents/delegation/child-tools';
import {
  childLedgerGuidance,
  openChildLedgerTools,
  retainChildLedgerTools,
  type ChildLedgerTools,
} from '../agents/delegation/ledger-tools';
import type { LocalDelegationContext } from '@canopy/desktop-shared/node/delegation/local-runner';
import { createDesktopRuntime } from '../canopy-runtime/desktop-runtime';
import {
  addLedgerEntryJsonSchema,
  searchLedgerEntriesJsonSchema,
  updateLedgerEntryJsonSchema,
} from '../canopy-tools/definitions';
import type {
  LedgerToolsDispatcher,
  LedgerToolsHost,
} from '../canopy-tools/ledger-tools-runtime';
import type { CanopyInjectedToolTextResult } from '../canopy-tools/core';
import {
  TEST_CONTAINER_CREATED_AT,
  createLedgerServiceHarness,
} from '../ledger/__tests__/fixtures/in-process-ledger-store-client';
interface MockDefinition {
  name: string;
  description: string;
  handler: (
    input: unknown,
    extra?: unknown,
  ) => Promise<{ isError: boolean; content?: { text: string }[] }>;
}
const mockDefinitions: MockDefinition[] = [];
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: jest.fn((value: unknown): unknown => value),
  tool: jest.fn(
    (
      name: string,
      description: string,
      _schema: unknown,
      handler: MockDefinition['handler'],
    ): MockDefinition => {
      const definition = { name, description, handler };
      mockDefinitions.push(definition);
      return definition;
    },
  ),
}));

beforeEach(() => {
  mockDefinitions.length = 0;
});

const LEDGER = CANOPY_INJECTED_TOOL_REGISTRY;

function fakeLedger(
  result: CanopyInjectedToolTextResult = { text: '{"ok":true}' },
): ChildLedgerTools & { execute: jest.Mock; dispose: jest.Mock } {
  return {
    execute: jest.fn(() => Promise.resolve(result)),
    systemPrompt: (): string => 'Ledger block',
    dispose: jest.fn(),
  };
}

/** The parent chat's approval policy for app-owned and Ledger tools. */
function parentPolicy(
  allow = true,
): jest.Mock<Promise<boolean>, [string, boolean, string, AbortSignal?]> {
  return jest.fn<Promise<boolean>, [string, boolean, string, AbortSignal?]>(
    () => Promise.resolve(allow),
  );
}

function parent(
  enableDelegationTools = true,
  delegationToolsWithheld?: 'not_enabled' | 'depth_limit',
  spawnError?: AgentDelegationError,
): DelegationParent {
  const snapshot: AgentDelegationSnapshot = {
    delegationId: 'grandchild',
    status: 'pending',
    outputTruncated: false,
  };
  const broker: DelegationParentBroker = {
    spawn: jest.fn(() =>
      Promise.resolve(
        spawnError
          ? { ok: false, error: spawnError }
          : { ok: true, value: snapshot },
      ),
    ),
    getOutput: jest.fn(() =>
      Promise.resolve({
        ok: true,
        value: {
          delegationId: 'grandchild',
          currentRunGeneration: 1,
          currentStatus: 'pending',
          latestResultIndex: null,
          result: null,
        },
      }),
    ),
    inspect: jest.fn(() => undefined),
    list: jest.fn(() => []),
    stop: jest.fn(() => ({ ok: true, value: snapshot })),
    closeOwner: jest.fn(() => Promise.resolve()),
    manageWorktree: jest.fn(() =>
      Promise.resolve({ ok: true, value: snapshot }),
    ),
    message: jest.fn(() => Promise.resolve({ ok: true, value: snapshot })),
  };
  return new DelegationParent({
    owner: {
      harnessId: 'claude',
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'c',
      sessionKey: 's',
      runtimeGeneration: 1,
      depth: 1,
      parentDelegationId: 'child',
      parentRunGeneration: 1,
    },
    harness: 'claude',
    namespace: 'canopy',
    names: {
      spawn: 'DelegateTask',
      inspect: 'InspectDelegate',
      list: 'ListDelegates',
      output: 'GetDelegateOutput',
      stop: 'StopDelegate',
      manageWorktree: 'ManageDelegateWorktree',
      message: 'MessageDelegate',
      requestSteering: 'RequestSteering',
    },
    broker,
    currentTurn: () => 'owned-turn',
    removeQueued: () => Promise.resolve(),
    reportError: jest.fn(),
    enableDelegationTools,
    ...(delegationToolsWithheld ? { delegationToolsWithheld } : {}),
    requestSteering: jest.fn(() => Promise.resolve({ ok: true, value: {} })),
  });
}

it('preserves the non-retryable lifetime refusal through both child adapters', async () => {
  const error: AgentDelegationError = {
    code: 'lifetime_limit_reached',
    message:
      'This worktree has reached its lifetime subagent limit. This is the most this build allows.',
    retryable: false,
  };
  const input = {
    model: 'model',
    description: 'Review',
    prompt: 'Review file',
  };
  const claude = createClaudeChildTools(parent(true, undefined, error));
  const approved = claude.bind(
    'mcp__canopy__DelegateTask',
    input,
    'lifetime-call',
  );
  if (!approved.ok) throw new Error('Expected host binding');
  const definition = mockDefinitions.find(
    (entry) => entry.name === 'DelegateTask',
  );
  if (!definition) throw new Error('Missing tool');
  const claudeResult = await definition.handler(approved.value);
  expect(claudeResult.isError).toBe(true);
  expect(JSON.parse(claudeResult.content?.[0]?.text ?? 'null')).toEqual({
    ok: false,
    error,
  });
  const codex = createCodexChildTools(
    parent(true, undefined, error),
    'native-child',
  );
  const codexResult = await codex.policy.execute(
    {
      threadId: 'native-child',
      turnId: 'owned-turn',
      callId: 'lifetime-call',
      namespace: null,
      tool: 'DelegateTask',
      arguments: input,
    },
    new AbortController().signal,
  );
  expect(codexResult.success).toBe(false);
  expect(codexResult.contentItems).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: 'inputText',
        text: JSON.stringify({ ok: false, error }),
      }),
    ]),
  );
});

it('only exposes managed tools and requires a native Claude hook binding', async () => {
  const owner = parent();
  const bridge = createClaudeChildTools(owner);
  const input = {
    model: 'model',
    description: 'Review',
    prompt: 'Review file',
  };
  const approved = bridge.bind('mcp__canopy__DelegateTask', input, 'call');
  expect(approved.ok).toBe(true);
  if (!approved.ok) throw new Error('Expected host binding');
  const definition = mockDefinitions.find(
    (entry) => entry.name === 'DelegateTask',
  );
  if (!definition) throw new Error('Missing SDK tool definition');
  expect((await definition.handler(input)).isError).toBe(true);
  expect((await definition.handler(approved.value)).isError).toBe(false);
  expect(
    bridge.bind('mcp__canopy__DelegateTask', approved.value, 'forged').ok,
  ).toBe(false);
  expect(bridge.owns('Agent')).toBe(false);
  owner.detach();
  expect((await definition.handler(approved.value)).isError).toBe(true);
});

it('rejects Codex calls from another native thread', async () => {
  const owner = parent();
  const bridge = createCodexChildTools(owner, 'native-child');
  const call = {
    threadId: 'other-thread',
    turnId: 'turn',
    callId: 'call',
    namespace: null,
    tool: 'DelegateTask',
    arguments: {},
  };
  expect(
    (await bridge.policy.execute(call, new AbortController().signal)).success,
  ).toBe(false);
  expect(bridge.specs.map((spec) => spec.name)).toContain('DelegateTask');
});

it.each([
  [
    'its parent did not enable nesting',
    'not_enabled',
    'Your parent did not enable nested delegation',
  ],
  [
    "it is at the user's maximum depth",
    'depth_limit',
    "at the user's maximum delegation depth",
  ],
] as const)(
  'tells a child without delegation tools that %s',
  (_case, withheld, reason) => {
    const guidance = childDelegationGuidance(parent(false, withheld));
    expect(guidance).toContain(reason);
    expect(guidance).toContain('Request Steering');
    expect(guidance).not.toContain('Watch Delegates');
  },
);

it('gives no withheld reason to a child that has delegation tools', () => {
  const owner = parent(true, 'not_enabled');
  expect(owner.delegationToolsWithheld).toBeUndefined();
  expect(childDelegationGuidance(owner)).not.toContain(
    'did not enable nested delegation',
  );
});

it.each([
  ['claude', 'RequestSteering'],
  ['codex', 'RequestSteering'],
] as const)(
  'exposes only upward communication to a leaf %s child',
  (harness, requestSteering) => {
    const owner = parent(false);
    expect(childDelegationGuidance(owner)).toContain('Request Steering');
    expect(childDelegationGuidance(owner)).not.toContain('Watch Delegates');
    if (harness === 'claude') {
      const bridge = createClaudeChildTools(owner);
      expect(mockDefinitions.map((definition) => definition.name)).toContain(
        requestSteering,
      );
      expect(bridge.owns('mcp__canopy__RequestSteering')).toBe(true);
      expect(bridge.owns('mcp__canopy__DelegateTask')).toBe(false);
      return;
    }
    const bridge = createCodexChildTools(owner, 'native-child');
    expect(bridge.specs.map((spec) => spec.name)).toEqual([requestSteering]);
  },
);

describe('Ledger tools for a managed delegate', () => {
  it('lists the Ledger tools on the Claude child server with delegate-bound handlers', async () => {
    const ledger = fakeLedger();
    const policy = parentPolicy();
    const bridge = createClaudeChildTools(parent(false), ledger, policy);
    const input = { type: 'TASK', title: 'Review', content: 'Review it.' };

    const names = mockDefinitions.map((definition) => definition.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'RequestSteering',
        'AddFeedEntry',
        'SearchFeedEntries',
        'UpdateFeedEntry',
      ]),
    );
    // Like app-owned tools, Ledger calls are approved when they run, under
    // the parent's policy, not pre-approved by the host binding.
    expect(bridge.owns(LEDGER.add_ledger_entry.claudeToolName)).toBe(false);
    expect(bridge.ownsAppTool(LEDGER.add_ledger_entry.claudeToolName)).toBe(
      true,
    );
    expect(bridge.ownsAppTool(LEDGER.update_ledger_entry.claudeToolName)).toBe(
      true,
    );
    const add = mockDefinitions.find(
      (definition) => definition.name === 'AddFeedEntry',
    );
    if (!add) throw new Error('Missing AddFeedEntry');

    const result = await add.handler(input, {
      _meta: { 'claudecode/toolUseId': 'toolu_1' },
    });

    expect(policy).toHaveBeenCalledWith(
      'AddFeedEntry',
      false,
      'toolu_1',
      undefined,
    );
    expect(ledger.execute).toHaveBeenCalledWith('add_ledger_entry', input, {
      invocationId: 'claude:toolu_1',
    });
    expect(result).toEqual({
      content: [{ type: 'text', text: '{"ok":true}' }],
      isError: false,
    });
    expect(childLedgerGuidance(ledger)).toBe('\nLedger block');
  });

  it.each([
    ['the parent policy denies it', parentPolicy(false)],
    ['no parent policy is supplied', undefined],
  ])('refuses a Claude child Ledger call when %s', async (_case, policy) => {
    const ledger = fakeLedger();
    createClaudeChildTools(parent(false), ledger, policy);
    const add = mockDefinitions.find(
      (definition) => definition.name === 'AddFeedEntry',
    );
    if (!add) throw new Error('Missing AddFeedEntry');

    await expect(
      add.handler(
        { type: 'TASK', title: 'Review', content: 'Review it.' },
        { _meta: { 'claudecode/toolUseId': 'toolu_2' } },
      ),
    ).resolves.toMatchObject({ isError: true });
    expect(ledger.execute).not.toHaveBeenCalled();
  });

  it('reports a refused Ledger call as a Claude tool error', async () => {
    const ledger = fakeLedger({ text: '{"ok":false}', isError: true });
    const policy = parentPolicy();
    createClaudeChildTools(parent(false), ledger, policy);
    const search = mockDefinitions.find(
      (definition) => definition.name === 'SearchFeedEntries',
    );
    if (!search) throw new Error('Missing SearchFeedEntries');

    await expect(search.handler({}, {})).resolves.toMatchObject({
      isError: true,
    });
    expect(ledger.execute).toHaveBeenCalledWith(
      'search_ledger_entries',
      {},
      {},
    );
    // Searching changes nothing, so it stays available while the parent plans.
    expect(policy).toHaveBeenCalledWith(
      'SearchFeedEntries',
      true,
      expect.any(String),
      undefined,
    );
  });

  it('serves the Codex child Ledger tools from the delegate runtime on its own thread only', async () => {
    const ledger = fakeLedger();
    const policy = parentPolicy();
    const bridge = createCodexChildTools(
      parent(false),
      'native-child',
      ledger,
      policy,
    );
    const call = {
      threadId: 'native-child',
      turnId: 'turn-1',
      callId: 'call-1',
      namespace: null,
      tool: LEDGER.add_ledger_entry.codexToolName,
      arguments: { type: 'TASK', title: 'Review', content: 'Review it.' },
    };
    const signal = new AbortController().signal;

    expect(bridge.specs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: LEDGER.add_ledger_entry.codexToolName,
          inputSchema: addLedgerEntryJsonSchema,
        }),
        expect.objectContaining({
          name: LEDGER.search_ledger_entries.codexToolName,
          inputSchema: searchLedgerEntriesJsonSchema,
        }),
        expect.objectContaining({
          name: LEDGER.update_ledger_entry.codexToolName,
          inputSchema: updateLedgerEntryJsonSchema,
        }),
      ]),
    );
    expect(bridge.policy.allowedTools).toContainEqual({
      namespace: null,
      tool: LEDGER.add_ledger_entry.codexToolName,
    });
    await expect(bridge.policy.authorize(call, signal)).resolves.toBe(true);
    expect(policy).toHaveBeenCalledWith(
      'AddFeedEntry',
      false,
      'call-1',
      signal,
    );
    await expect(
      bridge.policy.authorize({ ...call, threadId: 'other' }, signal),
    ).resolves.toBe(false);
    expect(policy).toHaveBeenCalledTimes(1);

    await expect(bridge.policy.execute(call, signal)).resolves.toEqual({
      success: true,
      contentItems: [{ type: 'inputText', text: '{"ok":true}' }],
    });
    expect(ledger.execute).toHaveBeenCalledWith(
      'add_ledger_entry',
      call.arguments,
      { invocationId: 'codex:native-child:turn-1:call-1', signal },
    );
    await expect(
      bridge.policy.execute({ ...call, threadId: 'other' }, signal),
    ).resolves.toMatchObject({ success: false });
    expect(ledger.execute).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['the parent policy denies it', parentPolicy(false)],
    ['no parent policy is supplied', undefined],
  ])('refuses a Codex child Ledger call when %s', async (_case, policy) => {
    const bridge = createCodexChildTools(
      parent(false),
      'native-child',
      fakeLedger(),
      policy,
    );

    await expect(
      bridge.policy.authorize(
        {
          threadId: 'native-child',
          turnId: 'turn-1',
          callId: 'call-1',
          namespace: null,
          tool: LEDGER.add_ledger_entry.codexToolName,
          arguments: {},
        },
        new AbortController().signal,
      ),
    ).resolves.toBe(false);
  });

  it('opens Ledger tools only for a run with a live delegation parent, and disposes them with the run', async () => {
    const ledger = fakeLedger();
    const open = jest.fn(
      (): Promise<ChildLedgerTools | undefined> => Promise.resolve(ledger),
    );
    const closers: (() => Promise<void>)[] = [];
    const context: LocalDelegationContext = {
      request: {
        delegationId: 'delegation-1',
        runGeneration: 1,
        launchKey: 'launch-1',
        parent: {
          harnessId: 'claude',
          projectId: 'p',
          worktreeId: 'w',
          chatId: 'c',
          sessionKey: 's',
          turnId: 't',
          toolCallId: 'call',
          runtimeGeneration: 1,
          depth: 0,
        },
        task: {
          modelId: 'model',
          description: 'Review',
          prompt: 'Review it.',
          executionMode: 'background',
          contextPolicy: 'task_only',
          isolation: 'shared_worktree',
        },
        route: routeFixture({ harnessId: 'claude' }),
        cwd: '/worktree',
        effectivePermission: 'read-only',
        signal: new AbortController().signal,
      },
      signal: new AbortController().signal,
      emit: () => Promise.resolve(),
      retain: (close) => {
        closers.push(close);
      },
      setInterrupt: () => undefined,
      setSteer: () => undefined,
    };

    await expect(
      retainChildLedgerTools(context, undefined, open),
    ).resolves.toBeUndefined();
    expect(open).not.toHaveBeenCalled();

    await expect(
      retainChildLedgerTools(context, parent(false), open),
    ).resolves.toBe(ledger);
    expect(ledger.dispose).not.toHaveBeenCalled();
    await Promise.all(closers.map((close) => close()));
    expect(ledger.dispose).toHaveBeenCalledTimes(1);
  });

  it('adds no Ledger tools when the Ledger is not exposed', () => {
    const claude = createClaudeChildTools(parent(false));
    const codex = createCodexChildTools(parent(false), 'native-child');

    expect(mockDefinitions.map((definition) => definition.name)).toEqual([
      'RequestSteering',
    ]);
    expect(claude.owns(LEDGER.add_ledger_entry.claudeToolName)).toBe(false);
    expect(codex.specs.map((spec) => spec.name)).toEqual(['RequestSteering']);
    expect(childLedgerGuidance(undefined)).toBe('');
  });

  describe('through a real Ledger', () => {
    const harness = createLedgerServiceHarness();
    const dispatcher = createDesktopRuntime({
      services: {
        listFileTreeRoots: (): Promise<{ roots: [] }> =>
          Promise.resolve({ roots: [] }),
        listFileTreeDirectory: (): Promise<{ entries: [] }> =>
          Promise.resolve({ entries: [] }),
      },
      ledgerService: harness.service,
    });
    let flag = true;
    const host: LedgerToolsHost = {
      dispatcher: (): LedgerToolsDispatcher => dispatcher,
      registry: (): typeof harness.bindings => harness.bindings,
      isFlagEnabled: (): boolean => flag,
      isRecordingEnabled: (): Promise<boolean> => Promise.resolve(true),
      workspaceType: (): WorkspaceType => 'single-repo',
      containerCreatedAt: (): Promise<string> =>
        Promise.resolve(TEST_CONTAINER_CREATED_AT),
      chatTitle: (): Promise<string> => Promise.resolve('Chat one'),
      databaseMayExist: (): Promise<boolean> => Promise.resolve(true),
    };
    const request: AgentRunRequest = {
      delegationId: 'delegation-1',
      runGeneration: 1,
      launchKey: 'launch-1',
      parent: {
        harnessId: 'claude',
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        sessionKey: 'workspace-1/worktree-1/chat-1',
        turnId: 'turn-1',
        toolCallId: 'call-1',
        runtimeGeneration: 7,
        depth: 0,
      },
      task: {
        modelId: 'gpt-5-codex',
        description: 'Review delegate',
        prompt: 'Review the change.',
        executionMode: 'background',
        contextPolicy: 'task_only',
        isolation: 'shared_worktree',
      },
      route: routeFixture({ harnessId: 'codex', runtimeModelId: 'gpt-5' }),
      cwd: '/worktree',
      effectivePermission: 'read-only',
      signal: new AbortController().signal,
    };

    afterAll(async () => {
      await dispatcher.shutdown();
      harness.dispose();
    });

    function codexCall(
      tool: string,
      args: Parameters<
        ReturnType<typeof createCodexChildTools>['policy']['execute']
      >[0]['arguments'],
      callId: string,
    ): Parameters<
      ReturnType<typeof createCodexChildTools>['policy']['execute']
    >[0] {
      return {
        threadId: 'native-child',
        turnId: 'turn-1',
        callId,
        namespace: null,
        tool,
        arguments: args,
      };
    }

    function textOf(
      response: Awaited<
        ReturnType<
          ReturnType<typeof createCodexChildTools>['policy']['execute']
        >
      >,
    ): Record<string, unknown> {
      const item = response.contentItems[0];
      if (item?.type !== 'inputText') throw new Error('Expected text');
      const parsed: unknown = JSON.parse(item.text);
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        Array.isArray(parsed)
      )
        throw new Error('Expected an object');
      return Object.fromEntries(Object.entries(parsed));
    }

    it('records the entry as the delegate with its lineage, and cannot write as its parent', async () => {
      const chatBinding = harness.register();
      const parentEntry = await harness.service.addEntry(
        {
          type: 'TASK',
          title: 'Parent task',
          content: 'Owned by the chat.',
          _meta: { idempotencyKey: 'parent-add' },
        },
        harness.context(chatBinding, 'parent-add'),
      );
      const tools = await openChildLedgerTools(request, {
        isLive: (): boolean => true,
        lineage: undefined,
        host,
      });
      if (tools === null) throw new Error('Expected delegate tools');
      const bridge = createCodexChildTools(
        parent(false),
        'native-child',
        tools,
      );
      const signal = new AbortController().signal;

      const added = await bridge.policy.execute(
        codexCall(
          LEDGER.add_ledger_entry.codexToolName,
          { type: 'TASK', title: 'Delegate task', content: 'Owned by me.' },
          'call-add',
        ),
        signal,
      );
      const refused = await bridge.policy.execute(
        codexCall(
          LEDGER.update_ledger_entry.codexToolName,
          {
            entryId: parentEntry.entry.entryId,
            expectedRevision: 1,
            status: 'BLOCKED',
          },
          'call-update',
        ),
        signal,
      );

      expect(added.success).toBe(true);
      const addedEntry = textOf(added).entry;
      if (
        typeof addedEntry !== 'object' ||
        addedEntry === null ||
        !('entryId' in addedEntry) ||
        typeof addedEntry.entryId !== 'string'
      )
        throw new Error('Expected an entry');
      const detail = await harness.service.getEntry(
        { entryId: addedEntry.entryId },
        harness.context(harness.registerUser()),
      );
      expect(detail.entry.author.kind).toBe('managed_delegation');
      expect(detail.entry.author.actorId).not.toBe(
        parentEntry.entry.author.actorId,
      );
      expect(detail.entry.authorDetails).toMatchObject({
        harness: 'codex',
        model: 'gpt-5',
      });
      expect(detail.entry.origin).toEqual({
        kind: 'managed_delegation',
        ledgerId: detail.entry.scope.ledgerId,
        delegationId: 'delegation-1',
        parentActorId: parentEntry.entry.author.actorId,
        root: { kind: 'chat', chatId: 'chat-1' },
        runGeneration: 1,
      });
      expect(refused.success).toBe(false);
      expect(textOf(refused)).toMatchObject({ error: { code: 'FORBIDDEN' } });
      tools.dispose();
    });

    it('opens no delegate tools without the flag, so the child projection is unchanged', async () => {
      flag = false;
      try {
        await expect(
          openChildLedgerTools(request, {
            isLive: (): boolean => true,
            lineage: undefined,
            host,
          }),
        ).resolves.toBeNull();
      } finally {
        flag = true;
      }
    });

    it('opens no delegate tools for a harness without a Ledger projection', async () => {
      await expect(
        openChildLedgerTools(
          { ...request, route: routeFixture() },
          { isLive: (): boolean => true, lineage: undefined, host },
        ),
      ).resolves.toBeNull();
    });
  });
});

describe('app-owned tools beside delegation tools', () => {
  const appTool = {
    key: 'search_memory' as const,
    name: 'SearchMemory',
    codexName: 'canopy_search_memory',
    description: 'Search saved memory.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
    readOnly: true,
  };
  function appTools(authorized = true): {
    tools: (typeof appTool)[];
    isolated: boolean;
    toolForClaudeName: (name: string) => typeof appTool | undefined;
    toolForCodexName: (name: string) => typeof appTool | undefined;
    authorize: jest.Mock<Promise<boolean>, [typeof appTool, unknown]>;
    run: jest.Mock<
      Promise<{ text: string }>,
      [typeof appTool, unknown, unknown]
    >;
    execute: jest.Mock<
      Promise<{ text: string; isError?: boolean }>,
      [typeof appTool, unknown, DelegateCanopyToolCallContext]
    >;
  } {
    return {
      tools: [appTool],
      isolated: false,
      toolForClaudeName: (name) =>
        name === 'mcp__canopy__SearchMemory' ? appTool : undefined,
      toolForCodexName: (name) =>
        name === 'canopy_search_memory' ? appTool : undefined,
      authorize: jest.fn<Promise<boolean>, [typeof appTool, unknown]>(() =>
        Promise.resolve(authorized),
      ),
      run: jest.fn<
        Promise<{ text: string }>,
        [typeof appTool, unknown, unknown]
      >(() => Promise.resolve({ text: 'memory hit' })),
      execute: jest.fn<
        Promise<{ text: string; isError?: boolean }>,
        [typeof appTool, unknown, DelegateCanopyToolCallContext]
      >(() => Promise.resolve({ text: 'memory hit' })),
    };
  }
  const call = {
    threadId: 'native-child',
    turnId: 'turn',
    callId: 'call-1',
    namespace: null,
    tool: 'canopy_search_memory',
    arguments: { query: 'build' },
  };

  it('serves app tools to a Claude child without delegation authority', async () => {
    mockDefinitions.length = 0;
    const tools = appTools();
    const bridge = createClaudeDelegateTools({
      namespace: 'canopy',
      appTools: tools,
    });
    expect(bridge?.ownsAppTool('mcp__canopy__SearchMemory')).toBe(true);
    expect(bridge?.ownsAppTool('mcp__canopy__SetupWatchers')).toBe(false);
    expect(bridge?.owns('mcp__canopy__DelegateTask')).toBe(false);
    expect(mockDefinitions.map((definition) => definition.name)).toEqual([
      'SearchMemory',
    ]);
    await mockDefinitions[0]?.handler({ query: 'build' });
    expect(tools.execute).toHaveBeenCalledTimes(1);
    const [calledTool, calledInput, calledContext] =
      tools.execute.mock.calls[0] ?? [];
    expect(calledTool).toBe(appTool);
    expect(calledInput).toEqual({ query: 'build' });
    expect(calledContext?.callId).toMatch(/^.+$/);
  });

  it('offers no Claude server when a child has neither tool set', () => {
    expect(createClaudeDelegateTools({ namespace: 'canopy' })).toBeUndefined();
  });

  it('shares one Codex host policy between delegation and app tools', async () => {
    const tools = appTools();
    const owner = parent();
    const bridge = createCodexDelegateTools({
      delegation: owner,
      appTools: tools,
      threadId: 'native-child',
    });
    if (!bridge) throw new Error('Expected Codex host tools');
    expect(bridge.specs.map((spec) => spec.name)).toEqual([
      ...createCodexChildTools(owner, 'native-child').specs.map(
        (spec) => spec.name,
      ),
      'canopy_search_memory',
    ]);
    // Delegate tool calls have no deadline; the turn's owner ends them.
    expect(bridge.policy.timeoutMs).toBeUndefined();
    expect(
      createCodexChildTools(owner, 'native-child').policy.timeoutMs,
    ).toBeUndefined();
    const signal = new AbortController().signal;
    await expect(bridge.policy.authorize(call, signal)).resolves.toBe(true);
    expect(tools.authorize).toHaveBeenCalledWith(appTool, {
      callId: 'call-1',
      signal,
    });
    await expect(bridge.policy.execute(call, signal)).resolves.toEqual({
      success: true,
      contentItems: [{ type: 'inputText', text: 'memory hit' }],
    });
    await expect(
      bridge.policy.authorize({ ...call, threadId: 'other-thread' }, signal),
    ).resolves.toBe(false);
  });

  it('denies a Codex app tool call the parent approval policy rejects', async () => {
    const bridge = createCodexDelegateTools({
      appTools: appTools(false),
      threadId: 'native-child',
    });
    await expect(
      bridge?.policy.authorize(call, new AbortController().signal),
    ).resolves.toBe(false);
  });
});
