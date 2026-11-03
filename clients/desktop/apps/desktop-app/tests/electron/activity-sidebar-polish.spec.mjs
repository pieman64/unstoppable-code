import { connectMockCloudAccount } from './seeders/connectMockCloudAccount.mjs';
import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedMcpServers, seedWorktreeChat } from './seeders/index.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CHAT_ID = 'activity-sidebar-polish';
const NOW = '2026-08-28T10:00:00.000Z';

test('MCP warning-only body uses standard spacing and warning ink', async () => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can2712-warning-'));
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });
  // The activity MCP card lists detected servers only for an active chat
  // that selects capabilities.
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: CHAT_ID,
    tabs: [
      {
        id: CHAT_ID,
        title: 'MCP warning',
        messages: [],
        pluginSelections: {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [{ serverId: 'linear', configId: 'linear-default' }],
        },
      },
    ],
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('mcp-servers:list-detected');
      ipcMain.handle('mcp-servers:list-detected', () => ({
        servers: [],
        warnings: ['Unavailable plugin'],
      }));
    });
    const window = await electronApp.firstWindow();
    await window.reload();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const warning = window.getByTestId('mcp-servers-card-warnings');
    await expect(warning).toBeVisible();
    await expect(warning).toHaveCSS('margin-top', '0px');
    await expect(warning).toHaveClass(/fg-warning/);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
// Longer than dnd-kit's default 200ms sortable layout transition, so two
// identical samples this far apart mean the post-drop animation has finished.
const LAYOUT_SETTLE_SAMPLE_MS = 250;

/**
 * Resolves with the locator's bounding box once it stops moving: dnd-kit
 * animates a dropped card into its new slot and may have autoscrolled the
 * list, so a box sampled right after `mouse.up()` points at stale geometry.
 */
async function waitForSettledBoundingBox(window, locator) {
  let previous = await locator.boundingBox();
  await expect
    .poll(
      async () => {
        await window.waitForTimeout(LAYOUT_SETTLE_SAMPLE_MS);
        const next = await locator.boundingBox();
        const settled =
          previous !== null &&
          next !== null &&
          Math.abs(next.x - previous.x) < 0.5 &&
          Math.abs(next.y - previous.y) < 0.5 &&
          Math.abs(next.width - previous.width) < 0.5 &&
          Math.abs(next.height - previous.height) < 0.5;
        previous = next;
        return settled;
      },
      { timeout: 10_000 },
    )
    .toBe(true);
  expect(previous).not.toBeNull();
  return previous;
}

test('activity sidebar exposes accessible grouped controls and interactions', async () => {
  const userDataDir = mkdtempSync(
    os.tmpdir() + '/canopy-electron-activity-sidebar-polish-',
  );
  const seedResult = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });
  const worktreePath = seedResult.workspaces?.[0]?.worktreePath;
  if (!worktreePath) {
    throw new Error('Activity polish fixture did not create a worktree');
  }
  writeFileSync(
    path.join(worktreePath, 'activity-scroll-viewport.txt'),
    'scroll viewport reaches the card edges\n',
    'utf8',
  );
  const summariesDir = path.join(
    userDataDir,
    'workspaces',
    WORKSPACE_ID,
    'summaries',
  );
  mkdirSync(summariesDir, { recursive: true });
  const summary = {
    title: 'App running: development environment configured',
    description: 'Semantic theme colors should follow the active accent.',
    highlights: ['Activity sidebar polish is ready for review'],
    generatedAt: NOW,
    turnCountAtGeneration: 12,
    lastFullRefreshAt: NOW,
    lastFullRefreshTurnCount: 12,
  };
  writeFileSync(
    path.join(summariesDir, `${WORKTREE_ID}.json`),
    `${JSON.stringify({
      version: 2,
      summary,
      history: [{ snapshotId: 'activity-sidebar-polish', summary }],
    })}\n`,
    'utf8',
  );
  seedMcpServers({
    userDataDir,
    servers: [
      {
        definition: {
          id: 'linear',
          name: 'Linear',
          description: 'Linear MCP server',
          type: 'http',
          url: 'https://linear.example.test/mcp',
          httpAuthHandler: 'provider',
          createdAt: NOW,
          updatedAt: NOW,
        },
        configs: [
          {
            id: 'linear-default',
            name: 'Default',
            description: 'Default configuration',
            enabled: true,
            envVars: {},
            extraArgs: [],
            extraHeaders: {},
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
      },
    ],
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: CHAT_ID,
    tabs: [
      {
        id: CHAT_ID,
        title: 'Activity sidebar polish',
        messages: [],
        pluginSelections: {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [{ serverId: 'linear', configId: 'linear-default' }],
        },
      },
    ],
  });
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(
      window,
      'csk_activity_sidebar_polish_attachments_e2e',
    );
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const summary = window.getByTestId('activity-summary-section');
    await expect(summary).toBeVisible({ timeout: 45_000 });
    await expect(
      summary.getByRole('button', {
        name: 'Collapse section',
        exact: true,
      }),
    ).toHaveCount(0);
    const summaryRefresh = summary.getByRole('button', {
      name: 'Refresh summary',
      exact: true,
    });
    await expect(summaryRefresh).toHaveText('');
    await expect(summaryRefresh).toHaveAttribute(
      'data-header-action-button',
      'true',
    );
    await summaryRefresh.hover();
    await expect(window.getByRole('tooltip')).toHaveText('Refresh summary');
    const detailsLink = summary.getByTestId('summary-details-link');
    await expect(detailsLink).toBeVisible();
    await detailsLink.click();
    const summaryModal = window.getByTestId('summary-detail-modal');
    const summaryModalRefresh = summaryModal.getByRole('button', {
      name: 'Refresh',
      exact: true,
    });
    await expect(summaryModalRefresh).toBeVisible();
    await expect(
      summaryModal.getByTestId('summary-highlight-dot'),
    ).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(summaryModal).toHaveCount(0);

    await expect(window.getByTestId('changed-files-section')).toBeVisible({
      timeout: 45_000,
    });
    await expect(
      window.getByTestId('activity-section-pull-request'),
    ).toHaveCount(0);
    await expect(
      window.getByTestId('activity-section-background-processes'),
    ).toHaveCount(0);

    const mcpSection = window.getByTestId('activity-section-mcp-servers');
    await mcpSection.scrollIntoViewIfNeeded();
    const refresh = mcpSection.getByRole('button', {
      name: 'Refresh MCP servers',
      exact: true,
    });
    await expect(mcpSection.getByText('Linear', { exact: true })).toBeVisible();
    seedMcpServers({
      userDataDir,
      servers: [
        {
          definition: {
            id: 'linear',
            name: 'Linear refreshed',
            description: 'Refreshed Linear MCP server',
            type: 'http',
            url: 'https://linear.example.test/mcp',
            httpAuthHandler: 'provider',
            createdAt: NOW,
            updatedAt: NOW,
          },
          configs: [
            {
              id: 'linear-default',
              name: 'Default',
              description: 'Default configuration',
              enabled: true,
              envVars: {},
              extraArgs: [],
              extraHeaders: {},
              createdAt: NOW,
              updatedAt: NOW,
            },
          ],
        },
      ],
    });
    await refresh.click();
    await expect(
      mcpSection.getByText('Linear refreshed', { exact: true }),
    ).toBeVisible();
    await expect(refresh).toHaveText('');
    await expect(refresh).toHaveAttribute('data-header-action-button', 'true');
    const refreshBox = await refresh.boundingBox();
    expect(refreshBox).not.toBeNull();
    expect(refreshBox.width).toBeGreaterThanOrEqual(28);
    expect(refreshBox.height).toBeGreaterThanOrEqual(28);
    await refresh.hover();
    await expect(window.getByRole('tooltip')).toHaveText('Refresh MCP servers');
    await window.mouse.move(1, 1);
    await expect(window.getByRole('tooltip')).toHaveCount(0);
    await expect(
      mcpSection.getByRole('button', {
        name: 'Collapse section',
        exact: true,
      }),
    ).toHaveCount(0);
    const mcpTitleBox = await mcpSection.getByRole('heading').boundingBox();
    expect(mcpTitleBox).not.toBeNull();
    const mcpHeader = mcpSection.locator('[data-panel-section-header]');
    const mcpLeadingIcon = mcpSection.locator(
      '[data-panel-section-leading-icon]',
    );
    const mcpHoverChevron = mcpSection.locator(
      '[data-panel-section-hover-chevron]',
    );
    const mcpDivider = mcpSection.locator('[data-panel-section-divider]');
    const expectedHairlineWidth = await window.evaluate(() =>
      window.devicePixelRatio >= 2 ? '0.5px' : '1px',
    );
    await expect(mcpDivider).toHaveCSS('height', expectedHairlineWidth);
    await expect(mcpDivider).toHaveCSS('opacity', '1');
    const mcpBody = mcpSection.locator('[data-panel-section-body]');
    // CAN-2734: the divider owns the physical-pixel hairline; the body must
    // not add a second computed border underneath it.
    await expect(mcpBody).toHaveCSS('border-top-width', '0px');
    const changedFilesSection = window.getByTestId('changed-files-section');
    await expect(
      changedFilesSection.getByText('activity-scroll-viewport.txt'),
    ).toBeVisible();
    await expect(mcpLeadingIcon).toBeVisible();
    await expect(mcpHoverChevron).toBeHidden();
    await mcpHeader.hover();
    await expect(mcpLeadingIcon).toBeHidden();
    await expect(mcpHoverChevron).toBeVisible();
    const mcpHoverChevronBox = await mcpHoverChevron.boundingBox();
    expect(mcpHoverChevronBox).not.toBeNull();
    expect(
      Math.abs(
        mcpHoverChevronBox.y +
          mcpHoverChevronBox.height / 2 -
          (mcpTitleBox.y + mcpTitleBox.height / 2),
      ),
    ).toBeLessThanOrEqual(2);

    await mcpHeader.click();
    await expect(
      mcpSection.locator('[data-panel-section-title-row]'),
    ).toHaveAttribute('aria-expanded', 'false');
    await expect(mcpDivider).toHaveCSS('opacity', '0');
    await expect(mcpBody).toBeHidden();
    const collapsedInsets = await mcpHeader.evaluate((header) => {
      const card = header.closest('section').getBoundingClientRect();
      const row = header.getBoundingClientRect();
      return [row.top - card.top, card.bottom - row.bottom];
    });
    expect(Math.abs(collapsedInsets[0] - collapsedInsets[1])).toBeLessThan(1);
    await mcpHeader.click();
    await expect(mcpDivider).toHaveCSS('opacity', '1');
    await expect(mcpBody).toBeVisible();

    // All populated Activity cards share the same outer inset, independently
    // of their body content or the presence of a subtitle/header action.
    const populatedCardPadding = await window
      .locator('[data-panel-section-header]')
      .evaluateAll((headers) =>
        headers.map((header) => {
          const style = getComputedStyle(header.closest('section'));
          return {
            title: header.textContent,
            insets: [
              style.paddingTop,
              style.paddingRight,
              style.paddingBottom,
              style.paddingLeft,
            ],
          };
        }),
      );
    expect(populatedCardPadding.length).toBeGreaterThan(1);
    for (const { title, insets } of populatedCardPadding) {
      expect(insets, `Outer padding for ${title}`).toEqual([
        '12px',
        '12px',
        '12px',
        '12px',
      ]);
    }

    const launchButton = window.getByTestId('worktree-top-launch');
    const scriptRunButton = window.getByTestId('activity-scripts-run').first();
    await scriptRunButton.scrollIntoViewIfNeeded();
    await expect(launchButton).toHaveAttribute(
      'data-execution-action-button',
      'true',
    );
    await expect(scriptRunButton).toHaveAttribute(
      'data-execution-action-button',
      'true',
    );
    await expect(scriptRunButton).toHaveCSS('height', '24px');
    await expect(scriptRunButton).toHaveClass(/bg-quaternary/);
    for (const { sectionTestId, actionTestId, label } of [
      {
        sectionTestId: 'activity-plans-section',
        actionTestId: 'activity-plans-import',
        label: 'Import plan',
      },
      {
        sectionTestId: 'activity-section-pipeline-runs',
        actionTestId: 'pipeline-dispatch-open',
        label: 'Dispatch workflow',
      },
      {
        sectionTestId: 'activity-section-hooks',
        actionTestId: 'activity-hooks-add',
        label: 'Add hook',
      },
      {
        sectionTestId: 'activity-section-notes',
        actionTestId: 'workspace-notes-add',
        label: 'Add note',
      },
      {
        sectionTestId: 'activity-section-prompts',
        actionTestId: 'workspace-prompts-add',
        label: 'Add prompt',
      },
      {
        sectionTestId: 'activity-section-attachments',
        actionTestId: 'workspace-attachments-import',
        label: 'Import attachment',
      },
    ]) {
      const section = window.getByTestId(sectionTestId);
      const actionCard = section.getByTestId(actionTestId);
      await section.scrollIntoViewIfNeeded();
      await expect(section).toHaveAttribute(
        'data-activity-action-card',
        'true',
      );
      await expect(section).not.toHaveAttribute('role', 'button');
      await expect(section).not.toHaveAttribute('tabindex', '0');
      await expect(actionCard).toHaveText(label);
      await expect(actionCard).toHaveCSS('user-select', 'none');
      for (const side of ['top', 'right', 'bottom', 'left']) {
        await expect(actionCard).toHaveCSS(`padding-${side}`, '12px');
      }
      await expect(actionCard).toHaveAttribute(
        'data-activity-action-card-button',
        'true',
      );
      await expect(section.getByRole('heading')).toHaveCount(0);
      const actionBox = await actionCard.boundingBox();
      expect(actionBox).not.toBeNull();
      expect(actionBox.height).toBeGreaterThanOrEqual(40);
    }

    const notesSection = window.getByTestId('activity-section-notes');
    const hooksSection = window.getByTestId('activity-section-hooks');
    const notesReorder = notesSection.getByRole('button', {
      name: 'Reorder notes section',
      exact: true,
    });
    await notesReorder.focus();
    await expect(notesReorder).toBeVisible();
    await notesReorder.press('Space');
    await expect(notesReorder).toHaveAttribute('aria-pressed', 'true');
    const dragStatus = window.locator('[role="status"]');
    await expect
      .poll(async () => (await dragStatus.allTextContents()).join(' '))
      .toContain('Draggable item notes was moved over droppable area notes.');
    await window.keyboard.press('ArrowUp');
    await expect
      .poll(async () => (await dragStatus.allTextContents()).join(' '))
      .toContain('Draggable item notes was moved over droppable area hooks.');
    await window.keyboard.press('Space');
    await expect
      .poll(async () => {
        const [notesBox, hooksBox] = await Promise.all([
          notesSection.boundingBox(),
          hooksSection.boundingBox(),
        ]);
        return notesBox != null && hooksBox != null && notesBox.y < hooksBox.y;
      })
      .toBe(true);

    const addNoteCard = window.getByTestId('workspace-notes-add');
    await window.getByTestId('activity-plans-import').click();
    await expect(window.getByTestId('import-plan-modal')).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(window.getByTestId('import-plan-modal')).toHaveCount(0);
    await window.getByTestId('pipeline-dispatch-open').click();
    await expect(
      window.getByTestId('pipeline-trigger-modal-body'),
    ).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(window.getByTestId('pipeline-trigger-modal-body')).toHaveCount(
      0,
    );

    await addNoteCard.focus();
    await window.keyboard.press('Enter');
    await expect(window.getByRole('dialog')).toContainText('New Note');
    await window.keyboard.press('Escape');
    await expect(window.getByRole('dialog')).toHaveCount(0);
    await window.getByTestId('workspace-prompts-add').click();
    await expect(window.getByRole('dialog')).toContainText('New Prompt');
    await window.keyboard.press('Escape');
    await expect(window.getByRole('dialog')).toHaveCount(0);

    // Saving a note turns the Notes action card into a regular card with a
    // two-line title+subtitle header. Its icon-only "Add note" action must
    // then sit in the shared header controls cell, centered on the title row
    // (like the Changed Files card), not on the whole title+subtitle block.
    await addNoteCard.click();
    await window.getByPlaceholder('New Note title').fill('Release checklist');
    await window
      .getByPlaceholder('Write your note... (supports Markdown)')
      .fill('# Release checklist\n- ship it');
    await window.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(window.getByRole('dialog')).toHaveCount(0);
    await expect(
      notesSection.locator('[data-panel-section-subtitle]'),
    ).toHaveText('1 note');
    await expect(notesSection.locator('[data-panel-section-header]')).toHaveCSS(
      'row-gap',
      '4px',
    );
    const notesAddAction = notesSection.getByTestId('workspace-notes-add');
    await expect(notesAddAction).toBeVisible();
    await expect(
      notesSection
        .locator('[data-panel-section-controls]')
        .getByTestId('workspace-notes-add'),
    ).toHaveCount(1);
    const [notesAddBox, notesTitleRowBox] = await Promise.all([
      notesAddAction.boundingBox(),
      notesSection.locator('[data-panel-section-title-row]').boundingBox(),
    ]);
    expect(notesAddBox).not.toBeNull();
    expect(notesTitleRowBox).not.toBeNull();
    const notesAddCenterY = notesAddBox.y + notesAddBox.height / 2;
    const notesTitleRowCenterY =
      notesTitleRowBox.y + notesTitleRowBox.height / 2;
    expect(
      Math.abs(notesAddCenterY - notesTitleRowCenterY),
    ).toBeLessThanOrEqual(2);

    const mcpList = mcpSection.getByTestId('mcp-servers-card-list');
    await expect(mcpList).toBeVisible({ timeout: 45_000 });
    await expect(mcpList.getByTestId('mcp-servers-card-row')).toHaveCount(1);

    const plansSection = window.getByTestId('activity-plans-section');
    const dragHandle = mcpSection.locator('[data-panel-section-title-row]');
    await mcpSection.scrollIntoViewIfNeeded();
    const [dragFrom, dragTo] = await Promise.all([
      dragHandle.boundingBox(),
      plansSection.boundingBox(),
    ]);
    expect(dragFrom).not.toBeNull();
    expect(dragTo).not.toBeNull();
    const startX = dragFrom.x + dragFrom.width / 2;
    const startY = dragFrom.y + dragFrom.height / 2;
    await window.mouse.move(startX, startY);
    await window.mouse.down();
    await window.waitForTimeout(300);
    await window.mouse.move(
      dragTo.x + dragTo.width / 2,
      dragTo.y + dragTo.height / 2,
      { steps: 12 },
    );
    await window.mouse.up();
    await expect
      .poll(async () => {
        const [mcpBox, plansBox] = await Promise.all([
          mcpSection.boundingBox(),
          plansSection.boundingBox(),
        ]);
        return mcpBox !== null && plansBox !== null && mcpBox.y > plansBox.y;
      })
      .toBe(true);

    // Regression: a press-and-drag-immediately (no pause between mouse.down
    // and the first move) must also reorder. A long-press activation
    // constraint cancels this gesture outright, which is how card reordering
    // silently broke while the delayed drag above kept passing.
    //
    // The first drop is still settling when the poll above resolves: dnd-kit
    // animates the reordered card into place and the drag near the panel's
    // top edge autoscrolled the list, so a box sampled immediately lands the
    // press in the MCP card body instead of on its header (the only element
    // wired for pointer activation). Wait for the geometry to stop moving
    // before choosing the press point.
    const immediateDragFrom = await waitForSettledBoundingBox(
      window,
      dragHandle,
    );
    const [immediateDragSource, immediateDragTo] = await Promise.all([
      mcpSection.boundingBox(),
      plansSection.boundingBox(),
    ]);
    expect(immediateDragSource).not.toBeNull();
    expect(immediateDragTo).not.toBeNull();
    // Move by the distance between the two card centers so closestCenter
    // resolves Plans as the drop target regardless of the cards' heights.
    const immediateDragDeltaY =
      immediateDragTo.y +
      immediateDragTo.height / 2 -
      (immediateDragSource.y + immediateDragSource.height / 2);
    const immediateDragStartX =
      immediateDragFrom.x + immediateDragFrom.width / 2;
    const immediateDragStartY =
      immediateDragFrom.y + immediateDragFrom.height / 2;
    await window.mouse.move(immediateDragStartX, immediateDragStartY);
    await window.mouse.down();
    await window.mouse.move(
      immediateDragStartX,
      immediateDragStartY + immediateDragDeltaY,
      { steps: 12 },
    );
    await window.mouse.up();
    await expect
      .poll(async () => {
        const [mcpBox, plansBox] = await Promise.all([
          mcpSection.boundingBox(),
          plansSection.boundingBox(),
        ]);
        return mcpBox !== null && plansBox !== null && mcpBox.y < plansBox.y;
      })
      .toBe(true);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('attachment imports report files that disappear before they are read', async () => {
  const userDataDir = mkdtempSync(
    os.tmpdir() + '/canopy-electron-attachment-read-failure-',
  );
  const seedResult = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });
  const worktreePath = seedResult.workspaces?.[0]?.worktreePath;
  if (!worktreePath) {
    throw new Error('Attachment failure fixture did not create a worktree');
  }
  const disappearingPath = path.join(worktreePath, 'moved-before-import.txt');
  writeFileSync(disappearingPath, 'gone before import\n', 'utf8');
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: CHAT_ID,
    tabs: [
      {
        id: CHAT_ID,
        title: 'Attachment read failure',
        messages: [],
      },
    ],
  });
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await connectMockCloudAccount(
      window,
      'csk_activity_sidebar_polish_attachments_e2e',
    );
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const composer = window
      .locator('[data-chat-textarea][contenteditable="true"]')
      .first();
    await expect(composer).toBeVisible({ timeout: 45_000 });

    await composer.evaluate((element) => {
      window.__attachmentUnhandledRejections = 0;
      window.addEventListener('unhandledrejection', (event) => {
        if (event.reason?.name === 'NotFoundError') {
          window.__attachmentUnhandledRejections += 1;
          event.preventDefault();
        }
      });

      const file = new File(['gone'], 'moved.png', { type: 'image/png' });
      Object.defineProperty(file, 'arrayBuffer', {
        configurable: true,
        value: () =>
          Promise.reject(
            new DOMException(
              'A requested file or directory could not be found at the time an operation was processed.',
              'NotFoundError',
            ),
          ),
      });
      const event = new Event('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', {
        value: { types: ['Files'], files: [file], dropEffect: 'copy' },
      });
      element.dispatchEvent(event);
    });

    const toast = window
      .getByTestId('toast-card')
      .filter({ hasText: "Couldn't attach that file." });
    await expect(toast).toContainText(
      'It may have moved or become unavailable — try selecting it again.',
      { timeout: 10_000 },
    );
    await expect
      .poll(() => window.evaluate(() => window.__attachmentUnhandledRejections))
      .toBe(0);

    await toast.getByRole('button', { name: 'Dismiss' }).click();
    await expect(toast).toHaveCount(0);
    await composer.evaluate((element) => {
      const file = new File(['gone'], 'moved-again.png', {
        type: 'image/png',
      });
      Object.defineProperty(file, 'arrayBuffer', {
        configurable: true,
        value: () =>
          Promise.reject(
            new DOMException(
              'A requested file or directory could not be found at the time an operation was processed.',
              'NotFoundError',
            ),
          ),
      });
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', {
        value: {
          items: [{ kind: 'file', getAsFile: () => file }],
        },
      });
      element.dispatchEvent(event);
    });

    await expect(toast).toContainText(
      'It may have moved or become unavailable — try selecting it again.',
      { timeout: 10_000 },
    );
    await expect
      .poll(() => window.evaluate(() => window.__attachmentUnhandledRejections))
      .toBe(0);

    await toast.getByRole('button', { name: 'Dismiss' }).click();
    await expect(toast).toHaveCount(0);

    await window.evaluate(() => {
      const input = document.createElement('input');
      input.type = 'file';
      input.dataset.testid = 'native-attachment-fixture';
      document.body.append(input);
    });
    const nativeFileInput = window.getByTestId('native-attachment-fixture');
    await nativeFileInput.setInputFiles(disappearingPath);
    unlinkSync(disappearingPath);

    const attachmentAction = window.getByRole('button', {
      name: 'Import attachment',
    });
    await attachmentAction.scrollIntoViewIfNeeded();
    await nativeFileInput.evaluate((input, targetSelector) => {
      if (!(input instanceof HTMLInputElement) || !input.files?.[0]) {
        throw new Error('Native attachment fixture is missing its file');
      }
      const target = document.querySelector(targetSelector);
      if (!(target instanceof HTMLElement)) {
        throw new Error('Attachment action card was not found');
      }
      const event = new Event('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', {
        value: { types: ['Files'], files: input.files, dropEffect: 'copy' },
      });
      target.dispatchEvent(event);
    }, '[aria-label="Import attachment"]');

    await expect(toast).toContainText(
      'It may have moved or become unavailable — try selecting it again.',
      { timeout: 10_000 },
    );
    await expect
      .poll(() => window.evaluate(() => window.__attachmentUnhandledRejections))
      .toBe(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('empty MCP card opens the chat server picker', async () => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-add-mcp-'));
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });
  const { electronApp } = await launchCanopy({
    userDataDir,
    viewportSize: { width: 1400, height: 900 },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const card = window.getByTestId('activity-section-mcp-servers');
    const add = card.getByRole('button', {
      name: 'Add MCP server',
      exact: true,
    });
    await expect(add).toBeVisible();
    await expect(card.locator('[data-panel-section-subtitle]')).toHaveCount(0);
    await expect(card.getByTestId('mcp-servers-card-refresh')).toHaveCount(0);
    await expect(add).toHaveCSS('user-select', 'none');
    await add.click();
    await expect(
      window.locator('[role="dialog"]').filter({ hasText: 'Plugins' }),
    ).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('empty Memory stays hidden and updates when memory files change', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-empty-memory-'),
  );
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });
  const { electronApp } = await launchCanopy({
    userDataDir,
    viewportSize: { width: 1400, height: 900 },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await electronApp.evaluate(({ ipcMain }) => {
      const original = ipcMain._invokeHandlers.get('local-memory:list');
      ipcMain.removeHandler('local-memory:list');
      const pending = new Promise((resolve) => {
        globalThis.releaseInitialMemory = resolve;
      });
      // The workspace index stays unavailable until the test clicks Retry.
      // A one-shot failure is not enough: the explorer also refreshes on
      // memory change events, and the scope's parent-directory watcher fires
      // for unrelated workspace writes, so an incidental refresh could take
      // the failure and leave the visible list to succeed.
      globalThis.memoryUnavailable = true;
      ipcMain.handle('local-memory:list', async (event, request) => {
        if (request.scope === 'workspace') {
          globalThis.initialMemoryRequested = true;
          await pending;
          if (globalThis.memoryUnavailable) {
            throw new Error('Memory index unavailable');
          }
          await globalThis.retryGate;
        }
        return original(event, request);
      });
    });
    await app.selectWorktree(WORKTREE_ID);
    await expect
      .poll(() =>
        electronApp.evaluate(() => Boolean(globalThis.initialMemoryRequested)),
      )
      .toBe(true);

    const card = window.getByTestId('activity-section-memory');
    await expect(card).toBeHidden();
    await electronApp.evaluate(() => globalThis.releaseInitialMemory());
    await expect(card.getByRole('alert')).toBeVisible();
    // Recover behind a gate, so no list (Try again's or an incidental
    // refresh) can succeed and clear the alert before Try again is clicked.
    await electronApp.evaluate(() => {
      globalThis.retryGate = new Promise((resolve) => {
        globalThis.releaseRetry = resolve;
      });
      globalThis.memoryUnavailable = false;
    });
    await card.getByRole('button', { name: 'Try again', exact: true }).click();
    await electronApp.evaluate(() => globalThis.releaseRetry());
    await expect(card).toBeHidden();
    await expect(card.getByPlaceholder('Search memories')).toHaveCount(0);
    await expect(card.locator('[aria-expanded]')).toHaveCount(0);
    const directory = path.join(
      userDataDir,
      'workspaces',
      WORKSPACE_ID,
      'memory',
    );
    mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'MEMORY.md');
    writeFileSync(
      file,
      '# Project memory\n\nRemember the compact activity card.\n',
    );
    await expect(card.getByPlaceholder('Search memories')).toBeVisible();
    const memoryTitle = card.locator('[data-panel-section-title-row]');
    await memoryTitle.click();
    await expect(memoryTitle).toHaveAttribute('aria-expanded', 'false');
    const spacing = await memoryTitle.evaluate((title) => {
      const section = title.closest('section');
      const header = section.querySelector('[data-panel-section-header]');
      const bounds = section.getBoundingClientRect();
      const headerBounds = header.getBoundingClientRect();
      return {
        top: headerBounds.top - bounds.top,
        bottom: bounds.bottom - headerBounds.bottom,
      };
    });
    expect(Math.abs(spacing.bottom - spacing.top)).toBeLessThan(1);
    await memoryTitle.click();
    await expect(card.getByPlaceholder('Search memories')).toBeVisible();
    await card.getByPlaceholder('Search memories').fill('no matching entry');
    await expect(
      card.getByText('No memories yet', { exact: true }),
    ).toHaveCount(0);
    await card.getByPlaceholder('Search memories').fill('');
    unlinkSync(file);
    await expect(card).toBeHidden();
    await expect(card.getByPlaceholder('Search memories')).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

for (const populated of [false, true]) {
  test(`refresh preserves ${populated ? 'populated' : 'empty'} Summary and MCP layouts`, async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-card-refresh-'),
    );
    seedDemoWorkspaces({
      userDataDir,
      apps: ['ts-pnpm-vite'],
      checkRuntimes: false,
    });
    if (populated) {
      const directory = path.join(
        userDataDir,
        'workspaces',
        WORKSPACE_ID,
        'summaries',
      );
      mkdirSync(directory, { recursive: true });
      const summary = {
        title: 'Existing summary',
        description: 'Keep this visible while refreshing.',
        highlights: [],
        generatedAt: NOW,
        turnCountAtGeneration: 1,
        lastFullRefreshAt: NOW,
        lastFullRefreshTurnCount: 1,
      };
      writeFileSync(
        path.join(directory, `${WORKTREE_ID}.json`),
        JSON.stringify({ version: 2, summary, history: [] }),
      );
      seedMcpServers({
        userDataDir,
        servers: [
          {
            definition: {
              id: 'linear',
              name: 'Linear',
              description: 'Fixture',
              type: 'http',
              url: 'https://linear.example.test/mcp',
              httpAuthHandler: 'provider',
              createdAt: NOW,
              updatedAt: NOW,
            },
            configs: [
              {
                id: 'linear-default',
                name: 'Default',
                description: '',
                enabled: true,
                envVars: {},
                extraArgs: [],
                extraHeaders: {},
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          },
        ],
      });
      seedWorktreeChat({
        userDataDir,
        workspaceId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        activeTabId: CHAT_ID,
        tabs: [
          {
            id: CHAT_ID,
            title: 'Refresh',
            messages: [],
            pluginSelections: {
              collectionIds: [],
              skillRefs: [],
              pluginRefs: [],
              mcpServerRefs: [
                { serverId: 'linear', configId: 'linear-default' },
              ],
            },
          },
        ],
      });
    }
    const { electronApp } = await launchCanopy({
      userDataDir,
      viewportSize: { width: 1400, height: 900 },
    });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_ID);
      if (populated)
        await expect(
          window
            .getByTestId('activity-section-mcp-servers')
            .getByText('Linear', { exact: true }),
        ).toBeVisible();
      await electronApp.evaluate(({ ipcMain, BrowserWindow }) => {
        const original = ipcMain._invokeHandlers.get(
          'mcp-servers:list-detected',
        );
        ipcMain.removeHandler('mcp-servers:list-detected');
        ipcMain.handle('mcp-servers:list-detected', async (event, request) => {
          if (!globalThis.holdMcpRefresh) return original(event, request);
          await new Promise((resolve) => {
            globalThis.releaseMcpRefresh = resolve;
          });
          return original(event, request);
        });
        ipcMain.removeHandler('worktree-summary:refresh');
        ipcMain.handle('worktree-summary:refresh', async (_event, request) => {
          const send = (generating) =>
            BrowserWindow.getAllWindows().forEach((win) =>
              win.webContents.send('worktree-summary:generating', {
                ...request,
                generating,
              }),
            );
          send(true);
          await new Promise((resolve) => {
            globalThis.releaseSummaryRefresh = resolve;
          });
          send(false);
        });
      });
      for (const kind of populated ? ['summary', 'mcp'] : ['summary']) {
        const card = window.getByTestId(
          kind === 'summary'
            ? 'activity-summary-section'
            : 'activity-section-mcp-servers',
        );
        const title = populated
          ? kind === 'summary'
            ? 'Summary'
            : 'MCP servers'
          : kind === 'summary'
            ? 'Generate summary'
            : 'No MCP servers yet';
        const titleLabel =
          !populated && kind === 'summary'
            ? card.getByTestId('activity-summary-generate')
            : card.locator('[data-panel-section-title]');
        await expect(titleLabel).toHaveText(title);
        if (!populated && kind === 'summary') {
          await expect(card).toHaveAttribute(
            'data-activity-action-card',
            'true',
          );
          await expect(titleLabel).toHaveCSS('user-select', 'none');
          await expect(card.locator('[data-panel-section-body]')).toHaveCount(
            0,
          );
        }
        if (populated)
          await expect(
            card.getByText(kind === 'summary' ? 'Existing summary' : 'Linear', {
              exact: true,
            }),
          ).toBeVisible();
        const action = card.getByRole('button', {
          name:
            kind === 'summary'
              ? populated
                ? 'Refresh summary'
                : 'Generate summary'
              : 'Refresh MCP servers',
          exact: true,
        });
        if (populated && kind === 'summary') {
          const details = card.getByTestId('summary-details-link');
          await window.mouse.move(0, 0);
          const normalColor = await details.evaluate(
            (element) => getComputedStyle(element).color,
          );
          await details.hover();
          await expect(details).toHaveCSS('text-decoration-line', 'none');
          await expect
            .poll(() =>
              details.evaluate((element) => getComputedStyle(element).color),
            )
            .not.toBe(normalColor);
          await window.mouse.move(0, 0);
          const titleBox = await card
            .locator('[data-panel-section-title]')
            .boundingBox();
          const updatedBox = await card
            .locator('[data-panel-section-subtitle]')
            .boundingBox();
          expect(
            Math.abs(
              titleBox.y +
                titleBox.height / 2 -
                updatedBox.y -
                updatedBox.height / 2,
            ),
          ).toBeLessThan(1);
          expect(updatedBox.x).toBeGreaterThan(titleBox.x);
        }
        const before = await card.boundingBox();
        if (kind === 'mcp')
          await electronApp.evaluate(() => {
            globalThis.holdMcpRefresh = true;
          });
        await action.click();
        const busy = card.getByRole('button', {
          name:
            !populated && kind === 'summary'
              ? 'Generating summary…'
              : /in progress/,
        });
        await expect(busy).toBeDisabled();
        await expect(titleLabel).toHaveText(
          !populated && kind === 'summary' ? 'Generating summary…' : title,
        );
        await expect
          .poll(async () =>
            Math.abs((await card.boundingBox()).height - before.height),
          )
          .toBeLessThan(1);
        if (!populated) {
          await expect(
            card.locator('[data-panel-section-subtitle]'),
          ).toHaveCount(0);
          await expect(card.locator('[aria-expanded]')).toHaveCount(0);
          await expect(
            card.getByTestId('mcp-servers-card-loading'),
          ).toHaveCount(0);
        } else {
          await expect(
            card.getByText(kind === 'summary' ? 'Existing summary' : 'Linear', {
              exact: true,
            }),
          ).toBeVisible();
        }
        await electronApp.evaluate((_electron, type) => {
          if (type === 'summary') globalThis.releaseSummaryRefresh();
          else globalThis.releaseMcpRefresh();
        }, kind);
        await expect(action).toBeEnabled();
      }
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}
