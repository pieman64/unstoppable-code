import { runRtkRewrite } from '@canopy/desktop-shared/node/rtk/rewrite';
import { authorizeOpenCodeNativeTool } from '../opencode/tool-approval';
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { mkdtemp, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  registerSession,
  drainChatSessionEvents,
} from '../agents/session-manager';
import { CANOPY_INJECTED_TOOL_REGISTRY } from '@canopy/desktop-shared/lib/canopy-injected-tools';
import { cursorCanopyMcpServerNames } from '@canopy/desktop-shared/lib/cursor-mcp-tool-call';
import type { AgentSessionOptions } from '../agents/types';
import { OpenCodeProvider } from '../agents/opencode-session';
import { runOpenCodeTurn } from '@canopy/desktop-shared/node/opencode/turn-driver';
import type { CursorCapabilityProjection } from '@canopy/desktop-shared/lib/cursor-capabilities';

import { getOpenCodeSessionProfile } from '../opencode/session-profile';
const mockForkContext = jest.fn<Promise<string | undefined>, [unknown]>(() =>
  Promise.resolve(undefined),
);
jest.mock('../opencode/fork-context', () => ({
  readOpenCodeForkContext: (scope: unknown) => mockForkContext(scope),
}));

const mockMarkDeferredDelivered = jest.fn<boolean, [unknown, string]>(
  () => true,
);
jest.mock('../deferred-tools/reload-coordinator', () => ({
  deferredToolsReloadCoordinator: {
    markOpenCodeResultDelivered: (scope: unknown, receipt: string) =>
      mockMarkDeferredDelivered(scope, receipt),
  },
}));

jest.mock('../memory/local/policy', () => ({
  resolveLocalMemoryPolicy: () => Promise.resolve({ kind: 'disabled' }),
}));
const mockPublishPlan = jest.fn<Promise<void>, [unknown]>(() =>
  Promise.resolve(),
);
jest.mock('../services/chat-state-plan-exit', () => ({
  publishOpenCodePlanProposal: (request: unknown) => mockPublishPlan(request),
}));
const mockRecordDiagnostic = jest.fn();
jest.mock('../observability', () => ({
  getObservabilityService: () => ({
    recordSessionDiagnostic: mockRecordDiagnostic,
  }),
}));

const mockCommands: CursorCapabilityProjection['commands'] = [];
const mockCompatibilityNotices: string[] = [];
const mockResolverWarnings: string[] = [];
const mockManagedDelegationEnabled = jest.fn(() => false);
const mockCreateManagedDelegationSession = jest.fn<Promise<unknown>, []>();
jest.mock('../agents/delegation/gate', () => ({
  managedDelegationEnabled: () => mockManagedDelegationEnabled(),
}));
jest.mock('../agents/delegation/service', () => ({
  createManagedDelegationSession: () => mockCreateManagedDelegationSession(),
}));

let mockDeclaredThinking: Array<'low' | 'medium' | 'high'> = [];
const mockAssertOpenCodeModelAvailable = jest.fn((model: string) =>
  Promise.resolve({
    id: model,
    supportedThinkingLevels: mockDeclaredThinking,
  }),
);
const mockWorkspace = { directory: '', cowork: true, localMemoryEnabled: true };
const mockProxy = {
  getMcpCapabilityDigests: jest.fn(() => ({})),
  getCanopyCapabilityDefinitions: jest.fn(() => []),
  registerCanopyWorktreeSessionRoute: jest.fn().mockResolvedValue(undefined),
  getCanopyWorktreeMcpUrl: jest.fn(() => 'http://localhost:1234/main'),
  getCanopyWorktreeUiMcpUrl: jest.fn(() => 'http://localhost:1234/ui'),
  setSessionToolCallGate: jest.fn(),
  unregisterRoutesForSession: jest.fn(),
  unregisterCanopyWorktreeSessionRoute: jest.fn(),
};
jest.mock('../mcp/http-proxy-service', () => ({
  getMcpHttpProxyService: () => mockProxy,
}));
jest.mock('../opencode/capability-snapshot', () => ({
  snapshotOpenCodeMcpTools: jest.fn(() => Promise.resolve([])),
}));
jest.mock('../opencode/connection', () => ({
  assertOpenCodeModelAvailable: (model: string) =>
    mockAssertOpenCodeModelAvailable(model),
  openManagedOpenCodeRuntime: jest.fn((options: { signal: AbortSignal }) =>
    Promise.resolve({
      executable: process.execPath,
      env: {},
      signal: options.signal,
      generation: 1,
      close: jest.fn(),
    }),
  ),
  assertOpenCodeConnectionGeneration: jest.fn(),
  listOpenCodeModels: jest.fn(),
}));
jest.mock('@canopy/desktop-shared/node/opencode/turn-driver', () => ({
  runOpenCodeTurn: jest.fn(() =>
    Promise.resolve({
      responseText: 'Done',
      sessionId: 'fixture-session',
      isError: false,
      cancelled: false,
      message: '',
      usage: {},
    }),
  ),
}));
jest.mock('../approvals/approval-service', () => ({
  createApprovalSession: jest.fn(() => ({
    dispose: jest.fn(),
    invalidatePending: jest.fn(),
  })),
}));
jest.mock('@canopy/desktop-shared/node/rtk/rewrite', () => ({
  runRtkRewrite: jest.fn(),
}));
jest.mock('../opencode/tool-approval', () => ({
  authorizeOpenCodeNativeTool: jest.fn(),
}));
jest.mock('../cursor/tool-approval', () => ({
  authorizeCursorMcpTool: jest.fn(),
}));
jest.mock('../lib/paths', () => ({
  getWorktreeDataDir: () => mockWorkspace.directory,
}));
jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeTargetIds: jest.fn(),
}));
jest.mock('../lib/workspace-registry', () => ({
  isCoworkWorkspace: () => mockWorkspace.cowork,
}));
jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: jest.fn(() =>
    Promise.resolve({
      localMemoryEnabled: mockWorkspace.localMemoryEnabled,
    }),
  ),
}));
jest.mock('../plugins/global-plugin-overlay', () => ({
  resolveEffectiveChatPluginContext: jest.fn(() =>
    Promise.resolve({
      selections: {
        collectionIds:
          mockCommands.length ||
          mockCompatibilityNotices.length ||
          mockResolverWarnings.length
            ? ['selected']
            : [],
        skillRefs: [],
        pluginRefs: [],
      },
    }),
  ),
}));
jest.mock('../plugins/plugin-resolver', () => ({
  resolvePlugins: jest.fn(() =>
    Promise.resolve({
      mcpServers: {},
      warnings: mockResolverWarnings,
      cursorNotices: mockCompatibilityNotices,
      cursorCapabilities: { skills: [], commands: mockCommands },
    }),
  ),
}));
jest.mock('@canopy/desktop-shared/node/cursor/capability-root', () => ({
  materializeSelectedCapabilityRoot: jest.fn(() =>
    Promise.resolve({
      warnings: [],
      commandIds: mockCommands.map((command) => command.id),
      skillIds: [],
    }),
  ),
}));
jest.mock('../pipelines/config-paths', () => ({ getEnhancedEnv: jest.fn() }));
jest.mock('../canopy-tools/session-runtime', () => ({
  requestAnswersFromRenderer: jest.fn(),
}));
jest.mock('../agents/session-manager', () => ({
  buildSessionKey: () => 'project/worktree/chat',
  drainChatSessionEvents: jest.fn(),
  markTurnActive: jest.fn(),
  markTurnIdle: jest.fn(),
  recordSessionEvent: jest.fn(),
  registerSession: jest.fn(),
}));

beforeEach(async () => {
  jest.clearAllMocks();
  mockForkContext.mockReset().mockResolvedValue(undefined);
  mockPublishPlan.mockReset().mockResolvedValue(undefined);
  mockDeclaredThinking = [];
  mockWorkspace.directory = await mkdtemp(
    join(tmpdir(), 'opencode-session-thinking-'),
  );
});
afterEach(async () => {
  await rm(mockWorkspace.directory, { recursive: true, force: true });
});

test.each<{
  name: string;
  levels: Array<'low' | 'medium' | 'high'>;
  expected: 'medium' | undefined;
}>([
  { name: 'model without effort variants', levels: [], expected: undefined },
  {
    name: 'model without high effort',
    levels: ['low', 'medium'],
    expected: 'medium',
  },
])('clamps the chat default for $name', async ({ levels, expected }) => {
  mockDeclaredThinking = levels;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const events: unknown[] = [];
  const session = new OpenCodeProvider().createSession(
    {
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      cwd: mockWorkspace.directory,
      model: 'opencode:fixture%2Fmodel',
      thinkingLevel: 'high',
    },
    (event) => {
      events.push(event);
      if (
        event &&
        typeof event === 'object' &&
        'type' in event &&
        (event.type === 'result' || event.type === 'error')
      )
        finish();
    },
    () => null,
  );
  try {
    session.sendMessage('Hello');
    await done;
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: 'error' }),
    );
    expect(runOpenCodeTurn).toHaveBeenCalledTimes(1);
    expect(jest.mocked(runOpenCodeTurn).mock.calls[0]?.[0].thinkingLevel).toBe(
      expected,
    );
  } finally {
    await session.destroy();
  }
});

const graphCases: Array<{
  name: string;
  cowork: boolean;
  assistantMode?: AgentSessionOptions['assistantMode'];
  advertised?: boolean;
  expected: boolean;
}> = [
  { name: 'enabled worktree', cowork: false, advertised: true, expected: true },
  {
    name: 'disabled worktree',
    cowork: false,
    advertised: false,
    expected: false,
  },
  { name: 'unspecified capability', cowork: false, expected: false },
  { name: 'Cowork', cowork: true, advertised: true, expected: false },
  {
    name: 'App Advisor',
    cowork: false,
    assistantMode: 'app-advisor',
    advertised: true,
    expected: false,
  },
];
test.each(graphCases)(
  'Code Graph advertisement and registration agree for $name',
  async ({ cowork, assistantMode, advertised, expected }) => {
    mockWorkspace.cowork = cowork;
    let finish = (): void => {};
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const session = new OpenCodeProvider().createSession(
      {
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        cwd: mockWorkspace.directory,
        model: 'opencode:fixture%2Fmodel',
        assistantMode,
        codeGraphToolsAdvertised: advertised,
      },
      (event) => {
        if (
          event &&
          typeof event === 'object' &&
          'type' in event &&
          (event.type === 'result' || event.type === 'error')
        )
          finish();
      },
      () => null,
    );
    try {
      expect(registerSession).toHaveBeenCalledWith(
        expect.anything(),
        session,
        expect.anything(),
        'opencode',
        'opencode:fixture%2Fmodel',
        assistantMode,
        undefined,
        expected,
        'opencode',
      );
      if (assistantMode === 'app-advisor') return;
      session.sendMessage('Inspect the repository');
      await done;
      expect(runOpenCodeTurn).toHaveBeenCalledTimes(1);
      expect(mockProxy.registerCanopyWorktreeSessionRoute).toHaveBeenCalledWith(
        expect.objectContaining({ codeGraphToolsAdvertised: expected }),
      );
      const instructions =
        jest.mocked(runOpenCodeTurn).mock.calls[0]?.[0].instructions;
      if (expected) expect(instructions).toContain('GetCodeGraphContext');
      else expect(instructions).not.toContain('GetCodeGraphContext');
    } finally {
      await session.destroy();
      mockWorkspace.cowork = true;
    }
  },
);

test('announces compatibility limits once per session under the OpenCode heading', async () => {
  mockCompatibilityNotices.push('Cursor does not support native hooks.');
  mockResolverWarnings.push('Resolver details belong in logs.');
  const events: unknown[] = [];
  let finish = (): void => undefined;
  const session = new OpenCodeProvider().createSession(
    {
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      cwd: mockWorkspace.directory,
      model: 'opencode:fixture%2Fmodel',
    },
    (event) => {
      events.push(event);
      if (
        event &&
        typeof event === 'object' &&
        'type' in event &&
        (event.type === 'result' || event.type === 'error')
      )
        finish();
    },
    () => null,
  );
  try {
    for (const text of ['First', 'Second']) {
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      session.sendMessage(text);
      await done;
    }
    const transcript = JSON.stringify(events);
    expect(
      transcript.match(/Some selections are not available in OpenCode chats:/g),
    ).toHaveLength(1);
    expect(
      transcript.match(/OpenCode does not support native hooks/g),
    ).toHaveLength(1);
    expect(transcript).not.toContain('Resolver details');
  } finally {
    await session.destroy();
    mockCompatibilityNotices.length = 0;
    mockResolverWarnings.length = 0;
  }
});

test('records one local diagnostic with fixed kinds and runtime identity', async () => {
  jest.mocked(runOpenCodeTurn).mockResolvedValueOnce({
    sessionId: 'fixture-session',
    responseText: 'Done',
    isError: false,
    cancelled: false,
    message: '',
    diagnostics: {
      ignoredUpdates: { available_commands_update: 12 },
      ignoredContent: {},
    },
  });
  let finish = (): void => undefined;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const session = new OpenCodeProvider().createSession(
    {
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      cwd: mockWorkspace.directory,
      model: 'opencode:fixture%2Fmodel',
    },
    (event) => {
      if (
        event &&
        typeof event === 'object' &&
        'type' in event &&
        (event.type === 'result' || event.type === 'error')
      )
        finish();
    },
    () => null,
  );
  try {
    session.sendMessage('Hello', { userMessageId: 'diagnostic-turn' });
    await done;
    expect(mockRecordDiagnostic).toHaveBeenCalledTimes(1);
    expect(mockRecordDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'opencode_ignored_updates',
        providerType: 'opencode',
        turnUserMessageId: 'diagnostic-turn',
        opencodeUpdates: {
          ignoredUpdates: { available_commands_update: 12 },
          ignoredContent: {},
        },
      }),
    );
  } finally {
    await session.destroy();
  }
});

test('delivers a captured attachment selection to the shared turn driver', async () => {
  const file = join(mockWorkspace.directory, 'notes.txt');
  await writeFile(file, 'Selected content');
  const paths = [file];
  let finish = (): void => {};
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const session = new OpenCodeProvider().createSession(
    {
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      cwd: mockWorkspace.directory,
      model: 'opencode:fixture%2Fmodel',
    },
    (event) => {
      if (
        event &&
        typeof event === 'object' &&
        'type' in event &&
        (event.type === 'result' || event.type === 'error')
      )
        finish();
    },
    () => null,
  );
  try {
    session.sendMessage('Review the attachment', {
      attachments: { baseDir: mockWorkspace.directory, paths },
    });
    paths.push('/unselected/late-change.txt');
    await done;
    expect(
      jest.mocked(runOpenCodeTurn).mock.calls[0]?.[0].promptContent,
    ).toEqual([
      {
        type: 'resource',
        resource: {
          uri: pathToFileURL(await realpath(file)).href,
          mimeType: 'text/plain',
          text: 'Selected content',
        },
      },
    ]);
  } finally {
    await session.destroy();
  }
});

test.each([false, true])(
  'OpenCode acknowledges a load only after durable result delivery (write fails: %s)',
  async (writeFails) => {
    mockWorkspace.cowork = false;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let draining!: () => void;
    const drainStarted = new Promise<void>((resolve) => {
      draining = resolve;
    });
    jest.mocked(drainChatSessionEvents).mockImplementationOnce(async () => {
      draining();
      await barrier;
      if (writeFails) throw new Error('transcript commit failed');
    });
    const resultEvent = {
      type: 'canopy_assistant_patch',
      messageId: 'm',
      revision: 1,
      timestamp: 1,
      patches: [
        {
          index: 0,
          block: {
            type: 'tool_use',
            toolUseId: 'native-tool',
            toolName: 'native-tool-name',
            input: '{}',
            display: {
              toolName: `mcp__${cursorCanopyMcpServerNames('default').main}__${CANOPY_INJECTED_TOOL_REGISTRY.load_deferred_tools.displayName}`,
              input: '{}',
            },
          },
        },
        {
          index: 1,
          block: {
            type: 'tool_result',
            toolUseId: 'native-tool',
            toolName: 'native-tool-name',
            output: JSON.stringify({
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    status: 'success',
                    requestId: 'receipt',
                    willEnable: [{ ref: 'skill' }],
                  }),
                },
              ],
            }),
            isError: false,
          },
        },
      ],
    };
    jest
      .mocked(runOpenCodeTurn)
      .mockImplementationOnce(async (_options, host) => {
        await host.emit(resultEvent);
        return {
          responseText: 'Done',
          sessionId: 'fixture-session',
          isError: false,
          cancelled: false,
          message: '',
          usage: {},
        };
      });
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const session = new OpenCodeProvider().createSession(
      {
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        cwd: mockWorkspace.directory,
        model: 'opencode:fixture%2Fmodel',
      },
      (event) => {
        if (
          event &&
          typeof event === 'object' &&
          'type' in event &&
          (event.type === 'result' || event.type === 'error')
        )
          finish();
      },
      () => null,
    );
    try {
      session.sendMessage('Load the requested skill');
      await drainStarted;
      expect(mockMarkDeferredDelivered).not.toHaveBeenCalled();
      release();
      await done;
      if (writeFails) expect(mockMarkDeferredDelivered).not.toHaveBeenCalled();
      else
        expect(mockMarkDeferredDelivered).toHaveBeenCalledWith(
          expect.objectContaining({
            projectId: 'project',
            worktreeId: 'worktree',
            chatId: 'chat',
          }),
          'receipt',
        );
    } finally {
      release();
      await session.destroy();
    }
  },
);

describe('formal OpenCode plan proposals', () => {
  const proposal =
    '# Change the parser\n\nAdd validation and regression coverage.';
  async function complete(
    options: {
      planMode?: boolean;
      isError?: boolean;
      cancelled?: boolean;
      text?: string;
    } = {},
  ) {
    jest
      .mocked(runOpenCodeTurn)
      .mockReset()
      .mockResolvedValueOnce({
        responseText:
          options.text ?? `<proposed_plan>${proposal}</proposed_plan>`,
        sessionId: 'fixture-session',
        isError: options.isError ?? false,
        cancelled: options.cancelled ?? false,
        message: '',
        usage: {},
      });
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const events: unknown[] = [];
    const session = new OpenCodeProvider().createSession(
      {
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        cwd: mockWorkspace.directory,
        model: 'opencode:fixture%2Fmodel',
        planMode: options.planMode ?? true,
      },
      (event) => {
        events.push(event);
        if (
          event &&
          typeof event === 'object' &&
          'type' in event &&
          (event.type === 'result' || event.type === 'error')
        )
          finish();
      },
      () => null,
    );
    session.sendMessage('Propose the change', { userMessageId: 'plan-turn' });
    await done;
    await session.destroy();
    return events;
  }

  it('publishes a formal proposal only after canonical output is drained', async () => {
    await complete();
    expect(mockPublishPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        plan: proposal,
        userMessageId: 'plan-turn',
      }),
    );
    expect(
      jest.mocked(drainChatSessionEvents).mock.invocationCallOrder[0],
    ).toBeLessThan(mockPublishPlan.mock.invocationCallOrder[0]);
    expect(
      jest.mocked(runOpenCodeTurn).mock.calls[0]?.[0].instructions,
    ).toContain('<proposed_plan>');
    expect(
      jest.mocked(runOpenCodeTurn).mock.calls[0]?.[0].instructions,
    ).not.toContain('use request_user_input');
  });

  it.each([
    { planMode: false },
    { isError: true },
    { cancelled: true },
    { text: 'Here are some ideas, without a formal proposal.' },
    { text: '<proposed_plan>   </proposed_plan>' },
  ])(
    'does not publish an incomplete or ineligible proposal: %j',
    async (options) => {
      await complete(options);
      expect(mockPublishPlan).not.toHaveBeenCalled();
    },
  );

  it('fails the turn when the proposal cannot be durably committed', async () => {
    mockPublishPlan.mockRejectedValueOnce(
      new Error('proposal journal unavailable'),
    );
    const events = await complete();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'error',
        error: 'proposal journal unavailable',
      }),
    );
  });

  it('explicitly retires prior plan restrictions in default mode', async () => {
    await complete({ planMode: false });
    expect(
      jest.mocked(runOpenCodeTurn).mock.calls[0]?.[0].instructions,
    ).toContain('Plan mode instructions are no longer active');
  });
});

test.each(['success', 'cancelled', 'error'] as const)(
  'visible fork seed acknowledgment survives restart only after %s',
  async (outcome) => {
    mockForkContext.mockResolvedValue('INHERITED_VISIBLE_TEXT');
    const opts: AgentSessionOptions = {
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      cwd: mockWorkspace.directory,
      model: 'opencode:fixture%2Fmodel',
    };
    const native = jest.mocked(runOpenCodeTurn);
    native.mockImplementationOnce(async (_request, host) => {
      await host.onSession?.('seed-session', {
        version: 1,
        sessionId: 'seed-session',
        digest: 'fixture-digest',
        generation: 1,
      });
      return {
        sessionId: 'seed-session',
        responseText: 'reply',
        isError: outcome === 'error',
        cancelled: outcome === 'cancelled',
        message: '',
      };
    });
    let complete!: () => void;
    const done = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const session = new OpenCodeProvider().createSession(
      opts,
      (event) => {
        if (
          typeof event === 'object' &&
          event &&
          'type' in event &&
          (event.type === 'result' || event.type === 'error')
        )
          complete();
      },
      () => null,
    );
    try {
      session.sendMessage('Continue');
      await done;
      expect(native.mock.calls[0]?.[0].initialContext).toEqual({
        text: 'INHERITED_VISIBLE_TEXT',
      });
      const binding: unknown = JSON.parse(
        await readFile(
          join(getOpenCodeSessionProfile(opts), 'host-session.json'),
          'utf8',
        ),
      );
      if (outcome === 'success')
        expect(binding).toHaveProperty('forkContextDigest');
      else expect(binding).not.toHaveProperty('forkContextDigest');
    } finally {
      await session.destroy();
    }
    native.mockImplementationOnce(async (_request, host) => {
      await host.onSession?.('seed-session', {
        version: 1,
        sessionId: 'seed-session',
        digest: 'fixture-digest',
        generation: 1,
      });
      return {
        sessionId: 'seed-session',
        responseText: 'reply',
        isError: false,
        cancelled: false,
        message: '',
      };
    });
    let finish!: () => void;
    const resumedDone = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const resumed = new OpenCodeProvider().createSession(
      { ...opts, sdkSessionId: 'seed-session' },
      (event) => {
        if (
          typeof event === 'object' &&
          event &&
          'type' in event &&
          (event.type === 'result' || event.type === 'error')
        )
          finish();
      },
      () => null,
    );
    try {
      resumed.sendMessage('Next');
      await resumedDone;
      expect(native.mock.calls[1]?.[0].initialContext?.appliedSessionId).toBe(
        outcome === 'success' ? 'seed-session' : undefined,
      );
    } finally {
      await resumed.destroy();
    }
  },
);

test('applies RTK to approved v2 shell calls in desktop chats', async () => {
  jest.mocked(runRtkRewrite).mockResolvedValueOnce('rtk git status');
  jest
    .mocked(authorizeOpenCodeNativeTool)
    .mockResolvedValueOnce({ decision: 'allow' });
  let outcome: unknown;
  jest
    .mocked(runOpenCodeTurn)
    .mockImplementationOnce(async (_request, host) => {
      outcome = await host.authorize({
        sessionId: 'fixture-session',
        toolCallId: 'shell',
        toolName: 'shell',
        toolArgs: { command: 'git status' },
      });
      return {
        responseText: 'Done',
        isError: false,
        cancelled: false,
        message: '',
        sessionId: 'fixture-session',
      };
    });
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const session = new OpenCodeProvider().createSession(
    {
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      cwd: mockWorkspace.directory,
      model: 'opencode:fixture%2Fmodel',
      rtkEnabled: true,
    },
    (event) => {
      if (event.type === 'result' || event.type === 'error') finish();
    },
    () => null,
  );
  try {
    session.sendMessage('Check git status');
    await done;
    expect(outcome).toEqual({
      decision: 'allow',
      updatedInput: { command: 'rtk git status' },
    });
  } finally {
    await session.destroy();
  }
});
