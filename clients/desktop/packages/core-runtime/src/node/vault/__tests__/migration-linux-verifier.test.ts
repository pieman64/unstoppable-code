import {
  createLinuxMigrationVerifier,
  type PreparedLinuxMigrationTrust,
  type LinuxMigrationCapture,
  type LinuxMigrationVerifier,
  type LinuxVerificationResult,
} from '../migration-linux-verifier';

const digest = (char = 'a'): string => `sha256:${char.repeat(64)}`;
type Image = ReturnType<PreparedLinuxMigrationTrust['image']>;
interface Fixture {
  capture: LinuxMigrationCapture;
  trust: PreparedLinuxMigrationTrust;
  native: jest.Mock<LinuxMigrationCapture | null, []>;
  close: jest.Mock<void, []>;
  verifier: LinuxMigrationVerifier;
  channel: object;
  verify: () => LinuxVerificationResult;
  lose: () => void;
  withdraw: () => void;
  invalidate: () => void;
}
function fixture(role: 'launcher' | 'daemon' = 'launcher'): Fixture {
  let valid = true;
  let live = true;
  let invalidate = (): void => undefined;
  const close = jest.fn<void, []>();
  const capture: LinuxMigrationCapture = {
    role,
    identity: {
      os: 'linux',
      pid: 45,
      bootId: '12345678-1234-1234-1234-123456789abc',
      startTime: '133923461234567891',
      continuity: 'process-instance',
    },
    localPid: 46,
    localParentPid: 45,
    parentPid: 46,
    fileId: '1'.repeat(24),
    digest: digest(),
    argv: ['/package/app'],
    current: () => live,
    close,
  };
  const trust: PreparedLinuxMigrationTrust = {
    expectations: {
      os: 'linux',
      installedPackageIdentity: 'fixture-installed-package',
      continuity: 'process-instance',
      launcherDigest: digest(),
      daemonDigest: digest(),
      package: {
        flavorId: 'com.fixture.app',
        secureMode: 'secure',
        buildId: 'exact-build',
        packageDigest: digest('b'),
        codeDigest: digest('d'),
        nativeDigest: digest('e'),
        updateEpoch: 'update-1',
      },
    },
    image: () => ({
      fileId: '1'.repeat(24),
      digest: digest(),
      argv: ['/package/app'],
    }),
    current: () => valid,
    onInvalidate: (callback) => {
      invalidate = callback;
      return jest.fn();
    },
  };
  const native = jest.fn((): LinuxMigrationCapture | null => capture);
  const verifier = createLinuxMigrationVerifier({ trust, capture: native });
  const channel = {};
  const verify = (): LinuxVerificationResult =>
    role === 'launcher'
      ? verifier.verifyLauncher(channel)
      : verifier.verifyDestination(channel);
  return {
    capture,
    close,
    trust,
    native,
    verifier,
    channel,
    verify,
    lose: (): void => {
      live = false;
    },
    withdraw: (): void => {
      valid = false;
    },
    invalidate: (): void => invalidate(),
  };
}

describe('Disabled Linux L2 verifier (CAN-5877 migration boundary)', () => {
  it.each(['launcher', 'daemon'] as const)(
    'verifies %s into shared frozen evidence without granting admission',
    (role) => {
      const f = fixture(role);
      const result = f.verify();
      expect(result.verified).toBe(true);
      if (!result.verified) throw new Error('No verification');
      expect(result.evidence).toMatchObject({
        os: 'linux',
        peer: {
          kind: 'captured',
          identity: {
            bootId: '12345678-1234-1234-1234-123456789abc',
            startTime: '133923461234567891',
            continuity: 'process-instance',
          },
          artifact: { package: { buildId: 'exact-build' } },
        },
      });
      expect(Object.isFrozen(result.evidence)).toBe(true);
      expect(f.verifier.lookup(result.handle, f.channel)).toBe(result.evidence);
      expect(f.verifier.lookup(result.handle, {})).toBeNull();
      expect(f.verifier.lookup({}, f.channel)).toBeNull();
      expect(f.verify()).toEqual({ verified: false, reason: 'replay' });
      f.verifier.retire(result.handle);
      expect(f.verifier.lookup(result.handle, f.channel)).toBeNull();
      expect(f.close).toHaveBeenCalledTimes(1);
      f.verifier.close();
    },
  );

  it.each([
    ['wrong opener instance/image', { fileId: '2'.repeat(24) }, 'image'],
    ['exact build digest', { digest: digest('b') }, 'image'],
    ['CLI invocation', { argv: ['/package/app', '--cli'] }, 'role'],
    ['renderer', { argv: ['/package/app', '--type=renderer'] }, 'role'],
    ['helper', { argv: ['/package/app', '--type=utility'] }, 'role'],
    ['product child', { argv: ['/package/app', 'child'] }, 'role'],
    ['claimed Electron', { role: 'daemon' }, 'role'],
    ['descendant or sibling', { localParentPid: 99 }, 'lineage'],
    [
      'lossy starttime',
      {
        identity: {
          os: 'linux',
          pid: 45,
          bootId: '12345678-1234-1234-1234-123456789abc',
          startTime: 133923461234567890,
          continuity: 'process-instance',
        },
      },
      'malformed-evidence',
    ],
    ['missing image', { digest: '' }, 'image'],
  ])('refuses %s', (_name, patch, reason) => {
    const f = fixture();
    Object.assign(f.capture, patch);
    expect(f.verify()).toEqual({ verified: false, reason });
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.verify()).toEqual({ verified: false, reason: 'replay' });
    f.verifier.close();
  });

  it.each(['--type=renderer', '--type=utility', '--run-as-node', '--type'])(
    'refuses a prepared helper invocation %s',
    (arg) => {
      const f = fixture();
      Object.assign(f.capture, { argv: ['/package/app', arg] });
      f.trust.image = (): Image => ({
        fileId: f.capture.fileId,
        digest: f.capture.digest,
        argv: f.capture.argv,
      });
      expect(f.verify()).toEqual({ verified: false, reason: 'role' });
    },
  );

  it.each([[[]], [['']], [['/package/app', 'bad\0argument']]])(
    'refuses empty or malformed invocation %j',
    (argv) => {
      const f = fixture();
      Object.assign(f.capture, { argv });
      f.trust.image = (): Image => ({
        fileId: f.capture.fileId,
        digest: f.capture.digest,
        argv,
      });
      expect(f.verify()).toEqual({ verified: false, reason: 'role' });
    },
  );

  it.each([null, undefined, '', '   '])(
    'refuses unauthenticated or empty installed-package identity %j',
    (identity) => {
      const f = fixture();
      Object.assign(f.trust.expectations, {
        installedPackageIdentity: identity,
      });
      expect(f.verify()).toEqual({
        verified: false,
        reason: 'trust-unavailable',
      });
      expect(f.native).not.toHaveBeenCalled();
    },
  );

  it('refuses a daemon not parented by its actual launcher', () => {
    const f = fixture('daemon');
    Object.assign(f.capture, { parentPid: 99 });
    expect(f.verify()).toEqual({ verified: false, reason: 'lineage' });
  });

  it('refuses generic tokens, remote and payload-forged channels without native custody', () => {
    const f = fixture();
    f.native.mockReturnValue(null);
    for (const channel of [
      { token: 'endpoint' },
      { remote: true },
      { role: 'electron-main' },
    ])
      expect(f.verifier.verifyLauncher(channel)).toEqual({
        verified: false,
        reason: 'no-native-peer',
      });
  });

  it.each(['lose', 'withdraw', 'invalidate'] as const)(
    'retires on %s after verification, not only at admission',
    (action) => {
      const f = fixture();
      const result = f.verify();
      if (!result.verified) throw new Error('No verification');
      f[action]();
      expect(f.verifier.lookup(result.handle, f.channel)).toBeNull();
      expect(f.close).toHaveBeenCalledTimes(1);
      expect(f.verify().verified).toBe(false);
      f.verifier.close();
      expect(f.close).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    'flavorId',
    'secureMode',
    'buildId',
    'packageDigest',
    'codeDigest',
    'nativeDigest',
    'updateEpoch',
  ] as const)('withdraws prepared package trust on %s change', (field) => {
    const f = fixture();
    const result = f.verify();
    if (!result.verified) throw new Error('No verification');
    Object.assign(f.trust.expectations.package, { [field]: 'replacement' });
    expect(f.verifier.lookup(result.handle, f.channel)).toBeNull();
  });

  it('refuses throwing trust and replacement during capture', () => {
    const f = fixture();
    f.native.mockImplementation((): LinuxMigrationCapture => {
      f.withdraw();
      return f.capture;
    });
    expect(f.verify()).toEqual({ verified: false, reason: 'changed' });
    expect(f.close).toHaveBeenCalledTimes(1);
    const g = fixture();
    g.trust.current = (): boolean => {
      throw new Error('trust lost');
    };
    expect(g.verify()).toEqual({
      verified: false,
      reason: 'trust-unavailable',
    });
    expect(g.native).not.toHaveBeenCalled();
  });

  it('refuses replaced package metadata during native capture and retains no receipt', () => {
    const f = fixture();
    f.native.mockImplementation((): LinuxMigrationCapture => {
      Object.assign(f.trust.expectations.package, { codeDigest: digest('f') });
      return f.capture;
    });
    expect(f.verify()).toEqual({ verified: false, reason: 'changed' });
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.verifier.lookup({}, f.channel)).toBeNull();
  });

  it('retires when installed-package identity, artifact pair or pinned invocation changes', () => {
    for (const field of [
      'installedPackageIdentity',
      'launcherDigest',
      'daemonDigest',
      'continuity',
    ]) {
      const f = fixture();
      const result = f.verify();
      if (!result.verified) throw new Error('No verification');
      Object.assign(f.trust.expectations, { [field]: 'changed' });
      expect(f.verifier.lookup(result.handle, f.channel)).toBeNull();
    }
    const f = fixture();
    const result = f.verify();
    if (!result.verified) throw new Error('No verification');
    f.trust.image = (): Image => ({
      fileId: f.capture.fileId,
      digest: f.capture.digest,
      argv: ['/replacement'],
    });
    expect(f.verifier.lookup(result.handle, f.channel)).toBeNull();
  });

  it('fences reentrant invalidation, close and retirement during native/host reads', () => {
    for (const action of ['invalidate', 'close'] as const) {
      const f = fixture();
      f.native.mockImplementation((): LinuxMigrationCapture => {
        if (action === 'close') f.verifier.close();
        else f.invalidate();
        return f.capture;
      });
      expect(f.verify()).toEqual({ verified: false, reason: 'changed' });
      expect(f.close).toHaveBeenCalledTimes(1);
    }
    const f = fixture();
    const result = f.verify();
    if (!result.verified) throw new Error('No verification');
    f.trust.current = (): boolean => {
      f.verifier.retire(result.handle);
      return true;
    };
    expect(f.verifier.lookup(result.handle, f.channel)).toBeNull();
  });

  it('refuses reentrant verification while retiring native pins', () => {
    const f = fixture();
    const first = f.verify();
    if (!first.verified) throw new Error('No verification');
    let duringCleanup: unknown;
    f.capture.close = (): void => {
      f.native.mockReturnValue({
        ...f.capture,
        current: () => true,
        close: () => undefined,
      });
      duringCleanup = f.verifier.verifyLauncher({});
    };
    f.lose();
    expect(f.verifier.lookup(first.handle, f.channel)).toBeNull();
    expect(duringCleanup).toEqual({ verified: false, reason: 'closed' });
    f.verifier.close();
  });
});
