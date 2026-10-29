// @capture-keep: paired before/after evidence for CAN-1570 phase 09c HTTP sign-ins
// @capture-reference: docs/planning/2026-10-06-can-1570-browser-interactions/phases/phase-09-print-pending-surfaces.md
// CAN-1570 phase 09c — capture the browser pane after an agent's click opens
// the Browser Lab's protected page, before (nothing intercepts the challenge:
// the page shows its 401 response) and after (the pending sign-in notice, then
// the app's credentials dialog).
//
// Run each stage in light mode, then add `--dark-mode` for dark mode:
//   CAN_1570_AUTH_STAGE=before pnpm run test:electron:captures:built can-1570-auth.capture-spec.ts
//   CAN_1570_AUTH_STAGE=after pnpm run test:electron:captures:built can-1570-auth.capture-spec.ts
// `before` runs on the 09b build.
//
// Determinism: the standard panel harness seeds a disposable demo worktree; the
// Browser Lab auth case is served from paired loopback listeners. No
// credentials are typed. No live agents or external services are involved.

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator } from '@playwright/test';
import { closeCanopy } from './launchCanopy.mjs';
import { listenPairedBrowserLabServers } from './mock-server/routes/browser-lab.mjs';
import { seedPanelWorktree } from './panelHarness.mjs';
import {
  openLab,
  selector,
  WORKTREE_ROUTE,
  worktreeMcpRoute,
} from './browser-files-harness.mjs';

const STAGES = ['before', 'after'] as const;
const STAGE =
  STAGES.find((stage) => stage === process.env.CAN_1570_AUTH_STAGE) ?? 'before';
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

test('captures the pending sign-in surfaces', async () => {
  test.setTimeout(180_000);
  mkdirSync(captureDir, { recursive: true });
  const lab = await listenPairedBrowserLabServers();
  try {
    const launched = await seedPanelWorktree();
    const { electronApp, userDataDir, window } = launched;
    try {
      const route = await worktreeMcpRoute(electronApp);
      try {
        const opened = await openLab(
          electronApp,
          route.run,
          lab.primary.origin,
          'auth',
          WORKTREE_ROUTE,
          { laidOut: true },
        );
        const pane = window.getByTestId(`browser-pane-${opened.browserId}`);
        await opened.run({
          type: 'browser.click',
          locator: selector('browser-lab-auth-protected-link'),
        });
        if (STAGE === 'after') {
          const notice = pane.getByTestId('browser-pending-surface-auth');
          await expect(notice).toBeVisible({ timeout: 15_000 });
          await capture(pane, 'browser-auth-request-pane');
          await notice.getByTestId('browser-auth-request-sign-in').click();
          await expect(
            pane.getByTestId('browser-sign-in-dialog'),
          ).toBeVisible();
          await capture(pane, 'browser-sign-in-dialog-pane');
          await pane.getByTestId('browser-sign-in-cancel').click();
        } else {
          await window.waitForTimeout(1_500);
          await capture(pane, 'browser-auth-request-pane');
        }
      } finally {
        await route.close();
      }
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  } finally {
    await lab.close();
  }
});
