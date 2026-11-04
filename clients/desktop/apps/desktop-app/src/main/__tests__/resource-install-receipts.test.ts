import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InstallReceipt } from '@canopy/desktop-shared/lib/resource-context-policy';
import { decideResourceContext } from '@canopy/desktop-shared/lib/resource-context-policy';
import * as atomicFile from '../lib/atomic-file';
import { createResourceInstallReceiptsStore } from '../lib/resource-install-receipts';

const receipt: InstallReceipt = {
  family: 'skills',
  remoteId: 'r',
  shareScope: 'organization',
  ownerContext: {
    kind: 'organization',
    organizationId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  },
  hash: 'v1',
  authorizedAt: '2026-09-23T00:00:00.000Z',
};
let dir: string;
it('fails strict skill lookup when corrupt provenance could otherwise look absent', async () => {
  const store = createResourceInstallReceiptsStore('a', dir);
  await writeFile(
    join(dir, 'resource-install-receipts.json'),
    JSON.stringify({
      version: 1,
      byAccount: { a: [{ ...receipt, authorizedAt: null }] },
    }),
  );
  await expect(store.find('skills', 'r', true)).rejects.toThrow(
    'Invalid resource install receipt',
  );
  await expect(store.listForAccount(true)).rejects.toThrow(
    'Invalid resource install receipt',
  );
});
it('preserves distinct per-copy baselines when updating only one alias', async () => {
  const store = createResourceInstallReceiptsStore('a', dir);
  const oldHash = 'a'.repeat(64);
  const newHash = 'b'.repeat(64);
  await store.record({
    ...receipt,
    localResourceIds: ['one', 'two'],
    localContentHashes: { one: oldHash, two: oldHash },
  });
  await store.record({
    ...receipt,
    hash: newHash,
    localResourceIds: ['one'],
    localContentHashes: { one: newHash },
  });
  expect(await store.find('skills', 'r')).toMatchObject({
    localResourceIds: ['one', 'two'],
    localContentHashes: { one: newHash, two: oldHash },
  });
});

it('preserves primary identity across dependency writes and compensates an aborted primary alias', async () => {
  const store = createResourceInstallReceiptsStore('a', dir);
  const primary = {
    ...receipt,
    localResourceIds: ['primary'],
    localResourceRoles: { primary: 'primary' as const },
  };
  await store.record(primary);
  const dependency = {
    ...receipt,
    localResourceIds: ['dependency'],
    localResourceRoles: { dependency: 'dependency' as const },
  };
  await store.record(dependency);
  const previous = await store.find('skills', 'r');
  expect(previous).toMatchObject({
    localResourceIds: ['primary', 'dependency'],
    localResourceRoles: { primary: 'primary' as const },
  });
  const alias = {
    ...receipt,
    localResourceIds: ['alias'],
    localResourceRoles: { alias: 'primary' as const },
  };
  await store.record(alias);
  expect(await store.find('skills', 'r')).toMatchObject({
    localResourceRoles: {
      primary: 'primary',
      dependency: 'dependency',
      alias: 'primary',
    },
  });
  await store.rollbackInstall(alias, previous);
  expect(await store.find('skills', 'r')).toEqual(previous);
});

it('does not infer per-copy baselines for legacy multi-alias receipts', async () => {
  const store = createResourceInstallReceiptsStore('a', dir);
  await store.record({ ...receipt, localResourceIds: ['one', 'two'] });
  const updated: InstallReceipt = {
    ...receipt,
    hash: 'b'.repeat(64),
    localResourceIds: ['one'],
    localContentHashes: { one: 'b'.repeat(64) },
  };
  const previous = await store.find('skills', 'r');
  await store.record(updated);
  expect((await store.find('skills', 'r'))?.localContentHashes).toEqual({
    one: 'b'.repeat(64),
  });
  await store.rollbackInstall(updated, previous);
  expect(await store.find('skills', 'r')).toEqual(previous);
});

it('does not rollback a winning per-copy update even with identical share metadata', async () => {
  const store = createResourceInstallReceiptsStore('a', dir);
  const previous: InstallReceipt = {
    ...receipt,
    localResourceIds: ['one', 'two'],
    localContentHashes: { one: 'a'.repeat(64), two: 'a'.repeat(64) },
  };
  const attempt: InstallReceipt = {
    ...previous,
    hash: 'b'.repeat(64),
    authorizedAt: '2026-10-29T12:00:00Z',
    localResourceIds: ['one'],
    localContentHashes: { one: 'b'.repeat(64) },
  };
  const winner: InstallReceipt = {
    ...attempt,
    localResourceIds: ['two'],
    localContentHashes: { two: 'c'.repeat(64) },
  };
  await store.record(previous);
  await store.record(attempt);
  await store.record(winner);
  await store.rollbackInstall(attempt, previous);
  expect(await store.find('skills', 'r')).toMatchObject({
    hash: attempt.hash,
    localResourceIds: ['one', 'two'],
    localContentHashes: { one: 'b'.repeat(64), two: 'c'.repeat(64) },
  });
});
it('keeps the original organization receipt in the team lane after Personal is replaced', async (): Promise<void> => {
  const store = createResourceInstallReceiptsStore('a', dir);
  await store.record(receipt);
  const persisted = await createResourceInstallReceiptsStore('a', dir).find(
    'skills',
    'r',
  );
  expect(persisted).toEqual(receipt);
  const decide = (
    context: InstallReceipt['ownerContext'],
    personalOrganizationId: string,
  ): ReturnType<typeof decideResourceContext> =>
    decideResourceContext(
      {
        resource: {
          owner: { shareScope: 'private' },
          provenance: persisted ?? undefined,
        },
        invocation: { mode: 'foreground', context },
      },
      { personalOrganizationId },
    );
  const original = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  expect(decide({ kind: 'personal' }, original)).toEqual({ allow: true });
  expect(
    decide({ kind: 'personal' }, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
  ).toEqual({ allow: false, reason: 'context-mismatch' });
  expect(
    decide(
      { kind: 'organization', organizationId: original },
      'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    ),
  ).toEqual({ allow: true });
});
beforeEach(async (): Promise<void> => {
  dir = await mkdtemp(join(tmpdir(), 'can2962-'));
});
afterEach(async (): Promise<void> => {
  await rm(dir, { recursive: true, force: true });
});
it('persists versioned, private, account-partitioned receipts across sign-out/recreation', async (): Promise<void> => {
  const a = createResourceInstallReceiptsStore('a', dir);
  const b = createResourceInstallReceiptsStore('b', dir);
  await Promise.all([a.record(receipt), b.record({ ...receipt, hash: 'b' })]);
  expect(
    await createResourceInstallReceiptsStore('a', dir).find('skills', 'r'),
  ).toEqual(receipt);
  expect(await b.listForAccount()).toEqual([{ ...receipt, hash: 'b' }]);
  const file = join(dir, 'resource-install-receipts.json');
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
    version: 1,
    byAccount: { a: [receipt], b: [{ ...receipt, hash: 'b' }] },
  });
});
it.each(['editing', 'managed import', 'revocation'])(
  '%s cannot replace org origin with Personal',
  async (): Promise<void> => {
    const store = createResourceInstallReceiptsStore('a', dir);
    await store.record(receipt);
    await expect(
      store.record({
        ...receipt,
        shareScope: 'private',
        ownerContext: { kind: 'personal' },
      }),
    ).rejects.toThrow('origin');
    expect(await store.find('skills', 'r')).toEqual(receipt);
  },
);
it('updates hashes without changing origin and keeps family identity separate', async (): Promise<void> => {
  const store = createResourceInstallReceiptsStore('a', dir);
  await store.record(receipt);
  await store.record({ ...receipt, hash: 'v2' });
  await store.record({ ...receipt, family: 'agents' });
  expect(await store.listForAccount()).toHaveLength(2);
  expect(await store.find('skills', 'r')).toEqual({ ...receipt, hash: 'v2' });
});
it('normalizes malformed entries and strips content on read', async (): Promise<void> => {
  await writeFile(
    join(dir, 'resource-install-receipts.json'),
    JSON.stringify({
      version: 1,
      byAccount: {
        a: [
          { ...receipt, content: 'secret' },
          null,
          { ...receipt, remoteId: '' },
        ],
        b: null,
      },
    }),
  );
  expect(
    await createResourceInstallReceiptsStore('a', dir).listForAccount(),
  ).toEqual([receipt]);
});
it('fails closed on unreadable provenance rather than overwriting it after cache failure', async (): Promise<void> => {
  const file = join(dir, 'resource-install-receipts.json');
  await writeFile(file, '{corrupt');
  const store = createResourceInstallReceiptsStore('a', dir);
  await expect(store.record(receipt)).rejects.toThrow(
    'Invalid resource install receipt file',
  );
  expect(await readFile(file, 'utf8')).toBe('{corrupt');
});

it.each(['a', 'b'])(
  'preserves raw rows when writing account %s',
  async (account): Promise<void> => {
    const file = join(dir, 'resource-install-receipts.json');
    const malformed = { ...receipt, authorizedAt: null, content: 'retained' };
    const existing = {
      ...receipt,
      remoteId: 'other',
      extra: { source: 'retained' },
    };
    const rows = [malformed, null, existing];
    await writeFile(
      file,
      JSON.stringify({ version: 1, byAccount: { a: rows } }),
    );
    await createResourceInstallReceiptsStore(account, dir).record(receipt);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      version: 1,
      byAccount:
        account === 'a' ? { a: [...rows, receipt] } : { a: rows, b: [receipt] },
    });
  },
);

it.each(['a', 'b'])(
  'refuses non-array account values when writing account %s',
  async (account): Promise<void> => {
    const file = join(dir, 'resource-install-receipts.json');
    const original = JSON.stringify({ version: 1, byAccount: { a: receipt } });
    await writeFile(file, original);
    await expect(
      createResourceInstallReceiptsStore(account, dir).record(receipt),
    ).rejects.toThrow('Invalid resource install receipt file');
    expect(await readFile(file, 'utf8')).toBe(original);
  },
);

it('preserves organization origin after a rejected write and allows recovery', async (): Promise<void> => {
  const store = createResourceInstallReceiptsStore('a', dir);
  await store.record(receipt);
  await expect(
    store.record({
      ...receipt,
      ownerContext: {
        kind: 'organization',
        organizationId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      },
    }),
  ).rejects.toThrow('origin');
  await store.record({ ...receipt, hash: 'updated' });
  expect(await store.find('skills', 'r')).toEqual({
    ...receipt,
    hash: 'updated',
  });
});
it('isolates special account keys and does not expose mutable cached receipts', async (): Promise<void> => {
  const store = createResourceInstallReceiptsStore('__proto__', dir);
  await store.record(receipt);
  const rows = await store.listForAccount();
  rows[0].ownerContext = { kind: 'personal' };
  expect(await store.find('skills', 'r')).toEqual(receipt);
  expect(
    await createResourceInstallReceiptsStore('toString', dir).listForAccount(),
  ).toEqual([]);
});

it('keeps the last durable receipt when atomic publication fails', async (): Promise<void> => {
  const store = createResourceInstallReceiptsStore('a', dir);
  await store.record(receipt);
  const write = jest
    .spyOn(atomicFile, 'writeFileAtomically')
    .mockRejectedValueOnce(new Error('disk unavailable'));
  try {
    await expect(store.record({ ...receipt, hash: 'failed' })).rejects.toThrow(
      'disk unavailable',
    );
    expect(await store.find('skills', 'r')).toEqual(receipt);
  } finally {
    write.mockRestore();
  }
});

it('retains local pipeline bindings across updates and account changes', async (): Promise<void> => {
  const store = createResourceInstallReceiptsStore('a', dir);
  await store.record({ ...receipt, localResourceIds: ['local-one'] });
  await store.record({
    ...receipt,
    hash: 'v2',
    localResourceIds: ['local-two'],
  });
  expect((await store.find('skills', 'r'))?.localResourceIds).toEqual([
    'local-one',
    'local-two',
  ]);
  expect(
    await createResourceInstallReceiptsStore('b', dir).findLocal(
      'skills',
      'local-one',
    ),
  ).toMatchObject({ accountId: 'a', receipt: { remoteId: 'r' } });
});

it('rolls back only a newly installed binding, retaining prior and concurrent provenance', async (): Promise<void> => {
  const store = createResourceInstallReceiptsStore('a', dir);
  const installed = { ...receipt, localResourceIds: ['created'] };
  await store.record(installed);
  await store.rollbackInstall(installed, undefined);
  expect(await store.listForAccount()).toEqual([
    { ...receipt, localResourceIds: [] },
  ]);
  expect(
    await store.listOrganizationContentOwners('skills', receipt.hash),
  ).toEqual(['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']);
  const previous = { ...receipt, localResourceIds: ['previous'] };
  await store.record(previous);
  await store.record(installed);
  await store.record({ ...receipt, localResourceIds: ['concurrent'] });
  await store.rollbackInstall(installed, previous);
  expect(await store.findLocal('skills', 'created')).toBeUndefined();
  expect((await store.find('skills', 'r'))?.localResourceIds).toEqual([
    'previous',
    'concurrent',
  ]);
});
it('lists organization content owners across accounts without treating them as grants', async () => {
  await createResourceInstallReceiptsStore('a', dir).record(receipt);
  const other = createResourceInstallReceiptsStore('b', dir);
  expect(await other.listOrganizationContentOwners('skills', 'v1')).toEqual([
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  ]);
  expect(await other.listOrganizationContentOwners('pipelines', 'v1')).toEqual(
    [],
  );
});

it.each(['a', 'b'])(
  'refuses non-array account values when rolling back account %s',
  async (account): Promise<void> => {
    const file = join(dir, 'resource-install-receipts.json');
    const original = JSON.stringify({ version: 1, byAccount: { a: receipt } });
    await writeFile(file, original);
    await expect(
      createResourceInstallReceiptsStore(account, dir).rollbackInstall(
        receipt,
        undefined,
      ),
    ).rejects.toThrow('Invalid resource install receipt file');
    expect(await readFile(file, 'utf8')).toBe(original);
  },
);

it('creates the missing receipts directory during rollback', async (): Promise<void> => {
  const missing = join(dir, 'absent');
  const store = createResourceInstallReceiptsStore('a', missing);
  await expect(
    store.rollbackInstall(receipt, undefined),
  ).resolves.toBeUndefined();
  expect(
    JSON.parse(
      await readFile(join(missing, 'resource-install-receipts.json'), 'utf8'),
    ),
  ).toEqual({ version: 1, byAccount: { a: [] } });
});

it('keeps concurrent pipeline metadata and recognizes newer YAML after rollback', async (): Promise<void> => {
  const store = createResourceInstallReceiptsStore('a', dir);
  const previous: InstallReceipt = {
    ...receipt,
    family: 'pipelines',
    localResourceIds: ['previous'],
  };
  const installed: InstallReceipt = {
    ...previous,
    hash: 'aborted',
    localResourceIds: ['created'],
  };
  const yaml = 'name: Newer pipeline';
  const concurrent: InstallReceipt = {
    ...previous,
    hash: createHash('sha256').update(yaml).digest('hex'),
    authorizedAt: '2026-09-24T00:00:00.000Z',
    localResourceIds: ['concurrent'],
  };
  await store.record(previous);
  await store.record(installed);
  await store.record(concurrent);
  await store.rollbackInstall(installed, previous);
  expect(
    await store.listOrganizationContentOwners(
      'pipelines',
      createHash('sha256').update(yaml).digest('hex'),
    ),
  ).toEqual(['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']);
  expect(await store.find('pipelines', 'r')).toEqual({
    ...concurrent,
    localResourceIds: ['previous', 'concurrent'],
  });
});
it('removes only added aliases when no concurrent aliases remain', async (): Promise<void> => {
  const store = createResourceInstallReceiptsStore('a', dir);
  const previous = { ...receipt, localResourceIds: ['previous'] };
  const installed = {
    ...receipt,
    hash: 'aborted',
    localResourceIds: ['created'],
  };
  await store.record(previous);
  await store.record(installed);
  await store.rollbackInstall(installed, previous);
  expect(await store.find('skills', 'r')).toEqual({
    ...previous,
    localResourceIds: ['previous'],
  });
});

it('normalizes names on record, find, list and local lookup, including older persisted rows', async () => {
  const store = createResourceInstallReceiptsStore('a', dir);
  const named = {
    ...receipt,
    localResourceIds: ['copy'],
    sharedByName: ' Lena ',
    ownerName: ' Acme ',
    teamName: '  ',
  };
  const normalized = {
    ...receipt,
    localResourceIds: ['copy'],
    sharedByName: 'Lena',
    ownerName: 'Acme',
  };
  await store.record(named);
  expect(await store.find('skills', 'r')).toEqual(normalized);
  expect(await store.listForAccount()).toEqual([normalized]);
  expect(
    JSON.parse(
      await readFile(join(dir, 'resource-install-receipts.json'), 'utf8'),
    ),
  ).toEqual({ version: 1, byAccount: { a: [normalized] } });
  await writeFile(
    join(dir, 'resource-install-receipts.json'),
    JSON.stringify({ version: 1, byAccount: { a: [named] } }),
  );
  expect(await store.find('skills', 'r')).toEqual(normalized);
  expect(await store.findLocal('skills', 'copy')).toEqual({
    accountId: 'a',
    receipt: normalized,
  });
});

it.each(['sharedByName', 'ownerName', 'teamName'])(
  'rejects and ignores persisted non-string %s without erasing malformed rows',
  async (field) => {
    const store = createResourceInstallReceiptsStore('a', dir);
    const invalid = { ...receipt, [field]: 42 };
    await expect(store.record(invalid)).rejects.toThrow(
      'Invalid resource install receipt',
    );
    const file = join(dir, 'resource-install-receipts.json');
    await writeFile(
      file,
      JSON.stringify({ version: 1, byAccount: { a: [invalid] } }),
    );
    expect(await store.listForAccount()).toEqual([]);
    await store.record({ ...receipt, remoteId: 'valid' });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      version: 1,
      byAccount: { a: [invalid, { ...receipt, remoteId: 'valid' }] },
    });
  },
);

it('replaces the display snapshot and restores it with the installed hash on an aborted update', async () => {
  const store = createResourceInstallReceiptsStore('a', dir);
  const previous = {
    ...receipt,
    localResourceIds: ['copy'],
    sharedByName: 'Lena',
    ownerName: 'Acme',
    teamName: 'Release',
  };
  await store.record(previous);
  const replacement = {
    ...receipt,
    localResourceIds: ['copy'],
    hash: 'v2',
    authorizedAt: '2026-10-26T00:00:00Z',
    ownerName: 'Renamed',
  };
  await store.record(replacement);
  expect(await store.find('skills', 'r')).toEqual(replacement);
  await store.rollbackInstall(replacement, previous);
  expect(await store.find('skills', 'r')).toEqual(previous);
  await store.record(replacement);
  expect(await store.find('skills', 'r')).toEqual(replacement);
});

it('preserves a concurrent display snapshot when rolling back an older attempt', async () => {
  const store = createResourceInstallReceiptsStore('a', dir);
  const previous = {
    ...receipt,
    sharedByName: 'Lena',
    localResourceIds: ['copy'],
  };
  const attempt = { ...previous, hash: 'v2' };
  const concurrent = { ...attempt, sharedByName: 'Sam' };
  await store.record(previous);
  await store.record(attempt);
  await store.record(concurrent);
  await store.rollbackInstall(attempt, previous);
  expect(await store.find('skills', 'r')).toEqual(concurrent);
});

it('keeps queued pipeline receipts bound to the captured account handle', async (): Promise<void> => {
  const authorized = createResourceInstallReceiptsStore('a', dir);
  const other = createResourceInstallReceiptsStore('b', dir);
  const installed: InstallReceipt = {
    ...receipt,
    family: 'pipelines',
    localResourceIds: ['installed-a'],
  };
  await Promise.all([
    other.record({ ...installed, localResourceIds: ['installed-b'] }),
    authorized.record(installed),
    authorized.record({ ...installed, localResourceIds: ['duplicate-a'] }),
  ]);
  expect(await authorized.listForAccount()).toEqual([
    { ...installed, localResourceIds: ['installed-a', 'duplicate-a'] },
  ]);
  expect(await other.listForAccount()).toEqual([
    { ...installed, localResourceIds: ['installed-b'] },
  ]);
});

it.each(['organization', 'team'] as const)(
  'allows agent receipt scope changes within the same organization from %s',
  async (shareScope): Promise<void> => {
    const store = createResourceInstallReceiptsStore('a', dir);
    const original: InstallReceipt = {
      ...receipt,
      family: 'agents',
      shareScope,
      localResourceIds: ['authored'],
    };
    await store.record(original);
    const updated: InstallReceipt = {
      ...original,
      shareScope: shareScope === 'team' ? 'organization' : 'team',
      hash: 'v2',
      localResourceIds: ['imported'],
    };
    await expect(store.record(updated)).resolves.toBeUndefined();
    expect(await store.find('agents', 'r')).toEqual({
      ...updated,
      localResourceIds: ['authored', 'imported'],
    });
  },
);
it.each([undefined, []])(
  'preserves origin on alias-free rollback (%s)',
  async (localResourceIds): Promise<void> => {
    const store = createResourceInstallReceiptsStore('a', dir);
    const installed = { ...receipt, localResourceIds };
    await store.record(installed);
    await store.rollbackInstall(installed, undefined);
    expect(await store.find('skills', 'r')).toEqual({
      ...receipt,
      localResourceIds: [],
    });
    await expect(
      store.record({
        ...receipt,
        shareScope: 'private',
        ownerContext: { kind: 'personal' },
      }),
    ).rejects.toThrow('origin');
  },
);

it('preserves a concurrent metadata update without new aliases during rollback', async (): Promise<void> => {
  const store = createResourceInstallReceiptsStore('a', dir);
  const previous = { ...receipt, localResourceIds: ['previous'] };
  const installed = { ...receipt, localResourceIds: ['created'] };
  await store.record(previous);
  await store.record(installed);
  const concurrent = {
    ...receipt,
    hash: 'newer',
    authorizedAt: '2026-09-24T00:00:00.000Z',
  };
  await store.record(concurrent);
  await store.rollbackInstall(installed, previous);
  expect(await store.find('skills', 'r')).toEqual({
    ...concurrent,
    localResourceIds: ['previous'],
  });
});

it('retains the Public collection source across durable receipt reloads', async () => {
  const publicReceipt = {
    ...receipt,
    family: 'collections',
    remoteId: 'public-a',
    shareScope: 'private' as const,
    ownerContext: { kind: 'personal' as const },
    sourceKind: 'public-share' as const,
    localResourceIds: ['local'],
  };
  await createResourceInstallReceiptsStore('a', dir).record(publicReceipt);
  expect(
    await createResourceInstallReceiptsStore('a', dir).find(
      'collections',
      'public-a',
    ),
  ).toEqual(publicReceipt);
});

it('retains uninstall history without erasing origin, and reactivates only the reinstalled alias', async () => {
  const store = createResourceInstallReceiptsStore('a', dir);
  await store.record({ ...receipt, localResourceIds: ['one', 'two'] });
  const removal = {
    ...receipt,
    localResourceIds: ['one'],
    uninstalledLocalResourceIds: ['one'],
  };
  await store.record(removal);
  await store.record({ ...receipt, localResourceIds: ['two'] });
  expect(await store.find('skills', 'r')).toMatchObject({
    localResourceIds: ['one', 'two'],
    uninstalledLocalResourceIds: ['one'],
    ownerContext: receipt.ownerContext,
  });
  expect(await store.findLocal('skills', 'one')).toBeDefined();
  await store.record({ ...receipt, localResourceIds: ['one'] });
  expect(await store.find('skills', 'r')).toMatchObject({
    uninstalledLocalResourceIds: [],
  });
});

it('restores intentional removal when a reinstall fails before publishing its file', async () => {
  const store = createResourceInstallReceiptsStore('a', dir);
  const removed = {
    ...receipt,
    localResourceIds: ['one'],
    uninstalledLocalResourceIds: ['one'],
  };
  await store.record(removed);
  const attempt = { ...receipt, localResourceIds: ['one'], hash: 'new' };
  await store.record(attempt);
  await store.rollbackInstall(attempt, removed);
  expect(await store.find('skills', 'r')).toEqual(removed);
});

it('an intentional removal preserves a newer receipt snapshot written after removal was prepared', async () => {
  const store = createResourceInstallReceiptsStore('a', dir);
  const old = { ...receipt, localResourceIds: ['one'] };
  const newer = {
    ...old,
    hash: 'newer',
    authorizedAt: '2026-10-29T18:00:00.000Z',
    sharedByName: 'New author',
  };
  await store.record(old);
  await store.record(newer);
  await store.record({ ...old, uninstalledLocalResourceIds: ['one'] });
  expect(await store.find('skills', 'r')).toEqual({
    ...newer,
    uninstalledLocalResourceIds: ['one'],
  });
});

it('fails closed when a row this build cannot read names the local resource', async () => {
  const file = join(dir, 'resource-install-receipts.json');
  const future = {
    family: 'pipelines',
    remoteId: 'future',
    localResourceIds: ['local-1'],
    ownerContext: { kind: 'organization', team: 'later-format' },
    hash: 'h1',
  };
  await writeFile(
    file,
    JSON.stringify({ version: 1, byAccount: { b: [future] } }),
  );
  const store = createResourceInstallReceiptsStore('a', dir);
  await expect(store.findLocal('pipelines', 'local-1')).rejects.toThrow(
    'Unreadable resource install receipt',
  );
  await expect(
    store.listOrganizationContentOwners('pipelines', 'h1'),
  ).rejects.toThrow('Unreadable resource install receipt');
  expect(await store.findLocal('pipelines', 'local-2')).toBeUndefined();
  expect(await store.findLocal('skills', 'local-1')).toBeUndefined();
  expect(await store.listOrganizationContentOwners('pipelines', 'h2')).toEqual(
    [],
  );
});

it('fails closed on local lookups when an account entry is not a list', async () => {
  await writeFile(
    join(dir, 'resource-install-receipts.json'),
    JSON.stringify({ version: 1, byAccount: { b: { receipt } } }),
  );
  const store = createResourceInstallReceiptsStore('a', dir);
  await expect(store.findLocal('skills', 'anything')).rejects.toThrow(
    'Unreadable resource install receipt',
  );
  await expect(
    store.listOrganizationContentOwners('skills', 'v1'),
  ).rejects.toThrow('Unreadable resource install receipt');
});

it('refuses a receipt file from a newer version and never writes over it', async () => {
  const file = join(dir, 'resource-install-receipts.json');
  const newer = JSON.stringify({ version: 2, byAccount: {} });
  await writeFile(file, newer);
  const store = createResourceInstallReceiptsStore('a', dir);
  await expect(store.findLocal('skills', 'x')).rejects.toThrow(
    'Resource install receipt file is from a newer version',
  );
  await expect(store.record(receipt)).rejects.toThrow(
    'Resource install receipt file is from a newer version',
  );
  expect(await readFile(file, 'utf8')).toBe(newer);
});

it('makes receipt writes and rollbacks durable', async () => {
  const write = jest.spyOn(atomicFile, 'writeFileAtomically');
  try {
    const store = createResourceInstallReceiptsStore('a', dir);
    await store.record({ ...receipt, localResourceIds: ['s1'] });
    await store.rollbackInstall(
      { ...receipt, localResourceIds: ['s1'] },
      undefined,
    );
    expect(write).toHaveBeenCalledTimes(2);
    for (const call of write.mock.calls)
      expect(call[2]).toMatchObject({ durable: true, mode: 0o600 });
  } finally {
    write.mockRestore();
  }
});

it('treats a receipt installed before its folder flush failed as recorded', async () => {
  const { StorageOutcomeUnknownError } =
    await import('@canopy/core-runtime/storage');
  const real = atomicFile.writeFileAtomically;
  const write = jest
    .spyOn(atomicFile, 'writeFileAtomically')
    .mockImplementationOnce(async (target, data, options) => {
      await real(target, data, { ...options, durable: false });
      throw new StorageOutcomeUnknownError(
        'directory_flush',
        new Error('flush failed'),
      );
    });
  try {
    const store = createResourceInstallReceiptsStore('a', dir);
    await expect(
      store.record({ ...receipt, localResourceIds: ['s1'] }),
    ).resolves.toBeUndefined();
    await store.rollbackInstall(
      { ...receipt, localResourceIds: ['s1'] },
      undefined,
    );
    expect(await store.findLocal('skills', 's1')).toBeUndefined();
  } finally {
    write.mockRestore();
  }
});
