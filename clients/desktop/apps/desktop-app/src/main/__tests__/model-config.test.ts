import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const mockAppPath = jest.fn(() => process.cwd());
const claudeFamily = {
  family: 'claude',
  familyLabel: 'Claude',
  vendor: 'anthropic',
  sortOrder: 10,
};
const codexFamily = {
  family: 'codex',
  familyLabel: 'Codex',
  vendor: 'openai',
  sortOrder: 20,
};

jest.mock('electron', () => ({
  app: {
    getAppPath: (): string => mockAppPath(),
  },
}));

jest.mock('../ollama', () => ({
  getOllamaService: (): {
    getCachedModels: () => [];
    getModelRegistrySnapshot: () => { ollama: [] };
  } => ({
    getCachedModels: (): [] => [],
    getModelRegistrySnapshot: (): { ollama: [] } => ({ ollama: [] }),
  }),
}));

import {
  CLAUDE_MODELS,
  CODEX_MODELS,
  initClaudeModels,
  initCodexModels,
  initModelAliases,
  initCursorModels,
  isCodexModel,
  resolveKnownModel,
} from '@canopy/desktop-shared/types';
import {
  getAuthoritativeConfiguredModel,
  listAuthoritativeConfiguredModels,
  loadModelsFromPackageJson,
  updateOrgGatewayModelCatalog,
} from '../lib/model-config';
import { getSynchronousModelRegistrySnapshot } from '../models/model-registry';

describe('desktop model configuration', () => {
  let temporary: string | undefined;

  it('uses the current Cursor catalog for exact model IDs and thinking levels without caching stale discoveries', () => {
    loadModelsFromPackageJson({ 'canopy-desktop-cursor-harness': true });
    initCursorModels([
      {
        id: 'cursor:review-model',
        rawModelId: 'review-model',
        label: 'Cursor reviewer',
        supportedThinkingLevels: ['low', 'high'],
      },
    ]);
    expect(
      getAuthoritativeConfiguredModel('cursor:review-model'),
    ).toMatchObject({
      id: 'cursor:review-model',
      defaultHarness: 'cursor',
      enabled: true,
      supportedThinkingLevels: ['low', 'high'],
    });
    expect(
      listAuthoritativeConfiguredModels().some(
        (model) => model.id === 'cursor-default',
      ),
    ).toBe(true);
    initCursorModels([]);
    expect(
      getAuthoritativeConfiguredModel('cursor:review-model'),
    ).toBeUndefined();
    expect(getAuthoritativeConfiguredModel('cursor-default')).toMatchObject({
      supportedThinkingLevels: [],
    });
    loadModelsFromPackageJson({ 'canopy-desktop-cursor-harness': false });
    expect(getAuthoritativeConfiguredModel('cursor-default')).toMatchObject({
      enabled: false,
    });
  });

  afterEach(async () => {
    updateOrgGatewayModelCatalog([]);
    mockAppPath.mockReturnValue(process.cwd());
    if (temporary) await rm(temporary, { recursive: true, force: true });
    temporary = undefined;
    initClaudeModels([]);
    initCodexModels([]);
    initCursorModels([]);
    initModelAliases({});
  });

  it('retains hidden and disabled definitions for authoritative lookup without exposing them for selection', async () => {
    temporary = await mkdtemp(path.join(tmpdir(), 'delegation-model-catalog-'));
    mockAppPath.mockReturnValue(temporary);
    await writeFile(
      path.join(temporary, 'package.json'),
      JSON.stringify({
        'claude-code': {
          models: [
            { ...claudeFamily, id: 'visible', label: 'Visible' },
            {
              ...claudeFamily,
              id: 'hidden',
              label: 'Hidden',
              sortOrder: 20,
              selectable: false,
              supportedThinkingLevels: ['low', 'high'],
            },
            {
              ...claudeFamily,
              id: 'disabled',
              label: 'Disabled',
              sortOrder: 30,
              featureFlag: 'canopy-shared-claude-model-fable5',
            },
          ],
        },
        codex: {
          models: [
            {
              ...codexFamily,
              id: 'hidden-codex',
              label: 'Hidden Codex',
              selectable: false,
            },
          ],
        },
      }),
    );
    loadModelsFromPackageJson({ 'canopy-shared-claude-model-fable5': false });
    expect(CLAUDE_MODELS).toEqual(['visible']);
    expect(getAuthoritativeConfiguredModel('hidden')).toMatchObject({
      id: 'hidden',
      defaultHarness: 'claude',
      modelSource: 'claude-managed',
      enabled: true,
      selectable: false,
      supportedThinkingLevels: ['low', 'high'],
    });
    expect(getAuthoritativeConfiguredModel('hidden-codex')).toMatchObject({
      defaultHarness: 'codex',
      selectable: false,
    });
    expect(getAuthoritativeConfiguredModel('disabled')).toMatchObject({
      enabled: false,
      selectable: false,
    });
    expect(getAuthoritativeConfiguredModel('missing')).toBeUndefined();
    const inventory = listAuthoritativeConfiguredModels();
    expect(inventory.map((model) => model.id)).toEqual(
      expect.arrayContaining(['visible', 'hidden', 'disabled', 'hidden-codex']),
    );
    expect(inventory.find((model) => model.id === 'disabled')?.enabled).toBe(
      false,
    );
    const publicSnapshot = getSynchronousModelRegistrySnapshot();
    expect(publicSnapshot.claude.map((entry) => entry.id)).toEqual(['visible']);
    expect(publicSnapshot.codex).toEqual([]);
  });

  it('replaces authoritative lookup on refresh while retained descriptors remain immutable', async () => {
    temporary = await mkdtemp(path.join(tmpdir(), 'delegation-model-catalog-'));
    mockAppPath.mockReturnValue(temporary);
    await writeFile(
      path.join(temporary, 'package.json'),
      JSON.stringify({
        'claude-code': {
          models: [
            {
              ...claudeFamily,
              id: 'retained',
              label: 'Original',
              selectable: false,
              supportedThinkingLevels: ['low'],
            },
          ],
        },
      }),
    );
    loadModelsFromPackageJson({});
    const retained = getAuthoritativeConfiguredModel('retained');
    expect(retained).toMatchObject({ label: 'Original' });
    await writeFile(
      path.join(temporary, 'package.json'),
      JSON.stringify({
        'claude-code': {
          models: [
            { ...claudeFamily, id: 'replacement', label: 'Replacement' },
          ],
        },
      }),
    );
    loadModelsFromPackageJson({});
    expect(getAuthoritativeConfiguredModel('retained')).toBeUndefined();
    expect(
      listAuthoritativeConfiguredModels().some(
        (model) => model.id === 'retained',
      ),
    ).toBe(false);
    expect(retained).toMatchObject({
      label: 'Original',
      selectable: false,
      supportedThinkingLevels: ['low'],
    });
    expect(Object.isFrozen(retained)).toBe(true);
    expect(Object.isFrozen(retained?.supportedThinkingLevels)).toBe(true);
  });

  it('refreshes authoritative lookup when the organization gateway changes', () => {
    loadModelsFromPackageJson({});
    expect(
      getAuthoritativeConfiguredModel('organization-model'),
    ).toBeUndefined();

    updateOrgGatewayModelCatalog([
      {
        organizationId: 'org-1',
        organizationName: 'Acme',
        baseUrl: 'https://gateway.acme.test',
        promptCachePassthrough: true,
        models: [
          {
            id: 'organization-model',
            gatewayId: 'provider/model',
            label: 'Organization Model',
            harness: 'codex',
            contextWindow: 131_072,
            supportedThinkingLevels: ['high'],
            toolSchemaProfile: 'standard',
          },
        ],
      },
    ]);

    expect(getAuthoritativeConfiguredModel('organization-model')).toMatchObject(
      {
        id: 'organization-model',
        label: 'Organization Model',
        modelSource: 'ai-gateway',
        defaultHarness: 'codex',
        supportedThinkingLevels: ['off', 'high'],
      },
    );
  });

  it('registers Fable 5.1 without the legacy Fable 5 feature flag', () => {
    loadModelsFromPackageJson({
      'canopy-shared-claude-model-fable5': false,
    });

    expect(CLAUDE_MODELS).toContain('claude-fable-5-1');
  });

  it('resolves retired GPT 5.4 selections to their GPT 6 successors', () => {
    loadModelsFromPackageJson();

    expect(CODEX_MODELS).not.toContain('gpt-5.4');
    expect(CODEX_MODELS).not.toContain('gpt-5.4-mini');
    expect(resolveKnownModel('gpt-5.4')).toBe('gpt-6-sol');
    expect(resolveKnownModel('gpt-5.4-mini')).toBe('gpt-6-luna');
    expect(isCodexModel('gpt-5.4')).toBe(true);
    expect(isCodexModel('gpt-5.4-mini')).toBe(true);
    expect(getSynchronousModelRegistrySnapshot().aliases).toMatchObject({
      'gpt-5.4': 'gpt-6-sol',
      'gpt-5.4-mini': 'gpt-6-luna',
    });
  });

  it('preserves model family metadata in renderer registry snapshots', () => {
    loadModelsFromPackageJson({
      'canopy-shared-claude-model-fable5': true,
    });

    const snapshot = getSynchronousModelRegistrySnapshot();
    const fable = snapshot.claude.find(
      (entry) => entry.id === 'claude-fable-5-1',
    );

    expect(fable).toMatchObject({
      label: 'Fable 5.1',
      family: 'claude',
      familyLabel: 'Claude',
      vendor: 'anthropic',
      sortOrder: 10,
      extraChargeOnly: true,
      extraChargeMessage:
        'Depending on your Claude plan, this model may require extra usage credits',
    });
    expect(fable?.showMoreOnly).toBeUndefined();
    expect(fable?.featureFlag).toBeUndefined();
  });

  it('registers More-menu models under their harness families', () => {
    loadModelsFromPackageJson({});

    const snapshot = getSynchronousModelRegistrySnapshot();
    const claudeLegacyModels = snapshot.claude
      .filter((entry) => entry.showMoreOnly)
      .map((entry) => [entry.id, entry.familyLabel]);
    const codexLegacyModels = snapshot.codex
      .filter((entry) => entry.showMoreOnly)
      .map((entry) => [entry.id, entry.familyLabel]);

    expect(claudeLegacyModels).toEqual([
      ['claude-fable-5', 'Claude'],
      ['claude-opus-5', 'Claude'],
      ['claude-sonnet-5', 'Claude'],
      ['claude-opus-4-8', 'Claude'],
      ['claude-opus-4-7', 'Claude'],
      ['claude-opus-4-6', 'Claude'],
      ['claude-haiku-4-5-20251001', 'Claude'],
    ]);
    expect(codexLegacyModels).toEqual([
      ['gpt-6-sol', 'Codex'],
      ['gpt-5.6-sol', 'Codex'],
      ['gpt-5.6-luna', 'Codex'],
    ]);
  });
});
