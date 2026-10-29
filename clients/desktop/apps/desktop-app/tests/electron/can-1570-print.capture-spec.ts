// @capture-keep: paired before/after evidence for CAN-1570 phase 09b print interception
// @capture-reference: docs/planning/2026-10-06-can-1570-browser-interactions/phases/phase-09-print-pending-surfaces.md
// CAN-1570 phase 09b — capture the browser pane after an agent's click on the
// Browser Lab print button, before (no interception: nothing shows) and after
// (the pending print notice).
//
// Run each stage in light mode, then add `--dark-mode` for dark mode:
//   CAN_1570_PRINT_STAGE=before pnpm run test:electron:captures:built can-1570-print.capture-spec.ts
//   CAN_1570_PRINT_STAGE=after pnpm run test:electron:captures:built can-1570-print.capture-spec.ts
// `before` runs on the 09a build. There, nothing intercepts the page's print(),
// so the spec replaces it with a no-op first: the native print panel never
// opens, and the pane looks as it would behind it.
//
// Determinism: the standard panel harness seeds a disposable demo worktree; the
// Browser Lab print case is served from paired loopback listeners. The native
// print dialog is stubbed. No live agents or external services are involved.

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
  stubNativePrint,
  WORKTREE_ROUTE,
  worktreeMcpRoute,
} from './browser-files-harness.mjs';

const STAGES = ['before', 'after'] as const;
const STAGE =
  STAGES.find((stage) => stage === process.env.CAN_1570_PRINT_STAGE) ??
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

test('captures the pending print surface', async () => {
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
          'print',
          WORKTREE_ROUTE,
          { laidOut: true },
        );
        await stubNativePrint(electronApp, opened.url);
        const pane = window.getByTestId(`browser-pane-${opened.browserId}`);
        await opened.run({
          type: 'browser.click',
          locator: selector('browser-lab-print-button'),
        });
        if (STAGE === 'after')
          await expect(
            pane.getByTestId('browser-pending-surface-print'),
          ).toBeVisible({ timeout: 15_000 });
        await capture(pane, 'browser-print-request-pane');
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
