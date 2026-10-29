import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedCoworkWorkspace } from './seeders/seedCoworkWorkspace.mjs';

const WORKTREE_ID = 'demo-main';
const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const COWORK_WORKSPACE_ID = 'memory-cowork';
const COWORK_ENTRY_ID = 'memory-cowork-entry';

function claudeProjectSlug(repoPath) {
  return path.resolve(repoPath).replace(/[^A-Za-z0-9-]/g, '-');
}

function seedLocalMemoryFixture() {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'memory-import-e2e-'));
  const seed = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
  });
  const workspace = seed.workspaces.find(
    (candidate) => candidate.id === WORKSPACE_ID,
  );
  if (!workspace?.repoPath) {
    throw new Error('Expected the seeded project repository path');
  }
  writeLocalMemoryPreference(userDataDir);

  const sourceDir = path.join(
    userDataDir,
    'provider-state',
    'claude',
    'projects',
    claudeProjectSlug(workspace.repoPath),
    'memory',
  );
  mkdirSync(sourceDir, { recursive: true });

  return {
    scopeDir: path.join(userDataDir, 'workspaces', WORKSPACE_ID, 'memory'),
    sourcePath: path.join(sourceDir, 'MEMORY.md'),
    userDataDir,
  };
}

function writeLocalMemoryPreference(userDataDir) {
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    JSON.stringify(
      { version: 1, preferences: { localMemoryEnabled: true } },
      null,
      2,
    ),
    'utf8',
  );
}

/**
 * A cowork workspace attached to a plain folder the user previously worked in
 * with Claude Code: the folder's memory lives under the isolated
 * `CLAUDE_CONFIG_DIR` keyed by the folder path, exactly as `~/.claude` keys a
 * repository, and has no `type: user` frontmatter so it routes to the
 * workspace scope.
 */
function seedCoworkMemoryFixture() {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'memory-import-cowork-e2e-'),
  );
  const folder = mkdtempSync(
    path.join(os.tmpdir(), 'memory-import-cowork-folder-'),
  );
  seedCoworkWorkspace({
    userDataDir,
    workspaceId: COWORK_WORKSPACE_ID,
    name: 'Memory cowork',
    collapsed: false,
    chatId: COWORK_ENTRY_ID,
    chatTitle: 'Memory cowork entry',
    externalPath: folder,
  });
  writeLocalMemoryPreference(userDataDir);
  const sourceDir = path.join(
    userDataDir,
    'provider-state',
    'claude',
    'projects',
    claudeProjectSlug(folder),
    'memory',
  );
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(
    path.join(sourceDir, 'MEMORY.md'),
    'Cowork folder fixture: the newsletter ships on Thursdays.\n',
    'utf8',
  );
  return {
    folder,
    scopeDir: path.join(
      userDataDir,
      'workspaces',
      COWORK_WORKSPACE_ID,
      'memory',
    ),
    userScopeDir: path.join(userDataDir, 'memory'),
    userDataDir,
  };
}

function stagedFiles(scopeDir) {
  const importedDir = path.join(scopeDir, 'imported');
  return existsSync(importedDir) ? readdirSync(importedDir).sort() : [];
}

test('local memory settings has no manual import control or completion notification', async () => {
  const fixture = seedLocalMemoryFixture();
  const { electronApp } = await launchCanopy({
    userDataDir: fixture.userDataDir,
  });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    writeFileSync(
      fixture.sourcePath,
      'CAN-2751 durable fixture: deploy on port 4788.\n',
      'utf8',
    );
    await window.evaluate(
      async ({ workspaceId, worktreeId }) => {
        await window.api.getWorkspaceReadiness({ workspaceId, worktreeId });
      },
      { workspaceId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
    );
    await expect.poll(() => stagedFiles(fixture.scopeDir).length).toBe(1);

    await app.openSettings();
    await app.openSettingsSection('memory');

    await expect(window.getByTestId('local-memory-import-claude')).toHaveCount(
      0,
    );
    await expect(
      window
        .getByTestId('toast-card')
        .filter({ hasText: 'Agent memory import' }),
    ).toHaveCount(0);
    await expect(
      window.getByText('Agent memory import', { exact: false }),
    ).toHaveCount(0);
    await expect(window.getByTestId('local-memory-open-folder')).toBeVisible();
  } finally {
    await closeCanopy(electronApp, fixture.userDataDir);
  }
});

test('activating a cowork workspace imports the Claude memory of its attached folder', async () => {
  const fixture = seedCoworkMemoryFixture();
  const { electronApp } = await launchCanopy({
    userDataDir: fixture.userDataDir,
  });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    // Open the workspace the way a user does: expand its sidebar row (a sole
    // cowork workspace is force-expanded and has no toggle) and pick an entry.
    const toggle = window.getByTestId(
      `sidebar-cowork-project-${COWORK_WORKSPACE_ID}-toggle`,
    );
    const entryRow = window.getByTestId(
      `sidebar-work-entry-${COWORK_ENTRY_ID}`,
    );
    await expect(toggle.or(entryRow).first()).toBeVisible({ timeout: 30_000 });
    if (
      (await toggle.count()) > 0 &&
      (await toggle.getAttribute('aria-expanded')) !== 'true'
    ) {
      await toggle.click();
    }
    await entryRow.click();
    await expect(window.getByTestId('panel-content-chat')).toBeVisible({
      timeout: 30_000,
    });

    // The folder's memory lands in this workspace's scope, not the user's.
    await expect
      .poll(() => stagedFiles(fixture.scopeDir).length, { timeout: 30_000 })
      .toBe(1);
    expect(stagedFiles(fixture.userScopeDir)).toEqual([]);
  } finally {
    await closeCanopy(electronApp, fixture.userDataDir);
    rmSync(fixture.folder, { recursive: true, force: true });
  }
});
