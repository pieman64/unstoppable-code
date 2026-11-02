import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  DIFFED_FILE_NAMES,
  openCreatedFiles,
  seedCreatedFiles,
} from './createdFilesFixture.mjs';

/**
 * Clean chat's "Edited N files" card and the diff card a row opens on hover.
 *
 * - A file row's hover sits inside the card: 4px from its edges on every side,
 *   with 8px corners nested in the card's 12px ones, in the shared subtle fill.
 * - The diff card is the menu's floating surface (12px corners), its Expand
 *   and Edit are the shared quiet header buttons, and the diff carries no
 *   library summary bar. A turn that saved no trees says its changes are
 *   unavailable.
 * - The reply row's icon buttons rest in the quiet tertiary ink.
 */

/** A CSS color expression, resolved by the renderer the way an element would. */
function resolveColor(window, expression, property = 'color') {
  return window.evaluate(
    ([value, prop]) => {
      const probe = document.createElement('span');
      probe.style.setProperty(prop, value);
      document.body.append(probe);
      const resolved = getComputedStyle(probe).getPropertyValue(prop);
      probe.remove();
      return resolved;
    },
    [expression, property],
  );
}

test('Clean chat file rows hover inside the card and open a quiet diff card', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-file-change-rows-'),
  );
  const fixture = seedCreatedFiles(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const chat = await openCreatedFiles(window, fixture);

    const card = chat.getByTestId('turn-files');
    await expect(card).toBeVisible();
    await expect(card.locator('[data-turn-files-title]')).toBeVisible();
    const row = card.getByRole('button', {
      name: `outputs/${DIFFED_FILE_NAMES[0]}`,
    });
    await expect(row).toBeVisible();

    // Approved nested corners inside the user bubble's 16px card radius.
    await expect(card).toHaveCSS('border-top-left-radius', '16px');
    await expect(row).toHaveCSS('border-top-left-radius', '11px');

    // The same 4px gap to the card's inner edge on both sides.
    const geometry = await row.evaluate((element) => {
      const cardElement = element.closest('[data-testid="turn-files"]');
      const cardRect = cardElement.getBoundingClientRect();
      const border = parseFloat(getComputedStyle(cardElement).borderLeftWidth);
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left - cardRect.left - border,
        right: cardRect.right - border - rect.right,
      };
    });
    expect(geometry).toEqual({ left: 4, right: 4 });

    // A file the turn created that git does not list (the "1 file" case)
    // takes the same row: no box of its own, the same inset and corners.
    const created = card.getByTestId('turn-file-chip').first();
    await expect(created).toBeVisible();
    await expect(created).toHaveCSS('border-left-width', '0px');
    await expect(created).toHaveCSS('border-top-left-radius', '11px');
    const createdGeometry = await created.evaluate((element) => {
      const cardElement = element.closest('[data-testid="turn-files"]');
      const cardRect = cardElement.getBoundingClientRect();
      const border = parseFloat(getComputedStyle(cardElement).borderLeftWidth);
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left - cardRect.left - border,
        right: cardRect.right - border - rect.right,
      };
    });
    expect(createdGeometry).toEqual({ left: 4, right: 4 });

    await row.hover();
    await expect(row).toHaveCSS(
      'background-color',
      await resolveColor(window, 'var(--bg-subtle)', 'background-color'),
    );

    // The diff card opens after the hover delay.
    const popover = window.getByTestId('turn-diff-popover');
    await expect(popover).toBeVisible();
    await expect(popover).toHaveCSS('border-top-left-radius', '12px');
    for (const name of ['Expand', 'Edit']) {
      await expect(popover.getByRole('button', { name })).toHaveAttribute(
        'data-header-action-button',
        'true',
      );
    }
    // No library summary bar (its expand-all button, count and squares).
    await expect(popover.locator('[role="banner"]')).toHaveCount(0);
    // The fixture's turn saved no trees: the card says so instead of showing
    // the worktree's current diff as the turn's (CAN-4103).
    const unavailable = popover.getByTestId(
      'diff-viewer-notice-turn-unavailable',
    );
    await expect(unavailable).toContainText(
      "This turn's changes weren't saved, so they can't be shown.",
    );
    await expect(unavailable).toContainText(
      'Expand to see all branch changes for this file.',
    );

    // The reply row's icons rest in the quiet tertiary ink.
    await window.mouse.move(0, 0);
    await expect(popover).toHaveCount(0);
    // The latest reply's row (the fixture has two turns).
    await expect(chat.getByTestId('turn-copy-message').last()).toHaveCSS(
      'color',
      await resolveColor(window, 'var(--fg-tertiary)'),
    );

    // The header: at full width View changes shares the title's row; in a
    // narrow column it moves to its own row under the title, the line
    // counts stay on one line, and nothing overlaps or meets the edge.
    const header = async () =>
      card.evaluate((element) => {
        const box = (node) => node?.getBoundingClientRect();
        const cardRect = element.getBoundingClientRect();
        const counts = box(element.querySelector('[data-line-counts]'));
        const actions = box(element.querySelector('[data-turn-files-actions]'));
        const title = box(element.querySelector('[data-turn-files-title]'));
        const lineHeight = parseFloat(
          getComputedStyle(element.querySelector('[data-line-counts]'))
            .lineHeight,
        );
        return {
          countsOneLine: counts.height <= lineHeight + 1,
          actionsBelowCounts: actions.top >= counts.bottom,
          actionsBesideTitle: actions.top < title.bottom,
          overlap: !(
            actions.right <= counts.left ||
            actions.left >= counts.right ||
            actions.bottom <= counts.top ||
            actions.top >= counts.bottom
          ),
          rightGap: Math.round(cardRect.right - actions.right),
        };
      });
    await expect(
      card.getByRole('button', { name: 'View changes' }),
    ).toBeVisible();
    expect(await header()).toMatchObject({
      countsOneLine: true,
      actionsBesideTitle: true,
      overlap: false,
    });
    await card.evaluate((element) => {
      element.style.width = '300px';
    });
    expect(await header()).toMatchObject({
      countsOneLine: true,
      actionsBelowCounts: true,
      overlap: false,
    });
    // The card's 12px header inset plus its 1px border.
    expect((await header()).rightGap).toBeGreaterThanOrEqual(13);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('changed files can collapse, reopen and scroll to the last saved output', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-file-summary-scroll-'),
  );
  const fileNames = Array.from(
    { length: 20 },
    (_, index) => `report-${index + 1}.md`,
  );
  const fixture = seedCreatedFiles(userDataDir, false, { fileNames });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const chat = await openCreatedFiles(window, fixture);
    const card = chat.getByTestId('turn-files');
    const toggle = card.getByRole('button', {
      name: 'Collapse changed files',
      exact: true,
    });
    await expect(toggle).toBeVisible();
    const scroll = card.getByRole('region', { name: 'Saved files' });
    await expect(scroll).toHaveCSS('max-height', '120px');
    const crop = await scroll.evaluate((viewport) => {
      const rows = viewport.querySelectorAll('[data-testid="turn-file-chip"]');
      const bounds = viewport.getBoundingClientRect();
      const first = rows[0].getBoundingClientRect();
      const fourth = rows[3].getBoundingClientRect();
      return {
        top: first.top - bounds.top,
        rowHeight: first.height,
        fourthVisible: bounds.bottom - fourth.top,
        gutter: viewport.offsetWidth - viewport.clientWidth,
      };
    });
    expect(crop).toEqual({
      top: 4,
      rowHeight: 32,
      fourthVisible: 20,
      gutter: 0,
    });
    await expect(scroll.getByTestId('turn-file-chip')).toHaveCount(20);
    await toggle.click();
    await expect(scroll).toBeHidden();
    await card
      .getByRole('button', { name: 'Expand changed files', exact: true })
      .press('Enter');
    const last = card.getByRole('button', {
      name: 'Open report-20.md',
      exact: true,
    });
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeInViewport();
    await expect(
      card.getByRole('button', { name: /Show \d+ more/ }),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('narrow saved-file rows preserve identity, readable errors and touch actions', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-file-row-access-'),
  );
  const filename = 'Q3 Board Deck — FINAL (revised) v13 [approved by legal].md';
  const fixture = seedCreatedFiles(userDataDir, true, {
    fileNames: [filename, 'a.md'],
    name: 'Northwind Industries — Platform Infrastructure and Enterprise Onboarding',
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const chat = await openCreatedFiles(window, fixture);
    const card = chat.getByTestId('turn-files');
    // The same narrow split-pane container as the existing header regression.
    await card.evaluate((element) => {
      element.style.width = '320px';
    });
    const open = card.getByRole('button', {
      name: `Open ${filename}`,
      exact: true,
    });
    const reveal = card.getByTestId('turn-file-chip-reveal').first();
    await window.evaluate(() => {
      document.documentElement.style.fontSize = '32px';
    });
    const space = await open.getByText(filename, { exact: true }).boundingBox();
    expect
      .soft(space?.width, 'filename keeps readable space at 200% text')
      .toBeGreaterThan(150);
    await window.keyboard.press('Tab');
    await open.focus();
    await expect
      .soft(window.getByRole('tooltip').filter({ hasText: filename }))
      .toBeVisible({ timeout: 1500 });
    await window.evaluate(() => {
      document.documentElement.style.fontSize = '';
    });
    const filePath = path.join(fixture.root, 'outputs', filename);
    unlinkSync(filePath);
    await open.press('Enter');
    const status = card.getByTestId('turn-file-chip-status').first();
    await expect(status).toBeVisible();
    const layout = await status.evaluate((element, name) => {
      const label = Array.from(
        element.closest('button').querySelectorAll('span'),
      ).find((node) => node.textContent === name);
      return {
        status: element.getBoundingClientRect().top,
        filenameBottom: label?.getBoundingClientRect().bottom,
        clipped: element.scrollWidth > element.clientWidth,
      };
    }, filename);
    expect
      .soft(layout.status, 'error reads below filename')
      .toBeGreaterThanOrEqual(layout.filenameBottom);
    expect
      .soft(layout.clipped, 'full recovery message remains readable')
      .toBe(false);
    writeFileSync(filePath, '# Restored report\n');
    await open.press('Enter');
    await expect(window.getByTestId('file-viewer')).toContainText(
      'Restored report',
    );
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
    for (const action of [
      open,
      reveal,
      card.getByRole('button', { name: 'Collapse changed files', exact: true }),
    ]) {
      expect
        .soft((await action.boundingBox())?.height, 'touch target height')
        .toBeGreaterThanOrEqual(44);
    }
  } finally {
    await closeCanopy(electronApp, userDataDir);
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
