/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionEvent } from '@github/copilot-sdk';
import type { CanopyWorktreeSessionRoute } from '../mcp/http-proxy-service';
import { authorizeCursorMcpTool } from '../cursor/tool-approval';
import { assertCopilotConnectionGeneration } from '../copilot/connection';
import { deferredToolsReloadCoordinator } from '../deferred-tools/reload-coordinator';

import type {
  ChatTabsFile,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import { readChatTabsFile } from '../lib/chat-tabs-reader';
import * as mainProcessLogging from '../lib/main-process-logging';
import { registerSession } from '../agents/session-manager';
import { CopilotProvider } from '../agents/copilot-session';
import * as homeCapture from '../agents/delegation/capture-home-capabilities';
import { resolvePlugins } from '../plugins/plugin-resolver';
import { runCopilotTurn } from '@canopy/desktop-shared/node/copilot/turn-driver';
import { cursorCanopyMcpServerNames } from '@canopy/desktop-shared/lib/cursor-mcp-tool-call';
import { buildCoworkDispatchSystemPromptAppend } from '../lib/cowork-chat-system-prompt';
import type { CursorCapabilityProjection } from '@canopy/desktop-shared/lib/cursor-capabilities';

type ForkTurn = Parameters<typeof runCopilotTurn>[0] & {
  preparePrompt?: (sessionId: string) => Promise<string>;
  onPromptAccepted?: (sessionId: string) => Promise<void>;
};

jest.mock('../lib/chat-tabs-reader', () => ({ readChatTabsFile: jest.fn() }));

let mockCommands: CursorCapabilityProjection['commands'] = [];
const mockManagedDelegationEnabled = jest.fn(() => false);
const mockCreateManagedDelegationSession = jest.fn<Promise<unknown>, []>();
jest.mock('../agents/delegation/gate', () => ({
  managedDelegationEnabled: () => mockManagedDelegationEnabled(),
}));
jest.mock('../agents/delegation/service', () => ({
  createManagedDelegationSession: () => mockCreateManagedDelegationSession(),
}));

const mockAssertCopilotModelAvailable = jest.fn((model: string) =>
  Promise.resolve({
    id: model,
    supportedThinkingLevels: [],
  }),
);
const mockWorkspace = { directory: '', cowork: true, localMemoryEnabled: true };
const mockProxy = {
  getMcpCapabilityDigests: jest.fn(() => ({})),
  getCanopyCapabilityDefinitions: jest.fn(() => []),
  registerCanopyWorktreeSessionRoute: jest
    .fn<Promise<string>, [CanopyWorktreeSessionRoute]>()
    .mockResolvedValue('route'),
  getCanopyWorktreeMcpUrl: jest.fn(() => 'http://localhost:1234/main'),
  getCanopyWorktreeUiMcpUrl: jest.fn(() => 'http://localhost:1234/ui'),
  setSessionToolCallGate: jest.fn(),
  unregisterRoutesForSession: jest.fn(),
  unregisterCanopyWorktreeSessionRoute: jest.fn(),
};
jest.mock('../mcp/http-proxy-service', () => ({
  getMcpHttpProxyService: () => mockProxy,
}));
const mockAuth = {
  token: (): Promise<string> => Promise.resolve('ghu_test'),
  tokenProvider: jest.fn(),
};
jest.mock('../copilot/connection', () => ({
  assertCopilotModelAvailable: (model: string) =>
    mockAssertCopilotModelAvailable(model),
  openManagedCopilotRuntime: jest.fn(() =>
    Promise.resolve({
      account: { login: 'test-account' },
      generation: 1,
      close: jest.fn(),
      auth: mockAuth,
    }),
  ),
  assertCopilotConnectionGeneration: jest.fn(),
  listCopilotModels: jest.fn(),
}));
jest.mock('@canopy/desktop-shared/node/copilot/turn-driver', () => ({
  runCopilotTurn: jest.fn(() => Promise.resolve({ text: 'Done', usage: {} })),
}));
jest.mock('../approvals/approval-service', () => ({
  createApprovalSession: jest.fn(() => ({
    dispose: jest.fn(),
    invalidatePending: jest.fn(),
  })),
}));
jest.mock('../copilot/tool-approval', () => ({
  authorizeCopilotNativeTool: jest.fn(),
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
type InheritedFixture = {
  skills: Array<{
    origin: 'claude' | 'cursor' | 'codex' | 'grok' | 'agents';
    name: string;
    sourceDir: string;
    description: string;
    userInvocable: boolean;
  }>;
  commands: Array<{
    origin: 'claude' | 'cursor';
    name: string;
    markdown: string;
    description: string;
  }>;
  skipped: Array<{ label: string; reason: string }>;
  fingerprint: string;
};
const emptyInherited = (): InheritedFixture => ({
  skills: [],
  commands: [],
  skipped: [],
  fingerprint: 'fp-empty',
});
let mockInherited: InheritedFixture = emptyInherited();
const mockDiscoverInherited = jest.fn(() => Promise.resolve(mockInherited));
jest.mock('@canopy/desktop-shared/node/cursor/inherited-capabilities', () => ({
  discoverInheritedCursorCapabilities: () => mockDiscoverInherited(),
  emptyInheritedCursorCapabilities: () => ({
    skills: [],
    commands: [],
    skipped: [],
    fingerprint: '',
  }),
}));
jest.mock('../cursor/inherited-roots', () => ({
  resolveInheritedCursorRoots: () => ({
    userHome: '/home/user',
    claudeConfigDir: '/home/user/.claude',
    codexHome: '/home/user/.codex',
  }),
}));
let mockClaudeEnabled: Map<string, string> | null = null;
jest.mock('../plugins/claude-enabled-plugins', () => ({
  readClaudeDisabledInstalledPlugins: (): string[] => [],
  readClaudeEnabledPlugins: () => mockClaudeEnabled,
}));
jest.mock('../plugins/inherited-cursor-plugins', () => ({
  inheritedClaudePluginRefs: (
    _marketplaces: unknown,
    _effective: unknown,
    _tombstones: unknown,
    enabled: Map<string, string> | null,
  ) =>
    enabled
      ? Array.from(enabled, ([key, installPath]) => {
          const [pluginName, marketplaceId] = key.split('@');
          return { marketplaceId, pluginName, installPath };
        })
      : [],
}));
jest.mock('../plugins/plugin-service', () => ({
  loadMarketplacesCacheOnly: jest.fn(() =>
    Promise.resolve({ success: true, data: { marketplaces: [] } }),
  ),
}));
const mockRefreshInventory = jest.fn();
jest.mock('../plugins/invocable-inventory-service', () => ({
  refreshInvocableInventoryAfterMutation: (reason: string): void => {
    mockRefreshInventory(reason);
  },
}));
jest.mock('../plugins/request-chat-tombstones', () => ({
  requestChatTombstones: (apply: unknown) => apply,
}));
jest.mock('../plugins/global-plugin-overlay', () => ({
  resolveEffectiveChatPluginContext: jest.fn(() =>
    Promise.resolve({
      selections: {
        collectionIds: mockCommands.length ? ['selected'] : [],
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

describe('Copilot desktop session instructions', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    jest
      .mocked(readChatTabsFile)
      .mockResolvedValue({ version: 1, tabs: [], activeTabId: null });
    jest.mocked(runCopilotTurn).mockImplementation(async (config) => {
      await config.onToolsReady?.({ version: 1, digest: 'a'.repeat(64) }, []);
      return {
        sessionId: 'fixture-session',
        text: 'Done',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      };
    });
    mockCommands = [];
    mockInherited = emptyInherited();
    mockClaudeEnabled = null;
    mockDiscoverInherited.mockImplementation(() =>
      Promise.resolve(mockInherited),
    );
    mockWorkspace.cowork = true;
    mockManagedDelegationEnabled.mockReturnValue(false);
    mockWorkspace.directory = await mkdtemp(
      join(tmpdir(), 'copilot-session-test-'),
    );
  });

  test.each([true, false])(
    'keeps Code Graph advertisement consistent with the session snapshot (%s)',
    async (advertised) => {
      mockWorkspace.cowork = false;
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const session = new CopilotProvider().createSession(
        {
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
          cwd: mockWorkspace.directory,
          model: 'copilot:model',
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
        session.sendMessage('Inspect code');
        await finished;
        expect(
          mockProxy.registerCanopyWorktreeSessionRoute,
        ).toHaveBeenCalledWith(
          expect.objectContaining({ codeGraphToolsAdvertised: advertised }),
        );
        expect(jest.mocked(registerSession).mock.calls.at(-1)?.[7]).toBe(
          advertised,
        );
        expect(mockProxy.getCanopyCapabilityDefinitions).toHaveBeenCalledWith(
          'project/worktree/chat',
        );
        const prompt = jest
          .mocked(runCopilotTurn)
          .mock.calls.at(-1)?.[0].systemPrompt;
        if (advertised) expect(prompt).toContain('GetCodeGraphContext');
        else expect(prompt).not.toContain('GetCodeGraphContext');
      } finally {
        await session.destroy();
      }
    },
  );

  test.each([false, true])(
    'advertises independent forks while managed delegation is enabled (Cowork=%s)',
    async (cowork) => {
      mockWorkspace.cowork = cowork;
      mockManagedDelegationEnabled.mockReturnValue(true);
      mockCreateManagedDelegationSession.mockResolvedValueOnce({
        tools: [],
        mcpTools: [],
        observe: jest.fn(),
        retireTurn: jest.fn(),
        detach: jest.fn(),
        applyPolicyGuidance: (text: string) => text,
      });
      let finish: (event: unknown) => void = () => undefined;
      const finished = new Promise<unknown>((resolve) => {
        finish = resolve;
      });
      const session = new CopilotProvider().createSession(
        {
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
          cwd: mockWorkspace.directory,
          model: 'copilot:model',
          managedDelegationSurface: 'worktree-chat',
          managedDelegationMode: 'explicit-only',
        },
        finish,
        () => null,
      );
      try {
        session.sendMessage(
          'Prepare an independent fork when explicitly requested',
        );
        await expect(finished).resolves.toMatchObject({
          type: 'result',
          is_error: false,
        });
        const prompt = jest
          .mocked(runCopilotTurn)
          .mock.calls.at(-1)?.[0].systemPrompt;
        expect(prompt).toContain('StartForkedAgent');
        if (cowork) expect(prompt).not.toContain('StartBranchedAgent');
        else expect(prompt).toContain('StartBranchedAgent');
      } finally {
        await session.destroy();
      }
    },
  );

  test.each(['instructions', 'native tools'])(
    'reports changed %s before resuming the same conversation',
    async (changed) => {
      const command = {
        id: 'review',
        markdown: 'Review version one.',
        label: 'Review',
        description: 'Review',
      };
      mockCommands = [command];
      let nativeDigest = 'a'.repeat(64);
      jest.mocked(runCopilotTurn).mockImplementation(async (config) => {
        await config.onToolsReady?.({ version: 1, digest: nativeDigest }, []);
        await config.onSession('same-session');
        return {
          sessionId: 'same-session',
          text: 'Done',
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        };
      });
      const events: unknown[] = [];
      let finish!: () => void;
      const session = new CopilotProvider().createSession(
        {
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
          cwd: mockWorkspace.directory,
          model: 'copilot:model',
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
      const send = async (): Promise<void> => {
        const done = new Promise<void>((resolve) => {
          finish = resolve;
        });
        session.sendMessage('Review');
        await done;
        await new Promise<void>((resolve) => setImmediate(resolve));
      };
      try {
        await send();
        if (changed === 'instructions')
          mockCommands = [{ ...command, markdown: 'Review version two.' }];
        else nativeDigest = 'b'.repeat(64);
        await send();
        expect(
          jest.mocked(runCopilotTurn).mock.calls.at(-1)?.[0].sessionId,
        ).toBe('same-session');
        expect(JSON.stringify(events)).toContain(
          'Selected capabilities changed',
        );
      } finally {
        await session.destroy();
      }
    },
  );

  test.each(['none', 'before-acceptance', 'after-acceptance'] as const)(
    'a fork retains only the destination history and tracks native acceptance (%s)',
    async (failure) => {
      const tab: PersistedChatTab = {
        id: 'chat',
        title: 'Fork',
        createdAt: '2026-10-12T00:00:00Z',
        providerType: 'copilot',
        model: 'copilot:model',
        forkedFrom: {
          projectId: 'source-project',
          worktreeId: 'source-worktree',
          chatId: 'source-chat',
          atMessageId: 'a1',
        },
        messages: [
          {
            id: 'u1',
            role: 'user',
            blocks: [{ type: 'text', text: 'COPILOT_FORK_HISTORY_CANARY' }],
            timestamp: 1,
          },
          {
            id: 'a1',
            role: 'assistant',
            blocks: [
              { type: 'text', text: 'Remembered the original decision.' },
            ],
            timestamp: 2,
          },
          {
            id: 'later',
            role: 'user',
            blocks: [{ type: 'text', text: 'COPILOT_FUTURE_SOURCE_CANARY' }],
            timestamp: 3,
          },
        ],
      };
      const tabs: ChatTabsFile = {
        version: 1,
        tabs: [tab],
        activeTabId: 'chat',
      };
      jest.mocked(readChatTabsFile).mockResolvedValue(tabs);
      let nativeTurns = 0;
      const submittedPrompts: string[] = [];
      jest
        .mocked(runCopilotTurn)
        .mockImplementation(async (config: ForkTurn) => {
          nativeTurns++;
          await config.onToolsReady?.(
            { version: 1, digest: 'a'.repeat(64) },
            [],
          );
          await config.onSession('fork-native-session');
          submittedPrompts.push(
            (await config.preparePrompt?.('fork-native-session')) ??
              config.prompt,
          );
          if (failure === 'before-acceptance' && nativeTurns === 1)
            throw new Error('fixture send was rejected');
          await config.onPromptAccepted?.('fork-native-session');
          if (failure === 'after-acceptance' && nativeTurns === 1)
            throw new Error('fixture model failed after accepting the prompt');
          return {
            sessionId: 'fork-native-session',
            text: 'Done',
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          };
        });
      let finish = () => {};
      const session = new CopilotProvider().createSession(
        {
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
          cwd: mockWorkspace.directory,
          model: 'copilot:model',
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
      const send = async () => {
        const done = new Promise<void>((resolve) => {
          finish = resolve;
        });
        session.sendMessage('Continue the selected conversation', {
          userMessageId: 'current',
        });
        await done;
        await new Promise<void>((resolve) => setImmediate(resolve));
      };
      try {
        await send();
        const first = submittedPrompts[0];
        expect(first).toContain('COPILOT_FORK_HISTORY_CANARY');
        expect(first).not.toContain('COPILOT_FUTURE_SOURCE_CANARY');
        expect(first).toContain('historical records');
        expect(first).toContain('Continue the selected conversation');
        expect(readChatTabsFile).toHaveBeenCalledWith('project', 'worktree', {
          chatIds: ['chat'],
          fullTranscript: true,
        });
        if (failure !== 'none') {
          await send();
          if (failure === 'before-acceptance')
            expect(submittedPrompts.at(-1)).toContain(
              'COPILOT_FORK_HISTORY_CANARY',
            );
          else
            expect(submittedPrompts.at(-1)).not.toContain(
              'COPILOT_FORK_HISTORY_CANARY',
            );
        }
        await send();
        expect(submittedPrompts.at(-1)).not.toContain(
          'COPILOT_FORK_HISTORY_CANARY',
        );
        expect(
          jest.mocked(runCopilotTurn).mock.calls.at(-1)?.[0].sessionId,
        ).toBe('fork-native-session');
      } finally {
        await session.destroy();
      }
    },
  );

  test('an oversized fork stops before submitting an incomplete history to Copilot', async () => {
    jest.mocked(readChatTabsFile).mockResolvedValue({
      version: 1,
      activeTabId: 'chat',
      tabs: [
        {
          id: 'chat',
          title: 'Fork',
          createdAt: '2026-10-12T00:00:00Z',
          providerType: 'copilot',
          forkedFrom: {
            projectId: 'project',
            worktreeId: 'worktree',
            chatId: 'source',
            atMessageId: 'a1',
          },
          messages: [
            {
              id: 'a1',
              role: 'assistant',
              blocks: [{ type: 'text', text: 'x'.repeat(1024 * 1024 + 1) }],
              timestamp: 1,
            },
          ],
        },
      ],
    });
    let submitted = false;
    jest.mocked(runCopilotTurn).mockImplementation(async (config: ForkTurn) => {
      await config.preparePrompt?.('new-fork-session');
      submitted = true;
      return {
        sessionId: 'new-fork-session',
        text: 'Done',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      };
    });
    const events: unknown[] = [];
    let finish = () => {};
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const session = new CopilotProvider().createSession(
      {
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        cwd: mockWorkspace.directory,
        model: 'copilot:model',
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
      session.sendMessage('Continue');
      await done;
      expect(submitted).toBe(false);
      expect(JSON.stringify(events)).toContain('too large to send to Copilot');
    } finally {
      await session.destroy();
    }
  });

  afterEach(async () => {
    await rm(mockWorkspace.directory, { recursive: true, force: true });
  });

  it('recovers an interactive chat whose saved profile is missing and announces lost context', async () => {
    const events: unknown[] = [];
    let finish: () => void = () => undefined;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const session = new CopilotProvider().createSession(
      {
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        cwd: mockWorkspace.directory,
        model: 'copilot:gpt-5',
        sdkSessionId: 'lost-session',
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
      session.sendMessage('Continue');
      await finished;
      expect(events.at(-1)).toMatchObject({ type: 'result', is_error: false });
      expect(
        jest.mocked(runCopilotTurn).mock.calls.at(-1)?.[0].sessionId,
      ).toBeUndefined();
      expect(JSON.stringify(events)).toContain('previous conversation');
    } finally {
      await session.destroy();
    }
  });

  it('persists the selected capability snapshot with the session binding', async () => {
    jest.mocked(runCopilotTurn).mockImplementationOnce(async (config) => {
      await config.onToolsReady?.({ version: 1, digest: 'c'.repeat(64) }, []);
      await config.onSession('new-session');
      return {
        sessionId: 'new-session',
        text: 'Done',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      };
    });
    let finish: () => void = () => undefined;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const session = new CopilotProvider().createSession(
      {
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        cwd: mockWorkspace.directory,
        model: 'copilot:gpt-5',
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
      session.sendMessage('Hello');
      await finished;
      const root = join(mockWorkspace.directory, 'copilot-sessions');
      const [profile] = await readdir(root);
      const binding: unknown = JSON.parse(
        await readFile(join(root, profile, 'host-session.json'), 'utf8'),
      );
      expect(binding).toMatchObject({
        version: 2,
        sessionId: 'new-session',
        nativeToolSnapshot: { version: 1, digest: 'c'.repeat(64) },
        capabilitySnapshot: {
          version: 1,
        },
      });
      expect(JSON.stringify(binding)).toMatch(/"digest":"[a-f0-9]{64}"/);
      expect(JSON.stringify(binding)).not.toContain('ghu_test');
    } finally {
      await session.destroy();
    }
  });

  test.each(['legacy', 'missing native digest', 'wrong runtime'])(
    'interactive resume handles %s metadata',
    async (kind) => {
      jest.mocked(runCopilotTurn).mockImplementation(async (config) => {
        await config.onToolsReady?.({ version: 1, digest: 'a'.repeat(64) }, []);
        await config.onSession('same-session');
        return {
          sessionId: 'same-session',
          text: 'Done',
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        };
      });
      const events: unknown[] = [];
      let finish!: () => void;
      const session = new CopilotProvider().createSession(
        {
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
          cwd: mockWorkspace.directory,
          model: 'copilot:model',
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
      const send = async (): Promise<void> => {
        const done = new Promise<void>((resolve) => {
          finish = resolve;
        });
        session.sendMessage('Review');
        await done;
        await new Promise<void>((resolve) => setImmediate(resolve));
      };
      try {
        await send();
        const root = join(mockWorkspace.directory, 'copilot-sessions');
        const [profile] = await readdir(root);
        const file = join(root, profile, 'host-session.json');
        const saved: unknown = JSON.parse(await readFile(file, 'utf8'));
        if (!saved || typeof saved !== 'object')
          throw new Error('Expected a saved binding');
        const changed =
          kind === 'legacy'
            ? {
                ...saved,
                version: 1,
                nativeToolSnapshot: undefined,
                runtimeVersion: undefined,
              }
            : kind === 'missing native digest'
              ? { ...saved, version: 2, nativeToolSnapshot: undefined }
              : { ...saved, version: 2, runtimeVersion: '0.0.0' };
        await writeFile(file, JSON.stringify(changed));
        await send();
        if (kind === 'legacy') {
          expect(events.at(-1)).toMatchObject({
            type: 'result',
            is_error: false,
          });
          expect(jest.mocked(runCopilotTurn)).toHaveBeenCalledTimes(2);
          expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({
            version: 2,
            nativeToolSnapshot: { version: 1, digest: 'a'.repeat(64) },
          });
        } else {
          expect(events.at(-1)).toMatchObject({ type: 'error' });
          expect(events.at(-1)).toHaveProperty(
            'error',
            expect.stringMatching(/configuration|metadata/),
          );
          expect(jest.mocked(runCopilotTurn)).toHaveBeenCalledTimes(1);
          expect(await readFile(file, 'utf8')).toBe(JSON.stringify(changed));
        }
      } finally {
        await session.destroy();
      }
    },
  );

  it('refuses a model absent from the current account before submitting a prompt to the SDK', async () => {
    mockAssertCopilotModelAvailable.mockRejectedValueOnce(
      new Error('This Copilot model is unavailable.'),
    );
    let finish: (event: unknown) => void = () => undefined;
    const finished = new Promise<unknown>((resolve) => {
      finish = resolve;
    });
    const session = new CopilotProvider().createSession(
      {
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        cwd: mockWorkspace.directory,
        model: 'copilot:stale-model',
      },
      finish,
      () => null,
    );
    try {
      session.sendMessage('Do not send this prompt');
      await expect(finished).resolves.toMatchObject({
        type: 'error',
        error: 'This Copilot model is unavailable.',
      });
      expect(runCopilotTurn).not.toHaveBeenCalled();
    } finally {
      await session.destroy();
    }
  });

  it('expands selected commands before current delegation policy after a mode change', async () => {
    mockManagedDelegationEnabled.mockReturnValue(true);
    mockCommands = [
      {
        id: 'selected-review',
        markdown: 'Review $ARGUMENTS using the retained checklist.',
        description: 'Selected review',
        label: 'Selected review',
      },
    ];
    let changed = false;
    const policy =
      '<managed_delegation_policy>Use the updated policy.</managed_delegation_policy>';
    const managed = {
      tools: [],
      mcpTools: [],
      observe: jest.fn(),
      retireTurn: jest.fn(),
      detach: jest.fn(),
      updatePolicy: jest.fn(() => {
        changed = true;
      }),
      applyPolicyGuidance: (text: string) =>
        changed ? `${policy}\n\n${text}` : text,
    };
    mockCreateManagedDelegationSession.mockResolvedValueOnce(managed);
    let finish: (event: unknown) => void = () => undefined;
    const session = new CopilotProvider().createSession(
      {
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        cwd: mockWorkspace.directory,
        model: 'copilot:gpt-5',
        managedDelegationSurface: 'worktree-chat',
        managedDelegationMode: 'explicit-only',
      },
      (event) => finish(event),
      () => null,
    );
    const sendCommand = async (file: string) => {
      const finished = new Promise<unknown>((resolve) => {
        finish = resolve;
      });
      session.sendMessage(`/selected-review ${file}`);
      await expect(finished).resolves.toMatchObject({
        type: 'result',
        is_error: false,
      });
      return jest.mocked(runCopilotTurn).mock.calls.at(-1)?.[0].prompt;
    };
    try {
      expect(await sendCommand('first.txt')).toBe(
        'Review first.txt using the retained checklist.',
      );
      await Promise.resolve(session.setManagedDelegationMode?.('proactive'));
      expect(managed.updatePolicy).toHaveBeenCalledWith('proactive');
      expect(await sendCommand('second.txt')).toBe(
        `${policy}\n\nReview second.txt using the retained checklist.`,
      );
      expect(await sendCommand('third.txt')).toBe(
        `${policy}\n\nReview third.txt using the retained checklist.`,
      );
    } finally {
      await session.destroy();
    }
  });

  it.each([true, false])(
    'advertises only available Cowork tools with local memory enabled: %s',
    async (localMemoryEnabled) => {
      mockWorkspace.cowork = true;
      mockWorkspace.localMemoryEnabled = localMemoryEnabled;
      let finish: (event: unknown) => void = () => undefined;
      const finished = new Promise<unknown>((resolve) => {
        finish = resolve;
      });
      const session = new CopilotProvider().createSession(
        {
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
          cwd: mockWorkspace.directory,
          model: 'copilot:gpt-5',
          systemPromptAppend: buildCoworkDispatchSystemPromptAppend(
            'copilot',
            localMemoryEnabled,
            false,
            true,
          ),
        },
        (event) => {
          finish(event);
        },
        () => null,
      );
      try {
        session.sendMessage('Help with this project');
        await expect(finished).resolves.toMatchObject({
          type: 'result',
          is_error: false,
        });
        expect(runCopilotTurn).toHaveBeenCalledTimes(1);
        const config = jest.mocked(runCopilotTurn).mock.calls[0]?.[0];
        expect(config?.gitHubTokenProvider).toBe(mockAuth.tokenProvider);
        expect(config?.systemPrompt).toContain('cowork project');
        expect(config?.systemPrompt).toMatch(
          /SearchDeferredTools|LoadDeferredTools/,
        );
        expect(config?.systemPrompt?.match(/project tools:/g)).toHaveLength(1);
        expect(
          config?.systemPrompt?.includes(
            'call SaveMemory with the appropriate scope',
          ),
        ).toBe(localMemoryEnabled);
        expect(
          mockProxy.registerCanopyWorktreeSessionRoute,
        ).toHaveBeenCalledWith(
          expect.objectContaining({
            toolSurface: 'copilot-sdk-standalone',
            deferredToolsAllowed: true,
          }),
        );
      } finally {
        await session.destroy();
      }
    },
  );

  it.each([
    'accepted',
    'mismatched',
    'denied',
    'missing-native',
    'child',
    'cancelled',
    'account-changed',
    'early',
    'missing-result',
    'no-active-reload',
  ] as const)(
    'uses the host/native receipt binding for %s completions',
    async (scenario) => {
      mockWorkspace.cowork = false;
      const delivered = jest
        .spyOn(deferredToolsReloadCoordinator, 'markToolResultDelivered')
        .mockReturnValue(scenario !== 'no-active-reload');
      const generation = jest.mocked(assertCopilotConnectionGeneration);
      jest.mocked(authorizeCursorMcpTool).mockResolvedValue({
        decision: scenario === 'denied' ? 'deny' : 'allow',
      });
      const events: unknown[] = [];
      const { session } = startSession((event) => events.push(event));
      let reachedReceipt = false;
      let stoppedAfterReceipt = false;
      const originalRun = jest.mocked(runCopilotTurn).getMockImplementation();
      if (!originalRun) throw new Error('Missing turn fixture');
      jest.mocked(runCopilotTurn).mockImplementation(async (config) => {
        const route =
          mockProxy.registerCanopyWorktreeSessionRoute.mock.calls.at(-1)?.[0];
        if (!route?.nativeToolResultDelivery || !route.authorizeToolCall)
          throw new Error('Missing host receipt binding');
        const args = { items: [{ ref: 'deferred:v1:fixture' }] };
        const toolName = 'fixture-loader';
        const eventBase = {
          id: 'native-event',
          parentId: null,
          timestamp: '2026-10-12T00:00:00Z',
        };
        const complete: SessionEvent = {
          ...eventBase,
          id: 'complete',
          type: 'tool.execution_complete',
          data: {
            toolCallId: 'native-load',
            success: true,
            result: {
              content: 'accepted',
              detailedContent: 'accepted',
              contents: [{ type: 'text', text: 'accepted' }],
            },
          },
        };
        if (scenario !== 'missing-native') {
          config.onEvent?.({
            ...eventBase,
            type: 'tool.execution_start',
            data: {
              toolCallId: 'native-load',
              toolName,
              arguments: args,
              mcpConfigServerName: cursorCanopyMcpServerNames('default').main,
              mcpToolName: 'LoadDeferredTools',
            },
          });
          await expect(
            config.authorize({
              toolName,
              toolArgs: args,
              timestamp: new Date(),
              workingDirectory: config.workingDirectory,
              sessionId: 'native-session',
            }),
          ).resolves.toEqual({
            decision: scenario === 'denied' ? 'deny' : 'allow',
          });
        }
        const admitted = await route.authorizeToolCall(
          'load_deferred_tools',
          args,
          { requestId: 'rpc-1' },
        );
        expect(admitted).toBe(
          scenario !== 'denied' && scenario !== 'missing-native',
        );
        reachedReceipt = true;
        if (!admitted) return originalRun(config);
        if (scenario === 'early') config.onEvent?.(complete);
        const expectedResponse = {
          requestId: 'rpc-1',
          toolUseId: 'route:rpc-1',
          result:
            scenario === 'missing-result'
              ? { isError: true }
              : { content: [{ type: 'text', text: 'accepted' }] },
        };
        if (scenario === 'early')
          expect(() =>
            route.nativeToolResultDelivery?.(expectedResponse),
          ).toThrow('could not verify');
        else route.nativeToolResultDelivery(expectedResponse);
        expect(delivered).not.toHaveBeenCalled();
        if (scenario === 'cancelled') void session.cancel();
        if (scenario === 'account-changed')
          generation.mockImplementationOnce(() => {
            throw new Error('Account changed');
          });
        const nativeReceipt: SessionEvent =
          scenario === 'mismatched'
            ? {
                ...complete,
                data: {
                  ...complete.data,
                  result: {
                    content: 'wrong',
                    contents: [{ type: 'text', text: 'wrong' }],
                  },
                },
              }
            : scenario === 'child'
              ? { ...complete, agentId: 'child' }
              : complete;
        if (scenario === 'account-changed')
          expect(() => config.onEvent?.(nativeReceipt)).toThrow(
            'Account changed',
          );
        else config.onEvent?.(nativeReceipt);
        if (scenario === 'accepted' || scenario === 'no-active-reload') {
          stoppedAfterReceipt = config.signal.aborted;
          expect(delivered).toHaveBeenCalledWith(
            { projectId: 'project', worktreeId: 'worktree', chatId: 'chat' },
            'route:rpc-1',
          );
          config.onEvent?.(complete);
          expect(delivered).toHaveBeenCalledTimes(1);
        } else expect(delivered).not.toHaveBeenCalled();
        return originalRun(config);
      });
      try {
        await sendAndSettle(session, events, 'Receipt fixture');
        expect(reachedReceipt).toBe(true);
        if (scenario === 'accepted') expect(stoppedAfterReceipt).toBe(true);
        if (scenario === 'no-active-reload')
          expect(stoppedAfterReceipt).toBe(false);
        if (scenario !== 'cancelled')
          expect(events.at(-1)).toMatchObject({
            type: 'result',
            is_error: false,
          });
      } finally {
        delivered.mockRestore();
        generation.mockReset();
        await session.destroy();
      }
    },
  );

  it.each([true, false])(
    'keeps explicit discovery opt-out in Copilot Cowork=%s',
    async (cowork) => {
      mockWorkspace.cowork = cowork;
      const events: unknown[] = [];
      const { session } = startSession((event) => events.push(event), {
        deferredToolsAllowed: false,
      });
      try {
        await sendAndSettle(session, events, 'Keep discovery disabled');
        expect(
          mockProxy.registerCanopyWorktreeSessionRoute,
        ).toHaveBeenCalledWith(
          expect.objectContaining({ deferredToolsAllowed: false }),
        );
        expect(
          jest.mocked(runCopilotTurn).mock.calls.at(-1)?.[0].systemPrompt,
        ).not.toMatch(/SearchDeferredTools|LoadDeferredTools/);
      } finally {
        await session.destroy();
      }
    },
  );

  function startSession(
    onEvent: (event: unknown) => void,
    options: { deferredToolsAllowed?: boolean } = {},
  ): {
    session: ReturnType<CopilotProvider['createSession']>;
  } {
    const session = new CopilotProvider().createSession(
      {
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        cwd: mockWorkspace.directory,
        model: 'copilot:gpt-5',
        ...options,
      },
      onEvent,
      () => null,
    );
    return { session };
  }

  async function sendAndSettle(
    session: ReturnType<CopilotProvider['createSession']>,
    events: unknown[],
    text: string,
  ): Promise<void> {
    await new Promise<void>((resolve) => {
      const originalLength = events.length;
      const check = (): void => {
        const settled = events
          .slice(originalLength)
          .some(
            (event) =>
              event &&
              typeof event === 'object' &&
              'type' in event &&
              (event.type === 'result' || event.type === 'error'),
          );
        if (settled) resolve();
        else setTimeout(check, 5);
      };
      session.sendMessage(text);
      check();
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  it("inherits the user's home skills, commands, and Claude Code plugins every turn", async () => {
    mockWorkspace.cowork = false;
    mockInherited = {
      skills: [
        {
          origin: 'claude',
          name: 'review',
          sourceDir: '/home/user/.claude/skills/review',
          description: 'Review',
          userInvocable: true,
        },
      ],
      commands: [],
      skipped: [],
      fingerprint: 'fp-1',
    };
    mockClaudeEnabled = new Map([['tool@market', '/plugins/tool']]);
    const events: unknown[] = [];
    const { session } = startSession((event) => events.push(event));
    try {
      await sendAndSettle(session, events, 'Review this');
      expect(resolvePlugins).toHaveBeenCalledTimes(1);
      expect(jest.mocked(resolvePlugins).mock.calls[0][4]).toMatchObject({
        purpose: 'copilot-session',
        inheritedCursorCapabilities: mockInherited,
        inheritedPluginRefs: [
          {
            marketplaceId: 'market',
            pluginName: 'tool',
            installPath: '/plugins/tool',
          },
        ],
      });
      expect(
        mockProxy.registerCanopyWorktreeSessionRoute.mock.calls.at(-1)?.[0]
          .pluginSelections,
      ).toMatchObject({
        pluginRefs: [{ marketplaceId: 'market', pluginName: 'tool' }],
      });
      expect(mockDiscoverInherited).toHaveBeenCalledTimes(1);
      await sendAndSettle(session, events, 'Again');
      expect(mockDiscoverInherited).toHaveBeenCalledTimes(2);
    } finally {
      await session.destroy();
    }
  });

  it('inherits nothing when discovery fails, and the turn still runs', async () => {
    mockWorkspace.cowork = false;
    mockDiscoverInherited.mockImplementation(() =>
      Promise.reject(new Error('home unreadable')),
    );
    const events: unknown[] = [];
    const { session } = startSession((event) => events.push(event));
    const error = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    try {
      await sendAndSettle(session, events, 'Hello');
      expect(events.at(-1)).toMatchObject({ type: 'result', is_error: false });
      expect(resolvePlugins).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
      await session.destroy();
    }
  });

  it('logs skipped delegation capabilities once without adding startup text to the transcript', async () => {
    mockWorkspace.cowork = false;
    mockManagedDelegationEnabled.mockReturnValue(true);
    mockCreateManagedDelegationSession.mockResolvedValueOnce({
      tools: [],
      mcpTools: [],
      observe: jest.fn(),
      retireTurn: jest.fn(),
      detach: jest.fn(),
      applyPolicyGuidance: (text: string) => text,
    });
    const capture = jest
      .spyOn(homeCapture, 'captureHomeCapabilities')
      .mockResolvedValue({
        overlay: undefined,
        skipped: ['unsafe-home', 'unsafe-home', 'another-home'],
      });
    const warn = jest
      .spyOn(mainProcessLogging, 'logMainProcessWarn')
      .mockImplementation(() => undefined);
    const events: unknown[] = [];
    const { session } = startSession((event) => events.push(event));
    try {
      await sendAndSettle(session, events, 'One');
      await sendAndSettle(session, events, 'Two');
      expect(capture).toHaveBeenCalledTimes(2);
      expect(
        events.filter((event) =>
          JSON.stringify(event).includes(
            'Some home capabilities could not be passed to delegates:',
          ),
        ),
      ).toHaveLength(0);
      expect(
        warn.mock.calls.filter(
          ([message]) => message === '[copilot-delegation-capabilities]',
        ),
      ).toEqual([
        [
          '[copilot-delegation-capabilities]',
          'Some home capabilities could not be passed to delegates: unsafe-home, another-home.',
        ],
      ]);
      expect(events.at(-1)).toMatchObject({ type: 'result', is_error: false });
    } finally {
      warn.mockRestore();
      capture.mockRestore();
      await session.destroy();
    }
  });

  it('tells the user once per session which home entries could not be loaded', async () => {
    mockWorkspace.cowork = false;
    mockInherited = {
      ...emptyInherited(),
      skipped: [{ label: '~/.claude/skills/broken', reason: 'no SKILL.md' }],
      fingerprint: 'fp-skipped',
    };
    const events: unknown[] = [];
    const { session } = startSession((event) => events.push(event));
    const warn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    try {
      await sendAndSettle(session, events, 'One');
      await sendAndSettle(session, events, 'Two');
      const notices = events.filter((event) =>
        JSON.stringify(event).includes(
          'Some of your Copilot skills or commands could not be loaded: ~/.claude/skills/broken.',
        ),
      );
      expect(notices).toHaveLength(1);
    } finally {
      warn.mockRestore();
      await session.destroy();
    }
  });

  it('shows a resolver notice once per session and logs resolver warnings instead of repeating them', async () => {
    mockWorkspace.cowork = false;
    // An inherited skill makes the turn resolve, as a real home folder would.
    mockInherited = {
      ...emptyInherited(),
      skills: [
        {
          origin: 'claude',
          name: 'review',
          sourceDir: '/home/user/.claude/skills/review',
          description: '',
          userInvocable: true,
        },
      ],
      fingerprint: 'fp-notices',
    };
    jest.mocked(resolvePlugins).mockResolvedValue({
      mcpServers: {},
      cursorCapabilities: { skills: [], commands: mockCommands },
      warnings: [
        'Plugin "ghost" has no installed folder, so it was not inherited.',
      ],
      cursorNotices: ['Plugin "hooks-only" adds nothing to a Cursor session.'],
    } as never);
    const events: unknown[] = [];
    const { session } = startSession((event) => events.push(event));
    const warn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    try {
      await sendAndSettle(session, events, 'One');
      await sendAndSettle(session, events, 'Two');
      // Serialized events escape the quotes in the notice, so match the
      // quote-free tail of the text.
      const serialized = events.map((event) => JSON.stringify(event));
      expect(
        serialized.filter((text) =>
          text.includes('adds nothing to a Copilot session.'),
        ),
      ).toHaveLength(1);
      expect(
        serialized.some((text) => text.includes('has no installed folder')),
      ).toBe(false);
      expect(warn).toHaveBeenCalledWith(
        '[copilot-plugin-resolver]',
        'Plugin "ghost" has no installed folder, so it was not inherited.',
      );
    } finally {
      warn.mockRestore();
      jest.mocked(resolvePlugins).mockReset();
      jest.mocked(resolvePlugins).mockImplementation(() =>
        Promise.resolve({
          mcpServers: {},
          cursorCapabilities: { skills: [], commands: mockCommands },
        } as never),
      );
      await session.destroy();
    }
  });

  it('announces MCP servers that need sign-in or failed, logs them, and continues the turn', async () => {
    mockWorkspace.cowork = false;
    mockInherited = {
      ...emptyInherited(),
      skills: [
        {
          origin: 'claude',
          name: 'review',
          sourceDir: '/home/user/.claude/skills/review',
          description: '',
          userInvocable: true,
        },
      ],
      fingerprint: 'fp-mcp-readiness',
    };
    jest.mocked(resolvePlugins).mockResolvedValue({
      mcpServers: {
        slack: { type: 'http', url: 'https://mcp.slack.example/mcp' },
        broken: { type: 'http', url: 'http://127.0.0.1:1/mcp' },
        'appdyn-unreachable--0123456789abcdef': {
          type: 'stdio',
          command: '/usr/bin/false',
        },
      },
      mcpServerBindings: {
        slack: { displayName: 'Slack', binding: {}, sources: [] },
      },
      cursorCapabilities: { skills: [], commands: mockCommands },
    } as never);
    jest.mocked(runCopilotTurn).mockImplementation(async (config) => {
      const names = cursorCanopyMcpServerNames('default');
      await config.onToolsReady?.({ version: 1, digest: 'a'.repeat(64) }, [
        { name: names.main, status: 'connected' },
        { name: names.ui, status: 'connected' },
        { name: 'slack', status: 'needs-auth' },
        { name: 'broken', status: 'failed', error: 'Connection refused' },
        {
          name: 'appdyn-unreachable--0123456789abcdef',
          status: 'failed',
          error: 'MCP fixture process closed',
        },
      ]);
      return {
        sessionId: 'fixture-session',
        text: 'Done',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      };
    });
    const events: unknown[] = [];
    const { session } = startSession((event) => events.push(event));
    const warn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    try {
      await sendAndSettle(session, events, 'Hello');
      const serialized = JSON.stringify(events);
      expect(serialized).toContain(
        'Slack needs sign-in. Connect it in the Activity panel to use its tools.',
      );
      expect(serialized).toContain(
        "Couldn't connect to the MCP server broken (Connection refused). Copilot is continuing without its tools.",
      );
      // A managed name shows its friendly part, never the kind prefix or digest.
      expect(serialized).toContain(
        "Couldn't connect to the MCP server unreachable (MCP fixture process closed). Copilot is continuing without its tools.",
      );
      expect(serialized).not.toContain('appdyn-unreachable--');
      expect(serialized).toContain('"type":"result"');
      expect(serialized).not.toContain('"type":"error"');
      expect(warn).toHaveBeenCalledWith(
        '[copilot-mcp]',
        expect.stringContaining('broken'),
      );
    } finally {
      warn.mockRestore();
      jest.mocked(resolvePlugins).mockReset();
      jest.mocked(resolvePlugins).mockImplementation(() =>
        Promise.resolve({
          mcpServers: {},
          cursorCapabilities: { skills: [], commands: mockCommands },
        } as never),
      );
      await session.destroy();
    }
  });

  it('redacts the MCP error shown in the notice and gives a disabled server its own line', async () => {
    mockWorkspace.cowork = false;
    jest.mocked(resolvePlugins).mockResolvedValue({
      mcpServers: {
        leaky: { type: 'http', url: 'https://host.example/mcp?token=secret-1' },
        paused: { type: 'http', url: 'https://paused.example/mcp' },
        halted: { type: 'http', url: 'https://halted.example/mcp' },
        absent: { type: 'http', url: 'https://absent.example/mcp' },
      },
      mcpServerBindings: {},
      cursorCapabilities: { skills: [], commands: mockCommands },
    } as never);
    jest.mocked(runCopilotTurn).mockImplementation(async (config) => {
      const names = cursorCanopyMcpServerNames('default');
      await config.onToolsReady?.({ version: 1, digest: 'a'.repeat(64) }, [
        { name: names.main, status: 'connected' },
        { name: names.ui, status: 'connected' },
        {
          name: 'leaky',
          status: 'failed',
          error:
            'fetch failed for https://host.example/mcp?token=secret-1 Authorization: Bearer ghu_abcdefghijklmnop',
        },
        { name: 'paused', status: 'disabled' },
        { name: 'halted', status: 'stopped' },
        { name: 'absent', status: 'not_configured' },
      ]);
      return {
        sessionId: 'fixture-session',
        text: 'Done',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      };
    });
    const events: unknown[] = [];
    const { session } = startSession((event) => events.push(event));
    const warn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    try {
      await sendAndSettle(session, events, 'Hello');
      const serialized = JSON.stringify(events);
      expect(serialized).toContain(
        "Couldn't connect to the MCP server leaky (fetch failed for https://host.example Authorization: Bearer [redacted]). Copilot is continuing without its tools.",
      );
      expect(serialized).toContain(
        'paused is turned off. Copilot is continuing without its tools.',
      );
      expect(serialized).toContain(
        'halted is stopped. Copilot is continuing without its tools.',
      );
      expect(serialized).toContain(
        'absent is not configured for this session. Copilot is continuing without its tools.',
      );
      expect(serialized).not.toContain(
        "Couldn't connect to the MCP server halted",
      );
      expect(serialized).not.toContain('secret-1');
      expect(serialized).not.toContain('ghu_abcdefghijklmnop');
      const logged = warn.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(logged).not.toContain('secret-1');
      expect(logged).not.toContain('ghu_abcdefghijklmnop');
    } finally {
      warn.mockRestore();
      jest.mocked(resolvePlugins).mockReset();
      jest.mocked(resolvePlugins).mockImplementation(() =>
        Promise.resolve({
          mcpServers: {},
          cursorCapabilities: { skills: [], commands: mockCommands },
        } as never),
      );
      await session.destroy();
    }
  });

  it('announces a server again after it recovered and failed anew, and skips the generic capabilities notice it explains', async () => {
    mockWorkspace.cowork = false;
    jest.mocked(resolvePlugins).mockResolvedValue({
      mcpServers: {
        flaky: { type: 'http', url: 'https://flaky.example/mcp' },
      },
      mcpServerBindings: {},
      cursorCapabilities: { skills: [], commands: mockCommands },
    } as never);
    const statuses: Array<'failed' | 'connected'> = [
      'failed',
      'failed',
      'connected',
      'failed',
    ];
    let turn = 0;
    jest.mocked(runCopilotTurn).mockImplementation(async (config) => {
      const names = cursorCanopyMcpServerNames('default');
      const status = statuses[turn] ?? 'connected';
      turn += 1;
      // The bound tool set differs between a turn with and without flaky.
      await config.onToolsReady?.(
        {
          version: 1,
          digest: (status === 'connected' ? 'b' : 'a').repeat(64),
        },
        [
          { name: names.main, status: 'connected' },
          { name: names.ui, status: 'connected' },
          { name: 'flaky', status },
        ],
      );
      await config.onSession('same-session');
      return {
        sessionId: 'same-session',
        text: 'Done',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      };
    });
    const events: unknown[] = [];
    const { session } = startSession((event) => events.push(event));
    const warn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    try {
      for (const prompt of ['One', 'Two', 'Three', 'Four'])
        await sendAndSettle(session, events, prompt);
      const serialized = events.map((event) => JSON.stringify(event));
      const notices = serialized.filter((text) =>
        text.includes("Couldn't connect to the MCP server flaky"),
      );
      // Announced on the first failure, silent while still down, announced
      // again after the server recovered and failed anew.
      expect(notices).toHaveLength(2);
      // Recovery is announced instead of the generic notice.
      expect(
        serialized.filter((text) =>
          text.includes('flaky is connected again. Its tools are available.'),
        ),
      ).toHaveLength(1);
      expect(
        serialized.some((text) =>
          text.includes('Selected capabilities changed'),
        ),
      ).toBe(false);
    } finally {
      warn.mockRestore();
      jest.mocked(resolvePlugins).mockReset();
      jest.mocked(resolvePlugins).mockImplementation(() =>
        Promise.resolve({
          mcpServers: {},
          cursorCapabilities: { skills: [], commands: mockCommands },
        } as never),
      );
      await session.destroy();
    }
  });

  it('still announces a native tool change while the same server stays down', async () => {
    mockWorkspace.cowork = false;
    jest.mocked(resolvePlugins).mockResolvedValue({
      mcpServers: {
        down: { type: 'http', url: 'https://down.example/mcp' },
      },
      mcpServerBindings: {},
      cursorCapabilities: { skills: [], commands: mockCommands },
    } as never);
    const digests = ['a', 'a', 'c'];
    let turn = 0;
    jest.mocked(runCopilotTurn).mockImplementation(async (config) => {
      const names = cursorCanopyMcpServerNames('default');
      const digest = (digests[turn] ?? 'c').repeat(64);
      turn += 1;
      await config.onToolsReady?.({ version: 1, digest }, [
        { name: names.main, status: 'connected' },
        { name: names.ui, status: 'connected' },
        { name: 'down', status: 'failed', error: 'Connection refused' },
      ]);
      await config.onSession('same-session');
      return {
        sessionId: 'same-session',
        text: 'Done',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      };
    });
    const events: unknown[] = [];
    const { session } = startSession((event) => events.push(event));
    const warn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    try {
      for (const prompt of ['One', 'Two', 'Three'])
        await sendAndSettle(session, events, prompt);
      const serialized = events.map((event) => JSON.stringify(event));
      expect(
        serialized.filter((text) =>
          text.includes("Couldn't connect to the MCP server down"),
        ),
      ).toHaveLength(1);
      // The third turn's digest moved while the sat-out set did not, so the
      // generic notice is the only explanation and must appear once.
      expect(
        serialized.filter((text) =>
          text.includes('Selected capabilities changed'),
        ),
      ).toHaveLength(1);
    } finally {
      warn.mockRestore();
      jest.mocked(resolvePlugins).mockReset();
      jest.mocked(resolvePlugins).mockImplementation(() =>
        Promise.resolve({
          mcpServers: {},
          cursorCapabilities: { skills: [], commands: mockCommands },
        } as never),
      );
      await session.destroy();
    }
  });

  it('redacts a configured header value echoed by an MCP error', async () => {
    mockWorkspace.cowork = false;
    // An inherited skill makes the turn resolve plugins, so the configured
    // server (and its header) is built into the session's server map.
    mockInherited = {
      ...emptyInherited(),
      skills: [
        {
          origin: 'claude',
          name: 'review',
          sourceDir: '/home/user/.claude/skills/review',
          description: '',
          userInvocable: true,
        },
      ],
      fingerprint: 'fp-keyed-header',
    };
    jest.mocked(resolvePlugins).mockResolvedValue({
      mcpServers: {
        keyed: {
          type: 'http',
          url: 'https://keyed.example/mcp',
          headers: { 'X-Api-Key': 'plain-secret-9999' },
        },
      },
      mcpServerBindings: {},
      cursorCapabilities: { skills: [], commands: mockCommands },
    } as never);
    jest.mocked(runCopilotTurn).mockImplementation(async (config) => {
      const names = cursorCanopyMcpServerNames('default');
      await config.onToolsReady?.({ version: 1, digest: 'a'.repeat(64) }, [
        { name: names.main, status: 'connected' },
        { name: names.ui, status: 'connected' },
        {
          name: 'keyed',
          status: 'failed',
          error: 'upstream rejected key plain-secret-9999',
        },
      ]);
      return {
        sessionId: 'fixture-session',
        text: 'Done',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      };
    });
    const events: unknown[] = [];
    const { session } = startSession((event) => events.push(event));
    const warn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    try {
      await sendAndSettle(session, events, 'Hello');
      const serialized = JSON.stringify(events);
      expect(serialized).toContain(
        "Couldn't connect to the MCP server keyed (upstream rejected key [redacted]). Copilot is continuing without its tools.",
      );
      expect(serialized).not.toContain('plain-secret-9999');
      expect(
        warn.mock.calls.map((call) => call.join(' ')).join('\n'),
      ).not.toContain('plain-secret-9999');
    } finally {
      warn.mockRestore();
      jest.mocked(resolvePlugins).mockReset();
      jest.mocked(resolvePlugins).mockImplementation(() =>
        Promise.resolve({
          mcpServers: {},
          cursorCapabilities: { skills: [], commands: mockCommands },
        } as never),
      );
      await session.destroy();
    }
  });

  it('keeps the generic notice when only a sat-out status moved and other tools changed', async () => {
    mockWorkspace.cowork = false;
    jest.mocked(resolvePlugins).mockResolvedValue({
      mcpServers: {
        moody: { type: 'http', url: 'https://moody.example/mcp' },
      },
      mcpServerBindings: {},
      cursorCapabilities: { skills: [], commands: mockCommands },
    } as never);
    const turns: Array<{ status: 'needs-auth' | 'failed'; digest: string }> = [
      { status: 'needs-auth', digest: 'a' },
      { status: 'failed', digest: 'c' },
    ];
    let turn = 0;
    jest.mocked(runCopilotTurn).mockImplementation(async (config) => {
      const names = cursorCanopyMcpServerNames('default');
      const current = turns[turn] ?? turns[turns.length - 1];
      turn += 1;
      await config.onToolsReady?.(
        { version: 1, digest: current.digest.repeat(64) },
        [
          { name: names.main, status: 'connected' },
          { name: names.ui, status: 'connected' },
          { name: 'moody', status: current.status },
        ],
      );
      await config.onSession('same-session');
      return {
        sessionId: 'same-session',
        text: 'Done',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      };
    });
    const events: unknown[] = [];
    const { session } = startSession((event) => events.push(event));
    const warn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    try {
      for (const prompt of ['One', 'Two'])
        await sendAndSettle(session, events, prompt);
      const serialized = events.map((event) => JSON.stringify(event));
      // The status move is announced, but it sat out both turns, so it does
      // not explain the digest change: the generic notice must still appear.
      expect(
        serialized.filter((text) =>
          text.includes("Couldn't connect to the MCP server moody"),
        ),
      ).toHaveLength(1);
      expect(
        serialized.filter((text) =>
          text.includes('Selected capabilities changed'),
        ),
      ).toHaveLength(1);
    } finally {
      warn.mockRestore();
      jest.mocked(resolvePlugins).mockReset();
      jest.mocked(resolvePlugins).mockImplementation(() =>
        Promise.resolve({
          mcpServers: {},
          cursorCapabilities: { skills: [], commands: mockCommands },
        } as never),
      );
      await session.destroy();
    }
  });

  it('announces again on the next turn when the notice could not be delivered', async () => {
    mockWorkspace.cowork = false;
    jest.mocked(resolvePlugins).mockResolvedValue({
      mcpServers: {
        shaky: { type: 'http', url: 'https://shaky.example/mcp' },
      },
      mcpServerBindings: {},
      cursorCapabilities: { skills: [], commands: mockCommands },
    } as never);
    jest.mocked(runCopilotTurn).mockImplementation(async (config) => {
      const names = cursorCanopyMcpServerNames('default');
      await config.onToolsReady?.({ version: 1, digest: 'a'.repeat(64) }, [
        { name: names.main, status: 'connected' },
        { name: names.ui, status: 'connected' },
        { name: 'shaky', status: 'failed', error: 'Connection refused' },
      ]);
      return {
        sessionId: 'fixture-session',
        text: 'Done',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      };
    });
    const events: unknown[] = [];
    let failNotice = true;
    const { session } = startSession((event) => {
      if (
        failNotice &&
        event &&
        typeof event === 'object' &&
        'messageId' in event &&
        String(event.messageId).endsWith(':mcp-unavailable')
      ) {
        failNotice = false;
        throw new Error('renderer gone');
      }
      events.push(event);
    });
    const warn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    try {
      await sendAndSettle(session, events, 'One');
      await sendAndSettle(session, events, 'Two');
      const serialized = events.map((event) => JSON.stringify(event));
      // The first delivery threw, so the map was never committed and the
      // second turn announces the same failure again.
      expect(
        serialized.filter((text) =>
          text.includes("Couldn't connect to the MCP server shaky"),
        ),
      ).toHaveLength(1);
    } finally {
      warn.mockRestore();
      jest.mocked(resolvePlugins).mockReset();
      jest.mocked(resolvePlugins).mockImplementation(() =>
        Promise.resolve({
          mcpServers: {},
          cursorCapabilities: { skills: [], commands: mockCommands },
        } as never),
      );
      await session.destroy();
    }
  });

  it("fails closed when the app's own tool server did not connect", async () => {
    mockWorkspace.cowork = false;
    jest.mocked(runCopilotTurn).mockImplementation(async (config) => {
      const names = cursorCanopyMcpServerNames('default');
      await config.onToolsReady?.({ version: 1, digest: 'a'.repeat(64) }, [
        { name: names.main, status: 'failed', error: 'Connection refused' },
        { name: names.ui, status: 'connected' },
      ]);
      return {
        sessionId: 'fixture-session',
        text: 'Done',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      };
    });
    const events: unknown[] = [];
    const { session } = startSession((event) => events.push(event));
    try {
      await sendAndSettle(session, events, 'Hello');
      const serialized = JSON.stringify(events);
      expect(serialized).toContain('"type":"error"');
      expect(serialized).toContain(
        "Couldn't connect to the app's tools for Copilot. Send again.",
      );
    } finally {
      await session.destroy();
    }
  });

  it('rebuilds the slash menu when the inherited set changes between turns', async () => {
    mockWorkspace.cowork = false;
    mockInherited = { ...emptyInherited(), fingerprint: 'fp-a' };
    const events: unknown[] = [];
    const { session } = startSession((event) => events.push(event));
    try {
      await sendAndSettle(session, events, 'One');
      mockRefreshInventory.mockClear();
      await sendAndSettle(session, events, 'Two');
      expect(mockRefreshInventory).not.toHaveBeenCalled();
      mockInherited = { ...emptyInherited(), fingerprint: 'fp-b' };
      await sendAndSettle(session, events, 'Three');
      expect(mockRefreshInventory).toHaveBeenCalledWith(
        'copilot-inherited-capabilities',
      );
    } finally {
      await session.destroy();
    }
  });
});
