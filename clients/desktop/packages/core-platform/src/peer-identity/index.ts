import path from 'node:path';
import type { PlatformOperatingSystem } from '@canopy/core-runtime';
import {
  type ByteChannel,
  type ChannelPeer,
  channelPeer,
  createPolledChannel,
  type OwnedChildChannel,
} from '../supervision/owned-child';

/**
 * Launcher-channel peer evidence (CAN-4504 §3.1–3.2). Darwin only;
 * production migration serving remains disabled. Host-only: never exposed over
 * IPC, preload, renderer, Portal, tools, agent actions, or remote control.
 */

/** Built from `packages/core-platform/native/peer-identity`; not staged yet. */
export const PEER_IDENTITY_FILE = 'core-peer-identity.node';

export type PeerIdentityErrorCode =
  | 'capability_unavailable'
  | 'invalid_argument'
  | 'failed_precondition'
  | 'unavailable';

/** Fixed messages only: no paths, requirements, or peer details. */
export class PeerIdentityError extends Error {
  override readonly name = 'PeerIdentityError';
  readonly code: PeerIdentityErrorCode;

  constructor(code: PeerIdentityErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Why a channel or its peer was refused. Every ambiguity refuses. */
export type PeerRefusalReason =
  | 'no_channel'
  | 'wrong_channel_type'
  | 'reparented'
  | 'no_frame'
  | 'not_connected'
  | 'not_running'
  | 'pid_mismatch'
  | 'pidversion_changed'
  | 'code_unavailable'
  | 'requirement_unsatisfied'
  | 'runtime_missing';

const REFUSALS: readonly PeerRefusalReason[] = [
  'no_channel',
  'wrong_channel_type',
  'reparented',
  'no_frame',
  'not_connected',
  'not_running',
  'pid_mismatch',
  'pidversion_changed',
  'code_unavailable',
  'requirement_unsatisfied',
  'runtime_missing',
];

/** Module-private: no other module can write a requirement literal. */
const ISSUED: unique symbol = Symbol('peer-identity requirement');

/**
 * A code requirement built here from validated parts; never free text. Each
 * capture accepts only its own role, checked again at runtime.
 */
interface CodeRequirement<Role extends PeerEvidence['role']> {
  readonly [ISSUED]: Role;
  readonly role: Role;
  readonly text: string;
}

/** What the daemon requires of its launcher. */
export type LauncherRequirement = CodeRequirement<'launcher'>;

/** What Electron main requires of the daemon it spawned. */
export type DaemonRequirement = CodeRequirement<'daemon'>;

/** Flavor-correct identity of the exact-build Electron main executable. */
export interface LauncherIdentity {
  readonly team: string;
  /** `brand.appId` for the flavor. */
  readonly identifier: string;
  /** Matched against the signed `CanopyBuildId` Info.plist key. */
  readonly buildId: string;
}

/** Binds the daemon to its build: a custom entitlement, or its cdhash. */
export type DaemonBuildBinding =
  | {
      readonly kind: 'entitlement';
      readonly key: string;
      readonly value: string;
    }
  | { readonly kind: 'cdhash'; readonly cdhash: string };

export interface DaemonIdentity {
  readonly team: string;
  readonly identifier: string;
  readonly build: DaemonBuildBinding;
}

/** Host-only; kept in a WeakMap, never serialized or sent anywhere. */
export interface PeerEvidence {
  readonly role: 'launcher' | 'daemon';
  readonly pid: number;
  readonly pidversion: number;
}

export type EvidenceCapture =
  | { readonly ok: true; readonly evidence: PeerEvidence }
  | { readonly ok: false; readonly reason: PeerRefusalReason };

/** The daemon's end of the launcher channel (fd 3). */
export type LauncherChannel = ByteChannel;

export type LauncherChannelClaim =
  | { readonly ok: true; readonly channel: LauncherChannel }
  | { readonly ok: false; readonly reason: PeerRefusalReason };

export interface PeerIdentityServices {
  /**
   * Daemon startup only, before any spawn: sets CLOEXEC on fd 3 and checks it
   * is a socketpair end. One attempt per process; a second one throws.
   */
  claimLauncherChannel(): LauncherChannelClaim;
  /**
   * Daemon: after the launcher's first frame. The peer must be the parent
   * that launched it, unchanged since the claim, satisfying `requirement`
   * with the hardened runtime. One capture per channel; there is no recheck.
   */
  captureLauncherEvidence(
    channel: LauncherChannel,
    requirement: LauncherRequirement,
  ): EvidenceCapture;
  /**
   * Electron main: after the daemon's first frame. The peer must be the
   * spawned, unreaped root, unchanged since spawn, satisfying `requirement`
   * with the hardened runtime. One capture per channel; there is no recheck.
   */
  captureDaemonEvidence(
    channel: OwnedChildChannel,
    requirement: DaemonRequirement,
  ): EvidenceCapture;
}

const UNSUPPORTED = 'Peer identity is unavailable on this host.';
const INVALID = 'Peer identity request is invalid.';
const CAPTURED = 'Peer evidence was already captured for this channel.';
const CLAIMED = 'Launcher channel was already claimed.';
const CLOSED = 'Launcher channel is closed.';
const BUSY = 'Launcher channel is already in use.';

const fail = (
  code: PeerIdentityErrorCode,
  message: string,
): PeerIdentityError => new PeerIdentityError(code, message);

const TEAM = /^[A-Z0-9]{10}$/;
const IDENTIFIER = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,253}[A-Za-z0-9])?$/;
const VALUE = /^[A-Za-z0-9._-]{1,128}$/;
const CDHASH = /^[0-9a-f]{40}$/;

/** The role each requirement was built for; the only proof it was built here. */
const issued = new WeakMap<object, PeerEvidence['role']>();

function requirement<Role extends PeerEvidence['role']>(
  role: Role,
  team: string,
  identifier: string,
  binding: string,
  compact = false,
): CodeRequirement<Role> {
  if (!TEAM.test(team) || !IDENTIFIER.test(identifier))
    throw fail('invalid_argument', INVALID);
  const value: CodeRequirement<Role> = Object.freeze({
    [ISSUED]: role,
    role,
    text: `anchor apple generic and certificate leaf[subject.OU]${compact ? '=' : ' = '}"${team}" and identifier "${identifier}" and ${binding}`,
  });
  issued.set(value, role);
  return value;
}

function cdhashBinding(cdhash: unknown): string {
  const lower = typeof cdhash === 'string' ? cdhash.toLowerCase() : '';
  if (!CDHASH.test(lower)) throw fail('invalid_argument', INVALID);
  return `cdhash H"${lower}"`;
}

/** Developer ID, team, flavor identifier, and the signed build id. */
export function launcherRequirement(
  identity: LauncherIdentity,
  /** VA-2 uses the compact, exact requirement text in its captured-evidence contract. */
  compact = false,
): LauncherRequirement {
  const { team, identifier, buildId } = identity;
  if (typeof buildId !== 'string' || !VALUE.test(buildId))
    throw fail('invalid_argument', INVALID);
  return requirement(
    'launcher',
    team,
    identifier,
    `info[CanopyBuildId]${compact ? '=' : ' = '}"${buildId}"`,
    compact,
  );
}

/** Developer ID, team, identifier, and the daemon's build binding. */
export function daemonRequirement(
  identity: DaemonIdentity,
  compact = false,
): DaemonRequirement {
  const { team, identifier, build } = identity;
  if (build.kind === 'entitlement') {
    if (!IDENTIFIER.test(build.key) || !VALUE.test(build.value))
      throw fail('invalid_argument', INVALID);
    return requirement(
      'daemon',
      team,
      identifier,
      `entitlement["${build.key}"] = "${build.value}"`,
      compact,
    );
  }
  return requirement(
    'daemon',
    team,
    identifier,
    cdhashBinding(build.cdhash),
    compact,
  );
}

/** The native addon. Results are `unknown` and validated here. */
interface PeerIdentityNative {
  claimLauncherChannel(): unknown;
  channelRead(handle: object, max: number): unknown;
  channelWrite(handle: object, bytes: Uint8Array): unknown;
  channelClose(handle: object): unknown;
  launcherEvidence(handle: object, requirement: string): unknown;
  checkGuest(token: Buffer, requirement: string): unknown;
  captureGuest?(token: Buffer, requirement: string): unknown;
}

const METHODS = [
  'claimLauncherChannel',
  'channelRead',
  'channelWrite',
  'channelClose',
  'launcherEvidence',
  'checkGuest',
];

const field = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined;

function isNative(value: unknown): value is PeerIdentityNative {
  return METHODS.every((method) => typeof field(value, method) === 'function');
}

function loadNative(file: string): PeerIdentityNative {
  const module = { exports: {} };
  if (!path.isAbsolute(file)) throw fail('capability_unavailable', UNSUPPORTED);
  try {
    process.dlopen(module, file);
  } catch {
    throw fail('capability_unavailable', UNSUPPORTED);
  }
  if (!isNative(module.exports))
    throw fail('capability_unavailable', UNSUPPORTED);
  return module.exports;
}

const NATIVE_ERRORS: Readonly<
  Record<string, readonly [PeerIdentityErrorCode, string]>
> = {
  ERR_PEER_IDENTITY_ARGUMENT: ['invalid_argument', INVALID],
  ERR_PEER_IDENTITY_CLAIMED: ['failed_precondition', CLAIMED],
  ERR_PEER_IDENTITY_CHANNEL: ['unavailable', CLOSED],
};

/** A fixed typed error for a native one. */
function mapError(error: unknown): PeerIdentityError {
  const code = field(error, 'code');
  const mapped = typeof code === 'string' ? NATIVE_ERRORS[code] : undefined;
  return fail(...(mapped ?? ['unavailable', UNSUPPORTED]));
}

/** Runs a native call, replacing its error with a fixed typed one. */
function call(run: () => unknown): unknown {
  try {
    return run();
  } catch (error) {
    throw mapError(error);
  }
}

function refusal(value: unknown): PeerRefusalReason | undefined {
  if (field(value, 'state') !== 'refused') return undefined;
  const reason = field(value, 'reason');
  const known = REFUSALS.find((item) => item === reason);
  if (!known) throw fail('unavailable', UNSUPPORTED);
  return known;
}

const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value);

/** Evidence by channel: the only record of an accepted peer. */
const evidence = new WeakMap<ByteChannel, PeerEvidence>();
const attempted = new WeakSet<ByteChannel>();
const captures = new WeakMap<ByteChannel, unknown>();

/** Actual native snapshot for admission; no expected identity fields are substituted. */
export function peerCaptureFor(channel: ByteChannel): unknown {
  return captures.get(channel);
}

/** The evidence captured for `channel`, if its peer was accepted. */
export function peerEvidenceFor(
  channel: ByteChannel,
): PeerEvidence | undefined {
  return evidence.get(channel);
}

/**
 * The text of a requirement built here for `role`. Anything else, including
 * a copy, a proxy, or the other role's requirement, is refused before any of
 * its properties are read, and before the channel's attempt is spent.
 */
function requirementText(value: unknown, role: PeerEvidence['role']): string {
  if (typeof value !== 'object' || value === null || issued.get(value) !== role)
    throw fail('invalid_argument', INVALID);
  const text = field(value, 'text');
  if (typeof text !== 'string') throw fail('invalid_argument', INVALID);
  return text;
}

/** Marks the one capture attempt a channel gets, accepted or refused. */
function spend(channel: ByteChannel): void {
  if (attempted.has(channel)) throw fail('failed_precondition', CAPTURED);
  attempted.add(channel);
}

function accept(
  channel: ByteChannel,
  role: PeerEvidence['role'],
  pid: unknown,
  pidversion: unknown,
): EvidenceCapture {
  if (!integer(pid) || pid <= 1 || !integer(pidversion))
    throw fail('unavailable', UNSUPPORTED);
  const accepted: PeerEvidence = Object.freeze({ role, pid, pidversion });
  evidence.set(channel, accepted);
  return { ok: true, evidence: accepted };
}

/**
 * Peer identity for the launcher channel. Darwin only; other hosts throw
 * `capability_unavailable`. The addon loads on first use.
 */
export function createPeerIdentityServices(options: {
  readonly os: PlatformOperatingSystem;
  readonly nativePath: string;
}): PeerIdentityServices {
  const { os, nativePath } = options;
  let native: PeerIdentityNative | undefined;
  const handles = new WeakMap<LauncherChannel, object>();
  const load = (): PeerIdentityNative => {
    if (os !== 'darwin') throw fail('capability_unavailable', UNSUPPORTED);
    return (native ??= loadNative(nativePath));
  };

  const services: PeerIdentityServices = {
    claimLauncherChannel() {
      const loaded = load();
      const result = call(() => loaded.claimLauncherChannel());
      const reason = refusal(result);
      if (reason) return { ok: false, reason };
      const handle = field(result, 'handle');
      if (
        field(result, 'state') !== 'channel' ||
        typeof handle !== 'object' ||
        handle === null
      )
        throw fail('unavailable', UNSUPPORTED);
      const channel = createPolledChannel(
        {
          read: (max) => loaded.channelRead(handle, max),
          write: (bytes) => loaded.channelWrite(handle, bytes),
          close: () => loaded.channelClose(handle),
        },
        {
          closed: () => fail('unavailable', CLOSED),
          busy: () => fail('failed_precondition', BUSY),
        },
      );
      handles.set(channel, handle);
      return { ok: true, channel };
    },
    captureLauncherEvidence(channel, required) {
      const loaded = load();
      const handle = handles.get(channel);
      if (!handle) throw fail('invalid_argument', INVALID);
      const text = requirementText(required, 'launcher');
      spend(channel);
      let result: unknown;
      try {
        result = loaded.launcherEvidence(handle, text);
      } catch (error) {
        // A closed channel has no launcher left to describe.
        if (field(error, 'code') === 'ERR_PEER_IDENTITY_CHANNEL')
          return { ok: false, reason: 'not_connected' };
        throw mapError(error);
      }
      const reason = refusal(result);
      if (reason) return { ok: false, reason };
      if (field(result, 'state') !== 'launcher')
        throw fail('unavailable', UNSUPPORTED);
      captures.set(channel, field(result, 'capture'));
      return accept(
        channel,
        'launcher',
        field(result, 'pid'),
        field(result, 'pidversion'),
      );
    },
    captureDaemonEvidence(channel, required) {
      const loaded = load();
      const text = requirementText(required, 'daemon');
      let peer: ChannelPeer | undefined;
      try {
        peer = channelPeer(channel);
      } catch (error) {
        // Not a launcher channel this process spawned: nothing to spend.
        if (field(error, 'code') === 'invalid_argument')
          throw fail('invalid_argument', INVALID);
      }
      spend(channel);
      if (!peer) throw fail('unavailable', UNSUPPORTED);
      if (peer.state === 'refused') return { ok: false, reason: peer.reason };
      const result = call(() =>
        loaded.captureGuest
          ? loaded.captureGuest(peer.token, text)
          : loaded.checkGuest(peer.token, text),
      );
      const reason = refusal(result);
      if (reason) return { ok: false, reason };
      if (field(result, 'state') !== 'satisfied')
        throw fail('unavailable', UNSUPPORTED);
      captures.set(channel, {
        os: 'darwin',
        spawned: { pid: peer.pid, pidversion: peer.pidversion, unreaped: true },
        peer: field(result, 'capture'),
      });
      return accept(channel, 'daemon', peer.pid, peer.pidversion);
    },
  };
  return Object.freeze(services);
}
