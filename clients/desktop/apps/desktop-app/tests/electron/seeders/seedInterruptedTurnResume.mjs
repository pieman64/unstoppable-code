import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { seedWorktreeChat } from './seedWorktreeChat.mjs';
import { seedUsageLimitedChats } from './seedUsageLimitedChats.mjs';

export const interruptedResumeScope = {
  projectId: 'demo-ts-pnpm-vite',
  worktreeId: 'demo-main',
  chatId: 'interrupted-resume-transcript',
};
// 8:00 PM local, two calendar days before the run: never today, and always
// inside the six days a completion stamp names by weekday. A fixed date ages
// out of that window and changes the stamp's format.
export const interruptedStartedAt = (() => {
  const startedAt = new Date();
  startedAt.setDate(startedAt.getDate() - 2);
  startedAt.setHours(20, 0, 0, 0);
  return startedAt.getTime();
})();
export const interruptedActivityAt = interruptedStartedAt + 12_000;

export function interruptedResumeMessages() {
  return [
    {
      id: 'original',
      role: 'user',
      timestamp: interruptedStartedAt,
      blocks: [
        { type: 'text', text: 'Read the settings and update the title.' },
      ],
    },
    {
      id: 'old-timer',
      role: 'system',
      timestamp: interruptedStartedAt,
      blocks: [
        {
          type: 'turn_timer',
          startedAt: interruptedStartedAt,
          completedAt: null,
        },
      ],
    },
    {
      id: 'read-call',
      role: 'assistant',
      timestamp: interruptedStartedAt + 1000,
      blocks: [
        {
          type: 'tool_use',
          toolUseId: 'read',
          toolName: 'Read',
          input: '{"file_path":"settings.json"}',
        },
        {
          type: 'tool_use',
          toolUseId: 'background-agent',
          toolName: 'Agent',
          input: '{"description":"Background review","run_in_background":true}',
        },
      ],
    },
    {
      id: 'child-follow-up',
      role: 'user',
      parentToolUseId: 'background-agent',
      timestamp: interruptedStartedAt + 1500,
      blocks: [{ type: 'text', text: 'Check the title in the background.' }],
    },
    {
      id: 'read-result',
      role: 'system',
      timestamp: interruptedStartedAt + 2000,
      blocks: [
        {
          type: 'tool_result',
          toolUseId: 'read',
          toolName: 'Read',
          output: '{"title":"Old title"}',
          isError: false,
        },
        {
          type: 'tool_result',
          toolUseId: 'background-agent',
          toolName: 'Agent',
          output: 'Background review started',
          isError: false,
        },
      ],
    },
    {
      id: 'edit-call',
      role: 'assistant',
      timestamp: interruptedActivityAt,
      blocks: [
        {
          type: 'tool_use',
          toolUseId: 'edit',
          toolName: 'Edit',
          input:
            '{"file_path":"settings.json","old_string":"Old title","new_string":"New title"}',
        },
      ],
    },
  ];
}

/** Seed a real restart, not a renderer-only approximation of settled history. */
export function seedInterruptedTurnResume(userDataDir) {
  const { projectId, worktreeId, chatId } = interruptedResumeScope;
  const messages = interruptedResumeMessages();
  seedWorktreeChat({
    userDataDir,
    workspaceId: projectId,
    worktreeId,
    providerType: 'claude',
    activeTabId: chatId,
    tabs: [
      {
        id: chatId,
        title: 'Interrupted transcript',
        model: 'sonnet',
        messages,
      },
    ],
  });
  const journal = path.join(
    userDataDir,
    'workspaces',
    projectId,
    'chat-journals',
    `${worktreeId}.jsonl`,
  );
  mkdirSync(path.dirname(journal), { recursive: true });
  writeFileSync(
    journal,
    `${JSON.stringify({ v: 1, revision: 1, mutationId: 'seed-interrupted-resume', occurredAt: new Date(interruptedActivityAt).toISOString(), source: 'provider', mutations: [{ type: 'runtime.patched', chatId, runtime: { status: 'streaming', queuedMessageIds: [], activeTurn: { userMessageId: 'original', startedAt: interruptedStartedAt }, lastActivityAt: interruptedActivityAt } }] })}\n`,
  );
  seedUsageLimitedChats({
    userDataDir,
    entries: [
      {
        ...interruptedResumeScope,
        provider: 'claude',
        interruptedUserMessageId: 'original',
        resumeReason: 'app_shutdown',
        // Detected at the next launch, after the turn it interrupted.
        detectedAt: interruptedStartedAt + 4 * 60 * 60 * 1000,
        workspaceName: 'TypeScript pnpm Vite',
        chatTitle: 'Interrupted transcript',
      },
    ],
  });
  return messages;
}

/**
 * Modern canonical restart. The older V1 fixture above deliberately retains
 * metadata-free migration behavior; it cannot exercise an interruption offer.
 * Seed the same transcript and running turn into V2 before the host starts so
 * real startup settlement must produce main-owned interruptedTurns metadata.
 */
export async function seedCanonicalInterruptedTurnResume(
  userDataDir,
  { unanswered = false, additionalTabs = [] } = {},
) {
  const messages = seedInterruptedTurnResume(userDataDir);
  const tabs = [
    {
      id: interruptedResumeScope.chatId,
      title: 'Interrupted transcript',
      model: 'sonnet',
      messages: unanswered ? messages.slice(0, 1) : messages,
    },
    ...additionalTabs,
  ];
  const { file } = seedWorktreeChat({
    userDataDir,
    workspaceId: interruptedResumeScope.projectId,
    worktreeId: interruptedResumeScope.worktreeId,
    activeTabId: interruptedResumeScope.chatId,
    providerType: 'claude',
    tabs,
  });
  const { require: tsRequire } = await import('tsx/cjs/api');
  const { ChatStorageV2 } = tsRequire(
    '../../../src/main/lib/chat-storage-v2.ts',
    import.meta.url,
  );
  const storage = new ChatStorageV2(
    path.join(userDataDir, 'workspaces', interruptedResumeScope.projectId),
    interruptedResumeScope.worktreeId,
  );
  await storage.migrate(async () => ({
    revision: 1,
    index: {
      activeTabId: interruptedResumeScope.chatId,
      runtimeByChatId: {},
    },
    recovery: {
      receipts: [],
      mutationIds: [],
      removedTabIds: [],
      removedArchiveEntryIds: [],
      removedMessageIds: [],
    },
    chats: (async function* () {
      for (const { messages: rows, ...metadata } of file.tabs) {
        yield {
          metadata,
          messages: (async function* () {
            yield* rows;
          })(),
        };
      }
    })(),
  }));
  // As in transcript-storage-fixture.mjs, install a crash-time live index
  // after migration, which intentionally only admits settled imports.
  const indexPath = path.join(storage.directory, 'live-index.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  index.runtimeByChatId[interruptedResumeScope.chatId] = {
    status: 'streaming',
    queuedMessageIds: [],
    updatedAt: interruptedActivityAt,
    activeTurn: { userMessageId: 'original', startedAt: interruptedStartedAt },
    lastActivityAt: interruptedActivityAt,
  };
  writeFileSync(indexPath, JSON.stringify(index));
  return messages;
}
