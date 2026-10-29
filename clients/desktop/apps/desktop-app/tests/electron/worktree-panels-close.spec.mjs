// Phase 4 grid operations — closing groups through the overflow ("…") menu's
// Close-all item (`panel-group-menu-${groupId}` -> `panel-group-close-
// ${groupId}`): the emptied branch collapses back into its parent (engine
// branch promotion), focus lands on the most-recently-active surviving group
// (MRU, doc 04), and the LAST remaining group's close-all item and maximize
// button are disabled (the grid always holds >= 1 view).

import { expect, test } from '@playwright/test';
import { closeCanopy } from './launchCanopy.mjs';
import {
  collectLeaves,
  countLeaves,
  DEFAULT_GROUP_IDS,
  DEFAULT_PANEL_IDS,
  getActiveGroupId,
  getLayout,
  seedPanelWorktree,
  splitViaApi,
} from './panelHarness.mjs';

/** Open a group's overflow menu (focuses the group) and click Close all. */
async function closeGroupViaMenu(scope, groupId) {
  await scope.getByTestId(`panel-group-menu-${groupId}`).click();
  await scope.getByTestId(`panel-group-close-${groupId}`).click();
}

test('closing groups collapses branches, focuses the MRU sibling, and disables close on the last group', async ({}, testInfo) => {
  const { electronApp, userDataDir, window } = await seedPanelWorktree();

  try {
    expect(await countLeaves(window)).toBe(3);
    // MRU after the default-layout build: [chat, terminal, activity].
    expect(await getActiveGroupId(window)).toBe(DEFAULT_GROUP_IDS.chat);

    // --- Split then close: the branch collapses back --------------------
    const newGroupId = await splitViaApi(
      window,
      DEFAULT_GROUP_IDS.activity,
      'down',
    );
    await expect.poll(() => countLeaves(window)).toBe(4);
    expect(await getActiveGroupId(window)).toBe(newGroupId);
    // The activity leaf became a vertical branch [activity, NEW].
    let layout = await getLayout(window);
    expect(layout.root.children[1].type).toBe('branch');

    await closeGroupViaMenu(window, newGroupId);

    await expect.poll(() => countLeaves(window)).toBe(3);
    await expect(window.getByTestId(`panel-group-${newGroupId}`)).toHaveCount(
      0,
    );
    // Branch collapse: the lone surviving child was promoted back to a
    // root-level leaf (the default tree shape returns exactly).
    layout = await getLayout(window);
    expect(layout.root.children).toHaveLength(2);
    expect(layout.root.children[1]).toMatchObject({
      type: 'leaf',
      groupId: DEFAULT_GROUP_IDS.activity,
    });

    // MRU focus: the closed group was active; chat was the most recently
    // active surviving group (default build focuses chat last).
    expect(await getActiveGroupId(window)).toBe(DEFAULT_GROUP_IDS.chat);
    await expect(
      window.getByTestId(`panel-group-${DEFAULT_GROUP_IDS.chat}`),
    ).toHaveAttribute('data-active', 'true');

    // --- Close down to a single group ------------------------------------
    await closeGroupViaMenu(window, DEFAULT_GROUP_IDS.terminal);
    await expect.poll(() => countLeaves(window)).toBe(2);
    // Opening a group's overflow menu first FOCUSES that group (capture-phase
    // mousedown), so the close removes the active group and MRU focus falls
    // back to chat — the most recently active survivor.
    expect(await getActiveGroupId(window)).toBe(DEFAULT_GROUP_IDS.chat);

    await closeGroupViaMenu(window, DEFAULT_GROUP_IDS.activity);
    await expect.poll(() => countLeaves(window)).toBe(1);
    expect(await getActiveGroupId(window)).toBe(DEFAULT_GROUP_IDS.chat);

    // --- Last remaining group: Full screen + Close-all menu items disabled -
    await window
      .getByTestId(`panel-group-menu-${DEFAULT_GROUP_IDS.chat}`)
      .click();
    const maximizeChat = window.getByTestId(
      `panel-group-maximize-${DEFAULT_GROUP_IDS.chat}`,
    );
    const closeChat = window.getByTestId(
      `panel-group-close-${DEFAULT_GROUP_IDS.chat}`,
    );
    await expect(maximizeChat).toBeDisabled();
    await expect(closeChat).toBeDisabled();

    // Clicking the disabled item must be inert.
    await closeChat.click({ force: true });
    expect(await countLeaves(window)).toBe(1);
    await expect(
      window.getByTestId(`panel-group-${DEFAULT_GROUP_IDS.chat}`),
    ).toBeVisible();
    await expect(window.getByTestId('panel-content-chat')).toBeVisible();

    await window.screenshot({
      path: testInfo.outputPath('worktree-panels-close.png'),
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('closing the final chat panel preserves its group with a fresh chat', async ({}, testInfo) => {
  const { electronApp, userDataDir, window } = await seedPanelWorktree();

  try {
    const before = await getLayout(window);
    const chatTab = window.getByTestId(`panel-tab-${DEFAULT_PANEL_IDS.chat}`);
    await chatTab.click({ button: 'right' });
    await window.getByTestId('panel-tab-context-close').click();

    await expect(chatTab).toHaveCount(0);
    await expect
      .poll(async () => {
        const layout = await getLayout(window);
        const chatGroup = collectLeaves(layout.root).find(
          (leaf) => leaf.groupId === DEFAULT_GROUP_IDS.chat,
        );
        const chatTabId = chatGroup?.panels[0]?.instance?.chatTabId ?? null;
        return chatTabId !== null && chatTabId !== 'seed-chat';
      })
      .toBe(true);

    const after = await getLayout(window);
    const chatGroup = collectLeaves(after.root).find(
      (leaf) => leaf.groupId === DEFAULT_GROUP_IDS.chat,
    );
    expect(await countLeaves(window)).toBe(3);
    expect(chatGroup?.panels).toHaveLength(1);
    expect(chatGroup?.panels[0]).toMatchObject({ kind: 'chat' });
    expect(after.root).toMatchObject({
      type: before.root.type,
      orientation: before.root.orientation,
    });

    await window.screenshot({
      path: testInfo.outputPath('worktree-panels-final-chat-close.png'),
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
