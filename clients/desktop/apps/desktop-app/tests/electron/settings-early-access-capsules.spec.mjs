import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { chooseSettingsOption } from './helpers/settingsSelect.mjs';

/** Appearance dropdowns keep their rounded-field geometry across Labs changes. */

function setEarlyAccess(window, enabled) {
  return window.evaluate(
    (value) =>
      window.api.experiments.setChoice({
        experimentId: 'early-access',
        enabled: value,
      }),
    enabled,
  );
}

test('Appearance dropdowns stay rounded fields across early access changes, in place', async () => {
  const launched = await launchCanopy();
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openSettings();
    await app.openSettingsSection('display');

    const track = window.getByTestId('settings-color-mode-select');
    await expect(track).toBeVisible();
    await expect(track).toHaveClass(/\brounded-row\b/);
    const trackHandle = await track.elementHandle();

    await setEarlyAccess(window, true);
    await expect(track).toHaveClass(/\brounded-row\b/);
    await expect(track).not.toHaveClass(/\brounded-full\b/);
    // Same node: the page's rows were not remounted by the toggle.
    expect(await trackHandle.evaluate((node) => node.isConnected)).toBe(true);

    await setEarlyAccess(window, false);
    await expect(track).toHaveClass(/\brounded-row\b/);
    expect(await trackHandle.evaluate((node) => node.isConnected)).toBe(true);
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
  }
});

test('Settings dropdowns share the rounded field and preserve the scrollbar preference', async () => {
  const launched = await launchCanopy();
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openSettings();
    await app.openSettingsSection('display');
    const scrollbars = window.getByTestId('settings-scrollbar-behavior');
    await expect(scrollbars).toHaveClass(/\brounded-row\b/);
    await chooseSettingsOption(scrollbars, 'always');
    await app.closeSettings();
    await app.openSettings();
    await app.openSettingsSection('display');
    await expect(scrollbars).toHaveAttribute('data-value', 'always');
    await expect(scrollbars).toHaveCSS('height', '28px');
    const selects = window
      .getByTestId('settings-tab-display')
      .locator('button[role="combobox"]');
    expect(await selects.count()).toBeGreaterThanOrEqual(3);
    for (const select of await selects.all())
      await expect(select).toHaveClass(/\brounded-row\b/);
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
  }
});

/**
 * Settings actions are the compact capsule: every shared `Button` on a desktop
 * Settings page is the 28px pill (`h-7 rounded-full text-xs`). The capsule is a
 * shape, not a role: primary actions keep the accent fill. Switches, tabs and
 * segments carry a role and are not actions.
 */
const ACCENT_FILL = /(?:^|\s)bg-accent(?:\s|$)/;
const PAGES_WITH_ACTIONS = [
  'canopy',
  'account',
  'account-proxy',
  'display',
  'browser',
  'environment',
  'files',
  'terminal',
  'shortcuts',
  'approvals',
  'plan-detection',
  'remote-access',
  'ollama',
  'experiments',
];
// Code Graph is left out: with no generations queued it has no actions.

test('Settings page actions are compact capsules that keep their role', async () => {
  const launched = await launchCanopy();
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openSettings();
    const overlay = window.locator('.settings-page-overlay');
    // The page itself, without the rail.
    const content = window.getByTestId('settings-content');
    const SELECTED = /(?:^|\s)bg-muted(?:\s|$)/;
    const heading = overlay.locator('h1').first();
    // Each page's own title, so no page is read twice or read for another.
    const titles = new Set();
    let capsules = 0;
    for (const section of PAGES_WITH_ACTIONS) {
      const nav = window.getByTestId(`settings-nav-${section}`);
      if ((await nav.count()) === 0) continue;
      const alreadyShowing = SELECTED.test(
        (await nav.getAttribute('class')) ?? '',
      );
      const previousTitle = alreadyShowing
        ? null
        : ((await heading.textContent()) ?? '').trim();
      await nav.click();
      await expect(nav).toHaveClass(SELECTED);
      // The rail selects at once while a page still loading renders in the
      // background, so the previous page can stay on screen: wait for the
      // heading to change and for every loading body (`SettingsLoading` and
      // the pages' own, all `*-loading`) to clear.
      if (previousTitle !== null)
        await expect(heading).not.toHaveText(previousTitle);
      await expect(heading).toBeVisible();
      await expect(content.locator('[data-testid$="-loading"]')).toHaveCount(0);
      const title = ((await heading.textContent()) ?? '').trim();
      expect(titles.has(title), `${section} shows ${title} again`).toBe(false);
      titles.add(title);
      // The shared `Button` draws `max-h-9` on every size; raw buttons
      // (field toggles, disclosures, rows) are not actions. Classes, not
      // measured boxes: the outgoing page can still be animating out.
      const pageActions = content.locator('button.max-h-9:not([role]):visible');
      // Every page listed here has actions; a page read with none was read
      // before it loaded.
      await expect(pageActions.first()).toBeVisible();
      const actions = await pageActions.evaluateAll((buttons) =>
        buttons.map((button) => ({
          label:
            button.textContent?.trim() ||
            button.getAttribute('aria-label') ||
            '',
          classes: button.getAttribute('class') ?? '',
        })),
      );
      capsules += actions.length;
      const notCapsules = actions
        .filter(
          ({ classes }) =>
            !['h-7', 'rounded-full', 'text-xs'].every((name) =>
              new RegExp(`(?:^|\\s)${name}(?:\\s|$)`).test(classes),
            ),
        )
        .map(({ label }) => label);
      expect({ section, notCapsules }).toEqual({ section, notCapsules: [] });
    }
    // The loop really walked the pages rather than skipping them all.
    expect(titles.size).toBeGreaterThan(8);
    expect(capsules).toBeGreaterThan(10);

    await app.openSettingsSection('environment');
    const newEnvironment = window.getByTestId('environments-new-environment');
    await expect(newEnvironment).toHaveClass(/\brounded-full\b/);
    await expect(newEnvironment).toHaveCSS('height', '28px');
    await expect(newEnvironment).toHaveClass(ACCENT_FILL);

    await window.getByTestId('settings-nav-browser').click();
    const createProfile = window.getByTestId('browser-profile-create');
    await expect(createProfile).toBeVisible();
    await expect(createProfile).toHaveClass(/\brounded-full\b/);
    await expect(createProfile).toHaveCSS('height', '28px');
    await expect(createProfile).toHaveClass(ACCENT_FILL);
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
  }
});
