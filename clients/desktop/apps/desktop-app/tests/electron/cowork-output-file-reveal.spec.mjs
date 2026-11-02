import { mkdtempSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { collectLeaves, getLayout } from './panelHarness.mjs';
import { mergeSeedPreferences } from './seeders/mergePreferences.mjs';
import { startExternalOpenCapture } from './fixtures/external-open-capture.mjs';
import {
  seedCreatedFiles,
  openCreatedFiles,
  CREATED_FILES_TURN,
} from './createdFilesFixture.mjs';

// CAN-4788 — files an agent wrote into a Cowork project can be found and
// opened without developer controls: each Created files chip says where the
// file was saved and reveals it, the file viewer header offers the platform
// file manager and the default app, and in Work navigation a file tab's menu
// starts with the reveal item. Code navigation keeps the developer menu.
//
// Reveals are stubbed in main before any action, and E2E builds send
// default-app opens to a local capture server, so no Finder window or
// external application ever opens.

const FILE_MANAGER = /^Open in (Finder|File Explorer|Files|file manager)$/;
const CSV_NAME = 'vendor-spend-cleaned.csv';
const MARKDOWN_NAME = 'Résumé des écarts.md';

function seedOutputs(userDataDir) {
  return seedCreatedFiles(userDataDir, true, {
    externalPath: path.join(userDataDir, 'Vendor Spend Q3'),
    fileNames: [MARKDOWN_NAME, CSV_NAME],
    name: 'Vendor Spend Q3',
  });
}

async function stubOsLaunches(electronApp) {
  await electronApp.evaluate(({ shell }) => {
    globalThis.__can4788Reveals = [];
    shell.showItemInFolder = (filePath) => {
      globalThis.__can4788Reveals.push(filePath);
    };
  });
}

const reveals = (electronApp) =>
  electronApp.evaluate(() => globalThis.__can4788Reveals);

async function expandSummary(chat) {
  const summary = chat.locator(
    `[data-testid="turn-files"][data-turn-id="${CREATED_FILES_TURN}"]`,
  );
  await expect(summary).toBeVisible();
  // The clean card always lists its files; there is nothing to open.
  await expect(summary.getByTestId('turn-file-chip').first()).toBeVisible();
  return summary;
}

async function filePanelId(window, filePath) {
  const layout = await getLayout(window);
  const matches = collectLeaves(layout.root)
    .flatMap((leaf) => leaf.panels)
    .filter(
      (panel) =>
        panel.kind === 'file-diff' && panel.instance?.filePath === filePath,
    );
  expect(matches).toHaveLength(1);
  return matches[0].panelId;
}

async function openTabMenu(window, panelId) {
  const tab = window.getByTestId(`panel-tab-${panelId}`);
  const menu = window.getByTestId('panel-tab-context-menu');
  await expect(tab).toBeVisible();
  // A tab that is still settling after the file opened can drop the first
  // right-click; retry the gesture rather than the assertion's timeout.
  await expect(async () => {
    await tab.click({ button: 'right' });
    await expect(menu).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
  const rows = await menu
    .locator('[data-testid^="panel-tab-context-"]')
    .evaluateAll((nodes) =>
      nodes.map((node) =>
        node.getAttribute('data-testid').replace('panel-tab-context-', ''),
      ),
    );
  return { menu, rows };
}

test('Work mode: agent-written CSV and Markdown files are easy to find and open', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-output-reveal-'),
  );
  const fixture = seedOutputs(userDataDir);
  mergeSeedPreferences(userDataDir, { navigationMode: 'work' });
  const csvPath = path.join(fixture.root, 'outputs', CSV_NAME);
  const markdownPath = path.join(fixture.root, 'outputs', MARKDOWN_NAME);
  const capture = await startExternalOpenCapture();
  const { electronApp } = await launchCanopy({ userDataDir, env: capture.env });
  try {
    const window = await electronApp.firstWindow();
    const chat = await openCreatedFiles(window, fixture);
    await stubOsLaunches(electronApp);
    const summary = await expandSummary(chat);

    // The chip names its project instead of showing an absolute path.
    const csvChip = summary
      .getByTestId('turn-file-chip')
      .filter({ hasText: CSV_NAME });
    await expect(csvChip.getByTestId('turn-file-chip-location')).toHaveText(
      'Saved in Vendor Spend Q3',
    );
    await expect(csvChip.locator('[title]')).toHaveCount(0);

    // Reveal from the chip: keyboard reachable, never previews the file.
    const chipReveal = csvChip.getByTestId('turn-file-chip-reveal');
    await expect(chipReveal).toHaveAccessibleName(
      /^Show vendor-spend-cleaned\.csv in (Finder|File Explorer|Files|folder)$/,
    );
    await chipReveal.focus();
    await expect(chipReveal).toBeFocused();
    await chipReveal.press('Enter');
    await expect
      .poll(() => reveals(electronApp))
      .toEqual([realpathSync(csvPath)]);
    await expect(window.getByTestId('file-viewer')).toHaveCount(0);

    // Preview from the same chip still works.
    await summary.getByRole('button', { name: `Open ${CSV_NAME}` }).click();
    await expect(window.getByTestId('file-viewer')).toBeVisible();

    // Header actions for the CSV, in order, keyboard reachable.
    const headerReveal = window.getByTestId('file-viewer-open-original');
    const headerOpen = window.getByTestId('file-viewer-open-external');
    await expect(headerReveal).toHaveAccessibleName(FILE_MANAGER);
    await expect(headerOpen).toHaveAccessibleName('Open in default app');
    await headerReveal.focus();
    await headerReveal.press('Enter');
    await expect
      .poll(() => reveals(electronApp))
      .toEqual([realpathSync(csvPath), realpathSync(csvPath)]);
    // Tab order: reveal, then default app. The viewer can take focus while
    // its content settles, so the gesture is retried from the reveal button.
    await expect(async () => {
      await headerReveal.focus();
      await expect(headerReveal).toBeFocused({ timeout: 1_000 });
      await window.keyboard.press('Tab');
      await expect(headerOpen).toBeFocused({ timeout: 1_000 });
    }).toPass({ timeout: 15_000 });

    // Work-mode tab menu: reveal first, no Split or Copy relative path.
    const csvPanelId = await filePanelId(window, csvPath);
    const { menu, rows } = await openTabMenu(window, csvPanelId);
    expect(rows[0]).toBe('open-in-file-manager');
    expect(rows[1]).toBe('copy-path');
    expect(rows.some((row) => row.startsWith('split-'))).toBe(false);
    expect(rows).not.toContain('copy-relative-path');
    expect(rows).toContain('pin');
    expect(rows).toContain('close');
    await expect(
      menu.getByTestId('panel-tab-context-open-in-file-manager'),
    ).toHaveText(FILE_MANAGER);
    await menu.getByTestId('panel-tab-context-open-in-file-manager').click();
    await expect.poll(async () => (await reveals(electronApp)).length).toBe(3);
    expect((await reveals(electronApp))[2]).toBe(realpathSync(csvPath));

    // Markdown: the header offers the same actions, and the default app
    // receives an encoded file URL (the name has a space). Opening a file
    // beside the chat can collapse the historical summary again.
    await window.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expandSummary(chat);
    await summary
      .getByRole('button', { name: `Open ${MARKDOWN_NAME}` })
      .click();
    await expect(
      window
        .getByTestId('file-viewer')
        .getByRole('heading', { name: 'Quarterly report', exact: true }),
    ).toBeVisible();
    // The CSV tab stays mounted behind the Markdown tab; act on the shown one.
    await expect(
      window.locator('[data-testid="file-viewer-open-original"]:visible'),
    ).toHaveAccessibleName(FILE_MANAGER);
    await window
      .locator('[data-testid="file-viewer-open-external"]:visible')
      .click();
    await expect.poll(() => capture.opened.length).toBe(1);
    const [openedUrl] = capture.opened;
    expect(openedUrl).toContain(encodeURIComponent(MARKDOWN_NAME));
    expect([
      pathToFileURL(markdownPath).href,
      pathToFileURL(realpathSync(markdownPath)).href,
    ]).toContain(openedUrl);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await capture.close();
  }
});

test('Clean chat keeps saved locations and Finder actions on created-file rows', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-output-reveal-clean-'),
  );
  const fixture = seedOutputs(userDataDir);
  mergeSeedPreferences(userDataDir, { navigationMode: 'work' });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const chat = await openCreatedFiles(window, fixture);
    await stubOsLaunches(electronApp);
    const chip = chat
      .getByTestId('turn-file-chip')
      .filter({ hasText: CSV_NAME });
    await expect(chip).toBeVisible();
    await expect(chip).toHaveCSS('border-left-width', '0px');
    await expect(chip.getByTestId('turn-file-chip-location')).toHaveText(
      'Saved in Vendor Spend Q3',
    );
    const reveal = chip.getByTestId('turn-file-chip-reveal');
    await reveal.focus();
    await expect(reveal).toBeFocused();
    await reveal.press('Enter');
    await expect
      .poll(() => reveals(electronApp))
      .toEqual([realpathSync(path.join(fixture.root, 'outputs', CSV_NAME))]);
    await expect(window.getByTestId('file-viewer')).toHaveCount(0);
    await chip.getByRole('button', { name: `Open ${CSV_NAME}` }).click();
    await expect(window.getByTestId('file-viewer')).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Code mode keeps the developer file tab menu', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-output-reveal-code-'),
  );
  const fixture = seedOutputs(userDataDir);
  mergeSeedPreferences(userDataDir, { navigationMode: 'code' });
  const csvPath = path.join(fixture.root, 'outputs', CSV_NAME);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const chat = await openCreatedFiles(window, fixture);
    await stubOsLaunches(electronApp);
    const summary = await expandSummary(chat);
    await summary.getByRole('button', { name: `Open ${CSV_NAME}` }).click();
    await expect(window.getByTestId('file-viewer')).toBeVisible();
    // Header actions are offered in both navigation modes.
    await expect(
      window.getByTestId('file-viewer-open-original'),
    ).toHaveAccessibleName(FILE_MANAGER);
    const { rows } = await openTabMenu(
      window,
      await filePanelId(window, csvPath),
    );
    expect(rows[0]).toBe('pin');
    expect(rows.some((row) => row.startsWith('split-'))).toBe(true);
    const copyPath = rows.indexOf('copy-path');
    expect(rows.slice(copyPath, copyPath + 3)).toEqual([
      'copy-path',
      'copy-relative-path',
      'open-in-file-manager',
    ]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Work mode file menu wiring reaches the auxiliary window', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-output-reveal-aux-'),
  );
  const fixture = seedCreatedFiles(userDataDir);
  mergeSeedPreferences(userDataDir, { navigationMode: 'work' });
  const markdownPath = path.join(
    fixture.root,
    'outputs',
    'Quarterly report.md',
  );
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const chat = await openCreatedFiles(window, fixture);
    await stubOsLaunches(electronApp);
    const summary = await expandSummary(chat);
    await summary
      .getByRole('button', { name: 'Open Quarterly report.md' })
      .click();
    await expect(window.getByTestId('file-viewer')).toBeVisible();
    const panelId = await filePanelId(window, markdownPath);
    const { menu } = await openTabMenu(window, panelId);
    const auxPromise = electronApp.waitForEvent('window');
    await menu.getByTestId('panel-tab-context-new-window').click();
    const aux = await auxPromise;
    await expect(aux.getByTestId('panel-aux-window-root')).toBeVisible();
    const { menu: auxMenu, rows } = await openTabMenu(aux, panelId);
    expect(rows.slice(0, 2)).toEqual(['open-in-file-manager', 'copy-path']);
    expect(rows.some((row) => row.startsWith('split-'))).toBe(false);
    expect(rows).not.toContain('copy-relative-path');
    await auxMenu.getByTestId('panel-tab-context-open-in-file-manager').click();
    await expect
      .poll(() => reveals(electronApp))
      .toEqual([realpathSync(markdownPath)]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
