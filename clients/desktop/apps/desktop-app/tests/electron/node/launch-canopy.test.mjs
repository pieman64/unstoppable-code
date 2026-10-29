import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  closeCanopy,
  registerSupervisedProcessTree,
} from '../launchCanopy.mjs';

test(
  'closeCanopy reaps the supervised tree when graceful Electron close stalls',
  { timeout: 1_000 },
  async () => {
    const calls = [];
    const electronApp = {
      close: () => new Promise(() => {}),
    };
    registerSupervisedProcessTree(electronApp, 4242);

    await closeCanopy(electronApp, 'C:\\test-data', {
      platform: 'darwin',
      gracefulCloseTimeoutMs: 1,
      scheduleTimeout: (callback) => {
        callback();
        return 1;
      },
      cancelTimeout: () => {},
      reapTree: async (pid) => calls.push(['reap', pid]),
      removeDataDir: async (dirPath) => calls.push(['remove', dirPath]),
    });

    assert.deepEqual(calls, [
      ['reap', 4242],
      ['remove', 'C:\\test-data'],
      ['remove', 'C:\\test-data-secure'],
    ]);
  },
);

test('closeCanopy does not reap a retired Windows PID after Playwright cleanup', async () => {
  const calls = [];
  let treeAlive = true;
  let now = 0;
  const electronApp = {
    async evaluate(callback) {
      return callback({
        app: {
          quit() {
            calls.push('quit');
          },
          exit(code) {
            calls.push(['exit', code]);
          },
        },
      });
    },
    async close() {
      calls.push('close');
    },
  };
  registerSupervisedProcessTree(electronApp, 4343);

  await closeCanopy(electronApp, 'C:\\test-data', {
    platform: 'win32',
    gracefulCloseTimeoutMs: 1,
    treeExists: () => treeAlive,
    now: () => now,
    wait: async (ms) => {
      now += ms;
    },
    reapTree: async () => {
      if (treeAlive) calls.push('reap');
    },
    removeDataDir: async () => {},
  });

  assert.deepEqual(calls, ['quit', ['exit', 0], 'close']);
});

test('Linux uses an isolated Chromium profile, X11 and libsecret without a mock keychain', async () => {
  const { platformElectronArgs } = await import('../launchCanopy.mjs');
  const args = platformElectronArgs('/tmp/canopy-launch', ['--some-flag'], {
    platform: 'linux',
    uid: () => 1000,
    euid: () => 1000,
  });
  assert.deepEqual(args, [
    '--user-data-dir=/tmp/canopy-launch/electron-profile',
    '--ozone-platform=x11',
    '--password-store=gnome-libsecret',
    '--some-flag',
  ]);
  assert.deepEqual(
    platformElectronArgs('/tmp/test', ['--some-flag'], { platform: 'darwin' }),
    ['--use-mock-keychain', '--some-flag'],
  );
  assert.deepEqual(
    platformElectronArgs('/tmp/test', ['--some-flag'], { platform: 'win32' }),
    ['--use-mock-keychain', '--some-flag'],
  );
});
for (const arg of [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-gpu-sandbox',
  '--user-data-dir=/tmp/outside',
  '--user-data-dir',
  '--ozone-platform=wayland',
  '--password-store=basic',
  '--display=:0',
  '--use-mock-keychain',
]) {
  test(`Linux rejects unsafe launch argument ${arg}`, async () => {
    const { platformElectronArgs } = await import('../launchCanopy.mjs');
    assert.throws(
      () =>
        platformElectronArgs('/tmp/canopy-launch', [arg], {
          platform: 'linux',
          uid: () => 1000,
          euid: () => 1000,
        }),
      /Linux|isolated|sandbox/,
    );
  });
}
test('Linux rejects duplicate switches and retains a validated caller profile', async () => {
  const { platformElectronArgs } = await import('../launchCanopy.mjs');
  const opts = { platform: 'linux', uid: () => 1000, euid: () => 1000 };
  assert.throws(
    () =>
      platformElectronArgs(
        '/tmp/test',
        ['--ozone-platform=x11', '--ozone-platform=x11'],
        opts,
      ),
    /duplicate/,
  );
  assert.ok(
    platformElectronArgs(
      '/tmp/test',
      ['--user-data-dir=/tmp/test/custom'],
      opts,
    ).includes('--user-data-dir=/tmp/test/custom'),
  );
});

test('Linux accepts one libsecret CLI switch and rejects conflicting switches', async () => {
  const { platformElectronArgs } = await import('../launchCanopy.mjs');
  const options = { platform: 'linux', uid: () => 1000, euid: () => 1000 };
  const args = platformElectronArgs(
    '/tmp/canopy-launch',
    ['--password-store=gnome-libsecret'],
    options,
  );
  assert.deepEqual(
    args.filter((arg) => arg.startsWith('--password-store')),
    ['--password-store=gnome-libsecret'],
  );
  assert.throws(
    () =>
      platformElectronArgs(
        '/tmp/canopy-launch',
        ['--password-store=basic'],
        options,
      ),
    /gnome-libsecret/,
  );
  assert.throws(
    () =>
      platformElectronArgs(
        '/tmp/canopy-launch',
        ['--password-store=gnome-libsecret', '--password-store=basic'],
        options,
      ),
    /duplicate/,
  );
  for (const platform of ['darwin', 'win32']) {
    assert.deepEqual(
      platformElectronArgs('/tmp/canopy-launch', [], { platform }),
      ['--use-mock-keychain'],
    );
  }
});
