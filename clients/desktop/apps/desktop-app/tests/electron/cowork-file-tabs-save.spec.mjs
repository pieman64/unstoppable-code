import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { writeJson } from './seeders/fsHelpers.mjs';

// PR #2319: Cowork file-tab save regression coverage.
//
// A Cowork workspace file could be opened and edited in the shared Monaco
// file tab, but Save failed with "Standalone chat files cannot be edited".
// This spec exercises the real flow (select work entry -> Cmd/Ctrl+P -> open
// file -> edit -> Save -> verify disk). The workspace, Work Entry, chat, and
// file are seeded on disk; no live agent or network is involved.

const WORKSPACE_ID = 'cowork-default';
const ENTRY_ID = 'entry-file-save';
const FILE_NAME = 'known-issues.md';
const INITIAL_CONTENT =
  '# Known issues\n\n- Cowork file tabs must save edits.\n';
const EDIT_MARKER = ' SAVED_FROM_COWORK';
const PALETTE_MODIFIER = process.platform === 'darwin' ? 'Meta' : 'Control';

function seedCoworkFileFixture(userDataDir) {
  const workspaceDir = path.join(userDataDir, 'workspaces', WORKSPACE_ID);
  const homeDir = path.join(workspaceDir, 'home');
  const filePath = path.join(homeDir, FILE_NAME);

  writeJson(path.join(userDataDir, 'workspaces', 'index.json'), {
    version: 1,
    workspaces: [
      {
        id: WORKSPACE_ID,
        name: 'File Save Project',
        type: 'cowork',
        color: '#7C9B6D',
        collapsed: false,
        order: 0,
        cowork: {
          createdAt: '2026-08-11T12:00:00.000Z',
          archiveRetentionDays: null,
        },
      },
    ],
  });
  writeJson(path.join(workspaceDir, 'workspace.json'), {
    version: 1,
    type: 'cowork',
    repos: [],
    cowork: {
      createdAt: '2026-08-11T12:00:00.000Z',
      archiveRetentionDays: null,
    },
  });
  writeJson(path.join(workspaceDir, 'work-entries.json'), {
    version: 1,
    entries: [{ id: ENTRY_ID, createdAt: '2026-08-11T12:00:00.000Z' }],
  });
  writeJson(path.join(workspaceDir, 'chats', `${ENTRY_ID}.json`), {
    version: 1,
    activeTabId: 'chat-file-save',
    tabs: [
      {
        id: 'chat-file-save',
        title: 'Review known issues',
        description: 'Review known issues',
        createdAt: '2026-08-11T12:00:00.000Z',
        kind: 'chat',
        messages: [
          {
            id: 'message-file-save',
            role: 'user',
            blocks: [{ type: 'text', text: 'Update the known issues file.' }],
            timestamp: Date.parse('2026-08-11T12:00:00.000Z'),
          },
        ],
      },
    ],
  });
  mkdirSync(homeDir, { recursive: true });
  writeFileSync(filePath, INITIAL_CONTENT, 'utf8');
  return filePath;
}

test('Cowork file tabs save edits to the scoped project file', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-cowork-file-save-'),
  );
  const filePath = seedCoworkFileFixture(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();

    // CAN-2672: a sole Cowork workspace has no toggle and is force-expanded.
    const workEntry = window.getByTestId(`sidebar-work-entry-${ENTRY_ID}`);
    await expect(workEntry).toBeVisible({ timeout: 15_000 });
    await workEntry.click();
    await expect(window.getByTestId('cowork-top-bar')).toBeVisible({
      timeout: 15_000,
    });
    await window.keyboard.press(`${PALETTE_MODIFIER}+p`);
    const palette = window.getByTestId('file-search-palette');
    await expect(palette).toBeVisible();
    await window.getByTestId('file-search-palette-input').fill(FILE_NAME);
    await window
      .getByTestId('file-search-palette-result')
      .filter({ hasText: FILE_NAME })
      .first()
      .click();

    const editor = window.getByTestId('monaco-file-editor');
    await expect(editor).toBeVisible({ timeout: 20_000 });
    await editor.click();
    await window.keyboard.type(EDIT_MARKER);
    await expect(window.getByTestId('file-viewer-dirty')).toBeVisible();
    await window.getByTestId('file-save').click();
    await expect
      .poll(() => readFileSync(filePath, 'utf8'), { timeout: 10_000 })
      .toContain(EDIT_MARKER);
    await expect(window.getByTestId('file-error')).toHaveCount(0);
    await expect(window.getByTestId('file-viewer-dirty')).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
