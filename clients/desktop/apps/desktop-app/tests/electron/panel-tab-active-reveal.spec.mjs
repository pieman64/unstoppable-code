// PR #2447 — active panel tabs remain visible without forcing fitting-strip
// rectangle measurements.
//
// The performance change skips expensive tab/strip getBoundingClientRect()
// reads when the strip fits. Its overflow state is observer-backed, so the
// regression fix also checks current scroll metrics synchronously before a
// reveal. This spec creates enough chat tabs through the real add-tab control to
// overflow a group, switches between the first and last tabs through the E2E
// panel API, and asserts both are revealed.
//
// Run after building the corresponding implementation:
//   pnpm run test:electron:built panel-tab-active-reveal.spec.mjs --reporter=line
//
// Determinism: the worktree and initial chat are seeded on disk, additional
// empty chats are created locally through renderer state, and no provider or
// network request runs. Visual evidence lives in the dedicated sibling
// the original panel-tab active-reveal regression flow.

import { expect, test } from '@playwright/test';
import { closeCanopy } from './launchCanopy.mjs';
import {
  collectLeaves,
  DEFAULT_GROUP_IDS,
  getLayout,
  seedPanelWorktree,
} from './panelHarness.mjs';

const ADDED_CHAT_COUNT = 9;

async function expectTabWithinStrip(strip, tab) {
  await expect
    .poll(async () => {
      return strip.evaluate(
        (stripElement, tabElement) => {
          const stripRect = stripElement.getBoundingClientRect();
          const tabRect = tabElement.getBoundingClientRect();
          return (
            tabRect.left >= stripRect.left - 1 &&
            tabRect.right <= stripRect.right + 1
          );
        },
        await tab.elementHandle(),
      );
    })
    .toBe(true);
}

test('active tab is revealed across an overflowing panel strip', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir, window } = await seedPanelWorktree();

  try {
    // Guarded: an unchecked `.find(...)` would blow up with "cannot read
    // properties of undefined" if layout seeding ever drifts, hiding the real
    // failure — and inside the poll below it would also mask the timeout
    // diagnostics.
    const chatPanelCount = async () => {
      const layout = await getLayout(window);
      const leaf = collectLeaves(layout.root).find(
        (candidate) => candidate.groupId === DEFAULT_GROUP_IDS.chat,
      );
      expect(leaf, 'chat group leaf missing from layout').toBeDefined();
      return leaf.panels.length;
    };

    const initialChatPanelCount = await chatPanelCount();

    for (let index = 0; index < ADDED_CHAT_COUNT; index += 1) {
      await window.getByTestId('panel-add-tab-group-chat').click();
      await expect.poll(chatPanelCount).toBe(initialChatPanelCount + index + 1);
    }

    const group = window.getByTestId(`panel-group-${DEFAULT_GROUP_IDS.chat}`);
    const strip = group.locator('.canopy-panel-tab-strip').last();
    await expect(strip).toBeVisible();
    await expect
      .poll(() =>
        strip.evaluate((element) => element.scrollWidth > element.clientWidth),
      )
      .toBe(true);

    const layout = await getLayout(window);
    const chatLeaf = collectLeaves(layout.root).find(
      (leaf) => leaf.groupId === DEFAULT_GROUP_IDS.chat,
    );
    expect(chatLeaf).toBeTruthy();
    expect(chatLeaf.panels.length).toBeGreaterThan(2);
    const firstPanelId = chatLeaf.panels[0].panelId;
    const lastPanelId = chatLeaf.panels.at(-1).panelId;
    const firstTab = window.getByTestId(`panel-tab-${firstPanelId}`);
    const lastTab = window.getByTestId(`panel-tab-${lastPanelId}`);

    await window.evaluate(
      ([groupId, panelId]) =>
        window.__canopyPanelTestApi.focusPanel(groupId, panelId),
      [DEFAULT_GROUP_IDS.chat, firstPanelId],
    );
    await expect(firstTab).toHaveAttribute('data-active', 'true');
    await expectTabWithinStrip(strip, firstTab);

    await window.evaluate(
      ([groupId, panelId]) =>
        window.__canopyPanelTestApi.focusPanel(groupId, panelId),
      [DEFAULT_GROUP_IDS.chat, lastPanelId],
    );
    await expect(lastTab).toHaveAttribute('data-active', 'true');
    await expectTabWithinStrip(strip, lastTab);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
