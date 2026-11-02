// Run by crash.test.ts in a separate process, in one of two modes.
// `crash` opens the seeded vault, runs one scenario and kills itself with
// SIGKILL (on Windows, TerminateProcess) at the requested point. It first
// appends each outcome its caller saw, then where it died, to the report file
// synchronously. Both modes flush folders as core-platform does.
// `session` is the restart: it opens the vault with the key slot it is given
// and answers the test's calls over IPC until `close`.
import { appendFileSync } from 'node:fs';

import {
  createFakeSecretProtection,
  type FakeSecretProtection,
} from '../../../../platform/testing/fake-secret-protection';
import type {
  VaultFamilyWriter,
  VaultSecretRef,
} from '../../../../vault/contracts';
import {
  openVaultReadRepository,
  type VaultReadRepository,
} from '../read-repository';
import {
  openVaultStore,
  type VaultStore,
  type VaultStoreFaults,
} from '../store';
import {
  CRASH_OS,
  createWrite,
  deleteWrite,
  flushingSecureFiles,
  isCrashScenario,
  isCrashSlot,
  isCrashStage,
  isSessionRequest,
  replaceWrite,
  writeRequest,
  type VaultCrashDeath,
  type VaultCrashScenario,
  type VaultCrashSlot,
  type VaultCrashStage,
  type VaultDeathPoint,
  type VaultSessionCall,
  type VaultSessionReply,
  type VaultWriteSpec,
} from './crash-fixtures';
import { FAMILY, NOW } from './read-repository-fixtures';

const USAGE =
  'usage: crash <folder> <slot> <slot hex> <vault ID> <report> <a> <b> <c> <scenario> <stage>\n' +
  '       session <folder> <slot> <slot hex> <vault ID> <slot state>';

const [mode, folder, slotName, slotHex, vaultId, ...rest] =
  process.argv.slice(2);
if (!folder || !slotName || !slotHex || !vaultId) throw new Error(USAGE);

const clock = (): Date => new Date(NOW);
const decoder = new TextDecoder();

interface Opened {
  readonly store: VaultStore;
  readonly vault: VaultReadRepository;
}

async function openVault(
  fake: FakeSecretProtection,
  faults: VaultStoreFaults = {},
  hold: () => Promise<void> = () => Promise.resolve(),
): Promise<Opened> {
  const opened = await openVaultStore({
    folder,
    platform: { os: CRASH_OS, secureFiles: flushingSecureFiles() },
    openBusyTimeoutMs: 0,
    clock,
    faults,
  });
  if (opened.kind !== 'opened') throw new Error(`store: ${opened.step}`);
  const vault = await openVaultReadRepository({
    store: opened.store,
    slots: fake.port,
    signal: new AbortController().signal,
    clock,
    // Every `get` while the key is not held probes, as after an unlock.
    minProbeIntervalMs: 0,
    holdPut: hold,
    holdDelete: hold,
  });
  if (vault.kind !== 'opened') throw new Error(`vault: ${vault.step}`);
  return { store: opened.store, vault: vault.vault };
}

function perform(
  writer: VaultFamilyWriter,
  spec: VaultWriteSpec,
): Promise<unknown> {
  const built = writeRequest(spec, vaultId);
  return built.kind === 'put'
    ? writer.put(built.request)
    : writer.delete(built.request);
}

async function crash(
  report: string,
  [a, b, c]: readonly string[],
  scenario: VaultCrashScenario,
  stage: VaultCrashStage,
): Promise<void> {
  if (!a || !b || !c) throw new Error(USAGE);
  let store: VaultStore | null = null;
  /** The key of the write whose intent the death line records. */
  let watched: string | null = null;

  function die(point: VaultDeathPoint): never {
    const intent =
      watched === null || store === null
        ? null
        : (store.findIntent(FAMILY, watched)?.state ?? null);
    const death: VaultCrashDeath = { died: point, intent };
    appendFileSync(report, `${JSON.stringify(death)}\n`);
    process.kill(process.pid, 'SIGKILL');
    throw new Error('unreachable');
  }

  /** Arms the next COMMIT: die around it, or fail its sync lost or landed. */
  let nextSync: 'die_before' | 'die_after' | 'lose' | 'land' | null = null;
  let failWrites = false;
  const faults: VaultStoreFaults = {
    beforeWrite: () => {
      if (failWrites) throw new Error('injected write failure');
    },
    sync: (commit) => {
      const armed = nextSync;
      nextSync = null;
      if (armed === 'die_before') die('sync');
      if (armed === 'lose') throw new Error('injected sync failure');
      commit();
      if (armed === 'die_after') die('committed');
      if (armed === 'land') throw new Error('injected sync failure');
    },
  };

  const proceed = (): Promise<void> => Promise.resolve();
  let atHold = proceed;
  /** Holds the next write at its hold point until the returned release. */
  function gate(): () => void {
    let release = (): void => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    atHold = (): Promise<void> => released;
    return () => release();
  }
  /** Fails the sync of the next write's commit after it lands. */
  function landNext(): Promise<void> {
    atHold = proceed;
    nextSync = 'land';
    return proceed();
  }

  const fake = createFakeSecretProtection({
    backend: 'macos_keychain',
    slots: { [slotName]: Buffer.from(slotHex, 'hex') },
  });
  const opened = await openVault(fake, faults, () => atHold());
  store = opened.store;
  const { vault } = opened;
  if (vault.repository.status().protection.state !== 'available')
    throw new Error('The vault key is not held.');
  const writer = vault.writer(FAMILY);

  function record(write: VaultWriteSpec, outcome: unknown): void {
    appendFileSync(report, `${JSON.stringify({ write, outcome })}\n`);
  }
  async function reported(write: VaultWriteSpec): Promise<void> {
    record(write, await perform(writer, write));
  }

  if (scenario === 'lost-delete-intent') {
    // Known limits 1 and 2: a delete whose intent write is lost supersedes a
    // held put, every rewrite of that intent fails, and the process dies.
    const release = gate();
    const put = perform(writer, replaceWrite(a, 0));
    atHold = proceed;
    nextSync = 'lose';
    await reported(deleteWrite(a, 0));
    failWrites = true;
    await reported(deleteWrite(a, 0, 'second-delete'));
    release();
    record(replaceWrite(a, 0), await put);
  } else if (scenario === 'uncertain-tombstone') {
    // Known limit 3: the first tombstone lands uncertain, then a second delete.
    atHold = landNext;
    await reported(deleteWrite(a, 0, 'earlier'));
    await reported(deleteWrite(a, 0, 'later'));
  } else if (scenario === 'superseded') {
    // Both superseding deletes stay held: the process dies before either
    // tombstone.
    const releasePut = gate();
    const put = perform(writer, replaceWrite(b, 0, 'superseded-put'));
    gate();
    void perform(writer, deleteWrite(b, 0, 'superseding-delete-b'));
    const releaseDelete = gate();
    const earlier = perform(writer, deleteWrite(c, 0, 'superseded-delete'));
    gate();
    void perform(writer, deleteWrite(c, 0, 'superseding-delete-c'));
    atHold = proceed;
    releasePut();
    record(replaceWrite(b, 0, 'superseded-put'), await put);
    releaseDelete();
    record(deleteWrite(c, 0, 'superseded-delete'), await earlier);
  } else if (scenario === 'reconciled') {
    atHold = landNext;
    await reported(replaceWrite(a, 0, 'reconciled-put'));
    await vault.reconcile();
    await reported(replaceWrite(a, 0, 'reconciled-put'));
    atHold = landNext;
    await reported(deleteWrite(b, 0, 'reconciled-delete'));
    await vault.reconcile();
    await reported(deleteWrite(b, 0, 'reconciled-delete'));
  } else {
    // Outcomes final before the crashed write starts.
    await reported(replaceWrite(b, 0, 'prelude-put'));
    await reported(deleteWrite(c, 0, 'prelude-delete'));
    const write =
      scenario === 'create'
        ? createWrite()
        : scenario === 'replace'
          ? replaceWrite(a, 0)
          : deleteWrite(a, 0);
    watched = write.key;
    atHold = (): Promise<void> => {
      if (stage === 'after-intent') die('hold');
      if (stage === 'in-commit') nextSync = 'die_before';
      if (stage === 'after-commit') nextSync = 'die_after';
      return proceed();
    };
    // `put` and `delete` write nothing before the intent on an open store.
    if (stage === 'before-intent') nextSync = 'die_before';
    await reported(write);
  }
  die('end');
}

function sessionSlots(slot: VaultCrashSlot): FakeSecretProtection {
  const material = Buffer.from(slotHex, 'hex');
  if (slot === 'wrong_key') material[0] ^= 0xff;
  const fake = createFakeSecretProtection({
    backend: 'macos_keychain',
    slots: slot === 'missing' ? {} : { [slotName]: material },
  });
  if (slot === 'locked') fake.inject({ kind: 'locked' });
  if (slot === 'corrupt') fake.inject({ kind: 'corrupt', slot: slotName });
  return fake;
}

function session(slot: VaultCrashSlot): void {
  const send = process.send?.bind(process);
  if (!send) throw new Error('The session child needs an IPC channel.');
  const fake = sessionSlots(slot);
  const opening = openVault(fake);

  async function answer(call: VaultSessionCall): Promise<unknown> {
    const { store, vault } = await opening;
    const { repository } = vault;
    const ref = (entryId: string): VaultSecretRef => ({ vaultId, entryId });
    switch (call.op) {
      case 'status':
        return repository.status();
      case 'list':
        return Object.fromEntries(
          (await repository.list()).map((entry) => [
            entry.ref.entryId,
            { state: entry.state, revision: entry.revision },
          ]),
        );
      case 'get': {
        const outcome = await repository.get(ref(call.entryId));
        return outcome.kind === 'available'
          ? {
              kind: 'available',
              revision: outcome.pin.revision,
              secret: decoder.decode(outcome.material),
            }
          : outcome;
      }
      case 'admit':
        return repository.admit({
          ref: ref(call.entryId),
          revision: call.revision,
        });
      case 'write':
        return perform(vault.writer(FAMILY), call.write);
      case 'unlock':
        fake.clearFaults();
        return null;
      case 'slot': {
        const contents = fake.peek(slotName);
        return contents instanceof Uint8Array
          ? Buffer.from(contents).toString('hex')
          : contents;
      }
      case 'prompts':
        return fake.prompts;
      case 'close':
        vault.dispose();
        store.close();
        return null;
    }
  }

  process.on('message', (message: unknown) => {
    if (!isSessionRequest(message)) throw new Error('Malformed session call.');
    const { id, call } = message;
    void answer(call)
      .then(
        (result): VaultSessionReply => ({ id, result: result ?? null }),
        (error: unknown): VaultSessionReply => ({ id, error: String(error) }),
      )
      .then((reply) =>
        send(reply, undefined, undefined, () => {
          if (call.op === 'close') process.disconnect();
        }),
      );
  });
}

if (mode === 'crash') {
  const [report, a, b, c, scenario, stage] = rest;
  if (!report || !isCrashScenario(scenario) || !isCrashStage(stage))
    throw new Error(USAGE);
  void crash(report, [a ?? '', b ?? '', c ?? ''], scenario, stage);
} else if (mode === 'session') {
  const [slot] = rest;
  if (!isCrashSlot(slot)) throw new Error(USAGE);
  session(slot);
} else {
  throw new Error(USAGE);
}
