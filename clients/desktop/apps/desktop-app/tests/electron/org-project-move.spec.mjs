import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { chooseSettingsOption } from './helpers/settingsSelect.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  clearScenario,
  connectMockCloudAccount,
  DEFAULT_MOCK_BASE_URL,
  getScenarioActivity,
  registerScenario,
  seedCoworkWorkspace,
  seedOrgContextScoping,
  ORG_CONTEXT_A,
  ORG_CONTEXT_ENV,
  ORG_CONTEXT_ORGANIZATIONS,
  PERSONAL_CONTEXT_WORKSPACE,
} from './seeders/index.mjs';
import {
  expectWorkspaceContext,
  selectWorkspaceContext,
} from './workspaceContextMenu.mjs';

// Move to organization: a member moves a Personal project, with every
// worktree in it, to one of their organizations from the sidebar. The
// selected context stays Personal; the moved project shows under the
// organization.

test.describe.configure({ retries: 0 });

const SECOND_PROJECT = { id: 'move-second-project', name: 'Second project' };
const COWORK_PROJECT = { id: 'move-cowork-project', name: 'Research notes' };
const PERSONAL_NAME = 'Personal repository';

function workspaceConfig(userDataDir, workspaceId) {
  return JSON.parse(
    readFileSync(
      path.join(userDataDir, 'workspaces', workspaceId, 'workspace.json'),
      'utf8',
    ),
  );
}

function projectSection(window, workspaceId) {
  return window.locator(`[data-sidebar-workspace-id="${workspaceId}"]`);
}

function worktreeRows(window, workspaceId) {
  return projectSection(window, workspaceId).locator(
    '[data-testid="worktree-row"]',
  );
}

async function activity(apiKey) {
  return (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, apiKey)).activity;
}

/**
 * Launch in Personal with the two-organization fixture, a Personal project
 * with two worktrees and a GitHub remote, a second Personal project, and a
 * Personal Cowork project.
 */
async function launchMoveFixture(apiKey, { cloud = {} } = {}) {
  await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
    cloud: { organizations: ORG_CONTEXT_ORGANIZATIONS, ...cloud },
  });
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-org-move-'));
  seedOrgContextScoping(userDataDir, {
    personalRemoteUrl: 'https://github.com/acme/personal.git',
    personalWorktreeIds: ['move-me', 'second'],
    extraPersonalWorkspaces: [SECOND_PROJECT],
  });
  seedCoworkWorkspace({
    userDataDir,
    workspaceId: COWORK_PROJECT.id,
    name: COWORK_PROJECT.name,
    mergeIndex: true,
  });
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: ORG_CONTEXT_ENV,
  });
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await connectMockCloudAccount(window, apiKey);
  await app.openMainPage();
  // With no organizations Personal is the only context; read it from main.
  if (cloud.organizations?.length !== 0)
    await expectWorkspaceContext(window, 'personal');
  else
    await expect
      .poll(async () =>
        window.evaluate(
          async () => (await window.api.workspaceContext.get()).context.kind,
        ),
      )
      .toBe('personal');
  return { electronApp, window, userDataDir };
}

async function openWorktreeRowMenu(window, workspaceId, worktreeId) {
  const row = projectSection(window, workspaceId).locator(
    `[data-testid="worktree-row"][data-worktree-id="${worktreeId}"]`,
  );
  await expect(row).toBeVisible();
  await row.click({ button: 'right' });
  await expect(window.getByTestId('worktree-actions-menu')).toBeVisible();
}

async function pickAndMove(window, organizationId) {
  const dialog = window.getByTestId('move-project-to-organization-dialog');
  await expect(dialog).toBeVisible();
  await expect(
    window.getByTestId('move-project-to-organization-move'),
  ).toBeDisabled();
  // A Canopy dropdown: open the trigger, choose the option by its value.
  const trigger = window.getByTestId('move-project-to-organization-select');
  await expect(trigger).toBeFocused();
  await chooseSettingsOption(trigger, { value: organizationId });
  await expect(trigger).toHaveAttribute('data-value', organizationId);
  await window.getByTestId('move-project-to-organization-move').click();
}

test('a worktree row moves its whole project to the picked organization', async () => {
  test.setTimeout(150_000);
  const apiKey = 'csk_org_move_worktree';
  const { electronApp, window, userDataDir } = await launchMoveFixture(apiKey);
  try {
    // The moved worktree is the current selection.
    await projectSection(window, PERSONAL_CONTEXT_WORKSPACE)
      .locator('[data-testid="worktree-row"][data-worktree-id="move-me"]')
      .click();
    const personalRowCount = await worktreeRows(
      window,
      PERSONAL_CONTEXT_WORKSPACE,
    ).count();
    expect(personalRowCount).toBeGreaterThanOrEqual(2);

    await openWorktreeRowMenu(window, PERSONAL_CONTEXT_WORKSPACE, 'move-me');
    await window
      .getByTestId('worktree-actions-menu-move-to-organization')
      .click();
    const dialog = window.getByTestId('move-project-to-organization-dialog');
    await expect(dialog).toContainText(
      `Once ${PERSONAL_NAME} moves to an organization, it stays there and cannot move back to your personal space.`,
    );
    await pickAndMove(window, ORG_CONTEXT_A);

    await expect(dialog).toHaveCount(0);
    await expect(
      window
        .getByTestId('toast-card')
        .filter({ hasText: `Moved ${PERSONAL_NAME} to Acme.` }),
    ).toBeVisible();
    // The project left Personal; the context did not switch.
    await expect(
      projectSection(window, PERSONAL_CONTEXT_WORKSPACE),
    ).toHaveCount(0);
    await expectWorkspaceContext(window, 'personal');
    // No row is left selected for the project that moved away.
    await expect(
      window.locator(
        '[data-testid="worktree-row"][data-worktree-id="move-me"]',
      ),
    ).toHaveCount(0);

    const config = workspaceConfig(userDataDir, PERSONAL_CONTEXT_WORKSPACE);
    expect(config.owner).toMatchObject({
      type: 'organization',
      organizationId: ORG_CONTEXT_A,
    });
    const moved = await activity(apiKey);
    expect(moved.orgCodeCreate).toBe(1);
    expect(moved[`orgProjectClaim:${config.owner.projectId}`]).toBe(1);
    expect(moved[`orgProjectComplete:${config.owner.projectId}`]).toBe(1);

    // Under the organization, the project has every worktree it had.
    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    await expect(worktreeRows(window, PERSONAL_CONTEXT_WORKSPACE)).toHaveCount(
      personalRowCount,
    );
    // An organization's project offers no Move.
    await openWorktreeRowMenu(window, PERSONAL_CONTEXT_WORKSPACE, 'move-me');
    await expect(
      window.getByTestId('worktree-actions-menu-move-to-organization'),
    ).toHaveCount(0);
    await window.keyboard.press('Escape');
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

test('the project header and Cowork project menus move their project', async () => {
  test.setTimeout(150_000);
  const apiKey = 'csk_org_move_header_cowork';
  const { electronApp, window, userDataDir } = await launchMoveFixture(apiKey);
  try {
    // Project header menu, on a second Personal project.
    await window
      .getByTestId(`sidebar-project-header-${SECOND_PROJECT.id}`)
      .click({ button: 'right', position: { x: 40, y: 16 } });
    const headerMenu = window.getByTestId('workspace-session-context-menu');
    await expect(headerMenu).toBeVisible();
    await headerMenu
      .getByTestId('workspace-move-to-organization-menu-item')
      .click();
    await expect(
      window.getByTestId('move-project-to-organization-dialog'),
    ).toContainText(`Once ${SECOND_PROJECT.name} moves to an organization`);
    await pickAndMove(window, ORG_CONTEXT_A);
    await expect(
      window
        .getByTestId('toast-card')
        .filter({ hasText: `Moved ${SECOND_PROJECT.name} to Acme.` }),
    ).toBeVisible();
    await expect(projectSection(window, SECOND_PROJECT.id)).toHaveCount(0);
    expect(workspaceConfig(userDataDir, SECOND_PROJECT.id).owner).toMatchObject(
      { type: 'organization', organizationId: ORG_CONTEXT_A },
    );
    expect((await activity(apiKey)).orgCodeCreate).toBe(1);

    // The default Chats space never offers Move.
    const chatsHeader = window.getByTestId(
      'sidebar-cowork-project-cowork-default-header',
    );
    if ((await chatsHeader.count()) > 0) {
      await chatsHeader.first().click({ button: 'right' });
      await expect(
        window.getByTestId('workspace-session-context-menu'),
      ).toBeVisible();
      await expect(
        window.getByTestId('workspace-move-to-organization-menu-item'),
      ).toHaveCount(0);
      await window.keyboard.press('Escape');
    }

    // A Personal Cowork project moves through its own row menu.
    const coworkHeader = window.getByTestId(
      `sidebar-cowork-project-${COWORK_PROJECT.id}-header`,
    );
    await expect(coworkHeader).toBeVisible();
    await coworkHeader.click({ button: 'right' });
    const coworkMenu = window.getByTestId('workspace-session-context-menu');
    await expect(coworkMenu).toBeVisible();
    await coworkMenu
      .getByTestId('workspace-move-to-organization-menu-item')
      .click();
    await pickAndMove(window, ORG_CONTEXT_A);
    await expect(
      window
        .getByTestId('toast-card')
        .filter({ hasText: `Moved ${COWORK_PROJECT.name} to Acme.` }),
    ).toBeVisible();
    await expect
      .poll(() => workspaceConfig(userDataDir, COWORK_PROJECT.id).owner)
      .toMatchObject({ type: 'organization', organizationId: ORG_CONTEXT_A });
    const moved = await activity(apiKey);
    expect(moved.orgCoworkCreate).toBe(1);
    await expect(coworkHeader).toHaveCount(0);
    await expectWorkspaceContext(window, 'personal');
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

test('a refused move keeps the dialog open and the project in Personal', async () => {
  test.setTimeout(120_000);
  const apiKey = 'csk_org_move_limit';
  const { electronApp, window, userDataDir } = await launchMoveFixture(apiKey, {
    cloud: { orgMemberProjectCreateStatus: 409 },
  });
  try {
    await openWorktreeRowMenu(window, PERSONAL_CONTEXT_WORKSPACE, 'move-me');
    await window
      .getByTestId('worktree-actions-menu-move-to-organization')
      .click();
    await pickAndMove(window, ORG_CONTEXT_A);
    const error = window.getByTestId('move-project-to-organization-error');
    await expect(error.getByRole('alert')).toBeVisible();
    await expect(error).toHaveText(
      `Couldn't move ${PERSONAL_NAME}. You've reached Acme's limit for private projects.`,
    );
    await expect(
      window.getByTestId('move-project-to-organization-dialog'),
    ).toBeVisible();
    expect(
      workspaceConfig(userDataDir, PERSONAL_CONTEXT_WORKSPACE).owner,
    ).toBeUndefined();
    await expect(
      projectSection(window, PERSONAL_CONTEXT_WORKSPACE),
    ).toBeVisible();

    // Closing and reopening starts fresh: no stale error.
    await window.getByTestId('move-project-to-organization-cancel').click();
    await expect(
      window.getByTestId('move-project-to-organization-dialog'),
    ).toHaveCount(0);
    await openWorktreeRowMenu(window, PERSONAL_CONTEXT_WORKSPACE, 'move-me');
    await window
      .getByTestId('worktree-actions-menu-move-to-organization')
      .click();
    await expect(
      window.getByTestId('move-project-to-organization-dialog'),
    ).toBeVisible();
    await expect(
      window.getByTestId('move-project-to-organization-error'),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }
});

test('no row offers Move in an organization or without organizations', async () => {
  test.setTimeout(150_000);
  const apiKey = 'csk_org_move_unavailable';
  const { electronApp, window, userDataDir } = await launchMoveFixture(apiKey);
  try {
    // In Personal with an organization, the row offers Move.
    await openWorktreeRowMenu(window, PERSONAL_CONTEXT_WORKSPACE, 'move-me');
    await expect(
      window.getByTestId('worktree-actions-menu-move-to-organization'),
    ).toBeVisible();
    await window.keyboard.press('Escape');

    // In an organization context, no menu offers it.
    await selectWorkspaceContext(window, ORG_CONTEXT_A);
    await window
      .getByTestId('sidebar-project-header-context-organization')
      .click({ button: 'right', position: { x: 40, y: 16 } });
    await expect(
      window.getByTestId('workspace-session-context-menu'),
    ).toBeVisible();
    await expect(
      window.getByTestId('workspace-move-to-organization-menu-item'),
    ).toHaveCount(0);
    await window.keyboard.press('Escape');
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
  }

  const noOrgKey = 'csk_org_move_no_orgs';
  const noOrgs = await launchMoveFixture(noOrgKey, {
    cloud: { organizations: [] },
  });
  try {
    await openWorktreeRowMenu(
      noOrgs.window,
      PERSONAL_CONTEXT_WORKSPACE,
      'move-me',
    );
    await expect(
      noOrgs.window.getByTestId('worktree-actions-menu-move-to-organization'),
    ).toHaveCount(0);
    await noOrgs.window.keyboard.press('Escape');
    await noOrgs.window
      .getByTestId(`sidebar-project-header-${SECOND_PROJECT.id}`)
      .click({ button: 'right', position: { x: 40, y: 16 } });
    await expect(
      noOrgs.window.getByTestId('workspace-session-context-menu'),
    ).toBeVisible();
    await expect(
      noOrgs.window.getByTestId('workspace-move-to-organization-menu-item'),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(noOrgs.electronApp, noOrgs.userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, noOrgKey);
  }
});
