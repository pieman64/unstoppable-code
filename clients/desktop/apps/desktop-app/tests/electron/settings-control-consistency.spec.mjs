import { expect, test } from '@playwright/test';
import { launchCanopyWithLabsPagesOffered } from './helpers/labsPages.mjs';
import {
  connectMockCloudAccount,
  registerHostedSettingsScenario,
  clearScenario,
  DEFAULT_MOCK_BASE_URL,
  readHostedSettingsState,
} from './seeders/index.mjs';
import {
  defaultHostedSettingsOrganizations,
  HOSTED_SETTINGS_ORG_IDS,
} from './mock-server/routes/hosted-settings-fixtures.mjs';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { openOrganizationsList } from './hostedSettingsLocators.mjs';
import { chooseSettingsOption } from './helpers/settingsSelect.mjs';

test('Settings number fields and model effort controls share capsule geometry and keep saved values', async () => {
  const launched = await launchCanopy();
  try {
    const page = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(page);
    await app.waitForShell();
    await app.openSettings();
    await app.openSettingsSection('canopy');
    const retention = page.locator('#settings-audit-retention-days');
    await expect(retention).toBeVisible();
    await retention.fill('12');
    await app.openSettingsSection('app-advisor');
    const row = page
      .locator('[data-testid="settings-content"] section')
      .filter({
        has: page.getByRole('heading', {
          name: 'Workflow monitoring',
          exact: true,
        }),
      });
    const selects = row.locator('button[role="combobox"]');
    await expect(selects).toHaveCount(2);
    for (const select of await selects.all()) {
      await expect(select).toHaveClass(/\brounded-full\b/);
      await expect(select).toHaveCSS('height', '28px');
      await expect(select).toHaveCSS('width', '144px');
    }
    expect((await selects.nth(0).boundingBox()).width).toBe(
      (await selects.nth(1).boundingBox()).width,
    );
    const effort = selects.nth(1);
    const value = await effort.getAttribute('data-value');
    await chooseSettingsOption(effort, value ?? '');
    await app.openSettingsSection('canopy');
    await expect(retention).toHaveValue('12');
    await expect(retention).toHaveClass(/\brounded-full\b/);
    await expect(retention).toHaveCSS('height', '28px');
    await connectMockCloudAccount(page, 'csk_settings_control_consistency');
    await app.openSettingsSection('remote-access');
    const add = page.getByTestId('settings-remote-access-add');
    await expect(add).toHaveClass(/\brounded-full\b/);
    await expect(add).toHaveCSS('height', '28px');
    const extraWidth = await add.evaluate((button) => {
      const text = document.createRange();
      text.selectNodeContents(button);
      const style = getComputedStyle(button);
      return (
        button.getBoundingClientRect().width -
        text.getBoundingClientRect().width -
        parseFloat(style.paddingLeft) -
        parseFloat(style.paddingRight) -
        parseFloat(style.borderLeftWidth) -
        parseFloat(style.borderRightWidth)
      );
    });
    expect(Math.abs(extraWidth)).toBeLessThan(2);
    await add.click();
    await expect(page.getByTestId('remote-access-pair-cancel')).toBeVisible();
    await page.getByTestId('remote-access-pair-cancel').click();
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
  }
});

test('Settings path fields keep long placeholders on one line', async () => {
  const launched = await launchCanopy();
  try {
    const page = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(page);
    await app.waitForShell();
    await app.openSettings();
    await app.openSettingsSection('experiments');
    const path = page.getByPlaceholder('/absolute/path/to/cursor-agent');
    await expect(path).toBeVisible();
    await expect(path).toHaveCSS('white-space', 'nowrap');
    await expect(path).toHaveCSS('height', '28px');
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
  }
});

test('Settings account, diagnostic and customization actions fit their labels', async () => {
  const launched = await launchCanopyWithLabsPagesOffered();
  try {
    const page = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(page);
    await app.waitForShell();
    await app.openSettings();
    async function expectNaturalWidth(button) {
      await expect(button).toBeVisible();
      await expect(button).toHaveCSS('height', '28px');
      await expect(button).toHaveClass(/\brounded-full\b/);
      const extraWidth = await button.evaluate((element) => {
        const text = document.createRange();
        text.selectNodeContents(element);
        const style = getComputedStyle(element);
        return (
          element.getBoundingClientRect().width -
          text.getBoundingClientRect().width -
          parseFloat(style.paddingLeft) -
          parseFloat(style.paddingRight) -
          parseFloat(style.borderLeftWidth) -
          parseFloat(style.borderRightWidth)
        );
      });
      expect(Math.abs(extraWidth)).toBeLessThan(2);
    }
    await app.openSettingsSection('account');
    const accountActions = page.locator(
      '[data-testid^="auth-panel-"][data-testid$="-connect"]',
    );
    await expect(accountActions.first()).toBeVisible();
    for (const button of await accountActions.all())
      await expectNaturalWidth(button);
    await app.openSettingsSection('experiments');
    const diagnostics = page.getByTestId('cursor-approval-check');
    await expectNaturalWidth(
      diagnostics.getByRole('button', {
        name: 'Save diagnostic path',
        exact: true,
      }),
    );
    await expectNaturalWidth(
      diagnostics.getByRole('button', {
        name: 'Test Cursor approvals',
        exact: true,
      }),
    );
    await expectNaturalWidth(page.getByTestId('opencode-connect'));
    await app.openSettingsSection('display');
    await expectNaturalWidth(page.getByTestId('settings-customize-sidebar'));
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
  }
});

test('Organization Statistics role uses one disclosure and saves through the shared picker', async () => {
  const key = 'csk_settings_statistics_picker';
  await registerHostedSettingsScenario(key, 'hosted-settings-signed-in');
  const launched = await launchCanopy();
  try {
    const page = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(page);
    await app.waitForShell();
    await connectMockCloudAccount(page, key);
    await app.openSettings();
    await openOrganizationsList(page);
    const owner = defaultHostedSettingsOrganizations().find(
      (org) => org.id === HOSTED_SETTINGS_ORG_IDS.owner,
    );
    await page
      .getByTestId('team-panel-org')
      .filter({ hasText: owner.name })
      .click();
    // Usage is its own rail row.
    await page.getByTestId('settings-nav-organization-settings-usage').click();
    const role = page.getByTestId('usage-min-role-select');
    await expect(role).toBeVisible();
    await expect(role).toHaveCSS('height', '28px');
    await expect(role).toHaveClass(/\brounded-full\b/);
    await expect(
      role.locator('xpath=ancestor::label[1]').locator('svg'),
    ).toHaveCount(1);
    await chooseSettingsOption(role, 'MEMBER');
    await expect
      .poll(
        async () =>
          (await readHostedSettingsState(key)).organizations.find(
            (org) => org.id === owner.id,
          )?.usageStatsMinRole,
      )
      .toBe('MEMBER');
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, key);
  }
});
