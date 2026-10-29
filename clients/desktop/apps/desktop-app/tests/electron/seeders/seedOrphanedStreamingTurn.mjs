import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { seedWorktreeChat } from './seedWorktreeChat.mjs';

/**
 * Seed the exact crash-recovery shape produced when a provider emits a final
 * assistant message but never emits its terminal turn event: the transcript
 * has an open timer while canonical runtime is still streaming.
 */
export function seedOrphanedStreamingTurn(options) {
  const {
    userDataDir,
    workspaceId,
    worktreeId,
    chatId = 'orphaned-streaming-turn',
    title = 'Interrupted turn recovery',
    providerType = 'codex',
    model = 'gpt-5.5',
    startedAt = Date.now() - (49 * 60_000 + 53_000),
    userText = 'Investigate the current service health',
    finalText = 'The investigation is complete and this is the final answer.',
  } = options ?? {};
  const userMessageId = `${chatId}-user`;

  seedWorktreeChat({
    userDataDir,
    workspaceId,
    worktreeId,
    providerType,
    activeTabId: chatId,
    tabs: [
      {
        id: chatId,
        title,
        providerType,
        model,
        messages: [
          {
            id: userMessageId,
            role: 'user',
            timestamp: startedAt,
            blocks: [{ type: 'text', text: userText }],
          },
          {
            id: `${chatId}-timer`,
            role: 'system',
            timestamp: startedAt,
            blocks: [{ type: 'turn_timer', completedAt: null }],
          },
          {
            id: `${chatId}-final`,
            role: 'assistant',
            timestamp: startedAt + 13 * 60_000,
            blocks: [{ type: 'text', text: finalText }],
          },
        ],
      },
    ],
  });

  const journalPath = path.join(
    userDataDir,
    'workspaces',
    workspaceId,
    'chat-journals',
    `${worktreeId}.jsonl`,
  );
  mkdirSync(path.dirname(journalPath), { recursive: true });
  writeFileSync(
    journalPath,
    `${JSON.stringify({
      v: 1,
      revision: 1,
      mutationId: 'seed-orphaned-streaming-turn',
      occurredAt: new Date(startedAt).toISOString(),
      source: 'provider',
      mutations: [
        {
          type: 'runtime.patched',
          chatId,
          runtime: {
            status: 'streaming',
            queuedMessageIds: [],
            activeTurn: { userMessageId, startedAt },
            lastActivityAt: startedAt + 13 * 60_000,
          },
        },
      ],
    })}\n`,
  );

  return { chatId, finalText, journalPath, startedAt, userMessageId, userText };
}
