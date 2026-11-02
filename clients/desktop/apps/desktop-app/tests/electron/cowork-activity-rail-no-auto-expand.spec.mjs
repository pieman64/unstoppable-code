// CAN-4793 — a Cowork Activity rail never opens itself on content.
//
// Cowork reaches the same CAN-2836 seeder as a code worktree, so its
// `group-activity` rail mounts collapsed with `auto` on the persisted
// descriptor. Code worktrees spend that flag on their first work
// (`worktree-panels-activity-auto-expand.spec.mjs`); Cowork must not, or a
// finished reply that records cost springs the rail open and narrows the chat.
// The user opens it from the collapsed edge bar instead.
//
// Content is seeded cost for the named Work Entry, matching the report. The
// seed is on disk before launch, so this covers content present at first
// paint; content arriving later is pinned by the hook's unit test.
//
// Run: pnpm run test:electron:built cowork-activity-rail-no-auto-expand.spec.mjs --reporter=line

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { expandCoworkWorkspace } from './coworkWorkEntryDoneFixture.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { collectLeaves, getLayout } from './panelHarness.mjs';
import { seedCostInsights } from './seeders/index.mjs';
import {
  CHATS_SECTION_NAMED_COWORK_ENTRY_ID,
  CHATS_SECTION_NAMED_COWORK_ID,
  seedChatsSectionFixture,
} from './seeders/seedChatsSectionFixture.mjs';

const CHAT_GROUP_ID = 'group-chat';

for (const [mode, RAIL_GROUP_ID] of [
  ['default', 'group-activity'],
  ['minimal', 'group-extras'],
]) {
  test.describe(`${mode} Cowork layout`, () => {
    /**
     * The activity rail leaf, or `undefined` before the layout hydrates. A newly
     * selected Work Entry installs the test API before it ensures its layout, so
     * that gap reads as "not yet" rather than failing the poll that waits it out.
     */
    async function railLeaf(window) {
      const layout = await getLayout(window).catch((error) => {
        if (
          error instanceof Error &&
          error.message.includes('No panel layout for worktree')
        ) {
          return null;
        }
        throw error;
      });
      return collectLeaves(layout?.root).find(
        (leaf) => leaf.groupId === RAIL_GROUP_ID,
      );
    }

    function railControl(window, action) {
      return mode === 'minimal'
        ? window.getByTestId('workspace-layout-side-panel-toggle')
        : window.getByTestId(`panel-group-${action}-${RAIL_GROUP_ID}`);
    }

    async function expectCollapsedChrome(window) {
      const group = window.getByTestId(`panel-group-${RAIL_GROUP_ID}`);
      if (mode === 'minimal') {
        // Minimal hides the entire optional region and exposes its toggle
        // in the top bar; the default layout uses a collapsed edge strip.
        await expect(group).toBeHidden();
        await expect(railControl(window, 'expand')).toBeVisible();
      } else {
        await expect(
          group.getByTestId(`panel-collapsed-bar-${RAIL_GROUP_ID}`),
        ).toBeVisible();
      }
    }

    /** The rail's collapse edge (e.g. `'right'`), or `null` when expanded. */
    async function railCollapsed(window) {
      return (await railLeaf(window))?.collapsed ?? null;
    }

    /** Whether the rail's collapse is Canopy's seeded default, not the user's. */
    async function railCollapsedIsAuto(window) {
      return (await railLeaf(window))?.collapsedAuto === true;
    }

    /**
     * Bumps the layout revision twice without touching the rail. The hook retries
     * on every revision, and the bridge declines while a group is maximized, so
     * restoring the chat group is exactly the pass that would reopen a rail the
     * policy still allowed to open.
     */
    async function bumpLayoutRevisions(window) {
      for (const maximized of [true, false]) {
        await window.evaluate(
          ([groupId, value]) =>
            window.__canopyPanelTestApi.maximizeGroup(groupId, value),
          [CHAT_GROUP_ID, maximized],
        );
      }
    }

    /**
     * Fails if the rail opens at any point during a settled window. A single
     * negative check would pass on the initial collapsed state before the hook's
     * effect ever ran.
     */
    async function expectRailStaysCollapsed(window, { settleMs = 3_000 } = {}) {
      const deadline = Date.now() + settleMs;
      while (Date.now() < deadline) {
        expect(await railCollapsed(window)).not.toBeNull();
        await window.waitForTimeout(250);
      }
    }

    async function launchCoworkEntryWithCost() {
      const userDataDir = mkdtempSync(
        path.join(os.tmpdir(), 'canopy-cowork-rail-'),
      );
      seedChatsSectionFixture(userDataDir, {
        worktreeCount: 0,
        chatEntryCount: 0,
      });
      const cost = seedCostInsights({
        userDataDir,
        workspaceId: CHATS_SECTION_NAMED_COWORK_ID,
        worktreeId: CHATS_SECTION_NAMED_COWORK_ENTRY_ID,
        // Keep the saved Activity rail independent of the sidebar preference.
        earlyAccess: mode !== 'minimal',
      });
      if (mode === 'minimal') {
        const entryDataDir = path.join(
          userDataDir,
          'workspaces',
          CHATS_SECTION_NAMED_COWORK_ID,
          'worktree-data',
          CHATS_SECTION_NAMED_COWORK_ENTRY_ID,
        );
        mkdirSync(entryDataDir, { recursive: true });
        writeFileSync(
          path.join(entryDataDir, 'panel-layout-mode.json'),
          JSON.stringify({ version: 1, mode }),
        );
        // Persist a user's existing Activity rail. Fresh Minimal layouts now
        // start empty; this regression protects a saved collapsed rail with
        // content, not the retired default tab seeder.
        writeFileSync(
          path.join(entryDataDir, 'panel-layout.json'),
          JSON.stringify({
            version: 1,
            grid: {
              orientation: 0,
              width: 1280,
              height: 800,
              root: {
                type: 'branch',
                size: 800,
                children: [
                  {
                    type: 'branch',
                    size: 600,
                    children: [
                      {
                        type: 'leaf',
                        groupId: CHAT_GROUP_ID,
                        size: 960,
                        panels: [],
                        activePanelId: null,
                      },
                      {
                        type: 'leaf',
                        groupId: RAIL_GROUP_ID,
                        size: 320,
                        panels: [
                          {
                            panelId: 'panel-activity',
                            kind: 'activity-section',
                          },
                        ],
                        activePanelId: 'panel-activity',
                        collapsed: {
                          edge: 'right',
                          expandedSize: 320,
                          auto: true,
                        },
                      },
                    ],
                  },
                  {
                    type: 'leaf',
                    groupId: 'group-terminal',
                    size: 200,
                    panels: [{ panelId: 'panel-terminal', kind: 'terminal' }],
                    activePanelId: 'panel-terminal',
                    collapsed: { edge: 'bottom', expandedSize: 200 },
                  },
                ],
              },
            },
            activeGroupId: CHAT_GROUP_ID,
            mostRecentActiveGroupIds: [CHAT_GROUP_ID],
          }),
        );
      }
      const launched = await launchCanopy({ userDataDir });
      const window = await launched.electronApp.firstWindow();
      await window.setViewportSize({ width: 1280, height: 800 });
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openChatPage();
      // Navigate by hand: `selectWorktree`/`expandDefaultActivityRail` can open
      // the rail themselves and would mask the bug.
      await expandCoworkWorkspace(window, CHATS_SECTION_NAMED_COWORK_ID);
      await window
        .getByTestId(
          `sidebar-work-entry-${CHATS_SECTION_NAMED_COWORK_ENTRY_ID}`,
        )
        .click();
      await expect(window.getByTestId('cowork-top-bar')).toBeVisible({
        timeout: 15_000,
      });
      await expect.poll(() => railLeaf(window)).toBeDefined();
      return { userDataDir, cost, launched, window };
    }

    /**
     * Waits until the mounted rail has rendered the seeded cost. A collapsed
     * group keeps its body mounted and hides it with CSS, so this proves the
     * rail's own content signal saw the work, whatever the rail's open state.
     */
    async function waitForRailCost(window, expectedTotal) {
      await expect(
        window
          .getByTestId(`panel-group-${RAIL_GROUP_ID}`)
          .getByTestId('activity-section-cost'),
      ).toContainText(expectedTotal, { timeout: 30_000 });
    }

    test('a Cowork rail stays collapsed with work present, until the user opens it', async () => {
      test.setTimeout(120_000);
      const { userDataDir, cost, launched, window } =
        await launchCoworkEntryWithCost();
      try {
        const railGroup = window.getByTestId(`panel-group-${RAIL_GROUP_ID}`);
        await waitForRailCost(window, cost.expected.scopeTotal);

        await bumpLayoutRevisions(window);
        await expectRailStaysCollapsed(window);

        await expectCollapsedChrome(window);
        await expect(
          railGroup.getByTestId('panel-content-activity-section'),
        ).toBeHidden();
        // The seeded flag is untouched: only a user action spends it.
        expect(await railCollapsed(window)).toBe('right');
        expect(await railCollapsedIsAuto(window)).toBe(true);

        // The user opens it from the edge bar; the work is there.
        await railControl(window, 'expand').click();
        await expect(
          railGroup.getByTestId('panel-content-activity-section'),
        ).toBeVisible();
        await expect(
          railGroup.getByTestId('activity-section-cost'),
        ).toBeVisible();
        await expect.poll(() => railCollapsed(window)).toBeNull();

        // Layout updates do not close a rail the user opened.
        await bumpLayoutRevisions(window);
        await expect(
          railGroup.getByTestId('panel-content-activity-section'),
        ).toBeVisible();
        expect(await railCollapsed(window)).toBeNull();

        // Wait for the actual saved layout, then recreate renderer state. A saved
        // open rail is restored open; CAN-4793 must never force-collapse it.
        const layoutPath = path.join(
          userDataDir,
          'workspaces',
          CHATS_SECTION_NAMED_COWORK_ID,
          'worktree-data',
          CHATS_SECTION_NAMED_COWORK_ENTRY_ID,
          'panel-layout.json',
        );
        await expect
          .poll(() => {
            const saved = JSON.parse(readFileSync(layoutPath, 'utf8'));
            const rail = collectLeaves(saved.grid.root).find(
              (leaf) => leaf.groupId === RAIL_GROUP_ID,
            );
            return rail !== undefined && rail.collapsed === undefined;
          })
          .toBe(true);
        await window.reload();
        const app = new CanopyAppDriver(window);
        await app.waitForShell({ timeout: 30_000 });
        await app.openChatPage();
        await expandCoworkWorkspace(window, CHATS_SECTION_NAMED_COWORK_ID);
        await window
          .getByTestId(
            `sidebar-work-entry-${CHATS_SECTION_NAMED_COWORK_ENTRY_ID}`,
          )
          .click();
        await expect(window.getByTestId('cowork-top-bar')).toBeVisible({
          timeout: 30_000,
        });
        await waitForRailCost(window, cost.expected.scopeTotal);
        await expect(
          railGroup.getByTestId('panel-content-activity-section'),
        ).toBeVisible();
        await bumpLayoutRevisions(window);
        expect(await railCollapsed(window)).toBeNull();
      } finally {
        await closeCanopy(launched.electronApp, userDataDir);
      }
    });

    test('a Cowork rail the user collapsed stays collapsed', async () => {
      test.setTimeout(120_000);
      const { userDataDir, cost, launched, window } =
        await launchCoworkEntryWithCost();
      try {
        const railGroup = window.getByTestId(`panel-group-${RAIL_GROUP_ID}`);
        await waitForRailCost(window, cost.expected.scopeTotal);

        await railControl(window, 'expand').click();
        await expect(
          railGroup.getByTestId('panel-content-activity-section'),
        ).toBeVisible();
        await railControl(window, 'collapse').click();
        await expectCollapsedChrome(window);

        await bumpLayoutRevisions(window);
        await expectRailStaysCollapsed(window);
        expect(await railCollapsedIsAuto(window)).toBe(false);
      } finally {
        await closeCanopy(launched.electronApp, userDataDir);
      }
    });
  });
}
