import type { SharedContainerReplicaState } from '@canopy/desktop-shared/types';
import {
  isListDismissedSharedContainersResult,
  isRestoreSharedContainerResult,
  isSharedContainerInboxChangedEvent,
  isSharedContainerPublicationState,
  isSharedContainerReplicaBroadcast,
  isSharedContainerReplicaPurge,
  isSharedContainerReplicaState,
  isSharedContainerReplicaStateOrNull,
} from '../shared-container-validation';

const base = {
  containerId: 'container-1',
  organizationId: 'org-1',
  containerType: 'CODE_WORKTREE',
  updatedAt: '2026-08-28T00:00:00.000Z',
};

const available: SharedContainerReplicaState = {
  ...base,
  containerType: 'CODE_WORKTREE',
  status: 'available',
  revisionId: 'revision-7',
  revision: 7,
  revisionCreatedAt: '2026-08-28T00:00:00.000Z',
  withheldFileCount: 2,
  withheldFileReasons: ['credential-shaped', 'oversized', 'symlink-escaping'],
};

describe('shared container replica state validation', () => {
  const repositoryBlocked = {
    ...base,
    status: 'blocked',
    reason: 'repository-access-missing',
    message: 'acme/tower-defense: repository access is missing',
  };

  it('accepts a canonical repository on blocked state and legacy absence', () => {
    expect(isSharedContainerReplicaState(repositoryBlocked)).toBe(true);
    const named = { ...repositoryBlocked, repository: 'acme/tower-defense' };
    expect(isSharedContainerReplicaState(named)).toBe(true);
    expect(isSharedContainerReplicaBroadcast(named)).toBe(true);
    expect(isSharedContainerReplicaStateOrNull(named)).toBe(true);
  });

  it.each([null, '', ' \t\n', 7, {}])(
    'rejects an invalid optional repository: %p',
    (repository) => {
      expect(
        isSharedContainerReplicaState({ ...repositoryBlocked, repository }),
      ).toBe(false);
    },
  );

  it('rejects undeclared fields alongside a repository', () => {
    expect(
      isSharedContainerReplicaState({
        ...repositoryBlocked,
        repository: 'acme/tower-defense',
        downloadUrl: 'https://storage.example/signed',
      }),
    ).toBe(false);
  });

  it.each([
    { ...base, status: 'nothing-published' },
    available,
    { ...available, status: 'pinned' },
  ])('rejects repository on non-blocked state: $status', (state) => {
    expect(
      isSharedContainerReplicaState({
        ...state,
        repository: 'acme/tower-defense',
      }),
    ).toBe(false);
  });

  it('accepts committed-symlink publication refusals', () => {
    expect(
      isSharedContainerPublicationState({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        organizationId: 'org-1',
        containerId: 'container-1',
        status: 'error',
        error: 'unsupported repository tree entry',
        errorReason: 'symlink',
        updatedAt: '2026-09-01T12:00:00.000Z',
      }),
    ).toBe(true);
  });

  it('rejects unknown publication refusal reasons', () => {
    expect(
      isSharedContainerPublicationState({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        organizationId: 'org-1',
        status: 'error',
        errorReason: 'unknown-refusal',
        updatedAt: '2026-09-01T12:00:00.000Z',
      }),
    ).toBe(false);
  });

  it('accepts every state the recipient bridge can broadcast', () => {
    expect(
      isSharedContainerReplicaState({ ...base, status: 'nothing-published' }),
    ).toBe(true);
    expect(isSharedContainerReplicaState(available)).toBe(true);
    expect(
      isSharedContainerReplicaState({ ...available, status: 'pinned' }),
    ).toBe(true);
    expect(
      isSharedContainerReplicaState({
        ...base,
        containerType: 'COWORK_WORK_ENTRY',
        status: 'blocked',
        reason: 'lfs-unsupported',
        message: 'canopy/app uses Git LFS',
      }),
    ).toBe(true);
    expect(
      isSharedContainerReplicaState({
        ...base,
        status: 'blocked',
        reason: 'symlink-unsupported',
        message: 'symbolic links are not supported on Windows',
      }),
    ).toBe(true);
  });

  it('accepts a direct share of a personal container', () => {
    const personal: Record<string, unknown> = {
      ...available,
      access: 'direct',
    };
    delete personal.organizationId;
    expect(isSharedContainerReplicaState(personal)).toBe(true);
    expect(
      isSharedContainerReplicaState({ ...available, access: 'direct' }),
    ).toBe(true);
    expect(
      isSharedContainerReplicaState({ ...available, access: 'organization' }),
    ).toBe(true);
    expect(
      isSharedContainerReplicaState({ ...available, access: 'public' }),
    ).toBe(false);
    expect(
      isSharedContainerReplicaState({ ...available, organizationId: '' }),
    ).toBe(false);
  });

  it('accepts a personal container publication state', () => {
    expect(
      isSharedContainerPublicationState({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        containerId: 'container-1',
        status: 'published',
        updatedAt: '2026-09-01T12:00:00.000Z',
      }),
    ).toBe(true);
    expect(
      isSharedContainerPublicationState({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        organizationId: 7,
        status: 'published',
        updatedAt: '2026-09-01T12:00:00.000Z',
      }),
    ).toBe(false);
  });

  it('rejects a payload carrying transport internals', () => {
    // The CAN-2549 boundary rule: no signed URL, object key, ciphertext, or
    // data key may reach the renderer, even alongside otherwise valid state.
    for (const leak of [
      { downloadUrl: 'https://storage.example/signed' },
      { objectKey: 'shared-containers/org-1/revision-7' },
      { dataKey: 'AAAABBBBCCCC' },
      { aad: 'container-1:revision-7' },
    ]) {
      expect(isSharedContainerReplicaState({ ...available, ...leak })).toBe(
        false,
      );
    }
  });

  it('rejects unknown statuses, block reasons, and container types', () => {
    expect(isSharedContainerReplicaState({ ...base, status: 'ready' })).toBe(
      false,
    );
    expect(
      isSharedContainerReplicaState({
        ...base,
        status: 'blocked',
        reason: 'sharing-policy-blocked',
        message: 'nope',
      }),
    ).toBe(false);
    expect(
      isSharedContainerReplicaState({
        ...available,
        containerType: 'CODE_WORKSPACE',
      }),
    ).toBe(false);
  });

  it('rejects malformed and missing revision coordinates', () => {
    const withoutRevisionId: Record<string, unknown> = { ...available };
    delete withoutRevisionId.revisionId;
    expect(isSharedContainerReplicaState(withoutRevisionId)).toBe(false);
    expect(isSharedContainerReplicaState({ ...available, revision: 7.5 })).toBe(
      false,
    );
    expect(
      isSharedContainerReplicaState({ ...base, status: 'available' }),
    ).toBe(false);
    expect(
      isSharedContainerReplicaState({ ...available, withheldFileCount: -1 }),
    ).toBe(false);
    expect(
      isSharedContainerReplicaState({
        ...available,
        withheldFileReasons: ['private-path'],
      }),
    ).toBe(false);
  });

  it('rejects non-record payloads and blank identifiers', () => {
    expect(isSharedContainerReplicaState(null)).toBe(false);
    expect(isSharedContainerReplicaState([available])).toBe(false);
    expect(isSharedContainerReplicaState('available')).toBe(false);
    expect(
      isSharedContainerReplicaState({ ...available, containerId: '' }),
    ).toBe(false);
  });

  // `get-replica-state` is a separate contract where `null` genuinely means
  // "this device has no replica". It must stay untouched by the broadcast
  // change, so these cases are load-bearing rather than redundant.
  it('treats null as the legitimate no-replica broadcast', () => {
    expect(isSharedContainerReplicaStateOrNull(null)).toBe(true);
    expect(isSharedContainerReplicaStateOrNull(available)).toBe(true);
    expect(isSharedContainerReplicaStateOrNull(undefined)).toBe(false);
  });

  it('accepts both purge scopes', () => {
    expect(
      isSharedContainerReplicaPurge({
        purged: 'container',
        containerId: 'container-1',
      }),
    ).toBe(true);
    expect(isSharedContainerReplicaPurge({ purged: 'all' })).toBe(true);
  });

  // A malformed purge must be rejected outright rather than degrade into a
  // wider scope than main meant: that widening is the bug being fixed.
  it('rejects a container purge that does not name a container', () => {
    expect(isSharedContainerReplicaPurge({ purged: 'container' })).toBe(false);
    expect(
      isSharedContainerReplicaPurge({ purged: 'container', containerId: '' }),
    ).toBe(false);
    expect(
      isSharedContainerReplicaPurge({
        purged: 'container',
        containerId: 'container-1',
        reason: 'dismissed',
      }),
    ).toBe(false);
    expect(
      isSharedContainerReplicaPurge({ purged: 'all', containerId: 'c' }),
    ).toBe(false);
    expect(isSharedContainerReplicaPurge({ purged: true })).toBe(false);
    expect(isSharedContainerReplicaPurge(undefined)).toBe(false);
    expect(isSharedContainerReplicaPurge(null)).toBe(false);
    expect(isSharedContainerReplicaPurge(available)).toBe(false);
  });

  it('accepts states and purges on the replica-changed broadcast, and nothing else', () => {
    expect(isSharedContainerReplicaBroadcast(available)).toBe(true);
    expect(
      isSharedContainerReplicaBroadcast({
        purged: 'container',
        containerId: 'container-1',
      }),
    ).toBe(true);
    expect(isSharedContainerReplicaBroadcast({ purged: 'all' })).toBe(true);
    // The bare `null` the purge used to broadcast is no longer a valid
    // broadcast; a purge has to declare its scope.
    expect(isSharedContainerReplicaBroadcast(null)).toBe(false);
    expect(isSharedContainerReplicaBroadcast(undefined)).toBe(false);
    expect(
      isSharedContainerReplicaBroadcast({ ...available, dataKey: 'secret' }),
    ).toBe(false);
  });
});

describe('shared container inbox signal validation', () => {
  it('accepts every declared refresh reason', () => {
    expect(isSharedContainerInboxChangedEvent({ reason: 'realtime' })).toBe(
      true,
    );
    expect(isSharedContainerInboxChangedEvent({ reason: 'poll' })).toBe(true);
    expect(isSharedContainerInboxChangedEvent({ reason: 'focus' })).toBe(true);
    expect(isSharedContainerInboxChangedEvent({ reason: 'local' })).toBe(true);
  });

  it('rejects undeclared fields, unknown reasons, and non-records', () => {
    // The signal is identity-free on purpose; anything extra is a transport
    // internal that must not reach the renderer.
    expect(
      isSharedContainerInboxChangedEvent({
        reason: 'realtime',
        containerId: 'c1',
      }),
    ).toBe(false);
    expect(isSharedContainerInboxChangedEvent({ reason: 'restart' })).toBe(
      false,
    );
    expect(isSharedContainerInboxChangedEvent({})).toBe(false);
    expect(isSharedContainerInboxChangedEvent(null)).toBe(false);
    expect(isSharedContainerInboxChangedEvent([{ reason: 'poll' }])).toBe(
      false,
    );
    expect(isSharedContainerInboxChangedEvent('poll')).toBe(false);
  });
});

describe('shared container removed-share validation', () => {
  const container = {
    id: 'container-1',
    organizationId: 'org-1',
    ownerUserId: 'owner-1',
    owner: { userId: 'owner-1', name: 'Owner' },
    access: 'organization',
    worktreeId: 'worktree-1',
    containerType: 'CODE_WORKTREE',
    title: 'Feature branch',
    revision: 3,
    capabilities: ['VIEW'],
    createdAt: '2026-08-26T00:00:00.000Z',
    updatedAt: '2026-08-26T00:00:00.000Z',
  };
  const dismissed = { ...container, dismissedAt: '2026-10-01T00:00:00.000Z' };

  it('accepts a removed-share page or the unsupported marker, nothing else', () => {
    expect(
      isListDismissedSharedContainersResult({
        containers: [dismissed],
        nextCursor: null,
      }),
    ).toBe(true);
    expect(isListDismissedSharedContainersResult({ unsupported: true })).toBe(
      true,
    );
    expect(isListDismissedSharedContainersResult({ unsupported: false })).toBe(
      false,
    );
    expect(
      isListDismissedSharedContainersResult({
        unsupported: true,
        containers: [dismissed],
        nextCursor: null,
      }),
    ).toBe(false);
    // A live summary has no removal time, so it is not a removed share.
    expect(
      isListDismissedSharedContainersResult({
        containers: [container],
        nextCursor: null,
      }),
    ).toBe(false);
    expect(isListDismissedSharedContainersResult(null)).toBe(false);
  });

  it('accepts only the declared restore outcomes', () => {
    expect(isRestoreSharedContainerResult({ restored: true, container })).toBe(
      true,
    );
    expect(
      isRestoreSharedContainerResult({
        restored: false,
        reason: 'not-restorable',
      }),
    ).toBe(true);
    expect(
      isRestoreSharedContainerResult({
        restored: false,
        reason: 'unsupported',
      }),
    ).toBe(true);
    expect(isRestoreSharedContainerResult({ restored: true })).toBe(false);
    expect(
      isRestoreSharedContainerResult({ restored: false, reason: 'revoked' }),
    ).toBe(false);
    expect(
      isRestoreSharedContainerResult({
        restored: false,
        reason: 'not-restorable',
        container,
      }),
    ).toBe(false);
    expect(isRestoreSharedContainerResult(undefined)).toBe(false);
  });
});
