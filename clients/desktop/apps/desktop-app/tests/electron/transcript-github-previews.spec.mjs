// ---------------------------------------------------------------------------
// Transcript GitHub previews — inline titles and hover cards for references.
//
// Seeds settled chats that mention GitHub issues, pull requests and a
// repository in a worktree whose `origin` is github.com/acme/app, connects
// GitHub through the real Settings PAT field (and Linear as the Linear spec
// does) against the shared credential-keyed REST mock, and walks the flow with
// Early access off: bare `#N` resolves in the origin repository, qualified
// and URL references resolve their own, each identity makes one request, the
// visible title ends after five whole words, hover/focus/Escape/Enter/click
// behave, code is never decorated, and an inaccessible reference stays plain.
// Then: a reload paints cached titles while every GitHub read is held, the
// pending placeholder is reserved and static under reduced motion, a
// credential change mid-read purges GitHub titles without a stale one while
// Linear keeps its titles, and disconnecting removes every decoration.
// A second test checks that a cowork transcript leaves bare `#N` plain.
//
// The mock's reference holds (`/__mock/github/reference-holds/:key`) keep a
// read in flight without timing; scenario activity counts the reads.
//
// Visual evidence: pnpm run test:electron:captures:built transcript-github-previews.capture-spec.ts
// ---------------------------------------------------------------------------
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  getScenarioActivity,
  registerScenario,
  seedCoworkWorkspace,
  seedWorktreeChat,
} from './seeders/index.mjs';
import { expectWordCut, readTruncation } from './wordBoundaryTruncation.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CHAT_ID = 'github-previews-chat';
const SCOPE_CHAT_ID = 'github-previews-scope-chat';
const TOKEN_A = 'ghp_e2e_github_previews_a';
const TOKEN_B = 'ghp_e2e_github_previews_b';
const COWORK_TOKEN = 'ghp_e2e_github_previews_cowork';
const LINEAR_TOKEN = 'lin_api_e2e_github_previews';
const STORAGE_KEY = 'canopy.referencePreviews.v1';

const ORIGIN_URL = 'https://github.com/acme/app.git';
const PR_URL = 'https://github.com/acme/app/pull/7/files?w=1#diff-x';
const PR_CANONICAL = 'https://github.com/acme/app/pull/7';
const ISSUE_URL = 'https://github.com/acme/app/issues/55';
const REPO_URL = 'https://github.com/acme/app';
const LINK_ITEMS = ['Copy link', 'Open in browser', 'Open in external browser'];
// Copy selection follows the link section, disabled without a selection
// (CAN-4870).
const COPY_ITEMS = ['Copy selection'];

const TITLE_1234 = 'Show pull request titles in every chat transcript today';
const FIVE_WORDS_1234 = 'Show pull request titles in';
const TITLE_OTHER_1234 = 'Fix the flaky retry loop in the HTTP client';
const TITLE_7 = 'Hydrate GitHub references';
const TITLE_55 = 'Preview cards for issues';
const TITLE_90 = 'Draft the repository card';
const TITLE_3001_A = 'Stale title from the first credential';
const TITLE_3001_B = 'Fresh title for the new credential';
const LINEAR_TITLE = 'Keep Linear titles through GitHub changes';
const REPO_DESCRIPTION = Array.from(
  { length: 6 },
  () =>
    'The Acme app: desktop client, web portal, shared packages and release tooling.',
).join(' ');
// Main bounds a repository description to 280 code points, ending in "…".
const REPO_DESCRIPTION_BOUNDED = `${REPO_DESCRIPTION.slice(0, 279).trimEnd()}…`;

const MAIN_TEXT = [
  'Bare #1234 is ours, acme/app#1234 is the same issue, and other/lib#1234 is not.',
  '',
  `The PR ${PR_URL} merged; see [my explanation](${PR_CANONICAL}).`,
  '',
  `Issue ${ISSUE_URL} is open and other/lib#90 is a draft.`,
  '',
  `Repository ${REPO_URL} hosts it. ghost/missing#5 is not shared with you.`,
  '',
  'Inline `acme/app#9` stays code.',
  '',
  '```text',
  'acme/app#9 in a fence',
  '```',
].join('\n');
const SCOPE_TEXT = 'Scope check: acme/app#3001 and CAN-42 are both linked.';

// What each decorated reference reads as, in transcript order.
const MAIN_REFERENCES = [
  `#1234: ${TITLE_1234}`,
  `acme/app#1234: ${TITLE_1234}`,
  `other/lib#1234: ${TITLE_OTHER_1234}`,
  `#7: ${TITLE_7}`,
  'my explanation',
  `#55: ${TITLE_55}`,
  `other/lib#90: ${TITLE_90}`,
  `acme/app: ${REPO_DESCRIPTION_BOUNDED}`,
  'ghost/missing#5',
];

function issue(owner, repo, number, title, extra = {}) {
  return {
    number,
    title,
    state: 'open',
    html_url: `https://github.com/${owner}/${repo}/issues/${number}`,
    updated_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    user: { login: 'octocat' },
    body: `## Context\n\nThe **${title}** work, tracked in [the plan](https://example.com).`,
    ...extra,
  };
}

function pull(owner, repo, number, title, { mergedAt = null, draft = false }) {
  return issue(owner, repo, number, title, {
    html_url: `https://github.com/${owner}/${repo}/pull/${number}`,
    draft,
    pull_request: { merged_at: mergedAt },
  });
}

const SCENARIO_A = {
  github: {
    issues: {
      'acme/app/1234': issue('acme', 'app', 1234, TITLE_1234),
      'other/lib/1234': issue('other', 'lib', 1234, TITLE_OTHER_1234, {
        state: 'closed',
      }),
      'acme/app/7': pull('acme', 'app', 7, TITLE_7, {
        mergedAt: '2026-10-01T09:00:00Z',
      }),
      'acme/app/55': issue('acme', 'app', 55, TITLE_55),
      'other/lib/90': pull('other', 'lib', 90, TITLE_90, { draft: true }),
      'acme/app/9': issue('acme', 'app', 9, 'Never requested from code'),
      'acme/app/3001': issue('acme', 'app', 3001, TITLE_3001_A),
    },
    repositories: {
      'acme/app': {
        description: REPO_DESCRIPTION,
        html_url: REPO_URL,
        private: false,
        archived: false,
        updated_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      },
    },
  },
};

const SCENARIO_B = {
  github: {
    issues: { 'acme/app/3001': issue('acme', 'app', 3001, TITLE_3001_B) },
  },
};

const LINEAR_SCENARIO = {
  linear: {
    previewTeams: [{ id: 'team_can', key: 'CAN', name: 'Canopy' }],
    issues: [
      {
        id: 'iss_can_42',
        identifier: 'CAN-42',
        title: LINEAR_TITLE,
        url: 'https://linear.app/acme/issue/CAN-42/keep-linear-titles',
        state: { name: 'In Progress' },
      },
    ],
  },
};

const git = (args) => execFileSync('/usr/bin/git', args, { stdio: 'pipe' });

// `origin` names the GitHub repository bare `#N` resolves in; the dead proxy
// keeps any background fetch off the network.
function pointOriginAtGitHub(repoPath) {
  git(['-C', repoPath, 'remote', 'add', 'origin', ORIGIN_URL]);
  git(['-C', repoPath, 'config', 'http.proxy', 'http://127.0.0.1:9']);
}

function seed(userDataDir) {
  const summary = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  pointOriginAtGitHub(summary.workspaces[0].worktreePath);
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
  const chat = (id, title, text) => ({
    id,
    title,
    messages: [
      {
        id: `${id}-user`,
        role: 'user',
        blocks: [{ type: 'text', text: 'Which GitHub items are involved?' }],
        timestamp: Date.parse('2026-10-01T10:00:00.000Z'),
      },
      {
        id: `${id}-assistant`,
        role: 'assistant',
        blocks: [{ type: 'text', text }],
        timestamp: Date.parse('2026-10-01T10:00:05.000Z'),
      },
    ],
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: CHAT_ID,
    tabs: [
      chat(CHAT_ID, 'GitHub previews', MAIN_TEXT),
      chat(SCOPE_CHAT_ID, 'Scope check', SCOPE_TEXT),
    ],
  });
}

// Main falls back to `gh auth token` without a PAT, and gh finds the host's
// keyring login even with an empty config dir; an unknown default host keeps
// that fallback empty, so a cleared PAT really disconnects.
function isolatedGhEnv(root) {
  const ghConfigDir = path.join(root, 'gh-config');
  mkdirSync(ghConfigDir, { recursive: true });
  return { GH_CONFIG_DIR: ghConfigDir, GH_HOST: 'github.e2e.invalid' };
}

async function setHold(key, held) {
  const response = await fetch(
    `${DEFAULT_MOCK_BASE_URL}/__mock/github/reference-holds/${encodeURIComponent(key)}`,
    { method: 'POST', body: JSON.stringify({ held }) },
  );
  expect(response.ok).toBe(true);
}

async function heldReads(key) {
  const response = await fetch(
    `${DEFAULT_MOCK_BASE_URL}/__mock/github/reference-holds/${encodeURIComponent(key)}`,
  );
  return (await response.json()).waiting;
}

/** Reference reads the mock saw for `key`, by `githubIssue:`/`githubRepository:` target. */
async function referenceReads(key) {
  const { activity } = await getScenarioActivity(DEFAULT_MOCK_BASE_URL, key);
  return Object.fromEntries(
    Object.entries(activity).filter(([field]) => field.startsWith('github')),
  );
}

// The supported Settings path: PAT mode, then type (or clear) the token.
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

function readSavedPreviews(window) {
  return window.evaluate((key) => {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : null;
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    return {
      raw: raw ?? '',
      githubScope: parsed?.githubScope ?? null,
      github: entries.filter((entry) => entry.provider === 'github').length,
      linear: entries.filter((entry) => entry.provider === 'linear').length,
    };
  }, STORAGE_KEY);
}

// Select a DOM range in the renderer, copy through Chromium's native copy
// command, and read the system clipboard.
async function copySelection(window, electronApp, select) {
  await electronApp.evaluate(({ clipboard }) => clipboard.clear());
  await window.evaluate(select);
  await electronApp.evaluate(({ BrowserWindow }) => {
    const focused =
      BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    focused.webContents.copy();
  });
  await expect
    .poll(() => electronApp.evaluate(({ clipboard }) => clipboard.readText()))
    .not.toBe('');
  return electronApp.evaluate(({ clipboard }) => clipboard.readText());
}

function interceptWindowOpen(window) {
  return window.evaluate(() => {
    Reflect.set(window, '__openedUrls', []);
    window.open = (url) => {
      Reflect.get(window, '__openedUrls').push(String(url));
      return null;
    };
  });
}

const openedUrls = (window) =>
  window.evaluate(() => Reflect.get(window, '__openedUrls'));

async function openChat(window, app, chatId) {
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_ID);
  await window.getByTestId(`panel-tab-panel-chat-${chatId}`).click();
  const chat = window.locator(
    `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${chatId}"]`,
  );
  await expect(chat).toBeVisible();
  return chat;
}

test('GitHub references show inline titles and preview cards, and follow the credential', async () => {
  test.setTimeout(240_000);
  const root = mkdtempSync(path.join(os.tmpdir(), 'canopy-github-previews-'));
  const userDataDir = path.join(root, 'data');
  mkdirSync(userDataDir);
  seed(userDataDir);
  await registerScenario(DEFAULT_MOCK_BASE_URL, TOKEN_A, SCENARIO_A);
  await registerScenario(DEFAULT_MOCK_BASE_URL, TOKEN_B, SCENARIO_B);
  await registerScenario(DEFAULT_MOCK_BASE_URL, LINEAR_TOKEN, LINEAR_SCENARIO);
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: isolatedGhEnv(root),
  });
  try {
    const window = await electronApp.firstWindow();
    let app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    expect(
      await window.evaluate(() =>
        window.api.experiments
          .getSnapshot()
          .then((snapshot) => snapshot.earlyAccessEnabled),
      ),
    ).not.toBe(true);
    await window.evaluate(
      (token) => window.api.saveLinearToken(token),
      LINEAR_TOKEN,
    );
    await window.evaluate(() =>
      window.dispatchEvent(new Event('canopy:linear-connection-changed')),
    );
    await setGitHubPat(window, app, TOKEN_A);
    let chat = await openChat(window, app, CHAT_ID);

    // ── Cold: every reference resolves once, in its own repository ──────────
    let references = chat.getByTestId('github-reference');
    await expect(references).toHaveText(MAIN_REFERENCES);
    await expect
      .poll(() => referenceReads(TOKEN_A))
      .toEqual({
        'githubIssue:acme/app/1234': 1,
        'githubIssue:other/lib/1234': 1,
        'githubIssue:acme/app/7': 1,
        'githubIssue:acme/app/55': 1,
        'githubIssue:other/lib/90': 1,
        'githubIssue:ghost/missing/5': 1,
        'githubRepository:acme/app': 1,
      });
    for (const reference of await references.all()) {
      await expect(reference.locator('svg[aria-hidden="true"]')).toHaveCount(1);
    }
    // URLs keep exactly what was written; generated text is a link role.
    await expect(references.nth(3)).toHaveAttribute('href', PR_URL);
    await expect(references.nth(4)).toHaveAttribute('href', PR_CANONICAL);
    await expect(references.nth(5)).toHaveAttribute('href', ISSUE_URL);
    await expect(references.nth(7)).toHaveAttribute('href', REPO_URL);
    await expect(references.nth(0)).toHaveAttribute('role', 'link');
    await expect(references.nth(1)).toHaveAttribute('role', 'link');
    // Code is never decorated, and never read.
    await expect(chat.locator('code', { hasText: 'acme/app#9' })).toHaveCount(
      2,
    );
    await expect(
      chat.locator('code [data-testid="github-reference"]'),
    ).toHaveCount(0);
    // The inaccessible reference keeps its own text and reserves nothing.
    await expect(
      references.nth(8).getByTestId('github-reference-title'),
    ).toHaveCount(0);
    await expect(
      chat.getByTestId('github-reference-title-placeholder'),
    ).toHaveCount(0);
    // A repository's description is bounded by main and whole in the DOM.
    await expect(
      references.nth(7).getByTestId('github-reference-title'),
    ).toHaveText(REPO_DESCRIPTION_BOUNDED);

    // About five whole words, then "…"; the full title stays in the DOM.
    for (const index of [0, 1]) {
      const title = references.nth(index).getByTestId('github-reference-title');
      await expect
        .poll(async () => (await readTruncation(title)).truncated)
        .toBe('word');
      const state = await readTruncation(title);
      expectWordCut(state, TITLE_1234);
      expect(TITLE_1234.slice(0, state.visibleLength)).toBe(FIVE_WORDS_1234);
      expect(state.title).toBeNull();
    }
    expect(
      await copySelection(window, electronApp, () => {
        const target = document.querySelectorAll(
          '[data-testid="panel-content-chat"] [data-testid="github-reference"]',
        )[1];
        const range = document.createRange();
        range.selectNodeContents(target);
        getSelection()?.removeAllRanges();
        getSelection()?.addRange(range);
      }),
    ).toBe(`acme/app#1234: ${TITLE_1234}`);
    await window.evaluate(() => getSelection()?.removeAllRanges());

    // Hover: full title, state, repository and author.
    const card = window.getByTestId('github-reference-preview-card');
    await references.nth(1).hover();
    await expect(
      card.getByTestId('github-reference-preview-repository'),
    ).toHaveText('app');
    await expect(card).toContainText('#1234');
    await expect(card).toContainText(TITLE_1234);
    await expect(
      card.getByTestId('github-reference-preview-status'),
    ).toHaveText('Open');
    await expect(card).toContainText('octocat');
    await expect(card).toHaveAttribute('data-layout', 'status');
    await window.mouse.move(0, 0);
    await expect(card).toHaveCount(0);
    await references.nth(2).hover();
    await expect(card).toContainText(TITLE_OTHER_1234);
    await expect(
      card.getByTestId('github-reference-preview-status'),
    ).toHaveText('Closed');
    await window.mouse.move(0, 0);
    await references.nth(3).hover();
    await expect(card).toContainText(TITLE_7);
    await expect(
      card.getByTestId('github-reference-preview-status'),
    ).toHaveText('Merged');
    await window.mouse.move(0, 0);
    await references.nth(4).hover();
    await expect(card).toContainText('#7');
    await expect(card).toContainText(TITLE_7);
    await window.mouse.move(0, 0);
    await references.nth(7).hover();
    await expect(card).toContainText('acme/app');
    await expect(card).toContainText('Repository · Public');
    await window.mouse.move(0, 0);
    await references.nth(8).hover();
    await expect(window.getByRole('tooltip')).toContainText(
      'Preview unavailable',
    );
    await window.mouse.move(0, 0);
    await expect(window.getByRole('tooltip')).toHaveCount(0);

    // Keyboard focus opens the card; Escape closes it and keeps focus.
    await window.keyboard.press('Shift');
    await references.nth(6).focus();
    await expect(card).toContainText(TITLE_90);
    await expect(
      card.getByTestId('github-reference-preview-status'),
    ).toHaveText('Draft');
    await window.keyboard.press('Escape');
    await expect(card).toHaveCount(0);
    await expect(references.nth(6)).toBeFocused();
    // Enter on generated text opens GitHub's canonical URL, once.
    await interceptWindowOpen(window);
    await references.nth(0).focus();
    await expect(card).toBeVisible();
    await window.keyboard.press('Escape');
    await window.keyboard.press('Enter');
    await expect
      .poll(() => openedUrls(window))
      .toEqual(['https://github.com/acme/app/issues/1234']);
    await references.nth(2).focus();
    await window.keyboard.press('Escape');
    await window.keyboard.press('Enter');
    await expect
      .poll(() => openedUrls(window))
      .toEqual([
        'https://github.com/acme/app/issues/1234',
        'https://github.com/other/lib/issues/1234',
      ]);
    await references.nth(2).blur();
    // A resolved generated reference carries the message menu's link section
    // (CAN-2632).
    const BARE_URL = 'https://github.com/acme/app/issues/1234';
    await expect(references.nth(0)).toHaveText(MAIN_REFERENCES[0]);
    await expect(references.nth(8)).toHaveText('ghost/missing#5');
    await expect(references.nth(0)).toHaveAttribute('data-link-url', BARE_URL);
    await expect(references.nth(8)).not.toHaveAttribute('data-link-url', /.*/);
    await window.mouse.move(0, 0);
    await references.nth(0).click({ button: 'right' });
    const messageMenu = window.getByTestId('chat-message-context-menu');
    await expect(messageMenu).toBeVisible();
    expect(await messageMenu.getByRole('menuitem').allTextContents()).toEqual([
      ...LINK_ITEMS,
      ...COPY_ITEMS,
    ]);
    await electronApp.evaluate(({ clipboard }) => clipboard.writeText(''));
    await window.getByTestId('chat-message-copy-link').click();
    await expect
      .poll(() => electronApp.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe(BARE_URL);
    await expect(messageMenu).toHaveCount(0);
    // An unresolved reference offers only the copy items.
    await references.nth(8).click({ button: 'right' });
    await expect(messageMenu).toBeVisible();
    expect(await messageMenu.getByRole('menuitem').allTextContents()).toEqual(
      COPY_ITEMS,
    );
    await window.keyboard.press('Escape');
    await expect(messageMenu).toHaveCount(0);
    await window.mouse.move(0, 0);
    // Clicking the PR URL navigates to the URL as written.
    await window.evaluate(() => {
      Reflect.set(window, '__clickedHrefs', []);
      window.addEventListener(
        'click',
        (event) => {
          const anchor =
            event.target instanceof Element
              ? event.target.closest('a[href]')
              : null;
          if (!anchor) return;
          Reflect.get(window, '__clickedHrefs').push(
            anchor.getAttribute('href'),
          );
          event.preventDefault();
        },
        { capture: true, once: true },
      );
    });
    await references.nth(3).click();
    await expect
      .poll(() => window.evaluate(() => Reflect.get(window, '__clickedHrefs')))
      .toEqual([PR_URL]);
    await window.mouse.move(0, 0);
    // Hover, focus and activation served from the cache: no new reads.
    expect(await referenceReads(TOKEN_A)).toMatchObject({
      'githubIssue:acme/app/1234': 1,
      'githubIssue:other/lib/1234': 1,
      'githubIssue:acme/app/7': 1,
      'githubIssue:ghost/missing/5': 1,
    });

    // ── Warm reload: cached titles paint while every read is held ───────────
    await expect
      .poll(async () => (await readSavedPreviews(window)).github)
      .toBe(6);
    const readsBeforeReload = await referenceReads(TOKEN_A);
    await setHold(TOKEN_A, true);
    await window.reload();
    app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    chat = await openChat(window, app, CHAT_ID);
    references = chat.getByTestId('github-reference');
    await expect(references).toHaveText(MAIN_REFERENCES);
    // The only read is the uncached inaccessible one, and it is still held.
    await expect.poll(() => heldReads(TOKEN_A)).toBe(1);
    expect(await referenceReads(TOKEN_A)).toEqual({
      ...readsBeforeReload,
      'githubIssue:ghost/missing/5': 2,
    });

    // ── Pending: a reserved, text-free, static placeholder ──────────────────
    const placeholder = references
      .nth(8)
      .getByTestId('github-reference-title-placeholder');
    await expect(placeholder).toHaveCount(1);
    await expect(placeholder).toHaveAttribute('aria-hidden', 'true');
    await expect(placeholder).toHaveAttribute('data-active', 'true');
    await expect(placeholder).toHaveText('');
    expect(
      await placeholder.evaluate((element) => element.offsetWidth),
    ).toBeGreaterThan(0);
    const shadeAnimation = () =>
      placeholder.evaluate(
        (element) => getComputedStyle(element, '::after').animationName,
      );
    expect(await shadeAnimation()).not.toBe('none');
    await window.emulateMedia({ reducedMotion: 'reduce' });
    expect(await shadeAnimation()).toBe('none');
    await window.emulateMedia({ reducedMotion: null });
    expect(
      await copySelection(window, electronApp, () => {
        const paragraph = document
          .querySelectorAll(
            '[data-testid="panel-content-chat"] [data-testid="github-reference"]',
          )[8]
          .closest('p');
        const range = document.createRange();
        range.selectNodeContents(paragraph);
        getSelection()?.removeAllRanges();
        getSelection()?.addRange(range);
      }),
    ).toBe(
      `Repository acme/app: ${REPO_DESCRIPTION_BOUNDED} hosts it. ghost/missing#5 is not shared with you.`,
    );
    await window.evaluate(() => getSelection()?.removeAllRanges());
    // Released, it answers 404 and the placeholder leaves no trace.
    await setHold(TOKEN_A, false);
    await expect(placeholder).toHaveCount(0);
    await expect(references.nth(8)).toHaveText('ghost/missing#5');

    // ── Credential change mid-read ──────────────────────────────────────────
    await setHold(TOKEN_A, true);
    const scopeChat = await openChat(window, app, SCOPE_CHAT_ID);
    const scopeReference = scopeChat.getByTestId('github-reference');
    const linearReference = scopeChat.getByTestId('linear-reference');
    await expect(linearReference).toHaveText(`CAN-42: ${LINEAR_TITLE}`);
    await expect(scopeReference).toHaveText('acme/app#3001');
    await expect(
      scopeReference.getByTestId('github-reference-title-placeholder'),
    ).toHaveCount(1);
    await expect.poll(() => heldReads(TOKEN_A)).toBe(1);
    const scopeA = (await readSavedPreviews(window)).githubScope;
    expect(scopeA).not.toBeNull();
    // Record any moment the first credential's title reaches the screen.
    await window.evaluate((stale) => {
      Reflect.set(window, '__staleTitleSeen', false);
      const check = () => {
        if (document.body.textContent?.includes(stale)) {
          Reflect.set(window, '__staleTitleSeen', true);
        }
      };
      new MutationObserver(check).observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      check();
    }, TITLE_3001_A);
    await setHold(TOKEN_B, true);
    await setGitHubPat(window, app, TOKEN_B);
    // GitHub titles and cache are gone for the new scope; Linear's stay.
    await expect(scopeReference).toHaveText('acme/app#3001');
    await expect(
      scopeReference.getByTestId('github-reference-title-placeholder'),
    ).toHaveCount(1);
    await expect(linearReference).toHaveText(`CAN-42: ${LINEAR_TITLE}`);
    await expect
      .poll(async () => {
        const saved = await readSavedPreviews(window);
        return {
          github: saved.github,
          changed: saved.githubScope !== scopeA,
          linear: saved.linear > 0,
          stale: saved.raw.includes(TITLE_1234),
        };
      })
      .toEqual({ github: 0, changed: true, linear: true, stale: false });
    test.info().annotations.push({
      type: 'reads under the new credential while the old one is held',
      description: JSON.stringify(await referenceReads(TOKEN_B)),
    });
    // The first credential's read lands now and must be ignored. The broker
    // runs one GitHub request at a time, so the new credential's read starts
    // only after it.
    await setHold(TOKEN_A, false);
    await expect.poll(() => heldReads(TOKEN_A)).toBe(0);
    await expect.poll(() => heldReads(TOKEN_B)).toBe(1);
    await expect(
      scopeReference.getByTestId('github-reference-title-placeholder'),
    ).toHaveAttribute('data-active', 'true');
    await setHold(TOKEN_B, false);
    await expect(scopeReference).toHaveText(`acme/app#3001: ${TITLE_3001_B}`);
    await expect(linearReference).toHaveText(`CAN-42: ${LINEAR_TITLE}`);
    expect(
      await window.evaluate(() => Reflect.get(window, '__staleTitleSeen')),
    ).toBe(false);
    expect(await referenceReads(TOKEN_B)).toEqual({
      'githubIssue:acme/app/3001': 1,
    });
    await expect
      .poll(async () => {
        const saved = await readSavedPreviews(window);
        return {
          github: saved.github,
          stale: saved.raw.includes(TITLE_3001_A),
        };
      })
      .toEqual({ github: 1, stale: false });

    // ── Disconnect: plain text and ordinary links, no placeholders ──────────
    await setGitHubPat(window, app, '');
    // Main resolves no GitHub credential at all now (no gh login fallback).
    await expect
      .poll(() =>
        window.evaluate(() => window.api.referencePreview.githubScope()),
      )
      .toEqual({ scope: null });
    await expect(scopeReference).toHaveCount(0);
    await expect(scopeChat).toContainText('Scope check: acme/app#3001 and');
    await expect(linearReference).toHaveText(`CAN-42: ${LINEAR_TITLE}`);
    chat = await openChat(window, app, CHAT_ID);
    await expect(chat.getByTestId('github-reference')).toHaveCount(0);
    await expect(
      window.getByTestId('github-reference-title-placeholder'),
    ).toHaveCount(0);
    await expect(chat).toContainText('Bare #1234 is ours, acme/app#1234');
    await expect(chat.locator(`a[href="${PR_URL}"]`)).toHaveCount(1);
    await expect(chat.locator(`a[href="${PR_CANONICAL}"]`)).toHaveText(
      'my explanation',
    );
    await expect
      .poll(async () => {
        const saved = await readSavedPreviews(window);
        return { github: saved.github, scope: saved.githubScope };
      })
      .toEqual({ github: 0, scope: null });
  } finally {
    await setHold(TOKEN_A, false).catch(() => undefined);
    await setHold(TOKEN_B, false).catch(() => undefined);
    await closeCanopy(electronApp, userDataDir).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test('a cowork transcript keeps bare numbers plain and hydrates qualified references', async () => {
  test.setTimeout(120_000);
  const root = mkdtempSync(path.join(os.tmpdir(), 'canopy-github-cowork-'));
  const userDataDir = path.join(root, 'data');
  mkdirSync(userDataDir);
  // The cowork folder is itself a checkout of acme/app: cowork still never
  // infers a repository for bare `#N`.
  const folder = path.join(root, 'cowork-folder');
  mkdirSync(folder);
  git(['init', folder]);
  pointOriginAtGitHub(folder);
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const workspaceId = 'github-previews-cowork';
  const chatId = 'github-previews-cowork-chat';
  seedCoworkWorkspace({
    userDataDir,
    workspaceId,
    name: 'GitHub previews cowork',
    collapsed: false,
    chatId,
    chatTitle: 'Cowork references',
    externalPath: folder,
    mergeIndex: true,
  });
  const chatsPath = path.join(
    userDataDir,
    'workspaces',
    workspaceId,
    'chats',
    'home.json',
  );
  const chats = JSON.parse(readFileSync(chatsPath, 'utf8'));
  chats.tabs[0].messages.push({
    id: `${chatId}-assistant`,
    role: 'assistant',
    blocks: [
      {
        type: 'text',
        text: 'In cowork #1234 stays plain while acme/app#1234 resolves.',
      },
    ],
    timestamp: Date.parse('2026-05-01T12:02:00.000Z'),
  });
  writeFileSync(chatsPath, JSON.stringify(chats, null, 2));
  await registerScenario(DEFAULT_MOCK_BASE_URL, COWORK_TOKEN, {
    github: {
      issues: { 'acme/app/1234': issue('acme', 'app', 1234, TITLE_1234) },
    },
  });
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: isolatedGhEnv(root),
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await setGitHubPat(window, app, COWORK_TOKEN);
    const toggle = window.getByTestId(
      `sidebar-cowork-project-${workspaceId}-toggle`,
    );
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
      await toggle.click();
    }
    await window.getByTestId(`sidebar-work-entry-${chatId}`).click();
    const chat = window.getByTestId('panel-content-chat');
    await expect(chat).toContainText('stays plain while', { timeout: 30_000 });
    const references = chat.getByTestId('github-reference');
    await expect(references).toHaveText([`acme/app#1234: ${TITLE_1234}`]);
    await expect(chat).toContainText('In cowork #1234 stays plain');
    expect(await referenceReads(COWORK_TOKEN)).toEqual({
      'githubIssue:acme/app/1234': 1,
    });
  } finally {
    await closeCanopy(electronApp, userDataDir).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});
