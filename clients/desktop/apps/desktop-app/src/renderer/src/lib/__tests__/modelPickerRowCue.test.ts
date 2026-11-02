import {
  type GatewayRouteEntry,
  initAiGatewayModels,
  initClaudeModels,
  initCodexModels,
  initOllamaModels,
} from '@canopy/desktop-shared/types';
import type { ModelLibraryAccess } from '@canopy/protocol/models';
import {
  resolveModelRowGate,
  type ModelRowGateInput,
  type VisibleModelRowGate,
} from '../modelPickerRowGate';
import { resolveDesktopModelRowCue } from '../modelPickerRowCue';
import { resolveModelLibraryLock } from '../modelLibraryAccess';
import type { BillingFramework } from '../chatBillingFramework';
import type { ProviderModelAvailability } from '@/hooks/useProviderAvailability';

/**
 * CAN-5213 — the desktop adapter fed by the real row gate, so each case is the
 * cue a picker row actually shows for that account state.
 */
const DEEPSEEK = 'deepseek-v4-pro';
const LUNA = 'gpt-6-luna';
const HAIKU = 'claude-haiku-cue-test';
const OPUS = 'claude-fable-5.1';
const NATIVE_ONLY = 'claude-native-only-cue-test';
const CODEX_NATIVE_ONLY = 'codex-native-only-cue-test';
const ORG_MODEL = 'claude-org-cue-test';
const LOCAL = 'llama-cue-test';

function route(
  modelId: string,
  gatewayOnly: boolean,
  gatewayId = `vendor/${modelId}`,
): GatewayRouteEntry {
  return {
    modelId,
    gatewayId,
    family: 'claude',
    recommendedHarness: 'claude',
    gatewayOnly,
    contextWindow: 100_000,
    supportsPromptCaching: false,
    supportedThinkingLevels: [],
    toolSchemaProfile: 'standard',
  };
}

beforeAll(() => {
  initClaudeModels([
    { id: HAIKU, label: 'Haiku' },
    { id: OPUS, label: 'Opus' },
    { id: NATIVE_ONLY, label: 'Native only' },
    { id: ORG_MODEL, label: 'Org' },
  ]);
  initCodexModels([
    { id: LUNA, label: 'Luna' },
    { id: CODEX_NATIVE_ONLY, label: 'Codex native only' },
  ]);
  initOllamaModels([{ id: LOCAL, rawModelId: LOCAL, label: 'Llama' }]);
  initAiGatewayModels(
    [],
    [
      route(DEEPSEEK, true),
      route(LUNA, false),
      // Admitted through its gateway id, as the shipped Haiku row is.
      route(HAIKU, false, 'anthropic/claude-haiku-5.5'),
      route(OPUS, false),
      {
        ...route(ORG_MODEL, true),
        family: 'custom',
        origin: 'org-gateway',
        baseUrl: 'https://gateway.acme.test',
        organizationId: 'org-1',
        promptCachePassthrough: true,
      },
    ],
  );
});

/** A guest with no provider CLI, no balance, and daily credits off. */
const DRIP_OFF: ProviderModelAvailability = {
  selectable: false,
  nativeAuth: false,
  creditsEligible: false,
  loading: false,
  creditsLoading: false,
  dailyCreditsEnabled: false,
};

interface Scenario {
  readonly model: string;
  readonly provider?: 'claude' | 'codex' | 'ollama';
  readonly availability?: ProviderModelAvailability;
  readonly isGuest?: boolean;
  readonly libraryAccess?: ModelLibraryAccess;
  readonly billingValue?: BillingFramework;
  readonly requireCredits?: boolean;
  readonly currentModel?: string;
  readonly agent?: boolean;
  readonly gatingEnabled?: boolean;
}

function providerFor(model: string): 'claude' | 'codex' | 'ollama' {
  if (model === LUNA || model === CODEX_NATIVE_ONLY) return 'codex';
  if (model === LOCAL) return 'ollama';
  return 'claude';
}

function rowGate(scenario: Scenario): VisibleModelRowGate {
  const isGuest = scenario.isGuest ?? true;
  const input: ModelRowGateInput = {
    model: scenario.model,
    provider: scenario.provider ?? providerFor(scenario.model),
    currentModel: scenario.currentModel,
    gatingEnabled: scenario.gatingEnabled ?? true,
    availability: scenario.availability ?? DRIP_OFF,
    billingValue: scenario.billingValue,
    requireCredits: scenario.requireCredits,
    lockedProvider: undefined,
    lockedProviderBehavior: 'disabled',
    lockedProviderReason: undefined,
    lockedHarness: undefined,
    canStartNewChat: false,
    modelPolicy: new Set<string>(),
    staleAgent: false,
    isGuest,
    libraryAccess: scenario.libraryAccess,
  };
  const gate = resolveModelRowGate(input);
  if (gate.kind === 'hidden') throw new Error('row is hidden');
  return gate;
}

function cue(scenario: Scenario): ReturnType<typeof resolveDesktopModelRowCue> {
  const isGuest = scenario.isGuest ?? true;
  return resolveDesktopModelRowCue({
    model: scenario.model,
    provider: scenario.provider ?? providerFor(scenario.model),
    agent: scenario.agent ?? false,
    gate: rowGate(scenario),
    viewerLock: resolveModelLibraryLock(isGuest, scenario.libraryAccess),
    availability:
      scenario.gatingEnabled === false
        ? undefined
        : (scenario.availability ?? DRIP_OFF),
    billingValue: scenario.billingValue,
    requireCredits: scenario.requireCredits ?? false,
  });
}

const FUNDED: ProviderModelAvailability = {
  ...DRIP_OFF,
  selectable: true,
  creditsEligible: true,
};

describe('resolveDesktopModelRowCue — drip-off guest with no CLI', () => {
  it.each([HAIKU, LUNA, DEEPSEEK])(
    'asks for free daily credits on %s',
    (model) => {
      expect(cue({ model })).toEqual({ kind: 'needs-daily-credits' });
    },
  );

  it('keeps both library steps on the Opus gate without a duplicate cue', () => {
    const scenario: Scenario = {
      model: OPUS,
      libraryAccess: 'needs_sign_in_then_purchase',
    };
    expect(rowGate(scenario)).toMatchObject({
      kind: 'recoverable',
      recovery: {
        kind: 'needs-account',
        access: 'needs_sign_in_then_purchase',
      },
    });
    expect(cue(scenario)).toBeUndefined();
  });

  it('asks for the provider sign-in on a native-only model', () => {
    expect(cue({ model: NATIVE_ONLY })).toEqual({
      kind: 'needs-provider-sign-in',
      providerLabel: 'Claude',
    });
    expect(cue({ model: CODEX_NATIVE_ONLY })).toEqual({
      kind: 'needs-provider-sign-in',
      providerLabel: 'Codex',
    });
  });

  it('asks for the sign-in even when credits or daily credits are on', () => {
    // Credits can never pay for a native-only model.
    expect(cue({ model: CODEX_NATIVE_ONLY, availability: FUNDED })).toEqual({
      kind: 'needs-provider-sign-in',
      providerLabel: 'Codex',
    });
    expect(
      cue({
        model: CODEX_NATIVE_ONLY,
        availability: { ...DRIP_OFF, dailyCreditsEnabled: true },
      }),
    ).toEqual({ kind: 'needs-provider-sign-in', providerLabel: 'Codex' });
  });

  it('offers no sign-in while the provider probe loads', () => {
    expect(
      cue({
        model: CODEX_NATIVE_ONLY,
        availability: { ...DRIP_OFF, loading: true },
      }),
    ).toBeUndefined();
  });

  it('offers nothing while the preference is unknown', () => {
    const availability = { ...DRIP_OFF };
    delete availability.dailyCreditsEnabled;
    expect(cue({ model: HAIKU, availability })).toBeUndefined();
  });

  it('offers nothing once daily credits are on but spent', () => {
    expect(
      cue({
        model: HAIKU,
        availability: { ...DRIP_OFF, dailyCreditsEnabled: true },
      }),
    ).toBeUndefined();
  });

  it('offers nothing while credits load or after an inconclusive read', () => {
    expect(
      cue({
        model: DEEPSEEK,
        availability: { ...DRIP_OFF, loading: true, creditsLoading: true },
      }),
    ).toBeUndefined();
    expect(
      cue({
        model: HAIKU,
        availability: { ...DRIP_OFF, creditsInconclusive: true },
      }),
    ).toBeUndefined();
  });
});

describe('resolveDesktopModelRowCue — usable rows', () => {
  it.each([HAIKU, LUNA, DEEPSEEK])(
    'marks %s Available once credits settle',
    (model) => {
      expect(cue({ model, availability: FUNDED })).toEqual({
        kind: 'available',
      });
    },
  );

  it('keeps a funded guest locked out of Opus', () => {
    // The gate draws the library lock itself, so no new cue.
    expect(cue({ model: OPUS, availability: FUNDED })).toBeUndefined();
  });

  it('marks a native subscription route Available, Opus included', () => {
    const native = { ...DRIP_OFF, nativeAuth: true, selectable: true };
    expect(cue({ model: OPUS, availability: native })).toEqual({
      kind: 'available',
    });
    expect(cue({ model: NATIVE_ONLY, availability: native })).toEqual({
      kind: 'available',
    });
  });

  it('respects an explicit AI Credits billing choice over the subscription', () => {
    const native = { ...DRIP_OFF, nativeAuth: true, selectable: true };
    // Unfunded credits are not Available, and the gate offers no recovery
    // here, so the row promises no opt-in either.
    expect(
      cue({ model: HAIKU, availability: native, billingValue: 'ai-credits' }),
    ).toBeUndefined();
    expect(
      cue({
        model: HAIKU,
        availability: { ...native, creditsEligible: true },
        billingValue: 'ai-credits',
      }),
    ).toEqual({ kind: 'available' });
  });

  it('does not take the gate’s optimism while a probe loads', () => {
    expect(
      cue({
        model: DEEPSEEK,
        availability: { ...FUNDED, loading: true, creditsLoading: true },
      }),
    ).toBeUndefined();
  });

  it('does not call the current, unfunded model Available', () => {
    // The gate keeps a chat's own model selectable; it cannot run a new turn.
    expect(
      cue({ model: OPUS, currentModel: OPUS, availability: FUNDED }),
    ).toBeUndefined();
  });

  it('marks a signed-in purchase-required account’s admitted rows', () => {
    expect(
      cue({
        model: HAIKU,
        isGuest: false,
        libraryAccess: 'needs_purchase',
        availability: FUNDED,
      }),
    ).toEqual({ kind: 'available' });
    expect(
      cue({ model: HAIKU, isGuest: false, libraryAccess: 'needs_purchase' }),
    ).toEqual({ kind: 'needs-daily-credits' });
  });
});

describe('resolveDesktopModelRowCue — no new cue', () => {
  it('leaves an unlocked viewer’s recovery unchanged', () => {
    expect(
      cue({ model: HAIKU, isGuest: false, libraryAccess: 'unlocked' }),
    ).toBeUndefined();
    expect(
      cue({
        model: HAIKU,
        isGuest: false,
        libraryAccess: 'unlocked',
        availability: FUNDED,
      }),
    ).toBeUndefined();
  });

  it('skips organization work, whose access is unknown', () => {
    expect(cue({ model: HAIKU, isGuest: false })).toBeUndefined();
  });

  it('skips Agent rows', () => {
    expect(cue({ model: HAIKU, agent: true })).toBeUndefined();
  });

  it('skips config surfaces with no availability', () => {
    expect(cue({ model: HAIKU, gatingEnabled: false })).toBeUndefined();
  });

  it('skips organization gateway routes and local models', () => {
    expect(cue({ model: ORG_MODEL })).toBeUndefined();
    expect(cue({ model: LOCAL, availability: FUNDED })).toBeUndefined();
  });

  it('describes the credits route of a harness credits row', () => {
    const native = { ...DRIP_OFF, nativeAuth: true, selectable: true };
    expect(
      cue({
        model: HAIKU,
        availability: native,
        billingValue: 'ai-credits',
        requireCredits: true,
      }),
    ).toEqual({ kind: 'needs-daily-credits' });
  });
});
