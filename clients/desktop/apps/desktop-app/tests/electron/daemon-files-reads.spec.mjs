// Files panel acceptance against the separately packaged daemon (CAN-4307).
// The ordinary app reads through its production connection; the verified G2a
// artifact is bridged into the product's own lookup paths. Panel results are
// held to a golden listing written from the fixture definition, so a defect
// shared by the direct and daemon readers still fails.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  GOLDEN_DIR,
  FIXTURE_PREFERENCES,
  MANAGED_DIR,
  cleanupAbandonedDaemonFilesApp,
  cliDaemonStatus,
  daemonExitState,
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
  setFilesFlag,
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

test('flag off: the Files panel matches the golden listing on direct reads with zero daemon contact', async ({}, testInfo) => {
  test.setTimeout(240_000);
  // Unpinned, exactly as every other spec launches: the default is off.
  await withDaemonFilesApp(
    testInfo,
    { flag: null, seed: seedSingleRepo },
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
      // would look: no runtime state and no daemon child of Electron main.
      expect(existsSync(path.join(canonicalDataRoot, 'runtime'))).toBe(false);
      expect(
        await daemonChildren(context.mainPid, context.bridge.executable),
      ).toEqual([]);
      Object.assign(report.steps, {
        malformedOwner: unchanged.value,
        panel: { opened: traffic.opened, all: traffic.all },
        runtimeDirectory: 'absent',
      });
    },
  );
});

test('flag on: the Files panel is served by the bridged packaged daemon through loss, flag-off return and typed failures', async ({}, testInfo) => {
  test.setTimeout(420_000);
  await withDaemonFilesApp(
    testInfo,
    { flag: true, seed: seedSingleRepo },
    async (context) => {
      const { window, counters, report, canonicalDataRoot } = context;
      const scope = { projectId: SINGLE, worktreeId: WORKTREE };

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
      // contact, with its error; the flag-off return below compares them.
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

      // Bracketed lifecycle: no daemon before the panel action.
      await selectWorktree(window, SINGLE);
      expect(readDescriptor(canonicalDataRoot)).toBeNull();
      const traffic = await walkSingleRepoPanel(context);
      expectDaemonServed(traffic.opened, ['roots', 'directory']);
      expectDaemonServed(traffic.all, ['roots', 'directory']);
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

      // Daemon loss: the next reads reattach to a new bridged daemon and are
      // never answered by the direct reader.
      await counters.reset();
      process.kill(descriptor.pid, 'SIGKILL');
      const attempts = [];
      await expect
        .poll(
          async () => {
            const result = await settleIpc(window, 'directory', {
              ...scope,
              repoId: SINGLE,
              relativeDir: `${GOLDEN_DIR}/probe-c`,
            });
            attempts.push(result.ok ? 'ok' : result.message);
            return result.ok;
          },
          { timeout: 60_000 },
        )
        .toBe(true);
      const replacement = readDescriptor(canonicalDataRoot);
      expect(replacement.pid).not.toBe(descriptor.pid);
      context.seenDescriptors.push(replacement);
      await expandFolder(panel, SINGLE, `${GOLDEN_DIR}/probe-c`);
      await expect
        .poll(() => panelChildren(panel, SINGLE, `${GOLDEN_DIR}/probe-c`))
        .toEqual([{ name: 'probe-c.txt', kind: 'file', ignored: false }]);
      const lossTraffic = filesTraffic(await counters.read());
      expect(lossTraffic.route['files.directory.direct']).toBeUndefined();
      expect(lossTraffic.route['files.directory.daemon']).toBe(
        lossTraffic.directory,
      );
      report.steps.daemonLoss = {
        attempts,
        traffic: lossTraffic,
        replacement,
        process: await proveBridgedDaemon(context, replacement),
      };

      // Negative control and flag-off return: with the flag off, a read is
      // answered while the still-running daemon is stopped, so it cannot
      // have been served by the daemon.
      await setFilesFlag(context.electronApp, window, false);
      // Turning the flag off closes the session; stop the daemon only once
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
        (await window.evaluate(() => window.api.featureFlags.getSnapshot()))
          .values['canopy-desktop-daemon-files-reads'],
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

      // Typed transport failure: with the bridged executable gone the next
      // routed read fails typed and still never falls back.
      const executable = report.artifact.bridge.find(
        ({ label }) => label === 'packaged daemon',
      );
      if (!executable.owned) {
        // CI shards never unpack `dist/`: a reused file there is a leak.
        expect(
          process.env.CI,
          'CI must stage the daemon itself, so the start failure always runs',
        ).toBeFalsy();
        testInfo.annotations.push({
          type: 'limitation',
          description:
            'Executable-start failure not exercised: the product daemon path held a pre-existing identical build this run may not remove.',
        });
        return;
      }
      await setFilesFlag(context.electronApp, window, true);
      expect(context.bridge.remove('packaged daemon')).toBe('removed');
      await counters.reset();
      const failed = await settleIpc(window, 'directory', {
        ...scope,
        repoId: SINGLE,
        relativeDir: `${GOLDEN_DIR}/probe-d`,
      });
      expect(failed.ok).toBe(false);
      // The launcher redacts the spawn failure and keeps its kind.
      expect(failed.message).toMatch(/: Core launch failed\.$/);
      const failedTraffic = filesTraffic(await counters.read());
      expect(failedTraffic.route).toEqual({
        'files.directory.daemon': 1,
        'files.directory.daemon.failed.failed_precondition': 1,
      });
      await expandFolder(panel, SINGLE, `${GOLDEN_DIR}/probe-d`);
      await expect(panel.getByTestId('files-tree-folder-error')).toHaveText(
        'Unable to load folder.',
      );
      expect(readDescriptor(canonicalDataRoot)).toBeNull();
      report.steps.typedTransportFailure = {
        ...failed,
        traffic: failedTraffic,
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
  const { id } = cowork[0];
  const config = JSON.parse(
    readFileSync(
      path.join(dataRoot, 'workspaces', id, 'workspace.json'),
      'utf8',
    ),
  );
  return {
    id,
    home: config.externalPath ?? path.join(dataRoot, 'workspaces', id, 'home'),
  };
}

for (const flag of [null, true])
  test(`flag ${flag ? 'on' : 'off'}: multi-repo and Cowork panels keep golden roots, order and managed exclusions ${flag ? 'over the daemon' : 'on direct reads'}`, async ({}, testInfo) => {
    test.setTimeout(300_000);
    // Flag off is the legacy baseline for the same scopes and golden rows.
    const expectServed = flag ? expectDaemonServed : expectDirectOnly;
    await withDaemonFilesApp(
      testInfo,
      { flag, seed: seedMultiRepo },
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
        const descriptor = flag ? readDescriptor(canonicalDataRoot) : null;
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
        const { id: coworkId, home } = coworkHome(dataRoot);
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
        await expect
          .poll(() => panelRoots(coworkPanel))
          .toEqual([
            { id: 'workspace', label: 'Workspace' },
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
          roots: [
            ['workspace', 'Workspace', home, 'standalone'],
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
        if (flag) {
          // The same daemon served both scopes.
          expect(readDescriptor(canonicalDataRoot).pid).toBe(descriptor.pid);
        } else {
          expect(existsSync(path.join(canonicalDataRoot, 'runtime'))).toBe(
            false,
          );
          expect(
            await daemonChildren(context.mainPid, context.bridge.executable),
          ).toEqual([]);
        }
        report.steps.cowork = { coworkId, traffic: coworkTraffic };
      },
    );
  });
