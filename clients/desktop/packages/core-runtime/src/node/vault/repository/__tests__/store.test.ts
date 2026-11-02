import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { openVaultSecret, sealVaultSecret } from '../sealed-secret';
import { VAULT_STORE_FILE, type VaultStore } from '../store';
import { VAULT_STORE_SCHEMA_VERSION } from '../store-schema';
import {
  deriveVaultSubkeys,
  disposeVaultSubkeys,
  generateVaultKey,
} from '../vault-keys';
import {
  STORE_VAULT_ID,
  intentKeys,
  putIntent,
  recordingSecureFiles,
  runStoreChild,
  sealedBox,
  storeChildTestTimeout,
  storeFolder,
  writeTestHeader,
  type StoreFolder,
} from './store-fixtures';

const posixIt = process.platform === 'win32' ? it.skip : it;

let dir: StoreFolder;
let store: VaultStore | null;

beforeEach(() => {
  dir = storeFolder();
  store = null;
});

afterEach(() => {
  store?.close();
  dir.remove();
});

function databasePath(): string {
  return join(dir.folder, VAULT_STORE_FILE);
}

function raw(run: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(databasePath());
  try {
    run(db);
  } finally {
    db.close();
  }
}

async function seeded(): Promise<VaultStore> {
  const opened = await dir.opened();
  writeTestHeader(opened);
  return opened;
}

describe('vault store open (CAN-5375)', () => {
  posixIt(
    'creates an owner-only folder and database, restricted and flushed before use',
    async () => {
      store = await dir.opened();

      expect(store.header).toBeNull();
      expect(statSync(dir.folder).mode & 0o777).toBe(0o700);
      expect(statSync(databasePath()).mode & 0o777).toBe(0o600);
      expect(dir.secureFiles.requests).toEqual([
        {
          path: dir.folder,
          kind: 'directory',
          mode: 'owner-only',
          action: 'restrict',
        },
        {
          path: databasePath(),
          kind: 'file',
          mode: 'owner-only',
          action: 'restrict',
        },
      ]);
      expect(dir.secureFiles.synced).toEqual([dirname(dir.folder), dir.folder]);
    },
  );

  it('runs WAL, synchronous=FULL, exclusive locking, secure delete and macOS fullfsync', async () => {
    store = await dir.opened();
    expect(store.durability()).toEqual({
      journalMode: 'wal',
      lockingMode: 'exclusive',
      synchronous: 2,
      fullfsync: true,
      secureDelete: true,
    });
    store.close();

    const linux = await dir.open({ os: 'linux' });
    if (linux.kind !== 'opened') throw new Error('Store did not open.');
    store = linux.store;
    expect(store.durability()).toMatchObject({ fullfsync: false });
  });

  it('makes each write durable before it returns', async () => {
    store = await seeded();
    expect(store.recordIntent(putIntent('k1'))).toMatchObject({
      kind: 'written',
      value: { sequence: 1, state: 'pending', outcomeRevision: null },
    });
    store.close();

    store = await dir.opened();
    expect(store.header).toMatchObject({
      vaultId: STORE_VAULT_ID,
      wrappedDataKey: sealedBox(1),
    });
    expect(intentKeys(store)).toEqual(['k1']);
  });

  it('refuses a second writer in this process, writing nothing', async () => {
    store = await seeded();
    expect(await dir.open()).toEqual({
      kind: 'store_unavailable',
      step: 'writer',
    });
    expect(store.recordIntent(putIntent('k1')).kind).toBe('written');
  });

  it(
    'refuses a second process while the store is held, and admits it once released',
    async () => {
      store = await seeded();
      expect(runStoreChild(dir.folder)).toEqual({
        kind: 'store_unavailable',
        step: 'writer',
      });
      expect(store.recordIntent(putIntent('k1')).kind).toBe('written');

      store.close();
      expect(runStoreChild(dir.folder)).toEqual({ kind: 'opened' });
      store = await dir.opened();
      expect(intentKeys(store)).toEqual(['k1']);
    },
    storeChildTestTimeout(2),
  );

  it('refuses an insecure folder before creating the database', async () => {
    dir.remove();
    dir = storeFolder(
      recordingSecureFiles((request) => request.kind === 'directory'),
    );
    expect(await dir.open()).toEqual({
      kind: 'store_unavailable',
      step: 'permissions',
    });
    expect(existsSync(databasePath())).toBe(false);
  });

  it('refuses an insecure database file before SQLite writes to it', async () => {
    dir.remove();
    dir = storeFolder(
      recordingSecureFiles((request) => request.kind === 'file'),
    );
    expect(await dir.open()).toEqual({
      kind: 'store_unavailable',
      step: 'permissions',
    });
    expect(statSync(databasePath()).size).toBe(0);
  });

  it('fails closed when the parent folder is missing', async () => {
    expect(
      await dir.open({ folder: join(dir.root, 'missing', 'vault') }),
    ).toEqual({ kind: 'store_unavailable', step: 'folder' });
  });

  it('never opens a newer or foreign schema', async () => {
    (await dir.opened()).close();
    raw((db) =>
      db
        .prepare(`UPDATE vault_meta SET value = ? WHERE key = 'schema_version'`)
        .run(String(VAULT_STORE_SCHEMA_VERSION + 1)),
    );
    expect(await dir.open()).toEqual({
      kind: 'store_unavailable',
      step: 'schema',
    });

    dir.remove();
    dir = storeFolder();
    (await dir.opened()).close();
    raw((db) => db.exec('DROP TABLE vault_meta'));
    expect(await dir.open()).toMatchObject({ step: 'schema' });
  });

  it.each([
    [
      'a dropped tombstone trigger',
      'DROP TRIGGER vault_entries_not_tombstoned',
    ],
    [
      'a rewritten tombstone trigger',
      `DROP TRIGGER vault_entries_not_tombstoned;
        CREATE TRIGGER vault_entries_not_tombstoned BEFORE INSERT ON vault_entries
        BEGIN SELECT 1; END`,
    ],
    ['a dropped index', 'DROP INDEX vault_intents_by_entry'],
    ['an added column', 'ALTER TABLE vault_entries ADD COLUMN extra TEXT'],
    [
      'a rebuilt table without its constraints',
      `DROP TABLE vault_tombstones;
        CREATE TABLE vault_tombstones (entry_id BLOB, family TEXT,
          revision INTEGER, sequence INTEGER, committed_at TEXT)`,
    ],
    [
      'an extra object',
      `CREATE TRIGGER vault_extra AFTER INSERT ON vault_tombstones
        BEGIN DELETE FROM vault_tombstones; END`,
    ],
  ])('never opens a current-version schema with %s', async (_, change) => {
    (await seeded()).close();
    raw((db) => db.exec(change));
    expect(await dir.open()).toEqual({
      kind: 'store_unavailable',
      step: 'schema',
    });
  });

  it.each([
    ['only SQLite statistics', 'ANALYZE'],
    ['a table named like an internal one', 'CREATE TABLE sqliteish (a)'],
  ])(
    'never builds the schema into a foreign database holding %s',
    async (_, contents) => {
      mkdirSync(dir.folder, { mode: 0o700 });
      raw((db) => db.exec(contents));
      expect(await dir.open()).toEqual({
        kind: 'store_unavailable',
        step: 'schema',
      });
    },
  );

  it('fails closed on records without a header, even once their rows are gone', async () => {
    const seededStore = await seeded();
    seededStore.recordIntent(putIntent('k1'));
    seededStore.close();
    raw((db) => db.exec('DELETE FROM vault_header'));
    expect(await dir.open()).toEqual({
      kind: 'store_unavailable',
      step: 'init_state',
    });

    raw((db) => db.exec('DELETE FROM vault_intents'));
    expect(await dir.open()).toMatchObject({ step: 'init_state' });
  });

  it.each(['-wal', '-journal'])(
    'fails closed on a %s whose database is gone, creating nothing',
    async (suffix) => {
      store = await seeded();
      store.recordIntent(putIntent('k1'));
      const lost = join(dir.root, 'lost');
      mkdirSync(lost, { mode: 0o700 });
      copyFileSync(
        `${databasePath()}-wal`,
        join(lost, `${VAULT_STORE_FILE}${suffix}`),
      );

      expect(await dir.open({ folder: lost })).toEqual({
        kind: 'store_unavailable',
        step: 'init_state',
      });
      expect(existsSync(join(lost, VAULT_STORE_FILE))).toBe(false);
    },
  );

  it('fails closed on a header that names no valid vault', async () => {
    (await seeded()).close();
    raw((db) => db.exec(`UPDATE vault_header SET vault_id = 'Not A Vault'`));
    expect(await dir.open()).toEqual({
      kind: 'store_unavailable',
      step: 'header',
    });
  });

  it('fails closed on a file that is not a vault database', async () => {
    (await dir.opened()).close();
    writeFileSync(databasePath(), 'not a database, and not empty either');
    expect(await dir.open()).toMatchObject({ kind: 'store_unavailable' });
  });
});

describe('vault store writes (CAN-5375)', () => {
  it('admits one header, only into an empty store, and no record before it', async () => {
    store = await dir.opened();
    expect(store.recordIntent(putIntent('k1'))).toEqual({
      kind: 'not_written',
      step: 'precondition',
    });
    writeTestHeader(store);
    expect(
      store.writeHeader({ vaultId: 'other', wrappedDataKey: sealedBox(2) }),
    ).toEqual({ kind: 'not_written', step: 'precondition' });
    expect(store.header?.vaultId).toBe(STORE_VAULT_ID);
  });

  it('rejects invalid input with a TypeError and no effect', async () => {
    store = await seeded();
    const invalid = [
      { ...putIntent('k1'), receipt: new Uint8Array(31) },
      { ...putIntent('k1'), kind: 'delete' as const },
      { ...putIntent('k1'), family: 'Not A Family' },
      { ...putIntent(''), entryId: 'e1' },
    ];
    for (const draft of invalid)
      expect(() => store?.recordIntent(draft)).toThrow(TypeError);
    expect(() =>
      store?.writeHeader({ vaultId: 'Bad ID', wrappedDataKey: sealedBox(1) }),
    ).toThrow(TypeError);
    expect(intentKeys(store)).toEqual([]);
  });

  it('keeps one intent per family and idempotency key', async () => {
    store = await seeded();
    store.recordIntent(putIntent('k1'));
    expect(store.recordIntent(putIntent('k1', 'entry-other'))).toEqual({
      kind: 'not_written',
      step: 'write',
    });
    expect(store.findIntent('test.family', 'k1')?.entryId).toBe('entry-k1');
  });

  it('commits a revision against its pending put, keeping its family fixed', async () => {
    store = await seeded();
    const intent = store.recordIntent(putIntent('k1'));
    if (intent.kind !== 'written') throw new Error('Intent not written.');
    const entry = {
      entryId: 'entry-k1',
      family: 'test.family',
      revision: 0,
      expiresAt: null,
      label: 'Token',
      sealed: sealedBox(3),
    };
    expect(
      store.commitEntry(intent.value.sequence, { ...entry, family: 'other' }),
    ).toEqual({ kind: 'not_written', step: 'precondition' });
    expect(store.commitEntry(intent.value.sequence, entry)).toMatchObject({
      kind: 'written',
      value: { ...entry, createdAt: '2026-10-29T12:00:00.000Z' },
    });
    expect(store.findIntent('test.family', 'k1')).toMatchObject({
      state: 'committed',
      outcomeRevision: 0,
    });
    expect(store.commitEntry(intent.value.sequence, entry)).toMatchObject({
      kind: 'not_written',
      step: 'precondition',
    });
  });

  it('erases the ciphertext in the tombstone transaction and never rewrites the entry', async () => {
    store = await seeded();
    const put = store.recordIntent(putIntent('k1'));
    if (put.kind !== 'written') throw new Error('Intent not written.');
    const marker = new Uint8Array(64).fill(0xa7);
    const entry = {
      entryId: 'entry-k1',
      family: 'test.family',
      revision: 0,
      expiresAt: null,
      label: 'Token',
      sealed: { ...sealedBox(3), ciphertext: marker },
    };
    store.commitEntry(put.value.sequence, entry);
    const removal = store.recordIntent({
      ...putIntent('k2', 'entry-k1'),
      kind: 'delete',
      expectedRevision: 0,
    });
    if (removal.kind !== 'written') throw new Error('Intent not written.');

    expect(store.commitTombstone(removal.value.sequence, 1)).toMatchObject({
      kind: 'written',
      value: { entryId: 'entry-k1', revision: 1 },
    });
    expect(store.readEntry('entry-k1')).toBeNull();
    const replay = store.recordIntent(putIntent('k3', 'entry-k1'));
    if (replay.kind !== 'written') throw new Error('Intent not written.');
    // Refused before the insert, so the rule does not rest on the trigger.
    expect(store.commitEntry(replay.value.sequence, entry)).toEqual({
      kind: 'not_written',
      step: 'precondition',
    });
    expect(store.readEntry('entry-k1')).toBeNull();
    expect(store.findIntent('test.family', 'k3')).toMatchObject({
      state: 'pending',
      outcomeRevision: null,
    });
    store.close();

    const bytes = readFileSync(databasePath());
    expect(bytes.includes(Buffer.from(marker))).toBe(false);
    store = await dir.opened();
    expect(store.readTombstone('entry-k1')).toMatchObject({
      revision: 1,
      sequence: removal.value.sequence,
      committedAt: '2026-10-29T12:00:00.000Z',
    });
  });

  it('round-trips embedded NULs and a leading BOM in caller text, so a sealed entry still opens', async () => {
    store = await seeded();
    const keys = deriveVaultSubkeys(generateVaultKey(), STORE_VAULT_ID);
    const entry = {
      entryId: 'entry\0one',
      family: 'test.family',
      revision: 0,
      expiresAt: null,
      label: '\uFEFFTo\0ken',
    };
    const fields = { ...entry, vaultId: STORE_VAULT_ID };
    const material = new TextEncoder().encode('s3cr3t');
    const put = store.recordIntent(putIntent('key\0one', fields.entryId));
    // A NUL-prefix sibling stays a distinct key and entry.
    store.recordIntent(putIntent('key', 'entry'));
    if (put.kind !== 'written') throw new Error('Intent not written.');
    store.commitEntry(put.value.sequence, {
      ...entry,
      sealed: sealVaultSecret(keys, fields, material),
    });
    store.close();

    store = await dir.opened();
    expect(intentKeys(store)).toEqual(['key\0one', 'key']);
    expect(store.findIntent('test.family', 'key\0one')).toMatchObject({
      entryId: 'entry\0one',
      state: 'committed',
    });
    const stored = store.readEntry('entry\0one');
    expect(stored).toMatchObject(entry);
    if (stored === null) throw new Error('Entry not read.');
    const opened = openVaultSecret(
      keys,
      { ...stored, vaultId: STORE_VAULT_ID },
      stored.sealed,
    );
    expect(opened).toEqual({ kind: 'opened', material });
    expect(store.listEntries().map((row) => row.label)).toEqual([
      '\uFEFFTo\0ken',
    ]);

    const removal = store.recordIntent({
      ...putIntent('del\0one', 'entry\0one'),
      kind: 'delete',
      expectedRevision: 0,
    });
    if (removal.kind !== 'written') throw new Error('Intent not written.');
    expect(store.commitTombstone(removal.value.sequence, 1)).toMatchObject({
      kind: 'written',
    });
    expect(store.readEntry('entry\0one')).toBeNull();
    expect(store.readTombstone('entry\0one')).toMatchObject({
      entryId: 'entry\0one',
    });
    expect(store.readTombstone('entry')).toBeNull();
    disposeVaultSubkeys(keys);
  });
});
