import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';

export const transcriptScope = {
  projectId: 'demo-ts-pnpm-vite',
  worktreeId: 'demo-main',
};
export const fullToolOutput = `FIRST OUTPUT PAGE\n${'retained tool output\n'.repeat(6000)}LAST OUTPUT PAGE`;

export async function seedTranscriptSearch({
  hiddenCanonicalRows = false,
} = {}) {
  const fixture = seedTranscriptStorage();
  const root = join(
    fixture.userDataDir,
    'workspaces',
    transcriptScope.projectId,
  );
  const file = join(root, 'chats', `${transcriptScope.worktreeId}.json`);
  const legacy = JSON.parse(readFileSync(file, 'utf8'));
  const source = legacy.tabs.find((tab) => tab.id === 'long');
  source.messages.find((row) => row.id === 'history-0').blocks[0].text =
    'buriedmatch first buriedmatch second';
  source.messages.find((row) => row.id === 'history-250').blocks[0].text =
    'buriedmatch third';
  source.messages.find((row) => row.id === 'history-508').blocks = [
    {
      type: 'thinking',
      text: 'Finish the retained work before the final answer.',
    },
  ];
  source.messages.find(
    (row) => row.id === 'long:seed-mutation:517',
  ).blocks[0].output =
    `toolpreviewneedle\n${'output prefix\n'.repeat(7000)}artifactmiddleneedle${'output suffix\n'.repeat(7000)}`;
  source.messages.push(
    {
      id: 'other-user',
      role: 'user',
      timestamp: 1788000001100,
      blocks: [{ type: 'text', text: 'Another old request' }],
    },
    ...Array.from({ length: 550 }, (_, index) => ({
      id: `other-${index}`,
      role: 'assistant',
      timestamp: 1788000001200 + index,
      blocks: [
        {
          type: 'text',
          text:
            index === 200
              ? 'buriedmatch fourth in another turn'
              : `Other retained reply ${index}`,
        },
      ],
    })),
    {
      id: 'other-thinking',
      role: 'assistant',
      timestamp: 1788000001800,
      blocks: [
        {
          type: 'thinking',
          text: 'Separate intermediate work from the final answer.',
        },
      ],
    },
    {
      id: 'other-final',
      role: 'assistant',
      timestamp: 1788000001801,
      blocks: [{ type: 'text', text: 'Other final answer' }],
    },
    ...(hiddenCanonicalRows
      ? [
          {
            id: 'hidden-canonical-local-command',
            role: 'user',
            timestamp: 1788000001801,
            blocks: [
              {
                type: 'text',
                text: '<local-command-stdout>canonicalhiddenneedle</local-command-stdout>',
              },
            ],
          },
          {
            id: 'hidden-canonical-no-response',
            role: 'assistant',
            timestamp: 1788000001801,
            blocks: [{ type: 'text', text: 'No response requested.' }],
          },
        ]
      : []),
    {
      id: 'other-timer',
      role: 'system',
      timestamp: 1788000001802,
      blocks: [{ type: 'turn_timer', completedAt: 1788000001802 }],
    },
    ...Array.from({ length: 105 }, (_, index) => [
      {
        id: `later-user-${index}`,
        role: 'user',
        timestamp: 1788000001900 + index,
        blocks: [{ type: 'text', text: `Later request ${index}` }],
      },
      {
        id: `later-reply-${index}`,
        role: 'assistant',
        timestamp: 1788000001900 + index,
        blocks: [{ type: 'text', text: `Later answer ${index}` }],
      },
      {
        id: `later-timer-${index}`,
        role: 'system',
        timestamp: 1788000001900 + index,
        blocks: [{ type: 'turn_timer', completedAt: 1788000001900 + index }],
      },
    ]).flat(),
  );
  source.messages.push(
    {
      id: 'recent-user',
      role: 'user',
      timestamp: 1788000002000,
      blocks: [{ type: 'text', text: 'Recent request' }],
    },
    {
      id: 'recent-answer',
      role: 'assistant',
      timestamp: 1788000003000,
      blocks: [{ type: 'text', text: 'Recent answer' }],
    },
    {
      id: 'recent-timer',
      role: 'system',
      timestamp: 1788000004000,
      blocks: [{ type: 'turn_timer', completedAt: 1788000004000 }],
    },
  );
  const { require: tsRequire } = await import('tsx/cjs/api');
  const { ChatStorageV2 } = tsRequire(
    '../../src/main/lib/chat-storage-v2.ts',
    import.meta.url,
  );
  const storage = new ChatStorageV2(root, transcriptScope.worktreeId);
  await storage.migrate(async () => ({
    revision: 1,
    index: { activeTabId: legacy.activeTabId, runtimeByChatId: {} },
    recovery: {
      receipts: [],
      mutationIds: [],
      removedTabIds: [],
      removedArchiveEntryIds: [],
      removedMessageIds: [],
    },
    chats: (async function* () {
      for (const { messages, ...metadata } of legacy.tabs)
        yield {
          metadata,
          messages: (async function* () {
            yield* messages;
          })(),
        };
    })(),
  }));
  return fixture;
}
/** Canonical disk fixture; damage only derived locators or seed a crashed host. */
export async function seedTranscriptRecovery({
  missingLocators = false,
  interrupted = false,
  interruptedScopeId = 'startup-recovery',
} = {}) {
  const fixture = seedTranscriptStorage();
  const root = join(
    fixture.userDataDir,
    'workspaces',
    transcriptScope.projectId,
  );
  const legacy = JSON.parse(
    readFileSync(
      join(root, 'chats', `${transcriptScope.worktreeId}.json`),
      'utf8',
    ),
  );
  const { require: tsRequire } = await import('tsx/cjs/api');
  const { ChatStorageV2 } = tsRequire(
    '../../src/main/lib/chat-storage-v2.ts',
    import.meta.url,
  );
  const scopeId = interrupted ? interruptedScopeId : transcriptScope.worktreeId;
  const storage = new ChatStorageV2(root, scopeId);
  await storage.migrate(async () => ({
    revision: 1,
    index: { activeTabId: legacy.activeTabId, runtimeByChatId: {} },
    recovery: {
      receipts: [],
      mutationIds: [],
      removedTabIds: [],
      removedArchiveEntryIds: [],
      removedMessageIds: [],
    },
    chats: (async function* () {
      for (const { messages, ...metadata } of legacy.tabs)
        yield {
          metadata,
          messages: (async function* () {
            yield* messages;
          })(),
        };
    })(),
  }));
  if (missingLocators)
    rmSync(join(storage.directory, 'transcripts', 'message-index', 'long'), {
      recursive: true,
    });
  if (interrupted) {
    // Startup recovery discovers both current and retained, removed scopes.
    // Recovery does not imply that the scope is eligible for the resume list.
    const file = join(storage.directory, 'live-index.json');
    const index = JSON.parse(readFileSync(file, 'utf8'));
    index.runtimeByChatId.long = {
      status: 'streaming',
      queuedMessageIds: [],
      updatedAt: Date.now(),
    };
    writeFileSync(file, JSON.stringify(index));
  }
  return fixture;
}
export function seedTranscriptStorage({
  pagedTurns = false,
  oversizedTurns = false,
} = {}) {
  const userDataDir = mkdtempSync(join(tmpdir(), 'transcript-storage-v2-'));
  writeFileSync(
    join(userDataDir, 'preferences.json'),
    JSON.stringify({
      version: 1,
      preferences: {
        onboardingCompleted: ['v1'],
        defaultChatInterfaceMode: 'canopy',
        defaultWorktreeProvider: 'codex',
        defaultChatProvider: 'codex',
        defaultWorktreeModelByProvider: {
          codex: { model: 'gpt-6-sol', thinkingLevel: 'high' },
        },
      },
    }),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const message = (id, text, role = 'assistant', extra = {}) => ({
    id,
    role,
    timestamp: 1788000000000,
    blocks: [{ type: 'text', text }],
    ...extra,
  });
  const messages = [
    message(
      'real-human',
      'Keep this human request visible while the transcript is paged.',
      'user',
      { userMessageSource: 'human' },
    ),
    ...Array.from({ length: 510 }, (_, index) =>
      message(
        `history-${index}`,
        index === 0 ? 'EARLIEST RETAINED REPLY' : `Retained reply ${index}`,
      ),
    ),
    message('watcher', 'Background watcher completed.', 'user', {
      watcherFired: { kind: 'Pipeline completion' },
      userMessageSource: 'watcher',
    }),
    message('reload', 'Deferred tools resumed.', 'user', {
      userMessageSource: 'deferred_tools_reload',
    }),
    message('restart', 'Session restarted.', 'user', {
      userMessageSource: 'immediate_turn_restart',
    }),
    {
      ...message('tool-call', ''),
      blocks: [
        {
          type: 'tool_use',
          toolUseId: 'call_01AbC',
          toolName: 'Read',
          input: '{"file_path":"large-output.txt"}',
        },
      ],
    },
    {
      ...message('long:seed-mutation:517', ''),
      blocks: [
        {
          type: 'tool_result',
          toolUseId: 'call_01AbC',
          toolName: 'Read',
          output: fullToolOutput,
          isError: false,
        },
      ],
    },
    {
      ...message('completed', '', 'system'),
      blocks: [{ type: 'turn_timer', completedAt: 1788000001000 }],
    },
  ];
  seedWorktreeChat({
    userDataDir,
    workspaceId: transcriptScope.projectId,
    worktreeId: transcriptScope.worktreeId,
    activeTabId: 'lean',
    providerType: 'codex',
    tabs: [
      {
        id: 'long',
        title: 'Long continuous transcript',
        model: 'gpt-6-sol',
        messages,
      },
      ...(oversizedTurns
        ? [
            {
              id: 'oversized-turns',
              title: 'Oversized turns',
              model: 'gpt-6-sol',
              messages: Array.from({ length: 3 }, (_, turn) => [
                message(
                  `large-prompt-${turn}`,
                  `Oversized request ${turn}`,
                  'user',
                ),
                {
                  ...message(`large-timer-${turn}`, '', 'system'),
                  blocks: [
                    {
                      type: 'turn_timer',
                      startedAt: 1788000000000,
                      completedAt: 1788000001000,
                    },
                  ],
                },
                ...Array.from({ length: 1250 }, (_, index) => ({
                  ...message(`large-${turn}-${index}`, ''),
                  blocks:
                    index % 5 === 0
                      ? [
                          {
                            type: 'text',
                            text: `Progress ${turn}/${index}: retained history evidence`,
                          },
                        ]
                      : [
                          {
                            type: 'tool_use',
                            toolUseId: `read-${turn}-${index}`,
                            toolName: 'Read',
                            input: '{"file_path":"fixture.ts"}',
                          },
                          {
                            type: 'tool_result',
                            toolUseId: `read-${turn}-${index}`,
                            toolName: 'Read',
                            output: `Evidence ${turn}/${index}`,
                            isError: false,
                          },
                        ],
                })),
                message(
                  `large-final-${turn}`,
                  `Final report for oversized turn ${turn}. ` +
                    'The transcript preserves evidence, ordering, and completed state. '.repeat(
                      20,
                    ),
                ),
              ]).flat(),
            },
          ]
        : []),
      ...(pagedTurns
        ? [
            {
              id: 'paged-turns',
              title: 'Many turns',
              model: 'gpt-6-sol',
              messages: Array.from({ length: 550 }, (_, index) => [
                message(
                  `prompt-${index}`,
                  `Historical prompt ${index}`,
                  'user',
                  { userMessageSource: 'human' },
                ),
                message(`body-${index}`, `Historical answer ${index}`),
                {
                  ...message(`timer-${index}`, '', 'system'),
                  blocks: [{ type: 'turn_timer', completedAt: 1788000001000 }],
                },
              ]).flat(),
            },
          ]
        : []),
      {
        id: 'lean',
        title: 'Lean sibling',
        model: 'gpt-6-sol',
        messages: [message('lean-reply', 'Lean sibling remains independent.')],
      },
    ],
  });
  return { userDataDir, messages };
}
