import { spawn, type ChildProcess } from 'node:child_process';
import type * as NodeFs from 'node:fs';
import { existsSync, promises as fsPromises, statSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  runSpawnedProcessLocally,
  SecretValueRedactor,
  type RecordStoreFactory,
} from '../spawned-process';
import { runSpawnedProcessInline } from '../step-runner';
import {
  createFileRecordStore,
  settleLateStorageCleanups,
  SpillingRecordStore,
  type RecordStore,
} from '../record-store';
import { redactRecordFromSource } from '../streaming-json-redactor';
import { redactSerializedJsonLine } from '../../../../lib/redaction';
import { overlapMatcherWorkCounters } from '../../../../lib/overlap-matcher';

/**
 * Record storage through the ACTUAL hosts.
 *
 * There are two of them and they are separate wirings of the same redactor:
 * the utility host (`runSpawnedProcessLocally`, what the desktop app injects)
 * and the inline host (`runSpawnedProcessInline`, what the CLI uses when no
 * runner is injected). Exercising the shared redactor and calling the result
 * "both hosts" is not coverage of either.
 *
 * Every test here forces the stored path at a small threshold AND asserts it
 * was entered. A green run on a record that never spilled proves nothing about
 * storage.
 */

function definedEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const defined: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined) defined[name] = value;
  }
  return defined;
}

/**
 * Big enough that the record CANNOT arrive in one read.
 *
 * A pipe read is 64 KiB, and a record that fits in one `data` event has its
 * terminator in the same chunk — so line assembly never crosses the spill
 * threshold and storage is never used at all. At 40,000 characters these tests
 * passed in isolation and silently skipped the path under test when the
 * machine was loaded enough to coalesce the child's writes.
 */
const RECORD_FILLER = 400_000;
const record = (): string =>
  `${JSON.stringify({
    SECRETVALUE: 'masked key',
    filler: 'z'.repeat(RECORD_FILLER),
    '***': 'ordinary',
  })}\n`;
const expected = (): string => record().replace('SECRETVALUE', '***__1');

/**
 * Writes the staged record as BYTE slices, respecting drain.
 *
 * Character slices can never split a surrogate pair, so they cannot reproduce
 * the encoding boundary. Byte slices are what a real child emits and what the
 * host's own decoder has to reassemble.
 */
const byteWriter = (stream: 'stdout' | 'stderr', file: string): string =>
  `(function(){const b=require('node:fs').readFileSync(${JSON.stringify(file)});let i=0;` +
  `const w=process.${stream};function send(){if(i===b.length)return;` +
  `const c=b.subarray(i,i+4096);i+=c.length;` +
  `if(w.write(c))setImmediate(send);else w.once('drain',send);}send();})();`;

/** Writes the staged record in paced chunks, respecting drain. */
const writer = (stream: 'stdout' | 'stderr', file: string): string =>
  // Wrapped in an IIFE so two writers can be concatenated into one program
  // without their declarations colliding — a duplicate `const` is a child
  // SyntaxError, which looks exactly like a failure of the code under test.
  `(function(){const s=require('node:fs').readFileSync(${JSON.stringify(file)},'utf8');let i=0;` +
  `const w=process.${stream};function send(){if(i===s.length)return;` +
  `const c=s.slice(i,i+4096);i+=c.length;` +
  `if(w.write(c))setImmediate(send);else w.once('drain',send);}send();})();`;

/**
 * Tracks the private directories the stores under test actually create.
 *
 * Listing the temp directory instead does not work: under a parallel run
 * another suite's record stores land in the same place, which fails this suite
 * for a leak it did not cause and would equally hide one it did. (Isolating via
 * `TMPDIR` does not help either — jest's node environment hands each test file
 * a COPY of `process.env`, so `os.tmpdir()` inside the module under test still
 * reads the real one.)
 */
function tracking(): {
  wrap: (store: RecordStore) => RecordStore;
  survivors: () => Promise<string[]>;
  /**
   * Modes of the directory and record file for any sample that found them by
   * name while the store was live. Empty when neither was ever reachable.
   */
  modes: () => { directory?: number; file?: number };
  /** Live samples taken while the store was file-backed. */
  samples: () => number;
} {
  const seen = new Set<string>();
  const sampled: { directory?: number; file?: number } = {};
  let samples = 0;
  const note = (store: RecordStore): void => {
    const where: string | undefined = store.location;
    if (where === undefined) return;
    seen.add(where);
    samples += 1;
    // Sampled here, not after the run: the spill can land after the last
    // append, so `append` alone can miss it. The file is unlinked before its
    // first write, so normally neither path exists by the time it is sampled.
    try {
      sampled.directory ??= statSync(where).mode & 0o777;
    } catch {
      // Gone: the directory is removed once the file has no name.
    }
    try {
      sampled.file ??= statSync(join(where, 'record')).mode & 0o777;
    } catch {
      // Gone, or not yet created.
    }
  };
  return {
    modes: () => sampled,
    samples: () => samples,
    survivors: async (): Promise<string[]> => {
      const alive: string[] = [];
      // `Array.from` rather than iterating the Set: this project's lint target
      // types a `for...of` over a Set as `any`.
      for (const where of Array.from(seen))
        if (
          await stat(where).then(
            () => true,
            () => false,
          )
        )
          alive.push(where);
      return alive;
    },
    wrap: (inner: RecordStore): RecordStore => ({
      get length(): number {
        return inner.length;
      },
      get spilled(): boolean {
        return inner.spilled;
      },
      get location(): string | undefined {
        return inner.location;
      },
      get residentLength(): number {
        return inner.residentLength;
      },
      settling(): Promise<void> | undefined {
        return inner.settling();
      },
      append(text: string): boolean {
        note(inner);
        const accepted = inner.append(text);
        note(inner);
        return accepted;
      },
      whenDrained(): Promise<void> {
        return inner.whenDrained().then(() => {
          note(inner);
        });
      },
      async *replay(): AsyncIterable<string> {
        note(inner);
        yield* inner.replay();
      },
      dispose(): Promise<void> {
        note(inner);
        return inner.dispose();
      },
    }),
  };
}

/** What a host run gives a test: durable bytes, live bytes, and per stream. */
interface HostRun {
  status: string;
  error?: string;
  log: string;
  /**
   * The saved file as BYTES.
   *
   * Reading it back as a string reconstructs whatever the encoder produced, so
   * a surrogate pair written as two separate UTF-8 encodings comes back as two
   * replacement characters that a string comparison against a correctly
   * reconstructed expectation would still flag — but only the bytes show WHERE
   * the encoding went wrong. Comparing bytes is the assertion the Unicode
   * boundary needs.
   */
  logBytes: Buffer;
  live: string;
  stdout: string;
  stderr: string;
}

interface HostOptions {
  spillAfterChars: number;
  createRecordStore?: RecordStoreFactory;
  /** Overrides the default configured value for cases that need their own. */
  secretValues?: string[];
}

interface Observed {
  factory: RecordStoreFactory;
  created: number;
  /** True once a store actually moved to a file — the positive control. */
  spilled(): boolean;
  labels: string[];
}

function observing(): Observed {
  const labels: string[] = [];
  // Latched, not read at the end: `dispose` releases the file, so a store
  // that DID spill reports `spilled === false` once the step has finished.
  let everSpilled = false;
  const state = {
    created: 0,
    labels,
    spilled: (): boolean => everSpilled,
    factory: (after: number, label: string): RecordStore => {
      state.created += 1;
      labels.push(label);
      const inner = new SpillingRecordStore(after, label);
      const latch = (): void => {
        everSpilled = everSpilled || inner.spilled;
      };
      return {
        get length(): number {
          return inner.length;
        },
        get spilled(): boolean {
          return inner.spilled;
        },
        get location(): string | undefined {
          return inner.location;
        },
        get residentLength(): number {
          return inner.residentLength;
        },
        settling(): Promise<void> | undefined {
          return inner.settling();
        },
        append(text: string): boolean {
          latch();
          const accepted = inner.append(text);
          latch();
          return accepted;
        },
        whenDrained(): Promise<void> {
          return inner.whenDrained().then(latch);
        },
        async *replay(): AsyncIterable<string> {
          latch();
          yield* inner.replay();
        },
        dispose(): Promise<void> {
          latch();
          return inner.dispose();
        },
      };
    },
  };
  return state;
}

/** A store that fails at one chosen boundary and is otherwise real. */
function failingAt(
  boundary: 'create' | 'write' | 'read' | 'flush',
  afterChars = 0,
): {
  factory: RecordStoreFactory;
  disposals: () => number;
  /** Positive control: a store that is never built cannot fail. */
  built: () => number;
} {
  let disposals = 0;
  let built = 0;
  return {
    built: () => built,
    disposals: () => disposals,
    factory: (after: number, label: string): RecordStore => {
      built += 1;
      const inner = new SpillingRecordStore(after, label);
      let written = 0;
      return {
        get length(): number {
          return inner.length;
        },
        get spilled(): boolean {
          return inner.spilled;
        },
        get location(): string | undefined {
          return inner.location;
        },
        get residentLength(): number {
          return inner.residentLength;
        },
        settling(): Promise<void> | undefined {
          // A store whose file cannot be created fails the step through the
          // admission wait as well as through `append`.
          if (boundary === 'create')
            return Promise.reject(new Error('injected create failure'));
          return inner.settling();
        },
        append(text: string): boolean {
          if (boundary === 'create') throw new Error('injected create failure');
          written += text.length;
          if (boundary === 'write' && written > afterChars)
            throw new Error('injected write failure');
          const accepted = inner.append(text);
          // A flush failure is only reachable through a drain, and a drain is
          // only requested when the store reports its queue saturated.
          return boundary === 'flush' ? false : accepted;
        },
        whenDrained(): Promise<void> {
          if (boundary === 'flush')
            return Promise.reject(new Error('injected flush failure'));
          return inner.whenDrained();
        },
        async *replay(): AsyncIterable<string> {
          if (boundary === 'read') throw new Error('injected read failure');
          yield* inner.replay();
        },
        async dispose(): Promise<void> {
          disposals += 1;
          await inner.dispose();
        },
      };
    },
  };
}

/**
 * Disposes a redactor these tests drove by hand and checks its spill files
 * are really gone. Each of these used to leave two 400 KB record files in tmp.
 */
async function expectStoresRemoved(
  redactor: SecretValueRedactor,
  stores: readonly SpillingRecordStore[],
): Promise<void> {
  // Wait for any spill still being created, so there is a location to check.
  for (const store of stores) await store.settling();
  const locations = stores
    .map((store) => store.location)
    .filter((location): location is string => location !== undefined);
  // Positive control: these tests exist because a spill really happened.
  expect(locations.length).toBeGreaterThan(0);
  await redactor.disposeStorage();
  for (const store of stores) await store.dispose();
  for (const location of locations) {
    await expect(stat(location)).rejects.toMatchObject({ code: 'ENOENT' });
  }
}

// These tests do real filesystem and git work. Under a loaded multi-worker
// Jest run they have exceeded Jest's default 5 s, so leave headroom here.
jest.setTimeout(30_000);

describe('storage admission and accounting', () => {
  it('publishes backpressure while the spill file is still being created', async () => {
    // Creating the file is asynchronous. Until it exists the store keeps the
    // text in memory, and nothing synchronous can make that stop — so the ONLY
    // way the threshold means anything is for the redactor to publish a wait
    // the host can pause on. Everything below is synchronous on purpose: the
    // spill provably has not landed yet, which is exactly the window.
    const stores: SpillingRecordStore[] = [];
    const redactor = new SecretValueRedactor(
      ['SECRETVALUE'],
      1_024,
      (after, label) => {
        const store = new SpillingRecordStore(after, label);
        stores.push(store);
        return store;
      },
    );
    try {
      redactor.redactChunk(`{"v":"${'a'.repeat(200_000)}`);
      redactor.redactChunk('a'.repeat(200_000));
      const store = stores[0];
      expect(store).toBeDefined();
      // Positive control: the store really is holding the text in memory.
      expect(store?.spilled).toBe(false);
      expect(store?.length ?? 0).toBeGreaterThan(300_000);
      // The host has to be told to wait.
      expect(redactor.takePendingDrain()).toBeDefined();
    } finally {
      await expectStoresRemoved(redactor, stores);
    }
  });

  it('counts the characters the record store is still holding', async () => {
    // `bufferedCharacterLength` is what the bounded-memory assertions read.
    // Excluding the store's resident text made it report a bound it was not
    // measuring — zero, while hundreds of thousands of characters were held.
    const stores: SpillingRecordStore[] = [];
    const redactor = new SecretValueRedactor(
      ['SECRETVALUE'],
      1_024,
      (after, label) => {
        const store = new SpillingRecordStore(after, label);
        stores.push(store);
        return store;
      },
    );
    try {
      redactor.redactChunk(`{"v":"${'a'.repeat(400_000)}`);
      const store = stores[0];
      expect(store?.spilled).toBe(false);
      expect(redactor.bufferedCharacterLength).toBeGreaterThanOrEqual(
        store?.length ?? 0,
      );
    } finally {
      await expectStoresRemoved(redactor, stores);
    }
  });
});

describe('cancellation and deadlines while storage is still being created', () => {
  // Creating the spill file is ordinary asynchronous filesystem work, and it
  // can stall. A step the caller has cancelled, or whose deadline has passed,
  // must still settle promptly: the paused pipes used to keep the child's
  // `close` from ever firing, and the finalizer then awaited drains, stored
  // completions and `dispose()` — all queued behind the stalled `mkdtemp`.
  // Settling promptly must not abandon the storage either: the late file is
  // still owned, still removed when it finally appears, and nothing is written
  // to the step's output after it has settled.
  let directory = '';
  let release: () => void = () => undefined;
  let entered: () => void = () => undefined;
  let storageEntered: Promise<void> = Promise.resolve();
  let spy: jest.SpyInstance | undefined;
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'canopy-host-delay-'));
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    storageEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const original = fsPromises.mkdtemp.bind(fsPromises);
    spy = jest
      .spyOn(fsPromises, 'mkdtemp')
      .mockImplementation(async (prefix: string, ...rest: unknown[]) => {
        if (String(prefix).includes('canopy-record-')) {
          entered();
          await gate;
        }
        return original(prefix, ...(rest as []));
      });
    unhandled.length = 0;
    process.on('unhandledRejection', onUnhandled);
  });

  afterEach(async () => {
    release();
    spy?.mockRestore();
    await settleLateStorageCleanups();
    process.off('unhandledRejection', onUnhandled);
    await rm(directory, { recursive: true, force: true });
  });

  const source =
    `const s=JSON.stringify({f:'z'.repeat(400000),v:'SECRETVALUE'})+String.fromCharCode(10);` +
    `let i=0;function go(){if(i>=s.length)return;const c=s.slice(i,i+4096);i+=c.length;` +
    `if(process.stdout.write(c))setImmediate(go);else process.stdout.once('drain',go);}go();`;

  const hosts = [
    ['utility host', runSpawnedProcessLocally],
    ['inline host', runSpawnedProcessInline],
  ] as const;

  describe.each(hosts)('%s', (hostName, host) => {
    it.each(['abort', 'deadline'] as const)(
      'settles on %s while the spill file is still being created',
      async (mode) => {
        const tracked = tracking();
        const controller = new AbortController();
        const logFile = join(directory, `${mode}.log`);
        const live: string[] = [];
        let settledAt = 0;
        const running = host(
          { command: process.execPath, args: ['-e', source] },
          {
            cwd: directory,
            env: definedEnvironment(process.env),
            signal: controller.signal,
            timeout_minutes: mode === 'deadline' ? 0.005 : 1,
            logFile,
            outputFile: join(directory, `${mode}.out`),
            envFile: join(directory, `${mode}.env`),
            secretValues: ['SECRETVALUE'],
            spillAfterChars: 1_024,
            createRecordStore: (after, label) =>
              tracked.wrap(new SpillingRecordStore(after, label)),
            onOutput: (_stream, data) => {
              live.push(data);
            },
          },
        ).then((result) => {
          settledAt = Date.now();
          return result;
        });
        // Positive control: storage creation really started and is held.
        await storageEntered;
        if (mode === 'abort') controller.abort();
        const outcome = await Promise.race([
          running,
          new Promise<'still pending'>((resolve) =>
            setTimeout(() => resolve('still pending'), 3_000),
          ),
        ]);
        expect(outcome).not.toBe('still pending');
        const result = await running;
        expect(result.status).toBe(mode === 'abort' ? 'cancelled' : 'failure');
        if (mode === 'deadline') expect(result.error).toContain('timed out');
        const liveAtSettle = live.join('');
        const savedAtSettle = await readFile(logFile, 'utf8');
        expect(liveAtSettle).toBe(savedAtSettle);
        expect(savedAtSettle).not.toContain('SECRETVALUE');
        // Now the stalled filesystem work finishes. It must be cleaned up —
        // not orphaned — and must not add a single byte to a settled step.
        release();
        await settleLateStorageCleanups();
        expect(await tracked.survivors()).toEqual([]);
        expect(live.join('')).toBe(liveAtSettle);
        expect(await readFile(logFile, 'utf8')).toBe(savedAtSettle);
        expect(unhandled).toEqual([]);
        expect(settledAt).toBeGreaterThan(0);
      },
      60_000,
    );

    it('keeps an unrelated concurrent step exact while a sibling is cancelled mid-creation', async () => {
      const controller = new AbortController();
      const siblingLog = join(directory, 'sibling.log');
      const siblingText = `${JSON.stringify({ ok: 'SECRETVALUE here' })}\n`;
      const [cancelled, sibling] = await Promise.all([
        host(
          { command: process.execPath, args: ['-e', source] },
          {
            cwd: directory,
            env: definedEnvironment(process.env),
            signal: controller.signal,
            timeout_minutes: 1,
            logFile: join(directory, 'victim.log'),
            outputFile: join(directory, 'victim.out'),
            envFile: join(directory, 'victim.env'),
            secretValues: ['SECRETVALUE'],
            spillAfterChars: 1_024,
          },
        ),
        (async (): ReturnType<typeof host> => {
          await storageEntered;
          controller.abort();
          return host(
            {
              command: process.execPath,
              args: [
                '-e',
                `process.stdout.write(${JSON.stringify(siblingText)})`,
              ],
            },
            {
              cwd: directory,
              env: definedEnvironment(process.env),
              signal: new AbortController().signal,
              timeout_minutes: 1,
              logFile: siblingLog,
              outputFile: join(directory, 'sibling.out'),
              envFile: join(directory, 'sibling.env'),
              secretValues: ['SECRETVALUE'],
            },
          );
        })(),
      ]);
      expect(cancelled.status).toBe('cancelled');
      expect(sibling.status).toBe('success');
      expect(await readFile(siblingLog, 'utf8')).toBe(
        siblingText.replace('SECRETVALUE', '***'),
      );
    }, 60_000);

    it('still waits for delayed storage when the step succeeds, and stays exact', async () => {
      // Prompt settlement is for a step that is being STOPPED. A step whose
      // child finished normally owes its caller every byte, so it waits for
      // the delayed file and emits the record exactly.
      const logFile = join(directory, 'ok.log');
      const running = host(
        { command: process.execPath, args: ['-e', source] },
        {
          cwd: directory,
          env: definedEnvironment(process.env),
          signal: new AbortController().signal,
          timeout_minutes: 1,
          logFile,
          outputFile: join(directory, 'ok.out'),
          envFile: join(directory, 'ok.env'),
          secretValues: ['SECRETVALUE'],
          spillAfterChars: 1_024,
        },
      );
      await storageEntered;
      setTimeout(() => release(), 500);
      const result = await running;
      expect(result.status).toBe('success');
      expect(await readFile(logFile, 'utf8')).toBe(
        `${JSON.stringify({ f: 'z'.repeat(400_000), v: '***' })}\n`,
      );
    }, 60_000);
  });
});

describe('stopping a step while a stored record is replaying', () => {
  // A spilled record replays through the same raw matcher new lines use. A
  // stopped step resumes the child's pipes so it can reach EOF, and a new line
  // emitted mid-replay used to release the replay's held-back start of a
  // configured value on its own. The saved output must be a prefix of the
  // exactly masked stream — never a fragment of the value, never out of order.
  const SECRET = 'SECRET-TOKEN-123456';
  const FILLER = 400_000;
  let directory = '';

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'canopy-replay-stop-'));
  });
  afterEach(async () => {
    await settleLateStorageCleanups();
    await rm(directory, { recursive: true, force: true });
  });

  /** The child: one raw-routed spilled record, then late lines on request. */
  const childScript = (stream: 'stdout' | 'stderr', extra: string): string => `
const fs = require('node:fs');
const path = require('node:path');
const dir = ${JSON.stringify('__DIR__')};
const w = process.${stream};
const record = '{' + 'a'.repeat(${FILLER}) + ${JSON.stringify(SECRET)} + 'b'.repeat(50) + '\\n';
let i = 0;
function send() {
  while (i < record.length) {
    const piece = record.slice(i, i + 4096);
    i += piece.length;
    if (!w.write(piece)) return w.once('drain', send);
  }
}
send();
const timer = setInterval(() => {
  if (!fs.existsSync(path.join(dir, 'go'))) return;
  clearInterval(timer);
  for (let n = 0; n < 20; n += 1) w.write('late output line ' + n + '\\n');
  fs.writeFileSync(path.join(dir, 'late-written'), 'yes');
}, 5);
${extra}
setInterval(() => {}, 1000);
`;

  /** Replays in two pieces cut inside the value; holds the second. */
  const gatedStores = (): {
    factory: RecordStoreFactory;
    prefixReached: Promise<void>;
    release: () => void;
  } => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached: () => void = () => undefined;
    const prefixReached = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const factory: RecordStoreFactory = (after, label) => {
      const inner = new SpillingRecordStore(after, label);
      return {
        get length(): number {
          return inner.length;
        },
        get spilled(): boolean {
          return inner.spilled;
        },
        get residentLength(): number {
          return inner.residentLength;
        },
        get location(): string | undefined {
          return inner.location;
        },
        settling: (): Promise<void> | undefined => inner.settling(),
        append: (text: string): boolean => inner.append(text),
        whenDrained: (): Promise<void> => inner.whenDrained(),
        replay: async function* (): AsyncIterable<string> {
          let whole = '';
          for await (const piece of inner.replay()) whole += piece;
          const at = whole.indexOf(SECRET);
          if (at === -1) {
            yield whole;
            return;
          }
          yield whole.slice(0, at + 8);
          reached();
          await held;
          yield whole.slice(at + 8);
        },
        dispose: (): Promise<void> => inner.dispose(),
      };
    };
    return { factory, prefixReached, release };
  };

  const waitFor = async (file: string): Promise<void> => {
    for (;;) {
      try {
        await stat(file);
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
  };

  const expectedStream =
    `{${'a'.repeat(FILLER)}***${'b'.repeat(50)}\n` +
    Array.from({ length: 20 }, (_, n) => `late output line ${n}\n`).join('');

  const hosts = [
    ['utility host', runSpawnedProcessLocally],
    ['inline host', runSpawnedProcessInline],
  ] as const;

  describe.each(hosts)('%s', (_hostName, host) => {
    it.each([
      ['stdout', 'abort', 'exits on SIGTERM', ''],
      ['stderr', 'abort', 'exits on SIGTERM', ''],
      ['stdout', 'deadline', 'exits on SIGTERM', ''],
      [
        'stdout',
        'abort',
        'ignores SIGTERM and keeps writing',
        "process.on('SIGTERM', () => { for (let n = 0; n < 5; n += 1) w.write('after stop ' + n + '\\n'); });",
      ],
    ] as const)(
      'keeps %s masked when stopped by %s mid-replay (child %s)',
      async (stream, mode, _label, extra) => {
        const script = join(directory, 'child.js');
        await writeFile(
          script,
          childScript(stream, extra).replace('__DIR__', directory),
        );
        const gate = gatedStores();
        const controller = new AbortController();
        const live: string[] = [];
        const logFile = join(directory, 'step.log');
        let settledAt = 0;
        let prefixAt = 0;
        void gate.prefixReached.then(() => {
          prefixAt = Date.now();
        });
        const running = host(
          { command: process.execPath, args: [script] },
          {
            cwd: directory,
            env: definedEnvironment(process.env),
            signal: controller.signal,
            timeout_minutes: mode === 'deadline' ? 0.1 : 1,
            logFile,
            outputFile: join(directory, 'step.out'),
            envFile: join(directory, 'step.env'),
            secretValues: [SECRET],
            spillAfterChars: 1_024,
            createRecordStore: gate.factory,
            onOutput: (_stream, data) => {
              live.push(data);
            },
          },
        ).then((result) => {
          settledAt = Date.now();
          return result;
        });
        try {
          await gate.prefixReached;
          // The child's late lines are in the pipe before the stop.
          await writeFile(join(directory, 'go'), 'go');
          await waitFor(join(directory, 'late-written'));
          if (mode === 'abort') controller.abort();
          const result = await running;
          expect(result.status).toBe(
            mode === 'abort' ? 'cancelled' : 'failure',
          );
          // Positive control: the stop really happened mid-replay.
          expect(prefixAt).toBeGreaterThan(0);
          expect(prefixAt).toBeLessThanOrEqual(settledAt);
        } finally {
          gate.release();
          await running.catch(() => undefined);
        }
        await settleLateStorageCleanups();
        const saved = await readFile(logFile, 'utf8');
        expect(live.join('')).toBe(saved);
        for (const fragment of ['SECRET-T', 'OKEN-123456', 'after stop'])
          expect(saved).not.toContain(fragment);
        expect(expectedStream.startsWith(saved)).toBe(true);
      },
      60_000,
    );

    it('stays exact when the agent-terminal watchdog ends a step after a replay', async () => {
      const script = join(directory, 'child.js');
      await writeFile(
        script,
        childScript(
          'stdout',
          // Reports a terminal result after the late lines, then never exits.
          "const t2 = setInterval(() => { if (!fs.existsSync(path.join(dir, 'late-written'))) return; clearInterval(t2); w.write(JSON.stringify({ type: 'result', subtype: 'error_during_execution' }) + '\\n'); }, 5);",
        ).replace('__DIR__', directory),
      );
      const gate = gatedStores();
      const live: string[] = [];
      const logFile = join(directory, 'step.log');
      const running = host(
        { command: process.execPath, args: [script] },
        {
          cwd: directory,
          env: definedEnvironment(process.env),
          signal: new AbortController().signal,
          timeout_minutes: 1,
          logFile,
          outputFile: join(directory, 'step.out'),
          envFile: join(directory, 'step.env'),
          secretValues: [SECRET],
          spillAfterChars: 1_024,
          agentTerminalResultGraceMs: 200,
          createRecordStore: gate.factory,
          onOutput: (_stream, data) => {
            live.push(data);
          },
        },
      );
      try {
        await gate.prefixReached;
        await writeFile(join(directory, 'go'), 'go');
        await waitFor(join(directory, 'late-written'));
      } finally {
        gate.release();
      }
      const result = await running;
      expect(result.status).toBe('failure');
      expect(result.error).toContain('did not exit');
      await settleLateStorageCleanups();
      const saved = await readFile(logFile, 'utf8');
      expect(live.join('')).toBe(saved);
      // The watchdog does not stop the pipes early: everything, in order.
      expect(saved).toBe(
        `${expectedStream}${JSON.stringify({ type: 'result', subtype: 'error_during_execution' })}\n`,
      );
    }, 60_000);
  });
});

describe('a key index that fails to open its storage', () => {
  // Both hosts must fail the step when the key index cannot open its data
  // file, and neither may leave the slots file it had already opened.
  let directory = '';
  const realOpen = fsPromises.open.bind(fsPromises);

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'canopy-keyindex-host-'));
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await settleLateStorageCleanups();
    await rm(directory, { recursive: true, force: true });
  });

  const hosts = [
    ['utility host', runSpawnedProcessLocally],
    ['inline host', runSpawnedProcessInline],
  ] as const;

  it.each(hosts)(
    '%s fails the step and closes what it opened',
    async (_name, host) => {
      const opened: FileHandle[] = [];
      jest
        .spyOn(fsPromises, 'open')
        .mockImplementation(async (path, flags, mode) => {
          const name = String(path);
          if (name.includes('canopy-keyindex-') && name.endsWith('/data'))
            throw Object.assign(new Error('synthetic key data EIO'), {
              code: 'EIO',
            });
          const handle = await realOpen(path, flags, mode);
          if (name.includes('canopy-keyindex-')) opened.push(handle);
          return handle;
        });
      const input = join(directory, 'input.json');
      await writeFile(
        input,
        `${JSON.stringify({ [`${'k'.repeat(1024 * 1024 + 1)}***`]: 1 })}\n`,
      );
      try {
        const result = await host(
          {
            command: process.execPath,
            args: [
              '-e',
              `require('node:fs').createReadStream(${JSON.stringify(input)}).pipe(process.stdout)`,
            ],
          },
          {
            cwd: directory,
            env: definedEnvironment(process.env),
            signal: new AbortController().signal,
            timeout_minutes: 1,
            logFile: join(directory, 'step.log'),
            outputFile: join(directory, 'step.out'),
            envFile: join(directory, 'step.env'),
            secretValues: ['SECRETVALUE'],
            spillAfterChars: 1_024,
          },
        );
        await settleLateStorageCleanups();
        expect(result.status).toBe('failure');
        expect(result.error).toContain('synthetic key data EIO');
        // Positive control: the slots file really was opened.
        expect(opened.length).toBeGreaterThan(0);
        expect(opened.filter((handle) => handle.fd !== -1)).toEqual([]);
      } finally {
        for (const handle of opened)
          if (handle.fd !== -1) await handle.close().catch(() => undefined);
      }
    },
    60_000,
  );
});

describe('private storage whose setup fails part way', () => {
  // Each private directory is created, then restricted to its owner. When the
  // chmod failed, the directory existed but nothing owned it yet, so disposal
  // could not remove it. Both reach their real creation points here, at the
  // default thresholds.
  // The module object the code under test calls through; a namespace import
  // is frozen and cannot be spied on.
  const fs: typeof NodeFs = jest.requireActual('node:fs');
  const created: string[] = [];
  let injected = false;
  const realMkdtemp = fsPromises.mkdtemp.bind(fsPromises);
  const realMkdtempSync = fs.mkdtempSync;
  const failChmodFor = (prefix: string): void => {
    const matches = (path: unknown): boolean => String(path).includes(prefix);
    const fail = (): never => {
      injected = true;
      throw Object.assign(new Error('synthetic chmod EIO'), { code: 'EIO' });
    };
    jest.spyOn(fsPromises, 'mkdtemp').mockImplementation(async (...args) => {
      const directory = await realMkdtemp(...args);
      if (matches(directory)) created.push(directory);
      return directory;
    });
    jest.spyOn(fs, 'mkdtempSync').mockImplementation((...args) => {
      const directory = realMkdtempSync(...args);
      if (matches(directory)) created.push(String(directory));
      return directory;
    });
    const realChmod = fsPromises.chmod.bind(fsPromises);
    jest.spyOn(fsPromises, 'chmod').mockImplementation(async (path, mode) => {
      if (matches(path)) fail();
      return realChmod(path, mode);
    });
    const realChmodSync = fs.chmodSync;
    jest.spyOn(fs, 'chmodSync').mockImplementation((path, mode) => {
      if (matches(path)) fail();
      realChmodSync(path, mode);
    });
  };
  const source = (text: string): { chunks: () => AsyncIterable<string> } => ({
    chunks: async function* (): AsyncIterable<string> {
      for (let at = 0; at < text.length; at += 65_536)
        yield await Promise.resolve(text.slice(at, at + 65_536));
    },
  });

  beforeEach(() => {
    created.length = 0;
    injected = false;
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    for (const directory of created)
      await rm(directory, { recursive: true, force: true });
  });

  it.each([
    [
      'a key over the identity threshold',
      'canopy-record-identity-',
      JSON.stringify({ [`key${'x'.repeat(1_200_000)}`]: 1 }),
    ],
    [
      'an array nested past the resident frame window',
      'canopy-frames-',
      `${'['.repeat(70_000)}0${']'.repeat(70_000)}`,
    ],
  ])('leaves no directory behind for %s', async (_name, prefix, record) => {
    failChmodFor(prefix);
    await expect(
      redactRecordFromSource(source(record), ['SYNTHETIC_VALUE'], () => {
        // Output is not the subject here.
      }),
    ).rejects.toThrow('synthetic chmod EIO');
    // Positive control: the directory really was created and restricted.
    expect(injected).toBe(true);
    expect(created).toHaveLength(1);
    expect(created.filter((directory) => fs.existsSync(directory))).toEqual([]);
  });
});

describe('private storage that cannot drop its name', () => {
  // A record file is unlinked before its first write, so no ending leaves it
  // on disk. Setup must fail - not fall back to a named file - when that
  // cannot be guaranteed, and must never write through an entry it did not
  // create.
  const fs: typeof NodeFs = jest.requireActual('node:fs');
  let owned = '';
  beforeEach(async () => {
    owned = await mkdtemp(join(tmpdir(), 'canopy-scratch-test-'));
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(owned, { recursive: true, force: true });
  });

  it('refuses a symlink already at the file path instead of following it', async () => {
    const target = join(owned, 'target');
    await writeFile(target, 'untouched');
    const planted = join(owned, 'planted');
    await mkdir(planted, { mode: 0o700 });
    await symlink(target, join(planted, 'record'));
    jest.spyOn(fsPromises, 'mkdtemp').mockResolvedValue(planted);
    await expect(
      createFileRecordStore('probe', ['raw text']),
    ).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect(await readFile(target, 'utf8')).toBe('untouched');
  });

  it('fails setup and leaves nothing when the file cannot be unlinked', async () => {
    const created: string[] = [];
    const realMkdtemp = fsPromises.mkdtemp.bind(fsPromises);
    jest.spyOn(fsPromises, 'mkdtemp').mockImplementation(async (...args) => {
      const directory = await realMkdtemp(...args);
      created.push(directory);
      return directory;
    });
    jest
      .spyOn(fsPromises, 'unlink')
      .mockRejectedValue(
        Object.assign(new Error('synthetic unlink EPERM'), { code: 'EPERM' }),
      );
    await expect(createFileRecordStore('probe', ['raw text'])).rejects.toThrow(
      'synthetic unlink EPERM',
    );
    expect(created).toHaveLength(1);
    expect(created.filter((directory) => fs.existsSync(directory))).toEqual([]);
  });

  it('fails the synchronous frame spill the same way', async () => {
    const created: string[] = [];
    const realMkdtempSync = fs.mkdtempSync;
    jest.spyOn(fs, 'mkdtempSync').mockImplementation((...args) => {
      const directory = realMkdtempSync(...args);
      created.push(String(directory));
      return directory;
    });
    jest.spyOn(fs, 'unlinkSync').mockImplementation(() => {
      throw Object.assign(new Error('synthetic unlinkSync EPERM'), {
        code: 'EPERM',
      });
    });
    await expect(
      redactRecordFromSource(
        {
          chunks: async function* (): AsyncIterable<string> {
            const record = `${'['.repeat(70_000)}0${']'.repeat(70_000)}`;
            for (let at = 0; at < record.length; at += 65_536)
              yield await Promise.resolve(record.slice(at, at + 65_536));
          },
        },
        ['SYNTHETIC_VALUE'],
        () => undefined,
      ),
    ).rejects.toThrow('synthetic unlinkSync EPERM');
    const frames = created.filter((directory) =>
      directory.includes('canopy-frames-'),
    );
    expect(frames).toHaveLength(1);
    expect(frames.filter((directory) => fs.existsSync(directory))).toEqual([]);
  });
});

describe('a stored record with a longer value containing a shorter one', () => {
  // Whole-record masking masks a configured URL as one span even when its
  // password is configured too. The stored path must give the same record the
  // same result: committing the password first released the URL's head and
  // tail in both a string value and a property name.
  const URL = 'postgres://admin:S3cretPass@db.internal:5432/app';

  const redactThroughHost = async (
    line: string,
    values: string[],
  ): Promise<{ output: string; stored: boolean }> => {
    // Default storage threshold: a 9 MiB record really is stored.
    const redactor = new SecretValueRedactor(values);
    let output = '';
    let stored = false;
    const settle = async (): Promise<void> => {
      stored ||= redactor.hasStoredWork;
      const drain = redactor.takePendingDrain();
      if (drain) await drain;
      stored ||= redactor.hasStoredWork;
      const completion = redactor.takePendingCompletion();
      if (completion)
        await completion((text) => {
          output += text;
        });
    };
    try {
      for (let at = 0; at < line.length; at += 65_536) {
        output += redactor.redactChunk(line.slice(at, at + 65_536));
        await settle();
      }
      output += redactor.flush();
      await settle();
    } finally {
      await redactor.disposeStorage();
    }
    return { output, stored };
  };

  it.each([
    ['both values', [URL, 'S3cretPass']],
    ['the URL alone', [URL]],
  ])(
    'masks it as the resident path does, with %s configured',
    async (_name, values) => {
      const record = JSON.stringify({
        note: `DB is ${URL} ok`,
        [URL]: 17,
        filler: 'x'.repeat(9 * 1024 * 1024),
      });
      const { output, stored } = await redactThroughHost(`${record}\n`, values);
      expect(stored).toBe(true);
      const parsed: unknown = JSON.parse(output);
      const anyString: unknown = expect.any(String);
      expect(parsed).toEqual({
        note: 'DB is *** ok',
        '***': 17,
        filler: anyString,
      });
      // Byte for byte what the resident path writes for the same record,
      // compared as a flag so a failure does not print 9 MiB.
      const identical =
        output === `${redactSerializedJsonLine(record, values)}\n`;
      expect(identical).toBe(true);
      expect(
        typeof parsed === 'object' && parsed !== null && 'filler' in parsed
          ? String(parsed.filler).length
          : 0,
      ).toBe(9 * 1024 * 1024);
    },
    60_000,
  );
});

describe('output of a stored record reaches the host in bounded pieces', () => {
  // The stored path released masked text one character at a time, and each
  // piece became its own host output call: a 9 MiB record made about nine
  // million. Output is now coalesced into bounded pieces, in order, byte for
  // byte what the resident path writes.
  const SECRET = 'SYNTHETIC-SECRET-918273';
  let directory = '';
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'canopy-coalesce-'));
  });
  afterEach(async () => {
    await settleLateStorageCleanups();
    await rm(directory, { recursive: true, force: true });
  });
  const hosts = [
    ['utility host', runSpawnedProcessLocally],
    ['inline host', runSpawnedProcessInline],
  ] as const;

  it.each(hosts)(
    '%s',
    async (_name, host) => {
      const record = `${JSON.stringify({
        before: 'ordinary \u00e9\u{1F642}',
        [`key-${SECRET}`]: 12345,
        filler: 'h'.repeat(9 * 1024 * 1024),
        tail: `${SECRET} tail \u{1F642}`,
      })}\n`;
      const input = join(directory, 'record.json');
      await writeFile(input, record);
      let calls = 0;
      const live: string[] = [];
      const logFile = join(directory, 'step.log');
      const result = await host(
        {
          command: process.execPath,
          args: [
            '-e',
            // Odd-sized reads, so a multibyte character is split across writes.
            `const fs=require('node:fs');const b=fs.readFileSync(${JSON.stringify(input)});let i=0;const w=()=>{while(i<b.length){const c=b.subarray(i,i+65531);i+=c.length;if(!process.stdout.write(c)){process.stdout.once('drain',w);return;}}};w();`,
          ],
        },
        {
          cwd: directory,
          env: definedEnvironment(process.env),
          signal: new AbortController().signal,
          timeout_minutes: 2,
          logFile,
          outputFile: join(directory, 'step.out'),
          envFile: join(directory, 'step.env'),
          secretValues: [SECRET],
          onOutput: (_stream, data) => {
            calls += 1;
            live.push(data);
          },
        },
      );
      expect(result.status).toBe('success');
      const expected = `${redactSerializedJsonLine(record.slice(0, -1), [SECRET])}\n`;
      const saved = await readFile(logFile, 'utf8');
      const identical = saved === expected && live.join('') === expected;
      expect(identical).toBe(true);
      expect(saved.includes(SECRET)).toBe(false);
      // Bounded by the record's 64 KiB pieces, not its characters.
      expect(calls).toBeLessThanOrEqual(
        2 * Math.ceil(record.length / 65_536) + 16,
      );
    },
    120_000,
  );
});

describe('a stored record held back behind a long configured value', () => {
  // The stored path masks string content through a streaming matcher that
  // holds back one character less than the longest value. Searching that held
  // window for every value on every character made a PEM-sized value cost
  // thousands of character comparisons per record character. Both hosts, the
  // default threshold, and the resident path as the oracle.
  const PEM = [
    '-----BEGIN PRIVATE KEY-----',
    ...Array.from(
      { length: 40 },
      (_, line) =>
        `MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC${String(line).padStart(13, '0')}`,
    ),
    '-----END PRIVATE KEY-----',
  ].join('\n');
  const SHORT = 'SYNTHETIC-SHORT-551177';
  let directory = '';
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'canopy-held-back-'));
  });
  afterEach(async () => {
    await settleLateStorageCleanups();
    await rm(directory, { recursive: true, force: true });
  });
  const hosts = [
    ['utility host', runSpawnedProcessLocally],
    ['inline host', runSpawnedProcessInline],
  ] as const;

  it.each(hosts)(
    '%s does linear work and writes what the resident path writes',
    async (_name, host) => {
      const prose = 'lorem ipsum dolor sit amet, consectetur adipiscing elit. ';
      const record = `${JSON.stringify({
        note: `${prose.repeat(100)}${PEM}${prose.repeat(100)}`,
        filler: prose.repeat(Math.ceil((9 * 1024 * 1024) / prose.length)),
        tail: `${SHORT} tail`,
      })}\n`;
      const input = join(directory, 'record.json');
      await writeFile(input, record);
      const live: string[] = [];
      const logFile = join(directory, 'step.log');
      // Counted without `jest.spyOn`, which records every call: tens of
      // millions of them exhaust the heap before the product does.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const original = String.prototype.indexOf;
      let scanned = 0;
      const steps = overlapMatcherWorkCounters.searchSteps;
      const counting = function (
        this: string,
        search: string,
        from?: number,
      ): number {
        const start = Math.max(0, from ?? 0);
        const at = original.call(this, search, from);
        scanned += (at === -1 ? this.length : at) - start;
        return at;
      };
      Object.defineProperty(String.prototype, 'indexOf', {
        value: counting,
        configurable: true,
        writable: true,
      });
      let result: Awaited<ReturnType<typeof host>>;
      try {
        result = await host(
          {
            command: process.execPath,
            args: [
              '-e',
              `require('node:fs').createReadStream(${JSON.stringify(input)}).pipe(process.stdout)`,
            ],
          },
          {
            cwd: directory,
            env: definedEnvironment(process.env),
            signal: new AbortController().signal,
            timeout_minutes: 4,
            logFile,
            outputFile: join(directory, 'step.out'),
            envFile: join(directory, 'step.env'),
            secretValues: [PEM, SHORT],
            onOutput: (_stream, data) => {
              live.push(data);
            },
          },
        );
      } finally {
        Object.defineProperty(String.prototype, 'indexOf', {
          value: original,
          configurable: true,
          writable: true,
        });
      }
      expect(result.status).toBe('success');
      const expected = `${redactSerializedJsonLine(record.slice(0, -1), [PEM, SHORT])}\n`;
      const saved = await readFile(logFile, 'utf8');
      // Positive control: the oracle really masked both values.
      expect(expected.includes('BEGIN PRIVATE KEY')).toBe(false);
      expect(expected.includes(SHORT)).toBe(false);
      const identical = saved === expected && live.join('') === expected;
      expect(identical).toBe(true);
      expect(scanned).toBeLessThanOrEqual(4 * record.length);
      expect(
        overlapMatcherWorkCounters.searchSteps - steps,
      ).toBeLessThanOrEqual(32 * record.length);
    },
    300_000,
  );
});

describe('the record store itself', () => {
  it('settles a pending drain when it is disposed', async () => {
    // The host awaits these drains before it finalizes. A wait that can never
    // settle therefore hangs the step past its own timeout — which is what
    // happened when the only resolver was 'drain': a stream that is ending
    // never emits it again. Under parallel load this hung a 300-second test.
    const store = new SpillingRecordStore(1, 'drain-regression');
    store.append('seed');
    await store.whenDrained();
    expect(store.spilled).toBe(true);
    // Saturate the write queue so a real wait is outstanding.
    let saturated = false;
    for (let attempt = 0; attempt < 64 && !saturated; attempt += 1)
      saturated = !store.append('y'.repeat(1 << 20));
    expect(saturated).toBe(true);
    const waiting = store.whenDrained().then(
      () => 'settled',
      () => 'settled',
    );
    await store.dispose();
    const outcome = await Promise.race([
      waiting,
      new Promise((resolve) => setTimeout(() => resolve('hung'), 10_000)),
    ]);
    expect(outcome).toBe('settled');
  }, 60_000);
});

describe('record storage through the real hosts', () => {
  let directory = '';
  let staged = '';

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'canopy-host-storage-'));
    staged = join(directory, 'record.txt');
    await writeFile(staged, record(), 'utf8');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const utilityHost = async (
    name: string,
    source: string,
    options: HostOptions,
  ): Promise<HostRun> => {
    const logFile = join(directory, `${name}.log`);
    const live: string[] = [];
    const perStream: Record<string, string[]> = { stdout: [], stderr: [] };
    const result = await runSpawnedProcessLocally(
      { command: process.execPath, args: ['-e', source] },
      {
        cwd: directory,
        env: definedEnvironment(process.env),
        signal: new AbortController().signal,
        timeout_minutes: 4,
        logFile,
        outputFile: join(directory, `${name}.out`),
        envFile: join(directory, `${name}.env`),
        secretValues: ['SECRETVALUE'],
        onOutput: (stream, data) => {
          live.push(data);
          perStream[stream]?.push(data);
        },
        ...options,
      },
    );
    return {
      status: result.status,
      error: result.error,
      log: await readFile(logFile, 'utf8').catch(() => ''),
      logBytes: await readFile(logFile).catch(() => Buffer.alloc(0)),
      live: live.join(''),
      stdout: (perStream.stdout ?? []).join(''),
      stderr: (perStream.stderr ?? []).join(''),
    };
  };

  const inlineHost = async (
    name: string,
    source: string,
    options: HostOptions,
  ): Promise<HostRun> => {
    const logFile = join(directory, `${name}.log`);
    const live: string[] = [];
    const perStream: Record<string, string[]> = { stdout: [], stderr: [] };
    const result = await runSpawnedProcessInline(
      { command: process.execPath, args: ['-e', source] },
      {
        cwd: directory,
        env: definedEnvironment(process.env),
        signal: new AbortController().signal,
        timeout_minutes: 4,
        logFile,
        outputFile: join(directory, `${name}.out`),
        envFile: join(directory, `${name}.env`),
        secretValues: ['SECRETVALUE'],
        onOutput: (stream, data) => {
          live.push(data);
          perStream[stream]?.push(data);
        },
        ...options,
      },
    );
    return {
      status: result.status,
      error: result.error,
      log: await readFile(logFile, 'utf8').catch(() => ''),
      logBytes: await readFile(logFile).catch(() => Buffer.alloc(0)),
      live: live.join(''),
      stdout: (perStream.stdout ?? []).join(''),
      stderr: (perStream.stderr ?? []).join(''),
    };
  };

  const hosts = [
    ['utility host', utilityHost],
    ['inline host', inlineHost],
  ] as const;

  describe.each(hosts)('%s', (hostName, run) => {
    it.each(['stdout', 'stderr'] as const)(
      'delivers a spilled record that never gets a newline on %s',
      async (stream) => {
        // A child whose last write has no line break is ordinary: a step that
        // ends with `process.stdout.write(JSON.stringify(result))`, or one
        // killed mid-write. Reading lines does not entitle a line reader to
        // discard what it is holding at EOF — it has to emit it.
        const unterminated = join(directory, 'unterminated.txt');
        const text = record().replace(/\n$/, '');
        await writeFile(unterminated, text, 'utf8');
        const observed = observing();
        const result = await run(
          `${hostName}-eof-${stream}`,
          writer(stream, unterminated),
          { spillAfterChars: 1_024, createRecordStore: observed.factory },
        );
        expect(result.status).toBe('success');
        // Positive control: the record really did go to storage, so this is
        // the stored EOF path and not the resident one.
        expect(observed.spilled()).toBe(true);
        expect(result.log).toBe(expected().replace(/\n$/, ''));
        expect(result.live).toBe(result.log);
      },
      300_000,
    );

    it('keeps a multi-line configured value masked across a spilled line boundary', async () => {
      // The resident path holds a JSON line whose tail could begin a
      // multi-line configured value until enough following text exists to
      // decide. The stored path has to make the SAME decision with the SAME
      // context, or the backing changes what is emitted — which is exactly
      // what `record-store.ts` promises it cannot do.
      const secret = 'END"}\nTAIL12';
      const body = `{"f":"${'z'.repeat(RECORD_FILLER)}","t":"END"}`;
      const staged2 = join(directory, 'multiline.txt');
      // The continuation arrives in a LATER write than the terminator, which
      // is the whole point: the decision cannot be made when the line ends.
      await writeFile(staged2, `${body}\nTAIL12 trailing\n`, 'utf8');
      const observed = observing();
      const result = await run(
        `${hostName}-multiline`,
        writer('stdout', staged2),
        {
          spillAfterChars: 1_024,
          createRecordStore: observed.factory,
          secretValues: [secret],
        },
      );
      expect(result.status).toBe('success');
      expect(observed.spilled()).toBe(true);
      // The configured value must not survive in either copy.
      expect(result.log).not.toContain(secret);
      expect(result.live).not.toContain(secret);
      // And the surrounding bytes are untouched.
      expect(result.log).toBe(
        `{"f":"${'z'.repeat(RECORD_FILLER)}","t":"*** trailing\n`,
      );
      expect(result.live).toBe(result.log);
    }, 300_000);

    it('keeps a value that starts at a spilled line’s closing syntax masked', async () => {
      // The other direction: the value begins inside the record's own closing
      // JSON syntax and continues past the terminator.
      const secret = '"}\nMYSECRETTAIL';
      const body = `{"f":"${'z'.repeat(RECORD_FILLER)}","t":"x"}`;
      const staged2 = join(directory, 'multiline2.txt');
      await writeFile(staged2, `${body}\nMYSECRETTAIL after\n`, 'utf8');
      const observed = observing();
      const result = await run(
        `${hostName}-multiline2`,
        writer('stdout', staged2),
        {
          spillAfterChars: 1_024,
          createRecordStore: observed.factory,
          secretValues: [secret],
        },
      );
      expect(result.status).toBe('success');
      expect(observed.spilled()).toBe(true);
      expect(result.log).not.toContain('MYSECRETTAIL');
      expect(result.live).not.toContain('MYSECRETTAIL');
      expect(result.log).toBe(
        `{"f":"${'z'.repeat(RECORD_FILLER)}","t":"x*** after\n`,
      );
      expect(result.live).toBe(result.log);
    }, 300_000);

    it.each([
      ['stdout', 0, true],
      ['stdout', 14, true],
      ['stdout', 40, true],
      ['stderr', 40, true],
      ['stdout', 40, false],
      ['stderr', 14, false],
    ] as const)(
      'keeps a spilled JSON record with a whitespace head structural (%s, %i spaces, newline=%s)',
      async (stream, spaces, newline) => {
        // The stored route used to classify only a short retained HEAD. A
        // record whose head was all whitespace read as "undecided" and went to
        // the raw byte matcher, which then found the configured `nABCDEFGHIJKL`
        // inside the serialized `\nABCDEFGHIJKL` escape — text that is not
        // in the data at all — and produced invalid JSON with success.
        const record =
          `${'\t \r'.repeat(Math.floor(spaces / 3))}${' '.repeat(spaces % 3)}` +
          JSON.stringify({
            pad: 'z'.repeat(RECORD_FILLER),
            a: '\nABCDEFGHIJKL',
            b: 'plain',
          }) +
          (newline ? '\n' : '');
        const staged2 = join(directory, `ws-${spaces}-${String(newline)}.txt`);
        await writeFile(staged2, record, 'utf8');
        const observed = observing();
        const result = await run(
          `${hostName}-ws-${stream}-${spaces}-${String(newline)}`,
          writer(stream, staged2),
          {
            spillAfterChars: 1_024,
            createRecordStore: observed.factory,
            secretValues: ['nABCDEFGHIJKL'],
          },
        );
        expect(result.status).toBe('success');
        expect(observed.spilled()).toBe(true);
        // Nothing configured is in the data, so the record comes back EXACTLY.
        expect(result.log.length).toBe(record.length);
        expect(result.log).toBe(record);
        expect(result.live).toBe(result.log);
      },
      300_000,
    );

    it('saves an astral character whole when it spans a write boundary', async () => {
      // The child sends BYTE slices, so the host's decoder always sees valid
      // Unicode: any split surrogate is this code's own doing. Each write is
      // encoded to UTF-8 independently, so a high surrogate ending one write
      // and its low surrogate starting the next each become U+FFFD — the
      // saved file is corrupt while concatenating the live fragments looks
      // perfect. Asserting BYTES is what catches that.
      const value = `\u{1F600}SECRETVALUE\u{1F600}`;
      const text = `${JSON.stringify({ filler: 'z'.repeat(RECORD_FILLER), v: value })}\n`;
      const staged2 = join(directory, 'astral.txt');
      await writeFile(staged2, text, 'utf8');
      const observed = observing();
      const result = await run(
        `${hostName}-astral`,
        byteWriter('stdout', staged2),
        { spillAfterChars: 1_024, createRecordStore: observed.factory },
      );
      expect(result.status).toBe('success');
      expect(observed.spilled()).toBe(true);
      const want = text.replace('SECRETVALUE', '***');
      expect(result.logBytes.equals(Buffer.from(want, 'utf8'))).toBe(true);
      expect(result.live).toBe(want);
    }, 300_000);

    it.each(['stdout', 'stderr'] as const)(
      'masks a spilled record byte for byte on %s',
      async (stream) => {
        const observed = observing();
        const result = await run(
          `${hostName}-${stream}`,
          writer(stream, staged),
          {
            spillAfterChars: 1_024,
            createRecordStore: observed.factory,
          },
        );
        expect(result.status).toBe('success');
        expect(result.log).toBe(expected());
        // Live output is the same bytes as the durable copy.
        expect(result.live).toBe(result.log);
        // Positive control: the record really did go through storage, and
        // really did reach a file rather than staying in the memory backing.
        expect(observed.created).toBeGreaterThan(0);
        expect(observed.spilled()).toBe(true);
      },
      300_000,
    );

    it('gives stdout and stderr independent stores', async () => {
      const observed = observing();
      const source = `${writer('stdout', staged)};${writer('stderr', staged)}`;
      const result = await run(`${hostName}-both`, source, {
        spillAfterChars: 1_024,
        createRecordStore: observed.factory,
      });
      expect(result.status).toBe('success');
      // Asserted PER STREAM, not on the shared log: both pipes write to one
      // log file, so two large records interleave there. Each stream's own
      // output is what has to be whole.
      expect(result.stdout).toBe(expected());
      expect(result.stderr).toBe(expected());
      // One store per pipe, not one shared between them.
      expect(observed.created).toBe(2);
      expect(observed.spilled()).toBe(true);
    }, 300_000);

    it.each(['create', 'write', 'read', 'flush'] as const)(
      'fails the step cleanly on an injected %s failure',
      async (boundary) => {
        const injected = failingAt(boundary, 2_048);
        const result = await run(
          `${hostName}-${boundary}`,
          writer('stdout', staged),
          {
            spillAfterChars: 1_024,
            createRecordStore: injected.factory,
          },
        );
        // The step fails. It never degrades to unprocessed output, so the
        // configured value must not appear anywhere it reached.
        // The store was actually built, so this is a failure of the storage
        // path rather than a record that quietly never used it.
        expect(injected.built()).toBeGreaterThan(0);
        expect(result.status).toBe('failure');
        expect(result.log).not.toContain('SECRETVALUE');
        expect(result.live).not.toContain('SECRETVALUE');
        expect(result.error ?? '').toContain('injected');
      },
      300_000,
    );

    it('keeps an unrelated concurrent step and the host healthy when one step’s storage fails', async () => {
      const injected = failingAt('write', 2_048);
      const healthy = observing();
      const [broken, fine] = await Promise.all([
        run(`${hostName}-broken`, writer('stdout', staged), {
          spillAfterChars: 1_024,
          createRecordStore: injected.factory,
        }),
        run(`${hostName}-fine`, writer('stdout', staged), {
          spillAfterChars: 1_024,
          createRecordStore: healthy.factory,
        }),
      ]);
      expect(injected.built()).toBeGreaterThan(0);
      expect(broken.status).toBe('failure');
      expect(fine.status).toBe('success');
      expect(fine.log).toBe(expected());
      expect(healthy.spilled()).toBe(true);
      // The host itself is still usable afterwards.
      const after = await run(`${hostName}-after`, writer('stdout', staged), {
        spillAfterChars: 1_024,
        createRecordStore: observing().factory,
      });
      expect(after.status).toBe('success');
      expect(after.log).toBe(expected());
    }, 300_000);

    it('leaves no private storage behind on success or on failure', async () => {
      const tracked = tracking();
      const good = observing();
      await run(`${hostName}-clean-ok`, writer('stdout', staged), {
        spillAfterChars: 1_024,
        createRecordStore: (after, label) =>
          tracked.wrap(good.factory(after, label)),
      });
      const injected = failingAt('write', 2_048);
      await run(`${hostName}-clean-fail`, writer('stdout', staged), {
        spillAfterChars: 1_024,
        createRecordStore: (after, label) =>
          tracked.wrap(injected.factory(after, label)),
      });
      // Positive control: directories were created, so "none survive" is not
      // vacuously true.
      expect(good.spilled()).toBe(true);
      expect(await tracked.survivors()).toEqual([]);
      // And the failing store was disposed rather than abandoned.
      expect(injected.disposals()).toBeGreaterThan(0);
    }, 300_000);

    it('keeps the record private and out of reach by name while it is stored', async () => {
      // Created in a `0o700` directory as an exclusive `0o600` file, then
      // unlinked before its first write: a live store's record is reachable
      // only through its own descriptor, so nothing - a crash included - can
      // leave it on disk.
      const created: Array<{ flags: unknown; mode: unknown }> = [];
      const restricted: unknown[] = [];
      const realOpen = fsPromises.open.bind(fsPromises);
      const realChmod = fsPromises.chmod.bind(fsPromises);
      jest
        .spyOn(fsPromises, 'open')
        .mockImplementation(async (path, flags, mode) => {
          if (String(path).includes('canopy-record-'))
            created.push({ flags, mode });
          return realOpen(path, flags, mode);
        });
      jest.spyOn(fsPromises, 'chmod').mockImplementation(async (path, mode) => {
        if (String(path).includes('canopy-record-')) restricted.push(mode);
        return realChmod(path, mode);
      });
      const tracked = tracking();
      const observed = observing();
      try {
        await run(`${hostName}-modes`, writer('stdout', staged), {
          spillAfterChars: 1_024,
          createRecordStore: (after, label) =>
            tracked.wrap(observed.factory(after, label)),
        });
      } finally {
        jest.restoreAllMocks();
      }
      // Positive controls: the record spilled, and was sampled while live.
      expect(observed.spilled()).toBe(true);
      expect(tracked.samples()).toBeGreaterThan(0);
      expect(created.length).toBeGreaterThan(0);
      expect(
        created.every(({ flags, mode }) => flags === 'wx+' && mode === 0o600),
      ).toBe(true);
      expect(restricted.length).toBe(created.length);
      expect(restricted.every((mode) => mode === 0o700)).toBe(true);
      expect(tracked.modes()).toEqual({});
    }, 300_000);

    it.each(['timeout', 'abnormal exit'] as const)(
      'disposes storage on %s',
      async (ending) => {
        const tracked = tracking();
        const observed = observing();
        // Both children hold a record open: one runs past its budget, the
        // other kills itself mid-record.
        const source =
          `(function(){const s=require('node:fs').readFileSync(${JSON.stringify(staged)},'utf8').replace(/\\n$/,'');` +
          'let i=0;const w=process.stdout;function send(){' +
          'const c=s.slice(i%s.length,(i%s.length)+4096);i+=4096;' +
          (ending === 'abnormal exit'
            ? 'if(i>20000){process.kill(process.pid,9);return;}'
            : '') +
          "if(w.write(c))setTimeout(send,1);else w.once('drain',send);}send();})();";
        const logFile = join(directory, `${hostName}-${ending}.log`);
        const options = {
          cwd: directory,
          env: definedEnvironment(process.env),
          signal: new AbortController().signal,
          // 0.05 minutes = 3 seconds, enough to open storage and expire.
          timeout_minutes: ending === 'timeout' ? 0.05 : 1,
          logFile,
          outputFile: join(directory, `${hostName}-${ending}.out`),
          envFile: join(directory, `${hostName}-${ending}.env`),
          secretValues: ['SECRETVALUE'],
          spillAfterChars: 1_024,
          createRecordStore: (after: number, label: string): RecordStore =>
            tracked.wrap(observed.factory(after, label)),
        };
        const result =
          run === utilityHost
            ? await runSpawnedProcessLocally(
                { command: process.execPath, args: ['-e', source] },
                options,
              )
            : await runSpawnedProcessInline(
                { command: process.execPath, args: ['-e', source] },
                options,
              );
        expect(result.status).not.toBe('success');
        expect(observed.spilled()).toBe(true);
        // A stopped step settles first and cleans up after; the cleanup is still
        // owned and still completes, which is what is asserted here.
        await settleLateStorageCleanups();
        expect(await tracked.survivors()).toEqual([]);
      },
      300_000,
    );

    it('disposes storage when the step is cancelled mid-record', async () => {
      const tracked = tracking();
      const observed = observing();
      const createRecordStore: RecordStoreFactory = (after, label) =>
        tracked.wrap(observed.factory(after, label));
      const controller = new AbortController();
      const logFile = join(directory, `${hostName}-cancel.log`);
      // A child that never finishes its record, so storage is open when the
      // cancellation lands.
      const source =
        `const s=require('node:fs').readFileSync(${JSON.stringify(staged)},'utf8').replace(/\\n$/,'');` +
        `let i=0;const w=process.stdout;function send(){` +
        `const c=s.slice(i%s.length,(i%s.length)+4096);i+=4096;` +
        `if(w.write(c))setTimeout(send,1);else w.once('drain',send);}send();`;
      const running =
        run === utilityHost
          ? runSpawnedProcessLocally(
              { command: process.execPath, args: ['-e', source] },
              {
                cwd: directory,
                env: definedEnvironment(process.env),
                signal: controller.signal,
                timeout_minutes: 1,
                logFile,
                outputFile: join(directory, `${hostName}-cancel.out`),
                envFile: join(directory, `${hostName}-cancel.env`),
                secretValues: ['SECRETVALUE'],
                spillAfterChars: 1_024,
                createRecordStore,
              },
            )
          : runSpawnedProcessInline(
              { command: process.execPath, args: ['-e', source] },
              {
                cwd: directory,
                env: definedEnvironment(process.env),
                signal: controller.signal,
                timeout_minutes: 1,
                logFile,
                outputFile: join(directory, `${hostName}-cancel.out`),
                envFile: join(directory, `${hostName}-cancel.env`),
                secretValues: ['SECRETVALUE'],
                spillAfterChars: 1_024,
                createRecordStore,
              },
            );
      await new Promise((resolve) => setTimeout(resolve, 500));
      controller.abort();
      const result = await running;
      expect(result.status).toBe('cancelled');
      // Storage was open when the cancellation landed, and is gone after it.
      expect(observed.spilled()).toBe(true);
      // A stopped step settles first and cleans up after; the cleanup is still
      // owned and still completes, which is what is asserted here.
      await settleLateStorageCleanups();
      expect(await tracked.survivors()).toEqual([]);
    }, 300_000);
  });
});

describe('private storage whose owner is killed', () => {
  // A step host that is killed outright (SIGKILL, a crash, power loss) never
  // runs disposal. Whatever raw, pre-masking text its stores had written must
  // not outlive it on disk. Each child here runs under a temporary root this
  // test owns exclusively, reaches one raw backing at its real creation point
  // and default threshold, reports every directory it created, and is killed.
  const child = join(__dirname, 'spill-owner-child.ts');
  const repoRoot = join(__dirname, '../../../../../../..');
  const canary = 'synthetic-spill-canary-NOT-A-CREDENTIAL-7731';
  let root = '';
  const running = new Set<ChildProcess>();

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'canopy-spill-owner-test-'));
  });
  afterEach(async () => {
    for (const process of Array.from(running)) process.kill('SIGKILL');
    await Promise.all(
      Array.from(running).map(
        (process) =>
          new Promise<void>((resolve) => {
            if (process.exitCode !== null || process.signalCode !== null)
              resolve();
            else process.once('exit', () => resolve());
          }),
      ),
    );
    running.clear();
    await rm(root, { recursive: true, force: true });
  });

  interface ChildReport {
    ready?: boolean;
    stored?: boolean;
    finished?: boolean;
    intact?: boolean;
    created: string[];
  }

  const start = (
    mode: string,
  ): {
    process: ChildProcess;
    next: () => Promise<ChildReport>;
    exited: Promise<void>;
  } => {
    const spawned = spawn(
      process.execPath,
      ['--import', 'tsx', child, mode, canary],
      {
        cwd: repoRoot,
        env: { ...definedEnvironment(process.env), TMPDIR: root },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    running.add(spawned);
    const exited = new Promise<void>((resolve) => {
      spawned.once('exit', () => {
        running.delete(spawned);
        resolve();
      });
    });
    let stderr = '';
    spawned.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });
    const lines: string[] = [];
    const waiting: Array<(line: string) => void> = [];
    let partial = '';
    spawned.stdout?.on('data', (data: Buffer) => {
      partial += data.toString();
      let at = partial.indexOf('\n');
      while (at >= 0) {
        const line = partial.slice(0, at);
        partial = partial.slice(at + 1);
        const taker = waiting.shift();
        if (taker) taker(line);
        else lines.push(line);
        at = partial.indexOf('\n');
      }
    });
    const next = (): Promise<ChildReport> =>
      new Promise<string>((resolve, reject) => {
        const queued = lines.shift();
        if (queued !== undefined) {
          resolve(queued);
          return;
        }
        waiting.push(resolve);
        void exited.then(() => {
          reject(new Error(`child ${mode} exited early: ${stderr}`));
        });
      }).then((line): ChildReport => {
        const parsed: unknown = JSON.parse(line);
        if (
          typeof parsed !== 'object' ||
          parsed === null ||
          !('created' in parsed) ||
          !Array.isArray(parsed.created)
        )
          throw new Error(`unexpected child report: ${line}`);
        const report: ChildReport = {
          created: parsed.created.map((entry: unknown) => String(entry)),
        };
        for (const flag of ['ready', 'stored', 'finished', 'intact'] as const)
          if (flag in parsed) {
            const value: unknown = Reflect.get(parsed, flag);
            if (typeof value === 'boolean') report[flag] = value;
          }
        return report;
      });
    return { process: spawned, next, exited };
  };

  /** Every file under the root, with whether it holds the canary. */
  const residue = async (): Promise<
    Array<{ path: string; bytes: number; canary: boolean }>
  > => {
    const found: Array<{ path: string; bytes: number; canary: boolean }> = [];
    const plain = Buffer.from(canary, 'utf8');
    const wide = Buffer.from(canary, 'utf16le');
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile()) {
          const bytes = await readFile(path);
          found.push({
            path,
            bytes: bytes.length,
            canary: bytes.includes(plain) || bytes.includes(wide),
          });
        }
      }
    };
    await walk(root);
    return found;
  };

  it.each(['record', 'identity', 'keyindex', 'frames'])(
    'leaves nothing of a killed %s store on disk',
    async (mode) => {
      const owner = start(mode);
      const ready = await owner.next();
      expect(ready.ready).toBe(true);
      // Positive control: the backing under test really was created, under
      // this test's root, before the kill.
      const prefix = {
        record: 'canopy-record-line-',
        identity: 'canopy-record-identity-',
        keyindex: 'canopy-keyindex-',
        frames: 'canopy-frames-',
      }[mode];
      expect(
        ready.created.some(
          (directory) =>
            directory.startsWith(root) &&
            prefix !== undefined &&
            directory.includes(prefix),
        ),
      ).toBe(true);
      if (mode === 'record') expect(ready.stored).toBe(true);
      owner.process.kill('SIGKILL');
      await owner.exited;
      expect((await residue()).filter((file) => file.canary)).toEqual([]);
      // Nothing with a name survives. The key index keeps one directory for
      // the slot files it creates as it grows, so a hard kill can leave that
      // directory - empty. Every other backing removes its directory as soon
      // as its file has no name.
      const survivors = ready.created.filter((directory) =>
        existsSync(directory),
      );
      if (mode === 'keyindex')
        for (const directory of survivors)
          expect(await readdir(directory)).toEqual([]);
      else expect(survivors).toEqual([]);
    },
    120_000,
  );

  it('leaves a live owner and files it did not create untouched', async () => {
    // Nothing here is identified by prefix, age or process id. A concurrent
    // owner keeps working after another process dies, and a directory that
    // merely looks like ours - with a stale owner file naming a process that
    // no longer exists, or a symlink to somewhere else - is never read,
    // followed or removed.
    const foreign = join(root, 'canopy-record-line-unknownowner');
    await mkdir(foreign, { mode: 0o700 });
    await writeFile(join(foreign, 'record'), `foreign ${canary}`);
    await writeFile(
      join(foreign, 'owner.json'),
      JSON.stringify({ pid: 999_999_999, startedAt: 0 }),
    );
    const elsewhere = await mkdtemp(join(tmpdir(), 'canopy-spill-target-'));
    try {
      await writeFile(join(elsewhere, 'kept'), 'target content');
      const link = join(root, 'canopy-record-line-symlinked');
      await symlink(elsewhere, link);
      const snapshot = async (): Promise<string[]> => [
        await readFile(join(foreign, 'record'), 'utf8'),
        await readFile(join(foreign, 'owner.json'), 'utf8'),
        await readlink(link),
        await readFile(join(elsewhere, 'kept'), 'utf8'),
      ];
      const before = await snapshot();

      const live = start('owner');
      const doomed = start('record');
      const [liveReady, doomedReady] = await Promise.all([
        live.next(),
        doomed.next(),
      ]);
      expect(liveReady.stored).toBe(true);
      expect(doomedReady.stored).toBe(true);
      doomed.process.kill('SIGKILL');
      await doomed.exited;

      live.process.stdin?.write('finish\n');
      const finished = await live.next();
      await live.exited;
      expect(finished).toMatchObject({ finished: true, intact: true });
      expect(await snapshot()).toEqual(before);
      // The only canary left anywhere is the one planted in the foreign file.
      expect(
        (await residue())
          .filter((file) => file.canary)
          .map((file) => file.path),
      ).toEqual([join(foreign, 'record')]);
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  }, 120_000);
});
