import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Opt in only on a provisioned qualification host; CI rejects skipped cases.
// When enabled, missing dependencies fail rather than silently skipping.
// Real GNOME covers noninteractive behavior; controlled providers qualify
// q-26/q-28 protocol safety, not rendered OS unlock UI.
const linuxDescribe =
  process.platform === 'linux' &&
  process.env.CANOPY_SECRET_SERVICE_QUALIFICATION === '1'
    ? describe
    : describe.skip;
const root = path.resolve(__dirname, '../../../..');
const child = path.join(__dirname, 'fixtures/secret-service-child.ts');
let directory = '';
let product = '';
let fixture = '';
let controlled = '';
linuxDescribe(
  'Linux Secret Service native qualification (private GNOME and controlled providers)',
  () => {
    beforeAll(() => {
      for (const binary of [
        '/usr/bin/dbus-daemon',
        '/usr/bin/gnome-keyring-daemon',
        '/usr/bin/gdbus',
        '/usr/bin/pkg-config',
        '/usr/bin/cc',
      ]) {
        try {
          execFileSync('/usr/bin/test', ['-x', binary]);
        } catch {
          throw new Error(
            `Linux native qualification prerequisite missing: ${binary}`,
          );
        }
      }
      directory = mkdtempSync(path.join(tmpdir(), 'linux-secret-build-'));
      product = path.join(directory, 'secret-product.node');
      fixture = path.join(directory, 'secret-fixture.node');
      execFileSync(
        process.execPath,
        [
          'scripts/build-secret-protection.mjs',
          '--out',
          product,
          '--fixture-out',
          fixture,
        ],
        {
          cwd: root,
          timeout: 60_000,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      const sea: unknown = JSON.parse(
        execFileSync(
          process.execPath,
          [
            'scripts/lib/native-vault-sea-qualification.mjs',
            product,
            path.join(directory, 'renamed-sea'),
          ],
          { cwd: root, encoding: 'utf8', timeout: 90_000 },
        )
          .trim()
          .split(/\r?\n/)
          .at(-1) ?? '',
      );
      expect(sea).toMatchObject({
        valid: { loads: 1 },
        replaced: { loads: 0 },
      });
      controlled = path.join(directory, 'controlled-service');
      const flags = execFileSync(
        '/usr/bin/pkg-config',
        ['--cflags', '--libs', 'gio-2.0'],
        { encoding: 'utf8' },
      )
        .trim()
        .split(/\s+/);
      execFileSync(
        '/usr/bin/cc',
        [
          '-std=c11',
          '-O2',
          '-Wall',
          '-Wextra',
          '-Werror',
          path.join(__dirname, 'fixtures/secret-service-controlled.c'),
          '-o',
          controlled,
          ...flags,
        ],
        { timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] },
      );
    }, 170_000);
    afterAll(() => {
      if (directory) rmSync(directory, { recursive: true, force: true });
    });
    test.each([
      'roundtrip',
      'duplicates',
      'malformed',
      'locked',
      'no-bus',
      'conformance',
      'namespace',
      'unavailable',
      'no-provider',
    ])(
      'real provider: %s',
      (mode) => {
        const output = execFileSync(
          process.execPath,
          [child, product, fixture, mode],
          {
            cwd: root,
            encoding: 'utf8',
            timeout: 20_000,
            // Child constructs private HOME/XDG and a bus; never inherits them.
            env: { PATH: '/usr/bin:/bin', TMPDIR: tmpdir() },
          },
        );
        const report: unknown = JSON.parse(output);
        expect(report).toEqual(expect.objectContaining({ passed: true, mode }));
        if (mode === 'conformance')
          expect(report).toEqual(
            expect.objectContaining({ contractCases: 14 }),
          );
      },
      25_000,
    );
    test.each([
      'create',
      'replace',
      'delete',
      'transport',
      'read-transport',
      'prompt-abort',
      'prompt-completed',
      'prompt-create-abort',
      'prompt-reply-abort',
      'prompt-queued-abort',
      'prompt-success',
      'locked-never',
      'prompt-transport',
      'bus-transport',
      'prompt-bus-transport',
    ])(
      'controlled provider: %s',
      (mode) => {
        const output = execFileSync(
          process.execPath,
          [
            path.join(__dirname, 'fixtures/secret-service-controlled.ts'),
            product,
            controlled,
            mode,
          ],
          {
            cwd: root,
            encoding: 'utf8',
            timeout: 20_000,
            env: { PATH: '/usr/bin:/bin', TMPDIR: tmpdir() },
          },
        );
        const report: unknown = JSON.parse(output);
        expect(report).toEqual({ passed: true, mode });
      },
      25_000,
    );
  },
);
