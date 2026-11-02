import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/seedWorktreeChat.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const TAB_ID = 'save-dirty-tab';
const FILE_NAME = 'SAVE_DIRTY.txt';
const INITIAL_CONTENT = 'first line\nsecond line\n';

// Platform Cmd/Ctrl+S — the single window-level save owner (CAN-1426).
const SAVE_MODIFIER = process.platform === 'darwin' ? 'Meta' : 'Control';
const PALETTE_MODIFIER = process.platform === 'darwin' ? 'Meta' : 'Control';

/**
 * Close a file panel tab via its hover-revealed close control. The reopened
 * tab carries a generated panel id, so this targets the resolved tab locator
 * (unlike the shared id-based `closePanelTab`) while applying the same
 * hover-retry: a single hover can be dropped by a tab re-render before the
 * click's hit-test runs, leaving the leading icon intercepting the click
 * (CAN-2436, verify run 32464410606).
 */
async function closeFileTab(filePanelTab) {
  await expect(async () => {
    await filePanelTab.hover({ timeout: 2_000 });
    await filePanelTab
      .getByRole('button', { name: /^Close / })
      .click({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

/**
 * End-to-end coverage for the single-owner file-save flow: every dirty marker
 * (shared FileViewer header, chat tab, panel tab, Save/Discard) rides one
 * shared session, one Cmd/Ctrl+S issues exactly one write, the close guard
 * discards through the shared session (a reopen reads disk), Auto Save persists
 * after the debounce, and an external mtime drift stays fail-closed.
 */
test('file viewer: shortcut save, close-guard discard/reopen, autosave, and external conflict', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-file-viewer-save-dirty-'),
  );
  const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = seed.workspaces[0]?.worktreePath;
  expect(worktreePath, 'seeded worktree path').toBeTruthy();

  const filePath = path.join(worktreePath, FILE_NAME);
  writeFileSync(filePath, INITIAL_CONTENT, 'utf8');

  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: TAB_ID,
    tabs: [
      {
        id: TAB_ID,
        title: FILE_NAME,
        kind: 'file',
        filePath,
        fileViewMode: 'raw',
        description: filePath,
        messages: [],
      },
    ],
  });

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    let editor = window.getByTestId('monaco-file-editor');
    await expect(editor).toBeVisible({ timeout: 20_000 });

    const dirtyMarker = window.getByTestId('file-viewer-dirty');
    const panelDirtyMarker = window.getByTestId(`panel-tab-dirty-${TAB_ID}`);
    let filePanelTab = window.getByTestId(`panel-tab-panel-file-${TAB_ID}`);
    const saveButton = window.getByTestId('file-save');
    const discardButton = window.getByTestId('file-discard');

    // --- Shortcut save -----------------------------------------------------
    await editor.click();
    await window.keyboard.type(' SHORTCUT_EDIT');

    // Every authoritative dirty projection agrees, from one shared edit.
    await expect(dirtyMarker).toBeVisible();
    await expect(panelDirtyMarker).toBeVisible();
    await expect(saveButton).toBeVisible();
    await expect(discardButton).toBeVisible();

    await editor.click();
    await window.keyboard.press(`${SAVE_MODIFIER}+s`);

    // One write reaches disk; poll because the IPC round-trip is async.
    await expect
      .poll(() => readFileSync(filePath, 'utf8'), { timeout: 10_000 })
      .toContain('SHORTCUT_EDIT');

    // All dirty markers clear and no error is shown.
    await expect(dirtyMarker).toHaveCount(0);
    await expect(panelDirtyMarker).toHaveCount(0);
    await expect(saveButton).toHaveCount(0);
    await expect(window.getByTestId('file-error')).toHaveCount(0);

    let savedContent = readFileSync(filePath, 'utf8');

    // --- FileViewer Save button: save then close without a stale prompt ----
    await editor.click();
    await window.keyboard.type(' BUTTON_SAVE_EDIT');
    await expect(saveButton).toBeVisible();
    await saveButton.click();
    await expect
      .poll(() => readFileSync(filePath, 'utf8'), { timeout: 10_000 })
      .toContain('BUTTON_SAVE_EDIT');
    await expect(dirtyMarker).toHaveCount(0);
    savedContent = readFileSync(filePath, 'utf8');

    await closeFileTab(filePanelTab);
    await expect(window.getByTestId('file-tab-close-guard')).toHaveCount(0);
    await expect(filePanelTab).toHaveCount(0);

    // Reopen for the close-guard scenarios. The new tab has a generated id.
    await window.keyboard.press(`${PALETTE_MODIFIER}+p`);
    await window.getByTestId('file-search-palette-input').fill(FILE_NAME);
    await window
      .getByTestId('file-search-palette-result')
      .filter({ hasText: FILE_NAME })
      .first()
      .click();
    editor = window.getByTestId('monaco-file-editor');
    await expect(editor).toBeVisible({ timeout: 20_000 });
    filePanelTab = window
      .locator('[data-testid^="panel-tab-panel-file-"][data-active="true"]')
      .first();

    // --- Close guard: Cancel keeps the draft, Don't Save discards ----------
    await editor.click();
    await window.keyboard.type(' DRAFT_EDIT');
    await expect(dirtyMarker).toBeVisible();

    await closeFileTab(filePanelTab);

    const modal = window.getByTestId('file-tab-close-guard');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText(`Save changes to “${FILE_NAME}”?`);
    await expect(modal).toContainText(
      'Discarding loses the edits you haven’t saved.',
    );
    await expect(
      window.getByTestId('file-tab-close-guard-cancel'),
    ).toBeVisible();
    await expect(
      window.getByTestId('file-tab-close-guard-discard'),
    ).toBeVisible();
    await expect(window.getByTestId('file-tab-close-guard-save')).toBeVisible();

    // Cancel: the tab and the draft survive.
    await window.getByTestId('file-tab-close-guard-cancel').click();
    await expect(modal).toHaveCount(0);
    await expect(dirtyMarker).toBeVisible();

    // Close again, then Don't Save: the draft is discarded and the tab closes.
    await closeFileTab(filePanelTab);
    await expect(modal).toBeVisible();
    await window.getByTestId('file-tab-close-guard-discard').click();
    await expect(modal).toHaveCount(0);
    await expect(filePanelTab).toHaveCount(0);

    // The discarded draft never touched disk.
    expect(readFileSync(filePath, 'utf8')).toBe(savedContent);

    // --- Reopen: a fresh read shows disk, not the discarded draft ----------
    await window.keyboard.press(`${PALETTE_MODIFIER}+p`);
    const palette = window.getByTestId('file-search-palette');
    await expect(palette).toBeVisible();
    await window.getByTestId('file-search-palette-input').fill(FILE_NAME);
    await window
      .getByTestId('file-search-palette-result')
      .filter({ hasText: FILE_NAME })
      .first()
      .click();

    const reopenedEditor = window.getByTestId('monaco-file-editor');
    await expect(reopenedEditor).toBeVisible({ timeout: 20_000 });
    // Clean on reopen — the discarded draft did not resurrect.
    await expect(window.getByTestId('file-viewer-dirty')).toHaveCount(0);
    await expect(reopenedEditor).not.toContainText('DRAFT_EDIT');
    await expect(reopenedEditor).toContainText('SHORTCUT_EDIT');

    // --- Header Discard asks first, then restores saved content (CAN-5365) --
    await reopenedEditor.click();
    await window.keyboard.type(' HEADER_DRAFT');
    await expect(discardButton).toHaveText('Discard');
    const discardConfirm = window.getByTestId('file-discard-confirm');
    await discardButton.click();
    await expect(discardConfirm).toContainText(
      `Discard your edits to “${FILE_NAME}”?`,
    );
    await expect(discardConfirm).toContainText(
      'Discarding loses the edits you haven’t saved.',
    );
    await expect(discardConfirm).not.toContainText('latest version');
    await expect(
      window.getByTestId('file-discard-confirm-cancel'),
    ).toBeFocused();
    await window.getByTestId('file-discard-confirm-cancel').click();
    await expect(discardConfirm).toHaveCount(0);
    await expect(discardButton).toBeFocused();
    await expect(reopenedEditor).toContainText('HEADER_DRAFT');
    await expect(window.getByTestId('file-viewer-dirty')).toBeVisible();

    await discardButton.click();
    await window.getByTestId('file-discard-confirm-accept').click();
    await expect(discardConfirm).toHaveCount(0);
    await expect(reopenedEditor).not.toContainText('HEADER_DRAFT');
    await expect(window.getByTestId('file-viewer-dirty')).toHaveCount(0);
    await expect(
      window.locator('[data-testid="file-viewer-header"]:visible'),
    ).toBeFocused();
    expect(readFileSync(filePath, 'utf8')).toBe(savedContent);

    // The reopened tab id is generated; resolve it from the active file panel.
    const reopenedTabId = await window.evaluate(() => {
      const active = document.querySelector(
        '[data-testid^="panel-tab-panel-file-"][data-active="true"]',
      );
      return (
        active
          ?.getAttribute('data-testid')
          ?.replace('panel-tab-panel-file-', '') ?? null
      );
    });

    // --- Auto Save: enable, edit, and confirm the debounce persists --------
    await app.openSettings();
    await app.openSettingsSection('files');
    const autoSaveToggle = window.getByTestId('settings-files-auto-save');
    await expect(autoSaveToggle).toBeVisible();
    if ((await autoSaveToggle.getAttribute('aria-checked')) !== 'true') {
      await autoSaveToggle.click();
    }
    await expect(autoSaveToggle).toHaveAttribute('aria-checked', 'true');
    await app.closeSettings();

    const autosaveEditor = window.getByTestId('monaco-file-editor');
    await expect(autosaveEditor).toBeVisible();
    await autosaveEditor.click();
    await window.keyboard.type(' AUTOSAVE_EDIT');
    await expect(window.getByTestId('file-viewer-dirty')).toBeVisible();

    // Poll disk until the 1200ms debounce persists the edit.
    await expect
      .poll(() => readFileSync(filePath, 'utf8'), { timeout: 10_000 })
      .toContain('AUTOSAVE_EDIT');
    await expect(window.getByTestId('file-viewer-dirty')).toHaveCount(0);
    if (reopenedTabId) {
      await expect(
        window.getByTestId(`panel-tab-dirty-${reopenedTabId}`),
      ).toHaveCount(0);
    }

    // --- External conflict: fail-closed, no overwrite ----------------------
    // Turn Auto Save back off so the local edit does not race the conflict.
    await app.openSettings();
    await app.openSettingsSection('files');
    if ((await autoSaveToggle.getAttribute('aria-checked')) === 'true') {
      await autoSaveToggle.click();
    }
    await expect(autoSaveToggle).toHaveAttribute('aria-checked', 'false');
    await app.closeSettings();

    const conflictEditor = window.getByTestId('monaco-file-editor');
    await conflictEditor.click();
    await window.keyboard.type(' LOCAL_ONLY');
    await expect(window.getByTestId('file-viewer-dirty')).toBeVisible();

    // Modify the file from the test process and force an mtime drift > 1 ms.
    const externalContent = 'EXTERNAL WRITE FROM DISK\n';
    writeFileSync(filePath, externalContent, 'utf8');
    const future = Date.now() / 1000 + 60;
    utimesSync(filePath, future, future);

    await conflictEditor.click();
    await window.keyboard.press(`${SAVE_MODIFIER}+s`);

    // The desktop file service refuses the stale write. The overlapping
    // changes cannot be combined, so the shared session offers recovery,
    // keeps the local buffer, and never overwrites disk on its own.
    const conflictNotice = window.getByTestId('file-overlap-notice');
    await expect(conflictNotice).toBeVisible({ timeout: 10_000 });
    await expect(conflictNotice.getByRole('alert')).toBeVisible();
    await expect(window.getByTestId('file-overlap-choose-ours')).toBeFocused();
    await expect(
      window.getByText('File changed on disk since it was loaded.'),
    ).toHaveCount(0);
    await expect(window.getByTestId('file-viewer-dirty')).toBeVisible();
    await expect(conflictEditor).toContainText('LOCAL_ONLY');
    expect(readFileSync(filePath, 'utf8')).toBe(externalContent);

    // Close-save must expose the shared recovery choices and keep the tab.
    await closeFileTab(filePanelTab);
    await expect(window.getByTestId('file-tab-close-guard')).toBeVisible();
    await window.getByTestId('file-tab-close-guard-save').click();
    await expect(window.getByTestId('file-tab-close-guard')).toHaveCount(0);
    await expect(filePanelTab).toBeVisible();
    await expect(conflictNotice).toBeVisible();
    await expect(window.getByTestId('file-overlap-choose-ours')).toBeFocused();
    expect(readFileSync(filePath, 'utf8')).toBe(externalContent);

    // Save my version replaces exactly the version the notice represents.
    await window.getByTestId('file-overlap-choose-ours').click();
    // The choice updates only the buffer; Save persists conditionally.
    expect(readFileSync(filePath, 'utf8')).toBe(externalContent);
    await window.getByTestId('file-save').click();
    await expect(conflictNotice).toHaveCount(0);
    await expect(window.getByTestId('file-viewer-dirty')).toHaveCount(0);
    await expect
      .poll(() => readFileSync(filePath, 'utf8'), { timeout: 10_000 })
      .toContain('LOCAL_ONLY');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
