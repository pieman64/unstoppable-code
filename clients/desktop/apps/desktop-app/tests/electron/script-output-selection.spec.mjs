// PR #2285: Script-output selection regression coverage.
// Reproduces selection loss in both a completed output modal and an actively
// streaming modal. No live process or network is involved because persisted
// and streaming script state is seeded.

import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  injectScriptOutputEvent,
  injectScriptRunEvent,
  seedScriptRun,
} from './seeders/index.mjs';

const WORKSPACE_ID = 'demo-multi-repo-fullstack';
const WORKTREE_ID = 'demo-main';
const COMPLETED_KEY = 'workspace-repo:web:build';
const LIVE_KEY = 'workspace-repo:web:test';
const COMPLETED_LINE = 'completed selection anchor remains highlighted';
const LIVE_LINE = 'live selection anchor remains highlighted';

const LIVE_SCRIPT = {
  scriptKey: LIVE_KEY,
  scriptName: 'test',
  label: 'Selection Stream',
  command: 'npm test',
  lifecycle: 'custom',
  target: 'workspace-repo',
  repoId: 'web',
  repoName: 'Web app',
};

async function openScriptsSection(window) {
  const heading = window.getByRole('heading', { name: 'Scripts', exact: true });
  await expect(heading).toBeVisible({ timeout: 45_000 });
  const section = heading.locator('xpath=ancestor::section[1]');
  const expand = section.getByLabel('Expand section');
  if (await expand.count()) {
    await expand.click();
  }
  return section;
}

async function selectLineText(dialog, line) {
  const lineElement = dialog
    .getByTestId('ansi-output')
    .getByText(line, { exact: true });
  await expect(lineElement).toBeVisible();
  await lineElement.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await expect.poll(() => selectedText(dialog.page())).toBe(line);
}

async function selectedText(window) {
  return window.evaluate(() => window.getSelection()?.toString() ?? '');
}

test('keeps selected completed and live script output highlighted across updates', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-script-output-selection-'),
  );
  seedDemoWorkspaces({
    userDataDir,
    apps: ['multi-repo-fullstack'],
    checkRuntimes: false,
  });
  seedScriptRun({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    status: 'success',
    durationMs: 1200,
    script: {
      scriptKey: COMPLETED_KEY,
      scriptName: 'build',
      label: 'Selection Snapshot',
      command: 'npm run build',
      lifecycle: 'custom',
      target: 'workspace-repo',
      repoId: 'web',
      repoName: 'Web app',
    },
    outputLines: [COMPLETED_LINE, 'completed output tail'],
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await expect(window.getByTestId('panel-content-chat')).toBeVisible();
    const section = await openScriptsSection(window);

    const completedToggle = section.getByRole('button', {
      name: /^Completed \(\d+\)$/,
    });
    await completedToggle.click();
    const completedCard = section
      .getByText('Selection Snapshot', { exact: true })
      .locator(
        'xpath=ancestor::div[.//button[@aria-label="Enlarge output"]][1]',
      );
    await completedCard.getByLabel('Enlarge output').click();
    let dialog = window.getByRole('dialog');
    await expect(dialog).toContainText('Selection Snapshot');
    const search = dialog.getByRole('textbox', { name: 'Search', exact: true });
    await expect(search).toBeVisible();
    await window.keyboard.press(
      process.platform === 'darwin' ? 'Meta+f' : 'Control+f',
    );
    await expect(search).toBeFocused();
    await selectLineText(dialog, COMPLETED_LINE);

    await injectScriptRunEvent(electronApp, {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      script: LIVE_SCRIPT,
      outputLines: [LIVE_LINE, 'live output tail'],
    });
    await expect(
      section.getByText('Selection Stream', { exact: true }),
    ).toBeVisible();
    const completedSelection = await selectedText(window);
    await dialog.getByLabel('Close').click();

    const liveCard = section
      .getByText('Selection Stream', { exact: true })
      .locator('xpath=ancestor::*[@data-testid="activity-scripts-entry"][1]');
    await liveCard.getByLabel('Enlarge output').click();
    dialog = window.getByRole('dialog');
    await expect(dialog).toContainText('Selection Stream');
    await expect(
      dialog.getByRole('textbox', { name: 'Search', exact: true }),
    ).toBeVisible();
    await selectLineText(dialog, LIVE_LINE);

    await injectScriptOutputEvent(electronApp, {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      script: LIVE_SCRIPT,
      outputLines: ['new streamed output'],
    });
    await expect(
      dialog.getByText('new streamed output', { exact: true }),
    ).toBeVisible();
    const liveSelection = await selectedText(window);
    expect(completedSelection).toBe(COMPLETED_LINE);
    expect(liveSelection).toBe(LIVE_LINE);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// The log panel has one surface, owned by AnsiOutput: the code-block fill with
// no outline. In the running card its corners are concentric with the card
// (card radius minus card inset), and in the output dialog it runs edge to
// edge and shares the dialog's clipped corners.
test('log panel is concentric in the running card and edge to edge in the dialog', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-log-panel-surface-'),
  );
  seedDemoWorkspaces({
    userDataDir,
    apps: ['multi-repo-fullstack'],
    checkRuntimes: false,
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await expect(window.getByTestId('panel-content-chat')).toBeVisible();
    const section = await openScriptsSection(window);

    await injectScriptRunEvent(electronApp, {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      script: LIVE_SCRIPT,
      outputLines: [LIVE_LINE, 'live output tail'],
    });
    const liveCard = section
      .getByText('Selection Stream', { exact: true })
      .locator('xpath=ancestor::*[@data-testid="activity-scripts-entry"][1]');
    const tail = liveCard.getByTestId('ansi-output');
    await expect(tail).toBeVisible();

    const inCard = await tail.evaluate((element) => {
      const card = element.closest('[data-testid="activity-scripts-entry"]');
      if (!card) throw new Error('The tail is not inside a running card');
      const probe = document.createElement('span');
      probe.style.backgroundColor = 'var(--bg-secondary)';
      document.body.append(probe);
      const codeBlockFill = getComputedStyle(probe).backgroundColor;
      probe.remove();
      const tailStyle = getComputedStyle(element);
      const cardStyle = getComputedStyle(card);
      return {
        usesCodeBlockFill: tailStyle.backgroundColor === codeBlockFill,
        outline: parseFloat(tailStyle.borderTopWidth),
        tailRadius: parseFloat(tailStyle.borderTopLeftRadius),
        cardRadius: parseFloat(cardStyle.borderTopLeftRadius),
        cardInset: parseFloat(cardStyle.paddingLeft),
      };
    });
    expect(inCard.usesCodeBlockFill).toBe(true);
    expect(inCard.outline).toBe(0);
    expect(inCard.tailRadius).toBe(inCard.cardRadius - inCard.cardInset);

    await liveCard.getByLabel('Enlarge output').click();
    const dialog = window.getByRole('dialog');
    await expect(dialog).toContainText('Selection Stream');
    const reader = dialog.getByTestId('ansi-output');
    await expect(reader).toBeVisible();

    const inDialog = await reader.evaluate((element) => {
      const shell = element.closest('[role="dialog"]');
      if (!shell) throw new Error('The log is not inside a dialog');
      const log = element.getBoundingClientRect();
      const frame = shell.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        left: Math.round(log.left - frame.left),
        right: Math.round(frame.right - log.right),
        bottom: Math.round(frame.bottom - log.bottom),
        radius: parseFloat(style.borderTopLeftRadius),
        outline: parseFloat(style.borderTopWidth),
        clipped: getComputedStyle(shell).overflow === 'hidden',
      };
    });
    expect(inDialog).toEqual({
      left: 0,
      right: 0,
      bottom: 0,
      radius: 0,
      outline: 0,
      clipped: true,
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
