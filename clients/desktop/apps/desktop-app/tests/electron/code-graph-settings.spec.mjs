import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { projectSettingsNav } from './projectSettingsDriver.mjs';

const WORKSPACE_NAME = 'TypeScript pnpm Vite';
// Catalog glyph shared by every Code Graph surface: `GraphIcon` from both
// `@canopy/ui-shared/icons` and its AppIcons catalog draws Lucide `network`.
const CODE_GRAPH_GLYPH = 'svg[data-glyph="network"]';

test('Code Graph settings live in their own Advanced page', async ({}, testInfo) => {
  const launched = await launchCanopy({
    seedDemoWorkspaces: true,
    demoWorkspaceApps: ['ts-pnpm-vite'],
  });
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.openSettings();

    const navEntry = window
      .getByTestId('settings-nav-group-advanced')
      .getByTestId('settings-nav-code-graph');
    await expect(navEntry).toBeVisible();
    await expect(navEntry).toContainText('Code Graph');
    await expect(navEntry.locator('svg[data-app-icon="true"]')).toHaveCount(1);
    await expect(navEntry.locator(CODE_GRAPH_GLYPH)).toHaveCount(1);

    await app.openSettingsSection('experiments');
    await expect(window.getByTestId('code-graph-mode-enabled')).toHaveCount(0);
    await expect(
      window.getByTestId('code-graph-generation-timeout'),
    ).toHaveCount(0);

    await app.openSettingsSection('code-graph');

    const enabled = window.getByTestId('code-graph-mode-enabled');
    const disabled = window.getByTestId('code-graph-mode-disabled');
    const selected = window.getByTestId('code-graph-mode-selected-workspaces');
    const timeout = window.getByTestId('code-graph-generation-timeout');

    // Availability is a segmented control: the chosen segment is the
    // pressed one.
    await expect(enabled).toHaveAttribute('aria-pressed', 'true');
    await expect(disabled).toHaveAttribute('aria-pressed', 'false');
    await disabled.click();
    await expect(disabled).toHaveAttribute('aria-pressed', 'true');
    await expect(enabled).toHaveAttribute('aria-pressed', 'false');
    await expect(timeout).toBeEnabled();

    await timeout.fill('0');
    await timeout.press('Enter');
    await expect(
      window.getByTestId('code-graph-generation-timeout-error'),
    ).toBeVisible();

    await timeout.fill('45');
    await timeout.press('Enter');
    await expect(timeout).toHaveValue('45');
    await expect(
      window.getByTestId('code-graph-generation-timeout-error'),
    ).toHaveCount(0);

    await selected.click();
    await expect(selected).toHaveAttribute('aria-pressed', 'true');
    await expect(
      window.getByTestId('code-graph-workspace-picker-list'),
    ).toBeVisible();
    const firstWorkspace = window
      .locator('[data-testid^="code-graph-workspace-picker-option-"]')
      .first();
    await expect(firstWorkspace).toBeVisible();
    await firstWorkspace.click();
    await expect(firstWorkspace).toHaveAttribute('aria-pressed', 'true');

    await window.screenshot({
      path: testInfo.outputPath('code-graph-settings.png'),
    });
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
  }
});

test('project settings Code Graph tab uses the code graph icon and links to its settings page', async () => {
  const launched = await launchCanopy({
    seedDemoWorkspaces: true,
    demoWorkspaceApps: ['ts-pnpm-vite'],
  });
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();

    // Turn Code Graph off so the project tab shows its settings link.
    await app.openSettings();
    await app.openSettingsSection('code-graph');
    const disabled = window.getByTestId('code-graph-mode-disabled');
    await disabled.click();
    await expect(disabled).toHaveAttribute('aria-pressed', 'true');
    await app.closeSettings();

    await app.workspaceHeaderLabel(WORKSPACE_NAME).hover();
    await app.workspaceSettingsButton(WORKSPACE_NAME).click();
    const dialog = window
      .locator('[role="dialog"]')
      .filter({ has: window.locator('#project-settings-title') });
    await expect(dialog).toBeVisible();

    const codeGraphTab = projectSettingsNav(app, 'code-graph');
    await expect(codeGraphTab.locator(CODE_GRAPH_GLYPH)).toHaveCount(1);
    await codeGraphTab.click();

    const openSettings = dialog.getByTestId('code-graph-summary-open-settings');
    await expect(openSettings).toHaveText('Open Code Graph settings');
    await openSettings.click();

    await expect(dialog).toHaveCount(0);
    await app.expectSettingsSection('code-graph');
    await expect(
      window.getByTestId('code-graph-mode-disabled'),
    ).toHaveAttribute('aria-pressed', 'true');
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
  }
});
