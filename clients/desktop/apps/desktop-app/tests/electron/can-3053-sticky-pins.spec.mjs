/**
 * CAN-3053 slice 6b — the shared rail fills the pinned-copy hosts.
 *
 * The rail reserves a band beneath Projects for two pinned copies: the current
 * project's header, and the selected row. The legacy section portals those
 * copies in; the shared surface did not, so the band sat empty — a ~90px gap
 * with nothing in it, which is what QA saw.
 *
 * Deterministic: workspaces, worktrees and chat transcripts are seeded on disk
 * before launch. No live agents, no network.
 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedChatsSectionFixture } from './seeders/index.mjs';

const SHARED_SIDEBAR_STORAGE_KEY = 'canopy.desktop.sharedSidebar';

test('the shared rail pins the project header and selected row', async () => {
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-s6b-'));
  seedChatsSectionFixture(userDataDir, { chatEntryCount: 60 });
  const { electronApp } = await launchCanopy({
    userDataDir,
    viewportSize: { width: 900, height: 700 },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await window.evaluate((key) => {
      window.localStorage.setItem(key, '1');
    }, SHARED_SIDEBAR_STORAGE_KEY);
    await window.reload();
    await app.waitForShell({ timeout: 30_000 });
    await window.waitForTimeout(2000);

    // Select a worktree so the selected-item pin group has a subject.
    await window.getByTestId('worktree-row').first().click();
    await window.waitForTimeout(1200);
    // Expand the chat list so the selection scrolls far out of view.
    await window
      .getByTestId('sidebar-cowork-project-cowork-default-show-all')
      .click()
      .catch(() => {});
    await window.waitForTimeout(1000);

    const viewport = window.getByTestId('sidebar-scroll-container');
    const box = await viewport.boundingBox();
    await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let n = 0; n < 25; n += 1) {
      await window.mouse.wheel(0, 200);
      await window.waitForTimeout(60);
    }
    await window.waitForTimeout(1200);

    const state = await window.evaluate(() => {
      const root = document.querySelector('[data-testid="app-sidebar"]');
      const slotRows = Array.from(
        root?.querySelectorAll('[data-sidebar-sticky-slot-workspace-id]') ?? [],
      );
      const pinTop = root?.querySelector('[data-sidebar-selected-pin-top]');
      // VISIBLE, not merely filled. `innerHTML.length > 0` passes the moment a
      // portal lands, whether or not the rail ever un-hides the host — which
      // is a green test certifying a DOM state rather than the band the user
      // sees. Both hosts start `hidden`; the rail's sync owns the reveal.
      const shown = (el) =>
        el instanceof HTMLElement &&
        !el.hidden &&
        el.getBoundingClientRect().height > 0;
      return {
        slotRowCount: slotRows.length,
        pinBelowProjects: (() => {
          const projects = root?.querySelector(
            '[data-sidebar-projects-header]',
          );
          if (
            !(projects instanceof HTMLElement) ||
            !(pinTop instanceof HTMLElement)
          ) {
            return false;
          }
          return (
            pinTop.getBoundingClientRect().top >=
            projects.getBoundingClientRect().bottom - 1
          );
        })(),
        // Every slot row carries its project's header copy, ready for the
        // pass that seats it. Which of the slot and the pin group is VISIBLE
        // depends on the selection: with one active it owns that seat and the
        // slot moves below it, so requiring both on screen at once would
        // assert a state the rail never produces.
        slotsFilled: slotRows.some((row) => row.innerHTML.length > 0),
        revealedPin:
          shown(pinTop) &&
          ['header', 'row'].every((part) => {
            const child = pinTop?.querySelector(
              `[data-sidebar-selected-pin-part="${part}"]`,
            );
            return shown(child) && child.innerHTML.length > 0;
          }) &&
          Array.from(pinTop?.children ?? []).every(
            (child) => child.hidden || child.innerHTML.length > 0,
          ),
      };
    });
    expect(state.slotRowCount).toBeGreaterThan(0);
    expect(state.slotsFilled).toBe(true);
    // The band under Projects, actually on screen — the gap this slice exists
    // to close. `innerHTML.length > 0` alone passes the moment a portal lands,
    // whether or not the rail ever un-hides the host.
    expect(state.revealedPin).toBe(true);
    // And seated BELOW the Projects header rather than on top of it: the pin
    // group is absolutely positioned at the band's bottom edge, which is
    // exactly where a host-rendered Projects header sits.
    expect(state.pinBelowProjects).toBe(true);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
