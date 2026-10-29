// @capture-keep: paired before/after evidence for CAN-1570 phase 08b file choosers
// @capture-reference: docs/planning/2026-10-06-can-1570-browser-interactions/phases/phase-08-uploads.md
// CAN-1570 phase 08b — capture the browser pane after an agent's click opens a
// file chooser, before (no interception: nothing shows) and after (the
// pending-chooser notice), and, after, the request_files card in the chat.
//
// Run each stage in light mode, then add `--dark-mode` for dark mode:
//   CAN_1570_CHOOSERS_STAGE=before pnpm run test:electron:captures:built can-1570-choosers.capture-spec.ts
//   CAN_1570_CHOOSERS_STAGE=after pnpm run test:electron:captures:built can-1570-choosers.capture-spec.ts
// `before` runs on the 08a build, which has no request_files, so it captures
// the pane only.
//
// Determinism: the standard panel harness seeds a disposable demo worktree; the
// Browser Lab upload case is served from paired loopback listeners. The
// request_files prompt comes from an E2E approval session in Ask mode, and the
// native open dialog is never opened. No live agents or external services are
// involved.

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator } from '@playwright/test';
import { closeCanopy } from './launchCanopy.mjs';
import { listenPairedBrowserLabServers } from './mock-server/routes/browser-lab.mjs';
import { chatPanelLocator, seedPanelWorktree } from './panelHarness.mjs';
import {
  chatForRoute,
  endApprovalSession,
  openLab,
  selector,
  startApprovalSession,
  WORKTREE_ROUTE,
  worktreeMcpRoute,
} from './browser-files-harness.mjs';

const STAGES = ['before', 'after'] as const;
const STAGE =
  STAGES.find((stage) => stage === process.env.CAN_1570_CHOOSERS_STAGE) ??
  'before';
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
const captureDir = path.join(repoRoot, '.playwright', 'can-1570');

async function capture(locator: Locator, name: string): Promise<void> {
  await expect(locator).toBeVisible();
  await locator.page().waitForTimeout(250);
  await locator.screenshot({
    path: path.join(captureDir, `${name}-desktop-${STAGE}.png`),
    animations: 'disabled',
  });
}

test('captures the file chooser surfaces', async () => {
  test.setTimeout(180_000);
  mkdirSync(captureDir, { recursive: true });
  const lab = await listenPairedBrowserLabServers();
  try {
    const launched = await seedPanelWorktree();
    const { electronApp, userDataDir, window } = launched;
    try {
      const route = await worktreeMcpRoute(electronApp);
      const session = await startApprovalSession(
        electronApp,
        chatForRoute(WORKTREE_ROUTE),
        'ask',
      );
      try {
        const opened = await openLab(
          electronApp,
          route.run,
          lab.primary.origin,
          'upload',
          WORKTREE_ROUTE,
          { laidOut: true },
        );
        const pane = window.getByTestId(`browser-pane-${opened.browserId}`);
        await opened.run({
          type: 'browser.click',
          locator: selector('browser-lab-upload-hidden-open'),
        });
        if (STAGE === 'after')
          await expect(
            pane.getByTestId('browser-pending-surface-file-chooser'),
          ).toBeVisible({ timeout: 15_000 });
        await capture(pane, 'browser-file-chooser-pane');

        if (STAGE === 'after') {
          const requesting = opened.run({
            type: 'browser.request_files',
            locator: selector('browser-lab-upload-single-input'),
            purpose: 'Your report for the upload form',
          });
          const card =
            chatPanelLocator(window).getByTestId('tool-approval-card');
          await expect(card).toBeVisible({ timeout: 15_000 });
          await capture(card, 'request-files-card');
          await card.getByTestId('tool-approval-decline-files').click();
          await requesting;
        }
      } finally {
        await endApprovalSession(electronApp, session.id);
        await route.close();
      }
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  } finally {
    await lab.close();
  }
});
