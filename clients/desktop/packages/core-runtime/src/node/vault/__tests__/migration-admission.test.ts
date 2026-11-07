import type { CanopyDaemonClock } from '../../daemon/leases';
import {
  MIGRATION_LAUNCHER_RUNTIME_FLAG,
  authenticateMigrationDestination,
  createMigrationAdmission,
  migrationDaemonRequirement,
  migrationLauncherRequirement,
  type MigrationAdmission,
  type MigrationAdmissionRefusal,
  type MigrationAdmissionResult,
  type MigrationDaemonExpectation,
  type MigrationLauncherExpectation,
} from '../migration-admission';
import {
  createMigrationEvidenceStore,
  type MigrationCodeSigning,
  type MigrationDarwinDestinationEvidence,
  type MigrationDarwinLauncherEvidence,
  type MigrationEvidenceStore,
  type MigrationPeerCapture,
  type MigrationProcessToken,
} from '../migration-evidence';
import {
  MIGRATION_HOST_FIELDS,
  type MigrationHostFacts,
  type MigrationHostOs,
  type MigrationSlotProgress,
} from '../migration-ports';
import {
  createMigrationSessionRegistry,
  type MigrationPresentation,
  type MigrationReleaseContext,
  type MigrationSessionRegistry,
} from '../migration-sessions';

// B1–B9 here are admission rows: each is refused by admission itself, or
// (B7–B9, pure session properties) by the registry reading admission's port.
// R-3 and R-5 are not labelled: their r17 definitions were not recoverable.

const TEAM = 'ABCDE12345';
const PROD_ID = 'com.example.canopy';
const INTERNAL_ID = 'com.example.canopy.dev';
const BUILD = 'build-1';
const MAIN: MigrationProcessToken = Object.freeze({
  pid: 4242,
  pidversion: 99,
});
const LAUNCHER_CDHASH = 'a'.repeat(40);
const FLAGS = MIGRATION_LAUNCHER_RUNTIME_FLAG | 0x2;
const SLOT = 'github-pat';

const PROD: MigrationLauncherExpectation = Object.freeze({
  teamId: TEAM,
  flavorId: PROD_ID,
  secureMode: 'prod',
  buildId: BUILD,
});
const INTERNAL: MigrationLauncherExpectation = Object.freeze({
  ...PROD,
  flavorId: INTERNAL_ID,
  secureMode: 'internal',
});
const HOST: MigrationHostFacts = Object.freeze({
  authorityId: 'authority-1',
  coreAuthority: 'core-A',
  coreIncarnation: 'core-inc-1',
  coreDigest: 'cdhash:daemon-1',
  buildId: BUILD,
  packageDigest: 'sha256:package-1',
  updateEpoch: 'epoch-7',
});

interface CaptureOverrides {
  readonly token?: MigrationProcessToken;
  readonly codeToken?: MigrationProcessToken;
  readonly signing?: Partial<MigrationCodeSigning>;
  readonly requirement?: {
    readonly text?: string;
    readonly satisfied?: boolean;
  };
  readonly staticCheck?: 'passed' | 'failed' | 'not-run';
}

function capture(
  identity: { readonly identifier: string; readonly requirement: string },
  overrides: CaptureOverrides = {},
  token: MigrationProcessToken = MAIN,
): MigrationPeerCapture {
  const captured = overrides.token ?? token;
  return {
    kind: 'captured',
    token: captured,
    codeToken: overrides.codeToken ?? captured,
    signing: {
      teamId: TEAM,
      identifier: identity.identifier,
      buildId: BUILD,
      codeFlags: FLAGS,
      cdhash: LAUNCHER_CDHASH,
      ...overrides.signing,
    },
    requirement: {
      text: identity.requirement,
      satisfied: true,
      ...overrides.requirement,
    },
    staticCheck: overrides.staticCheck ?? 'not-run',
  };
}

const launcherCapture = (
  overrides: CaptureOverrides = {},
  expected = PROD,
): MigrationPeerCapture =>
  capture(
    {
      identifier: expected.flavorId,
      requirement: migrationLauncherRequirement(expected),
    },
    overrides,
  );

function evidence(
  overrides: Partial<MigrationDarwinLauncherEvidence> = {},
  expected = PROD,
): MigrationDarwinLauncherEvidence {
  return {
    os: 'darwin',
    launched: true,
    fd3: { family: 'AF_UNIX', type: 'SOCK_STREAM' },
    fd3CloexecAtStartup: true,
    startupParentPid: MAIN.pid,
    captureParentPid: MAIN.pid,
    peer: launcherCapture({}, expected),
    ...overrides,
  };
}

function manualClock(): CanopyDaemonClock & { advance(ms: number): void } {
  let now = 1_000_000;
  const timers = new Set<{ at: number; run: () => void }>();
  return {
    now: (): number => now,
    setTimer(run, delayMs): { cancel(): void } {
      const timer = { at: now + delayMs, run };
      timers.add(timer);
      return { cancel: (): void => void timers.delete(timer) };
    },
    advance(ms): void {
      now += ms;
      for (const timer of Array.from(timers))
        if (timer.at <= now && timers.delete(timer)) timer.run();
    },
  };
}

interface RigOptions {
  readonly os?: MigrationHostOs;
  readonly expected?: MigrationLauncherExpectation;
  readonly missingPrerequisites?: () => readonly string[];
  /** False: `onAmbiguity` records only, as a host that never told the registry. */
  readonly forwardAmbiguity?: boolean;
}

interface Rig {
  readonly store: MigrationEvidenceStore;
  readonly admission: MigrationAdmission;
  readonly registry: MigrationSessionRegistry;
  readonly clock: ReturnType<typeof manualClock>;
  readonly ambiguities: string[];
  readonly progress: Map<string, MigrationSlotProgress>;
  setHost(overrides: Partial<MigrationHostFacts>): void;
  /** Runs `act` once, inside the host read that follows `skip` others. */
  onHostRead(act: () => void, skip?: number): void;
  /** As `onHostRead`, for the source generation read. */
  onGenerationRead(act: () => void, skip?: number): void;
  readonly imports: unknown[];
  attach(value?: unknown): object;
  admit(handle: object): MigrationAdmissionResult;
}

function rig(options: RigOptions = {}): Rig {
  let host: MigrationHostFacts = { ...HOST };
  let hostRead: { act: () => void; skip: number } | null = null;
  let generationRead: { act: () => void; skip: number } | null = null;
  const imports: unknown[] = [];
  const ambiguities: string[] = [];
  const progress = new Map<string, MigrationSlotProgress>();
  const clock = manualClock();
  const store = createMigrationEvidenceStore();
  let registry: MigrationSessionRegistry | null = null;
  const admission = createMigrationAdmission({
    os: options.os ?? 'darwin',
    expected: options.expected ?? PROD,
    evidence: store,
    host: (): MigrationHostFacts => {
      const pending = hostRead;
      if (pending !== null && pending.skip > 0) pending.skip -= 1;
      else if (pending !== null) {
        hostRead = null;
        pending.act();
      }
      return host;
    },
    missingPrerequisites: options.missingPrerequisites ?? ((): string[] => []),
    onAmbiguity: (reason) => {
      ambiguities.push(reason);
      if (options.forwardAmbiguity !== false) registry?.reportAmbiguity(reason);
    },
  });
  registry = createMigrationSessionRegistry(
    {
      admission: admission.port,
      source: {
        currentGeneration: (): string => {
          const pending = generationRead;
          if (pending !== null && pending.skip > 0) pending.skip -= 1;
          else if (pending !== null) {
            generationRead = null;
            pending.act();
          }
          return 'g1';
        },
        isFenced: () => false,
        fence: () => undefined,
        slotProgress: (slot) => progress.get(slot) ?? { state: 'not_started' },
      },
      importer: {
        createIfAbsent: (request) => {
          imports.push(request);
          return Promise.resolve({ kind: 'created', receipt: 'r' });
        },
      },
      clock,
    },
    { os: options.os ?? 'darwin', ttlMs: 60_000, settleMs: 1_000 },
  );
  return {
    store,
    admission,
    registry,
    clock,
    ambiguities,
    progress,
    setHost: (overrides): void => {
      host = { ...host, ...overrides };
    },
    onHostRead: (act, skip = 0): void => {
      hostRead = { act, skip };
    },
    onGenerationRead: (act, skip = 0): void => {
      generationRead = { act, skip };
    },
    imports,
    attach: (value: unknown = evidence()): object => store.attach(value),
    admit: (handle): MigrationAdmissionResult =>
      admission.admitMigrationConnection(handle),
  };
}

const refused = (
  reason: MigrationAdmissionRefusal,
): MigrationAdmissionResult => ({
  admitted: false,
  refusal: 'refused',
  reason,
});

/** Attaches `value` and admits it, as the native transport and host would. */
function admitted(r: Rig, value: unknown = evidence()): object {
  const handle = r.attach(value);
  const result = r.admit(handle);
  if (!result.admitted)
    throw new Error(`admission refused: ${JSON.stringify(result)}`);
  return handle;
}

interface Offer {
  readonly id: string;
  present(overrides?: Partial<MigrationPresentation>): MigrationPresentation;
}

function offer(r: Rig, channel: object, slot = SLOT): Offer {
  const result = r.registry.issue(channel, slot);
  if (!result.issued) throw new Error(`issue refused: ${result.reason}`);
  const issued = result.offer;
  return {
    id: issued.sessionId,
    present: (overrides = {}): MigrationPresentation => ({
      channel,
      challenge: issued.challenge,
      operation: issued.operation,
      purpose: issued.purpose,
      ...overrides,
    }),
  };
}

const anyValue = (value: unknown): value is unknown => value !== Symbol.for('');
const idle = (): Promise<void> => Promise.resolve();

describe('migration evidence store', () => {
  it('hands out opaque, frozen handles that carry and serialize nothing', () => {
    const r = rig();
    const handle = r.attach();
    expect(Object.getPrototypeOf(handle)).toBeNull();
    expect(Reflect.ownKeys(handle)).toEqual([]);
    expect(Object.isFrozen(handle)).toBe(true);
    expect(JSON.stringify(handle)).toBe('{}');
    expect(r.store.lookup(structuredClone(handle))).toBeNull();
    expect(r.store.lookup({})).toBeNull();
    expect(r.attach()).not.toBe(handle);
  });

  // Each source answers MAIN on the first read and launchd (reparented) after.
  it.each([
    [
      'a getter',
      (answer: () => number): object =>
        Object.defineProperty(evidence(), 'captureParentPid', {
          enumerable: true,
          get: answer,
        }),
    ],
    [
      'a proxy',
      (answer: () => number): object =>
        new Proxy(evidence(), {
          get: (target, key, receiver): unknown =>
            key === 'captureParentPid'
              ? answer()
              : Reflect.get(target, key, receiver),
        }),
    ],
  ])(
    'copies %s once, so later answers are never seen (R-7: no recheck)',
    (_label, make) => {
      const r = rig();
      let reads = 0;
      const source = make(() => (reads++ === 0 ? MAIN.pid : 1));
      expect(reads).toBe(0);
      const handle = r.attach(source);
      expect(reads).toBe(1);
      const stored = r.store.lookup(handle)?.evidence;
      expect(stored).toEqual(evidence());
      expect(Object.isFrozen(stored)).toBe(true);
      expect(r.admit(handle).admitted).toBe(true);
      expect(reads).toBe(1);
    },
  );

  it.each([
    ['an extra LOCAL_PEERPID field', { ...evidence(), peerPid: MAIN.pid }],
    ['a missing field', { ...evidence(), launched: undefined }],
    ['a non-integer pid', evidence({ captureParentPid: 4242.5 })],
    [
      'a non-hex cdhash',
      evidence({ peer: launcherCapture({ signing: { cdhash: 'x' } }) }),
    ],
    ['an unknown os', { ...evidence(), os: 'freebsd' }],
    ['an array', [evidence()]],
    ['null', null],
    [
      'a throwing getter',
      Object.defineProperty(evidence(), 'launched', {
        enumerable: true,
        get(): never {
          throw new Error('unreadable');
        },
      }),
    ],
    [
      'a throwing proxy',
      new Proxy(evidence(), {
        ownKeys(): never {
          throw new Error('unreadable');
        },
      }),
    ],
  ])('records %s as malformed and admission refuses it', (_label, value) => {
    const r = rig();
    const handle = r.attach(value);
    expect(r.store.lookup(handle)).toEqual({ evidence: null });
    expect(r.admit(handle)).toEqual(refused('malformed-evidence'));
  });

  it('forgets retired handles', () => {
    const r = rig();
    const handle = r.attach();
    r.store.retire(handle);
    expect(r.store.lookup(handle)).toBeNull();
    expect(r.admit(handle)).toEqual(refused('no-evidence'));
  });

  it('a handle the transport retires in the store stops being a channel', () => {
    const r = rig();
    const handle = admitted(r);
    const s = offer(r, handle);
    r.store.retire(handle);
    expect(r.admission.port.channel(handle)).toBeNull();
    expect(r.registry.consume(s.id, s.present(), idle, anyValue)).toEqual({
      accepted: false,
      reason: 'no-native-evidence',
    });
  });
});

describe('migration admission: the own-flavor launcher', () => {
  it('admits a constant, frozen MigrationCaller that exposes no evidence', () => {
    const r = rig();
    const handle = r.attach();
    const result = r.admit(handle);
    if (!result.admitted) throw new Error('not admitted');
    const { channelId, ...facts } = result.caller;
    expect(channelId).toMatch(/^[0-9a-f]{32}$/);
    expect(facts).toEqual({
      principal: 'migration-launcher',
      transport: 'launcher-channel',
      launcher: { os: 'darwin', ...MAIN },
      launcherDigest: LAUNCHER_CDHASH,
      source: { flavorId: PROD_ID, secureMode: 'prod' },
      admittedHost: HOST,
    });
    expect(Object.isFrozen(result.caller)).toBe(true);
    expect(Object.isFrozen(result.caller.launcher)).toBe(true);
    expect(r.admission.port.channel(handle)).toBe(result.caller);
    expect(r.admission.port.host()).toEqual(HOST);
    expect(r.ambiguities).toEqual([]);
  });

  it('compiles the launcher requirement for its own flavor and refuses unsafe input', () => {
    expect(migrationLauncherRequirement(PROD)).toBe(
      'anchor apple generic and certificate leaf[subject.OU]="ABCDE12345"' +
        ' and identifier "com.example.canopy"' +
        ' and info[CanopyBuildId]="build-1"',
    );
    for (const bad of [
      { flavorId: 'com.example" or identifier "x' },
      { flavorId: 'canopy' },
      { teamId: 'abcde12345' },
      { buildId: 'build"1' },
      { secureMode: '' },
    ])
      expect(() => rig({ expected: { ...PROD, ...bad } })).toThrow(RangeError);
  });

  it('accepts a passed static check and refuses a failed one', () => {
    const r = rig();
    const passed = r.attach(
      evidence({ peer: launcherCapture({ staticCheck: 'passed' }) }),
    );
    expect(r.admit(passed).admitted).toBe(true);
    const s = rig();
    const failed = s.attach(
      evidence({ peer: launcherCapture({ staticCheck: 'failed' }) }),
    );
    expect(s.admit(failed)).toEqual(refused('code:static-check'));
  });

  it('refuses everything once closed', () => {
    const r = rig();
    const handle = admitted(r);
    r.admission.close();
    expect(r.admission.port.channel(handle)).toBeNull();
    expect(r.admit(r.attach())).toEqual(refused('closed'));
  });
});

describe('migration admission: B1–B9 as admission rows', () => {
  it('B1 a generic token holder on another connection: refused before the session layer', () => {
    const r = rig();
    const s = offer(r, admitted(r));
    const endpoint = {};
    expect(r.admit(endpoint)).toEqual(refused('no-evidence'));
    expect(r.admission.port.channel(endpoint)).toBeNull();
    expect(
      r.registry.consume(
        s.id,
        s.present({ channel: endpoint }),
        idle,
        anyValue,
      ),
    ).toEqual({ accepted: false, reason: 'no-native-evidence' });
  });

  it('B2 the same pid with a different pidversion: refused', () => {
    const r = rig();
    const execd = { ...MAIN, pidversion: MAIN.pidversion + 1 };
    const handle = r.attach(
      evidence({ peer: launcherCapture({ codeToken: execd }) }),
    );
    expect(r.admit(handle)).toEqual(refused('lineage:pidversion'));
    const s = rig();
    const first = admitted(s);
    const again = s.attach(
      evidence({ peer: launcherCapture({ token: execd }) }),
    );
    expect(s.admit(again)).toEqual(refused('ambiguity:second-channel'));
    expect(s.admission.port.channel(first)).toBeNull();
  });

  it('B3 a remote or payload-built channel: no evidence, so no issue', () => {
    const r = rig();
    const handle = admitted(r);
    const caller = r.admission.port.channel(handle);
    for (const remote of [
      { ...caller },
      structuredClone(handle),
      { transport: 'tcp-remote' },
    ]) {
      expect(r.admit(remote)).toEqual(refused('no-evidence'));
      expect(r.registry.issue(remote, SLOT)).toEqual({
        issued: false,
        reason: 'no-native-evidence',
      });
    }
  });

  it.each(['updateEpoch', 'packageDigest'] as const)(
    'B4 R-8 at consume: a %s change retires the admitted channel',
    (field) => {
      const r = rig();
      const handle = admitted(r);
      const s = offer(r, handle);
      r.setHost({ [field]: 'changed' });
      expect(r.admission.port.channel(handle)).toBeNull();
      expect(r.registry.consume(s.id, s.present(), idle, anyValue)).toEqual({
        accepted: false,
        reason: 'no-native-evidence',
      });
      // Retirement is permanent: reverting the host does not revive it.
      r.setHost({ [field]: HOST[field] });
      expect(r.admission.port.channel(handle)).toBeNull();
    },
  );

  it('B5 R-8 at issue: the admitted identity differs from the current host', () => {
    const r = rig();
    const handle = admitted(r);
    r.setHost({ packageDigest: 'sha256:package-2' });
    expect(r.registry.issue(handle, SLOT)).toEqual({
      issued: false,
      reason: 'no-native-evidence',
    });
    const s = rig();
    s.setHost({ buildId: 'build-2' });
    expect(s.admit(s.attach())).toEqual(refused('host:buildId'));
  });

  it('B6 R-6 ambiguity revokes issued sessions and only flags pending ones', async () => {
    const r = rig();
    const handle = admitted(r);
    const pending = offer(r, handle);
    const issued = offer(r, handle, 'linear-token');
    const seen: { ctx: MigrationReleaseContext | null } = { ctx: null };
    const consumed = r.registry.consume(
      pending.id,
      pending.present(),
      (ctx) => {
        seen.ctx = ctx;
        return new Promise<never>(() => undefined);
      },
      anyValue,
    );
    expect(consumed.accepted).toBe(true);
    expect(r.admit(r.attach())).toEqual(refused('ambiguity:second-channel'));
    expect(r.ambiguities).toEqual(['ambiguity:second-channel']);
    expect(r.registry.get(issued.id)?.state).toBe('revoked');
    expect(r.registry.get(pending.id)).toMatchObject({
      state: 'pending',
      flagged: 'ambiguity:second-channel',
    });
    await Promise.resolve();
    expect(seen.ctx?.mayRelease()).toBe(false);
  });

  it('B7 an expired session is refused, and a retired channel is refused by admission', () => {
    const r = rig();
    const handle = admitted(r);
    const s = offer(r, handle);
    r.clock.advance(60_000);
    expect(r.registry.consume(s.id, s.present(), idle, anyValue)).toEqual({
      accepted: false,
      reason: 'expired',
    });
    r.admission.retire(handle);
    expect(r.admission.port.channel(handle)).toBeNull();
    expect(r.store.lookup(handle)).toBeNull();
    expect(r.registry.issue(handle, SLOT)).toEqual({
      issued: false,
      reason: 'no-native-evidence',
    });
  });

  it('B8 single use: a handle is admitted once and its caller stays constant', () => {
    const r = rig();
    const handle = r.attach();
    const first = r.admit(handle);
    if (!first.admitted) throw new Error('not admitted');
    expect(r.admit(handle)).toEqual(refused('already-admitted'));
    expect(r.admission.port.channel(handle)).toBe(first.caller);
    expect(r.admission.port.channel(handle)).toBe(first.caller);
    expect(r.ambiguities).toEqual([]);
  });

  it.each([
    [{ challenge: 'x'.repeat(43) }, 'binding:challenge'],
    [{ operation: 'restore' }, 'binding:operation'],
    [{ purpose: 'other-role' }, 'binding:purpose'],
  ])(
    'B9 %j on the admitted channel: refused by the session',
    (overrides, reason) => {
      const r = rig();
      const handle = admitted(r);
      const s = offer(r, handle);
      expect(
        r.registry.consume(s.id, s.present(overrides), idle, anyValue),
      ).toEqual({
        accepted: false,
        reason,
      });
      expect(r.admission.port.channel(handle)).not.toBeNull();
    },
  );
});

describe('migration admission: R-1–R-13', () => {
  it('R-1 and R-2: endpoint token holders and remote clients have no route', () => {
    const r = rig();
    const bare = {};
    Reflect.setPrototypeOf(bare, null);
    for (const connection of [
      { connectionId: 'endpoint-1' },
      { portal: true },
      { transport: 'remote', principal: 'migration-launcher' },
      { interfaceKind: 'cli', clientName: 'migration-launcher' },
      { interfaceKind: 'electron', principal: 'migration-launcher' },
      bare,
    ]) {
      expect(r.admit(connection)).toEqual(refused('no-evidence'));
      expect(r.admission.port.channel(connection)).toBeNull();
    }
    expect(r.ambiguities).toEqual([]);
  });

  it('R-4 a RunAsNode child presenting on the genuine channel: refused', () => {
    const r = rig();
    const child = { pid: 5000, pidversion: 3 };
    const handle = r.attach(
      evidence({ peer: launcherCapture({ token: child }) }),
    );
    expect(r.admit(handle)).toEqual(refused('lineage:not-parent'));
    expect(r.ambiguities).toEqual(['lineage:not-parent']);
  });

  it.each<
    [
      string,
      Partial<MigrationDarwinLauncherEvidence>,
      MigrationAdmissionRefusal,
    ]
  >([
    // pid ≠ ppid is R-4 and EINVAL/ENOTCONN are R-13, below.
    ['no channel', { fd3: null }, 'channel:none'],
    [
      'wrong fd 3 type',
      { fd3: { family: 'AF_UNIX', type: 'SOCK_DGRAM' } },
      'channel:fd3-type',
    ],
    [
      'an inet fd 3',
      { fd3: { family: 'AF_INET', type: 'SOCK_STREAM' } },
      'channel:fd3-type',
    ],
    [
      'an fd 3 co-holder (no CLOEXEC at startup)',
      { fd3CloexecAtStartup: false },
      'channel:fd3-inheritable',
    ],
    [
      'attached rather than launched',
      { launched: false },
      'channel:not-launched',
    ],
    [
      'a failed capture',
      { peer: { kind: 'capture-failed' } },
      'peer:capture-failed',
    ],
    [
      'a pidversion change',
      {
        peer: launcherCapture({ codeToken: { pid: MAIN.pid, pidversion: 1 } }),
      },
      'lineage:pidversion',
    ],
    [
      'reparented',
      {
        captureParentPid: 9000,
        peer: launcherCapture({ token: { pid: 9000, pidversion: 1 } }),
      },
      'lineage:reparented',
    ],
    [
      'reparented to launchd',
      {
        startupParentPid: 1,
        captureParentPid: 1,
        peer: launcherCapture({ token: { pid: 1, pidversion: 1 } }),
      },
      'lineage:reparented',
    ],
    [
      'a build mismatch',
      { peer: launcherCapture({ signing: { buildId: 'build-0' } }) },
      'code:build',
    ],
    [
      'a missing build id',
      { peer: launcherCapture({ signing: { buildId: null } }) },
      'code:build',
    ],
    [
      'a flavor mismatch',
      { peer: launcherCapture({ signing: { identifier: INTERNAL_ID } }) },
      'code:flavor',
    ],
    [
      'another team',
      { peer: launcherCapture({ signing: { teamId: 'ZZZZZ99999' } }) },
      'code:team',
    ],
    [
      'an unsigned team',
      { peer: launcherCapture({ signing: { teamId: null } }) },
      'code:team',
    ],
    [
      'an unsatisfied requirement',
      { peer: launcherCapture({ requirement: { satisfied: false } }) },
      'code:requirement',
    ],
    [
      'a requirement other than ours',
      {
        peer: launcherCapture({
          requirement: { text: 'anchor apple generic' },
        }),
      },
      'code:requirement',
    ],
    [
      'no hardened runtime',
      { peer: launcherCapture({ signing: { codeFlags: 0x2 } }) },
      'code:runtime',
    ],
  ])(
    'R-6 ambiguity: %s is refused and reported',
    (_label, overrides, reason) => {
      const r = rig();
      expect(r.admit(r.attach(evidence(overrides)))).toEqual(refused(reason));
      expect(r.ambiguities).toEqual([reason]);
    },
  );

  it('R-7 delegation: the handle exports no descriptor and capture is never repeated', () => {
    const r = rig();
    const live = evidence();
    const handle = r.attach(live);
    Object.assign(live, { captureParentPid: 1 });
    const result = r.admit(handle);
    expect(result.admitted).toBe(true);
    expect(Reflect.ownKeys(handle)).toEqual([]);
    // The store has no capture or descriptor API to repeat or export a capture.
    expect(Object.keys(r.store).sort()).toEqual(['attach', 'lookup', 'retire']);
    if (result.admitted)
      expect(Object.keys(result.caller).sort()).toEqual([
        'admittedHost',
        'channelId',
        'launcher',
        'launcherDigest',
        'principal',
        'source',
        'transport',
      ]);
  });

  it('R-9 a genuine daemon an attacker launched migrates only for its own authority', () => {
    const genuine = rig();
    const attacker = rig();
    attacker.setHost({
      authorityId: 'authority-attacker',
      coreIncarnation: 'core-inc-9',
    });
    const theirs = admitted(attacker);
    expect(
      attacker.admission.port.channel(theirs)?.admittedHost.authorityId,
    ).toBe('authority-attacker');
    expect(genuine.admission.port.channel(theirs)).toBeNull();
    expect(genuine.registry.issue(theirs, SLOT)).toEqual({
      issued: false,
      reason: 'no-native-evidence',
    });
  });

  it.each([
    ['R-10 a planted or relocated addon', ['va-3:addon-location']],
    ['R-11 SIGUSR1 not closed', ['va-3:sigusr1']],
    ['missing CAN-4507 entitlements', ['can-4507:entitlements']],
  ])('%s: refused until the prerequisite holds', (_label, missing) => {
    const r = rig({ missingPrerequisites: () => missing });
    expect(r.admit(r.attach())).toEqual(refused('prerequisite-missing'));
    const s = rig({
      missingPrerequisites: () => {
        throw new Error('unreadable');
      },
    });
    expect(s.admit(s.attach())).toEqual(refused('prerequisite-missing'));
  });

  it('refuses when the host identity is unreadable, even if the ambiguity hook throws', () => {
    const store = createMigrationEvidenceStore();
    const admission = createMigrationAdmission({
      os: 'darwin',
      expected: PROD,
      evidence: store,
      host: () => {
        throw new Error('no host');
      },
      missingPrerequisites: () => [],
      onAmbiguity: () => {
        throw new Error('hook failed');
      },
    });
    const handle = store.attach(evidence());
    expect(admission.admitMigrationConnection(handle)).toEqual(
      refused('host-unavailable'),
    );
    expect(admission.port.channel(handle)).toBeNull();
  });

  it('R-13 an exited peer never falls back to the parent pid', () => {
    for (const errno of ['EINVAL', 'ENOTCONN'] as const) {
      const r = rig();
      const gone = r.attach(evidence({ peer: { kind: 'peer-gone', errno } }));
      expect(r.admit(gone)).toEqual(refused('peer:gone'));
      expect(r.ambiguities).toEqual(['peer:gone']);
      expect(r.admission.port.channel(gone)).toBeNull();
    }
  });
});

describe('migration destination authentication (R-12)', () => {
  const DAEMON: MigrationProcessToken = Object.freeze({
    pid: 5151,
    pidversion: 7,
  });
  const DAEMON_CDHASH = 'b'.repeat(40);
  const BY_CDHASH: MigrationDaemonExpectation = {
    teamId: TEAM,
    identifier: 'com.example.canopy.daemon',
    binding: { kind: 'cdhash', cdhash: DAEMON_CDHASH },
  };
  const BY_ENTITLEMENT: MigrationDaemonExpectation = {
    ...BY_CDHASH,
    binding: {
      kind: 'entitlement',
      key: 'com.example.canopy.build-id',
      value: BUILD,
    },
  };

  function destination(
    overrides: Partial<MigrationDarwinDestinationEvidence> = {},
    peer: CaptureOverrides = {},
    expected = BY_CDHASH,
  ): MigrationDarwinDestinationEvidence {
    return {
      os: 'darwin',
      spawned: { ...DAEMON, unreaped: true },
      peer: capture(
        {
          identifier: expected.identifier,
          requirement: migrationDaemonRequirement(expected),
        },
        {
          ...peer,
          signing: { cdhash: DAEMON_CDHASH, buildId: null, ...peer.signing },
        },
        DAEMON,
      ),
      ...overrides,
    };
  }
  const authenticate = (
    value: unknown,
    expected = BY_CDHASH,
    os: MigrationHostOs = 'darwin',
  ): unknown => authenticateMigrationDestination(value, { os, expected });
  const fails = (reason: string): unknown => ({
    authenticated: false,
    refusal: 'refused',
    reason,
  });

  it('compiles the daemon requirement with its build binding', () => {
    const anchor =
      'anchor apple generic and certificate leaf[subject.OU]="ABCDE12345" and identifier "com.example.canopy.daemon"';
    expect(migrationDaemonRequirement(BY_CDHASH)).toBe(
      `${anchor} and cdhash H"${DAEMON_CDHASH}"`,
    );
    expect(migrationDaemonRequirement(BY_ENTITLEMENT)).toBe(
      `${anchor} and entitlement["com.example.canopy.build-id"] = "build-1"`,
    );
    expect(() =>
      migrationDaemonRequirement({
        ...BY_ENTITLEMENT,
        binding: { kind: 'entitlement', key: 'k"]', value: 'v' },
      }),
    ).toThrow(RangeError);
  });

  it('authenticates the spawned, unreaped, genuine daemon before any SafeStorage use', () => {
    expect(authenticate(destination())).toEqual({
      authenticated: true,
      daemon: {
        pid: DAEMON.pid,
        pidversion: DAEMON.pidversion,
        digest: DAEMON_CDHASH,
      },
    });
    expect(
      authenticate(destination({}, {}, BY_ENTITLEMENT), BY_ENTITLEMENT),
    ).toMatchObject({
      authenticated: true,
    });
  });

  it.each<
    [
      string,
      Partial<MigrationDarwinDestinationEvidence>,
      CaptureOverrides,
      string,
    ]
  >([
    [
      'an imposter identifier',
      {},
      { signing: { identifier: 'com.evil.daemon' } },
      'code:identifier',
    ],
    [
      'an imposter team',
      {},
      { signing: { teamId: 'ZZZZZ99999' } },
      'code:team',
    ],
    ['a no-runtime daemon', {}, { signing: { codeFlags: 0 } }, 'code:runtime'],
    [
      'another build (cdhash)',
      {},
      { signing: { cdhash: 'c'.repeat(40) } },
      'code:binding',
    ],
    [
      'an unsatisfied requirement',
      {},
      { requirement: { satisfied: false } },
      'code:requirement',
    ],
    [
      'a reaped child',
      { spawned: { ...DAEMON, unreaped: false } },
      {},
      'lineage:reaped',
    ],
    [
      'a peer that is not the child',
      {},
      { token: { pid: 6000, pidversion: 7 } },
      'lineage:not-spawned',
    ],
    [
      'an exec-self daemon',
      {},
      { token: { pid: DAEMON.pid, pidversion: 8 } },
      'lineage:pidversion',
    ],
    [
      'an exited daemon',
      { peer: { kind: 'peer-gone', errno: 'ENOTCONN' } },
      {},
      'peer:gone',
    ],
  ])('refuses %s', (_label, overrides, peer, reason) => {
    expect(authenticate(destination(overrides, peer))).toEqual(fails(reason));
  });

  it('refuses malformed evidence and is unavailable off macOS', () => {
    expect(authenticate({ ...destination(), pid: 1 })).toEqual(
      fails('malformed-evidence'),
    );
    expect(authenticate({ os: 'win32' })).toEqual(fails('os-mismatch'));
    for (const os of ['win32', 'linux'] as const)
      expect(authenticate(destination(), BY_CDHASH, os)).toEqual({
        authenticated: false,
        refusal: 'unavailable',
        os,
        reason: 'no-launch-primitive',
      });
  });
});

describe('migration admission: lineage', () => {
  it('admits only the process that launched this daemon, unreparented', () => {
    const r = rig();
    expect(r.admit(r.attach()).admitted).toBe(true);
    const moved = rig();
    const handle = moved.attach(evidence({ startupParentPid: 4000 }));
    expect(moved.admit(handle)).toEqual(refused('lineage:reparented'));
  });
});

describe('migration admission: flavor and second-source ambiguity (C-11, W6)', () => {
  it('a production daemon refuses the internal launcher, and the reverse', () => {
    const prod = rig();
    const internalLauncher = evidence({}, INTERNAL);
    expect(prod.admit(prod.attach(internalLauncher))).toEqual(
      refused('code:flavor'),
    );
    const internal = rig({ expected: INTERNAL });
    expect(internal.admit(internal.attach(evidence()))).toEqual(
      refused('code:flavor'),
    );
  });

  it('does not key on the .dev suffix: the internal flavor admits its own launcher', () => {
    const internal = rig({ expected: INTERNAL });
    const result = internal.admit(internal.attach(evidence({}, INTERNAL)));
    expect(result).toMatchObject({
      admitted: true,
      caller: { source: { flavorId: INTERNAL_ID, secureMode: 'internal' } },
    });
  });

  it('records the compiled source, so a slot past not_started for another source is refused', () => {
    const internal = rig({ expected: INTERNAL });
    const handle = admitted(internal, evidence({}, INTERNAL));
    internal.progress.set(SLOT, {
      state: 'imported_unverified',
      source: { flavorId: PROD_ID, secureMode: 'prod' },
    });
    expect(internal.registry.issue(handle, SLOT)).toEqual({
      issued: false,
      reason: 'second-source',
    });
    expect(internal.registry.issue(handle, 'linear-token').issued).toBe(true);
  });

  it('a second launcher of any flavor is ambiguity, and retires the first', () => {
    const r = rig();
    const first = admitted(r);
    const second = r.attach(evidence({}, INTERNAL));
    expect(r.admit(second)).toEqual(refused('ambiguity:second-channel'));
    expect(r.admission.port.channel(first)).toBeNull();
    expect(r.admit(r.attach())).toEqual(refused('ambiguity:second-channel'));
  });

  it("a refused first capture still uses up the daemon's one channel", () => {
    const r = rig();
    const spent = r.attach(evidence({ launched: false }));
    expect(r.admit(spent)).toEqual(refused('channel:not-launched'));
    expect(r.store.lookup(spent)).toBeNull();
    expect(r.admit(spent)).toEqual(refused('no-evidence'));
    expect(r.admit(r.attach())).toEqual(refused('ambiguity:second-channel'));
  });

  it('a launcher that exits before admission still spends the channel', () => {
    const r = rig();
    const gone = r.attach();
    r.admission.retire(gone);
    expect(r.admit(r.attach())).toEqual(refused('ambiguity:second-channel'));
  });

  type Reentry = (admission: MigrationAdmission, handle: object) => void;
  const REENTRIES: [string, Reentry][] = [
    ['ambiguity', (a): void => a.reportAmbiguity('elsewhere')],
    ['retirement', (a, handle): void => a.retire(handle)],
    ['close', (a): void => a.close()],
  ];

  /** Host facts whose `field` getter runs `act` the first time it is read. */
  function factsWithGetter(
    field: keyof MigrationHostFacts,
    act: () => void,
  ): MigrationHostFacts {
    const facts = { ...HOST };
    let pending = true;
    Object.defineProperty(facts, field, {
      enumerable: true,
      get: (): string => {
        if (pending) act();
        pending = false;
        return HOST[field];
      },
    });
    return facts;
  }

  /**
   * Runs `act` inside the host read numbered `at` (1: admission's): from the
   * host callback itself, or from a getter on `field` of the facts it returns.
   */
  function reentrant(
    at: number,
    act: Reentry,
    field?: keyof MigrationHostFacts,
  ): { readonly admission: MigrationAdmission; readonly handle: object } {
    const store = createMigrationEvidenceStore();
    const handle = store.attach(evidence());
    let reads = 0;
    const admission: MigrationAdmission = createMigrationAdmission({
      os: 'darwin',
      expected: PROD,
      evidence: store,
      host: (): MigrationHostFacts => {
        if (++reads !== at) return HOST;
        const run = (): void => act(admission, handle);
        if (field !== undefined) return factsWithGetter(field, run);
        run();
        return HOST;
      },
      missingPrerequisites: () => [],
      onAmbiguity: () => undefined,
    });
    return { admission, handle };
  }

  type Field = keyof MigrationHostFacts | undefined;
  type ReentryCase = [string, string, Reentry, Field];
  const FROM: [string, Field][] = [
    ['the host callback', undefined],
    ['a host field getter', 'authorityId'],
  ];
  const REENTRIES_FROM = FROM.flatMap(([from, field]) =>
    REENTRIES.map(([label, act]): ReentryCase => [label, from, act, field]),
  );

  it.each<ReentryCase>([
    ...REENTRIES_FROM,
    [
      'a nested admission',
      'the host callback',
      (a, handle): void => void a.admitMigrationConnection(handle),
      undefined,
    ],
  ])(
    '%s raised from %s during admission refuses it',
    (_label, _from, act, field) => {
      const { admission, handle } = reentrant(1, act, field);
      expect(admission.admitMigrationConnection(handle)).toEqual(
        refused('ambiguity:during-admission'),
      );
      expect(admission.port.channel(handle)).toBeNull();
    },
  );

  it.each(MIGRATION_HOST_FIELDS)(
    'ambiguity raised by the %s getter during admission refuses it',
    (field) => {
      const { admission, handle } = reentrant(
        1,
        (a) => a.reportAmbiguity('getter-reentry'),
        field,
      );
      expect(admission.admitMigrationConnection(handle)).toEqual(
        refused('ambiguity:during-admission'),
      );
      expect(admission.port.channel(handle)).toBeNull();
    },
  );

  it.each(REENTRIES_FROM)(
    '%s raised from %s in the channel check retires the channel',
    (_label, _from, act, field) => {
      const { admission, handle } = reentrant(2, act, field);
      expect(admission.admitMigrationConnection(handle).admitted).toBe(true);
      expect(admission.port.channel(handle)).toBeNull();
      expect(admission.port.channel(handle)).toBeNull();
    },
  );

  it.each(REENTRIES_FROM)(
    '%s raised from %s in the port host read fails it closed',
    (_label, _from, act, field) => {
      const { admission, handle } = reentrant(2, act, field);
      expect(admission.admitMigrationConnection(handle).admitted).toBe(true);
      expect(() => admission.port.host()).toThrow();
      expect(() => admission.port.host()).toThrow();
      expect(admission.port.channel(handle)).toBeNull();
    },
  );

  it('the port has no host facts without a live channel', () => {
    const r = rig();
    expect(() => r.admission.port.host()).toThrow();
    const handle = admitted(r);
    expect(r.admission.port.host()).toEqual(HOST);
    expect(Object.isFrozen(r.admission.port.host())).toBe(true);
    r.admission.retire(handle);
    expect(() => r.admission.port.host()).toThrow();
  });

  type RigReentry = (r: Rig, handle: object) => void;
  const RELEASE_REENTRIES: [string, RigReentry][] = [
    ['ambiguity', (r): void => r.admission.reportAmbiguity('during-release')],
    ['retirement', (r, handle): void => r.admission.retire(handle)],
    ['close', (r): void => r.admission.close()],
  ];
  // mayRelease reads the host three times: in the channel check, directly,
  // then in the last channel check.
  const RELEASE_READS: [string, number][] = [
    ['the channel check', 0],
    ['the port host read', 1],
    ['the last channel check', 2],
  ];

  it.each(
    RELEASE_REENTRIES.flatMap(([label, act]) =>
      RELEASE_READS.map(
        ([read, skip]): [string, string, RigReentry, number] => [
          label,
          read,
          act,
          skip,
        ],
      ),
    ),
  )(
    '%s raised from %s during mayRelease blocks the release',
    (_label, _read, act, skip) => {
      const r = rig();
      const handle = admitted(r);
      const s = offer(r, handle);
      const seen: { released: boolean | null } = { released: null };
      const consumed = r.registry.consume(
        s.id,
        s.present(),
        (ctx) => {
          r.onHostRead(() => act(r, handle), skip);
          seen.released = ctx.mayRelease();
          return new Promise<never>(() => undefined);
        },
        anyValue,
      );
      expect(consumed.accepted).toBe(true);
      expect(seen.released).toBe(false);
      expect(r.registry.get(s.id)?.released).toBe(false);
      expect(r.admission.port.channel(handle)).toBeNull();
    },
  );

  // The host has not (yet) told the registry: only admission knows.
  it.each(RELEASE_REENTRIES)(
    '%s in admission alone, raised from the source read in mayRelease, blocks the release',
    async (_label, act) => {
      const r = rig({ forwardAmbiguity: false });
      const handle = admitted(r);
      const s = offer(r, handle);
      const value = new TextEncoder().encode('ghp_secret');
      // Presentation reads the generation once; mayRelease reads it next.
      r.onGenerationRead(() => act(r, handle), 1);
      const result = r.registry.importSlot(s.id, s.present(), value);
      if (!result.accepted) throw new Error(`refused: ${result.reason}`);
      expect((await result.outcome).state).toBe('revoked');
      expect(r.registry.get(s.id)).toMatchObject({
        released: false,
        terminalTransitions: 1,
      });
      expect(r.imports).toEqual([]);
      expect(value.every((byte) => byte === 0)).toBe(true);
      expect(r.admission.port.channel(handle)).toBeNull();
    },
  );

  it.each(RELEASE_REENTRIES)(
    '%s in admission alone, raised from the source read in presentation, refuses it',
    (_label, act) => {
      const r = rig({ forwardAmbiguity: false });
      const handle = admitted(r);
      const s = offer(r, handle);
      const value = new TextEncoder().encode('ghp_secret');
      r.onGenerationRead(() => act(r, handle));
      expect(r.registry.importSlot(s.id, s.present(), value)).toEqual({
        accepted: false,
        reason: 'no-native-evidence',
      });
      expect(r.registry.get(s.id)).toMatchObject({
        state: 'revoked',
        released: false,
      });
      expect(r.imports).toEqual([]);
      expect(value.every((byte) => byte === 0)).toBe(true);
    },
  );

  it.each(RELEASE_REENTRIES)(
    '%s in admission alone, raised from the source read during issue, refuses the issue',
    (_label, act) => {
      const r = rig({ forwardAmbiguity: false });
      const handle = admitted(r);
      r.onGenerationRead(() => act(r, handle));
      expect(r.registry.issue(handle, SLOT)).toEqual({
        issued: false,
        reason: 'ambiguity:during-issue',
      });
    },
  );

  it('reportAmbiguity retires the admitted channel and notifies the host', () => {
    const r = rig();
    const handle = admitted(r);
    r.admission.reportAmbiguity('reparented-after-admission');
    expect(r.ambiguities).toEqual(['reparented-after-admission']);
    expect(r.admission.port.channel(handle)).toBeNull();
  });
});

describe('migration admission: product child or attacker acting as launcher (W1)', () => {
  it('refuses a product child on the genuine main channel (lineage)', () => {
    const r = rig();
    const child = { pid: 6001, pidversion: 1 };
    const handle = r.attach(
      evidence({ peer: launcherCapture({ token: child }) }),
    );
    expect(r.admit(handle)).toEqual(refused('lineage:not-parent'));
  });

  it('limit (i): a child that launches its own daemon is admitted there, bound to that daemon only', () => {
    // A product child that spawns its own daemon is that daemon's parent and
    // carries the same signature: admission cannot tell it from main (W1).
    const child = { pid: 6001, pidversion: 1 };
    const own = rig();
    own.setHost({ coreIncarnation: 'core-inc-child' });
    const handle = admitted(
      own,
      evidence({
        startupParentPid: child.pid,
        captureParentPid: child.pid,
        peer: launcherCapture({ token: child }),
      }),
    );
    expect(own.admission.port.channel(handle)).toMatchObject({
      launcher: { os: 'darwin', ...child },
      admittedHost: { coreIncarnation: 'core-inc-child' },
    });
    const genuine = rig();
    expect(genuine.admission.port.channel(handle)).toBeNull();
  });
});

describe('migration admission: per-OS unavailable (C-4)', () => {
  it.each(['win32', 'linux'] as const)(
    '%s returns a typed unavailable refusal',
    (os) => {
      const r = rig({ os });
      for (const value of [evidence(), { os }])
        expect(r.admit(r.attach(value))).toEqual({
          admitted: false,
          refusal: 'unavailable',
          os,
          reason: 'no-launch-primitive',
        });
      expect(r.admit({})).toMatchObject({ refusal: 'unavailable' });
      expect(r.admission.port.channel(r.attach())).toBeNull();
      expect(r.registry.issue(r.attach(), SLOT)).toEqual({
        issued: false,
        reason: 'no-native-evidence',
      });
      expect(r.ambiguities).toEqual([]);
    },
  );

  it('a darwin daemon refuses evidence captured for another OS', () => {
    const r = rig();
    expect(r.admit(r.attach({ os: 'win32' }))).toEqual(refused('os-mismatch'));
  });
});
