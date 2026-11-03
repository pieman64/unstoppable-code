import { expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { chooseSettingsOption } from './helpers/settingsSelect.mjs';

// The skill page heading is the skill's display title (CAN-4264).
function skillTitle(name) {
  return name
    .split(/[^A-Za-z0-9]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment[0].toUpperCase() + segment.slice(1))
    .join(' ');
}

const SKILL_NAME = 'test-skill';
const TYPED_METADATA_SKILL_NAME = 'typed-metadata-skill';
const WORKTREE_BRANCH = 'demo-main';

function typedMetadataSkillPath(userDataDir) {
  return path.join(
    userDataDir,
    'skills',
    'custom:app',
    TYPED_METADATA_SKILL_NAME,
    'SKILL.md',
  );
}

function seedTypedMetadataSkill(userDataDir) {
  const skillPath = typedMetadataSkillPath(userDataDir);
  mkdirSync(path.dirname(skillPath), { recursive: true });
  writeFileSync(
    skillPath,
    [
      '---',
      `name: ${TYPED_METADATA_SKILL_NAME}`,
      'description: Original typed metadata description.',
      'user-invocable: false',
      'priority: 2',
      'metadata:',
      '  internal: true',
      'tags:',
      '  - review',
      '  - safe',
      '---',
      '',
      '# Typed metadata',
      '',
    ].join('\n'),
    'utf8',
  );
}

function readTypedMetadataFrontmatter(userDataDir) {
  const raw = readFileSync(typedMetadataSkillPath(userDataDir), 'utf8');
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match) throw new Error('Seeded skill lost its YAML frontmatter.');
  return yaml.load(match[1]);
}

// CAN-4267: installed skills list as Customize rows; a custom skill's Edit
// lives in the row's ⋯ menu.
function installedSkillRow(window, name) {
  return window
    .getByTestId('customize-section-installed')
    .getByTestId(`customize-row-skill:custom:app:${name}`);
}

async function editInstalledSkill(window, name) {
  const menu = window
    .getByTestId('customize-section-installed')
    .getByTestId(`customize-row-menu-skill:custom:app:${name}`);
  await menu.click();
  await window
    .getByTestId(`customize-row-menu-skill:custom:app:${name}-edit`)
    .click();
}

function skillRow(dialog) {
  return dialog.getByRole('checkbox', {
    name: `Select ${SKILL_NAME}`,
  });
}

async function openSkillPicker(window) {
  await window.getByTestId('chat-input-plus-button').click();
  await window.getByTestId('chat-plugins-button').click();
  const dialog = window
    .locator('[role="dialog"]')
    .filter({ hasText: 'Plugins' });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder('Search by name…').fill(SKILL_NAME);
  await chooseSettingsOption(
    dialog.getByRole('combobox', { name: 'Kind filter' }),
    'skill',
  );
  await expect(skillRow(dialog)).toBeVisible();
  return dialog;
}

async function openSlashMenu(window) {
  const composer = window
    .getByTestId('panel-content-chat')
    .getByRole('textbox')
    .first();
  await expect(composer).toBeVisible();
  await composer.click();
  await expect(composer).toBeFocused();
  const menu = window.getByTestId('chat-input-plus-menu');
  // The rich editor and the Commands popover both restore focus
  // asynchronously. Re-enter the trigger if that hand-off consumes the first
  // update; this mirrors a user clearing and retyping `/` and keeps the test
  // focused on the newly-created skill's availability.
  await expect(async () => {
    await composer.fill('');
    await composer.fill('/');
    await expect(menu).toBeVisible({ timeout: 5_000 });
    await expect(menu).toHaveAttribute('data-menu-variant', 'commands');
  }).toPass({ timeout: 45_000 });
  return { composer, menu };
}

test('creating a custom skill exposes it in the list, chat picker, and slash menu', async ({}, testInfo) => {
  const { electronApp, userDataDir } = await launchCanopy({
    seedDemoWorkspaces: true,
    demoWorkspaceApps: ['ts-pnpm-vite'],
  });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();
    await app.openPluginsPage();
    await app.openPluginsTab('skills');
    await app.expectPluginsTab('skills');

    await window.screenshot({
      path: testInfo.outputPath('skills-tab.png'),
      fullPage: true,
    });

    await window.getByTestId('plugins-add-custom-menu').click();
    await window.getByTestId('plugins-add-custom-skill-custom').click();

    const modal = window.locator('#create-skill-modal-title');
    await expect(modal).toBeVisible();

    // Verify each form field rendered by the refactored SkillEditorBody
    await expect(window.getByPlaceholder('my-skill-name')).toBeVisible();
    await expect(
      window.getByPlaceholder(
        'One-line summary of when this skill should be used.',
      ),
    ).toBeVisible();
    await expect(
      window.getByRole('button', { name: /Advanced metadata/ }),
    ).toBeVisible();
    await expect(
      window.locator(
        'textarea[placeholder*="Describe how the skill should be used"]',
      ),
    ).toBeVisible();
    // Edit/Preview toggle pills
    await expect(
      window.getByRole('button', { name: 'Edit', exact: true }),
    ).toBeVisible();
    await expect(
      window.getByRole('button', { name: 'Preview', exact: true }),
    ).toBeVisible();
    // Footer
    await expect(window.getByRole('button', { name: 'Cancel' })).toBeVisible();
    await expect(window.getByTestId('skill-editor-save')).toBeVisible();

    await window.screenshot({
      path: testInfo.outputPath('skills-create-modal-empty.png'),
      fullPage: true,
    });

    const nameInput = window.getByPlaceholder('my-skill-name');

    // Invalid names remain visible so the user can correct the unsupported
    // characters instead of having their input silently rewritten. The
    // message shows once Save is pressed (docs/design/forms.md).
    await nameInput.fill('test_skill');
    await expect(nameInput).toHaveValue('test_skill');
    await window.getByTestId('skill-editor-save').click();
    await expect(
      window.getByText(
        'Skill name can only contain lowercase letters, numbers, and hyphens.',
      ),
    ).toBeVisible();

    // Type rather than paste: the old input sanitizer removed a trailing
    // hyphen before the next character arrived, producing "testskill".
    await nameInput.clear();
    await nameInput.pressSequentially(SKILL_NAME);
    await expect(nameInput).toHaveValue(SKILL_NAME);

    // Fill out the rest of the form and expand advanced metadata.
    await window
      .getByPlaceholder('One-line summary of when this skill should be used.')
      .fill('Smoke-test skill produced by the verification spec.');
    await window
      .locator('textarea[placeholder*="Describe how the skill should be used"]')
      .fill('# Hello\n\nThis is the body for the verification spec.');

    await window.getByRole('button', { name: /Advanced metadata/ }).click();
    await window.getByRole('button', { name: 'Add field' }).click();

    await window.screenshot({
      path: testInfo.outputPath('skills-create-modal-filled.png'),
      fullPage: true,
    });

    // Switch to Preview and verify content renders via MarkdownFrontmatterContent.
    await window.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(window.getByRole('heading', { name: 'Hello' })).toBeVisible();

    await window.screenshot({
      path: testInfo.outputPath('skills-create-modal-preview.png'),
      fullPage: true,
    });

    await window.getByTestId('skill-editor-save').click();
    await expect(modal).toBeHidden();
    // Saving opens the new skill's detail; its row is on the list behind it.
    await app.expectCreatedCustomizeDetail(skillTitle(SKILL_NAME));
    await app.closeMarketplaceEntryDetail();
    await expect(installedSkillRow(window, SKILL_NAME)).toContainText(
      skillTitle(SKILL_NAME),
    );

    // Reopening and saving the skill preserves the hyphenated directory and
    // frontmatter name on every platform supported by this Electron spec.
    // Editing opens the skill's edit page (CAN-3485), and saving lands on
    // the skill's details.
    const editorPage = window.getByTestId('skill-editor-page');
    await editInstalledSkill(window, SKILL_NAME);
    await expect(editorPage).toBeVisible();
    await expect(nameInput).toHaveValue(SKILL_NAME);
    await window
      .getByPlaceholder('One-line summary of when this skill should be used.')
      .fill('Updated smoke-test skill description.');
    await window.getByRole('button', { name: 'Save changes' }).click();
    await expect(editorPage).toBeHidden();
    await expect(window.locator('#skill-detail-modal-title')).toHaveText(
      skillTitle(SKILL_NAME),
    );

    await window.getByTestId('skill-read-detail-edit').click();
    await expect(editorPage).toBeVisible();
    await expect(nameInput).toHaveValue(SKILL_NAME);
    await window.getByRole('button', { name: 'Cancel' }).click();
    await expect(editorPage).toBeHidden();

    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);
    await expect(window.getByTestId('panel-content-chat')).toBeVisible();

    // Newly created skills are immediately available in the chat picker.
    let dialog = await openSkillPicker(window);
    await expect(skillRow(dialog)).not.toBeChecked();
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toHaveCount(0);

    // Before it is enabled for the chat, the slash menu offers the skill in
    // its Available-to-enable section.
    let slash = await openSlashMenu(window);
    await expect(
      slash.menu.getByRole('group', { name: 'Available to enable' }),
    ).toBeVisible();
    await expect(
      slash.menu.getByTestId(`chat-input-capability-${SKILL_NAME}`),
    ).toBeVisible({ timeout: 45_000 });
    await slash.composer.press('Escape');
    await expect(slash.menu).toHaveCount(0);
    await slash.composer.fill('');

    // Enabling the skill removes it from the Available-to-enable set and
    // persists the selection in Plugins. A fresh provider thread has no live
    // discovery result yet, so it does not advertise enabled skill rows in
    // the unified `/` menu until the provider reports them.
    dialog = await openSkillPicker(window);
    await skillRow(dialog).check();
    await expect(skillRow(dialog)).toBeChecked();
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toHaveCount(0);

    slash = await openSlashMenu(window);
    await expect(
      slash.menu
        .getByRole('group', { name: 'Available to enable' })
        .getByTestId(`chat-input-capability-${SKILL_NAME}`),
    ).toHaveCount(0);
    await slash.composer.press('Escape');
    await expect(slash.menu).toHaveCount(0);
    await slash.composer.fill('');

    dialog = await openSkillPicker(window);
    await expect(skillRow(dialog)).toBeChecked();
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('editing a custom skill preserves untouched YAML metadata types and user-invocable false', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-typed-skill-metadata-'),
  );
  seedTypedMetadataSkill(userDataDir);
  const { electronApp } = await launchCanopy({
    userDataDir,
    seedDemoWorkspaces: true,
    demoWorkspaceApps: ['ts-pnpm-vite'],
  });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();
    await app.openPluginsPage();
    await app.openPluginsTab('skills');
    await app.expectPluginsTab('skills');
    await expect(
      installedSkillRow(window, TYPED_METADATA_SKILL_NAME),
    ).toContainText(skillTitle(TYPED_METADATA_SKILL_NAME));

    await editInstalledSkill(window, TYPED_METADATA_SKILL_NAME);
    const saveButton = window.getByTestId('skill-editor-save');
    await expect(saveButton).toBeVisible();
    await window
      .getByTestId('skill-editor-description-input')
      .fill('Updated typed metadata description.');

    // The preview must render the typed values that will be saved: boolean
    // false renders as 'No', while a string-coerced 'false' would render
    // verbatim.
    await window.getByTestId('skill-editor-mode-preview').click();
    await expect(
      window.getByText('user-invocable', { exact: true }),
    ).toBeVisible();
    await expect(window.getByText('No', { exact: true })).toBeVisible();
    await expect(window.getByText('false', { exact: true })).toHaveCount(0);
    await window.getByTestId('skill-editor-mode-edit').click();

    await saveButton.click();
    await expect(saveButton).toBeHidden();

    expect(readTypedMetadataFrontmatter(userDataDir)).toEqual({
      name: TYPED_METADATA_SKILL_NAME,
      description: 'Updated typed metadata description.',
      'user-invocable': false,
      priority: 2,
      metadata: { internal: true },
      tags: ['review', 'safe'],
    });

    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);
    const { menu } = await openSlashMenu(window);
    await expect(
      menu.getByText(TYPED_METADATA_SKILL_NAME, { exact: true }),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
