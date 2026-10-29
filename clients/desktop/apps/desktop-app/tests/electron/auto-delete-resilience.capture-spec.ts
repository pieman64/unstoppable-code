// @capture-keep: reusable before/after proof for documented cleanup-warning resilience
// @capture-reference: docs/auto-delete.md
/**
 * Auto Delete resilience: show cleanup warnings on a committed deletion.
 * Run AUTO_DELETE_STAGE=before (default: after) with
 * pnpm run test:electron:captures:built auto-delete-resilience.capture-spec.ts --reporter=line
 * and repeat with --dark-mode, both before the fix and after build:e2e.
 * A seeded workspace receives the same deterministic completion event in both
 * stages. No provider, network, or wall-clock expiry is needed for this visual
 * evidence; normal lifecycle specs separately exercise the real scheduler.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { BrowserWindow as ElectronBrowserWindow } from 'electron';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const stage = process.env.AUTO_DELETE_STAGE === 'before' ? 'before' : 'after';
const captureDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../.playwright/auto-delete-resilience',
);

test(`captures cleanup warning (${stage})`, async () => {
  mkdirSync(captureDir, { recursive: true });
  const { electronApp, userDataDir } = await launchCanopy({
    seedDemoWorkspaces: true,
    demoWorkspaceApps: ['ts-pnpm-vite'],
  });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    await electronApp.evaluate(
      ({ BrowserWindow }: { BrowserWindow: typeof ElectronBrowserWindow }) => {
        for (const browserWindow of BrowserWindow.getAllWindows()) {
          browserWindow.webContents.send('auto-archive:completed', {
            workspaceId: 'demo-ts-pnpm-vite',
            workspaceName: 'TypeScript pnpm Vite',
            targetId: 'demo-main',
            targetName: 'demo-main',
            surface: 'single-repo',
            inactivityDays: 7,
            status: 'success',
            warnings: ['Browser storage cleanup failed.'],
          });
        }
      },
    );
    const toast = window
      .getByTestId('toast-card')
      .filter({ hasText: 'automatically deleted' })
      .first();
    await expect(toast).toBeVisible();
    await toast.screenshot({
      path: path.join(captureDir, `cleanup-warning-${stage}.png`),
      animations: 'disabled',
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
