// Phase 4 grid operations — stacking panels as tabs inside one group via the
// add-panel affordance (`panel-add-panel-${groupId}` -> `panel-add-menu` ->
// `panel-add-menu-item-${kind}`), switching tabs, and closing a tab.
//
// Post per-tab-chat rework: the add menu offers singleton kinds not yet open
// (browser, file-explorer for the default layout), per-entity chat/file
// entries for UNBOUND chatStore tabs (`panel-add-menu-item-chat-<tabId>` —
// none for a freshly seeded worktree, whose only chat tab is already bound),
// and one activity-card entry per section
// (`panel-add-menu-item-activity-card-<sectionId>`). This spec stacks the
// singleton `file-explorer` kind onto the chat group.
//
// Key content contract: every tab's lightweight panel frame stays MOUNTED
// across tab switches (PanelGroup hides non-active tabs with the `hidden`
// attribute). Expensive chat surfaces unmount while hidden; composer drafts
// must survive that lifecycle through chatStore persistence.

import { expect, test } from '@playwright/test';
import { closePanelTab } from './canopyApp.mjs';
import { closeCanopy } from './launchCanopy.mjs';
import {
  collectLeaves,
  countLeaves,
  DEFAULT_GROUP_IDS,
  DEFAULT_PANEL_IDS,
  getLayout,
  SEEDED_CHAT_TAB_ID,
  seedPanelWorktree,
} from './panelHarness.mjs';

async function chatGroupTabs(window) {
  const layout = await getLayout(window);
  const leaf = collectLeaves(layout.root).find(
    (node) => node.groupId === DEFAULT_GROUP_IDS.chat,
  );
  return leaf
    ? { panels: leaf.panels, activePanelId: leaf.activePanelId }
    : null;
}

test('add-tab menu stacks a second panel, tab switching preserves mounted content, closing returns to one tab', async ({}, testInfo) => {
  const { electronApp, userDataDir, window } = await seedPanelWorktree();
  const rendererErrors = [];
  window.on('pageerror', (error) => rendererErrors.push(error.message));

  try {
    // Mark the stable chat panel frame and seed a composer draft before any
    // tab operations. The frame must survive; the expensive surface should
    // unmount while hidden and restore the draft when shown again.
    await window.evaluate(() => {
      const element = document.querySelector(
        '[data-testid="panel-content-chat"]',
      );
      if (!element) {
        throw new Error('chat panel content not mounted');
      }
      element.__panelPersistenceMarker = 'kept';
    });
    const composer = window
      .getByTestId('panel-content-chat')
      .locator('[data-chat-textarea][contenteditable="true"]');
    await composer.fill('draft survives hidden chat suspension');

    // --- Add a file-explorer tab to the chat group -------------------------
    await window.getByTestId('panel-add-panel-group-chat').click();
    const addMenu = window.getByTestId('panel-add-menu');
    await expect(addMenu).toBeVisible();
    // Singleton kinds not already open in the default layout.
    for (const kind of ['browser', 'file-explorer']) {
      await expect(
        window.getByTestId(`panel-add-menu-item-${kind}`),
      ).toBeVisible();
    }
    // Terminal is repeatable and its profiles live in a nested flyout.
    await window.getByTestId('panel-add-menu-terminal-submenu').click();
    await expect(
      window.getByTestId('panel-add-menu-terminal-shells-group'),
    ).toBeVisible();
    // Already-open singletons and already-bound chat tabs are NOT offered.
    await expect(
      window.getByTestId('panel-add-menu-item-activity-section'),
    ).toHaveCount(0);
    await expect(
      window.getByTestId(`panel-add-menu-item-chat-${SEEDED_CHAT_TAB_ID}`),
    ).toHaveCount(0);
    // Activity sections are offered as per-section cards.
    await expect(
      window.getByTestId('panel-add-menu-item-activity-card-summary'),
    ).toBeVisible();

    await window.getByTestId('panel-add-menu-item-file-explorer').click();
    await expect(addMenu).toBeHidden();

    // Store state: two tabs, fresh panel id, new tab active; no new group.
    let tabs = await chatGroupTabs(window);
    expect(tabs.panels).toHaveLength(2);
    expect(tabs.panels[0]).toMatchObject({
      panelId: DEFAULT_PANEL_IDS.chat,
      kind: 'chat',
      instance: { chatTabId: SEEDED_CHAT_TAB_ID },
    });
    const explorerPanelId = tabs.panels[1].panelId;
    expect(tabs.panels[1].kind).toBe('file-explorer');
    expect(explorerPanelId).not.toBe(DEFAULT_PANEL_IDS.chat);
    expect(tabs.activePanelId).toBe(explorerPanelId);
    expect(await countLeaves(window)).toBe(3);

    // DOM: both tabs render in the chat group's title bar; the new one is
    // active and shows its content. The chat frame remains mounted but its
    // expensive composer/transcript subtree is suspended.
    const chatTab = window.getByTestId(`panel-tab-${DEFAULT_PANEL_IDS.chat}`);
    const explorerTab = window.getByTestId(`panel-tab-${explorerPanelId}`);
    await expect(explorerTab).toHaveAttribute('data-active', 'true');
    await expect(chatTab).toHaveAttribute('data-active', 'false');
    await expect(
      window.getByTestId('panel-content-file-explorer'),
    ).toBeVisible();
    await expect(window.getByTestId('panel-content-chat')).toBeHidden();
    await expect(
      window
        .getByTestId('panel-content-chat')
        .locator('[data-chat-textarea][contenteditable="true"]'),
    ).toHaveCount(0);

    // --- Switch back: stable frame and persisted composer draft return ------
    await chatTab.click();
    await expect(chatTab).toHaveAttribute('data-active', 'true');
    await expect(explorerTab).toHaveAttribute('data-active', 'false');
    await expect(window.getByTestId('panel-content-chat')).toBeVisible();
    await expect(
      window.getByTestId('panel-content-file-explorer'),
    ).toBeHidden();

    expect(
      await window.evaluate(
        () =>
          document.querySelector('[data-testid="panel-content-chat"]')
            ?.__panelPersistenceMarker ?? null,
      ),
    ).toBe('kept');
    await expect(composer).toHaveText('draft survives hidden chat suspension');

    // Reproduce Chromium delivering a blur that was already queued while a
    // focused composer is synchronously suspended by the real panel-tab flow.
    // Slate removes its editor-to-element weak-map entry during that suspend;
    // the stale blur must be discarded instead of reaching Editable's handler.
    await composer.click();
    await composer.evaluate((editable, targetPanelId) => {
      const panelApi = window.__canopyPanelTestApi;
      if (!panelApi) {
        throw new Error('panel test API is not installed');
      }
      editable.addEventListener(
        'focusout',
        () => {
          panelApi.focusPanel('group-chat', targetPanelId);
        },
        { capture: true, once: true },
      );
      editable.dispatchEvent(
        new FocusEvent('focusout', { bubbles: true, relatedTarget: null }),
      );
    }, explorerPanelId);
    await expect(explorerTab).toHaveAttribute('data-active', 'true');
    expect(
      rendererErrors.filter((message) =>
        message.includes('Cannot resolve a DOM node from Slate node'),
      ),
    ).toEqual([]);

    await chatTab.click();
    await expect(chatTab).toHaveAttribute('data-active', 'true');

    tabs = await chatGroupTabs(window);
    expect(tabs.activePanelId).toBe(DEFAULT_PANEL_IDS.chat);

    // --- Escape dismisses a reopened add menu ------------------------------
    await window.getByTestId('panel-add-panel-group-chat').click();
    await expect(addMenu).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(addMenu).toBeHidden();

    // --- Close the added tab: back to one tab, group survives --------------
    await closePanelTab(window, explorerPanelId);
    await expect(explorerTab).toHaveCount(0);
    await expect(chatTab).toHaveAttribute('data-active', 'true');

    tabs = await chatGroupTabs(window);
    expect(tabs.panels).toHaveLength(1);
    expect(tabs.activePanelId).toBe(DEFAULT_PANEL_IDS.chat);
    expect(await countLeaves(window)).toBe(3);
    await expect(window.getByTestId('panel-content-chat')).toBeVisible();

    await window.screenshot({
      path: testInfo.outputPath('worktree-panels-tabs.png'),
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// The Usage add-menu group: five variants under a labeled "Usage" section
// (`panel-add-menu-item-usage-${variant}`), each a distinct instance of the
// single `usage` kind. Adding one stacks a `usage` panel bound to its variant.
for (const pinnedVariant of ['codex', 'cursor']) {
  test(`add-tab menu offers the Usage group and stacks a ${pinnedVariant} usage panel`, async () => {
    const { electronApp, userDataDir, window } = await seedPanelWorktree();

    try {
      await window.getByTestId('panel-add-panel-group-chat').click();
      const addMenu = window.getByTestId('panel-add-menu');
      await expect(addMenu).toBeVisible();

      // Usage renders as a nested flyout: open it explicitly from its
      // submenu row, then the five variants appear in the flyout.
      await window.getByTestId('panel-add-menu-usage-submenu').click();
      await expect(
        window.getByTestId('panel-add-menu-usage-group'),
      ).toBeVisible();
      for (const variant of [
        'all',
        'active-chat',
        'codex',
        'claude',
        'cursor',
      ]) {
        await expect(
          window.getByTestId(`panel-add-menu-item-usage-${variant}`),
        ).toBeVisible();
      }

      // Add the selected provider variant.
      await window
        .getByTestId(`panel-add-menu-item-usage-${pinnedVariant}`)
        .click();
      await expect(addMenu).toBeHidden();

      // Content mounts; the panel root carries its variant.
      const usageContent = window.getByTestId('panel-content-usage');
      await expect(usageContent).toBeVisible();
      await expect(usageContent.getByTestId('usage-panel')).toHaveAttribute(
        'data-variant',
        pinnedVariant,
      );

      // Store state: a second tab of kind `usage`, bound to the selected provider variant.
      const tabs = await chatGroupTabs(window);
      expect(tabs.panels).toHaveLength(2);
      expect(tabs.panels[1]).toMatchObject({
        kind: 'usage',
        instance: { variant: pinnedVariant },
      });
      expect(tabs.activePanelId).toBe(tabs.panels[1].panelId);

      // Reopening the menu no longer offers the just-added provider variant, but
      // still offers the other variants.
      await window.getByTestId('panel-add-panel-group-chat').click();
      await expect(addMenu).toBeVisible();
      await window.getByTestId('panel-add-menu-usage-submenu').click();
      await expect(
        window.getByTestId(`panel-add-menu-item-usage-${pinnedVariant}`),
      ).toHaveCount(0);
      await expect(
        window.getByTestId('panel-add-menu-item-usage-all'),
      ).toBeVisible();
      await window.keyboard.press('Escape');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

test('App Advisor respects the Cursor usage rollout after the menu hides it', async () => {
  const { electronApp, userDataDir, window } = await seedPanelWorktree();
  try {
    await window.getByTestId('panel-add-panel-group-chat').click();
    await window.getByTestId('panel-add-menu-usage-submenu').click();
    await expect(
      window.getByTestId('panel-add-menu-item-usage-cursor'),
    ).toBeVisible();

    await electronApp.evaluate(() => {
      const values = JSON.parse(process.env.CANOPY_E2E_CLIENT_FEATURE_FLAGS);
      values['canopy-desktop-cursor-harness'] = false;
      process.env.CANOPY_E2E_CLIENT_FEATURE_FLAGS = JSON.stringify(values);
    });
    await window.evaluate(() => window.api.featureFlags.refreshContext());
    await expect(
      window.getByTestId('panel-add-menu-item-usage-cursor'),
    ).toHaveCount(0);
    await window.keyboard.press('Escape');
    await window.keyboard.press('Escape');
    await expect(window.getByTestId('panel-add-menu')).toBeHidden();
    const before = await getLayout(window);

    // Deliver the same IPC envelope as an Advisor tool call. Only its response
    // sink is replaced in this isolated app; the preload, bridge, dispatcher,
    // flag store and panel UI all run their production implementations.
    const dispatchCursorUsage = async (requestId) =>
      electronApp.evaluate(({ BrowserWindow, ipcMain }, id) => {
        const responseChannel = 'app-advisor:tool-response';
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            ipcMain.removeHandler(responseChannel);
            reject(new Error('Advisor panel action did not respond'));
          }, 15_000);
          ipcMain.removeHandler(responseChannel);
          ipcMain.handleOnce(responseChannel, (_event, response) => {
            clearTimeout(timer);
            resolve(response);
          });
          BrowserWindow.getAllWindows()[0].webContents.send(
            'app-advisor:tool-request',
            {
              requestId: id,
              kind: 'dispatch_action',
              action: {
                type: 'panel.add_tab',
                kind: 'usage',
                variant: 'cursor',
              },
            },
          );
        });
      }, requestId);

    const disabled = await dispatchCursorUsage('cursor-usage-disabled');
    expect(disabled).toMatchObject({
      ok: false,
      error: { code: 'surface_unavailable' },
    });
    expect(await getLayout(window)).toEqual(before);
    await expect(window.getByTestId('panel-content-usage')).toHaveCount(0);

    await electronApp.evaluate(() => {
      const values = JSON.parse(process.env.CANOPY_E2E_CLIENT_FEATURE_FLAGS);
      values['canopy-desktop-cursor-harness'] = true;
      process.env.CANOPY_E2E_CLIENT_FEATURE_FLAGS = JSON.stringify(values);
    });
    await window.evaluate(() => window.api.featureFlags.refreshContext());
    await window.getByTestId('panel-add-panel-group-chat').click();
    await window.getByTestId('panel-add-menu-usage-submenu').click();
    await expect(
      window.getByTestId('panel-add-menu-item-usage-cursor'),
    ).toBeVisible();
    await window.keyboard.press('Escape');

    await window.keyboard.press('Escape');
    expect(await dispatchCursorUsage('cursor-usage-enabled')).toMatchObject({
      ok: true,
    });
    await expect(window.getByTestId('usage-panel')).toHaveAttribute(
      'data-variant',
      'cursor',
    );
    await expect(window.getByTestId('panel-content-usage')).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// The tab strip's `+` creates a fresh chatStore tab AND places its bound
// panel in the clicked group — ahead of the chat ⇄ panel sync bridge, which
// would otherwise MRU-place it into the chat group.
test('tab-strip + places the new chat panel in the clicked group', async ({}, testInfo) => {
  const { electronApp, userDataDir, window } = await seedPanelWorktree();

  try {
    // Add Chat through the TERMINAL group's panel catalog: target-group
    // placement must win over the bridge's MRU chat-group placement. Advanced
    // mode only shows the direct New Chat `+` on groups already holding chat.
    await window.getByTestId('panel-add-panel-group-terminal').click();
    await window.getByTestId('panel-add-menu-item-new-chat').click();

    // Store state: the terminal group gained a chat-bound panel with the
    // deterministic `panel-chat-<chatTabId>` id, active in its group.
    const layout = await getLayout(window);
    const terminalLeaf = collectLeaves(layout.root).find(
      (node) => node.groupId === DEFAULT_GROUP_IDS.terminal,
    );
    expect(terminalLeaf).toBeTruthy();
    const chatPanel = terminalLeaf.panels.find(
      (panel) => panel.kind === 'chat',
    );
    expect(chatPanel).toBeTruthy();
    expect(chatPanel.instance?.chatTabId).toBeTruthy();
    expect(chatPanel.panelId).toBe(
      `panel-chat-${chatPanel.instance.chatTabId}`,
    );
    expect(chatPanel.instance.chatTabId).not.toBe(SEEDED_CHAT_TAB_ID);
    expect(terminalLeaf.activePanelId).toBe(chatPanel.panelId);

    // DOM: the bound panel tab renders active in the terminal group's strip.
    await expect(
      window.getByTestId(`panel-tab-${chatPanel.panelId}`),
    ).toHaveAttribute('data-active', 'true');

    await window.screenshot({
      path: testInfo.outputPath('worktree-panels-new-chat.png'),
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('bound chat panel shows a loading state while chat tabs hydrate', async ({}, testInfo) => {
  const { electronApp, userDataDir, window } = await seedPanelWorktree();

  try {
    await expect(window.getByTestId('panel-content-chat')).toBeVisible();

    await window.evaluate(() => {
      window.__canopyPanelTestApi.simulateChatHydrationPending();
    });

    await expect(window.getByTestId('panel-binding-loading')).toBeVisible();
    await expect(window.getByText('This chat is no longer open')).toHaveCount(
      0,
    );

    await window.screenshot({
      path: testInfo.outputPath('worktree-panels-chat-loading.png'),
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
