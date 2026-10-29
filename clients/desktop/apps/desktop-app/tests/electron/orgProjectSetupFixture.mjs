import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import {
  connectMockCloudAccount,
  DEFAULT_MOCK_BASE_URL,
  getScenarioActivity,
  seedOrgContextScoping,
  ORG_CONTEXT_A,
} from './seeders/index.mjs';
import { selectWorkspaceContext } from './workspaceContextMenu.mjs';

// Org project setup fixtures shared by the setup specs.

export const PROJECT_ID = '33333333-3333-4333-8333-333333333331';

export function catalogProject() {
  return {
    id: PROJECT_ID,
    organizationId: ORG_CONTEXT_A,
    name: 'Local catalog project',
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
      name: 'setup-repo',
      providerRepoId: '1',
      defaultBranch: 'main',
      verification: 'VERIFIED',
    },
    state: 'ACTIVE',
    revision: 1,
    authorizationVersion: 1,
    defaultListed: true,
    preference: 'FOLLOW_DEFAULTS',
    listed: true,
    capabilities: { administer: false, manageCloud: false, use: true },
    instance: null,
  };
}

export function seedLocalRepository(userDataDir, scopingOptions) {
  seedOrgContextScoping(userDataDir, scopingOptions);
  const source = path.join(userDataDir, 'setup-source');
  const cloneBase = path.join(userDataDir, 'bare');
  const destination = path.join(userDataDir, 'clones');
  mkdirSync(source, { recursive: true });
  mkdirSync(path.join(cloneBase, 'acme'), { recursive: true });
  mkdirSync(destination, { recursive: true });
  writeFileSync(path.join(source, 'README.md'), 'Local setup fixture\n');
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
    ['clone', '--bare', source, path.join(cloneBase, 'acme', 'setup-repo.git')],
  ])
    execFileSync('git', args, { cwd: source, stdio: 'pipe' });
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    JSON.stringify({
      version: 1,
      preferences: { orgProjectDefaultDestinationRoot: destination },
    }),
  );
  return { cloneBase, destination, source };
}

/**
 * Setup starts from the + dialog: a catalog project the member has not set up
 * is not a sidebar row (CAN-3386). The row appears only once a setup is
 * running, failed, or left unfinished. With a folder remembered, Add sets the
 * project up at once (CAN-3469), so consent here opens from the portal's
 * "Open on desktop" link. A linked Personal checkout already puts the
 * project on this computer and offers no Add; its consent carries the
 * relationship notice.
 */
export async function openSetup(
  electronApp,
  apiKey,
  destination,
  start = true,
  linkedPersonal = false,
) {
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await connectMockCloudAccount(window, apiKey);
  await selectWorkspaceContext(window, ORG_CONTEXT_A);
  const row = window.getByTestId(
    `sidebar-org-project-placeholder-${PROJECT_ID}`,
  );
  await window.getByTestId('sidebar-section-code-add').focus();
  await window.getByTestId('sidebar-section-code-add').press('Enter');
  const catalogRow = window.getByTestId(
    `add-workspace-org-catalog-row-${PROJECT_ID}`,
  );
  const add = window.getByTestId(`add-workspace-org-catalog-add-${PROJECT_ID}`);
  if (linkedPersonal) {
    await expect(
      window.getByTestId('sidebar-project-header-context-personal'),
    ).toBeVisible();
    await expect(catalogRow).toContainText('Added');
    await expect(add).toHaveCount(0);
  } else {
    await expect(add).toBeEnabled();
  }
  await expect(row).toHaveCount(0);
  await expect(
    window.getByTestId('sidebar-section-shared-projects'),
  ).toHaveCount(0);
  // Nothing is claimed until the member asks for it.
  expect(
    (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, apiKey)).activity[
      `orgProjectClaim:${PROJECT_ID}`
    ] ?? 0,
  ).toBe(0);
  await window.keyboard.press('Escape');
  await electronApp.evaluate(({ app: nativeApp }, url) => {
    nativeApp.emit('open-url', { preventDefault() {} }, url);
  }, `canopy://org-project/${PROJECT_ID}?org=${ORG_CONTEXT_A}`);
  await expect(window.getByTestId('add-workspace-modal')).toHaveCount(0);
  const dialog = window.getByTestId('org-project-setup-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('acme/setup-repo');
  await expect(dialog).toContainText('main');
  await expect(dialog).toContainText(
    'Cloned with your Git credentials. No scripts run until you open a task.',
  );
  await expect(
    window.getByTestId('org-project-setup-destination'),
  ).toContainText(destination);
  await expect(
    window.getByTestId('org-project-setup-destination'),
  ).toHaveAttribute('title', destination);
  const destinationText = window
    .getByTestId('org-project-setup-destination')
    .locator('[dir="rtl"]');
  await expect(destinationText).toHaveCSS('white-space', 'nowrap');
  await expect(destinationText).toHaveCSS('text-overflow', 'ellipsis');
  expect(
    (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, apiKey)).activity[
      `orgProjectClaim:${PROJECT_ID}`
    ] ?? 0,
  ).toBe(0);
  if (start) {
    await window.getByTestId('org-project-setup-start').click();
    await expect(dialog).toHaveCount(0, { timeout: 1_000 });
  }
  return { window, row, app };
}
