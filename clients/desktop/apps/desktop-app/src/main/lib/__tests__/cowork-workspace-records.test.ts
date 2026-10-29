jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({ recordAppDiagnostic: jest.fn() })),
}));
jest.mock('../../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(),
}));
jest.mock('../window-send', () => ({ sendToAllWindows: jest.fn() }));
jest.mock('../worktree-data-cleanup', () => ({
  cleanupPersistedWorktreeData: jest.fn(),
}));
jest.mock('../archived-containers', () => {
  // A real per-workspace lock, so lock-order inversions can deadlock here.
  const tails = new Map<string, Promise<unknown>>();
  return {
    countArchivedContainers: jest.fn(() => Promise.resolve(0)),
    withArchivedWorkspaceOperationLock: jest.fn(
      (id: string, work: () => Promise<unknown>) => {
        const run = (tails.get(id) ?? Promise.resolve()).then(work, work);
        tails.set(
          id,
          run.catch(() => undefined),
        );
        return run;
      },
    ),
  };
});
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as sidebar from '../sidebar-items';
import { getWorkspaceConfigPath, getWorkspaceIndexFilePath } from '../paths';
import { updateWorkspaceConfig } from '../workspace-persistence';
import {
  clearCoworkWorkspaceTemplateShare,
  setCoworkWorkspaceTemplatePublicationKey,
  setCoworkWorkspaceTemplateShareMetadata,
  updateCoworkWorkspace,
} from '../cowork-workspace-crud';
import { withArchivedWorkspaceOperationLock } from '../archived-containers';
import { serializeWorkspaceMutation } from '../chat-project-operation-queue';

import { isRecord } from '../type-guards';
async function readJson(file: string): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (!isRecord(parsed)) throw new Error('Expected a JSON object');
  return parsed;
}
async function indexIds(): Promise<string[]> {
  const parsed = await readJson(getWorkspaceIndexFilePath());
  if (!Array.isArray(parsed.workspaces)) throw new Error('Expected workspaces');
  return parsed.workspaces.map((entry: unknown): string => {
    if (!isRecord(entry) || typeof entry.id !== 'string')
      throw new Error('Expected id');
    return entry.id;
  });
}
let dataDir: string;
let previous: string | undefined;
beforeEach(async () => {
  previous = process.env.CANOPY_DATA_DIR;
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'canopy-cowork-records-'));
  process.env.CANOPY_DATA_DIR = dataDir;
  sidebar.__resetSidebarItemsStateForTests();
  await mkdir(path.dirname(getWorkspaceConfigPath('one')), { recursive: true });
  await writeFile(
    getWorkspaceConfigPath('one'),
    JSON.stringify({
      version: 1,
      type: 'cowork',
      repos: [],
      cowork: { description: 'original', archiveRetentionDays: 7 },
    }),
  );
  await sidebar.getWorkspaceIndexRepository().update(() => ({
    result: undefined,
    entries: [
      {
        id: 'one',
        name: 'One',
        type: 'cowork',
        color: '#7C3AED',
        collapsed: false,
        order: 0,
      },
    ],
  }));
});
afterEach(async () => {
  jest.restoreAllMocks();
  if (previous === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = previous;
  await rm(dataDir, { recursive: true, force: true });
});

it('applies metadata without saving a stale projection over other fields or another workspace', async () => {
  const stale = await sidebar.readAllSidebarItems();
  await updateWorkspaceConfig('one', (config) => {
    config.cowork = { ...config.cowork, description: 'concurrent' };
  });
  await sidebar.getWorkspaceIndexRepository().update(({ entries }) => ({
    result: undefined,
    entries: [
      ...entries,
      {
        id: 'other',
        name: 'Other',
        type: 'cowork',
        color: '#0EA5E9',
        collapsed: false,
        order: 1,
      },
    ],
  }));
  jest.spyOn(sidebar, 'readAllSidebarItems').mockResolvedValueOnce(stale);
  await setCoworkWorkspaceTemplatePublicationKey('one', 'publication');
  expect(
    JSON.parse(await readFile(getWorkspaceConfigPath('one'), 'utf8')),
  ).toMatchObject({
    cowork: { description: 'concurrent' },
    sharedTemplatePublicationKey: 'publication',
  });
  expect(await indexIds()).toEqual(['one', 'other']);
});

import {
  recordCoworkTemplateShare,
  recordCoworkWorkspaceMetadata,
  recordNewCoworkWorkspace,
  recordStagedCoworkWorkspace,
  publishCoworkWorkspaceRecord,
  discardCoworkWorkspaceRecord,
  provisionCoworkWorkspaceRecord,
  recordMigratedCoworkWorkspace,
  renameDefaultCoworkWorkspaceRecord,
} from '../cowork-workspace-records';
import { setWorktreeRegistryReconciler } from '../workspace-persistence';
import { getWorkspaceWorktreesFilePath } from '../paths';
import type { WorkspaceOwnerBinding } from '@canopy/desktop-shared/types';
const owner: WorkspaceOwnerBinding = {
  type: 'organization',
  organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  projectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  instanceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  bindingGeneration: 1,
};
const writers = {
  metadata: (workspaceId = 'one'): Promise<void> =>
    recordCoworkWorkspaceMetadata({
      source: 'template_install',
      workspaceId,
      change: { kind: 'install', externalId: 'template', contentHash: 'hash' },
    }),
  'template share': (workspaceId = 'one'): Promise<void> =>
    recordCoworkTemplateShare({
      source: 'template_share_publish',
      workspaceId,
      change: { kind: 'publication', publicationKey: 'key' },
    }),
};

it.each(
  (['metadata', 'template share'] as const).flatMap((writer) =>
    (
      [
        'manifest',
        'index',
        'missing-manifest',
        'missing-entry',
        'partial-index',
        'code-manifest',
      ] as const
    ).map((failure) => [writer, failure] as const),
  ),
)('%s refuses %s without changing persisted bytes', async (writer, failure) => {
  if (failure === 'manifest')
    await writeFile(getWorkspaceConfigPath('one'), 'broken');
  if (failure === 'index')
    await writeFile(getWorkspaceIndexFilePath(), 'broken');
  if (failure === 'missing-manifest') await rm(getWorkspaceConfigPath('one'));
  if (failure === 'missing-entry')
    await writeFile(
      getWorkspaceIndexFilePath(),
      '{"version":1,"workspaces":[]}',
    );
  if (failure === 'partial-index')
    await writeFile(
      getWorkspaceIndexFilePath(),
      '{"version":1,"workspaces":[{"id":"one"}]}',
    );
  if (failure === 'code-manifest')
    await writeFile(
      getWorkspaceConfigPath('one'),
      '{"version":1,"type":"single-repo","repos":[]}',
    );
  const beforeIndex = await readFile(getWorkspaceIndexFilePath(), 'utf8');
  const beforeManifest = await readFile(
    getWorkspaceConfigPath('one'),
    'utf8',
  ).catch(() => null);
  await expect(writers[writer]()).rejects.toMatchObject({
    reason:
      failure === 'manifest'
        ? 'configuration-unavailable'
        : failure.includes('index')
          ? 'index-unavailable'
          : 'not-found',
  });
  expect(await readFile(getWorkspaceIndexFilePath(), 'utf8')).toBe(beforeIndex);
  expect(
    await readFile(getWorkspaceConfigPath('one'), 'utf8').catch(() => null),
  ).toBe(beforeManifest);
});

it('keeps nested unknown settings and concurrent queued writes, and clears only the share fields it owns', async () => {
  await writeFile(
    getWorkspaceConfigPath('one'),
    JSON.stringify({
      version: 1,
      type: 'cowork',
      repos: [],
      future: true,
      cowork: { description: 'keep', futureSetting: true },
      sharedTemplatePublicationKey: 'old',
    }),
  );
  await Promise.all([
    recordCoworkWorkspaceMetadata({
      source: 'template_install',
      workspaceId: 'one',
      change: { kind: 'install', externalId: 'template', contentHash: 'hash' },
    }),
    recordCoworkTemplateShare({
      source: 'template_share_revoke',
      workspaceId: 'one',
      change: { kind: 'share', metadata: null },
    }),
    recordCoworkWorkspaceMetadata({
      source: 'chat_project_update',
      workspaceId: 'one',
      change: {
        kind: 'settings',
        request: {
          projectId: 'one',
          name: 'Renamed',
          startPage: null,
          description: 'changed',
        },
      },
    }),
  ]);
  const result = await readJson(getWorkspaceConfigPath('one'));
  expect(result).toMatchObject({
    future: true,
    installedFromTemplateExternalId: 'template',
    cowork: { description: 'changed', futureSetting: true },
  });
  expect(result).not.toHaveProperty('sharedTemplatePublicationKey');
  expect(await readJson(getWorkspaceIndexFilePath())).toMatchObject({
    workspaces: [{ name: 'Renamed' }],
  });
});

const KEY = 'a3c7b87a-a05a-4787-a9a4-38c930d80aef';
const HASH = 'a'.repeat(64);
it.each([
  [
    'with Cowork settings',
    { cowork: { description: 'keep', futureSetting: true } },
    { futureSetting: true, description: 'keep' },
  ],
  ['without Cowork settings', {}, {}],
  ['with malformed Cowork settings', { cowork: 'broken' }, {}],
])(
  'records template share identity %s with unchanged manifest bytes and no index write',
  async (_label, fields, cowork) => {
    await writeFile(
      getWorkspaceConfigPath('one'),
      JSON.stringify({
        version: 1,
        type: 'cowork',
        repos: [],
        future: true,
        alwaysShow: true,
        ...fields,
      }),
    );
    const index = await readFile(getWorkspaceIndexFilePath(), 'utf8');
    const manifest = (): Promise<string> =>
      readFile(getWorkspaceConfigPath('one'), 'utf8');
    const bytes = (share: Record<string, string>): string =>
      JSON.stringify(
        {
          version: 1,
          type: 'cowork',
          repos: [],
          cowork,
          ...share,
          alwaysShow: true,
          future: true,
        },
        null,
        2,
      );

    await setCoworkWorkspaceTemplatePublicationKey('one', KEY);
    expect(await manifest()).toBe(bytes({ sharedTemplatePublicationKey: KEY }));
    await setCoworkWorkspaceTemplateShareMetadata('one', {
      externalId: 'share',
      pinnedContentHash: HASH,
    });
    expect(await manifest()).toBe(
      bytes({
        sharedTemplatePublicationKey: KEY,
        sharedTemplateExternalId: 'share',
        sharedTemplateContentHash: HASH,
      }),
    );
    await clearCoworkWorkspaceTemplateShare('one', 'template_share_revoke');
    expect(await manifest()).toBe(bytes({}));

    // Get's observation and publish's account-switch reset clear the same fields.
    for (const source of [
      'template_share_get',
      'template_share_publish',
    ] as const) {
      await setCoworkWorkspaceTemplatePublicationKey('one', KEY);
      await setCoworkWorkspaceTemplateShareMetadata('one', {
        externalId: 'share',
        pinnedContentHash: HASH,
      });
      await clearCoworkWorkspaceTemplateShare('one', source);
      expect(await manifest()).toBe(bytes({}));
    }
    expect(await readFile(getWorkspaceIndexFilePath(), 'utf8')).toBe(index);
  },
);

it('types a template share record without a key or revision, and only a clear from revoke or get', () => {
  const typeOnly = (): void => {
    void recordCoworkTemplateShare({
      source: 'template_share_get',
      workspaceId: 'one',
      // @ts-expect-error Get only clears.
      change: { kind: 'publication', publicationKey: KEY },
    });
    // @ts-expect-error Revoke only clears.
    void recordCoworkTemplateShare({
      source: 'template_share_revoke',
      workspaceId: 'one',
      change: {
        kind: 'share',
        metadata: { externalId: 'share', pinnedContentHash: HASH },
      },
    });
    void recordCoworkTemplateShare({
      source: 'template_share_publish',
      workspaceId: 'one',
      change: { kind: 'publication', publicationKey: KEY },
      // @ts-expect-error The record takes no key.
      idempotencyKey: 'key',
    });
    // @ts-expect-error Clearing takes no options.
    void clearCoworkWorkspaceTemplateShare('one', 'template_share_get', {});
  };
  expect(typeOnly).toEqual(expect.any(Function));
});

it('creates, stages, publishes and discards only its own identity without reconciling code worktree groups', async () => {
  const unrelatedManifest = await readFile(
    getWorkspaceConfigPath('one'),
    'utf8',
  );
  const listPath = getWorkspaceWorktreesFilePath('one');
  await writeFile(listPath, '{"version":1,"worktrees":[],"future":true}');
  const groups = jest.fn(() =>
    Promise.reject(new Error('group reconciliation failed')),
  );
  setWorktreeRegistryReconciler(groups);
  const first = await recordNewCoworkWorkspace({
    source: 'external_import',
    name: 'Folder',
    createdAt: '2026-01-01T00:00:00.000Z',
    externalPath: '/user/folder',
  });
  const second = await recordNewCoworkWorkspace({
    source: 'managed_create',
    name: 'Folder',
    createdAt: '2026-01-02T00:00:00.000Z',
  });
  expect(second.id).toBe('folder-2');
  await recordStagedCoworkWorkspace({
    source: 'org_cowork_stage',
    item: {
      id: 'staged',
      name: 'Staged',
      type: 'cowork',
      color: '#7C3AED',
      collapsed: false,
      order: 0,
      externalPath: '/user/folder',
      owner,
    },
  });
  await discardCoworkWorkspaceRecord({
    source: 'org_cowork_discard',
    workspaceId: 'staged',
    projectId: 'other-project',
  });
  expect(await readFile(getWorkspaceConfigPath('staged'), 'utf8')).toContain(
    owner.projectId,
  );
  await publishCoworkWorkspaceRecord({
    source: 'org_cowork_publish',
    workspaceId: 'staged',
    name: 'Published',
    owner,
  });
  await discardCoworkWorkspaceRecord({
    source: 'org_cowork_discard',
    workspaceId: 'staged',
    projectId: owner.projectId,
  });
  expect(await readFile(getWorkspaceConfigPath('staged'), 'utf8')).toContain(
    owner.projectId,
  );
  await recordStagedCoworkWorkspace({
    source: 'org_cowork_stage',
    item: {
      id: 'unpublished',
      name: 'Unpublished',
      type: 'cowork',
      color: '#7C3AED',
      collapsed: false,
      order: 0,
      externalPath: '/user/folder',
      owner,
    },
  });
  await discardCoworkWorkspaceRecord({
    source: 'org_cowork_discard',
    workspaceId: 'unpublished',
    projectId: owner.projectId,
  });
  await expect(
    readFile(getWorkspaceConfigPath('unpublished')),
  ).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await indexIds()).toEqual(['one', first.id, second.id, 'staged']);
  expect(await readFile(getWorkspaceConfigPath('one'), 'utf8')).toBe(
    unrelatedManifest,
  );
  expect(await readFile(listPath, 'utf8')).toBe(
    '{"version":1,"worktrees":[],"future":true}',
  );
  expect(groups).not.toHaveBeenCalled();
});

it('migrates and provisions without using an earlier projection or rewriting other manifests and lists', async () => {
  const before = await readFile(getWorkspaceConfigPath('one'), 'utf8');
  const migrated = await recordMigratedCoworkWorkspace({
    source: 'legacy_cowork_migration',
    legacyId: 'legacy',
    candidateId: 'legacy',
    name: 'Legacy',
    cowork: { description: 'migrated' },
  });
  expect(migrated).toBe('legacy');
  expect(
    JSON.parse(await readFile(getWorkspaceConfigPath(migrated), 'utf8')),
  ).toMatchObject({ type: 'cowork', cowork: { description: 'migrated' } });
  await provisionCoworkWorkspaceRecord({
    source: 'default_cowork_provision',
    workspaceId: 'cowork-default',
  });
  await renameDefaultCoworkWorkspaceRecord({
    source: 'default_cowork_name_migration',
    workspaceId: migrated,
    name: 'New name',
    onlyWhenNamed: ['Legacy'],
  });
  expect(await readFile(getWorkspaceConfigPath('one'), 'utf8')).toBe(before);
  await expect(
    readFile(getWorkspaceWorktreesFilePath(migrated)),
  ).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await indexIds()).toEqual(['one', 'legacy', 'cowork-default']);
});

it('refuses invalid ids and a staging identity already owned by another project', async () => {
  for (const writer of Object.values(writers))
    await expect(writer('../escape')).rejects.toMatchObject({
      reason: 'invalid-request',
    });
  await updateWorkspaceConfig(
    'one',
    (config) => {
      config.owner = {
        ...owner,
        projectId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      };
    },
    { ownership: 'replace' },
  );
  const before = await readFile(getWorkspaceConfigPath('one'), 'utf8');
  await expect(
    recordStagedCoworkWorkspace({
      source: 'org_cowork_stage',
      item: {
        id: 'one',
        name: 'One',
        type: 'cowork',
        color: '#7C3AED',
        collapsed: false,
        order: 0,
        owner,
      },
    }),
  ).rejects.toMatchObject({
    reason: 'identity-changed',
    message: 'The local workspace id is already in use',
  });
  expect(await readFile(getWorkspaceConfigPath('one'), 'utf8')).toBe(before);
});

import { releaseAdoptedWorkspace } from '../workspace-ownership';
it.each(['metadata', 'template share'] as const)(
  'settles an adoption rollback alongside a Cowork %s commit without reversing their lock order',
  async (writer) => {
    await updateWorkspaceConfig(
      'one',
      (config) => {
        config.owner = owner;
      },
      { ownership: 'replace' },
    );
    let unlock: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    let entered: () => void = () => undefined;
    const locked = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocker = updateWorkspaceConfig('one', async () => {
      entered();
      await gate;
    });
    await locked;
    const release = releaseAdoptedWorkspace({
      source: 'org_project_adoption_rollback',
      workspaceId: 'one',
      instanceId: owner.type === 'organization' ? owner.instanceId : '',
    });
    const edit = writers[writer]().then(
      () => 'written',
      (error: unknown) =>
        error instanceof Error && 'reason' in error ? error.reason : error,
    );
    unlock();
    await blocker;
    expect(await release).toBe(true);
    expect(await edit).toBe('not-found');
  },
);

it('takes the workspace queue before the archive lock, as the IPC path does', async () => {
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // An IPC update holds the workspace queue, then needs the archive lock.
  const ipc = serializeWorkspaceMutation(async () => {
    await gate;
    await withArchivedWorkspaceOperationLock('one', () => Promise.resolve());
  });
  const direct = updateCoworkWorkspace({
    projectId: 'one',
    description: 'direct',
  });
  await new Promise((resolve) => setImmediate(resolve));
  release();
  const settled = await Promise.race([
    Promise.all([ipc, direct]).then(() => 'settled'),
    new Promise((resolve) => setTimeout(() => resolve('deadlocked'), 2000)),
  ]);
  expect(settled).toBe('settled');
});

it('carries over unknown Cowork settings but not malformed known ones', async () => {
  await writeFile(
    getWorkspaceConfigPath('one'),
    JSON.stringify({
      version: 1,
      type: 'cowork',
      repos: [],
      cowork: {
        description: 'original',
        presets: 'not-a-list',
        futureSetting: true,
      },
    }),
  );
  await updateCoworkWorkspace({ projectId: 'one', description: 'changed' });
  const cowork = (await readJson(getWorkspaceConfigPath('one'))).cowork;
  expect(cowork).toMatchObject({ description: 'changed', futureSetting: true });
  expect(isRecord(cowork) ? cowork.presets : undefined).not.toBe('not-a-list');
});

it('refuses to stage over an indexed workspace whose manifest is missing', async () => {
  // `one` is indexed; without its manifest nothing proves it belongs to this
  // organization project, so staging must not claim it.
  await rm(getWorkspaceConfigPath('one'));
  await expect(
    recordStagedCoworkWorkspace({
      source: 'org_cowork_stage',
      item: {
        id: 'one',
        name: 'One',
        type: 'cowork',
        color: '#7C3AED',
        collapsed: false,
        order: 0,
        owner,
      },
    }),
  ).rejects.toMatchObject({ reason: 'identity-changed' });
  await expect(readFile(getWorkspaceConfigPath('one'), 'utf8')).rejects.toThrow(
    /ENOENT/,
  );
});
