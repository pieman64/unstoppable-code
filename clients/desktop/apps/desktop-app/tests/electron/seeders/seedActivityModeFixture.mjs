import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import {
  seedChatsSectionFixture,
  CHATS_SECTION_CODE_WORKSPACE_ID,
  CHATS_SECTION_NAMED_COWORK_ID,
  CHATS_SECTION_DEFAULT_COWORK_ID,
} from './seedChatsSectionFixture.mjs';
import { seedWorktreeChat } from './seedWorktreeChat.mjs';
import { writeJson } from './fsHelpers.mjs';

export const ACTIVITY_MODE_FIXTURE = Object.freeze({
  workspaceId: CHATS_SECTION_CODE_WORKSPACE_ID,
  coworkWorkspaceId: CHATS_SECTION_DEFAULT_COWORK_ID,
  worktreeId: 'feature-01',
  unreadChatId: 'activity-unread',
  userLastChatId: 'activity-user-last',
  activeChatId: 'activity-active',
  draftChatId: 'activity-draft',
  legacyChatId: 'activity-legacy',
  legacyWorktreeId: 'feature-02',
  unrepliedChatIds: Object.freeze(
    Array.from(
      { length: 60 },
      (_, i) => `activity-unreplied-${String(i).padStart(2, '0')}`,
    ),
  ),
});

/** Seed fake persisted conversations only. Flows create drafts in the composer
 * and start the active chat through their scenario provider after launch. */
export function seedActivityModeFixture(userDataDir) {
  seedChatsSectionFixture(userDataDir, { worktreeCount: 2, chatEntryCount: 0 });
  // The shared helper also seeds a named Cowork project. Keep this fixture's
  // inventory at two parents so that no unrelated assistant-last row leaks in.
  const indexPath = path.join(userDataDir, 'workspaces', 'index.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  index.workspaces = index.workspaces.filter(
    (workspace) => workspace.id !== CHATS_SECTION_NAMED_COWORK_ID,
  );
  writeJson(indexPath, index);
  rmSync(path.join(userDataDir, 'workspaces', CHATS_SECTION_NAMED_COWORK_ID), {
    recursive: true,
    force: true,
  });
  const f = ACTIVITY_MODE_FIXTURE;
  const epoch = Date.parse('2026-10-01T12:00:00.000Z');
  const tab = (id, role, index, unread = false) => ({
    id,
    title: id,
    kind: 'chat',
    unread,
    createdAt: new Date(epoch - 86_400_000).toISOString(),
    messages: [
      {
        id: `${id}-message`,
        role,
        timestamp: epoch - index * 60_000,
        blocks: [{ type: 'text', text: `Fixture ${id}` }],
      },
    ],
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: f.workspaceId,
    worktreeId: f.worktreeId,
    // Keep the selected chat out of Unread so navigation cannot mark it read.
    activeTabId: f.userLastChatId,
    tabs: [
      tab(f.unreadChatId, 'assistant', -4, true),
      tab(f.userLastChatId, 'user', -3),
      tab(f.activeChatId, 'assistant', -2),
      tab(f.draftChatId, 'user', -1),
      ...f.unrepliedChatIds.map((id, i) => tab(id, 'assistant', i)),
    ],
  });
  // A user-last transcript with a trailing system row: old-descriptor
  // recovery must never infer an assistant from the latest-human position.
  seedWorktreeChat({
    userDataDir,
    workspaceId: f.workspaceId,
    worktreeId: f.legacyWorktreeId,
    tabs: [
      {
        ...tab(f.legacyChatId, 'user', 70),
        messages: [
          ...tab(f.legacyChatId, 'user', 70).messages,
          ...tab('activity-system', 'system', 71).messages,
        ],
      },
    ],
  });
  seedLegacyDescriptor(
    userDataDir,
    f.workspaceId,
    f.legacyWorktreeId,
    f.legacyChatId,
  );
  const entryId = 'activity-cowork-entry';
  writeJson(
    path.join(
      userDataDir,
      'workspaces',
      f.coworkWorkspaceId,
      'work-entries.json',
    ),
    {
      version: 1,
      entries: [{ id: entryId, createdAt: new Date(epoch).toISOString() }],
    },
  );
  seedWorktreeChat({
    userDataDir,
    workspaceId: f.coworkWorkspaceId,
    worktreeId: entryId,
    activeTabId: 'activity-cowork-quiet',
    tabs: [
      tab('activity-cowork-unread', 'assistant', -5, true),
      tab('activity-cowork-quiet', 'user', -6),
    ],
  });
  return {
    ...f,
    coworkEntryId: entryId,
    expectedUnrepliedOrder: [...f.unrepliedChatIds],
  };
}

/** Use the canonical migration writer, then remove only the additive role
 * metadata to model a persisted pre-CAN-390 scope. A subprocess keeps the
 * TypeScript loader and storage/session modules out of the Playwright host.
 */
function seedLegacyDescriptor(userDataDir, workspaceId, scopeId, chatId) {
  execFileSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-'],
    {
      cwd: fileURLToPath(new URL('../../../../../', import.meta.url)),
      env: {
        ...process.env,
        CANOPY_DATA_DIR: userDataDir,
        CAN390_LEGACY_SCOPE: JSON.stringify({
          userDataDir,
          workspaceId,
          scopeId,
          chatId,
        }),
      },
      input: `
      import { readFile, writeFile } from 'node:fs/promises';
      import { createHash } from 'node:crypto';
      import { join } from 'node:path';
      import storage from './apps/desktop-app/src/main/lib/chat-storage-v2.ts';
      const { userDataDir, workspaceId, scopeId, chatId } = JSON.parse(process.env.CAN390_LEGACY_SCOPE);
      const workspaceRoot = join(userDataDir, 'workspaces', workspaceId);
      const tabs = JSON.parse(await readFile(join(workspaceRoot, 'chats', scopeId + '.json'), 'utf8'));
      const store = new storage.ChatStorageV2(workspaceRoot, scopeId);
      await store.migrate(() => Promise.resolve({
        revision: 0,
        index: { activeTabId: chatId, runtimeByChatId: {} },
        recovery: { receipts: [], mutationIds: [], removedTabIds: [], removedArchiveEntryIds: [], removedMessageIds: [] },
        chats: (async function* () {
          for (const tab of tabs.tabs) {
            const { messages, ...metadata } = tab;
            yield { metadata, messages: (async function* () { yield* messages; })() };
          }
        })(),
      }));
      const livePath = join(store.directory, 'live-index.json');
      const live = JSON.parse(await readFile(livePath, 'utf8'));
      for (const tab of live.tabs) delete tab.transcript.lastMessageRole;
      await writeFile(livePath, JSON.stringify(live));
      const sparsePath = join(store.directory, 'transcripts', chatId + '.index.json');
      const { checksum: oldChecksum, ...sparse } = JSON.parse(await readFile(sparsePath, 'utf8'));
      delete sparse.lastMessageRole;
      const checksum = createHash('sha256').update(JSON.stringify(sparse)).digest('hex');
      await writeFile(sparsePath, JSON.stringify({ ...sparse, checksum }));
    `,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
}
