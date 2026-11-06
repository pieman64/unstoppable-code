import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Opt in only on a qualification host; CI requires every case to execute.
const darwinDescribe =
  process.platform === 'darwin' &&
  process.env.CANOPY_KEYCHAIN_QUALIFICATION === '1'
    ? describe
    : describe.skip;
const root = path.resolve(__dirname, '../../../..');
const child = path.join(__dirname, 'fixtures/secret-protection-child.ts');
let directory = '';
let fixture = '';
let product = '';
let keychain = '';
let home = '';
let cleanupPending = false;
interface KeychainPreferences {
  readonly search: string;
  readonly default: string;
}
let initialPreferences: KeychainPreferences | undefined;
function preferences(): KeychainPreferences {
  const read = (command: string): string =>
    execFileSync('/usr/bin/security', [command, '-d', 'user'], {
      encoding: 'utf8',
      timeout: 10_000,
    });
  return { search: read('list-keychains'), default: read('default-keychain') };
}
function assertPreferencesUnchanged(): void {
  if (initialPreferences === undefined)
    throw new Error('No real-user Keychain preference snapshot.');
  const current = preferences();
  if (
    current.search !== initialPreferences.search ||
    current.default !== initialPreferences.default
  ) {
    throw new Error(
      'Native qualification changed the real user Keychain search list or default. Stop qualification; never restore preferences automatically.',
    );
  }
}
function runChild(args: string[], timeout = 25_000): string {
  let beforeFailure: Error | undefined;
  try {
    assertPreferencesUnchanged();
  } catch (error) {
    if (args[args.length - 1] !== 'cleanup') throw error;
    // Failure cleanup must run, but must not erase the failed observation.
    beforeFailure =
      error instanceof Error
        ? error
        : new Error('Keychain preference snapshot failed.');
  }
  let result = '';
  let childFailed = false;
  let childFailure: unknown;
  try {
    result = execFileSync(process.execPath, args, {
      cwd: root,
      encoding: 'utf8',
      timeout,
      // Defense in depth only: parent-side snapshots, not these overrides, prove isolation.
      env: {
        PATH: '/usr/bin:/bin',
        TMPDIR: tmpdir(),
        HOME: home,
        CFFIXED_USER_HOME: home,
      },
    });
  } catch (error) {
    childFailed = true;
    childFailure = error;
  }
  assertPreferencesUnchanged();
  if (beforeFailure) throw beforeFailure;
  if (childFailed) throw childFailure;
  return result;
}

function run(mode: string): Record<string, unknown> {
  const result = runChild([child, root, fixture, keychain, mode]);
  const parsed: unknown = JSON.parse(result);
  if (typeof parsed !== 'object' || parsed === null)
    throw new Error('No fixture report.');
  return {
    ...Object.fromEntries(Object.entries(parsed)),
    preferencesUnchanged: true,
  };
}

darwinDescribe(
  'standalone Node macOS key slots (disposable Keychain only)',
  () => {
    beforeAll(() => {
      initialPreferences = preferences();
      directory = mkdtempSync(path.join(tmpdir(), 'key-slot-native-'));
      fixture = path.join(directory, 'key-slot-fixture.node');
      product = path.join(directory, 'key-slot-product.node');
      keychain = path.join(directory, 'disposable.keychain-db');
      home = path.join(directory, 'home');
      mkdirSync(path.join(home, 'Library', 'Keychains'), {
        recursive: true,
        mode: 0o700,
      });
      runChild(
        [
          'scripts/build-secret-protection.mjs',
          '--out',
          product,
          '--fixture-out',
          fixture,
        ],
        60_000,
      );
    }, 65_000);
    afterAll(() => {
      try {
        if (cleanupPending) run('cleanup');
      } finally {
        try {
          if (initialPreferences) assertPreferencesUnchanged();
        } finally {
          if (directory) rmSync(directory, { recursive: true, force: true });
        }
      }
    });
    beforeEach(() => {
      rmSync(path.join(directory, 'vault'), { recursive: true, force: true });
      cleanupPending = true;
      run('create');
    });
    afterEach(() => {
      if (cleanupPending) {
        run('cleanup');
        cleanupPending = false;
      }
    });

    test('native adapter passes the existing conformance kit and atomic concurrent create', () => {
      const report = run('conformance');
      expect(report.tests).toEqual(expect.any(Number));
      expect(Number(report.tests)).toBeGreaterThan(10);
      expect(Number(report.apiCalls)).toBeGreaterThan(10);
      expect(report.prompts).toBe(0);
      expect(report.ownedBytes).toBe(0);
      expect(report.preferencesUnchanged).toBe(true);
    }, 30_000);
    test('a slot written by one Node process recovers in another, across lock and unlock', () => {
      run('write');
      run('read');
      run('lock');
      run('unlock');
      run('read');
    }, 30_000);
    test('durable vault restart preserves ciphertext through missing, malformed and wrong key recovery', () => {
      run('repository-write');
      run('repository-recover');
    }, 30_000);
    test('native OSStatus mapping preserves absence, refusal, corruption and uncertainty', () => {
      run('mapping');
    });
    test('fixture-only unlock answers exercise prompt counting and typed outcomes without OS UI', () => {
      const report = run('prompt');
      expect(report.prompts).toBe(5);
      expect(report.ownedBytes).toBe(0);
      expect(report.preferencesUnchanged).toBe(true);
    });
    test('an unavailable explicit Keychain is not absence', () => {
      run('unavailable');
    });
    test('V-3 isolates all eight brand + build namespaces and distinct authorities', () => {
      run('namespace');
    });
    test('product binary has no fixture controls and validates names before Keychain access', () => {
      const script = `
      const m = { exports: {} }; process.dlopen(m, process.argv[1]);
      const assert = require('node:assert/strict');
      assert.equal(m.exports.fixture, false);
      assert.equal(m.exports.control, undefined);
      assert.equal(m.exports.diagnostics, undefined);
      assert.equal(m.exports.mapStatus, undefined);
      // Invalid service/account and fixture path are refused before opening login storage.
      const service = 'canopy.dev.vault';
      const account = service + '/${'a'.repeat(64)}/test';
      assert.throws(() => m.exports.run('read', 'unknown.vault', account, new Uint8Array()), TypeError);
      assert.throws(() => m.exports.run('read', service, 'invalid', new Uint8Array()), TypeError);
      assert.throws(() => m.exports.run('read', service, account, new Uint8Array(), '/fixture.keychain-db'), TypeError);
      assert.throws(() => m.exports.run('unlock', service, account, new Uint8Array(), '/fixture.keychain-db', 'success'), TypeError);
    `;
      expect(() => runChild(['-e', script, product], 10_000)).not.toThrow();
    });
  },
);
