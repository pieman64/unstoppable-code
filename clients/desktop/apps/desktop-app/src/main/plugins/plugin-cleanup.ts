import * as fs from 'node:fs';
import * as path from 'node:path';
import { getChatPluginsRootDir, getChatSkillPluginDir } from '../lib/paths';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getErrorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function removeGeneratedPluginDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    // Chat plugin directories are generated cache/state. Cleanup
    // failures, including unresolvable Windows reparse points, must not block
    // session teardown or worktree archival.
    // eslint-disable-next-line no-console
    console.warn('[plugin-cleanup] Failed to remove generated plugin state', {
      code: getErrorCode(error),
    });
  }
}

export function cleanupChatSkillPluginDir(
  projectId: string,
  worktreeId: string,
  chatId: string,
): void {
  const dir = getChatSkillPluginDir(projectId, worktreeId, chatId);
  removeGeneratedPluginDir(dir);
}

export function cleanupWorktreeChatPluginDirs(
  projectId: string,
  worktreeId: string,
): void {
  const dir = path.join(getChatPluginsRootDir(), projectId, worktreeId);
  removeGeneratedPluginDir(dir);
}
