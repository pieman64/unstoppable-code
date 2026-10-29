import {
  initAiGatewayModels,
  initClaudeModels,
  initCodexModels,
  initCopilotModels,
  initOpenCodeModels,
} from '../types';
import { toCopilotModelId } from '../lib/copilot-models';
import { toOpenCodeModelId } from '../lib/opencode-models';
import { buildModelCatalogOption } from '../lib/model-catalog-projection';
import { replaceModelFamilyMetadata } from '../model-config';

describe.each(['copilot', 'opencode'] as const)(
  '%s model presentation',
  (harness) => {
    const raw =
      harness === 'copilot'
        ? 'claude-sonnet-5.5'
        : 'anthropic/claude-sonnet-5-5';
    const idFor = harness === 'copilot' ? toCopilotModelId : toOpenCodeModelId;
    const init = harness === 'copilot' ? initCopilotModels : initOpenCodeModels;
    const entry = (
      rawModelId: string,
    ): Parameters<typeof initCopilotModels>[0][number] => ({
      id: idFor(rawModelId),
      rawModelId,
      label: 'Account model',
      contextWindow: 128_000,
      supportsVision: true,
      supportedThinkingLevels: ['high' as const],
    });
    const project = (
      rawModelId: string,
    ): ReturnType<typeof buildModelCatalogOption> =>
      buildModelCatalogOption(idFor(rawModelId), { provider: harness });

    beforeEach(() => {
      initClaudeModels([
        {
          id: 'sonnet',
          label: 'Sonnet 5.5',
          gatewayId: 'anthropic/claude-sonnet-5.5',
        },
      ]);
      initCodexModels([]);
      initAiGatewayModels([], []);
      init([entry(raw)]);
      replaceModelFamilyMetadata([
        {
          id: 'sonnet',
          family: 'sonnet',
          familyLabel: 'Sonnet',
          vendor: 'anthropic',
        },
      ]);
    });
    afterEach(() => {
      init([]);
      replaceModelFamilyMetadata([]);
    });

    it('projects one display identity while retaining the account route and capabilities', () => {
      expect(project(raw)).toMatchObject({
        id: idFor(raw),
        canonicalModelId: 'sonnet',
        vendor: 'anthropic',
        provider: harness,
        source: harness,
        harness,
        contextWindow: 128_000,
        supportedThinkingLevels: ['high'],
      });
    });
    it('merges an exact hosted model without requiring Cursor-specific metadata', () => {
      initAiGatewayModels(
        [
          {
            id: 'gemini-3.1-pro',
            label: 'Gemini 3.1 Pro',
            recommendedHarness: 'codex',
            contextWindow: 200_000,
            supportsPromptCaching: false,
            supportedThinkingLevels: [],
            toolSchemaProfile: 'standard',
          },
        ],
        [],
      );
      const rawModelId =
        harness === 'copilot' ? 'gemini-3.1-pro' : 'google/gemini-3.1-pro';
      init([entry(rawModelId)]);
      expect(project(rawModelId)).toMatchObject({
        canonicalModelId: 'gemini-3.1-pro',
        vendor: 'google',
        provider: harness,
      });
    });
    it('does not merge variants or infer identity from the label', () => {
      const variant = `${raw}-fast`;
      init([{ ...entry(variant), label: 'Sonnet 5.5' }]);
      expect(project(variant)).toMatchObject({ vendor: 'anthropic' });
      expect(project(variant)).not.toHaveProperty('canonicalModelId');
    });
    it('does not merge ambiguous native aliases', () => {
      initClaudeModels([
        {
          id: 'sonnet',
          label: 'Sonnet',
          gatewayId: 'anthropic/claude-sonnet-5.5',
        },
        {
          id: 'another-sonnet',
          label: 'Sonnet',
          gatewayId: 'anthropic/claude-sonnet-5.5',
        },
      ]);
      expect(project(raw)).not.toHaveProperty('canonicalModelId');
    });
    it('refreshes presentation when discovery or the native catalog changes', () => {
      expect(project(raw)).toHaveProperty('canonicalModelId', 'sonnet');
      init([]);
      expect(project(raw)).not.toHaveProperty('canonicalModelId');
      init([entry(raw)]);
      initClaudeModels([
        {
          id: 'sonnet',
          label: 'Next Sonnet',
          gatewayId: 'anthropic/claude-sonnet-6',
        },
      ]);
      expect(project(raw)).not.toHaveProperty('canonicalModelId');
    });
  },
);

it('keeps two OpenCode accounts for the same model independently selectable', () => {
  initCodexModels([{ id: 'gpt-5.5', label: 'GPT 5.5' }]);
  const entries = ['openai/gpt-5.5', 'github-copilot/gpt-5.5'].map(
    (rawModelId) => ({
      id: toOpenCodeModelId(rawModelId),
      rawModelId,
      label: 'GPT 5.5',
      supportsVision: false,
      supportedThinkingLevels: [],
    }),
  );
  initOpenCodeModels(entries);
  try {
    for (const entry of entries) {
      const option = buildModelCatalogOption(entry.id, {
        provider: 'opencode',
      });
      expect(option).toMatchObject({ id: entry.id, vendor: 'openai' });
      expect(option).not.toHaveProperty('canonicalModelId');
    }
  } finally {
    initOpenCodeModels([]);
  }
});
