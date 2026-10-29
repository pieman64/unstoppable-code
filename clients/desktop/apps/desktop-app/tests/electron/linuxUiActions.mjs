import { expect } from '@playwright/test';

/**
 * Hidden-window-safe UI actions for the native Linux Electron specs.
 *
 * Hidden native Linux windows can suspend the animation frames Playwright's
 * "stable" actionability check waits on, stalling an ordinary click or hover
 * for its full timeout even with background throttling off. On Linux only,
 * these actions assert the control is visible and enabled themselves and then
 * act with `force: true` (which skips the stable check). macOS and Windows keep
 * Playwright's default click/hover, and the Settings navigation methods
 * delegate to the wrapped driver unchanged there.
 *
 * The wrapper composes a `CanopyAppDriver` instance: it never subclasses it or
 * patches the instance or prototype, and reads only its public `window` and
 * `expectSettingsSection` / `expectAccountSettingsPage`. Callers keep the real driver for everything else
 * (for example `waitForShell`) and use the wrapper only for the interactions
 * that need the Linux-safe click.
 *
 * @param {import('./canopyApp.mjs').CanopyAppDriver} driver
 */
export function createLinuxUiActions(driver) {
  const { window } = driver;
  const isLinux = () => process.platform === 'linux';

  // `options.timeout` bounds the visible/enabled assertions.
  async function expectInteractable(locator, { timeout } = {}) {
    await expect(locator).toBeVisible({ timeout });
    await expect(locator).toBeEnabled({ timeout });
  }

  async function clickVisibleControl(locator, options = {}) {
    if (!isLinux()) return locator.click();
    await expectInteractable(locator, options);
    return locator.click({ force: true });
  }

  async function hoverVisibleControl(locator, options = {}) {
    if (!isLinux()) return locator.hover();
    await expectInteractable(locator, options);
    return locator.hover({ force: true });
  }

  async function openAccountMenuLinux() {
    const menu = window.getByTestId('sidebar-account-menu');
    if (!(await menu.isVisible())) {
      await clickVisibleControl(window.getByTestId('sidebar-account-row'));
      await expect(menu).toBeVisible();
    }
  }

  async function openSettings() {
    if (!isLinux()) return driver.openSettings();
    const directSettingsAction = window.getByTestId(
      'sidebar-account-action-settings',
    );
    if (await directSettingsAction.isVisible()) {
      await clickVisibleControl(directSettingsAction);
    } else {
      await openAccountMenuLinux();
      await clickVisibleControl(
        window.getByTestId('sidebar-account-menu-item-settings'),
      );
    }
    await expect(window.getByTestId('settings-overlay')).toBeVisible();
  }

  async function openSettingsSection(section) {
    if (!isLinux()) return driver.openSettingsSection(section);
    await clickVisibleControl(window.getByTestId(`settings-nav-${section}`));
    await driver.expectSettingsSection(section);
  }

  async function openAccountSettingsPage(page) {
    if (!isLinux()) return driver.openAccountSettingsPage(page);
    await clickVisibleControl(
      window.getByTestId(`settings-nav-account-${page}`),
    );
    await driver.expectAccountSettingsPage(page);
  }

  async function closeSettings() {
    if (!isLinux()) return driver.closeSettings();
    await clickVisibleControl(window.getByTestId('settings-nav-back'));
    await expect(window.getByTestId('settings-overlay')).toBeHidden();
  }

  return {
    clickVisibleControl,
    hoverVisibleControl,
    openSettings,
    openSettingsSection,
    openAccountSettingsPage,
    closeSettings,
  };
}
