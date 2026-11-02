import { fork, spawnSync, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PLATFORM_SERVICE_METHODS } from '../../../../platform/platform-services.generated';
import { createFakeSecretProtection } from '../../../../platform/testing/fake-secret-protection';
import type {
  VaultPutOutcome,
  VaultSecretPin,
  VaultSecretRef,
} from '../../../../vault/contracts';
import { vaultKeySlot } from '../key-slot-outcome';
import { openVaultReadRepository } from '../read-repository';
import { openVaultStore, type VaultStoreOpenResult } from '../store';
import {
  CRASH_OS,
  CRASH_STAGES,
  CRASH_WRITES,
  CREATED_SECRET,
  ROTATED_SECRET,
  WINDOWS_FLUSH_LABEL,
  createWrite,
  deleteWrite,
  flushingSecureFiles,
  folderFlushFlags,
  isCrashDeath,
  isCrashReport,
  isSessionReply,
  replaceWrite,
  writeRequest,
  type VaultCrashDeath,
  type VaultCrashReport,
  type VaultCrashScenario,
  type VaultCrashSlot,
  type VaultCrashStage,
  type VaultCrashWrite,
  type VaultSessionCall,
  type VaultWriteSpec,
} from './crash-fixtures';
import { FAMILY, NOW } from './read-repository-fixtures';
import {
  storeChildTestTimeout,
  storeFolder,
  type StoreFolder,
} from './store-fixtures';

/*
 * Crash and restart (CAN-5468, unit F-t): a real child process runs writes
 * on a seeded vault and dies by SIGKILL at a stage of one; a second child
 * then restarts the vault from the files the first left, and the test checks
 * every outcome a caller can see through it. Every open flushes the vault
 * folder and its parent as core-platform does; on Windows that flush is
 * CAN-5151 D1's, so what a Windows restart shows rests on its label (see
 * WINDOWS_FLUSH_LABEL).
 */

const child = join(__dirname, 'crash-child.fixture.ts');
const CHILD_FLAGS = [
  '--disable-warning=ExperimentalWarning',
  '--import',
  'tsx',
];
const SESSION_TIMEOUT_MS = 60_000;
const OBSERVED_AT = new Date(NOW).toISOString();

interface Seeded {
  readonly vaultId: string;
  readonly slotName: string;
  readonly slotHex: string;
  /**
   * Four entries at revision 0. The crashed write targets `a`; the crash
   * child first replaces `b` and deletes `c`; nothing writes `d`.
   */
  readonly a: string;
  readonly b: string;
  readonly c: string;
  readonly d: string;
}

let template: StoreFolder;
let dir: StoreFolder;
let seeded: Seeded;
/** Each live session, with its exit. */
const sessions = new Map<ChildProcess, Promise<unknown>>();

// Seeded once and copied closed, so no test repeats the seed's commits and
// their flushes.
beforeAll(async () => {
  template = storeFolder(flushingSecureFiles());
  const store = await template.open({ os: CRASH_OS });
  if (store.kind !== 'opened') throw new Error(`store: ${store.step}`);
  const fake = createFakeSecretProtection({ backend: 'macos_keychain' });
  const opened = await openVaultReadRepository({
    store: store.store,
    slots: fake.port,
    signal: new AbortController().signal,
    clock: () => new Date(NOW),
  });
  if (opened.kind !== 'opened') throw new Error(`vault: ${opened.step}`);
  const { vault } = opened;
  const writer = vault.writer(FAMILY);
  const seed = async (key: string): Promise<string> => {
    const built = writeRequest(createWrite(key), vault.vaultId);
    if (built.kind !== 'put') throw new Error('A create is a put.');
    return committedPin(await writer.put(built.request)).ref.entryId;
  };
  const a = await seed('seed-a');
  const b = await seed('seed-b');
  const c = await seed('seed-c');
  const d = await seed('seed-d');
  const slotName = vaultKeySlot(vault.vaultId).name;
  const slot = fake.peek(slotName);
  vault.dispose();
  store.store.close();
  if (!(slot instanceof Uint8Array)) throw new Error('No key slot.');
  seeded = {
    vaultId: vault.vaultId,
    slotName,
    slotHex: Buffer.from(slot).toString('hex'),
    a,
    b,
    c,
    d,
  };
});

afterAll(() => template.remove());

beforeEach(() => {
  dir = storeFolder();
  cpSync(template.folder, dir.folder, { recursive: true });
});

// Waits for each killed session: Windows refuses to remove files it holds.
afterEach(async () => {
  sessions.forEach((_, session) => session.kill('SIGKILL'));
  await Promise.all(sessions.values());
  dir.remove();
});

function committedPin(outcome: VaultPutOutcome): VaultSecretPin {
  if (outcome.kind !== 'committed') throw new Error(JSON.stringify(outcome));
  return outcome.pin;
}

function childArgs(mode: 'crash' | 'session'): string[] {
  const { slotName, slotHex, vaultId } = seeded;
  return [mode, dir.folder, slotName, slotHex, vaultId];
}

interface Crashed {
  /** Every outcome a caller saw before the crash, in order. */
  readonly reported: readonly VaultCrashReport[];
  readonly death: VaultCrashDeath;
}

/**
 * How the crash child's own SIGKILL reaches this process. On Windows it is
 * TerminateProcess with exit code 1, and Node reports a signal only for a kill
 * the parent sent.
 */
const KILLED =
  process.platform === 'win32'
    ? { status: 1, signal: null }
    : { status: null, signal: 'SIGKILL' };

/** What a Windows restart proves rests on the folder flush, so it says so. */
const ON_WINDOWS_D1 =
  CRASH_OS === 'win32' ? ` (CAN-5151 D1: ${WINDOWS_FLUSH_LABEL})` : '';

/** Runs the crash child to its SIGKILL and reads what it reported first. */
function crash(
  scenario: VaultCrashScenario,
  stage: VaultCrashStage = 'reported',
): Crashed {
  const report = join(dir.root, 'report.jsonl');
  const { a, b, c } = seeded;
  const result = spawnSync(
    process.execPath,
    [
      ...CHILD_FLAGS,
      child,
      ...childArgs('crash'),
      report,
      a,
      b,
      c,
      scenario,
      stage,
    ],
    { encoding: 'utf8', timeout: SESSION_TIMEOUT_MS },
  );
  // The death line below shows the kill was the child's own.
  expect({
    status: result.status,
    signal: result.signal,
    stderr: result.stderr,
  }).toEqual({ ...KILLED, stderr: '' });
  const lines = existsSync(report)
    ? readFileSync(report, 'utf8')
        .trim()
        .split('\n')
        .map((line): unknown => JSON.parse(line))
    : [];
  const death = lines.pop();
  if (!isCrashDeath(death) || !lines.every(isCrashReport))
    throw new Error(`Malformed crash report: ${JSON.stringify(lines)}`);
  return { reported: lines, death };
}

type Listing = Record<string, { state: string; revision: number }>;

function isListing(value: unknown): value is Listing {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.values(value).every(
      (entry: unknown) =>
        typeof entry === 'object' &&
        entry !== null &&
        'state' in entry &&
        typeof entry.state === 'string' &&
        'revision' in entry &&
        typeof entry.revision === 'number',
    )
  );
}

/** A vault restarted in its own child process; every call crosses IPC. */
interface Session {
  status(): Promise<unknown>;
  list(): Promise<Listing>;
  /** `get`, with the material decoded. */
  get(entryId: string): Promise<unknown>;
  admit(entryId: string, revision: number): Promise<unknown>;
  write(spec: VaultWriteSpec): Promise<unknown>;
  /** Clears the backend's lock, as the user unlocking it would. */
  unlock(): Promise<void>;
  /** The slot's contents as hex, `corrupt`, or null. */
  slot(): Promise<unknown>;
  prompts(): Promise<unknown>;
  /** Closes the vault; the child must exit cleanly. */
  close(): Promise<void>;
}

function restart(slot: VaultCrashSlot = 'present'): Session {
  const session = fork(child, [...childArgs('session'), slot], {
    execArgv: CHILD_FLAGS,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    timeout: SESSION_TIMEOUT_MS,
  });
  let output = '';
  session.on('error', (error) => (output += String(error)));
  session.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  session.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const waiting = new Map<
    number,
    {
      readonly resolve: (result: unknown) => void;
      readonly reject: (error: Error) => void;
    }
  >();
  const exited = new Promise<{ code: number | null; signal: string | null }>(
    (resolve) => {
      session.on('close', (code, signal) => {
        sessions.delete(session);
        waiting.forEach(({ reject }) =>
          reject(new Error(`The session exited: ${output}`)),
        );
        waiting.clear();
        resolve({ code, signal });
      });
    },
  );
  sessions.set(session, exited);
  session.on('message', (message: unknown) => {
    if (!isSessionReply(message)) return;
    const waiter = waiting.get(message.id);
    waiting.delete(message.id);
    if ('error' in message) waiter?.reject(new Error(message.error));
    else waiter?.resolve(message.result);
  });
  let next = 0;
  function call(request: VaultSessionCall): Promise<unknown> {
    next += 1;
    const id = next;
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      session.send({ id, call: request }, (error) => {
        if (error === null) return;
        waiting.delete(id);
        reject(error);
      });
    });
  }
  return {
    status: () => call({ op: 'status' }),
    async list(): Promise<Listing> {
      const listing = await call({ op: 'list' });
      if (!isListing(listing)) throw new Error(JSON.stringify(listing));
      return listing;
    },
    get: (entryId) => call({ op: 'get', entryId }),
    admit: (entryId, revision) => call({ op: 'admit', entryId, revision }),
    write: (write) => call({ op: 'write', write }),
    unlock: async () => void (await call({ op: 'unlock' })),
    slot: () => call({ op: 'slot' }),
    prompts: () => call({ op: 'prompts' }),
    async close(): Promise<void> {
      await call({ op: 'close' });
      expect({ ...(await exited), output }).toEqual({
        code: 0,
        signal: null,
        output: '',
      });
    },
  };
}

function ref(entryId: string): VaultSecretRef {
  return { vaultId: seeded.vaultId, entryId };
}

function pin(entryId: string, revision: number): VaultSecretPin {
  return { ref: ref(entryId), revision };
}

function committedPut(entryId: string, revision: number): unknown {
  return { kind: 'committed', pin: pin(entryId, revision) };
}

function committedDelete(entryId: string, tombstoneRevision: number): unknown {
  return { kind: 'committed', ref: ref(entryId), tombstoneRevision };
}

function available(revision: number, secret = CREATED_SECRET): unknown {
  return { kind: 'available', revision, secret };
}

const DELETED = { kind: 'not_found', reason: 'deleted' };
const UNCONFIRMED = { kind: 'unconfirmed', state: 'unconfirmed' };
const DELETE_UNCONFIRMED = { kind: 'unconfirmed', state: 'delete_unconfirmed' };

function status(state: string, extra: object = {}): unknown {
  return {
    protection: { state, backend: 'macos_keychain', ...extra },
    observedAt: OBSERVED_AT,
  };
}

/** Every outcome reported final before the crash replays unchanged after it. */
async function expectFinalsKept(
  vault: Session,
  reported: readonly VaultCrashReport[],
): Promise<void> {
  const finals = reported.filter(({ outcome }) =>
    ['committed', 'superseded'].includes(
      typeof outcome === 'object' && outcome !== null && 'kind' in outcome
        ? String(outcome.kind)
        : '',
    ),
  );
  expect(finals.length).toBeGreaterThan(0);
  for (const { write, outcome } of finals)
    expect({ write, outcome: await vault.write(write) }).toEqual({
      write,
      outcome,
    });
}

/** What the stage left durable. */
function landed(stage: VaultCrashStage): 'nothing' | 'intent' | 'commit' {
  if (stage === 'before-intent') return 'nothing';
  return stage === 'after-intent' || stage === 'in-commit'
    ? 'intent'
    : 'commit';
}

type Durable = ReturnType<typeof landed>;

/** Where each stage killed the child, and its intent as it saw it then. */
const DEATHS: Record<VaultCrashStage, VaultCrashDeath> = {
  'before-intent': { died: 'sync', intent: 'pending' },
  'after-intent': { died: 'hold', intent: 'pending' },
  'in-commit': { died: 'sync', intent: 'committed' },
  'after-commit': { died: 'committed', intent: 'committed' },
  reported: { died: 'end', intent: 'committed' },
};

function crashedWrite(write: VaultCrashWrite): VaultWriteSpec {
  if (write === 'create') return createWrite();
  return write === 'replace'
    ? replaceWrite(seeded.a, 0)
    : deleteWrite(seeded.a, 0);
}

/** Checks the crashed write after the restart; returns its same-key retry. */
type RestartCheck = (
  vault: Session,
  durable: Durable,
  before: Listing,
) => Promise<unknown>;

const AFTER_RESTART: Record<VaultCrashWrite, RestartCheck> = {
  async create(vault, durable, before) {
    const { a, b, d } = seeded;
    const created = Object.keys(before).filter((id) => ![a, b, d].includes(id));
    expect(created).toHaveLength(durable === 'nothing' ? 0 : 1);
    const [entryId] = created;
    if (entryId !== undefined) {
      const pending = durable === 'intent';
      expect(before[entryId]).toEqual({
        state: pending ? 'unconfirmed' : 'available',
        revision: 0,
      });
      expect(await vault.get(entryId)).toEqual(
        pending ? UNCONFIRMED : available(0),
      );
      expect(await vault.admit(entryId, 0)).toEqual({
        kind: pending ? 'unconfirmed' : 'admitted',
      });
    }
    const retry = await vault.write(createWrite());
    if (
      typeof retry !== 'object' ||
      retry === null ||
      !('pin' in retry) ||
      typeof retry.pin !== 'object' ||
      retry.pin === null ||
      !('ref' in retry.pin) ||
      typeof retry.pin.ref !== 'object' ||
      retry.pin.ref === null ||
      !('entryId' in retry.pin.ref) ||
      typeof retry.pin.ref.entryId !== 'string'
    )
      throw new Error(JSON.stringify(retry));
    const createdId = retry.pin.ref.entryId;
    // A durable intent keeps its minted ID; without one the retry is a new create.
    if (entryId !== undefined) expect(createdId).toBe(entryId);
    expect(retry).toEqual(committedPut(createdId, 0));
    expect(await vault.get(createdId)).toEqual(available(0));
    expect(await vault.write(deleteWrite(createdId, 0, 'follow-up'))).toEqual(
      committedDelete(createdId, 1),
    );
    return retry;
  },

  async replace(vault, durable, before) {
    const { a } = seeded;
    expect(before[a]).toEqual(
      {
        nothing: { state: 'available', revision: 0 },
        intent: { state: 'unconfirmed', revision: 0 },
        commit: { state: 'available', revision: 1 },
      }[durable],
    );
    expect(await vault.get(a)).toEqual(
      {
        nothing: available(0),
        intent: UNCONFIRMED,
        commit: available(1, ROTATED_SECRET),
      }[durable],
    );
    expect(await vault.admit(a, 0)).toEqual({
      kind: { nothing: 'admitted', intent: 'unconfirmed', commit: 'stale' }[
        durable
      ],
    });
    const retry = await vault.write(replaceWrite(a, 0));
    expect(retry).toEqual(committedPut(a, 1));
    expect(await vault.get(a)).toEqual(available(1, ROTATED_SECRET));
    expect(await vault.admit(a, 1)).toEqual({ kind: 'admitted' });
    expect(await vault.write(deleteWrite(a, 1, 'follow-up'))).toEqual(
      committedDelete(a, 2),
    );
    return retry;
  },

  async delete(vault, durable, before) {
    const { a } = seeded;
    expect(before[a]).toEqual(
      {
        nothing: { state: 'available', revision: 0 },
        intent: { state: 'delete_unconfirmed', revision: 0 },
        commit: undefined,
      }[durable],
    );
    expect(await vault.get(a)).toEqual(
      { nothing: available(0), intent: DELETE_UNCONFIRMED, commit: DELETED }[
        durable
      ],
    );
    expect(await vault.admit(a, 0)).toEqual({
      kind: durable === 'nothing' ? 'admitted' : 'revoked',
    });
    const retry = await vault.write(deleteWrite(a, 0));
    expect(retry).toEqual(committedDelete(a, 1));
    expect(await vault.get(a)).toEqual(DELETED);
    expect(await vault.admit(a, 0)).toEqual({ kind: 'revoked' });
    expect(await vault.write(replaceWrite(a, 0, 'follow-up'))).toEqual(DELETED);
    return retry;
  },
};

const KILL_POINTS = CRASH_WRITES.flatMap((write) =>
  CRASH_STAGES.map((stage): [VaultCrashWrite, VaultCrashStage] => [
    write,
    stage,
  ]),
);

describe(`vault crash and restart (CAN-5468)${ON_WINDOWS_D1}`, () => {
  it.each(KILL_POINTS)(
    'a %s killed at %s restarts to one outcome its same-key retry keeps',
    async (write, stage) => {
      const { b, c, d } = seeded;
      const { reported, death } = crash(write, stage);
      expect(death).toEqual(DEATHS[stage]);
      const prelude = [
        {
          write: replaceWrite(b, 0, 'prelude-put'),
          outcome: committedPut(b, 1),
        },
        {
          write: deleteWrite(c, 0, 'prelude-delete'),
          outcome: committedDelete(c, 1),
        },
      ];
      expect(reported.slice(0, 2)).toEqual(prelude);

      const vault = restart();
      const before = await vault.list();
      expect(await vault.status()).toEqual(status('available'));
      expect(before[b]).toEqual({ state: 'available', revision: 1 });
      expect(before[c]).toBeUndefined();
      expect(await vault.get(b)).toEqual(available(1, ROTATED_SECRET));
      expect(await vault.get(c)).toEqual(DELETED);
      expect(await vault.admit(b, 0)).toEqual({ kind: 'stale' });
      expect(await vault.admit(c, 0)).toEqual({ kind: 'revoked' });
      expect(before[d]).toEqual({ state: 'available', revision: 0 });
      expect(await vault.get(d)).toEqual(available(0));
      expect(await vault.admit(d, 0)).toEqual({ kind: 'admitted' });
      await expectFinalsKept(vault, reported);
      const retry = await AFTER_RESTART[write](vault, landed(stage), before);
      // Only the last stage let a caller see the crashed write's outcome.
      expect(reported.slice(2)).toEqual(
        stage === 'reported'
          ? [{ write: crashedWrite(write), outcome: retry }]
          : [],
      );
      expect(await vault.status()).toEqual(status('available'));
      await vault.close();
    },
    storeChildTestTimeout(2),
  );

  it(
    'a put and a delete reported superseded stay superseded, and the held deletes commit on retry',
    async () => {
      const { b, c } = seeded;
      const { reported, death } = crash('superseded');
      expect(death).toEqual({ died: 'end', intent: null });
      expect(reported).toEqual([
        {
          write: replaceWrite(b, 0, 'superseded-put'),
          outcome: { kind: 'superseded', ref: ref(b) },
        },
        {
          write: deleteWrite(c, 0, 'superseded-delete'),
          outcome: { kind: 'superseded', ref: ref(c) },
        },
      ]);

      const vault = restart();
      expect(await vault.list()).toMatchObject({
        [b]: { state: 'delete_unconfirmed', revision: 0 },
        [c]: { state: 'delete_unconfirmed', revision: 0 },
      });
      expect(await vault.get(b)).toEqual(DELETE_UNCONFIRMED);
      expect(await vault.admit(c, 0)).toEqual({ kind: 'revoked' });
      await expectFinalsKept(vault, reported);
      expect(
        await vault.write(deleteWrite(b, 0, 'superseding-delete-b')),
      ).toEqual(committedDelete(b, 1));
      expect(
        await vault.write(deleteWrite(c, 0, 'superseding-delete-c')),
      ).toEqual(committedDelete(c, 1));
      await expectFinalsKept(vault, reported);
      expect(await vault.get(b)).toEqual(DELETED);
      expect(await vault.get(c)).toEqual(DELETED);
      await vault.close();
    },
    storeChildTestTimeout(2),
  );

  it(
    'a put and a delete that reconcile promoted keep their commits across a crash',
    async () => {
      const { a, b } = seeded;
      const { reported } = crash('reconciled');
      const put = replaceWrite(a, 0, 'reconciled-put');
      const del = deleteWrite(b, 0, 'reconciled-delete');
      expect(reported).toEqual([
        { write: put, outcome: { kind: 'outcome_unknown', ref: ref(a) } },
        { write: put, outcome: committedPut(a, 1) },
        { write: del, outcome: { kind: 'outcome_unknown', ref: ref(b) } },
        { write: del, outcome: committedDelete(b, 1) },
      ]);

      const vault = restart();
      expect(await vault.get(a)).toEqual(available(1, ROTATED_SECRET));
      expect(await vault.get(b)).toEqual(DELETED);
      await expectFinalsKept(vault, reported);
      await vault.close();
    },
    storeChildTestTimeout(2),
  );
});

describe(`restart while the key is not held (CAN-5468)${ON_WINDOWS_D1}`, () => {
  it(
    'restarts locked, keeps the pending put and refuses new puts, deletes, then unlocks',
    async () => {
      const { a, b, c, d } = seeded;
      expect(crash('replace', 'after-intent').reported).toHaveLength(2);
      const vault = restart('locked');

      expect(await vault.status()).toEqual(
        status('locked', { evidence: 'reported' }),
      );
      expect(await vault.list()).toEqual({
        [a]: { state: 'unconfirmed', revision: 0 },
        [b]: { state: 'locked', revision: 1 },
        [d]: { state: 'locked', revision: 0 },
      });
      expect(await vault.get(a)).toEqual(UNCONFIRMED);
      expect(await vault.get(b)).toEqual({ kind: 'blocked', reason: 'locked' });
      expect(await vault.admit(b, 1)).toEqual({
        kind: 'blocked',
        reason: 'locked',
      });
      expect(await vault.get(c)).toEqual(DELETED);
      // A retry cannot be checked against its receipt without the key.
      expect(await vault.write(replaceWrite(a, 0))).toEqual({
        kind: 'unavailable',
        ref: ref(a),
      });
      expect(await vault.write(replaceWrite(b, 1, 'new-put'))).toEqual({
        kind: 'blocked',
        reason: 'locked',
      });
      expect(await vault.write(deleteWrite(b, 1, 'locked-delete'))).toEqual(
        committedDelete(b, 2),
      );

      await vault.unlock();
      // Only a `get` of an open entry reaches the backend.
      expect(await vault.get(d)).toEqual(available(0));
      expect(await vault.status()).toEqual(status('available'));
      expect(await vault.write(replaceWrite(a, 0))).toEqual(committedPut(a, 1));
      expect(await vault.get(a)).toEqual(available(1, ROTATED_SECRET));
      // A put refused before acceptance left its key unused.
      expect(await vault.write(replaceWrite(d, 0, 'new-put'))).toEqual(
        committedPut(d, 1),
      );
      expect(await vault.get(b)).toEqual(DELETED);
      expect(await vault.prompts()).toBe(0);
      await vault.close();
    },
    storeChildTestTimeout(2),
  );

  it.each(['missing', 'corrupt', 'wrong_key'] as const)(
    'restarts key_missing with the slot %s, re-creates nothing, and recovers once it returns',
    async (slot) => {
      const { a, b, c, d, slotHex } = seeded;
      expect(crash('replace', 'after-intent').reported).toHaveLength(2);
      const vault = restart(slot);

      expect(await vault.status()).toEqual(status('key_missing'));
      expect(await vault.list()).toEqual({
        [a]: { state: 'unconfirmed', revision: 0 },
        [b]: { state: 'key_missing', revision: 1 },
        [d]: { state: 'key_missing', revision: 0 },
      });
      expect(await vault.get(b)).toEqual({
        kind: 'blocked',
        reason: 'key_missing',
      });
      expect(await vault.write(replaceWrite(a, 0))).toEqual({
        kind: 'unavailable',
        ref: ref(a),
      });
      expect(await vault.write(replaceWrite(b, 1, 'new-put'))).toEqual({
        kind: 'blocked',
        reason: 'key_missing',
      });
      expect(await vault.write(deleteWrite(b, 1, 'blocked-delete'))).toEqual(
        committedDelete(b, 2),
      );
      // V1 never writes, replaces or deletes a slot, and never prompts.
      const wrongKey = Buffer.from(slotHex, 'hex');
      wrongKey[0] ^= 0xff;
      expect(await vault.slot()).toEqual(
        {
          missing: null,
          corrupt: 'corrupt',
          wrong_key: wrongKey.toString('hex'),
        }[slot],
      );
      expect(await vault.prompts()).toBe(0);
      await vault.close();

      // The header was not re-created: the original slot still unwraps it.
      const restored = restart();
      expect(await restored.status()).toEqual(status('available'));
      expect(await restored.get(c)).toEqual(DELETED);
      expect(await restored.get(b)).toEqual(DELETED);
      expect(await restored.get(d)).toEqual(available(0));
      expect(await restored.write(replaceWrite(a, 0))).toEqual(
        committedPut(a, 1),
      );
      expect(await restored.get(a)).toEqual(available(1, ROTATED_SECRET));
      await restored.close();
    },
    storeChildTestTimeout(3),
  );
});

describe(`the #7065 known limits across a real crash (CAN-5468)${ON_WINDOWS_D1}`, () => {
  it(
    'a lost delete intent never rewritten: the put it superseded commits on retry, and the restart lifts the fail-closed delete',
    async () => {
      const { a } = seeded;
      // No caller saw a final outcome before the crash.
      expect(crash('lost-delete-intent').reported).toEqual([
        {
          write: deleteWrite(a, 0),
          outcome: { kind: 'outcome_unknown', ref: ref(a) },
        },
        {
          write: deleteWrite(a, 0, 'second-delete'),
          outcome: { kind: 'refused', reason: 'closure_unrecorded' },
        },
        {
          write: replaceWrite(a, 0),
          outcome: { kind: 'outcome_unknown', ref: ref(a) },
        },
      ]);
      const vault = restart();

      expect(await vault.status()).toEqual(status('available'));
      expect((await vault.list())[a]).toEqual({
        state: 'unconfirmed',
        revision: 0,
      });
      expect(await vault.write(replaceWrite(a, 0))).toEqual(committedPut(a, 1));
      expect(await vault.get(a)).toEqual(available(1, ROTATED_SECRET));
      // The lost intent left no receipt: its key is a new delete.
      expect(await vault.write(deleteWrite(a, 0))).toEqual({
        kind: 'revision_conflict',
        currentRevision: 1,
      });
      expect(await vault.write(deleteWrite(a, 1, 'second-delete'))).toEqual(
        committedDelete(a, 2),
      );
      expect(await vault.get(a)).toEqual(DELETED);
      await vault.close();
    },
    storeChildTestTimeout(2),
  );

  it(
    'a delete after an uncertain tombstone landed: the restart settles the earlier committed and the later superseded',
    async () => {
      const { a } = seeded;
      expect(crash('uncertain-tombstone').reported).toEqual([
        {
          write: deleteWrite(a, 0, 'earlier'),
          outcome: { kind: 'outcome_unknown', ref: ref(a) },
        },
        {
          write: deleteWrite(a, 0, 'later'),
          outcome: { kind: 'unavailable', ref: ref(a) },
        },
      ]);
      const vault = restart();

      expect(await vault.status()).toEqual(status('available'));
      expect((await vault.list())[a]).toBeUndefined();
      expect(await vault.get(a)).toEqual(DELETED);
      expect(await vault.write(deleteWrite(a, 0, 'earlier'))).toEqual(
        committedDelete(a, 1),
      );
      expect(await vault.write(deleteWrite(a, 0, 'later'))).toEqual({
        kind: 'superseded',
        ref: ref(a),
      });
      expect(await vault.write(replaceWrite(a, 0, 'after'))).toEqual(DELETED);
      await vault.close();
    },
    storeChildTestTimeout(2),
  );
});

describe(`restart through the folder flush (CAN-5151 D1 on Windows: ${WINDOWS_FLUSH_LABEL})`, () => {
  const hostFlags = folderFlushFlags(CRASH_OS);
  const otherFlags = hostFlags === 'r' ? 'r+' : 'r';
  // Windows refuses a read-only flush; POSIX refuses a read-write folder open.
  const refusal = CRASH_OS === 'win32' ? 'flush:EPERM' : 'open:EISDIR';

  function openHere(
    secureFiles: ReturnType<typeof flushingSecureFiles>,
  ): Promise<VaultStoreOpenResult> {
    return openVaultStore({
      folder: dir.folder,
      platform: { os: CRASH_OS, secureFiles },
      openBusyTimeoutMs: 0,
    });
  }

  // The fixture copies core-platform's flush, which core-runtime may not
  // import; this contract is what both must keep.
  it('copies the flush the platform contract declares', () => {
    const contract = PLATFORM_SERVICE_METHODS.find(
      (method) => method.id === 'secureFiles.syncDirectory',
    );
    expect(contract?.win32).toBe('implemented');
    expect(contract?.purpose).toContain(
      `Windows flushes a read-write handle (CAN-5151 D1: ${WINDOWS_FLUSH_LABEL})`,
    );
    expect(folderFlushFlags('win32')).toBe('r+');
    expect(folderFlushFlags('darwin')).toBe('r');
    expect(folderFlushFlags('linux')).toBe('r');
  });

  it('flushes the vault folder and its parent, read-write only on Windows', async () => {
    expect(hostFlags).toBe(process.platform === 'win32' ? 'r+' : 'r');
    const files = flushingSecureFiles();
    const opened = await openHere(files);
    if (opened.kind !== 'opened') throw new Error(`store: ${opened.step}`);
    try {
      expect(opened.store.header?.vaultId).toBe(seeded.vaultId);
    } finally {
      opened.store.close();
    }
    expect(files.flushes).toEqual([
      { path: dir.root, flags: hostFlags, refused: null },
      { path: dir.folder, flags: hostFlags, refused: null },
    ]);
  });

  it.each(['parent', 'folder'] as const)(
    'fails closed when the host refuses the %s flush, and the next restart finds the crashed vault',
    async (refused) => {
      expect(crash('replace', 'after-intent').reported).toHaveLength(2);
      const target = refused === 'parent' ? dir.root : dir.folder;
      const files = flushingSecureFiles((path) =>
        path === target ? otherFlags : hostFlags,
      );
      expect(await openHere(files)).toEqual({
        kind: 'store_unavailable',
        step: 'folder',
      });
      expect(files.flushes).toEqual([
        ...(refused === 'folder'
          ? [{ path: dir.root, flags: hostFlags, refused: null }]
          : []),
        { path: target, flags: otherFlags, refused: refusal },
      ]);

      const vault = restart();
      expect(await vault.status()).toEqual(status('available'));
      expect((await vault.list())[seeded.a]).toEqual({
        state: 'unconfirmed',
        revision: 0,
      });
      expect(await vault.write(replaceWrite(seeded.a, 0))).toEqual(
        committedPut(seeded.a, 1),
      );
      await vault.close();
    },
    storeChildTestTimeout(2),
  );
});
