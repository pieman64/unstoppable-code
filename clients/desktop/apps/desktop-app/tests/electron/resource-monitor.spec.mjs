// Doc 2 Spec 9 — resource monitor attribution coverage (PRs 811 / 706).
//
// Verifies the sidebar resource-diagnostics pill opens the popover and renders
// attribution rows for an injected `ResourceMonitorSnapshot`:
//   - a "Browser" group/attribution row (in-app-browser process);
//   - a "Script" group/attribution row;
//   - NO duplicate "App" group summary (PR 811's core claim);
//   - per-process `resource-row-${process.id}` rows;
//   - CPU values clamped to <= 100% (PR 706) for an over-100 sample.
//
// Snapshot state is injected at runtime via the H7 helper
// (`injectResourceSnapshot`), which emits the same `resource-monitor:snapshot`
// IPC event the main-process service broadcasts. Because the live resource
// sampler may also push real snapshots, every assertion polls so a racing live
// sample that lands between injections is retried away.

import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  buildResourceSnapshot,
  injectResourceSnapshot,
} from './seeders/index.mjs';

// A worktree the injected processes are attributed to. It does not need to be
// a real/navigable worktree — attribution rows render with the raw projectId /
// worktreeId fallback labels when the project is not hydrated in the sidebar.
const PROJECT_ID = 'seeded-project';
const WORKTREE_ID = 'seeded-worktree';

const BROWSER_PROCESS_ID = 'browser:browser-1';
const SCRIPT_PROCESS_ID = 'script:script-1';
const ELECTRON_MAIN_PROCESS_ID = 'electron-main';
const OTHER_ELECTRON_PROCESS_ID = 'other-electron-helper';

async function revealResourceDiagnosticsPill(window) {
  const pill = window.getByTestId('sidebar-resource-diagnostics-pill');
  await expect(pill).toBeVisible();
  return pill;
}

function buildGroup(id, label, items) {
  return {
    id,
    label,
    cpuPercent: items.reduce((total, item) => total + item.cpuPercent, 0),
    memoryRssBytes: items.reduce(
      (total, item) => total + item.memoryRssBytes,
      0,
    ),
    processCount: items.reduce((total, item) => total + item.processCount, 0),
    items,
  };
}

/**
 * Build the test snapshot: a `browser` group (rendered with the "Browser"
 * group label) holding an in-app browser process whose CPU is intentionally
 * > 100% to exercise PR 706 clamping, and a `scripts` group (rendered with the
 * "Script" group label) holding a script process. Both processes are attributed
 * to the same worktree. Deliberately omits any `app` group so we can assert
 * there is no duplicate "App" summary/row (PR 811).
 *
 * Group labels are sourced from the renderer's `GROUP_LABELS` map keyed by
 * group `id` (`apps/desktop-app/src/renderer/src/components/resource-diagnostics/ResourceDiagnosticsPopover.tsx`):
 * `browser` -> "Browser", `scripts` -> "Script".
 */
function buildAttributionSnapshot() {
  const browserProcess = {
    id: BROWSER_PROCESS_ID,
    kind: 'in-app-browser',
    groupId: 'browser',
    label: 'In-app browser',
    pid: 2001,
    // Over 100% on purpose — the formatter must clamp this to "100".
    cpuPercent: 150,
    memoryRssBytes: 180 * 1024 * 1024,
    processCount: 1,
    status: 'running',
    metadata: {
      type: 'browser',
      browser: {
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        browserId: 'browser-1',
        title: 'Seeded Page',
        displayUrl: 'example.com',
        visible: true,
        status: 'ready',
      },
    },
  };

  const scriptProcess = {
    id: SCRIPT_PROCESS_ID,
    kind: 'script',
    groupId: 'scripts',
    label: 'dev server',
    pid: 2002,
    cpuPercent: 6,
    memoryRssBytes: 120 * 1024 * 1024,
    processCount: 1,
    status: 'running',
    metadata: {
      type: 'script',
      script: {
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        scriptKey: 'launch',
        scriptName: 'launch',
        scriptLabel: 'Launch',
        // Must be a valid ScriptResourceMetadata target accepted by the preload
        // validator (`apps/desktop-app/src/preload/resource-monitor-validation.ts`):
        // 'project' | 'workspace-repo' | 'workspace-root'.
        target: 'workspace-root',
      },
    },
  };

  return buildResourceSnapshot({
    groups: [
      buildGroup('browser', 'Browser', [browserProcess]),
      buildGroup('scripts', 'Script', [scriptProcess]),
    ],
  });
}

function buildElectronAppDisplaySnapshot() {
  const electronMainProcess = {
    id: ELECTRON_MAIN_PROCESS_ID,
    kind: 'electron-main',
    groupId: 'app',
    label: 'Electron main',
    pid: 2101,
    cpuPercent: 4,
    memoryRssBytes: 90 * 1024 * 1024,
    processCount: 1,
    status: 'running',
  };

  const otherElectronProcess = {
    id: OTHER_ELECTRON_PROCESS_ID,
    kind: 'other',
    groupId: 'other',
    label: 'Electron helper',
    pid: 2102,
    cpuPercent: 2,
    memoryRssBytes: 50 * 1024 * 1024,
    processCount: 1,
    status: 'running',
    metadata: { type: 'generic' },
  };

  return buildResourceSnapshot({
    groups: [
      buildGroup('app', 'App', [electronMainProcess]),
      buildGroup('other', 'Other', [otherElectronProcess]),
    ],
  });
}

test('resource popover renders browser/script attribution rows without a duplicate App row and clamps CPU to 100%', async ({}, testInfo) => {
  // Pin the live resource sampler to an effectively-never interval so it emits
  // at most one real sample at startup and then leaves our injected snapshot in
  // place. (`apps/desktop-app/src/main/resource-monitor/service.ts` reads
  // `CANOPY_RESOURCE_MONITOR_INTERVAL_MS`; 2147483647 is the max setInterval
  // delay Node honors without clamping to 1ms.)
  const { electronApp, userDataDir } = await launchCanopy({
    env: { CANOPY_RESOURCE_MONITOR_INTERVAL_MS: '2147483647' },
  });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();

    const snapshot = buildAttributionSnapshot();

    // Seed an initial snapshot so the pill has non-null state and the popover
    // can render once opened (the popover only mounts when snapshot !== null).
    await injectResourceSnapshot(electronApp, snapshot);

    const pill = await revealResourceDiagnosticsPill(window);
    await pill.click();

    const popover = window.getByTestId('resource-diagnostics-popover');
    await expect(popover).toBeVisible();

    // Re-inject after the popover is open to win any race against a live
    // sample that may have landed between the first injection and the click.
    await injectResourceSnapshot(electronApp, snapshot);

    const browserRow = window.getByTestId(`resource-row-${BROWSER_PROCESS_ID}`);
    const scriptRow = window.getByTestId(`resource-row-${SCRIPT_PROCESS_ID}`);

    // Per-process rows render (re-inject inside the poll so a racing live
    // sample that replaces the store state is retried away).
    await expect
      .poll(
        async () => {
          await injectResourceSnapshot(electronApp, snapshot);
          return browserRow.count();
        },
        { timeout: 10_000 },
      )
      .toBeGreaterThan(0);
    await expect(browserRow).toBeVisible();
    await expect(scriptRow).toBeVisible();

    // Browser attribution: row shows the "Browser" group label plus the
    // worktree attribution and display URL in its secondary line.
    await expect(browserRow).toContainText('In-app browser');
    await expect(browserRow).toContainText('Browser');
    await expect(browserRow).toContainText(WORKTREE_ID);

    // Script attribution: row shows the "Script" group label plus attribution.
    await expect(scriptRow).toContainText('dev server');
    await expect(scriptRow).toContainText('Script');
    await expect(scriptRow).toContainText(WORKTREE_ID);

    // PR 811: no duplicate "App" row. The injected snapshot has no `app`
    // group, so neither an App summary chip nor any App-group resource row
    // should appear.
    const appSummary = popover.getByText(/^App:/);
    await expect(appSummary).toHaveCount(0);
    const appRows = popover.locator('[data-testid^="resource-row-app:"]');
    await expect(appRows).toHaveCount(0);

    // The only two rendered rows are the browser + script processes.
    await expect(popover.locator('tbody tr')).toHaveCount(2);

    // PR 706: the 150% browser CPU sample is clamped to 100% in its CPU cell.
    // CPU is the 3rd cell, after the source icon and name; assert the
    // rendered text is exactly "100%".
    const browserCpuCell = browserRow.locator('td').nth(2);
    await expect(browserCpuCell).toHaveText('100%');

    // Sanity: the under-100 script CPU is shown verbatim (rounded), not clamped.
    const scriptCpuCell = scriptRow.locator('td').nth(2);
    await expect(scriptCpuCell).toHaveText('6%');

    // The panel is portaled to the body so the sidebar cannot clip it: it is
    // wider than the sidebar, extends past the sidebar's right edge, and still
    // sits fully inside the viewport.
    const sidebarBox = await window
      .getByTestId('app-sidebar')
      .boundingBox({ timeout: 5_000 });
    const popoverBox = await popover.boundingBox({ timeout: 5_000 });
    expect(sidebarBox).not.toBeNull();
    expect(popoverBox).not.toBeNull();
    expect(popoverBox.x + popoverBox.width).toBeGreaterThan(
      sidebarBox.x + sidebarBox.width,
    );
    const viewport = await window.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    const viewportTolerancePx = 1;
    expect(popoverBox.x).toBeGreaterThanOrEqual(-viewportTolerancePx);
    expect(popoverBox.y).toBeGreaterThanOrEqual(-viewportTolerancePx);
    expect(popoverBox.x + popoverBox.width).toBeLessThanOrEqual(
      viewport.width + viewportTolerancePx,
    );
    expect(popoverBox.y + popoverBox.height).toBeLessThanOrEqual(
      viewport.height + viewportTolerancePx,
    );

    // Sort headers exist for all three columns.
    await expect(
      popover.getByTestId('resource-diagnostics-popover-sort-name'),
    ).toBeVisible();
    await expect(
      popover.getByTestId('resource-diagnostics-popover-sort-cpu'),
    ).toBeVisible();
    await expect(
      popover.getByTestId('resource-diagnostics-popover-sort-memory'),
    ).toBeVisible();

    await window.screenshot({
      path: testInfo.outputPath('resource-monitor-attribution.png'),
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('resource popover strips Electron prefix only for App process rows', async ({}, testInfo) => {
  const { electronApp, userDataDir } = await launchCanopy({
    env: { CANOPY_RESOURCE_MONITOR_INTERVAL_MS: '2147483647' },
  });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();

    const snapshot = buildElectronAppDisplaySnapshot();

    await injectResourceSnapshot(electronApp, snapshot);

    const pill = await revealResourceDiagnosticsPill(window);
    await pill.click();

    const popover = window.getByTestId('resource-diagnostics-popover');
    await expect(popover).toBeVisible();
    await injectResourceSnapshot(electronApp, snapshot);

    const appRow = window.getByTestId(
      `resource-row-${ELECTRON_MAIN_PROCESS_ID}`,
    );
    const otherRow = window.getByTestId(
      `resource-row-${OTHER_ELECTRON_PROCESS_ID}`,
    );

    await expect
      .poll(
        async () => {
          await injectResourceSnapshot(electronApp, snapshot);
          return appRow.count();
        },
        { timeout: 10_000 },
      )
      .toBeGreaterThan(0);

    await expect(appRow).toBeVisible();
    await expect(otherRow).toBeVisible();
    await expect(
      appRow.locator('td').nth(1).getByText('Main', { exact: true }),
    ).toHaveText('Main');
    await expect(otherRow).toContainText('Electron helper');
    await expect(appRow).not.toContainText('Electron main');

    await window.screenshot({
      path: testInfo.outputPath('resource-monitor-app-electron-display.png'),
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('resource popover collapses agent process trees and totals app processes in the footer', async () => {
  const { electronApp, userDataDir } = await launchCanopy({
    env: { CANOPY_RESOURCE_MONITOR_INTERVAL_MS: '2147483647' },
  });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();

    const mib = 1024 * 1024;
    const snapshot = buildResourceSnapshot({
      groups: [
        buildGroup('app', 'App', [
          {
            id: 'electron:3000',
            kind: 'electron-main',
            groupId: 'app',
            label: 'Electron main',
            pid: 3000,
            cpuPercent: 4,
            memoryRssBytes: 300 * mib,
            processCount: 1,
            status: 'running',
          },
        ]),
        buildGroup('claude', 'Claude', [
          {
            id: 'claude:3001',
            kind: 'chat-provider',
            groupId: 'claude',
            label: 'claude',
            pid: 3001,
            ppid: 3000,
            cpuPercent: 10,
            memoryRssBytes: 400 * mib,
            processCount: 1,
            status: 'running',
            metadata: { type: 'generic' },
          },
        ]),
        buildGroup('other', 'Other', [
          {
            id: 'other:3002',
            kind: 'other',
            groupId: 'other',
            label: 'bash',
            pid: 3002,
            ppid: 3001,
            cpuPercent: 1,
            memoryRssBytes: 10 * mib,
            processCount: 1,
            status: 'running',
            metadata: { type: 'generic' },
          },
          {
            id: 'other:3003',
            kind: 'other',
            groupId: 'other',
            label: 'git',
            pid: 3003,
            ppid: 3000,
            cpuPercent: 2,
            memoryRssBytes: 20 * mib,
            processCount: 1,
            status: 'running',
            metadata: { type: 'generic' },
          },
        ]),
      ],
    });

    await injectResourceSnapshot(electronApp, snapshot);
    const pill = await revealResourceDiagnosticsPill(window);
    await pill.click();
    const popover = window.getByTestId('resource-diagnostics-popover');
    await expect(popover).toBeVisible();
    // Synthetic clicks bypass app-region, so assert the computed region: the
    // portaled panel must punch a hole in drag rects beneath its controls.
    await expect(
      popover.getByTestId('resource-diagnostics-popover-content'),
    ).toHaveCSS('-webkit-app-region', 'no-drag');

    const agentRow = window.getByTestId('resource-row-claude:3001');
    await expect
      .poll(
        async () => {
          await injectResourceSnapshot(electronApp, snapshot);
          return agentRow.count();
        },
        { timeout: 10_000 },
      )
      .toBeGreaterThan(0);

    // The agent's shell nests under it, collapsed, and rolls into its usage.
    const shellRow = window.getByTestId('resource-row-other:3002');
    await expect(shellRow).toHaveCount(0);
    await expect(agentRow.locator('td').nth(2)).toHaveText('11%');

    // Only Electron and the commands the app runs count toward the footer.
    const footer = popover.getByTestId(
      'resource-diagnostics-popover-app-totals',
    );
    await expect(footer).toContainText('App processes');
    await expect(footer).toContainText('6% CPU');
    await expect(footer).toContainText('320.0 MB');

    const toggle = agentRow.getByRole('button', { name: 'Expand claude' });
    await agentRow.hover();
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(shellRow).toBeVisible();
    await expect(
      agentRow.getByRole('button', { name: 'Collapse claude' }),
    ).toHaveAttribute('aria-expanded', 'true');

    await agentRow.getByRole('button', { name: 'Collapse claude' }).click();
    await expect(shellRow).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
