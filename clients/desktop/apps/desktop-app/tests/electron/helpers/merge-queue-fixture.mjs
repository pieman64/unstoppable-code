import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CanopyAppDriver } from '../canopyApp.mjs';
import { seedDemoWorkspaces } from '../demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from '../launchCanopy.mjs';
import { readChatStorageTabs } from '../readChatStorage.mjs';
import {
  clearScenario,
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  writeJson,
} from '../seeders/index.mjs';
import { saveGitHubPat } from './github-pat.mjs';

export const WORKSPACE_ID = 'demo-ts-pnpm-vite';
export const WORKTREE_ID = 'demo-main';
export const PR_URL = 'https://github.com/canopy-e2e/ts-pnpm-vite/pull/101';

export async function githubScenario(token) {
  const response = await fetch(
    `${DEFAULT_MOCK_BASE_URL}/__mock/state/${encodeURIComponent(token)}`,
  );
  if (!response.ok) throw new Error(`Scenario read failed: ${response.status}`);
  return (await response.json()).scenario.github;
}

export function queueTab(userDataDir) {
  try {
    return readChatStorageTabs(
      path.join(userDataDir, 'workspaces', WORKSPACE_ID),
      WORKTREE_ID,
    ).tabs.find((tab) =>
      tab.messages.some((message) =>
        message.blocks?.some(
          (block) =>
            block.type === 'builtin_gh_chat_info' &&
            block.kind === 'merge_queue',
        ),
      ),
    );
  } catch {
    return undefined;
  }
}

async function clearMergeScenario(token) {
  // Closing a provider can race an idle control-plane socket. Deletion is
  // idempotent; retry transport failures without hiding HTTP/schema errors.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await clearScenario(DEFAULT_MOCK_BASE_URL, token);
      break;
    } catch (error) {
      if (!(error instanceof TypeError) || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

// Uses real poller/IPC/launcher and loopback provider/GitHub fixtures. No IPC
// merge replacement, live agent, git push or live GitHub mutation; enqueues
// only reach the loopback fixture. `mergeQueueAgentHandling` seeds the
// Settings > Git merge queue choice (omitted: the product default).
export async function openMergeFixture({
  provider = 'claude',
  queue = true,
  mergeQueueAgentHandling,
  env,
}) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-merge-queue-'),
  );
  const token = `ghp_e2e_merge_queue_${path.basename(userDataDir)}`;
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  writeJson(path.join(userDataDir, 'preferences.json'), {
    version: 1,
    preferences: {
      onboardingCompleted: ['v1'],
      legalConsentAcceptedAt: '2026-07-06T00:00:00.000Z',
      legalConsentTosVersion: '2026-07-06',
      defaultWorktreeProvider: provider,
      defaultChatProvider: provider,
      defaultChatInterfaceMode: 'canopy',
      defaultWorktreeModelByProvider: {
        claude: { model: 'claude-haiku-4-5-20251001', thinkingLevel: 'off' },
        codex: { model: 'gpt-5.4', thinkingLevel: 'medium' },
      },
      approvalDefaults: { worktree: 'auto', cowork: 'ask', appAdvisor: 'ask' },
      ...(mergeQueueAgentHandling ? { mergeQueueAgentHandling } : {}),
    },
  });
  writeJson(path.join(userDataDir, 'migrations.json'), {
    version: 1,
    approval_defaults_full_access: true,
  });
  execFileSync('git', [
    '-C',
    path.join(
      userDataDir,
      'workspaces',
      WORKSPACE_ID,
      'worktrees',
      WORKTREE_ID,
    ),
    'remote',
    'add',
    'origin',
    'https://github.com/canopy-e2e/ts-pnpm-vite.git',
  ]);
  await registerScenario(DEFAULT_MOCK_BASE_URL, token, {
    github: {
      variant: 'open-pr',
      graphqlPullRequests: {
        101: { isMergeQueueEnabled: queue, isInMergeQueue: false },
      },
      mergeRequests: [],
    },
  });
  let electronApp;
  const cleanup = async () => {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearMergeScenario(token);
    }
  };
  try {
    ({ electronApp } = await launchCanopy({ userDataDir, env }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await saveGitHubPat(window, app, token);
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    return { electronApp, window, app, userDataDir, token, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
