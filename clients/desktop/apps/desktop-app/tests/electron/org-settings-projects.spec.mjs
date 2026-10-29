import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  clearScenario,
  connectMockCloudAccount,
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
} from './seeders/index.mjs';
import {
  HOSTED_SETTINGS_ORG_IDS,
  hostedSettingsScenario,
} from './seeders/hostedSettingsCloud.mjs';
import { ORG_CONTEXT_ENV } from './seeders/seedOrgContextScoping.mjs';
import { defaultHostedSettingsOrganizations } from './mock-server/routes/hosted-settings-fixtures.mjs';

// The organization Projects page in desktop Settings (CAN-4532): the
// first-run checklist routes Connect GitHub to the Integrations tab in place,
// an organization with projects shows one list with its filter, Hidden pill,
// row menu and this desktop's Set up, and Set up switches to the organization,
// closes Settings and opens the setup dialog.

test.describe.configure({ retries: 0 });

/**
 * The owner's organization with its GitHub connection and projects replaced;
 * `cloud` adds the desktop's own cloud slices (its org project catalog).
 */
function scenarioWith(owned, cloud = {}) {
  return hostedSettingsScenario('hosted-settings-signed-in', {
    overrides: {
      organizations: defaultHostedSettingsOrganizations().map((org) =>
        org.id === HOSTED_SETTINGS_ORG_IDS.owner ? { ...org, ...owned } : org,
      ),
    },
    scenario: { cloud },
  });
}

async function openProjectsPage(apiKey, owned, { cloud, env } = {}) {
  await registerScenario(
    DEFAULT_MOCK_BASE_URL,
    apiKey,
    scenarioWith(owned, cloud),
  );
  const { electronApp, userDataDir } = await launchCanopy(
    env === undefined ? {} : { env },
  );
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await connectMockCloudAccount(window, apiKey);
  await app.openSettings();
  await window.getByTestId('settings-nav-organizations-list').click();
  const content = window.getByTestId('hosted-settings-content');
  await content
    .getByTestId('team-panel-org')
    .filter({ hasText: 'Northwind Labs' })
    .first()
    .click();
  await window.getByTestId('settings-nav-organization-projects').click();
  await expect(content).toHaveAttribute(
    'data-hosted-settings-page',
    'organization/projects',
  );
  return { electronApp, userDataDir, window, content };
}

test('Connect GitHub on the checklist opens Integrations in Settings', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_can4532_disconnected';
  const [seeded] = defaultHostedSettingsOrganizations().find(
    (org) => org.id === HOSTED_SETTINGS_ORG_IDS.owner,
  ).projects;
  // The owner's own project, which the checklist doesn't count.
  const mine = {
    ...seeded,
    id: 'b0000000-0000-4000-8000-000000000097',
    name: 'My Notes',
    visibility: 'private',
    memberOwned: true,
  };
  const { electronApp, userDataDir, window, content } = await openProjectsPage(
    apiKey,
    { projects: [mine] },
  );
  try {
    await expect(content.getByTestId('team-projects-setup')).toBeVisible();
    await expect(
      content.getByTestId('team-projects-private-heading'),
    ).toContainText('Only visible to you');
    await expect(
      content.getByTestId(`team-projects-row-${mine.id}`),
    ).toBeVisible();
    await expect(
      content.getByTestId(`team-projects-private-${mine.id}`),
    ).toHaveCount(0);
    await expect(
      content.getByTestId('team-projects-setup-local'),
    ).toContainText('Set up on this computer');
    await expect(window.getByTestId('team-projects-create')).toHaveCount(0);
    await content.getByTestId('team-projects-connect-github').click();
    // The link stays in Settings instead of navigating the app to Home.
    await expect(window.getByTestId('settings-overlay')).toBeVisible();
    await expect(content).toHaveAttribute(
      'data-hosted-settings-page',
      'organization/settings',
      { timeout: 20_000 },
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

test('lists projects with a filter, a row menu and Set up', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_can4532_connected';
  const [build] = defaultHostedSettingsOrganizations().find(
    (org) => org.id === HOSTED_SETTINGS_ORG_IDS.owner,
  ).projects;
  const hidden = {
    ...build,
    id: 'b0000000-0000-4000-8000-000000000098',
    name: 'Docs Site',
    preference: 'DISMISSED',
    listed: false,
    repository: {
      ...build.repository,
      name: 'docs-site',
      providerRepoId: '900098',
    },
  };
  const archived = {
    ...build,
    id: 'b0000000-0000-4000-8000-000000000099',
    name: 'Old Service',
    state: 'ARCHIVED',
    repository: {
      ...build.repository,
      name: 'old-service',
      providerRepoId: '900099',
    },
  };
  const { electronApp, userDataDir, window, content } = await openProjectsPage(
    apiKey,
    {
      githubConnection: { connected: true, accountLogin: 'example-org' },
      projects: [build, hidden, archived],
    },
  );
  try {
    await expect(content.getByTestId('team-projects-setup')).toHaveCount(0);
    await expect(window.getByTestId('team-projects-create')).toBeVisible();
    await expect(
      window.getByTestId('team-projects-repositories-open'),
    ).toBeVisible();
    await expect(content.getByTestId('team-projects-count')).toHaveText('3');
    // A project hidden from the viewer's list stays, marked, under All.
    await expect(
      content.getByTestId(`team-projects-hidden-${hidden.id}`),
    ).toHaveText('Hidden');
    await expect(
      content.getByTestId('team-projects-filter-hidden'),
    ).toContainText('1');
    await expect(
      content.getByTestId(`team-projects-access-${build.id}`),
    ).toHaveText('Everyone in Northwind Labs');

    await content.getByTestId('team-projects-filter-archived').click();
    await expect(
      content.locator('[data-testid^="team-projects-row-"]'),
    ).toHaveCount(1);
    await content.getByTestId('team-projects-filter-all').click();

    // This desktop's action, never the web handoff.
    await expect(
      content.getByTestId(`team-projects-set-up-${build.id}`),
    ).toHaveText('Set up');
    await expect(content.getByText(/^Open in /)).toHaveCount(0);

    await content.getByTestId(`team-projects-actions-${build.id}`).click();
    for (const item of ['Edit', 'Access', 'Archive', 'Delete'])
      await expect(window.getByRole('menuitem', { name: item })).toBeVisible();
    await window.keyboard.press('Escape');
    await content.getByTestId(`team-projects-actions-${hidden.id}`).click();
    await expect(
      window.getByRole('menuitem', { name: 'Show in my list' }),
    ).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

test('Set up switches to the organization, closes Settings and opens setup', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_can4532_set_up';
  const [seeded] = defaultHostedSettingsOrganizations().find(
    (org) => org.id === HOSTED_SETTINGS_ORG_IDS.owner,
  ).projects;
  // The desktop's catalog parses full summaries, which the hosted fixture's
  // definition only partly carries.
  const build = {
    ...seeded,
    purpose: 'project',
    visibility: 'organization',
    memberOwned: false,
  };
  const summary = { ...build };
  for (const field of ['grants', 'createdBy', 'createdAt', 'updatedAt'])
    delete summary[field];
  const { electronApp, userDataDir, window, content } = await openProjectsPage(
    apiKey,
    {
      githubConnection: { connected: true, accountLogin: 'example-org' },
      projects: [build],
    },
    {
      // The desktop's own catalog for the organization, which setup reads.
      cloud: {
        orgProjects: { [`org:${HOSTED_SETTINGS_ORG_IDS.owner}`]: [summary] },
      },
      env: ORG_CONTEXT_ENV,
    },
  );
  try {
    await content.getByTestId(`team-projects-set-up-${build.id}`).click();
    await expect(window.getByTestId('org-project-setup-dialog')).toBeVisible({
      timeout: 20_000,
    });
    await expect(window.getByTestId('settings-overlay')).toBeHidden();
    expect(
      await window.evaluate(
        async () => (await window.api.workspaceContext.get()).context,
      ),
    ).toEqual({
      kind: 'organization',
      organizationId: HOSTED_SETTINGS_ORG_IDS.owner,
    });
    // Cancelling leaves the user in the organization, nothing cloned.
    await window.getByTestId('org-project-setup-cancel').click();
    await expect(window.getByTestId('org-project-setup-dialog')).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});
