import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// The skill page heading is the skill's display title (CAN-4264).
function skillTitle(name) {
  return name
    .split(/[^A-Za-z0-9]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment[0].toUpperCase() + segment.slice(1))
    .join(' ');
}

const SKILL_NAME = 'multi-file-skill';
const FILE_PATH = 'references/api.md';
const FILE_CONTENT = '# API reference\n\nSupporting file body.';

test('multi-file custom skills: create with a supporting file, view with tree and file tabs', async ({}, testInfo) => {
  test.setTimeout(180_000);

  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();
    await app.openPluginsPage();
    await app.openPluginsTab('skills');
    await app.expectPluginsTab('skills');

    // -------------------------------------------------------------------
    // Create a custom skill with one supporting file.
    // -------------------------------------------------------------------
    await window.getByRole('button', { name: 'Create skill' }).click();
    const modal = window.locator('#create-skill-modal-title');
    await expect(modal).toBeVisible();

    await window
      .getByPlaceholder('my-skill-name')
      .pressSequentially(SKILL_NAME);
    await window
      .getByPlaceholder('One-line summary of when this skill should be used.')
      .fill('Multi-file skill produced by the verification spec.');
    // A long body makes the viewer content overflow the modal, which is the
    // case that previously flex-squashed the file tab strip to a sliver.
    const longBody = `# Main\n\nSee references/api.md.\n\n${'Filler paragraph for overflow testing.\n\n'.repeat(60)}`;
    await window
      .locator('textarea[placeholder*="Describe how the skill should be used"]')
      .fill(longBody);

    // The editor always shows the SKILL.md tab plus folder/add controls.
    await expect(window.getByTestId('skill-file-tab-main')).toBeVisible();

    // Add a supporting file; it opens in its own closable tab.
    await window.getByTestId('skill-editor-add-file').click();
    const pathInput = window.getByTestId('skill-file-path-input');
    await expect(pathInput).toBeVisible();
    await expect(pathInput).toHaveValue('new-file.md');
    await pathInput.fill(FILE_PATH);
    await window.getByTestId('skill-file-content-input').fill(FILE_CONTENT);

    // The file tree lists SKILL.md and the new file under its folder.
    await window.getByTestId('skill-file-tree-toggle').click();
    await expect(window.getByTestId('skill-file-tree')).toBeVisible();
    await expect(
      window.locator(
        '[data-testid="skill-file-tree-dir"][data-path="references"]',
      ),
    ).toBeVisible();
    await expect(
      window.locator(
        `[data-testid="skill-file-tree-file"][data-path="${FILE_PATH}"]`,
      ),
    ).toBeVisible();

    await window.screenshot({
      path: testInfo.outputPath('skills-multi-file-editor.png'),
      fullPage: true,
    });

    // Switching back to SKILL.md keeps the file tab open in the strip.
    await window.getByTestId('skill-file-tab-main').click();
    await expect(
      window.locator(
        `[data-testid="skill-file-tab"][data-path="${FILE_PATH}"]`,
      ),
    ).toBeVisible();

    await window
      .getByRole('button', { name: 'Create skill', exact: true })
      .click();
    await expect(modal).toBeHidden();
    await expect(window.getByText(SKILL_NAME, { exact: true })).toBeVisible();

    // -------------------------------------------------------------------
    // View the skill: folder icon + file tabs appear for multi-file skills.
    // -------------------------------------------------------------------
    await window.getByRole('button', { name: SKILL_NAME }).click();
    const detailTitle = window.locator('#skill-detail-modal-title');
    await expect(detailTitle).toHaveText(skillTitle(SKILL_NAME));
    await expect(window.getByTestId('plugins-entry-detail-page')).toBeVisible();

    // SKILL.md renders first and is the leading tab.
    await expect(
      window.getByRole('heading', { name: 'Main', exact: true }),
    ).toBeVisible();
    await expect(window.getByTestId('skill-file-tab-main')).toBeVisible();

    // The tab strip must keep its full height even when the SKILL.md body
    // overflows the modal (regression: flex squashed it to a sliver).
    const tabBarBox = await window
      .getByTestId('skill-file-tab-bar')
      .boundingBox();
    expect(tabBarBox?.height ?? 0).toBeGreaterThan(20);

    // The folder icon opens the file tree; selecting a file opens a tab.
    await window.getByTestId('skill-file-tree-toggle').click();
    await expect(window.getByTestId('skill-file-tree')).toBeVisible();
    await window
      .locator(`[data-testid="skill-file-tree-file"][data-path="${FILE_PATH}"]`)
      .click();

    const fileTab = window.locator(
      `[data-testid="skill-file-tab"][data-path="${FILE_PATH}"]`,
    );
    await expect(fileTab).toBeVisible();

    // Supporting-file tabs live inside the wheel-scrollable strip while the
    // folder toggle and SKILL.md tab stay pinned outside it.
    const scrollStrip = window.getByTestId('skill-file-tab-scroll');
    await expect(
      scrollStrip.locator('[data-testid="skill-file-tab"]'),
    ).toHaveCount(1);
    await expect(
      scrollStrip.locator('[data-testid="skill-file-tab-main"]'),
    ).toHaveCount(0);
    await expect(window.getByTestId('skill-file-preview')).toBeVisible();
    await expect(
      window.getByRole('heading', { name: 'API reference' }),
    ).toBeVisible();

    await window.screenshot({
      path: testInfo.outputPath('skills-multi-file-viewer.png'),
      fullPage: true,
    });

    // Closing the file tab returns to SKILL.md.
    await fileTab.getByRole('button', { name: 'Close api.md' }).click();
    await expect(fileTab).toBeHidden();
    await expect(
      window.getByRole('heading', { name: 'Main', exact: true }),
    ).toBeVisible();
    // CAN-3483: the viewer is a Marketplace page. CAN-4261: it has no Back;
    // the Skills crumb returns to the installed Skills list.
    await window.getByTestId('plugins-entry-detail-breadcrumb-type').click();
    await expect(detailTitle).toHaveCount(0);

    // -------------------------------------------------------------------
    // Re-editing loads the supporting file back into the editor, which opens
    // as the skill's edit page (CAN-3485); Cancel lands on its details.
    // -------------------------------------------------------------------
    await window.getByRole('button', { name: 'Edit skill' }).click();
    const editorPage = window.getByTestId('skill-editor-page');
    await expect(editorPage).toBeVisible();
    await window.getByTestId('skill-file-tree-toggle').click();
    await window
      .locator(`[data-testid="skill-file-tree-file"][data-path="${FILE_PATH}"]`)
      .click();
    await expect(window.getByTestId('skill-file-content-input')).toHaveValue(
      FILE_CONTENT,
    );
    await window.getByTestId('skill-editor-cancel').click();
    await expect(editorPage).toBeHidden();
    await expect(detailTitle).toHaveText(skillTitle(SKILL_NAME));
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
