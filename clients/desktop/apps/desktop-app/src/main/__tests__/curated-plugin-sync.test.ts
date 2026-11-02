import { createHash } from 'node:crypto';
// `node:fs` (sync) is intentionally NOT mocked, so test setup/assertions
// never pollute the `node:fs/promises` call log the engine is asserted on.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CuratedMcpServerListResponse } from '@canopy/protocol/mcp-catalog';
import type {
  CuratedPluginContentResponse,
  CuratedPluginEntry,
  CuratedPluginListResponse,
} from '@canopy/protocol/plugin-catalog';

/** Ordered log of every mutating `node:fs/promises` call the engine makes. */
const mockFsCalls: string[] = [];
/** Every marketplace manifest write, with its content, in order. */
const mockManifestWrites: Array<{ path: string; content: string }> = [];
let mockRenameFailureTarget = '';
let mockRenameFailuresRemaining = 0;

/**
 * The engine only ever passes plain string paths/contents; anything else is
 * logged as an empty string rather than stringified.
 */
function mockText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
  return {
    ...actual,
    mkdir: (
      ...args: Parameters<typeof actual.mkdir>
    ): ReturnType<typeof actual.mkdir> => {
      mockFsCalls.push(`mkdir ${mockText(args[0])}`);
      return actual.mkdir(...args);
    },
    writeFile: (
      ...args: Parameters<typeof actual.writeFile>
    ): ReturnType<typeof actual.writeFile> => {
      const path = mockText(args[0]);
      mockFsCalls.push(`writeFile ${path}`);
      if (path.endsWith('marketplace.json')) {
        mockManifestWrites.push({ path, content: mockText(args[1]) });
      }
      return actual.writeFile(...args);
    },
    rm: (
      ...args: Parameters<typeof actual.rm>
    ): ReturnType<typeof actual.rm> => {
      mockFsCalls.push(`rm ${mockText(args[0])}`);
      return actual.rm(...args);
    },
    rename: (
      ...args: Parameters<typeof actual.rename>
    ): ReturnType<typeof actual.rename> => {
      mockFsCalls.push(`rename ${mockText(args[1])}`);
      if (
        mockText(args[1]) === mockRenameFailureTarget &&
        mockRenameFailuresRemaining > 0
      ) {
        mockRenameFailuresRemaining -= 1;
        return Promise.reject(new Error('simulated promotion rename failure'));
      }
      return actual.rename(...args);
    },
  };
});

let mockRootDir = '';

jest.mock('../lib/paths', () => ({
  getCuratedPluginsMarketplaceDir: (): string =>
    join(mockRootDir, 'curated-plugins', 'marketplace'),
  getCuratedPluginsStagingDir: (): string =>
    join(mockRootDir, 'curated-plugins', 'staging'),
  getCuratedPluginsSyncLockFilePath: (): string =>
    join(mockRootDir, 'curated-plugins', 'sync-lock.json'),
}));

const mockFetchCuratedPluginsForSync = jest.fn<
  Promise<CuratedPluginListResponse | null>,
  []
>();
const mockFetchCuratedPluginContent = jest.fn<
  Promise<CuratedPluginContentResponse | null>,
  [string]
>();
type TestMcpResolution =
  | { status: 'verified'; catalog: CuratedMcpServerListResponse }
  | { status: 'unavailable' };

const mockResolveCuratedMcpCatalogForSync = jest.fn<
  Promise<TestMcpResolution>,
  []
>();

jest.mock('../plugins/curated-plugin-catalog', () => ({
  get fetchCuratedPluginsForSync(): typeof mockFetchCuratedPluginsForSync {
    return mockFetchCuratedPluginsForSync;
  },
  get fetchCuratedPluginContent(): typeof mockFetchCuratedPluginContent {
    return mockFetchCuratedPluginContent;
  },
}));
jest.mock('../mcp/curated-catalog', () => ({
  get resolveCuratedMcpCatalogForSync(): typeof mockResolveCuratedMcpCatalogForSync {
    return mockResolveCuratedMcpCatalogForSync;
  },
}));

import { scanPluginDetails } from '../plugins/plugin-scanner';
import {
  CURATED_PLUGIN_SYNC_TTL_MS,
  getCuratedPluginMarketplaceName,
  resetCuratedPluginSyncStateForTests,
  syncCuratedPlugins,
  type CuratedPluginSyncResult,
} from '../plugins/curated-plugin-sync';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface TestPlugin {
  entry: CuratedPluginEntry;
  content: CuratedPluginContentResponse;
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function makePlugin(
  key: string,
  options: {
    revision?: string;
    mcpServers?: string[];
    version?: string;
    recommended?: boolean;
  } = {},
): TestPlugin {
  const revision = options.revision ?? 'v1';
  const skillKey = `${key}-skill`;
  const files = [
    {
      path: 'SKILL.md',
      content: `---\nname: ${skillKey}\ndescription: The ${key} skill (${revision}).\n---\n\nBody ${revision}\n`,
    },
    { path: 'references/api.md', content: `# ${key} reference ${revision}\n` },
  ];
  const manifestFiles = files.map((file) => ({
    path: file.path,
    sha256: sha256(file.content),
    size: Buffer.byteLength(file.content, 'utf8'),
  }));
  const contentHash = `plugin-${key}-${revision}`;
  const skillContentHash = `skill-${key}-${revision}`;
  return {
    entry: {
      key,
      name: `${key} display`,
      shortDescription: `Short description for ${key} (${revision})`,
      ...(options.version !== undefined ? { version: options.version } : {}),
      authorName: 'Canopy',
      docsUrl: `https://example.test/${key}`,
      categories: ['development'],
      popular: false,
      ...(options.recommended !== undefined
        ? { recommended: options.recommended }
        : {}),
      sortOrder: 0,
      contentHash,
      mcpServers: options.mcpServers ?? [],
      skills: [
        {
          key: skillKey,
          name: `${key} skill`,
          contentHash: skillContentHash,
          files: manifestFiles,
        },
      ],
      updatedAt: '2026-07-14T00:00:00.000Z',
    },
    content: {
      version: 1,
      key,
      contentHash,
      skills: [
        {
          key: skillKey,
          contentHash: skillContentHash,
          files: files.map((file, index) => ({
            ...manifestFiles[index],
            content: file.content,
          })),
        },
      ],
    },
  };
}

const MCP_URL_PREFIX = 'https://mcp.example.test/';

function curatedMcpCatalog(keys: string[]): CuratedMcpServerListResponse {
  return {
    version: 1,
    servers: keys.map((key) => ({
      key,
      name: key,
      shortDescription: `${key} MCP`,
      url: `${MCP_URL_PREFIX}${key}`,
      transport: 'http',
      categories: [],
      popular: false,
      sortOrder: 0,
      updatedAt: '2026-07-14T00:00:00.000Z',
    })),
  };
}

function armCatalog(plugins: TestPlugin[]): void {
  mockFetchCuratedPluginsForSync.mockResolvedValue({
    version: 1,
    plugins: plugins.map((plugin) => plugin.entry),
  });
  mockFetchCuratedPluginContent.mockImplementation((key: string) =>
    Promise.resolve(
      plugins.find((plugin) => plugin.entry.key === key)?.content ?? null,
    ),
  );
}

function marketplaceDir(): string {
  return join(mockRootDir, 'curated-plugins', 'marketplace');
}

function pluginDir(key: string): string {
  return join(marketplaceDir(), key);
}

function promotionBackupDir(key: string): string {
  return join(mockRootDir, 'curated-plugins', 'promotion-backups', key);
}

function lockPath(): string {
  return join(mockRootDir, 'curated-plugins', 'sync-lock.json');
}

function claudeMarketplacePath(): string {
  return join(marketplaceDir(), '.claude-plugin', 'marketplace.json');
}

function codexMarketplacePath(): string {
  return join(marketplaceDir(), '.agents', 'plugins', 'marketplace.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJsonFile(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isRecord(parsed)) throw new Error(`Not a JSON object: ${path}`);
  return parsed;
}

function manifestPluginNames(path: string): string[] {
  const manifest = readJsonFile(path);
  const plugins = manifest.plugins;
  if (!Array.isArray(plugins)) return [];
  return plugins.map((plugin) =>
    isRecord(plugin) && typeof plugin.name === 'string' ? plugin.name : '',
  );
}

function lockPlugins(): Record<string, unknown> {
  const lock = readJsonFile(lockPath());
  return isRecord(lock.plugins) ? lock.plugins : {};
}

function lockEntry(key: string): Record<string, unknown> {
  const entry = lockPlugins()[key];
  if (!isRecord(entry)) throw new Error(`Missing lock entry: ${key}`);
  return entry;
}

function skillBody(key: string): string {
  return readFileSync(
    join(pluginDir(key), 'skills', `${key}-skill`, 'SKILL.md'),
    'utf8',
  );
}

function indexOfCall(predicate: (call: string) => boolean): number {
  return mockFsCalls.findIndex(predicate);
}

function lastIndexOfCall(predicate: (call: string) => boolean): number {
  for (let index = mockFsCalls.length - 1; index >= 0; index -= 1) {
    if (predicate(mockFsCalls[index])) return index;
  }
  return -1;
}

async function sync(force = true): Promise<CuratedPluginSyncResult> {
  return syncCuratedPlugins(force ? { force: true } : undefined);
}

// ---------------------------------------------------------------------------

describe('curated plugin sync', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFsCalls.length = 0;
    mockManifestWrites.length = 0;
    mockRenameFailureTarget = '';
    mockRenameFailuresRemaining = 0;
    resetCuratedPluginSyncStateForTests();
    mockRootDir = mkdtempSync(join(tmpdir(), 'curated-plugin-sync-'));
    mockResolveCuratedMcpCatalogForSync.mockResolvedValue({
      status: 'verified',
      catalog: { version: 1, servers: [] },
    });
  });

  afterEach(() => {
    rmSync(mockRootDir, { recursive: true, force: true });
  });

  describe('fetch failure', () => {
    it('returns skipped and performs zero filesystem writes', async () => {
      mockFetchCuratedPluginsForSync.mockResolvedValue(null);

      const result = await sync();

      expect(result).toEqual({
        status: 'skipped',
        added: [],
        changed: [],
        removed: [],
        errors: [],
      });
      expect(mockFsCalls).toEqual([]);
      expect(existsSync(join(mockRootDir, 'curated-plugins'))).toBe(false);
    });

    it('never deletes a previously materialized plugin', async () => {
      armCatalog([makePlugin('alpha')]);
      await sync();
      mockFsCalls.length = 0;
      mockFetchCuratedPluginsForSync.mockResolvedValue(null);

      const result = await sync();

      expect(result.status).toBe('skipped');
      expect(mockFsCalls).toEqual([]);
      expect(existsSync(pluginDir('alpha'))).toBe(true);
      expect(Object.keys(lockPlugins())).toEqual(['alpha']);
    });
  });

  describe('TTL', () => {
    it('short-circuits a non-forced call inside the TTL window', async () => {
      armCatalog([makePlugin('alpha')]);
      await sync();
      expect(mockFetchCuratedPluginsForSync).toHaveBeenCalledTimes(1);

      const result = await syncCuratedPlugins();

      expect(result.status).toBe('noop');
      expect(mockFetchCuratedPluginsForSync).toHaveBeenCalledTimes(1);
    });

    it('bypasses the TTL when force is set', async () => {
      armCatalog([makePlugin('alpha')]);
      await sync();

      const result = await syncCuratedPlugins({ force: true });

      expect(result.status).toBe('noop');
      expect(mockFetchCuratedPluginsForSync).toHaveBeenCalledTimes(2);
    });

    it('exposes a five minute TTL', () => {
      expect(CURATED_PLUGIN_SYNC_TTL_MS).toBe(5 * 60_000);
    });
  });

  describe('diff', () => {
    it('computes added, changed and removed sets from the lock', async () => {
      armCatalog([makePlugin('alpha'), makePlugin('beta')]);
      const first = await sync();
      expect(first).toMatchObject({
        status: 'synced',
        added: ['alpha', 'beta'],
        changed: [],
        removed: [],
      });

      armCatalog([
        makePlugin('alpha'),
        makePlugin('beta', { revision: 'v2' }),
        makePlugin('gamma'),
      ]);
      const second = await sync();

      expect(second).toMatchObject({
        status: 'synced',
        added: ['gamma'],
        changed: ['beta'],
        removed: [],
        errors: [],
      });
      expect(skillBody('beta')).toContain('Body v2');
      expect(skillBody('alpha')).toContain('Body v1');
      // Only the added and changed plugins are re-downloaded.
      expect(
        mockFetchCuratedPluginContent.mock.calls
          .slice(2)
          .map(([key]) => key)
          .sort(),
      ).toEqual(['beta', 'gamma']);
    });

    it('reports a plugin dropped from the catalog as removed', async () => {
      armCatalog([makePlugin('alpha'), makePlugin('beta')]);
      await sync();

      armCatalog([makePlugin('alpha')]);
      const result = await sync();

      expect(result).toMatchObject({
        status: 'synced',
        added: [],
        changed: [],
        removed: ['beta'],
      });
      expect(existsSync(pluginDir('beta'))).toBe(false);
      expect(Object.keys(lockPlugins())).toEqual(['alpha']);
      expect(manifestPluginNames(claudeMarketplacePath())).toEqual(['alpha']);
      expect(manifestPluginNames(codexMarketplacePath())).toEqual(['alpha']);
    });

    it('returns noop and writes nothing when the catalog is unchanged', async () => {
      armCatalog([makePlugin('alpha')]);
      await sync();
      mockFsCalls.length = 0;

      const result = await sync();

      expect(result.status).toBe('noop');
      expect(mockFsCalls).toEqual([]);
    });

    it('updates Try it metadata without downloading or changing installed content', async () => {
      const plugin = makePlugin('alpha');
      plugin.entry.tryNowPrompt = 'First example';
      armCatalog([plugin]);
      await sync();
      mockFetchCuratedPluginContent.mockClear();
      plugin.entry.tryNowPrompt = 'Second example';
      armCatalog([plugin]);
      const result = await sync();
      expect(result).toMatchObject({
        status: 'synced',
        added: [],
        changed: [],
        removed: [],
      });
      expect(mockFetchCuratedPluginContent).not.toHaveBeenCalled();
      expect(lockEntry('alpha').contentHash).toBe('plugin-alpha-v1');
      expect(readJsonFile(claudeMarketplacePath()).plugins).toEqual([
        expect.objectContaining({
          name: 'alpha',
          tryNowPrompt: 'Second example',
        }),
      ]);
    });

    it('rewrites recommendation metadata without downloading unchanged content', async () => {
      armCatalog([makePlugin('alpha', { recommended: false })]);
      await sync();
      mockFetchCuratedPluginContent.mockClear();

      armCatalog([makePlugin('alpha', { recommended: true })]);
      const result = await sync();

      expect(result).toMatchObject({
        status: 'synced',
        added: [],
        changed: [],
        removed: [],
      });
      expect(mockFetchCuratedPluginContent).not.toHaveBeenCalled();
      const manifest = readJsonFile(claudeMarketplacePath());
      expect(manifest.plugins).toEqual([
        expect.objectContaining({ name: 'alpha', recommended: true }),
      ]);
    });

    it('handles a plugin key that collides with an Object prototype member', async () => {
      armCatalog([makePlugin('constructor')]);

      const first = await sync();
      expect(first).toMatchObject({ status: 'synced', added: ['constructor'] });
      expect(skillBody('constructor')).toContain('Body v1');

      const second = await sync();
      expect(second.status).toBe('noop');
    });

    it('re-downloads when the materialized directory is missing', async () => {
      armCatalog([makePlugin('alpha')]);
      await sync();
      rmSync(pluginDir('alpha'), { recursive: true, force: true });

      const result = await sync();

      expect(result).toMatchObject({ status: 'synced', changed: ['alpha'] });
      expect(skillBody('alpha')).toContain('Body v1');
    });

    it('repairs a materialized skill file whose bytes no longer match the lock', async () => {
      armCatalog([makePlugin('alpha')]);
      await sync();
      writeFileSync(
        join(pluginDir('alpha'), 'skills', 'alpha-skill', 'SKILL.md'),
        'corrupted externally',
        'utf8',
      );

      const result = await sync();

      expect(result).toMatchObject({ status: 'synced', changed: ['alpha'] });
      expect(skillBody('alpha')).toContain('Body v1');
    });

    it('repairs a generated plugin manifest that was edited externally', async () => {
      armCatalog([makePlugin('alpha')]);
      await sync();
      writeFileSync(
        join(pluginDir('alpha'), '.codex-plugin', 'plugin.json'),
        '{}\n',
        'utf8',
      );

      const result = await sync();

      expect(result).toMatchObject({ status: 'synced', changed: ['alpha'] });
      expect(
        readJsonFile(join(pluginDir('alpha'), '.codex-plugin', 'plugin.json')),
      ).toMatchObject({ name: 'alpha', skills: './skills/' });
    });

    it('treats a corrupt lock as a full resync', async () => {
      armCatalog([makePlugin('alpha'), makePlugin('beta')]);
      await sync();
      writeFileSync(lockPath(), '{not json', 'utf8');

      const result = await sync();

      expect(result).toMatchObject({
        status: 'synced',
        added: ['alpha', 'beta'],
        changed: [],
        removed: [],
      });
      expect(Object.keys(lockPlugins()).sort()).toEqual(['alpha', 'beta']);
      expect(skillBody('alpha')).toContain('Body v1');
    });
  });

  describe('per-plugin failure containment', () => {
    it('keeps the previous version of a plugin whose sha256 does not match', async () => {
      armCatalog([makePlugin('alpha'), makePlugin('beta')]);
      await sync();

      const tamperedAlpha = makePlugin('alpha', { revision: 'v2' });
      tamperedAlpha.content.skills[0].files[0].content = 'tampered content';
      armCatalog([tamperedAlpha, makePlugin('beta', { revision: 'v2' })]);
      const result = await sync();

      expect(result.status).toBe('synced');
      expect(result.changed).toEqual(['beta']);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].key).toBe('alpha');
      expect(result.errors[0].message).toContain('sha256');
      // Previous version retained on disk and in the lock.
      expect(skillBody('alpha')).toContain('Body v1');
      expect(lockEntry('alpha').contentHash).toBe('plugin-alpha-v1');
      // Other plugins still proceed.
      expect(skillBody('beta')).toContain('Body v2');
      expect(lockEntry('beta').contentHash).toBe('plugin-beta-v2');
      const claudeManifest = readJsonFile(claudeMarketplacePath());
      const alphaManifestEntry: unknown = Array.isArray(claudeManifest.plugins)
        ? claudeManifest.plugins.find(
            (plugin) => isRecord(plugin) && plugin.name === 'alpha',
          )
        : undefined;
      expect(alphaManifestEntry).toMatchObject({
        description: 'Short description for alpha (v1)',
      });
      // The retained plugin stays listed in both manifests.
      expect(manifestPluginNames(claudeMarketplacePath()).sort()).toEqual([
        'alpha',
        'beta',
      ]);
      // The failure is recorded on the lock for diagnostics.
      expect(String(readJsonFile(lockPath()).lastError)).toContain('alpha');
    });

    it('omits a brand new plugin whose content download fails', async () => {
      const alpha = makePlugin('alpha');
      mockFetchCuratedPluginsForSync.mockResolvedValue({
        version: 1,
        plugins: [alpha.entry, makePlugin('beta').entry],
      });
      mockFetchCuratedPluginContent.mockImplementation((key: string) =>
        Promise.resolve(key === 'alpha' ? alpha.content : null),
      );

      const result = await sync();

      expect(result.added).toEqual(['alpha']);
      expect(result.errors).toEqual([
        { key: 'beta', message: 'Failed to download plugin content' },
      ]);
      expect(existsSync(pluginDir('beta'))).toBe(false);
      expect(manifestPluginNames(claudeMarketplacePath())).toEqual(['alpha']);
      expect(Object.keys(lockPlugins())).toEqual(['alpha']);
    });

    it('rejects a plugin key that is unsafe as a directory name', async () => {
      const evil = makePlugin('alpha');
      evil.entry.key = '../escape';
      mockFetchCuratedPluginsForSync.mockResolvedValue({
        version: 1,
        plugins: [evil.entry],
      });

      const result = await sync();

      expect(result.errors).toEqual([
        { key: '../escape', message: 'Unsupported plugin key' },
      ]);
      expect(mockFetchCuratedPluginContent).not.toHaveBeenCalled();
      expect(mockFsCalls).toEqual([]);
    });

    it.each(['con', 'aux', 'nul', 'com1', 'lpt9'])(
      'rejects the Windows reserved plugin key %s',
      async (key) => {
        const plugin = makePlugin('alpha');
        plugin.entry.key = key;
        mockFetchCuratedPluginsForSync.mockResolvedValue({
          version: 1,
          plugins: [plugin.entry],
        });

        const result = await sync();

        expect(result.errors).toEqual([
          { key, message: 'Unsupported plugin key' },
        ]);
        expect(mockFetchCuratedPluginContent).not.toHaveBeenCalled();
      },
    );

    it('rejects a Windows reserved skill key before materialization', async () => {
      const plugin = makePlugin('alpha');
      plugin.entry.skills[0].key = 'con';
      plugin.content.skills[0].key = 'con';
      armCatalog([plugin]);

      const result = await sync();

      expect(result.errors).toEqual([
        { key: 'alpha', message: 'Unsupported skill key "con"' },
      ]);
      expect(existsSync(pluginDir('alpha'))).toBe(false);
    });

    it('discards the staging directory when a plugin fails', async () => {
      const tampered = makePlugin('alpha');
      tampered.content.skills[0].files[0].content = 'tampered content';
      armCatalog([tampered]);

      await sync();

      const stagingDir = join(mockRootDir, 'curated-plugins', 'staging');
      expect(existsSync(stagingDir) ? readdirSync(stagingDir) : []).toEqual([]);
    });
  });

  describe('commit ordering', () => {
    it('restores the live plugin when staged promotion fails', async () => {
      armCatalog([makePlugin('alpha')]);
      await sync();

      armCatalog([makePlugin('alpha', { revision: 'v2' })]);
      mockRenameFailureTarget = pluginDir('alpha');
      mockRenameFailuresRemaining = 1;

      const result = await sync();

      expect(result.errors).toEqual([
        {
          key: '(sync)',
          message: 'simulated promotion rename failure',
        },
      ]);
      expect(skillBody('alpha')).toContain('Body v1');
      expect(lockEntry('alpha').contentHash).toBe('plugin-alpha-v1');
      expect(existsSync(promotionBackupDir('alpha'))).toBe(false);
    });

    it('restores an interrupted promotion before diffing the catalog', async () => {
      armCatalog([makePlugin('alpha')]);
      await sync();
      mkdirSync(promotionBackupDir('alpha'), { recursive: true });
      rmSync(promotionBackupDir('alpha'), { recursive: true, force: true });
      renameSync(pluginDir('alpha'), promotionBackupDir('alpha'));
      mockFsCalls.length = 0;

      const result = await sync();

      expect(result.status).toBe('noop');
      expect(result.changed).toEqual([]);
      expect(skillBody('alpha')).toContain('Body v1');
      expect(existsSync(promotionBackupDir('alpha'))).toBe(false);
    });

    it('rewrites manifests without removed plugins before deleting, and writes the lock last', async () => {
      armCatalog([makePlugin('alpha'), makePlugin('beta')]);
      await sync();
      mockFsCalls.length = 0;
      mockManifestWrites.length = 0;

      armCatalog([makePlugin('beta', { revision: 'v2' }), makePlugin('gamma')]);
      await sync();

      const firstManifestWrite = indexOfCall((call) =>
        call.startsWith(`writeFile ${claudeMarketplacePath()}`),
      );
      const removeAlpha = indexOfCall(
        (call) => call === `rm ${pluginDir('alpha')}`,
      );
      const lastRename = lastIndexOfCall(
        (call) =>
          call === `rename ${pluginDir('beta')}` ||
          call === `rename ${pluginDir('gamma')}`,
      );
      const lastManifestWrite = lastIndexOfCall(
        (call) =>
          call.startsWith('writeFile ') && call.endsWith('marketplace.json'),
      );
      const lockWrite = indexOfCall(
        (call) => call === `writeFile ${lockPath()}.tmp`,
      );
      const lockRename = indexOfCall((call) => call === `rename ${lockPath()}`);

      // (a) manifests lose the removed plugin BEFORE (b) its directory goes.
      expect(firstManifestWrite).toBeGreaterThanOrEqual(0);
      expect(removeAlpha).toBeGreaterThan(firstManifestWrite);
      // (c) staged directories are promoted after the removals.
      expect(lastRename).toBeGreaterThan(removeAlpha);
      // (d) the final manifest write happens AFTER the renames.
      expect(lastManifestWrite).toBeGreaterThan(lastRename);
      // (e) the lock is the very last thing written.
      expect(lockWrite).toBeGreaterThan(lastManifestWrite);
      expect(lockRename).toBe(mockFsCalls.length - 1);

      // The pre-commit manifest never references a directory that is about
      // to be deleted, and never references a not-yet-renamed new plugin.
      const claudeWrites = mockManifestWrites.filter(
        (write) => write.path === claudeMarketplacePath(),
      );
      expect(claudeWrites).toHaveLength(2);
      expect(manifestNames(claudeWrites[0].content)).toEqual(['beta']);
      expect(manifestNames(claudeWrites[1].content).sort()).toEqual([
        'beta',
        'gamma',
      ]);
    });
  });

  describe('verified empty catalog', () => {
    it('writes nothing when nothing was ever materialized', async () => {
      mockFetchCuratedPluginsForSync.mockResolvedValue({
        version: 1,
        plugins: [],
      });

      const result = await sync();

      expect(result.status).toBe('noop');
      expect(mockFsCalls).toEqual([]);
      expect(existsSync(marketplaceDir())).toBe(false);
    });

    it('removes previously materialized plugins and empties the lock', async () => {
      armCatalog([makePlugin('alpha')]);
      await sync();

      mockFetchCuratedPluginsForSync.mockResolvedValue({
        version: 1,
        plugins: [],
      });
      const result = await sync();

      expect(result).toMatchObject({ status: 'synced', removed: ['alpha'] });
      expect(existsSync(pluginDir('alpha'))).toBe(false);
      expect(manifestPluginNames(claudeMarketplacePath())).toEqual([]);
      expect(manifestPluginNames(codexMarketplacePath())).toEqual([]);
      expect(lockPlugins()).toEqual({});
    });
  });

  describe('curated MCP servers', () => {
    it('writes resolved servers with their curated key, skips unknown keys, and records both in the lock', async () => {
      mockResolveCuratedMcpCatalogForSync.mockResolvedValue({
        status: 'verified',
        catalog: curatedMcpCatalog(['github', 'linear']),
      });
      armCatalog([
        makePlugin('alpha', {
          mcpServers: ['linear', 'github', 'not-in-catalog'],
        }),
      ]);

      await sync();

      // The curated key is the member's identity for the resolver and the
      // inventory; without it a plugin member can never bind to the account
      // or device connection that reaches the same upstream.
      expect(readJsonFile(join(pluginDir('alpha'), '.mcp.json'))).toEqual({
        mcpServers: {
          github: {
            type: 'http',
            url: `${MCP_URL_PREFIX}github`,
            curated: { key: 'github' },
          },
          linear: {
            type: 'http',
            url: `${MCP_URL_PREFIX}linear`,
            curated: { key: 'linear' },
          },
        },
      });
      // Keys are emitted sorted so the rendered file stays byte-stable.
      const written = readJsonFile(join(pluginDir('alpha'), '.mcp.json'));
      expect(
        Object.keys(isRecord(written.mcpServers) ? written.mcpServers : {}),
      ).toEqual(['github', 'linear']);
      expect(lockEntry('alpha').curatedMcpKeys).toEqual([
        'linear',
        'github',
        'not-in-catalog',
      ]);
      const codexManifest = readJsonFile(
        join(pluginDir('alpha'), '.codex-plugin', 'plugin.json'),
      );
      expect(codexManifest.mcpServers).toBe('./.mcp.json');
    });

    it('does not re-download when every declared key stays unresolvable', async () => {
      armCatalog([makePlugin('alpha', { mcpServers: ['not-in-catalog'] })]);
      await sync();
      expect(existsSync(join(pluginDir('alpha'), '.mcp.json'))).toBe(false);
      mockFsCalls.length = 0;

      const result = await sync();

      expect(result.status).toBe('noop');
      expect(mockFsCalls).toEqual([]);
    });

    it('self-heals a plugin materialized while the MCP catalog was empty', async () => {
      armCatalog([makePlugin('alpha', { mcpServers: ['github'] })]);
      await sync();
      expect(existsSync(join(pluginDir('alpha'), '.mcp.json'))).toBe(false);

      mockResolveCuratedMcpCatalogForSync.mockResolvedValue({
        status: 'verified',
        catalog: curatedMcpCatalog(['github']),
      });
      const result = await sync();

      expect(result.changed).toEqual(['alpha']);
      expect(existsSync(join(pluginDir('alpha'), '.mcp.json'))).toBe(true);
    });

    it('never deletes a working .mcp.json when the MCP catalog goes away', async () => {
      mockResolveCuratedMcpCatalogForSync.mockResolvedValue({
        status: 'verified',
        catalog: curatedMcpCatalog(['github']),
      });
      armCatalog([makePlugin('alpha', { mcpServers: ['github'] })]);
      await sync();
      const mcpPath = join(pluginDir('alpha'), '.mcp.json');
      const before = readFileSync(mcpPath, 'utf8');
      mockFsCalls.length = 0;

      armCatalog([
        makePlugin('alpha', { revision: 'v2', mcpServers: ['github'] }),
      ]);
      mockResolveCuratedMcpCatalogForSync.mockResolvedValue({
        status: 'unavailable',
      });
      const result = await sync();

      expect(result.status).toBe('skipped');
      expect(mockFsCalls).toEqual([]);
      expect(readFileSync(mcpPath, 'utf8')).toBe(before);
      expect(skillBody('alpha')).toContain('Body v1');
      expect(result.errors).toEqual([
        {
          key: 'alpha',
          message: 'Curated MCP catalog unavailable; plugin sync deferred',
        },
      ]);
      expect(lockEntry('alpha').curatedMcpKeys).toEqual(['github']);
    });

    it('removes stale MCP config when a verified catalog becomes empty', async () => {
      mockResolveCuratedMcpCatalogForSync.mockResolvedValue({
        status: 'verified',
        catalog: curatedMcpCatalog(['github']),
      });
      armCatalog([makePlugin('alpha', { mcpServers: ['github'] })]);
      await sync();
      const mcpPath = join(pluginDir('alpha'), '.mcp.json');
      expect(existsSync(mcpPath)).toBe(true);

      mockResolveCuratedMcpCatalogForSync.mockResolvedValue({
        status: 'verified',
        catalog: curatedMcpCatalog([]),
      });
      const result = await sync();

      expect(result.changed).toEqual(['alpha']);
      expect(existsSync(mcpPath)).toBe(false);
    });

    it('heals when a key is genuinely removed from a live MCP catalog', async () => {
      mockResolveCuratedMcpCatalogForSync.mockResolvedValue({
        status: 'verified',
        catalog: curatedMcpCatalog(['github', 'linear']),
      });
      armCatalog([makePlugin('alpha', { mcpServers: ['github'] })]);
      await sync();
      const mcpPath = join(pluginDir('alpha'), '.mcp.json');
      expect(existsSync(mcpPath)).toBe(true);

      mockResolveCuratedMcpCatalogForSync.mockResolvedValue({
        status: 'verified',
        catalog: curatedMcpCatalog(['linear']),
      });
      const result = await sync();

      expect(result.changed).toEqual(['alpha']);
      expect(existsSync(mcpPath)).toBe(false);
      expect(
        readJsonFile(join(pluginDir('alpha'), '.codex-plugin', 'plugin.json'))
          .mcpServers,
      ).toBeUndefined();
    });
  });

  describe('serialization', () => {
    it('queues a concurrent call instead of interleaving it', async () => {
      let releaseFirst: (value: CuratedPluginListResponse) => void = () => {};
      const gated = new Promise<CuratedPluginListResponse>((resolve) => {
        releaseFirst = resolve;
      });
      const alpha = makePlugin('alpha');
      mockFetchCuratedPluginsForSync.mockReturnValueOnce(gated);
      mockFetchCuratedPluginsForSync.mockResolvedValue({
        version: 1,
        plugins: [alpha.entry],
      });
      mockFetchCuratedPluginContent.mockResolvedValue(alpha.content);

      const first = sync();
      const second = sync();
      await Promise.resolve();

      expect(mockFetchCuratedPluginsForSync).toHaveBeenCalledTimes(1);

      releaseFirst({ version: 1, plugins: [alpha.entry] });
      const [firstResult, secondResult] = await Promise.all([first, second]);

      expect(mockFetchCuratedPluginsForSync).toHaveBeenCalledTimes(2);
      expect(firstResult.status).toBe('synced');
      expect(secondResult.status).toBe('noop');
    });
  });

  describe('generated manifests', () => {
    it('matches the shapes the plugin scanners accept', async () => {
      mockResolveCuratedMcpCatalogForSync.mockResolvedValue({
        status: 'verified',
        catalog: curatedMcpCatalog(['github']),
      });
      armCatalog([
        makePlugin('alpha', {
          version: '2.1.0',
          mcpServers: ['github'],
          recommended: true,
        }),
      ]);

      await sync();

      const claudeManifest = readJsonFile(claudeMarketplacePath());
      expect(claudeManifest).toMatchObject({
        name: getCuratedPluginMarketplaceName(),
        version: '1.0.0',
        owner: { name: 'Canopy' },
      });
      expect(claudeManifest.plugins).toEqual([
        {
          name: 'alpha',
          description: 'Short description for alpha (v1)',
          version: '2.1.0',
          source: './alpha',
          category: 'development',
          author: { name: 'Canopy' },
          homepage: 'https://example.test/alpha',
          recommended: true,
        },
      ]);

      const codexManifest = readJsonFile(codexMarketplacePath());
      expect(codexManifest).toMatchObject({
        name: getCuratedPluginMarketplaceName(),
        interface: { displayName: 'Canopy Curated Marketplace' },
      });
      expect(codexManifest.plugins).toEqual([
        {
          name: 'alpha',
          source: { source: 'local', path: './alpha' },
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
          category: 'development',
          author: { name: 'Canopy' },
        },
      ]);

      expect(
        readJsonFile(join(pluginDir('alpha'), '.claude-plugin', 'plugin.json')),
      ).toEqual({
        name: 'alpha',
        version: '2.1.0',
        description: 'Short description for alpha (v1)',
        author: { name: 'Canopy' },
        homepage: 'https://example.test/alpha',
        mcpServers: './.mcp.json',
      });
      expect(
        readJsonFile(join(pluginDir('alpha'), '.codex-plugin', 'plugin.json')),
      ).toMatchObject({
        name: 'alpha',
        skills: './skills/',
        interface: { displayName: 'alpha display' },
      });
    });

    it('is discoverable by the real plugin scanner for both providers', async () => {
      mockResolveCuratedMcpCatalogForSync.mockResolvedValue({
        status: 'verified',
        catalog: curatedMcpCatalog(['github']),
      });
      armCatalog([makePlugin('alpha', { mcpServers: ['github'] })]);
      await sync();

      for (const manifestKind of ['claude', 'codex'] as const) {
        const details = scanPluginDetails(pluginDir('alpha'), {
          manifestKind,
        });
        expect(details.skills).toEqual([
          {
            name: 'alpha-skill',
            description: 'The alpha skill (v1).',
            path: join('skills', 'alpha-skill'),
          },
        ]);
        expect(details.mcpServers).toEqual([
          { name: 'github', type: 'http', url: `${MCP_URL_PREFIX}github` },
        ]);
      }
    });
  });
});

function manifestNames(content: string): string[] {
  const parsed: unknown = JSON.parse(content);
  if (!isRecord(parsed) || !Array.isArray(parsed.plugins)) return [];
  return parsed.plugins.map((plugin) =>
    isRecord(plugin) && typeof plugin.name === 'string' ? plugin.name : '',
  );
}
