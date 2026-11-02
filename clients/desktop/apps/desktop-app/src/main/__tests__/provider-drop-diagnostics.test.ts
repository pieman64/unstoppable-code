import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mockQuery = jest.fn();
const mockRecordSessionDiagnostic = jest.fn();

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  get query(): typeof mockQuery {
    return mockQuery;
  },
}));
jest.mock('../observability', () => ({
  getObservabilityService: (): Record<string, jest.Mock> => ({
    recordSessionDiagnostic: mockRecordSessionDiagnostic,
    beginClaudeQuery: jest.fn(),
    endClaudeQuery: jest.fn(),
    observeChatEvent: jest.fn(),
  }),
}));
jest.mock('../codex/runtime-service', () => ({
  getCodexRuntimeService: (): { attachInteractiveClient: jest.Mock } => ({
    attachInteractiveClient: jest.fn(() => ({})),
  }),
}));
jest.mock('../agents/session-manager', () => ({
  // The session under test is its key's registered instance (CAN-4833).
  getSessionKeyOwnership: (): string => 'registered',
  registerSession: jest.fn(),
  unregisterSession: jest.fn(),
  buildSessionKey: (
    projectId: string,
    worktreeId: string,
    chatId: string,
  ): string => `${projectId}/${worktreeId}/${chatId}`,
  markTurnActive: jest.fn(),
  markTurnIdle: jest.fn(),
  noteSessionMessageQueued: jest.fn(),
  recordSessionEvent: jest.fn(),
  createSessionPhaseTimer: jest.fn(() => jest.fn()),
  isSessionAiCreditsRouted: jest.fn(() => false),
  isSessionAccountProxyRouted: jest.fn(() => false),
  recordSessionAccountProxyRoute: jest.fn(),
  resetSessionLiveBackgroundTasks: jest.fn(),
}));
jest.mock('../auth/provider-auth-state', () => ({
  isProviderNativelyAuthenticated: jest.fn().mockResolvedValue(true),
  isProviderNativelyAuthenticatedForRouting: jest.fn().mockResolvedValue(true),
}));
jest.mock('../agents/ai-credits-routing', () => ({
  isAiCreditsChosenOverAccountProxy: jest.fn(() => false),
  resolveSessionAiCreditsAttribution: jest.fn().mockResolvedValue({}),
  emitAiCreditsRoutingStatus: jest.fn(),
  emitAiCreditsUsageLimitReached: jest.fn(),
  emitAiCreditsNoBillingSource: jest.fn(),
  resolveAiCreditsRoutingAttempt: jest.fn().mockResolvedValue({
    shouldUseCredits: false,
  }),
  getAiCreditsRoutingContext: jest.fn().mockResolvedValue(null),
  hasUserSuppliedProviderCredential: jest.fn().mockResolvedValue(false),
  resolveGatewayModelEntry: jest.fn(),
  resolveOrgGatewayCredential: jest.fn().mockResolvedValue(null),
  markOrgGatewayCredentialRejected: jest.fn(),
}));
jest.mock('../agents/work-owner', () => ({
  captureSessionWorkOwner: jest.fn().mockResolvedValue(undefined),
  resolveSessionWorkOwner: jest.fn().mockResolvedValue({ kind: 'personal' }),
}));
jest.mock('../lib/model-gateway-state', () => ({
  checkModelGatewayRoute: jest
    .fn()
    .mockResolvedValue({ ok: true, orgRoute: false }),
}));
jest.mock('../lib/preferences-store', () => ({
  readLocalMemoryEnabledPreference: jest.fn().mockResolvedValue(false),
  readLatestPreferencesFile: jest.fn().mockResolvedValue({}),
}));
jest.mock('../services/attention-tracker', () => ({
  getAttentionTracker: (): { mark: jest.Mock; clear: jest.Mock } => ({
    mark: jest.fn(),
    clear: jest.fn(),
  }),
}));
jest.mock('../lib/usage-limited-chats-registry', () => ({
  recordUsageLimitedChat: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../lib/resolve-workspace-display-name', () => ({
  resolveWorkspaceRecordingSnapshot: jest.fn().mockResolvedValue({
    name: 'Workspace',
    type: 'single-repo',
  }),
}));
jest.mock('../agents/delegation/gate', () => ({
  managedDelegationEnabled: jest.fn(() => false),
}));
jest.mock('../plugins/plugin-resolver', () => ({
  resolvePlugins: jest.fn().mockResolvedValue({
    sdkPlugins: [],
    skillPluginDir: null,
    selectedCapabilityRoots: [],
    codexProcessEnv: {},
    codexMcpServers: {},
    mcpServers: {},
    warnings: [],
  }),
  cleanupWorktreeChatPluginDirs: jest.fn(),
}));
jest.mock('../plugins/global-plugin-overlay', () => ({
  resolveEffectiveChatPluginContext: jest.fn((selections?: unknown) =>
    Promise.resolve({ selections: selections ?? {} }),
  ),
}));
jest.mock('../plugins/invocable-inventory-service', () => ({
  loadCachedInventory: jest.fn().mockResolvedValue(null),
}));
jest.mock('../mcp/http-proxy-service', () => ({
  getMcpHttpProxyService: jest.fn(() => ({
    registerCanopyWorktreeSessionRoute: jest.fn().mockResolvedValue('route'),
    unregisterCanopyWorktreeSessionRoute: jest.fn(),
    unregisterRoutesForSession: jest.fn(),
    getCanopyWorktreeMcpUrl: jest.fn(() => 'http://127.0.0.1/mcp'),
    getCanopyWorktreeUiMcpUrl: jest.fn(() => 'http://127.0.0.1/ui-mcp'),
    getCodexCapabilityAuthorityIds: jest.fn(() => []),
  })),
}));
jest.mock('../agents/codex-gateway-proxy-service', () => ({
  getCodexGatewayProxyService: jest.fn(() => ({
    registerRoute: jest.fn().mockResolvedValue({
      routeId: 'route',
      baseUrl: 'http://127.0.0.1/route',
    }),
    unregisterRoutesForSession: jest.fn(),
  })),
}));
jest.mock('../pipelines/config-paths', () => ({
  getEnhancedEnv: jest.fn(() => ({ ...process.env })),
  getBundledClaudeBinaryPath: jest.fn(() => '/mock/claude'),
  getBundledRtkBinaryPath: jest.fn(() => '/mock/rtk'),
  getBundledRgBinaryPath: jest.fn(() => '/mock/rg'),
  getRtkManagedEnv: jest.fn(() => ({})),
}));
jest.mock('../lib/plan-persistence', () => ({
  createTrackedPlan: jest.fn(),
  updateTrackedPlan: jest.fn(),
}));
jest.mock('../lib/window-send', () => ({
  sendToWindow: jest.fn(),
  sendToWindowDetailed: jest.fn(() => ({
    delivered: false,
    reason: 'no_window',
  })),
}));
jest.mock('../approvals/approval-service', () => ({
  createApprovalSession: jest.fn(() => ({
    check: jest.fn().mockResolvedValue({ decision: 'allow' }),
    setMode: jest.fn(),
    invalidatePending: jest.fn(),
    dispose: jest.fn(),
  })),
}));
jest.mock('../ollama/claude-compatible', () => ({
  resolveClaudeCompatibleInvocation: jest.fn(),
}));
jest.mock('../codex/fork-thread', () => ({
  waitForPendingCodexFork: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../codex/transcript-seed', () => ({
  loadCodexForkContinuation: jest.fn().mockResolvedValue(undefined),
  loadPersistedCodexFallbackSeedItems: jest.fn().mockResolvedValue([]),
}));
jest.mock('../codex/speed-policy', () => ({
  admitCodexSpeed: jest.fn().mockResolvedValue({
    speed: 'standard',
    availability: { speed: 'standard', status: 'available', reason: 'default' },
  }),
  reportCodexSpeedTurnFailure: jest.fn(() => false),
}));

import {
  initAiGatewayModels,
  initClaudeModels,
  initCodexModels,
  initModelAliases,
  initOllamaModels,
  omitModelFeatureFlags,
} from '@canopy/desktop-shared/types';
import { parseModelPackageConfig } from '@canopy/desktop-shared/model-config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ClaudeCodeProvider } from '../agents/claude-session';
import { CodexAppServerClient } from '../codex/app-server-client';
import { createCodexContractGuard } from '../agents/provider-contract-guard';
import { ChatStateService } from '../services/chat-state-service';
import { ChatStateV2Repository } from '../services/chat-state-v2-repository';
import { recordChatEventDropped } from '../lib/chat-event-drop-diagnostics';
import type { ChatEventDrop } from '../lib/chat-event-drop-diagnostics';
import type { SessionDiagnosticRecord } from '../observability/service';

type ProviderEventDrop = Omit<
  ChatEventDrop,
  'projectId' | 'worktreeId' | 'chatId'
>;

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function initializeModelCatalog(): void {
  const pkg: unknown = JSON.parse(
    readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
  );
  const config = parseModelPackageConfig(pkg);
  const codexModels = omitModelFeatureFlags(config.codexModels);
  initClaudeModels(omitModelFeatureFlags(config.claudeModels));
  initCodexModels(codexModels);
  initAiGatewayModels([], []);
  initModelAliases(config.modelAliases);
  initOllamaModels([]);
}

describe('provider event drop diagnostics', () => {
  beforeAll(() => initializeModelCatalog());

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('records an ownerless Claude task-notification prelude result', async () => {
    const prelude = {
      type: 'result',
      is_error: false,
      num_turns: 0,
      result: '',
      origin: { kind: 'task_notification' },
    };
    mockQuery.mockImplementation(() =>
      Object.assign(
        (async function* (): AsyncGenerator<unknown, void> {
          await Promise.resolve();
          yield prelude;
        })(),
        {
          applyFlagSettings: jest.fn().mockResolvedValue(undefined),
          setPermissionMode: jest.fn().mockResolvedValue(undefined),
          setModel: jest.fn().mockResolvedValue(undefined),
        },
      ),
    );

    const sessionOptions = {
      cwd: '/tmp/repo',
      projectId: 'project-drop',
      worktreeId: 'worktree-drop',
      chatId: 'claude-chat',
    };
    // Preserve the legacy option this test passes at runtime while keeping it
    // outside the current AgentSessionOptions shape.
    Reflect.set(sessionOptions, 'resumeSessionId', 'resumed-session');
    const session = new ClaudeCodeProvider().createSession(
      sessionOptions,
      jest.fn(),
      () => null,
    );
    await flush();
    await flush();

    expect(mockQuery).toHaveBeenCalled();
    expect(mockRecordSessionDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'chat_event_dropped',
        projectId: 'project-drop',
        worktreeId: 'worktree-drop',
        chatId: 'claude-chat',
        providerType: 'claude',
        chatEventDropGate: 'claude_prelude_without_turn',
        chatEventDropReason: 'no_foreground_turn',
        eventType: 'result',
      }),
    );
    expect(mockRecordSessionDiagnostic).toHaveBeenCalledTimes(1);
    await session.destroy();
  });

  it('reports Codex notifications the lifecycle table lacks, with the harness version (turn-state phase 43b)', async () => {
    const scope = {
      sessionKey: 'project-drop/worktree-drop/codex-chat',
      projectId: 'project-drop',
      worktreeId: 'worktree-drop',
      chatId: 'codex-chat',
    };
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      ...scope,
      initialThreadId: 'root-thread',
      onEvent: jest.fn(),
      providerContractGuard: createCodexContractGuard(
        scope,
        (diagnostic: SessionDiagnosticRecord): void => {
          mockRecordSessionDiagnostic(diagnostic);
        },
      ),
      getWindow: (): null => null,
    });
    Reflect.set(client, 'connection', {
      harnessUserAgent: (): string => 'canopy/0.50.0 (Mac OS 15.5.0; arm64)',
    });

    await client.handleConnectionNotification('thread/brandNew', {
      params: { threadId: 'root-thread' },
    });
    await flush();

    expect(mockRecordSessionDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'provider_contract_unknown_event',
        providerType: 'codex',
        providerContractEvent: 'thread/brandNew',
        chatId: 'codex-chat',
      }),
    );
    expect(mockRecordSessionDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'provider_harness_version',
        providerType: 'codex',
        providerHarnessVersion: 'canopy/0.50.0',
      }),
    );

    // A pooled connection hands every session an unknown method no owner claims.
    client.handleUnroutedUnknownNotification('account/brandNew');
    expect(mockRecordSessionDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'provider_contract_unknown_event',
        providerType: 'codex',
        providerContractEvent: 'account/brandNew',
      }),
    );
  });

  it('records a root Codex completion discarded without an active turn', async () => {
    const onProviderEventDropped = jest.fn((drop: ProviderEventDrop): void => {
      const target = {
        projectId: 'project-drop',
        worktreeId: 'worktree-drop',
        chatId: 'codex-chat',
        providerType: 'codex' as const,
      };
      recordChatEventDropped({ ...drop, ...target });
    });
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project-drop',
      worktreeId: 'worktree-drop',
      chatId: 'codex-chat',
      sessionKey: 'project-drop/worktree-drop/codex-chat',
      initialThreadId: 'root-thread',
      onEvent: jest.fn(),
      onProviderEventDropped,
      getWindow: (): null => null,
    });

    await client.handleConnectionNotification('turn/completed', {
      params: {
        threadId: 'root-thread',
        turn: { id: 'completed-turn', status: 'completed' },
      },
    });
    await flush();

    expect(onProviderEventDropped).toHaveBeenCalledWith(
      expect.objectContaining({
        gate: 'codex_root_completion_stale',
        reason: 'no_active_turn',
        providerThreadId: 'root-thread',
        providerTurnId: 'completed-turn',
      }),
    );
    expect(onProviderEventDropped.mock.calls[0]?.[0]?.data).toMatchObject({
      method: 'turn/completed',
    });
    expect(mockRecordSessionDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        chatEventDropGate: 'codex_root_completion_stale',
        chatEventDropReason: 'no_active_turn',
        eventType: 'turn/completed',
        providerThreadId: 'root-thread',
        providerTurnId: 'completed-turn',
      }),
    );

    const activeTurnItems = new Map<string, unknown>();
    Reflect.set(client, 'activeTurn', {
      turnId: 'active-turn',
      items: activeTurnItems,
    });
    await client.handleConnectionNotification('turn/completed', {
      params: {
        threadId: 'root-thread',
        turn: { id: 'stale-turn', status: 'completed' },
      },
    });
    await flush();

    expect(onProviderEventDropped).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        gate: 'codex_root_completion_stale',
        reason: 'turn_id_mismatch',
        providerThreadId: 'root-thread',
        providerTurnId: 'stale-turn',
      }),
    );
    expect(mockRecordSessionDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        chatEventDropGate: 'codex_root_completion_stale',
        chatEventDropReason: 'turn_id_mismatch',
        eventType: 'turn/completed',
        providerThreadId: 'root-thread',
        providerTurnId: 'stale-turn',
      }),
    );
    expect(activeTurnItems.size).toBe(0);
  });

  it('records post-terminal root command deltas without provider output text', async () => {
    const onProviderEventDropped = jest.fn((drop: ProviderEventDrop): void => {
      recordChatEventDropped({
        ...drop,
        projectId: 'project-drop',
        worktreeId: 'worktree-drop',
        chatId: 'codex-chat',
        providerType: 'codex',
      });
    });
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project-drop',
      worktreeId: 'worktree-drop',
      chatId: 'codex-chat',
      sessionKey: 'project-drop/worktree-drop/codex-chat',
      initialThreadId: 'root-thread',
      onEvent: jest.fn(),
      onProviderEventDropped,
      getWindow: (): null => null,
    });
    const completedTurn = {
      rootThreadId: 'root-thread',
      turnId: 'finished-turn',
      dispatchResponseObserved: true,
      resolve: jest.fn(),
      reject: jest.fn(),
      items: new Map<string, unknown>(),
      itemRoutings: new Map<string, unknown>(),
      completedItemIds: new Set<string>(),
      commandOutputEmissions: new Map<string, unknown>(),
    };
    Reflect.set(client, 'activeTurn', completedTurn);

    await client.handleConnectionNotification('turn/started', {
      params: {
        threadId: 'root-thread',
        turn: { id: 'finished-turn', status: 'inProgress' },
      },
    });

    await client.handleConnectionNotification('turn/completed', {
      params: {
        threadId: 'root-thread',
        turn: {
          id: 'finished-turn',
          items: [],
          status: 'completed',
          error: null,
        },
      },
    });
    expect(Reflect.get(client, 'activeTurn')).toBeNull();

    await client.handleConnectionNotification(
      'item/commandExecution/outputDelta',
      {
        params: {
          threadId: 'root-thread',
          turnId: 'finished-turn',
          itemId: 'cmd-after-terminal',
          delta: 'sensitive command output must not enter diagnostics',
        },
      },
    );
    await flush();

    expect(onProviderEventDropped).toHaveBeenCalledWith(
      expect.objectContaining({
        gate: 'codex_root_output_stale',
        reason: 'no_active_turn',
        providerThreadId: 'root-thread',
        providerTurnId: 'finished-turn',
      }),
    );
    expect(mockRecordSessionDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        chatEventDropGate: 'codex_root_output_stale',
        chatEventDropReason: 'no_active_turn',
        eventType: 'item/commandExecution/outputDelta',
        providerThreadId: 'root-thread',
        providerTurnId: 'finished-turn',
      }),
    );
    expect(
      JSON.stringify(mockRecordSessionDiagnostic.mock.calls),
    ).not.toContain('sensitive command output must not enter diagnostics');
  });

  it('records stale root Codex command output with both provider ids', async () => {
    const onProviderEventDropped = jest.fn((drop: ProviderEventDrop): void => {
      recordChatEventDropped({
        ...drop,
        projectId: 'project-drop',
        worktreeId: 'worktree-drop',
        chatId: 'codex-chat',
        providerType: 'codex',
      });
    });
    const client = new CodexAppServerClient({
      cwd: '/tmp/repo',
      projectId: 'project-drop',
      worktreeId: 'worktree-drop',
      chatId: 'codex-chat',
      sessionKey: 'project-drop/worktree-drop/codex-chat',
      initialThreadId: 'root-thread',
      onEvent: jest.fn(),
      onProviderEventDropped,
      getWindow: (): null => null,
    });
    Reflect.set(client, 'activeTurn', {
      turnId: 'active-turn',
      items: new Map(),
    });

    await client.handleConnectionNotification(
      'item/commandExecution/outputDelta',
      {
        params: {
          threadId: 'root-thread',
          turnId: 'stale-turn',
          itemId: 'stale-command',
          delta: 'late output',
        },
      },
    );
    await flush();

    expect(onProviderEventDropped).toHaveBeenCalledWith(
      expect.objectContaining({
        gate: 'codex_root_output_stale',
        reason: 'turn_id_mismatch',
        providerThreadId: 'root-thread',
        providerTurnId: 'stale-turn',
      }),
    );
    expect(onProviderEventDropped.mock.calls[0]?.[0]?.data).toMatchObject({
      method: 'item/commandExecution/outputDelta',
    });
    expect(mockRecordSessionDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        chatEventDropGate: 'codex_root_output_stale',
        chatEventDropReason: 'turn_id_mismatch',
        eventType: 'item/commandExecution/outputDelta',
        providerThreadId: 'root-thread',
        providerTurnId: 'stale-turn',
      }),
    );
  });

  it('records provider events rejected by canonical turn admission', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'chat-event-drop-'));
    const paths = {
      tabs: join(tempDir, 'chats.json'),
      archives: join(tempDir, 'archives.json'),
      journal: join(tempDir, 'journal.jsonl'),
    };
    const repository = new ChatStateV2Repository({
      resolvePaths: (): typeof paths => paths,
    });
    const recordDiagnostic = jest.fn<void, [SessionDiagnosticRecord]>();
    const service = new ChatStateService({ repository, recordDiagnostic });
    const scope = {
      projectId: 'project-drop',
      worktreeId: 'worktree-drop',
      chatId: 'canonical-chat',
    };

    try {
      await service.command({
        schemaVersion: 1,
        commandId: 'create-chat',
        projectId: scope.projectId,
        worktreeId: scope.worktreeId,
        command: {
          type: 'chat.create_tab',
          tabId: scope.chatId,
          title: 'Drop diagnostics',
          providerType: 'codex',
        },
      });
      await repository.transact(
        { projectId: scope.projectId, worktreeId: scope.worktreeId },
        [
          {
            type: 'runtime.patched',
            chatId: scope.chatId,
            runtime: {
              status: 'streaming',
              queuedMessageIds: [],
              activeTurn: {
                userMessageId: 'owner-turn',
                startedAt: 1,
              },
            },
          },
        ],
        { source: 'provider', mutationId: 'set-active-turn' },
      );

      await expect(
        service.ingestProviderEvent({
          ...scope,
          providerType: 'codex',
          mutationId: 'stale-event',
          turnUserMessageId: 'stale-turn',
          data: {
            type: 'assistant',
            canopy_turn_user_message_id: 'stale-turn',
            message: {
              id: 'stale-assistant',
              role: 'assistant',
              content: [{ type: 'text', text: 'Late response' }],
            },
          },
        }),
      ).resolves.toBe(false);

      expect(recordDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'chat_event_dropped',
          chatEventDropGate: 'canonical_admission_rejected',
          chatEventDropReason: 'stale_turn_mismatch',
          eventType: 'assistant',
          eventTurnUserMessageId: 'stale-turn',
          turnUserMessageId: 'owner-turn',
          providerType: 'codex',
        }),
      );
    } finally {
      await repository.drainAll();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('records malformed input-delivery provider events rejected before admission', async () => {
    const recordDiagnostic = jest.fn<void, [SessionDiagnosticRecord]>();
    const service = new ChatStateService({ recordDiagnostic });

    await expect(
      service.ingestProviderEvent({
        projectId: 'project-drop',
        worktreeId: 'worktree-drop',
        chatId: 'invalid-delivery',
        providerType: 'codex',
        data: {
          type: 'canopy_input_delivery',
          phase: 'picked-up',
          startsTurn: true,
        },
      }),
    ).resolves.toBe(false);

    expect(recordDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'chat_event_dropped',
        chatEventDropGate: 'canonical_admission_rejected',
        chatEventDropReason: 'invalid_input_delivery_event',
        eventType: 'canopy_input_delivery',
        providerType: 'codex',
      }),
    );
  });
});
