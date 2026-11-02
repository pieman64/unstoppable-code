import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  clearScenario,
  connectMockCloudAccount,
  seedOrgContextScoping,
  ORG_CONTEXT_ENV,
  PERSONAL_CONTEXT_WORKSPACE,
  ORG_CONTEXT_WORKSPACE,
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
} from './seeders/index.mjs';
import {
  expectWorkspaceContext,
  expectContextChevronAfterText,
  expectHeaderSearchBesideBell,
  expectContextSelectionCheckmarkOnly,
  selectWorkspaceContext,
} from './workspaceContextMenu.mjs';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const PERSONAL_ORG_ID = '44444444-4444-4444-8444-444444444444';
// CAN-3522: the organization's branding logo, which the switcher shows in
// place of the building glyph, as the web portal does.
const ORG_LOGO_URL = `${DEFAULT_MOCK_BASE_URL}/org-logo/acme.svg`;
const ORGANIZATIONS = [
  {
    id: ORG_ID,
    name: 'Acme',
    logoUrl: ORG_LOGO_URL,
    role: 'MEMBER',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

for (const scenario of [
  { name: 'flag off', enabled: false, organizations: ORGANIZATIONS },
  { name: 'no organizations', enabled: true, organizations: [] },
  {
    name: 'organization switching',
    enabled: true,
    organizations: ORGANIZATIONS,
  },
]) {
  test(`context picker: ${scenario.name}`, async () => {
    test.setTimeout(120_000);
    const apiKey = `csk_can2953_${scenario.name.replaceAll(' ', '_')}`;
    await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
      cloud: {
        organizations: scenario.organizations,
        // A provisioned Personal, so its own actions can show.
        ...(scenario.organizations.length === 0
          ? { personalOrganizationId: PERSONAL_ORG_ID }
          : {}),
      },
    });
    const env = {
      CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
        'canopy-shared-org-projects-enabled': scenario.enabled,
      }),
    };
    const launched = await launchCanopy({ env });
    let electronApp = launched.electronApp;
    const { userDataDir } = launched;
    try {
      let window = await electronApp.firstWindow();
      await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
      const connected = await window.evaluate(
        async (key) => window.api.saveCanopyCloudApiKey({ apiKey: key }),
        apiKey,
      );
      expect(connected.status.authenticated).toBe(true);
      await window.evaluate(() => {
        window.dispatchEvent(new Event('canopy:cloud-account-changed'));
      });
      // Wait for main's membership refresh before asserting an absent row.
      await expect
        .poll(async () =>
          window.evaluate(
            async () =>
              (await window.api.workspaceContext.get()).organizations.length,
          ),
        )
        .toBe(scenario.enabled ? scenario.organizations.length : 0);
      // CAN-4053: the switcher heads the sidebar, above New task, as on the
      // web portal; the footer holds only the personal account row.
      const contextRow = window.getByTestId('sidebar-context-row');
      const accountRow = window.getByTestId('sidebar-account-row');
      if (!scenario.enabled) {
        await expect(
          window.getByTestId('sidebar-activity-toggle'),
        ).toBeVisible();
        await expect(contextRow).toHaveCount(0);
        await expect(window.getByTestId('sidebar-top-context-row')).toHaveCount(
          0,
        );
        await accountRow.click();
        await expect(
          window.getByTestId('sidebar-account-menu-item-usage'),
        ).toBeVisible();
        await expect(
          window.getByTestId('sidebar-context-option-personal'),
        ).toHaveCount(0);
        await window.keyboard.press('Escape');
        return;
      }

      await expect(contextRow).toBeVisible();
      await expect(contextRow).toHaveText('Personal');
      await expectContextChevronAfterText(window);
      await expect(contextRow).toHaveAttribute(
        'aria-label',
        'Workspace context: Personal',
      );
      await expect(
        window
          .getByTestId('sidebar-top-context-row')
          .getByTestId('sidebar-context-row'),
      ).toBeVisible();
      await expect(
        window
          .getByTestId('sidebar-account-footer')
          .getByTestId('sidebar-context-row'),
      ).toHaveCount(0);
      const bell = window.getByTestId('sidebar-activity-toggle');
      await expect(bell).toHaveCount(1);
      await expectHeaderSearchBesideBell(window);
      // The icon-only Search names its shortcut in its tooltip, as one
      // borderless cap per key read from the shortcut registry.
      await window.getByTestId('sidebar-search').hover();
      const searchTip = window.getByRole('tooltip');
      await expect(searchTip).toContainText('Search');
      await expect(searchTip.locator('kbd')).toHaveText(
        process.platform === 'darwin' ? ['⌘', 'K'] : ['Ctrl', 'K'],
      );
      await expect(searchTip.locator('kbd').first()).toHaveCSS(
        'border-top-width',
        '0px',
      );
      await window.getByTestId('sidebar-search').click();
      await expect(window.getByTestId('command-palette')).toBeVisible();
      await window.keyboard.press('Escape');
      await expect(window.getByTestId('command-palette')).toBeHidden();
      await expect(contextRow).toHaveCSS('font-size', '16px');
      await expect(contextRow).toHaveCSS('font-weight', '500');
      const bellBox = await bell.boundingBox();
      const rowBox = await contextRow.boundingBox();
      expect(bellBox).not.toBeNull();
      expect(
        Math.abs(bellBox.y + bellBox.height / 2 - rowBox.y - rowBox.height / 2),
      ).toBeLessThan(1);
      expect(bellBox.x).toBeGreaterThanOrEqual(rowBox.x + rowBox.width);
      const resourceGlyph = await window
        .getByTestId('sidebar-resource-diagnostics-pill')
        .locator('svg')
        .first()
        .boundingBox();
      const searchGlyph = await window
        .getByTestId('sidebar-search')
        .locator('svg')
        .boundingBox();
      expect(resourceGlyph).not.toBeNull();
      expect(searchGlyph).not.toBeNull();
      expect(
        Math.abs(
          resourceGlyph.x +
            resourceGlyph.width / 2 -
            searchGlyph.x -
            searchGlyph.width / 2,
        ),
      ).toBeLessThan(0.5);
      await bell.click();
      await expect(bell).toHaveAttribute('aria-pressed', 'true');
      await bell.click();
      await expect(bell).toHaveAttribute('aria-pressed', 'false');
      const newTaskBox = await window
        .getByTestId('sidebar-create-task')
        .boundingBox();
      expect(rowBox).not.toBeNull();
      expect(newTaskBox).not.toBeNull();
      // Above New task, clear of the titlebar's drag region: a click lands.
      expect(rowBox.y + rowBox.height).toBeLessThanOrEqual(newTaskBox.y + 1);

      // The account menu stays personal: the person, never a context group.
      await accountRow.click();
      await expect(
        window.getByTestId('sidebar-account-menu-item-usage'),
      ).toBeVisible();
      await expect(
        window.getByTestId('sidebar-account-menu-header-identity'),
      ).toBeVisible();
      await expect(
        window.getByTestId('sidebar-context-option-personal'),
      ).toHaveCount(0);
      await window.keyboard.press('Escape');

      await contextRow.click();
      const menu = window.getByTestId('sidebar-context-menu');
      await expectContextSelectionCheckmarkOnly(window);
      await expect(menu).toBeVisible();
      await expect(
        window.getByTestId('sidebar-context-option-personal'),
      ).toHaveAttribute('aria-checked', 'true');
      // Organization settings is the selected organization's: none in Personal.
      await expect(
        window.getByTestId('sidebar-context-organization-settings'),
      ).toHaveCount(0);
      if (scenario.organizations.length === 0) {
        // Every signed-in account gets the switcher: Personal alone, with
        // Personal's actions.
        await expect(menu.getByRole('menuitemradio')).toHaveCount(1);
        await expect(
          window.getByTestId('account-personal-activity-row'),
        ).toBeVisible();
        await expect(
          window.getByTestId('account-context-statistics-row'),
        ).toBeVisible();
        await expect(
          window.getByTestId('account-create-team-row'),
        ).toBeVisible();
        await window.keyboard.press('Escape');
        await expect(menu).toHaveCount(0);
        return;
      }
      const optionLogo = window
        .getByTestId(`sidebar-context-option-${ORG_ID}`)
        .getByTestId('sidebar-context-glyph-logo');
      await expect(optionLogo).toHaveAttribute('src', ORG_LOGO_URL);
      await expect
        .poll(() => optionLogo.evaluate((image) => image.naturalWidth))
        .toBeGreaterThan(0);
      await window.getByTestId(`sidebar-context-option-${ORG_ID}`).click();
      await expect(menu).toHaveCount(0);
      await expect(contextRow).toHaveText('Acme');
      await expectContextChevronAfterText(window);
      await expect(
        contextRow.getByTestId('sidebar-context-glyph-logo'),
      ).toHaveAttribute('src', ORG_LOGO_URL);
      await expect(
        contextRow.getByTestId('sidebar-context-glyph-building'),
      ).toHaveCount(0);
      // The footer keeps naming the person in an organization.
      await expect(
        window.getByTestId('sidebar-account-identity'),
      ).not.toHaveText('Acme');
      await contextRow.click();
      await expect(
        window.getByTestId('sidebar-context-organization-settings'),
      ).toBeVisible();
      await window.keyboard.press('Escape');
      await expectWorkspaceContext(window, ORG_ID);
      await selectWorkspaceContext(window, 'personal');
      await expectWorkspaceContext(window, 'personal');
      await expect(contextRow).toHaveText('Personal');

      await window.keyboard.press('ControlOrMeta+k');
      await window
        .getByTestId('command-palette-input')
        .fill('> Switch to Acme');
      await window
        .getByRole('option')
        .filter({ hasText: 'Switch to Acme' })
        .click();
      await expectWorkspaceContext(window, ORG_ID);
      await closeCanopy(electronApp, userDataDir, { keepUserData: true });
      ({ electronApp } = await launchCanopy({
        userDataDir,
        env,
        preserveProviderState: true,
      }));
      window = await electronApp.firstWindow();
      await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
      await expectWorkspaceContext(window, ORG_ID);
      await expect(window.getByTestId('sidebar-context-row')).toHaveText(
        'Acme',
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
    }
  });
}

test('early access keeps the switcher at the top and the account menu personal', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_can4053_early_access_account';
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: {
      organizations: ORGANIZATIONS,
      // Signed in, Early access is the account's stored choice.
      experiments: { choices: { 'early-access': true } },
    },
  });
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-acct-ctx-'));
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: {
      CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
        'canopy-shared-org-projects-enabled': true,
      }),
    },
  });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, apiKey);
    await expect
      .poll(async () =>
        window.evaluate(
          async () =>
            (await window.api.workspaceContext.get()).organizations.length,
        ),
      )
      .toBe(ORGANIZATIONS.length);
    // One switcher, at the top: no second selector in the footer.
    await expect(window.getByTestId('sidebar-context-row')).toHaveCount(1);
    await expect(
      window
        .getByTestId('sidebar-top-context-row')
        .getByTestId('sidebar-context-row'),
    ).toBeVisible();

    const identity = window.getByTestId('sidebar-account-identity');
    await expect(identity).not.toHaveText('Acme');
    await window.getByTestId('sidebar-account-row').click();
    await expect(
      window.getByTestId('sidebar-account-menu-header-identity'),
    ).toBeVisible();
    await expect(
      window.getByTestId('sidebar-context-option-personal'),
    ).toHaveCount(0);
    await window.keyboard.press('Escape');

    await selectWorkspaceContext(window, ORG_ID);
    // The account row keeps naming the person after the switch.
    await expect(identity).not.toHaveText('Acme');
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

test('runtime rollback projects Personal and restores the persisted organization on re-enable', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_can2960_runtime_rollback';
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: { organizations: ORGANIZATIONS },
  });
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-can2960-'));
  seedOrgContextScoping(userDataDir);
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: ORG_CONTEXT_ENV,
  });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, apiKey);
    const account = window.getByTestId('sidebar-account-row');
    const chats = window.getByTestId('sidebar-section-chats');
    const personal = window.locator(
      `[data-sidebar-workspace-id="${PERSONAL_CONTEXT_WORKSPACE}"]`,
    );
    const organization = window.locator(
      `[data-sidebar-workspace-id="${ORG_CONTEXT_WORKSPACE}"]`,
    );
    await expectWorkspaceContext(window, 'personal');
    await selectWorkspaceContext(window, ORG_ID);
    await expect(organization).toBeVisible();
    await expect(personal).toHaveCount(0);
    await expect(chats).toBeVisible();
    const contextFile = path.join(userDataDir, 'workspace-context.json');
    const persisted = readFileSync(contextFile, 'utf8');
    expect(persisted).toContain(`org:${ORG_ID}`);

    await electronApp.evaluate(() => {
      const flags = JSON.parse(
        process.env.CANOPY_E2E_CLIENT_FEATURE_FLAGS ?? '{}',
      );
      flags['canopy-shared-org-projects-enabled'] = false;
      process.env.CANOPY_E2E_CLIENT_FEATURE_FLAGS = JSON.stringify(flags);
    });
    await window.evaluate(() => window.api.featureFlags.refreshContext());
    // The disabled design hides the picker and restores the unscoped sidebar.
    await expect(account).toBeVisible();
    await expect(window.getByTestId('sidebar-context-row')).toHaveCount(0);
    await expect(personal).toBeVisible();
    await expect(organization).toBeVisible();
    await expect(chats).toBeVisible();
    await expect(window.getByTestId('sidebar-top-context-row')).toHaveCount(0);
    await account.click();
    await expect(
      window.getByTestId('sidebar-context-option-personal'),
    ).toHaveCount(0);
    await window.keyboard.press('Escape');
    expect(
      await window.evaluate(() => window.api.workspaceContext.get()),
    ).toMatchObject({ context: { kind: 'personal' }, organizations: [] });
    const rejection = await window.evaluate(async (organizationId) => {
      try {
        await window.api.workspaceContext.set({
          context: { kind: 'organization', organizationId },
        });
        return null;
      } catch (error) {
        return error.message;
      }
    }, ORG_ID);
    expect(rejection).toContain(
      'Organization projects are not available for this account yet.',
    );
    expect(readFileSync(contextFile, 'utf8')).toBe(persisted);

    await electronApp.evaluate(() => {
      const flags = JSON.parse(
        process.env.CANOPY_E2E_CLIENT_FEATURE_FLAGS ?? '{}',
      );
      flags['canopy-shared-org-projects-enabled'] = true;
      process.env.CANOPY_E2E_CLIENT_FEATURE_FLAGS = JSON.stringify(flags);
    });
    await window.evaluate(() => window.api.featureFlags.refreshContext());
    await expect(organization).toBeVisible();
    await expect(personal).toHaveCount(0);
    await expect(chats).toBeVisible();
    await expectWorkspaceContext(window, ORG_ID);
    expect(readFileSync(contextFile, 'utf8')).toBe(persisted);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});
