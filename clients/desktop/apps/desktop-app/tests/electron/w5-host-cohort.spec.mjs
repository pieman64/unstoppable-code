// CAN-3797 W11-2: Electron main joins the W5 host cohort at startup, so
// offline maintenance refuses while the app (or a CLI) runs, and the app
// refuses to start while maintenance holds its data folder. Real processes
// on one data root: the built app, the desktop CLI entry, and a test
// composition of `runW5Maintenance` that never registers as a host.
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';
import { expect, test } from '@playwright/test';
import {
  buildE2eLaunchMarkerEnv,
  buildElectronEnv,
  platformElectronArgs,
  removeTestDataDir,
  resolveE2eMainEntryPath,
} from './launchCanopy.mjs';
import {
  crashKeepingData,
  launchW5App,
  quitGracefullyKeepingData,
} from './parity/w5-fixtures.mjs';
import { buildW5MaintenanceComposition } from './helpers/w5-maintenance-composition.mjs';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
const MAINTENANCE_HELD =
  'Data maintenance is running. Try again when it finishes.';

test.describe.configure({ timeout: 300_000 });
test.skip(
  process.platform === 'win32',
  'Windows registration is a no-op and maintenance refuses (CAN-3797 Q4)',
);

let workDir;
let composition;
let userDataDir;
let root;
const children = new Set();
const openApps = new Set();

/** Host-cohort members of the data root, as `{ pid, hostKind }`. */
function members() {
  const hosts = path.join(root, 'runtime', 'hosts');
  if (!existsSync(hosts)) return [];
  return readdirSync(hosts)
    .filter((name) => !name.startsWith('.'))
    .map((name) => {
      const { pid, hostKind } = JSON.parse(
        readFileSync(path.join(hosts, name), 'utf8'),
      );
      return { pid, hostKind };
    })
    .sort((a, b) => a.hostKind.localeCompare(b.hostKind));
}

function maintenanceRecordExists() {
  return existsSync(path.join(root, 'runtime', 'w5-maintenance.json'));
}

function track(child) {
  children.add(child);
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  // `close`, not `exit`: stderr is complete only once its stream closes.
  const exited = new Promise((resolve) =>
    child.once('close', (code, signal) => {
      children.delete(child);
      resolve({ code: code ?? signal, stderr });
    }),
  );
  return { child, exited };
}

/** The real CLI entry on the data root; `hold` keeps its loop alive. */
function cli(hold = false) {
  const keepAlive = path.join(workDir, 'keep-alive.cjs');
  return track(
    spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        ...(hold ? ['--require', keepAlive] : []),
        'apps/desktop-cli/src/index.ts',
        'workspace',
        'list',
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          FORCE_COLOR: undefined,
          NO_COLOR: '1',
          CANOPY_DATA_DIR: userDataDir,
          CANOPY_SECURE_DATA_DIR: `${userDataDir}-secure`,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    ),
  );
}

/** Starts the built app without the harness: it must exit on its own. */
function launchExpectingExit() {
  const profile = path.join(userDataDir, 'electron-profile');
  return track(
    spawn(
      electronPath,
      [
        ...platformElectronArgs(userDataDir, [`--user-data-dir=${profile}`]),
        resolveE2eMainEntryPath(repoRoot),
      ],
      {
        cwd: repoRoot,
        env: buildElectronEnv(userDataDir, buildE2eLaunchMarkerEnv()),
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    ),
  );
}

async function within(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function launchApp() {
  const launched = await launchW5App({ userDataDir });
  openApps.add(launched);
  const mainPid = await launched.electronApp.evaluate(() => process.pid);
  return { ...launched, mainPid, launched };
}

async function quitApp(app) {
  openApps.delete(app.launched);
  await quitGracefullyKeepingData(app.electronApp, userDataDir);
}

async function killApp(app) {
  openApps.delete(app.launched);
  await crashKeepingData(app.launched);
}

async function expectStartupRefused() {
  const { code, stderr } = await within(
    launchExpectingExit().exited,
    60_000,
    'refused startup',
  );
  expect(code).toBe(1);
  expect(stderr).toContain(MAINTENANCE_HELD);
}

async function expectCliRefused() {
  const { code, stderr } = await within(cli().exited, 60_000, 'refused CLI');
  expect(code).toBe(1);
  expect(stderr).toContain(MAINTENANCE_HELD);
}

test.beforeAll(async () => {
  workDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'w5-cohort-e2e-')));
  writeFileSync(
    path.join(workDir, 'keep-alive.cjs'),
    'setInterval(() => undefined, 60_000);\n',
  );
  composition = await buildW5MaintenanceComposition({
    directory: workDir,
    repoRoot,
    workerEntry: path.join(
      path.dirname(resolveE2eMainEntryPath(repoRoot)),
      'w5-commit-log-worker.js',
    ),
  });
});

test.beforeEach(() => {
  userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-w5-cohort-'));
  // Maintenance requires the canonical root; registration resolves it too.
  root = realpathSync(userDataDir);
});

test.afterEach(async () => {
  for (const launched of Array.from(openApps)) {
    openApps.delete(launched);
    await crashKeepingData(launched).catch(() => undefined);
  }
  await composition?.killAll();
  await Promise.all(
    Array.from(children, async (child) => {
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('close', resolve));
    }),
  );
  await removeTestDataDir(userDataDir);
  await removeTestDataDir(`${userDataDir}-secure`);
});

test.afterAll(async () => {
  if (workDir) await removeTestDataDir(workDir);
});

test('a running app blocks maintenance until it quits', async () => {
  const app = await launchApp();
  expect(members()).toEqual([{ pid: app.mainPid, hostKind: 'electron' }]);
  // Admitted: the gated commit-log writer started and provisioned the index.
  expect(existsSync(path.join(root, 'w5', 'commit-log.sqlite'))).toBe(true);

  expect(await composition.run('diagnose', root)).toEqual({
    line: 'refused:host-active',
    code: 3,
  });
  expect(maintenanceRecordExists()).toBe(false);

  // Release is process death: the member file outlives a graceful quit.
  await quitApp(app);
  expect(members()).toEqual([{ pid: app.mainPid, hostKind: 'electron' }]);
  expect(await composition.run('diagnose', root)).toEqual({
    line: 'diagnosed',
    code: 0,
  });
  expect(members()).toEqual([]);
  expect(maintenanceRecordExists()).toBe(false);
});

test('a killed app no longer blocks maintenance', async () => {
  const app = await launchApp();
  expect(await composition.run('diagnose', root)).toEqual({
    line: 'refused:host-active',
    code: 3,
  });
  await killApp(app);
  expect(members()).toEqual([{ pid: app.mainPid, hostKind: 'electron' }]);
  expect(await composition.run('diagnose', root)).toEqual({
    line: 'diagnosed',
    code: 0,
  });
  expect(members()).toEqual([]);
});

// A registration failure that also stops maintenance on that root keeps the
// app fully usable, unregistered (like the legacy writers); maintenance
// refuses that root.
test('an app whose runtime folder is linked still writes, and maintenance refuses that root', async () => {
  const elsewhere = mkdtempSync(path.join(os.tmpdir(), 'canopy-w5-runtime-'));
  try {
    // A linked runtime folder is never private.
    symlinkSync(elsewhere, path.join(root, 'runtime'));
    // launchW5App waits until startup records the default Chats project
    // through the app's commit-log writer.
    const app = await launchApp();
    expect(existsSync(path.join(root, 'w5', 'commit-log.sqlite'))).toBe(true);
    expect(members()).toEqual([]);
    expect(readdirSync(elsewhere)).not.toContain('hosts');
    expect(await composition.run('diagnose', root)).toEqual({
      line: 'refused:runtime-unavailable',
      code: 3,
    });
    expect(readdirSync(elsewhere)).not.toContain('w5-maintenance.json');
    await quitApp(app);
  } finally {
    await removeTestDataDir(elsewhere);
  }
});

test('the app refuses to start while maintenance holds the data folder', async () => {
  const first = await launchApp();
  await quitApp(first);

  const maintenance = composition.start('hold', root);
  expect(await within(maintenance.line, 120_000, 'hold')).toBe('held');
  await expectStartupRefused();
  // Maintenance pruned the departed app; the refused one withdrew its file.
  expect(members()).toEqual([]);
  expect(maintenanceRecordExists()).toBe(true);

  await maintenance.kill();
  const app = await launchApp();
  expect(members()).toEqual([{ pid: app.mainPid, hostKind: 'electron' }]);
  await quitApp(app);
});

test('Electron, the CLI and maintenance start, repair, interrupt and restart on one data root', async () => {
  // Start: the app and a CLI run together, each a member.
  const app = await launchApp();
  const heldCli = cli(true);
  await expect
    .poll(() => members().map((member) => member.hostKind), {
      timeout: 60_000,
    })
    .toEqual(['cli', 'electron']);
  expect(members()).toEqual([
    { pid: heldCli.child.pid, hostKind: 'cli' },
    { pid: app.mainPid, hostKind: 'electron' },
  ]);
  const listed = await within(cli().exited, 60_000, 'CLI beside the app');
  expect(listed.code).toBe(0);
  expect(await composition.run('diagnose', root)).toEqual({
    line: 'refused:host-active',
    code: 3,
  });

  // Either host alone still blocks; only both gone admit maintenance.
  await quitApp(app);
  expect(await composition.run('diagnose', root)).toEqual({
    line: 'refused:host-active',
    code: 3,
  });
  heldCli.child.kill('SIGKILL');
  await heldCli.exited;

  // Repair: a real restore through a cold dedicated host.
  const repaired = await composition.run('repair', root);
  expect(repaired).toMatchObject({ code: 0 });
  expect(repaired.line).toMatch(/^restored:\d+$/);
  expect(members()).toEqual([]);
  expect(maintenanceRecordExists()).toBe(false);
  expect(existsSync(path.join(root, 'runtime', 'startup-claim.json'))).toBe(
    false,
  );

  // Interruption: maintenance killed mid-restore, holding the folder.
  const interrupted = composition.start('hold', root);
  expect(await within(interrupted.line, 120_000, 'hold')).toBe('held');
  await expectStartupRefused();
  await expectCliRefused();
  expect(members()).toEqual([]);
  await interrupted.kill();
  // The departed record stays until the next maintenance replaces it.
  expect(maintenanceRecordExists()).toBe(true);

  // Restart: both hosts start again, then maintenance repairs once more.
  const restarted = await launchApp();
  const restartedCli = await within(cli().exited, 60_000, 'restarted CLI');
  expect(restartedCli.code).toBe(0);
  expect(members()).toEqual([{ pid: restarted.mainPid, hostKind: 'electron' }]);
  expect(await composition.run('diagnose', root)).toEqual({
    line: 'refused:host-active',
    code: 3,
  });
  await quitApp(restarted);
  const again = await composition.run('repair', root);
  expect(again).toMatchObject({ code: 0 });
  expect(again.line).toMatch(/^restored:\d+$/);
  expect(maintenanceRecordExists()).toBe(false);

  const final = await launchApp();
  expect(members()).toEqual([{ pid: final.mainPid, hostKind: 'electron' }]);
  await quitApp(final);
});
