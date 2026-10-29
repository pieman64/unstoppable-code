// CAN-1570 phase 04b: the host-side page model on every Browser Lab page.
// Until the cutover this spec compared the preload's snapshot with the
// model's; that gate passed on the production path before the preload's
// snapshot was deleted, and the unit suite keeps the captured expectations.
// What remains checks the model against itself and against the page.
// Run headlessly after build:e2e through test:electron:built. Fixture script
// execution is setup/observation only; snapshots and inspect use the real host.
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { expect, test } from '@playwright/test';
import {
  BROWSER_LAB_CASES,
  BROWSER_LAB_INTERACTION_CASES,
  listenPairedBrowserLabServers,
} from './mock-server/routes/browser-lab.mjs';
import { closeCanopy } from './launchCanopy.mjs';
import { seedPanelWorktree, SEEDED_CHAT_TAB_ID } from './panelHarness.mjs';

const OWNER = { projectId: 'demo-ts-pnpm-vite', worktreeId: 'demo-main' };
// These pages actually contain frames/roots. Leaf documents in the same cases
// are deliberately NOT excluded from light-DOM parity.
const STRUCTURED_PAGES = new Set([
  '/browser-lab/frames',
  '/browser-lab/frames/nested/1',
  '/browser-lab/frames/nested/2',
  '/browser-lab/shadow',
  '/browser-lab/heavy',
  '/browser-lab/upload',
  '/browser-lab/dialog-surfaces',
]);
// A page that is only a drop zone, with no control for a snapshot row.
const ROWLESS_PAGES = new Set(['/browser-lab/upload/drop-frame']);
const LIGHT_PAGES = [
  { path: '/browser-lab', controls: ['browser-lab-index'] },
  {
    path: '/browser-lab/interaction',
    controls: ['browser-lab-interaction-index'],
  },
  ...[...BROWSER_LAB_CASES, ...BROWSER_LAB_INTERACTION_CASES].flatMap(
    (entry) => entry.pages,
  ),
].filter((page) => !STRUCTURED_PAGES.has(page.path));
let lab;

test.beforeAll(async () => {
  lab = await listenPairedBrowserLabServers();
});
test.afterAll(async () => {
  if (lab) await lab.close();
});

async function dispatch(electronApp, action) {
  const requestId = randomUUID();
  return electronApp.evaluate(
    async ({ BrowserWindow, ipcMain }, request) => {
      const main = BrowserWindow.getAllWindows().find(
        (candidate) =>
          !candidate.webContents.getURL().includes('surface=app-advisor'),
      );
      if (!main) throw new Error('Main window not found');
      ipcMain.removeHandler('app-advisor:tool-response');
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Page-model browser action timed out')),
          20_000,
        );
        ipcMain.handle('app-advisor:tool-response', (_event, response) => {
          if (response?.requestId !== request.requestId) return;
          clearTimeout(timer);
          resolve(response);
        });
        main.webContents.send('app-advisor:tool-request', request);
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

async function inPage(context, expression) {
  return context.electronApp.evaluate(
    async ({ webContents }, input) => {
      const view = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL() === input.url);
      if (!view) throw new Error(`Fixture WebContents missing: ${input.url}`);
      return view.executeJavaScript(input.expression);
    },
    { url: context.url, expression },
  );
}

async function hook(context, request) {
  return context.electronApp.evaluate(
    (_electron, input) => {
      if (typeof globalThis.__CANOPY_E2E_BROWSER_PAGE_MODEL__ !== 'function')
        throw new Error(
          'Page-model build hook missing; rebuild the E2E bundle',
        );
      return globalThis.__CANOPY_E2E_BROWSER_PAGE_MODEL__(input);
    },
    { browserId: context.browserId, ...request },
  );
}

// The E2E-only hook measures one build; it cannot change routing.
async function build(context, options) {
  return hook(context, { kind: 'build', options });
}

async function inspect(context, target) {
  return context.window.evaluate(
    (request) => window.api.browser.inspect(request),
    {
      browserId: context.browserId,
      expectedRuntimeGeneration: context.expectedRuntimeGeneration,
      ...target,
    },
  );
}

async function snapshot(context, request = {}) {
  return context.window.evaluate(
    (input) => window.api.browser.inputSnapshot(input),
    {
      browserId: context.browserId,
      expectedRuntimeGeneration: context.expectedRuntimeGeneration,
      ...request,
    },
  );
}

async function withBrowser(pathOrUrl, callback, { requiresAuth = false } = {}) {
  const launched = await seedPanelWorktree();
  const { electronApp, userDataDir, window } = launched;
  let context;
  try {
    if (requiresAuth) {
      // Only the public synthetic Browser Lab challenge, never host credentials.
      await electronApp.evaluate(({ app }) => {
        app.on('login', (event, _contents, _details, authInfo, answer) => {
          if (authInfo.realm !== 'Browser Lab auth') return;
          event.preventDefault();
          answer('browser-lab-user', 'browser-lab-pass-7Q4M');
        });
      });
    }
    const url = `${pathOrUrl.startsWith('http') ? pathOrUrl : `${lab.primary.origin}${pathOrUrl}`}#page-model-${randomUUID()}`;
    const opened = await dispatch(electronApp, { type: 'browser.open', url });
    expect(opened.ok, JSON.stringify(opened)).toBe(true);
    const browserId = opened.result?.browser?.id;
    const expectedRuntimeGeneration =
      opened.result?.browser?.profile?.runtimeGeneration;
    expect(browserId).toEqual(expect.any(String));
    expect(expectedRuntimeGeneration).toEqual(expect.any(Number));
    context = {
      electronApp,
      window,
      browserId,
      expectedRuntimeGeneration,
      url,
      run: (action) =>
        dispatch(electronApp, {
          browserId,
          expectedRuntimeGeneration,
          ...action,
        }),
    };
    await expect
      .poll(
        () =>
          inPage(
            context,
            `document.readyState === 'complete' && innerWidth > 0 && !!document.body`,
          ).catch(() => false),
        { timeout: 30_000 },
      )
      .toBe(true);
    await callback(context);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
}

// Everything a snapshot says except when it was taken and what it calls
// each row; refs are compared separately, by identity.
function normalizeSnapshot(response) {
  const { capturedAt, frames, ...semantic } = response;
  return {
    ...semantic,
    inputs: response.inputs.map((item, index) => {
      const { ref, ...row } = item;
      return { ...row, ref: `row-${response.offset + index}` };
    }),
  };
}

function normalizeInspect(response) {
  const { capturedAt, ...semantic } = response;
  return semantic;
}

// What every page of a snapshot must satisfy, whatever it contains.
function assertPage(response) {
  expect(response.inputs).toEqual(expect.any(Array));
  expect(response.returned).toBe(response.inputs.length);
  expect(response.truncated).toBe(
    response.offset + response.returned < response.total,
  );
  if (response.truncated)
    expect(response.nextOffset).toBe(response.offset + response.returned);
  else expect(response.nextOffset).toBeUndefined();
}

async function collectRows(context, filter) {
  const rows = [];
  let offset = 0;
  for (;;) {
    const page = await snapshot(context, {
      offset,
      limit: 100,
      ...(filter ? { filter } : {}),
    });
    assertPage(page);
    rows.push(...page.inputs);
    if (!page.truncated) {
      expect(rows).toHaveLength(page.total);
      return rows;
    }
    expect(page.nextOffset).toBeGreaterThan(offset);
    offset = page.nextOffset;
  }
}

// Refs are the model's: unique, stable across a rebuild, and each one
// inspects back to the row's own element. A row keeps a locator only when
// that locator resolves to exactly the same element.
async function assertRefs(context, rows) {
  const refs = rows.map((row) => row.ref);
  for (const ref of refs) expect(ref).toMatch(/^r-.+/);
  expect(new Set(refs).size, 'refs must be unique').toBe(refs.length);
  // A fresh build, not just a cache hit, must preserve node identity.
  await build(context, { cache: 'bypass' });
  expect((await collectRows(context)).map((row) => row.ref)).toEqual(refs);
  for (const [index, row] of rows.entries()) {
    const described = await inspect(context, { ref: row.ref });
    expect(described.tagName, `inspect row ${index}`).toBe(row.tagName);
    expect(described.role, `inspect row ${index}`).toBe(row.role);
    // Inspect withholds at least what the row does. It may withhold more:
    // it also marks an element whose content holds a secret.
    if (row.valueRedacted === true) {
      expect(described.valueRedacted, `inspect row ${index}`).toBe(true);
      expect(described.value, `inspect row ${index}`).toBeUndefined();
    }
    if (row.locator)
      expect(
        normalizeInspect(await inspect(context, { locator: row.locator })),
        `row ${index} locator ${row.locator}`,
      ).toEqual(normalizeInspect(described));
  }
}

async function assertFiltersAndPagination(context, rows) {
  const defaults = await snapshot(context);
  assertPage(defaults);
  expect(defaults.limit).toBe(25);
  expect(defaults.offset).toBe(0);
  expect(defaults.inputs).toEqual(rows.slice(0, 25));
  for (const [offset, limit] of [
    [0, 0],
    [0, 1],
    [1, 3],
    [24, 25],
    [25, 100],
    [0, 1000],
    [rows.length, 25],
    [rows.length + 10, 25],
  ]) {
    const page = await snapshot(context, { offset, limit });
    assertPage(page);
    const effectiveLimit = Math.max(1, Math.min(100, limit));
    expect(page.limit).toBe(effectiveLimit);
    expect(page.total).toBe(rows.length);
    expect(page.inputs).toEqual(rows.slice(offset, offset + effectiveLimit));
  }
  const filters = [
    { name: 'no-such-page-model-control-7f2b' },
    ...[...new Set(rows.map((row) => row.role).filter(Boolean))].map(
      (role) => ({ role: ` ${role.toUpperCase()} ` }),
    ),
    ...[...new Set(rows.map((row) => row.inputType).filter(Boolean))].map(
      (inputType) => ({ inputType: ` ${inputType.toUpperCase()} ` }),
    ),
  ];
  for (const field of ['name', 'text', 'placeholder']) {
    const row = rows.find((candidate) => candidate[field]);
    if (row) {
      const name = ` ${row[field].slice(0, 8).toUpperCase()} `;
      filters.push({ name });
      filters.push({ name, role: row.role, inputType: row.inputType });
    }
  }
  const allRefs = new Set(rows.map((row) => row.ref));
  for (const filter of filters) {
    const filtered = await collectRows(context, filter);
    if (filter.name === 'no-such-page-model-control-7f2b')
      expect(filtered).toHaveLength(0);
    else expect(filtered.length, JSON.stringify(filter)).toBeGreaterThan(0);
    for (const row of filtered) {
      expect(allRefs.has(row.ref)).toBe(true);
      // Exact, case-insensitive role and input type; fuzzy name.
      if (filter.role)
        expect(row.role?.toLowerCase()).toBe(filter.role.trim().toLowerCase());
      if (filter.inputType)
        expect(row.inputType?.toLowerCase()).toBe(
          filter.inputType.trim().toLowerCase(),
        );
    }
    const page = await snapshot(context, { filter, offset: 1, limit: 2 });
    assertPage(page);
    expect(page.inputs).toEqual(filtered.slice(1, 3));
  }
}

test.describe('snapshot and inspect integrity on a page without frames or shadow roots', () => {
  for (const page of LIGHT_PAGES) {
    test(page.path, async () => {
      test.setTimeout(240_000);
      await withBrowser(
        page.path,
        async (context) => {
          await expect
            .poll(() =>
              inPage(
                context,
                `!!document.querySelector(${JSON.stringify(`[data-testid="${page.controls[0]}"]`)})`,
              ),
            )
            .toBe(true);
          expect(
            await inPage(
              context,
              `document.querySelectorAll('iframe, frame').length + Array.from(document.querySelectorAll('*')).filter(element => element.shadowRoot).length`,
            ),
          ).toBe(0);
          const rows = await collectRows(context);
          if (ROWLESS_PAGES.has(page.path)) expect(rows).toEqual([]);
          else expect(rows.length).toBeGreaterThan(0);
          // A row says where it is only when there is something to say.
          for (const row of rows) {
            expect(row).not.toHaveProperty('frameRef');
            expect(row).not.toHaveProperty('inShadowRoot');
          }
          await assertFiltersAndPagination(context, rows);
          await assertRefs(context, rows);
          // Non-row ancestors, labels, and status nodes resolve by locator
          // too, in both the bare and the page.locator(...) forms.
          const presentIds = await inPage(
            context,
            `${JSON.stringify(page.controls)}.filter(id => document.querySelector('[data-testid="' + id + '"]'))`,
          );
          for (const id of presentIds) {
            const bare = await inspect(context, {
              locator: `[data-testid="${id}"]`,
            });
            // An option under a secret select has its attributes withheld.
            if (bare.valueRedacted === true)
              expect([id, '[redacted]']).toContain(
                bare.attributes['data-testid'],
              );
            else expect(bare.attributes['data-testid']).toBe(id);
            expect(
              normalizeInspect(
                await inspect(context, {
                  locator: `page.locator('[data-testid="${id}"]')`,
                }),
              ),
            ).toEqual(normalizeInspect(bare));
          }
        },
        page,
      );
    });
  }
});

test('coordinate inspect finds the element at a point on a scrolled page', async () => {
  test.setTimeout(120_000);
  await withBrowser('/browser-lab/controls', async (context) => {
    const target = await inPage(
      context,
      `(() => { const button = document.querySelector('[data-testid="browser-lab-controls-menu-button"]'); button.scrollIntoView({ block: 'center' }); const rect = button.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, scrollY }; })()`,
    );
    // The point is in viewport coordinates and the page is scrolled, so a
    // hit test that confused the two would land on another element.
    expect(target.scrollY).toBeGreaterThan(0);
    const atPoint = await inspect(context, { x: target.x, y: target.y });
    expect(atPoint.attributes['data-testid']).toBe(
      'browser-lab-controls-menu-button',
    );
    expect(normalizeInspect(atPoint)).toEqual(
      normalizeInspect(
        await inspect(context, {
          locator: '[data-testid="browser-lab-controls-menu-button"]',
        }),
      ),
    );
  });
});

function assertNoSecrets(response, secrets) {
  const serialized = JSON.stringify(response);
  // Seeded values end in a number, so `-1` must not also match `-10`.
  for (const secret of secrets) {
    const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(serialized).not.toMatch(new RegExp(`${escaped}(?!\\d)`));
  }
}

const SECRET_SCOPES = {
  same: {
    prefix: 'browser-lab-frames-same-origin-secret',
    numbers: [1, 2, 3, 13],
    owner: 'browser-lab-frames-same-origin-frame',
  },
  cross: {
    prefix: 'browser-lab-frames-cross-site-secret',
    numbers: [4, 5, 6, 14],
    owner: 'browser-lab-frames-cross-site-frame',
  },
  open: { prefix: 'browser-lab-shadow-open-secret', numbers: [7, 8, 9, 15] },
  closed: {
    prefix: 'browser-lab-shadow-closed-secret',
    numbers: [10, 11, 12, 16],
  },
  scripted: {
    prefix: 'browser-lab-shadow-scripted-secret',
    numbers: [17, 18, 19, 20],
  },
};

function secretValues(scopes) {
  return scopes.flatMap((scope) =>
    scope.numbers.map((number) => `canopy-seeded-secret-${number}`),
  );
}

async function modelRows(context) {
  const rows = [];
  let offset = 0;
  let frames;
  for (;;) {
    const result = await snapshot(context, { offset, limit: 100 });
    assertNoSecrets(result, secretValues(Object.values(SECRET_SCOPES)));
    rows.push(...result.inputs);
    frames = result.frames;
    expect(result.returned).toBe(result.inputs.length);
    if (!result.truncated) {
      expect(rows).toHaveLength(result.total);
      break;
    }
    expect(result.nextOffset).toBeGreaterThan(offset);
    offset = result.nextOffset;
  }
  expect(new Set(rows.map((row) => row.ref)).size).toBe(rows.length);
  return { rows, frames };
}

// A row is identified by its element's own id or test id, read through
// inspect. Its locator need not contain either: a control whose value is
// withheld gets only its CSS path, and a row may have no locator at all.
async function rowElementIds(context, rows) {
  const elementIds = new Map();
  for (const row of rows) {
    const described = await inspect(context, { ref: row.ref });
    elementIds.set(
      row.ref,
      new Set(
        [
          described.attributes?.id,
          described.attributes?.['data-testid'],
        ].filter(Boolean),
      ),
    );
  }
  return elementIds;
}

function rowById(rows, elementIds, id, frameRef) {
  const found = rows.filter(
    (row) =>
      elementIds.get(row.ref)?.has(id) &&
      (!frameRef || row.frameRef === frameRef),
  );
  expect(found, `expected exactly one snapshot row for ${id}`).toHaveLength(1);
  return found[0];
}

async function assertStructuredSecrets(context, scopes, rows, frames) {
  const secrets = secretValues(scopes);
  assertNoSecrets({ rows, frames }, secrets);
  const elementIds = await rowElementIds(context, rows);
  for (const scope of scopes) {
    const scopedCss = (id) =>
      scope.owner
        ? `page.frameLocator('[data-testid="${scope.owner}"]').locator('#${id}')`
        : `#${id}`;
    const ancestor = await inspect(context, {
      locator: scopedCss(`${scope.prefix}-ancestor`),
    });
    expect(ancestor.attributes['data-browser-lab-state']).toBe('revealed');
    assertNoSecrets(ancestor, secrets);
    for (const suffix of ['revealed', 'otp', 'card', 'select', 'mirror']) {
      const id = `${scope.prefix}-${suffix}`;
      const row = rowById(rows, elementIds, id, scope.frameRef);
      expect(row.valueRedacted, id).toBe(true);
      expect(row.value, id).toBeUndefined();
      const described = await inspect(context, { ref: row.ref });
      expect(described.attributes.id).toBe(id);
      expect(described.valueRedacted, id).toBe(true);
      expect(described.value, id).toBeUndefined();
      assertNoSecrets(described, secrets);
      const located = await inspect(context, { locator: scopedCss(id) });
      expect(normalizeInspect(located)).toEqual(normalizeInspect(described));
      assertNoSecrets(located, secrets);
      if (suffix === 'revealed') expect(described.attributes.type).toBe('text');
    }
    const option = await inspect(context, {
      locator: scopedCss(`${scope.prefix}-option`),
    });
    expect(option.valueRedacted).toBe(true);
    expect(option.value).toBeUndefined();
    expect(option.text).toBeUndefined();
    expect(option.accessibleName).toBeUndefined();
    assertNoSecrets(option, secrets);
    // Filters cannot search raw/default/option/mirrored values either.
    for (const secret of secretValues([scope])) {
      const filtered = await snapshot(context, {
        filter: { name: secret },
        limit: 100,
      });
      expect(filtered.total).toBe(0);
      expect(filtered.inputs).toEqual([]);
      // The response echoes the request's filter, which is this test's input.
      assertNoSecrets({ ...filtered, filter: undefined }, secrets);
    }
  }
  // Inspect every returned row, not only the known fields: this includes the
  // focusable ancestors whose text/outerHtml contains secret descendants.
  for (const row of rows) {
    const described = await inspect(context, { ref: row.ref });
    expect(described.tagName).toBe(row.tagName);
    assertNoSecrets(described, secrets);
  }
}

test('frames: coverage, scoped locators through inspect, and seeded secrets', async () => {
  test.setTimeout(240_000);
  await withBrowser('/browser-lab/frames', async (context) => {
    const expectedIds = [
      'browser-lab-frames-same-origin-name',
      'browser-lab-frames-cross-site-name',
      'browser-lab-frames-nested-counter-button',
      'browser-lab-frames-late-button',
    ];
    await expect
      .poll(
        async () => {
          const { rows } = await modelRows(context);
          const elementIds = await rowElementIds(context, rows);
          return expectedIds.every((id) =>
            rows.some((row) => elementIds.get(row.ref)?.has(id)),
          );
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    const { rows, frames } = await modelRows(context);
    const elementIds = await rowElementIds(context, rows);
    expect(frames).toEqual(expect.any(Array));
    // Cross-site fixture coverage alone is not evidence that an OOPIF was
    // walked: independently observe the actual Chromium iframe target.
    const targets = await context.electronApp.evaluate(
      async ({ webContents }, url) => {
        const view = webContents
          .getAllWebContents()
          .find((contents) => contents.getURL() === url);
        if (!view) throw new Error('Frames WebContents missing');
        const result = await view.debugger.sendCommand('Target.getTargets');
        return result.targetInfos.map(({ type, url }) => ({ type, url }));
      },
      context.url,
    );
    expect(
      targets.some(
        (target) =>
          target.type === 'iframe' &&
          target.url ===
            `${lab.paired.origin}/browser-lab/frames/cross-site-form`,
      ),
    ).toBe(true);
    for (const path of [
      '/browser-lab/frames/same-origin-form',
      '/browser-lab/frames/cross-site-form',
      '/browser-lab/frames/nested/1',
      '/browser-lab/frames/nested/2',
      '/browser-lab/frames/nested/3',
      '/browser-lab/frames/late',
    ]) {
      const included = frames.filter(
        (frame) =>
          frame.status === 'included' && new URL(frame.url).pathname === path,
      );
      expect(included.length, `included coverage for ${path}`).toBeGreaterThan(
        0,
      );
      for (const frame of included) expect(frame.frameRef).toMatch(/^f-/);
    }
    // The covered iframe intentionally loads another copy of the same-origin
    // form. Identify the intended frame by scoped inspect, not URL/order.
    const sameLocated = await inspect(context, {
      locator: `page.frameLocator('[data-testid="${SECRET_SCOPES.same.owner}"]').getByTestId('${expectedIds[0]}')`,
    });
    const sameMatches = rows.filter(
      (row) =>
        elementIds.get(row.ref)?.has(expectedIds[0]) &&
        JSON.stringify(row.bounds) === JSON.stringify(sameLocated.bounds),
    );
    expect(sameMatches).toHaveLength(1);
    const same = sameMatches[0];
    const cross = rowById(rows, elementIds, expectedIds[1]);
    expect(same.frameRef).toMatch(/^f-/);
    expect(cross.frameRef).toMatch(/^f-/);
    expect(same.frameRef).not.toBe(cross.frameRef);
    for (const frame of frames.filter(
      (candidate) => candidate.status === 'included',
    )) {
      const url = new URL(frame.url);
      expect(url.search).toBe('');
      expect(url.hash).toBe('');
      expect(url.username).toBe('');
      expect(url.password).toBe('');
    }
    for (const id of expectedIds) {
      const row = rowById(
        rows,
        elementIds,
        id,
        id === expectedIds[0] ? same.frameRef : undefined,
      );
      expect(row.frameRef).toMatch(/^f-/);
      const described = await inspect(context, { ref: row.ref });
      expect(described.attributes['data-testid']).toBe(id);
    }
    await assertStructuredSecrets(
      context,
      [{ ...SECRET_SCOPES.same, frameRef: same.frameRef }, SECRET_SCOPES.cross],
      rows,
      frames,
    );
    const frameSelector = '[data-testid="browser-lab-frames-cross-site-frame"]';
    const scoped = (inner) => `page.frameLocator('${frameSelector}').${inner}`;
    // The input's id is `frame-name` in every frame; only its test id is
    // unique across the page.
    const crossName = '[data-testid=browser-lab-frames-cross-site-name]';
    for (const locator of [
      crossName,
      `css=${crossName}`,
      `page.locator('${crossName}')`,
      `page.locator('[data-testid="browser-lab-frames-cross-site-name"]')`,
      `page.getByTestId('browser-lab-frames-cross-site-name')`,
      scoped(`locator('#frame-name')`),
      scoped(`getByTestId('browser-lab-frames-cross-site-name')`),
      scoped(`getByRole('textbox', { name: 'Name' })`),
      scoped(`getByLabel('Name')`),
    ]) {
      expect(
        (await inspect(context, { locator })).attributes['data-testid'],
      ).toBe(expectedIds[1]);
    }
    expect(
      (
        await inspect(context, {
          locator: scoped(`getByPlaceholder('Revealed password')`),
        })
      ).attributes.id,
    ).toBe(`${SECRET_SCOPES.cross.prefix}-revealed`);
    expect(
      (
        await inspect(context, {
          locator: scoped(`getByAltText('Page model fixture image')`),
        })
      ).attributes.id,
    ).toBe(`${SECRET_SCOPES.cross.prefix}-image`);
    for (const locator of [
      scoped(`getByText('Cross-site collision button')`),
      'text=Cross-site collision button',
    ])
      expect((await inspect(context, { locator })).attributes.id).toBe(
        'collision-button',
      );
    // Main and child deliberately share an id; unscoped lookup must not pick
    // either merely because its document/process was enumerated first.
    const ambiguous = await context.run({
      type: 'browser.inspect',
      locator: '#collision-button',
    });
    expect(ambiguous.ok).toBe(false);
    expect(JSON.stringify(ambiguous)).toContain('target_ambiguous');
    expect(
      (
        await inspect(context, {
          locator: scoped(`locator('#collision-button')`),
        })
      ).text,
    ).toBe('Cross-site collision button');
    const nestedLocator = `page.frameLocator('[data-testid="browser-lab-frames-nested-frame"]').frameLocator('[data-testid="browser-lab-frames-nested-1-child-frame"]').frameLocator('[data-testid="browser-lab-frames-nested-2-child-frame"]').getByTestId('browser-lab-frames-nested-counter-button')`;
    expect(
      (await inspect(context, { locator: nestedLocator })).attributes[
        'data-testid'
      ],
    ).toBe('browser-lab-frames-nested-counter-button');
    const rebuilt = await build(context, { cache: 'bypass' });
    expect(rebuilt.coverage.length).toBeGreaterThan(0);
    const again = await modelRows(context);
    expect(again.rows.map((row) => row.ref)).toEqual(
      rows.map((row) => row.ref),
    );
  });
});

test('the build hook reports stage timings, and the optional stages change no row', async () => {
  test.setTimeout(120_000);
  await withBrowser('/browser-lab/controls', async (context) => {
    const before = await snapshot(context, { limit: 100 });
    assertPage(before);
    const ordinary = await build(context, {
      cache: 'bypass',
      accessibility: false,
      listeners: false,
    });
    expect(ordinary.cached).toBe(false);
    expect(ordinary.durationMs).toBeGreaterThanOrEqual(0);
    expect(ordinary.counts.nodes).toBeGreaterThan(0);
    expect(ordinary.counts.frames).toBeGreaterThan(0);
    expect(ordinary.counts.inputs).toBeGreaterThan(0);
    expect(ordinary.coverage.length).toBeGreaterThan(0);
    for (const timing of ['extractionMs', 'assemblyMs', 'totalMs'])
      expect(ordinary.timings[timing]).toBeGreaterThanOrEqual(0);
    const cached = await build(context, { cache: 'use' });
    expect(cached.cached).toBe(true);
    const optional = await build(context, {
      cache: 'bypass',
      accessibility: true,
      listeners: true,
    });
    expect(optional.cached).toBe(false);
    expect(optional.timings.accessibilityMs).toBeGreaterThanOrEqual(0);
    expect(optional.timings.listenersMs).toBeGreaterThanOrEqual(0);
    // The page registers click and pointerdown listeners with
    // addEventListener. A scan that finds none is not reading the world the
    // page's scripts run in, and its cost says nothing about a real scan.
    expect(optional.counts.listenerHits).toBeGreaterThan(0);
    expect(optional.counts.accessibilityNodes).toBeGreaterThan(0);
    expect(ordinary.counts.listenerHits).toBe(0);
    expect(ordinary.counts.accessibilityNodes).toBe(0);
    // Rows and names do not use the optional stages.
    const after = await snapshot(context, { limit: 100 });
    expect(normalizeSnapshot(after)).toEqual(normalizeSnapshot(before));
    expect(after.inputs.map((row) => row.ref)).toEqual(
      before.inputs.map((row) => row.ref),
    );
  });
});

test('shadow roots: open, closed and nested rows, every locator form through inspect, and seeded secrets', async () => {
  test.setTimeout(180_000);
  await withBrowser('/browser-lab/shadow', async (context) => {
    const { rows, frames } = await modelRows(context);
    const elementIds = await rowElementIds(context, rows);
    for (const [id, text] of [
      ['browser-lab-shadow-open-button', 'Open-root action'],
      ['browser-lab-shadow-nested-button', 'Two levels deep'],
    ]) {
      const row = rowById(rows, elementIds, id);
      expect(row.inShadowRoot).toBe(true);
      expect((await inspect(context, { ref: row.ref })).text).toBe(text);
    }
    const closed = rows.filter((row) => row.text === 'Closed-root action');
    expect(closed).toHaveLength(1);
    expect(closed[0].inShadowRoot).toBe(true);
    expect((await inspect(context, { ref: closed[0].ref })).text).toBe(
      'Closed-root action',
    );
    await assertStructuredSecrets(
      context,
      [SECRET_SCOPES.open, SECRET_SCOPES.closed, SECRET_SCOPES.scripted],
      rows,
      frames,
    );
    for (const locator of [
      '#open-note',
      'css=#open-note',
      "page.locator('#open-note')",
      "page.getByTestId('browser-lab-shadow-open-input')",
      "page.getByRole('textbox', { name: 'Note' })",
      "page.getByLabel('Note')",
    ])
      expect((await inspect(context, { locator })).attributes.id).toBe(
        'open-note',
      );
    expect(
      (
        await inspect(context, {
          locator: "page.getByLabel('Account reference')",
        })
      ).attributes.id,
    ).toBe('account-input');
    for (const locator of [
      "page.getByRole('button', { name: 'Closed-root action' })",
      "page.getByText('Closed-root action')",
      'text=Closed-root action',
    ])
      expect((await inspect(context, { locator })).text).toBe(
        'Closed-root action',
      );
    // Alt/placeholder names deliberately collide between the roots; use unique
    // CSS for the other nodes, and assert ambiguity rather than pick an
    // arbitrary root for an unscoped semantic lookup.
    for (const locator of [
      "page.getByAltText('Page model fixture image')",
      "page.getByPlaceholder('Revealed password')",
    ]) {
      const ambiguous = await context.run({ type: 'browser.inspect', locator });
      expect(ambiguous.ok).toBe(false);
      expect(JSON.stringify(ambiguous)).toContain('target_ambiguous');
    }
    // Give the open-root targets distinct public names using fixture setup.
    // This also checks that shadow DOM attribute changes invalidate the model,
    // rather than serving the previous ambiguous cached result for 500 ms.
    await inPage(
      context,
      `(() => {
      const root = document.querySelector('[data-testid="browser-lab-shadow-open-host"]').shadowRoot;
      root.querySelector('#${SECRET_SCOPES.open.prefix}-image').setAttribute('alt', 'Open page model fixture image');
      root.querySelector('#${SECRET_SCOPES.open.prefix}-revealed').setAttribute('placeholder', 'Open revealed password');
      const scripted = document.querySelector('[data-testid="browser-lab-shadow-scripted-host"]').shadowRoot;
      scripted.querySelector('#${SECRET_SCOPES.scripted.prefix}-image').setAttribute('alt', 'Scripted page model fixture image');
      scripted.querySelector('#${SECRET_SCOPES.scripted.prefix}-revealed').setAttribute('placeholder', 'Scripted revealed password');
      return true;
    })()`,
    );
    for (const [locator, id] of [
      [
        "page.getByAltText('Open page model fixture image')",
        `${SECRET_SCOPES.open.prefix}-image`,
      ],
      [
        "page.getByAltText('Page model fixture image')",
        `${SECRET_SCOPES.closed.prefix}-image`,
      ],
      [
        "page.getByPlaceholder('Open revealed password')",
        `${SECRET_SCOPES.open.prefix}-revealed`,
      ],
      [
        "page.getByPlaceholder('Revealed password')",
        `${SECRET_SCOPES.closed.prefix}-revealed`,
      ],
    ]) {
      const described = await inspect(context, { locator });
      expect(described.attributes.id).toBe(id);
      assertNoSecrets(
        described,
        secretValues([
          SECRET_SCOPES.open,
          SECRET_SCOPES.closed,
          SECRET_SCOPES.scripted,
        ]),
      );
    }
    expect(
      (
        await inspect(context, {
          locator: `#${SECRET_SCOPES.closed.prefix}-image`,
        })
      ).attributes.alt,
    ).toBe('Page model fixture image');
    expect(
      (
        await inspect(context, {
          locator: "page.getByTestId('browser-lab-shadow-nested-button')",
        })
      ).text,
    ).toBe('Two levels deep');
    await build(context, { cache: 'bypass' });
    expect((await modelRows(context)).rows.map((row) => row.ref)).toEqual(
      rows.map((row) => row.ref),
    );
  });
});

// Keep the sign-in markup and assertion matrix aligned with the B1 test in
// browser-chrome.spec.mjs. It is intentionally self-contained: importing that
// spec would register its unrelated tests and lifecycle hooks in this suite.
async function startB1Fixture() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(`<!doctype html><html>
      <head><title>Canopy Browser Sign-in Fixture</title></head><body>
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
          const value = `private-month-${String(index + 1).padStart(2, '0')}`;
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
        for (const input of document.querySelectorAll('input')) {
          input.addEventListener('input', () => input.setAttribute('value', input.value));
        }
      </script></body></html>`);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing B1 listener');
  return {
    url: `http://127.0.0.1:${address.port}/sign-in`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

test('sign-in redaction holds on the page model, including every inspect field', async () => {
  test.setTimeout(240_000);
  const fixture = await startB1Fixture();
  const password = 'agent-password-secret-7429';
  const revealedPassword = 'agent-revealed-password-secret-7621';
  const code = 'agent-code-secret-5813';
  const secrets = [
    password,
    revealedPassword,
    code,
    'textarea-otp-secret-9284',
    'labelled-otp-secret-7319',
    'wrapped-otp-secret-8426',
    ...Array.from(
      { length: 12 },
      (_, index) => `private-month-${String(index + 1).padStart(2, '0')}`,
    ),
    'private-custom-month-01',
    'private-custom-month-11',
    'private-cardholder-9284',
  ];
  try {
    await withBrowser(fixture.url, async (context) => {
      for (const [locator, text] of [
        ['#username', 'ada'],
        ['#password', password],
        ['#revealable-password', revealedPassword],
        ['#code', code],
      ]) {
        const result = await context.run({
          type: 'browser.fill',
          locator,
          text,
        });
        expect(result.ok, JSON.stringify(result)).toBe(true);
      }
      const revealed = await context.run({
        type: 'browser.click',
        locator: '#reveal-password',
      });
      expect(revealed.ok, JSON.stringify(revealed)).toBe(true);
      expect(
        await inPage(
          context,
          "document.querySelector('#revealable-password').type",
        ),
      ).toBe('text');
      const response = await snapshot(context, { limit: 100 });
      assertPage(response);
      assertNoSecrets(response, secrets);
      expect(JSON.stringify(response)).not.toMatch(/private-(year|range)-/);
      expect(response.inputs.some((row) => row.value === 'ada')).toBe(true);
      expect(response.inputs.some((row) => row.valueRedacted === true)).toBe(
        true,
      );
      const inspections = new Map();
      for (const locator of [
        '#username',
        '#password',
        '#revealable-password',
        '#code',
        '#sign-in',
        '#secret-expiry option:checked',
        '#secret-expiry option:first-child',
        '#secret-expiry',
        '#selected-years',
        '#secret-year',
        '#secret-textarea',
        '#labelled-otp',
        '#wrapped-otp',
        '#custom-expiry option:checked span',
        '#custom-expiry-mirror',
        '#custom-select-form',
        '#cardholder-name',
      ]) {
        const inspected = await inspect(context, { locator });
        inspections.set(locator, inspected);
        assertNoSecrets(inspected, secrets);
        expect(JSON.stringify(inspected)).not.toMatch(/private-(year|range)-/);
      }
      expect(inspections.get('#username').value).toBe('ada');
      for (const locator of [
        '#password',
        '#revealable-password',
        '#code',
        '#secret-textarea',
        '#labelled-otp',
        '#wrapped-otp',
        '#cardholder-name',
      ]) {
        expect(inspections.get(locator).valueRedacted).toBe(true);
        expect(inspections.get(locator).value).toBeUndefined();
      }
      const option = inspections.get('#secret-expiry option:checked');
      expect(option.valueRedacted).toBe(true);
      expect(option.attributes.label).toBe('[redacted]');
      expect(JSON.stringify(option)).not.toContain('nth-of-type(11)');
      const group = inspections.get('#selected-years');
      expect(group.valueRedacted).toBe(true);
      expect(group.attributes.label).toBe('[redacted]');
      expect(group.text).toBeUndefined();
      expect(group.accessibleName).toBeUndefined();
      expect(JSON.stringify(group)).not.toContain('nth-of-type(2)');
      expect(group.outerHtml).not.toMatch(/\sselected(?:\s|>)/);
      await assertRefs(context, response.inputs);
      // Recording describes elements from the page itself and must hold the
      // same line.
      await context.window.evaluate(
        (browserId) => window.api.browser.startRecording({ browserId }),
        context.browserId,
      );
      await inPage(
        context,
        `document.querySelector('#custom-expiry option:checked span').dispatchEvent(new MouseEvent('click', { bubbles: true }))`,
      );
      const recording = await context.window.evaluate(
        (browserId) => window.api.browser.stopRecording({ browserId }),
        context.browserId,
      );
      assertNoSecrets(recording, secrets);
      expect(JSON.stringify(recording)).not.toContain('nth-of-type(2)');
    });
  } finally {
    await fixture.close();
  }
});
