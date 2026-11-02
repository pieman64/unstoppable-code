import { normalizePipeline } from '../normalize-pipeline';
import {
  buildPipelineDefaultDisplay,
  getPipelinePluginDefaultKey,
} from '../plugin-collections';
import type { PipelinePluginDefault } from '../../types/pipeline';

function buildPipeline(
  pluginDefault: unknown,
): Parameters<typeof normalizePipeline>[0] {
  return {
    name: 'Plugin Collections',
    on: 'dispatch',
    plugin_collections: [
      {
        id: 'defaults',
        name: 'Defaults',
        // The normalizer receives YAML-parsed data at runtime; this is the
        // explicit boundary that lets negative tests exercise malformed input.
        defaults: [pluginDefault as PipelinePluginDefault],
      },
    ],
    jobs: {
      build: {
        steps: [{ id: 'echo', run: 'echo ok' }],
      },
    },
  };
}

describe('normalizePipeline plugin_collections built-in plugin refs', () => {
  it('normalizes built-in marketplace Claude plugin defaults to builtin/app', () => {
    const normalized = normalizePipeline(
      buildPipeline({
        type: 'claude_plugin',
        marketplace: { type: 'builtin', id: 'anything' },
        plugin_name: 'example-plugin',
      }),
    );

    const pluginDefault = normalized.plugin_collections?.[0]?.defaults[0];
    if (!pluginDefault) {
      throw new Error('Expected normalized plugin default');
    }
    expect(pluginDefault).toEqual({
      type: 'claude_plugin',
      marketplace: { type: 'builtin', id: 'app' },
      plugin_name: 'example-plugin',
      required: false,
    });
    expect(getPipelinePluginDefaultKey(pluginDefault)).toBe(
      'claude_plugin:builtin:app:example-plugin',
    );
    expect(buildPipelineDefaultDisplay(pluginDefault)).toEqual({
      title: 'example-plugin',
      subtitle: 'Built-in (Canopy)',
    });
  });

  it('keeps GitHub marketplace Claude plugin defaults supported', () => {
    const normalized = normalizePipeline(
      buildPipeline({
        type: 'claude_plugin',
        marketplace: { type: 'github', repo: 'Owner/Plugins' },
        plugin_name: 'example-plugin',
      }),
    );

    expect(normalized.plugin_collections?.[0]?.defaults[0]).toMatchObject({
      type: 'claude_plugin',
      marketplace: { type: 'github', repo: 'owner/plugins' },
      plugin_name: 'example-plugin',
    });
  });

  it('rejects unknown marketplace sources with the portable-source error', () => {
    expect(() =>
      normalizePipeline(
        buildPipeline({
          type: 'claude_plugin',
          marketplace: { type: 'local', repo: 'owner/repo' },
          plugin_name: 'example-plugin',
        }),
      ),
    ).toThrow('marketplace must be builtin or github');
  });

  it('normalizes Codex-native plugin defaults from Codex built-in marketplaces', () => {
    const normalized = normalizePipeline(
      buildPipeline({
        type: 'codex_plugin',
        marketplace: { type: 'codex-builtin', id: ' openai-curated ' },
        plugin_name: 'codex-security',
        required: true,
      }),
    );

    const pluginDefault = normalized.plugin_collections?.[0]?.defaults[0];
    if (!pluginDefault) {
      throw new Error('Expected normalized plugin default');
    }
    expect(pluginDefault).toEqual({
      type: 'codex_plugin',
      marketplace: { type: 'codex-builtin', id: 'openai-curated' },
      plugin_name: 'codex-security',
      required: true,
    });
    expect(getPipelinePluginDefaultKey(pluginDefault)).toBe(
      'codex_plugin:codex-builtin:openai-curated:codex-security',
    );
    expect(buildPipelineDefaultDisplay(pluginDefault)).toEqual({
      title: 'codex-security',
      subtitle: 'Codex built-in (openai-curated)',
    });
  });

  it('rejects Codex-native plugin defaults from Claude marketplace sources', () => {
    expect(() =>
      normalizePipeline(
        buildPipeline({
          type: 'codex_plugin',
          marketplace: { type: 'github', repo: 'owner/repo' },
          plugin_name: 'codex-security',
        }),
      ),
    ).toThrow('marketplace must be codex-builtin for codex_plugin refs');
  });
});
