// CAN-2701 — the reworked chat model selector.
//
// Durable coverage for the four acceptance criteria, driven through the real
// composer rather than a mounted component, because three of the four are
// questions only a laid-out DOM can answer: whether a label truncates, whether
// the trigger's tooltip appears on hover, and whether either survives a
// non-default UI scale.
//
// Run:
//   pnpm run test:electron:built can-2701-model-selector.spec.mjs --reporter=line

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedWorktreeChat, writeJson } from './seeders/index.mjs';
import {
  launchPendingModelFixture,
  releasePendingModel,
} from './model-selection-fixture.mjs';
import {
  CHAT_EFFORT_TRIGGER_TEST_ID,
  closeEffortPanel,
  openEffortSlider,
  readEffortStops,
  stepEffortAway,
} from './effortPanel.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';
const CHAT_ID = 'can-2701-model-selector-chat';

/**
 * A trailing context-window token: the "1M" this ticket removed from the
 * trigger. Anchored so a real name part ending in a letter cannot match.
 */
const CONTEXT_WINDOW_SUFFIX = /\s\d+(\.\d+)?[KM]$/;

/** Vendor headings the shipping catalog can produce, in their own casing. */
const KNOWN_VENDOR_HEADINGS = new Set([
  'Agents',
  'Anthropic',
  'OpenAI',
  'Claude',
  'Codex',
  'Ollama',
  'DeepSeek',
  'Moonshot AI',
  'Z.ai',
  'MiniMax',
]);

function seedLayoutPreferences(userDataDir, { uiScale, sidebarWidth }) {
  writeJson(path.join(userDataDir, 'preferences.json'), {
    version: 1,
    preferences: {
      ...(uiScale !== undefined ? { uiScale } : {}),
      ...(sidebarWidth !== undefined ? { sidebarWidth } : {}),
    },
  });
}

function seedAgentModel(userDataDir) {
  writeFileSync(
    path.join(userDataDir, 'agent-models.json'),
    `${JSON.stringify({
      version: 1,
      agents: [
        {
          id: 'agent_model_icon_fixture',
          name: 'Icon Fixture',
          baseModel: 'sonnet',
          instructions: 'Exercise the Agents model-picker group.',
          pluginSelections: {
            collectionIds: [],
            skillRefs: [],
            pluginRefs: [],
            mcpServerRefs: [],
          },
          createdAt: '2026-09-15T12:00:00.000Z',
          updatedAt: '2026-09-15T12:00:00.000Z',
        },
      ],
    })}\n`,
    'utf8',
  );
}

function prepareUserData(uiScale, sidebarWidth) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-can-2701-model-selector-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: CHAT_ID, title: 'Model selector' }],
  });
  if (uiScale !== undefined || sidebarWidth !== undefined) {
    seedLayoutPreferences(userDataDir, { uiScale, sidebarWidth });
  }
  return userDataDir;
}

function preparePromptExpansionUserData() {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-can-2701-prompt-expansion-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'codex',
    activeTabId: CHAT_ID,
    tabs: [
      {
        id: CHAT_ID,
        title: 'Prompt expansion model guard',
        model: 'gpt-5.6-sol',
      },
    ],
  });
  const promptsDir = path.join(
    userDataDir,
    'workspaces',
    WORKSPACE_ID,
    'prompts',
  );
  mkdirSync(promptsDir, { recursive: true });
  const promptPath = path.join(promptsDir, 'guard-race.md');
  writeFileSync(
    promptPath,
    '---\ntitle: Guard Race\n---\nExpanded prompt body.\n',
    'utf8',
  );
  return { userDataDir, promptPath };
}

async function openComposerModelMenu(window, { expandChat = false } = {}) {
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_BRANCH);
  if (expandChat) {
    // Preserve the narrow viewport needed by the flyout geometry assertions,
    // but give the responsive composer enough room to expose its picker.
    await window.getByTestId('panel-group-menu-group-chat').click();
    await window.getByTestId('panel-group-maximize-group-chat').click();
    await expect(
      window.getByTestId('panel-group-restore-group-chat'),
    ).toBeVisible();
  }
  const picker = window
    .locator('[data-testid="chat-model-picker"]:visible')
    .first();
  await expect(picker).toBeVisible();
  await picker.click();
  const menu = window.getByTestId('chat-model-menu');
  await expect(menu).toBeVisible();
  return { picker, menu };
}

/**
 * Narrow enough that a detail popup cannot sit right of a right-side "More"
 * flyout, which is the case where the popup used to fall back to "left of the
 * row" and land on the parent dropdown. Wide enough that the flyout itself
 * still opens to the right.
 */
const FLYOUT_VIEWPORT = { width: 1000, height: 800 };

/**
 * Wait out the menu's entry scale so geometry is read at its final size. The
 * surface animates in, so an early `boundingBox()` reports a row mid-transform.
 */
async function waitForStableBox(locator) {
  let previous;
  await expect
    .poll(async () => {
      const current = await locator.boundingBox();
      if (!current) return false;
      const settled =
        previous !== undefined &&
        Math.abs(current.x - previous.x) < 0.01 &&
        Math.abs(current.y - previous.y) < 0.01 &&
        Math.abs(current.width - previous.width) < 0.01 &&
        Math.abs(current.height - previous.height) < 0.01;
      previous = current;
      return settled;
    })
    .toBe(true);
}

function boxesIntersect(first, second) {
  return (
    first.x < second.x + second.width &&
    first.x + first.width > second.x &&
    first.y < second.y + second.height &&
    first.y + first.height > second.y
  );
}

/** Inspect the single model list. */
async function openClaudeModels(window) {
  const { menu } = await openComposerModelMenu(window, { expandChat: true });
  await expect(menu).toHaveAttribute('data-positioned', 'true');
  const rows = menu.locator('[role="menuitemradio"][data-model-id]:visible');
  await expect(rows.first()).toBeVisible();
  return { menu, rows };
}

/**
 * Measure every rendered option label. `scrollWidth > clientWidth` is the only
 * honest test for "this text is cut off" — a `truncate` class tells you the
 * rule exists, not that it fired.
 */
async function measureOptionLabels(menu) {
  return menu.evaluate((element) => {
    const labels = Array.from(
      element.querySelectorAll('[data-testid^="chat-model-option-label-"]'),
    );
    return labels
      .filter((label) => label.checkVisibility())
      .map((label) => ({
        text: label.textContent ?? '',
        scrollWidth: label.scrollWidth,
        clientWidth: label.clientWidth,
      }));
  });
}

/** The row detail card currently shown, keyed per model in the picker. */
function rowDetail(window) {
  return window.locator('[data-testid^="chat-model-option-detail-"]:visible');
}

async function readGroupHeadings(menu) {
  return menu.evaluate((element) =>
    Array.from(
      element.querySelectorAll('[data-testid^="chat-model-group-label-"]'),
    )
      .filter((node) => node.checkVisibility())
      .map((node) => node.textContent ?? ''),
  );
}

/**
 * Rendered glyph boxes for each picker area, as `WxH` CSS px strings. Layout,
 * not the `width` attribute: app-icons.css snaps Lucide glyphs to 14px / 20px
 * with `!important`, so only a laid-out box shows what a person sees.
 */
async function readPickerGlyphBoxes(menu) {
  return menu.evaluate((element) => {
    const boxOf = (svg) => {
      const { width, height } = svg.getBoundingClientRect();
      const round = (value) => Math.round(value * 10) / 10;
      return `${round(width)}x${round(height)}`;
    };
    const boxes = (selector) =>
      Array.from(element.querySelectorAll(selector))
        .filter((svg) => svg.checkVisibility())
        .map(boxOf);
    const search = element
      .querySelector('[data-testid="chat-model-search"]')
      ?.parentElement?.querySelector('svg');
    return {
      railTabs: Array.from(
        element.querySelectorAll('[data-testid^="chat-model-harness-tab-"]'),
      ).filter((tab) => tab.checkVisibility()).length,
      rail: boxes('[data-testid^="chat-model-harness-tab-"] svg'),
      search: search ? [boxOf(search)] : [],
      stars: boxes('[data-testid^="chat-model-favorite-"] svg'),
      providers: boxes('[data-testid^="chat-model-harness-icon-"] svg'),
      headers: boxes('[data-testid^="chat-model-group-icon-"] svg'),
    };
  });
}

test('opens the real composer picker on All and browses harness tabs', async () => {
  const userDataDir = prepareUserData();
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const { menu } = await openComposerModelMenu(window);
    await expect(
      menu.getByTestId('chat-model-harness-tab-all'),
    ).toHaveAttribute('aria-checked', 'true');
    const favoritesDivider = menu.getByTestId('chat-model-favorites-divider');
    await expect(favoritesDivider).toHaveCSS('opacity', '1');
    await menu.getByTestId('chat-model-harness-tab-favorites').click();
    await expect(favoritesDivider).toHaveCSS('opacity', '1');
    await menu.getByTestId('chat-model-harness-tab-all').click();
    await expect(
      menu.getByTestId('chat-model-harness-tab-unstoppable'),
    ).toHaveCount(0);
    const selected = menu
      .locator('[data-model-id][aria-checked="true"]:visible')
      .first();
    await expect(selected).toBeVisible();
    // The shell fits the rail: from six tabs, the last one sits as far from
    // the bottom edge as every tab sits from the left one; a shorter rail
    // keeps the six-tab height, leaving the missing slots (36px tab + 1px
    // gap) below its last tab.
    const railInsets = await menu.evaluate((element) => {
      const rail = element
        .querySelector('nav[aria-label="Model harnesses"]')
        ?.getBoundingClientRect();
      const tabs = Array.from(
        element.querySelectorAll('[data-testid^="chat-model-harness-tab-"]'),
      ).map((tab) => tab.getBoundingClientRect());
      const last = tabs.at(-1);
      return rail && tabs[0] && last
        ? {
            left: tabs[0].left - rail.left,
            bottom: rail.bottom - last.bottom,
            missingSlotsPx: Math.max(0, 6 - tabs.length) * (tabs[0].height + 1),
          }
        : undefined;
    });
    expect(railInsets?.left).toBeGreaterThan(0);
    expect(railInsets?.bottom).toBeCloseTo(
      (railInsets?.left ?? 0) + (railInsets?.missingSlotsPx ?? 0),
      0,
    );
    await expect(
      menu.locator('[data-model-id]:visible').first(),
    ).toBeInViewport({ ratio: 0.5 });
    await expect(selected.locator('[data-picker-selected-check]')).toHaveCount(
      0,
    );
    await expect(selected.locator('..')).toHaveClass(/bg-subtle/);

    await menu.getByTestId('chat-model-harness-tab-claude').click();
    const unselectedModel = menu
      .locator(
        '[role="menuitemradio"][data-model-id][aria-checked="false"]:visible',
      )
      .first();
    await expect(unselectedModel).toBeVisible();
    // Stars lead each row in place of a provider glyph.
    const unselectedId = await unselectedModel.getAttribute('data-model-id');
    await expect(
      menu.locator(
        `[data-testid="chat-model-favorite-${unselectedId}"]:visible`,
      ),
    ).toHaveClass(/left-0\.5/);

    await menu.getByTestId('chat-model-harness-tab-codex').click();
    await expect(
      menu.getByTestId('chat-model-harness-tab-codex'),
    ).toHaveAttribute('aria-checked', 'true');
    await expect(menu.getByRole('group', { name: 'OpenAI' })).toBeVisible();
    await expect(menu.getByRole('group', { name: 'Claude' })).toBeHidden();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('renders picker glyphs at one size per area: rail 18px, search and rows 14px, section marks 12px', async () => {
  const userDataDir = prepareUserData();
  seedAgentModel(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const { menu } = await openComposerModelMenu(window);
    // Read geometry after the entry scale, not mid-transform.
    await waitForStableBox(menu);

    // Each harness tab shows its own rows, provider marks and headers, so
    // collect across All and the native harness tabs.
    const seen = {
      railTabs: 0,
      rail: [],
      search: [],
      stars: [],
      providers: [],
      headers: [],
    };
    for (const tab of ['all', 'claude', 'codex']) {
      await menu.getByTestId(`chat-model-harness-tab-${tab}`).click();
      await expect(
        menu.getByTestId(`chat-model-harness-tab-${tab}`),
      ).toHaveAttribute('aria-checked', 'true');
      await expect(
        menu.locator('[role="menuitemradio"][data-model-id]:visible').first(),
      ).toBeVisible();
      const boxes = await readPickerGlyphBoxes(menu);
      seen.railTabs = Math.max(seen.railTabs, boxes.railTabs);
      for (const area of ['rail', 'search', 'stars', 'providers', 'headers']) {
        seen[area].push(...boxes[area]);
      }
    }

    // Rail tabs, Lucide glyphs and provider marks alike, fill one 18px box.
    expect(seen.railTabs).toBeGreaterThan(2);
    expect(seen.rail.length).toBeGreaterThanOrEqual(seen.railTabs * 3);
    expect(new Set(seen.rail)).toEqual(new Set(['18x18']));
    // Search and row glyphs (favorite stars, trailing provider marks) sit at
    // 14px.
    expect(seen.search).toHaveLength(3);
    expect(seen.stars.length).toBeGreaterThan(0);
    expect(seen.providers.length).toBeGreaterThan(0);
    expect(new Set([...seen.search, ...seen.stars, ...seen.providers])).toEqual(
      new Set(['14x14']),
    );
    // Section headings keep their small 12px mark beside the label.
    expect(seen.headers.length).toBeGreaterThan(0);
    expect(new Set(seen.headers)).toEqual(new Set(['12x12']));
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('shows the requested model while saving and prevents sending with stale settings', async () => {
  const fixture = await launchPendingModelFixture();
  try {
    await expect(fixture.picker).toContainText('GPT 5.6 Luna');
    const sendButton = fixture.window.getByRole('button', {
      name: 'Send message',
      exact: true,
    });
    await expect(
      sendButton.getByTestId('chat-model-change-pending'),
    ).toBeVisible();
    await expect(sendButton).toHaveAttribute('aria-busy', 'true');
    await expect(sendButton.locator('svg')).toHaveCount(0);
    const busyBox = await sendButton.boundingBox();
    await expect(
      fixture.window.getByTestId('chat-model-change-pending'),
    ).toBeVisible();
    const editor = fixture.window
      .locator('[data-slate-editor="true"]:visible')
      .first();
    await editor.fill('Keep this draft while the model changes');
    await expect(
      fixture.window.getByRole('button', { name: 'Send message', exact: true }),
    ).toBeDisabled();
    await editor.press('Enter');
    await expect(editor).toContainText(
      'Keep this draft while the model changes',
    );
    const pendingChatId = await fixture.window.evaluate(async () => {
      const snapshot = await window.api.chat.getState({
        projectId: 'demo-ts-pnpm-vite',
        worktreeId: 'demo-main',
      });
      return snapshot.tabsFile.activeTabId;
    });
    await fixture.window.getByTestId('panel-tab-panel-chat-original').click();
    await expect(
      fixture.window.getByTestId('chat-model-change-pending'),
    ).toHaveCount(0);
    await expect(fixture.picker).toContainText('GPT 5.6 Sol');
    await fixture.window
      .getByTestId(`panel-tab-panel-chat-${pendingChatId}`)
      .click();
    await expect(fixture.picker).toContainText('GPT 5.6 Luna');
    await releasePendingModel(fixture.electronApp);
    await expect(
      fixture.window.getByTestId('chat-model-change-pending'),
    ).toHaveCount(0);
    await expect(fixture.picker).toContainText('GPT 5.6 Luna');
    await expect(editor).toContainText(
      'Keep this draft while the model changes',
    );
    await expect(
      fixture.window.getByRole('button', { name: 'Send message', exact: true }),
    ).toBeEnabled();
    await expect(sendButton).toHaveAttribute('aria-busy', 'false');
    await expect(sendButton.locator('svg')).toHaveCount(1);
    const readyBox = await sendButton.boundingBox();
    expect(readyBox.width).toBe(busyBox.width);
    expect(readyBox.height).toBe(busyBox.height);
  } finally {
    await releasePendingModel(fixture.electronApp);
    await closeCanopy(fixture.electronApp, fixture.userDataDir);
  }
});

test('does not send after a model change starts during prompt expansion', async () => {
  const { userDataDir, promptPath } = preparePromptExpansionUserData();
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);

    await electronApp.evaluate(({ ipcMain }) => {
      const promptChannel = 'workspace-items:read-prompt-by-path';
      const promptHandler = ipcMain._invokeHandlers.get(promptChannel);
      const modelChannel = 'chat:model-change';
      const modelHandler = ipcMain._invokeHandlers.get(modelChannel);
      const sendChannel = 'chat:send-message';
      const sendHandler = ipcMain._invokeHandlers.get(sendChannel);
      if (
        typeof promptHandler !== 'function' ||
        typeof modelHandler !== 'function' ||
        typeof sendHandler !== 'function'
      ) {
        throw new Error(
          'Expected chat and prompt IPC handlers to be registered',
        );
      }

      globalThis.__promptExpansionStarted = false;
      globalThis.__staleModelSendObserved = false;
      ipcMain.removeHandler(promptChannel);
      ipcMain.handle(promptChannel, async (event, request) => {
        globalThis.__promptExpansionStarted = true;
        await new Promise((resolve) => {
          globalThis.__releasePromptExpansion = resolve;
        });
        return promptHandler(event, request);
      });
      ipcMain.removeHandler(modelChannel);
      ipcMain.handle(modelChannel, async (event, request) => {
        if (request.model === 'gpt-5.6-luna') {
          await new Promise((resolve) => {
            globalThis.__releasePendingModel = resolve;
          });
        }
        return modelHandler(event, request);
      });
      ipcMain.removeHandler(sendChannel);
      ipcMain.handle(sendChannel, async (event, request) => {
        globalThis.__staleModelSendObserved = true;
        await new Promise((resolve) => {
          globalThis.__releaseStaleModelSend = resolve;
        });
        return sendHandler(event, request);
      });
    });

    const editor = window.locator('[data-slate-editor="true"]:visible').first();
    await editor.fill('Review ');
    await window.evaluate(
      ({ absolutePath }) => {
        document.dispatchEvent(
          new CustomEvent('canopy:insert-file-reference', {
            detail: {
              displayPath: 'Prompt: Guard Race',
              absolutePath,
              repoName: 'Prompts',
              kind: 'prompt',
            },
          }),
        );
      },
      { absolutePath: promptPath },
    );
    await editor.press('Enter');
    await expect
      .poll(() =>
        electronApp.evaluate(() => globalThis.__promptExpansionStarted),
      )
      .toBe(true);

    const picker = window
      .locator('[data-testid="chat-model-picker"]:visible')
      .first();
    await picker.click();
    await window.getByTestId('chat-model-more-openai').click();
    await window.getByTestId('chat-model-option-gpt-5.6-luna').click();
    await expect(window.getByTestId('chat-model-change-pending')).toBeVisible();
    await electronApp.evaluate(() => globalThis.__releasePromptExpansion());

    await window.waitForTimeout(500);
    await expect
      .poll(() =>
        electronApp.evaluate(() => globalThis.__staleModelSendObserved),
      )
      .toBe(false);
    await expect(editor).toContainText('Review');
    await expect(editor).toContainText('Prompt: Guard Race');
  } finally {
    await electronApp.evaluate(() => {
      globalThis.__releasePromptExpansion?.();
      globalThis.__releasePendingModel?.();
      globalThis.__releaseStaleModelSend?.();
    });
    await closeCanopy(electronApp, userDataDir);
  }
});

test('restores the confirmed model when a pending selection is refused', async () => {
  const fixture = await launchPendingModelFixture({ reject: true });
  try {
    const editor = fixture.window
      .locator('[data-slate-editor="true"]:visible')
      .first();
    await editor.fill('Keep this draft after rejection');
    const sendButton = fixture.window.getByRole('button', {
      name: 'Send message',
      exact: true,
    });
    await expect(
      sendButton.getByTestId('chat-model-change-pending'),
    ).toBeVisible();
    await expect(sendButton).toBeDisabled();
    await expect(fixture.picker).toContainText('GPT 5.6 Luna');
    await expect(
      fixture.window.getByTestId('chat-model-change-pending'),
    ).toBeVisible();
    await releasePendingModel(fixture.electronApp);
    await expect(
      fixture.window.getByTestId('chat-model-change-pending'),
    ).toHaveCount(0);
    await expect(fixture.picker).toContainText('GPT 5.6 Sol');
    await expect(sendButton).toBeEnabled();
    await expect(sendButton.locator('svg')).toHaveCount(1);
    await expect(editor).toContainText('Keep this draft after rejection');
  } finally {
    await releasePendingModel(fixture.electronApp);
    await closeCanopy(fixture.electronApp, fixture.userDataDir);
  }
});

test('a delayed acknowledgement cannot undo the latest model picked in an empty new chat', async () => {
  const userDataDir = prepareUserData();
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);
    await window.getByTestId('panel-add-tab-group-chat').click();
    await window.getByTestId('panel-add-menu-item-new-chat').click();
    const picker = window
      .locator('[data-testid="chat-model-picker"]:visible')
      .first();
    await picker.click();
    await window.getByTestId('chat-model-more-openai').click();
    await window.getByTestId('chat-model-option-gpt-5.6-sol').click();
    await expect(picker).toContainText('GPT 5.6 Sol');
    // Delay only the first reply after its real canonical mutation. Subsequent
    // clicks still exercise the shipping IPC, validation and persistence paths.
    await electronApp.evaluate(({ ipcMain }) => {
      const channel = 'chat:model-change';
      const original = ipcMain._invokeHandlers.get(channel);
      if (typeof original !== 'function') {
        throw new Error('Expected chat:model-change handler to be registered');
      }
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (event, request) => {
        const accepted = await original(event, request);
        if (request.model === 'gpt-5.6-luna') {
          await new Promise((resolve) => {
            globalThis.__releaseModelReply = resolve;
          });
        }
        return accepted;
      });
    });
    await picker.click();
    await window.getByTestId('chat-model-more-openai').click();
    await window.getByTestId('chat-model-option-gpt-5.6-luna').click();
    await expect
      .poll(() =>
        electronApp.evaluate(() => typeof globalThis.__releaseModelReply),
      )
      .toBe('function');
    await picker.click();
    await window.getByTestId('chat-model-option-gpt-6-astra').click();
    await expect(picker).toContainText('GPT 6 Astra');
    await expect(window.getByTestId('chat-model-change-pending')).toHaveCount(
      0,
    );
    await electronApp.evaluate(() => globalThis.__releaseModelReply());
    // Give the released reply a turn to reach the renderer and replay any
    // stale settings, then check both the label and main-owned state.
    await window.waitForTimeout(1_000);
    await expect(picker).toContainText('GPT 6 Astra');
    await expect
      .poll(() =>
        window.evaluate(
          async ({ projectId, worktreeId }) => {
            const snapshot = await window.api.chat.getState({
              projectId,
              worktreeId,
            });
            return snapshot.tabsFile.tabs.find(
              (tab) => tab.id === snapshot.tabsFile.activeTabId,
            )?.model;
          },
          { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
        ),
      )
      .toBe('gpt-6-astra');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('updates an empty new chat through repeated Codex model selections without switching tabs', async () => {
  const userDataDir = prepareUserData();
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);
    await window.getByTestId('panel-add-tab-group-chat').click();
    await window.getByTestId('panel-add-menu-item-new-chat').click();
    const picker = window
      .locator('[data-testid="chat-model-picker"]:visible')
      .first();
    for (const [model, label] of [
      ['gpt-6.1-sol', 'GPT 6.1 Sol'],
      ['gpt-6-sol', 'GPT 6 Sol'],
      ['gpt-6-luna', 'GPT 6 Luna'],
      ['gpt-5.6-sol', 'GPT 5.6 Sol'],
      ['gpt-5.6-luna', 'GPT 5.6 Luna'],
      ['gpt-5.6-terra', 'GPT 5.6 Terra'],
      ['gpt-6-astra', 'GPT 6 Astra'],
      ['gpt-5.6-luna', 'GPT 5.6 Luna'],
      ['gpt-5.6-sol', 'GPT 5.6 Sol'],
    ]) {
      await picker.click();
      if (
        model === 'gpt-6-sol' ||
        model === 'gpt-5.6-sol' ||
        model === 'gpt-5.6-luna' ||
        model === 'gpt-5.6-terra'
      ) {
        await window.getByTestId('chat-model-more-openai').click();
      }
      await window.getByTestId(`chat-model-option-${model}`).click();
      await expect(picker).toContainText(label);
      await expect
        .poll(() =>
          window.evaluate(
            async ({ projectId, worktreeId }) => {
              const snapshot = await window.api.chat.getState({
                projectId,
                worktreeId,
              });
              const tab = snapshot.tabsFile.tabs.find(
                (candidate) => candidate.id === snapshot.tabsFile.activeTabId,
              );
              return { model: tab?.model, messageCount: tab?.messages.length };
            },
            { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
          ),
        )
        .toEqual({ model, messageCount: 0 });
    }
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

for (const model of ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna']) {
  test(`clamps persisted Off to a supported effort on ${model}`, async () => {
    const userDataDir = prepareUserData();
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'codex',
      tabs: [
        { id: CHAT_ID, title: 'Thinking effort', model, thinkingLevel: 'off' },
      ],
    });
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);
      const thinking = window.getByTestId(CHAT_EFFORT_TRIGGER_TEST_ID);
      // CAN-4902 preserves the model's declared Low floor instead of aliasing
      // it to Medium; Luna still supports the persisted Off value directly.
      const clamped = model === 'gpt-6-luna' ? 'off' : 'low';
      await expect(thinking).toHaveAttribute('data-thinking-level', clamped);
      // The effort panel offers None only where the model supports it, and
      // moving off the clamped level commits the next one.
      const slider = await openEffortSlider(window, thinking);
      const stops = await readEffortStops(slider);
      if (model === 'gpt-6-luna') expect(stops).toContain('None');
      else expect(stops).not.toContain('None');
      // Traversing the stops commits each move. Wait for the final Home
      // update before choosing which direction moves away from the floor.
      await expect(slider).toHaveAttribute(
        'aria-valuetext',
        model === 'gpt-6-luna' ? 'None' : 'Low',
      );
      await stepEffortAway(slider);
      await expect(thinking).not.toHaveAttribute(
        'data-thinking-level',
        clamped,
      );
      await closeEffortPanel(window);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

test('trims the trigger to the model name without a restating tooltip', async () => {
  const userDataDir = prepareUserData();
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);

    const picker = window
      .locator('[data-testid="chat-model-picker"]:visible')
      .first();
    await expect(picker).toBeVisible();

    // AC 1a: name + version only. "Opus 5 1M" put a context-window detail in
    // the one place the model's identity belongs.
    const triggerText = ((await picker.textContent()) ?? '').trim();
    expect(triggerText.length).toBeGreaterThan(0);
    expect(triggerText).not.toMatch(CONTEXT_WINDOW_SUFFIX);
    expect(triggerText).not.toContain('1M');

    // AC 1b: no tooltip restating the label. The chat composer's chip needs
    // no description either, so a settled hover (past the selectors' 1s
    // tooltip delay) shows nothing, and there is no native `title`.
    await picker.hover();
    await window.waitForTimeout(1_500);
    await expect(window.locator('[role="tooltip"]')).toHaveCount(0);
    expect(await picker.getAttribute('title')).toBeNull();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('groups the dropdown under vendor headings and fits every label', async () => {
  const userDataDir = prepareUserData();
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const { menu } = await openComposerModelMenu(window);

    // AC 3: one heading per vendor, in the vendor's own casing.
    const headings = await readGroupHeadings(menu);
    expect(headings.length).toBeGreaterThan(0);
    expect(new Set(headings).size).toBe(headings.length);
    for (const heading of headings) {
      expect(KNOWN_VENDOR_HEADINGS).toContain(heading);
    }
    await menu.getByTestId('chat-model-harness-tab-claude').click();
    expect(await readGroupHeadings(menu)).toContain('Claude');
    await menu.getByTestId('chat-model-harness-tab-codex').click();
    expect(await readGroupHeadings(menu)).toContain('OpenAI');

    // A heading must organize rows, not restate one. Family grouping gave
    // every Claude model a heading of its own.
    const labels = await measureOptionLabels(menu);
    expect(labels.length).toBeGreaterThan(headings.length);

    // AC 2: no mid-sentence truncation, verified against the longest label
    // actually on screen rather than a short one.
    for (const label of labels) {
      expect(
        label.scrollWidth,
        `option label "${label.text}" is truncated`,
      ).toBeLessThanOrEqual(label.clientWidth + 1);
    }
    const longest = labels.reduce(
      (widest, label) =>
        label.text.length > widest.length ? label.text : widest,
      '',
    );
    expect(longest.length).toBeGreaterThanOrEqual('GPT 5.5'.length);

    // The subtext that used to sit inline, always cut off, is gone from the row.
    await expect(
      menu.locator('[data-testid^="chat-model-option-description"]'),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('keeps labels un-truncated at a non-default UI scale', async () => {
  // AC 4: the menu width and the type scale are both rem-based, so they should
  // track together — but "should" is why this runs at 150% rather than 100%.
  const userDataDir = prepareUserData(150);
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    await expect(window.locator('html')).toHaveAttribute(
      'data-ui-scale',
      '150',
    );
    // The scale is a uniform zoom, so the default 1400px window is a 933 CSS
    // px viewport here: the responsive composer folds its picker away in the
    // side-by-side layout, so maximize the chat group to reach it.
    const { menu } = await openComposerModelMenu(window, { expandChat: true });
    const labels = await measureOptionLabels(menu);
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) {
      expect(
        label.scrollWidth,
        `option label "${label.text}" is truncated at 150% UI scale`,
      ).toBeLessThanOrEqual(label.clientWidth + 1);
    }
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('keeps the Agents section visible in the compact picker', async () => {
  const userDataDir = prepareUserData();
  seedAgentModel(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const { menu } = await openComposerModelMenu(window);
    const agentsGroup = menu.getByRole('group', { name: 'Agents' });
    await expect(agentsGroup).toBeVisible();
    await expect(agentsGroup.locator('[data-model-id]')).toHaveCount(1);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('moves the model summary and context window into the row detail', async () => {
  const userDataDir = prepareUserData();
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const { menu } = await openComposerModelMenu(window);
    await expect(menu).toHaveAttribute('data-positioned', 'true');

    const row = menu
      .locator('[role="menuitemradio"][data-model-id]:visible')
      .first();
    const rowLabel = (
      (await row
        .locator('[data-testid^="chat-model-option-label-"]')
        .textContent()) ?? ''
    ).trim();
    // Hover only after the positioned menu finishes its entry scale.
    await waitForStableBox(row);
    await row.hover();

    const detail = rowDetail(window);
    await expect(detail).toBeVisible();
    // The card is titled with the model and says what the row cannot.
    await expect(detail).toContainText(rowLabel);
    await expect(detail).toContainText('Provider');
    // The context-window figure survives the trigger trim by living here.
    await expect(detail).toContainText('Context');

    // It wraps rather than clipping — the whole reason it left the row.
    const wraps = await detail.evaluate(
      (element) =>
        getComputedStyle(element).whiteSpace !== 'nowrap' &&
        element.scrollHeight <= element.clientHeight + 1,
    );
    expect(wraps).toBe(true);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('keeps a harness row detail off the model dropdown at narrow widths', async () => {
  // Pin the supported minimum sidebar width so the deliberately narrow
  // viewport exercises flyout placement without hiding the model picker via
  // the composer's independent toolbar-compression behavior.
  const userDataDir = prepareUserData(undefined, 220);
  const { electronApp } = await launchCanopy({
    userDataDir,
    viewportSize: FLYOUT_VIEWPORT,
  });

  try {
    const window = await electronApp.firstWindow();
    const { menu, rows } = await openClaudeModels(window);

    // The second row, so the hover is not confused with the focus the flyout
    // gives its first row on open.
    const row = rows.nth(1);
    // The detail is positioned once, from the row's rect at the moment it
    // opens, so read it only after the menu's scale-in settles. Hovering
    // mid-flight anchors the popup to a row that is still growing.
    await waitForStableBox(row);
    await row.hover();
    const detail = rowDetail(window);
    await expect(detail).toBeVisible();
    expect(await detail.getAttribute('id')).toBe(
      await row.getAttribute('aria-describedby'),
    );

    const [menuBox, rowBox, detailBox] = await Promise.all([
      menu.boundingBox(),
      row.boundingBox(),
      detail.boundingBox(),
    ]);
    const viewport = await window.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));

    expect(boxesIntersect(detailBox, menuBox)).toBe(false);
    expect(detailBox.x).toBeGreaterThanOrEqual(0);
    expect(detailBox.y).toBeGreaterThanOrEqual(0);
    expect(detailBox.x + detailBox.width).toBeLessThanOrEqual(viewport.width);
    expect(detailBox.y + detailBox.height).toBeLessThanOrEqual(viewport.height);
    // Still anchored to the hovered row. The popup is placed centred on the
    // row from its own PRE-WRAP height and keeps that `top` as its text wraps,
    // so its centre drifts with description length but the row's centre stays
    // inside the popup's top half. Asserting that relation rather than a pixel
    // budget keeps this stable whichever model the catalog lists second, while
    // still failing if the popup detaches from its row.
    const rowCenter = rowBox.y + rowBox.height / 2;
    const topOffset = rowCenter - detailBox.y;
    expect(topOffset).toBeGreaterThan(0);
    // A detail that does not wrap sits exactly centred, where row and popup
    // edges round to different sub-pixels; allow one pixel for that.
    expect(topOffset).toBeLessThanOrEqual(detailBox.height / 2 + 1);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('shows model detail on keyboard navigation and hover without opening it on search focus', async () => {
  const userDataDir = prepareUserData();
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const { menu, rows } = await openClaudeModels(window);
    const detail = rowDetail(window);

    const search = menu.getByTestId('chat-model-search');
    await search.focus();
    await expect(detail).toHaveCount(0);
    await search.press('ArrowDown');
    await expect(rows.first()).toBeFocused();
    await expect(detail).toBeVisible();
    expect(await detail.getAttribute('id')).toBe(
      await rows.first().getAttribute('aria-describedby'),
    );

    // So is hovering one. Wait for that row's own card: the focused row's
    // card is already open, so a generic visible check would pass too early.
    const hovered = rows.nth(2);
    await hovered.hover();
    const hoveredDetail = window.getByTestId(
      `chat-model-option-detail-${await hovered.getAttribute('data-model-id')}`,
    );
    await expect(hoveredDetail).toBeVisible();
    expect(
      (await hovered.getAttribute('aria-describedby'))?.split(' '),
    ).toContain(await hoveredDetail.getAttribute('id'));
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('presents every model in All as vendor sections that select in place', async () => {
  const userDataDir = prepareUserData();
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const { picker, menu } = await openComposerModelMenu(window, {
      expandChat: true,
    });
    await expect(menu).toHaveAttribute('data-positioned', 'true');

    // The composer's harness browser opens on All: every model at once.
    await expect(
      menu.getByTestId('chat-model-harness-tab-all'),
    ).toHaveAttribute('aria-checked', 'true');

    // Models from more than one vendor are reachable without switching views,
    // which is what "one list" has to mean to be worth anything. Two groups
    // are not vendors: the hosted catalog's loading or failed placeholder, and
    // the connect section (CAN-4590) for harnesses that are not connected.
    const groups = menu.locator('[role="group"][aria-label]');
    const sections = await groups.evaluateAll((nodes) =>
      nodes.map((node) => {
        const testId = node.getAttribute('data-testid') ?? '';
        return {
          heading: node.getAttribute('aria-label'),
          connect: testId.endsWith('-connect-section'),
          catalogStatus: testId.includes('-gateway-catalog-'),
        };
      }),
    );
    // The connect section lists only harnesses that are not connected, so it
    // is absent once all are; when shown, it follows every vendor.
    const connectIndex = sections.findIndex((section) => section.connect);
    if (connectIndex !== -1) {
      expect(connectIndex).toBe(sections.length - 1);
    }
    const headings = sections
      .filter((section) => !section.connect && !section.catalogStatus)
      .map((section) => section.heading);
    expect(headings.length).toBeGreaterThan(1);
    for (const heading of headings) {
      expect(KNOWN_VENDOR_HEADINGS).toContain(heading);
    }

    // And a row selects straight from that list.
    const rows = menu.locator('[role="menuitemradio"][data-model-id]:visible');
    await expect(rows.first()).toBeVisible();
    const label = await rows
      .first()
      .locator('[data-testid^="chat-model-option-label-"]')
      .innerText();
    await rows.first().click();
    await expect(menu).toBeHidden();
    await expect(picker).toContainText(label);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
