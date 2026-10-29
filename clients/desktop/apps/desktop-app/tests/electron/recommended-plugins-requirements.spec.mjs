// CAN-3310: first durable UI coverage for canopy.json environment requirements.
// A source-controlled MCP dependency opens the existing recommendation dialog
// after worktree creation, reports non-blocking setup, and exposes Set up.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { writeJson } from './seeders/fsHelpers.mjs';

function git(cwd, args) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function seedRequirementsWorkspace(userDataDir) {
  const fixtureDir = mkdtempSync(
    path.join(os.tmpdir(), 'can3310-requirements-'),
  );
  const repoPath = path.join(fixtureDir, 'repo');
  const workspaceId = 'can3310-requirements';
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ['init']);
  git(repoPath, ['config', 'user.email', 'test@example.com']);
  git(repoPath, ['config', 'user.name', 'Canopy Test']);
  writeJson(path.join(repoPath, 'canopy.json'), {
    version: 1,
    dependencies: [
      {
        id: 'linear',
        kind: 'mcp',
        server: { catalog_id: 'linear' },
        required: true,
        fallback: 'block',
      },
    ],
  });
  git(repoPath, ['add', 'canopy.json']);
  git(repoPath, ['commit', '-m', 'add environment requirement']);

  const workspaceDir = path.join(userDataDir, 'workspaces', workspaceId);
  writeJson(path.join(userDataDir, 'workspaces', 'index.json'), {
    version: 1,
    workspaces: [
      {
        id: workspaceId,
        name: 'Requirements Project',
        type: 'single-repo',
        color: '#38bdf8',
        collapsed: false,
        order: 0,
      },
    ],
  });
  writeJson(path.join(workspaceDir, 'workspace.json'), {
    version: 1,
    type: 'single-repo',
    repoPath,
    repos: [],
    alwaysShow: true,
  });
  writeJson(path.join(workspaceDir, 'worktrees.json'), {
    version: 1,
    worktrees: [],
  });
  writeJson(path.join(userDataDir, 'mcp-servers', 'curated-catalog.json'), {
    version: 1,
    fetchedAt: new Date().toISOString(),
    servers: [
      {
        key: 'linear',
        name: 'Linear',
        shortDescription: 'Track issues and projects in Linear.',
        longDescription: 'Connect to Linear through its hosted MCP server.',
        url: 'https://linear.example.test/mcp',
        transport: 'http',
        categories: ['productivity'],
        popular: true,
        sortOrder: 0,
        updatedAt: '2026-09-23T00:00:00.000Z',
      },
    ],
  });
  return fixtureDir;
}

test('shows canopy.json requirements in the recommendation dialog', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'can3310-requirements-data-'),
  );
  const fixtureDir = seedRequirementsWorkspace(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openChatPage();
    await app.workspaceHeaderLabel('Requirements Project').hover();
    await window
      .getByRole('button', {
        name: 'Create worktree for Requirements Project',
      })
      .click();

    const dialog = window
      .getByRole('dialog')
      .filter({ hasText: 'Recommended plugins' });
    await expect(dialog).toBeVisible({ timeout: 60_000 });
    const requirements = dialog.getByTestId('recommended-plugin-requirements');
    await expect(requirements).toContainText('linear');
    await expect(requirements).toContainText('Needs setup');
    await expect(requirements).toContainText(
      'Missing setup does not block applying recommendations.',
    );
    const setup = requirements.getByTestId(
      'recommended-plugin-requirement-setup-linear',
    );
    await expect(setup).toHaveText('Set up');
    await setup.click();
    await expect(dialog).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(window.getByTestId('plugins-entry-detail-page')).toBeVisible();
    await expect(
      window.getByTestId('plugins-entry-detail-breadcrumb-current'),
    ).toContainText(/linear/i);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
