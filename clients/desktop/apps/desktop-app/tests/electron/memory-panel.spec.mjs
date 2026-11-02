import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { memoryRowSelector } from './memoryRows.mjs';

// The Memory side panel lists memories saved for every project and for this
// project as rows (title, one line, where it applies), opens one into a
// detail view with its source, scope, kind, time and usage, and edits or
// deletes it from the detail view or the row's "…" menu. Deletion waits for
// Undo before the file goes.
//
// Determinism: memory files and usage.json are seeded on disk before launch;
// no agents, network or consolidation run.

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_BRANCH = 'demo-main';

function seedMemory(userDataDir) {
  const user = path.join(userDataDir, 'memory');
  const project = path.join(userDataDir, 'workspaces', WORKSPACE_ID, 'memory');
  for (const dir of [user, project]) {
    mkdirSync(path.join(dir, 'topics'), { recursive: true });
    mkdirSync(path.join(dir, 'inbox'), { recursive: true });
  }
  writeFileSync(
    path.join(user, 'topics', 'em-dashes.md'),
    '# No em dashes\n\nNever use em dashes in copy, comments or prose.\n',
  );
  writeFileSync(
    path.join(project, 'topics', 'ports.md'),
    '# Dev server ports\n\nClient and backend ports move as a pair.\n',
  );
  writeFileSync(
    path.join(project, 'inbox', '2026-10-22T09-00-00-000Z-preflight.md'),
    '---\nsource:\n  provider: "claude"\n  chatId: "chat-not-in-this-app"\ncreated: "2026-10-22T09:00:00.000Z"\nmodified: "2026-10-22T09:00:00.000Z"\ntype: inbox\n---\n\nRun the queue preflight first\nUpdate the branch when it reports an overlap.\n',
  );
  const now = new Date().toISOString();
  writeFileSync(
    path.join(project, 'usage.json'),
    `${JSON.stringify({
      version: 1,
      trackingSince: '2026-10-01T00:00:00.000Z',
      entries: {
        'topics/ports.md': { usageCount: 6, lastUsedAt: now, createdAt: now },
      },
    })}\n`,
  );
  return { user, project };
}

test('the Memory panel lists, opens, edits and deletes memories with Undo', async () => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'memory-panel-e2e-'));
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });
  const { project } = seedMemory(userDataDir);
  const { electronApp } = await launchCanopy({
    userDataDir,
    viewportSize: { width: 1400, height: 900 },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);
    // Open Memory from the side rail's add menu (or a new tab's picker).
    await expect(
      window.getByTestId('panel-content-activity-section'),
    ).toBeVisible();
    await window
      .getByTestId('panel-add-tab-group-extras')
      .or(window.getByTestId('panel-add-tab-group-activity'))
      .first()
      .click();
    await window
      .getByTestId('side-panel-empty-item-memory')
      .or(window.getByTestId('panel-add-menu-item-activity-card-memory'))
      .first()
      .click();
    const panel = window
      .getByTestId('activity-card-section-memory')
      .getByTestId('memory-explorer-workspace');
    const row = (fileKey) => panel.locator(memoryRowSelector(fileKey));

    // Rows from both scopes, with where each applies.
    await expect(panel.getByTestId('memory-row')).toHaveCount(3);
    await expect(
      row('topics/em-dashes.md').getByTestId('memory-row-meta'),
    ).toHaveText('Everywhere');
    await expect(
      row('topics/ports.md').getByTestId('memory-row-excerpt'),
    ).toHaveText('Client and backend ports move as a pair.');
    const note = row('inbox/2026-10-22T09-00-00-000Z-preflight.md');
    await expect(note.getByTestId('memory-row-title')).toHaveText(
      'Run the queue preflight first',
    );
    await expect(note.getByTestId('memory-row-meta')).toContainText(
      'Recent note',
    );

    // Filter to this project's memories.
    await panel.getByTestId('memory-filter-trigger').click();
    await window.getByTestId('memory-filter-scope-0').click();
    await window.keyboard.press('Escape');
    await expect(panel.getByTestId('memory-filter-count')).toHaveText(
      '1 filter',
    );
    await expect(panel.getByTestId('memory-row')).toHaveCount(2);
    await panel.getByTestId('memory-filter-trigger').click();
    await window.getByTestId('memory-filter-scope-0').click();
    await window.keyboard.press('Escape');
    await expect(panel.getByTestId('memory-row')).toHaveCount(3);

    // The detail view says where a memory came from and how often it's used.
    await row('topics/ports.md').getByTestId('memory-row-open').click();
    const facts = panel.getByTestId('memory-detail-facts');
    await expect(facts).toContainText('Saved for');
    await expect(facts).toContainText('Topic');
    await expect(facts).toContainText(
      /Saved(Today|Yesterday|[A-Z][a-z]{2} \d)/,
    );
    await expect(panel.getByTestId('memory-detail-usage')).toHaveText(
      '6 times',
    );
    await panel.getByTestId('memory-detail-edit').click();
    await panel.getByTestId('memory-item-title').fill('Dev server port pairs');
    await panel.getByTestId('memory-item-save').click();
    await expect(panel.getByTestId('memory-detail-title')).toHaveText(
      'Dev server port pairs',
    );
    await expect(
      window.getByTestId('toast-stack-host').getByText('Memory saved'),
    ).toBeVisible();
    await panel.getByTestId('memory-detail-back').click();

    await note.getByTestId('memory-row-open').click();
    await expect(panel.getByTestId('memory-detail-source')).toHaveText('Chat');
    await expect(panel.getByTestId('memory-detail-facts')).toContainText(
      'Recent note',
    );
    await window.keyboard.press('Escape');
    await expect(panel.getByTestId('memory-detail')).toHaveCount(0);

    // Delete from the row menu; Undo brings it back, then it really goes.
    const notePath = path.join(
      project,
      'inbox',
      '2026-10-22T09-00-00-000Z-preflight.md',
    );
    await note.getByTestId('memory-row-menu').click();
    await window.getByRole('menuitem', { name: 'Delete' }).click();
    await expect(note).toHaveCount(0);
    await window
      .getByTestId('toast-action')
      .filter({ hasText: 'Undo' })
      .click();
    await expect(note).toBeVisible();
    await note.getByTestId('memory-row-menu').click();
    await window.getByRole('menuitem', { name: 'Delete' }).click();
    await expect(note).toHaveCount(0);
    expect(existsSync(notePath)).toBe(true);
    await expect
      .poll(() => existsSync(notePath), { timeout: 30_000 })
      .toBe(false);

    // The panel menu reaches Memory settings.
    await panel.getByTestId('memory-panel-menu').click();
    await window.getByRole('menuitem', { name: 'Memory settings' }).click();
    await app.expectSettingsSection('memory');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
