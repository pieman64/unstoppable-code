/*
 * Native evidence for ADR 7 migration admission (CAN-4504 VA-2). Inert: no
 * production migration host serves this yet (CAN-4933 lands disabled). Evidence lives only in the
 * host's WeakMap, keyed by an opaque handle; it is never serialized and never
 * crosses remote control. Each capture happens once, after the peer's frame
 * 1, and is never repeated (R-7). There is no LOCAL_PEERPID field.
 */

export interface MigrationProcessToken {
  readonly pid: number;
  readonly pidversion: number;
}

/** Signing facts the native code check read for the peer. */
export interface MigrationCodeSigning {
  /** Leaf certificate OU; null when unsigned or ad hoc. */
  readonly teamId: string | null;
  readonly identifier: string;
  /** `info[CanopyBuildId]`, when the bundle has one. */
  readonly buildId: string | null;
  /** Dynamic `kSecCodeInfoStatus`, including `CS_RUNTIME`. */
  readonly codeFlags: number;
  readonly cdhash: string;
}

export type MigrationPeerCapture =
  | {
      readonly kind: 'captured';
      /** The peer's audit token, captured once after its frame 1. */
      readonly token: MigrationProcessToken;
      /** The audit token the code check resolved; differs after an exec. */
      readonly codeToken: MigrationProcessToken;
      readonly signing: MigrationCodeSigning;
      /** The requirement text the native check evaluated, and its verdict. */
      readonly requirement: {
        readonly text: string;
        readonly satisfied: boolean;
      };
      /** §3.2.6 static validity check: raises the bar only when it runs. */
      readonly staticCheck: 'passed' | 'failed' | 'not-run';
    }
  /** The peer exited or outlived its end; never retried another way (R-13). */
  | { readonly kind: 'peer-gone'; readonly errno: 'EINVAL' | 'ENOTCONN' }
  | { readonly kind: 'capture-failed' };

/** What the daemon captured about the process on its fd 3. */
export interface MigrationDarwinLauncherEvidence {
  readonly os: 'darwin';
  /** Started with the fixed `--migration-channel`, not attached later. */
  readonly launched: boolean;
  /** fd 3's socket family and type; null when fd 3 is not a socket. */
  readonly fd3: { readonly family: string; readonly type: string } | null;
  /** CLOEXEC was set on fd 3 before the daemon spawned anything. */
  readonly fd3CloexecAtStartup: boolean;
  /** `getppid()` at daemon startup. */
  readonly startupParentPid: number;
  /** `getppid()` at capture. */
  readonly captureParentPid: number;
  readonly peer: MigrationPeerCapture;
}

/** What Electron main captured about the daemon it spawned (R-12). */
export interface MigrationDarwinDestinationEvidence {
  readonly os: 'darwin';
  readonly spawned: MigrationProcessToken & { readonly unreaped: boolean };
  readonly peer: MigrationPeerCapture;
}

/**
 * Windows and Linux have no launch primitive at the pin (C-4), so they carry
 * nothing. VA-W and VA-L add their capture fields.
 */
export interface MigrationUnsupportedOsEvidence {
  readonly os: 'win32' | 'linux';
}

export type MigrationLauncherEvidence =
  | MigrationDarwinLauncherEvidence
  | MigrationUnsupportedOsEvidence;

export type MigrationDestinationEvidence =
  | MigrationDarwinDestinationEvidence
  | MigrationUnsupportedOsEvidence;

/** Code-signing value shapes; none admits a quote, so requirements stay literal. */
export const MIGRATION_SIGNING_PATTERNS = Object.freeze({
  cdhash: /^[0-9a-f]{40}$/,
  teamId: /^[A-Z0-9]{10}$/,
  identifier: /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/,
  buildId: /^[A-Za-z0-9._-]{1,128}$/,
});

const {
  cdhash: CDHASH,
  teamId: TEAM_ID,
  identifier: IDENTIFIER,
  buildId: BUILD_ID,
} = MIGRATION_SIGNING_PATTERNS;
const SOCKET_NAME = /^[A-Z][A-Z0-9_]{0,31}$/;
const MAX_REQUIREMENT_CHARS = 2048;
const MAX_IDENTIFIER_CHARS = 255;
const UINT32_MAX = 0xffff_ffff;

class MalformedEvidence extends Error {}

type Fields = Readonly<Record<string, unknown>>;

/**
 * Copies an object's own fields once, so a getter or proxy cannot answer
 * differently on a later read. Everything after reads only the copy.
 */
function plain(value: unknown): Fields {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new MalformedEvidence();
  return Object.fromEntries(Object.entries(value));
}

/** Exactly `keys`: an unknown field (say, a peer pid) is malformed. */
function exact(copy: Fields, keys: readonly string[]): Fields {
  const present = Object.keys(copy);
  if (
    present.length !== keys.length ||
    present.some((key) => !keys.includes(key))
  )
    throw new MalformedEvidence();
  return copy;
}

const fields = (value: unknown, keys: readonly string[]): Fields =>
  exact(plain(value), keys);

function integer(value: unknown, min: number, max: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    throw new MalformedEvidence();
  return value;
}

function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new MalformedEvidence();
  return value;
}

function text(value: unknown, pattern: RegExp, max = 256): string {
  if (typeof value !== 'string' || value.length > max || !pattern.test(value))
    throw new MalformedEvidence();
  return value;
}

function nullable<T>(value: unknown, read: (value: unknown) => T): T | null {
  return value === null ? null : read(value);
}

function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
  const match = values.find((candidate) => candidate === value);
  if (match === undefined) throw new MalformedEvidence();
  return match;
}

function token(value: unknown): MigrationProcessToken {
  const copy = fields(value, ['pid', 'pidversion']);
  return Object.freeze({
    pid: integer(copy.pid, 1, UINT32_MAX),
    pidversion: integer(copy.pidversion, 0, UINT32_MAX),
  });
}

function signing(value: unknown): MigrationCodeSigning {
  const copy = fields(value, [
    'teamId',
    'identifier',
    'buildId',
    'codeFlags',
    'cdhash',
  ]);
  return Object.freeze({
    teamId: nullable(copy.teamId, (v) => text(v, TEAM_ID)),
    identifier: text(copy.identifier, IDENTIFIER, MAX_IDENTIFIER_CHARS),
    buildId: nullable(copy.buildId, (v) => text(v, BUILD_ID)),
    codeFlags: integer(copy.codeFlags, 0, UINT32_MAX),
    cdhash: text(copy.cdhash, CDHASH),
  });
}

function requirement(value: unknown): {
  readonly text: string;
  readonly satisfied: boolean;
} {
  const copy = fields(value, ['text', 'satisfied']);
  if (
    typeof copy.text !== 'string' ||
    copy.text.length === 0 ||
    copy.text.length > MAX_REQUIREMENT_CHARS
  )
    throw new MalformedEvidence();
  return Object.freeze({ text: copy.text, satisfied: bool(copy.satisfied) });
}

function peer(value: unknown): MigrationPeerCapture {
  const copy = plain(value);
  if (copy.kind === 'capture-failed') {
    exact(copy, ['kind']);
    return Object.freeze({ kind: 'capture-failed' });
  }
  if (copy.kind === 'peer-gone') {
    exact(copy, ['kind', 'errno']);
    return Object.freeze({
      kind: 'peer-gone',
      errno: oneOf(copy.errno, ['EINVAL', 'ENOTCONN'] as const),
    });
  }
  exact(copy, [
    'kind',
    'token',
    'codeToken',
    'signing',
    'requirement',
    'staticCheck',
  ]);
  if (copy.kind !== 'captured') throw new MalformedEvidence();
  return Object.freeze({
    kind: 'captured',
    token: token(copy.token),
    codeToken: token(copy.codeToken),
    signing: signing(copy.signing),
    requirement: requirement(copy.requirement),
    staticCheck: oneOf(copy.staticCheck, [
      'passed',
      'failed',
      'not-run',
    ] as const),
  });
}

function socket(
  value: unknown,
): { readonly family: string; readonly type: string } | null {
  return nullable(value, (v) => {
    const copy = fields(v, ['family', 'type']);
    return Object.freeze({
      family: text(copy.family, SOCKET_NAME),
      type: text(copy.type, SOCKET_NAME),
    });
  });
}

/** Unsupported-OS variants carry exactly `os`. */
function unsupportedOs(copy: Fields): MigrationUnsupportedOsEvidence | null {
  const os = copy.os;
  if (os !== 'win32' && os !== 'linux') return null;
  exact(copy, ['os']);
  return Object.freeze({ os });
}

/** Any throw, including a getter's or a proxy trap's, is malformed. */
function parse<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}

/** A deep-frozen copy of launcher evidence, or null when malformed. */
export function readMigrationLauncherEvidence(
  value: unknown,
): MigrationLauncherEvidence | null {
  return parse((): MigrationLauncherEvidence => {
    const copy = plain(value);
    const other = unsupportedOs(copy);
    if (other !== null) return other;
    exact(copy, [
      'os',
      'launched',
      'fd3',
      'fd3CloexecAtStartup',
      'startupParentPid',
      'captureParentPid',
      'peer',
    ]);
    if (copy.os !== 'darwin') throw new MalformedEvidence();
    return Object.freeze({
      os: 'darwin',
      launched: bool(copy.launched),
      fd3: socket(copy.fd3),
      fd3CloexecAtStartup: bool(copy.fd3CloexecAtStartup),
      startupParentPid: integer(copy.startupParentPid, 1, UINT32_MAX),
      captureParentPid: integer(copy.captureParentPid, 1, UINT32_MAX),
      peer: peer(copy.peer),
    });
  });
}

/** A deep-frozen copy of destination evidence, or null when malformed. */
export function readMigrationDestinationEvidence(
  value: unknown,
): MigrationDestinationEvidence | null {
  return parse((): MigrationDestinationEvidence => {
    const copy = plain(value);
    const other = unsupportedOs(copy);
    if (other !== null) return other;
    exact(copy, ['os', 'spawned', 'peer']);
    if (copy.os !== 'darwin') throw new MalformedEvidence();
    const spawned = fields(copy.spawned, ['pid', 'pidversion', 'unreaped']);
    return Object.freeze({
      os: 'darwin',
      spawned: Object.freeze({
        ...token({ pid: spawned.pid, pidversion: spawned.pidversion }),
        unreaped: bool(spawned.unreaped),
      }),
      peer: peer(copy.peer),
    });
  });
}

export interface MigrationEvidenceEntry {
  /** Null when the native capture was malformed. */
  readonly evidence: MigrationLauncherEvidence | null;
}

/** Host-only. The native transport attaches; admission looks up. */
export interface MigrationEvidenceStore {
  /**
   * Copies the capture once and returns the opaque handle frames on this
   * channel arrive with. The handle carries nothing and serializes to `{}`.
   */
  attach(capture: unknown): object;
  /** Null for any value `attach` did not return, and for retired handles. */
  lookup(handle: object): MigrationEvidenceEntry | null;
  retire(handle: object): void;
}

export function createMigrationEvidenceStore(): MigrationEvidenceStore {
  const entries = new WeakMap<object, MigrationEvidenceEntry>();
  return Object.freeze({
    attach(capture: unknown): object {
      const handle = {};
      Reflect.setPrototypeOf(handle, null);
      Object.freeze(handle);
      entries.set(
        handle,
        Object.freeze({ evidence: readMigrationLauncherEvidence(capture) }),
      );
      return handle;
    },
    lookup: (handle: object): MigrationEvidenceEntry | null =>
      entries.get(handle) ?? null,
    retire(handle: object): void {
      entries.delete(handle);
    },
  });
}
