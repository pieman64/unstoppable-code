import {
  type ChatTabPluginSelections,
  type GatewayRouteEntry,
  initAgentModels,
  initAiGatewayModels,
  initClaudeModels,
  initCodexModels,
  initOllamaModels,
} from '@canopy/desktop-shared/types';
import {
  isGuestAllowedSelection,
  resolveModelRowGate,
  type ModelRowGate,
  type ModelRowGateInput,
} from '../modelPickerRowGate';
import type { ProviderModelAvailability } from '@/hooks/useProviderAvailability';
import {
  GUEST_ALLOWED_MODELS,
  MODEL_LIBRARY_ACCESS_VALUES,
} from '@canopy/protocol/models';

/**
 * CAN-2349 gate matrix. Pure — no React, no DOM. This is the file that makes
 * the ordering decisions in `resolveModelRowGate` assertable one at a time
 * instead of only through a rendered picker.
 */

const CLAUDE_GATEWAY = 'opus';
const CLAUDE_NON_GATEWAY = 'claude-legacy-gate-test';
const CLAUDE_GATEWAY_ONLY = 'claude-gateway-only-gate-test';
const CLAUDE_ORG_GATEWAY = 'claude-org-gateway-gate-test';
const OLLAMA_MODEL = 'llama-gate-test';
// CAN-3026 — the guest allowlist, spelled exactly as `GUEST_ALLOWED_MODELS`
// does. Real ids on purpose: the point of these cases is that the SHIPPED
// desktop AI-Credits default (`deepseek-v4-pro`) stays selectable for a guest,
// and that GPT-6 Luna, the guest model on web and desktop, is selectable too.
const GUEST_ALLOWED_GATEWAY_ONLY = 'deepseek-v4-pro';
const GUEST_ALLOWED_NATIVE = 'gpt-6-luna';
/** An expensive model a guest must not reach. Credit-routed, not gateway-only. */
const GUEST_BLOCKED_NATIVE = 'claude-fable-5.1';

function gatewayRoute(
  modelId: string,
  gatewayOnly: boolean,
): GatewayRouteEntry {
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

function emptyPluginSelections(): ChatTabPluginSelections {
  return {
    collectionIds: [],
    skillRefs: [],
    pluginRefs: [],
    mcpServerRefs: [],
  };
}

/**
 * CAN-3026 routes. `deepseek-v4-pro` is gateway-only (case B); `gpt-6-luna`
 * and `claude-fable-5.1` are routable but NOT gateway-only, so they exercise
 * the `creditRouted` half of the guest gate — the half that matters, since
 * Luna itself is a native Codex model.
 */
const GUEST_ROUTES: readonly GatewayRouteEntry[] = [
  gatewayRoute(GUEST_ALLOWED_GATEWAY_ONLY, true),
  gatewayRoute(GUEST_ALLOWED_NATIVE, false),
  gatewayRoute(GUEST_BLOCKED_NATIVE, false),
];

/** Re-seeds the routes `beforeAll` installs, for specs that clear them. */
function restoreGatewayRoutes(): void {
  initAiGatewayModels(
    [],
    [
      gatewayRoute(CLAUDE_GATEWAY_ONLY, true),
      {
        ...gatewayRoute(CLAUDE_ORG_GATEWAY, true),
        family: 'custom',
        origin: 'org-gateway',
        baseUrl: 'https://gateway.acme.test',
        organizationId: 'org-1',
        promptCachePassthrough: true,
      },
      ...GUEST_ROUTES,
    ],
  );
}

beforeAll(() => {
  initClaudeModels([
    { id: CLAUDE_GATEWAY, label: 'Opus' },
    { id: CLAUDE_NON_GATEWAY, label: 'Claude Legacy' },
    { id: CLAUDE_GATEWAY_ONLY, label: 'Claude Gateway Only' },
    { id: CLAUDE_ORG_GATEWAY, label: 'Organization Claude' },
  ]);
  initCodexModels([
    { id: 'gpt-5.5', label: 'GPT-5.5' },
    // Real registry membership: an Agent's base model must be a known provider
    // model for the overlay to resolve, and Luna is a native Codex row.
    { id: GUEST_ALLOWED_NATIVE, label: 'GPT 6 Luna' },
  ]);
  initOllamaModels([
    { id: OLLAMA_MODEL, rawModelId: OLLAMA_MODEL, label: 'Llama' },
  ]);
  // Native registry init no longer feeds the gateway route table:
  // `initAiGatewayModels` is the only writer, and it atomically replaces both
  // the API-only rows and ALL routes. Routes for managed models live here.
  initAiGatewayModels(
    [],
    [
      gatewayRoute(CLAUDE_GATEWAY_ONLY, true),
      {
        ...gatewayRoute(CLAUDE_ORG_GATEWAY, true),
        family: 'custom',
        origin: 'org-gateway',
        baseUrl: 'https://gateway.acme.test',
        organizationId: 'org-1',
        promptCachePassthrough: true,
      },
      ...GUEST_ROUTES,
    ],
  );
});

const avail = (
  overrides: Partial<ProviderModelAvailability> = {},
): ProviderModelAvailability => ({
  selectable: false,
  nativeAuth: false,
  creditsEligible: false,
  loading: false,
  ...overrides,
});

function gate(overrides: Partial<ModelRowGateInput> = {}): ModelRowGate {
  const input: ModelRowGateInput = {
    model: CLAUDE_GATEWAY,
    provider: 'claude',
    currentModel: undefined,
    gatingEnabled: true,
    availability: avail(),
    billingValue: undefined,
    lockedProvider: undefined,
    lockedProviderBehavior: 'disabled',
    lockedProviderReason: undefined,
    // Explicit rather than relying on the trailing `...overrides` spread to
    // satisfy a required-but-`| undefined` property. Left implicit, the harness
    // lock — the highest-risk branch in this resolver — reads as covered by
    // every case below while never actually being set by any of them.
    lockedHarness: undefined,
    canStartNewChat: false,
    modelPolicy: new Set<string>(),
    staleAgent: false,
    ...overrides,
  };
  return resolveModelRowGate(input);
}

describe('resolveModelRowGate — precedence', () => {
  it('puts org policy above everything else', () => {
    // Backstop. Even a row that would otherwise be recoverable must not offer a
    // purchase for a model the org has forbidden.
    const result = gate({
      modelPolicy: new Set([CLAUDE_GATEWAY]),
      staleAgent: true,
    });
    expect(result.kind).toBe('hard-disabled');
    if (result.kind === 'hard-disabled') {
      expect(result.cause).toBe('org-policy');
      expect(result.reason).toContain('organization');
    }
  });

  it('names the owning organization in the policy reason', () => {
    expect(
      gate({
        modelPolicy: new Set([CLAUDE_GATEWAY]),
        organizationName: 'Acme',
      }),
    ).toMatchObject({
      cause: 'org-policy',
      reason: 'Blocked by Acme’s model policy.',
    });
  });

  it('keeps a stale Agent hard-disabled, never recoverable', () => {
    // `getAgentModelAvailability` only ever reports `not_found` /
    // `base_model_unavailable` — it never reflects auth or credits. A broken
    // Agent definition is not an account state, so no purchase fixes it.
    const result = gate({ staleAgent: true });
    expect(result.kind).toBe('hard-disabled');
    if (result.kind === 'hard-disabled') {
      expect(result.cause).toBe('stale-agent');
      expect(result.reason).toContain('base model');
    }
  });

  it('lets the locked provider outrank a missing billing source', () => {
    // A cross-harness row for a user with no billing source is both H and A.
    // H wins: the row is unusable in THIS chat at any price.
    expect(
      gate({
        model: OLLAMA_MODEL,
        provider: 'ollama',
        lockedProvider: 'claude',
        canStartNewChat: true,
      }),
    ).toEqual({
      kind: 'recoverable',
      recovery: { kind: 'needs-new-chat', lockedProvider: 'claude' },
    });
  });

  it('stays optimistic while a probe is in flight', () => {
    // The trap this guards: a row that is available only because a probe has
    // not landed must never become `recoverable`, or a click during the probe
    // would open a modal — and, worse, a settle during the modal would commit.
    expect(gate({ availability: avail({ loading: true }) })).toEqual({
      kind: 'available',
    });
  });
});

describe('resolveModelRowGate — recoverable cases', () => {
  it('case A: no native login and no credits on a claude/codex row', () => {
    expect(gate()).toEqual({
      kind: 'recoverable',
      recovery: { kind: 'needs-billing-source', provider: 'claude' },
    });
  });

  it('case B: a gateway-only model with no credits', () => {
    // Native auth does NOT help here — a gateway-only model can never bill to a
    // subscription — so the recovery is credits-only.
    expect(
      gate({
        model: CLAUDE_GATEWAY_ONLY,
        availability: avail({ nativeAuth: true }),
      }),
    ).toEqual({ kind: 'recoverable', recovery: { kind: 'needs-credits' } });
  });

  it('keeps an organization gateway model available without hosted credits', () => {
    expect(
      gate({
        model: CLAUDE_ORG_GATEWAY,
        availability: avail(),
      }),
    ).toEqual({ kind: 'available' });
  });

  it('hides every non-org row when the org gateway is the only route', () => {
    // Dimming these produced a picker where ~20 permanently dead rows buried
    // the handful the org actually permits. They can never become selectable
    // while enforcement stands, so they are case-E hidden, not disabled.
    expect(
      gate({
        model: CLAUDE_GATEWAY,
        availability: avail({ nativeAuth: true, creditsEligible: true }),
        modelGatewayEnforced: true,
      }),
    ).toEqual({ kind: 'hidden', cause: 'org-gateway-only' });
  });

  it('hides local models under enforcement too: only route means only route', () => {
    // The deliberate divergence from org model policy and from case E, both of
    // which exempt Ollama.
    expect(
      gate({
        model: OLLAMA_MODEL,
        provider: 'ollama',
        availability: avail({ selectable: true }),
        modelGatewayEnforced: true,
      }),
    ).toEqual({ kind: 'hidden', cause: 'org-gateway-only' });
  });

  it('keeps the chat’s own model visible and explained under enforcement', () => {
    // A chat stamped before enforcement landed still has to render its
    // selection; hiding it leaves the picker showing no current model at all.
    expect(
      gate({
        model: CLAUDE_GATEWAY,
        currentModel: CLAUDE_GATEWAY,
        availability: avail({ nativeAuth: true, creditsEligible: true }),
        modelGatewayEnforced: true,
      }),
    ).toEqual({
      kind: 'hard-disabled',
      cause: 'org-gateway',
      reason: 'Your organization requires its configured model gateway.',
    });
  });

  it('does not hide anything while the gateway route table is still cold', () => {
    // With no routes loaded, `isOrgGatewayRoute` cannot tell an org model from
    // a native one, so hiding on that answer empties the picker down to the
    // current model. Case E guards its own hide with `hasGatewayModelRoutes()`
    // for the same reason; degrade to the visible, self-explaining row instead.
    initAiGatewayModels([], []);
    try {
      expect(
        gate({
          model: CLAUDE_ORG_GATEWAY,
          availability: avail({ nativeAuth: true, creditsEligible: true }),
          modelGatewayEnforced: true,
        }),
      ).toMatchObject({ kind: 'hard-disabled', cause: 'org-gateway' });
    } finally {
      restoreGatewayRoutes();
    }
  });

  it('names the owning organization in the gateway reason', () => {
    expect(
      gate({
        model: CLAUDE_GATEWAY,
        currentModel: CLAUDE_GATEWAY,
        availability: avail({ nativeAuth: true, creditsEligible: true }),
        modelGatewayEnforced: true,
        organizationName: 'Acme',
      }),
    ).toMatchObject({
      cause: 'org-gateway',
      reason: 'Acme requires its configured model gateway.',
    });
  });

  it('leaves the org’s own rows selectable under enforcement', () => {
    expect(
      gate({
        model: CLAUDE_ORG_GATEWAY,
        availability: avail({ nativeAuth: true, creditsEligible: true }),
        modelGatewayEnforced: true,
      }),
    ).toEqual({ kind: 'available' });
  });

  it('case H: a never-continuable pair, only when a new chat is offered', () => {
    const withOffer = gate({
      model: OLLAMA_MODEL,
      provider: 'ollama',
      lockedProvider: 'claude',
      canStartNewChat: true,
    });
    expect(withOffer.kind).toBe('recoverable');

    // Without `onStartNewChat` there is nothing to offer, so it falls back to
    // the shared hard-disabled treatment rather than inventing one.
    const withoutOffer = gate({
      model: OLLAMA_MODEL,
      provider: 'ollama',
      lockedProvider: 'claude',
      canStartNewChat: false,
    });
    expect(withoutOffer.kind).toBe('hard-disabled');
  });

  it('never reaches case A for an Ollama row', () => {
    // Ollama runs locally and is never gated on auth or credits, so
    // "sign in to Ollama" must be unreachable — enforced at the type level by
    // `needs-billing-source`'s `'claude' | 'codex'`, and here at runtime.
    expect(gate({ model: OLLAMA_MODEL, provider: 'ollama' })).toEqual({
      kind: 'available',
    });
  });
});

describe('resolveModelRowGate — case E hiding', () => {
  it('hides a model AI Credits cannot route', () => {
    expect(
      gate({
        model: CLAUDE_NON_GATEWAY,
        billingValue: 'ai-credits',
        availability: avail({ nativeAuth: true }),
      }),
    ).toEqual({ kind: 'hidden', cause: 'not-billable-to-credits' });
  });

  it('refuses to hide the currently-selected model', () => {
    expect(
      gate({
        model: CLAUDE_NON_GATEWAY,
        currentModel: CLAUDE_NON_GATEWAY,
        billingValue: 'ai-credits',
        availability: avail({ nativeAuth: true }),
      }),
    ).toEqual({ kind: 'available' });
  });

  it('hides nothing under subscription billing', () => {
    expect(
      gate({
        model: CLAUDE_NON_GATEWAY,
        billingValue: 'subscription',
        availability: avail({ nativeAuth: true }),
      }),
    ).toEqual({ kind: 'available' });
  });

  it('never hides an Ollama row on a billing question', () => {
    // Ollama is local and free, so AI Credits routing is not a question it can
    // fail. Hiding it here also names a remedy the user may not have: with
    // credits but no native login `resolveChatBillingFramework` returns
    // `toggleDisabled: true`, so "turn AI Credits off to see them" points at a
    // control that cannot be operated and the local models simply vanish.
    expect(
      gate({
        model: OLLAMA_MODEL,
        provider: 'ollama',
        billingValue: 'ai-credits',
      }),
    ).toEqual({ kind: 'available' });
  });
});

describe('resolveModelRowGate — legacy harness inference', () => {
  // A chat persisted before `executionHarness` existed has its harness inferred
  // by `inferLegacyExecutionHarness`, which returns 'claude' for an Ollama model
  // (`types.ts`) even though every Ollama model actually runs on
  // DEFAULT_OLLAMA_HARNESS ('codex'). These cases pin the resolver's correction
  // for that skew. The shared inference itself is develop's and is deliberately
  // left alone: `getLockedHarness` also feeds message-time harness capture in
  // `messaging.ts`, so changing it would repin live legacy chats.
  const legacyOllamaChat = {
    lockedProvider: 'ollama',
    lockedHarness: 'claude',
    canStartNewChat: true,
  } satisfies Partial<ModelRowGateInput>;

  it('does not offer a new chat to reach the model already selected', () => {
    // The self-contradiction: the checked row renders clickable and the modal
    // says "this chat is running on Ollama, which can't be carried over to
    // <that same Ollama model>".
    expect(
      gate({
        ...legacyOllamaChat,
        model: OLLAMA_MODEL,
        provider: 'ollama',
        currentModel: OLLAMA_MODEL,
      }),
    ).toEqual({ kind: 'available' });
  });

  it('does not offer a new chat to reach a sibling Ollama model', () => {
    // Same skew, different row: switching between two local models inside an
    // Ollama chat is not a harness move at all.
    expect(
      gate({
        ...legacyOllamaChat,
        model: OLLAMA_MODEL,
        provider: 'ollama',
        currentModel: 'some-other-ollama-model',
      }),
    ).toEqual({ kind: 'available' });
  });

  it('still refuses to continue a legacy Ollama chat onto Claude', () => {
    // Regression guard for the correction above: Ollama remains non-continuable
    // in both directions, so the cross-harness offer must survive.
    const result = gate({
      ...legacyOllamaChat,
      model: CLAUDE_GATEWAY,
      provider: 'claude',
    });
    expect(result.kind).toBe('recoverable');
    if (result.kind === 'recoverable') {
      expect(result.recovery).toEqual({
        kind: 'needs-new-chat',
        lockedProvider: 'ollama',
        lockedHarness: 'codex',
      });
    }
  });

  it('leaves a MODERN Ollama chat on the harness comparison', () => {
    // The repair is scoped to the legacy 'claude' misreading only. A chat that
    // captured `executionHarness: 'codex'` is telling the truth — it really
    // does run on the Codex harness — so switching it to a Codex model is a
    // same-harness switch and stays allowed. Widening the repair to every
    // `lockedProvider === 'ollama'` chat would have turned this into a
    // needs-new-chat offer.
    expect(
      gate({
        model: 'gpt-5.5',
        provider: 'codex',
        lockedProvider: 'ollama',
        lockedHarness: 'codex',
        lockedProviderBehavior: 'continue',
        canStartNewChat: true,
        availability: avail({ nativeAuth: true }),
      }),
    ).toEqual({ kind: 'available' });
  });

  it('keeps the provider comparison when no harness was captured', () => {
    // The other half of the scoping. With `lockedHarness` absent there is
    // nothing to repair, and synthesizing DEFAULT_OLLAMA_HARNESS here would
    // flip the whole decision onto the harness branch — where a Codex row
    // matches exactly and every Codex model in an Ollama-locked chat silently
    // unlocks.
    const result = gate({
      model: 'gpt-5.5',
      provider: 'codex',
      lockedProvider: 'ollama',
      lockedHarness: undefined,
      lockedProviderBehavior: 'continue',
      canStartNewChat: true,
    });
    expect(result.kind).toBe('recoverable');
    if (result.kind === 'recoverable') {
      expect(result.recovery).toEqual({
        kind: 'needs-new-chat',
        lockedProvider: 'ollama',
      });
    }
  });

  it('continues a Claude<->Codex pair known only by its captured harness', () => {
    // `getLockedHarness` always resolves for a started chat, but
    // `getLockedProvider` returns undefined for a tab with content and no
    // `providerType`/`model`. In that window a genuinely continuable row was
    // being offered as "start a new chat" purely because the provider half of
    // the pair was unknown.
    expect(
      gate({
        model: CLAUDE_GATEWAY,
        provider: 'claude',
        lockedProvider: undefined,
        lockedHarness: 'codex',
        lockedProviderBehavior: 'continue',
        canStartNewChat: true,
        availability: avail({ nativeAuth: true }),
      }),
    ).toEqual({ kind: 'available' });
  });
});

describe('resolveModelRowGate — the five config surfaces', () => {
  /**
   * The load-bearing constraint. With `providerAvailability === undefined`
   * these surfaces write a CONFIG VALUE (a pipeline alias, a hook action), not
   * a chat turn — a purchase modal that then auto-commits a pipeline alias
   * would be wrong. The resolver must return exactly what the pre-CAN-2349 code
   * produced.
   */
  const configSurface: Partial<ModelRowGateInput> = {
    gatingEnabled: false,
    availability: undefined,
    billingValue: undefined,
  };

  it('never resolves a gateway-only row to recoverable', () => {
    const result = gate({ ...configSurface, model: CLAUDE_GATEWAY_ONLY });
    expect(result.kind).toBe('hard-disabled');
    if (result.kind === 'hard-disabled') {
      expect(result.cause).toBe('no-credits');
      expect(result.reason).toContain('AI Credits');
    }
  });

  it('treats an ungated ordinary row as available, exactly as before', () => {
    expect(gate({ ...configSurface })).toEqual({ kind: 'available' });
  });

  it('never resolves case H even if a new chat were somehow offered', () => {
    const result = gate({
      ...configSurface,
      model: OLLAMA_MODEL,
      provider: 'ollama',
      lockedProvider: 'claude',
      canStartNewChat: true,
    });
    expect(result.kind).toBe('hard-disabled');
  });
});

describe('resolveModelRowGate — hard-disabled reasons', () => {
  it('always carries a reason, on every cause', () => {
    // §6: `ModelOption` renders the identical trio (dim, tooltip,
    // click-to-reveal) for every hard-disabled row and reads `gate.reason`
    // unconditionally — so a cause that produced an empty reason would render a
    // blank explanation with no component-level branch to catch it.
    const cases: ModelRowGate[] = [
      gate({ modelPolicy: new Set([CLAUDE_GATEWAY]) }),
      gate({ staleAgent: true }),
      gate({
        model: OLLAMA_MODEL,
        provider: 'ollama',
        lockedProvider: 'claude',
      }),
      gate({ gatingEnabled: false, model: CLAUDE_GATEWAY_ONLY }),
      gate({ gatingEnabled: false, availability: avail() }),
    ];
    for (const result of cases) {
      expect(result.kind).toBe('hard-disabled');
      if (result.kind === 'hard-disabled') {
        expect(result.reason.length).toBeGreaterThan(0);
      }
    }
  });

  it('uses the specific transient reason only for a continuable pair (case J)', () => {
    // A chat that COULD be continued but is blocked right now.
    const transient = gate({
      provider: 'codex',
      model: 'gpt-5.5',
      lockedProvider: 'claude',
      lockedProviderReason: 'Stop the current turn, then switch.',
    });
    expect(transient).toEqual({
      kind: 'hard-disabled',
      cause: 'locked-provider',
      reason: 'Stop the current turn, then switch.',
    });

    // It must NOT leak onto a pair that can never be continued: promising a
    // switch that will never become available is worse than saying nothing.
    const never = gate({
      model: OLLAMA_MODEL,
      provider: 'ollama',
      lockedProvider: 'claude',
      lockedProviderReason: 'Stop the current turn, then switch.',
    });
    expect(never.kind).toBe('hard-disabled');
    if (never.kind === 'hard-disabled') {
      expect(never.reason).not.toContain('Stop the current turn');
    }
  });
});

/**
 * CAN-3026 — the guest model gate.
 *
 * Scope is the load-bearing thing here: only selections Canopy would PAY for
 * are intercepted. A guest on their own Claude/Codex subscription or on local
 * Ollama costs Canopy nothing, and pushing them onto the hosted gateway would
 * raise cost for exactly the users the gate targets.
 */
describe('resolveModelRowGate — guest model gate (CAN-3026)', () => {
  /** Funded: every consented guest receives the daily AI-credit drip. */
  const fundedGuest = avail({ creditsEligible: true, nativeAuth: false });

  it('CAN-5211 sends an unfunded guest native route to the account gate', () => {
    expect(
      gate({
        model: GUEST_BLOCKED_NATIVE,
        availability: avail({ creditsEligible: false, nativeAuth: false }),
        isGuest: true,
        libraryAccess: 'needs_sign_in_then_purchase',
      }),
    ).toEqual({
      kind: 'recoverable',
      recovery: {
        kind: 'needs-account',
        access: 'needs_sign_in_then_purchase',
      },
    });
  });

  it('intercepts a guest picking a gateway-only model Canopy pays for', () => {
    // Funded on purpose. The gate must sit AHEAD of the credits probe —
    // otherwise the guest resolves `available` first and the drip pays for the
    // expensive turn, which is the whole incident.
    expect(
      gate({
        model: CLAUDE_GATEWAY_ONLY,
        availability: fundedGuest,
        isGuest: true,
      }),
    ).toEqual({
      kind: 'recoverable',
      recovery: { kind: 'needs-account', access: 'needs_sign_in' },
    });
  });

  it('intercepts a guest picking a credit-routed native model', () => {
    // Gateway-only rows alone would be insufficient: the expensive models are
    // native-registry rows that merely ROUTE through credits for a guest with
    // no provider login.
    expect(
      gate({
        model: GUEST_BLOCKED_NATIVE,
        availability: fundedGuest,
        isGuest: true,
      }),
    ).toEqual({
      kind: 'recoverable',
      recovery: { kind: 'needs-account', access: 'needs_sign_in' },
    });
  });

  it('leaves the shipped desktop AI-Credits default selectable', () => {
    // DECISION-0 REGRESSION TEST. `deepseek-v4-pro` is the first entry in
    // `CREDITS_LANE_DEFAULT_CANDIDATES`, i.e. the lane default in
    // ALREADY-SHIPPED desktop builds. Gating it would prompt every installed
    // guest client sitting on its own default, with no client update path.
    expect(
      gate({
        model: GUEST_ALLOWED_GATEWAY_ONLY,
        availability: fundedGuest,
        isGuest: true,
      }),
    ).toEqual({ kind: 'available' });
  });

  it('leaves the other allowlisted model selectable', () => {
    expect(
      gate({
        model: GUEST_ALLOWED_NATIVE,
        provider: 'codex',
        availability: fundedGuest,
        isGuest: true,
      }),
    ).toEqual({ kind: 'available' });
  });

  it('unwraps an Agent overlay to its base model before the allowlist check', () => {
    // An Agent model (`agent_model_*`) NEVER reaches a provider — every caller
    // unwraps it to `baseModel` first, so the LLM proxy sees the base model's
    // gateway id and allows the turn. Checking the raw `agent_model_*` id
    // against the allowlist would therefore refuse, on the client, a selection
    // the server accepts: a false block with no sign-in that can fix it.
    initAgentModels([
      {
        id: 'agent_model_luna',
        name: 'Luna Agent',
        baseModel: GUEST_ALLOWED_NATIVE,
        instructions: '',
        pluginSelections: emptyPluginSelections(),
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        available: true,
      },
      {
        id: 'agent_model_fable',
        name: 'Fable Agent',
        baseModel: GUEST_BLOCKED_NATIVE,
        instructions: '',
        pluginSelections: emptyPluginSelections(),
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        available: true,
      },
    ]);
    try {
      expect(
        gate({
          model: 'agent_model_luna',
          provider: 'codex',
          availability: fundedGuest,
          isGuest: true,
        }),
      ).toEqual({ kind: 'available' });
      // The converse still holds: an Agent over an EXPENSIVE base is gated.
      expect(
        gate({
          model: 'agent_model_fable',
          availability: fundedGuest,
          isGuest: true,
        }),
      ).toEqual({
        kind: 'recoverable',
        recovery: { kind: 'needs-account', access: 'needs_sign_in' },
      });
    } finally {
      initAgentModels([]);
    }
  });

  it("keeps rendering the chat's own model, even a blocked one", () => {
    // Same exemption as cases E and 1b: a chat already stamped on a model must
    // keep showing its selection checked. The server decides whether the turn
    // runs.
    expect(
      gate({
        model: CLAUDE_GATEWAY_ONLY,
        currentModel: CLAUDE_GATEWAY_ONLY,
        availability: fundedGuest,
        isGuest: true,
      }),
    ).toEqual({ kind: 'available' });
  });

  it('never gates a guest on their own native provider login', () => {
    // Nothing is billed to Canopy here. Forcing an allowlisted model on this
    // guest would push them OFF a free subscription ONTO the hosted gateway.
    expect(
      gate({
        model: GUEST_BLOCKED_NATIVE,
        availability: avail({ nativeAuth: true, creditsEligible: true }),
        isGuest: true,
      }),
    ).toEqual({ kind: 'available' });
  });

  it('never gates a guest on local Ollama', () => {
    expect(
      gate({
        model: OLLAMA_MODEL,
        provider: 'ollama',
        availability: fundedGuest,
        isGuest: true,
      }),
    ).toEqual({ kind: 'available' });
  });

  it('never gates a guest on Cursor, which bills its own account', () => {
    // Cursor is paid for with the user's OWN Cursor account — the one provider
    // row the shared billing toggle does not govern (see the `provider !==
    // 'cursor'` carve-out in `notBillableToCredits`). Canopy pays nothing, so
    // there is nothing for an account gate to protect, and prompting here would
    // push a guest off a subscription they already have.
    expect(
      gate({
        model: 'cursor-default',
        provider: 'cursor',
        availability: avail({ nativeAuth: true, creditsEligible: true }),
        isGuest: true,
      }),
    ).toEqual({ kind: 'available' });
  });

  it('leaves a signed-out Cursor row exactly as it was before the guest gate', () => {
    // Without a Cursor login the row is ALREADY `hard-disabled` by CAN-2349's
    // billing-source rule. Asserted as guest-vs-member EQUALITY rather than a
    // literal, because the claim under test is that the guest gate changed
    // nothing here — not that this particular disabled reason is correct, which
    // is a different file's contract. A `needs-account` recovery leaking in
    // would both break the equality and replace a truthful "sign in to Cursor"
    // with a sign-in prompt for the wrong account.
    const cursorRow = {
      model: 'cursor-default',
      provider: 'cursor',
      availability: fundedGuest,
    } as const;

    expect(gate({ ...cursorRow, isGuest: true })).toEqual(
      gate({ ...cursorRow, isGuest: false }),
    );
    expect(gate({ ...cursorRow, isGuest: true })).toMatchObject({
      kind: 'hard-disabled',
      cause: 'no-billing-source',
    });
  });

  it("never gates a guest on the organization's own gateway contract", () => {
    // Billed under the organization's provider contract, not by Canopy.
    expect(
      gate({
        model: CLAUDE_ORG_GATEWAY,
        availability: fundedGuest,
        isGuest: true,
      }),
    ).toEqual({ kind: 'available' });
  });

  it('leaves the five config surfaces at zero diff', () => {
    // `gatingEnabled: false` — these write a CONFIG value, not a chat turn, so
    // a sign-in prompt that then commits a pipeline alias would be wrong.
    expect(
      gate({
        model: CLAUDE_GATEWAY_ONLY,
        gatingEnabled: false,
        availability: avail(),
        isGuest: true,
      }),
    ).toMatchObject({ kind: 'hard-disabled', cause: 'no-credits' });
  });

  it('treats an absent isGuest as not-a-guest', () => {
    // Every existing caller omits the field and must keep its behavior.
    expect(
      gate({ model: CLAUDE_GATEWAY_ONLY, availability: fundedGuest }),
    ).toEqual({ kind: 'available' });
  });

  it('keeps org policy and the harness lock ahead of the guest gate', () => {
    expect(
      gate({
        model: CLAUDE_GATEWAY_ONLY,
        availability: fundedGuest,
        isGuest: true,
        // Policy is keyed by the GATEWAY id for a routed model — see
        // `normalizeGovernedModelId`.
        modelPolicy: new Set([`vendor/${CLAUDE_GATEWAY_ONLY}`]),
      }),
    ).toMatchObject({ kind: 'hard-disabled', cause: 'org-policy' });

    expect(
      gate({
        model: CLAUDE_GATEWAY_ONLY,
        availability: fundedGuest,
        isGuest: true,
        lockedProvider: 'ollama',
        lockedHarness: 'codex',
      }),
    ).toMatchObject({ kind: 'hard-disabled', cause: 'locked-provider' });
  });
});

/**
 * CAN-4028 — the allowlist now also holds a signed-in account that has not
 * made a card purchase. Same scope as the guest gate: only selections Canopy
 * pays for, judged against the ONE allowlist.
 *
 * The allowlisted side iterates `GUEST_ALLOWED_MODELS` rather than naming ids,
 * so these cases follow the table and cannot quietly become a second policy
 * list. The locked side uses a model the table does not contain.
 */
describe('resolveModelRowGate — model library access (CAN-4028)', () => {
  /** Signed in, no provider login, spendable daily credits. */
  const fundedNonPayer = avail({ creditsEligible: true, nativeAuth: false });
  const NOT_ALLOWLISTED = GUEST_BLOCKED_NATIVE;

  beforeAll(() => {
    // Routes for every allowlisted model, derived from the table, plus the
    // one model that is deliberately not on it.
    initAiGatewayModels(
      [],
      [
        ...GUEST_ALLOWED_MODELS.map((model) => gatewayRoute(model.id, false)),
        gatewayRoute(NOT_ALLOWLISTED, false),
        gatewayRoute(CLAUDE_GATEWAY_ONLY, true),
      ],
    );
  });
  afterAll(() => {
    restoreGatewayRoutes();
  });

  it('never names the non-listed model in the allowlist', () => {
    // Guards the fixture: if this model were ever added to the table, every
    // "locked" assertion below would be testing nothing.
    expect(GUEST_ALLOWED_MODELS.map((model) => model.id)).not.toContain(
      NOT_ALLOWLISTED,
    );
  });

  describe.each(MODEL_LIBRARY_ACCESS_VALUES)('access %s', (access) => {
    it.each(GUEST_ALLOWED_MODELS.map((model) => model.id))(
      'leaves allowlisted %s available to a signed-in account',
      (model) => {
        expect(
          gate({
            model,
            provider: 'codex',
            availability: fundedNonPayer,
            libraryAccess: access,
          }),
        ).toEqual({ kind: 'available' });
      },
    );

    it.each(GUEST_ALLOWED_MODELS.map((model) => model.id))(
      'leaves allowlisted %s available to a guest',
      (model) => {
        expect(
          gate({
            model,
            provider: 'codex',
            availability: fundedNonPayer,
            isGuest: true,
            libraryAccess: access,
          }),
        ).toEqual({ kind: 'available' });
      },
    );

    it('keeps a funded guest restricted whatever the access value says', () => {
      // The funded-guest rule. Even `unlocked` — which the server never sends
      // for a guest — must not widen a guest's list.
      expect(
        gate({
          model: NOT_ALLOWLISTED,
          availability: fundedNonPayer,
          isGuest: true,
          libraryAccess: access,
        }),
      ).toEqual({
        kind: 'recoverable',
        recovery: {
          kind: 'needs-account',
          access:
            access === 'needs_sign_in_then_purchase'
              ? 'needs_sign_in_then_purchase'
              : 'needs_sign_in',
        },
      });
    });
  });

  it('locks a non-listed credit-routed model for a signed-in non-payer', () => {
    // Funded on purpose: daily credits are spendable and do not unlock, so
    // the lock has to sit ahead of the credits check.
    expect(
      gate({
        model: NOT_ALLOWLISTED,
        availability: fundedNonPayer,
        libraryAccess: 'needs_purchase',
      }),
    ).toEqual({ kind: 'recoverable', recovery: { kind: 'needs-purchase' } });
  });

  it('locks a non-listed gateway-only model for a signed-in non-payer', () => {
    expect(
      gate({
        model: CLAUDE_GATEWAY_ONLY,
        availability: fundedNonPayer,
        libraryAccess: 'needs_purchase',
      }),
    ).toEqual({ kind: 'recoverable', recovery: { kind: 'needs-purchase' } });
  });

  it('locks the explicit AI Credits route of a non-listed model', () => {
    // `requireCredits` is the per-row "bill this to AI Credits" pick. It is
    // Canopy-paid even for someone signed in to the provider.
    expect(
      gate({
        model: NOT_ALLOWLISTED,
        availability: avail({ creditsEligible: true, nativeAuth: true }),
        requireCredits: true,
        libraryAccess: 'needs_purchase',
      }),
    ).toEqual({ kind: 'recoverable', recovery: { kind: 'needs-purchase' } });
  });

  it.each(['unlocked', undefined] as const)(
    'renders no purchase lock for a signed-in account when access is %s',
    (access) => {
      // `undefined` is unknown: organization-owned work, a failed read, or an
      // older server. The server still enforces, so the client must not sell.
      expect(
        gate({
          model: NOT_ALLOWLISTED,
          availability: fundedNonPayer,
          ...(access ? { libraryAccess: access } : {}),
        }),
      ).toEqual({ kind: 'available' });
    },
  );

  it.each(['needs_sign_in', 'needs_sign_in_then_purchase'] as const)(
    'ignores a guest-shaped %s for a signed-in account',
    (access) => {
      // A value that has not caught up with a sign-in must not draw a lock a
      // sign-in cannot clear.
      expect(
        gate({
          model: NOT_ALLOWLISTED,
          availability: fundedNonPayer,
          libraryAccess: access,
        }),
      ).toEqual({ kind: 'available' });
    },
  );

  it('never locks a model run on the user’s own provider subscription', () => {
    // Not Canopy-paid, so not library-locked — the same carve-out the guest
    // gate makes.
    expect(
      gate({
        model: NOT_ALLOWLISTED,
        availability: avail({ creditsEligible: true, nativeAuth: true }),
        libraryAccess: 'needs_purchase',
      }),
    ).toEqual({ kind: 'available' });
  });

  it('never locks a local model', () => {
    expect(
      gate({
        model: OLLAMA_MODEL,
        provider: 'ollama',
        availability: fundedNonPayer,
        libraryAccess: 'needs_purchase',
      }),
    ).toEqual({ kind: 'available' });
  });

  it('lets organization policy outrank the purchase lock', () => {
    // A purchase cannot lift a policy block, so the row must keep the policy's
    // own reason rather than offer a remedy that would not work.
    expect(
      gate({
        model: NOT_ALLOWLISTED,
        availability: fundedNonPayer,
        libraryAccess: 'needs_purchase',
        // Policy is keyed by the gateway id for a routed model.
        modelPolicy: new Set([`vendor/${NOT_ALLOWLISTED}`]),
      }),
    ).toMatchObject({ kind: 'hard-disabled', cause: 'org-policy' });
  });

  it('lets the provider lock outrank the purchase lock', () => {
    expect(
      gate({
        model: NOT_ALLOWLISTED,
        availability: fundedNonPayer,
        libraryAccess: 'needs_purchase',
        lockedProvider: 'codex',
        lockedProviderReason: 'Stop the current turn, then switch.',
      }),
    ).toMatchObject({ kind: 'hard-disabled', cause: 'locked-provider' });
  });

  it('stays out of the configuration surfaces', () => {
    // They write a config value, not a chat turn, and never raise a recovery.
    expect(
      gate({
        model: NOT_ALLOWLISTED,
        availability: fundedNonPayer,
        libraryAccess: 'needs_purchase',
        gatingEnabled: false,
      }),
    ).toEqual({ kind: 'available' });
  });

  it("keeps rendering the chat's own model", () => {
    expect(
      gate({
        model: NOT_ALLOWLISTED,
        currentModel: NOT_ALLOWLISTED,
        availability: fundedNonPayer,
        libraryAccess: 'needs_purchase',
      }),
    ).toEqual({ kind: 'available' });
  });
});

/**
 * The exported predicate the row gate AND the billing-framework toggle both
 * call, so a picker id is judged against the same spelling the LLM proxy sees.
 */
describe('isGuestAllowedSelection (CAN-3026)', () => {
  afterEach(() => {
    initAgentModels([]);
  });

  it('admits both allowlist spellings', () => {
    expect(isGuestAllowedSelection(GUEST_ALLOWED_GATEWAY_ONLY)).toBe(true);
    expect(isGuestAllowedSelection(GUEST_ALLOWED_NATIVE)).toBe(true);
    expect(isGuestAllowedSelection(`vendor/${GUEST_ALLOWED_NATIVE}`)).toBe(
      false,
    );
  });

  it('refuses an expensive model and an absent selection', () => {
    expect(isGuestAllowedSelection(GUEST_BLOCKED_NATIVE)).toBe(false);
    expect(isGuestAllowedSelection(undefined)).toBe(false);
  });

  it('judges an Agent overlay by its base model', () => {
    initAgentModels([
      {
        id: 'agent_model_luna_helper',
        name: 'Luna Agent',
        baseModel: GUEST_ALLOWED_NATIVE,
        instructions: '',
        pluginSelections: emptyPluginSelections(),
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        available: true,
      },
    ]);
    expect(isGuestAllowedSelection('agent_model_luna_helper')).toBe(true);
  });

  it('refuses an Agent id that resolves to nothing', () => {
    // Fail-closed: an unregistered overlay unwraps to `undefined`, and the
    // server would refuse the turn too because no base model exists to send.
    expect(isGuestAllowedSelection('agent_model_unregistered')).toBe(false);
  });

  // CAN-3026 review round 2: what the PROXY judges is the resolved
  // `entry.gatewayId`, not the picker row id. They coincide only because the
  // seeded catalog spells both allowlisted models canonically — a registry
  // ALIAS row separates them, and the client would then refuse a selection the
  // server accepts, with no sign-in able to clear it.
  it('admits a row whose GATEWAY id is allowlisted even when its own id is not', () => {
    initAiGatewayModels(
      [
        {
          id: 'vendor-internal-luna',
          label: 'Luna (aliased)',
          recommendedHarness: 'codex',
          contextWindow: 1_000_000,
          supportsPromptCaching: false,
          supportedThinkingLevels: ['low', 'medium', 'high'],
          toolSchemaProfile: 'standard',
        },
      ],
      [
        {
          modelId: 'vendor-internal-luna',
          gatewayId: GUEST_ALLOWED_NATIVE,
          family: 'openai',
          recommendedHarness: 'codex',
          gatewayOnly: true,
          contextWindow: 1_000_000,
          supportsPromptCaching: false,
          supportedThinkingLevels: ['low', 'medium', 'high'],
          toolSchemaProfile: 'standard',
        },
      ],
    );

    expect(isGuestAllowedSelection('vendor-internal-luna')).toBe(true);
  });

  it('still refuses a row whose gateway id is NOT allowlisted', () => {
    initAiGatewayModels(
      [
        {
          id: 'vendor-internal-fable',
          label: 'Fable (aliased)',
          recommendedHarness: 'claude',
          contextWindow: 1_000_000,
          supportsPromptCaching: true,
          supportedThinkingLevels: ['low', 'medium', 'high'],
          toolSchemaProfile: 'standard',
        },
      ],
      [
        {
          modelId: 'vendor-internal-fable',
          gatewayId: 'anthropic/claude-fable-5.1',
          family: 'anthropic',
          recommendedHarness: 'claude',
          gatewayOnly: true,
          contextWindow: 1_000_000,
          supportsPromptCaching: true,
          supportedThinkingLevels: ['low', 'medium', 'high'],
          toolSchemaProfile: 'standard',
        },
      ],
    );

    expect(isGuestAllowedSelection('vendor-internal-fable')).toBe(false);
  });

  // Claude Haiku 5.5 is allowlisted by its gateway spelling only: the desktop
  // registry id `haiku` is deliberately NOT in `GUEST_ALLOWED_MODELS`, so the
  // row is admitted through its resolved gateway id, while its Claude siblings
  // stay refused.
  it('admits Haiku 5.5 by its gateway id and refuses Sonnet and Opus', () => {
    const claudeRoute = (
      modelId: string,
      gatewayId: string,
    ): GatewayRouteEntry => ({
      modelId,
      gatewayId,
      family: 'anthropic',
      recommendedHarness: 'claude',
      gatewayOnly: false,
      contextWindow: 200_000,
      supportsPromptCaching: true,
      supportedThinkingLevels: ['low', 'medium', 'high'],
      toolSchemaProfile: 'standard',
    });
    initAiGatewayModels(
      [],
      [
        claudeRoute('haiku', 'anthropic/claude-haiku-5.5'),
        claudeRoute('sonnet', 'anthropic/claude-sonnet-5.5'),
        claudeRoute('opus', 'anthropic/claude-opus-5.5'),
      ],
    );
    try {
      expect(isGuestAllowedSelection('haiku')).toBe(true);
      expect(isGuestAllowedSelection('sonnet')).toBe(false);
      expect(isGuestAllowedSelection('opus')).toBe(false);
    } finally {
      restoreGatewayRoutes();
    }
  });
});
