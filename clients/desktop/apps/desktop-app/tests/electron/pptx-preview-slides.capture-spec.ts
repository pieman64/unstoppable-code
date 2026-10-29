// @capture-keep: reusable fixture and real-deck gallery for PPTX slide preview reviews
// @capture-reference: docs/development-workflow.md
// Run with: PPTX_STAGE=after pnpm run test:electron:captures:built pptx-preview-slides.capture-spec.ts --reporter=line
// Color modes: run each stage normally for light, then append `--dark-mode` for dark.
//
// PPTX semantic slide preview in the desktop file tab.
//
// Before: a `.pptx` file tab shows "Unsupported file type" with only the
// platform open action. After: the shared `@canopy/ui-rich/office`
// PptxPreview renders each slide as a scaled canvas (positioned text, images,
// tables, master decoration) with speaker notes, under the Office banner.
//
// Determinism: the deck is the hand-built OOXML fixture shared with the unit
// and Electron flow specs; no agents and no network. Set PPTX_CAPTURE_DECK to
// an absolute `.pptx` path to also capture a real deck (`pptx-real-deck-*`).
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedWorktreeChat } from './seeders/seedWorktreeChat.mjs';
import { buildPptxFixture } from '../../../../packages/ui-rich/test/ooxml-fixtures.js';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const STAGE = process.env.PPTX_STAGE === 'before' ? 'before' : 'after';
const REAL_DECK = process.env.PPTX_CAPTURE_DECK;

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
const captureDir = path.join(repoRoot, '.playwright', 'pptx-preview');

function fileTab(
  id: string,
  title: string,
  filePath: string,
): Record<string, unknown> {
  return {
    id,
    title,
    kind: 'file',
    filePath,
    fileViewMode: 'raw',
    description: filePath,
    messages: [],
  };
}

async function captureActivePanel(window: Page, name: string): Promise<void> {
  const panel = window.locator(
    '[data-testid="panel-content-file-diff"]:visible',
  );
  if (STAGE === 'after') {
    await expect(panel.getByTestId('pptx-slide').first()).toBeVisible({
      timeout: 60_000,
    });
  } else {
    await expect(panel.getByTestId('file-viewer-unsupported')).toBeVisible({
      timeout: 60_000,
    });
  }
  await window.waitForTimeout(300);
  await panel.screenshot({
    path: path.join(captureDir, `${name}-desktop-${STAGE}.png`),
    animations: 'disabled',
  });
}

test('captures the desktop PPTX file tab', async () => {
  test.setTimeout(180_000);
  mkdirSync(captureDir, { recursive: true });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-pptx-capture-'),
  );
  const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = seed.workspaces[0]?.worktreePath;
  if (!worktreePath) throw new Error('Seeded worktree path missing.');
  const deckPath = path.join(worktreePath, 'deck.pptx');
  writeFileSync(deckPath, Buffer.from(buildPptxFixture()));
  const tabs = [fileTab('pptx', 'deck.pptx', deckPath)];
  if (REAL_DECK) {
    const realPath = path.join(worktreePath, path.basename(REAL_DECK));
    copyFileSync(REAL_DECK, realPath);
    tabs.push(fileTab('real', path.basename(REAL_DECK), realPath));
  }
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: 'pptx',
    tabs,
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await captureActivePanel(window, 'pptx-fixture-deck');
    if (REAL_DECK) {
      await window.getByTestId('panel-tab-panel-file-real').click();
      await captureActivePanel(window, 'pptx-real-deck');
      if (STAGE === 'after') {
        const slides = window
          .locator('[data-testid="panel-content-file-diff"]:visible')
          .getByTestId('pptx-slide');
        const count = await slides.count();
        for (let index = 0; index < count; index += 1) {
          const slide = slides.nth(index);
          await slide.scrollIntoViewIfNeeded();
          await slide.getByTestId('pptx-slide-canvas').screenshot({
            path: path.join(
              captureDir,
              `pptx-real-deck-slide-${index + 1}-desktop-${STAGE}.png`,
            ),
            animations: 'disabled',
          });
        }
      }
    }
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
