// CAN-3817: the typed core.workspace.plugins.update boundary. Runs the real
// manifest repository and persistence modules against a temporary data dir.
jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordAppDiagnostic: jest.fn(),
  })),
}));
jest.mock('../../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(),
}));
jest.mock('../desktop-telemetry', () => ({
  recordWorkspaceCrudTelemetry: jest.fn(),
}));
// Recommended plugin installs reach the network; the boundary does not.
jest.mock('../canopy-json', () => ({
  getCanopyJsonPath: jest.fn(),
  readCanopyJson: jest.fn(),
}));
jest.mock('../../plugins/shareable-plugin-resolution', () => ({
  loadShareablePluginCatalog: jest.fn(),
  matchShareablePluginRef: jest.fn(),
}));
jest.mock('../../skills/skill-service', () => ({
  installSkills: jest.fn(),
}));
jest.mock('../../plugins/plugin-service', () => ({
  addMarketplace: jest.fn(),
  installPlugin: jest.fn(),
  loadMarketplaces: jest.fn(),
  refreshMarketplaces: jest.fn(),
}));
jest.mock('../../pipelines/pipeline-package-service', () => ({
  evaluatePipelinePackageRequirements: jest.fn(() =>
    Promise.resolve({ requirements: [] }),
  ),
  probePipelinePackageRequirement: jest.fn(),
}));
// The MCP server move also rewrites global defaults and saved chats.
jest.mock('../preferences-store', () => ({
  projectPreferencesForRuntime: (value: unknown): unknown => value,
  updatePreferencesFile: jest.fn(() => Promise.resolve({})),
}));
jest.mock('../preferences-broadcast', () => ({
  broadcastPreferencesSynced: jest.fn(),
}));
jest.mock('../../agents/session-manager', () => ({
  bumpGlobalPluginDefaultsRevision: jest.fn(),
}));
jest.mock('../../services/chat-state-service', () => ({
  getChatStateService: (): object => ({
    updateCompatibilityTab: jest.fn(),
    updateCompatibilityTabs: jest.fn(),
  }),
}));

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  ChatTabPluginSelections,
  WorkspaceOwnerBinding,
} from '@canopy/desktop-shared/types';
import { rewriteMcpServerRefs } from '../../mcp/server-ref-rewrite';
import {
  loadShareablePluginCatalog,
  matchShareablePluginRef,
} from '../../plugins/shareable-plugin-resolution';
import { installSkills } from '../../skills/skill-service';
import { readCanopyJson } from '../canopy-json';
import { recordWorkspaceCrudTelemetry } from '../desktop-telemetry';
import { getWorkspaceConfigPath } from '../paths';
import { applyRecommendedPlugins } from '../recommended-plugins';
import {
  getWorkspaceManifestRepository,
  readProjectPluginDefaults,
  setBeforeProjectPluginDefaultsChangeHandler,
  updateWorkspaceConfig,
  updateWorkspaceOwnership,
} from '../workspace-persistence';
import {
  updateWorkspacePlugins,
  WorkspacePluginsRefusedError,
  type WorkspacePluginsChange,
} from '../workspace-plugin-defaults';
import { defaultForkCapabilityInstallDependencies } from '../../shared-containers/capability-package/install';

const WORKSPACE_ID = 'plugins-ws';

const OWNER: WorkspaceOwnerBinding = {
  type: 'organization',
  organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  projectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  instanceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  bindingGeneration: 1,
};

const ADDED_REPO = {
  id: 'repo-added',
  name: 'Added',
  repoPath: '/repos/added',
};

const SKILL_KEY = 'skill:github:org/skills:reviewer';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function selections(
  overrides: Partial<ChatTabPluginSelections> = {},
): ChatTabPluginSelections {
  return { collectionIds: [], skillRefs: [], pluginRefs: [], ...overrides };
}

async function readManifest(): Promise<JsonRecord> {
  const parsed: unknown = JSON.parse(
    await readFile(getWorkspaceConfigPath(WORKSPACE_ID), 'utf8'),
  );
  if (!isRecord(parsed)) throw new Error('Expected a manifest object');
  return parsed;
}

async function seedManifest(extra: JsonRecord = {}): Promise<void> {
  const manifestPath = getWorkspaceConfigPath(WORKSPACE_ID);
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(
    manifestPath,
    JSON.stringify({
      version: 1,
      type: 'multi-repo',
      repos: [{ id: 'repo-a', name: 'Repo A', repoPath: '/repos/a' }],
      alwaysShow: true,
      futureManifestField: { kept: true },
      ...extra,
    }),
  );
}

/** A repository and ownership change another writer commits concurrently. */
async function commitConcurrentRepositoryAndOwnership(): Promise<void> {
  await updateWorkspaceConfig(WORKSPACE_ID, (config): void => {
    config.repos.push({ ...ADDED_REPO });
  });
  await updateWorkspaceOwnership(WORKSPACE_ID, () => ({ owner: OWNER }));
}

async function expectConcurrentDataKept(): Promise<void> {
  const manifest = await readManifest();
  expect(manifest.repos).toEqual([
    { id: 'repo-a', name: 'Repo A', repoPath: '/repos/a' },
    ADDED_REPO,
  ]);
  expect(manifest.owner).toEqual(OWNER);
  expect(manifest.futureManifestField).toEqual({ kept: true });
}

/**
 * Holds this workspace's manifest queue with a repository and ownership
 * change until `release`, and resolves `queued` once another task waits
 * behind it, so a writer that read before the queue cannot hide it.
 */
function holdManifestQueue(): {
  held: Promise<void>;
  queued: Promise<void>;
  release: () => void;
} {
  const repository = getWorkspaceManifestRepository();
  const original = repository.serialize.bind(repository);
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let notifyQueued = (): void => undefined;
  const queued = new Promise<void>((resolve) => {
    notifyQueued = resolve;
  });
  let calls = 0;
  jest
    .spyOn(repository, 'serialize')
    .mockImplementation(<T>(workspaceId: string, work: () => Promise<T>) => {
      calls += 1;
      const result = original(workspaceId, work);
      if (calls === 2) notifyQueued();
      return result;
    });
  const held = updateWorkspaceConfig(
    WORKSPACE_ID,
    async (config): Promise<void> => {
      await gate;
      config.repos.push({ ...ADDED_REPO });
      config.owner = OWNER;
    },
    { ownership: 'replace' },
  );
  return { held, queued, release };
}

async function expectRefusal(
  promise: Promise<unknown>,
  reason: WorkspacePluginsRefusedError['reason'],
  message: RegExp,
): Promise<void> {
  const error: unknown = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(WorkspacePluginsRefusedError);
  expect(error).toMatchObject({ reason });
  expect(error instanceof Error ? error.message : '').toMatch(message);
}

function update(
  change: WorkspacePluginsChange,
): ReturnType<typeof updateWorkspacePlugins> {
  return updateWorkspacePlugins({
    workspaceId: WORKSPACE_ID,
    change,
    source: 'workspace_settings',
  });
}

describe('workspace plugins boundary (real fs)', () => {
  let dataDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    originalDataDir = process.env.CANOPY_DATA_DIR;
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'canopy-ws-plugins-'));
    process.env.CANOPY_DATA_DIR = dataDir;
    await seedManifest();
    jest.clearAllMocks();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    setBeforeProjectPluginDefaultsChangeHandler(undefined);
    if (originalDataDir === undefined) {
      delete process.env.CANOPY_DATA_DIR;
    } else {
      process.env.CANOPY_DATA_DIR = originalDataDir;
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  describe('setDefaults', () => {
    it('replaces the default selections and keeps every other field', async () => {
      const defaults = selections({
        skillRefs: [{ sourceId: 'github-org-skills', skillName: 'review' }],
      });

      const outcome = await update({
        kind: 'setDefaults',
        defaultPluginSelections: defaults,
      });

      expect(outcome).toMatchObject({
        workspaceId: WORKSPACE_ID,
        written: true,
      });
      const manifest = await readManifest();
      expect(manifest.defaultPluginSelections).toMatchObject({
        skillRefs: [{ sourceId: 'github-org-skills', skillName: 'review' }],
      });
      expect(manifest.futureManifestField).toEqual({ kept: true });
      expect(manifest.alwaysShow).toBe(true);
      expect(recordWorkspaceCrudTelemetry).toHaveBeenCalledWith({
        action: 'update',
        workspaceId: WORKSPACE_ID,
        source: 'default_plugins',
      });
    });

    it('runs the pre-change normalization and refreshes the cached project layer', async () => {
      const before = selections({
        pluginRefs: [{ marketplaceId: 'm', pluginName: 'old' }],
      });
      await update({ kind: 'setDefaults', defaultPluginSelections: before });
      expect(
        (await readProjectPluginDefaults(WORKSPACE_ID)).defaultPluginSelections
          ?.pluginRefs,
      ).toEqual([{ marketplaceId: 'm', pluginName: 'old' }]);
      const preChange = jest.fn(() => Promise.resolve());
      setBeforeProjectPluginDefaultsChangeHandler(preChange);

      await update({
        kind: 'setDefaults',
        defaultPluginSelections: selections({
          pluginRefs: [{ marketplaceId: 'm', pluginName: 'new' }],
        }),
      });

      expect(preChange).toHaveBeenCalledWith(
        WORKSPACE_ID,
        expect.objectContaining({
          pluginRefs: [{ marketplaceId: 'm', pluginName: 'old' }],
        }),
        undefined,
      );
      expect(
        (await readProjectPluginDefaults(WORKSPACE_ID)).defaultPluginSelections
          ?.pluginRefs,
      ).toEqual([{ marketplaceId: 'm', pluginName: 'new' }]);
    });

    it('applies after an earlier queued write instead of over it', async () => {
      const { held, queued, release } = holdManifestQueue();
      const pending = update({
        kind: 'setDefaults',
        defaultPluginSelections: selections(),
      });
      await queued;
      release();
      await Promise.all([held, pending]);

      await expectConcurrentDataKept();
    });
  });

  describe('selectRecommended', () => {
    beforeEach(() => {
      jest.mocked(readCanopyJson).mockResolvedValue({
        version: 1,
        plugins: [
          {
            type: 'skill',
            source: { type: 'github', repo: 'org/skills' },
            skill_name: 'reviewer',
          },
        ],
      });
      jest
        .mocked(loadShareablePluginCatalog)
        .mockResolvedValue({ skills: [], marketplaces: [] });
    });

    it('keeps repository and ownership changes committed during the install', async () => {
      let installed = false;
      jest.mocked(installSkills).mockImplementation(async () => {
        // Another writer lands while the network install runs.
        await commitConcurrentRepositoryAndOwnership();
        installed = true;
        return { success: true, data: undefined };
      });
      jest.mocked(matchShareablePluginRef).mockImplementation((ref) =>
        installed
          ? {
              matchState: 'matched',
              ref,
              catalogKey: 'github-org-skills/reviewer',
              selection: {
                kind: 'skill',
                sourceId: 'github-org-skills',
                skillName: 'reviewer',
              },
            }
          : {
              matchState: 'unmatched',
              ref,
              displayName: 'reviewer',
              displaySource: 'org/skills',
            },
      );

      const response = await applyRecommendedPlugins({
        workspaceId: WORKSPACE_ID,
        worktreeId: 'wt-1',
        selectedKeys: [SKILL_KEY],
        optOutKeys: ['skill:github:org/other:thing'],
      });

      expect(response.defaultPluginSelections.skillRefs).toEqual([
        { sourceId: 'github-org-skills', skillName: 'reviewer' },
      ]);
      expect(response.recommendedPluginOptOutKeys).toEqual([
        'skill:github:org/other:thing',
      ]);
      await expectConcurrentDataKept();
      const manifest = await readManifest();
      expect(manifest.defaultPluginSelections).toMatchObject({
        skillRefs: [{ sourceId: 'github-org-skills', skillName: 'reviewer' }],
      });
      expect(manifest.recommendedPluginOptOutKeys).toEqual([
        'skill:github:org/other:thing',
      ]);
    });

    it('merges into the defaults and opt-outs current when it writes', async () => {
      await seedManifest({
        defaultPluginSelections: selections({
          pluginRefs: [{ marketplaceId: 'm', pluginName: 'kept' }],
        }),
        recommendedPluginOptOutKeys: ['stale', SKILL_KEY],
      });

      const outcome = await update({
        kind: 'selectRecommended',
        selections: [
          { kind: 'skill', sourceId: 'builtin', skillName: 'review' },
          { kind: 'plugin', marketplaceId: 'm', pluginName: 'kept' },
        ],
        optOutKeys: ['new-opt-out'],
        clearOptOutKeys: ['stale', SKILL_KEY],
      });

      expect(outcome.defaultPluginSelections).toEqual({
        collectionIds: [],
        skillRefs: [{ sourceId: 'builtin', skillName: 'review' }],
        pluginRefs: [{ marketplaceId: 'm', pluginName: 'kept' }],
        mcpServerRefs: [],
        mcpHttpAuthPreferences: [],
      });
      expect(outcome.recommendedPluginOptOutKeys).toEqual(['new-opt-out']);
      expect((await readManifest()).recommendedPluginOptOutKeys).toEqual([
        'new-opt-out',
      ]);
    });

    it('drops the opt-out list when nothing is opted out', async () => {
      await seedManifest({ recommendedPluginOptOutKeys: ['old'] });

      const outcome = await update({
        kind: 'selectRecommended',
        selections: [],
        optOutKeys: [],
        clearOptOutKeys: ['old'],
      });

      expect(outcome.recommendedPluginOptOutKeys).toEqual([]);
      expect(await readManifest()).not.toHaveProperty(
        'recommendedPluginOptOutKeys',
      );
    });
  });

  describe('replaceMcpServerRefs', () => {
    const device = { serverId: 'dev-1', configId: 'cfg-1' };
    const cloud = { serverId: 'custom:abc', configId: 'default' };

    it('keeps repository and ownership changes queued before the move', async () => {
      await seedManifest({
        defaultPluginSelections: selections({ mcpServerRefs: [device] }),
      });
      const { held, queued, release } = holdManifestQueue();

      const pending = rewriteMcpServerRefs({
        from: [{ serverId: 'dev-1' }],
        to: cloud,
      });
      await queued;
      release();
      const [, response] = await Promise.all([held, pending]);

      expect(response.workspaces).toBe(1);
      await expectConcurrentDataKept();
      expect((await readManifest()).defaultPluginSelections).toMatchObject({
        mcpServerRefs: [cloud],
      });
    });

    it('rewrites defaults and tombstones and leaves an unaffected manifest alone', async () => {
      await seedManifest({
        defaultPluginSelections: selections({ mcpServerRefs: [device] }),
        disabledGlobalPluginSelections: {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [device],
        },
      });

      const moved = await update({
        kind: 'replaceMcpServerRefs',
        from: [{ serverId: 'dev-1' }],
        to: cloud,
      });
      const unaffected = await update({
        kind: 'replaceMcpServerRefs',
        from: [{ serverId: 'other' }],
        to: cloud,
      });

      expect(moved.written).toBe(true);
      expect(unaffected.written).toBe(false);
      const manifest = await readManifest();
      expect(manifest.defaultPluginSelections).toMatchObject({
        mcpServerRefs: [cloud],
      });
      expect(manifest.disabledGlobalPluginSelections).toMatchObject({
        mcpServerRefs: [cloud],
      });
    });
  });

  describe('removeSelections', () => {
    const added = { sourceId: 'custom:app', skillName: 'helper' };
    const mine = { sourceId: 'custom:app', skillName: 'mine' };

    it('removes only the named selections and keeps every other field', async () => {
      await seedManifest({
        defaultPluginSelections: selections({
          skillRefs: [added, mine],
          pluginRefs: [{ marketplaceId: 'm', pluginName: 'kept' }],
        }),
      });

      const outcome = await updateWorkspacePlugins({
        workspaceId: WORKSPACE_ID,
        change: {
          kind: 'removeSelections',
          selections: [{ kind: 'skill', ...added }],
        },
        source: 'shared_container_fork',
      });

      expect(outcome.written).toBe(true);
      const manifest = await readManifest();
      expect(manifest.defaultPluginSelections).toMatchObject({
        skillRefs: [mine],
        pluginRefs: [{ marketplaceId: 'm', pluginName: 'kept' }],
      });
      expect(manifest.futureManifestField).toEqual({ kept: true });
      expect(recordWorkspaceCrudTelemetry).not.toHaveBeenCalled();
    });

    it('writes nothing when no named selection is a default', async () => {
      await seedManifest({
        defaultPluginSelections: selections({ skillRefs: [mine] }),
      });
      const before = await readFile(
        getWorkspaceConfigPath(WORKSPACE_ID),
        'utf8',
      );

      const outcome = await update({
        kind: 'removeSelections',
        selections: [{ kind: 'skill', ...added }],
      });

      expect(outcome.written).toBe(false);
      expect(await readFile(getWorkspaceConfigPath(WORKSPACE_ID), 'utf8')).toBe(
        before,
      );
    });

    it('treats a fork destination that is gone as having nothing to remove', async () => {
      await rm(getWorkspaceConfigPath(WORKSPACE_ID));

      await expect(
        defaultForkCapabilityInstallDependencies().removeDefaultSkills(
          WORKSPACE_ID,
          [added],
        ),
      ).resolves.toBeUndefined();
      await expect(
        readFile(getWorkspaceConfigPath(WORKSPACE_ID), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('keeps a defaults change committed while a fork compensation waited', async () => {
      await seedManifest({
        defaultPluginSelections: selections({ skillRefs: [added] }),
      });
      // Another writer adds a plugin default and holds the manifest queue
      // until the fork's compensation is queued behind it.
      const repository = getWorkspaceManifestRepository();
      const original = repository.serialize.bind(repository);
      let release = (): void => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let notifyQueued = (): void => undefined;
      const queued = new Promise<void>((resolve) => {
        notifyQueued = resolve;
      });
      let calls = 0;
      jest
        .spyOn(repository, 'serialize')
        .mockImplementation(
          <T>(workspaceId: string, work: () => Promise<T>) => {
            calls += 1;
            const result = original(workspaceId, work);
            if (calls === 2) notifyQueued();
            return result;
          },
        );
      const held = updateWorkspaceConfig(
        WORKSPACE_ID,
        async (config): Promise<void> => {
          await gate;
          config.defaultPluginSelections = {
            ...selections(config.defaultPluginSelections),
            pluginRefs: [{ marketplaceId: 'm', pluginName: 'concurrent' }],
          };
        },
      );

      const pending =
        defaultForkCapabilityInstallDependencies().removeDefaultSkills(
          WORKSPACE_ID,
          [added],
        );
      await queued;
      release();
      await Promise.all([held, pending]);

      expect((await readManifest()).defaultPluginSelections).toMatchObject({
        skillRefs: [],
        pluginRefs: [{ marketplaceId: 'm', pluginName: 'concurrent' }],
      });
    });
  });

  describe('pruneMarketplace', () => {
    it('removes the marketplace plugin refs and keeps unknown fields', async () => {
      await seedManifest({
        defaultPluginSelections: selections({
          pluginRefs: [
            { marketplaceId: 'gone', pluginName: 'a' },
            { marketplaceId: 'kept', pluginName: 'b' },
          ],
        }),
      });

      const outcome = await update({
        kind: 'pruneMarketplace',
        marketplaceId: 'gone',
      });

      expect(outcome.written).toBe(true);
      const manifest = await readManifest();
      expect(manifest.defaultPluginSelections).toMatchObject({
        pluginRefs: [{ marketplaceId: 'kept', pluginName: 'b' }],
      });
      expect(manifest.futureManifestField).toEqual({ kept: true });
      expect(
        (await readProjectPluginDefaults(WORKSPACE_ID)).defaultPluginSelections
          ?.pluginRefs,
      ).toEqual([{ marketplaceId: 'kept', pluginName: 'b' }]);
    });

    it('writes nothing when no ref names the marketplace', async () => {
      const outcome = await update({
        kind: 'pruneMarketplace',
        marketplaceId: 'gone',
      });

      expect(outcome.written).toBe(false);
    });
  });

  describe('refusals write nothing', () => {
    const changes: Array<[string, WorkspacePluginsChange]> = [
      [
        'setDefaults',
        { kind: 'setDefaults', defaultPluginSelections: selections() },
      ],
      [
        'selectRecommended',
        {
          kind: 'selectRecommended',
          selections: [],
          optOutKeys: ['x'],
          clearOptOutKeys: [],
        },
      ],
      [
        'replaceMcpServerRefs',
        {
          kind: 'replaceMcpServerRefs',
          from: [{ serverId: 'dev-1' }],
          to: { serverId: 'custom:abc', configId: 'default' },
        },
      ],
      ['pruneMarketplace', { kind: 'pruneMarketplace', marketplaceId: 'gone' }],
      [
        'removeSelections',
        {
          kind: 'removeSelections',
          selections: [
            { kind: 'skill', sourceId: 'custom:app', skillName: 'helper' },
          ],
        },
      ],
    ];

    it.each(changes)(
      'refuses %s while the manifest is unreadable',
      async (_name, change) => {
        const manifestPath = getWorkspaceConfigPath(WORKSPACE_ID);
        await writeFile(manifestPath, '{"version":1,');

        await expectRefusal(
          update(change),
          'configuration-unavailable',
          /could not be read/,
        );

        expect(await readFile(manifestPath, 'utf8')).toBe('{"version":1,');
      },
    );

    it.each(changes)(
      'refuses %s for a workspace without a manifest',
      async (_name, change) => {
        await rm(getWorkspaceConfigPath(WORKSPACE_ID));

        await expectRefusal(update(change), 'not-found', /not found/);

        await expect(
          readFile(getWorkspaceConfigPath(WORKSPACE_ID), 'utf8'),
        ).rejects.toMatchObject({ code: 'ENOENT' });
      },
    );

    it('refuses default selections that are not an object', async () => {
      const change: WorkspacePluginsChange = {
        kind: 'setDefaults',
        defaultPluginSelections: selections(),
      };
      Reflect.set(change, 'defaultPluginSelections', 'all');

      await expectRefusal(update(change), 'invalid-change', /plugins/);

      expect(await readManifest()).not.toHaveProperty(
        'defaultPluginSelections',
      );
    });
  });
});
