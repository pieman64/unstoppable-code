// The real settings editor reaches api.chatProject.loadClaudeMd and
// api.chatProject.saveClaudeMd over chat-project:load-claude-md and
// chat-project:save-claude-md; assertions below observe the files they persist.
// CAN-5585: saving Cowork project instructions must never replace a user's
// own AGENTS.md. The editor loads the file the folder actually uses, saves
// edits back to it, and leaves a separate CLAUDE.md untouched. Attachment
// itself has its own coverage; these fixtures seed an attached folder.
import { expect, test } from '@playwright/test';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedCoworkWorkspace } from './seeders/index.mjs';

const WORKSPACE_ID = 'cowork-instructions-layout';

/**
 * Seeds a Cowork project attached to a disposable folder holding `files`,
 * launches the app, and hands the open Instructions tab to `body`.
 */
async function withInstructionsTab(files, body, { managed = false } = {}) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-cowork-instructions-'),
  );
  const folder = managed
    ? path.join(userDataDir, 'workspaces', WORKSPACE_ID, 'home')
    : mkdtempSync(path.join(os.tmpdir(), 'canopy-cowork-instructions-folder-'));
  let electronApp;
  try {
    seedCoworkWorkspace({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      name: 'Instructions Layout',
      collapsed: false,
      ...(managed ? {} : { externalPath: folder }),
    });
    mkdirSync(folder, { recursive: true });
    for (const [name, text] of Object.entries(files)) {
      writeFileSync(path.join(folder, name), text);
    }
    ({ electronApp } = await launchCanopy({ userDataDir }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openChatPage();

    const openInstructions = async () => {
      const rowTestId = `sidebar-cowork-project-${WORKSPACE_ID}`;
      await window.getByTestId(`${rowTestId}-header`).hover();
      await window.getByTestId(`${rowTestId}-settings`).click();
      const dialog = window
        .locator('[role="dialog"]')
        .filter({ has: window.locator('#chat-project-settings-title') });
      await expect(dialog).toBeVisible();
      await dialog
        .getByRole('tab', { name: 'Instructions', exact: true })
        .click();
      const editor = dialog.getByTestId('chat-project-instructions-editor');
      await expect(editor).toBeEnabled();
      return { dialog, editor };
    };

    await body({ window, folder, openInstructions });
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
      else rmSync(userDataDir, { recursive: true, force: true });
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }
}

async function appendAndSave(dialog, editor, addition) {
  const current = await editor.inputValue();
  await editor.fill(`${current}${addition}`);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();
}

function read(folder, name) {
  return readFileSync(path.join(folder, name), 'utf8');
}

test('edits a standalone AGENTS.md in place and pairs a missing CLAUDE.md', async () => {
  const original = '# Team rules\n- Original rule\n';
  await withInstructionsTab(
    { 'AGENTS.md': original },
    async ({ folder, openInstructions }) => {
      const { dialog, editor } = await openInstructions();
      await expect(
        dialog.getByRole('heading', { name: 'AGENTS.md', exact: true }),
      ).toBeVisible();
      await expect(editor).toHaveValue(original);
      await expect(
        dialog.getByTestId('chat-project-instructions-notice'),
      ).toContainText('creates CLAUDE.md only if');

      const agentsInode = lstatSync(path.join(folder, 'AGENTS.md')).ino;
      await appendAndSave(dialog, editor, '- Added rule\n');

      const agents = lstatSync(path.join(folder, 'AGENTS.md'));
      expect(agents.isFile()).toBe(true);
      expect(agents.isSymbolicLink()).toBe(false);
      expect(agents.ino).toBe(agentsInode);
      expect(read(folder, 'AGENTS.md')).toBe(`${original}- Added rule\n`);
      const claude = lstatSync(path.join(folder, 'CLAUDE.md'));
      if (process.platform === 'win32') {
        expect(read(folder, 'CLAUDE.md')).toBe(`${original}- Added rule\n`);
      } else {
        expect(claude.isSymbolicLink()).toBe(true);
        expect(readlinkSync(path.join(folder, 'CLAUDE.md'))).toBe('AGENTS.md');
      }

      const reopened = await openInstructions();
      await expect(reopened.editor).toHaveValue(`${original}- Added rule\n`);
    },
  );
});

test('leaves a separate CLAUDE.md byte-identical', async () => {
  const claudeText = '# Claude-only rules\n';
  await withInstructionsTab(
    { 'AGENTS.md': '# Shared rules\n', 'CLAUDE.md': claudeText },
    async ({ folder, openInstructions }) => {
      const { dialog, editor } = await openInstructions();
      await expect(
        dialog.getByTestId('chat-project-instructions-notice'),
      ).toContainText('CLAUDE.md stays unchanged');

      await appendAndSave(dialog, editor, '- New shared rule\n');

      expect(read(folder, 'AGENTS.md')).toBe(
        '# Shared rules\n- New shared rule\n',
      );
      expect(lstatSync(path.join(folder, 'CLAUDE.md')).isFile()).toBe(true);
      expect(read(folder, 'CLAUDE.md')).toBe(claudeText);
    },
  );
});

test('keeps the CLAUDE.md convention and pairs a missing AGENTS.md', async () => {
  await withInstructionsTab(
    { 'CLAUDE.md': '# Project rules\n' },
    async ({ folder, openInstructions }) => {
      const { dialog, editor } = await openInstructions();
      await expect(
        dialog.getByRole('heading', { name: 'CLAUDE.md', exact: true }),
      ).toBeVisible();
      await expect(
        dialog.getByTestId('chat-project-instructions-notice'),
      ).toHaveCount(0);

      await appendAndSave(dialog, editor, '- Keep it short\n');

      expect(read(folder, 'CLAUDE.md')).toBe(
        '# Project rules\n- Keep it short\n',
      );
      if (process.platform !== 'win32') {
        expect(lstatSync(path.join(folder, 'AGENTS.md')).isSymbolicLink()).toBe(
          true,
        );
      }
      expect(read(folder, 'AGENTS.md')).toBe(
        '# Project rules\n- Keep it short\n',
      );
    },
  );
});

test('saves and reopens managed-home instructions with the CLAUDE.md convention', async () => {
  await withInstructionsTab(
    { 'CLAUDE.md': '# Managed rules\n' },
    async ({ folder, openInstructions }) => {
      const { dialog, editor } = await openInstructions();
      await expect(
        dialog.getByRole('heading', { name: 'CLAUDE.md', exact: true }),
      ).toBeVisible();
      const before = lstatSync(path.join(folder, 'CLAUDE.md'));
      await appendAndSave(dialog, editor, '- Managed addition\n');
      expect(lstatSync(path.join(folder, 'CLAUDE.md')).ino).toBe(before.ino);
      expect(read(folder, 'CLAUDE.md')).toBe(
        '# Managed rules\n- Managed addition\n',
      );
      expect(read(folder, 'AGENTS.md')).toBe(
        '# Managed rules\n- Managed addition\n',
      );
      if (process.platform !== 'win32') {
        expect(readlinkSync(path.join(folder, 'AGENTS.md'))).toBe('CLAUDE.md');
      }
      const reopened = await openInstructions();
      await expect(reopened.editor).toHaveValue(
        '# Managed rules\n- Managed addition\n',
      );
    },
    { managed: true },
  );
});

test('retains edits on a real revision conflict and reloads only on request', async () => {
  await withInstructionsTab(
    { 'AGENTS.md': '# Original rules\n' },
    async ({ folder, openInstructions }) => {
      const { dialog, editor } = await openInstructions();
      const edit = '# Original rules\n- My edit\n';
      await editor.fill(edit);
      writeFileSync(path.join(folder, 'AGENTS.md'), '# External edit\n');
      await dialog.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(
        dialog.getByTestId('chat-project-instructions-save-issue'),
      ).toContainText('Your edits have not been saved');
      await expect(editor).toHaveValue(edit);
      expect(read(folder, 'AGENTS.md')).toBe('# External edit\n');
      await expect(
        dialog.getByRole('button', { name: 'Save', exact: true }),
      ).toHaveCount(0);

      // A reload can itself fail. Saving another setting must still retain
      // the user's instruction draft until a later explicit reload succeeds.
      rmSync(path.join(folder, 'AGENTS.md'));
      mkdirSync(path.join(folder, 'AGENTS.md'));
      await dialog.getByRole('button', { name: 'Reload', exact: true }).click();
      await expect(dialog).toContainText(
        "Couldn't load this project's instructions",
      );
      await dialog.getByRole('tab', { name: 'General', exact: true }).click();
      await dialog.locator('#chat-project-name').fill('Renamed instructions');
      await dialog.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(
        dialog.getByTestId('chat-project-instructions-save-issue'),
      ).toBeVisible();
      await expect(editor).toHaveValue(edit);

      rmSync(path.join(folder, 'AGENTS.md'), { recursive: true });
      writeFileSync(path.join(folder, 'AGENTS.md'), '# External edit\n');
      await dialog.getByRole('button', { name: 'Reload', exact: true }).click();
      await expect(editor).toHaveValue('# External edit\n');
      await expect(
        dialog.getByTestId('chat-project-instructions-save-issue'),
      ).toHaveCount(0);
    },
  );
});
