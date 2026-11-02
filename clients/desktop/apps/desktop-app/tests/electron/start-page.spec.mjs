import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const WORKSPACE_ID = 'cowork-default';
const CODE_WORKSPACE_ID = 'demo-ts-pnpm-vite';
const CODE_WORKTREE_ID = 'demo-main';
const START_PAGE_ENV = {
  CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
    'canopy-desktop-start-page': true,
  }),
};

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function seedCoworkStartPage(
  userDataDir,
  {
    startPage = { kind: 'file', path: 'README.md' },
    files = {
      'README.md': '# Start here\n\nThis is the project start page.\n',
    },
  } = {},
) {
  const workspaceDir = path.join(userDataDir, 'workspaces', WORKSPACE_ID);
  writeJson(path.join(userDataDir, 'workspaces', 'index.json'), {
    version: 1,
    workspaces: [
      {
        id: WORKSPACE_ID,
        name: 'Start Page Project',
        type: 'cowork',
        color: '#7C9B6D',
        collapsed: false,
        order: 0,
        cowork: {
          createdAt: '2026-09-30T12:00:00.000Z',
          archiveRetentionDays: null,
          startPage,
        },
      },
    ],
  });
  writeJson(path.join(workspaceDir, 'workspace.json'), {
    version: 1,
    type: 'cowork',
    repos: [],
    cowork: {
      createdAt: '2026-09-30T12:00:00.000Z',
      archiveRetentionDays: null,
      startPage,
    },
  });
  writeJson(path.join(workspaceDir, 'work-entries.json'), {
    version: 1,
    entries: [],
  });
  mkdirSync(path.join(workspaceDir, 'home'), { recursive: true });
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(workspaceDir, 'home', relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, 'utf8');
  }
}

function seedCodeStartPage({
  createWorktrees = true,
  mode,
  startPage = { kind: 'file', path: 'README.md' },
} = {}) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-code-start-page-'),
  );
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    createWorktrees,
  });
  const workspacePath = path.join(
    userDataDir,
    'workspaces',
    CODE_WORKSPACE_ID,
    'workspace.json',
  );
  const workspace = JSON.parse(readFileSync(workspacePath, 'utf8'));
  if (startPage === null) {
    delete workspace.startPage;
  } else {
    workspace.startPage = startPage;
  }
  writeJson(workspacePath, workspace);
  if (mode && createWorktrees) {
    writeJson(
      path.join(
        userDataDir,
        'workspaces',
        CODE_WORKSPACE_ID,
        'worktree-data',
        CODE_WORKTREE_ID,
        'panel-layout-mode.json',
      ),
      { version: 1, mode },
    );
  }
  return userDataDir;
}

function launchStartPageCanopy(userDataDir) {
  return launchCanopy({ userDataDir, env: START_PAGE_ENV });
}

async function openCodeWorkspace(window) {
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await app.selectWorktree(CODE_WORKTREE_ID);
  await expect(window.getByTestId('panel-grid-root')).toBeVisible({
    timeout: 20_000,
  });
}

async function expectBrowserStartPage({
  startPage,
  files,
  expectedUrl,
  afterOpen,
}) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-start-page-'));
  seedCoworkStartPage(userDataDir, { startPage, files });
  const { electronApp } = await launchStartPageCanopy(userDataDir);

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    const workspaceLabel = window
      .getByTestId('app-sidebar')
      .getByText('Start Page Project', { exact: true });
    await expect(workspaceLabel).toBeVisible({ timeout: 15_000 });
    await workspaceLabel.hover();
    await window.getByTestId('sidebar-section-chats-new-chat').click();
    await expect(window.getByTestId('cowork-top-bar')).toBeVisible({
      timeout: 20_000,
    });

    // The start page must follow New Chat promptly. Tab creation used to
    // stall for a fixed two seconds on debugger commands a never-navigated
    // view cannot answer, so anything near that bound is the regression.
    await expect(
      window.locator('[role="tab"][data-panel-kind="chat"]'),
    ).toBeVisible({ timeout: 20_000 });
    const chatTabShownAt = Date.now();
    const browserTab = window.locator(
      '[role="tab"][data-panel-kind="browser"]',
    );
    await expect(browserTab).toBeVisible({ timeout: 20_000 });
    expect(Date.now() - chatTabShownAt).toBeLessThan(1_500);
    await expect(browserTab).toHaveAttribute('data-active', 'true');
    await expect(window.getByTestId('browser-url-input')).toHaveValue(
      expectedUrl,
    );
    await expect(
      window.locator('[role="tab"][data-panel-kind="chat"]'),
    ).toBeVisible();
    await afterOpen?.({ window, browserTab });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
}

test('a Cowork start page saved in Settings opens in the next work entry', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-start-page-'));
  seedCoworkStartPage(userDataDir, { startPage: null });
  const { electronApp } = await launchStartPageCanopy(userDataDir);

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    // The default Cowork workspace is the Chats section, not a project row,
    // so its settings open from that section's header.
    const workspaceLabel = window
      .getByTestId('app-sidebar')
      .getByText('Start Page Project', { exact: true });
    await expect(workspaceLabel).toBeVisible({ timeout: 15_000 });
    await workspaceLabel.hover();
    await window.getByTestId('sidebar-section-chats-settings').click();
    const dialog = window
      .locator('[role="dialog"]')
      .filter({ has: window.locator('#chat-project-settings-title') });
    await expect(dialog).toBeVisible();
    await dialog.getByTestId('start-page-choice-trigger').click();
    await window.getByTestId('start-page-choice-file').click();
    await dialog
      .getByRole('button', { name: 'README.md', exact: true })
      .click();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toHaveCount(0);

    await workspaceLabel.hover();
    await window.getByTestId('sidebar-section-chats-new-chat').click();
    await expect(window.getByTestId('cowork-top-bar')).toBeVisible({
      timeout: 20_000,
    });

    const fileTab = window
      .locator('[data-testid^="panel-tab-panel-file-"]')
      .filter({ hasText: 'README.md' });
    const chatTab = window
      .locator('[data-testid^="panel-tab-panel-chat-"]')
      .filter({ hasText: 'New Chat' });
    await expect(fileTab).toBeVisible({ timeout: 20_000 });
    await expect(fileTab).toHaveAttribute('data-active', 'true');
    await expect(chatTab).toBeVisible();
    await expect(window.getByTestId('file-markdown-preview')).toContainText(
      'Start here',
    );
    // First, with New Chat beside it. The tab moves to the front once its
    // panel exists, so poll rather than sample the strip once.
    await expect
      .poll(async () =>
        fileTab.evaluate(
          (file, chat) =>
            (file.compareDocumentPosition(chat) &
              Node.DOCUMENT_POSITION_FOLLOWING) !==
            0,
          await chatTab.elementHandle(),
        ),
      )
      .toBe(true);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a configured start page leaves a fresh entry reusable', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-start-page-'));
  seedCoworkStartPage(userDataDir);
  const { electronApp } = await launchStartPageCanopy(userDataDir);

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await window.getByTestId('sidebar-section-chats').hover();
    const newChat = window.getByTestId('sidebar-section-chats-new-chat');
    await newChat.click();
    await expect(
      window.locator('[data-testid^="panel-tab-panel-file-"]').filter({
        hasText: 'README.md',
      }),
    ).toBeVisible({ timeout: 20_000 });

    const selected = window.locator(
      '[data-testid^="sidebar-work-entry-"][data-sidebar-selected-item]',
    );
    const firstTestId = await selected.getAttribute('data-testid');
    const entryId = firstTestId.replace('sidebar-work-entry-', '');
    const layoutPath = path.join(
      userDataDir,
      'workspaces',
      WORKSPACE_ID,
      'worktree-data',
      entryId,
      'panel-layout.json',
    );
    await expect
      .poll(() =>
        existsSync(layoutPath)
          ? JSON.parse(readFileSync(layoutPath, 'utf8')).hasUserChanges
          : null,
      )
      .toBe(false);
    await window.waitForTimeout(800);
    expect(JSON.parse(readFileSync(layoutPath, 'utf8')).hasUserChanges).toBe(
      false,
    );
    const entriesPath = path.join(
      userDataDir,
      'workspaces',
      WORKSPACE_ID,
      'work-entries.json',
    );
    await expect
      .poll(() => {
        const entries = JSON.parse(readFileSync(entriesPath, 'utf8')).entries;
        return entries.length === 1
          ? (entries[0].hasUserChanges ?? false)
          : 'missing';
      })
      .toBe(false);

    await window.getByTestId('sidebar-section-chats').hover();
    await newChat.click();
    await expect(selected).toHaveAttribute('data-testid', firstTestId);
    expect(JSON.parse(readFileSync(entriesPath, 'utf8')).entries).toHaveLength(
      1,
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a Cowork project without a start page still opens New Chat unchanged', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-start-page-'));
  seedCoworkStartPage(userDataDir, { startPage: null });
  const { electronApp } = await launchStartPageCanopy(userDataDir);

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    const workspaceLabel = window
      .getByTestId('app-sidebar')
      .getByText('Start Page Project', { exact: true });
    await expect(workspaceLabel).toBeVisible({ timeout: 15_000 });
    await workspaceLabel.hover();
    await window.getByTestId('sidebar-section-chats-new-chat').click();

    const chatTab = window
      .locator('[role="tab"][data-panel-kind="chat"]')
      .filter({ hasText: 'New Chat' });
    await expect(chatTab).toBeVisible({ timeout: 20_000 });
    await expect(chatTab).toHaveAttribute('data-active', 'true');
    await expect(
      window.locator('[role="tab"][data-panel-kind="file-diff"]'),
    ).toHaveCount(0);
    await expect(
      window.locator('[role="tab"][data-panel-kind="browser"]'),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a new Cowork work entry keeps its HTML start page open and active', async () => {
  test.setTimeout(120_000);
  await expectBrowserStartPage({
    startPage: { kind: 'file', path: 'index.html' },
    files: { 'index.html': '<h1>Start here</h1>' },
    expectedUrl: /\/index\.html$/,
  });
});

test('the tab menu over an HTML start page keeps the page on screen', async () => {
  test.setTimeout(120_000);
  await expectBrowserStartPage({
    startPage: { kind: 'file', path: 'index.html' },
    files: { 'index.html': '<h1>Start here</h1>' },
    expectedUrl: /\/index\.html$/,
    afterOpen: async ({ window, browserTab }) => {
      await expect(window.getByTestId('browser-pane-loading')).toHaveCount(0, {
        timeout: 20_000,
      });
      await browserTab.click({ button: 'right' });
      await expect(
        window.getByTestId('panel-tab-context-start-page'),
      ).toHaveText('Remove start page');
      // The menu covers the native view, so the pane swaps in a still of the
      // page. It must be the fast encoding: a slow one misses the pane's
      // capture deadline and leaves the page blank behind the menu.
      const freezeFrame = window.getByTestId('browser-pane-freeze-frame');
      await expect(freezeFrame).toBeVisible({ timeout: 10_000 });
      await expect(freezeFrame).toHaveAttribute('src', /^data:image\/jpeg;/);
      await window.keyboard.press('Escape');
      await expect(freezeFrame).toHaveCount(0);
    },
  });
});

test('a new Cowork work entry keeps its URL start page open and active', async () => {
  test.setTimeout(120_000);
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<h1>Start here</h1>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Start-page test server did not bind a TCP port');
  }
  const url = `http://127.0.0.1:${address.port}/start`;

  try {
    await expectBrowserStartPage({
      startPage: { kind: 'url', url },
      files: {},
      expectedUrl: url,
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a code-project local override opens README first and active', async () => {
  test.setTimeout(120_000);
  const userDataDir = seedCodeStartPage();
  const { electronApp } = await launchStartPageCanopy(userDataDir);

  try {
    const window = await electronApp.firstWindow();
    await openCodeWorkspace(window);

    const fileTab = window
      .locator('[data-testid^="panel-tab-panel-file-"]')
      .filter({ hasText: 'README.md' });
    await expect(fileTab).toBeVisible({ timeout: 20_000 });
    await expect(fileTab).toHaveAttribute('data-active', 'true');
    await expect(fileTab.getByTestId('panel-tab-start-page')).toBeVisible();
    await expect(
      window.locator('[role="tab"][data-panel-kind="chat"]'),
    ).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('setting README from its context menu marks the tab as the start page', async () => {
  test.setTimeout(120_000);
  // The file tree lives in the Minimal layout's Side panel; the Activity rail
  // has none.
  const userDataDir = seedCodeStartPage({ mode: 'minimal', startPage: null });
  const { electronApp } = await launchStartPageCanopy(userDataDir);

  try {
    const window = await electronApp.firstWindow();
    await openCodeWorkspace(window);
    const sidePanelToggle = window.getByTestId(
      'workspace-layout-side-panel-toggle',
    );
    if (
      (await sidePanelToggle.getAttribute('aria-label')) !==
      'Collapse side panel'
    ) {
      await sidePanelToggle.click();
    }
    await window.getByTestId('side-panel-empty-item-file-explorer').click();
    const explorerTab = window
      .getByTestId('panel-group-group-extras')
      .locator('[role="tab"][data-panel-kind="file-explorer"]');
    await explorerTab.click();

    const readme = window.locator(
      '[data-testid="files-tree-row"][data-path="README.md"]',
    );
    await expect(readme).toBeVisible({ timeout: 20_000 });
    await readme.click();
    const fileTab = window
      .locator('[role="tab"][data-panel-kind="file-diff"]')
      .filter({ hasText: 'README.md' });
    await expect(fileTab).toBeVisible({ timeout: 20_000 });

    // README opened over the tree in the same panel; go back to the tree.
    await explorerTab.click();
    await readme.click({ button: 'right' });
    const action = window.getByTestId('files-tree-action-start-page');
    await expect(action).toHaveText('Set as start page');
    await action.click();
    await expect(fileTab.getByTestId('panel-tab-start-page')).toBeVisible({
      timeout: 20_000,
    });
    await expect
      .poll(() => {
        const workspace = JSON.parse(
          readFileSync(
            path.join(
              userDataDir,
              'workspaces',
              CODE_WORKSPACE_ID,
              'workspace.json',
            ),
            'utf8',
          ),
        );
        return workspace.startPage;
      })
      .toEqual({ kind: 'file', path: 'README.md' });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Minimal mode opens the start page active in the Side panel', async () => {
  test.setTimeout(120_000);
  const userDataDir = seedCodeStartPage({ mode: 'minimal' });
  const { electronApp } = await launchStartPageCanopy(userDataDir);

  try {
    const window = await electronApp.firstWindow();
    await openCodeWorkspace(window);

    const side = window.getByTestId('panel-group-group-extras');
    await expect(side).toBeVisible({ timeout: 20_000 });
    const fileTab = side
      .locator('[data-testid^="panel-tab-panel-file-"]')
      .filter({ hasText: 'README.md' });
    await expect(fileTab).toBeVisible();
    await expect(fileTab).toHaveAttribute('data-active', 'true');
    await expect(
      window.getByTestId('workspace-layout-side-panel-toggle'),
    ).toHaveAttribute('aria-label', 'Collapse side panel');
    await expect(
      window
        .getByTestId('panel-group-group-chat')
        .locator('[role="tab"][data-panel-kind="chat"]'),
    ).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a prompt from Home keeps the newly created chat focused', async () => {
  test.setTimeout(180_000);
  const userDataDir = seedCodeStartPage({ createWorktrees: false });
  const { electronApp } = await launchStartPageCanopy(userDataDir);

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await window.getByTestId('sidebar-create-task').click();
    const home = window.getByTestId('page-home');
    await expect(home).toBeVisible();
    await expect(home.getByTestId('home-surface')).toHaveAttribute(
      'data-workspace-selected',
      'true',
    );

    const prompt = 'Explain the project entry point.';
    await home.getByTestId('home-composer-editor').fill(prompt);
    await home.getByTestId('home-send-button').click();
    await expect(home).toHaveCount(0);

    const chat = window.getByTestId('panel-content-chat');
    await expect(chat).toBeVisible({ timeout: 30_000 });
    await expect(chat.getByText(prompt).first()).toBeVisible({
      timeout: 30_000,
    });
    const chatTab = window.locator(
      '[role="tab"][data-panel-kind="chat"][data-active="true"]',
    );
    await expect(chatTab).toBeVisible();
    await expect(
      window.locator('[data-testid="panel-tab-start-page"]'),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
