import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect } from '@playwright/test';
import { loadBrand } from '../../../../../scripts/brand/load-brand.mjs';
import {
  createShortDaemonDataRoot,
  preflightDaemonDataRoot,
  stageProductDaemonBridge,
} from '../../../../../scripts/lib/e2e-daemon-product-bridge.mjs';
import {
  assertIsolatedCanopyDataDir,
  closeCanopy,
  launchCanopyApp,
  resolveLaunchRuntimeRoot,
} from '../launchCanopy.mjs';

const execFileAsync = promisify(execFile);

export const FILES_FLAG = 'canopy-desktop-daemon-files-reads';
export const GOLDEN_DIR = 'c4307-golden';
export const brand = loadBrand(process.env.CANOPY_BRAND ?? 'canopy');
export const MANAGED_DIR = brand.storage.projectConfigDirNames[0];

// Index exclusions the fixture preferences select: one custom glob, and one
// builtin turned off so its directory stays indexable.
export const FIXTURE_PREFERENCES = {
  fileIndexing: {
    disabledBuiltinGlobIds: ['nox'],
    customGlobs: [{ id: 'c4307-gen', pattern: '**/*.gen', enabled: true }],
  },
};

/**
 * The fixture tree written under `<root>/c4307-golden`. Only repo-local
 * `.gitignore` rules are used: the daemon receives no GIT_* environment.
 */
export function writeGoldenFixture(root) {
  const dir = path.join(root, GOLDEN_DIR);
  const file = (relative, text = `${relative}\n`) => {
    mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
    writeFileSync(path.join(dir, relative), text);
  };
  file('.gitignore', 'ignored.log\nignored-dir/\n');
  file('alpha.txt');
  file('Beta.txt');
  file('custom.gen');
  file('ignored.log');
  file('zeta/inner.txt');
  file('ignored-dir/kept.txt');
  file('bower_components/pkg/index.js');
  file('.nox/session.txt');
  for (const probe of ['probe-a', 'probe-b', 'probe-c', 'probe-d'])
    file(`${probe}/${probe}.txt`);
  mkdirSync(path.join(dir, 'empty-dir'));
  symlinkSync('alpha.txt', path.join(dir, 'link-to-alpha.txt'));
  symlinkSync('zeta', path.join(dir, 'link-dir'));
  return dir;
}

const entry = (name, kind, flags = {}) => ({
  name,
  kind,
  isIgnored: false,
  isIndexExcluded: false,
  isSymlink: false,
  hasChildren: kind === 'directory',
  ...flags,
});

/**
 * Expected listings, written from the fixture above and the reader's
 * documented rules (directories first, then `localeCompare` by name; `.git`
 * hidden; links followed only inside the root and never expandable).
 */
export const GOLDEN_LISTINGS = {
  [GOLDEN_DIR]: [
    entry('.nox', 'directory'),
    entry('bower_components', 'directory', { isIndexExcluded: true }),
    entry('empty-dir', 'directory'),
    entry('ignored-dir', 'directory', { isIgnored: true }),
    entry('link-dir', 'directory', { isSymlink: true, hasChildren: false }),
    entry('probe-a', 'directory'),
    entry('probe-b', 'directory'),
    entry('probe-c', 'directory'),
    entry('probe-d', 'directory'),
    entry('zeta', 'directory'),
    entry('.gitignore', 'file'),
    entry('alpha.txt', 'file'),
    entry('Beta.txt', 'file'),
    entry('custom.gen', 'file', { isIndexExcluded: true }),
    entry('ignored.log', 'file', { isIgnored: true }),
    entry('link-to-alpha.txt', 'file', { isSymlink: true }),
  ],
  [`${GOLDEN_DIR}/zeta`]: [entry('inner.txt', 'file')],
  [`${GOLDEN_DIR}/ignored-dir`]: [
    entry('kept.txt', 'file', { isIgnored: true }),
  ],
  [`${GOLDEN_DIR}/bower_components`]: [
    entry('pkg', 'directory', { isIndexExcluded: true }),
  ],
  [`${GOLDEN_DIR}/empty-dir`]: [],
};

/**
 * Golden entries as the IPC returns them for a root at `rootPath`. Roots that
 * are not Git-aware (Cowork folders) report nothing as ignored.
 */
export function goldenIpcEntries(
  rootPath,
  relativeDir,
  { gitAware = true } = {},
) {
  return GOLDEN_LISTINGS[relativeDir].map((item) => {
    const relativePath = `${relativeDir}/${item.name}`;
    return {
      ...item,
      isIgnored: gitAware && item.isIgnored,
      relativePath,
      absolutePath: path.join(rootPath, ...relativePath.split('/')),
    };
  });
}

/** What the panel itself renders for those entries. */
export function goldenPanelRows(relativeDir, { gitAware = true } = {}) {
  return GOLDEN_LISTINGS[relativeDir].map(({ name, kind, isIgnored }) => ({
    name,
    kind,
    ignored: gitAware && isIgnored,
  }));
}

export function treeItem(panel, rootId, relativePath) {
  return panel.locator(
    `[data-file-tree-id="${encodeURIComponent(rootId)}:${encodeURIComponent(relativePath)}"]`,
  );
}

/**
 * Adds a File Explorer tab to the chat group and returns its tree. Waits for
 * the scope's chat panel to hydrate first: a chat-active panel that
 * materializes after the tab was added is selected by the chat ⇄ panel sync,
 * hiding the tree. `chatTabId` names the seeded chat when it is known.
 */
export async function openFilesPanel(window, { chatTabId } = {}) {
  let chat = window.getByTestId('panel-content-chat').filter({ visible: true });
  if (chatTabId)
    chat = chat.and(
      window.locator(`[data-panel-id="panel-chat-${chatTabId}"]`),
    );
  chat = chat.first();
  await expect(chat, 'the scope chat panel has hydrated').toBeVisible({
    timeout: 30_000,
  });
  await expect(chat.getByTestId('panel-binding-loading')).toHaveCount(0, {
    timeout: 30_000,
  });
  await window.getByTestId('panel-add-panel-group-chat').click();
  await window.getByTestId('panel-add-menu-item-file-explorer').click();
  const panel = window.getByTestId('files-tree-tab');
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expectFilesPanelActive(panel);
  return panel;
}

/** The File Explorer is its group's active tab, with its tree shown. */
export async function expectFilesPanelActive(panel) {
  const window = panel.page();
  const content = window
    .getByTestId('panel-content-file-explorer')
    .filter({ visible: true });
  await expect(content, 'File Explorer is the active tab').toHaveCount(1);
  const panelId = await content.getAttribute('data-panel-id');
  await expect(window.getByTestId(`panel-tab-${panelId}`)).toHaveAttribute(
    'data-active',
    'true',
  );
  await expect(panel).toBeVisible();
}

export async function expandFolder(panel, rootId, relativePath) {
  await expectFilesPanelActive(panel);
  const row = treeItem(panel, rootId, relativePath).first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  if ((await row.getAttribute('aria-expanded')) !== 'true') await row.click();
  await expect(row).toHaveAttribute('aria-expanded', 'true');
}

/** Rows the panel renders directly under one folder, in DOM order. */
export function panelChildren(panel, rootId, relativePath) {
  return panel.evaluate(
    (host, { prefix, parent }) => {
      const seen = new Set();
      const rows = [];
      for (const element of host.querySelectorAll('[data-file-tree-id]')) {
        const id = element.getAttribute('data-file-tree-id') ?? '';
        const rowPath = element.getAttribute('data-path') ?? '';
        if (!id.startsWith(prefix) || seen.has(id)) continue;
        const rest =
          parent === ''
            ? rowPath
            : rowPath.startsWith(`${parent}/`)
              ? rowPath.slice(parent.length + 1)
              : '';
        if (!rest || rest.includes('/')) continue;
        seen.add(id);
        rows.push({
          name: rest,
          kind: element.getAttribute('data-file-tree-kind'),
          ignored: element.getAttribute('data-ignored') === 'true',
        });
      }
      return rows;
    },
    { prefix: `${encodeURIComponent(rootId)}:`, parent: relativePath },
  );
}

/** Root rows in panel order: id, label and expansion. */
export function panelRoots(panel) {
  return panel.evaluate((host) =>
    Array.from(host.querySelectorAll('[data-file-tree-id]'))
      .filter((element) => element.getAttribute('data-path') === '')
      .map((element) => ({
        id: decodeURIComponent(
          (element.getAttribute('data-file-tree-id') ?? '').replace(/:$/, ''),
        ),
        // Without the leading expand marker.
        label: (element.textContent ?? '').replace(/^\s*[▶▼]/, '').trim(),
      })),
  );
}

export function workCounters(electronApp) {
  return {
    reset: () =>
      electronApp.evaluate(() => globalThis.__CANOPY_WORK_COUNTERS__.reset()),
    read: () =>
      electronApp.evaluate(() =>
        globalThis.__CANOPY_WORK_COUNTERS__.snapshot(),
      ),
  };
}

/**
 * The Files route keys (`files.<op>.<backend|outcome>`) and the file-tree IPC
 * invocations from one counter snapshot.
 */
export function filesTraffic(snapshot) {
  const route = Object.fromEntries(
    Object.entries(snapshot.route).filter(([key]) => key.startsWith('files.')),
  );
  return {
    route,
    roots: snapshot.ipc['invoke.file-tree:roots'] ?? 0,
    directory: snapshot.ipc['invoke.file-tree:directory'] ?? 0,
  };
}

/** Every file-tree read in the snapshot was selected for and served by the daemon. */
export function expectDaemonServed(traffic, operations) {
  for (const operation of operations) {
    const invoked = traffic[operation];
    expect(invoked, `${operation} IPC reads`).toBeGreaterThan(0);
    expect(traffic.route[`files.${operation}.daemon`]).toBe(invoked);
    expect(traffic.route[`files.${operation}.daemon.served`]).toBe(invoked);
    expect(traffic.route[`files.${operation}.direct`]).toBeUndefined();
  }
}

/** Every file-tree read in the snapshot used the direct reader. */
export function expectDirectOnly(traffic, operations) {
  for (const operation of operations) {
    const invoked = traffic[operation];
    expect(invoked, `${operation} IPC reads`).toBeGreaterThan(0);
    expect(traffic.route[`files.${operation}.direct`]).toBe(invoked);
  }
  expect(
    Object.keys(traffic.route).filter((key) => key.includes('.daemon')),
  ).toEqual([]);
}

export async function setFilesFlag(electronApp, window, enabled) {
  await electronApp.evaluate(
    (_electron, { key, value }) => {
      const flags = JSON.parse(
        process.env.CANOPY_E2E_CLIENT_FEATURE_FLAGS ?? '{}',
      );
      process.env.CANOPY_E2E_CLIENT_FEATURE_FLAGS = JSON.stringify({
        ...flags,
        [key]: value,
      });
    },
    { key: FILES_FLAG, value: enabled },
  );
  const snapshot = await window.evaluate(() =>
    window.api.featureFlags.refreshContext(),
  );
  expect(snapshot.values[FILES_FLAG]).toBe(enabled);
}

export function readDescriptor(canonicalDataRoot) {
  const descriptorPath = path.join(canonicalDataRoot, 'runtime/core.json');
  return existsSync(descriptorPath)
    ? JSON.parse(readFileSync(descriptorPath, 'utf8'))
    : null;
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

/**
 * `exited` once the process is gone or only an unreaped zombie of Electron
 * main remains; otherwise its `ps` state, with its open Unix sockets.
 */
export async function daemonExitState(pid) {
  if (!isAlive(pid)) return { state: 'exited' };
  let stat = '';
  try {
    ({ stdout: stat } = await execFileAsync('ps', [
      '-o',
      'stat=',
      '-p',
      String(pid),
    ]));
  } catch {
    return { state: 'exited' };
  }
  stat = stat.trim();
  if (stat === '' || stat.startsWith('Z')) return { state: 'exited', stat };
  let sockets = null;
  try {
    sockets = (await daemonUnixSockets(pid)).length;
  } catch {
    // Exited between the checks.
  }
  return { state: 'running', stat, sockets };
}

/** Parent, group and mapped executable of one process, from the OS. */
export async function inspectDaemonProcess(pid) {
  const { stdout: ps } = await execFileAsync('ps', [
    '-o',
    'ppid=,pgid=,stat=',
    '-p',
    String(pid),
  ]);
  const [ppid, pgid, stat] = ps.trim().split(/\s+/);
  const { stdout: lsof } = await execFileAsync('lsof', [
    '-a',
    '-p',
    String(pid),
    '-d',
    'txt',
    '-Fn',
  ]);
  const text = lsof
    .split('\n')
    .filter((line) => line.startsWith('n'))
    .map((line) => line.slice(1));
  return { pid, ppid: Number(ppid), pgid: Number(pgid), stat, text };
}

/** The daemon's Unix sockets: its listener plus one per connected client. */
export async function daemonUnixSockets(pid) {
  const { stdout } = await execFileAsync('lsof', [
    '-a',
    '-p',
    String(pid),
    '-U',
    '-Fn',
  ]);
  return stdout.split('\n').filter((line) => line.startsWith('n'));
}

/** Process groups the E2E supervisor recorded for this launch. */
export function supervisedGroups(userDataDir) {
  const file = path.join(userDataDir, '.e2e-supervised-groups.ndjson');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((record) => typeof record.pgid === 'number')
    .map((record) => record.pgid);
}

function sourceSha(runtimeRoot) {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: runtimeRoot,
    encoding: 'utf8',
  }).trim();
}

/**
 * The daemon this launch started is the bridged artifact: a direct child of
 * Electron main, its mapped executable the bridged path with the manifest
 * hash, and its process group tracked by the E2E supervisor.
 */
export async function proveBridgedDaemon(context, descriptor) {
  const processInfo = await inspectDaemonProcess(descriptor.pid);
  expect(processInfo.ppid).toBe(context.mainPid);
  expect(processInfo.pgid).toBe(descriptor.pid);
  expect(processInfo.text).toContain(context.bridge.executable);
  const digest = createHash('sha256')
    .update(readFileSync(context.bridge.executable))
    .digest('hex');
  expect(digest).toBe(context.bridge.manifest.sha256);
  await expect
    .poll(() => supervisedGroups(context.dataRoot), { timeout: 20_000 })
    .toContain(descriptor.pid);
  return { ...processInfo, executableSha256: digest };
}

async function stopOwnedDaemon(context, report) {
  const descriptors = [...context.seenDescriptors];
  const current = context.canonicalDataRoot
    ? readDescriptor(context.canonicalDataRoot)
    : null;
  if (current) descriptors.push(current);
  const outcomes = [];
  for (const descriptor of descriptors) {
    if (!isAlive(descriptor.pid)) {
      outcomes.push({ pid: descriptor.pid, outcome: 'exited' });
      continue;
    }
    let info = null;
    try {
      info = await inspectDaemonProcess(descriptor.pid);
    } catch {
      // Exited between the checks.
    }
    // Only a process still running the bridged artifact is ours to stop.
    if (!info?.text.includes(context.bridge.executable)) {
      outcomes.push({ pid: descriptor.pid, outcome: 'not-owned' });
      continue;
    }
    try {
      process.kill(descriptor.pid, 'SIGCONT');
      process.kill(descriptor.pid, 'SIGTERM');
    } catch {
      // Exited meanwhile.
    }
    await expect
      .poll(() => isAlive(descriptor.pid), { timeout: 15_000 })
      .toBe(false);
    outcomes.push({ pid: descriptor.pid, outcome: 'terminated-after-close' });
  }
  report.daemonCleanup = outcomes;
}

// A timed-out test body never reaches its `finally` before the worker
// restarts, so `afterEach` runs the same owned cleanup.
let pendingCleanup = null;

/** For `test.afterEach`: finishes the owned cleanup of an abandoned run. */
export async function cleanupAbandonedDaemonFilesApp() {
  const cleanup = pendingCleanup;
  pendingCleanup = null;
  if (cleanup) await cleanup();
}

/**
 * Launches the ordinary app on a short isolated data root with the verified
 * daemon bridged into the product lookup paths, runs `scenario`, then cleans
 * up only what this run owns: processes, staged files and the data root.
 * `flag: null` leaves the Files flag unpinned, as every other spec does.
 */
export async function withDaemonFilesApp(
  testInfo,
  { flag, seed, launchEnv = {} },
  scenario,
) {
  const expectedFlag = flag ?? false;
  const runtimeRoot = resolveLaunchRuntimeRoot();
  const report = { flag: expectedFlag, flagPinned: flag !== null, steps: {} };
  const bridge = stageProductDaemonBridge({
    runtimeRoot,
    sourceSha: sourceSha(runtimeRoot),
    platform: process.platform,
    arch: process.arch,
    brand,
  });
  report.artifact = {
    identity: bridge.identity,
    manifest: bridge.manifest,
    bridge: bridge.entries.map(({ label, target, sha256, owned }) => ({
      label,
      target,
      sha256,
      owned,
    })),
  };
  let owner = null;
  let launched;
  let failure;
  const context = {
    bridge,
    report,
    seenDescriptors: [],
  };
  let cleanupRun = null;
  const cleanup = () => (cleanupRun ??= ownedCleanup());
  async function ownedCleanup() {
    const cleanupErrors = [];
    const step = async (name, run) => {
      try {
        await run();
      } catch (error) {
        cleanupErrors.push(`${name}: ${error.stack ?? error}`);
      }
    };
    for (const pid of context.stoppedPids ?? [])
      await step('resume', () => process.kill(pid, 'SIGCONT'));
    if (launched)
      await step('close', () =>
        closeCanopy(launched.electronApp, context.dataRoot, {
          keepUserData: true,
        }),
      );
    await step('daemon', () => stopOwnedDaemon(context, report));
    await step('bridge', () => {
      report.bridgeCleanup = bridge.cleanup();
      const retained = report.bridgeCleanup.filter(
        ({ outcome }) => outcome === 'retained-changed',
      );
      if (retained.length)
        throw new Error(
          `Bridge files changed by another owner: ${JSON.stringify(retained)}`,
        );
    });
    if (owner)
      await step('data root', () =>
        rmSync(owner, { recursive: true, force: true }),
      );
    report.dataRootRemoved = owner ? !existsSync(owner) : null;
    report.cleanupErrors = cleanupErrors;
    report.failure = failure ? String(failure.stack ?? failure) : null;
    const evidence = testInfo.outputPath('daemon-files-evidence.json');
    writeFileSync(evidence, JSON.stringify(report, null, 2));
    await testInfo.attach('daemon-files-evidence.json', {
      path: evidence,
      contentType: 'application/json',
    });
    return cleanupErrors;
  }
  pendingCleanup = cleanup;
  try {
    ({ owner, dataRoot: context.dataRoot } = createShortDaemonDataRoot({
      prefix: 'c4307-',
    }));
    const { dataRoot } = context;
    assertIsolatedCanopyDataDir('CANOPY_DATA_DIR', dataRoot);
    const preflight = preflightDaemonDataRoot(dataRoot);
    context.canonicalDataRoot = preflight.canonical;
    report.dataRoot = { lexical: dataRoot, ...preflight };
    context.seeded = seed ? await seed(dataRoot) : {};
    launched = await launchCanopyApp({
      userDataDir: dataRoot,
      env: {
        ...launchEnv,
        ...(flag !== null && {
          CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
            [FILES_FLAG]: flag,
          }),
        }),
      },
    });
    Object.assign(context, launched);
    const snapshot = await launched.window.evaluate(() =>
      window.api.featureFlags.getSnapshot(),
    );
    // Unknown E2E flag keys are dropped silently; prove the key arrived.
    expect(snapshot.values[FILES_FLAG]).toBe(expectedFlag);
    context.mainPid = await launched.electronApp.evaluate(() => process.pid);
    context.counters = workCounters(launched.electronApp);
    report.runtime = {
      mainPid: context.mainPid,
      // Unpackaged, so the host resolves the bridged lookup paths.
      app: await launched.electronApp.evaluate(({ app }) => ({
        name: app.getName(),
        version: app.getVersion(),
        isPackaged: app.isPackaged,
      })),
      electron: await launched.electronApp.evaluate(() => process.versions),
      flagSnapshot: {
        status: snapshot.status,
        value: snapshot.values[FILES_FLAG],
      },
    };
    expect(report.runtime.app.isPackaged).toBe(false);
    await scenario(context);
  } catch (error) {
    failure = error;
  } finally {
    if (pendingCleanup === cleanup) pendingCleanup = null;
    const cleanupErrors = await cleanup();
    if (!failure && cleanupErrors.length)
      failure = new Error(`Owned cleanup failed:\n${cleanupErrors.join('\n')}`);
  }
  if (failure) throw failure;
}

/** Runs the verified CLI's `daemon status` against the launch's data root. */
export async function cliDaemonStatus(context) {
  const { stdout } = await execFileAsync(
    context.bridge.verified.cliExecutable,
    ['daemon', 'status'],
    {
      env: {
        ...process.env,
        CANOPY_DATA_DIR: context.dataRoot,
        CANOPY_ENV: 'development',
        NODE_ENV: 'development',
      },
      timeout: 30_000,
    },
  );
  const field = (name) =>
    stdout.match(new RegExp(`^${name}: (.+)$`, 'm'))?.[1] ?? null;
  return {
    stdout,
    runtime: field('Runtime'),
    host: field('Host'),
    epoch: field('Epoch'),
    build: field('Build'),
  };
}
