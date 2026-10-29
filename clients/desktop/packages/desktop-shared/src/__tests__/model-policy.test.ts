import {
  initAgentModels,
  initAiGatewayModels,
  initClaudeModels,
  initCursorModels,
  initModelAliases,
  type CanopyCloudAccountPublicState,
} from '../types';
import {
  isModelBlocked,
  isModelBlockedTriState,
  modelPolicyForOwner,
  resolveModelPolicy,
  resolveModelPolicyIndex,
} from '../lib/model-policy';

const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function accountWith(
  enforcedSettings?: CanopyCloudAccountPublicState['enforcedSettings'],
): CanopyCloudAccountPublicState {
  return {
    hasApiKey: true,
    authMode: 'oauth',
    credentialSource: 'oauth_desktop',
    capabilities: [],
    organizations: [],
    teams: [],
    storageAvailable: true,
    ...(enforcedSettings ? { enforcedSettings } : {}),
  };
}

describe('model policy', () => {
  it('selects only the work owner policy and keeps the union for an unknown owner', () => {
    const index = resolveModelPolicyIndex(
      accountWith([
        {
          organizationId: ORG_A.toUpperCase(),
          organizationName: 'Acme',
          policies: [
            {
              kind: 'model-policy',
              blockedModelIds: ['openai/gpt-5.6-sol'],
              reviewedModelIds: ['openai/gpt-5.6-sol'],
            },
          ],
        },
        {
          organizationId: ORG_B,
          organizationName: 'Globex',
          policies: [
            {
              kind: 'model-policy',
              blockedModelIds: [],
              reviewedModelIds: ['openai/gpt-5.6-sol'],
            },
          ],
        },
      ]),
    );

    expect(
      isModelBlocked(
        'openai/gpt-5.6-sol',
        modelPolicyForOwner(index, {
          kind: 'organization',
          organizationId: ORG_A,
        }),
      ),
    ).toBe(true);
    expect(
      isModelBlocked(
        'openai/gpt-5.6-sol',
        modelPolicyForOwner(index, {
          kind: 'organization',
          organizationId: ORG_B,
        }),
      ),
    ).toBe(false);
    expect(
      isModelBlocked(
        'openai/gpt-5.6-sol',
        modelPolicyForOwner(index, { kind: 'personal' }),
      ),
    ).toBe(false);
    expect(
      isModelBlocked(
        'openai/gpt-5.6-sol',
        modelPolicyForOwner(index, undefined),
      ),
    ).toBe(true);
  });

  it("exempts an organization gateway route only from that organization's policy", () => {
    initAiGatewayModels(
      [],
      [
        {
          modelId: 'acme-model',
          gatewayId: 'anthropic/acme-model',
          family: 'custom',
          recommendedHarness: 'claude',
          gatewayOnly: true,
          contextWindow: 200_000,
          supportsPromptCaching: true,
          supportedThinkingLevels: [],
          toolSchemaProfile: 'standard',
          origin: 'org-gateway',
          baseUrl: 'https://gateway.acme.test',
          organizationId: ORG_A,
          promptCachePassthrough: true,
        },
      ],
    );
    const index = resolveModelPolicyIndex(
      accountWith([
        {
          organizationId: ORG_A,
          organizationName: 'Acme',
          policies: [
            {
              kind: 'model-policy',
              blockedModelIds: ['anthropic/acme-model'],
              reviewedModelIds: ['anthropic/acme-model'],
            },
          ],
        },
        {
          organizationId: ORG_B,
          organizationName: 'Globex',
          policies: [
            { kind: 'model-policy', blockedModelIds: [], reviewedModelIds: [] },
          ],
        },
      ]),
    );

    const acmePolicy = modelPolicyForOwner(index, {
      kind: 'organization',
      organizationId: ORG_A,
    });
    const globexPolicy = modelPolicyForOwner(index, {
      kind: 'organization',
      organizationId: ORG_B,
    });
    expect(isModelBlocked('acme-model', acmePolicy)).toBe(false);
    expect(isModelBlockedTriState('acme-model', acmePolicy, true)).toBe(false);
    expect(isModelBlocked('acme-model', globexPolicy)).toBe(true);
    expect(isModelBlockedTriState('acme-model', globexPolicy, true)).toBe(true);
    expect(isModelBlocked('acme-model', index.union)).toBe(true);
    expect(isModelBlockedTriState('acme-model', index.union, true)).toBe(true);
  });
  it.each(['thinking=true', 'thinking=false'])(
    'preserves persisted Cursor policy identity before discovery: %s',
    (variant) => {
      initCursorModels([]);
      const id = `cursor:${encodeURIComponent(`claude-opus-5[${variant}]`)}`;
      const allowed = resolveModelPolicy(
        accountWith([
          {
            organizationId: 'org-1',
            organizationName: 'Acme',
            policies: [
              {
                kind: 'model-policy',
                reviewedModelIds: ['anthropic/claude-opus-5'],
                blockedModelIds: [],
              },
            ],
          },
        ]),
      );
      expect(isModelBlocked(id, allowed)).toBe(false);
      expect(isModelBlocked(id, new Set(['anthropic/claude-opus-5']))).toBe(
        true,
      );
    },
  );
  it('governs a supported Cursor variant by its canonical native identity', () => {
    initClaudeModels([
      { id: 'opus', label: 'Opus', gatewayId: 'anthropic/claude-opus-5' },
    ]);
    const rawModelId = 'claude-opus-5[thinking=true]';
    const id = `cursor:${encodeURIComponent(rawModelId)}`;
    initCursorModels([{ id, rawModelId, label: 'Cursor Opus' }]);
    try {
      expect(isModelBlocked(id, new Set(['anthropic/claude-opus-5']))).toBe(
        true,
      );
    } finally {
      initCursorModels([]);
    }
  });
  beforeEach(() => {
    initClaudeModels([
      {
        id: 'opus',
        label: 'Opus',
        gatewayId: 'anthropic/claude-opus-5',
      },
    ]);
    initModelAliases({ 'legacy-opus': 'opus' });
    initAgentModels([
      {
        id: 'agent_model_reviewer',
        name: 'Reviewer',
        baseModel: 'opus',
        instructions: '',
        pluginSelections: { collectionIds: [] },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        available: true,
      },
    ]);
  });
  it('does not block without an enforced policy or without a model', () => {
    expect(isModelBlocked('gpt-5.6-sol', resolveModelPolicy(null))).toBe(false);
    expect(isModelBlocked(undefined, resolveModelPolicy(accountWith()))).toBe(
      false,
    );
  });

  it('blocks explicit denials and unreviewed governed models', () => {
    const policy = resolveModelPolicy(
      accountWith([
        {
          organizationId: ORG_A,
          organizationName: 'Acme',
          policies: [
            {
              kind: 'model-policy',
              blockedModelIds: ['openai/gpt-5.6-sol'],
              reviewedModelIds: ['openai/gpt-5.6-sol'],
            },
          ],
        },
      ]),
    );

    expect(isModelBlocked('openai/gpt-5.6-sol', policy)).toBe(true);
    expect(isModelBlocked('openai/gpt-5.6-terra', policy)).toBe(true);
  });

  it('allows reviewed models and never governs local Ollama ids', () => {
    const policy = resolveModelPolicy(
      accountWith([
        {
          organizationId: ORG_A,
          organizationName: 'Acme',
          policies: [
            {
              kind: 'model-policy',
              blockedModelIds: [],
              reviewedModelIds: ['openai/gpt-5.6-sol'],
            },
          ],
        },
      ]),
    );

    expect(isModelBlocked('openai/gpt-5.6-sol', policy)).toBe(false);
    expect(isModelBlocked('ollama-llama3:8b', policy)).toBe(false);
  });

  it('never governs a model the organization serves from its own gateway', () => {
    // An org that enforces BOTH a model policy and a model gateway used to
    // block its own gateway models: `/api/account/model-catalog` lists only
    // Canopy's hosted catalog plus native-only ids, so a row the admin
    // authored in the gateway card can never appear in the policy card, can
    // never be ticked, and is therefore permanently unreviewed. The renderer
    // then strips those models AND their routes from the registry, leaving an
    // enforcing org with no usable model at all.
    //
    // Publishing a model to the org's own gateway IS the admin's review. Same
    // carve-out shape as local Ollama ids above.
    initAiGatewayModels(
      [],
      [
        {
          modelId: 'org-1-sonnet-5',
          gatewayId: 'anthropic/claude-sonnet-5',
          family: 'custom',
          recommendedHarness: 'claude',
          gatewayOnly: true,
          contextWindow: 1_000_000,
          supportsPromptCaching: true,
          supportedThinkingLevels: [],
          toolSchemaProfile: 'standard',
          origin: 'org-gateway',
          baseUrl: 'https://ai-gateway.vercel.sh',
          organizationId: ORG_A,
          promptCachePassthrough: true,
        },
      ],
    );
    const policy = resolveModelPolicy(
      accountWith([
        {
          organizationId: ORG_A,
          organizationName: 'Acme',
          policies: [
            {
              kind: 'model-policy',
              blockedModelIds: [],
              // Deliberately does not mention the gateway model: it cannot.
              reviewedModelIds: ['anthropic/claude-opus-5'],
            },
          ],
        },
      ]),
    );

    expect(isModelBlocked('org-1-sonnet-5', policy)).toBe(false);
    expect(isModelBlockedTriState('org-1-sonnet-5', policy, true)).toBe(false);
    // The carve-out is for the org's OWN route, not a blanket amnesty: a
    // native model this policy has not reviewed is still blocked.
    expect(isModelBlocked('opus', policy)).toBe(false);
    expect(isModelBlocked('gpt-5.6-sol', policy)).toBe(true);
  });

  it('uses prohibition-wins semantics across organizations', () => {
    const policy = resolveModelPolicy(
      accountWith([
        {
          organizationId: 'org-1',
          organizationName: 'Acme',
          policies: [
            {
              kind: 'model-policy',
              blockedModelIds: [],
              reviewedModelIds: ['openai/gpt-5.6-sol'],
            },
          ],
        },
        {
          organizationId: 'org-2',
          organizationName: 'Globex',
          policies: [
            {
              kind: 'model-policy',
              blockedModelIds: [],
              reviewedModelIds: [],
            },
          ],
        },
      ]),
    );

    expect(isModelBlocked('openai/gpt-5.6-sol', policy)).toBe(true);
  });

  it('compares aliases and Agent wrappers after unwrapping', () => {
    const policy = resolveModelPolicy(
      accountWith([
        {
          organizationId: 'org-1',
          organizationName: 'Acme',
          policies: [
            {
              kind: 'model-policy',
              blockedModelIds: [],
              reviewedModelIds: ['anthropic/claude-opus-5'],
            },
          ],
        },
      ]),
    );
    expect(isModelBlocked('legacy-opus', policy)).toBe(false);
    expect(isModelBlocked('agent_model_reviewer', policy)).toBe(false);
  });

  it('judges an Agent that inherits the default only once it is pinned', () => {
    initClaudeModels([
      { id: 'opus', label: 'Opus', gatewayId: 'anthropic/claude-opus-5' },
      { id: 'haiku', label: 'Haiku', gatewayId: 'anthropic/claude-haiku-5' },
    ]);
    initAgentModels([
      {
        id: 'agent_model_inherit',
        name: 'Inherit',
        baseModel: 'default',
        instructions: '',
        pluginSelections: { collectionIds: [] },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        available: true,
      },
    ]);
    const policy = resolveModelPolicy(
      accountWith([
        {
          organizationId: 'org-1',
          organizationName: 'Acme',
          policies: [
            {
              kind: 'model-policy',
              blockedModelIds: [],
              reviewedModelIds: ['anthropic/claude-opus-5'],
            },
          ],
        },
      ]),
    );
    expect(isModelBlocked('agent_model_inherit', policy)).toBe(false);
    expect(isModelBlocked('agent_model_inherit@opus', policy)).toBe(false);
    expect(isModelBlocked('agent_model_inherit@haiku', policy)).toBe(true);
  });

  it('keeps gateway and native-only stored id spaces disjoint', () => {
    expect('anthropic/claude-opus-5').toContain('/');
    expect('gpt-5.3-codex-spark').not.toContain('/');
  });

  it('does not mistake a cold gateway-only id for an unreviewed model', () => {
    const policy = resolveModelPolicy(
      accountWith([
        {
          organizationId: 'org-1',
          organizationName: 'Acme',
          policies: [
            {
              kind: 'model-policy',
              blockedModelIds: [],
              reviewedModelIds: ['deepseek/deepseek-v4-pro'],
            },
          ],
        },
      ]),
    );

    expect(
      isModelBlockedTriState('deepseek-v4-pro', policy, false),
    ).toBeUndefined();
    expect(isModelBlockedTriState('deepseek-v4-pro', policy, true)).toBe(true);
  });

  it('blocks an unreviewed canonical NATIVE id even on a cold gateway catalog', () => {
    // A native id with no alias also satisfies `governedId === modelId` with no
    // gateway entry, so the cold-catalog deferral used to answer UNKNOWN for it
    // — and `resolveDefaultModelLane` treats UNKNOWN as allowed, seeding an
    // enforcing-org member onto an org-blocked native model. Hydrating the
    // route catalog can never re-govern a native id, so there is nothing to
    // defer for.
    initClaudeModels([
      { id: 'opus', label: 'Opus', gatewayId: 'anthropic/claude-opus-5' },
      { id: 'claude-haiku-4-5-20251001', label: 'Haiku' },
    ]);
    const policy = resolveModelPolicy(
      accountWith([
        {
          organizationId: 'org-1',
          organizationName: 'Acme',
          policies: [
            {
              kind: 'model-policy',
              blockedModelIds: [],
              reviewedModelIds: ['anthropic/claude-opus-5'],
            },
          ],
        },
      ]),
    );

    expect(
      isModelBlockedTriState('claude-haiku-4-5-20251001', policy, false),
    ).toBe(true);
    expect(
      isModelBlockedTriState('claude-haiku-4-5-20251001', policy, true),
    ).toBe(true);
    // A reviewed native id is still allowed on a cold catalog.
    expect(isModelBlockedTriState('opus', policy, false)).toBe(false);
  });
});
