// ---------------------------------------------------------------------------
// Transcript Linear references stay put while titles load, refresh and reload
// (CAN-3978).
//
// Seeded chats against the shared GraphQL mock, with a gate on main's
// `globalThis.fetch` that holds (or fails) Linear preview requests until the
// test releases them, so "before the provider answers" is a state the test
// controls instead of a race. Flows:
//   - a window reload paints saved icons and titles before any provider
//     answer, and the references keep their exact boxes once it settles;
//   - a different account or a disconnect across a reload clears saved titles;
//   - a team catalog older than five minutes refreshes (held, answered, and
//     failed) without any reference reverting to plain text;
//   - more than 200 references across transcripts: an earlier transcript
//     shows its titles at once, with no placeholder and no new reads;
//   - the loading placeholder reserves the title's width, so the following
//     words barely move when the title arrives.
// ---------------------------------------------------------------------------
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedWorktreeChat,
} from './seeders/index.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const STORAGE_KEY = 'canopy.referencePreviews.v1';
const AT = Date.parse('2026-10-01T10:00:00.000Z');
const FIVE_MINUTES = 5 * 60 * 1000;
const TEAMS = [
  { id: 'team_can', key: 'CAN', name: 'Canopy' },
  { id: 'team_ecw', key: 'ECW', name: 'Ecommerce' },
];

const KNOWN_CHAT = 'stability-known';
const KNOWN_TEXT = [
  'CAN-42 still needs visual evidence, and ECW-7 ships after it.',
  '',
  'See https://linear.app/acme/issue/CAN-42 for the plan.',
].join('\n');
const KNOWN_ISSUES = [
  {
    id: 'iss_can_42',
    identifier: 'CAN-42',
    title: 'Keep Linear reference titles stable across reloads',
    url: 'https://linear.app/acme/issue/CAN-42/keep-titles-stable',
  },
  {
    id: 'iss_ecw_7',
    identifier: 'ECW-7',
    title: 'Checkout copy',
    url: 'https://linear.app/acme/issue/ECW-7/checkout-copy',
  },
];
const KNOWN_LABELS = [
  `CAN-42: ${KNOWN_ISSUES[0].title}`,
  'ECW-7: Checkout copy',
  `CAN-42: ${KNOWN_ISSUES[0].title}`,
];

function message(id, role, text, offset) {
  return { id, role, blocks: [{ type: 'text', text }], timestamp: AT + offset };
}

function seedChats(userDataDir, tabs) {
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: tabs[0].id,
    tabs: tabs.map(({ id, title, text }, index) => ({
      id,
      title,
      messages: [
        message(`${id}-user`, 'user', 'Status?', index * 10_000),
        ...(Array.isArray(text) ? text : [text]).map((part, offset) =>
          message(
            `${id}-assistant-${offset}`,
            'assistant',
            part,
            index * 10_000 + 5_000 + offset,
          ),
        ),
      ],
    })),
  });
}

const KNOWN_TAB = { id: KNOWN_CHAT, title: 'Known tickets', text: KNOWN_TEXT };

async function launch(prefix, tabs, token, issues) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), prefix));
  seedChats(userDataDir, tabs);
  await registerScenario(DEFAULT_MOCK_BASE_URL, token, {
    linear: { previewTeams: TEAMS, issues },
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await instrumentProvider(electronApp);
  await window.evaluate((value) => window.api.saveLinearToken(value), token);
  return { userDataDir, electronApp, window, app };
}

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

// Records the references in the first DOM state that shows `marker` in the
// chat, before any frame paints: what the user sees first after a reload.
async function recordFirstRender(window, chatId, marker) {
  await window.addInitScript(
    ({ panel, text }) => {
      const record = () => {
        const chat = document.querySelector(
          `[data-testid="panel-content-chat"][data-panel-id="${panel}"]`,
        );
        if (!chat?.textContent?.includes(text)) return false;
        window.__firstRender = Array.from(
          chat.querySelectorAll('[data-testid="linear-reference"]'),
          (element) => element.textContent,
        );
        return true;
      };
      const observer = new MutationObserver(() => {
        if (record()) observer.disconnect();
      });
      observer.observe(document, { childList: true, subtree: true });
    },
    { panel: `panel-chat-${chatId}`, text: marker },
  );
}

async function reloadInto(window, app, chatId) {
  await window.reload();
  await app.waitForShell({ timeout: 30_000 });
  return openChat(window, app, chatId);
}

// Main's Linear SDK resolves `globalThis.fetch` per request. Count preview
// requests sent and answered per operation, and let the test hold an
// operation behind a gate that it later answers or fails.
async function instrumentProvider(electronApp) {
  await electronApp.evaluate(() => {
    const original = globalThis.fetch;
    const state = {
      sent: { issue: 0, teams: 0 },
      held: { issue: 0, teams: 0 },
      answered: { issue: 0, teams: 0 },
      gates: {},
    };
    Reflect.set(globalThis, '__linearStability', state);
    globalThis.fetch = async (input, init) => {
      const body = typeof init?.body === 'string' ? init.body : '';
      const operation = body.includes('referencePreviewIssue')
        ? 'issue'
        : body.includes('referencePreviewTeams')
          ? 'teams'
          : null;
      if (operation === null) return original(input, init);
      state.sent[operation] += 1;
      const gate = state.gates[operation];
      if (gate) {
        state.held[operation] += 1;
        if ((await gate.promise) === 'fail') {
          throw new TypeError('fetch failed');
        }
      }
      const response = await original(input, init);
      state.answered[operation] += 1;
      return response;
    };
  });
}

function hold(electronApp, operations = ['issue', 'teams']) {
  return electronApp.evaluate((_electron, names) => {
    const state = Reflect.get(globalThis, '__linearStability');
    for (const name of names) {
      if (state.gates[name]) continue;
      let release = () => undefined;
      const promise = new Promise((resolve) => {
        release = resolve;
      });
      state.gates[name] = { promise, release };
    }
  }, operations);
}

/** Answers (or, with `fail`, rejects) every request held for `operations`. */
function release(electronApp, operations = ['issue', 'teams'], outcome) {
  return electronApp.evaluate(
    (_electron, { names, result }) => {
      const state = Reflect.get(globalThis, '__linearStability');
      if (!state) return;
      for (const name of names) {
        const gate = state.gates[name];
        delete state.gates[name];
        gate?.release(result);
      }
    },
    { names: operations, result: outcome ?? 'answer' },
  );
}

function providerState(electronApp) {
  return electronApp.evaluate(() => {
    const { sent, held, answered } = Reflect.get(
      globalThis,
      '__linearStability',
    );
    return { sent: { ...sent }, held: { ...held }, answered: { ...answered } };
  });
}

function savedPreviews(window) {
  return window.evaluate((key) => {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    const parsed = JSON.parse(raw);
    return {
      scope: parsed.scope ?? null,
      titles: (parsed.entries ?? []).map((entry) => entry.preview.title),
      catalog: parsed.catalog?.keys ?? null,
    };
  }, STORAGE_KEY);
}

// The 250 ms write debounce has flushed both the titles and the catalog.
// KNOWN_TEXT saves three entries: bare CAN-42, ECW-7, and the acme URL.
async function waitForSavedTitles(window, count = 3) {
  await expect
    .poll(async () => {
      const saved = await savedPreviews(window);
      return saved ? [saved.titles.length, saved.catalog] : null;
    })
    .toEqual([count, ['CAN', 'ECW']]);
}

/** Each reference's label and box, plus whether it shows a placeholder. */
function readReferences(chat) {
  return chat.evaluate((root) =>
    Array.from(root.querySelectorAll('[data-testid="linear-reference"]')).map(
      (element) => {
        const rect = element.getBoundingClientRect();
        return {
          text: element.textContent,
          icon:
            element.querySelectorAll(':scope > svg[aria-hidden="true"]')
              .length === 1,
          placeholder:
            element.querySelector(
              '[data-testid="linear-reference-title-placeholder"]',
            ) !== null,
          rect: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          },
        };
      },
    ),
  );
}

// Sample the transcript repeatedly; every sample must show every reference
// decorated with its title. Catches a flicker between two polls of `expect`.
async function expectDecoratedThroughout(window, chat, labels, samples = 12) {
  for (let sample = 0; sample < samples; sample += 1) {
    const references = await readReferences(chat);
    expect(references.map(({ text }) => text)).toEqual(labels);
    expect(references.every(({ icon }) => icon)).toBe(true);
    expect(references.some(({ placeholder }) => placeholder)).toBe(false);
    await window.waitForTimeout(100);
  }
}

test('a reload paints saved icons and titles before the provider answers', async () => {
  test.setTimeout(120_000);
  const { userDataDir, electronApp, window, app } = await launch(
    'canopy-linear-reload-',
    [KNOWN_TAB],
    'lin_api_e2e_stability_reload',
    KNOWN_ISSUES,
  );
  try {
    const chat = await openChat(window, app, KNOWN_CHAT);
    const references = chat.getByTestId('linear-reference');
    await expect(references).toHaveText(KNOWN_LABELS);
    await waitForSavedTitles(window);
    const before = await providerState(electronApp);

    await hold(electronApp);
    await recordFirstRender(window, KNOWN_CHAT, 'still needs visual evidence');
    const reloaded = await reloadInto(window, app, KNOWN_CHAT);
    const reloadedReferences = reloaded.getByTestId('linear-reference');
    await expect(reloadedReferences).toHaveText(KNOWN_LABELS);
    // The first render already carried the titles, not a later read.
    expect(
      await window.evaluate(() => Reflect.get(window, '__firstRender')),
    ).toEqual(KNOWN_LABELS);
    for (const reference of await reloadedReferences.all()) {
      await expect(reference.locator('svg[aria-hidden="true"]')).toHaveCount(1);
    }
    await expect(
      reloaded.getByTestId('linear-reference-title-placeholder'),
    ).toHaveCount(0);
    // Only saved data can have painted: no preview answer since the reload.
    expect((await providerState(electronApp)).answered).toEqual(
      before.answered,
    );
    // Boxes at first paint, once the clip has measured on the next frames.
    await window.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const firstPaint = await readReferences(reloaded);

    // The background scope confirm and any refresh change nothing on screen.
    await release(electronApp);
    await window.waitForTimeout(1_500);
    const settled = await readReferences(reloaded);
    expect(settled).toEqual(firstPaint);
    expect(settled.map(({ text }) => text)).toEqual(KNOWN_LABELS);
  } finally {
    await release(electronApp).catch(() => undefined);
    await closeCanopy(electronApp, userDataDir).catch(() => undefined);
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('another account or a disconnect across a reload clears saved titles', async () => {
  test.setTimeout(150_000);
  const TOKEN = 'lin_api_e2e_stability_account_a';
  const OTHER_TOKEN = 'lin_api_e2e_stability_account_b';
  const OTHER_TITLE = 'Seen from the second account';
  const { userDataDir, electronApp, window, app } = await launch(
    'canopy-linear-scope-',
    [KNOWN_TAB],
    TOKEN,
    KNOWN_ISSUES,
  );
  try {
    await registerScenario(DEFAULT_MOCK_BASE_URL, OTHER_TOKEN, {
      linear: {
        previewTeams: TEAMS,
        issues: [
          { ...KNOWN_ISSUES[0], title: OTHER_TITLE },
          { ...KNOWN_ISSUES[1], title: 'Second account copy' },
        ],
      },
    });
    const chat = await openChat(window, app, KNOWN_CHAT);
    await expect(chat.getByTestId('linear-reference')).toHaveText(KNOWN_LABELS);
    await waitForSavedTitles(window);
    const firstScope = (await savedPreviews(window)).scope;

    // Switch accounts behind the renderer's back: only the reload's
    // background scope confirm can notice.
    await window.evaluate(
      (value) => window.api.saveLinearToken(value),
      OTHER_TOKEN,
    );
    expect((await savedPreviews(window)).scope).toBe(firstScope);
    const before = await providerState(electronApp);
    await hold(electronApp, ['issue']);
    const switched = await reloadInto(window, app, KNOWN_CHAT);
    // The saved titles belong to the other scope: they leave and the
    // references wait for a fresh read.
    await expect(switched).not.toContainText(KNOWN_ISSUES[0].title);
    await expect(switched).not.toContainText('Checkout copy');
    await expect(
      switched.getByTestId('linear-reference-title-placeholder'),
    ).not.toHaveCount(0);
    await release(electronApp, ['issue']);
    await expect(switched.getByTestId('linear-reference')).toHaveText([
      `CAN-42: ${OTHER_TITLE}`,
      'ECW-7: Second account copy',
      `CAN-42: ${OTHER_TITLE}`,
    ]);
    const after = await providerState(electronApp);
    expect(after.answered.issue).toBeGreaterThan(before.answered.issue);
    await expect
      .poll(async () => (await savedPreviews(window))?.scope)
      .not.toBe(firstScope);

    // Disconnect behind the renderer's back, then reload: decorations leave
    // and the saved cache is invalidated.
    await waitForSavedTitles(window);
    await window.evaluate(() => window.api.saveLinearToken(''));
    expect(await savedPreviews(window)).not.toBeNull();
    const disconnected = await reloadInto(window, app, KNOWN_CHAT);
    await expect(disconnected).toContainText('still needs visual evidence');
    await expect(disconnected.getByTestId('linear-reference')).toHaveCount(0);
    await expect(disconnected).not.toContainText(OTHER_TITLE);
    await expect(
      disconnected.locator('a[href="https://linear.app/acme/issue/CAN-42"]'),
    ).toHaveCount(1);
    await expect.poll(() => savedPreviews(window)).toBeNull();
  } finally {
    await release(electronApp).catch(() => undefined);
    await closeCanopy(electronApp, userDataDir).catch(() => undefined);
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

// The renderer's five-minute catalog timer runs on Playwright's fake clock
// (installed, then a reload so every store timer is fake); main's catalog
// cache reads `Date.now`, which the test offsets by the same amount so main
// also treats its catalog as stale and asks the provider again.
async function advanceBothClocks(window, electronApp, ms) {
  await electronApp.evaluate((_electron, delta) => {
    const clock = Reflect.get(globalThis, '__linearStabilityClock') ?? {
      now: Date.now,
      offset: 0,
    };
    if (!Reflect.has(globalThis, '__linearStabilityClock')) {
      Reflect.set(globalThis, '__linearStabilityClock', clock);
      Date.now = () => clock.now() + clock.offset;
    }
    clock.offset += delta;
  }, ms);
  await window.clock.fastForward(ms);
}

test('references stay decorated across a stale team-catalog refresh', async () => {
  test.setTimeout(150_000);
  const { userDataDir, electronApp, window, app } = await launch(
    'canopy-linear-expiry-',
    [KNOWN_TAB],
    'lin_api_e2e_stability_expiry',
    KNOWN_ISSUES,
  );
  try {
    await window.clock.install();
    const chat = await reloadInto(window, app, KNOWN_CHAT);
    await expect(chat.getByTestId('linear-reference')).toHaveText(KNOWN_LABELS);
    await waitForSavedTitles(window);

    // A slow refresh: past five minutes, the catalog request is held.
    const start = await providerState(electronApp);
    await hold(electronApp, ['teams']);
    await advanceBothClocks(window, electronApp, FIVE_MINUTES + 60_000);
    await expect
      .poll(async () => (await providerState(electronApp)).held.teams)
      .toBe(start.held.teams + 1);
    await expectDecoratedThroughout(window, chat, KNOWN_LABELS);
    await release(electronApp, ['teams']);
    await expect
      .poll(async () => (await providerState(electronApp)).answered.teams)
      .toBe(start.answered.teams + 1);
    await expectDecoratedThroughout(window, chat, KNOWN_LABELS);

    // A failed refresh keeps the last catalog's keys.
    const failedStart = await providerState(electronApp);
    await hold(electronApp, ['teams']);
    await advanceBothClocks(window, electronApp, FIVE_MINUTES + 60_000);
    await expect
      .poll(async () => (await providerState(electronApp)).held.teams)
      .toBe(failedStart.held.teams + 1);
    await expectDecoratedThroughout(window, chat, KNOWN_LABELS, 5);
    await release(electronApp, ['teams'], 'fail');
    await window.waitForTimeout(300);
    expect((await providerState(electronApp)).answered.teams).toBe(
      failedStart.answered.teams,
    );
    await expectDecoratedThroughout(window, chat, KNOWN_LABELS);
  } finally {
    await release(electronApp).catch(() => undefined);
    await closeCanopy(electronApp, userDataDir).catch(() => undefined);
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

const MANY_TABS = [1, 2, 3].map((tab) => ({
  id: `stability-many-${tab}`,
  title: `Many tickets ${tab}`,
  numbers: Array.from({ length: 120 }, (_, index) => tab * 1000 + index + 1),
}));

test('an earlier transcript keeps its titles after 360 other references load', async () => {
  test.setTimeout(240_000);
  const tabs = MANY_TABS.map(({ id, title, numbers }) => ({
    id,
    title,
    // A block decorates at most 100 references; two messages of 60.
    text: [numbers.slice(0, 60), numbers.slice(60)].map((part) =>
      part.map((number) => `- CAN-${number} is tracked.`).join('\n'),
    ),
  }));
  const issues = MANY_TABS.flatMap(({ numbers }) =>
    numbers.map((number) => ({
      id: `iss_can_${number}`,
      identifier: `CAN-${number}`,
      title: `Ticket ${number}`,
    })),
  );
  const { userDataDir, electronApp, window, app } = await launch(
    'canopy-linear-many-',
    tabs,
    'lin_api_e2e_stability_many',
    issues,
  );
  try {
    // Scroll each transcript until every reference has read its title.
    for (const { id, numbers } of MANY_TABS) {
      const chat = await openChat(window, app, id);
      await expect(chat.getByTestId('linear-reference')).toHaveCount(120);
      await expect
        .poll(
          () =>
            chat.evaluate((root) => {
              const references = Array.from(
                root.querySelectorAll('[data-testid="linear-reference"]'),
              );
              const loading = references.find(
                (element) =>
                  !element.querySelector(
                    '[data-testid="linear-reference-title"]',
                  ),
              );
              loading?.scrollIntoView({ block: 'center' });
              return loading ? 'loading' : 'loaded';
            }),
          { timeout: 90_000, intervals: [200] },
        )
        .toBe('loaded');
      await expect(chat.getByTestId('linear-reference').first()).toHaveText(
        `CAN-${numbers[0]}: Ticket ${numbers[0]}`,
      );
    }
    const loaded = await providerState(electronApp);
    expect(loaded.answered.issue).toBe(360);

    const first = await openChat(window, app, MANY_TABS[0].id);
    await expect(first.getByTestId('linear-reference')).toHaveCount(120);
    // One snapshot as the transcript appears: every title, no placeholder.
    const shown = await first.evaluate((root) => ({
      titles: root.querySelectorAll('[data-testid="linear-reference-title"]')
        .length,
      placeholders: root.querySelectorAll(
        '[data-testid="linear-reference-title-placeholder"]',
      ).length,
    }));
    expect(shown).toEqual({ titles: 120, placeholders: 0 });
    await window.waitForTimeout(1_000);
    expect((await providerState(electronApp)).sent.issue).toBe(
      loaded.sent.issue,
    );
  } finally {
    await closeCanopy(electronApp, userDataDir).catch(() => undefined);
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

const FRESH_CHAT = 'stability-fresh';
const FRESH_TITLE =
  'Reserve space for loading reference titles while the provider answers';
const FRESH_TEXT =
  'CAN-77 is new here; this prose keeps going after the reference.';

/** The reference's box, the next word's box, and the placeholder's width. */
function measureFollowingWord(reference) {
  return reference.evaluate((element) => {
    const paragraph = element.closest('p');
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
    let text = null;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const after =
        element.compareDocumentPosition(node) &
        Node.DOCUMENT_POSITION_FOLLOWING;
      if (after && !element.contains(node) && node.data.trim()) {
        text = node;
        break;
      }
    }
    const start = text.data.search(/\S/);
    const range = document.createRange();
    range.setStart(text, start);
    range.setEnd(text, start + text.data.slice(start).search(/\s|$/));
    const word = range.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    const placeholder = element.querySelector(
      '[data-testid="linear-reference-title-placeholder"]',
    );
    return {
      word: range.toString(),
      wordX: word.x,
      wordY: word.y,
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      placeholder: placeholder?.getBoundingClientRect().width ?? null,
    };
  });
}

test('the loading placeholder holds the title width while it loads', async () => {
  test.setTimeout(120_000);
  const { userDataDir, electronApp, window, app } = await launch(
    'canopy-linear-placeholder-',
    [KNOWN_TAB, { id: FRESH_CHAT, title: 'Fresh ticket', text: FRESH_TEXT }],
    'lin_api_e2e_stability_placeholder',
    [
      ...KNOWN_ISSUES,
      { id: 'iss_can_77', identifier: 'CAN-77', title: FRESH_TITLE },
    ],
  );
  try {
    const known = await openChat(window, app, KNOWN_CHAT);
    await expect(known.getByTestId('linear-reference')).toHaveText(
      KNOWN_LABELS,
    );

    await hold(electronApp, ['issue']);
    const fresh = await openChat(window, app, FRESH_CHAT);
    const reference = fresh.getByTestId('linear-reference');
    const placeholder = reference.getByTestId(
      'linear-reference-title-placeholder',
    );
    await expect(reference).toHaveText('CAN-77');
    await expect(placeholder).toBeVisible();
    await expect(placeholder).toHaveAttribute('aria-hidden', 'true');
    await expect
      .poll(async () => (await providerState(electronApp)).held.issue)
      .toBeGreaterThan(0);
    const loading = await measureFollowingWord(reference);
    expect(loading.word).toBe('is');

    await release(electronApp, ['issue']);
    await expect(reference).toHaveText(`CAN-77: ${FRESH_TITLE}`);
    await expect(placeholder).toHaveCount(0);
    await expect
      .poll(async () =>
        Number.isInteger(
          Number(
            await reference
              .getByTestId('linear-reference-title')
              .getAttribute('data-visible-length'),
          ),
        ),
      )
      .toBe(true);
    const titled = await measureFollowingWord(reference);
    // The placeholder is 36ch plus a 0.5rem gap; the title is `: ` plus a
    // word-boundary clip of at most 40ch. This title clips near 40ch, so the
    // next word may move by up to 4ch plus the separator: allow 5ch (about
    // 44px at 1ch = 8.8px; measured 3.9ch). Without the placeholder it would
    // jump by the whole `: title`, about 41ch.
    const ch = loading.placeholder / 36;
    expect(Math.abs(titled.wordX - loading.wordX)).toBeLessThan(5 * ch);
    expect(titled.x).toBe(loading.x);
    expect(titled.wordY).toBe(loading.wordY);
    expect(titled.y).toBe(loading.y);
    expect(Math.abs(titled.height - loading.height)).toBeLessThanOrEqual(1);
  } finally {
    await release(electronApp).catch(() => undefined);
    await closeCanopy(electronApp, userDataDir).catch(() => undefined);
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
