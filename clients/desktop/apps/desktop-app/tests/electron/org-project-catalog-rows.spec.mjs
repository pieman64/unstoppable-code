import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
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
} from './seeders/index.mjs';
import {
  expectWorkspaceContext,
  selectWorkspaceContext,
} from './workspaceContextMenu.mjs';

const SHARED_SIDEBAR_STORAGE_KEY = 'canopy.desktop.sharedSidebar';

const projects = ['VERIFIED', 'UNVERIFIED'].map((verification, index) => ({
  id:
    index === 0
      ? '33333333-3333-4333-8333-333333333331'
      : '33333333-3333-4333-8333-333333333332',
  organizationId: ORG_CONTEXT_A,
  name: index === 0 ? 'Catalog ready' : 'Catalog access',
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
    name: `repo-${index}`,
    providerRepoId: `${index + 1}`,
    defaultBranch: 'main',
    verification,
  },
  state: 'ACTIVE',
  revision: 1,
  authorizationVersion: 1,
  defaultListed: true,
  preference: 'FOLLOW_DEFAULTS',
  listed: true,
  capabilities: { administer: false, manageCloud: false, use: true },
  instance: null,
}));

// The seeded `context-organization` workspace is bound to this project, so the
// member already has it on this computer (CAN-3386).
const setUpProject = {
  ...projects[0],
  id: '33333333-3333-4333-8333-333333333333',
  name: 'Acme repository',
  repository: {
    ...projects[0].repository,
    name: 'acme-repository',
    providerRepoId: '3',
  },
  instance: { id: 'seeded-instance', state: 'READY' },
};

async function openAddProject(window) {
  await window.getByTestId('sidebar-section-code-add').focus();
  await window.getByTestId('sidebar-section-code-add').press('Enter');
  await expect(window.getByTestId('add-workspace-org-catalog')).toBeVisible();
}

/**
 * CAN-3453 removed Dismiss from the desktop Add project dialog, but a project
 * can still be dismissed elsewhere (the web catalog). Apply that dismissal
 * through the same preference API and wait for the desktop catalog to see it.
 */
async function dismissElsewhere(window, projectId) {
  await window.evaluate(
    ({ organizationId, projectId }) =>
      window.api.orgProjects.setPreference({
        context: { kind: 'organization', organizationId },
        projectId,
        preference: 'DISMISSED',
      }),
    { organizationId: ORG_CONTEXT_A, projectId },
  );
}

/**
 * Claims the mock recorded for these catalog projects. Switching into an
 * organization also claims its default Chats workspace (#4159), which is not
 * a catalog project and is not counted here.
 */
async function catalogClaims(apiKey, rows) {
  const { activity } = await getScenarioActivity(DEFAULT_MOCK_BASE_URL, apiKey);
  return rows.reduce(
    (total, row) => total + (activity[`orgProjectClaim:${row.id}`] ?? 0),
    0,
  );
}

async function catalogRowIds(window) {
  return (
    await window
      .locator('[data-testid^="add-workspace-org-catalog-row-"]')
      .evaluateAll((rows) =>
        rows.map((row) =>
          row.dataset.testid.replace('add-workspace-org-catalog-row-', ''),
        ),
      )
  ).sort();
}

test('the sidebar lists only set-up organization projects; the + dialog finds and adds the rest', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_can3386_catalog_rows';
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: {
      organizations: ORG_CONTEXT_ORGANIZATIONS,
      orgProjects: {
        [`org:${ORG_CONTEXT_A}`]: [...projects, setUpProject],
        [`org:${ORG_CONTEXT_B}`]: [],
      },
    },
  });
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-can3386-'));
  seedOrgContextScoping(userDataDir);
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: ORG_CONTEXT_ENV,
  });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, apiKey);
    const placeholders = window.locator(
      '[data-testid^="sidebar-org-project-placeholder-"]',
    );
    await expectWorkspaceContext(window, 'personal');
    await expect(placeholders).toHaveCount(0);
    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    // The set-up project is an ordinary project row; nothing else is listed.
    const localProject = window.getByTestId(
      'sidebar-project-header-context-organization',
    );
    await expect(localProject).toBeVisible();
    // The dialog shares the sidebar's catalog snapshot: once its rows are
    // listed, the sidebar has had every chance to render catalog rows.
    await openAddProject(window);
    await expect(
      window.getByTestId(`add-workspace-org-catalog-row-${projects[0].id}`),
    ).toBeVisible();
    // The sidebar scope chose the organization: its catalog is the first
    // option, beside the ones that make a member-owned project.
    await expect(
      window.getByTestId('add-workspace-mode-catalog'),
    ).toHaveAttribute('aria-pressed', 'true');
    for (const scopeButton of [
      'add-workspace-personal-mode',
      'add-workspace-org-create',
    ])
      await expect(window.getByTestId(scopeButton)).toHaveCount(0);
    await expect(placeholders).toHaveCount(0);
    await expect(
      window.getByTestId('sidebar-section-shared-projects'),
    ).toHaveCount(0);
    expect(await catalogRowIds(window)).toEqual(
      [...projects, setUpProject].map((project) => project.id).sort(),
    );
    const setUpRow = window.getByTestId(
      `add-workspace-org-catalog-row-${setUpProject.id}`,
    );
    await expect(setUpRow).toContainText('Added');
    await expect(
      window.getByTestId(`add-workspace-org-catalog-add-${setUpProject.id}`),
    ).toHaveCount(0);
    // Search matches the project name and its repository name.
    const search = window.getByTestId('add-workspace-org-catalog-search');
    await expect(search).toHaveAccessibleName('Search projects');
    await search.fill('repo-1');
    expect(await catalogRowIds(window)).toEqual([projects[1].id]);
    await search.fill('catalog ready');
    expect(await catalogRowIds(window)).toEqual([projects[0].id]);
    // Never the owner (CAN-3469): every repository here belongs to `acme`,
    // but only the project named Acme matches.
    await search.fill('acme');
    expect(await catalogRowIds(window)).toEqual([setUpProject.id]);
    await search.fill('acme/repo-1');
    await expect(
      window.getByTestId('add-workspace-org-catalog-no-match'),
    ).toBeVisible();
    await search.fill('');
    // An add dialog needs no "Not on this computer" filter (CAN-3469).
    await expect(
      window.getByTestId('add-workspace-org-catalog-not-local'),
    ).toHaveCount(0);
    // Nothing is claimed or cloned by browsing.
    expect(await catalogClaims(apiKey, [...projects, setUpProject])).toBe(0);
    // With no folder remembered from an earlier setup, Add falls back to the
    // setup dialog for that one project, and there is no other folder to
    // choose from the row (CAN-3469).
    await expect(
      window.getByTestId('add-workspace-org-catalog-destination'),
    ).toHaveCount(0);
    await expect(
      window.locator(
        '[data-testid^="add-workspace-org-catalog-choose-folder-"]',
      ),
    ).toHaveCount(0);
    for (const [index, project] of projects.entries()) {
      if (index > 0) await openAddProject(window);
      await window
        .getByTestId(`add-workspace-org-catalog-add-${project.id}`)
        .click();
      await expect(window.getByTestId('add-workspace-modal')).toHaveCount(0);
      const dialog = window.getByTestId('org-project-setup-dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(project.name);
      await expect(dialog).toContainText(`acme/repo-${index}`);
      await window.getByTestId('org-project-setup-cancel').click();
      await expect(dialog).toHaveCount(0);
      await expect(placeholders).toHaveCount(0);
    }
    expect(await catalogClaims(apiKey, [...projects, setUpProject])).toBe(0);
    await selectWorkspaceContext(window, ORG_CONTEXT_B);
    // An organization with a default Chats workspace is not empty (#4159),
    // and its empty Projects list is one `None found` row with nothing to add
    // (CAN-3550).
    await expect(window.getByTestId('sidebar-section-chats')).toBeVisible();
    await expect(window.getByTestId('sidebar-context-empty-state')).toHaveText(
      'None found',
    );
    await expect(
      window.getByTestId('sidebar-context-empty-state-add'),
    ).toHaveCount(0);
    await expect(placeholders).toHaveCount(0);
    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    // The dialog offers no Dismiss (CAN-3469). A project dismissed elsewhere
    // (the web keeps Dismiss) is simply available again here.
    await openAddProject(window);
    await expect(
      window.locator('[data-testid^="add-workspace-org-catalog-dismiss-"]'),
    ).toHaveCount(0);
    await window.keyboard.press('Escape');
    await window.evaluate(
      ({ organizationId, projectId }) =>
        window.api.orgProjects.setPreference({
          context: { kind: 'organization', organizationId },
          projectId,
          preference: 'DISMISSED',
        }),
      { organizationId: ORG_CONTEXT_A, projectId: projects[0].id },
    );
    await openAddProject(window);
    // Rows name the GitHub repository (CAN-3489).
    await expect(
      window
        .getByTestId('add-workspace-org-catalog')
        .getByRole('region', { name: 'Projects' }),
    ).toContainText(projects[0].repository.name);
    await expect(
      window
        .getByTestId('add-workspace-org-catalog')
        .getByRole('region', { name: 'Dismissed' }),
    ).toHaveCount(0);
    await window.keyboard.press('Escape');
    expect(
      (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, apiKey)).activity
        .orgProjectPreferencePut ?? 0,
    ).toBe(1);
    await expect(placeholders).toHaveCount(0);
    const index = JSON.parse(
      readFileSync(path.join(userDataDir, 'workspaces', 'index.json'), 'utf8'),
    );
    expect(JSON.stringify(index)).not.toContain('org-project:');
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

test('an organization with nothing on this computer points at the + dialog', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_can3386_empty_state';
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: {
      organizations: ORG_CONTEXT_ORGANIZATIONS,
      orgProjects: {
        [`org:${ORG_CONTEXT_A}`]: projects,
        [`org:${ORG_CONTEXT_B}`]: projects.map((project) => ({
          ...project,
          organizationId: ORG_CONTEXT_B,
        })),
      },
    },
  });
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-can3386e-'));
  seedOrgContextScoping(userDataDir);
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: ORG_CONTEXT_ENV,
  });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, apiKey);
    await selectWorkspaceContext(window, ORG_CONTEXT_B);
    // `None found`, with no action of its own: the Projects header's "+"
    // opens the dialog and stays on screen while the list is empty (CAN-3550).
    const empty = window.getByTestId('sidebar-context-empty-state');
    await expect(empty).toHaveText('None found');
    await expect(
      empty.getByTestId('sidebar-context-empty-state-label'),
    ).toHaveText('None found');
    await expect(empty).not.toContainText('Add a project from');
    await expect(
      window.getByTestId('sidebar-context-empty-state-add'),
    ).toHaveCount(0);
    await expect(
      window.getByTestId('sidebar-context-empty-state-back'),
    ).toHaveCount(0);
    await expect(
      window.locator('[data-testid^="sidebar-org-project-placeholder-"]'),
    ).toHaveCount(0);
    const add = window.getByTestId('sidebar-section-code-add');
    await window.mouse.move(900, 500);
    await expect(add).toHaveCSS('opacity', '1');
    await add.click();
    await expect(window.getByTestId('add-workspace-org-catalog')).toBeVisible();
    expect(await catalogRowIds(window)).toEqual(
      projects.map((project) => project.id).sort(),
    );
    expect(await catalogClaims(apiKey, projects)).toBe(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

// CAN-3537: the shared sidebar, as the portal renders it. The organization's
// default Chats lists above an empty Projects section; the catalog still has
// projects to add, and the Projects header's "+" opens it (CAN-3550).
test('the shared sidebar points at projects to add below an organization Chats', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_can3537_empty_projects_shared';
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: {
      organizations: ORG_CONTEXT_ORGANIZATIONS,
      orgProjects: {
        [`org:${ORG_CONTEXT_A}`]: projects,
        [`org:${ORG_CONTEXT_B}`]: projects.map((project) => ({
          ...project,
          organizationId: ORG_CONTEXT_B,
        })),
      },
    },
  });
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-can3537e-'));
  seedOrgContextScoping(userDataDir);
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: ORG_CONTEXT_ENV,
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, apiKey);
    await window.evaluate((key) => {
      window.localStorage.setItem(key, '1');
    }, SHARED_SIDEBAR_STORAGE_KEY);
    await window.reload();
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await selectWorkspaceContext(window, ORG_CONTEXT_B);
    await expect(window.getByTestId('sidebar-section-chats')).toBeVisible();
    const empty = window.getByTestId('sidebar-context-empty-state');
    await expect(
      empty.getByTestId('sidebar-context-empty-state-label'),
    ).toHaveText('None found');
    await expect(empty).not.toContainText('Add a project from');
    await expect(
      window.getByTestId('sidebar-context-empty-state-back'),
    ).toHaveCount(0);
    await expect(
      window.getByTestId('sidebar-context-empty-state-add'),
    ).toHaveCount(0);
    const add = window.getByTestId('sidebar-section-code-add');
    await window.mouse.move(900, 500);
    await expect(add).toHaveCSS('opacity', '1');
    await add.click();
    await expect(window.getByTestId('add-workspace-org-catalog')).toBeVisible();
    expect(await catalogClaims(apiKey, projects)).toBe(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

/**
 * The same rule, rendered by the shared sidebar. Setup rows are not
 * workspaces, so `partitionWorkspaces` drops them: the host has to hand a
 * running setup to the surface itself. The native path above cannot catch
 * that — it is a different component.
 */
test('the shared sidebar lists no catalog rows and shows a setup the member started', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_can3386_catalog_rows_shared';
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: {
      organizations: ORG_CONTEXT_ORGANIZATIONS,
      orgProjects: {
        [`org:${ORG_CONTEXT_A}`]: projects,
        [`org:${ORG_CONTEXT_B}`]: [],
      },
    },
  });
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-can3386s-'));
  seedOrgContextScoping(userDataDir);
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: ORG_CONTEXT_ENV,
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, apiKey);
    await window.evaluate((key) => {
      window.localStorage.setItem(key, '1');
    }, SHARED_SIDEBAR_STORAGE_KEY);
    await window.reload();
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    const placeholders = window.locator(
      '[data-testid^="sidebar-org-project-placeholder-"]',
    );
    await openAddProject(window);
    await expect(
      window.getByTestId(`add-workspace-org-catalog-row-${projects[0].id}`),
    ).toBeVisible();
    await expect(placeholders).toHaveCount(0);
    await expect(
      window.getByTestId('sidebar-section-shared-projects'),
    ).toHaveCount(0);
    await window
      .getByTestId(`add-workspace-org-catalog-add-${projects[0].id}`)
      .click();
    await expect(window.getByTestId('org-project-setup-dialog')).toBeVisible();
    await window.getByTestId('org-project-setup-cancel').click();
    expect(await catalogClaims(apiKey, projects)).toBe(0);
    // A running setup is shown until it resolves, without a network clone.
    await electronApp.evaluate(({ BrowserWindow }, projectId) => {
      for (const win of BrowserWindow.getAllWindows())
        win.webContents.send('org-projects:setup-progress', {
          projectId,
          instanceId: null,
          state: 'materializing',
          percent: 42,
          message: 'Cloning repository',
          updatedAt: new Date().toISOString(),
        });
    }, projects[0].id);
    const group = window.getByTestId('sidebar-section-shared-projects');
    await expect(
      group.getByTestId(`sidebar-org-project-placeholder-${projects[0].id}`),
    ).toContainText('Cloning repository');
    await expect(placeholders).toHaveCount(1);
    // And an organization with no catalog rows does not render the rows of
    // the previous context. Its default Chats workspace lists above an empty
    // Projects list, which is one `None found` row (#4159, CAN-3550).
    await selectWorkspaceContext(window, ORG_CONTEXT_B);
    await expect(window.getByTestId('sidebar-section-chats')).toBeVisible();
    await expect(window.getByTestId('sidebar-context-empty-state')).toHaveText(
      'None found',
    );
    await expect(
      window.getByTestId('sidebar-context-empty-state-add'),
    ).toHaveCount(0);
    await expect(placeholders).toHaveCount(0);
    await expect(
      window.getByTestId('sidebar-section-shared-projects'),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

for (const scenario of [
  'setup',
  'dismissed-setup',
  'access-changed',
  'shared-admission',
  'dismiss',
  'stability',
]) {
  test(`linked Personal project retains sidebar visibility: ${scenario}`, async () => {
    test.setTimeout(120_000);
    const apiKey = `csk_can3170_${scenario}`;
    await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
      cloud: {
        organizations: ORG_CONTEXT_ORGANIZATIONS,
        orgProjects: { [`org:${ORG_CONTEXT_A}`]: projects },
      },
    });
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-can3170-'));
    seedOrgContextScoping(userDataDir);
    execFileSync(
      'git',
      ['remote', 'add', 'origin', 'https://github.com/acme/repo-0.git'],
      {
        cwd: path.join(userDataDir, 'repos', 'context-personal'),
        stdio: 'pipe',
      },
    );
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: ORG_CONTEXT_ENV,
    });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await connectMockCloudAccount(window, apiKey);
      if (scenario === 'shared-admission') {
        await window.evaluate(
          (key) => window.localStorage.setItem(key, '1'),
          SHARED_SIDEBAR_STORAGE_KEY,
        );
        await window.reload();
        await app.waitForShell({ timeout: 30_000 });
        await app.openMainPage();
      }
      await selectWorkspaceContext(window, ORG_CONTEXT_A);
      const row = window.getByTestId(
        `sidebar-org-project-placeholder-${projects[0].id}`,
      );
      // Wait for the link lookup, not merely the initial absence of catalog rows.
      await expect
        .poll(() =>
          window.evaluate(async () => {
            const result = await window.api.orgProjects.linksList();
            return result.status === 'resolved' ? result.links : [];
          }),
        )
        .toContainEqual({
          projectId: projects[0].id,
          personalWorkspaceId: 'context-personal',
        });
      // CAN-3386: a catalog project the member has not set up is not a row.
      await expect(
        window.getByTestId(`sidebar-org-project-placeholder-${projects[1].id}`),
      ).toHaveCount(0);
      await expect(row).toHaveCount(0);
      const personal = window.getByTestId(
        scenario === 'shared-admission'
          ? 'sidebar-project-context-personal'
          : 'sidebar-project-header-context-personal',
      );
      if (scenario === 'stability') {
        // Links used to drop on a later refresh and come back as Set up rows
        // until a context switch. Catalog refreshes, focus refreshes and a
        // transient Git failure must all leave the linked row in place.
        const linksStatus = () =>
          window.evaluate(
            async () => (await window.api.orgProjects.linksList()).status,
          );
        const focusWindow = () =>
          window.evaluate(() => window.dispatchEvent(new Event('focus')));
        const expectLinkedRow = async () => {
          await expect(personal).toBeVisible();
          await expect(row).toHaveCount(0);
        };
        await expectLinkedRow();
        for (let attempt = 0; attempt < 3; attempt += 1) {
          await window.evaluate(
            (organizationId) =>
              window.api.orgProjects.refresh({
                context: { kind: 'organization', organizationId },
              }),
            ORG_CONTEXT_A,
          );
          await focusWindow();
          await expectLinkedRow();
          // Step past the focus-refresh throttle so each focus really asks.
          await window.waitForTimeout(5_500);
        }
        const repoDir = path.join(userDataDir, 'repos', 'context-personal');
        renameSync(path.join(repoDir, '.git'), path.join(repoDir, '.git-off'));
        try {
          await expect.poll(linksStatus).toBe('unknown');
          await focusWindow();
          // Span the first bounded retries, which also answer unknown.
          for (let tick = 0; tick < 4; tick += 1) {
            await window.waitForTimeout(1_000);
            await expectLinkedRow();
          }
        } finally {
          renameSync(
            path.join(repoDir, '.git-off'),
            path.join(repoDir, '.git'),
          );
        }
        await expect.poll(linksStatus).toBe('resolved');
        await window.waitForTimeout(5_500);
        await focusWindow();
        await expectLinkedRow();
      } else if (scenario === 'dismiss') {
        await expect(personal).toBeVisible();
        await dismissElsewhere(window, projects[0].id);
        await expect(personal).toHaveCount(0);
        await expect(row).toHaveCount(0);
        await selectWorkspaceContext(window, 'personal');
        await expect(personal).toBeVisible();
      } else if (scenario === 'shared-admission') {
        await expect(personal).toBeVisible();
        const handle = personal.getByRole('button', {
          name: 'Reorder Personal repository',
        });
        await handle.focus();
        await handle.press('Enter');
        await expect(handle).toHaveAttribute('aria-pressed', 'true');
        // dnd-kit measures droppables just after pickup; an ArrowDown that
        // lands first finds no target and leaves the item over itself. Press
        // again only until the move registers, so it never overshoots.
        const movedOverOrganization = window
          .locator('[id^="DndLiveRegion"]')
          .filter({
            hasText: 'was moved over droppable area context-organization',
          });
        await expect(async () => {
          if ((await movedOverOrganization.count()) === 0) {
            await handle.press('ArrowDown');
          }
          await expect(movedOverOrganization).toHaveCount(1, {
            timeout: 1_000,
          });
        }).toPass({ timeout: 15_000 });
        await handle.press('Enter');
        await expect
          .poll(() => {
            const index = JSON.parse(
              readFileSync(
                path.join(userDataDir, 'workspaces', 'index.json'),
                'utf8',
              ),
            );
            const personalOrder = index.workspaces.find(
              (workspace) => workspace.id === 'context-personal',
            ).order;
            const orgOrder = index.workspaces.find(
              (workspace) => workspace.id === 'context-organization',
            ).order;
            return personalOrder > orgOrder;
          })
          .toBe(true);
        await expect(personal).toBeVisible();
        await expect(
          window.getByTestId('sidebar-section-shared-projects'),
        ).toHaveCount(0);
      } else if (scenario === 'setup' || scenario === 'dismissed-setup') {
        // The linked checkout already puts this project on this computer, so
        // the + dialog offers no Add for it (CAN-3469). A setup can still run
        // (from Advisor or an earlier attempt); deliver deterministic service
        // progress without cloning over the network.
        for (const state of ['materializing', 'failed']) {
          await electronApp.evaluate(
            ({ BrowserWindow }, { projectId, state }) => {
              for (const win of BrowserWindow.getAllWindows())
                win.webContents.send('org-projects:setup-progress', {
                  projectId,
                  instanceId: null,
                  state,
                  percent: 42,
                  message:
                    state === 'failed' ? 'Clone failed' : 'Cloning repository',
                  updatedAt: new Date().toISOString(),
                });
            },
            { projectId: projects[0].id, state },
          );
          if (scenario === 'dismissed-setup' && state === 'materializing') {
            await dismissElsewhere(window, projects[0].id);
            await expect(row).toContainText('Cloning repository');
          }
          await expect(row).toContainText(
            state === 'failed' ? 'Clone failed' : '42%',
          );
          const action = window.getByTestId(
            `sidebar-org-project-${state === 'failed' ? 'retry' : 'cancel'}-${projects[0].id}`,
          );
          if (scenario === 'dismissed-setup' && state === 'failed') {
            await expect(action).toHaveCount(0);
          } else {
            await expect(action).toBeVisible();
          }
          if (scenario !== 'dismissed-setup')
            await expect(personal).toBeVisible();
        }
        if (scenario === 'dismissed-setup') {
          await expect(
            window.getByTestId(`sidebar-org-project-retry-${projects[0].id}`),
          ).toHaveCount(0);
        } else {
          await window
            .getByTestId(`sidebar-org-project-retry-${projects[0].id}`)
            .click();
          await expect(
            window.getByTestId('org-project-setup-dialog'),
          ).toBeVisible();
        }
      } else {
        for (const error of ['offline', 'access-changed']) {
          await electronApp.evaluate(
            ({ BrowserWindow }, snapshot) => {
              for (const win of BrowserWindow.getAllWindows())
                win.webContents.send('org-projects:changed', snapshot);
            },
            {
              context: `org:${ORG_CONTEXT_A}`,
              revision: error,
              fetchedAt: new Date().toISOString(),
              stale: true,
              error,
              projects,
            },
          );
          if (error === 'offline') {
            await expect(personal).toBeVisible();
          } else {
            await expect(personal).toHaveCount(0);
          }
          // Neither state brings back a row for a project not set up.
          await expect(row).toHaveCount(0);
        }
      }
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
    }
  });
}

/**
 * CAN-3469: the + dialog reads a linked Personal checkout as on this computer,
 * but links arrive asynchronously (main runs `git remote get-url` per Personal
 * workspace). Until they have been resolved for this organization, Add must
 * stay unavailable, or one-click Add into the remembered folder could start a
 * second checkout of a repository that is already here. The links answer is
 * held at the IPC boundary so the gap is deterministic.
 */
test('Add stays unavailable until linked checkouts are resolved', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_can3469_links_pending';
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: {
      organizations: ORG_CONTEXT_ORGANIZATIONS,
      orgProjects: { [`org:${ORG_CONTEXT_A}`]: projects },
    },
  });
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-can3469l-'));
  seedOrgContextScoping(userDataDir);
  execFileSync(
    'git',
    ['remote', 'add', 'origin', 'https://github.com/acme/repo-0.git'],
    {
      cwd: path.join(userDataDir, 'repos', 'context-personal'),
      stdio: 'pipe',
    },
  );
  const destination = path.join(userDataDir, 'clones');
  mkdirSync(destination);
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    JSON.stringify({
      version: 1,
      preferences: { orgProjectDefaultDestinationRoot: destination },
    }),
  );
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: ORG_CONTEXT_ENV,
  });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, apiKey);
    await electronApp.evaluate(({ ipcMain }) => {
      const channel = 'org-projects:links-list';
      const original = ipcMain._invokeHandlers.get(channel);
      if (!original) throw new Error('Missing links handler');
      const gate = new Promise((resolve) => {
        globalThis.__can3469ReleaseLinks = resolve;
      });
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (event, ...args) => {
        await gate;
        return original(event, ...args);
      });
    });
    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    await openAddProject(window);
    await expect(
      window.getByTestId('add-workspace-org-catalog-destination'),
    ).toContainText(destination);
    const linkedRow = window.getByTestId(
      `add-workspace-org-catalog-row-${projects[0].id}`,
    );
    await expect(linkedRow).toBeVisible();
    const add = window.getByTestId(
      `add-workspace-org-catalog-add-${projects[0].id}`,
    );
    await expect(add).toBeDisabled();
    await add.click({ force: true });
    await expect(window.getByTestId('add-workspace-modal')).toBeVisible();
    await electronApp.evaluate(() => globalThis.__can3469ReleaseLinks());
    await expect(linkedRow).toContainText('Added');
    await expect(add).toHaveCount(0);
    // The unlinked project becomes available once the answer is in.
    await expect(
      window.getByTestId(`add-workspace-org-catalog-add-${projects[1].id}`),
    ).toBeEnabled();
    // Nothing was listed, claimed or cloned.
    const { activity } = await getScenarioActivity(
      DEFAULT_MOCK_BASE_URL,
      apiKey,
    );
    expect(activity.orgProjectPreferencePut ?? 0).toBe(0);
    expect(await catalogClaims(apiKey, projects)).toBe(0);
    expect(readdirSync(destination)).toEqual([]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

/**
 * CAN-3469: main links a Personal checkout only to a listed project, so an
 * unlisted project's existing checkout is unknown until Add lists it. One-click
 * Add must ask for fresh links after listing and clone nothing when the
 * project turns out to be linked.
 */
test('Add on an unlisted project already checked out here clones nothing', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_can3469_unlisted_linked';
  const unlisted = { ...projects[0], defaultListed: false, listed: false };
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: {
      organizations: ORG_CONTEXT_ORGANIZATIONS,
      orgProjects: { [`org:${ORG_CONTEXT_A}`]: [unlisted, projects[1]] },
    },
  });
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-can3469u-'));
  seedOrgContextScoping(userDataDir);
  execFileSync(
    'git',
    ['remote', 'add', 'origin', 'https://github.com/acme/repo-0.git'],
    {
      cwd: path.join(userDataDir, 'repos', 'context-personal'),
      stdio: 'pipe',
    },
  );
  const destination = path.join(userDataDir, 'clones');
  mkdirSync(destination);
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    JSON.stringify({
      version: 1,
      preferences: { orgProjectDefaultDestinationRoot: destination },
    }),
  );
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: ORG_CONTEXT_ENV,
  });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, apiKey);
    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    await openAddProject(window);
    const row = window.getByTestId(
      `add-workspace-org-catalog-row-${unlisted.id}`,
    );
    // Not listed, so not linked yet: it looks available to add.
    await expect(row).not.toContainText('Added');
    const add = window.getByTestId(
      `add-workspace-org-catalog-add-${unlisted.id}`,
    );
    await expect(add).toBeEnabled();
    await add.click();
    await expect(row).toContainText('Added');
    await expect(window.getByTestId('add-workspace-modal')).toBeVisible();
    await expect(window.getByTestId('org-project-setup-dialog')).toHaveCount(0);
    await expect(
      window.getByTestId(`sidebar-org-project-placeholder-${unlisted.id}`),
    ).toHaveCount(0);
    expect(readdirSync(destination)).toEqual([]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

/**
 * CAN-3388: a repository already on disk used to show as a project in the
 * organization, then flip back to a Set up row. The first switch into an
 * organization asked main for same-repository links before its catalog had
 * ever arrived, and main answered "nothing is linked" from an empty stand-in,
 * so the catalog that followed rendered the on-disk repository as a setup
 * row. A second Personal checkout of the same repository also listed the
 * project twice. The recorder below watches every DOM change, not just the
 * settled state, so a single flashed frame fails the test.
 */
test('a repository already on disk stays one stable project through the switch and catalog refreshes', async () => {
  test.setTimeout(180_000);
  const apiKey = 'csk_can3388_stable_org_rows';
  const linked = projects[0];
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: {
      organizations: ORG_CONTEXT_ORGANIZATIONS,
      orgProjects: { [`org:${ORG_CONTEXT_A}`]: projects },
      // Real catalogs page through the network; the gap between the switch
      // and the first answer is where the stand-in used to leak.
      orgProjectCatalogDelayMs: 750,
    },
  });
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-can3388-'));
  seedOrgContextScoping(userDataDir, {
    extraPersonalWorkspaces: [
      { id: 'context-personal-copy', name: 'Personal repository copy' },
    ],
  });
  for (const id of ['context-personal', 'context-personal-copy']) {
    execFileSync(
      'git',
      ['remote', 'add', 'origin', 'https://github.com/acme/repo-0.git'],
      { cwd: path.join(userDataDir, 'repos', id), stdio: 'pipe' },
    );
  }
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: ORG_CONTEXT_ENV,
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, apiKey);
    await expectWorkspaceContext(window, 'personal');
    // Exact ids: other header surfaces share the prefix with a suffix.
    const PERSONAL_ROWS =
      '[data-testid="sidebar-project-header-context-personal"], [data-testid="sidebar-project-header-context-personal-copy"]';
    const personalRows = window.locator(PERSONAL_ROWS);
    await expect(personalRows).toHaveCount(2);
    await window.evaluate(
      ({ projectId, rowsSelector }) => {
        const recorder = { setupRowSeen: false, personalCounts: [] };
        const record = () => {
          if (
            document.querySelector(
              `[data-testid="sidebar-org-project-placeholder-${projectId}"]`,
            )
          )
            recorder.setupRowSeen = true;
          const count = document.querySelectorAll(rowsSelector).length;
          if (recorder.personalCounts.at(-1) !== count)
            recorder.personalCounts.push(count);
        };
        new MutationObserver(record).observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['data-testid'],
        });
        record();
        window.__can3388 = recorder;
      },
      { projectId: linked.id, rowsSelector: PERSONAL_ROWS },
    );
    const recorded = () => window.evaluate(() => window.__can3388);
    const resetCounts = () =>
      window.evaluate(() => {
        const recorder = window.__can3388;
        recorder.personalCounts = recorder.personalCounts.slice(-1);
      });

    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    // Settled: the delayed catalog has arrived. Since CAN-3386 the other
    // catalog project is added from +, not offered as a sidebar row, and the
    // on-disk one is a single project row.
    await window.evaluate(
      (organizationId) =>
        window.api.orgProjects.refresh({
          context: { kind: 'organization', organizationId },
        }),
      ORG_CONTEXT_A,
    );
    await expect(
      window.getByTestId(`sidebar-org-project-placeholder-${projects[1].id}`),
    ).toHaveCount(0);
    await expect(
      window.getByTestId('sidebar-project-header-context-personal'),
    ).toBeVisible();
    expect((await recorded()).setupRowSeen).toBe(false);
    await expect(personalRows).toHaveCount(1);

    // Waiting through every kind of refresh must not move anything.
    await resetCounts();
    const orgContext = { kind: 'organization', organizationId: ORG_CONTEXT_A };
    for (let round = 0; round < 2; round += 1) {
      await window.evaluate(
        (context) => window.api.orgProjects.refresh({ context }),
        orgContext,
      );
      await window.evaluate(
        (context) => window.api.orgProjects.refresh({ context, force: true }),
        orgContext,
      );
      await window.evaluate(() => window.dispatchEvent(new Event('focus')));
      // Step past the focus throttle so the next focus really asks again.
      await window.waitForTimeout(5_500);
    }
    expect((await recorded()).personalCounts).toEqual([1]);
    await selectWorkspaceContext(window, 'personal');
    await expect(personalRows).toHaveCount(2);
    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    await expect(personalRows).toHaveCount(1);
    await resetCounts();
    await window.waitForTimeout(3_000);
    const final = await recorded();
    expect(final.setupRowSeen).toBe(false);
    expect(final.personalCounts).toEqual([1]);
    await expect(
      window.getByTestId(`sidebar-org-project-placeholder-${linked.id}`),
    ).toHaveCount(0);
    // CAN-3469: the + dialog agrees with the sidebar. A linked checkout puts
    // the project on this computer, so its row offers no Add.
    await openAddProject(window);
    const linkedRow = window.getByTestId(
      `add-workspace-org-catalog-row-${linked.id}`,
    );
    await expect(linkedRow).toContainText('Added');
    await expect(
      window.getByTestId(`add-workspace-org-catalog-add-${linked.id}`),
    ).toHaveCount(0);
    await expect(
      window.getByTestId(`add-workspace-org-catalog-add-${projects[1].id}`),
    ).toBeVisible();
    await window.keyboard.press('Escape');
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

test('the search stays pinned while a long catalog scrolls', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_can3469_sticky_search';
  const many = Array.from({ length: 30 }, (_, index) => ({
    ...projects[0],
    id: `44444444-4444-4444-8444-${String(index).padStart(12, '0')}`,
    name: `Sticky project ${index}`,
    listed: false,
    repository: {
      ...projects[0].repository,
      name: `sticky-${index}`,
      providerRepoId: `${100 + index}`,
    },
  }));
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: {
      organizations: ORG_CONTEXT_ORGANIZATIONS,
      orgProjects: {
        [`org:${ORG_CONTEXT_A}`]: [...many, setUpProject],
        [`org:${ORG_CONTEXT_B}`]: [],
      },
    },
  });
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-can3469-'));
  seedOrgContextScoping(userDataDir);
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: ORG_CONTEXT_ENV,
  });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, apiKey);
    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    await openAddProject(window);
    await expect(
      window.getByTestId(`add-workspace-org-catalog-row-${many[29].id}`),
    ).toBeAttached();
    const search = window.getByTestId('add-workspace-org-catalog-search');
    // Scroll the list with the wheel, as a member would.
    const firstRow = window.getByTestId(
      `add-workspace-org-catalog-row-${many[0].id}`,
    );
    await firstRow.hover();
    for (let step = 0; step < 20; step += 1) {
      await window.mouse.wheel(0, 400);
    }
    await expect(
      window.getByTestId(`add-workspace-org-catalog-row-${many[29].id}`),
    ).toBeInViewport();
    const pinned = await search.boundingBox();
    for (let step = 0; step < 5; step += 1) {
      await window.mouse.wheel(0, 400);
    }
    const after = await search.boundingBox();
    expect(pinned).not.toBeNull();
    expect(after).not.toBeNull();
    // Once the search reaches its sticky position, more scrolling leaves it there.
    expect(Math.abs((after?.y ?? 0) - (pinned?.y ?? 0))).toBeLessThan(16);
    await expect(search).toBeInViewport();
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey).catch(() => {});
  }
});

/** Rows of one catalog group, in the order the dialog shows them. */
async function groupRowIds(window, group) {
  return window
    .getByTestId('add-workspace-org-catalog')
    .getByRole('region', { name: group })
    .locator('[data-testid^="add-workspace-org-catalog-row-"]')
    .evaluateAll((rows) =>
      rows.map((row) =>
        row.dataset.testid.replace('add-workspace-org-catalog-row-', ''),
      ),
    );
}

function minutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

// CAN-3489: GitHub-style rows, sorted by last update like GitHub's list.
const liveRows = [
  {
    ...projects[0],
    id: '55555555-5555-4555-8555-555555555551',
    name: 'Nightly jobs',
    listed: false,
    defaultListed: false,
    repository: {
      ...projects[0].repository,
      name: 'nightly-jobs',
      providerRepoId: '51',
      description: 'Runs the nightly reconciliation jobs',
      visibility: 'PRIVATE',
      updatedAt: minutesAgo(3 * 24 * 60),
    },
  },
  {
    ...projects[0],
    id: '55555555-5555-4555-8555-555555555552',
    name: 'Docs site',
    listed: false,
    defaultListed: false,
    repository: {
      ...projects[0].repository,
      name: 'docs-site',
      providerRepoId: '52',
      description: null,
      visibility: 'PUBLIC',
      updatedAt: minutesAgo(5 * 60),
    },
  },
];
// Created on GitHub while the member works: the next open lists it.
const createdOnGitHub = {
  ...liveRows[0],
  id: '55555555-5555-4555-8555-555555555553',
  name: 'created-a-minute-ago',
  repository: {
    ...liveRows[0].repository,
    name: 'created-a-minute-ago',
    providerRepoId: '53',
    description: 'Made a minute ago',
    visibility: 'INTERNAL',
    updatedAt: minutesAgo(1),
  },
};

test('the + dialog shows GitHub-style rows and re-reads GitHub every time it opens', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_can3489_live_rows';
  const cloud = {
    organizations: ORG_CONTEXT_ORGANIZATIONS,
    orgProjects: {
      [`org:${ORG_CONTEXT_A}`]: [...liveRows, setUpProject],
      [`org:${ORG_CONTEXT_B}`]: [],
    },
  };
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, { cloud });
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-can3489-'));
  seedOrgContextScoping(userDataDir);
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: ORG_CONTEXT_ENV,
  });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, apiKey);
    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    await openAddProject(window);
    // Opening the dialog asks the server to re-read GitHub.
    await expect
      .poll(
        async () =>
          (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, apiKey)).activity
            .orgProjectRepositoryRefresh ?? 0,
      )
      .toBe(1);
    const [nightly, docs] = liveRows;
    const nightlyRow = window.getByTestId(
      `add-workspace-org-catalog-row-${nightly.id}`,
    );
    await expect(
      nightlyRow.getByTestId(`add-workspace-org-catalog-name-${nightly.id}`),
    ).toHaveText('nightly-jobs');
    await expect(
      nightlyRow.getByTestId(
        `add-workspace-org-catalog-description-${nightly.id}`,
      ),
    ).toHaveText('Runs the nightly reconciliation jobs');
    await expect(
      nightlyRow.getByTestId(
        `add-workspace-org-catalog-visibility-${nightly.id}`,
      ),
    ).toHaveText('Private');
    await expect(
      nightlyRow.getByTestId(`add-workspace-org-catalog-updated-${nightly.id}`),
    ).toHaveText('Updated 3d ago');
    await expect(
      window.getByTestId(`add-workspace-org-catalog-visibility-${docs.id}`),
    ).toHaveText('Public');
    await expect(
      window.getByTestId(`add-workspace-org-catalog-description-${docs.id}`),
    ).toHaveCount(0);
    // Newest first, as GitHub lists them.
    // One list: newest first, the project already here last (CAN-3469).
    expect(await groupRowIds(window, 'Projects')).toEqual([
      docs.id,
      nightly.id,
      setUpProject.id,
    ]);
    // The set-up project shows a disabled Added button in Add's place.
    await expect(
      window.getByTestId(`add-workspace-org-catalog-added-${setUpProject.id}`),
    ).toBeDisabled();
    await expect(
      window.getByTestId(`add-workspace-org-catalog-add-${nightly.id}`),
    ).toBeEnabled();
    // These rows could run in the cloud, but Add to Cloud and Open are
    // web-only: the desktop host passes no `cloud` (REG-3091).
    await expect(
      window.locator(
        '[data-testid^="add-workspace-org-catalog-add-cloud-"], [data-testid^="add-workspace-org-catalog-open-cloud-"]',
      ),
    ).toHaveCount(0);
    await expect(
      window.getByTestId('add-workspace-org-catalog-github-refresh-failed'),
    ).toHaveCount(0);
    await window.keyboard.press('Escape');

    // A repository is created on GitHub. Nobody refreshes on the web: the
    // next open lists it, newest first, ready to add.
    await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
      cloud: {
        ...cloud,
        orgProjectRepositoryRefresh: {
          createdRepositories: { [`org:${ORG_CONTEXT_A}`]: [createdOnGitHub] },
        },
      },
    });
    await openAddProject(window);
    const createdRow = window.getByTestId(
      `add-workspace-org-catalog-row-${createdOnGitHub.id}`,
    );
    await expect(createdRow).toBeVisible();
    await expect(createdRow).toContainText('created-a-minute-ago');
    await expect(createdRow).toContainText('Internal');
    expect(await groupRowIds(window, 'Projects')).toEqual([
      createdOnGitHub.id,
      docs.id,
      nightly.id,
      setUpProject.id,
    ]);
    await window
      .getByTestId(`add-workspace-org-catalog-add-${createdOnGitHub.id}`)
      .click();
    const setup = window.getByTestId('org-project-setup-dialog');
    await expect(setup).toBeVisible();
    await expect(setup).toContainText('acme/created-a-minute-ago');
    await window.getByTestId('org-project-setup-cancel').click();
    // Name-only search still finds it by its repository name.
    await openAddProject(window);
    await window
      .getByTestId('add-workspace-org-catalog-search')
      .fill('created-a');
    expect(await catalogRowIds(window)).toEqual([createdOnGitHub.id]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey).catch(() => {});
  }
});

test('the + dialog keeps the cached list, noted, when GitHub cannot be read', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_can3489_refresh_failed';
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: {
      organizations: ORG_CONTEXT_ORGANIZATIONS,
      orgProjects: {
        [`org:${ORG_CONTEXT_A}`]: liveRows,
        [`org:${ORG_CONTEXT_B}`]: [],
      },
      orgProjectRepositoryRefresh: { status: 'failed' },
    },
  });
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-can3489f-'));
  seedOrgContextScoping(userDataDir);
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: ORG_CONTEXT_ENV,
  });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, apiKey);
    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    await openAddProject(window);
    await expect(
      window.getByTestId('add-workspace-org-catalog-github-refresh-failed'),
    ).toHaveText(
      "Couldn't refresh from GitHub. New repositories may be missing.",
    );
    // The list is still there and still addable; it is not offline.
    expect(await catalogRowIds(window)).toEqual(
      liveRows.map((row) => row.id).sort(),
    );
    await expect(
      window.getByTestId(`add-workspace-org-catalog-add-${liveRows[0].id}`),
    ).toBeEnabled();
    await expect(
      window.getByTestId('add-workspace-org-catalog'),
    ).not.toContainText('Offline');
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey).catch(() => {});
  }
});
