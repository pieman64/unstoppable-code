import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  CHATS_SECTION_CODE_WORKSPACE_ID,
  CHATS_SECTION_DEFAULT_COWORK_ID,
  seedChatsSectionFixture,
} from './seeders/index.mjs';

/**
 * Appearance → Sidebar style → Compact simplifies sidebar rows (see
 * docs/sidebar-worktree-status.md):
 * worktree and chat rows carry one leading status dot (orange needs you, red
 * failed, loader running, blue unread, grey idle) and a right-aligned
 * last-activity age; project headers drop their counters, and list
 * disclosures read More / Less. Switching back to Advanced restores today's
 * rows exactly.
 */

const AGE_PATTERN = /^(now|\d+(m|h|d|w|mo|y))$/;

async function setCompactSidebar(window, enabled) {
  await window.evaluate(
    (value) =>
      window.api.experiments.setChoice({
        experimentId: 'sidebar',
        enabled: value,
      }),
    enabled,
  );
}

test('compact sidebar gives worktree rows one leading status dot', async () => {
  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    await expect(window.getByTestId('sidebar-more')).toBeVisible();
    await setCompactSidebar(window, true);

    await window.getByTestId('sidebar-more').click();
    await window.getByTestId('sidebar-more-item-dev-pages').click();
    await window.getByTestId('dev-pages-tab-worktree-states').click();
    const page = window.getByTestId('page-worktree-states');
    await expect(page).toHaveAttribute('data-status-model', 'focused');

    const status = (id) =>
      window
        .getByTestId(`gallery-worktree-row-${id}`)
        .getByTestId('worktree-row-status');
    await expect(status('idle')).toHaveAttribute('data-row-status', 'idle');
    await expect(status('question')).toHaveAttribute(
      'data-row-status',
      'needs-input',
    );
    await expect(status('plan-review')).toHaveAttribute(
      'data-row-status',
      'needs-input',
    );
    await expect(status('pipeline-running')).toHaveAttribute(
      'data-row-status',
      'working',
    );
    await expect(status('unread')).toHaveAttribute('data-row-status', 'unread');
    await expect(status('pipeline-failed')).toHaveAttribute(
      'data-row-status',
      'failed',
    );
    // Nothing on the right but the age and the hover actions.
    await expect(
      window
        .getByTestId('gallery-worktree-row-question')
        .getByTestId('worktree-row-question'),
    ).toHaveCount(0);
    await expect(
      window
        .getByTestId('gallery-worktree-row-terminal-running')
        .getByTestId('worktree-row-terminal-badge'),
    ).toHaveCount(0);

    // Off restores the classic row.
    await setCompactSidebar(window, false);
    await expect(page).toHaveAttribute('data-status-model', 'classic');
    await expect(window.getByTestId('worktree-row-status')).toHaveCount(0);
    await expect(
      window
        .getByTestId('gallery-worktree-row-question')
        .getByTestId('worktree-row-question'),
    ).toHaveCount(1);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('compact sidebar gives chat and worktree rows a leading dot and an age, and drops counters', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-compact-sidebar-rows-'),
  );
  seedChatsSectionFixture(userDataDir, { worktreeCount: 2 });
  const { electronApp } = await launchCanopy({
    userDataDir,
    viewportSize: { width: 900, height: 900 },
  });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await setCompactSidebar(window, true);

    const chats = window.getByTestId('sidebar-section-chats-content');
    const chatRow = chats.locator('[data-standalone-chat-id]').first();
    const chatId = await chatRow.getAttribute('data-standalone-chat-id');
    const chatBase = `sidebar-work-entry-${chatId}`;
    await expect(chatRow.getByTestId(`${chatBase}-status`)).toHaveAttribute(
      'data-row-status',
      'idle',
    );
    const chatAge = chatRow.getByTestId(`${chatBase}-age`);
    await expect(chatAge).toHaveText(AGE_PATTERN);

    const worktreeRow = window.getByTestId('worktree-row').first();
    await expect(worktreeRow.getByTestId('worktree-row-status')).toBeVisible();
    await expect(worktreeRow.getByTestId('worktree-row-age')).toHaveText(
      AGE_PATTERN,
    );

    // The age gives its place to the hover actions; the row keeps its height
    // and its title does not move.
    const restBox = await chatRow.boundingBox();
    const restTitle = await chatRow.locator('p').boundingBox();
    await chatRow.hover();
    await expect(chatAge).toBeHidden();
    const hoverBox = await chatRow.boundingBox();
    const hoverTitle = await chatRow.locator('p').boundingBox();
    expect(hoverBox?.height).toBe(restBox?.height);
    expect(hoverTitle?.y).toBe(restTitle?.y);
    expect(hoverTitle?.height).toBe(restTitle?.height);

    const showAll = window.getByTestId(
      `sidebar-cowork-project-${CHATS_SECTION_DEFAULT_COWORK_ID}-show-all`,
    );
    await expect(showAll).toContainText('More');
    await expect(
      window.getByTestId(
        `sidebar-cowork-project-${CHATS_SECTION_DEFAULT_COWORK_ID}-show-all-count`,
      ),
    ).toHaveCount(0);
    await expect(window.getByTestId('workspace-section-counter')).toHaveCount(
      0,
    );

    // Off restores today's rows.
    await setCompactSidebar(window, false);
    await expect(chatRow.getByTestId(`${chatBase}-status`)).toHaveCount(0);
    await expect(chatRow.getByTestId(`${chatBase}-age`)).toHaveCount(0);
    await expect(showAll).toContainText('Show all');
    await expect(
      window.getByTestId('workspace-section-counter').first(),
    ).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('compact sidebar shows line changes beside the worktree name', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-compact-row-diff-'),
  );
  seedChatsSectionFixture(userDataDir, { worktreeCount: 2 });
  // Uncommitted edit in one worktree: one line replaced, three appended.
  writeFileSync(
    path.join(
      userDataDir,
      'workspaces',
      CHATS_SECTION_CODE_WORKSPACE_ID,
      'worktrees',
      'feature-01',
      'README.md',
    ),
    'compact rows\nfirst\nsecond\nthird\n',
    'utf8',
  );
  const { electronApp } = await launchCanopy({
    userDataDir,
    viewportSize: { width: 900, height: 900 },
  });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await setCompactSidebar(window, true);

    const row = (id) =>
      window.locator(`[data-testid="worktree-row"][data-branch="${id}"]`);
    const subtitle = row('feature-01').getByTestId('worktree-row-subtitle');
    const diff = subtitle.getByTestId('worktree-row-subtitle-diff');
    await expect(diff).toContainText('+4', { timeout: 30_000 });
    await expect(diff).toContainText('-1');
    // The counts follow the worktree name on the same line.
    await expect(subtitle).toContainText(/feature-01\s*\+4\s*-1/);
    await expect(
      row('feature-02').getByTestId('worktree-row-subtitle-diff'),
    ).toHaveCount(0);

    // Advanced keeps the counts at the row's trailing edge instead.
    await setCompactSidebar(window, false);
    await expect(diff).toHaveCount(0);
    await expect(
      row('feature-01').getByTestId('worktree-row-trailing-diff'),
    ).toContainText('+4');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
