import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createMigrationSessionRegistry } from '@canopy/core-runtime/node/vault';
import type {
  MigrationHostFacts,
  PreparedWindowsMigrationTrust,
  WindowsMigrationCapture,
} from '@canopy/core-runtime/node/vault';
import { createHostTrustGeneration } from '../prepared-trust';
import {
  createWindowsMigrationComposition,
  qualifyWindowsMigrationComposition,
  prepareWindowsMigrationTrust,
  type WindowsMigrationPackageReport,
} from '../windows-migration';

// CAN-5885 / CAN-4504 W3 migration exemption: injected authenticated policy,
// not genuine signed-Canopy exact-package qualification.
function fixture(): {
  policy: PreparedWindowsMigrationTrust;
  capture: WindowsMigrationCapture;
  closed: jest.Mock;
  host: MigrationHostFacts;
  report: WindowsMigrationPackageReport;
  withdraw: () => void;
} {
  const digest = `sha256:${'a'.repeat(64)}`;
  let invalidate = (): void => undefined;
  const closed = jest.fn();
  return {
    policy: {
      expectations: {
        os: 'win32',
        publisher: 'Fixture publisher',
        certificateDigest: digest,
        launcherDigest: digest,
        daemonDigest: digest,
        package: {
          flavorId: 'com.fixture.app',
          secureMode: 'secure',
          buildId: 'exact-build',
          packageDigest: digest,
          codeDigest: digest,
          nativeDigest: digest,
          updateEpoch: 'epoch-1',
        },
      },
      image: () => ({ fileId: '1'.repeat(24), digest, commandLine: 'app.exe' }),
      current: () => true,
      onInvalidate: (callback) => {
        invalidate = callback;
        return () => undefined;
      },
    },
    closed,
    capture: {
      role: 'launcher',
      identity: { os: 'win32', pid: 45, creationTime: 133923461234567891n },
      localPid: 46,
      localParentPid: 45,
      parentPid: 46,
      fileId: '1'.repeat(24),
      digest,
      commandLine: 'app.exe',
      signing: {
        status: 'valid',
        publisher: 'Fixture publisher',
        certificateDigest: digest,
      },
      current: () => true,
      close: closed,
    },
    host: {
      authorityId: 'local',
      coreAuthority: 'core',
      coreIncarnation: 'incarnation',
      coreDigest: digest,
      buildId: 'exact-build',
      packageDigest: digest,
      updateEpoch: 'epoch-1',
    },
    report: { migrationRole: 'eligible', disabledReasons: [], violations: [] },
    withdraw: () => invalidate(),
  };
}
function composition(
  f = fixture(),
  purpose: 'qualification' | 'production' = 'qualification',
): {
  prepared: NonNullable<ReturnType<typeof prepareWindowsMigrationTrust>>;
  composed: ReturnType<typeof createWindowsMigrationComposition>;
  retireSessions: jest.Mock;
  capture: jest.Mock;
} {
  const prepared = prepareWindowsMigrationTrust({
    policy: f.policy,
    checkPackage: () => f.report,
  });
  if (!prepared) throw new Error('No fixture preparation');
  const retireSessions = jest.fn();
  const capture = jest.fn(() => f.capture);
  return {
    prepared,
    retireSessions,
    capture,
    composed: (purpose === 'production'
      ? createWindowsMigrationComposition
      : qualifyWindowsMigrationComposition)({
      prepared: prepared.capability,
      capture,
      host: () => f.host,
      retireSessions,
    }),
  };
}

describe('Disabled Windows W3 composition (injected policy, not signed Canopy)', () => {
  it('does not mint trust from the real checker succeeding with a disabled report', () => {
    const dir = mkdtempSync(join(tmpdir(), 'windows-migration-package-'));
    const appPath = join(dir, 'Canopy.app');
    try {
      mkdirSync(join(appPath, 'Contents/Resources/bin'), { recursive: true });
      // Same unstaged bundle skeleton as the checker golden; no macOS tools needed.
      // Native Node loads the ESM checker and its TypeScript dependencies, outside Jest.
      const output = execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          `
            import assert from 'node:assert/strict';
            import { loadBrand } from './scripts/brand/load-brand.mjs';
            import {
              assertMigrationRolePackage,
              inspectMigrationRolePackage,
            } from './scripts/lib/check-migration-role-package.mjs';
            const brand = loadBrand('canopy');
            const report = inspectMigrationRolePackage({
              appPath: process.argv[1],
              brands: [brand],
              fuses: { source: 'binary', states: {
                runAsNode: 'off',
                enableNodeOptionsEnvironmentVariable: 'off',
                enableNodeCliInspectArguments: 'off',
                enableEmbeddedAsarIntegrityValidation: 'on',
                onlyLoadAppFromAsar: 'on',
              } },
              readInfoPlist: () => ({ CFBundleIdentifier: brand.appId }),
              readEntitlements: () => ({}),
            });
            assert.doesNotThrow(() => assertMigrationRolePackage(report));
            process.stdout.write(JSON.stringify(report));
          `,
          appPath,
        ],
        { cwd: resolve(__dirname, '../../../..'), encoding: 'utf8' },
      );
      const parsed: unknown = JSON.parse(output);
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        !('migrationRole' in parsed) ||
        (parsed.migrationRole !== 'eligible' &&
          parsed.migrationRole !== 'disabled') ||
        !('disabledReasons' in parsed) ||
        !Array.isArray(parsed.disabledReasons) ||
        !parsed.disabledReasons.every((reason) => typeof reason === 'string') ||
        !('violations' in parsed) ||
        !Array.isArray(parsed.violations) ||
        !parsed.violations.every((violation) => typeof violation === 'string')
      ) {
        throw new Error('Invalid package checker report');
      }
      const report: WindowsMigrationPackageReport = {
        migrationRole: parsed.migrationRole,
        disabledReasons: parsed.disabledReasons,
        violations: parsed.violations,
      };
      expect(report.migrationRole).toBe('disabled');
      expect(report.disabledReasons).toEqual(['daemon:not-staged']);
      expect(report.violations).toEqual([]);
      const f = fixture();
      const image = jest.fn(
        (role: Parameters<PreparedWindowsMigrationTrust['image']>[0]) =>
          f.policy.image(role),
      );
      const prepared = prepareWindowsMigrationTrust({
        policy: { ...f.policy, image },
        checkPackage: () => report,
      });
      expect(prepared).toBeNull();
      expect(image).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it.each([
    null,
    { migrationRole: 'disabled', disabledReasons: [], violations: [] },
    {
      migrationRole: 'disabled',
      disabledReasons: ['fuse:RunAsNode'],
      violations: [],
    },
    {
      migrationRole: 'eligible',
      disabledReasons: ['daemon:not-staged'],
      violations: [],
    },
    {
      migrationRole: 'eligible',
      disabledReasons: [],
      violations: ['wrong build'],
    },
  ] satisfies (WindowsMigrationPackageReport | null)[])(
    'never mints admission trust for a non-positive report: %p',
    (report) => {
      expect(
        prepareWindowsMigrationTrust({
          policy: fixture().policy,
          checkPackage: () => report,
        }),
      ).toBeNull();
    },
  );
  it('fails closed on a throwing checker or prelaunch observation', () => {
    const f = fixture();
    expect(
      prepareWindowsMigrationTrust({
        policy: f.policy,
        checkPackage: () => {
          throw new Error('checker');
        },
      }),
    ).toBeNull();
    Object.assign(f.policy, { current: () => false });
    expect(
      prepareWindowsMigrationTrust({
        policy: f.policy,
        checkPackage: () => f.report,
      }),
    ).toBeNull();
  });
  it('admits only after eligibility AND W2, projecting host-only session facts', () => {
    const f = fixture();
    const c = composition(f);
    const channel = {};
    expect(c.capture).not.toHaveBeenCalled();
    expect(c.composed.admit(channel)).toMatchObject({ admitted: true });
    expect(c.composed.port.channel(channel)).toMatchObject({
      launcher: { os: 'win32', creationTime: 133923461234567891n },
      source: { flavorId: 'com.fixture.app', secureMode: 'secure' },
    });
    expect(c.composed.port.channel({})).toBeNull();
    expect(c.composed.port.host()).toEqual(f.host);
    c.composed.close();
    expect(c.composed.port.channel(channel)).toBeNull();
    expect(c.retireSessions).toHaveBeenCalledTimes(1);
  });
  it('keeps production fail-closed even with eligible package and matching runtime', () => {
    const c = composition(fixture(), 'production');
    const decision = c.composed.admit({});
    expect(decision.admitted).toBe(false);
    if (decision.admitted) throw new Error('Production admitted');
    expect(decision.reason).toContain('CAN-5762');
    expect(decision.reason).toContain('CAN-5865');
    expect(decision.reason).toContain('genuine-signed-package-qualification');
    expect(c.capture).not.toHaveBeenCalled();
    c.composed.close();
  });
  it.each(['production', undefined])(
    'keeps the qualification seam disabled outside tests: %p',
    (environment) => {
      const previous = process.env.NODE_ENV;
      try {
        if (environment === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = environment;
        const c = composition();
        expect(c.composed.admit({}).admitted).toBe(false);
        expect(c.composed.verifyDestination({}).verified).toBe(false);
        expect(c.composed.destination({}, {})).toBeNull();
        expect(c.capture).not.toHaveBeenCalled();
        c.composed.close();
      } finally {
        if (previous === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = previous;
      }
    },
  );
  it('rejects native-preparation, foreign generations, clones and serialized capabilities', () => {
    const c = composition();
    const serialized: unknown = JSON.parse(
      JSON.stringify(c.prepared.capability),
    );
    for (const capability of [
      createHostTrustGeneration('package-admission').issue(),
      { ...c.prepared.capability },
      serialized,
      createHostTrustGeneration('native-preparation').issue(),
    ]) {
      const composed = qualifyWindowsMigrationComposition({
        prepared: capability,
        capture: c.capture,
        host: () => fixture().host,
        retireSessions: jest.fn(),
      });
      expect(composed.admit({})).toMatchObject({ admitted: false });
      composed.close();
    }
    expect(c.capture).not.toHaveBeenCalled();
    c.composed.close();
  });
  it.each(['digest', 'publisher', 'role', 'lineage', 'missing', 'lost'])(
    'eligibility does not bypass runtime refusal: %s',
    (kind) => {
      const f = fixture();
      const c = composition(f);
      if (kind === 'digest')
        Object.assign(f.capture, { digest: `sha256:${'b'.repeat(64)}` });
      if (kind === 'publisher')
        Object.assign(f.capture.signing, { publisher: 'Other' });
      if (kind === 'role')
        Object.assign(f.capture, { commandLine: 'app.exe --type=renderer' });
      if (kind === 'lineage') Object.assign(f.capture, { localParentPid: 99 });
      if (kind === 'missing') c.capture.mockReturnValue(null);
      if (kind === 'lost') Object.assign(f.capture, { current: () => false });
      expect(c.composed.admit({})).toMatchObject({ admitted: false });
      expect(c.retireSessions).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    'invalidate',
    'withdraw',
    'update',
    'code',
    'native',
    'disabled',
    'loss',
    'host',
  ])('retires channel, W2 receipts and sessions permanently on %s', (kind) => {
    const f = fixture();
    const c = composition(f);
    const channel = {};
    expect(c.composed.admit(channel).admitted).toBe(true);
    if (kind === 'invalidate') c.prepared.invalidate();
    if (kind === 'withdraw') f.withdraw();
    if (kind === 'update')
      Object.assign(f.policy.expectations.package, { updateEpoch: 'epoch-2' });
    if (kind === 'code')
      Object.assign(f.policy.expectations.package, {
        codeDigest: `sha256:${'b'.repeat(64)}`,
      });
    if (kind === 'native')
      Object.assign(f.policy.expectations.package, {
        nativeDigest: `sha256:${'b'.repeat(64)}`,
      });
    if (kind === 'disabled')
      Object.assign(f.report, { migrationRole: 'disabled' });
    if (kind === 'loss') Object.assign(f.capture, { current: () => false });
    if (kind === 'host') Object.assign(f.host, { coreIncarnation: 'next' });
    expect(c.composed.port.channel(channel)).toBeNull();
    expect(c.retireSessions).toHaveBeenCalledTimes(1);
    expect(f.closed).toHaveBeenCalledTimes(1);
    expect(() => c.composed.port.host()).toThrow();
    expect(c.composed.admit(channel).admitted).toBe(false);
  });
  it('withdrawal revokes a real issued migration session through the composed port', () => {
    const c = composition();
    const channel = {};
    expect(c.composed.admit(channel).admitted).toBe(true);
    const registry = createMigrationSessionRegistry(
      {
        admission: c.composed.port,
        source: {
          currentGeneration: () => 'generation-1',
          isFenced: () => false,
          fence: jest.fn(),
          slotProgress: () => ({ state: 'not_started' }),
        },
        importer: { createIfAbsent: () => Promise.resolve({ kind: 'exists' }) },
      },
      { os: 'win32' },
    );
    c.retireSessions.mockImplementation(() =>
      registry.reportAmbiguity('trust-withdrawn'),
    );
    const issued = registry.issue(channel, 'github-pat');
    expect(issued.issued).toBe(true);
    if (!issued.issued) throw new Error('No session');
    c.prepared.invalidate();
    expect(registry.get(issued.offer.sessionId)).toMatchObject({
      state: 'revoked',
    });
    expect(registry.issue(channel, 'github-pat').issued).toBe(false);
    registry.close();
  });
  it('refuses prelaunch update changes before taking a native capture', () => {
    const f = fixture();
    const c = composition(f);
    Object.assign(f.policy.expectations.package, { updateEpoch: 'epoch-2' });
    expect(c.composed.admit({}).admitted).toBe(false);
    expect(c.capture).not.toHaveBeenCalled();
  });
  it('refuses a second channel and retires the first and its sessions', () => {
    const c = composition();
    const channel = {};
    expect(c.composed.admit(channel).admitted).toBe(true);
    expect(c.composed.admit({})).toMatchObject({
      admitted: false,
      reason: 'replay',
    });
    expect(c.composed.port.channel(channel)).toBeNull();
    expect(c.retireSessions).toHaveBeenCalledTimes(1);
  });
  it.each(['same-channel', 'other-channel', 'launcher'])(
    'retires destination receipts and sessions on a second verification: %s',
    (kind) => {
      const f = fixture();
      Object.assign(f.capture, { role: 'daemon' });
      const c = composition(f);
      const channel = {};
      const result = c.composed.verifyDestination(channel);
      expect(result.verified).toBe(true);
      if (!result.verified) throw new Error('No destination verification');
      expect(c.composed.destination(result.handle, channel)).not.toBeNull();
      if (kind === 'launcher')
        expect(c.composed.admit({})).toMatchObject({
          admitted: false,
          reason: 'replay',
        });
      else
        expect(
          c.composed.verifyDestination(kind === 'same-channel' ? channel : {}),
        ).toMatchObject({
          verified: false,
          reason: 'replay',
        });
      expect(c.retireSessions).toHaveBeenCalledTimes(1);
      expect(c.composed.destination(result.handle, channel)).toBeNull();
      expect(f.closed).toHaveBeenCalledTimes(1);
    },
  );
  it.each(['throw', 'disabled'])(
    'permanently withdraws issued trust after a later non-positive checker read: %s',
    (kind) => {
      const f = fixture();
      let readable = true;
      const prepared = prepareWindowsMigrationTrust({
        policy: f.policy,
        checkPackage: () => {
          if (!readable) {
            if (kind === 'throw') throw new Error('Package observation lost');
            return {
              migrationRole: 'disabled',
              disabledReasons: [],
              violations: [],
            };
          }
          return f.report;
        },
      });
      if (!prepared) throw new Error('No fixture preparation');
      const c = qualifyWindowsMigrationComposition({
        prepared: prepared.capability,
        capture: () => f.capture,
        host: () => f.host,
        retireSessions: jest.fn(),
      });
      const channel = {};
      expect(c.admit(channel).admitted).toBe(true);
      readable = false;
      expect(c.port.channel(channel)).toBeNull();
      readable = true;
      expect(c.port.channel(channel)).toBeNull();
      expect(c.admit(channel).admitted).toBe(false);
      const capture = jest.fn(() => f.capture);
      const another = qualifyWindowsMigrationComposition({
        prepared: prepared.capability,
        capture,
        host: () => f.host,
        retireSessions: jest.fn(),
      });
      expect(another.admit({}).admitted).toBe(false);
      expect(capture).not.toHaveBeenCalled();
      another.close();
    },
  );
  it('does not admit across reentrant invalidation during host or native reads', () => {
    for (const phase of ['host', 'capture']) {
      const f = fixture();
      const c = composition(f);
      if (phase === 'host')
        Object.defineProperty(f.host, 'buildId', {
          get: () => {
            c.prepared.invalidate();
            return 'exact-build';
          },
        });
      else
        c.capture.mockImplementation(() => {
          c.prepared.invalidate();
          return f.capture;
        });
      expect(c.composed.admit({}).admitted).toBe(false);
      expect(c.retireSessions).toHaveBeenCalledTimes(1);
    }
  });
});
