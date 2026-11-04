// Home Continue paging: with 17 unread results, Continue lists the 5 most
// recent, Show more adds 10 at a time, and the button goes once every row is
// listed. Offline: the chats are seeded persisted JSON.
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';

const UNREAD_COUNT = 17;

/** A finished, unread chat whose turn ended at `endedAt`. */
function finishedUnreadChat(index, endedAt) {
  const id = `finished-${index}`;
  return {
    id,
    title: `Finished ${index}`,
    lastAcceptedUserMessageId: `${id}-user`,
    turnEnds: { [`${id}-user`]: { outcome: 'completed', endedAt } },
    unread: true,
    messages: [
      {
        id: `${id}-user`,
        role: 'user',
        timestamp: endedAt - 1000,
        blocks: [{ type: 'text', text: 'Finish this task.' }],
      },
      {
        id: `${id}-assistant`,
        role: 'assistant',
        timestamp: endedAt,
        blocks: [{ type: 'text', text: 'Done.' }],
      },
    ],
  };
}

function unreadChatTabs(count = UNREAD_COUNT) {
  return [
    { id: 'idle', title: 'Idle chat', messages: [] },
    ...Array.from({ length: count }, (_, index) =>
      finishedUnreadChat(index + 1, 1788782500000 - index * 60_000),
    ),
  ];
}

function seedUnreadChats() {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-continue-show-more-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    providerType: 'claude',
    activeTabId: 'idle',
    tabs: unreadChatTabs(),
  });
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    JSON.stringify({
      version: 1,
      preferences: {
        onboardingCompleted: ['v1'],
        legalConsentAcceptedAt: '2026-07-06T00:00:00.000Z',
        legalConsentTosVersion: '2026-07-06',
      },
    }),
    'utf8',
  );
  return userDataDir;
}

test('Home Continue shows 5 rows, then 10 more per Show more', async () => {
  const userDataDir = seedUnreadChats();
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    const card = window
      .getByTestId('page-home')
      .getByTestId('home-resume-card');
    const rows = card.getByTestId('home-continue-unread-row');
    const showMore = card.getByTestId('home-continue-show-more');

    await expect(rows).toHaveCount(5, { timeout: 30_000 });
    await expect(rows.first()).toContainText('Finished 1');
    await expect(showMore).toHaveText('Show more');

    // Show more is one more row: the same pitch as the rows above it.
    const pitch = await card.evaluate((element) => {
      const items = [...element.querySelectorAll('ul > li')];
      const tops = items.map((li) => li.getBoundingClientRect().top);
      return tops.slice(1).map((top, index) => top - tops[index]);
    });
    expect(new Set(pitch).size).toBe(1);

    await showMore.click();
    await expect(rows).toHaveCount(15);
    await showMore.click();
    await expect(rows).toHaveCount(UNREAD_COUNT);
    await expect(showMore).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
