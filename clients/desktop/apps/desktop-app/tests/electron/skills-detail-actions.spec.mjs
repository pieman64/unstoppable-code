import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { readChatStorageIndexes } from './readChatStorage.mjs';
import { writeJson } from './seeders/fsHelpers.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  clearScenario,
} from './seeders/index.mjs';

// The skill page heading is the skill's display title (CAN-4264).
function skillTitle(name) {
  return name
    .split(/[^A-Za-z0-9]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment[0].toUpperCase() + segment.slice(1))
    .join(' ');
}

// CAN-3482: the installed skill detail offers the same Share and Delete/Remove
// actions as its list row, with the same eligibility and confirmation flows.
// CAN-3483: that detail is the Marketplace detail page
// (`Marketplace > Installed > Skills > <name>`), not a popup, and the Skills
// breadcrumb returns to the installed Skills list with its state. CAN-4261:
// the page has no Back control; the breadcrumb is the way out.
// CAN-3485: a custom skill's Edit opens its edit page
// (`Marketplace > Installed > Skills > <name> > Edit`) in place of the
// detail; Cancel and Back return to the detail, Save to the updated detail.
//
// Testids exercised:
//   - `plugins-entry-detail-page`    -> installed skill detail page root
//   - `plugins-entry-detail-breadcrumbs` / `-breadcrumb-type` /
//     `-breadcrumb-installed`        -> page breadcrumb trail
//   - `plugins-entry-detail-back`    -> page Back control (absent, CAN-4261)
//   - `plugins-management-section-skills` -> installed Skills list
//   - `skill-read-detail-share`      -> detail Share action
//   - `skill-read-detail-edit`       -> detail Edit action (custom only)
//   - `skill-read-detail-remove`     -> detail Delete/Remove action
//   - `skill-delete-confirm-modal`   -> shared Delete/Remove confirmation
//   - `skill-delete-confirm`         -> confirmation button
//   - `cloud-sync-modal`             -> disconnected share gate
//   - `share-skill-modal`            -> Share Skill dialog
//   - `skill-share-builtin:*`        -> bundled row Share action
//   - `skill-editor-page`            -> custom skill edit page root
//   - `skill-editor-page-actions`    -> edit page actions row
//   - `skill-editor-cancel` / `skill-editor-save` -> edit page actions
//   - `plugins-entry-detail-breadcrumb-entry` / `-breadcrumb-edit`
//                                    -> edit page's `<name> > Edit` crumbs
//   - `skill-edit-custom:app-<name>` -> installed Skills row Edit action
// CAN-1259: "Edit with AI" on the detail, the edit page, and the custom row
// opens a new Cowork chat with the skill selected and the prompt drafted
// (not sent); read-only skills explain why it is unavailable.
//   - `skill-read-detail-edit-with-ai` -> detail Edit with AI item in the
//                                       More menu (CAN-4261)
//   - `skill-editor-edit-with-ai`    -> edit page Edit with AI action
//   - `skill-edit-with-ai-custom:app-<name>` -> installed row Edit with AI
//   - `page-chat`                    -> Cowork chat page

const CUSTOM_SKILL = 'detail-custom-skill';
const SHARED_CUSTOM_SKILL = 'detail-shared-custom-skill';
const INSTALLED_SOURCE_ID = 'local:e2e-detail-actions';
const INSTALLED_SKILL = 'detail-installed-skill';

function writeSkill(directory, name, description) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\nUse this skill.\n`,
  );
}

function seedSkills(userDataDir) {
  const skillsRoot = path.join(userDataDir, 'skills');
  writeSkill(
    path.join(skillsRoot, 'custom:app', CUSTOM_SKILL),
    CUSTOM_SKILL,
    'Authored locally for the detail actions check.',
  );
  writeSkill(
    path.join(skillsRoot, 'custom:app', SHARED_CUSTOM_SKILL),
    SHARED_CUSTOM_SKILL,
    'Shared from the detail actions check.',
  );
  writeSkill(
    path.join(skillsRoot, INSTALLED_SOURCE_ID, INSTALLED_SKILL),
    INSTALLED_SKILL,
    'Installed from a local source for the detail actions check.',
  );
  const now = new Date('2026-01-01T00:00:00.000Z').toISOString();
  writeJson(path.join(skillsRoot, 'skills-lock.json'), {
    version: 2,
    skills: {
      [`${INSTALLED_SOURCE_ID}/${INSTALLED_SKILL}`]: {
        sourceId: INSTALLED_SOURCE_ID,
        source: '/tmp/e2e-detail-actions',
        sourceType: 'local',
        sourceUrl: '',
        skillPath: INSTALLED_SKILL,
        skillFolderHash: 'e2e',
        installedAt: now,
        updatedAt: now,
      },
    },
  });
}

test('installed skill detail offers the list Share and Delete/Remove flows', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-skill-detail-actions-'),
  );
  seedSkills(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();
    await app.openPluginsPage();
    await app.openPluginsTab('skills');
    await app.expectPluginsTab('skills');

    const detailTitle = window.locator('#skill-detail-modal-title');
    const detailPage = window.getByTestId('plugins-entry-detail-page');
    const skillsList = window.getByTestId('plugins-management-section-skills');
    const shareAction = window.getByTestId('skill-read-detail-share');
    const editAction = window.getByTestId('skill-read-detail-edit');
    const removeAction = window.getByTestId('skill-read-detail-remove');
    const moreAction = window.getByTestId('skill-read-detail-more');
    const moreMenu = window.getByTestId('skill-read-detail-menu');
    // Delete and Remove sit last in the header's More menu (CAN-4264).
    const openMore = async () => {
      if (!(await moreMenu.isVisible())) await moreAction.click();
      await expect(moreMenu).toBeVisible();
    };
    const closeMore = async () => {
      if (await moreMenu.isVisible()) await moreAction.click();
      await expect(moreMenu).toHaveCount(0);
    };
    const confirmModal = window.getByTestId('skill-delete-confirm-modal');
    const openSkill = async (name) => {
      await window.locator('tbody button', { hasText: name }).first().click();
      await expect(detailTitle).toHaveText(skillTitle(name));
      // A Marketplace page, not a dialog over the list.
      await expect(detailPage).toBeVisible();
      await expect(window.getByRole('dialog', { name })).toHaveCount(0);
      await expect(skillsList).toBeHidden();
    };

    // ---------------------------------------------------------------------
    // Custom skill: Share, Edit, and Delete, like its list row.
    // ---------------------------------------------------------------------
    await openSkill(SHARED_CUSTOM_SKILL);
    await expect(shareAction).toBeVisible();
    await expect(editAction).toBeVisible();
    await openMore();
    await expect(removeAction).toHaveText('Delete');
    await closeMore();

    // Share goes through the same account gate as the list.
    await shareAction.click();
    const cloudSyncModal = window.getByTestId('cloud-sync-modal');
    await expect(cloudSyncModal).toBeVisible();
    await expect(window.getByTestId('share-skill-modal')).toHaveCount(0);
    await cloudSyncModal.getByRole('button', { name: 'Close' }).click();
    await expect(cloudSyncModal).toHaveCount(0);
    await expect(detailTitle).toHaveText(skillTitle(SHARED_CUSTOM_SKILL));

    const saveResult = await window.evaluate(
      async (apiKey) => window.api.saveCanopyCloudApiKey({ apiKey }),
      'csk_skill_detail_actions_e2e',
    );
    expect(
      saveResult.status,
      saveResult.status.error ?? 'Skill sharing account did not connect',
    ).toMatchObject({ authenticated: true });
    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('skills:shared-create');
      // Share create resolves a ShareOperationResult envelope.
      ipcMain.handle('skills:shared-create', (_event, request) => ({
        ok: true,
        value: {
          id: 'detail-shared-skill',
          name: 'detail-shared-custom-skill',
          description: 'Shared from the detail actions check.',
          contentHash: 'sha256:detail-shared-skill',
          shareScope: request.shareScope,
          owner: {
            type: 'user',
            id: 'mock-cloud-account',
            name: 'Test User',
          },
          createdBy: {
            id: 'mock-cloud-account',
            name: 'Test User',
            email: 'test@example.com',
          },
          createdAt: '2026-09-29T00:00:00.000Z',
          updatedAt: '2026-09-29T00:00:00.000Z',
          canUpdate: true,
          canDelete: true,
          publicShare: null,
          rawSkill: request.rawSkill,
        },
      }));
      ipcMain.removeHandler('skills:shared-publish-public');
      ipcMain.handle('skills:shared-publish-public', () => ({
        externalId: 'detail-shared-skill-public',
        pinnedContentHash: 'sha256:detail-shared-skill',
        upToDate: true,
        sharePath: '/portal/plugins/skills/shared/detail-shared-skill-public',
        createdAt: '2026-09-29T00:00:00.000Z',
        updatedAt: '2026-09-29T00:00:00.000Z',
      }));
    });
    await window.evaluate(() => {
      window.dispatchEvent(new Event('canopy:cloud-account-changed'));
    });

    await shareAction.click();
    const shareModal = window.getByTestId('share-skill-modal');
    await expect(shareModal).toBeVisible();
    // Sharing never deletes the local source, so there is no delete-local
    // option to pick.
    await expect(
      shareModal.getByTestId('share-skill-delete-local'),
    ).toHaveCount(0);
    await expect(shareModal.getByTestId('share-skill-submit')).toBeEnabled({
      timeout: 30_000,
    });
    await shareModal.getByTestId('share-skill-submit').click();
    await expect(shareModal).toHaveCount(0);
    // The shared-link toast stays until dismissed and covers the header's
    // top-right corner, where a skill with only Try it now keeps its More
    // button (CAN-4261). Close it so later header actions stay clickable.
    const shareToast = window
      .getByTestId('toast-stack-card')
      .filter({ has: window.getByTestId('toast-copy-link') });
    await expect(shareToast).toHaveCount(1);
    await shareToast.getByTestId('toast-dismiss').click();
    await expect(window.getByTestId('toast-copy-link')).toHaveCount(0);
    // The local skill is kept, so its detail page stays open and the Skills
    // crumb returns to an installed Skills list that still lists it
    // (CAN-4261: the page has no Back).
    await expect(detailTitle).toHaveText(skillTitle(SHARED_CUSTOM_SKILL));
    await window.getByTestId('plugins-entry-detail-breadcrumb-type').click();
    await expect(detailTitle).toHaveCount(0);
    await expect(skillsList).toBeVisible();
    await expect(
      window.locator('tbody button', { hasText: SHARED_CUSTOM_SKILL }),
    ).toHaveCount(1);

    await openSkill(CUSTOM_SKILL);
    await expect(shareAction).toBeVisible();
    await expect(editAction).toBeVisible();
    await openMore();
    await expect(removeAction).toHaveText('Delete');

    // Delete uses the list's confirmation; cancelling keeps the detail open.
    await removeAction.click();
    await expect(confirmModal).toBeVisible();
    await expect(confirmModal).toContainText(`Delete skill "${CUSTOM_SKILL}"?`);
    await confirmModal.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirmModal).toHaveCount(0);
    await expect(detailTitle).toHaveText(skillTitle(CUSTOM_SKILL));

    await openMore();
    await removeAction.click();
    await window.getByTestId('skill-delete-confirm').click();
    await expect(confirmModal).toHaveCount(0);
    await expect(detailTitle).toHaveCount(0);
    await expect(skillsList).toBeVisible();
    await expect(
      window.locator('tbody button', { hasText: CUSTOM_SKILL }),
    ).toHaveCount(0);

    // ---------------------------------------------------------------------
    // Installed skill: Remove only, like its list row.
    // ---------------------------------------------------------------------
    await openSkill(INSTALLED_SKILL);
    await expect(shareAction).toHaveCount(0);
    await expect(editAction).toHaveCount(0);
    await openMore();
    await expect(removeAction).toHaveText('Remove');

    await removeAction.click();
    await expect(confirmModal).toContainText(
      `Remove skill "${INSTALLED_SKILL}"?`,
    );
    await window.getByTestId('skill-delete-confirm').click();
    await expect(confirmModal).toHaveCount(0);
    await expect(detailTitle).toHaveCount(0);
    await expect(skillsList).toBeVisible();
    await expect(
      window.locator('tbody button', { hasText: INSTALLED_SKILL }),
    ).toHaveCount(0);

    // ---------------------------------------------------------------------
    // Bundled skill: Share only; no removal, like its list row.
    // ---------------------------------------------------------------------
    const bundledRow = window
      .locator('tbody tr', {
        has: window.locator('[data-testid^="skill-share-builtin"]'),
      })
      .first();
    await bundledRow.locator('td').first().getByRole('button').click();
    await expect(detailPage).toBeVisible();
    await expect(shareAction).toBeVisible();
    // CAN-4261: More holds only the unavailable Edit with AI; no update,
    // no removal.
    await expect(moreAction).toHaveCount(1);
    await moreAction.click();
    const bundledMenu = window.getByTestId('skill-read-detail-menu');
    await expect(bundledMenu).toBeVisible();
    await expect(
      bundledMenu.getByTestId('skill-read-detail-edit-with-ai'),
    ).toBeDisabled();
    await expect(removeAction).toHaveCount(0);
    await window.keyboard.press('Escape');
    await expect(editAction).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('installed skill page returns to the installed Skills list with its scroll', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-skill-detail-page-return-'),
  );
  // Enough rows that the installed Skills list scrolls.
  const names = Array.from(
    { length: 30 },
    (_, index) => `page-return-skill-${String(index + 1).padStart(2, '0')}`,
  );
  for (const name of names) {
    writeSkill(
      path.join(userDataDir, 'skills', 'custom:app', name),
      name,
      'Seeded so the installed Skills list scrolls.',
    );
  }
  const lastSkill = names[names.length - 1];
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openPluginsPage();
    await app.openPluginsTab('skills');
    await app.expectPluginsTab('skills');

    const skillsList = window.getByTestId('plugins-management-section-skills');
    const scroller = window
      .getByTestId('plugins-management-content')
      .locator('.page-scroll-gutter');
    const detailPage = window.getByTestId('plugins-entry-detail-page');
    const lastRow = window.locator('tbody button', { hasText: lastSkill });

    await lastRow.scrollIntoViewIfNeeded();
    const scrollTop = await scroller.evaluate((node) => node.scrollTop);
    expect(scrollTop).toBeGreaterThan(0);

    const openLastSkill = async () => {
      await lastRow.click();
      await expect(detailPage).toBeVisible();
      await expect(window.locator('#skill-detail-modal-title')).toHaveText(
        skillTitle(lastSkill),
      );
      await expect(
        window
          .getByTestId('plugins-entry-detail-breadcrumbs')
          .getByRole('listitem'),
      ).toHaveText([
        'Customize',
        'Installed',
        'Skills',
        'Page Return Skill 30',
      ]);
      await expect(
        window.getByTestId('plugins-entry-detail-breadcrumb-type'),
      ).toHaveAttribute('data-entry-kind', 'skill');
    };

    // CAN-4261: the page has no Back; the Skills breadcrumb returns to the
    // same list at the same scroll position.
    await openLastSkill();
    await expect(window.getByTestId('plugins-entry-detail-back')).toHaveCount(
      0,
    );
    await window.getByTestId('plugins-entry-detail-breadcrumb-type').click();
    await expect(detailPage).toHaveCount(0);
    await expect(skillsList).toBeVisible();
    await expect(lastRow).toBeInViewport();
    expect(await scroller.evaluate((node) => node.scrollTop)).toBe(scrollTop);

    // Edit opens the skill's edit page on the same Marketplace page
    // (CAN-3485); Cancel returns to the detail, an in-place save re-reads the
    // content, and a rename follows the skill.
    await openLastSkill();
    const editor = window.getByTestId('skill-editor-page');
    await window.getByTestId('skill-read-detail-edit').click();
    await expect(editor).toBeVisible();
    await expect(detailPage).toBeVisible();
    await window.getByTestId('skill-editor-cancel').click();
    await expect(editor).toHaveCount(0);
    await expect(window.locator('#skill-detail-modal-title')).toHaveText(
      skillTitle(lastSkill),
    );

    await window.getByTestId('skill-read-detail-edit').click();
    await window
      .getByPlaceholder('One-line summary of when this skill should be used.')
      .fill('Updated from the detail page.');
    await window.getByTestId('skill-editor-save').click();
    await expect(editor).toHaveCount(0);
    await expect(detailPage).toContainText('Updated from the detail page.');

    await window.getByTestId('skill-read-detail-edit').click();
    await window.getByPlaceholder('my-skill-name').fill('page-return-renamed');
    await window.getByTestId('skill-editor-save').click();
    await expect(editor).toHaveCount(0);
    await expect(window.locator('#skill-detail-modal-title')).toHaveText(
      skillTitle('page-return-renamed'),
    );
    await expect(
      window.getByTestId('plugins-entry-detail-breadcrumb-current'),
    ).toHaveText('Page Return Renamed');
    await expect(
      window.getByTestId('plugins-entry-detail-breadcrumb-installed'),
    ).toBeVisible();

    // The Installed breadcrumb leads to the mixed Installed list.
    await window
      .getByTestId('plugins-entry-detail-breadcrumb-installed')
      .click();
    await expect(detailPage).toHaveCount(0);
    await expect(
      window.getByTestId('plugins-management-section-installed'),
    ).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('custom skill Edit opens its Marketplace edit page', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-skill-editor-page-'),
  );
  writeSkill(
    path.join(userDataDir, 'skills', 'custom:app', CUSTOM_SKILL),
    CUSTOM_SKILL,
    'Authored locally for the edit page check.',
  );
  // A long but valid name must not push the Edit crumb out of the titlebar.
  const longSkill = `long-${'breadcrumb-name-'.repeat(12)}end`;
  writeSkill(
    path.join(userDataDir, 'skills', 'custom:app', longSkill),
    longSkill,
    'Long name for the edit page breadcrumb check.',
  );
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openPluginsPage();
    await app.openPluginsTab('skills');
    await app.expectPluginsTab('skills');

    const detailTitle = window.locator('#skill-detail-modal-title');
    const detailPage = window.getByTestId('plugins-entry-detail-page');
    const editorPage = window.getByTestId('skill-editor-page');
    const skillsList = window.getByTestId('plugins-management-section-skills');
    const crumbs = window
      .getByTestId('plugins-entry-detail-breadcrumbs')
      .getByRole('listitem');
    const editCrumbs = [
      'Customize',
      'Installed',
      'Skills',
      'Detail Custom Skill',
      'Edit',
    ];
    const descriptionInput = window.getByTestId(
      'skill-editor-description-input',
    );
    const nameInput = window.getByPlaceholder('my-skill-name');
    const save = window.getByTestId('skill-editor-save');

    // ---------------------------------------------------------------------
    // Detail Edit -> edit page with the `<name> > Edit` breadcrumb level.
    // ---------------------------------------------------------------------
    await window
      .locator('tbody button', { hasText: CUSTOM_SKILL })
      .first()
      .click();
    await expect(detailTitle).toHaveText(skillTitle(CUSTOM_SKILL));
    await window.getByTestId('skill-read-detail-edit').click();
    await expect(editorPage).toBeVisible();
    await expect(detailPage).toBeVisible();
    // A page, not the editor dialog over the detail.
    await expect(window.locator('#create-skill-modal-title')).toHaveCount(0);
    await expect(detailTitle).toHaveCount(0);
    await expect(crumbs).toHaveText(editCrumbs);
    await expect(
      window.getByTestId('plugins-entry-detail-breadcrumb-edit'),
    ).toHaveAttribute('aria-current', 'page');
    await expect(window.getByTestId('skill-editor-page-actions')).toBeVisible();
    await expect(nameInput).toHaveValue(CUSTOM_SKILL);
    await expect(descriptionInput).toHaveValue(
      'Authored locally for the edit page check.',
    );

    // Validation stays inline and blocks Save.
    await nameInput.fill('Detail_Custom');
    await expect(
      window.getByText(
        'Skill name can only contain lowercase letters, numbers, and hyphens.',
      ),
    ).toBeVisible();
    await expect(save).toBeDisabled();

    // Cancel discards the edit and returns to the details.
    await window.getByTestId('skill-editor-cancel').click();
    await expect(editorPage).toHaveCount(0);
    await expect(detailTitle).toHaveText(skillTitle(CUSTOM_SKILL));
    await expect(
      window.getByTestId('plugins-entry-detail-breadcrumb-current'),
    ).toHaveText('Detail Custom Skill');

    // The name crumb also returns to the details.
    await window.getByTestId('skill-read-detail-edit').click();
    await expect(editorPage).toBeVisible();
    await window.getByTestId('plugins-entry-detail-breadcrumb-entry').click();
    await expect(editorPage).toHaveCount(0);
    await expect(detailTitle).toHaveText(skillTitle(CUSTOM_SKILL));

    // ---------------------------------------------------------------------
    // Modify + save -> the updated details, and the installed list refreshed.
    // ---------------------------------------------------------------------
    await window.getByTestId('skill-read-detail-edit').click();
    await expect(nameInput).toHaveValue(CUSTOM_SKILL);
    await descriptionInput.fill('Updated from the edit page.');
    await save.click();
    await expect(editorPage).toHaveCount(0);
    await expect(detailTitle).toHaveText(skillTitle(CUSTOM_SKILL));
    await expect(detailPage).toContainText('Updated from the edit page.');

    // CAN-4261: the page has no Back; the Skills crumb returns to the list.
    await window.getByTestId('plugins-entry-detail-breadcrumb-type').click();
    await expect(skillsList).toBeVisible();
    await expect(
      window.locator('tbody tr', { hasText: CUSTOM_SKILL }),
    ).toContainText('Updated from the edit page.');

    // ---------------------------------------------------------------------
    // The list row's Edit opens the same page; Cancel lands on the details.
    // ---------------------------------------------------------------------
    await window.getByTestId(`skill-edit-custom:app-${CUSTOM_SKILL}`).click();
    await expect(editorPage).toBeVisible();
    await expect(skillsList).toBeHidden();
    await expect(crumbs).toHaveText(editCrumbs);
    await expect(descriptionInput).toHaveValue('Updated from the edit page.');
    await window.getByTestId('skill-editor-cancel').click();
    await expect(editorPage).toHaveCount(0);
    await expect(detailTitle).toHaveText(skillTitle(CUSTOM_SKILL));
    await window.getByTestId('plugins-entry-detail-breadcrumb-type').click();
    await expect(skillsList).toBeVisible();

    await window.getByTestId(`skill-edit-custom:app-${longSkill}`).click();
    await expect(editorPage).toBeVisible();
    await expect(
      window.getByTestId('plugins-entry-detail-breadcrumb-edit'),
    ).toBeInViewport({ ratio: 1 });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

/** Cowork chats (default Chats project) that have `skillName` selected. */
function coworkChatsWithSkill(userDataDir, skillName) {
  const workspaceRoot = path.join(userDataDir, 'workspaces', 'cowork-default');
  const manifests = path.join(workspaceRoot, 'chat-storage-manifests');
  if (!existsSync(manifests)) return [];
  return readdirSync(manifests)
    .filter((file) => file.endsWith('.json'))
    .flatMap((file) => {
      const scopeId = file.slice(0, -'.json'.length);
      try {
        return readChatStorageIndexes(workspaceRoot, scopeId).live.tabs;
      } catch {
        return [];
      }
    })
    .filter((tab) =>
      (tab.pluginSelections?.skillRefs ?? []).some(
        (ref) => ref.sourceId === 'custom:app' && ref.skillName === skillName,
      ),
    );
}

test('Edit with AI opens a Cowork chat with the skill selected and the prompt drafted', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-skill-edit-with-ai-'),
  );
  seedSkills(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();

    const prompt = `Help me edit ${CUSTOM_SKILL}. Ask what I want to change, use the available skill-editing tools to propose the changes, and save them after I confirm.`;
    const detailTitle = window.locator('#skill-detail-modal-title');
    const detailPage = window.getByTestId('plugins-entry-detail-page');
    const skillsList = window.getByTestId('plugins-management-section-skills');
    const chatPage = window.getByTestId('page-chat');
    const composer = chatPage.locator('[data-slate-editor="true"]:visible');
    const openSkillsList = async () => {
      await app.openPluginsPage();
      await app.openPluginsTab('skills');
      await app.expectPluginsTab('skills');
      await expect(skillsList).toBeVisible();
    };
    const openSkill = async (name) => {
      await window.locator('tbody button', { hasText: name }).first().click();
      await expect(detailTitle).toHaveText(skillTitle(name));
      await expect(detailPage).toBeVisible();
    };
    const expectDraftedChat = async (expectedChats) => {
      await expect(chatPage).toBeVisible();
      await expect(composer).toHaveCount(1);
      await expect(composer).toHaveText(prompt);
      // Drafted, not sent: the new chat has no user message.
      await expect(
        chatPage.locator('[data-testid="user-message-content"]'),
      ).toHaveCount(0);
      // The exact skill is the chat's selected skill.
      await expect
        .poll(() => coworkChatsWithSkill(userDataDir, CUSTOM_SKILL).length)
        .toBe(expectedChats);
      const [chat] = coworkChatsWithSkill(userDataDir, CUSTOM_SKILL).slice(-1);
      expect(chat.messageCount ?? 0).toBe(0);
    };

    // ---------------------------------------------------------------------
    // Detail page -> new Cowork chat.
    // ---------------------------------------------------------------------
    await openSkillsList();
    await openSkill(CUSTOM_SKILL);
    // CAN-4261: Edit with AI sits in the header's More menu.
    const moreAction = window.getByTestId('skill-read-detail-more');
    const moreMenu = window.getByTestId('skill-read-detail-menu');
    await moreAction.click();
    await expect(moreMenu).toBeVisible();
    const detailAction = moreMenu.getByTestId('skill-read-detail-edit-with-ai');
    await expect(detailAction).toHaveText('Edit with AI');
    await expect(detailAction).toBeEnabled();
    // Keyboard reaches it like the other skill actions.
    await detailAction.focus();
    await window.keyboard.press('Enter');
    await expectDraftedChat(1);

    // ---------------------------------------------------------------------
    // Edit page -> waits for unsaved edits, then a new Cowork chat.
    // ---------------------------------------------------------------------
    await openSkillsList();
    await openSkill(CUSTOM_SKILL);
    await window.getByTestId('skill-read-detail-edit').click();
    await expect(window.getByTestId('skill-editor-page')).toBeVisible();
    const editorAction = window.getByTestId('skill-editor-edit-with-ai');
    const description = window.getByTestId('skill-editor-description-input');
    await expect(description).toHaveValue(
      'Authored locally for the detail actions check.',
    );
    await description.fill('Changed but not saved.');
    await expect(editorAction).toHaveAttribute('aria-disabled', 'true');
    // Playwright treats aria-disabled as disabled; force the press anyway.
    await editorAction.click({ force: true });
    await expect(window.getByTestId('skill-editor-page')).toBeVisible();
    await expect(chatPage).toHaveCount(0);
    await description.fill('Authored locally for the detail actions check.');
    await expect(editorAction).not.toHaveAttribute('aria-disabled', 'true');
    await editorAction.click();
    await expectDraftedChat(2);

    // ---------------------------------------------------------------------
    // Installed Skills row -> new Cowork chat.
    // ---------------------------------------------------------------------
    await openSkillsList();
    await expect(
      window.getByTestId(
        `skill-edit-with-ai-${INSTALLED_SOURCE_ID}-${INSTALLED_SKILL}`,
      ),
    ).toHaveCount(0);
    await window
      .getByTestId(`skill-edit-with-ai-custom:app-${CUSTOM_SKILL}`)
      .click();
    await expectDraftedChat(3);

    // ---------------------------------------------------------------------
    // Read-only skills explain why and do nothing.
    // ---------------------------------------------------------------------
    await openSkillsList();
    await openSkill(INSTALLED_SKILL);
    // CAN-4261: unavailable, it is a disabled More menu item whose reason
    // shows in the menu rather than in a tooltip.
    await moreAction.click();
    await expect(moreMenu).toBeVisible();
    const unavailable = moreMenu.getByTestId('skill-read-detail-edit-with-ai');
    const readOnlyReason =
      'This skill is read-only here. Change it where it was installed from.';
    await expect(unavailable).toBeDisabled();
    await expect(unavailable).toHaveAccessibleDescription(readOnlyReason);
    await expect(moreMenu).toContainText(readOnlyReason);
    await unavailable.click({ force: true });
    await expect(detailPage).toBeVisible();
    await expect(chatPage).toHaveCount(0);
    // Close the menu, then leave through the Skills crumb (no Back).
    await moreAction.click();
    await expect(moreMenu).toHaveCount(0);

    await window.getByTestId('plugins-entry-detail-breadcrumb-type').click();
    await window
      .locator('tbody tr', { hasText: 'built-in' })
      .first()
      .locator('td')
      .first()
      .getByRole('button')
      .click();
    await expect(detailPage).toBeVisible();
    await moreAction.click();
    await expect(moreMenu).toBeVisible();
    await expect(unavailable).toBeDisabled();
    await expect(unavailable).toHaveAccessibleDescription(
      'Built-in skills are read-only. Create a custom skill to make your own version.',
    );
    await expect
      .poll(() => coworkChatsWithSkill(userDataDir, CUSTOM_SKILL).length)
      .toBe(3);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('CAN-4359 skill detail submits once and reopens its standalone chat after reload', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-skill-try-it-'),
  );
  seedSkills(userDataDir);
  await registerScenario(DEFAULT_MOCK_BASE_URL, 'detail-custom-skill', {
    llm: {
      steps: [
        { text: 'The skill example is complete.', stopReason: 'end_turn' },
      ],
    },
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    const open = async () => {
      await app.waitForShell();
      await app.openPluginsPage();
      await app.openPluginsTab('skills');
      await window
        .locator('tbody button', { hasText: CUSTOM_SKILL })
        .first()
        .click();
      await expect(window.locator('#skill-detail-modal-title')).toHaveText(
        skillTitle(CUSTOM_SKILL),
      );
      const primary = window.getByTestId('detail-primary-cta');
      await expect(primary).toHaveText('Try it');
      await primary.click();
    };
    await open();
    const messages = window
      .getByTestId('page-chat')
      .getByTestId('user-message-content');
    await expect(messages).toHaveCount(1, { timeout: 60_000 });
    await expect(messages).toContainText(CUSTOM_SKILL);
    await expect
      .poll(() => coworkChatsWithSkill(userDataDir, CUSTOM_SKILL).length)
      .toBe(1);
    const [chat] = coworkChatsWithSkill(userDataDir, CUSTOM_SKILL);
    await window.reload();
    await open();
    await expect(messages).toHaveCount(1);
    expect(
      coworkChatsWithSkill(userDataDir, CUSTOM_SKILL).map((tab) => tab.id),
    ).toEqual([chat.id]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, 'detail-custom-skill');
  }
});

// CAN-4264: deterministic UI coverage. IPC checks/applies are stubbed; real
// content and inventory reads must observe the changed disk fixtures.
test('CAN-4264 skill page checks, applies once, reloads content and synchronizes Back', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-skill-update-'),
  );
  const sourceId = 'github:e2e:skills';
  const name = 'update-example';
  const key = `${sourceId}/${name}`;
  const skillsRoot = path.join(userDataDir, 'skills');
  const skillDir = path.join(skillsRoot, sourceId, name);
  const statusPath = path.join(skillsRoot, 'update-status.json');
  writeSkill(skillDir, name, 'Before the applied update.');
  writeJson(path.join(skillsRoot, 'skills-lock.json'), {
    version: 2,
    skills: {
      [key]: {
        sourceId,
        source: 'e2e/skills',
        sourceType: 'github',
        sourceUrl: 'https://github.com/e2e/skills',
        skillPath: name,
        skillFolderHash: 'before',
        installedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    },
  });
  writeJson(statusPath, { [key]: false });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    await electronApp.evaluate(({ ipcMain }, skillKey) => {
      const channels = ['skills:check-updates', 'skills:update'];
      const originals = channels.map((channel) => [
        channel,
        ipcMain._invokeHandlers.get(channel),
      ]);
      const state = {
        originals,
        checkCalls: 0,
        applyArgs: [],
        finishCheck: null,
        finishApply: null,
      };
      globalThis.__can4264Updates = state;
      for (const channel of channels) ipcMain.removeHandler(channel);
      ipcMain.handle('skills:check-updates', (event) => {
        state.checkCalls += 1;
        event.sender.send('skills:update-progress', {
          operation: 'check-updates',
          status: 'running',
          message: '',
        });
        return new Promise((resolve) => {
          state.finishCheck = () => {
            const data = { [skillKey]: true };
            event.sender.send('skills:update-progress', {
              operation: 'check-updates',
              status: 'complete',
              message: '',
              updateMap: data,
            });
            resolve({ success: true, data });
          };
        });
      });
      ipcMain.handle('skills:update', (_event, source, skillName) => {
        state.applyArgs.push([source, skillName]);
        return new Promise((resolve) => {
          state.finishApply = () => resolve({ success: true });
        });
      });
    }, key);
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openPluginsPage();
    await app.openPluginsTab('skills');
    const row = window.locator('tbody tr', { hasText: name });
    await row.locator('td').first().getByRole('button').click();
    const detail = window.getByTestId('plugins-entry-detail-page');
    await expect(detail).toContainText('Before the applied update.');
    const more = window.getByTestId('skill-read-detail-more');
    const check = window.getByTestId('skill-read-detail-check-updates');
    const apply = window.getByTestId('skill-read-detail-apply-update');
    const notice = window.getByTestId('skill-update-notice');
    const status = window.getByTestId('skill-update-status');
    const checkCalls = () =>
      electronApp.evaluate(() => globalThis.__can4264Updates.checkCalls);
    // The Customize page checks once per mount for its Updates section
    // (CAN-4261); opening the detail page adds no check of its own.
    await expect.poll(checkCalls).toBe(1);
    // A cached "no update known" claims nothing.
    await expect(status).toHaveCount(0);
    await expect(notice).toHaveCount(0);
    // Check for updates lives in the header's More menu.
    await more.click();
    await check.click();
    await expect(status).toHaveText('Checking for updates…');
    await more.click();
    await expect(check).toBeDisabled();
    await more.click();
    expect(await checkCalls()).toBe(2);
    writeJson(statusPath, { [key]: true });
    await electronApp.evaluate(() => globalThis.__can4264Updates.finishCheck());
    await expect(notice).toHaveAttribute('data-state', 'available');
    await expect(notice).toContainText('Update available');
    await expect(status).toHaveCount(0);
    await apply.evaluate((button) => {
      button.click();
      button.click();
    });
    // Progress replaces the Update button inside the same notice.
    await expect(notice).toHaveAttribute('data-state', 'applying');
    await expect(apply).toHaveCount(0);
    expect(
      await electronApp.evaluate(() => globalThis.__can4264Updates.applyArgs),
    ).toEqual([[sourceId, name]]);
    writeSkill(skillDir, name, 'After the applied update.');
    writeJson(statusPath, { [key]: false });
    await electronApp.evaluate(() => globalThis.__can4264Updates.finishApply());
    await expect(detail).toContainText('After the applied update.');
    await expect(notice).toHaveCount(0);
    await expect(status).toContainText('Up to date');
    // CAN-4261: the page has no Back; the Skills crumb returns to the list.
    await window.getByTestId('plugins-entry-detail-breadcrumb-type').click();
    await expect(row).toContainText('After the applied update.');
    await expect(
      row.getByRole('button', { name: 'Update available', exact: true }),
    ).toHaveCount(0);
    await row.locator('td').first().getByRole('button').click();
    await expect(detail).toContainText('After the applied update.');
    await expect(notice).toHaveCount(0);
    expect(await checkCalls()).toBe(2);
  } finally {
    try {
      await electronApp.evaluate(({ ipcMain }) => {
        const state = globalThis.__can4264Updates;
        if (!state) return;
        state.finishCheck?.();
        state.finishApply?.();
        for (const [channel, handler] of state.originals) {
          ipcMain.removeHandler(channel);
          if (handler) ipcMain.handle(channel, handler);
        }
        delete globalThis.__can4264Updates;
      });
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  }
});
