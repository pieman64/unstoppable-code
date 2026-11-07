import {
  createWindowsMigrationVerifier,
  type PreparedWindowsMigrationTrust,
  type WindowsMigrationCapture,
  type WindowsMigrationVerifier,
  type WindowsVerificationResult,
} from '../migration-windows-verifier';

const digest = (char = 'a'): string => `sha256:${char.repeat(64)}`;
type Image = ReturnType<PreparedWindowsMigrationTrust['image']>;
interface Fixture {
  capture: WindowsMigrationCapture;
  trust: PreparedWindowsMigrationTrust;
  native: jest.Mock<WindowsMigrationCapture | null, []>;
  close: jest.Mock<void, []>;
  verifier: WindowsMigrationVerifier;
  channel: object;
  verify: () => WindowsVerificationResult;
  lose: () => void;
  withdraw: () => void;
  invalidate: () => void;
}
function fixture(role: 'launcher' | 'daemon' = 'launcher'): Fixture {
  let valid = true;
  let live = true;
  let invalidate = (): void => undefined;
  const close = jest.fn<void, []>();
  const capture: WindowsMigrationCapture = {
    role,
    identity: { os: 'win32', pid: 45, creationTime: 133923461234567891n },
    localPid: 46,
    localParentPid: 45,
    parentPid: 46,
    fileId: '1'.repeat(24),
    digest: digest(),
    commandLine: '"C:\\package\\app.exe"',
    signing: {
      status: 'valid',
      publisher: 'Fixture publisher',
      certificateDigest: digest('c'),
    },
    current: () => live,
    close,
  };
  const trust: PreparedWindowsMigrationTrust = {
    expectations: {
      os: 'win32',
      publisher: 'Fixture publisher',
      certificateDigest: digest('c'),
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
      commandLine: '"C:\\package\\app.exe"',
    }),
    current: () => valid,
    onInvalidate: (callback) => {
      invalidate = callback;
      return jest.fn();
    },
  };
  const native = jest.fn((): WindowsMigrationCapture | null => capture);
  const verifier = createWindowsMigrationVerifier({ trust, capture: native });
  const channel = {};
  const verify = (): WindowsVerificationResult =>
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

describe('Disabled Windows W2 verifier (CAN-5864 migration boundary)', () => {
  it.each(['launcher', 'daemon'] as const)(
    'verifies %s into shared frozen evidence without granting admission',
    (role) => {
      const f = fixture(role);
      const result = f.verify();
      expect(result.verified).toBe(true);
      if (!result.verified) throw new Error('No verification');
      expect(result.evidence).toMatchObject({
        os: 'win32',
        peer: {
          kind: 'captured',
          identity: { creationTime: 133923461234567891n },
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
    ['CLI invocation', { commandLine: '"C:\\package\\app.exe" --cli' }, 'role'],
    [
      'renderer',
      { commandLine: '"C:\\package\\app.exe" --type=renderer' },
      'role',
    ],
    [
      'helper',
      { commandLine: '"C:\\package\\app.exe" --type=utility' },
      'role',
    ],
    ['claimed Electron', { role: 'daemon' }, 'role'],
    ['descendant or sibling opener', { localParentPid: 99 }, 'lineage'],
    [
      'unsigned',
      {
        signing: {
          status: 'unsigned',
          publisher: null,
          certificateDigest: null,
        },
      },
      'signing',
    ],
    [
      'wrong publisher',
      {
        signing: {
          status: 'valid',
          publisher: 'Other',
          certificateDigest: digest('c'),
        },
      },
      'signing',
    ],
    [
      'wrong certificate',
      {
        signing: {
          status: 'valid',
          publisher: 'Fixture publisher',
          certificateDigest: digest('d'),
        },
      },
      'signing',
    ],
    [
      'lossy creation time',
      { identity: { os: 'win32', pid: 45, creationTime: 133923461234567890 } },
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

  it.each([
    'app.exe --type=renderer',
    'app.exe \"--type=utility\"',
    'app.exe \"--run-as-node\"',
    'app.exe --ty"pe"=renderer',
    'app.exe --run-as-"node"',
    'app.exe --type""=utility',
  ])('refuses a prepared helper invocation %s', (commandLine) => {
    const f = fixture();
    Object.assign(f.capture, { commandLine });
    f.trust.image = (): Image => ({
      fileId: f.capture.fileId,
      digest: f.capture.digest,
      commandLine: f.capture.commandLine,
    });
    expect(f.verify()).toEqual({ verified: false, reason: 'role' });
  });

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
    f.native.mockImplementation((): WindowsMigrationCapture => {
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

  it('fences reentrant invalidation, close and retirement during native/host reads', () => {
    for (const action of ['invalidate', 'close'] as const) {
      const f = fixture();
      f.native.mockImplementation((): WindowsMigrationCapture => {
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
