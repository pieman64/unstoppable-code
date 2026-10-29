// merge-queue-hooks (CAN-3782): the merge queue PR hook triggers in the
// Activity Hooks section and the workspace hook editor.
//
// Seeds the multi-repo demo workspace with local hook overrides: Web App has
// one `pr:queue:removed` hook (a flat row), and API Service has
// `pr:merge-conflicts`, `pr:queue:removed`, and `pr:queue:entered` (a repo
// group, written out of order to prove trigger ordering). The spec asserts the
// labels and order, then checks that only the queue triggers offer the queue
// variables in the hook editor's "Insert variable" menu. All state is local:
// no GitHub token, no network.
//
//   pnpm run test:electron:built merge-queue-hooks.spec.mjs --reporter=line

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver, revealRowActions } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const WORKSPACE_ID = 'demo-multi-repo-fullstack';
const WORKSPACE_NAME = 'Multi Repo Fullstack';
const WORKTREE_ID = 'demo-main';
const COMMANDS = {
  webQueueRemoved: 'echo web-queue-removed',
  apiMergeConflicts: 'echo api-merge-conflicts',
  apiQueueRemoved: 'echo api-queue-removed',
  apiQueueEntered: 'echo api-queue-entered',
};

function commandHook(command) {
  return [{ type: 'command', command }];
}

function seedMergeQueueHooks(userDataDir) {
  seedDemoWorkspaces({
    userDataDir,
    apps: ['multi-repo-fullstack'],
    checkRuntimes: false,
  });
  const configPath = path.join(
    userDataDir,
    'workspaces',
    WORKSPACE_ID,
    'workspace.json',
  );
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const repo = (id) => {
    const match = config.repos.find((entry) => entry.id === id);
    if (!match) throw new Error(`Missing ${id} repo in seeded project`);
    return match;
  };
  repo('web').hooks = {
    'pr:queue:removed': commandHook(COMMANDS.webQueueRemoved),
  };
  repo('api').hooks = {
    'pr:queue:entered': commandHook(COMMANDS.apiQueueEntered),
    'pr:merge-conflicts': commandHook(COMMANDS.apiMergeConflicts),
    'pr:queue:removed': commandHook(COMMANDS.apiQueueRemoved),
    // Disable the demo manifest's hook so the group holds only these three.
    'worktree:precommit:failure': null,
  };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

async function hooksSection(window) {
  const title = window.getByRole('heading', { name: 'Hooks', exact: true });
  await expect(title).toBeVisible({ timeout: 45_000 });
  const section = title.locator('xpath=ancestor::section[1]');
  const expand = section.getByRole('button', {
    name: 'Expand section',
    exact: true,
  });
  if (await expand.count()) await expand.first().click();
  return section;
}

/** Each entry's label: the first span in an `activity-hooks-entry` row. */
function entryLabels(entries) {
  return entries.evaluateAll((nodes) =>
    nodes.map((node) => node.querySelector('span')?.textContent?.trim() ?? ''),
  );
}

async function insertVariableNames(window, settings, command) {
  const commandIndex = await settings
    .locator('textarea')
    .evaluateAll(
      (nodes, value) => nodes.findIndex((node) => node.value === value),
      command,
    );
  expect(commandIndex, `hook editor for ${command}`).toBeGreaterThanOrEqual(0);
  const editor = settings
    .locator('textarea')
    .nth(commandIndex)
    .locator(
      'xpath=ancestor::div[contains(@class,"rounded-lg") and contains(@class,"bg-card")][1]',
    );
  const toggle = editor.getByRole('button', {
    name: 'Insert variable',
    exact: true,
  });
  await toggle.scrollIntoViewIfNeeded();
  await toggle.click();
  const menu = window.getByRole('menu', { name: 'Available variables' });
  await expect(menu).toBeVisible();
  const names = await menu
    .locator('[role="menuitem"] > span:first-child')
    .allTextContents();
  await toggle.click();
  await expect(menu).toHaveCount(0);
  return names.join('\n');
}

test('merge queue hooks: activity labels and order, editor variables', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-merge-queue-hooks-'),
  );
  seedMergeQueueHooks(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const section = await hooksSection(window);
    await expect(
      section.getByText('Web App — PR Removed From Merge Queue', {
        exact: true,
      }),
    ).toBeVisible();

    const apiGroupButton = section.getByRole('button', {
      name: /^API Service/,
    });
    await expect(apiGroupButton).toContainText('3 hooks');
    if ((await apiGroupButton.getAttribute('aria-expanded')) !== 'true') {
      await apiGroupButton.click();
    }
    await expect(apiGroupButton).toHaveAttribute('aria-expanded', 'true');
    const apiEntries = apiGroupButton
      .locator('xpath=..')
      .getByTestId('activity-hooks-entry');
    await expect(apiEntries).toHaveCount(3);
    expect(await entryLabels(apiEntries)).toEqual([
      'PR Merge Conflicts Detected',
      'PR Removed From Merge Queue',
      'PR Entered Merge Queue',
    ]);

    // The project settings control moves to the section header when this is
    // the only visible project. Hover the visible header to reveal its controls.
    const settingsButton = app.workspaceSettingsButton(WORKSPACE_NAME).or(
      window.getByRole('button', {
        name: `Project settings for ${WORKSPACE_NAME}`,
        exact: true,
      }),
    );
    await (await revealRowActions(window, settingsButton)).click();
    const settings = window.getByRole('dialog', { name: WORKSPACE_NAME });
    await expect(settings).toBeVisible();
    await settings.getByRole('tab', { name: 'Hooks' }).click();
    const localOverride = settings.getByRole('button', {
      name: 'Local override',
      exact: true,
    });
    if (await localOverride.count()) await localOverride.click();

    for (const command of [
      COMMANDS.webQueueRemoved,
      COMMANDS.apiQueueRemoved,
      COMMANDS.apiQueueEntered,
    ]) {
      const names = await insertVariableNames(window, settings, command);
      expect(names).toContain('PR_URL');
      expect(names).toContain('PR_QUEUE_ENTRY_ID');
      expect(names).toContain('PR_QUEUE_REMOVAL_REASON');
    }
    const conflictNames = await insertVariableNames(
      window,
      settings,
      COMMANDS.apiMergeConflicts,
    );
    expect(conflictNames).toContain('PR_URL');
    expect(conflictNames).not.toContain('PR_QUEUE_ENTRY_ID');
    expect(conflictNames).not.toContain('PR_QUEUE_REMOVAL_REASON');

    await settings.getByRole('button', { name: 'Close' }).click();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
