// @capture-keep: reusable before/after proof for the documented Auto Delete settings
// @capture-reference: docs/auto-delete.md
// Color modes: run each stage normally for light, then append `--dark-mode` for dark.
/**
 * Auto Delete workspace settings, deterministic disabled/enabled evidence.
 * No-ticket: capture coverage for the Auto Delete terminology alignment.
 *
 * Disabled state:
 *   AUTO_ARCHIVE_STAGE=before pnpm run test:electron:captures:built auto-archive-settings.capture-spec.ts --reporter=line
 *   AUTO_ARCHIVE_STAGE=before pnpm run test:electron:captures:built auto-archive-settings.capture-spec.ts --reporter=line --dark-mode
 * Enabled state, after `pnpm run build:e2e`:
 *   AUTO_ARCHIVE_STAGE=after pnpm run test:electron:captures:built auto-archive-settings.capture-spec.ts --reporter=line
 *   AUTO_ARCHIVE_STAGE=after pnpm run test:electron:captures:built auto-archive-settings.capture-spec.ts --reporter=line --dark-mode
 *
 * The same seeded single-repo workspace opens its real settings modal in both
 * stages. The before stage shows Auto Delete disabled. The after stage enables
 * it, keeps the seven-day default, and selects local branch deletion. No agents,
 * network, or live runtimes are involved.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const STAGE = process.env.AUTO_ARCHIVE_STAGE === 'before' ? 'before' : 'after';
const WORKTREE_BRANCH = 'demo-main';
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
const captureDir = path.join(repoRoot, '.playwright', 'auto-delete');

function writeReport(): void {
  mkdirSync(captureDir, { recursive: true });
  writeFileSync(
    path.join(captureDir, 'report.md'),
    `# Auto Delete settings\n\n` +
      `This deterministic code-workspace flow opens the real project settings modal. Both states show always-on Deletion retention and Auto Delete within the same bordered container. The before captures show Auto Delete disabled. The after captures show it enabled with its default seven-day inactivity window and local branch deletion selected.\n\n` +
      `## Light mode\n\n` +
      `![Disabled, light](./code-workspace-before-light.png)\n\n` +
      `![Enabled, light](./code-workspace-after-light.png)\n\n` +
      `## Dark mode\n\n` +
      `![Disabled, dark](./code-workspace-before-dark.png)\n\n` +
      `![Enabled, dark](./code-workspace-after-dark.png)\n\n` +
      `The durable Electron regression suite separately verifies Save → close → reopen persistence for code, Cowork, and App Advisor settings. Scheduler liveness, last-touch persistence, Auto Delete success/failure continuation, watcher and scheduled-automation vetoes, and notifications are covered by unit/integration tests.\n`,
    'utf8',
  );
}

test(`captures Auto Delete settings (${STAGE})`, async () => {
  mkdirSync(captureDir, { recursive: true });
  const { electronApp, userDataDir } = await launchCanopy({
    seedDemoWorkspaces: true,
    demoWorkspaceApps: ['ts-pnpm-vite'],
  });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.selectWorktree(WORKTREE_BRANCH);
    await app.workspaceHeaderLabel('TypeScript pnpm Vite').hover();
    await app.workspaceSettingsButton('TypeScript pnpm Vite').click();
    const dialog = window
      .locator('[role="dialog"]')
      .filter({ has: window.locator('#project-settings-title') });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Deletion retention');
    await expect(dialog).toContainText('Auto delete');
    await expect(
      dialog.getByTestId('project-settings-retention-toggle'),
    ).toHaveCount(0);

    if (STAGE === 'after') {
      await dialog.getByTestId('project-settings-auto-archive-toggle').check();
      await expect(
        dialog.getByTestId('project-settings-auto-archive-days'),
      ).toHaveValue('7');
      await dialog
        .getByTestId('project-settings-auto-archive-delete-branch')
        .check();
    }

    const retention = dialog.getByTestId('project-settings-retention');
    await retention.scrollIntoViewIfNeeded();
    await retention.screenshot({
      path: path.join(captureDir, `code-workspace-${STAGE}.png`),
      animations: 'disabled',
    });
    writeReport();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
