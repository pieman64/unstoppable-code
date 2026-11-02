import type { PlatformSecretProtectionServices } from '../../../../platform/secret-protection';
import {
  createFakeSecretProtection,
  type FakeSecretProtection,
} from '../../../../platform/testing/fake-secret-protection';
import type { VaultStore, VaultStoreFaults } from '../store';
import { initializeVault } from '../store-init';
import { unwrapDataKey } from '../vault-keys';
import { storeFolder, type StoreFolder } from './store-fixtures';

let dir: StoreFolder;
let store: VaultStore | null;
let fake: FakeSecretProtection;
let written: string[];

beforeEach(() => {
  dir = storeFolder();
  store = null;
  fake = createFakeSecretProtection({ backend: 'macos_keychain' });
  written = [];
});

afterEach(() => {
  store?.close();
  dir.remove();
});

const signal = new AbortController().signal;

function initialize(target: VaultStore): ReturnType<typeof initializeVault> {
  const port: PlatformSecretProtectionServices = {
    ...fake.port,
    writeKeySlot: (slot, material, options) => {
      written.push(slot.name);
      return fake.port.writeKeySlot(slot, material, options);
    },
  };
  return initializeVault(target, port, signal);
}

async function reopen(faults?: VaultStoreFaults): Promise<VaultStore> {
  store?.close();
  store = await dir.opened(faults);
  return store;
}

describe('vault init order (CAN-5375, plan Q4c item 7)', () => {
  it('creates the slot without prompting, then a header its KEK unwraps', async () => {
    const result = await initialize(await reopen());
    if (result.kind !== 'initialized') throw new Error(result.kind);

    const slot = fake.peek(`vault-${result.header.vaultId}`);
    if (!(slot instanceof Uint8Array)) throw new Error('No slot.');
    const unwrapped = unwrapDataKey(
      slot,
      result.header.wrappedDataKey,
      result.header.vaultId,
    );
    expect(unwrapped).toEqual({ kind: 'unwrapped', dataKey: result.dataKey });
    expect(fake.prompts).toBe(0);
    expect((await reopen()).header).toEqual(result.header);
  });

  it('settles an uncertain slot write by re-reading the slot', async () => {
    fake.inject({ kind: 'uncertain', operation: 'write', applied: true });
    expect(await initialize(await reopen())).toMatchObject({
      kind: 'initialized',
    });

    store?.close();
    dir.remove();
    dir = storeFolder();
    fake.inject({ kind: 'uncertain', operation: 'write', applied: false });
    expect(await initialize(await reopen())).toEqual({
      kind: 'not_initialized',
      step: 'slot_uncertain',
    });
    expect((await reopen()).header).toBeNull();
  });

  it('writes no header when the backend blocks or fails the create', async () => {
    fake.inject({ kind: 'locked' });
    expect(await initialize(await reopen())).toEqual({
      kind: 'blocked',
      reason: 'locked',
    });
    expect(fake.prompts).toBe(0);
    fake.clearFaults();
    fake.inject({ kind: 'write_failed' });
    expect(await initialize(await reopen())).toMatchObject({
      kind: 'not_initialized',
    });
    expect((await reopen()).header).toBeNull();
  });

  it('leaves an orphaned slot alone and starts a new vault after a failed header write', async () => {
    let fail = true;
    const faulty = await reopen({
      beforeWrite: () => {
        if (fail) throw new Error('disk full');
      },
    });
    expect(await initialize(faulty)).toEqual({
      kind: 'not_initialized',
      step: 'header',
    });
    const [orphan] = written;
    const orphanKek = fake.peek(orphan);
    fail = false;

    const result = await initialize(await reopen());
    if (result.kind !== 'initialized') throw new Error(result.kind);
    expect(written).toHaveLength(2);
    expect(written[1]).not.toBe(orphan);
    expect(fake.peek(orphan)).toEqual(orphanKek);
  });

  it('reports an uncertain header commit and faults the store', async () => {
    const faulty = await reopen({
      sync: () => {
        throw new Error('fsync failed');
      },
    });
    expect(await initialize(faulty)).toEqual({
      kind: 'not_initialized',
      step: 'header_uncertain',
    });
    expect(faulty.state).toBe('faulted');
  });

  it('reports a header whose checkpoint failed as uncertain, and the reopen keeps that vault', async () => {
    const faulty = await reopen({
      checkpoint: () => {
        throw new Error('disk I/O error');
      },
    });
    expect(await initialize(faulty)).toEqual({
      kind: 'not_initialized',
      step: 'header_uncertain',
    });
    expect(faulty.state).toBe('faulted');

    const header = (await reopen()).header;
    if (header === null) throw new Error('No header.');
    expect(written).toEqual([`vault-${header.vaultId}`]);
    expect(await initialize(await reopen())).toEqual({
      kind: 'not_initialized',
      step: 'store',
    });
    expect(written).toHaveLength(1);
  });

  it('never re-creates over an existing header, and never calls the backend for it', async () => {
    const first = await initialize(await reopen());
    if (first.kind !== 'initialized') throw new Error(first.kind);
    fake.inject({ kind: 'key_missing', slot: `vault-${first.header.vaultId}` });

    expect(await initialize(await reopen())).toEqual({
      kind: 'not_initialized',
      step: 'store',
    });
    expect(written).toHaveLength(1);
    expect((await reopen()).header).toEqual(first.header);
  });
});
