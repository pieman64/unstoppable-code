// CAN-4663: real provider/tool bridges, deterministic loopback human check,
// two automation-origin turns, explicit navigation, reload and accepted reply.
// No live authentication or network beyond the loopback fixture/mock provider.
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeCanopy } from './launchCanopy.mjs';
import {
  collectLeaves,
  getLayout,
  seedPanelWorktree,
  SEEDED_CHAT_TAB_ID,
  waitForPanelLayout,
} from './panelHarness.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  clearScenario,
} from './seeders/index.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';

const scope = { projectId: 'demo-ts-pnpm-vite', worktreeId: 'demo-main' };
const marker = 'Canopy-C4663HANDOFF';
const show = (files, id) => ({
  toolCalls: [{ name: 'mcp__canopy__ShowFiles', id, input: { files } }],
  stopReason: 'tool_use',
});

const end = (text) => ({ text, stopReason: 'end_turn' });

async function snapshot(window) {
  return window.evaluate((target) => window.api.chat.getState(target), scope);
}
async function transcript(window) {
  return window.evaluate(
    (target) => window.api.chat.getTranscriptPage(target),
    {
      ...scope,
      chatId: SEEDED_CHAT_TAB_ID,
    },
  );
}
function receipts(page) {
  return page.messages
    .flatMap((message) => message.blocks)
    .filter((block) => block.type === 'tool_result')
    .map((block) => ({ result: JSON.parse(block.output) }));
}
async function selection(window) {
  const layout = await getLayout(window);
  return {
    group: layout?.activeGroupId,
    selected: collectLeaves(layout?.root).map((leaf) => [
      leaf.groupId,
      leaf.activePanelId,
    ]),
  };
}
async function expectBrowserFocused(window, browserId) {
  const layout = await getLayout(window);
  const group = collectLeaves(layout?.root).find((leaf) =>
    leaf.panels.some(
      (panel) =>
        panel.kind === 'browser' && panel.instance?.browserId === browserId,
    ),
  );
  const panel = group?.panels.find(
    (candidate) => candidate.instance?.browserId === browserId,
  );
  expect(group, 'browser group exists').toBeTruthy();
  expect(group?.activePanelId).toBe(panel?.panelId);
  expect(layout?.activeGroupId).toBe(group?.groupId);
}
async function dispatch(electronApp, action) {
  return electronApp.evaluate(
    (_electron, input) =>
      globalThis.__CANOPY_E2E_DISPATCH_BROWSER_ACTION__(input),
    {
      action,
      path: 'scoped',
      destination: { ...scope, chatId: SEEDED_CHAT_TAB_ID },
    },
  );
}
async function send(window, tag, source = 'automation') {
  await window.evaluate((request) => window.api.chat.sendMessage(request), {
    ...scope,
    chatId: SEEDED_CHAT_TAB_ID,
    userMessageId: `handoff-${tag}`,
    text: `[${marker}] [Canopy-Mock-Request:${tag}] Complete this fixture step.`,
    providerType: 'claude',
    model: 'sonnet',
    approvalMode: 'full-access',
    initiationSource: source,
    ...(source === 'automation'
      ? { automationName: 'Handoff regression schedule' }
      : {}),
  });
  await expect
    .poll(
      async () => {
        const page = await transcript(window);
        return page.messages.some(
          (message) =>
            message.role === 'assistant' &&
            message.blocks.some(
              (block) =>
                block.type === 'text' && block.text.includes(`done-${tag}`),
            ),
        );
      },
      { timeout: 90_000 },
    )
    .toBe(true);
}

test('a browser handoff survives two scheduled runs, navigation and reload until a human reply', async () => {
  test.setTimeout(360_000);
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(
      '<title>Handoff human check</title><button onclick="this.textContent=\'Verified\'">Verify</button>',
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  let electronApp;
  let userDataDir;
  try {
    const launched = await withBundledBinaryOverridesScrubbed(() =>
      seedPanelWorktree(),
    );
    ({ electronApp, userDataDir } = launched);
    const { window, demoSeed, app } = launched;
    const root = demoSeed.workspaces[0].worktreePath;
    for (const name of [
      'report.md',
      'foreground.md',
      'schedule-state.json',
      'schedule.html',
    ]) {
      writeFileSync(
        path.join(root, name),
        name.endsWith('.html')
          ? '<title>Scheduled HTML</title>'
          : `Fixture ${name}`,
      );
    }
    const opened = await dispatch(electronApp, { type: 'browser.open', url });
    expect(opened.ok).toBe(true);
    const browser = opened.result.browser;
    const handoffAction = {
      type: 'browser.open',
      browserId: browser.id,
      expectedRuntimeGeneration: browser.profile.runtimeGeneration,
      handoff: true,
    };
    const requestHandoff = (id) => ({
      toolCalls: [
        {
          name: 'mcp__canopy__DispatchAction',
          id,
          input: { action: handoffAction },
        },
      ],
      stopReason: 'tool_use',
    });
    const automationFiles = [
      { path: 'schedule-state.json' },
      { path: 'schedule.html' },
      { path: 'report.md' },
    ];
    await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
      llm: {
        steps: [end('unused')],
        stepsByRequestTag: {
          start: [
            requestHandoff('handoff-start'),
            show([{ path: 'report.md' }], 'handoff-start-files'),
            end('done-start'),
          ],
          'schedule-one': [
            show(automationFiles, 'handoff-schedule-one'),
            end('done-schedule-one'),
          ],
          'schedule-two': [
            show(automationFiles, 'handoff-schedule-two'),
            end('done-schedule-two'),
          ],
          'schedule-after-reply': [
            show(automationFiles, 'handoff-schedule-after-reply'),
            end('done-schedule-after-reply'),
          ],
          duplicate: [
            requestHandoff('handoff-duplicate'),
            show(automationFiles, 'handoff-repeat-files'),
            end('done-duplicate'),
          ],
          reply: [
            show([{ path: 'foreground.md' }], 'handoff-foreground'),
            end('done-reply'),
          ],
        },
      },
    });
    await send(window, 'start', 'user');
    const browserPane = window.getByTestId(`browser-pane-${browser.id}`);
    await expect(browserPane).toBeVisible();
    await expectBrowserFocused(window, browser.id);
    const protectedSelection = await selection(window);
    const browsersBeforeSchedules = (
      await dispatch(electronApp, { type: 'browser.list' })
    ).result.browsers.map((entry) => entry.id);
    expect(receipts(await transcript(window)).at(-1)?.result).toMatchObject({
      presentation: 'background',
      opened: 1,
      activated: false,
    });
    const fileTabsBeforeSchedules = (
      await snapshot(window)
    ).tabsFile.tabs.filter((tab) => tab.kind === 'file');
    for (const tag of ['schedule-one', 'schedule-two']) {
      await send(window, tag);
      expect(await selection(window)).toEqual(protectedSelection);
      expect(
        (
          await dispatch(electronApp, { type: 'browser.list' })
        ).result.browsers.map((entry) => entry.id),
      ).toEqual(browsersBeforeSchedules);
      expect(
        (await snapshot(window)).tabsFile.tabs.filter((tab) =>
          ['schedule-state.json', 'schedule.html', 'report.md'].some((name) =>
            tab.filePath?.endsWith(name),
          ),
        ),
      ).toEqual(fileTabsBeforeSchedules);
      expect(receipts(await transcript(window)).at(-1)?.result).toMatchObject({
        presentation: 'deferred',
        reason: 'automation_turn',
        opened: 0,
        deferred: 3,
      });
    }
    // An explicit user open must work while the handoff is still pending.
    await window.keyboard.press(
      `${process.platform === 'darwin' ? 'Meta' : 'Control'}+p`,
    );
    await window.getByTestId('file-search-palette-input').fill('report.md');
    await window
      .getByTestId('file-search-palette-result')
      .filter({ hasText: 'report.md' })
      .first()
      .click();
    await expect(window.getByTestId('file-viewer')).toBeVisible();
    const userSelection = await selection(window);
    await send(window, 'duplicate');
    expect(await selection(window)).toEqual(userSelection);
    // Read the reply that arrived behind the file tab. An unread chat would
    // rightly draw the re-entry after reload to its group (CAN-4957); a
    // quiet worktree restores the saved Browser selection.
    await window
      .getByTestId(`panel-tab-panel-chat-${SEEDED_CHAT_TAB_ID}`)
      .click();
    await expect(
      window.locator(
        `[data-testid="panel-tab-unread-${SEEDED_CHAT_TAB_ID}"], [data-testid="panel-tab-unread-dot-${SEEDED_CHAT_TAB_ID}"]`,
      ),
    ).toHaveCount(0);
    await window.getByTestId(`panel-tab-panel-browser-${browser.id}`).click();
    await expect(browserPane).toBeVisible();
    const beforeReload = await selection(window);
    const pinBeforeReload = await window.evaluate(
      (target) => window.api.browser.loadWorktreeState(target),
      scope,
    );
    await window.reload();
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(scope.worktreeId, {
      expandDefaultActivityRail: false,
    });
    await waitForPanelLayout(window);
    await expect(window.getByTestId(`browser-pane-${browser.id}`)).toBeVisible({
      timeout: 30_000,
    });
    expect(await selection(window)).toEqual(beforeReload);
    const hydrated = await window.evaluate(
      (target) => window.api.browser.loadWorktreeState(target),
      scope,
    );
    expect(hydrated.handoffState.handoff.browserId).toBe(browser.id);
    expect(hydrated.handoffState.handoff.handoffId).toBe(
      pinBeforeReload.handoffState.handoff.handoffId,
    );
    // Complete the deterministic human check in the actual native page.
    await electronApp.evaluate(async ({ webContents }, pageUrl) => {
      const page = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL() === pageUrl);
      if (!page) throw new Error('Missing native handoff page');
      const point = await page.executeJavaScript(`(() => {
        const bounds = document.querySelector('button').getBoundingClientRect();
        return { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) };
      })()`);
      page.sendInputEvent({
        type: 'mouseDown',
        ...point,
        button: 'left',
        clickCount: 1,
      });
      page.sendInputEvent({
        type: 'mouseUp',
        ...point,
        button: 'left',
        clickCount: 1,
      });
    }, url);
    await expect
      .poll(() =>
        electronApp.evaluate(async ({ webContents }, pageUrl) => {
          const page = webContents
            .getAllWebContents()
            .find((contents) => contents.getURL() === pageUrl);
          return page?.executeJavaScript('document.body.innerText');
        }, url),
      )
      .toContain('Verified');
    // The real accepted human send releases protection before its ShowFiles.
    await send(window, 'reply', 'user');
    const replyReceipt = receipts(await transcript(window)).at(-1)?.result;
    expect(replyReceipt).toMatchObject({
      presentation: 'foreground',
      opened: 1,
      activated: true,
    });
    const foregroundPanelId = `panel-file-${replyReceipt.files[0].tabId}`;
    await expect(
      window
        .locator(`[data-panel-content-host="${foregroundPanelId}"]`)
        .getByTestId('file-viewer'),
    ).toContainText('Fixture foreground.md');
    const foregroundLayout = await getLayout(window);
    expect(
      collectLeaves(foregroundLayout.root).find(
        (leaf) => leaf.groupId === foregroundLayout.activeGroupId,
      )?.activePanelId,
    ).toBe(foregroundPanelId);
    const released = await window.evaluate(
      (target) => window.api.browser.loadWorktreeState(target),
      scope,
    );
    expect(released.handoffState.handoff).toBeNull();
    const replySelection = await selection(window);
    await send(window, 'schedule-after-reply');
    expect(await selection(window)).toEqual(replySelection);
    expect(receipts(await transcript(window)).at(-1)?.result).toMatchObject({
      presentation: 'deferred',
      reason: 'automation_turn',
      opened: 0,
    });
    // Destruction releases a fresh pin, including attention queued by its open.
    expect((await dispatch(electronApp, handoffAction)).ok).toBe(true);
    await window.getByTestId(`panel-tab-panel-browser-${browser.id}`).click();
    await window.evaluate(
      (browserId) => window.api.browser.destroy({ browserId }),
      browser.id,
    );
    await expect(window.getByTestId(`browser-pane-${browser.id}`)).toHaveCount(
      0,
    );
    const closed = await window.evaluate(
      (target) => window.api.browser.loadWorktreeState(target),
      scope,
    );
    expect(closed.handoffState.handoff).toBeNull();
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, marker);
    await new Promise((resolve) => server.close(resolve));
  }
});

test('an inactive-worktree handoff never selects that worktree or steals focus on return', async () => {
  const otherWorktreeId = 'handoff-other';
  const { electronApp, userDataDir, window, app } =
    await withBundledBinaryOverridesScrubbed(() =>
      seedPanelWorktree({
        onBeforeLaunch({ userDataDir }) {
          const catalogPath = path.join(
            userDataDir,
            'workspaces',
            scope.projectId,
            'worktrees.json',
          );
          const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
          const original = catalog.worktrees.find(
            (entry) => entry.id === scope.worktreeId,
          );
          const otherPath = path.join(
            userDataDir,
            'workspaces',
            scope.projectId,
            'worktrees',
            otherWorktreeId,
          );
          execFileSync(
            'git',
            ['worktree', 'add', '-b', otherWorktreeId, otherPath],
            {
              cwd: path.join(path.dirname(otherPath), scope.worktreeId),
            },
          );
          catalog.worktrees.push({
            ...original,
            id: otherWorktreeId,
            branchName: otherWorktreeId,
            path: otherPath,
            createdAt: new Date().toISOString(),
          });
          writeFileSync(catalogPath, JSON.stringify(catalog));
        },
      }),
    );
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<title>Inactive handoff</title><button>Verify</button>');
  });
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const opened = await dispatch(electronApp, {
      type: 'browser.open',
      url: `http://127.0.0.1:${server.address().port}/`,
    });
    expect(opened.ok).toBe(true);
    const browser = opened.result.browser;
    await expect(
      window.getByTestId(`browser-pane-${browser.id}`),
    ).toBeVisible();
    await window
      .getByTestId(`panel-tab-panel-chat-${SEEDED_CHAT_TAB_ID}`)
      .click();
    const beforeLeaving = await selection(window);
    await app.selectWorktree(otherWorktreeId, {
      expandDefaultActivityRail: false,
    });
    await waitForPanelLayout(window);
    const otherSelection = await selection(window);
    const handoff = await dispatch(electronApp, {
      type: 'browser.open',
      browserId: browser.id,
      expectedRuntimeGeneration: browser.profile.runtimeGeneration,
      handoff: true,
    });
    expect(handoff).toMatchObject({
      ok: true,
      result: { attention: 'pending' },
    });
    // Wait beyond the bounded pending-focus lifetime before returning.
    await window.waitForTimeout(5_100);
    expect(await selection(window)).toEqual(otherSelection);
    await app.selectWorktree(scope.worktreeId, {
      expandDefaultActivityRail: false,
    });
    await waitForPanelLayout(window);
    expect(await selection(window)).toEqual(beforeLeaving);
    const hydrated = await window.evaluate(
      (target) => window.api.browser.loadWorktreeState(target),
      scope,
    );
    expect(hydrated.handoffState.handoff.browserId).toBe(browser.id);
  } finally {
    try {
      await closeCanopy(electronApp, userDataDir);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }
});
