// CAN-2339 round-4 F4: the hook chat-action editor resolves pipeline model
// aliases (`$default-codex`) before deriving the provider, the model-picker
// display, and the thinking-level validation (`HookActionEditor`).
//
// The seeded hook names `$default-codex` (→ `gpt-6.1-sol`) with
// `thinkingLevel: 'max'`, which the model supports. Without alias
// resolution the editor sees an unknown model: the picker would render the raw
// alias id and the provider hint would fall back to Claude. The thinking
// control must then cycle against the resolved model's supported set, so the
// stored `max` value displays as `Max` and advances to `Ultra`.
//
//   pnpm run test:electron:built hook-action-model-alias.spec.mjs --reporter=line

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver, revealRowActions } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const WORKSPACE_ID = 'demo-multi-repo-fullstack';
const WORKSPACE_NAME = 'Multi Repo Fullstack';
const HOOK_PROMPT = 'Review the new PR for alias-resolved model handling.';

function seedAliasChatHook(userDataDir) {
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
  const webRepo = config.repos.find((repo) => repo.id === 'web');
  if (!webRepo) throw new Error('Missing web repo in seeded project');
  webRepo.hooks = {
    'pr:create': [
      {
        type: 'chat',
        prompt: HOOK_PROMPT,
        model: '$default-codex',
        modelConfig: { thinkingLevel: 'max' },
      },
    ],
  };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

test('hook chat action editor resolves a pipeline model alias for display and thinking controls', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-hook-model-alias-'),
  );
  seedAliasChatHook(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    // Wait for the regular sidebar row; the temporary sole-project settings
    // action can detach during startup. Hover to reveal its settings button.
    const settingsButton = app.workspaceSettingsButton(WORKSPACE_NAME);
    await expect(settingsButton).toBeAttached();
    await (await revealRowActions(window, settingsButton)).click();
    const settings = window.getByRole('dialog', { name: WORKSPACE_NAME });
    await expect(settings).toBeVisible({ timeout: 15_000 });
    await settings.getByRole('tab', { name: 'Hooks' }).click();

    // Scope to the chat-action editor card that owns the seeded prompt.
    const prompt = settings
      .locator('[data-testid^="hook-chat-"][contenteditable="true"]')
      .filter({ hasText: HOOK_PROMPT });
    await expect(prompt).toHaveCount(1);
    const editor = prompt.locator(
      'xpath=ancestor::div[contains(@class,"rounded-lg") and contains(@class,"bg-card")][1]',
    );

    // The picker shows the alias target (`gpt-6.1-sol`) with its Codex
    // provider identity, not the raw `$default-codex` id.
    const picker = editor.getByTestId('chat-model-picker');
    await expect(picker).toBeVisible();
    await expect(picker).toContainText('GPT 6.1 Sol');
    await expect(picker).not.toContainText('$default-codex');
    await expect(
      picker.getByTestId('chat-model-picker-provider-icon'),
    ).toHaveAttribute('data-provider', 'codex');

    // The stored Max level displays unchanged for the resolved model.
    const thinking = editor.locator('button[aria-label^="Thinking: "]');
    await expect(thinking).toHaveAttribute(
      'aria-label',
      'Thinking: Max; click to cycle',
    );

    // The control cycles against the resolved model's full supported set:
    // GPT 6.1 Sol supports Ultra after Max.
    await thinking.click();
    await expect(thinking).toHaveAttribute(
      'aria-label',
      'Thinking: Ultra; click to cycle',
    );
    // An explicit hook model can be cleared back to the workspace default.
    await picker.click();
    const modelMenu = window.getByTestId('chat-model-menu');
    const defaultRow = modelMenu.getByRole('menuitemradio', {
      name: 'Project default',
      exact: true,
    });
    await expect(defaultRow).toBeVisible();
    await defaultRow.click();
    await expect(modelMenu).toBeHidden();
    await expect(picker).toContainText('Opus 5.5');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
