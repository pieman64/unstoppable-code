import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// File Labels — Files-settings "Labels" section plus label filtering in the
// Changed Files card and the file panel's changed-file (diff) tree.
//
// State is seeded on disk (demo workspace + scripted git changes), with no
// live agents or network.

const WORKTREE_BRANCH = 'demo-main';

test('Files settings: collapsible sections and the Labels editor', async () => {
  let { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();
    await app.openSettings();
    await app.openSettingsSection('files');
    await app.expectSettingsSection('files');

    // Both configs sit behind collapsed disclosure sections.
    const doNotIndexToggle = window.getByTestId(
      'settings-files-do-not-index-toggle',
    );
    await expect(doNotIndexToggle).toBeVisible();
    await expect(window.getByTestId('settings-files-custom-input')).toHaveCount(
      0,
    );
    await doNotIndexToggle.click();
    await expect(
      window.getByTestId('settings-files-custom-input'),
    ).toBeVisible();
    await doNotIndexToggle.click();

    const labelsToggle = window.getByTestId(
      'settings-files-labels-section-toggle',
    );
    await expect(labelsToggle).toHaveText(/10\/10 labels enabled/);
    // The label rows open inside the Labels row's group.
    await expect(window.getByTestId('file-label-bucket-tests')).toHaveCount(0);
    await labelsToggle.click();
    await expect(window.getByTestId('file-label-bucket-tests')).toBeVisible();

    // Seeded buckets render in priority order; seeded rows have no delete.
    const testsBucket = window.getByTestId('file-label-bucket-tests');
    await expect(testsBucket).toBeVisible();
    await expect(
      window.getByTestId('file-label-bucket-documentation'),
    ).toBeVisible();
    await expect(window.getByTestId('file-label-delete-tests')).toHaveCount(0);

    // Seeded buckets can be toggled off; the summary count follows.
    const testsToggle = window.getByTestId('file-label-toggle-tests');
    await expect(testsToggle).toHaveAttribute('aria-checked', 'true');
    await testsToggle.click();
    await expect(testsToggle).toHaveAttribute('aria-checked', 'false');
    await expect(labelsToggle).toHaveText(/Hide labels/);

    // "Stop further labels" is configurable on seeded buckets.
    const docsStop = window.getByTestId('file-label-stop-documentation');
    await expect(docsStop).not.toBeChecked();
    await docsStop.check();
    await expect(docsStop).toBeChecked();
    await docsStop.uncheck();

    // Expanding a bucket reveals its matchers with per-matcher controls.
    await window.getByTestId('file-label-expand-tests').click();
    const seededMatcher = window.getByTestId('file-label-matcher-tests-dirs');
    await expect(seededMatcher).toBeVisible();
    await expect(
      window.getByTestId('file-label-matcher-delete-tests-dirs'),
    ).toHaveCount(0);
    const matcherToggle = window.getByTestId(
      'file-label-matcher-toggle-tests-dirs',
    );
    await matcherToggle.click();
    await expect(matcherToggle).toHaveAttribute('aria-checked', 'false');
    await matcherToggle.click();
    const matcherStop = window.getByTestId(
      'file-label-matcher-stop-tests-dirs',
    );
    await matcherStop.check();
    await expect(matcherStop).toBeChecked();
    await matcherStop.uncheck();

    // Custom matchers can be added to seeded buckets (with validation:
    // submitting an empty pattern via Enter surfaces the inline error).
    const addMatcherInput = window.getByTestId(
      'file-label-add-matcher-input-tests',
    );
    await addMatcherInput.press('Enter');
    await expect(
      window.getByTestId('file-label-add-matcher-error-tests'),
    ).toHaveText('Enter a valid glob pattern.');
    await addMatcherInput.fill('**/*.integration.ts');
    await window.getByTestId('file-label-add-matcher-tests').click();
    const customMatcher = window
      .locator('[data-testid^="file-label-matcher-matcher-"]')
      .first();
    await expect(customMatcher).toBeVisible();

    // Custom labels can be added, renamed, and deleted.
    await window.getByTestId('file-labels-add-label').click();
    const nameInput = window.locator('[data-testid^="file-label-name-label-"]');
    await expect(nameInput).toBeVisible();
    await nameInput.fill('Infra');
    await nameInput.press('Tab');
    const persistedCustomLabelName = () => {
      const stored = JSON.parse(
        readFileSync(path.join(userDataDir, 'preferences.json'), 'utf8'),
      );
      return stored.preferences.fileLabels.find((bucket) =>
        bucket.id.startsWith('label-'),
      )?.name;
    };
    const persistedDocumentationStop = () => {
      const stored = JSON.parse(
        readFileSync(path.join(userDataDir, 'preferences.json'), 'utf8'),
      );
      return stored.preferences.fileLabels.find(
        (bucket) => bucket.id === 'documentation',
      )?.stopFurtherLabels;
    };
    await expect.poll(persistedCustomLabelName).toBe('Infra');

    // Empty text remains a visible local draft and must not erase the last
    // valid persisted value. A later valid blur commits the replacement.
    await nameInput.fill('');
    await expect.poll(persistedCustomLabelName).toBe('Infra');

    // An invalid text draft must not block unrelated valid changes from
    // persisting. The draft stays visible while the Documentation option is
    // saved independently, then can still be repaired normally.
    await docsStop.check();
    await expect.poll(persistedDocumentationStop).toBe(true);
    await expect(nameInput).toHaveValue('');
    await expect.poll(persistedCustomLabelName).toBe('Infra');
    await docsStop.uncheck();
    await expect.poll(persistedDocumentationStop).toBe(false);

    await nameInput.fill('Platform');
    await nameInput.press('Tab');
    await expect.poll(persistedCustomLabelName).toBe('Platform');
    const customBucket = window
      .locator('[data-testid^="file-label-bucket-label-"]')
      .first();
    await expect(customBucket).toBeVisible();

    await window
      .locator('[data-testid^="file-label-delete-label-"]')
      .first()
      .click();
    await expect(
      window.locator('[data-testid^="file-label-bucket-label-"]'),
    ).toHaveCount(0);

    await app.closeSettings();
  } finally {
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
  }

  // The Tests toggle-off persisted across relaunch.
  ({ electronApp } = await launchCanopy({ userDataDir }));
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openSettings();
    await app.openSettingsSection('files');
    await app.expectSettingsSection('files');
    await expect(
      window.getByTestId('settings-files-labels-section-toggle'),
    ).toHaveText(/9\/10 labels enabled/);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Changed Files card and file-panel diff tree filter by label', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-electron-file-labels-'),
  );
  let launched;
  try {
    const seed = seedDemoWorkspaces({
      userDataDir,
      apps: ['ts-pnpm-vite'],
      checkRuntimes: false,
    });
    const worktreePath = seed.workspaces[0]?.worktreePath;
    if (!worktreePath) throw new Error('Missing seeded worktree');

    // Four uncommitted changes across three labels:
    //   README.md            → Documentation (modified)
    //   docs/canfl-guide.md  → Documentation (untracked)
    //   src/canfl.test.ts    → Tests (untracked)
    //   CANFL_PLAIN.txt      → Other (untracked)
    appendFileSync(
      path.join(worktreePath, 'README.md'),
      '\nfile-labels tracked change\n',
      'utf8',
    );
    mkdirSync(path.join(worktreePath, 'docs'), { recursive: true });
    writeFileSync(
      path.join(worktreePath, 'docs', 'canfl-guide.md'),
      '# guide\n',
      'utf8',
    );
    writeFileSync(
      path.join(worktreePath, 'src', 'canfl.test.ts'),
      'export {};\n',
      'utf8',
    );
    writeFileSync(
      path.join(worktreePath, 'CANFL_PLAIN.txt'),
      'unlabeled\n',
      'utf8',
    );

    launched = await launchCanopy({ userDataDir });
  } catch (error) {
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
    throw error;
  }

  const { electronApp } = launched;
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);

    const section = window.getByTestId('changed-files-section');
    await expect(section).toBeVisible();
    await expect(
      section.getByTestId('activity-changed-file').first(),
    ).toBeVisible({ timeout: 20_000 });
    await expect(section.getByText('4 files', { exact: true })).toBeVisible();

    // Filter trigger sits to the left of the View diagram button.
    const trigger = section.getByTestId('changed-files-label-filter-trigger');
    await expect(trigger).toBeVisible();
    const diagramButton = section.getByTestId('view-change-diagram-button');
    await expect(diagramButton).toBeVisible();
    await expect(diagramButton).toHaveText('');
    await expect(diagramButton).toHaveAttribute('aria-label', 'View diagram');

    // Hide Tests → one row filtered out everywhere.
    await trigger.click();
    const dropdown = window.getByTestId('changed-files-label-filter-dropdown');
    await expect(dropdown).toBeVisible();
    // Only labels matching a current row are offered (Tests, Documentation,
    // Other here); empty labels like Assets are omitted. The Settings entry
    // is always last.
    await expect(
      window.getByTestId('changed-files-label-filter-option-other'),
    ).toBeVisible();
    await expect(
      window.getByTestId('changed-files-label-filter-option-tests'),
    ).toBeVisible();
    await expect(
      window.getByTestId('changed-files-label-filter-option-documentation'),
    ).toBeVisible();
    await expect(
      window.getByTestId('changed-files-label-filter-option-assets'),
    ).toHaveCount(0);
    await expect(
      window.getByTestId('changed-files-label-filter-settings'),
    ).toBeVisible();
    await window.getByTestId('changed-files-label-filter-option-tests').click();
    await window.keyboard.press('Escape');
    await expect(dropdown).toHaveCount(0);

    // "X files (Y)": X is the unfiltered total, Y the count still shown.
    await expect(section.getByText('4 files (3)')).toBeVisible();
    await expect(section.getByTestId('activity-changed-file')).toHaveCount(3);
    await expect(
      window.getByTestId('changed-files-label-filter-active-dot'),
    ).toBeVisible();

    // The muted "1 more file…" entry reopens the filter menu.
    const moreFiles = section.getByTestId('changed-files-more-files');
    await expect(moreFiles).toHaveText('1 more file…');
    await moreFiles.click();
    await expect(dropdown).toBeVisible();
    await window.keyboard.press('Escape');

    // The second filter host is the file panel's changed-file tree. A
    // changed-file click now routes to an ordinary file panel in diff mode
    // (the Code Review takeover is gone), and that panel owns the tree.
    await section
      .getByTestId('activity-changed-file')
      .filter({ hasText: 'README.md' })
      .first()
      .click();
    const diffPanel = window.locator(
      '[data-testid="panel-content-file-diff"]:visible',
    );
    await expect(diffPanel.getByTestId('file-panel-diff')).toBeVisible({
      timeout: 20_000,
    });
    // Populated file panels start with their tree collapsed.
    await diffPanel
      .locator('[data-testid="file-tab-tree-toggle"]:visible')
      .click();
    const tree = diffPanel.getByTestId('file-tab-diff-tree');
    await expect(tree).toBeVisible();
    const treeRows = tree.locator('[data-testid^="diff-file-tree-row-"]');

    // Tests is still hidden from the card above: the filter is one shared
    // store, so the tree opens already filtered.
    const testsRow = tree.getByTestId('diff-file-tree-row-:src/canfl.test.ts');
    await expect(testsRow).toHaveCount(0);
    await expect(treeRows).toHaveCount(3);

    // The tree hosts the same menu; re-showing Tests restores the row here and
    // the plain count on the card.
    const treeFilter = tree.getByTestId('changed-files-label-filter-trigger');
    await treeFilter.click();
    await window.getByTestId('changed-files-label-filter-option-tests').click();
    await window.keyboard.press('Escape');
    await expect(testsRow).toBeVisible();
    await expect(treeRows).toHaveCount(4);
    await expect(section.getByText('4 files', { exact: true })).toBeVisible();

    // The file this panel already shows is the selected row.
    const readmeRow = tree.getByTestId('diff-file-tree-row-:README.md');
    await expect(readmeRow).toHaveAttribute('data-selected', 'true');

    // Hiding the selected row's label removes the row. The panel keeps the
    // open file: a file panel is an ordinary tab, not a selection the tree
    // owns, so a hidden label must not blank the diff.
    await treeFilter.click();
    await window
      .getByTestId('changed-files-label-filter-option-documentation')
      .click();
    await window.keyboard.press('Escape');
    await expect(readmeRow).toHaveCount(0);
    await expect(treeRows).toHaveCount(2);
    await expect(diffPanel.getByTestId('file-panel-diff')).toBeVisible();

    // Hiding every represented label empties the tree and says so, without
    // disturbing the open diff.
    await treeFilter.click();
    await window.getByTestId('changed-files-label-filter-option-tests').click();
    await window.getByTestId('changed-files-label-filter-option-other').click();
    await window.keyboard.press('Escape');
    await expect(treeRows).toHaveCount(0);
    await expect(tree.getByText('No matching changed files.')).toBeVisible();
    await expect(diffPanel.getByTestId('file-panel-diff')).toBeVisible();

    // Restore the filters so the remaining menu navigation coverage can use
    // the full file list.
    await treeFilter.click();
    await window
      .getByTestId('changed-files-label-filter-option-documentation')
      .click();
    await window.getByTestId('changed-files-label-filter-option-tests').click();
    await window.getByTestId('changed-files-label-filter-option-other').click();
    await window.keyboard.press('Escape');
    await expect(treeRows).toHaveCount(4);

    // The tree menu's Settings entry opens the Files settings page with the
    // Labels section already expanded.
    await treeFilter.click();
    await window.getByTestId('changed-files-label-filter-settings').click();
    await expect(window.getByTestId('settings-tab-files')).toBeVisible();
    await expect(window.getByTestId('file-label-bucket-tests')).toBeVisible();
    await expect(
      window.getByTestId('settings-files-labels-section-toggle'),
    ).toHaveText(/Hide labels/);
    // The Do-not-index section stays collapsed.
    await expect(window.getByTestId('settings-files-custom-input')).toHaveCount(
      0,
    );
    await app.closeSettings();

    // A tree row for a file this panel does not show opens as a sibling file
    // tab, the same funnel the normal embedded file tree uses.
    await expect(
      window.locator('[data-testid^="panel-tab-panel-file-"]'),
    ).toHaveCount(1);
    await testsRow.click();
    await expect(
      window.locator('[data-testid^="panel-tab-panel-file-"]'),
    ).toHaveCount(2);
    await expect(
      window.locator('[data-testid="file-panel-diff"]:visible'),
    ).toContainText('export {}');

    // Same entry from the card's menu.
    await section.getByTestId('changed-files-label-filter-trigger').click();
    await window.getByTestId('changed-files-label-filter-settings').click();
    await expect(window.getByTestId('file-label-bucket-tests')).toBeVisible();
    await app.closeSettings();

    // The expansion request is one-shot. Opening Files settings normally
    // afterward must return the Labels section to its collapsed default.
    await app.openSettings();
    await app.openSettingsSection('files');
    await expect(
      window.getByTestId('settings-files-labels-section-toggle'),
    ).toHaveText(/10\/10 labels enabled/);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
