import type {
  CollectionConfig,
  SharedCollectionItem,
} from '@canopy/protocol/collections';
import {
  applyCollectionUpdate,
  duplicateLocalCollection,
  type CollectionMutationPorts,
  type CollectionUpdateSnapshot,
} from '../collection-mutations';

const skill: SharedCollectionItem = {
  type: 'skill',
  source: { type: 'builtin', id: 'app' },
  skill_name: 'review',
};
const custom: SharedCollectionItem = {
  type: 'custom_skill',
  skillId: 'remote-skill',
  skill_name: 'same-name-2',
  contentHash: 'skill-hash',
};

interface Fixture {
  ports: CollectionMutationPorts;
  initial: CollectionConfig;
  snapshot: CollectionUpdateSnapshot;
  save: jest.MockedFunction<CollectionMutationPorts['save']>;
  resolve: jest.MockedFunction<CollectionMutationPorts['resolve']>;
  live: jest.Mock<Promise<CollectionUpdateSnapshot>, []>;
  installPackage: jest.MockedFunction<
    CollectionMutationPorts['installPackage']
  >;
  assertContext: jest.Mock<Promise<void>, []>;
  setCurrent(value: CollectionConfig | null): void;
  getCurrent(): CollectionConfig | null;
}

function fixture(): Fixture {
  let current: CollectionConfig | null = {
    id: 'abc',
    revision: 'r1',
    name: 'Keep local name',
    description: 'Keep description',
    createdAt: '2026-01-01',
    updatedAt: '2026-01-02',
    skills: [{ sourceId: 'old', skillName: 'deleted' }],
    plugins: [{ marketplaceId: 'old', pluginName: 'deleted' }],
    mcpServers: [{ serverId: 'abc', configId: 'def' }],
    remote: {
      accountId: 'account',
      remoteId: 'outgoing',
      contentHash: 'published',
      shareScope: 'private',
      sharedAt: '2026-01-01',
    },
    sharedSource: {
      remoteId: 'source',
      contentHash: 'old-hash',
      fetchedAt: '2026-01-01',
    },
  };
  const initial = current;
  const snapshot: CollectionUpdateSnapshot = {
    contentHash: 'new-hash',
    collection: {
      version: 1,
      name: 'Remote name',
      description: 'Remote description',
      items: [skill],
    },
    customSkills: [],
  };
  const save = jest.fn<
    ReturnType<CollectionMutationPorts['save']>,
    Parameters<CollectionMutationPorts['save']>
  >(async (input, guard) => {
    await guard.assertCurrent?.();
    if (input.id && (!current || current.revision !== guard.expectedRevision))
      throw Object.assign(new Error('Conflict'), { code: 'conflict' });
    const saved: CollectionConfig = {
      id: input.id ?? 'def',
      revision: 'r2',
      name: input.name,
      description: input.description ?? '',
      skills: input.skills ?? [],
      plugins: input.plugins ?? [],
      mcpServers: input.mcpServers ?? [],
      createdAt: input.createdAt ?? 'new-date',
      updatedAt: 'new-date',
      ...(input.sharedSource ? { sharedSource: input.sharedSource } : {}),
      ...(input.remote ? { remote: input.remote } : {}),
    };
    if (input.id) current = saved;
    return saved;
  });
  const resolve = jest.fn<
    ReturnType<CollectionMutationPorts['resolve']>,
    Parameters<CollectionMutationPorts['resolve']>
  >(() => Promise.resolve({ sourceId: 'builtin:app', skillName: 'review' }));
  const live = jest.fn(() => Promise.resolve(snapshot));
  const installPackage = jest.fn<
    ReturnType<CollectionMutationPorts['installPackage']>,
    Parameters<CollectionMutationPorts['installPackage']>
  >(() =>
    Promise.resolve({ customSkills: new Map(), skills: [], mcpServers: [] }),
  );
  const assertContext = jest.fn(() => Promise.resolve());
  const ports: CollectionMutationPorts = {
    captureContext: () => Promise.resolve('account/session/project'),
    assertContext,
    read: () => Promise.resolve(current),
    save,
    live,
    resolve,
    installPackage,
  };
  return {
    ports,
    initial,
    snapshot,
    save,
    resolve,
    live,
    installPackage,
    assertContext,
    setCurrent: (value: CollectionConfig | null): void => {
      current = value;
    },
    getCurrent: (): CollectionConfig | null => current,
  };
}

describe('backend collection mutations', () => {
  it('duplicates the complete local snapshot once, with fresh metadata and no remote read', async () => {
    const f = fixture();
    const copy = await duplicateLocalCollection(
      { collectionId: 'abc' },
      f.ports,
    );
    expect(copy).toMatchObject({
      id: 'def',
      name: 'Keep local name copy',
      description: f.initial.description,
      skills: f.initial.skills,
      plugins: f.initial.plugins,
      mcpServers: f.initial.mcpServers,
      createdAt: 'new-date',
    });
    expect(copy.sharedSource).toBeUndefined();
    expect(copy.remote).toBeUndefined();
    expect(f.save).toHaveBeenCalledTimes(1);
    expect(f.live).not.toHaveBeenCalled();
  });

  it('replaces exact skill/plugin membership, preserves legacy MCP refs and identity, then advances the hash', async () => {
    const f = fixture();
    const result = await applyCollectionUpdate(
      { collectionId: 'abc', expectedRevision: 'r1' },
      f.ports,
    );
    expect(result.collection).toMatchObject({
      id: 'abc',
      name: f.initial.name,
      description: f.initial.description,
      createdAt: f.initial.createdAt,
      remote: f.initial.remote,
      skills: [{ sourceId: 'builtin:app', skillName: 'review' }],
      plugins: [],
      mcpServers: f.initial.mcpServers,
      sharedSource: { remoteId: 'source', contentHash: 'new-hash' },
    });
    expect(result.preservedLegacyMcpRefs).toBe(true);
    expect(f.save).toHaveBeenCalledTimes(1);
  });

  it('uses package resource mappings without duplicate legacy imports and removes old MCP refs', async () => {
    const f = fixture();
    f.snapshot.package = { version: 1, digest: 'package' };
    f.snapshot.collection.items = [custom];
    const ref = { sourceId: 'custom:app', skillName: 'actual-local-7' };
    f.installPackage.mockResolvedValue({
      customSkills: new Map([['remote-skill', ref]]),
      skills: [ref],
      mcpServers: [],
    });
    const result = await applyCollectionUpdate(
      { collectionId: 'abc', expectedRevision: 'r1' },
      f.ports,
    );
    expect(result.collection.skills).toEqual([ref]);
    expect(result.collection.mcpServers).toEqual([]);
    expect(f.resolve).not.toHaveBeenCalled();
    expect(result.preservedLegacyMcpRefs).toBe(false);
  });

  it('does not install or save a revoked/missing share', async () => {
    const f = fixture();
    f.live.mockRejectedValue(new Error('Not found'));
    await expect(
      applyCollectionUpdate(
        { collectionId: 'abc', expectedRevision: 'r1' },
        f.ports,
      ),
    ).rejects.toThrow('Not found');
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.installPackage).not.toHaveBeenCalled();
    expect(f.save).not.toHaveBeenCalled();
  });

  it('stops importing subsequent members when access is revoked after the first import', async () => {
    const f = fixture();
    f.snapshot.collection.items = [skill, { ...skill, skill_name: 'second' }];
    f.resolve.mockImplementationOnce(() => {
      f.live.mockRejectedValue(
        Object.assign(new Error('Access revoked'), {
          code: 'permission_denied',
        }),
      );
      return Promise.resolve({ sourceId: 'builtin:app', skillName: 'review' });
    });
    await expect(
      applyCollectionUpdate(
        { collectionId: 'abc', expectedRevision: 'r1' },
        f.ports,
      ),
    ).rejects.toMatchObject({
      code: 'permission_denied',
      partialResourceEffects: ['review'],
    });
    expect(f.resolve).toHaveBeenCalledTimes(1);
    expect(f.save).not.toHaveBeenCalled();
    expect(f.getCurrent()).toEqual(f.initial);
  });

  it('applies an empty upstream membership without uninstalling resources', async () => {
    const f = fixture();
    f.snapshot.collection.items = [];
    const result = await applyCollectionUpdate(
      { collectionId: 'abc', expectedRevision: 'r1' },
      f.ports,
    );
    expect(result.collection.skills).toEqual([]);
    expect(result.collection.plugins).toEqual([]);
    expect(result.collection.mcpServers).toEqual(f.initial.mcpServers);
    expect(result.collection.sharedSource?.contentHash).toBe('new-hash');
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.installPackage).not.toHaveBeenCalled();
  });

  it('rechecks access at the final writer boundary after imports', async () => {
    const f = fixture();
    f.save.mockImplementationOnce(async (_input, guard) => {
      f.live.mockRejectedValue(
        Object.assign(new Error('Access revoked'), {
          code: 'permission_denied',
        }),
      );
      await guard.assertCurrent?.();
      throw new Error('The writer guard should refuse the save');
    });
    await expect(
      applyCollectionUpdate(
        { collectionId: 'abc', expectedRevision: 'r1' },
        f.ports,
      ),
    ).rejects.toMatchObject({
      code: 'permission_denied',
      partialResourceEffects: ['review'],
    });
    expect(f.getCurrent()).toEqual(f.initial);
  });

  it.each(['edit', 'remove', 'source', 'context'] as const)(
    'fences a concurrent %s without rollback or resurrection',
    async (change) => {
      const f = fixture();
      f.resolve.mockImplementation(() => {
        if (change === 'context')
          f.assertContext.mockRejectedValue(new Error('context-mismatch'));
        else if (change === 'remove') f.setCurrent(null);
        else
          f.setCurrent({
            ...f.initial,
            revision: 'newer',
            name: 'User edit',
            ...(change === 'source'
              ? { sharedSource: { remoteId: 'other', fetchedAt: 'now' } }
              : {}),
          });
        return Promise.resolve({
          sourceId: 'builtin:app',
          skillName: 'review',
        });
      });
      await expect(
        applyCollectionUpdate(
          { collectionId: 'abc', expectedRevision: 'r1' },
          f.ports,
        ),
      ).rejects.toThrow();
      expect(f.save).not.toHaveBeenCalled();
      if (change === 'remove') expect(f.getCurrent()).toBeNull();
      if (change === 'edit') expect(f.getCurrent()?.name).toBe('User edit');
    },
  );

  it('keeps the hash and grouping on member failure and can retry', async () => {
    const f = fixture();
    f.resolve.mockRejectedValueOnce(new Error('Member failed'));
    await expect(
      applyCollectionUpdate(
        { collectionId: 'abc', expectedRevision: 'r1' },
        f.ports,
      ),
    ).rejects.toThrow('Member failed');
    expect(f.getCurrent()).toEqual(f.initial);
    expect(f.save).not.toHaveBeenCalled();
    await expect(
      applyCollectionUpdate(
        { collectionId: 'abc', expectedRevision: 'r1' },
        f.ports,
      ),
    ).resolves.toMatchObject({
      collection: { sharedSource: { contentHash: 'new-hash' } },
    });
  });

  it('does not prune or advance the hash when a represented package member is unresolved', async () => {
    const f = fixture();
    f.snapshot.package = { version: 1, digest: 'package' };
    f.snapshot.collection.items = [custom];
    await expect(
      applyCollectionUpdate(
        { collectionId: 'abc', expectedRevision: 'r1' },
        f.ports,
      ),
    ).rejects.toMatchObject({
      code: 'execution_failed',
      partialResourceEffects: ['Collection capability package'],
    });
    expect(f.save).not.toHaveBeenCalled();
    expect(f.getCurrent()).toEqual(f.initial);
  });

  it('rejects a changed live package/hash after resource effects without saving', async () => {
    const f = fixture();
    f.resolve.mockImplementationOnce(() => {
      f.live.mockResolvedValue({ ...f.snapshot, contentHash: 'different' });
      return Promise.resolve({ sourceId: 'builtin:app', skillName: 'review' });
    });
    await expect(
      applyCollectionUpdate(
        { collectionId: 'abc', expectedRevision: 'r1' },
        f.ports,
      ),
    ).rejects.toMatchObject({
      code: 'conflict',
      partialResourceEffects: ['review'],
    });
    expect(f.save).not.toHaveBeenCalled();
  });

  it('reports final persistence failure with resource effects and leaves retryable local state', async () => {
    const f = fixture();
    f.save.mockRejectedValue(new Error('Disk full'));
    await expect(
      applyCollectionUpdate(
        { collectionId: 'abc', expectedRevision: 'r1' },
        f.ports,
      ),
    ).rejects.toMatchObject({
      code: 'execution_failed',
      partialResourceEffects: ['review'],
    });
    expect(f.getCurrent()).toEqual(f.initial);
  });

  it('deduplicates simultaneous updates for one copy', async () => {
    const f = fixture();
    await Promise.all([
      applyCollectionUpdate(
        { collectionId: 'abc', expectedRevision: 'r1' },
        f.ports,
      ),
      applyCollectionUpdate(
        { collectionId: 'abc', expectedRevision: 'r1' },
        f.ports,
      ),
    ]);
    expect(f.save).toHaveBeenCalledTimes(1);
    expect(f.resolve).toHaveBeenCalledTimes(1);
  });

  it('keeps updates of two copies of one source independent', async () => {
    const first = fixture();
    const second = fixture();
    second.initial.id = 'def';
    await Promise.all([
      applyCollectionUpdate(
        { collectionId: 'abc', expectedRevision: 'r1' },
        first.ports,
      ),
      applyCollectionUpdate(
        { collectionId: 'def', expectedRevision: 'r1' },
        second.ports,
      ),
    ]);
    expect(first.save).toHaveBeenCalledTimes(1);
    expect(second.save).toHaveBeenCalledTimes(1);
    expect(first.getCurrent()?.id).toBe('abc');
    expect(second.getCurrent()?.id).toBe('def');
  });
});

it('rechecks the originating Portal session between imports and at the final write', async () => {
  const f = fixture();
  let authorized = true;
  f.snapshot.collection.items = [skill, { ...skill, skill_name: 'second' }];
  f.resolve.mockImplementationOnce(() => {
    authorized = false;
    return Promise.resolve({ sourceId: 'builtin:app', skillName: 'review' });
  });
  await expect(
    applyCollectionUpdate(
      { collectionId: 'abc', expectedRevision: 'r1' },
      f.ports,
      {
        key: 'portal/session',
        assertCurrent: () =>
          authorized
            ? Promise.resolve()
            : Promise.reject(
                Object.assign(new Error('Session changed'), {
                  code: 'permission_denied',
                }),
              ),
      },
    ),
  ).rejects.toMatchObject({
    code: 'permission_denied',
    partialResourceEffects: ['review'],
  });
  expect(f.resolve).toHaveBeenCalledTimes(1);
  expect(f.save).not.toHaveBeenCalled();
});

it.each(['missing', 'stale', 'unlinked', 'unverified live'] as const)(
  'refuses an update before effects for %s state',
  async (state) => {
    const f = fixture();
    if (state === 'missing') f.setCurrent(null);
    if (state === 'stale') f.setCurrent({ ...f.initial, revision: 'newer' });
    if (state === 'unlinked')
      f.setCurrent({ ...f.initial, sharedSource: undefined });
    if (state === 'unverified live') f.snapshot.contentHash = '';
    await expect(
      applyCollectionUpdate(
        { collectionId: 'abc', expectedRevision: 'r1' },
        f.ports,
      ),
    ).rejects.toMatchObject({
      code: state === 'missing' ? 'not_found' : 'conflict',
    });
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.installPackage).not.toHaveBeenCalled();
    expect(f.save).not.toHaveBeenCalled();
    expect(f.getCurrent()?.sharedSource?.contentHash).not.toBe('new-hash');
  },
);

it('replaces renamed members and deduplicates repeated upstream identities', async () => {
  const f = fixture();
  const renamed = { ...skill, skill_name: 'renamed' };
  f.snapshot.collection.items = [renamed, renamed];
  f.resolve.mockResolvedValue({
    sourceId: 'builtin:app',
    skillName: 'renamed',
  });
  const result = await applyCollectionUpdate(
    { collectionId: 'abc', expectedRevision: 'r1' },
    f.ports,
  );
  expect(result.collection.skills).toEqual([
    { sourceId: 'builtin:app', skillName: 'renamed' },
  ]);
  expect(f.resolve).toHaveBeenCalledTimes(1);
  expect(result.collection.sharedSource?.contentHash).toBe('new-hash');
});

it('reports package installation failure without replacing grouping or hash', async () => {
  const f = fixture();
  f.snapshot.package = { version: 1, digest: 'package' };
  f.installPackage.mockRejectedValue(new Error('Package unavailable'));
  await expect(
    applyCollectionUpdate(
      { collectionId: 'abc', expectedRevision: 'r1' },
      f.ports,
    ),
  ).rejects.toMatchObject({
    code: 'execution_failed',
    partialResourceEffects: ['Collection capability package'],
  });
  expect(f.getCurrent()).toEqual(f.initial);
  expect(f.resolve).not.toHaveBeenCalled();
  expect(f.save).not.toHaveBeenCalled();
});

it('rejects another revision while the same copy has an update in flight', async () => {
  const f = fixture();
  let release: () => void = () => {};
  let started: () => void = () => {};
  const importing = new Promise<void>((resolve) => {
    started = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.resolve.mockImplementationOnce(async () => {
    started();
    await waiting;
    return { sourceId: 'builtin:app', skillName: 'review' };
  });
  const pending = applyCollectionUpdate(
    { collectionId: 'abc', expectedRevision: 'r1' },
    f.ports,
  );
  await importing;
  try {
    await expect(
      applyCollectionUpdate(
        { collectionId: 'abc', expectedRevision: 'r2' },
        f.ports,
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(f.resolve).toHaveBeenCalledTimes(1);
  } finally {
    release();
    await pending;
  }
  expect(f.save).toHaveBeenCalledTimes(1);
});
