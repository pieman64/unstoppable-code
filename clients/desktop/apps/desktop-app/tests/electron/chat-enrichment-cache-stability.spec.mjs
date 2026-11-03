// ---------------------------------------------------------------------------
// Chat enrichment stays ready across real tab clicks, reloads, stale data and
// app focus return (CAN-4061).
//
// Seeds two chats in a worktree (origin github.com/acme/app) and two in a
// cowork project, signs in a mock Canopy account, connects Linear and GitHub
// against the shared mock and warms both providers. Observers go in BEFORE the
// first click and every provider read is then held (Linear in main's fetch,
// GitHub through the mock's reference holds), so a cleared cache shows as an
// unresolved chip instead of hiding behind a fast answer. Linear chips add the
// title; GitHub chips show only the ID. A resolved bare reference declares its
// canonical `data-link-url`.
//
// The trace records, per chat panel and for every DOM mutation and animation
// frame, each reference's text, ready/plain state, icon, React
// reset epoch and box; plus reset-key writes, account notifications (detail
// and dispatcher) and focus/visibility events with their target. Hidden test
// windows never receive a native window focus, so app return dispatches the
// same `focus`/`visibilitychange` events OrgLapsedBanner listens for; real
// tab clicks only move element focus. Set CHAT_ENRICHMENT_TRACE_DIR to also
// write each trace as JSON.
//
// Visual evidence: .playwright/can-4061/ (one-shot capture spec and report).
// ---------------------------------------------------------------------------
import { execFileSync } from 'node:child_process';
import {
  lstatSync,
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
  connectMockCloudAccount,
  getScenarioActivity,
  registerScenario,
  seedCoworkWorkspace,
  seedWorktreeChat,
} from './seeders/index.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const COWORK_ID = 'enrichment-cowork';
const REFRESH_CHANNEL = 'settings:refresh-canopy-cloud-enforced-settings';
const STORAGE_KEY = 'canopy.referencePreviews.v1';
const GITHUB_SCOPE_CHANNEL = 'reference-preview:github-scope';
const TRACE_ARGS = {
  accountEvent: 'canopy:cloud-account-changed',
  resetKey: 'canopy.referencePreviews.reset.v1',
};
// OrgLapsedBanner re-probes at most once a minute.
const REPROBE_GAP = 61_000;
const AT = Date.parse('2026-10-01T10:00:00.000Z');

const TITLES = {
  'CAN-42': 'Keep enrichment titles through tab switches',
  'ECW-7': 'Checkout copy',
  'CAN-77': 'Second chat ticket',
  1234: 'Reuse pull request state for previews',
  7: 'Hydrate GitHub references',
  55: 'Preview cards for issues',
};
const label = (prefix, key) => `${prefix}: ${TITLES[key]}`;

// Each text ends with a sentinel: a sample is judged only once the whole
// transcript has rendered. Cowork never resolves bare `#N`.
const CHATS = {
  worktree: [
    {
      id: 'enrichment-wt-a',
      text: 'CAN-42 still needs evidence and ECW-7 ships after it. PR acme/app#1234 and bare #7 track it. End of alpha.',
      linear: [label('CAN-42', 'CAN-42'), label('ECW-7', 'ECW-7')],
      github: ['acme/app#1234', '#7'],
    },
    {
      id: 'enrichment-wt-b',
      text: 'CAN-77 is next and acme/app#55 is the issue. End of beta.',
      linear: [label('CAN-77', 'CAN-77')],
      github: ['acme/app#55'],
    },
  ],
  cowork: [
    {
      id: 'enrichment-cw-a',
      text: 'In cowork CAN-42 and acme/app#1234 resolve while bare #7 stays plain. End of cowork alpha.',
      linear: [label('CAN-42', 'CAN-42')],
      github: ['acme/app#1234'],
    },
    {
      id: 'enrichment-cw-b',
      text: 'Cowork follow-up: CAN-77 with acme/app#55. End of cowork beta.',
      linear: [label('CAN-77', 'CAN-77')],
      github: ['acme/app#55'],
    },
  ],
};
const sentinelOf = (chat) => chat.text.slice(chat.text.lastIndexOf('End'));

const SCENARIOS = {
  linear: {
    linear: {
      previewTeams: [
        { id: 'team_can', key: 'CAN', name: 'Canopy' },
        { id: 'team_ecw', key: 'ECW', name: 'Ecommerce' },
      ],
      issues: ['CAN-42', 'ECW-7', 'CAN-77'].map((identifier) => ({
        id: `iss_${identifier}`,
        identifier,
        title: TITLES[identifier],
        url: `https://linear.app/acme/issue/${identifier}/x`,
      })),
    },
  },
  github: {
    github: {
      issues: Object.fromEntries(
        [1234, 7, 55].map((number) => [
          `acme/app/${number}`,
          {
            number,
            title: TITLES[number],
            state: 'open',
            html_url: `https://github.com/acme/app/issues/${number}`,
            updated_at: new Date(AT).toISOString(),
            user: { login: 'octocat' },
            body: `Context for ${TITLES[number]}.`,
            ...(number === 1234
              ? {
                  html_url: 'https://github.com/acme/app/pull/1234',
                  draft: false,
                  pull_request: { merged_at: null },
                }
              : {}),
          },
        ]),
      ),
    },
  },
};

const chatTab = (chat, index) => ({
  id: chat.id,
  title: chat.id,
  createdAt: new Date(AT).toISOString(),
  providerType: 'claude',
  messages: [
    ['user', 'Which tickets are involved?'],
    ['assistant', chat.text],
  ].map(([role, text], offset) => ({
    id: `${chat.id}-${role}`,
    role,
    blocks: [{ type: 'text', text }],
    timestamp: AT + index * 10_000 + offset * 5_000,
  })),
});

function seed(root) {
  const userDataDir = path.join(root, 'data');
  const ghConfigDir = path.join(root, 'gh-config');
  mkdirSync(ghConfigDir, { recursive: true });
  const summary = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const repo = summary.workspaces[0].worktreePath;
  const git = (args) =>
    execFileSync('/usr/bin/git', ['-C', repo, ...args], { stdio: 'pipe' });
  git(['remote', 'add', 'origin', 'https://github.com/acme/app.git']);
  // A dead proxy keeps any background fetch off the network.
  git(['config', 'http.proxy', 'http://127.0.0.1:9']);
  const dataDir = path.join(userDataDir, 'workspaces', WORKSPACE_ID);
  mkdirSync(path.join(dataDir, 'worktree-data', WORKTREE_ID), {
    recursive: true,
  });
  writeFileSync(
    path.join(dataDir, 'worktree-data', WORKTREE_ID, 'panel-layout-mode.json'),
    JSON.stringify({ version: 1, mode: 'advanced' }),
  );
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    tabs: CHATS.worktree.map(chatTab),
  });
  seedCoworkWorkspace({
    userDataDir,
    workspaceId: COWORK_ID,
    collapsed: false,
    chatId: CHATS.cowork[0].id,
    providerType: 'claude',
    mergeIndex: true,
  });
  writeFileSync(
    path.join(userDataDir, 'workspaces', COWORK_ID, 'chats', 'home.json'),
    JSON.stringify({
      version: 1,
      activeTabId: CHATS.cowork[0].id,
      tabs: CHATS.cowork.map(chatTab),
    }),
  );
  const advisorDir = path.join(userDataDir, 'app-workspaces', 'app-advisor');
  mkdirSync(path.join(advisorDir, 'chats'), { recursive: true });
  writeFileSync(
    path.join(advisorDir, 'work-entries.json'),
    JSON.stringify({
      version: 1,
      entries: [
        {
          id: 'enrichment-advisor',
          title: 'Enrichment second window',
          createdAt: new Date(AT).toISOString(),
        },
      ],
    }),
  );
  const advisorChat = { ...CHATS.cowork[0], id: 'enrichment-advisor-a' };
  writeFileSync(
    path.join(advisorDir, 'chats', 'enrichment-advisor.json'),
    JSON.stringify({
      version: 1,
      activeTabId: advisorChat.id,
      tabs: [chatTab(advisorChat, 0)],
    }),
  );
  // Main falls back to `gh auth token`; an unknown host keeps that empty.
  return {
    userDataDir,
    repo,
    env: { GH_CONFIG_DIR: ghConfigDir, GH_HOST: 'github.e2e.invalid' },
  };
}

// Main: Linear preview reads counted and gated (the Linear SDK resolves
// `globalThis.fetch` per request), the enforcement refresh IPC counted and
// optionally failed, and a `Date.now` offset for main's preview freshness.
function instrumentMain(electronApp) {
  return electronApp.evaluate(
    ({ ipcMain }, { refreshChannel: channel, scopeChannel }) => {
      const now = Date.now;
      const state = {
        offset: 0,
        sent: { issue: 0, teams: 0 },
        gate: null,
        refresh: { calls: 0, settled: 0, fail: false, read: null },
        scope: { fail: false },
      };
      Date.now = () => now() + state.offset;
      Reflect.set(globalThis, '__enrichment', state);
      const original = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const body = typeof init?.body === 'string' ? init.body : '';
        const read = /referencePreview(Issue|Teams)/.exec(body)?.[1];
        if (read) {
          state.sent[read === 'Issue' ? 'issue' : 'teams'] += 1;
          await state.gate?.promise;
        }
        return original(input, init);
      };
      const handler = ipcMain._invokeHandlers.get(channel);
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (event, ...args) => {
        state.refresh.calls += 1;
        try {
          if (state.refresh.fail) throw new Error('enforcement refresh failed');
          const result = await handler(event, ...args);
          return state.refresh.read === null
            ? result
            : { ...result, read: state.refresh.read };
        } finally {
          state.refresh.settled += 1;
        }
      });
      const scopeHandler = ipcMain._invokeHandlers.get(scopeChannel);
      ipcMain.removeHandler(scopeChannel);
      ipcMain.handle(scopeChannel, (event, ...args) => {
        if (state.scope.fail)
          throw new Error('Cloud account scope is unreadable');
        return scopeHandler(event, ...args);
      });
    },
    { refreshChannel: REFRESH_CHANNEL, scopeChannel: GITHUB_SCOPE_CHANNEL },
  );
}

const mainState = (electronApp) =>
  electronApp.evaluate(() => {
    const { sent, refresh } = Reflect.get(globalThis, '__enrichment');
    return { sent: { ...sent }, refresh: { ...refresh } };
  });

const setMain = (electronApp, patch) =>
  electronApp.evaluate((_electron, { offset = 0, fail, read, scopeFail }) => {
    const state = Reflect.get(globalThis, '__enrichment');
    state.offset += offset;
    if (fail !== undefined) state.refresh.fail = fail;
    if (read !== undefined) state.refresh.read = read;
    if (scopeFail !== undefined) state.scope.fail = scopeFail;
  }, patch);

async function gitHubReads(token) {
  const { activity } = await getScenarioActivity(DEFAULT_MOCK_BASE_URL, token);
  return Object.entries(activity)
    .filter(([field]) => field.startsWith('github'))
    .reduce((total, [, count]) => total + count, 0);
}

/** Hold (or release) every Linear and GitHub preview read. */
async function holdProviders(electronApp, token, held) {
  await electronApp.evaluate((_electron, hold) => {
    const state = Reflect.get(globalThis, '__enrichment');
    if (!hold) state.gate?.release();
    if (!hold || !state.gate) {
      let release = () => undefined;
      const promise = new Promise((resolve) => {
        release = resolve;
      });
      state.gate = hold ? { promise, release } : null;
    }
  }, held);
  const response = await fetch(
    `${DEFAULT_MOCK_BASE_URL}/__mock/github/reference-holds/${encodeURIComponent(token)}`,
    { method: 'POST', body: JSON.stringify({ held }) },
  );
  expect(response.ok).toBe(true);
}

// Runs in the page, through `evaluate` or as an init script before a reload.
function traceObservers({ accountEvent, resetKey }) {
  Reflect.get(window, '__enrichmentTrace')?.stop();
  const start = performance.now();
  const at = () => Math.round(performance.now() - start);
  const trace = { samples: [], events: [] };
  const epochOf = (element) => {
    const key = Object.keys(element).find((name) =>
      name.startsWith('__reactFiber$'),
    );
    for (let fiber = element[key], depth = 0; fiber && depth < 30; depth++) {
      const resetKeyProp = fiber.memoizedProps?.resetKey;
      if (typeof resetKeyProp === 'string') {
        return Number(resetKeyProp.split(':')[0]);
      }
      fiber = fiber.return;
    }
    return null;
  };
  const referenceOf = (element) => {
    const provider = element.dataset.testid.replace('-reference', '');
    const box = element.getBoundingClientRect();
    return {
      provider,
      text: element.textContent,
      // A resolved bare reference declares its canonical URL.
      state: element.hasAttribute('data-link-url') ? 'ready' : 'plain',
      icon: element.querySelector('svg[aria-hidden="true"]') !== null,
      epoch: epochOf(element),
      box: [box.x, box.y, box.width, box.height].map(Math.round),
    };
  };
  const last = {};
  const sample = (kind) => {
    const panels = Array.from(
      document.querySelectorAll('[data-testid="panel-content-chat"]'),
      (panel) => ({
        panel: panel.dataset.panelId,
        visible: panel.checkVisibility(),
        text: panel.textContent ?? '',
        references: Array.from(
          panel.querySelectorAll(
            '[data-testid="linear-reference"], [data-testid="github-reference"]',
          ),
          referenceOf,
        ),
      }),
    );
    const key = JSON.stringify(panels);
    if (key === last[kind] || trace.samples.length > 4000) return;
    last[kind] = key;
    trace.samples.push({ kind, t: at(), panels });
  };
  const observer = new MutationObserver(() => sample('dom'));
  observer.observe(document, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['style', 'class', 'hidden'],
  });
  let frame = requestAnimationFrame(function tick() {
    sample('frame');
    frame = requestAnimationFrame(tick);
  });
  const caller = () => (new Error().stack ?? '').split('\n')[3]?.trim();
  const { setItem } = Storage.prototype;
  Storage.prototype.setItem = function traceSetItem(key, value) {
    if (key === resetKey) {
      trace.events.push({ t: at(), kind: 'reset', value, caller: caller() });
    }
    return setItem.call(this, key, value);
  };
  const dispatchEvent = window.dispatchEvent;
  window.dispatchEvent = function traceDispatch(event) {
    if (event.type === accountEvent) {
      trace.events.push({
        t: at(),
        kind: 'account',
        detail: event.detail ?? null,
        caller: caller(),
      });
    }
    return dispatchEvent.call(this, event);
  };
  // Only window-targeted focus reaches OrgLapsedBanner's listener.
  const onLifecycle = (event) =>
    trace.events.push({
      t: at(),
      kind: event.type,
      target:
        event.target === window || event.target === document
          ? 'window'
          : (event.target?.dataset?.testid ?? event.target?.tagName),
      trusted: event.isTrusted,
    });
  const lifecycle = [
    [window, 'focus'],
    [window, 'blur'],
    [document, 'visibilitychange'],
  ];
  for (const [target, type] of lifecycle) {
    target.addEventListener(type, onLifecycle, true);
  }
  sample('dom');
  Reflect.set(window, '__enrichmentTrace', {
    trace,
    stop: () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      Storage.prototype.setItem = setItem;
      window.dispatchEvent = dispatchEvent;
      for (const [target, type] of lifecycle) {
        target.removeEventListener(type, onLifecycle, true);
      }
    },
  });
}

const installTrace = (window) => window.evaluate(traceObservers, TRACE_ARGS);

/**
 * Stops the trace, attaches it, and fails on any sample of a visible, fully
 * rendered chat that is not exactly its ready references (unresolved, missing
 * icon or missing decoration).
 */
async function recordTrace(window, name) {
  const trace = await window.evaluate(() => {
    const handle = Reflect.get(window, '__enrichmentTrace');
    handle.stop();
    return handle.trace;
  });
  const body = JSON.stringify(trace, null, 2);
  await test
    .info()
    .attach(`${name}.json`, { body, contentType: 'application/json' });
  const dir = process.env.CHAT_ENRICHMENT_TRACE_DIR;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${name}.json`), body);
  }
  return trace;
}

async function expectStable(window, origin, name) {
  const trace = await recordTrace(window, name);
  const regressions = [];
  const epochs = new Set();
  for (const { kind, t, panels } of trace.samples) {
    for (const { panel, visible, text, references } of panels) {
      references.forEach(({ provider, epoch }) =>
        epochs.add(`${provider}:${epoch}`),
      );
      const chat = CHATS[origin].find(({ id }) => panel === `panel-chat-${id}`);
      if (!chat || !visible || !text.includes(sentinelOf(chat))) continue;
      const shown = references.map(({ text: shownText, state, icon }) =>
        state === 'ready' && icon
          ? shownText
          : `${state}${icon ? '' : ' (no icon)'}: ${shownText}`,
      );
      if (
        JSON.stringify(shown) !==
        JSON.stringify([...chat.linear, ...chat.github])
      ) {
        regressions.push({ kind, t, chat: chat.id, shown });
      }
    }
  }
  test.info().annotations.push({
    type: name,
    description: JSON.stringify({
      samples: trace.samples.length,
      epochs: [...epochs].sort(),
      events: trace.events.map(({ t, kind, target, detail, value }) => ({
        t,
        kind,
        target,
        detail,
        value,
      })),
      firstRegressions: regressions.slice(0, 3),
    }),
  });
  expect(regressions, `${name}: ready references regressed`).toEqual([]);
  return trace;
}

const resetsIn = (trace) => trace.events.filter(({ kind }) => kind === 'reset');

const panelOf = (window, chat) =>
  window.locator(
    `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${chat.id}"]`,
  );

// Resolved references of one provider: each declares its canonical URL.
const resolvedIn = (panel, provider) =>
  panel.locator(`[data-testid="${provider}-reference"][data-link-url]`);

async function expectReady(window, chat) {
  const panel = panelOf(window, chat);
  await expect(panel).toBeVisible({ timeout: 30_000 });
  for (const provider of ['linear', 'github']) {
    const references = panel.getByTestId(`${provider}-reference`);
    await expect(references).toHaveText(chat[provider], { timeout: 30_000 });
    await expect(resolvedIn(panel, provider)).toHaveCount(
      chat[provider].length,
      { timeout: 30_000 },
    );
  }
}

// Real navigation: the worktree row or the cowork entry, then the chat's own
// tab; a cowork chat missing from the tab strip opens through its entry.
async function openOrigin(window, app, origin) {
  await app.openMainPage();
  if (origin === 'worktree') return app.selectWorktree(WORKTREE_ID);
  await window.getByTestId(`sidebar-work-entry-${CHATS.cowork[0].id}`).click();
}

// Worktree chats have no sidebar entry, so their click waits for the tab.
async function clickChat(window, chat) {
  const tab = window.getByTestId(`panel-tab-panel-chat-${chat.id}`);
  const target =
    CHATS.worktree.includes(chat) || (await tab.isVisible())
      ? tab
      : window.getByTestId(`sidebar-work-entry-${chat.id}`);
  await target.click();
  await expectReady(window, chat);
}

/** A→B→A by real clicks. */
async function switchTabs(window, origin) {
  const [a, b] = CHATS[origin];
  await clickChat(window, b);
  await window.waitForTimeout(500);
  await clickChat(window, a);
  await window.waitForTimeout(1_000);
}

/** Return to the app past the re-probe throttle; resolves once it settled. */
async function returnToApp(window, electronApp, { visibility = true } = {}) {
  const { settled } = (await mainState(electronApp)).refresh;
  await window.evaluate(
    ({ delta, visibilityEvent }) => {
      const now = Reflect.get(window, '__realNow') ?? Date.now;
      Reflect.set(window, '__realNow', now);
      const offset = (Reflect.get(window, '__nowOffset') ?? 0) + delta;
      Reflect.set(window, '__nowOffset', offset);
      Date.now = () => now() + offset;
      window.dispatchEvent(new Event('focus'));
      if (visibilityEvent)
        document.dispatchEvent(new Event('visibilitychange'));
    },
    { delta: REPROBE_GAP, visibilityEvent: visibility },
  );
  await expect
    .poll(async () => (await mainState(electronApp)).refresh.settled)
    .toBe(settled + 1);
  await window.waitForTimeout(1_500);
}

/**
 * Launches a seeded app with a signed-in account and both providers, warms
 * both chats of `origin` (A→B→A), runs `body`, and always cleans up.
 */
async function withWarmApp(origin, { fakeClock = false } = {}, body) {
  const root = mkdtempSync(
    path.join(os.tmpdir(), `canopy-enrichment-${origin}-`),
  );
  const { userDataDir, env, repo } = seed(root);
  const suffix = path.basename(root).replace(/\W/g, '').slice(-10);
  const tokens = {
    account: `csk_e2e_enrichment_${suffix}`,
    linear: `lin_api_e2e_enrichment_${suffix}`,
    github: `ghp_e2e_enrichment_${suffix}`,
  };
  await registerScenario(DEFAULT_MOCK_BASE_URL, tokens.account, {});
  await registerScenario(
    DEFAULT_MOCK_BASE_URL,
    tokens.linear,
    SCENARIOS.linear,
  );
  await registerScenario(
    DEFAULT_MOCK_BASE_URL,
    tokens.github,
    SCENARIOS.github,
  );
  const { electronApp } = await launchCanopy({ userDataDir, env });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await window.evaluate(() =>
      window.api.savePreferences({
        linearChatEnrichmentMode: 'replace',
        githubChatEnrichmentMode: 'replace',
      }),
    );
    await instrumentMain(electronApp);
    await connectMockCloudAccount(window, tokens.account);
    await window.evaluate(async ({ linear, github }) => {
      await window.api.saveLinearToken(linear);
      await window.api.saveGitHubPat(github);
      window.dispatchEvent(new Event('canopy:linear-connection-changed'));
      window.dispatchEvent(new Event('canopy:github-connection-changed'));
    }, tokens);
    if (fakeClock) {
      // Installed before a reload so every store timer uses it.
      await window.clock.install();
      await window.reload();
      await app.waitForShell({ timeout: 30_000 });
    }
    const [a, b] = CHATS[origin];
    await openOrigin(window, app, origin);
    for (const chat of [a, b, a]) await clickChat(window, chat);
    // The 250 ms write debounce has saved every title.
    await expect
      .poll(() =>
        window.evaluate(
          (key) =>
            JSON.parse(localStorage.getItem(key) ?? '{}').entries?.length,
          STORAGE_KEY,
        ),
      )
      .toBe(origin === 'worktree' ? 6 : 4);
    const warm = {
      main: await mainState(electronApp),
      github: await gitHubReads(tokens.github),
    };
    await holdProviders(electronApp, tokens.github, true);
    const reads = async () => ({
      main: await mainState(electronApp),
      github: await gitHubReads(tokens.github),
    });
    await body({
      electronApp,
      window,
      app,
      warm,
      reads,
      tokens,
      repo,
      userDataDir,
    });
  } finally {
    await holdProviders(electronApp, tokens.github, false).catch(() => {});
    await closeCanopy(electronApp, userDataDir).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}

for (const failure of ['git', 'manifest']) {
  test(`worktree: a restored repository origin expires after failed ${failure} host validation`, async () => {
    test.setTimeout(180_000);
    await withWarmApp(
      'worktree',
      { fakeClock: true },
      async ({ electronApp, window, app, repo }) => {
        if (failure === 'git') {
          const file = path.join(repo, '.git');
          expect(lstatSync(file).isFile()).toBe(true);
          writeFileSync(file, 'gitdir: ./unavailable-enrichment-test');
        } else {
          // Only the real origin handler sees malformed bytes; sidebar reads stay valid.
          await electronApp.evaluate(
            ({ ipcMain }, manifest) => {
              const fs = process.getBuiltinModule('node:fs/promises');
              const { AsyncLocalStorage } =
                process.getBuiltinModule('node:async_hooks');
              const context = new AsyncLocalStorage();
              const readFile = fs.readFile;
              fs.readFile = function (file, ...args) {
                return context.getStore() && String(file) === manifest
                  ? Promise.resolve('{unreadable manifest')
                  : readFile.call(this, file, ...args);
              };
              process.getBuiltinModule('node:module').syncBuiltinESMExports();
              const channel = 'reference-preview:github-origin';
              const handler = ipcMain._invokeHandlers.get(channel);
              ipcMain.removeHandler(channel);
              ipcMain.handle(channel, (event, ...args) =>
                context.run(true, () => handler(event, ...args)),
              );
            },
            path.resolve(repo, '..', '..', 'workspace.json'),
          );
        }
        await window.evaluate((key) => {
          const saved = JSON.parse(localStorage.getItem(key));
          for (const origin of saved.origins)
            origin.checkedAt = Date.now() - 7 * 24 * 60 * 60_000 + 60_000;
          localStorage.setItem(key, JSON.stringify(saved));
        }, STORAGE_KEY);
        await window.reload();
        await app.waitForShell({ timeout: 30_000 });
        await openOrigin(window, app, 'worktree');
        await clickChat(window, CHATS.worktree[0]);
        await installTrace(window);
        await window.clock.fastForward(60_001);
        const panel = panelOf(window, CHATS.worktree[0]);
        await expect(panel.getByTestId('github-reference')).toHaveText([
          CHATS.worktree[0].github[0],
        ]);
        await expect(panel).toContainText('bare #7');
        await recordTrace(window, `worktree-origin-retention-${failure}`);
      },
    );
  });
}

for (const origin of ['worktree', 'cowork']) {
  test(`${origin}: pure tab clicks A→B→A keep ready references`, async () => {
    test.setTimeout(180_000);
    await withWarmApp(origin, {}, async ({ window, warm, reads }) => {
      await installTrace(window);
      await switchTabs(window, origin);
      const trace = await expectStable(window, origin, `${origin}-pure-tabs`);
      expect(resetsIn(trace)).toEqual([]);
      // The clicks alone: no window focus, enforcement refresh or read.
      expect(trace.events.filter(({ target }) => target === 'window')).toEqual(
        [],
      );
      expect(await reads()).toEqual(warm);
    });
  });

  test(`${origin}: a reload paints cached references before any provider answers`, async () => {
    test.setTimeout(180_000);
    await withWarmApp(origin, {}, async ({ window, app }) => {
      // Observers start with the new document, before its first render.
      await window.addInitScript(traceObservers, TRACE_ARGS);
      await window.reload();
      await app.waitForShell({ timeout: 30_000 });
      await openOrigin(window, app, origin);
      await clickChat(window, CHATS[origin][0]);
      await window.waitForTimeout(1_000);
      await expectStable(window, origin, `${origin}-reload`);
    });
  });

  test(`${origin}: five-minute-stale references stay ready across tab clicks`, async () => {
    test.setTimeout(180_000);
    await withWarmApp(
      origin,
      { fakeClock: true },
      async ({ electronApp, window, warm, reads }) => {
        await installTrace(window);
        const sixMinutes = 6 * 60 * 1000;
        await setMain(electronApp, { offset: sixMinutes });
        await window.clock.fastForward(sixMinutes);
        await switchTabs(window, origin);
        // Frames here follow the fake clock's animation frames.
        const after = await reads();
        test.info().annotations.push({
          type: 'stale reads (warm → after)',
          description: JSON.stringify([warm, after]),
        });
        // The entries really were stale: refresh reads went out and are held.
        expect(after.main.sent.issue).toBeGreaterThan(warm.main.sent.issue);
        // Two held Linear reads can occupy the bounded queue. Let them settle
        // while GitHub stays held so its stale refresh can enter the same queue.
        await electronApp.evaluate(() => {
          const state = Reflect.get(globalThis, '__enrichment');
          state.gate?.release();
          state.gate = null;
        });
        await expect
          .poll(async () => (await reads()).github)
          .toBeGreaterThan(warm.github);
        await expectStable(window, origin, `${origin}-stale-tabs`);
      },
    );
  });

  test(`${origin}: app focus and visibility return with the same account keep ready references`, async () => {
    test.setTimeout(180_000);
    await withWarmApp(
      origin,
      {},
      async ({ electronApp, window, warm, reads }) => {
        const identity = () =>
          window.evaluate(() =>
            window.api
              .loadCanopyCloudAccount()
              .then((account) => account?.account?.email),
          );
        const before = await identity();
        // The banner is mounted for a billable provider but renders nothing.
        await expect(
          window.getByTestId('chat-input-org-lapsed-banner'),
        ).toHaveCount(0);
        await installTrace(window);
        await returnToApp(window, electronApp);
        await returnToApp(window, electronApp);
        const trace = await expectStable(
          window,
          origin,
          `${origin}-focus-return`,
        );
        expect(resetsIn(trace)).toEqual([]);
        expect((await reads()).main.sent).toEqual(warm.main.sent);
        expect((await reads()).github).toBe(warm.github);
        expect(await identity()).toBe(before);
      },
    );
  });
}

for (const origin of ['worktree', 'cowork']) {
  for (const read of ['unavailable', 'error']) {
    test(`${origin}: a fulfilled ${read} account refresh retains both ready providers`, async () => {
      test.setTimeout(180_000);
      await withWarmApp(
        origin,
        {},
        async ({ electronApp, window, warm, reads }) => {
          await setMain(electronApp, { read });
          await installTrace(window);
          await returnToApp(window, electronApp);
          const trace = await expectStable(
            window,
            origin,
            `${origin}-inconclusive-${read}`,
          );
          expect(resetsIn(trace)).toEqual([]);
          expect((await reads()).main.sent).toEqual(warm.main.sent);
          expect((await reads()).github).toBe(warm.github);
        },
      );
    });
  }
  test(`${origin}: unreadable account scope retains stale titles without provider reads`, async () => {
    test.setTimeout(180_000);
    await withWarmApp(
      origin,
      { fakeClock: true },
      async ({ electronApp, window, warm, reads }) => {
        await setMain(electronApp, { scopeFail: true, offset: 6 * 60_000 });
        await installTrace(window);
        await window.clock.fastForward(6 * 60_000);
        await switchTabs(window, origin);
        const trace = await expectStable(
          window,
          origin,
          `${origin}-inconclusive-stale-scope`,
        );
        expect(resetsIn(trace)).toEqual([]);
        expect((await reads()).github).toBe(warm.github);
      },
    );
  });
  test(`${origin}: unreadable account scope retains saved titles through reload`, async () => {
    test.setTimeout(180_000);
    await withWarmApp(
      origin,
      {},
      async ({ electronApp, window, app, warm, reads }) => {
        await setMain(electronApp, { scopeFail: true });
        await window.addInitScript(traceObservers, TRACE_ARGS);
        await window.reload();
        await app.waitForShell({ timeout: 30_000 });
        const trace = await expectStable(
          window,
          origin,
          `${origin}-inconclusive-scope-reload`,
        );
        expect(resetsIn(trace)).toEqual([]);
        expect((await reads()).github).toBe(warm.github);
      },
    );
  });
}

test('worktree: a failed refresh, then repeated returns with two composers, keep ready references', async () => {
  test.setTimeout(180_000);
  await withWarmApp('worktree', {}, async ({ electronApp, window }) => {
    const [a, b] = CHATS.worktree;
    // Both chats side by side: two composers, so two mounted banners.
    await window.evaluate((panelId) => {
      window.__canopyPanelTestApi.setFixedTopology(false);
      window.__canopyPanelTestApi.movePanel(panelId, 'group-chat', 'right');
    }, `panel-chat-${b.id}`);
    await expectReady(window, a);
    await expectReady(window, b);
    await expect(window.getByTestId('chat-input-notices')).toHaveCount(2);

    // A failed refresh is no evidence of anything: titles stay.
    await installTrace(window);
    await setMain(electronApp, { fail: true });
    await returnToApp(window, electronApp, { visibility: false });
    const failed = await expectStable(
      window,
      'worktree',
      'worktree-failed-refresh',
    );
    expect(resetsIn(failed)).toEqual([]);

    // Three returns inside one throttle window: one refresh for both banners.
    await setMain(electronApp, { fail: false });
    await installTrace(window);
    const { calls } = (await mainState(electronApp)).refresh;
    await returnToApp(window, electronApp);
    for (let round = 0; round < 2; round += 1) {
      await window.evaluate(() => window.dispatchEvent(new Event('focus')));
      await window.waitForTimeout(300);
    }
    expect((await mainState(electronApp)).refresh.calls).toBe(calls + 1);
    const repeated = await expectStable(
      window,
      'worktree',
      'worktree-two-composers',
    );
    expect(resetsIn(repeated)).toEqual([]);
  });
});

for (const replacementHasPr of [true, false]) {
  test(`worktree: credential replacement cannot retain prior PR context (${replacementHasPr ? 'visible PR' : 'no PR'})`, async () => {
    test.setTimeout(120_000);
    await withWarmApp(
      'worktree',
      {},
      async ({ electronApp, window, tokens, repo, userDataDir }) => {
        await holdProviders(electronApp, tokens.github, false);
        const branch = execFileSync(
          '/usr/bin/git',
          ['-C', repo, 'branch', '--show-current'],
          { encoding: 'utf8' },
        ).trim();
        const pull = {
          id: 1101,
          number: 101,
          node_id: 'PR_scope_fixture',
          html_url: 'https://github.com/acme/app/pull/101',
          title: 'Scoped tracking PR',
          body: 'Tracking fixture',
          state: 'open',
          draft: false,
          created_at: new Date(AT).toISOString(),
          updated_at: new Date(AT).toISOString(),
          merged_at: null,
          closed_at: null,
          mergeable: true,
          mergeable_state: 'clean',
          user: { login: 'octocat' },
          labels: [],
          assignees: [],
          requested_reviewers: [],
          head: {
            ref: branch,
            sha: 'a'.repeat(40),
            repo: { full_name: 'acme/app' },
          },
          base: {
            ref: 'main',
            sha: 'b'.repeat(40),
            repo: { full_name: 'acme/app' },
          },
        };
        const scenario = {
          github: { ...SCENARIOS.github.github, pulls: [pull] },
        };
        await registerScenario(DEFAULT_MOCK_BASE_URL, tokens.github, scenario);
        const snapshotFile = path.join(
          userDataDir,
          'workspaces',
          WORKSPACE_ID,
          'worktree-data',
          WORKTREE_ID,
          'github-pr',
          'project-root',
          'current.json',
        );
        const snapshot = () => {
          try {
            return JSON.parse(readFileSync(snapshotFile, 'utf8'));
          } catch {
            return null;
          }
        };
        const refresh = () =>
          window.evaluate(
            ({ projectId, worktreeId }) =>
              window.api.github.requestFastRefresh({
                projectId,
                worktreeId,
                skipIfFresh: false,
              }),
            { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
          );
        await refresh();
        await expect
          .poll(() => snapshot()?.pr.number, { timeout: 30_000 })
          .toBe(101);
        const previous = snapshot();
        expect(previous.credentialScope).toEqual(expect.any(String));
        const comment = {
          id: 9001,
          nodeId: null,
          htmlUrl: null,
          apiUrl: null,
          author: null,
          authorAssociation: null,
          body: 'A-only private comment',
          createdAt: new Date(AT).toISOString(),
          updatedAt: new Date(AT).toISOString(),
        };
        writeFileSync(
          snapshotFile,
          JSON.stringify({
            ...previous,
            includesComments: true,
            includesReviews: true,
            includesReviewComments: true,
            issueComments: [comment],
            reviews: [],
            reviewComments: [],
          }),
        );
        const nextToken = `ghp_e2e_pr_provenance_${Date.now()}`;
        await registerScenario(DEFAULT_MOCK_BASE_URL, nextToken, {
          github: {
            ...scenario.github,
            pulls: replacementHasPr ? [pull] : [],
          },
        });
        await window.evaluate(async (token) => {
          await window.api.saveGitHubPat(token);
          window.dispatchEvent(new Event('canopy:github-connection-changed'));
        }, nextToken);
        await refresh();
        await expect
          .poll(() => snapshot()?.credentialScope, { timeout: 30_000 })
          .not.toBe(previous.credentialScope);
        if (replacementHasPr) {
          const current = snapshot();
          expect(current?.credentialScope).toEqual(expect.any(String));
          expect(current?.issueComments).toEqual([]);
          expect(current?.includesComments).toBe(false);
        } else {
          expect(snapshot()).toBeNull();
        }
        expect(() =>
          readFileSync(path.join(path.dirname(snapshotFile), 'previous.json')),
        ).toThrow(expect.objectContaining({ code: 'ENOENT' }));
        await expect(panelOf(window, CHATS.worktree[0])).toContainText(
          'End of alpha.',
        );
      },
    );
  });
}

test('worktree: an unreadable initiating account read purges on confirmed refresh', async () => {
  test.setTimeout(120_000);
  await withWarmApp('worktree', {}, async ({ electronApp, window }) => {
    await installTrace(window);
    await electronApp.evaluate(({ ipcMain }) => {
      const loadChannel = 'settings:load-canopy-cloud-account';
      const refreshChannel = 'settings:refresh-canopy-cloud-enforced-settings';
      const load = ipcMain._invokeHandlers.get(loadChannel);
      const refresh = ipcMain._invokeHandlers.get(refreshChannel);
      let unreadable = true;
      ipcMain.removeHandler(loadChannel);
      ipcMain.handle(loadChannel, async (event, ...args) => {
        const account = await load(event, ...args);
        return unreadable ? { ...account, read: 'error' } : account;
      });
      ipcMain.removeHandler(refreshChannel);
      ipcMain.handle(refreshChannel, (event, ...args) => {
        unreadable = false;
        return refresh(event, ...args);
      });
    });
    await returnToApp(window, electronApp);
    const panel = panelOf(window, CHATS.worktree[0]);
    await expect(resolvedIn(panel, 'linear')).toHaveCount(0);
    await expect(resolvedIn(panel, 'github')).toHaveCount(0);
    const trace = await recordTrace(
      window,
      'worktree-unknown-to-confirmed-identity',
    );
    expect(resetsIn(trace).length).toBeGreaterThan(0);
    expect(trace.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'account',
          detail: { reason: 'identity' },
        }),
      ]),
    );
  });
});

test('worktree: provider replacement and sign-out invalidate main and App Advisor windows', async () => {
  test.setTimeout(180_000);
  await withWarmApp(
    'worktree',
    {},
    async ({ electronApp, window, app, tokens }) => {
      await holdProviders(electronApp, tokens.github, false);
      const second = await app.openAppAdvisorWindow(electronApp);
      await second
        .getByTestId('app-advisor-nav-entry-enrichment-advisor')
        .click();
      const mainPanel = panelOf(window, CHATS.worktree[0]);
      const secondPanel = second.getByTestId('panel-content-chat').first();
      await expect(secondPanel.getByTestId('linear-reference')).toHaveText(
        CHATS.cowork[0].linear,
      );
      await expect(secondPanel.getByTestId('github-reference')).toHaveText(
        CHATS.cowork[0].github,
      );
      await expect(resolvedIn(secondPanel, 'linear')).toHaveCount(
        CHATS.cowork[0].linear.length,
      );
      await expect(resolvedIn(secondPanel, 'github')).toHaveCount(
        CHATS.cowork[0].github.length,
      );
      await holdProviders(electronApp, tokens.github, true);
      const nextToken = `ghp_e2e_replaced_${Date.now()}`;
      await registerScenario(
        DEFAULT_MOCK_BASE_URL,
        nextToken,
        SCENARIOS.github,
      );
      await holdProviders(electronApp, nextToken, true);
      try {
        await installTrace(window);
        await installTrace(second);
        await window.evaluate(async (token) => {
          await window.api.saveGitHubPat(token);
          window.dispatchEvent(new Event('canopy:github-connection-changed'));
        }, nextToken);
        for (const [panel, labels] of [
          [mainPanel, CHATS.worktree[0].linear],
          [secondPanel, CHATS.cowork[0].linear],
        ]) {
          await expect(resolvedIn(panel, 'github')).toHaveCount(0);
          // Linear keeps its resolved references.
          await expect(panel.getByTestId('linear-reference')).toHaveText(
            labels,
          );
          await expect(resolvedIn(panel, 'linear')).toHaveCount(labels.length);
        }
        await window.evaluate(async () => {
          await window.api.disconnectCanopyCloudAccount();
          window.dispatchEvent(new Event('canopy:cloud-account-changed'));
        });
        for (const panel of [mainPanel, secondPanel]) {
          await expect(resolvedIn(panel, 'linear')).toHaveCount(0);
          await expect(resolvedIn(panel, 'github')).toHaveCount(0);
        }
        await recordTrace(window, 'worktree-two-windows-main');
        await recordTrace(second, 'worktree-two-windows-advisor');
      } finally {
        await holdProviders(electronApp, nextToken, false);
        await window.evaluate(() => window.api.appAdvisor.closeWindow());
      }
    },
  );
});
