// Browser tabs appear before their session exists.
//
// Opening a Browser tab used to wait for the main process to create the
// whole session (profile resolution, persistence, debugger attach, and up to
// 1.5s of first-page load) before the panel was even placed, so the click
// felt dead. Every open path now places the bound tab immediately, with its
// URL prefilled and a labelled loading state, and the session is created in
// the background.
//
// Each flow arms `__CANOPY_E2E_BROWSER_CREATE_GATE__`, which holds
// `BrowserService.create` in the E2E build, and asserts the tab is already on
// screen while creation is held. Releasing the gate must then finish the
// open normally. Covered paths:
//   - the outer `+` Add panel menu (blank tab)
//   - a detected dev-server `Open` action
//   - the file viewer's `Open in browser` action for an HTML file
//   - an ordinary app link routed into the built-in browser
//   - the agent `browser.open` action (main-process worktree dispatcher)
//   - the App Advisor `browser.open` action (renderer dispatcher)
//   - an agent ShowFiles request for an HTML page
//
// Determinism: demo workspaces, the chat and page files are seeded from
// fixtures, pages are served from an in-test loopback server, and agent
// requests use the production dispatch seams. No live agent or network.
//
//   pnpm run test:electron:built browser-open-latency.spec.mjs --reporter=line

import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import { closeCanopy } from './launchCanopy.mjs';
import {
  DEFAULT_GROUP_IDS,
  SEEDED_CHAT_TAB_ID,
  collectLeaves,
  getLayout,
  seedPanelWorktree,
} from './panelHarness.mjs';
import { injectScriptRunEvent } from './seeders/index.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const PAGE_TITLE = 'Open latency page';
const HTML_TITLE = 'Open latency file';

/** Serves one deterministic page on a loopback port. */
async function startPageServer(headScript = '') {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(
      `<!doctype html><html><head><title>${PAGE_TITLE}</title>${headScript}</head>` +
        '<body><h1>Ready</h1></body></html>',
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    port,
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function createGate(electronApp, kind) {
  return electronApp.evaluate((_electron, operation) => {
    if (typeof globalThis.__CANOPY_E2E_BROWSER_CREATE_GATE__ !== 'function')
      throw new Error('Missing browser creation gate fixture');
    return globalThis.__CANOPY_E2E_BROWSER_CREATE_GATE__({ kind: operation });
  }, kind);
}

/** Bound browser ids across the worktree's panel layout. */
async function browserIds(window) {
  const layout = await getLayout(window);
  if (!layout) return [];
  return collectLeaves(layout.root).flatMap((leaf) =>
    leaf.panels
      .filter((panel) => panel.kind === 'browser')
      .map((panel) => panel.instance?.browserId)
      .filter(Boolean),
  );
}

/** Waits for exactly one browser tab that was not bound before. */
async function newBrowserId(window, before) {
  let found;
  await expect
    .poll(async () => {
      const added = (await browserIds(window)).filter(
        (id) => !before.includes(id),
      );
      found = added[0];
      return added.length;
    })
    .toBe(1);
  return found;
}

/**
 * Holds session creation, runs `open`, and asserts the new tab is placed with
 * its prefilled URL and loading label (`null`: the blank empty state) while
 * creation is still held, without the tab's loading dot. `whileHeld` runs
 * before release. Returns the new browser id after releasing the gate.
 */
async function expectTabBeforeSession(
  electronApp,
  window,
  { open, url, label, backgroundTabLabel = undefined, whileHeld = undefined },
) {
  const before = await browserIds(window);
  await createGate(electronApp, 'arm');
  let browserId;
  try {
    // Settled later, after the gate is released; kept observed meanwhile so a
    // rejection surfaces at the await instead of as an unhandled rejection.
    const pending = Promise.resolve()
      .then(open)
      .then(
        () => undefined,
        (error) => error,
      );
    browserId = await newBrowserId(window, before);
    const pane = window.getByTestId(`browser-pane-${browserId}`);
    const tab = window.getByTestId(`panel-tab-panel-browser-${browserId}`);
    await expect(tab).toBeVisible();
    if (backgroundTabLabel !== undefined) {
      // Agent opens keep the user's focus: the tab is placed (and labelled
      // with its URL) beside the active one instead of being selected.
      await expect(tab).toContainText(backgroundTabLabel);
    } else {
      await expect(pane).toBeVisible();
    }
    const displayedAddress =
      url === '' || url === 'about:blank'
        ? ''
        : url.startsWith('file:')
          ? decodeURIComponent(new URL(url).pathname.split('/').pop())
          : new URL(url).host;
    await expect(pane.getByTestId('browser-url-input')).toHaveValue(
      displayedAddress,
    );
    if (label === null) {
      await expect(pane.getByTestId('browser-pane-loading')).toHaveCount(0);
      await expect(pane.getByTestId('browser-pane-empty')).toHaveText(
        'Enter a URL to start.',
      );
    } else {
      await expect(pane.getByTestId('browser-pane-loading')).toHaveText(label);
    }
    // Setting up the session is the pane's state, not a page load.
    await expect(pane).toHaveAttribute('data-browser-state', 'opening');
    await expect(
      window.getByTestId(`panel-tab-browser-loading-${browserId}`),
    ).toHaveCount(0);
    // Creation really is held: the tab did not wait for it.
    expect((await createGate(electronApp, 'status')).entered).toBeGreaterThan(
      0,
    );
    if (whileHeld) await whileHeld(pane, browserId);
    await createGate(electronApp, 'release');
    const failure = await pending;
    if (failure) throw failure;
  } finally {
    await createGate(electronApp, 'release');
  }
  return browserId;
}

/** Resolves once a native browser view on exactly `url` shows `title`. */
async function expectPageLoaded(
  electronApp,
  url,
  title,
  excludedContents = [],
) {
  await expect
    .poll(
      () =>
        electronApp.evaluate(
          ({ webContents }, { pageUrl, pageTitle, excludedIds }) =>
            webContents
              .getAllWebContents()
              .some(
                (contents) =>
                  !excludedIds.includes(contents.id) &&
                  contents.getURL() === pageUrl &&
                  contents.getTitle() === pageTitle,
              ),
          { pageUrl: url, pageTitle: title, excludedIds: excludedContents },
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
}

function sendRendererTool(electronApp, request) {
  return electronApp.evaluate(
    async ({ BrowserWindow, ipcMain }, rendererRequest) => {
      const responseChannel = 'app-advisor:tool-response';
      const mainWindow = BrowserWindow.getAllWindows().find(
        (candidate) =>
          !candidate.webContents.getURL().includes('surface=app-advisor'),
      );
      if (!mainWindow) throw new Error('Main window not found');
      ipcMain.removeHandler(responseChannel);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Timed out waiting for the renderer tool')),
          30_000,
        );
        ipcMain.handle(responseChannel, (_event, candidate) => {
          if (candidate?.requestId !== rendererRequest.requestId) return;
          clearTimeout(timer);
          resolve(candidate);
        });
        mainWindow.webContents.send(
          'app-advisor:tool-request',
          rendererRequest,
        );
      });
    },
    request,
  );
}

function showFiles(electronApp, requestId, files) {
  return sendRendererTool(electronApp, {
    kind: 'show_files',
    requestId,
    payload: {
      target: { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
      origin: {
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        chatTabId: SEEDED_CHAT_TAB_ID,
      },
      files,
    },
  });
}

function writeHtmlPage(worktreePath) {
  const siteDir = path.join(worktreePath, 'latency-site');
  mkdirSync(siteDir, { recursive: true });
  writeFileSync(
    path.join(siteDir, 'index.html'),
    `<!doctype html><html><head><title>${HTML_TITLE}</title></head>` +
      '<body><h1>File page</h1></body></html>\n',
  );
  return path.join(siteDir, 'index.html');
}

test.describe('Browser tabs open before their session exists', () => {
  test('task removal drains an admitted profile-switch recovery before deleting browser metadata', async () => {
    const { electronApp, userDataDir, window, demoSeed } =
      await seedPanelWorktree();
    const catalogPath = path.join(
      userDataDir,
      'browser-profiles',
      'catalog.json',
    );
    const statePath = path.join(
      userDataDir,
      'workspaces',
      WORKSPACE_ID,
      'worktree-data',
      WORKTREE_ID,
      'browser-state.json',
    );
    try {
      writeHtmlPage(demoSeed.workspaces[0].worktreePath);
      expect(
        await showFiles(electronApp, 'recovery-html-source', [
          { path: 'latency-site/index.html', view: 'raw' },
        ]),
      ).toMatchObject({ ok: true });
      const before = await browserIds(window);
      await window.getByTestId('file-viewer-open-in-browser').click();
      const sourceId = await newBrowserId(window, before);
      await expect(
        window.getByTestId(`browser-pane-${sourceId}`),
      ).toHaveAttribute('data-browser-state', 'live');
      const source = await electronApp.evaluate(async () => {
        const response =
          await globalThis.__CANOPY_E2E_DISPATCH_BROWSER_ACTION__({
            action: { type: 'browser.list' },
            path: 'scoped',
            destination: {
              projectId: 'demo-ts-pnpm-vite',
              worktreeId: 'demo-main',
              chatId: 'seed-chat',
            },
          });
        return response.result.browsers[0];
      });
      await expectPageLoaded(electronApp, source.url, HTML_TITLE);
      const operationId = 'retirement-recovery-fixture';
      const journalPath = path.join(
        userDataDir,
        'browser-profile-switches',
        `${operationId}.json`,
      );
      mkdirSync(path.dirname(journalPath), { recursive: true });
      writeFileSync(
        journalPath,
        JSON.stringify({
          schemaVersion: 1,
          operationId,
          digest: 'a'.repeat(64),
          createdAt: Date.now(),
          stage: 'close_intent',
          source,
          target: {
            ...source,
            profile: {
              ...source.profile,
              runtimeGeneration: source.profile.runtimeGeneration + 1,
            },
          },
          mode: 'replace',
        }),
      );
      // Hold the actual journal read, including the task open before view allocation.
      // The production retirement path must drain it while owning the workspace lock.
      await electronApp.evaluate((_electron, filename) => {
        const fs = process.getBuiltinModule('node:fs/promises');
        const { syncBuiltinESMExports } =
          process.getBuiltinModule('node:module');
        const original = fs.readFile;
        const gate = new Promise((resolve) => {
          globalThis.__releaseRetirementRecovery = resolve;
        });
        globalThis.__retirementRecoveryEntered = false;
        fs.readFile = async function (...args) {
          const result = await original.apply(this, args);
          if (String(args[0]) === filename) {
            globalThis.__retirementRecoveryEntered = true;
            await gate;
          }
          return result;
        };
        syncBuiltinESMExports();
        globalThis.__restoreRetirementRecovery = () => {
          fs.readFile = original;
          syncBuiltinESMExports();
          globalThis.__releaseRetirementRecovery();
        };
      }, journalPath);
      expect(
        await showFiles(electronApp, 'recovery-html-reopen', [
          { path: 'latency-site/index.html', view: 'raw' },
        ]),
      ).toMatchObject({ ok: true });
      await window.getByTestId('file-viewer-open-in-browser').click();
      await expect
        .poll(() =>
          electronApp.evaluate(() => globalThis.__retirementRecoveryEntered),
        )
        .toBe(true);
      const row = window.locator(
        `[data-testid="worktree-row"][data-worktree-id="${WORKTREE_ID}"]`,
      );
      await row.hover();
      await row.getByTestId('worktree-actions-menu-button').click();
      await window.getByTestId('worktree-actions-menu-delete').click();
      const dialog = window.getByRole('dialog', { name: /^Delete worktree/ });
      await expect(dialog).toBeVisible();
      await dialog.getByTestId('worktree-removal-preserve-branch').click();
      const retirement = () =>
        Object.values(
          JSON.parse(readFileSync(catalogPath, 'utf8')).retirements,
        ).find((entry) => entry.scope.worktreeId === WORKTREE_ID);
      await expect.poll(() => retirement()?.state).toBe('prepared');
      await window.waitForTimeout(300);
      expect(retirement()?.state).toBe('prepared');
      await electronApp.evaluate(() =>
        globalThis.__restoreRetirementRecovery(),
      );
      await expect
        .poll(() => retirement()?.state, { timeout: 60_000 })
        .toBe('committed');
      await expect.poll(() => existsSync(statePath)).toBe(false);
      const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
      expect(journal.stage).toBe('close_intent');
      expect(journal.result).toBeUndefined();
    } finally {
      await electronApp
        .evaluate(() => globalThis.__restoreRetirementRecovery?.())
        .catch(() => undefined);
      await closeCanopy(electronApp, userDataDir);
    }
  });

  for (const mode of ['open', 'replace', 'new-tab']) {
    test(`a file browser ${mode} waiting for workspace persistence leaves profile inventory responsive`, async () => {
      const { electronApp, userDataDir, window, demoSeed } =
        await seedPanelWorktree();
      let inventory;
      let pendingSwitch;
      try {
        const worktreePath = demoSeed?.workspaces?.[0]?.worktreePath;
        if (!worktreePath) throw new Error('Expected a seeded worktree path.');
        writeHtmlPage(worktreePath);
        await window.evaluate(() => window.api.browser.profiles.list());
        expect(
          await showFiles(electronApp, 'contended-html-source', [
            { path: 'latency-site/index.html', view: 'raw' },
          ]),
        ).toMatchObject({ ok: true });

        let sourceId;
        let source;
        let named;
        if (mode !== 'open') {
          const before = await browserIds(window);
          await window.getByTestId('file-viewer-open-in-browser').click();
          sourceId = await newBrowserId(window, before);
          await expectPageLoaded(
            electronApp,
            pathToFileURL(path.join(worktreePath, 'latency-site/index.html'))
              .href,
            HTML_TITLE,
          );
          source = await window.evaluate(async (browserId) => {
            const { state } = await window.api.browser.loadWorktreeState({
              projectId: 'demo-ts-pnpm-vite',
              worktreeId: 'demo-main',
            });
            return state.browsers.find((browser) => browser.id === browserId);
          }, sourceId);
          named = await window.evaluate(() =>
            window.api.browser.profiles.create({
              operationId: crypto.randomUUID(),
              input: { displayName: 'Contended profile' },
            }),
          );
        }
        const existingContents = await electronApp.evaluate(({ webContents }) =>
          webContents.getAllWebContents().map((contents) => contents.id),
        );
        await electronApp.evaluate(async (_electron, projectId) => {
          const activity = globalThis.__CANOPY_E2E_WORKSPACE_ACTIVITY__;
          if (!activity)
            throw new Error('Workspace activity fixture is unavailable');
          const held = new Promise((resolve) => {
            globalThis.__browserWorkspaceHeld = resolve;
          });
          const gate = new Promise((resolve) => {
            globalThis.__releaseBrowserWorkspace = resolve;
          });
          globalThis.__browserWorkspaceOperation =
            activity.withArchivedWorkspaceOperationLock(projectId, async () => {
              globalThis.__browserWorkspaceHeld();
              await gate;
            });
          await held;
        }, WORKSPACE_ID);

        const before = await browserIds(window);
        let browserId;
        if (mode === 'open') {
          await window.getByTestId('file-viewer-open-in-browser').click();
          browserId = await newBrowserId(window, before);
          await expect(
            window.getByTestId(`browser-pane-${browserId}`),
          ).toHaveAttribute('data-browser-state', 'opening');
        } else if (mode === 'replace') {
          await window.getByTestId('browser-more').click();
          await window.getByTestId('browser-more-profile').hover();
          await window
            .getByTestId(`browser-profile-option-${named.profileId}`)
            .click();
        } else {
          // The graduated submenu switches in place. New-tab remains a backend
          // operation, so exercise that mode through its real preload API.
          pendingSwitch = window
            .evaluate((request) => window.api.browser.switchProfile(request), {
              operationId: 'latency-new-tab-switch',
              browserId: sourceId,
              expectedRuntimeGeneration: source.profile.runtimeGeneration,
              selection: { kind: 'named', profileId: named.profileId },
              mode: 'new-tab',
            })
            .then(
              (result) => ({ result }),
              (error) => ({ error: String(error) }),
            );
        }
        // Allocation follows profile/session resolution and precedes binding persistence.
        await expect
          .poll(() =>
            electronApp.evaluate(
              ({ webContents }, ids) =>
                webContents
                  .getAllWebContents()
                  .some((contents) => !ids.includes(contents.id)),
              existingContents,
            ),
          )
          .toBe(true);

        // Repeated reads also catch a read that raced ahead of the first binding commit.
        inventory = window.evaluate(async () => {
          for (let index = 0; index < 5; index += 1)
            await window.api.browser.profiles.list();
          return 'responsive';
        });
        let result;
        void inventory.then(
          (value) => {
            result = value;
          },
          (error) => {
            result = String(error);
          },
        );
        await expect.poll(() => result, { timeout: 5_000 }).toBe('responsive');

        await electronApp.evaluate(async () => {
          globalThis.__releaseBrowserWorkspace();
          await globalThis.__browserWorkspaceOperation;
        });
        if (mode === 'replace') browserId = sourceId;
        else if (mode === 'new-tab') {
          const completed = await pendingSwitch;
          expect(completed).not.toHaveProperty('error');
          expect(completed.result).toMatchObject({
            status: 'complete',
            browser: { profile: { resolvedProfileId: named.profileId } },
          });
          browserId = completed.result.browser.id;
          expect(browserId).not.toBe(sourceId);
          // The API creates a session; the retired picker owned panel placement.
          await expect
            .poll(async () => {
              const { state } = await window.evaluate(() =>
                window.api.browser.loadWorktreeState({
                  projectId: 'demo-ts-pnpm-vite',
                  worktreeId: 'demo-main',
                }),
              );
              return state.browsers.find((browser) => browser.id === browserId);
            })
            .toMatchObject({
              id: browserId,
              status: 'ready',
              url: pathToFileURL(
                path.join(worktreePath, 'latency-site/index.html'),
              ).href,
              profile: { resolvedProfileId: named.profileId },
            });
        }
        await expectPageLoaded(
          electronApp,
          pathToFileURL(path.join(worktreePath, 'latency-site/index.html'))
            .href,
          HTML_TITLE,
          existingContents,
        );
        if (mode !== 'new-tab') {
          await expect(
            window.getByTestId(`browser-pane-${browserId}`),
          ).toHaveAttribute('data-browser-state', 'live');
        }
        if (mode === 'replace') {
          await window.getByTestId('browser-more').click();
          await window.getByTestId('browser-more-profile').hover();
          const selected = window.getByTestId(
            `browser-profile-option-${named.profileId}`,
          );
          await expect(selected).toHaveAttribute('aria-checked', 'true');
          await expect(selected).toHaveText('Contended profile');
        }
      } finally {
        await electronApp
          .evaluate(async () => {
            globalThis.__releaseBrowserWorkspace?.();
            await globalThis.__browserWorkspaceOperation;
          })
          .catch(() => undefined);
        await inventory?.catch(() => undefined);
        await pendingSwitch;
        await closeCanopy(electronApp, userDataDir);
      }
    });
  }

  test('user-initiated opens place the tab immediately', async () => {
    test.setTimeout(180_000);
    const page = await startPageServer();
    const launched = await seedPanelWorktree();
    const { electronApp, userDataDir, window } = launched;
    try {
      const worktreePath = launched.demoSeed?.workspaces?.[0]?.worktreePath;
      if (!worktreePath) throw new Error('Expected a seeded worktree path.');
      writeHtmlPage(worktreePath);

      // --- Add panel menu: a blank tab --------------------------------------
      // No loading state while it opens, unless a URL is submitted before the
      // session is ready.
      const typedUrl = `${page.url}?from=typed`;
      const blankId = await expectTabBeforeSession(electronApp, window, {
        url: '',
        label: null,
        whileHeld: async (pane, heldId) => {
          const input = pane.getByTestId('browser-url-input');
          await input.fill(typedUrl);
          await input.press('Enter');
          await expect(pane.getByTestId('browser-pane-loading')).toHaveText(
            `Loading 127.0.0.1:${page.port}…`,
          );
          await expect(input).toHaveValue(typedUrl);
          await expect(
            window.getByTestId(`panel-tab-browser-loading-${heldId}`),
          ).toHaveCount(0);
        },
        open: async () => {
          await window
            .getByTestId(`panel-add-tab-${DEFAULT_GROUP_IDS.terminal}`)
            .click();
          await window.getByTestId('panel-add-menu-item-browser').click();
          // The menu closes on placement, not after the session exists.
          await expect(window.getByTestId('panel-add-menu')).toBeHidden();
        },
      });
      await expectPageLoaded(electronApp, typedUrl, PAGE_TITLE);
      const blankPane = window.getByTestId(`browser-pane-${blankId}`);
      await expect(blankPane.getByTestId('browser-url-input')).toHaveValue(
        typedUrl,
      );
      // The pane leaves its loading state once the page has loaded.
      await expect(blankPane.getByTestId('browser-pane-loading')).toHaveCount(
        0,
        { timeout: 15_000 },
      );
      await expect(blankPane).toHaveAttribute('data-browser-state', 'live');

      // --- Dev-server Open --------------------------------------------------
      await injectScriptRunEvent(electronApp, {
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        script: {
          scriptKey: 'launch:project',
          scriptName: 'launch',
          label: 'Dev Server',
          command: 'npm run dev',
          lifecycle: 'launch',
          target: 'project',
        },
        invocation: 'manual-lifecycle',
        outputLines: ['VITE ready in 312 ms', `Local: ${page.url}`],
      });
      const openDevServer = window
        .getByRole('button', { name: `Open dev server ${page.url}` })
        .first();
      await expect(openDevServer).toBeVisible({ timeout: 15_000 });
      await expectTabBeforeSession(electronApp, window, {
        url: page.url,
        label: `Loading 127.0.0.1:${page.port}…`,
        open: () => openDevServer.click(),
      });
      await expectPageLoaded(electronApp, page.url, PAGE_TITLE);

      // --- File viewer: Open in browser ------------------------------------
      const source = await showFiles(electronApp, 'latency-html-source', [
        { path: 'latency-site/index.html', view: 'raw' },
      ]);
      expect(source).toMatchObject({ ok: true });
      const viewer = window
        .locator('[data-testid="panel-content-file-diff"]:visible')
        .filter({ hasText: 'index.html' });
      await expect(viewer).toBeVisible({ timeout: 30_000 });
      await expectTabBeforeSession(electronApp, window, {
        url: pathToFileURL(path.join(worktreePath, 'latency-site/index.html'))
          .href,
        label: 'Loading index.html…',
        open: () => viewer.getByTestId('file-viewer-open-in-browser').click(),
      });
      await expectPageLoaded(
        electronApp,
        pathToFileURL(path.join(worktreePath, 'latency-site/index.html')).href,
        HTML_TITLE,
      );

      // --- App link -----------------------------------------------------------
      await window.evaluate(() =>
        window.api.savePreferences({ openAppLinksInBuiltInBrowser: true }),
      );
      const linkUrl = `${page.url}?from=app-link`;
      await expectTabBeforeSession(electronApp, window, {
        url: linkUrl,
        label: `Loading 127.0.0.1:${page.port}…`,
        open: async () => {
          await window.evaluate((href) => {
            const anchor = document.createElement('a');
            anchor.href = href;
            anchor.target = '_blank';
            anchor.textContent = 'Open latency link';
            anchor.dataset.testid = 'browser-latency-app-link';
            document.body.append(anchor);
          }, linkUrl);
          await window.getByTestId('browser-latency-app-link').click();
        },
      });
      await expectPageLoaded(electronApp, linkUrl, PAGE_TITLE);
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await page.close();
    }
  });

  test('agent-initiated opens place the tab before the tool returns', async () => {
    test.setTimeout(180_000);
    const page = await startPageServer();
    const launched = await seedPanelWorktree();
    const { electronApp, userDataDir, window } = launched;
    try {
      const worktreePath = launched.demoSeed?.workspaces?.[0]?.worktreePath;
      if (!worktreePath) throw new Error('Expected a seeded worktree path.');
      writeHtmlPage(worktreePath);

      // --- Agent DispatchAction browser.open (main process) ------------------
      const agentUrl = `${page.url}?from=agent`;
      let agentResult;
      await expectTabBeforeSession(electronApp, window, {
        url: agentUrl,
        label: `Loading 127.0.0.1:${page.port}…`,
        open: () => {
          const dispatch = electronApp.evaluate(
            (_electron, input) =>
              globalThis.__CANOPY_E2E_DISPATCH_BROWSER_ACTION__(input),
            {
              path: 'scoped',
              action: { type: 'browser.open', url: agentUrl },
              destination: {
                projectId: WORKSPACE_ID,
                worktreeId: WORKTREE_ID,
                chatId: SEEDED_CHAT_TAB_ID,
              },
            },
          );
          return dispatch.then((result) => {
            agentResult = result;
          });
        },
      });
      expect(agentResult).toMatchObject({ ok: true });
      await expectPageLoaded(electronApp, agentUrl, PAGE_TITLE);

      // --- App Advisor browser.open (renderer dispatcher) --------------------
      const advisorUrl = `${page.url}?from=advisor`;
      let advisorResult;
      await expectTabBeforeSession(electronApp, window, {
        url: advisorUrl,
        label: `Loading 127.0.0.1:${page.port}…`,
        backgroundTabLabel: advisorUrl,
        open: () =>
          sendRendererTool(electronApp, {
            kind: 'dispatch_action',
            requestId: 'latency-advisor-open',
            originChatTabId: SEEDED_CHAT_TAB_ID,
            originWorktreeId: WORKTREE_ID,
            action: {
              projectId: WORKSPACE_ID,
              worktreeId: WORKTREE_ID,
              type: 'browser.open',
              url: advisorUrl,
            },
          }).then((result) => {
            advisorResult = result;
          }),
      });
      expect(advisorResult).toMatchObject({ ok: true });
      await expectPageLoaded(electronApp, advisorUrl, PAGE_TITLE);

      // --- ShowFiles for an HTML page ---------------------------------------
      let shown;
      await expectTabBeforeSession(electronApp, window, {
        url: pathToFileURL(path.join(worktreePath, 'latency-site/index.html'))
          .href,
        label: 'Loading index.html…',
        backgroundTabLabel: 'latency-site/index.html',
        open: () =>
          showFiles(electronApp, 'latency-html-page', [
            { path: 'latency-site/index.html' },
          ]).then((result) => {
            shown = result;
          }),
      });
      expect(shown).toMatchObject({
        ok: true,
        result: { opened: 1, files: [{ ok: true, openedIn: 'browser' }] },
      });
      await expectPageLoaded(
        electronApp,
        pathToFileURL(path.join(worktreePath, 'latency-site/index.html')).href,
        HTML_TITLE,
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await page.close();
    }
  });

  // A view that was never shown lays its page out at 0×0, and pages that
  // measure the window while loading (infinite scroll, lazy loading) never
  // recover once the pane sizes the view. An agent tab starts its first load
  // after the pane has shown it at its real size.
  test('an agent-opened page has the pane size while it loads', async () => {
    test.setTimeout(180_000);
    const page = await startPageServer(
      '<script>window.__sizeAtLoad = { width: innerWidth, height: innerHeight };</script>',
    );
    const { electronApp, userDataDir } = await seedPanelWorktree();
    try {
      const agentUrl = `${page.url}?from=agent-size`;
      const result = await electronApp.evaluate(
        (_electron, input) =>
          globalThis.__CANOPY_E2E_DISPATCH_BROWSER_ACTION__(input),
        {
          path: 'scoped',
          action: { type: 'browser.open', url: agentUrl },
          destination: {
            projectId: WORKSPACE_ID,
            worktreeId: WORKTREE_ID,
            chatId: SEEDED_CHAT_TAB_ID,
          },
        },
      );
      expect(result).toMatchObject({ ok: true });
      await expectPageLoaded(electronApp, agentUrl, PAGE_TITLE);
      const sizeAtLoad = await electronApp.evaluate(
        ({ webContents }, pageUrl) =>
          webContents
            .getAllWebContents()
            .find((contents) => contents.getURL() === pageUrl)
            ?.executeJavaScript('window.__sizeAtLoad'),
        agentUrl,
      );
      expect(sizeAtLoad.width).toBeGreaterThan(0);
      expect(sizeAtLoad.height).toBeGreaterThan(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await page.close();
    }
  });
});
