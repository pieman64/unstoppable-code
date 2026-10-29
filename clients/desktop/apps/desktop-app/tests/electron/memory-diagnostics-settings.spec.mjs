// Covers opting into memory diagnostics, creating a report, and checking its
// saved artifacts. See docs/planning/2026-10-21-memory-diagnostics/phases/phase-06-settings-and-report.md.

import { readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

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

    const reportResult = diagnostics.getByTestId(
      'settings-memory-report-result',
    );
    await expect(reportResult).toBeVisible({ timeout: 120_000 });
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
    expect(reportFiles).toContain('main.heapsnapshot');
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

    await diagnosticsSwitch.click();
    await expect(diagnosticsSwitch).toHaveAttribute('aria-checked', 'false');
    await expect(createReportButton).toBeDisabled();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
