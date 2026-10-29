/**
 * @capture-keep: reusable before/after evidence while Phase 0A visual acceptance remains open
 * @capture-reference: docs/planning/2026-07-31-desktop-core-daemon/artifacts/phase-0a-file-tree-reads.md
 * Phase 0A filesystem boundary safety verification (no UI redesign).
 * Seeded local checkout, no agents/network: roots and directory contents must
 * remain visually identical across the boundary hardening.
 * CORE_FILESYSTEM_STAGE=before (or after; default) pnpm run test:electron:captures:built core-filesystem-boundary.capture-spec.ts --reporter=line
 * Repeat each stage with --dark-mode for the paired dark capture.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';

const stage =
  process.env.CORE_FILESYSTEM_STAGE === 'before' ? 'before' : 'after';
const captureDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../.playwright/core-filesystem-boundary',
);

test('captures roots and an expanded directory through the legacy IPC projection', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'core-filesystem-capture-'),
  );
  const seed = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });
  const worktreePath = seed.workspaces[0]?.worktreePath;
  if (!worktreePath) throw new Error('Missing seeded worktree');
  mkdirSync(path.join(worktreePath, 'boundary-demo'), { recursive: true });
  writeFileSync(
    path.join(worktreePath, 'boundary-demo', 'README.md'),
    '# Boundary demo\n',
  );
  writeFileSync(
    path.join(worktreePath, 'boundary-demo', 'example.ts'),
    'export const answer = 42;\n',
  );
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    providerType: 'claude',
    tabs: [{ id: 'boundary-chat', title: 'Filesystem' }],
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree('demo-main');
    await window.getByTestId('panel-add-panel-group-chat').click();
    await window.getByTestId('panel-add-menu-item-file-explorer').click();
    await window
      .locator('[data-testid="files-tree-folder"][data-path="boundary-demo"]')
      .click();
    await expect(
      window.locator(
        '[data-testid="files-tree-row"][data-path="boundary-demo/example.ts"]',
      ),
    ).toBeVisible();
    mkdirSync(captureDir, { recursive: true });
    const explorer = window.getByTestId('files-tree-tab');
    await explorer.screenshot({
      path: path.join(captureDir, `expanded-directory-${stage}.png`),
      animations: 'disabled',
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
