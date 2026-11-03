/**
 * CAN-2552 durable recipient fork coverage.
 *
 * Walks the flow a recipient actually takes: accept a Cowork share, open its
 * row menu, make a copy, pass the disclosures, and land in the copy. Cowork is
 * the container type chosen here because its fork is entirely local file work
 * with no git host, clone, or credentials, so the spec exercises the real
 * main-process fork engine end to end rather than a stub.
 *
 * The assertions that matter are the ones a refactor can silently break:
 *
 * - The disclosures are a gate, not decoration. Reaching the confirm control
 *   requires passing the destination step first.
 * - The source replica survives the fork. Copy-never-move is the invariant the
 *   whole fork design rests on, and a fork that moved the tree would still
 *   look successful from the destination's side.
 * - The copy is an ordinary local container. It lands on the chat page as a
 *   Work Entry, not back in "Shared with me".
 *
 * Run: pnpm run test:electron:built can-2552-shared-container-fork.spec.mjs --reporter=line
 */
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  chooseSettingsOption,
  settingsOptionLabels,
} from './helpers/settingsSelect.mjs';
import { acceptSharedContainerInvitation } from './sharedContainerRecipientActions.mjs';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  clearScenario,
  DEFAULT_MOCK_BASE_URL,
  getScenarioActivity,
  registerScenario,
  seedChatsSectionFixture,
  seedCoworkWorkspace,
  CHATS_SECTION_CODE_WORKSPACE_ID,
  seedOrgContextScoping,
  seedSharedContainerRecipientReplicas,
  sharedContainerRecipientScenario,
  ORG_CONTEXT_ENV,
  SHARED_CONTAINER_RECIPIENT_COWORK_ID,
  SHARED_CONTAINER_RECIPIENT_CODE_ID,
} from './seeders/index.mjs';
import {
  OTHER_SHARED_CONTAINERS_ORGANIZATION_ID,
  SHARED_CONTAINERS_CLOUD_API_KEY,
  SHARED_CONTAINERS_ORGANIZATION_ID,
  buildSharedContainerE2eEnv,
  connectSharedContainersAccount,
} from './sharedContainerInviteFixture.mjs';
import { selectWorkspaceContext } from './workspaceContextMenu.mjs';
import { sharedContainerPackageMetadata } from './mock-server/routes/shared-containers.mjs';

test.describe.configure({ mode: 'serial' });

const DIRECT_FORK_FLAGS = JSON.stringify({
  'canopy-shared-org-projects-enabled': true,
  'canopy-shared-container-external-sharing': true,
});

function seedDirectForkReplicas(userDataDir, options) {
  seedSharedContainerRecipientReplicas(userDataDir, options);
  // Replica reuse checks the access lane as well as the owning organization.
  // Match the direct server fixture so opening does not re-download a sealed
  // revision whose transport this local fixture deliberately does not serve.
  const indexPath = path.join(userDataDir, 'shared-containers', 'index.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  for (const replica of Object.values(index.containers)) {
    replica.access = 'direct';
  }
  writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
}

test('copies an accepted Cowork share into an independent local project', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-fork-'),
  );
  const recipientScenario = sharedContainerRecipientScenario({
    includeRun: false,
  });
  // This success case exercises direct access, which always copies to
  // Personal; organization-access copies have their own flows below.
  recipientScenario.sharedContainersState.containers =
    recipientScenario.sharedContainersState.containers.map((container) => ({
      ...container,
      access: 'direct',
    }));
  await registerScenario(
    DEFAULT_MOCK_BASE_URL,
    SHARED_CONTAINERS_CLOUD_API_KEY,
    recipientScenario,
  );

  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(userDataDir, {
        CANOPY_E2E_CLIENT_FEATURE_FLAGS: DIRECT_FORK_FLAGS,
      }),
    }));
    const loginWindow = await electronApp.firstWindow();
    await connectSharedContainersAccount(loginWindow);
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    electronApp = undefined;

    // Seed only after the identity transition, then restart so the production
    // replica manager binds the injected fixture's filesystem identity before
    // it performs any destructive operation such as recipient dismissal.
    seedDirectForkReplicas(userDataDir, {
      preferences: false,
      includeRun: false,
    });
    // A pre-existing Cowork workspace is the real-world precondition for the
    // bug this spec guards: the recipient has used Cowork before forking, so
    // the store's `chatProjects` is already populated and stale rather than
    // unloaded. It also gets the chat page past `StandaloneChatPage`'s
    // `isColdStart` branch, which returns a `page-chat` section holding only
    // `StandaloneColdStartEmptyState` and never reaches `CoworkTopBar` — and
    // `cowork-top-bar` visibility is this spec's "initialize finished" signal.
    seedChatsSectionFixture(userDataDir, {
      worktreeCount: 2,
      chatEntryCount: 1,
    });
    const sourceRevisionRoot = path.join(
      userDataDir,
      'shared-containers',
      SHARED_CONTAINER_RECIPIENT_COWORK_ID,
      'revisions',
      'cowork-revision-1',
    );
    const publishedChatPath = path.join(
      sourceRevisionRoot,
      'artifacts',
      'chats',
      'cowork-chat.json',
    );
    const publishedChat = JSON.parse(readFileSync(publishedChatPath, 'utf8'));
    publishedChat.messages[0].parts = [
      {
        kind: 'attachment',
        data: { references: [{ displayPath: '/etc/passwd' }] },
      },
    ];
    writeFileSync(publishedChatPath, JSON.stringify(publishedChat), 'utf8');
    const publishedLayoutPath = path.join(
      sourceRevisionRoot,
      'artifacts',
      'container.json',
    );
    const publishedLayout = JSON.parse(
      readFileSync(publishedLayoutPath, 'utf8'),
    );
    const sharedClaudeInstructions = 'Use the shared customer workflow.\n';
    const sharedAgentsInstructions =
      'Use the distinct shared agent instructions.\n';
    publishedLayout.files.push(
      {
        path: 'CLAUDE.md',
        status: 'added',
        artifactId: 'cowork-claude-md',
        sizeBytes: String(Buffer.byteLength(sharedClaudeInstructions)),
      },
      {
        path: 'AGENTS.md',
        status: 'added',
        artifactId: 'cowork-agents-md',
        sizeBytes: String(Buffer.byteLength(sharedAgentsInstructions)),
      },
    );
    writeFileSync(publishedLayoutPath, JSON.stringify(publishedLayout), 'utf8');
    writeFileSync(
      path.join(sourceRevisionRoot, 'content', 'CLAUDE.md'),
      sharedClaudeInstructions,
      'utf8',
    );
    writeFileSync(
      path.join(sourceRevisionRoot, 'content', 'AGENTS.md'),
      sharedAgentsInstructions,
      'utf8',
    );
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(userDataDir, {
        CANOPY_E2E_CLIENT_FEATURE_FLAGS: DIRECT_FORK_FLAGS,
      }),
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    // Visit the chat page first so `StandaloneChatPage` mounts and the store
    // reaches `initialized: true` with a populated `chatProjects`. Without
    // this, `openWorkEntryFromSidebar` takes its cold-`initialize()` branch,
    // which re-lists as a side effect and accidentally hides the bug. Waiting
    // on `cowork-top-bar` rather than `page-chat` is what proves `initialize()`
    // finished, not merely that the page rendered.
    await app.openChatPage();
    await expect(window.getByTestId('cowork-top-bar')).toBeVisible({
      timeout: 30_000,
    });
    await app.openMainPage();
    await expect(
      window.getByTestId('sidebar-section-shared-with-me'),
    ).toBeVisible({ timeout: 30_000 });

    await acceptSharedContainerInvitation(
      window,
      SHARED_CONTAINER_RECIPIENT_COWORK_ID,
    );
    const coworkRow = window.getByTestId(
      `shared-container-row-${SHARED_CONTAINER_RECIPIENT_COWORK_ID}`,
    );
    await expect(coworkRow).toBeVisible({ timeout: 30_000 });

    await coworkRow.hover();
    await window
      .getByTestId(
        `shared-container-row-${SHARED_CONTAINER_RECIPIENT_COWORK_ID}-actions`,
      )
      .click();
    const forkItem = window.getByTestId(
      `shared-container-row-${SHARED_CONTAINER_RECIPIENT_COWORK_ID}-fork`,
    );
    // Only a readable replica has a revision to copy from; the row asks main
    // for that before enabling the action.
    await expect(forkItem).toBeEnabled({ timeout: 30_000 });
    // Entry point and dialog share one word for one concept.
    await expect(forkItem).toContainText('Make a copy');
    await forkItem.click();

    const modal = window.getByTestId('shared-container-fork-modal');
    await expect(modal).toBeVisible();
    await expect(
      window.getByTestId('shared-container-fork-destination-context'),
    ).toHaveText('Belongs to Personal');
    await expect(
      window.getByTestId('shared-container-fork-destination'),
    ).toBeVisible();
    // A Cowork copy has no repositories to place, so the clone-directory field
    // must not appear at all.
    await expect(
      window.getByTestId('shared-container-fork-location'),
    ).toHaveCount(0);
    // The disclosures gate the fork: there is no confirm control until the
    // destination step has been passed.
    await expect(
      window.getByTestId('shared-container-fork-confirm'),
    ).toHaveCount(0);

    await window.getByTestId('shared-container-fork-continue').click();
    const disclosures = window.getByTestId('shared-container-fork-disclosures');
    await expect(disclosures).toBeVisible();
    await expect(
      window.getByTestId('shared-container-fork-disclosures-destination'),
    ).toHaveText('Your copy will be made in Personal.');
    await expect(disclosures).toContainText('Your copy is independent');
    await expect(disclosures).toContainText("can't take it back");
    await expect(disclosures).toContainText('read-only history');

    // CAN-3710: the copy opens as soon as it is made; no done screen.
    await window.getByTestId('shared-container-fork-confirm').click();
    await expect(modal).toHaveCount(0, { timeout: 60_000 });
    // CAN-4782: the share viewer does not cover the copy, and focus lands on
    // the copy's provenance line.
    await expect(window.getByTestId('shared-container-surface')).toHaveCount(0);
    await expect(
      window
        .getByTestId('page-chat')
        .getByTestId('shared-container-fork-provenance'),
    ).toBeFocused({ timeout: 30_000 });
    await expect(
      window
        .getByTestId('toast-card')
        .filter({ hasText: 'Copy made' })
        .getByTestId('toast-action'),
    ).toHaveText('Open copy');

    // The copy is an ordinary Cowork Work Entry on the chat page. Its durable
    // provenance remains visible after the success dialog is gone.
    await expect(window.getByTestId('page-chat')).toBeVisible({
      timeout: 30_000,
    });
    await window
      .getByTestId('page-chat')
      .getByTestId('panel-tab-panel-chat-cowork-chat')
      .click();
    // Scoped to the copy: the share viewer renders the same published chat if
    // it is ever mounted again.
    await expect(
      window
        .getByTestId('page-chat')
        .getByText('Summarize the customer follow-up.', { exact: false }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(window.getByText('/etc/passwd', { exact: false })).toHaveCount(
      0,
    );
    await expect(
      window.getByTestId('shared-container-fork-provenance'),
    ).toContainText('does not update when theirs does');
    // The notice above is keyed on (activeChatProjectId, activeWorkEntryId) and
    // renders null on a miss, so it is already a selection assertion. These two
    // name the selection, so it cannot pass with the wrong workspace active.
    await expect(window.getByTestId('cowork-top-workspace-name')).toHaveText(
      'Customer follow-up',
    );
    // Scope to the panel: the sidebar row carries this same string, which is
    // precisely why the pre-open assertion passes while the row is dead.
    await expect(
      window
        .getByTestId('page-chat')
        .getByTestId('panel-content-chat')
        .filter({ hasText: 'Summarize the customer follow-up.' }),
    ).toBeVisible();

    const workspaceIndex = JSON.parse(
      readFileSync(path.join(userDataDir, 'workspaces', 'index.json'), 'utf8'),
    );
    const forkWorkspace = workspaceIndex.workspaces.find(
      (workspace) => workspace.name === 'Customer follow-up',
    );
    expect(forkWorkspace).toBeTruthy();
    expect(
      JSON.parse(
        readFileSync(
          path.join(
            userDataDir,
            'workspaces',
            forkWorkspace.id,
            'workspace.json',
          ),
          'utf8',
        ),
      ).owner,
    ).toBeUndefined();
    const workEntries = JSON.parse(
      readFileSync(
        path.join(
          userDataDir,
          'workspaces',
          forkWorkspace.id,
          'work-entries.json',
        ),
        'utf8',
      ),
    );
    expect(workEntries.entries).toHaveLength(1);

    // Symptom 2 of the reported bug: the forked row rendered but clicking it
    // did nothing, permanently. The row reads `workEntries.list` directly, so
    // it renders regardless of whether the Cowork store ever listed the
    // workspace — navigate away and come back through the row itself.
    const forkedEntryRow = window
      .locator(
        `[data-testid="sidebar-work-entry-${workEntries.entries[0].id}"]`,
      )
      .first();
    await expect(forkedEntryRow).toHaveAttribute(
      'data-sidebar-selected-item',
      '',
    );
    await window
      .getByTestId('sidebar-work-entry-entry-chat-001')
      .first()
      .click();
    await expect(window.getByTestId('cowork-top-workspace-name')).toHaveText(
      'Personal',
    );
    await app.openMainPage();
    await expect(window.getByTestId('page-chat')).toHaveCount(0);
    await expect(window.getByTestId('shared-container-surface')).toHaveCount(0);
    await expect(forkedEntryRow).toBeVisible({ timeout: 30_000 });
    const otherCodeRow = window
      .locator(
        `[data-testid="worktree-row"][data-project-id="${CHATS_SECTION_CODE_WORKSPACE_ID}"][data-worktree-id="feature-02"]`,
      )
      .first();
    await window
      .locator(
        `[data-testid="worktree-row"][data-project-id="${CHATS_SECTION_CODE_WORKSPACE_ID}"][data-worktree-id="feature-01"]`,
      )
      .first()
      .click();
    await electronApp.evaluate(({ ipcMain }, projectId) => {
      const original = ipcMain._invokeHandlers.get('standalone-chat:init');
      if (!original) throw new Error('chat:load-tabs handler not found');
      ipcMain.__forkEntryLoadStarted = false;
      ipcMain.removeHandler('standalone-chat:init');
      ipcMain.handle('standalone-chat:init', async (...args) => {
        if (args[1] === projectId) {
          ipcMain.removeHandler('standalone-chat:init');
          ipcMain.handle('standalone-chat:init', original);
          ipcMain.__forkEntryLoadStarted = true;
          await new Promise((resolve) => {
            ipcMain.__releaseForkEntryLoad = resolve;
          });
        }
        return original(...args);
      });
    }, forkWorkspace.id);
    const coworkCopyToast = window
      .getByTestId('toast-card')
      .filter({ hasText: 'Copy made' });
    await coworkCopyToast.hover();
    await coworkCopyToast.getByTestId('toast-action').click();
    await expect
      .poll(() =>
        electronApp.evaluate(({ ipcMain }) => ipcMain.__forkEntryLoadStarted),
      )
      .toBe(true);
    await otherCodeRow.click();
    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.__releaseForkEntryLoad();
    });
    await expect(
      window
        .getByTestId('toast-card')
        .filter({ hasText: "The copy couldn't be opened." }),
    ).toHaveCount(1);
    await expect(window.getByTestId('page-main')).toBeVisible();
    await expect(
      window
        .locator('[data-sidebar-selected-item]')
        .filter({ has: otherCodeRow }),
    ).toBeVisible();
    const coworkRetryToast = window
      .getByTestId('toast-card')
      .filter({ hasText: "The copy couldn't be opened." });
    // Re-enter another workspace so retry must list the copy's entries,
    // independently of whether its sidebar cache has already refreshed.
    await window
      .getByTestId('sidebar-work-entry-entry-chat-001')
      .first()
      .click();
    await expect(window.getByTestId('cowork-top-workspace-name')).toHaveText(
      'Personal',
    );
    await app.openMainPage();
    await otherCodeRow.click();
    // The interruption must survive returning to the original page.
    await electronApp.evaluate(({ ipcMain }, projectId) => {
      const original = ipcMain._invokeHandlers.get('work-entries:list');
      if (!original) throw new Error('work-entries:list handler not found');
      ipcMain.__forkEntryRefreshStarted = false;
      ipcMain.removeHandler('work-entries:list');
      ipcMain.handle('work-entries:list', async (...args) => {
        if (args[1]?.projectId === projectId) {
          ipcMain.removeHandler('work-entries:list');
          ipcMain.handle('work-entries:list', original);
          ipcMain.__forkEntryRefreshStarted = true;
          await new Promise((resolve) => {
            ipcMain.__releaseForkEntryRefresh = resolve;
          });
        }
        return original(...args);
      });
    }, forkWorkspace.id);
    await coworkRetryToast.hover();
    await coworkRetryToast.getByTestId('toast-action').click();
    await expect
      .poll(() =>
        electronApp.evaluate(
          ({ ipcMain }) => ipcMain.__forkEntryRefreshStarted,
        ),
      )
      .toBe(true);
    await app.openUsagePage();
    await app.openMainPage();
    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.__releaseForkEntryRefresh();
    });
    await expect(coworkRetryToast).toHaveCount(1);
    await expect(window.getByTestId('page-main')).toBeVisible();
    await expect(
      window
        .locator('[data-sidebar-selected-item]')
        .filter({ has: otherCodeRow }),
    ).toBeVisible();
    await coworkRetryToast.hover();
    await coworkRetryToast.getByTestId('toast-action').click();
    await expect(
      window
        .getByTestId('page-chat')
        .getByTestId('shared-container-fork-provenance'),
    ).toBeFocused();
    await app.openMainPage();
    await forkedEntryRow.click();
    await expect(window.getByTestId('page-chat')).toBeVisible({
      timeout: 30_000,
    });
    await expect(forkedEntryRow).toHaveAttribute(
      'data-sidebar-selected-item',
      '',
      { timeout: 30_000 },
    );
    await expect(window.getByTestId('cowork-top-workspace-name')).toHaveText(
      'Customer follow-up',
    );
    const managedRoot = path.join(
      userDataDir,
      'workspaces',
      forkWorkspace.id,
      'home',
      '.canopy',
    );
    expect(readdirSync(path.join(managedRoot, 'notes'))).toEqual([
      expect.stringMatching(/^cowork-note-[a-f0-9]{12}\.md$/),
    ]);
    expect(readdirSync(path.join(managedRoot, 'prompts'))).toEqual([
      expect.stringMatching(/^cowork-prompt-[a-f0-9]{12}\.md$/),
    ]);
    const forkedFile = path.join(
      userDataDir,
      'workspaces',
      forkWorkspace.id,
      'home',
      'exports',
      'customer-summary.txt',
    );
    expect(readFileSync(forkedFile, 'utf8')).toBe(
      'Customer follow-up details.\n',
    );
    const forkHome = path.dirname(path.dirname(forkedFile));
    expect(readFileSync(path.join(forkHome, 'CLAUDE.md'), 'utf8')).toBe(
      sharedClaudeInstructions,
    );
    const forkAgentsPath = path.join(forkHome, 'AGENTS.md');
    expect(lstatSync(forkAgentsPath).isSymbolicLink()).toBe(false);
    expect(readFileSync(forkAgentsPath, 'utf8')).toBe(sharedAgentsInstructions);
    expect(existsSync(sourceRevisionRoot)).toBe(true);

    // Removing the source acceptance purges its replica but cannot recall or
    // reconnect the local fork. It remains writable afterwards.
    await app.openMainPage();
    await expect(coworkRow).toBeVisible();
    await coworkRow.hover();
    await window
      .getByTestId(
        `shared-container-row-${SHARED_CONTAINER_RECIPIENT_COWORK_ID}-actions`,
      )
      .click();
    await window
      .getByTestId(
        `shared-container-row-${SHARED_CONTAINER_RECIPIENT_COWORK_ID}-remove`,
      )
      .click();
    await window
      .getByTestId(
        `shared-container-row-${SHARED_CONTAINER_RECIPIENT_COWORK_ID}-remove-confirm`,
      )
      .click();
    await expect(coworkRow).toHaveCount(0, { timeout: 30_000 });
    await expect
      .poll(() => existsSync(sourceRevisionRoot), { timeout: 30_000 })
      .toBe(false);

    writeFileSync(forkedFile, 'Edited after source removal.\n', 'utf8');
    expect(readFileSync(forkedFile, 'utf8')).toBe(
      'Edited after source removal.\n',
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

test('keeps newer Code selection when retry starts Cowork for the first time', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-cold-fork-'));
  const scenario = sharedContainerRecipientScenario({ includeRun: false });
  scenario.sharedContainersState.containers =
    scenario.sharedContainersState.containers.map((container) => ({
      ...container,
      access: 'direct',
    }));
  await registerScenario(
    DEFAULT_MOCK_BASE_URL,
    SHARED_CONTAINERS_CLOUD_API_KEY,
    scenario,
  );
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(userDataDir, {
        CANOPY_E2E_CLIENT_FEATURE_FLAGS: DIRECT_FORK_FLAGS,
      }),
    }));
    await connectSharedContainersAccount(await electronApp.firstWindow());
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    electronApp = undefined;
    seedChatsSectionFixture(userDataDir, {
      worktreeCount: 2,
      chatEntryCount: 1,
    });
    seedDirectForkReplicas(userDataDir, {
      preferences: false,
      includeRun: false,
    });
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(userDataDir, {
        CANOPY_E2E_CLIENT_FEATURE_FLAGS: DIRECT_FORK_FLAGS,
      }),
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    const firstCodeRow = window
      .locator(
        `[data-testid="worktree-row"][data-project-id="${CHATS_SECTION_CODE_WORKSPACE_ID}"][data-worktree-id="feature-01"]`,
      )
      .first();
    const chosenCodeRow = window
      .locator(
        `[data-testid="worktree-row"][data-project-id="${CHATS_SECTION_CODE_WORKSPACE_ID}"][data-worktree-id="feature-02"]`,
      )
      .first();
    await firstCodeRow.click();
    await acceptSharedContainerInvitation(
      window,
      SHARED_CONTAINER_RECIPIENT_COWORK_ID,
    );
    const shareRow = window.getByTestId(
      `shared-container-row-${SHARED_CONTAINER_RECIPIENT_COWORK_ID}`,
    );
    await shareRow.hover();
    await window
      .getByTestId(
        `shared-container-row-${SHARED_CONTAINER_RECIPIENT_COWORK_ID}-actions`,
      )
      .click();
    await window
      .getByTestId(
        `shared-container-row-${SHARED_CONTAINER_RECIPIENT_COWORK_ID}-fork`,
      )
      .click();
    await window.getByTestId('shared-container-fork-continue').click();
    // Keep the new copy out of the initial reveal so its saved-response retry
    // is the first operation to initialize Cowork. Creation itself stays real.
    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.__coldForkProjectsLoad =
        ipcMain._invokeHandlers.get('projects:load');
      if (!ipcMain.__coldForkProjectsLoad)
        throw new Error('projects:load handler not found');
      ipcMain.removeHandler('projects:load');
      ipcMain.handle('projects:load', () => {
        throw new Error('Injected initial copy listing failure');
      });
    });
    await window.getByTestId('shared-container-fork-confirm').click();
    await expect(window.getByTestId('shared-container-fork-modal')).toHaveCount(
      0,
      { timeout: 60_000 },
    );
    const initialRetry = window
      .getByTestId('toast-card')
      .filter({ hasText: "Copy made, but it couldn't be opened." });
    await expect(initialRetry).toHaveCount(1);
    const index = JSON.parse(
      readFileSync(path.join(userDataDir, 'workspaces', 'index.json'), 'utf8'),
    );
    const copy = index.workspaces.find(
      (workspace) => workspace.name === 'Customer follow-up',
    );
    expect(copy).toBeTruthy();
    await electronApp.evaluate(({ ipcMain }, projectId) => {
      ipcMain.removeHandler('projects:load');
      ipcMain.handle('projects:load', ipcMain.__coldForkProjectsLoad);
      const original = ipcMain._invokeHandlers.get('work-entries:list');
      if (!original) throw new Error('work-entries:list handler not found');
      ipcMain.__coldForkListingStarted = false;
      ipcMain.removeHandler('work-entries:list');
      ipcMain.handle('work-entries:list', async (...args) => {
        if (args[1]?.projectId === projectId) {
          ipcMain.removeHandler('work-entries:list');
          ipcMain.handle('work-entries:list', original);
          ipcMain.__coldForkListingStarted = true;
          await new Promise((resolve) => {
            ipcMain.__releaseColdForkListing = resolve;
          });
        }
        return original(...args);
      });
    }, copy.id);
    await initialRetry.hover();
    await initialRetry.getByTestId('toast-action').click();
    await expect
      .poll(() =>
        electronApp.evaluate(({ ipcMain }) => ipcMain.__coldForkListingStarted),
      )
      .toBe(true);
    await chosenCodeRow.click();
    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.__releaseColdForkListing();
    });
    const retry = window
      .getByTestId('toast-card')
      .filter({ hasText: "The copy couldn't be opened." });
    await expect(retry).toHaveCount(1);
    await expect(window.getByTestId('page-main')).toBeVisible();
    await expect(
      window
        .locator('[data-sidebar-selected-item]')
        .filter({ has: chosenCodeRow }),
    ).toBeVisible();
    await retry.hover();
    await retry.getByTestId('toast-action').click();
    await expect(
      window
        .getByTestId('page-chat')
        .getByTestId('shared-container-fork-provenance'),
    ).toBeFocused();
    const afterRetryIndex = JSON.parse(
      readFileSync(path.join(userDataDir, 'workspaces', 'index.json'), 'utf8'),
    );
    expect(
      afterRetryIndex.workspaces.filter(
        (workspace) => workspace.name === 'Customer follow-up',
      ),
    ).toHaveLength(1);
  } finally {
    await clearScenario(
      DEFAULT_MOCK_BASE_URL,
      SHARED_CONTAINERS_CLOUD_API_KEY,
    ).catch(() => undefined);
    if (electronApp) await closeCanopy(electronApp, userDataDir);
  }
});

test('copies a code snapshot with its commit and overlay state', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-code-fork-'),
  );
  const recipientScenario = sharedContainerRecipientScenario({
    includeCowork: false,
    includeRun: false,
    codeSource: 'snapshot',
  });
  recipientScenario.sharedContainersState.containers =
    recipientScenario.sharedContainersState.containers.map((container) => ({
      ...container,
      access: 'direct',
    }));
  const agentReply = 'Mock response from the Canopy UI-automation LLM surface.';
  await registerScenario(
    DEFAULT_MOCK_BASE_URL,
    SHARED_CONTAINERS_CLOUD_API_KEY,
    recipientScenario,
  );

  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(userDataDir, {
        CANOPY_E2E_CLIENT_FEATURE_FLAGS: DIRECT_FORK_FLAGS,
      }),
    }));
    const loginWindow = await electronApp.firstWindow();
    await connectSharedContainersAccount(loginWindow);
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    electronApp = undefined;

    seedChatsSectionFixture(userDataDir, {
      worktreeCount: 1,
      chatEntryCount: 1,
    });
    seedDirectForkReplicas(userDataDir, {
      preferences: false,
      includeRun: false,
      codeSource: 'snapshot',
    });
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(userDataDir, {
        CANOPY_E2E_CLIENT_FEATURE_FLAGS: DIRECT_FORK_FLAGS,
      }),
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();

    const sourceRevisionRoot = path.join(
      userDataDir,
      'shared-containers',
      SHARED_CONTAINER_RECIPIENT_CODE_ID,
      'revisions',
      'code-revision-1',
    );
    const sourceLayout = JSON.parse(
      readFileSync(
        path.join(sourceRevisionRoot, 'artifacts', 'container.json'),
        'utf8',
      ),
    );
    expect(sourceLayout.schemaVersion).toBe(2);
    expect(sourceLayout.repositories[0].source).toBe('snapshot');
    const sourceStatusBefore = Object.fromEntries(
      sourceLayout.repositories.map((repository) => [
        repository.repoId,
        execFileSync('git', ['status', '--short'], {
          cwd: path.join(sourceRevisionRoot, 'repos', repository.repoId),
          encoding: 'utf8',
        }),
      ]),
    );

    await acceptSharedContainerInvitation(
      window,
      SHARED_CONTAINER_RECIPIENT_CODE_ID,
    );
    const codeRow = window.getByTestId(
      `shared-container-row-${SHARED_CONTAINER_RECIPIENT_CODE_ID}`,
    );
    await expect(codeRow).toBeVisible({ timeout: 30_000 });
    await codeRow.click();
    await expect(window.getByTestId('shared-container-surface')).toBeVisible();
    await window.getByTestId('shared-container-fork-open-modal').click();

    await expect(
      window.getByTestId('shared-container-fork-location'),
    ).not.toHaveValue('');
    await expect(
      window.getByTestId('shared-container-fork-destination-context'),
    ).toHaveText('Belongs to Personal');
    await window.getByTestId('shared-container-fork-continue').click();
    await expect(
      window.getByTestId('shared-container-fork-disclosures-destination'),
    ).toHaveText('Your copy will be made in Personal.');
    await window.getByTestId('shared-container-fork-confirm').click();
    await expect(window.getByTestId('page-main')).toBeVisible({
      timeout: 60_000,
    });
    // CAN-4782: the copy is in front, not mounted behind the share viewer,
    // and keyboard focus is on its provenance once the dialog is gone.
    await expect(window.getByTestId('shared-container-fork-modal')).toHaveCount(
      0,
    );
    await expect(window.getByTestId('shared-container-surface')).toHaveCount(0);
    const codeProvenance = window
      .getByTestId('page-main')
      .getByTestId('shared-container-fork-provenance');
    await expect(codeProvenance).toContainText(
      'does not update when theirs does',
    );
    await expect(codeProvenance).toBeFocused();
    const workspaceIndex = JSON.parse(
      readFileSync(path.join(userDataDir, 'workspaces', 'index.json'), 'utf8'),
    );
    const workspace = workspaceIndex.workspaces.find(
      (item) => item.name === 'Recipient feature branch',
    );
    expect(workspace).toBeTruthy();
    const workspaceDir = path.join(userDataDir, 'workspaces', workspace.id);
    const config = JSON.parse(
      readFileSync(path.join(workspaceDir, 'workspace.json'), 'utf8'),
    );
    const worktrees = JSON.parse(
      readFileSync(path.join(workspaceDir, 'worktrees.json'), 'utf8'),
    );
    expect(config.type).toBe('multi-repo');
    expect(config.owner).toBeUndefined();
    expect(config.repos).toHaveLength(2);
    expect(worktrees.worktrees).toHaveLength(1);
    const worktreeId = worktrees.worktrees[0].id;
    const copiedRow = window
      .locator(
        `[data-sidebar-selected-item] [data-testid="worktree-row"][data-project-id="${workspace.id}"][data-worktree-id="${worktreeId}"]`,
      )
      .first();
    await expect(copiedRow).toBeVisible();
    const copyToast = window
      .getByTestId('toast-card')
      .filter({ hasText: 'Copy made' });
    await expect(copyToast).toHaveCount(1);
    await expect(copyToast.getByTestId('toast-action')).toHaveText('Open copy');

    // Hold the toast's real projects refresh so a newer navigation can win.
    // A late reveal must not replace a newer selection on the same page.
    await electronApp.evaluate(({ ipcMain }) => {
      const original = ipcMain._invokeHandlers.get('projects:load');
      if (!original) throw new Error('projects:load handler not found');
      ipcMain.__forkRevealRefreshStarted = false;
      ipcMain.removeHandler('projects:load');
      ipcMain.handle('projects:load', async (...args) => {
        ipcMain.removeHandler('projects:load');
        ipcMain.handle('projects:load', original);
        ipcMain.__forkRevealRefreshStarted = true;
        await new Promise((resolve) => {
          ipcMain.__releaseForkRevealRefresh = resolve;
        });
        return original(...args);
      });
    });
    await copyToast.hover();
    await copyToast.getByTestId('toast-action').click();
    await expect
      .poll(() =>
        electronApp.evaluate(
          ({ ipcMain }) => ipcMain.__forkRevealRefreshStarted,
        ),
      )
      .toBe(true);
    const otherRow = window
      .locator(
        `[data-testid="worktree-row"][data-project-id="${CHATS_SECTION_CODE_WORKSPACE_ID}"][data-worktree-id="feature-01"]`,
      )
      .first();
    await otherRow.click();
    await expect(
      window.locator('[data-sidebar-selected-item]').filter({ has: otherRow }),
    ).toBeVisible();
    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.__releaseForkRevealRefresh();
    });
    const retryToast = window
      .getByTestId('toast-card')
      .filter({ hasText: "The copy couldn't be opened." });
    await expect(retryToast).toHaveCount(1);
    await expect(window.getByTestId('page-main')).toBeVisible();
    await expect(
      window.locator('[data-sidebar-selected-item]').filter({ has: otherRow }),
    ).toBeVisible();
    // Retrying still opens the same copy, without another fork/success toast.
    await app.openChatPage();
    await expect(
      window.getByTestId('sidebar-work-entry-entry-chat-001').first(),
    ).toHaveAttribute('data-sidebar-selected-item', '');
    await retryToast.hover();
    await retryToast.getByTestId('toast-action').click();
    await expect(window.getByTestId('page-main')).toBeVisible();
    await expect(codeProvenance).toBeFocused();
    await expect(window.getByTestId('shared-container-surface')).toHaveCount(0);
    await expect(copiedRow).toBeVisible();
    // The action dismisses its own toast, and a successful reopen adds none.
    await expect(copyToast).toHaveCount(0);

    for (const publishedRepo of sourceLayout.repositories) {
      const localRepo = config.repos.find(
        (repo) => repo.name === publishedRepo.repoName,
      );
      expect(localRepo).toBeTruthy();
      // The promoted checkout is the workspace source repository. Published
      // overlay state belongs only in the new worktree below, never here.
      expect(
        execFileSync('git', ['status', '--short', '--untracked-files=all'], {
          cwd: localRepo.repoPath,
          encoding: 'utf8',
        }),
      ).toBe('');
      const checkout = path.join(
        workspaceDir,
        'worktrees',
        worktreeId,
        'repos',
        localRepo.id,
      );
      expect(
        execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: checkout,
          encoding: 'utf8',
        }).trim(),
      ).toBe(publishedRepo.baseCommitSha);
      const status = execFileSync(
        'git',
        ['status', '--short', '--untracked-files=all'],
        {
          cwd: checkout,
          encoding: 'utf8',
        },
      );
      const overlayPath =
        publishedRepo.repoId === 'repo-1'
          ? 'src/recipient.ts'
          : 'src/secondary.ts';
      expect(status).toContain(`?? ${overlayPath}`);
      expect(readFileSync(path.join(checkout, overlayPath), 'utf8')).toContain(
        'true',
      );
      if (publishedRepo.repoId === 'repo-1') {
        // CAN-2552: a committed symlink (git mode 120000) is ordinary content
        // — Canopy's own tree has one — and the fork used to refuse the whole
        // copy on sight. It must arrive as a link, not as a copy of its
        // target, and the checkout must stay clean because of it.
        const committedLink = path.join(checkout, 'skills', 'committed-link');
        expect(lstatSync(committedLink).isSymbolicLink()).toBe(true);
        expect(readlinkSync(committedLink, 'utf8')).toBe(
          '../src/committed-change.ts',
        );
        expect(status).not.toContain('skills/committed-link');
      }
      expect(
        execFileSync('git', ['status', '--short'], {
          cwd: path.join(sourceRevisionRoot, 'repos', publishedRepo.repoId),
          encoding: 'utf8',
        }),
      ).toBe(sourceStatusBefore[publishedRepo.repoId]);
    }

    // A local workspace was created, but the cloud listing still contains
    // only the original share. No grant or shared-container row was copied.
    await app.openMainPage();
    await expect(codeRow).toBeVisible();

    await codeRow.hover();
    await window
      .getByTestId(
        `shared-container-row-${SHARED_CONTAINER_RECIPIENT_CODE_ID}-actions`,
      )
      .click();
    await window
      .getByTestId(
        `shared-container-row-${SHARED_CONTAINER_RECIPIENT_CODE_ID}-remove`,
      )
      .click();
    await window
      .getByTestId(
        `shared-container-row-${SHARED_CONTAINER_RECIPIENT_CODE_ID}-remove-confirm`,
      )
      .click();
    await expect(codeRow).toHaveCount(0, { timeout: 30_000 });
    await expect
      .poll(() => existsSync(sourceRevisionRoot), { timeout: 30_000 })
      .toBe(false);

    const firstRepo = config.repos.find(
      (repo) => repo.name === sourceLayout.repositories[0].repoName,
    );
    expect(firstRepo).toBeTruthy();
    const firstCheckout = path.join(
      workspaceDir,
      'worktrees',
      worktreeId,
      'repos',
      firstRepo.id,
    );
    const independentFile = path.join(firstCheckout, 'after-revocation.txt');
    writeFileSync(independentFile, 'still local\n', 'utf8');
    execFileSync('git', ['add', 'after-revocation.txt'], {
      cwd: firstCheckout,
    });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Recipient Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '--quiet',
        '--no-gpg-sign',
        '-m',
        'edit independent fork',
      ],
      { cwd: firstCheckout },
    );
    expect(readFileSync(independentFile, 'utf8')).toBe('still local\n');

    const chatPanel = window.getByTestId('panel-content-chat');
    const composer = chatPanel.getByRole('textbox').first();
    await composer.fill('Confirm this local fork still works.');
    await chatPanel.getByRole('button', { name: 'Send message' }).click();
    await expect(chatPanel.getByText(agentReply).first()).toBeVisible({
      timeout: 90_000,
    });
    const activity = await getScenarioActivity(
      DEFAULT_MOCK_BASE_URL,
      SHARED_CONTAINERS_CLOUD_API_KEY,
    );
    expect(activity.activity.sharedContainersDismiss).toBe(1);
    expect(activity.activity.sharedContainersCreate ?? 0).toBe(0);
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

test('copies into an existing Personal project moved back from an organization', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-moved-back-fork-'),
  );
  const scenario = sharedContainerRecipientScenario({ includeRun: false });
  scenario.sharedContainersState.containers =
    scenario.sharedContainersState.containers.map((container) => ({
      ...container,
      access: 'direct',
    }));
  await registerScenario(
    DEFAULT_MOCK_BASE_URL,
    SHARED_CONTAINERS_CLOUD_API_KEY,
    scenario,
  );
  let electronApp;
  try {
    const env = buildSharedContainerE2eEnv(userDataDir, {
      CANOPY_E2E_CLIENT_FEATURE_FLAGS: DIRECT_FORK_FLAGS,
    });
    ({ electronApp } = await launchCanopy({ userDataDir, env }));
    await connectSharedContainersAccount(await electronApp.firstWindow());
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    electronApp = undefined;
    seedDirectForkReplicas(userDataDir, {
      preferences: false,
      includeRun: false,
    });
    const { workspaceId } = seedCoworkWorkspace({
      userDataDir,
      collapsed: false,
    });
    const configPath = path.join(
      userDataDir,
      'workspaces',
      workspaceId,
      'workspace.json',
    );
    const ownershipTransfer = {
      version: 1,
      previousOwner: { type: 'personal' },
      organizationId: SHARED_CONTAINERS_ORGANIZATION_ID,
      projectId: '33333333-3333-4333-8333-333333333333',
      convertedAt: '2026-10-22T00:00:00.000Z',
      movedBackAt: '2026-10-23T00:00:00.000Z',
    };
    writeFileSync(
      configPath,
      JSON.stringify({
        ...JSON.parse(readFileSync(configPath, 'utf8')),
        ownershipTransfer,
      }),
    );
    ({ electronApp } = await launchCanopy({ userDataDir, env }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await acceptSharedContainerInvitation(
      window,
      SHARED_CONTAINER_RECIPIENT_COWORK_ID,
    );
    const rowId = `shared-container-row-${SHARED_CONTAINER_RECIPIENT_COWORK_ID}`;
    await window.getByTestId(rowId).hover();
    await window.getByTestId(`${rowId}-actions`).click();
    await window.getByTestId(`${rowId}-fork`).click();
    await window
      .getByTestId('shared-container-fork-destination-existing')
      .click();
    await chooseSettingsOption(
      window.getByTestId('shared-container-fork-workspace'),
      workspaceId,
    );
    await window.getByTestId('shared-container-fork-continue').click();
    await expect(
      window.getByTestId('shared-container-fork-disclosures-destination'),
    ).toContainText('Seeded Cowork in Personal');
    await window.getByTestId('shared-container-fork-confirm').click();
    await expect(window.getByTestId('shared-container-fork-modal')).toHaveCount(
      0,
      { timeout: 30_000 },
    );
    await expect(window.getByTestId('cowork-top-workspace-name')).toHaveText(
      'Seeded Cowork',
    );
    const persisted = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(persisted.owner).toBeUndefined();
    expect(persisted.ownershipTransfer).toEqual(ownershipTransfer);
    expect(
      readFileSync(
        path.join(
          userDataDir,
          'workspaces',
          workspaceId,
          'home',
          'exports',
          'customer-summary.txt',
        ),
        'utf8',
      ),
    ).toBe('Customer follow-up details.\n');
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

test('filters existing-project fork destinations to the share owning context', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-context-fork-'),
  );
  const organizations = [
    {
      id: SHARED_CONTAINERS_ORGANIZATION_ID,
      name: 'Share owner org',
      role: 'MEMBER',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: OTHER_SHARED_CONTAINERS_ORGANIZATION_ID,
      name: 'Other org',
      role: 'MEMBER',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ];
  const recipientScenario = sharedContainerRecipientScenario({
    includeCowork: false,
    includeRun: false,
    codeSource: 'snapshot',
  });
  recipientScenario.sharedContainersState.containers =
    recipientScenario.sharedContainersState.containers.map((container) => ({
      ...container,
      organizationName: 'Share owner org',
    }));
  await registerScenario(
    DEFAULT_MOCK_BASE_URL,
    SHARED_CONTAINERS_CLOUD_API_KEY,
    {
      ...recipientScenario,
      cloud: {
        ...(recipientScenario.cloud ?? {}),
        organizations,
        orgBillingStates: organizations.map((organization) => ({
          organizationId: organization.id,
          organizationName: organization.name,
          teamsEntitled: true,
        })),
      },
    },
  );

  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(userDataDir),
    }));
    const loginWindow = await electronApp.firstWindow();
    await connectSharedContainersAccount(loginWindow);
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    electronApp = undefined;

    seedSharedContainerRecipientReplicas(userDataDir, {
      preferences: false,
      includeCowork: false,
      includeRun: false,
      codeSource: 'snapshot',
    });
    seedOrgContextScoping(userDataDir, {
      extraPersonalWorkspaces: [
        { id: 'context-other-org', name: 'Other organization repository' },
      ],
    });
    for (const [workspaceId, organizationId, projectId, instanceId] of [
      [
        'context-organization',
        SHARED_CONTAINERS_ORGANIZATION_ID,
        '33333333-3333-4333-8333-333333333333',
        '44444444-4444-4444-8444-444444444444',
      ],
      [
        'context-other-org',
        OTHER_SHARED_CONTAINERS_ORGANIZATION_ID,
        '55555555-5555-4555-8555-555555555555',
        '66666666-6666-4666-8666-666666666666',
      ],
    ]) {
      const configPath = path.join(
        userDataDir,
        'workspaces',
        workspaceId,
        'workspace.json',
      );
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      writeFileSync(
        configPath,
        `${JSON.stringify(
          {
            ...config,
            owner: {
              type: 'organization',
              organizationId,
              projectId,
              instanceId,
              bindingGeneration: 0,
            },
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
    }
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(userDataDir, {
        CANOPY_E2E_CLIENT_FEATURE_FLAGS:
          ORG_CONTEXT_ENV.CANOPY_E2E_CLIENT_FEATURE_FLAGS,
        CANOPY_E2E_ORG_PROJECT_AUTO_CONVERT: 'off',
      }),
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await selectWorkspaceContext(window, SHARED_CONTAINERS_ORGANIZATION_ID);
    await app.openMainPage();

    await acceptSharedContainerInvitation(
      window,
      SHARED_CONTAINER_RECIPIENT_CODE_ID,
    );
    const codeRow = window.getByTestId(
      `shared-container-row-${SHARED_CONTAINER_RECIPIENT_CODE_ID}`,
    );
    await expect(codeRow).toBeVisible({ timeout: 30_000 });
    // A row-menu copy also works when no viewer is open. Switching away
    // dismisses the accepted share through the real context lifecycle.
    await selectWorkspaceContext(window, 'personal');
    await selectWorkspaceContext(window, SHARED_CONTAINERS_ORGANIZATION_ID);
    await expect(window.getByTestId('shared-container-surface')).toHaveCount(0);

    await codeRow.hover();
    await window
      .getByTestId(
        `shared-container-row-${SHARED_CONTAINER_RECIPIENT_CODE_ID}-actions`,
      )
      .click();
    await window
      .getByTestId(
        `shared-container-row-${SHARED_CONTAINER_RECIPIENT_CODE_ID}-fork`,
      )
      .click();

    // CAN-4781: a share with several repositories can't become a new
    // organization copy yet. It stays organization-owned in both steps and
    // refuses without touching pre-existing local artifacts.
    const indexPath = path.join(userDataDir, 'workspaces', 'index.json');
    const indexBefore = readFileSync(indexPath, 'utf8');
    const workspaceDirectoriesBefore = readdirSync(
      path.join(userDataDir, 'workspaces'),
    ).sort();
    const cloneParent = path.join(userDataDir, 'refused-fork-parent');
    await expect(
      window.getByTestId('shared-container-fork-destination-context'),
    ).toHaveText('Belongs to Share owner org');
    await window
      .getByTestId('shared-container-fork-location')
      .fill(cloneParent);
    await window.getByTestId('shared-container-fork-continue').click();
    await expect(
      window.getByTestId('shared-container-fork-disclosures-destination'),
    ).toHaveText('Your copy will be made in Share owner org.');
    await window.getByTestId('shared-container-fork-confirm').click();
    await expect(window.getByTestId('shared-container-fork-error')).toHaveText(
      "Shares with several repositories can't be copied into a new workspace in Share owner org yet, so the copy wasn't made.",
    );
    await expect(
      window.getByTestId('shared-container-fork-destination'),
    ).toBeVisible();
    await expect(
      window.getByTestId('shared-container-fork-destination-context'),
    ).toHaveText('Belongs to Share owner org');
    expect(readFileSync(indexPath, 'utf8')).toBe(indexBefore);
    expect(readdirSync(path.join(userDataDir, 'workspaces')).sort()).toEqual(
      workspaceDirectoriesBefore,
    );
    expect(existsSync(cloneParent)).toBe(false);

    await window
      .getByTestId('shared-container-fork-destination-existing')
      .click();
    const select = window.getByTestId('shared-container-fork-workspace');
    await expect(select).not.toHaveAttribute('data-value');
    await expect(select).toHaveText('Choose a project');
    const offered = await settingsOptionLabels(select);
    expect(offered).toContain('Acme repository');
    expect(offered).not.toContain('Personal repository');
    expect(offered).not.toContain('Other organization repository');
    await expect(
      window.getByTestId('shared-container-fork-workspace-context'),
    ).toHaveText('Projects in Share owner org');
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

const ORG_COWORK_ORGANIZATIONS = [
  {
    id: SHARED_CONTAINERS_ORGANIZATION_ID,
    name: 'Share owner org',
    role: 'MEMBER',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: OTHER_SHARED_CONTAINERS_ORGANIZATION_ID,
    name: 'Other org',
    role: 'MEMBER',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

/**
 * CAN-4781: a recipient in the share owner's organization, with an accepted
 * organization-access Cowork share whose copy dialog is open on its new
 * project destination. `cloud` adds mock-cloud knobs for denial cases.
 */
async function openOrganizationCoworkCopy(userDataDir, cloud = {}) {
  const recipientScenario = sharedContainerRecipientScenario({
    includeRun: false,
  });
  recipientScenario.sharedContainersState.containers =
    recipientScenario.sharedContainersState.containers.map((container) => ({
      ...container,
      organizationName: 'Share owner org',
    }));
  await registerScenario(
    DEFAULT_MOCK_BASE_URL,
    SHARED_CONTAINERS_CLOUD_API_KEY,
    {
      ...recipientScenario,
      cloud: {
        ...(recipientScenario.cloud ?? {}),
        organizations: ORG_COWORK_ORGANIZATIONS,
        orgBillingStates: ORG_COWORK_ORGANIZATIONS.map((organization) => ({
          organizationId: organization.id,
          organizationName: organization.name,
          teamsEntitled: true,
        })),
        ...cloud,
      },
    },
  );
  const env = buildSharedContainerE2eEnv(userDataDir, {
    CANOPY_E2E_CLIENT_FEATURE_FLAGS:
      ORG_CONTEXT_ENV.CANOPY_E2E_CLIENT_FEATURE_FLAGS,
    CANOPY_E2E_ORG_PROJECT_AUTO_CONVERT: 'off',
  });
  let { electronApp } = await launchCanopy({ userDataDir, env });
  const loginWindow = await electronApp.firstWindow();
  await connectSharedContainersAccount(loginWindow);
  await closeCanopy(electronApp, userDataDir, { keepUserData: true });

  seedSharedContainerRecipientReplicas(userDataDir, {
    preferences: false,
    includeRun: false,
  });
  seedOrgContextScoping(userDataDir);
  // A pre-existing Cowork project gets the chat page past its cold start.
  seedChatsSectionFixture(userDataDir, {
    worktreeCount: 1,
    chatEntryCount: 1,
  });
  ({ electronApp } = await launchCanopy({ userDataDir, env }));
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await selectWorkspaceContext(window, SHARED_CONTAINERS_ORGANIZATION_ID);
  await app.openMainPage();

  await acceptSharedContainerInvitation(
    window,
    SHARED_CONTAINER_RECIPIENT_COWORK_ID,
  );
  const coworkRow = window.getByTestId(
    `shared-container-row-${SHARED_CONTAINER_RECIPIENT_COWORK_ID}`,
  );
  await expect(coworkRow).toBeVisible({ timeout: 30_000 });
  await coworkRow.hover();
  await window
    .getByTestId(
      `shared-container-row-${SHARED_CONTAINER_RECIPIENT_COWORK_ID}-actions`,
    )
    .click();
  const forkItem = window.getByTestId(
    `shared-container-row-${SHARED_CONTAINER_RECIPIENT_COWORK_ID}-fork`,
  );
  await expect(forkItem).toBeEnabled({ timeout: 30_000 });
  await forkItem.click();
  await expect(
    window.getByTestId('shared-container-fork-destination-context'),
  ).toHaveText('Belongs to Share owner org');
  return { electronApp, window, app };
}

function workspaceIds(userDataDir) {
  return JSON.parse(
    readFileSync(path.join(userDataDir, 'workspaces', 'index.json'), 'utf8'),
  )
    .workspaces.map((workspace) => workspace.id)
    .sort();
}

async function confirmOrganizationCopy(window) {
  await window.getByTestId('shared-container-fork-continue').click();
  await expect(
    window.getByTestId('shared-container-fork-disclosures-destination'),
  ).toHaveText('Your copy will be made in Share owner org.');
  await window.getByTestId('shared-container-fork-confirm').click();
}

test('copies an organization Cowork share into a new project in that organization', async () => {
  test.setTimeout(150_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-org-fork-'),
  );
  let electronApp;
  try {
    const opened = await openOrganizationCoworkCopy(userDataDir);
    electronApp = opened.electronApp;
    const { window } = opened;

    await confirmOrganizationCopy(window);
    await expect(window.getByTestId('shared-container-fork-modal')).toHaveCount(
      0,
      { timeout: 60_000 },
    );
    await expect(window.getByTestId('cowork-top-workspace-name')).toHaveText(
      'Customer follow-up',
      { timeout: 30_000 },
    );

    // The copy is bound to the share owner's organization, with the project
    // and instance identity the organization created and claimed for it.
    const index = JSON.parse(
      readFileSync(path.join(userDataDir, 'workspaces', 'index.json'), 'utf8'),
    );
    const copy = index.workspaces.find(
      (workspace) => workspace.name === 'Customer follow-up',
    );
    expect(copy).toBeTruthy();
    const config = JSON.parse(
      readFileSync(
        path.join(userDataDir, 'workspaces', copy.id, 'workspace.json'),
        'utf8',
      ),
    );
    expect(config.type).toBe('cowork');
    expect(config.owner).toMatchObject({
      type: 'organization',
      organizationId: SHARED_CONTAINERS_ORGANIZATION_ID,
    });
    expect(typeof config.owner.projectId).toBe('string');
    expect(typeof config.owner.instanceId).toBe('string');
    const activity = await getScenarioActivity(
      DEFAULT_MOCK_BASE_URL,
      SHARED_CONTAINERS_CLOUD_API_KEY,
    );
    expect(activity.activity.orgCoworkCreate).toBe(1);

    // The copy shows only in its organization. Switching to Personal leaves
    // no foreign selection behind; switching back restores it.
    const copyHeader = window
      .getByTestId('sidebar-section-code')
      .getByText('Customer follow-up', { exact: true })
      .first();
    await expect(copyHeader).toBeVisible();
    await selectWorkspaceContext(window, 'personal');
    await expect(copyHeader).toHaveCount(0);
    await expect(
      window
        .getByTestId('cowork-top-workspace-name')
        .filter({ hasText: 'Customer follow-up' }),
    ).toHaveCount(0);
    await selectWorkspaceContext(
      window,
      OTHER_SHARED_CONTAINERS_ORGANIZATION_ID,
    );
    await expect(copyHeader).toHaveCount(0);
    await selectWorkspaceContext(window, SHARED_CONTAINERS_ORGANIZATION_ID);
    await expect(copyHeader).toBeVisible({ timeout: 30_000 });
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

for (const [name, cloud, message] of [
  [
    'when organization projects are unavailable to the member',
    { extraCapabilities: [], withholdOrgProjectsCapability: true },
    "You can't create projects in Share owner org right now, so the copy wasn't made.",
  ],
  [
    'when the organization refuses creation after the eligibility check',
    { orgMemberProjectCreateStatus: 403 },
    "You can't create projects in Share owner org right now, so the copy wasn't made.",
  ],
]) {
  test(`refuses an organization Cowork copy ${name} and leaves nothing behind`, async () => {
    test.setTimeout(150_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-shared-container-org-fork-denied-'),
    );
    let electronApp;
    try {
      const opened = await openOrganizationCoworkCopy(userDataDir, cloud);
      electronApp = opened.electronApp;
      const { window } = opened;
      const idsBefore = workspaceIds(userDataDir);
      const directoriesBefore = readdirSync(
        path.join(userDataDir, 'workspaces'),
      ).sort();

      await confirmOrganizationCopy(window);
      await expect(
        window.getByTestId('shared-container-fork-error'),
      ).toHaveText(message, { timeout: 60_000 });
      // Back on the destination step, still owned by the organization.
      await expect(
        window.getByTestId('shared-container-fork-destination'),
      ).toBeVisible();
      await expect(
        window.getByTestId('shared-container-fork-destination-context'),
      ).toHaveText('Belongs to Share owner org');
      expect(workspaceIds(userDataDir)).toEqual(idsBefore);
      expect(readdirSync(path.join(userDataDir, 'workspaces')).sort()).toEqual(
        directoriesBefore,
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
}

test('keeps fork consent on its disclosed revision during a publication update', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-fork-revision-consent-'),
  );
  const scenario = sharedContainerRecipientScenario({ includeRun: false });
  for (const container of scenario.sharedContainersState.containers) {
    container.access = 'direct';
  }
  await registerScenario(
    DEFAULT_MOCK_BASE_URL,
    SHARED_CONTAINERS_CLOUD_API_KEY,
    scenario,
  );
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(userDataDir, {
        CANOPY_E2E_CLIENT_FEATURE_FLAGS: DIRECT_FORK_FLAGS,
      }),
    }));
    await connectSharedContainersAccount(await electronApp.firstWindow());
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    electronApp = undefined;
    seedDirectForkReplicas(userDataDir, {
      preferences: false,
      includeRun: false,
    });
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(userDataDir, {
        CANOPY_E2E_CLIENT_FEATURE_FLAGS: DIRECT_FORK_FLAGS,
      }),
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await acceptSharedContainerInvitation(
      window,
      SHARED_CONTAINER_RECIPIENT_COWORK_ID,
    );
    await window
      .getByTestId(
        `shared-container-row-${SHARED_CONTAINER_RECIPIENT_COWORK_ID}`,
      )
      .click();
    const surface = window.getByTestId('shared-container-surface');
    await expect(surface).toBeVisible();
    await expect(
      surface.getByTestId('panel-tab-panel-chat-cowork-chat'),
    ).toBeVisible();
    const index = JSON.parse(
      readFileSync(
        path.join(userDataDir, 'shared-containers', 'index.json'),
        'utf8',
      ),
    );
    const original = {
      ...index.containers[SHARED_CONTAINER_RECIPIENT_COWORK_ID],
      package: {
        digest: `pp:v1:${'a'.repeat(43)}`,
        counts: {
          skills: 1,
          pipelines: 0,
          agents: 0,
          automations: 0,
          hooks: 0,
        },
        executableFiles: ['original/scripts/run.sh'],
      },
    };
    // Use the production replica event path to simulate completed publications.
    // The existing success tests exercise real fork effects; this refusal
    // records the consent-bearing request without installing a test package.
    await electronApp.evaluate(({ BrowserWindow, ipcMain }, state) => {
      globalThis.__can4655Replica = state;
      ipcMain.removeHandler('shared-containers:replica-state');
      ipcMain.handle(
        'shared-containers:replica-state',
        () => globalThis.__can4655Replica,
      );
      ipcMain.removeHandler('shared-containers:fork');
      ipcMain.handle('shared-containers:fork', (_event, request) => {
        globalThis.__can4655LastFork = request;
        throw new Error('Audit fork request captured');
      });
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send('shared-containers:replica-changed', state);
      }
    }, original);
    await surface.getByTestId('shared-container-fork-open-modal').click();
    await window.getByTestId('shared-container-fork-continue').click();
    await expect(
      window.getByTestId('shared-container-fork-capabilities'),
    ).toHaveText(
      'Installs 1 skill, plus 1 script that can run on this computer.',
    );
    // The script names sit behind Show details.
    await window.getByTestId('shared-container-fork-details-toggle').click();
    await expect(
      window.getByTestId('shared-container-fork-details'),
    ).toContainText('New chats in the copy start with this skill turned on.');
    const disclosure = window.getByTestId('shared-container-fork-scripts');
    await expect(disclosure).toContainText('original/scripts/run.sh');
    await electronApp.evaluate(
      ({ BrowserWindow }, state) => {
        globalThis.__can4655Replica = state;
        for (const window of BrowserWindow.getAllWindows()) {
          window.webContents.send('shared-containers:replica-changed', state);
        }
      },
      {
        ...original,
        revisionId: 'cowork-revision-2',
        revision: 2,
        package: {
          ...original.package,
          digest: `pp:v1:${'b'.repeat(43)}`,
          executableFiles: ['new/scripts/undisclosed.sh'],
        },
      },
    );
    // The original consent stays visible until the recipient explicitly
    // reviews the new revision and the scripts that come with it.
    await expect(
      surface.getByTestId('panel-tab-panel-chat-cowork-chat'),
    ).toBeVisible();
    await expect(disclosure).toContainText('original/scripts/run.sh');
    await expect(disclosure).not.toContainText('undisclosed.sh');
    await expect(
      window.getByTestId('shared-container-fork-confirm'),
    ).toBeDisabled();
    expect(
      await electronApp.evaluate(() => globalThis.__can4655LastFork),
    ).toBeUndefined();
    await window.getByTestId('shared-container-fork-revision-accept').click();
    await expect(disclosure).toContainText('new/scripts/undisclosed.sh');
    await expect(disclosure).not.toContainText('original/scripts/run.sh');
    await window.getByTestId('shared-container-fork-confirm').click();
    await expect
      .poll(() => electronApp.evaluate(() => globalThis.__can4655LastFork))
      .toMatchObject({
        revisionId: 'cowork-revision-2',
        expectedPackageDigest: `pp:v1:${'b'.repeat(43)}`,
      });
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, SHARED_CONTAINERS_CLOUD_API_KEY);
  }
});

/**
 * CAN-4655: a real capability package, built by the production definition
 * builders and package analyzer (see
 * fixtures/shared-container-capability-package.build.mjs), with one skill
 * carrying a script, one Agent, one pipeline (plus its child pipeline), one
 * Cowork automation and one hook.
 */
const CAPABILITY_PACKAGE = JSON.parse(
  readFileSync(
    new URL(
      './fixtures/shared-container-capability-package.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const HOOKS_OMITTED_WARNING =
  "Hooks from this share weren't added because they can't start paused in every worktree yet.";
const INVALID_PACKAGE_WARNING =
  "Capabilities from this share weren't installed because they couldn't be verified.";

/** The skill's SKILL.md bytes replaced while the manifest keeps its hash. */
function tamperedSkillPackage() {
  const tampered = structuredClone(CAPABILITY_PACKAGE);
  const skill = tampered.manifest.resources.find(
    (resource) => resource.kind === 'standalone_skill',
  );
  const entry = skill.trees[0].entries.find(
    (candidate) => candidate.path === 'SKILL.md',
  );
  tampered.blobs[entry.sha256] = Buffer.from(
    '# Not the reviewed skill\n',
  ).toString('base64');
  return tampered;
}

function readJsonIfPresent(filePath, fallback) {
  return existsSync(filePath)
    ? JSON.parse(readFileSync(filePath, 'utf8'))
    : fallback;
}

/** Every SKILL.md under the data directory's skills root. */
function installedSkillFiles(userDataDir) {
  const root = path.join(userDataDir, 'skills');
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true })
    .map(String)
    .filter((relative) => path.basename(relative) === 'SKILL.md')
    .map((relative) => path.join(root, relative));
}

function installedCapabilities(userDataDir) {
  const names = CAPABILITY_PACKAGE.names;
  const agents = readJsonIfPresent(
    path.join(userDataDir, 'agent-models.json'),
    { agents: [] },
  ).agents.filter((agent) => agent.name.startsWith(names.agent));
  const automations = readJsonIfPresent(
    path.join(userDataDir, 'automations.json'),
    { activities: [] },
  ).activities.filter((activity) => activity.name.startsWith(names.automation));
  const pipelineIndex = JSON.stringify(
    readJsonIfPresent(path.join(userDataDir, 'pipelines', 'index.json'), {}),
  );
  const skills = installedSkillFiles(userDataDir).filter((file) =>
    readFileSync(file, 'utf8').includes(`name: ${names.skill}`),
  );
  const ledger = JSON.stringify(
    readJsonIfPresent(
      path.join(userDataDir, 'pipeline-package-installs.json'),
      {},
    ),
  );
  return {
    agents,
    automations,
    pipelineInstalled: pipelineIndex.includes(names.pipeline),
    skills,
    ledgerHasShare: ledger.includes(SHARED_CONTAINER_RECIPIENT_COWORK_ID),
  };
}

/**
 * Records what main's fork handler returns while still delivering it to the
 * renderer, so the spec can read the warning sentences the toast summarizes.
 */
async function recordForkResponses(electronApp) {
  return electronApp.evaluate(({ ipcMain }) => {
    const handlers = ipcMain._invokeHandlers;
    const original = handlers?.get('shared-containers:fork');
    if (!original) return false;
    globalThis.__can4655ForkResponses = [];
    handlers.set('shared-containers:fork', async (event, ...args) => {
      const reply = event._reply;
      if (typeof reply === 'function')
        event._reply = (value) => {
          globalThis.__can4655ForkResponses.push(value);
          return reply.call(event, value);
        };
      const result = await original(event, ...args);
      if (result !== undefined) globalThis.__can4655ForkResponses.push(result);
      return result;
    });
    return true;
  });
}

/**
 * Accepts the seeded Cowork share whose pinned revision carries
 * `packageDownload`, opens Make a copy, and returns at the disclosures. The
 * replica holds the summary the server reports for the revision, which is
 * what the dialog discloses and pins.
 */
async function openPackagedCoworkFork(userDataDir, packageDownload) {
  const summary = sharedContainerPackageMetadata(CAPABILITY_PACKAGE);
  const scenario = sharedContainerRecipientScenario({
    includeCode: false,
    includeRun: false,
  });
  const container = scenario.sharedContainersState.containers[0];
  container.access = 'direct';
  // A direct recipient is authorized by its grant when reading the pinned
  // package; organization membership alone does not authorize this lane.
  scenario.sharedContainersState.grants.push({
    id: '44444444-4444-4444-8444-444444444444',
    containerId: container.id,
    recipient: {
      kind: 'member',
      userId: '99999999-9999-4999-8999-999999999999',
      name: 'Mock Owner',
    },
    capabilities: ['VIEW'],
    createdAt: '2026-08-01T12:00:00.000Z',
  });
  container.latestRevision = { ...container.latestRevision, package: summary };
  scenario.sharedContainersState.revisions = [
    {
      containerId: SHARED_CONTAINER_RECIPIENT_COWORK_ID,
      revision: container.latestRevision,
      packageDownload,
    },
  ];
  await registerScenario(
    DEFAULT_MOCK_BASE_URL,
    SHARED_CONTAINERS_CLOUD_API_KEY,
    scenario,
  );
  let { electronApp } = await launchCanopy({
    userDataDir,
    env: buildSharedContainerE2eEnv(userDataDir, {
      CANOPY_E2E_CLIENT_FEATURE_FLAGS: DIRECT_FORK_FLAGS,
    }),
  });
  await connectSharedContainersAccount(await electronApp.firstWindow());
  await closeCanopy(electronApp, userDataDir, { keepUserData: true });
  seedDirectForkReplicas(userDataDir, {
    preferences: false,
    includeRun: false,
  });
  seedCoworkWorkspace({ userDataDir, collapsed: false });
  const indexPath = path.join(userDataDir, 'shared-containers', 'index.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  index.containers[SHARED_CONTAINER_RECIPIENT_COWORK_ID].package = summary;
  writeFileSync(indexPath, JSON.stringify(index), 'utf8');
  ({ electronApp } = await launchCanopy({
    userDataDir,
    env: buildSharedContainerE2eEnv(userDataDir, {
      CANOPY_E2E_CLIENT_FEATURE_FLAGS: DIRECT_FORK_FLAGS,
    }),
  }));
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openChatPage();
  await expect(window.getByTestId('cowork-top-bar')).toBeVisible({
    timeout: 30_000,
  });
  await app.openMainPage();
  await acceptSharedContainerInvitation(
    window,
    SHARED_CONTAINER_RECIPIENT_COWORK_ID,
  );
  const row = window.getByTestId(
    `shared-container-row-${SHARED_CONTAINER_RECIPIENT_COWORK_ID}`,
  );
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.hover();
  await window
    .getByTestId(
      `shared-container-row-${SHARED_CONTAINER_RECIPIENT_COWORK_ID}-actions`,
    )
    .click();
  const forkItem = window.getByTestId(
    `shared-container-row-${SHARED_CONTAINER_RECIPIENT_COWORK_ID}-fork`,
  );
  await expect(forkItem).toBeEnabled({ timeout: 30_000 });
  await forkItem.click();
  await window.getByTestId('shared-container-fork-continue').click();
  const disclosure = window.getByTestId('shared-container-fork-capabilities');
  await expect(disclosure).toBeVisible();
  return { electronApp, window, app, disclosure, summary };
}

async function confirmFork(electronApp, window) {
  const recording = await recordForkResponses(electronApp);
  await window.getByTestId('shared-container-fork-confirm').click();
  await expect(window.getByTestId('shared-container-fork-modal')).toHaveCount(
    0,
    { timeout: 60_000 },
  );
  // The copy exists either way; installation problems only ever add
  // warnings, which the success toast summarizes.
  await expect(
    window.getByTestId('toast-card').filter({
      hasText: /Copy made\. .+ could not bring everything across\./,
    }),
  ).toBeVisible({ timeout: 30_000 });
  if (!recording) return undefined;
  await expect
    .poll(() =>
      electronApp.evaluate(() => globalThis.__can4655ForkResponses.length),
    )
    .toBeGreaterThan(0);
  const [response] = await electronApp.evaluate(
    () => globalThis.__can4655ForkResponses,
  );
  return response;
}

function forkedCoworkWorkspace(userDataDir) {
  const workspaceIndex = JSON.parse(
    readFileSync(path.join(userDataDir, 'workspaces', 'index.json'), 'utf8'),
  );
  return workspaceIndex.workspaces.find(
    (workspace) => workspace.name === 'Customer follow-up',
  );
}

test('installs the disclosed capability package with a Cowork copy', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-package-fork-'),
  );
  let electronApp;
  try {
    let window;
    let app;
    let disclosure;
    let summary;
    ({ electronApp, window, app, disclosure, summary } =
      await openPackagedCoworkFork(userDataDir, CAPABILITY_PACKAGE));
    // Hooks are counted in the package but never installed, and the copy
    // names every script that can run, in full.
    await expect(disclosure).toHaveText(
      'Installs 1 skill, 1 pipeline, 1 Agent and 1 automation, plus 1 script that can run on this computer.',
    );
    await window.getByTestId('shared-container-fork-details-toggle').click();
    const details = window.getByTestId('shared-container-fork-details');
    await expect(details).toContainText(
      'New chats in the copy start with this skill turned on.',
    );
    await expect(details).toContainText('The automation starts turned off.');
    await expect(details).toContainText("Hooks from this share aren't added.");
    for (const script of summary.executableFiles) {
      await expect(
        window.getByTestId('shared-container-fork-scripts'),
      ).toContainText(script);
    }
    expect(installedCapabilities(userDataDir)).toMatchObject({
      agents: [],
      automations: [],
      pipelineInstalled: false,
      skills: [],
    });

    const response = await confirmFork(electronApp, window);
    if (response) {
      expect(response.warnings).toContain(HOOKS_OMITTED_WARNING);
      expect(response.warnings).not.toContain(INVALID_PACKAGE_WARNING);
    }

    const forkWorkspace = forkedCoworkWorkspace(userDataDir);
    expect(forkWorkspace).toBeTruthy();
    await expect
      .poll(() => installedCapabilities(userDataDir).ledgerHasShare, {
        timeout: 30_000,
      })
      .toBe(true);
    const installed = installedCapabilities(userDataDir);
    expect(installed.skills).toHaveLength(1);
    expect(
      lstatSync(
        path.join(path.dirname(installed.skills[0]), 'scripts', 'summarize.sh'),
      ).mode & 0o111,
    ).not.toBe(0);
    expect(installed.agents).toHaveLength(1);
    expect(installed.pipelineInstalled).toBe(true);
    expect(installed.automations).toHaveLength(1);
    const [automation] = installed.automations;
    expect(automation.enabled).toBe(false);
    // Retargeted at the copy, not at the publisher's machine.
    expect(JSON.stringify(automation.action)).toContain(forkWorkspace.id);
    expect(JSON.stringify(automation.action)).not.toContain('cowork-local-1');
    // No hook reached any workspace configuration.
    const workspacesRoot = path.join(userDataDir, 'workspaces');
    for (const relative of readdirSync(workspacesRoot, { recursive: true })) {
      const file = path.join(workspacesRoot, String(relative));
      if (!file.endsWith('.json') || lstatSync(file).isDirectory()) continue;
      expect(readFileSync(file, 'utf8')).not.toContain('echo opened');
    }

    // The automation is listed, turned off, in the Workflows library.
    await app.openAutomationsPage();
    await expect(
      app
        .workflowsLibraryAutomationRow(automation.id)
        .getByTestId('workflows-library-toggle'),
    ).toHaveAttribute('aria-checked', 'false', { timeout: 30_000 });
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

test('keeps the copy and installs nothing when a package file was tampered with', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-package-tamper-'),
  );
  let electronApp;
  try {
    let window;
    let disclosure;
    ({ electronApp, window, disclosure } = await openPackagedCoworkFork(
      userDataDir,
      tamperedSkillPackage(),
    ));
    await expect(disclosure).toContainText('Installs ');

    const response = await confirmFork(electronApp, window);
    if (response) {
      expect(response.warnings).toContain(INVALID_PACKAGE_WARNING);
    }

    // The fork itself is intact and opens as an ordinary local copy.
    expect(forkedCoworkWorkspace(userDataDir)).toBeTruthy();
    await expect(window.getByTestId('page-chat')).toBeVisible({
      timeout: 30_000,
    });
    await expect(window.getByTestId('cowork-top-workspace-name')).toHaveText(
      'Customer follow-up',
    );
    expect(installedCapabilities(userDataDir)).toMatchObject({
      agents: [],
      automations: [],
      pipelineInstalled: false,
      skills: [],
      ledgerHasShare: false,
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
