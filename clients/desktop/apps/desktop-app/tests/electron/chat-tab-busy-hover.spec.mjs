import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedWorkspaceApprovals,
  seedWorktreeChat,
} from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';

// A panel tab normally trades its leading icon for the close button while the
// pointer rests on it (`panels.css` swaps the two in the same slot). On a chat
// tab running a turn that leading icon is the thinking spinner — the only
// place the tab strip reports that work is in flight — so the swap erased the
// status the moment the user reached for the tab.
//
// A busy tab now keeps its spinner on hover and withholds the close button
// (which has nowhere else to go); closing stays on the context menu. This spec
// drives a REAL Claude turn against the shared mock provider with a slow
// stream (same seam as `chat-cancel-escape-confirm.spec.mjs`) so the renderer
// holds a genuine streaming frame, then compares hover behavior on the busy
// tab against an idle sibling and against the same tab once the turn ends.

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';
const BUSY_TAB_ID = 'busy-chat';
const IDLE_TAB_ID = 'idle-chat';
// Mock-server scenario markers must match /\[(Canopy-C[A-Za-z0-9_-]+)\]/
// (control-plane.mjs markerFromText) — the 'Canopy-C' prefix is mandatory.
const CONVERSATION_MARKER = 'Canopy-CBUSYTABHOVER';

/**
 * Hover a tab and run `assertions` while the pointer sits on it, retrying the
 * pair until both stick. Chromium drops `:hover` when a re-render replaces the
 * node under a stationary CDP pointer (see `closePanelTab` in canopyApp.mjs),
 * and a streaming tab re-renders constantly.
 */
async function withHover(window, panelId, assertions, timeout = 30_000) {
  const tab = window.getByTestId(`panel-tab-${panelId}`);
  await expect(async () => {
    await tab.hover({ timeout: 2_000 });
    await assertions();
  }).toPass({ timeout });
}

async function waitForBox(locator, label, timeout = 30_000) {
  let box = null;
  await expect
    .poll(
      async () => {
        box = await locator.boundingBox();
        return box !== null;
      },
      { message: `${label} geometry becomes available`, timeout },
    )
    .toBe(true);
  return box;
}

test.describe('busy chat tab hover (spinner is not swapped for close)', () => {
  test('a streaming tab keeps its spinner on hover; an idle tab still swaps', async () => {
    test.setTimeout(180_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-busy-tab-hover-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorkspaceApprovals({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      defaultMode: 'full-access',
    });
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'claude',
      tabs: [
        { id: BUSY_TAB_ID, title: 'Working' },
        { id: IDLE_TAB_ID, title: 'Idle' },
      ],
      activeTabId: BUSY_TAB_ID,
    });
    await registerScenario(DEFAULT_MOCK_BASE_URL, CONVERSATION_MARKER, {
      llm: {
        steps: [{ text: 'slow streaming turn', streamMs: 120_000 }],
      },
    });

    const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
      launchCanopy({ userDataDir }),
    );
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);

      const busyPanelId = `panel-chat-${BUSY_TAB_ID}`;
      const idlePanelId = `panel-chat-${IDLE_TAB_ID}`;
      const busyTab = window.getByTestId(`panel-tab-${busyPanelId}`);
      const idleTab = window.getByTestId(`panel-tab-${idlePanelId}`);
      await expect(busyTab).toBeVisible({ timeout: 30_000 });
      await expect(idleTab).toBeVisible();

      const busySpinner = busyTab.locator('[aria-label="Thinking"]');
      const busyClose = window.getByTestId(`panel-tab-close-${busyPanelId}`);
      const idleIcon = idleTab.locator('.canopy-panel-tab-icon');
      const idleClose = window.getByTestId(`panel-tab-close-${idlePanelId}`);

      // Baseline: not hovered, no turn running — the tab shows its provider
      // icon and no spinner.
      await expect(busySpinner).toHaveCount(0);

      const composer = window.getByRole('textbox').last();
      await composer.fill(`[${CONVERSATION_MARKER}] start a slow turn`);
      await composer.press('Enter');

      // The streaming-only stop control proves the turn is live.
      const stopButton = window.getByTestId('chat-stop-generation');
      await expect(stopButton).toBeVisible({ timeout: 30_000 });
      await expect(busySpinner).toBeVisible();

      // The regression: hovering the working tab must not hide the spinner,
      // and the close button that would occupy that slot stays withheld.
      await withHover(window, busyPanelId, async () => {
        await expect(busySpinner).toBeVisible({ timeout: 2_000 });
        await expect(busyClose).toBeHidden({ timeout: 2_000 });
      });

      // Control: the swap is intact for a tab that is not working. Its leading
      // icon hides and the close button takes the slot.
      await withHover(window, idlePanelId, async () => {
        await expect(idleIcon).toBeHidden({ timeout: 2_000 });
        await expect(idleClose).toBeVisible({ timeout: 2_000 });
      });

      // No jitter: the leading slot is one fixed box, so swapping the provider
      // icon for the spinner (or for the close button) must not move the label
      // or resize the tab. Measured while streaming, then again once idle.
      const measure = async () => {
        const [icon, label, tab] = await Promise.all([
          busyTab.locator('.canopy-panel-tab-icon').boundingBox(),
          busyTab.locator('.canopy-panel-tab-title').boundingBox(),
          busyTab.boundingBox(),
        ]);
        if (!icon || !label || !tab)
          throw new Error('tab geometry unavailable');
        return { icon, label, tab };
      };
      const streamingBox = await measure();
      const spinnerBox = await waitForBox(busySpinner, 'spinner');

      // Suppression is transient: once the turn stops, the working tab is an
      // ordinary tab again and its close button comes back.
      await stopButton.click();
      await expect(stopButton).toBeHidden({ timeout: 30_000 });
      await expect(busySpinner).toHaveCount(0);

      // Move off the tab before measuring its restored provider glyph. The
      // preceding hover assertion intentionally hides that SVG in favor of
      // the close button, so reading its box while hovered is undefined.
      await composer.hover();
      const providerBox = await waitForBox(
        busyTab.locator('.canopy-panel-tab-icon svg'),
        'provider glyph',
      );

      let idleBox;
      let closeBox;
      await withHover(window, busyPanelId, async () => {
        await expect(busyTab.locator('.canopy-panel-tab-icon')).toBeHidden({
          timeout: 2_000,
        });
        await expect(busyClose).toBeVisible({ timeout: 2_000 });
        // Capture both boxes in the same hover frame. A later re-render may
        // clear :hover even though the preceding visibility assertion passed.
        idleBox = await measure();
        closeBox = await busyClose.boundingBox();
        expect(closeBox, 'hovered close button geometry').not.toBeNull();
      });

      // Sub-pixel tolerance only; a whole-pixel difference is visible drift.
      const shifted = (a, b) => Math.abs(a - b);
      expect
        .soft(
          shifted(idleBox.icon.width, streamingBox.icon.width),
          `leading slot width: streaming ${streamingBox.icon.width} vs idle ${idleBox.icon.width}`,
        )
        .toBeLessThanOrEqual(0.5);
      expect
        .soft(
          shifted(idleBox.label.x, streamingBox.label.x),
          `label start: streaming ${streamingBox.label.x} vs idle ${idleBox.label.x}`,
        )
        .toBeLessThanOrEqual(0.5);
      expect
        .soft(
          shifted(idleBox.tab.width, streamingBox.tab.width),
          `tab width: streaming ${streamingBox.tab.width} vs idle ${idleBox.tab.width}`,
        )
        .toBeLessThanOrEqual(0.5);

      // The glyphs that alternate in that slot are also the same size: a
      // running tab must not read narrower than an idle one.
      expect(
        shifted(spinnerBox.width, providerBox.width),
        `glyph width: spinner ${spinnerBox.width} vs provider ${providerBox.width}`,
      ).toBeLessThanOrEqual(0.5);

      // The close button replaces the icon in place, so the two marks share a
      // center: a hover must not visually nudge the glyph sideways.
      const closeCenter = closeBox.x + closeBox.width / 2;
      const iconCenter = idleBox.icon.x + idleBox.icon.width / 2;
      expect(
        shifted(closeCenter, iconCenter),
        `close/icon centers: ${closeCenter} vs ${iconCenter}`,
      ).toBeLessThanOrEqual(0.5);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
