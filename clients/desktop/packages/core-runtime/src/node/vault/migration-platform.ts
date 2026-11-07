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

/** Host-only identities; Windows FILETIME and Linux start ticks are never JS numbers. */
export type MigrationProcessIdentity =
  | {
      readonly os: 'darwin';
      readonly pid: number;
      readonly pidversion: number;
    }
  | {
      readonly os: 'win32';
      readonly pid: number;
      readonly creationTime: bigint;
    }
  | {
      readonly os: 'linux';
      readonly pid: number;
      readonly bootId: string;
      readonly startTime: string;
      /** starttime/pidfd proves process-instance, not executable continuity. */
      readonly continuity: 'process-instance';
    };

export type MigrationWindowsProcessIdentity = Extract<
  MigrationProcessIdentity,
  { readonly os: 'win32' }
>;
export type MigrationLinuxProcessIdentity = Extract<
  MigrationProcessIdentity,
  { readonly os: 'linux' }
>;

/** Observations, not authorization. W2/L2 must authenticate package membership. */
export interface MigrationPackageObservation {
  readonly flavorId: string;
  readonly secureMode: string;
  readonly buildId: string;
  readonly packageDigest: string;
  readonly codeDigest: string;
  readonly nativeDigest: string;
  readonly updateEpoch: string;
}

export interface MigrationWindowsArtifact {
  readonly executableDigest: string;
  readonly role: 'electron-main' | 'daemon' | 'other';
  readonly signing: {
    readonly publisher: string | null;
    readonly certificateDigest: string | null;
    readonly status: 'valid' | 'invalid' | 'unsigned';
  };
  readonly package: MigrationPackageObservation;
}

export interface MigrationLinuxArtifact {
  readonly executableDigest: string;
  readonly role: 'electron-main' | 'daemon' | 'other';
  /** Installed-package trust is separate from executable digest and pidfd. */
  readonly installedPackage: {
    readonly identity: string | null;
    readonly status: 'verified' | 'invalid' | 'unavailable';
  };
  readonly package: MigrationPackageObservation;
}

/**
 * Contract inputs for future platform verifiers, not a prepared-trust capability.
 * Expectations must come from authenticated artifacts/update observation (unit T),
 * never a sidecar or protocol payload. No Windows/Linux verifier is installed here.
 */
export type MigrationPlatformExpectations =
  | {
      readonly os: 'darwin';
      readonly launcher: MigrationLauncherExpectation;
      readonly daemon: MigrationDaemonExpectation;
    }
  | {
      readonly os: 'win32';
      readonly package: MigrationPackageObservation;
      readonly publisher: string;
      readonly certificateDigest: string;
      readonly launcherDigest: string;
      readonly daemonDigest: string;
    }
  | {
      readonly os: 'linux';
      readonly package: MigrationPackageObservation;
      readonly installedPackageIdentity: string;
      readonly launcherDigest: string;
      readonly daemonDigest: string;
      readonly continuity: 'process-instance';
    };

export type MigrationPlatformPeer<Identity, Artifact> =
  | {
      readonly kind: 'captured';
      readonly identity: Identity;
      readonly artifact: Artifact;
    }
  | { readonly kind: 'peer-gone' }
  | { readonly kind: 'capture-failed' };

/** Custody observations from the private launch channel, not payload claims. */
export interface MigrationLaunchChannel<Kind extends string> {
  readonly kind: Kind;
  readonly nonInheritable: boolean;
  readonly processCustody: 'retained' | 'lost';
}

export interface MigrationWindowsLauncherEvidence {
  readonly os: 'win32';
  readonly launched: boolean;
  readonly channel: MigrationLaunchChannel<'named-pipe'>;
  readonly startupParent: MigrationWindowsProcessIdentity;
  readonly captureParent: MigrationWindowsProcessIdentity;
  readonly peer: MigrationPlatformPeer<
    MigrationWindowsProcessIdentity,
    MigrationWindowsArtifact
  >;
}

export interface MigrationLinuxLauncherEvidence {
  readonly os: 'linux';
  readonly launched: boolean;
  readonly channel: MigrationLaunchChannel<'socketpair'> & {
    /** Separate from start identity, executable digest and package trust. */
    readonly peerPidfd: 'held' | 'lost' | 'unavailable';
  };
  readonly startupParent: MigrationLinuxProcessIdentity;
  readonly captureParent: MigrationLinuxProcessIdentity;
  readonly peer: MigrationPlatformPeer<
    MigrationLinuxProcessIdentity,
    MigrationLinuxArtifact
  >;
}

export interface MigrationWindowsDestinationEvidence {
  readonly os: 'win32';
  readonly spawned: MigrationWindowsProcessIdentity & {
    readonly unreaped: boolean;
  };
  readonly peer: MigrationWindowsLauncherEvidence['peer'];
}

export interface MigrationLinuxDestinationEvidence {
  readonly os: 'linux';
  readonly spawned: MigrationLinuxProcessIdentity & {
    readonly unreaped: boolean;
  };
  readonly peer: MigrationLinuxLauncherEvidence['peer'];
}

/** Preserve Darwin's diagnostic while comparing every platform's whole identity. */
export function migrationIdentityMismatch(
  expected: MigrationProcessIdentity,
  actual: MigrationProcessIdentity,
):
  | 'launcher.os'
  | 'launcher.pid'
  | 'launcher.pidversion'
  | 'launcher.identity'
  | null {
  if (expected.os !== actual.os) return 'launcher.os';
  if (expected.pid !== actual.pid) return 'launcher.pid';
  if (expected.os === 'darwin' && actual.os === 'darwin')
    return expected.pidversion === actual.pidversion
      ? null
      : 'launcher.pidversion';
  if (expected.os === 'win32' && actual.os === 'win32')
    return expected.creationTime === actual.creationTime
      ? null
      : 'launcher.identity';
  if (expected.os === 'linux' && actual.os === 'linux')
    return expected.bootId === actual.bootId &&
      expected.startTime === actual.startTime &&
      expected.continuity === actual.continuity
      ? null
      : 'launcher.identity';
  return 'launcher.os';
}
