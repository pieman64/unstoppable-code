import type * as LedgerModule from '../claude-session-cost-ledger';
import type { ClaudeSessionCostLedger } from '../claude-session-cost-ledger';
const mockReaddir = jest.fn<Promise<string[]>, [string]>();
const mockReadFile = jest.fn<Promise<string>, [string, string?]>();
const mockAppendFile = jest.fn<Promise<void>, [string, string]>();
const mockMkdir = jest.fn<Promise<void>, [string, { recursive?: boolean }?]>();
const mockStat = jest.fn<Promise<{ size: number }>, [string]>();
const mockWriteFile = jest.fn<Promise<void>, [string, string]>();
const mockReadPreferencesFile = jest.fn();
const mockPeekProviderAccountIdentity = jest.fn<
  ProviderAccountIdentity | null,
  []
>(() => null);
const mockPeekProviderBillingAccountKind = jest.fn(() => 'api_key');
const mockCheckClaudeAuthStatusObserved = jest.fn();
const mockWarmProviderAccountIdentity = jest.fn();

function mockReaddirStub(path: string): Promise<string[]> {
  return mockReaddir(path);
}

jest.mock('node:fs/promises', () => ({
  get appendFile(): typeof mockAppendFile {
    return mockAppendFile;
  },
  get mkdir(): typeof mockMkdir {
    return mockMkdir;
  },
  get readFile(): typeof mockReadFile {
    return mockReadFile;
  },
  readdir: mockReaddirStub,
  rename: jest.fn(),
  rm: jest.fn(),
  get stat(): typeof mockStat {
    return mockStat;
  },
  get writeFile(): typeof mockWriteFile {
    return mockWriteFile;
  },
}));

// An in-memory Claude cost ledger: the real one persists through the mocked fs.
jest.mock('../claude-session-cost-ledger', () => {
  const actual = jest.requireActual<typeof LedgerModule>(
    '../claude-session-cost-ledger',
  );
  let ledger: ClaudeSessionCostLedger | undefined;
  return {
    ...actual,
    getClaudeSessionCostLedger: (): ClaudeSessionCostLedger => {
      if (!ledger) {
        ledger = new actual.ClaudeSessionCostLedger({
          filePath: '/claude-session-costs.json',
          persistDelayMs: 0,
        });
        ledger.load = (): Promise<void> => Promise.resolve();
        ledger.flush = (): Promise<void> => Promise.resolve();
      }
      return ledger;
    },
  };
});

jest.mock('../../lib/paths', () => ({
  getAgentObservabilityAppEventsDayFilePath: (day: string): string =>
    `/app-events/${day}.jsonl`,
  getAgentObservabilityAppEventsDir: (): string => '/app-events',
  getAgentObservabilityAuditDayFilePath: (day: string): string =>
    `/audit/${day}.jsonl`,
  getAgentObservabilityAuditDir: (): string => '/audit',
  getAgentObservabilitySessionEventsDayFilePath: (day: string): string =>
    `/session-events/${day}.jsonl`,
  getAgentObservabilitySessionEventsDir: (): string => '/session-events',
  getAgentObservabilitySnapshotPath: (): string => '/audit/snapshot.json',
  getAgentObservabilityTranscriptDayDir: (day: string): string =>
    `/transcripts/${day}`,
  getAgentObservabilityTranscriptFilePath: (request: { id: string }): string =>
    `/transcripts/${request.id}.jsonl`,
  getAgentObservabilityTranscriptIndexDayFilePath: (day: string): string =>
    `/transcript-index/${day}.jsonl`,
  getAgentObservabilityTranscriptIndexDir: (): string => '/transcript-index',
  getAgentObservabilityTranscriptsDir: (): string => '/transcripts',
  getAgentObservabilityUsageEventsDayFilePath: (day: string): string =>
    `/usage/${day}.jsonl`,
  getAgentObservabilityUsageEventsDir: (): string => '/usage',
}));

jest.mock('../../lib/preferences-store', () => ({
  get readPreferencesFile(): typeof mockReadPreferencesFile {
    return mockReadPreferencesFile;
  },
}));

jest.mock('../../auth/provider-auth-state', () => ({
  get checkClaudeAuthStatusObserved(): typeof mockCheckClaudeAuthStatusObserved {
    return mockCheckClaudeAuthStatusObserved;
  },
  get peekProviderAccountIdentity(): typeof mockPeekProviderAccountIdentity {
    return mockPeekProviderAccountIdentity;
  },
  get peekProviderBillingAccountKind(): typeof mockPeekProviderBillingAccountKind {
    return mockPeekProviderBillingAccountKind;
  },
  get warmProviderAccountIdentity(): typeof mockWarmProviderAccountIdentity {
    return mockWarmProviderAccountIdentity;
  },
}));

jest.mock('../../feature-flags', () => ({
  getFeatureFlagService: (): {
    onSnapshotChanged: () => () => void;
  } => ({ onSnapshotChanged: (): (() => void) => (): void => undefined }),
}));
jest.mock('../../cursor/feature-flag', () => ({
  isCursorHarnessEnabled: (): boolean => false,
}));
jest.mock('../../cursor/account-usage', () => ({
  readCursorAccountUsage: jest.fn(),
}));
jest.mock('../../copilot/feature-flag', () => ({
  isCopilotHarnessEnabled: (): boolean => false,
}));
jest.mock('../../copilot/account-usage', () => ({
  readCopilotUsageSummary: jest.fn(),
}));
jest.mock('../../copilot/usage-events', () => ({
  onCopilotUsageChanged: (): (() => void) => (): void => undefined,
}));
jest.mock('../../memory/local/citation-tracking', () => ({
  isLocalMemoryCitationTrackingEnabled: (): Promise<boolean> =>
    Promise.resolve(false),
  trackCompletedTurnLocalMemoryCitations: (): Promise<void> =>
    Promise.resolve(),
}));
jest.mock('../../openai-pricing/pricing-client', () => ({
  getOpenAiPricingForCostingSync: (): {
    loadedFrom: 'none';
    stale: boolean;
  } => ({ loadedFrom: 'none', stale: true }),
  prewarmOpenAiPricingCache: (): void => undefined,
}));

import type { AgentDelegationTranscript } from '@canopy/protocol/delegation';
import {
  rename as renameModuleMock,
  rm as rmModuleMock,
} from 'node:fs/promises';
import type {
  AgentAuditEntry,
  PlanUsageEvent,
} from '@canopy/desktop-shared/types';
import {
  ObservabilityService,
  type PipelineExecutionStateSyncInput,
} from '../service';
import { billingBasisAtEntryStart } from '../capture-fields';
import type { ProviderAccountIdentity } from '../../auth/provider-auth-state';
import {
  onAuditEntryEnqueued,
  type AuditEntryEnqueuedEvent,
} from '../audit-stream-hooks';
import { setExperimentalFeaturesEnabled } from '../../lib/experimental-features';
import {
  recordAccountProxyResponse,
  resetAccountProxyAttributionForTests,
} from '../../account-proxy/attribution';

const mockRename = jest.mocked(renameModuleMock);
const mockRm = jest.mocked(rmModuleMock);

const NOW = Date.parse('2026-10-08T12:00:00.000Z');
const ZERO_TOOL_COUNTS: AgentAuditEntry['toolCounts'] = {
  thinking: 0,
  bash: 0,
  read: 0,
  readLines: 0,
  writeEdit: 0,
  plan: 0,
  fileEdit: 0,
  fileAdd: 0,
  fileDelete: 0,
  search: 0,
  grep: 0,
  web: 0,
  agent: 0,
  workflow: 0,
  tasks: 0,
  taskStop: 0,
  skills: 0,
  monitor: 0,
  claude: 0,
  scheduleWakeup: 0,
  askUser: 0,
  scriptOutput: 0,
  watcher: 0,
  canopy: 0,
  graph: 0,
  appAdvisor: 0,
  pipelineEditor: 0,
  mcp: 0,
  other: 0,
};

function startChat(
  service: ObservabilityService,
  options: { provider?: 'claude' | 'codex'; chatId?: string } = {},
): void {
  service.startChatTurn({
    projectId: 'proj',
    worktreeId: 'wt',
    chatId: options.chatId ?? 'chat',
    provider: options.provider ?? 'claude',
    originalUserText: 'Private prompt must not be captured',
    submittedText: 'Private prompt must not be captured',
    userMessageId: 'msg-1',
    planMode: false,
    isStandalone: false,
  });
}

function recentEntry(
  service: ObservabilityService,
  chatId = 'chat',
): AgentAuditEntry {
  const entry = service
    .loadSnapshot()
    .recentEntries.find((candidate) => candidate.chatId === chatId);
  if (!entry) throw new Error(`Expected audit entry for ${chatId}`);
  return entry;
}

function delegationTranscript(): AgentDelegationTranscript {
  return {
    delegationId: 'delegate-1',
    runGeneration: 1,
    sequence: 1,
    parentHarnessId: 'claude',
    parentTurnId: 'parent-turn-1',
    parentToolCallId: 'tool-call-1',
    createdAt: NOW - 1_000,
    task: {
      description: 'Private delegate description',
      prompt: 'Private delegate prompt',
      executionMode: 'foreground',
    },
    snapshot: {
      delegationId: 'delegate-1',
      status: 'running',
      outputTruncated: false,
      routeSnapshot: {
        selectedModelId: 'codex-route',
        selectedModelLabel: 'Codex delegate',
        runtimeModelLabel: 'Codex model',
        runtimeModelId: 'gpt-6-luna',
        harnessId: 'codex',
        runtimeKind: 'codex-app-server',
        runnerRegistrationId: 'codex-local-v1',
        runtimeVersion: '1',
        adapterVersion: '1',
        modelSource: 'codex-managed',
        providerType: 'codex',
        assignmentRevision: 'revision-1',
        billingAuthority: 'native',
        aiCreditsRouted: false,
        capabilities: [],
        supportedThinkingLevels: ['low', 'medium', 'high'],
        capabilitySnapshotHash: 'hash-1',
        capabilityGeneration: 1,
        policyRevision: 'policy-1',
      },
      usage: {
        inputTokens: 40,
        outputTokens: 10,
        cachedInputTokens: 20,
        costUsd: 0.25,
      },
    },
    transcript: [],
  };
}

describe('audit capture gaps', () => {
  let services: ObservabilityService[];

  beforeEach(() => {
    resetAccountProxyAttributionForTests();
    jest.useFakeTimers().setSystemTime(NOW);
    setExperimentalFeaturesEnabled(false);
    mockAppendFile.mockClear();
    services = [];
    mockReadPreferencesFile.mockResolvedValue({ auditRetentionDays: 30 });
    mockPeekProviderAccountIdentity.mockReturnValue(null);
    mockPeekProviderBillingAccountKind.mockReturnValue('api_key');
    mockReadFile.mockImplementation((path): Promise<string> => {
      if (path === '/audit/2026-10-08.jsonl') return Promise.resolve('');
      return Promise.resolve('');
    });
    mockReaddir.mockImplementation(
      (path): Promise<string[]> => Promise.resolve(path === '/audit' ? [] : []),
    );
    mockAppendFile.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);
    mockRm.mockResolvedValue(undefined);
    mockStat.mockResolvedValue({ size: 0 });
    mockWriteFile.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await Promise.all(services.map((service) => service.dispose()));
    setExperimentalFeaturesEnabled(false);
    jest.useRealTimers();
  });

  function createService(): ObservabilityService {
    const service = new ObservabilityService();
    services.push(service);
    return service;
  }

  it('snapshots API-key billing basis at entry start for chat and helper entries', () => {
    const service = createService();
    startChat(service);
    mockPeekProviderBillingAccountKind.mockReturnValue('subscription');
    service.completeChatTurn('proj', 'wt', 'chat', 'success');

    expect(recentEntry(service).billingBasis).toBe('api_key');

    const helper: AgentAuditEntry = {
      id: 'helper-1',
      eventType: 'local_memory_consolidation',
      status: 'running',
      provider: 'codex',
      label: 'Helper',
      startedAt: new Date(NOW).toISOString(),
      tokens: {
        input: 0,
        output: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      messageCount: 0,
      assistantMessageCount: 0,
      toolUseCount: 0,
      subAgentCount: 0,
      hasTranscript: false,
      toolCounts: ZERO_TOOL_COUNTS,
    };
    mockPeekProviderBillingAccountKind.mockReturnValue('bedrock');
    service.startObservedTask('helper:test', helper);
    mockPeekProviderBillingAccountKind.mockReturnValue('subscription');
    service.finalizeObservedTask('helper:test', 'success');
    expect(
      service
        .loadSnapshot()
        .recentEntries.find((entry) => entry.id === 'helper-1')?.billingBasis,
    ).toBe('api_key');
  });

  it.each([
    ['subscription', 'claude', 'subscription', false, false],
    ['subscription', 'codex', 'subscription', false, false],
    ['api_key', 'claude', 'api_key', false, false],
    ['api_key', 'codex', 'api_key', false, false],
    ['api_key', 'claude', 'bedrock', false, false],
    ['api_key', 'codex', 'bedrock', false, false],
    ['unknown', 'claude', 'unknown', false, false],
    ['unknown', 'codex', 'unknown', false, false],
    ['local', 'ollama', 'unknown', false, false],
    ['ai_credits', 'claude', 'subscription', true, false],
    ['ai_credits', 'codex', 'subscription', true, false],
    ['account_proxy', 'claude', 'subscription', false, true],
    ['account_proxy', 'codex', 'subscription', false, true],
  ] as const)(
    'stamps chat billing %s from the start snapshot',
    (basis, provider, accountKind, aiCreditsRouted, accountProxyRouted) => {
      const service = createService();
      mockPeekProviderBillingAccountKind.mockReturnValue(accountKind);
      service.startChatTurn({
        projectId: 'proj',
        worktreeId: 'wt',
        chatId: 'chat',
        provider,
        aiCreditsRouted,
        accountProxyRouted,
        originalUserText: '',
        submittedText: '',
        userMessageId: 'msg-1',
        planMode: false,
        isStandalone: false,
      });
      mockPeekProviderBillingAccountKind.mockReturnValue('subscription');
      service.completeChatTurn('proj', 'wt', 'chat', 'success');
      expect(recentEntry(service).billingBasis).toBe(basis);
    },
  );

  it.each([
    ['subscription', 'claude', 'subscription', false, false, true],
    ['subscription', 'codex', 'subscription', false, false, true],
    ['api_key', 'claude', 'api_key', false, false, true],
    ['api_key', 'codex', 'api_key', false, false, true],
    ['api_key', 'claude', 'bedrock', false, false, true],
    ['api_key', 'codex', 'bedrock', false, false, true],
    ['account_proxy', 'claude', 'subscription', false, true, false],
    ['account_proxy', 'codex', 'subscription', false, true, false],
    ['unknown', 'claude', 'unknown', false, false, false],
    ['unknown', 'codex', 'unknown', false, false, false],
    ['ai_credits', 'claude', 'subscription', true, false, false],
    ['local', 'ollama', 'unknown', false, false, false],
  ] as const)(
    'preserves the original %s billing basis and identity when a %s chat resumes',
    async (
      basis,
      provider,
      accountKind,
      aiCreditsRouted,
      accountProxyRouted,
      hasOriginalIdentity,
    ) => {
      const service = createService();
      const originalIdentity: ProviderAccountIdentity = {
        providerAccountKey: `${provider}:original-account`,
        accountEmail: 'original@example.com',
        planType: 'max',
      };
      mockPeekProviderBillingAccountKind.mockReturnValue(accountKind);
      mockPeekProviderAccountIdentity.mockReturnValue(
        hasOriginalIdentity ? originalIdentity : null,
      );

      service.startChatTurn({
        projectId: 'proj',
        worktreeId: 'wt',
        chatId: 'chat',
        provider,
        aiCreditsRouted,
        accountProxyRouted,
        originalUserText: 'Original prompt',
        submittedText: 'Original prompt',
        userMessageId: 'msg-1',
        planMode: false,
        isStandalone: false,
      });
      if (provider === 'codex') {
        service.observeChatEvent('proj', 'wt', 'chat', {
          type: 'codex',
          event: {
            type: 'item.completed',
            item: {
              type: 'agent_message',
              id: 'initial-result',
              text: 'Initial result',
            },
          },
        });
      } else {
        service.observeChatEvent('proj', 'wt', 'chat', {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Initial result' }] },
        });
      }
      service.completeChatTurn('proj', 'wt', 'chat', 'success');

      expect(recentEntry(service).billingBasis).toBe(basis);
      mockPeekProviderBillingAccountKind.mockReturnValue(
        accountKind === 'subscription' ? 'api_key' : 'subscription',
      );
      mockPeekProviderAccountIdentity.mockReturnValue({
        providerAccountKey: `${provider}:current-account`,
        accountEmail: 'current@example.com',
        planType: 'team',
      });
      mockPeekProviderBillingAccountKind.mockClear();
      mockPeekProviderAccountIdentity.mockClear();

      if (provider === 'codex') {
        service.observeChatEvent('proj', 'wt', 'chat', {
          type: 'codex',
          event: {
            type: 'item.completed',
            item: {
              type: 'agent_message',
              id: 'late-result',
              text: 'Continuation',
            },
          },
        });
      } else {
        service.observeChatEvent('proj', 'wt', 'chat', {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Continuation' }] },
        });
      }
      service.completeChatTurn('proj', 'wt', 'chat', 'success');

      const resumedEntry = recentEntry(service);
      expect(resumedEntry.billingBasis).toBe(basis);
      expect(mockPeekProviderBillingAccountKind).not.toHaveBeenCalled();
      expect(mockPeekProviderAccountIdentity).not.toHaveBeenCalled();
      if (hasOriginalIdentity && !aiCreditsRouted) {
        expect(resumedEntry).toMatchObject({
          providerAccountKey: originalIdentity.providerAccountKey,
          providerAccountEmail: originalIdentity.accountEmail,
          providerPlanType: originalIdentity.planType,
        });
      } else {
        expect(resumedEntry).not.toHaveProperty('providerAccountKey');
        expect(resumedEntry).not.toHaveProperty('providerAccountEmail');
      }

      await service.dispose();
    },
  );

  it('revives a completed turn for an injected prompt without inventing a legacy billing basis', async () => {
    const service = createService();
    service.startChatTurn({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      provider: 'claude',
      originalUserText: 'Original prompt',
      submittedText: 'Original prompt',
      userMessageId: 'msg-1',
      planMode: false,
      isStandalone: false,
    });
    service.completeChatTurn('proj', 'wt', 'chat', 'success');
    const legacyEntry = recentEntry(service);
    delete legacyEntry.billingBasis;
    await service.flush();

    const injectedPrompt = {
      kind: 'system_prompt_append' as const,
      provider: 'claude' as const,
      applicationCondition: 'claude_system_prompt_append_each_turn' as const,
      text: 'A continuation prompt.',
    };
    service.recordInjectedPromptForOpenChatTurn(
      'proj',
      'wt',
      'chat',
      injectedPrompt,
    );

    expect(recentEntry(service).status).toBe('running');
    expect(
      service.getInjectedPromptsForTests('proj', 'wt', 'chat'),
    ).toContainEqual(injectedPrompt);

    service.completeChatTurn('proj', 'wt', 'chat', 'success');

    expect(recentEntry(service)).not.toHaveProperty('billingBasis');
    await service.dispose();
  });

  it('uses the route settled after a proxy chat is revived', async () => {
    const service = createService();
    const nativeIdentity: ProviderAccountIdentity = {
      providerAccountKey: 'claude:native-account',
      accountEmail: 'native@example.com',
      planType: 'max',
    };
    mockPeekProviderBillingAccountKind.mockReturnValue('subscription');
    mockPeekProviderAccountIdentity.mockReturnValue(nativeIdentity);
    service.startChatTurn({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      provider: 'claude',
      accountProxyRouted: true,
      originalUserText: 'Original prompt',
      submittedText: 'Original prompt',
      userMessageId: 'msg-1',
      planMode: false,
      isStandalone: false,
    });
    service.completeChatTurn('proj', 'wt', 'chat', 'success');

    service.observeChatEvent('proj', 'wt', 'chat', {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Continuation' }] },
    });
    service.setChatTurnAccountProxyRouted('proj/wt/chat', false);
    service.completeChatTurn('proj', 'wt', 'chat', 'success');

    expect(recentEntry(service)).toMatchObject({
      billingBasis: 'subscription',
      providerAccountKey: nativeIdentity.providerAccountKey,
      providerAccountEmail: nativeIdentity.accountEmail,
    });
    await service.dispose();
  });

  it('never credits an account proxy turn to the native account', () => {
    // The user also has their own subscription, but the proxy served this
    // turn: it is billed to the proxy, never to the native account.
    const service = createService();
    mockPeekProviderBillingAccountKind.mockReturnValue('subscription');
    mockPeekProviderAccountIdentity.mockReturnValue({
      providerAccountKey: 'claude:native',
      accountEmail: 'me@example.com',
      planType: 'max',
    });
    service.startChatTurn({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      provider: 'claude',
      accountProxyRouted: true,
      originalUserText: '',
      submittedText: '',
      userMessageId: 'msg-1',
      planMode: false,
      isStandalone: false,
    });
    service.completeChatTurn('proj', 'wt', 'chat', 'success');

    expect(recentEntry(service).billingBasis).toBe('account_proxy');
    expect(recentEntry(service).providerAccountKey).toBeUndefined();
    expect(recentEntry(service).providerAccountEmail).toBeUndefined();
  });

  it('records the proxy accounts that served each chat turn', () => {
    const service = createService();
    const respond = (sessionId: string, trace: string): void => {
      recordAccountProxyResponse({
        sessionId,
        connectionId: 'conn-1',
        traceHeader: trace,
        lookupAccount: (authIndex) =>
          authIndex === 'a1f3c2d4a1f3c2d4'
            ? { label: 'sam@example.com', provider: 'claude' }
            : null,
      });
    };
    // Before any turn opens: nothing to record it on.
    respond('proj/wt/chat', '20261012204400-a1f3c2d4a1f3c2d4-0001');
    service.startChatTurn({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      provider: 'claude',
      accountProxyRouted: true,
      originalUserText: '',
      submittedText: '',
      userMessageId: 'msg-1',
      planMode: false,
      isStandalone: false,
    });
    respond('proj/wt/chat', '20261012204401-a1f3c2d4a1f3c2d4-0002');
    respond('proj/wt/chat', '20261012204402-e2a8f640e2a8f640-0003');
    respond('proj/wt/chat', '20261012204403-e2a8f640e2a8f640-0004');
    // Another chat's response stays out of this turn.
    respond('proj/wt/other', '20261012204404-a1f3c2d4a1f3c2d4-0005');
    service.completeChatTurn('proj', 'wt', 'chat', 'success');
    respond('proj/wt/chat', '20261012204405-a1f3c2d4a1f3c2d4-0006');

    expect(recentEntry(service).accountProxy).toEqual({
      connectionId: 'conn-1',
      accounts: [
        { authIndex: 'e2a8f640e2a8f640', requests: 2 },
        {
          authIndex: 'a1f3c2d4a1f3c2d4',
          label: 'sam@example.com',
          provider: 'claude',
          requests: 1,
        },
      ],
    });
  });

  it('records the proxy accounts a pipeline step attempt used', () => {
    const service = createService();
    const routeSessionId = 'pipeline:run-1:job:step:1:1:0';
    recordAccountProxyResponse({
      sessionId: routeSessionId,
      connectionId: 'conn-1',
      traceHeader: '20261012204400-a1f3c2d4a1f3c2d4-0001',
      lookupAccount: () => ({ label: 'sam@example.com', provider: 'codex' }),
    });
    service.syncPipelineExecutionState({
      id: 'run-1',
      pipeline_id: 'pipeline',
      pipeline_snapshot: { name: 'Pipeline' },
      project_id: 'proj',
      worktree_id: 'wt',
      jobs: {
        job: {
          status: 'success',
          outputs: {},
          steps: {
            step: {
              status: 'success',
              outputs: {
                canopy_account_proxy_routed: 'true',
                canopy_account_proxy_session: routeSessionId,
              },
              dynamic_env: {},
              log_format_hint: 'agent',
              agent_provider: 'codex',
              started_at: new Date(NOW).toISOString(),
              completed_at: new Date(NOW + 10).toISOString(),
            },
          },
        },
      },
    });
    const [entry] = service.loadSnapshot().recentEntries;
    expect(entry).toMatchObject({
      eventType: 'pipeline_agent_turn',
      billingBasis: 'account_proxy',
      accountProxy: {
        connectionId: 'conn-1',
        accounts: [
          {
            authIndex: 'a1f3c2d4a1f3c2d4',
            label: 'sam@example.com',
            provider: 'codex',
            requests: 1,
          },
        ],
      },
    });
  });

  it('keeps the accounts a pipeline step used before it paused and resumed', () => {
    const service = createService();
    const respond = (sessionId: string, authIndex: string): void => {
      recordAccountProxyResponse({
        sessionId,
        connectionId: 'conn-1',
        traceHeader: `20261012204400-${authIndex}-0001`,
        lookupAccount: () => null,
      });
    };
    const firstRoute = 'pipeline:run-1:job:step:1:1:0';
    const recoveryRoute = 'pipeline:run-1:job:step:1:1:1';
    respond(firstRoute, 'a1f3c2d4a1f3c2d4');
    respond(firstRoute, 'a1f3c2d4a1f3c2d4');
    const sync = (
      status: 'paused' | 'success',
      routeSessionId: string,
    ): void => {
      service.syncPipelineExecutionState({
        id: 'run-1',
        pipeline_id: 'pipeline',
        pipeline_snapshot: { name: 'Pipeline' },
        project_id: 'proj',
        worktree_id: 'wt',
        jobs: {
          job: {
            status: status === 'paused' ? 'running' : 'success',
            outputs: {},
            steps: {
              step: {
                status,
                outputs: {
                  canopy_account_proxy_routed: 'true',
                  canopy_account_proxy_session: routeSessionId,
                },
                dynamic_env: {},
                log_format_hint: 'agent',
                agent_provider: 'claude',
                started_at: new Date(NOW).toISOString(),
                ...(status === 'success'
                  ? { completed_at: new Date(NOW + 10).toISOString() }
                  : {}),
              },
            },
          },
        },
      });
    };
    // A quota pause keeps the step's entry open; the resumed step has a
    // route of its own, and the same route may be read more than once.
    sync('paused', firstRoute);
    respond(recoveryRoute, 'e2a8f640e2a8f640');
    sync('success', recoveryRoute);
    sync('success', recoveryRoute);

    const [entry] = service.loadSnapshot().recentEntries;
    expect(entry?.accountProxy).toEqual({
      connectionId: 'conn-1',
      accounts: [
        { authIndex: 'a1f3c2d4a1f3c2d4', requests: 2 },
        { authIndex: 'e2a8f640e2a8f640', requests: 1 },
      ],
    });
  });

  it('keeps responses that arrive after a chat turn ends for its revival', async () => {
    const service = createService();
    const respond = (authIndex: string): void => {
      recordAccountProxyResponse({
        sessionId: 'proj/wt/chat',
        connectionId: 'conn-1',
        traceHeader: `20261012204400-${authIndex}-0001`,
        lookupAccount: () => null,
      });
    };
    service.startChatTurn({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      provider: 'claude',
      accountProxyRouted: true,
      originalUserText: '',
      submittedText: '',
      userMessageId: 'msg-1',
      planMode: false,
      isStandalone: false,
    });
    respond('a1f3c2d4a1f3c2d4');
    service.completeChatTurn('proj', 'wt', 'chat', 'success');
    await service.flush();
    // A continuation's requests can reach the proxy before the late event
    // that reopens the turn.
    respond('e2a8f640e2a8f640');
    service.recordInjectedPromptForOpenChatTurn('proj', 'wt', 'chat', {
      kind: 'system_prompt_append',
      provider: 'claude',
      applicationCondition: 'claude_system_prompt_append_each_turn',
      text: 'Continue.',
    });
    service.completeChatTurn('proj', 'wt', 'chat', 'success');

    expect(recentEntry(service).accountProxy).toEqual({
      connectionId: 'conn-1',
      accounts: [
        { authIndex: 'a1f3c2d4a1f3c2d4', requests: 1 },
        { authIndex: 'e2a8f640e2a8f640', requests: 1 },
      ],
    });
  });

  it('credits the native account when the session fell back from the proxy', () => {
    // The session was created for the proxy, but its accounts stopped being
    // ready before spawn, so the turn ran on the user's own login.
    const service = createService();
    mockPeekProviderBillingAccountKind.mockReturnValue('subscription');
    mockPeekProviderAccountIdentity.mockReturnValue({
      providerAccountKey: 'claude:native',
      accountEmail: 'me@example.com',
      planType: 'max',
    });
    service.startChatTurn({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      provider: 'claude',
      accountProxyRouted: true,
      originalUserText: '',
      submittedText: '',
      userMessageId: 'msg-1',
      planMode: false,
      isStandalone: false,
    });
    service.setChatTurnAccountProxyRouted('proj/wt/chat', false);
    service.completeChatTurn('proj', 'wt', 'chat', 'success');

    expect(recentEntry(service).billingBasis).toBe('subscription');
    expect(recentEntry(service).providerAccountKey).toBe('claude:native');
  });

  it('snapshots billing basis for advisor and pipeline entry families at start', () => {
    const service = createService();
    service.startChatTurn({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'advisor-chat',
      provider: 'claude',
      originalUserText: 'Private advisor prompt',
      submittedText: 'Private advisor prompt',
      userMessageId: 'advisor-msg',
      planMode: false,
      isStandalone: false,
      assistantMode: 'app-advisor',
    });
    mockPeekProviderBillingAccountKind.mockReturnValue('subscription');
    service.completeChatTurn('proj', 'wt', 'advisor-chat', 'success');

    const createPipelineEntry = (
      id: string,
      eventType: 'pipeline_agent_turn' | 'pipeline_advisor',
    ): AgentAuditEntry => ({
      id,
      eventType,
      status: 'running',
      provider: 'codex',
      label: 'Pipeline',
      startedAt: new Date(NOW).toISOString(),
      pipelineExecutionId: id,
      tokens: {
        input: 0,
        output: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      messageCount: 0,
      assistantMessageCount: 0,
      toolUseCount: 0,
      subAgentCount: 0,
      hasTranscript: false,
      toolCounts: ZERO_TOOL_COUNTS,
    });
    mockPeekProviderBillingAccountKind.mockReturnValue('unknown');
    service.startObservedTask(
      'pipeline:agent',
      createPipelineEntry('pipeline-agent', 'pipeline_agent_turn'),
    );
    mockPeekProviderBillingAccountKind.mockReturnValue('bedrock');
    service.finalizeObservedTask('pipeline:agent', 'success');
    service.startObservedTask(
      'pipeline:advisor',
      createPipelineEntry('pipeline-advisor', 'pipeline_advisor'),
    );
    mockPeekProviderBillingAccountKind.mockReturnValue('subscription');
    service.finalizeObservedTask('pipeline:advisor', 'success');

    expect(service.loadSnapshot().recentEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          chatId: 'advisor-chat',
          billingBasis: 'api_key',
        }),
        expect.objectContaining({
          id: 'pipeline-agent',
          billingBasis: 'unknown',
        }),
        expect.objectContaining({
          id: 'pipeline-advisor',
          billingBasis: 'api_key',
        }),
      ]),
    );
  });

  it('prefers organization gateway billing over AI Credits when both route flags are present', () => {
    expect(billingBasisAtEntryStart('claude', 'api_key', true, true)).toBe(
      'org_gateway',
    );
  });

  it.each([
    ['subscription', 'claude', 'subscription', false, false],
    ['api_key', 'codex', 'api_key', false, false],
    ['api_key', 'claude', 'bedrock', false, false],
    ['unknown', 'codex', 'unknown', false, false],
    ['local', 'ollama', 'unknown', false, false],
    ['ai_credits', 'claude', 'subscription', true, false],
    ['org_gateway', 'claude', 'api_key', true, true],
  ] as const)(
    'stamps %s at finalize for helper and both pipeline families',
    (basis, provider, accountKind, aiCreditsRouted, modelGatewayRouted) => {
      const service = createService();
      for (const eventType of [
        'chat_summary',
        'pipeline_agent_turn',
        'pipeline_advisor',
      ] as const) {
        const id = `basis:${eventType}`;
        mockPeekProviderBillingAccountKind.mockReturnValue(accountKind);
        service.startObservedTask(id, {
          id,
          eventType,
          provider,
          aiCreditsRouted,
          modelGatewayRouted,
          status: 'running',
          label: 'Capture',
          startedAt: new Date(NOW).toISOString(),
          tokens: {
            input: 0,
            output: 0,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
          messageCount: 0,
          assistantMessageCount: 0,
          toolUseCount: 0,
          subAgentCount: 0,
          hasTranscript: false,
          toolCounts: ZERO_TOOL_COUNTS,
        });
        mockPeekProviderBillingAccountKind.mockReturnValue('subscription');
        service.finalizeObservedTask(id, 'success');
        expect(
          service.loadSnapshot().recentEntries.find((entry) => entry.id === id)
            ?.billingBasis,
        ).toBe(basis);
      }
    },
  );

  it('names a verified nested pipeline root on every child retry attempt, including late lineage', () => {
    const service = createService();
    const state: PipelineExecutionStateSyncInput = {
      id: 'nested-child',
      parent_execution_id: 'nested-parent',
      pipeline_id: 'pipeline',
      pipeline_snapshot: { name: 'Pipeline' },
      project_id: 'proj',
      worktree_id: 'wt',
      jobs: {
        job: {
          status: 'success',
          outputs: {},
          steps: {
            step: {
              status: 'success',
              outputs: {},
              dynamic_env: {},
              log_format_hint: 'agent',
              agent_provider: 'claude',
              started_at: new Date(NOW).toISOString(),
              completed_at: new Date(NOW + 10).toISOString(),
            },
          },
          retry_count: 1,
          retry_history: [
            {
              attempt: 0,
              status: 'failure',
              steps: {
                step: {
                  status: 'failure',
                  outputs: {},
                  dynamic_env: {},
                  log_format_hint: 'agent',
                  agent_provider: 'claude',
                  started_at: new Date(NOW - 100).toISOString(),
                  completed_at: new Date(NOW - 10).toISOString(),
                },
              },
            },
          ],
        },
      },
    };
    // Keep this historical malformed status at the service boundary.
    const retry = state.jobs.job.retry_history?.[0];
    if (!retry) throw new Error('Expected a retry fixture');
    const retryStep = retry.steps.step;
    if (!retryStep) throw new Error('Expected a retry step fixture');
    Reflect.set(retry, 'status', 'failed');
    Reflect.set(retryStep, 'status', 'failed');
    service.syncPipelineExecutionState(state);
    expect(
      service
        .loadSnapshot()
        .recentEntries.every((entry) => !entry.rootPipelineExecutionId),
    ).toBe(true);
    service.syncPipelineExecutionState({
      ...state,
      id: 'nested-parent',
      parent_execution_id: 'pipeline-root',
      jobs: {},
    });
    service.syncPipelineExecutionState({
      ...state,
      id: 'pipeline-root',
      parent_execution_id: undefined,
      jobs: {},
    });
    const entries = service.loadSnapshot().recentEntries;
    expect(entries).toHaveLength(2);
    expect(
      entries.every(
        (entry) =>
          entry.eventType === 'pipeline_agent_turn' &&
          entry.rootPipelineExecutionId === 'pipeline-root',
      ),
    ).toBe(true);
  });

  it('records context from Claude and Codex provider usage and keeps compactions deduped', () => {
    const service = createService();
    startChat(service);
    service.observeChatEvent('proj', 'wt', 'chat', {
      type: 'result',
      usage: {
        input_tokens: 30,
        cache_read_input_tokens: 40,
        cache_creation_input_tokens: 5,
      },
    });
    service.observeChatEvent('proj', 'wt', 'chat', {
      type: 'canopy_context_snapshot',
      userMessageId: 'msg-1',
      context: { endTokens: 75, windowTokens: 200000 },
    });
    service.observeChatEvent('proj', 'wt', 'chat', {
      type: 'canopy_compaction',
      id: 'compact-1',
      at: '2026-10-08T11:59:00.000Z',
      trigger: 'auto',
      preTokens: 180000,
    });
    service.observeChatEvent('proj', 'wt', 'chat', {
      type: 'system',
      subtype: 'compact_boundary',
      uuid: 'claude-compact-1',
      timestamp: '2026-10-08T11:58:00.000Z',
      compact_metadata: { trigger: 'manual', pre_tokens: 120000 },
    });
    service.observeChatEvent('proj', 'wt', 'chat', {
      type: 'canopy_compaction',
      id: 'claude-compact-1',
      at: '2026-10-08T11:58:00.000Z',
      trigger: 'manual',
      preTokens: 120000,
    });
    service.observeChatEvent('proj', 'wt', 'chat', {
      type: 'canopy_compaction',
      id: 'compact-1',
      at: '2026-10-08T11:59:00.000Z',
      trigger: 'auto',
      preTokens: 180000,
    });
    service.completeChatTurn('proj', 'wt', 'chat', 'success');

    expect(recentEntry(service)).toMatchObject({
      context: { endTokens: 75, windowTokens: 200000 },
      compactions: [
        { at: '2026-10-08T11:59:00.000Z', trigger: 'auto', preTokens: 180000 },
        {
          at: '2026-10-08T11:58:00.000Z',
          trigger: 'manual',
          preTokens: 120000,
        },
      ],
    });
  });

  it('records context categories with Early access off', () => {
    const service = createService();
    startChat(service);
    const context = {
      endTokens: 40,
      windowTokens: 200000,
      categories: [{ name: 'Messages', tokens: 40, kind: 'used' }],
    };
    service.observeChatEvent('proj', 'wt', 'chat', {
      type: 'canopy_context_snapshot',
      userMessageId: 'msg-1',
      context,
    });
    expect(recentEntry(service).context).toEqual(context);

    service.observeChatEvent('proj', 'wt', 'chat', {
      type: 'canopy_context_snapshot',
      userMessageId: 'msg-1',
      context: { ...context, endTokens: 50 },
    });
    expect(recentEntry(service).context).toEqual({
      endTokens: 50,
      windowTokens: 200000,
      categories: [{ name: 'Messages', tokens: 40, kind: 'used' }],
    });
  });

  const taskEvent = (
    subtype: 'task_started' | 'task_progress' | 'task_notification',
    fields: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    type: 'system',
    subtype,
    task_id: 'task-1',
    tool_use_id: 'task-tool-1',
    ...(subtype === 'task_started'
      ? { task_type: 'local_agent', description: 'Private task text' }
      : {}),
    ...fields,
  });

  it('queues the running turn again when one of its subagents ends', () => {
    const service = createService();
    const events: AuditEntryEnqueuedEvent[] = [];
    const unsubscribe = onAuditEntryEnqueued((event) => events.push(event));
    try {
      startChat(service);
      service.observeChatEvent('proj', 'wt', 'chat', taskEvent('task_started'));
      service.observeChatEvent(
        'proj',
        'wt',
        'chat',
        taskEvent('task_progress', {
          subagent_type: 'Explore',
          usage: { total_tokens: 500, tool_uses: 1, duration_ms: 10 },
        }),
      );
      events.length = 0;

      // Progress updates the entry in place without writing an audit line.
      service.observeChatEvent(
        'proj',
        'wt',
        'chat',
        taskEvent('task_progress', {
          usage: { total_tokens: 600, tool_uses: 2, duration_ms: 20 },
        }),
      );
      expect(events).toEqual([]);

      service.observeChatEvent(
        'proj',
        'wt',
        'chat',
        taskEvent('task_notification', {
          status: 'completed',
          usage: { total_tokens: 700, tool_uses: 3, duration_ms: 30 },
        }),
      );
      expect(events).toEqual([
        {
          eventType: 'worktree_chat',
          status: 'running',
          projectId: 'proj',
          worktreeId: 'wt',
          chatId: 'chat',
          cause: 'subagent_ended',
        },
      ]);
      expect(recentEntry(service).subagents?.[0]).toMatchObject({
        id: 'task-tool-1',
        totalTokens: 700,
      });

      // The same notification seen again is not a second ending.
      service.observeChatEvent(
        'proj',
        'wt',
        'chat',
        taskEvent('task_notification', {
          status: 'completed',
          usage: { total_tokens: 700, tool_uses: 3, duration_ms: 30 },
        }),
      );
      expect(events).toHaveLength(1);
    } finally {
      unsubscribe();
    }
  });

  it('uses last root Claude context, main-loop result tokens and the SDK running cost, and records Task subagents from task events', () => {
    const service = createService();
    startChat(service);
    service.observeChatEvent('proj', 'wt', 'chat', {
      type: 'assistant',
      message: {
        id: 'root-message-1',
        model: 'claude-sonnet-4-5',
        content: [],
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 3,
          output_tokens: 4,
        },
      },
    });
    service.observeChatEvent('proj', 'wt', 'chat', taskEvent('task_started'));
    service.observeChatEvent(
      'proj',
      'wt',
      'chat',
      taskEvent('task_notification', {
        status: 'completed',
        subagent_type: 'Explore',
        usage: { total_tokens: 1300, tool_uses: 2, duration_ms: 50 },
      }),
    );
    service.observeChatEvent('proj', 'wt', 'chat', {
      type: 'result',
      session_id: 'audit-capture-gaps-session-1',
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 3,
        output_tokens: 4,
        context_window: 200000,
      },
      total_cost_usd: 0.75,
      modelUsage: {
        'claude-sonnet-4-5': {
          inputTokens: 10,
          outputTokens: 4,
          cacheReadInputTokens: 20,
          cacheCreationInputTokens: 3,
          webSearchRequests: 0,
          costUSD: 0.5,
        },
        'claude-haiku-4-5': {
          inputTokens: 500,
          outputTokens: 200,
          cacheReadInputTokens: 500,
          cacheCreationInputTokens: 100,
          webSearchRequests: 0,
          costUSD: 0.25,
        },
      },
    });
    service.completeChatTurn('proj', 'wt', 'chat', 'success');

    const entry = recentEntry(service);
    expect(entry).toMatchObject({
      // The SDK running total covers the whole tree; tokens are the main loop.
      totalCostUsd: 0.75,
      costDerivation: 'exact',
      tokens: {
        input: 10,
        output: 4,
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 3,
      },
      context: { endTokens: 33, windowTokens: 200000 },
      subAgentCount: 1,
      subagents: [
        {
          id: 'task-tool-1',
          kind: 'claude_task',
          label: 'Explore',
          inclusion: 'included',
          totalTokens: 1300,
        },
      ],
    });
    expect(entry.modelUsage?.map((row) => row.model).sort()).toEqual([
      'claude-haiku-4-5',
      'claude-sonnet-4-5',
    ]);
    // The task description is never recorded.
    expect(JSON.stringify(entry)).not.toContain('Private task text');
  });

  it('ignores forwarded subagent frames and counts a task at its latest running total', () => {
    const service = createService();
    startChat(service);
    service.observeChatEvent('proj', 'wt', 'chat', taskEvent('task_started'));
    for (const totalTokens of [100, 300, 300]) {
      service.observeChatEvent(
        'proj',
        'wt',
        'chat',
        taskEvent('task_progress', {
          usage: { total_tokens: totalTokens, tool_uses: 1, duration_ms: 1 },
        }),
      );
    }
    // A forwarded subagent frame carries a placeholder output count; it adds nothing.
    service.observeChatEvent('proj', 'wt', 'chat', {
      type: 'assistant',
      parent_tool_use_id: 'task-tool-1',
      message: {
        id: 'child-message-1',
        model: 'claude-haiku-4-5',
        content: [],
        usage: { input_tokens: 500, output_tokens: 3 },
      },
    });
    service.completeChatTurn('proj', 'wt', 'chat', 'success');

    const subagents = recentEntry(service).subagents ?? [];
    expect(subagents).toHaveLength(1);
    expect(subagents[0]).toMatchObject({
      id: 'task-tool-1',
      totalTokens: 300,
      tokens: {
        input: 0,
        output: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    });
  });

  it('captures Codex token-usage context and dedupes the transcript compaction envelope', () => {
    const service = createService();
    startChat(service, { provider: 'codex' });
    const key = 'chat:proj/wt/chat';
    service.observeCodexEvent(key, {
      type: 'thread.started',
      thread_id: 'thread-1',
    });
    service.observeCodexEvent(key, {
      type: 'turn.started',
      thread_id: 'thread-1',
      turn_id: 'turn-1',
    });
    service.observeCodexEvent(key, {
      type: 'thread.token_usage.updated',
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      usage: { context_tokens: 90, context_window: 200000 },
    });
    service.observeCodexEvent(key, {
      type: 'item.completed',
      thread_id: 'thread-1',
      timestamp: '2026-10-08T11:59:00.000Z',
      item: { id: 'item-1', type: 'context_compaction', pre_tokens: 180000 },
    });
    service.observeChatEvent('proj', 'wt', 'chat', {
      type: 'canopy_compaction',
      id: 'codex-context-compaction:thread-1:item-1',
      at: '2026-10-08T11:59:00.000Z',
      trigger: 'unknown',
      preTokens: 180000,
    });
    service.completeChatTurn('proj', 'wt', 'chat', 'success');

    expect(recentEntry(service)).toMatchObject({
      context: { endTokens: 90, windowTokens: 200000 },
      compactions: [
        {
          at: '2026-10-08T11:59:00.000Z',
          trigger: 'unknown',
          preTokens: 180000,
        },
      ],
    });
  });

  it('retains the observed context peak when a later response uses less context', () => {
    const service = createService();
    startChat(service, { provider: 'codex' });
    const key = 'chat:proj/wt/chat';
    service.observeCodexEvent(key, {
      type: 'thread.started',
      thread_id: 'thread-peak',
    });
    service.observeCodexEvent(key, {
      type: 'turn.started',
      thread_id: 'thread-peak',
      turn_id: 'turn-peak',
    });
    for (const contextTokens of [120, 30]) {
      service.observeCodexEvent(key, {
        type: 'thread.token_usage.updated',
        thread_id: 'thread-peak',
        turn_id: 'turn-peak',
        usage: { context_tokens: contextTokens, context_window: 200000 },
      });
    }
    service.completeChatTurn('proj', 'wt', 'chat', 'success');
    expect(recentEntry(service).context).toEqual({
      endTokens: 30,
      windowTokens: 200000,
      peakTokens: 120,
    });
  });

  it('omits Codex subagent usage when only a spawn signal is observable', () => {
    const service = createService();
    startChat(service, { provider: 'codex' });
    service.observeCodexEvent('chat:proj/wt/chat', {
      type: 'item.started',
      thread_id: 'root-thread',
      item: {
        id: 'spawn-agent-1',
        type: 'collab_agent_tool_call',
        tool: 'spawnAgent',
      },
    });
    service.completeChatTurn('proj', 'wt', 'chat', 'success');

    expect(recentEntry(service).subagents).toBeUndefined();
  });

  it('attributes recorded plan lifecycle events to an already finalized chat', () => {
    const service = createService();
    startChat(service);
    service.completeChatTurn('proj', 'wt', 'chat', 'success');
    const event: PlanUsageEvent = {
      version: 1,
      id: 'plan-created:proj/wt/chat:plan-1:1',
      type: 'plan_created',
      timestamp: new Date(NOW).toISOString(),
      workspaceId: 'proj',
      worktreeId: 'wt',
      provider: 'claude',
      initiationSource: 'user',
      chatId: 'chat',
      planId: 'plan-1',
      planVersion: 1,
    };
    service.recordUsageMetricEvent(event);
    service.recordUsageMetricEvent({
      ...event,
      id: 'plan-approved:proj/wt/chat:plan-1:1',
      type: 'plan_approved',
    });

    expect(recentEntry(service).planEvents).toEqual({
      created: 1,
      approved: 1,
    });
  });

  it('does not attach plan counts to helper entries with an explicit audit id', () => {
    const service = createService();
    const helper: AgentAuditEntry = {
      id: 'helper-plan-target',
      eventType: 'local_memory_consolidation',
      status: 'running',
      provider: 'claude',
      label: 'Helper',
      startedAt: new Date(NOW).toISOString(),
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      tokens: {
        input: 0,
        output: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      messageCount: 0,
      assistantMessageCount: 0,
      toolUseCount: 0,
      subAgentCount: 0,
      hasTranscript: false,
      toolCounts: ZERO_TOOL_COUNTS,
    };
    service.startObservedTask('helper:plan-test', helper);
    service.recordUsageMetricEvent({
      version: 1,
      id: 'plan-created:helper',
      type: 'plan_created',
      timestamp: new Date(NOW).toISOString(),
      workspaceId: 'proj',
      worktreeId: 'wt',
      provider: 'claude',
      chatId: 'chat',
      planId: 'plan-1',
      auditEntryId: 'helper-plan-target',
    });

    expect(service.loadSnapshot().recentEntries[0]).not.toHaveProperty(
      'planEvents',
    );
  });

  it('re-appends plan counts for the explicit finalized turn in its startedAt day, not the next turn', async () => {
    const service = createService();
    startChat(service);
    service.completeChatTurn('proj', 'wt', 'chat', 'success');
    const prior = recentEntry(service);
    jest.setSystemTime(NOW + 24 * 60 * 60 * 1000);
    startChat(service);
    service.recordUsageMetricEvent({
      version: 1,
      id: 'approved-late',
      type: 'plan_approved',
      timestamp: new Date().toISOString(),
      workspaceId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      provider: 'claude',
      planId: 'plan-late',
      auditEntryId: prior.id,
    });
    await service.flush();
    const entries = service.loadSnapshot().recentEntries;
    expect(entries.find((entry) => entry.id === prior.id)?.planEvents).toEqual({
      created: 0,
      approved: 1,
    });
    expect(
      entries.find((entry) => entry.id !== prior.id)?.planEvents,
    ).toBeUndefined();
    const records: unknown[] = mockAppendFile.mock.calls
      .filter(([filename]) => filename === '/audit/2026-10-08.jsonl')
      .flatMap(([, contents]) =>
        contents
          .trim()
          .split('\n')
          .map((line): unknown => JSON.parse(line)),
      );
    expect(
      records
        .filter(
          (entry) =>
            typeof entry === 'object' &&
            entry !== null &&
            'id' in entry &&
            entry.id === prior.id,
        )
        .pop(),
    ).toMatchObject({ id: prior.id, planEvents: { created: 0, approved: 1 } });
  });

  it('attaches a chat-scoped plan event without an explicit audit id to the latest completed turn', () => {
    const service = createService();
    startChat(service);
    service.completeChatTurn('proj', 'wt', 'chat', 'success');
    const firstId = recentEntry(service).id;
    jest.setSystemTime(NOW + 1000);
    startChat(service);
    service.completeChatTurn('proj', 'wt', 'chat', 'success');
    const latestId = recentEntry(service).id;
    service.recordUsageMetricEvent({
      version: 1,
      id: 'created-latest',
      type: 'plan_created',
      timestamp: new Date().toISOString(),
      workspaceId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      provider: 'claude',
      planId: 'plan-new',
    });
    const entries = service.loadSnapshot().recentEntries;
    expect(entries.find((entry) => entry.id === latestId)?.planEvents).toEqual({
      created: 1,
      approved: 0,
    });
    expect(
      entries.find((entry) => entry.id === firstId)?.planEvents,
    ).toBeUndefined();
  });

  it('flushes pending coalesced delegation progress only on disposal, not a general flush', async () => {
    const service = createService();
    const transcript = delegationTranscript();
    service.observeChatEvent('proj', 'wt', 'chat', {
      type: 'canopy_delegation',
      delegation: transcript,
    });
    service.observeChatEvent('proj', 'wt', 'chat', {
      type: 'canopy_delegation',
      delegation: {
        ...transcript,
        sequence: 2,
        snapshot: {
          ...transcript.snapshot,
          usage: { inputTokens: 80, costUsd: 0.5 },
        },
      },
    });
    await service.flush();
    expect(service.loadSnapshot().recentEntries[0]?.tokens.input).toBe(40);
    await service.dispose();
    expect(service.loadSnapshot().recentEntries[0]?.tokens.input).toBe(80);
    expect(
      mockAppendFile.mock.calls.filter(([filename]) =>
        filename.startsWith('/usage/'),
      ),
    ).toEqual([]);
  });

  it('does not retain expired managed delegation spend in the Statistics cache', async () => {
    const service = createService();
    service.observeChatEvent('proj', 'wt', 'chat', {
      type: 'canopy_delegation',
      delegation: delegationTranscript(),
    });
    await service.loadUsageTabSummary({ tab: 'cost' });
    jest.setSystemTime(NOW + 40 * 24 * 60 * 60 * 1000);
    const summary = await service.loadUsageTabSummary({ tab: 'cost' });
    expect(
      summary.cards.find((card) => card.key === 'observed_cost')?.allTime,
    ).toBe(0);
  });

  it('applies a late advisor root pipeline patch to its retained finalized audit entry', async () => {
    const service = createService();
    const advisor: AgentAuditEntry = {
      id: 'advisor-task:one',
      eventType: 'pipeline_advisor',
      status: 'running',
      provider: 'claude',
      label: 'Pipeline Advisor',
      startedAt: new Date(NOW).toISOString(),
      projectId: 'proj',
      worktreeId: 'wt',
      pipelineExecutionId: 'nested-run',
      tokens: {
        input: 0,
        output: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      messageCount: 0,
      assistantMessageCount: 0,
      toolUseCount: 0,
      subAgentCount: 0,
      hasTranscript: false,
      toolCounts: ZERO_TOOL_COUNTS,
    };
    service.startObservedTask('advisor:one', advisor);
    service.finalizeObservedTask('advisor:one', 'success');
    for (let index = 0; index < 205; index += 1) {
      service.recordCreatedPullRequest({
        projectId: 'proj',
        worktreeId: 'wt',
        provider: 'claude',
        prNumber: index + 1,
        prUrl: `https://github.com/org/repo/pull/${index + 1}`,
      });
    }
    expect(
      service
        .loadSnapshot()
        .recentEntries.some((entry) => entry.id === 'advisor-task:one'),
    ).toBe(false);
    service.updateObservedTask('advisor:one', {
      rootPipelineExecutionId: 'root-run',
    });
    await service.flush();

    expect(
      mockAppendFile.mock.calls.some(
        ([, payload]) =>
          payload.includes('"id":"advisor-task:one"') &&
          payload.includes('"rootPipelineExecutionId":"root-run"'),
      ),
    ).toBe(true);
  });

  it('counts managed delegation spend in cost and token Statistics without a chat turn', async () => {
    const persistedEntry = (
      id: string,
      totalCostUsd: number,
      input: number,
      output: number,
      cacheReadInputTokens: number,
    ): AgentAuditEntry => ({
      id,
      eventType: 'managed_delegation',
      status: 'success',
      provider: 'codex',
      label: 'Managed delegation',
      startedAt: new Date(NOW - 1_000).toISOString(),
      completedAt: new Date(NOW - 1_000).toISOString(),
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat',
      totalCostUsd,
      tokens: {
        input,
        output,
        cacheReadInputTokens,
        cacheCreationInputTokens: 0,
      },
      messageCount: 0,
      assistantMessageCount: 0,
      toolUseCount: 0,
      subAgentCount: 0,
      hasTranscript: false,
      toolCounts: ZERO_TOOL_COUNTS,
      delegation: { delegationId: id, runGeneration: 1 },
    });
    const persistedMatchesLive = persistedEntry(
      'managed_delegation:delegate-1:1',
      99,
      900,
      900,
      900,
    );
    const persistedHistorical = persistedEntry(
      'managed_delegation:prior-run:1',
      0.5,
      30,
      5,
      10,
    );
    mockReaddir.mockImplementation(
      (path): Promise<string[]> =>
        Promise.resolve(path === '/audit' ? ['2026-10-08.jsonl'] : []),
    );
    mockReadFile.mockImplementation(
      (path): Promise<string> =>
        Promise.resolve(
          path === '/audit/2026-10-08.jsonl'
            ? `${JSON.stringify(persistedMatchesLive)}\n${JSON.stringify(persistedHistorical)}\n`
            : '',
        ),
    );
    const service = createService();
    service.observeChatEvent('proj', 'wt', 'chat', {
      type: 'canopy_delegation',
      delegation: delegationTranscript(),
    });
    expect(service.loadSnapshot().recentEntries).toEqual([
      expect.objectContaining({
        eventType: 'managed_delegation',
        projectId: 'proj',
        totalCostUsd: 0.25,
      }),
    ]);

    const costSummary = await service.loadUsageTabSummary({ tab: 'cost' });
    const tokenSummary = await service.loadUsageTabSummary({ tab: 'tokens' });
    const chatSummary = await service.loadUsageTabSummary({ tab: 'chats' });

    expect(
      costSummary.cards.find((card) => card.key === 'observed_cost')?.allTime,
    ).toBe(0.75);
    expect(
      tokenSummary.cards.find((card) => card.key === 'total_tokens')?.allTime,
    ).toBe(115);
    expect(
      chatSummary.cards.find((card) => card.key === 'total_turns')?.allTime,
    ).toBe(0);
    expect(service.loadSnapshot().recentEntries).toEqual([
      expect.objectContaining({ eventType: 'managed_delegation' }),
    ]);

    // The charts beside those totals add the same delegation spend.
    const range = {
      startDate: new Date(NOW - 86_400_000).toISOString(),
      endDate: new Date(NOW + 3_600_000).toISOString(),
      bucket: 'day' as const,
    };
    const costSeries = await service.loadUsageTimeseries({
      ...range,
      dataset: { kind: 'tab-counts', tab: 'cost', series: ['cost_total_usd'] },
    });
    const tokenSeries = await service.loadUsageTimeseries({
      ...range,
      dataset: { kind: 'tab-counts', tab: 'tokens', series: ['token_total'] },
    });
    const seriesTotal = (
      response: typeof costSeries,
      key: 'cost_total_usd' | 'token_total',
    ): number =>
      response.kind === 'tab-counts'
        ? response.buckets.reduce(
            (sum, bucket) => sum + (bucket.series[key] ?? 0),
            0,
          )
        : Number.NaN;
    expect(seriesTotal(costSeries, 'cost_total_usd')).toBeCloseTo(0.75, 6);
    expect(seriesTotal(tokenSeries, 'token_total')).toBe(115);
  });
});
