// @capture-keep: paired before/after evidence for CAN-1570 phase 08a uploads
// @capture-reference: docs/planning/2026-10-06-can-1570-browser-interactions/phases/phase-08-uploads.md
// CAN-1570 phase 08a — capture Settings → Approvals' add-rule form before and
// after the Browser upload kind, and, after, the upload approval card and the
// Files panel's upload row.
//
// Run each stage in light mode, then add `--dark-mode` for dark mode:
//   CAN_1570_UPLOADS_STAGE=before pnpm run test:electron:captures:built can-1570-uploads.capture-spec.ts
//   CAN_1570_UPLOADS_STAGE=after pnpm run test:electron:captures:built can-1570-uploads.capture-spec.ts
// `before` runs on the 07b build, which has no upload action, so it captures
// the Settings form only.
//
// Determinism: the standard panel harness seeds a disposable demo worktree; the
// Browser Lab upload case is served from paired loopback listeners. The
// approval prompt comes from an E2E approval session in Ask mode. No live
// agents or external services are involved.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy } from './launchCanopy.mjs';
import { listenPairedBrowserLabServers } from './mock-server/routes/browser-lab.mjs';
import { chatPanelLocator, seedPanelWorktree } from './panelHarness.mjs';
import {
  chatForRoute,
  endApprovalSession,
  openFilesPanel,
  openLab,
  selector,
  startApprovalSession,
  WORKTREE_ROUTE,
  worktreeMcpRoute,
} from './browser-files-harness.mjs';

const STAGES = ['before', 'after'] as const;
const STAGE =
  STAGES.find((stage) => stage === process.env.CAN_1570_UPLOADS_STAGE) ??
  'before';
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
const captureDir = path.join(repoRoot, '.playwright', 'can-1570');

async function captureAddRuleForm(window: Page, name: string): Promise<void> {
  const form = window
    .getByTestId('approval-add-rule-global')
    .locator('xpath=..');
  await expect(form).toBeVisible();
  await window.waitForTimeout(250);
  await form.screenshot({
    path: path.join(captureDir, `${name}-desktop-${STAGE}.png`),
    animations: 'disabled',
  });
}

test('captures the upload approval surfaces', async () => {
  test.setTimeout(180_000);
  mkdirSync(captureDir, { recursive: true });
  const lab = await listenPairedBrowserLabServers();
  try {
    const launched = await seedPanelWorktree();
    const { electronApp, userDataDir, window } = launched;
    try {
      if (STAGE === 'after') {
        const route = await worktreeMcpRoute(electronApp);
        const opened = await openLab(
          electronApp,
          route.run,
          lab.primary.origin,
          'upload',
          WORKTREE_ROUTE,
          { laidOut: true },
        );
        const session = await startApprovalSession(
          electronApp,
          chatForRoute(WORKTREE_ROUTE),
          'ask',
        );
        try {
          const file = path.join(
            session.workspaceRoot,
            'exports',
            'report.csv',
          );
          mkdirSync(path.dirname(file), { recursive: true });
          writeFileSync(file, 'region,total\nnorth,12\n');
          const uploading = opened.run({
            type: 'browser.upload_files',
            locator: selector('browser-lab-upload-single-input'),
            files: [{ path: 'exports/report.csv' }],
          });
          const card =
            chatPanelLocator(window).getByTestId('tool-approval-card');
          await expect(card).toBeVisible({ timeout: 15_000 });
          await window.waitForTimeout(250);
          await card.screenshot({
            path: path.join(
              captureDir,
              'upload-approval-card-desktop-after.png',
            ),
            animations: 'disabled',
          });
          await card.getByTestId('tool-approval-allow').click();
          await uploading;
          const { pane } = await openFilesPanel(window, opened.browserId);
          await expect(
            pane.locator('[data-testid^="browser-transfer-row-"]').first(),
          ).toContainText('Attached', { timeout: 15_000 });
          await window.waitForTimeout(250);
          await pane.screenshot({
            path: path.join(
              captureDir,
              'browser-files-upload-desktop-after.png',
            ),
            animations: 'disabled',
          });
        } finally {
          await endApprovalSession(electronApp, session.id);
          await route.close();
        }
      }

      const app = new CanopyAppDriver(window);
      await app.openSettings();
      await window.getByTestId('settings-nav-approvals').click();
      await expect(
        window.getByTestId('settings-approvals-section'),
      ).toBeVisible();
      await captureAddRuleForm(window, 'approvals-add-rule');
      if (STAGE === 'after') {
        const form = window
          .getByTestId('approval-add-rule-global')
          .locator('xpath=..');
        await form.getByLabel('Kind').selectOption('browser-upload');
        await form.getByLabel('Site').fill('https://upload.example.com');
        await form.getByLabel('Path (optional)').fill('exports/**');
        await captureAddRuleForm(window, 'approvals-add-upload-rule');
      }
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  } finally {
    await lab.close();
  }
});
