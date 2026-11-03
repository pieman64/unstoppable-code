/**
 * CAN-2546/CAN-2547 durable UI automation: owner invite/manage/revoke for a
 * code worktree and Cowork Work Entry, persisted file/note/prompt approval,
 * and sync-disabled recovery. Everything is seeded locally and served by the
 * shared mock server; no live agent or external network is involved.
 */
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { readChatStorageIndexes } from './readChatStorage.mjs';
import { cleanupDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  ENTRY_ID,
  expandCoworkWorkspace,
  openWorkEntryMenu,
} from './coworkWorkEntryDoneFixture.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { attachMainProcessLog } from './mainProcessLog.mjs';
import {
  clearScenario,
  DEFAULT_MOCK_BASE_URL,
  getScenarioActivity,
  registerScenario,
} from './seeders/index.mjs';
import {
  ADA_USER_ID,
  CODE_NOTE_ID,
  CODE_PROMPT_ID,
  CODE_SERVER_WORKTREE_ID,
  GRACE_USER_ID,
  OTHER_SHARED_CONTAINERS_ORGANIZATION_ID,
  SHARED_CONTAINERS_CLOUD_API_KEY,
  SHARED_CONTAINERS_ORGANIZATION_ID,
  buildSharedContainerE2eEnv,
  connectSharedContainersAccount,
  readPersistedFileScope,
  COWORK_CANDIDATE_FILE_PATHS,
  COWORK_NESTED_FILE_PATHS,
  COWORK_ROOT_FILE_PATH,
  COWORK_NOTE_ID,
  COWORK_PROMPT_ID,
  DEEP_UNTRACKED_PATH,
  seedCodeSharedContainer,
  seedCoworkSharedContainer,
  seedMultiRepoCodeSharedContainer,
} from './sharedContainerInviteFixture.mjs';

async function selectMember(window, name) {
  const teamPicker = window.getByTestId('shared-container-invite-modal-team');
  if ((await teamPicker.count()) > 0) {
    const selected = teamPicker.locator('[aria-pressed="true"]');
    if ((await selected.count()) === 0) {
      await teamPicker
        .locator('[data-testid^="shared-container-invite-modal-team-option-"]')
        .first()
        .click();
    }
  }
  const picker = window.getByTestId(
    'shared-container-invite-modal-member-picker',
  );
  await expect(picker).toBeVisible({ timeout: 15_000 });
  await picker.getByRole('button', { name }).click();
}

/**
 * Open Share for the seeded `demo-main` worktree through the realistic sidebar
 * path a user takes, rather than by driving the modal directly.
 */
async function openWorktreeShare(window, app) {
  await app.openMainPage();
  await app.selectWorktree('demo-main');
  const row = window.locator(
    '[data-testid="worktree-row"][data-worktree-id="demo-main"]',
  );
  await row.hover();
  await row.getByTestId('worktree-actions-menu-button').click();
  await window.getByTestId('worktree-actions-menu-invite').click();
}

/**
 * Opens the collapsed-by-default share-scope `Advanced` expander.
 *
 * Everything informational (the summary, the disclosure, the repository list,
 * the withheld notices, and every opt-out control) lives behind it, so a spec
 * that asserts on that content has to open it first. Assertions that a notice
 * is *absent* especially have to: a collapsed expander would otherwise make
 * every absence assertion pass for the wrong reason.
 */
async function expandScopeDetails(window, { timeout = 15_000 } = {}) {
  const toggle = window.getByTestId(
    'shared-container-invite-modal-scope-details-toggle',
  );
  // The toggle renders with the share preview.
  await expect(toggle).toBeVisible({ timeout });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
    await toggle.click();
  }
  await expect(
    window.getByTestId('shared-container-invite-modal-scope-details-body'),
  ).toBeVisible();
}

function saturateCoworkArtifactBudget(
  userDataDir,
  projectId,
  referencedFilePath,
) {
  const chatPath = path.join(
    userDataDir,
    'workspaces',
    projectId,
    'chats',
    `${ENTRY_ID}.json`,
  );
  const chats = JSON.parse(readFileSync(chatPath, 'utf8'));
  const template = chats.tabs[0];
  // 196 chats: the seeded note and prompt are shared by default and count
  // toward the same budget.
  chats.tabs = Array.from({ length: 196 }, (_, index) => ({
    ...template,
    id: `chat-budget-${index}`,
    title: `Budget chat ${index}`,
    messages:
      index === 0
        ? [
            ...template.messages,
            ...(referencedFilePath
              ? [
                  {
                    id: 'chat-budget-file-reference',
                    role: 'user',
                    blocks: [{ type: 'text', text: referencedFilePath }],
                    timestamp: Date.parse('2026-01-03T00:00:00.000Z'),
                  },
                ]
              : []),
          ]
        : [],
  }));
  chats.activeTabId = chats.tabs[0].id;
  writeFileSync(chatPath, `${JSON.stringify(chats, null, 2)}\n`, 'utf8');
}

async function registerFixture(overrides = {}) {
  await registerScenario(
    DEFAULT_MOCK_BASE_URL,
    SHARED_CONTAINERS_CLOUD_API_KEY,
    {
      sharedContainers: {},
      github: { commits: true },
      ...overrides,
      // An empty policy snapshot is authoritative; an omitted one is unavailable.
      cloud: { enforcedSettings: [], ...overrides.cloud },
    },
  );
}

const SHARED_CONTAINERS_DISABLED_ENV = {
  CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
    'canopy-desktop-shared-containers': false,
  }),
};

const SHARED_CONTAINERS_EXTERNAL_ENV = {
  CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
    'canopy-desktop-shared-containers': true,
    'canopy-shared-container-external-sharing': true,
  }),
};

async function requestAdvisorTool(electronApp, request) {
  return electronApp.evaluate(
    async ({ BrowserWindow, ipcMain }, rendererRequest) => {
      const responseChannel = 'app-advisor:tool-response';
      const requestChannel = 'app-advisor:tool-request';
      const mainWindow = BrowserWindow.getAllWindows().find(
        (candidate) =>
          !candidate.webContents.getURL().includes('surface=app-advisor'),
      );
      if (!mainWindow) throw new Error('Main window not found');

      ipcMain.removeHandler(responseChannel);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Timed out waiting for App Advisor tool')),
          5_000,
        );
        ipcMain.handle(responseChannel, (_event, candidate) => {
          if (candidate?.requestId !== rendererRequest.requestId) return;
          clearTimeout(timer);
          resolve(candidate);
        });
        mainWindow.webContents.send(requestChannel, rendererRequest);
      });
    },
    request,
  );
}

async function dispatchAdvisorAction(electronApp, action) {
  return requestAdvisorTool(electronApp, {
    kind: 'dispatch_action',
    requestId: `shared-container-action-${Date.now()}`,
    originWorktreeId: 'e2e-advisor-entry',
    action,
  });
}

async function getAdvisorUiState(electronApp) {
  return requestAdvisorTool(electronApp, {
    kind: 'get_current_ui_state',
    requestId: `shared-container-ui-state-${Date.now()}`,
  });
}

test('shares an organization-owned worktree by team and public email, then revokes the email invite', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-external-invite-'),
  );
  const fixture = seedCodeSharedContainer(userDataDir, {
    metadata: 'organization',
    anchorOrganizationId: SHARED_CONTAINERS_ORGANIZATION_ID,
  });
  await registerFixture({
    sharedContainers: {
      allowExternalContainerSharing: true,
      team: true,
      inviteDelayMs: 500,
    },
  });
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(
        userDataDir,
        SHARED_CONTAINERS_EXTERNAL_ENV,
      ),
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectSharedContainersAccount(window);
    await openWorktreeShare(window, app);

    const audience = window.getByTestId('shared-container-invite-scope');
    await expect(audience).toBeVisible();
    await expect(
      window.getByTestId('shared-container-invite-scope-team'),
    ).toHaveAttribute('aria-checked', 'true');
    const teamPicker = window.getByTestId('shared-container-invite-modal-team');
    await expect(teamPicker).toContainText('Shared Containers Team');
    await expect(
      window.getByText('Choose a team.', { exact: true }),
    ).toBeVisible();
    await expect(
      window.getByTestId('shared-container-invite-submit'),
    ).toBeDisabled();
    await teamPicker
      .locator('[data-testid^="shared-container-invite-modal-team-option-"]')
      .first()
      .click();
    await expect(
      window
        .getByTestId('shared-container-invite-modal-member-picker')
        .getByRole('button', { name: 'Ada Lovelace' }),
    ).toBeVisible();
    await expect(
      window
        .getByTestId('shared-container-invite-modal-member-picker')
        .getByRole('button', { name: 'Grace Hopper' }),
    ).toHaveCount(0);

    await window.getByTestId('shared-container-invite-scope-public').click();
    await expect(
      window.getByTestId('shared-container-invite-modal-external-notice'),
    ).toContainText('People outside Shared Containers E2E');
    const emailInput = window.getByTestId(
      'shared-container-invite-modal-email-input',
    );
    await emailInput.fill('Outside@Example.com');
    const submit = window.getByTestId('shared-container-invite-submit');
    await submit.click();
    await expect(submit).toContainText('Sharing…');
    await expect(
      window.getByTestId('shared-container-invite-submit-spinner'),
    ).toBeVisible();
    await expect(
      window.getByTestId('shared-container-invite-cancel'),
    ).toHaveCount(0);
    await expect(
      window
        .getByTestId('shared-container-invite-modal')
        .getByRole('button', { name: 'Close', exact: true }),
    ).toBeDisabled();
    await expect(emailInput).toBeDisabled();

    const recipients = window.getByTestId(
      'shared-container-invite-modal-recipients',
    );
    await expect(recipients).toContainText('outside@example.com');
    await expect(recipients).toContainText('Invited');
    await expect(emailInput).toHaveValue('');
    await expect(emailInput).toBeFocused();
    await expect(
      window.getByText('Invited outside@example.com', { exact: true }),
    ).toBeVisible();
    await expect(
      window.getByTestId('shared-container-invite-done'),
    ).toBeVisible();
    await recipients
      .getByRole('button', { name: 'Remove', exact: true })
      .click();
    const confirmation = window.getByTestId(
      'shared-container-invite-modal-revoke-confirmation',
    );
    await expect(confirmation).toContainText('outside@example.com');
    await confirmation.getByRole('button', { name: 'Remove access' }).click();
    // That was the only recipient, so the empty list is not rendered at all.
    await expect(
      window.getByTestId('shared-container-invite-people'),
    ).toHaveCount(0);

    const { activity } = await getScenarioActivity(
      DEFAULT_MOCK_BASE_URL,
      SHARED_CONTAINERS_CLOUD_API_KEY,
    );
    expect(activity.sharedContainersCreateEmail).toBe(1);
    expect(activity.sharedContainersRevoke).toBe(1);
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
      cleanupDemoWorkspaces(fixture.result);
    }
  }
});

test('manages link sharing below People with access: on, copy, narrow, reset, off', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-link-sharing-'),
  );
  const fixture = seedCodeSharedContainer(userDataDir, {
    metadata: 'organization',
    anchorOrganizationId: SHARED_CONTAINERS_ORGANIZATION_ID,
  });
  await registerFixture({
    sharedContainers: { allowExternalContainerSharing: true, team: true },
  });
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(
        userDataDir,
        SHARED_CONTAINERS_EXTERNAL_ENV,
      ),
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectSharedContainersAccount(window);
    await openWorktreeShare(window, app);

    // A never-shared container has no People with access yet, so Link sharing
    // stands on its own and can create the first owner container.
    const linkSection = window.getByTestId('shared-container-invite-link');
    await expect(linkSection).toBeVisible({ timeout: 15_000 });
    await expect(
      window.getByTestId('shared-container-invite-people'),
    ).toHaveCount(0);
    const linkAudience = window.getByTestId(
      'shared-container-invite-link-audience',
    );
    await expect(linkAudience).toBeEnabled();
    await expect(linkAudience).toHaveAttribute('data-value', 'off');
    await expect(
      window.getByTestId('shared-container-invite-copy-link'),
    ).toHaveCount(0);

    await linkAudience.click();
    await window
      .getByTestId('shared-container-invite-link-option-anyone')
      .click();
    await expect(linkAudience).toHaveAttribute('data-value', 'anyone');
    await expect(
      window.getByTestId('shared-container-invite-link-description'),
    ).toHaveText(
      'Anyone signed in who has the link can view it, including people outside Shared Containers E2E',
    );
    // Link copy never borrows the invite audience's "Public" name.
    await expect(linkSection).not.toContainText(/public/i);
    const copyLink = window.getByTestId('shared-container-invite-copy-link');
    await expect(copyLink).toBeVisible();
    // The link alone is the share. No disabled Share button suggests another
    // step, and the contents publish before anybody claims the link.
    await expect(
      window.getByTestId('shared-container-invite-submit'),
    ).toHaveCount(0);
    // Nobody holds a grant yet, so there is no People with access list; the
    // publish status sits on Link sharing instead.
    await expect(
      window.getByTestId('shared-container-invite-people'),
    ).toHaveCount(0);
    await expect(
      linkSection.getByTestId(
        'shared-container-invite-modal-publication-state',
      ),
    ).toHaveAttribute('data-publish-status', 'published', { timeout: 60_000 });
    await copyLink.click();
    await expect(copyLink).toContainText('Copied');

    // A link can be the container's only sharing state. Reopening must recover
    // it from the owner listing before any recipient has claimed or been
    // invited, so the owner can copy, reset, or disable the existing link.
    await window.getByTestId('shared-container-invite-done').click();
    await openWorktreeShare(window, app);
    await expect(linkAudience).toHaveAttribute('data-value', 'anyone');
    await expect(copyLink).toBeVisible();

    await selectMember(window, 'Ada Lovelace');
    await window.getByTestId('shared-container-invite-submit').click();
    const people = window.getByTestId('shared-container-invite-people');
    await expect(people).toContainText('Ada Lovelace', { timeout: 15_000 });

    // Google's order: Link sharing sits below People with access once that
    // section exists.
    const peopleBox = await people.boundingBox();
    const linkBox = await linkSection.boundingBox();
    expect(peopleBox).not.toBeNull();
    expect(linkBox).not.toBeNull();
    expect(linkBox?.y ?? 0).toBeGreaterThan(peopleBox?.y ?? 0);

    const confirm = window.getByTestId('shared-container-invite-link-confirm');
    const confirmAction = window.getByTestId(
      'shared-container-invite-link-confirm-action',
    );

    await linkAudience.click();
    await window
      .getByTestId('shared-container-invite-link-option-organization')
      .click();
    await expect(confirm).toContainText('Limit link to Shared Containers E2E?');
    await confirmAction.click();
    await expect(confirm).toHaveCount(0);
    await expect(linkAudience).toHaveAttribute('data-value', 'organization');

    await window.getByTestId('shared-container-invite-link-more').click();
    await window.getByTestId('shared-container-invite-link-reset').click();
    await expect(confirm).toContainText('Reset link?');
    await confirmAction.click();
    await expect(confirm).toHaveCount(0);

    await linkAudience.click();
    await window.getByTestId('shared-container-invite-link-option-off').click();
    await expect(confirm).toContainText('Turn off link?');
    await confirmAction.click();
    await expect(confirm).toHaveCount(0);
    await expect(linkAudience).toHaveAttribute('data-value', 'off');
    await expect(
      window.getByTestId('shared-container-invite-copy-link'),
    ).toHaveCount(0);

    const { activity } = await getScenarioActivity(
      DEFAULT_MOCK_BASE_URL,
      SHARED_CONTAINERS_CLOUD_API_KEY,
    );
    expect(activity['sharedContainersLinkSet:ANYONE']).toBe(1);
    expect(activity['sharedContainersLinkSet:ORGANIZATION']).toBe(1);
    expect(activity.sharedContainersLinkReset).toBe(1);
    expect(activity.sharedContainersLinkRemoved).toBe(1);
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
      cleanupDemoWorkspaces(fixture.result);
    }
  }
});

test('keeps a failed email invite in place and reports the error above the footer', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-invite-error-'),
  );
  const fixture = seedCodeSharedContainer(userDataDir, {
    metadata: 'organization',
    anchorOrganizationId: SHARED_CONTAINERS_ORGANIZATION_ID,
  });
  await registerFixture({
    sharedContainers: {
      allowExternalContainerSharing: true,
      inviteError: {
        status: 503,
        body: { error: 'Simulated invite outage.' },
      },
    },
  });
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(
        userDataDir,
        SHARED_CONTAINERS_EXTERNAL_ENV,
      ),
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectSharedContainersAccount(window);
    await openWorktreeShare(window, app);

    await window.getByTestId('shared-container-invite-scope-public').click();
    const emailInput = window.getByTestId(
      'shared-container-invite-modal-email-input',
    );
    await emailInput.fill('retry@example.com');
    await window.getByTestId('shared-container-invite-submit').click();

    await expect(
      window.getByTestId('shared-container-invite-error'),
    ).toContainText("Couldn't share the project. Try again.");
    await expect(emailInput).toHaveValue('retry@example.com');
    await expect(
      window.getByTestId('shared-container-invite-modal'),
    ).toBeVisible();
    await expect(
      window.getByTestId('shared-container-invite-submit'),
    ).toHaveText('Share');
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
      cleanupDemoWorkspaces(fixture.result);
    }
  }
});

test('shows Public disabled when an organization has external sharing off', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-external-disabled-'),
  );
  const fixture = seedCodeSharedContainer(userDataDir, {
    metadata: 'organization',
    anchorOrganizationId: SHARED_CONTAINERS_ORGANIZATION_ID,
  });
  // A team keeps two member audiences usable, so the selector still renders
  // and Public shows disabled rather than the selector collapsing.
  await registerFixture({ sharedContainers: { team: true } });
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(
        userDataDir,
        SHARED_CONTAINERS_EXTERNAL_ENV,
      ),
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectSharedContainersAccount(window);
    await openWorktreeShare(window, app);

    await expect(
      window.getByTestId('shared-container-invite-scope-public'),
    ).toBeDisabled();
    await expect(
      window.getByTestId('shared-container-invite-scope-hint'),
    ).toContainText('An organization admin can allow sharing outside');
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
      cleanupDemoWorkspaces(fixture.result);
    }
  }
});

test('offers only Public to an account with no organization', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-personal-invite-'),
  );
  const fixture = seedCodeSharedContainer(userDataDir);
  await registerFixture({
    cloud: { organizations: [], teams: [], orgBillingStates: [] },
  });
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(
        userDataDir,
        SHARED_CONTAINERS_EXTERNAL_ENV,
      ),
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectSharedContainersAccount(window);
    await openWorktreeShare(window, app);

    // Public is the only usable scope, so there is nothing to choose: no
    // legend, no pills, and no hint. The Email field carries its meaning.
    await expect(
      window.getByTestId('shared-container-invite-modal-email-input'),
    ).toBeVisible();
    await expect(
      window.getByTestId('shared-container-invite-scope'),
    ).toHaveCount(0);
    await expect(
      window.getByTestId('shared-container-invite-scope-public'),
    ).toHaveCount(0);
    await expect(
      window.getByTestId('shared-container-invite-scope-hint'),
    ).toHaveCount(0);
    await expect(
      window.getByTestId(
        'shared-container-invite-modal-email-input-description',
      ),
    ).toHaveText("Choose who to share with, and we'll email them an invite.");
    await expect(
      window.getByTestId('shared-container-invite-modal-external-notice'),
    ).toHaveCount(0);

    // The address error waits for the person to finish: nothing while they
    // type, the error once focus leaves, and gone again on the next edit.
    const emailInput = window.getByTestId(
      'shared-container-invite-modal-email-input',
    );
    const emailError = window.getByTestId(
      'shared-container-invite-modal-email-input-error',
    );
    await emailInput.pressSequentially('friend@exam');
    await expect(emailError).toHaveCount(0);
    await emailInput.blur();
    await expect(emailError).toBeVisible();
    await emailInput.pressSequentially('ple.com');
    await expect(emailError).toHaveCount(0);
    await expect(
      window.getByTestId('shared-container-invite-submit'),
    ).toBeEnabled();
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
      cleanupDemoWorkspaces(fixture.result);
    }
  }
});

test('shows the owner that credential-shaped and hardlinked tracked changes are withheld', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-withheld-preview-'),
  );
  const fixture = seedCodeSharedContainer(userDataDir);
  const credentialPath = path.join(fixture.worktreePath, '.env.production');
  const hardLinkedPath = path.join(fixture.worktreePath, 'hardlinked.txt');
  const hardLinkedAliasPath = path.join(
    fixture.worktreePath,
    'hardlinked-alias.txt',
  );
  writeFileSync(credentialPath, 'TOKEN=base\n', 'utf8');
  writeFileSync(hardLinkedPath, 'base\n', 'utf8');
  execFileSync('git', ['add', '.env.production', 'hardlinked.txt'], {
    cwd: fixture.worktreePath,
    stdio: 'ignore',
  });
  execFileSync('git', ['commit', '-m', 'seed credential fixture'], {
    cwd: fixture.worktreePath,
    stdio: 'ignore',
  });
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: fixture.worktreePath,
    encoding: 'utf8',
  }).trim();
  execFileSync('git', ['update-ref', `refs/remotes/origin/${branch}`, 'HEAD'], {
    cwd: fixture.worktreePath,
    stdio: 'ignore',
  });
  writeFileSync(credentialPath, 'TOKEN=owner-secret\n', 'utf8');
  linkSync(hardLinkedPath, hardLinkedAliasPath);
  writeFileSync(hardLinkedPath, 'owner change\n', 'utf8');
  await registerFixture();
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(userDataDir),
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectSharedContainersAccount(window);
    await app.openMainPage();
    await app.selectWorktree('demo-main');

    const row = window.locator(
      '[data-testid="worktree-row"][data-worktree-id="demo-main"]',
    );
    await row.hover();
    await row.getByTestId('worktree-actions-menu-button').click();
    await window.getByTestId('worktree-actions-menu-invite').click();

    await expandScopeDetails(window);
    // The credential file and the hard-linked tracked file, plus the
    // untracked alias: files not in git are shared by default, so the
    // withholding rules inspect every one of them, not only approved ones.
    await expect(
      window.getByTestId('shared-container-invite-modal-withheld-files'),
    ).toContainText('3 changed files will be withheld');
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
      cleanupDemoWorkspaces(fixture.result);
    }
  }
});

test('previews publishable code attachments and mode-only tracked changes', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-preview-parity-'),
  );
  const fixture = seedCodeSharedContainer(userDataDir);
  const modeOnlyPath = path.join(fixture.worktreePath, 'mode-only.sh');
  writeFileSync(modeOnlyPath, '#!/bin/sh\n', 'utf8');
  execFileSync('git', ['add', 'mode-only.sh'], {
    cwd: fixture.worktreePath,
    stdio: 'ignore',
  });
  execFileSync('git', ['commit', '-m', 'seed mode-only fixture'], {
    cwd: fixture.worktreePath,
    stdio: 'ignore',
  });
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: fixture.worktreePath,
    encoding: 'utf8',
  }).trim();
  execFileSync('git', ['update-ref', `refs/remotes/origin/${branch}`, 'HEAD'], {
    cwd: fixture.worktreePath,
    stdio: 'ignore',
  });
  chmodSync(modeOnlyPath, 0o755);

  const attachmentDir = path.join(
    userDataDir,
    'workspaces',
    fixture.projectId,
    'attachments',
    fixture.worktreeId,
  );
  const firstAttachment = path.join(attachmentDir, 'first.txt');
  const duplicateAttachment = path.join(attachmentDir, 'duplicate.txt');
  mkdirSync(attachmentDir, { recursive: true });
  writeFileSync(firstAttachment, 'same bytes', 'utf8');
  writeFileSync(duplicateAttachment, 'same bytes', 'utf8');
  writeFileSync(path.join(attachmentDir, 'unreferenced.txt'), 'other', 'utf8');
  const chatsDir = path.join(
    userDataDir,
    'workspaces',
    fixture.projectId,
    'chats',
  );
  mkdirSync(chatsDir, { recursive: true });
  writeFileSync(
    path.join(chatsDir, `${fixture.worktreeId}.json`),
    JSON.stringify({
      version: 1,
      activeTabId: 'chat-1',
      tabs: [
        {
          id: 'chat-1',
          title: 'Chat',
          createdAt: '2026-01-01T00:00:00.000Z',
          messages: [
            {
              id: 'message-1',
              role: 'user',
              timestamp: 1,
              blocks: [],
              attachmentPaths: [firstAttachment, duplicateAttachment],
            },
          ],
        },
      ],
    }),
    'utf8',
  );
  await registerFixture();
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(userDataDir),
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectSharedContainersAccount(window);
    await app.openMainPage();
    await app.selectWorktree('demo-main');

    const row = window.locator(
      '[data-testid="worktree-row"][data-worktree-id="demo-main"]',
    );
    await row.hover();
    await row.getByTestId('worktree-actions-menu-button').click();
    await window.getByTestId('worktree-actions-menu-invite').click();

    // Both counts belong to the summary sentence that opens Advanced.
    await expandScopeDetails(window);
    const summary = window.getByTestId(
      'shared-container-invite-modal-scope-summary',
    );
    await expect(summary).toContainText('1 attachment');
    await expect(summary).toContainText('1 uncommitted change');
    // Within the limit the budget is not actionable, so it is not shown.
    await expect(
      window.getByTestId('shared-container-invite-modal-artifact-budget'),
    ).toHaveCount(0);
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
      cleanupDemoWorkspaces(fixture.result);
    }
  }
});

test('App Advisor opens one invite modal when selected-row pin copies are mounted', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-advisor-'),
  );
  const fixture = seedCodeSharedContainer(userDataDir);
  await registerFixture();
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(userDataDir),
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectSharedContainersAccount(window);
    await app.openMainPage();
    await app.selectWorktree('demo-main');
    await expect(
      window.locator('[data-testid^="worktree-row-pin-"]'),
    ).toHaveCount(2);

    const response = await dispatchAdvisorAction(electronApp, {
      type: 'shared-containers.open_invite',
      projectId: fixture.projectId,
      worktreeId: fixture.worktreeId,
      containerType: 'CODE_WORKTREE',
    });

    expect(response).toMatchObject({ ok: true });
    await expect(
      window.getByTestId('shared-container-invite-modal'),
    ).toHaveCount(1);
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
      cleanupDemoWorkspaces(fixture.result);
    }
  }
});

test('an organization-less account refresh leaves the open invite modal actionable', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-orgless-refresh-'),
  );
  const fixture = seedCodeSharedContainer(userDataDir);
  await registerFixture();
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(userDataDir),
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectSharedContainersAccount(window);
    await app.openMainPage();
    await app.selectWorktree('demo-main');

    const row = window.locator(
      '[data-testid="worktree-row"][data-worktree-id="demo-main"]',
    );
    await row.hover();
    await row.getByTestId('worktree-actions-menu-button').click();
    await window.getByTestId('worktree-actions-menu-invite').click();
    await expect(
      window.getByTestId('shared-container-invite-modal-member-picker'),
    ).toBeVisible({ timeout: 15_000 });

    await registerScenario(
      DEFAULT_MOCK_BASE_URL,
      SHARED_CONTAINERS_CLOUD_API_KEY,
      { cloud: { organizations: [] }, sharedContainers: {} },
    );
    const refreshedAccount = await window.evaluate(async (apiKey) => {
      const saved = await window.api.saveCanopyCloudApiKey({ apiKey });
      window.dispatchEvent(new Event('canopy:cloud-account-changed'));
      return saved;
    }, SHARED_CONTAINERS_CLOUD_API_KEY);
    expect(refreshedAccount.status).toMatchObject({ authenticated: true });
    expect(refreshedAccount.account.organizations).toEqual([]);

    const refusal = window.getByTestId('shared-container-invite-blocked');
    await expect(refusal).toContainText('Join an organization', {
      timeout: 15_000,
    });
    await expect(refusal).not.toContainText('Checking access…');
    await expect(
      window.getByTestId('shared-container-invite-cancel'),
    ).toHaveCount(0);
    await expect(
      window
        .getByTestId('shared-container-invite-modal')
        .getByRole('button', { name: 'Close', exact: true }),
    ).toBeEnabled();
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
      cleanupDemoWorkspaces(fixture.result);
    }
  }
});

test('refreshes the artifact budget when tracked changes cross the limit', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-budget-refresh-'),
  );
  const fixture = seedCodeSharedContainer(userDataDir);
  await registerFixture();
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(userDataDir),
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectSharedContainersAccount(window);
    await app.openMainPage();
    await app.selectWorktree('demo-main');

    const row = window.locator(
      '[data-testid="worktree-row"][data-worktree-id="demo-main"]',
    );
    const modal = window.getByTestId('shared-container-invite-modal');
    const budget = window.getByTestId(
      'shared-container-invite-modal-artifact-budget',
    );
    // The budget is copy only once exceeded, so read the counts from the
    // review container's automation attributes instead of visible text.
    const review = window.getByTestId(
      'shared-container-invite-modal-file-review',
    );

    // Open the invite modal with the whole seeded composition present.
    //
    // The preview is recomputed per open, and the budget counts the seeded
    // chat alongside the padding. Early in this test's life that chat is not
    // always in the preview yet, so a count read then is one low — which is
    // what made this spec intermittently report 201 of 200 rather than any
    // product off-by-one. Reopening until the summary names the chat pins the
    // composition instead of compensating for it afterwards.
    const openInviteModal = async () => {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await row.hover();
        await row.getByTestId('worktree-actions-menu-button').click();
        await window.getByTestId('worktree-actions-menu-invite').click();
        await expect(review).toBeVisible();
        // The summary lives behind Advanced.
        await expandScopeDetails(window);
        if ((await review.innerText()).includes('1 chat')) return;
        await modal.getByRole('button', { name: 'Close', exact: true }).click();
        await window.waitForTimeout(500);
      }
      throw new Error(
        'the seeded chat never appeared in the share preview summary',
      );
    };

    await openInviteModal();
    const initialUsed = Number(
      await review.getAttribute('data-artifact-budget-used'),
    );
    const artifactBudgetLimit = Number(
      await review.getAttribute('data-artifact-budget-limit'),
    );
    expect(artifactBudgetLimit).toBe(200);
    expect(initialUsed).toBeGreaterThan(0);
    expect(initialUsed).toBeLessThan(200);
    await expect(budget).toHaveCount(0);
    await modal.getByRole('button', { name: 'Close', exact: true }).click();

    // Seed enough tracked files to fill the budget after advancing the base.
    // The base transition can expose a fixture-owned tracked change depending
    // on the surrounding shard, so measure the new baseline before choosing
    // how many padding files to modify.
    // A few more than the limit so the convergence loop below can always add
    // one more dirty file, whatever the rest of the composition turns out to be.
    const paddingFileCount = artifactBudgetLimit + 8;
    const paddingDir = path.join(fixture.worktreePath, 'budget-padding');
    mkdirSync(paddingDir, { recursive: true });
    for (let index = 0; index < paddingFileCount; index += 1) {
      writeFileSync(path.join(paddingDir, `${index}.txt`), 'base\n', 'utf8');
    }
    execFileSync('git', ['add', 'budget-padding'], {
      cwd: fixture.worktreePath,
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    execFileSync('git', ['commit', '-m', 'seed artifact budget'], {
      cwd: fixture.worktreePath,
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: fixture.worktreePath,
      encoding: 'utf8',
    }).trim();
    execFileSync(
      'git',
      ['update-ref', `refs/remotes/origin/${branch}`, 'HEAD'],
      {
        cwd: fixture.worktreePath,
        stdio: 'ignore',
      },
    );

    await openInviteModal();
    const postCommitUsed = Number(
      await review.getAttribute('data-artifact-budget-used'),
    );
    expect(postCommitUsed).toBeGreaterThan(0);
    expect(postCommitUsed).toBeLessThan(artifactBudgetLimit);
    await modal.getByRole('button', { name: 'Close', exact: true }).click();

    // Converge on the limit instead of computing the padding once.
    //
    // The budget counts more than this test's padding: the container itself,
    // every chat, the selected notes and prompts, and any tracked change the
    // fixture or the base transition happens to expose. Which of those exist
    // is not fully this test's to decide, so a padding count derived from a
    // snapshot taken one modal-open earlier lands off by one whenever the
    // composition shifts in between — the 201-vs-200 flake this loop removes.
    // Re-reading the live count and adjusting is exact regardless.
    let dirtyPaddingCount = 0;
    const setDirtyPaddingCount = (next) => {
      for (let index = dirtyPaddingCount; index < next; index += 1) {
        writeFileSync(
          path.join(paddingDir, `${index}.txt`),
          'changed\n',
          'utf8',
        );
      }
      for (let index = next; index < dirtyPaddingCount; index += 1) {
        writeFileSync(path.join(paddingDir, `${index}.txt`), 'base\n', 'utf8');
      }
      dirtyPaddingCount = next;
    };
    // Converge one below the limit, so the last step up to it is a measured
    // single-file delta rather than an assumption.
    const convergeTo = async (target) => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await openInviteModal();
        const used = Number(
          await review.getAttribute('data-artifact-budget-used'),
        );
        if (used === target) return used;
        await modal.getByRole('button', { name: 'Close', exact: true }).click();
        const next = dirtyPaddingCount + (target - used);
        expect(next).toBeGreaterThanOrEqual(0);
        expect(next).toBeLessThanOrEqual(paddingFileCount);
        setDirtyPaddingCount(next);
      }
      return -1;
    };

    setDirtyPaddingCount(artifactBudgetLimit - 1 - postCommitUsed);
    expect(await convergeTo(artifactBudgetLimit - 1)).toBe(
      artifactBudgetLimit - 1,
    );
    await expect(budget).toHaveCount(0);
    await modal.getByRole('button', { name: 'Close', exact: true }).click();

    // One more dirty tracked file, measured against the reading immediately
    // before it. This is the arithmetic the convergence loop would otherwise
    // absorb — drop the container's own `1 +` term, or double-count a tracked
    // symlink, and the loop would simply settle on a different padding count
    // with nothing to notice. Asserting it against `postCommitUsed` instead
    // does not work: that snapshot predates the seeded chat appearing in the
    // preview under load, which is the drift this whole loop exists to absorb.
    const dirtyPaddingAtLimit = dirtyPaddingCount + 1;
    setDirtyPaddingCount(dirtyPaddingAtLimit);
    await openInviteModal();
    // Exactly at the limit is still publishable, so nothing is surfaced yet.
    await expect(review).toHaveAttribute(
      'data-artifact-budget-used',
      String(artifactBudgetLimit),
    );
    await expect(budget).toHaveCount(0);
    await modal.getByRole('button', { name: 'Close', exact: true }).click();

    // Keep growing the tracked changes. Files not in git are included by
    // default but capped at the budget, so each step first drops one quietly
    // (the count holds at the limit) until none is left to drop and the
    // tracked changes alone cross it.
    let crossed = false;
    for (let attempt = 0; attempt < 8 && !crossed; attempt += 1) {
      setDirtyPaddingCount(dirtyPaddingCount + 1);
      await openInviteModal();
      const used = Number(
        await review.getAttribute('data-artifact-budget-used'),
      );
      if (used > artifactBudgetLimit) {
        crossed = true;
        break;
      }
      expect(used).toBe(artifactBudgetLimit);
      // Over-limit files are unticked quietly: no warning, banner or blocker.
      await expect(budget).toHaveCount(0);
      await expect(
        window.getByTestId(
          'shared-container-invite-modal-file-scope-budget-note',
        ),
      ).toHaveCount(0);
      await modal.getByRole('button', { name: 'Close', exact: true }).click();
    }
    expect(crossed).toBe(true);
    await expect(
      window.getByTestId(
        'shared-container-invite-modal-file-review-share-note.txt',
      ),
    ).not.toBeChecked();
    // Crossing the limit is the problem the owner must act on.
    await expect(budget).toContainText('201 of 200 shareable items used.');
    await expect(budget).toContainText('Publishing refuses over the limit');
    await expect(budget).toContainText('Untick some files under Advanced');
    await expect(budget.getByRole('alert')).toContainText(
      '201 of 200 shareable items used.',
    );

    // The boundary the progressive-disclosure rework has to hold: a refusal
    // that stops publishing is never collapsed. Close the expander again and
    // the blocker must still be on screen, because an owner who never opens
    // Advanced would otherwise click Invite believing the share will publish.
    const detailsToggle = window.getByTestId(
      'shared-container-invite-modal-scope-details-toggle',
    );
    await detailsToggle.click();
    await expect(detailsToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(
      window.getByTestId('shared-container-invite-modal-scope-details-body'),
    ).toHaveCount(0);
    await expect(budget).toBeVisible();
    await expect(budget).toContainText('201 of 200 shareable items used.');
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
      cleanupDemoWorkspaces(fixture.result);
    }
  }
});

test('invites from a code worktree, persists opt-outs, and revokes both recipients', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-code-'),
  );
  const fixture = seedCodeSharedContainer(userDataDir, {
    seedPlanVisibility: true,
  });
  // At least nine run scripts (the demo app adds its own), committed and
  // pushed so the manifest is not itself a file not in git.
  const runScriptNames = [
    'setup',
    'launch',
    ...['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((suffix) => `check-${suffix}`),
  ];
  writeFileSync(
    path.join(fixture.worktreePath, 'canopy.json'),
    `${JSON.stringify(
      {
        version: 1,
        scripts: Object.fromEntries(
          runScriptNames.map((name) => [name, `echo ${name}`]),
        ),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  execFileSync('git', ['add', 'canopy.json'], {
    cwd: fixture.worktreePath,
    stdio: 'ignore',
  });
  execFileSync('git', ['commit', '-m', 'seed run scripts'], {
    cwd: fixture.worktreePath,
    stdio: 'ignore',
  });
  const runScriptBranch = execFileSync(
    'git',
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    { cwd: fixture.worktreePath, encoding: 'utf8' },
  ).trim();
  execFileSync(
    'git',
    ['update-ref', `refs/remotes/origin/${runScriptBranch}`, 'HEAD'],
    { cwd: fixture.worktreePath, stdio: 'ignore' },
  );
  await registerFixture({
    sharedContainers: { inviteDelayMs: 500 },
  });
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(userDataDir),
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectSharedContainersAccount(window);
    await app.openMainPage();
    await app.selectWorktree('demo-main');

    const row = window.locator(
      '[data-testid="worktree-row"][data-worktree-id="demo-main"]',
    );
    await row.hover();
    await row.getByTestId('worktree-actions-menu-button').click();
    await window.getByTestId('worktree-actions-menu-invite').click();

    const modal = window.getByTestId('shared-container-invite-modal');
    await expect(modal).toBeVisible();
    const review = window.getByTestId(
      'shared-container-invite-modal-file-review',
    );
    // No card and no always-visible sentence: the scope panel shows only the
    // low-profile Advanced toggle until it is opened.
    const summary = review.getByTestId(
      'shared-container-invite-modal-scope-summary',
    );
    await expect(summary).toHaveCount(0);
    await expect(
      window.getByTestId('shared-container-invite-modal-scope-details-toggle'),
    ).toHaveText('Advanced');
    // The per-revision artifact budget stays hidden until publishing would
    // refuse; this fixture is well inside the ceiling.
    await expect(
      window.getByTestId('shared-container-invite-modal-artifact-budget'),
    ).toHaveCount(0);
    // The summary answers "what leaves my machine", and the base commit the
    // recipient clones is disclosed, one line per repository, inside Advanced.
    await expandScopeDetails(window);
    await expect(summary).toContainText("Sharing this project's code");
    await expect(summary).toContainText('1 plan');
    await expect(summary).toContainText('1 of 1 note, 1 of 1 prompt');
    await expect(
      window.getByTestId('shared-container-invite-modal-scope-details-body'),
    ).toContainText('Repository');
    // Code worktrees publish now, so the pre-publisher copy is gone.
    await expect(
      window.getByTestId('shared-container-invite-modal-disclosure'),
    ).not.toContainText('once publishing is available');
    const workspaceItems = window.getByTestId(
      'shared-container-invite-modal-workspace-items',
    );
    await expect(workspaceItems).toContainText(
      'Included unless you untick them.',
    );
    // Notes and prompts are shared by default; unticking records exclusions.
    const noteScope = window.getByTestId(
      `shared-container-invite-modal-note-scope-${CODE_NOTE_ID}`,
    );
    const promptScope = window.getByTestId(
      `shared-container-invite-modal-prompt-scope-${CODE_PROMPT_ID}`,
    );
    await expect(noteScope).toBeChecked();
    await expect(promptScope).toBeChecked();
    await noteScope.uncheck();
    await promptScope.uncheck();
    await expect
      .poll(() =>
        readPersistedFileScope(
          userDataDir,
          fixture.projectId,
          fixture.worktreeId,
        ),
      )
      .toMatchObject({
        version: 1,
        excludedNoteIds: [CODE_NOTE_ID],
        excludedPromptIds: [CODE_PROMPT_ID],
      });
    // Files not in git are shared by default too.
    await expect(
      window
        .getByTestId('shared-container-invite-modal-file-scope')
        .locator('legend'),
    ).toHaveText('Files not in git');
    const fileApproval = window.getByTestId(
      'shared-container-invite-modal-file-review-share-note.txt',
    );
    await expect(fileApproval).toBeChecked();
    await fileApproval.uncheck();
    await expect
      .poll(() =>
        readPersistedFileScope(
          userDataDir,
          fixture.projectId,
          fixture.worktreeId,
        ),
      )
      .toMatchObject({ version: 1, excludedPaths: ['share-note.txt'] });

    // Run sharing is on by default with the first eight scripts ticked.
    await expect(
      window.getByTestId('shared-container-invite-modal-run-scope-toggle'),
    ).toBeChecked();
    const runScopePrefix = 'shared-container-invite-modal-run-scope-';
    const runScript = (name) => window.getByTestId(`${runScopePrefix}${name}`);
    // Rows render in selection order: lifecycle scripts first, then the rest
    // alphabetically. The first eight are ticked; the rest wait past the cap.
    const runScriptNames = (
      await window
        .getByTestId('shared-container-invite-modal-run-scope')
        .locator(`input[data-testid^="${runScopePrefix}"]`)
        .evaluateAll((inputs) =>
          inputs.map((input) => input.getAttribute('data-testid') ?? ''),
        )
    )
      .filter((testId) => !testId.endsWith('-toggle'))
      .map((testId) => testId.slice(runScopePrefix.length));
    expect(runScriptNames.length).toBeGreaterThanOrEqual(9);
    expect(runScriptNames.slice(0, 2)).toEqual(['setup', 'launch']);
    for (const name of runScriptNames.slice(0, 8)) {
      await expect(runScript(name)).toBeChecked();
    }
    const ninthScript = runScriptNames[8];
    await expect(runScript(ninthScript)).not.toBeChecked();
    await expect(runScript(ninthScript)).toBeDisabled();
    await expect(
      window.getByTestId('shared-container-invite-modal-run-scope'),
    ).toContainText('8 of 8 selected');
    // Unticking one persists an exclusion and lets the ninth script in.
    await runScript('launch').uncheck();
    await expect
      .poll(() =>
        readPersistedFileScope(
          userDataDir,
          fixture.projectId,
          fixture.worktreeId,
        ),
      )
      .toMatchObject({ version: 1, excludedRunScripts: ['launch'] });
    await expect(runScript('launch')).not.toBeChecked();
    await expect(runScript(ninthScript)).toBeChecked();

    // A file not in git can appear while the modal is closed, and a formerly
    // unticked file can become tracked. The new file is shared by default,
    // and unticking it persists alongside the earlier choices.
    await modal.getByRole('button', { name: 'Close', exact: true }).click();
    execFileSync('git', ['add', 'share-note.txt'], {
      cwd: fixture.worktreePath,
      stdio: 'ignore',
    });
    writeFileSync(
      path.join(fixture.worktreePath, 'fresh-share-note.txt'),
      'A newly untracked file approved after the old scope became stale.\n',
      'utf8',
    );
    await row.hover();
    await row.getByTestId('worktree-actions-menu-button').click();
    await window.getByTestId('worktree-actions-menu-invite').click();
    // The expander collapses again with the remounted modal.
    await expandScopeDetails(window);
    const freshFile = window.getByTestId(
      'shared-container-invite-modal-file-review-fresh-share-note.txt',
    );
    await expect(freshFile).toBeChecked();
    await freshFile.uncheck();
    await expect
      .poll(
        async () =>
          (
            await readPersistedFileScope(
              userDataDir,
              fixture.projectId,
              fixture.worktreeId,
            )
          )?.excludedPaths ?? [],
      )
      .toContain('fresh-share-note.txt');

    // TextInput rests transparent on its field edge (docs/design/forms.md).
    // The member row stays unfilled and has a pick affordance of its own.
    const picker = window.getByTestId(
      'shared-container-invite-modal-member-picker',
    );
    const search = picker.locator('input[type="search"]');
    // Persistence precedes the preview refresh that re-enables this field.
    await expect(search).toBeEnabled();
    await search.blur();
    const inputPaint = await search.evaluate((element) => {
      const style = getComputedStyle(element.parentElement);
      return {
        fill: style.backgroundColor,
        edge: style.boxShadow,
      };
    });
    const rowFill = await picker
      .getByRole('button', { name: 'Ada Lovelace' })
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(inputPaint.fill).toMatch(/rgba\(.*,\s*0\)$/);
    expect(inputPaint.edge).not.toBe('none');
    expect(inputPaint.edge).toContain('inset');
    expect(rowFill).toMatch(/rgba\(.*,\s*0\)$/);
    // ...and each row carries its own pick affordance rather than relying on
    // the list's former box.
    await expect(
      picker
        .getByRole('button', { name: 'Ada Lovelace' })
        .getByTestId('shared-target-picker-selection-indicator'),
    ).toHaveAttribute('data-selected', 'false');

    await selectMember(window, 'Ada Lovelace');
    await expect(
      picker
        .getByRole('button', { name: 'Ada Lovelace' })
        .getByTestId('shared-target-picker-selection-indicator'),
    ).toHaveAttribute('data-selected', 'true');
    const memberSearch = modal.getByPlaceholder('Search teammates by name');
    await memberSearch.fill('Grace');
    await expect(
      window.getByTestId('shared-container-invite-submit'),
    ).toBeDisabled();
    await memberSearch.fill('');
    await selectMember(window, 'Ada Lovelace');
    await window.getByTestId('shared-container-invite-submit').click();
    const recipients = window.getByTestId(
      'shared-container-invite-modal-recipients',
    );
    await expect(recipients).toContainText('Ada Lovelace');
    // The granted capability is one pill per token, keyed on the raw server
    // token and rendered with a friendly label.
    await expect(
      recipients.getByTestId('shared-container-capability-pill-VIEW'),
    ).toHaveText('View');
    // Somebody holds a grant now. The one scope panel remains with the invite
    // content while another teammate can still be selected, preserving the
    // owner's open Advanced state because success no longer swaps panes.
    await expect(
      window.getByTestId('shared-container-invite-modal-scope-summary'),
    ).toContainText("Sharing this project's code");
    await expect(
      window.getByTestId('shared-container-invite-modal-scope-details-body'),
    ).toBeVisible();

    await selectMember(window, 'Grace Hopper');
    await window.getByTestId('shared-container-invite-submit').click();
    await expect(
      window.getByTestId(`shared-container-invite-modal-revoke-${ADA_USER_ID}`),
    ).toBeDisabled();
    await expect(recipients).toContainText('Ada Lovelace');
    await expect(recipients).toContainText('Grace Hopper');

    // Both members now hold a grant. The picker becomes its settled empty
    // state and the one scope panel moves beneath People with access.
    await expect(
      window.getByTestId(
        'shared-container-invite-modal-empty-everyone-has-access',
      ),
    ).toBeVisible();
    // The moved panel mounts collapsed, so open its Advanced expander.
    await recipients
      .getByTestId('shared-container-invite-modal-scope-details-toggle')
      .click();
    await expect(
      recipients.getByTestId('shared-container-invite-modal-scope-summary'),
    ).toBeVisible();
    await expect(
      window.getByTestId('shared-container-invite-modal-scope-summary'),
    ).toHaveCount(1);

    let inviteModalState;
    await expect
      .poll(
        async () => {
          const uiStateResponse = await getAdvisorUiState(electronApp);
          expect(uiStateResponse).toMatchObject({ ok: true });
          inviteModalState =
            uiStateResponse.uiState.snapshot.sharedContainersInviteModal;
          return inviteModalState?.recipients?.map(
            (recipient) => recipient.name,
          );
        },
        { timeout: 15_000 },
      )
      .toContain('Ada Lovelace');
    const adaRecipient = inviteModalState.recipients.find(
      (recipient) => recipient.name === 'Ada Lovelace',
    );
    expect(adaRecipient).toEqual({
      userId: ADA_USER_ID,
      name: 'Ada Lovelace',
    });
    const revokeResponse = await dispatchAdvisorAction(electronApp, {
      type: 'shared-containers.revoke_recipient',
      containerId: inviteModalState.containerId,
      recipientId: adaRecipient.userId,
      organizationId: inviteModalState.organizationId,
    });
    expect(revokeResponse).toMatchObject({ ok: true });
    const revokeConfirmation = window.getByTestId(
      'shared-container-invite-modal-revoke-confirmation',
    );
    await expect(revokeConfirmation).toContainText('Ada Lovelace');
    expect(
      (
        await getScenarioActivity(
          DEFAULT_MOCK_BASE_URL,
          SHARED_CONTAINERS_CLOUD_API_KEY,
        )
      ).activity.sharedContainersRevoke ?? 0,
    ).toBe(0);
    await revokeConfirmation
      .getByRole('button', { name: 'Remove access' })
      .click();
    await expect(recipients).not.toContainText('Ada Lovelace');
    await expect(recipients).toContainText('Grace Hopper');
    const graceRevokeButton = window.getByTestId(
      `shared-container-invite-modal-revoke-${GRACE_USER_ID}`,
    );
    await expect(graceRevokeButton).toBeVisible();

    // Revoking the LAST recipient, in the same modal session. The publish
    // scheduler returns early for a target with no recipients and no link
    // without
    // rewriting the record, and revoke never touches it, so the local
    // `not-published` record survives with nothing queued behind it. Before
    // the fix this left "Publishing…" spinning directly above "No one has been
    // invited yet" for as long as the modal stayed open.
    await graceRevokeButton.click();
    const graceRevokeConfirmation = window.getByTestId(
      'shared-container-invite-modal-revoke-confirmation',
    );
    await expect(graceRevokeConfirmation).toContainText('Grace Hopper');
    await graceRevokeConfirmation
      .getByRole('button', { name: 'Remove access' })
      .click();

    await expect(recipients).not.toContainText('Grace Hopper');
    // Managing existing access keeps the list, since it is the whole dialog.
    await expect(recipients).toContainText('No one has been invited yet.');
    // The invariant is that no publish is *claimed* once nobody holds a grant,
    // not that the block is unconditionally absent. Asserting absence would
    // race the publish `schedule()` armed by the invite: its debounce is
    // SHARED_CONTAINER_PUBLISH_IDLE_DEBOUNCE_MS (10s), and the mock cloud
    // implements stage+commit, so on a loaded runner the record can legitimately
    // reach `published` before this line and render a truthful "Shared" — a
    // permanent failure no retry recovers, since the block never disappears
    // again. Asserting on the stranded spinner instead is immune to that and
    // still fails against the unfixed source, where the block renders
    // "Publishing…" above "No one has been invited yet" forever.
    await expect(
      window
        .getByTestId('shared-container-invite-modal-publication-state')
        .filter({ hasText: 'Publishing' }),
    ).toHaveCount(0);

    const { activity } = await getScenarioActivity(
      DEFAULT_MOCK_BASE_URL,
      SHARED_CONTAINERS_CLOUD_API_KEY,
    );
    expect(activity.sharedContainersCreate).toBe(2);
    expect(activity.sharedContainersRevoke).toBe(2);
    expect(activity.sharedContainersUnexpectedMutation ?? 0).toBe(0);
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
      cleanupDemoWorkspaces(fixture.result);
    }
  }
});

test('reads the only-member dead end as a dead end, with a legible handoff', async () => {
  // Two follow-ups to CAN-2551 meet here. There is nobody to invite, so the
  // scope panel - a file-approval decision for a share that cannot happen -
  // is noise and comes off. And the one live control on the screen has to be
  // readable: it shipped as `bg-fg-primary` + `text-base`, which is a solid
  // slab with an invisible label, because `text-base` is Tailwind's font-size
  // utility rather than a color. Class names cannot prove that fix, so this
  // reads the computed colors off the running app.
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-only-member-'),
  );
  const fixture = seedCodeSharedContainer(userDataDir);
  // The owner alone in the organization: the member search returns nobody.
  await registerFixture({ sharedContainers: { members: [] } });
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(userDataDir),
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectSharedContainersAccount(window);
    await app.openMainPage();
    await app.selectWorktree('demo-main');

    const row = window.locator(
      '[data-testid="worktree-row"][data-worktree-id="demo-main"]',
    );
    await row.hover();
    await row.getByTestId('worktree-actions-menu-button').click();
    await window.getByTestId('worktree-actions-menu-invite').click();

    await expect(
      window.getByTestId('shared-container-invite-modal-empty-only-member'),
    ).toBeVisible({ timeout: 30_000 });
    // No search box, and no scope panel behind it.
    await expect(
      window.getByTestId('shared-container-invite-modal-member-picker'),
    ).toHaveCount(0);
    await expect(
      window.getByTestId('shared-container-invite-modal-file-review'),
    ).toHaveCount(0);

    const cta = window.getByTestId(
      'shared-container-invite-modal-manage-members',
    );
    await expect(cta).toBeVisible();
    const paint = await cta.evaluate((element) => {
      const style = getComputedStyle(element);
      return { color: style.color, backgroundColor: style.backgroundColor };
    });
    expect(paint.color).not.toBe(paint.backgroundColor);
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
      cleanupDemoWorkspaces(fixture.result);
    }
  }
});

test('marks a shared worktree in the sidebar, immediately and after a restart', async () => {
  // CAN-2551. Two distinct paths produce this badge and both must work:
  //   1. right after an invite, from the container the renderer just created;
  //   2. on a cold start, from the org-wide owner listing reverse-mapped
  //      through the telemetry anchor map in main.
  // Path 2 is the one that has no other coverage - it is the only consumer of
  // `buildLocalWorktreeIndexByServerExternalId`, which the owned-target
  // handler builds once per invocation and looks every container up in.
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-badge-'),
  );
  const fixture = seedCodeSharedContainer(userDataDir);
  await registerFixture();
  const env = buildSharedContainerE2eEnv(userDataDir);
  const rowSelector =
    '[data-testid="worktree-row"][data-worktree-id="demo-main"]';
  let first;
  let second;
  try {
    first = await launchCanopy({ userDataDir, env });
    const window = await first.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectSharedContainersAccount(window);
    await app.openMainPage();
    await app.selectWorktree('demo-main');

    const row = window.locator(rowSelector);
    // Nothing is shared yet, so the row must not claim otherwise.
    await expect(row.getByTestId('worktree-row-shared-badge')).toHaveCount(0);

    await row.hover();
    await row.getByTestId('worktree-actions-menu-button').click();
    await window.getByTestId('worktree-actions-menu-invite').click();
    await expect(
      window.getByTestId('shared-container-invite-modal'),
    ).toBeVisible();
    await selectMember(window, 'Ada Lovelace');
    await window.getByTestId('shared-container-invite-submit').click();
    await expect(
      window.getByTestId('shared-container-invite-modal-recipients'),
    ).toContainText('Ada Lovelace');
    await window.getByTestId('shared-container-invite-done').click();
    await expect(
      window.getByTestId('shared-container-invite-modal'),
    ).toHaveCount(0);

    // Path 1: the badge appears without waiting for another account hydration.
    const badge = row.getByTestId('worktree-row-shared-badge');
    await expect(badge).toBeVisible({ timeout: 15_000 });
    await expect(badge).toHaveAttribute('aria-label', 'Shared with teammates');
    // Persistent metadata, never the single-winner leading slot.
    await expect(
      row
        .getByTestId('worktree-row-leading-slot')
        .getByTestId('worktree-row-shared-badge'),
    ).toHaveCount(0);

    // The badge now sits at the trailing edge of the title line, which is
    // exactly where the row paints its ••• and rail buttons on hover. The
    // rail is `bg-transparent` at rest, so without the fade the glyphs
    // overlap. Read the computed opacity rather than class names: an
    // unlayered `border-color` rule makes class-name inspection unreliable
    // for this kind of assertion (CAN-2734).
    const badgeOpacity = async () =>
      badge.evaluate((node) => getComputedStyle(node).opacity);
    await window.mouse.move(0, 0);
    // DialogModal restores focus to the menu trigger. Blur it before checking
    // the row's true resting paint; focus-within intentionally keeps the
    // trailing action rail visible for keyboard users.
    await window.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    });
    await expect.poll(badgeOpacity).toBe('1');

    await row.hover();
    const actionsButton = row.getByTestId('worktree-actions-menu-button');
    await expect(actionsButton).toBeVisible();
    // Faded, not unmounted: the footprint stays so nothing on the row jumps.
    await expect.poll(badgeOpacity).toBe('0');
    await expect(badge).toHaveCount(1);

    await window.mouse.move(0, 0);
    await window.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    });
    await expect.poll(badgeOpacity).toBe('1');

    // `keepUserData` is required: the default close deletes the data dir, and
    // the whole point of the second leg is that nothing survives except what
    // was actually persisted.
    await closeCanopy(first.electronApp, userDataDir, { keepUserData: true });
    first = undefined;

    // Path 2: a cold start knows nothing except what the org-wide owner
    // listing plus the persisted anchor map can tell it.
    second = await launchCanopy({ userDataDir, env });
    const restarted = await second.electronApp.firstWindow();
    const restartedApp = new CanopyAppDriver(restarted);
    await restartedApp.waitForShell({ timeout: 30_000 });
    await connectSharedContainersAccount(restarted);
    await restartedApp.openMainPage();
    await restartedApp.selectWorktree('demo-main');
    await expect(
      restarted.locator(rowSelector).getByTestId('worktree-row-shared-badge'),
    ).toBeVisible({ timeout: 30_000 });
  } finally {
    try {
      if (first) await closeCanopy(first.electronApp, userDataDir);
      if (second) await closeCanopy(second.electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
      cleanupDemoWorkspaces(fixture.result);
    }
  }
});

test('marks a shared Cowork Work Entry with the same badge, in the same slot', async () => {
  // The Cowork counterpart of the code-worktree badge assertions above. Both
  // row types now render the one `SharedWithTeammatesBadge` at the trailing
  // edge of the title line, which is where each row paints its ••• and rail
  // buttons on hover. The rails are `bg-transparent` at rest, so without the
  // fade the glyphs overlap - the bug this test is the regression guard for.
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-cowork-badge-'),
  );
  const fixture = seedCoworkSharedContainer(userDataDir);
  await registerFixture();
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(userDataDir),
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectSharedContainersAccount(window);
    await app.openMainPage();
    await expandCoworkWorkspace(window, fixture.projectId);

    const row = window.getByTestId(`sidebar-work-entry-${ENTRY_ID}`);
    const badge = row.getByTestId('worktree-row-shared-badge');
    // Nothing is shared yet, so the row must not claim otherwise.
    await expect(badge).toHaveCount(0);

    await openWorkEntryMenu(window, ENTRY_ID);
    await window.getByTestId(`sidebar-work-entry-${ENTRY_ID}-invite`).click();
    await expect(
      window.getByTestId('shared-container-invite-modal'),
    ).toBeVisible();
    await expandScopeDetails(window);
    await window
      .getByTestId('shared-container-invite-modal-file-scope-folder-evidence')
      .check();
    await selectMember(window, 'Ada Lovelace');
    await window.getByTestId('shared-container-invite-submit').click();
    await expect(
      window.getByTestId('shared-container-invite-modal-recipients'),
    ).toContainText('Ada Lovelace');
    await window.getByTestId('shared-container-invite-done').click();
    await expect(
      window.getByTestId('shared-container-invite-modal'),
    ).toHaveCount(0);

    await expect(badge).toBeVisible({ timeout: 15_000 });
    await expect(badge).toHaveAttribute('aria-label', 'Shared with teammates');

    // Read the computed opacity rather than class names: an unlayered
    // `border-color` rule makes class-name inspection unreliable for this kind
    // of assertion (CAN-2734).
    const badgeOpacity = async () =>
      badge.evaluate((node) => getComputedStyle(node).opacity);
    await window.mouse.move(0, 0);
    await expect.poll(badgeOpacity).toBe('1');

    await row.hover();
    await expect(
      window.getByTestId(`sidebar-work-entry-${ENTRY_ID}-menu`),
    ).toBeVisible();
    // Faded, not unmounted: the footprint stays so nothing on the row jumps.
    await expect.poll(badgeOpacity).toBe('0');
    await expect(badge).toHaveCount(1);

    await window.mouse.move(0, 0);
    await expect.poll(badgeOpacity).toBe('1');
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
    }
  }
});

test('shows an actionable Git LFS publication refusal after a code-worktree invite', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-lfs-'),
  );
  const fixture = seedCodeSharedContainer(userDataDir);
  writeFileSync(
    path.join(fixture.worktreePath, '.gitattributes'),
    '*.bin filter=lfs diff=lfs merge=lfs -text\n',
    'utf8',
  );
  execFileSync('git', ['add', '.gitattributes'], {
    cwd: fixture.worktreePath,
    stdio: 'ignore',
  });
  execFileSync('git', ['commit', '-m', 'Add LFS fixture'], {
    cwd: fixture.worktreePath,
    stdio: 'ignore',
  });
  await registerFixture();
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(userDataDir),
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectSharedContainersAccount(window);
    await app.openMainPage();
    await app.selectWorktree('demo-main');
    const row = window.locator(
      '[data-testid="worktree-row"][data-worktree-id="demo-main"]',
    );
    await row.hover();
    await row.getByTestId('worktree-actions-menu-button').click();
    await window.getByTestId('worktree-actions-menu-invite').click();
    await selectMember(window, 'Ada Lovelace');
    await window.getByTestId('shared-container-invite-submit').click();

    await expect(
      window.getByTestId(
        'shared-container-invite-modal-publication-error-reason',
      ),
    ).toContainText('Git LFS', { timeout: 30_000 });
    await expect(
      window.getByTestId('shared-container-invite-modal-publication-state'),
    ).toContainText('contents are not available');
    const retry = window.getByTestId(
      'shared-container-invite-modal-publication-retry',
    );
    await expect(retry).toHaveText('Try again');
    await retry.click();
    await expect(
      window.getByTestId(
        'shared-container-invite-modal-publication-error-reason',
      ),
    ).toContainText('Git LFS', { timeout: 30_000 });
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, SHARED_CONTAINERS_CLOUD_API_KEY);
    cleanupDemoWorkspaces(fixture.result);
  }
});

/**
 * CAN-2727: an in-repo committed symlink used to refuse the whole revision at
 * inventory time. It must now be admitted and produce a published revision.
 */
test('admits an in-repo committed symlink instead of refusing the revision', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-symlink-'),
  );
  const fixture = seedCodeSharedContainer(userDataDir);
  writeFileSync(
    path.join(fixture.worktreePath, 'symlink-target.txt'),
    'target\n',
    'utf8',
  );
  symlinkSync(
    'symlink-target.txt',
    path.join(fixture.worktreePath, 'link.txt'),
  );
  execFileSync('git', ['add', 'symlink-target.txt', 'link.txt'], {
    cwd: fixture.worktreePath,
    stdio: 'ignore',
  });
  execFileSync('git', ['commit', '-m', 'Add symlink fixture'], {
    cwd: fixture.worktreePath,
    stdio: 'ignore',
  });
  await registerFixture();
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(userDataDir),
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectSharedContainersAccount(window);
    await app.openMainPage();
    await app.selectWorktree('demo-main');
    const row = window.locator(
      '[data-testid="worktree-row"][data-worktree-id="demo-main"]',
    );
    await row.hover();
    await row.getByTestId('worktree-actions-menu-button').click();
    await window.getByTestId('worktree-actions-menu-invite').click();

    // The symlink points inside the repository, so the owner gets no
    // withholding warning about it before inviting. The notice lives inside
    // the Details expander, so open it first: a collapsed expander would make
    // this absence assertion pass for the wrong reason.
    await expandScopeDetails(window);
    await expect(
      window.getByTestId('shared-container-invite-modal-withheld-symlinks'),
    ).toHaveCount(0);

    await selectMember(window, 'Ada Lovelace');
    await window.getByTestId('shared-container-invite-submit').click();

    await expect(
      window.getByText('Invited Ada Lovelace', { exact: true }),
    ).toBeVisible();
    const state = window.getByTestId(
      'shared-container-invite-modal-publication-state',
    );
    // The heading status settles from a spinner to the quiet resting label;
    // the revision lives in `title` so the heading does not read like a log.
    await expect(state).toHaveAttribute('data-publish-status', 'published', {
      timeout: 60_000,
    });
    await expect(state).toHaveAttribute('title', 'Revision 1');
    await expect(state).toHaveText('Up to date');
    await expect(state).not.toContainText('symbolic link');
    await expect
      .poll(async () => {
        const { activity } = await getScenarioActivity(
          DEFAULT_MOCK_BASE_URL,
          SHARED_CONTAINERS_CLOUD_API_KEY,
        );
        return activity.sharedContainersCommit ?? 0;
      })
      .toBe(1);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, SHARED_CONTAINERS_CLOUD_API_KEY);
    cleanupDemoWorkspaces(fixture.result);
  }
});

/**
 * CAN-2727: a symlink whose target leaves the repository is withheld, not
 * refused, and the owner is told which path it was. The path is disclosed
 * owner-side only; the wire revision layout stays path-free.
 */
test('names the escaping symlinks it withholds from the owner', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-escaping-symlink-'),
  );
  const fixture = seedCodeSharedContainer(userDataDir);
  const escapingPath = path.join(fixture.worktreePath, 'escaping-link.txt');
  writeFileSync(escapingPath, 'base\n', 'utf8');
  execFileSync('git', ['add', 'escaping-link.txt'], {
    cwd: fixture.worktreePath,
    stdio: 'ignore',
  });
  execFileSync('git', ['commit', '-m', 'seed escaping symlink fixture'], {
    cwd: fixture.worktreePath,
    stdio: 'ignore',
  });
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: fixture.worktreePath,
    encoding: 'utf8',
  }).trim();
  execFileSync('git', ['update-ref', `refs/remotes/origin/${branch}`, 'HEAD'], {
    cwd: fixture.worktreePath,
    stdio: 'ignore',
  });
  unlinkSync(escapingPath);
  symlinkSync('../../outside-secret.txt', escapingPath);
  await registerFixture();
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(userDataDir),
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectSharedContainersAccount(window);
    await app.openMainPage();
    await app.selectWorktree('demo-main');

    const row = window.locator(
      '[data-testid="worktree-row"][data-worktree-id="demo-main"]',
    );
    await row.hover();
    await row.getByTestId('worktree-actions-menu-button').click();
    await window.getByTestId('worktree-actions-menu-invite').click();

    await expandScopeDetails(window);
    await expect(
      window.getByTestId('shared-container-invite-modal-withheld-symlinks'),
    ).toContainText('escaping-link.txt', { timeout: 30_000 });
    await expect(
      window.getByTestId('shared-container-invite-modal-withheld-files'),
    ).toContainText('link outside the repository');
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
      cleanupDemoWorkspaces(fixture.result);
    }
  }
});

test('saves the publisher layout at the first invite, updates it, and turns it off', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-layout-row-'),
  );
  const fixture = seedCodeSharedContainer(userDataDir);
  await registerFixture();
  const persistedLayout = () =>
    readPersistedFileScope(userDataDir, fixture.projectId, fixture.worktreeId)
      ?.preferredLayout;
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(userDataDir),
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectSharedContainersAccount(window);
    await openWorktreeShare(window, app);

    // The row sits in the scope panel itself, not behind Advanced. It is a
    // plain switch, on before any choice is stored, with nothing saved until
    // the first share.
    const layoutRow = window.getByTestId('shared-container-layout-row');
    await expect(layoutRow).toBeVisible({ timeout: 30_000 });
    const layoutSwitch = layoutRow.getByRole('switch', {
      name: 'Open to my layout',
    });
    const updateAction = window.getByTestId(
      'shared-container-layout-row-update',
    );
    await expect(layoutSwitch).toHaveAttribute('aria-checked', 'true');
    await expect(layoutRow).toHaveText('Open to my layout');
    await expect(updateAction).toHaveCount(0);
    expect(persistedLayout()).toBeUndefined();

    // The first invite saves the layout on screen, and the row offers to
    // update it without the dialog being reopened.
    await selectMember(window, 'Ada Lovelace');
    await window.getByTestId('shared-container-invite-submit').click();
    await expect(
      window.getByTestId('shared-container-invite-modal-recipients'),
    ).toContainText('Ada Lovelace');
    await expect(updateAction).toHaveText('Update to current layout', {
      timeout: 30_000,
    });
    await expect.poll(persistedLayout).toMatchObject({
      enabled: true,
      snapshot: { pinnedAt: expect.any(String), layout: { version: 1 } },
    });
    const firstPinnedAt = persistedLayout().snapshot.pinnedAt;

    // Updating replaces the saved layout with the current one.
    await updateAction.click();
    await expect
      .poll(() => persistedLayout()?.snapshot?.pinnedAt)
      .not.toBe(firstPinnedAt);
    expect(persistedLayout()).toMatchObject({ enabled: true });
    await expect(updateAction).toBeVisible();

    // Turning it off drops the saved layout, so no later revision ships one.
    await layoutSwitch.click();
    await expect(layoutSwitch).toHaveAttribute('aria-checked', 'false');
    await expect(layoutRow).toHaveText('Open to my layout');
    await expect(updateAction).toHaveCount(0);
    await expect.poll(persistedLayout).toEqual({ enabled: false });
    await expect
      .poll(async () => {
        const uiStateResponse = await getAdvisorUiState(electronApp);
        return uiStateResponse.uiState?.snapshot?.sharedContainersInviteModal
          ?.preferredLayoutEnabled;
      })
      .toBe(false);

    // Turning it back on saves the current layout again.
    await layoutSwitch.click();
    await expect(layoutSwitch).toHaveAttribute('aria-checked', 'true');
    await expect(updateAction).toBeVisible();
    await expect.poll(persistedLayout).toMatchObject({
      enabled: true,
      snapshot: { pinnedAt: expect.any(String) },
    });
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, SHARED_CONTAINERS_CLOUD_API_KEY);
    cleanupDemoWorkspaces(fixture.result);
  }
});

test('shares a non-GitHub repository as a named code snapshot', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-non-github-'),
  );
  const fixture = seedCodeSharedContainer(userDataDir);
  execFileSync(
    'git',
    ['remote', 'set-url', 'origin', 'https://gitlab.com/acme/app.git'],
    { cwd: fixture.worktreePath, stdio: 'ignore' },
  );
  await registerFixture();
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(userDataDir),
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectSharedContainersAccount(window);
    await openWorktreeShare(window, app);

    await expect(
      window.getByTestId('shared-container-invite-modal-member-picker'),
    ).toBeVisible({ timeout: 30_000 });
    // Informational, so the disclosure sits behind Advanced.
    await expandScopeDetails(window);
    const disclosure = window.getByTestId(
      'shared-container-invite-modal-snapshot-disclosure',
    );
    await expect(disclosure).toContainText('Project root');
    await expect(disclosure).toContainText('is sent through');
    await expect(disclosure).toContainText("isn't on GitHub");
    await expect(
      window.getByTestId('shared-container-invite-blocked'),
    ).toHaveCount(0);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, SHARED_CONTAINERS_CLOUD_API_KEY);
    cleanupDemoWorkspaces(fixture.result);
  }
});

test('publishes an unborn snapshot without offering its files as optional approvals', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-unborn-snapshot-'),
  );
  const fixture = seedCodeSharedContainer(userDataDir);
  execFileSync('git', ['update-ref', '-d', 'HEAD'], {
    cwd: fixture.worktreePath,
    stdio: 'ignore',
  });
  writeFileSync(
    path.join(fixture.worktreePath, 'snapshot-only.txt'),
    'Included by the parentless snapshot.\n',
    'utf8',
  );
  await registerFixture();
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(userDataDir),
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectSharedContainersAccount(window);
    await openWorktreeShare(window, app);

    // The snapshot disclosure is informational, so it sits behind Advanced.
    await expandScopeDetails(window);
    await expect(
      window.getByTestId('shared-container-invite-modal-snapshot-disclosure'),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      window.getByTestId(
        'shared-container-invite-modal-file-review-snapshot-only.txt',
      ),
    ).toHaveCount(0);

    await selectMember(window, 'Ada Lovelace');
    await window.getByTestId('shared-container-invite-submit').click();
    await expect(
      window.getByTestId('shared-container-invite-modal-publication-state'),
    ).toHaveAttribute('data-publish-status', 'published', { timeout: 60_000 });
    await expect
      .poll(async () => {
        const { activity } = await getScenarioActivity(
          DEFAULT_MOCK_BASE_URL,
          SHARED_CONTAINERS_CLOUD_API_KEY,
        );
        return activity.sharedContainersCommit ?? 0;
      })
      .toBe(1);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, SHARED_CONTAINERS_CLOUD_API_KEY);
    cleanupDemoWorkspaces(fixture.result);
  }
});

test('keeps an unpushed commit shareable and names it in the scope summary', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-unpushed-'),
  );
  const fixture = seedCodeSharedContainer(userDataDir);
  const remoteHead = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: fixture.worktreePath,
    encoding: 'utf8',
  }).trim();
  writeFileSync(
    path.join(fixture.worktreePath, 'unpushed.txt'),
    'This commit is carried in the shared overlay.\n',
    'utf8',
  );
  execFileSync('git', ['add', 'unpushed.txt'], {
    cwd: fixture.worktreePath,
    stdio: 'ignore',
  });
  execFileSync('git', ['commit', '-m', 'Unpushed shared commit'], {
    cwd: fixture.worktreePath,
    stdio: 'ignore',
  });
  const branchName = execFileSync(
    'git',
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    { cwd: fixture.worktreePath, encoding: 'utf8' },
  ).trim();
  const remoteRefs = execFileSync(
    'git',
    ['for-each-ref', '--format=%(refname)', 'refs/remotes'],
    { cwd: fixture.worktreePath, encoding: 'utf8' },
  )
    .split('\n')
    .filter(Boolean);
  for (const ref of remoteRefs) {
    execFileSync('git', ['update-ref', '-d', ref], {
      cwd: fixture.worktreePath,
      stdio: 'ignore',
    });
  }
  execFileSync(
    'git',
    ['update-ref', `refs/remotes/origin/${branchName}`, remoteHead],
    { cwd: fixture.worktreePath, stdio: 'ignore' },
  );
  try {
    execFileSync('git', ['branch', '--unset-upstream'], {
      cwd: fixture.worktreePath,
      stdio: 'ignore',
    });
  } catch {
    // A branch with no upstream is already in the intended fixture state.
  }
  const github = {
    commits: { [`acme/app/${remoteHead}`]: { sha: remoteHead } },
  };
  await registerFixture({ github });
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(userDataDir, {
        CANOPY_E2E_GIT_REMOTE_SHA: remoteHead,
      }),
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectSharedContainersAccount(window);
    await openWorktreeShare(window, app);

    await expect(
      window.getByTestId('shared-container-invite-modal-member-picker'),
    ).toBeVisible({ timeout: 30_000 });
    await expandScopeDetails(window);
    await expect(
      window.getByTestId('shared-container-invite-modal-scope-summary'),
    ).toContainText('1 commit not on GitHub yet');
    await expect(
      window.getByTestId('shared-container-invite-blocked'),
    ).toHaveCount(0);
    await expect(
      window.getByTestId('shared-container-invite-push-github'),
    ).toHaveCount(0);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, SHARED_CONTAINERS_CLOUD_API_KEY);
    cleanupDemoWorkspaces(fixture.result);
  }
});

test('advances automatically when cloud registration finishes', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-registering-'),
  );
  const fixture = seedCodeSharedContainer(userDataDir);
  await registerFixture();
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(userDataDir),
    }));
    await electronApp.evaluate(({ ipcMain }, serverWorktreeExternalId) => {
      let callCount = 0;
      ipcMain.removeHandler('shared-containers:eligibility');
      ipcMain.handle('shared-containers:eligibility', () => {
        callCount += 1;
        return callCount === 1
          ? { eligible: false, reason: 'not-yet-synced' }
          : {
              eligible: true,
              serverWorktreeExternalId,
            };
      });
    }, CODE_SERVER_WORKTREE_ID);
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectSharedContainersAccount(window);
    await openWorktreeShare(window, app);

    await expect(
      window.getByTestId('shared-container-invite-registration-pending'),
    ).toContainText('Getting this project ready to share', {
      timeout: 30_000,
    });
    await expect(
      window.getByTestId('shared-container-invite-modal-member-picker'),
    ).toBeVisible({ timeout: 30_000 });
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, SHARED_CONTAINERS_CLOUD_API_KEY);
    cleanupDemoWorkspaces(fixture.result);
  }
});

test('offers Try again after registration fails and recovers in place', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-registration-retry-'),
  );
  const fixture = seedCodeSharedContainer(userDataDir);
  await registerFixture();
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(userDataDir),
    }));
    await electronApp.evaluate(({ ipcMain }, serverWorktreeExternalId) => {
      let callCount = 0;
      ipcMain.removeHandler('shared-containers:eligibility');
      ipcMain.handle('shared-containers:eligibility', () => {
        callCount += 1;
        return callCount === 1
          ? { eligible: false, reason: 'registration-failed' }
          : {
              eligible: true,
              serverWorktreeExternalId,
            };
      });
    }, CODE_SERVER_WORKTREE_ID);
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectSharedContainersAccount(window);
    await openWorktreeShare(window, app);

    const failure = window.getByTestId(
      'shared-container-invite-registration-failed',
    );
    await expect(failure).toContainText("Couldn't get this project ready", {
      timeout: 30_000,
    });
    const retry = window.getByTestId(
      'shared-container-invite-registration-retry',
    );
    await expect(retry).toHaveText('Try again');
    await retry.click();
    await expect(
      window.getByTestId('shared-container-invite-modal-member-picker'),
    ).toBeVisible({ timeout: 30_000 });
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, SHARED_CONTAINERS_CLOUD_API_KEY);
    cleanupDemoWorkspaces(fixture.result);
  }
});

test('explains when a project anchor belongs to another organization', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-anchor-conflict-'),
  );
  const fixture = seedCodeSharedContainer(userDataDir, {
    anchorOrganizationId: SHARED_CONTAINERS_ORGANIZATION_ID,
  });
  await registerFixture({
    cloud: {
      organizations: [
        {
          id: SHARED_CONTAINERS_ORGANIZATION_ID,
          name: 'Original Sharing Org',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: OTHER_SHARED_CONTAINERS_ORGANIZATION_ID,
          name: 'Other Sharing Org',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    },
  });
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(userDataDir),
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectSharedContainersAccount(window);
    await app.openMainPage();
    await app.selectWorktree('demo-main');

    const row = window.locator(
      '[data-testid="worktree-row"][data-worktree-id="demo-main"]',
    );
    await row.hover();
    await row.getByTestId('worktree-actions-menu-button').click();
    await window.getByTestId('worktree-actions-menu-invite').click();
    await window
      .getByTestId(
        `shared-container-invite-modal-organization-option-${OTHER_SHARED_CONTAINERS_ORGANIZATION_ID}`,
      )
      .click();

    const refusal = window.getByTestId('shared-container-invite-blocked');
    await expect(refusal).toContainText(
      'already shared through Original Sharing Org',
      { timeout: 15_000 },
    );
    await expect(refusal).not.toContainText('Try again');
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
      cleanupDemoWorkspaces(fixture.result);
    }
  }
});

test('lets an owner switch away from a blocked organization', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-blocked-org-switch-'),
  );
  const fixture = seedCodeSharedContainer(userDataDir, {
    anchorOrganizationId: OTHER_SHARED_CONTAINERS_ORGANIZATION_ID,
  });
  await registerFixture({
    cloud: {
      organizations: [
        {
          id: SHARED_CONTAINERS_ORGANIZATION_ID,
          name: 'Blocked Default Org',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: OTHER_SHARED_CONTAINERS_ORGANIZATION_ID,
          name: 'Shareable Org',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    },
  });
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(userDataDir),
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectSharedContainersAccount(window);
    await app.openMainPage();
    await app.selectWorktree('demo-main');

    const row = window.locator(
      '[data-testid="worktree-row"][data-worktree-id="demo-main"]',
    );
    await row.hover();
    await row.getByTestId('worktree-actions-menu-button').click();
    await window.getByTestId('worktree-actions-menu-invite').click();
    await window
      .getByTestId(
        `shared-container-invite-modal-organization-option-${SHARED_CONTAINERS_ORGANIZATION_ID}`,
      )
      .click();
    await expect(
      window.getByTestId('shared-container-invite-blocked'),
    ).toContainText('already shared through Shareable Org', {
      timeout: 15_000,
    });

    await window
      .getByTestId(
        `shared-container-invite-modal-organization-option-${OTHER_SHARED_CONTAINERS_ORGANIZATION_ID}`,
      )
      .click();
    await expect(
      window.getByTestId('shared-container-invite-modal-member-picker'),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      window.getByTestId('shared-container-invite-blocked'),
    ).toHaveCount(0);
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
      cleanupDemoWorkspaces(fixture.result);
    }
  }
});

test('hides the worktree invite entry point while rollout is disabled', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-disabled-code-hidden-'),
  );
  const fixture = seedCodeSharedContainer(userDataDir);
  await registerFixture();
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(
        userDataDir,
        SHARED_CONTAINERS_DISABLED_ENV,
      ),
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectSharedContainersAccount(window);
    await app.openMainPage();
    await app.selectWorktree('demo-main');

    const row = window.locator(
      '[data-testid="worktree-row"][data-worktree-id="demo-main"]',
    );
    await row.hover();
    await row.getByTestId('worktree-actions-menu-button').click();
    // Asserting a sibling item is visible first proves the menu actually
    // opened, so an absent invite item is a real absence.
    await expect(
      window.getByTestId('worktree-actions-menu-info'),
    ).toBeVisible();
    await expect(
      window.getByTestId('worktree-actions-menu-invite'),
    ).toHaveCount(0);
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
      cleanupDemoWorkspaces(fixture.result);
    }
  }
});

test('hides the Cowork Work Entry invite entry point while rollout is disabled', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-disabled-cowork-hidden-'),
  );
  const fixture = seedCoworkSharedContainer(userDataDir);
  await registerFixture();
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(
        userDataDir,
        SHARED_CONTAINERS_DISABLED_ENV,
      ),
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectSharedContainersAccount(window);
    await app.openMainPage();
    await expandCoworkWorkspace(window, fixture.projectId);
    await openWorkEntryMenu(window, ENTRY_ID);

    await expect(
      window.getByTestId(`sidebar-work-entry-${ENTRY_ID}-rename`),
    ).toBeVisible();
    await expect(
      window.getByTestId(`sidebar-work-entry-${ENTRY_ID}-invite`),
    ).toHaveCount(0);
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
      cleanupDemoWorkspaces(fixture.result);
    }
  }
});

/**
 * CAN-2551. The inverse of the flag-off pair above: rollout ON, with the
 * account's only organization billing-lapsed. The entry point must REMAIN
 * present.
 *
 * A lapse is not a flag-off. It leaves live grants outstanding, and this menu
 * item is the only surface anywhere for revoking them — the server keeps
 * `listSharedByMe`, `listContainerRecipients`, and `revokeContainerGrant`
 * authorized on organization membership rather than a current entitlement for
 * exactly that reason, and `InviteTeammateModal` renders a dedicated
 * management path for the `blocked-by-org-billing` refusal. Hiding the item
 * would strand a departed teammate's access with no way to remove it. This
 * pins the invariant commit `9728d7bdea` established.
 *
 * The `cloud.orgBillingStates` override is load-bearing: the fixture's
 * hardcoded default is `teamsEntitled: true`, so without it these specs would
 * pass vacuously.
 */
const LAPSED_ORG_BILLING_STATES = [
  {
    organizationId: SHARED_CONTAINERS_ORGANIZATION_ID,
    organizationName: 'Shared Containers E2E',
    teamsEntitled: false,
  },
];

test('offers Public personal sharing when every organization is billing-lapsed', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-lapsed-public-'),
  );
  const fixture = seedCodeSharedContainer(userDataDir);
  await registerFixture({
    cloud: { orgBillingStates: LAPSED_ORG_BILLING_STATES },
  });
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(
        userDataDir,
        SHARED_CONTAINERS_EXTERNAL_ENV,
      ),
    }));
    await electronApp.evaluate(({ ipcMain }, serverWorktreeExternalId) => {
      ipcMain.removeHandler('shared-containers:eligibility');
      ipcMain.handle('shared-containers:eligibility', (_event, request) => {
        if (request.audience !== 'public') {
          throw new Error(
            `Expected Public eligibility, got ${request.audience}`,
          );
        }
        return {
          eligible: true,
          serverWorktreeExternalId,
          audiences: { team: false, organization: false, public: true },
          ownerFixed: false,
        };
      });
    }, CODE_SERVER_WORKTREE_ID);
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectSharedContainersAccount(window);
    await openWorktreeShare(window, app);

    // Public is selected on its own; one usable scope hides the selector.
    await expect(
      window.getByTestId('shared-container-invite-modal-email-input'),
    ).toBeVisible();
    await expect(
      window.getByTestId('shared-container-invite-scope'),
    ).toHaveCount(0);
    await expect(
      window.getByTestId('shared-container-invite-orgs-ineligible'),
    ).toHaveCount(0);
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
      cleanupDemoWorkspaces(fixture.result);
    }
  }
});

test('keeps the worktree invite entry point when every organization is billing-lapsed', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-lapsed-code-shown-'),
  );
  const fixture = seedCodeSharedContainer(userDataDir);
  await registerFixture({
    cloud: { orgBillingStates: LAPSED_ORG_BILLING_STATES },
  });
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(userDataDir),
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectSharedContainersAccount(window);
    await app.openMainPage();
    await app.selectWorktree('demo-main');

    const row = window.locator(
      '[data-testid="worktree-row"][data-worktree-id="demo-main"]',
    );
    await row.hover();
    await row.getByTestId('worktree-actions-menu-button').click();
    // Sibling item first, so a present invite item is read from a menu that is
    // provably open.
    await expect(
      window.getByTestId('worktree-actions-menu-info'),
    ).toBeVisible();
    await expect(
      window.getByTestId('worktree-actions-menu-invite'),
    ).toBeVisible();
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
      cleanupDemoWorkspaces(fixture.result);
    }
  }
});

test('keeps the Cowork Work Entry invite entry point when every organization is billing-lapsed', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-lapsed-cowork-shown-'),
  );
  const fixture = seedCoworkSharedContainer(userDataDir);
  await registerFixture({
    cloud: { orgBillingStates: LAPSED_ORG_BILLING_STATES },
  });
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(userDataDir),
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectSharedContainersAccount(window);
    await app.openMainPage();
    await expandCoworkWorkspace(window, fixture.projectId);
    await openWorkEntryMenu(window, ENTRY_ID);

    await expect(
      window.getByTestId(`sidebar-work-entry-${ENTRY_ID}-rename`),
    ).toBeVisible();
    await expect(
      window.getByTestId(`sidebar-work-entry-${ENTRY_ID}-invite`),
    ).toBeVisible();
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
      cleanupDemoWorkspaces(fixture.result);
    }
  }
});

test('wraps a deep untracked path without scrolling the invite dialog sideways', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-deep-path-'),
  );
  const fixture = seedCodeSharedContainer(userDataDir, {
    seedDeepUntrackedPath: true,
  });
  await registerFixture();
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(userDataDir),
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectSharedContainersAccount(window);
    await app.openMainPage();
    await app.selectWorktree('demo-main');

    const row = window.locator(
      '[data-testid="worktree-row"][data-worktree-id="demo-main"]',
    );
    await row.hover();
    await row.getByTestId('worktree-actions-menu-button').click();
    await window.getByTestId('worktree-actions-menu-invite').click();

    await expandScopeDetails(window);
    const checkbox = window.getByTestId(
      `shared-container-invite-modal-file-review-${DEEP_UNTRACKED_PATH}`,
    );
    await expect(checkbox).toBeVisible({ timeout: 15_000 });

    // The whole path has to be readable: the owner is deciding whether this
    // file leaves their machine, and the basename is the part that identifies
    // it. A clipped label renders the same textContent, so assert geometry.
    const label = window
      .locator('label')
      .filter({ has: checkbox })
      .getByText(DEEP_UNTRACKED_PATH, { exact: true });
    const body = window
      .getByTestId('shared-container-invite-modal-file-scope')
      .locator('xpath=ancestor::*[contains(@class,"overflow-y-auto")][1]');

    // Measure both before asserting, so one run reports every symptom rather
    // than stopping at whichever fires first.
    const [overflow, bodyOverflow] = await Promise.all([
      label.evaluate((node) => {
        // ChoiceField's text block owns the available width. The path span
        // is inline; a Range reports one rect per painted line.
        const block = node.parentElement;
        const range = node.ownerDocument.createRange();
        range.selectNodeContents(node);
        return {
          scrollWidth: block.scrollWidth,
          clientWidth: block.clientWidth,
          lineCount: range.getClientRects().length,
        };
      }),
      body.evaluate((node) => ({
        scrollWidth: node.scrollWidth,
        clientWidth: node.clientWidth,
      })),
    ]);

    // The row must not push a horizontal scrollbar onto the dialog body.
    expect(bodyOverflow.scrollWidth).toBeLessThanOrEqual(
      bodyOverflow.clientWidth,
    );
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
    expect(overflow.clientWidth).toBeGreaterThan(0);
    // Wrapped, not clipped to one line.
    expect(overflow.lineCount).toBeGreaterThan(1);

    // Still an operable control after the layout change: shared by default,
    // so unticking it records an exclusion.
    await expect(checkbox).toBeChecked();
    await checkbox.uncheck();
    await expect
      .poll(
        async () =>
          (
            await readPersistedFileScope(
              userDataDir,
              fixture.projectId,
              fixture.worktreeId,
            )
          )?.excludedPaths ?? [],
      )
      .toContain(DEEP_UNTRACKED_PATH);
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
      cleanupDemoWorkspaces(fixture.result);
    }
  }
});

test('reviews every repository and persists a child-repo file opt-out for a multi-repo worktree', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-multi-repo-'),
  );
  const fixture = seedMultiRepoCodeSharedContainer(userDataDir);
  await registerFixture();
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(userDataDir),
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectSharedContainersAccount(window);
    await app.openMainPage();
    await app.selectWorktree('demo-main');

    const row = window.locator(
      '[data-testid="worktree-row"][data-worktree-id="demo-main"]',
    );
    await row.hover();
    await row.getByTestId('worktree-actions-menu-button').click();
    await window.getByTestId('worktree-actions-menu-invite').click();

    // Every repository's remote and base commit is disclosed inside the
    // Advanced expander.
    await expandScopeDetails(window);
    const details = window.getByTestId(
      'shared-container-invite-modal-scope-details-body',
    );
    await expect(details).toContainText(
      'Web App: https://github.com/acme/web.git',
    );
    await expect(details).toContainText(
      'API Service: https://github.com/acme/api.git',
    );
    const childFilePath = 'repos/web/share-web-note.txt';
    const childFile = window.getByTestId(
      `shared-container-invite-modal-file-review-${childFilePath}`,
    );
    await expect(childFile).toBeChecked();
    await childFile.uncheck();
    await expect
      .poll(
        async () =>
          (
            await readPersistedFileScope(
              userDataDir,
              fixture.projectId,
              fixture.worktreeId,
            )
          )?.excludedPaths ?? [],
      )
      .toContain(childFilePath);
  } catch (error) {
    // This test has failed on CI with the share preview still pending and
    // nothing on screen to say why; the main process knows what it was doing.
    await attachMainProcessLog(userDataDir);
    throw error;
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
      cleanupDemoWorkspaces(fixture.result);
    }
  }
});

// The fixture's repositories have github.com remotes. GitHub answers 401 for
// them, so git asks a credential helper; on the self-hosted macOS pool that
// helper never answers. Without network access git fails at once instead and
// this test passes for that reason, so it cannot fail falsely offline.
test('shows the share preview while the repository remotes wait on credentials', async () => {
  test.skip(
    process.platform === 'win32',
    'The blocking credential helper is a POSIX shell command.',
  );
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-remote-wait-'),
  );
  const fixture = seedMultiRepoCodeSharedContainer(userDataDir);
  await registerFixture();
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: {
        ...buildSharedContainerE2eEnv(userDataDir),
        // Replace every configured helper (an empty value resets the list)
        // with one that never answers within the preview's wait.
        GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_KEY_0: 'credential.helper',
        GIT_CONFIG_VALUE_0: '',
        GIT_CONFIG_KEY_1: 'credential.helper',
        GIT_CONFIG_VALUE_1: '!sleep 90 #',
      },
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectSharedContainersAccount(window);
    await openWorktreeShare(window, app);

    await expandScopeDetails(window);
    await expect(
      window.getByTestId('shared-container-invite-modal-scope-details-body'),
    ).toContainText('Web App: https://github.com/acme/web.git');
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
      cleanupDemoWorkspaces(fixture.result);
    }
  }
});

test('disables Cowork file choices that do not fit the share budget', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-cowork-file-budget-'),
  );
  const fixture = seedCoworkSharedContainer(userDataDir);
  // Manifest + 196 chats + the default-included note and prompt leave
  // exactly one of the three files inside the
  // protocol's 200-artifact ceiling. Make the absolute-path reference older
  // than its peers so only reference ranking can keep it inside that slot.
  const referencedFilePath = path.join(
    userDataDir,
    'workspaces',
    fixture.projectId,
    'home',
    COWORK_ROOT_FILE_PATH,
  );
  utimesSync(referencedFilePath, new Date(0), new Date(0));
  saturateCoworkArtifactBudget(
    userDataDir,
    fixture.projectId,
    referencedFilePath,
  );
  await registerFixture();
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(userDataDir),
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectSharedContainersAccount(window);
    await app.openMainPage();
    await expandCoworkWorkspace(window, fixture.projectId);
    await openWorkEntryMenu(window, ENTRY_ID);
    await window.getByTestId(`sidebar-work-entry-${ENTRY_ID}-invite`).click();
    // Previewing the 196 saturating chats takes about 15s on its own, so the
    // default wait is too tight here.
    await expandScopeDetails(window, { timeout: 60_000 });
    await expect(
      window.getByTestId('shared-container-invite-modal-scope-summary'),
    ).toContainText(`1 of ${COWORK_CANDIDATE_FILE_PATHS.length} files`);

    await expect(
      window.getByTestId(
        `shared-container-invite-modal-file-review-${COWORK_ROOT_FILE_PATH}`,
      ),
    ).toBeChecked();
    const cappedFiles = window.locator(
      '[data-testid^="shared-container-invite-modal-file-review-"]:not(:checked)',
    );
    await expect(cappedFiles).toHaveCount(2);
    for (const cappedFile of await cappedFiles.all()) {
      await expect(cappedFile).toBeDisabled();
    }
    await expect(
      window.getByTestId(
        'shared-container-invite-modal-file-scope-folder-evidence',
      ),
    ).toBeDisabled();
    // Quiet by design: no warning, banner or blocker for the overflow.
    await expect(
      window.getByTestId(
        'shared-container-invite-modal-file-scope-budget-note',
      ),
    ).toHaveCount(0);
    await expect(
      window.getByTestId('shared-container-invite-modal-artifact-budget'),
    ).toHaveCount(0);
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
    }
  }
});

test('hides stale Cowork scope controls when the post-save preview refresh fails', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-cowork-preview-refresh-'),
  );
  const fixture = seedCoworkSharedContainer(userDataDir);
  await registerFixture();
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(userDataDir),
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectSharedContainersAccount(window);
    await app.openMainPage();
    await expandCoworkWorkspace(window, fixture.projectId);
    await openWorkEntryMenu(window, ENTRY_ID);
    await window.getByTestId(`sidebar-work-entry-${ENTRY_ID}-invite`).click();
    await expandScopeDetails(window);

    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('shared-containers:preview');
      ipcMain.handle('shared-containers:preview', () => {
        throw new Error('simulated post-save preview failure');
      });
    });
    await window
      .getByTestId(
        `shared-container-invite-modal-file-review-${COWORK_ROOT_FILE_PATH}`,
      )
      .uncheck();

    await expect(
      window.getByTestId('shared-container-invite-modal-preview-unavailable'),
    ).toContainText('Could not check what will be shared');
    await expect(
      window.getByTestId(
        `shared-container-invite-modal-file-review-${COWORK_ROOT_FILE_PATH}`,
      ),
    ).toHaveCount(0);
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
    }
  }
});

test('keeps a migrated transcript reference in the capped Cowork file preview', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-ranking-'),
  );
  const fixture = seedCoworkSharedContainer(userDataDir);
  const workspaceDir = path.join(userDataDir, 'workspaces', fixture.projectId);
  const home = path.join(workspaceDir, 'home');
  const referencedPath = path.join(home, 'referenced.txt');
  writeFileSync(referencedPath, 'Referenced evidence');
  utimesSync(referencedPath, new Date(0), new Date(0));
  const fillerDir = path.join(home, 'fillers');
  mkdirSync(fillerDir, { recursive: true });
  for (let index = 0; index < 1_000; index += 1) {
    writeFileSync(path.join(fillerDir, `${index}.txt`), 'Filler');
  }
  const chatPath = path.join(
    workspaceDir,
    'chats',
    `${fixture.worktreeId}.json`,
  );
  const tabs = JSON.parse(readFileSync(chatPath, 'utf8'));
  tabs.tabs[0].messages[0].blocks.push({ type: 'text', text: referencedPath });
  writeFileSync(chatPath, JSON.stringify(tabs));
  await registerFixture();
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(userDataDir),
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectSharedContainersAccount(window);
    await app.openMainPage();
    await expandCoworkWorkspace(window, fixture.projectId);
    // Loading the entry migrates its legacy fixture to canonical V2 storage.
    await window.getByTestId(`sidebar-work-entry-${ENTRY_ID}`).click();
    await expect
      .poll(() => {
        try {
          return (
            readChatStorageIndexes(workspaceDir, fixture.worktreeId).live
              .tabs[0]?.transcript?.committedMessageCount ?? 0
          );
        } catch {
          return 0;
        }
      })
      .toBeGreaterThan(0);
    await openWorkEntryMenu(window, ENTRY_ID);
    await window.getByTestId(`sidebar-work-entry-${ENTRY_ID}-invite`).click();
    await expandScopeDetails(window);
    await expect(
      window.getByTestId(
        'shared-container-invite-modal-file-review-referenced.txt',
      ),
    ).toBeChecked();
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
    }
  }
});

test('invites from a Cowork Work Entry', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-cowork-'),
  );
  const fixture = seedCoworkSharedContainer(userDataDir);
  await registerFixture();
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(userDataDir),
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectSharedContainersAccount(window);
    await app.openMainPage();
    await expandCoworkWorkspace(window, fixture.projectId);
    await openWorkEntryMenu(window, ENTRY_ID);

    // The menu grows to its widest action: "Invite a teammate" used to wrap
    // onto a second line and spill out of its fixed-height row.
    const inviteItem = window.getByTestId(
      `sidebar-work-entry-${ENTRY_ID}-invite`,
    );
    await expect(inviteItem).toBeVisible();
    const inviteLayout = await inviteItem.evaluate((element) => ({
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }));
    expect(inviteLayout.scrollHeight).toBeLessThanOrEqual(
      inviteLayout.clientHeight,
    );
    expect(inviteLayout.scrollWidth).toBeLessThanOrEqual(
      inviteLayout.clientWidth,
    );

    await inviteItem.click();

    // No card, no pills, and no summary until Advanced is opened. With only
    // Public usable the selector would hide; here it is the member flow, and
    // the Email description is covered by the external-sharing tests.
    await expect(
      window.getByTestId('shared-container-invite-modal-scope-summary'),
    ).toHaveCount(0);
    await expect(
      window.getByTestId('shared-container-invite-modal-scope-details-toggle'),
    ).toHaveText('Advanced');

    // The reported bug, from the owner's side. A Cowork share carries the
    // folder's files, so the summary has to say so — the modal used to offer
    // no file options at all, because the preview crashed on the long chat
    // message this fixture seeds.
    await expandScopeDetails(window);
    await expect(
      window.getByTestId('shared-container-invite-modal-scope-summary'),
    ).toContainText('Sharing this workspace:');
    await expect(
      window.getByTestId('shared-container-invite-modal-scope-summary'),
    ).toContainText(
      `${COWORK_CANDIDATE_FILE_PATHS.length} of ${COWORK_CANDIDATE_FILE_PATHS.length} files`,
    );

    const disclosure = window.getByTestId(
      'shared-container-invite-modal-disclosure',
    );
    // Both container types read as "this project": neither internal name
    // ("Work Entry", "worktree") is a term an invite recipient should have to
    // learn.
    await expect(disclosure).toContainText('this project');
    await expect(disclosure).not.toContainText('Work Entry');
    await expect(disclosure).toContainText('granted access');
    await expect(disclosure).toContainText('encrypted, read-only copy');

    // Every file is in by default, including the one at the workspace root
    // that the reporter never saw offered at all.
    await expect(
      window.getByTestId(
        `shared-container-invite-modal-file-review-${COWORK_ROOT_FILE_PATH}`,
      ),
    ).toBeChecked();
    await expect(
      window.getByTestId(
        'shared-container-invite-modal-file-scope-folder-evidence',
      ),
    ).toBeChecked();

    // The checkbox now runs the other way: unticking a folder records
    // exclusions rather than withdrawing approvals that were never granted.
    await window
      .getByTestId('shared-container-invite-modal-file-scope-folder-evidence')
      .uncheck();
    await expect
      .poll(() =>
        readPersistedFileScope(
          userDataDir,
          fixture.projectId,
          fixture.worktreeId,
        ),
      )
      .toMatchObject({
        version: 1,
        excludedPaths: COWORK_NESTED_FILE_PATHS,
      });
    await expect(
      window.getByTestId('shared-container-invite-modal-scope-summary'),
    ).toContainText(`1 of ${COWORK_CANDIDATE_FILE_PATHS.length} files`);

    // Putting them back clears the exclusion rather than adding an allowlist.
    // An all-defaults Cowork scope holds no decision, so the store drops the
    // file entirely rather than persisting an empty record — and the share is
    // back to carrying everything.
    const evidenceFolder = window.getByTestId(
      'shared-container-invite-modal-file-scope-folder-evidence',
    );
    await expect(async () => {
      await expect(evidenceFolder).toBeEnabled();
      await expect(evidenceFolder).not.toBeChecked();
      await window.waitForTimeout(100);
      await expect(evidenceFolder).toBeEnabled();
      await expect(evidenceFolder).not.toBeChecked();
    }).toPass({ timeout: 5_000 });
    await evidenceFolder.click();
    await expect
      .poll(() =>
        readPersistedFileScope(
          userDataDir,
          fixture.projectId,
          fixture.worktreeId,
        ),
      )
      .toBeNull();
    await expect(
      window.getByTestId('shared-container-invite-modal-scope-summary'),
    ).toContainText(
      `${COWORK_CANDIDATE_FILE_PATHS.length} of ${COWORK_CANDIDATE_FILE_PATHS.length} files`,
    );

    // Cowork notes and prompts are project-wide, and shared by default like
    // everything else: the owner unticks the ones to keep back.
    const workspaceItems = window.getByTestId(
      'shared-container-invite-modal-workspace-items',
    );
    await expect(workspaceItems).toContainText(
      'belong to the whole Cowork project',
    );
    await expect(workspaceItems).toContainText(
      'Included unless you untick them.',
    );
    const coworkNote = window.getByTestId(
      `shared-container-invite-modal-note-scope-${COWORK_NOTE_ID}`,
    );
    const coworkPrompt = window.getByTestId(
      `shared-container-invite-modal-prompt-scope-${COWORK_PROMPT_ID}`,
    );
    await expect(coworkNote).toBeChecked();
    await expect(coworkPrompt).toBeChecked();
    await coworkNote.uncheck();
    await expect
      .poll(() =>
        readPersistedFileScope(
          userDataDir,
          fixture.projectId,
          fixture.worktreeId,
        ),
      )
      .toMatchObject({ version: 1, excludedNoteIds: [COWORK_NOTE_ID] });
    await coworkPrompt.uncheck();
    await expect
      .poll(() =>
        readPersistedFileScope(
          userDataDir,
          fixture.projectId,
          fixture.worktreeId,
        ),
      )
      .toMatchObject({
        version: 1,
        // Unticking a prompt must not discard the earlier note exclusion.
        excludedNoteIds: [COWORK_NOTE_ID],
        excludedPromptIds: [COWORK_PROMPT_ID],
      });
    // ...nor quietly drop the files the share carries by default.
    await expect(
      window.getByTestId('shared-container-invite-modal-scope-summary'),
    ).toContainText(
      `${COWORK_CANDIDATE_FILE_PATHS.length} of ${COWORK_CANDIDATE_FILE_PATHS.length} files`,
    );

    // A file can vanish between two opens of the modal. The share is defined
    // by what is in the folder now, so the row goes with it and the summary
    // re-counts rather than offering a decision about a file that is gone.
    const removedPath = COWORK_NESTED_FILE_PATHS[0];
    unlinkSync(
      path.join(
        userDataDir,
        'workspaces',
        fixture.projectId,
        'home',
        ...removedPath.split('/'),
      ),
    );
    await window
      .getByTestId('shared-container-invite-modal')
      .getByRole('button', { name: 'Close' })
      .click();
    await openWorkEntryMenu(window, ENTRY_ID);
    await window.getByTestId(`sidebar-work-entry-${ENTRY_ID}-invite`).click();
    // The expander collapses again with the remounted modal.
    await expandScopeDetails(window);
    await expect(
      window.getByTestId('shared-container-invite-modal-scope-summary'),
    ).toContainText(
      `${COWORK_CANDIDATE_FILE_PATHS.length - 1} of ${COWORK_CANDIDATE_FILE_PATHS.length - 1} files`,
    );
    await expect(
      window.getByTestId(
        `shared-container-invite-modal-file-review-${removedPath}`,
      ),
    ).toHaveCount(0);
    await expect(
      window.getByTestId(
        `shared-container-invite-modal-file-review-${COWORK_ROOT_FILE_PATH}`,
      ),
    ).toBeChecked();

    await selectMember(window, 'Ada Lovelace');
    await window.getByTestId('shared-container-invite-submit').click();
    await expect(
      window.getByTestId('shared-container-invite-modal-recipients'),
    ).toContainText('Ada Lovelace');
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
    }
  }
});

test('discloses the capabilities a Cowork chat used once the background analysis finishes', async () => {
  // CAN-4655: the preview never analyzes in the foreground. The first preview
  // starts one background analysis; a later preview request (here, reopening
  // the dialog) reads its counts. The chat invokes a local custom skill, so
  // the share carries that skill.
  test.setTimeout(150_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-capabilities-'),
  );
  const fixture = seedCoworkSharedContainer(userDataDir);
  const skillDir = path.join(
    userDataDir,
    'skills',
    'custom:app',
    'refund-helper',
  );
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: refund-helper\ndescription: Draft a refund reply.\n---\n\nDraft a short refund reply.\n',
    'utf8',
  );
  const chatPath = path.join(
    userDataDir,
    'workspaces',
    fixture.projectId,
    'chats',
    `${ENTRY_ID}.json`,
  );
  const chats = JSON.parse(readFileSync(chatPath, 'utf8'));
  chats.tabs[0].messages.push({
    id: 'chat-refunds-skill-invocation',
    role: 'user',
    blocks: [{ type: 'text', text: '/refund-helper draft the reply' }],
    timestamp: Date.parse('2026-01-02T00:00:01.000Z'),
  });
  writeFileSync(chatPath, JSON.stringify(chats), 'utf8');
  await registerFixture();
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(userDataDir),
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectSharedContainersAccount(window);
    await app.openMainPage();
    await expandCoworkWorkspace(window, fixture.projectId);

    const capabilities = window.getByTestId(
      'shared-container-invite-modal-capabilities',
    );
    const openShare = async () => {
      await openWorkEntryMenu(window, ENTRY_ID);
      await window.getByTestId(`sidebar-work-entry-${ENTRY_ID}-invite`).click();
      await expandScopeDetails(window);
    };
    await expect(async () => {
      if (
        (await window.getByTestId('shared-container-invite-modal').count()) > 0
      ) {
        await window.keyboard.press('Escape');
        await expect(
          window.getByTestId('shared-container-invite-modal'),
        ).toHaveCount(0);
      }
      await openShare();
      await expect(capabilities).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 60_000, intervals: [1_000, 2_000, 3_000] });
    await expect(capabilities).toHaveText(
      'This share also carries the 1 skill used here. They install only if a teammate makes a copy.',
    );
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
    }
  }
});

// Personal work with work stats Off: registration needs metadata sharing, so
// the invite reports `sync-disabled` instead of waiting out retries. The owner
// recovers either through Privacy or with the inline personal opt-in, which
// raises work stats to Just me only.
async function launchPersonalSyncOffInvite(userDataDir) {
  seedCodeSharedContainer(userDataDir, { metadata: 'off' });
  await registerFixture({
    cloud: { organizations: [], teams: [], orgBillingStates: [] },
  });
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: buildSharedContainerE2eEnv(
      userDataDir,
      SHARED_CONTAINERS_EXTERNAL_ENV,
    ),
  });
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await connectSharedContainersAccount(window);
  await openWorktreeShare(window, app);
  return { electronApp, window, app };
}

async function storedSharing(window) {
  return window.evaluate(
    async () => (await window.api.loadPreferences()).telemetrySharing,
  );
}

test('personal sync-disabled invite recovers through Privacy', async () => {
  test.setTimeout(150_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-personal-sync-off-'),
  );
  let electronApp;
  try {
    let window;
    let app;
    ({ electronApp, window, app } =
      await launchPersonalSyncOffInvite(userDataDir));

    await expect(window.getByTestId('shared-container-setup-cta')).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      window.getByTestId('shared-container-invite-modal-email-input'),
    ).toHaveCount(0);
    await window.keyboard.press('Escape');
    await expect(
      window.getByTestId('shared-container-invite-modal'),
    ).toHaveCount(0);

    await app.openSettings();
    await app.openSettingsSection('privacy');
    await window.getByTestId('telemetry-sharing-metadata-private').click();
    await expect
      .poll(async () => (await storedSharing(window)).metadata)
      .toBe('private');
    await app.closeSettings();

    await openWorktreeShare(window, app);
    await expect(
      window.getByTestId('shared-container-invite-modal-email-input'),
    ).toBeVisible({ timeout: 30_000 });
    await expect(window.getByTestId('shared-container-setup-cta')).toHaveCount(
      0,
    );
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
    }
  }
});

test('personal sync-disabled invite turns on Just me sharing in place', async () => {
  test.setTimeout(150_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-personal-opt-in-'),
  );
  let electronApp;
  try {
    let window;
    ({ electronApp, window } = await launchPersonalSyncOffInvite(userDataDir));

    const hint = window.getByTestId('data-sharing-opt-in-shared-projects');
    await expect(hint).toBeVisible({ timeout: 30_000 });
    await expect(hint).toHaveAttribute('data-opt-in-audience', 'personal');
    await expect(hint).toContainText('Only you can see them.');
    await expect(
      window.getByTestId('data-sharing-opt-in-shared-projects-dismiss'),
    ).toHaveCount(0);
    await window
      .getByTestId('data-sharing-opt-in-shared-projects-enable')
      .click();

    // Wait on the invite itself: registration queues and flushes after the
    // save, and the modal may briefly show its registration state.
    await expect(
      window.getByTestId('shared-container-invite-modal-email-input'),
    ).toBeVisible({ timeout: 30_000 });
    await expect(window.getByTestId('shared-container-setup-cta')).toHaveCount(
      0,
    );
    expect(await storedSharing(window)).toEqual({
      metadata: 'private',
      plans: 'off',
      summaries: 'off',
      transcripts: 'off',
    });
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
    }
  }
});

test('keeps the entry point enabled and offers sharing to sync-disabled owners', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-sync-off-'),
  );
  const fixture = seedCoworkSharedContainer(userDataDir, { metadata: 'off' });
  await registerFixture();
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(userDataDir),
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectSharedContainersAccount(window);
    await app.openMainPage();
    await expandCoworkWorkspace(window, fixture.projectId);
    await openWorkEntryMenu(window, ENTRY_ID);
    const invite = window.getByTestId(`sidebar-work-entry-${ENTRY_ID}-invite`);
    await expect(invite).toBeEnabled();
    await invite.click();

    const cta = window.getByTestId('shared-container-setup-cta');
    await expect(cta).toContainText('Turn on project data sharing');
    await expect(
      window.getByTestId('data-sharing-opt-in-shared-projects-enable'),
    ).toBeEnabled();
    const sharing = await window.evaluate(
      async () => (await window.api.loadPreferences()).telemetrySharing,
    );
    expect(sharing.metadata).toBe('off');
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
    }
  }
});

test('CAN-3383: sync-disabled invite recovery enables sharing in place', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-sync-off-'),
  );
  const fixture = seedCoworkSharedContainer(userDataDir, { metadata: 'off' });
  await registerFixture({ cloud: { enforcedSettings: [] } });
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(userDataDir),
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectSharedContainersAccount(window);
    await app.openMainPage();
    await expandCoworkWorkspace(window, fixture.projectId);
    await openWorkEntryMenu(window, ENTRY_ID);
    const invite = window.getByTestId(`sidebar-work-entry-${ENTRY_ID}-invite`);
    await expect(invite).toBeEnabled();
    await invite.click();

    const cta = window.getByTestId('shared-container-setup-cta');
    await expect(cta).toContainText('Turn on project data sharing');
    const hint = window.getByTestId('data-sharing-opt-in-shared-projects');
    await expect(hint).toBeVisible();
    await expect(
      window.getByTestId('data-sharing-opt-in-shared-projects-dismiss'),
    ).toHaveCount(0);
    await window
      .getByTestId('data-sharing-opt-in-shared-projects-enable')
      .click();
    await expect(cta).toHaveCount(0);
    await expect(
      window.getByTestId('shared-container-invite-modal-member-picker'),
    ).toBeVisible();
    const sharing = await window.evaluate(
      async () => (await window.api.loadPreferences()).telemetrySharing,
    );
    expect(sharing.metadata).toBe('organization');
    expect(sharing.transcripts).not.toBe('organization');
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
    }
  }
});
