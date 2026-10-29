// ---------------------------------------------------------------------------
// Pull request cards (Labs, off by default): a GitHub pull request reference's
// hover card. Off keeps the classic card (label and title, body excerpt,
// facts line) on the tooltip surface. On, the card leads with the status as a
// colored glyph and label, then the title, then the author's avatar with the
// size of change, on the sidebar worktree card's surface. Turning it off brings
// the classic card back without a restart.
//
// The pull request facts come through the real main reader against the shared
// GitHub mock: the issue read, `GET .../pulls/:n` for the size and the PR
// status GraphQL query for mergeability. Avatars are answered offline.
// ---------------------------------------------------------------------------
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { stubGitHubAvatars } from './githubAvatarStub.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedWorktreeChat,
} from './seeders/index.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CHAT_ID = 'pr-hover-cards-chat';
const TOKEN = 'ghp_e2e_pr_hover_cards';
const ORIGIN_URL = 'https://github.com/acme/app.git';
const AVATAR_URL = 'https://avatars.githubusercontent.com/u/583231.png?v=4';

const CONFLICT_TITLE = 'Change a worktree branch from the header';
const MERGED_TITLE = 'Open app links in the built-in browser';
const TEXT = 'Conflicting #7 and merged #8 are both ours.';

function pullIssue(number, title, mergedAt) {
  return {
    number,
    title,
    state: mergedAt ? 'closed' : 'open',
    html_url: `https://github.com/acme/app/pull/${number}`,
    updated_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    user: { login: 'octocat', avatar_url: AVATAR_URL },
    body: 'Background: the header picks the branch.',
    draft: false,
    pull_request: { merged_at: mergedAt },
  };
}

function pull(number, size) {
  return {
    number,
    html_url: `https://github.com/acme/app/pull/${number}`,
    state: 'open',
    head: { ref: `feature-${number}`, sha: 'b'.repeat(40) },
    base: { ref: 'main', repo: { full_name: 'acme/app' } },
    ...size,
  };
}

const SCENARIO = {
  github: {
    issues: {
      'acme/app/7': pullIssue(7, CONFLICT_TITLE, null),
      'acme/app/8': pullIssue(8, MERGED_TITLE, '2026-10-01T09:00:00Z'),
    },
    pulls: [
      pull(7, { additions: 2674, deletions: 963, changed_files: 42 }),
      pull(8, { additions: 12, deletions: 3, changed_files: 1 }),
    ],
    pullRequests: {
      'acme/app/7': { mergeable: 'CONFLICTING' },
      'acme/app/8': { state: 'MERGED', mergeable: 'UNKNOWN' },
    },
  },
};

const git = (args) => execFileSync('/usr/bin/git', args, { stdio: 'pipe' });

function seed(userDataDir) {
  const summary = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const repoPath = summary.workspaces[0].worktreePath;
  // `origin` names the repository bare `#N` resolves in; the dead proxy keeps
  // any background fetch off the network.
  git(['-C', repoPath, 'remote', 'add', 'origin', ORIGIN_URL]);
  git(['-C', repoPath, 'config', 'http.proxy', 'http://127.0.0.1:9']);
  const worktreeDataDir = path.join(
    userDataDir,
    'workspaces',
    WORKSPACE_ID,
    'worktree-data',
    WORKTREE_ID,
  );
  mkdirSync(worktreeDataDir, { recursive: true });
  writeFileSync(
    path.join(worktreeDataDir, 'panel-layout-mode.json'),
    JSON.stringify({ version: 1, mode: 'advanced' }),
  );
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: CHAT_ID,
    tabs: [
      {
        id: CHAT_ID,
        title: 'Pull request cards',
        messages: [
          {
            id: `${CHAT_ID}-user`,
            role: 'user',
            blocks: [{ type: 'text', text: 'Which pull requests?' }],
            timestamp: Date.parse('2026-10-01T10:00:00.000Z'),
          },
          {
            id: `${CHAT_ID}-assistant`,
            role: 'assistant',
            blocks: [{ type: 'text', text: TEXT }],
            timestamp: Date.parse('2026-10-01T10:00:05.000Z'),
          },
        ],
      },
    ],
  });
}

// Main falls back to `gh auth token` without a PAT; an unknown default host
// keeps that fallback empty.
function isolatedGhEnv(root) {
  const ghConfigDir = path.join(root, 'gh-config');
  mkdirSync(ghConfigDir, { recursive: true });
  return { GH_CONFIG_DIR: ghConfigDir, GH_HOST: 'github.e2e.invalid' };
}

async function setGitHubPat(window, app, token) {
  await window.evaluate(() =>
    window.api.savePreferences({ githubChatEnrichmentMode: 'replace' }),
  );
  await app.openSettings();
  await app.openAccountSettingsPage('integrations');
  await window
    .getByTestId('auth-panel-github')
    .getByRole('button', { name: 'Personal Access Token' })
    .click();
  await window.getByTestId('auth-panel-github-pat-input').fill(token);
  await expect
    .poll(() => window.evaluate(() => window.api.loadGitHubPat()), {
      timeout: 10_000,
    })
    .toBe(token);
  await app.closeSettings();
}

test('Pull request cards changes the PR hover card and follows its Labs switch', async () => {
  test.setTimeout(240_000);
  const root = mkdtempSync(path.join(os.tmpdir(), 'canopy-pr-hover-cards-'));
  const userDataDir = path.join(root, 'data');
  mkdirSync(userDataDir);
  seed(userDataDir);
  await registerScenario(DEFAULT_MOCK_BASE_URL, TOKEN, SCENARIO);
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: isolatedGhEnv(root),
  });
  try {
    const window = await electronApp.firstWindow();
    const avatars = await stubGitHubAvatars(window, 'png');
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    const enabled = () =>
      window.evaluate(async () => {
        const snapshot = await window.api.experiments.getSnapshot();
        return snapshot.experiments.find(
          (entry) => entry.id === 'pr-hover-cards',
        )?.enabled;
      });
    expect(await enabled()).toBe(false);

    await setGitHubPat(window, app, TOKEN);

    const openChat = async () => {
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_ID);
      await window.getByTestId(`panel-tab-panel-chat-${CHAT_ID}`).click();
      const chat = window.locator(
        `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${CHAT_ID}"]`,
      );
      await expect(chat).toBeVisible();
      return chat;
    };
    const setSwitch = async (on) => {
      await app.openSettings();
      await app.openSettingsSection('experiments');
      const toggle = window.getByTestId(
        'labs-experiment-toggle-pr-hover-cards',
      );
      await toggle.scrollIntoViewIfNeeded();
      await expect(toggle).toHaveAttribute('aria-checked', String(!on));
      await toggle.click();
      await expect.poll(enabled).toBe(on);
      await app.closeSettings();
    };
    // Rest on a reference until its card opens; move away to close it.
    const hoverCard = async (chat, index) => {
      await window.mouse.move(0, 0);
      await expect(window.locator('[role="tooltip"]')).toHaveCount(0);
      await chat.getByTestId('github-reference').nth(index).hover();
      const tooltip = window.locator('[role="tooltip"]', {
        has: window.getByTestId('github-reference-preview-card'),
      });
      await expect(tooltip).toBeVisible();
      return tooltip;
    };

    // ── Off: the classic card on the tooltip surface ─────────────────────────
    let chat = await openChat();
    const references = chat.getByTestId('github-reference');
    await expect(references).toHaveText([
      `#7: ${CONFLICT_TITLE}`,
      `#8: ${MERGED_TITLE}`,
    ]);
    let tooltip = await hoverCard(chat, 0);
    let card = tooltip.getByTestId('github-reference-preview-card');
    await expect(card).not.toHaveAttribute('data-layout', 'status');
    await expect(card).toContainText('Pull request · Open · by octocat');
    await expect(tooltip).toHaveClass(/shadow-tooltip/);

    // ── On: status, title, author and size on the preview card surface ──────
    await setSwitch(true);
    chat = await openChat();
    tooltip = await hoverCard(chat, 0);
    card = tooltip.getByTestId('github-reference-preview-card');
    await expect(card).toHaveAttribute('data-layout', 'status');
    const status = card.getByTestId('github-reference-preview-status');
    await expect(status).toHaveText('Merge conflicts');
    await expect(status).toHaveAttribute('data-status', 'merge-conflict');
    await expect(status.locator('svg')).toHaveAttribute('data-glyph', 'alert');
    await expect(
      card.getByTestId('github-reference-preview-repository'),
    ).toHaveText('app');
    await expect(card).toContainText('#7');
    await expect(card).toContainText(CONFLICT_TITLE);
    await expect(card.getByTestId('github-reference-preview-diff')).toHaveText(
      '+2,674-963',
    );
    await expect(card.getByTestId('github-reference-preview-files')).toHaveText(
      '42 files',
    );
    await expect(card.locator('img')).toHaveAttribute('src', AVATAR_URL);
    expect(avatars).toContain(AVATAR_URL);
    await expect(tooltip).toHaveClass(/rounded-lg/);
    await expect(tooltip).toHaveClass(/shadow-xl/);

    tooltip = await hoverCard(chat, 1);
    card = tooltip.getByTestId('github-reference-preview-card');
    await expect(
      card.getByTestId('github-reference-preview-status'),
    ).toHaveText('Merged');
    await expect(card.getByTestId('github-reference-preview-files')).toHaveText(
      '1 file',
    );

    // ── Off again: the classic card returns without a restart ────────────────
    await setSwitch(false);
    chat = await openChat();
    tooltip = await hoverCard(chat, 0);
    await expect(
      tooltip.getByTestId('github-reference-preview-card'),
    ).not.toHaveAttribute('data-layout', 'status');
    await expect(tooltip).toHaveClass(/shadow-tooltip/);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    rmSync(root, { recursive: true, force: true });
  }
});
