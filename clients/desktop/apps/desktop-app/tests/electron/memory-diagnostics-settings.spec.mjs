// Covers opting into memory diagnostics, creating a report, and checking its
// saved artifacts. See docs/planning/2026-10-21-memory-diagnostics/phases/phase-06-settings-and-report.md.

import { readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

/** Whether the memory report overlay's card is what a click at its center hits. */
function overlayIsTopmost(window) {
  return window.evaluate(() => {
    const card = document.querySelector(
      '[data-testid="memory-report-overlay"]',
    );
    if (!(card instanceof HTMLElement)) return false;
    const rect = card.getBoundingClientRect();
    const hit = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    return hit !== null && card.contains(hit);
  });
}

async function enableMemoryDiagnostics(window, app) {
  await app.openSettings();
  await app.openSettingsSection('performance');
  const diagnosticsSwitch = window.getByTestId('settings-memory-diagnostics');
  await diagnosticsSwitch.scrollIntoViewIfNeeded();
  await diagnosticsSwitch.click();
  await expect(diagnosticsSwitch).toHaveAttribute('aria-checked', 'true');
  await expect(
    window.getByTestId('settings-create-memory-report'),
  ).toBeEnabled();
  await app.closeSettings();
}

test('memory diagnostics can create a report from Performance settings', async () => {
  test.setTimeout(240_000);

  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openSettings();
    await app.openSettingsSection('performance');

    const diagnostics = window
      .getByTestId('settings-tab-performance')
      .locator('section')
      .filter({
        has: window.getByRole('heading', {
          name: 'Diagnostics',
          exact: true,
        }),
      });
    await diagnostics.scrollIntoViewIfNeeded();
    await expect(diagnostics).toBeVisible();

    const diagnosticsSwitch = diagnostics.getByTestId(
      'settings-memory-diagnostics',
    );
    const createReportButton = diagnostics.getByTestId(
      'settings-create-memory-report',
    );

    await expect(diagnosticsSwitch).toHaveAttribute('aria-checked', 'false');
    await expect(createReportButton).toBeDisabled();

    await diagnosticsSwitch.click();
    await expect(diagnosticsSwitch).toHaveAttribute('aria-checked', 'true');
    await expect(createReportButton).toBeEnabled();

    await createReportButton.click();
    const confirmationDialog = window.getByTestId(
      'settings-memory-report-dialog',
    );
    await expect(confirmationDialog).toBeVisible();
    await expect(confirmationDialog).toHaveAttribute('role', 'dialog');
    await expect(confirmationDialog).toContainText('Create a memory report?');
    await expect(confirmationDialog).toContainText('chat and file content');
    await expect(confirmationDialog).toContainText(
      /about \d+ (second|minute)s?/,
    );

    await window.getByTestId('settings-memory-report-confirm').click();
    await expect(confirmationDialog).toBeHidden();

    // The progress overlay covers Settings and stays up with the outcome.
    const overlay = window.getByTestId('memory-report-overlay');
    await expect(overlay).toBeVisible();
    await expect(overlay).toContainText('Generating…');
    await expect(overlay).toContainText(
      /stop responding for about \d+ (second|minute)s? while it saves the report/,
    );
    await expect(window.getByTestId('memory-report-saved')).toBeVisible({
      timeout: 120_000,
    });
    await expect(overlay).toContainText('Memory report saved');
    await expect(window.getByTestId('settings-overlay')).toBeVisible();
    expect(await overlayIsTopmost(window)).toBe(true);
    await expect(window.getByTestId('memory-report-open-folder')).toBeVisible();
    await window.getByTestId('memory-report-done').click();
    await expect(overlay).toBeHidden();

    const reportResult = diagnostics.getByTestId(
      'settings-memory-report-result',
    );
    await expect(reportResult).toBeVisible();
    await expect(reportResult.getByRole('alert')).toHaveCount(0);

    const revealButton = reportResult.getByTestId(
      'settings-memory-report-reveal',
    );
    const revealLabel =
      process.platform === 'darwin'
        ? 'Show in Finder'
        : process.platform === 'win32'
          ? 'Show in File Explorer'
          : 'Show in Files';
    await expect(revealButton).toBeVisible();
    await expect(revealButton).toHaveAccessibleName(revealLabel);

    await expect(createReportButton).toBeEnabled();
    await expect(createReportButton).toHaveAccessibleName('Create report');

    // CANOPY_DATA_DIR is path-resolved, but the report service resolves the
    // memory-reports root to its canonical real path before writing into it.
    const reportsDirectory = await realpath(
      path.join(userDataDir, 'memory-reports'),
    );
    const reportDirectories = (
      await readdir(reportsDirectory, { withFileTypes: true })
    )
      .filter(
        (entry) => entry.isDirectory() && entry.name.startsWith('report-'),
      )
      .map((entry) => entry.name)
      .sort();
    expect(reportDirectories.length).toBeGreaterThan(0);

    const newestReportDirectory = path.join(
      reportsDirectory,
      reportDirectories[reportDirectories.length - 1],
    );
    const reportFiles = await readdir(newestReportDirectory);
    expect(reportFiles).toContain('summary.json');
    expect(reportFiles).not.toContain('native-memory.trace.json');
    expect(reportFiles).toContain('main.heapsnapshot');
    expect(reportFiles).toContain('main.heapprofile');
    expect(
      reportFiles.some((fileName) =>
        /^renderer-.*\.heapsnapshot$/.test(fileName),
      ),
    ).toBe(true);

    const summary = JSON.parse(
      await readFile(path.join(newestReportDirectory, 'summary.json'), 'utf8'),
    );
    expect(summary).not.toBeNull();
    expect(Array.isArray(summary)).toBe(false);
    expect(typeof summary).toBe('object');
    expect(summary.kind).toBe('report');
    expect(summary.sampling.active).toBe(true);
    expect(summary.sampling.included).toBe(true);
    // Renderer statistics come from Electron's real DevTools protocol route,
    // read just before each renderer snapshot. The main window must succeed.
    const mainRenderer = summary.rendererSnapshots.find(
      (snapshot) => snapshot.label === 'main',
    );
    expect(mainRenderer?.statisticsUnavailableReason).toBeUndefined();
    expect(mainRenderer?.heapUsage?.usedSize).toBeGreaterThan(0);
    expect(mainRenderer?.heapUsage?.totalSize).toBeGreaterThanOrEqual(
      mainRenderer?.heapUsage?.usedSize ?? Number.POSITIVE_INFINITY,
    );
    expect(mainRenderer?.domCounters?.nodes).toBeGreaterThan(0);
    expect(summary.processHistory).toMatchObject({
      reportsWrittenBefore: 0,
      mainSnapshotsWrittenBefore: 0,
    });
    expect(summary.processHistory.processUptimeSeconds).toBeGreaterThan(0);
    // One Chromium memory-infra dump, before the snapshots, for every process.
    expect(summary.nativeMemory).toMatchObject({
      captured: true,
      unavailableReason: null,
      missingProcessIds: [],
    });
    const rendererNativeMemory = summary.nativeMemory.processes.find(
      (entry) => entry.pid === mainRenderer?.processId,
    );
    expect(rendererNativeMemory?.privateFootprintBytes).toBeGreaterThan(0);
    expect(Object.keys(rendererNativeMemory?.allocators ?? {})).toEqual(
      expect.arrayContaining(['v8', 'blink_gc', 'partition_alloc']),
    );

    await diagnosticsSwitch.click();
    await expect(diagnosticsSwitch).toHaveAttribute('aria-checked', 'false');
    await expect(createReportButton).toBeDisabled();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('memory diagnostics can create a report from the resources popover', async () => {
  test.setTimeout(240_000);

  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();

    const pill = window.getByTestId('sidebar-resource-diagnostics-pill');
    const popover = window.getByTestId('resource-diagnostics-popover');
    const footer = popover.getByTestId(
      'resource-diagnostics-popover-memory-report',
    );
    await pill.click();
    await expect(popover).toBeVisible();
    // Hidden until memory diagnostics are on in Performance settings.
    await expect(
      popover.getByTestId('resource-diagnostics-popover-app-totals'),
    ).toBeVisible();
    await expect(footer).toHaveCount(0);
    await window.keyboard.press('Escape');
    await expect(popover).toBeHidden();

    await enableMemoryDiagnostics(window, app);

    await pill.click();
    await expect(footer).toBeVisible();
    await expect(
      footer.getByTestId('resource-diagnostics-popover-open-report'),
    ).toHaveCount(0);
    await footer
      .getByTestId('resource-diagnostics-popover-create-report')
      .click();
    await expect(popover).toBeHidden();

    await expect(
      window.getByTestId('settings-memory-report-dialog'),
    ).toBeVisible();
    await window.getByTestId('settings-memory-report-confirm').click();
    const overlay = window.getByTestId('memory-report-overlay');
    await expect(overlay).toContainText('Generating…');
    await expect(window.getByTestId('memory-report-saved')).toBeVisible({
      timeout: 120_000,
    });
    expect(await overlayIsTopmost(window)).toBe(true);
    await window.getByTestId('memory-report-done').click();
    await expect(overlay).toBeHidden();

    await pill.click();
    await expect(
      footer.getByTestId('resource-diagnostics-popover-open-report'),
    ).toBeVisible();
    await expect(
      footer.getByTestId('resource-diagnostics-popover-open-report'),
    ).toHaveText('Open folder');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
