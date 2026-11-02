// Phase 05 S3 — Changed files stays bounded and navigable during a large
// mid-merge state. This is intentionally red against the unchanged S1 UI for
// virtualization, paging, and the bounded-row target.
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedLargeMergeChangedFiles } from './seeders/seedLargeMergeChangedFiles.mjs';

const WORKTREE_BRANCH = 'demo-main';
const PAGE_SIZE = 200;
const MAX_RENDERED_ROWS = 80;
// 201 ordinary committed rows keep the Portal default group small while the
// desktop flow exercises auto-reveal on the last (non-empty) group.
const DESKTOP_COMMITTED_BASE_FILE_COUNT = PAGE_SIZE + 1;

test('bounds and pages Changed files during a large merge', async () => {
  test.setTimeout(600_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-electron-changed-files-scale-'),
  );
  let electronApp;

  try {
    const seed = seedDemoWorkspaces({
      userDataDir,
      apps: ['ts-pnpm-vite'],
      checkRuntimes: false,
    });
    const worktreePath = seed.workspaces[0]?.worktreePath;
    expect(worktreePath, 'seeded demo-main worktree path').toBeTruthy();
    const fixture = seedLargeMergeChangedFiles(worktreePath, {
      committedBaseFileCount: DESKTOP_COMMITTED_BASE_FILE_COUNT,
    });

    // Producer totals and the Portal transport estimate are asserted inside
    // the fixture before Electron is launched.
    expect(fixture.uncommittedGroupTotal).toBe(
      fixture.generatedFileCount + fixture.conflictedPaths.length,
    );
    expect(fixture.committedGroupTotal).toBe(
      fixture.committedBaseFileCount + fixture.conflictedPaths.length,
    );
    expect(fixture.portalEntityByteEstimate).toBeLessThanOrEqual(
      fixture.portalEntityByteSafeCeiling,
    );

    ({ electronApp } = await launchCanopy({ userDataDir }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);

    const section = window.getByTestId('changed-files-section');
    await expect(section).toBeVisible({ timeout: 120_000 });
    // The shared header helper emits the raw, ungrouped number (e.g. "10409
    // files"), so do not add locale separators here.
    await expect(
      section.getByText(`${fixture.totalChangedFileCount} files`, {
        exact: true,
      }),
      'header subtitle should include the full uncommitted + committed row total',
    ).toBeVisible({ timeout: 120_000 });

    const list = section.getByTestId('activity-changed-files');
    await expect(list).toBeVisible({ timeout: 120_000 });
    await expect(list).toHaveAttribute('data-virtualized', 'true', {
      timeout: 120_000,
    });
    const rows = list.getByTestId('activity-changed-file');
    await expect
      .poll(() => rows.count(), { timeout: 120_000 })
      .toBeGreaterThan(0);
    await expect
      .poll(() => rows.count(), { timeout: 120_000 })
      .toBeLessThanOrEqual(MAX_RENDERED_ROWS);

    const firstPageConflict = rowForPath(
      section,
      fixture.firstPageConflictPath,
    );
    await expect(firstPageConflict).toBeVisible({ timeout: 60_000 });
    await expect(firstPageConflict.locator('[title="Unmerged"]')).toBeVisible();

    const uncommittedHeading = section.getByRole('heading', {
      name: 'Uncommitted',
    });
    await expect(uncommittedHeading).toHaveAttribute(
      'data-total',
      String(fixture.uncommittedGroupTotal),
    );
    const committedHeading = section.getByRole('heading', {
      name: 'Committed',
    });

    const scroller = await desktopScroller(window, list);
    const showMoreUncommitted = section.locator(
      '[data-testid="activity-changed-files-show-more"][data-group="uncommitted"]',
    );
    const pathsAtTop = await renderedFilePaths(rows);
    const hiddenAtTop = await hiddenFilesRemaining(
      showMoreUncommitted,
      fixture.uncommittedGroupTotal - PAGE_SIZE,
    );

    // Uncommitted is an earlier group when Committed exists. Scroll to its
    // sentinel, then use its explicit button (it does not auto-reveal).
    await scrollToGroupSentinel({
      scroller,
      button: showMoreUncommitted,
      currentGroupRevealCount: PAGE_SIZE,
      lastGroupVisibleCount: Math.min(fixture.committedGroupTotal, PAGE_SIZE),
    });
    await expect(showMoreUncommitted).toBeVisible({ timeout: 120_000 });
    const pathsAtSentinel = await renderedFilePaths(rows);
    expect(pathsAtSentinel).not.toEqual(pathsAtTop);
    const hiddenAtSentinel = await hiddenFilesRemaining(
      showMoreUncommitted,
      fixture.uncommittedGroupTotal - PAGE_SIZE,
    );
    expect(hiddenAtSentinel).toBe(hiddenAtTop);

    await showMoreUncommitted.click();
    await scrollToGroupSentinel({
      scroller,
      button: showMoreUncommitted,
      currentGroupRevealCount: PAGE_SIZE * 2,
      lastGroupVisibleCount: Math.min(fixture.committedGroupTotal, PAGE_SIZE),
    });
    const pathsAtSecondSentinel = await renderedFilePaths(rows);
    await expect
      .poll(
        () =>
          hiddenFilesRemaining(
            showMoreUncommitted,
            fixture.uncommittedGroupTotal - PAGE_SIZE * 2,
          ),
        { timeout: 120_000 },
      )
      .toBe(fixture.uncommittedGroupTotal - PAGE_SIZE * 2);
    await expect
      .poll(() => rows.count(), { timeout: 120_000 })
      .toBeLessThanOrEqual(MAX_RENDERED_ROWS);

    // The next explicit page is keyboard-operable. Enter must activate the
    // focused Button and consume another 200 rows from the reveal budget.
    await expect(showMoreUncommitted).toBeVisible({ timeout: 120_000 });
    const hiddenBeforeKeyboard = await hiddenFilesRemaining(
      showMoreUncommitted,
      fixture.uncommittedGroupTotal - PAGE_SIZE * 2,
    );
    await showMoreUncommitted.focus();
    await expect(showMoreUncommitted).toBeFocused();
    await window.keyboard.press('Enter');
    await scrollToGroupSentinel({
      scroller,
      button: showMoreUncommitted,
      currentGroupRevealCount: PAGE_SIZE * 3,
      lastGroupVisibleCount: Math.min(fixture.committedGroupTotal, PAGE_SIZE),
    });
    await expect
      .poll(
        () =>
          hiddenFilesRemaining(
            showMoreUncommitted,
            fixture.uncommittedGroupTotal - PAGE_SIZE * 3,
          ),
        { timeout: 120_000 },
      )
      .toBeLessThan(hiddenBeforeKeyboard);

    const laterPageConflict = rowForPath(
      section,
      fixture.laterPageConflictPath,
    );
    await scrollToUncommittedIndex({
      scroller,
      itemIndex: PAGE_SIZE + 2,
      currentGroupRevealCount: PAGE_SIZE * 3,
      lastGroupVisibleCount: Math.min(fixture.committedGroupTotal, PAGE_SIZE),
    });
    expect(await renderedFilePaths(rows)).not.toEqual(pathsAtSecondSentinel);
    await expect(laterPageConflict).toBeVisible({ timeout: 60_000 });
    await expect(laterPageConflict.locator('[title="Unmerged"]')).toBeVisible();

    // The second-page row still opens its diff and context menu after the
    // reveal budget grows; this checks the row's existing behavior, not only
    // its appearance in a virtualized slice.
    const secondPageRow = rowForPath(section, fixture.secondPagePath);
    await expect(secondPageRow).toBeVisible({ timeout: 60_000 });
    await secondPageRow.click();
    const diffPanel = window.getByTestId('file-panel-diff').last();
    await expect(diffPanel).toBeVisible({ timeout: 60_000 });
    await secondPageRow.click({ button: 'right' });
    await expect(window.getByRole('menu').last()).toBeVisible({
      timeout: 30_000,
    });
    await window.keyboard.press('Escape');

    // Infinite scrolling belongs only to the last non-empty group. With 201
    // ordinary committed rows plus the four conflict paths, its final page is
    // small enough to reveal while staying far below the Portal byte ceiling.
    const committedShowMore = section.locator(
      '[data-testid="activity-changed-files-show-more"][data-group="committed"]',
    );
    await scrollNearGroupStart({
      scroller,
      currentGroupRevealCount: PAGE_SIZE,
      previousGroupRevealCount: Math.min(
        fixture.uncommittedGroupTotal,
        PAGE_SIZE * 3,
      ),
    });
    await expect(committedHeading).toHaveAttribute(
      'data-total',
      String(fixture.committedGroupTotal),
    );
    await committedHeading.scrollIntoViewIfNeeded();
    await expect(committedHeading).toBeVisible();
    const lastCommittedBaseRow = rowForPath(
      section,
      fixture.lastCommittedBasePath,
    );
    await expect(lastCommittedBaseRow).toHaveCount(0);
    const pathsBeforeAutoReveal = await renderedFilePaths(rows);
    const committedHiddenBeforeScroll = await hiddenFilesRemaining(
      committedShowMore,
      fixture.committedGroupTotal - PAGE_SIZE,
    );
    expect(committedHiddenBeforeScroll).toBeGreaterThan(0);
    await scrollViewportToEnd(scroller);
    await expect(committedShowMore).toHaveCount(0, { timeout: 120_000 });
    await lastCommittedBaseRow.scrollIntoViewIfNeeded();
    await expect(lastCommittedBaseRow).toBeVisible({ timeout: 60_000 });
    expect(await renderedFilePaths(rows)).not.toEqual(pathsBeforeAutoReveal);
    await expect
      .poll(() => hiddenFilesRemaining(committedShowMore, 0), {
        timeout: 120_000,
      })
      .toBe(0);
    await expect
      .poll(() => rows.count(), { timeout: 120_000 })
      .toBeLessThanOrEqual(MAX_RENDERED_ROWS);
  } finally {
    if (electronApp) {
      await closeCanopy(electronApp, userDataDir);
    } else {
      rmSync(userDataDir, { recursive: true, force: true });
      rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
    }
  }
});

async function desktopScroller(window, list) {
  const framelessBody = window
    .locator('[data-testid="frameless-section-body"]')
    .filter({ has: list })
    .first();
  return (await framelessBody.isVisible().catch(() => false))
    ? framelessBody
    : list;
}

async function scrollToGroupSentinel({
  scroller,
  button,
  currentGroupRevealCount,
  lastGroupVisibleCount,
  previousGroupRevealCount = 0,
}) {
  if (await button.isVisible().catch(() => false)) return;
  const revealedRows =
    previousGroupRevealCount + currentGroupRevealCount + lastGroupVisibleCount;
  const targetIndex = previousGroupRevealCount + currentGroupRevealCount - 12;
  const targetFraction = Math.max(0, targetIndex / revealedRows);
  await scroller.evaluate((element, fraction) => {
    const maxScroll = Math.max(0, element.scrollHeight - element.clientHeight);
    element.scrollTop = maxScroll * fraction;
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
  }, targetFraction);
  await expect(button).toBeVisible({ timeout: 120_000 });
  await button.scrollIntoViewIfNeeded();
}

async function scrollViewportToEnd(scroller) {
  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
}

async function scrollNearGroupStart({
  scroller,
  currentGroupRevealCount,
  previousGroupRevealCount,
}) {
  const totalRows = previousGroupRevealCount + currentGroupRevealCount;
  const targetIndex = previousGroupRevealCount + 4;
  const targetFraction = Math.max(0, targetIndex / totalRows);
  await scroller.evaluate((element, fraction) => {
    const maxScroll = Math.max(0, element.scrollHeight - element.clientHeight);
    element.scrollTop = maxScroll * fraction;
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
  }, targetFraction);
}

async function scrollToUncommittedIndex({
  scroller,
  itemIndex,
  currentGroupRevealCount,
  lastGroupVisibleCount,
}) {
  const totalRows = currentGroupRevealCount + lastGroupVisibleCount;
  const targetFraction = Math.max(0, itemIndex / totalRows);
  await scroller.evaluate((element, fraction) => {
    const maxScroll = Math.max(0, element.scrollHeight - element.clientHeight);
    element.scrollTop = maxScroll * fraction;
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
  }, targetFraction);
}

function rowForPath(section, filePath) {
  return section
    .locator(`[data-testid="activity-changed-file"][title="${filePath}"]`)
    .first();
}

async function renderedFilePaths(rows) {
  return rows.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('title')),
  );
}

async function hiddenFilesRemaining(showMore, fallback) {
  if ((await showMore.count()) === 0) return fallback;
  const label = await showMore
    .last()
    .innerText()
    .catch(() => '');
  const match = label.match(/([\d,]+)\s+files?\s+not shown/i);
  return match ? Number(match[1].replaceAll(',', '')) : fallback;
}
