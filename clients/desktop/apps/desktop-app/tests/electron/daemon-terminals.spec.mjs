// Daemon terminals acceptance (CAN-5088) against the verified daemon artifact
// bridged into the product's lookup paths, as the Files acceptance does. With
// the daemon-terminals Labs experiment on, a terminal the main window opens
// runs in the daemon's supervised terminal host: the shell's grandparent is
// the daemon, it survives a renderer round trip, a terminal host fault ends
// it as lost with its scrollback kept, Restart recreates it in the daemon,
// and turning the experiment off sends the next terminal in process.
import { expect, test } from '@playwright/test';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  cleanupAbandonedDaemonFilesApp,
  readDescriptor,
  withDaemonFilesApp,
} from './helpers/daemon-files-panel.mjs';
import { DEFAULT_GROUP_IDS } from './panelHarness.mjs';

const WORKTREE = 'demo-main';
const PROJECT = 'demo-ts-pnpm-vite';

test.skip(
  process.platform !== 'darwin',
  'The packaged daemon artifact and owned-child host are macOS only.',
);

test.afterEach(cleanupAbandonedDaemonFilesApp);

async function selectWorktree(window) {
  const row = window
    .locator(
      `[data-testid="worktree-row"][data-project-id="${PROJECT}"][data-worktree-id="${WORKTREE}"]`,
    )
    .first();
  await expect(row).toBeAttached({ timeout: 30_000 });
  await row.evaluate((element) => element.click());
  await expect(window.getByTestId('panel-grid-root')).toBeVisible();
}

/**
 * The auto-started terminal's pane. Its first start also starts the daemon
 * and its terminal host, so it waits longer than an in-process start, and
 * clicks Start only once it is enabled.
 */
async function openTerminal(window) {
  const expand = window.locator(
    `[data-testid="panel-group-expand-${DEFAULT_GROUP_IDS.terminal}"]:visible`,
  );
  if ((await expand.count()) > 0) await expand.first().click();
  await expect(window.getByTestId('terminal-panel-surface')).toBeVisible();
  const pane = window.getByTestId('terminal-pane');
  const start = window
    .getByTestId('terminal-panel-surface')
    .getByRole('button', { name: 'Start terminal', exact: true });
  await expect
    .poll(
      async () => {
        if ((await pane.count()) > 0) return true;
        if ((await start.count()) > 0 && (await start.isEnabled()))
          await start.click().catch(() => undefined);
        return false;
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  await expect(pane).toBeVisible();
  return pane;
}

async function setTerminalsChoice(window, enabled) {
  const snapshot = await window.evaluate(
    (value) =>
      window.api.experiments.setChoice({
        experimentId: 'daemon-terminals',
        enabled: value,
      }),
    enabled,
  );
  expect(snapshot.ready).toBe(true);
  expect(
    snapshot.experiments.find((entry) => entry.id === 'daemon-terminals'),
  ).toMatchObject({
    flagKey: 'canopy-desktop-labs-daemon-terminals',
    choice: enabled,
    enabled,
  });
}

/** Types a command and waits until the pane shows `expected`. */
async function run(window, pane, command, expected) {
  await pane.click();
  await window.keyboard.type(command);
  await window.keyboard.press('Enter');
  await expect
    .poll(() => pane.innerText(), { timeout: 30_000 })
    .toContain(expected);
}

/** The shell's parent and grandparent pids. */
async function ptyParents(window, pane, marker) {
  await run(
    window,
    pane,
    `echo ${marker}-$PPID-$(ps -o ppid= -p $PPID | tr -d ' ')-end`,
    `${marker}-`,
  );
  await expect
    .poll(() => pane.innerText(), { timeout: 30_000 })
    .toMatch(new RegExp(`${marker}-\\d+-\\d+-end`));
  const match = new RegExp(`${marker}-(\\d+)-(\\d+)-end`).exec(
    await pane.innerText(),
  );
  return { parent: Number(match?.[1]), grandparent: Number(match?.[2]) };
}

test('runs renderer terminals in the daemon terminal host while the experiment is on', async ({}, testInfo) => {
  test.setTimeout(240_000);
  await withDaemonFilesApp(
    testInfo,
    {
      enabled: null,
      seed: (dataRoot) =>
        seedDemoWorkspaces({ userDataDir: dataRoot, apps: ['ts-pnpm-vite'] }),
    },
    async (context) => {
      const { window, canonicalDataRoot, report, mainPid } = context;
      await setTerminalsChoice(window, true);
      await selectWorktree(window);

      const pane = await openTerminal(window);
      await expect(pane).toBeVisible();
      const first = await ptyParents(window, pane, 'owner-a');
      const daemonPid = readDescriptor(canonicalDataRoot)?.pid;
      report.terminals = { mainPid, daemonPid, first };
      // The shell runs in the terminal host the daemon started.
      expect(first.grandparent).toBe(daemonPid);
      expect(first.parent).not.toBe(mainPid);
      await run(window, pane, 'echo daemon-$((40+2))', 'daemon-42');

      // A terminal host fault ends the terminal as lost, keeps its
      // scrollback read-only, and Restart recreates it in the daemon.
      await run(
        window,
        pane,
        '(sleep 0.5; kill -9 $PPID) & echo host-fault-armed',
        'host-fault-armed',
      );
      const restart = pane.getByTestId('terminal-restart-button');
      await expect(restart).toBeVisible({ timeout: 30_000 });
      await expect(pane).toContainText('The terminal connection was lost');
      await restart.click();
      await expect(restart).toBeHidden({ timeout: 30_000 });
      await expect
        .poll(() => pane.innerText(), { timeout: 30_000 })
        .toContain('[Terminal restarted]');
      await expect(pane).toContainText('daemon-42');
      const restarted = await ptyParents(window, pane, 'owner-b');
      report.terminals.restarted = restarted;
      expect(restarted.grandparent).toBe(daemonPid);
      expect(restarted.parent).not.toBe(first.parent);

      // Off: the same terminal's next shell starts in Electron main, from
      // the same persisted state, with nothing repaired.
      await setTerminalsChoice(window, false);
      await run(window, pane, 'exit', 'The shell exited');
      await expect(restart).toBeVisible({ timeout: 30_000 });
      await restart.click();
      await expect(restart).toBeHidden({ timeout: 30_000 });
      await expect(pane).toContainText('daemon-42');
      const inProcess = await ptyParents(window, pane, 'owner-c');
      report.terminals.inProcess = inProcess;
      expect(inProcess.parent).toBe(mainPid);
    },
  );
});
