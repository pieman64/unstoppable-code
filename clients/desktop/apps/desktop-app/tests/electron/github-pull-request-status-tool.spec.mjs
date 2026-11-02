// Electron E2E — CAN-4036 GetGitHubPullRequestStatus transcript rows.
//
// Agents read a pull request's cached status with the injected
// GetGitHubPullRequestStatus tool. The shared `@canopy/ui-shared` tool display
// labels the call "Read pull request status acme/api#7" under its Claude MCP
// name and its Codex name alike; the Portal spec
// `portal/portal-pr-watcher-tool-card.spec.mjs` pins the same wording in the
// browser.
//
// Deterministic: the transcripts are seeded on disk before Electron launches,
// and no agent turn or GitHub request runs.
//
//   pnpm run test:electron:built \
//     github-pull-request-status-tool.spec.mjs --reporter=line
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedWorktreeChat } from './seeders/seedWorktreeChat.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const PR_URL = 'https://github.com/acme/api/pull/7';
const BASE = Date.parse('2026-10-13T00:00:00.000Z');
const FINAL_ANSWER = 'Checks are still running on the pull request';

const SURFACES = [
  {
    chatId: 'can-4036-pr-status-claude',
    providerType: 'claude',
    toolName: 'mcp__canopy__GetGitHubPullRequestStatus',
  },
  {
    chatId: 'can-4036-pr-status-codex',
    providerType: 'codex',
    toolName: 'canopy_get_github_pull_request_status',
  },
];

function transcript(toolName) {
  const toolUseId = `can-4036-${toolName}`;
  return [
    {
      id: 'can-4036-user',
      role: 'user',
      blocks: [{ type: 'text', text: 'Is the pull request green yet?' }],
      timestamp: BASE,
    },
    {
      id: 'can-4036-status-call',
      role: 'assistant',
      blocks: [
        {
          type: 'tool_use',
          toolUseId,
          toolName,
          input: JSON.stringify({ pullRequest: PR_URL }),
        },
        {
          type: 'tool_result',
          toolUseId,
          toolName,
          output: JSON.stringify({
            ok: true,
            pullRequest: {
              repository: 'acme/api',
              number: 7,
              url: PR_URL,
              title: 'Add search',
              state: 'open',
              checks: { state: 'pending', total: 3, passed: 2, failed: 0 },
            },
          }),
          isError: false,
        },
      ],
      timestamp: BASE + 2_000,
    },
    {
      id: 'can-4036-answer',
      role: 'assistant',
      blocks: [{ type: 'text', text: `${FINAL_ANSWER}: 2 of 3 passed.` }],
      timestamp: BASE + 4_000,
    },
    {
      id: 'can-4036-timer',
      role: 'system',
      blocks: [
        { type: 'turn_timer', startedAt: BASE, completedAt: BASE + 5_000 },
      ],
      timestamp: BASE + 5_000,
    },
  ];
}

for (const surface of SURFACES) {
  test(`labels a ${surface.providerType} GetGitHubPullRequestStatus call as a pull request status read`, async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-pr-status-tool-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: surface.providerType,
      activeTabId: surface.chatId,
      tabs: [
        {
          id: surface.chatId,
          title: 'Pull request check',
          messages: transcript(surface.toolName),
        },
      ],
    });

    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      // Individual-step assertions use the Detailed preference.
      await window.evaluate(() =>
        window.api.savePreferences({ chatDetail: 'detailed' }),
      );
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_ID);

      const chatPanel = window.locator(
        `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${surface.chatId}"]`,
      );
      await expect(chatPanel).toBeVisible({ timeout: 30_000 });
      await expect(
        chatPanel.getByText(FINAL_ANSWER, { exact: false }),
      ).toBeVisible({ timeout: 30_000 });

      const statusCards = chatPanel.locator(
        `[data-testid="chat-tool-call"][data-tool-name="${surface.toolName}"]`,
      );
      // The completed turn folds its tool call behind a collapsed step row.
      const steps = chatPanel
        .locator('[data-chat-turn-group]')
        .filter({ hasText: FINAL_ANSWER })
        .locator('button[aria-expanded="false"]')
        .first();
      await expect(statusCards).toHaveCount(0);
      await steps.click();

      await expect(statusCards).toHaveCount(1);
      await expect(statusCards).toContainText('Read pull request status');
      await expect(statusCards).toContainText('acme/api#7');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}
