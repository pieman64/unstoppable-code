import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type BigIntStats,
} from 'node:fs';
import { dirname, isAbsolute, parse } from 'node:path';
import {
  createLinuxMigrationVerifier,
  type LinuxMigrationVerifier,
  type PreparedLinuxMigrationTrust,
} from '@canopy/core-runtime/node/vault';
import {
  createHostTrustGeneration,
  type HostLocalCapability,
} from './prepared-trust';
import { isMigrationRolePackageEligible } from './migration-package-eligibility';
import {
  captureLinuxMigrationPeer,
  connectLinuxLauncherChannel,
  createOwnedChildServices,
  OwnedChildError,
  type OwnedChildChannel,
  type OwnedChildLaunch,
} from './supervision/owned-child';

/** No runtime flag or package-check exit can open production admission. */
export const LINUX_MIGRATION_PRODUCTION_ENABLED = false;
export const LINUX_MIGRATION_PRODUCTION_BLOCKERS = Object.freeze([
  'V6 genuine signed-package and authenticated update qualification',
  'CAN-5762 Electron launcher-role/runAsNode proof',
  'V6 bidirectional admission and session/root binding',
]);

/** Candidate form only: no genuine production package is qualified by L3. */
export const LINUX_MIGRATION_INSTALL_FORM = 'system-deb' as const;
type Role = 'launcher' | 'daemon';
type Member = 'launcher' | 'daemon' | 'code' | 'native' | 'peer';
interface PinSpec {
  readonly path: string;
  readonly digest: string;
}
interface HeldPin extends PinSpec {
  readonly fd: number;
  readonly stat: BigIntStats;
}
export type PreparedLinuxMigrationPackage =
  HostLocalCapability<'package-admission'>;

export interface LinuxMigrationQualificationPolicy {
  /** Test injection, never an installed sidecar or a product eligibility claim. */
  readonly source: 'injected-test-policy';
  readonly installForm: string;
  readonly packageReport: unknown;
  readonly expectations: PreparedLinuxMigrationTrust['expectations'];
  readonly files: Readonly<Record<Member, PinSpec>>;
  readonly argv: Readonly<Record<Role, readonly string[]>>;
  /** Host-owned authenticated update observation in the eventual V6 producer. */
  readonly current: () => boolean;
}
interface PreparedEntry {
  readonly trust: PreparedLinuxMigrationTrust;
  readonly peerPath: () => string;
}
const prepared = new WeakMap<object, PreparedEntry>();
// dlopen caches descriptor pathnames, and N-API images cannot be safely unloaded.
// Keep one descriptor per mapped inode for the process lifetime so that pathname
// can never alias a later image. Unmapped package pins still retire normally.
const mappedPeers = new Map<string, HeldPin>();
function fileId(pin: HeldPin): string {
  return `${pin.stat.dev}:${pin.stat.ino}`;
}
function peerPath(pin: HeldPin): string {
  const id = fileId(pin);
  const mapped = mappedPeers.get(id);
  if (mapped && (!same(mapped.stat, pin.stat) || mapped.digest !== pin.digest))
    throw new OwnedChildError(
      'capability_unavailable',
      'Linux migration peer image changed after native loading.',
    );
  if (!mapped) mappedPeers.set(id, pin);
  return `/proc/self/fd/${(mapped ?? pin).fd}`;
}
const digest = (fd: number): string => {
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(64 * 1024);
  let offset = 0;
  for (;;) {
    const count = readSync(fd, buffer, 0, buffer.length, offset);
    if (!count) return `sha256:${hash.digest('hex')}`;
    hash.update(buffer.subarray(0, count));
    offset += count;
  }
};
function same(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    right.nlink === 1n
  );
}
function canonical(file: string): void {
  if (!isAbsolute(file) || realpathSync(file) !== file)
    throw new Error('Redirected package member.');
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    if (!lstatSync(dir).isDirectory() || realpathSync(dir) !== dir)
      throw new Error('Redirected package directory.');
    if (dir === parse(dir).root) break;
  }
}
function hold(spec: PinSpec): HeldPin {
  canonical(spec.path);
  const before = lstatSync(spec.path, { bigint: true });
  if (
    !before.isFile() ||
    before.nlink !== 1n ||
    before.size < 1n ||
    before.size > 512n * 1024n * 1024n ||
    !/^sha256:[a-f0-9]{64}$/.test(spec.digest)
  )
    throw new Error('Invalid package member.');
  const fd = openSync(
    spec.path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const pin = { ...spec, fd, stat: fstatSync(fd, { bigint: true }) };
    if (!same(before, pin.stat) || !currentPin(pin))
      throw new Error('Package changed.');
    return pin;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}
function currentPin(pin: HeldPin): boolean {
  canonical(pin.path);
  return (
    same(pin.stat, lstatSync(pin.path, { bigint: true })) &&
    same(pin.stat, fstatSync(pin.fd, { bigint: true })) &&
    digest(pin.fd) === pin.digest &&
    same(pin.stat, fstatSync(pin.fd, { bigint: true })) &&
    same(pin.stat, lstatSync(pin.path, { bigint: true }))
  );
}

/**
 * L3 fixture producer only. Uses CAN-5855's package-admission generation, not
 * native-preparation or serializable metadata. V6 must replace the injected
 * policy with authenticated complete package/dependency and update observations.
 * Fixture trees are user-owned; this is NOT a production immutable-tree proof.
 */
export function prepareLinuxMigrationQualification(
  policy: LinuxMigrationQualificationPolicy,
): {
  readonly capability: PreparedLinuxMigrationPackage;
  readonly invalidate: () => void;
} | null {
  if (
    process.platform !== 'linux' ||
    !['x64', 'arm64'].includes(process.arch) ||
    policy.source !== 'injected-test-policy' ||
    policy.installForm !== LINUX_MIGRATION_INSTALL_FORM ||
    !isMigrationRolePackageEligible(policy.packageReport)
  )
    return null;
  const generation = createHostTrustGeneration('package-admission');
  const pins: HeldPin[] = [];
  const listeners = new Set<() => void>();
  let retired = false;
  const invalidate = (): void => {
    if (retired) return;
    retired = true;
    generation.invalidate();
    for (const retire of [...listeners]) {
      try {
        retire();
      } catch {
        /* Continue retiring other channels. */
      }
    }
    listeners.clear();
    for (const pin of pins) {
      if (mappedPeers.get(fileId(pin)) !== pin) closeSync(pin.fd);
    }
  };
  try {
    // Copy policy before native load; later caller mutation cannot change pins.
    const expectations = Object.freeze({
      ...policy.expectations,
      package: Object.freeze({ ...policy.expectations.package }),
    });
    const launcher = hold(policy.files.launcher);
    pins.push(launcher);
    const take = (member: Member): HeldPin => {
      const pin = hold(policy.files[member]);
      pins.push(pin);
      return pin;
    };
    const daemon = take('daemon'),
      code = take('code'),
      native = take('native'),
      peer = take('peer');
    if (
      launcher.digest !== expectations.launcherDigest ||
      daemon.digest !== expectations.daemonDigest ||
      code.digest !== expectations.package.codeDigest ||
      native.digest !== expectations.package.nativeDigest
    )
      throw new Error('Package policy mismatch.');
    const argv = {
      launcher: Object.freeze([...policy.argv.launcher]),
      daemon: Object.freeze([...policy.argv.daemon]),
    };
    const observe = policy.current;
    const capability = generation.issue();
    const current = (): boolean => {
      try {
        if (
          generation.accepts(capability) &&
          observe() &&
          pins.every(currentPin) &&
          generation.accepts(capability)
        )
          return true;
      } catch {
        /* Unreadable observations permanently withdraw trust. */
      }
      invalidate();
      return false;
    };
    const trust: PreparedLinuxMigrationTrust = Object.freeze({
      expectations,
      image: (role: Role): ReturnType<PreparedLinuxMigrationTrust['image']> => {
        const pin = role === 'launcher' ? launcher : daemon;
        return {
          fileId: `${pin.stat.dev}:${pin.stat.ino}`,
          digest: pin.digest,
          argv: argv[role],
        };
      },
      current,
      onInvalidate: (retire: () => void): (() => void) => {
        if (retired) retire();
        else listeners.add(retire);
        return (): void => {
          listeners.delete(retire);
        };
      },
    });
    if (!current()) return null;
    // Linux dlopen resolves the held inode, not a replaceable installation name.
    prepared.set(capability, { trust, peerPath: (): string => peerPath(peer) });
    return Object.freeze({ capability, invalidate });
  } catch {
    invalidate();
    return null;
  }
}

export interface LinuxMigrationComposition extends LinuxMigrationVerifier {
  spawn(
    request: Parameters<
      ReturnType<typeof createOwnedChildServices>['spawnWithChannel']
    >[0],
  ): Promise<OwnedChildLaunch>;
  connect(launcherPid: number): OwnedChildChannel;
}

/** Disabled host qualification: L1 custody + prepared package trust + L2 receipts.
 * No principal, migration session, published endpoint or production caller.
 */
export function createLinuxMigrationComposition(
  capability: unknown,
): LinuxMigrationComposition | null {
  if (typeof capability !== 'object' || capability === null) return null;
  const entry = prepared.get(capability);
  if (!entry?.trust.current()) return null;
  const channels = new Map<object, OwnedChildChannel>();
  let closed = false;
  const closeChannels = (): void => {
    closed = true;
    for (const channel of channels.values()) channel.close();
    channels.clear();
  };
  const unsubscribe = entry.trust.onInvalidate(closeChannels);
  const verifier = createLinuxMigrationVerifier({
    trust: entry.trust,
    capture: (channel) => {
      const native = channels.get(channel);
      return native ? captureLinuxMigrationPeer(native) : null;
    },
  });
  const check = (): void => {
    if (closed || !entry.trust.current())
      throw new OwnedChildError(
        'capability_unavailable',
        'Linux migration package trust unavailable.',
      );
  };
  return Object.freeze({
    ...verifier,
    close(): void {
      closeChannels();
      verifier.close();
      unsubscribe();
    },
    async spawn(
      request: Parameters<LinuxMigrationComposition['spawn']>[0],
    ): Promise<OwnedChildLaunch> {
      check();
      const launch = await createOwnedChildServices({
        os: 'linux',
        nativePath: entry.peerPath(),
      }).spawnWithChannel(request);
      try {
        check();
      } catch (error) {
        launch.channel.close();
        await launch.child.terminate(AbortSignal.timeout(5000));
        throw error;
      }
      channels.set(launch.channel, launch.channel);
      return launch;
    },
    connect(launcherPid: number): OwnedChildChannel {
      check();
      const channel = connectLinuxLauncherChannel(
        entry.peerPath(),
        launcherPid,
      );
      try {
        check();
      } catch (error) {
        channel.close();
        throw error;
      }
      channels.set(channel, channel);
      return channel;
    },
  });
}
