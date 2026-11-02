import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { collectLeaves, getLayout } from './panelHarness.mjs';
import { startExternalOpenCapture } from './fixtures/external-open-capture.mjs';
import {
  seedSlashSearch,
  SEARCH_MARKETPLACE,
  SEARCH_WEBSITE,
  SEARCH_WORKTREE,
} from './fixtures/can5271-slash-search.mjs';

test('CAN-5271 Customize Website opens externally with a selected worktree', async () => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can5271-website-'));
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });
  seedSlashSearch(userDataDir);
  const external = await startExternalOpenCapture();
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({ userDataDir, env: external.env }));
    const page = await electronApp.firstWindow();
    const app = new CanopyAppDriver(page);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree(SEARCH_WORKTREE);
    const browserPanels = async () => {
      const layout = await getLayout(page);
      expect(layout).not.toBeNull();
      return collectLeaves(layout.root)
        .flatMap((leaf) => leaf.panels)
        .filter((panel) => panel.kind === 'browser').length;
    };
    const before = {
      panes: await browserPanels(),
      windows: electronApp.windows().length,
    };
    await app.openPluginsPage();
    await app.openPluginsTab('marketplace');
    await page
      .locator(
        `[data-testid="marketplace-source-row"][data-source-id="${SEARCH_MARKETPLACE}"]`,
      )
      .getByTestId('marketplace-source-open')
      .click();
    await page
      .locator(
        '[data-testid="marketplace-source-plugin"][data-plugin-key="ud-code-review"]',
      )
      .click();
    await page
      .getByTestId('plugins-entry-detail')
      .getByRole('link', { name: 'Website', exact: true })
      .click();
    await expect.poll(() => external.opened).toEqual([SEARCH_WEBSITE]);
    await app.openMainPage();
    expect({
      panes: await browserPanels(),
      windows: electronApp.windows().length,
    }).toEqual(before);
    await test.info().attach('external-open-evidence', {
      body: JSON.stringify({
        url: SEARCH_WEBSITE,
        before,
        after: {
          panes: await browserPanels(),
          windows: electronApp.windows().length,
        },
        opened: external.opened,
      }),
      contentType: 'application/json',
    });
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await external.close();
  }
});
