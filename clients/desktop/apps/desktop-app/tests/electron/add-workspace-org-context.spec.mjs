import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
  chmodSync,
  rmSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { writeUnauthenticatedGhFixture } from './ghAuthFixture.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { chooseCloneDestination } from './helpers/add-project.mjs';
import {
  clearScenario,
  connectMockCloudAccount,
  DEFAULT_MOCK_BASE_URL,
  getScenarioActivity,
  registerScenario,
  seedOrgContextScoping,
  ORG_CONTEXT_A,
  ORG_CONTEXT_B,
  ORG_CONTEXT_ENV,
  ORG_CONTEXT_ORGANIZATIONS,
  PERSONAL_CONTEXT_WORKSPACE,
} from './seeders/index.mjs';
import {
  expectWorkspaceContext,
  selectWorkspaceContext,
} from './workspaceContextMenu.mjs';
import { hostedSettingsScenario } from './seeders/hostedSettingsCloud.mjs';
import { defaultHostedSettingsOrganizations } from './mock-server/routes/hosted-settings-fixtures.mjs';

test.describe.configure({ retries: 0 });

// CAN-3984: the real catalog loader, dialog, clone and organization writer.
test('CAN-3984: empty member catalog opens Existing and Remote clones only into the organization', async () => {
  test.skip(process.platform === 'win32', 'Local POSIX clone fixture');
  test.setTimeout(120_000);
  const apiKey = 'csk_can3984_member_remote';
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: { organizations: ORG_CONTEXT_ORGANIZATIONS },
  });
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can3984-member-'));
  const root = mkdtempSync(path.join(os.tmpdir(), 'can3984-clone-'));
  seedOrgContextScoping(userDataDir);
  const source = path.join(root, 'local-source');
  execFileSync('git', ['init', '--initial-branch=main', source]);
  execFileSync('git', [
    '-C',
    source,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '--allow-empty',
    '-m',
    'Initial',
  ]);
  const destination = path.join(root, 'clones');
  mkdirSync(destination);
  // Use a real local clone while preserving a supported origin for inspection.
  const shim = path.join(root, 'git-local-clone.sh');
  writeFileSync(
    shim,
    [
      '#!/bin/sh',
      'case " $* " in',
      '  *" clone "*)',
      '    for destination; do :; done',
      "    /usr/bin/git clone '" + source + '\' "$destination" || exit $?',
      '    /usr/bin/git -C "$destination" remote set-url origin https://github.com/acme/local-source.git',
      '    exit $?',
      '    ;;',
      'esac',
      'exec /usr/bin/git "$@"',
      '',
    ].join('\n'),
  );
  chmodSync(shim, 0o755);
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: {
      ...ORG_CONTEXT_ENV,
      CANOPY_E2E_CLOUD_BASE_URL: DEFAULT_MOCK_BASE_URL,
      CANOPY_GIT_EXECUTABLE: shim,
      // Remote offers its GitHub / URL source toggle only when the host can
      // list GitHub repositories. Sign gh out so a developer machine with a
      // signed-in gh shows the same URL-only form as the CI pool.
      GH_EXECUTABLE: writeUnauthenticatedGhFixture(path.join(root, 'gh')),
    },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, apiKey);
    await app.openMainPage();
    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    await window.getByTestId('sidebar-section-code-add').focus();
    await window.getByTestId('sidebar-section-code-add').press('Enter');
    await expect(window.getByTestId('add-workspace-mode-catalog')).toHaveCount(
      0,
    );
    await expect(
      window.getByTestId('add-workspace-mode-existing'),
    ).toHaveAttribute('aria-pressed', 'true');
    await window.getByTestId('add-workspace-mode-remote').click();
    await window
      .getByTestId('add-workspace-remote-url-input')
      .fill('https://github.com/acme/local-source.git');
    await chooseCloneDestination(electronApp, window, destination);
    await window.getByTestId('add-workspace-clone-submit').click();
    await expect(window.getByTestId('add-workspace-modal')).toHaveCount(0, {
      timeout: 30_000,
    });
    const created = workspaceConfigByName(userDataDir, 'local-source');
    expect(created).toMatchObject({
      type: 'single-repo',
      owner: { type: 'organization', organizationId: ORG_CONTEXT_A },
    });
    expect(existsSync(path.join(created.repoPath, '.git'))).toBe(true);
    const index = JSON.parse(
      readFileSync(path.join(userDataDir, 'workspaces', 'index.json'), 'utf8'),
    );
    expect(
      index.workspaces.filter((item) => item.name === 'local-source'),
    ).toHaveLength(1);
    await expect(
      window.locator('[data-sidebar-workspace-id="' + created.id + '"]'),
    ).toBeVisible();
    await selectWorkspaceContext(window, 'personal');
    await expect(
      window.locator('[data-sidebar-workspace-id="' + created.id + '"]'),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
    rmSync(root, { recursive: true, force: true });
  }
});

// Organization setup opens inside Settings when hosted settings are available
// (CAN-4445), and signed in on the web otherwise. These cover the web
// hand-off, so they run with that rollout flag off.
const HOSTED_SETTINGS_OFF_ORG_CONTEXT_ENV = {
  ...ORG_CONTEXT_ENV,
  CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
    ...JSON.parse(ORG_CONTEXT_ENV.CANOPY_E2E_CLIENT_FEATURE_FLAGS),
    'canopy-desktop-hosted-settings': false,
  }),
};

for (const status of ['not-connected', 'refreshed', 'failed']) {
  test(
    'CAN-3984: ADMIN empty catalog setup with ' + status + ' connection check',
    async () => {
      test.setTimeout(120_000);
      const apiKey = 'csk_can3984_admin_' + status;
      await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
        cloud: {
          organizations: ORG_CONTEXT_ORGANIZATIONS.map((org) => ({
            ...org,
            role: 'ADMIN',
          })),
          orgProjectRepositoryRefresh: { status },
        },
      });
      const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can3984-admin-'));
      seedOrgContextScoping(userDataDir);
      const { electronApp } = await launchCanopy({
        userDataDir,
        env: {
          ...HOSTED_SETTINGS_OFF_ORG_CONTEXT_ENV,
          CANOPY_E2E_CLOUD_BASE_URL: DEFAULT_MOCK_BASE_URL,
          CANOPY_E2E_EXTERNAL_OPEN_CAPTURE_URL:
            DEFAULT_MOCK_BASE_URL + '/__mock/github/external-open',
        },
      });
      try {
        const window = await electronApp.firstWindow();
        const app = new CanopyAppDriver(window);
        await app.waitForShell({ timeout: 30_000 });
        await connectMockCloudAccount(window, apiKey);
        await app.openMainPage();
        await selectWorkspaceContext(window, ORG_CONTEXT_A);
        await window.getByTestId('sidebar-section-code-add').focus();
        await window.getByTestId('sidebar-section-code-add').press('Enter');
        await expect(
          window.getByTestId('add-workspace-mode-catalog'),
        ).toHaveAttribute('aria-pressed', 'true');
        const action =
          status === 'not-connected' ? 'connect-github' : 'choose-projects';
        await expect(
          window.getByTestId('add-workspace-org-catalog-' + action),
        ).toBeVisible();
        await expect(
          window.getByTestId('add-workspace-mode-remote'),
        ).toHaveCount(0);
        await window.getByTestId('add-workspace-org-catalog-' + action).click();
        await expect(window.getByTestId('add-workspace-modal')).toHaveCount(0);
        const target =
          '/organization/' +
          ORG_CONTEXT_A +
          (status === 'not-connected'
            ? '/settings?tab=integrations'
            : '/projects');
        const { activity } = await getScenarioActivity(
          DEFAULT_MOCK_BASE_URL,
          apiKey,
        );
        expect(activity['authLinkMint:' + target]).toBe(1);
        const external = await fetch(
          DEFAULT_MOCK_BASE_URL + '/__mock/github/external-open',
        ).then((response) => response.json());
        expect(new URL(external.urls.at(-1)).pathname).toBe(
          '/api/v1/canopy/auth-link/consume',
        );
      } finally {
        await closeCanopy(electronApp, userDataDir);
        await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
      }
    },
  );
}

// CAN-4445: with hosted settings available (the E2E default), Connect GitHub
// and Choose projects open the organization's Integrations or Projects page
// inside Settings and never mint a signed-in web link.
for (const status of ['not-connected', 'refreshed', 'failed']) {
  test(
    'CAN-4445: ADMIN empty catalog setup with ' +
      status +
      ' connection check opens in Settings',
    async () => {
      test.setTimeout(120_000);
      const apiKey = 'csk_can4445_admin_' + status;
      // Hosted Settings knows the same organization, with the viewer as
      // ADMIN, so its Integrations and Projects pages render.
      const hostedTemplate = defaultHostedSettingsOrganizations().find(
        (org) => !org.isPersonal && org.viewerRole === 'OWNER',
      );
      await registerScenario(
        DEFAULT_MOCK_BASE_URL,
        apiKey,
        hostedSettingsScenario('hosted-settings-signed-in', {
          syncCloudAccount: false,
          overrides: {
            organizations: [
              {
                ...hostedTemplate,
                id: ORG_CONTEXT_A,
                name: 'Acme',
                viewerRole: 'ADMIN',
                projects: [],
                facts: [],
              },
            ],
          },
          scenario: {
            cloud: {
              organizations: ORG_CONTEXT_ORGANIZATIONS.map((org) => ({
                ...org,
                role: 'ADMIN',
              })),
              orgProjectRepositoryRefresh: { status },
            },
          },
        }),
      );
      const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can4445-admin-'));
      seedOrgContextScoping(userDataDir);
      const { electronApp } = await launchCanopy({
        userDataDir,
        env: {
          ...ORG_CONTEXT_ENV,
          // Capture any browser open instead of launching one.
          CANOPY_E2E_EXTERNAL_OPEN_CAPTURE_URL:
            DEFAULT_MOCK_BASE_URL + '/__mock/github/external-open',
        },
      });
      try {
        const window = await electronApp.firstWindow();
        const app = new CanopyAppDriver(window);
        await app.waitForShell({ timeout: 30_000 });
        await connectMockCloudAccount(window, apiKey);
        await app.openMainPage();
        await selectWorkspaceContext(window, ORG_CONTEXT_A);
        await window.getByTestId('sidebar-section-code-add').focus();
        await window.getByTestId('sidebar-section-code-add').press('Enter');
        const action =
          status === 'not-connected' ? 'connect-github' : 'choose-projects';
        await window.getByTestId('add-workspace-org-catalog-' + action).click();
        await expect(window.getByTestId('add-workspace-modal')).toHaveCount(0);
        const pageKey =
          status === 'not-connected'
            ? 'organization/settings'
            : 'organization/projects';
        await expect(
          window.locator(
            '[data-testid="hosted-settings-content"][data-hosted-settings-page="' +
              pageKey +
              '"]',
          ),
        ).toBeVisible({ timeout: 20_000 });
        const target =
          '/organization/' +
          ORG_CONTEXT_A +
          (status === 'not-connected'
            ? '/settings?tab=integrations'
            : '/projects');
        const { activity } = await getScenarioActivity(
          DEFAULT_MOCK_BASE_URL,
          apiKey,
        );
        expect(activity['authLinkMint:' + target]).toBeUndefined();
        // Nor did it open the page in a browser without signing in. The
        // capture is shared across specs, so look for this page only.
        const external = await fetch(
          DEFAULT_MOCK_BASE_URL + '/__mock/github/external-open',
        ).then((response) => response.json());
        expect(
          external.urls.filter((url) =>
            new URL(url).pathname.startsWith('/organization/' + ORG_CONTEXT_A),
          ),
        ).toEqual([]);
        await app.closeSettings();
      } finally {
        await closeCanopy(electronApp, userDataDir);
        await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
      }
    },
  );
}

const project = {
  id: '33333333-3333-4333-8333-333333333331',
  organizationId: ORG_CONTEXT_A,
  name: 'Catalog project',
  description: null,
  kind: 'CODE',
  purpose: 'project',
  visibility: 'organization',
  memberOwned: false,
  location: 'LOCAL',
  repository: {
    provider: 'github',
    host: 'github.com',
    owner: 'acme',
    name: 'catalog',
    providerRepoId: '1',
    defaultBranch: 'main',
    verification: 'VERIFIED',
  },
  state: 'ACTIVE',
  revision: 1,
  authorizationVersion: 1,
  defaultListed: false,
  preference: 'FOLLOW_DEFAULTS',
  listed: false,
  capabilities: { administer: false, manageCloud: false, use: true },
  instance: null,
};

function workspaceConfigByName(userDataDir, name) {
  const index = JSON.parse(
    readFileSync(path.join(userDataDir, 'workspaces', 'index.json'), 'utf8'),
  );
  const entry = index.workspaces.find((workspace) => workspace.name === name);
  if (!entry) return undefined;
  const config = JSON.parse(
    readFileSync(
      path.join(userDataDir, 'workspaces', entry.id, 'workspace.json'),
      'utf8',
    ),
  );
  return { ...entry, ...config };
}

for (const role of ['ADMIN', 'MEMBER']) {
  test(`${role}: a dismissed project is available again and Add sets it up on demand`, async () => {
    test.setTimeout(120_000);
    const apiKey = `csk_can2947_${role.toLowerCase()}`;
    // CAN-3453: the dialog offers no Dismiss. A project dismissed earlier
    // (for example on the web) is available again.
    const dismissed = { ...project, preference: 'DISMISSED' };
    await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
      cloud: {
        organizations: ORG_CONTEXT_ORGANIZATIONS.map((org) => ({
          ...org,
          role,
        })),
        orgProjects: { [`org:${ORG_CONTEXT_A}`]: [dismissed] },
      },
    });
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-can2947-'));
    seedOrgContextScoping(userDataDir);
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: {
        ...ORG_CONTEXT_ENV,
        CANOPY_E2E_CLOUD_BASE_URL: DEFAULT_MOCK_BASE_URL,
      },
    });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await connectMockCloudAccount(window, apiKey);
      await app.openMainPage();
      await selectWorkspaceContext(window, ORG_CONTEXT_A);
      const indexPath = path.join(userDataDir, 'workspaces', 'index.json');
      // Switching into an organization sets up its default Chats workspace
      // (#4159), which rewrites the index a moment later. Let that land
      // before taking the baseline browsing is compared against.
      await expect
        .poll(() => readFileSync(indexPath, 'utf8'))
        .toContain(`cowork-org-${ORG_CONTEXT_A}`);
      const beforeIndex = readFileSync(indexPath, 'utf8');
      await window.getByTestId('sidebar-section-code-add').focus();
      await window.getByTestId('sidebar-section-code-add').press('Enter');
      const dialog = window.getByTestId('add-workspace-modal');
      // The organization's catalog is the first tile of the Personal
      // dialog's row. A clone would be Personal, so Remote is not offered.
      await expect(window.getByTestId('add-workspace-mode-catalog')).toHaveText(
        'From my orgTeam projects',
      );
      await expect(
        window.getByTestId('add-workspace-mode-catalog'),
      ).toHaveAttribute('aria-pressed', 'true');
      await expect(
        window.getByTestId('add-workspace-mode-existing'),
      ).toContainText('Existing folder');
      await expect(
        window.getByTestId('add-workspace-mode-create'),
      ).toContainText('Create new');
      await expect(window.getByTestId('add-workspace-mode-remote')).toHaveCount(
        0,
      );
      const catalog = window.getByTestId('add-workspace-org-catalog');
      await expect(
        catalog.getByRole('region', { name: 'Projects' }),
      ).toContainText(project.repository.name);
      await expect(
        catalog.getByRole('region', { name: 'Dismissed' }),
      ).toHaveCount(0);
      await expect(
        window.locator('[data-testid^="add-workspace-org-catalog-dismiss-"]'),
      ).toHaveCount(0);
      await expect(
        window.getByTestId('add-workspace-personal-mode'),
      ).toHaveCount(0);
      // Browsing writes nothing: no preference, claim or local workspace.
      const browsed = (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, apiKey))
        .activity;
      expect(browsed.orgProjectPreferencePut ?? 0).toBe(0);
      expect(browsed[`orgProjectClaim:${project.id}`] ?? 0).toBe(0);
      expect(readFileSync(indexPath, 'utf8')).toBe(beforeIndex);
      // Add lists the project, then hands consent to the setup dialog
      // without claiming: nothing is cloned until the member starts it.
      await window
        .getByTestId(`add-workspace-org-catalog-add-${project.id}`)
        .click();
      await expect(dialog).toHaveCount(0);
      await expect
        .poll(
          async () =>
            (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, apiKey)).activity
              .orgProjectPreferencePut ?? 0,
        )
        .toBe(1);
      await expect(
        window.getByTestId('org-project-setup-dialog'),
      ).toBeVisible();
      await window.getByTestId('org-project-setup-cancel').click();
      expect(
        (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, apiKey)).activity[
          `orgProjectClaim:${project.id}`
        ] ?? 0,
      ).toBe(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
    }
  });
}

test('Advisor Add rejects another organization project and adds the active organization project', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_can2947_advisor_scope';
  const otherProject = {
    ...project,
    id: '33333333-3333-4333-8333-333333333332',
    organizationId: ORG_CONTEXT_B,
  };
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: {
      organizations: ORG_CONTEXT_ORGANIZATIONS,
      orgProjects: {
        [`org:${ORG_CONTEXT_A}`]: [project],
        [`org:${ORG_CONTEXT_B}`]: [otherProject],
      },
    },
  });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-can2947-advisor-'),
  );
  seedOrgContextScoping(userDataDir);
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: {
      ...ORG_CONTEXT_ENV,
      CANOPY_E2E_CLOUD_BASE_URL: DEFAULT_MOCK_BASE_URL,
    },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, apiKey);
    await app.openMainPage();
    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    const dispatch = async (projectId) =>
      electronApp.evaluate(async ({ BrowserWindow, ipcMain }, id) => {
        const mainWindow = BrowserWindow.getAllWindows().find(
          (candidate) =>
            candidate.webContents.getURL().includes('surface=app-advisor') ===
            false,
        );
        if (mainWindow === undefined) throw new Error('Main window not found');
        ipcMain.removeHandler('app-advisor:tool-response');
        return new Promise((resolve, reject) => {
          const requestId = `can2947-add-${id}`;
          const timer = setTimeout(
            () => reject(new Error('Advisor response timed out')),
            10_000,
          );
          ipcMain.handle('app-advisor:tool-response', (_event, response) => {
            if (response?.requestId === requestId) {
              clearTimeout(timer);
              resolve(response);
            }
          });
          mainWindow.webContents.send('app-advisor:tool-request', {
            kind: 'dispatch_action',
            requestId,
            source: 'assistant',
            action: { type: 'workspace.add_org_project', projectId: id },
          });
        });
      }, projectId);
    const rejected = await dispatch(otherProject.id);
    expect(
      (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, apiKey)).activity
        .orgProjectPreferencePut ?? 0,
    ).toBe(0);
    expect(rejected.ok).toBe(false);
    expect(rejected.error.code).toBe('not_found');
    const added = await dispatch(project.id);
    expect(added.ok).toBe(true);
    // CAN-3592: like the dialog's Add with no remembered folder, it lists the
    // project and asks for a folder; nothing is on this computer yet, and the
    // result says so rather than reporting an add.
    expect(added.result).toMatchObject({
      projectId: project.id,
      organizationId: ORG_CONTEXT_A,
      status: 'awaiting_setup',
      onThisComputer: false,
    });
    expect(
      (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, apiKey)).activity
        .orgProjectPreferencePut,
    ).toBe(1);
    await expect(window.getByTestId('org-project-setup-dialog')).toBeVisible();
    await window.getByTestId('org-project-setup-cancel').click();
    expect(
      (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, apiKey)).activity[
        `orgProjectClaim:${project.id}`
      ] ?? 0,
    ).toBe(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

test('member creates a private Cowork project in the selected organization', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_can3453_create';
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: { organizations: ORG_CONTEXT_ORGANIZATIONS },
  });
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-can3453-'));
  seedOrgContextScoping(userDataDir);
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: {
      ...ORG_CONTEXT_ENV,
      CANOPY_E2E_CLOUD_BASE_URL: DEFAULT_MOCK_BASE_URL,
    },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, apiKey);
    await app.openMainPage();
    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    await window.getByTestId('sidebar-section-code-add').focus();
    await window.getByTestId('sidebar-section-code-add').press('Enter');
    await window.getByTestId('add-workspace-mode-create').click();
    // The title names the organization; the notice only shows when the
    // organization requires chat sync (CAN-3909).
    await expect(
      window.getByRole('heading', { name: 'Add project to Acme' }),
    ).toBeVisible();
    await expect(window.getByTestId('add-workspace-org-notice')).toHaveCount(0);
    // The Personal panel's Project type control, with the types an
    // organization can take (Multi-repo since CAN-3546).
    await expect(
      window.getByTestId('add-workspace-type-multi-repo'),
    ).toHaveCount(1);
    await window.getByTestId('add-workspace-type-cowork').click();
    await window
      .getByTestId('add-workspace-name-input')
      .fill('Launch research');
    await window.getByTestId('add-workspace-create-submit').click();
    await expect(window.getByTestId('add-workspace-modal')).toHaveCount(0);
    await expect
      .poll(
        async () =>
          (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, apiKey)).activity
            .orgCoworkCreate ?? 0,
      )
      .toBe(1);

    const index = JSON.parse(
      readFileSync(path.join(userDataDir, 'workspaces', 'index.json'), 'utf8'),
    );
    const created = index.workspaces.find(
      (workspace) => workspace.name === 'Launch research',
    );
    expect(created).toMatchObject({
      type: 'cowork',
    });
    expect(created.id).toMatch(/^cowork-project-/);
    const config = JSON.parse(
      readFileSync(
        path.join(userDataDir, 'workspaces', created.id, 'workspace.json'),
        'utf8',
      ),
    );
    expect(config.owner).toMatchObject({
      type: 'organization',
      organizationId: ORG_CONTEXT_A,
    });
    await expect
      .poll(
        async () =>
          (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, apiKey)).activity,
      )
      .toMatchObject({
        [`orgProjectClaim:${config.owner.projectId}`]: 1,
        [`orgProjectComplete:${config.owner.projectId}`]: 1,
      });
    expect(config.externalPath).toBeUndefined();
    expect(
      existsSync(path.join(userDataDir, 'workspaces', created.id, 'home')),
    ).toBe(true);
    await expectWorkspaceContext(window, ORG_CONTEXT_A);
    await expect(
      window.locator(`[data-sidebar-workspace-id="${created.id}"]`),
    ).toBeVisible();
    await selectWorkspaceContext(window, 'personal');
    await expect(
      window.locator(`[data-sidebar-workspace-id="${created.id}"]`),
    ).toHaveCount(0);
    await selectWorkspaceContext(window, ORG_CONTEXT_B);
    await expect(
      window.locator(`[data-sidebar-workspace-id="${created.id}"]`),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

test('member adopts a git folder as an organization Code project in place', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_can3534_git_folder';
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: { organizations: ORG_CONTEXT_ORGANIZATIONS },
  });
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-can3534-'));
  seedOrgContextScoping(userDataDir);
  const folderRoot = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-can3534-folder-'),
  );
  const folder = path.join(folderRoot, 'member-code-folder');
  execFileSync('git', ['init', '--initial-branch=main', folder]);
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: {
      ...ORG_CONTEXT_ENV,
      CANOPY_E2E_CLOUD_BASE_URL: DEFAULT_MOCK_BASE_URL,
    },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, apiKey);
    await app.openMainPage();
    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    await window.getByTestId('sidebar-section-code-add').focus();
    await window.getByTestId('sidebar-section-code-add').press('Enter');
    await window.getByTestId('add-workspace-mode-existing').click();
    // A code-capable organization explains nothing up front: the drop area
    // waits for a folder (CAN-3909).
    await expect(window.getByTestId('add-workspace-folder-drop')).toBeVisible();
    await expect(
      window.getByTestId('add-workspace-existing-description'),
    ).toHaveCount(0);
    await electronApp.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [selected],
      });
    }, folder);
    // A routine folder is added on pick, as in Personal, under its own name.
    await window.getByTestId('add-workspace-choose-folder').click();
    await expect(window.getByTestId('add-workspace-modal')).toHaveCount(0);

    const created = workspaceConfigByName(userDataDir, 'member-code-folder');
    expect(created).toMatchObject({
      type: 'single-repo',
      name: 'member-code-folder',
      repoPath: realpathSync(folder),
      owner: {
        type: 'organization',
        organizationId: ORG_CONTEXT_A,
      },
    });
    expect(existsSync(path.join(folder, '.git'))).toBe(true);
    await selectWorkspaceContext(window, 'personal');
    await expect(
      window.locator(`[data-sidebar-workspace-id="${created.id}"]`),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
    rmSync(folderRoot, { recursive: true, force: true });
  }
});

test('member adds a plain folder as an organization Cowork project on pick', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_can3534_plain_folder';
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: { organizations: ORG_CONTEXT_ORGANIZATIONS },
  });
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-can3534-'));
  seedOrgContextScoping(userDataDir);
  const folderRoot = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-can3534-folder-'),
  );
  const folder = path.join(folderRoot, 'member-notes');
  mkdirSync(folder);
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: {
      ...ORG_CONTEXT_ENV,
      CANOPY_E2E_CLOUD_BASE_URL: DEFAULT_MOCK_BASE_URL,
    },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, apiKey);
    await app.openMainPage();
    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    await window.getByTestId('sidebar-section-code-add').focus();
    await window.getByTestId('sidebar-section-code-add').press('Enter');
    await window.getByTestId('add-workspace-mode-existing').click();
    await electronApp.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [selected],
      });
    }, folder);
    await window.getByTestId('add-workspace-choose-folder').click();
    await expect(window.getByTestId('add-workspace-modal')).toHaveCount(0);

    const created = workspaceConfigByName(userDataDir, 'member-notes');
    expect(created).toMatchObject({
      type: 'cowork',
      owner: {
        type: 'organization',
        organizationId: ORG_CONTEXT_A,
      },
    });
    // The folder is attached in place, not copied.
    expect(realpathSync(created.externalPath)).toBe(realpathSync(folder));
    expect(created.id).toMatch(/^cowork-project-/);
    await expectWorkspaceContext(window, ORG_CONTEXT_A);
    await selectWorkspaceContext(window, 'personal');
    await expect(
      window.locator(`[data-sidebar-workspace-id="${created.id}"]`),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
    rmSync(folderRoot, { recursive: true, force: true });
  }
});

test('member links a matching git folder to its existing organization project', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_can3534_existing_project';
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: {
      organizations: ORG_CONTEXT_ORGANIZATIONS,
      orgProjects: { [`org:${ORG_CONTEXT_A}`]: [project] },
    },
  });
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-can3534-'));
  seedOrgContextScoping(userDataDir);
  const folderRoot = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-can3534-folder-'),
  );
  const folder = path.join(folderRoot, 'matching-catalog-folder');
  execFileSync('git', ['init', '--initial-branch=main', folder]);
  execFileSync('git', [
    '-C',
    folder,
    'remote',
    'add',
    'origin',
    'git@github.com:acme/catalog.git',
  ]);
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: {
      ...ORG_CONTEXT_ENV,
      CANOPY_E2E_CLOUD_BASE_URL: DEFAULT_MOCK_BASE_URL,
    },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, apiKey);
    await app.openMainPage();
    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    await window.getByTestId('sidebar-section-code-add').focus();
    await window.getByTestId('sidebar-section-code-add').press('Enter');
    await window.getByTestId('add-workspace-mode-existing').click();
    await electronApp.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [selected],
      });
    }, folder);
    await window.getByTestId('add-workspace-choose-folder').click();
    // Linking to a project the organization already has waits for the member.
    await expect(
      window.getByTestId('add-workspace-org-folder-kind'),
    ).toContainText('This folder is already in Acme as Catalog project.');
    await expect(window.getByTestId('add-workspace-modal')).toBeVisible();
    expect(workspaceConfigByName(userDataDir, project.name)).toBeUndefined();
    await window.getByTestId('add-workspace-org-folder-add').click();
    await expect(window.getByTestId('add-workspace-modal')).toHaveCount(0);

    const linked = workspaceConfigByName(userDataDir, project.name);
    expect(linked).toMatchObject({
      type: 'single-repo',
      name: project.name,
      repoPath: realpathSync(folder),
      owner: {
        type: 'organization',
        organizationId: ORG_CONTEXT_A,
        projectId: project.id,
      },
    });
    expect(
      (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, apiKey)).activity
        .orgCodeCreate ?? 0,
    ).toBe(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
    rmSync(folderRoot, { recursive: true, force: true });
  }
});

// Hybrid model: a repository an organization holds is never moved between
// scopes after the one-time migration. Adding it in Personal nudges the
// member to the organization instead; they may still add it to Personal.
test('Personal Existing folder of an organization repository nudges to the organization', async () => {
  test.setTimeout(180_000);
  const apiKey = 'csk_hybrid_nudge_existing_folder';
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: {
      organizations: ORG_CONTEXT_ORGANIZATIONS,
      orgProjects: { [`org:${ORG_CONTEXT_A}`]: [project] },
    },
  });
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-nudge-'));
  seedOrgContextScoping(userDataDir);
  const folderRoot = mkdtempSync(path.join(os.tmpdir(), 'canopy-nudge-src-'));
  const gitFolder = (name) => {
    const folder = path.join(folderRoot, name);
    execFileSync('git', ['init', '--initial-branch=main', folder]);
    execFileSync('git', [
      '-C',
      folder,
      'remote',
      'add',
      'origin',
      'git@github.com:acme/catalog.git',
    ]);
    return folder;
  };
  const personalFolder = gitFolder('personal-anyway');
  const orgFolder = gitFolder('nudged-to-acme');
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: {
      ...ORG_CONTEXT_ENV,
      CANOPY_E2E_CLOUD_BASE_URL: DEFAULT_MOCK_BASE_URL,
    },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, apiKey);
    await app.openMainPage();
    await expectWorkspaceContext(window, 'personal');
    const dialog = window.getByTestId('add-workspace-modal');
    const notice = window.getByTestId('add-workspace-org-owner-notice');
    const pickFolder = async (folder) => {
      await window.getByTestId('sidebar-section-code-add').focus();
      await window.getByTestId('sidebar-section-code-add').press('Enter');
      await expect(dialog).toBeVisible();
      // Personal opens on Clone (CAN-3909).
      await window.getByTestId('add-workspace-mode-existing').click();
      await electronApp.evaluate(({ dialog: native }, selected) => {
        native.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [selected],
        });
      }, folder);
      await window.getByTestId('add-workspace-choose-folder').click();
      // Nothing is added until the member chooses where.
      await expect(notice).toContainText(
        `Acme has set up ${path.basename(folder)}. Adding it to Personal leaves out its skills, connectors and shared settings.`,
      );
      await expect(
        window.getByTestId('add-workspace-org-owner-folder-path'),
      ).toContainText(folder);
    };

    // Add to Personal: the unchanged Personal add.
    await pickFolder(personalFolder);
    await expect(
      window.getByTestId('add-workspace-org-owner-notice-continue'),
    ).toHaveText('Add to Personal');
    expect(
      workspaceConfigByName(userDataDir, 'personal-anyway'),
    ).toBeUndefined();
    await window.getByTestId('add-workspace-org-owner-notice-continue').click();
    await expect(dialog).toHaveCount(0);
    await expectWorkspaceContext(window, 'personal');
    const personal = workspaceConfigByName(userDataDir, 'personal-anyway');
    expect(personal).toMatchObject({
      type: 'single-repo',
      // Personal keeps the path as picked.
      repoPath: personalFolder,
    });
    expect(personal.owner).toBeUndefined();

    // Add to Acme: switch to Acme and continue the same folder there, which
    // shows the organization's link confirmation before anything is bound.
    await pickFolder(orgFolder);
    await window.getByTestId('add-workspace-org-owner-notice-add').click();
    // The sidebar scope switched under the open dialog.
    await expect(window.getByTestId('sidebar-context-row')).toHaveAttribute(
      'aria-label',
      'Workspace context: Acme',
    );
    await expect(dialog).toBeVisible();
    await expect(
      window.getByTestId('add-workspace-org-folder-kind'),
    ).toContainText('This folder is already in Acme as Catalog project.');
    await expect(
      window.getByTestId('add-workspace-org-folder-path'),
    ).toContainText(orgFolder);
    await expect(
      window.getByTestId('add-workspace-context-changed'),
    ).toHaveCount(0);
    await expect(notice).toHaveCount(0);
    expect(workspaceConfigByName(userDataDir, project.name)).toBeUndefined();
    await window.getByTestId('add-workspace-org-folder-add').click();
    await expect(dialog).toHaveCount(0);
    await expectWorkspaceContext(window, ORG_CONTEXT_A);
    expect(workspaceConfigByName(userDataDir, project.name)).toMatchObject({
      type: 'single-repo',
      name: project.name,
      repoPath: realpathSync(orgFolder),
      owner: {
        type: 'organization',
        organizationId: ORG_CONTEXT_A,
        projectId: project.id,
      },
    });
    // The Personal project stays Personal: nothing moved automatically.
    expect(
      workspaceConfigByName(userDataDir, 'personal-anyway').owner,
    ).toBeUndefined();
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
    rmSync(folderRoot, { recursive: true, force: true });
  }
});

test('member moves a matching Personal project into the organization', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_can3534_personal_move';
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: {
      organizations: ORG_CONTEXT_ORGANIZATIONS,
      orgProjects: { [`org:${ORG_CONTEXT_A}`]: [project] },
    },
  });
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-can3534-'));
  seedOrgContextScoping(userDataDir, {
    personalRemoteUrl: 'git@github.com:acme/catalog.git',
  });
  const folder = path.join(userDataDir, 'repos', PERSONAL_CONTEXT_WORKSPACE);
  const configPath = path.join(
    userDataDir,
    'workspaces',
    PERSONAL_CONTEXT_WORKSPACE,
    'workspace.json',
  );
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: {
      ...ORG_CONTEXT_ENV,
      CANOPY_E2E_CLOUD_BASE_URL: DEFAULT_MOCK_BASE_URL,
    },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, apiKey);
    await app.openMainPage();
    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    await window.getByTestId('sidebar-section-code-add').focus();
    await window.getByTestId('sidebar-section-code-add').press('Enter');
    await window.getByTestId('add-workspace-mode-existing').click();
    await electronApp.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [selected],
      });
    }, folder);
    await window.getByTestId('add-workspace-choose-folder').click();
    await expect(
      window.getByTestId('add-workspace-org-folder-kind'),
    ).toContainText('Your Personal project Personal repository moves to Acme');
    // Nothing moves until the member confirms.
    expect(JSON.parse(readFileSync(configPath, 'utf8')).owner).toBeUndefined();
    await window.getByTestId('add-workspace-org-folder-add').click();
    await expect(window.getByTestId('add-workspace-modal')).toHaveCount(0);

    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(config).toMatchObject({
      repoPath: folder,
      owner: {
        type: 'organization',
        organizationId: ORG_CONTEXT_A,
        projectId: project.id,
      },
      ownershipTransfer: {
        version: 1,
        previousOwner: { type: 'personal' },
        organizationId: ORG_CONTEXT_A,
        projectId: project.id,
      },
    });
    const index = JSON.parse(
      readFileSync(path.join(userDataDir, 'workspaces', 'index.json'), 'utf8'),
    );
    expect(
      index.workspaces.filter(
        (workspace) => workspace.id === PERSONAL_CONTEXT_WORKSPACE,
      ),
    ).toHaveLength(1);
    expect(
      (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, apiKey)).activity
        .orgCodeCreate ?? 0,
    ).toBe(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

test('member starts a new organization Code repository without a folder', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_can3534_new_repo';
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: { organizations: ORG_CONTEXT_ORGANIZATIONS },
  });
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-can3534-'));
  seedOrgContextScoping(userDataDir);
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: {
      ...ORG_CONTEXT_ENV,
      CANOPY_E2E_CLOUD_BASE_URL: DEFAULT_MOCK_BASE_URL,
    },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, apiKey);
    await app.openMainPage();
    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    await window.getByTestId('sidebar-section-code-add').focus();
    await window.getByTestId('sidebar-section-code-add').press('Enter');
    await window.getByTestId('add-workspace-mode-create').click();
    await expect(
      window.getByTestId('add-workspace-type-single-repo'),
    ).toHaveAttribute('aria-pressed', 'true');
    await window
      .getByTestId('add-workspace-name-input')
      .fill('Fresh member repo');
    await window.getByTestId('add-workspace-create-submit').click();
    await expect(window.getByTestId('add-workspace-modal')).toHaveCount(0);

    const created = workspaceConfigByName(userDataDir, 'Fresh member repo');
    expect(created).toMatchObject({
      type: 'single-repo',
      owner: {
        type: 'organization',
        organizationId: ORG_CONTEXT_A,
      },
    });
    expect(existsSync(path.join(created.repoPath, '.git'))).toBe(true);
    expect(existsSync(path.join(created.repoPath, 'canopy.json'))).toBe(true);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

test('member creates an organization multi-repo project and its settings open to add repositories', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_can3546_multi_repo';
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: { organizations: ORG_CONTEXT_ORGANIZATIONS },
  });
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-can3546-'));
  seedOrgContextScoping(userDataDir);
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: {
      ...ORG_CONTEXT_ENV,
      CANOPY_E2E_CLOUD_BASE_URL: DEFAULT_MOCK_BASE_URL,
    },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, apiKey);
    await app.openMainPage();
    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    await window.getByTestId('sidebar-section-code-add').focus();
    await window.getByTestId('sidebar-section-code-add').press('Enter');
    await window.getByTestId('add-workspace-mode-create').click();
    await window.getByTestId('add-workspace-type-multi-repo').click();
    // The same flow as a Personal multi-repo project: a name, then settings.
    await expect(window.getByTestId('add-workspace-modal')).toContainText(
      'Add them after you create it.',
    );
    await expect(
      window.locator('[data-testid^="add-workspace-org-multi-repo-picker"]'),
    ).toHaveCount(0);
    await window.getByTestId('add-workspace-name-input').fill('Acme platform');
    await window.getByTestId('add-workspace-create-submit').click();
    await expect(window.getByTestId('add-workspace-modal')).toHaveCount(0);

    const settingsDialog = window
      .locator('[role="dialog"]')
      .filter({ has: window.locator('#workspace-settings-title') });
    await expect(settingsDialog).toBeVisible();
    await expect(
      settingsDialog.getByRole('heading', { name: 'Repositories' }),
    ).toBeVisible();
    const activity = (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, apiKey))
      .activity;
    expect(activity.orgMemberMultiRepoCreate).toBe(1);
    expect(workspaceConfigByName(userDataDir, 'Acme platform')).toMatchObject({
      type: 'multi-repo',
      repos: [],
      owner: {
        type: 'organization',
        organizationId: ORG_CONTEXT_A,
      },
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

test('failed member Code creation leaves no local workspace or claim', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_can3453_create_failure';
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: {
      organizations: ORG_CONTEXT_ORGANIZATIONS,
      orgCoworkCreateStatus: 503,
    },
  });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-can3453-failure-'),
  );
  seedOrgContextScoping(userDataDir);
  const indexPath = path.join(userDataDir, 'workspaces', 'index.json');
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: {
      ...ORG_CONTEXT_ENV,
      CANOPY_E2E_CLOUD_BASE_URL: DEFAULT_MOCK_BASE_URL,
    },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, apiKey);
    await app.openMainPage();
    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    // Switching into an organization sets up its default Chats workspace
    // (#4159), which rewrites the index a moment later. Let that land before
    // the baseline, so the comparison below sees only what the failed creation
    // itself wrote.
    await expect
      .poll(() => readFileSync(indexPath, 'utf8'))
      .toContain(`cowork-org-${ORG_CONTEXT_A}`);
    const beforeIndex = readFileSync(indexPath, 'utf8');
    await window.getByTestId('sidebar-section-code-add').focus();
    await window.getByTestId('sidebar-section-code-add').press('Enter');
    await window.getByTestId('add-workspace-mode-create').click();
    await window
      .getByTestId('add-workspace-name-input')
      .fill('Unavailable research');
    await window.getByTestId('add-workspace-create-submit').click();
    await expect(window.getByTestId('add-workspace-org-error')).toContainText(
      "Couldn't create Unavailable research in Acme. Try again.",
    );
    const activity = (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, apiKey))
      .activity;
    expect(activity.orgCodeCreate).toBe(1);
    expect(readFileSync(indexPath, 'utf8')).toBe(beforeIndex);
    expect(
      readdirSync(path.join(userDataDir, 'workspaces')).filter((name) =>
        name.startsWith('cowork-project-'),
      ),
    ).toEqual([]);
    await window.keyboard.press('Escape');
    await expect(window.getByTestId('add-workspace-modal')).toHaveCount(0);
    await expectWorkspaceContext(window, ORG_CONTEXT_A);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

test('Advisor refuses Personal Cowork creation and creates it in the selected organization', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_can3453_advisor';
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: { organizations: ORG_CONTEXT_ORGANIZATIONS },
  });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-can3453-advisor-'),
  );
  seedOrgContextScoping(userDataDir);
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: {
      ...ORG_CONTEXT_ENV,
      CANOPY_E2E_CLOUD_BASE_URL: DEFAULT_MOCK_BASE_URL,
    },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, apiKey);
    await app.openMainPage();
    const dispatch = async (requestId) =>
      electronApp.evaluate(async ({ BrowserWindow, ipcMain }, id) => {
        const mainWindow = BrowserWindow.getAllWindows().find(
          (candidate) =>
            candidate.webContents.getURL().includes('surface=app-advisor') ===
            false,
        );
        if (mainWindow === undefined) throw new Error('Main window not found');
        ipcMain.removeHandler('app-advisor:tool-response');
        return new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('Advisor response timed out')),
            15_000,
          );
          ipcMain.handle('app-advisor:tool-response', (_event, response) => {
            if (response?.requestId === id) {
              clearTimeout(timer);
              resolve(response);
            }
          });
          mainWindow.webContents.send('app-advisor:tool-request', {
            kind: 'dispatch_action',
            requestId: id,
            source: 'assistant',
            action: {
              type: 'org_project.create_cowork',
              name: 'Advisor notes',
            },
          });
        });
      }, requestId);

    await selectWorkspaceContext(window, 'personal');
    const refused = await dispatch('can3453-advisor-personal');
    expect(refused).toMatchObject({
      ok: false,
      error: { code: 'surface_unavailable' },
    });
    expect(
      (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, apiKey)).activity
        .orgCoworkCreate ?? 0,
    ).toBe(0);

    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    const created = await dispatch('can3453-advisor-org');
    expect(created).toMatchObject({
      ok: true,
      result: {
        organizationId: ORG_CONTEXT_A,
        message: 'Created Advisor notes in Acme.',
      },
    });
    await expect
      .poll(
        async () =>
          (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, apiKey)).activity,
      )
      .toMatchObject({
        orgCoworkCreate: 1,
        [`orgProjectClaim:${created.result.projectId}`]: 1,
        [`orgProjectComplete:${created.result.projectId}`]: 1,
      });
    await expectWorkspaceContext(window, ORG_CONTEXT_A);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

for (const kind of ['cowork', 'repository']) {
  test(`a ${kind} folder added in Personal is Personal; in an organization it would be the organization's`, async () => {
    test.setTimeout(120_000);
    const apiKey = `csk_can3155_${kind}`;
    await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
      cloud: { organizations: ORG_CONTEXT_ORGANIZATIONS },
    });
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-can3155-'));
    seedOrgContextScoping(userDataDir);
    const folderRoot = mkdtempSync(path.join(os.tmpdir(), 'can3155-import-'));
    const folder = path.join(folderRoot, `personal-${kind}`);
    mkdirSync(folder);
    if (kind === 'repository') {
      execFileSync('git', ['init', '--initial-branch=main', folder]);
      execFileSync('git', [
        '-C',
        folder,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '--allow-empty',
        '-m',
        'Initial',
      ]);
    }
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: {
        ...ORG_CONTEXT_ENV,
        CANOPY_E2E_CLOUD_BASE_URL: DEFAULT_MOCK_BASE_URL,
      },
    });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await connectMockCloudAccount(window, apiKey);
      await app.openMainPage();
      const openAddProject = async () => {
        await window.getByTestId('sidebar-section-code-add').focus();
        await window.getByTestId('sidebar-section-code-add').press('Enter');
        await expect(window.getByTestId('add-workspace-modal')).toBeVisible();
      };
      // CAN-3453: an organization's Add project never creates a Personal
      // project. Its Existing folder option says, before a folder is
      // picked, that the project will be the organization's.
      await selectWorkspaceContext(window, ORG_CONTEXT_A);
      await window.getByTestId('sidebar-section-code-add').focus();
      await window.getByTestId('sidebar-section-code-add').press('Enter');
      // Acme's catalog is empty and this MEMBER can add a folder, so the
      // dialog withholds the catalog for this open and lands on Existing
      // folder (CAN-3984). Wait for that settled state rather than racing
      // the catalog and eligibility reads.
      await expect(
        window.getByTestId('add-workspace-mode-existing'),
      ).toHaveAttribute('aria-pressed', 'true');
      await expect(
        window.getByTestId('add-workspace-mode-catalog'),
      ).toHaveCount(0);
      await expect(
        window.getByTestId('add-workspace-personal-mode'),
      ).toHaveCount(0);
      await expect(
        window.getByTestId('add-workspace-personal-notice'),
      ).toHaveCount(0);
      await window.getByTestId('add-workspace-mode-existing').click();
      await expect(
        window.getByRole('heading', { name: 'Add project to Acme' }),
      ).toBeVisible();
      await expect(window.getByTestId('add-workspace-org-notice')).toHaveCount(
        0,
      );
      await expect(
        window.getByTestId('add-workspace-choose-folder'),
      ).toBeVisible();
      await window.keyboard.press('Escape');
      await expect(window.getByTestId('add-workspace-modal')).toHaveCount(0);
      await selectWorkspaceContext(window, 'personal');
      await window.getByTestId('sidebar-section-code-add').focus();
      await window.getByTestId('sidebar-section-code-add').press('Enter');
      await expect(window.getByTestId('add-workspace-org-catalog')).toHaveCount(
        0,
      );
      await expect(window.getByTestId('add-workspace-org-notice')).toHaveCount(
        0,
      );
      // Personal opens on Clone (CAN-3909).
      await window.getByTestId('add-workspace-mode-existing').click();
      await electronApp.evaluate(({ dialog }, selected) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [selected],
        });
      }, folder);
      await window.getByTestId('add-workspace-choose-folder').click();
      await expect(window.getByTestId('add-workspace-modal')).toHaveCount(0);
      await expectWorkspaceContext(window, 'personal');
      const projects = await window.evaluate(() => window.api.loadProjects());
      const imported = projects.items.find(
        (item) => item.name === `personal-${kind}`,
      );
      expect(imported).toBeDefined();
      if (kind === 'cowork') {
        await expect(
          window.getByTestId(`sidebar-cowork-project-${imported.id}`),
        ).toBeVisible();
        await expect(window.getByTestId('page-chat')).toBeVisible();
        await expect
          .poll(async () => {
            const result = await window.evaluate(
              (projectId) => window.api.workEntries.list({ projectId }),
              imported.id,
            );
            return result.entries.length;
          })
          .toBe(1);
      } else {
        await expect(
          window.getByTestId('page-home').getByTestId('home-workspace-select'),
        ).toContainText('personal-repository');
      }
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
      rmSync(folderRoot, { recursive: true, force: true });
    }
  });
}
