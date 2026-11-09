// CAN-5862: a daemon an E2E spec keeps across an app quit outlives the app,
// and the supervisor's watchdog reaps it once the test worker that kept it is
// gone, even when that worker is killed before its cleanup runs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  SUPERVISED_RETAIN_FILE_ENV,
  createPosixProcessTreeOwner,
  holdRetainedTree,
  listPosixProcesses,
} from './process-tree-supervisor.mjs';

const SUPERVISOR = fileURLToPath(
  new URL('./process-tree-supervisor.mjs', import.meta.url),
);
const posix = process.platform === 'win32' ? test.skip : test;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(message);
    await delay(50);
  }
}

async function identity(pid) {
  const row = (await listPosixProcesses()).find(
    (candidate) => candidate.pid === pid,
  );
  assert.ok(row, `process ${pid} is listed`);
  return { pid, startTime: row.startTime };
}

function sleeper() {
  const child = spawn('sleep', ['60'], { stdio: 'ignore' });
  child.unref();
  return child;
}

/** A stand-in app whose detached child, in a group of its own, is the daemon. */
async function appWithDaemon() {
  const app = spawn(
    process.execPath,
    [
      '-e',
      "const d = require('node:child_process').spawn('sleep', ['60'], { detached: true, stdio: 'ignore' }); d.unref(); console.log(d.pid); setInterval(() => {}, 1000);",
    ],
    // Its own group, as the supervisor launches Electron.
    { stdio: ['ignore', 'pipe', 'ignore'], detached: true },
  );
  const daemon = await new Promise((resolve) => {
    app.stdout.once('data', (chunk) => resolve(Number(String(chunk).trim())));
  });
  return { app, daemon };
}

function kill(pid, signal = 'SIGKILL') {
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone.
  }
}

posix(
  'the watchdog keeps a retained daemon while its worker lives and reaps it when the worker is killed',
  async (t) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'c5862-retain-'));
    const groupsFile = path.join(dir, 'groups.ndjson.watchdog');
    const retainFile = path.join(dir, 'retain.json');
    const nonce = randomUUID();
    const supervisor = sleeper();
    const controller = sleeper();
    const { app, daemon } = await appWithDaemon();
    const watchdog = spawn(
      process.execPath,
      [
        SUPERVISOR,
        '--canopy-process-tree-watchdog',
        String(supervisor.pid),
        String(app.pid),
        groupsFile,
        nonce,
      ],
      {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: {
          ...process.env,
          [SUPERVISED_RETAIN_FILE_ENV]: retainFile,
          CANOPY_E2E_TREE_REFRESH_MS: '100',
        },
      },
    );
    t.after(() => {
      for (const pid of [watchdog.pid, supervisor.pid, controller.pid, app.pid])
        kill(pid);
      kill(-daemon);
      rmSync(dir, { recursive: true, force: true });
    });

    // The watchdog tracks the daemon's group through the app's lineage.
    await until(
      () =>
        existsSync(groupsFile) &&
        readFileSync(groupsFile, 'utf8').includes(`"pgid":${daemon}`),
      10_000,
      'the watchdog never tracked the daemon group',
    );
    writeFileSync(
      retainFile,
      JSON.stringify({
        v: 1,
        nonce,
        ...(await identity(daemon)),
        controller: await identity(controller.pid),
      }),
    );

    // The app and its supervisor exit; the watchdog ends the rest of the tree.
    kill(app.pid);
    kill(supervisor.pid);
    await delay(1_000);
    assert.equal(alive(daemon), true, 'the retained daemon outlives the app');
    assert.equal(alive(watchdog.pid), true, 'the watchdog holds the daemon');

    // The worker dies without its cleanup; the watchdog reaps the daemon.
    kill(controller.pid);
    await until(() => !alive(daemon), 10_000, 'the daemon was not reaped');
    await until(
      () => !alive(watchdog.pid),
      10_000,
      'the watchdog did not exit',
    );
  },
);

posix('holding ends without signals once the worker cleaned up', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'c5862-hold-'));
  const retainFile = path.join(dir, 'retain.json');
  const nonce = randomUUID();
  const controller = sleeper();
  const daemon = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
  daemon.unref();
  try {
    writeFileSync(
      retainFile,
      JSON.stringify({
        v: 1,
        nonce,
        ...(await identity(daemon.pid)),
        controller: await identity(controller.pid),
      }),
    );
    const signals = [];
    const held = holdRetainedTree({
      retainFile,
      runNonce: nonce,
      pollIntervalMs: 50,
      killTree: async (pgid, signal) => {
        signals.push([pgid, signal]);
      },
    });
    await delay(300);
    kill(daemon.pid);
    assert.equal(await held, 'gone');
    assert.deepEqual(signals, []);
    // Another launch's record retains nothing.
    assert.equal(
      await holdRetainedTree({ retainFile, runNonce: randomUUID() }),
      'none',
    );
  } finally {
    kill(controller.pid);
    kill(daemon.pid);
    rmSync(dir, { recursive: true, force: true });
  }
});

posix(
  'a process that outlives the retained daemon is reaped with it when the worker is gone',
  async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'c5862-orphan-'));
    const retainFile = path.join(dir, 'retain.json');
    const nonce = randomUUID();
    const controller = sleeper();
    // The daemon and its detached child (a pipeline host or step).
    const { app: daemonProcess, daemon: child } = await appWithDaemon();
    try {
      writeFileSync(
        retainFile,
        JSON.stringify({
          v: 1,
          nonce,
          ...(await identity(daemonProcess.pid)),
          controller: await identity(controller.pid),
        }),
      );
      const held = holdRetainedTree({
        retainFile,
        runNonce: nonce,
        pollIntervalMs: 50,
      });
      let settled = false;
      void held.then(() => {
        settled = true;
      });
      await delay(300);
      // The daemon dies first; its child is reparented away from it.
      kill(daemonProcess.pid);
      await until(
        () => !alive(daemonProcess.pid),
        5_000,
        'the daemon did not exit',
      );
      await delay(300);
      assert.equal(alive(child), true);
      assert.equal(settled, false, 'the hold still owns the surviving child');
      kill(controller.pid);
      assert.equal(await held, 'reaped');
      await until(() => !alive(child), 5_000, 'the child was not reaped');
    } finally {
      kill(controller.pid);
      kill(daemonProcess.pid);
      kill(-child);
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

/**
 * A stand-in app in its own group whose detached child (the daemon) starts a
 * detached child of its own (a pipeline host or step).
 */
async function appWithDaemonAndStep() {
  const daemonScript =
    "const s = require('node:child_process').spawn('sleep', ['60'], { detached: true, stdio: 'ignore' }); s.unref(); console.log(s.pid); setInterval(() => {}, 1000);";
  const app = spawn(
    process.execPath,
    [
      '-e',
      `const d = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(daemonScript)}], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] }); d.stdout.once('data', (c) => console.log(d.pid + ' ' + String(c).trim())); d.unref(); setInterval(() => {}, 1000);`,
    ],
    { stdio: ['ignore', 'pipe', 'ignore'], detached: true },
  );
  const [daemon, step] = await new Promise((resolve) => {
    app.stdout.once('data', (chunk) =>
      resolve(String(chunk).trim().split(' ').map(Number)),
    );
  });
  return { app, daemon, step };
}

posix(
  "the tree owner hands the hold the processes it spared, so one the daemon leaves behind before the hold's first snapshot is reaped",
  async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'c5862-handoff-'));
    const retainFile = path.join(dir, 'retain.json');
    const nonce = randomUUID();
    const controller = sleeper();
    const { app, daemon, step } = await appWithDaemonAndStep();
    try {
      const owner = createPosixProcessTreeOwner(app, {
        retainFile,
        runNonce: nonce,
        graceMs: 200,
      });
      assert.equal(await owner.ready, true);
      await until(
        async () => {
          await owner.refresh();
          return owner
            .trackedGroups()
            .some((group) => group.pgid === step && group.members.has(step));
        },
        10_000,
        'the owner never tracked the step group',
      );
      writeFileSync(
        retainFile,
        JSON.stringify({
          v: 1,
          nonce,
          ...(await identity(daemon)),
          controller: await identity(controller.pid),
        }),
      );
      // The app exits; only retained groups are left when the owner stops.
      kill(app.pid);
      await until(() => !alive(app.pid), 5_000, 'the app did not exit');
      await owner.stop();
      assert.equal(alive(daemon), true, 'the owner spared the daemon');
      const known = owner.retainedMembers();
      assert.equal(known.has(step), true, 'the owner hands over the step');
      // The daemon goes before the hold's first snapshot; the step survives.
      kill(daemon);
      await until(() => !alive(daemon), 5_000, 'the daemon did not exit');
      const held = holdRetainedTree({
        retainFile,
        runNonce: nonce,
        pollIntervalMs: 50,
        known,
      });
      let settled = false;
      void held.then(() => {
        settled = true;
      });
      await delay(300);
      assert.equal(settled, false, 'the hold owns the surviving step');
      kill(controller.pid);
      assert.equal(await held, 'reaped');
      await until(() => !alive(step), 5_000, 'the step was not reaped');
    } finally {
      kill(controller.pid);
      kill(app.pid);
      kill(-daemon);
      kill(-step);
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
