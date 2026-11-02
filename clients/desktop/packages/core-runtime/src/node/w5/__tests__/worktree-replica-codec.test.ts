import { WORKSPACE_ROOT_REPO_ID } from '@canopy/protocol/ui-labels';
import type {
  WorktreeReplicaState,
  WorktreeRepositoryReplica,
} from '@canopy/protocol/worktree-replica';
import {
  observeReplicaBranch,
  parseWorktreeReplica,
  serializeWorktreeReplica,
} from '../worktree-replica-codec';
import { recordLocalWorktreeReplica } from '../worktree-replica-record';

const unknown = { state: 'unknown' } as const;

function repo(repoId = WORKSPACE_ROOT_REPO_ID): WorktreeRepositoryReplica {
  return {
    authorityId: 'local-desktop',
    workspaceId: 'ws',
    worktreeId: 'tree',
    repoId,
    targetId: {
      primaryAuthorityId: 'local-desktop',
      targetId: 'in_process_worker',
    },
    replicaId: `replica-${repoId.replace(/_/g, '-')}`,
    remoteIdentity: { state: 'local-only' },
    branchName: { state: 'known', value: 'feature/x' },
    baseOid: { state: 'known', value: 'a'.repeat(40) },
    localHeadOid: unknown,
    observedRemoteHeadOid: unknown,
    expectedRemoteHeadOid: unknown,
    syncMode: { state: 'configured', mode: 'handoff' },
    syncState: 'ahead',
  };
}

function recorded(
  repositories: WorktreeRepositoryReplica[],
): WorktreeReplicaState {
  return {
    state: 'recorded',
    primarySnapshotRevision: { state: 'known', value: 3 },
    repositories,
  };
}

describe('parseWorktreeReplica', () => {
  it('reads an absent value as never recorded and a valid set as recorded', () => {
    expect(parseWorktreeReplica(undefined, 'ws', 'tree')).toEqual({
      state: 'never-recorded',
    });
    const replica = recorded([repo(), repo('child')]);
    expect(parseWorktreeReplica(replica, 'ws', 'tree')).toEqual(replica);
  });

  it.each([
    ['an uppercase identity', [{ ...repo(), replicaId: 'Replica' }]],
    ['an empty identity', [{ ...repo(), authorityId: '' }]],
    ['another worktree', [{ ...repo(), worktreeId: 'other' }]],
    ['no workspace root', [repo('child')]],
    ['a duplicate repository', [repo(), repo()]],
    ['a short OID', [{ ...repo(), baseOid: { state: 'known', value: 'a' } }]],
  ])('reports %s as unreadable rather than defaulting', (_name, entries) => {
    expect(
      parseWorktreeReplica(
        { ...recorded([]), repositories: entries },
        'ws',
        'tree',
      ),
    ).toEqual({ state: 'unreadable' });
  });
});

it('keeps stored extensions but drops a value its observation no longer owns', () => {
  const previous = {
    ...recorded([repo()]),
    future: 1,
    repositories: [
      {
        ...repo(),
        extension: true,
        baseOid: { state: 'known', value: 'a'.repeat(40), seenAt: 1 },
      },
    ],
  };
  const next = recorded([{ ...repo(), baseOid: unknown }]);
  expect(serializeWorktreeReplica(next, previous)).toEqual({
    ...next,
    future: 1,
    repositories: [
      { ...repo(), extension: true, baseOid: { state: 'unknown', seenAt: 1 } },
    ],
  });
  expect(serializeWorktreeReplica({ state: 'unreadable' }, previous)).toBe(
    previous,
  );
});

it('mints root-first local replicas for included repositories only', () => {
  const replica = recordLocalWorktreeReplica(
    'ws',
    {
      id: 'tree',
      branchName: 'feature/x',
      includedRepoIds: ['child'],
    },
    {
      authorityId: 'local-desktop',
      targetId: 'in_process_worker',
      repoIds: ['excluded', 'child'],
    },
  );
  if (replica.state !== 'recorded') throw new Error('Expected a replica');
  expect(
    replica.repositories.map((entry) => [entry.repoId, entry.branchName]),
  ).toEqual([
    [WORKSPACE_ROOT_REPO_ID, observeReplicaBranch('feature/x')],
    ['child', unknown],
  ]);
  expect(parseWorktreeReplica(replica, 'ws', 'tree')).toEqual(replica);
});

it('leaves a row unrecorded when its identities cannot be admitted', () => {
  expect(
    recordLocalWorktreeReplica(
      'ws',
      { id: 'Legacy Tree', branchName: 'main' },
      {
        authorityId: 'local-desktop',
        targetId: 'in_process_worker',
        repoIds: [],
      },
    ),
  ).toEqual({ state: 'never-recorded' });
});
