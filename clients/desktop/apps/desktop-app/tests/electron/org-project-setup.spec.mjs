import {
  autoConversionDiagnostics,
  initRepository,
} from './orgCombineScopeFixture.mjs';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
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
  seedWorktreeChat,
  ORG_CONTEXT_A,
  ORG_CONTEXT_B,
  ORG_CONTEXT_ENV,
  ORG_CONTEXT_ORGANIZATIONS,
} from './seeders/index.mjs';
import { selectWorkspaceContext } from './workspaceContextMenu.mjs';
import {
  catalogProject,
  openSetup,
  PROJECT_ID,
  seedLocalRepository,
} from './orgProjectSetupFixture.mjs';
import {
  DISPOSABLE_COMBINATION,
  KEPT_COMBINATION,
  seedEmptyTemporaryCombinations,
} from './keptCombinationsFixture.mjs';

/**
 * Claims the mock recorded for these catalog projects. Switching into an
 * organization also claims its default Chats workspace (#4159), which is not
 * a catalog project, so organization-wide totals would count it too.
 */
async function catalogClaims(apiKey, projectIds) {
  const { activity } = await getScenarioActivity(DEFAULT_MOCK_BASE_URL, apiKey);
  return projectIds.reduce(
    (total, id) => total + (activity[`orgProjectClaim:${id}`] ?? 0),
    0,
  );
}
function workspaces(userDataDir) {
  return JSON.parse(
    readFileSync(path.join(userDataDir, 'workspaces', 'index.json'), 'utf8'),
  ).workspaces;
}

function workspaceConfigs(userDataDir) {
  return workspaces(userDataDir).map((entry) => ({
    ...entry,
    ...JSON.parse(
      readFileSync(
        path.join(userDataDir, 'workspaces', entry.id, 'workspace.json'),
        'utf8',
      ),
    ),
  }));
}

test('sets up a catalog Cowork project without a destination or clone', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_can3453_catalog_cowork';
  const userDataDir = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), 'canopy-can3453-catalog-')),
  );
  seedOrgContextScoping(userDataDir);
  const coworkProject = {
    ...catalogProject(),
    name: 'Catalog Cowork',
    kind: 'COWORK',
    visibility: 'private',
    memberOwned: true,
    repository: null,
    capabilities: { administer: true, manageCloud: false, use: true },
  };
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: {
      organizations: ORG_CONTEXT_ORGANIZATIONS,
      orgProjects: { [`org:${ORG_CONTEXT_A}`]: [coworkProject] },
    },
  });
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: ORG_CONTEXT_ENV,
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, apiKey);
    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    await window.getByTestId('sidebar-section-code-add').focus();
    await window.getByTestId('sidebar-section-code-add').press('Enter');
    await window
      .getByTestId(`add-workspace-org-catalog-add-${PROJECT_ID}`)
      .click();
    const dialog = window.getByTestId('org-project-setup-dialog');
    await expect(dialog).toBeVisible();
    await expect(
      window.getByTestId('org-project-setup-destination'),
    ).toHaveCount(0);
    await expect(dialog).not.toContainText('Repository');
    await expect(dialog).not.toContainText('Default branch');
    await expect(
      window.getByTestId('org-project-setup-cowork-disclosure'),
    ).toContainText(
      'Creates an empty Cowork project on this computer. Chats stay on this computer.',
    );
    await window.getByTestId('org-project-setup-start').click();
    const workspaceId = `cowork-project-${PROJECT_ID}`;
    await expect
      .poll(() => workspaces(userDataDir).map((entry) => entry.id), {
        timeout: 30_000,
      })
      .toContain(workspaceId);
    const workspaceDir = path.join(userDataDir, 'workspaces', workspaceId);
    const config = JSON.parse(
      readFileSync(path.join(workspaceDir, 'workspace.json'), 'utf8'),
    );
    expect(config).toMatchObject({
      type: 'cowork',
      owner: {
        type: 'organization',
        organizationId: ORG_CONTEXT_A,
        projectId: PROJECT_ID,
      },
    });
    expect(config.externalPath).toBeUndefined();
    expect(existsSync(path.join(workspaceDir, 'home'))).toBe(true);
    expect(existsSync(path.join(workspaceDir, 'home', '.git'))).toBe(false);
    const activity = (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, apiKey))
      .activity;
    expect(activity[`orgProjectClaim:${PROJECT_ID}`]).toBe(1);
    expect(activity[`orgProjectComplete:${PROJECT_ID}`]).toBe(1);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

test('binds a repository-less member Code project from a chosen folder', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_can3534_choose_folder';
  const userDataDir = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), 'canopy-can3534-choose-folder-')),
  );
  seedOrgContextScoping(userDataDir);
  const folderRoot = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-can3534-choose-folder-source-'),
  );
  const folder = path.join(folderRoot, 'second-computer-checkout');
  execFileSync('git', ['init', '--initial-branch=main', folder]);
  const memberCodeProject = {
    ...catalogProject(),
    name: 'Member Code',
    visibility: 'private',
    memberOwned: true,
    repository: null,
    capabilities: { administer: true, manageCloud: false, use: true },
  };
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: {
      organizations: ORG_CONTEXT_ORGANIZATIONS,
      orgProjects: { [`org:${ORG_CONTEXT_A}`]: [memberCodeProject] },
    },
  });
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: ORG_CONTEXT_ENV,
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, apiKey);
    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    await window.getByTestId('sidebar-section-code-add').focus();
    await window.getByTestId('sidebar-section-code-add').press('Enter');
    await window
      .getByTestId(`add-workspace-org-catalog-add-${PROJECT_ID}`)
      .click();
    const dialog = window.getByTestId('org-project-setup-dialog');
    await expect(dialog).toContainText('Choose the project folder');
    await expect(
      window.getByTestId('org-project-setup-folder-disclosure'),
    ).toContainText('Its files stay where they are');
    await electronApp.evaluate(({ dialog: nativeDialog }, selected) => {
      nativeDialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [selected],
      });
    }, folder);
    await window.getByTestId('org-project-setup-choose-folder').click();
    await expect(dialog).toHaveCount(0);
    await expect
      .poll(
        () =>
          workspaceConfigs(userDataDir).find(
            (entry) => entry.repoPath === realpathSync(folder),
          ),
        { timeout: 30_000 },
      )
      .toMatchObject({
        type: 'single-repo',
        owner: {
          type: 'organization',
          organizationId: ORG_CONTEXT_A,
          projectId: PROJECT_ID,
        },
      });
    expect(existsSync(path.join(folder, '.git'))).toBe(true);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
    rmSync(folderRoot, { recursive: true, force: true });
  }
});

test('sets up in the consented root despite a preference change after Start, exactly once', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_can2956_setup';
  const userDataDir = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), 'canopy-can2956-')),
  );
  const { cloneBase, destination, source } = seedLocalRepository(userDataDir);
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: {
      organizations: ORG_CONTEXT_ORGANIZATIONS,
      orgProjects: { [`org:${ORG_CONTEXT_A}`]: [catalogProject()] },
      orgProjectClaimDelayMs: 500,
    },
  });
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: { ...ORG_CONTEXT_ENV, CANOPY_E2E_ORG_PROJECT_CLONE_BASE: cloneBase },
    }));
    const { window, row } = await openSetup(
      electronApp,
      apiKey,
      destination,
      false,
    );
    const otherDestination = path.join(userDataDir, 'other-clones');
    mkdirSync(otherDestination);
    // Hold the request at the IPC boundary while another window's preference
    // save completes. Both real handlers run: only their ordering is controlled.
    await electronApp.evaluate(({ ipcMain }, otherRoot) => {
      const start = ipcMain._invokeHandlers.get('org-projects:setup-start');
      const save = ipcMain._invokeHandlers.get('preferences:save');
      if (!start || !save) throw new Error('Missing setup/preferences handler');
      ipcMain.removeHandler('org-projects:setup-start');
      ipcMain.handle('org-projects:setup-start', async (event, request) => {
        await save(event, { orgProjectDefaultDestinationRoot: otherRoot });
        return start(event, request);
      });
    }, otherDestination);
    await window.getByTestId('org-project-setup-start').click();
    await expect(window.getByTestId('org-project-setup-dialog')).toHaveCount(0);
    await expect
      .poll(async () =>
        window.evaluate(
          async () =>
            (await window.api.loadPreferences())
              .orgProjectDefaultDestinationRoot,
        ),
      )
      .toBe(otherDestination);

    await expect(row).toHaveCount(0, { timeout: 30_000 });
    await expect(
      window.getByTestId(`sidebar-org-project-placeholder-${PROJECT_ID}`),
    ).toHaveCount(0);
    const checkout = path.join(destination, 'setup-repo');
    expect(readFileSync(path.join(checkout, 'README.md'), 'utf8')).toBe(
      'Local setup fixture\n',
    );
    expect(
      execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: checkout,
        encoding: 'utf8',
      }),
    ).toBe(
      execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: source,
        encoding: 'utf8',
      }),
    );
    expect(
      execFileSync('git', ['branch', '--show-current'], {
        cwd: checkout,
        encoding: 'utf8',
      }).trim(),
    ).toBe('main');
    expect(existsSync(path.join(checkout, 'canopy.json'))).toBe(false);
    const workspace = workspaces(userDataDir).find((entry) =>
      entry.id.startsWith('setup-repo'),
    );
    expect(workspace).toBeDefined();
    const config = JSON.parse(
      readFileSync(
        path.join(userDataDir, 'workspaces', workspace.id, 'workspace.json'),
        'utf8',
      ),
    );
    expect(config.repoPath).toBe(checkout);
    expect(config.owner).toMatchObject({
      type: 'organization',
      organizationId: ORG_CONTEXT_A,
      projectId: PROJECT_ID,
      bindingGeneration: 1,
    });
    await expect(
      window.getByTestId(`sidebar-project-header-${workspace.id}`),
    ).toBeVisible();
    await expect(window.getByTestId('org-project-setup-dialog')).toHaveCount(0);
    // Back in the + dialog the project reads as set up and offers no Add.
    await window.getByTestId('sidebar-section-code-add').focus();
    await window.getByTestId('sidebar-section-code-add').press('Enter');
    await expect(
      window.getByTestId(`add-workspace-org-catalog-row-${PROJECT_ID}`),
    ).toContainText('Added');
    await expect(
      window.getByTestId(`add-workspace-org-catalog-add-${PROJECT_ID}`),
    ).toHaveCount(0);
    await window.keyboard.press('Escape');
    await expect(window.getByTestId('add-workspace-modal')).toHaveCount(0);
    expect(
      JSON.parse(
        readFileSync(path.join(userDataDir, 'preferences.json'), 'utf8'),
      ).preferences.orgProjectDefaultDestinationRoot,
    ).toBe(otherDestination);
    expect(readdirSync(otherDestination)).toEqual([]);
    const before = workspaces(userDataDir);
    const beforePaths = readdirSync(destination);
    // Ready rows no longer offer Set up. Exercise a stale second request through
    // the same preload API to prove the coordinator's guard, too.
    await expect(
      window.getByTestId(`sidebar-org-project-setup-${PROJECT_ID}`),
    ).toHaveCount(0);
    await window.evaluate(
      async ({ projectId, destinationRoot }) => {
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            unsubscribe();
            reject(new Error('Repeated setup did not become ready'));
          }, 10_000);
          const unsubscribe = window.api.orgProjects.onSetupProgress(
            (progress) => {
              if (
                progress.projectId === projectId &&
                progress.state === 'ready'
              ) {
                clearTimeout(timeout);
                unsubscribe();
                resolve();
              }
            },
          );
          void window.api.orgProjects
            .setupStart({ projectId, destinationRoot })
            .then((progress) => {
              if (progress.state === 'ready') {
                clearTimeout(timeout);
                unsubscribe();
                resolve();
              }
            })
            .catch((error) => {
              clearTimeout(timeout);
              unsubscribe();
              reject(error);
            });
        });
      },
      { projectId: PROJECT_ID, destinationRoot: destination },
    );
    await expect
      .poll(
        async () =>
          (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, apiKey)).activity[
            `orgProjectComplete:${PROJECT_ID}`
          ],
      )
      .toBe(1);
    expect(
      (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, apiKey)).activity[
        `orgProjectClaim:${PROJECT_ID}`
      ],
    ).toBe(1);
    expect(workspaces(userDataDir)).toEqual(before);
    expect(readdirSync(destination)).toEqual(beforePaths);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

test('Add sets a project up in the remembered folder without the setup dialog', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_can3469_one_click_add';
  const userDataDir = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), 'canopy-can3469-')),
  );
  const { cloneBase, destination, source } = seedLocalRepository(userDataDir);
  // Not listed yet: Add lists it first, then sets it up.
  const project = { ...catalogProject(), defaultListed: false, listed: false };
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: {
      organizations: ORG_CONTEXT_ORGANIZATIONS,
      orgProjects: { [`org:${ORG_CONTEXT_A}`]: [project] },
    },
  });
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: { ...ORG_CONTEXT_ENV, CANOPY_E2E_ORG_PROJECT_CLONE_BASE: cloneBase },
    }));
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, apiKey);
    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    await window.getByTestId('sidebar-section-code-add').focus();
    await window.getByTestId('sidebar-section-code-add').press('Enter');
    // The folder the member chose for an earlier setup is preselected.
    const folder = window.getByTestId('add-workspace-org-catalog-destination');
    await expect(folder).toContainText(destination);
    await expect(folder).toHaveAttribute('title', destination);
    const catalogRow = window.getByTestId(
      `add-workspace-org-catalog-row-${PROJECT_ID}`,
    );
    await expect(catalogRow).not.toContainText('Added');
    // One pinned folder control for the whole list, none per row.
    await expect(
      window.getByTestId('add-workspace-org-catalog-change-destination'),
    ).toBeVisible();
    // Record every frame: the setup dialog must never appear, not merely be
    // gone by the time the assertion runs.
    await window.evaluate(() => {
      const recorder = { setupDialogSeen: false };
      const record = () => {
        if (document.querySelector('[data-testid="org-project-setup-dialog"]'))
          recorder.setupDialogSeen = true;
      };
      new MutationObserver(record).observe(document.body, {
        childList: true,
        subtree: true,
      });
      window.__can3469 = recorder;
    });
    await window
      .getByTestId(`add-workspace-org-catalog-add-${PROJECT_ID}`)
      .click();
    await expect(window.getByTestId('add-workspace-modal')).toHaveCount(0);
    await expect
      .poll(
        () =>
          workspaces(userDataDir).some((entry) =>
            entry.id.startsWith('setup-repo'),
          ),
        { timeout: 30_000 },
      )
      .toBe(true);
    const checkout = path.join(destination, 'setup-repo');
    expect(readFileSync(path.join(checkout, 'README.md'), 'utf8')).toBe(
      'Local setup fixture\n',
    );
    expect(
      execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: checkout,
        encoding: 'utf8',
      }),
    ).toBe(
      execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: source,
        encoding: 'utf8',
      }),
    );
    const workspace = workspaces(userDataDir).find((entry) =>
      entry.id.startsWith('setup-repo'),
    );
    await expect(
      window.getByTestId(`sidebar-project-header-${workspace.id}`),
    ).toBeVisible();
    expect(
      (await window.evaluate(() => window.__can3469)).setupDialogSeen,
    ).toBe(false);
    const { activity } = await getScenarioActivity(
      DEFAULT_MOCK_BASE_URL,
      apiKey,
    );
    expect(activity.orgProjectPreferencePut).toBe(1);
    expect(activity[`orgProjectClaim:${project.id}`]).toBe(1);
    await expect
      .poll(
        async () =>
          (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, apiKey)).activity[
            `orgProjectComplete:${project.id}`
          ],
      )
      .toBe(1);
    // Exactly one checkout, with no collision suffix.
    expect(readdirSync(destination)).toEqual(['setup-repo']);
    // Back in the + dialog it is on this computer.
    await window.getByTestId('sidebar-section-code-add').focus();
    await window.getByTestId('sidebar-section-code-add').press('Enter');
    await expect(catalogRow).toContainText('Added');
    await expect(
      window.getByTestId(`add-workspace-org-catalog-add-${PROJECT_ID}`),
    ).toHaveCount(0);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

/**
 * Sends one App Advisor tool request to the main window and awaits its
 * response. It replaces main's tool-response handler for the rest of the
 * app's life, so it must be the only Advisor client in the launched app.
 */
async function advisorToolRequest(electronApp, body) {
  return electronApp.evaluate(async ({ BrowserWindow, ipcMain }, request) => {
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
        20_000,
      );
      ipcMain.handle('app-advisor:tool-response', (_event, response) => {
        if (response?.requestId === request.requestId) {
          clearTimeout(timer);
          resolve(response);
        }
      });
      mainWindow.webContents.send('app-advisor:tool-request', request);
    });
  }, body);
}

// CAN-3592: from Personal, App Advisor switches to the organization that owns
// the repository and adds its project. The add carries the revision of the
// switch's own response, as the model does, while app state is still
// settling from the switch; it must land the project on this computer and in
// the organization's sidebar, not only list it.
for (const stale of [false, true]) {
  // A removed workspace leaves its instance READY on the server; the add must
  // release it and set the project up again rather than call it added.
  test(`Advisor switches to the owning organization and its add lands the project in the sidebar${stale ? ' after its workspace was removed' : ''}`, async () => {
    test.setTimeout(120_000);
    const apiKey = `csk_can3592_advisor_add_${stale ? 'stale' : 'fresh'}`;
    const userDataDir = realpathSync(
      mkdtempSync(path.join(os.tmpdir(), 'canopy-can3592-')),
    );
    const { cloneBase, destination } = seedLocalRepository(userDataDir);
    const project = stale
      ? {
          ...catalogProject(),
          preference: 'ADDED',
          instance: { id: 'stale-ready-instance', state: 'READY' },
        }
      : { ...catalogProject(), defaultListed: false, listed: false };
    await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
      cloud: {
        organizations: ORG_CONTEXT_ORGANIZATIONS,
        orgProjects: { [`org:${ORG_CONTEXT_A}`]: [project] },
      },
    });
    let electronApp;
    try {
      ({ electronApp } = await launchCanopy({
        userDataDir,
        env: {
          ...ORG_CONTEXT_ENV,
          CANOPY_E2E_ORG_PROJECT_CLONE_BASE: cloneBase,
        },
      }));
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await connectMockCloudAccount(window, apiKey);
      await app.openMainPage();
      const switched = await advisorToolRequest(electronApp, {
        kind: 'dispatch_action',
        requestId: 'can3592-switch',
        source: 'assistant',
        action: {
          type: 'workspace_context.switch',
          context: { kind: 'organization', organizationId: ORG_CONTEXT_A },
        },
      });
      expect(switched.ok).toBe(true);
      // The switch keeps updating app state for a moment, so the revision the
      // model holds is already behind when its add arrives.
      await expect
        .poll(
          async () =>
            (
              await advisorToolRequest(electronApp, {
                kind: 'get_current_ui_state',
                requestId: `can3592-ui-${Date.now()}`,
              })
            ).uiState.revision,
        )
        .toBeGreaterThan(switched.uiState.revision);
      const added = await advisorToolRequest(electronApp, {
        kind: 'dispatch_action',
        requestId: 'can3592-add',
        source: 'assistant',
        expectedUiRevision: switched.uiState.revision,
        action: { type: 'workspace.add_org_project', projectId: PROJECT_ID },
      });
      expect(added.error).toBeUndefined();
      expect(added.ok).toBe(true);
      expect(added.result).toMatchObject({
        projectId: PROJECT_ID,
        organizationId: ORG_CONTEXT_A,
      });
      // A fast clone finishes within the add's wait and reports the bound
      // workspace; a slow one is still under way. Never an unbound success.
      expect(['on_this_computer', 'setting_up']).toContain(added.result.status);
      expect(added.result.onThisComputer).toBe(
        added.result.status === 'on_this_computer',
      );
      await expect
        .poll(
          () =>
            workspaces(userDataDir).some((entry) =>
              entry.id.startsWith('setup-repo'),
            ),
          { timeout: 30_000 },
        )
        .toBe(true);
      const workspace = workspaces(userDataDir).find((entry) =>
        entry.id.startsWith('setup-repo'),
      );
      await expect(
        window.getByTestId(`sidebar-project-header-${workspace.id}`),
      ).toBeVisible();
      expect(readdirSync(destination)).toEqual(['setup-repo']);
      const { activity } = await getScenarioActivity(
        DEFAULT_MOCK_BASE_URL,
        apiKey,
      );
      expect(activity.orgProjectPreferencePut ?? 0).toBe(stale ? 0 : 1);
      expect(activity[`orgProjectDetach:${PROJECT_ID}`] ?? 0).toBe(
        stale ? 1 : 0,
      );
      expect(activity[`orgProjectClaim:${PROJECT_ID}`]).toBe(1);
    } finally {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
      await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
    }
  });
}

test('cancels before promotion and removes the real staging checkout without creating a workspace', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_can2956_cancel';
  const userDataDir = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), 'canopy-can2956-cancel-')),
  );
  const { cloneBase, destination } = seedLocalRepository(userDataDir);
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: {
      organizations: ORG_CONTEXT_ORGANIZATIONS,
      orgProjects: { [`org:${ORG_CONTEXT_A}`]: [catalogProject()] },
      // Hold the cloud access recheck after the real clone, before promotion.
      // This avoids racing a tiny local clone or adding a production delay seam.
      orgProjectValidationDelayMs: 10_000,
    },
  });
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: { ...ORG_CONTEXT_ENV, CANOPY_E2E_ORG_PROJECT_CLONE_BASE: cloneBase },
    }));
    const beforeWorkspaceIds = workspaces(userDataDir).map((entry) => entry.id);
    const { window, row } = await openSetup(electronApp, apiKey, destination);
    await expect
      .poll(
        async () =>
          (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, apiKey)).activity
            .orgProjectValidationRead ?? 0,
      )
      .toBeGreaterThan(0);
    // Taken once the switch has set up the organization's default Chats
    // workspace (#4159), while promotion is still held behind validation:
    // only the project's own workspace must never appear.
    await expect
      .poll(() =>
        workspaces(userDataDir).some(
          (entry) => entry.id === `cowork-org-${ORG_CONTEXT_A}`,
        ),
      )
      .toBe(true);
    const before = workspaces(userDataDir);
    const staging = readdirSync(destination).find((entry) =>
      entry.startsWith('.canopy-setup-'),
    );
    expect(staging).toBeDefined();
    expect(
      readFileSync(path.join(destination, staging, 'README.md'), 'utf8'),
    ).toBe('Local setup fixture\n');
    await expect(row.getByRole('status')).not.toBeEmpty();
    await expect(
      row.getByTestId(`sidebar-org-project-setup-${PROJECT_ID}`),
    ).toHaveCount(0);
    await expect(
      row.getByTestId(`sidebar-org-project-cancel-${PROJECT_ID}`),
    ).toBeVisible();
    // Focus returns to the + that started the flow, not to a lost dialog.
    await expect(window.getByTestId('sidebar-section-code-add')).toBeFocused({
      timeout: 1_000,
    });
    await window
      .getByTestId(`sidebar-org-project-cancel-${PROJECT_ID}`)
      .click();
    // A cancelled setup leaves the project in the + dialog only.
    await expect(row).toHaveCount(0, { timeout: 30_000 });
    expect(existsSync(path.join(destination, staging))).toBe(false);
    expect(existsSync(path.join(destination, 'setup-repo'))).toBe(false);
    const defaultChatsId = `cowork-org-${ORG_CONTEXT_A}`;
    expect(
      workspaces(userDataDir)
        .map((entry) => entry.id)
        .filter((id) => id !== defaultChatsId),
    ).toEqual(beforeWorkspaceIds.filter((id) => id !== defaultChatsId));
    const { activity } = await getScenarioActivity(
      DEFAULT_MOCK_BASE_URL,
      apiKey,
    );
    expect(activity[`orgProjectClaim:${PROJECT_ID}`]).toBe(1);
    expect(activity[`orgProjectDetach:${PROJECT_ID}`]).toBe(1);
    expect(activity[`orgProjectComplete:${PROJECT_ID}`] ?? 0).toBe(0);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

test('shows clone failure and Retry on the row, then reopens consent', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_can2956_retry';
  const userDataDir = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), 'canopy-can2956-retry-')),
  );
  const { destination } = seedLocalRepository(userDataDir);
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: {
      organizations: ORG_CONTEXT_ORGANIZATIONS,
      orgProjects: { [`org:${ORG_CONTEXT_A}`]: [catalogProject()] },
    },
  });
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: {
        ...ORG_CONTEXT_ENV,
        CANOPY_E2E_ORG_PROJECT_CLONE_BASE: path.join(
          userDataDir,
          'missing-bare',
        ),
      },
    }));
    const { window, row } = await openSetup(electronApp, apiKey, destination);
    const retry = row.getByTestId(`sidebar-org-project-retry-${PROJECT_ID}`);
    await expect(retry).toBeVisible({ timeout: 30_000 });
    await expect(row.getByRole('status')).not.toBeEmpty();
    await retry.click();
    await expect(window.getByTestId('org-project-setup-dialog')).toBeVisible();
    await expect(window.getByTestId('org-project-setup-start')).toHaveText(
      'Start',
    );
    await window.getByTestId('org-project-setup-cancel').click();
    await expect(window.getByTestId('org-project-setup-dialog')).toHaveCount(0);
    await expect(retry).toBeFocused();
    const { activity } = await getScenarioActivity(
      DEFAULT_MOCK_BASE_URL,
      apiKey,
    );
    expect(activity[`orgProjectClaim:${PROJECT_ID}`]).toBe(1);
    expect(activity[`orgProjectComplete:${PROJECT_ID}`] ?? 0).toBe(0);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

for (const change of [
  'removed',
  'unlisted',
  'unusable',
  'bound-failure',
  'offline',
  'access-changed',
  'not-local',
]) {
  test(`setup dialog follows live catalog and workspace state: ${change}`, async () => {
    test.setTimeout(120_000);
    const apiKey = `csk_can2956_live_${change}`;
    const userDataDir = realpathSync(
      mkdtempSync(path.join(os.tmpdir(), 'canopy-can2956-live-')),
    );
    const { destination } = seedLocalRepository(userDataDir);
    await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
      cloud: {
        organizations: ORG_CONTEXT_ORGANIZATIONS,
        orgProjects: {
          [`org:${ORG_CONTEXT_A}`]: [
            {
              ...catalogProject(),
              // Binding follows a successful claim. Without this instance the
              // fixture describes a completed bound workspace, whose placeholder
              // is correctly hidden; the earlier assertion only won a reload race.
              ...(change === 'bound-failure'
                ? { instance: { id: 'bound-instance', state: 'CLAIMED' } }
                : {}),
            },
          ],
        },
      },
    });
    let electronApp;
    try {
      ({ electronApp } = await launchCanopy({
        userDataDir,
        env: ORG_CONTEXT_ENV,
      }));
      const { window } = await openSetup(
        electronApp,
        apiKey,
        destination,
        false,
      );
      if (change === 'bound-failure') {
        const localProjects = await window.evaluate(() =>
          window.api.loadProjects(),
        );
        await electronApp.evaluate(
          (
            { ipcMain, BrowserWindow },
            { localProjects, projectId, organizationId },
          ) => {
            // Model the coordinator's disk binding before its terminal event,
            // without weakening or bypassing any production setup guard.
            ipcMain.removeHandler('projects:load');
            ipcMain.handle('projects:load', () => ({
              ...localProjects,
              items: [
                ...localProjects.items,
                {
                  id: 'bound-setup',
                  name: 'Bound setup',
                  type: 'single-repo',
                  repoPath: '/fixture/bound',
                  color: '',
                  collapsed: false,
                  order: 99,
                  worktrees: [],
                  owner: {
                    type: 'organization',
                    organizationId,
                    projectId,
                    instanceId: 'bound-instance',
                    bindingGeneration: 1,
                  },
                },
              ],
            }));
          },
          {
            localProjects,
            projectId: PROJECT_ID,
            organizationId: ORG_CONTEXT_A,
          },
        );
        // Drain any reload already in flight before announcing the failure.
        // The renderer reloads projects once per terminal progress event, so a
        // load that started before the handler swap would resolve with the old
        // list and nothing would ask again.
        await window.evaluate(() => window.api.loadProjects());
        await electronApp.evaluate(
          ({ BrowserWindow }, { projectId }) => {
            for (const win of BrowserWindow.getAllWindows())
              win.webContents.send('org-projects:setup-progress', {
                projectId,
                instanceId: 'bound-instance',
                state: 'failed',
                errorCode: 'access-removed',
                message: 'Setup did not finish',
                percent: null,
                updatedAt: new Date().toISOString(),
              });
          },
          { projectId: PROJECT_ID },
        );
        await expect(
          window.getByTestId(`sidebar-org-project-placeholder-${PROJECT_ID}`),
        ).toContainText('Setup did not finish');
        await expect(window.getByTestId('org-project-setup-start')).toHaveCount(
          0,
        );
        await expect(
          window.getByTestId(`sidebar-org-project-retry-${PROJECT_ID}`),
        ).toHaveCount(0);
      } else {
        const project = catalogProject();
        const snapshot = {
          context: `org:${ORG_CONTEXT_A}`,
          revision: 'r2',
          fetchedAt: new Date().toISOString(),
          stale: false,
          error: ['offline', 'access-changed'].includes(change) ? change : null,
          projects:
            change === 'removed'
              ? []
              : [
                  {
                    ...project,
                    listed: change !== 'unlisted',
                    location:
                      change === 'not-local' ? 'CLOUD' : project.location,
                    capabilities: {
                      ...project.capabilities,
                      use: change !== 'unusable',
                    },
                  },
                ],
        };
        await electronApp.evaluate(({ BrowserWindow }, snapshot) => {
          for (const win of BrowserWindow.getAllWindows())
            win.webContents.send('org-projects:changed', snapshot);
        }, snapshot);
        if (['offline', 'access-changed', 'not-local'].includes(change)) {
          const reason = {
            offline: 'Offline',
            'access-changed': 'Access changed',
            'not-local': 'Runs in the cloud',
          }[change];
          await expect(
            window.getByTestId('org-project-setup-dialog'),
          ).toContainText(reason);
          await expect(
            window.getByTestId('org-project-setup-start'),
          ).toHaveCount(0);
          await window.getByTestId('org-project-setup-cancel').click();
        }
        await expect(
          window.getByTestId('org-project-setup-dialog'),
        ).toHaveCount(0);
      }
    } finally {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
      await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
    }
  });
}

for (const change of ['offline', 'unusable']) {
  test(`does not claim after eligibility becomes ${change} during the preference save`, async () => {
    test.setTimeout(120_000);
    const apiKey = `csk_can2956_pending_${change}`;
    const userDataDir = realpathSync(
      mkdtempSync(path.join(os.tmpdir(), 'canopy-can2956-pending-')),
    );
    const { destination } = seedLocalRepository(userDataDir);
    await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
      cloud: {
        organizations: ORG_CONTEXT_ORGANIZATIONS,
        orgProjects: { [`org:${ORG_CONTEXT_A}`]: [catalogProject()] },
      },
    });
    let electronApp;
    try {
      ({ electronApp } = await launchCanopy({
        userDataDir,
        env: ORG_CONTEXT_ENV,
      }));
      const { window } = await openSetup(
        electronApp,
        apiKey,
        destination,
        false,
      );
      await electronApp.evaluate(({ ipcMain }) => {
        const save = ipcMain._invokeHandlers.get('preferences:save');
        const start = ipcMain._invokeHandlers.get('org-projects:setup-start');
        if (!save || !start)
          throw new Error('Missing setup/preferences handler');
        globalThis.pendingSetupSave = { saved: false, starts: 0 };
        ipcMain.removeHandler('preferences:save');
        ipcMain.handle('preferences:save', async (event, preferences) => {
          const result = await save(event, preferences);
          globalThis.pendingSetupSave.saved = true;
          await new Promise((resolve) => {
            globalThis.pendingSetupSave.resolve = resolve;
          });
          return result;
        });
        ipcMain.removeHandler('org-projects:setup-start');
        ipcMain.handle('org-projects:setup-start', (event, request) => {
          globalThis.pendingSetupSave.starts++;
          return start(event, request);
        });
      });
      await window.getByTestId('org-project-setup-start').click();
      await expect
        .poll(() =>
          electronApp.evaluate(() => globalThis.pendingSetupSave.saved),
        )
        .toBe(true);
      const project = catalogProject();
      await electronApp.evaluate(
        ({ BrowserWindow }, snapshot) => {
          for (const win of BrowserWindow.getAllWindows())
            win.webContents.send('org-projects:changed', snapshot);
        },
        {
          context: `org:${ORG_CONTEXT_A}`,
          revision: 'r2',
          fetchedAt: new Date().toISOString(),
          stale: false,
          error: change === 'offline' ? 'offline' : null,
          projects: [
            {
              ...project,
              capabilities: {
                ...project.capabilities,
                use: change !== 'unusable',
              },
            },
          ],
        },
      );
      await expect(window.getByTestId('org-project-setup-start')).toHaveCount(
        0,
      );
      await electronApp.evaluate(() => globalThis.pendingSetupSave.resolve());
      // A subsequent round trip and renderer frame drain the saved click continuation.
      await window.evaluate(async () => {
        await window.api.loadPreferences();
        await new Promise(requestAnimationFrame);
      });
      expect(
        await electronApp.evaluate(() => globalThis.pendingSetupSave.starts),
      ).toBe(0);
      expect(
        (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, apiKey)).activity[
          `orgProjectClaim:${PROJECT_ID}`
        ] ?? 0,
      ).toBe(0);
      expect(
        JSON.parse(
          readFileSync(path.join(userDataDir, 'preferences.json'), 'utf8'),
        ).preferences.orgProjectDefaultDestinationRoot,
      ).toBe(destination);
      if (change === 'offline') {
        await expect(
          window.getByTestId('org-project-setup-dialog'),
        ).toContainText('Offline');
      } else {
        await expect(
          window.getByTestId('org-project-setup-dialog'),
        ).toHaveCount(0);
      }
    } finally {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
      await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
    }
  });
}

test('closes consent when another window starts claiming without calling onStart', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_can2956_other_window_claiming';
  const userDataDir = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), 'canopy-can2956-other-window-')),
  );
  const { destination } = seedLocalRepository(userDataDir);
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: {
      organizations: ORG_CONTEXT_ORGANIZATIONS,
      orgProjects: { [`org:${ORG_CONTEXT_A}`]: [catalogProject()] },
    },
  });
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: ORG_CONTEXT_ENV,
    }));
    const { window, row } = await openSetup(
      electronApp,
      apiKey,
      destination,
      false,
    );
    await electronApp.evaluate(({ ipcMain, BrowserWindow }, projectId) => {
      const start = ipcMain._invokeHandlers.get('org-projects:setup-start');
      if (start === undefined) throw new Error('Missing setup handler');
      globalThis.otherWindowSetupStarts = 0;
      ipcMain.removeHandler('org-projects:setup-start');
      ipcMain.handle('org-projects:setup-start', (event, request) => {
        globalThis.otherWindowSetupStarts++;
        return start(event, request);
      });
      for (const win of BrowserWindow.getAllWindows())
        win.webContents.send('org-projects:setup-progress', {
          projectId,
          instanceId: null,
          state: 'claiming',
          message: 'Claiming a setup slot',
          percent: null,
          updatedAt: new Date().toISOString(),
        });
    }, PROJECT_ID);
    await expect(
      row.getByTestId(`sidebar-org-project-cancel-${PROJECT_ID}`),
    ).toBeVisible();
    await expect(window.getByTestId('org-project-setup-dialog')).toHaveCount(0);
    expect(
      await electronApp.evaluate(() => globalThis.otherWindowSetupStarts),
    ).toBe(0);
    expect(
      (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, apiKey)).activity[
        `orgProjectClaim:${PROJECT_ID}`
      ] ?? 0,
    ).toBe(0);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

test('organization project deep link switches context and opens consent without claiming', async () => {
  const apiKey = 'csk_can2957_deep_link';
  const userDataDir = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), 'canopy-can2957-')),
  );
  seedLocalRepository(userDataDir);
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: {
      organizations: ORG_CONTEXT_ORGANIZATIONS,
      orgProjects: { [`org:${ORG_CONTEXT_A}`]: [catalogProject()] },
    },
  });
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: ORG_CONTEXT_ENV,
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, apiKey);
    await selectWorkspaceContext(window, 'personal');
    await electronApp.evaluate(({ app: nativeApp }, url) => {
      nativeApp.emit('open-url', { preventDefault() {} }, url);
    }, `canopy://org-project/${PROJECT_ID}?org=${ORG_CONTEXT_A}`);
    await expect(window.getByTestId('org-project-setup-dialog')).toBeVisible();
    await expect(window.getByTestId('org-project-setup-dialog')).toContainText(
      'acme/setup-repo',
    );
    expect(
      (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, apiKey)).activity[
        `orgProjectClaim:${PROJECT_ID}`
      ] ?? 0,
    ).toBe(0);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

for (const matches of [true, false]) {
  test(`Personal repository relationship: ${matches ? 'dismiss survives restart' : 'non-match stays private'}`, async () => {
    test.setTimeout(120_000);
    const apiKey = `csk_can2958_${matches}`;
    const userDataDir = realpathSync(
      mkdtempSync(path.join(os.tmpdir(), 'canopy-can2958-')),
    );
    const { destination } = seedLocalRepository(userDataDir);
    execFileSync(
      'git',
      [
        'remote',
        'add',
        'origin',
        `git@github.com:${matches ? 'acme' : 'fork-owner'}/setup-repo.git`,
      ],
      {
        cwd: path.join(userDataDir, 'repos', 'context-personal'),
        stdio: 'pipe',
      },
    );
    await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
      cloud: {
        organizations: ORG_CONTEXT_ORGANIZATIONS,
        orgProjects: { [`org:${ORG_CONTEXT_A}`]: [catalogProject()] },
      },
    });
    let electronApp;
    try {
      ({ electronApp } = await launchCanopy({
        userDataDir,
        env: ORG_CONTEXT_ENV,
      }));
      const { window, row } = await openSetup(
        electronApp,
        apiKey,
        destination,
        false,
        matches,
      );
      const copy = 'You already have this repository in Personal';
      const dialog = window.getByTestId('org-project-setup-dialog');
      if (matches) {
        await expect(dialog).toContainText(copy);
        await expect(row).toHaveCount(0);
        await dialog
          .getByRole('button', { name: 'Dismiss', exact: true })
          .click();
        await expect(dialog.getByText(copy, { exact: true })).toHaveCount(0);
        await expect(row.getByText(copy, { exact: true })).toHaveCount(0);
        const decisions = JSON.parse(
          readFileSync(
            path.join(userDataDir, 'org-project-links.json'),
            'utf8',
          ),
        );
        expect(decisions.version).toBe(1);
        expect(
          Object.values(decisions.byAccount).some(
            (account) =>
              account[`${PROJECT_ID}:context-personal`] === 'dismissed',
          ),
        ).toBe(true);
        await closeCanopy(electronApp, userDataDir, { keepUserData: true });
        electronApp = undefined;
        ({ electronApp } = await launchCanopy({
          userDataDir,
          env: ORG_CONTEXT_ENV,
        }));
        const restarted = await openSetup(
          electronApp,
          apiKey,
          destination,
          false,
        );
        expect(
          await restarted.window.evaluate(() =>
            window.api.orgProjects.linksList(),
          ),
        ).toEqual({ status: 'resolved', links: [] });
        await expect(
          restarted.window
            .getByTestId('org-project-setup-dialog')
            .getByText(copy, { exact: true }),
        ).toHaveCount(0);
        await expect(
          restarted.row.getByText(copy, { exact: true }),
        ).toHaveCount(0);
      } else {
        expect(
          await window.evaluate(() => window.api.orgProjects.linksList()),
        ).toEqual({ status: 'resolved', links: [] });
        await expect(dialog.getByText(copy, { exact: true })).toHaveCount(0);
        await expect(row.getByText(copy, { exact: true })).toHaveCount(0);
      }
      const { activity } = await getScenarioActivity(
        DEFAULT_MOCK_BASE_URL,
        apiKey,
      );
      expect(activity[`orgProjectClaim:${PROJECT_ID}`] ?? 0).toBe(0);
      expect(activity.orgProjectPreferencePut ?? 0).toBe(0);
    } finally {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
      await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
    }
  });
}

test('views the organization project and sets up separately without changing Personal', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_can2958_separate';
  const userDataDir = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), 'canopy-can2958-separate-')),
  );
  const { destination, cloneBase } = seedLocalRepository(userDataDir);
  const personalPath = path.join(userDataDir, 'repos', 'context-personal');
  execFileSync(
    'git',
    ['remote', 'add', 'origin', 'https://github.com/acme/setup-repo.git'],
    { cwd: personalPath, stdio: 'pipe' },
  );
  const personalBefore = JSON.parse(
    readFileSync(
      path.join(
        userDataDir,
        'workspaces',
        'context-personal',
        'workspace.json',
      ),
      'utf8',
    ),
  );
  const readmeBefore = readFileSync(
    path.join(personalPath, 'README.md'),
    'utf8',
  );
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: {
      organizations: ORG_CONTEXT_ORGANIZATIONS,
      orgProjects: { [`org:${ORG_CONTEXT_A}`]: [catalogProject()] },
    },
  });
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: { ...ORG_CONTEXT_ENV, CANOPY_E2E_ORG_PROJECT_CLONE_BASE: cloneBase },
    }));
    const { window, row } = await openSetup(
      electronApp,
      apiKey,
      destination,
      false,
      true,
    );
    await window
      .getByTestId('org-project-setup-dialog')
      .getByRole('button', { name: 'View organization project', exact: true })
      .click();
    const dialog = window.getByTestId('org-project-setup-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('acme/setup-repo');
    await dialog
      .getByRole('button', { name: 'Set up separately', exact: true })
      .click();
    await expect(
      dialog.getByText('You already have this repository in Personal', {
        exact: true,
      }),
    ).toHaveCount(0);
    await window.getByTestId('org-project-setup-start').click();
    // This linked project had no placeholder before setup either; wait for promotion.
    await expect
      .poll(
        () =>
          workspaces(userDataDir).some((entry) =>
            entry.id.startsWith('setup-repo'),
          ),
        { timeout: 30_000 },
      )
      .toBe(true);
    await expect(row).toHaveCount(0);
    const folders = readdirSync(destination);
    expect(folders).toHaveLength(1);
    expect(folders[0]).toMatch(/^setup-repo-[a-z0-9]{6}$/);
    const personalAfter = JSON.parse(
      readFileSync(
        path.join(
          userDataDir,
          'workspaces',
          'context-personal',
          'workspace.json',
        ),
        'utf8',
      ),
    );
    expect(personalAfter).toMatchObject(personalBefore);
    expect(personalAfter.owner).toBeUndefined();
    expect(
      execFileSync('git', ['remote', 'get-url', 'origin'], {
        cwd: personalPath,
        encoding: 'utf8',
      }).trim(),
    ).toBe('https://github.com/acme/setup-repo.git');
    expect(readFileSync(path.join(personalPath, 'README.md'), 'utf8')).toBe(
      readmeBefore,
    );
    expect(
      (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, apiKey)).activity[
        `orgProjectClaim:${PROJECT_ID}`
      ],
    ).toBe(1);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

test('converts a Personal project into the organization project in place, then moves it back', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_can3415_convert';
  const userDataDir = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), 'canopy-can3415-')),
  );
  const workspaceId = 'context-personal';
  const worktreeIds = ['convert-first', 'convert-second'];
  seedLocalRepository(userDataDir, { personalWorktreeIds: worktreeIds });
  const personalPath = path.join(userDataDir, 'repos', workspaceId);
  execFileSync(
    'git',
    ['remote', 'add', 'origin', 'https://github.com/acme/setup-repo.git'],
    { cwd: personalPath, stdio: 'pipe' },
  );
  const chatText = 'Plan the converted work.';
  seedWorktreeChat({
    userDataDir,
    workspaceId,
    worktreeId: worktreeIds[1],
    providerType: 'claude',
    tabs: [
      {
        id: 'convert-chat',
        title: 'Converted planning chat',
        messages: [
          {
            id: 'convert-chat-message',
            role: 'user',
            blocks: [{ type: 'text', text: chatText }],
            timestamp: Date.parse('2026-07-01T10:00:00.000Z'),
          },
        ],
      },
    ],
  });
  const configPath = path.join(
    userDataDir,
    'workspaces',
    workspaceId,
    'workspace.json',
  );
  const worktreesPath = path.join(
    userDataDir,
    'workspaces',
    workspaceId,
    'worktrees.json',
  );
  const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
  // The app enriches rows (badges, PR status); identity must not change.
  const worktreeIdentity = () =>
    readJson(worktreesPath).worktrees.map(({ id, branchName, createdAt }) => ({
      id,
      branchName,
      createdAt,
    }));
  const configBefore = readJson(configPath);
  const worktreesBefore = worktreeIdentity();
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: {
      organizations: ORG_CONTEXT_ORGANIZATIONS,
      orgProjects: { [`org:${ORG_CONTEXT_A}`]: [catalogProject()] },
    },
  });
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: ORG_CONTEXT_ENV,
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, apiKey);
    const project = window.locator(
      `[data-sidebar-workspace-id="${workspaceId}"]`,
    );
    const rows = window
      .getByTestId('worktree-row')
      .and(window.locator(`[data-project-id="${workspaceId}"]`));
    const placeholder = window.getByTestId(
      `sidebar-org-project-placeholder-${PROJECT_ID}`,
    );
    const chat = window.getByTestId('page-main').getByText(chatText, {
      exact: true,
    });
    const expectProjectWithWorktreesAndChat = async () => {
      await expect(project).toBeVisible();
      await expect(rows).toHaveCount(worktreeIds.length);
      await app.selectWorktree(worktreeIds[1]);
      await expect(chat).toBeVisible();
    };
    const convert = (request) =>
      window.evaluate(
        (value) => window.api.orgProjects.convertWorkspace(value),
        request,
      );
    const request = {
      workspaceId,
      organizationId: ORG_CONTEXT_A,
      projectId: PROJECT_ID,
    };
    const owner = () =>
      window.evaluate(
        async (id) =>
          (await window.api.loadProjects()).items.find((item) => item.id === id)
            ?.owner ?? null,
        workspaceId,
      );
    // Before conversion (and after moving back) the organization view shows
    // the checkout only as a Personal project linked to the same repository.
    const links = () =>
      window.evaluate(async () => {
        const result = await window.api.orgProjects.linksList();
        return result.status === 'resolved' ? result.links : null;
      });
    const link = { projectId: PROJECT_ID, personalWorkspaceId: workspaceId };

    await expectProjectWithWorktreesAndChat();
    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    await expect.poll(links).toContainEqual(link);
    expect(await owner()).toBeNull();
    // A checkout of another repository is refused and left alone.
    expect(
      await convert({ ...request, workspaceId: 'context-organization' }),
    ).toEqual({ ok: false, code: 'not-personal' });

    const converted = await convert(request);
    expect(converted).toMatchObject({
      ok: true,
      workspaceId,
      owner: {
        type: 'organization',
        organizationId: ORG_CONTEXT_A,
        projectId: PROJECT_ID,
      },
      ownershipTransfer: {
        version: 1,
        previousOwner: { type: 'personal' },
        organizationId: ORG_CONTEXT_A,
        projectId: PROJECT_ID,
      },
    });
    // The organization now shows the project as its own, with the same
    // worktrees and chats, and no setup offer next to it.
    expect(await owner()).toEqual(converted.owner);
    await expect.poll(links).toEqual([]);
    await expectProjectWithWorktreesAndChat();
    await expect(placeholder).toHaveCount(0);
    await selectWorkspaceContext(window, 'personal');
    await expect(project).toHaveCount(0);

    // Only ownership changed on disk.
    const configConverted = readJson(configPath);
    expect(configConverted).toMatchObject({
      ...configBefore,
      owner: converted.owner,
      ownershipTransfer: converted.ownershipTransfer,
    });
    expect(worktreeIdentity()).toEqual(worktreesBefore);
    expect(workspaces(userDataDir).map((entry) => entry.id)).toContain(
      workspaceId,
    );
    let { activity } = await getScenarioActivity(DEFAULT_MOCK_BASE_URL, apiKey);
    expect(activity[`orgProjectClaim:${PROJECT_ID}`]).toBe(1);
    expect(activity[`orgProjectComplete:${PROJECT_ID}`]).toBe(1);
    // CAN-3418: the completed conversion asks the server to move this
    // checkout's already-uploaded Personal activity to the organization.
    expect(activity.orgProjectActivityMove).toBe(1);
    expect(
      activity[`orgProjectActivityMove:${PROJECT_ID}:${workspaceId}`],
    ).toBe(1);
    expect(activity.orgProjectActivityReturn).toBeUndefined();

    const movedBack = await window.evaluate(
      (value) => window.api.orgProjects.moveBackToPersonal(value),
      { workspaceId },
    );
    expect(movedBack).toMatchObject({
      ok: true,
      workspaceId,
      ownershipTransfer: {
        ...converted.ownershipTransfer,
        movedBackAt: expect.any(String),
      },
    });
    expect(await owner()).toBeNull();
    await expectProjectWithWorktreesAndChat();
    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    await expect.poll(links).toContainEqual(link);
    await expect(placeholder).toHaveCount(0);

    const configMovedBack = readJson(configPath);
    expect(configMovedBack.owner).toBeUndefined();
    expect(configMovedBack.ownershipTransfer).toEqual(
      movedBack.ownershipTransfer,
    );
    expect(configMovedBack).toMatchObject({ repoPath: configBefore.repoPath });
    expect(worktreeIdentity()).toEqual(worktreesBefore);
    ({ activity } = await getScenarioActivity(DEFAULT_MOCK_BASE_URL, apiKey));
    expect(activity[`orgProjectDetach:${PROJECT_ID}`]).toBe(1);
    // Moving back returns the activity to Personal.
    expect(activity.orgProjectActivityReturn).toBe(1);
    expect(
      activity[`orgProjectActivityReturn:${PROJECT_ID}:${workspaceId}`],
    ).toBe(1);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

test('shows a converted project only under its organization, and only in Personal after moving it back', async () => {
  test.setTimeout(150_000);
  const apiKey = 'csk_can3417_org_only';
  const userDataDir = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), 'canopy-can3417-')),
  );
  const workspaceId = 'context-personal';
  const worktreeIds = ['org-only-first', 'org-only-second'];
  seedLocalRepository(userDataDir, { personalWorktreeIds: worktreeIds });
  execFileSync(
    'git',
    ['remote', 'add', 'origin', 'https://github.com/acme/setup-repo.git'],
    { cwd: path.join(userDataDir, 'repos', workspaceId), stdio: 'pipe' },
  );
  const chatText = 'Review the organization rollout.';
  seedWorktreeChat({
    userDataDir,
    workspaceId,
    worktreeId: worktreeIds[1],
    providerType: 'claude',
    tabs: [
      {
        id: 'org-only-chat',
        title: 'Organization rollout chat',
        messages: [
          {
            id: 'org-only-chat-message',
            role: 'user',
            blocks: [{ type: 'text', text: chatText }],
            timestamp: Date.parse('2026-07-01T10:00:00.000Z'),
          },
        ],
      },
    ],
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: {
      organizations: ORG_CONTEXT_ORGANIZATIONS,
      orgProjects: { [`org:${ORG_CONTEXT_A}`]: [catalogProject()] },
    },
  });
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: ORG_CONTEXT_ENV,
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, apiKey);
    const header = window.getByTestId(`sidebar-project-header-${workspaceId}`);
    const rows = window
      .getByTestId('worktree-row')
      .and(window.locator(`[data-project-id="${workspaceId}"]`));
    const placeholder = window.getByTestId(
      `sidebar-org-project-placeholder-${PROJECT_ID}`,
    );
    const chat = window.getByTestId('page-main').getByText(chatText, {
      exact: true,
    });
    const owner = () =>
      window.evaluate(
        async (id) =>
          (await window.api.loadProjects()).items.find((item) => item.id === id)
            ?.owner ?? null,
        workspaceId,
      );
    // The portal scopes projects by the owner in this desktop snapshot.
    const snapshotOwner = () =>
      window.evaluate(
        async (id) =>
          (await window.api.getDesktopSessionSnapshot({})).workspaces.find(
            (workspace) => workspace.localId === id,
          )?.owner ?? null,
        workspaceId,
      );
    const links = () =>
      window.evaluate(async () => {
        const result = await window.api.orgProjects.linksList();
        return result.status === 'resolved' ? result.links : null;
      });
    const expectShownWithWorktreesAndChat = async () => {
      // One project row: never a second copy next to it.
      await expect(header).toHaveCount(1);
      await expect(header).toBeVisible();
      await expect(rows).toHaveCount(worktreeIds.length);
      await app.selectWorktree(worktreeIds[1]);
      await expect(chat).toBeVisible();
    };
    const expectHidden = async () => {
      await expect(header).toHaveCount(0);
      await expect(rows).toHaveCount(0);
    };
    const organizationOwner = {
      type: 'organization',
      organizationId: ORG_CONTEXT_A,
      projectId: PROJECT_ID,
    };

    await expectShownWithWorktreesAndChat();
    const converted = await window.evaluate(
      (value) => window.api.orgProjects.convertWorkspace(value),
      { workspaceId, organizationId: ORG_CONTEXT_A, projectId: PROJECT_ID },
    );
    expect(converted).toMatchObject({ ok: true, owner: organizationOwner });
    await expect.poll(owner).toMatchObject(organizationOwner);
    await expect.poll(snapshotOwner).toEqual(organizationOwner);

    // Switch back and forth: the project, its worktrees and its chat live in
    // the organization only.
    for (let pass = 0; pass < 2; pass += 1) {
      await selectWorkspaceContext(window, 'personal');
      await expectHidden();
      await selectWorkspaceContext(window, ORG_CONTEXT_A);
      await expectShownWithWorktreesAndChat();
      // Not also offered as a linked Personal checkout or a setup row.
      await expect.poll(links).toEqual([]);
      await expect(placeholder).toHaveCount(0);
    }

    const movedBack = await window.evaluate(
      (value) => window.api.orgProjects.moveBackToPersonal(value),
      { workspaceId },
    );
    expect(movedBack).toMatchObject({ ok: true, workspaceId });
    await expect.poll(owner).toBeNull();
    await expect.poll(snapshotOwner).toBeNull();

    // Moving back reverses the conversion: Personal owns the project again,
    // and the organization is back to the same-repository link (CAN-2958)
    // it showed before the conversion, never the organization's own project.
    for (let pass = 0; pass < 2; pass += 1) {
      await selectWorkspaceContext(window, 'personal');
      await expectShownWithWorktreesAndChat();
      await selectWorkspaceContext(window, ORG_CONTEXT_A);
      await expect
        .poll(links)
        .toEqual([{ projectId: PROJECT_ID, personalWorkspaceId: workspaceId }]);
      await expect(header).toHaveCount(1);
      await expect(placeholder).toHaveCount(0);
    }
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});
// CAN-3416: automatic conversion. ORG_CONTEXT_ENV keeps it off for the manual
// flows above; these launches turn it back on.
const AUTO_CONVERT_ENV = {
  ...ORG_CONTEXT_ENV,
  CANOPY_E2E_ORG_PROJECT_AUTO_CONVERT: 'on',
};

test('converts only the kept empty temporary combination and preserves its scoped row across reload', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_can3759_kept_combinations';
  const userDataDir = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), 'canopy-can3759-')),
  );
  seedOrgContextScoping(userDataDir);
  const configPaths = seedEmptyTemporaryCombinations(userDataDir);
  const readConfig = (id) => JSON.parse(readFileSync(configPaths[id], 'utf8'));
  const before = {
    [KEPT_COMBINATION]: readConfig(KEPT_COMBINATION),
    [DISPOSABLE_COMBINATION]: readConfig(DISPOSABLE_COMBINATION),
  };
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: {
      organizations: ORG_CONTEXT_ORGANIZATIONS,
      orgProjects: { [`org:${ORG_CONTEXT_A}`]: [catalogProject()] },
    },
  });
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: AUTO_CONVERT_ENV,
    }));
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, apiKey);
    // The owning organization's ledger is the durable completion signal.
    // Org B's empty catalog intentionally holds its unrelated pass open.
    await expect
      .poll(
        () => {
          const ledgerPath = path.join(
            userDataDir,
            'org-project-migration-passes.json',
          );
          if (!existsSync(ledgerPath)) return false;
          const { organizations } = JSON.parse(
            readFileSync(ledgerPath, 'utf8'),
          );
          return Boolean(organizations[ORG_CONTEXT_A]?.completedAt);
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    await expect(
      window.locator(`[data-sidebar-workspace-id="${KEPT_COMBINATION}"]`),
    ).toBeVisible();
    await expect
      .poll(() => autoConversionDiagnostics(userDataDir), { timeout: 30_000 })
      .toContainEqual({
        workspaceId: KEPT_COMBINATION,
        outcome: 'converted',
        reason: null,
      });
    expect(
      autoConversionDiagnostics(userDataDir).filter(
        (event) => event.workspaceId === DISPOSABLE_COMBINATION,
      ),
    ).toEqual([]);
    expect(readConfig(KEPT_COMBINATION)).toMatchObject({
      ...before[KEPT_COMBINATION],
      owner: { type: 'organization', organizationId: ORG_CONTEXT_A },
    });
    expect(readConfig(DISPOSABLE_COMBINATION)).toEqual(
      before[DISPOSABLE_COMBINATION],
    );
    const keptOwner = readConfig(KEPT_COMBINATION).owner;
    const assertRows = async () => {
      await selectWorkspaceContext(window, ORG_CONTEXT_A);
      await expect(
        window.locator(`[data-sidebar-workspace-id="${KEPT_COMBINATION}"]`),
      ).toBeVisible();
      await expect(
        window.locator(
          `[data-sidebar-workspace-id="${DISPOSABLE_COMBINATION}"]`,
        ),
      ).toHaveCount(0);
      await selectWorkspaceContext(window, 'personal');
      for (const id of [KEPT_COMBINATION, DISPOSABLE_COMBINATION]) {
        await expect(
          window.locator(`[data-sidebar-workspace-id="${id}"]`),
        ).toHaveCount(0);
      }
    };
    await assertRows();
    await window.reload();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    await assertRows();
    expect(readConfig(KEPT_COMBINATION).owner).toEqual(keptOwner);
    expect(readConfig(KEPT_COMBINATION).temporary).toBe(true);
    expect(readConfig(DISPOSABLE_COMBINATION).temporary).toBe(true);
    expect(readConfig(DISPOSABLE_COMBINATION).owner).toBeUndefined();
    const { activity } = await getScenarioActivity(
      DEFAULT_MOCK_BASE_URL,
      apiKey,
    );
    expect(activity.orgMemberMultiRepoCreate).toBe(1);
    expect(activity[`orgProjectClaim:${keptOwner.projectId}`]).toBe(1);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});
const MOVED_BACK_WORKSPACE = 'moved-back-personal';
const MOVED_BACK_PROJECT_ID = '33333333-3333-4333-8333-333333333334';

function movedBackCatalogProject() {
  const project = catalogProject();
  return {
    ...project,
    id: MOVED_BACK_PROJECT_ID,
    name: 'Moved back project',
    repository: {
      ...project.repository,
      name: 'moved-repo',
      providerRepoId: '2',
    },
  };
}

/**
 * A Personal checkout that was converted once and moved back to Personal:
 * its `workspace.json` carries `ownershipTransfer.movedBackAt`.
 */
function seedMovedBackWorkspace(userDataDir) {
  const repoPath = path.join(userDataDir, 'repos', MOVED_BACK_WORKSPACE);
  mkdirSync(repoPath, { recursive: true });
  writeFileSync(path.join(repoPath, 'README.md'), 'Moved back fixture\n');
  for (const args of [
    ['init', '--initial-branch=main'],
    ['add', 'README.md'],
    [
      '-c',
      'user.name=Canopy Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-m',
      'initial',
    ],
    ['remote', 'add', 'origin', 'https://github.com/acme/moved-repo.git'],
  ])
    execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' });
  const workspaceDir = path.join(
    userDataDir,
    'workspaces',
    MOVED_BACK_WORKSPACE,
  );
  mkdirSync(workspaceDir, { recursive: true });
  const config = {
    version: 1,
    type: 'single-repo',
    repoPath,
    repos: [],
    alwaysShow: true,
    ownershipTransfer: {
      version: 1,
      previousOwner: { type: 'personal' },
      organizationId: ORG_CONTEXT_A,
      projectId: MOVED_BACK_PROJECT_ID,
      convertedAt: '2026-09-01T10:00:00.000Z',
      movedBackAt: '2026-09-02T10:00:00.000Z',
    },
  };
  writeFileSync(
    path.join(workspaceDir, 'workspace.json'),
    `${JSON.stringify(config, null, 2)}\n`,
  );
  writeFileSync(
    path.join(workspaceDir, 'worktrees.json'),
    `${JSON.stringify({ version: 1, worktrees: [] }, null, 2)}\n`,
  );
  const indexPath = path.join(userDataDir, 'workspaces', 'index.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  index.workspaces.push({
    id: MOVED_BACK_WORKSPACE,
    name: 'Moved back repository',
    type: 'single-repo',
    color: '#7C9B6D',
    collapsed: false,
    order: index.workspaces.length,
  });
  writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  return path.join(workspaceDir, 'workspace.json');
}

function seedAutoConversion(userDataDir) {
  seedLocalRepository(userDataDir);
  execFileSync(
    'git',
    ['remote', 'add', 'origin', 'https://github.com/acme/setup-repo.git'],
    {
      cwd: path.join(userDataDir, 'repos', 'context-personal'),
      stdio: 'pipe',
    },
  );
  const movedBackConfigPath = seedMovedBackWorkspace(userDataDir);
  return {
    personalConfigPath: path.join(
      userDataDir,
      'workspaces',
      'context-personal',
      'workspace.json',
    ),
    movedBackConfigPath,
  };
}

test('converts a matching Personal project automatically after launch, and leaves a moved-back one Personal', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_can3416_auto_convert';
  const userDataDir = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), 'canopy-can3416-')),
  );
  const { personalConfigPath, movedBackConfigPath } =
    seedAutoConversion(userDataDir);
  const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
  const personalBefore = readJson(personalConfigPath);
  const movedBackBefore = readJson(movedBackConfigPath);
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: {
      organizations: ORG_CONTEXT_ORGANIZATIONS,
      orgProjects: {
        [`org:${ORG_CONTEXT_A}`]: [catalogProject(), movedBackCatalogProject()],
      },
    },
  });
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: AUTO_CONVERT_ENV,
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, apiKey);
    const owner = (workspaceId) =>
      window.evaluate(
        async (id) =>
          (await window.api.loadProjects()).items.find((item) => item.id === id)
            ?.owner ?? null,
        workspaceId,
      );

    // Nobody asks: signing in is enough for the project to become the org's.
    await expect
      .poll(() => owner('context-personal'), { timeout: 30_000 })
      .toMatchObject({
        type: 'organization',
        organizationId: ORG_CONTEXT_A,
        projectId: PROJECT_ID,
      });
    await expect(window.getByTestId('org-project-setup-dialog')).toHaveCount(0);

    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    await expect(
      window.locator('[data-sidebar-workspace-id="context-personal"]'),
    ).toBeVisible();
    await expect(
      window.getByTestId(`sidebar-org-project-placeholder-${PROJECT_ID}`),
    ).toHaveCount(0);
    await selectWorkspaceContext(window, 'personal');
    await expect(
      window.locator('[data-sidebar-workspace-id="context-personal"]'),
    ).toHaveCount(0);
    // The moved-back project stays Personal, with its record untouched.
    await expect(
      window.locator(`[data-sidebar-workspace-id="${MOVED_BACK_WORKSPACE}"]`),
    ).toBeVisible();
    expect(await owner(MOVED_BACK_WORKSPACE)).toBeNull();
    const movedBackAfter = readJson(movedBackConfigPath);
    expect(movedBackAfter.owner).toBeUndefined();
    expect(movedBackAfter.ownershipTransfer).toEqual(
      movedBackBefore.ownershipTransfer,
    );

    const personalAfter = readJson(personalConfigPath);
    expect(personalAfter).toMatchObject({
      ...personalBefore,
      owner: { type: 'organization', projectId: PROJECT_ID },
      ownershipTransfer: {
        version: 1,
        previousOwner: { type: 'personal' },
        organizationId: ORG_CONTEXT_A,
        projectId: PROJECT_ID,
      },
    });
    expect(personalAfter.ownershipTransfer.movedBackAt).toBeUndefined();
    const { activity } = await getScenarioActivity(
      DEFAULT_MOCK_BASE_URL,
      apiKey,
    );
    // Exactly one claim: the moved-back project was never claimed.
    expect(activity[`orgProjectClaim:${PROJECT_ID}`]).toBe(1);
    expect(activity[`orgProjectComplete:${PROJECT_ID}`]).toBe(1);
    expect(
      activity[`orgProjectClaim:${MOVED_BACK_PROJECT_ID}`],
    ).toBeUndefined();
    await expect
      .poll(() => autoConversionDiagnostics(userDataDir), { timeout: 30_000 })
      .toEqual(
        expect.arrayContaining([
          {
            workspaceId: 'context-personal',
            outcome: 'converted',
            reason: null,
          },
          {
            workspaceId: MOVED_BACK_WORKSPACE,
            outcome: 'skipped',
            reason: 'moved-back',
          },
        ]),
      );
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

test('converts nothing with the organization-projects flag off', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_can3416_flag_off';
  const userDataDir = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), 'canopy-can3416-off-')),
  );
  const { personalConfigPath, movedBackConfigPath } =
    seedAutoConversion(userDataDir);
  const ownership = (file) => {
    const { owner, ownershipTransfer } = JSON.parse(readFileSync(file, 'utf8'));
    return {
      owner: owner ?? null,
      ownershipTransfer: ownershipTransfer ?? null,
    };
  };
  const personalBefore = ownership(personalConfigPath);
  const movedBackBefore = ownership(movedBackConfigPath);
  expect(personalBefore).toEqual({ owner: null, ownershipTransfer: null });
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: {
      organizations: ORG_CONTEXT_ORGANIZATIONS,
      orgProjects: {
        [`org:${ORG_CONTEXT_A}`]: [catalogProject(), movedBackCatalogProject()],
      },
    },
  });
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: {
        ...AUTO_CONVERT_ENV,
        CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
          'canopy-shared-org-projects-enabled': false,
        }),
      },
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, apiKey);
    await expect(
      window.locator('[data-sidebar-workspace-id="context-personal"]'),
    ).toBeVisible();
    // Well past the first run's startup delay and a trigger's debounce: with
    // the flag off nothing is scheduled, so nothing ever claims.
    await window.waitForTimeout(10_000);
    expect(
      await catalogClaims(apiKey, [PROJECT_ID, MOVED_BACK_PROJECT_ID]),
    ).toBe(0);
    expect(ownership(personalConfigPath)).toEqual(personalBefore);
    expect(ownership(movedBackConfigPath)).toEqual(movedBackBefore);
    expect(autoConversionDiagnostics(userDataDir)).toEqual([]);
    await expect(
      window.locator('[data-sidebar-workspace-id="context-personal"]'),
    ).toBeVisible();
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

// CAN-3517: before CAN-3515 the sidebar selection chose where activity was
// uploaded. After upgrade, the startup sweep asks the server once per
// workspace to put it back: a bound workspace's private rows move to its
// organization, and a Personal workspace's rows filed in an organization
// return to the member. The member's own sharing choice decides the first.
const ORG_CONTEXT_PROJECT_ID = '33333333-3333-4333-8333-333333333333';

function seedActivityRepair(userDataDir, telemetrySharing) {
  seedOrgContextScoping(userDataDir, {
    extraPersonalWorkspaces: [{ id: 'moved-back', name: 'Moved back' }],
  });
  const movedBackConfig = path.join(
    userDataDir,
    'workspaces',
    'moved-back',
    'workspace.json',
  );
  writeFileSync(
    movedBackConfig,
    JSON.stringify({
      ...JSON.parse(readFileSync(movedBackConfig, 'utf8')),
      ownershipTransfer: {
        version: 1,
        previousOwner: { type: 'personal' },
        organizationId: ORG_CONTEXT_A,
        projectId: ORG_CONTEXT_PROJECT_ID,
        convertedAt: '2026-09-01T00:00:00.000Z',
        movedBackAt: '2026-09-02T00:00:00.000Z',
      },
    }),
  );
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    JSON.stringify({ version: 1, preferences: { telemetrySharing } }),
  );
}

/** Sign in once, then launch again as a member upgrading would. */
async function launchSignedIn(userDataDir, apiKey) {
  const first = await launchCanopy({ userDataDir, env: ORG_CONTEXT_ENV });
  try {
    const window = await first.electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, apiKey);
  } finally {
    await closeCanopy(first.electronApp, userDataDir, { keepUserData: true });
  }
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: ORG_CONTEXT_ENV,
  });
  const window = await electronApp.firstWindow();
  await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
  return { electronApp, window };
}

// The repair reads the organization's policy. An omitted policy snapshot is
// unavailable, so the repair defers until one arrives, which the mock's
// default account response never sends. Production always sends the array.
function registerActivityRepairScenario(apiKey) {
  return registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: {
      organizations: ORG_CONTEXT_ORGANIZATIONS,
      orgProjects: { [`org:${ORG_CONTEXT_A}`]: [] },
      enforcedSettings: [],
    },
  });
}

function activityRepairLedger(userDataDir) {
  const file = path.join(userDataDir, 'activity-scope-repair.json');
  if (!existsSync(file)) return {};
  const ledger = JSON.parse(readFileSync(file, 'utf8'));
  return Object.values(ledger.byAccount)[0] ?? {};
}

// CAN-3532: a Personal multi-repo project moves to the organization when
// its held repositories select exactly one member organization.
const PLATFORM_WORKSPACE = 'platform-multi';
const MIXED_WORKSPACE = 'mixed-multi';

/** A Personal multi-repo project: an optional root plus child repositories. */
function seedMultiRepoWorkspace(
  userDataDir,
  { id, name, root, repos, worktreeIds = [] },
) {
  const base = path.join(userDataDir, 'repos', id);
  const sourceRepoPath = root ? path.join(base, 'root') : undefined;
  if (root) initRepository(sourceRepoPath, root);
  const children = repos.map((repo) => {
    const repoPath = path.join(base, repo.name);
    initRepository(repoPath, repo.remote);
    return { id: repo.name, name: repo.name, repoPath };
  });
  const workspaceDir = path.join(userDataDir, 'workspaces', id);
  mkdirSync(workspaceDir, { recursive: true });
  // Each worktree is the root's worktree with a worktree of every child
  // repository inside it, as the app lays a multi-repo worktree out.
  for (const worktreeId of worktreeIds) {
    const worktreePath = path.join(workspaceDir, 'worktrees', worktreeId);
    const add = (cwd, target) =>
      execFileSync('git', ['worktree', 'add', '-b', worktreeId, target], {
        cwd,
        stdio: 'pipe',
      });
    if (sourceRepoPath) add(sourceRepoPath, worktreePath);
    for (const child of children)
      add(child.repoPath, path.join(worktreePath, child.name));
  }
  writeFileSync(
    path.join(workspaceDir, 'workspace.json'),
    `${JSON.stringify(
      {
        version: 1,
        type: 'multi-repo',
        repos: children,
        ...(sourceRepoPath ? { sourceRepoPath } : {}),
        alwaysShow: true,
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    path.join(workspaceDir, 'worktrees.json'),
    `${JSON.stringify(
      {
        version: 1,
        worktrees: worktreeIds.map((worktreeId) => ({
          id: worktreeId,
          branchName: worktreeId,
          createdAt: '2026-09-01T00:00:00.000Z',
        })),
      },
      null,
      2,
    )}\n`,
  );
  const indexPath = path.join(userDataDir, 'workspaces', 'index.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  index.workspaces.push({
    id,
    name,
    type: 'multi-repo',
    color: '#5B8DEF',
    collapsed: false,
    order: index.workspaces.length,
  });
  writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  return path.join(workspaceDir, 'workspace.json');
}

function repositoryProject(id, name, providerRepoId) {
  const project = catalogProject();
  return {
    ...project,
    id,
    name,
    repository: { ...project.repository, name, providerRepoId },
  };
}

test('moves eligible ordinary and mixed multi-repo projects to the organization on launch and moves one back', async () => {
  test.setTimeout(150_000);
  const apiKey = 'csk_can3532_multi_repo';
  const userDataDir = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), 'canopy-can3532-')),
  );
  seedLocalRepository(userDataDir);
  const worktreeId = 'platform-feature';
  const platformConfigPath = seedMultiRepoWorkspace(userDataDir, {
    id: PLATFORM_WORKSPACE,
    name: 'Platform',
    root: 'https://github.com/acme/platform-root.git',
    repos: [
      { name: 'web', remote: 'https://github.com/acme/platform-web.git' },
      { name: 'api', remote: 'git@github.com:acme/platform-api.git' },
    ],
    worktreeIds: [worktreeId],
  });
  const mixedConfigPath = seedMultiRepoWorkspace(userDataDir, {
    id: MIXED_WORKSPACE,
    name: 'Side work',
    root: 'https://github.com/someone/platform.git',
    repos: [
      { name: 'web', remote: 'https://github.com/acme/platform-web.git' },
      { name: 'notes', remote: 'https://gitlab.com/group/subgroup/notes.git' },
    ],
    worktreeIds: ['mixed-feature'],
  });
  const chatText = 'Plan the platform work.';
  seedWorktreeChat({
    userDataDir,
    workspaceId: PLATFORM_WORKSPACE,
    worktreeId,
    providerType: 'claude',
    tabs: [
      {
        id: 'platform-chat',
        title: 'Platform planning chat',
        messages: [
          {
            id: 'platform-chat-message',
            role: 'user',
            blocks: [{ type: 'text', text: chatText }],
            timestamp: Date.parse('2026-09-01T10:00:00.000Z'),
          },
        ],
      },
    ],
  });
  const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
  const platformBefore = readJson(platformConfigPath);
  const mixedBefore = readJson(mixedConfigPath);
  const catalog = [
    repositoryProject(
      '33333333-3333-4333-8333-333333333351',
      'platform-root',
      '51',
    ),
    repositoryProject(
      '33333333-3333-4333-8333-333333333352',
      'platform-web',
      '52',
    ),
    repositoryProject(
      '33333333-3333-4333-8333-333333333353',
      'platform-api',
      '53',
    ),
  ];
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: {
      organizations: ORG_CONTEXT_ORGANIZATIONS,
      orgProjects: { [`org:${ORG_CONTEXT_A}`]: catalog },
    },
  });
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: AUTO_CONVERT_ENV,
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(window, apiKey);
    const owner = (workspaceId) =>
      window.evaluate(
        async (id) =>
          (await window.api.loadProjects()).items.find((item) => item.id === id)
            ?.owner ?? null,
        workspaceId,
      );
    const platformRow = window.locator(
      `[data-sidebar-workspace-id="${PLATFORM_WORKSPACE}"]`,
    );
    const mixedRow = window.locator(
      `[data-sidebar-workspace-id="${MIXED_WORKSPACE}"]`,
    );

    // Signing in is enough: the member's own multi-repo project is created
    // for it and bound in place.
    await expect
      .poll(() => owner(PLATFORM_WORKSPACE), { timeout: 30_000 })
      .toMatchObject({ type: 'organization', organizationId: ORG_CONTEXT_A });
    const bound = await owner(PLATFORM_WORKSPACE);
    const multiProjectId = bound.projectId;
    expect(catalog.map((project) => project.id)).not.toContain(multiProjectId);
    await expect
      .poll(() => owner(MIXED_WORKSPACE), { timeout: 30_000 })
      .toMatchObject({ type: 'organization', organizationId: ORG_CONTEXT_A });
    const mixedBound = await owner(MIXED_WORKSPACE);

    // Both show only under the organization; worktrees and chats stay intact.
    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    await expect(platformRow).toBeVisible();
    await expect(mixedRow).toBeVisible();
    await expect(
      window
        .getByTestId('worktree-row')
        .and(window.locator(`[data-project-id="${PLATFORM_WORKSPACE}"]`)),
    ).toHaveCount(1);
    await app.selectWorktree(worktreeId);
    await expect(
      window.getByTestId('page-main').getByText(chatText, { exact: true }),
    ).toBeVisible();
    // The Add project catalog counts it as on this computer, offering nothing.
    await window.getByTestId('sidebar-section-code-add').focus();
    await window.getByTestId('sidebar-section-code-add').press('Enter');
    await expect(
      window.getByTestId(`add-workspace-org-catalog-added-${multiProjectId}`),
    ).toBeDisabled();
    await window.keyboard.press('Escape');
    await selectWorkspaceContext(window, 'personal');
    await expect(platformRow).toHaveCount(0);
    await expect(mixedRow).toHaveCount(0);

    // Only ownership changed on disk.
    const platformAfter = readJson(platformConfigPath);
    expect(platformAfter).toMatchObject({
      ...platformBefore,
      owner: {
        type: 'organization',
        organizationId: ORG_CONTEXT_A,
        projectId: multiProjectId,
      },
      ownershipTransfer: {
        version: 1,
        previousOwner: { type: 'personal' },
        organizationId: ORG_CONTEXT_A,
        projectId: multiProjectId,
      },
    });
    expect(readJson(mixedConfigPath)).toMatchObject({
      ...mixedBefore,
      owner: mixedBound,
      ownershipTransfer: { projectId: mixedBound.projectId },
    });
    const scenarioResponse = await fetch(
      `${DEFAULT_MOCK_BASE_URL}/__mock/state/${apiKey}`,
    );
    const { scenario } = await scenarioResponse.json();
    expect(
      scenario.cloud.orgProjects[`org:${ORG_CONTEXT_A}`].find(
        (row) => row.id === mixedBound.projectId,
      ).repositoryProjectIds,
    ).toEqual([catalog[1].id]);
    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    await app.workspaceHeaderLabel('Side work').hover();
    await app.workspaceSettingsButton('Side work').click();
    const settings = window.getByRole('dialog', { name: 'Side work' });
    await settings.getByRole('tab', { name: 'Repositories' }).click();
    await settings
      .getByText('notes', { exact: true })
      .locator('..')
      .getByRole('button', { name: 'Add to source control', exact: true })
      .click();
    await settings.getByRole('button', { name: /Default branch/ }).click();
    await window
      .getByRole('listbox')
      .getByRole('option', { name: /mixed-feature/ })
      .click();
    await settings
      .getByRole('button', { name: 'Add to worktree', exact: true })
      .click();
    await expect(settings).toBeHidden({ timeout: 30_000 });
    const manifest = readJson(
      path.join(
        userDataDir,
        'workspaces',
        MIXED_WORKSPACE,
        'worktrees',
        'mixed-feature',
        'canopy.json',
      ),
    );
    expect(manifest.repos).toContainEqual({
      id: 'notes',
      name: 'notes',
      url: 'https://gitlab.com/group/subgroup/notes.git',
    });
    expect(readJson(mixedConfigPath).owner).toEqual(mixedBound);
    await selectWorkspaceContext(window, 'personal');
    let { activity } = await getScenarioActivity(DEFAULT_MOCK_BASE_URL, apiKey);
    expect(activity.orgMemberMultiRepoCreate).toBe(2);
    expect(activity[`orgProjectClaim:${multiProjectId}`]).toBe(1);
    expect(activity[`orgProjectComplete:${multiProjectId}`]).toBe(1);
    // The startup sweep may retry the move too; the server answers a replay.
    expect(
      activity[
        `orgProjectActivityMove:${multiProjectId}:${PLATFORM_WORKSPACE}`
      ],
    ).toBeGreaterThanOrEqual(1);
    await expect
      .poll(() => autoConversionDiagnostics(userDataDir), { timeout: 30_000 })
      .toEqual(
        expect.arrayContaining([
          {
            workspaceId: PLATFORM_WORKSPACE,
            outcome: 'converted',
            reason: null,
          },
          {
            workspaceId: MIXED_WORKSPACE,
            outcome: 'converted',
            reason: null,
          },
        ]),
      );

    // Moving back works the same way it does for one repository.
    const movedBack = await window.evaluate(
      (value) => window.api.orgProjects.moveBackToPersonal(value),
      { workspaceId: PLATFORM_WORKSPACE },
    );
    expect(movedBack).toMatchObject({
      ok: true,
      workspaceId: PLATFORM_WORKSPACE,
      ownershipTransfer: { movedBackAt: expect.any(String) },
    });
    expect(await owner(PLATFORM_WORKSPACE)).toBeNull();
    await expect(platformRow).toBeVisible();
    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    await expect(platformRow).toHaveCount(0);
    const platformMovedBack = readJson(platformConfigPath);
    expect(platformMovedBack.owner).toBeUndefined();
    expect(platformMovedBack.ownershipTransfer).toEqual(
      movedBack.ownershipTransfer,
    );
    ({ activity } = await getScenarioActivity(DEFAULT_MOCK_BASE_URL, apiKey));
    expect(activity[`orgProjectDetach:${multiProjectId}`]).toBe(1);
    expect(
      activity[
        `orgProjectActivityReturn:${multiProjectId}:${PLATFORM_WORKSPACE}`
      ],
    ).toBe(1);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

test('repairs activity filed under the wrong scope once after upgrade', async () => {
  test.setTimeout(240_000);
  const apiKey = 'csk_can3517_repair';
  const userDataDir = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), 'canopy-can3517-')),
  );
  seedActivityRepair(userDataDir, {
    metadata: 'organization',
    transcripts: 'organization',
    plans: 'private',
    summaries: 'off',
  });
  await registerActivityRepairScenario(apiKey);
  let electronApp;
  try {
    ({ electronApp } = await launchSignedIn(userDataDir, apiKey));
    const activity = async () =>
      (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, apiKey)).activity;
    // The organization's checkout moves its private rows there, withholding
    // the kinds the member does not share with the organization.
    await expect
      .poll(
        async () =>
          (await activity())[
            `orgProjectActivityMove:${ORG_CONTEXT_PROJECT_ID}:context-organization:withheld=plans,summaries`
          ],
        { timeout: 60_000 },
      )
      .toBe(1);
    // Personal work, Cowork included, returns from any organization.
    await expect
      .poll(
        async () => {
          const current = await activity();
          return [
            current['orgPersonalActivityReturn:context-personal'],
            current['orgPersonalActivityReturn:cowork-default'],
          ];
        },
        { timeout: 60_000 },
      )
      .toEqual([1, 1]);
    const afterUpgrade = await activity();
    // A project moved back to Personal is never touched.
    expect(
      afterUpgrade['orgPersonalActivityReturn:moved-back'],
    ).toBeUndefined();
    await expect
      .poll(() => activityRepairLedger(userDataDir), { timeout: 30_000 })
      .toMatchObject({
        'context-organization': {
          target: `organization:${ORG_CONTEXT_A}:${ORG_CONTEXT_PROJECT_ID}`,
          outcome: 'nothing-to-move',
        },
        'context-personal': {
          target: 'personal',
          outcome: 'nothing-to-return',
        },
        'cowork-default': { target: 'personal', outcome: 'nothing-to-return' },
      });

    // Once per workspace: the next launch asks for nothing again.
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    electronApp = undefined;
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: ORG_CONTEXT_ENV,
    }));
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    await window.waitForTimeout(8_000);
    const relaunched = await activity();
    for (const key of ['orgProjectActivityMove', 'orgPersonalActivityReturn']) {
      expect(relaunched[key]).toBe(afterUpgrade[key]);
    }
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

test('keeps a Just me member organization work private', async () => {
  test.setTimeout(180_000);
  const apiKey = 'csk_can3517_just_me';
  const userDataDir = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), 'canopy-can3517-private-')),
  );
  seedActivityRepair(userDataDir, {
    metadata: 'private',
    transcripts: 'private',
    plans: 'private',
    summaries: 'private',
  });
  await registerActivityRepairScenario(apiKey);
  let electronApp;
  try {
    ({ electronApp } = await launchSignedIn(userDataDir, apiKey));
    await expect
      .poll(() => activityRepairLedger(userDataDir)['context-organization'], {
        timeout: 60_000,
      })
      .toMatchObject({ outcome: 'kept-private' });
    const { activity } = await getScenarioActivity(
      DEFAULT_MOCK_BASE_URL,
      apiKey,
    );
    expect(activity.orgProjectActivityMove).toBeUndefined();
    // Personal work filed in an organization still returns to the member.
    expect(activity['orgPersonalActivityReturn:context-personal']).toBe(1);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

// CAN-3129: a claim whose 15-minute lease lapsed before the completion
// landed. The mock answers the completion with the server's 409 `conflict`
// for both a lapsed lease and a supersede, exactly like the real server, so
// only the reclaim can tell them apart.
async function addFromCatalog(electronApp, apiKey) {
  const window = await electronApp.firstWindow();
  await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
  await connectMockCloudAccount(window, apiKey);
  await selectWorkspaceContext(window, ORG_CONTEXT_A);
  await window.getByTestId('sidebar-section-code-add').focus();
  await window.getByTestId('sidebar-section-code-add').press('Enter');
  await window
    .getByTestId(`add-workspace-org-catalog-add-${PROJECT_ID}`)
    .click();
  await expect(window.getByTestId('add-workspace-modal')).toHaveCount(0);
  return window;
}

function unlistedCatalogProject() {
  return { ...catalogProject(), defaultListed: false, listed: false };
}

async function mockInstance(apiKey) {
  const response = await fetch(
    `${DEFAULT_MOCK_BASE_URL}/__mock/state/${encodeURIComponent(apiKey)}`,
  );
  const { scenario } = await response.json();
  return scenario.cloud.orgProjects[`org:${ORG_CONTEXT_A}`].find(
    (row) => row.id === PROJECT_ID,
  ).instance;
}

function setupJournals(userDataDir) {
  const dir = path.join(userDataDir, 'org-project-setups');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json') && file !== 'attempt-nonces.json')
    .map((file) => JSON.parse(readFileSync(path.join(dir, file), 'utf8')));
}

async function expectLapsedRow(window, apiKey) {
  const row = window.getByTestId(
    `sidebar-org-project-placeholder-${PROJECT_ID}`,
  );
  await expect(row).toContainText(
    'Your files are ready, but setup lost its place in the queue before it finished',
    { timeout: 30_000 },
  );
  await expect(
    window.getByTestId(`sidebar-org-project-retry-${PROJECT_ID}`),
  ).toBeVisible();
  const { activity } = await getScenarioActivity(DEFAULT_MOCK_BASE_URL, apiKey);
  expect(activity[`orgProjectClaim:${PROJECT_ID}`]).toBe(1);
  expect(activity[`orgProjectComplete:${PROJECT_ID}`]).toBe(1);
  // The instance is still this checkout's: nothing was handed back.
  expect(activity[`orgProjectDetach:${PROJECT_ID}`] ?? 0).toBe(0);
  return row;
}

test('Retry reclaims a lapsed claim and finishes the setup without cloning again (CAN-3129)', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_can3129_reclaim_retry';
  const userDataDir = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), 'canopy-can3129-retry-')),
  );
  const { cloneBase, destination } = seedLocalRepository(userDataDir);
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: {
      organizations: ORG_CONTEXT_ORGANIZATIONS,
      orgProjects: { [`org:${ORG_CONTEXT_A}`]: [unlistedCatalogProject()] },
      orgProjectClaimLapses: 1,
    },
  });
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: { ...ORG_CONTEXT_ENV, CANOPY_E2E_ORG_PROJECT_CLONE_BASE: cloneBase },
    }));
    const window = await addFromCatalog(electronApp, apiKey);
    const row = await expectLapsedRow(window, apiKey);
    const [lapsed] = setupJournals(userDataDir);
    expect(lapsed).toMatchObject({
      phase: 'reclaiming',
      errorCode: 'claim-expired',
      fencingGeneration: 1,
    });

    await window.getByTestId(`sidebar-org-project-retry-${PROJECT_ID}`).click();
    await expect(row).toHaveCount(0, { timeout: 30_000 });
    const workspace = workspaces(userDataDir).find((entry) =>
      entry.id.startsWith('setup-repo'),
    );
    await expect(
      window.getByTestId(`sidebar-project-header-${workspace.id}`),
    ).toBeVisible();
    const { activity } = await getScenarioActivity(
      DEFAULT_MOCK_BASE_URL,
      apiKey,
    );
    expect(activity[`orgProjectReclaim:${PROJECT_ID}`]).toBe(1);
    expect(activity[`orgProjectComplete:${PROJECT_ID}`]).toBe(2);
    expect(activity[`orgProjectDetach:${PROJECT_ID}`] ?? 0).toBe(0);
    // Same instance, a fresh fence, completed; the same workspace id the
    // claim carried; one checkout, never cloned twice.
    const instance = await mockInstance(apiKey);
    expect(instance).toMatchObject({
      state: 'READY',
      fencingGeneration: 2,
      localWorkspaceId: workspace.id,
    });
    const config = workspaceConfigs(userDataDir).find(
      (entry) => entry.id === workspace.id,
    );
    expect(config.owner).toMatchObject({
      type: 'organization',
      projectId: PROJECT_ID,
      instanceId: instance.id,
      bindingGeneration: 2,
    });
    expect(readdirSync(destination)).toEqual(['setup-repo']);
    expect(setupJournals(userDataDir)).toEqual([]);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

test('Retry fails with the server answer when the setup was superseded, and takes nothing back (CAN-3129)', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_can3129_reclaim_superseded';
  const userDataDir = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), 'canopy-can3129-superseded-')),
  );
  const { cloneBase, destination } = seedLocalRepository(userDataDir);
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: {
      organizations: ORG_CONTEXT_ORGANIZATIONS,
      orgProjects: { [`org:${ORG_CONTEXT_A}`]: [unlistedCatalogProject()] },
      orgProjectSupersedeOnComplete: true,
    },
  });
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: { ...ORG_CONTEXT_ENV, CANOPY_E2E_ORG_PROJECT_CLONE_BASE: cloneBase },
    }));
    const window = await addFromCatalog(electronApp, apiKey);
    const row = await expectLapsedRow(window, apiKey);
    const before = await mockInstance(apiKey);

    await window.getByTestId(`sidebar-org-project-retry-${PROJECT_ID}`).click();
    await expect(row).toContainText(
      'A newer setup of this project superseded this attempt',
      { timeout: 30_000 },
    );
    await expect(
      window.getByTestId(`sidebar-org-project-retry-${PROJECT_ID}`),
    ).toHaveCount(0);
    const { activity } = await getScenarioActivity(
      DEFAULT_MOCK_BASE_URL,
      apiKey,
    );
    expect(activity[`orgProjectReclaim:${PROJECT_ID}`]).toBe(1);
    expect(activity[`orgProjectComplete:${PROJECT_ID}`]).toBe(1);
    expect(activity[`orgProjectDetach:${PROJECT_ID}`] ?? 0).toBe(0);
    // The newer claim is untouched: same fence, still pending.
    expect(await mockInstance(apiKey)).toMatchObject({
      state: 'CLAIMED',
      operationId: before.operationId,
      fencingGeneration: before.fencingGeneration,
    });
    // The checkout is a workspace the user can see; it stays where it is.
    const workspace = workspaces(userDataDir).find((entry) =>
      entry.id.startsWith('setup-repo'),
    );
    expect(workspace).toBeDefined();
    expect(readdirSync(destination)).toEqual(['setup-repo']);
    expect(setupJournals(userDataDir)).toEqual([
      expect.objectContaining({ phase: 'failed', errorCode: 'superseded' }),
    ]);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

test('the next launch reclaims a lapsed claim to the same outcome as Retry (CAN-3129)', async () => {
  test.setTimeout(180_000);
  const apiKey = 'csk_can3129_reclaim_relaunch';
  const userDataDir = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), 'canopy-can3129-relaunch-')),
  );
  const { cloneBase, destination } = seedLocalRepository(userDataDir);
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: {
      organizations: ORG_CONTEXT_ORGANIZATIONS,
      orgProjects: { [`org:${ORG_CONTEXT_A}`]: [unlistedCatalogProject()] },
      orgProjectClaimLapses: 1,
    },
  });
  const env = {
    ...ORG_CONTEXT_ENV,
    CANOPY_E2E_ORG_PROJECT_CLONE_BASE: cloneBase,
  };
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({ userDataDir, env }));
    await expectLapsedRow(await addFromCatalog(electronApp, apiKey), apiKey);
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    electronApp = undefined;

    ({ electronApp } = await launchCanopy({
      userDataDir,
      env,
      preserveProviderState: true,
    }));
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    await expect
      .poll(
        async () =>
          (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, apiKey)).activity[
            `orgProjectComplete:${PROJECT_ID}`
          ],
        { timeout: 30_000 },
      )
      .toBe(2);
    const { activity } = await getScenarioActivity(
      DEFAULT_MOCK_BASE_URL,
      apiKey,
    );
    expect(activity[`orgProjectReclaim:${PROJECT_ID}`]).toBe(1);
    expect(activity[`orgProjectDetach:${PROJECT_ID}`] ?? 0).toBe(0);
    expect(await mockInstance(apiKey)).toMatchObject({
      state: 'READY',
      fencingGeneration: 2,
    });
    const workspace = workspaces(userDataDir).find((entry) =>
      entry.id.startsWith('setup-repo'),
    );
    expect(
      workspaceConfigs(userDataDir).find((entry) => entry.id === workspace.id)
        .owner,
    ).toMatchObject({ bindingGeneration: 2 });
    expect(readdirSync(destination)).toEqual(['setup-repo']);
    await expect.poll(() => setupJournals(userDataDir)).toEqual([]);
    // The row follows the catalog: the instance is READY, so it is gone and
    // the workspace is an ordinary project.
    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    await expect(
      window.getByTestId(`sidebar-org-project-placeholder-${PROJECT_ID}`),
    ).toHaveCount(0);
    await expect(
      window.getByTestId(`sidebar-project-header-${workspace.id}`),
    ).toBeVisible();
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

// CAN-3130: the app exits after the checkout was promoted. The run is held
// right after its journal records the phase (the unpackaged-build pause the
// QA notes describe), then the app is closed there, which is the crash.
for (const phase of ['promoted', 'bound', 'completing']) {
  test(`the next launch finishes a setup interrupted at ${phase} without cloning again (CAN-3130)`, async () => {
    test.setTimeout(180_000);
    const apiKey = `csk_can3130_resume_${phase}`;
    const userDataDir = realpathSync(
      mkdtempSync(path.join(os.tmpdir(), `canopy-can3130-${phase}-`)),
    );
    const { cloneBase, destination, source } = seedLocalRepository(userDataDir);
    await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
      cloud: {
        organizations: ORG_CONTEXT_ORGANIZATIONS,
        orgProjects: { [`org:${ORG_CONTEXT_A}`]: [unlistedCatalogProject()] },
      },
    });
    const env = {
      ...ORG_CONTEXT_ENV,
      CANOPY_E2E_ORG_PROJECT_CLONE_BASE: cloneBase,
    };
    let electronApp;
    try {
      ({ electronApp } = await launchCanopy({
        userDataDir,
        env: { ...env, CANOPY_DEV_ORG_PROJECT_SETUP_PAUSE: `${phase}:120` },
      }));
      await addFromCatalog(electronApp, apiKey);
      await expect
        .poll(() => setupJournals(userDataDir).map((entry) => entry.phase), {
          timeout: 30_000,
        })
        .toEqual([phase]);
      const [interrupted] = setupJournals(userDataDir);
      await closeCanopy(electronApp, userDataDir, { keepUserData: true });
      electronApp = undefined;
      // What the crash left: a promoted checkout, and no completion sent.
      expect(
        existsSync(
          phase === 'promoted'
            ? interrupted.stagingPath
            : interrupted.finalPath,
        ),
      ).toBe(true);
      const before = (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, apiKey))
        .activity;
      expect(before[`orgProjectClaim:${PROJECT_ID}`]).toBe(1);
      expect(before[`orgProjectComplete:${PROJECT_ID}`] ?? 0).toBe(0);

      ({ electronApp } = await launchCanopy({
        userDataDir,
        env,
        preserveProviderState: true,
      }));
      const window = await electronApp.firstWindow();
      await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
      await expect
        .poll(
          async () =>
            (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, apiKey)).activity[
              `orgProjectComplete:${PROJECT_ID}`
            ],
          { timeout: 30_000 },
        )
        .toBe(1);
      const { activity } = await getScenarioActivity(
        DEFAULT_MOCK_BASE_URL,
        apiKey,
      );
      // Finished under the original claim: no second claim, no detach.
      expect(activity[`orgProjectClaim:${PROJECT_ID}`]).toBe(1);
      expect(activity[`orgProjectDetach:${PROJECT_ID}`] ?? 0).toBe(0);
      expect(await mockInstance(apiKey)).toMatchObject({ state: 'READY' });
      await expect.poll(() => setupJournals(userDataDir)).toEqual([]);
      // One checkout, the original one, and nothing left in staging.
      expect(readdirSync(destination)).toEqual(['setup-repo']);
      const checkout = path.join(destination, 'setup-repo');
      expect(
        execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: checkout,
          encoding: 'utf8',
        }),
      ).toBe(
        execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: source,
          encoding: 'utf8',
        }),
      );
      const workspace = workspaces(userDataDir).find((entry) =>
        entry.id.startsWith('setup-repo'),
      );
      expect(
        workspaceConfigs(userDataDir).find((entry) => entry.id === workspace.id)
          .owner,
      ).toMatchObject({
        type: 'organization',
        projectId: PROJECT_ID,
        bindingGeneration: 1,
      });
      await selectWorkspaceContext(window, ORG_CONTEXT_A);
      await expect(
        window.getByTestId(`sidebar-org-project-placeholder-${PROJECT_ID}`),
      ).toHaveCount(0);
      await expect(
        window.getByTestId(`sidebar-project-header-${workspace.id}`),
      ).toBeVisible();
    } finally {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
      await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
    }
  });
}
// Real Combine IPC, git moves and durable binding, no restart. The join is
// invoked through preload; the Add repository modal is covered by
// add-workspace-existing-worktree.spec.mjs and split-workspace.spec.mjs.
test('binds a temporary mixed combination after join and retains the binding through split, reuse and promotion', async () => {
  test.setTimeout(180_000);
  const apiKey = 'csk_mixed_combination_lifecycle';
  const userDataDir = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), 'canopy-mixed-combination-')),
  );
  seedOrgContextScoping(userDataDir, {
    personalWorktreeIds: ['notes-feature'],
    organizationWorktreeIds: ['org-feature'],
    personalRemoteUrl: 'https://github.com/someone/notes.git',
  });
  const orgRepoPath = path.join(userDataDir, 'repos', 'context-organization');
  execFileSync(
    'git',
    ['remote', 'add', 'origin', 'https://github.com/acme/setup-repo.git'],
    { cwd: orgRepoPath, stdio: 'pipe' },
  );
  const holder = {
    ...catalogProject(),
    id: '33333333-3333-4333-8333-333333333333',
  };
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: {
      organizations: ORG_CONTEXT_ORGANIZATIONS,
      orgProjects: { [`org:${ORG_CONTEXT_A}`]: [holder] },
    },
  });
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: AUTO_CONVERT_ENV,
    }));
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    const combine = (
      workspaceId,
      worktreeId,
      joinWorkspaceId,
      joinWorktreeId,
    ) =>
      window.evaluate(
        (request) => window.api.combineWorktreeWithExistingWorktree(request),
        {
          sourceWorkspaceId: workspaceId,
          sourceWorktreeId: worktreeId,
          joinWorkspaceId,
          joinWorktreeId,
          mode: 'temporary',
        },
      );
    const originalContents = new Map([
      [orgRepoPath, readFileSync(path.join(orgRepoPath, 'README.md'), 'utf8')],
      [
        path.join(userDataDir, 'repos', 'context-personal'),
        readFileSync(
          path.join(userDataDir, 'repos', 'context-personal', 'README.md'),
          'utf8',
        ),
      ],
    ]);
    // Join before the account connects. Only projects that exist when the
    // one-time migration pass starts are eligible (CAN-3589); a combination
    // created afterwards is never moved automatically.
    const combined = await combine(
      'context-organization',
      'org-feature',
      'context-personal',
      'notes-feature',
    );
    expect(combined.createdTemporaryWorkspace).toBe(true);
    // Organization B's catalog is unknown from the pass's first read.
    await electronApp.evaluate((_electron, organizationId) => {
      globalThis.healthyCatalogFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const url = new URL(
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
        );
        if (
          url.pathname.endsWith('/projects/catalog') &&
          url.searchParams.get('context') === `org:${organizationId}`
        )
          return new Response(null, { status: 503 });
        return globalThis.healthyCatalogFetch(input, init);
      };
    }, ORG_CONTEXT_B);
    await connectMockCloudAccount(window, apiKey);
    const catalogContext = {
      kind: 'organization',
      organizationId: ORG_CONTEXT_B,
    };
    const configPath = path.join(
      userDataDir,
      'workspaces',
      combined.destinationWorkspaceId,
      'workspace.json',
    );
    const readConfig = () => JSON.parse(readFileSync(configPath, 'utf8'));
    await expect
      .poll(() => autoConversionDiagnostics(userDataDir), { timeout: 30_000 })
      .toContainEqual({
        workspaceId: combined.destinationWorkspaceId,
        outcome: 'skipped',
        reason: 'catalog-unavailable',
      });
    expect(readConfig().owner).toBeUndefined();
    await electronApp.evaluate(() => {
      globalThis.fetch = globalThis.healthyCatalogFetch;
    });
    await window.evaluate(
      (context) => window.api.orgProjects.refresh({ context, force: true }),
      catalogContext,
    );
    await expect
      .poll(() => readConfig().owner ?? null, { timeout: 30_000 })
      .toMatchObject({ type: 'organization', organizationId: ORG_CONTEXT_A });
    const bound = readConfig().owner;
    const definition = async () => {
      const response = await fetch(
        `${DEFAULT_MOCK_BASE_URL}/__mock/state/${apiKey}`,
      );
      const { scenario } = await response.json();
      return scenario.cloud.orgProjects[`org:${ORG_CONTEXT_A}`].find(
        (row) => row.id === bound.projectId,
      );
    };
    expect((await definition()).repositoryProjectIds).toEqual([holder.id]);
    for (const mapping of combined.repoMappings) {
      expect(
        readFileSync(path.join(mapping.newWorktreePath, 'README.md'), 'utf8'),
      ).toBe(originalContents.get(mapping.repoPath));
    }
    const beforeCount = (
      await getScenarioActivity(DEFAULT_MOCK_BASE_URL, apiKey)
    ).activity.orgMemberMultiRepoCreate;
    const split = await window.evaluate(
      async (request) => {
        const preview =
          await window.api.previewSplitTemporaryWorkspace(request);
        const approval =
          await window.api.approveSplitTemporaryWorkspaceDestructiveAction({
            ...request,
            previewRevision: preview.previewRevision,
          });
        const done = new Promise((resolve) => {
          const unsubscribe = window.api.onWorkspaceSplitTemporaryComplete(
            (event) => {
              if (
                event.workspaceId === request.workspaceId &&
                event.worktreeId === request.worktreeId
              ) {
                unsubscribe();
                resolve(event);
              }
            },
          );
        });
        await window.api.splitTemporaryWorkspace({
          ...request,
          previewRevision: preview.previewRevision,
          destructiveApprovalToken: approval.approvalToken ?? undefined,
        });
        return done;
      },
      {
        workspaceId: combined.destinationWorkspaceId,
        worktreeId: combined.destinationWorktreeId,
        selections: {},
      },
    );
    expect(split.success).toBe(true);
    expect(readConfig().owner).toEqual(bound);
    expect(
      JSON.parse(
        readFileSync(
          path.join(path.dirname(configPath), 'worktrees.json'),
          'utf8',
        ),
      ).worktrees,
    ).toEqual([]);
    expect(workspaces(userDataDir).map((workspace) => workspace.id)).toContain(
      combined.destinationWorkspaceId,
    );
    expect((await definition()).state).toBe('ACTIVE');
    const [first, second] = split.results.filter(
      (result) => result.disposition === 'split',
    );
    const reused = await combine(
      first.destinationWorkspaceId,
      first.destinationWorktreeId,
      second.destinationWorkspaceId,
      second.destinationWorktreeId,
    );
    expect(reused.destinationWorkspaceId).toBe(combined.destinationWorkspaceId);
    expect(readConfig().owner).toEqual(bound);
    expect(
      (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, apiKey)).activity
        .orgMemberMultiRepoCreate,
    ).toBe(beforeCount);
    await window.evaluate(
      (request) => window.api.promoteTemporaryWorkspace(request),
      { workspaceId: reused.destinationWorkspaceId, name: 'Mixed platform' },
    );
    expect(readConfig().temporary).toBeUndefined();
    expect(readConfig().owner).toEqual(bound);
    expect((await definition()).id).toBe(bound.projectId);
    expect((await definition()).state).toBe('ACTIVE');
    expect(
      (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, apiKey)).activity
        .orgMemberMultiRepoCreate,
    ).toBe(beforeCount);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

test('keeps a temporary combination spanning two organizations Personal', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_cross_org_combination';
  const userDataDir = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), 'canopy-cross-org-combination-')),
  );
  seedOrgContextScoping(userDataDir, {
    personalRemoteUrl: 'https://github.com/someone/notes.git',
  });
  const orgPath = path.join(userDataDir, 'repos', 'context-organization');
  execFileSync(
    'git',
    ['remote', 'add', 'origin', 'https://github.com/acme/setup-repo.git'],
    { cwd: orgPath, stdio: 'pipe' },
  );
  const holder = {
    ...catalogProject(),
    id: '33333333-3333-4333-8333-333333333333',
  };
  const other = {
    ...catalogProject(),
    id: '33333333-3333-4333-8333-333333333332',
    organizationId: ORG_CONTEXT_ORGANIZATIONS[1].id,
    repository: {
      ...holder.repository,
      owner: 'someone',
      name: 'notes',
      providerRepoId: '2',
    },
  };
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: {
      organizations: ORG_CONTEXT_ORGANIZATIONS,
      orgProjects: {
        [`org:${ORG_CONTEXT_A}`]: [holder],
        [`org:${other.organizationId}`]: [other],
      },
    },
  });
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: AUTO_CONVERT_ENV,
    }));
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    const combined = await window.evaluate(
      (repos) => window.api.createTemporaryWorkspaceFromRepos({ repos }),
      [
        { name: 'Acme repository', path: orgPath },
        {
          name: 'Personal repository',
          path: path.join(userDataDir, 'repos', 'context-personal'),
        },
      ],
    );
    // Pin eligibility before the account starts its original migration pass.
    // An empty disposable combination now retires silently before catalog reads,
    // so use a kept combination to exercise cross-organization refusal.
    await window.evaluate(
      (projectId) =>
        window.api.saveWorkspaceDefaultPlugins({
          projectId,
          defaultPluginSelections: {
            collectionIds: [],
            skillRefs: [],
            pluginRefs: [],
          },
          alwaysShow: true,
        }),
      combined.workspace.id,
    );
    await connectMockCloudAccount(window, apiKey);
    await expect
      .poll(() => autoConversionDiagnostics(userDataDir), { timeout: 30_000 })
      .toContainEqual({
        workspaceId: combined.workspace.id,
        outcome: 'skipped',
        reason: 'repositories-span-organizations',
      });
    const config = JSON.parse(
      readFileSync(
        path.join(
          userDataDir,
          'workspaces',
          combined.workspace.id,
          'workspace.json',
        ),
        'utf8',
      ),
    );
    expect(config.temporary).toBe(true);
    expect(config.owner).toBeUndefined();
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});
