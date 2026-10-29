import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const fixture =
  process.env.CURSOR_CHECK_LIVE_BINARY ??
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'fixtures/cursor-acp-agent.mjs',
  );

for (const decision of ['allow', 'deny', 'stop', 'leave']) {
  test(`Cursor approval check: ${decision} controls the actual file effect`, async ({}, testInfo) => {
    if (process.env.CURSOR_CHECK_LIVE_BINARY) test.setTimeout(150_000);
    const launched = await launchCanopy();
    try {
      const window = await launched.electronApp.firstWindow();
      const driver = new CanopyAppDriver(window);
      await driver.waitForShell();
      await driver.openSettings();
      await driver.openSettingsSection('experiments');
      const section = window.getByTestId('cursor-approval-check');
      await expect(section).toBeVisible();
      await section.getByLabel('Cursor executable').fill(fixture);
      await section
        .getByRole('button', { name: 'Test Cursor approvals' })
        .click();
      const card = section.getByTestId('tool-approval-card');
      await expect(card).toBeVisible({
        timeout: process.env.CURSOR_CHECK_LIVE_BINARY ? 90_000 : 15_000,
      });
      const target = await section
        .getByTestId('cursor-check-path')
        .textContent();
      expect(target).toBeTruthy();
      if (!process.env.CURSOR_CHECK_LIVE_BINARY) {
        const profile = path.join(
          path.dirname(path.dirname(target.trim())),
          'profile',
        );
        expect(
          JSON.parse(
            readFileSync(path.join(profile, 'fixture-args.json'), 'utf8'),
          ),
        ).toContain('--disable-auto-update');
      }
      expect(existsSync(target.trim())).toBe(false);
      if (decision === 'leave') {
        await driver.openSettingsSection('display');
      } else if (decision === 'stop') {
        await section.getByRole('button', { name: 'Stop' }).click();
      } else {
        await card.getByTestId(`tool-approval-${decision}`).click();
      }
      await expect(card).toHaveCount(0);
      if (decision !== 'leave') {
        await expect(section.getByTestId('cursor-check-status')).toHaveText(
          decision === 'allow'
            ? 'File created after approval.'
            : decision === 'deny'
              ? 'Edit rejected. No file created.'
              : 'Stopped. No file created.',
          { timeout: process.env.CURSOR_CHECK_LIVE_BINARY ? 90_000 : 15_000 },
        );
      }
      const root = path.dirname(path.dirname(target.trim()));
      // These are removed only after the owned process has been shut down.
      await expect
        .poll(() =>
          ['profile', 'hook'].some((name) => existsSync(path.join(root, name))),
        )
        .toBe(false);
      expect(existsSync(target.trim())).toBe(decision === 'allow');
      expect(
        await window.evaluate(() => window.api.approvals.pendingRequests()),
      ).toEqual([]);
      await testInfo.attach('cursor-check-result', {
        body: JSON.stringify({
          decision,
          target,
          fileExists: existsSync(target.trim()),
          privateStateRemoved: true,
        }),
        contentType: 'application/json',
      });
    } finally {
      await closeCanopy(launched.electronApp, launched.userDataDir);
    }
  });
}

test('Cursor diagnostic path settings never claim chat is enabled', async () => {
  const launched = await launchCanopy();
  try {
    const window = await launched.electronApp.firstWindow();
    const driver = new CanopyAppDriver(window);
    await driver.waitForShell();
    await driver.openSettings();
    await driver.openSettingsSection('experiments');
    const section = window.getByTestId('cursor-approval-check');
    await section.getByLabel('Cursor executable').fill(fixture);
    // Both labels address the same saved-path operation on before/after builds.
    await section
      .getByRole('button', {
        name: /^(Enable Cursor chat|Save diagnostic path)$/,
      })
      .click();
    await expect
      .poll(() => window.evaluate(() => window.api.loadPreferences()))
      .toMatchObject({ cursorAgentPath: fixture });
    expect(
      (await window.evaluate(() => window.api.loadPreferences())).cursorEnabled,
    ).not.toBe(true);
    await expect(
      section.getByText('Diagnostic path saved.', { exact: true }),
    ).toBeVisible();
    await expect(
      section.getByRole('button', { name: /^(Enable|Disable) Cursor chat$/ }),
    ).toHaveCount(0);
    await driver.closeSettings();
    await driver.openSettings();
    await driver.openSettingsSection('experiments');
    await expect(section.getByLabel('Cursor executable')).toHaveValue(fixture);
    await section.getByLabel('Cursor executable').fill('');
    await section
      .getByRole('button', { name: 'Save diagnostic path', exact: true })
      .click();
    await expect
      .poll(() => window.evaluate(() => window.api.loadPreferences()))
      .toMatchObject({ cursorAgentPath: '' });
    expect(
      (await window.evaluate(() => window.api.loadPreferences())).cursorEnabled,
    ).not.toBe(true);
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
  }
});
