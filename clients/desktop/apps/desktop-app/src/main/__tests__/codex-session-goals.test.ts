import type * as LedgerToolsRuntimeModule from '../canopy-tools/ledger-tools-runtime';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const mockStartTurn = jest.fn();
const mockInterruptTurn = jest.fn();
const mockSetApprovalMode = jest.fn();
const mockDispose = jest.fn();
const mockGetThreadId = jest.fn(() => 'interactive-thread');

jest.mock('../codex/app-server-client', () => ({
  CodexAppServerClient: jest.fn().mockImplementation(() => ({
    startTurn: mockStartTurn,
    interruptTurn: mockInterruptTurn,
    setApprovalMode: mockSetApprovalMode,
    dispose: mockDispose,
    getThreadId: mockGetThreadId,
    getActiveTurnInterruptTarget: jest.fn(() => ({
      threadId: 'interactive-thread',
      turnId: 'interactive-turn',
    })),
    hasProviderOwnedTurn: jest.fn(() => false),
    hasActiveTurn: jest.fn(() => false),
    hasLiveBackgroundWork: jest.fn(() => false),
    getBackgroundSnapshot: jest.fn(() => ({
      epoch: 'goals-epoch',
      revision: 0,
      rootThreadId: 'interactive-thread',
      work: [],
      reconciling: false,
    })),
    subscribeBackgroundWork: jest.fn(() => (): void => undefined),
  })),
}));
// The Ledger tools read real Feed storage; these sessions run without them.
jest.mock('../canopy-tools/ledger-tools-runtime', () => ({
  ...jest.requireActual<typeof LedgerToolsRuntimeModule>(
    '../canopy-tools/ledger-tools-runtime',
  ),
  mayExposeLedgerTools: (): boolean => false,
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
  markTurnAwaitingUser: jest.fn(),
  noteSessionMessageQueued: jest.fn(),
  recordSessionEvent: jest.fn(),
  createSessionPhaseTimer: jest.fn(() => jest.fn()),
  isSessionAiCreditsRouted: jest.fn(() => false),
  isSessionAccountProxyRouted: jest.fn(() => false),
  recordSessionAccountProxyRoute: jest.fn(),
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
  resolveEffectiveChatPluginSelectionRefs: jest.fn(),
  codexAggregateSkillInvocationNamesForRefs: jest.fn(() => new Map()),
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
    unregisterRoutesForSession: jest.fn(),
    getCodexCapabilityAuthorityIds: jest.fn(() => []),
    shutdown: jest.fn().mockResolvedValue(undefined),
  })),
}));
jest.mock('../agents/codex-gateway-proxy-service', () => ({
  getCodexGatewayProxyService: jest.fn(() => ({
    registerRoute: jest.fn().mockResolvedValue({
      routeId: 'route',
      baseUrl: 'http://127.0.0.1/route',
    }),
    unregisterRoutesForSession: jest.fn(),
    shutdown: jest.fn().mockResolvedValue(undefined),
  })),
}));
jest.mock('../pipelines/config-paths', () => ({
  getEnhancedEnv: jest.fn(() => ({ ...process.env })),
}));
jest.mock('../services/chat-state-service', () => ({
  getChatStateService: (): { commitPlanExit: jest.Mock } => ({
    commitPlanExit: jest.fn().mockResolvedValue(undefined),
  }),
}));
jest.mock('../approvals/approval-service', () => ({
  createApprovalSession: jest.fn(() => ({
    check: jest.fn().mockResolvedValue({ decision: 'allow' }),
    setMode: jest.fn(),
    invalidatePending: jest.fn(),
    dispose: jest.fn(),
  })),
}));
jest.mock('../codex/fork-thread', () => ({
  waitForPendingCodexFork: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../codex/transcript-seed', () => ({
  loadCodexForkContinuation: jest.fn().mockResolvedValue(undefined),
  loadPersistedCodexFallbackSeedItems: jest.fn().mockResolvedValue([]),
}));
jest.mock('../codex/runtime-service', () => ({
  getCodexRuntimeService: jest.fn(() => ({
    registerStdioMcpRoute: jest.fn().mockResolvedValue(undefined),
    revokeStdioMcpRoutes: jest.fn().mockResolvedValue(undefined),
  })),
}));
jest.mock('../codex/speed-policy', () => ({
  admitCodexSpeed: jest.fn().mockResolvedValue({
    speed: 'standard',
    availability: { speed: 'standard', status: 'available', reason: 'default' },
  }),
  codexSpeedGatewayForOrigin: jest.fn(),
  reportCodexSpeedTurnFailure: jest.fn(() => false),
}));
jest.mock('../lib/model-gateway-state', () => ({
  checkModelGatewayRoute: jest
    .fn()
    .mockResolvedValue({ ok: true, orgRoute: false }),
}));
jest.mock('../lib/model-gateway-credential-store', () => ({
  loadModelGatewayCredential: jest.fn().mockResolvedValue(null),
  markModelGatewayCredentialRejected: jest.fn(),
}));
jest.mock('../lib/workspace-registry', () => ({
  isCoworkWorkspace: jest.fn(() => false),
}));
jest.mock('../lib/code-graph-availability', () => ({
  isCodeGraphAvailableForWorkspace: jest.fn().mockResolvedValue(false),
}));
jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordSessionDiagnostic: jest.fn(),
  })),
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
import { CodexProvider } from '../agents/codex-session';
import { CodexAppServerClient } from '../codex/app-server-client';

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
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

describe('Codex interactive thread goals configuration', () => {
  beforeAll(() => initializeModelCatalog());

  beforeEach(() => {
    jest.clearAllMocks();
    mockStartTurn.mockResolvedValue({ status: 'completed' });
    mockInterruptTurn.mockResolvedValue(undefined);
    mockSetApprovalMode.mockResolvedValue(undefined);
    mockDispose.mockResolvedValue(undefined);
  });

  it('disables server-created goals for an interactive Codex thread', async () => {
    const session = new CodexProvider().createSession(
      {
        cwd: '/tmp/repo',
        projectId: 'project-goals',
        worktreeId: 'worktree-goals',
        chatId: 'interactive-chat',
      },
      jest.fn(),
      () => null,
    );

    session.sendMessage('Run once');
    // Session start has many unmocked awaits before the client is built.
    await waitFor(
      () => jest.mocked(CodexAppServerClient).mock.calls.length > 0,
    );

    expect(CodexAppServerClient).toHaveBeenCalled();
    const options = jest.mocked(CodexAppServerClient).mock.calls[0]?.[0];
    expect(options?.threadConfig).toMatchObject({ 'features.goals': false });
    await session.destroy();
  });
});
