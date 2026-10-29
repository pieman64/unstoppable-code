import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveOpenCodeProviderConfig,
  serializeOpenCodeRuntimeConfig,
} from '../provider-settings';
import { readOpenCodeProviderConfig } from '../provider-config';

it('imports v2 provider settings and provider restrictions without native tool policies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opencode-v2-config-'));
  try {
    await mkdir(join(root, 'opencode'));
    await writeFile(
      join(root, 'opencode', 'opencode.json'),
      JSON.stringify({
        providers: { fixture: { settings: { apiKey: 'fixture' } } },
        policies: [
          { action: 'provider.use', resource: 'fixture', effect: 'allow' },
          { action: 'tool.use', resource: '*', effect: 'allow' },
        ],
        plugins: ['unselected'],
      }),
    );
    expect(await readOpenCodeProviderConfig({ XDG_CONFIG_HOME: root })).toEqual(
      {
        providers: { fixture: { settings: { apiKey: 'fixture' } } },
        policies: [
          { action: 'provider.use', resource: 'fixture', effect: 'allow' },
        ],
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('imports provider JSONC while excluding native plugins, MCP, instructions and permission overrides', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opencode-config-'));
  try {
    await mkdir(join(root, 'opencode'));
    await writeFile(
      join(root, 'opencode', 'opencode.jsonc'),
      '{ // native config\n "provider": {"local":{"options":{"baseURL":"http://127.0.0.1:1234"}}}, "permission":"allow", "plugin":["unselected"], "mcp":{"unselected":{}}, "instructions":["secret"], }',
    );
    expect(await readOpenCodeProviderConfig({ XDG_CONFIG_HOME: root })).toEqual(
      {
        provider: { local: { options: { baseURL: 'http://127.0.0.1:1234' } } },
      },
    );
    await writeFile(join(root, 'opencode', 'opencode.jsonc'), '{ invalid');
    await expect(
      readOpenCodeProviderConfig({ XDG_CONFIG_HOME: root }),
    ).rejects.toThrow('invalid JSON');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('merges layered provider settings and preserves file references outside the private runtime directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opencode-config-'));
  try {
    await mkdir(join(root, 'opencode'));
    await writeFile(
      join(root, 'opencode', 'config.json'),
      JSON.stringify({
        provider: {
          local: {
            options: {
              apiKey: '{file:./key.txt}',
              baseURL: 'https://old.test',
            },
            models: { custom: { name: 'Custom' } },
          },
        },
      }),
    );
    await writeFile(
      join(root, 'opencode', 'opencode.json'),
      JSON.stringify({
        provider: { local: { options: { baseURL: 'https://new.test' } } },
      }),
    );
    expect(await readOpenCodeProviderConfig({ XDG_CONFIG_HOME: root })).toEqual(
      {
        provider: {
          local: {
            options: {
              apiKey: `{file:${join(root, 'opencode', 'key.txt')}}`,
              baseURL: 'https://new.test',
            },
            models: { custom: { name: 'Custom' } },
          },
        },
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('freezes env/file values once and shields literal references from the native second pass', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opencode-effective-config-'));
  try {
    const file = join(root, 'key.txt');
    await writeFile(file, '  synthetic-key-{env:SECOND}-{file:other.txt}\n');
    const env = {
      FIRST: 'https://first.invalid',
      KEY: `{file:${file}}`,
      SECOND: 'must-not-expand',
    };
    const config = {
      provider: {
        custom: {
          options: {
            baseURL: '{env:FIRST}',
            apiKey: '{env:KEY}',
            duplicate: `{file:${file}}`,
            missing: '{env:ABSENT}',
            quoted: '{env:QUOTE}',
          },
        },
      },
    };
    const resolved = await resolveOpenCodeProviderConfig(
      config,
      { ...env, QUOTE: 'a"b\nc' },
      root,
      new AbortController().signal,
    );
    expect(resolved).toEqual({
      provider: {
        custom: {
          options: {
            baseURL: 'https://first.invalid',
            apiKey: 'synthetic-key-{env:SECOND}-{file:other.txt}',
            duplicate: 'synthetic-key-{env:SECOND}-{file:other.txt}',
            missing: '',
            quoted: 'a"b\nc',
          },
        },
      },
    });
    env.FIRST = 'https://second.invalid';
    await writeFile(file, 'replacement-key');
    const serialized = serializeOpenCodeRuntimeConfig(resolved ?? {});
    expect(serialized).not.toMatch(/\{(?:env|file):/);
    expect(JSON.parse(serialized)).toEqual(resolved);
    expect(serialized).not.toContain('replacement-key');
    expect(config.provider.custom.options.baseURL).toBe('{env:FIRST}');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('provider reference reads are bounded, cancellable and do not disclose paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opencode-provider-bounds-'));
  try {
    const file = join(root, 'synthetic-secret-path.txt');
    for (const value of [`{file:${file}}`, `{file:${root}}`])
      await expect(
        resolveOpenCodeProviderConfig(
          { provider: { value } },
          {},
          root,
          new AbortController().signal,
        ),
      ).rejects.toThrow(
        'OpenCode provider settings contain an unreadable file reference.',
      );
    await writeFile(file, 'x'.repeat(1024 * 1024 + 1));
    await expect(
      resolveOpenCodeProviderConfig(
        { provider: { value: `{file:${file}}` } },
        {},
        root,
        new AbortController().signal,
      ),
    ).rejects.toThrow('unreadable file reference');
    const abort = new AbortController();
    abort.abort(new Error('caller cancelled'));
    await expect(
      resolveOpenCodeProviderConfig({ provider: {} }, {}, root, abort.signal),
    ).rejects.toThrow('caller cancelled');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
