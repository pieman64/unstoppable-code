import {
  readMigrationDestinationEvidence,
  readMigrationLauncherEvidence,
  type MigrationDestinationEvidence,
  type MigrationLauncherEvidence,
} from './migration-evidence';
import type {
  MigrationPlatformExpectations,
  MigrationWindowsArtifact,
  MigrationWindowsDestinationEvidence,
  MigrationWindowsLauncherEvidence,
  MigrationWindowsProcessIdentity,
} from './migration-platform';

type Role = 'launcher' | 'daemon';
type Expectations = Extract<MigrationPlatformExpectations, { os: 'win32' }>;

/**
 * Host-only adapter from CAN-5855's package-admission generation, produced by
 * core-platform's Windows preparation. Native-preparation is not admission.
 * Direct implementations are qualification fixtures only; never IPC.
 */
export interface PreparedWindowsMigrationTrust {
  readonly expectations: Expectations;
  /**
   * Pins held BEFORE launch, including the package's code/native dependencies.
   * The command line is the exact supported packaged role invocation, not a
   * payload claim. An image hash or an unauthenticated sidecar is insufficient.
   */
  image(role: Role): {
    readonly fileId: string;
    readonly digest: string;
    readonly commandLine: string;
  };
  /** Checks retained pins, authenticated package/update observation and trust. */
  current(): boolean;
  onInvalidate(retire: () => void): () => void;
}

/** Host-only observation of W1's retained, correctly oriented process handle. */
export interface WindowsMigrationCapture {
  readonly role: Role;
  readonly identity: MigrationWindowsProcessIdentity;
  readonly localPid: number;
  readonly localParentPid: number;
  readonly parentPid: number;
  readonly fileId: string;
  readonly digest: string;
  readonly commandLine: string;
  readonly signing: MigrationWindowsArtifact['signing'];
  current(): boolean;
  close(): void;
}

export type WindowsVerificationRefusal =
  | 'closed'
  | 'replay'
  | 'no-native-peer'
  | 'trust-unavailable'
  | 'lineage'
  | 'image'
  | 'role'
  | 'signing'
  | 'malformed-evidence'
  | 'changed';

type Evidence =
  | MigrationWindowsLauncherEvidence
  | MigrationWindowsDestinationEvidence;

function isWindowsEvidence(
  parsed: MigrationLauncherEvidence | MigrationDestinationEvidence | null,
): parsed is Evidence {
  // The shared parsers validate every field. Their legacy { os } variant
  // spans two OS tags, so checking the tag alone cannot narrow that union.
  return parsed !== null && parsed.os === 'win32' && 'peer' in parsed;
}

export type WindowsVerificationResult =
  | {
      readonly verified: true;
      readonly handle: object;
      readonly evidence: Evidence;
    }
  | { readonly verified: false; readonly reason: WindowsVerificationRefusal };

export interface WindowsMigrationVerifier {
  verifyLauncher(channel: object): WindowsVerificationResult;
  verifyDestination(channel: object): WindowsVerificationResult;
  lookup(handle: object, channel: object): Evidence | null;
  retire(handle: object): void;
  close(): void;
}

function trustState(trust: PreparedWindowsMigrationTrust, role: Role): string {
  const e = trust.expectations,
    p = e.package,
    i = trust.image(role);
  return JSON.stringify([
    e.os,
    e.publisher,
    e.certificateDigest,
    e.launcherDigest,
    e.daemonDigest,
    p.flavorId,
    p.secureMode,
    p.buildId,
    p.packageDigest,
    p.codeDigest,
    p.nativeDigest,
    p.updateEpoch,
    i.fileId,
    i.digest,
    i.commandLine,
  ]);
}

/**
 * W2 verifier consumed by disabled W3 composition; no principal or session here.
 * Matching image/invocation is not proof of Electron main: CAN-5762 must
 * disable runAsNode (or W3 supply a role proof) before W3/V6 enablement.
 * Kernel opener identity is NOT last-writer evidence. Hostile same-user explicit
 * DuplicateHandle co-holding is unqualified; CAN-5865 blocks W3/V6 enablement.
 */
export function createWindowsMigrationVerifier(options: {
  readonly trust: PreparedWindowsMigrationTrust;
  readonly capture: (channel: object) => WindowsMigrationCapture | null;
}): WindowsMigrationVerifier {
  const spent = new WeakSet<object>();
  const entries = new Map<
    object,
    {
      channel: object;
      capture: WindowsMigrationCapture;
      evidence: Evidence;
      policy: string;
      role: Role;
    }
  >();
  let closed = false;
  let retiring = false;
  let epoch = 0;
  const safelyClose = (capture: WindowsMigrationCapture): void => {
    const wasRetiring = retiring;
    retiring = true;
    try {
      capture.close();
    } catch {
      /* Retirement must continue for other pins. */
    } finally {
      retiring = wasRetiring;
    }
  };
  const retire = (): void => {
    epoch++;
    const live = [...entries.values()];
    entries.clear();
    for (const item of live) safelyClose(item.capture);
  };
  let unsubscribe = (): void => undefined;
  try {
    unsubscribe = options.trust.onInvalidate(() => {
      closed = true;
      retire();
    });
  } catch {
    closed = true;
  }
  const refuse = (
    reason: WindowsVerificationRefusal,
  ): WindowsVerificationResult => ({ verified: false, reason });

  const verify = (channel: object, role: Role): WindowsVerificationResult => {
    if (closed || retiring) return refuse('closed');
    if (spent.has(channel)) return refuse('replay');
    spent.add(channel);
    const start = epoch;
    let capture: WindowsMigrationCapture | null = null;
    let retained = false;
    try {
      if (!options.trust.current()) return refuse('trust-unavailable');
      // Copy authenticated policy before any native observation; invalidate on
      // every lookup as well, never only at initial verification.
      const state = trustState(options.trust, role);
      const policy = options.trust.expectations;
      if (policy.os !== 'win32') return refuse('trust-unavailable');
      const expected = { ...policy, package: { ...policy.package } };
      const image = { ...options.trust.image(role) };
      capture = options.capture(channel);
      if (!capture) return refuse('no-native-peer');
      if (capture.role !== role) return refuse('role');
      if (
        role === 'launcher'
          ? capture.localParentPid !== capture.identity.pid
          : capture.parentPid !== capture.localPid
      )
        return refuse('lineage');
      if (
        image.digest !==
          (role === 'launcher'
            ? expected.launcherDigest
            : expected.daemonDigest) ||
        capture.digest !== image.digest ||
        capture.fileId !== image.fileId
      )
        return refuse('image');
      // Conservatively reject quote-spliced switches too; this guard is not
      // Electron-main role proof while the runAsNode fuse is enabled (CAN-5762).
      if (
        capture.commandLine !== image.commandLine ||
        (role === 'launcher' &&
          /(?:^|[\s"])--(?:type|run-as-node)(?:[=\s"]|$)/i.test(
            capture.commandLine.replace(/"/g, ''),
          ))
      )
        return refuse('role');
      const signing = capture.signing;
      if (
        signing.status !== 'valid' ||
        signing.publisher !== expected.publisher ||
        signing.certificateDigest !== expected.certificateDigest
      )
        return refuse('signing');
      const artifact: MigrationWindowsArtifact = {
        executableDigest: capture.digest,
        role: role === 'launcher' ? 'electron-main' : 'daemon',
        signing,
        package: expected.package,
      };
      const peer = {
        kind: 'captured',
        identity: capture.identity,
        artifact,
      } as const;
      const parsed =
        role === 'launcher'
          ? readMigrationLauncherEvidence({
              os: 'win32',
              launched: true,
              channel: {
                kind: 'named-pipe',
                nonInheritable: true,
                processCustody: 'retained',
              },
              startupParent: capture.identity,
              captureParent: capture.identity,
              peer,
            })
          : readMigrationDestinationEvidence({
              os: 'win32',
              spawned: { ...capture.identity, unreaped: true },
              peer,
            });
      if (!isWindowsEvidence(parsed)) return refuse('malformed-evidence');
      if (
        !capture.current() ||
        !options.trust.current() ||
        trustState(options.trust, role) !== state ||
        closed ||
        epoch !== start
      )
        return refuse('changed');
      const handle = {};
      Reflect.setPrototypeOf(handle, null);
      Object.freeze(handle);
      entries.set(handle, {
        channel,
        capture,
        evidence: parsed,
        policy: state,
        role,
      });
      retained = true;
      return { verified: true, handle, evidence: parsed };
    } catch {
      return refuse('trust-unavailable');
    } finally {
      if (capture && !retained) safelyClose(capture);
    }
  };
  return Object.freeze({
    verifyLauncher: (channel: object) => verify(channel, 'launcher'),
    verifyDestination: (channel: object) => verify(channel, 'daemon'),
    lookup(handle: object, channel: object): Evidence | null {
      const item = entries.get(handle);
      if (closed || !item || item.channel !== channel) return null;
      const start = epoch;
      try {
        if (
          item.capture.current() &&
          options.trust.current() &&
          trustState(options.trust, item.role) === item.policy &&
          !closed &&
          epoch === start &&
          entries.get(handle) === item
        )
          return item.evidence;
      } catch {
        /* Unreadable host facts retire all verified peers. */
      }
      retire();
      return null;
    },
    retire(handle: object): void {
      const item = entries.get(handle);
      entries.delete(handle);
      epoch++;
      if (item) safelyClose(item.capture);
    },
    close(): void {
      closed = true;
      retire();
      try {
        unsubscribe();
      } catch {
        /* Already closed. */
      }
    },
  });
}
