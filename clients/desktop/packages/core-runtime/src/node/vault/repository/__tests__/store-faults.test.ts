import {
  copyFileSync,
  existsSync,
  mkdirSync,
  statSync,
  truncateSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  VAULT_STORE_FILE,
  type VaultStore,
  type VaultStoreFaults,
} from '../store';
import { checkpointWal } from '../store-database';
import {
  STORE_VAULT_ID,
  intentKeys,
  putIntent,
  runStoreChild,
  sealedBox,
  storeChildTestTimeout,
  storeFolder,
  writeTestHeader,
  type StoreFolder,
} from './store-fixtures';

const posixIt = process.platform === 'win32' ? it.skip : it;

/*
 * Each fault point of a write, injected in-process, then a reopen shows what
 * reached the disk. Kill-the-process restarts at the same points are F-t's.
 */

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

function injected(): never {
  throw Object.assign(new Error('disk I/O error'), { errcode: 10 });
}

async function seededWith(faults: VaultStoreFaults): Promise<VaultStore> {
  const seeded = await dir.opened();
  writeTestHeader(seeded);
  seeded.recordIntent(putIntent('k0'));
  seeded.close();
  return dir.opened(faults);
}

async function reopened(): Promise<string[]> {
  store?.close();
  store = await dir.opened();
  return intentKeys(store);
}

describe('vault store fault points (CAN-5375)', () => {
  it.each<[string, VaultStoreFaults]>([
    ['before the write', { beforeWrite: injected }],
    ['after the write, before its sync', { beforeSync: injected }],
  ])(
    'rolls back a fault %s, reports not_written and stays usable',
    async (_point, faults) => {
      let armed = true;
      const once = (): void => {
        if (!armed) return;
        armed = false;
        injected();
      };
      store = await seededWith({
        beforeWrite: faults.beforeWrite && once,
        beforeSync: faults.beforeSync && once,
      });

      expect(store.recordIntent(putIntent('k1'))).toEqual({
        kind: 'not_written',
        step: 'write',
      });
      expect(store.state).toBe('open');
      expect(intentKeys(store)).toEqual(['k0']);
      expect(store.recordIntent(putIntent('k2')).kind).toBe('written');
      expect(await reopened()).toEqual(['k0', 'k2']);
    },
  );

  it.each([
    ['landed', true, ['k0', 'k1']],
    ['did not land', false, ['k0']],
  ])(
    'reports a sync error whose commit %s as uncertain and faults the store',
    async (_label, landed, afterReopen) => {
      store = await seededWith({
        sync: (commit) => {
          if (landed) commit();
          injected();
        },
      });

      expect(store.recordIntent(putIntent('k1'))).toEqual({
        kind: 'uncertain',
        step: 'commit',
      });
      expect(store.state).toBe('faulted');
      expect(store.recordIntent(putIntent('k2'))).toEqual({
        kind: 'not_written',
        step: 'store',
      });
      expect(() => store?.listIntents()).toThrow('unavailable');
      expect(await reopened()).toEqual(afterReopen);
    },
  );

  posixIt(
    'reports a real I/O error at commit as uncertain, and a reopen shows it never landed',
    async () => {
      (await seededWith({})).close();
      // 400 blocks admit the seeded files but not a 1 MB revision's WAL frames.
      expect(
        runStoreChild(dir.folder, {
          mode: 'commit-large',
          fileSizeBlocks: 400,
        }),
      ).toEqual({
        kind: 'opened',
        intent: 'written',
        commit: { kind: 'uncertain', step: 'commit' },
        state: 'faulted',
      });

      store = await dir.opened();
      expect(store.listEntries()).toEqual([]);
      expect(store.findIntent('test.family', 'large')).toMatchObject({
        state: 'pending',
      });
    },
    storeChildTestTimeout(1),
  );

  it('refuses a write re-entered inside another, leaving the outer one whole', async () => {
    let inner: unknown = null;
    store = await seededWith({
      beforeSync: () => {
        inner ??= store?.recordIntent(putIntent('inner'));
      },
    });

    expect(store.recordIntent(putIntent('k1')).kind).toBe('written');
    expect(inner).toEqual({ kind: 'not_written', step: 'store' });
    expect(await reopened()).toEqual(['k0', 'k1']);
  });

  it('keeps the header in the database file once init commits it', async () => {
    // No close in between: closing would checkpoint the header anyway.
    store = await dir.opened();
    writeTestHeader(store);
    store.recordIntent(putIntent('k1'));
    // A crash image whose WAL was lost, as a restore without it would leave.
    const crashed = join(dir.root, 'crashed');
    mkdirSync(crashed, { mode: 0o700 });
    copyFileSync(
      join(dir.folder, VAULT_STORE_FILE),
      join(crashed, VAULT_STORE_FILE),
    );
    store.close();

    const recovered = await dir.open({ folder: crashed });
    if (recovered.kind !== 'opened') throw new Error(recovered.step);
    store = recovered.store;
    expect(store.header?.vaultId).toBe(STORE_VAULT_ID);
  });

  // The files a held store left, as a crash would; without its WAL, as a
  // restore that lost it would.
  function crashImage(from: string, name: string, withWal: boolean): string {
    const crashed = join(dir.root, name);
    mkdirSync(crashed, { mode: 0o700 });
    for (const file of withWal
      ? [VAULT_STORE_FILE, `${VAULT_STORE_FILE}-wal`]
      : [VAULT_STORE_FILE])
      copyFileSync(join(from, file), join(crashed, file));
    return crashed;
  }

  it.each<[string, VaultStoreFaults['checkpoint']]>([
    ['fails', (): boolean => injected()],
    ['leaves frames behind', (): boolean => false],
  ])(
    'reports the header uncertain when its checkpoint %s, and the next open checkpoints it',
    async (_label, checkpoint) => {
      store = await dir.opened({ checkpoint });
      expect(
        store.writeHeader({
          vaultId: STORE_VAULT_ID,
          wrappedDataKey: sealedBox(1),
        }),
      ).toEqual({ kind: 'uncertain', step: 'checkpoint' });
      expect(store.state).toBe('faulted');
      expect(store.header).toBeNull();
      expect(store.recordIntent(putIntent('k1'))).toEqual({
        kind: 'not_written',
        step: 'store',
      });

      // The header committed to the WAL only; a crash keeps that WAL.
      const crashed = crashImage(dir.folder, 'crashed', true);
      store.close();
      const recovered = await dir.open({ folder: crashed });
      if (recovered.kind !== 'opened') throw new Error(recovered.step);
      store = recovered.store;
      expect(store.header?.vaultId).toBe(STORE_VAULT_ID);
      expect(store.recordIntent(putIntent('k1')).kind).toBe('written');

      // That open moved the header into the database file before any record.
      const restored = await dir.open({
        folder: crashImage(crashed, 'restored', false),
      });
      if (restored.kind !== 'opened') throw new Error(restored.step);
      expect(restored.store.header?.vaultId).toBe(STORE_VAULT_ID);
      restored.store.close();
    },
  );

  it('fails closed at open when a header cannot be checkpointed', async () => {
    let calls = 0;
    const incomplete = (): boolean => {
      calls += 1;
      return false;
    };
    // An empty store has no header to checkpoint.
    (await dir.opened({ checkpoint: incomplete })).close();
    expect(calls).toBe(0);

    (await seededWith({})).close();
    expect(await dir.open({ faults: { checkpoint: incomplete } })).toEqual({
      kind: 'store_unavailable',
      step: 'checkpoint',
    });
    expect(calls).toBe(1);
    store = await dir.opened();
    expect(store.header?.vaultId).toBe(STORE_VAULT_ID);
  });

  // Exclusive locking admits no reader, so a plain WAL database shows SQLite's
  // own busy result.
  it('counts only a checkpoint that empties the WAL as complete', () => {
    const path = join(dir.root, 'plain.sqlite');
    const writer = new DatabaseSync(path);
    const reader = new DatabaseSync(path);
    try {
      writer.exec(
        'PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE t (x)',
      );
      reader.exec('BEGIN');
      reader.prepare('SELECT * FROM t').all();
      // Every frame copied, but the reader keeps the WAL from truncating.
      expect(checkpointWal(writer, undefined)).toBe(false);
      writer.exec('INSERT INTO t VALUES (1)');
      // The reader's snapshot also holds back the newer frames.
      expect(checkpointWal(writer, undefined)).toBe(false);
      reader.exec('COMMIT');
      expect(checkpointWal(writer, undefined)).toBe(true);
      reader.close();
      writer.exec('PRAGMA journal_mode = DELETE');
      expect(checkpointWal(writer, undefined)).toBe(false);
    } finally {
      if (reader.isOpen) reader.close();
      writer.close();
    }
  });

  it('drops only a transaction whose WAL tail is torn', async () => {
    store = await seededWith({});
    store.recordIntent(putIntent('k1'));
    const wal = join(dir.folder, `${VAULT_STORE_FILE}-wal`);
    const walBefore = statSync(wal).size;
    store.recordIntent(putIntent('k2'));
    expect(statSync(wal).size).toBeGreaterThan(walBefore);

    // A crash image: the files as the held store left them, its last WAL
    // frame cut short as a power loss mid-write would.
    const crashed = join(dir.root, 'crashed');
    mkdirSync(crashed, { mode: 0o700 });
    copyFileSync(
      join(dir.folder, VAULT_STORE_FILE),
      join(crashed, VAULT_STORE_FILE),
    );
    copyFileSync(wal, join(crashed, `${VAULT_STORE_FILE}-wal`));
    truncateSync(
      join(crashed, `${VAULT_STORE_FILE}-wal`),
      statSync(wal).size - 100,
    );
    store.close();

    const recovered = await dir.open({ folder: crashed });
    if (recovered.kind !== 'opened') throw new Error(recovered.step);
    store = recovered.store;
    expect(intentKeys(store)).toEqual(['k0', 'k1']);
    expect(store.recordIntent(putIntent('k3')).kind).toBe('written');
    expect(intentKeys(store)).toEqual(['k0', 'k1', 'k3']);
  });

  it('fails closed on a torn database file', async () => {
    (await seededWith({})).close();
    const database = join(dir.folder, VAULT_STORE_FILE);
    expect(existsSync(`${database}-wal`)).toBe(false);
    // Keep the schema page and tear every table page after it; a short read
    // zero-fills, so a torn page that held only zeroes would go unnoticed.
    const pageSize = 4_096;
    expect(statSync(database).size).toBeGreaterThan(2 * pageSize);
    truncateSync(database, pageSize + 100);

    expect(await dir.open()).toMatchObject({ kind: 'store_unavailable' });
  });
});
