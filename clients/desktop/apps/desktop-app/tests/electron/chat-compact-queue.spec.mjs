// Compact queue: with the switch on, queued messages leave the end of
// the transcript for one-line rows in the Queued group of the composer's work
// drawer, tucked behind the composer. The rows reorder by keyboard and by
// dragging through the host queue, any row can interrupt.
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedWorktreeChat,
} from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
// Mock-server scenario markers must match /\[(Canopy-C[A-Za-z0-9_-]+)\]/.
const MARKER = 'Canopy-CCOMPACTQUEUE';

// A 1x1 PNG, so the image attachment has a real preview to show.
const ONE_PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// A one-frame H.264 video, so the OS has a first frame to thumbnail.
const ONE_FRAME_MP4 =
  'AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAMWbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAACgAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAkB0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAACgAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAEAAAABAAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAAoAAAAAAABAAAAAAG4bWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAyAAAAAgBVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABY21pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAASNzdGJsAAAAv3N0c2QAAAAAAAAAAQAAAK9hdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAEAAQABIAAAASAAAAAAAAAABFUxhdmM2Mi4yOC4xMDEgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAANWF2Y0MBZAAK/+EAGGdkAAqs2UQmwEQAAAMABAAAAwDIPEiWWAEABmjr48siwP34+AAAAAAQcGFzcAAAAAEAAAABAAAAFGJ0cnQAAAAAAAJQ+AAAAAAAAAAYc3R0cwAAAAAAAAABAAAAAQAAAgAAAAAcc3RzYwAAAAAAAAABAAAAAQAAAAEAAAABAAAAFHN0c3oAAAAAAAAC9wAAAAEAAAAUc3RjbwAAAAAAAAABAAADRgAAAGJ1ZHRhAAAAWm1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALWlsc3QAAAAlqXRvbwAAAB1kYXRhAAAAAQAAAABMYXZmNjIuMTIuMTAxAAAACGZyZWUAAAL/bWRhdAAAAq4GBf//qtxF6b3m2Ui3lizYINkj7u94MjY0IC0gY29yZSAxNjUgcjMyMjIgYjM1NjA1YSAtIEguMjY0L01QRUctNCBBVkMgY29kZWMgLSBDb3B5bGVmdCAyMDAzLTIwMjUgLSBodHRwOi8vd3d3LnZpZGVvbGFuLm9yZy94MjY0Lmh0bWwgLSBvcHRpb25zOiBjYWJhYz0xIHJlZj0zIGRlYmxvY2s9MTowOjAgYW5hbHlzZT0weDM6MHgxMTMgbWU9aGV4IHN1Ym1lPTcgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MSBtZV9yYW5nZT0xNiBjaHJvbWFfbWU9MSB0cmVsbGlzPTEgOHg4ZGN0PTEgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9LTIgdGhyZWFkcz0yIGxvb2thaGVhZF90aHJlYWRzPTEgc2xpY2VkX3RocmVhZHM9MCBucj0wIGRlY2ltYXRlPTEgaW50ZXJsYWNlZD0wIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MyBiX3B5cmFtaWQ9MiBiX2FkYXB0PTEgYl9iaWFzPTAgZGlyZWN0PTEgd2VpZ2h0Yj0xIG9wZW5fZ29wPTAgd2VpZ2h0cD0yIGtleWludD0yNTAga2V5aW50X21pbj0yNSBzY2VuZWN1dD00MCBpbnRyYV9yZWZyZXNoPTAgcmNfbG9va2FoZWFkPTQwIHJjPWNyZiBtYnRyZWU9MSBjcmY9MjMuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAAEFliIQAKf8XAKmh/+JQpCHfeV/ApJGD4ci+SOd9NC3VrZJk9bZjoAR54COUYwkunZFJBfPMpqLqrevcPmk88PnmsQ==';

async function sendQueued(window, userMessageId, text, requestPatch = {}) {
  await window.evaluate(
    async ({ workspaceId, worktreeId, userMessageId, text, requestPatch }) => {
      await window.api.chat.sendMessage({
        projectId: workspaceId,
        worktreeId,
        chatId: 't1',
        userMessageId,
        text,
        providerType: 'claude',
        ...requestPatch,
      });
    },
    {
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      userMessageId,
      text,
      requestPatch,
    },
  );
}

async function menuInterrupt(window, row) {
  await row.getByTestId('queued-message-more').click();
  return window
    .getByTestId('queued-message-more-menu')
    .getByTestId('queued-message-interrupt');
}

async function expectInterruptState(window, row, reason) {
  const action = await menuInterrupt(window, row);
  if (reason) {
    await expect(action).toBeDisabled();
    await expect(action).toHaveAttribute('aria-description', reason);
  } else {
    await expect(action).toBeEnabled();
  }
  await window.keyboard.press('Escape');
}

test('Compact queue lists, reorders and interrupts queued messages in the composer drawer', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'compact-queue-'));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: 't1', title: 'Chat' }],
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, MARKER, {
    llm: {
      steps: [
        { text: 'slow active turn', streamMs: 90_000 },
        { text: 'interrupted reply', stopReason: 'end_turn' },
        { text: 'next reply', stopReason: 'end_turn' },
        { text: 'last reply', stopReason: 'end_turn' },
      ],
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
    await app.selectWorktree(WORKTREE_ID);

    const composer = window.getByRole('textbox').last();
    await composer.fill(`[${MARKER}] first`);
    await composer.press('Enter');
    await expect(window.getByTestId('chat-stop-generation')).toBeVisible({
      timeout: 30_000,
    });
    await sendQueued(window, 'queued-a', 'queued alpha');
    await sendQueued(window, 'queued-b', 'queued bravo');
    await sendQueued(window, 'queued-c', 'queued charlie');

    const list = window.getByRole('list', { name: 'Queued messages' });
    const previews = list.getByTestId('queued-message-preview');
    await expect(previews).toHaveText(
      ['queued alpha', 'queued bravo', 'queued charlie'],
      { timeout: 30_000 },
    );
    // Not in the transcript: the Queued group of the drawer behind the
    // composer box, open as soon as the first message queued.
    const panel = window.getByTestId('panel-content-chat');
    const transcript = panel.getByTestId('chat-message-list-scroll');
    await expect(transcript).toHaveCount(1);
    await expect(transcript.getByTestId('queued-message-bubble')).toHaveCount(
      0,
    );
    await expect(transcript.getByText('queued alpha')).toHaveCount(0);
    // Queued prompts stay out of session replay, as they were in the
    // transcript; the row's buttons stay recorded.
    const REPLAY_BLOCKED =
      'xpath=ancestor-or-self::*[contains(concat(" ", normalize-space(@class), " "), " ph-no-capture ")]';
    await expect(previews.first().locator(REPLAY_BLOCKED)).not.toHaveCount(0);
    await expect(
      list.getByTestId('queued-message-more').first().locator(REPLAY_BLOCKED),
    ).toHaveCount(0);
    const drawer = panel.getByTestId('composer-work-drawer');
    await expect(
      drawer.getByTestId('composer-work-drawer-toggle'),
    ).toHaveAttribute('aria-expanded', 'true');
    await expect(
      drawer.getByTestId('composer-work-drawer-toggle'),
    ).toContainText('Queued3');
    const card = await drawer.boundingBox();
    const box = await window
      .locator('[data-chat-composer-root] [data-composer-layout]')
      .last()
      .boundingBox();
    expect(card && box).toBeTruthy();
    // Inset 16px from the composer's sides, past its corner radius.
    expect(Math.round(card.x - box.x)).toBe(16);
    expect(Math.round(box.x + box.width - (card.x + card.width))).toBe(16);
    // Its bottom tucks 16px under the composer's top edge.
    expect(Math.round(card.y + card.height - box.y)).toBe(16);
    // The composer paints over the tucked part.
    const onTop = await window.evaluate(
      ({ x, y }) =>
        document.elementFromPoint(x, y)?.closest('[data-composer-layout]') !==
        null,
      { x: box.x + box.width / 2, y: box.y + 8 },
    );
    expect(onTop).toBe(true);
    // The summary sits above the composer, with the queued rows above it.
    const mores = list.getByTestId('queued-message-more');
    const first = await mores.first().boundingBox();
    const summaryRow = await drawer
      .getByTestId('composer-work-drawer-toggle')
      .boundingBox();
    const lastRow = await list
      .getByTestId('queued-message-bubble')
      .last()
      .boundingBox();
    expect(summaryRow.y + summaryRow.height).toBeLessThanOrEqual(box.y + 1);
    expect(lastRow.y + lastRow.height).toBeLessThanOrEqual(summaryRow.y);
    expect(first.x + first.width).toBeLessThanOrEqual(card.x + card.width);
    // A quiet grip handle leads each row with a grab cursor; Edit and
    // Interrupt live in the ••• menu.
    const rows = list.getByTestId('queued-message-bubble');
    const handles = list.getByTestId('queued-message-drag-handle');
    await expect(handles.locator('[data-glyph="grip-vertical"]')).toHaveCount(
      3,
    );
    await expect(handles.first()).toHaveCSS('cursor', 'grab');
    await expect(rows.getByTestId('queued-message-steer').first()).toHaveText(
      'Steer',
    );
    // Steer is inline; Interrupt, Edit, Copy and Delete live in the menu.
    await expect(
      rows
        .first()
        .locator(
          'button:not([data-testid="queued-message-more"]):not([data-testid="queued-message-drag-handle"])',
        ),
    ).toHaveText(['Steer']);
    await expectInterruptState(window, rows.first());
    await expect(list.getByTestId('queued-message-edit')).toHaveCount(0);
    await expect(list.getByTestId('queued-message-cancel')).toHaveCount(0);

    // Reorder from the keyboard on the focused handle: charlie moves up one
    // place. dnd-kit measures the rows after each step; a key that arrives
    // before the previous move settles is dropped.
    await handles.nth(2).focus();
    await window.keyboard.press('Space');
    await expect(handles.nth(2)).toHaveAttribute('aria-pressed', 'true');
    for (const key of ['ArrowUp', 'Space']) {
      await window.waitForTimeout(250);
      await window.keyboard.press(key);
    }
    await expect(previews).toHaveText([
      'queued alpha',
      'queued charlie',
      'queued bravo',
    ]);
    // Reorder by dragging the second row's handle to the top.
    const from = await handles.nth(1).boundingBox();
    const to = await handles.nth(0).boundingBox();
    const x = from.x + from.width / 2;
    await window.mouse.move(x, from.y + from.height / 2);
    await window.mouse.down();
    for (let step = 1; step <= 10; step += 1) {
      await window.mouse.move(
        x,
        from.y + from.height / 2 - ((from.y - to.y + 8) * step) / 10,
      );
    }
    await window.mouse.up();
    await expect(previews).toHaveText([
      'queued charlie',
      'queued alpha',
      'queued bravo',
    ]);
    // The host order follows: it survives a reload.
    await window.reload();
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await expect(previews).toHaveText(
      ['queued charlie', 'queued alpha', 'queued bravo'],
      { timeout: 30_000 },
    );

    // The menu holds Interrupt, Edit, Copy and Delete.
    await rows.nth(2).getByTestId('queued-message-more').click();
    await expect(window.getByRole('menuitem')).toHaveText([
      'Interrupt',
      'Edit',
      'Copy',
      'Delete',
    ]);
    // Edit message opens the editor with the focus in it.
    await window.getByTestId('queued-message-edit').click();
    const editor = window.getByTestId('queued-message-editor');
    await expect(
      editor.locator('[data-chat-textarea][contenteditable="true"]'),
    ).toBeFocused();
    await editor.getByTestId('queued-message-edit-cancel').click();
    await expect(editor).toHaveCount(0);
    // Any row may be sent now, not only the next one.
    await (await menuInterrupt(window, rows.nth(2))).click();
    await expect(
      panel.locator('[data-role="user"]').filter({ hasText: 'queued bravo' }),
    ).toHaveCount(1, { timeout: 60_000 });
    await expect(previews).toHaveText(['queued charlie', 'queued alpha']);

    // Attachments show before the text: an image as its thumbnail, a video
    // as a thumbnail with a play glyph, any other file as its icon and name.
    const files = mkdtempSync(path.join(os.tmpdir(), 'compact-queue-files-'));
    const image = path.join(files, 'screenshot.png');
    writeFileSync(image, Buffer.from(ONE_PIXEL_PNG, 'base64'));
    const video = path.join(files, 'demo.mp4');
    writeFileSync(video, Buffer.from(ONE_FRAME_MP4, 'base64'));
    const notes = path.join(files, 'notes.txt');
    writeFileSync(notes, 'notes');
    await sendQueued(window, 'queued-d', 'queued delta', {
      attachmentPaths: [image, video, notes],
    });
    const withFiles = rows.filter({ hasText: 'queued delta' });
    const attachments = withFiles.getByTestId('queued-message-attachment');
    await expect(attachments).toHaveCount(3, { timeout: 30_000 });
    await expect(attachments.nth(0)).toHaveAttribute('data-kind', 'image');
    await expect(attachments.nth(0).locator('img')).toHaveAttribute(
      'src',
      /^data:image\//,
    );
    await expect(attachments.nth(1)).toHaveAttribute('data-kind', 'video');
    // macOS and Windows draw the video's first frame as its preview, a plain
    // square like an image; Linux has no OS thumbnailer, so the tile stays
    // empty there. No play glyph either way.
    await expect(attachments.nth(1).locator('svg')).toHaveCount(0);
    if (process.platform === 'darwin' || process.platform === 'win32') {
      await expect(attachments.nth(1).locator('img')).toHaveAttribute(
        'src',
        /^data:image\//,
      );
    }
    await expect(attachments.nth(2)).toHaveText('notes.txt');
    for (const index of [0, 1]) {
      const tile = await attachments.nth(index).boundingBox();
      expect(Math.round(tile.width)).toBe(24);
      expect(Math.round(tile.height)).toBe(24);
    }
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Compact queue stays on the composer box under chat state notices', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'compact-queue-'));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: 't1', title: 'Chat' }],
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, MARKER, {
    llm: { steps: [{ text: 'slow active turn', streamMs: 90_000 }] },
  });
  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({ userDataDir }),
  );
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const composer = window.getByRole('textbox').last();
    await composer.fill(`[${MARKER}] first`);
    await composer.press('Enter');
    await expect(window.getByTestId('chat-stop-generation')).toBeVisible({
      timeout: 30_000,
    });
    await sendQueued(window, 'queued-a', 'queued alpha');
    const list = window.getByRole('list', { name: 'Queued messages' });
    await expect(list.getByTestId('queued-message-preview')).toHaveText(
      ['queued alpha'],
      { timeout: 30_000 },
    );
    // The row can steer before the state refresh is stubbed out below.
    await expect(list.getByTestId('queued-message-steer')).toBeEnabled({
      timeout: 30_000,
    });

    // A stale command raises "Chat changed elsewhere" and a snapshot refresh
    // that never settles, so both recovery notices stay up between the
    // transcript and the composer.
    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('chat:command');
      ipcMain.handle('chat:command', (_event, envelope) => ({
        commandId: envelope.commandId,
        revision: 9,
        outcome: 'not_found',
      }));
      ipcMain.removeHandler('chat:get-state');
      ipcMain.handle('chat:get-state', () => new Promise(() => {}));
    });
    await list.getByTestId('queued-message-steer').click();
    const refreshing = window.getByTestId('chat-state-refreshing-toast');
    const conflict = window.getByTestId('chat-state-conflict-notice');
    await expect(refreshing).toBeVisible();
    await expect(conflict).toBeVisible();
    await expect(list.getByTestId('queued-message-preview')).toHaveText([
      'queued alpha',
    ]);

    const card = await window.getByTestId('composer-work-drawer').boundingBox();
    const box = await window
      .locator('[data-chat-composer-root] [data-composer-layout]')
      .last()
      .boundingBox();
    expect(card && box).toBeTruthy();
    // The card stays on the composer box, not on whatever sits above it:
    // inset 16px from the box and tucked 16px under its edge.
    expect(Math.round(card.x - box.x)).toBe(16);
    expect(Math.round(box.x + box.width - (card.x + card.width))).toBe(16);
    expect(Math.round(card.y + card.height - box.y)).toBe(16);
    // The independent tip slot adds a second 8px stack gap before the drawer.
    // The notices remain clear of the drawer, including their hit targets.
    for (const notice of [refreshing, conflict]) {
      const rect = await notice.boundingBox();
      expect(rect).toBeTruthy();
      expect(
        Math.round(card.y - (rect.y + rect.height)),
      ).toBeGreaterThanOrEqual(8);
      const covered = await window.evaluate(
        ({ x, y, testId }) =>
          document
            .elementFromPoint(x, y)
            ?.closest(`[data-testid="${testId}"]`) === null,
        {
          x: rect.x + rect.width / 2,
          y: rect.y + rect.height - 2,
          testId: await notice.getAttribute('data-testid'),
        },
      );
      expect(covered).toBe(false);
    }
    const lowest = await conflict.boundingBox();
    expect(Math.round(card.y - (lowest.y + lowest.height))).toBe(16);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('A queued row waiting to be queued says why and keeps ••• open', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'compact-queue-'));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: 't1', title: 'Chat' }],
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, MARKER, {
    llm: { steps: [{ text: 'slow active turn', streamMs: 90_000 }] },
  });
  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({ userDataDir }),
  );
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const composer = window.getByRole('textbox').last();
    await composer.fill(`[${MARKER}] first`);
    await composer.press('Enter');
    await expect(window.getByTestId('chat-stop-generation')).toBeVisible({
      timeout: 30_000,
    });
    // Once a queued row can steer, the chat's steering support has loaded.
    await sendQueued(window, 'queued-a', 'queued alpha');
    await expect(
      window
        .getByRole('list', { name: 'Queued messages' })
        .getByTestId('queued-message-steer'),
    ).toBeEnabled({ timeout: 30_000 });
    // The host takes a moment to queue a follow-up; hold it there so the
    // row stays in that state.
    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('chat:send-message');
      ipcMain.handle('chat:send-message', () => new Promise(() => {}));
    });
    await composer.fill('held follow-up');
    await composer.press('Enter');
    const list = window.getByRole('list', { name: 'Queued messages' });
    const row = list
      .getByTestId('queued-message-bubble')
      .filter({ hasText: 'held follow-up' });
    await expect(row).toHaveCount(1);
    const reason = 'Available once this message is queued';
    // Steer and Send now wait and say why: there is no queued entry yet.
    await expectInterruptState(window, row, reason);
    for (const action of [row.getByTestId('queued-message-steer')]) {
      await expect(action).toBeDisabled();
      await expect(action).toHaveAttribute('aria-description', reason);
    }
    await row.getByTestId('queued-message-steer').hover({ force: true });
    await expect(window.getByRole('tooltip', { name: reason })).toBeVisible();
    // ••• is not dimmed: it opens, with Edit message and Delete waiting.
    const more = row.getByTestId('queued-message-more');
    await expect(more).toBeEnabled();
    await more.click();
    await expect(
      window.getByTestId('queued-message-more-unavailable'),
    ).toHaveText(reason);
    await expect(window.getByTestId('queued-message-edit')).toBeDisabled();
    await expect(window.getByTestId('queued-message-cancel')).toBeDisabled();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// Shared setup for the busy-agent states: a slow turn with Compact queue on.
async function openBusyChat(userDataDir) {
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: 't1', title: 'Chat' }],
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, MARKER, {
    llm: { steps: [{ text: 'slow active turn', streamMs: 90_000 }] },
  });
  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({ userDataDir }),
  );
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_ID);
  const composer = window.getByRole('textbox').last();
  await composer.fill(`[${MARKER}] first`);
  await composer.press('Enter');
  await expect(window.getByTestId('chat-stop-generation')).toBeVisible({
    timeout: 30_000,
  });
  return { electronApp, window, composer };
}

test('Every row keeps its handle, actions and quiet ••• while others are still being queued', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'compact-queue-'));
  const { electronApp, window, composer } = await openBusyChat(userDataDir);
  try {
    await sendQueued(window, 'queued-a', 'queued alpha');
    const list = window.getByRole('list', { name: 'Queued messages' });
    const rows = list.getByTestId('queued-message-bubble');
    await expect(rows.getByTestId('queued-message-steer')).toHaveCount(1, {
      timeout: 30_000,
    });
    // Two follow-ups the host has not queued yet.
    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('chat:send-message');
      ipcMain.handle('chat:send-message', () => new Promise(() => {}));
    });
    for (const text of ['held bravo', 'held charlie']) {
      await composer.fill(text);
      await composer.press('Enter');
    }
    await expect(list.getByTestId('queued-message-preview')).toHaveText([
      'queued alpha',
      'held bravo',
      'held charlie',
    ]);
    const queued = 'Available once this message is queued';
    // Every row keeps a handle; the queued one still moves.
    const handles = list.getByTestId('queued-message-drag-handle');
    await expect(handles).toHaveCount(3);
    await expect(handles.nth(0)).toBeEnabled();
    for (const index of [1, 2]) {
      await expect(handles.nth(index)).toBeDisabled();
      await expect(handles.nth(index)).toHaveAttribute(
        'aria-description',
        queued,
      );
    }
    // The queued row steers and sends now; the others show both, waiting.
    await expect(rows.nth(0).getByTestId('queued-message-steer')).toBeEnabled();
    await expectInterruptState(window, rows.nth(0));
    for (const index of [1, 2]) {
      await expectInterruptState(window, rows.nth(index), queued);
      for (const testId of ['queued-message-steer']) {
        const action = rows.nth(index).getByTestId(testId);
        await expect(action).toBeDisabled();
        await expect(action).toHaveAttribute('aria-description', queued);
        await expect(action).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      }
    }
    // The same quiet ••• on every row: enabled, no fill at rest.
    const mores = list.getByTestId('queued-message-more');
    await expect(mores).toHaveCount(3);
    await window.mouse.move(0, 0);
    for (const index of [0, 1, 2]) {
      await expect(mores.nth(index)).toBeEnabled();
      await expect(mores.nth(index)).toHaveCSS(
        'background-color',
        'rgba(0, 0, 0, 0)',
      );
    }
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('With an edit open, the other rows keep their handles and actions, saying why they wait', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'compact-queue-'));
  const { electronApp, window } = await openBusyChat(userDataDir);
  try {
    await sendQueued(window, 'queued-a', 'queued alpha');
    await sendQueued(window, 'queued-b', 'queued bravo');
    await sendQueued(window, 'queued-c', 'queued charlie');
    const list = window.getByRole('list', { name: 'Queued messages' });
    const rows = list.getByTestId('queued-message-bubble');
    await expect(rows.getByTestId('queued-message-steer')).toHaveCount(3, {
      timeout: 30_000,
    });
    await rows.nth(0).getByTestId('queued-message-more').click();
    await window.getByTestId('queued-message-edit').click();
    await expect(window.getByTestId('queued-message-editor')).toBeVisible();
    await expect(list.getByTestId('queued-message-preview')).toHaveText([
      'queued bravo',
      'queued charlie',
    ]);
    const editing = 'Available after you finish editing';
    const handles = list.getByTestId('queued-message-drag-handle');
    await expect(handles).toHaveCount(2);
    for (const index of [0, 1]) {
      await expect(handles.nth(index)).toBeDisabled();
      await expect(handles.nth(index)).toHaveAttribute(
        'aria-description',
        editing,
      );
      await expectInterruptState(window, rows.nth(index), editing);
      for (const testId of ['queued-message-steer']) {
        const action = rows.nth(index).getByTestId(testId);
        await expect(action).toBeDisabled();
        await expect(action).toHaveAttribute('aria-description', editing);
      }
      await expect(
        rows.nth(index).getByTestId('queued-message-more'),
      ).toBeEnabled();
    }
    // Closing the editor gives the rows their handles and actions back.
    await window
      .getByTestId('queued-message-editor')
      .getByTestId('queued-message-edit-cancel')
      .click();
    await expect(handles).toHaveCount(3);
    for (const index of [0, 1, 2]) {
      await expect(handles.nth(index)).toBeEnabled();
      await expect(
        rows.nth(index).getByTestId('queued-message-steer'),
      ).toBeEnabled();
      await expectInterruptState(window, rows.nth(index));
    }
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Rows reorder by dragging again and again, and the handle lets go of its hover', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'compact-queue-'));
  const { electronApp, window } = await openBusyChat(userDataDir);
  try {
    await sendQueued(window, 'queued-a', 'queued alpha');
    await sendQueued(window, 'queued-b', 'queued bravo');
    await sendQueued(window, 'queued-c', 'queued charlie');
    const list = window.getByRole('list', { name: 'Queued messages' });
    const previews = list.getByTestId('queued-message-preview');
    const handles = list.getByTestId('queued-message-drag-handle');
    await expect(list.getByTestId('queued-message-steer')).toHaveCount(3, {
      timeout: 30_000,
    });
    // Drag the last row to the top, three times over.
    const dragLastToTop = async () => {
      const from = await handles.nth(2).boundingBox();
      const to = await handles.nth(0).boundingBox();
      const x = from.x + from.width / 2;
      await window.mouse.move(x, from.y + from.height / 2);
      await window.mouse.down();
      for (let step = 1; step <= 10; step += 1) {
        await window.mouse.move(
          x,
          from.y + from.height / 2 - ((from.y - to.y + 8) * step) / 10,
        );
      }
      await window.mouse.up();
    };
    for (const expected of [
      ['queued charlie', 'queued alpha', 'queued bravo'],
      ['queued bravo', 'queued charlie', 'queued alpha'],
      ['queued alpha', 'queued bravo', 'queued charlie'],
    ]) {
      await dragLastToTop();
      await expect(previews).toHaveText(expected);
      // Away from the handles, none keeps a hover fill.
      await window.mouse.move(0, 0);
      for (const index of [0, 1, 2]) {
        await expect(handles.nth(index)).toHaveCSS(
          'background-color',
          'rgba(0, 0, 0, 0)',
        );
      }
    }
    // The host kept the last order: it survives a reload.
    await window.reload();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await expect(previews).toHaveText(
      ['queued alpha', 'queued bravo', 'queued charlie'],
      { timeout: 30_000 },
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
