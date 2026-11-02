import type { CanopyDaemonClock } from '../../daemon/leases';
import {
  MIGRATION_HOST_FIELDS,
  MIGRATION_LAUNCHER_TRANSPORT,
  MIGRATION_SLOTS_AT_PIN,
  migrationSlotKey,
  type MigrationChannelFacts,
  type MigrationHostFacts,
  type MigrationImportPort,
  type MigrationImportRequest,
  type MigrationImportResult,
  type MigrationSlotDefinition,
  type MigrationSlotProgress,
  type MigrationSourceIdentity,
  type MigrationSourcePort,
} from '../migration-ports';
import { migrationResultFrame } from '../migration-protocol';
import {
  createMigrationSessionRegistry,
  type MigrationConsumeResult,
  type MigrationPresentation,
  type MigrationReleaseContext,
  type MigrationSessionOutcome,
  type MigrationSessionRegistry,
  type MigrationSessionRegistryOptions,
} from '../migration-sessions';

// T1–T12 follow the r16 F5 model; T13–T18 and B1–B9 follow the F5b round-2
// model, with B rows at the session-binding layer (admission is VA-2).

const HOST: MigrationHostFacts = Object.freeze({
  authorityId: 'authority-1',
  coreAuthority: 'core-A',
  coreIncarnation: 'core-inc-1',
  coreDigest: 'cdhash:daemon-1',
  buildId: 'build-1',
  packageDigest: 'sha256:package-1',
  updateEpoch: 'epoch-7',
});
const PROD: MigrationSourceIdentity = Object.freeze({
  flavorId: 'com.example.canopy',
  secureMode: 'prod',
});
const INTERNAL: MigrationSourceIdentity = Object.freeze({
  flavorId: 'com.example.canopy.dev',
  secureMode: 'internal',
});
const SETTLE_MS = 1_000;
const TTL_MS = 60_000;
const SLOT = 'github-pat';
const PROD_KEY = migrationSlotKey(PROD, SLOT);

type Initiate = (ctx: MigrationReleaseContext) => unknown;
type Outcome = MigrationSessionOutcome<unknown>;

const anyValue = (value: unknown): value is unknown => value !== Symbol.for('');
const idle = (): Promise<void> => Promise.resolve();
const hang = (): Promise<never> => new Promise<never>(() => undefined);
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
/** An importer resolving with `value`, which its declared type can't express. */
const resolvesWith =
  (value: unknown): MigrationImportPort['createIfAbsent'] =>
  () =>
    new Promise<MigrationImportResult>((resolve) => {
      Reflect.apply(resolve, undefined, [value]);
    });
const text = (value: Uint8Array | undefined): string =>
  new TextDecoder().decode(value);
/** Releases, then returns `value` (a promise unless `sync`). */
const release =
  (value?: unknown, sync = false): Initiate =>
  (ctx): unknown => {
    ctx.mayRelease();
    return sync ? value : Promise.resolve(value);
  };

function manualClock(): CanopyDaemonClock & {
  advance(ms: number): void;
  breakTimers(): void;
} {
  let now = 1_000_000;
  let broken = false;
  const timers = new Set<{ at: number; run: () => void }>();
  return {
    breakTimers: (): void => {
      broken = true;
    },
    now: (): number => now,
    setTimer(run, delayMs): { cancel(): void } {
      if (broken) throw new Error('no timers');
      const timer = { at: now + delayMs, run };
      timers.add(timer);
      return { cancel: (): void => void timers.delete(timer) };
    },
    advance(ms): void {
      now += ms;
      for (const timer of Array.from(timers).sort((a, b) => a.at - b.at))
        if (timer.at <= now && timers.delete(timer)) timer.run();
    },
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
}

interface Ports {
  readonly fence?: MigrationSourcePort['fence'];
  readonly createIfAbsent?: MigrationImportPort['createIfAbsent'];
}

type ReentrantPort =
  | 'channel'
  | 'host'
  | 'currentGeneration'
  | 'slotProgress'
  | 'isFenced'
  | 'now';

interface Rig {
  readonly registry: MigrationSessionRegistry;
  readonly clock: ReturnType<typeof manualClock>;
  readonly channel: object;
  mint(overrides?: Partial<MigrationChannelFacts>): object;
  retire(channel: object): void;
  setHost(overrides: Partial<MigrationHostFacts>): void;
  /** Runs `act` once, inside the next read of `port` after `skip` others. */
  onRead(port: ReentrantPort, act: () => void, skip?: number): void;
  readonly generations: Map<string, string>;
  readonly fences: { key: string; generation: string }[];
  readonly progress: Map<string, MigrationSlotProgress>;
  readonly vault: Map<string, { value: Uint8Array; writer: string }>;
  readonly imports: MigrationImportRequest[];
}

function rig(
  options: Partial<MigrationSessionRegistryOptions> = {},
  ports: Ports = {},
): Rig {
  const clock = manualClock();
  let host: MigrationHostFacts = { ...HOST };
  let reentry: {
    readonly port: ReentrantPort;
    readonly act: () => void;
    skip: number;
  } | null = null;
  const reading = (port: ReentrantPort): void => {
    const pending = reentry;
    if (pending === null || pending.port !== port) return;
    if (pending.skip > 0) pending.skip -= 1;
    else {
      reentry = null;
      pending.act();
    }
  };
  const minted = new WeakMap<object, MigrationChannelFacts>();
  const generations = new Map<string, string>();
  const fences: Rig['fences'] = [];
  const progress = new Map<string, MigrationSlotProgress>();
  const vault: Rig['vault'] = new Map();
  const imports: MigrationImportRequest[] = [];
  const recordFence = (key: string, generation: string): void =>
    void fences.push({ key, generation });
  const createIfAbsent = (
    request: MigrationImportRequest,
  ): Promise<MigrationImportResult> => {
    imports.push(request);
    if (vault.has(request.slot)) return Promise.resolve({ kind: 'exists' });
    vault.set(request.slot, {
      value: Uint8Array.from(request.value),
      writer: migrationSlotKey(request.source, request.slot),
    });
    return Promise.resolve({ kind: 'created', receipt: `r-${request.slot}` });
  };
  const mint = (overrides: Partial<MigrationChannelFacts> = {}): object => {
    const handle = {};
    minted.set(handle, {
      transport: MIGRATION_LAUNCHER_TRANSPORT,
      channelId: 'chan-1',
      launcher: { pid: 4242, pidversion: 99 },
      launcherDigest: 'cdhash:launcher-1',
      source: PROD,
      admittedHost: { ...HOST },
      ...overrides,
    });
    return handle;
  };
  const registry = createMigrationSessionRegistry(
    {
      admission: {
        channel: (handle): MigrationChannelFacts | null => {
          reading('channel');
          return minted.get(handle) ?? null;
        },
        host: (): MigrationHostFacts => {
          reading('host');
          return host;
        },
      },
      source: {
        currentGeneration: (key): string => {
          reading('currentGeneration');
          return generations.get(key) ?? 'g1';
        },
        isFenced: (key, generation): boolean => {
          reading('isFenced');
          return fences.some(
            (f) => f.key === key && f.generation === generation,
          );
        },
        fence: ports.fence ?? recordFence,
        slotProgress: (slot): MigrationSlotProgress => {
          reading('slotProgress');
          return progress.get(slot) ?? { state: 'not_started' };
        },
      },
      importer: { createIfAbsent: ports.createIfAbsent ?? createIfAbsent },
      clock: {
        now: (): number => {
          reading('now');
          return clock.now();
        },
        setTimer: (run, delayMs): { cancel(): void } =>
          clock.setTimer(run, delayMs),
      },
    },
    { os: 'darwin', ttlMs: TTL_MS, settleMs: SETTLE_MS, ...options },
  );
  return {
    registry,
    clock,
    channel: mint(),
    mint,
    retire: (handle): void => void minted.delete(handle),
    setHost: (overrides): void => {
      host = { ...host, ...overrides };
    },
    onRead: (port, act, skip = 0): void => {
      reentry = { port, act, skip };
    },
    generations,
    fences,
    progress,
    vault,
    imports,
  };
}

interface Issued {
  readonly id: string;
  present(overrides?: Partial<MigrationPresentation>): MigrationPresentation;
}

function issued(r: Rig, slot = SLOT, channel = r.channel): Issued {
  const result = r.registry.issue(channel, slot);
  if (!result.issued) throw new Error(`issue refused: ${result.reason}`);
  const { offer } = result;
  return {
    id: offer.sessionId,
    present: (overrides = {}): MigrationPresentation => ({
      channel,
      challenge: offer.challenge,
      operation: offer.operation,
      purpose: offer.purpose,
      ...overrides,
    }),
  };
}

function outcomeOf<T>(
  result: MigrationConsumeResult<T>,
): Promise<MigrationSessionOutcome<T>> {
  if (!result.accepted) throw new Error(`consume refused: ${result.reason}`);
  return result.outcome;
}

function consume(
  r: Rig,
  s: Issued,
  initiate: Initiate,
  presentation = s.present(),
): MigrationConsumeResult<unknown> {
  return r.registry.consume(s.id, presentation, initiate, anyValue);
}

/** Starts a consume whose initiator captures its context. */
function captured(
  r: Rig,
  s: Issued,
  initiate: Initiate = hang,
): { ctx(): MigrationReleaseContext; outcome: Promise<Outcome> } {
  let context: MigrationReleaseContext | undefined;
  const outcome = outcomeOf(
    consume(r, s, (ctx) => {
      context = ctx;
      return initiate(ctx);
    }),
  );
  return {
    ctx: (): MigrationReleaseContext => {
      if (!context) throw new Error('not initiated');
      return context;
    },
    outcome,
  };
}

/** A promise settled by hand, for initiators that finish later. */
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let settle: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return {
    promise,
    resolve: (value): void => settle?.(value),
  };
}

const notInitiated = (reason: string): Outcome => ({
  state: 'revoked',
  reason: `not-initiated:${reason}`,
});

describe('migration session registry: F5 T1–T12', () => {
  it('T1 happy path settles exactly once', async () => {
    const r = rig();
    const s = issued(r);
    let calls = 0;
    const outcome = await outcomeOf(
      consume(r, s, (ctx) => {
        calls += 1;
        expect(ctx.mayRelease()).toBe(true);
        return Promise.resolve('receipt-1');
      }),
    );
    expect(outcome).toEqual({ state: 'completed', value: 'receipt-1' });
    expect(calls).toBe(1);
    expect(r.registry.get(s.id)).toMatchObject({
      state: 'completed',
      terminalTransitions: 1,
    });
  });

  it('T2 concurrent consume: one initiation, the second refused synchronously', async () => {
    const r = rig();
    const s = issued(r);
    let calls = 0;
    const initiate: Initiate = (ctx) => {
      calls += 1;
      return release()(ctx);
    };
    const first = consume(r, s, initiate);
    expect(consume(r, s, initiate)).toEqual({
      accepted: false,
      reason: 'not-issued:pending',
    });
    await outcomeOf(first);
    expect(calls).toBe(1);
  });

  it('T3 a reentrant consume from inside initiate is refused', async () => {
    const r = rig();
    const s = issued(r);
    let inner: MigrationConsumeResult<unknown> | undefined;
    await outcomeOf(
      consume(r, s, (ctx) => {
        inner = consume(r, s, idle);
        return release()(ctx);
      }),
    );
    expect(inner).toEqual({ accepted: false, reason: 'not-issued:pending' });
  });

  it('T4 expiry applies to issued sessions only', async () => {
    const r = rig();
    const s = issued(r);
    r.clock.advance(TTL_MS);
    expect(consume(r, s, idle)).toEqual({ accepted: false, reason: 'expired' });
    expect(r.registry.get(s.id)?.state).toBe('revoked');

    const r2 = rig({ ttlMs: 100, settleMs: 5_000 });
    const late = deferred<string>();
    const outcome = outcomeOf(
      consume(r2, issued(r2), (ctx) => {
        ctx.mayRelease();
        return late.promise;
      }),
    );
    r2.clock.advance(1_000);
    await flush();
    late.resolve('late');
    expect(await outcome).toEqual({ state: 'completed', value: 'late' });
  });

  type Substitute = (r: Rig, s: Issued) => MigrationPresentation;
  const row = (
    reason: string,
    substitute: Substitute,
  ): [string, Substitute] => [reason, substitute];
  const channelRow = (
    field: string,
    overrides: Partial<MigrationChannelFacts>,
  ): [string, Substitute] =>
    row(`binding:channel:${field}`, (r, s) =>
      s.present({ channel: r.mint(overrides) }),
    );
  const substitutions: [string, Substitute][] = [
    channelRow('channelId', { channelId: 'chan-2' }),
    channelRow('launcher.pid', { launcher: { pid: 4243, pidversion: 99 } }),
    channelRow('launcherDigest', { launcherDigest: 'other' }),
    channelRow('source', { source: INTERNAL }),
    channelRow('handle', {}),
    row('binding:challenge', (_r, s) =>
      s.present({ challenge: 'x'.repeat(43) }),
    ),
    row('binding:operation', (_r, s) => s.present({ operation: 'restore' })),
    row('binding:purpose', (_r, s) => s.present({ purpose: 'other' })),
    row('binding:sourceGeneration', (r, s) => {
      r.generations.set(PROD_KEY, 'g2');
      return s.present();
    }),
    ...MIGRATION_HOST_FIELDS.map((field) =>
      row(`binding:host:${field}`, (r, s) => {
        r.setHost({ [field]: 'changed' });
        return s.present();
      }),
    ),
  ];

  it.each(substitutions)(
    'T5 substitution refused, revoked and never initiated: %s',
    (reason, substitute) => {
      const r = rig();
      const s = issued(r);
      let called = false;
      const result = consume(
        r,
        s,
        () => {
          called = true;
          return idle();
        },
        substitute(r, s),
      );
      expect(result).toEqual({ accepted: false, reason });
      expect(called).toBe(false);
      expect(r.registry.get(s.id)?.state).toBe('revoked');
    },
  );

  it('T6 revoke between issue and consume', () => {
    const r = rig();
    const s = issued(r);
    expect(
      r.registry.revokeWhere((b) => b.channelId === 'chan-1', 'disconnect'),
    ).toBe(1);
    expect(consume(r, s, idle)).toEqual({
      accepted: false,
      reason: 'not-issued:revoked',
    });
  });

  it('T7 revoke during pending blocks an unreleased release and keeps a released one', async () => {
    const r = rig();
    const s = issued(r);
    const unreleased = captured(r, s);
    await flush();
    expect(r.registry.revoke(s.id, 'operator')).toBe(false);
    expect(unreleased.ctx().mayRelease()).toBe(false);

    const r2 = rig();
    const s2 = issued(r2);
    const done = deferred<string>();
    const kept = captured(r2, s2, (ctx) => {
      ctx.mayRelease();
      return done.promise;
    });
    await flush();
    r2.registry.revoke(s2.id, 'operator');
    done.resolve('kept');
    expect(await kept.outcome).toEqual({ state: 'completed', value: 'kept' });
    expect(r2.registry.get(s2.id)?.flagged).toBe('operator');
  });

  it('T8 a source generation change before release prevents release', async () => {
    const r = rig();
    const outcome = await outcomeOf(
      consume(r, issued(r), (ctx) => {
        r.generations.set(PROD_KEY, 'g2');
        expect(ctx.mayRelease()).toBe(false);
        return idle();
      }),
    );
    expect(outcome).toEqual(notInitiated('fulfilled-without-release'));
    expect(r.fences).toEqual([]);
  });

  it('T9 a lost reply after release is uncertain, fences, and blocks re-issue', async () => {
    const r = rig();
    const s = issued(r);
    const outcome = await outcomeOf(
      consume(r, s, (ctx) => {
        ctx.mayRelease();
        return Promise.reject(new Error('reply lost'));
      }),
    );
    expect(outcome).toEqual({ state: 'uncertain', reason: 'rejected' });
    expect(r.fences).toEqual([{ key: PROD_KEY, generation: 'g1' }]);
    expect(r.registry.issue(r.channel, SLOT)).toEqual({
      issued: false,
      reason: 'source-generation-fenced',
    });
    expect(consume(r, s, idle)).toEqual({
      accepted: false,
      reason: 'not-issued:uncertain',
    });
  });

  it('T9b the in-process fence holds when the durable fence write fails', async () => {
    const failing = (): void => {
      throw new Error('disk full');
    };
    const r = rig({}, { fence: failing });
    const s = issued(r);
    await outcomeOf(
      consume(r, s, (ctx) => {
        ctx.mayRelease();
        return Promise.reject(new Error('lost'));
      }),
    );
    expect(r.registry.get(s.id)?.history).toContain('fence-failed');
    expect(r.registry.issue(r.channel, SLOT)).toEqual({
      issued: false,
      reason: 'source-generation-fenced',
    });
  });

  it('T10 an update epoch change revokes; a reconnect cannot resurrect it', () => {
    const r = rig();
    const s = issued(r);
    r.registry.revokeWhere((b) => b.host.updateEpoch === 'epoch-7', 'update');
    r.setHost({ updateEpoch: 'epoch-8' });
    const reconnect = r.mint({
      channelId: 'chan-2',
      admittedHost: { ...HOST, updateEpoch: 'epoch-8' },
    });
    expect(consume(r, s, idle, s.present({ channel: reconnect }))).toEqual({
      accepted: false,
      reason: 'not-issued:revoked',
    });
  });

  it('T11 a generic token holder or claimed interface kind carries no evidence', () => {
    const r = rig();
    const claimed = { interfaceKind: 'electron', token: 'valid-local-token' };
    expect(r.registry.issue(claimed, SLOT)).toEqual({
      issued: false,
      reason: 'no-native-evidence',
    });
    const s = issued(r);
    expect(consume(r, s, idle, s.present({ channel: claimed }))).toEqual({
      accepted: false,
      reason: 'no-native-evidence',
    });
  });

  it('T12 retired evidence (launcher incarnation ended) blocks consume and release', async () => {
    const r = rig();
    const s = issued(r);
    r.retire(r.channel);
    expect(consume(r, s, idle)).toEqual({
      accepted: false,
      reason: 'no-native-evidence',
    });

    const r2 = rig();
    const outcome = await outcomeOf(
      consume(r2, issued(r2), (ctx) => {
        r2.retire(r2.channel);
        expect(ctx.mayRelease()).toBe(false);
        return idle();
      }),
    );
    expect(outcome.state).toBe('revoked');
  });
});

describe('migration session registry: F5b T13–T18', () => {
  const thenGetter = (get: () => unknown): object =>
    Object.defineProperty({}, 'then', { get });
  const thenable = (
    then: (fulfil: (v: unknown) => void, reject: (e: unknown) => void) => void,
  ): object => ({ then });
  let thenReads = 0;
  const initiationRows: [string, Initiate, Outcome, number][] = [
    [
      'T13a sync throw before release',
      (): never => {
        throw new Error('boom');
      },
      notInitiated('sync-throw'),
      0,
    ],
    [
      'T13b sync throw after release',
      (ctx): never => {
        ctx.mayRelease();
        throw new Error('boom');
      },
      { state: 'uncertain', reason: 'sync-throw' },
      1,
    ],
    [
      'T14a non-thenable return without release',
      (): number => 42,
      notInitiated('non-thenable'),
      0,
    ],
    [
      'T14b non-thenable return after release',
      release({ notAPromise: true }, true),
      { state: 'uncertain', reason: 'non-thenable' },
      1,
    ],
    [
      'T14c throwing then getter after release',
      release(
        thenGetter(() => {
          throw new Error('then-getter');
        }),
        true,
      ),
      { state: 'uncertain', reason: 'then-getter-threw' },
      1,
    ],
    [
      'T14d onFulfilled twice then onRejected',
      release(
        thenable((fulfil, reject) => {
          fulfil('first');
          fulfil('second');
          reject(new Error('late'));
        }),
        true,
      ),
      { state: 'completed', value: 'first' },
      0,
    ],
    [
      'T14e onRejected then onFulfilled after release',
      release(
        thenable((fulfil, reject) => {
          reject(new Error('first'));
          fulfil('second');
        }),
        true,
      ),
      { state: 'uncertain', reason: 'rejected' },
      1,
    ],
    [
      'T14f then is read exactly once',
      release(
        thenGetter(() => {
          thenReads += 1;
          if (thenReads > 1) throw new Error('second read');
          return (fulfil: (v: unknown) => void): void => fulfil('once');
        }),
        true,
      ),
      { state: 'completed', value: 'once' },
      0,
    ],
    [
      'T14g then throws after calling onFulfilled',
      release(
        thenable((fulfil) => {
          fulfil('done');
          throw new Error('then-after');
        }),
        true,
      ),
      { state: 'completed', value: 'done' },
      0,
    ],
  ];

  it.each(initiationRows)(
    '%s: one terminal state, fenced only after release',
    async (_name, initiate, expected, fences) => {
      thenReads = 0;
      const r = rig();
      const s = issued(r);
      expect(await outcomeOf(consume(r, s, initiate))).toEqual(expected);
      expect(r.registry.get(s.id)?.terminalTransitions).toBe(1);
      expect(r.fences).toHaveLength(fences);
      if (fences > 0)
        expect(r.fences).toEqual([{ key: PROD_KEY, generation: 'g1' }]);
    },
  );

  it('T13c/T13d a captured mayRelease after a sync throw stays false; one fence', async () => {
    for (const releaseFirst of [false, true]) {
      const r = rig();
      const s = issued(r);
      const run = captured(r, s, (ctx) => {
        if (releaseFirst) ctx.mayRelease();
        throw new Error('boom');
      });
      await run.outcome;
      expect(run.ctx().mayRelease()).toBe(false);
      expect(r.registry.get(s.id)).toMatchObject({
        state: releaseFirst ? 'uncertain' : 'revoked',
        released: releaseFirst,
      });
      r.clock.advance(SETTLE_MS);
      await flush();
      expect(r.fences).toHaveLength(releaseFirst ? 1 : 0);
    }
  });

  it('T14h an unrecognized fulfilment after release is uncertain', async () => {
    const r = rig();
    const s = issued(r);
    const result = r.registry.consume(
      s.id,
      s.present(),
      release('not-a-number'),
      (value): value is number => typeof value === 'number',
    );
    expect(await outcomeOf(result)).toEqual({
      state: 'uncertain',
      reason: 'unrecognized-result',
    });
    expect(r.fences).toHaveLength(1);
  });

  it('T15a lost pending after release: the deadline is uncertain and fences once', async () => {
    const r = rig();
    const s = issued(r);
    const late = deferred<undefined>();
    const run = captured(r, s, (ctx) => {
      ctx.mayRelease();
      return late.promise;
    });
    await flush();
    expect(r.registry.get(s.id)?.state).toBe('pending');
    r.clock.advance(SETTLE_MS);
    expect(await run.outcome).toEqual({
      state: 'uncertain',
      reason: 'settlement-deadline',
    });
    late.resolve(undefined);
    await flush();
    expect(r.registry.get(s.id)).toMatchObject({
      state: 'uncertain',
      terminalTransitions: 1,
    });
    expect(r.fences).toHaveLength(1);
  });

  it('T15b indefinite pending without release: uncertain, never revoked or re-issued', async () => {
    const r = rig();
    const s = issued(r);
    const run = captured(r, s);
    await flush();
    r.clock.advance(SETTLE_MS);
    expect(r.registry.get(s.id)?.state).toBe('uncertain');
    expect(run.ctx().mayRelease()).toBe(false);
    expect(consume(r, s, idle).accepted).toBe(false);
    expect(r.registry.issue(r.channel, SLOT)).toEqual({
      issued: false,
      reason: 'source-generation-fenced',
    });
  });

  it('T15c the deadline before a queued fulfilment: uncertain, late completion ignored', async () => {
    const r = rig();
    const s = issued(r);
    consume(r, s, release());
    r.clock.advance(SETTLE_MS);
    await flush();
    const snapshot = r.registry.get(s.id);
    expect(snapshot).toMatchObject({
      state: 'uncertain',
      terminalTransitions: 1,
    });
    expect(r.fences).toHaveLength(1);
    expect(snapshot?.history.some((h) => h.startsWith('late:completed'))).toBe(
      true,
    );
  });

  it('T15d fulfilment first, then the deadline passes: completed, no fence', async () => {
    const r = rig();
    const s = issued(r);
    consume(r, s, release());
    await flush();
    r.clock.advance(SETTLE_MS * 2);
    expect(r.registry.get(s.id)).toMatchObject({
      state: 'completed',
      terminalTransitions: 1,
    });
    expect(r.fences).toEqual([]);
  });

  it('T16 slot, source and generation come only from the session record', async () => {
    const r = rig();
    const s = issued(r);
    const presentation = {
      ...s.present(),
      slot: 'linear-token',
      generation: '999',
      source: INTERNAL,
    };
    let context: MigrationReleaseContext | undefined;
    const outcome = await outcomeOf(
      consume(
        r,
        s,
        (ctx) => {
          context = ctx;
          return release()(ctx);
        },
        presentation,
      ),
    );
    // Asserted here, not in the initiator: the registry swallows its throws.
    expect(outcome.state).toBe('completed');
    if (!context) throw new Error('not initiated');
    expect([context.slot, context.generation, context.source]).toEqual([
      SLOT,
      'g1',
      PROD,
    ]);
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.source)).toBe(true);
    expect(Reflect.set(context, 'slot', 'mutated')).toBe(false);
    expect(Reflect.set(context.source, 'flavorId', 'mutated')).toBe(false);
    expect(context.slot).toBe(SLOT);
    expect(r.registry.get(s.id)?.slot).toBe(SLOT);
  });

  it('T17a revoke during pending, then the deadline: exactly one terminal state', async () => {
    const r = rig();
    const s = issued(r);
    const run = captured(r, s);
    await flush();
    r.registry.revoke(s.id, 'operator');
    expect(run.ctx().mayRelease()).toBe(false);
    r.clock.advance(SETTLE_MS);
    expect(r.registry.get(s.id)).toMatchObject({
      state: 'uncertain',
      terminalTransitions: 1,
    });
  });

  it('T17b the deadline, then revoke: revoke is a no-op', async () => {
    const r = rig();
    const s = issued(r);
    captured(r, s, (ctx) => {
      ctx.mayRelease();
      return hang();
    });
    await flush();
    r.clock.advance(SETTLE_MS);
    expect(r.registry.revoke(s.id, 'operator')).toBe(false);
    expect(r.registry.get(s.id)).toMatchObject({
      state: 'uncertain',
      terminalTransitions: 1,
    });
  });

  it('T17c revoke during pending, fulfilment without release, then the deadline', async () => {
    const r = rig();
    const s = issued(r);
    const finish = deferred<undefined>();
    const run = captured(r, s, () => finish.promise);
    await flush();
    r.registry.revoke(s.id, 'operator');
    expect(run.ctx().mayRelease()).toBe(false);
    finish.resolve(undefined);
    expect(await run.outcome).toEqual(
      notInitiated('fulfilled-without-release'),
    );
    r.clock.advance(SETTLE_MS);
    expect(r.registry.get(s.id)?.terminalTransitions).toBe(1);
    expect(r.fences).toEqual([]);
  });

  it('T17d a re-entrant revoke inside initiate before release: release refused', async () => {
    const r = rig();
    const s = issued(r);
    let released: boolean | undefined;
    await outcomeOf(
      consume(r, s, (ctx) => {
        r.registry.revoke(s.id, 'operator');
        released = ctx.mayRelease();
        return idle();
      }),
    );
    expect(released).toBe(false);
    expect(r.registry.get(s.id)).toMatchObject({
      state: 'revoked',
      terminalTransitions: 1,
    });
    expect(r.fences).toEqual([]);
  });

  it('T18/T18b mayRelease is one-shot, recorded, and false after a terminal state', async () => {
    const r = rig();
    const s = issued(r);
    const calls: boolean[] = [];
    const run = captured(r, s, (ctx) => {
      calls.push(ctx.mayRelease(), ctx.mayRelease());
      return idle();
    });
    expect((await run.outcome).state).toBe('completed');
    expect(calls).toEqual([true, false]);
    expect(run.ctx().mayRelease()).toBe(false);
    expect(r.registry.get(s.id)).toMatchObject({ released: true });
    expect(r.registry.get(s.id)?.history).toContain('released');
  });

  it('a deadline that cannot be armed: never initiated, the outcome resolves, the slot is freed', async () => {
    const r = rig();
    const s = issued(r);
    r.clock.breakTimers();
    let called = false;
    const outcome = outcomeOf(
      consume(r, s, () => {
        called = true;
        return hang();
      }),
    );
    await expect(outcome).resolves.toEqual(
      notInitiated('deadline-unavailable'),
    );
    expect(called).toBe(false);
    expect(r.registry.issue(r.channel, SLOT).issued).toBe(true);
  });

  it('T18c release in a later turn after initiate returned: one-shot, then completed', async () => {
    const r = rig();
    const finish = deferred<undefined>();
    const run = captured(r, issued(r), () => finish.promise);
    await flush();
    const calls = [run.ctx().mayRelease(), run.ctx().mayRelease()];
    finish.resolve(undefined);
    expect((await run.outcome).state).toBe('completed');
    expect(calls).toEqual([true, false]);
  });
});

describe('migration session registry: B1–B9 at the session-binding layer', () => {
  it('B1 the right challenge on another channel: refused, revoked, single use kept', () => {
    const r = rig();
    const s = issued(r);
    const other = r.mint({ channelId: 'chan-2' });
    expect(consume(r, s, idle, s.present({ channel: other }))).toEqual({
      accepted: false,
      reason: 'binding:channel:channelId',
    });
    expect(r.registry.get(s.id)?.state).toBe('revoked');
    expect(consume(r, s, idle).accepted).toBe(false);
  });

  it('B2 the same pid with a different pidversion: refused', () => {
    const r = rig();
    const s = issued(r);
    const channel = r.mint({ launcher: { pid: 4242, pidversion: 100 } });
    expect(consume(r, s, idle, s.present({ channel }))).toEqual({
      accepted: false,
      reason: 'binding:channel:launcher.pidversion',
    });
  });

  it('B3 a remote or endpoint transport: refused at issue and at consume', () => {
    const r = rig();
    const remote = r.mint({ transport: 'tcp-remote' });
    expect(r.registry.issue(remote, SLOT)).toEqual({
      issued: false,
      reason: 'remote-or-unknown-transport',
    });
    const s = issued(r);
    const channel = r.mint({ transport: 'published-endpoint' });
    expect(consume(r, s, idle, s.present({ channel }))).toEqual({
      accepted: false,
      reason: 'binding:channel:transport',
    });
  });

  it.each(['updateEpoch', 'packageDigest'] as const)(
    'B4 R-8 at consume: %s changed since issue',
    (field) => {
      const r = rig();
      const s = issued(r);
      r.setHost({ [field]: 'changed' });
      expect(consume(r, s, idle)).toEqual({
        accepted: false,
        reason: `binding:host:${field}`,
      });
    },
  );

  it('B4b R-8 at release: an update between consume and release blocks release', async () => {
    const r = rig();
    const outcome = await outcomeOf(
      consume(r, issued(r), (ctx) => {
        r.setHost({ updateEpoch: 'epoch-8' });
        expect(ctx.mayRelease()).toBe(false);
        return idle();
      }),
    );
    expect(outcome.state).toBe('revoked');
  });

  it('B5 R-8 at issue: the admitted package identity differs from the host', () => {
    const r = rig();
    const stale = r.mint({ admittedHost: { ...HOST, packageDigest: 'stale' } });
    expect(r.registry.issue(stale, SLOT)).toEqual({
      issued: false,
      reason: 'host:packageDigest',
    });
    r.setHost({ updateEpoch: 'epoch-8' });
    expect(r.registry.issue(r.channel, SLOT)).toEqual({
      issued: false,
      reason: 'host:updateEpoch',
    });
  });

  it('B6 R-6 ambiguity revokes issued sessions and only flags pending ones', async () => {
    const r = rig();
    const pending = issued(r);
    const second = issued(r, 'linear-token');
    const run = captured(r, pending);
    await flush();
    r.registry.reportAmbiguity('two-candidate-peers');
    expect(r.registry.get(second.id)?.state).toBe('revoked');
    expect(r.registry.get(pending.id)).toMatchObject({
      state: 'pending',
      flagged: 'two-candidate-peers',
    });
    // Design choice: ambiguity also blocks a release that has not happened.
    expect(run.ctx().mayRelease()).toBe(false);
  });

  it('B7 an expired session is refused, and an unpresented one frees its slot', () => {
    const r = rig();
    const s = issued(r);
    r.clock.advance(TTL_MS);
    expect(consume(r, s, idle)).toEqual({ accepted: false, reason: 'expired' });
    const stale = issued(r, 'linear-token');
    r.clock.advance(TTL_MS);
    expect(r.registry.issue(r.channel, 'linear-token').issued).toBe(true);
    expect(r.registry.get(stale.id)).toMatchObject({
      state: 'revoked',
      reason: 'expired',
    });
  });

  it('B8 single use: a completed session cannot be consumed again', async () => {
    const r = rig();
    const s = issued(r);
    await outcomeOf(consume(r, s, release()));
    expect(consume(r, s, idle)).toEqual({
      accepted: false,
      reason: 'not-issued:completed',
    });
  });

  it.each([
    [{ challenge: 'x'.repeat(43) }, 'binding:challenge'],
    [{ challenge: '' }, 'binding:challenge'],
    [{ operation: 'restore' }, 'binding:operation'],
    [{ purpose: 'other-role' }, 'binding:purpose'],
  ])('B9 a wrong challenge, operation or purpose: %j', (overrides, reason) => {
    const r = rig();
    const s = issued(r);
    expect(consume(r, s, idle, s.present(overrides))).toEqual({
      accepted: false,
      reason,
    });
  });

  it('refuses unknown session ids and a second live session for a slot', () => {
    const r = rig();
    const s = issued(r);
    expect(r.registry.consume('nope', s.present(), idle, anyValue)).toEqual({
      accepted: false,
      reason: 'unknown-session',
    });
    expect(r.registry.get(s.id)?.state).toBe('issued');
    expect(r.registry.issue(r.channel, SLOT)).toEqual({
      issued: false,
      reason: 'slot-busy',
    });
  });
});

describe('migration session registry: launcher exit, shutdown and decline', () => {
  it('launcher exit revokes before release and is uncertain plus fence after it', async () => {
    const r = rig();
    const issuedOnly = issued(r, 'linear-token');
    const unreleased = captured(r, issued(r, 'cloud-account'));
    const released = captured(r, issued(r), (ctx) => {
      ctx.mayRelease();
      return hang();
    });
    const other = issued(r, 'mcp-oauth-tokens', r.mint({ channelId: 'c-2' }));
    await flush();
    r.registry.endChannel(r.channel, 'launcher-exit');
    expect(r.registry.get(issuedOnly.id)?.state).toBe('revoked');
    expect(await unreleased.outcome).toEqual(notInitiated('launcher-exit'));
    expect(await released.outcome).toEqual({
      state: 'uncertain',
      reason: 'launcher-exit',
    });
    expect(r.fences).toEqual([{ key: PROD_KEY, generation: 'g1' }]);
    expect(r.registry.get(other.id)?.state).toBe('issued');
  });

  it('a re-entrant launcher exit or close inside initiate ends the session once', async () => {
    for (const [releaseFirst, stop] of [
      [true, 'exit'],
      [false, 'exit'],
      [true, 'close'],
      [false, 'close'],
    ] as const) {
      const r = rig();
      const s = issued(r);
      const reason = stop === 'exit' ? 'launcher-exit' : 'closed';
      const run = captured(r, s, (ctx) => {
        if (releaseFirst) ctx.mayRelease();
        if (stop === 'exit') r.registry.endChannel(r.channel, reason);
        else r.registry.close();
        expect(ctx.mayRelease()).toBe(false);
        return Promise.resolve('late');
      });
      expect(await run.outcome).toEqual(
        releaseFirst ? { state: 'uncertain', reason } : notInitiated(reason),
      );
      await flush();
      r.clock.advance(SETTLE_MS);
      expect(r.registry.get(s.id)?.terminalTransitions).toBe(1);
      expect(r.fences).toHaveLength(releaseFirst ? 1 : 0);
    }
  });

  it('pruning keeps live sessions, in-process fences and source claims', async () => {
    const failing = (): void => {
      throw new Error('disk full');
    };
    const r = rig({ maxRetainedSessions: 1 }, { fence: failing });
    const live = issued(r, 'cloud-account');
    const lost = issued(r);
    await outcomeOf(
      consume(r, lost, (ctx) => {
        ctx.mayRelease();
        return Promise.reject(new Error('lost'));
      }),
    );
    const done = issued(r, 'linear-token');
    await outcomeOf(consume(r, done, release()));
    issued(r, 'mcp-oauth-tokens');
    expect(r.registry.get(lost.id)).toBeNull();
    expect(r.registry.get(done.id)).toBeNull();
    expect(r.registry.get(live.id)?.state).toBe('issued');
    expect(r.registry.issue(r.channel, SLOT)).toEqual({
      issued: false,
      reason: 'source-generation-fenced',
    });
    const internal = r.mint({ channelId: 'chan-internal', source: INTERNAL });
    expect(r.registry.issue(internal, 'linear-token')).toEqual({
      issued: false,
      reason: 'second-source',
    });
  });

  it('close refuses new sessions and ends live ones like a launcher exit', async () => {
    const r = rig();
    const run = captured(r, issued(r), (ctx) => {
      ctx.mayRelease();
      return hang();
    });
    await flush();
    r.registry.close();
    expect(await run.outcome).toEqual({ state: 'uncertain', reason: 'closed' });
    expect(r.registry.issue(r.channel, 'linear-token')).toEqual({
      issued: false,
      reason: 'closed',
    });
    r.clock.advance(SETTLE_MS);
    expect(r.fences).toHaveLength(1);
  });

  it('a bound decline revokes the session; a forged decline is refused', () => {
    const r = rig();
    const s = issued(r);
    const forged = s.present({ challenge: 'y'.repeat(43) });
    expect(r.registry.decline(s.id, forged, 'absent')).toEqual({
      accepted: false,
      reason: 'binding:challenge',
    });
    const t = issued(r);
    expect(r.registry.decline(t.id, t.present(), 'absent')).toEqual({
      accepted: true,
    });
    expect(r.registry.get(t.id)).toMatchObject({
      state: 'revoked',
      reason: 'declined:absent',
    });
  });
});

describe('migration session registry: re-entry from a port read', () => {
  type Reentry = (r: Rig, s: Issued) => void;
  const REENTRIES: [string, Reentry][] = [
    ['ambiguity', (r): void => r.registry.reportAmbiguity('reentry')],
    ['a revocation', (r, s): void => void r.registry.revoke(s.id, 'reentry')],
    [
      'a launcher exit',
      (r): void => r.registry.endChannel(r.channel, 'reentry'),
    ],
    ['a shutdown', (r): void => r.registry.close()],
  ];
  /** The host retired the channel in admission but has not told the registry. */
  const ADMISSION_ONLY: [string, Reentry] = [
    'an admission-only retirement',
    (r): void => r.retire(r.channel),
  ];
  type Read = [ReentrantPort, number];
  type ReadCase = [string, ReentrantPort, number, Reentry];
  const cases = (
    reentries: readonly [string, Reentry][],
    reads: readonly Read[],
  ): ReadCase[] =>
    reentries.flatMap(([label, act]) =>
      reads.map(([port, skip]): ReadCase => [label, port, skip, act]),
    );
  // An import reads the clock (expiry), then the channel, host and generation
  // for presentation and the channel a last time; mayRelease reads them again.
  const PRESENT_READS: readonly Read[] = [
    ['now', 0],
    ['channel', 0],
    ['host', 0],
    ['currentGeneration', 0],
    ['channel', 1],
  ];
  const RELEASE_READS: readonly Read[] = [
    ['channel', 2],
    ['host', 1],
    ['currentGeneration', 1],
    ['channel', 3],
  ];

  /** Imports with `act` raised from the `port` read `skip` reads in. */
  function importWith(
    port: ReentrantPort,
    act: Reentry,
    skip: number,
  ): {
    readonly r: Rig;
    readonly s: Issued;
    readonly value: Uint8Array;
    readonly result: MigrationConsumeResult<MigrationImportResult>;
  } {
    const r = rig();
    const s = issued(r);
    const value = bytes('secret');
    r.onRead(port, () => act(r, s), skip);
    const result = r.registry.importSlot(s.id, s.present(), value);
    return { r, s, value, result };
  }

  it.each(cases([...REENTRIES, ADMISSION_ONLY], RELEASE_READS))(
    '%s raised from the %s read (skip %i) in mayRelease blocks the release',
    async (_label, port, skip, act) => {
      const { r, s, value, result } = importWith(port, act, skip);
      expect((await outcomeOf(result)).state).toBe('revoked');
      expect(r.imports).toEqual([]);
      expect(value.every((byte) => byte === 0)).toBe(true);
      expect(r.registry.get(s.id)).toMatchObject({
        released: false,
        terminalTransitions: 1,
      });
    },
  );

  // Issue reads each port once in this order, then the channel a last time
  // (skip 1). No session exists yet, so a revocation has nothing to target.
  type IssueCase = [string, ReentrantPort, number, (r: Rig) => void, string];
  const DURING = 'ambiguity:during-issue';
  const ISSUE_READS: readonly Read[] = [
    ['channel', 0],
    ['host', 0],
    ['slotProgress', 0],
    ['currentGeneration', 0],
    ['isFenced', 0],
    ['now', 0],
    ['channel', 1],
  ];
  /** The refusal at (port, skip): the last check's, unless an earlier one sees `act`. */
  const ISSUE_REENTRIES: [
    string,
    (r: Rig) => void,
    (port: ReentrantPort, skip: number) => string,
  ][] = [
    [
      'ambiguity',
      (r): void => r.registry.reportAmbiguity('reentry'),
      (): string => DURING,
    ],
    [
      'a launcher exit',
      (r): void => r.registry.endChannel(r.channel, 'reentry'),
      (): string => DURING,
    ],
    ['a shutdown', (r): void => r.registry.close(), (): string => DURING],
    [
      'an admission-only retirement',
      (r): void => r.retire(r.channel),
      (port, skip): string =>
        port === 'channel' && skip === 0 ? 'no-native-evidence' : DURING,
    ],
    [
      'a nested issue',
      (r): void => void r.registry.issue(r.channel, SLOT),
      // The slot check follows the first channel, host and progress reads.
      (port, skip): string =>
        ['channel', 'host', 'slotProgress'].includes(port) && skip === 0
          ? 'slot-busy'
          : DURING,
    ],
  ];
  it.each(
    ISSUE_REENTRIES.flatMap(([label, act, reasonAt]) =>
      ISSUE_READS.map(
        ([port, skip]): IssueCase => [
          label,
          port,
          skip,
          act,
          reasonAt(port, skip),
        ],
      ),
    ),
  )(
    '%s raised from the %s read (skip %i) during issue refuses the issue',
    (_label, port, skip, act, reason) => {
      const r = rig();
      r.onRead(port, () => act(r), skip);
      expect(r.registry.issue(r.channel, SLOT)).toEqual({
        issued: false,
        reason,
      });
    },
  );

  it.each<ReentrantPort>(['currentGeneration', 'isFenced', 'now'])(
    'a nested issue during the %s read leaves one live session',
    (port) => {
      const r = rig();
      let nested = '';
      r.onRead(port, () => {
        const inner = r.registry.issue(r.channel, SLOT);
        nested = inner.issued ? inner.offer.sessionId : inner.reason;
      });
      expect(r.registry.issue(r.channel, SLOT)).toEqual({
        issued: false,
        reason: DURING,
      });
      expect(r.registry.get(nested)?.state).toBe('issued');
      expect(r.registry.issue(r.channel, SLOT)).toEqual({
        issued: false,
        reason: 'slot-busy',
      });
    },
  );

  it.each(cases(REENTRIES, PRESENT_READS))(
    '%s raised from the %s read (skip %i) in presentation refuses it',
    (_label, port, skip, act) => {
      const { r, s, value, result } = importWith(port, act, skip);
      expect(result).toEqual({ accepted: false, reason: 'not-issued:revoked' });
      expect(r.imports).toEqual([]);
      expect(value.every((byte) => byte === 0)).toBe(true);
      expect(r.registry.get(s.id)).toMatchObject({
        state: 'revoked',
        released: false,
        terminalTransitions: 1,
      });
    },
  );

  it.each(cases([ADMISSION_ONLY], PRESENT_READS))(
    '%s raised from the %s read (skip %i) in presentation refuses it',
    (_label, port, skip, act) => {
      const { r, s, value, result } = importWith(port, act, skip);
      expect(result).toEqual({ accepted: false, reason: 'no-native-evidence' });
      expect(r.imports).toEqual([]);
      expect(value.every((byte) => byte === 0)).toBe(true);
      expect(r.registry.get(s.id)).toMatchObject({
        state: 'revoked',
        reason: 'no-native-evidence',
        released: false,
      });
    },
  );
});

describe('create-only import (W15)', () => {
  it('imports into an empty slot and returns the receipt', async () => {
    const r = rig();
    const s = issued(r);
    const outcome = await outcomeOf(
      r.registry.importSlot(s.id, s.present(), bytes('ghp_secret')),
    );
    expect(outcome).toEqual({
      state: 'completed',
      value: { kind: 'created', receipt: `r-${SLOT}` },
    });
    expect(text(r.vault.get(SLOT)?.value)).toBe('ghp_secret');
    expect(r.imports[0]).toMatchObject({
      slot: SLOT,
      source: PROD,
      generation: 'g1',
    });
  });

  it('never overwrites an entry another writer made (a re-entered token)', async () => {
    const r = rig();
    r.vault.set(SLOT, { value: bytes('re-entered'), writer: 'settings-ui' });
    const s = issued(r);
    const outcome = await outcomeOf(
      r.registry.importSlot(s.id, s.present(), bytes('legacy')),
    );
    expect(outcome).toEqual({ state: 'completed', value: { kind: 'exists' } });
    expect(r.vault.get(SLOT)).toEqual({
      value: bytes('re-entered'),
      writer: 'settings-ui',
    });
    expect(r.fences).toEqual([]);
  });

  it('a later session for the same slot cannot replace the first import', async () => {
    const r = rig();
    const first = issued(r);
    await outcomeOf(
      r.registry.importSlot(first.id, first.present(), bytes('one')),
    );
    r.generations.set(PROD_KEY, 'g2');
    const second = issued(r);
    const outcome = await outcomeOf(
      r.registry.importSlot(second.id, second.present(), bytes('two')),
    );
    expect(outcome).toEqual({ state: 'completed', value: { kind: 'exists' } });
    expect(text(r.vault.get(SLOT)?.value)).toBe('one');
  });

  it('never calls the importer when presentation or release is refused', () => {
    const r = rig();
    const s = issued(r);
    r.registry.revoke(s.id, 'operator');
    expect(r.registry.importSlot(s.id, s.present(), bytes('x')).accepted).toBe(
      false,
    );
    const t = issued(r, 'linear-token');
    r.generations.set(migrationSlotKey(PROD, 'linear-token'), 'g9');
    expect(r.registry.importSlot(t.id, t.present(), bytes('x'))).toEqual({
      accepted: false,
      reason: 'binding:sourceGeneration',
    });
    expect(r.imports).toEqual([]);
  });

  it('zeroes the plaintext only after an asynchronous import has read it', async () => {
    const seen: string[] = [];
    const slowImport = async (
      request: MigrationImportRequest,
    ): Promise<MigrationImportResult> => {
      await flush();
      seen.push(text(request.value));
      return { kind: 'created', receipt: 'r-async' };
    };
    const r = rig({}, { createIfAbsent: slowImport });
    const s = issued(r);
    const imported = bytes('slow-secret');
    await outcomeOf(r.registry.importSlot(s.id, s.present(), imported));
    expect(seen).toEqual(['slow-secret']);
    expect(imported.every((b) => b === 0)).toBe(true);
    const refused = bytes('secret-two');
    expect(r.registry.importSlot(s.id, s.present(), refused).accepted).toBe(
      false,
    );
    expect(refused.every((b) => b === 0)).toBe(true);
  });

  it('zeroes the plaintext when the settlement deadline cannot be armed', async () => {
    const r = rig();
    const s = issued(r);
    r.clock.breakTimers();
    const plaintext = bytes('never-imported');
    const outcome = await outcomeOf(
      r.registry.importSlot(s.id, s.present(), plaintext),
    );
    expect(outcome).toEqual(notInitiated('deadline-unavailable'));
    expect(r.imports).toEqual([]);
    expect(plaintext.every((b) => b === 0)).toBe(true);
  });

  it('a receipt the wire would reject is uncertain, fenced and not reissued', async () => {
    const malformed = (): Promise<MigrationImportResult> =>
      Promise.resolve({ kind: 'created', receipt: 'not a receipt' });
    const r = rig({}, { createIfAbsent: malformed });
    const s = issued(r);
    const outcome = await outcomeOf(
      r.registry.importSlot(s.id, s.present(), bytes('x')),
    );
    expect(outcome).toEqual({
      state: 'uncertain',
      reason: 'unrecognized-result',
    });
    expect(r.fences).toEqual([{ key: PROD_KEY, generation: 'g1' }]);
    expect(r.registry.issue(r.channel, SLOT)).toEqual({
      issued: false,
      reason: 'source-generation-fenced',
    });
  });

  it('zeroes the plaintext when the presentation throws', () => {
    const r = rig();
    const s = issued(r);
    const presentation = Object.defineProperty(s.present(), 'challenge', {
      get: (): never => {
        throw new Error('hostile presentation');
      },
    });
    const plaintext = bytes('never-imported');
    expect(() => r.registry.importSlot(s.id, presentation, plaintext)).toThrow(
      'hostile presentation',
    );
    expect(r.imports).toEqual([]);
    expect(plaintext.every((b) => b === 0)).toBe(true);
  });

  it('the wire carries the receipt that was checked, read once', async () => {
    let reads = 0;
    const shifting: MigrationImportResult = {
      kind: 'created',
      get receipt(): string {
        reads += 1;
        return reads <= 2 ? 'r-checked' : 'not a receipt';
      },
    };
    const r = rig({}, { createIfAbsent: resolvesWith(shifting) });
    const s = issued(r);
    const outcome = await outcomeOf(
      r.registry.importSlot(s.id, s.present(), bytes('x')),
    );
    if (outcome.state !== 'completed') throw new Error(outcome.state);
    expect(migrationResultFrame(s.id, outcome)).toEqual({
      type: 'result',
      sessionId: s.id,
      outcome: 'imported',
      receipt: 'r-checked',
    });
    expect(Object.isFrozen(outcome.value)).toBe(true);
    expect(reads).toBe(1);
    expect(r.fences).toEqual([]);
  });

  it('a result that throws or carries no string receipt is uncertain and fenced', async () => {
    const throwing: MigrationImportResult = {
      kind: 'created',
      get receipt(): string {
        throw new Error('getter');
      },
    };
    for (const result of [throwing, { kind: 'created', receipt: 7 }, null]) {
      const r = rig({}, { createIfAbsent: resolvesWith(result) });
      const s = issued(r);
      const outcome = await outcomeOf(
        r.registry.importSlot(s.id, s.present(), bytes('x')),
      );
      expect(outcome.state).toBe('uncertain');
      expect(r.fences).toEqual([{ key: PROD_KEY, generation: 'g1' }]);
    }
  });

  it('a rejected import after release is uncertain and fenced', async () => {
    const lost = (): Promise<never> => Promise.reject(new Error('lost'));
    const r = rig({}, { createIfAbsent: lost });
    const s = issued(r);
    const outcome = await outcomeOf(
      r.registry.importSlot(s.id, s.present(), bytes('x')),
    );
    expect(outcome).toEqual({ state: 'uncertain', reason: 'rejected' });
    expect(r.fences).toHaveLength(1);
  });
});

describe('source identity and slot namespacing (C-11)', () => {
  it('namespaces slot keys by source, injectively', () => {
    const key = (flavorId: string, secureMode: string, slot = 'd'): string =>
      migrationSlotKey({ flavorId, secureMode }, slot);
    expect(PROD_KEY).not.toBe(migrationSlotKey(INTERNAL, SLOT));
    expect(key('a', 'b\u0000c')).not.toBe(key('a\u0000b', 'c'));
    expect(key('a"', 'b')).not.toBe(key('a', '"b'));
    expect(key('a', 'b', 'c')).not.toBe(key('a', 'b\u0000c', ''));
    expect(PROD_KEY).toBe(migrationSlotKey({ ...PROD }, SLOT));
  });

  it('reads generations and fences through the source-namespaced key', async () => {
    const r = rig();
    const internalKey = migrationSlotKey(INTERNAL, SLOT);
    r.generations.set(internalKey, 'internal-g5');
    const internal = r.mint({ channelId: 'chan-internal', source: INTERNAL });
    const s = issued(r, SLOT, internal);
    expect(r.registry.get(s.id)).toMatchObject({
      generation: 'internal-g5',
      source: INTERNAL,
    });
    await outcomeOf(
      consume(r, s, (ctx) => {
        ctx.mayRelease();
        return Promise.reject(new Error('lost'));
      }),
    );
    expect(r.fences).toEqual([{ key: internalKey, generation: 'internal-g5' }]);
  });

  it('refuses a second source for a slot already past not_started', () => {
    const r = rig();
    r.progress.set(SLOT, { state: 'imported_unverified', source: PROD });
    const internal = r.mint({ channelId: 'chan-internal', source: INTERNAL });
    expect(r.registry.issue(internal, SLOT)).toEqual({
      issued: false,
      reason: 'second-source',
    });
    expect(r.registry.issue(r.channel, SLOT).issued).toBe(true);
  });

  it('refuses a second source while or after another source holds the slot', async () => {
    const r = rig();
    const s = issued(r);
    const internal = r.mint({ channelId: 'chan-internal', source: INTERNAL });
    const refused = { issued: false, reason: 'second-source' };
    expect(r.registry.issue(internal, SLOT)).toEqual(refused);
    await outcomeOf(consume(r, s, release()));
    expect(r.registry.issue(internal, SLOT)).toEqual(refused);
    expect(r.registry.issue(internal, 'linear-token').issued).toBe(true);
  });

  it('refuses when durable progress and an in-process release name different sources', async () => {
    const r = rig();
    await outcomeOf(consume(r, issued(r), release()));
    r.progress.set(SLOT, { state: 'imported_unverified', source: INTERNAL });
    const internal = r.mint({ channelId: 'chan-internal', source: INTERNAL });
    const refused = { issued: false, reason: 'second-source' };
    expect(r.registry.issue(r.channel, SLOT)).toEqual(refused);
    expect(r.registry.issue(internal, SLOT)).toEqual(refused);
  });

  it('lets another source start once the first source was only revoked', () => {
    const r = rig();
    r.registry.revoke(issued(r).id, 'operator');
    const internal = r.mint({ channelId: 'chan-internal', source: INTERNAL });
    expect(r.registry.issue(internal, SLOT).issued).toBe(true);
  });
});

describe('data-driven slot set (W7)', () => {
  it('lists the six legacy stores at the pin, with no Copilot slot on Linux', () => {
    expect(MIGRATION_SLOTS_AT_PIN.map((slot) => slot.id)).toEqual([
      'github-pat',
      'linear-token',
      'mcp-oauth-tokens',
      'cloud-account',
      'user-environment-secrets',
      'copilot-account',
    ]);
    expect(Object.isFrozen(MIGRATION_SLOTS_AT_PIN)).toBe(true);
    expect(
      MIGRATION_SLOTS_AT_PIN.find((slot) => slot.id === 'copilot-account')
        ?.platforms,
    ).toEqual(['darwin', 'win32']);
  });

  it('issues only allowlisted slots available on the host OS', () => {
    const r = rig({ os: 'linux' });
    const refused = (reason: string): unknown => ({ issued: false, reason });
    expect(r.registry.issue(r.channel, 'copilot-account')).toEqual(
      refused('slot-unavailable'),
    );
    expect(r.registry.issue(r.channel, 'github-pat').issued).toBe(true);
    for (const slot of ['../secure/x', 'constructor', '__proto__', ''])
      expect(r.registry.issue(r.channel, slot)).toEqual(
        refused('unknown-slot'),
      );
  });

  it('takes its slot set from data, so another store is one row', () => {
    const slots: readonly MigrationSlotDefinition[] = [
      ...MIGRATION_SLOTS_AT_PIN,
      { id: 'model-gateway-credentials', platforms: ['darwin'] },
    ];
    const r = rig({ slots });
    expect(
      r.registry.issue(r.channel, 'model-gateway-credentials').issued,
    ).toBe(true);
    const only = rig({ slots: [{ id: 'one', platforms: ['darwin'] }] });
    expect(only.registry.issue(only.channel, 'github-pat')).toEqual({
      issued: false,
      reason: 'unknown-slot',
    });
  });

  it('rejects a malformed slot set and bad timing options', () => {
    const slot = (id: string): MigrationSlotDefinition => ({
      id,
      platforms: ['darwin'],
    });
    for (const options of [
      { slots: [slot('a'), slot('a')] },
      { slots: [slot('')] },
      { slots: [slot('../x')] },
      { slots: [{ id: 'a', platforms: [] }] },
      { ttlMs: 0 },
      { settleMs: 1.5 },
    ])
      expect(() => rig(options)).toThrow(RangeError);
  });
});
