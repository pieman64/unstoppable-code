import path from 'node:path';
import { writeJson } from './fsHelpers.mjs';

/**
 * Harness primitive — seed the usage-limited chats registry consumed by the
 * account-change resume modal (`UsageLimitResumeModal` /
 * `listUsageLimitedIdleChats` / `resumeUsageLimitedChats`).
 *
 * On-disk path: `usage-limited-chats.json` at the `CANOPY_DATA_DIR` root
 * (`apps/desktop-app/src/main/lib/paths.ts` `getUsageLimitedChatsFilePath` →
 * `getDataDir()`, which `launchCanopy.mjs` points at the test's own
 * `userDataDir`).
 *
 * Shape: `UsageLimitedChatsFile` from `packages/desktop-shared/src/types.ts`:
 *   { version: 1, entries: UsageLimitedChatEntry[] }
 *
 * Each entry's `projectId`/`worktreeId`/`chatId` must match a real seeded
 * chat tab (see `seedWorktreeChat.mjs`) — `handleListUsageLimitedIdleChats`
 * prunes registry entries whose chat tab no longer exists.
 *
 * @param {object} options
 * @param {string} options.userDataDir absolute CANOPY_DATA_DIR
 * @param {import('@canopy/desktop-shared/types').UsageLimitedChatEntry[]} [options.entries]
 *   defaults to an empty registry
 * @returns {{ filePath: string, file: import('@canopy/desktop-shared/types').UsageLimitedChatsFile }}
 */
export function seedUsageLimitedChats(options) {
  const { userDataDir, entries = [] } = options ?? {};

  if (!userDataDir) {
    throw new Error('seedUsageLimitedChats requires userDataDir');
  }

  /** @type {import('@canopy/desktop-shared/types').UsageLimitedChatsFile} */
  const file = { version: 1, entries };
  const filePath = path.join(userDataDir, 'usage-limited-chats.json');

  writeJson(filePath, file);
  return { filePath, file };
}
