import {
  assertNoSecretLikeContent,
  containsSecretLikeContent,
  isPipelineDependencyStatusSatisfied,
  normalizePipelineDependency,
  PIPELINE_DEPENDENCY_ACTIONS,
  PIPELINE_DEPENDENCY_FALLBACKS,
  PIPELINE_DEPENDENCY_KINDS,
  PIPELINE_DEPENDENCY_STATUSES,
} from '../dependencies';

describe('pipeline dependency wire contract', () => {
  it('pins the dependency enums', () => {
    expect(PIPELINE_DEPENDENCY_KINDS).toEqual([
      'plugin',
      'skill',
      'mcp',
      'connector',
      'local_runtime',
      'local_package',
    ]);
    expect(PIPELINE_DEPENDENCY_FALLBACKS).toEqual([
      'block',
      'skip',
      'reduced',
      'queue',
      'alternative',
    ]);
    expect(PIPELINE_DEPENDENCY_STATUSES).toEqual([
      'installed',
      'connected',
      'not_installed',
      'needs_authorization',
      'update_required',
      'blocked_by_policy',
      'unavailable',
      'incompatible',
    ]);
    expect(PIPELINE_DEPENDENCY_ACTIONS).toEqual([
      'install',
      'connect',
      'authorize',
      'update',
      'choose_alternative',
    ]);
  });

  it('treats only installed and connected as satisfied', () => {
    expect(isPipelineDependencyStatusSatisfied('installed')).toBe(true);
    expect(isPipelineDependencyStatusSatisfied('connected')).toBe(true);
    expect(isPipelineDependencyStatusSatisfied('not_installed')).toBe(false);
    expect(isPipelineDependencyStatusSatisfied('needs_authorization')).toBe(
      false,
    );
    expect(isPipelineDependencyStatusSatisfied('blocked_by_policy')).toBe(
      false,
    );
  });
});

describe('normalizePipelineDependency', () => {
  const context = 'Pipeline dependencies[0]';

  it('normalizes a full mcp dependency', () => {
    expect(
      normalizePipelineDependency(
        {
          id: 'linear',
          kind: 'mcp',
          required: true,
          capability: 'Reads Linear issues',
          steps: ['fetch_issues'],
          server: { catalog_id: 'linear' },
          health_check: 'connection',
          privacy: 'Issue titles are sent to Linear',
          config_deferrable: true,
        },
        context,
      ),
    ).toEqual({
      id: 'linear',
      kind: 'mcp',
      required: true,
      fallback: 'block',
      capability: 'Reads Linear issues',
      steps: ['fetch_issues'],
      server: { catalog_id: 'linear' },
      health_check: 'connection',
      privacy: 'Issue titles are sent to Linear',
      config_deferrable: true,
    });
  });

  it('defaults required to false and fallback by requiredness', () => {
    const optional = normalizePipelineDependency(
      { id: 'gh', kind: 'local_package', package: { probe: 'gh' } },
      context,
    );
    expect(optional.required).toBe(false);
    expect(optional.fallback).toBe('skip');

    const required = normalizePipelineDependency(
      {
        id: 'gh',
        kind: 'local_package',
        required: true,
        package: { probe: 'gh' },
      },
      context,
    );
    expect(required.fallback).toBe('block');
  });

  it('normalizes plugin and skill refs through the portable-ref reader', () => {
    const dependency = normalizePipelineDependency(
      {
        id: 'browser',
        kind: 'plugin',
        ref: {
          type: 'plugin',
          marketplace: { type: 'github', repo: 'Owner/Marketplace' },
          plugin_name: 'browser',
        },
      },
      context,
    );
    if (dependency.kind !== 'plugin') {
      throw new Error('Expected a plugin dependency');
    }
    expect(dependency.ref).toEqual({
      type: 'plugin',
      marketplace: { type: 'github', repo: 'owner/marketplace' },
      plugin_name: 'browser',
    });
  });

  it('rejects kind/ref mismatches in both directions', () => {
    expect(() =>
      normalizePipelineDependency(
        {
          id: 'a',
          kind: 'skill',
          ref: {
            type: 'plugin',
            marketplace: { type: 'builtin', id: 'app' },
            plugin_name: 'browser',
          },
        },
        context,
      ),
    ).toThrow('kind "skill" requires a ref of type "skill"');

    expect(() =>
      normalizePipelineDependency(
        {
          id: 'a',
          kind: 'plugin',
          ref: {
            type: 'skill',
            source: { type: 'builtin', id: 'app' },
            skill_name: 'charting',
          },
        },
        context,
      ),
    ).toThrow('kind "plugin" requires a plugin ref, got a skill ref');
  });

  it('rejects unknown kinds and unexpected fields', () => {
    expect(() =>
      normalizePipelineDependency({ id: 'a', kind: 'wasm' }, context),
    ).toThrow('kind must be one of');
    expect(() =>
      normalizePipelineDependency(
        {
          id: 'a',
          kind: 'connector',
          connector: 'github',
          server: { catalog_id: 'x' },
        },
        context,
      ),
    ).toThrow('unexpected field "server"');
  });

  it('validates kind-specific targets', () => {
    expect(() =>
      normalizePipelineDependency(
        { id: 'a', kind: 'mcp', server: {} },
        context,
      ),
    ).toThrow('server catalog_id must be a non-empty string');
    expect(() =>
      normalizePipelineDependency(
        { id: 'a', kind: 'local_package', package: { probe: 'bin/gh' } },
        context,
      ),
    ).toThrow('package probe must be a bare executable name');
    expect(
      normalizePipelineDependency(
        {
          id: 'a',
          kind: 'local_package',
          package: { probe: 'gh', version_flag: '--version' },
        },
        context,
      ),
    ).toMatchObject({ package: { probe: 'gh', version_flag: '--version' } });
  });

  it('requires instructions when install mode is instructions', () => {
    expect(() =>
      normalizePipelineDependency(
        {
          id: 'a',
          kind: 'local_runtime',
          runtime: 'ollama',
          install: { mode: 'instructions' },
        },
        context,
      ),
    ).toThrow('install mode "instructions" requires install instructions');
    expect(
      normalizePipelineDependency(
        {
          id: 'a',
          kind: 'local_runtime',
          runtime: 'ollama',
          install: {
            mode: 'instructions',
            instructions: 'brew install ollama',
          },
        },
        context,
      ),
    ).toMatchObject({
      install: { mode: 'instructions', instructions: 'brew install ollama' },
    });
  });

  it('requires alternatives for the alternative fallback', () => {
    expect(() =>
      normalizePipelineDependency(
        {
          id: 'a',
          kind: 'connector',
          connector: 'github',
          fallback: 'alternative',
        },
        context,
      ),
    ).toThrow('fallback "alternative" requires a non-empty alternatives list');
  });

  it('rejects malformed version ranges', () => {
    expect(() =>
      normalizePipelineDependency(
        {
          id: 'a',
          kind: 'local_package',
          package: { probe: 'gh' },
          version: '>=2.40; rm -rf /',
        },
        context,
      ),
    ).toThrow('must be a version range expression');
    // Credential-shaped values fit the version charset but must still be
    // rejected by the secret filter.
    expect(() =>
      normalizePipelineDependency(
        {
          id: 'a',
          kind: 'local_package',
          package: { probe: 'gh' },
          version: 'sk-0123456789abcdef',
        },
        context,
      ),
    ).toThrow('version must not contain secret-like content');
    expect(
      normalizePipelineDependency(
        {
          id: 'a',
          kind: 'local_package',
          package: { probe: 'gh' },
          version: '>=2.40 <3',
        },
        context,
      ),
    ).toMatchObject({ version: '>=2.40 <3' });
  });

  it('rejects secret-like content in free-text fields', () => {
    expect(() =>
      normalizePipelineDependency(
        {
          id: 'a',
          kind: 'connector',
          connector: 'github',
          capability: 'Use token ghp_0123456789abcdefghij0123456789abcdef',
        },
        context,
      ),
    ).toThrow('capability must not contain secret-like content');
    expect(() =>
      normalizePipelineDependency(
        {
          id: 'a',
          kind: 'local_runtime',
          runtime: 'ollama',
          install: {
            mode: 'instructions',
            instructions: 'export API_KEY=abcdefgh12345678 before running',
          },
        },
        context,
      ),
    ).toThrow('install instructions must not contain secret-like content');
  });

  it('rejects secret-like content in structural fields, not just free text', () => {
    expect(() =>
      normalizePipelineDependency(
        {
          id: 'ghp_0123456789abcdefghij0123456789abcdef',
          kind: 'connector',
          connector: 'github',
        },
        context,
      ),
    ).toThrow('id must not contain secret-like content');
    expect(() =>
      normalizePipelineDependency(
        {
          id: 'a',
          kind: 'local_runtime',
          runtime: 'xoxb-0123456789-abcdef',
        },
        context,
      ),
    ).toThrow('runtime must not contain secret-like content');
    expect(() =>
      normalizePipelineDependency(
        {
          id: 'a',
          kind: 'plugin',
          ref: {
            type: 'plugin',
            marketplace: { type: 'builtin', id: 'app' },
            plugin_name: 'sk-0123456789abcdefgh',
          },
        },
        context,
      ),
    ).toThrow('ref plugin_name must not contain secret-like content');
  });

  it('rejects unknown keys in refs and nested source/marketplace objects', () => {
    expect(() =>
      normalizePipelineDependency(
        {
          id: 'a',
          kind: 'skill',
          ref: {
            type: 'skill',
            source: { type: 'builtin', id: 'app' },
            skill_name: 'charting',
            token: 'anything',
          },
        },
        context,
      ),
    ).toThrow('ref unexpected field "token"');
    expect(() =>
      normalizePipelineDependency(
        {
          id: 'a',
          kind: 'plugin',
          ref: {
            type: 'plugin',
            marketplace: {
              type: 'github',
              repo: 'acme/marketplace',
              api_key: 'anything',
            },
            plugin_name: 'browser',
          },
        },
        context,
      ),
    ).toThrow('ref marketplace unexpected field "api_key"');
  });
});

describe('assertNoSecretLikeContent traversal guards', () => {
  it('rejects canonical Canopy API keys in recursively scanned fields', () => {
    const apiKey = `csk_${'a'.repeat(43)}`;
    expect(() =>
      assertNoSecretLikeContent(
        { install: { alternatives: [{ instructions: apiKey }] } },
        'Pipeline dependencies[0]',
      ),
    ).toThrow(
      'Pipeline dependencies[0] install alternatives instructions must not contain secret-like content',
    );
  });

  it('terminates on cyclic and shared-alias structures', () => {
    const cyclic: Record<string, unknown> = { note: 'ok' };
    cyclic.self = cyclic;
    expect(() =>
      assertNoSecretLikeContent(cyclic, 'Pipeline dependencies[0]'),
    ).not.toThrow();

    const shared = { note: 'ok' };
    expect(() =>
      assertNoSecretLikeContent(
        { left: shared, right: shared },
        'Pipeline dependencies[0]',
      ),
    ).not.toThrow();
  });

  it('rejects pathologically deep nesting instead of overflowing', () => {
    let deep: Record<string, unknown> = { leaf: 'ok' };
    for (let index = 0; index < 100; index += 1) {
      deep = { nested: deep };
    }
    expect(() =>
      assertNoSecretLikeContent(deep, 'Pipeline dependencies[0]'),
    ).toThrow('is nested too deeply to validate');
  });
});

describe('containsSecretLikeContent', () => {
  it('flags common credential shapes', () => {
    expect(
      containsSecretLikeContent('ghp_0123456789abcdefghij0123456789abcdef'),
    ).toBe(true);
    expect(containsSecretLikeContent('AKIAABCDEFGHIJKLMNOP')).toBe(true);
    expect(containsSecretLikeContent('password = hunter2hunter2')).toBe(true);
    expect(containsSecretLikeContent('-----BEGIN RSA PRIVATE KEY-----')).toBe(
      true,
    );
    expect(
      containsSecretLikeContent('AIzaSyA1234567890abcdefghijklmnopqrstuv'),
    ).toBe(true);
    expect(containsSecretLikeContent('glpat-abcdefghij1234567890')).toBe(true);
    expect(containsSecretLikeContent(`npm_${'a1'.repeat(18)}`)).toBe(true);
    expect(containsSecretLikeContent('sk_live_abcdefgh12345678')).toBe(true);
    expect(containsSecretLikeContent(`csk_${'a'.repeat(43)}`)).toBe(true);
    expect(containsSecretLikeContent(`csk_${'a'.repeat(42)}-`)).toBe(true);
  });

  it('accepts ordinary capability and instruction copy', () => {
    expect(containsSecretLikeContent('Reads Linear issues')).toBe(false);
    expect(containsSecretLikeContent('brew install gh')).toBe(false);
    expect(
      containsSecretLikeContent(
        'Connect your GitHub account from Settings before running',
      ),
    ).toBe(false);
  });
});
