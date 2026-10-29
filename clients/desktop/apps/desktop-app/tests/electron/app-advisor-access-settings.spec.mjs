import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  clearScenario,
  connectMockCloudAccount,
  DEFAULT_MOCK_BASE_URL,
  ORG_CONTEXT_A,
  ORG_CONTEXT_B,
  ORG_CONTEXT_ENV,
  ORG_CONTEXT_ORGANIZATIONS,
  registerScenario,
} from './seeders/index.mjs';

const ACCESS_PREFIX = 'app-advisor-project-agent-access';
const ACCESS_LABEL =
  'Allow project agents to use App Advisor chats and create automations';
const ACCESS_DESCRIPTION =
  'Controls whether code and cowork agents can use App Advisor tools and create automations that prompt App Advisor.';
const STALE_ORGANIZATION_ID = '33333333-3333-4333-8333-333333333333';

async function openAppAdvisorSettings(app, window) {
  await app.openSettings();
  const navEntry = window.getByTestId('settings-nav-app-advisor');
  await expect(navEntry).toBeVisible();
  await app.openSettingsSection('app-advisor');
  await expect(window.getByTestId('settings-tab-app-advisor')).toBeVisible();
}

async function expectStoredAccess(window, expected) {
  await expect
    .poll(() =>
      window.evaluate(async () => {
        const preferences = await window.api.loadPreferences();
        return preferences.appAdvisorProjectAgentAccess;
      }),
    )
    .toEqual(expected);
}

test('App Advisor project agent access defaults to Enabled', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir } = await launchCanopy();
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await openAppAdvisorSettings(app, window);

    const section = window.getByTestId(
      'settings-app-advisor-project-agent-access',
    );
    const control = section.getByTestId(ACCESS_PREFIX);
    await expect(section).toBeVisible();
    await expect(control).toBeVisible();
    await expect(
      control.getByText(ACCESS_LABEL, { exact: true }),
    ).toBeVisible();
    await expect(
      control.getByText(ACCESS_DESCRIPTION, { exact: true }),
    ).toBeVisible();
    await expect(
      window.getByTestId(`${ACCESS_PREFIX}-mode-enabled`),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(
      window.getByTestId(`${ACCESS_PREFIX}-mode-selected-owners`),
    ).toHaveAttribute('aria-pressed', 'false');
    await expect(
      window.getByTestId(`${ACCESS_PREFIX}-mode-disabled`),
    ).toHaveAttribute('aria-pressed', 'false');
    await expect(window.getByTestId(`${ACCESS_PREFIX}-owner-list`)).toHaveCount(
      0,
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('App Advisor project agent access can select Personal and persists across reload', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir } = await launchCanopy();
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await openAppAdvisorSettings(app, window);

    const selectedOwnersMode = window.getByTestId(
      `${ACCESS_PREFIX}-mode-selected-owners`,
    );
    await selectedOwnersMode.click();
    await expect(selectedOwnersMode).toHaveAttribute('aria-pressed', 'true');

    const ownerList = window.getByTestId(`${ACCESS_PREFIX}-owner-list`);
    await expect(ownerList).toBeVisible();
    const personal = ownerList.getByTestId(`${ACCESS_PREFIX}-owner-personal`);
    await expect(personal).toBeVisible();
    await expect(personal).toHaveText('Personal');
    const noOwnersHint = window.getByTestId(`${ACCESS_PREFIX}-no-owners`);
    await expect(noOwnersHint).toBeVisible();

    await personal.click();
    await expect(personal).toHaveAttribute('aria-pressed', 'true');
    await expect(noOwnersHint).toBeHidden();
    await expectStoredAccess(window, {
      mode: 'selected-owners',
      selectedOwners: [{ kind: 'personal' }],
    });

    await window.reload();
    await app.waitForShell({ timeout: 30_000 });
    await openAppAdvisorSettings(app, window);
    await expect(
      window.getByTestId(`${ACCESS_PREFIX}-mode-selected-owners`),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(
      window
        .getByTestId(`${ACCESS_PREFIX}-owner-list`)
        .getByTestId(`${ACCESS_PREFIX}-owner-personal`),
    ).toHaveAttribute('aria-pressed', 'true');
    await expectStoredAccess(window, {
      mode: 'selected-owners',
      selectedOwners: [{ kind: 'personal' }],
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('App Advisor project agent access persists Disabled across reload', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir } = await launchCanopy();
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await openAppAdvisorSettings(app, window);

    const disabled = window.getByTestId(`${ACCESS_PREFIX}-mode-disabled`);
    await disabled.click();
    await expect(disabled).toHaveAttribute('aria-pressed', 'true');
    await expect(window.getByTestId(`${ACCESS_PREFIX}-owner-list`)).toHaveCount(
      0,
    );
    await expectStoredAccess(window, {
      mode: 'disabled',
      selectedOwners: [],
    });

    await window.reload();
    await app.waitForShell({ timeout: 30_000 });
    await openAppAdvisorSettings(app, window);
    await expect(
      window.getByTestId(`${ACCESS_PREFIX}-mode-disabled`),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(window.getByTestId(`${ACCESS_PREFIX}-owner-list`)).toHaveCount(
      0,
    );
    await expectStoredAccess(window, {
      mode: 'disabled',
      selectedOwners: [],
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('App Advisor project agent access sorts organizations and removes unavailable selections', async () => {
  test.setTimeout(120_000);
  const apiKey = `csk_app_advisor_access_${randomUUID()}`;
  let scenarioRegistered = false;
  let launched;
  try {
    await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
      cloud: { organizations: [...ORG_CONTEXT_ORGANIZATIONS].reverse() },
    });
    scenarioRegistered = true;
    launched = await launchCanopy({ env: ORG_CONTEXT_ENV });

    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, apiKey);
    await expect
      .poll(() =>
        window.evaluate(async () => {
          const context = await window.api.workspaceContext.get();
          return context.organizations.map(({ id }) => id).sort();
        }),
      )
      .toEqual([ORG_CONTEXT_A, ORG_CONTEXT_B].sort());

    await window.evaluate(async (staleOrganizationId) => {
      await window.api.savePreferences({
        appAdvisorProjectAgentAccess: {
          mode: 'selected-owners',
          selectedOwners: [
            { kind: 'organization', organizationId: staleOrganizationId },
          ],
        },
      });
    }, STALE_ORGANIZATION_ID);
    await expectStoredAccess(window, {
      mode: 'selected-owners',
      selectedOwners: [
        { kind: 'organization', organizationId: STALE_ORGANIZATION_ID },
      ],
    });

    await openAppAdvisorSettings(app, window);
    await expect(
      window.getByTestId(`${ACCESS_PREFIX}-mode-selected-owners`),
    ).toHaveAttribute('aria-pressed', 'true');
    const ownerList = window.getByTestId(`${ACCESS_PREFIX}-owner-list`);
    await expect(ownerList).toBeVisible();

    const ownerRows = ownerList.locator(
      '[data-testid^="app-advisor-project-agent-access-owner-"]',
    );
    await expect(ownerRows).toHaveCount(4);
    const ownerTestIds = await ownerRows.evaluateAll((rows) =>
      rows.map((row) => row.getAttribute('data-testid')),
    );
    expect(
      ownerTestIds.filter((testId) =>
        [
          `${ACCESS_PREFIX}-owner-personal`,
          `${ACCESS_PREFIX}-owner-organization-${ORG_CONTEXT_A}`,
          `${ACCESS_PREFIX}-owner-organization-${ORG_CONTEXT_B}`,
        ].includes(testId),
      ),
    ).toEqual([
      `${ACCESS_PREFIX}-owner-personal`,
      `${ACCESS_PREFIX}-owner-organization-${ORG_CONTEXT_A}`,
      `${ACCESS_PREFIX}-owner-organization-${ORG_CONTEXT_B}`,
    ]);
    await expect(
      ownerList.getByTestId(`${ACCESS_PREFIX}-owner-personal`),
    ).toHaveText('Personal');
    await expect(
      ownerList.getByTestId(
        `${ACCESS_PREFIX}-owner-organization-${ORG_CONTEXT_A}`,
      ),
    ).toHaveText('Acme');
    await expect(
      ownerList.getByTestId(
        `${ACCESS_PREFIX}-owner-organization-${ORG_CONTEXT_B}`,
      ),
    ).toHaveText('Empty organization');

    const staleOwner = ownerList.getByTestId(
      `${ACCESS_PREFIX}-owner-organization-${STALE_ORGANIZATION_ID}`,
    );
    await expect(staleOwner).toHaveAttribute('aria-pressed', 'true');
    await expect(staleOwner).toHaveAttribute('data-unavailable', 'true');
    await expect(staleOwner).toContainText('Unavailable organization');
    await staleOwner.click();
    await expect
      .poll(() =>
        window.evaluate(async () => {
          const preferences = await window.api.loadPreferences();
          return preferences.appAdvisorProjectAgentAccess;
        }),
      )
      .toEqual({ mode: 'selected-owners', selectedOwners: [] });
  } finally {
    try {
      if (launched) {
        await closeCanopy(launched.electronApp, launched.userDataDir);
      }
    } finally {
      if (scenarioRegistered) {
        await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
      }
    }
  }
});
