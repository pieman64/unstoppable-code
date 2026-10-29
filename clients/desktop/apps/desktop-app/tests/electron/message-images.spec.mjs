// ---------------------------------------------------------------------------
// Sent images in the user bubble (early access).
//
// Seeds a settled chat whose user message carries four attachments: a small
// PNG, a PNG over the preview handler's 5 MB image cap, a HEIC photo the
// handler cannot draw, and a text file. With Early access off every
// attachment stays a file chip under the bubble, exactly as on develop. With
// it on, only the PNG the handler can draw becomes a thumbnail inside the
// bubble (loaded through the real `readFilePreview` IPC); the oversized PNG,
// the HEIC photo and the text file stay chips, so no attachment ever shows
// as a blank tile, a 64px square 6px from the bubble's top and left edge.
// Clicking the thumbnail opens the file externally.
//
// Determinism: the transcript and attachments are seeded on disk; the
// external open goes to a local capture receiver. No agents, providers or network.
// ---------------------------------------------------------------------------
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CHAT_ID = 'message-images-chat';

/** A 1x1 opaque PNG. */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

function seed(userDataDir, attachmentsDir) {
  mkdirSync(attachmentsDir, { recursive: true });
  const shot = path.join(attachmentsDir, 'shot.png');
  const huge = path.join(attachmentsDir, 'huge.png');
  const photo = path.join(attachmentsDir, 'photo.heic');
  const notes = path.join(attachmentsDir, 'notes.txt');
  writeFileSync(shot, TINY_PNG);
  writeFileSync(huge, Buffer.alloc(6 * 1024 * 1024));
  writeFileSync(photo, Buffer.from('not a real heic'));
  writeFileSync(notes, 'release notes\n');

  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: CHAT_ID,
    tabs: [
      {
        id: CHAT_ID,
        title: 'Message images',
        messages: [
          {
            id: 'message-images-user',
            role: 'user',
            blocks: [{ type: 'text', text: 'See the references.' }],
            attachmentPaths: [shot, huge, photo, notes],
            timestamp: Date.parse('2026-10-01T10:00:00.000Z'),
          },
          {
            id: 'message-images-assistant',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'Got them.' }],
            timestamp: Date.parse('2026-10-01T10:00:05.000Z'),
          },
        ],
      },
    ],
  });
  return { shot };
}

/** Local receiver standing in for the system's default app. */
async function startExternalOpenCapture() {
  const opened = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        opened.push(JSON.parse(body).url);
      } catch {
        // Ignore malformed payloads; the assertion reports the gap.
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/__capture/external-open`,
    opened,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
      }),
  };
}

test('sent images show in the bubble with early access and stay chips without it', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-message-images-'),
  );
  const { shot } = seed(userDataDir, path.join(userDataDir, 'e2e-attachments'));
  const externalOpen = await startExternalOpenCapture();
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: { CANOPY_E2E_EXTERNAL_OPEN_CAPTURE_URL: externalOpen.url },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    expect(
      await window.evaluate(() =>
        window.api.experiments
          .getSnapshot()
          .then((snapshot) => snapshot.earlyAccessEnabled),
      ),
    ).not.toBe(true);

    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await window.getByTestId(`panel-tab-panel-chat-${CHAT_ID}`).click();
    const chat = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${CHAT_ID}"]`,
    );
    await expect(chat).toContainText('See the references.');

    const tiles = chat.getByTestId('message-image-attachment');
    const chips = chat.getByTestId('file-attachment-chip');

    // Early access off: develop's chips for every attachment.
    await expect(chips).toHaveCount(4);
    await expect(chips).toContainText([
      'shot.png',
      'huge.png',
      'photo.heic',
      'notes.txt',
    ]);
    await expect(chat.getByTestId('message-image-attachments')).toHaveCount(0);

    // Early access on: only the drawable PNG moves into the bubble.
    await window.evaluate(() =>
      window.api.experiments.setChoice({
        experimentId: 'early-access',
        enabled: true,
      }),
    );
    await expect(tiles).toHaveCount(1);
    await expect(tiles.first()).toHaveAttribute('title', 'shot.png');
    const image = tiles.first().locator('img');
    await expect(image).toHaveAttribute('src', /^data:image\/png;base64,/);
    await expect
      .poll(() => image.evaluate((element) => element.naturalWidth))
      .toBe(1);
    await expect(chips).toHaveCount(3);
    await expect(chips).toContainText(['huge.png', 'photo.heic', 'notes.txt']);

    // A 64px square, inset as far from the bubble's top as from its side.
    const bubble = chat.getByTestId('portal-chat-message-content');
    const tileBox = await tiles.first().boundingBox();
    const bubbleBox = await bubble.boundingBox();
    expect(tileBox?.width).toBeCloseTo(64, 0);
    expect(tileBox?.height).toBeCloseTo(64, 0);
    if (!tileBox || !bubbleBox) throw new Error('Bubble or thumbnail missing');
    expect(tileBox.y - bubbleBox.y).toBeCloseTo(6, 0);
    expect(tileBox.x - bubbleBox.x).toBeCloseTo(6, 0);

    // The thumbnail opens the file in the system's default app.
    await tiles.first().click();
    await expect
      .poll(() => [...externalOpen.opened])
      .toEqual([pathToFileURL(shot).toString()]);

    // Turning early access back off restores the chips.
    await window.evaluate(() =>
      window.api.experiments.setChoice({
        experimentId: 'early-access',
        enabled: false,
      }),
    );
    await expect(tiles).toHaveCount(0);
    await expect(chips).toHaveCount(4);
  } finally {
    await closeCanopy(electronApp, userDataDir).catch(() => undefined);
    await externalOpen.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
