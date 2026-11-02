import packageConfig from '../../../../package.json';
import { parseModelPackageConfig } from '../model-config';
import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_MODEL,
  hasGatewayModelRoutes,
  hasHydratedGatewayCatalog,
  initAiGatewayModels,
  initClaudeModels,
  initCodexModels,
  initOllamaModels,
  resolveKnownModel,
  type ProviderModelSelection,
} from '../types';
import {
  CREDITS_LANE_DEFAULT_CANDIDATES,
  isAiCreditsOnlyBilling,
  isCodexModelAvailableToAccount,
  isGuestAllowedCreditsModel,
  repairLaneDefaults,
  resolveDefaultModelLane,
  type BillingLane,
  type BillingLaneAvailability,
  type LaneModelDefaults,
} from '../lib/default-model-lane';
import { isGatewayRoutableModel } from '../lib/gateway-model-availability';
import {
  GUEST_DEFAULT_MODEL_ID,
  isGuestAllowedModelId,
} from '@canopy/protocol';

const defaults: LaneModelDefaults = {
  claude: { model: DEFAULT_CLAUDE_MODEL, thinkingLevel: 'high' },
  codex: { model: DEFAULT_CODEX_MODEL, thinkingLevel: 'high' },
  ollama: { model: 'ollama-qwen', thinkingLevel: 'high' },
  aiCredits: null,
};

const TRI_STATE_VALUES = [false, true, undefined] as const;
const AVAILABILITY_TRUTH_TABLE = TRI_STATE_VALUES.flatMap((claudeNativeAuth) =>
  TRI_STATE_VALUES.flatMap((codexNativeAuth) =>
    TRI_STATE_VALUES.map((creditsEligible) => ({
      claudeNativeAuth,
      codexNativeAuth,
      creditsEligible,
    })),
  ),
);

function resolve(
  availability: BillingLaneAvailability,
  overrides: Partial<Parameters<typeof resolveDefaultModelLane>[0]> = {},
): ReturnType<typeof resolveDefaultModelLane> {
  return resolveDefaultModelLane({
    availability,
    defaults,
    preferredProvider: 'claude',
    lastResolvedLane: undefined,
    isModelAllowed: () => true,
    isModelInRegistry: (model) => resolveKnownModel(model) !== undefined,
    gatewayRoutesHydrated: true,
    ollamaPinned: false,
    ...overrides,
  });
}

describe('default model billing lane', () => {
  beforeEach(() => {
    initClaudeModels([{ id: DEFAULT_CLAUDE_MODEL, label: 'Opus' }]);
    initCodexModels([
      { id: DEFAULT_CODEX_MODEL, label: 'GPT' },
      { id: 'gpt-6-luna', label: 'GPT 6 Luna' },
    ]);
    initOllamaModels([
      {
        id: 'ollama-qwen',
        rawModelId: 'qwen',
        label: 'Qwen',
        show: { capabilities: ['completion', 'tools'] },
      },
    ]);
    initAiGatewayModels(
      [
        {
          id: 'deepseek-v4-pro',
          label: 'DeepSeek V4 Pro',
          recommendedHarness: 'codex',
          contextWindow: 1_000_000,
          supportsPromptCaching: false,
          supportedThinkingLevels: [],
          toolSchemaProfile: 'standard',
        },
      ],
      [
        {
          modelId: 'deepseek-v4-pro',
          gatewayId: 'deepseek/deepseek-v4-pro',
          family: 'deepseek',
          recommendedHarness: 'codex',
          gatewayOnly: true,
          contextWindow: 1_000_000,
          supportsPromptCaching: false,
          supportedThinkingLevels: [],
          toolSchemaProfile: 'standard',
        },
      ],
    );
  });

  it.each([
    [
      { claudeNativeAuth: true, codexNativeAuth: true, creditsEligible: true },
      'claude-native',
    ],
    [
      { claudeNativeAuth: false, codexNativeAuth: true, creditsEligible: true },
      'codex-native',
    ],
    [
      {
        claudeNativeAuth: false,
        codexNativeAuth: false,
        creditsEligible: true,
      },
      'ai-credits',
    ],
  ] as const)(
    'selects the first dispatchable lane for %j',
    (availability, lane) => {
      expect(resolve(availability)).toMatchObject({
        outcome: 'resolved',
        lane,
      });
    },
  );

  it.each(AVAILABILITY_TRUTH_TABLE)(
    'covers the tri-state availability table: %j',
    (availability) => {
      const result = resolve(availability);
      const anyPossible = Object.values(availability).some(
        (value) => value !== false,
      );
      expect(result.outcome).toBe(
        anyPossible ? 'resolved' : 'no-dispatchable-model',
      );
      if (result.outcome === 'resolved') {
        const chosenAvailability =
          result.lane === 'claude-native'
            ? availability.claudeNativeAuth
            : result.lane === 'codex-native'
              ? availability.codexNativeAuth
              : availability.creditsEligible;
        expect(result.provisional).toBe(chosenAvailability === undefined);
      }
    },
  );

  it.each(
    AVAILABILITY_TRUTH_TABLE.flatMap((availability) =>
      (['claude', 'codex', 'ollama'] as const).flatMap((preferredProvider) =>
        ([true, false, undefined] as const).map((policyAllowed) => ({
          availability,
          preferredProvider,
          policyAllowed,
        })),
      ),
    ),
  )(
    'covers availability × preferred/pinned provider × policy tri-state: %j',
    ({ availability, preferredProvider, policyAllowed }) => {
      const ollamaPinned = preferredProvider === 'ollama';
      const result = resolve(availability, {
        preferredProvider,
        ollamaPinned,
        isModelAllowed: () => policyAllowed,
      });
      const anyPossibleLane =
        ollamaPinned ||
        Object.values(availability).some((value) => value !== false);

      if (!anyPossibleLane || policyAllowed === false) {
        expect(result.outcome).toBe('no-dispatchable-model');
        return;
      }

      expect(result.outcome).toBe('resolved');
      if (result.outcome !== 'resolved') return;
      if (ollamaPinned) {
        expect(result.lane).toBe('ollama');
      }
      if (policyAllowed === undefined) {
        expect(result.provisional).toBe(true);
      }
    },
  );

  it.each(['claude', 'codex'] as const)(
    'honors an available preferred %s provider',
    (preferredProvider) => {
      const result = resolve(
        {
          claudeNativeAuth: true,
          codexNativeAuth: true,
          creditsEligible: true,
        },
        { preferredProvider },
      );
      expect(result).toMatchObject({
        outcome: 'resolved',
        lane: `${preferredProvider}-native`,
      });
    },
  );

  it('never auto-selects Ollama, but gives an explicit pin highest precedence', () => {
    const availability = {
      claudeNativeAuth: true,
      codexNativeAuth: true,
      creditsEligible: true,
    };
    expect(
      resolve(availability, { preferredProvider: 'ollama' }),
    ).toMatchObject({
      outcome: 'resolved',
      lane: 'claude-native',
    });
    expect(
      resolve(availability, {
        preferredProvider: 'ollama',
        ollamaPinned: true,
      }),
    ).toMatchObject({ outcome: 'resolved', lane: 'ollama', reason: 'pinned' });
  });

  it('resolves lane and policy jointly instead of returning a blocked preferred model', () => {
    const result = resolve(
      { claudeNativeAuth: true, codexNativeAuth: true, creditsEligible: true },
      {
        preferredProvider: 'claude',
        isModelAllowed: (model) => model !== DEFAULT_CLAUDE_MODEL,
      },
    );
    expect(result).toMatchObject({
      outcome: 'resolved',
      lane: 'codex-native',
      reason: 'policy-fallback',
    });
  });

  it('holds the last known lane provisionally while its availability is unknown', () => {
    expect(
      resolve(
        {
          claudeNativeAuth: false,
          codexNativeAuth: undefined,
          creditsEligible: false,
        },
        { lastResolvedLane: 'codex-native' },
      ),
    ).toMatchObject({
      outcome: 'resolved',
      lane: 'codex-native',
      provisional: true,
      reason: 'last-known-lane',
    });
  });

  it('uses the gateway default candidate for a credits-only account', () => {
    const result = resolve({
      claudeNativeAuth: false,
      codexNativeAuth: false,
      creditsEligible: true,
    });
    expect(result).toMatchObject({
      outcome: 'resolved',
      lane: 'ai-credits',
      selection: { model: CREDITS_LANE_DEFAULT_CANDIDATES[0] },
    });
    expect(isGatewayRoutableModel(CREDITS_LANE_DEFAULT_CANDIDATES[0])).toBe(
      true,
    );
  });

  it('fails open provisionally for a credits-only account with a cold gateway catalog', () => {
    initAiGatewayModels([], []);
    expect(
      resolve(
        {
          claudeNativeAuth: false,
          codexNativeAuth: false,
          creditsEligible: true,
        },
        { gatewayRoutesHydrated: false },
      ),
    ).toMatchObject({
      outcome: 'resolved',
      lane: 'ai-credits',
      provisional: true,
    });
  });

  it('never returns an unregistered model from the cold credits catalog', () => {
    // Cold catalog fails open on ROUTABILITY only. An id absent from the model
    // registry is unusable rather than merely unproven, so the walk must skip
    // it and land on the next candidate — matching the registry-first check
    // both hosts already apply in their `isRunnableOnLane` hooks.
    initAiGatewayModels([], []);
    const result = resolve(
      {
        claudeNativeAuth: false,
        codexNativeAuth: false,
        creditsEligible: true,
      },
      { gatewayRoutesHydrated: false },
    );
    expect(result.outcome).toBe('resolved');
    if (result.outcome !== 'resolved') return;
    expect(resolveKnownModel(result.selection.model)).toBeDefined();
    expect(result.selection.model).not.toBe(CREDITS_LANE_DEFAULT_CANDIDATES[0]);
  });

  it.each([
    [false, false, false, 'billing-lane'],
    [true, false, false, 'policy-allowance'],
  ] as const)(
    'reports the dead-end cause when availability is %s/%s/%s',
    (claudeNativeAuth, codexNativeAuth, creditsEligible, missing) => {
      const result = resolve(
        { claudeNativeAuth, codexNativeAuth, creditsEligible },
        {
          isModelAllowed: () =>
            claudeNativeAuth || codexNativeAuth || creditsEligible
              ? false
              : true,
        },
      );
      expect(result).toMatchObject({
        outcome: 'no-dispatchable-model',
        missing,
      });
    },
  );

  it('classifies disjoint multi-org approval as a policy dead end', () => {
    expect(
      resolve(
        {
          claudeNativeAuth: true,
          codexNativeAuth: true,
          creditsEligible: true,
        },
        { isModelAllowed: () => false },
      ),
    ).toMatchObject({
      outcome: 'no-dispatchable-model',
      missing: 'policy-allowance',
      hasPolicyAllowedLane: false,
    });
  });

  it('identifies AI Credits as the missing lane when policy allows only a gateway model', () => {
    expect(
      resolve(
        {
          claudeNativeAuth: true,
          codexNativeAuth: false,
          creditsEligible: false,
        },
        {
          isModelAllowed: (model) => model === 'deepseek-v4-pro',
        },
      ),
    ).toMatchObject({
      outcome: 'no-dispatchable-model',
      missing: 'billing-lane',
      lanesNeeded: ['ai-credits'],
      hasPolicyAllowedLane: true,
    });
  });

  it('reports no allowed lane when the allowlist blocks everything and nothing is confirmed available (CAN-2436)', () => {
    // The state the banner used to mistake for "your organization's allowed
    // models all need a billing source": `missing` is `both`, but there is no
    // allowed runnable model on ANY lane, so no billing source could help and
    // the only route through is the org admin. `lanesNeeded` is empty here
    // exactly as it is for the billing-shaped `both`, which is why the
    // resolver has to say so explicitly.
    expect(
      resolve(
        {
          claudeNativeAuth: false,
          codexNativeAuth: false,
          creditsEligible: false,
        },
        { isModelAllowed: () => false },
      ),
    ).toMatchObject({
      outcome: 'no-dispatchable-model',
      missing: 'both',
      lanesNeeded: [],
      hasPolicyAllowedLane: false,
    });
  });

  it('holds the last-known lane behind a CONFIRMED lane that is not first in precedence', () => {
    // Regression for the incomplete first fix: `order` is NOT sorted by
    // availability (the preferred lane is hoisted to the front regardless), so
    // "insert before the first unconfirmed lane" put the last-known lane ahead
    // of a CONFIRMED lane sitting behind an unavailable preferred one.
    //
    // claude (preferred) = false, codex = true, credits = UNKNOWN, last = credits.
    expect(
      resolve(
        {
          claudeNativeAuth: false,
          codexNativeAuth: true,
          creditsEligible: undefined,
        },
        { lastResolvedLane: 'ai-credits' },
      ),
    ).toMatchObject({
      outcome: 'resolved',
      lane: 'codex-native',
      provisional: false,
    });

    // Same shape with a Codex-preferred user whose own probe is still in
    // flight while Claude is confirmed. The preferred lane still wins while its
    // availability is merely UNKNOWN — that is existing precedence — but the
    // last-known CREDITS lane must no longer be hoisted in front of everything,
    // which is what the old `firstUnconfirmed` splice did here (it inserted at
    // index 0 because the preferred Codex lane is not confirmed).
    const codexPreferred = resolve(
      {
        claudeNativeAuth: true,
        codexNativeAuth: undefined,
        creditsEligible: undefined,
      },
      { lastResolvedLane: 'ai-credits', preferredProvider: 'codex' },
    );
    expect(codexPreferred).toMatchObject({
      outcome: 'resolved',
      lane: 'codex-native',
    });
    expect(codexPreferred).not.toMatchObject({ lane: 'ai-credits' });
  });

  it('never lets an UNKNOWN last-known lane outrank a CONFIRMED lane', () => {
    // Regression: an unknown `lastResolvedLane` used to be unshifted to the
    // FRONT of the precedence order, so a Claude subscriber whose credits read
    // was still in flight got seeded onto — and billed for — AI Credits.
    expect(
      resolve(
        {
          claudeNativeAuth: true,
          codexNativeAuth: false,
          creditsEligible: undefined,
        },
        { lastResolvedLane: 'ai-credits' },
      ),
    ).toMatchObject({
      outcome: 'resolved',
      lane: 'claude-native',
      provisional: false,
    });

    // It still wins over other UNCONFIRMED lanes, which is the flap-avoidance
    // the last-known lane exists for.
    expect(
      resolve(
        {
          claudeNativeAuth: false,
          codexNativeAuth: undefined,
          creditsEligible: undefined,
        },
        { lastResolvedLane: 'ai-credits' },
      ),
    ).toMatchObject({
      outcome: 'resolved',
      lane: 'ai-credits',
      reason: 'last-known-lane',
    });
  });

  it('repairs an org-blocked lane default instead of changing lanes', () => {
    // The resolver only considers ONE candidate per native lane, so without the
    // repair a Claude subscriber whose CONFIGURED Claude model is blocked falls
    // through to another lane entirely. Both the renderer seed and the
    // main-process resolver run this, so they cannot disagree.
    initClaudeModels([
      { id: DEFAULT_CLAUDE_MODEL, label: 'Opus' },
      { id: 'sonnet', label: 'Sonnet' },
    ]);
    const blocked = (model: string): boolean => model === DEFAULT_CLAUDE_MODEL;
    const repaired = repairLaneDefaults(defaults, {
      laneCatalog: (lane: BillingLane) =>
        lane === 'claude-native' ? [DEFAULT_CLAUDE_MODEL, 'sonnet'] : [],
      isPolicyBlocked: blocked,
      isModelInRegistry: (model) => resolveKnownModel(model) !== undefined,
      // REQUIRED by `LaneDefaultRepairHooks`. Omitting it only ever "worked"
      // because `isPolicyBlocked` short-circuits before the hook is reached —
      // and for a lane where it does not, this would have thrown.
      isLaneCatalogHydrated: () => true,
      isRunnableOnLane: (lane, model) =>
        lane === 'claude-native'
          ? model.startsWith('claude') || model === 'sonnet'
          : false,
      clampThinkingLevel: (level) => level,
    });
    expect(repaired.claude.model).toBe('sonnet');

    expect(
      resolve(
        {
          claudeNativeAuth: true,
          codexNativeAuth: true,
          creditsEligible: true,
        },
        {
          defaults: repaired,
          isModelAllowed: (model) => !blocked(model),
        },
      ),
    ).toMatchObject({ outcome: 'resolved', lane: 'claude-native' });
  });

  it('leaves a lane default alone when the policy answer is UNKNOWN', () => {
    // Repair rewrites a user's configured default, so an unresolved policy read
    // must never trigger it — otherwise every default is silently replaced
    // during the startup window.
    const repaired = repairLaneDefaults(defaults, {
      laneCatalog: () => ['sonnet'],
      isPolicyBlocked: () => false,
      isModelInRegistry: () => false,
      isLaneCatalogHydrated: () => false,
      isRunnableOnLane: () => false,
      clampThinkingLevel: (level) => level,
    });
    expect(repaired.claude.model).toBe(DEFAULT_CLAUDE_MODEL);
  });

  it('separates a cold gateway catalog from one an org policy emptied', () => {
    // `applySnapshot` initializes the catalog twice: once raw, then again with
    // the policy-filtered lists, which can legitimately be EMPTY when an org
    // blocks every gateway model. A route-count check reports that settled
    // state as "still loading" forever, leaving org-disallowed gateway models
    // provisionally allowed. Hydration is keyed on the INPUT and is sticky, so
    // the filtered second call cannot un-record it.
    const routes = [
      {
        modelId: CREDITS_LANE_DEFAULT_CANDIDATES[0],
        gatewayId: `openrouter/${CREDITS_LANE_DEFAULT_CANDIDATES[0]}`,
        family: 'openrouter',
        recommendedHarness: 'codex' as const,
        contextWindow: 128_000,
        supportsPromptCaching: false,
        supportedThinkingLevels: ['high' as const],
        toolSchemaProfile: 'standard' as const,
        gatewayOnly: true,
      },
    ];
    initAiGatewayModels(
      [
        {
          id: CREDITS_LANE_DEFAULT_CANDIDATES[0],
          label: 'DeepSeek',
          recommendedHarness: 'codex',
          contextWindow: 128000,
          supportsPromptCaching: false,
          supportedThinkingLevels: ['high' as const],
          toolSchemaProfile: 'standard',
        },
      ],
      routes,
    );
    expect(hasGatewayModelRoutes()).toBe(true);
    expect(hasHydratedGatewayCatalog()).toBe(true);

    // Policy filters every gateway route away.
    initAiGatewayModels([], []);
    expect(hasGatewayModelRoutes()).toBe(false);
    // ...but the catalog is known to have ARRIVED, so policy can fail closed.
    expect(hasHydratedGatewayCatalog()).toBe(true);
  });

  it('repairs a CONFIGURED credits default instead of reporting a dead end', () => {
    // A configured credits model whose gateway route disappeared, or which an
    // org later blocked, used to leave the credits lane contributing only that
    // unusable model — so the resolver reported `no-dispatchable-model` while
    // allowed, routable alternatives sat in the catalog.
    const stale = 'stale-credits-model';
    const repaired = repairLaneDefaults(
      { ...defaults, aiCredits: { model: stale, thinkingLevel: 'high' } },
      {
        laneCatalog: (lane: BillingLane) =>
          lane === 'ai-credits'
            ? [stale, CREDITS_LANE_DEFAULT_CANDIDATES[0]]
            : [],
        isPolicyBlocked: (model) => model === stale,
        isModelInRegistry: () => true,
        isLaneCatalogHydrated: () => true,
        isRunnableOnLane: (lane) => lane === 'ai-credits',
        clampThinkingLevel: (level) => level,
      },
    );
    expect(repaired.aiCredits?.model).toBe(CREDITS_LANE_DEFAULT_CANDIDATES[0]);

    // The `null` AUTO sentinel is still left alone for the resolver to expand.
    expect(
      repairLaneDefaults(
        { ...defaults, aiCredits: null },
        {
          laneCatalog: () => [CREDITS_LANE_DEFAULT_CANDIDATES[0]],
          isPolicyBlocked: () => false,
          isModelInRegistry: () => true,
          isLaneCatalogHydrated: () => true,
          isRunnableOnLane: () => true,
          clampThinkingLevel: (level) => level,
        },
      ).aiCredits,
    ).toBeNull();
  });

  it('judges credits dispatchability against the HELPER candidates when given', () => {
    // Regression: an org blocking both chat-default credits candidates while
    // allowing the cheap helper model made the resolver report a dead end
    // before the helper set was ever examined.
    const helper = 'gpt-5.6-luna';
    const gatewayEntry = {
      gatewayId: `openai/${helper}`,
      family: 'openai' as const,
      recommendedHarness: 'codex' as const,
      contextWindow: 400_000,
      supportsPromptCaching: false,
      supportedThinkingLevels: [],
      toolSchemaProfile: 'standard' as const,
    };
    initAiGatewayModels(
      [{ id: helper, label: 'Luna', ...gatewayEntry }],
      [{ modelId: helper, gatewayOnly: true, ...gatewayEntry }],
    );
    expect(
      resolve(
        {
          claudeNativeAuth: false,
          codexNativeAuth: false,
          creditsEligible: true,
        },
        {
          creditsCandidates: [helper],
          isModelAllowed: (model) => model === helper,
        },
      ),
    ).toMatchObject({
      outcome: 'resolved',
      lane: 'ai-credits',
      selection: { model: helper },
    });
  });

  it('repairs a credits default that VANISHED from a hydrated catalog', () => {
    // The masked case: `isDefinitelyUnusableOnLane` used to preserve any model
    // absent from the registry as UNKNOWN, but a gateway-only id that
    // disappears from a refreshed catalog is REMOVED from it. The stale
    // selection then stayed the lane's only candidate and produced a false dead
    // end. Note this test does NOT stub `isModelInRegistry` to true — that is
    // exactly what hid the gap before.
    const vanished = 'vanished-gateway-model';
    const survivor = CREDITS_LANE_DEFAULT_CANDIDATES[0];
    const repaired = repairLaneDefaults(
      { ...defaults, aiCredits: { model: vanished, thinkingLevel: 'high' } },
      {
        laneCatalog: (lane: BillingLane) =>
          lane === 'ai-credits' ? [survivor] : [],
        isPolicyBlocked: () => false,
        // The vanished id is genuinely gone from the registry.
        isModelInRegistry: (model) => model !== vanished,
        isLaneCatalogHydrated: () => true,
        isRunnableOnLane: (lane, model) =>
          lane === 'ai-credits' && model !== vanished,
        clampThinkingLevel: (level) => level,
      },
    );
    expect(repaired.aiCredits?.model).toBe(survivor);
  });

  it('leaves a vanished-looking model alone while the catalog is still COLD', () => {
    // Same shape, but hydration has not completed — absence teaches nothing
    // yet, so the user's configured value must survive the startup window.
    const unknown = 'not-yet-known-model';
    const repaired = repairLaneDefaults(
      { ...defaults, aiCredits: { model: unknown, thinkingLevel: 'high' } },
      {
        laneCatalog: () => [CREDITS_LANE_DEFAULT_CANDIDATES[0]],
        isPolicyBlocked: () => false,
        isModelInRegistry: (model) => model !== unknown,
        isLaneCatalogHydrated: () => false,
        isRunnableOnLane: () => true,
        clampThinkingLevel: (level) => level,
      },
    );
    expect(repaired.aiCredits?.model).toBe(unknown);
  });

  it('clamps the thinking level on a SYNTHESIZED credits candidate (round-3 finding 12)', () => {
    // The AUTO candidates are built here, not read from preferences, and they
    // hardcoded `'high'`. A gateway entry can declare
    // `supportedThinkingLevels: []`, and main callers forward
    // `resolution.selection.thinkingLevel` straight into the dispatched turn
    // (`requireLaneAwareDefaultSelection` -> `laneDefault?.thinkingLevel`).
    const credits = CREDITS_LANE_DEFAULT_CANDIDATES[0];
    const resolution = resolve(
      {
        claudeNativeAuth: false,
        codexNativeAuth: false,
        creditsEligible: true,
      },
      {
        creditsCandidates: [credits],
        isModelInRegistry: () => true,
        clampThinkingLevel: (
          _level,
          model,
        ): ProviderModelSelection['thinkingLevel'] =>
          model === credits ? 'off' : 'high',
      },
    );

    expect(resolution).toMatchObject({
      outcome: 'resolved',
      lane: 'ai-credits',
      selection: { model: credits, thinkingLevel: 'off' },
    });
  });

  it('keeps the nominal level when no clamp hook is supplied', () => {
    const credits = CREDITS_LANE_DEFAULT_CANDIDATES[0];
    const resolution = resolve(
      {
        claudeNativeAuth: false,
        codexNativeAuth: false,
        creditsEligible: true,
      },
      { creditsCandidates: [credits], isModelInRegistry: () => true },
    );

    expect(resolution).toMatchObject({
      outcome: 'resolved',
      selection: { thinkingLevel: 'high' },
    });
  });
});

describe('CAN-3026 guest allowlist alignment', () => {
  it('keeps the primary AI-Credits lane default guest-allowed', () => {
    // Decision 0 regression test. `CREDITS_LANE_DEFAULT_CANDIDATES[0]` is the
    // AI-Credits default in already-shipped desktop builds, so a guest who
    // never opens the picker lands on it. If it ever stops being on the guest
    // allowlist, every installed client on its own default starts taking a 403
    // from the LLM proxy with no client update path.
    expect(isGuestAllowedModelId(CREDITS_LANE_DEFAULT_CANDIDATES[0])).toBe(
      true,
    );
  });

  it('uses configured gateway routes for the credits fallback chain', () => {
    const config = parseModelPackageConfig(packageConfig);
    const fallback = CREDITS_LANE_DEFAULT_CANDIDATES[1];
    expect(
      config.codexModels.find((model) => model.id === fallback)?.gatewayId,
    ).toBe('openai/gpt-6-luna');
  });
});

describe('guest principal on the AI Credits lane', () => {
  // The guest walk follows `GUEST_ALLOWED_MODELS` table order after the lane's
  // own candidates: DeepSeek (the lane default), GPT 6 Luna, GPT 5.6 Luna,
  // Haiku. GPT 6 Luna is the first fallback, and the cloud chat guest pin.
  const GUEST_FALLBACK = GUEST_DEFAULT_MODEL_ID;
  const CREDITS_ONLY: BillingLaneAvailability = {
    claudeNativeAuth: false,
    codexNativeAuth: false,
    creditsEligible: true,
  };

  interface GatewayFixture {
    /** Absent for a package model, which the registry already lists. */
    model?: Parameters<typeof initAiGatewayModels>[0][number];
    entry: Parameters<typeof initAiGatewayModels>[1][number];
  }

  function gatewayModel(
    id: string,
    gatewayId: string,
    family: string,
    recommendedHarness: 'codex' | 'claude' = 'codex',
  ): Required<GatewayFixture> {
    return {
      model: {
        id,
        label: id,
        recommendedHarness,
        contextWindow: 400_000,
        supportsPromptCaching: false,
        supportedThinkingLevels: [],
        toolSchemaProfile: 'standard',
      },
      entry: {
        modelId: id,
        gatewayId,
        family,
        recommendedHarness,
        gatewayOnly: false,
        contextWindow: 400_000,
        supportsPromptCaching: false,
        supportedThinkingLevels: [],
        toolSchemaProfile: 'standard',
      },
    };
  }

  /** A route for a package Claude model registered through `initClaudeModels`. */
  function claudePackageRoute(id: string, gatewayId: string): GatewayFixture {
    return {
      entry: gatewayModel(id, gatewayId, 'anthropic', 'claude').entry,
    };
  }

  /** A hydrated catalog that routes the given models and nothing else. */
  function routeOnly(...models: GatewayFixture[]): void {
    initAiGatewayModels(
      models.flatMap((m) => (m.model ? [m.model] : [])),
      models.map((m) => m.entry),
    );
  }

  const LUNA_6 = gatewayModel('gpt-6-luna', 'openai/gpt-6-luna', 'gpt');
  const LUNA_56 = gatewayModel('gpt-5.6-luna', 'openai/gpt-5.6-luna', 'gpt');
  const DEEPSEEK = gatewayModel(
    'deepseek-v4-pro',
    'deepseek/deepseek-v4-pro',
    'deepseek',
  );
  const HAIKU = claudePackageRoute('haiku', 'anthropic/claude-haiku-5.5');
  const SONNET = claudePackageRoute('sonnet', 'anthropic/claude-sonnet-5');
  // A Cursor model whose route shares Haiku's gateway id.
  const CURSOR_HAIKU = gatewayModel(
    'cursor:claude-haiku-5-5',
    'anthropic/claude-haiku-5.5',
    'anthropic',
    'claude',
  );

  beforeEach(() => {
    initClaudeModels([
      { id: DEFAULT_CLAUDE_MODEL, label: 'Opus' },
      { id: 'haiku', label: 'Haiku' },
      { id: 'sonnet', label: 'Sonnet' },
    ]);
    initCodexModels([{ id: DEFAULT_CODEX_MODEL, label: 'GPT' }]);
  });

  it('falls back to GPT 6 Luna for a non-guest when DeepSeek is unroutable', () => {
    routeOnly(LUNA_6, LUNA_56);
    expect(resolve(CREDITS_ONLY)).toMatchObject({
      outcome: 'resolved',
      lane: 'ai-credits',
      selection: { model: 'gpt-6-luna' },
    });
  });

  it('keeps a non-guest on the credits lane default candidates', () => {
    routeOnly(DEEPSEEK, LUNA_6, LUNA_56, HAIKU);
    expect(resolve(CREDITS_ONLY)).toMatchObject({
      outcome: 'resolved',
      lane: 'ai-credits',
      selection: { model: CREDITS_LANE_DEFAULT_CANDIDATES[0] },
    });
  });

  it('never defaults a guest to a model outside the guest allowlist', () => {
    routeOnly(LUNA_6, LUNA_56);
    const result = resolve(CREDITS_ONLY, { guestPrincipal: true });
    expect(result).toMatchObject({
      outcome: 'resolved',
      lane: 'ai-credits',
      selection: { model: GUEST_FALLBACK },
    });
    if (result.outcome === 'resolved') {
      expect(isGuestAllowedModelId(result.selection.model)).toBe(true);
    }
  });

  it('keeps a guest on DeepSeek, the desktop lane default, when it is routable', () => {
    routeOnly(DEEPSEEK, LUNA_6, LUNA_56, HAIKU);
    expect(resolve(CREDITS_ONLY, { guestPrincipal: true })).toMatchObject({
      outcome: 'resolved',
      lane: 'ai-credits',
      selection: { model: 'deepseek-v4-pro' },
    });
  });

  it('falls back to GPT 6 Luna when DeepSeek cannot route', () => {
    routeOnly(LUNA_6, LUNA_56, HAIKU);
    expect(resolve(CREDITS_ONLY, { guestPrincipal: true })).toMatchObject({
      outcome: 'resolved',
      lane: 'ai-credits',
      selection: { model: 'gpt-6-luna' },
    });
  });

  it('falls back to GPT 5.6 Luna when neither DeepSeek nor GPT 6 Luna can route', () => {
    routeOnly(LUNA_56, HAIKU);
    expect(resolve(CREDITS_ONLY, { guestPrincipal: true })).toMatchObject({
      outcome: 'resolved',
      lane: 'ai-credits',
      selection: { model: 'gpt-5.6-luna' },
    });
  });

  it('falls back to Haiku by its registry id when it is the only allowlisted route', () => {
    routeOnly(HAIKU);
    expect(resolve(CREDITS_ONLY, { guestPrincipal: true })).toMatchObject({
      outcome: 'resolved',
      lane: 'ai-credits',
      selection: { model: 'haiku' },
    });
  });

  it('prefers the package model over a Cursor model sharing its gateway id', () => {
    // The Cursor route is registered first, so only the package preference,
    // not registration order, can pick Haiku.
    routeOnly(CURSOR_HAIKU, HAIKU);
    expect(resolve(CREDITS_ONLY, { guestPrincipal: true })).toMatchObject({
      outcome: 'resolved',
      lane: 'ai-credits',
      selection: { model: 'haiku' },
    });
  });

  it('skips a configured AI Credits default a guest may not run', () => {
    routeOnly(DEEPSEEK, LUNA_6, LUNA_56);
    const result = resolve(CREDITS_ONLY, {
      guestPrincipal: true,
      defaults: {
        ...defaults,
        aiCredits: { model: DEFAULT_CODEX_MODEL, thinkingLevel: 'high' },
      },
    });
    expect(result).toMatchObject({
      outcome: 'resolved',
      lane: 'ai-credits',
      selection: { model: GUEST_FALLBACK },
    });
  });

  it('keeps a configured AI Credits default of Haiku for a guest', () => {
    routeOnly(DEEPSEEK, LUNA_6, HAIKU);
    expect(
      resolve(CREDITS_ONLY, {
        guestPrincipal: true,
        defaults: {
          ...defaults,
          aiCredits: { model: 'haiku', thinkingLevel: 'high' },
        },
      }),
    ).toMatchObject({
      outcome: 'resolved',
      lane: 'ai-credits',
      selection: { model: 'haiku' },
    });
  });

  it('drops a configured AI Credits default of Sonnet for a guest', () => {
    routeOnly(SONNET, LUNA_6, HAIKU);
    expect(
      resolve(CREDITS_ONLY, {
        guestPrincipal: true,
        defaults: {
          ...defaults,
          aiCredits: { model: 'sonnet', thinkingLevel: 'high' },
        },
      }),
    ).toMatchObject({
      outcome: 'resolved',
      lane: 'ai-credits',
      selection: { model: 'gpt-6-luna' },
    });
  });

  it.each([
    [
      'every allowlisted model',
      [DEEPSEEK, LUNA_6, LUNA_56, HAIKU],
      ['deepseek-v4-pro', 'gpt-6-luna', 'gpt-5.6-luna', 'haiku'],
    ],
    ['only Haiku and its Cursor twin', [CURSOR_HAIKU, HAIKU], ['haiku']],
    ['only 5.6 Luna', [LUNA_56], ['gpt-5.6-luna']],
  ])(
    'walks only guest-allowed candidates with %s routable',
    (_label, routes, expected) => {
      routeOnly(SONNET, ...routes);
      // The resolver falls through candidates it may not run, so refusing
      // each resolved model in turn visits every candidate the walk yields.
      const visited: string[] = [];
      for (;;) {
        const result = resolve(CREDITS_ONLY, {
          guestPrincipal: true,
          isModelAllowed: (model) => !visited.includes(model),
        });
        if (result.outcome !== 'resolved') break;
        expect(result.lane).toBe('ai-credits');
        expect(isGuestAllowedCreditsModel(result.selection.model)).toBe(true);
        visited.push(result.selection.model);
      }
      expect(visited).toEqual(expected);
    },
  );

  it("leaves a guest's own native subscription models alone", () => {
    routeOnly(LUNA_6, LUNA_56);
    expect(
      resolve(
        {
          claudeNativeAuth: false,
          codexNativeAuth: true,
          creditsEligible: true,
        },
        { guestPrincipal: true },
      ),
    ).toMatchObject({
      outcome: 'resolved',
      lane: 'codex-native',
      selection: { model: DEFAULT_CODEX_MODEL },
    });
  });

  it('falls back to GPT 6 Luna provisionally while the gateway catalog is cold', () => {
    // No route exists yet, so no gateway id resolves and DeepSeek, which is
    // gateway-only, is not registered. The package model must still be offered.
    initCodexModels([
      { id: DEFAULT_CODEX_MODEL, label: 'GPT' },
      { id: 'gpt-6-luna', label: 'GPT 6 Luna' },
    ]);
    initAiGatewayModels([], []);
    expect(
      resolve(CREDITS_ONLY, {
        guestPrincipal: true,
        gatewayRoutesHydrated: false,
      }),
    ).toMatchObject({
      outcome: 'resolved',
      lane: 'ai-credits',
      selection: { model: GUEST_FALLBACK },
      provisional: true,
    });
  });

  it("never dispatches Haiku's bare allowlist id while the gateway catalog is cold", () => {
    // Cold, the Haiku row falls back to its bare allowlist id,
    // `claude-haiku-5.5`, which is not the registry id (`haiku`). It must be
    // skipped as unregistered, never returned as a model to run.
    initAiGatewayModels([], []);
    expect(
      resolve(CREDITS_ONLY, {
        guestPrincipal: true,
        gatewayRoutesHydrated: false,
      }),
    ).toMatchObject({ outcome: 'no-dispatchable-model' });
  });

  it('reports a dead end rather than a refused model when no allowlisted model routes', () => {
    routeOnly(SONNET);
    expect(resolve(CREDITS_ONLY, { guestPrincipal: true })).toMatchObject({
      outcome: 'no-dispatchable-model',
    });
  });
});

describe('isAiCreditsOnlyBilling', () => {
  const lanes = (
    claudeNativeAuth: boolean | undefined,
    codexNativeAuth: boolean | undefined,
    creditsEligible: boolean | undefined,
  ): BillingLaneAvailability => ({
    claudeNativeAuth,
    codexNativeAuth,
    creditsEligible,
  });

  it('is true when credits are eligible and neither provider has native access', () => {
    expect(isAiCreditsOnlyBilling(lanes(false, false, true))).toBe(true);
  });

  it('is false when either provider has native access', () => {
    expect(isAiCreditsOnlyBilling(lanes(true, false, true))).toBe(false);
    expect(isAiCreditsOnlyBilling(lanes(false, true, true))).toBe(false);
  });

  it('is false while either native access probe is unknown', () => {
    expect(isAiCreditsOnlyBilling(lanes(undefined, false, true))).toBe(false);
    expect(isAiCreditsOnlyBilling(lanes(false, undefined, true))).toBe(false);
  });

  it('is false when credits are ineligible or unknown', () => {
    expect(isAiCreditsOnlyBilling(lanes(false, false, false))).toBe(false);
    expect(isAiCreditsOnlyBilling(lanes(false, false, undefined))).toBe(false);
  });

  it('is false when every fact is unknown', () => {
    expect(isAiCreditsOnlyBilling(lanes(undefined, undefined, undefined))).toBe(
      false,
    );
  });
});

describe('CAN-4716 Codex account eligibility', () => {
  const LUNA = 'gpt-6-luna';

  beforeEach(() => {
    initClaudeModels([{ id: DEFAULT_CLAUDE_MODEL, label: 'Opus' }]);
    initCodexModels([
      { id: DEFAULT_CODEX_MODEL, label: 'GPT' },
      { id: LUNA, label: 'GPT 6 Luna' },
    ]);
  });

  function codexRepairHooks(
    accountModels: ReadonlySet<string> | null,
    blocked: (model: string) => boolean = () => false,
  ): Parameters<typeof repairLaneDefaults>[1] {
    return {
      laneCatalog: (lane: BillingLane) =>
        lane === 'codex-native' ? [DEFAULT_CODEX_MODEL, LUNA] : [],
      isPolicyBlocked: blocked,
      isModelInRegistry: (model) => resolveKnownModel(model) !== undefined,
      isLaneCatalogHydrated: () => true,
      // The same wrapper both hosts install around their lane hook.
      isRunnableOnLane: (lane, model) =>
        lane === 'codex-native'
          ? isCodexModelAvailableToAccount(model, accountModels)
          : true,
      clampThinkingLevel: (level) => level,
    };
  }

  it('treats an unknown or empty account list as eligible', () => {
    expect(isCodexModelAvailableToAccount(DEFAULT_CODEX_MODEL, null)).toBe(
      true,
    );
    expect(isCodexModelAvailableToAccount(DEFAULT_CODEX_MODEL, undefined)).toBe(
      true,
    );
    expect(isCodexModelAvailableToAccount(DEFAULT_CODEX_MODEL, new Set())).toBe(
      true,
    );
    expect(
      isCodexModelAvailableToAccount(DEFAULT_CODEX_MODEL, new Set([LUNA])),
    ).toBe(false);
    expect(isCodexModelAvailableToAccount(LUNA, new Set([LUNA]))).toBe(true);
  });

  it('repairs a configured Codex default the account cannot run to the first eligible catalog model', () => {
    const repaired = repairLaneDefaults(
      defaults,
      codexRepairHooks(new Set([LUNA])),
    );
    expect(repaired.codex).toEqual({ model: LUNA, thinkingLevel: 'high' });
  });

  it('keeps the configured Codex default when the account can run it', () => {
    const repaired = repairLaneDefaults(
      defaults,
      codexRepairHooks(new Set([DEFAULT_CODEX_MODEL, LUNA])),
    );
    expect(repaired.codex.model).toBe(DEFAULT_CODEX_MODEL);
  });

  it.each([
    ['null', null],
    ['empty', new Set<string>()],
  ])('changes nothing for a %s account list', (_label, accountModels) => {
    const repaired = repairLaneDefaults(
      defaults,
      codexRepairHooks(accountModels),
    );
    expect(repaired.codex.model).toBe(DEFAULT_CODEX_MODEL);
  });

  it('skips a policy-blocked eligible model', () => {
    const repaired = repairLaneDefaults(
      defaults,
      codexRepairHooks(new Set([LUNA]), (model) => model === LUNA),
    );
    // No eligible, allowed candidate: the original selection stays so the
    // resolver sees the lane as undispatchable.
    expect(repaired.codex.model).toBe(DEFAULT_CODEX_MODEL);
  });

  it('never rewrites the stored defaults object', () => {
    const stored: LaneModelDefaults = {
      ...defaults,
      codex: { model: DEFAULT_CODEX_MODEL, thinkingLevel: 'high' },
    };
    const snapshot = structuredClone(stored);
    const repaired = repairLaneDefaults(
      stored,
      codexRepairHooks(new Set([LUNA])),
    );
    expect(repaired.codex.model).toBe(LUNA);
    expect(stored).toEqual(snapshot);
  });

  it('falls through to AI Credits when the account can run no Codex candidate', () => {
    const availability = {
      claudeNativeAuth: false,
      codexNativeAuth: true,
      creditsEligible: true,
    };
    expect(
      resolve(availability, {
        preferredProvider: 'codex',
        codexAccountModels: new Set(['some-other-model']),
        // A cold gateway catalog fails open on routability, so the registered
        // candidate stands in for a routable credits model here.
        gatewayRoutesHydrated: false,
        creditsCandidates: [LUNA],
      }),
    ).toMatchObject({
      outcome: 'resolved',
      lane: 'ai-credits',
      selection: { model: LUNA },
    });
    expect(
      resolve(
        { ...availability, creditsEligible: false },
        {
          preferredProvider: 'codex',
          codexAccountModels: new Set(['some-other-model']),
        },
      ),
    ).toMatchObject({ outcome: 'no-dispatchable-model' });
    expect(
      resolve(availability, {
        preferredProvider: 'codex',
        codexAccountModels: null,
      }),
    ).toMatchObject({
      outcome: 'resolved',
      lane: 'codex-native',
      selection: { model: DEFAULT_CODEX_MODEL },
    });
  });
});
