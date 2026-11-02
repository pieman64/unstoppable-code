// A worktree chat whose Claude parent reads two workspace files during a
// scripted live turn (fixtures/delegation-stream-script.mjs). One result is
// larger than TOOL_OUTPUT_INLINE_BYTES, so it is stored apart; the other is
// inline but longer than the 4,000-character Portal preview.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { seedWorkspaceApprovals, seedWorktreeChat } from './index.mjs';

export const PRIMARY_LIVE_CHAT_ID = 'primary-live-output';
export const PRIMARY_LIVE_TITLE = 'Live primary output';
export const PRIMARY_LIVE_SENTINELS = {
  stored: 'primary live stored tail sentinel',
  inline: 'primary live inline tail sentinel',
};

function evidence(stage, lines) {
  const body = Array.from(
    { length: lines },
    (_, index) =>
      `${stage} line ${String(index).padStart(4, '0')}: the quick brown fox jumps over the lazy dog.`,
  );
  return `${[...body, PRIMARY_LIVE_SENTINELS[stage]].join('\n')}\n`;
}

export function preparePrimaryLiveOutput({
  userDataDir,
  worktreePath,
  workspaceId,
  worktreeId,
}) {
  seedWorkspaceApprovals({
    userDataDir,
    workspaceId,
    defaultMode: 'full-access',
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId,
    worktreeId,
    tabs: [
      {
        id: PRIMARY_LIVE_CHAT_ID,
        title: PRIMARY_LIVE_TITLE,
        providerType: 'claude',
        executionHarness: 'claude',
        model: 'claude-sonnet-4-6',
        approvalMode: 'full-access',
      },
    ],
  });
  // About 72 KiB of Read output with line numbers, under Read's token limit.
  const storedPath = path.join(worktreePath, 'primary-live-stored.txt');
  writeFileSync(storedPath, evidence('stored', 1_000));
  const inlinePath = path.join(worktreePath, 'primary-live-inline.txt');
  writeFileSync(inlinePath, evidence('inline', 70));
  return { chatId: PRIMARY_LIVE_CHAT_ID, storedPath, inlinePath };
}
