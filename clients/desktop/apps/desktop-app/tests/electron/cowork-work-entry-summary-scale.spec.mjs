// Regression coverage for the Chats Work Entry list OOM path.
//
// Fifty registry rows carry compact summaries, while only the three entries
// this test opens have readable transcript files. Listing must render every
// summary without decoding the other 47 histories; then realistic navigation
// proves the selected entries still hydrate their complete chat sets lazily.

import { existsSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

import {
  WORKSPACE_ID,
  ENTRY_COUNT,
  OPEN_INDEXES,
  ordinal,
  entryId,
  seedScaleFixture,
  HOME_COWORK_PROMPT,
  registerHomeCoworkScenario,
} from './cowork-summary-fixture.mjs';

test('Chats lists compact summaries and lazily opens entry chats', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-cowork-summary-scale-'),
  );
  seedScaleFixture(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    // CAN-2672: a sole Cowork workspace has no toggle and is force-expanded.
    // CAN-2363 then capped the Chats section, so the full list this scale
    // test exercises is behind "Show all".
    const showAll = window.getByTestId(
      `sidebar-cowork-project-${WORKSPACE_ID}-show-all`,
    );
    // "Show all" is component state, so selecting an entry re-collapses the
    // list back to the cap; re-expand before reaching for a capped-out row.
    const expandAll = async () => {
      await expect(showAll).toBeVisible({ timeout: 30_000 });
      if ((await showAll.innerText()).includes('Show all')) {
        await showAll.click();
      }
    };
    await expandAll();
    await expect(window.locator('[data-standalone-chat-id]')).toHaveCount(
      ENTRY_COUNT,
      { timeout: 30_000 },
    );
    await expect(
      window.getByTestId(`sidebar-work-entry-${entryId(36)}`),
    ).toContainText('Customer investigation 037');

    for (const index of OPEN_INDEXES) {
      const label = ordinal(index);
      await expandAll();
      const row = window.getByTestId(`sidebar-work-entry-${entryId(index)}`);
      // Opening an entry remounts the sidebar section and restores its cap.
      await expect(async () => {
        const showAll = window
          .getByTestId(`sidebar-cowork-project-${WORKSPACE_ID}-show-all`)
          .filter({ hasText: 'Show all' });
        if (await showAll.isVisible()) await showAll.click();
        await expect(row).toBeVisible();
      }).toPass({ timeout: 20_000 });
      // Clicking auto-scrolls and re-resolves the locator if selected-item
      // pinning replaces the in-flow row during the scroll transition.
      await row.click();
      await expect(window.getByTestId('cowork-top-bar')).toBeVisible({
        timeout: 20_000,
      });
      for (const kind of ['Long transcript', 'Pipeline review', 'Overview']) {
        const tab = window
          .locator('[data-testid^="panel-tab-panel-chat-"]')
          .filter({ hasText: `${kind} ${label}` });
        await expect(tab).toBeVisible({ timeout: 20_000 });
        await tab.click();
      }
      const composer = window
        .locator('[data-testid="panel-content-chat"]:visible')
        .getByRole('textbox')
        .first();
      await composer.fill(`Draft for entry ${label}`);
      await expect(composer).toContainText(`Draft for entry ${label}`);
      await composer.fill('');
    }
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Home sends to a new Cowork entry without migrating unrelated legacy histories', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-home-legacy-summary-'),
  );
  seedScaleFixture(userDataDir, { legacySummary: true });
  await registerHomeCoworkScenario();
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await window.getByTestId('sidebar-create-task').click();
    const home = window.getByTestId('page-home');
    await expect(home).toBeVisible();
    // CAN-2698: the only workspace is selected automatically. Since #4159 the
    // picker names that sole Chats destination instead of hiding.
    const workspaceSelect = home.getByTestId('home-workspace-select');
    await expect(workspaceSelect).toBeVisible();
    await expect(workspaceSelect).toContainText('Chats');
    await expect(home.getByTestId('home-composer-editor')).toHaveAttribute(
      'contenteditable',
      'true',
    );
    await home.getByTestId('home-composer-editor').fill(HOME_COWORK_PROMPT);
    await home.getByTestId('home-send-button').click();
    await expect(window.getByTestId('cowork-top-bar')).toBeVisible();
    await expect(
      window
        .locator('[data-testid="panel-content-chat"]:visible')
        .getByText(HOME_COWORK_PROMPT, { exact: true })
        .first(),
    ).toBeVisible();
    const workspaceDir = path.join(userDataDir, 'workspaces', WORKSPACE_ID);
    for (const historicalId of [entryId(24), entryId(12)]) {
      expect(
        existsSync(
          path.join(
            workspaceDir,
            'chat-storage-manifests',
            `${historicalId}.json`,
          ),
        ),
      ).toBe(false);
      expect(
        existsSync(path.join(workspaceDir, 'chats', `${historicalId}.json`)),
      ).toBe(true);
    }
    expect(
      existsSync(
        path.join(workspaceDir, 'chat-archives', `${entryId(12)}.json`),
      ),
    ).toBe(true);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
