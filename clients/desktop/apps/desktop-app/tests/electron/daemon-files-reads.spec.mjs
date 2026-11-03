// Files panel acceptance against the separately packaged daemon (CAN-4307).
// The ordinary app reads through its production connection; the verified G2a
// artifact is bridged into the product's own lookup paths. Panel results are
// held to a golden listing written from the fixture definition, so a defect
// shared by the direct and daemon readers still fails.
import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { DESKTOP_FILE_IMAGE_SAVE_SUPPORT } from '../../../../packages/protocol/src/file-image-save.ts';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { isDaemonFilesDryRun } from './launchCanopy.mjs';
import {
  GOLDEN_DIR,
  FIXTURE_PREFERENCES,
  MANAGED_DIR,
  cleanupAbandonedDaemonFilesApp,
  cliDaemonStatus,
  daemonExitState,
  expandAppManagedRootGroup,
  expandFolder,
  expectDaemonServed,
  expectDirectOnly,
  expectFilesPanelActive,
  filesTraffic,
  goldenIpcEntries,
  goldenPanelRows,
  daemonUnixSockets,
  inspectDaemonProcess,
  isAlive,
  openFilesPanel,
  panelChildren,
  panelRoots,
  proveBridgedDaemon,
  readDescriptor,
  setFilesChoice,
  treeItem,
  withDaemonFilesApp,
  writeGoldenFixture,
} from './helpers/daemon-files-panel.mjs';
import {
  markWorkspaceOrganizationOwned,
  seedWorktreeChat,
} from './seeders/index.mjs';
import { mergeSeedPreferences } from './seeders/mergePreferences.mjs';

const execFileAsync = promisify(execFile);
const WORKTREE = 'demo-main';
const SINGLE = 'demo-ts-pnpm-vite';
const MALFORMED_OWNER = 'demo-ts-npm-next';
const MULTI = 'demo-multi-repo-fullstack';
const SINGLE_CHAT = 'c4307-chat';
const MULTI_CHAT = 'c4307-multi-chat';
// Long enough for a stopped daemon to visibly hold a read, short of every
// lease and query deadline.
const STOP_WINDOW_MS = 2_500;

test.skip(
  process.platform !== 'darwin',
  'The packaged daemon artifact and owned-child host are macOS only.',
);

test.afterEach(cleanupAbandonedDaemonFilesApp);

function seedSingleRepo(dataRoot) {
  const seed = seedDemoWorkspaces({
    userDataDir: dataRoot,
    apps: ['ts-pnpm-vite', 'ts-npm-next'],
  });
  const repo = seed.workspaces.find(({ id }) => id === SINGLE);
  writeGoldenFixture(repo.worktreePath);
  // Q2: a malformed organization owner is a typed daemon failure and is
  // unchanged on the direct reader.
  markWorkspaceOrganizationOwned(dataRoot, MALFORMED_OWNER, 'not-a-uuid');
  seedWorktreeChat({
    userDataDir: dataRoot,
    workspaceId: SINGLE,
    worktreeId: WORKTREE,
    providerType: 'claude',
    tabs: [{ id: SINGLE_CHAT, title: 'Chat' }],
  });
  mergeSeedPreferences(dataRoot, FIXTURE_PREFERENCES);
  // Present but empty, so the attachments root starts hidden and the
  // panel's watch covers the folder its first attachment lands in.
  const attachmentsDir = path.join(
    dataRoot,
    'workspaces',
    SINGLE,
    'attachments',
    WORKTREE,
  );
  mkdirSync(attachmentsDir, { recursive: true });
  return { worktreePath: repo.worktreePath, attachmentsDir };
}

async function selectWorktree(window, projectId) {
  const row = window
    .locator(
      `[data-testid="worktree-row"][data-project-id="${projectId}"][data-worktree-id="${WORKTREE}"]`,
    )
    .first();
  await expect(row).toBeAttached({ timeout: 30_000 });
  await row.evaluate((element) => element.click());
  await expect(
    window.locator('[data-sidebar-selected-item]').filter({ has: row }),
  ).toHaveCount(1);
  await expect(window.getByTestId('panel-grid-root')).toBeVisible();
}

function ipcDirectory(window, scope, repoId, relativeDir) {
  return window.evaluate(
    (request) => window.api.getFileTreeDirectory(request),
    { ...scope, repoId, relativeDir },
  );
}

function ipcRoots(window, scope) {
  return window.evaluate(
    (request) => window.api.getFileTreeRoots(request),
    scope,
  );
}

/** The main window's "Couldn't reach the background service" notice. */
const backgroundServiceNotice = (window) =>
  window.getByTestId('background-service-notice');

/**
 * Main's background service status, which drives the notice. A routed read
 * reports to it before its reply, and an unchanged `sequence` also rules out
 * a warning that flickered and cleared.
 */
const backgroundServiceStatus = (window) =>
  window.evaluate(() => window.api.backgroundService.getStatus());

/** Settles an IPC read as `{ ok, value | message }` without throwing. */
function settleIpc(window, channel, request) {
  return window.evaluate(
    async ({ channel: name, request: body }) => {
      try {
        const value =
          name === 'roots'
            ? await window.api.getFileTreeRoots(body)
            : await window.api.getFileTreeDirectory(body);
        return { ok: true, value };
      } catch (error) {
        return { ok: false, message: String(error?.message ?? error) };
      }
    },
    { channel, request },
  );
}

const singleRoots = ({ worktreePath, attachmentsDir }, withAttachments) => [
  {
    repoId: SINGLE,
    repoName: SINGLE,
    absolutePath: worktreePath,
    rootKind: 'git-repo',
  },
  ...(withAttachments
    ? [
        {
          repoId: 'attachments',
          repoName: 'attachments',
          absolutePath: attachmentsDir,
          rootKind: 'attachments',
        },
      ]
    : []),
];

/**
 * The shared single-repo walk: roots, the golden folder and its nested
 * folders, then a root change (a first attachment) and a directory change.
 * Returns the counter traffic of the panel interactions.
 */
async function walkSingleRepoPanel(context) {
  const { window, counters, seeded } = context;
  const scope = { projectId: SINGLE, worktreeId: WORKTREE };
  await counters.reset();
  const panel = await openFilesPanel(window, { chatTabId: SINGLE_CHAT });
  await expandFolder(panel, SINGLE, '');
  await expandFolder(panel, SINGLE, GOLDEN_DIR);
  await expect
    .poll(() => panelChildren(panel, SINGLE, GOLDEN_DIR))
    .toEqual(goldenPanelRows(GOLDEN_DIR));
  for (const nested of ['zeta', 'ignored-dir', 'bower_components']) {
    const relative = `${GOLDEN_DIR}/${nested}`;
    await expandFolder(panel, SINGLE, relative);
    await expect
      .poll(() => panelChildren(panel, SINGLE, relative))
      .toEqual(goldenPanelRows(relative));
  }
  expect(await panelRoots(panel)).toEqual([{ id: SINGLE, label: SINGLE }]);
  const opened = filesTraffic(await context.counters.read());

  // The same IPC route, from the same window, for the fields the panel
  // does not render.
  expect(await ipcRoots(window, scope)).toEqual({
    imageSaveSupport: DESKTOP_FILE_IMAGE_SAVE_SUPPORT,
    roots: singleRoots(seeded, false),
  });
  for (const relative of [
    GOLDEN_DIR,
    `${GOLDEN_DIR}/zeta`,
    `${GOLDEN_DIR}/ignored-dir`,
    `${GOLDEN_DIR}/bower_components`,
    `${GOLDEN_DIR}/empty-dir`,
  ])
    expect(await ipcDirectory(window, scope, SINGLE, relative)).toEqual({
      entries: goldenIpcEntries(seeded.worktreePath, relative),
    });

  // A root change: the first attachment makes the attachments root appear.
  await expect(panel).toHaveAttribute('data-watching', 'true');
  writeFileSync(path.join(seeded.attachmentsDir, 'attached.txt'), 'attached\n');
  await expect
    .poll(() => panelRoots(panel), { timeout: 20_000 })
    .toEqual([
      { id: SINGLE, label: SINGLE },
      { id: 'attachments', label: 'attachments' },
    ]);
  await expectFilesPanelActive(panel);
  expect(await ipcRoots(window, scope)).toEqual({
    imageSaveSupport: DESKTOP_FILE_IMAGE_SAVE_SUPPORT,
    roots: singleRoots(seeded, true),
  });
  // A directory change inside an expanded folder.
  writeFileSync(
    path.join(seeded.worktreePath, GOLDEN_DIR, 'zeta/added.txt'),
    '',
  );
  await expect
    .poll(() => panelChildren(panel, SINGLE, `${GOLDEN_DIR}/zeta`), {
      timeout: 20_000,
    })
    .toEqual([
      { name: 'added.txt', kind: 'file', ignored: false },
      { name: 'inner.txt', kind: 'file', ignored: false },
    ]);
  await expectFilesPanelActive(panel);
  return { panel, opened, all: filesTraffic(await counters.read()) };
}

/**
 * Everything under `runtime` except `hosts`: Electron main joins that W5 host
 * cohort at startup whether or not the daemon runs.
 */
function daemonRuntimeEntries(canonicalDataRoot) {
  const runtime = path.join(canonicalDataRoot, 'runtime');
  if (!existsSync(runtime)) return [];
  return readdirSync(runtime).filter((name) => name !== 'hosts');
}

async function daemonChildren(mainPid, executable) {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,command=']);
  return stdout
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .filter(
      ([, , ppid, command]) =>
        Number(ppid) === mainPid && command.startsWith(executable),
    )
    .map(([, pid]) => Number(pid));
}

test('experiment off: the Files panel matches the golden listing on direct reads with zero daemon contact', async ({}, testInfo) => {
  test.setTimeout(240_000);
  // The ordinary suite pins offered with no choice: no daemon contact.
  await withDaemonFilesApp(
    testInfo,
    { enabled: null, seed: seedSingleRepo },
    async (context) => {
      const { window, counters, report, canonicalDataRoot } = context;
      await counters.reset();
      const unchanged = await settleIpc(window, 'roots', {
        projectId: MALFORMED_OWNER,
        worktreeId: WORKTREE,
      });
      expect(unchanged.ok).toBe(true);
      expect(unchanged.value.roots.map(({ repoId }) => repoId)).toEqual([
        MALFORMED_OWNER,
      ]);
      expectDirectOnly(filesTraffic(await counters.read()), ['roots']);

      await selectWorktree(window, SINGLE);
      const traffic = await walkSingleRepoPanel(context);
      expectDirectOnly(traffic.opened, ['roots', 'directory']);
      expectDirectOnly(traffic.all, ['roots', 'directory']);
      // Zero contact although the verified daemon is staged where the host
      // would look: no daemon runtime state and no daemon child of Electron
      // main.
      expect(daemonRuntimeEntries(canonicalDataRoot)).toEqual([]);
      expect(
        await daemonChildren(context.mainPid, context.bridge.executable),
      ).toEqual([]);
      // Nothing reads through the background service, so nothing warns.
      expect(await backgroundServiceStatus(window)).toMatchObject({
        state: 'ok',
        retry: 'idle',
      });
      await expect(backgroundServiceNotice(window)).toHaveCount(0);
      Object.assign(report.steps, {
        malformedOwner: unchanged.value,
        panel: { opened: traffic.opened, all: traffic.all },
        daemonRuntimeState: 'absent',
      });
    },
  );
});

test('experiment on: the Files panel is served by the bridged packaged daemon through loss, opt-out return and typed failures', async ({}, testInfo) => {
  test.setTimeout(420_000);
  await withDaemonFilesApp(
    testInfo,
    { enabled: true, seed: seedSingleRepo },
    async (context) => {
      const { window, counters, report, canonicalDataRoot } = context;
      const scope = { projectId: SINGLE, worktreeId: WORKTREE };
      const healthy = await backgroundServiceStatus(window);
      expect(healthy).toEqual({
        state: 'ok',
        retry: 'idle',
        sequence: healthy.sequence,
      });

      // Deterministic typed failure: the trusted owner check refuses before
      // any daemon contact, and the direct reader is never used instead.
      await counters.reset();
      const malformed = await settleIpc(window, 'roots', {
        projectId: MALFORMED_OWNER,
        worktreeId: WORKTREE,
      });
      expect(malformed.ok).toBe(false);
      expect(malformed.message).toMatch(
        /: The selected filesystem scope cannot be resolved from trusted workspace records\.$/,
      );
      const malformedTraffic = filesTraffic(await counters.read());
      // Selected for the daemon, refused typed, no query sent, no fallback.
      expect(malformedTraffic.route).toEqual({
        'files.roots.daemon': 1,
        'files.roots.daemon.failed.failed_precondition': 1,
      });
      expect(
        existsSync(path.join(canonicalDataRoot, 'runtime/core.json')),
      ).toBe(false);
      report.steps.malformedOwner = { ...malformed, traffic: malformedTraffic };

      // The direct reader's own path check refuses a traversal before any
      // contact, with its error; the opt-out return below compares them.
      const traversalRequest = {
        ...scope,
        repoId: SINGLE,
        relativeDir: `${GOLDEN_DIR}/../..`,
      };
      await counters.reset();
      const traversal = await settleIpc(window, 'directory', traversalRequest);
      expect(traversal.ok).toBe(false);
      expect(traversal.message).toMatch(
        /: Path cannot traverse outside the worktree\.$/,
      );
      const traversalTraffic = filesTraffic(await counters.read());
      expect(traversalTraffic.route).toEqual({
        'files.directory.daemon': 1,
        'files.directory.daemon.failed.invalid_argument': 1,
      });
      expect(
        existsSync(path.join(canonicalDataRoot, 'runtime/core.json')),
      ).toBe(false);
      report.steps.traversal = { ...traversal, traffic: traversalTraffic };
      // Refusals before contact say nothing about reaching the service.
      const notice = backgroundServiceNotice(window);
      expect(await backgroundServiceStatus(window)).toEqual(healthy);
      await expect(notice).toHaveCount(0);

      // Bracketed lifecycle: no daemon before the panel action.
      await selectWorktree(window, SINGLE);
      expect(readDescriptor(canonicalDataRoot)).toBeNull();
      const traffic = await walkSingleRepoPanel(context);
      expectDaemonServed(traffic.opened, ['roots', 'directory']);
      expectDaemonServed(traffic.all, ['roots', 'directory']);
      expect(await backgroundServiceStatus(window)).toEqual(healthy);
      await expect(notice).toHaveCount(0);
      const descriptor = readDescriptor(canonicalDataRoot);
      expect(descriptor).not.toBeNull();
      context.seenDescriptors.push(descriptor);
      report.steps.panel = { opened: traffic.opened, all: traffic.all };
      report.steps.daemon = {
        descriptor,
        process: await proveBridgedDaemon(context, descriptor),
      };

      // Independent observer: the verified CLI attaches to the same daemon.
      const status = await cliDaemonStatus(context);
      expect(status.runtime).toBeTruthy();
      expect(status.host).toBeTruthy();
      expect(status.epoch).toBeTruthy();
      expect(status.build).toContain(descriptor.buildVersion);
      expect(readDescriptor(canonicalDataRoot).pid).toBe(descriptor.pid);
      report.steps.cliStatus = status;

      // A typed refusal from the live daemon: no direct read, no warning.
      await counters.reset();
      const refused = await settleIpc(window, 'directory', {
        ...scope,
        repoId: 'unregistered',
        relativeDir: '',
      });
      expect(refused.ok).toBe(false);
      const refusedTraffic = filesTraffic(await counters.read());
      expect(refusedTraffic.route).toEqual({
        'files.directory.daemon': 1,
        'files.directory.daemon.queries': 1,
        'files.directory.daemon.failed.not_found': 1,
      });
      expect(await backgroundServiceStatus(window)).toEqual(healthy);
      await expect(notice).toHaveCount(0);
      report.steps.liveRefusal = { ...refused, traffic: refusedTraffic };

      // Causal probe: a stopped daemon holds a never-opened folder's read.
      const { panel } = traffic;
      await expectFilesPanelActive(panel);
      await counters.reset();
      process.kill(descriptor.pid, 'SIGSTOP');
      context.stoppedPids = [descriptor.pid];
      await treeItem(panel, SINGLE, `${GOLDEN_DIR}/probe-a`).first().click();
      await window.waitForTimeout(STOP_WINDOW_MS);
      expect(
        await panelChildren(panel, SINGLE, `${GOLDEN_DIR}/probe-a`),
      ).toEqual([]);
      const held = filesTraffic(await counters.read());
      expect(held.route['files.directory.daemon.queries']).toBe(1);
      expect(held.route['files.directory.daemon.served']).toBeUndefined();
      process.kill(descriptor.pid, 'SIGCONT');
      context.stoppedPids = [];
      await expect
        .poll(() => panelChildren(panel, SINGLE, `${GOLDEN_DIR}/probe-a`))
        .toEqual([{ name: 'probe-a.txt', kind: 'file', ignored: false }]);
      const released = filesTraffic(await counters.read());
      expectDaemonServed(released, ['directory']);
      report.steps.causalProbe = { held, released };

      // Daemon loss: every read still lists, in-process while the daemon is
      // gone (CAN-5541), until the lease's restart serves them again. A
      // restart that succeeds never shows the notice (Mike, q-13 GA3-1).
      await counters.reset();
      // Every push main sends, so even a notice shown briefly is caught.
      await window.evaluate(() => {
        const pushes = [];
        window.__backgroundServicePushes = pushes;
        window.__stopBackgroundServicePushes =
          window.api.backgroundService.onStatusChanged((status) =>
            pushes.push(status),
          );
      });
      process.kill(descriptor.pid, 'SIGKILL');
      const probeC = {
        ...scope,
        repoId: SINGLE,
        relativeDir: `${GOLDEN_DIR}/probe-c`,
      };
      const servedCount = async () =>
        filesTraffic(await counters.read()).route[
          'files.directory.daemon.served'
        ] ?? 0;
      const attempts = [];
      await expect
        .poll(
          async () => {
            const before = await servedCount();
            const result = await settleIpc(window, 'directory', probeC);
            attempts.push(
              result.ok
                ? result.value.entries.map(({ name }) => name).join(',')
                : result.message,
            );
            return (await servedCount()) > before;
          },
          { timeout: 60_000 },
        )
        .toBe(true);
      // Never "Unable to load folder.": each attempt listed the folder.
      expect(attempts.every((listed) => listed === 'probe-c.txt')).toBe(true);
      const replacement = readDescriptor(canonicalDataRoot);
      expect(replacement.pid).not.toBe(descriptor.pid);
      context.seenDescriptors.push(replacement);
      await expandFolder(panel, SINGLE, `${GOLDEN_DIR}/probe-c`);
      await expect
        .poll(() => panelChildren(panel, SINGLE, `${GOLDEN_DIR}/probe-c`))
        .toEqual([{ name: 'probe-c.txt', kind: 'file', ignored: false }]);
      // Hidden while the lease restarted the daemon, then ok on reattach.
      await expect
        .poll(async () => (await backgroundServiceStatus(window)).state, {
          timeout: 15_000,
        })
        .toBe('ok');
      expect(await backgroundServiceStatus(window)).toMatchObject({
        state: 'ok',
        retry: 'idle',
      });
      await expect(notice).toHaveCount(0);
      const lossPushes = await window.evaluate(() => {
        window.__stopBackgroundServicePushes();
        return window.__backgroundServicePushes.map(({ state, reason }) => ({
          state,
          reason: reason ?? null,
        }));
      });
      expect(lossPushes[0]).toEqual({ state: 'reconnecting', reason: null });
      expect(lossPushes.at(-1)).toEqual({ state: 'ok', reason: null });
      expect(lossPushes.filter(({ state }) => state === 'unavailable')).toEqual(
        [],
      );
      const lossTraffic = filesTraffic(await counters.read());
      expect(lossTraffic.route['files.directory.direct']).toBeUndefined();
      expect(lossTraffic.route['files.directory.daemon']).toBe(
        lossTraffic.directory,
      );
      expect(
        Object.keys(lossTraffic.route).filter((key) =>
          key.includes('.daemon.failed.'),
        ),
      ).toEqual([]);
      // Once restarted, the next read is the daemon's.
      await counters.reset();
      expect(
        (await ipcDirectory(window, scope, SINGLE, `${GOLDEN_DIR}/probe-c`))
          .entries,
      ).toHaveLength(1);
      expectDaemonServed(filesTraffic(await counters.read()), ['directory']);
      report.steps.daemonLoss = {
        attempts,
        statusPushes: lossPushes,
        traffic: lossTraffic,
        replacement,
        process: await proveBridgedDaemon(context, replacement),
      };

      // Negative control and opt-out return: with the experiment off, a read is
      // answered while the still-running daemon is stopped, so it cannot
      // have been served by the daemon.
      await setFilesChoice(window, false);
      // Opting out closes the session; stop the daemon only once
      // its last client connection is gone (the listener alone remains), so
      // the stop never stalls that release.
      await expect
        .poll(async () => (await daemonUnixSockets(replacement.pid)).length, {
          timeout: 15_000,
        })
        .toBe(1);
      await counters.reset();
      process.kill(replacement.pid, 'SIGSTOP');
      context.stoppedPids = [replacement.pid];
      await expandFolder(panel, SINGLE, `${GOLDEN_DIR}/probe-b`);
      await expect
        .poll(() => panelChildren(panel, SINGLE, `${GOLDEN_DIR}/probe-b`), {
          timeout: 10_000,
        })
        .toEqual([{ name: 'probe-b.txt', kind: 'file', ignored: false }]);
      expect(isAlive(replacement.pid)).toBe(true);
      expect((await inspectDaemonProcess(replacement.pid)).stat).toMatch(/T/);
      const directTraffic = filesTraffic(await counters.read());
      expectDirectOnly(directTraffic, ['directory']);
      // The route proof itself must reject a read served directly while a
      // daemon exists.
      expect(() => expectDaemonServed(directTraffic, ['directory'])).toThrow();
      process.kill(replacement.pid, 'SIGCONT');
      context.stoppedPids = [];
      // The released lease lets the daemon reach its idle exit while the
      // app keeps running: 30 s idle grace, after at most the 10 s
      // reconnect grace of a lease whose release did not arrive.
      const releasedAt = Date.now();
      const idleSamples = [];
      try {
        await expect
          .poll(
            async () => {
              const sample = await daemonExitState(replacement.pid);
              idleSamples.push({ ms: Date.now() - releasedAt, ...sample });
              return sample.state;
            },
            { timeout: 75_000, intervals: [1_000] },
          )
          .toBe('exited');
      } finally {
        report.steps.idleSamples = idleSamples.slice(-5);
      }
      const idleExitMs = Date.now() - releasedAt;
      expect(
        (
          await window.evaluate(() => window.api.experiments.getSnapshot())
        ).experiments.find((entry) => entry.id === 'daemon-files-reads')
          ?.enabled,
      ).toBe(false);
      // Recorded, not asserted: whether Electron main reaped the exited
      // daemons while it keeps running (an unreaped one stays a zombie).
      const reapedAt = await expect
        .poll(() => isAlive(replacement.pid), { timeout: 5_000 })
        .toBe(false)
        .then(
          () => Date.now() - releasedAt,
          () => null,
        );
      report.steps.flagOff = {
        traffic: directTraffic,
        idleExitMs,
        reapedAfterMs: reapedAt,
        killedDaemonReaped: !isAlive(descriptor.pid),
      };

      // The routed traversal refusal is the direct reader's own error.
      await counters.reset();
      const directTraversal = await settleIpc(
        window,
        'directory',
        traversalRequest,
      );
      expect(directTraversal).toEqual(traversal);
      expect(filesTraffic(await counters.read()).route).toEqual({
        'files.directory.direct': 1,
      });
      report.steps.flagOff.traversal = directTraversal;

      // Start failure: with the bridged executable gone before contact, the
      // next routed read lists in-process and the notice shows (CAN-5541).
      const executable = report.artifact.bridge.find(
        ({ label }) => label === 'packaged daemon',
      );
      if (!executable.owned) {
        // CI shards never unpack `dist/`: a reused file there is a leak,
        // except the Files dry run's lane install, which other workers'
        // daemons start from (CAN-5544).
        if (!isDaemonFilesDryRun())
          expect(
            process.env.CI,
            'CI must stage the daemon itself, so the start failure always runs',
          ).toBeFalsy();
        testInfo.annotations.push({
          type: 'limitation',
          description:
            'Executable-start failure, the in-process fallback, the background service notice and its recovery not exercised: the product daemon path held a pre-existing identical build this run may not remove.',
        });
        return;
      }
      await setFilesChoice(window, true);
      // Opting out reset the record, so the notice below is this read's.
      expect(await backgroundServiceStatus(window)).toMatchObject({
        state: 'ok',
        retry: 'idle',
      });
      await expect(notice).toHaveCount(0);
      expect(context.bridge.remove('packaged daemon')).toBe('removed');
      await counters.reset();
      const probeD = {
        ...scope,
        repoId: SINGLE,
        relativeDir: `${GOLDEN_DIR}/probe-d`,
      };
      const fellBack = await settleIpc(window, 'directory', probeD);
      expect(fellBack.ok).toBe(true);
      expect(fellBack.value.entries.map(({ name }) => name)).toEqual([
        'probe-d.txt',
      ]);
      // Recorded before the read's reply: one read is enough to warn.
      expect(await backgroundServiceStatus(window)).toMatchObject({
        state: 'unavailable',
        reason: 'start_failed',
        retry: 'idle',
      });
      const fallbackTraffic = filesTraffic(await counters.read());
      expect(fallbackTraffic.route).toEqual({
        'files.directory.daemon': 1,
        'files.directory.daemon.fallback.start_failed': 1,
      });
      // Latched: the next read skips the start that just failed.
      await counters.reset();
      expect((await settleIpc(window, 'directory', probeD)).ok).toBe(true);
      expect(filesTraffic(await counters.read()).route).toEqual({
        'files.directory.daemon': 1,
        'files.directory.daemon.bypassed': 1,
      });
      await expandFolder(panel, SINGLE, `${GOLDEN_DIR}/probe-d`);
      await expect
        .poll(() => panelChildren(panel, SINGLE, `${GOLDEN_DIR}/probe-d`))
        .toEqual([{ name: 'probe-d.txt', kind: 'file', ignored: false }]);
      await expect(panel.getByTestId('files-tree-folder-error')).toHaveCount(0);
      expect(readDescriptor(canonicalDataRoot)).toBeNull();
      // The start failure shows the one background service notice.
      await expect(notice).toBeVisible();
      await expect(notice).toContainText(
        "Couldn't reach the background service",
      );
      report.steps.startFailure = {
        ...fellBack,
        traffic: fallbackTraffic,
      };

      // Try again while the executable is still missing: the notice stays
      // and says the retry didn't reach the service either.
      const retry = notice.getByTestId('background-service-notice-retry');
      await retry.click();
      await expect(notice).toContainText(
        "Still couldn't reach the background service",
      );
      await expect(retry).toBeEnabled();
      expect(await backgroundServiceStatus(window)).toMatchObject({
        state: 'unavailable',
        reason: 'start_failed',
        retry: 'failed',
      });
      expect(readDescriptor(canonicalDataRoot)).toBeNull();

      // Recovery: with the executable back, Try again starts the daemon and
      // clears the notice, with no Files read in between; the next read is
      // daemon-served.
      expect(context.bridge.restage('packaged daemon')).toBe('restaged');
      await counters.reset();
      await retry.click();
      await expect(notice).toHaveCount(0, { timeout: 30_000 });
      expect(await backgroundServiceStatus(window)).toEqual({
        state: 'ok',
        retry: 'idle',
        sequence: expect.any(Number),
      });
      expect(filesTraffic(await counters.read()).route).toEqual({});
      const recovered = readDescriptor(canonicalDataRoot);
      expect(recovered).not.toBeNull();
      context.seenDescriptors.push(recovered);
      await counters.reset();
      const listed = await ipcDirectory(
        window,
        scope,
        SINGLE,
        `${GOLDEN_DIR}/probe-d`,
      );
      expect(listed.entries.map(({ name, kind }) => ({ name, kind }))).toEqual([
        { name: 'probe-d.txt', kind: 'file' },
      ]);
      const recoveredTraffic = filesTraffic(await counters.read());
      expectDaemonServed(recoveredTraffic, ['directory']);
      report.steps.recovery = {
        traffic: recoveredTraffic,
        descriptor: recovered,
        process: await proveBridgedDaemon(context, recovered),
      };

      // Kill with the restart blocked: reads keep listing in-process, and
      // once the lease's restart fails the notice shows and reads skip it.
      expect(context.bridge.remove('packaged daemon')).toBe('removed');
      await counters.reset();
      process.kill(recovered.pid, 'SIGKILL');
      const killedAt = Date.now();
      const orphaned = await settleIpc(window, 'directory', probeD);
      expect(orphaned.ok).toBe(true);
      expect(orphaned.value.entries.map(({ name }) => name)).toEqual([
        'probe-d.txt',
      ]);
      const orphanedTraffic = filesTraffic(await counters.read());
      // Answered in-process: a fallback, or a skip once the restart failed.
      expect(
        Object.keys(orphanedTraffic.route).filter(
          (key) =>
            key.includes('.daemon.fallback.') ||
            key === 'files.directory.daemon.bypassed',
        ),
      ).toHaveLength(1);
      expect(orphanedTraffic.route['files.directory.daemon.served']).toBe(
        undefined,
      );
      // A missing executable fails the restart at once; the lease bounds a
      // retried or hung one at 30 s.
      await expect(notice).toBeVisible({ timeout: 30_000 });
      const noticeAfterMs = Date.now() - killedAt;
      const orphanedAttempts = [];
      await expect
        .poll(
          async () => {
            await counters.reset();
            const result = await settleIpc(window, 'directory', probeD);
            orphanedAttempts.push(result.ok ? 'ok' : result.message);
            return filesTraffic(await counters.read()).route[
              'files.directory.daemon.bypassed'
            ];
          },
          { timeout: 30_000 },
        )
        .toBe(1);
      expect(orphanedAttempts.every((attempt) => attempt === 'ok')).toBe(true);
      // The lease's failed restart latched it, or a new session's start did
      // once the lease gave up.
      const blocked = await backgroundServiceStatus(window);
      expect(blocked.state).toBe('unavailable');
      expect(['reconnect_failed', 'start_failed']).toContain(blocked.reason);
      report.steps.killWithStartBlocked = {
        traffic: orphanedTraffic,
        noticeAfterMs,
        status: await backgroundServiceStatus(window),
      };

      // Turning Files reads off while warned clears the notice.
      await setFilesChoice(window, false);
      await expect(notice).toHaveCount(0);
      expect(await backgroundServiceStatus(window)).toMatchObject({
        state: 'ok',
        retry: 'idle',
      });

      // And on again with the executable back, the next read starts a new
      // daemon and is served by it.
      expect(context.bridge.restage('packaged daemon')).toBe('restaged');
      await setFilesChoice(window, true);
      await counters.reset();
      expect(
        (await ipcDirectory(window, scope, SINGLE, `${GOLDEN_DIR}/probe-d`))
          .entries,
      ).toHaveLength(1);
      expectDaemonServed(filesTraffic(await counters.read()), ['directory']);
      const restarted = readDescriptor(canonicalDataRoot);
      expect(restarted.pid).not.toBe(recovered.pid);
      context.seenDescriptors.push(restarted);
      await expect(notice).toHaveCount(0);
      report.steps.restartAfterFlagReturn = {
        descriptor: restarted,
        process: await proveBridgedDaemon(context, restarted),
      };
    },
  );
});

function seedMultiRepo(dataRoot) {
  const seed = seedDemoWorkspaces({
    userDataDir: dataRoot,
    apps: ['multi-repo-fullstack'],
  });
  const { worktreePath } = seed.workspaces.find(({ id }) => id === MULTI);
  writeGoldenFixture(worktreePath);
  seedWorktreeChat({
    userDataDir: dataRoot,
    workspaceId: MULTI,
    worktreeId: WORKTREE,
    providerType: 'claude',
    tabs: [{ id: MULTI_CHAT, title: 'Chat' }],
  });
  mergeSeedPreferences(dataRoot, FIXTURE_PREFERENCES);
  return { worktreePath };
}

function coworkHome(dataRoot) {
  const index = JSON.parse(
    readFileSync(path.join(dataRoot, 'workspaces/index.json'), 'utf8'),
  );
  const cowork = index.workspaces.filter(({ type }) => type === 'cowork');
  expect(cowork).toHaveLength(1);
  const { id, name } = cowork[0];
  const config = JSON.parse(
    readFileSync(
      path.join(dataRoot, 'workspaces', id, 'workspace.json'),
      'utf8',
    ),
  );
  return {
    id,
    name,
    home: config.externalPath ?? path.join(dataRoot, 'workspaces', id, 'home'),
  };
}

for (const enabled of [null, true])
  test(`experiment ${enabled ? 'on' : 'off'}: multi-repo and Cowork panels keep golden roots, order and managed exclusions ${enabled ? 'over the daemon' : 'on direct reads'}`, async ({}, testInfo) => {
    test.setTimeout(300_000);
    // Opt-out is the direct baseline for the same scopes and golden rows.
    const expectServed = enabled ? expectDaemonServed : expectDirectOnly;
    await withDaemonFilesApp(
      testInfo,
      { enabled, seed: seedMultiRepo },
      async (context) => {
        const { window, app, counters, report, canonicalDataRoot, dataRoot } =
          context;
        const { worktreePath } = context.seeded;
        const scope = { projectId: MULTI, worktreeId: WORKTREE };
        await selectWorktree(window, MULTI);
        expect(readDescriptor(canonicalDataRoot)).toBeNull();
        await counters.reset();
        const panel = await openFilesPanel(window, { chatTabId: MULTI_CHAT });
        await expect
          .poll(() => panelRoots(panel))
          .toEqual([
            { id: '__workspace_root__', label: 'Project root' },
            { id: 'web', label: 'Web App' },
            { id: 'api', label: 'API Service' },
          ]);
        await expandFolder(panel, '__workspace_root__', '');
        // The child checkouts under `repos/` are their own roots, never
        // entries of the workspace root.
        await expect
          .poll(() => panelChildren(panel, '__workspace_root__', ''))
          .toEqual([
            { name: MANAGED_DIR, kind: 'directory', ignored: false },
            { name: GOLDEN_DIR, kind: 'directory', ignored: false },
            { name: '.gitignore', kind: 'file', ignored: false },
            { name: 'canopy.json', kind: 'file', ignored: false },
            { name: 'README.md', kind: 'file', ignored: false },
          ]);
        await expandFolder(panel, '__workspace_root__', GOLDEN_DIR);
        await expect
          .poll(() => panelChildren(panel, '__workspace_root__', GOLDEN_DIR))
          .toEqual(goldenPanelRows(GOLDEN_DIR));
        await expandFolder(panel, 'web', '');
        await expect
          .poll(async () => (await panelChildren(panel, 'web', '')).length)
          .toBeGreaterThan(0);
        expect(
          (await panelChildren(panel, 'web', '')).map(({ name }) => name),
        ).not.toContain('.git');
        const multiTraffic = filesTraffic(await counters.read());
        expectServed(multiTraffic, ['roots', 'directory']);
        expect(await ipcRoots(window, scope)).toEqual({
          imageSaveSupport: DESKTOP_FILE_IMAGE_SAVE_SUPPORT,
          roots: [
            {
              repoId: '__workspace_root__',
              repoName: 'Project root',
              absolutePath: worktreePath,
              rootKind: 'workspace-root',
            },
            {
              repoId: 'web',
              repoName: 'Web App',
              absolutePath: path.join(worktreePath, 'repos/web'),
              rootKind: 'git-repo',
            },
            {
              repoId: 'api',
              repoName: 'API Service',
              absolutePath: path.join(worktreePath, 'repos/api'),
              rootKind: 'git-repo',
            },
          ],
        });
        expect(
          await ipcDirectory(window, scope, '__workspace_root__', GOLDEN_DIR),
        ).toEqual({ entries: goldenIpcEntries(worktreePath, GOLDEN_DIR) });
        const descriptor = enabled ? readDescriptor(canonicalDataRoot) : null;
        if (descriptor) context.seenDescriptors.push(descriptor);
        report.steps.multiRepo = {
          traffic: multiTraffic,
          process:
            descriptor && (await proveBridgedDaemon(context, descriptor)),
        };

        // Cowork: the default project, with its managed folders surfaced as
        // their own roots and excluded from the workspace folder.
        await app.openChatPage();
        await window.getByTestId('empty-new-chat').click();
        await expect(window.getByTestId('cowork-top-bar')).toBeVisible({
          timeout: 30_000,
        });
        const { id: coworkId, name: coworkName, home } = coworkHome(dataRoot);
        writeGoldenFixture(home);
        const managed = path.join(home, MANAGED_DIR);
        for (const [relative, text] of [
          ['keep.txt', 'kept\n'],
          ['notes/note.md', '# note\n'],
          ['prompts/prompt.md', 'prompt\n'],
          ['attachments/attached.txt', 'attached\n'],
        ]) {
          mkdirSync(path.dirname(path.join(managed, relative)), {
            recursive: true,
          });
          writeFileSync(path.join(managed, relative), text);
        }
        await counters.reset();
        const coworkPanel = await openFilesPanel(window);
        // App-owned roots start inside the collapsed brand group.
        await expect
          .poll(() => panelRoots(coworkPanel))
          .toEqual([{ id: 'workspace', label: coworkName }]);
        await expandAppManagedRootGroup(coworkPanel);
        await expect
          .poll(() => panelRoots(coworkPanel))
          .toEqual([
            { id: 'workspace', label: coworkName },
            { id: 'notes', label: 'notes' },
            { id: 'prompts', label: 'prompts' },
            { id: 'attachments', label: 'attachments' },
          ]);
        await expandFolder(coworkPanel, 'workspace', '');
        await expandFolder(coworkPanel, 'workspace', MANAGED_DIR);
        await expect
          .poll(() => panelChildren(coworkPanel, 'workspace', MANAGED_DIR))
          .toEqual([{ name: 'keep.txt', kind: 'file', ignored: false }]);
        await expandFolder(coworkPanel, 'workspace', GOLDEN_DIR);
        await expect
          .poll(() => panelChildren(coworkPanel, 'workspace', GOLDEN_DIR))
          .toEqual(goldenPanelRows(GOLDEN_DIR, { gitAware: false }));
        const coworkTraffic = filesTraffic(await counters.read());
        expectServed(coworkTraffic, ['roots', 'directory']);
        const coworkScope = {
          projectId: 'standalone-chat',
          worktreeId: coworkId,
        };
        expect(await ipcRoots(window, coworkScope)).toEqual({
          imageSaveSupport: DESKTOP_FILE_IMAGE_SAVE_SUPPORT,
          roots: [
            ['workspace', coworkName, home, 'standalone'],
            ['notes', 'notes', path.join(managed, 'notes'), 'standalone'],
            ['prompts', 'prompts', path.join(managed, 'prompts'), 'standalone'],
            [
              'attachments',
              'attachments',
              path.join(managed, 'attachments'),
              'attachments',
            ],
          ].map(([repoId, repoName, absolutePath, rootKind]) => ({
            repoId,
            repoName,
            absolutePath,
            rootKind,
          })),
        });
        expect(
          await ipcDirectory(window, coworkScope, 'workspace', GOLDEN_DIR),
        ).toEqual({
          entries: goldenIpcEntries(home, GOLDEN_DIR, { gitAware: false }),
        });
        if (enabled) {
          // The same daemon served both scopes.
          expect(readDescriptor(canonicalDataRoot).pid).toBe(descriptor.pid);
        } else {
          expect(daemonRuntimeEntries(canonicalDataRoot)).toEqual([]);
          expect(
            await daemonChildren(context.mainPid, context.bridge.executable),
          ).toEqual([]);
        }
        report.steps.cowork = { coworkId, traffic: coworkTraffic };
      },
    );
  });
