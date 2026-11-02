import { randomBytes } from 'node:crypto';

import {
  MIGRATION_SIGNING_PATTERNS,
  readMigrationDestinationEvidence,
  type MigrationDarwinLauncherEvidence,
  type MigrationEvidenceStore,
  type MigrationPeerCapture,
} from './migration-evidence';
import {
  MIGRATION_HOST_FIELDS,
  MIGRATION_LAUNCHER_TRANSPORT,
  type MigrationAdmissionPort,
  type MigrationChannelFacts,
  type MigrationHostFacts,
  type MigrationHostOs,
  type MigrationSourceIdentity,
} from './migration-ports';

/*
 * Migration admission from native evidence (CAN-4504 VA-2, plan §3.2–3.5).
 * VA-6b serves this in qualification only; production is disabled. The daemon admits
 * at most one channel, its fd 3, and only for the launcher of its own flavor
 * (C-11). Any doubt refuses and is reported as ambiguity (R-6). The published
 * endpoint's `callerFor` is untouched: endpoint connections have no evidence.
 */

/** `CS_RUNTIME`: the hardened runtime. */
export const MIGRATION_LAUNCHER_RUNTIME_FLAG = 0x10000;

const SECURE_MODE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ENTITLEMENT_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LAUNCHD_PID = 1;

/** The daemon's own flavor, compiled into the daemon (C-11). */
export interface MigrationLauncherExpectation {
  readonly teamId: string;
  /** `brand.appId` for this flavor; a `.dev` suffix is not special (W6). */
  readonly flavorId: string;
  readonly secureMode: string;
  readonly buildId: string;
}

export interface MigrationDaemonExpectation {
  readonly teamId: string;
  readonly identifier: string;
  /** §3.2.5: a custom entitlement (preferred) or the embedded daemon cdhash. */
  readonly binding:
    | {
        readonly kind: 'entitlement';
        readonly key: string;
        readonly value: string;
      }
    | { readonly kind: 'cdhash'; readonly cdhash: string };
}

/** The constant principal for one admitted launcher channel (§3.3). */
export interface MigrationCaller extends MigrationChannelFacts {
  readonly principal: 'migration-launcher';
}

type PeerRefusal =
  | 'peer:gone'
  | 'peer:capture-failed'
  | 'lineage:pidversion'
  | 'code:team'
  | 'code:requirement'
  | 'code:runtime'
  | 'code:static-check';

export type MigrationAdmissionRefusal =
  | PeerRefusal
  | 'closed'
  | 'no-evidence'
  | 'already-admitted'
  | 'malformed-evidence'
  | 'os-mismatch'
  | 'prerequisite-missing'
  | 'host-unavailable'
  | 'host:buildId'
  | 'ambiguity:second-channel'
  | 'ambiguity:during-admission'
  | 'channel:not-launched'
  | 'channel:none'
  | 'channel:fd3-type'
  | 'channel:fd3-inheritable'
  | 'lineage:reparented'
  | 'lineage:not-parent'
  | 'code:flavor'
  | 'code:build';

export type MigrationDestinationRefusal =
  | PeerRefusal
  | 'malformed-evidence'
  | 'os-mismatch'
  | 'lineage:reaped'
  | 'lineage:not-spawned'
  | 'code:identifier'
  | 'code:binding';

/** Windows and Linux cannot launch the daemon at the pin (C-4; VA-W, VA-L). */
export interface MigrationUnavailable {
  readonly refusal: 'unavailable';
  readonly os: Exclude<MigrationHostOs, 'darwin'>;
  readonly reason: 'no-launch-primitive';
}

export type MigrationAdmissionResult =
  | { readonly admitted: true; readonly caller: MigrationCaller }
  | {
      readonly admitted: false;
      readonly refusal: 'refused';
      readonly reason: MigrationAdmissionRefusal;
    }
  | ({ readonly admitted: false } & MigrationUnavailable);

export type MigrationDestinationResult =
  | {
      readonly authenticated: true;
      readonly daemon: {
        readonly pid: number;
        readonly pidversion: number;
        readonly digest: string;
      };
    }
  | {
      readonly authenticated: false;
      readonly refusal: 'refused';
      readonly reason: MigrationDestinationRefusal;
    }
  | ({ readonly authenticated: false } & MigrationUnavailable);

export interface MigrationAdmissionOptions {
  /** Supplied by the host; this package reads no platform. */
  readonly os: MigrationHostOs;
  readonly expected: MigrationLauncherExpectation;
  readonly evidence: MigrationEvidenceStore;
  readonly host: () => MigrationHostFacts;
  /** VA-3 injection closure and CAN-4507 entitlements; any entry refuses. */
  readonly missingPrerequisites: () => readonly string[];
  /** R-6: the host forwards this to the session registry's `reportAmbiguity`. */
  readonly onAmbiguity: (reason: string) => void;
}

export interface MigrationAdmission {
  /** Returns the channel's `MigrationCaller` or a typed refusal. Once per handle. */
  admitMigrationConnection(handle: object): MigrationAdmissionResult;
  /** For the session registry: facts only for the live admitted channel. */
  readonly port: MigrationAdmissionPort;
  /**
   * Launcher exit, before or after admission: either way the daemon's one
   * channel is spent. The host also ends the channel's sessions.
   */
  retire(handle: object): void;
  /** Ambiguity found after admission: retires the channel and notifies. */
  reportAmbiguity(reason: string): void;
  close(): void;
}

type Captured = Extract<MigrationPeerCapture, { readonly kind: 'captured' }>;

interface LiveChannel {
  readonly handle: object;
  readonly caller: MigrationCaller;
}

function checked(name: string, value: string, pattern: RegExp): string {
  if (!pattern.test(value) || value.length > 255)
    throw new RangeError(`Invalid migration ${name}.`);
  return value;
}

function anchor(teamId: string, identifier: string): string {
  const team = checked('team id', teamId, MIGRATION_SIGNING_PATTERNS.teamId);
  const id = checked(
    'identifier',
    identifier,
    MIGRATION_SIGNING_PATTERNS.identifier,
  );
  return `anchor apple generic and certificate leaf[subject.OU]="${team}" and identifier "${id}"`;
}

/** §3.2.4. Patterns keep every interpolated value free of quotes. */
export function migrationLauncherRequirement(
  expected: MigrationLauncherExpectation,
): string {
  const build = checked(
    'build id',
    expected.buildId,
    MIGRATION_SIGNING_PATTERNS.buildId,
  );
  return `${anchor(expected.teamId, expected.flavorId)} and info[CanopyBuildId]="${build}"`;
}

/** §3.2.3: what Electron main requires of the daemon it spawned. */
export function migrationDaemonRequirement(
  expected: MigrationDaemonExpectation,
): string {
  const base = anchor(expected.teamId, expected.identifier);
  const { binding } = expected;
  if (binding.kind === 'cdhash')
    return `${base} and cdhash H"${checked('cdhash', binding.cdhash, MIGRATION_SIGNING_PATTERNS.cdhash)}"`;
  const key = checked('entitlement key', binding.key, ENTITLEMENT_KEY);
  const value = checked(
    'entitlement value',
    binding.value,
    MIGRATION_SIGNING_PATTERNS.buildId,
  );
  return `${base} and entitlement["${key}"] = "${value}"`;
}

/** Host reads fail closed: a throwing read is unavailable. */
function read<T>(get: () => T): { readonly value: T } | null {
  try {
    return { value: get() };
  } catch {
    return null;
  }
}

function unavailableOn(os: MigrationHostOs): MigrationUnavailable | null {
  return os === 'darwin'
    ? null
    : Object.freeze({
        refusal: 'unavailable',
        os,
        reason: 'no-launch-primitive',
      });
}

function capturedPeer(
  peer: MigrationPeerCapture,
): Captured | 'peer:gone' | 'peer:capture-failed' {
  if (peer.kind === 'peer-gone') return 'peer:gone';
  if (peer.kind === 'capture-failed') return 'peer:capture-failed';
  return peer;
}

/** The code check must name the instance that holds the token: no exec since. */
function sameInstance(peer: Captured): boolean {
  return (
    peer.codeToken.pid === peer.token.pid &&
    peer.codeToken.pidversion === peer.token.pidversion
  );
}

/** The native verdict counts only for the requirement this side compiled. */
function verdict(
  peer: Captured,
  requirement: string,
): 'code:requirement' | 'code:runtime' | 'code:static-check' | null {
  if (!peer.requirement.satisfied || peer.requirement.text !== requirement)
    return 'code:requirement';
  if ((peer.signing.codeFlags & MIGRATION_LAUNCHER_RUNTIME_FLAG) === 0)
    return 'code:runtime';
  return peer.staticCheck === 'failed' ? 'code:static-check' : null;
}

function channelRefusal(
  evidence: MigrationDarwinLauncherEvidence,
): MigrationAdmissionRefusal | null {
  if (!evidence.launched) return 'channel:not-launched';
  if (evidence.fd3 === null) return 'channel:none';
  if (evidence.fd3.family !== 'AF_UNIX' || evidence.fd3.type !== 'SOCK_STREAM')
    return 'channel:fd3-type';
  return evidence.fd3CloexecAtStartup ? null : 'channel:fd3-inheritable';
}

/** §3.2.4 lineage and code identity for the process on fd 3. */
function launcherRefusal(
  evidence: MigrationDarwinLauncherEvidence,
  expected: MigrationLauncherExpectation,
  requirement: string,
): Captured | MigrationAdmissionRefusal {
  const channel = channelRefusal(evidence);
  if (channel !== null) return channel;
  const peer = capturedPeer(evidence.peer);
  if (typeof peer === 'string') return peer;
  const parent = evidence.captureParentPid;
  if (parent !== evidence.startupParentPid || parent === LAUNCHD_PID)
    return 'lineage:reparented';
  if (peer.token.pid !== parent) return 'lineage:not-parent';
  if (!sameInstance(peer)) return 'lineage:pidversion';
  if (peer.signing.teamId !== expected.teamId) return 'code:team';
  if (peer.signing.identifier !== expected.flavorId) return 'code:flavor';
  if (peer.signing.buildId !== expected.buildId) return 'code:build';
  return verdict(peer, requirement) ?? peer;
}

function hostCopy(facts: MigrationHostFacts): MigrationHostFacts {
  return Object.freeze({
    authorityId: facts.authorityId,
    coreAuthority: facts.coreAuthority,
    coreIncarnation: facts.coreIncarnation,
    coreDigest: facts.coreDigest,
    buildId: facts.buildId,
    packageDigest: facts.packageDigest,
    updateEpoch: facts.updateEpoch,
  });
}

function launcherExpectation(
  expected: MigrationLauncherExpectation,
): MigrationLauncherExpectation {
  checked('secure mode', expected.secureMode, SECURE_MODE);
  migrationLauncherRequirement(expected);
  return Object.freeze({
    teamId: expected.teamId,
    flavorId: expected.flavorId,
    secureMode: expected.secureMode,
    buildId: expected.buildId,
  });
}

export function createMigrationAdmission(
  options: MigrationAdmissionOptions,
): MigrationAdmission {
  const { evidence } = options;
  const expected = launcherExpectation(options.expected);
  const requirement = migrationLauncherRequirement(expected);
  const source: MigrationSourceIdentity = Object.freeze({
    flavorId: expected.flavorId,
    secureMode: expected.secureMode,
  });
  const unavailable = unavailableOn(options.os);
  let live: LiveChannel | null = null;
  /** The daemon has one fd 3: once any capture is judged, no other is. */
  let judged = false;
  let closed = false;
  /** Bumped by every `retireLive`: ambiguity, retire, close and R-8. */
  let epoch = 0;

  /** Copied inside the guarded read, so field getters run before any check. */
  const hostFacts = (): MigrationHostFacts => hostCopy(options.host());

  const retireLive = (): void => {
    epoch += 1;
    if (live === null) return;
    evidence.retire(live.handle);
    live = null;
  };

  const ambiguity = (reason: string): void => {
    judged = true;
    retireLive();
    read(() => options.onAmbiguity(reason));
  };

  const refuse = (
    reason: MigrationAdmissionRefusal,
  ): MigrationAdmissionResult =>
    Object.freeze({ admitted: false, refusal: 'refused', reason });

  const judge = (
    handle: object,
    captured: MigrationDarwinLauncherEvidence | null,
  ): MigrationAdmissionResult => {
    judged = true;
    const start = epoch;
    if (captured === null) return refuseAmbiguous(handle, 'malformed-evidence');
    const missing = read(() => options.missingPrerequisites().length);
    if (missing === null || missing.value > 0)
      return refuseAmbiguous(handle, 'prerequisite-missing');
    const facts = read(hostFacts);
    if (facts === null) return refuseAmbiguous(handle, 'host-unavailable');
    if (facts.value.buildId !== expected.buildId)
      return refuseAmbiguous(handle, 'host:buildId');
    const peer = launcherRefusal(captured, expected, requirement);
    if (typeof peer === 'string') return refuseAmbiguous(handle, peer);
    // A host read above may have re-entered: ambiguity, retirement or close.
    if (epoch !== start || evidence.lookup(handle) === null)
      return refuseAmbiguous(handle, 'ambiguity:during-admission');
    const caller: MigrationCaller = Object.freeze({
      principal: 'migration-launcher',
      transport: MIGRATION_LAUNCHER_TRANSPORT,
      channelId: randomBytes(16).toString('hex'),
      launcher: Object.freeze({
        pid: peer.token.pid,
        pidversion: peer.token.pidversion,
      }),
      launcherDigest: peer.signing.cdhash,
      source,
      admittedHost: facts.value,
    });
    live = { handle, caller };
    return Object.freeze({ admitted: true, caller });
  };

  /** A refused capture is spent: its handle never admits later. */
  const refuseAmbiguous = (
    handle: object,
    reason: MigrationAdmissionRefusal,
  ): MigrationAdmissionResult => {
    evidence.retire(handle);
    ambiguity(reason);
    return refuse(reason);
  };

  const admitMigrationConnection = (
    handle: object,
  ): MigrationAdmissionResult => {
    if (unavailable !== null)
      return Object.freeze({ admitted: false, ...unavailable });
    if (closed) return refuse('closed');
    const entry = evidence.lookup(handle);
    if (entry === null) return refuse('no-evidence');
    if (live?.handle === handle) return refuse('already-admitted');
    if (judged) return refuseAmbiguous(handle, 'ambiguity:second-channel');
    const captured = entry.evidence;
    if (captured !== null && captured.os !== 'darwin')
      return refuseAmbiguous(handle, 'os-mismatch');
    return judge(handle, captured);
  };

  /**
   * R-8: a package or update change since admission retires the channel, as
   * does the transport retiring the handle in the store.
   */
  const channel = (handle: object): MigrationChannelFacts | null => {
    if (unavailable !== null || closed || live?.handle !== handle) return null;
    const admitted = live.caller;
    if (evidence.lookup(handle) === null) {
      retireLive();
      return null;
    }
    const current = read(hostFacts);
    if (
      live?.handle !== handle ||
      current === null ||
      MIGRATION_HOST_FIELDS.some(
        (field) => current.value[field] !== admitted.admittedHost[field],
      )
    ) {
      retireLive();
      return null;
    }
    return admitted;
  };

  /**
   * Throws, which the registry treats as an unreadable host, unless a channel
   * is live and stays live through the read: a re-entrant retire, close or
   * ambiguity must not leave facts that authorize issue or release.
   */
  const host = (): MigrationHostFacts => {
    const start = epoch;
    if (closed || live === null)
      throw new Error('No admitted migration channel.');
    const current = hostFacts();
    if (epoch !== start)
      throw new Error('Migration channel retired during the host read.');
    return current;
  };

  return Object.freeze({
    admitMigrationConnection,
    port: Object.freeze({ channel, host }),
    retire(handle: object): void {
      if (evidence.lookup(handle) !== null) judged = true;
      if (live?.handle === handle) retireLive();
      else evidence.retire(handle);
    },
    reportAmbiguity: ambiguity,
    close(): void {
      closed = true;
      retireLive();
    },
  });
}

/**
 * R-12, topology L: Electron main authenticates the daemon it spawned before
 * any SafeStorage use. Inert until VA-4 wires the launcher side.
 */
export function authenticateMigrationDestination(
  capture: unknown,
  options: {
    readonly os: MigrationHostOs;
    readonly expected: MigrationDaemonExpectation;
  },
): MigrationDestinationResult {
  const requirement = migrationDaemonRequirement(options.expected);
  const unavailable = unavailableOn(options.os);
  if (unavailable !== null)
    return Object.freeze({ authenticated: false, ...unavailable });
  const peer = destinationRefusal(capture, options.expected, requirement);
  if (typeof peer === 'string')
    return Object.freeze({
      authenticated: false,
      refusal: 'refused',
      reason: peer,
    });
  return Object.freeze({
    authenticated: true,
    daemon: Object.freeze({
      pid: peer.token.pid,
      pidversion: peer.token.pidversion,
      digest: peer.signing.cdhash,
    }),
  });
}

function destinationRefusal(
  capture: unknown,
  expected: MigrationDaemonExpectation,
  requirement: string,
): Captured | MigrationDestinationRefusal {
  const evidence = readMigrationDestinationEvidence(capture);
  if (evidence === null) return 'malformed-evidence';
  if (evidence.os !== 'darwin') return 'os-mismatch';
  const { spawned } = evidence;
  if (!spawned.unreaped) return 'lineage:reaped';
  const peer = capturedPeer(evidence.peer);
  if (typeof peer === 'string') return peer;
  if (peer.token.pid !== spawned.pid) return 'lineage:not-spawned';
  if (peer.token.pidversion !== spawned.pidversion || !sameInstance(peer))
    return 'lineage:pidversion';
  if (peer.signing.teamId !== expected.teamId) return 'code:team';
  if (peer.signing.identifier !== expected.identifier) return 'code:identifier';
  const { binding } = expected;
  if (binding.kind === 'cdhash' && peer.signing.cdhash !== binding.cdhash)
    return 'code:binding';
  return verdict(peer, requirement) ?? peer;
}
