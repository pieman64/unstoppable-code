import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';
import {
  seedDeliveryCoworkWorkspace,
  WORKSPACE_ID,
} from './coworkWorkEntryDoneFixture.mjs';

export const SIDEBAR_REORDER_IDS = Array.from(
  { length: 11 },
  (_, index) => `entry-order-${index}`,
);

/** Small deterministic transcripts, including the user's large chat-count shape. */
export function seedSidebarReorderWorkspace(userDataDir) {
  const dir = seedDeliveryCoworkWorkspace(userDataDir);
  const timestamp = '2026-07-01T12:00:00.000Z';
  const write = (file, value) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  };
  write(path.join(dir, 'work-entries.json'), {
    version: 1,
    entries: SIDEBAR_REORDER_IDS.map((id, index) => ({
      id,
      title: `Order task ${index}`,
      createdAt: timestamp,
      hasUserChanges: true,
    })),
  });
  for (const [index, id] of SIDEBAR_REORDER_IDS.entries()) {
    const tabs = Array.from({ length: index === 3 ? 228 : 1 }, (_, tab) => ({
      id: `chat-${id}-${tab}`,
      title: `Order task ${index} chat ${tab}`,
      kind: 'chat',
      providerType: 'claude',
      createdAt: timestamp,
      messages: [
        {
          id: `message-${id}-${tab}`,
          role: 'user',
          blocks: [{ type: 'text', text: 'Seeded sidebar ordering fixture.' }],
          timestamp: Date.parse(timestamp),
        },
      ],
    }));
    write(path.join(dir, 'chats', `${id}.json`), {
      version: 1,
      tabs,
      activeTabId: tabs[0].id,
    });
  }
  for (const file of [
    path.join(dir, 'workspace.json'),
    path.join(userDataDir, 'workspaces', 'index.json'),
  ]) {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (value.workspaces) value.workspaces[0].itemSortMode = 'manual';
    else value.itemSortMode = 'manual';
    write(file, value);
  }
  return { workspaceId: WORKSPACE_ID, ids: SIDEBAR_REORDER_IDS };
}

export function sidebarReorderRows(window) {
  return window
    .locator(
      '[data-testid^="sidebar-work-entry-entry-order-"]:not([data-testid$="-menu"]):not([data-testid$="-toggle-pin"])',
    )
    .filter({ has: window.locator('p') });
}

export async function dragSidebarReorderRow(
  window,
  itemId,
  beforeId,
  prefix = 'sidebar-work-entry-',
) {
  const source = window.getByTestId(`${prefix}${itemId}`).locator('p').first();
  const target = window.getByTestId(`${prefix}${beforeId}`);
  await expect(async () => {
    await source.scrollIntoViewIfNeeded();
  }).toPass({ timeout: 15000 });
  const a = await source.boundingBox();
  const b = await target.boundingBox();
  if (!a || !b) throw new Error('Sidebar reorder rows have no geometry');
  await window.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await window.mouse.down();
  await window.mouse.move(a.x + a.width / 2 + 12, a.y + a.height / 2, {
    steps: 4,
  });
  await expect(
    window.getByTestId('sidebar-item-group-drag-overlay'),
  ).toBeVisible();
  await window.mouse.move(b.x + b.width / 2, b.y + b.height / 4, { steps: 10 });
  await window.mouse.up();
}

/** Test-side IPC barriers; real handlers still execute and own persistence. */
export async function installSidebarReorderBarriers(electronApp) {
  await electronApp.evaluate(({ ipcMain }) => {
    const state = {
      saves: 0,
      reads: 0,
      trace: [],
      releaseSave: () => {},
      releaseReads: () => {},
      restore: () => {},
    };
    const saveGate = new Promise((resolve) => {
      state.releaseSave = resolve;
    });
    const readGate = new Promise((resolve) => {
      state.releaseReads = resolve;
    });
    const originals = new Map();
    for (const channel of [
      'sidebar-item-groups:move-item',
      'work-entries:list',
      'projects:load',
      'desktop:session-snapshot',
    ]) {
      const original = ipcMain._invokeHandlers.get(channel);
      if (!original) throw new Error(`Missing sidebar test handler ${channel}`);
      originals.set(channel, original);
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (...args) => {
        state.trace.push({ channel, stage: 'start', at: Date.now() });
        if (channel === 'sidebar-item-groups:move-item') {
          state.saves += 1;
          await saveGate;
        } else if (state.saves > 0) {
          state.reads += 1;
          await readGate;
        }
        const result = await original(...args);
        state.trace.push({ channel, stage: 'end', at: Date.now() });
        return result;
      });
    }
    state.restore = () => {
      state.releaseSave();
      state.releaseReads();
      for (const [channel, original] of originals) {
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, original);
      }
    };
    globalThis.__sidebarReorderBarriers = state;
  });
}

export async function releaseSidebarReorderBarriers(electronApp) {
  await electronApp.evaluate(() =>
    globalThis.__sidebarReorderBarriers?.restore(),
  );
}
