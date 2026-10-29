import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WORKSPACE_ROOT_REPO_ID,
  type WorktreeData,
} from '@canopy/desktop-shared/types';
import type {
  WorktreeReplicaState,
  WorktreeRepositoryReplica,
} from '@canopy/desktop-shared/worktree-replica';
import type {
  WorktreeListRepository,
  WorktreeListRead,
} from '../worktree-list-repository';
import type { LocalReplicaContext } from '../worktree-replica-record';
import { createWorktreeListRepository } from '../worktree-list-repository';
import { nodeW5FileStore } from '../w5-file-store';
import { withStorageAdmission, WORKTREE_LIST_STORAGE } from '../w5-storage';
import { parseWorktreeReplica } from '../worktree-replica-codec';

const unknownHead = { state: 'unknown' } as const;
const knownHead = { state: 'known', value: 'a'.repeat(40) } as const;
function repo(repoId = WORKSPACE_ROOT_REPO_ID): WorktreeRepositoryReplica {
  return {
    authorityId: 'local-desktop',
    workspaceId: 'workspace',
    worktreeId: 'tree',
    repoId,
    targetId: {
      primaryAuthorityId: 'local-desktop',
      targetId: 'in_process_worker',
    },
    replicaId: `replica-${repoId.replace(/_/g, '-')}`,
    remoteIdentity: { state: 'unknown' },
    branchName: { state: 'known', value: 'feature/replica' },
    baseOid: unknownHead,
    localHeadOid: unknownHead,
    observedRemoteHeadOid: unknownHead,
    expectedRemoteHeadOid: unknownHead,
    syncMode: { state: 'unconfigured' },
    syncState: 'not-yet-observed',
  };
}
function set(repositories: WorktreeRepositoryReplica[]): WorktreeReplicaState {
  return {
    state: 'recorded',
    primarySnapshotRevision: { state: 'known', value: 12 },
    repositories,
  };
}
function row(replica?: WorktreeReplicaState): WorktreeData {
  return {
    id: 'tree',
    branchName: 'feature/replica',
    createdAt: '2026-10-14',
    ...(replica ? { replica } : {}),
  };
}

let directory: string;
let file: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'can-3808-'));
  file = join(directory, 'worktrees.json');
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
function repository(recordIdentity = false): WorktreeListRepository {
  return createWorktreeListRepository({
    store: {
      read: (path) => nodeW5FileStore.read(path),
      replace: (path, contents, storage, replacement) =>
        withStorageAdmission([WORKTREE_LIST_STORAGE], () =>
          nodeW5FileStore.replace(path, contents, storage, replacement),
        ),
    },
    filePath: () => file,
    storage: { namespace: 'worktree_list', writer: 'electron_main' },
    knownRowFields: new Set([
      'id',
      'branchName',
      'createdAt',
      'replica',
      'label',
    ]),
    ...(recordIdentity
      ? {
          localReplicaContext: (): Promise<LocalReplicaContext> =>
            Promise.resolve({
              authorityId: 'local-desktop',
              targetId: 'in_process_worker',
              repoIds: ['child'],
            }),
        }
      : {}),
  });
}
async function readRows(): Promise<
  Extract<WorktreeListRead, { authority: 'ok' }>
> {
  const read = await repository().read('workspace');
  if (read.authority !== 'ok') throw new Error('Expected readable list');
  return read;
}

it.each([
  ['local-only', set([{ ...repo(), remoteIdentity: { state: 'local-only' } }])],
  ['never-observed', set([repo()])],
  [
    'known observations',
    set([
      {
        ...repo(),
        remoteIdentity: { state: 'known', value: `sha256:${'b'.repeat(64)}` },
        baseOid: knownHead,
        localHeadOid: { state: 'known', value: 'c'.repeat(64) },
        observedRemoteHeadOid: knownHead,
        expectedRemoteHeadOid: knownHead,
        syncState: 'ahead',
        syncMode: { state: 'configured', mode: 'handoff' },
      },
    ]),
  ],
  [
    'mixed repositories',
    set([
      { ...repo(), remoteIdentity: { state: 'local-only' } },
      {
        ...repo('child'),
        localHeadOid: knownHead,
        syncState: 'conflicted',
        syncMode: { state: 'configured', mode: 'isolated-branch' },
      },
    ]),
  ],
])(
  '%s survives write, restart and unrelated updates',
  async (_name, replica) => {
    await repository().replace('workspace', [row(replica)], {
      authority: 'absent',
    });
    const restarted = await readRows();
    expect(restarted.worktrees[0]?.replica).toEqual(replica);
    await repository().replace(
      'workspace',
      restarted.worktrees.map((entry) => ({ ...entry, label: 'Renamed' })),
      restarted,
    );
    expect((await readRows()).worktrees[0]).toEqual({
      ...row(replica),
      label: 'Renamed',
    });
  },
);

it('reads a legacy row without writing; mints identities once on its next existing write', async () => {
  const raw = JSON.stringify({ version: 1, worktrees: [row()] });
  await writeFile(file, raw);
  const legacy = await readRows();
  expect(legacy.worktrees[0]?.replica).toEqual({ state: 'never-recorded' });
  expect(await readFile(file, 'utf8')).toBe(raw);
  await repository(true).replace('workspace', legacy.worktrees, legacy);
  const recorded = (await readRows()).worktrees[0]?.replica;
  expect(recorded).toMatchObject({
    state: 'recorded',
    primarySnapshotRevision: unknownHead,
    repositories: [
      {
        repoId: WORKSPACE_ROOT_REPO_ID,
        remoteIdentity: unknownHead,
        baseOid: unknownHead,
      },
      { repoId: 'child', remoteIdentity: unknownHead, branchName: unknownHead },
    ],
  });
  const restarted = await readRows();
  // A stale legacy save cannot erase or mint another identity.
  await repository(true).replace('workspace', legacy.worktrees, restarted);
  expect((await readRows()).worktrees[0]?.replica).toEqual(recorded);
});

it('keeps the malformed replica value and reports unreadable rather than defaulting', async () => {
  const malformed =
    '{ "state" : "recorded", "path": "\\u002fsecret", "repositories" : [null] }';
  await writeFile(
    file,
    `{"version":1,"worktrees":[{"id":"tree","branchName":"feature","createdAt":"today","replica":${malformed}}]}`,
  );
  const read = await readRows();
  expect(read.worktrees[0]?.replica).toEqual({ state: 'unreadable' });
  await repository(true).replace(
    'workspace',
    [{ ...row(set([repo()])), label: 'Unrelated' }],
    read,
  );
  const preserved = await readRows();
  const malformedValue: unknown = JSON.parse(malformed);
  expect(preserved.document).toEqual({
    version: 1,
    worktrees: [{ ...row(), replica: malformedValue, label: 'Unrelated' }],
  });
  expect((await readRows()).worktrees[0]?.replica).toEqual({
    state: 'unreadable',
  });
});

it('preserves nested extensions on disk while projecting only validated fields', async () => {
  const replica = set([repo()]);
  if (replica.state !== 'recorded') throw new Error('Expected recorded state');
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      worktrees: [
        {
          ...row(),
          replica: {
            ...replica,
            futureSet: { path: '/private/root' },
            repositories: [
              {
                ...repo(),
                remoteUrl: 'https://secret@host/repo',
                targetId: { ...repo().targetId, secret: 'token' },
                localHeadOid: { ...unknownHead, futureHead: true },
              },
            ],
          },
        },
      ],
    }),
  );
  const read = await readRows();
  expect(read.worktrees[0]?.replica).toEqual(replica);
  expect(JSON.stringify(read.worktrees[0]?.replica)).not.toMatch(
    /private|https|secret|token|future/,
  );
  const updated = set([{ ...repo(), syncState: 'behind' }]);
  await repository().replace('workspace', [row(updated)], read);
  const disk = await readFile(file, 'utf8');
  expect(disk).toContain('/private/root');
  expect(disk).toContain('https://secret@host/repo');
  expect(disk).toContain('futureHead');
  expect((await readRows()).worktrees[0]?.replica).toEqual(updated);
});

it('keeps nested value and mode extensions outside the shapes that own them', async () => {
  const replica = set([repo()]);
  if (replica.state !== 'recorded') throw new Error('Expected recorded state');
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      worktrees: [
        {
          ...row(),
          replica: {
            ...replica,
            repositories: [
              {
                ...repo(),
                mode: 'repository-extension',
                targetId: { ...repo().targetId, value: 'target-extension' },
              },
            ],
          },
        },
      ],
    }),
  );
  const read = await readRows();
  await repository().replace(
    'workspace',
    [row(set([{ ...repo(), syncState: 'behind' }]))],
    read,
  );
  const disk = await readFile(file, 'utf8');
  expect(disk).toContain('repository-extension');
  expect(disk).toContain('target-extension');
});

it('drops an observation value once the observation becomes unknown', async () => {
  await repository().replace(
    'workspace',
    [row(set([{ ...repo(), localHeadOid: knownHead }]))],
    { authority: 'absent' },
  );
  const read = await readRows();
  await repository().replace('workspace', [row(set([repo()]))], read);
  expect(await readFile(file, 'utf8')).not.toContain('a'.repeat(40));
});

it.each([
  { ...repo(), baseOid: { state: 'known', value: '' } },
  { ...repo(), remoteIdentity: { state: 'known', value: 'https://host/repo' } },
  { ...repo(), workspaceId: 'other' },
  { ...repo(), targetId: { primaryAuthorityId: 'other', targetId: 'local' } },
  {
    ...repo(),
    observedRemoteHeadOid: { state: 'unknown', value: 'a'.repeat(40) },
  },
  { ...repo(), syncState: 'clean' },
])('rejects invalid observations and identity binding: %j', (record) => {
  expect(
    parseWorktreeReplica(
      {
        state: 'recorded',
        primarySnapshotRevision: unknownHead,
        repositories: [record],
      },
      'workspace',
      'tree',
    ),
  ).toEqual({ state: 'unreadable' });
});

it('keeps legacy writes usable when a branch or identity cannot be admitted', async () => {
  await repository(true).replace('workspace', [{ ...row(), branchName: '' }], {
    authority: 'absent',
  });
  expect((await readRows()).worktrees[0]?.replica).toMatchObject({
    state: 'recorded',
    repositories: [{ branchName: unknownHead }, { branchName: unknownHead }],
  });
  const read = await readRows();
  await repository(true).replace(
    'workspace',
    [{ ...row(), id: 'Legacy/identity' }],
    read,
  );
  expect((await readRows()).worktrees[0]?.replica).toEqual({
    state: 'never-recorded',
  });
  expect(await readFile(file, 'utf8')).not.toContain('"replica"');
});
