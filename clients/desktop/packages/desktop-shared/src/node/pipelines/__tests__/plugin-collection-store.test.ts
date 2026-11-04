import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resetResolvedCanopyDataDirForTests } from '../../../canopy-paths';
import {
  deletePipelineModelAliasPreferences,
  deletePipelinePluginCollectionPreferences,
  loadPipelineModelAliasPreferences,
  loadPipelinePluginCollectionPreferences,
  mergePipelineModelAliasPreferences,
  mergePipelinePluginCollectionPreferences,
  normalizePipelineModelAliasPreferences,
  PipelinePreferencesWriteRefusedError,
  prunePipelinePreferenceSelections,
  savePipelineModelAliasPreferences,
  savePipelinePluginCollectionPreferences,
} from '../plugin-collection-store';
import { writeFileAtomically } from '../../lib/atomic-file';

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
  const previousDataDir = process.env.CANOPY_DATA_DIR;
  let tempDir: string;
  let preferencesFilePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-pipeline-plugin-store-'),
    );
    process.env.CANOPY_DATA_DIR = tempDir;
    resetResolvedCanopyDataDirForTests();
    preferencesFilePath = path.join(
      tempDir,
      'pipeline-plugin-preferences.json',
    );
  });

  afterEach(() => {
    if (previousDataDir === undefined) {
      delete process.env.CANOPY_DATA_DIR;
    } else {
      process.env.CANOPY_DATA_DIR = previousDataDir;
    }
    resetResolvedCanopyDataDirForTests();
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

  it('rewrites legacy stored locator entries to the source-qualified key on save', async () => {
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

    await savePipelinePluginCollectionPreferences(
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
      'electron_main',
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

  it('preserves legacy plugin preferences when saving model aliases', async () => {
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
    await savePipelineModelAliasPreferences(
      locator,
      {
        reviewer: { mode: 'agent', agent_id: 'agent_model_reviewer' },
      },
      'electron_main',
    );

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

  it('deletes both legacy and source-qualified stored locator entries', async () => {
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

    await deletePipelinePluginCollectionPreferences(
      {
        type: 'stored',
        source: 'user',
        value: 'plan-review',
      },
      'electron_main',
    );

    const entries = readPersistedEntries(preferencesFilePath);
    expect(entries).toEqual({});
  });

  it('normalizes model alias preferences and strips reset entries on save', async () => {
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
    await savePipelineModelAliasPreferences(
      locator,
      {
        reviewer: { mode: 'inline', base: 'claude-sonnet-4-6' },
        reset_me: { mode: 'reset' },
      },
      'electron_main',
    );

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

  it('loads, saves, and deletes model alias preferences without touching plugin preferences', async () => {
    const locator = {
      type: 'stored' as const,
      source: 'user' as const,
      value: 'plan-review',
    };
    await savePipelinePluginCollectionPreferences(
      locator,
      {
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
      },
      'electron_main',
    );
    await savePipelineModelAliasPreferences(
      locator,
      {
        reviewer: { mode: 'agent', agent_id: 'agent_model_reviewer' },
      },
      'electron_main',
    );

    expect(loadPipelineModelAliasPreferences(locator)).toEqual({
      reviewer: { mode: 'agent', agent_id: 'agent_model_reviewer' },
    });

    await deletePipelineModelAliasPreferences(locator, 'electron_main');

    expect(loadPipelineModelAliasPreferences(locator)).toEqual({});
    expect(loadPipelinePluginCollectionPreferences(locator)).toHaveProperty(
      'tools',
    );
  });

  it('merges saved defaults collection by collection and alias by alias, and a reset removes an alias', async () => {
    const locator = { type: 'file' as const, value: '/tmp/pipeline.yaml' };
    const tools = {
      disabledDefaultKeys: ['a'],
      extraSelections: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
        mcpHttpAuthPreferences: [],
      },
    };
    await savePipelinePluginCollectionPreferences(
      locator,
      { tools, review: tools },
      'electron_main',
    );
    await savePipelineModelAliasPreferences(
      locator,
      { reviewer: { mode: 'inline', base: 'claude-a' } },
      'electron_main',
    );

    await mergePipelinePluginCollectionPreferences(
      locator,
      { review: { ...tools, disabledDefaultKeys: ['b'] } },
      'desktop_cli',
    );
    await mergePipelineModelAliasPreferences(
      locator,
      { planner: { mode: 'inline', base: 'claude-b' } },
      'desktop_cli',
    );
    await mergePipelineModelAliasPreferences(
      locator,
      { reviewer: { mode: 'reset' } },
      'desktop_cli',
    );

    expect(loadPipelinePluginCollectionPreferences(locator)).toEqual({
      tools,
      review: { ...tools, disabledDefaultKeys: ['b'] },
    });
    expect(loadPipelineModelAliasPreferences(locator)).toEqual({
      planner: { mode: 'inline', base: 'claude-b' },
    });
  });

  it('reads a damaged file as empty without changing it', () => {
    fs.writeFileSync(preferencesFilePath, '{"version": 2, "entries": {');

    expect(
      loadPipelineModelAliasPreferences({ type: 'file', value: '/a.yaml' }),
    ).toEqual({});
    expect(fs.readFileSync(preferencesFilePath, 'utf8')).toBe(
      '{"version": 2, "entries": {',
    );
    expect(fs.readdirSync(tempDir)).toEqual([
      'pipeline-plugin-preferences.json',
    ]);
  });

  it('copies a damaged file aside before replacing it', async () => {
    fs.writeFileSync(preferencesFilePath, '{"version": 2, "entries": {');
    const locator = { type: 'file' as const, value: '/a.yaml' };

    await savePipelineModelAliasPreferences(
      locator,
      { reviewer: { mode: 'inline', base: 'claude-a' } },
      'desktop_cli',
    );

    const copies = fs
      .readdirSync(tempDir)
      .filter((name) =>
        name.startsWith('pipeline-plugin-preferences.json.damaged-'),
      );
    expect(copies).toHaveLength(1);
    expect(fs.readFileSync(path.join(tempDir, copies[0]), 'utf8')).toBe(
      '{"version": 2, "entries": {',
    );
    expect(loadPipelineModelAliasPreferences(locator)).toEqual({
      reviewer: { mode: 'inline', base: 'claude-a' },
    });
  });

  it.each([
    ['the current layout', { version: 3, entries: {} }],
    ['a different layout', { version: 3, preferences: { saved: 'newer' } }],
  ])(
    'never writes over a file from a newer version with %s',
    async (_, value) => {
      const newer = `${JSON.stringify(value)}\n`;
      fs.writeFileSync(preferencesFilePath, newer);
      const locator = { type: 'file' as const, value: '/a.yaml' };

      expect(loadPipelineModelAliasPreferences(locator)).toEqual({});
      await expect(
        savePipelineModelAliasPreferences(
          locator,
          { reviewer: { mode: 'inline', base: 'claude-a' } },
          'electron_main',
        ),
      ).rejects.toMatchObject({
        name: PipelinePreferencesWriteRefusedError.name,
        reason: 'newer',
      });
      expect(fs.readFileSync(preferencesFilePath, 'utf8')).toBe(newer);
    },
  );

  it('never writes over a file it cannot read', async () => {
    fs.mkdirSync(preferencesFilePath);

    await expect(
      deletePipelineModelAliasPreferences(
        { type: 'file', value: '/a.yaml' },
        'desktop_cli',
      ),
    ).rejects.toMatchObject({ reason: 'unreadable' });
    expect(fs.statSync(preferencesFilePath).isDirectory()).toBe(true);
  });

  it('waits for a live writer in another process and reclaims its lock once that process is gone', async () => {
    const lockDir = path.join(tempDir, 'locks', 'pipeline-plugin-preferences');
    fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    const child = spawn(
      process.execPath,
      ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000);'],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    try {
      await once(child.stdout, 'data');
      fs.writeFileSync(
        path.join(lockDir, 'writer.lock'),
        JSON.stringify({
          version: 1,
          pid: child.pid,
          nonce: 'other-process',
          createdAt: new Date(0).toISOString(),
        }),
      );
      const locator = { type: 'file' as const, value: '/a.yaml' };
      let settled = false;
      const save = savePipelineModelAliasPreferences(
        locator,
        { reviewer: { mode: 'inline', base: 'claude-a' } },
        'electron_main',
      ).finally(() => {
        settled = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(settled).toBe(false);
      expect(fs.existsSync(preferencesFilePath)).toBe(false);

      const exited = once(child, 'exit');
      child.kill();
      await exited;
      await save;
      expect(loadPipelineModelAliasPreferences(locator)).toEqual({
        reviewer: { mode: 'inline', base: 'claude-a' },
      });
      expect(fs.readdirSync(lockDir)).toEqual([]);
    } finally {
      child.kill();
    }
  });

  it('refuses a write to the preference file from any other module', async () => {
    await expect(
      writeFileAtomically(preferencesFilePath, '{}', {
        admittedWriter: {
          namespace: 'pipeline_plugin_preferences',
          writer: 'desktop_cli',
          module: 'cli/commands/run',
        },
      }),
    ).rejects.toMatchObject({ reason: 'unadmitted_writer' });
    await expect(
      writeFileAtomically(preferencesFilePath, '{}'),
    ).rejects.toThrow();
    expect(fs.existsSync(preferencesFilePath)).toBe(false);
  });

  it('prunes selections through the writer lock and writes only when something changed', async () => {
    const locator = { type: 'file' as const, value: '/a.yaml' };
    await savePipelinePluginCollectionPreferences(
      locator,
      {
        tools: {
          disabledDefaultKeys: [],
          extraSelections: {
            collectionIds: [],
            skillRefs: [],
            pluginRefs: [
              { marketplaceId: 'acme', pluginName: 'gone' },
              { marketplaceId: 'acme', pluginName: 'kept' },
            ],
            mcpServerRefs: [],
            mcpHttpAuthPreferences: [],
          },
        },
      },
      'electron_main',
    );
    const before = fs.statSync(preferencesFilePath).mtimeMs;

    await prunePipelinePreferenceSelections(() => false, 'electron_main');
    expect(fs.statSync(preferencesFilePath).mtimeMs).toBe(before);

    await prunePipelinePreferenceSelections((entries) => {
      const changed = JSON.stringify(entries).includes('"gone"');
      for (const entry of Object.values(entries)) {
        if (!isRecord(entry) || !isRecord(entry.plugin_collections)) continue;
        const preference = entry.plugin_collections.tools;
        if (!isRecord(preference) || !isRecord(preference.extraSelections))
          continue;
        const refs = preference.extraSelections.pluginRefs;
        if (Array.isArray(refs))
          preference.extraSelections.pluginRefs = refs.filter(
            (ref: unknown) => !isRecord(ref) || ref.pluginName !== 'gone',
          );
      }
      return changed;
    }, 'electron_main');

    expect(
      loadPipelinePluginCollectionPreferences(locator).tools?.extraSelections
        .pluginRefs,
    ).toEqual([{ marketplaceId: 'acme', pluginName: 'kept' }]);
  });

  it('leaves a newer file alone when pruning selections', async () => {
    const newer = `${JSON.stringify({ version: 3, entries: {} })}\n`;
    fs.writeFileSync(preferencesFilePath, newer);

    await expect(
      prunePipelinePreferenceSelections(() => true, 'electron_main'),
    ).resolves.toBeUndefined();
    expect(fs.readFileSync(preferencesFilePath, 'utf8')).toBe(newer);
  });
});
