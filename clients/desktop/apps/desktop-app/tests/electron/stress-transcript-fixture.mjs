import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { seedCoworkWorkspace } from './seeders/seedCoworkWorkspace.mjs';

export const STRESS_TRANSCRIPT = Object.freeze({
  workspaceId: 'cowork-default',
  entryId: 'stress-entry',
  chatId: 'stress-chat',
  leanId: 'stress-lean',
});

// Same composition as the implanted Default chat: 25 agent turns, 647 rows
// per turn, 480 tool exchanges, three mid-turn question/answer exchanges,
// and a 26 KB Markdown handoff. Answers explicitly stay within the running
// turn so all 25 display turns exceed the 500-row paging boundary.
export function buildStressTranscriptMessages({
  turns = 25,
  batches = 160,
  finalBytes = 26_000,
} = {}) {
  const messages = [];
  for (let turn = 0; turn < turns; turn += 1) {
    const prefix = `stress-${turn}`;
    const timestamp = Date.parse('2026-09-01T12:00:00Z') + turn * 2_700_000;
    const add = (suffix, role, blocks) =>
      messages.push({
        id: `${prefix}-${suffix}`,
        codexTurnId: `${prefix}-agent-turn`,
        role,
        timestamp: timestamp + messages.length * 1000,
        blocks,
      });
    const text = (suffix, role, value) =>
      add(suffix, role, [{ type: 'text', text: value }]);
    text(
      'prompt',
      'user',
      `Stress request ${turn + 1}: inspect persistence, navigation, and recovery. Preserve the full tool evidence and finish with a detailed report.`,
    );
    add('timer', 'system', [
      {
        type: 'turn_timer',
        startedAt: timestamp,
        completedAt: timestamp + 2_000_000,
      },
    ]);
    text(
      'intro',
      'assistant',
      `I’ll trace the storage and rendering boundaries for phase ${turn + 1}, checking saved state against the visible result.`,
    );
    for (let batch = 0; batch < batches; batch += 1) {
      text(
        `progress-${batch}`,
        'assistant',
        `Stress progress ${turn + 1}/${batch}: the previous batch preserves identity and ordering. I’m checking recovery, repeat navigation, and the saved representation before moving to the next case.`,
      );
      for (let check = 0; check < 3; check += 1) {
        const ordinal = batch * 3 + check;
        const toolUseId = `${prefix}-tool-${ordinal}`;
        const toolName = ['Read', 'Grep', 'Bash', 'Edit'][ordinal % 4];
        const file = `src/transcript/recovery-${ordinal % 12}.ts`;
        const input =
          toolName === 'Bash'
            ? {
                command: 'npm test -- transcript --runInBand',
                description: 'Verify recovery assertions',
              }
            : toolName === 'Grep'
              ? { pattern: 'restore|cursor|complete', path: 'src/transcript' }
              : toolName === 'Edit'
                ? {
                    file_path: file,
                    old_string: 'pending',
                    new_string: 'complete',
                  }
                : { file_path: file, offset: 1, limit: 40 };
        const isError = toolName === 'Bash' && batch % 29 === 0;
        const output = Array.from(
          { length: 18 },
          (_, line) =>
            `${file}:${line + 1}: ${isError ? 'FAIL simulated recovery assertion' : 'Verified saved identity and visible completion'}; case ${turn + 1}/${batch}/${check}; preserve transcript order and retry evidence.`,
        ).join('\n');
        add(`exchange-${ordinal}`, 'system', [
          {
            type: 'tool_use',
            toolUseId,
            toolName,
            input: JSON.stringify(input),
          },
          { type: 'tool_result', toolUseId, toolName, output, isError },
        ]);
      }
      if ([39, 79, 119].includes(batch)) {
        const requestId = `${prefix}-question-${batch}`;
        const question =
          'Include reopening and recovered tool errors in the review?';
        const progress = messages.find(
          (message) => message.id === `${prefix}-progress-${batch}`,
        );
        progress.blocks[0].asyncQuestion = {
          requestId,
          questions: [{ title: question, options: ['Include recovery'] }],
        };
        add(`steer-${batch}`, 'user', [
          {
            type: 'text',
            text: `Stress steering ${turn + 1}/${batch}: include recovery.`,
            asyncQuestionAnswer: {
              requestId,
              startsTurn: false,
              answers: [{ question, selectedOptions: ['Include recovery'] }],
            },
          },
        ]);
      }
    }
    const section = [
      '### Recovery findings',
      '',
      'The simulated review follows the initiating action, intermediate state, persistence boundary, and visible result. IDs and chronological ordering survive repeated navigation. These are fixture results; no commands were executed.',
      '',
      '| Check | Expected | Result |',
      '| --- | --- | --- |',
      '| Reopen | Stable identity | Passed |',
      '| Retry | Original evidence retained | Passed |',
      '',
      '```typescript',
      'const recovery = {',
      '  preserveMessageIds: true,',
      '  verifyAfterReopen: true,',
      "  status: 'complete',",
      '};',
      '```',
      '',
      'Carry the acceptance criteria into the next phase and compare saved state with the visible transcript.',
      '',
    ].join('\n');
    let final = `# Stress final report ${turn + 1}\n\n`;
    while (final.length + section.length < finalBytes) final += section;
    final += 'Detailed verification evidence. '.repeat(
      Math.ceil((finalBytes - final.length) / 32),
    );
    text('final', 'assistant', final);
  }
  return messages;
}

export async function seedStressTranscript(userDataDir, config = {}) {
  const { workspaceId, entryId, chatId, leanId } = STRESS_TRANSCRIPT;
  const providerType = config.providerType ?? 'codex';
  const messages = buildStressTranscriptMessages(config);
  seedCoworkWorkspace({
    userDataDir,
    workspaceId,
    name: 'Default',
    collapsed: false,
  });
  const root = path.join(userDataDir, 'workspaces', workspaceId);
  const { require: tsRequire } = await import('tsx/cjs/api');
  const { ChatStorageV2 } = tsRequire(
    '../../src/main/lib/chat-storage-v2.ts',
    import.meta.url,
  );
  const storage = new ChatStorageV2(root, entryId);
  const createdAt = '2026-09-01T12:00:00.000Z';
  const metadata = (id, title) => ({
    id,
    title,
    createdAt,
    kind: 'chat',
    providerType,
    ...(providerType === 'codex' ? { model: 'gpt-6-sol' } : {}),
  });
  const tabs = [
    metadata(leanId, 'Stress lean sibling'),
    metadata(chatId, 'Stress transcript'),
  ];
  await storage.migrate(async () => ({
    revision: 1,
    index: { activeTabId: leanId, runtimeByChatId: {} },
    recovery: {
      receipts: [],
      mutationIds: [],
      removedTabIds: [],
      removedArchiveEntryIds: [],
      removedMessageIds: [],
    },
    chats: (async function* () {
      for (const tab of tabs)
        yield {
          metadata: tab,
          messages: (async function* () {
            if (tab.id === chatId) yield* messages;
            else
              yield {
                id: 'stress-lean-message',
                role: 'assistant',
                timestamp: Date.parse(createdAt),
                blocks: [{ type: 'text', text: 'Stress lean sibling ready.' }],
              };
          })(),
        };
    })(),
  }));
  mkdirSync(root, { recursive: true });
  writeFileSync(
    path.join(root, 'work-entries.json'),
    JSON.stringify({
      version: 1,
      entries: [
        {
          id: entryId,
          title: 'Stress transcript',
          createdAt,
          summary: {
            version: 1,
            title: 'Stress transcript',
            lastMessageAt: createdAt,
            providerType,
            chatCount: tabs.length,
            chats: tabs.map((tab) => ({ ...tab, lastMessageAt: createdAt })),
          },
        },
      ],
    }),
  );
  const indexes = await storage.indexes();
  const transcript = indexes.live.tabs.find(
    (tab) => tab.id === chatId,
  ).transcript;
  return {
    ...STRESS_TRANSCRIPT,
    turns: config.turns ?? 25,
    rowsPerTurn: messages.length / (config.turns ?? 25),
    messageCount: messages.length,
    transcriptBytes: transcript.committedByteLength,
    toolExchanges: messages
      .flatMap((message) => message.blocks)
      .filter((block) => block.type === 'tool_use').length,
    finalBytes: config.finalBytes ?? 26_000,
    providerType,
    storage: 'canonical-v2-with-turn-cache',
  };
}
