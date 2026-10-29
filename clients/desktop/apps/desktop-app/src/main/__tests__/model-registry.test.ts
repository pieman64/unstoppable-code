import {
  initAgentModels,
  initClaudeModels,
  initCodexModels,
  initModelAliases,
  initOllamaModels,
} from '@canopy/desktop-shared/types';
import { replaceModelFamilyMetadata } from '@canopy/desktop-shared/model-config';

jest.mock('../ollama', () => ({
  getOllamaService: (): { getCachedModels: () => [] } => ({
    getCachedModels: () => [],
  }),
}));

import { getSynchronousModelRegistrySnapshot } from '../models/model-registry';

describe('model registry snapshot descriptions', () => {
  afterEach(() => {
    initClaudeModels([]);
    initCodexModels([]);
    initOllamaModels([]);
    initAgentModels([]);
    initModelAliases({});
    replaceModelFamilyMetadata([]);
  });

  it('preserves explicit Cursor identities across the main-to-renderer snapshot', () => {
    initClaudeModels([
      Object.assign(
        { id: 'claude-alias', label: 'Claude Alias' },
        {
          cursorModelId: 'cursor-claude',
        },
      ),
    ]);
    initCodexModels([
      Object.assign(
        { id: 'codex-alias', label: 'Codex Alias' },
        {
          cursorModelId: 'cursor-codex',
        },
      ),
    ]);
    const snapshot = getSynchronousModelRegistrySnapshot();
    expect(snapshot.claude[0]).toMatchObject({
      cursorModelId: 'cursor-claude',
    });
    expect(snapshot.codex[0]).toMatchObject({ cursorModelId: 'cursor-codex' });
  });

  it('preserves descriptions across the main-to-renderer snapshot seam', () => {
    initClaudeModels([
      {
        id: 'described-claude',
        label: 'Described Claude',
        description: 'A configured Claude description.',
      },
    ]);
    initCodexModels([
      {
        id: 'described-codex',
        label: 'Described Codex',
        description: 'A configured Codex description.',
      },
    ]);

    const snapshot = getSynchronousModelRegistrySnapshot();

    expect(snapshot.claude[0]).toMatchObject({
      id: 'described-claude',
      description: 'A configured Claude description.',
    });
    expect(snapshot.codex[0]).toMatchObject({
      id: 'described-codex',
      description: 'A configured Codex description.',
    });
  });

  it('preserves package-owned Codex family metadata without classifying the ID', () => {
    const entries = [
      {
        id: 'deepseek-v4-pro',
        label: 'DeepSeek V4 Pro',
        family: 'codex',
        familyLabel: 'Codex',
        vendor: 'openai',
        sortOrder: 80,
        gateway: {
          gatewayId: 'deepseek/deepseek-v4-pro',
          family: 'deepseek',
          recommendedHarness: 'codex',
          gatewayOnly: true,
          contextWindow: 128_000,
          supportsPromptCaching: false,
          supportedThinkingLevels: ['low', 'high'],
          toolSchemaProfile: 'standard',
        },
      },
    ];
    initCodexModels(entries);
    replaceModelFamilyMetadata(entries);

    const snapshot = getSynchronousModelRegistrySnapshot();

    expect(snapshot.codex[0]).toMatchObject({
      id: 'deepseek-v4-pro',
      family: 'codex',
      familyLabel: 'Codex',
      vendor: 'openai',
      sortOrder: 80,
    });
  });
});
