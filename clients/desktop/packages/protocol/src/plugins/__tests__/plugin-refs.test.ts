import {
  getShareablePluginRefKey,
  isShareablePluginRef,
  isValidGitHubRepoRef,
  normalizeGitHubRepoRef,
  normalizePluginName,
  normalizeShareablePluginRef,
  normalizeShareableSource,
  normalizeSkillName,
  serializeShareableSource,
  pluginSharePath,
  type ShareableClaudePluginRef,
  type ShareableCodexPluginRef,
  type ShareableDynamicPluginRef,
  type ShareableSkillRef,
} from '../index';
import {
  buildDesktopShareDeepLink,
  parseDesktopShareDeepLink,
  publicShareSnapshotApiPath,
} from '../../share-deep-link';

const SHARE_UUID = '2f0c9a1e-4b3d-4f6a-8c2e-1d5b7a9e0c4f';

describe('shared plugin paths', () => {
  it('uses the canonical plugin share and snapshot paths', () => {
    expect(pluginSharePath(SHARE_UUID)).toBe(
      `/portal/plugins/plugins/shared/${SHARE_UUID}`,
    );
    expect(
      publicShareSnapshotApiPath('desktop-app', 'plugin', SHARE_UUID),
    ).toBe(`/api/v1/desktop-app/public-shares/plugins/${SHARE_UUID}`);
  });

  it('round-trips plugin desktop share deep links', () => {
    const url = buildDesktopShareDeepLink({
      scheme: 'canopy',
      entity: 'plugin',
      externalId: SHARE_UUID,
    });
    expect(parseDesktopShareDeepLink(url, 'canopy')).toEqual({
      entity: 'plugin',
      externalId: SHARE_UUID,
      intent: 'install',
    });
  });
});

describe('normalizeGitHubRepoRef', () => {
  it('lowercases owner/name segments', () => {
    expect(normalizeGitHubRepoRef('OwnerName/RepoName')).toBe(
      'ownername/reponame',
    );
  });

  it('trims whitespace', () => {
    expect(normalizeGitHubRepoRef('  acme/skills  ')).toBe('acme/skills');
  });

  it.each([
    '',
    'owner',
    '/repo',
    'owner/',
    'owner/repo/sub',
    'https://github.com/owner/repo',
    'git@github.com:owner/repo',
  ])('rejects malformed ref: %s', (ref) => {
    expect(() => normalizeGitHubRepoRef(ref)).toThrow();
  });

  it('isValidGitHubRepoRef matches normalizeGitHubRepoRef behaviour', () => {
    expect(isValidGitHubRepoRef('owner/repo')).toBe(true);
    expect(isValidGitHubRepoRef('https://example.com')).toBe(false);
    expect(isValidGitHubRepoRef(42)).toBe(false);
  });
});

describe('normalizeShareableSource', () => {
  it('collapses builtin sources to the canonical id', () => {
    expect(
      normalizeShareableSource({ type: 'builtin', id: 'whatever' }),
    ).toEqual({
      type: 'builtin',
      id: 'app',
    });
  });

  it('normalizes github repo refs', () => {
    expect(
      normalizeShareableSource({ type: 'github', repo: 'OwnerName/Repo' }),
    ).toEqual({ type: 'github', repo: 'ownername/repo' });
  });
});

describe('serializeShareableSource', () => {
  it('builds stable keys', () => {
    expect(serializeShareableSource({ type: 'builtin', id: 'app' })).toBe(
      'builtin:app',
    );
    expect(
      serializeShareableSource({ type: 'github', repo: 'Acme/Skills' }),
    ).toBe('github:acme/skills');
  });
});

describe('skill / plugin name validators', () => {
  it.each(['valid-name', 'valid_name', 'name123'])('accepts %s', (name) => {
    expect(normalizeSkillName(name)).toBe(name);
    expect(normalizePluginName(name)).toBe(name);
  });

  it.each(['', '   ', 'has space', 'has/slash', 'has\\backslash'])(
    'rejects %s',
    (name) => {
      expect(() => normalizeSkillName(name)).toThrow();
      expect(() => normalizePluginName(name)).toThrow();
    },
  );
});

describe('getShareablePluginRefKey', () => {
  it('builds case-insensitive keys for skills and plugins', () => {
    const skill: ShareableSkillRef = {
      type: 'skill',
      source: { type: 'builtin', id: 'canopy' },
      skill_name: 'Commit-Messages',
    };
    expect(getShareablePluginRefKey(skill)).toBe(
      'skill:builtin:app:commit-messages',
    );

    const plugin: ShareableClaudePluginRef = {
      type: 'claude_plugin',
      marketplace: { type: 'github', repo: 'UD/Marketplace' },
      plugin_name: 'Browser',
    };
    expect(getShareablePluginRefKey(plugin)).toBe(
      'claude_plugin:github:ud/marketplace:browser',
    );
  });

  it('builds builtin:app keys for built-in marketplace plugins', () => {
    const builtInPlugin: ShareableClaudePluginRef = {
      type: 'claude_plugin',
      marketplace: { type: 'builtin', id: 'app' },
      plugin_name: 'Example-Plugin',
    };
    expect(getShareablePluginRefKey(builtInPlugin)).toBe(
      'claude_plugin:builtin:app:example-plugin',
    );
  });

  it('builds keys for provider-neutral marketplace plugins', () => {
    const dynamicPlugin: ShareableDynamicPluginRef = {
      type: 'plugin',
      marketplace: { type: 'github', repo: 'UD/Marketplace' },
      plugin_name: 'Browser',
    };
    expect(getShareablePluginRefKey(dynamicPlugin)).toBe(
      'plugin:github:ud/marketplace:browser',
    );
  });

  it('collapses any built-in marketplace id in the key', () => {
    const builtInPlugin: ShareableClaudePluginRef = {
      type: 'claude_plugin',
      marketplace: { type: 'builtin', id: 'whatever' },
      plugin_name: 'example-plugin',
    };
    expect(getShareablePluginRefKey(builtInPlugin)).toBe(
      'claude_plugin:builtin:app:example-plugin',
    );
  });

  it('builds keys for Codex-native marketplace plugins', () => {
    const codexPlugin: ShareableCodexPluginRef = {
      type: 'codex_plugin',
      marketplace: { type: 'codex-builtin', id: 'OpenAI-Curated' },
      plugin_name: 'Codex-Security',
    };
    expect(getShareablePluginRefKey(codexPlugin)).toBe(
      'codex_plugin:codex-builtin:openai-curated:codex-security',
    );
  });
});

describe('normalizeShareablePluginRef', () => {
  it('canonicalizes nested sources', () => {
    const result = normalizeShareablePluginRef({
      type: 'skill',
      source: { type: 'github', repo: 'Acme/Skills' },
      skill_name: 'my-skill',
    });
    expect(result).toEqual({
      type: 'skill',
      source: { type: 'github', repo: 'acme/skills' },
      skill_name: 'my-skill',
    });
  });

  it('throws on unknown discriminator', () => {
    expect(() =>
      normalizeShareablePluginRef({
        type: 'bogus',
      } as unknown as ShareableSkillRef),
    ).toThrow();
  });

  it('normalizes a built-in marketplace plugin to the canonical builtin app source', () => {
    const result = normalizeShareablePluginRef({
      type: 'claude_plugin',
      marketplace: { type: 'builtin', id: 'whatever' },
      plugin_name: 'Example-Plugin',
    });
    expect(result).toEqual({
      type: 'claude_plugin',
      marketplace: { type: 'builtin', id: 'app' },
      plugin_name: 'Example-Plugin',
    });
  });

  it('keeps github marketplace plugins unchanged after normalization', () => {
    const result = normalizeShareablePluginRef({
      type: 'claude_plugin',
      marketplace: { type: 'github', repo: 'UD/Marketplace' },
      plugin_name: 'browser',
    });
    expect(result).toEqual({
      type: 'claude_plugin',
      marketplace: { type: 'github', repo: 'ud/marketplace' },
      plugin_name: 'browser',
    });
  });

  it('normalizes provider-neutral marketplace plugins', () => {
    const result = normalizeShareablePluginRef({
      type: 'plugin',
      marketplace: { type: 'github', repo: 'UD/Marketplace' },
      plugin_name: 'browser',
    });
    expect(result).toEqual({
      type: 'plugin',
      marketplace: { type: 'github', repo: 'ud/marketplace' },
      plugin_name: 'browser',
    });
  });

  it('rejects claude_plugin refs with an unknown marketplace source', () => {
    expect(() =>
      normalizeShareablePluginRef({
        type: 'claude_plugin',
        marketplace: { type: 'local', path: '/tmp' },
        plugin_name: 'x',
      }),
    ).toThrow();
  });

  it('normalizes codex_plugin refs from Codex built-in marketplaces', () => {
    const result = normalizeShareablePluginRef({
      type: 'codex_plugin',
      marketplace: { type: 'codex-builtin', id: ' openai-curated ' },
      plugin_name: 'codex-security',
    });
    expect(result).toEqual({
      type: 'codex_plugin',
      marketplace: { type: 'codex-builtin', id: 'openai-curated' },
      plugin_name: 'codex-security',
    });
  });

  it('rejects codex_plugin refs with non-Codex marketplace sources', () => {
    expect(() =>
      normalizeShareablePluginRef({
        type: 'codex_plugin',
        marketplace: { type: 'github', repo: 'owner/repo' },
        plugin_name: 'x',
      }),
    ).toThrow();
  });
});

describe('isShareablePluginRef', () => {
  it('returns true for valid refs', () => {
    expect(
      isShareablePluginRef({
        type: 'skill',
        source: { type: 'builtin', id: 'canopy' },
        skill_name: 'a',
      }),
    ).toBe(true);
  });

  it('returns false for non-objects', () => {
    expect(isShareablePluginRef(null)).toBe(false);
    expect(isShareablePluginRef('skill')).toBe(false);
  });

  it('returns false when sub-fields are malformed', () => {
    expect(
      isShareablePluginRef({
        type: 'skill',
        source: { type: 'github', repo: 'no-slash' },
        skill_name: 'a',
      }),
    ).toBe(false);
  });
});
