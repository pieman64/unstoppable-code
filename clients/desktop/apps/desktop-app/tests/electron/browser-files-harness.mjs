// CAN-1570 phase 07a: shared helpers for the browser Files (downloads) flows.
// The agent-route helpers are copied from browser-interactions.spec.mjs and
// behave the same way: each route gets its own launch, and the fixture is
// observed through its native WebContents.
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from '@playwright/test';
import { closeCanopy } from './launchCanopy.mjs';
import { seedPanelWorktree, SEEDED_CHAT_TAB_ID } from './panelHarness.mjs';

export const OWNER = {
  projectId: 'demo-ts-pnpm-vite',
  worktreeId: 'demo-main',
};
export const ROUTES = ['advisor', 'mcp'];
/**
 * `worktree` is the MCP route of an ordinary worktree chat: its DispatchAction
 * runs in main, where the App Advisor routes go through the renderer.
 */
export const WORKTREE_ROUTE = 'worktree';
/**
 * `advisor-entry` is App Advisor's MCP route run from its own Work Entry, as
 * in the product: it acts on the demo task's browser from another chat.
 */
export const ADVISOR_ENTRY_ROUTE = 'advisor-entry';
const ADVISOR_ENTRY = {
  projectId: 'app-advisor',
  worktreeId: 'profile-advisor-entry',
};
/** The chat each route's actions come from. */
export function chatForRoute(kind, owner = OWNER) {
  if (kind === ADVISOR_ENTRY_ROUTE)
    return { ...ADVISOR_ENTRY, chatId: SEEDED_CHAT_TAB_ID };
  return {
    projectId: kind === 'advisor' ? 'app-advisor' : owner.projectId,
    worktreeId: owner.worktreeId,
    chatId: SEEDED_CHAT_TAB_ID,
  };
}

export async function dispatchAdvisor(electronApp, action, owner = OWNER) {
  const requestId = randomUUID();
  return electronApp.evaluate(
    async ({ BrowserWindow, ipcMain }, request) => {
      const mainWindow = BrowserWindow.getAllWindows().find(
        (candidate) =>
          !candidate.webContents.getURL().includes('surface=app-advisor'),
      );
      if (!mainWindow) throw new Error('Main window not found');
      ipcMain.removeHandler('app-advisor:tool-response');
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new Error('Timed out waiting for App Advisor browser action'),
            ),
          20_000,
        );
        ipcMain.handle('app-advisor:tool-response', (_event, response) => {
          if (response?.requestId !== request.requestId) return;
          clearTimeout(timer);
          resolve(response);
        });
        mainWindow.webContents.send('app-advisor:tool-request', request);
      });
    },
    {
      kind: 'dispatch_action',
      requestId,
      originChatTabId: SEEDED_CHAT_TAB_ID,
      originWorktreeId: owner.worktreeId,
      action: { ...owner, ...action },
    },
  );
}

export async function dispatchMcp(route, action, owner = OWNER) {
  const response = await fetch(route.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${route.authToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: randomUUID(),
      method: 'tools/call',
      params: {
        name: 'DispatchAction',
        arguments: { action: { ...owner, ...action } },
      },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  expect(response.status).toBe(200);
  const envelope = await response.json();
  expect(envelope.error).toBeUndefined();
  const content = envelope.result?.content?.find(
    (item) => item.type === 'text',
  )?.text;
  if (typeof content !== 'string' || !content.trim().startsWith('{'))
    throw new Error(
      `MCP DispatchAction did not return JSON: ${content ?? 'empty'}`,
    );
  return JSON.parse(content);
}

// Playwright auto-dismisses JavaScript dialogs on every page it can see,
// which races the app's own dialog handling in browser views. A no-op
// listener leaves those dialogs to the app.
export async function leaveDialogsToApp(electronApp, url) {
  await expect
    .poll(() =>
      electronApp
        .context()
        .pages()
        .some((page) => page.url() === url),
    )
    .toBe(true);
  for (const page of electronApp.context().pages())
    if (page.url() === url) page.on('dialog', () => {});
}

export async function openLab(
  electronApp,
  run,
  origin,
  caseName,
  kind,
  { laidOut = false, suffix = '' } = {},
) {
  // A unique fragment keeps each route-owned native view distinguishable
  // without changing the Browser Lab response or its fixture state.
  const url = `${origin}/browser-lab/${caseName}${suffix}#${kind}-${randomUUID()}`;
  const opened = await run({ type: 'browser.open', url });
  expect(opened.ok, JSON.stringify(opened)).toBe(true);
  const browserId = opened.result?.browser?.id;
  expect(browserId).toBeTruthy();
  // Existing-tab commands carry the runtime generation the agent observed,
  // as MCP requires.
  const expectedRuntimeGeneration =
    opened.result?.browser?.profile?.runtimeGeneration;
  expect(typeof expectedRuntimeGeneration).toBe('number');
  // Agent-opened tabs load in the background, so wait for the native
  // WebContents rather than a visible pane.
  await expect
    .poll(
      () =>
        readLab(
          electronApp,
          url,
          `browser-lab-${caseName}-main`,
          'data-testid',
        ).catch(() => null),
      { timeout: 30_000 },
    )
    .toBe(`browser-lab-${caseName}-main`);
  await leaveDialogsToApp(electronApp, url);
  // The app lays out the first agent-opened tab shortly after it loads. Setup
  // that measures the page must wait for that layout.
  if (laidOut)
    await expect
      .poll(() => inLab(electronApp, url, 'innerWidth'), { timeout: 15_000 })
      .toBeGreaterThan(0);
  return {
    browserId,
    expectedRuntimeGeneration,
    url,
    run: (action) => run({ browserId, expectedRuntimeGeneration, ...action }),
  };
}

/**
 * Runs `callback` once per agent route, each in its own launch. `beforeOpen`
 * runs after launch and before the agent opens the lab (for main-process
 * spies). The callback also gets the launch's `userDataDir`.
 */
export async function withBrowser(
  origin,
  caseName,
  callback,
  { routes = ROUTES, beforeOpen, keepUserData = false, seed } = {},
) {
  for (const kind of routes) {
    // `seed` reaches seedPanelWorktree, e.g. to add chat history before launch.
    const launched = await seedPanelWorktree(seed);
    const { electronApp, userDataDir, window } = launched;
    let route;
    try {
      route = await electronApp.evaluate(
        (_electron, routeKind) =>
          globalThis.__CANOPY_E2E_BROWSER_MCP_ROUTE__(
            routeKind === 'worktree'
              ? { kind: 'create' }
              : routeKind === 'advisor-entry'
                ? { kind: 'create', mode: 'app-advisor', owner: 'advisor' }
                : { kind: 'create', mode: 'app-advisor' },
          ),
        kind,
      );
      const run = (action) =>
        kind === 'advisor'
          ? dispatchAdvisor(electronApp, action)
          : // The worktree route's chat owns its scope; it takes no owner fields.
            dispatchMcp(route, action, kind === WORKTREE_ROUTE ? {} : OWNER);
      const context = { kind, electronApp, window, userDataDir, run };
      if (beforeOpen) context.prepared = await beforeOpen(context);
      const lab = await openLab(electronApp, run, origin, caseName, kind, {
        laidOut: true,
      });
      await callback({
        ...context,
        ...lab,
        openAnother: (otherCase) =>
          openLab(electronApp, run, origin, otherCase, kind),
      });
    } finally {
      try {
        if (route)
          await electronApp.evaluate(
            (_electron, sessionKey) =>
              globalThis.__CANOPY_E2E_BROWSER_MCP_ROUTE__({
                kind: 'delete',
                sessionKey,
              }),
            route.sessionKey,
          );
      } finally {
        await closeCanopy(electronApp, userDataDir, { keepUserData });
      }
    }
  }
}

export async function inLab(electronApp, url, expression) {
  return electronApp.evaluate(
    async ({ webContents }, input) => {
      const view = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL() === input.url);
      if (!view)
        throw new Error(`Browser Lab WebContents not found: ${input.url}`);
      return view.executeJavaScript(input.expression);
    },
    { url, expression },
  );
}

export function selector(testId) {
  return `[data-testid="${testId}"]`;
}

export async function readLab(electronApp, url, testId, attribute) {
  return inLab(
    electronApp,
    url,
    `document.querySelector(${JSON.stringify(selector(testId))})?.getAttribute(${JSON.stringify(attribute)})`,
  );
}

export function receiptOf(response) {
  return (
    response.result?.receipt ??
    response.result?.error?.details ??
    response.error?.details ??
    response.details
  );
}

export function waitForOf(response, kind) {
  return kind === 'mcp'
    ? (response.waitFor ?? response.result?.waitFor)
    : response.result?.waitFor;
}

// --- Files (downloads) helpers -------------------------------------------

/** The task's downloads folder for the seeded demo worktree. */
export function taskDownloadsDir(userDataDir, owner = OWNER) {
  return path.join(taskFilesDir(userDataDir, owner), 'downloads');
}

export function taskFilesDir(userDataDir, owner = OWNER) {
  return path.join(
    userDataDir,
    'workspaces',
    owner.projectId,
    'worktree-data',
    owner.worktreeId,
    'browser-files',
  );
}

/** File names in a folder, sorted; an absent folder is empty. */
export function filesIn(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).sort();
}

/**
 * Points Electron's default downloads path at an empty temporary folder and
 * counts every native save dialog call. Returns the folder.
 */
export async function armSaveDialogSpy(electronApp) {
  const sentinel = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-default-downloads-'),
  );
  await electronApp.evaluate(({ app, dialog }, directory) => {
    app.setPath('downloads', directory);
    const calls = [];
    globalThis.__browserFilesSaveDialogCalls = calls;
    for (const name of ['showSaveDialog', 'showSaveDialogSync']) {
      const original = dialog[name];
      dialog[name] = (...args) => {
        calls.push(name);
        return original.apply(dialog, args);
      };
    }
  }, sentinel);
  return sentinel;
}

export function saveDialogCalls(electronApp) {
  return electronApp.evaluate(
    () => globalThis.__browserFilesSaveDialogCalls ?? null,
  );
}

/** The `list_transfers` payload, from either route. */
export function transfersPayload(response) {
  return response.result ?? response;
}

export async function listTransfers(run, request = {}) {
  const response = await run({ type: 'browser.list_transfers', ...request });
  expect(response.ok, JSON.stringify(response)).toBe(true);
  const payload = transfersPayload(response);
  // 07a has no user pause, and the admission hold is not reported as one.
  expect(
    payload.transfers.filter((transfer) => transfer.status === 'paused'),
    'paused transfers',
  ).toEqual([]);
  return payload;
}

/** Polls `list_transfers` until `predicate(transfers)` returns a value. */
export async function pollTransfers(run, predicate, { timeout = 30_000 } = {}) {
  let found;
  let last;
  await expect
    .poll(
      async () => {
        const payload = await listTransfers(run, { limit: 100 });
        last = payload.transfers.map(
          (transfer) =>
            `${transfer.fileName}:${transfer.status}:${transfer.canResume}:${transfer.receivedBytes}/${transfer.totalBytes}`,
        );
        found = predicate(payload.transfers, payload);
        return Boolean(found);
      },
      { timeout },
    )
    .toBe(true)
    .catch((error) => {
      throw new Error(
        `Transfers never matched; last listed: ${JSON.stringify(last)}`,
        { cause: error },
      );
    });
  return found;
}

/** Clicks an element in the page the way a user script would. */
export async function clickInLab(electronApp, url, testId) {
  const clicked = await inLab(
    electronApp,
    url,
    `(() => {
      const target = document.querySelector(${JSON.stringify(selector(testId))});
      if (!(target instanceof HTMLElement)) return false;
      target.click();
      return true;
    })()`,
  );
  expect(clicked, `click ${testId}`).toBe(true);
}

/** Starts a download of `href` from the page, through a temporary link. */
export async function downloadInLab(electronApp, url, href, download) {
  await inLab(
    electronApp,
    url,
    `(() => {
      const link = document.createElement('a');
      link.href = ${JSON.stringify(href)};
      ${download === undefined ? '' : `link.download = ${JSON.stringify(download)};`}
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      link.remove();
      return true;
    })()`,
  );
}

/**
 * Has the page start a download of `href` after `delayMs`, so an agent wait
 * that is already in flight observes it.
 */
export async function downloadInLabLater(electronApp, url, href, delayMs) {
  await inLab(
    electronApp,
    url,
    `(() => {
      setTimeout(() => {
        const link = document.createElement('a');
        link.href = ${JSON.stringify(href)};
        link.style.display = 'none';
        document.body.appendChild(link);
        link.click();
        link.remove();
      }, ${JSON.stringify(delayMs)});
      return true;
    })()`,
  );
}

/**
 * Registers a real approval session for `chat` in `mode`, the way a provider
 * session does, so an action's approval follows that mode. Auto treats the
 * seeded worktree as the workspace.
 */
export function startApprovalSession(electronApp, chat, mode, root = OWNER) {
  return electronApp.evaluate(
    (_electron, input) =>
      globalThis.__CANOPY_E2E_APPROVAL_SESSION__({ kind: 'create', ...input }),
    { ...chat, mode, root },
  );
}

export function endApprovalSession(electronApp, id) {
  return electronApp.evaluate(
    (_electron, sessionId) =>
      globalThis.__CANOPY_E2E_APPROVAL_SESSION__({
        kind: 'dispose',
        id: sessionId,
      }),
    id,
  );
}

/** Opens the Files tab of a browser pane's inspector. */
export async function openFilesPanel(window, browserId) {
  const pane = window.getByTestId(`browser-pane-${browserId}`);
  await expect(pane).toBeVisible();
  const panel = pane.getByTestId('browser-files-panel');
  if (!(await panel.isVisible())) {
    await pane.getByTestId('browser-files-button').click();
  }
  await expect(panel).toBeVisible();
  return { pane, panel };
}

/** The bytes the Browser Lab streams for a synthetic download. */
export function syntheticBytes(seed, length) {
  const bytes = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1)
    bytes[index] = seed.charCodeAt(index % seed.length);
  return bytes;
}

/** Statuses after which a download never changes again. */
export function isFinal(transfer) {
  return (
    transfer.status === 'complete' ||
    transfer.status === 'cancelled' ||
    transfer.status === 'failed' ||
    (transfer.status === 'interrupted' && !transfer.canResume)
  );
}

const ABSOLUTE_PATH_PATTERNS = [
  /(^|["'\s(=])\/(Users|private|var|tmp|home|Volumes|etc|opt)\//,
  /[A-Za-z]:\\\\/,
  /file:\/\//,
];

/** Fails when any string in `value` looks like a host path. */
export function expectPathFree(value, label, extra = []) {
  const text = JSON.stringify(value);
  for (const pattern of ABSOLUTE_PATH_PATTERNS)
    expect(text, `${label} has a host path`).not.toMatch(pattern);
  for (const fragment of extra)
    expect(text, `${label} contains ${fragment}`).not.toContain(fragment);
}

/** A worktree chat's MCP route, as `withBrowser` creates for `worktree`. */
export async function worktreeMcpRoute(electronApp) {
  const route = await electronApp.evaluate(() =>
    globalThis.__CANOPY_E2E_BROWSER_MCP_ROUTE__({ kind: 'create' }),
  );
  return {
    run: (action) => dispatchMcp(route, action, {}),
    close: () =>
      electronApp.evaluate(
        (_electron, sessionKey) =>
          globalThis.__CANOPY_E2E_BROWSER_MCP_ROUTE__({
            kind: 'delete',
            sessionKey,
          }),
        route.sessionKey,
      ),
  };
}

/**
 * Records, instead of sending, the app's replay of Blink's own print() in an
 * isolated world (a print outside an agent action, or the banner's Print…), so
 * the system print panel never opens.
 */
export async function stubNativePrint(electronApp, url) {
  await electronApp.evaluate(
    async ({ webContents }, input) => {
      const view = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL() === input.url);
      if (!view) throw new Error('Browser Lab WebContents not found');
      const calls = [];
      globalThis.__browserFilesNativePrints = calls;
      globalThis.__browserFilesForwardNativePrints = false;
      const debug = view.debugger;
      const send = debug.sendCommand.bind(debug);
      debug.sendCommand = (method, params, sessionId) => {
        if (
          method === 'Runtime.evaluate' &&
          String(params?.expression).includes('canopy native print')
        ) {
          calls.push({ sessionId: sessionId ?? null });
          // A case that expects Blink to ignore the call lets it through.
          if (!globalThis.__browserFilesForwardNativePrints)
            return Promise.resolve({ result: { type: 'undefined' } });
        }
        return sessionId === undefined
          ? send(method, params)
          : send(method, params, sessionId);
      };
      // A document the app's wrapper does not cover (a build without 09b, or
      // a missed frame) would open Chromium's own print panel; silence it so
      // the case fails without a native dialog.
      await Promise.all(
        view.mainFrame.framesInSubtree.map((frame) =>
          frame
            .executeJavaScript(
              'if (!(window.print && window.print.__canopyPrintIntercepted)) window.print = () => undefined;',
            )
            .catch(() => undefined),
        ),
      );
    },
    { url },
  );
}
export function nativePrints(electronApp) {
  return electronApp.evaluate(
    () => globalThis.__browserFilesNativePrints ?? [],
  );
}
