// CAN-1570 phase 03: real agent-route browser input against Browser Lab.
// The fixture is observed through its native WebContents; Playwright input
// never performs the browser action being asserted.
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { listenPairedBrowserLabServers } from './mock-server/routes/browser-lab.mjs';
import { closeCanopy } from './launchCanopy.mjs';
import {
  chatPanelLocator,
  seedPanelWorktree,
  SEEDED_CHAT_TAB_ID,
} from './panelHarness.mjs';

const OWNER = { projectId: 'demo-ts-pnpm-vite', worktreeId: 'demo-main' };
const ROUTES = ['advisor', 'mcp'];
let lab;
let origin;

test.beforeAll(async () => {
  lab = await listenPairedBrowserLabServers();
  origin = lab.primary.origin;
});

test.afterAll(async () => {
  if (!lab) return;
  await lab.close();
});

async function dispatchAdvisor(electronApp, action) {
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
      originWorktreeId: OWNER.worktreeId,
      action: { ...OWNER, ...action },
    },
  );
}

async function dispatchMcp(route, action) {
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
        arguments: { action: { ...OWNER, ...action } },
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
async function leaveDialogsToApp(electronApp, url) {
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

async function openLab(
  electronApp,
  run,
  caseName,
  kind,
  { laidOut = false } = {},
) {
  // A unique fragment keeps each route-owned native view distinguishable
  // without changing the Browser Lab response or its fixture state.
  const url = `${origin}/browser-lab/${caseName}#${kind}-${randomUUID()}`;
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

// Each route gets its own launch, so its first tab is the one the app lays
// out. A later agent-opened tab is never shown and has no size.
async function withBrowser(caseName, callback) {
  for (const kind of ROUTES) {
    const launched = await seedPanelWorktree();
    const { electronApp, userDataDir, window } = launched;
    let route;
    try {
      route = await electronApp.evaluate(() =>
        globalThis.__CANOPY_E2E_BROWSER_MCP_ROUTE__({
          kind: 'create',
          mode: 'app-advisor',
        }),
      );
      const run = (action) =>
        kind === 'advisor'
          ? dispatchAdvisor(electronApp, action)
          : dispatchMcp(route, action);
      const lab = await openLab(electronApp, run, caseName, kind, {
        laidOut: true,
      });
      await callback({
        kind,
        ...lab,
        openAnother: (otherCase) => openLab(electronApp, run, otherCase, kind),
        electronApp,
        window,
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
        await closeCanopy(electronApp, userDataDir);
      }
    }
  }
}

async function inLab(electronApp, url, expression) {
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

function selector(testId) {
  return `[data-testid="${testId}"]`;
}

async function readLab(electronApp, url, testId, attribute) {
  return inLab(
    electronApp,
    url,
    `document.querySelector(${JSON.stringify(selector(testId))})?.getAttribute(${JSON.stringify(attribute)})`,
  );
}

async function setLabProperty(electronApp, url, testId, property, value) {
  // Fixture setup only: it never dispatches the action under test.
  return inLab(
    electronApp,
    url,
    `document.querySelector(${JSON.stringify(selector(testId))})[${JSON.stringify(property)}] = ${JSON.stringify(value)}`,
  );
}

function receiptOf(response) {
  return (
    response.result?.receipt ??
    response.result?.error?.details ??
    response.error?.details ??
    response.details
  );
}

test.describe('compatibility', () => {
  test('plain click and fill retain the response shape and fixture effects through both routes', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      const clicked = await run({
        type: 'browser.click',
        locator: selector('browser-lab-controls-menu-button'),
      });
      expect(clicked.ok).toBe(true);
      expect(clicked.result).toMatchObject({
        completed: true,
        browser: { id: expect.any(String) },
      });
      await expect
        .poll(() =>
          readLab(
            electronApp,
            url,
            'browser-lab-controls-menu-status',
            'data-browser-lab-last-action',
          ),
        )
        .toBe('opened-click');
      const filled = await run({
        type: 'browser.fill',
        locator: selector('browser-lab-controls-enter-input'),
        text: 'Agent fill',
      });
      expect(filled.ok).toBe(true);
      expect(filled.result).toMatchObject({
        completed: true,
        browser: { id: expect.any(String) },
      });
      expect(
        await inLab(
          electronApp,
          url,
          `document.querySelector(${JSON.stringify(selector('browser-lab-controls-enter-input'))}).value`,
        ),
      ).toBe('Agent fill');
    });
  });

  test('untargeted Enter is delivered to an already focused input through both routes', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      await inLab(
        electronApp,
        url,
        `document.querySelector(${JSON.stringify(selector('browser-lab-controls-enter-input'))}).focus()`,
      );
      const pressed = await run({ type: 'browser.press', key: 'Enter' });
      expect(pressed.result).toMatchObject({
        completed: true,
        browser: { id: expect.any(String) },
      });
    });
  });

  test('prearmed dialogResponse answers synchronous click confirm through both routes', async () => {
    test.setTimeout(120_000);
    await withBrowser('dialog-surfaces', async ({ run, electronApp, url }) => {
      const clicked = await run({
        type: 'browser.click',
        locator: selector('browser-lab-dialog-surfaces-click-confirm'),
        dialogResponse: { accept: false },
      });
      expect(clicked.ok).toBe(true);
      expect(clicked.result).toMatchObject({
        completed: true,
        browser: { id: expect.any(String) },
        handledDialog: { accept: false, dialog: { type: 'confirm' } },
      });
      await expect
        .poll(() =>
          readLab(
            electronApp,
            url,
            'browser-lab-dialog-surfaces-click-confirm-status',
            'data-browser-lab-answer',
          ),
        )
        .toBe('dismissed');
    });
  });

  test('composer focus survives fill through both routes', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, window }) => {
      const composer = chatPanelLocator(window).locator(
        '[data-chat-textarea][contenteditable="true"]',
      );
      await composer.fill('User draft');
      await composer.focus();
      const filled = await run({
        type: 'browser.fill',
        locator: selector('browser-lab-controls-enter-input'),
        text: 'Agent text',
      });
      expect(filled.ok).toBe(true);
      await expect(composer).toBeFocused();
      await expect(composer).toHaveText('User draft');
    });
  });
});

test.describe('compatibility: dialogs opened by press and fill', () => {
  test('press and fill that open an alert return the dialog promptly and leave the tab usable through both routes', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      // Setup only: an input whose own handlers open an alert. The agent's
      // press and fill, not setup, trigger them.
      await inLab(
        electronApp,
        url,
        `(() => { const input = document.createElement('input'); input.dataset.testid = 'phase03-dialog-input'; input.addEventListener('keydown', (event) => { if (event.key === 'Enter') window.alert('phase03 keydown alert'); }); input.addEventListener('input', () => window.alert('phase03 input alert')); document.querySelector('[data-testid="browser-lab-controls-main"]').append(input); return true; })()`,
      );
      for (const action of [
        {
          type: 'browser.press',
          locator: selector('phase03-dialog-input'),
          key: 'Enter',
        },
        {
          type: 'browser.fill',
          locator: selector('phase03-dialog-input'),
          text: 'x',
        },
      ]) {
        const startedAt = Date.now();
        const result = await run(action);
        expect(Date.now() - startedAt).toBeLessThan(8_000);
        expect(result.ok, JSON.stringify(result)).toBe(true);
        expect(result.result).toMatchObject({
          completed: false,
          dialog: { type: 'alert' },
        });
        const answered = await run({
          type: 'browser.handle_dialog',
          dialogId: result.result.dialog.id,
          accept: true,
        });
        expect(answered.ok, JSON.stringify(answered)).toBe(true);
      }
      // The tab still takes input once the dialogs are answered.
      const clicked = await run({
        type: 'browser.click',
        locator: selector('browser-lab-controls-menu-button'),
      });
      expect(clicked.ok, JSON.stringify(clicked)).toBe(true);
    });
  });
});

test.describe('phase 03 behavior', () => {
  test('phase 03 behavior: real pointer-down opens a menu through both routes', async () => {
    test.setTimeout(120_000);
    await withBrowser('menus', async ({ kind, run, electronApp, url }) => {
      const result = await run({
        type: 'browser.click',
        locator: selector('browser-lab-menus-pointer-trigger'),
      });
      expect(result.ok).toBe(true);
      await expect
        .poll(
          () =>
            readLab(
              electronApp,
              url,
              'browser-lab-menus-pointer-status',
              'data-browser-lab-last-action',
            ),
          { message: `${kind}: ${JSON.stringify(receiptOf(result))}` },
        )
        .toBe('opened-pointerdown');
    });
  });

  test('phase 03 behavior: Enter submits the focused form through both routes', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ kind, run, electronApp, url }) => {
      await inLab(
        electronApp,
        url,
        `document.querySelector(${JSON.stringify(selector('browser-lab-controls-enter-input'))}).focus()`,
      );
      const result = await run({ type: 'browser.press', key: 'Enter' });
      expect(result.ok).toBe(true);
      await expect
        .poll(
          () =>
            readLab(
              electronApp,
              url,
              'browser-lab-controls-enter-result',
              'data-browser-lab-state',
            ),
          { message: `${kind}: ${JSON.stringify(receiptOf(result))}` },
        )
        .toBe('received');
      expect(
        await readLab(
          electronApp,
          url,
          'browser-lab-controls-enter-form',
          'data-browser-lab-submit-count',
        ),
      ).toBe('1');
    });
  });

  test('phase 03 behavior: Tab moves in positive tabindex order through both routes', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ kind, run, electronApp, url }) => {
      await inLab(
        electronApp,
        url,
        `document.querySelector(${JSON.stringify(selector('browser-lab-controls-tab-one'))}).focus()`,
      );
      const result = await run({ type: 'browser.press', key: 'Tab' });
      expect(result.ok).toBe(true);
      await expect
        .poll(
          () =>
            inLab(
              electronApp,
              url,
              `document.activeElement?.getAttribute('data-testid')`,
            ),
          { message: `${kind}: ${JSON.stringify(receiptOf(result))}` },
        )
        .toBe('browser-lab-controls-tab-two');
      expect(
        JSON.parse(
          await readLab(
            electronApp,
            url,
            'browser-lab-controls-focus-log',
            'data-browser-lab-focus-log',
          ),
        ),
      ).toContain('browser-lab-controls-tab-two');
    });
  });

  for (const key of [
    process.platform === 'darwin' ? 'Meta+V' : 'Control+V',
    process.platform === 'darwin' ? 'Meta+T' : 'Control+T',
  ]) {
    test(`phase 03 behavior: ${key} is refused through both routes`, async () => {
      test.setTimeout(120_000);
      await withBrowser('controls', async ({ run, electronApp, url }) => {
        await inLab(
          electronApp,
          url,
          `document.querySelector(${JSON.stringify(selector('browser-lab-controls-enter-input'))}).focus()`,
        );
        const result = await run({ type: 'browser.press', key });
        expect(result.ok).toBe(false);
        expect(receiptOf(result)).toMatchObject({
          status: 'not_executed',
          error: { code: 'policy_denied' },
        });
      });
    });
  }

  test('phase 03 behavior: disabled click reports target_disabled through both routes', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      await setLabProperty(
        electronApp,
        url,
        'browser-lab-controls-menu-button',
        'disabled',
        true,
      );
      const result = await run({
        type: 'browser.click',
        locator: selector('browser-lab-controls-menu-button'),
      });
      expect(result.ok).toBe(false);
      expect(receiptOf(result)).toMatchObject({
        status: 'not_executed',
        error: { code: 'target_disabled' },
      });
      expect(
        await readLab(
          electronApp,
          url,
          'browser-lab-controls-menu-status',
          'data-browser-lab-last-action',
        ),
      ).toBe('idle');
    });
  });

  test('phase 03 behavior: readonly fill reports not_editable through both routes', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      await setLabProperty(
        electronApp,
        url,
        'browser-lab-controls-enter-input',
        'readOnly',
        true,
      );
      const result = await run({
        type: 'browser.fill',
        locator: selector('browser-lab-controls-enter-input'),
        text: 'should not appear',
      });
      expect(result.ok).toBe(false);
      expect(receiptOf(result)).toMatchObject({
        status: 'not_executed',
        error: { code: 'not_editable' },
      });
      expect(
        await inLab(
          electronApp,
          url,
          `document.querySelector(${JSON.stringify(selector('browser-lab-controls-enter-input'))}).value`,
        ),
      ).toBe('');
    });
  });

  test('phase 03 behavior: explicit missing press target reports target_not_found through both routes', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      await inLab(
        electronApp,
        url,
        `document.querySelector(${JSON.stringify(selector('browser-lab-controls-enter-input'))}).focus()`,
      );
      const result = await run({
        type: 'browser.press',
        locator: '[data-testid="browser-lab-missing-target"]',
        key: 'Enter',
      });
      expect(result.ok).toBe(false);
      expect(receiptOf(result)).toMatchObject({
        status: 'not_executed',
        error: { code: 'target_not_found' },
      });
      expect(
        await readLab(
          electronApp,
          url,
          'browser-lab-controls-enter-form',
          'data-browser-lab-submit-count',
        ),
      ).toBe('0');
    });
  });

  test('phase 03 behavior: covered click uses synthetic fallback with a warning through both routes', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      // Setup-only cover over an existing Browser Lab marker. The agent click, not setup, opens the fixture menu.
      await inLab(
        electronApp,
        url,
        `(() => { const target = document.querySelector(${JSON.stringify(selector('browser-lab-controls-menu-button'))}); target.scrollIntoView(); const rect = target.getBoundingClientRect(); const cover = document.createElement('div'); cover.dataset.testid = 'phase03-click-cover'; cover.className = 'phase03-click-cover'; cover.style.cssText = 'position:fixed;z-index:2147483647;background:rgba(0,0,0,.1);left:' + rect.left + 'px;top:' + rect.top + 'px;width:' + rect.width + 'px;height:' + rect.height + 'px'; document.body.append(cover); })()`,
      );
      const result = await run({
        type: 'browser.click',
        locator: selector('browser-lab-controls-menu-button'),
      });
      expect(result.ok).toBe(true);
      expect(receiptOf(result)).toMatchObject({
        status: 'executed',
        inputMode: 'synthetic',
        warnings: expect.arrayContaining([expect.any(String)]),
      });
      expect(JSON.stringify(receiptOf(result).warnings)).toContain(
        'phase03-click-cover',
      );
      await expect
        .poll(() =>
          readLab(
            electronApp,
            url,
            'browser-lab-controls-menu-status',
            'data-browser-lab-last-action',
          ),
        )
        .toBe('opened-click');
    });
  });

  test('phase 03 behavior: every successful click, press, and fill carries an executed receipt through both routes', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      await inLab(
        electronApp,
        url,
        `document.querySelector(${JSON.stringify(selector('browser-lab-controls-enter-input'))}).focus()`,
      );
      for (const action of [
        {
          type: 'browser.click',
          locator: selector('browser-lab-controls-menu-button'),
        },
        { type: 'browser.press', key: 'a' },
        {
          type: 'browser.fill',
          locator: selector('browser-lab-controls-enter-input'),
          text: 'receipt',
        },
      ]) {
        const result = await run(action);
        expect(result.ok, JSON.stringify(result)).toBe(true);
        expect(receiptOf(result)).toMatchObject({ status: 'executed' });
      }
    });
  });

  test('phase 03 behavior: click and press preserve a focused composer through both routes', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, window }) => {
      const composer = chatPanelLocator(window).locator(
        '[data-chat-textarea][contenteditable="true"]',
      );
      await composer.fill('Draft');
      for (const action of [
        {
          type: 'browser.click',
          locator: selector('browser-lab-controls-menu-button'),
        },
        {
          type: 'browser.press',
          locator: selector('browser-lab-controls-enter-input'),
          key: 'a',
        },
      ]) {
        await composer.focus();
        const result = await run(action);
        expect(result.ok).toBe(true);
        await expect(composer).toBeFocused();
        await expect(composer).toHaveText('Draft');
      }
    });
  });
});

test.describe('phase 03 never-shown tabs', () => {
  test('phase 03 behavior: a never-shown tab falls back to a direct click without waiting through both routes', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ electronApp, openAnother }) => {
      const hidden = await openAnother('controls');
      const result = await hidden.run({
        type: 'browser.click',
        locator: selector('browser-lab-controls-menu-button'),
      });
      expect(result.ok).toBe(true);
      const receipt = receiptOf(result);
      expect(receipt).toMatchObject({
        status: 'executed',
        inputMode: 'synthetic',
        warnings: expect.arrayContaining([
          expect.stringContaining('has not been shown'),
        ]),
      });
      expect(receipt.durationMs).toBeLessThan(2_000);
      await expect
        .poll(() =>
          readLab(
            electronApp,
            hidden.url,
            'browser-lab-controls-menu-status',
            'data-browser-lab-last-action',
          ),
        )
        .toBe('opened-click');
    });
  });
});

test.describe('phase 03 agent input attribution', () => {
  test('phase 03 behavior: pick mode refuses agent clicks before any input through both routes', async () => {
    test.setTimeout(120_000);
    await withBrowser(
      'menus',
      async ({
        run,
        electronApp,
        url,
        window,
        browserId,
        expectedRuntimeGeneration,
      }) => {
        await window.evaluate(
          (request) => window.api.browser.setPickMode(request),
          { browserId, expectedRuntimeGeneration, enabled: true },
        );
        try {
          const result = await run({
            type: 'browser.click',
            locator: selector('browser-lab-menus-pointer-trigger'),
          });
          expect(result.ok).toBe(false);
          expect(JSON.stringify(result.error)).toContain('picking');
          expect(receiptOf(result)).toMatchObject({ status: 'not_executed' });
          expect(
            await readLab(
              electronApp,
              url,
              'browser-lab-menus-pointer-status',
              'data-browser-lab-last-action',
            ),
          ).toBe('idle');
        } finally {
          await window.evaluate(
            (request) => window.api.browser.setPickMode(request),
            { browserId, expectedRuntimeGeneration, enabled: false },
          );
        }
      },
    );
  });

  test('phase 03 behavior: recording captures real-input agent clicks through both routes', async () => {
    test.setTimeout(120_000);
    await withBrowser(
      'menus',
      async ({ run, window, browserId, expectedRuntimeGeneration }) => {
        await window.evaluate(
          (request) => window.api.browser.startRecording(request),
          { browserId, expectedRuntimeGeneration },
        );
        const result = await run({
          type: 'browser.click',
          locator: selector('browser-lab-menus-pointer-trigger'),
        });
        expect(result.ok).toBe(true);
        const recording = await window.evaluate(
          (request) => window.api.browser.stopRecording(request),
          { browserId, expectedRuntimeGeneration },
        );
        expect(recording.steps.some((step) => step.action === 'click')).toBe(
          true,
        );
      },
    );
  });

  test('a genuine user click during an agent click keeps focus in the browser', async () => {
    test.setTimeout(120_000);
    await withBrowser(
      'controls',
      async ({
        kind,
        electronApp,
        window,
        url,
        browserId,
        expectedRuntimeGeneration,
      }) => {
        // The focus guard under test belongs to the App Advisor renderer route.
        if (kind !== 'advisor') return;
        const composer = chatPanelLocator(window).locator(
          '[data-chat-textarea][contenteditable="true"]',
        );
        await composer.fill('Draft');
        await composer.focus();
        const observed = await electronApp.evaluate(
          async ({ BrowserWindow, ipcMain, webContents }, payload) => {
            const mainWindow = BrowserWindow.getAllWindows().find(
              (candidate) =>
                !candidate.webContents.getURL().includes('surface=app-advisor'),
            );
            if (!mainWindow) throw new Error('Main window not found');
            const lab = webContents
              .getAllWebContents()
              .find((contents) => contents.getURL() === payload.url);
            if (!lab) throw new Error('Browser Lab WebContents not found');
            ipcMain.removeHandler('app-advisor:tool-response');
            return new Promise((resolve, reject) => {
              const timer = setTimeout(
                () => reject(new Error('Timed out waiting for browser action')),
                20_000,
              );
              ipcMain.handle(
                'app-advisor:tool-response',
                (_event, response) => {
                  if (response?.requestId !== payload.request.requestId) return;
                  clearTimeout(timer);
                  resolve({
                    response,
                    mainRendererFocused: mainWindow.webContents.isFocused(),
                  });
                },
              );
              mainWindow.webContents.send(
                'app-advisor:tool-request',
                payload.request,
              );
              // A real user click far from the agent's target, while the
              // agent's input is still being dispatched or settling.
              setTimeout(() => {
                lab.focus();
                for (const type of ['mouseDown', 'mouseUp'])
                  lab.sendInputEvent({
                    type,
                    x: 8,
                    y: 8,
                    button: 'left',
                    clickCount: 1,
                  });
              }, 100);
            });
          },
          {
            url,
            request: {
              kind: 'dispatch_action',
              requestId: randomUUID(),
              originChatTabId: SEEDED_CHAT_TAB_ID,
              originWorktreeId: OWNER.worktreeId,
              action: {
                ...OWNER,
                type: 'browser.click',
                browserId,
                expectedRuntimeGeneration,
                locator: selector('browser-lab-controls-menu-button'),
              },
            },
          },
        );
        expect(observed.response.ok).toBe(true);
        expect(observed.mainRendererFocused).toBe(false);
      },
    );
  });
});

test.describe('privacy', () => {
  test('password, OTP, and card fill responses never contain secret values through both routes', async () => {
    test.setTimeout(120_000);
    await withBrowser('typing', async ({ run, electronApp, url, kind }) => {
      for (const [testId, secret] of [
        ['browser-lab-typing-secret-password', `phase03-password-${kind}-9471`],
        [
          'browser-lab-typing-secret-one-time-code',
          `918274${kind === 'advisor' ? '1' : '2'}`,
        ],
        [
          'browser-lab-typing-secret-card-number',
          `499988887777${kind === 'advisor' ? '1111' : '2222'}`,
        ],
      ]) {
        const result = await run({
          type: 'browser.fill',
          locator: selector(testId),
          text: secret,
        });
        expect(result.ok).toBe(true);
        expect(JSON.stringify(result)).not.toContain(secret);
        expect(
          await inLab(
            electronApp,
            url,
            `document.querySelector(${JSON.stringify(selector(testId))}).value`,
          ),
        ).toBe(secret);
        await expect
          .poll(() =>
            readLab(
              electronApp,
              url,
              `${testId}-status`,
              'data-browser-lab-length',
            ),
          )
          .toBe(String(secret.length));
      }
    });
  });
});

test.describe('phase 03b public action API', () => {
  function waitForOf(response, kind) {
    return kind === 'mcp'
      ? (response.waitFor ?? response.result?.waitFor)
      : response.result?.waitFor;
  }

  test('phase 03b: click parameters reach the page through both routes', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      await inLab(
        electronApp,
        url,
        `(() => {
          const target = document.createElement('button');
          target.dataset.testid = 'phase03b-click-target';
          target.textContent = 'Phase 03b click target';
          target.style.cssText = 'position:fixed;left:80px;top:80px;width:200px;height:80px;z-index:2147483646';
          target.dataset.clickCount = '0';
          target.addEventListener('contextmenu', (event) => {
            event.preventDefault();
            target.dataset.contextmenu = String(event.button === 2);
          });
          target.addEventListener('auxclick', (event) => {
            target.dataset.auxclickButton = String(event.button);
          });
          target.addEventListener('dblclick', () => {
            target.dataset.dblclick = 'true';
          });
          target.addEventListener('click', (event) => {
            target.dataset.clickCount = String(Number(target.dataset.clickCount) + 1);
            target.dataset.clickDetail = String(event.detail);
            target.dataset.metaKey = String(event.metaKey);
            target.dataset.shiftKey = String(event.shiftKey);
            target.dataset.altKey = String(event.altKey);
            target.dataset.ctrlKey = String(event.ctrlKey);
          });
          for (const type of ['pointerdown', 'mousedown'])
            target.addEventListener(type, (event) => {
              target.dataset.lastPositionEvent = type;
              target.dataset[type + 'X'] = String(event.offsetX);
              target.dataset[type + 'Y'] = String(event.offsetY);
            });
          document.body.append(target);
          return true;
        })()`,
      );

      const clickTarget = selector('phase03b-click-target');
      for (const [button, expectedAttribute, expectedValue] of [
        ['right', 'data-contextmenu', 'true'],
        ['middle', 'data-auxclick-button', '1'],
      ]) {
        const result = await run({
          type: 'browser.click',
          locator: clickTarget,
          button,
        });
        expect(result.ok, JSON.stringify(result)).toBe(true);
        expect(receiptOf(result)).toMatchObject({ status: 'executed' });
        await expect
          .poll(() =>
            inLab(
              electronApp,
              url,
              `document.querySelector(${JSON.stringify(clickTarget)})?.getAttribute(${JSON.stringify(expectedAttribute)})`,
            ),
          )
          .toBe(expectedValue);
      }

      const doubleClick = await run({
        type: 'browser.click',
        locator: clickTarget,
        clickCount: 2,
      });
      expect(doubleClick.ok, JSON.stringify(doubleClick)).toBe(true);
      expect(receiptOf(doubleClick)).toMatchObject({ status: 'executed' });
      await expect
        .poll(() =>
          readLab(electronApp, url, 'phase03b-click-target', 'data-dblclick'),
        )
        .toBe('true');
      expect(
        await readLab(
          electronApp,
          url,
          'phase03b-click-target',
          'data-click-detail',
        ),
      ).toBe('2');

      const modifiedClick = await run({
        type: 'browser.click',
        locator: clickTarget,
        modifiers: ['Shift', 'Alt'],
      });
      expect(modifiedClick.ok, JSON.stringify(modifiedClick)).toBe(true);
      expect(receiptOf(modifiedClick)).toMatchObject({ status: 'executed' });
      await expect
        .poll(async () => ({
          shiftKey: await readLab(
            electronApp,
            url,
            'phase03b-click-target',
            'data-shift-key',
          ),
          altKey: await readLab(
            electronApp,
            url,
            'phase03b-click-target',
            'data-alt-key',
          ),
        }))
        .toEqual({ shiftKey: 'true', altKey: 'true' });

      const positionedClick = await run({
        type: 'browser.click',
        locator: clickTarget,
        position: { x: 10, y: 10 },
      });
      expect(positionedClick.ok, JSON.stringify(positionedClick)).toBe(true);
      expect(receiptOf(positionedClick)).toMatchObject({ status: 'executed' });
      const offsets = await inLab(
        electronApp,
        url,
        `(() => {
          const target = document.querySelector(${JSON.stringify(clickTarget)});
          const type = target.dataset.lastPositionEvent;
          return {
            x: Number(target.dataset[type + 'X']),
            y: Number(target.dataset[type + 'Y']),
          };
        })()`,
      );
      expect(Math.abs(offsets.x - 10)).toBeLessThanOrEqual(2);
      expect(Math.abs(offsets.y - 10)).toBeLessThanOrEqual(2);

      await inLab(
        electronApp,
        url,
        `(() => {
          const target = document.querySelector(${JSON.stringify(clickTarget)});
          const rect = target.getBoundingClientRect();
          const cover = document.createElement('div');
          cover.dataset.testid = 'phase03b-click-cover';
          cover.style.cssText = 'position:fixed;z-index:2147483647;background:rgba(0,0,0,.1);left:' + rect.left + 'px;top:' + rect.top + 'px;width:' + rect.width + 'px;height:' + rect.height + 'px';
          document.body.append(cover);
          return true;
        })()`,
      );
      const clicksBeforeForce = Number(
        await readLab(
          electronApp,
          url,
          'phase03b-click-target',
          'data-click-count',
        ),
      );
      const forcedClick = await run({
        type: 'browser.click',
        locator: clickTarget,
        force: true,
      });
      expect(forcedClick.ok, JSON.stringify(forcedClick)).toBe(true);
      expect(receiptOf(forcedClick)).toMatchObject({
        status: 'executed',
        inputMode: 'synthetic',
      });
      expect(
        Number(
          await readLab(
            electronApp,
            url,
            'phase03b-click-target',
            'data-click-count',
          ),
        ),
      ).toBeGreaterThan(clicksBeforeForce);
    });
  });

  test('phase 03b: actionId repeats return the original receipt and conflicting reuse is rejected through both routes', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ kind, run, electronApp, url }) => {
      await inLab(
        electronApp,
        url,
        `(() => {
          const button = document.createElement('button');
          button.dataset.testid = 'phase03b-repeat-button';
          button.dataset.count = '0';
          button.textContent = 'Repeat action target';
          button.style.cssText = 'position:fixed;left:80px;top:80px;width:200px;height:80px';
          button.addEventListener('click', () => {
            button.dataset.count = String(Number(button.dataset.count) + 1);
          });
          document.body.append(button);
          return true;
        })()`,
      );
      const actionId = `phase03b-repeat-${kind}-${randomUUID()}`;
      const action = {
        type: 'browser.click',
        locator: selector('phase03b-repeat-button'),
        actionId,
      };
      const first = await run(action);
      expect(first.ok, JSON.stringify(first)).toBe(true);
      const second = await run(action);
      expect(second.ok, JSON.stringify(second)).toBe(true);
      expect(receiptOf(first)).toMatchObject({ actionId });
      expect(receiptOf(first).sequence).toBeDefined();
      expect(receiptOf(second)).toEqual(receiptOf(first));
      expect(second.result?.repeated ?? second.repeated).toBe(true);
      expect(
        await readLab(electronApp, url, 'phase03b-repeat-button', 'data-count'),
      ).toBe('1');

      const conflicting = await run({ ...action, clickCount: 2 });
      expect(conflicting.ok).toBe(false);
      expect(JSON.stringify(conflicting)).toContain(actionId);
      expect(
        await readLab(electronApp, url, 'phase03b-repeat-button', 'data-count'),
      ).toBe('1');
    });
  });

  test('phase 03b: focus and timeoutMs through both routes', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      const focused = await run({
        type: 'browser.focus',
        locator: selector('browser-lab-controls-enter-input'),
      });
      expect(focused.ok, JSON.stringify(focused)).toBe(true);
      expect(receiptOf(focused)).toMatchObject({
        status: 'executed',
        kind: 'focus',
        target: { focused: true },
      });
      await expect
        .poll(() =>
          inLab(
            electronApp,
            url,
            `document.activeElement?.getAttribute('data-testid')`,
          ),
        )
        .toBe('browser-lab-controls-enter-input');

      await setLabProperty(
        electronApp,
        url,
        'browser-lab-controls-menu-button',
        'disabled',
        true,
      );
      const startedAt = Date.now();
      const disabled = await run({
        type: 'browser.click',
        locator: selector('browser-lab-controls-menu-button'),
        timeoutMs: 600,
      });
      expect(Date.now() - startedAt).toBeLessThan(4_000);
      expect(disabled.ok).toBe(false);
      expect(receiptOf(disabled)).toMatchObject({
        status: 'not_executed',
        error: { code: 'target_disabled' },
      });
    });
  });

  test('phase 03b: wait_for conditions through both routes', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ kind, run, electronApp, url }) => {
      const satisfiedWait = async (condition) => {
        const response = await run({
          type: 'browser.wait_for',
          timeoutMs: 5_000,
          ...condition,
        });
        expect(response.ok, JSON.stringify(response)).toBe(true);
        expect(waitForOf(response, kind)?.satisfied).toBe(true);
        expect(receiptOf(response)).toMatchObject({
          kind: 'wait_for',
          status: 'executed',
        });
        return response;
      };

      await inLab(
        electronApp,
        url,
        `setTimeout(() => {
          const element = document.createElement('div');
          element.dataset.testid = 'phase03b-wait-visible';
          element.textContent = 'Visible after a delay';
          document.body.append(element);
        }, 400)`,
      );
      await satisfiedWait({ locator: selector('phase03b-wait-visible') });

      await inLab(
        electronApp,
        url,
        `(() => {
          const element = document.createElement('div');
          element.dataset.testid = 'phase03b-wait-hidden';
          element.textContent = 'Hidden after a delay';
          document.body.append(element);
          setTimeout(() => { element.style.display = 'none'; }, 300);
          return true;
        })()`,
      );
      await satisfiedWait({
        locator: selector('phase03b-wait-hidden'),
        state: 'hidden',
      });

      await inLab(
        electronApp,
        url,
        `(() => {
          const element = document.createElement('div');
          element.dataset.testid = 'phase03b-wait-detached';
          element.textContent = 'Removed after a delay';
          document.body.append(element);
          setTimeout(() => element.remove(), 300);
          return true;
        })()`,
      );
      await satisfiedWait({
        locator: selector('phase03b-wait-detached'),
        state: 'detached',
      });

      await inLab(
        electronApp,
        url,
        `setTimeout(() => {
          const element = document.createElement('div');
          element.textContent = 'phase03b delayed text';
          document.body.append(element);
        }, 300)`,
      );
      await satisfiedWait({ text: 'phase03b delayed text' });

      await satisfiedWait({ loadState: 'load' });
      await satisfiedWait({ loadState: 'network_idle' });

      const missingStartedAt = Date.now();
      const missing = await run({
        type: 'browser.wait_for',
        locator: selector('phase03b-never-created'),
        timeoutMs: 700,
      });
      expect(Date.now() - missingStartedAt).toBeLessThan(4_000);
      expect(missing.ok, JSON.stringify(missing)).toBe(true);
      expect(waitForOf(missing, kind)?.satisfied).toBe(false);
      expect(receiptOf(missing)).toMatchObject({
        kind: 'wait_for',
        status: 'executed',
      });

      await inLab(
        electronApp,
        url,
        `setTimeout(() => {
          history.pushState({}, '', location.pathname + '?phase03b-url-ready');
        }, 300)`,
      );
      await satisfiedWait({ url: 'phase03b-url-ready' });
    });
  });
});

test.describe('phase 04b: the first command on a new tab', () => {
  test('phase 04b: a load-state wait as the first command on a new tab is polled through both routes', async () => {
    test.setTimeout(120_000);
    // A tab that opens straight onto its page commits its root frame before
    // the service enables the Page domain. Setup reads the fixture through
    // the native WebContents only, so each wait below is the tab's first
    // agent command.
    await withBrowser('controls', async ({ kind, run, openAnother }) => {
      const neverShown = await openAnother('controls');
      for (const [target, loadState] of [
        [run, 'load'],
        [neverShown.run, 'domcontentloaded'],
      ]) {
        const response = await target({
          type: 'browser.wait_for',
          loadState,
          timeoutMs: 5_000,
        });
        expect(response.ok, JSON.stringify(response)).toBe(true);
        const waitFor =
          kind === 'mcp'
            ? (response.waitFor ?? response.result?.waitFor)
            : response.result?.waitFor;
        expect(waitFor?.satisfied, JSON.stringify(response)).toBe(true);
        expect(receiptOf(response)).toMatchObject({
          kind: 'wait_for',
          status: 'executed',
        });
      }
    });
  });
});

test.describe('phase 05: pointer and viewport actions', () => {
  function effectsOf(response) {
    return receiptOf(response)?.effects;
  }

  test('phase 05: hover opens a hover menu, and right-click opens a context menu, through both routes', async () => {
    test.setTimeout(120_000);
    await withBrowser('menus', async ({ run, electronApp, url }) => {
      const hovered = await run({
        type: 'browser.hover',
        locator: selector('browser-lab-menus-hover-trigger'),
      });
      expect(hovered.ok, JSON.stringify(hovered)).toBe(true);
      expect(receiptOf(hovered)).toMatchObject({
        kind: 'hover',
        status: 'executed',
        inputMode: 'trusted',
      });
      await expect
        .poll(() =>
          readLab(
            electronApp,
            url,
            'browser-lab-menus-hover-status',
            'data-browser-lab-last-action',
          ),
        )
        .toBe('opened-hover');

      const context = await run({
        type: 'browser.click',
        locator: selector('browser-lab-menus-context-area'),
        button: 'right',
      });
      expect(context.ok, JSON.stringify(context)).toBe(true);
      await expect
        .poll(() =>
          readLab(
            electronApp,
            url,
            'browser-lab-menus-context-status',
            'data-browser-lab-last-action',
          ),
        )
        .toBe('opened-contextmenu');
    });
  });

  test('phase 05: scroll moves the page and containers and reports what moved, through both routes', async () => {
    test.setTimeout(180_000);
    await withBrowser('scroll', async ({ run, electronApp, url }) => {
      // The page, by one page.
      const page = await run({ type: 'browser.scroll', direction: 'down' });
      expect(page.ok, JSON.stringify(page)).toBe(true);
      // The view is showing, so the page scrolls for real wheel input.
      expect(receiptOf(page)).toMatchObject({
        kind: 'scroll',
        status: 'executed',
        inputMode: 'trusted',
      });
      expect(receiptOf(page).warnings ?? []).toEqual([]);
      expect(effectsOf(page)?.scroll).toMatchObject({
        container: 'page',
        axis: 'y',
        moved: true,
        atStart: false,
      });
      expect(effectsOf(page).scroll.y).toBeGreaterThan(0);
      await expect
        .poll(async () =>
          Number(
            await readLab(
              electronApp,
              url,
              'browser-lab-scroll-status',
              'data-browser-lab-scroll-y',
            ),
          ),
        )
        .toBeGreaterThan(0);

      // A virtualized list: rows past the first window render.
      const virtual = await run({
        type: 'browser.scroll',
        direction: 'down',
        pages: 3,
        locator: selector('browser-lab-scroll-virtual-viewport'),
      });
      expect(virtual.ok, JSON.stringify(virtual)).toBe(true);
      expect(effectsOf(virtual)?.scroll).toMatchObject({
        container: 'element',
        axis: 'y',
        moved: true,
      });
      await expect
        .poll(async () =>
          Number(
            await readLab(
              electronApp,
              url,
              'browser-lab-scroll-virtual-status',
              'data-browser-lab-first-row',
            ),
          ),
        )
        .toBeGreaterThan(0);

      // Infinite scroll: scrolling to the end of the loaded items loads more.
      const before = Number(
        await readLab(
          electronApp,
          url,
          'browser-lab-scroll-infinite-status',
          'data-browser-lab-item-count',
        ),
      );
      let grew = false;
      for (let attempt = 0; attempt < 6 && !grew; attempt += 1) {
        const infinite = await run({
          type: 'browser.scroll',
          direction: 'down',
          pages: 10,
          locator: selector('browser-lab-scroll-infinite-viewport'),
        });
        expect(infinite.ok, JSON.stringify(infinite)).toBe(true);
        expect(effectsOf(infinite)?.scroll?.container).toBe('element');
        const now = Number(
          await readLab(
            electronApp,
            url,
            'browser-lab-scroll-infinite-status',
            'data-browser-lab-item-count',
          ),
        );
        grew = now > before;
      }
      expect(grew).toBe(true);

      // Back to the top: atStart is the axis minimum in either direction.
      const top = await run({
        type: 'browser.scroll',
        direction: 'up',
        pixels: 100_000,
      });
      expect(top.ok, JSON.stringify(top)).toBe(true);
      expect(effectsOf(top)?.scroll).toMatchObject({
        container: 'page',
        atStart: true,
        y: 0,
      });

      // Into view: an off-screen button inside its own scroll container.
      const intoView = await run({
        type: 'browser.scroll',
        intoView: true,
        locator: selector('browser-lab-scroll-offscreen-button'),
      });
      expect(intoView.ok, JSON.stringify(intoView)).toBe(true);
      expect(receiptOf(intoView)?.target?.inViewport).toBe(true);

      // To text: a section far down the page.
      const toText = await run({
        type: 'browser.scroll',
        toText: 'Section 60',
      });
      expect(toText.ok, JSON.stringify(toText)).toBe(true);
      expect(receiptOf(toText)?.target?.inViewport).toBe(true);

      const missing = await run({
        type: 'browser.scroll',
        toText: 'phase05 text that is nowhere on the page',
      });
      expect(missing.ok).toBe(false);
      expect(receiptOf(missing)?.error?.code).toBe('target_not_found');

      // The page title is in the tree but never drawn, so it is not a match.
      expect(
        await inLab(electronApp, url, 'document.title'),
        'the title is one text node that appears nowhere on the page',
      ).toBe('Browser Lab - Scrolling');
      const undrawn = await run({
        type: 'browser.scroll',
        toText: 'Browser Lab - Scrolling',
      });
      expect(undrawn.ok).toBe(false);
      expect(receiptOf(undrawn)?.error?.code).toBe('target_not_found');
    });
  });

  test('phase 05: drag reorders a sortable list, moves an HTML5 card, and sets sliders, through both routes', async () => {
    test.setTimeout(180_000);
    await withBrowser('drag', async ({ run, electronApp, url }) => {
      // Pointer-event sortable list: move the first item below the third.
      const sorted = await run({
        type: 'browser.drag',
        from: { locator: selector('browser-lab-drag-sort-item-a') },
        to: { locator: selector('browser-lab-drag-sort-item-c') },
      });
      expect(sorted.ok, JSON.stringify(sorted)).toBe(true);
      expect(receiptOf(sorted)).toMatchObject({
        kind: 'drag',
        status: 'executed',
        inputMode: 'trusted',
      });
      await expect
        .poll(() =>
          readLab(
            electronApp,
            url,
            'browser-lab-drag-sortable-status',
            'data-browser-lab-order',
          ),
        )
        .not.toBe('a,b,c,d,e');

      // HTML5 board: card a from todo into done.
      const moved = await run({
        type: 'browser.drag',
        from: { locator: selector('browser-lab-drag-card-a') },
        to: { locator: selector('browser-lab-drag-board-done') },
      });
      expect(moved.ok, JSON.stringify(moved)).toBe(true);
      await expect
        .poll(() =>
          readLab(
            electronApp,
            url,
            'browser-lab-drag-board-status',
            'data-browser-lab-board',
          ),
        )
        .toMatch(/done:[^|]*a/);

      // Native range: drag the thumb right by an offset.
      const native = await run({
        type: 'browser.drag',
        from: { locator: selector('browser-lab-drag-native-range') },
        to: { dx: 60, dy: 0 },
      });
      expect(native.ok, JSON.stringify(native)).toBe(true);
      await expect
        .poll(async () =>
          Number(
            await readLab(
              electronApp,
              url,
              'browser-lab-drag-range-status',
              'data-browser-lab-native-range-value',
            ),
          ),
        )
        .not.toBe(50);

      // Custom slider built on pointer events.
      const custom = await run({
        type: 'browser.drag',
        from: { locator: selector('browser-lab-drag-custom-thumb') },
        to: { dx: 80, dy: 0 },
      });
      expect(custom.ok, JSON.stringify(custom)).toBe(true);
      await expect
        .poll(async () =>
          Number(
            await readLab(
              electronApp,
              url,
              'browser-lab-drag-range-status',
              'data-browser-lab-custom-range-value',
            ),
          ),
        )
        .toBeGreaterThan(25);

      // Held modifiers reach the press, the held moves, and the release.
      await inLab(
        electronApp,
        url,
        `(() => { window.__phase05Shift = []; for (const type of ['pointerdown', 'pointermove', 'pointerup']) document.addEventListener(type, (event) => { if (type !== 'pointermove' || event.buttons) window.__phase05Shift.push(type + ':' + event.shiftKey); }, true); })()`,
      );
      const shifted = await run({
        type: 'browser.drag',
        from: { locator: selector('browser-lab-drag-custom-thumb') },
        to: { dx: -30, dy: 0 },
        steps: 3,
        modifiers: ['Shift'],
      });
      expect(shifted.ok, JSON.stringify(shifted)).toBe(true);
      const seen = await inLab(electronApp, url, 'window.__phase05Shift');
      expect(seen).toContain('pointerdown:true');
      expect(seen).toContain('pointermove:true');
      expect(seen).toContain('pointerup:true');
      expect(seen.filter((entry) => entry.endsWith(':false'))).toEqual([]);
    });
  });

  test('phase 05: scroll moves only the container it was asked to move, through both routes', async () => {
    test.setTimeout(120_000);
    await withBrowser('scroll', async ({ run, electronApp, url }) => {
      const scrollTopOf = (testId) =>
        inLab(
          electronApp,
          url,
          `document.querySelector(${JSON.stringify(selector(testId))}).scrollTop`,
        );
      const scrollLeftOf = (testId) =>
        inLab(
          electronApp,
          url,
          `document.querySelector(${JSON.stringify(selector(testId))}).scrollLeft`,
        );
      await inLab(
        electronApp,
        url,
        `document.querySelector(${JSON.stringify(selector('browser-lab-scroll-nested-outer'))}).scrollIntoView({ block: 'center' })`,
      );

      // The inner container sits under the outer one's centre: a wheel there
      // would move the inner one, so the outer one is scrolled with script.
      const outer = await run({
        type: 'browser.scroll',
        direction: 'down',
        pixels: 120,
        locator: selector('browser-lab-scroll-nested-outer'),
      });
      expect(outer.ok, JSON.stringify(outer)).toBe(true);
      expect(effectsOf(outer)?.scroll).toMatchObject({
        container: 'element',
        axis: 'y',
        moved: true,
      });
      expect(await scrollTopOf('browser-lab-scroll-nested-outer')).toBe(
        effectsOf(outer).scroll.y,
      );
      expect(effectsOf(outer).scroll.y).toBeGreaterThan(0);
      expect(await scrollTopOf('browser-lab-scroll-nested-inner')).toBe(0);

      const inner = await run({
        type: 'browser.scroll',
        direction: 'down',
        pixels: 90,
        locator: selector('browser-lab-scroll-nested-inner'),
      });
      expect(inner.ok, JSON.stringify(inner)).toBe(true);
      expect(await scrollTopOf('browser-lab-scroll-nested-inner')).toBe(90);
      expect(effectsOf(inner)?.scroll).toMatchObject({
        container: 'element',
        axis: 'y',
        y: 90,
        moved: true,
        atStart: false,
        atEnd: false,
      });

      // Sideways, on the other axis.
      await inLab(
        electronApp,
        url,
        `document.querySelector(${JSON.stringify(selector('browser-lab-scroll-offscreen-viewport'))}).scrollIntoView({ block: 'center' })`,
      );
      const sideways = await run({
        type: 'browser.scroll',
        direction: 'right',
        pixels: 200,
        locator: selector('browser-lab-scroll-offscreen-viewport'),
      });
      expect(sideways.ok, JSON.stringify(sideways)).toBe(true);
      expect(effectsOf(sideways)?.scroll).toMatchObject({
        container: 'element',
        axis: 'x',
        x: 200,
        moved: true,
        atStart: false,
      });
      expect(await scrollLeftOf('browser-lab-scroll-offscreen-viewport')).toBe(
        200,
      );
      expect(await scrollTopOf('browser-lab-scroll-offscreen-viewport')).toBe(
        0,
      );

      // An element that cannot scroll that way is refused with the reason.
      const fixed = await run({
        type: 'browser.scroll',
        direction: 'down',
        locator: selector('browser-lab-scroll-sticky-header'),
      });
      expect(fixed.ok).toBe(false);
      expect(receiptOf(fixed)).toMatchObject({
        kind: 'scroll',
        status: 'not_executed',
        error: {
          code: 'unsupported_control',
          message:
            'This element does not scroll in that direction. Use browser.scroll without a target to scroll the page.',
        },
      });
    });
  });

  test('phase 05: a recorded drag is one step, without the page events it causes, through both routes', async () => {
    test.setTimeout(120_000);
    await withBrowser('drag', async ({ run }) => {
      const started = await run({ type: 'browser.start_recording' });
      expect(started.ok, JSON.stringify(started)).toBe(true);
      // Dragging a native slider fires input, change, and click on the page,
      // which the page recorder would write as steps of its own.
      const dragged = await run({
        type: 'browser.drag',
        from: { locator: selector('browser-lab-drag-native-range') },
        to: { dx: 60, dy: 0 },
      });
      expect(dragged.ok, JSON.stringify(dragged)).toBe(true);
      const stopped = await run({ type: 'browser.stop_recording' });
      expect(stopped.ok, JSON.stringify(stopped)).toBe(true);
      const recording = stopped.result?.recording;
      expect(
        recording?.steps
          .filter((step) => step.action !== 'goto')
          .map((step) => step.action),
      ).toEqual(['drag']);
      expect(recording?.playwrightScript).toContain('page.mouse.down()');
      expect(recording?.playwrightScript).not.toContain('.fill(');
      // The drag scrolled its source into view before it measured the
      // pointer's start, so the step starts from the source, and the end
      // keeps its distance from the start.
      expect(recording?.playwrightScript).toMatch(
        /const source = .+;\s+await source\.scrollIntoViewIfNeeded\(\);\s+const box = await source\.boundingBox\(\);/,
      );
      expect(recording?.playwrightScript).toMatch(
        /await page\.mouse\.move\(x \+ 60, y, \{ steps: 10 \}\);/,
      );
    });
  });

  // Setup-only content: a chat-style reversed list, a scroller around a slot
  // in an open and in a closed root, and text directly in a shadow root.
  const PHASE05_SCROLL_SETUP = `(() => {
    const main = document.querySelector('main');
    const list = document.createElement('div');
    list.id = 'phase05-reversed';
    list.style.cssText = 'display:flex;flex-direction:column-reverse;height:160px;overflow:auto;border:1px solid #52677d';
    for (let index = 0; index < 40; index += 1) {
      const row = document.createElement('div');
      row.style.cssText = 'flex:none;height:30px';
      row.textContent = 'Reversed message ' + index;
      list.append(row);
    }
    window.__phase05Wrappers = {};
    const hosts = [];
    for (const mode of ['open', 'closed']) {
      const slotted = document.createElement('div');
      slotted.id = 'phase05-slot-' + mode;
      const wrapper = document.createElement('div');
      wrapper.style.cssText = 'height:300px;overflow:auto;border:1px solid #a5541b';
      wrapper.append(document.createElement('slot'));
      slotted.attachShadow({ mode }).append(wrapper);
      const tall = document.createElement('div');
      tall.style.cssText = 'height:1500px';
      tall.textContent = 'Slotted into a ' + mode + ' root';
      slotted.append(tall);
      window.__phase05Wrappers[mode] = wrapper;
      const bare = document.createElement('div');
      bare.id = 'phase05-bare-' + mode;
      bare.style.cssText = 'margin-top:24px;padding:8px';
      bare.attachShadow({ mode }).append('Phase05 bare ' + mode + ' root text', document.createElement('slot'));
      hosts.push(slotted);
      main.append(bare);
    }
    main.prepend(list, ...hosts);
  })()`;

  test('phase 05: a reversed container scrolls up from its resting end, through both routes', async () => {
    test.setTimeout(120_000);
    await withBrowser('scroll', async ({ run, electronApp, url }) => {
      const read = (expression) => inLab(electronApp, url, expression);
      await read(PHASE05_SCROLL_SETUP);
      // A column-reverse list rests at its bottom, offset 0, and scrolls up
      // into negative offsets.
      const maxY = await read(
        `(() => { const list = document.getElementById('phase05-reversed'); return list.scrollHeight - list.clientHeight; })()`,
      );
      expect(maxY).toBeGreaterThan(500);
      const up = await run({
        type: 'browser.scroll',
        direction: 'up',
        pixels: 100,
        locator: '#phase05-reversed',
      });
      expect(up.ok, JSON.stringify(up)).toBe(true);
      expect(effectsOf(up)?.scroll).toMatchObject({
        container: 'element',
        axis: 'y',
        y: maxY - 100,
        maxY,
        moved: true,
        atStart: false,
        atEnd: false,
      });
      expect(
        await read(`document.getElementById('phase05-reversed').scrollTop`),
      ).toBe(-100);
      const top = await run({
        type: 'browser.scroll',
        direction: 'up',
        pixels: 100_000,
        locator: '#phase05-reversed',
      });
      expect(effectsOf(top)?.scroll).toMatchObject({ y: 0, atStart: true });
      expect(
        await read(`document.getElementById('phase05-reversed').scrollTop`),
      ).toBe(-maxY);
    });
  });

  test('phase 05: a page scroll does not wheel a scroller around a slot, through both routes', async () => {
    test.setTimeout(120_000);
    await withBrowser('scroll', async ({ run, electronApp, url }) => {
      const read = (expression) => inLab(electronApp, url, expression);
      await read(PHASE05_SCROLL_SETUP);
      // A wheel over slotted content would move the scroller around its
      // slot, in the host's shadow tree, so the page is scrolled with script.
      for (const mode of ['open', 'closed']) {
        await read(
          `document.getElementById('phase05-slot-${mode}').scrollIntoView({ block: 'center' })`,
        );
        expect(
          await read(
            `document.getElementById('phase05-slot-${mode}').contains(document.elementFromPoint(innerWidth / 2, innerHeight / 2))`,
          ),
          `${mode}: slotted content is under the viewport centre`,
        ).toBe(true);
        const before = await read('document.scrollingElement.scrollTop');
        const scrolled = await run({
          type: 'browser.scroll',
          direction: 'down',
          pixels: 40,
        });
        expect(scrolled.ok, JSON.stringify(scrolled)).toBe(true);
        expect(receiptOf(scrolled), mode).toMatchObject({
          inputMode: 'direct',
          warnings: [
            'Scrolled with script: the pointer would have scrolled another element.',
          ],
        });
        expect(await read('document.scrollingElement.scrollTop'), mode).toBe(
          before + 40,
        );
        expect(
          await read(`window.__phase05Wrappers.${mode}.scrollTop`),
          mode,
        ).toBe(0);
      }
    });
  });

  test('phase 05: to-text reaches text that sits directly in a shadow root, through both routes', async () => {
    test.setTimeout(120_000);
    await withBrowser('scroll', async ({ run, electronApp, url }) => {
      await inLab(electronApp, url, PHASE05_SCROLL_SETUP);
      for (const mode of ['open', 'closed']) {
        const reached = await run({
          type: 'browser.scroll',
          toText: `Phase05 bare ${mode} root text`,
        });
        expect(reached.ok, `${mode}: ${JSON.stringify(reached)}`).toBe(true);
        expect(receiptOf(reached)?.target, mode).toMatchObject({
          tagName: 'div',
          inViewport: true,
        });
      }
    });
  });

  test('phase 05: a covered hover target is refused and names its cover, through both routes', async () => {
    test.setTimeout(120_000);
    await withBrowser('menus', async ({ run, electronApp, url }) => {
      // Setup-only cover over the hover trigger.
      await inLab(
        electronApp,
        url,
        `(() => { const target = document.querySelector(${JSON.stringify(selector('browser-lab-menus-hover-trigger'))}); target.scrollIntoView({ block: 'center' }); const rect = target.getBoundingClientRect(); const cover = document.createElement('div'); cover.className = 'phase05-hover-cover'; cover.style.cssText = 'position:fixed;z-index:2147483647;background:rgba(0,0,0,.1);left:' + rect.left + 'px;top:' + rect.top + 'px;width:' + rect.width + 'px;height:' + rect.height + 'px'; document.body.append(cover); })()`,
      );
      const before = await readLab(
        electronApp,
        url,
        'browser-lab-menus-hover-status',
        'data-browser-lab-last-action',
      );
      const covered = await run({
        type: 'browser.hover',
        locator: selector('browser-lab-menus-hover-trigger'),
        timeoutMs: 1500,
      });
      expect(covered.ok).toBe(false);
      expect(receiptOf(covered)).toMatchObject({
        kind: 'hover',
        status: 'not_executed',
        error: {
          code: 'target_obscured',
          message: 'The target is covered by div.phase05-hover-cover.',
        },
      });
      // No synthetic fallback: the menu never saw a hover.
      expect(
        await readLab(
          electronApp,
          url,
          'browser-lab-menus-hover-status',
          'data-browser-lab-last-action',
        ),
      ).toBe(before);
      expect(before).not.toBe('opened-hover');
    });
  });

  test('phase 05: to-text scrolls to the text itself inside a tall element, through both routes', async () => {
    test.setTimeout(120_000);
    await withBrowser('scroll', async ({ run, electronApp, url }) => {
      // Setup-only: text deep inside one element far taller than the
      // viewport, whose top is already in view.
      await inLab(
        electronApp,
        url,
        `(() => { const tall = document.createElement('div'); tall.id = 'phase05-tall'; tall.style.cssText = 'height:3200px;padding-top:2600px;box-sizing:border-box;border:1px solid #52677d'; tall.textContent = 'Phase05 deep text'; document.querySelector('main').prepend(tall); window.scrollTo(0, 0); })()`,
      );
      const textInView = () =>
        inLab(
          electronApp,
          url,
          `(() => { const range = document.createRange(); range.selectNodeContents(document.getElementById('phase05-tall').firstChild); const box = range.getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight; })()`,
        );
      expect(await textInView()).toBe(false);
      const reached = await run({
        type: 'browser.scroll',
        toText: 'Phase05 deep text',
      });
      expect(reached.ok, JSON.stringify(reached)).toBe(true);
      expect(effectsOf(reached)?.scroll).toMatchObject({
        container: 'page',
        axis: 'y',
        moved: true,
      });
      expect(await textInView()).toBe(true);
    });
  });

  // Setup-only: a log whose 120 lines are one text node, inside its own
  // scroller, as a <pre> usually is.
  const PHASE05_LOG_SETUP = `(() => { const log = document.createElement('pre'); log.id = 'phase05-log'; log.style.cssText = 'height:160px;overflow:auto;margin:0 0 12px;border:1px solid #52677d'; log.textContent = Array.from({ length: 120 }, (_, index) => 'Log line ' + (index + 1) + ' of the run').join('\\n'); document.querySelector('main').prepend(log); window.scrollTo(0, 0); })()`;
  const PHASE05_LOG_WORDS_IN_VIEW = `(() => { const log = document.getElementById('phase05-log'); const node = log.firstChild; const at = node.data.indexOf('Log line 60 of'); const range = document.createRange(); range.setStart(node, at); range.setEnd(node, at + 14); const words = range.getBoundingClientRect(); const box = log.getBoundingClientRect(); return words.top >= box.top && words.bottom <= box.bottom && words.top >= 0 && words.bottom <= innerHeight; })()`;

  test('phase 05: to-text lands on the matched words inside one large text node, and reports its container, through both routes', async () => {
    test.setTimeout(120_000);
    await withBrowser('scroll', async ({ run, electronApp, url }) => {
      await inLab(electronApp, url, PHASE05_LOG_SETUP);
      expect(await inLab(electronApp, url, PHASE05_LOG_WORDS_IN_VIEW)).toBe(
        false,
      );
      const reached = await run({
        type: 'browser.scroll',
        toText: 'log line 60   OF the run',
      });
      expect(reached.ok, JSON.stringify(reached)).toBe(true);
      expect(await inLab(electronApp, url, PHASE05_LOG_WORDS_IN_VIEW)).toBe(
        true,
      );
      // The element that holds the text is the box that scrolled.
      expect(effectsOf(reached)?.scroll).toMatchObject({
        container: 'element',
        axis: 'y',
        moved: true,
        atStart: false,
      });
      expect(receiptOf(reached)?.target).toMatchObject({ tagName: 'pre' });
    });
  });

  test('phase 05: a recorded to-text scroll replays to the words, through both routes', async () => {
    test.setTimeout(120_000);
    await withBrowser('scroll', async ({ run, electronApp, url }) => {
      await inLab(electronApp, url, PHASE05_LOG_SETUP);
      const started = await run({ type: 'browser.start_recording' });
      expect(started.ok, JSON.stringify(started)).toBe(true);
      const reached = await run({
        type: 'browser.scroll',
        toText: 'Log line 60 of the run',
      });
      expect(reached.ok, JSON.stringify(reached)).toBe(true);
      const stopped = await run({ type: 'browser.stop_recording' });
      expect(stopped.ok, JSON.stringify(stopped)).toBe(true);
      const script = stopped.result?.recording?.playwrightScript ?? '';
      const replay =
        /\.evaluate\((\(element, text\) => \{[\s\S]*\}), "log line 60 of the run"\);/.exec(
          script,
        );
      expect(replay, script).not.toBeNull();
      // Run the recorded step again from the top, as a replay would.
      await inLab(
        electronApp,
        url,
        `(() => { document.getElementById('phase05-log').scrollTop = 0; window.scrollTo(0, 0); })()`,
      );
      expect(await inLab(electronApp, url, PHASE05_LOG_WORDS_IN_VIEW)).toBe(
        false,
      );
      await inLab(
        electronApp,
        url,
        `(${replay[1]})(document.getElementById('phase05-log'), "log line 60 of the run")`,
      );
      expect(await inLab(electronApp, url, PHASE05_LOG_WORDS_IN_VIEW)).toBe(
        true,
      );
    });
  });

  test('phase 05: scrolling an unrendered element into view is refused with the reason, through both routes', async () => {
    test.setTimeout(120_000);
    await withBrowser('scroll', async ({ run, electronApp, url }) => {
      await inLab(
        electronApp,
        url,
        `(() => { const hidden = document.createElement('button'); hidden.id = 'phase05-unrendered'; hidden.style.display = 'none'; hidden.textContent = 'Unrendered'; const wrapper = document.createElement('div'); wrapper.id = 'phase05-contents'; wrapper.style.display = 'contents'; const child = document.createElement('p'); child.id = 'phase05-contents-child'; child.textContent = 'Inside a display: contents wrapper'; wrapper.append(child); const main = document.querySelector('main'); main.prepend(hidden); main.append(wrapper); window.scrollTo(0, 0); })()`,
      );
      // A display: contents wrapper has no box of its own, but its content
      // is laid out, so it scrolls.
      const wrapper = await run({
        type: 'browser.scroll',
        intoView: true,
        locator: '#phase05-contents',
      });
      expect(wrapper.ok, JSON.stringify(wrapper)).toBe(true);
      expect(receiptOf(wrapper)).toMatchObject({ status: 'executed' });
      expect(
        await inLab(
          electronApp,
          url,
          `(() => { const box = document.getElementById('phase05-contents-child').getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight; })()`,
        ),
      ).toBe(true);
      const unrendered = await run({
        type: 'browser.scroll',
        intoView: true,
        locator: '#phase05-unrendered',
      });
      expect(unrendered.ok, JSON.stringify(unrendered)).toBe(false);
      expect(receiptOf(unrendered)).toMatchObject({
        kind: 'scroll',
        status: 'not_executed',
        error: {
          code: 'target_not_visible',
          message:
            'The element is not rendered, so it cannot be scrolled into view.',
        },
      });
    });
  });

  test('phase 05: a label laid over its control is in the way of a hover, not of a click, through both routes', async () => {
    test.setTimeout(120_000);
    await withBrowser('menus', async ({ run, electronApp, url }) => {
      // Setup-only: a floating label positioned over the input it names.
      await inLab(
        electronApp,
        url,
        `(() => { const wrap = document.createElement('div'); wrap.style.cssText = 'position:relative;width:240px;height:40px;margin:12px'; const input = document.createElement('input'); input.id = 'phase05-labelled'; input.style.cssText = 'width:240px;height:40px;box-sizing:border-box'; const label = document.createElement('label'); label.htmlFor = 'phase05-labelled'; label.className = 'phase05-floating-label'; label.textContent = 'Floating label'; label.style.cssText = 'position:absolute;inset:0'; wrap.append(input, label); document.querySelector('main').prepend(wrap); window.scrollTo(0, 0); })()`,
      );
      const hovered = await run({
        type: 'browser.hover',
        locator: '#phase05-labelled',
        timeoutMs: 1500,
      });
      expect(hovered.ok, JSON.stringify(hovered)).toBe(false);
      expect(receiptOf(hovered)).toMatchObject({
        kind: 'hover',
        status: 'not_executed',
        error: {
          code: 'target_obscured',
          message: 'The target is covered by label.phase05-floating-label.',
        },
      });
      // A click on that label is how the control is reached.
      const clicked = await run({
        type: 'browser.click',
        locator: '#phase05-labelled',
      });
      expect(clicked.ok, JSON.stringify(clicked)).toBe(true);
      expect(receiptOf(clicked)).toMatchObject({
        status: 'executed',
        inputMode: 'trusted',
      });
      await expect
        .poll(() => inLab(electronApp, url, 'document.activeElement?.id'))
        .toBe('phase05-labelled');
    });
  });

  test('phase 05: a page scroll over bare <html> uses the wheel, through both routes', async () => {
    test.setTimeout(120_000);
    await withBrowser('scroll', async ({ run, electronApp, url }) => {
      // Setup only: a short body, so the middle of the viewport is the
      // document's root element itself. Chromium reports that element with
      // its own frame's id, as it reports a frame owner with its child's.
      await inLab(
        electronApp,
        url,
        `(() => { for (const child of document.body.children) child.style.display = 'none'; document.documentElement.style.height = '4000px'; window.scrollTo(0, 0); })()`,
      );
      expect(
        await inLab(
          electronApp,
          url,
          `document.elementFromPoint(innerWidth / 2, innerHeight / 2) === document.documentElement`,
        ),
      ).toBe(true);
      const scrolled = await run({ type: 'browser.scroll', direction: 'down' });
      expect(scrolled.ok, JSON.stringify(scrolled)).toBe(true);
      const receipt = receiptOf(scrolled);
      expect(receipt?.inputMode, JSON.stringify(receipt)).toBe('trusted');
      expect(receipt?.warnings ?? []).toEqual([]);
      expect(effectsOf(scrolled)?.scroll).toMatchObject({
        container: 'page',
        axis: 'y',
        moved: true,
      });
    });
  });

  test('phase 05: a recorded hover on an offscreen element replays from the element, through both routes', async () => {
    test.setTimeout(120_000);
    await withBrowser('scroll', async ({ run, electronApp, url }) => {
      // Setup only: a target far below the fold, which the hover scrolls to.
      await inLab(
        electronApp,
        url,
        `(() => { const far = document.createElement('button'); far.id = 'phase05-far'; far.textContent = 'Phase05 far target'; far.style.cssText = 'display:block;margin-top:2600px;width:220px;height:48px'; document.querySelector('main').append(far); window.scrollTo(0, 0); })()`,
      );
      const started = await run({ type: 'browser.start_recording' });
      expect(started.ok, JSON.stringify(started)).toBe(true);
      const hovered = await run({
        type: 'browser.hover',
        locator: '#phase05-far',
      });
      expect(hovered.ok, JSON.stringify(hovered)).toBe(true);
      const stopped = await run({ type: 'browser.stop_recording' });
      expect(stopped.ok, JSON.stringify(stopped)).toBe(true);
      const script = stopped.result?.recording?.playwrightScript ?? '';
      // A bare viewport point would replay over whatever is at that point
      // before anything scrolls.
      expect(script).toMatch(
        /const source = .+;\s+await source\.scrollIntoViewIfNeeded\(\);\s+const box = await source\.boundingBox\(\);/,
      );
      const move =
        /await page\.mouse\.move\(box\.x(?: \+ ([\d.]+))?, box\.y(?: \+ ([\d.]+))?\);/.exec(
          script,
        );
      expect(move, script).not.toBeNull();
      // Run the step's own arithmetic from the top, as a replay would.
      expect(
        await inLab(
          electronApp,
          url,
          `(() => { window.scrollTo(0, 0); const far = document.getElementById('phase05-far'); far.scrollIntoViewIfNeeded(); const box = far.getBoundingClientRect(); return document.elementFromPoint(box.x + ${Number(move[1] ?? 0)}, box.y + ${Number(move[2] ?? 0)}) === far; })()`,
        ),
      ).toBe(true);
    });
  });

  // Setup-only content: a log scaled to twice its size, and words that a box
  // clips and cannot scroll to.
  const PHASE05_SCALED_SETUP = `(() => { const lines = (label) => Array.from({ length: 200 }, (_, index) => label + ' line ' + (index + 1) + ' of the run').join('\\n'); const log = document.createElement('pre'); log.id = 'phase05-scaled'; log.style.cssText = 'height:120px;width:320px;overflow:auto;margin:0 0 160px;transform:scale(2);transform-origin:top left;border:1px solid #52677d'; log.textContent = lines('Scaled'); const clipped = document.createElement('pre'); clipped.id = 'phase05-clipped'; clipped.style.cssText = 'height:120px;overflow:clip;margin:0 0 12px;border:1px solid #a5541b'; clipped.textContent = lines('Clipped'); document.querySelector('main').prepend(log, clipped); window.scrollTo(0, 0); })()`;
  const PHASE05_SCALED_WORDS_IN_VIEW = `(() => { const log = document.getElementById('phase05-scaled'); const node = log.firstChild; const at = node.data.indexOf('Scaled line 100 of'); const range = document.createRange(); range.setStart(node, at); range.setEnd(node, at + 18); const words = range.getBoundingClientRect(); const box = log.getBoundingClientRect(); return words.top >= box.top && words.bottom <= box.bottom && words.top >= 0 && words.bottom <= innerHeight; })()`;
  const STILL_HIDDEN =
    'The matched text is still clipped or out of view after scrolling.';

  test('phase 05: to-text lands on the words in a scaled container, and says when a box still clips them, through both routes', async () => {
    test.setTimeout(120_000);
    await withBrowser('scroll', async ({ run, electronApp, url }) => {
      await inLab(electronApp, url, PHASE05_SCALED_SETUP);
      expect(await inLab(electronApp, url, PHASE05_SCALED_WORDS_IN_VIEW)).toBe(
        false,
      );
      const reached = await run({
        type: 'browser.scroll',
        toText: 'Scaled line 100 of the run',
      });
      expect(reached.ok, JSON.stringify(reached)).toBe(true);
      // One pixel of scroll is two on screen here: the distance measured
      // on screen is twice the distance to scroll.
      expect(await inLab(electronApp, url, PHASE05_SCALED_WORDS_IN_VIEW)).toBe(
        true,
      );
      expect(receiptOf(reached)?.warnings ?? []).not.toContain(STILL_HIDDEN);
      // overflow: clip hides the words and gives nothing to scroll.
      const clipped = await run({
        type: 'browser.scroll',
        toText: 'Clipped line 150 of the run',
      });
      expect(clipped.ok, JSON.stringify(clipped)).toBe(true);
      expect(receiptOf(clipped)?.status).toBe('executed');
      expect(receiptOf(clipped)?.warnings ?? []).toContain(STILL_HIDDEN);
    });
  });

  // Setup-only content: one large text node in a rotated box, and one slotted
  // into a scroller inside an open and inside a closed shadow root.
  const PHASE05_FLAT_SETUP = `(() => { const lines = (label) => Array.from({ length: 200 }, (_, index) => label + ' line ' + (index + 1) + ' of the run').join('\\n'); const rotated = document.createElement('pre'); rotated.id = 'phase05-rotated'; rotated.style.cssText = 'height:160px;width:320px;overflow:auto;margin:120px 0 200px 160px;transform:rotate(90deg)'; rotated.textContent = lines('Rotated'); window.__phase05Boxes = { rotated }; const hosts = []; for (const mode of ['open', 'closed']) { const host = document.createElement('div'); host.id = 'phase05-slotted-' + mode; host.style.cssText = 'white-space:pre;font-family:monospace;margin:0 0 12px'; const wrapper = document.createElement('div'); wrapper.style.cssText = 'height:140px;overflow:auto;border:1px solid #a5541b'; wrapper.append(document.createElement('slot')); host.attachShadow({ mode }).append(wrapper); host.textContent = lines('Slotted ' + mode); window.__phase05Boxes[mode] = wrapper; hosts.push(host); } document.querySelector('main').prepend(rotated, ...hosts); window.scrollTo(0, 0); })()`;
  const phase05WordsShown = (id, key, phrase) =>
    `(() => { const node = document.getElementById(${JSON.stringify(id)}).firstChild; const at = node.data.indexOf(${JSON.stringify(phrase)}); const range = document.createRange(); range.setStart(node, at); range.setEnd(node, at + ${phrase.length}); const words = range.getBoundingClientRect(); const x = (words.left + words.right) / 2, y = (words.top + words.bottom) / 2; const box = window.__phase05Boxes[${JSON.stringify(key)}].getBoundingClientRect(); return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom && x >= 0 && x <= innerWidth && y >= 0 && y <= innerHeight; })()`;

  test('phase 05: to-text lands on words slotted into a scroller in a shadow root, and in a rotated box, through both routes', async () => {
    test.setTimeout(120_000);
    await withBrowser('scroll', async ({ run, electronApp, url }) => {
      await inLab(electronApp, url, PHASE05_FLAT_SETUP);
      // The text is a child of its host, and is laid out in a slot inside a
      // scroller that the host's shadow root owns.
      for (const [id, key, label] of [
        ['phase05-slotted-open', 'open', 'Slotted open'],
        ['phase05-slotted-closed', 'closed', 'Slotted closed'],
        ['phase05-rotated', 'rotated', 'Rotated'],
      ]) {
        const shown = phase05WordsShown(id, key, `${label} line 100 of`);
        expect(await inLab(electronApp, url, shown), id).toBe(false);
        const reached = await run({
          type: 'browser.scroll',
          toText: `${label} line 100 of the run`,
        });
        expect(reached.ok, JSON.stringify(reached)).toBe(true);
        expect(await inLab(electronApp, url, shown), id).toBe(true);
        expect(receiptOf(reached)?.warnings ?? [], id).not.toContain(
          STILL_HIDDEN,
        );
        // The scroller around an open root's slot is seen moving. One in a
        // closed root is not: script cannot follow that slot.
        if (key === 'open')
          expect(effectsOf(reached)?.scroll).toMatchObject({
            container: 'element',
            axis: 'y',
            moved: true,
          });
      }
    });
  });

  // Setup-only content: a frame far below the fold, holding one large text node.
  const PHASE05_FRAME_SETUP = `(() => { const frame = document.createElement('iframe'); frame.id = 'phase05-frame'; frame.title = 'Phase05 framed log'; frame.style.cssText = 'display:block;width:420px;height:300px;margin-top:2600px;border:1px solid #52677d'; frame.srcdoc = '<!doctype html><pre id="log" style="margin:0">' + Array.from({ length: 200 }, (_, index) => 'Framed line ' + (index + 1) + ' of the run').join('\\n') + '</pre>'; document.querySelector('main').append(frame); window.scrollTo(0, 0); return new Promise((resolve) => frame.addEventListener('load', () => resolve(true), { once: true })); })()`;
  const PHASE05_FRAME_WORDS_SHOWN = `(() => { const frame = document.getElementById('phase05-frame'); const node = frame.contentDocument.getElementById('log').firstChild; const at = node.data.indexOf('Framed line 100 of'); const range = frame.contentDocument.createRange(); range.setStart(node, at); range.setEnd(node, at + 18); const words = range.getBoundingClientRect(); const inner = frame.contentWindow; const x = (words.left + words.right) / 2, y = (words.top + words.bottom) / 2; const box = frame.getBoundingClientRect(); const topX = x + box.left + frame.clientLeft, topY = y + box.top + frame.clientTop; return x >= 0 && x <= inner.innerWidth && y >= 0 && y <= inner.innerHeight && topX >= 0 && topX <= innerWidth && topY >= 0 && topY <= innerHeight; })()`;

  test('phase 05: a recorded to-text scroll into a frame below the fold brings the frame into view, through both routes', async () => {
    test.setTimeout(120_000);
    await withBrowser('scroll', async ({ run, electronApp, url }) => {
      expect(await inLab(electronApp, url, PHASE05_FRAME_SETUP)).toBe(true);
      const started = await run({ type: 'browser.start_recording' });
      expect(started.ok, JSON.stringify(started)).toBe(true);
      const reached = await run({
        type: 'browser.scroll',
        toText: 'Framed line 100 of the run',
      });
      expect(reached.ok, JSON.stringify(reached)).toBe(true);
      expect(await inLab(electronApp, url, PHASE05_FRAME_WORDS_SHOWN)).toBe(
        true,
      );
      const stopped = await run({ type: 'browser.stop_recording' });
      expect(stopped.ok, JSON.stringify(stopped)).toBe(true);
      const script = stopped.result?.recording?.playwrightScript ?? '';
      // The words are centred by script that runs inside the frame, which
      // cannot move the page around the frame: the element comes into view
      // first, through its frames.
      const replay =
        /await (.+)\.scrollIntoViewIfNeeded\(\);\s+await (.+)\.evaluate\((\(element, text\) => \{[\s\S]*\}), "framed line 100 of the run"\);/.exec(
          script,
        );
      expect(replay, script).not.toBeNull();
      expect(replay[2]).toBe(replay[1]);
      // Run the recorded step again from the top, as a replay would.
      await inLab(
        electronApp,
        url,
        `(() => { const frame = document.getElementById('phase05-frame'); frame.contentWindow.scrollTo(0, 0); window.scrollTo(0, 0); })()`,
      );
      expect(await inLab(electronApp, url, PHASE05_FRAME_WORDS_SHOWN)).toBe(
        false,
      );
      await inLab(
        electronApp,
        url,
        `(() => { const log = document.getElementById('phase05-frame').contentDocument.getElementById('log'); log.scrollIntoViewIfNeeded(); (${replay[3]})(log, "framed line 100 of the run"); })()`,
      );
      expect(await inLab(electronApp, url, PHASE05_FRAME_WORDS_SHOWN)).toBe(
        true,
      );
    });
  });

  test('phase 05: snapshots report the viewport and scroll position, through both routes', async () => {
    test.setTimeout(120_000);
    await withBrowser('scroll', async ({ run }) => {
      await run({ type: 'browser.scroll', direction: 'down', pixels: 400 });
      const snapshot = await run({ type: 'browser.input_snapshot' });
      expect(snapshot.ok, JSON.stringify(snapshot)).toBe(true);
      const result = snapshot.result?.inputSnapshot;
      expect(result.viewport?.width).toBeGreaterThan(0);
      expect(result.viewport?.height).toBeGreaterThan(0);
      expect(result.scroll?.y).toBeGreaterThan(0);
      expect(result.scroll?.maxY).toBeGreaterThan(result.scroll.y - 1);
    });
  });
});

test.describe('phase 06: form control actions', () => {
  function effectsOf(response) {
    return receiptOf(response)?.effects;
  }

  const propertyOf = (electronApp, url, testId, property) =>
    inLab(
      electronApp,
      url,
      'document.querySelector(' +
        JSON.stringify(selector(testId)) +
        ').' +
        property,
    );

  const selectedValuesOf = (electronApp, url, testId) =>
    inLab(
      electronApp,
      url,
      'Array.from(document.querySelector(' +
        JSON.stringify(selector(testId)) +
        ').selectedOptions, (option) => option.value)',
    );

  async function addSecretMonthSelect(electronApp, url) {
    const added = await inLab(
      electronApp,
      url,
      "(() => { const select = document.createElement('select'); select.setAttribute('autocomplete', 'cc-exp-month'); select.setAttribute('aria-label', 'Secret billing month'); select.dataset.testid = 'phase06-secret-select'; for (const [value, label] of [['phase06-private-value-january', 'Phase06 protected month January'], ['phase06-private-value-february', 'Phase06 protected month February'], ['phase06-private-value-march', 'Phase06 protected month March']]) { const option = document.createElement('option'); option.value = value; option.textContent = label; select.append(option); } document.querySelector('main').prepend(select); return true; })()",
    );
    expect(added).toBe(true);
  }

  test('phase 06 behavior 1: set_checked toggles native, styled, ARIA checkbox, and switch controls without input on a repeat', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      const controls = [
        {
          id: 'browser-lab-controls-checkbox-native',
          status: 'browser-lab-controls-checkbox-native-status',
          aria: false,
        },
        {
          id: 'browser-lab-controls-checkbox-styled',
          status: 'browser-lab-controls-checkbox-styled-status',
          aria: false,
        },
        {
          id: 'browser-lab-controls-checkbox-aria',
          status: 'browser-lab-controls-checkbox-aria-status',
          aria: true,
        },
        {
          id: 'browser-lab-controls-switch-aria',
          status: 'browser-lab-controls-switch-status',
          aria: true,
        },
      ];

      for (const control of controls) {
        const checked = await run({
          type: 'browser.set_checked',
          locator: selector(control.id),
          checked: true,
        });
        expect(checked.ok, JSON.stringify(checked)).toBe(true);
        expect(receiptOf(checked)).toMatchObject({
          kind: 'set_checked',
          status: 'executed',
          inputMode: 'trusted',
          target: { checked: true },
        });
        expect(effectsOf(checked)).toBeDefined();
        await expect
          .poll(() =>
            propertyOf(
              electronApp,
              url,
              control.id,
              control.aria ? "getAttribute('aria-checked')" : 'checked',
            ),
          )
          .toBe(control.aria ? 'true' : true);
        await expect
          .poll(() =>
            readLab(electronApp, url, control.status, 'data-browser-lab-value'),
          )
          .toBe('checked');

        const unchecked = await run({
          type: 'browser.set_checked',
          locator: selector(control.id),
          checked: false,
        });
        expect(unchecked.ok, JSON.stringify(unchecked)).toBe(true);
        expect(receiptOf(unchecked)).toMatchObject({
          status: 'executed',
          target: { checked: false },
        });
        await expect
          .poll(() =>
            propertyOf(
              electronApp,
              url,
              control.id,
              control.aria ? "getAttribute('aria-checked')" : 'checked',
            ),
          )
          .toBe(control.aria ? 'false' : false);
        await expect
          .poll(() =>
            readLab(electronApp, url, control.status, 'data-browser-lab-value'),
          )
          .toBe('unchecked');

        const repeated = await run({
          type: 'browser.set_checked',
          locator: selector(control.id),
          checked: false,
        });
        expect(repeated.ok, JSON.stringify(repeated)).toBe(true);
        expect(receiptOf(repeated)).toMatchObject({
          kind: 'set_checked',
          status: 'executed',
          target: { checked: false },
        });
        expect(receiptOf(repeated)?.inputMode).toBeUndefined();
        expect(effectsOf(repeated)).toBeDefined();
        expect(
          await readLab(
            electronApp,
            url,
            control.status,
            'data-browser-lab-value',
          ),
        ).toBe('unchecked');
      }
    });
  });

  test('phase 06 behavior 2: set_checked selects each radio label style and refuses to uncheck a selected radio', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      // The status lists the choice in every group, so earlier groups stay
      // chosen as the test goes on.
      const radios = [
        {
          id: 'browser-lab-controls-radio-sibling-one',
          name: 'siblingChoice',
          status: 'one||',
        },
        {
          id: 'browser-lab-controls-radio-wrapping-one',
          name: 'wrappingChoice',
          status: 'one|one|',
        },
        {
          id: 'browser-lab-controls-radio-custom-one',
          name: 'customChoice',
          status: 'one|one|one',
        },
      ];
      for (const radio of radios) {
        const checked = await run({
          type: 'browser.set_checked',
          locator: selector(radio.id),
          checked: true,
        });
        expect(checked.ok, JSON.stringify(checked)).toBe(true);
        expect(receiptOf(checked)).toMatchObject({
          kind: 'set_checked',
          status: 'executed',
          target: { checked: true },
        });
        await expect
          .poll(() => propertyOf(electronApp, url, radio.id, 'checked'))
          .toBe(true);
        await expect
          .poll(() =>
            readLab(
              electronApp,
              url,
              'browser-lab-controls-radio-status',
              'data-browser-lab-value',
            ),
          )
          .toBe(radio.status);

        const refused = await run({
          type: 'browser.set_checked',
          locator: selector(radio.id),
          checked: false,
        });
        expect(refused.ok).toBe(false);
        expect(receiptOf(refused)).toMatchObject({
          kind: 'set_checked',
          status: 'not_executed',
          error: {
            code: 'unsupported_control',
            message:
              'A radio button cannot be unchecked. Check another option in its group.',
          },
        });
        expect(receiptOf(refused)?.inputMode).toBeUndefined();
        expect(await propertyOf(electronApp, url, radio.id, 'checked')).toBe(
          true,
        );
      }
    });
  });

  test('phase 06 behavior 3: select_option matches values, case-insensitive labels, indexes, and exact multiple-select sets', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      const single = await run({
        type: 'browser.select_option',
        locator: selector('browser-lab-controls-select-single'),
        values: ['violet'],
      });
      expect(single.ok, JSON.stringify(single)).toBe(true);
      expect(receiptOf(single)).toMatchObject({
        kind: 'select_option',
        status: 'executed',
        inputMode: 'direct',
        target: { selectedOptions: [{ value: 'violet' }] },
      });
      expect(effectsOf(single)).toBeDefined();
      expect(
        await propertyOf(
          electronApp,
          url,
          'browser-lab-controls-select-single',
          'value',
        ),
      ).toBe('violet');
      expect(
        await readLab(
          electronApp,
          url,
          'browser-lab-controls-select-single-status',
          'data-browser-lab-value',
        ),
      ).toBe('violet');

      const multiple = 'browser-lab-controls-select-multiple';
      const firstSet = await run({
        type: 'browser.select_option',
        locator: selector(multiple),
        values: ['red', 'blue'],
      });
      expect(firstSet.ok, JSON.stringify(firstSet)).toBe(true);
      expect(
        receiptOf(firstSet)?.target?.selectedOptions.map(
          (option) => option.value,
        ),
      ).toEqual(['red', 'blue']);
      expect(await selectedValuesOf(electronApp, url, multiple)).toEqual([
        'red',
        'blue',
      ]);
      expect(
        await readLab(
          electronApp,
          url,
          'browser-lab-controls-select-multiple-status',
          'data-browser-lab-value',
        ),
      ).toBe('red,blue');

      const replacementSet = await run({
        type: 'browser.select_option',
        locator: selector(multiple),
        labels: ['GREEN', 'Blue'],
      });
      expect(replacementSet.ok, JSON.stringify(replacementSet)).toBe(true);
      expect(
        receiptOf(replacementSet)?.target?.selectedOptions.map(
          (option) => option.value,
        ),
      ).toEqual(['green', 'blue']);
      expect(await selectedValuesOf(electronApp, url, multiple)).toEqual([
        'green',
        'blue',
      ]);
      expect(
        await readLab(
          electronApp,
          url,
          'browser-lab-controls-select-multiple-status',
          'data-browser-lab-value',
        ),
      ).toBe('green,blue');

      const optgroup = await run({
        type: 'browser.select_option',
        locator: selector('browser-lab-controls-select-optgroup'),
        indexes: [2],
      });
      expect(optgroup.ok, JSON.stringify(optgroup)).toBe(true);
      expect(
        receiptOf(optgroup)?.target?.selectedOptions.map(
          (option) => option.value,
        ),
      ).toEqual(['north-two']);
      expect(
        await propertyOf(
          electronApp,
          url,
          'browser-lab-controls-select-optgroup',
          'value',
        ),
      ).toBe('north-two');
      expect(
        await readLab(
          electronApp,
          url,
          'browser-lab-controls-select-optgroup-status',
          'data-browser-lab-value',
        ),
      ).toBe('north-two');
    });
  });

  test('phase 06 behavior 4: select_option refuses a disabled option before dispatch', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      const response = await run({
        type: 'browser.select_option',
        locator: selector('browser-lab-controls-select-disabled'),
        values: ['disabled'],
      });
      expect(response.ok).toBe(false);
      expect(receiptOf(response)).toMatchObject({
        kind: 'select_option',
        status: 'not_executed',
        error: {
          code: 'target_disabled',
          message: "The option 'Unavailable' is disabled.",
        },
      });
      expect(receiptOf(response)?.inputMode).toBeUndefined();
      expect(
        await propertyOf(
          electronApp,
          url,
          'browser-lab-controls-select-disabled',
          'value',
        ),
      ).toBe('');
      expect(
        await readLab(
          electronApp,
          url,
          'browser-lab-controls-select-disabled-status',
          'data-browser-lab-value',
        ),
      ).toBe('');
    });
  });

  test('phase 06 behavior 5: select_option focuses the untouched lazy select and chooses its asynchronously loaded option', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      expect(
        await propertyOf(
          electronApp,
          url,
          'browser-lab-controls-select-lazy',
          'options.length',
        ),
      ).toBe(1);
      const response = await run({
        type: 'browser.select_option',
        locator: selector('browser-lab-controls-select-lazy'),
        values: ['lazy-two'],
      });
      expect(response.ok, JSON.stringify(response)).toBe(true);
      expect(receiptOf(response)).toMatchObject({
        kind: 'select_option',
        status: 'executed',
        inputMode: 'direct',
        target: { selectedOptions: [{ value: 'lazy-two' }] },
      });
      expect(
        await propertyOf(
          electronApp,
          url,
          'browser-lab-controls-select-lazy',
          'value',
        ),
      ).toBe('lazy-two');
      expect(
        await readLab(
          electronApp,
          url,
          'browser-lab-controls-select-lazy-status',
          'data-browser-lab-value',
        ),
      ).toBe('lazy-two');
    });
  });

  test('phase 06 behavior 6: select_option reports a reverted framework-controlled selection as an executed readback', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      const response = await run({
        type: 'browser.select_option',
        locator: selector('browser-lab-controls-select-revert'),
        values: ['alternate'],
      });
      expect(response.ok, JSON.stringify(response)).toBe(true);
      expect(receiptOf(response)).toMatchObject({
        kind: 'select_option',
        status: 'executed',
        readback: { code: 'state_unchanged' },
        target: { selectedOptions: [{ value: 'stable' }] },
      });
      expect(
        await propertyOf(
          electronApp,
          url,
          'browser-lab-controls-select-revert',
          'value',
        ),
      ).toBe('stable');
    });
  });

  test('phase 06 behavior 7: a missing select value returns option_not_found with the select candidates', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      const response = await run({
        type: 'browser.select_option',
        locator: selector('browser-lab-controls-select-single'),
        values: ['phase06-option-that-does-not-exist'],
      });
      expect(response.ok).toBe(false);
      expect(receiptOf(response)).toMatchObject({
        kind: 'select_option',
        status: 'not_executed',
        error: {
          code: 'option_not_found',
          message: 'No option matched the requested choice.',
          options: expect.arrayContaining([
            expect.objectContaining({ value: 'amber', label: 'Amber' }),
            expect.objectContaining({ value: 'violet', label: 'Violet' }),
          ]),
        },
      });
      expect(
        await propertyOf(
          electronApp,
          url,
          'browser-lab-controls-select-single',
          'value',
        ),
      ).toBe('');
      expect(
        await readLab(
          electronApp,
          url,
          'browser-lab-controls-select-single-status',
          'data-browser-lab-value',
        ),
      ).toBe('');
    });
  });

  test('phase 06 behavior 8: select_option clicks ARIA combobox options and supports searchText', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      await inLab(
        electronApp,
        url,
        '(() => { const input = document.querySelector(' +
          JSON.stringify(selector('browser-lab-controls-combobox-input')) +
          "); window.__phase06TrustedComboClicks = []; input.addEventListener('click', (event) => window.__phase06TrustedComboClicks.push(event.isTrusted)); })()",
      );
      const searched = await run({
        type: 'browser.select_option',
        locator: selector('browser-lab-controls-combobox-input'),
        searchText: 'beta',
        values: ['beta'],
      });
      expect(searched.ok, JSON.stringify(searched)).toBe(true);
      expect(receiptOf(searched)).toMatchObject({
        kind: 'select_option',
        status: 'executed',
        inputMode: 'trusted',
        target: { value: 'Beta' },
      });
      expect(
        await inLab(electronApp, url, 'window.__phase06TrustedComboClicks'),
      ).toEqual([true]);
      await expect
        .poll(() =>
          readLab(
            electronApp,
            url,
            'browser-lab-controls-combobox-status',
            'data-browser-lab-state',
          ),
        )
        .toBe('selected');
      expect(
        await readLab(
          electronApp,
          url,
          'browser-lab-controls-combobox-status',
          'data-browser-lab-value',
        ),
      ).toBe('beta');
      expect(
        await propertyOf(
          electronApp,
          url,
          'browser-lab-controls-combobox-input',
          'value',
        ),
      ).toBe('Beta');
    });
  });

  test('phase 06 behavior 9: secret selects redact click, missing-option, and successful selection responses', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      await addSecretMonthSelect(electronApp, url);
      const target = selector('phase06-secret-select');
      const clicked = await run({ type: 'browser.click', locator: target });
      expect(clicked.ok).toBe(false);
      expect(receiptOf(clicked)).toMatchObject({
        kind: 'click',
        status: 'not_executed',
        error: {
          code: 'unsupported_control',
          candidatesRedacted: true,
        },
      });
      expect(receiptOf(clicked)?.error).not.toHaveProperty('options');

      const missing = await run({
        type: 'browser.select_option',
        locator: target,
        values: ['phase06-private-value-missing'],
      });
      expect(missing.ok).toBe(false);
      expect(receiptOf(missing)).toMatchObject({
        kind: 'select_option',
        status: 'not_executed',
        error: {
          code: 'option_not_found',
          candidatesRedacted: true,
        },
      });
      expect(receiptOf(missing)?.error).not.toHaveProperty('options');

      const selected = await run({
        type: 'browser.select_option',
        locator: target,
        values: ['phase06-private-value-february'],
      });
      expect(selected.ok, JSON.stringify(selected)).toBe(true);
      expect(receiptOf(selected)).toMatchObject({
        kind: 'select_option',
        status: 'executed',
        target: { optionsRedacted: true },
      });
      expect(receiptOf(selected)?.target).not.toHaveProperty('selectedOptions');

      const privateOptions = [
        'phase06-private-value-january',
        'phase06-private-value-february',
        'phase06-private-value-march',
        'phase06-private-value-missing',
        'Phase06 protected month January',
        'Phase06 protected month February',
        'Phase06 protected month March',
      ];
      for (const response of [clicked, missing, selected]) {
        const serialized = JSON.stringify(response);
        for (const privateOption of privateOptions)
          expect(serialized).not.toContain(privateOption);
      }
    });
  });

  test('phase 06 behavior 10: fill and click refuse checkable, select, and file controls, including forced clicks', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      await inLab(
        electronApp,
        url,
        "(() => { const input = document.createElement('input'); input.type = 'file'; input.dataset.testid = 'phase06-file-input'; document.querySelector('main').prepend(input); return true; })()",
      );
      const refusals = [
        {
          id: 'browser-lab-controls-checkbox-native',
          next: 'browser.set_checked',
          message:
            'Use browser.set_checked instead of filling a checkbox or radio button.',
        },
        {
          id: 'browser-lab-controls-radio-sibling-one',
          next: 'browser.set_checked',
          message:
            'Use browser.set_checked instead of filling a checkbox or radio button.',
        },
        {
          id: 'browser-lab-controls-select-single',
          next: 'browser.select_option',
          message:
            'Use browser.select_option instead of filling a select, listbox, or non-editable combobox.',
        },
        {
          id: 'phase06-file-input',
          next: 'browser.upload_files',
          message:
            'Use browser.upload_files to attach files to a file input, or browser.request_files to ask the user to choose them.',
        },
      ];
      for (const refusal of refusals) {
        const response = await run({
          type: 'browser.fill',
          locator: selector(refusal.id),
          text: 'not an action',
        });
        expect(response.ok).toBe(false);
        expect(receiptOf(response)).toMatchObject({
          kind: 'fill',
          status: 'not_executed',
          error: {
            code: 'unsupported_control',
            message: refusal.message,
            ...(refusal.next ? { next: refusal.next } : {}),
          },
        });
        if (refusal.next)
          expect(receiptOf(response)?.error?.next).toBe(refusal.next);
        else expect(receiptOf(response)?.error).not.toHaveProperty('next');
      }

      const selectId = 'browser-lab-controls-select-single';
      for (const force of [false, true]) {
        const clicked = await run({
          type: 'browser.click',
          locator: selector(selectId),
          ...(force ? { force: true } : {}),
        });
        expect(clicked.ok).toBe(false);
        expect(receiptOf(clicked)).toMatchObject({
          kind: 'click',
          status: 'not_executed',
          error: {
            code: 'unsupported_control',
            message: 'Use browser.select_option to choose an option.',
            next: 'browser.select_option',
            options: expect.arrayContaining([
              expect.objectContaining({ value: 'violet', label: 'Violet' }),
            ]),
          },
        });
      }

      const fileClick = await run({
        type: 'browser.click',
        locator: selector('phase06-file-input'),
      });
      expect(fileClick.ok).toBe(false);
      expect(receiptOf(fileClick)).toMatchObject({
        kind: 'click',
        status: 'not_executed',
        error: {
          code: 'unsupported_control',
          message:
            'Use browser.upload_files to attach files, or browser.request_files to ask the user to choose them.',
          next: 'browser.upload_files',
        },
      });
      const forcedFileClick = await run({
        type: 'browser.click',
        locator: selector('phase06-file-input'),
        force: true,
      });
      expect(forcedFileClick.ok).toBe(false);
      expect(receiptOf(forcedFileClick)).toMatchObject({
        status: 'not_executed',
        error: {
          code: 'unsupported_control',
          message:
            'Use browser.upload_files to attach files, or browser.request_files to ask the user to choose them.',
          next: 'browser.upload_files',
        },
      });
      expect(await propertyOf(electronApp, url, selectId, 'value')).toBe('');
      expect(
        await propertyOf(
          electronApp,
          url,
          'browser-lab-controls-checkbox-native',
          'checked',
        ),
      ).toBe(false);
    });
  });

  test('phase 06 behavior 11: fill sets valid compound controls and reports an invalid date format as readback', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      const fields = [
        ['date', '2026-06-21'],
        ['time', '11:45'],
        ['datetime-local', '2026-01-11T12:30'],
        ['month', '2026-02'],
        ['week', '2026-W10'],
        ['color', '#112233'],
        ['range', '60'],
      ];
      for (const [field, value] of fields) {
        const testId = 'browser-lab-controls-' + field;
        const response = await run({
          type: 'browser.fill',
          locator: selector(testId),
          text: value,
        });
        expect(response.ok, JSON.stringify(response)).toBe(true);
        expect(receiptOf(response)).toMatchObject({
          kind: 'fill',
          status: 'executed',
          target: { value },
        });
        expect(await propertyOf(electronApp, url, testId, 'value')).toBe(value);
        expect(
          await readLab(
            electronApp,
            url,
            'browser-lab-controls-' + field + '-status',
            'data-browser-lab-value',
          ),
        ).toBe(value);
      }

      const badDate = await run({
        type: 'browser.fill',
        locator: selector('browser-lab-controls-date'),
        text: '2026-13-45',
      });
      expect(badDate.ok, JSON.stringify(badDate)).toBe(true);
      expect(receiptOf(badDate)).toMatchObject({
        kind: 'fill',
        status: 'executed',
        readback: { code: 'invalid_format', expectedFormat: 'YYYY-MM-DD' },
        target: { value: '' },
        warnings: ['The value was not accepted. Expected format: YYYY-MM-DD.'],
      });
      expect(
        await propertyOf(
          electronApp,
          url,
          'browser-lab-controls-date',
          'value',
        ),
      ).toBe('');
    });
  });

  test('phase 06 behavior 12: fill falls back to real typing when the untouched sticky input reverts the setter', async () => {
    test.setTimeout(120_000);
    await withBrowser('typing', async ({ run, electronApp, url }) => {
      const text = 'Trusted fallback text';
      const response = await run({
        type: 'browser.fill',
        locator: selector('browser-lab-typing-sticky'),
        text,
      });
      expect(response.ok, JSON.stringify(response)).toBe(true);
      expect(receiptOf(response)).toMatchObject({
        kind: 'fill',
        status: 'executed',
        inputMode: 'trusted',
        target: { value: text },
        warnings: ['The page reverted the value; typed it instead.'],
      });
      expect(
        await propertyOf(
          electronApp,
          url,
          'browser-lab-typing-sticky',
          'value',
        ),
      ).toBe(text);
      expect(
        await readLab(
          electronApp,
          url,
          'browser-lab-typing-sticky-status',
          'data-browser-lab-value',
        ),
      ).toBe(text);
    });
  });

  test('phase 06 behavior 13: fill replaces the prefilled value rather than appending', async () => {
    test.setTimeout(120_000);
    await withBrowser('typing', async ({ run, electronApp, url }) => {
      const text = 'Replacement value';
      const response = await run({
        type: 'browser.fill',
        locator: selector('browser-lab-typing-prefilled'),
        text,
      });
      expect(response.ok, JSON.stringify(response)).toBe(true);
      expect(receiptOf(response)).toMatchObject({
        kind: 'fill',
        status: 'executed',
        target: { value: text },
      });
      expect(
        await propertyOf(
          electronApp,
          url,
          'browser-lab-typing-prefilled',
          'value',
        ),
      ).toBe(text);
      expect(
        await readLab(
          electronApp,
          url,
          'browser-lab-typing-prefilled-status',
          'data-browser-lab-value',
        ),
      ).toBe(text);
    });
  });

  test('phase 06 behavior 14: type sends trusted key events to the masked phone and reads its formatted value', async () => {
    test.setTimeout(120_000);
    await withBrowser('typing', async ({ run, electronApp, url }) => {
      const response = await run({
        type: 'browser.type',
        locator: selector('browser-lab-typing-masked-phone'),
        text: '4155550123',
      });
      expect(response.ok, JSON.stringify(response)).toBe(true);
      expect(receiptOf(response)).toMatchObject({
        kind: 'type',
        status: 'executed',
        inputMode: 'trusted',
        target: { value: '(415) 555-0123' },
      });
      expect(
        await propertyOf(
          electronApp,
          url,
          'browser-lab-typing-masked-phone',
          'value',
        ),
      ).toBe('(415) 555-0123');
      expect(
        await readLab(
          electronApp,
          url,
          'browser-lab-typing-masked-phone-status',
          'data-browser-lab-value',
        ),
      ).toBe('(415) 555-0123');
    });
  });

  test('phase 06 behavior 15: type opens combobox and datalist suggestions without submitting and returns the autocomplete hint', async () => {
    test.setTimeout(120_000);
    await withBrowser('typing', async ({ run, electronApp, url }) => {
      const hint =
        'Wait for suggestions and click one instead of pressing Enter.';
      const combo = await run({
        type: 'browser.type',
        locator: selector('browser-lab-typing-combobox'),
        text: 'Port Lumen',
      });
      expect(combo.ok, JSON.stringify(combo)).toBe(true);
      expect(receiptOf(combo)).toMatchObject({
        kind: 'type',
        status: 'executed',
        inputMode: 'trusted',
        target: { value: 'Port Lumen' },
        warnings: [hint],
      });
      expect(
        await propertyOf(
          electronApp,
          url,
          'browser-lab-typing-combobox',
          "getAttribute('aria-expanded')",
        ),
      ).toBe('true');
      expect(
        await propertyOf(
          electronApp,
          url,
          'browser-lab-typing-combobox-list',
          'textContent',
        ),
      ).toBe('Port Lumen (PLM)');
      expect(
        await readLab(
          electronApp,
          url,
          'browser-lab-typing-combobox-status',
          'data-browser-lab-state',
        ),
      ).toBe('open');

      const datalist = await run({
        type: 'browser.type',
        locator: selector('browser-lab-typing-datalist'),
        text: 'Port',
      });
      expect(datalist.ok, JSON.stringify(datalist)).toBe(true);
      expect(receiptOf(datalist)).toMatchObject({
        kind: 'type',
        status: 'executed',
        inputMode: 'trusted',
        target: { value: 'Port' },
        warnings: [hint],
      });
      expect(
        await propertyOf(
          electronApp,
          url,
          'browser-lab-typing-datalist',
          'value',
        ),
      ).toBe('Port');
      expect(
        await propertyOf(
          electronApp,
          url,
          'browser-lab-typing-datalist-options',
          'options.length',
        ),
      ).toBe(3);
      expect(
        await propertyOf(
          electronApp,
          url,
          'browser-lab-typing-datalist-options',
          'options[0].value',
        ),
      ).toBe('Port Lumen');
      expect(
        await inLab(
          electronApp,
          url,
          'document.activeElement === document.querySelector(' +
            JSON.stringify(selector('browser-lab-typing-datalist')) +
            ')',
        ),
      ).toBe(true);
      expect(
        await readLab(
          electronApp,
          url,
          'browser-lab-typing-datalist-status',
          'data-browser-lab-value',
        ),
      ).toBe('Port');
      expect(
        await propertyOf(
          electronApp,
          url,
          'browser-lab-typing-main',
          'ownerDocument.location.pathname',
        ),
      ).toBe('/browser-lab/typing');
    });
  });

  test('phase 06 behavior 16: untargeted type writes to the element that already has focus', async () => {
    test.setTimeout(120_000);
    await withBrowser('typing', async ({ run, electronApp, url }) => {
      await inLab(
        electronApp,
        url,
        '(() => { const input = document.querySelector(' +
          JSON.stringify(selector('browser-lab-typing-prefilled')) +
          '); input.focus(); input.setSelectionRange(input.value.length, input.value.length); })()',
      );
      const response = await run({
        type: 'browser.type',
        text: ' appended',
      });
      expect(response.ok, JSON.stringify(response)).toBe(true);
      expect(receiptOf(response)).toMatchObject({
        kind: 'type',
        status: 'executed',
        inputMode: 'trusted',
        target: { value: 'Prefilled value appended' },
      });
      expect(
        await propertyOf(
          electronApp,
          url,
          'browser-lab-typing-prefilled',
          'value',
        ),
      ).toBe('Prefilled value appended');
      expect(
        await readLab(
          electronApp,
          url,
          'browser-lab-typing-prefilled-status',
          'data-browser-lab-value',
        ),
      ).toBe('Prefilled value appended');
    });
  });

  test('phase 06 behavior 17: fill leaves plain and model-driven editors with the exact requested text, including two lines', async () => {
    test.setTimeout(120_000);
    await withBrowser('editor', async ({ run, electronApp, url }) => {
      const plainText = 'Plain editor exact text';
      const plain = await run({
        type: 'browser.fill',
        locator: selector('browser-lab-editor-plain'),
        text: plainText,
      });
      expect(plain.ok, JSON.stringify(plain)).toBe(true);
      expect(receiptOf(plain)).toMatchObject({
        kind: 'fill',
        status: 'executed',
        inputMode: 'trusted',
        target: { value: plainText },
      });
      expect(
        await propertyOf(
          electronApp,
          url,
          'browser-lab-editor-plain',
          'textContent',
        ),
      ).toBe(plainText);
      expect(
        await readLab(
          electronApp,
          url,
          'browser-lab-editor-plain-status',
          'data-browser-lab-value',
        ),
      ).toBe(plainText);

      const modelText = 'Model first line\nmodel second line';
      const model = await run({
        type: 'browser.fill',
        locator: selector('browser-lab-editor-model'),
        text: modelText,
      });
      expect(model.ok, JSON.stringify(model)).toBe(true);
      // The receipt reads the editor with a line break between its blocks.
      expect(receiptOf(model)).toMatchObject({
        kind: 'fill',
        status: 'executed',
        inputMode: 'trusted',
        target: { value: modelText },
      });
      expect(receiptOf(model)).not.toHaveProperty('readback');
      expect(receiptOf(model)).not.toHaveProperty('warnings');
      expect(
        await propertyOf(
          electronApp,
          url,
          'browser-lab-editor-model',
          'textContent',
        ),
      ).toBe('Model first linemodel second line');
      expect(
        await readLab(
          electronApp,
          url,
          'browser-lab-editor-model-status',
          'data-browser-lab-model',
        ),
      ).toBe(modelText);
      expect(
        await readLab(
          electronApp,
          url,
          'browser-lab-editor-model-status',
          'data-browser-lab-dropped',
        ),
      ).toBe('2');
    });
  });

  // TinyMCE and similar editors cancel Enter's keydown and insert their own
  // paragraph. A key's text sent as a separate char event is inserted anyway,
  // which left an empty paragraph between the lines.
  test('an editor that handles Enter on keydown gets one line break from type, press, and fill', async () => {
    test.setTimeout(120_000);
    await withBrowser('editor', async ({ run, electronApp, url }) => {
      const added = await inLab(
        electronApp,
        url,
        "(() => { const editor = document.createElement('div'); editor.contentEditable = 'true'; editor.dataset.testid = 'keydown-enter-editor'; editor.setAttribute('aria-label', 'Keydown Enter editor'); editor.innerHTML = '<p><br></p>'; editor.addEventListener('keydown', (event) => { if (event.key !== 'Enter') return; event.preventDefault(); const paragraph = document.createElement('p'); paragraph.append(document.createElement('br')); editor.append(paragraph); const range = document.createRange(); range.setStart(paragraph, 0); range.collapse(true); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); }); document.querySelector('main').prepend(editor); return true; })()",
      );
      expect(added).toBe(true);
      const paragraphs = () =>
        inLab(
          electronApp,
          url,
          'Array.from(document.querySelector(\'[data-testid="keydown-enter-editor"]\').childNodes, (block) => block.textContent)',
        );
      const typed = await run({
        type: 'browser.type',
        locator: selector('keydown-enter-editor'),
        text: 'first\nsecond',
      });
      expect(typed.ok, JSON.stringify(typed)).toBe(true);
      expect(await paragraphs()).toEqual(['first', 'second']);
      const pressed = await run({
        type: 'browser.press',
        locator: selector('keydown-enter-editor'),
        key: 'Enter',
      });
      expect(pressed.ok, JSON.stringify(pressed)).toBe(true);
      expect(await paragraphs()).toEqual(['first', 'second', '']);
      const filled = await run({
        type: 'browser.fill',
        locator: selector('keydown-enter-editor'),
        text: 'one\ntwo',
      });
      expect(filled.ok, JSON.stringify(filled)).toBe(true);
      expect(await paragraphs()).toEqual(['one', 'two']);
    });
  });

  test('type inserts accented, CJK, and astral characters into an input and an editor', async () => {
    test.setTimeout(120_000);
    await withBrowser('editor', async ({ run, electronApp, url }) => {
      const added = await inLab(
        electronApp,
        url,
        "(() => { const input = document.createElement('input'); input.dataset.testid = 'non-ascii-input'; input.setAttribute('aria-label', 'Non-ASCII input'); const editor = document.createElement('div'); editor.contentEditable = 'true'; editor.dataset.testid = 'non-ascii-editor'; editor.setAttribute('aria-label', 'Non-ASCII editor'); document.querySelector('main').prepend(input, editor); return true; })()",
      );
      expect(added).toBe(true);
      const text = 'café 日本 😀 ñ';
      for (const testId of ['non-ascii-input', 'non-ascii-editor']) {
        const typed = await run({
          type: 'browser.type',
          locator: selector(testId),
          text,
        });
        expect(typed.ok, JSON.stringify(typed)).toBe(true);
      }
      expect(
        await inLab(
          electronApp,
          url,
          '[document.querySelector(\'[data-testid="non-ascii-input"]\').value, document.querySelector(\'[data-testid="non-ascii-editor"]\').textContent]',
        ),
      ).toEqual([text, text]);
    });
  });

  // An unparsable selector says so, instead of "not found", which sent
  // agents back to the input snapshot.
  test('an action target with an unparsable CSS locator reports invalid CSS', async () => {
    test.setTimeout(120_000);
    await withBrowser('editor', async ({ run }) => {
      const invalid = await run({
        type: 'browser.hover',
        locator: 'main >> nth=0',
      });
      expect(invalid.ok, JSON.stringify(invalid)).toBe(false);
      expect(JSON.stringify(invalid)).toMatch(/Invalid CSS locator/);
      expect(JSON.stringify(invalid)).not.toMatch(/target_not_found/);
    });
  });

  test('phase 06 behavior 18: fill and type succeed on secret fields without returning their values', async () => {
    test.setTimeout(120_000);
    await withBrowser('typing', async ({ run, electronApp, url }) => {
      const fields = [
        ['password', 'phase06-password-fill', 'phase06-password-typed'],
        ['one-time-code', 'phase06-code-fill', 'phase06-code-typed'],
        ['card-number', 'phase06-number-fill', 'phase06-number-typed'],
        ['card-expiry', 'phase06-expiry-fill', 'phase06-expiry-typed'],
        ['card-cvc', 'phase06-cvc-fill', 'phase06-cvc-typed'],
      ];
      for (const [name, fillText, typedText] of fields) {
        const id = 'browser-lab-typing-secret-' + name;
        const fill = await run({
          type: 'browser.fill',
          locator: selector(id),
          text: fillText,
        });
        expect(fill.ok, JSON.stringify(fill)).toBe(true);
        expect(receiptOf(fill)).toMatchObject({
          kind: 'fill',
          status: 'executed',
          target: { valueRedacted: true },
        });
        expect(receiptOf(fill)?.target).not.toHaveProperty('value');
        expect(JSON.stringify(fill)).not.toContain(fillText);

        const typed = await run({
          type: 'browser.type',
          locator: selector(id),
          text: typedText,
        });
        expect(typed.ok, JSON.stringify(typed)).toBe(true);
        expect(receiptOf(typed)).toMatchObject({
          kind: 'type',
          status: 'executed',
          inputMode: 'trusted',
          target: { valueRedacted: true },
        });
        expect(receiptOf(typed)?.target).not.toHaveProperty('value');
        const serialized = JSON.stringify(typed);
        expect(serialized).not.toContain(fillText);
        expect(serialized).not.toContain(typedText);

        expect(await propertyOf(electronApp, url, id, 'value')).toBe(
          fillText + typedText,
        );
        expect(
          await readLab(
            electronApp,
            url,
            'browser-lab-typing-secret-' + name + '-status',
            'data-browser-lab-length',
          ),
        ).toBe(String((fillText + typedText).length));
      }
    });
  });

  test('phase 06 behavior 19: recording writes one check, uncheck, multi-select, and editor-fill step without a secret value', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      await inLab(
        electronApp,
        url,
        "(() => { const editor = document.createElement('div'); editor.contentEditable = 'true'; editor.dataset.testid = 'phase06-recording-editor'; editor.textContent = 'Starting editor text'; document.querySelector('main').prepend(editor); return true; })()",
      );
      const started = await run({ type: 'browser.start_recording' });
      expect(started.ok, JSON.stringify(started)).toBe(true);

      const checked = await run({
        type: 'browser.set_checked',
        locator: selector('browser-lab-controls-checkbox-native'),
        checked: true,
      });
      expect(checked.ok, JSON.stringify(checked)).toBe(true);
      const unchecked = await run({
        type: 'browser.set_checked',
        locator: selector('browser-lab-controls-checkbox-native'),
        checked: false,
      });
      expect(unchecked.ok, JSON.stringify(unchecked)).toBe(true);
      const selected = await run({
        type: 'browser.select_option',
        locator: selector('browser-lab-controls-select-multiple'),
        values: ['red', 'blue'],
      });
      expect(selected.ok, JSON.stringify(selected)).toBe(true);
      const editorText = 'Recorded editor text';
      const filled = await run({
        type: 'browser.fill',
        locator: selector('phase06-recording-editor'),
        text: editorText,
      });
      expect(filled.ok, JSON.stringify(filled)).toBe(true);
      const secretValue = 'phase06-recording-secret-value';
      const secret = await run({
        type: 'browser.fill',
        locator: selector('browser-lab-controls-secret-password'),
        text: secretValue,
      });
      expect(secret.ok, JSON.stringify(secret)).toBe(true);

      const stopped = await run({ type: 'browser.stop_recording' });
      expect(stopped.ok, JSON.stringify(stopped)).toBe(true);
      const recording = stopped.result?.recording;
      const steps = recording?.steps.filter((step) => step.action !== 'goto');
      // The secret fill is recorded with its value redacted, as before.
      expect(steps?.map((step) => step.action)).toEqual([
        'check',
        'uncheck',
        'select',
        'fill',
        'fill',
      ]);
      expect(steps?.find((step) => step.action === 'select')?.values).toEqual([
        'red',
        'blue',
      ]);
      expect(steps?.[3]).toMatchObject({ action: 'fill', value: editorText });
      expect(steps?.[3]?.locator).toContain('phase06-recording-editor');
      expect(steps?.[4]).toMatchObject({ action: 'fill', valueRedacted: true });
      expect(steps?.[4]?.value).toBeUndefined();
      expect(recording?.playwrightScript).toContain('.check()');
      expect(recording?.playwrightScript).toContain('.uncheck()');
      expect(recording?.playwrightScript).toContain('.selectOption(');
      expect(recording?.playwrightScript).toContain('.fill(');
      expect(JSON.stringify(steps)).not.toContain(secretValue);
      expect(
        await propertyOf(
          electronApp,
          url,
          'phase06-recording-editor',
          'textContent',
        ),
      ).toBe(editorText);
    });
  });

  test('phase 06 behavior 20: input_snapshot exposes checked, select, multiple, date, required, and redacted secret-select fields', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      await addSecretMonthSelect(electronApp, url);
      await setLabProperty(
        electronApp,
        url,
        'browser-lab-controls-checkbox-native',
        'checked',
        false,
      );
      const response = await run({
        type: 'browser.input_snapshot',
        limit: 100,
      });
      expect(response.ok, JSON.stringify(response)).toBe(true);
      const inputSnapshot = response.result?.inputSnapshot;
      expect(inputSnapshot?.inputs).toEqual(expect.any(Array));
      expect(inputSnapshot?.truncated).toBe(false);

      const rowFor = (name, tagName, inputType) => {
        const rows = inputSnapshot.inputs.filter(
          (item) =>
            item.name === name &&
            item.tagName === tagName &&
            (inputType === undefined || item.inputType === inputType),
        );
        expect(rows, 'snapshot row for ' + name).toHaveLength(1);
        return rows[0];
      };
      const checkbox = rowFor('Native checkbox', 'input', 'checkbox');
      expect(checkbox).toHaveProperty('checked', false);
      const single = rowFor('Single select', 'select');
      expect(single.optionCount).toBe(3);
      expect(single.options).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ value: 'amber', label: 'Amber' }),
          expect.objectContaining({ value: 'violet', label: 'Violet' }),
        ]),
      );
      const multiple = rowFor('Multiple select', 'select');
      expect(multiple.constraints?.multiple).toBe(true);
      const date = rowFor('Date', 'input', 'date');
      expect(date.format).toBe('YYYY-MM-DD');
      const required = rowFor('Required text', 'input', 'text');
      expect(required).toHaveProperty('required', true);
      const secret = rowFor('Secret billing month', 'select');
      expect(secret.optionsRedacted).toBe(true);
      expect(secret.optionCount).toBe(3);
      expect(secret).not.toHaveProperty('options');
    });
  });

  test('phase 06 review: a combobox whose popup unmounts, a combobox in a shadow root, an option with no value, and a blank line in an editor', async () => {
    test.setTimeout(240_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      // Setup only: three lists the Browser Lab page does not have.
      await inLab(
        electronApp,
        url,
        `(() => {
          const main = document.querySelector('main');
          const unmounting = document.createElement('div');
          unmounting.innerHTML =
            '<label>Unmounting city <input role="combobox" aria-controls="review-unmount-list" data-testid="review-unmount-combo"></label>' +
            '<div id="review-unmount-list" role="listbox"><div role="option" data-value="porto" aria-selected="false">Porto</div></div>';
          main.prepend(unmounting);
          unmounting.querySelector('[role="option"]').addEventListener('click', () => {
            unmounting.querySelector('input').value = 'Porto';
            document.getElementById('review-unmount-list').remove();
          });
          const host = document.createElement('div');
          host.dataset.testid = 'review-shadow-host';
          main.prepend(host);
          const root = host.attachShadow({ mode: 'open' });
          root.innerHTML =
            '<label>Shadow city <input role="combobox" aria-controls="review-shadow-list" data-testid="review-shadow-combo"></label>' +
            '<div id="review-shadow-list" role="listbox"><div role="option" data-value="faro" aria-selected="false">Faro</div></div>';
          const shadowOption = root.querySelector('[role="option"]');
          shadowOption.addEventListener('click', () => {
            shadowOption.setAttribute('aria-selected', 'true');
            root.querySelector('[data-testid="review-shadow-combo"]').value = 'Faro';
          });
          const plain = document.createElement('div');
          plain.innerHTML =
            '<div role="listbox" aria-label="Country" data-testid="review-plain-list"><div role="option" aria-selected="false">Portugal</div></div>';
          main.prepend(plain);
          const country = plain.querySelector('[role="option"]');
          country.addEventListener('click', () => country.setAttribute('aria-selected', 'true'));
          return true;
        })()`,
      );

      const unmounted = await run({
        type: 'browser.select_option',
        locator: selector('review-unmount-combo'),
        values: ['porto'],
      });
      expect(unmounted.ok, JSON.stringify(unmounted)).toBe(true);
      expect(receiptOf(unmounted)).toMatchObject({
        kind: 'select_option',
        status: 'executed',
        inputMode: 'trusted',
      });
      expect(receiptOf(unmounted)).not.toHaveProperty('readback');
      expect(
        await propertyOf(electronApp, url, 'review-unmount-combo', 'value'),
      ).toBe('Porto');

      const shadow = await run({
        type: 'browser.select_option',
        locator: selector('review-shadow-combo'),
        values: ['faro'],
      });
      expect(shadow.ok, JSON.stringify(shadow)).toBe(true);
      expect(receiptOf(shadow)).toMatchObject({
        kind: 'select_option',
        status: 'executed',
        target: { selectedOptions: [{ value: 'faro', label: 'Faro' }] },
      });
      expect(receiptOf(shadow)).not.toHaveProperty('readback');
      expect(
        await inLab(
          electronApp,
          url,
          `document.querySelector('[data-testid="review-shadow-host"]').shadowRoot.querySelector('[role="option"]').getAttribute('aria-selected')`,
        ),
      ).toBe('true');

      const plain = await run({
        type: 'browser.select_option',
        locator: selector('review-plain-list'),
        values: ['Portugal'],
      });
      expect(plain.ok, JSON.stringify(plain)).toBe(true);
      expect(receiptOf(plain)).toMatchObject({
        kind: 'select_option',
        status: 'executed',
        target: {
          selectedOptions: [{ value: 'Portugal', label: 'Portugal' }],
        },
      });
    });

    await withBrowser('editor', async ({ run, electronApp, url }) => {
      const text = 'First\n\nThird';
      const filled = await run({
        type: 'browser.fill',
        locator: selector('browser-lab-editor-plain'),
        text,
      });
      expect(filled.ok, JSON.stringify(filled)).toBe(true);
      expect(receiptOf(filled)).toMatchObject({
        kind: 'fill',
        status: 'executed',
        target: { value: text },
      });
      expect(receiptOf(filled)).not.toHaveProperty('readback');
      expect(
        await inLab(
          electronApp,
          url,
          `document.querySelector('[data-testid="browser-lab-editor-plain"]').querySelectorAll('div').length`,
        ),
      ).toBe(2);
    });
  });

  // Setup only: controls the Browser Lab page does not have, for the round 2
  // review findings.
  async function addReviewRound2Controls(electronApp, url) {
    await inLab(
      electronApp,
      url,
      `(() => {
        const box = document.createElement('div');
        box.innerHTML =
          '<form data-testid="review2-form"><label>Street <input name="street" data-testid="review2-street"></label></form>' +
          '<div contenteditable="plaintext-only" role="textbox" aria-label="Plain notes" data-testid="review2-plaintext"></div>' +
          '<label>Open city <input role="combobox" aria-controls="review2-open-list" aria-expanded="true" data-testid="review2-open-combo"></label>' +
          '<div id="review2-open-list" role="listbox"><div role="option" data-value="braga" aria-selected="false">Braga</div></div>' +
          '<label>Popup city <input role="combobox" aria-controls="review2-popup" data-testid="review2-popup-combo"></label>' +
          '<div id="review2-popup"><div role="option" data-value="first" aria-selected="false">First</div><div role="listbox"><div role="option" data-value="evora" aria-selected="false">Evora</div></div></div>' +
          '<label>Reordering <select data-testid="review2-reorder"><option value="a">A</option><option value="b">B</option></select></label>' +
          '<label>Country code <select data-testid="review2-country"><option label="Placeholder">--</option><option label="United States">US</option></select></label>';
        document.querySelector('main').prepend(box);
        const form = box.querySelector('form');
        form.dataset.submits = '0';
        form.addEventListener('submit', (event) => {
          event.preventDefault();
          form.dataset.submits = String(Number(form.dataset.submits) + 1);
        });
        const open = box.querySelector('[data-testid="review2-open-combo"]');
        const openList = box.querySelector('#review2-open-list');
        open.addEventListener('click', () => {
          const isOpen = open.getAttribute('aria-expanded') === 'true';
          open.setAttribute('aria-expanded', isOpen ? 'false' : 'true');
          openList.hidden = isOpen;
        });
        for (const [value, combo] of [['braga', 'review2-open-combo'], ['evora', 'review2-popup-combo']])
          box.querySelector('[data-value="' + value + '"]').addEventListener('click', (event) => {
            event.currentTarget.setAttribute('aria-selected', 'true');
            box.querySelector('[data-testid="' + combo + '"]').value = event.currentTarget.textContent;
          });
        const reorder = box.querySelector('[data-testid="review2-reorder"]');
        let moved = false;
        reorder.addEventListener('focus', () => {
          if (moved) return;
          moved = true;
          reorder.append(reorder.options[0]);
        });
        return true;
      })()`,
    );
  }

  test('phase 06 review round 2: a fill into a single-line input in a form never submits it', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      await addReviewRound2Controls(electronApp, url);
      const filled = await run({
        type: 'browser.fill',
        locator: selector('review2-street'),
        text: 'Main St\nApt 4',
      });
      expect(filled.ok, JSON.stringify(filled)).toBe(true);
      expect(receiptOf(filled)).toMatchObject({
        kind: 'fill',
        status: 'executed',
        inputMode: 'direct',
      });
      expect(receiptOf(filled)).not.toHaveProperty('readback');
      expect(receiptOf(filled)).not.toHaveProperty('warnings');
      expect(
        await readLab(electronApp, url, 'review2-form', 'data-submits'),
      ).toBe('0');
      expect(
        await propertyOf(electronApp, url, 'review2-street', 'value'),
      ).toBe('Main StApt 4');
    });
  });

  test('phase 06 review round 2: a plaintext editor takes each line once', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      await addReviewRound2Controls(electronApp, url);
      const filled = await run({
        type: 'browser.fill',
        locator: selector('review2-plaintext'),
        text: 'ab\ncd',
      });
      expect(filled.ok, JSON.stringify(filled)).toBe(true);
      expect(receiptOf(filled)).toMatchObject({
        kind: 'fill',
        status: 'executed',
        target: { value: 'ab\ncd' },
      });
      expect(receiptOf(filled)).not.toHaveProperty('readback');
      expect(
        await propertyOf(electronApp, url, 'review2-plaintext', 'innerText'),
      ).toBe('ab\ncd');
    });
  });

  test('phase 06 review round 2: a combobox that is already open is not clicked closed', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      await addReviewRound2Controls(electronApp, url);
      const chosen = await run({
        type: 'browser.select_option',
        locator: selector('review2-open-combo'),
        values: ['braga'],
      });
      expect(chosen.ok, JSON.stringify(chosen)).toBe(true);
      expect(receiptOf(chosen)).toMatchObject({
        kind: 'select_option',
        status: 'executed',
        target: { selectedOptions: [{ value: 'braga', label: 'Braga' }] },
      });
      expect(receiptOf(chosen)).not.toHaveProperty('readback');
      expect(
        await readLab(electronApp, url, 'review2-open-combo', 'aria-expanded'),
      ).toBe('true');
    });
  });

  test('phase 06 review round 2: a combobox popup that is not a listbox, with an option outside its inner listbox', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      await addReviewRound2Controls(electronApp, url);
      const chosen = await run({
        type: 'browser.select_option',
        locator: selector('review2-popup-combo'),
        values: ['evora'],
      });
      expect(chosen.ok, JSON.stringify(chosen)).toBe(true);
      expect(receiptOf(chosen)).toMatchObject({
        kind: 'select_option',
        status: 'executed',
        target: { selectedOptions: [{ value: 'evora', label: 'Evora' }] },
      });
      expect(receiptOf(chosen)).not.toHaveProperty('readback');
      expect(
        await inLab(
          electronApp,
          url,
          `document.querySelector('[data-value="first"]').getAttribute('aria-selected')`,
        ),
      ).toBe('false');
    });
  });

  test('phase 06 review round 2: a select whose options reorder on focus gets the requested option', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      await addReviewRound2Controls(electronApp, url);
      const chosen = await run({
        type: 'browser.select_option',
        locator: selector('review2-reorder'),
        values: ['b'],
      });
      expect(chosen.ok, JSON.stringify(chosen)).toBe(true);
      expect(receiptOf(chosen)).toMatchObject({
        kind: 'select_option',
        status: 'executed',
        target: { selectedOptions: [{ value: 'b', label: 'B' }] },
      });
      expect(receiptOf(chosen)).not.toHaveProperty('readback');
      expect(
        await propertyOf(electronApp, url, 'review2-reorder', 'value'),
      ).toBe('b');
    });
  });

  test('phase 06 review round 2: a native option is chosen by the value the snapshot gives it', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      await addReviewRound2Controls(electronApp, url);
      const snapshot = await run({
        type: 'browser.input_snapshot',
        limit: 100,
      });
      expect(snapshot.ok, JSON.stringify(snapshot)).toBe(true);
      // Found by its options: a select's accessible name can include the
      // selected option's text.
      const row = snapshot.result?.inputSnapshot?.inputs.find(
        (item) =>
          item.tagName === 'select' &&
          item.options?.some((option) => option.label === 'United States'),
      );
      expect(row?.options?.[1]).toMatchObject({
        value: 'US',
        label: 'United States',
      });
      const chosen = await run({
        type: 'browser.select_option',
        locator: selector('review2-country'),
        values: [row?.options?.[1]?.value],
      });
      expect(chosen.ok, JSON.stringify(chosen)).toBe(true);
      expect(receiptOf(chosen)).toMatchObject({
        kind: 'select_option',
        status: 'executed',
        target: { selectedOptions: [{ value: 'US', label: 'United States' }] },
      });
    });
  });

  // Setup only: controls the Browser Lab page does not have, for the round 3
  // review findings.
  async function addReviewRound3Controls(electronApp, url) {
    await inLab(
      electronApp,
      url,
      `(() => {
        const box = document.createElement('div');
        box.innerHTML =
          '<div role="combobox" tabindex="0" aria-label="Card" aria-controls="review3-cards" data-testid="review3-card-combo">Choose a card</div><div id="review3-cards"></div>' +
          '<label>Moving <input data-testid="review3-moving"></label>' +
          '<label>Other <input data-testid="review3-other" value="keep me"></label>' +
          '<label>Removing <select multiple data-testid="review3-removing"><option value="a">A</option><option value="b">B</option></select></label>' +
          '<label>Color <input type="color" data-testid="review3-color"></label>' +
          '<label>When <input type="datetime-local" data-testid="review3-datetime"></label>' +
          '<label>Level <input type="range" data-testid="review3-range"></label>';
        document.querySelector('main').prepend(box);
        box.querySelector('[data-testid="review3-card-combo"]').addEventListener('click', () => {
          box.querySelector('#review3-cards').innerHTML =
            '<div role="listbox" autocomplete="cc-number"><div role="option" aria-disabled="true">4111 1111 1111 1111</div></div>';
        });
        const moving = box.querySelector('[data-testid="review3-moving"]');
        const other = box.querySelector('[data-testid="review3-other"]');
        moving.addEventListener('input', (event) => {
          if (event.isTrusted) return;
          moving.value = '';
          other.focus();
        });
        const removing = box.querySelector('[data-testid="review3-removing"]');
        let removed = false;
        removing.addEventListener('focus', () => {
          if (removed) return;
          removed = true;
          removing.querySelector('option[value="b"]').remove();
        });
        return true;
      })()`,
    );
  }

  test('phase 06 review round 3: a secret list that appears when its combobox opens stays out of every message', async () => {
    test.setTimeout(120_000);
    // The named container exists before the combobox opens and is not
    // secret; the secret listbox appears inside it on open.
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      await addReviewRound3Controls(electronApp, url);
      const chosen = await run({
        type: 'browser.select_option',
        locator: selector('review3-card-combo'),
        indexes: [0],
      });
      expect(chosen.ok, JSON.stringify(chosen)).toBe(true);
      expect(receiptOf(chosen)).toMatchObject({
        kind: 'select_option',
        status: 'executed',
        readback: { code: 'state_unchanged' },
      });
      expect(JSON.stringify(chosen)).not.toContain('4111 1111 1111 1111');
    });
  });

  test('phase 06 review round 3: a fill types into its own field when the page moves focus', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      await addReviewRound3Controls(electronApp, url);
      const filled = await run({
        type: 'browser.fill',
        locator: selector('review3-moving'),
        text: 'typed text',
      });
      expect(filled.ok, JSON.stringify(filled)).toBe(true);
      expect(receiptOf(filled)).toMatchObject({
        kind: 'fill',
        status: 'executed',
        inputMode: 'trusted',
      });
      expect(await propertyOf(electronApp, url, 'review3-other', 'value')).toBe(
        'keep me',
      );
      expect(
        await propertyOf(electronApp, url, 'review3-moving', 'value'),
      ).toBe('typed text');
    });
  });

  test('phase 06 review round 3: a multiple select whose requested option is removed reports it', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      await addReviewRound3Controls(electronApp, url);
      const chosen = await run({
        type: 'browser.select_option',
        locator: selector('review3-removing'),
        values: ['a', 'b'],
      });
      expect(chosen.ok, JSON.stringify(chosen)).toBe(true);
      expect(receiptOf(chosen)).toMatchObject({
        kind: 'select_option',
        status: 'executed',
        readback: { code: 'state_unchanged' },
      });
    });
  });

  test('phase 06 review round 3: a color or date-time the browser rewrites is accepted', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      await addReviewRound3Controls(electronApp, url);
      for (const [id, text, stored] of [
        ['review3-color', '#FF0000', '#ff0000'],
        ['review3-datetime', '2026-10-12T09:30:00', '2026-10-12T09:30'],
      ]) {
        const filled = await run({
          type: 'browser.fill',
          locator: selector(id),
          text,
        });
        expect(filled.ok, JSON.stringify(filled)).toBe(true);
        expect(receiptOf(filled)).toMatchObject({
          kind: 'fill',
          status: 'executed',
        });
        expect(receiptOf(filled)).not.toHaveProperty('readback');
        expect(await propertyOf(electronApp, url, id, 'value')).toBe(stored);
      }
    });
  });

  test('phase 06 review round 3: a range without attributes reports its default format', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      await addReviewRound3Controls(electronApp, url);
      const filled = await run({
        type: 'browser.fill',
        locator: selector('review3-range'),
        text: '150',
      });
      expect(filled.ok, JSON.stringify(filled)).toBe(true);
      expect(receiptOf(filled)).toMatchObject({
        kind: 'fill',
        status: 'executed',
        readback: {
          code: 'invalid_format',
          expectedFormat: '0 to 100 in steps of 1',
        },
      });
    });
  });

  test('phase 06 review round 3: an editor keeps a trailing line the fill typed', async () => {
    test.setTimeout(120_000);
    await withBrowser('editor', async ({ run }) => {
      const filled = await run({
        type: 'browser.fill',
        locator: selector('browser-lab-editor-plain'),
        text: 'A\n',
      });
      expect(filled.ok, JSON.stringify(filled)).toBe(true);
      expect(receiptOf(filled)).toMatchObject({
        kind: 'fill',
        status: 'executed',
        target: { value: 'A\n' },
      });
      expect(receiptOf(filled)).not.toHaveProperty('readback');
    });
  });

  // Setup only: controls the Browser Lab page does not have, for the round 4
  // review findings.
  async function addReviewRound4Controls(electronApp, url) {
    await inLab(
      electronApp,
      url,
      `(() => {
        const box = document.createElement('div');
        box.innerHTML =
          '<label>Notes <textarea data-testid="review4-notes"></textarea></label>' +
          '<label>Shrinking <select data-testid="review4-shrinking"><option value="x">X</option><option value="y">Y</option></select></label>' +
          '<label>Search city <input role="combobox" aria-controls="review4-cities" data-testid="review4-search-combo"></label>' +
          '<div id="review4-cities" role="listbox"><div role="option" data-value="porto" aria-selected="false">Porto</div></div>' +
          '<label>Other <input data-testid="review4-other" value="original"></label>' +
          '<label data-testid="review4-agree-label">I agree to the <a href="#terms" data-testid="review4-terms">terms</a> <input type="checkbox" data-testid="review4-agree"></label>' +
          '<label>Card <select data-testid="review4-card"><option value="">Choose a card</option></select></label>';
        document.querySelector('main').prepend(box);
        const shrinking = box.querySelector('[data-testid="review4-shrinking"]');
        shrinking.dataset.changes = '0';
        shrinking.addEventListener('change', () => {
          shrinking.dataset.changes = String(Number(shrinking.dataset.changes) + 1);
          const y = shrinking.querySelector('option[value="y"]');
          if (y) y.remove();
        });
        // The link stays on the page, so the test can find it by its URL.
        box.querySelector('[data-testid="review4-terms"]').addEventListener('click', (event) => event.preventDefault());
        const other = box.querySelector('[data-testid="review4-other"]');
        box.querySelector('[data-testid="review4-search-combo"]').addEventListener('click', () => other.focus());
        const card = box.querySelector('[data-testid="review4-card"]');
        card.addEventListener('focus', () => {
          if (card.getAttribute('autocomplete')) return;
          card.setAttribute('autocomplete', 'cc-number');
          card.insertAdjacentHTML('beforeend', '<option value="4111111111111111" disabled>4111 1111 1111 1111</option>');
        });
        return true;
      })()`,
    );
  }

  test('phase 06 review round 4: a textarea fill with CRLF line breaks is set once', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      await addReviewRound4Controls(electronApp, url);
      const filled = await run({
        type: 'browser.fill',
        locator: selector('review4-notes'),
        text: 'first\r\nsecond',
      });
      expect(filled.ok, JSON.stringify(filled)).toBe(true);
      expect(receiptOf(filled)).toMatchObject({
        kind: 'fill',
        status: 'executed',
        inputMode: 'direct',
      });
      expect(receiptOf(filled)).not.toHaveProperty('readback');
      expect(await propertyOf(electronApp, url, 'review4-notes', 'value')).toBe(
        'first\nsecond',
      );
    });
  });

  test('phase 06 review round 4: a select whose requested option is removed gets no second attempt', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      await addReviewRound4Controls(electronApp, url);
      const chosen = await run({
        type: 'browser.select_option',
        locator: selector('review4-shrinking'),
        values: ['y'],
      });
      expect(chosen.ok, JSON.stringify(chosen)).toBe(true);
      expect(receiptOf(chosen)).toMatchObject({
        kind: 'select_option',
        status: 'executed',
        readback: { code: 'state_unchanged' },
        warnings: ['The requested option is no longer available.'],
      });
      expect(
        await readLab(electronApp, url, 'review4-shrinking', 'data-changes'),
      ).toBe('1');
    });
  });

  test('phase 06 review round 4: combobox search text is not typed into the field that took focus', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      await addReviewRound4Controls(electronApp, url);
      const chosen = await run({
        type: 'browser.select_option',
        locator: selector('review4-search-combo'),
        values: ['porto'],
        searchText: 'query',
      });
      expect(chosen.ok, JSON.stringify(chosen)).toBe(true);
      expect(receiptOf(chosen)).toMatchObject({
        kind: 'select_option',
        status: 'executed',
        readback: { code: 'state_unchanged' },
      });
      expect(await propertyOf(electronApp, url, 'review4-other', 'value')).toBe(
        'original',
      );
    });
  });

  test('phase 06 review round 4: a click on a link inside a checkbox label is recorded as a click', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      await addReviewRound4Controls(electronApp, url);
      const started = await run({ type: 'browser.start_recording' });
      expect(started.ok, JSON.stringify(started)).toBe(true);
      const clicked = await run({
        type: 'browser.click',
        locator: selector('review4-terms'),
      });
      expect(clicked.ok, JSON.stringify(clicked)).toBe(true);
      const stopped = await run({ type: 'browser.stop_recording' });
      expect(stopped.ok, JSON.stringify(stopped)).toBe(true);
      const steps = stopped.result?.recording?.steps.filter(
        (step) => step.action !== 'goto',
      );
      expect(steps?.map((step) => step.action)).toEqual(['click']);
      expect(
        await propertyOf(electronApp, url, 'review4-agree', 'checked'),
      ).toBe(false);
    });
  });

  test('phase 06 review round 4: a select that becomes secret on focus keeps its labels out of every message', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      await addReviewRound4Controls(electronApp, url);
      const chosen = await run({
        type: 'browser.select_option',
        locator: selector('review4-card'),
        values: ['4111111111111111'],
      });
      expect(chosen.ok, JSON.stringify(chosen)).toBe(true);
      expect(receiptOf(chosen)).toMatchObject({
        kind: 'select_option',
        status: 'executed',
        readback: { code: 'state_unchanged' },
      });
      expect(JSON.stringify(chosen)).not.toContain('4111 1111 1111 1111');
    });
  });

  test('phase 06 review round 5: an editor fill with CRLF line breaks types each line once', async () => {
    test.setTimeout(120_000);
    await withBrowser('editor', async ({ run }) => {
      const filled = await run({
        type: 'browser.fill',
        locator: selector('browser-lab-editor-plain'),
        text: 'first\r\nsecond',
      });
      expect(filled.ok, JSON.stringify(filled)).toBe(true);
      expect(receiptOf(filled)).toMatchObject({
        kind: 'fill',
        status: 'executed',
        target: { value: 'first\nsecond' },
      });
      expect(receiptOf(filled)).not.toHaveProperty('readback');
    });
  });

  test('phase 06 review round 5: an editor fill does not type into the field that took focus while it was cleared', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      // Setup only: an editor whose page moves focus when it is emptied.
      await inLab(
        electronApp,
        url,
        `(() => {
          const box = document.createElement('div');
          box.innerHTML =
            '<div contenteditable="true" role="textbox" aria-label="Review editor" data-testid="review5-editor">old text</div>' +
            '<label>Unrelated <input data-testid="review5-other" value="unrelated"></label>';
          document.querySelector('main').prepend(box);
          const editor = box.querySelector('[data-testid="review5-editor"]');
          const other = box.querySelector('[data-testid="review5-other"]');
          editor.addEventListener('input', (event) => {
            if (!event.isTrusted) other.focus();
          });
          return true;
        })()`,
      );
      const filled = await run({
        type: 'browser.fill',
        locator: selector('review5-editor'),
        text: 'hello',
      });
      expect(filled.ok, JSON.stringify(filled)).toBe(true);
      expect(await propertyOf(electronApp, url, 'review5-other', 'value')).toBe(
        'unrelated',
      );
      expect(
        await propertyOf(electronApp, url, 'review5-editor', 'textContent'),
      ).toBe('hello');
    });
  });

  test('phase 06 review round 5: an index keeps the option it chose when focus reorders the select', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      // Setup only: a select that moves its first option to the end on focus.
      await inLab(
        electronApp,
        url,
        `(() => {
          const box = document.createElement('div');
          box.innerHTML =
            '<label>Letters <select data-testid="review5-letters"><option value="a">A</option><option value="b">B</option><option value="c">C</option></select></label>';
          document.querySelector('main').prepend(box);
          const select = box.querySelector('select');
          select.dataset.changes = '0';
          let moved = false;
          select.addEventListener('focus', () => {
            if (moved) return;
            moved = true;
            select.append(select.options[0]);
          });
          select.addEventListener('change', () => {
            select.dataset.changes = String(Number(select.dataset.changes) + 1);
          });
          return true;
        })()`,
      );
      const chosen = await run({
        type: 'browser.select_option',
        locator: selector('review5-letters'),
        indexes: [1],
      });
      expect(chosen.ok, JSON.stringify(chosen)).toBe(true);
      expect(receiptOf(chosen)).toMatchObject({
        kind: 'select_option',
        status: 'executed',
        target: { selectedOptions: [{ value: 'b', label: 'B' }] },
      });
      expect(receiptOf(chosen)).not.toHaveProperty('readback');
      expect(
        await propertyOf(electronApp, url, 'review5-letters', 'value'),
      ).toBe('b');
      expect(
        await readLab(electronApp, url, 'review5-letters', 'data-changes'),
      ).toBe('1');
    });
  });

  test('phase 06 review round 6: a list that a separate secret control names stays out of every message', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      // Setup only: a card-number field and a plain combobox name the same
      // container; the combobox fills it when opened.
      await inLab(
        electronApp,
        url,
        `(() => {
          const box = document.createElement('div');
          box.innerHTML =
            '<label>Card number <input autocomplete="cc-number" aria-controls="review6-cards"></label>' +
            '<div role="combobox" tabindex="0" aria-label="Saved card" aria-controls="review6-cards" data-testid="review6-combo">Choose a card</div>' +
            '<div id="review6-cards"></div>';
          document.querySelector('main').prepend(box);
          box.querySelector('[data-testid="review6-combo"]').addEventListener('click', () => {
            box.querySelector('#review6-cards').innerHTML =
              '<div role="listbox"><div role="option" aria-disabled="true">4111 1111 1111 1111</div></div>';
          });
          return true;
        })()`,
      );
      const chosen = await run({
        type: 'browser.select_option',
        locator: selector('review6-combo'),
        indexes: [0],
      });
      expect(chosen.ok, JSON.stringify(chosen)).toBe(true);
      expect(receiptOf(chosen)).toMatchObject({
        kind: 'select_option',
        status: 'executed',
        readback: { code: 'state_unchanged' },
      });
      expect(JSON.stringify(chosen)).not.toContain('4111 1111 1111 1111');
    });
  });

  test('phase 06 review round 6: a click keeps a field secret when the page drops its secret marker on focus', async () => {
    test.setTimeout(120_000);
    await withBrowser('typing', async ({ run, electronApp, url }) => {
      // Setup only: the card field holds a number and loses its
      // autocomplete token when focused.
      await inLab(
        electronApp,
        url,
        `(() => {
          const card = document.querySelector('[data-testid="browser-lab-typing-secret-card-number"]');
          card.value = '4111111111111111';
          card.addEventListener('focus', () => card.removeAttribute('autocomplete'));
          return true;
        })()`,
      );
      const clicked = await run({
        type: 'browser.click',
        locator: selector('browser-lab-typing-secret-card-number'),
      });
      expect(clicked.ok, JSON.stringify(clicked)).toBe(true);
      expect(receiptOf(clicked)).toMatchObject({
        kind: 'click',
        status: 'executed',
        target: { valueRedacted: true },
      });
      expect(JSON.stringify(clicked)).not.toContain('4111111111111111');
    });
  });

  test('phase 06 review round 6: a select marked aria-disabled is refused before input', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      // Setup only: one select marked aria-disabled, one inside a marked container.
      await inLab(
        electronApp,
        url,
        `(() => {
          const box = document.createElement('div');
          box.innerHTML =
            '<label>Marked <select aria-disabled="true" data-testid="review6-marked"><option value="a" selected>A</option><option value="b">B</option></select></label>' +
            '<div aria-disabled="true"><label>Inside <select data-testid="review6-inside"><option value="a" selected>A</option><option value="b">B</option></select></label></div>';
          document.querySelector('main').prepend(box);
          return true;
        })()`,
      );
      for (const id of ['review6-marked', 'review6-inside']) {
        const refused = await run({
          type: 'browser.select_option',
          locator: selector(id),
          values: ['b'],
        });
        expect(refused.ok).toBe(false);
        expect(receiptOf(refused)).toMatchObject({
          kind: 'select_option',
          status: 'not_executed',
          error: { code: 'target_disabled' },
        });
        expect(await propertyOf(electronApp, url, id, 'value')).toBe('a');
      }
    });
  });

  test('phase 06 review round 7: a listbox inside a container a secret control names stays out of every message', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      // Setup only: a card-number field names a plain container that holds
      // a listbox of saved cards.
      await inLab(
        electronApp,
        url,
        `(() => {
          const box = document.createElement('div');
          box.innerHTML =
            '<label>Card number <input autocomplete="cc-number" aria-controls="review7-wrap"></label>' +
            '<div id="review7-wrap"><div role="listbox" aria-label="Saved cards" data-testid="review7-cards"><div role="option" aria-disabled="true">4111 1111 1111 1111</div></div></div>';
          document.querySelector('main').prepend(box);
          return true;
        })()`,
      );
      const refused = await run({
        type: 'browser.select_option',
        locator: selector('review7-cards'),
        indexes: [0],
      });
      expect(refused.ok).toBe(false);
      expect(receiptOf(refused)).toMatchObject({
        kind: 'select_option',
        status: 'not_executed',
        error: { code: 'target_disabled' },
      });
      expect(JSON.stringify(refused)).not.toContain('4111 1111 1111 1111');
    });
  });

  test('phase 06 review round 7: a list named by a field that was a password stays out of every message', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      // Setup only: the password field becomes a text field without a secret
      // token and names a container that a plain combobox fills when opened.
      await inLab(
        electronApp,
        url,
        `(() => {
          const password = document.querySelector('[data-testid="browser-lab-controls-secret-password"]');
          password.type = 'text';
          password.removeAttribute('autocomplete');
          password.setAttribute('aria-controls', 'review7-saved');
          const box = document.createElement('div');
          box.innerHTML =
            '<div role="combobox" tabindex="0" aria-label="Saved password" aria-controls="review7-saved" data-testid="review7-combo">Choose one</div>' +
            '<div id="review7-saved"></div>';
          document.querySelector('main').prepend(box);
          box.querySelector('[data-testid="review7-combo"]').addEventListener('click', () => {
            box.querySelector('#review7-saved').innerHTML =
              '<div role="listbox"><div role="option" aria-disabled="true">review7-saved-secret-5150</div></div>';
          });
          return true;
        })()`,
      );
      const chosen = await run({
        type: 'browser.select_option',
        locator: selector('review7-combo'),
        indexes: [0],
      });
      expect(chosen.ok, JSON.stringify(chosen)).toBe(true);
      expect(receiptOf(chosen)).toMatchObject({
        kind: 'select_option',
        status: 'executed',
        readback: { code: 'state_unchanged' },
      });
      expect(JSON.stringify(chosen)).not.toContain('review7-saved-secret-5150');
    });
  });

  test('phase 06 review round 7: a select keeps its selection when focus removes the requested option', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      // Setup only: a select that removes option B when focused.
      await inLab(
        electronApp,
        url,
        `(() => {
          const box = document.createElement('div');
          box.innerHTML =
            '<label>Letters <select data-testid="review7-letters"><option value="a">A</option><option value="b">B</option><option value="c" selected>C</option></select></label>';
          document.querySelector('main').prepend(box);
          const select = box.querySelector('select');
          select.dataset.changes = '0';
          select.addEventListener('focus', () => {
            select.querySelector('option[value="b"]')?.remove();
          });
          select.addEventListener('change', () => {
            select.dataset.changes = String(Number(select.dataset.changes) + 1);
          });
          return true;
        })()`,
      );
      const chosen = await run({
        type: 'browser.select_option',
        locator: selector('review7-letters'),
        values: ['b'],
      });
      expect(chosen.ok, JSON.stringify(chosen)).toBe(true);
      expect(receiptOf(chosen)).toMatchObject({
        kind: 'select_option',
        status: 'executed',
        readback: { code: 'state_unchanged' },
      });
      expect(
        await propertyOf(electronApp, url, 'review7-letters', 'value'),
      ).toBe('c');
      expect(
        await readLab(electronApp, url, 'review7-letters', 'data-changes'),
      ).toBe('0');
    });
  });

  test('phase 06 review round 7: a combobox option is not confirmed by text another option shares', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      // Setup only: two options share a label, and choosing one changes nothing.
      await inLab(
        electronApp,
        url,
        `(() => {
          const box = document.createElement('div');
          box.innerHTML =
            '<div role="combobox" tabindex="0" aria-label="City" aria-controls="review7-cities" data-testid="review7-city">Lisbon</div>' +
            '<div id="review7-cities" role="listbox" aria-label="Cities">' +
            '<div role="option" data-value="lis-1" aria-selected="true" data-testid="review7-lisbon-1">Lisbon</div>' +
            '<div role="option" data-value="lis-2" aria-selected="false" data-testid="review7-lisbon-2">Lisbon</div>' +
            '</div>';
          document.querySelector('main').prepend(box);
          return true;
        })()`,
      );
      const chosen = await run({
        type: 'browser.select_option',
        locator: selector('review7-city'),
        values: ['lis-2'],
      });
      expect(chosen.ok, JSON.stringify(chosen)).toBe(true);
      expect(receiptOf(chosen)).toMatchObject({
        kind: 'select_option',
        status: 'executed',
        readback: { code: 'state_unchanged' },
      });
      expect(
        await readLab(electronApp, url, 'review7-lisbon-2', 'aria-selected'),
      ).toBe('false');
    });
  });

  test('phase 06 review round 8: focus and a targeted press keep a field secret when the page drops its secret marker on focus', async () => {
    test.setTimeout(120_000);
    await withBrowser('typing', async ({ run, electronApp, url }) => {
      const arm = () =>
        // Setup only: the card field holds a number, is not focused, and
        // loses its autocomplete token when focused.
        inLab(
          electronApp,
          url,
          `(() => {
            const card = document.querySelector('[data-testid="browser-lab-typing-secret-card-number"]');
            card.blur();
            card.value = '4111111111111111';
            card.setAttribute('autocomplete', 'cc-number');
            card.addEventListener('focus', () => card.removeAttribute('autocomplete'), { once: true });
            return true;
          })()`,
        );
      for (const command of [
        {
          type: 'browser.focus',
          locator: selector('browser-lab-typing-secret-card-number'),
        },
        {
          type: 'browser.press',
          locator: selector('browser-lab-typing-secret-card-number'),
          key: 'ArrowRight',
        },
      ]) {
        await arm();
        const result = await run(command);
        expect(result.ok, JSON.stringify(result)).toBe(true);
        expect(receiptOf(result)).toMatchObject({
          status: 'executed',
          target: { valueRedacted: true },
        });
        expect(JSON.stringify(result)).not.toContain('4111111111111111');
      }
    });
  });

  test('phase 06 review round 8: a select that its focus handler disables is not changed', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      // Setup only: three selects whose focus handler disables the select,
      // the requested option, or its group.
      await inLab(
        electronApp,
        url,
        `(() => {
          const box = document.createElement('div');
          for (const part of ['select', 'option', 'group']) {
            box.insertAdjacentHTML('beforeend',
              '<label>' + part + ' <select data-testid="review8-' + part + '"><option value="a" selected>A</option><optgroup label="More"><option value="b">B</option></optgroup></select></label>');
          }
          document.querySelector('main').prepend(box);
          for (const part of ['select', 'option', 'group']) {
            const select = box.querySelector('[data-testid="review8-' + part + '"]');
            select.dataset.changes = '0';
            select.addEventListener('focus', () => {
              if (part === 'select') select.disabled = true;
              if (part === 'option') select.querySelector('option[value="b"]').disabled = true;
              if (part === 'group') select.querySelector('optgroup').disabled = true;
            }, { once: true });
            select.addEventListener('change', () => {
              select.dataset.changes = String(Number(select.dataset.changes) + 1);
            });
          }
          return true;
        })()`,
      );
      for (const part of ['select', 'option', 'group']) {
        const id = `review8-${part}`;
        const chosen = await run({
          type: 'browser.select_option',
          locator: selector(id),
          values: ['b'],
        });
        expect(chosen.ok, JSON.stringify(chosen)).toBe(true);
        expect(receiptOf(chosen)).toMatchObject({
          kind: 'select_option',
          status: 'executed',
          readback: { code: 'state_unchanged' },
        });
        expect(await propertyOf(electronApp, url, id, 'value')).toBe('a');
        expect(await readLab(electronApp, url, id, 'data-changes')).toBe('0');
      }
    });
  });

  test('phase 06 review round 8: the select fallback chooses the requested option when its mousedown moves it', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      // Setup only: the first change is reverted, so the fallback runs, and
      // its mousedown moves option B to the end.
      await inLab(
        electronApp,
        url,
        `(() => {
          const box = document.createElement('div');
          box.innerHTML =
            '<label>Letters <select data-testid="review8-moving"><option value="a" selected>A</option><option value="b">B</option><option value="c">C</option></select></label>';
          document.querySelector('main').prepend(box);
          const select = box.querySelector('select');
          select.dataset.changed = '';
          select.addEventListener('change', () => {
            select.dataset.changed += select.value + ',';
            if (select.dataset.changed === 'b,') select.value = 'a';
          });
          select.addEventListener('mousedown', () => {
            select.append(select.querySelector('option[value="b"]'));
          }, { once: true });
          return true;
        })()`,
      );
      const chosen = await run({
        type: 'browser.select_option',
        locator: selector('review8-moving'),
        values: ['b'],
      });
      expect(chosen.ok, JSON.stringify(chosen)).toBe(true);
      expect(receiptOf(chosen)).toMatchObject({
        kind: 'select_option',
        status: 'executed',
        target: { selectedOptions: [{ value: 'b', label: 'B' }] },
      });
      expect(receiptOf(chosen)).not.toHaveProperty('readback');
      expect(
        await readLab(electronApp, url, 'review8-moving', 'data-changed'),
      ).toBe('b,b,');
    });
  });

  test('phase 06 review round 8: a fill refuses an element that inherits contenteditable="false", and keeps its text', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      // Setup only: a span marked contenteditable="inherit" inside a
      // non-editable container.
      await inLab(
        electronApp,
        url,
        `(() => {
          const box = document.createElement('div');
          box.innerHTML =
            '<div contenteditable="false"><span contenteditable="inherit" data-testid="review8-inherit">kept text</span></div>';
          document.querySelector('main').prepend(box);
          return true;
        })()`,
      );
      const filled = await run({
        type: 'browser.fill',
        locator: selector('review8-inherit'),
        text: 'replacement',
      });
      expect(filled.ok).toBe(false);
      expect(receiptOf(filled)).toMatchObject({
        kind: 'fill',
        status: 'not_executed',
        error: { code: 'not_editable' },
      });
      expect(
        await propertyOf(electronApp, url, 'review8-inherit', 'textContent'),
      ).toBe('kept text');
    });
  });

  test('phase 06 review round 9: a control whose list mounts when it opens keeps its options and value', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      // Setup only: a combobox whose list mounts on click, and a field that
      // names a suggestion list the page has not mounted.
      await inLab(
        electronApp,
        url,
        `(() => {
          const box = document.createElement('div');
          box.innerHTML =
            '<div role="combobox" tabindex="0" aria-label="Colour" aria-controls="review9-popup" data-testid="review9-combo">Choose</div>';
          document.querySelector('main').prepend(box);
          box.querySelector('[data-testid="review9-combo"]').addEventListener('click', () => {
            if (document.getElementById('review9-popup')) return;
            box.insertAdjacentHTML('beforeend',
              '<div id="review9-popup" role="listbox"><div role="option" data-value="red">Red</div><div role="option" data-value="green">Green</div></div>');
          });
          const field = document.querySelector('[data-testid="browser-lab-controls-enter-input"]');
          field.setAttribute('aria-controls', 'review9-suggestions');
          field.setAttribute('aria-autocomplete', 'list');
          return true;
        })()`,
      );
      const chosen = await run({
        type: 'browser.select_option',
        locator: selector('review9-combo'),
        values: ['purple'],
      });
      expect(chosen.ok, JSON.stringify(chosen)).toBe(true);
      expect(receiptOf(chosen)).toMatchObject({
        kind: 'select_option',
        status: 'executed',
        readback: { code: 'state_unchanged' },
        target: {
          options: [
            { value: 'red', label: 'Red' },
            { value: 'green', label: 'Green' },
          ],
        },
      });
      expect(receiptOf(chosen).target).not.toHaveProperty('optionsRedacted');

      const filled = await run({
        type: 'browser.fill',
        locator: selector('browser-lab-controls-enter-input'),
        text: 'Lis',
      });
      expect(filled.ok, JSON.stringify(filled)).toBe(true);
      expect(receiptOf(filled)).toMatchObject({
        kind: 'fill',
        status: 'executed',
        target: { value: 'Lis' },
      });
    });
  });

  test('phase 06 review round 9: an option is chosen by the exact value the snapshot gives it', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      // Setup only: two option values that differ only by spaces.
      await inLab(
        electronApp,
        url,
        `(() => {
          const box = document.createElement('div');
          box.innerHTML =
            '<label>Spacing <select data-testid="review9-spaced"><option value="z" selected>Neither</option><option value=" a ">Spaced</option><option value="a">Plain</option></select></label>';
          document.querySelector('main').prepend(box);
          return true;
        })()`,
      );
      const snapshot = await run({
        type: 'browser.input_snapshot',
        limit: 100,
      });
      expect(snapshot.ok, JSON.stringify(snapshot)).toBe(true);
      const row = snapshot.result?.inputSnapshot?.inputs.find(
        (item) =>
          item.tagName === 'select' &&
          item.options?.some((option) => option.label === 'Spaced'),
      );
      const spaced = row?.options?.find((option) => option.label === 'Spaced');
      expect(spaced?.value).toBe(' a ');
      const chosen = await run({
        type: 'browser.select_option',
        locator: selector('review9-spaced'),
        values: [spaced?.value],
      });
      expect(chosen.ok, JSON.stringify(chosen)).toBe(true);
      expect(
        await propertyOf(electronApp, url, 'review9-spaced', 'value'),
      ).toBe(' a ');
    });
  });

  test('phase 06 review round 9: a reverted fill does not focus the field while the user is picking an element', async () => {
    test.setTimeout(120_000);
    await withBrowser(
      'controls',
      async ({
        run,
        electronApp,
        url,
        window,
        browserId,
        expectedRuntimeGeneration,
      }) => {
        // Setup only: a field that reverts every input and refuses focus, so
        // a focus would fall back to a click.
        await inLab(
          electronApp,
          url,
          `(() => {
            const box = document.createElement('div');
            box.innerHTML = '<label>Locked <input data-testid="review9-locked" value="locked"></label>';
            document.querySelector('main').prepend(box);
            const field = box.querySelector('input');
            field.addEventListener('input', () => { field.value = 'locked'; });
            field.addEventListener('focus', () => field.blur());
            return true;
          })()`,
        );
        await window.evaluate(
          (request) => window.api.browser.setPickMode(request),
          { browserId, expectedRuntimeGeneration, enabled: true },
        );
        try {
          const filled = await run({
            type: 'browser.fill',
            locator: selector('review9-locked'),
            text: 'changed',
          });
          expect(filled.ok, JSON.stringify(filled)).toBe(true);
          expect(receiptOf(filled)).toMatchObject({
            kind: 'fill',
            status: 'executed',
            readback: { code: 'state_unchanged' },
          });
          expect(receiptOf(filled).warnings?.[0]).toBe(
            'The page reverted the value. It was not typed instead, because the user is picking an element and focusing the field can take a click.',
          );
          expect(filled.result?.browser?.pickMode).toBe(true);
        } finally {
          await window.evaluate(
            (request) => window.api.browser.setPickMode(request),
            { browserId, expectedRuntimeGeneration, enabled: false },
          );
        }
      },
    );
  });

  test('phase 06 review round 9: an editor that cannot be cleared says so beside its autocomplete hint', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      // Setup only: an autocomplete editor that puts its text back on every
      // input.
      await inLab(
        electronApp,
        url,
        `(() => {
          const box = document.createElement('div');
          box.innerHTML =
            '<div contenteditable="true" role="combobox" aria-autocomplete="list" aria-label="Locked editor" data-testid="review9-editor">locked</div>';
          document.querySelector('main').prepend(box);
          const editor = box.querySelector('[data-testid="review9-editor"]');
          editor.addEventListener('input', () => {
            if (editor.textContent !== 'locked') editor.textContent = 'locked';
          });
          return true;
        })()`,
      );
      const filled = await run({
        type: 'browser.fill',
        locator: selector('review9-editor'),
        text: 'changed',
      });
      expect(filled.ok, JSON.stringify(filled)).toBe(true);
      expect(receiptOf(filled)).toMatchObject({
        kind: 'fill',
        status: 'executed',
        readback: { code: 'state_unchanged' },
      });
      expect(receiptOf(filled).warnings).toContain(
        'The editor could not be cleared before filling it.',
      );
    });
  });

  test('phase 06 review round 10: typing stops when the page moves focus to another field', async () => {
    test.setTimeout(180_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      // Setup only: four targets that move focus to a field of their own on
      // their first trusted input. The fill target also reverts the value the
      // setter gave it, so the fill types it instead.
      await inLab(
        electronApp,
        url,
        `(() => {
          const box = document.createElement('div');
          box.innerHTML =
            '<div contenteditable="true" role="textbox" aria-label="Moving editor" data-testid="review10-editor">old</div>' +
            '<label>Editor other <input data-testid="review10-editor-other" value="original"></label>' +
            '<label>Moving fill <input data-testid="review10-fill"></label>' +
            '<label>Fill other <input data-testid="review10-fill-other" value="original"></label>' +
            '<label>Moving type <input data-testid="review10-type"></label>' +
            '<label>Type other <input data-testid="review10-type-other" value="original"></label>' +
            '<input role="combobox" aria-label="Moving city" aria-controls="review10-cities" data-testid="review10-combo">' +
            '<div id="review10-cities" role="listbox"><div role="option">Lisbon</div></div>' +
            '<label>Combo other <input data-testid="review10-combo-other" value="original"></label>';
          document.querySelector('main').prepend(box);
          for (const name of ['editor', 'fill', 'type', 'combo']) {
            const field = box.querySelector('[data-testid="review10-' + name + '"]');
            const other = box.querySelector('[data-testid="review10-' + name + '-other"]');
            let moved = false;
            field.addEventListener('input', (event) => {
              if (name === 'fill' && !event.isTrusted) field.value = '';
              if (event.isTrusted && !moved) {
                moved = true;
                other.focus();
              }
            });
          }
          return true;
        })()`,
      );
      const actions = [
        {
          name: 'editor',
          command: {
            type: 'browser.fill',
            locator: selector('review10-editor'),
            text: 'abc',
          },
        },
        {
          name: 'fill',
          command: {
            type: 'browser.fill',
            locator: selector('review10-fill'),
            text: 'abc',
          },
        },
        {
          name: 'type',
          command: {
            type: 'browser.type',
            locator: selector('review10-type'),
            text: 'abc',
          },
        },
        {
          name: 'combo',
          command: {
            type: 'browser.select_option',
            locator: selector('review10-combo'),
            labels: ['Lisbon'],
            searchText: 'Lis',
          },
        },
      ];
      for (const { name, command } of actions) {
        const result = await run(command);
        expect.soft(result.ok, `${name}: ${JSON.stringify(result)}`).toBe(true);
        expect
          .soft(receiptOf(result)?.readback, name)
          .toEqual({ code: 'state_unchanged' });
        expect
          .soft(
            await propertyOf(
              electronApp,
              url,
              `review10-${name}-other`,
              'value',
            ),
            name,
          )
          .toBe('original');
      }
    });
  });

  test('phase 06 review round 10: an index request is not confirmed by another option the click selected', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      // Setup only: a click on B moves it to the front and selects A, which
      // is then at the requested index.
      await inLab(
        electronApp,
        url,
        `(() => {
          const box = document.createElement('div');
          box.innerHTML =
            '<div role="listbox" aria-label="Letters" data-testid="review10-list">' +
            '<div role="option" aria-selected="false" data-testid="review10-a">A</div>' +
            '<div role="option" aria-selected="false" data-testid="review10-b">B</div>' +
            '</div>';
          document.querySelector('main').prepend(box);
          const list = box.querySelector('[data-testid="review10-list"]');
          const a = box.querySelector('[data-testid="review10-a"]');
          const b = box.querySelector('[data-testid="review10-b"]');
          b.addEventListener('click', () => {
            list.prepend(b);
            a.setAttribute('aria-selected', 'true');
          });
          return true;
        })()`,
      );
      const chosen = await run({
        type: 'browser.select_option',
        locator: selector('review10-list'),
        indexes: [1],
      });
      expect(chosen.ok, JSON.stringify(chosen)).toBe(true);
      expect(receiptOf(chosen)).toMatchObject({
        kind: 'select_option',
        status: 'executed',
        readback: { code: 'state_unchanged' },
      });
      expect(
        await readLab(electronApp, url, 'review10-b', 'aria-selected'),
      ).toBe('false');
    });
  });

  test('phase 06 review round 11: an editor whose clearing click moves focus does not clear another field', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      // Setup only: the editor rejects the script clear by putting its text
      // back, and its click handler moves focus to a field with content.
      await inLab(
        electronApp,
        url,
        `(() => {
          const box = document.createElement('div');
          box.innerHTML =
            '<div contenteditable="true" role="textbox" aria-label="Locked editor" data-testid="review11-editor">locked text</div>' +
            '<label>Other <input data-testid="review11-other" value="original"></label>';
          document.querySelector('main').prepend(box);
          const editor = box.querySelector('[data-testid="review11-editor"]');
          const other = box.querySelector('[data-testid="review11-other"]');
          editor.addEventListener('input', (event) => {
            if (!event.isTrusted && editor.textContent !== 'locked text')
              editor.textContent = 'locked text';
          });
          editor.addEventListener('click', (event) => {
            if (event.isTrusted) other.focus();
          });
          return true;
        })()`,
      );
      const filled = await run({
        type: 'browser.fill',
        locator: selector('review11-editor'),
        text: 'new',
      });
      expect(filled.ok, JSON.stringify(filled)).toBe(true);
      expect(receiptOf(filled)).toMatchObject({
        kind: 'fill',
        status: 'executed',
        readback: { code: 'state_unchanged' },
      });
      expect(receiptOf(filled).warnings).toContain(
        'The editor lost focus while it was cleared, so the text was not typed.',
      );
      expect(
        await propertyOf(electronApp, url, 'review11-other', 'value'),
      ).toBe('original');
    });
  });

  test('phase 06 review round 11: a native option is chosen by the value the browser gives its text', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      // Setup only: an option without a value attribute whose text has a
      // no-break space, and an option whose value has an ordinary space.
      await inLab(
        electronApp,
        url,
        `(() => {
          const box = document.createElement('div');
          box.innerHTML =
            '<label>Spacing <select data-testid="review11-nbsp"><option value="z" selected>Neither</option><option>A&nbsp;B</option><option value="A B">Plain</option></select></label>';
          document.querySelector('main').prepend(box);
          return true;
        })()`,
      );
      const snapshot = await run({
        type: 'browser.input_snapshot',
        limit: 100,
      });
      expect(snapshot.ok, JSON.stringify(snapshot)).toBe(true);
      const row = snapshot.result?.inputSnapshot?.inputs.find(
        (item) =>
          item.tagName === 'select' &&
          item.options?.some((option) => option.label === 'Plain'),
      );
      const advertised = row?.options?.[1]?.value;
      expect(advertised).toBe('A\u00a0B');
      const chosen = await run({
        type: 'browser.select_option',
        locator: selector('review11-nbsp'),
        values: [advertised],
      });
      expect(chosen.ok, JSON.stringify(chosen)).toBe(true);
      expect(await propertyOf(electronApp, url, 'review11-nbsp', 'value')).toBe(
        'A\u00a0B',
      );
    });
  });

  test('phase 06 review round 11: a checkbox click the page cancels is recorded as a click', async () => {
    test.setTimeout(120_000);
    await withBrowser(
      'controls',
      async ({
        run,
        electronApp,
        url,
        window,
        browserId,
        expectedRuntimeGeneration,
      }) => {
        // Setup only: a checkbox and its label whose clicks the page cancels.
        await inLab(
          electronApp,
          url,
          `(() => {
            const box = document.createElement('div');
            box.innerHTML =
              '<label for="review11-box" data-testid="review11-label">Cancelled box</label><input id="review11-box" type="checkbox" data-testid="review11-box">';
            document.querySelector('main').prepend(box);
            for (const element of box.querySelectorAll('label, input'))
              element.addEventListener('click', (event) => event.preventDefault());
            return true;
          })()`,
        );
        await window.evaluate(
          (request) => window.api.browser.startRecording(request),
          { browserId, expectedRuntimeGeneration },
        );
        for (const id of ['review11-box', 'review11-label']) {
          const clicked = await run({
            type: 'browser.click',
            locator: selector(id),
          });
          expect(clicked.ok, JSON.stringify(clicked)).toBe(true);
        }
        const recording = await window.evaluate(
          (request) => window.api.browser.stopRecording(request),
          { browserId, expectedRuntimeGeneration },
        );
        const actions = recording.steps.map((step) => step.action);
        expect(actions, JSON.stringify(recording.steps)).not.toContain('check');
        expect(actions, JSON.stringify(recording.steps)).toContain('click');
        expect(
          await propertyOf(electronApp, url, 'review11-box', 'checked'),
        ).toBe(false);
      },
    );
  });

  test('phase 06 review round 12: form actions wait for a target that is disabled for a moment', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      // Setup only: a field and a checkbox that enable after 600 ms, and a
      // field that stays disabled.
      await inLab(
        electronApp,
        url,
        `(() => {
          const box = document.createElement('div');
          box.innerHTML =
            '<label>Later <input disabled data-testid="review12-later"></label>' +
            '<label>Later box <input type="checkbox" disabled data-testid="review12-later-box"></label>' +
            '<label>Never <input disabled data-testid="review12-never"></label>';
          document.querySelector('main').prepend(box);
          setTimeout(() => {
            box.querySelector('[data-testid="review12-later"]').disabled = false;
            box.querySelector('[data-testid="review12-later-box"]').disabled = false;
          }, 600);
          return true;
        })()`,
      );
      const filled = await run({
        type: 'browser.fill',
        locator: selector('review12-later'),
        text: 'ready',
        timeoutMs: 5_000,
      });
      expect(filled.ok, JSON.stringify(filled)).toBe(true);
      expect(
        await propertyOf(electronApp, url, 'review12-later', 'value'),
      ).toBe('ready');
      const checked = await run({
        type: 'browser.set_checked',
        locator: selector('review12-later-box'),
        checked: true,
        timeoutMs: 5_000,
      });
      expect(checked.ok, JSON.stringify(checked)).toBe(true);
      expect(
        await propertyOf(electronApp, url, 'review12-later-box', 'checked'),
      ).toBe(true);
      const started = Date.now();
      const refused = await run({
        type: 'browser.fill',
        locator: selector('review12-never'),
        text: 'nope',
        timeoutMs: 800,
      });
      expect(refused.ok).toBe(false);
      expect(receiptOf(refused)).toMatchObject({
        status: 'not_executed',
        error: { code: 'target_disabled' },
      });
      expect(Date.now() - started).toBeGreaterThanOrEqual(700);
    });
  });

  test('phase 06 review round 12: a reverted fill sends nothing after select-all once focus moved', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      // Setup only: the field reverts the setter's value, and its select-all
      // keydown moves focus to a field with content.
      await inLab(
        electronApp,
        url,
        `(() => {
          const box = document.createElement('div');
          box.innerHTML =
            '<label>Reverting <input data-testid="review12-revert" value="kept"></label>' +
            '<label>Unrelated <input data-testid="review12-unrelated" value="unrelated"></label>';
          document.querySelector('main').prepend(box);
          const field = box.querySelector('[data-testid="review12-revert"]');
          const other = box.querySelector('[data-testid="review12-unrelated"]');
          field.addEventListener('input', (event) => {
            if (!event.isTrusted) field.value = 'kept';
          });
          field.addEventListener('keydown', (event) => {
            if (event.key.toLowerCase() === 'a' && (event.metaKey || event.ctrlKey)) other.focus();
          });
          return true;
        })()`,
      );
      for (const text of ['X', '']) {
        const filled = await run({
          type: 'browser.fill',
          locator: selector('review12-revert'),
          text,
        });
        expect(filled.ok, JSON.stringify(filled)).toBe(true);
        expect(receiptOf(filled)).toMatchObject({
          readback: { code: 'state_unchanged' },
        });
        expect(
          await propertyOf(electronApp, url, 'review12-unrelated', 'value'),
        ).toBe('unrelated');
      }
    });
  });

  test('phase 06 review round 12: typing into an input in a closed shadow root types all of it', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      // Setup only: an input inside a closed shadow root, kept reachable for
      // the readback through a main-world reference.
      await inLab(
        electronApp,
        url,
        `(() => {
          const host = document.createElement('div');
          document.querySelector('main').prepend(host);
          const root = host.attachShadow({ mode: 'closed' });
          root.innerHTML = '<label>Closed field <input aria-label="Closed field"></label>';
          window.__review12Closed = root.querySelector('input');
          return true;
        })()`,
      );
      const snapshot = await run({
        type: 'browser.input_snapshot',
        limit: 100,
      });
      expect(snapshot.ok, JSON.stringify(snapshot)).toBe(true);
      const row = snapshot.result?.inputSnapshot?.inputs.find(
        (item) => item.name === 'Closed field',
      );
      expect(
        row?.ref,
        JSON.stringify(snapshot.result?.inputSnapshot?.inputs),
      ).toBeTruthy();
      const typed = await run({
        type: 'browser.type',
        ref: row?.ref,
        text: 'abc',
      });
      expect(typed.ok, JSON.stringify(typed)).toBe(true);
      expect(receiptOf(typed)).not.toHaveProperty('readback');
      expect(
        await inLab(electronApp, url, 'window.__review12Closed.value'),
      ).toBe('abc');
    });
  });

  test('phase 06 review round 12: a container inside a secret list stays out of every message', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      // Setup only: a combobox names a wrapper nested inside a card-number list.
      await inLab(
        electronApp,
        url,
        `(() => {
          const box = document.createElement('div');
          box.innerHTML =
            '<div role="combobox" tabindex="0" aria-label="Card" aria-controls="review12-wrap" data-testid="review12-combo">Choose</div>' +
            '<div role="listbox" autocomplete="cc-number"><div id="review12-wrap"><div role="option">4111 1111 1111 1111</div></div></div>';
          document.querySelector('main').prepend(box);
          return true;
        })()`,
      );
      for (const choice of [{ labels: ['missing card'] }, { indexes: [0] }]) {
        const chosen = await run({
          type: 'browser.select_option',
          locator: selector('review12-combo'),
          ...choice,
        });
        expect(JSON.stringify(chosen)).not.toContain('4111');
      }
    });
  });
  test('phase 06 review round 13: typing into an iframe stops when the page moves focus to the parent document', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      // Setup only: a same-origin iframe whose input moves focus to a parent
      // field on its first trusted input.
      await inLab(
        electronApp,
        url,
        `new Promise((resolve) => {
          const box = document.createElement('div');
          box.innerHTML =
            '<label>Parent field <input data-testid="review13-parent" value="original"></label>' +
            '<iframe data-testid="review13-frame" title="Inner form"></iframe>';
          document.querySelector('main').prepend(box);
          const frame = box.querySelector('iframe');
          const parentField = box.querySelector('[data-testid="review13-parent"]');
          frame.addEventListener('load', () => {
            const input = frame.contentDocument.querySelector('input');
            input.addEventListener('input', (event) => {
              if (event.isTrusted && !input.dataset.moved) {
                input.dataset.moved = 'true';
                parentField.focus();
              }
            });
            resolve(true);
          }, { once: true });
          frame.srcdoc = '<label>Inner <input data-testid="review13-inner" aria-label="Inner"></label>';
        })`,
      );
      const typed = await run({
        type: 'browser.type',
        frame: selector('review13-frame'),
        locator: selector('review13-inner'),
        text: 'abc',
      });
      expect(typed.ok, JSON.stringify(typed)).toBe(true);
      expect(
        await propertyOf(electronApp, url, 'review13-parent', 'value'),
      ).toBe('original');
      expect(receiptOf(typed)).toMatchObject({
        readback: { code: 'state_unchanged' },
      });
    });
  });
  test('phase 06 review round 13: a duplicate list id in another shadow root does not expose a secret list', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      // Setup only: one component's combobox names #options, a wrapper inside
      // its card-number list; another component has an ordinary #options list.
      await inLab(
        electronApp,
        url,
        `(() => {
          const box = document.createElement('div');
          document.querySelector('main').prepend(box);
          const secretHost = document.createElement('div');
          const publicHost = document.createElement('div');
          box.append(secretHost, publicHost);
          secretHost.attachShadow({ mode: 'open' }).innerHTML =
            '<div role="combobox" tabindex="0" aria-label="Saved card" aria-controls="options" data-testid="review13-card-combo">Saved card</div>' +
            '<div role="listbox" autocomplete="cc-number"><div id="options"><div role="option" aria-selected="true">4111 1111 1111 1111</div></div></div>';
          publicHost.attachShadow({ mode: 'open' }).innerHTML =
            '<div id="options" role="listbox" aria-label="Colours"><div role="option">Red</div></div>';
          return true;
        })()`,
      );
      for (const command of [
        { type: 'browser.focus', locator: selector('review13-card-combo') },
        {
          type: 'browser.select_option',
          locator: selector('review13-card-combo'),
          labels: ['missing card'],
        },
      ]) {
        const result = await run(command);
        expect(JSON.stringify(result)).not.toContain('4111 1111 1111 1111');
      }
    });
  });
  test('phase 06 review round 14: a recorded multiline editor fill and type replay as a valid script', async () => {
    test.setTimeout(120_000);
    await withBrowser(
      'editor',
      async ({ run, window, browserId, expectedRuntimeGeneration }) => {
        await window.evaluate(
          (request) => window.api.browser.startRecording(request),
          { browserId, expectedRuntimeGeneration },
        );
        const filled = await run({
          type: 'browser.fill',
          locator: selector('browser-lab-editor-plain'),
          text: 'first\nsecond',
        });
        expect(filled.ok, JSON.stringify(filled)).toBe(true);
        const typed = await run({
          type: 'browser.type',
          locator: selector('browser-lab-editor-plain'),
          text: '\nthird',
        });
        expect(typed.ok, JSON.stringify(typed)).toBe(true);
        const recording = await window.evaluate(
          (request) => window.api.browser.stopRecording(request),
          { browserId, expectedRuntimeGeneration },
        );
        const multiline = recording.steps.filter(
          (step) => typeof step.value === 'string' && step.value.includes('\n'),
        );
        expect(multiline.map((step) => step.action)).toEqual(['fill', 'press']);
        for (const step of recording.steps) {
          expect(
            () =>
              new Function(
                'page',
                `return (async () => { ${step.playwright} });`,
              ),
            step.playwright,
          ).not.toThrow();
        }
      },
    );
  });
  test('phase 06 review round 15: a recorded editor fill or type keeps text out when the editor turns out to be secret', async () => {
    test.setTimeout(120_000);
    await withBrowser(
      'controls',
      async ({
        run,
        electronApp,
        url,
        window,
        browserId,
        expectedRuntimeGeneration,
      }) => {
        // Setup only: an editor that becomes a one-time-code field when
        // focused, and a card-number editing host with an empty child.
        await inLab(
          electronApp,
          url,
          `(() => {
            const box = document.createElement('div');
            box.innerHTML =
              '<div contenteditable="true" role="combobox" aria-label="Code" data-testid="review15-code"></div>' +
              '<div contenteditable="true" autocomplete="cc-number" aria-label="Card" data-testid="review15-card"><span data-testid="review15-card-child"></span></div>';
            document.querySelector('main').prepend(box);
            const code = box.querySelector('[data-testid="review15-code"]');
            code.addEventListener('focus', () => code.setAttribute('autocomplete', 'one-time-code'), { once: true });
            return true;
          })()`,
        );
        await window.evaluate(
          (request) => window.api.browser.startRecording(request),
          { browserId, expectedRuntimeGeneration },
        );
        const typed = await run({
          type: 'browser.type',
          locator: selector('review15-code'),
          text: '987654',
        });
        expect(typed.ok, JSON.stringify(typed)).toBe(true);
        const filled = await run({
          type: 'browser.fill',
          locator: selector('review15-card-child'),
          text: '4111111111111111',
        });
        expect(filled.ok, JSON.stringify(filled)).toBe(true);
        const recording = await window.evaluate(
          (request) => window.api.browser.stopRecording(request),
          { browserId, expectedRuntimeGeneration },
        );
        const recorded = JSON.stringify(recording);
        expect(recorded).not.toContain('987654');
        expect(recorded).not.toContain('4111111111111111');
      },
    );
  });
  test('phase 06 review round 16: input sent to a secret editing host through a child keeps its text out of the receipt and the recording', async () => {
    test.setTimeout(120_000);
    await withBrowser(
      'controls',
      async ({
        run,
        electronApp,
        url,
        window,
        browserId,
        expectedRuntimeGeneration,
      }) => {
        // Setup only: two card-number editing hosts that drop their secret
        // marker when focused, each with a child the actions are aimed at.
        await inLab(
          electronApp,
          url,
          `(() => {
            const box = document.createElement('div');
            box.innerHTML =
              '<div contenteditable="true" autocomplete="cc-number" aria-label="Stored card" data-testid="review16-type-host">TEST-STORED-CARD<span data-testid="review16-type-child"></span></div>' +
              '<div contenteditable="true" autocomplete="cc-number" aria-label="New card" data-testid="review16-fill-host"><span data-testid="review16-fill-child"></span></div>';
            document.querySelector('main').prepend(box);
            for (const host of box.querySelectorAll('[contenteditable]'))
              host.addEventListener('focus', () => host.removeAttribute('autocomplete'), { once: true });
            return true;
          })()`,
        );
        await window.evaluate(
          (request) => window.api.browser.startRecording(request),
          { browserId, expectedRuntimeGeneration },
        );
        const typed = await run({
          type: 'browser.type',
          locator: selector('review16-type-child'),
          text: 'X',
        });
        expect(typed.ok, JSON.stringify(typed)).toBe(true);
        expect(JSON.stringify(typed)).not.toContain('TEST-STORED-CARD');
        const filled = await run({
          type: 'browser.fill',
          locator: selector('review16-fill-child'),
          text: '4111111111111111',
        });
        expect(filled.ok, JSON.stringify(filled)).toBe(true);
        expect(JSON.stringify(filled)).not.toContain('4111111111111111');
        const recording = await window.evaluate(
          (request) => window.api.browser.stopRecording(request),
          { browserId, expectedRuntimeGeneration },
        );
        const recorded = JSON.stringify(recording);
        expect(recorded).not.toContain('TEST-STORED-CARD');
        expect(recorded).not.toContain('4111111111111111');
      },
    );
  });

  test('phase 06 review round 16: a button combobox whose popup unmounts on select reports the choice', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      // Setup only: a button trigger that mounts its list on click; choosing
      // an option sets the button's text and removes the list.
      await inLab(
        electronApp,
        url,
        `(() => {
          const box = document.createElement('div');
          box.innerHTML =
            '<button type="button" role="combobox" aria-label="Size" aria-controls="review16-sizes" data-testid="review16-size">Choose a size</button>';
          document.querySelector('main').prepend(box);
          const trigger = box.querySelector('button');
          trigger.addEventListener('click', () => {
            if (document.getElementById('review16-sizes')) return;
            box.insertAdjacentHTML('beforeend',
              '<div id="review16-sizes" role="listbox"><div role="option" data-value="s">Small</div><div role="option" data-value="l">Large</div></div>');
            for (const option of box.querySelectorAll('[role="option"]'))
              option.addEventListener('click', () => {
                trigger.textContent = option.textContent;
                document.getElementById('review16-sizes').remove();
              });
          });
          return true;
        })()`,
      );
      const chosen = await run({
        type: 'browser.select_option',
        locator: selector('review16-size'),
        labels: ['Large'],
      });
      expect(chosen.ok, JSON.stringify(chosen)).toBe(true);
      expect(receiptOf(chosen)).toMatchObject({
        kind: 'select_option',
        status: 'executed',
      });
      expect(receiptOf(chosen)).not.toHaveProperty('readback');
      expect(
        await propertyOf(electronApp, url, 'review16-size', 'textContent'),
      ).toBe('Large');
    });
  });

  test('phase 06 review round 16: an editor fill with a no-break space is accepted', async () => {
    test.setTimeout(120_000);
    await withBrowser('editor', async ({ run }) => {
      const filled = await run({
        type: 'browser.fill',
        locator: selector('browser-lab-editor-plain'),
        text: '10\u00a0EUR',
      });
      expect(filled.ok, JSON.stringify(filled)).toBe(true);
      expect(receiptOf(filled)).toMatchObject({
        kind: 'fill',
        status: 'executed',
      });
      expect(receiptOf(filled)).not.toHaveProperty('readback');
    });
  });

  test('phase 06 review round 17: inspecting a secret editing host, its child, or its parent never returns its text', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      // Setup only: a card-number editing host that holds a card number,
      // with a child inside it and a wrapper around it.
      await inLab(
        electronApp,
        url,
        `(() => {
          const box = document.createElement('div');
          box.innerHTML =
            '<section data-testid="review17-wrap"><div contenteditable="true" autocomplete="cc-number" aria-label="Card" data-testid="review17-host">4111111111111111<span data-testid="review17-child">4000056655665556</span></div></section>';
          document.querySelector('main').prepend(box);
          return true;
        })()`,
      );
      for (const id of ['review17-host', 'review17-child', 'review17-wrap']) {
        const inspected = await run({
          type: 'browser.inspect',
          locator: selector(id),
        });
        expect(inspected.ok, JSON.stringify(inspected)).toBe(true);
        const sent = JSON.stringify(inspected);
        expect(sent, id).not.toContain('4111111111111111');
        expect(sent, id).not.toContain('4000056655665556');
      }
    });
  });

  test('phase 06 review round 17: a time fill with seconds is compared as the browser stores it', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      // Setup only: time inputs, one of them with seconds in its step.
      await inLab(
        electronApp,
        url,
        `(() => {
          const box = document.createElement('div');
          box.innerHTML =
            '<label>Starts <input type="time" step="1" data-testid="review17-time-seconds"></label>' +
            '<label>Ends <input type="time" data-testid="review17-time"></label>';
          document.querySelector('main').prepend(box);
          return true;
        })()`,
      );
      for (const [id, text] of [
        ['review17-time-seconds', '09:30:00'],
        ['review17-time-seconds', '09:30:15.500'],
        ['review17-time', '09:30:00'],
        ['review17-time', '09:45'],
      ]) {
        const filled = await run({
          type: 'browser.fill',
          locator: selector(id),
          text,
        });
        expect(filled.ok, JSON.stringify(filled)).toBe(true);
        expect(receiptOf(filled), text).toMatchObject({
          kind: 'fill',
          status: 'executed',
        });
        expect(receiptOf(filled), text).not.toHaveProperty('readback');
        expect(await propertyOf(electronApp, url, id, 'value'), text).toBe(
          text,
        );
      }
    });
  });

  test('phase 06 review round 18: controls and lists inside a secret editing host are redacted in snapshots and inspection', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      // Setup only: a card-number editing host with a select, a field, and
      // a list inside it, and a plain editing host with the same controls.
      await inLab(
        electronApp,
        url,
        `(() => {
          const box = document.createElement('div');
          const controls = (prefix, option, listed, typed) =>
            '<select data-testid="' + prefix + '-select"><option value="' + option + '" selected>' + option + '</option></select>' +
            '<input data-testid="' + prefix + '-field" value="' + typed + '">' +
            '<div role="listbox" tabindex="0" aria-label="Cards" data-testid="' + prefix + '-list"><div role="option" data-value="' + listed + '">Card</div></div>';
          box.innerHTML =
            '<div contenteditable="true" autocomplete="cc-number" aria-label="Card" data-testid="review18-secret">' +
            controls('review18-secret', '4111111111111111', '4000056655665556', '5555555555554444') +
            '</div>' +
            '<div contenteditable="true" aria-label="Notes" data-testid="review18-plain">' +
            controls('review18-plain', 'PLAIN-EDITOR-OPTION', 'PLAIN-EDITOR-LISTED', 'PLAIN-EDITOR-TYPED') +
            '</div>';
          document.querySelector('main').prepend(box);
          return true;
        })()`,
      );
      const cards = [
        '4111111111111111',
        '4000056655665556',
        '5555555555554444',
      ];
      const snapshot = await run({
        type: 'browser.input_snapshot',
        limit: 100,
      });
      expect(snapshot.ok, JSON.stringify(snapshot)).toBe(true);
      const sent = JSON.stringify(snapshot.result?.inputSnapshot);
      for (const card of cards) expect(sent, card).not.toContain(card);
      // The same controls in an editor that is not secret keep their values.
      expect(sent).toContain('PLAIN-EDITOR-OPTION');
      expect(sent).toContain('PLAIN-EDITOR-LISTED');
      for (const id of [
        'review18-secret-select',
        'review18-secret-field',
        'review18-secret-list',
      ]) {
        const inspected = await run({
          type: 'browser.inspect',
          locator: selector(id),
        });
        expect(inspected.ok, JSON.stringify(inspected)).toBe(true);
        const element = JSON.stringify(inspected);
        for (const card of cards) expect(element, id).not.toContain(card);
      }
    });
  });

  test('phase 06 review round 18: an email or URL fill with surrounding spaces is compared as the browser stores it', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      // Setup only: email and URL inputs, and a count of the keys the page
      // receives.
      await inLab(
        electronApp,
        url,
        `(() => {
          const box = document.createElement('div');
          box.innerHTML =
            '<label>Email <input type="email" data-testid="review18-email"></label>' +
            '<label>Emails <input type="email" multiple data-testid="review18-emails"></label>' +
            '<label>Site <input type="url" data-testid="review18-url"></label>' +
            '<output data-testid="review18-keys">0</output>';
          document.querySelector('main').prepend(box);
          const keys = box.querySelector('output');
          document.addEventListener('keydown', () => {
            keys.textContent = String(Number(keys.textContent) + 1);
          }, true);
          return true;
        })()`,
      );
      for (const [id, text, stored] of [
        ['review18-email', '  user@example.com  ', 'user@example.com'],
        [
          'review18-emails',
          ' a@example.com , b@example.com ',
          'a@example.com,b@example.com',
        ],
        ['review18-url', '  https://example.com/  ', 'https://example.com/'],
      ]) {
        const filled = await run({
          type: 'browser.fill',
          locator: selector(id),
          text,
        });
        expect(filled.ok, JSON.stringify(filled)).toBe(true);
        expect(receiptOf(filled), id).toMatchObject({
          kind: 'fill',
          status: 'executed',
          inputMode: 'direct',
        });
        expect(receiptOf(filled), id).not.toHaveProperty('readback');
        expect(await propertyOf(electronApp, url, id, 'value'), id).toBe(
          stored,
        );
      }
      expect(
        await propertyOf(electronApp, url, 'review18-keys', 'textContent'),
      ).toBe('0');
    });
  });

  test('phase 06 review round 19: a recorded select_option keeps a secret list option out of the recording', async () => {
    test.setTimeout(120_000);
    await withBrowser(
      'controls',
      async ({
        run,
        electronApp,
        url,
        window,
        browserId,
        expectedRuntimeGeneration,
      }) => {
        // Setup only: a listbox with a secret token, a combobox whose list
        // mounts with a secret token when it opens, and a plain listbox. A
        // click selects an option.
        await inLab(
          electronApp,
          url,
          `(() => {
            const box = document.createElement('div');
            box.innerHTML =
              '<div role="listbox" autocomplete="cc-number" aria-label="Stored cards" data-testid="review19-secret-list"><div role="option" aria-selected="false">4111 1111 1111 1111</div></div>' +
              '<div role="combobox" tabindex="0" aria-label="Card" aria-controls="review19-cards" aria-expanded="false" data-testid="review19-combo">Choose a card</div><div id="review19-cards"></div>' +
              '<div role="listbox" aria-label="Sizes" data-testid="review19-plain-list"><div role="option" aria-selected="false">Large size</div></div>';
            document.querySelector('main').prepend(box);
            const selects = (option) =>
              option.addEventListener('click', () => option.setAttribute('aria-selected', 'true'));
            box.querySelectorAll('[role="option"]').forEach(selects);
            const combo = box.querySelector('[data-testid="review19-combo"]');
            combo.addEventListener('click', () => {
              const holder = box.querySelector('#review19-cards');
              if (holder.firstChild) return;
              holder.innerHTML =
                '<div role="listbox" autocomplete="cc-number"><div role="option" aria-selected="false">5555 5555 5555 4444</div></div>';
              combo.setAttribute('aria-expanded', 'true');
              holder.querySelectorAll('[role="option"]').forEach(selects);
            });
            return true;
          })()`,
        );
        await window.evaluate(
          (request) => window.api.browser.startRecording(request),
          { browserId, expectedRuntimeGeneration },
        );
        for (const id of [
          'review19-secret-list',
          'review19-combo',
          'review19-plain-list',
        ]) {
          const chosen = await run({
            type: 'browser.select_option',
            locator: selector(id),
            indexes: [0],
          });
          expect(chosen.ok, JSON.stringify(chosen)).toBe(true);
          expect(receiptOf(chosen), id).toMatchObject({
            kind: 'select_option',
            status: 'executed',
          });
        }
        expect(
          await inLab(
            electronApp,
            url,
            `Array.from(document.querySelectorAll('[data-testid^="review19"] [role="option"], #review19-cards [role="option"]'), (option) => option.getAttribute('aria-selected')).join(',')`,
          ),
        ).toBe('true,true,true');
        const recording = await window.evaluate(
          (request) => window.api.browser.stopRecording(request),
          { browserId, expectedRuntimeGeneration },
        );
        const recorded = JSON.stringify(recording);
        expect(recorded).not.toContain('4111 1111 1111 1111');
        expect(recorded).not.toContain('5555 5555 5555 4444');
        // The same choice in a list that is not secret is recorded as the
        // page saw it, and replays.
        expect(
          recording.steps.filter(
            (step) =>
              step.action === 'click' && step.playwright.includes('Large size'),
          ),
        ).toHaveLength(1);
        expect(recording.playwrightScript).toContain('Large size');
      },
    );
  });

  test('phase 06 review round 19: typed text with CRLF line breaks types one line break for each', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      // Setup only: a textarea, an editor, and a single-line field in a
      // form that counts its submissions and cancels them.
      await inLab(
        electronApp,
        url,
        `(() => {
          const box = document.createElement('div');
          box.innerHTML =
            '<label>Notes <textarea data-testid="review19-area"></textarea></label>' +
            '<div contenteditable="true" aria-label="Editor" style="min-height: 24px" data-testid="review19-editor"></div>' +
            '<form data-testid="review19-form" data-submits="0"><label>Line <input data-testid="review19-line"></label></form>';
          document.querySelector('main').prepend(box);
          const form = box.querySelector('form');
          form.addEventListener('submit', (event) => {
            event.preventDefault();
            form.dataset.submits = String(Number(form.dataset.submits) + 1);
          });
          return true;
        })()`,
      );
      for (const id of ['review19-area', 'review19-editor', 'review19-line']) {
        const typed = await run({
          type: 'browser.type',
          locator: selector(id),
          text: 'first\r\nsecond',
        });
        expect(typed.ok, JSON.stringify(typed)).toBe(true);
        expect(receiptOf(typed), id).toMatchObject({
          kind: 'type',
          status: 'executed',
        });
      }
      expect(await propertyOf(electronApp, url, 'review19-area', 'value')).toBe(
        'first\nsecond',
      );
      expect(
        await propertyOf(electronApp, url, 'review19-editor', 'innerText'),
      ).toBe('first\nsecond');
      expect(await propertyOf(electronApp, url, 'review19-line', 'value')).toBe(
        'firstsecond',
      );
      expect(
        await readLab(electronApp, url, 'review19-form', 'data-submits'),
      ).toBe('1');
    });
  });

  test('phase 06 review round 20: a select that is secret only while the action runs stays out of the recording', async () => {
    test.setTimeout(120_000);
    await withBrowser(
      'controls',
      async ({
        run,
        electronApp,
        url,
        window,
        browserId,
        expectedRuntimeGeneration,
      }) => {
        // Setup only: a select that gains a secret token on focus and drops
        // it on input, before change.
        await inLab(
          electronApp,
          url,
          `(() => {
            const box = document.createElement('div');
            box.innerHTML =
              '<label>Holder <select data-testid="review20-holder"><option value="">Choose</option><option value="private-name">Private Person</option></select></label>';
            document.querySelector('main').prepend(box);
            const select = box.querySelector('select');
            select.addEventListener('focus', () => select.setAttribute('autocomplete', 'cc-name'));
            select.addEventListener('input', () => select.removeAttribute('autocomplete'));
            return true;
          })()`,
        );
        await window.evaluate(
          (request) => window.api.browser.startRecording(request),
          { browserId, expectedRuntimeGeneration },
        );
        const chosen = await run({
          type: 'browser.select_option',
          locator: selector('review20-holder'),
          values: ['private-name'],
        });
        expect(chosen.ok, JSON.stringify(chosen)).toBe(true);
        expect(receiptOf(chosen)).toMatchObject({
          kind: 'select_option',
          status: 'executed',
          target: { optionsRedacted: true },
        });
        expect(JSON.stringify(chosen)).not.toContain('Private Person');
        expect(
          await propertyOf(electronApp, url, 'review20-holder', 'value'),
        ).toBe('private-name');
        const recording = await window.evaluate(
          (request) => window.api.browser.stopRecording(request),
          { browserId, expectedRuntimeGeneration },
        );
        const recorded = JSON.stringify(recording);
        expect(recorded).not.toContain('private-name');
        expect(recorded).not.toContain('Private Person');
      },
    );
  });

  test('phase 06 review round 20: a combobox option that is only highlighted is clicked, and one that is shown as the value is not', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      // Setup only: comboboxes that mark the highlighted option with
      // aria-selected. The top match is highlighted on open and after each
      // search change, unless the field already shows an option. A click on
      // an option puts its label in the field and closes the list.
      await inLab(
        electronApp,
        url,
        `(() => {
          const box = document.createElement('div');
          const states = ['Alabama', 'Alaska', 'Arizona'];
          for (const [id, value] of [['review20-search', ''], ['review20-open', ''], ['review20-shown', 'Alaska']]) {
            const wrap = document.createElement('div');
            wrap.innerHTML =
              '<input role="combobox" aria-label="State" aria-autocomplete="list" aria-expanded="false" aria-controls="' + id + '-list" data-testid="' + id + '">' +
              '<div id="' + id + '-list" role="listbox" data-clicks="0" hidden></div>';
            box.append(wrap);
            const input = wrap.querySelector('input');
            const list = wrap.querySelector('[role="listbox"]');
            input.value = value;
            const close = () => {
              list.hidden = true;
              list.innerHTML = '';
              input.setAttribute('aria-expanded', 'false');
            };
            const render = () => {
              const text = input.value.toLowerCase();
              const shown = states.find((state) => state.toLowerCase() === text);
              const matches = shown ? states : states.filter((state) => state.toLowerCase().startsWith(text));
              list.innerHTML = '';
              matches.forEach((state, index) => {
                const option = document.createElement('div');
                option.setAttribute('role', 'option');
                option.setAttribute('aria-selected', String(shown ? state === shown : index === 0));
                option.textContent = state;
                option.addEventListener('click', () => {
                  list.dataset.clicks = String(Number(list.dataset.clicks) + 1);
                  input.value = state;
                  close();
                });
                list.append(option);
              });
              list.hidden = false;
              input.setAttribute('aria-expanded', 'true');
            };
            input.addEventListener('click', render);
            input.addEventListener('input', render);
          }
          document.querySelector('main').prepend(box);
          return true;
        })()`,
      );
      const searched = await run({
        type: 'browser.select_option',
        locator: selector('review20-search'),
        labels: ['Alabama'],
        searchText: 'Ala',
      });
      expect(searched.ok, JSON.stringify(searched)).toBe(true);
      expect(receiptOf(searched)).toMatchObject({
        kind: 'select_option',
        status: 'executed',
      });
      expect(receiptOf(searched)).not.toHaveProperty('readback');
      expect(
        await propertyOf(electronApp, url, 'review20-search', 'value'),
      ).toBe('Alabama');

      const opened = await run({
        type: 'browser.select_option',
        locator: selector('review20-open'),
        labels: ['Alabama'],
      });
      expect(opened.ok, JSON.stringify(opened)).toBe(true);
      expect(receiptOf(opened)).not.toHaveProperty('readback');
      expect(await propertyOf(electronApp, url, 'review20-open', 'value')).toBe(
        'Alabama',
      );

      // The field already shows the option, so nothing is clicked.
      const shown = await run({
        type: 'browser.select_option',
        locator: selector('review20-shown'),
        labels: ['Alaska'],
      });
      expect(shown.ok, JSON.stringify(shown)).toBe(true);
      expect(receiptOf(shown)).toMatchObject({
        kind: 'select_option',
        status: 'executed',
      });
      expect(receiptOf(shown)).not.toHaveProperty('readback');
      expect(
        await propertyOf(electronApp, url, 'review20-shown', 'value'),
      ).toBe('Alaska');
      expect(
        await inLab(
          electronApp,
          url,
          `document.getElementById('review20-shown-list').dataset.clicks`,
        ),
      ).toBe('0');
    });
  });

  test('phase 06 review round 20: the receipt lists the option a combobox names directly', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      // Setup only: an open combobox whose aria-controls names the option
      // itself; a click selects it.
      await inLab(
        electronApp,
        url,
        `(() => {
          const box = document.createElement('div');
          box.innerHTML =
            '<div role="combobox" tabindex="0" aria-label="City" aria-expanded="true" aria-controls="review20-only" data-testid="review20-direct">Pick a city</div>' +
            '<div id="review20-only" role="option" data-value="city" aria-selected="false">New York</div>';
          document.querySelector('main').prepend(box);
          const option = box.querySelector('[role="option"]');
          option.addEventListener('click', () => {
            option.setAttribute('aria-selected', 'true');
            box.querySelector('[role="combobox"]').textContent = 'New York';
          });
          return true;
        })()`,
      );
      const chosen = await run({
        type: 'browser.select_option',
        locator: selector('review20-direct'),
        values: ['city'],
      });
      expect(chosen.ok, JSON.stringify(chosen)).toBe(true);
      expect(receiptOf(chosen)).toMatchObject({
        kind: 'select_option',
        status: 'executed',
        target: { selectedOptions: [{ value: 'city', label: 'New York' }] },
      });
      expect(receiptOf(chosen)).not.toHaveProperty('readback');
    });
  });

  test('phase 06 review round 21: a highlighted combobox option whose click the page does not accept is reported unchanged', async () => {
    test.setTimeout(120_000);
    await withBrowser('controls', async ({ run, electronApp, url }) => {
      // Setup only: a combobox that marks its highlighted option with
      // aria-selected and highlights the top match after each search change.
      // A click on an option is counted and otherwise ignored.
      await inLab(
        electronApp,
        url,
        `(() => {
          const box = document.createElement('div');
          box.innerHTML =
            '<input role="combobox" aria-label="State" aria-autocomplete="list" aria-expanded="false" aria-controls="review21-states" data-testid="review21-combo">' +
            '<div id="review21-states" role="listbox" data-clicks="0" hidden></div>';
          document.querySelector('main').prepend(box);
          const input = box.querySelector('input');
          const list = box.querySelector('[role="listbox"]');
          const render = () => {
            const text = input.value.toLowerCase();
            list.innerHTML = '';
            ['Alabama', 'Alaska', 'Arizona']
              .filter((state) => state.toLowerCase().startsWith(text))
              .forEach((state, index) => {
                const option = document.createElement('div');
                option.setAttribute('role', 'option');
                option.setAttribute('aria-selected', String(index === 0));
                option.textContent = state;
                option.addEventListener('click', () => {
                  list.dataset.clicks = String(Number(list.dataset.clicks) + 1);
                });
                list.append(option);
              });
            list.hidden = false;
            input.setAttribute('aria-expanded', 'true');
          };
          input.addEventListener('click', render);
          input.addEventListener('input', render);
          return true;
        })()`,
      );
      const chosen = await run({
        type: 'browser.select_option',
        locator: selector('review21-combo'),
        labels: ['Alabama'],
        searchText: 'Ala',
      });
      expect(chosen.ok, JSON.stringify(chosen)).toBe(true);
      expect(receiptOf(chosen)).toMatchObject({
        kind: 'select_option',
        status: 'executed',
        readback: { code: 'state_unchanged' },
      });
      expect(
        await propertyOf(electronApp, url, 'review21-combo', 'value'),
      ).toBe('Ala');
      expect(
        await inLab(
          electronApp,
          url,
          `document.getElementById('review21-states').dataset.clicks`,
        ),
      ).toBe('1');
    });
  });

  test('phase 06 review round 21: an editor fill or type that stopped partway does not record its whole text', async () => {
    test.setTimeout(120_000);
    await withBrowser(
      'controls',
      async ({
        run,
        electronApp,
        url,
        window,
        browserId,
        expectedRuntimeGeneration,
      }) => {
        // Setup only: two editors that move focus to another field on their
        // first trusted input, and one that keeps it.
        await inLab(
          electronApp,
          url,
          `(() => {
            const box = document.createElement('div');
            box.innerHTML =
              '<div contenteditable="true" role="textbox" aria-label="Moving fill editor" data-testid="review21-fill">old</div>' +
              '<div contenteditable="true" role="textbox" aria-label="Moving type editor" style="min-height: 24px" data-testid="review21-type"></div>' +
              '<div contenteditable="true" role="textbox" aria-label="Steady editor" style="min-height: 24px" data-testid="review21-steady"></div>' +
              '<label>Other <input data-testid="review21-other"></label>';
            document.querySelector('main').prepend(box);
            const other = box.querySelector('[data-testid="review21-other"]');
            for (const name of ['fill', 'type']) {
              const editor = box.querySelector('[data-testid="review21-' + name + '"]');
              let moved = false;
              editor.addEventListener('input', (event) => {
                if (event.isTrusted && !moved) {
                  moved = true;
                  other.focus();
                }
              });
            }
            return true;
          })()`,
        );
        await window.evaluate(
          (request) => window.api.browser.startRecording(request),
          { browserId, expectedRuntimeGeneration },
        );
        for (const [type, id, text] of [
          ['browser.fill', 'review21-fill', 'filled-text-never-entered'],
          ['browser.type', 'review21-type', 'typed-text-never-entered'],
        ]) {
          const stopped = await run({ type, locator: selector(id), text });
          expect(stopped.ok, JSON.stringify(stopped)).toBe(true);
          expect(receiptOf(stopped), id).toMatchObject({
            status: 'executed',
            readback: { code: 'state_unchanged' },
          });
        }
        const steady = await run({
          type: 'browser.type',
          locator: selector('review21-steady'),
          text: 'typed-in-full',
        });
        expect(steady.ok, JSON.stringify(steady)).toBe(true);
        expect(receiptOf(steady)).not.toHaveProperty('readback');
        const recording = await window.evaluate(
          (request) => window.api.browser.stopRecording(request),
          { browserId, expectedRuntimeGeneration },
        );
        const recorded = JSON.stringify(recording);
        expect(recorded).not.toContain('filled-text-never-entered');
        expect(recorded).not.toContain('typed-text-never-entered');
        // An action that entered its whole text is recorded as before.
        expect(recording.playwrightScript).toContain(
          ".pressSequentially('typed-in-full')",
        );
      },
    );
  });
});
