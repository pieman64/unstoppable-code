import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { cursorRuntimeFixture } from './fixtures/cursor-runtime.mjs';
import { expectCursorConnected } from './fixtures/cursor-tile.mjs';

// App Advisor chats on the Cursor harness
// (docs/planning/2026-09-24-cursor-app-advisor). The managed runtime is the
// deterministic ACP fixture served through the real installer; no live Cursor
// binary or network is involved.

const live = Boolean(process.env.CURSOR_CHAT_LIVE_BINARY);

/** The first per-chat Cursor profile created under any App Advisor entry. */
function advisorCursorProfileDir(userDataDir) {
  const root = path.join(
    userDataDir,
    'app-workspaces',
    'app-advisor',
    'worktree-data',
  );
  if (!existsSync(root)) return undefined;
  for (const entry of readdirSync(root)) {
    const sessions = path.join(root, entry, 'cursor-sessions');
    if (!existsSync(sessions)) continue;
    const [profile] = readdirSync(sessions);
    if (profile) return path.join(sessions, profile);
  }
  return undefined;
}

test('App Advisor runs a Cursor chat with App Advisor tools behind the approval card', async () => {
  test.skip(live, 'Deterministic managed-runtime regression');
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'app-advisor-cursor-'),
  );
  const managed = await cursorRuntimeFixture();
  const launched = await launchCanopy({ userDataDir, env: managed.env });
  try {
    const window = await launched.electronApp.firstWindow();
    const driver = new CanopyAppDriver(window);
    await driver.waitForShell({ timeout: 30_000 });
    await driver.openSettings();
    await driver.openSettingsSection('experiments');
    await window.getByTestId('cursor-connect').click();
    await expectCursorConnected(window);
    await driver.closeSettings();

    const advisor = await driver.openAppAdvisorWindow(launched.electronApp);
    // Keep the full composer toolbar mounted so the model picker is reachable
    // regardless of the compact width an isolated profile starts with.
    await advisor.setViewportSize({ width: 1_200, height: 800 });
    const composer = advisor.getByRole('textbox').first();
    await expect(composer).toBeVisible({ timeout: 30_000 });
    const picker = advisor
      .locator('[data-testid="chat-model-picker"]:visible')
      .first();
    await picker.click();
    // Before this change the App Advisor picker never offered Cursor.
    await advisor.getByTestId('chat-model-option-cursor-default').click();
    await expect(
      picker.getByTestId('chat-model-picker-provider-icon'),
    ).toHaveAttribute('data-provider', 'cursor');
    // New chats start in Full Access (CAN-3055); pick Ask so the App Advisor
    // tool calls below raise the shared approval card.
    const approvalPicker = advisor
      .locator('[data-testid="approval-mode-picker"]:visible')
      .first();
    await approvalPicker.click();
    await advisor.getByTestId('approval-mode-option-ask').click();
    await expect(approvalPicker).toHaveAttribute(
      'aria-label',
      'Tool approval mode, current mode Ask',
    );

    await composer.fill(
      'CURSOR_CHAT_E2E_MCP_ADVISOR: Read the current UI state, then open Settings.',
    );
    await advisor
      .getByRole('button', { name: 'Send message', exact: true })
      .click();

    // GetCurrentUiState prompts through the shared card in Ask mode. Allowing
    // it must run the tool exactly once: the proxy gate has to recognize the
    // allowance the ACP permission recorded, or a second card would appear.
    const card = advisor.getByTestId('tool-approval-card');
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card).toContainText('Cursor wants to use GetCurrentUiState');
    await card.getByTestId('tool-approval-allow').click();
    await expect(advisor.locator('body')).toContainText('MCP_RESULT:', {
      timeout: 20_000,
    });

    // DispatchAction prompts next; denying it means the action never runs.
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card).toContainText('Cursor wants to use DispatchAction');
    await card.getByTestId('tool-approval-deny').click();
    await expect(card).toHaveCount(0);
    await expect(advisor.locator('body')).toContainText('MCP tool denied.', {
      timeout: 20_000,
    });
    await expect(
      advisor.getByRole('button', { name: 'Stop generation', exact: true }),
    ).toHaveCount(0, { timeout: 20_000 });
    // The denied action would have opened Settings in the main window; the
    // overlay stays mounted after the test's own close, so check visibility.
    await expect(window.getByTestId('settings-overlay')).toBeHidden();

    // The App Advisor tool call renders through the same display path as a
    // Claude App Advisor chat (raw name folded to the Claude MCP name).
    await advisor.getByRole('button', { name: /^Agent steps:/ }).click();
    await expect(
      advisor
        .locator(
          '[data-tool-name="mcp__canopy_app_advisor__GetCurrentUiState"]',
        )
        .first(),
    ).toBeVisible();

    const profile = advisorCursorProfileDir(userDataDir);
    if (!profile)
      throw new Error(
        'Cursor profile was not created under the App Advisor entry',
      );
    const servers = JSON.parse(
      readFileSync(path.join(profile, 'fixture-mcp-servers.json'), 'utf8'),
    );
    expect(servers.map((server) => server.name)).toEqual([
      'canopy_app_advisor',
      'canopy_ui',
    ]);
    const prompt = readFileSync(
      path.join(profile, 'fixture-prompt.txt'),
      'utf8',
    );
    expect(prompt).toContain(
      'MCP tools on the canopy_app_advisor and canopy_ui servers',
    );
    expect(prompt).not.toContain('Use GetScriptOutput to inspect setup');
  } finally {
    await closeCanopy(launched.electronApp, launched.userDataDir);
    await managed.close();
  }
});
