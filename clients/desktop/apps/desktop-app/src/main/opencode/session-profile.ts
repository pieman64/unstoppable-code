import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { STANDALONE_CHAT_PROJECT_ID } from '@canopy/desktop-shared/types';
import { buildChatSessionKey } from '../agents/session-key';
import { getWorktreeDataDir } from '../lib/paths';
import { resolveWorktreeTargetIds } from '../lib/resolve-worktree';

/** Keep native forks and ordinary turns on the same canonical private profile. */
export function getOpenCodeSessionProfile(scope: {
  projectId: string;
  worktreeId: string;
  chatId: string;
  cwd: string;
}): string {
  const target =
    (scope.projectId === STANDALONE_CHAT_PROJECT_ID
      ? resolveWorktreeTargetIds(scope.projectId, scope.worktreeId)
      : null) ?? scope;
  const key = buildChatSessionKey(
    scope.projectId,
    scope.worktreeId,
    scope.chatId,
  );
  return join(
    getWorktreeDataDir(target.projectId, target.worktreeId),
    'opencode-sessions',
    createHash('sha256')
      .update(JSON.stringify([key, scope.cwd]))
      .digest('hex'),
  );
}
