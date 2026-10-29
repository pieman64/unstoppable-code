// Shared workspace-item activity cards (Notes / Prompts / Attachments) on the
// Code worktree surface: the add-panel menu offers the new activity-card
// sections, creating a note through the card persists it (machine-local
// {dataDir}/workspaces/{ws}/notes/ + index.json) with a branch-origin badge
// resolved from the worktree record, and the attachments card lists files
// imported into the existing per-worktree attachments dir (storage
// unchanged).

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeCanopy } from './launchCanopy.mjs';
import { seedPanelWorktree } from './panelHarness.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';

test('notes card creates an indexed note with a branch-origin badge; attachments card lists imported files', async () => {
  const { electronApp, userDataDir, window } = await seedPanelWorktree();

  try {
    // --- Open the Notes activity card from the add-panel menu -------------
    await window.getByTestId('panel-add-panel-group-chat').click();
    const addMenu = window.getByTestId('panel-add-menu');
    await expect(addMenu).toBeVisible();
    await window.getByTestId('panel-add-menu-item-activity-card-notes').click();

    // --- Create a note through the standalone card panel -------------------
    // (The Notes section also renders inside the stacked activity rail, so
    // scope to the frameless single-card chrome.)
    const notesCard = window.getByTestId('frameless-section-header');
    await notesCard.getByTestId('workspace-notes-add').click();
    await window.getByPlaceholder('New Note title').fill('Release checklist');
    await window
      .getByPlaceholder('Write your note... (supports Markdown)')
      .fill('# Release checklist\n- ship it');
    await window.getByRole('button', { name: 'Save', exact: true }).click();

    const noteRow = window.getByTestId('workspace-notes-item').first();
    await expect(noteRow).toBeVisible();
    await expect(noteRow).toContainText('Release checklist');
    // The branch origin no longer renders inline — it moved into the info
    // button that lives with the row's hover action chip (alongside the
    // created date) so it stops eating horizontal space. Hovering the row
    // reveals the chip; hovering the info button reveals the portaled tooltip.
    // The seeded branch equals the worktree id, which counts as a
    // canopy-default name and renders the friendly display label.
    await noteRow.hover();
    await noteRow.getByRole('button', { name: 'Item details' }).hover();
    const noteTooltip = window.getByRole('tooltip');
    await expect(noteTooltip).toContainText('from New Task');
    await expect(noteTooltip).toContainText('Created');

    // Persisted machine-locally, outside the checkout, with a v1 index.
    const notesDir = path.join(
      userDataDir,
      'workspaces',
      WORKSPACE_ID,
      'notes',
    );
    await expect
      .poll(() => existsSync(path.join(notesDir, 'release-checklist.md')))
      .toBe(true);
    const index = JSON.parse(
      readFileSync(path.join(notesDir, 'index.json'), 'utf8'),
    );
    expect(index.version).toBe(1);
    expect(index.items['release-checklist'].originWorktreeId).toBe(WORKTREE_ID);
    expect(index.items['release-checklist'].originBranchName).toBe(WORKTREE_ID);

    // --- Attachments card lists the existing worktree attachments dir ------
    // Import BEFORE mounting the card (the card loads on mount; the header
    // button opens a native dialog Playwright cannot drive) using a real
    // file — the note markdown written above.
    const imported = await window.evaluate(
      async ({ projectId, worktreeId, sourcePath }) => {
        const response = await window.api.workspaceItems.importAttachments({
          projectId,
          worktreeId,
          filePaths: [sourcePath],
        });
        return response.attachments.map((attachment) => attachment.filename);
      },
      {
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        sourcePath: path.join(
          userDataDir,
          'workspaces',
          WORKSPACE_ID,
          'notes',
          'release-checklist.md',
        ),
      },
    );
    expect(imported).toEqual(['release-checklist.md']);

    await window.getByTestId('panel-add-panel-group-chat').click();
    await window
      .getByTestId('panel-add-menu-item-activity-card-attachments')
      .click();

    // Same storage location the chat attachment flow uses.
    expect(
      existsSync(
        path.join(
          userDataDir,
          'workspaces',
          WORKSPACE_ID,
          'attachments',
          WORKTREE_ID,
          'release-checklist.md',
        ),
      ),
    ).toBe(true);

    // The card lists the dir on mount (row also appears in the stacked
    // activity rail, hence .first()).
    const attachmentRow = window
      .getByTestId('workspace-attachments-item')
      .first();
    await expect(attachmentRow).toBeVisible();
    await expect(attachmentRow).toContainText('release-checklist.md');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
