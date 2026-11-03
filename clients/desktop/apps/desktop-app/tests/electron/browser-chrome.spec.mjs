// In-app Browser panels — repeatable outer Browser panels (one session per
// panel), rewritten for the one-browser-per-panel refactor.
//
// SCOPE. This spec covers the renderer DOM chrome of the repeatable Browser
// panels: the outer `+` menu's transactional create-then-bind row, per-panel
// BrowserBar chrome (first content element, no inner group/tab/add/split
// strip), live page-identity in the OUTER panel tab (title label, rich
// tooltip with the exact `Browser` subtitle and distinct favicons),
// side-by-side arrangement through the outer grid, independent navigation,
// app-page/Settings/history visibility synchronization, exact-ID browser
// screenshots, exact-ID snapshot routing, and close-path destruction of both
// sessions.
//
// Overlay intersection and freeze-frame sequencing are asserted in renderer
// component tests because native WebContentsView pixels are not part of the
// Playwright DOM. This Electron flow still exercises the real per-ID browser
// screenshot IPC against both native views.
//
// FLOW:
//   1. Seed a demo workspace + worktree, launch, select the worktree.
//   2. Serve two deterministic local pages with different <title>s (and no
//      favicon, exercising the globe fallback) from an in-test HTTP server.
//   3. Add TWO Browser panels through the outer `+` menu (repeatable kind —
//      the row is always offered, even when Browser panels already exist).
//   4. Navigate each to its own local page; assert independent outer tab
//      labels (live page titles), the rich tooltip (full title + globe +
//      exact `Browser` subtitle), and the globe fallback icon.
//   5. Arrange them side by side via the outer grid test API; both panes
//      stay mounted with independent BrowserBars/URLs.
//   6. Navigate to Usage and Settings, including back/forward app history;
//      both native views hide off-screen and reappear on return.
//   7. Close one panel; exactly its session is destroyed (exact-ID
//      `browser:destroy` reaches the main process) while the other panel
//      keeps its page identity.

import http from 'node:http';
import { cpSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  captureFixtureCatalog,
  createBoundaryRecorder,
  createSelectedLaunchBoundary,
  observeBoundary,
} from './browser-profile-test-lifecycle.mjs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import {
  captureDaemonDryRunEvidence,
  closeCanopy,
  ElectronTerminalResultError,
  getMainWindow,
  isPlaywrightTargetClosedError,
  observeElectronTerminalResult,
} from './launchCanopy.mjs';
import { CanopyAppDriver, closePanelTab } from './canopyApp.mjs';
import { setUiScale } from './uiScale.mjs';
import {
  DEFAULT_GROUP_IDS,
  SEEDED_CHAT_TAB_ID,
  chatPanelLocator,
  collectLeaves,
  getLayout,
  movePanelViaApi,
  seedPanelWorktree,
} from './panelHarness.mjs';

const ARCHIVE_FAILURE_METADATA_LIMIT = 32 * 1024;
const ADVISOR_INITIAL_SELECTION_METADATA_LIMIT = 12 * 1024;

function boundedFailureValue(value, limit = 512) {
  if (typeof value !== 'string') return value;
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function assertElectronTerminalTuple(result, expectedCode) {
  if (!Number.isInteger(result?.pid) || result.pid <= 0)
    throw new Error('Electron terminal result did not retain a positive PID.');
  if (result.error)
    throw new Error(
      `Electron terminal result retained a child error: ${result.error.message}`,
    );
  for (const [event, actual] of [
    ['exit', result.exit],
    ['close', result.close],
  ]) {
    if (actual?.code !== expectedCode || actual.signal !== null)
      throw new Error(
        `Electron terminal ${event} must be (${expectedCode}, null), received (${String(actual?.code)}, ${String(actual?.signal)}).`,
      );
  }
}

function assertTarget125TerminalRejection(error) {
  if (!error)
    throw new Error(
      'target125 ordinary close must reject with its singleton terminal result.',
    );
  if (!(error instanceof ElectronTerminalResultError)) throw error;
  try {
    assertElectronTerminalTuple(error.result, 125);
  } catch {
    throw error;
  }
}

function throwRetainedFixtureFailures(failures) {
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(
      failures,
      'Browser panels qualification body and mandatory cleanup failed.',
    );
}

function serializeArchiveFailureMetadata(metadata) {
  let serialized;
  try {
    serialized = JSON.stringify(metadata, null, 2);
  } catch (error) {
    serialized = JSON.stringify({
      stage: boundedFailureValue(metadata.stage, 128),
      truncated: true,
      reason: 'Full archive failure metadata could not be serialized.',
      serializationError: boundedFailureValue(
        error instanceof Error ? error.message : String(error),
      ),
    });
  }
  const body = Buffer.from(serialized);
  if (body.byteLength <= ARCHIVE_FAILURE_METADATA_LIMIT) return body;
  const expectedOwner = metadata.uiState?.expectedOwner;
  const truncation = Buffer.from(
    JSON.stringify({
      stage: boundedFailureValue(metadata.stage, 128),
      truncated: true,
      reason: `Full archive failure metadata exceeded ${ARCHIVE_FAILURE_METADATA_LIMIT} bytes.`,
      originalByteLength: body.byteLength,
      expectedOwner: expectedOwner
        ? {
            projectId: boundedFailureValue(expectedOwner.projectId, 256),
            worktreeId: boundedFailureValue(expectedOwner.worktreeId, 256),
          }
        : null,
      archiveOperationObservation: metadata.archiveOperationObservation,
    }),
  );
  if (truncation.byteLength <= ARCHIVE_FAILURE_METADATA_LIMIT)
    return truncation;
  return Buffer.from(
    '{"truncated":true,"reason":"Archive failure metadata exceeded the bounded fallback."}',
  );
}

async function settleFailureEvidence(promise, timeoutMs, unavailable) {
  let timeout;
  try {
    return await Promise.race([
      Promise.resolve(promise).catch((error) => ({
        unavailable,
        error: boundedFailureValue(
          error instanceof Error ? error.message : String(error),
        ),
      })),
      new Promise((resolve) => {
        timeout = setTimeout(
          () => resolve({ unavailable: 'timed out' }),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function captureWorktreeArchiveFailure({
  testInfo,
  fixture,
  surface,
  stage,
  lastCatalog,
}) {
  const [uiState, slowActionSnapshot, screenshot] = await Promise.all([
    settleFailureEvidence(
      surface.evaluate(async (expectedOwner) => {
        const envelope = await window.api.appAdvisor.getState();
        const isVisible = (element) => {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            rect.width > 0 &&
            rect.height > 0
          );
        };
        const matchingRow = document.querySelector(
          `[data-project-id="${CSS.escape(expectedOwner.projectId)}"][data-worktree-id="${CSS.escape(expectedOwner.worktreeId)}"]`,
        );
        const visibleStatus = Array.from(
          document.querySelectorAll(
            '[role="dialog"], [role="alert"], [data-testid*="error"]',
          ),
        ).filter(isVisible);
        return {
          expectedOwner,
          currentGuardIdentity:
            envelope.snapshot?.worktreeArchiveDialog ?? null,
          matchingRow: matchingRow
            ? {
                projectId: matchingRow.getAttribute('data-project-id'),
                worktreeId: matchingRow.getAttribute('data-worktree-id'),
                text: matchingRow.textContent?.trim().slice(0, 512) ?? '',
                visible: isVisible(matchingRow),
              }
            : null,
          visibleStatus: visibleStatus.slice(0, 16).map((element) => ({
            role: element.getAttribute('role'),
            testId: element.getAttribute('data-testid'),
            text: element.textContent?.trim().slice(0, 512) ?? '',
          })),
          droppedVisibleStatusCount: Math.max(0, visibleStatus.length - 16),
        };
      }, fixture.owner),
      550,
      'current renderer state unavailable',
    ),
    settleFailureEvidence(
      surface.evaluate(async () => {
        const snapshot = await window.api.slowActions.loadSnapshot();
        const matching = snapshot.records.filter((record) =>
          /archive|remov/i.test(record.context?.channel ?? ''),
        );
        return {
          records: matching.slice(0, 16),
          droppedCount: Math.max(0, matching.length - 16),
          semantics:
            'Snapshot contains only actions still pending after the 15-second slow-action threshold; absence does not prove archive was not invoked.',
        };
      }),
      550,
      'slow-action snapshot unavailable',
    ),
    settleFailureEvidence(
      surface.locator('body').screenshot({
        animations: 'disabled',
        timeout: 650,
      }),
      700,
      'screenshot unavailable',
    ),
  ]);

  if (Buffer.isBuffer(screenshot)) {
    await settleFailureEvidence(
      testInfo.attach(`${stage}.png`, {
        body: screenshot,
        contentType: 'image/png',
      }),
      400,
      'screenshot attachment unavailable',
    );
  }

  const metadata = {
    stage,
    uiState,
    slowActionSnapshot,
    lastCatalogObservation: projectOwnerRetirementCatalog(
      lastCatalog,
      fixture.owner,
    ),
    archiveOperationObservation: {
      invocation: 'unobserved',
      result: 'unobserved',
      limitation:
        'The public renderer/Electron surfaces used by this flow do not expose a per-invocation archive request or result.',
    },
  };
  const body = serializeArchiveFailureMetadata(metadata);
  await settleFailureEvidence(
    testInfo.attach(`${stage}.json`, {
      body,
      contentType: 'application/json',
    }),
    400,
    'metadata attachment unavailable',
  );
}

const PAGE_ONE_TITLE = 'Canopy Browser Page One';
const PAGE_TWO_TITLE = 'Canopy Browser Page Two';
const LINK_TEST_TITLE = 'Link test';
const DIALOG_PAGE_TITLE = 'Canopy Browser Dialog Page';
const LOCAL_FILE_HOME_TITLE = 'Local file fixture home';
const LOCAL_FILE_NEIGHBOUR_TITLE = 'Local file fixture neighbour';
const localSiteFixtureDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'local-site',
);

/** Serves two deterministic pages with distinct favicon assets. */
function startLocalPages() {
  const server = http.createServer((request, response) => {
    if (request.url === '/one') {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end(
        `<!doctype html><html><head><title>${PAGE_ONE_TITLE}</title><link rel="icon" href="/favicon-one.svg"></head><body style="background:#f00"><h1>one</h1></body></html>`,
      );
      return;
    }
    if (request.url === '/two') {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end(
        `<!doctype html><html><head><title>${PAGE_TWO_TITLE}</title><link rel="icon" href="/favicon-two.svg"></head><body style="background:#00f"><h1>two</h1></body></html>`,
      );
      return;
    }
    // The CAN-4831 report's page, with its links pointed at page two.
    if (request.url === '/link-test') {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end(`<!doctype html>
        <html lang="en">
          <head><meta charset="utf-8"><title>${LINK_TEST_TITLE}</title></head>
          <body>
            <h1>Link test</h1>
            <p><a id="same-tab" href="/two" target="_self">Open in the same tab</a></p>
            <p><a id="new-tab" href="/two" target="_blank" rel="noopener noreferrer">Open in a new tab</a></p>
          </body>
        </html>`);
      return;
    }
    if (request.url === '/dialog') {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end(`<!doctype html>
        <html>
          <head><title>${DIALOG_PAGE_TITLE}</title></head>
          <body>
            <button id="confirm-button">Continue</button>
            <output id="confirm-result">idle</output>
            <button id="prompt-button">Prompt</button>
            <output id="prompt-result">idle</output>
            <script>
              document.querySelector('#confirm-button').addEventListener('click', () => {
                document.querySelector('#confirm-result').textContent =
                  window.confirm('Continue with this action?') ? 'accepted' : 'dismissed';
              });
              document.querySelector('#prompt-button').addEventListener('click', () => {
                const value = window.prompt('What should the browser remember?', 'default value');
                document.querySelector('#prompt-result').textContent =
                  value === null ? 'cancelled' : value;
              });
            </script>
          </body>
        </html>`);
      return;
    }
    if (request.url === '/focus') {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end(`<!doctype html>
        <html>
          <head><title>Canopy Browser Focus Fixture</title></head>
          <body><label>Agent input <input id="agent-input"></label></body>
        </html>`);
      return;
    }
    if (request.url === '/sign-in') {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end(`<!doctype html>
        <html>
          <head><title>Canopy Browser Sign-in Fixture</title></head>
          <body>
            <form id="sign-in">
              <label>Username <input id="username" autocomplete="username"></label>
              <label>Password <input id="password" type="password" autocomplete="current-password"></label>
              <label>Revealable password <input id="revealable-password" type="password"></label>
              <button id="reveal-password" type="button">Show password</button>
              <label>Code <input id="code" autocomplete="one-time-code"></label>
              <textarea id="secret-textarea" autocomplete="one-time-code">textarea-otp-secret-9284</textarea>
              <div id="labelled-otp-label">Code <textarea id="labelled-otp" autocomplete="one-time-code" aria-labelledby="labelled-otp-label">labelled-otp-secret-7319</textarea></div>
              <label>Code <textarea id="wrapped-otp" autocomplete="one-time-code">wrapped-otp-secret-8426</textarea></label>
            </form>
            <select id="secret-expiry" autocomplete="cc-exp-month" aria-label="Expiry month">
              ${Array.from({ length: 12 }, (_, index) => {
                const month = String(index + 1).padStart(2, '0');
                const value = `private-month-${month}`;
                return `<option value="${value}" label="${value}"${index === 10 ? ' selected' : ''}>${value}</option>`;
              }).join('')}
            </select>
            <input id="cardholder-name" autocomplete="cc-name" value="private-cardholder-9284">
            <form id="custom-select-form">
              <select id="custom-expiry" autocomplete="cc-exp-month" aria-label="Custom expiry"></select>
            </form>
            <select id="secret-year" autocomplete="cc-exp-year" aria-label="Expiry year">
              <optgroup id="first-years" label="private-range-a">
                <option value="private-year-2031" label="private-year-2031">private-year-2031</option>
                <option value="private-year-2032" label="private-year-2032">private-year-2032</option>
              </optgroup>
              <optgroup id="selected-years" label="private-range-b">
                <option value="private-year-2033" label="private-year-2033">private-year-2033</option>
                <option value="private-year-2034" label="private-year-2034" selected>private-year-2034</option>
              </optgroup>
            </select>
            <script>
              const customExpiry = document.querySelector('#custom-expiry');
              const mirrorButton = document.createElement('button');
              const mirror = document.createElement('selectedcontent');
              mirror.id = 'custom-expiry-mirror';
              mirror.textContent = 'private-custom-month-11';
              mirrorButton.append(mirror);
              customExpiry.append(mirrorButton);
              for (const month of ['01', '11']) {
                const option = document.createElement('option');
                option.value = 'private-custom-month-' + month;
                option.selected = month === '11';
                const span = document.createElement('span');
                span.textContent = option.value;
                if (month === '11') span.id = 'custom-expiry-selected';
                option.append(span);
                customExpiry.append(option);
              }
              document.querySelector('#reveal-password').addEventListener('click', () => {
                document.querySelector('#revealable-password').type = 'text';
              });
              // Frameworks such as React mirror the live value into markup.
              for (const input of document.querySelectorAll('input')) {
                input.addEventListener('input', () =>
                  input.setAttribute('value', input.value),
                );
              }
            </script>
          </body>
        </html>`);
      return;
    }
    if (request.url === '/slow-focus') {
      setTimeout(() => {
        response.writeHead(200, { 'Content-Type': 'text/html' });
        response.end(`<!doctype html>
          <html>
            <head><title>Canopy Slow Focus Fixture</title></head>
            <body>Loaded after user interaction</body>
          </html>`);
      }, 600);
      return;
    }
    if (request.url === '/auth/set' || request.url === '/auth/check') {
      if (request.url === '/auth/set') {
        response.setHeader(
          'Set-Cookie',
          'canopy-browser-auth=release-128; Path=/; Max-Age=3600; SameSite=Lax',
        );
      }
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end(`<!doctype html>
        <html>
          <head><title>Canopy Browser Auth Fixture</title></head>
          <body><output id="auth-state">${request.headers.cookie ?? ''}</output>
            <script>
              if (location.pathname === '/auth/set') {
                localStorage.setItem('profile-fixture', 'durable-local-value');
              }
              document.querySelector('#auth-state').textContent +=
                '|local=' + localStorage.getItem('profile-fixture');
            </script>
          </body>
        </html>`);
      return;
    }
    if (
      request.url === '/favicon-one.svg' ||
      request.url === '/favicon-two.svg'
    ) {
      const fill = request.url.includes('one') ? '#f00' : '#00f';
      response.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      response.end(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="${fill}"/></svg>`,
      );
      return;
    }
    response.writeHead(404);
    response.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        port: server.address().port,
        close: () => new Promise((resolveClose) => server.close(resolveClose)),
      });
    });
  });
}

/** Receives build-gated external opens instead of launching a host browser. */
async function startExternalOpenCapture() {
  const opened = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      try {
        opened.push(JSON.parse(body).url);
      } catch {
        // The assertion below reports malformed or missing requests.
      }
      response.writeHead(204);
      response.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('External-open capture server did not bind a TCP port.');
  }
  return {
    url: `http://127.0.0.1:${address.port}/external-open`,
    opened,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
      }),
  };
}

/** Clicks a real renderer anchor so Electron's window-open interception runs. */
async function clickAppLink(window, url) {
  await window.evaluate((href) => {
    document
      .querySelector('[data-testid="browser-app-link-fixture"]')
      ?.remove();
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.target = '_blank';
    anchor.textContent = 'Open browser fixture';
    anchor.dataset.testid = 'browser-app-link-fixture';
    document.body.append(anchor);
  }, url);
  await window.getByTestId('browser-app-link-fixture').click();
}

/** All bound Browser panels (leaf order) from the serialized layout. */
async function browserPanels(window) {
  const layout = await getLayout(window);
  return collectLeaves(layout.root).flatMap((leaf) =>
    leaf.panels
      .filter((panel) => panel.kind === 'browser')
      .map((panel) => ({
        groupId: leaf.groupId,
        panelId: panel.panelId,
        browserId: panel.instance?.browserId,
      })),
  );
}

/** Adds a Browser panel via a group's outer `+` menu; returns its binding. */
async function addBrowserPanel(window, groupId) {
  const before = await browserPanels(window);
  const beforeIds = new Set(before.map((panel) => panel.panelId));
  await window.getByTestId(`panel-add-tab-${groupId}`).click();
  const addMenu = window.getByTestId('panel-add-menu');
  await expect(addMenu).toBeVisible();
  const browserRow = window.getByTestId('panel-add-menu-item-browser');
  await expect(browserRow).toBeVisible();
  await browserRow.click();
  // The menu closes as soon as the bound panel is inserted; the backend
  // session is still being created at that point.
  await expect(addMenu).toBeHidden({ timeout: 15_000 });
  const after = await browserPanels(window);
  const added = after.find((panel) => !beforeIds.has(panel.panelId));
  expect(added).toBeTruthy();
  expect(added.browserId).toBeTruthy();
  // Bound-panel contract: the panel id derives from the session id.
  expect(added.panelId).toBe(`panel-browser-${added.browserId}`);
  await waitForBlankBrowserSession(window, added.browserId);
  return added;
}

/**
 * A new tab is placed before its backend session exists. Specs that drive
 * the session directly (inspect, automation, screenshots) wait for it first.
 */
async function waitForBlankBrowserSession(surface, browserId) {
  await expect(
    surface.getByTestId(`browser-pane-${browserId}`),
  ).toHaveAttribute('data-browser-state', 'live', { timeout: 30_000 });
}

/** Waits until no tab in `surface` is still opening or first-loading. */
async function waitForBrowserTabsLoaded(surface) {
  await expect(surface.getByTestId('browser-pane-loading')).toHaveCount(0, {
    timeout: 30_000,
  });
}

/** Navigates the visible pane of `browserId` via its own BrowserBar. */
async function navigatePane(window, browserId, url) {
  const pane = window.getByTestId(`browser-pane-${browserId}`);
  await expect(pane).toBeVisible();
  const urlInput = pane.getByTestId('browser-url-input');
  await expect(urlInput).toBeVisible();
  await urlInput.click();
  await urlInput.fill(url);
  await urlInput.press('Enter');
}

/** Native WebContentsView geometry/visibility keyed by its live page title. */
async function nativeBrowserViews(electronApp) {
  return electronApp.evaluate(({ BrowserWindow }) => {
    const found = [];
    // A Browser page sits inside its frame views, so its window bounds add
    // up its ancestors' offsets.
    const visit = (view, hostWindowId, offsetX = 0, offsetY = 0) => {
      for (const child of view?.children ?? []) {
        const own = child.getBounds();
        const bounds = { ...own, x: own.x + offsetX, y: own.y + offsetY };
        if (child.webContents) {
          found.push({
            webContentsId: child.webContents.id,
            title: child.webContents.getTitle(),
            bounds,
            visible: child.getVisible(),
            hostWindowId,
            ownerWindowId:
              BrowserWindow.fromWebContents(child.webContents)?.id ?? null,
          });
        }
        visit(child, hostWindowId, bounds.x, bounds.y);
      }
    };
    for (const browserWindow of BrowserWindow.getAllWindows()) {
      visit(browserWindow.contentView, browserWindow.id);
    }
    return found;
  });
}

async function browserViewByTitle(electronApp, title) {
  return (await nativeBrowserViews(electronApp)).find(
    (view) => view.title === title,
  );
}

async function browserVisibilityByTitle(electronApp) {
  const views = await nativeBrowserViews(electronApp);
  return {
    first: views.find((view) => view.title === PAGE_ONE_TITLE)?.visible,
    second: views.find((view) => view.title === PAGE_TWO_TITLE)?.visible,
  };
}

async function requestAdvisorTool(electronApp, request) {
  return electronApp.evaluate(
    async ({ BrowserWindow, ipcMain }, rendererRequest) => {
      const responseChannel = 'app-advisor:tool-response';
      const requestChannel = 'app-advisor:tool-request';
      const mainWindow = BrowserWindow.getAllWindows().find(
        (candidate) =>
          !candidate.webContents.getURL().includes('surface=app-advisor'),
      );
      if (!mainWindow) throw new Error('Main window not found');

      ipcMain.removeHandler(responseChannel);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Timed out waiting for browser action')),
          15_000,
        );
        ipcMain.handle(responseChannel, (_event, candidate) => {
          if (candidate?.requestId !== rendererRequest.requestId) return;
          clearTimeout(timer);
          resolve(candidate);
        });
        mainWindow.webContents.send(requestChannel, rendererRequest);
      });
    },
    request,
  );
}

async function dispatchAdvisorBrowserAction(electronApp, requestId, action) {
  return requestAdvisorTool(electronApp, {
    kind: 'dispatch_action',
    requestId,
    originChatTabId: SEEDED_CHAT_TAB_ID,
    originWorktreeId: 'demo-main',
    action: {
      projectId: 'demo-ts-pnpm-vite',
      worktreeId: 'demo-main',
      ...action,
    },
  });
}

async function dispatchAdvisorActionWhileClickingBrowser(
  electronApp,
  requestId,
  action,
) {
  return electronApp.evaluate(
    async ({ BrowserWindow, ipcMain }, payload) => {
      const mainWindow = BrowserWindow.getAllWindows().find(
        (candidate) =>
          !candidate.webContents.getURL().includes('surface=app-advisor'),
      );
      if (!mainWindow) throw new Error('Main window not found');
      let clickedContents;
      const findBrowserContents = (view) => {
        for (const child of view?.children ?? []) {
          if (child.webContents?.getTitle() === payload.browserTitle) {
            return child.webContents;
          }
          const nested = findBrowserContents(child);
          if (nested) return nested;
        }
        return undefined;
      };

      ipcMain.removeHandler('app-advisor:tool-response');
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Timed out waiting for browser action')),
          15_000,
        );
        ipcMain.handle('app-advisor:tool-response', (_event, candidate) => {
          if (candidate?.requestId !== payload.request.requestId) return;
          clearTimeout(timer);
          resolve({
            response: candidate,
            mainRendererFocused: mainWindow.webContents.isFocused(),
          });
        });
        mainWindow.webContents.send(
          'app-advisor:tool-request',
          payload.request,
        );
        setTimeout(() => {
          clickedContents = findBrowserContents(mainWindow.contentView);
          if (!clickedContents) {
            reject(new Error('Browser WebContentsView not found'));
            return;
          }
          clickedContents.focus();
          clickedContents.sendInputEvent({
            type: 'mouseDown',
            x: 8,
            y: 8,
            button: 'left',
            clickCount: 1,
          });
          clickedContents.sendInputEvent({
            type: 'mouseUp',
            x: 8,
            y: 8,
            button: 'left',
            clickCount: 1,
          });
        }, 100);
      });
    },
    {
      browserTitle: 'Canopy Browser Focus Fixture',
      request: {
        kind: 'dispatch_action',
        requestId,
        originChatTabId: SEEDED_CHAT_TAB_ID,
        originWorktreeId: 'demo-main',
        action: {
          projectId: 'demo-ts-pnpm-vite',
          worktreeId: 'demo-main',
          ...action,
        },
      },
    },
  );
}

test.describe('repeatable Browser panels (one session per panel)', () => {
  for (const finalSnapshot of [false, true]) {
    test(`worktree return recreates browsers evicted from the warm budget${finalSnapshot ? ' after a final snapshot' : ''}`, async () => {
      test.setTimeout(120_000);
      const pages = await startLocalPages();
      const fixtureApps = [
        'ts-pnpm-vite',
        'python-fastapi-uv',
        'ts-npm-next',
        'ts-yarn-cli',
        'go-cli',
      ];
      const launched = await seedPanelWorktree({
        apps: fixtureApps,
        onBeforeLaunch: ({ userDataDir, workspaceIds }) => {
          // Every visited workspace needs the Advanced terminal group used
          // to create its live browser, not the default Minimal drawer.
          for (const workspaceId of workspaceIds.slice(1)) {
            const dataDir = path.join(
              userDataDir,
              'workspaces',
              workspaceId,
              'worktree-data',
              'demo-main',
            );
            mkdirSync(dataDir, { recursive: true });
            writeFileSync(
              path.join(dataDir, 'panel-layout-mode.json'),
              JSON.stringify({ version: 1, mode: 'advanced' }),
            );
          }
        },
      });
      const { electronApp, window, userDataDir } = launched;
      const pageUrl = `http://127.0.0.1:${pages.port}/one`;
      const worktreeRow = (appId) =>
        window.locator(
          `[data-testid="worktree-row"][data-project-id="demo-${appId}"][data-worktree-id="demo-main"]`,
        );
      const selectFixtureWorktree = async (appId) => {
        const row = worktreeRow(appId);
        await row.evaluate((element) => element.click());
        await expect(
          window.locator('[data-sidebar-selected-item]').filter({ has: row }),
        ).toHaveCount(1);
        await expect(window.getByTestId('panel-grid-root')).toBeVisible();
        await expect(
          window.getByTestId('panel-add-tab-group-terminal'),
        ).toBeVisible();
      };
      try {
        await selectFixtureWorktree(fixtureApps[0]);
        const browser = await addBrowserPanel(window, 'group-terminal');
        await navigatePane(window, browser.browserId, pageUrl);
        await expect
          .poll(() => browserViewByTitle(electronApp, PAGE_ONE_TITLE))
          .toBeTruthy();
        const original = await browserViewByTitle(electronApp, PAGE_ONE_TITLE);

        // Hold the real disposal IPC long enough for Chromium's final title
        // publication to reach the renderer, after the release cleared live.
        await electronApp.evaluate(
          ({ ipcMain, webContents }, input) => {
            const channel = 'browser:dispose-live-view';
            const dispose = ipcMain._invokeHandlers.get(channel);
            if (!dispose) throw new Error('Browser disposal handler missing');
            globalThis.__browserReleaseFinished = false;
            ipcMain.removeHandler(channel);
            ipcMain.handle(channel, async (event, request) => {
              if (request.browserId !== input.browserId)
                return dispose(event, request);
              if (input.finalSnapshot) {
                const contents = webContents
                  .getAllWebContents()
                  .find((entry) => entry.getURL() === input.pageUrl);
                if (!contents)
                  throw new Error('Browser view missing before disposal');
                await new Promise((resolve, reject) => {
                  contents.once('page-title-updated', resolve);
                  void contents
                    .executeJavaScript(
                      "document.title = 'Final background title'",
                    )
                    .catch(reject);
                });
                // Round-trip the host renderer so its browser:event has been
                // delivered before disposal's reply releases rematerialization.
                await event.sender.executeJavaScript('Promise.resolve()');
              }
              await dispose(event, request);
              globalThis.__browserReleaseFinished = true;
            });
          },
          { browserId: browser.browserId, pageUrl, finalSnapshot },
        );

        // Leaving a worktree now keeps its views warm. Visit four others to
        // exercise real disposal through the three-worktree retention budget.
        let other;
        for (const appId of fixtureApps.slice(1)) {
          await selectFixtureWorktree(appId);
          other = await addBrowserPanel(window, 'group-terminal');
        }
        await expect(
          window.getByTestId(`browser-pane-${browser.browserId}`),
        ).toHaveCount(0);
        await expect
          .poll(() =>
            electronApp.evaluate(() => globalThis.__browserReleaseFinished),
          )
          .toBe(true);
        await expect
          .poll(async () =>
            (await nativeBrowserViews(electronApp)).some(
              (view) => view.webContentsId === original.webContentsId,
            ),
          )
          .toBe(false);

        // Give the other project's own browser a live page. Returning must
        // preserve the first tab's exact identity and recreate its native view.
        await navigatePane(
          window,
          other.browserId,
          `http://127.0.0.1:${pages.port}/two`,
        );
        await expect
          .poll(() => browserViewByTitle(electronApp, PAGE_TWO_TITLE))
          .toBeTruthy();
        await electronApp.evaluate(() =>
          globalThis.__CANOPY_E2E_BROWSER_CREATE_GATE__({ kind: 'arm' }),
        );
        await selectFixtureWorktree(fixtureApps[0]);
        const pane = window.getByTestId(`browser-pane-${browser.browserId}`);
        await expect(pane).toBeVisible();
        const address = pane.getByTestId('browser-url-input');
        await address.focus();
        await expect(address).toHaveValue(pageUrl);
        await address.blur();
        await expect
          .poll(() =>
            electronApp.evaluate(() =>
              globalThis.__CANOPY_E2E_BROWSER_CREATE_GATE__({ kind: 'status' }),
            ),
          )
          .toMatchObject({ entered: 1 });
        // Refresh must wait for the same in-flight rematerialization, rather
        // than sending reload to a native session that does not exist yet.
        await pane.getByTestId('browser-refresh').click();
        await electronApp.evaluate(() =>
          globalThis.__CANOPY_E2E_BROWSER_CREATE_GATE__({ kind: 'release' }),
        );
        await expect
          .poll(() => browserViewByTitle(electronApp, PAGE_ONE_TITLE))
          .toBeTruthy();
        await expect(pane.getByTestId('browser-url-input')).toHaveAttribute(
          'aria-invalid',
          'false',
        );
        await expect(pane.getByTestId('browser-pane-failed')).toHaveCount(0);
        expect(
          (await browserPanels(window)).map((entry) => entry.browserId),
        ).toContain(browser.browserId);
      } finally {
        await electronApp.evaluate(() =>
          globalThis.__CANOPY_E2E_BROWSER_CREATE_GATE__({ kind: 'release' }),
        );
        await closeCanopy(electronApp, userDataDir);
        await pages.close();
      }
    });
  }

  test('user and agent flows open a complete local site without external fallback', async () => {
    test.setTimeout(120_000);
    const launched = await seedPanelWorktree();
    const seededWorktree = launched.demoSeed?.workspaces?.[0]?.worktreePath;
    if (!seededWorktree) {
      throw new Error('Expected a seeded worktree path.');
    }
    const localSiteDir = path.join(seededWorktree, 'Local Site índigo');
    cpSync(localSiteFixtureDir, localSiteDir, { recursive: true });
    const indexPath = path.join(localSiteDir, 'index.html');
    const indexUrl = pathToFileURL(indexPath).href;
    const missingPath = path.join(localSiteDir, 'missing report.html');

    try {
      await launched.electronApp.evaluate(({ shell }) => {
        globalThis.__can2850ExternalOpenCount = 0;
        shell.openExternal = async () => {
          globalThis.__can2850ExternalOpenCount += 1;
        };
      });

      const browser = await addBrowserPanel(launched.window, 'group-terminal');
      const pane = launched.window.getByTestId(
        `browser-pane-${browser.browserId}`,
      );

      // The user enters the raw OS path. The renderer and main process agree
      // on one encoded file URL, including the space and non-ASCII segment.
      await navigatePane(launched.window, browser.browserId, indexPath);
      await expect
        .poll(() =>
          browserViewByTitle(launched.electronApp, LOCAL_FILE_HOME_TITLE),
        )
        .toBeTruthy();
      const address = pane.getByTestId('browser-url-input');
      await address.focus();
      await expect(address).toHaveValue(indexUrl);
      await address.blur();

      // One inspect proves the classic script, image, and stylesheet all
      // loaded from relative file paths.
      await expect
        .poll(async () => {
          const inspected = await launched.window.evaluate(
            ({ browserId }) =>
              window.api.browser.inspect({
                browserId,
                locator: '#asset-report',
              }),
            { browserId: browser.browserId },
          );
          return inspected.text;
        })
        .toBe('script-ok|16|rgb(0, 128, 0)');

      // Re-entering the same path takes the single reload path rather than
      // issuing a second competing load.
      await launched.electronApp.evaluate(({ webContents }, pageTitle) => {
        const contents = webContents
          .getAllWebContents()
          .find((candidate) => candidate.getTitle() === pageTitle);
        if (!contents) throw new Error('Local file browser view not found.');
        globalThis.__can2850MainNavigationCount = 0;
        contents.on(
          'did-start-navigation',
          (_event, _url, _isInPlace, isMainFrame) => {
            if (isMainFrame) globalThis.__can2850MainNavigationCount += 1;
          },
        );
      }, LOCAL_FILE_HOME_TITLE);
      await navigatePane(launched.window, browser.browserId, indexPath);
      await expect
        .poll(() =>
          launched.electronApp.evaluate(
            () => globalThis.__can2850MainNavigationCount,
          ),
        )
        .toBe(1);
      await expect
        .poll(async () => {
          const inspected = await launched.window.evaluate(
            ({ browserId }) =>
              window.api.browser.inspect({
                browserId,
                locator: '#neighbour-link',
              }),
            { browserId: browser.browserId },
          );
          return inspected.text;
        })
        .toBe('Open neighbouring file');

      // A local page may follow a relative link to a neighbouring file, and
      // the refused-external safety path remains untouched.
      const clicked = await launched.window.evaluate(
        ({ browserId }) =>
          window.api.browser.automation({
            browserId,
            command: { kind: 'click', locator: '#neighbour-link' },
          }),
        { browserId: browser.browserId },
      );
      expect(clicked, JSON.stringify(clicked)).toMatchObject({ ok: true });
      await expect
        .poll(() =>
          browserViewByTitle(launched.electronApp, LOCAL_FILE_NEIGHBOUR_TITLE),
        )
        .toBeTruthy();
      expect(
        await launched.electronApp.evaluate(
          () => globalThis.__can2850ExternalOpenCount,
        ),
      ).toBe(0);

      // App Advisor uses the same policy and returns an in-app browser, not
      // an openedUrl result from the system-browser fallback.
      const opened = await dispatchAdvisorBrowserAction(
        launched.electronApp,
        'browser-open-local-file',
        { type: 'browser.open', url: indexUrl },
      );
      expect(opened.ok).toBe(true);
      expect(opened.result?.browser?.id).toBeTruthy();
      expect(opened.result?.openedUrl).toBeUndefined();
      await expect
        .poll(() =>
          browserViewByTitle(launched.electronApp, LOCAL_FILE_HOME_TITLE),
        )
        .toBeTruthy();

      // File-specific Chromium failures name the decoded basename, and a
      // normal history action clears the failure instead of leaving it sticky.
      await navigatePane(launched.window, browser.browserId, missingPath);
      const failure = pane.getByTestId('browser-pane-failed');
      await expect(failure).toContainText(
        "Couldn't open missing report.html. The file wasn't found.",
      );
      await pane.getByTestId('browser-back').click();
      await expect(failure).toHaveCount(0);
      await expect
        .poll(() =>
          browserViewByTitle(launched.electronApp, LOCAL_FILE_NEIGHBOUR_TITLE),
        )
        .toBeTruthy();
    } finally {
      await closeCanopy(launched.electronApp, launched.userDataDir);
    }
  });

  test('target="_blank" links open one new tab and target="_self" links stay in theirs', async () => {
    test.setTimeout(120_000);
    const pages = await startLocalPages();
    const { electronApp, userDataDir, window } = await seedPanelWorktree();
    const linkTestUrl = `http://127.0.0.1:${pages.port}/link-test`;
    const pageTwoUrl = `http://127.0.0.1:${pages.port}/two`;
    const openPages = () =>
      electronApp.evaluate(
        ({ webContents }, urls) => {
          const all = webContents
            .getAllWebContents()
            .map((entry) => entry.getURL());
          return urls.map((url) => all.filter((entry) => entry === url).length);
        },
        [linkTestUrl, pageTwoUrl],
      );
    // A user's click: a page-side click with a user gesture, not a browser
    // action, which would count as an agent's and open its tab behind.
    const clickLink = (pageUrl, locator) =>
      electronApp.evaluate(
        ({ webContents }, input) =>
          webContents
            .getAllWebContents()
            .find((entry) => entry.getURL() === input.pageUrl)
            ?.executeJavaScript(
              `document.querySelector(${JSON.stringify(input.locator)}).click()`,
              true,
            ),
        { pageUrl, locator },
      );
    try {
      const browser = await addBrowserPanel(window, 'group-chat');
      const pane = window.getByTestId(`browser-pane-${browser.browserId}`);

      // The control: target="_self" navigates its own tab.
      await navigatePane(window, browser.browserId, linkTestUrl);
      await expect
        .poll(() => browserViewByTitle(electronApp, LINK_TEST_TITLE))
        .toBeTruthy();
      await clickLink(linkTestUrl, '#same-tab');
      await expect(pane.getByTestId('browser-url-input')).toHaveValue(
        pageTwoUrl,
      );
      await expect.poll(openPages).toEqual([0, 1]);
      expect(await browserPanels(window)).toHaveLength(1);

      // target="_blank" with rel="noopener noreferrer" opens exactly one new
      // tab and leaves the test page in its own tab.
      await navigatePane(window, browser.browserId, linkTestUrl);
      await expect.poll(openPages).toEqual([1, 0]);
      await clickLink(linkTestUrl, '#new-tab');
      await expect
        .poll(async () => (await browserPanels(window)).length)
        .toBe(2);
      const opened = (await browserPanels(window)).find(
        (panel) => panel.browserId !== browser.browserId,
      );
      expect(opened?.browserId).toBeTruthy();
      // The new tab is selected, and the only page-two view is its own.
      await expect(
        window.getByTestId(`browser-pane-${opened.browserId}`),
      ).toBeVisible();
      await expect.poll(openPages).toEqual([1, 1]);
      // The new tab is its own session: the page has no opener to reach.
      const opener = await electronApp.evaluate(({ webContents }, url) => {
        const contents = webContents
          .getAllWebContents()
          .find((entry) => entry.getURL() === url);
        return contents?.executeJavaScript('window.opener === null');
      }, pageTwoUrl);
      expect(opener).toBe(true);
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await pages.close();
    }
  });

  test('the memory report overlay hides an open Browser view as Settings does', async () => {
    test.setTimeout(240_000);
    const pages = await startLocalPages();
    const { electronApp, userDataDir, window } = await seedPanelWorktree();

    try {
      const app = new CanopyAppDriver(window);
      const first = await addBrowserPanel(window, 'group-terminal');
      await navigatePane(
        window,
        first.browserId,
        `http://127.0.0.1:${pages.port}/one`,
      );
      const pageVisible = async () =>
        (await browserVisibilityByTitle(electronApp)).first;
      await expect.poll(pageVisible, { timeout: 30_000 }).toBe(true);

      await app.openSettings();
      await expect.poll(pageVisible).toBe(false);
      await app.openSettingsSection('performance');
      const diagnosticsSwitch = window.getByTestId(
        'settings-memory-diagnostics',
      );
      await diagnosticsSwitch.scrollIntoViewIfNeeded();
      await diagnosticsSwitch.click();
      await expect(diagnosticsSwitch).toHaveAttribute('aria-checked', 'true');
      await expect(
        window.getByTestId('settings-create-memory-report'),
      ).toBeEnabled();
      await app.closeSettings();
      await expect.poll(pageVisible).toBe(true);

      await window.getByTestId('sidebar-resource-diagnostics-pill').click();
      await window
        .getByTestId('resource-diagnostics-popover-create-report')
        .click();
      await expect(
        window.getByTestId('settings-memory-report-dialog'),
      ).toBeVisible();
      await window.getByTestId('settings-memory-report-confirm').click();
      await expect(window.getByTestId('memory-report-overlay')).toContainText(
        'Generating…',
      );
      await expect.poll(pageVisible).toBe(false);
      await expect(window.getByTestId('memory-report-saved')).toBeVisible({
        timeout: 120_000,
      });
      expect(await pageVisible()).toBe(false);
      await window.getByTestId('memory-report-done').click();
      await expect(window.getByTestId('memory-report-overlay')).toBeHidden();
      await expect.poll(pageVisible).toBe(true);
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await pages.close();
    }
  });

  test('agent browser actions preserve an active chat draft', async () => {
    test.setTimeout(120_000);
    const pages = await startLocalPages();
    const { electronApp, userDataDir, window } = await seedPanelWorktree();

    try {
      const composer = chatPanelLocator(window).locator(
        '[data-chat-textarea][contenteditable="true"]',
      );
      await composer.fill('User draft');
      await composer.focus();

      const opened = await dispatchAdvisorBrowserAction(
        electronApp,
        'browser-focus-open',
        {
          type: 'browser.open',
          url: `http://127.0.0.1:${pages.port}/focus`,
        },
      );
      expect(opened.ok).toBe(true);
      const browserId = opened.result?.browser?.id;
      // Existing-tab actions carry the runtime generation the agent observed.
      const expectedRuntimeGeneration =
        opened.result?.browser?.profile?.runtimeGeneration;
      expect(browserId).toBeTruthy();
      await expect(window.getByTestId(`browser-pane-${browserId}`)).toBeVisible(
        { timeout: 30_000 },
      );

      await window.keyboard.type(' while opening');
      await expect(composer).toHaveText('User draft while opening');

      await composer.focus();
      const filled = await dispatchAdvisorBrowserAction(
        electronApp,
        'browser-focus-fill',
        {
          type: 'browser.fill',
          browserId,
          expectedRuntimeGeneration,
          locator: '#agent-input',
          text: 'Agent supplied text',
        },
      );
      expect(filled.ok).toBe(true);
      const inspected = await window.evaluate(
        ({ id }) =>
          window.api.browser.inspect({
            browserId: id,
            locator: '#agent-input',
          }),
        { id: browserId },
      );
      expect(inspected.value).toBe('Agent supplied text');

      await window.keyboard.type(' during automation');
      await expect(composer).toHaveText(
        'User draft while opening during automation',
      );

      await composer.focus();
      const navigated = await dispatchAdvisorActionWhileClickingBrowser(
        electronApp,
        'browser-focus-user-click',
        {
          type: 'browser.navigate',
          browserId,
          expectedRuntimeGeneration,
          url: `http://127.0.0.1:${pages.port}/slow-focus`,
        },
      );
      expect(navigated.response.ok).toBe(true);
      expect(navigated.mainRendererFocused).toBe(false);
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await pages.close();
    }
  });

  test('agent snapshots and inspection never return password or one-time code values', async () => {
    test.setTimeout(120_000);
    const pages = await startLocalPages();
    const { electronApp, userDataDir, window } = await seedPanelWorktree();
    const password = 'agent-password-secret-7429';
    const revealedPassword = 'agent-revealed-password-secret-7621';
    const code = 'agent-code-secret-5813';

    try {
      const opened = await dispatchAdvisorBrowserAction(
        electronApp,
        'browser-secret-open',
        {
          type: 'browser.open',
          url: `http://127.0.0.1:${pages.port}/sign-in`,
        },
      );
      expect(opened.ok).toBe(true);
      const browserId = opened.result?.browser?.id;
      // Existing-tab actions carry the runtime generation the agent observed.
      const expectedRuntimeGeneration =
        opened.result?.browser?.profile?.runtimeGeneration;
      expect(browserId).toBeTruthy();
      await expect(window.getByTestId(`browser-pane-${browserId}`)).toBeVisible(
        { timeout: 30_000 },
      );

      for (const [locator, text] of [
        ['#username', 'ada'],
        ['#password', password],
        ['#revealable-password', revealedPassword],
        ['#code', code],
      ]) {
        const filled = await dispatchAdvisorBrowserAction(
          electronApp,
          `browser-secret-fill-${locator.slice(1)}`,
          {
            type: 'browser.fill',
            browserId,
            expectedRuntimeGeneration,
            locator,
            text,
          },
        );
        expect(filled.ok, JSON.stringify(filled)).toBe(true);
      }

      const revealed = await dispatchAdvisorBrowserAction(
        electronApp,
        'browser-secret-reveal-password',
        {
          type: 'browser.click',
          browserId,
          expectedRuntimeGeneration,
          locator: '#reveal-password',
        },
      );
      expect(revealed.ok, JSON.stringify(revealed)).toBe(true);

      const snapshot = await dispatchAdvisorBrowserAction(
        electronApp,
        'browser-secret-snapshot',
        {
          type: 'browser.input_snapshot',
          browserId,
          expectedRuntimeGeneration,
        },
      );
      const inspectedPassword = await dispatchAdvisorBrowserAction(
        electronApp,
        'browser-secret-inspect-password',
        {
          type: 'browser.inspect',
          browserId,
          expectedRuntimeGeneration,
          locator: '#password',
        },
      );
      const inspectedRevealedPassword = await dispatchAdvisorBrowserAction(
        electronApp,
        'browser-secret-inspect-revealed-password',
        {
          type: 'browser.inspect',
          browserId,
          expectedRuntimeGeneration,
          locator: '#revealable-password',
        },
      );
      const inspectedForm = await dispatchAdvisorBrowserAction(
        electronApp,
        'browser-secret-inspect-form',
        {
          type: 'browser.inspect',
          browserId,
          expectedRuntimeGeneration,
          locator: '#sign-in',
        },
      );
      const inspectedOption = await dispatchAdvisorBrowserAction(
        electronApp,
        'browser-secret-inspect-option',
        {
          type: 'browser.inspect',
          browserId,
          expectedRuntimeGeneration,
          locator: '#secret-expiry option:checked',
        },
      );
      const inspectedOtherOption = await dispatchAdvisorBrowserAction(
        electronApp,
        'browser-secret-inspect-other-option',
        {
          type: 'browser.inspect',
          browserId,
          expectedRuntimeGeneration,
          locator: '#secret-expiry option:first-child',
        },
      );
      const inspectedSelect = await dispatchAdvisorBrowserAction(
        electronApp,
        'browser-secret-inspect-select',
        {
          type: 'browser.inspect',
          browserId,
          expectedRuntimeGeneration,
          locator: '#secret-expiry',
        },
      );
      const inspectedOptgroup = await dispatchAdvisorBrowserAction(
        electronApp,
        'browser-secret-inspect-optgroup',
        {
          type: 'browser.inspect',
          browserId,
          expectedRuntimeGeneration,
          locator: '#selected-years',
        },
      );
      const inspectedYear = await dispatchAdvisorBrowserAction(
        electronApp,
        'browser-secret-inspect-year',
        {
          type: 'browser.inspect',
          browserId,
          expectedRuntimeGeneration,
          locator: '#secret-year',
        },
      );
      const inspectedTextarea = await dispatchAdvisorBrowserAction(
        electronApp,
        'browser-secret-inspect-textarea',
        {
          type: 'browser.inspect',
          browserId,
          expectedRuntimeGeneration,
          locator: '#secret-textarea',
        },
      );
      const inspectedLabelledOtp = await dispatchAdvisorBrowserAction(
        electronApp,
        'browser-secret-inspect-labelled-otp',
        {
          type: 'browser.inspect',
          browserId,
          expectedRuntimeGeneration,
          locator: '#labelled-otp',
        },
      );
      const inspectedWrappedOtp = await dispatchAdvisorBrowserAction(
        electronApp,
        'browser-secret-inspect-wrapped-otp',
        {
          type: 'browser.inspect',
          browserId,
          expectedRuntimeGeneration,
          locator: '#wrapped-otp',
        },
      );
      const inspectedNestedOption = await dispatchAdvisorBrowserAction(
        electronApp,
        'browser-secret-inspect-nested-option',
        {
          type: 'browser.inspect',
          browserId,
          expectedRuntimeGeneration,
          locator: '#custom-expiry option:checked span',
        },
      );
      const inspectedMirror = await dispatchAdvisorBrowserAction(
        electronApp,
        'browser-secret-inspect-mirror',
        {
          type: 'browser.inspect',
          browserId,
          expectedRuntimeGeneration,
          locator: '#custom-expiry-mirror',
        },
      );
      const inspectedCustomForm = await dispatchAdvisorBrowserAction(
        electronApp,
        'browser-secret-inspect-custom-form',
        {
          type: 'browser.inspect',
          browserId,
          expectedRuntimeGeneration,
          locator: '#custom-select-form',
        },
      );
      const inspectedCardholder = await dispatchAdvisorBrowserAction(
        electronApp,
        'browser-secret-inspect-cardholder',
        {
          type: 'browser.inspect',
          browserId,
          expectedRuntimeGeneration,
          locator: '#cardholder-name',
        },
      );
      await window.evaluate(
        (id) => window.api.browser.startRecording({ browserId: id }),
        browserId,
      );
      await electronApp.evaluate(async ({ BrowserWindow }, title) => {
        const find = (view) => {
          for (const child of view?.children ?? []) {
            if (child.webContents?.getTitle() === title)
              return child.webContents;
            const nested = find(child);
            if (nested) return nested;
          }
          return undefined;
        };
        const contents = BrowserWindow.getAllWindows()
          .map((browserWindow) => find(browserWindow.contentView))
          .find(Boolean);
        if (!contents) throw new Error('Missing sign-in browser view');
        await contents.executeJavaScript(`document.querySelector('#custom-expiry option:checked span')
          .dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
      }, 'Canopy Browser Sign-in Fixture');
      const recording = await window.evaluate(
        (id) => window.api.browser.stopRecording({ browserId: id }),
        browserId,
      );
      expect(JSON.stringify(recording)).not.toContain(
        'private-custom-month-11',
      );
      expect(JSON.stringify(recording)).not.toContain('nth-of-type(2)');

      for (const result of [
        snapshot,
        inspectedPassword,
        inspectedRevealedPassword,
        inspectedForm,
        inspectedOption,
        inspectedOtherOption,
        inspectedSelect,
        inspectedOptgroup,
        inspectedYear,
        inspectedTextarea,
        inspectedLabelledOtp,
        inspectedWrappedOtp,
        inspectedNestedOption,
        inspectedMirror,
        inspectedCustomForm,
        inspectedCardholder,
      ]) {
        expect(result.ok, JSON.stringify(result)).toBe(true);
        const serialized = JSON.stringify(result);
        expect(serialized).not.toContain(password);
        expect(serialized).not.toContain(revealedPassword);
        expect(serialized).not.toContain(code);
        expect(serialized).not.toContain('textarea-otp-secret-9284');
        expect(serialized).not.toContain('labelled-otp-secret-7319');
        expect(serialized).not.toContain('wrapped-otp-secret-8426');
        for (let month = 1; month <= 12; month += 1) {
          expect(serialized).not.toContain(
            `private-month-${String(month).padStart(2, '0')}`,
          );
        }
        expect(serialized).not.toMatch(/private-(year|range)-/);
        expect(serialized).not.toContain('private-custom-month-11');
        expect(serialized).not.toContain('private-cardholder-9284');
      }
      // Ordinary fields stay readable, and redacted fields say so.
      expect(JSON.stringify(snapshot)).toContain('"value":"ada"');
      expect(JSON.stringify(snapshot)).toContain('"valueRedacted":true');
      expect(JSON.stringify(inspectedPassword)).toContain(
        '"valueRedacted":true',
      );
      expect(JSON.stringify(inspectedRevealedPassword)).toContain(
        '"valueRedacted":true',
      );
      expect(JSON.stringify(inspectedOption)).toContain('"valueRedacted":true');
      expect(JSON.stringify(inspectedOption)).not.toContain('nth-of-type(11)');
      expect(JSON.stringify(inspectedOption)).toContain('"label":"[redacted]"');
      expect(inspectedOptgroup.result?.element?.valueRedacted).toBe(true);
      expect(inspectedOptgroup.result?.element?.attributes?.label).toBe(
        '[redacted]',
      );
      expect(inspectedOptgroup.result?.element?.text).toBeUndefined();
      expect(inspectedOptgroup.result?.element?.accessibleName).toBeUndefined();
      expect(JSON.stringify(inspectedOptgroup)).not.toContain('nth-of-type(2)');
      expect(inspectedOptgroup.result?.element?.outerHtml).not.toMatch(
        /\sselected(?:\s|>)/,
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await pages.close();
    }
  });

  test('persistent auth and local storage share a task and stay isolated across browser destruction and app restart', async () => {
    test.setTimeout(180_000);
    const pages = await startLocalPages();
    let launched;
    const projectId = 'demo-ts-pnpm-vite';
    const worktreeId = 'demo-main';
    const isolatedWorktreeId = 'demo-auth-isolated';
    const boundaryFor = (label) =>
      createSelectedLaunchBoundary('persistent-auth', label, {
        close: closeCanopy,
        owners: [worktreeId, isolatedWorktreeId].map((worktreeId) => ({
          projectId,
          worktreeId,
        })),
      });
    let boundary = boundaryFor('initial');
    const { existsSync, realpathSync } = await import('node:fs');
    const { execFileSync } = await import('node:child_process');
    let isolatedOwner;
    let isolatedCheckoutPath;
    const ownerRegistryPath = () =>
      path.join(
        launched.userDataDir,
        'workspaces',
        projectId,
        'worktrees.json',
      );
    const readOwnerRegistry = () =>
      JSON.parse(readFileSync(ownerRegistryPath(), 'utf8'));
    const seedIsolatedOwner = () => {
      const workspaceDir = path.join(
        launched.userDataDir,
        'workspaces',
        projectId,
      );
      const workspace = JSON.parse(
        readFileSync(path.join(workspaceDir, 'workspace.json'), 'utf8'),
      );
      const registry = readOwnerRegistry();
      const source = registry.worktrees.find(
        (entry) => entry.id === worktreeId,
      );
      expect(source).toBeTruthy();
      expect(
        registry.worktrees.some((entry) => entry.id === isolatedWorktreeId),
      ).toBe(false);
      // Boot recovery checks this derived checkout path, not a copied row path.
      // A metadata-only owner is correctly archived as a missing worktree.
      isolatedCheckoutPath = path.join(
        workspaceDir,
        'worktrees',
        isolatedWorktreeId,
      );
      execFileSync(
        'git',
        [
          '-C',
          workspace.repoPath,
          'worktree',
          'add',
          '-b',
          isolatedWorktreeId,
          isolatedCheckoutPath,
          'HEAD',
        ],
        { encoding: 'utf8', timeout: 10000, stdio: 'pipe' },
      );
      expect(existsSync(path.join(isolatedCheckoutPath, '.git'))).toBe(true);
      const registered = execFileSync(
        'git',
        ['-C', workspace.repoPath, 'worktree', 'list', '--porcelain', '-z'],
        { encoding: 'utf8', timeout: 10000 },
      )
        .split('\0')
        .filter((line) => line.startsWith('worktree '))
        .map((line) => realpathSync.native(line.slice('worktree '.length)));
      expect(registered).toContain(realpathSync.native(isolatedCheckoutPath));
      isolatedOwner = {
        id: isolatedWorktreeId,
        branchName: isolatedWorktreeId,
        createdAt: source.createdAt,
        trackedBaseBranch: source.trackedBaseBranch,
      };
      registry.worktrees.push(isolatedOwner);
      writeFileSync(ownerRegistryPath(), JSON.stringify(registry));
    };
    const assertIsolatedOwnerRetained = () => {
      expect(existsSync(isolatedCheckoutPath)).toBe(true);
      expect(
        readOwnerRegistry().worktrees.find(
          (entry) => entry.id === isolatedWorktreeId,
        ),
      ).toMatchObject(isolatedOwner);
    };
    const setUrl = `http://127.0.0.1:${pages.port}/auth/set`;
    const checkUrl = `http://127.0.0.1:${pages.port}/auth/check`;

    const createAndReadAuth = async (window, ownerWorktreeId, url) => {
      const snapshot = await window.evaluate(
        (request) => window.api.browser.create(request),
        { projectId, worktreeId: ownerWorktreeId, url },
      );
      const inspected = await window.evaluate(
        ({ browserId }) =>
          window.api.browser.inspect({ browserId, locator: '#auth-state' }),
        { browserId: snapshot.id },
      );
      return { browserId: snapshot.id, text: inspected.text ?? '' };
    };
    const navigateAndReadAuth = async (window, browserId, url) => {
      await window.evaluate((request) => window.api.browser.navigate(request), {
        browserId,
        url,
      });
      const inspected = await window.evaluate(
        ({ browserId }) =>
          window.api.browser.inspect({ browserId, locator: '#auth-state' }),
        { browserId },
      );
      return inspected.text ?? '';
    };

    try {
      launched = await seedPanelWorktree(boundary.options);
      seedIsolatedOwner();
      // Establish the browser through real chrome before exercising the
      // storage/restart boundary. Phase 0 must stay green on the unchanged
      // BrowserService; no proposed profile API is used here.
      const seeded = await addBrowserPanel(launched.window, 'group-activity');
      await navigatePane(launched.window, seeded.browserId, setUrl);
      await expect(
        launched.window.getByTestId(`panel-tab-${seeded.panelId}`),
      ).toContainText('Canopy Browser Auth Fixture', { timeout: 30_000 });
      await expect
        .poll(async () => {
          const state = await launched.window.evaluate(
            (browserId) =>
              window.api.browser.inspect({ browserId, locator: '#auth-state' }),
            seeded.browserId,
          );
          return state.text ?? '';
        })
        .toContain('local=durable-local-value');
      expect(
        await navigateAndReadAuth(launched.window, seeded.browserId, checkUrl),
      ).toContain('canopy-browser-auth=release-128');
      const shared = await createAndReadAuth(
        launched.window,
        worktreeId,
        checkUrl,
      );
      expect(shared.text).toContain('canopy-browser-auth=release-128');
      expect(shared.text).toContain('local=durable-local-value');
      await launched.window.evaluate(
        (browserId) => window.api.browser.destroy({ browserId }),
        shared.browserId,
      );
      await launched.window.evaluate(
        (browserId) => window.api.browser.destroy({ browserId }),
        seeded.browserId,
      );

      const recreated = await createAndReadAuth(
        launched.window,
        worktreeId,
        checkUrl,
      );
      expect(recreated.browserId).not.toBe(seeded.browserId);
      expect(recreated.text).toContain('canopy-browser-auth=release-128');
      expect(recreated.text).toContain('local=durable-local-value');

      const isolated = await createAndReadAuth(
        launched.window,
        isolatedWorktreeId,
        checkUrl,
      );
      expect(isolated.text).not.toContain('canopy-browser-auth=release-128');
      expect(isolated.text).toContain('local=null');
      await Promise.all([
        launched.window.evaluate(
          (browserId) => window.api.browser.destroy({ browserId }),
          recreated.browserId,
        ),
        launched.window.evaluate(
          (browserId) => window.api.browser.destroy({ browserId }),
          isolated.browserId,
        ),
      ]);

      assertIsolatedOwnerRetained();
      const userDataDir = launched.userDataDir;
      await boundary.close(launched, { keepUserData: true });
      // A restart retains both durable owners. Force-reseeding would remove
      // the isolated owner before startup retirement reconciliation runs.
      const restartBoundary = boundaryFor('restart');
      const restartedOwner = await seedPanelWorktree({
        userDataDir,
        seedDemoWorkspaces: false,
        ...restartBoundary.options,
      });
      launched = restartedOwner;
      boundary = restartBoundary;
      assertIsolatedOwnerRetained();

      const restarted = await createAndReadAuth(
        launched.window,
        worktreeId,
        checkUrl,
      );
      expect(restarted.text).toContain('canopy-browser-auth=release-128');
      expect(restarted.text).toContain('local=durable-local-value');
      const restartedIsolated = await createAndReadAuth(
        launched.window,
        isolatedWorktreeId,
        checkUrl,
      );
      expect(restartedIsolated.text).not.toContain(
        'canopy-browser-auth=release-128',
      );
      expect(restartedIsolated.text).toContain('local=null');
    } finally {
      if (launched) await boundary.close(launched);
      await pages.close();
    }
  });

  test('agent automation and app UI share app-owned JavaScript dialogs', async () => {
    test.setTimeout(120_000);
    const pages = await startLocalPages();
    const { electronApp, userDataDir, window } = await seedPanelWorktree();

    try {
      await electronApp.evaluate(({ dialog }) => {
        const runtime = globalThis;
        runtime.__canopyBrowserNativeDialogCount = 0;
        const originalShowMessageBox = dialog.showMessageBox.bind(dialog);
        dialog.showMessageBox = (...args) => {
          runtime.__canopyBrowserNativeDialogCount += 1;
          return originalShowMessageBox(...args);
        };
      });
      const browser = await addBrowserPanel(window, 'group-terminal');
      await navigatePane(
        window,
        browser.browserId,
        `http://127.0.0.1:${pages.port}/dialog`,
      );
      await expect(
        window.getByTestId(`panel-tab-${browser.panelId}`),
      ).toContainText(DIALOG_PAGE_TITLE, { timeout: 30_000 });
      const dialogView = await browserViewByTitle(
        electronApp,
        DIALOG_PAGE_TITLE,
      );
      expect(dialogView).toBeTruthy();
      expect(dialogView.ownerWindowId).toBe(dialogView.hostWindowId);
      // Agent clicks now open real dialogs. Playwright auto-dismisses dialogs
      // on pages it sees, racing the app's own handling; leave them to the app.
      const dialogUrl = `http://127.0.0.1:${pages.port}/dialog`;
      await expect
        .poll(() =>
          electronApp
            .context()
            .pages()
            .some((page) => page.url() === dialogUrl),
        )
        .toBe(true);
      for (const page of electronApp.context().pages())
        if (page.url() === dialogUrl) page.on('dialog', () => {});
      const promptBridge = await electronApp.evaluate(
        async ({ webContents }, pageTitle) => {
          const contents = webContents
            .getAllWebContents()
            .find((candidate) => candidate.getTitle() === pageTitle);
          if (!contents) throw new Error('Embedded browser page not found.');
          return {
            debuggerAttached: contents.debugger.isAttached(),
            promptSource: await contents.executeJavaScript(
              `String(globalThis.prompt)`,
            ),
          };
        },
        DIALOG_PAGE_TITLE,
      );
      expect(promptBridge.debuggerAttached).toBe(true);
      expect(promptBridge.promptSource).toContain('canopyAppOwnedPrompt');
      const unarmedPrompt = await window.evaluate(async (browserId) => {
        return window.api.browser.automation({
          browserId,
          command: {
            kind: 'click',
            locator: '#prompt-button',
          },
        });
      }, browser.browserId);
      expect(unarmedPrompt).toMatchObject({
        ok: true,
        completed: false,
        dialog: {
          browserId: browser.browserId,
          type: 'prompt',
          message: 'What should the browser remember?',
          defaultPrompt: 'default value',
        },
      });

      const promptDialog = window.getByTestId('browser-javascript-dialog');
      await expect(promptDialog).toBeVisible();
      await expect
        .poll(async () => {
          const view = await browserViewByTitle(electronApp, DIALOG_PAGE_TITLE);
          return view?.visible;
        })
        .toBe(false);
      const promptInput = promptDialog.getByRole('textbox', {
        name: 'Response',
      });
      await expect(promptInput).toHaveValue('default value');
      await promptInput.fill('user supplied value');
      await promptDialog.getByRole('button', { name: 'OK' }).click();
      await expect(promptDialog).toHaveCount(0);
      const unarmedPromptResult = await window.evaluate(async (browserId) => {
        return window.api.browser.inspect({
          browserId,
          locator: '#prompt-result',
        });
      }, browser.browserId);
      expect(unarmedPromptResult.text).toBe('user supplied value');

      const prearmed = await window.evaluate(async (browserId) => {
        return window.api.browser.automation({
          browserId,
          command: {
            kind: 'click',
            locator: '#confirm-button',
            dialogResponse: { accept: false },
          },
        });
      }, browser.browserId);
      expect(prearmed).toMatchObject({
        ok: true,
        completed: true,
        handledDialog: {
          accept: false,
          dialog: {
            browserId: browser.browserId,
            type: 'confirm',
            message: 'Continue with this action?',
          },
        },
      });
      const prearmedResult = await window.evaluate(async (browserId) => {
        return window.api.browser.inspect({
          browserId,
          locator: '#confirm-result',
        });
      }, browser.browserId);
      expect(prearmedResult.text).toBe('dismissed');

      const prearmedPrompt = await window.evaluate(async (browserId) => {
        return window.api.browser.automation({
          browserId,
          command: {
            kind: 'click',
            locator: '#prompt-button',
            dialogResponse: {
              accept: true,
              promptText: 'agent supplied value',
            },
          },
        });
      }, browser.browserId);
      expect(prearmedPrompt).toMatchObject({
        ok: true,
        completed: true,
        handledDialog: {
          accept: true,
          promptText: 'agent supplied value',
          dialog: {
            browserId: browser.browserId,
            type: 'prompt',
            message: 'What should the browser remember?',
            defaultPrompt: 'default value',
          },
        },
      });
      const prearmedPromptResult = await window.evaluate(async (browserId) => {
        return window.api.browser.inspect({
          browserId,
          locator: '#prompt-result',
        });
      }, browser.browserId);
      expect(prearmedPromptResult.text).toBe('agent supplied value');
      expect(
        await electronApp.evaluate(
          () => globalThis.__canopyBrowserNativeDialogCount,
        ),
      ).toBe(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await pages.close();
    }
  });

  test('two Browser panels: transactional add, live identity, side-by-side, close destruction', async ({}, testInfo) => {
    test.setTimeout(180_000);
    const pages = await startLocalPages();
    const screenshotBoundary = createSelectedLaunchBoundary(
      'two-browser-panels-screenshot',
      'initial',
      { close: closeCanopy },
    );
    const selectedEnvironment = screenshotBoundary.options.env;
    const rawScreenshotDiagnostic =
      selectedEnvironment?.CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS;
    const requestedCloseQualification =
      process.env.CANOPY_E2E_NATIVE_CLOSE_HANDLE_QUALIFICATION;
    const nativeCloseQualification =
      rawScreenshotDiagnostic &&
      ['clean0', 'target125'].includes(requestedCloseQualification)
        ? requestedCloseQualification
        : undefined;
    const launchEnvironment = rawScreenshotDiagnostic
      ? {
          ...selectedEnvironment,
          CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS: JSON.stringify({
            ...JSON.parse(rawScreenshotDiagnostic),
            mode: nativeCloseQualification ? 'close' : 'screenshot',
          }),
        }
      : undefined;
    const nativeViewportDiagnosticSelected = Boolean(
      rawScreenshotDiagnostic &&
      process.env.CANOPY_E2E_NATIVE_VIEWPORT_DIAGNOSTIC === '1',
    );
    const launchOptions = {
      ...(launchEnvironment ? { env: launchEnvironment } : {}),
      ...(nativeViewportDiagnosticSelected ? {} : { viewportSize: null }),
    };
    const { electronApp, userDataDir, window } =
      await seedPanelWorktree(launchOptions);
    const terminalResult = nativeCloseQualification
      ? observeElectronTerminalResult(electronApp)
      : undefined;

    let bodyError;
    try {
      const pageOneUrl = `http://127.0.0.1:${pages.port}/one`;
      const pageTwoUrl = `http://127.0.0.1:${pages.port}/two`;

      // --- 1. First Browser panel through the outer `+` menu ---------------
      const first = await addBrowserPanel(window, 'group-terminal');
      await expect(window.getByTestId('panel-content-browser')).toBeVisible();
      await expect(window.getByTestId('browser-panel-surface')).toBeVisible();

      // BrowserBar is the FIRST content element; no inner browser chrome.
      const firstPane = window.getByTestId(`browser-pane-${first.browserId}`);
      await expect(firstPane).toBeVisible();
      await expect(firstPane.getByTestId('browser-bar')).toBeVisible();
      await expect(window.getByTestId('browser-new')).toHaveCount(0);
      await expect(window.getByTestId('browser-split')).toHaveCount(0);
      await expect(window.locator('[data-testid^="browser-tab-"]')).toHaveCount(
        0,
      );
      // Blank session → empty pane copy.
      await expect(window.getByTestId('browser-pane-empty')).toContainText(
        'Enter a URL to start.',
      );

      // --- 2. Second Browser panel: the row is ALWAYS offered --------------
      const second = await addBrowserPanel(window, 'group-terminal');
      expect(second.browserId).not.toBe(first.browserId);

      // --- 3. Independent navigation + live outer tab labels ---------------
      // The second panel is the group's active tab right now.
      await navigatePane(window, second.browserId, pageTwoUrl);
      const secondTab = window.getByTestId(`panel-tab-${second.panelId}`);
      await expect(secondTab).toContainText(PAGE_TWO_TITLE, {
        timeout: 30_000,
      });

      // Switch to the first panel's tab and navigate it to page one.
      const firstTab = window.getByTestId(`panel-tab-${first.panelId}`);
      await firstTab.click();
      await navigatePane(window, first.browserId, pageOneUrl);
      await expect(firstTab).toContainText(PAGE_ONE_TITLE, {
        timeout: 30_000,
      });
      // Independence: the OTHER tab keeps its own title.
      await expect(secondTab).toContainText(PAGE_TWO_TITLE);

      // Each outer tab carries its own live favicon.
      await expect(firstTab.locator('img')).toBeVisible();
      await expect(secondTab.locator('img')).toBeVisible();
      const firstFavicon = await firstTab.locator('img').getAttribute('src');
      const secondFavicon = await secondTab.locator('img').getAttribute('src');
      expect(firstFavicon).toBeTruthy();
      expect(secondFavicon).toBeTruthy();
      expect(firstFavicon).not.toBe(secondFavicon);

      // --- 4. One-line rich tooltip: globe + `Browser · full title` --------
      await firstTab.locator('.canopy-panel-tab-title').hover();
      const tooltip = window.getByTestId(
        `panel-tab-browser-tooltip-${first.browserId}`,
      );
      await expect(tooltip).toBeVisible({ timeout: 10_000 });
      await expect(
        tooltip.locator('.canopy-panel-tab-rich-tooltip-title'),
      ).toHaveText(PAGE_ONE_TITLE);
      await expect(
        tooltip.locator('.canopy-panel-tab-rich-tooltip-subtitle'),
      ).toHaveText('Browser');
      await expect(
        tooltip.locator('.canopy-panel-tab-rich-tooltip-separator'),
      ).toHaveText('·');
      await expect(tooltip).toHaveText(`Browser · ${PAGE_ONE_TITLE}`);
      expect(
        await tooltip.evaluate(
          (element) => getComputedStyle(element).whiteSpace,
        ),
      ).toBe('nowrap');
      // Move away so the tooltip closes before grid operations.
      await window.getByTestId('panel-content-chat').hover();

      // --- 5. Side by side through the outer grid --------------------------
      await movePanelViaApi(window, second.panelId, first.groupId, 'right');
      const arranged = await browserPanels(window);
      const firstArranged = arranged.find(
        (panel) => panel.panelId === first.panelId,
      );
      const secondArranged = arranged.find(
        (panel) => panel.panelId === second.panelId,
      );
      expect(firstArranged.groupId).not.toBe(secondArranged.groupId);
      // Both panes are now simultaneously visible with their own BrowserBars
      // showing their own URLs.
      await expect(
        window.getByTestId(`browser-pane-${first.browserId}`),
      ).toBeVisible();
      await expect(
        window.getByTestId(`browser-pane-${second.browserId}`),
      ).toBeVisible();
      await expect(window.getByTestId('browser-bar')).toHaveCount(2);
      for (const [browserId, url] of [
        [first.browserId, pageOneUrl],
        [second.browserId, pageTwoUrl],
      ]) {
        const address = window
          .getByTestId(`browser-pane-${browserId}`)
          .getByTestId('browser-url-input');
        await address.focus();
        await expect(address).toHaveValue(url);
        await address.blur();
      }

      // The two native views have independent non-overlapping bounds.
      await expect
        .poll(async () => {
          const views = await nativeBrowserViews(electronApp);
          const firstBounds = views.find(
            (view) => view.title === PAGE_ONE_TITLE,
          )?.bounds;
          const secondBounds = views.find(
            (view) => view.title === PAGE_TWO_TITLE,
          )?.bounds;

          return {
            firstPositive: Boolean(
              firstBounds && firstBounds.width > 0 && firstBounds.height > 0,
            ),
            secondPositive: Boolean(
              secondBounds && secondBounds.width > 0 && secondBounds.height > 0,
            ),
            separate: Boolean(
              firstBounds &&
              secondBounds &&
              (firstBounds.x !== secondBounds.x ||
                firstBounds.y !== secondBounds.y ||
                firstBounds.width !== secondBounds.width ||
                firstBounds.height !== secondBounds.height),
            ),
            nonOverlapping: Boolean(
              firstBounds &&
              secondBounds &&
              (firstBounds.x + firstBounds.width <= secondBounds.x ||
                secondBounds.x + secondBounds.width <= firstBounds.x ||
                firstBounds.y + firstBounds.height <= secondBounds.y ||
                secondBounds.y + secondBounds.height <= firstBounds.y),
            ),
          };
        })
        .toEqual({
          firstPositive: true,
          secondPositive: true,
          separate: true,
          nonOverlapping: true,
        });

      // The interface scale is a uniform zoom: the pane keeps reporting its
      // content rect in CSS px while the native view is positioned in window
      // DIPs, so the view must cover the content area (under the bar, the
      // inspector closed) at CSS rect x zoom, within the renderer's and
      // main's rounding. 100% first proves the content-rect derivation.
      const expectNativeViewCoversPane = async (browserId, title, zoom) => {
        await expect
          .poll(async () => {
            const content = await window.evaluate((id) => {
              const pane = document.querySelector(
                `[data-testid="browser-pane-${id}"]`,
              );
              const bar = pane?.querySelector('[data-testid="browser-bar"]');
              if (!pane || !bar) return null;
              const paneBox = pane.getBoundingClientRect();
              const barBox = bar.getBoundingClientRect();
              return {
                x: paneBox.left,
                y: barBox.bottom,
                width: paneBox.width,
                height: paneBox.bottom - barBox.bottom,
              };
            }, browserId);
            const native = (await browserViewByTitle(electronApp, title))
              ?.bounds;
            if (!content || !native) return Number.POSITIVE_INFINITY;
            return Math.max(
              Math.abs(native.x - content.x * zoom),
              Math.abs(native.y - content.y * zoom),
              Math.abs(native.width - content.width * zoom),
              Math.abs(native.height - content.height * zoom),
            );
          })
          .toBeLessThanOrEqual(1.5);
      };
      await expectNativeViewCoversPane(first.browserId, PAGE_ONE_TITLE, 1);
      await setUiScale(window, 150);
      await expectNativeViewCoversPane(first.browserId, PAGE_ONE_TITLE, 1.5);
      await setUiScale(window, 100);
      await expectNativeViewCoversPane(first.browserId, PAGE_ONE_TITLE, 1);

      // An overlay intersecting only pane one blocks only its native view.
      const firstBox = await window
        .getByTestId(`browser-pane-${first.browserId}`)
        .boundingBox();
      expect(firstBox).toBeTruthy();
      await window.evaluate((box) => {
        const overlay = document.createElement('div');
        overlay.id = 'browser-native-overlay-e2e';
        overlay.setAttribute('data-canopy-browser-native-overlay', 'true');
        Object.assign(overlay.style, {
          position: 'fixed',
          left: `${box.x}px`,
          top: `${box.y}px`,
          width: `${box.width}px`,
          height: `${box.height}px`,
          zIndex: '99999',
        });
        document.body.appendChild(overlay);
      }, firstBox);
      await expect
        .poll(() => browserVisibilityByTitle(electronApp))
        .toEqual({ first: false, second: true });

      // Expanding the same overlay across the viewport blocks both panes.
      await window.evaluate(() => {
        const overlay = document.getElementById('browser-native-overlay-e2e');
        Object.assign(overlay.style, {
          left: '0px',
          top: '0px',
          width: '100vw',
          height: '100vh',
        });
      });
      await expect
        .poll(() => browserVisibilityByTitle(electronApp))
        .toEqual({ first: false, second: false });
      await window.evaluate(() => {
        document.getElementById('browser-native-overlay-e2e')?.remove();
      });
      await expect
        .poll(() => browserVisibilityByTitle(electronApp))
        .toEqual({ first: true, second: true });

      // A plain floating surface (no marker, no role) blocks the pane it
      // overlaps too: any design-system floating layer counts by default.
      const pageBox = await window
        .getByTestId(`browser-pane-${first.browserId}`)
        .getByTestId('browser-page-area')
        .boundingBox();
      expect(pageBox).toBeTruthy();
      await window.evaluate((box) => {
        const popover = document.createElement('div');
        popover.id = 'browser-unmarked-popover-e2e';
        popover.className = 'fixed z-dropdown';
        Object.assign(popover.style, {
          left: `${box.x}px`,
          top: `${box.y}px`,
          width: '40px',
          height: '40px',
        });
        document.body.appendChild(popover);
      }, pageBox);
      await expect
        .poll(() => browserVisibilityByTitle(electronApp))
        .toEqual({ first: false, second: true });
      await window.evaluate(() => {
        document.getElementById('browser-unmarked-popover-e2e')?.remove();
      });
      await expect
        .poll(() => browserVisibilityByTitle(electronApp))
        .toEqual({ first: true, second: true });

      // Move, split/collapse, and maximize/restore topology transitions all
      // invalidate and refresh the surviving native view bounds.
      const beforeCollapse = (
        await browserViewByTitle(electronApp, PAGE_ONE_TITLE)
      ).bounds;
      const beforeMaximize = (
        await browserViewByTitle(electronApp, PAGE_TWO_TITLE)
      ).bounds;
      await window.evaluate(
        (groupId) => window.__canopyPanelTestApi.collapseGroup(groupId, true),
        firstArranged.groupId,
      );
      await expect
        .poll(
          async () =>
            (await browserViewByTitle(electronApp, PAGE_ONE_TITLE))?.visible,
        )
        .toBe(false);
      await window.evaluate(
        (groupId) => window.__canopyPanelTestApi.collapseGroup(groupId, false),
        firstArranged.groupId,
      );
      await expect
        .poll(
          async () =>
            (await browserViewByTitle(electronApp, PAGE_ONE_TITLE))?.visible,
        )
        .toBe(true);
      await window.evaluate(
        (groupId) => window.__canopyPanelTestApi.maximizeGroup(groupId, true),
        secondArranged.groupId,
      );
      await expect
        .poll(
          async () =>
            (await browserViewByTitle(electronApp, PAGE_TWO_TITLE))?.bounds,
        )
        .not.toEqual(beforeMaximize);
      await window.evaluate(
        (groupId) => window.__canopyPanelTestApi.maximizeGroup(groupId, false),
        secondArranged.groupId,
      );
      await expect
        .poll(async () => {
          const restored = (
            await browserViewByTitle(electronApp, PAGE_ONE_TITLE)
          )?.bounds;
          if (!restored) return Infinity;
          return Math.max(
            ...['x', 'y', 'width', 'height'].map((key) =>
              Math.abs(restored[key] - beforeCollapse[key]),
            ),
          );
        })
        // Grid restoration can round a fractional split by one CSS pixel.
        .toBeLessThanOrEqual(1);
      await expectNativeViewCoversPane(first.browserId, PAGE_ONE_TITLE, 1);

      // App-level navigation keeps MainPage mounted, but both native views
      // must hide while another page or Settings is on screen. Exercise both
      // history arrows because those were a distinct bleed-through path.
      const app = new CanopyAppDriver(window);
      await app.openUsagePage();
      await expect
        .poll(() => browserVisibilityByTitle(electronApp))
        .toEqual({ first: false, second: false });
      await window.getByTestId('nav-history-back').click();
      await app.expectMainPage();
      await expect
        .poll(() => browserVisibilityByTitle(electronApp))
        .toEqual({ first: true, second: true });
      await window.getByTestId('nav-history-forward').click();
      await expect(window.getByTestId('page-usage')).toBeVisible();
      await expect
        .poll(() => browserVisibilityByTitle(electronApp))
        .toEqual({ first: false, second: false });
      await window.getByTestId('nav-history-back').click();
      await app.expectMainPage();
      await expect
        .poll(() => browserVisibilityByTitle(electronApp))
        .toEqual({ first: true, second: true });

      await app.openSettings();
      await expect
        .poll(() => browserVisibilityByTitle(electronApp))
        .toEqual({ first: false, second: false });
      await app.closeSettings();
      await expect
        .poll(() => browserVisibilityByTitle(electronApp))
        .toEqual({ first: true, second: true });

      // Native screenshots are routed to the requested browser id and the
      // deliberately different red/blue pages produce different captures.
      let captures;
      let deferredViewportDiagnosticError = null;
      if (!nativeViewportDiagnosticSelected) {
        const targets = [
          { browserId: first.browserId, title: PAGE_ONE_TITLE },
          { browserId: second.browserId, title: PAGE_TWO_TITLE },
        ];
        const hostHandle = await electronApp.browserWindow(window);
        try {
          await expect
            .poll(
              async () => {
                const renderer = await window.evaluate(() => ({
                  width: window.innerWidth,
                  height: window.innerHeight,
                }));
                const native = await hostHandle.evaluate(
                  (host, { requestedTargets, renderer }) => {
                    if (!host || host.isDestroyed())
                      return {
                        hostFound: Boolean(host),
                        destroyed: Boolean(host?.isDestroyed()),
                        rendererMatchesContentBounds: false,
                        rendererMatchesContentViewBounds: false,
                        truncated: false,
                        targets: [],
                      };
                    const contentBounds = host.getContentBounds();
                    const contentViewBounds = host.contentView.getBounds();
                    const directChildren = host.contentView.children;
                    // A Browser page's window child is its frame, which
                    // holds the page two views down at the frame's bounds.
                    const pageOf = (view) =>
                      view.webContents
                        ? view
                        : (view.children?.[0]?.children?.[0] ?? view);
                    const inspectedChildren = directChildren
                      .slice(0, 16)
                      .map((frame) => {
                        const view = pageOf(frame);
                        return {
                          webContentsId: view.webContents?.id ?? null,
                          title:
                            view.webContents && !view.webContents.isDestroyed()
                              ? view.webContents.getTitle()
                              : null,
                          live: Boolean(
                            view.webContents && !view.webContents.isDestroyed(),
                          ),
                          visible: frame.getVisible() && view.getVisible(),
                          bounds: frame.getBounds(),
                        };
                      });
                    const intersectsContentView = (bounds) =>
                      Boolean(
                        bounds &&
                        bounds.width > 0 &&
                        bounds.height > 0 &&
                        bounds.x <
                          contentViewBounds.x + contentViewBounds.width &&
                        bounds.x + bounds.width > contentViewBounds.x &&
                        bounds.y <
                          contentViewBounds.y + contentViewBounds.height &&
                        bounds.y + bounds.height > contentViewBounds.y,
                      );
                    return {
                      hostFound: true,
                      destroyed: false,
                      hostWindowId: host.id,
                      rendererWebContentsId: host.webContents.id,
                      rendererMatchesContentBounds:
                        renderer.width === contentBounds.width &&
                        renderer.height === contentBounds.height,
                      rendererMatchesContentViewBounds:
                        renderer.width === contentViewBounds.width &&
                        renderer.height === contentViewBounds.height,
                      truncated: directChildren.length > 16,
                      targets: requestedTargets.map(({ browserId, title }) => {
                        const matches = inspectedChildren.filter(
                          (child) => child.title === title,
                        );
                        const match = matches[0];
                        return {
                          browserId,
                          matchCount: matches.length,
                          webContentsId: match?.webContentsId ?? null,
                          live: match?.live ?? false,
                          visible: match?.visible ?? false,
                          intersectsContentView: intersectsContentView(
                            match?.bounds,
                          ),
                        };
                      }),
                    };
                  },
                  { requestedTargets: targets, renderer },
                );
                return {
                  hostFound: native.hostFound,
                  destroyed: native.destroyed,
                  rendererMatchesContentBounds:
                    native.rendererMatchesContentBounds,
                  rendererMatchesContentViewBounds:
                    native.rendererMatchesContentViewBounds,
                  truncated: native.truncated,
                  targets: native.targets.map(
                    ({
                      browserId,
                      matchCount,
                      live,
                      visible,
                      intersectsContentView,
                    }) => ({
                      browserId,
                      matchCount,
                      live,
                      visible,
                      intersectsContentView,
                    }),
                  ),
                };
              },
              {
                intervals: [100, 250, 500],
                timeout: 10_000,
                message: 'ordinary Browser screenshot geometry must settle',
              },
            )
            .toEqual({
              hostFound: true,
              destroyed: false,
              rendererMatchesContentBounds: true,
              rendererMatchesContentViewBounds: true,
              truncated: false,
              targets: targets.map(({ browserId }) => ({
                browserId,
                matchCount: 1,
                live: true,
                visible: true,
                intersectsContentView: true,
              })),
            });
        } finally {
          await hostHandle.dispose();
        }
        captures = await window.evaluate(
          async (ids) => {
            const [firstCapture, secondCapture] = await Promise.all([
              window.api.browser.screenshot({ browserId: ids.first }),
              window.api.browser.screenshot({ browserId: ids.second }),
            ]);
            return {
              first: firstCapture.dataUrl,
              second: secondCapture.dataUrl,
            };
          },
          { first: first.browserId, second: second.browserId },
        );
      } else {
        const targets = [
          { browserId: first.browserId, title: PAGE_ONE_TITLE },
          { browserId: second.browserId, title: PAGE_TWO_TITLE },
        ];
        const evidence = {
          schemaVersion: 1,
          diagnosticOnly: true,
          acceptanceEligible: false,
          targetBrowserIds: targets.map((target) => target.browserId),
          before: {},
          after: {},
          outcome: 'diagnostic-incomplete',
        };
        const boundedError = (error) => {
          const message =
            error &&
            typeof error === 'object' &&
            typeof error.message === 'string'
              ? error.message
              : String(error);
          return message.length <= 512 ? message : `${message.slice(0, 512)}…`;
        };
        const rendererGeometry = () =>
          window.evaluate(() => ({
            width: window.innerWidth,
            height: window.innerHeight,
          }));
        const nativeGeometry = (handle) =>
          handle.evaluate((host, requestedTargets) => {
            const boundedText = (value, limit = 256) => {
              const text = typeof value === 'string' ? value : String(value);
              return text.length <= limit ? text : `${text.slice(0, limit)}…`;
            };
            const intersects = (bounds, parent) =>
              Boolean(
                bounds &&
                parent &&
                bounds.width > 0 &&
                bounds.height > 0 &&
                parent.width > 0 &&
                parent.height > 0 &&
                bounds.x < parent.x + parent.width &&
                bounds.x + bounds.width > parent.x &&
                bounds.y < parent.y + parent.height &&
                bounds.y + bounds.height > parent.y,
              );
            if (!host)
              return {
                hostFound: false,
                mainProcessId: process.pid,
                targets: requestedTargets.map(({ browserId }) => ({
                  browserId,
                  matchCount: 0,
                  webContentsId: null,
                  live: false,
                  intersectsContentView: false,
                })),
              };
            const destroyed = host.isDestroyed();
            if (destroyed)
              return {
                hostFound: true,
                destroyed: true,
                mainProcessId: process.pid,
                hostWindowId: host.id,
                rendererWebContentsId: null,
                targets: requestedTargets.map(({ browserId }) => ({
                  browserId,
                  matchCount: 0,
                  webContentsId: null,
                  live: false,
                  intersectsContentView: false,
                })),
              };
            const contentViewBounds = host.contentView.getBounds();
            const directChildren = host.contentView.children;
            const childCount = directChildren.length;
            const inspectedChildCount = Math.min(childCount, 16);
            const children = [];
            for (let index = 0; index < inspectedChildCount; index++) {
              // A Browser page's window child is its frame, which holds the
              // page two views down at the frame's bounds.
              const frame = directChildren[index];
              const view = frame.webContents
                ? frame
                : (frame.children?.[0]?.children?.[0] ?? frame);
              const childDestroyed =
                !view.webContents || view.webContents.isDestroyed();
              children.push({
                webContentsId: view.webContents?.id ?? null,
                title: childDestroyed
                  ? null
                  : boundedText(view.webContents.getTitle()),
                destroyed: childDestroyed,
                visible: frame.getVisible() && view.getVisible(),
                bounds: frame.getBounds(),
              });
            }
            return {
              hostFound: true,
              destroyed: false,
              mainProcessId: process.pid,
              hostWindowId: host.id,
              rendererWebContentsId: host.webContents.id,
              visible: host.isVisible(),
              minimized: host.isMinimized(),
              bounds: host.getBounds(),
              contentBounds: host.getContentBounds(),
              contentViewBounds,
              childCount,
              inspectedChildCount,
              droppedChildCount: childCount - inspectedChildCount,
              truncated: childCount > inspectedChildCount,
              children,
              targets: requestedTargets.map(({ browserId, title }) => {
                const matches = children.filter(
                  (child) => child.title === title,
                );
                const match = matches[0];
                return {
                  browserId,
                  expectedTitle: boundedText(title),
                  matchCount: matches.length,
                  webContentsId: match?.webContentsId ?? null,
                  live: Boolean(match && !match.destroyed),
                  visible: match?.visible ?? null,
                  bounds: match?.bounds ?? null,
                  intersectsContentView: intersects(
                    match?.bounds,
                    contentViewBounds,
                  ),
                };
              }),
            };
          }, targets);
        const captureDiagnosticPair = () =>
          window.evaluate(
            async (requestedIds) => {
              const settled = await Promise.allSettled(
                requestedIds.map((browserId) =>
                  window.api.browser.screenshot({ browserId }),
                ),
              );
              return {
                ok: settled.every(
                  (result) =>
                    result.status === 'fulfilled' &&
                    typeof result.value?.dataUrl === 'string' &&
                    result.value.dataUrl.startsWith('data:image/png;base64,') &&
                    result.value.dataUrl.length >
                      'data:image/png;base64,'.length,
                ),
                outcomes: settled.map((result, index) => {
                  const browserId = requestedIds[index];
                  if (result.status === 'rejected') {
                    const raw =
                      result.reason &&
                      typeof result.reason === 'object' &&
                      typeof result.reason.message === 'string'
                        ? result.reason.message
                        : String(result.reason);
                    return {
                      browserId,
                      ok: false,
                      error: raw.length <= 512 ? raw : `${raw.slice(0, 512)}…`,
                    };
                  }
                  const dataUrl = result.value?.dataUrl;
                  return {
                    browserId,
                    ok: true,
                    pngPrefix:
                      typeof dataUrl === 'string' &&
                      dataUrl.startsWith('data:image/png;base64,'),
                    nonempty:
                      typeof dataUrl === 'string' &&
                      dataUrl.length > 'data:image/png;base64,'.length,
                    length: typeof dataUrl === 'string' ? dataUrl.length : 0,
                  };
                }),
              };
            },
            targets.map((target) => target.browserId),
          );
        const nativeIssue = (native, expectedIdentity, requireAlignment) => {
          if (!native?.hostFound) return 'Exact native host was lost.';
          if (native.destroyed) return 'Exact native host is destroyed.';
          if (native.visible) return 'Exact native host is visible.';
          if (
            !native.contentBounds ||
            native.contentBounds.width <= 0 ||
            native.contentBounds.height <= 0 ||
            !native.contentViewBounds ||
            native.contentViewBounds.width <= 0 ||
            native.contentViewBounds.height <= 0
          )
            return 'Exact native host has invalid content bounds.';
          if (native.truncated)
            return 'Direct child inspection was truncated; exact target identity is incomplete.';
          if (
            native.targets.length !== targets.length ||
            native.targets.some(
              (target) =>
                target.matchCount !== 1 || !target.live || !target.visible,
            )
          )
            return 'A requested Browser target is missing, duplicated, destroyed, or hidden.';
          if (
            expectedIdentity &&
            (native.mainProcessId !== expectedIdentity.mainProcessId ||
              native.hostWindowId !== expectedIdentity.hostWindowId ||
              native.rendererWebContentsId !==
                expectedIdentity.rendererWebContentsId)
          )
            return 'Exact native app or host identity changed.';
          if (
            expectedIdentity &&
            native.minimized !== expectedIdentity.minimized
          )
            return 'Exact native host minimized state changed.';
          if (
            expectedIdentity &&
            (native.contentBounds.width !==
              expectedIdentity.contentBounds.width ||
              native.contentBounds.height !==
                expectedIdentity.contentBounds.height ||
              native.contentViewBounds.width !==
                expectedIdentity.contentViewBounds.width ||
              native.contentViewBounds.height !==
                expectedIdentity.contentViewBounds.height)
          )
            return 'Exact native content dimensions changed.';
          if (
            expectedIdentity &&
            native.targets.some(
              (target, index) =>
                target.browserId !==
                  expectedIdentity.targets[index].browserId ||
                target.webContentsId !==
                  expectedIdentity.targets[index].webContentsId ||
                target.live !== expectedIdentity.targets[index].live ||
                target.visible !== expectedIdentity.targets[index].visible,
            )
          )
            return 'A requested Browser target identity, liveness, or visibility changed.';
          if (
            requireAlignment &&
            native.targets.some((target) => !target.intersectsContentView)
          )
            return 'A live Browser child does not intersect native content.';
          return null;
        };

        let diagnosticError = null;
        let afterCaptureError = null;
        let attachmentError = null;
        let hostHandle = null;
        let beforeIdentity = null;
        try {
          try {
            hostHandle = await electronApp.browserWindow(window);
            evidence.before.renderer = await rendererGeometry();
            evidence.before.native = await nativeGeometry(hostHandle);
            const issue = nativeIssue(evidence.before.native, null, false);
            if (issue) diagnosticError = new Error(issue);
            else
              beforeIdentity = {
                mainProcessId: evidence.before.native.mainProcessId,
                hostWindowId: evidence.before.native.hostWindowId,
                rendererWebContentsId:
                  evidence.before.native.rendererWebContentsId,
                minimized: evidence.before.native.minimized,
                contentBounds: {
                  width: evidence.before.native.contentBounds.width,
                  height: evidence.before.native.contentBounds.height,
                },
                contentViewBounds: {
                  width: evidence.before.native.contentViewBounds.width,
                  height: evidence.before.native.contentViewBounds.height,
                },
                targets: evidence.before.native.targets.map(
                  ({ browserId, webContentsId, live, visible }) => ({
                    browserId,
                    webContentsId,
                    live,
                    visible,
                  }),
                ),
              };
          } catch (error) {
            diagnosticError = error;
          }

          try {
            evidence.before.capture = await captureDiagnosticPair();
          } catch (error) {
            evidence.before.capture = {
              ok: false,
              observationError: boundedError(error),
            };
            diagnosticError ??= error;
          }

          if (!diagnosticError && hostHandle) {
            try {
              const measuredContent = evidence.before.native.contentBounds;
              await window.setViewportSize({
                width: measuredContent.width,
                height: measuredContent.height,
              });
              await window.evaluate(() =>
                window.dispatchEvent(new Event('resize')),
              );
              await expect
                .poll(
                  async () => {
                    evidence.alignment ??= {};
                    evidence.alignment.renderer = await rendererGeometry();
                    evidence.alignment.native =
                      await nativeGeometry(hostHandle);
                    const issue = nativeIssue(
                      evidence.alignment.native,
                      beforeIdentity,
                      true,
                    );
                    const rendererAligned = Boolean(
                      !issue &&
                      evidence.alignment.renderer.width ===
                        evidence.alignment.native.contentBounds.width &&
                      evidence.alignment.renderer.height ===
                        evidence.alignment.native.contentBounds.height &&
                      evidence.alignment.renderer.width ===
                        evidence.alignment.native.contentViewBounds.width &&
                      evidence.alignment.renderer.height ===
                        evidence.alignment.native.contentViewBounds.height,
                    );
                    return {
                      ready: rendererAligned,
                      reason:
                        issue ??
                        (rendererAligned
                          ? null
                          : 'Renderer and native content sizes differ.'),
                    };
                  },
                  {
                    intervals: [100, 250, 500],
                    timeout: 10_000,
                    message: 'native viewport alignment must settle',
                  },
                )
                .toEqual({ ready: true, reason: null });
            } catch (error) {
              diagnosticError = error;
            }
          }

          try {
            captures = await window.evaluate(
              async (ids) => {
                const [firstCapture, secondCapture] = await Promise.all([
                  window.api.browser.screenshot({ browserId: ids.first }),
                  window.api.browser.screenshot({ browserId: ids.second }),
                ]);
                return {
                  first: firstCapture.dataUrl,
                  second: secondCapture.dataUrl,
                };
              },
              { first: first.browserId, second: second.browserId },
            );
            const afterValues = [captures.first, captures.second];
            const outcomes = afterValues.map((value, index) => ({
              browserId: targets[index].browserId,
              ok:
                typeof value === 'string' &&
                value.startsWith('data:image/png;base64,') &&
                value.length > 'data:image/png;base64,'.length,
              pngPrefix:
                typeof value === 'string' &&
                value.startsWith('data:image/png;base64,'),
              nonempty:
                typeof value === 'string' &&
                value.length > 'data:image/png;base64,'.length,
              length: typeof value === 'string' ? value.length : 0,
            }));
            evidence.after.capture = {
              ok: outcomes.every((outcome) => outcome.ok),
              outcomes,
            };
          } catch (error) {
            evidence.after.capture = {
              ok: false,
              requestedBrowserIds: targets.map((target) => target.browserId),
              error: boundedError(error),
            };
            afterCaptureError = error;
          }

          try {
            if (!hostHandle)
              throw new Error(
                'Exact native host is unavailable for the after-capture snapshot.',
              );
            [evidence.after.renderer, evidence.after.native] =
              await Promise.all([
                rendererGeometry(),
                nativeGeometry(hostHandle),
              ]);
            const issue = nativeIssue(
              evidence.after.native,
              beforeIdentity,
              true,
            );
            if (issue) throw new Error(issue);
            if (
              evidence.after.renderer.width !==
                evidence.after.native.contentBounds.width ||
              evidence.after.renderer.height !==
                evidence.after.native.contentBounds.height ||
              evidence.after.renderer.width !==
                evidence.after.native.contentViewBounds.width ||
              evidence.after.renderer.height !==
                evidence.after.native.contentViewBounds.height
            )
              throw new Error(
                'Renderer and native content sizes differ after capture.',
              );
          } catch (error) {
            evidence.after.observationError = boundedError(error);
            diagnosticError ??= error;
          }
        } finally {
          if (hostHandle) {
            try {
              await hostHandle.dispose();
            } catch (error) {
              diagnosticError ??= error;
            }
          }
          if (diagnosticError)
            evidence.diagnosticError = boundedError(diagnosticError);
          if (afterCaptureError) evidence.outcome = 'after-capture-failed';
          else if (evidence.before.capture?.ok)
            evidence.outcome = 'initial-capture-succeeded-non-reproduction';
          else {
            const beforeRenderer = evidence.before.renderer;
            const beforeNative = evidence.before.native;
            const alignmentRenderer = evidence.alignment?.renderer;
            const alignmentNative = evidence.alignment?.native;
            const afterRenderer = evidence.after.renderer;
            const afterNative = evidence.after.native;
            const mismatchBefore = Boolean(
              beforeRenderer &&
              beforeNative?.contentBounds &&
              (beforeRenderer.width !== beforeNative.contentBounds.width ||
                beforeRenderer.height !== beforeNative.contentBounds.height),
            );
            const alignmentReady = Boolean(
              alignmentRenderer &&
              alignmentNative?.contentBounds &&
              alignmentRenderer.width === alignmentNative.contentBounds.width &&
              alignmentRenderer.height ===
                alignmentNative.contentBounds.height &&
              alignmentNative.targets?.every(
                (target) => target.live && target.intersectsContentView,
              ),
            );
            const alignedAfter = Boolean(
              afterRenderer &&
              afterNative?.contentBounds &&
              afterRenderer.width === afterNative.contentBounds.width &&
              afterRenderer.height === afterNative.contentBounds.height &&
              afterNative.targets?.every(
                (target) => target.live && target.intersectsContentView,
              ),
            );
            const unavailableBefore = Boolean(
              evidence.before.capture?.outcomes?.length === targets.length &&
              evidence.before.capture.outcomes.every(
                (outcome) =>
                  !outcome.ok &&
                  outcome.error === 'Browser screenshot is unavailable',
              ),
            );
            evidence.outcome =
              evidence.after.capture?.ok &&
              mismatchBefore &&
              alignmentReady &&
              alignedAfter &&
              unavailableBefore &&
              !diagnosticError
                ? 'mismatch-caused-empty-to-nonempty-support'
                : 'initial-capture-failed-after-succeeded-inconclusive';
          }
          try {
            await testInfo.attach(
              'two-browser-panels-native-viewport-discriminator.json',
              {
                body: JSON.stringify(evidence, null, 2),
                contentType: 'application/json',
              },
            );
          } catch (error) {
            attachmentError = error;
          }
        }
        if (afterCaptureError) throw afterCaptureError;
        deferredViewportDiagnosticError = diagnosticError ?? attachmentError;
      }
      expect(captures.first).toMatch(/^data:image\/png;base64,/);
      expect(captures.second).toMatch(/^data:image\/png;base64,/);
      expect(captures.first).not.toBe(captures.second);
      if (deferredViewportDiagnosticError)
        throw deferredViewportDiagnosticError;

      // Explicit active targeting: selecting the first panel's tab makes its
      // group the active group (interaction-driven activation).
      await firstTab.click();
      const activeGroupId = await window.evaluate(() =>
        window.__canopyPanelTestApi.getActiveGroupId(),
      );
      expect(activeGroupId).toBe(firstArranged.groupId);

      await window.screenshot({
        path: testInfo.outputPath('browser-panels-side-by-side.png'),
      });

      // --- 7. Closing a panel destroys exactly its session -----------------
      await closePanelTab(window, second.panelId);
      await expect(secondTab).toHaveCount(0);
      await expect(
        window.getByTestId(`browser-pane-${second.browserId}`),
      ).toHaveCount(0);
      // The surviving panel keeps its page identity.
      await expect(firstTab).toContainText(PAGE_ONE_TITLE);
      await expect(
        window.getByTestId(`browser-pane-${first.browserId}`),
      ).toBeVisible();

      // Exact-ID permanent destruction: the closed session leaves the main
      // process session table; the surviving one stays.
      await expect
        .poll(
          () =>
            electronApp.evaluate(
              ({ webContents }, ids) => {
                const titles = webContents
                  .getAllWebContents()
                  .map((contents) => contents.getTitle());
                return {
                  survivorAlive: titles.includes(ids.survivorTitle),
                  closedAlive: titles.includes(ids.closedTitle),
                };
              },
              {
                survivorTitle: PAGE_ONE_TITLE,
                closedTitle: PAGE_TWO_TITLE,
              },
            ),
          { intervals: [250, 500, 1000], timeout: 20_000 },
        )
        .toEqual({ survivorAlive: true, closedAlive: false });

      // Close the final Browser panel too; no Browser WebContents survives.
      await closePanelTab(window, first.panelId);
      await expect(firstTab).toHaveCount(0);
      await expect
        .poll(
          () =>
            electronApp.evaluate(
              ({ webContents }, title) =>
                webContents
                  .getAllWebContents()
                  .some((contents) => contents.getTitle() === title),
              PAGE_ONE_TITLE,
            ),
          { intervals: [250, 500, 1000], timeout: 20_000 },
        )
        .toBe(false);
    } catch (error) {
      bodyError = error;
    }

    let evaluationError;
    if (!bodyError && nativeCloseQualification === 'target125') {
      await captureDaemonDryRunEvidence(electronApp);
      try {
        await electronApp.evaluate(({ app }) => app.exit(125));
      } catch (error) {
        evaluationError = error;
      }
    }

    const failures = bodyError ? [bodyError] : [];
    let targetClosedEvaluation = false;
    if (evaluationError) {
      try {
        targetClosedEvaluation = isPlaywrightTargetClosedError(evaluationError);
      } catch (error) {
        // Keep the direct evaluation failure primary, but retain a private
        // classifier drift as well and still run mandatory cleanup below.
        failures.push(evaluationError, error);
      }
      if (!targetClosedEvaluation && !failures.includes(evaluationError))
        failures.push(evaluationError);
    }
    let closeError;
    try {
      await closeCanopy(
        electronApp,
        userDataDir,
        nativeCloseQualification
          ? { boundaryRecord: screenshotBoundary.record }
          : undefined,
      );
    } catch (error) {
      closeError = error;
    }
    if (closeError && (bodyError || nativeCloseQualification !== 'target125'))
      failures.push(closeError);

    if (!bodyError && nativeCloseQualification === 'target125') {
      try {
        assertTarget125TerminalRejection(closeError);
      } catch (error) {
        failures.push(error);
      }
    }

    let terminalError;
    if (!bodyError && nativeCloseQualification) {
      try {
        assertElectronTerminalTuple(
          terminalResult,
          nativeCloseQualification === 'target125' ? 125 : 0,
        );
      } catch (error) {
        terminalError = error;
        failures.push(error);
      }
    }
    try {
      await pages.close();
    } catch (error) {
      failures.push(error);
    }
    if (!bodyError && nativeCloseQualification) {
      try {
        screenshotBoundary.record?.('native-close-handle-result', {
          mode: nativeCloseQualification,
          child: {
            pid: terminalResult?.pid,
            exit: terminalResult?.exit,
            close: terminalResult?.close,
            error: terminalResult?.error,
          },
        });
      } catch {
        // The selected fixture recorder is optional evidence, never a result
        // oracle or a substitute for terminal and cleanup assertions.
      }
    }
    if (evaluationError && targetClosedEvaluation) {
      // Only the installed Playwright target-closed instance can disappear,
      // and only after both the exact in-memory terminal tuple and mandatory
      // cleanup have succeeded. Retained streams are post-run evidence only.
      if (
        nativeCloseQualification !== 'target125' ||
        terminalError ||
        failures.length > 0
      ) {
        failures.push(evaluationError);
      }
    }
    throwRetainedFixtureFailures(failures);
  });

  // CAN-2305: "Open links in the built-in browser" — the Settings toggle,
  // the real routing seam, and the recoverable local-only conflict toast.
  test('app links route into a browser panel and local-only conflicts stay recoverable', async () => {
    test.setTimeout(210_000);
    const pages = await startLocalPages();
    const externalOpen = await startExternalOpenCapture();
    const launchOptions = {
      env: { CANOPY_E2E_EXTERNAL_OPEN_CAPTURE_URL: externalOpen.url },
    };
    let launched = await seedPanelWorktree(launchOptions);

    try {
      let { window } = launched;
      let app = new CanopyAppDriver(window);
      await app.openSettings();
      await app.openSettingsSection('browser');

      const appLinkToggle = window.getByTestId(
        'settings-browser-open-app-links-in-built-in-browser',
      );
      // On by default; turning it off and back on persists each choice.
      const persistedAppLinks = () =>
        window.evaluate(async () => {
          const preferences = await window.api.loadPreferences();
          return preferences.openAppLinksInBuiltInBrowser === true;
        });
      await expect(appLinkToggle).toHaveAttribute('aria-checked', 'true');
      await appLinkToggle.click();
      await expect(appLinkToggle).toHaveAttribute('aria-checked', 'false');
      // The toggle is a real persisted preference, not renderer-only state.
      await expect.poll(persistedAppLinks).toBe(false);
      await appLinkToggle.click();
      await expect(appLinkToggle).toHaveAttribute('aria-checked', 'true');
      await expect.poll(persistedAppLinks).toBe(true);
      await app.closeSettings();

      // A link activated from a pulled-out chat panel crosses the child
      // webContents hardening seam before it reaches the owning renderer.
      // It must retain the same app-link policy instead of falling back to
      // the host browser merely because the panel lives in an aux window.
      const auxWindowPromise = launched.electronApp.waitForEvent('window');
      await window
        .getByTestId(`panel-group-menu-${DEFAULT_GROUP_IDS.chat}`)
        .click();
      await window
        .getByTestId(`panel-group-pop-out-${DEFAULT_GROUP_IDS.chat}`)
        .click();
      const aux = await auxWindowPromise;
      const auxChatPanel = aux.locator(
        '[data-testid="panel-content-chat"]:visible',
      );
      await expect(auxChatPanel).toBeVisible();
      const auxLinkUrl = `http://127.0.0.1:${pages.port}/two`;
      await auxChatPanel.evaluate((panel, href) => {
        const anchor = document.createElement('a');
        anchor.href = href;
        anchor.target = '_blank';
        anchor.textContent = 'Open aux browser fixture';
        anchor.dataset.testid = 'browser-aux-app-link-fixture';
        panel.append(anchor);
      }, auxLinkUrl);
      await aux.getByTestId('browser-aux-app-link-fixture').click();
      await expect
        .poll(
          async () =>
            (await aux.locator('[data-testid^="browser-pane-"]').count()) +
            (await window.locator('[data-testid^="browser-pane-"]').count()),
          { timeout: 30_000 },
        )
        .toBeGreaterThan(0);
      // The tab is placed before its session exists; let it finish opening.
      await waitForBrowserTabsLoaded(aux);
      await waitForBrowserTabsLoaded(window);
      expect(externalOpen.opened).toEqual([]);
      if (!aux.isClosed()) {
        const auxClosePromise = aux.waitForEvent('close');
        await aux
          .getByTestId('panel-aux-window-merge-back')
          .click()
          .catch((error) => {
            if (!aux.isClosed()) throw error;
          });
        await auxClosePromise;
      }

      // With the toggle on, an ordinary app link lands in the selected
      // worktree's built-in browser instead of the system browser.
      await clickAppLink(window, `http://127.0.0.1:${pages.port}/one`);
      await expect(
        window.locator('[data-testid^="browser-pane-"]').first(),
      ).toBeVisible({ timeout: 30_000 });
      await waitForBrowserTabsLoaded(window);

      // The browser view is a Playwright page too. Let its `window` event
      // land first so the Advisor helper does not mistake it for the Advisor.
      await expect
        .poll(() =>
          launched.electronApp
            .windows()
            .some((page) => page.url().endsWith('/one')),
        )
        .toBe(true);

      // App Advisor is a separate renderer process and must mount the same
      // browser-event subscription. A link originating there stays in that
      // window's selected work entry instead of timing out to the OS fallback.
      const advisor = await app.openAppAdvisorWindow(launched.electronApp);
      // Expansion mounts navigation before the full grid finishes hydration.
      await expect(advisor.getByTestId('panel-grid-loading')).toHaveCount(0);
      await expect(advisor.getByTestId('panel-grid-root')).toBeVisible();
      await expect(
        advisor.locator('[data-testid="panel-content-chat"]:visible'),
      ).toBeVisible();
      await clickAppLink(advisor, `http://127.0.0.1:${pages.port}/two`);
      await expect(
        advisor.locator('[data-testid^="browser-pane-"]').first(),
      ).toBeVisible({ timeout: 30_000 });
      await waitForBrowserTabsLoaded(advisor);
      expect(externalOpen.opened).toEqual([]);

      // The preference survives a full app restart.
      const userDataDir = launched.userDataDir;
      await closeCanopy(launched.electronApp, userDataDir, {
        keepUserData: true,
      });
      launched = await seedPanelWorktree({ userDataDir, ...launchOptions });
      window = launched.window;
      app = new CanopyAppDriver(window);
      await app.openSettings();
      await app.openSettingsSection('browser');
      const persistedAppLinkToggle = window.getByTestId(
        'settings-browser-open-app-links-in-built-in-browser',
      );
      await expect(persistedAppLinkToggle).toHaveAttribute(
        'aria-checked',
        'true',
      );

      // Turning the preference off restores the existing system-browser path.
      await persistedAppLinkToggle.click();
      await expect(persistedAppLinkToggle).toHaveAttribute(
        'aria-checked',
        'false',
      );
      await app.closeSettings();
      const panesBeforeFallback = await window
        .locator('[data-testid^="browser-pane-"]')
        .count();
      const externalFallbackUrl = `http://127.0.0.1:${pages.port}/two`;
      await clickAppLink(window, externalFallbackUrl);
      await expect
        .poll(() => externalOpen.opened)
        .toEqual([externalFallbackUrl]);
      await expect(
        window.locator('[data-testid^="browser-pane-"]'),
      ).toHaveCount(panesBeforeFallback);

      // Turning "Only allow local sites" on is the conflict case: the link
      // cannot load in-app, so it must be explained rather than silently
      // doing nothing.
      await app.openSettings();
      await app.openSettingsSection('browser');
      const restoredAppLinkToggle = window.getByTestId(
        'settings-browser-open-app-links-in-built-in-browser',
      );
      await restoredAppLinkToggle.click();
      await expect(restoredAppLinkToggle).toHaveAttribute(
        'aria-checked',
        'true',
      );
      const localOnlyToggle = window.getByTestId(
        'settings-browser-local-servers-only',
      );
      await localOnlyToggle.click();
      await expect(localOnlyToggle).toHaveAttribute('aria-checked', 'true');
      await app.closeSettings();

      await clickAppLink(window, 'https://example.com/docs');
      await expect
        .poll(() => externalOpen.opened)
        .toEqual([externalFallbackUrl, 'https://example.com/docs']);

      const toastAction = window.getByTestId('toast-action');
      await expect(toastAction).toBeVisible({ timeout: 15_000 });
      await expect(toastAction).toHaveText('Allow all sites');
      await toastAction.click();

      // The inline action is the recovery: local-only is off afterwards.
      await expect
        .poll(() =>
          window.evaluate(async () => {
            const preferences = await window.api.loadPreferences();
            return preferences.inAppBrowserLocalServersOnly === true;
          }),
        )
        .toBe(false);
    } finally {
      await closeCanopy(launched.electronApp, launched.userDataDir);
      await pages.close();
      await externalOpen.close();
    }
  });

  // The default-browser setting is its own choice: turning it on must not
  // route in-app links, and in-app links stay external until their own
  // toggle is on. E2E builds never touch the real OS registration, so the
  // verified status reports that it only works in the installed app.
  test('default-browser setting is independent of in-app link routing', async () => {
    test.setTimeout(120_000);
    const pages = await startLocalPages();
    const externalOpen = await startExternalOpenCapture();
    const launched = await seedPanelWorktree({
      env: { CANOPY_E2E_EXTERNAL_OPEN_CAPTURE_URL: externalOpen.url },
    });

    try {
      const { window } = launched;
      const app = new CanopyAppDriver(window);
      await app.openSettings();
      await app.openSettingsSection('browser');

      const defaultToggle = window.getByTestId(
        'settings-browser-use-as-system-default',
      );
      const appLinkToggle = window.getByTestId(
        'settings-browser-open-app-links-in-built-in-browser',
      );
      await expect(defaultToggle).toHaveAttribute('aria-checked', 'false');
      // App links open in the built-in browser by default; turn that off so
      // the default-browser choice is tested on its own.
      await expect(appLinkToggle).toHaveAttribute('aria-checked', 'true');
      await appLinkToggle.click();
      await expect(appLinkToggle).toHaveAttribute('aria-checked', 'false');

      await defaultToggle.click();
      await expect(defaultToggle).toHaveAttribute('aria-checked', 'true');
      await expect(appLinkToggle).toHaveAttribute('aria-checked', 'false');
      await expect
        .poll(() =>
          window.evaluate(async () => {
            const preferences = await window.api.loadPreferences();
            return {
              useAsSystemDefaultBrowser:
                preferences.useAsSystemDefaultBrowser === true,
              openAppLinksInBuiltInBrowser:
                preferences.openAppLinksInBuiltInBrowser === true,
            };
          }),
        )
        .toEqual({
          useAsSystemDefaultBrowser: true,
          openAppLinksInBuiltInBrowser: false,
        });
      await expect(
        window.getByTestId('settings-browser-default-guidance'),
      ).toContainText('installed');
      await app.closeSettings();

      const panesBefore = await window
        .locator('[data-testid^="browser-pane-"]')
        .count();
      const linkUrl = `http://127.0.0.1:${pages.port}/one`;
      await clickAppLink(window, linkUrl);
      await expect.poll(() => externalOpen.opened).toEqual([linkUrl]);
      await expect(
        window.locator('[data-testid^="browser-pane-"]'),
      ).toHaveCount(panesBefore);
    } finally {
      await closeCanopy(launched.electronApp, launched.userDataDir);
      await pages.close();
      await externalOpen.close();
    }
  });
});

function boundedAdvisorCatalog(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return {
      unavailable: 'catalog projection unavailable',
      error: boundedFailureValue(String(value), 512),
      fileCount: 0,
      droppedFileCount: 0,
      identityCount: 0,
      droppedIdentityCount: 0,
      files: [],
    };
  const inputFiles = Array.isArray(value.files) ? value.files : [];
  const fileCount = inputFiles.length;
  const identityCount = inputFiles.reduce(
    (count, file) =>
      count + (Array.isArray(file?.identities) ? file.identities.length : 0),
    0,
  );
  const files = inputFiles.slice(0, 17).map((file) => {
    const identities = Array.isArray(file?.identities) ? file.identities : [];
    return {
      path: boundedFailureValue(file?.path, 1024),
      status: boundedFailureValue(file?.status, 64),
      code: boundedFailureValue(file?.code, 128),
      sizeBytes:
        typeof file?.sizeBytes === 'number' ? file.sizeBytes : undefined,
      sha256: boundedFailureValue(file?.sha256, 128),
      version: typeof file?.version === 'number' ? file.version : undefined,
      identities: identities
        .slice(0, 4)
        .map((identity) =>
          Object.fromEntries(
            [
              'id',
              'kind',
              'type',
              'workspaceId',
              'worktreeId',
              'branchName',
            ].flatMap((key) =>
              typeof identity?.[key] === 'string'
                ? [[key, boundedFailureValue(identity[key], 128)]]
                : [],
            ),
          ),
        ),
      droppedIdentityCount: Math.max(0, identities.length - 4),
      truncated: Boolean(file?.truncated) || identities.length > 4,
    };
  });
  const retainedIdentityCount = files.reduce(
    (count, file) => count + file.identities.length,
    0,
  );
  return {
    userDataDir: boundedFailureValue(value.userDataDir, 1024),
    indexPath: boundedFailureValue(value.indexPath, 1024),
    unavailable: boundedFailureValue(value.unavailable, 256),
    error: boundedFailureValue(value.error, 512),
    fileCount,
    droppedFileCount: Math.max(0, fileCount - files.length),
    identityCount,
    droppedIdentityCount: Math.max(0, identityCount - retainedIdentityCount),
    files,
  };
}

function boundedAdvisorEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return {
      unavailable: 'store-derived envelope projection unavailable',
      error: boundedFailureValue(String(value), 512),
    };
  const selected = value.snapshot?.selectedWorktree;
  return {
    version:
      typeof value.version === 'number'
        ? value.version
        : boundedFailureValue(value.version, 128),
    revision:
      typeof value.revision === 'number'
        ? value.revision
        : boundedFailureValue(value.revision, 128),
    digest: boundedFailureValue(value.digest, 512),
    unavailable: boundedFailureValue(value.unavailable, 256),
    error: boundedFailureValue(value.error, 512),
    snapshot: {
      activePage: boundedFailureValue(value.snapshot?.activePage, 256),
      selectedWorktree:
        typeof selected === 'string'
          ? boundedFailureValue(selected, 256)
          : selected && typeof selected === 'object'
            ? Object.fromEntries(
                ['projectId', 'worktreeId', 'branch', 'name'].flatMap((key) =>
                  typeof selected[key] === 'string'
                    ? [[key, boundedFailureValue(selected[key], 256)]]
                    : [],
                ),
              )
            : null,
    },
  };
}

function boundedAdvisorProjection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return {
      unavailable: 'renderer selection projection unavailable',
      error: boundedFailureValue(String(value), 512),
      rows: [],
      activeSidebar: [],
      droppedRowCount: 0,
      droppedActiveSidebarCount: 0,
    };
  const rows = Array.isArray(value.rows)
    ? value.rows.slice(0, 128).map((row) => ({
        projectId: boundedFailureValue(row?.projectId, 128),
        worktreeId: boundedFailureValue(row?.worktreeId, 128),
        branch: boundedFailureValue(row?.branch, 256),
        label: boundedFailureValue(row?.label, 512),
        visible: Boolean(row?.visible),
      }))
    : [];
  const activeSidebar = Array.isArray(value.activeSidebar)
    ? value.activeSidebar.slice(0, 32).map((entry) => ({
        testId: boundedFailureValue(entry?.testId, 256),
        text: boundedFailureValue(entry?.text, 512),
        visible: Boolean(entry?.visible),
      }))
    : [];
  return {
    unavailable: boundedFailureValue(value.unavailable, 256),
    error: boundedFailureValue(value.error, 512),
    expectedWorktreeId: boundedFailureValue(value.expectedWorktreeId, 128),
    rows,
    droppedRowCount:
      Math.max(0, Number(value.droppedRowCount) || 0) +
      Math.max(0, (value.rows?.length ?? 0) - rows.length),
    matchingRowCount: Number(value.matchingRowCount) || 0,
    matchingVisibleRowCount: Number(value.matchingVisibleRowCount) || 0,
    pageMain: {
      present: Boolean(value.pageMain?.present),
      visible: Boolean(value.pageMain?.visible),
    },
    activeSidebar,
    droppedActiveSidebarCount:
      Math.max(0, Number(value.droppedActiveSidebarCount) || 0) +
      Math.max(0, (value.activeSidebar?.length ?? 0) - activeSidebar.length),
    href: boundedFailureValue(value.href, 2048),
    visibilityState: boundedFailureValue(value.visibilityState, 64),
    focused: Boolean(value.focused),
  };
}

function finalizeAdvisorInitialSelectionMetadata(metadata) {
  const bounded = {
    prelaunchCatalog: boundedAdvisorCatalog(metadata.prelaunchCatalog),
    failureCatalog: boundedAdvisorCatalog(metadata.failureCatalog),
    renderer: {
      envelope: boundedAdvisorEnvelope(metadata.renderer?.envelope),
      projection: boundedAdvisorProjection(metadata.renderer?.projection),
    },
    primaryError: boundedFailureValue(metadata.primaryError, 2048),
    screenshot: {
      status: boundedFailureValue(metadata.screenshot?.status, 64),
      path: boundedFailureValue(metadata.screenshot?.path, 2048),
      unavailable: boundedFailureValue(metadata.screenshot?.unavailable, 256),
      error: boundedFailureValue(metadata.screenshot?.error, 512),
    },
  };
  const catalogs = [bounded.prelaunchCatalog, bounded.failureCatalog];
  const projection = bounded.renderer.projection;
  const serializedSize = () =>
    Buffer.byteLength(JSON.stringify(bounded, null, 2));
  const markTruncated = () => {
    bounded.truncated = true;
  };
  while (
    serializedSize() > ADVISOR_INITIAL_SELECTION_METADATA_LIMIT &&
    projection.rows.length
  ) {
    projection.rows.pop();
    projection.droppedRowCount++;
    markTruncated();
  }
  while (
    serializedSize() > ADVISOR_INITIAL_SELECTION_METADATA_LIMIT &&
    projection.activeSidebar.length
  ) {
    projection.activeSidebar.pop();
    projection.droppedActiveSidebarCount++;
    markTruncated();
  }
  for (const catalog of catalogs)
    for (const file of [...catalog.files].reverse())
      while (
        serializedSize() > ADVISOR_INITIAL_SELECTION_METADATA_LIMIT &&
        file.identities.length
      ) {
        file.identities.pop();
        file.droppedIdentityCount++;
        catalog.droppedIdentityCount++;
        file.truncated = true;
        markTruncated();
      }
  for (const catalog of catalogs)
    while (
      serializedSize() > ADVISOR_INITIAL_SELECTION_METADATA_LIMIT &&
      catalog.files.length
    ) {
      const [file] = catalog.files.splice(-1, 1);
      catalog.droppedFileCount++;
      catalog.droppedIdentityCount += file.identities.length;
      markTruncated();
    }
  if (
    catalogs.some(
      (catalog) =>
        catalog.droppedFileCount > 0 || catalog.droppedIdentityCount > 0,
    ) ||
    projection.droppedRowCount > 0 ||
    projection.droppedActiveSidebarCount > 0
  )
    markTruncated();
  if (serializedSize() > ADVISOR_INITIAL_SELECTION_METADATA_LIMIT) {
    const fallback = {
      truncated: true,
      unavailable: `metadata exceeded ${ADVISOR_INITIAL_SELECTION_METADATA_LIMIT} bytes`,
      primaryError: boundedFailureValue(metadata.primaryError, 1024),
      prelaunchCatalog: {
        fileCount: bounded.prelaunchCatalog.fileCount,
        droppedFileCount: bounded.prelaunchCatalog.fileCount,
        identityCount: bounded.prelaunchCatalog.identityCount,
        droppedIdentityCount: bounded.prelaunchCatalog.identityCount,
      },
      failureCatalog: {
        fileCount: bounded.failureCatalog.fileCount,
        droppedFileCount: bounded.failureCatalog.fileCount,
        identityCount: bounded.failureCatalog.identityCount,
        droppedIdentityCount: bounded.failureCatalog.identityCount,
      },
      renderer: {
        droppedRowCount: projection.droppedRowCount + projection.rows.length,
        droppedActiveSidebarCount:
          projection.droppedActiveSidebarCount +
          projection.activeSidebar.length,
      },
      screenshot: bounded.screenshot,
    };
    return {
      metadata: fallback,
      serialized: Buffer.from(JSON.stringify(fallback, null, 2)),
    };
  }
  return {
    metadata: bounded,
    serialized: Buffer.from(JSON.stringify(bounded, null, 2)),
  };
}

async function captureAdvisorInitialSelectionFailure({
  context,
  prelaunchCatalog,
  base,
  record,
  testInfo,
}) {
  const [failureCatalog, envelope, renderer, screenshot] = await Promise.all([
    settleFailureEvidence(
      Promise.resolve().then(() =>
        captureFixtureCatalog(context.userDataDir, ['demo-ts-pnpm-vite']),
      ),
      550,
      'failure catalog unavailable',
    ),
    settleFailureEvidence(
      context.window.evaluate(async () => {
        const value = await window.api.appAdvisor.getState();
        return {
          version: value?.version,
          revision: value?.revision,
          digest: value?.digest,
          snapshot: {
            activePage: value?.snapshot?.activePage ?? null,
            selectedWorktree: value?.snapshot?.selectedWorktree ?? null,
          },
        };
      }),
      550,
      'store-derived envelope unavailable',
    ),
    settleFailureEvidence(
      context.window.evaluate(
        collectAdvisorInitialSelectionSnapshot,
        context.branch,
      ),
      550,
      'renderer selection state unavailable',
    ),
    settleFailureEvidence(
      context.window.locator('body').screenshot({
        animations: 'disabled',
        timeout: 650,
      }),
      700,
      'screenshot unavailable',
    ),
  ]);

  let screenshotEvidence = screenshot;
  if (Buffer.isBuffer(screenshot)) {
    const screenshotPath =
      base && `${base}-advisor-initial-selection-failure.png`;
    if (screenshotPath) {
      try {
        writeFileSync(screenshotPath, screenshot);
        screenshotEvidence = { status: 'retained', path: screenshotPath };
      } catch (error) {
        screenshotEvidence = {
          unavailable: 'screenshot write failed',
          error: boundedFailureValue(
            error instanceof Error ? error.message : String(error),
          ),
        };
      }
    } else {
      screenshotEvidence = { status: 'attached', path: null };
    }
    await settleFailureEvidence(
      testInfo.attach('advisor-initial-selection-failure.png', {
        body: screenshot,
        contentType: 'image/png',
      }),
      400,
      'screenshot attachment unavailable',
    );
  }

  const rawMetadata = {
    prelaunchCatalog,
    failureCatalog,
    renderer: { envelope, projection: renderer },
    primaryError: boundedFailureValue(
      String(context.error?.message ?? context.error),
      2048,
    ),
    screenshot: screenshotEvidence,
  };
  const { metadata: boundedMetadata, serialized } =
    finalizeAdvisorInitialSelectionMetadata(rawMetadata);
  try {
    record?.('advisor-initial-selection-failure', boundedMetadata);
  } catch {
    /* Observation must not replace the selection failure. */
  }
  await settleFailureEvidence(
    testInfo.attach('advisor-initial-selection-failure.json', {
      body: serialized,
      contentType: 'application/json',
    }),
    400,
    'metadata attachment unavailable',
  );
}

function collectAdvisorInitialSelectionSnapshot(expectedWorktreeId) {
  const bounded = (value, limit) =>
    typeof value === 'string' ? value.slice(0, limit) : null;
  const visible = (element) => {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      rect.width > 0 &&
      rect.height > 0
    );
  };
  const rowNodes = Array.from(
    document.querySelectorAll('[data-testid="worktree-row"]'),
  );
  const rows = rowNodes.slice(0, 128).map((row) => ({
    projectId: bounded(row.getAttribute('data-project-id'), 128),
    worktreeId: bounded(row.getAttribute('data-worktree-id'), 128),
    branch: bounded(row.getAttribute('data-branch'), 256),
    label: bounded(row.textContent?.trim() ?? '', 512),
    visible: visible(row),
  }));
  const matching = rows.filter((row) => row.worktreeId === expectedWorktreeId);
  const pageMain = document.querySelector('[data-testid="page-main"]');
  const activeSidebarNodes = Array.from(
    document.querySelectorAll(
      '[data-active="true"], [aria-current="page"], [aria-selected="true"]',
    ),
  );
  return {
    expectedWorktreeId,
    rows,
    droppedRowCount: Math.max(0, rowNodes.length - rows.length),
    matchingRowCount: matching.length,
    matchingVisibleRowCount: matching.filter((row) => row.visible).length,
    pageMain: {
      present: Boolean(pageMain),
      visible: pageMain ? visible(pageMain) : false,
    },
    activeSidebar: activeSidebarNodes.slice(0, 32).map((node) => ({
      testId: bounded(node.getAttribute('data-testid'), 256),
      text: bounded(node.textContent?.trim() ?? '', 512),
      visible: visible(node),
    })),
    droppedActiveSidebarCount: Math.max(0, activeSidebarNodes.length - 32),
    href: bounded(window.location.href, 2048),
    visibilityState: document.visibilityState,
    focused: document.hasFocus(),
  };
}

function projectOwnerRetirementCatalog(lastCatalog, owner) {
  const matchingRetirements = Object.values(
    lastCatalog?.retirements ?? {},
  ).filter(
    (entry) =>
      entry?.scope?.projectId === owner.projectId &&
      entry?.scope?.worktreeId === owner.worktreeId,
  );
  return {
    available: lastCatalog !== null,
    revision: lastCatalog?.revision ?? null,
    matchingRetirements: matchingRetirements.slice(0, 16),
    matchingRetirementsDroppedCount: Math.max(
      0,
      matchingRetirements.length - 16,
    ),
  };
}

async function captureCoworkPrecleanupRetirementFailure({
  testInfo,
  fixture,
  catalogPath,
  lastCatalog,
}) {
  let refreshedCatalog;
  let refreshFailure;
  try {
    refreshedCatalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  } catch (error) {
    refreshFailure = error;
  }
  const lastPreCleanupCatalogObservation = refreshFailure
    ? {
        refresh: 'unavailable',
        unavailable: 'catalog refresh unavailable',
        error: boundedFailureValue(
          refreshFailure instanceof Error
            ? refreshFailure.message
            : String(refreshFailure),
        ),
        ...projectOwnerRetirementCatalog(null, fixture.owner),
      }
    : {
        refresh: 'fulfilled',
        ...projectOwnerRetirementCatalog(refreshedCatalog, fixture.owner),
      };
  const metadata = {
    stage: 'cowork-precommit-abort-failure-before-cleanup',
    lastPreCleanupCatalogObservation,
    lastPollCatalogObservation: {
      source: 'last successful poll observation',
      ...projectOwnerRetirementCatalog(lastCatalog, fixture.owner),
    },
    interpretation:
      'This is the last pre-cleanup catalog observation. Fixture shutdown may still settle the operation; it does not establish abort, archive capture, main-process catch entry, or IPC outcome.',
    archiveOperationObservation: {
      invocation: 'unobserved',
      result: 'unobserved',
      limitation:
        'The public renderer/Electron surfaces used by this flow do not expose a per-invocation archive request or result.',
    },
  };
  await settleFailureEvidence(
    testInfo.attach('cowork-precommit-abort-failure-before-cleanup.json', {
      body: serializeArchiveFailureMetadata(metadata),
      contentType: 'application/json',
    }),
    400,
    'metadata attachment unavailable',
  );
}

// W1 uses the existing real HTTP auth fixture, native persistent Sessions and
// ordinary owner/browser chrome. No profile binding is fabricated on first use.
async function seedLegacyReviewOwner(ownerKind, boundary, testInfo) {
  const { launchCanopy } = await import('./launchCanopy.mjs');
  const { seedBrowserProfileEntryOwners } =
    await import('./seeders/browser-profile-state.mjs');
  const { mkdirSync } = await import('node:fs');
  const panelSeedBoundary = createSelectedLaunchBoundary(
    `w1-legacy-review-${ownerKind}`,
    'panel-seed',
    {
      close: closeCanopy,
      owners: [{ projectId: 'demo-ts-pnpm-vite', worktreeId: 'demo-main' }],
      firstProjectsLoad: ownerKind === 'advisor',
    },
  );
  if (
    ['worktree', 'cowork', 'advisor'].includes(ownerKind) &&
    testInfo &&
    process.env.CANOPY_WINDOWS_BOUNDARY_DIAGNOSTICS_DIR?.trim()
  ) {
    let prelaunchCatalog;
    const observeFirstProjectsLoadPrelaunch =
      panelSeedBoundary.options.onBeforeLaunch;
    panelSeedBoundary.options.onBeforeLaunch = (context) => {
      observeFirstProjectsLoadPrelaunch?.(context);
      const { userDataDir, workspaceIds } = context;
      prelaunchCatalog = captureFixtureCatalog(userDataDir, workspaceIds);
    };
    panelSeedBoundary.options.onSelectWorktreeFailure = (context) =>
      captureAdvisorInitialSelectionFailure({
        context,
        prelaunchCatalog,
        base: panelSeedBoundary.base,
        record: panelSeedBoundary.record,
        testInfo,
      });
  }
  let launched = await seedPanelWorktree(panelSeedBoundary.options);
  const userDataDir = launched.userDataDir;
  await panelSeedBoundary.close(launched, { keepUserData: true });
  if (ownerKind === 'worktree') {
    const workspaceConfigPath = path.join(
      userDataDir,
      'workspaces',
      'demo-ts-pnpm-vite',
      'workspace.json',
    );
    const workspaceConfig = JSON.parse(
      readFileSync(workspaceConfigPath, 'utf8'),
    );
    workspaceConfig.scripts.teardown = 'node -e "process.exit(0)"';
    writeFileSync(
      workspaceConfigPath,
      `${JSON.stringify(workspaceConfig, null, 2)}\n`,
    );
  }
  const entryOwners = await seedBrowserProfileEntryOwners(userDataDir);
  // Sidebar rows are shown only for entries with a real message. The shared
  // data-layer seeder intentionally omits chats, so add UI fixture content.
  for (const entry of entryOwners) {
    const directory = path.join(
      userDataDir,
      entry.projectId === 'app-advisor' ? 'app-workspaces' : 'workspaces',
      entry.projectId,
    );
    mkdirSync(path.join(directory, 'chats'), { recursive: true });
    writeFileSync(
      path.join(directory, 'chats', `${entry.worktreeId}.json`),
      JSON.stringify({
        version: 1,
        activeTabId: 'legacy-review-chat',
        tabs: [
          {
            id: 'legacy-review-chat',
            title: 'Legacy browser review',
            description: 'Legacy browser review',
            createdAt: '2026-09-01T00:00:00.000Z',
            messages: [
              {
                id: 'legacy-review-message',
                role: 'user',
                blocks: [
                  { type: 'text', text: 'Retain my existing browser account.' },
                ],
                timestamp: 1788220800000,
              },
            ],
          },
        ],
      }),
    );
    const dataDirectory = path.join(
      directory,
      'worktree-data',
      entry.worktreeId,
    );
    mkdirSync(dataDirectory, { recursive: true });
    writeFileSync(
      path.join(dataDirectory, 'panel-layout-mode.json'),
      JSON.stringify({ version: 1, mode: 'advanced' }),
    );
  }
  const owner =
    ownerKind === 'worktree'
      ? { projectId: 'demo-ts-pnpm-vite', worktreeId: 'demo-main' }
      : entryOwners[ownerKind === 'cowork' ? 0 : 1];
  const pages = await startLocalPages();
  const url = `http://127.0.0.1:${pages.port}/auth/set`;
  const checkUrl = `http://127.0.0.1:${pages.port}/auth/check`;
  const partition = `persist:canopy-browser-${owner.projectId}-${owner.worktreeId}`;
  let route;
  try {
    let authSeedLaunchOptions = {};
    let authSeedBoundary;
    const authSeedDiagnosticsDirectory =
      process.env.CANOPY_WINDOWS_BOUNDARY_DIAGNOSTICS_DIR?.trim();
    if (authSeedDiagnosticsDirectory) {
      try {
        mkdirSync(authSeedDiagnosticsDirectory, { recursive: true });
        authSeedBoundary = createSelectedLaunchBoundary(
          `w1-legacy-review-${ownerKind}`,
          'auth-seed',
          { close: closeCanopy, owners: [owner] },
        );
        authSeedLaunchOptions = authSeedBoundary.options;
      } catch {
        /* Optional fixture observation. */
      }
    }
    launched = {
      ...(await launchCanopy({ userDataDir, ...authSeedLaunchOptions })),
      userDataDir,
    };
    const window = await getMainWindow(launched.electronApp);
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    const named = await window.evaluate(() =>
      window.api.browser.profiles.create({
        operationId: crypto.randomUUID(),
        input: { displayName: 'Unrelated legacy review account' },
      }),
    );
    const paths = await launched.electronApp.evaluate(
      async ({ BrowserWindow }, request) => {
        const paths = [];
        for (const partition of [request.partition, request.namedPartition]) {
          const fixture = new BrowserWindow({
            show: false,
            webPreferences: { partition },
          });
          try {
            await fixture.loadURL(request.url);
            const text = await fixture.webContents.executeJavaScript(
              "document.querySelector('#auth-state').textContent",
            );
            if (!text.includes('durable-local-value'))
              throw new Error('Native legacy auth seeding failed');
            await fixture.webContents.session.cookies.flushStore();
            fixture.webContents.session.flushStorageData();
            paths.push(fixture.webContents.session.storagePath);
          } finally {
            fixture.destroy();
          }
        }
        return paths;
      },
      {
        partition,
        namedPartition: `persist:canopy-browser-profile-${named.profileId}-g${named.storageGeneration}`,
        url,
      },
    );
    if (authSeedBoundary)
      await authSeedBoundary.close(launched, { keepUserData: true });
    else
      await closeCanopy(launched.electronApp, userDataDir, {
        keepUserData: true,
      });
    const stateDirectory = path.join(
      userDataDir,
      ownerKind === 'advisor' ? 'app-workspaces' : 'workspaces',
      owner.projectId,
      'worktree-data',
      owner.worktreeId,
    );
    mkdirSync(stateDirectory, { recursive: true });
    writeFileSync(
      path.join(stateDirectory, 'browser-state.json'),
      JSON.stringify({
        version: 1,
        browsers: [
          {
            id: 'legacy-review-saved',
            ...owner,
            url: checkUrl,
            title: 'Saved legacy account',
            status: 'ready',
            createdAt: 1,
            updatedAt: 1,
            canGoBack: false,
            canGoForward: false,
            loading: false,
            themeMode: 'light',
            pickMode: false,
            recording: false,
          },
        ],
        groups: [
          {
            id: 'legacy-review-group',
            browserIds: ['legacy-review-saved'],
            focusedBrowserId: 'legacy-review-saved',
          },
        ],
        activeGroupId: 'legacy-review-group',
      }),
    );
    launched = {
      ...(await launchCanopy({
        userDataDir,
        ...(boundary
          ? {
              env: {
                CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS: JSON.stringify({
                  file: boundary.mainFile,
                  mode: 'close',
                }),
              },
            }
          : {}),
      })),
      userDataDir,
    };
    launched.window = await getMainWindow(launched.electronApp);
    launched.app = new CanopyAppDriver(launched.window);
    await launched.app.waitForShell();
    route = await launched.electronApp.evaluate(
      (_electron, owner) =>
        globalThis.__CANOPY_E2E_BROWSER_MCP_ROUTE__({ kind: 'create', owner }),
      ownerKind,
    );
    // Session creation is observed only around discovery, after startup and
    // route setup. No native Session is acquired to inspect an empty Task slot.
    await launched.electronApp.evaluate(({ app }) => {
      const fixture = { count: 0, stop: undefined };
      const listener = () => {
        fixture.count++;
      };
      app.on('session-created', listener);
      fixture.stop = () => app.removeListener('session-created', listener);
      globalThis.__LEGACY_REVIEW_DISCOVERY__ = fixture;
    });
    const call = async (action) => {
      const response = await fetch(route.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${route.authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'legacy-review',
          method: 'tools/call',
          params: { name: 'DispatchAction', arguments: { action } },
        }),
        signal: AbortSignal.timeout(15_000),
      });
      expect(response.status).toBe(200);
      const envelope = await response.json();
      expect(envelope.error).toBeUndefined();
      const text = envelope.result?.content?.find(
        (item) => item.type === 'text',
      )?.text;
      if (typeof text !== 'string' || !text.startsWith('{'))
        throw new Error(`Legacy discovery MCP rejected: ${text}`);
      const result = JSON.parse(text);
      expect(result.ok).toBe(true);
      return result;
    };
    await call({ type: 'browser.profile.list' });
    await call({ type: 'browser.profile.get', profileId: named.profileId });
    expect(
      await launched.electronApp.evaluate(() => {
        const fixture = globalThis.__LEGACY_REVIEW_DISCOVERY__;
        fixture.stop();
        return fixture.count;
      }),
    ).toBe(0);
    const close = async ({ appAlreadyClosed = false } = {}) => {
      await observeBoundary(
        'route-removal',
        () =>
          launched.electronApp.evaluate(async (_electron, sessionKey) => {
            const record =
              globalThis.__CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS__;
            globalThis.__LEGACY_REVIEW_DISCOVERY__?.stop();
            try {
              record?.('route-removal-entered');
              await globalThis.__CANOPY_E2E_BROWSER_MCP_ROUTE__({
                kind: 'delete',
                sessionKey,
              });
              record?.('route-removal-fulfilled');
            } catch (error) {
              record?.('route-removal-rejected');
              throw error;
            } finally {
              record?.('close-entry');
            }
          }, route.sessionKey),
        boundary?.record,
      ).catch(() => {});
      if (!appAlreadyClosed)
        await closeCanopy(launched.electronApp, userDataDir, {
          boundaryRecord: boundary?.record,
        });
      await pages.close();
    };
    return {
      ...launched,
      owner,
      ownerKind,
      partition,
      checkUrl,
      nativePath: paths[0],
      unrelatedPath: paths[1],
      named,
      close,
    };
  } catch (error) {
    await closeCanopy(launched.electronApp, userDataDir).catch(() => {});
    await pages.close();
    throw error;
  }
}

async function selectLegacyReviewOwner(fixture) {
  const { app, owner, ownerKind, electronApp } = fixture;
  if (ownerKind === 'advisor') {
    const advisor =
      fixture.advisorSurface ?? (await app.openAppAdvisorWindow(electronApp));
    fixture.advisorSurface = advisor;
    await advisor
      .getByTestId(`app-advisor-nav-entry-${owner.worktreeId}`)
      .click();
    return advisor;
  }
  await app.openMainPage();
  if (ownerKind === 'worktree') await app.selectWorktree(owner.worktreeId);
  else {
    const toggle = fixture.window.getByTestId(
      `sidebar-cowork-project-${owner.projectId}-toggle`,
    );
    if ((await toggle.getAttribute('aria-expanded')) !== 'true')
      await toggle.click();
    const row = fixture.window.getByTestId(
      `sidebar-work-entry-${owner.worktreeId}`,
    );
    await row.click();
    await expect(row).toHaveAttribute('data-sidebar-selected-item', '');
  }
  return fixture.window;
}

async function addLegacyReviewBrowser(surface, ownerKind) {
  await expect(surface.getByTestId('panel-grid-root')).toBeVisible();
  const groupId = ownerKind === 'worktree' ? 'group-terminal' : 'group-chat';
  // A quiet worktree restores its saved Browser group, so the seeded saved
  // browser can show beside the one this adds; the added pane is the other.
  await surface.getByTestId(`panel-add-tab-${groupId}`).click();
  await surface.getByTestId('panel-add-menu-item-browser').click();
  const pane = surface.locator(
    '[data-testid="browser-panel-surface"][data-browser-id]:not([data-browser-id="legacy-review-saved"]):visible',
  );
  await expect(pane).toHaveCount(1);
  const browserId = await pane.getAttribute('data-browser-id');
  await waitForBlankBrowserSession(surface, browserId);
  return { browserId };
}

for (const ownerKind of ['worktree', 'cowork', 'advisor']) {
  test(`W1 scoped discovery preserves legacy cookie and localStorage for ${ownerKind}`, async () => {
    test.setTimeout(180_000);
    const fixture = await seedLegacyReviewOwner(ownerKind);
    try {
      const surface = await selectLegacyReviewOwner(fixture);
      const browser = await addLegacyReviewBrowser(surface, ownerKind);
      await navigatePane(surface, browser.browserId, fixture.checkUrl);
      await expect
        .poll(async () => {
          const result = await surface.evaluate(
            (browserId) =>
              window.api.browser.inspect({ browserId, locator: '#auth-state' }),
            browser.browserId,
          );
          return result.text ?? '';
        })
        .toContain('canopy-browser-auth=release-128');
      expect(
        (
          await surface.evaluate(
            (browserId) =>
              window.api.browser.inspect({ browserId, locator: '#auth-state' }),
            browser.browserId,
          )
        ).text,
      ).toContain('local=durable-local-value');
      const nativePath = await fixture.electronApp.evaluate(
        ({ webContents }, url) =>
          webContents
            .getAllWebContents()
            .find((contents) => contents.getURL() === url)?.session.storagePath,
        fixture.checkUrl,
      );
      expect(nativePath).toBe(fixture.nativePath);
    } finally {
      await fixture.close();
    }
  });

  test(`W1 discovery then unallocated ${ownerKind} retirement purges only the proven legacy store`, async ({}, testInfo) => {
    test.setTimeout(180_000);
    const fixture = await seedLegacyReviewOwner(ownerKind);
    const { existsSync } = await import('node:fs');
    const { launchCanopy } = await import('./launchCanopy.mjs');
    let restarted;
    let originalClosed = false;
    let lastCatalog = null;
    let flowFailed = false;
    const catalogPath = path.join(
      fixture.userDataDir,
      'browser-profiles',
      'catalog.json',
    );
    try {
      const surface = await selectLegacyReviewOwner(fixture);
      if (ownerKind === 'worktree') {
        const row = surface.locator(
          `[data-testid="worktree-row"][data-worktree-id="${fixture.owner.worktreeId}"]`,
        );
        await row.hover();
        await surface.getByTestId('worktree-actions-menu-button').click();
        await surface.getByTestId('worktree-actions-menu-archive').click();
        const dialog = surface.getByRole('dialog', {
          name: /^Archive worktree/,
        });
        await dialog.getByTestId('worktree-removal-preserve-branch').click();
        await expect(row).toHaveCount(0, { timeout: 60_000 });
        // The sidebar removes this row optimistically before archive IPC.
        // Restart only after the real owner removal and retirement commit;
        // closing on row disappearance instead interrupts an in-flight archive.
        await expect
          .poll(() => {
            lastCatalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
            const retirement = Object.values(lastCatalog.retirements).find(
              (entry) =>
                entry.scope.kind === 'worktree' &&
                entry.scope.projectId === fixture.owner.projectId &&
                entry.scope.worktreeId === fixture.owner.worktreeId,
            );
            const registry = JSON.parse(
              readFileSync(
                path.join(
                  fixture.userDataDir,
                  'workspaces',
                  fixture.owner.projectId,
                  'worktrees.json',
                ),
                'utf8',
              ),
            );
            return {
              state: retirement?.state,
              ownerExists: registry.worktrees.some(
                (entry) => entry.id === fixture.owner.worktreeId,
              ),
            };
          })
          .toEqual({ state: 'committed', ownerExists: false });
      } else {
        const prefix =
          ownerKind === 'advisor'
            ? 'app-advisor-nav-entry'
            : 'sidebar-work-entry';
        const id = `${prefix}-${fixture.owner.worktreeId}`;
        const row = surface.getByTestId(id);
        await row.hover();
        await surface.getByTestId(`${id}-menu`).click();
        await surface.getByTestId(`${id}-delete`).click();
        await surface
          .getByTestId(`${id}-delete-dialog`)
          .getByTestId(`${id}-confirm-delete`)
          .click();
        await expect(row).toHaveCount(0, { timeout: 30_000 });
      }
      await testInfo.attach('retirement-before-restart', {
        body: readFileSync(catalogPath),
        contentType: 'application/json',
      });
      await closeCanopy(fixture.electronApp, fixture.userDataDir, {
        keepUserData: true,
      });
      originalClosed = true;
      restarted = await launchCanopy({ userDataDir: fixture.userDataDir });
      const window = await getMainWindow(restarted.electronApp);
      await new CanopyAppDriver(window).waitForShell();
      await expect.poll(() => existsSync(fixture.nativePath)).toBe(false);
      expect(existsSync(fixture.unrelatedPath)).toBe(true);
      expect(
        await window.evaluate(
          (id) => window.api.browser.profiles.get({ profileId: id }),
          fixture.named.profileId,
        ),
      ).toMatchObject({ lifecycle: 'active' });
    } catch (error) {
      flowFailed = true;
      if (ownerKind === 'worktree') {
        try {
          lastCatalog ??= JSON.parse(readFileSync(catalogPath, 'utf8'));
          await captureWorktreeArchiveFailure({
            testInfo,
            fixture,
            surface: fixture.window,
            stage: 'worktree-retirement-failure-before-cleanup',
            lastCatalog,
          });
        } catch {
          // Failure evidence must never replace the original flow error.
        }
      }
      throw error;
    } finally {
      if (ownerKind === 'worktree' && flowFailed) {
        try {
          const catalogBody = readFileSync(catalogPath);
          if (catalogBody.byteLength <= ARCHIVE_FAILURE_METADATA_LIMIT) {
            await settleFailureEvidence(
              testInfo.attach(
                restarted
                  ? 'retirement-after-restart'
                  : 'retirement-before-restart-failure',
                {
                  body: catalogBody,
                  contentType: 'application/json',
                },
              ),
              400,
              'final catalog attachment unavailable',
            );
          }
        } catch {
          // Failure evidence must never replace the original flow error.
        }
      } else {
        await testInfo.attach('retirement-after-restart', {
          body: readFileSync(catalogPath),
          contentType: 'application/json',
        });
      }
      if (restarted)
        await closeCanopy(restarted.electronApp, fixture.userDataDir);
      await fixture.close({ appAlreadyClosed: originalClosed });
    }
  });
}

for (const ownerKind of ['worktree', 'cowork', 'advisor']) {
  test(`W1 precommit ${ownerKind} retirement abort retains legacy login for first browser open`, async ({}, testInfo) => {
    if (ownerKind === 'cowork') {
      try {
        const directory =
          process.env.CANOPY_WINDOWS_BOUNDARY_DIAGNOSTICS_DIR?.trim();
        if (directory) {
          mkdirSync(directory, { recursive: true });
          createBoundaryRecorder(
            path.resolve(
              directory,
              `w1-legacy-review-cowork-worker-${process.pid}-${randomUUID()}-fixture.jsonl`,
            ),
          )?.('worker-invocation', {
            caseId: 'w1-legacy-review-cowork',
            fixturePid: process.pid,
            wallTime: new Date().toISOString(),
          });
        }
      } catch {
        /* Optional worker invocation observation. */
      }
    }
    test.setTimeout(180_000);
    let boundary;
    const directory =
      process.env.CANOPY_WINDOWS_BOUNDARY_DIAGNOSTICS_DIR?.trim();
    if (ownerKind === 'worktree' && directory) {
      try {
        mkdirSync(directory, { recursive: true });
        const base = path.resolve(
          directory,
          `w1-precommit-close-${process.pid}-${randomUUID()}`,
        );
        boundary = {
          mainFile: `${base}-main.jsonl`,
          record: createBoundaryRecorder(`${base}-fixture.jsonl`),
        };
      } catch {
        /* Optional fixture observation. */
      }
    }
    const fixture = await seedLegacyReviewOwner(ownerKind, boundary, testInfo);
    const { rmSync } = await import('node:fs');
    const archiveRoot = path.join(
      fixture.userDataDir,
      ownerKind === 'advisor' ? 'app-workspaces' : 'workspaces',
      fixture.owner.projectId,
      'archived-containers',
    );
    const conflictPath = path.join(archiveRoot, fixture.owner.worktreeId);
    const catalogPath = path.join(
      fixture.userDataDir,
      'browser-profiles',
      'catalog.json',
    );
    let lastCatalog = null;
    let coworkRetirementConfirmed = false;
    try {
      const surface = await selectLegacyReviewOwner(fixture);
      // Fail real archive capture after browser retirement prepare and before
      // owner removal. Worktree rollback must still read its absent Git receipt,
      // so keep its parent directory valid and corrupt only container.json.
      mkdirSync(archiveRoot, { recursive: true });
      if (ownerKind === 'worktree') mkdirSync(conflictPath);
      writeFileSync(
        ownerKind === 'worktree'
          ? path.join(conflictPath, 'container.json')
          : conflictPath,
        'Intentional fixture archive destination conflict',
      );
      if (ownerKind === 'worktree') {
        const row = surface.locator(
          `[data-testid="worktree-row"][data-worktree-id="${fixture.owner.worktreeId}"]`,
        );
        await row.hover();
        await surface.getByTestId('worktree-actions-menu-button').click();
        await surface.getByTestId('worktree-actions-menu-archive').click();
        const dialog = surface.getByRole('dialog', {
          name: /^Archive worktree/,
        });
        await dialog.getByTestId('worktree-removal-preserve-branch').click();
      } else {
        const prefix =
          ownerKind === 'advisor'
            ? 'app-advisor-nav-entry'
            : 'sidebar-work-entry';
        const id = `${prefix}-${fixture.owner.worktreeId}`;
        const row = surface.getByTestId(id);
        await row.hover();
        await surface.getByTestId(`${id}-menu`).click();
        await surface.getByTestId(`${id}-delete`).click();
        await surface
          .getByTestId(`${id}-delete-dialog`)
          .getByTestId(`${id}-confirm-delete`)
          .click();
        if (ownerKind === 'cowork') coworkRetirementConfirmed = true;
      }
      await expect
        .poll(() => {
          lastCatalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
          return Object.values(lastCatalog.retirements).map(
            (entry) => entry.state,
          );
        })
        .toContain('aborted');
      rmSync(conflictPath, { recursive: true });
      // Error dialogs may remain after a failed worktree archive; escape them
      // through the ordinary UI before selecting the still-live owner.
      await surface.keyboard.press('Escape');
      const reopened = await selectLegacyReviewOwner(fixture);
      const browser = await addLegacyReviewBrowser(reopened, ownerKind);
      await navigatePane(reopened, browser.browserId, fixture.checkUrl);
      await expect
        .poll(
          async () =>
            (
              await reopened.evaluate(
                (browserId) =>
                  window.api.browser.inspect({
                    browserId,
                    locator: '#auth-state',
                  }),
                browser.browserId,
              )
            ).text ?? '',
        )
        .toContain('canopy-browser-auth=release-128');
      expect(
        (
          await reopened.evaluate(
            (browserId) =>
              window.api.browser.inspect({ browserId, locator: '#auth-state' }),
            browser.browserId,
          )
        ).text,
      ).toContain('local=durable-local-value');
    } catch (error) {
      if (ownerKind === 'worktree') {
        await captureWorktreeArchiveFailure({
          testInfo,
          fixture,
          surface: fixture.window,
          stage: 'worktree-precommit-abort-failure-before-cleanup',
          lastCatalog,
        }).catch(() => {});
      } else if (ownerKind === 'cowork' && coworkRetirementConfirmed) {
        await captureCoworkPrecleanupRetirementFailure({
          testInfo,
          fixture,
          catalogPath,
          lastCatalog,
        }).catch(() => {});
      }
      throw error;
    } finally {
      rmSync(conflictPath, { recursive: true, force: true });
      await fixture.close();
    }
  });
}
