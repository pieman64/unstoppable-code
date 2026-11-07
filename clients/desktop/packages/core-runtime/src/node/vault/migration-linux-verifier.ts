import {
  readMigrationDestinationEvidence,
  readMigrationLauncherEvidence,
  type MigrationDestinationEvidence,
  type MigrationLauncherEvidence,
} from './migration-evidence';
import type {
  MigrationPlatformExpectations,
  MigrationLinuxArtifact,
  MigrationLinuxDestinationEvidence,
  MigrationLinuxLauncherEvidence,
  MigrationLinuxProcessIdentity,
} from './migration-platform';

type Role = 'launcher' | 'daemon';
type Expectations = Extract<MigrationPlatformExpectations, { os: 'linux' }>;

/** Host projection of prepared package trust; never IPC or enablement evidence.
 * L3 core-platform composition resolves its package-admission capability through
 * a private registry before supplying this reader. Direct injected readers remain
 * an L2 qualification seam, not a production prepared-trust producer.
 */
export interface PreparedLinuxMigrationTrust {
  readonly expectations: Expectations;
  /**
   * Pins held BEFORE launch, including the package's code/native dependencies.
   * The command line is the exact supported packaged role invocation, not a
   * payload claim. An image hash or an unauthenticated sidecar is insufficient.
   * A production producer requires a qualified, immutable installed ELF package
   * tree; L3's labelled fixture injection does not qualify such a producer.
   * current() must verify installation-name membership as well as held
   * code/native pins; open inode pins alone do not detect path replacement.
   * AppImage, extracted archives, dev checkouts and user-writable install trees
   * have no qualified producer and must remain unavailable.
   */
  image(role: Role): {
    readonly fileId: string;
    readonly digest: string;
    readonly argv: readonly string[];
  };
  /** Checks retained pins, authenticated package/update observation and trust. */
  current(): boolean;
  onInvalidate(retire: () => void): () => void;
}

/** Host-only observation of L1's retained, correctly oriented pidfd/procfs custody. */
export interface LinuxMigrationCapture {
  readonly role: Role;
  readonly identity: MigrationLinuxProcessIdentity;
  readonly localPid: number;
  readonly localParentPid: number;
  readonly parentPid: number;
  readonly fileId: string;
  readonly digest: string;
  readonly argv: readonly string[];
  current(): boolean;
  close(): void;
}

export type LinuxVerificationRefusal =
  | 'closed'
  | 'replay'
  | 'no-native-peer'
  | 'trust-unavailable'
  | 'lineage'
  | 'image'
  | 'role'
  | 'malformed-evidence'
  | 'changed';

type Evidence =
  | MigrationLinuxLauncherEvidence
  | MigrationLinuxDestinationEvidence;

function isLinuxEvidence(
  parsed: MigrationLauncherEvidence | MigrationDestinationEvidence | null,
): parsed is Evidence {
  // The shared parsers validate every field. Their legacy { os } variant
  // spans two OS tags, so checking the tag alone cannot narrow that union.
  return parsed !== null && parsed.os === 'linux' && 'peer' in parsed;
}

export type LinuxVerificationResult =
  | {
      readonly verified: true;
      readonly handle: object;
      readonly evidence: Evidence;
    }
  | { readonly verified: false; readonly reason: LinuxVerificationRefusal };

export interface LinuxMigrationVerifier {
  verifyLauncher(channel: object): LinuxVerificationResult;
  verifyDestination(channel: object): LinuxVerificationResult;
  lookup(handle: object, channel: object): Evidence | null;
  retire(handle: object): void;
  close(): void;
}

function trustState(trust: PreparedLinuxMigrationTrust, role: Role): string {
  const e = trust.expectations,
    p = e.package,
    i = trust.image(role);
  return JSON.stringify([
    e.os,
    e.installedPackageIdentity,
    e.continuity,
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
    i.argv,
  ]);
}

/**
 * Disabled L2 verifier, not production admission: issues no principal or session.
 * Matching image/invocation is not proof of Electron main: CAN-5762 must
 * disable runAsNode (or L3 supply a role proof) before L3/V6 enablement.
 * L1 attributes every received chunk. pidfd/starttime proves only process-instance
 * continuity: ptrace, preload, capable impersonation and an away-and-back exec
 * remain accepted native limits, not macOS-equivalent signing enforcement.
 */
export function createLinuxMigrationVerifier(options: {
  readonly trust: PreparedLinuxMigrationTrust;
  readonly capture: (channel: object) => LinuxMigrationCapture | null;
}): LinuxMigrationVerifier {
  const spent = new WeakSet<object>();
  const entries = new Map<
    object,
    {
      channel: object;
      capture: LinuxMigrationCapture;
      evidence: Evidence;
      policy: string;
      role: Role;
    }
  >();
  let closed = false;
  let retiring = false;
  let epoch = 0;
  const safelyClose = (capture: LinuxMigrationCapture): void => {
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
    reason: LinuxVerificationRefusal,
  ): LinuxVerificationResult => ({ verified: false, reason });

  const verify = (channel: object, role: Role): LinuxVerificationResult => {
    if (closed || retiring) return refuse('closed');
    if (spent.has(channel)) return refuse('replay');
    spent.add(channel);
    const start = epoch;
    let capture: LinuxMigrationCapture | null = null;
    let retained = false;
    try {
      if (!options.trust.current()) return refuse('trust-unavailable');
      // Copy authenticated policy before any native observation; invalidate on
      // every lookup as well, never only at initial verification.
      const state = trustState(options.trust, role);
      const policy = options.trust.expectations;
      if (
        policy.os !== 'linux' ||
        policy.continuity !== 'process-instance' ||
        typeof policy.installedPackageIdentity !== 'string' ||
        !policy.installedPackageIdentity.trim()
      )
        return refuse('trust-unavailable');
      const expected = { ...policy, package: { ...policy.package } };
      const sourceImage = options.trust.image(role);
      const image = { ...sourceImage, argv: [...sourceImage.argv] };
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
      if (
        capture.argv.length !== image.argv.length ||
        capture.argv.some((arg, i) => arg !== image.argv[i]) ||
        !capture.argv.length ||
        !capture.argv[0] ||
        capture.argv.some(
          (arg) => typeof arg !== 'string' || arg.includes('\0'),
        ) ||
        (role === 'launcher' &&
          capture.argv
            .slice(1)
            .some((arg) => /^--(?:type|run-as-node)(?:=|$)/i.test(arg)))
      )
        return refuse('role');
      const artifact: MigrationLinuxArtifact = {
        executableDigest: capture.digest,
        role: role === 'launcher' ? 'electron-main' : 'daemon',
        installedPackage: {
          identity: expected.installedPackageIdentity,
          status: 'verified',
        },
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
              os: 'linux',
              launched: true,
              channel: {
                kind: 'socketpair',
                peerPidfd: 'held',
                nonInheritable: true,
                processCustody: 'retained',
              },
              startupParent: capture.identity,
              captureParent: capture.identity,
              peer,
            })
          : readMigrationDestinationEvidence({
              os: 'linux',
              spawned: { ...capture.identity, unreaped: true },
              peer,
            });
      if (!isLinuxEvidence(parsed)) return refuse('malformed-evidence');
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
