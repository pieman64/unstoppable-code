// Two Codex chats in different projects share one pooled fake app-server.
// Chat A's provider burst is held immediately before its durable canonical
// transcript write (a slow commit), so A's notification admission stays
// pending. A message sent in chat B must still complete and render while A
// remains held: one owner's admission may only delay that owner's frames, not
// the shared app-server stdout. After A's write is released, A drains and
// renders its whole burst. See docs/codex-app-server.md, "Per-owner
// notification admission", and the 2026-09-30 incident notes.
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { launchCanopy } from './launchCanopy.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { readChatStorageMessages } from './readChatStorage.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
import { holdProviderTranscriptWrite } from './seeders/holdProviderTranscriptWrite.mjs';
import { withoutChatSummaryTraffic } from './fixtures/codex-chat-summary-traffic.mjs';
import {
  closeFixture,
  createFixture,
  seedPreferences,
} from './codexPipelineRuntime.mjs';

const HELD_MARKER = 'CANOPY-EVENT-PRESSURE-00';
const LAST_MARKER = 'CANOPY-EVENT-PRESSURE-47';
const PEER_REPLY = 'CANOPY-PEER-CHAT-REPLY-WHILE-PEER-HELD';
const WORKTREE_ID = 'demo-main';
const HELD_PROJECT = 'demo-ts-pnpm-vite';
const PEER_PROJECT = 'demo-ts-yarn-cli';
const HELD_CHAT = 'held-commit-chat';
const PEER_CHAT = 'peer-chat';

function protocolEntries(logPath) {
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function openProjectWorktreeChat(window, projectId) {
  const app = new CanopyAppDriver(window);
  await app.openMainPage();
  const row = window
    .locator(
      `[data-testid="worktree-row"][data-project-id="${projectId}"][data-worktree-id="${WORKTREE_ID}"]`,
    )
    .first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
  const panel = window
    .locator('[data-testid="panel-content-chat"]:visible')
    .first();
  await expect(panel).toBeVisible();
  const composerRoot = panel.locator('[data-chat-composer-root]');
  await expect(composerRoot).toBeVisible();
  return { panel, composerRoot };
}

async function sendMessage(composerRoot, text) {
  await composerRoot.getByRole('textbox').fill(text);
  await composerRoot.getByRole('button', { name: 'Send message' }).click();
}

test('a Codex chat completes while another chat on the shared app-server is held on its durable commit', async () => {
  test.setTimeout(240_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-codex-shared-admission-'),
  );
  // The fixture's normal turns reply with PEER_REPLY; only the held chat's
  // prompt triggers the 48-item pressure burst.
  const fixture = createFixture('event-pressure', PEER_REPLY);
  seedPreferences(userDataDir);
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite', 'ts-yarn-cli'] });
  for (const [projectId, chatId, title] of [
    [HELD_PROJECT, HELD_CHAT, 'Held commit chat'],
    [PEER_PROJECT, PEER_CHAT, 'Peer chat'],
  ]) {
    seedWorktreeChat({
      userDataDir,
      workspaceId: projectId,
      worktreeId: WORKTREE_ID,
      providerType: 'codex',
      tabs: [{ id: chatId, title, providerType: 'codex', model: 'gpt-6-sol' }],
    });
  }

  const { electronApp } = await launchCanopy({
    userDataDir,
    env: fixture.env,
  });
  let barrier;
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    // Chat A: start the burst and hold its first durable assistant write.
    const held = await openProjectWorktreeChat(window, HELD_PROJECT);
    barrier = await holdProviderTranscriptWrite(electronApp, {
      userDataDir,
      workspaceId: HELD_PROJECT,
      scopeId: WORKTREE_ID,
      marker: HELD_MARKER,
    });
    await sendMessage(held.composerRoot, 'Report pressure status.');
    await expect
      .poll(async () => (await barrier.read())?.reached, { timeout: 45_000 })
      .toBe(true);

    // Chat B, in another project on the same pooled app-server, must start
    // its thread, run its turn, and render the reply while A stays held.
    const peer = await openProjectWorktreeChat(window, PEER_PROJECT);
    await sendMessage(peer.composerRoot, 'Say hello from the peer chat.');
    await expect(
      peer.panel.getByText(PEER_REPLY, { exact: false }).first(),
    ).toBeVisible({ timeout: 45_000 });
    await expect(
      peer.composerRoot.getByRole('button', { name: 'Send message' }),
    ).toBeVisible({ timeout: 30_000 });

    // A is still held: its write gate is closed and its burst is not durable.
    expect((await barrier.read())?.reached).toBe(true);
    const heldMessagesWhileHeld = readChatStorageMessages(
      path.join(userDataDir, 'workspaces', HELD_PROJECT),
      WORKTREE_ID,
      HELD_CHAT,
    );
    expect(JSON.stringify(heldMessagesWhileHeld)).not.toContain(LAST_MARKER);

    // Both conversation turns were served by one shared app-server process.
    // Each chat's first message also schedules a chat-summary helper thread;
    // those are not the chats' turns.
    const turnStarts = withoutChatSummaryTraffic(
      protocolEntries(fixture.logPath),
    ).filter(
      (entry) =>
        entry.direction === 'client' && entry.message?.method === 'turn/start',
    );
    expect(turnStarts.length).toBeGreaterThanOrEqual(2);
    expect(new Set(turnStarts.map((entry) => entry.pid)).size).toBe(1);
    expect(
      new Set(turnStarts.map((entry) => entry.message.params.threadId)).size,
    ).toBeGreaterThanOrEqual(2);

    // Releasing A's commit drains its held burst in order.
    await barrier.release();
    const heldAgain = await openProjectWorktreeChat(window, HELD_PROJECT);
    await expect(
      heldAgain.panel.getByText(LAST_MARKER, { exact: false }).first(),
    ).toBeVisible({ timeout: 90_000 });
    await expect(
      heldAgain.composerRoot.getByRole('button', { name: 'Send message' }),
    ).toBeVisible({ timeout: 30_000 });
    const heldMessages = readChatStorageMessages(
      path.join(userDataDir, 'workspaces', HELD_PROJECT),
      WORKTREE_ID,
      HELD_CHAT,
    );
    const markers = heldMessages.flatMap((message) =>
      (message.blocks ?? [])
        .filter((block) => block.type === 'text')
        .flatMap((block) =>
          Array.from(
            block.text.matchAll(/CANOPY-EVENT-PRESSURE-\d{2}/g),
            (match) => match[0],
          ),
        ),
    );
    expect(markers).toEqual(
      Array.from(
        { length: 48 },
        (_, index) => `CANOPY-EVENT-PRESSURE-${String(index).padStart(2, '0')}`,
      ),
    );
  } finally {
    try {
      await barrier?.stop();
    } finally {
      await closeFixture(electronApp, userDataDir, fixture.runtimeDir);
    }
  }
});
