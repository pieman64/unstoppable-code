// CAN-4953: real Cowork viewer + canonical projected tool completions.
// The clean update uses real scripted Claude Read/Edit/reply execution; later
// dirty/reopen cases use deterministic writes and canonical event ingress.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';
import {
  seedAgentEditViewer,
  registerAgentEditScenario,
  completeAgentFileEdit as completeWrite,
} from './file-viewer-agent-edit-fixture.mjs';
import { EDIT_ENTRY as COWORK_FILES_ENTRY } from './file-viewer-agent-edit-fixture.mjs';

const NAME = 'onboarding-findings.md';
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const DOC_START =
  process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home';
const UPDATED =
  '# Findings\n\nEight participants\n\nP7: Clearer onboarding\n\nP8: More guidance\n';

async function paletteOpen(page) {
  await expect(page.getByTestId('cowork-top-bar')).toBeVisible();
  await expect(async () => {
    if (!(await page.getByTestId('file-search-palette').isVisible())) {
      await page.keyboard.press(`${MOD}+p`);
    }
    await expect(page.getByTestId('file-search-palette')).toBeVisible({
      timeout: 1_000,
    });
  }).toPass({ timeout: 15_000 });
  await page.getByTestId('file-search-palette-input').fill(NAME);
  await page
    .getByTestId('file-search-palette-result')
    .filter({ hasText: NAME })
    .first()
    .click();
}

test('failed merged save rechecks pending feedback against its recovery read', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'can5171-failed-merge-'),
  );
  const { filePath } = seedAgentEditViewer(userDataDir);
  const baseline = readFileSync(filePath, 'utf8');
  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({ userDataDir }),
  );
  try {
    const page = await electronApp.firstWindow();
    const app = new CanopyAppDriver(page);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await page.getByTestId(`sidebar-work-entry-${COWORK_FILES_ENTRY}`).click();
    await paletteOpen(page);
    await expect(page.getByTestId('file-viewer')).toContainText(
      'Six participants',
    );
    const editor = page.getByTestId('monaco-file-editor');
    if (!(await editor.isVisible()))
      await page.getByTestId('file-view-toggle-source').click();
    await editor.click();
    await page.keyboard.press(`${MOD}+a`);
    await page.keyboard.insertText(
      baseline.replace('# Findings', '# My findings'),
    );
    writeFileSync(filePath, baseline + '\nDistant agent update\n');
    await completeWrite(electronApp, filePath, 'can5171-failed-merge');
    const pending = page.getByTestId('file-combinable-change-notice');
    await expect(pending).toBeVisible();
    // A newer, unreported version is discovered only by stale-save recovery.
    const newer =
      baseline.replace('Six participants', 'Seven participants') +
      '\nDistant agent update\n';
    writeFileSync(filePath, newer);
    await electronApp.evaluate(({ ipcMain }, absolutePath) => {
      const channel = 'file:save-content';
      const original = ipcMain._invokeHandlers.get(channel);
      if (!original) throw new Error('File save handler not found');
      let calls = 0;
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (...args) => {
        if (args[1]?.absolutePath !== absolutePath) return original(...args);
        calls += 1;
        if (calls === 2) {
          ipcMain.removeHandler(channel);
          ipcMain.handle(channel, original);
          throw new Error('CAN-5171 merged write failed');
        }
        return original(...args);
      });
    }, filePath);
    await page.getByTestId('file-save').click();
    await expect(
      page.getByRole('alert').filter({
        hasText: 'CAN-5171 merged write failed',
      }),
    ).toBeVisible();
    await expect(pending).toHaveText(
      'This document was updated while you were editing. Save to combine your updates with the newer changes.',
    );
    await editor.click();
    await page.keyboard.press(`${MOD}+a`);
    await page.keyboard.insertText(
      baseline
        .replace('# Findings', '# My findings')
        .replace('Six participants', 'My participants'),
    );
    await expect(pending).toHaveCount(0);
    expect(readFileSync(filePath, 'utf8')).toBe(newer);
    await page.getByTestId('file-save').click();
    await expect(page.getByTestId('file-overlap-notice')).toBeVisible();
    await expect(page.getByTestId('file-combined-save-notice')).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('typing during Discard keeps recovery on the newly read version', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'can5171-canceled-reload-'),
  );
  const { filePath } = seedAgentEditViewer(userDataDir);
  const baseline = readFileSync(filePath, 'utf8');
  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({ userDataDir }),
  );
  try {
    const page = await electronApp.firstWindow();
    const app = new CanopyAppDriver(page);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await page.getByTestId(`sidebar-work-entry-${COWORK_FILES_ENTRY}`).click();
    await paletteOpen(page);
    await expect(page.getByTestId('file-viewer')).toContainText(
      'Six participants',
    );
    const editor = page.getByTestId('monaco-file-editor');
    if (!(await editor.isVisible()))
      await page.getByTestId('file-view-toggle-source').click();
    await editor.click();
    await page.keyboard.press(`${MOD}+a`);
    await page.keyboard.insertText(
      baseline.replace('Six participants', 'My participants'),
    );
    const v2 = baseline.replace('Six participants', 'Seven participants');
    writeFileSync(filePath, v2);
    await completeWrite(electronApp, filePath, 'can5171-canceled-reload');
    await expect(page.getByTestId('file-overlap-notice')).toBeVisible();
    await page.getByTestId('file-overlap-decide-later').click();
    const v3 = v2.replace('# Findings', '# New findings');
    writeFileSync(filePath, v3);
    await electronApp.evaluate(({ ipcMain }, absolutePath) => {
      const channel = 'file:read-content';
      const original = ipcMain._invokeHandlers.get(channel);
      if (!original) throw new Error('File read handler not found');
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (...args) => {
        if (args[1]?.absolutePath !== absolutePath) return original(...args);
        const response = await original(...args);
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, original);
        await new Promise((resolve) => {
          ipcMain.__can5171ReleaseReload = resolve;
        });
        return response;
      });
    }, filePath);
    await page.getByTestId('file-discard').click();
    await page.getByTestId('file-discard-confirm-accept').click();
    await expect
      .poll(() =>
        electronApp.evaluate(
          ({ ipcMain }) => typeof ipcMain.__can5171ReleaseReload,
        ),
      )
      .toBe('function');
    await editor.click();
    await page.keyboard.press(`${MOD}+a`);
    await page.keyboard.insertText(
      baseline.replace('# Findings', '# My findings'),
    );
    await electronApp.evaluate(({ ipcMain }) =>
      ipcMain.__can5171ReleaseReload(),
    );
    const keep = page.getByTestId('file-external-change-keep');
    await expect(keep).toBeEnabled();
    await keep.click();
    await expect(page.getByTestId('file-combinable-change-notice')).toHaveCount(
      0,
    );
    await expect(editor).toContainText('My findings');
    await page.getByTestId('file-save').click();
    await expect(page.getByTestId('file-overlap-notice')).toBeVisible();
    expect(readFileSync(filePath, 'utf8')).toBe(v3);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

for (const scenario of ['Discard', 'Failed Save', 'Read before failed Save']) {
  const failedSave = scenario !== 'Discard';
  const readBeforeSave = scenario === 'Read before failed Save';
  test(`${scenario} keeps recovery available when a newer disk invalidation fails to read`, async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can5001-race-'));
    const { filePath } = seedAgentEditViewer(userDataDir);
    const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
      launchCanopy({ userDataDir }),
    );
    try {
      const page = await electronApp.firstWindow();
      const app = new CanopyAppDriver(page);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await page
        .getByTestId(`sidebar-work-entry-${COWORK_FILES_ENTRY}`)
        .click();
      await expect(page.getByTestId('cowork-top-bar')).toBeVisible();
      await paletteOpen(page);
      const editor = page.getByTestId('monaco-file-editor');
      if (!(await editor.isVisible()))
        await page.getByTestId('file-view-toggle-source').click();
      await expect(editor).toContainText('Six participants');
      await editor.click();
      await page.keyboard.press(`${MOD}+a`);
      await page.keyboard.insertText(
        readFileSync(filePath, 'utf8').replace(
          'Six participants',
          'Six participants UNSAVED_MARKER',
        ),
      );
      if (!failedSave) {
        writeFileSync(filePath, UPDATED);
        await completeWrite(electronApp, filePath, 'can5001-kept-write');
        await expect(page.getByTestId('file-overlap-notice')).toBeVisible();
        await page.getByTestId('file-overlap-decide-later').click();
      }

      // Hold a real read's response after capturing its bytes. A second write
      // invalidates those bytes; its follow-up read fails deterministically.
      await electronApp.evaluate(
        ({ ipcMain }, { absolutePath, failedSave, readBeforeSave }) => {
          const channel = 'file:read-content';
          const original = ipcMain._invokeHandlers.get(channel);
          if (!original) throw new Error('File read handler not found');
          const saveOriginal = ipcMain._invokeHandlers.get('file:save-content');
          if (!saveOriginal) throw new Error('File save handler not found');
          const gate = {
            reads: 0,
            release: null,
            releaseRead: null,
            original,
            saveOriginal,
          };
          ipcMain.__can5001ReadGate = gate;
          if (failedSave) {
            ipcMain.removeHandler('file:save-content');
            ipcMain.handle('file:save-content', async (...args) => {
              if (args[1]?.absolutePath !== absolutePath)
                return saveOriginal(...args);
              await new Promise((resolve) => {
                gate.release = resolve;
              });
              throw new Error('CAN-5001 save conflict');
            });
          }
          ipcMain.removeHandler(channel);
          ipcMain.handle(channel, async (...args) => {
            if (args[1]?.absolutePath !== absolutePath)
              return original(...args);
            gate.reads += 1;
            if (readBeforeSave && gate.reads === 1) {
              const response = await original(...args);
              await new Promise((resolve) => {
                gate.releaseRead = resolve;
              });
              return response;
            }
            if (failedSave && gate.reads === (readBeforeSave ? 2 : 1))
              throw new Error('CAN-5001 recovery read offline');
            if (failedSave) return original(...args);
            if (gate.reads === 1) {
              const response = await original(...args);
              await new Promise((resolve) => {
                gate.release = resolve;
              });
              return response;
            }
            if (gate.reads === 2)
              throw new Error('CAN-5001 recovery read offline');
            return original(...args);
          });
        },
        { absolutePath: filePath, failedSave, readBeforeSave },
      );
      if (readBeforeSave) {
        writeFileSync(filePath, UPDATED + '\nNewest agent update\n');
        await completeWrite(electronApp, filePath, 'can5001-before-save');
        await expect
          .poll(() =>
            electronApp.evaluate(
              ({ ipcMain }) => typeof ipcMain.__can5001ReadGate.releaseRead,
            ),
          )
          .toBe('function');
      }
      await page.getByTestId(failedSave ? 'file-save' : 'file-discard').click();
      if (!failedSave)
        await page.getByTestId('file-discard-confirm-accept').click();
      await expect
        .poll(() =>
          electronApp.evaluate(
            ({ ipcMain }) => typeof ipcMain.__can5001ReadGate.release,
          ),
        )
        .toBe('function');
      if (!readBeforeSave) {
        writeFileSync(filePath, UPDATED + '\nNewest agent update\n');
        await completeWrite(electronApp, filePath, 'can5001-newer-write');
      }
      await electronApp.evaluate(({ ipcMain }) =>
        ipcMain.__can5001ReadGate.release(),
      );

      const notice = page.getByTestId('file-external-change-notice');
      await expect(notice).toContainText('CAN-5001 recovery read offline');
      if (readBeforeSave) {
        await electronApp.evaluate(({ ipcMain }) =>
          ipcMain.__can5001ReadGate.releaseRead(),
        );
      }
      await expect(page.getByTestId('file-viewer-dirty')).toHaveCount(
        failedSave ? 1 : 0,
      );
      await expect(editor).toContainText('Six participants');
      await expect(page.getByTestId('file-reload-announcement')).toHaveText('');
      if (failedSave) {
        await page.getByTestId('file-external-change-keep').click();
        await expect(page.getByTestId('file-discard')).toHaveText(
          'Discard my edits',
        );
        await page.getByTestId('file-discard').click();
        await page.getByTestId('file-discard-confirm-accept').click();
      } else {
        await page.getByTestId('file-external-change-show-latest').click();
      }
      await expect(editor).toContainText('Newest agent update');
      await expect(editor).not.toContainText('UNSAVED_MARKER');
      await expect(notice).toHaveCount(0);
      await expect(page.getByTestId('file-reload-announcement')).toHaveText(
        'Document updated to the latest version.',
      );
      await expect(
        page.locator('[data-testid^="panel-tab-panel-file-"]'),
      ).toHaveCount(1);
      expect(readFileSync(filePath, 'utf8')).toBe(
        UPDATED + '\nNewest agent update\n',
      );
    } finally {
      await electronApp
        .evaluate(({ ipcMain }) => {
          const gate = ipcMain.__can5001ReadGate;
          gate?.release?.();
          gate?.releaseRead?.();
          if (gate) {
            ipcMain.removeHandler('file:read-content');
            ipcMain.handle('file:read-content', gate.original);
            ipcMain.removeHandler('file:save-content');
            ipcMain.handle('file:save-content', gate.saveOriginal);
          }
        })
        .catch(() => {});
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

test('Cowork refreshes clean content, preserves dirty edits, and rechecks an existing palette tab', async ({}, testInfo) => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can4953-refresh-'));
  const { filePath } = seedAgentEditViewer(userDataDir);
  const marker = 'Canopy-CAN4953DESKTOP';
  await registerAgentEditScenario(filePath, marker);
  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({ userDataDir }),
  );
  try {
    const page = await electronApp.firstWindow();
    const app = new CanopyAppDriver(page);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await page.getByTestId(`sidebar-work-entry-${COWORK_FILES_ENTRY}`).click();
    await expect(page.getByTestId('cowork-top-bar')).toBeVisible();
    await paletteOpen(page);
    const viewer = page.getByTestId('file-viewer');
    await expect(viewer).toContainText('Six participants');
    const tabs = page.locator('[data-testid^="panel-tab-panel-file-"]');
    await expect(tabs).toHaveCount(1);
    const editor = page.getByTestId('monaco-file-editor');
    // Markdown opens formatted; its Source segment shows the editor.
    if (!(await editor.isVisible()))
      await page.getByTestId('file-view-toggle-source').click();
    await expect(editor).toBeVisible();
    await editor.click();
    const focusBefore = await page.evaluate(
      () => document.activeElement?.className,
    );
    await page.evaluate(() => {
      window.__can4953Receipt = null;
      window.__can4953EditId = null;
      window.api.chat.onChatEvent((event) => {
        const content = event.data?.message?.content;
        if (event.data?.type === 'assistant' && Array.isArray(content)) {
          const edit = content.find(
            (part) => part.type === 'tool_use' && part.name === 'Edit',
          );
          if (edit) window.__can4953EditId = edit.id;
        }
        if (event.data?.type !== 'user') return;
        if (
          Array.isArray(content) &&
          content.some(
            (part) =>
              part.type === 'tool_result' &&
              window.__can4953EditId !== null &&
              part.tool_use_id === window.__can4953EditId,
          )
        ) {
          window.__can4953Receipt = performance.now();
        }
      });
    });
    const chat = page.locator('[data-testid="panel-content-chat"]:visible');
    await chat
      .locator('[data-chat-textarea][contenteditable="true"]')
      .fill(
        `[${marker}] [Canopy-Mock-Request:findings] Update the findings from six to eight participants.`,
      );
    await chat
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    await editor.click();
    await page.waitForFunction(
      () => typeof window.__can4953Receipt === 'number',
      undefined,
      { timeout: 90_000 },
    );
    await expect(editor).toContainText('Eight participants', {
      timeout: 5_000,
    });
    await expect(editor).toContainText('P7: Clearer onboarding');
    await expect(editor).toContainText('P8: More guidance');
    const elapsedMs = await page.evaluate(() =>
      window.__can4953Receipt === null
        ? null
        : performance.now() - window.__can4953Receipt,
    );
    await testInfo.attach('completion-responsiveness', {
      body: JSON.stringify({
        elapsedMs,
        targetMs: 1000,
        source: 'renderer tool-result receipt',
      }),
      contentType: 'application/json',
    });
    expect(
      elapsedMs,
      'successful tool-result receipt was observed',
    ).not.toBeNull();
    expect(elapsedMs).toBeLessThanOrEqual(1000);
    expect(readFileSync(filePath, 'utf8')).toBe(UPDATED);
    expect(await page.evaluate(() => document.activeElement?.className)).toBe(
      focusBefore,
    );
    await expect(tabs).toHaveCount(1);
    await expect(page.getByTestId('file-external-change-notice')).toHaveCount(
      0,
    );

    await expect(chat).toContainText('with P7 and P8 quotes.', {
      timeout: 30_000,
    });
    await editor.click();
    // Edit the first line so the agent's appended line stays disjoint.
    await page.keyboard.press(DOC_START);
    await page.keyboard.type('UNSAVED_MARKER ');
    await expect(page.getByTestId('file-viewer-dirty')).toBeVisible();
    writeFileSync(filePath, UPDATED + '\nSecond agent update\n');
    await completeWrite(electronApp, filePath, 'dirty-write');
    await expect(editor).toContainText('UNSAVED_MARKER');
    // CAN-5000: a change the save combines asks nothing of the user; the
    // save combines the disjoint changes instead of a stale-version error.
    // CAN-5171: a neutral notice explains what Save will do.
    const pendingNotice = page.getByTestId('file-combinable-change-notice');
    await expect(pendingNotice).toBeVisible();
    await expect(pendingNotice).toHaveText(
      /^.+ updated this document while you were editing\. Save to combine your updates with .+'s\.$/,
    );
    await expect(pendingNotice.getByRole('button')).toHaveCount(0);
    const discard = page.getByTestId('file-discard');
    const confirm = page.getByTestId('file-discard-confirm');
    const cancelDiscard = page.getByTestId('file-discard-confirm-cancel');
    await expect(discard).toHaveText('Discard my edits');
    await discard.click();
    await expect(confirm).toHaveAccessibleName(
      `Discard your edits to “${NAME}”?`,
    );
    await expect(cancelDiscard).toBeFocused();
    // A real Enter activates Cancel's browser default, never the header.
    await page.keyboard.press('Enter');
    await expect(confirm).toHaveCount(0);
    await expect(discard).toBeFocused();
    await expect(editor).toContainText('UNSAVED_MARKER');
    await expect(page.getByTestId('file-viewer-dirty')).toBeVisible();
    expect(readFileSync(filePath, 'utf8')).toBe(
      UPDATED + '\nSecond agent update\n',
    );
    await expect(editor).not.toContainText('Second agent update');
    await expect(page.getByTestId('file-viewer-dirty')).toBeVisible();
    await expect(page.getByTestId('file-external-change-notice')).toHaveCount(
      0,
    );
    await page.getByTestId('file-save').click();
    await expect(page.getByTestId('file-viewer-dirty')).toHaveCount(0);
    await expect(pendingNotice).toHaveCount(0);
    await expect(page.getByTestId('file-save-conflict-notice')).toHaveCount(0);
    await expect(page.getByTestId('file-external-change-notice')).toHaveCount(
      0,
    );
    await expect
      .poll(() => readFileSync(filePath, 'utf8'))
      .toBe('UNSAVED_MARKER ' + UPDATED + '\nSecond agent update\n');
    await expect(page.getByTestId('file-reload-announcement')).toContainText(
      /Saved\. Your edits and .+ changes were combined\./,
    );
    const savedNotice = page.getByTestId('file-combined-save-notice');
    await expect(savedNotice).toBeVisible();
    await expect(savedNotice).toHaveText(
      /^Saved\. Your edits and .+'s changes were combined\.$/,
    );
    await page.getByTestId('file-combined-save-notice-dismiss').click();
    await expect(savedNotice).toHaveCount(0);

    // CAN-5001: a conflicting edit that was kept still discards to disk.
    await editor.click();
    await page.keyboard.press(`${MOD}+a`);
    await page.keyboard.insertText(
      readFileSync(filePath, 'utf8').replace(
        'Eight participants',
        'DISCARD_DRAFT participants',
      ),
    );
    const latestAfterKeep = readFileSync(filePath, 'utf8').replace(
      'Eight participants',
      'Nine participants',
    );
    writeFileSync(filePath, latestAfterKeep);
    await completeWrite(electronApp, filePath, 'discard-after-keep');
    await expect(page.getByTestId('file-overlap-notice')).toBeVisible();
    await expect(discard).toHaveText('Discard my edits');
    await discard.click();
    await expect(confirm).toContainText(
      'Discarding loses the edits you haven’t saved and shows the latest version of the document.',
    );
    await expect(cancelDiscard).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(confirm).toHaveCount(0);
    await expect(discard).toBeFocused();
    await expect(editor).toContainText('DISCARD_DRAFT');
    expect(readFileSync(filePath, 'utf8')).toBe(latestAfterKeep);
    // After Decide later, correcting the draft restores the pending combine
    // explanation while keeping the unsaved buffer and stale baseline.
    await page.getByTestId('file-overlap-decide-later').click();
    await expect(page.getByTestId('file-overlap-notice')).toHaveCount(0);
    await discard.click();
    await expect(confirm).toContainText('latest version of the document.');
    await cancelDiscard.click();
    await expect(discard).toBeFocused();
    await expect(editor).toContainText('DISCARD_DRAFT');
    await editor.click();
    await page.keyboard.press(`${MOD}+a`);
    await page.keyboard.insertText(
      latestAfterKeep
        .replace('Nine participants', 'Eight participants')
        .replace('# Findings', '# Findings LOCAL'),
    );
    await expect(page.getByTestId('file-overlap-notice')).toHaveCount(0);
    await expect(pendingNotice).toBeVisible();
    await expect(editor).toContainText('Findings LOCAL');
    await expect(editor).toContainText('Eight participants');
    expect(readFileSync(filePath, 'utf8')).toBe(latestAfterKeep);
    // CAN-5365: the stale header names what it loses and asks first.
    await expect(discard).toHaveText('Discard my edits');
    await discard.click();
    await expect(confirm).toContainText(
      'Discarding loses the edits you haven’t saved and shows the latest version of the document.',
    );
    await expect(page.getByTestId('file-discard-confirm-cancel')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(confirm).toHaveCount(0);
    await expect(discard).toBeFocused();
    await expect(editor).toContainText('Findings LOCAL');
    await expect(page.getByTestId('file-viewer-dirty')).toBeVisible();
    expect(readFileSync(filePath, 'utf8')).toBe(latestAfterKeep);
    await discard.click();
    await page.getByTestId('file-discard-confirm-accept').click();
    await expect(confirm).toHaveCount(0);
    await expect(pendingNotice).toHaveCount(0);
    await expect(editor).toContainText('Nine participants');
    await expect(editor).not.toContainText('DISCARD_DRAFT');
    await expect(page.getByTestId('file-viewer-dirty')).toHaveCount(0);
    await expect(page.getByTestId('file-external-change-notice')).toHaveCount(
      0,
    );
    await expect(tabs).toHaveCount(1);
    expect(readFileSync(filePath, 'utf8')).toBe(latestAfterKeep);
    await expect(
      page.locator('[data-testid="file-viewer-header"]:visible'),
    ).toBeFocused();

    // Start Show latest from a fresh dirty buffer with a current baseline.
    await paletteOpen(page);
    await expect(editor).toContainText('Second agent update');
    // The agent's version drops the saved first-line marker, so editing the
    // first line overlaps it and the notice offers Show latest.
    await editor.click();
    await page.keyboard.press(DOC_START);
    await page.keyboard.type('FRESH_UNSAVED_MARKER ');
    await expect(page.getByTestId('file-viewer-dirty')).toBeVisible();
    writeFileSync(filePath, UPDATED + '\nThird agent update\n');
    await completeWrite(electronApp, filePath, 'dirty-write-again');
    await expect(page.getByTestId('file-overlap-notice')).toBeVisible();
    await page.getByTestId('file-overlap-choose-theirs').click();
    await expect(editor).toContainText('Third agent update');
    await expect(editor).not.toContainText('UNSAVED_MARKER');
    await expect(editor).not.toContainText('FRESH_UNSAVED_MARKER');
    await expect(page.getByTestId('file-viewer-dirty')).toHaveCount(0);

    // Undoing the only local change must reveal the already-known disk
    // update, even when that update combined silently.
    await editor.click();
    await page.keyboard.press(DOC_START);
    await page.keyboard.type('UNDO_UNSAVED_MARKER');
    await expect(page.getByTestId('file-viewer-dirty')).toBeVisible();
    writeFileSync(filePath, UPDATED + '\nUndo freshness\n');
    await completeWrite(electronApp, filePath, 'undo-write');
    await expect(page.getByTestId('file-external-change-notice')).toHaveCount(
      0,
    );
    await expect(pendingNotice).toBeVisible();
    await page.keyboard.press(`${MOD}+z`);
    await expect(editor).toContainText('Undo freshness');
    await expect(editor).not.toContainText('UNDO_UNSAVED_MARKER');
    await expect(pendingNotice).toHaveCount(0);
    await expect(page.getByTestId('file-external-change-notice')).toHaveCount(
      0,
    );
    await expect(tabs).toHaveCount(1);

    writeFileSync(filePath, UPDATED + '\nMention freshness\n');
    await page
      .getByTestId('chat-local-file-link')
      .filter({ hasText: NAME })
      .first()
      .click();
    await expect(editor).toContainText('Mention freshness');
    await expect(tabs).toHaveCount(1);

    writeFileSync(filePath, UPDATED + '\nChip freshness\n');
    await page
      .getByTestId('turn-file-chip-open')
      .filter({ hasText: NAME })
      .first()
      .click();
    await expect(viewer).toContainText('Chip freshness');
    await expect(tabs).toHaveCount(1);

    writeFileSync(filePath, UPDATED + '\nPalette freshness\n');
    await paletteOpen(page);
    await expect(viewer).toContainText('Palette freshness');
    await expect(tabs).toHaveCount(1);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
