// GitHub pull request watchers from a Cowork chat (CAN-3785). Two chats share
// one Work Entry; chat A watches a PR on the GraphQL mock and only A wakes
// when it merges. The Cowork folder is not a git checkout, so a bare PR number
// needs an explicit repository. The PR observer's first read is due 45 s ±20%
// after the subscription appears; waits are sized for that cadence.

import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import {
  cleanupDemoWorkspaces,
  seedDemoWorkspaces,
} from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';
import { writeJson } from './seeders/fsHelpers.mjs';
import { DEFAULT_MOCK_BASE_URL, registerScenario } from './seeders/index.mjs';

const COWORK_WORKSPACE_ID = 'github-watcher-cowork';
const COWORK_ENTRY_ID = 'github-watcher-entry';
const CHAT_A = 'cowork-pr-watcher-a';
const CHAT_B = 'cowork-pr-watcher-b';
const REPOSITORY = 'acme/api';
const PR_NUMBER = 7;
const GH_TOKEN = 'ghp_e2e_cowork_pr_watcher';
const MARKER = 'Canopy-CCOWORKPRWATCHER';
const OBSERVATION_TIMEOUT_MS = 90_000;
const SEEDED_AT = '2026-10-07T10:00:00.000Z';

function seedCoworkChats(userDataDir) {
  const workspacesRoot = path.join(userDataDir, 'workspaces');
  const indexPath = path.join(workspacesRoot, 'index.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  const collectionKey = Array.isArray(index.items) ? 'items' : 'workspaces';
  index[collectionKey].push({
    id: COWORK_WORKSPACE_ID,
    name: 'GitHub Watcher Cowork',
    type: 'cowork',
    color: '#7C9B6D',
    collapsed: false,
    order: index[collectionKey].length,
    cowork: { createdAt: SEEDED_AT, archiveRetentionDays: null },
  });
  writeJson(indexPath, index);

  const workspaceDir = path.join(workspacesRoot, COWORK_WORKSPACE_ID);
  mkdirSync(path.join(workspaceDir, 'home'), { recursive: true });
  writeJson(path.join(workspaceDir, 'workspace.json'), {
    version: 1,
    type: 'cowork',
    cowork: {
      createdAt: SEEDED_AT,
      defaultModel: 'claude-sonnet-4-6',
      searchIndexingEnabled: false,
      archiveRetentionDays: null,
    },
  });
  writeJson(path.join(workspaceDir, 'work-entries.json'), {
    version: 1,
    entries: [{ id: COWORK_ENTRY_ID, createdAt: SEEDED_AT }],
  });
  const tab = (id, title) => ({
    id,
    title,
    createdAt: SEEDED_AT,
    kind: 'chat',
    providerType: 'claude',
    model: 'claude-sonnet-4-6',
    // Tool calls must not stop for an approval decision.
    approvalMode: 'full-access',
    // The sidebar lists a work entry only once one of its chats has messages.
    messages: [
      {
        id: `${id}-seed-user`,
        role: 'user',
        blocks: [{ type: 'text', text: `Open ${title}.` }],
        timestamp: Date.parse(SEEDED_AT),
      },
      {
        id: `${id}-seed-assistant`,
        role: 'assistant',
        blocks: [{ type: 'text', text: 'Ready.' }],
        timestamp: Date.parse(SEEDED_AT) + 1_000,
      },
    ],
  });
  writeJson(path.join(workspaceDir, 'chats', `${COWORK_ENTRY_ID}.json`), {
    version: 1,
    activeTabId: CHAT_A,
    tabs: [tab(CHAT_A, 'Pull request watcher'), tab(CHAT_B, 'Bystander')],
  });
}

async function setGithubScenario(github) {
  const response = await fetch(`${DEFAULT_MOCK_BASE_URL}/__mock/state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: GH_TOKEN, scenario: { github } }),
  });
  expect(response.ok).toBe(true);
}

async function clearScenario(key) {
  await fetch(
    `${DEFAULT_MOCK_BASE_URL}/__mock/state/${encodeURIComponent(key)}`,
    { method: 'DELETE' },
  ).catch(() => undefined);
}

function pullRequestWatchers(userDataDir) {
  try {
    return JSON.parse(
      readFileSync(path.join(userDataDir, 'app-advisor-watchers.json'), 'utf8'),
    ).watchers.filter(
      (entry) => entry.trigger === 'github_pull_requests_changed',
    );
  } catch {
    return [];
  }
}

/** Every WatchGitHubItems result in chat A's Cowork transcript, in call order. */
function readWatchToolResults(userDataDir) {
  let raw;
  try {
    raw = readFileSync(
      path.join(
        userDataDir,
        'workspaces',
        COWORK_WORKSPACE_ID,
        'chat-storage-v2',
        COWORK_ENTRY_ID,
        'transcripts',
        `${CHAT_A}.jsonl`,
      ),
      'utf8',
    );
  } catch {
    return [];
  }
  const blocks = raw
    .trim()
    .split('\n')
    .flatMap((line) => JSON.parse(line).blocks ?? []);
  return blocks
    .filter(
      (block) =>
        block.type === 'tool_use' &&
        String(block.toolName).includes('WatchGitHubItems'),
    )
    .map((call) =>
      blocks.find(
        (block) =>
          block.type === 'tool_result' && block.toolUseId === call.toolUseId,
      ),
    )
    .filter(Boolean);
}

function toolResultPayload(result) {
  const output = Array.isArray(result.output)
    ? result.output
        .map((part) => (typeof part === 'string' ? part : (part?.text ?? '')))
        .join('')
    : result.output;
  return typeof output === 'string' ? JSON.parse(output) : output;
}

/** Record every watcher message the renderer sends to main, unchanged. */
async function recordWatcherSends(electronApp) {
  await electronApp.evaluate(({ ipcMain }) => {
    const channel = 'chat:send-message';
    const original = ipcMain._invokeHandlers?.get(channel);
    if (typeof original !== 'function') {
      throw new Error(`Expected a registered ${channel} handler`);
    }
    globalThis.__coworkPrWatcherSends = [];
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, (event, request, ...rest) => {
      if (request?.watcherFired) {
        globalThis.__coworkPrWatcherSends.push({
          projectId: request.projectId,
          worktreeId: request.worktreeId,
          chatId: request.chatId,
          text: request.text,
        });
      }
      return original(event, request, ...rest);
    });
  });
}

async function watcherSends(electronApp) {
  return electronApp.evaluate(() => globalThis.__coworkPrWatcherSends ?? []);
}

async function attachDiagnostics(testInfo, userDataDir) {
  for (const relative of ['app-advisor-watchers.json', 'logs/main.log']) {
    try {
      await testInfo.attach(relative.replaceAll('/', '-'), {
        body: readFileSync(path.join(userDataDir, relative)),
        contentType: 'text/plain',
      });
    } catch {
      /* Missing diagnostics do not replace the assertion. */
    }
  }
}

test.afterEach(async () => {
  await Promise.all([clearScenario(GH_TOKEN), clearScenario(MARKER)]);
});

test('a Cowork chat watches a pull request by repository and only that chat wakes on merge', async ({}, testInfo) => {
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-cowork-pr-watcher-'),
  );
  const demo = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedCoworkChats(userDataDir);
  const open = { baseRefName: 'develop', headRefOid: '1'.repeat(40) };
  const mergeSha = '2'.repeat(40);
  await setGithubScenario({
    pullRequests: { [`${REPOSITORY}/${PR_NUMBER}`]: open },
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, MARKER, {
    llm: {
      steps: [
        {
          toolCalls: [
            {
              id: 'watch-bare-number',
              name: 'mcp__canopy__WatchGitHubItems',
              input: { items: [{ kind: 'pull_request', number: PR_NUMBER }] },
            },
          ],
          stopReason: 'tool_use',
        },
        {
          toolCalls: [
            {
              id: 'watch-with-repository',
              name: 'mcp__canopy__WatchGitHubItems',
              input: {
                items: [
                  {
                    kind: 'pull_request',
                    repository: REPOSITORY,
                    number: PR_NUMBER,
                  },
                ],
              },
            },
          ],
          stopReason: 'tool_use',
        },
        { text: 'Watching the pull request', stopReason: 'end_turn' },
        { text: 'Pull request merge acknowledged', stopReason: 'end_turn' },
      ],
    },
  });

  let electronApp;
  try {
    ({ electronApp } = await withBundledBinaryOverridesScrubbed(() =>
      launchCanopy({ userDataDir, env: { GH_TOKEN } }),
    ));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await recordWatcherSends(electronApp);
    await app.openMainPage();
    const toggle = window.getByTestId(
      `sidebar-cowork-project-${COWORK_WORKSPACE_ID}-toggle`,
    );
    if ((await toggle.getAttribute('aria-expanded')) !== 'true')
      await toggle.click();
    await window.getByTestId(`sidebar-work-entry-${COWORK_ENTRY_ID}`).click();
    const panel = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${CHAT_A}"]`,
    );
    await expect(panel).toBeVisible();
    const composer = panel.getByRole('textbox').first();
    await composer.fill(`[${MARKER}] Tell me when ${REPOSITORY}#7 lands.`);
    await panel.getByRole('button', { name: 'Send message' }).click();
    await expect(
      panel.getByText('Watching the pull request').first(),
    ).toBeVisible({ timeout: 90_000 });

    await expect
      .poll(() => readWatchToolResults(userDataDir).length, {
        timeout: 30_000,
      })
      .toBe(2);
    const [bare, explicit] = readWatchToolResults(userDataDir);
    expect(bare.isError).toBe(true);
    expect(toolResultPayload(bare)).toMatchObject({
      ok: false,
      code: 'repository_required',
      message: expect.stringContaining('Add repository'),
    });
    expect(explicit.isError).not.toBe(true);
    expect(toolResultPayload(explicit)).toMatchObject({
      ok: true,
      status: 'created',
      itemCount: 1,
    });

    const [watcher] = pullRequestWatchers(userDataDir);
    expect(pullRequestWatchers(userDataDir)).toHaveLength(1);
    expect(watcher).toMatchObject({
      status: 'active',
      destination: {
        projectId: COWORK_WORKSPACE_ID,
        worktreeId: COWORK_ENTRY_ID,
        chatId: CHAT_A,
      },
      target: {
        items: [
          { kind: 'pull_request', repository: REPOSITORY, number: PR_NUMBER },
        ],
      },
    });

    const watchersButton = panel.getByTestId(`chat-input-watchers-${CHAT_A}`);
    await expect(watchersButton).toBeVisible();
    await watchersButton.click();
    const modal = window.getByTestId('watcher-management-modal');
    await expect(modal).toContainText(`${REPOSITORY}#${PR_NUMBER}`);
    await modal.getByRole('button', { name: 'Close' }).click();

    await setGithubScenario({
      pullRequests: {
        [`${REPOSITORY}/${PR_NUMBER}`]: {
          ...open,
          state: 'MERGED',
          mergeCommit: { oid: mergeSha },
        },
      },
    });
    await expect
      .poll(async () => (await watcherSends(electronApp)).length, {
        timeout: OBSERVATION_TIMEOUT_MS,
      })
      .toBeGreaterThanOrEqual(1);
    const [send] = await watcherSends(electronApp);
    expect(send).toMatchObject({
      projectId: COWORK_WORKSPACE_ID,
      worktreeId: COWORK_ENTRY_ID,
      chatId: CHAT_A,
    });
    expect(send.text).toContain(
      `${REPOSITORY}#${PR_NUMBER} merged into develop`,
    );
    await expect(panel.getByTestId('watcher-fired-title')).toHaveCount(1, {
      timeout: 30_000,
    });
    await expect(
      panel.getByText('Pull request merge acknowledged').first(),
    ).toBeVisible({ timeout: 90_000 });
    await expect
      .poll(() => pullRequestWatchers(userDataDir)[0]?.status, {
        timeout: 30_000,
      })
      .toBe('fired');
    expect(
      (await watcherSends(electronApp)).map((entry) => entry.chatId),
    ).toEqual([CHAT_A]);
  } catch (error) {
    await attachDiagnostics(testInfo, userDataDir);
    throw error;
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(demo);
  }
});
