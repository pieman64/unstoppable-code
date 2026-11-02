/**
 * Pinned items carry a pin mark, and App Advisor entries can be pinned.
 *
 * A pinned project, worktree, Cowork Work Entry, Chats Work Entry, and App
 * Advisor Work Entry show the quiet pin at the trailing edge of their title
 * line; it fades while the row reveals its hover actions. Pinning or
 * unpinning from an item's menu adds or removes the mark. App Advisor rows
 * offer Pin to top / Unpin first in their menu, lead their list when pinned,
 * and persist the pin to the App Advisor Work Entry registry.
 *
 * Deterministic: `seedPinnedItemsFixture` writes one pin at every tier
 * before launch. No live agents, no network.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver, waitForStableLocator } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  CHATS_SECTION_CODE_WORKSPACE_ID,
  CHATS_SECTION_NAMED_COWORK_ID,
  PINNED_ITEMS_PINNED_ADVISOR_ENTRY_ID,
  PINNED_ITEMS_PINNED_CHAT_ENTRY_ID,
  PINNED_ITEMS_PINNED_WORKTREE_ID,
  seedPinnedItemsFixture,
} from './seeders/index.mjs';

const PIN_BADGE = 'worktree-row-pinned-badge';

async function launchSeeded() {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-pinned-items-'),
  );
  seedPinnedItemsFixture(userDataDir);
  const { electronApp } = await launchCanopy({
    userDataDir,
    viewportSize: { width: 900, height: 1000 },
  });
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  return { electronApp, window, app, userDataDir };
}

function worktreeRow(window, worktreeId) {
  return window.locator(
    `[data-testid="worktree-row"][data-worktree-id="${worktreeId}"]`,
  );
}

function entryRow(window, entryId) {
  return window.locator(`[data-standalone-chat-id="${entryId}"]`).first();
}

function codeProjectPin(window) {
  return window.locator(
    `[data-sidebar-workspace-id="${CHATS_SECTION_CODE_WORKSPACE_ID}"] [data-testid="workspace-section-pinned-badge"]`,
  );
}

function coworkProjectPin(window) {
  return window.getByTestId(
    `sidebar-cowork-project-${CHATS_SECTION_NAMED_COWORK_ID}-pinned`,
  );
}

/** Projects-list workspaces, in rendered order (pinned copies skipped). */
async function projectOrder(window) {
  return window
    .getByTestId('sidebar-section-code')
    .locator('[data-sidebar-workspace-id]')
    .evaluateAll((elements) => {
      const ids = [];
      for (const element of elements) {
        const id = element.getAttribute('data-sidebar-workspace-id');
        if (id && !ids.includes(id)) ids.push(id);
      }
      return ids;
    });
}

async function opacityOf(locator) {
  return locator.evaluate((element) => getComputedStyle(element).opacity);
}

/** App Advisor nav rows, in rendered order. */
async function advisorRowIds(advisor) {
  return advisor
    .locator('[data-testid^="app-advisor-nav-entry-"][data-standalone-chat-id]')
    .evaluateAll((rows) =>
      rows.map((row) => row.getAttribute('data-standalone-chat-id')),
    );
}

function readAdvisorPins(userDataDir) {
  const registry = JSON.parse(
    readFileSync(
      path.join(
        userDataDir,
        'app-workspaces',
        'app-advisor',
        'work-entries.json',
      ),
      'utf8',
    ),
  );
  return registry.entries
    .filter((entry) => entry.pinned === true)
    .map((entry) => entry.id);
}

test('pinned projects, worktrees, and Work Entries carry the pin mark', async () => {
  test.setTimeout(120_000);
  const { electronApp, window, userDataDir } = await launchSeeded();
  try {
    const pinnedWorktree = worktreeRow(window, PINNED_ITEMS_PINNED_WORKTREE_ID);
    await expect(pinnedWorktree).toBeVisible({ timeout: 30_000 });
    await waitForStableLocator(window, pinnedWorktree);
    await window.mouse.move(880, 980);

    // Project tier: the pinned code project's header, not the unpinned
    // Cowork project's.
    await expect(codeProjectPin(window)).toBeVisible();
    await expect(codeProjectPin(window)).toHaveAttribute(
      'aria-label',
      'Pinned',
    );
    await expect(coworkProjectPin(window)).toHaveCount(0);

    // Row tier: the pinned worktree, a pinned entry inside the unpinned
    // Cowork project, and a pinned Chats entry. Unpinned rows carry none.
    await expect(pinnedWorktree.getByTestId(PIN_BADGE)).toBeVisible();
    await expect(
      worktreeRow(window, 'feature-01').getByTestId(PIN_BADGE),
    ).toHaveCount(0);
    await expect(
      entryRow(window, 'entry-research-plan').getByTestId(PIN_BADGE),
    ).toBeVisible();
    await expect(
      entryRow(window, PINNED_ITEMS_PINNED_CHAT_ENTRY_ID).getByTestId(
        PIN_BADGE,
      ),
    ).toBeVisible();
    await expect(
      entryRow(window, 'entry-chat-001').getByTestId(PIN_BADGE),
    ).toHaveCount(0);

    // Hover trades the pin for the row's actions.
    const worktreePin = pinnedWorktree.getByTestId(PIN_BADGE);
    expect(await opacityOf(worktreePin)).toBe('1');
    await pinnedWorktree.hover();
    await expect.poll(() => opacityOf(worktreePin)).toBe('0');
    await window.mouse.move(880, 980);
    await expect.poll(() => opacityOf(worktreePin)).toBe('1');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('pinning and unpinning from item menus adds and removes the mark', async () => {
  test.setTimeout(120_000);
  const { electronApp, window, userDataDir } = await launchSeeded();
  try {
    const chatEntry = entryRow(window, 'entry-chat-004');
    await expect(chatEntry).toBeVisible({ timeout: 30_000 });
    await waitForStableLocator(window, chatEntry);

    // Work Entry: Pin to top adds the mark, Unpin removes it.
    await expect(chatEntry.getByTestId(PIN_BADGE)).toHaveCount(0);
    await chatEntry.hover();
    await chatEntry
      .getByTestId('sidebar-work-entry-entry-chat-004-menu')
      .click();
    await window
      .getByTestId('sidebar-work-entry-entry-chat-004-toggle-pin')
      .click();
    await expect(
      entryRow(window, 'entry-chat-004').getByTestId(PIN_BADGE),
    ).toBeVisible();
    await entryRow(window, 'entry-chat-004').hover();
    await entryRow(window, 'entry-chat-004')
      .getByTestId('sidebar-work-entry-entry-chat-004-menu')
      .click();
    await window
      .getByTestId('sidebar-work-entry-entry-chat-004-toggle-pin')
      .click();
    await expect(
      entryRow(window, 'entry-chat-004').getByTestId(PIN_BADGE),
    ).toHaveCount(0);

    // Cowork project: pinning it from its header menu adds the header mark.
    await window
      .getByTestId(
        `sidebar-cowork-project-${CHATS_SECTION_NAMED_COWORK_ID}-header`,
      )
      .click({ button: 'right' });
    await window.getByTestId('workspace-toggle-pin-menu-item').click();
    await window.mouse.move(880, 980);
    await expect(coworkProjectPin(window)).toBeVisible();

    // Code project: unpinning it removes the header mark.
    await window
      .locator(
        `[data-sidebar-workspace-id="${CHATS_SECTION_CODE_WORKSPACE_ID}"] [data-testid^="sidebar-project-header-"]`,
      )
      .first()
      .click({ button: 'right' });
    const unpin = window.getByTestId('workspace-toggle-pin-menu-item');
    await expect(unpin).toContainText('Unpin');
    await unpin.click();
    await expect(codeProjectPin(window)).toHaveCount(0);

    // Pinned projects lead the Projects list: the pinned Cowork project now
    // sits above the code project it used to follow.
    await expect
      .poll(() => projectOrder(window))
      .toEqual([
        CHATS_SECTION_NAMED_COWORK_ID,
        CHATS_SECTION_CODE_WORKSPACE_ID,
      ]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('App Advisor entries pin to the top from their menu and persist', async () => {
  test.setTimeout(120_000);
  const { electronApp, app, userDataDir } = await launchSeeded();
  try {
    const advisor = await app.openAppAdvisorWindow(electronApp);
    await expect
      .poll(() => advisorRowIds(advisor), { timeout: 30_000 })
      .toEqual([
        PINNED_ITEMS_PINNED_ADVISOR_ENTRY_ID,
        'advisor-entry-1',
        'advisor-entry-2',
      ]);
    await expect(
      advisor
        .getByTestId(
          `app-advisor-nav-entry-${PINNED_ITEMS_PINNED_ADVISOR_ENTRY_ID}`,
        )
        .getByTestId('worktree-row-pinned-badge'),
    ).toBeVisible();
    await expect(
      advisor
        .getByTestId('app-advisor-nav-entry-advisor-entry-2')
        .getByTestId('worktree-row-pinned-badge'),
    ).toHaveCount(0);

    // Pin to top leads the row menu and moves the entry into the pinned
    // group, which keeps registry order.
    const second = advisor.getByTestId('app-advisor-nav-entry-advisor-entry-2');
    await second.hover();
    await advisor
      .getByTestId('app-advisor-nav-entry-advisor-entry-2-menu')
      .click();
    const popover = advisor.getByTestId(
      'app-advisor-nav-entry-advisor-entry-2-menu-popover',
    );
    await expect(popover.getByRole('menuitem').first()).toHaveAttribute(
      'data-testid',
      'app-advisor-nav-entry-advisor-entry-2-toggle-pin',
    );
    await expect(popover.getByRole('menuitem').first()).toContainText(
      'Pin to top',
    );
    await popover.getByRole('menuitem').first().click();
    await expect
      .poll(() => advisorRowIds(advisor))
      .toEqual([
        'advisor-entry-2',
        PINNED_ITEMS_PINNED_ADVISOR_ENTRY_ID,
        'advisor-entry-1',
      ]);
    await expect(
      advisor
        .getByTestId('app-advisor-nav-entry-advisor-entry-2')
        .getByTestId('worktree-row-pinned-badge'),
    ).toBeAttached();
    await expect
      .poll(() => readAdvisorPins(userDataDir).sort())
      .toEqual(['advisor-entry-2', PINNED_ITEMS_PINNED_ADVISOR_ENTRY_ID]);

    // Unpin returns the entry to the unpinned tail and drops its mark.
    const third = advisor.getByTestId(
      `app-advisor-nav-entry-${PINNED_ITEMS_PINNED_ADVISOR_ENTRY_ID}`,
    );
    await third.hover();
    await advisor
      .getByTestId(
        `app-advisor-nav-entry-${PINNED_ITEMS_PINNED_ADVISOR_ENTRY_ID}-menu`,
      )
      .click();
    const unpin = advisor.getByTestId(
      `app-advisor-nav-entry-${PINNED_ITEMS_PINNED_ADVISOR_ENTRY_ID}-toggle-pin`,
    );
    await expect(unpin).toContainText('Unpin');
    await unpin.click();
    await expect
      .poll(() => advisorRowIds(advisor))
      .toEqual([
        'advisor-entry-2',
        'advisor-entry-1',
        PINNED_ITEMS_PINNED_ADVISOR_ENTRY_ID,
      ]);
    await expect(
      advisor
        .getByTestId(
          `app-advisor-nav-entry-${PINNED_ITEMS_PINNED_ADVISOR_ENTRY_ID}`,
        )
        .getByTestId('worktree-row-pinned-badge'),
    ).toHaveCount(0);
    await expect
      .poll(() => readAdvisorPins(userDataDir))
      .toEqual(['advisor-entry-2']);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('pinned project names announce their state while focused', async () => {
  test.setTimeout(120_000);
  const { electronApp, window, userDataDir } = await launchSeeded();
  try {
    const project = window
      .locator(
        `[data-sidebar-workspace-id="${CHATS_SECTION_CODE_WORKSPACE_ID}"]`,
      )
      .first();
    await expect(codeProjectPin(window)).toBeVisible({ timeout: 30_000 });
    const toggle = project.getByRole('button', {
      name: /^(Collapse|Expand) Chats Section Code, Pinned$/,
      exact: true,
    });
    await expect(toggle).toBeVisible();
    await toggle.focus();
    await expect(toggle).toHaveAccessibleName(
      'Collapse Chats Section Code, Pinned',
    );
    await expect(codeProjectPin(window)).toBeHidden();
    await toggle.press('Enter');
    await expect(toggle).toHaveAccessibleName(
      'Expand Chats Section Code, Pinned',
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('coarse pointers show Cowork actions without painting the pin underneath', async () => {
  test.setTimeout(120_000);
  const { electronApp, window, userDataDir } = await launchSeeded();
  try {
    const header = window.getByTestId(
      `sidebar-cowork-project-${CHATS_SECTION_NAMED_COWORK_ID}-header`,
    );
    await expect(header).toBeVisible({ timeout: 30_000 });
    await header.click({ button: 'right' });
    await window.getByTestId('workspace-toggle-pin-menu-item').click();
    // Menu selection restores focus to the header. Leave that keyboard
    // interaction before asserting the fine-pointer mark at rest.
    await header.evaluate((element) => {
      if (element.contains(document.activeElement)) {
        document.activeElement.blur();
      }
    });
    await window.mouse.move(880, 980);
    await expect(coworkProjectPin(window)).toHaveCSS('opacity', '1');
    const cdp = await window.context().newCDPSession(window);
    await cdp.send('Emulation.setTouchEmulationEnabled', {
      enabled: true,
      maxTouchPoints: 1,
    });
    await expect
      .poll(() =>
        window.evaluate(() => matchMedia('(pointer: coarse)').matches),
      )
      .toBe(true);
    const add = window.getByTestId(
      `sidebar-cowork-project-${CHATS_SECTION_NAMED_COWORK_ID}-new-chat`,
    );
    await expect(add).toHaveCSS('opacity', '1');
    await expect(coworkProjectPin(window)).toHaveCSS('opacity', '0');
    await add.click();
    await expect(window.getByTestId('cowork-top-bar')).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
