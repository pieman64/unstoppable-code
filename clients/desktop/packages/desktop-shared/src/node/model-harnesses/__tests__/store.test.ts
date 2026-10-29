import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelHarnessCatalog } from '../../../model-harnesses';
import {
  ModelHarnessOverrideStore,
  UnsupportedModelHarnessOverridesVersionError,
} from '../store';

function baseCatalog(): ModelHarnessCatalog {
  return {
    claudeModels: ['managed-claude'],
    codexModels: ['managed-codex'],
    aiGatewayModels: [{ id: 'gateway-model', recommendedHarness: 'codex' }],
    ollamaModels: ['ollama-local'],
    modelAliases: { gateway_alias: 'gateway-model' },
  };
}

describe('ModelHarnessOverrideStore', () => {
  let root: string;
  let filePath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'model-harness-store-'));
    filePath = join(root, 'nested', 'model-harness-overrides.json');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function createStore(
    getCatalog: () => ModelHarnessCatalog = baseCatalog,
  ): ModelHarnessOverrideStore {
    return new ModelHarnessOverrideStore({ filePath, getCatalog });
  }

  it('loads a missing file once as an empty map', async () => {
    const store = createStore();
    await expect(store.load()).resolves.toEqual({});
    await mkdir(join(root, 'nested'), { recursive: true });
    await writeFile(
      filePath,
      JSON.stringify({ version: 1, overrides: { 'gateway-model': 'claude' } }),
    );
    expect(store.getCachedOverrides()).toEqual({});
  });

  it('retains a Cursor default across restart while its runtime is disconnected', async () => {
    const getCatalog = (): ModelHarnessCatalog => ({
      ...baseCatalog(),
      cursorModels: ['cursor:managed-codex%5B%5D'],
      cursorModelMappings: { 'managed-codex': 'cursor:managed-codex%5B%5D' },
    });
    await createStore(getCatalog).set('managed-codex', 'cursor');
    // Reloading without discovery must retain the preference. The assignment
    // policy decides whether it can currently be offered.
    await expect(createStore().load()).resolves.toEqual({
      'managed-codex': 'cursor',
    });
    await expect(createStore(getCatalog).load()).resolves.toEqual({
      'managed-codex': 'cursor',
    });
  });

  it('treats a non-ENOENT read failure as empty and permits a later mutation', async () => {
    await mkdir(filePath, { recursive: true });
    const store = createStore();

    await expect(store.load()).resolves.toEqual({});

    await rm(filePath, { recursive: true });
    await expect(store.set('gateway-model', 'claude')).resolves.toMatchObject({
      changed: true,
      overrides: { 'gateway-model': 'claude' },
    });
  });

  it('serializes atomic writes and creates a restrictive file without temp residue', async () => {
    const store = createStore();
    const [first, second] = await Promise.all([
      store.set('gateway-model', 'claude'),
      store.set('gateway-model', 'codex'),
    ]);
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(true);
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
      version: 1,
      overrides: {},
    });
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    expect(
      (await readdir(join(root, 'nested'))).filter((name) =>
        name.endsWith('.tmp'),
      ),
    ).toEqual([]);
  });

  it('backs up malformed JSON and replaces it with a clean document', async () => {
    await mkdir(join(root, 'nested'), { recursive: true });
    await writeFile(filePath, '{not json');
    const store = new ModelHarnessOverrideStore({
      filePath,
      getCatalog: baseCatalog,
      now: (): Date => new Date('2026-08-04T12:34:56.000Z'),
    });
    await expect(store.load()).resolves.toEqual({});
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
      version: 1,
      overrides: {},
    });
    expect(
      await readFile(
        `${filePath}.corrupt-2026-08-04T12-34-56-000Z.bak`,
        'utf8',
      ),
    ).toBe('{not json');
  });

  it.each([
    ['malformed JSON', '{not json'],
    ['an invalid document shape', JSON.stringify({ version: 1 })],
  ])(
    'keeps %s non-fatal when best-effort healing fails',
    async (_description, contents) => {
      await mkdir(join(root, 'nested'), { recursive: true });
      await writeFile(filePath, contents);
      const store = new ModelHarnessOverrideStore({
        filePath,
        getCatalog: baseCatalog,
        healCorruptFile: (): Promise<void> =>
          Promise.reject(new Error('read-only preferences directory')),
      });

      await expect(store.load()).resolves.toEqual({});
      await expect(store.load()).resolves.toEqual({});
      await expect(store.set('gateway-model', 'claude')).resolves.toMatchObject(
        {
          changed: true,
          overrides: { 'gateway-model': 'claude' },
        },
      );
    },
  );

  it('never overwrites unsupported future versions', async () => {
    await mkdir(join(root, 'nested'), { recursive: true });
    const future = '{"version":2,"overrides":{"gateway-model":"claude"}}\n';
    await writeFile(filePath, future);
    const store = createStore();
    await expect(store.load()).resolves.toEqual({});
    await expect(store.set('gateway-model', 'claude')).rejects.toBeInstanceOf(
      UnsupportedModelHarnessOverridesVersionError,
    );
    expect(await readFile(filePath, 'utf8')).toBe(future);
  });

  it('keeps stale valid keys and cleans invalid entries on the next successful mutation', async () => {
    await mkdir(join(root, 'nested'), { recursive: true });
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        overrides: {
          'stale-model': 'claude',
          'bad model': 'codex',
          'gateway-model': 'invalid',
        },
      }),
    );
    const store = createStore();
    await expect(store.load()).resolves.toEqual({ 'stale-model': 'claude' });
    await expect(store.reset('gateway-model')).resolves.toMatchObject({
      changed: false,
    });
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
      version: 1,
      overrides: { 'stale-model': 'claude' },
    });
  });

  it('canonicalizes aliases and rejects managed or unknown models', async () => {
    const store = createStore();
    await expect(store.set('gateway_alias', 'claude')).resolves.toMatchObject({
      modelId: 'gateway-model',
      overrides: { 'gateway-model': 'claude' },
    });
    await expect(store.set('managed-claude', 'codex')).rejects.toMatchObject({
      code: 'NOT_CONFIGURABLE',
    });
    await expect(store.set('missing', 'codex')).rejects.toMatchObject({
      code: 'UNKNOWN_MODEL',
    });
  });

  it('makes repeated set/reset mutations idempotent', async () => {
    const store = createStore();
    await expect(store.set('gateway-model', 'claude')).resolves.toMatchObject({
      changed: true,
    });
    await expect(store.set('gateway-model', 'claude')).resolves.toMatchObject({
      changed: false,
    });
    await expect(store.reset('gateway-model')).resolves.toMatchObject({
      changed: true,
    });
    await expect(store.reset('gateway-model')).resolves.toMatchObject({
      changed: false,
    });
  });

  it('retains an explicit override across recommendation changes until reset to the live default', async () => {
    let catalog = baseCatalog();
    const store = createStore(() => catalog);
    await store.set('gateway-model', 'claude');
    catalog = {
      ...catalog,
      aiGatewayModels: [{ id: 'gateway-model', recommendedHarness: 'claude' }],
    };
    expect(store.getCachedOverrides()).toEqual({ 'gateway-model': 'claude' });
    await expect(store.set('gateway-model', 'claude')).resolves.toMatchObject({
      changed: true,
      overrides: {},
    });
  });
});
