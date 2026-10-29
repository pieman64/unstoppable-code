/**
 * @capture-keep: reproducible guest-rail desktop controls while CAN-2989 evidence remains incomplete
 * @capture-reference: docs/planning/2026-10-07-can-2989-gap-audit/README.md
 * CAN-2989 temporary unchanged desktop rail controls. Headless runs:
 * CAN2989_STAGE=before|after pnpm run test:electron:captures:built can-2989-guest-rail.capture-spec.ts
 * Repeat with --dark-mode. Same local seeder, viewport and fonts readiness.
 * Remove only after the complete cross-platform report has been handed off.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedChatsSectionFixture } from './seeders/index.mjs';
const stage = process.env.CAN2989_STAGE === 'before' ? 'before' : 'after';
const output = path.resolve('.playwright/can-2989-guest-rail');
for (const count of [0, 2]) {
  test(`unchanged desktop rail with ${count} chats`, async () => {
    test.setTimeout(120_000);
    mkdirSync(output, { recursive: true });
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can-2989-rail-'));
    let launched: Awaited<ReturnType<typeof launchCanopy>> | undefined;
    try {
      seedChatsSectionFixture(userDataDir, {
        worktreeCount: 0,
        chatEntryCount: count,
      });
      launched = await launchCanopy({
        userDataDir,
        viewportSize: { width: 1440, height: 1000 },
      });
      const { electronApp } = launched;
      const window = await electronApp.firstWindow();
      await new CanopyAppDriver(window).waitForShell();
      await expect(
        window.getByTestId('portal-sidebar-guest-projects-card'),
      ).toHaveCount(0);
      await window.evaluate(() => document.fonts.ready.then(() => undefined));
      await window.getByTestId('sidebar-scroll-container').screenshot({
        path: path.join(
          output,
          `desktop-${count === 0 ? 'empty-chats' : 'populated'}-${stage}.png`,
        ),
        animations: 'disabled',
      });
    } finally {
      if (launched) await closeCanopy(launched.electronApp, userDataDir);
      else rmSync(userDataDir, { recursive: true, force: true });
    }
  });
}
