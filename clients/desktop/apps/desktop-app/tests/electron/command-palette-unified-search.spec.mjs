import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { injectChatEvent } from './seeders/injectChatEvent.mjs';
import { publishTurnLifecycle } from './seeders/publishTurnLifecycle.mjs';
import { seedStoredPipeline } from './seeders/seedStoredPipeline.mjs';
import { seedWorktreeChat } from './seeders/seedWorktreeChat.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const PALETTE_SHORTCUT = process.platform === 'darwin' ? 'Meta+K' : 'Control+K';
const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const MAPPED_WORKTREE_ID = 'mapped-worktree';
const MAPPED_BRANCH = 'tirish/2026-09-07-file-tab-labels';

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function seedMappedWorktree(userDataDir, seedResult) {
  const repoPath = seedResult.workspaces[0]?.repoPath;
  if (!repoPath) throw new Error('Missing seeded repository path');
  const worktreePath = path.join(
    userDataDir,
    'workspaces',
    WORKSPACE_ID,
    'worktrees',
    MAPPED_WORKTREE_ID,
  );
  mkdirSync(path.dirname(worktreePath), { recursive: true });
  execFileSync(
    'git',
    ['worktree', 'add', '-b', MAPPED_BRANCH, worktreePath, 'HEAD'],
    {
      cwd: repoPath,
      stdio: 'ignore',
    },
  );
  writeJson(
    path.join(userDataDir, 'workspaces', WORKSPACE_ID, 'worktrees.json'),
    {
      version: 1,
      worktrees: [
        {
          id: MAPPED_WORKTREE_ID,
          branchName: MAPPED_BRANCH,
          createdAt: '2026-09-07T00:00:00.000Z',
          trackedBaseBranch: 'main',
        },
      ],
    },
  );
}

function makeMessages(id, phrase) {
  return [
    {
      id: `${id}-user`,
      role: 'user',
      blocks: [{ type: 'text', text: phrase }],
      timestamp: Date.parse('2026-07-14T12:00:00.000Z'),
    },
  ];
}

function makeSizedBody(totalBytes, needle) {
  const prefix = 'aggregate worker projection body. ';
  const suffix = ` ${needle}`;
  return `${prefix
    .repeat(Math.ceil((totalBytes - suffix.length) / prefix.length))
    .slice(0, totalBytes - suffix.length)}${suffix}`;
}

async function openPalette(window) {
  await window.keyboard.press(PALETTE_SHORTCUT);
  await expect(window.getByTestId('command-palette')).toBeVisible();
  return window.getByTestId('command-palette-input');
}

async function closePalette(window) {
  await window.keyboard.press('Escape');
  await expect(window.getByTestId('command-palette')).toBeHidden();
}

test('chat search excludes hidden managed-delivery messages', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-palette-hidden-delivery-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: 'hidden-delivery-chat',
    tabs: [
      {
        id: 'hidden-delivery-chat',
        title: 'Delegation result',
        providerType: 'codex',
        messages: [
          ...makeMessages('hidden-delivery-chat', 'visibleparentneedle'),
          {
            id: 'hidden-delivery-message',
            role: 'user',
            hidden: true,
            blocks: [{ type: 'text', text: 'privatedeliveryneedle' }],
            timestamp: Date.parse('2026-07-14T12:00:01.000Z'),
          },
        ],
      },
    ],
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();

    let input = await openPalette(window);
    await closePalette(window);
    await expect
      .poll(async () => {
        const response = await window.evaluate(() =>
          window.api.chatSearch.query({ query: 'visibleparentneedle' }),
        );
        return response.results.map((result) => result.chatId);
      })
      .toContain('hidden-delivery-chat');

    input = await openPalette(window);
    await input.fill('privatedeliveryneedle');
    await expect(
      window
        .getByTestId('command-palette')
        .locator('[data-palette-section="chats"]')
        .getByText('Delegation result', { exact: true }),
    ).toHaveCount(0);
    const response = await window.evaluate(() =>
      window.api.chatSearch.query({ query: 'privatedeliveryneedle' }),
    );
    expect(response.results).toEqual([]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('keyboard navigation expands and traverses every result in a capped section', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-palette-show-more-'),
  );
  const chatIds = Array.from(
    { length: 9 },
    (_, index) => `palette-overflow-${index + 1}`,
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: chatIds[0],
    tabs: chatIds.map((id, index) => ({
      id,
      title: `Paletteoverflow result ${index + 1}`,
      providerType: 'codex',
      createdAt: `2026-07-${String(index + 1).padStart(2, '0')}T12:00:00.000Z`,
      messages: makeMessages(id, `Deterministic overflow fixture ${index + 1}`),
    })),
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();

    await openPalette(window);
    await closePalette(window);
    await window.evaluate(async (expectedChatIds) => {
      const expected = new Set(expectedChatIds);
      const startedAt = performance.now();
      while (performance.now() - startedAt < 30_000) {
        const response = await window.api.chatSearch.catalog();
        if (
          response.entries.filter((entry) => expected.has(entry.chatId))
            .length === expected.size
        ) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error('Timed out waiting for palette overflow fixtures');
    }, chatIds);

    const input = await openPalette(window);
    await input.fill('paletteoverflow');
    const palette = window.getByTestId('command-palette');
    const scrollContainer = palette.locator('.overflow-y-auto');
    const chatSection = palette.locator('[data-palette-section="chats"]');
    const showMore = palette.getByTestId('command-palette-show-more');
    await expect(showMore).toHaveText('Show 3 more');
    const initiallyVisible = await chatSection
      .getByTestId('command-palette-result')
      .count();
    const advertisedMore = Number(
      (await showMore.innerText()).match(/\d+/)?.[0] ?? Number.NaN,
    );
    const advertisedTotal = initiallyVisible + advertisedMore;

    for (let index = 0; index < 6; index += 1) {
      await window.keyboard.press('ArrowDown');
    }
    await expect(showMore).toHaveAttribute('aria-selected', 'true');
    await window.keyboard.press('Enter');

    const options = palette.getByRole('option');
    await expect(options).toHaveCount(advertisedTotal);
    await expect(input).toBeFocused();
    const visited = new Set();
    for (let index = 0; index < advertisedTotal; index += 1) {
      const active = palette.locator('[role="option"][aria-selected="true"]');
      visited.add((await active.innerText()).trim());
      await expect
        .poll(async () => {
          const [activeBox, containerBox] = await Promise.all([
            active.boundingBox(),
            scrollContainer.boundingBox(),
          ]);
          if (!activeBox || !containerBox) {
            return { topContained: false, bottomContained: false };
          }
          return {
            topContained: activeBox.y - containerBox.y >= 0,
            bottomContained:
              containerBox.y +
                containerBox.height -
                (activeBox.y + activeBox.height) >=
              0,
          };
        })
        .toEqual({ topContained: true, bottomContained: true });
      await window.keyboard.press('ArrowDown');
    }
    expect(visited.size).toBe(advertisedTotal);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('searches and surfaces a branch-mapped worktree label', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-palette-worktree-label-'),
  );
  const seedResult = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    createWorktrees: false,
  });
  seedMappedWorktree(userDataDir, seedResult);
  writeJson(path.join(userDataDir, 'preferences.json'), {
    version: 1,
    preferences: {
      branchDisplayMappings: [
        {
          id: 'e2e-file-tab-labels',
          label: 'E2E file tab labels',
          matcher: `^${MAPPED_BRANCH}$`,
          result: 'File Tab Labels',
          settings: { replaceHyphens: false, capitalize: false },
          enabled: true,
          builtin: false,
          examples: [],
          readonlyExampleCount: 0,
        },
      ],
    },
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();

    const input = await openPalette(window);
    await input.fill('File Tab Labels');
    const worktreeSection = window.locator(
      '[data-palette-section="worktrees"]',
    );
    await expect(worktreeSection).toBeVisible();
    const mappedWorktree = worktreeSection.getByRole('option', {
      name: /File Tab Labels TypeScript pnpm Vite/,
    });
    await expect(mappedWorktree).toBeVisible();
    await expect(mappedWorktree).toContainText('File Tab Labels');
    await expect(mappedWorktree).not.toContainText(MAPPED_BRANCH);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('searches and surfaces the divergent multi-repo branch label', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-palette-multi-repo-label-'),
  );
  const seedResult = seedDemoWorkspaces({
    userDataDir,
    apps: ['multi-repo-fullstack'],
  });
  const worktreePath = seedResult.workspaces[0]?.worktreePath;
  if (!worktreePath) throw new Error('Missing seeded multi-repo worktree path');
  execFileSync('git', ['branch', '-m', 'feature/web-only'], {
    cwd: path.join(worktreePath, 'repos', 'web'),
    stdio: 'ignore',
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await expect(
      window.getByTestId('worktree-row').getByText('Multiple branches', {
        exact: true,
      }),
    ).toBeVisible({ timeout: 30_000 });

    const input = await openPalette(window);
    await input.fill('Multiple branches');
    const worktreeSection = window.locator(
      '[data-palette-section="worktrees"]',
    );
    await expect(worktreeSection).toBeVisible();
    await expect(worktreeSection).toContainText('Multiple branches');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('unified palette renders rich entity and transcript results and navigates them', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-unified-palette-'),
  );
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite', 'ts-npm-next'],
  });
  seedStoredPipeline({
    userDataDir,
    id: 'palette-zephyr',
    name: 'Palette Zephyr Pipeline',
    description: 'Seeded unified-search pipeline',
    yaml: 'name: Palette Zephyr Pipeline\non: dispatch\njobs: {}\n',
  });

  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: 'live-palette-chat',
    tabs: [
      {
        id: 'live-palette-chat',
        title: 'Ordinary live discussion',
        providerType: 'codex',
        messages: makeMessages(
          'live-palette-chat',
          'The distinctive quasarneedle belongs in the live transcript.',
        ),
      },
    ],
  });

  const archivedTab = {
    id: 'archived-palette-chat',
    title: 'Ordinary archived discussion',
    providerType: 'claude',
    createdAt: '2026-07-14T11:00:00.000Z',
    messages: makeMessages(
      'archived-palette-chat',
      'The archived nebulaarchive phrase must remain searchable.',
    ),
  };
  writeJson(
    path.join(
      userDataDir,
      'workspaces',
      WORKSPACE_ID,
      'chat-archives',
      `${WORKTREE_ID}.json`,
    ),
    {
      version: 1,
      archived: [
        {
          tab: archivedTab,
          archivedAt: '2026-07-14T12:30:00.000Z',
          turnCount: 1,
          readAt: null,
        },
      ],
    },
  );

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();

    // Exercise the initial lazy scan against more than one workspace. The
    // palette must remain responsive immediately after launch while indexing
    // continues in the background.
    let input = await openPalette(window);
    await input.fill('ts-npm-next');
    await expect(input).toHaveValue('ts-npm-next');
    await closePalette(window);

    // Tier 0: raw branch terms remain searchable, while the result uses the
    // same resolved display label as the sidebar, followed by Enter navigation.
    input = await openPalette(window);
    await input.fill('demo-main');
    const worktreeSection = window.locator(
      '[data-palette-section="worktrees"]',
    );
    await expect(worktreeSection).toBeVisible();
    const viteWorktree = worktreeSection.getByRole('option', {
      name: /New Task TypeScript pnpm Vite/,
    });
    await expect(viteWorktree).toBeVisible();
    await expect(viteWorktree).not.toContainText('demo-main');
    // Result refreshes intentionally preserve the previously selected item.
    // Establish the worktree as the active row, then exercise a down/up
    // keyboard round trip without depending on which prior result survived.
    await viteWorktree.hover();
    await expect(viteWorktree).toHaveAttribute('aria-selected', 'true');
    await window.keyboard.press('ArrowDown');
    await expect(viteWorktree).toHaveAttribute('aria-selected', 'false');
    await window.keyboard.press('ArrowUp');
    await expect(viteWorktree).toHaveAttribute('aria-selected', 'true');
    await window.keyboard.press('Enter');
    await expect(window.getByTestId('command-palette')).toBeHidden();
    await expect(
      window.getByTestId('panel-tab-panel-chat-live-palette-chat'),
    ).toBeVisible();

    // Seeded pipeline rows omit source pills and navigate to the editor.
    input = await openPalette(window);
    await input.fill('Palette Zephyr');
    const pipelineSection = window.locator(
      '[data-palette-section="pipelines"]',
    );
    await expect(pipelineSection).toContainText('Palette Zephyr Pipeline');
    await expect(
      pipelineSection.getByTestId('command-palette-status-badge'),
    ).toHaveCount(0);
    await pipelineSection.getByRole('option').click();
    await expect(window.getByTestId('page-pipelines-root')).toBeVisible();
    await expect(
      window.getByText('Palette Zephyr Pipeline', { exact: true }),
    ).toBeVisible();

    // Opening once starts the non-blocking lazy scan. Reopen after its yielding
    // pass so the deferred FTS request observes the deterministic fixtures.
    input = await openPalette(window);
    await window.evaluate(() => {
      document.body.tabIndex = -1;
      document.body.focus();
    });
    await expect(input).not.toBeFocused();
    await closePalette(window);
    await window.waitForTimeout(750);

    input = await openPalette(window);
    await input.fill('quasarneedle');
    const transcriptSection = window.locator(
      '[data-palette-section="transcripts"]',
    );
    await expect(transcriptSection).toContainText('Ordinary live discussion', {
      timeout: 15_000,
    });
    await expect(transcriptSection.locator('mark')).not.toHaveCount(0);
    await expect(
      transcriptSection.getByTestId('command-palette-provider-codex'),
    ).toBeVisible();
    await transcriptSection.getByRole('option').click();
    await expect(
      window.getByTestId('panel-tab-panel-chat-live-palette-chat'),
    ).toBeVisible();

    input = await openPalette(window);
    await input.fill('nebulaarchive');
    await expect(transcriptSection).toContainText(
      'Ordinary archived discussion',
      {
        timeout: 15_000,
      },
    );
    await expect(transcriptSection).toContainText('Archived');
    await transcriptSection.getByRole('option').click();
    await expect(
      window.getByTestId('archived-chat-transcript-modal'),
    ).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      window
        .getByTestId('archived-chat-transcript-modal')
        .getByText('nebulaarchive'),
    ).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('aggregate-large transcript search routes projection through the utility worker', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-unified-palette-aggregate-worker-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });

  const needle = 'aggregateworkerneedle';
  const bodyBytesPerChat = 6 * 1024 * 1024;
  const body = makeSizedBody(bodyBytesPerChat, needle);
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: 'aggregate-worker-chat-1',
    tabs: Array.from({ length: 3 }, (_, index) => ({
      id: `aggregate-worker-chat-${index + 1}`,
      title: `Aggregate worker chat ${index + 1}`,
      providerType: 'codex',
      messages: makeMessages(`aggregate-worker-chat-${index + 1}`, body),
    })),
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();

    // Opening the palette starts the lazy transcript scan. Wait for that scan
    // to index the large deterministic fixtures before asserting query routing.
    let input = await openPalette(window);
    await closePalette(window);
    await window.evaluate(async () => {
      const expectedIds = new Set([
        'aggregate-worker-chat-1',
        'aggregate-worker-chat-2',
        'aggregate-worker-chat-3',
      ]);
      const startedAt = performance.now();
      while (performance.now() - startedAt < 60_000) {
        const response = await window.api.chatSearch.catalog();
        const indexedCount = response.entries.filter((entry) =>
          expectedIds.has(entry.chatId),
        ).length;
        if (indexedCount === expectedIds.size) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error('Timed out waiting for aggregate chat-search fixtures');
    });

    input = await openPalette(window);
    await input.fill(needle);
    await expect(input).toHaveValue(needle);
    const response = await window.evaluate(
      (query) => window.api.chatSearch.query({ query, limit: 20 }),
      needle,
    );
    expect(response.results.map((result) => result.chatId).sort()).toEqual([
      'aggregate-worker-chat-1',
      'aggregate-worker-chat-2',
      'aggregate-worker-chat-3',
    ]);

    const workerRuns = await electronApp.evaluate(
      () => globalThis.__CANOPY_E2E_CHAT_SEARCH_WORKER_RUNS__ ?? 0,
    );
    expect(workerRuns).toBeGreaterThan(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('oversized transcript search stays responsive when its query worker fails', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-unified-palette-worker-failure-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });

  const needle = 'failedworkerneedle';
  const body = makeSizedBody(6 * 1024 * 1024, needle);
  const expectedIds = Array.from(
    { length: 3 },
    (_, index) => `failed-worker-chat-${index + 1}`,
  );
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: expectedIds[0],
    tabs: expectedIds.map((id, index) => ({
      id,
      title: `Failed worker chat ${index + 1}`,
      providerType: 'codex',
      messages: makeMessages(id, body),
    })),
  });

  const { electronApp } = await launchCanopy({
    userDataDir,
    env: { CANOPY_E2E_FORCE_CHAT_SEARCH_WORKER_FAILURE: '1' },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();

    let input = await openPalette(window);
    await closePalette(window);
    await window.evaluate(async (chatIds) => {
      const expectedIds = new Set(chatIds);
      const startedAt = performance.now();
      while (performance.now() - startedAt < 60_000) {
        const response = await window.api.chatSearch.catalog();
        const indexedCount = response.entries.filter((entry) =>
          expectedIds.has(entry.chatId),
        ).length;
        if (indexedCount === expectedIds.size) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error('Timed out waiting for failed-worker fixtures');
    }, expectedIds);

    input = await openPalette(window);
    await input.fill(needle);
    await expect(input).toHaveValue(needle);
    await expect(
      window.locator('[data-palette-section="transcripts"]'),
    ).toBeHidden();

    await input.fill('demo-main');
    await expect(
      window.locator('[data-palette-section="worktrees"]'),
    ).toBeVisible();

    const response = await window.evaluate(
      (query) => window.api.chatSearch.query({ query, limit: 20 }),
      needle,
    );
    expect(response.results).toEqual([]);
    const workerRuns = await electronApp.evaluate(
      () => globalThis.__CANOPY_E2E_CHAT_SEARCH_WORKER_RUNS__ ?? 0,
    );
    expect(workerRuns).toBeGreaterThan(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('oversized transcript search uses a temporary recovery index when derived storage is blocked', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-unified-palette-memory-recovery-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const blockedDerivedPath = path.join(userDataDir, 'derived');
  writeFileSync(blockedDerivedPath, 'not a directory', 'utf8');

  const needle = 'memoryrecoveryneedle';
  const body = makeSizedBody(6 * 1024 * 1024, needle);
  const expectedIds = Array.from(
    { length: 3 },
    (_, index) => `memory-recovery-chat-${index + 1}`,
  );
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: expectedIds[0],
    tabs: expectedIds.map((id, index) => ({
      id,
      title: `Memory recovery chat ${index + 1}`,
      providerType: 'codex',
      messages: makeMessages(id, body),
    })),
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();

    let input = await openPalette(window);
    await closePalette(window);
    await window.evaluate(async (chatIds) => {
      const expectedIds = new Set(chatIds);
      const startedAt = performance.now();
      while (performance.now() - startedAt < 60_000) {
        const response = await window.api.chatSearch.catalog();
        const indexedCount = response.entries.filter((entry) =>
          expectedIds.has(entry.chatId),
        ).length;
        if (indexedCount === expectedIds.size) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error('Timed out waiting for memory-recovery fixtures');
    }, expectedIds);

    input = await openPalette(window);
    await input.fill(needle);
    const transcriptRows = window.locator(
      '[data-palette-section="transcripts"] [data-testid="command-palette-result"]',
    );
    await expect(transcriptRows).toHaveCount(expectedIds.length);
    const response = await window.evaluate(
      (query) => window.api.chatSearch.query({ query, limit: 20 }),
      needle,
    );
    expect(response.results.map((result) => result.chatId).sort()).toEqual(
      expectedIds,
    );
    const workerRuns = await electronApp.evaluate(
      () => globalThis.__CANOPY_E2E_CHAT_SEARCH_WORKER_RUNS__ ?? 0,
    );
    expect(workerRuns).toBeGreaterThan(0);
    expect(readFileSync(blockedDerivedPath, 'utf8')).toBe('not a directory');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('live transcript search refreshes after append, edit, and deletion deltas', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-unified-palette-live-deltas-'),
  );
  const chatId = 'live-delta-palette-chat';
  const initialTab = {
    id: chatId,
    title: 'Live delta discussion',
    providerType: 'codex',
    createdAt: '2026-07-14T11:00:00.000Z',
    messages: makeMessages(
      chatId,
      'The original deltastartneedle phrase is searchable.',
    ),
  };
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: chatId,
    tabs: [initialTab],
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();

    const input = await openPalette(window);
    const transcriptSection = window.locator(
      '[data-palette-section="transcripts"]',
    );
    await input.fill('deltastartneedle');
    await expect(transcriptSection).toContainText('Live delta discussion', {
      timeout: 15_000,
    });

    // Keep the query unchanged while the backend index refreshes. The settled
    // In content section must stay mounted until the replacement rows commit.
    await window.evaluate(() => {
      const palette = document.querySelector('[data-testid="command-palette"]');
      if (!(palette instanceof HTMLElement)) {
        throw new Error('Command palette is not mounted');
      }
      window.__CANOPY_E2E_CONTENT_SECTION_REMOVALS__ = 0;
      window.__CANOPY_E2E_CONTENT_SECTION_OBSERVER__ = new MutationObserver(
        () => {
          if (
            document.querySelector('[data-palette-section="transcripts"]') ===
            null
          ) {
            window.__CANOPY_E2E_CONTENT_SECTION_REMOVALS__ += 1;
          }
        },
      );
      window.__CANOPY_E2E_CONTENT_SECTION_OBSERVER__.observe(palette, {
        childList: true,
        subtree: true,
      });
    });
    const sameQueryRefreshResult = await window.evaluate(
      async ({ projectId, worktreeId, targetChatId }) =>
        window.api.chat.command({
          schemaVersion: 1,
          commandId: 'e2e-search-delta-same-query-refresh',
          projectId,
          worktreeId,
          command: {
            type: 'chat.commit_terminal_initial_prompt',
            chatId: targetChatId,
            userMessageId: `${targetChatId}-same-query-refresh`,
            turnTimerMessageId: `${targetChatId}-same-query-refresh-timer`,
            text: 'Live delta discussion refreshed with deltastartneedle.',
          },
        }),
      {
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        targetChatId: chatId,
      },
    );
    expect(sameQueryRefreshResult.outcome).toBe('applied');
    await expect(transcriptSection).toContainText(
      'Live delta discussion refreshed',
      { timeout: 15_000 },
    );
    const sectionRemovals = await window.evaluate(() => {
      window.__CANOPY_E2E_CONTENT_SECTION_OBSERVER__?.disconnect();
      return window.__CANOPY_E2E_CONTENT_SECTION_REMOVALS__ ?? 0;
    });
    expect(sectionRemovals).toBe(0);
    const appendResult = await window.evaluate(
      async ({ projectId, worktreeId, targetChatId }) =>
        window.api.chat.command({
          schemaVersion: 1,
          commandId: 'e2e-search-delta-append',
          projectId,
          worktreeId,
          command: {
            type: 'chat.commit_terminal_initial_prompt',
            chatId: targetChatId,
            userMessageId: `${targetChatId}-append`,
            turnTimerMessageId: `${targetChatId}-append-timer`,
            text: 'The newly appended deltaappendneedle is searchable.',
          },
        }),
      {
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        targetChatId: chatId,
      },
    );
    expect(appendResult.outcome).toBe('applied');
    await input.fill('deltaappendneedle');
    await expect(transcriptSection).toContainText('Live delta discussion', {
      timeout: 15_000,
    });

    const resetResult = await window.evaluate(
      async ({ projectId, worktreeId, targetChatId, atMessageId }) =>
        window.api.chat.command({
          schemaVersion: 1,
          commandId: 'e2e-search-delta-reset-before-replacement',
          projectId,
          worktreeId,
          command: {
            type: 'chat.reset_to_point',
            chatId: targetChatId,
            userMessageId: atMessageId,
          },
        }),
      {
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        targetChatId: chatId,
        atMessageId: initialTab.messages.find(
          (message) => message.role === 'user',
        ).id,
      },
    );
    expect(resetResult.outcome).toBe('applied');

    const replacementResult = await window.evaluate(
      async ({ projectId, worktreeId, targetChatId }) =>
        window.api.chat.command({
          schemaVersion: 1,
          commandId: 'e2e-search-delta-replacement',
          projectId,
          worktreeId,
          command: {
            type: 'chat.commit_terminal_initial_prompt',
            chatId: targetChatId,
            userMessageId: `${targetChatId}-replacement`,
            turnTimerMessageId: `${targetChatId}-replacement-timer`,
            text: 'The edited deltaeditneedle replaces the appended phrase.',
          },
        }),
      {
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        targetChatId: chatId,
      },
    );
    expect(replacementResult.outcome).toBe('applied');
    await input.fill('deltaeditneedle');
    await expect(transcriptSection).toContainText('Live delta discussion', {
      timeout: 15_000,
    });
    await input.fill('deltaappendneedle');
    await expect(
      transcriptSection.getByRole('option', {
        name: /Live delta discussion/,
      }),
    ).toHaveCount(0, { timeout: 15_000 });

    const deleteResult = await window.evaluate(
      async ({ projectId, worktreeId, targetChatId, atMessageId }) =>
        window.api.chat.command({
          schemaVersion: 1,
          commandId: 'e2e-search-delta-delete-replacement',
          projectId,
          worktreeId,
          command: {
            type: 'chat.reset_to_point',
            chatId: targetChatId,
            userMessageId: atMessageId,
          },
        }),
      {
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        targetChatId: chatId,
        atMessageId: initialTab.messages.find(
          (message) => message.role === 'user',
        ).id,
      },
    );
    expect(deleteResult.outcome).toBe('applied');
    await input.fill('deltaeditneedle');
    await expect(
      transcriptSection.getByRole('option', {
        name: /Live delta discussion/,
      }),
    ).toHaveCount(0, { timeout: 15_000 });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('in-flight turn text stays searchable without rewriting committed search text', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-palette-in-flight-'),
  );
  const chatId = 'in-flight-search-chat';
  const turnId = `${chatId}-turn-user`;
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'codex',
    activeTabId: chatId,
    tabs: [
      {
        id: chatId,
        title: 'In-flight search discussion',
        providerType: 'codex',
        model: 'gpt-6-sol',
        messages: [
          {
            id: `${chatId}-history-user`,
            role: 'user',
            timestamp: Date.parse('2026-09-25T11:00:00.000Z'),
            blocks: [
              { type: 'text', text: 'Where is the harborcommittedneedle?' },
            ],
          },
          {
            id: `${chatId}-history-assistant`,
            role: 'assistant',
            timestamp: Date.parse('2026-09-25T11:00:05.000Z'),
            blocks: [
              {
                type: 'text',
                text: 'The harborcommittedneedle sits by the lanternsharedneedle.',
              },
            ],
          },
          {
            id: turnId,
            role: 'user',
            timestamp: Date.parse('2026-09-25T12:00:00.000Z'),
            blocks: [{ type: 'text', text: 'Continue the survey.' }],
          },
        ],
      },
    ],
  });
  const searchDbPath = path.join(userDataDir, 'derived', 'chat-search.sqlite');
  const readSearchIndex = (sql, ...params) => {
    const db = new DatabaseSync(searchDbPath, { readOnly: true });
    try {
      return db.prepare(sql).all(...params);
    } finally {
      db.close();
    }
  };
  const committedRows = () =>
    readSearchIndex(
      'SELECT rowid AS id, body FROM chat_fts WHERE chat_fts MATCH ?',
      'harborcommittedneedle',
    ).map((row) => ({ id: Number(row.id), body: row.body }));
  const inFlightBodies = () =>
    readSearchIndex(
      `SELECT f.body AS body FROM chat_docs d
       JOIN chat_fts f ON f.rowid = d.active_fts_rowid
       WHERE d.chat_id = ? AND d.source = 'live'`,
      chatId,
    ).map((row) => row.body);

  const { electronApp } = await launchCanopy({ userDataDir });
  const inject = (data) =>
    injectChatEvent(electronApp, {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId,
      providerType: 'codex',
      turnUserMessageId: turnId,
      data: { canopy_turn_user_message_id: turnId, ...data },
    });
  const draft = (id, text) =>
    inject({
      type: 'assistant',
      message: { id, role: 'assistant', content: [{ type: 'text', text }] },
    });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await expect(window.getByTestId('panel-content-chat')).toBeVisible();

    const input = await openPalette(window);
    const chatResults = window
      .locator('[data-palette-section="transcripts"]')
      .getByRole('option', { name: /In-flight search discussion/ });
    await input.fill('harborcommittedneedle');
    await expect(chatResults).toHaveCount(1, { timeout: 15_000 });

    await inject({ type: 'canopy_user_prompt' });
    await publishTurnLifecycle(electronApp, {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId,
      turnUserMessageId: turnId,
      phase: 'start',
    });
    await draft(
      `${chatId}-draft-1`,
      'The firstdraftneedle meets lanternsharedneedle.',
    );
    await input.fill('firstdraftneedle');
    await expect(chatResults).toHaveCount(1, { timeout: 15_000 });
    const [committedRow] = committedRows();
    expect(committedRow?.id).toBeGreaterThan(0);

    // Another revision of the same turn changes only the active sidecar. The
    // row holding committed text is neither rewritten nor given draft text.
    await draft(`${chatId}-draft-2`, 'The seconddraftneedle follows.');
    await input.fill('seconddraftneedle');
    await expect(chatResults).toHaveCount(1, { timeout: 15_000 });
    expect(committedRows()).toEqual([
      {
        id: committedRow?.id,
        body: expect.not.stringContaining('draftneedle'),
      },
    ]);
    expect(inFlightBodies()).toEqual([
      expect.stringMatching(/firstdraftneedle[\s\S]*seconddraftneedle/),
    ]);
    // Committed and in-flight text both match; the chat is listed once.
    await input.fill('lanternsharedneedle');
    await expect(chatResults).toHaveCount(1, { timeout: 15_000 });

    await publishTurnLifecycle(electronApp, {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId,
      turnUserMessageId: turnId,
      phase: 'end',
    });
    await inject({ type: 'codex', event: { type: 'turn.completed' } });
    await expect.poll(inFlightBodies, { timeout: 15_000 }).toEqual([]);
    for (const needle of ['firstdraftneedle', 'seconddraftneedle']) {
      await input.fill(needle);
      await expect(chatResults).toHaveCount(1, { timeout: 15_000 });
    }
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
