import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  seedChatsSectionFixture,
  seedWorktreeChat,
  injectChatEvent,
  injectGithubPrStatus,
  buildPrStatusEvent,
  buildPrStatusData,
} from './seeders/index.mjs';

/**
 * Early access: a short hover on a sidebar worktree row opens a preview card
 * beside it with the full title, project, branch, and worktree id. The card
 * stays up while the pointer rests on the row's Pin and Archive, whose own
 * tooltips show beside it, and turning early access off removes it.
 */

import { seedInteractiveQuestion } from './seeders/seedInteractiveQuestion.mjs';

const SHARED_SIDEBAR_STORAGE_KEY = 'canopy.desktop.sharedSidebar';

async function setEarlyAccess(window, enabled) {
  await window.evaluate(
    (value) =>
      window.api.experiments.setChoice({
        experimentId: 'early-access',
        enabled: value,
      }),
    enabled,
  );
}

test('early access opens a preview card on worktree row hover', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-worktree-row-preview-'),
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
    await setEarlyAccess(window, true);

    const row = window.getByTestId('worktree-row').first();
    const branch = await row.getAttribute('data-branch');
    const preview = window.getByTestId('worktree-row-preview');

    await row.hover();
    await expect(preview).toBeVisible();
    await expect(
      preview.getByTestId('worktree-row-preview-project'),
    ).toBeVisible();
    if (branch) {
      await expect(
        preview.getByTestId('worktree-row-preview-branch'),
      ).toContainText(branch);
    }
    await expect(preview).toHaveCSS('width', '280px');
    // The card sits beside the row, not over it.
    const rowBox = await row.boundingBox();
    const previewBox = await preview.boundingBox();
    expect(previewBox?.x).toBeGreaterThanOrEqual(
      (rowBox?.x ?? 0) + (rowBox?.width ?? 0),
    );

    // The card shows the row's text, so the row has no OS tooltips.
    await expect(row.locator('[title]')).toHaveCount(0);

    // Resting on the row's Pin keeps the card up beside Pin's own tooltip.
    const pin = row.getByRole('button', { name: /^(Pin|Unpin)$/ });
    await pin.hover();
    await expect(
      window.getByRole('tooltip').filter({ hasText: /^(Pin|Unpin)$/ }),
    ).toBeVisible();
    await window.waitForTimeout(800);
    await expect(preview).toBeVisible();

    // Dragging across the card's text selects it: the row neither starts
    // dragging nor opens.
    const branchLine = preview
      .getByTestId('worktree-row-preview-branch')
      .getByText(branch ?? 'feature-01');
    const lineBox = await branchLine.boundingBox();
    expect(lineBox).not.toBeNull();
    await expect(window.getByTestId('worktree-top-bar')).toHaveCount(0);
    await window.mouse.move(lineBox.x + 2, lineBox.y + lineBox.height / 2);
    await window.mouse.down();
    await window.mouse.move(
      lineBox.x + lineBox.width - 2,
      lineBox.y + lineBox.height / 2,
      { steps: 8 },
    );
    expect(
      await row.evaluate((element) => {
        const sortable = element.closest('[aria-roledescription="sortable"]');
        return sortable instanceof HTMLElement ? sortable.style.transform : '';
      }),
    ).toBe('');
    await window.mouse.up();
    expect(
      (await window.evaluate(() => window.getSelection()?.toString() ?? ''))
        .length,
    ).toBeGreaterThan(0);
    await expect(preview).toBeVisible();
    await window.waitForTimeout(300);
    await expect(window.getByTestId('worktree-top-bar')).toHaveCount(0);

    // Leaving the row closes it.
    await window.mouse.move(1, 1);
    await expect(preview).toHaveCount(0);

    // Right-clicking the row (its menu) keeps the card away.
    await row.hover();
    await expect(preview).toBeVisible();
    await row.click({ button: 'right' });
    await expect(preview).toHaveCount(0);
    await window.keyboard.press('Escape');
    await window.mouse.move(1, 1);

    // Off removes the card.
    await setEarlyAccess(window, false);
    await row.hover();
    await window.waitForTimeout(800);
    await expect(preview).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test("selecting the card's text in the shared rail never drags or opens the row", async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-worktree-row-preview-shared-'),
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
    await window.evaluate((key) => {
      window.localStorage.setItem(key, '1');
    }, SHARED_SIDEBAR_STORAGE_KEY);
    await window.reload();
    await app.waitForShell({ timeout: 30_000 });
    await setEarlyAccess(window, true);

    const row = window.getByTestId('worktree-row').first();
    const branch = await row.getAttribute('data-branch');
    const preview = window.getByTestId('worktree-row-preview');
    await row.hover();
    await expect(preview).toBeVisible();
    await expect(window.getByTestId('worktree-top-bar')).toHaveCount(0);

    // Drag across the branch name (its text, not its icon), well past the
    // drag's 8px threshold.
    const line = await preview
      .getByTestId('worktree-row-preview-branch')
      .getByText(branch ?? 'feature-01')
      .boundingBox();
    expect(line).not.toBeNull();
    await window.mouse.move(line.x + 2, line.y + line.height / 2);
    await window.mouse.down();
    await window.mouse.move(line.x + line.width - 2, line.y + line.height / 2, {
      steps: 10,
    });
    // A dragged row is marked while the drag runs.
    expect(
      await window.evaluate(
        () => document.querySelectorAll('[data-dragging]').length,
      ),
    ).toBe(0);
    await window.mouse.up();

    expect(
      (await window.evaluate(() => window.getSelection()?.toString() ?? ''))
        .length,
    ).toBeGreaterThan(0);
    await window.waitForTimeout(300);
    await expect(window.getByTestId('worktree-top-bar')).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('preview shows merged PR details without labeling chat activity background agents', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-worktree-indicators-'),
  );
  seedChatsSectionFixture(userDataDir, { worktreeCount: 2, chatEntryCount: 0 });
  const projectId = 'chats-section-code';
  const worktreeId = 'feature-01';
  const chatId = 'preview-agent';
  seedWorktreeChat({
    userDataDir,
    workspaceId: projectId,
    worktreeId,
    tabs: [{ id: chatId, title: 'Background work' }],
    activeTabId: chatId,
  });
  const { electronApp } = await launchCanopy({
    userDataDir,
    viewportSize: { width: 1000, height: 900 },
  });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    await setEarlyAccess(window, true);
    const row = window.locator(`[data-worktree-id="${worktreeId}"]`).first();
    await row.click();
    await expect(
      window.getByTestId('panel-content-chat').first(),
    ).toBeVisible();
    await injectChatEvent(electronApp, {
      projectId,
      worktreeId,
      chatId,
      data: {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Working' }] },
      },
    });
    // Leave the running chat, then inspect it from another worktree.
    await window.locator('[data-worktree-id="feature-02"]').first().click();
    await row.hover();
    const preview = window.getByTestId('worktree-row-preview');
    await expect(preview).toBeVisible();
    await expect(preview).not.toContainText(/Agents running|Unread updates/);
    await expect(preview).toHaveCSS('width', '280px');
    await injectGithubPrStatus(
      electronApp,
      buildPrStatusEvent({
        projectId,
        worktreeId,
        repos: [
          {
            repoId: projectId,
            repoName: 'Preview project',
            status: buildPrStatusData({
              prNumber: 823,
              state: 'merged',
              title: 'Merged preview change',
            }),
          },
        ],
      }),
    );
    await expect(
      preview.getByTestId('worktree-row-preview-pr').locator('.text-2xs'),
    ).toHaveText('Merged');
    // The merged event marks the worktree Done. Reopening the PR must
    // restore its actual open state, even while the worktree remains Done.
    for (const reviewStatus of ['none', 'changes_requested']) {
      await injectGithubPrStatus(
        electronApp,
        buildPrStatusEvent({
          projectId,
          worktreeId: worktreeId,
          repos: [
            {
              repoId: projectId,
              repoName: 'Preview project',
              status: {
                ...buildPrStatusData({
                  prNumber: 823,
                  state: 'open',
                  title: 'Reopened preview change',
                  checkStatus: 'passing',
                }),
                reviewStatus,
              },
            },
          ],
        }),
      );
      await expect(row.getByTestId('worktree-row-merged')).toHaveCount(0);
      if (reviewStatus === 'changes_requested') {
        await expect(
          row.getByTestId('worktree-row-checks-passing'),
        ).toHaveCount(0);
        await expect(row.getByTestId('worktree-row-open-pr')).toHaveClass(
          /fg-destructive/,
        );
        await expect(
          preview.getByTestId('worktree-row-preview-pr'),
        ).toContainText('Changes requested');
      } else {
        await expect(
          preview.getByTestId('worktree-row-preview-pr-checks-passing'),
        ).toBeVisible();
        // Hover actions hide the row's resting metadata. Inspect that icon
        // with the pointer away, then reopen the card for the next update.
        await window.mouse.move(900, 400);
        await expect(preview).toHaveCount(0);
        await expect(
          row.getByTestId('worktree-row-checks-passing'),
        ).toBeVisible();
        await row.hover();
        await expect(preview).toBeVisible();
      }
    }
    for (const id of ['pr-state', 'merge-ready', 'review', 'done', 'unread']) {
      await expect(
        preview.getByTestId(`worktree-row-preview-status-${id}`),
      ).toHaveCount(0);
    }
    await expect(
      preview.getByTestId('worktree-row-preview-unread'),
    ).toHaveCount(0);
    await expect(preview).toBeVisible();
    await expect(preview).not.toContainText(/Agents running|Unread updates/);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('question preview glyph matches the sidebar attention color', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-worktree-preview-color-'),
  );
  seedInteractiveQuestion(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await setEarlyAccess(window, true);
    await app.openMainPage();
    await app.selectWorktree('demo-main');
    await expect(window.getByTestId('chat-question-prompt')).toBeVisible();
    const row = window
      .locator('[data-worktree-id="demo-main"]:visible')
      .first();
    await row.hover();
    const glyph = window
      .getByTestId('worktree-row-preview-status-question')
      .locator(':scope > span')
      .first();
    await expect(glyph).toBeVisible();
    const dot = row
      .getByTestId('worktree-row-status')
      .locator(':scope > span')
      .first();
    const color = await dot.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    expect(color).not.toBe('rgba(0, 0, 0, 0)');
    await expect(glyph).toHaveCSS('color', color);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
