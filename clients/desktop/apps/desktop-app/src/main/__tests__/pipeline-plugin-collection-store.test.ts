import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let preferencesFilePath = '';

jest.mock('../lib/paths', () => ({
  getPipelinePluginPreferencesFilePath: jest.fn(() => preferencesFilePath),
}));

import {
  deletePipelineModelAliasPreferences,
  deletePipelinePluginCollectionPreferences,
  loadPipelineModelAliasPreferences,
  loadPipelinePluginCollectionPreferences,
  normalizePipelineModelAliasPreferences,
  savePipelineModelAliasPreferences,
  savePipelinePluginCollectionPreferences,
} from '../pipelines/plugin-collection-store';
import {
  savePipelineModelAliasPreferences as saveSharedPipelineModelAliasPreferences,
  savePipelinePluginCollectionPreferences as saveSharedPipelinePluginCollectionPreferences,
} from '@canopy/desktop-shared/node/pipelines/plugin-collection-store';
import { resetResolvedCanopyDataDirForTests } from '@canopy/desktop-shared/canopy-paths';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readPersistedEntries(filePath: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!isRecord(parsed) || !isRecord(parsed.entries)) {
    throw new Error('Expected persisted pipeline preference entries');
  }
  return parsed.entries;
}

describe('pipeline plugin collection store', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-pipeline-plugin-store-'),
    );
    preferencesFilePath = path.join(
      tempDir,
      'pipeline-plugin-preferences.json',
    );
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('loads legacy stored locator preferences for source-qualified locators', () => {
    fs.writeFileSync(
      preferencesFilePath,
      `${JSON.stringify(
        {
          version: 1,
          entries: {
            'stored:plan-review': {
              implementer_plugins: {
                disabledDefaultKeys: ['skill:builtin:app:reviewer'],
                extraSelections: {
                  collectionIds: ['bundle-a'],
                },
              },
            },
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    expect(
      loadPipelinePluginCollectionPreferences({
        type: 'stored',
        source: 'user',
        value: 'plan-review',
      }),
    ).toMatchObject({
      implementer_plugins: {
        disabledDefaultKeys: ['skill:builtin:app:reviewer'],
        extraSelections: {
          collectionIds: ['bundle-a'],
        },
      },
    });
  });

  it('rewrites legacy stored locator entries to the source-qualified key on save', () => {
    fs.writeFileSync(
      preferencesFilePath,
      `${JSON.stringify(
        {
          version: 1,
          entries: {
            'stored:plan-review': {
              implementer_plugins: {
                disabledDefaultKeys: ['legacy-key'],
                extraSelections: {},
              },
            },
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    savePipelinePluginCollectionPreferences(
      {
        type: 'stored',
        source: 'user',
        value: 'plan-review',
      },
      {
        implementer_plugins: {
          disabledDefaultKeys: ['new-key'],
          extraSelections: {
            collectionIds: ['bundle-b'],
            skillRefs: [],
            pluginRefs: [],
            mcpServerRefs: [],
            mcpHttpAuthPreferences: [],
          },
        },
      },
    );

    const entries = readPersistedEntries(preferencesFilePath);
    expect(entries['stored:plan-review']).toBeUndefined();
    expect(entries['stored:user:plan-review']).toMatchObject({
      plugin_collections: {
        implementer_plugins: {
          disabledDefaultKeys: ['new-key'],
          extraSelections: {
            collectionIds: ['bundle-b'],
          },
        },
      },
    });
  });

  it('preserves legacy plugin preferences when saving model aliases', () => {
    fs.writeFileSync(
      preferencesFilePath,
      `${JSON.stringify(
        {
          version: 2,
          entries: {
            'stored:plan-review': {
              plugin_collections: {
                implementer_plugins: {
                  disabledDefaultKeys: ['legacy-key'],
                  extraSelections: {
                    collectionIds: ['bundle-a'],
                    skillRefs: [],
                    pluginRefs: [],
                    mcpServerRefs: [],
                    mcpHttpAuthPreferences: [],
                  },
                },
              },
              model_aliases: {
                reviewer: { mode: 'inline', base: 'claude-legacy' },
              },
            },
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const locator = {
      type: 'stored' as const,
      source: 'user' as const,
      value: 'plan-review',
    };
    savePipelineModelAliasPreferences(locator, {
      reviewer: { mode: 'agent', agent_id: 'agent_model_reviewer' },
    });

    expect(loadPipelinePluginCollectionPreferences(locator)).toMatchObject({
      implementer_plugins: {
        disabledDefaultKeys: ['legacy-key'],
        extraSelections: {
          collectionIds: ['bundle-a'],
        },
      },
    });
    expect(loadPipelineModelAliasPreferences(locator)).toEqual({
      reviewer: { mode: 'agent', agent_id: 'agent_model_reviewer' },
    });
    const entries = readPersistedEntries(preferencesFilePath);
    expect(entries['stored:plan-review']).toBeUndefined();
    expect(entries['stored:user:plan-review']).toMatchObject({
      plugin_collections: {
        implementer_plugins: {
          disabledDefaultKeys: ['legacy-key'],
        },
      },
      model_aliases: {
        reviewer: { mode: 'agent', agent_id: 'agent_model_reviewer' },
      },
    });
  });

  it('deletes both legacy and source-qualified stored locator entries', () => {
    fs.writeFileSync(
      preferencesFilePath,
      `${JSON.stringify(
        {
          version: 1,
          entries: {
            'stored:plan-review': {
              implementer_plugins: {
                disabledDefaultKeys: ['legacy-key'],
                extraSelections: {},
              },
            },
            'stored:user:plan-review': {
              implementer_plugins: {
                disabledDefaultKeys: ['new-key'],
                extraSelections: {},
              },
            },
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    deletePipelinePluginCollectionPreferences({
      type: 'stored',
      source: 'user',
      value: 'plan-review',
    });

    const entries = readPersistedEntries(preferencesFilePath);
    expect(entries).toEqual({});
  });

  it('normalizes model alias preferences and strips reset entries on save', () => {
    const normalized = normalizePipelineModelAliasPreferences({
      reviewer: {
        mode: 'inline',
        base: ' claude-sonnet-4-6 ',
        instructions: 'Review.',
        plugin_collection_id: ' review_tools ',
      },
      agent: {
        mode: 'agent',
        agent_id: 'agent_model_reviewer',
      },
      reset_me: { mode: 'reset' },
      invalid: { mode: 'inline', base: '' },
    });

    expect(normalized).toEqual({
      reviewer: {
        mode: 'inline',
        base: 'claude-sonnet-4-6',
        instructions: 'Review.',
        plugin_collection_id: 'review_tools',
      },
      agent: {
        mode: 'agent',
        agent_id: 'agent_model_reviewer',
      },
    });

    const locator = { type: 'file' as const, value: '/tmp/pipeline.yaml' };
    savePipelineModelAliasPreferences(locator, {
      reviewer: { mode: 'inline', base: 'claude-sonnet-4-6' },
      reset_me: { mode: 'reset' },
    });

    expect(loadPipelineModelAliasPreferences(locator)).toEqual({
      reviewer: { mode: 'inline', base: 'claude-sonnet-4-6' },
    });
    expect(readPersistedEntries(preferencesFilePath)).toEqual({
      'file:/tmp/pipeline.yaml': {
        model_aliases: {
          reviewer: { mode: 'inline', base: 'claude-sonnet-4-6' },
        },
      },
    });
  });

  it('loads, saves, and deletes model alias preferences without touching plugin preferences', () => {
    const locator = {
      type: 'stored' as const,
      source: 'user' as const,
      value: 'plan-review',
    };
    savePipelinePluginCollectionPreferences(locator, {
      tools: {
        disabledDefaultKeys: [],
        extraSelections: {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [],
          mcpHttpAuthPreferences: [],
        },
      },
    });
    savePipelineModelAliasPreferences(locator, {
      reviewer: { mode: 'agent', agent_id: 'agent_model_reviewer' },
    });

    expect(loadPipelineModelAliasPreferences(locator)).toEqual({
      reviewer: { mode: 'agent', agent_id: 'agent_model_reviewer' },
    });

    deletePipelineModelAliasPreferences(locator);

    expect(loadPipelineModelAliasPreferences(locator)).toEqual({});
    expect(loadPipelinePluginCollectionPreferences(locator)).toHaveProperty(
      'tools',
    );
  });

  it('main and shared stores produce identical v2 file contents', () => {
    const previousDataDir = process.env.CANOPY_DATA_DIR;
    const locator = { type: 'file' as const, value: '/tmp/pipeline.yaml' };
    const mainPath = path.join(tempDir, 'main-preferences.json');
    preferencesFilePath = mainPath;
    savePipelinePluginCollectionPreferences(locator, {
      tools: {
        disabledDefaultKeys: ['default-a'],
        extraSelections: {
          collectionIds: ['bundle-a'],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [],
          mcpHttpAuthPreferences: [],
        },
      },
    });
    savePipelineModelAliasPreferences(locator, {
      reviewer: { mode: 'inline', base: 'claude-sonnet-4-6' },
    });
    const mainContents = fs.readFileSync(mainPath, 'utf8');

    const sharedDataDir = path.join(tempDir, 'shared-data');
    process.env.CANOPY_DATA_DIR = sharedDataDir;
    resetResolvedCanopyDataDirForTests();
    try {
      saveSharedPipelinePluginCollectionPreferences(locator, {
        tools: {
          disabledDefaultKeys: ['default-a'],
          extraSelections: {
            collectionIds: ['bundle-a'],
            skillRefs: [],
            pluginRefs: [],
            mcpServerRefs: [],
            mcpHttpAuthPreferences: [],
          },
        },
      });
      saveSharedPipelineModelAliasPreferences(locator, {
        reviewer: { mode: 'inline', base: 'claude-sonnet-4-6' },
      });
      const sharedContents = fs.readFileSync(
        path.join(sharedDataDir, 'pipeline-plugin-preferences.json'),
        'utf8',
      );
      expect(sharedContents).toBe(mainContents);
    } finally {
      if (previousDataDir === undefined) {
        delete process.env.CANOPY_DATA_DIR;
      } else {
        process.env.CANOPY_DATA_DIR = previousDataDir;
      }
      resetResolvedCanopyDataDirForTests();
    }
  });
});
