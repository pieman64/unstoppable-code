/**
 * @jest-environment jsdom
 */
import {
  type GatewayRouteEntry,
  type SidebarItem,
  initAgentModels,
  initAiGatewayModels,
  initClaudeModels,
  initCodexModels,
  initOllamaModels,
  pinInheritingAgentModel,
} from '@canopy/desktop-shared/types';
import {
  cachedHomeModelRefusal,
  evaluateHomeModelEligibility,
  loadHomeModelEligibilityFacts,
  preflightHomeModel,
  resetHomeModelPreflightForTests,
  type HomeModelEligibilityFacts,
  type HomeModelSelection,
} from '../components/home/homeModelPreflight';
import {
  resetModelLibraryAccessForTests,
  useModelLibraryAccessStore,
} from '@/lib/modelLibraryAccess';
import { createEmptySelections } from '@/lib/pluginSelections';
import {
  resetRendererModelPolicyForTests,
  setRendererModelPolicy,
} from '@/stores/modelPolicyRuntime';
import { useProjectsStore } from '@/stores/projectsStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';

/**
 * CAN-5021 — Home's pre-flight refuses only what the client has established.
 * Each case pins one fact; every other fact stays unknown, which must never
 * turn into a refusal on its own.
 */

/** Routable through AI Credits, not gateway-only, not on the guest allowlist. */
const ROUTABLE = 'claude-fable-5.1';
/**
 * A native Claude model with no gateway route. Its governed id is its own, so
 * a raw policy set can name it directly.
 */
const NOT_ROUTABLE = 'claude-legacy-preflight-test';
/** Billable only through AI Credits. */
const GATEWAY_ONLY = 'claude-gateway-only-preflight-test';
/** Served by the member's organization gateway. */
const ORG_GATEWAY = 'claude-org-gateway-preflight-test';
const OLLAMA = 'ollama-llama-preflight-test';
const INHERITING_AGENT = 'agent_model_preflight_inherit';

function route(modelId: string, gatewayOnly: boolean): GatewayRouteEntry {
  return {
    modelId,
    gatewayId: `vendor/${modelId}`,
    family: 'claude',
    recommendedHarness: 'claude',
    gatewayOnly,
    contextWindow: 100_000,
    supportsPromptCaching: false,
    supportedThinkingLevels: [],
    toolSchemaProfile: 'standard',
  };
}

function installRoutes(): void {
  initAiGatewayModels(
    [],
    [
      route(ROUTABLE, false),
      route(GATEWAY_ONLY, true),
      {
        ...route(ORG_GATEWAY, true),
        family: 'custom',
        origin: 'org-gateway',
        baseUrl: 'https://gateway.acme.test',
        organizationId: 'org-1',
        promptCachePassthrough: true,
      },
    ],
  );
}

function installCatalog(): void {
  initClaudeModels([
    { id: ROUTABLE, label: 'Fable 5.1' },
    { id: NOT_ROUTABLE, label: 'Claude Legacy' },
    { id: GATEWAY_ONLY, label: 'Claude Gateway Only' },
    { id: ORG_GATEWAY, label: 'Organization Claude' },
  ]);
  initCodexModels([{ id: 'gpt-6-luna', label: 'GPT 6 Luna' }]);
  initOllamaModels([
    { id: OLLAMA, rawModelId: 'llama-preflight-test', label: 'Llama' },
  ]);
  initAgentModels([
    {
      id: INHERITING_AGENT,
      name: 'Inherit',
      baseModel: 'default',
      instructions: '',
      pluginSelections: createEmptySelections(),
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      available: true,
    },
  ]);
  installRoutes();
}

beforeAll(installCatalog);

const credits: HomeModelEligibilityFacts = { billingSeed: 'ai-credits' };

function evaluate(
  model: string,
  facts: HomeModelEligibilityFacts,
  executionHarness?: HomeModelSelection['executionHarness'],
): ReturnType<typeof evaluateHomeModelEligibility> {
  return evaluateHomeModelEligibility(
    { model, ...(executionHarness ? { executionHarness } : {}) },
    facts,
  );
}

describe('evaluateHomeModelEligibility', () => {
  it('does not establish unknown-model absence from an entirely empty snapshot', () => {
    initClaudeModels([]);
    initCodexModels([]);
    initAiGatewayModels([], []);
    try {
      expect(
        evaluate('unknown-preflight-model', { catalogLoaded: true }),
      ).toEqual({ ok: true });
    } finally {
      installCatalog();
    }
  });

  it('uses the accepted destination billing route when retrying', () => {
    expect(
      evaluateHomeModelEligibility(
        { model: NOT_ROUTABLE, aiCreditsRouted: false },
        credits,
      ),
    ).toEqual({ ok: true });
    expect(
      evaluateHomeModelEligibility(
        { model: NOT_ROUTABLE, aiCreditsRouted: true },
        { billingSeed: 'subscription' },
      ),
    ).toMatchObject({ ok: false, reason: 'not-routable' });
  });

  it('passes a selection when nothing is known', () => {
    expect(evaluate(NOT_ROUTABLE, {})).toEqual({ ok: true });
  });

  it('asks a guest on AI Credits for an account, naming the model', () => {
    expect(evaluate(ROUTABLE, { ...credits, isGuest: true })).toEqual({
      ok: false,
      reason: 'needs-account',
      modelLabel: 'Fable 5.1',
    });
  });

  it('asks a signed-in non-purchaser on AI Credits for a purchase', () => {
    expect(
      evaluate(ROUTABLE, {
        ...credits,
        isGuest: false,
        libraryAccess: 'needs_purchase',
      }),
    ).toMatchObject({ ok: false, reason: 'needs-purchase' });
  });

  it('refuses a model the gateway cannot route on AI Credits', () => {
    expect(evaluate(NOT_ROUTABLE, credits)).toMatchObject({
      ok: false,
      reason: 'not-routable',
    });
  });

  it('refuses a model the organization policy blocks', () => {
    expect(
      evaluate(NOT_ROUTABLE, { modelPolicy: new Set([NOT_ROUTABLE]) }),
    ).toMatchObject({ ok: false, reason: 'org-policy' });
    expect(evaluate(NOT_ROUTABLE, { modelPolicy: new Set() })).toEqual({
      ok: true,
    });
  });

  it('refuses a model off an enforced organization gateway', () => {
    expect(evaluate(ROUTABLE, { modelGatewayEnforced: true })).toMatchObject({
      ok: false,
      reason: 'org-gateway',
    });
    expect(evaluate(ORG_GATEWAY, { modelGatewayEnforced: true })).toEqual({
      ok: true,
    });
  });

  it('refuses an unknown model only against a loaded catalog', () => {
    const missing = 'claude-removed-preflight-test';
    expect(evaluate(missing, { catalogLoaded: true })).toEqual({
      ok: false,
      reason: 'unknown-model',
      modelLabel: 'this model',
    });
    expect(evaluate(missing, { catalogLoaded: false })).toEqual({ ok: true });
    expect(evaluate(missing, {})).toEqual({ ok: true });
  });

  it('does not let an unreadable account bypass an organization denial', () => {
    // On AI Credits this model would otherwise read as not routable: the
    // policy denial comes first and needs no account fact.
    expect(
      evaluate(NOT_ROUTABLE, {
        ...credits,
        modelPolicy: new Set([NOT_ROUTABLE]),
      }),
    ).toMatchObject({ ok: false, reason: 'org-policy' });
  });

  it('applies no library lock while the account is unreadable', () => {
    expect(evaluate(ROUTABLE, credits)).toEqual({ ok: true });
    expect(
      evaluate(ROUTABLE, { ...credits, libraryAccess: 'needs_purchase' }),
    ).toEqual({ ok: true });
  });

  it('holds a guest to the allowlist before library access loads', () => {
    expect(evaluate(ROUTABLE, { ...credits, isGuest: false })).toEqual({
      ok: true,
    });
    expect(evaluate(ROUTABLE, { ...credits, isGuest: true })).toMatchObject({
      ok: false,
      reason: 'needs-account',
    });
  });

  it('applies library locks and routability only on AI Credits', () => {
    const subscription: HomeModelEligibilityFacts = {
      billingSeed: 'subscription',
      isGuest: true,
    };
    expect(evaluate(ROUTABLE, subscription)).toEqual({ ok: true });
    expect(evaluate(NOT_ROUTABLE, subscription)).toEqual({ ok: true });
    expect(evaluate(ROUTABLE, { isGuest: true })).toEqual({ ok: true });
    // A gateway-only model bills AI Credits whatever the seed says.
    expect(evaluate(GATEWAY_ONLY, subscription)).toMatchObject({
      ok: false,
      reason: 'needs-account',
    });
  });

  it('keeps the picker’s Ollama and managed-harness exceptions', () => {
    const guestOnCredits = { ...credits, isGuest: true, catalogLoaded: true };
    expect(evaluate(OLLAMA, guestOnCredits)).toEqual({ ok: true });
    expect(evaluate(ROUTABLE, guestOnCredits, 'opencode')).toEqual({
      ok: true,
    });
    expect(
      evaluate('claude-removed-preflight-test', guestOnCredits, 'cursor'),
    ).toEqual({ ok: true });
  });

  it('judges an inheriting Agent by the model it resolved to', () => {
    const pinned = pinInheritingAgentModel(INHERITING_AGENT, ROUTABLE);
    expect(pinned).not.toBe(INHERITING_AGENT);
    expect(evaluate(pinned, { ...credits, isGuest: true })).toMatchObject({
      ok: false,
      reason: 'needs-account',
    });
  });

  describe('with an empty gateway registry', () => {
    beforeEach(() => {
      initAiGatewayModels([], []);
    });
    afterEach(installRoutes);

    it('fails open on routability and gateway enforcement', () => {
      expect(evaluate(NOT_ROUTABLE, credits)).toEqual({ ok: true });
      expect(evaluate(ROUTABLE, { modelGatewayEnforced: true })).toEqual({
        ok: true,
      });
    });
  });
});

const loadCanopyCloudAccount = jest.fn();
const loadCanopyCloudEntitlements = jest.fn();
const originalApi = Object.getOwnPropertyDescriptor(window, 'api');

function signedIn(guest: boolean): unknown {
  return {
    read: 'ok',
    hasApiKey: true,
    account: { id: 'account-1' },
    authMode: guest ? 'guest' : 'oauth',
    credentialSource: guest ? 'guest' : 'oauth',
  };
}

function libraryReports(access: string): void {
  loadCanopyCloudEntitlements.mockResolvedValue({
    resolved: true,
    modelLibrary: { status: 'reported', access },
    modelLibraryAccountKey: 'account-1',
    modelLibraryOwnerKey: 'personal',
    workModelLibrary: { status: 'reported', access },
  });
}

function personalProject(id: string, order: number): SidebarItem {
  return {
    id,
    name: id,
    type: 'cowork',
    color: '#7c3aed',
    collapsed: false,
    order,
  };
}

describe('loading facts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetHomeModelPreflightForTests();
    resetModelLibraryAccessForTests();
    resetRendererModelPolicyForTests();
    // The Personal context, hydrated, with both targets in it.
    useWorkspaceContextStore.setState({ accountEpoch: 0, hydrated: true });
    useProjectsStore.setState({
      projects: [personalProject('ws-1', 0), personalProject('ws-2', 1)],
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { loadCanopyCloudAccount, loadCanopyCloudEntitlements },
    });
  });

  afterAll(() => {
    if (originalApi) Object.defineProperty(window, 'api', originalApi);
    else Reflect.deleteProperty(window, 'api');
  });

  it('turns rejected reads into unknown facts without throwing', async () => {
    loadCanopyCloudAccount.mockRejectedValue(new Error('offline'));
    loadCanopyCloudEntitlements.mockRejectedValue(new Error('offline'));
    const facts = await loadHomeModelEligibilityFacts('ws-1');
    expect(facts.isGuest).toBeUndefined();
    expect(facts.libraryAccess).toBeUndefined();
    expect(facts.modelPolicy).toBeUndefined();
  });

  it('treats an explicitly unreadable account as unknown', async () => {
    loadCanopyCloudAccount.mockResolvedValue({
      read: 'error',
      hasApiKey: false,
      authMode: null,
    });
    loadCanopyCloudEntitlements.mockResolvedValue({ resolved: false });
    const facts = await loadHomeModelEligibilityFacts('ws-1');
    expect(facts.isGuest).toBeUndefined();
    expect(facts.libraryAccess).toBeUndefined();
  });

  it('reads the account and the selected work’s library access', async () => {
    loadCanopyCloudAccount.mockResolvedValue(signedIn(false));
    libraryReports('needs_purchase');
    const facts = await loadHomeModelEligibilityFacts('ws-1');
    expect(facts).toMatchObject({
      isGuest: false,
      libraryAccess: 'needs_purchase',
    });
    expect(loadCanopyCloudEntitlements).toHaveBeenCalledWith({
      kind: 'work',
      projectId: 'ws-1',
    });
  });

  it('reads policy only once an account read established it', async () => {
    loadCanopyCloudAccount.mockResolvedValue(signedIn(false));
    libraryReports('unlocked');
    expect(
      (await loadHomeModelEligibilityFacts('ws-1')).modelPolicy,
    ).toBeUndefined();
    setRendererModelPolicy(new Set([NOT_ROUTABLE]), true);
    expect(
      (await loadHomeModelEligibilityFacts('ws-1')).modelPolicy,
    ).toBeDefined();
  });

  it('leaves policy unknown when the work’s owner cannot be named', async () => {
    loadCanopyCloudAccount.mockResolvedValue(signedIn(false));
    libraryReports('unlocked');
    setRendererModelPolicy(new Set([NOT_ROUTABLE]), true);
    // A target outside the selected context (here, not loaded at all).
    expect(
      (await loadHomeModelEligibilityFacts('ws-elsewhere')).modelPolicy,
    ).toBeUndefined();
    // A context that has not hydrated yet.
    useWorkspaceContextStore.setState({ hydrated: false });
    expect(
      (await loadHomeModelEligibilityFacts('ws-1')).modelPolicy,
    ).toBeUndefined();
  });

  it('pre-flights against loaded facts', async () => {
    loadCanopyCloudAccount.mockRejectedValue(new Error('offline'));
    loadCanopyCloudEntitlements.mockRejectedValue(new Error('offline'));
    setRendererModelPolicy(new Set([NOT_ROUTABLE]), true);
    await expect(
      preflightHomeModel('ws-1', { model: NOT_ROUTABLE }),
    ).resolves.toMatchObject({ ok: false, reason: 'org-policy' });
  });

  describe('cachedHomeModelRefusal', () => {
    beforeEach(() => {
      loadCanopyCloudAccount.mockResolvedValue(signedIn(false));
      libraryReports('unlocked');
      setRendererModelPolicy(new Set([NOT_ROUTABLE]), true);
    });

    it('passes before any facts have loaded', () => {
      expect(cachedHomeModelRefusal('ws-1', { model: NOT_ROUTABLE })).toEqual({
        ok: true,
      });
    });

    it('re-evaluates the last facts loaded for the same work context', async () => {
      await loadHomeModelEligibilityFacts('ws-1');
      expect(cachedHomeModelRefusal('ws-1', { model: NOT_ROUTABLE })).toEqual({
        ok: false,
        reason: 'org-policy',
        modelLabel: 'Claude Legacy',
      });
      expect(cachedHomeModelRefusal('ws-1', { model: ROUTABLE })).toEqual({
        ok: true,
      });
      expect(cachedHomeModelRefusal('ws-2', { model: NOT_ROUTABLE })).toEqual({
        ok: true,
      });
    });

    it('does not reuse a purchase refusal after library access changes', async () => {
      libraryReports('needs_purchase');
      await loadHomeModelEligibilityFacts('ws-1');
      expect(
        cachedHomeModelRefusal('ws-1', { model: GATEWAY_ONLY }),
      ).toMatchObject({ ok: false, reason: 'needs-purchase' });
      useModelLibraryAccessStore.setState({ access: 'unlocked' });
      expect(cachedHomeModelRefusal('ws-1', { model: GATEWAY_ONLY })).toEqual({
        ok: true,
      });
    });

    it('forgets facts once the account changes', async () => {
      await loadHomeModelEligibilityFacts('ws-1');
      useWorkspaceContextStore.setState({ accountEpoch: 1 });
      expect(cachedHomeModelRefusal('ws-1', { model: NOT_ROUTABLE })).toEqual({
        ok: true,
      });
    });

    it('keeps the newest load when an older one settles last', async () => {
      let releaseFirst: (value: unknown) => void = () => undefined;
      loadCanopyCloudAccount
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              releaseFirst = resolve;
            }),
        )
        .mockResolvedValue(signedIn(false));
      const first = loadHomeModelEligibilityFacts('ws-1');
      await loadHomeModelEligibilityFacts('ws-2');
      releaseFirst(signedIn(false));
      await first;
      expect(cachedHomeModelRefusal('ws-1', { model: NOT_ROUTABLE })).toEqual({
        ok: true,
      });
      expect(
        cachedHomeModelRefusal('ws-2', { model: NOT_ROUTABLE }),
      ).toMatchObject({ ok: false, reason: 'org-policy' });
    });
  });
});
