// CAN-1570 phase 04b: frames, shadow roots and redaction on both agent routes.
// The fixture is observed through its native WebContents; Playwright input
// never performs the browser action being asserted.
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { listenPairedBrowserLabServers } from './mock-server/routes/browser-lab.mjs';
import { closeCanopy } from './launchCanopy.mjs';
import { seedPanelWorktree, SEEDED_CHAT_TAB_ID } from './panelHarness.mjs';

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
  // The tool rejects arguments its schema refuses before any action runs,
  // and reports the schema's messages as text.
  if (
    typeof content === 'string' &&
    content.startsWith('Invalid arguments for DispatchAction.')
  )
    return {
      ok: false,
      error: { code: 'invalid_arguments', message: content },
    };
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

function receiptOf(response) {
  return (
    response.result?.receipt ??
    response.result?.error?.details ??
    response.error?.details ??
    response.details
  );
}

// Duplicate same-origin URLs are distinguished by the native frame's name,
// never by parent-document access to its contentWindow.
async function inFrame(context, path, expression, name) {
  return context.electronApp.evaluate(
    async ({ webContents }, input) => {
      const view = webContents
        .getAllWebContents()
        .find((wc) => wc.getURL() === input.url);
      if (!view)
        throw new Error(`Browser Lab WebContents missing: ${input.url}`);
      const frame = view.mainFrame.framesInSubtree.find((candidate) => {
        try {
          return (
            new URL(candidate.url).pathname === input.path &&
            (!input.name || candidate.name === input.name)
          );
        } catch {
          return false;
        }
      });
      if (!frame)
        throw new Error(
          `Browser Lab frame missing: ${input.path} (${input.name ?? 'any'})`,
        );
      return frame.executeJavaScript(input.expression);
    },
    { url: context.url, path, expression, name },
  );
}

const SAME = '/browser-lab/frames/same-origin-form';
const CROSS = '/browser-lab/frames/cross-site-form';
const NESTED = '/browser-lab/frames/nested/3';
const LATE = '/browser-lab/frames/late';
const SAME_OWNER = 'browser-lab-frames-same-origin-frame';
const OVERLAY_OWNER = 'browser-lab-frames-overlay-frame';
const CROSS_OWNER = 'browser-lab-frames-cross-site-frame';

function assertNoSecrets(response) {
  expect(JSON.stringify(response)).not.toMatch(/canopy-seeded-secret-\d+/);
}

async function inspect(context, target) {
  const response = await context.run({ type: 'browser.inspect', ...target });
  expect(
    response.ok,
    `${context.kind}: inspect ${JSON.stringify(target)}: ${JSON.stringify(response)}`,
  ).toBe(true);
  expect(response.result?.element).toMatchObject({
    tagName: expect.any(String),
  });
  assertNoSecrets(response);
  return response.result.element;
}

async function snapshot(context, filter = {}) {
  const inputs = [];
  let offset = 0;
  let last;
  for (;;) {
    const response = await context.run({
      type: 'browser.input_snapshot',
      limit: 100,
      offset,
      ...filter,
    });
    expect(
      response.ok,
      `${context.kind}: snapshot: ${JSON.stringify(response)}`,
    ).toBe(true);
    last = response.result?.inputSnapshot;
    expect(last).toMatchObject({
      inputs: expect.any(Array),
      total: expect.any(Number),
    });
    expect(last.returned).toBe(last.inputs.length);
    // Positive envelope assertions above keep whole-response absence checks non-vacuous.
    assertNoSecrets(response);
    inputs.push(...last.inputs);
    if (!last.truncated) break;
    expect(last.nextOffset).toBeGreaterThan(offset);
    offset = last.nextOffset;
  }
  expect(inputs).toHaveLength(last.total);
  expect(inputs.length).toBeGreaterThan(0);
  return { ...last, inputs };
}

async function rowsById(context, filter = {}) {
  const result = await snapshot(context, filter);
  const rows = [];
  for (const row of result.inputs) {
    const element = await inspect(context, { ref: row.ref });
    rows.push({ ...row, testId: element.attributes?.['data-testid'] });
  }
  return { ...result, inputs: rows };
}

function rowById(result, testId, frameRef) {
  const rows = result.inputs.filter(
    (row) => row.testId === testId && (!frameRef || row.frameRef === frameRef),
  );
  expect(
    rows,
    `exactly one row for ${testId} in ${frameRef ?? 'any frame'}`,
  ).toHaveLength(1);
  return rows[0];
}

async function frameRef(context, owner, testId) {
  const element = await inspect(context, {
    locator: `page.frameLocator('${selector(owner)}').getByTestId('${testId}')`,
  });
  expect(element.frameRef).toMatch(/^f-/);
  return element.frameRef;
}

async function readFrame(context, path, testId, property, name) {
  return inFrame(
    context,
    path,
    `document.querySelector(${JSON.stringify(selector(testId))})?.${property}`,
    name,
  );
}

async function frameCount(context, path, testId, expected, name) {
  await expect
    .poll(
      () =>
        readFrame(
          context,
          path,
          testId,
          "getAttribute('data-browser-lab-click-count')",
          name,
        ),
      { message: `${context.kind}: ${testId} click count` },
    )
    .toBe(String(expected));
}

function executed(context, response, target = {}, inputMode) {
  expect(response.ok, `${context.kind}: ${JSON.stringify(response)}`).toBe(
    true,
  );
  expect(receiptOf(response)).toMatchObject({
    status: 'executed',
    target,
    ...(inputMode ? { inputMode } : {}),
  });
}

async function shadowRead(context, host, testId, property) {
  return inLab(
    context.electronApp,
    context.url,
    `document.querySelector(${JSON.stringify(selector(host))}).shadowRoot.querySelector(${JSON.stringify(selector(testId))})?.${property}`,
  );
}

async function waitFrames(context) {
  for (const [path, name] of [[SAME, SAME_OWNER], [CROSS], [NESTED], [LATE]]) {
    await expect
      .poll(
        () =>
          inFrame(
            context,
            path,
            "document.readyState === 'complete' && !!document.querySelector('main')",
            name,
          ).catch(() => false),
        { timeout: 30_000, message: `${context.kind}: frame ready ${path}` },
      )
      .toBe(true);
  }
}

function waitForOf(response, kind) {
  return kind === 'mcp'
    ? (response.waitFor ?? response.result?.waitFor)
    : response.result?.waitFor;
}

test.describe('frames on both agent routes', () => {
  test('snapshot includes same-origin, OOPIF, nested and late rows and coverage', async () => {
    // Frames 1: rows carry frameRef; top rows do not; every child is included, and cross-site is a real target.
    test.setTimeout(120_000);
    await withBrowser('frames', async (context) => {
      await waitFrames(context);
      const same = await frameRef(
        context,
        SAME_OWNER,
        'browser-lab-frames-same-origin-name',
      );
      const result = await rowsById(context);
      for (const [id, scope] of [
        ['browser-lab-frames-same-origin-name', same],
        ['browser-lab-frames-cross-site-name'],
        ['browser-lab-frames-nested-counter-button'],
        ['browser-lab-frames-late-button'],
      ])
        expect(rowById(result, id, scope).frameRef).toMatch(/^f-/);
      const top = rowById(result, 'browser-lab-frames-overlay-dismiss');
      expect(top.ref).toBeTruthy();
      expect(top.frameRef).toBeUndefined();
      const topElement = await inspect(context, { ref: top.ref });
      expect(topElement.attributes?.['data-testid']).toBe(
        'browser-lab-frames-overlay-dismiss',
      );
      expect(topElement.frameRef).toBeUndefined();
      expect(topElement.inShadowRoot).toBeUndefined();
      for (const path of [
        SAME,
        CROSS,
        '/browser-lab/frames/nested/1',
        '/browser-lab/frames/nested/2',
        NESTED,
        LATE,
      ]) {
        const included = result.frames.filter(
          (frame) =>
            frame.status === 'included' && new URL(frame.url).pathname === path,
        );
        expect(included.length, `included frame ${path}`).toBeGreaterThan(0);
        for (const frame of included) expect(frame.frameRef).toMatch(/^f-/);
      }
      const targets = await context.electronApp.evaluate(
        async ({ webContents }, url) => {
          const view = webContents
            .getAllWebContents()
            .find((wc) => wc.getURL() === url);
          return (
            await view.debugger.sendCommand('Target.getTargets')
          ).targetInfos.map(({ type, url }) => ({ type, url }));
        },
        context.url,
      );
      expect(targets).toContainEqual({
        type: 'iframe',
        url: `${lab.paired.origin}${CROSS}`,
      });
    });
  });

  test('snapshot frame filters return only that frame and reject unknown refs', async () => {
    // Frames 2: frameRef and owner CSS select identical rows; total is scoped; unknown scope fails.
    test.setTimeout(120_000);
    await withBrowser('frames', async (context) => {
      await waitFrames(context);
      const scope = await frameRef(
        context,
        CROSS_OWNER,
        'browser-lab-frames-cross-site-name',
      );
      const all = await snapshot(context);
      const expected = all.inputs
        .filter((row) => row.frameRef === scope)
        .map((row) => row.ref);
      expect(expected.length).toBeGreaterThan(0);
      for (const frame of [scope, selector(CROSS_OWNER)]) {
        const filtered = await snapshot(context, { frame });
        expect(filtered.inputs.map((row) => row.ref)).toEqual(expected);
        expect(filtered.total).toBe(expected.length);
        expect(filtered.total).toBeLessThan(all.total);
      }
      const missing = await context.run({
        type: 'browser.input_snapshot',
        frame: 'f-unavailable-phase04b',
      });
      expect(missing.ok, JSON.stringify(missing)).toBe(false);
      expect(JSON.stringify(missing)).toMatch(
        /frame_unavailable|frame.*unavailable/i,
      );
    });
  });

  test('ref clicks name and reach same-origin, cross-site and nested buttons', async () => {
    // Frames 3: stable refs dispatch trusted input to the owning frame and receipts name the retained target.
    test.setTimeout(120_000);
    await withBrowser('frames', async (context) => {
      await waitFrames(context);
      const same = await frameRef(
        context,
        SAME_OWNER,
        'browser-lab-frames-same-origin-counter-button',
      );
      const rows = await rowsById(context);
      for (const [path, id, status, name, scope] of [
        [
          SAME,
          'browser-lab-frames-same-origin-counter-button',
          'browser-lab-frames-same-origin-counter-status',
          SAME_OWNER,
          same,
        ],
        [
          CROSS,
          'browser-lab-frames-collision-button',
          'browser-lab-frames-cross-site-collision-status',
          undefined,
          await frameRef(
            context,
            CROSS_OWNER,
            'browser-lab-frames-collision-button',
          ),
        ],
        [
          NESTED,
          'browser-lab-frames-nested-counter-button',
          'browser-lab-frames-nested-counter-status',
        ],
      ]) {
        const row = rowById(rows, id, scope);
        expect(row.name).toEqual(expect.any(String));
        expect(row.name.length).toBeGreaterThan(0);
        const response = await context.run({
          type: 'browser.click',
          ref: row.ref,
        });
        executed(
          context,
          response,
          { ref: row.ref, name: row.name, tagName: 'button' },
          'trusted',
        );
        await frameCount(context, path, status, 1, name);
      }
    });
  });

  test('collision locators are ambiguous until frameRef, owner CSS or frameLocator scopes them', async () => {
    // Frames 4: global locator ambiguity names both scopes; each frame-scoped form clicks only the child.
    test.setTimeout(120_000);
    await withBrowser('frames', async (context) => {
      await waitFrames(context);
      const id = 'browser-lab-frames-collision-button';
      const scope = await frameRef(context, CROSS_OWNER, id);
      const ambiguous = await context.run({
        type: 'browser.click',
        locator: selector(id),
        timeoutMs: 600,
      });
      expect(ambiguous.ok).toBe(false);
      expect(receiptOf(ambiguous)).toMatchObject({
        status: 'not_executed',
        error: { code: 'target_ambiguous' },
      });
      expect(receiptOf(ambiguous).error.message).toContain(scope);
      const rootFrame = (await snapshot(context)).frames.find(
        (frame) => new URL(frame.url).pathname === '/browser-lab/frames',
      );
      expect(rootFrame?.frameRef).toBeTruthy();
      expect(receiptOf(ambiguous).error.message).toContain(rootFrame.frameRef);
      await frameCount(
        context,
        CROSS,
        'browser-lab-frames-cross-site-collision-status',
        0,
      );
      const actions = [
        { locator: selector(id), frame: scope },
        { locator: selector(id), frame: selector(CROSS_OWNER) },
        {
          locator: `page.frameLocator('${selector(CROSS_OWNER)}').getByTestId('${id}')`,
        },
      ];
      for (const [index, action] of actions.entries()) {
        executed(
          context,
          await context.run({ type: 'browser.click', ...action }),
        );
        await frameCount(
          context,
          CROSS,
          'browser-lab-frames-cross-site-collision-status',
          index + 1,
        );
        expect(
          await readLab(
            context.electronApp,
            context.url,
            'browser-lab-frames-main-collision-status',
            'data-browser-lab-click-count',
          ),
        ).toBe('0');
      }
    });
  });

  test('ref fills and frame-scoped locator fills reach both name inputs', async () => {
    // Frames 5: fill uses the same retained frame identity for refs and explicit scopes.
    test.setTimeout(120_000);
    await withBrowser('frames', async (context) => {
      await waitFrames(context);
      for (const [path, marker, owner] of [
        [SAME, 'same-origin', SAME_OWNER],
        [CROSS, 'cross-site', CROSS_OWNER],
      ]) {
        const id = `browser-lab-frames-${marker}-name`;
        const scope = await frameRef(context, owner, id);
        const row = rowById(await rowsById(context, { frame: scope }), id);
        for (const [index, target] of [
          { ref: row.ref },
          { locator: selector(id), frame: scope },
          { locator: selector(id), frame: selector(owner) },
        ].entries()) {
          const text = `${context.kind}-${marker}-${index}`;
          executed(
            context,
            await context.run({ type: 'browser.fill', text, ...target }),
            { ref: row.ref },
          );
          expect(await readFrame(context, path, id, 'value', owner)).toBe(text);
        }
      }
    });
  });

  test('focus follows a frame for untargeted typing and targeted Enter submits its form', async () => {
    // Frames 6: focus and untargeted press follow frame activeElement; a ref-targeted press retains it across submit.
    test.setTimeout(120_000);
    await withBrowser('frames', async (context) => {
      await waitFrames(context);
      for (const [path, marker, owner] of [
        [SAME, 'same-origin', SAME_OWNER],
        [CROSS, 'cross-site', CROSS_OWNER],
      ]) {
        const id = `browser-lab-frames-${marker}-name`;
        const scope = await frameRef(context, owner, id);
        const row = rowById(await rowsById(context, { frame: scope }), id);
        executed(
          context,
          await context.run({
            type: 'browser.focus',
            locator: selector(id),
            frame: scope,
          }),
          { ref: row.ref, focused: true },
        );
        expect(
          await inFrame(
            context,
            path,
            "document.activeElement?.getAttribute('data-testid')",
            owner,
          ),
        ).toBe(id);
        executed(
          context,
          await context.run({ type: 'browser.press', key: 'a' }),
        );
        await expect
          .poll(() => readFrame(context, path, id, 'value', owner))
          .toBe('a');
        const submitted = await context.run({
          type: 'browser.press',
          ref: row.ref,
          key: 'Enter',
        });
        expect(submitted.ok, JSON.stringify(submitted)).toBe(true);
        expect(receiptOf(submitted).status).toBe('executed');
        await expect
          .poll(
            () =>
              inFrame(
                context,
                '/browser-lab/frames/submit',
                `document.querySelector('[data-browser-lab-field="name"]')?.textContent`,
                owner,
              ).catch(() => ''),
            { timeout: 15_000 },
          )
          .toBe('a');
        expect(
          await inFrame(
            context,
            '/browser-lab/frames/submit',
            `document.querySelector('[data-testid="browser-lab-result"]')?.getAttribute('data-browser-lab-status')`,
            owner,
          ),
        ).toBe('received');
      }
    });
  });

  test('covered frame clicks fall back, then become trusted after dismiss', async () => {
    // Frames 7: ancestor hit testing names the covering element, without preventing synthetic fallback.
    test.setTimeout(120_000);
    await withBrowser('frames', async (context) => {
      await waitFrames(context);
      const id = 'browser-lab-frames-same-origin-counter-button';
      const scope = await frameRef(context, OVERLAY_OWNER, id);
      const row = rowById(await rowsById(context, { frame: scope }), id);
      const covered = await context.run({
        type: 'browser.click',
        ref: row.ref,
      });
      executed(context, covered, { ref: row.ref }, 'synthetic');
      // The cover is whatever the parent document's hit test finds, named
      // by tag and classes as for a cover in the target's own document.
      expect(receiptOf(covered).warnings).toEqual([
        expect.stringMatching(
          /^Covered by [a-z][\w.-]*; clicked the element directly\.$/,
        ),
      ]);
      await frameCount(
        context,
        SAME,
        'browser-lab-frames-same-origin-counter-status',
        1,
        OVERLAY_OWNER,
      );
      executed(
        context,
        await context.run({
          type: 'browser.click',
          locator: selector('browser-lab-frames-overlay-dismiss'),
        }),
      );
      expect(
        await readLab(
          context.electronApp,
          context.url,
          'browser-lab-frames-overlay-status',
          'data-browser-lab-state',
        ),
      ).toBe('dismissed');
      const uncovered = await context.run({
        type: 'browser.click',
        ref: row.ref,
      });
      executed(context, uncovered, { ref: row.ref }, 'trusted');
      expect(JSON.stringify(receiptOf(uncovered).warnings ?? [])).not.toContain(
        'browser-lab-frames-overlay',
      );
      await frameCount(
        context,
        SAME,
        'browser-lab-frames-same-origin-counter-status',
        2,
        OVERLAY_OWNER,
      );
    });
  });

  test('snapshot coordinates hit a control inside the cross-site frame', async () => {
    // Frames 8: top-level row bounds are mapped through the OOPIF owner for coordinate input.
    test.setTimeout(120_000);
    await withBrowser('frames', async (context) => {
      await waitFrames(context);
      const id = 'browser-lab-frames-collision-button';
      await inFrame(
        context,
        CROSS,
        `document.querySelector(${JSON.stringify(selector(id))}).scrollIntoView({ block: 'center' })`,
      );
      await inLab(
        context.electronApp,
        context.url,
        `document.querySelector(${JSON.stringify(selector(CROSS_OWNER))}).scrollIntoView({ block: 'center' })`,
      );
      const scope = await frameRef(context, CROSS_OWNER, id);
      const row = rowById(await rowsById(context, { frame: scope }), id);
      expect(row.inViewport).toBe(true);
      expect(row.bounds.width).toBeGreaterThan(0);
      expect(row.bounds.height).toBeGreaterThan(0);
      const response = await context.run({
        type: 'browser.click',
        x: row.bounds.x + row.bounds.width / 2,
        y: row.bounds.y + row.bounds.height / 2,
      });
      executed(context, response, { ref: row.ref });
      await frameCount(
        context,
        CROSS,
        'browser-lab-frames-cross-site-collision-status',
        1,
      );
      expect(
        await readLab(
          context.electronApp,
          context.url,
          'browser-lab-frames-main-collision-status',
          'data-browser-lab-click-count',
        ),
      ).toBe('0');
    });
  });

  test('wait_for searches late-frame locators and text and validates frame combinations', async () => {
    // Frames 9: host waits include child content, frame filters exclude other documents, frame+url is invalid.
    test.setTimeout(120_000);
    await withBrowser('frames', async (context) => {
      const conditions = [
        { locator: selector('browser-lab-frames-late-button') },
        { text: 'Late-frame-only ready text' },
      ];
      const topText = await inLab(
        context.electronApp,
        context.url,
        'document.body.textContent',
      );
      expect(topText).toContain('Late frame');
      expect(topText).not.toContain('Late-frame-only ready text');
      for (const condition of conditions) {
        const response = await context.run({
          type: 'browser.wait_for',
          timeoutMs: 5_000,
          ...condition,
        });
        expect(response.ok, JSON.stringify(response)).toBe(true);
        expect(waitForOf(response, context.kind)?.satisfied).toBe(true);
      }
      const scope = await frameRef(
        context,
        SAME_OWNER,
        'browser-lab-frames-same-origin-name',
      );
      for (const condition of conditions) {
        const response = await context.run({
          type: 'browser.wait_for',
          timeoutMs: 600,
          frame: scope,
          ...condition,
        });
        expect(response.ok, JSON.stringify(response)).toBe(true);
        expect(waitForOf(response, context.kind)?.satisfied).toBe(false);
        expect(receiptOf(response)).toMatchObject({
          kind: 'wait_for',
          status: 'executed',
        });
      }
      const invalid = await context.run({
        type: 'browser.wait_for',
        frame: scope,
        url: 'frames',
        timeoutMs: 600,
      });
      expect(invalid.ok).toBe(false);
      expect(JSON.stringify(invalid)).toContain(
        'browser.wait_for frame requires locator or text and cannot be combined with url or loadState.',
      );
    });
  });

  test('detached-frame refs are stale and scoped locators unavailable without dispatch', async () => {
    // Frames 10: document identity survives removal only as a stale ref; no input is dispatched on either failure.
    test.setTimeout(120_000);
    await withBrowser('frames', async (context) => {
      await waitFrames(context);
      const id = 'browser-lab-frames-collision-button';
      const scope = await frameRef(context, CROSS_OWNER, id);
      const row = rowById(await rowsById(context, { frame: scope }), id);
      await inLab(
        context.electronApp,
        context.url,
        `document.querySelector(${JSON.stringify(selector(CROSS_OWNER))}).remove()`,
      );
      await expect
        .poll(() => inFrame(context, CROSS, 'true').catch(() => false))
        .toBe(false);
      for (const [target, code] of [
        [{ ref: row.ref }, 'target_stale'],
        [{ locator: selector(id), frame: scope }, 'frame_unavailable'],
      ]) {
        const response = await context.run({
          type: 'browser.click',
          timeoutMs: 600,
          ...target,
        });
        expect(response.ok).toBe(false);
        expect(receiptOf(response)).toMatchObject({
          status: 'not_executed',
          error: { code },
        });
        expect(
          await readLab(
            context.electronApp,
            context.url,
            'browser-lab-frames-main-collision-status',
            'data-browser-lab-click-count',
          ),
        ).toBe('0');
      }
    });
  });

  test('inspect by ref identifies each frame element without secrets', async () => {
    // Frames 11: both public inspect routes preserve frameRef and redact the whole element response.
    test.setTimeout(120_000);
    await withBrowser('frames', async (context) => {
      await waitFrames(context);
      const same = await frameRef(
        context,
        SAME_OWNER,
        'browser-lab-frames-same-origin-name',
      );
      const result = await rowsById(context);
      for (const [id, scope] of [
        ['browser-lab-frames-same-origin-name', same],
        ['browser-lab-frames-cross-site-name'],
        ['browser-lab-frames-nested-counter-button'],
        ['browser-lab-frames-late-button'],
      ]) {
        const row = rowById(result, id, scope);
        const element = await inspect(context, { ref: row.ref });
        expect(element).toMatchObject({
          frameRef: row.frameRef,
          attributes: { 'data-testid': id },
        });
      }
    });
  });

  test('phase 05: to-text, hover and amount scroll reach the cross-site frame', async () => {
    // Phase 05: pointer and viewport actions use the frame's own document and session.
    test.setTimeout(120_000);
    await withBrowser('frames', async (context) => {
      await waitFrames(context);
      const scope = selector(CROSS_OWNER);
      const status = 'browser-lab-frames-cross-site-collision-status';
      const frameScroll = async () =>
        Number(
          await inFrame(context, CROSS, 'document.scrollingElement.scrollTop'),
        );

      // The collision section sits below the 190 px frame's fold.
      const reached = await context.run({
        type: 'browser.scroll',
        toText: 'Cross-site collision button',
        frame: scope,
      });
      executed(context, reached, { tagName: 'button', inViewport: true });
      expect(await frameScroll()).toBeGreaterThan(0);

      // Setup-only: the frame's status records a hover of its button.
      await inFrame(
        context,
        CROSS,
        `(() => { const status = document.querySelector(${JSON.stringify(selector(status))}); document.querySelector(${JSON.stringify(selector('browser-lab-frames-collision-button'))}).addEventListener('mouseover', () => status.setAttribute('data-phase05-hovered', 'true')); return true; })()`,
      );
      executed(
        context,
        await context.run({
          type: 'browser.hover',
          locator: selector('browser-lab-frames-collision-button'),
          frame: scope,
        }),
        { tagName: 'button' },
        'trusted',
      );
      await expect
        .poll(() =>
          readFrame(
            context,
            CROSS,
            status,
            "getAttribute('data-phase05-hovered')",
          ),
        )
        .toBe('true');
      expect(
        await readFrame(
          context,
          CROSS,
          status,
          "getAttribute('data-browser-lab-click-count')",
        ),
      ).toBe('0');

      const top = await context.run({
        type: 'browser.scroll',
        direction: 'up',
        pixels: 100_000,
        locator: 'html',
        frame: scope,
      });
      executed(context, top);
      expect(receiptOf(top)?.effects?.scroll).toMatchObject({
        container: 'element',
        axis: 'y',
        moved: true,
        atStart: true,
      });
      expect(await frameScroll()).toBe(0);
    });
  });

  test('phase 05: a page scroll does not wheel a cross-site frame under the pointer', async () => {
    // Phase 05: in the page's own session a cross-site frame is only its owner
    // element, so a wheel at the viewport centre would scroll the frame.
    test.setTimeout(120_000);
    await withBrowser('frames', async (context) => {
      await waitFrames(context);
      const frameScroll = async () =>
        Number(
          await inFrame(context, CROSS, 'document.scrollingElement.scrollTop'),
        );
      const pageScroll = () =>
        inLab(
          context.electronApp,
          context.url,
          'document.scrollingElement.scrollTop',
        );
      await inLab(
        context.electronApp,
        context.url,
        `document.querySelector(${JSON.stringify(selector(CROSS_OWNER))}).scrollIntoView({ block: 'center' })`,
      );
      expect(
        await inLab(
          context.electronApp,
          context.url,
          `document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.getAttribute('data-testid')`,
        ),
        'the frame is under the viewport centre',
      ).toBe(CROSS_OWNER);
      const before = await pageScroll();
      // Both can scroll down: the page has room, and so has the frame.
      expect(
        await inLab(
          context.electronApp,
          context.url,
          'document.scrollingElement.scrollHeight - document.scrollingElement.clientHeight - document.scrollingElement.scrollTop',
        ),
      ).toBeGreaterThan(40);
      expect(
        Number(
          await inFrame(
            context,
            CROSS,
            'document.scrollingElement.scrollHeight - document.scrollingElement.clientHeight',
          ),
        ),
      ).toBeGreaterThan(40);
      expect(await frameScroll()).toBe(0);

      const scrolled = await context.run({
        type: 'browser.scroll',
        direction: 'down',
        pixels: 40,
      });
      executed(context, scrolled, {}, 'direct');
      expect(receiptOf(scrolled).warnings).toContain(
        'Scrolled with script: the pointer would have scrolled another element.',
      );
      expect(receiptOf(scrolled).effects?.scroll).toMatchObject({
        container: 'page',
        axis: 'y',
        moved: true,
      });
      expect(await pageScroll()).toBe(before + 40);
      expect(await frameScroll()).toBe(0);
    });
  });

  test('phase 05: a drag out of a frame is refused before any input', async () => {
    // Phase 05: a drag stays inside one document; nothing is pressed otherwise.
    test.setTimeout(120_000);
    await withBrowser('frames', async (context) => {
      await waitFrames(context);
      const refused = await context.run({
        type: 'browser.drag',
        from: {
          locator: selector('browser-lab-frames-same-origin-counter-button'),
          frame: selector(SAME_OWNER),
        },
        to: { locator: selector('browser-lab-frames-main') },
      });
      expect(refused.ok).toBe(false);
      expect(receiptOf(refused)).toMatchObject({
        kind: 'drag',
        status: 'not_executed',
        error: {
          code: 'unsupported_capability',
          message:
            'Drag works within one document; the destination is in another frame.',
        },
      });
      await frameCount(
        context,
        SAME,
        'browser-lab-frames-same-origin-counter-button',
        0,
        SAME_OWNER,
      );
    });
  });
});

test.describe('shadow roots on both agent routes', () => {
  test('phase 05: to-text finds text inside a closed root', async () => {
    // Phase 05: the text search covers closed roots, as the snapshot does.
    test.setTimeout(120_000);
    await withBrowser('shadow', async (context) => {
      executed(
        context,
        await context.run({
          type: 'browser.scroll',
          toText: 'Closed-root action',
        }),
        { tagName: 'button', inViewport: true },
      );
    });
  });

  test('snapshot includes open, closed, nested and slotted controls with root metadata', async () => {
    // Shadow 1: pierce every root, but a slotted light-DOM element is not itself inShadowRoot.
    test.setTimeout(120_000);
    await withBrowser('shadow', async (context) => {
      const result = await rowsById(context);
      for (const id of [
        'browser-lab-shadow-open-button',
        'browser-lab-shadow-nested-button',
        'browser-lab-shadow-closed-secret-plain',
        'browser-lab-shadow-scripted-input',
      ]) {
        const row = rowById(result, id);
        expect(row.inShadowRoot).toBe(true);
        expect(await inspect(context, { ref: row.ref })).toMatchObject({
          inShadowRoot: true,
          attributes: { 'data-testid': id },
        });
      }
      const top = await inspect(context, {
        locator: selector('browser-lab-header-home'),
      });
      expect(top.tagName).toBe('a');
      expect(top.inShadowRoot).toBeUndefined();
      expect(top.frameRef).toBeUndefined();
      const slotted = rowById(result, 'browser-lab-shadow-slotted-button');
      expect(slotted.ref).toBeTruthy();
      expect(slotted.inShadowRoot).not.toBe(true);
    });
  });

  test('ref clicks reach open, nested, slotted and scripted buttons', async () => {
    // Shadow 2: ref resolution crosses roots and slot boundaries without retargeting to their hosts.
    test.setTimeout(120_000);
    await withBrowser('shadow', async (context) => {
      const rows = await rowsById(context);
      for (const [id, host, status] of [
        [
          'browser-lab-shadow-open-button',
          'browser-lab-shadow-open-host',
          'browser-lab-shadow-open-click-status',
        ],
        [
          'browser-lab-shadow-slotted-button',
          'browser-lab-shadow-slot-host',
          'browser-lab-shadow-slotted-status',
        ],
        [
          'browser-lab-shadow-scripted-button',
          'browser-lab-shadow-scripted-host',
          'browser-lab-shadow-scripted-click-status',
        ],
      ]) {
        const row = rowById(rows, id);
        executed(
          context,
          await context.run({ type: 'browser.click', ref: row.ref }),
          { ref: row.ref, name: row.name },
          'trusted',
        );
        await expect
          .poll(() =>
            shadowRead(
              context,
              host,
              status,
              "getAttribute('data-browser-lab-click-count')",
            ),
          )
          .toBe('1');
      }
      const nested = rowById(rows, 'browser-lab-shadow-nested-button');
      executed(
        context,
        await context.run({ type: 'browser.click', ref: nested.ref }),
        { ref: nested.ref },
        'trusted',
      );
      await expect
        .poll(() =>
          inLab(
            context.electronApp,
            context.url,
            `document.querySelector('${selector('browser-lab-shadow-nested-host')}').shadowRoot.querySelector('${selector('browser-lab-shadow-nested-inner-host')}').shadowRoot.querySelector('${selector('browser-lab-shadow-nested-status')}').getAttribute('data-browser-lab-click-count')`,
          ),
        )
        .toBe('1');
    });
  });

  test('ref fills update open, labelled and scripted root statuses', async () => {
    // Shadow 3: host-side native fill reaches declarative and imperative roots; event effects are visible.
    test.setTimeout(120_000);
    await withBrowser('shadow', async (context) => {
      const rows = await rowsById(context);
      for (const [id, host, status] of [
        [
          'browser-lab-shadow-open-input',
          'browser-lab-shadow-open-host',
          'browser-lab-shadow-input-status',
        ],
        [
          'browser-lab-shadow-labelled-input',
          'browser-lab-shadow-labelled-host',
          'browser-lab-shadow-labelled-status',
        ],
        [
          'browser-lab-shadow-scripted-input',
          'browser-lab-shadow-scripted-host',
          'browser-lab-shadow-scripted-input-status',
        ],
      ]) {
        const row = rowById(rows, id);
        const text = `${context.kind}: ${id}`;
        executed(
          context,
          await context.run({ type: 'browser.fill', ref: row.ref, text }),
          { ref: row.ref },
        );
        await expect
          .poll(() =>
            shadowRead(
              context,
              host,
              status,
              "getAttribute('data-browser-lab-value')",
            ),
          )
          .toBe(text);
      }
    });
  });

  test('all supported locator forms resolve inside open and closed roots', async () => {
    // Shadow 4: CSS/Playwright/testid/role/label/text forms pierce roots including closed ones.
    test.setTimeout(120_000);
    await withBrowser('shadow', async (context) => {
      const openId = 'browser-lab-shadow-scripted-button';
      const openButton = [
        `page.locator('${selector(openId)}')`,
        `page.getByTestId('${openId}')`,
        "page.getByRole('button', { name: 'Scripted-root action' })",
        "page.getByText('Scripted-root action')",
        `css=${selector(openId)}`,
        'text=Scripted-root action',
      ];
      const closedButton = [
        "page.locator('button:not([data-testid])')",
        "page.getByRole('button', { name: 'Closed-root action' })",
        "page.getByText('Closed-root action')",
        'css=button:not([data-testid])',
        'text=Closed-root action',
      ];
      for (const [locators, closed] of [
        [openButton, false],
        [closedButton, true],
      ]) {
        for (const [index, locator] of locators.entries()) {
          executed(
            context,
            await context.run({ type: 'browser.click', locator }),
          );
          await expect
            .poll(() =>
              closed
                ? readLab(
                    context.electronApp,
                    context.url,
                    'browser-lab-shadow-closed-host',
                    'data-browser-lab-click-count',
                  )
                : shadowRead(
                    context,
                    'browser-lab-shadow-scripted-host',
                    'browser-lab-shadow-scripted-click-status',
                    "getAttribute('data-browser-lab-click-count')",
                  ),
            )
            .toBe(String(index + 1));
        }
      }
      // The closed root's existing seeded input supplies a stable test id;
      // its wrapped Private input supplies getByLabel without exposing the root to setup.
      for (const locator of [
        "page.getByLabel('Scripted note')",
        "page.getByLabel('Private input')",
        "page.getByTestId('browser-lab-shadow-closed-secret-plain')",
      ]) {
        const before = await inspect(context, { locator });
        expect(before.tagName).toBe('input');
        const text = `locator-fill-${context.kind}`;
        executed(
          context,
          await context.run({ type: 'browser.fill', locator, text }),
          { tagName: 'input' },
        );
        const after = await inspect(context, { locator });
        expect(after.value).toBe(text);
      }
    });
  });

  test('listbox trigger and option update selection inside the open root', async () => {
    // Shadow 5: roots remain targetable across a visibility-changing action and a subsequent option click.
    test.setTimeout(120_000);
    await withBrowser('shadow', async (context) => {
      const trigger = rowById(
        await rowsById(context),
        'browser-lab-shadow-select-trigger',
      );
      executed(
        context,
        await context.run({ type: 'browser.click', ref: trigger.ref }),
      );
      await expect
        .poll(() =>
          shadowRead(
            context,
            'browser-lab-shadow-open-host',
            'browser-lab-shadow-listbox',
            'hidden',
          ),
        )
        .toBe(false);
      const option = rowById(
        await rowsById(context),
        'browser-lab-shadow-option-blue',
      );
      executed(
        context,
        await context.run({ type: 'browser.click', ref: option.ref }),
        { ref: option.ref },
      );
      await expect
        .poll(() =>
          shadowRead(
            context,
            'browser-lab-shadow-open-host',
            'browser-lab-shadow-selection-status',
            "getAttribute('data-browser-lab-selection')",
          ),
        )
        .toBe('blue');
      expect(
        await shadowRead(
          context,
          'browser-lab-shadow-open-host',
          'browser-lab-shadow-listbox',
          'hidden',
        ),
      ).toBe(true);
    });
  });

  test('tracked shadow fills read back the new ordinary value and retained receipt target', async () => {
    // Shadow 6: tracking is positively confirmed by a readable changed input value, never a password.
    test.setTimeout(120_000);
    await withBrowser('shadow', async (context) => {
      const id = 'browser-lab-shadow-scripted-input';
      const row = rowById(await rowsById(context), id);
      const text = `tracked-readback-${context.kind}`;
      executed(
        context,
        await context.run({ type: 'browser.fill', ref: row.ref, text }),
        { ref: row.ref, tagName: 'input', name: row.name },
      );
      const next = rowById(await rowsById(context), id);
      expect(next.value).toBe(text);
      expect(next.valueRedacted).not.toBe(true);
      expect(
        await shadowRead(
          context,
          'browser-lab-shadow-scripted-host',
          id,
          'value',
        ),
      ).toBe(text);
    });
  });
});

async function assertRedactionScope(
  context,
  { prefix, first, tracked, frame },
) {
  const result = await rowsById(context, frame ? { frame } : {});
  const plain = rowById(result, `${prefix}-plain`);
  const note = rowById(result, `${prefix}-note`);
  expect(note.value).toBe(`canopy-visible-note-${first}`);
  expect(note.valueRedacted).not.toBe(true);
  const revealed = rowById(result, `${prefix}-revealed`);
  expect(revealed.valueRedacted).toBe(true);
  expect(revealed.value).toBeUndefined();
  if (tracked) {
    expect(plain.value).toBe(`canopy-visible-input-${first}`);
    expect(plain.valueRedacted).not.toBe(true);
  } else {
    expect(plain.valueRedacted).toBe(true);
    expect(plain.value).toBeUndefined();
  }
  // Inspect every scoped row, not just secrets. Each positive ref/tag assertion
  // accompanies assertNoSecrets over the entire public response in inspect().
  for (const row of result.inputs) {
    const element = await inspect(context, { ref: row.ref });
    expect(element.tagName).toBe(row.tagName);
    if (row.testId)
      expect(element.attributes?.['data-testid']).toBe(row.testId);
    if (row.frameRef) expect(element.frameRef).toBe(row.frameRef);
  }
  const ancestor = await inspect(context, {
    locator: selector(`${prefix}-ancestor`),
    ...(frame ? { frame } : {}),
  });
  expect(ancestor.attributes?.['data-testid']).toBe(`${prefix}-ancestor`);
  expect(ancestor.attributes?.['data-browser-lab-state']).toBe('revealed');
  const label = await inspect(context, {
    locator: `label[for="${prefix}-revealed"]`,
    ...(frame ? { frame } : {}),
  });
  expect(label.tagName).toBe('label');
  const plainElement = await inspect(context, { ref: plain.ref });
  const noteElement = await inspect(context, { ref: note.ref });
  expect(noteElement.value).toBe(`canopy-visible-note-${first}`);
  if (tracked) expect(plainElement.value).toBe(`canopy-visible-input-${first}`);
  else {
    expect(plainElement.attributes?.['data-testid']).toBe(`${prefix}-plain`);
    expect(plainElement.valueRedacted).toBe(true);
    expect(plainElement.value).toBeUndefined();
  }
}

test.describe('redaction regressions on both agent routes', () => {
  test('same-origin tracked input stays secret while plain input and note are readable', async () => {
    // Redaction 1 / D2,D3,D5,D12,D13: early frame history withholds revealed seeds and label text, not ordinary data.
    test.setTimeout(120_000);
    await withBrowser('frames', async (context) => {
      await waitFrames(context);
      const scope = await frameRef(
        context,
        SAME_OWNER,
        'browser-lab-frames-same-origin-secret-plain',
      );
      expect(
        await readFrame(
          context,
          SAME,
          'browser-lab-frames-same-origin-secret-revealed',
          'type',
          SAME_OWNER,
        ),
      ).toBe('text');
      await assertRedactionScope(context, {
        prefix: 'browser-lab-frames-same-origin-secret',
        first: 1,
        tracked: true,
        frame: scope,
      });
    });
  });

  test('first OOPIF document fails closed but its next document confirms tracking', async () => {
    // Redaction 2,3 / D4,D12: no debugger pause; first document unknown, next document tracked; textarea remains public in both.
    test.setTimeout(120_000);
    await withBrowser('frames', async (context) => {
      await waitFrames(context);
      const scope = await frameRef(
        context,
        CROSS_OWNER,
        'browser-lab-frames-cross-site-secret-plain',
      );
      expect(
        await readFrame(
          context,
          CROSS,
          'browser-lab-frames-cross-site-secret-revealed',
          'type',
        ),
      ).toBe('text');
      await assertRedactionScope(context, {
        prefix: 'browser-lab-frames-cross-site-secret',
        first: 4,
        tracked: false,
        frame: scope,
      });
      // Navigate from the frame itself, not by reaching through the parent.
      const marker = `tracked-${randomUUID()}`;
      await inFrame(
        context,
        CROSS,
        `(() => { location.replace(location.origin + location.pathname + '?' + ${JSON.stringify(marker)}); return true; })()`,
      );
      await expect
        .poll(
          () =>
            inFrame(
              context,
              CROSS,
              `location.search === '?' + ${JSON.stringify(marker)} && document.readyState === 'complete' && document.querySelector('[data-browser-lab-seeded-password]')?.type === 'text'`,
            ).catch(() => false),
          { timeout: 30_000 },
        )
        .toBe(true);
      const nextScope = await frameRef(
        context,
        CROSS_OWNER,
        'browser-lab-frames-cross-site-secret-plain',
      );
      await assertRedactionScope(context, {
        prefix: 'browser-lab-frames-cross-site-secret',
        first: 4,
        tracked: true,
        frame: nextScope,
      });
    });
  });

  test('script-created open and closed roots track history while the declarative root fails closed', async () => {
    // Redaction 4,5 / D2,D3,D5,D12,D13: attachShadow history is readable only for never-secret inputs; declarative history is unknown.
    test.setTimeout(120_000);
    await withBrowser('shadow', async (context) => {
      for (const scope of [
        {
          prefix: 'browser-lab-shadow-scripted-secret',
          first: 17,
          tracked: true,
        },
        {
          prefix: 'browser-lab-shadow-closed-secret',
          first: 10,
          tracked: true,
        },
        { prefix: 'browser-lab-shadow-open-secret', first: 7, tracked: false },
      ])
        await assertRedactionScope(context, scope);
      expect(
        await shadowRead(
          context,
          'browser-lab-shadow-scripted-host',
          'browser-lab-shadow-scripted-secret-revealed',
          'type',
        ),
      ).toBe('text');
      expect(
        await shadowRead(
          context,
          'browser-lab-shadow-open-host',
          'browser-lab-shadow-open-secret-revealed',
          'type',
        ),
      ).toBe('text');
      // A closed root is intentionally not exposed to observation; inspect
      // proved its revealed input exists and the public host stays usable.
      expect(
        await readLab(
          context.electronApp,
          context.url,
          'browser-lab-shadow-closed-host',
          'data-browser-lab-click-count',
        ),
      ).toBe('0');
    });
  });
});
