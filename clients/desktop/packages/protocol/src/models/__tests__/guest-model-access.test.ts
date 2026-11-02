import {
  GUEST_ALLOWED_MODELS,
  GUEST_DEFAULT_MODEL_ID,
  formatGuestAllowedModelLabels,
  isGuestAllowedModelId,
} from '../guest-model-access';
import { resolveGuestAllowedModelForGatewayId } from '..';

describe('guest model allowlist', () => {
  describe('accepted spellings', () => {
    const accepted = [
      'gpt-6-luna',
      'openai/gpt-6-luna',
      'gpt-5.6-luna',
      'openai/gpt-5.6-luna',
      'deepseek-v4-pro',
      'deepseek/deepseek-v4-pro',
      'claude-haiku-5.5',
      'anthropic/claude-haiku-5.5',
    ];

    it.each(accepted)('admits %s', (modelId) => {
      expect(isGuestAllowedModelId(modelId)).toBe(true);
    });

    it.each(accepted)('admits %s with surrounding whitespace', (modelId) => {
      expect(isGuestAllowedModelId(`  ${modelId}\n`)).toBe(true);
    });

    it.each(accepted)('admits %s case-insensitively', (modelId) => {
      expect(isGuestAllowedModelId(modelId.toUpperCase())).toBe(true);
    });
  });

  describe('fails closed', () => {
    it('refuses undefined', () => {
      expect(isGuestAllowedModelId(undefined)).toBe(false);
    });

    it('refuses the empty string', () => {
      expect(isGuestAllowedModelId('')).toBe(false);
      expect(isGuestAllowedModelId('   ')).toBe(false);
    });

    // The proxy reads `model` off an untrusted JSON body, so these are real
    // runtime inputs. `isGuestAllowedModelId` takes `unknown` so they can be
    // passed directly, without the casts the repository's no-type-casting rule
    // forbids — testing the actual API rather than a coerced view of it.
    it('refuses a non-string', () => {
      const notAString: unknown = { id: 'gpt-5.6-luna' };
      expect(isGuestAllowedModelId(notAString)).toBe(false);
      expect(isGuestAllowedModelId(null)).toBe(false);
      expect(isGuestAllowedModelId(12345)).toBe(false);
      expect(isGuestAllowedModelId(['gpt-5.6-luna'])).toBe(false);
      expect(isGuestAllowedModelId(true)).toBe(false);
    });

    // Every one of these is a spelling some normalization rule would have
    // admitted. They are the reason the match is exact.
    it.each([
      'gpt-5.6-sol',
      'gpt-5.6-luna[1m]',
      'other-vendor/gpt-5.6-luna',
      'openai/openai/gpt-5.6-luna',
      'gpt-5.6-luna-pro',
      'deepseek-v4-flash',
      'deepseek/deepseek-v4-pro-max',
      'agent_model_gpt-5.6-luna',
      'agent_model_deepseek-v4-pro',
      'anthropic/claude-fable-5.1',
      'claude-fable-5.1',
      'other-vendor/gpt-6-luna',
      'gpt-6-luna[1m]',
      'gpt-6.1-luna',
      'gpt-6-sol',
      'agent_model_gpt-6-luna',
      // Desktop and Cursor spellings of Haiku: callers resolve the gateway id.
      'haiku',
      'claude-haiku-5-5',
      'claude-haiku-5.5[1m]',
      'other-vendor/claude-haiku-5.5',
      'anthropic/claude-haiku-4.5',
      'anthropic/claude-sonnet-5.5',
      'agent_model_claude-haiku-5.5',
    ])('refuses the near-miss %s', (modelId) => {
      expect(isGuestAllowedModelId(modelId)).toBe(false);
    });

    it('refuses a newly added gateway model until it is added here', () => {
      // The closed-allowlist invariant: new gateway capacity is signed-in only
      // by default. If this ever passes, the allowlist stopped being closed.
      expect(isGuestAllowedModelId('acme/acme-mega-9')).toBe(false);
      expect(isGuestAllowedModelId('acme-mega-9')).toBe(false);
    });
  });

  describe('table invariants', () => {
    it('spells every id and gatewayId in lowercase', () => {
      // The lookup set is built by flatMap over this table and compared against
      // a lowercased input, so an uppercase literal would be unmatchable.
      for (const model of GUEST_ALLOWED_MODELS) {
        expect(model.id).toBe(model.id.toLowerCase());
        expect(model.gatewayId).toBe(model.gatewayId.toLowerCase());
      }
    });

    it('spells every gatewayId once', () => {
      // Desktop resolves a registry model from each gatewayId when it walks the
      // allowlist, so a duplicate would make that reverse lookup ambiguous.
      const gatewayIds = GUEST_ALLOWED_MODELS.map((model) => model.gatewayId);
      expect(new Set(gatewayIds).size).toBe(gatewayIds.length);
    });

    it('admits both spellings of every table entry', () => {
      for (const model of GUEST_ALLOWED_MODELS) {
        expect(isGuestAllowedModelId(model.id)).toBe(true);
        expect(isGuestAllowedModelId(model.gatewayId)).toBe(true);
      }
    });

    it('pins GPT 6 Luna as the default and allows it', () => {
      expect(GUEST_DEFAULT_MODEL_ID).toBe('gpt-6-luna');
      expect(
        GUEST_ALLOWED_MODELS.some(
          (model) => model.id === GUEST_DEFAULT_MODEL_ID,
        ),
      ).toBe(true);
      expect(isGuestAllowedModelId(GUEST_DEFAULT_MODEL_ID)).toBe(true);
    });

    it('keeps GPT 5.6 Luna for shipped desktop builds that fall back to it', () => {
      expect(isGuestAllowedModelId('gpt-5.6-luna')).toBe(true);
    });

    it('keeps the shipped desktop AI-Credits lane default reachable', () => {
      // Decision 0: `deepseek-v4-pro` is the first CREDITS_LANE_DEFAULT_CANDIDATE
      // in already-shipped desktop builds. Dropping it bricks installed clients.
      expect(isGuestAllowedModelId('deepseek-v4-pro')).toBe(true);
    });
  });

  describe('formatGuestAllowedModelLabels', () => {
    it('renders the labels as a disjunction', () => {
      expect(formatGuestAllowedModelLabels()).toBe(
        'GPT 6 Luna, GPT 5.6 Luna, DeepSeek V4 Pro or Claude Haiku 5.5',
      );
    });
  });

  describe('resolveGuestAllowedModelForGatewayId', () => {
    it.each([
      [
        'anthropic/claude-opus-5',
        'anthropic/claude-haiku-5.5',
        'Claude Haiku 5.5',
      ],
      ['openai/gpt-6-sol', 'openai/gpt-6-luna', 'GPT 6 Luna'],
      [
        'deepseek/deepseek-v4-flash',
        'deepseek/deepseek-v4-pro',
        'DeepSeek V4 Pro',
      ],
    ])(
      'prefers the first allowed sibling for %s',
      (gatewayId, preferredId, label) => {
        const preferred = GUEST_ALLOWED_MODELS.find(
          (model) => model.gatewayId === preferredId,
        );
        expect(preferred).toBeDefined();
        expect(resolveGuestAllowedModelForGatewayId(gatewayId)).toBe(preferred);
        expect(resolveGuestAllowedModelForGatewayId(gatewayId)?.label).toBe(
          label,
        );
        expect(isGuestAllowedModelId(gatewayId)).toBe(false);
      },
    );

    it('prefers GPT 6 Luna even for the legacy allowed OpenAI model', () => {
      expect(
        resolveGuestAllowedModelForGatewayId('openai/gpt-5.6-luna')?.id,
      ).toBe('gpt-6-luna');
    });

    it.each([
      [' \tANTHROPIC/CLAUDE-OPUS-5\n', 'claude-haiku-5.5'],
      [' OPENAI/GPT-6-SOL ', 'gpt-6-luna'],
      ['\nDeepSeek/DeepSeek-V4-Flash\t', 'deepseek-v4-pro'],
    ])('normalizes the gateway spelling %p', (gatewayId, preferredId) => {
      expect(resolveGuestAllowedModelForGatewayId(gatewayId)?.id).toBe(
        preferredId,
      );
    });

    const invalidInputs: readonly unknown[] = [
      undefined,
      null,
      12345,
      true,
      { gatewayId: 'anthropic/claude-opus-5' },
      ['anthropic/claude-opus-5'],
      '',
      ' \t\n',
      'haiku',
      'claude-opus-5',
      'gpt-6-luna',
      '/',
      '/claude-opus-5',
      'anthropic/',
      'anthropic/ \t',
      'anthropic//claude-opus-5',
      'anthropic/claude-opus-5/',
      'anthropic/claude-opus-5/variant',
      'openai/openai/gpt-6-sol',
      'unknown/claude-opus-5',
      'anthropic-other/claude-opus-5',
      'other-vendor/gpt-6-luna',
    ];

    it.each(invalidInputs)(
      'has no preference for invalid or unknown input %p',
      (gatewayId) => {
        expect(resolveGuestAllowedModelForGatewayId(gatewayId)).toBeUndefined();
      },
    );

    it('keeps every allowlist gateway ID structurally valid and resolvable', () => {
      for (const model of GUEST_ALLOWED_MODELS) {
        expect(model.gatewayId).toMatch(/^[^/\s]+\/[^/\s]+$/);
        expect(
          resolveGuestAllowedModelForGatewayId(model.gatewayId),
        ).toBeDefined();
      }
    });
  });
});
