import {
  authenticateMigrationDestination,
  createMigrationAdmission,
} from '../migration-admission';
import {
  createMigrationEvidenceStore,
  readMigrationDestinationEvidence,
  readMigrationLauncherEvidence,
  readMigrationProcessIdentity,
} from '../migration-evidence';
import {
  migrationIdentityMismatch,
  type MigrationLinuxLauncherEvidence,
  type MigrationPlatformExpectations,
  type MigrationProcessIdentity,
  type MigrationWindowsLauncherEvidence,
} from '../index';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const PACKAGE = {
  flavorId: 'com.example.canopy',
  secureMode: 'prod',
  buildId: 'build-1',
  packageDigest: DIGEST,
  codeDigest: DIGEST,
  nativeDigest: DIGEST,
  updateEpoch: 'epoch-1',
};
const WINDOWS = {
  os: 'win32',
  pid: 42,
  creationTime: 133_000_000_000_000_001n,
} as const;
const LINUX = {
  os: 'linux',
  pid: 42,
  bootId: '12345678-1234-1234-1234-123456789abc',
  startTime: '9007199254740993',
  continuity: 'process-instance',
} as const;
const DARWIN = { os: 'darwin', pid: 42, pidversion: 0xffffffff } as const;
const EXPECTED = {
  teamId: 'ABCDE12345',
  flavorId: PACKAGE.flavorId,
  secureMode: 'prod',
  buildId: 'build-1',
};
const DAEMON = {
  teamId: EXPECTED.teamId,
  identifier: 'com.example.daemon',
  binding: { kind: 'cdhash', cdhash: 'a'.repeat(40) },
} as const;

function windows(): MigrationWindowsLauncherEvidence {
  return {
    os: 'win32',
    launched: true,
    channel: {
      kind: 'named-pipe',
      nonInheritable: true,
      processCustody: 'retained',
    },
    startupParent: WINDOWS,
    captureParent: WINDOWS,
    peer: {
      kind: 'captured',
      identity: WINDOWS,
      artifact: {
        executableDigest: DIGEST,
        role: 'electron-main',
        signing: {
          publisher: 'Example',
          certificateDigest: DIGEST,
          status: 'valid',
        },
        package: { ...PACKAGE },
      },
    },
  };
}
function linux(): MigrationLinuxLauncherEvidence {
  return {
    os: 'linux',
    launched: true,
    channel: {
      kind: 'socketpair',
      nonInheritable: true,
      processCustody: 'retained',
      peerPidfd: 'held',
    },
    startupParent: LINUX,
    captureParent: LINUX,
    peer: {
      kind: 'captured',
      identity: LINUX,
      artifact: {
        executableDigest: DIGEST,
        role: 'electron-main',
        installedPackage: { identity: 'example-package', status: 'verified' },
        package: { ...PACKAGE },
      },
    },
  };
}

function expectDeepFrozen(value: unknown): void {
  if (typeof value !== 'object' || value === null) return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeepFrozen(child);
}

const IDENTITIES: readonly MigrationProcessIdentity[] = [
  DARWIN,
  WINDOWS,
  LINUX,
];

describe('OS-discriminated migration evidence (CAN-5857; disabled)', () => {
  it.each(IDENTITIES)(
    'copies the whole $os identity losslessly',
    (identity) => {
      const copy = readMigrationProcessIdentity(identity);
      expect(copy).toEqual(identity);
      expect(copy).not.toBe(identity);
      expectDeepFrozen(copy);
      expect(migrationIdentityMismatch(identity, identity)).toBeNull();
    },
  );

  it.each([
    null,
    [],
    {},
    { ...WINDOWS, creationTime: Number(WINDOWS.creationTime) },
    { ...WINDOWS, creationTime: String(WINDOWS.creationTime) },
    { ...WINDOWS, creationTime: 0n },
    { ...WINDOWS, creationTime: -1n },
    { ...WINDOWS, creationTime: 0x1_0000_0000_0000_0000n },
    { ...WINDOWS, pidversion: 1 },
    { ...WINDOWS, pid: 1.5 },
    { ...DARWIN, pidversion: 0x1_0000_0000 },
    { ...LINUX, startTime: Number(9007199254740993n) },
    { ...LINUX, startTime: '' },
    { ...LINUX, startTime: '01' },
    { ...LINUX, startTime: '-1' },
    { ...LINUX, startTime: '18446744073709551616' },
    { ...LINUX, bootId: 'not-a-boot-id' },
    { ...LINUX, continuity: 'exec-generation' },
    { ...LINUX, pidversion: 1 },
    { ...LINUX, os: 'win32' },
  ])('rejects malformed or lossy identities: %#', (value) => {
    expect(readMigrationProcessIdentity(value)).toBeNull();
  });

  it('accepts integer boundaries without number conversion', () => {
    for (const creationTime of [1n, 0xffff_ffff_ffff_ffffn])
      expect(
        readMigrationProcessIdentity({ ...WINDOWS, creationTime }),
      ).toEqual({ ...WINDOWS, creationTime });
    for (const startTime of ['0', '18446744073709551615'])
      expect(readMigrationProcessIdentity({ ...LINUX, startTime })).toEqual({
        ...LINUX,
        startTime,
      });
    expect(readMigrationProcessIdentity({ ...DARWIN, pidversion: 0 })).toEqual({
      ...DARWIN,
      pidversion: 0,
    });
  });

  it('distinguishes adjacent Windows ticks and Linux ticks beyond Number precision', () => {
    expect(
      migrationIdentityMismatch(WINDOWS, {
        ...WINDOWS,
        creationTime: WINDOWS.creationTime + 1n,
      }),
    ).toBe('launcher.identity');
    expect(
      migrationIdentityMismatch(LINUX, {
        ...LINUX,
        startTime: '9007199254740992',
      }),
    ).toBe('launcher.identity');
    expect(
      migrationIdentityMismatch(LINUX, {
        ...LINUX,
        bootId: 'abcdefab-1234-1234-1234-123456789abc',
      }),
    ).toBe('launcher.identity');
    expect(migrationIdentityMismatch(DARWIN, WINDOWS)).toBe('launcher.os');
  });

  it.each([windows, linux])(
    'copies full launcher/destination captures deeply once: %#',
    (make) => {
      const raw = make();
      const copied = readMigrationLauncherEvidence(raw);
      expect(copied).toEqual(raw);
      expectDeepFrozen(copied);
      const destination = {
        os: raw.os,
        spawned: { ...raw.captureParent, unreaped: true },
        peer: raw.peer,
      };
      expect(readMigrationDestinationEvidence(destination)).toEqual(
        destination,
      );
      expectDeepFrozen(readMigrationDestinationEvidence(destination));
      const store = createMigrationEvidenceStore();
      const handle = store.attach(raw);
      expect(JSON.stringify(handle)).toBe('{}');
      expect(store.lookup(structuredClone(handle))).toBeNull();
      expect(store.lookup(handle)?.evidence).toEqual(raw);
      store.retire(handle);
      expect(store.lookup(handle)).toBeNull();
    },
  );

  it.each([windows, linux])(
    'captures getters once and never reads a changing identity again: %#',
    (make) => {
      let reads = 0;
      const raw = make();
      const value = {
        ...raw,
        get captureParent(): unknown {
          reads += 1;
          return reads === 1 ? raw.captureParent : null;
        },
      };
      expect(readMigrationLauncherEvidence(value)).toEqual(raw);
      expect(reads).toBe(1);
    },
  );

  it.each([windows, linux])(
    'refuses cross-OS, extra, missing and throwing evidence fields: %#',
    (make) => {
      const raw = make();
      for (const bad of [
        { ...raw, startupParent: DARWIN },
        { ...raw, peer: { kind: 'captured', identity: DARWIN, artifact: {} } },
        { ...raw, authenticated: true },
        { ...raw, channel: undefined },
        { ...raw, channel: { ...raw.channel, fd: 3 } },
        {
          ...raw,
          get peer(): never {
            throw new Error('unreadable');
          },
        },
        new Proxy(raw, {
          ownKeys(): never {
            throw new Error('unreadable');
          },
        }),
      ])
        expect(readMigrationLauncherEvidence(bad)).toBeNull();
    },
  );

  it.each([windows, linux])(
    'preserves negative captures without inventing identity: %#',
    (make) => {
      for (const kind of ['peer-gone', 'capture-failed']) {
        const raw = { ...make(), peer: { kind } };
        expect(readMigrationLauncherEvidence(raw)).toEqual(raw);
        expect(
          readMigrationLauncherEvidence({ ...raw, peer: { kind, pid: 42 } }),
        ).toBeNull();
      }
    },
  );

  it('keeps Linux pidfd custody distinct from instance and executable evidence', () => {
    const raw = linux();
    for (const peerPidfd of ['held', 'lost', 'unavailable']) {
      const value = { ...raw, channel: { ...raw.channel, peerPidfd } };
      expect(readMigrationLauncherEvidence(value)).toEqual(value);
    }
    expect(
      readMigrationLauncherEvidence({
        ...raw,
        channel: { ...raw.channel, peerPidfd: true },
      }),
    ).toBeNull();
  });

  it('records unsigned or unavailable package observations without invented identities', () => {
    const win = windows();
    const lin = linux();
    if (win.peer.kind !== 'captured' || lin.peer.kind !== 'captured')
      throw new Error('fixture missing captured peer');
    for (const raw of [
      {
        ...win,
        peer: {
          ...win.peer,
          artifact: {
            ...win.peer.artifact,
            signing: {
              publisher: null,
              certificateDigest: null,
              status: 'unsigned',
            },
          },
        },
      },
      {
        ...lin,
        peer: {
          ...lin.peer,
          artifact: {
            ...lin.peer.artifact,
            installedPackage: { identity: null, status: 'unavailable' },
          },
        },
      },
    ])
      expect(readMigrationLauncherEvidence(raw)).toEqual(raw);
  });

  it('keeps platform-specific expectations distinct from observations and prepared trust', () => {
    const expectations: readonly MigrationPlatformExpectations[] = [
      { os: 'darwin', launcher: EXPECTED, daemon: DAEMON },
      {
        os: 'win32',
        package: PACKAGE,
        publisher: 'Example',
        certificateDigest: DIGEST,
        launcherDigest: DIGEST,
        daemonDigest: DIGEST,
      },
      {
        os: 'linux',
        package: PACKAGE,
        installedPackageIdentity: 'example-package',
        launcherDigest: DIGEST,
        daemonDigest: DIGEST,
        continuity: 'process-instance',
      },
    ];
    expect(expectations.map((item) => item.os)).toEqual([
      'darwin',
      'win32',
      'linux',
    ]);
  });

  it.each([windows, linux])(
    'never admits even complete, self-claimed valid metadata: %#',
    (make) => {
      const raw = make();
      const store = createMigrationEvidenceStore();
      const admission = createMigrationAdmission({
        os: raw.os,
        expected: EXPECTED,
        evidence: store,
        host: () => {
          throw new Error('must not read host');
        },
        missingPrerequisites: () => {
          throw new Error('must not read prerequisites');
        },
        onAmbiguity: () => {
          throw new Error('must not report unsupported OS as ambiguity');
        },
      });
      const handle = store.attach(raw);
      expect(admission.admitMigrationConnection(handle)).toMatchObject({
        admitted: false,
        refusal: 'unavailable',
        os: raw.os,
      });
      expect(admission.port.channel(handle)).toBeNull();
      expect(
        authenticateMigrationDestination(
          {
            os: raw.os,
            spawned: { ...raw.captureParent, unreaped: true },
            peer: raw.peer,
          },
          { os: raw.os, expected: DAEMON },
        ),
      ).toMatchObject({
        authenticated: false,
        refusal: 'unavailable',
        os: raw.os,
      });
      const darwin = createMigrationAdmission({
        os: 'darwin',
        expected: EXPECTED,
        evidence: store,
        host: () => {
          throw new Error('must not read mismatched host');
        },
        missingPrerequisites: () => [],
        onAmbiguity: () => undefined,
      });
      expect(darwin.admitMigrationConnection(handle)).toEqual({
        admitted: false,
        refusal: 'refused',
        reason: 'os-mismatch',
      });
    },
  );
});
