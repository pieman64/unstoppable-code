import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '../../featureFlagsStore';
import {
  APP_ADVISOR_PROJECT_ID,
  DEFAULT_APP_ADVISOR_MODEL,
  STANDALONE_CHAT_PROJECT_ID,
  clampThinkingLevelForModel,
  getProviderForModel,
  initAgentModels,
  initAiGatewayModels,
  initClaudeModels,
  initCodexModels,
  initCursorModels,
  initModelHarnessAssignments,
  buildModelHarnessAssignmentSnapshot,
  getCurrentModelHarnessCatalog,
  initOllamaModels,
  resetGatewayCatalogHydrationForTests,
  type ModelDefaultsByProvider,
} from '@canopy/desktop-shared/types';
import { CREDITS_LANE_DEFAULT_CANDIDATES } from '@canopy/desktop-shared/lib/default-model-lane';
import {
  resolveBillingSeed,
  resolveLaneForTarget,
  resolveTabDefaults,
} from '../defaults';
import {
  resetRendererModelPolicyForTests,
  setRendererActiveWorkOwner,
  setRendererModelGatewayIndex,
  setRendererModelPolicy,
} from '../../modelPolicyRuntime';
import {
  resetRendererBillingLaneForTests,
  setRendererBillingLaneAvailability,
  setRendererGuestPrincipal,
} from '../../billingLaneRuntime';

function defaultsFor(model: string): {
  chatProvider: 'claude';
  chatModelByProvider: ModelDefaultsByProvider;
  worktreeProvider: 'claude';
  worktreeModelByProvider: ModelDefaultsByProvider;
} {
  const selections: ModelDefaultsByProvider = {
    claude: { model, thinkingLevel: 'high' },
    codex: { model: 'blocked-codex', thinkingLevel: 'high' },
    ollama: null,
  };
  return {
    chatProvider: 'claude',
    chatModelByProvider: selections,
    worktreeProvider: 'claude',
    worktreeModelByProvider: selections,
  };
}

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

describe('resolveTabDefaults model-policy fallback', () => {
  afterEach(() => {
    setRendererModelPolicy(new Set(), true);
    initClaudeModels([]);
    initCodexModels([]);
    initOllamaModels([]);
    initAgentModels([]);
  });

  it('keeps a selectable remembered model', () => {
    initClaudeModels([{ id: 'remembered-model', label: 'Remembered' }]);

    expect(
      resolveTabDefaults('project', defaultsFor('remembered-model')),
    ).toMatchObject({
      model: 'remembered-model',
      thinkingLevel: 'high',
    });
  });

  it('uses the first allowed catalog model when the remembered default was filtered', () => {
    setRendererModelPolicy(new Set(['blocked-model']), true);
    initClaudeModels([
      { id: 'first-allowed', label: 'First allowed' },
      { id: 'second-allowed', label: 'Second allowed' },
    ]);

    expect(
      resolveTabDefaults('project', defaultsFor('blocked-model')),
    ).toMatchObject({
      model: 'first-allowed',
      thinkingLevel: 'high',
    });
  });

  it('skips blocked catalog models when picking the fallback default', () => {
    // The registries are normally pre-filtered, but the fallback must not
    // depend on that implicit ordering: an unfiltered/stale registry whose
    // first entry is blocked must still resolve to an allowed model.
    setRendererModelPolicy(new Set(['blocked-model', 'also-blocked']), true);
    initClaudeModels([
      { id: 'also-blocked', label: 'Also blocked' },
      { id: 'allowed-model', label: 'Allowed' },
    ]);

    expect(
      resolveTabDefaults('project', defaultsFor('blocked-model')),
    ).toMatchObject({
      model: 'allowed-model',
      thinkingLevel: 'high',
    });
  });

  it('falls back to an allowed model from another provider catalog', () => {
    setRendererModelPolicy(new Set(['blocked-model', 'blocked-claude']), true);
    initClaudeModels([{ id: 'blocked-claude', label: 'Blocked Claude' }]);
    initCodexModels([{ id: 'allowed-codex', label: 'Allowed Codex' }]);

    expect(
      resolveTabDefaults('project', defaultsFor('blocked-model')),
    ).toMatchObject({
      model: 'allowed-codex',
    });
  });
});

describe('resolveTabDefaults billing-lane selection (CAN-1929)', () => {
  afterEach(() => {
    resetRendererModelPolicyForTests();
    resetRendererBillingLaneForTests();
    initClaudeModels([]);
    initCodexModels([]);
    initOllamaModels([]);
    initAiGatewayModels([], []);
    // `initAiGatewayModels([], [])` deliberately does NOT clear the sticky
    // hydration flag (a policy-filtered catalog can legitimately be empty), so
    // the cold-catalog path would stay unreachable for every test declared
    // after a hydrating one without this.
    resetGatewayCatalogHydrationForTests();
    initAgentModels([]);
  });

  function seedCatalog(): void {
    initClaudeModels([{ id: 'claude-model', label: 'Claude' }]);
    initCodexModels([{ id: 'codex-model', label: 'Codex' }]);
    initAiGatewayModels(
      [
        {
          id: 'deepseek-v4-pro',
          label: 'DeepSeek',
          supportedThinkingLevels: ['high'],
        },
      ],
      [
        {
          modelId: 'deepseek-v4-pro',
          gatewayId: 'deepseek/deepseek-v4-pro',
          family: 'deepseek',
          recommendedHarness: 'codex',
          gatewayOnly: true,
          contextWindow: 128_000,
          supportsPromptCaching: false,
          supportedThinkingLevels: ['high'],
          toolSchemaProfile: 'codex',
        },
      ],
    );
    setRendererModelPolicy(new Set(), true);
  }

  function laneDefaults(): ReturnType<typeof defaultsFor> {
    const selections: ModelDefaultsByProvider = {
      claude: { model: 'claude-model', thinkingLevel: 'high' },
      codex: { model: 'codex-model', thinkingLevel: 'high' },
      ollama: null,
    };
    return {
      chatProvider: 'claude',
      chatModelByProvider: selections,
      worktreeProvider: 'claude',
      worktreeModelByProvider: selections,
    };
  }

  function seedOrgGatewayCatalog(): void {
    initClaudeModels([{ id: 'claude-model', label: 'Claude' }]);
    initCodexModels([{ id: 'codex-model', label: 'Codex' }]);
    initAiGatewayModels(
      [
        {
          id: 'deepseek-v4-pro',
          label: 'DeepSeek',
          supportedThinkingLevels: ['high'],
        },
        {
          id: 'org-claude-sonnet',
          label: 'Organization Sonnet',
          supportedThinkingLevels: ['high'],
        },
      ],
      [
        {
          modelId: 'deepseek-v4-pro',
          gatewayId: 'deepseek/deepseek-v4-pro',
          family: 'deepseek',
          recommendedHarness: 'codex',
          gatewayOnly: true,
          contextWindow: 128_000,
          supportsPromptCaching: false,
          supportedThinkingLevels: ['high'],
          toolSchemaProfile: 'codex',
        },
        {
          modelId: 'org-claude-sonnet',
          gatewayId: 'anthropic/claude-sonnet-5',
          family: 'custom',
          recommendedHarness: 'codex',
          gatewayOnly: true,
          contextWindow: 1_000_000,
          supportsPromptCaching: true,
          supportedThinkingLevels: ['high'],
          toolSchemaProfile: 'standard',
          origin: 'org-gateway',
          baseUrl: 'https://ai-gateway.vercel.sh',
          organizationId: ORG_A,
          promptCachePassthrough: true,
        },
      ],
    );
    setRendererModelPolicy(new Set(), true);
    setRendererModelGatewayIndex({
      byOrganization: new Map([
        [
          ORG_A,
          {
            organizationName: 'Org A',
            baseUrl: 'https://ai-gateway.vercel.sh',
            enforced: true,
            promptCachePassthrough: true,
            models: [],
            unavailable: false,
          },
        ],
      ]),
      accountUnavailable: false,
    });
  }

  it('seeds an org model, not the native default, under an enforced gateway', () => {
    // The reported bug: an enforcing org with an EMPTY model blocklist. The
    // picker hard-disabled every native row while the seed still stamped the
    // Claude default, so the composer opened on a model it then refused to run.
    seedOrgGatewayCatalog();
    setRendererBillingLaneAvailability({
      claudeNativeAuth: true,
      codexNativeAuth: true,
      creditsEligible: true,
    });

    expect(resolveTabDefaults('project', laneDefaults())).toMatchObject({
      model: 'org-claude-sonnet',
    });
  });

  it('seeds an org model with no AI Credits, which never fund an org gateway', () => {
    // Org routes are paid for with the member's own gateway key, so gating
    // them on credits eligibility would turn "wrong default" into "no
    // dispatchable model" for every member of an enforcing org without credits.
    seedOrgGatewayCatalog();
    setRendererBillingLaneAvailability({
      claudeNativeAuth: false,
      codexNativeAuth: false,
      creditsEligible: false,
    });

    expect(resolveTabDefaults('project', laneDefaults())).toMatchObject({
      model: 'org-claude-sonnet',
    });
  });

  it("does not apply Org A's enforced gateway to Personal work", () => {
    seedOrgGatewayCatalog();
    setRendererActiveWorkOwner({ kind: 'personal' });
    setRendererBillingLaneAvailability({
      claudeNativeAuth: true,
      codexNativeAuth: true,
      creditsEligible: true,
    });

    expect(resolveTabDefaults('project', laneDefaults())).toMatchObject({
      model: 'claude-model',
    });
  });

  it("applies Org A's enforced gateway to Org A's work", () => {
    seedOrgGatewayCatalog();
    setRendererActiveWorkOwner({ kind: 'organization', organizationId: ORG_A });
    setRendererBillingLaneAvailability({
      claudeNativeAuth: true,
      codexNativeAuth: true,
      creditsEligible: true,
    });

    expect(resolveTabDefaults('project', laneDefaults())).toMatchObject({
      model: 'org-claude-sonnet',
    });
  });

  it("never seeds Org A's gateway model for Org B's work", () => {
    seedOrgGatewayCatalog();
    setRendererActiveWorkOwner({ kind: 'organization', organizationId: ORG_B });
    setRendererBillingLaneAvailability({
      claudeNativeAuth: true,
      codexNativeAuth: true,
      creditsEligible: true,
    });

    const seeded = resolveTabDefaults('project', laneDefaults()).model;
    expect(seeded).not.toBe('org-claude-sonnet');
    expect(seeded).toBe('claude-model');
  });

  it('never seeds a hosted gateway model under enforcement', () => {
    seedOrgGatewayCatalog();
    setRendererBillingLaneAvailability({
      claudeNativeAuth: false,
      codexNativeAuth: false,
      creditsEligible: true,
    });

    expect(resolveTabDefaults('project', laneDefaults()).model).not.toBe(
      'deepseek-v4-pro',
    );
  });

  it('seeds the native Claude default when the Claude lane is available', () => {
    seedCatalog();
    setRendererBillingLaneAvailability({
      claudeNativeAuth: true,
      codexNativeAuth: false,
      creditsEligible: false,
    });

    expect(resolveTabDefaults('project', laneDefaults())).toMatchObject({
      model: 'claude-model',
    });
  });

  it('skips a confirmed signed-out Claude lane and seeds the Codex default', () => {
    seedCatalog();
    setRendererBillingLaneAvailability({
      claudeNativeAuth: false,
      codexNativeAuth: true,
      creditsEligible: false,
    });

    expect(resolveTabDefaults('project', laneDefaults())).toMatchObject({
      model: 'codex-model',
    });
  });

  it.each([
    [{ speed: 'ultrafast' as const, fastMode: false }, 'ultrafast', false],
    [{ speed: 'fast' as const, fastMode: true }, 'fast', true],
    [{ fastMode: true }, 'fast', true],
    [{}, 'standard', false],
  ])(
    'seeds the Codex default speed %p speed-first',
    (codexDefault, speed, fastMode) => {
      seedCatalog();
      setRendererBillingLaneAvailability({
        claudeNativeAuth: false,
        codexNativeAuth: true,
        creditsEligible: false,
      });

      expect(
        resolveTabDefaults('project', {
          ...laneDefaults(),
          modelConfigDefaultsByProvider: { codex: codexDefault },
        }),
      ).toMatchObject({
        model: 'codex-model',
        modelConfig: { speed, fastMode },
      });
    },
  );

  it('seeds a gateway model for a credits-only user instead of an unpayable native default', () => {
    seedCatalog();
    setRendererBillingLaneAvailability({
      claudeNativeAuth: false,
      codexNativeAuth: false,
      creditsEligible: true,
    });

    expect(resolveTabDefaults('project', laneDefaults())).toMatchObject({
      model: 'deepseek-v4-pro',
    });
  });

  it('never seeds a guest with a model outside the guest allowlist', () => {
    // DeepSeek, the primary credits candidate, is not routable here, so a
    // signed-in and guest credits users fall back to GPT 6 Luna. A guest
    // walks the allowlist to GPT 5.6 Luna when GPT 6 Luna cannot route either;
    // the guest-ineligible GPT 5.4 route must never win.
    const entry = (
      modelId: string,
      gatewayId: string,
    ): Parameters<typeof initAiGatewayModels>[1][number] => ({
      modelId,
      gatewayId,
      family: 'gpt',
      recommendedHarness: 'codex' as const,
      gatewayOnly: false,
      contextWindow: 400_000,
      supportsPromptCaching: false,
      supportedThinkingLevels: ['high' as const],
      toolSchemaProfile: 'codex' as const,
    });
    const gpt54 = {
      id: 'gpt-5.4',
      label: 'GPT 5.4',
      supportedThinkingLevels: ['high' as const],
    };
    const luna56 = {
      id: 'gpt-5.6-luna',
      label: 'GPT 5.6 Luna',
      supportedThinkingLevels: ['high' as const],
    };
    initClaudeModels([{ id: 'claude-model', label: 'Claude' }]);
    initCodexModels([{ id: 'codex-model', label: 'Codex' }]);
    initAiGatewayModels(
      [
        gpt54,
        {
          id: 'gpt-6-luna',
          label: 'GPT 6 Luna',
          supportedThinkingLevels: ['high'],
        },
        luna56,
      ],
      [
        entry('gpt-5.4', 'openai/gpt-5.4'),
        entry('gpt-6-luna', 'openai/gpt-6-luna'),
        entry('gpt-5.6-luna', 'openai/gpt-5.6-luna'),
      ],
    );
    setRendererModelPolicy(new Set(), true);
    setRendererBillingLaneAvailability({
      claudeNativeAuth: false,
      codexNativeAuth: false,
      creditsEligible: true,
    });

    expect(resolveTabDefaults('project', laneDefaults())).toMatchObject({
      model: 'gpt-6-luna',
    });

    setRendererGuestPrincipal(true);
    expect(resolveTabDefaults('project', laneDefaults())).toMatchObject({
      model: 'gpt-6-luna',
    });

    initAiGatewayModels(
      [gpt54, luna56],
      [
        entry('gpt-5.4', 'openai/gpt-5.4'),
        entry('gpt-5.6-luna', 'openai/gpt-5.6-luna'),
      ],
    );
    expect(resolveTabDefaults('project', laneDefaults())).toMatchObject({
      model: 'gpt-5.6-luna',
    });
  });

  it('force-seeds the ai-credits billing framework on the credits lane', () => {
    seedCatalog();
    setRendererBillingLaneAvailability({
      claudeNativeAuth: false,
      codexNativeAuth: false,
      creditsEligible: true,
    });

    expect(resolveBillingSeed(laneDefaults(), 'project')).toBe('ai-credits');
  });

  it('leaves the billing seed alone when a native lane wins', () => {
    seedCatalog();
    setRendererBillingLaneAvailability({
      claudeNativeAuth: true,
      codexNativeAuth: false,
      creditsEligible: true,
    });

    expect(resolveBillingSeed(laneDefaults(), 'project')).toBeUndefined();
  });

  it('treats an UNKNOWN lane as still usable rather than signed out', () => {
    // The distinction the tri-state exists for: an in-flight or failed auth
    // probe must not divert a Claude subscriber onto credits.
    seedCatalog();
    setRendererBillingLaneAvailability({
      claudeNativeAuth: undefined,
      codexNativeAuth: false,
      creditsEligible: true,
    });

    expect(resolveTabDefaults('project', laneDefaults())).toMatchObject({
      model: 'claude-model',
    });
  });

  it('never auto-selects Ollama when no lane is available and Ollama is not pinned', () => {
    seedCatalog();
    initOllamaModels([{ id: 'llama-local', label: 'Llama', supported: true }]);
    setRendererBillingLaneAvailability({
      claudeNativeAuth: false,
      codexNativeAuth: false,
      creditsEligible: false,
    });

    const resolved = resolveTabDefaults('project', laneDefaults());
    expect(resolved.model).not.toBe('llama-local');
  });

  it('reports a dead end when policy blocks every model on every payable lane', () => {
    seedCatalog();
    // Every candidate the resolver can reach, including the credits lane's
    // built-in `CREDITS_LANE_DEFAULT_CANDIDATES` fallbacks — a dead end means
    // nothing is left, not just that the configured defaults are gone.
    // Note the gateway entry is the GOVERNED id (`deepseek/deepseek-v4-pro`),
    // not the display id: an org's reviewed snapshot is written in governed
    // ids, and `isModelBlockedTriState` normalizes before comparing. Blocking
    // the display id here would silently not block anything — which is exactly
    // the cold-catalog ambiguity the tri-state predicate exists to surface.
    setRendererModelPolicy(
      new Set([
        'claude-model',
        'codex-model',
        'deepseek/deepseek-v4-pro',
        ...CREDITS_LANE_DEFAULT_CANDIDATES,
      ]),
      true,
    );
    setRendererBillingLaneAvailability({
      claudeNativeAuth: true,
      codexNativeAuth: true,
      creditsEligible: true,
    });

    const resolution = resolveLaneForTarget('project', laneDefaults());
    expect(resolution?.outcome).toBe('no-dispatchable-model');
  });

  it('reads the remembered lane from the scope being resolved', () => {
    // Both native lanes UNKNOWN (failed probes), so the remembered lane is what
    // decides. The chat surface must not inherit the worktree scope answer.
    seedCatalog();
    setRendererBillingLaneAvailability({
      claudeNativeAuth: undefined,
      codexNativeAuth: undefined,
      creditsEligible: false,
    });
    const defaults = {
      ...laneDefaults(),
      lastResolvedLaneByScope: {
        chat: 'codex-native' as const,
        worktree: 'claude-native' as const,
      },
    };

    expect(
      resolveLaneForTarget(STANDALONE_CHAT_PROJECT_ID, defaults),
    ).toMatchObject({ outcome: 'resolved', lane: 'codex-native' });
    expect(resolveLaneForTarget('project', defaults)).toMatchObject({
      outcome: 'resolved',
      lane: 'claude-native',
    });
  });

  it('pins App Advisor Ollama from the chat provider, matching its lane resolution', () => {
    // `isCoworkChatTarget(APP_ADVISOR_PROJECT_ID)` is true, so the advisor lane
    // is resolved from the CHAT provider. Reading `worktreeProvider` for the
    // selectable-default fallback made the two halves disagree.
    seedCatalog();
    initOllamaModels([
      {
        id: 'ollama-model',
        rawModelId: 'ollama-model',
        label: 'Local',
        show: { capabilities: ['completion', 'tools'] },
      },
    ]);
    // Nothing is payable and the configured advisor model is org-blocked, so
    // the ONLY reachable candidate is the pinned local lane.
    setRendererBillingLaneAvailability({
      claudeNativeAuth: false,
      codexNativeAuth: false,
      creditsEligible: false,
    });
    setRendererModelPolicy(
      new Set(['claude-model', 'codex-model', 'deepseek-v4-pro']),
      true,
    );
    const selections: ModelDefaultsByProvider = {
      claude: { model: 'claude-model', thinkingLevel: 'high' },
      codex: { model: 'codex-model', thinkingLevel: 'high' },
      ollama: { model: 'ollama-model', thinkingLevel: 'high' },
    };

    expect(
      resolveTabDefaults(APP_ADVISOR_PROJECT_ID, {
        chatProvider: 'ollama',
        chatModelByProvider: selections,
        // Deliberately different from the chat provider.
        worktreeProvider: 'claude',
        worktreeModelByProvider: selections,
        appAdvisorModel: 'codex-model',
      }),
    ).toMatchObject({ model: 'ollama-model' });
  });

  it('offers no lane opinion before the model registry hydrates', () => {
    // Pre-hydration nothing can be classified, so every native lane would look
    // undispatchable and the credits lane's fail-open would swallow the user.
    resetRendererBillingLaneForTests();
    setRendererModelPolicy(new Set(), true);
    initClaudeModels([]);
    initCodexModels([]);

    expect(resolveLaneForTarget('project', laneDefaults())).toBeUndefined();
  });

  it('offers no lane opinion for an unclassifiable preferred default, even with a populated catalog (round-5)', () => {
    // Pins the INTENTIONAL divergence from main documented in
    // `resolveLaneForTarget`. Main repairs an unidentifiable default from the
    // lane catalog; this side declines to rewrite a model it cannot identify,
    // so a user's custom or not-yet-known id survives in the composer instead
    // of being silently replaced.
    //
    // Making the renderer repair too was tried and reverted: it rewrote exactly
    // those ids, which is worse than the bounded disagreement (reachable only
    // for a model-less tab, since dispatch consults the lane default only when
    // the turn carries no concrete model).
    seedCatalog();
    setRendererModelPolicy(new Set(), true);
    setRendererBillingLaneAvailability({
      claudeNativeAuth: true,
      codexNativeAuth: false,
      creditsEligible: false,
    });
    const stale: ModelDefaultsByProvider = {
      claude: { model: 'model-from-an-older-release', thinkingLevel: 'high' },
      codex: { model: 'codex-model', thinkingLevel: 'high' },
      ollama: null,
    };

    expect(
      resolveLaneForTarget('project', {
        chatProvider: 'claude',
        chatModelByProvider: stale,
        worktreeProvider: 'claude',
        worktreeModelByProvider: stale,
      }),
    ).toBeUndefined();
  });

  describe('App Advisor guest default (CAN-3637)', () => {
    type GatewayRoute = Parameters<typeof initAiGatewayModels>[1][number];
    const route = (
      modelId: string,
      gatewayId: string,
      supportedThinkingLevels: GatewayRoute['supportedThinkingLevels'] = [
        'high',
      ],
    ): GatewayRoute => ({
      modelId,
      gatewayId,
      family: 'gpt',
      recommendedHarness: 'codex',
      gatewayOnly: false,
      contextWindow: 400_000,
      supportsPromptCaching: false,
      supportedThinkingLevels,
      toolSchemaProfile: 'codex',
    });

    /**
     * Keeps the shipped seed ROUTABLE on the gateway, so a failure here is
     * about guest eligibility and never about a missing route.
     */
    function seedAdvisorCatalog(
      options: { deepseek?: boolean; luna?: boolean } = {},
    ): void {
      const { deepseek = true, luna = true } = options;
      initClaudeModels([{ id: 'claude-model', label: 'Claude' }]);
      initCodexModels([
        { id: DEFAULT_APP_ADVISOR_MODEL, label: 'GPT 6.1 Sol' },
        { id: 'codex-model', label: 'Codex' },
      ]);
      const entries: Parameters<typeof initAiGatewayModels>[0] = [
        {
          id: DEFAULT_APP_ADVISOR_MODEL,
          label: 'GPT 6.1 Sol',
          supportedThinkingLevels: ['high'],
        },
        {
          id: 'other-gateway-model',
          label: 'Other',
          supportedThinkingLevels: ['high'],
        },
      ];
      const routes: GatewayRoute[] = [
        // A guest-ineligible fixture route isolates guest policy from
        // the shipped native seed's actual gateway availability.
        route(DEFAULT_APP_ADVISOR_MODEL, 'openai/gpt-5.4'),
        route('other-gateway-model', 'vendor/other-gateway-model'),
      ];
      if (luna) {
        entries.push({
          id: 'gpt-5.6-luna',
          label: 'GPT 5.6 Luna',
          supportedThinkingLevels: ['medium'],
        });
        routes.push(route('gpt-5.6-luna', 'openai/gpt-5.6-luna', ['medium']));
      }
      if (deepseek) {
        entries.push({
          id: 'deepseek-v4-pro',
          label: 'DeepSeek',
          supportedThinkingLevels: ['medium'],
        });
        routes.push(
          route('deepseek-v4-pro', 'deepseek/deepseek-v4-pro', ['medium']),
        );
      }
      initAiGatewayModels(entries, routes);
      setRendererModelPolicy(new Set(), true);
    }

    function advisorDefaults(
      appAdvisorModel: string | undefined | null = DEFAULT_APP_ADVISOR_MODEL,
    ): NonNullable<Parameters<typeof resolveTabDefaults>[1]> {
      return {
        ...laneDefaults(),
        ...(appAdvisorModel == null ? {} : { appAdvisorModel }),
        appAdvisorThinkingLevel: 'high',
      };
    }

    function creditsOnly(): void {
      setRendererBillingLaneAvailability({
        claudeNativeAuth: false,
        codexNativeAuth: false,
        creditsEligible: true,
      });
    }

    it('replaces the guest-ineligible seed with the resolver selection for a credits-only guest', () => {
      seedAdvisorCatalog();
      creditsOnly();
      setRendererGuestPrincipal(true);

      const resolved = resolveTabDefaults(
        APP_ADVISOR_PROJECT_ID,
        advisorDefaults(),
      );
      expect(resolved.model).toBe('deepseek-v4-pro');
      expect(resolved.providerType).toBe(
        getProviderForModel('deepseek-v4-pro'),
      );
      // The seed asks for `high`; DeepSeek here supports only `medium`.
      expect(resolved.thinkingLevel).toBe(
        clampThinkingLevelForModel('high', 'deepseek-v4-pro'),
      );
      expect(resolved.modelConfig?.thinkingLevel).toBe(resolved.thinkingLevel);
    });

    it('selects GPT 5.6 Luna when it is the only guest-eligible route', () => {
      seedAdvisorCatalog({ deepseek: false });
      creditsOnly();
      setRendererGuestPrincipal(true);

      expect(
        resolveTabDefaults(APP_ADVISOR_PROJECT_ID, advisorDefaults()).model,
      ).toBe('gpt-5.6-luna');
    });

    it('applies the same rule when no Advisor preference is stored', () => {
      seedAdvisorCatalog();
      creditsOnly();
      setRendererGuestPrincipal(true);

      expect(
        resolveTabDefaults(APP_ADVISOR_PROJECT_ID, advisorDefaults(null)).model,
      ).toBe('deepseek-v4-pro');
    });

    it('keeps the shipped seed for a signed-in credits user', () => {
      seedAdvisorCatalog();
      creditsOnly();

      expect(
        resolveTabDefaults(APP_ADVISOR_PROJECT_ID, advisorDefaults()).model,
      ).toBe(DEFAULT_APP_ADVISOR_MODEL);
    });

    it('keeps the Codex seed for a guest on the native Codex lane', () => {
      seedAdvisorCatalog();
      setRendererBillingLaneAvailability({
        claudeNativeAuth: false,
        codexNativeAuth: true,
        creditsEligible: true,
      });
      setRendererGuestPrincipal(true);

      expect(
        resolveTabDefaults(APP_ADVISOR_PROJECT_ID, advisorDefaults()),
      ).toMatchObject({
        model: DEFAULT_APP_ADVISOR_MODEL,
        providerType: 'codex',
      });
    });

    it('keeps the existing Claude migration for a guest on the native Claude lane', () => {
      seedAdvisorCatalog();
      setRendererBillingLaneAvailability({
        claudeNativeAuth: true,
        codexNativeAuth: false,
        creditsEligible: true,
      });
      setRendererGuestPrincipal(true);

      expect(
        resolveTabDefaults(APP_ADVISOR_PROJECT_ID, advisorDefaults()),
      ).toMatchObject({ model: 'claude-model', providerType: 'claude' });
    });

    it('applies guest eligibility when detected native credentials still resolve to credits', () => {
      // Codex credentials are detected, but policy leaves that lane with
      // nothing runnable, so the lane resolves to AI Credits. Auth detection
      // alone must not exempt the seed from the guest allowlist.
      seedAdvisorCatalog();
      initCodexModels([{ id: 'codex-model', label: 'Codex' }]);
      setRendererModelPolicy(new Set(['codex-model']), true);
      setRendererBillingLaneAvailability({
        claudeNativeAuth: false,
        codexNativeAuth: true,
        creditsEligible: true,
      });
      setRendererGuestPrincipal(true);

      expect(
        resolveLaneForTarget(APP_ADVISOR_PROJECT_ID, advisorDefaults()),
      ).toMatchObject({ outcome: 'resolved', lane: 'ai-credits' });
      expect(
        resolveTabDefaults(APP_ADVISOR_PROJECT_ID, advisorDefaults()).model,
      ).toBe('deepseek-v4-pro');
    });

    it('keeps an explicit non-default preference even when guests cannot run it (scope exception)', () => {
      // Documented limitation: equality with the shipped constant is the only
      // "untouched" signal, so an explicit different choice is left alone and
      // surfaces the existing guest-model refusal instead.
      seedAdvisorCatalog();
      creditsOnly();
      setRendererGuestPrincipal(true);

      expect(
        resolveTabDefaults(
          APP_ADVISOR_PROJECT_ID,
          advisorDefaults('other-gateway-model'),
        ).model,
      ).toBe('other-gateway-model');
    });

    it('keeps an explicit guest-eligible preference', () => {
      seedAdvisorCatalog();
      creditsOnly();
      setRendererGuestPrincipal(true);

      expect(
        resolveTabDefaults(
          APP_ADVISOR_PROJECT_ID,
          advisorDefaults('gpt-5.6-luna'),
        ).model,
      ).toBe('gpt-5.6-luna');
    });

    it('holds the configured seed while the registry is cold, then resolves to an eligible model', () => {
      // Cold: no lane opinion, so the persisted preference is what the tab
      // shows. The empty-tab sync re-stamps it once the catalog lands.
      setRendererModelPolicy(new Set(), true);
      creditsOnly();
      setRendererGuestPrincipal(true);
      expect(
        resolveLaneForTarget(APP_ADVISOR_PROJECT_ID, advisorDefaults()),
      ).toBeUndefined();

      seedAdvisorCatalog();
      expect(
        resolveTabDefaults(APP_ADVISOR_PROJECT_ID, advisorDefaults()).model,
      ).toBe('deepseek-v4-pro');
    });

    it('reports a dead end, not a fabricated model, when no guest-eligible route exists', () => {
      seedAdvisorCatalog({ deepseek: false, luna: false });
      creditsOnly();
      setRendererGuestPrincipal(true);

      const resolution = resolveLaneForTarget(
        APP_ADVISOR_PROJECT_ID,
        advisorDefaults(),
      );
      expect(resolution?.outcome).toBe('no-dispatchable-model');
    });
  });
});

test('fresh defaults reject stale Cursor assignments when the live flag turns off', () => {
  const original = useFeatureFlagsStore.getState().snapshot;
  const flag = CLIENT_FEATURE_FLAGS.canopyDesktopCursorHarness.key;
  initClaudeModels([
    { id: 'sonnet', label: 'Sonnet', gatewayId: 'anthropic/claude-sonnet-4-6' },
  ]);
  initCursorModels([
    {
      id: 'cursor:claude-sonnet-4-6',
      rawModelId: 'claude-sonnet-4-6',
      label: 'Cursor Sonnet',
    },
  ]);
  initModelHarnessAssignments(
    buildModelHarnessAssignmentSnapshot({
      catalog: getCurrentModelHarnessCatalog(),
      overrides: { sonnet: 'cursor' },
      revision: 1,
    }),
  );
  try {
    useFeatureFlagsStore.getState().setSnapshot({
      ...original,
      values: { ...original.values, [flag]: true },
    });
    expect(
      resolveTabDefaults('project', defaultsFor('sonnet')).providerType,
    ).toBe('cursor');
    useFeatureFlagsStore.getState().setSnapshot({
      ...original,
      values: { ...original.values, [flag]: false },
    });
    expect(resolveTabDefaults('project', defaultsFor('sonnet'))).toMatchObject({
      model: 'sonnet',
      providerType: 'claude',
    });
  } finally {
    useFeatureFlagsStore.getState().setSnapshot(original);
    initCursorModels([]);
    initModelHarnessAssignments({ revision: 0, assignments: [] });
  }
});

test('applies a Cursor default harness to Cowork targets under the live flag', () => {
  const original = useFeatureFlagsStore.getState().snapshot;
  const flag = CLIENT_FEATURE_FLAGS.canopyDesktopCursorHarness.key;
  initClaudeModels([
    { id: 'sonnet', label: 'Sonnet', gatewayId: 'anthropic/claude-sonnet-4-6' },
  ]);
  initCursorModels([
    {
      id: 'cursor:claude-sonnet-4-6',
      rawModelId: 'claude-sonnet-4-6',
      label: 'Cursor Sonnet',
    },
  ]);
  initModelHarnessAssignments(
    buildModelHarnessAssignmentSnapshot({
      catalog: getCurrentModelHarnessCatalog(),
      overrides: { sonnet: 'cursor' },
      revision: 1,
    }),
  );
  try {
    useFeatureFlagsStore.getState().setSnapshot({
      ...original,
      values: { ...original.values, [flag]: true },
    });
    expect(
      resolveTabDefaults(STANDALONE_CHAT_PROJECT_ID, defaultsFor('sonnet'))
        .providerType,
    ).toBe('cursor');
  } finally {
    useFeatureFlagsStore.getState().setSnapshot(original);
    initCursorModels([]);
    initModelHarnessAssignments({ revision: 0, assignments: [] });
  }
});
