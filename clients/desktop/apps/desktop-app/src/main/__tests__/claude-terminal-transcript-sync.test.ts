import { terminalPresentationPrompt } from '@canopy/desktop-shared/lib/terminal-presentation';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  ChatSendMessageRequest,
  ChatTabsFile,
} from '@canopy/desktop-shared/types';

const mockReadChatTabsFile = jest.fn<Promise<ChatTabsFile>, [string, string]>();
const mockWriteChatTabsFile = jest.fn<
  Promise<void>,
  [string, string, ChatTabsFile]
>();
const mockGetWorktreeAttachmentsDir = jest.fn(() =>
  path.join(runtimeDir, 'attachments'),
);
let runtimeDir = '';

jest.mock('../lib/chat-tabs-reader', () => ({
  readChatTabsFile: (
    projectId: string,
    worktreeId: string,
  ): Promise<ChatTabsFile> => mockReadChatTabsFile(projectId, worktreeId),
}));

jest.mock('../lib/chat-tabs', () => ({
  writeChatTabsFile: (
    projectId: string,
    worktreeId: string,
    data: ChatTabsFile,
  ): Promise<void> => mockWriteChatTabsFile(projectId, worktreeId, data),
}));

jest.mock('../lib/paths', () => ({
  getClaudeTerminalRuntimeDir: jest.fn(() => runtimeDir),
  getCoworkWorkspaceRootDir: jest.fn(() =>
    path.join(runtimeDir, 'standalone-home'),
  ),
  get getWorktreeAttachmentsDir(): typeof mockGetWorktreeAttachmentsDir {
    return mockGetWorktreeAttachmentsDir;
  },
}));

import { syncClaudeTerminalTranscript } from '../integration/claude-terminal-transcript-sync';
import type { TranscriptSyncRequest } from '../integration/claude-terminal-transcript-sync';
import { enqueueChatTabMutation } from '../lib/chat-tab-mutation-queue';
import { initClaudeModels } from '@canopy/desktop-shared/types';

const fsPromises = jest.requireActual<{
  readFile: typeof readFile;
  open: (filePath: string, flags: string) => Promise<FileHandle>;
  writeFile: typeof writeFile;
}>('node:fs/promises');

function parseJsonObject(raw: string): Record<string, unknown> {
  const value = JSON.parse(raw) as unknown;
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error('Expected JSON object.');
}

describe('claude-terminal-transcript-sync', () => {
  beforeEach(async () => {
    runtimeDir = await mkdtemp(
      path.join(os.tmpdir(), 'canopy-transcript-sync-'),
    );
    mockWriteChatTabsFile.mockReset();
    mockReadChatTabsFile.mockReset();
    mockGetWorktreeAttachmentsDir.mockClear();
    mockReadChatTabsFile.mockResolvedValue({
      version: 1,
      activeTabId: 'chat',
      tabs: [
        {
          id: 'chat',
          title: 'Chat',
          messages: [],
          createdAt: '2026-05-22T00:00:00.000Z',
        },
      ],
    });
  });

  afterEach(async () => {
    await rm(runtimeDir, { recursive: true, force: true });
  });

  beforeAll(() => {
    initClaudeModels([
      { id: 'sonnet', label: 'Sonnet 5' },
      { id: 'opus[1m]', label: 'Opus 5.5' },
      { id: 'claude-opus-4-8', label: 'Opus 4.8' },
    ]);
  });

  it('serializes its persisted transcript merge with other chat-tab mutations', async () => {
    const transcriptPath = path.join(runtimeDir, 'claude.jsonl');
    await writeFile(
      transcriptPath,
      `${JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-queued',
        message: { role: 'assistant', content: 'Queued reply' },
      })}\n`,
      'utf8',
    );
    let releaseMutation: (() => void) | undefined;
    const mutationBlocked = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    let persistedTabs: ChatTabsFile = {
      version: 1,
      activeTabId: 'chat',
      tabs: [
        {
          id: 'chat',
          title: 'Chat',
          messages: [],
          createdAt: '2026-05-22T00:00:00.000Z',
        },
      ],
    };
    mockReadChatTabsFile.mockImplementation(() =>
      Promise.resolve(persistedTabs),
    );
    let markWriteStarted: (() => void) | undefined;
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve;
    });
    mockWriteChatTabsFile.mockImplementationOnce(
      (_projectId, _worktreeId, data) => {
        markWriteStarted?.();
        persistedTabs = data;
        return Promise.resolve();
      },
    );
    const inFlightMutation = enqueueChatTabMutation('p', 'w', async () => {
      await mutationBlocked;
      persistedTabs = {
        ...persistedTabs,
        tabs: persistedTabs.tabs.map((tab) =>
          tab.id === 'chat'
            ? {
                ...tab,
                title: 'Renderer title',
                messages: [
                  {
                    id: 'host-message',
                    role: 'assistant',
                    timestamp: 1,
                    blocks: [{ type: 'text', text: 'Host reply' }],
                  },
                ],
              }
            : tab,
        ),
      };
    });

    try {
      const syncPromise = syncClaudeTerminalTranscript({
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'chat',
        sessionKey: 'session',
        sdkSessionId: 'sdk',
        transcriptPath,
        hookEventName: 'Stop',
        hookPayload: {},
      });
      await expect(
        Promise.race([
          writeStarted.then(() => 'write-started'),
          new Promise<string>((resolve) =>
            setTimeout(() => resolve('still-blocked'), 500),
          ),
        ]),
      ).resolves.toBe('still-blocked');

      releaseMutation?.();
      await inFlightMutation;
      await syncPromise;
      expect(mockWriteChatTabsFile).toHaveBeenCalledTimes(1);
      expect(persistedTabs.tabs[0]).toMatchObject({ title: 'Renderer title' });
      expect(
        persistedTabs.tabs[0]?.messages.map((message) => message.id),
      ).toEqual(['host-message', 'assistant-queued']);
    } finally {
      releaseMutation?.();
      await inFlightMutation;
    }
  });

  it.each([
    [true, false],
    [false, false],
    [true, true],
    [false, true],
  ])(
    'correlates trusted terminal imports without leaking the sender note (persist=%s, mixed=%s)',
    async (persistChatState, mixedAttachments) => {
      const sender = {
        kind: 'bot' as const,
        botId: 'app_advisor',
        taskId: 'origin-task',
        chatId: 'origin-chat',
      };
      const request: ChatSendMessageRequest = {
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'chat',
        userMessageId: 'accepted-agent',
        text: 'Visible original',
        ...(mixedAttachments
          ? {
              fileReferences: [
                {
                  displayPath: 'file.ts',
                  absolutePath: '/workspace/file.ts',
                  kind: 'file' as const,
                },
              ],
              attachmentPaths: ['/notes.pdf', '/shot.png', '/notes.pdf'],
            }
          : {}),
        agentSent: {
          sender,
          chatTitle: 'Captured origin',
          projectLabel: 'App Advisor',
        },
        agentSenderProvenance: {
          version: 1,
          sender,
          owner: { kind: 'none' },
          capturedAt: '2026-10-16T00:00:00.000Z',
          acceptedInputId: 'accepted-agent',
        },
        hiddenContext: {
          kind: 'agent-sender-context',
          text: '<system_instruction>Private sender facts</system_instruction>',
        },
      };
      const tabs: ChatTabsFile = {
        version: 1,
        activeTabId: 'chat',
        tabs: [
          {
            id: 'chat',
            title: 'Chat',
            createdAt: '2026-05-22T00:00:00.000Z',
            messages: [],
            inputDelivery: {
              version: 1,
              epoch: 0,
              rows: [
                {
                  id: request.userMessageId,
                  revision: 1,
                  createdAt: 1,
                  state: 'sending',
                  settingsKey: '',
                  text: request.text,
                  payload: request,
                  currentAttemptId: request.userMessageId,
                  attempts: [
                    {
                      id: request.userMessageId,
                      generation: 'managed-terminal',
                      provider: 'claude',
                      createdAt: 1,
                    },
                  ],
                },
              ],
            },
          },
        ],
      };
      mockReadChatTabsFile.mockResolvedValue(tabs);
      mockWriteChatTabsFile.mockImplementation(
        (_project, _worktree, updated) => {
          Object.assign(tabs, updated);
          return Promise.resolve();
        },
      );
      const transcriptPath = path.join(runtimeDir, 'claude.jsonl');
      await writeFile(
        transcriptPath,
        JSON.stringify({
          type: 'user',
          uuid: 'native-user-id',
          message: {
            role: 'user',
            content: [
              ...[
                {
                  type: 'text',
                  text: `${request.hiddenContext?.text}\n\n${request.text}${mixedAttachments ? '\n\n/workspace/file.ts\n/notes.pdf\n[Image #1]\n[Image: source: /shot.png]' : ''}`,
                },
              ],
              ...(mixedAttachments
                ? [
                    {
                      type: 'image',
                      source: {
                        type: 'base64',
                        media_type: 'image/png',
                        data: Buffer.from('inline-image').toString('base64'),
                      },
                    },
                  ]
                : []),
            ],
          },
        }) + '\n',
      );
      const input: TranscriptSyncRequest = {
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'chat',
        sessionKey: 'session',
        sdkSessionId: 'sdk',
        transcriptPath,
        hookEventName: 'Stop',
        hookPayload: {},
        persistChatState,
      };
      const result = await syncClaudeTerminalTranscript(input);
      expect(result.lifecycleMessages?.[0]?.id).toBe(request.userMessageId);
      expect(result.importedMessages).toEqual([
        expect.objectContaining({
          id: request.userMessageId,
          userMessageSource: 'agent',
          agentSent: request.agentSent,
          blocks: [
            ...(mixedAttachments
              ? [
                  {
                    type: 'file_references',
                    references: request.fileReferences,
                  },
                ]
              : []),
            { type: 'text', text: 'Visible original' },
          ],
        }),
      ]);
      if (mixedAttachments) {
        expect(result.importedMessages[0]?.attachmentPaths).toEqual(
          expect.arrayContaining(['/notes.pdf', '/shot.png']),
        );
        expect(result.importedMessages[0]?.attachmentPaths).toHaveLength(3);
        expect(new Set(result.importedMessages[0]?.attachmentPaths).size).toBe(
          3,
        );
      }
      if (persistChatState) {
        const timestampMatcher: unknown = expect.any(Number);
        expect(tabs.tabs[0]?.inputDelivery?.rows[0]).toMatchObject({
          state: 'picked-up',
          attempts: [
            expect.objectContaining({
              generation: 'managed-terminal',
              pickedUpAt: timestampMatcher,
            }),
          ],
        });
        expect(mockWriteChatTabsFile).toHaveBeenCalledTimes(1);
      }
      expect(JSON.stringify(result.importedMessages)).not.toContain(
        'Private sender facts',
      );
      expect(
        (await syncClaudeTerminalTranscript(input)).importedMessages,
      ).toEqual([]);
    },
  );

  it('imports Claude Code user prompts, assistant text/thinking, tool use/results, and result metadata idempotently', async () => {
    const transcriptPath = path.join(runtimeDir, 'claude.jsonl');
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: 'user',
          uuid: 'u1',
          message: { role: 'user', content: 'Build it' },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: '11111111-1111-4111-8111-111111111111',
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'Plan' },
              { type: 'text', text: 'Working' },
              {
                type: 'tool_use',
                id: 'tool-1',
                name: 'Bash',
                input: { command: 'npm test' },
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'user',
          uuid: '22222222-2222-4222-8222-222222222222',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tool-1',
                content: 'ok',
                is_error: false,
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'result',
          uuid: 'r1',
          subtype: 'success',
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      ].join('\n'),
      'utf8',
    );

    const result = await syncClaudeTerminalTranscript({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      sessionKey: 'session',
      sdkSessionId: 'sdk',
      transcriptPath,
      hookEventName: 'Stop',
      hookPayload: {},
    });

    expect(result.importedEventCount).toBe(4);
    expect(result.importedMessages).toHaveLength(4);
    expect(result.importedMessages[0]?.role).toBe('user');
    const assistantMessage = result.importedMessages.find(
      (message) => message.id === '11111111-1111-4111-8111-111111111111',
    );
    expect(assistantMessage?.role).toBe('assistant');
    expect(assistantMessage?.claudeUuid).toBe(
      '11111111-1111-4111-8111-111111111111',
    );
    expect(
      assistantMessage?.blocks.some(
        (block) => block.type === 'thinking' && block.text === 'Plan',
      ),
    ).toBe(true);
    expect(
      assistantMessage?.blocks.some(
        (block) => block.type === 'tool_use' && block.toolName === 'Bash',
      ),
    ).toBe(true);
    const toolResultMessage = result.importedMessages.find(
      (message) => message.id === '22222222-2222-4222-8222-222222222222',
    );
    expect(toolResultMessage?.claudeUuid).toBe(
      '22222222-2222-4222-8222-222222222222',
    );
    expect(toolResultMessage?.blocks[0]).toMatchObject({
      type: 'tool_result',
      toolUseId: 'tool-1',
      output: 'ok',
    });
    const timerMessage = result.importedMessages.find(
      (message) => message.id === 'r1',
    );
    const timerBlock = timerMessage?.blocks[0];
    expect(timerBlock?.type).toBe('turn_timer');
    if (timerBlock?.type !== 'turn_timer') {
      throw new Error('Expected result metadata to import as turn timer');
    }
    expect(typeof timerBlock.completedAt).toBe('number');
    expect(mockWriteChatTabsFile).toHaveBeenCalledWith(
      'p',
      'w',
      expect.objectContaining({
        tabs: [
          expect.objectContaining({
            messages: result.importedMessages,
          }),
        ],
      }),
    );

    mockWriteChatTabsFile.mockClear();
    mockReadChatTabsFile.mockResolvedValue({
      version: 1,
      activeTabId: 'chat',
      tabs: [
        {
          id: 'chat',
          title: 'Chat',
          messages: result.importedMessages,
          createdAt: '2026-05-22T00:00:00.000Z',
        },
      ],
    });
    await expect(
      syncClaudeTerminalTranscript({
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'chat',
        sessionKey: 'session',
        sdkSessionId: 'sdk',
        transcriptPath,
        hookEventName: 'Stop',
        hookPayload: {},
      }),
    ).resolves.toMatchObject({ importedEventCount: 0 });
  });

  it('imports Claude meta tool-injected text as a tool result instead of a user message', async () => {
    const transcriptPath = path.join(runtimeDir, 'claude.jsonl');
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: 'user',
          uuid: 'u1',
          message: { role: 'user', content: 'hi' },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'skill-use',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'toolu-skill',
                name: 'Skill',
                input: { skill: 'superpowers:using-superpowers' },
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'user',
          uuid: 'skill-launch',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu-skill',
                content: 'Launching skill: superpowers:using-superpowers',
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'user',
          uuid: 'skill-body',
          isMeta: true,
          sourceToolUseID: 'toolu-skill',
          message: {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Base directory for this skill: /plugins/superpowers\nEXTREMELY-IMPORTANT: follow these instructions.',
              },
            ],
          },
        }),
      ].join('\n'),
      'utf8',
    );

    const result = await syncClaudeTerminalTranscript({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      sessionKey: 'session',
      sdkSessionId: 'sdk',
      transcriptPath,
      hookEventName: 'Stop',
      hookPayload: {},
    });

    expect(result.importedEventCount).toBe(4);
    const injectedMessage = result.importedMessages.find(
      (message) => message.id === 'skill-body',
    );
    expect(injectedMessage?.role).toBe('system');
    const injectedBlock = injectedMessage?.blocks[0];
    expect(injectedBlock?.type).toBe('tool_result');
    if (injectedBlock?.type !== 'tool_result') {
      throw new Error(
        'Expected injected skill body to import as a tool result.',
      );
    }
    expect(injectedBlock.toolUseId).toBe('toolu-skill');
    expect(injectedBlock.isError).toBe(false);
    expect(injectedBlock.output).toContain('Base directory for this skill');
    expect(
      result.importedMessages.some(
        (message) =>
          message.role === 'user' &&
          message.blocks.some(
            (block) =>
              block.type === 'text' &&
              block.text.includes('Base directory for this skill'),
          ),
      ),
    ).toBe(false);
  });

  it('persists a captured terminal turn diff onto the imported user message', async () => {
    const transcriptPath = path.join(runtimeDir, 'claude.jsonl');
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: 'user',
          uuid: 'user-turn',
          message: { role: 'user', content: 'edit the app' },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'assistant-turn',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Done' }],
          },
        }),
      ].join('\n'),
      'utf8',
    );

    const turnDiff = {
      files: [
        {
          path: 'src/app.ts',
          status: 'modified' as const,
          insertions: 7,
          deletions: 2,
        },
      ],
      totalInsertions: 7,
      totalDeletions: 2,
      capturedAt: 456,
      treeRefs: [{ startTree: 'start-tree', endTree: 'end-tree' }],
    };

    const result = await syncClaudeTerminalTranscript({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      sessionKey: 'session',
      sdkSessionId: 'sdk',
      transcriptPath,
      hookEventName: 'Stop',
      hookPayload: {},
      turnDiff,
    });

    expect(result.turnDiffs).toEqual({ 'user-turn': turnDiff });
    expect(mockWriteChatTabsFile).toHaveBeenCalledWith(
      'p',
      'w',
      expect.objectContaining({
        tabs: [
          expect.objectContaining({
            id: 'chat',
            turnDiffs: { 'user-turn': turnDiff },
          }),
        ],
      }),
    );
  });

  it('skips Claude Code local command transcript events and synthetic no-response replies', async () => {
    const transcriptPath = path.join(runtimeDir, 'claude.jsonl');
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: 'user',
          uuid: 'local-caveat',
          isMeta: true,
          message: {
            role: 'user',
            content:
              '<local-command-caveat>Caveat: generated by a local command.</local-command-caveat>',
          },
        }),
        JSON.stringify({
          type: 'user',
          uuid: 'local-command',
          message: {
            role: 'user',
            content:
              '<command-name>/exit</command-name>\n<command-message>exit</command-message>\n<command-args></command-args>',
          },
        }),
        JSON.stringify({
          type: 'user',
          uuid: 'local-stdout',
          message: {
            role: 'user',
            content: '<local-command-stdout>Bye!</local-command-stdout>',
          },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'synthetic-no-response',
          message: {
            model: '<synthetic>',
            role: 'assistant',
            content: [{ type: 'text', text: 'No response requested.' }],
          },
        }),
      ].join('\n'),
      'utf8',
    );

    const result = await syncClaudeTerminalTranscript({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      sessionKey: 'session',
      sdkSessionId: 'sdk',
      transcriptPath,
      hookEventName: 'Stop',
      hookPayload: {},
    });

    expect(result.importedEventCount).toBe(0);
    expect(result.importedMessages).toEqual([]);
    expect(mockWriteChatTabsFile).not.toHaveBeenCalled();
    const cursor = parseJsonObject(
      await readFile(path.join(runtimeDir, 'transcript-cursor.json'), 'utf8'),
    );
    expect(cursor.importedEventIds).toEqual(
      expect.arrayContaining([
        'local-caveat',
        'local-command',
        'local-stdout',
        'synthetic-no-response',
      ]),
    );
  });

  it('skips Claude Code queue operations and imports turn_duration as a turn timer', async () => {
    const transcriptPath = path.join(runtimeDir, 'claude.jsonl');
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: 'queue-operation',
          operation: 'enqueue',
          uuid: 'queue-1',
          timestamp: '2026-06-02T14:11:46.515Z',
          content: 'what am i looking at now?',
        }),
        JSON.stringify({
          type: 'user',
          uuid: 'u1',
          timestamp: '2026-06-02T14:11:46.526Z',
          message: { role: 'user', content: 'what am i looking at now?' },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'a1',
          timestamp: '2026-06-02T14:11:51.163Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'Checking' },
              {
                type: 'tool_use',
                id: 'tool-1',
                name: 'mcp__canopy_app_advisor__GetCurrentUiState',
                input: {},
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'user',
          uuid: 'tr1',
          timestamp: '2026-06-02T14:11:51.225Z',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tool-1',
                content: 'state',
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'system',
          subtype: 'turn_duration',
          uuid: 'td1',
          timestamp: '2026-06-02T14:11:56.147Z',
          durationMs: 5578,
        }),
      ].join('\n'),
      'utf8',
    );

    const result = await syncClaudeTerminalTranscript({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      sessionKey: 'session',
      sdkSessionId: 'sdk',
      transcriptPath,
      hookEventName: 'Stop',
      hookPayload: {},
    });

    expect(result.importedEventCount).toBe(4);
    expect(result.importedMessages.map((message) => message.id)).toEqual([
      'u1',
      'a1',
      'tr1',
      'td1',
    ]);
    expect(result.importedMessages[3]?.blocks[0]).toMatchObject({
      type: 'turn_timer',
      completedAt: Date.parse('2026-06-02T14:11:56.147Z'),
    });
  });

  it('skips the API request records Claude Code 2.1.299+ writes beside the conversation', async () => {
    const transcriptPath = path.join(runtimeDir, 'claude.jsonl');
    const toolUse = {
      type: 'tool_use',
      id: 'tool-1',
      name: 'Read',
      input: { file_path: '/tmp/a' },
    };
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: 'user',
          uuid: 'u1',
          timestamp: '2026-10-26T14:11:46.526Z',
          message: { role: 'user', content: 'read a' },
        }),
        JSON.stringify({
          type: 'api-request-shape',
          sessionId: 'sdk',
          shapeHash: 'shape-1',
          timestamp: '2026-10-26T14:11:46.600Z',
          version: 1,
          shape: { system: [], tools: [] },
        }),
        JSON.stringify({
          type: 'api-request-blob',
          sessionId: 'sdk',
          hash: 'blob-user',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'read a' }],
          },
        }),
        JSON.stringify({
          type: 'api-request-blob',
          sessionId: 'sdk',
          hash: 'blob-system',
          message: {
            role: 'system',
            content: [{ type: 'text', text: 'context' }],
          },
        }),
        JSON.stringify({
          type: 'api-request',
          sessionId: 'sdk',
          id: 'request-1',
          timestamp: '2026-10-26T14:11:46.700Z',
          version: 1,
          querySource: 'repl_main_thread',
          shapeHash: 'shape-1',
          params: {},
          keep: ['blob-user', 'blob-system'],
          tail: [],
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'a1',
          timestamp: '2026-10-26T14:11:51.163Z',
          message: { role: 'assistant', content: [toolUse] },
        }),
        JSON.stringify({
          type: 'api-request-blob',
          sessionId: 'sdk',
          hash: 'blob-assistant',
          message: { role: 'assistant', content: [toolUse] },
        }),
        JSON.stringify({
          type: 'api-request-blob',
          sessionId: 'sdk',
          hash: 'blob-result',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'tool-1', content: 'a' },
            ],
          },
        }),
      ].join('\n'),
      'utf8',
    );

    const result = await syncClaudeTerminalTranscript({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      sessionKey: 'session',
      sdkSessionId: 'sdk',
      transcriptPath,
      hookEventName: 'Stop',
      hookPayload: {},
    });

    expect(result.importedMessages.map((message) => message.id)).toEqual([
      'u1',
      'a1',
    ]);
  });

  it('does not re-import a replayed Canopy-native transcript prefix with different Claude ids', async () => {
    const existingUser = {
      id: 'native-user',
      role: 'user' as const,
      timestamp: 10,
      blocks: [{ type: 'text' as const, text: 'hi' }],
    };
    const existingAssistant = {
      id: 'native-assistant',
      role: 'assistant' as const,
      timestamp: 20,
      blocks: [
        { type: 'text' as const, text: 'Hi! What would you like to work on?' },
      ],
    };
    const existingTimer = {
      id: 'native-timer',
      role: 'system' as const,
      timestamp: 30,
      blocks: [
        {
          type: 'turn_timer' as const,
          startedAt: 10,
          completedAt: 22,
        },
      ],
    };
    mockReadChatTabsFile.mockResolvedValue({
      version: 1,
      activeTabId: 'chat',
      tabs: [
        {
          id: 'chat',
          title: 'Chat',
          messages: [existingUser, existingAssistant, existingTimer],
          createdAt: '2026-05-22T00:00:00.000Z',
        },
      ],
    });

    const transcriptPath = path.join(runtimeDir, 'claude.jsonl');
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: 'user',
          uuid: 'claude-user',
          message: { role: 'user', content: 'hi' },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'claude-assistant',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Hi! What would you like to work on?' },
            ],
          },
        }),
        JSON.stringify({
          type: 'result',
          uuid: 'claude-result',
          subtype: 'success',
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'new-assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'New terminal response' }],
          },
        }),
      ].join('\n'),
      'utf8',
    );

    const result = await syncClaudeTerminalTranscript({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      sessionKey: 'session',
      sdkSessionId: 'sdk',
      transcriptPath,
      hookEventName: 'Stop',
      hookPayload: {},
    });

    expect(result).toMatchObject({
      importedEventCount: 1,
      replayedFromStart: true,
    });
    expect(result.importedMessages.map((message) => message.id)).toEqual([
      'new-assistant',
    ]);
    const writtenMessages =
      mockWriteChatTabsFile.mock.calls[0]?.[2].tabs[0]?.messages;
    expect(writtenMessages?.map((message) => message.id)).toEqual([
      'native-user',
      'native-assistant',
      'native-timer',
      'new-assistant',
    ]);
  });

  // CAN-3083 pinning test for the folded-in fingerprint/layout refactor.
  //
  // Main's `isTranscriptLayoutMessage` used to hand-maintain its own list and
  // was silently missing `claude_terminal_sync_warning`, so a sync-warning
  // message counted as conversation content, entered `comparableMessages`, and
  // broke the replayed-prefix match — re-importing the whole prefix. The
  // renderer's copy of the same predicate always treated it as layout, so the
  // two dedupers disagreed about exactly this one variant. Both now read the
  // shared `LAYOUT_BLOCK_TYPES` set, so this asserts main's side of that fix.
  it('treats a sync-warning-only message as layout when dropping a replayed prefix', async () => {
    const existingUser = {
      id: 'native-user',
      role: 'user' as const,
      timestamp: 10,
      blocks: [{ type: 'text' as const, text: 'hi' }],
    };
    const existingAssistant = {
      id: 'native-assistant',
      role: 'assistant' as const,
      timestamp: 20,
      blocks: [
        { type: 'text' as const, text: 'Hi! What would you like to work on?' },
      ],
    };
    const existingSyncWarning = {
      id: 'native-sync-warning',
      role: 'system' as const,
      timestamp: 25,
      blocks: [
        {
          type: 'claude_terminal_sync_warning' as const,
          timestamp: 25,
          message: 'Some terminal output could not be synced.',
        },
      ],
    };
    mockReadChatTabsFile.mockResolvedValue({
      version: 1,
      activeTabId: 'chat',
      tabs: [
        {
          id: 'chat',
          title: 'Chat',
          messages: [existingUser, existingAssistant, existingSyncWarning],
          createdAt: '2026-05-22T00:00:00.000Z',
        },
      ],
    });

    const transcriptPath = path.join(runtimeDir, 'claude.jsonl');
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: 'user',
          uuid: 'claude-user',
          message: { role: 'user', content: 'hi' },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'claude-assistant',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Hi! What would you like to work on?' },
            ],
          },
        }),
        JSON.stringify({
          type: 'result',
          uuid: 'claude-result',
          subtype: 'success',
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'new-assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'New terminal response' }],
          },
        }),
      ].join('\n'),
      'utf8',
    );

    const result = await syncClaudeTerminalTranscript({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      sessionKey: 'session',
      sdkSessionId: 'sdk',
      transcriptPath,
      hookEventName: 'Stop',
      hookPayload: {},
    });

    // The replayed user/assistant pair is recognised across the interleaved
    // sync warning, so only the genuinely new message is imported.
    expect(result.importedMessages.map((message) => message.id)).toEqual([
      'new-assistant',
    ]);
    const writtenMessages =
      mockWriteChatTabsFile.mock.calls[0]?.[2].tabs[0]?.messages;
    // The warning itself is untouched: excluding it from comparison must not
    // drop it from the transcript.
    expect(writtenMessages?.map((message) => message.id)).toEqual([
      'native-user',
      'native-assistant',
      'native-sync-warning',
      'new-assistant',
    ]);
  });

  it('appends terminal compaction blocks without accepting a hook-only transcript path', async () => {
    const result = await syncClaudeTerminalTranscript({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      sessionKey: 'session',
      sdkSessionId: 'sdk',
      hookEventName: 'PostCompact',
      hookPayload: {
        id: 'compact-1',
        transcript_path: '/untrusted/from/direct-sync.jsonl',
        trigger: 'manual',
        compact_summary: 'short summary',
      },
    });

    expect(result).toMatchObject({
      importedEventCount: 1,
      compactionAppended: true,
      transcriptPath: undefined,
    });
    const cursor = parseJsonObject(
      await readFile(path.join(runtimeDir, 'transcript-cursor.json'), 'utf8'),
    );
    expect(cursor.transcriptPath).toBeUndefined();
    expect(mockWriteChatTabsFile).toHaveBeenCalled();
    const compactionBlock =
      mockWriteChatTabsFile.mock.calls[0]?.[2].tabs[0]?.messages[0]?.blocks[0];
    expect(compactionBlock).toMatchObject({
      type: 'compaction_info',
      provider: 'claude',
      interfaceMode: 'claude-code',
      reason: 'manual',
      summary: 'short summary',
      sourceEventId: 'compact-1',
    });
  });

  it('keeps distinct PostCompact hooks without upstream event ids', async () => {
    const first = await syncClaudeTerminalTranscript({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      sessionKey: 'session',
      sdkSessionId: 'sdk',
      hookEventName: 'PostCompact',
      hookPayload: {
        trigger: 'auto',
        compact_summary: 'first summary',
      },
    });
    const second = await syncClaudeTerminalTranscript({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      sessionKey: 'session',
      sdkSessionId: 'sdk',
      hookEventName: 'PostCompact',
      hookPayload: {
        trigger: 'auto',
        compact_summary: 'second summary',
      },
    });
    const duplicate = await syncClaudeTerminalTranscript({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      sessionKey: 'session',
      sdkSessionId: 'sdk',
      hookEventName: 'PostCompact',
      hookPayload: {
        trigger: 'auto',
        compact_summary: 'second summary',
      },
    });

    expect(first.compactionAppended).toBe(true);
    expect(second.compactionAppended).toBe(true);
    expect(duplicate.compactionAppended).toBe(false);
  });

  it('rejects transcript paths outside Claude projects and the runtime dir', async () => {
    const transcriptPath = path.join(os.tmpdir(), 'outside-transcript.jsonl');
    await writeFile(
      transcriptPath,
      JSON.stringify({
        type: 'assistant',
        uuid: 'outside',
        message: { role: 'assistant', content: 'do not import' },
      }),
      'utf8',
    );
    try {
      const result = await syncClaudeTerminalTranscript({
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'chat',
        sessionKey: 'session',
        sdkSessionId: 'sdk',
        transcriptPath,
        hookEventName: 'Stop',
        hookPayload: {},
      });

      expect(result.importedEventCount).toBe(0);
      expect(result.transcriptPath).toBeUndefined();
      expect(result.errors).toEqual([
        'Rejected Claude terminal transcript path outside allowed roots.',
      ]);
      expect(mockWriteChatTabsFile).not.toHaveBeenCalled();
    } finally {
      await rm(transcriptPath, { force: true });
    }
  });

  it('imports transcript paths from the configured Claude projects directory', async () => {
    const claudeConfigDir = await mkdtemp(
      path.join(os.tmpdir(), 'canopy-claude-config-'),
    );
    const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const transcriptPath = path.join(
      claudeConfigDir,
      'projects',
      'configured-project',
      'configured-session.jsonl',
    );
    process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;

    try {
      await mkdir(path.dirname(transcriptPath), { recursive: true });
      await writeFile(
        transcriptPath,
        `${JSON.stringify({
          type: 'assistant',
          uuid: 'configured-assistant',
          message: { role: 'assistant', content: 'Configured reply' },
        })}\n`,
        'utf8',
      );

      const result = await syncClaudeTerminalTranscript({
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'chat',
        sessionKey: 'session',
        sdkSessionId: 'sdk',
        transcriptPath,
        hookEventName: 'Stop',
        hookPayload: {},
      });

      expect(result.importedEventCount).toBe(1);
      expect(result.transcriptPath).toBe(transcriptPath);
      expect(result.errors).toBeUndefined();
    } finally {
      if (originalClaudeConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
      }
      await rm(claudeConfigDir, { recursive: true, force: true });
    }
  });

  it('returns imported messages without advancing the cursor when the persisted tab is missing', async () => {
    mockReadChatTabsFile.mockResolvedValueOnce({
      version: 1,
      activeTabId: '',
      tabs: [],
    });
    const transcriptPath = path.join(runtimeDir, 'claude.jsonl');
    await writeFile(
      transcriptPath,
      `${JSON.stringify({
        type: 'assistant',
        uuid: 'a1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Done' }],
        },
      })}\n`,
      'utf8',
    );

    const result = await syncClaudeTerminalTranscript({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      sessionKey: 'session',
      sdkSessionId: 'sdk',
      transcriptPath,
      hookEventName: 'Stop',
      hookPayload: {},
    });

    expect(result.importedEventCount).toBe(1);
    expect(result.importedMessages).toEqual([
      expect.objectContaining({ id: 'a1', role: 'assistant' }),
    ]);
    expect(result.errors).toEqual([
      expect.stringContaining('chat tab was not present'),
    ]);
    expect(mockWriteChatTabsFile).not.toHaveBeenCalled();
    await expect(
      readFile(path.join(runtimeDir, 'transcript-cursor.json'), 'utf8'),
    ).rejects.toThrow();
  });

  it('reconciles from the beginning when the cursor advanced but the persisted tab is empty', async () => {
    const transcriptPath = path.join(runtimeDir, 'claude.jsonl');
    await writeFile(
      transcriptPath,
      `${JSON.stringify({
        type: 'user',
        uuid: 'u1',
        message: { role: 'user', content: 'Recover me' },
      })}\n`,
      'utf8',
    );

    await expect(
      syncClaudeTerminalTranscript({
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'chat',
        sessionKey: 'session',
        sdkSessionId: 'sdk',
        transcriptPath,
        hookEventName: 'Stop',
        hookPayload: {},
      }),
    ).resolves.toMatchObject({ importedEventCount: 1 });

    mockWriteChatTabsFile.mockClear();
    mockReadChatTabsFile.mockResolvedValue({
      version: 1,
      activeTabId: 'chat',
      tabs: [
        {
          id: 'chat',
          title: 'Chat',
          messages: [],
          createdAt: '2026-05-22T00:00:00.000Z',
        },
      ],
    });

    const recovered = await syncClaudeTerminalTranscript({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      sessionKey: 'session',
      sdkSessionId: 'sdk',
      transcriptPath,
      hookEventName: 'Stop',
      hookPayload: {},
    });

    expect(recovered.importedEventCount).toBe(1);
    expect(recovered.importedMessages[0]?.id).toBe('u1');
    expect(mockWriteChatTabsFile).toHaveBeenCalledWith(
      'p',
      'w',
      expect.objectContaining({
        tabs: [
          expect.objectContaining({
            messages: [expect.objectContaining({ id: 'u1' })],
          }),
        ],
      }),
    );
  });

  it('resets the offset when a same-path transcript identity changes', async () => {
    const transcriptPath = path.join(runtimeDir, 'claude.jsonl');
    const replacementLine = JSON.stringify({
      type: 'user',
      uuid: 'replacement-user',
      message: {
        role: 'user',
        content: 'Replacement file event that would be skipped without reset',
      },
    });
    await writeFile(transcriptPath, `${replacementLine}\n`, 'utf8');
    const currentStat = await stat(transcriptPath);
    await writeFile(
      path.join(runtimeDir, 'transcript-cursor.json'),
      JSON.stringify(
        {
          version: 1,
          transcriptPath,
          transcriptIdentity: {
            dev: currentStat.dev,
            ino: currentStat.ino + 1,
            mtimeMs: currentStat.mtimeMs,
            size: currentStat.size,
          },
          offset: Buffer.byteLength(`${replacementLine}\n`, 'utf8'),
          importedEventIds: ['previous-user'],
          updatedAt: Date.now(),
        },
        null,
        2,
      ),
      'utf8',
    );
    mockReadChatTabsFile.mockResolvedValue({
      version: 1,
      activeTabId: 'chat',
      tabs: [
        {
          id: 'chat',
          title: 'Chat',
          messages: [
            {
              id: 'previous-user',
              role: 'user',
              timestamp: 1,
              blocks: [{ type: 'text', text: 'Previous' }],
            },
          ],
          createdAt: '2026-05-22T00:00:00.000Z',
        },
      ],
    });

    await expect(
      syncClaudeTerminalTranscript({
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'chat',
        sessionKey: 'session',
        sdkSessionId: 'sdk',
        transcriptPath,
        hookEventName: 'Stop',
        hookPayload: {},
      }),
    ).resolves.toMatchObject({ importedEventCount: 1 });

    const replacementWrite = mockWriteChatTabsFile.mock.calls[0]?.[2];
    expect(
      replacementWrite?.tabs[0]?.messages.some(
        (message) =>
          message.id === 'replacement-user' && message.role === 'user',
      ),
    ).toBe(true);
    const cursor = parseJsonObject(
      await readFile(path.join(runtimeDir, 'transcript-cursor.json'), 'utf8'),
    );
    expect(cursor.importedEventIds).toEqual(
      expect.arrayContaining(['previous-user', 'replacement-user']),
    );
    expect(cursor.offset).toBe(
      Buffer.byteLength(`${replacementLine}\n`, 'utf8'),
    );
  });

  it('replays a same-size replacement at the transcript path', async () => {
    const transcriptPath = path.join(runtimeDir, 'claude.jsonl');
    const line = (uuid: string, content: string): string =>
      `${JSON.stringify({
        type: 'user',
        uuid,
        message: { role: 'user', content },
      })}\n`;
    const original = line('first-message', 'old content');
    const replacement = line('newer-message', 'new content');
    expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(original));
    await writeFile(transcriptPath, original);
    const first = await syncClaudeTerminalTranscript({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      sessionKey: 'session',
      sdkSessionId: 'sdk',
      transcriptPath,
      hookEventName: 'Stop',
      hookPayload: {},
    });
    mockReadChatTabsFile.mockResolvedValue({
      version: 1,
      activeTabId: 'chat',
      tabs: [
        {
          id: 'chat',
          title: 'Chat',
          messages: first.importedMessages,
          createdAt: '2026-05-22T00:00:00.000Z',
        },
      ],
    });
    const staged = path.join(runtimeDir, 'replacement.jsonl');
    await writeFile(staged, replacement);
    await rename(staged, transcriptPath);

    const second = await syncClaudeTerminalTranscript({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      sessionKey: 'session',
      sdkSessionId: 'sdk',
      transcriptPath,
      hookEventName: 'Stop',
      hookPayload: {},
    });

    expect(second.replayedFromStart).toBe(true);
    expect(second.importedMessages).toEqual([
      expect.objectContaining({ id: 'newer-message' }),
    ]);
  });

  it('replays a truncated transcript when the saved byte offset is past EOF', async () => {
    const transcriptPath = path.join(runtimeDir, 'claude.jsonl');
    const firstLine = JSON.stringify({
      type: 'user',
      uuid: 'long-first-message',
      message: { role: 'user', content: 'before '.repeat(100) },
    });
    await writeFile(transcriptPath, `${firstLine}\n`);
    const first = await syncClaudeTerminalTranscript({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      sessionKey: 'session',
      sdkSessionId: 'sdk',
      transcriptPath,
      hookEventName: 'Stop',
      hookPayload: {},
    });
    mockReadChatTabsFile.mockResolvedValue({
      version: 1,
      activeTabId: 'chat',
      tabs: [
        {
          id: 'chat',
          title: 'Chat',
          messages: first.importedMessages,
          createdAt: '2026-05-22T00:00:00.000Z',
        },
      ],
    });
    const replacement = JSON.stringify({
      type: 'user',
      uuid: 'short-new-message',
      message: { role: 'user', content: 'after' },
    });
    await writeFile(transcriptPath, `${replacement}\n`);

    const second = await syncClaudeTerminalTranscript({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      sessionKey: 'session',
      sdkSessionId: 'sdk',
      transcriptPath,
      hookEventName: 'Stop',
      hookPayload: {},
    });

    expect(second.replayedFromStart).toBe(true);
    expect(second.importedMessages).toEqual([
      expect.objectContaining({ id: 'short-new-message' }),
    ]);
  });

  it('replays a truncation that occurs after identity observation but before transcript reading', async () => {
    const transcriptPath = path.join(runtimeDir, 'claude.jsonl');
    const initial = `${JSON.stringify({
      type: 'user',
      uuid: 'long-raced-message',
      message: { role: 'user', content: 'before '.repeat(100) },
    })}\n`;
    await writeFile(transcriptPath, initial);
    const input = {
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      sessionKey: 'session',
      sdkSessionId: 'sdk',
      transcriptPath,
      hookEventName: 'Stop' as const,
      hookPayload: {},
    };
    const first = await syncClaudeTerminalTranscript(input);
    mockReadChatTabsFile.mockResolvedValue({
      version: 1,
      activeTabId: 'chat',
      tabs: [
        {
          id: 'chat',
          title: 'Chat',
          messages: first.importedMessages,
          createdAt: '2026-05-22T00:00:00.000Z',
        },
      ],
    });
    // Ensure the observed size extends beyond the saved cursor, so a
    // positioned range reader attempts a byte read after its fstat.
    await writeFile(
      transcriptPath,
      `${initial}${JSON.stringify({
        type: 'assistant',
        uuid: 'unread-appended-message',
        message: { role: 'assistant', content: 'before '.repeat(100) },
      })}\n`,
    );
    const replacement = `${JSON.stringify({
      type: 'user',
      uuid: 'short-raced-message',
      message: { role: 'user', content: 'after' },
    })}\n`;
    const originalReadFile = fsPromises.readFile;
    const originalOpen = fsPromises.open;
    const originalWriteFile = fsPromises.writeFile;
    let replaced = false;
    let openedTranscriptHandles = 0;
    let closedTranscriptHandles = 0;
    const replaceBeforeBytes = async (): Promise<void> => {
      if (replaced) return;
      replaced = true;
      // Rewrite through the same path/inode to isolate the size-observation
      // race from the separately covered rename/rotation path.
      await originalWriteFile(transcriptPath, replacement);
    };
    const readSpy = jest
      .spyOn(fsPromises, 'readFile')
      .mockImplementation(async (...args) => {
        if (args[0] === transcriptPath) await replaceBeforeBytes();
        return originalReadFile(...args);
      });
    const openSpy = jest
      .spyOn(fsPromises, 'open')
      .mockImplementation(async (...args) => {
        const handle = await originalOpen(...args);
        if (args[0] === transcriptPath) {
          openedTranscriptHandles += 1;
          const originalHandleRead = handle.read.bind(handle);
          const originalHandleClose = handle.close.bind(handle);
          jest.spyOn(handle, 'read').mockImplementation(async (...readArgs) => {
            await replaceBeforeBytes();
            return originalHandleRead(...readArgs);
          });
          handle.close = async (): Promise<void> => {
            try {
              await originalHandleClose();
            } finally {
              closedTranscriptHandles += 1;
            }
          };
        }
        return handle;
      });
    try {
      const second = await syncClaudeTerminalTranscript(input);
      expect(replaced).toBe(true);
      expect(second.replayedFromStart).toBe(true);
      expect(second.importedMessages).toEqual([
        expect.objectContaining({ id: 'short-raced-message' }),
      ]);
      const cursor = parseJsonObject(
        await readFile(path.join(runtimeDir, 'transcript-cursor.json'), 'utf8'),
      );
      expect(cursor.offset).toBe(Buffer.byteLength(replacement));
      expect(openedTranscriptHandles).toBe(closedTranscriptHandles);
    } finally {
      openSpy.mockRestore();
      readSpy.mockRestore();
    }
  });

  it('decodes an appended assistant record across a 64 KiB UTF-8 boundary', async () => {
    const transcriptPath = path.join(runtimeDir, 'claude.jsonl');
    await writeFile(
      transcriptPath,
      `${JSON.stringify({
        type: 'user',
        uuid: 'boundary-user',
        message: { role: 'user', content: 'Start' },
      })}\n`,
    );
    const input = {
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      sessionKey: 'session',
      sdkSessionId: 'sdk',
      transcriptPath,
      hookEventName: 'Stop' as const,
      hookPayload: {},
    };
    const first = await syncClaudeTerminalTranscript(input);
    mockReadChatTabsFile.mockResolvedValue({
      version: 1,
      activeTabId: 'chat',
      tabs: [
        {
          id: 'chat',
          title: 'Chat',
          messages: first.importedMessages,
          createdAt: '2026-05-22T00:00:00.000Z',
        },
      ],
    });

    const assistantLine = (padding: number): string =>
      `${JSON.stringify({
        type: 'assistant',
        uuid: 'boundary-assistant',
        message: {
          role: 'assistant',
          content: `${'x'.repeat(padding)}🚀 complete`,
        },
      })}\n`;
    const unpadded = assistantLine(0);
    const unpaddedEmojiAt = Buffer.byteLength(
      unpadded.slice(0, unpadded.indexOf('🚀')),
      'utf8',
    );
    const padding = 64 * 1024 - 2 - unpaddedEmojiAt;
    expect(padding).toBeGreaterThan(0);
    const appended = assistantLine(padding);
    expect(
      Buffer.byteLength(appended.slice(0, appended.indexOf('🚀')), 'utf8'),
    ).toBe(64 * 1024 - 2);
    expect(Buffer.byteLength(appended, 'utf8')).toBeGreaterThan(64 * 1024);
    await appendFile(transcriptPath, appended, 'utf8');

    const second = await syncClaudeTerminalTranscript(input);
    expect(second.importedMessages).toHaveLength(1);
    expect(second.importedMessages[0]).toMatchObject({
      id: 'boundary-assistant',
      blocks: [{ type: 'text', text: `${'x'.repeat(padding)}🚀 complete` }],
    });
    expect((await syncClaudeTerminalTranscript(input)).importedEventCount).toBe(
      0,
    );
  });

  it('efficiency: reads only the appended suffix after a persisted cursor', async () => {
    const transcriptPath = path.join(runtimeDir, 'claude.jsonl');
    await writeFile(
      transcriptPath,
      `${JSON.stringify({
        type: 'user',
        uuid: 'initial-user',
        message: { role: 'user', content: 'x'.repeat(1024 * 1024) },
      })}\n`,
    );
    const first = await syncClaudeTerminalTranscript({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      sessionKey: 'session',
      sdkSessionId: 'sdk',
      transcriptPath,
      hookEventName: 'Stop',
      hookPayload: {},
    });
    mockReadChatTabsFile.mockResolvedValue({
      version: 1,
      activeTabId: 'chat',
      tabs: [
        {
          id: 'chat',
          title: 'Chat',
          messages: first.importedMessages,
          createdAt: '2026-05-22T00:00:00.000Z',
        },
      ],
    });
    await writeFile(
      transcriptPath,
      `${await readFile(transcriptPath, 'utf8')}${JSON.stringify({
        type: 'assistant',
        uuid: 'suffix-assistant',
        message: { role: 'assistant', content: 'Done' },
      })}\n`,
    );
    const readSpy = jest.spyOn(fsPromises, 'readFile');
    try {
      const second = await syncClaudeTerminalTranscript({
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'chat',
        sessionKey: 'session',
        sdkSessionId: 'sdk',
        transcriptPath,
        hookEventName: 'Stop',
        hookPayload: {},
      });
      expect(second.importedMessages.map((message) => message.id)).toEqual([
        'suffix-assistant',
      ]);
      expect(
        readSpy.mock.calls.filter(([filePath]) => filePath === transcriptPath),
      ).toHaveLength(0);
    } finally {
      readSpy.mockRestore();
    }
  });

  it('worker cursor: does not reimport an unchanged event with chat persistence disabled', async () => {
    const transcriptPath = path.join(runtimeDir, 'claude.jsonl');
    await writeFile(
      transcriptPath,
      `${JSON.stringify({
        type: 'user',
        uuid: 'worker-user',
        message: { role: 'user', content: 'Worker task' },
      })}\n`,
    );
    const input = {
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      sessionKey: 'worker-session',
      sdkSessionId: 'sdk',
      transcriptPath,
      hookEventName: 'Stop' as const,
      hookPayload: {},
      persistChatState: false,
    };
    expect((await syncClaudeTerminalTranscript(input)).importedEventCount).toBe(
      1,
    );
    const repeated = await syncClaudeTerminalTranscript(input);
    expect(repeated.importedEventCount).toBe(0);
    expect(repeated.importedMessages).toEqual([]);
  });

  it('worker cursor: imports only new events after replacement and truncation', async () => {
    const transcriptPath = path.join(runtimeDir, 'claude.jsonl');
    const event = (id: string, content: string): string =>
      `${JSON.stringify({
        type: 'user',
        uuid: id,
        message: { role: 'user', content },
      })}\n`;
    const input = {
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      sessionKey: 'worker-session',
      sdkSessionId: 'sdk',
      transcriptPath,
      hookEventName: 'Stop' as const,
      hookPayload: {},
      persistChatState: false,
    };

    await writeFile(transcriptPath, event('worker-first', 'Before'), 'utf8');
    expect(
      (await syncClaudeTerminalTranscript(input)).importedMessages,
    ).toEqual([expect.objectContaining({ id: 'worker-first' })]);

    const replacementPath = path.join(runtimeDir, 'replacement.jsonl');
    await writeFile(
      replacementPath,
      event('worker-first', 'Before') + event('worker-second', 'After'),
      'utf8',
    );
    await rename(replacementPath, transcriptPath);
    const rotated = await syncClaudeTerminalTranscript(input);
    expect(rotated.replayedFromStart).toBe(true);
    expect(rotated.importedMessages.map((message) => message.id)).toEqual([
      'worker-second',
    ]);
    expect(rotated.importedEvents).toHaveLength(1);

    await writeFile(
      transcriptPath,
      event('worker-second', 'After') + event('worker-third', 'New'),
      'utf8',
    );
    const truncated = await syncClaudeTerminalTranscript(input);
    expect(truncated.replayedFromStart).toBe(true);
    expect(truncated.importedMessages.map((message) => message.id)).toEqual([
      'worker-third',
    ]);
    expect(truncated.importedEvents).toHaveLength(1);
    expect(
      (await syncClaudeTerminalTranscript(input)).importedMessages,
    ).toEqual([]);
  });

  it('worker cursor: retries a failed read without losing or duplicating an event', async () => {
    const transcriptPath = path.join(runtimeDir, 'claude.jsonl');
    await writeFile(
      transcriptPath,
      `${JSON.stringify({
        type: 'assistant',
        uuid: 'worker-retry',
        message: { role: 'assistant', content: 'Recovered answer' },
      })}\n`,
      'utf8',
    );
    const input = {
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      sessionKey: 'worker-session',
      sdkSessionId: 'sdk',
      transcriptPath,
      hookEventName: 'Stop' as const,
      hookPayload: {},
      persistChatState: false,
    };
    const openSpy = jest
      .spyOn(fsPromises, 'open')
      .mockRejectedValueOnce(new Error('transient transcript read failure'));
    try {
      const failed = await syncClaudeTerminalTranscript(input);
      expect(failed.transcriptReadComplete).toBe(false);
      expect(failed.importedMessages).toEqual([]);
      expect(failed.errors).toContain('transient transcript read failure');
    } finally {
      openSpy.mockRestore();
    }
    const recovered = await syncClaudeTerminalTranscript(input);
    expect(recovered.importedMessages.map((message) => message.id)).toEqual([
      'worker-retry',
    ]);
    const repeated = await syncClaudeTerminalTranscript(input);
    expect(repeated.importedMessages).toEqual([]);
    expect(repeated.importedEvents).toEqual([]);
  });

  it('worker cursor: retries an event after cursor persistence fails', async () => {
    const transcriptPath = path.join(runtimeDir, 'claude.jsonl');
    await writeFile(
      transcriptPath,
      `${JSON.stringify({
        type: 'user',
        uuid: 'worker-write-retry',
        message: { role: 'user', content: 'Retry after cursor write' },
      })}\n`,
      'utf8',
    );
    const input = {
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      sessionKey: 'worker-session',
      sdkSessionId: 'sdk',
      transcriptPath,
      hookEventName: 'Stop' as const,
      hookPayload: {},
      persistChatState: false,
    };
    const writeSpy = jest
      .spyOn(fsPromises, 'writeFile')
      .mockRejectedValueOnce(new Error('cursor write failed'));
    try {
      await expect(syncClaudeTerminalTranscript(input)).rejects.toThrow(
        'cursor write failed',
      );
    } finally {
      writeSpy.mockRestore();
    }
    const recovered = await syncClaudeTerminalTranscript(input);
    expect(recovered.importedMessages.map((message) => message.id)).toEqual([
      'worker-write-retry',
    ]);
    expect((await syncClaudeTerminalTranscript(input)).importedEvents).toEqual(
      [],
    );
  });

  it('worker cursor: records stage-labeled transcript open and read bytes', async () => {
    if (process.env.CANOPY_WORKER_CURSOR_IO_MEASURE !== '1') return;
    const stage = process.env.CANOPY_WORKER_CURSOR_IO_STAGE;
    if (stage !== 'before' && stage !== 'after') {
      throw new Error('Set CANOPY_WORKER_CURSOR_IO_STAGE=before or after');
    }
    const transcriptPath = path.join(runtimeDir, 'claude.jsonl');
    const cursorPath = path.join(runtimeDir, 'transcript-cursor.json');
    const firstLine = JSON.stringify({
      type: 'user',
      uuid: 'worker-io-0',
      message: { role: 'user', content: 'x'.repeat(1024 * 1024) },
    });
    const event = (index: number): string =>
      JSON.stringify({
        type: 'assistant',
        uuid: `worker-io-${index}`,
        message: { role: 'assistant', content: `Answer ${index}` },
      });
    const initialText = `${firstLine}\n${Array.from(
      { length: 500 },
      (_, index) => event(index + 1),
    ).join('\n')}\n`;
    await writeFile(transcriptPath, initialText, 'utf8');
    const input = {
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      sessionKey: 'worker-io',
      sdkSessionId: 'sdk',
      transcriptPath,
      hookEventName: 'Stop' as const,
      hookPayload: {},
      persistChatState: false,
    };
    const counters = {
      initial: { opens: 0, reads: 0, readBytes: 0 },
      unchanged: { opens: 0, reads: 0, readBytes: 0 },
      append: { opens: 0, reads: 0, readBytes: 0 },
      rotation: { opens: 0, reads: 0, readBytes: 0 },
    };
    let phase: keyof typeof counters = 'initial';
    const originalOpen = fsPromises.open;
    const openSpy = jest
      .spyOn(fsPromises, 'open')
      .mockImplementation(async (...args) => {
        const handle = await originalOpen(...args);
        if (args[0] !== transcriptPath) return handle;
        counters[phase].opens += 1;
        const originalRead = handle.read.bind(handle);
        Object.defineProperty(handle, 'read', {
          configurable: true,
          value: async (
            buffer: Buffer,
            offset: number,
            length: number,
            position: number,
          ) => {
            const result = await originalRead(buffer, offset, length, position);
            counters[phase].reads += 1;
            counters[phase].readBytes += result.bytesRead;
            return result;
          },
        });
        return handle;
      });
    const assertCursor = async (expectedBytes: number): Promise<void> => {
      const cursor = parseJsonObject(await readFile(cursorPath, 'utf8'));
      expect(cursor.offset).toBe(expectedBytes);
    };
    try {
      const initial = await syncClaudeTerminalTranscript(input);
      expect(initial.importedEventCount).toBe(501);
      await assertCursor(Buffer.byteLength(initialText, 'utf8'));

      phase = 'unchanged';
      const unchanged = await syncClaudeTerminalTranscript(input);
      expect(unchanged.importedEventCount).toBe(stage === 'before' ? 501 : 0);
      await assertCursor(Buffer.byteLength(initialText, 'utf8'));

      const appendedText = `${initialText}${event(501)}\n`;
      await writeFile(transcriptPath, appendedText, 'utf8');
      phase = 'append';
      const appended = await syncClaudeTerminalTranscript(input);
      expect(appended.importedEventCount).toBe(stage === 'before' ? 502 : 1);
      await assertCursor(Buffer.byteLength(appendedText, 'utf8'));

      const rotatedText = `${firstLine}\n${event(502)}\n`;
      const replacementPath = path.join(runtimeDir, 'replacement.jsonl');
      await writeFile(replacementPath, rotatedText, 'utf8');
      await rename(replacementPath, transcriptPath);
      phase = 'rotation';
      const rotated = await syncClaudeTerminalTranscript(input);
      expect(rotated.replayedFromStart).toBe(true);
      expect(rotated.importedEventCount).toBe(2);
      await assertCursor(Buffer.byteLength(rotatedText, 'utf8'));

      const outputDir = path.resolve(
        __dirname,
        '../../../../..',
        '.playwright/filesystem-io-improvements/phase-2-2026-09-24',
      );
      await mkdir(outputDir, { recursive: true });
      await writeFile(
        path.join(outputDir, `worker-cursor-io-${stage}.json`),
        `${JSON.stringify(
          {
            stage,
            source: 'worker persistChatState:false unit transcript path',
            initialBytes: Buffer.byteLength(initialText, 'utf8'),
            appendBytes: Buffer.byteLength(appendedText, 'utf8'),
            rotationBytes: Buffer.byteLength(rotatedText, 'utf8'),
            importedEventCounts: {
              initial: initial.importedEventCount,
              unchanged: unchanged.importedEventCount,
              append: appended.importedEventCount,
              rotation: rotated.importedEventCount,
            },
            counters,
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
    } finally {
      openSpy.mockRestore();
    }
  });

  it('resumes from UTF-8 byte offsets when prior transcript content is non-ASCII', async () => {
    const transcriptPath = path.join(runtimeDir, 'claude.jsonl');
    const firstLine = JSON.stringify({
      type: 'user',
      uuid: 'unicode-user',
      message: {
        role: 'user',
        content: 'First prompt with café and emoji 🚀',
      },
    });
    const secondLine = JSON.stringify({
      type: 'assistant',
      uuid: 'after-unicode-assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Second event' }],
      },
    });

    await writeFile(transcriptPath, `${firstLine}\n`, 'utf8');
    const firstResult = await syncClaudeTerminalTranscript({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      sessionKey: 'session',
      sdkSessionId: 'sdk',
      transcriptPath,
      hookEventName: 'Stop',
      hookPayload: {},
    });
    expect(firstResult.importedEventCount).toBe(1);

    mockWriteChatTabsFile.mockClear();
    mockReadChatTabsFile.mockResolvedValue({
      version: 1,
      activeTabId: 'chat',
      tabs: [
        {
          id: 'chat',
          title: 'Chat',
          messages: firstResult.importedMessages,
          createdAt: '2026-05-22T00:00:00.000Z',
        },
      ],
    });
    await writeFile(transcriptPath, `${firstLine}\n${secondLine}\n`, 'utf8');
    await expect(
      syncClaudeTerminalTranscript({
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'chat',
        sessionKey: 'session',
        sdkSessionId: 'sdk',
        transcriptPath,
        hookEventName: 'Stop',
        hookPayload: {},
      }),
    ).resolves.toMatchObject({ importedEventCount: 1 });

    const unicodeWrite = mockWriteChatTabsFile.mock.calls[0]?.[2];
    expect(
      unicodeWrite?.tabs[0]?.messages.some(
        (message) =>
          message.id === 'after-unicode-assistant' &&
          message.role === 'assistant',
      ),
    ).toBe(true);
  });

  it('leaves an incomplete trailing JSONL line unread for a later sync', async () => {
    const transcriptPath = path.join(runtimeDir, 'claude.jsonl');
    const firstLine = JSON.stringify({
      type: 'user',
      uuid: 'complete-user',
      message: { role: 'user', content: 'First prompt' },
    });
    const secondLine = JSON.stringify({
      type: 'assistant',
      uuid: 'completed-assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Recovered final response' }],
      },
    });

    await writeFile(
      transcriptPath,
      `${firstLine}\n${secondLine.slice(0, -2)}`,
      'utf8',
    );
    const firstResult = await syncClaudeTerminalTranscript({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      sessionKey: 'session',
      sdkSessionId: 'sdk',
      transcriptPath,
      hookEventName: 'Stop',
      hookPayload: {},
    });

    expect(firstResult.transcriptReadComplete).toBe(false);
    expect(firstResult.importedEventCount).toBe(1);
    expect(firstResult.importedMessages).toHaveLength(1);
    let cursor = parseJsonObject(
      await readFile(path.join(runtimeDir, 'transcript-cursor.json'), 'utf8'),
    );
    expect(cursor.offset).toBe(Buffer.byteLength(`${firstLine}\n`, 'utf8'));
    expect(cursor.importedEventIds).not.toContain('completed-assistant');

    mockWriteChatTabsFile.mockClear();
    mockReadChatTabsFile.mockResolvedValue({
      version: 1,
      activeTabId: 'chat',
      tabs: [
        {
          id: 'chat',
          title: 'Chat',
          messages: firstResult.importedMessages,
          createdAt: '2026-05-22T00:00:00.000Z',
        },
      ],
    });
    await writeFile(transcriptPath, `${firstLine}\n${secondLine}\n`, 'utf8');

    const secondResult = await syncClaudeTerminalTranscript({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      sessionKey: 'session',
      sdkSessionId: 'sdk',
      transcriptPath,
      hookEventName: 'Stop',
      hookPayload: {},
    });

    expect(secondResult.importedEventCount).toBe(1);
    expect(secondResult.transcriptReadComplete).toBe(true);
    expect(
      secondResult.lifecycleMessages?.map((message) => message.id),
    ).toEqual(['complete-user', 'completed-assistant']);
    expect(secondResult.importedMessages[0]?.id).toBe('completed-assistant');
    cursor = parseJsonObject(
      await readFile(path.join(runtimeDir, 'transcript-cursor.json'), 'utf8'),
    );
    expect(cursor.offset).toBe(
      Buffer.byteLength(`${firstLine}\n${secondLine}\n`, 'utf8'),
    );
    expect(cursor.importedEventIds).toEqual(
      expect.arrayContaining(['complete-user', 'completed-assistant']),
    );
  });

  it('keeps task notifications out of the visible transcript like Canopy-native chats do', async () => {
    const transcriptPath = path.join(runtimeDir, 'claude.jsonl');
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: 'user',
          uuid: 'n1',
          origin: { kind: 'task-notification' },
          message: {
            role: 'user',
            content:
              '<task-notification>\n<task-id>t-1</task-id>\n<status>completed</status>\n</task-notification>',
          },
        }),
        JSON.stringify({
          type: 'user',
          uuid: 'n2',
          message: {
            role: 'user',
            content: '<task_notification>legacy form</task_notification>',
          },
        }),
        JSON.stringify({
          type: 'user',
          uuid: 'real-user',
          message: { role: 'user', content: 'a real prompt' },
        }),
      ].join('\n'),
      'utf8',
    );

    const result = await syncClaudeTerminalTranscript({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      sessionKey: 'session',
      sdkSessionId: 'sdk',
      transcriptPath,
      hookEventName: 'Stop',
      hookPayload: {},
    });

    // Only the real user prompt is imported; the harness notifications are
    // dropped from the chat transcript...
    expect(result.importedMessages).toHaveLength(1);
    expect(result.importedMessages[0]).toMatchObject({
      id: 'real-user',
      role: 'user',
    });
    // ...but still reach the audit trail through the raw event stream.
    expect(
      result.importedEvents.filter(
        (event) =>
          typeof event === 'object' &&
          event !== null &&
          JSON.stringify(event).includes('task-notification'),
      ),
    ).toHaveLength(1);
    expect(result.importedEvents).toHaveLength(3);
  });

  it('keeps Claude Code user interruption markers out of the visible transcript', async () => {
    const transcriptPath = path.join(runtimeDir, 'claude.jsonl');
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: 'assistant',
          uuid: 'partial-assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'I started working on it.' }],
          },
        }),
        JSON.stringify({
          parentUuid: 'partial-assistant',
          type: 'user',
          uuid: 'interrupt-marker',
          interruptedMessageId: 'msg_012TyieNqKoycBh8A4RM8jc9',
          message: {
            role: 'user',
            content: [{ type: 'text', text: '[Request interrupted by user]' }],
          },
        }),
      ].join('\n'),
      'utf8',
    );

    const result = await syncClaudeTerminalTranscript({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      sessionKey: 'session',
      sdkSessionId: 'sdk',
      transcriptPath,
      hookEventName: 'SessionEnd',
      hookPayload: { source: 'renderer-escape' },
    });

    expect(result.importedMessages).toHaveLength(1);
    expect(result.importedMessages[0]).toMatchObject({
      id: 'partial-assistant',
      role: 'assistant',
    });
    expect(
      result.importedMessages.some(
        (message) =>
          message.role === 'user' &&
          JSON.stringify(message.blocks).includes('Request interrupted'),
      ),
    ).toBe(false);
    expect(result.importedEvents).toHaveLength(2);
    const cursor = parseJsonObject(
      await readFile(path.join(runtimeDir, 'transcript-cursor.json'), 'utf8'),
    );
    expect(cursor.importedEventIds).toEqual(
      expect.arrayContaining(['partial-assistant', 'interrupt-marker']),
    );
  });

  it('keeps deferred-tools reload continuations out of the visible transcript', async () => {
    const transcriptPath = path.join(runtimeDir, 'claude.jsonl');
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: 'user',
          uuid: 'reload-continuation',
          message: {
            role: 'user',
            content: [
              {
                type: 'text',
                text: '<system_instruction>Requested items now enabled, continue the interrupted request.</system_instruction>',
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'resumed-assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Continuing now.' }],
          },
        }),
      ].join('\n'),
      'utf8',
    );

    const result = await syncClaudeTerminalTranscript({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      sessionKey: 'session',
      sdkSessionId: 'sdk',
      transcriptPath,
      hookEventName: 'SessionEnd',
      hookPayload: {},
      suppressDeferredToolsReloadContinuation: true,
    });

    expect(result.importedMessages).toHaveLength(1);
    expect(result.importedMessages[0]).toMatchObject({
      id: 'resumed-assistant',
      role: 'assistant',
    });
    expect(JSON.stringify(result.importedMessages)).not.toContain(
      'system_instruction',
    );
    expect(result.importedEvents).toHaveLength(2);
  });

  it('imports user-authored text that resembles a deferred-tools reload continuation', async () => {
    const transcriptPath = path.join(runtimeDir, 'claude.jsonl');
    const continuationText =
      '<system_instruction>Requested items now enabled, continue the interrupted request.</system_instruction>';
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: 'user',
          uuid: 'user-authored-continuation',
          message: {
            role: 'user',
            content: [
              {
                type: 'text',
                text: continuationText,
              },
            ],
          },
        }),
      ].join('\n'),
      'utf8',
    );

    const result = await syncClaudeTerminalTranscript({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      sessionKey: 'session',
      sdkSessionId: 'sdk',
      transcriptPath,
      hookEventName: 'SessionEnd',
      hookPayload: { source: 'renderer-escape' },
    });

    expect(result.importedMessages).toHaveLength(1);
    expect(result.importedMessages[0]).toMatchObject({
      id: 'user-authored-continuation',
      role: 'user',
      blocks: [{ type: 'text', text: continuationText }],
    });
    expect(result.importedEvents).toHaveLength(1);
  });

  it('adds a fallback turn timer for interrupted turns when Claude writes no duration event', async () => {
    const transcriptPath = path.join(runtimeDir, 'claude.jsonl');
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: 'user',
          uuid: 'prompt',
          message: { role: 'user', content: 'what is the weather in sf?' },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'search',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_search',
                name: 'WebSearch',
                input: { query: 'current weather San Francisco June 2026' },
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'user',
          uuid: 'rejected-tool',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_search',
                content: "The user doesn't want to proceed with this tool use.",
                is_error: true,
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'user',
          uuid: 'interrupt-marker',
          interruptedMessageId: 'msg_01HHAY1ojQZg3hSJYbDG7KVN',
          message: {
            role: 'user',
            content: [
              {
                type: 'text',
                text: '[Request interrupted by user for tool use]',
              },
            ],
          },
        }),
      ].join('\n'),
      'utf8',
    );

    const result = await syncClaudeTerminalTranscript({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      sessionKey: 'session',
      sdkSessionId: 'sdk',
      transcriptPath,
      hookEventName: 'SessionEnd',
      hookPayload: { source: 'renderer-escape' },
      fallbackTurnTimer: {
        id: 'interrupted-timer',
        startedAt: 1_000,
        completedAt: 2_500,
      },
    });

    expect(result.importedMessages).toHaveLength(4);
    expect(result.importedMessages.map((message) => message.id)).toEqual([
      'prompt',
      'search',
      'rejected-tool',
      'interrupted-timer',
    ]);
    const fallbackTimerMessage =
      result.importedMessages[result.importedMessages.length - 1];
    expect(fallbackTimerMessage).toMatchObject({
      id: 'interrupted-timer',
      role: 'system',
      blocks: [{ type: 'turn_timer', startedAt: 1_000, completedAt: 2_500 }],
    });
    expect(JSON.stringify(result.importedMessages)).not.toContain(
      'Request interrupted',
    );
    expect(result.importedEvents).toHaveLength(4);
    expect(mockWriteChatTabsFile).toHaveBeenCalledWith(
      'p',
      'w',
      expect.any(Object),
    );
    const persistedTabs = mockWriteChatTabsFile.mock.calls[0]?.[2];
    const persistedChat = persistedTabs?.tabs.find((tab) => tab.id === 'chat');
    expect(
      persistedChat?.messages.some(
        (message) => message.id === 'interrupted-timer',
      ),
    ).toBe(true);
  });

  it('appends a fallback turn timer when the tab only has a prior-turn timer', async () => {
    const transcriptPath = path.join(runtimeDir, 'claude.jsonl');
    await writeFile(
      transcriptPath,
      JSON.stringify({
        type: 'assistant',
        uuid: 'partial-assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'I started working on it.' }],
        },
      }),
      'utf8',
    );
    mockReadChatTabsFile.mockResolvedValueOnce({
      version: 1,
      activeTabId: 'chat',
      tabs: [
        {
          id: 'chat',
          title: 'Chat',
          messages: [
            {
              id: 'existing-timer',
              role: 'system',
              timestamp: 1_500,
              blocks: [
                { type: 'turn_timer', startedAt: 1_000, completedAt: 1_500 },
              ],
            },
          ],
          createdAt: '2026-05-22T00:00:00.000Z',
        },
      ],
    });

    const result = await syncClaudeTerminalTranscript({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      sessionKey: 'session',
      sdkSessionId: 'sdk',
      transcriptPath,
      hookEventName: 'SessionEnd',
      hookPayload: { source: 'renderer-escape' },
      fallbackTurnTimer: {
        id: 'interrupted-timer',
        startedAt: 1_000,
        completedAt: 2_500,
      },
    });

    expect(result.importedMessages.map((message) => message.id)).toEqual([
      'partial-assistant',
      'interrupted-timer',
    ]);
    const persistedTabs = mockWriteChatTabsFile.mock.calls[0]?.[2];
    const persistedChat = persistedTabs?.tabs.find((tab) => tab.id === 'chat');
    const timerBlocks = persistedChat?.messages.flatMap((message) =>
      message.blocks.filter((block) => block.type === 'turn_timer'),
    );
    expect(timerBlocks).toHaveLength(2);
  });

  it('does not append a fallback turn timer when the exact fallback already exists', async () => {
    const transcriptPath = path.join(runtimeDir, 'claude.jsonl');
    await writeFile(
      transcriptPath,
      JSON.stringify({
        type: 'assistant',
        uuid: 'partial-assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'I started working on it.' }],
        },
      }),
      'utf8',
    );
    mockReadChatTabsFile.mockResolvedValueOnce({
      version: 1,
      activeTabId: 'chat',
      tabs: [
        {
          id: 'chat',
          title: 'Chat',
          messages: [
            {
              id: 'interrupted-timer',
              role: 'system',
              timestamp: 2_500,
              blocks: [
                { type: 'turn_timer', startedAt: 1_000, completedAt: 2_500 },
              ],
            },
          ],
          createdAt: '2026-05-22T00:00:00.000Z',
        },
      ],
    });

    const result = await syncClaudeTerminalTranscript({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      sessionKey: 'session',
      sdkSessionId: 'sdk',
      transcriptPath,
      hookEventName: 'SessionEnd',
      hookPayload: { source: 'renderer-escape' },
      fallbackTurnTimer: {
        id: 'interrupted-timer',
        startedAt: 1_000,
        completedAt: 2_500,
      },
    });

    expect(result.importedMessages.map((message) => message.id)).toEqual([
      'partial-assistant',
    ]);
    const persistedTabs = mockWriteChatTabsFile.mock.calls[0]?.[2];
    const persistedChat = persistedTabs?.tabs.find((tab) => tab.id === 'chat');
    const timerBlocks = persistedChat?.messages.flatMap((message) =>
      message.blocks.filter((block) => block.type === 'turn_timer'),
    );
    expect(timerBlocks).toHaveLength(1);
  });

  it('surfaces /model changes as system notes while dropping other local-command chatter', async () => {
    const transcriptPath = path.join(runtimeDir, 'claude.jsonl');
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: 'user',
          uuid: 'cmd1',
          message: {
            role: 'user',
            content:
              '<command-name>/model</command-name><command-args>claude-sonnet-4-6</command-args>',
          },
        }),
        JSON.stringify({
          type: 'user',
          uuid: 'cmd2',
          message: {
            role: 'user',
            content:
              '<local-command-stdout>Set model to \u001b[1mclaude-sonnet-4-6\u001b[22m</local-command-stdout>',
          },
        }),
        JSON.stringify({
          type: 'user',
          uuid: 'cmd3',
          message: {
            role: 'user',
            content: '<local-command-stdout>Bye!</local-command-stdout>',
          },
        }),
      ].join('\n'),
      'utf8',
    );

    const result = await syncClaudeTerminalTranscript({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      sessionKey: 'session',
      sdkSessionId: 'sdk',
      transcriptPath,
      hookEventName: 'Stop',
      hookPayload: {},
    });

    expect(result.importedMessages).toHaveLength(1);
    expect(result.importedMessages[0]).toMatchObject({
      role: 'system',
      blocks: [{ type: 'text', text: 'Set model to claude-sonnet-4-6' }],
    });
  });

  it('syncs terminal-initiated model and permission-mode changes into the tab', async () => {
    const transcriptPath = path.join(runtimeDir, 'claude.jsonl');
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: 'user',
          uuid: 'model1',
          message: {
            role: 'user',
            content:
              '<local-command-stdout>Set model to \u001b[1mSonnet 5\u001b[22m and saved as your default for new sessions</local-command-stdout>',
          },
        }),
        JSON.stringify({
          type: 'permission-mode',
          uuid: 'perm1',
          permissionMode: 'plan',
          sessionId: 'sdk',
        }),
      ]
        .map((line) => `${line}\n`)
        .join(''),
      'utf8',
    );

    const result = await syncClaudeTerminalTranscript({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      sessionKey: 'session',
      sdkSessionId: 'sdk',
      transcriptPath,
      hookEventName: 'Stop',
      hookPayload: {},
    });

    expect(result.settingsSync).toEqual({
      model: 'sonnet',
      planMode: true,
    });
    const writeCalls = mockWriteChatTabsFile.mock.calls;
    const writtenTabs = writeCalls[writeCalls.length - 1]?.[2];
    expect(writtenTabs?.tabs[0]).toMatchObject({
      id: 'chat',
      model: 'sonnet',
      planMode: true,
    });
  });

  it('syncs a terminal model change whose label carries the TUI context-window suffix', async () => {
    // CAN-2701: Canopy's label is "Opus 5.5"; the Claude Code TUI still prints
    // "Set model to Opus 5.5 1M". The switch must still reach the tab.
    const transcriptPath = path.join(runtimeDir, 'claude.jsonl');
    await writeFile(
      transcriptPath,
      `${JSON.stringify({
        type: 'user',
        uuid: 'model-suffix',
        message: {
          role: 'user',
          content:
            '<local-command-stdout>Set model to \u001b[1mOpus 5.5 1M\u001b[22m</local-command-stdout>',
        },
      })}\n`,
      'utf8',
    );

    const result = await syncClaudeTerminalTranscript({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      sessionKey: 'session',
      sdkSessionId: 'sdk',
      transcriptPath,
      hookEventName: 'Stop',
      hookPayload: {},
    });

    expect(result.settingsSync).toMatchObject({ model: 'opus[1m]' });
  });

  it('does not report settings sync when replayed entries match the tab state', async () => {
    mockReadChatTabsFile.mockResolvedValue({
      version: 1,
      activeTabId: 'chat',
      tabs: [
        {
          id: 'chat',
          title: 'Chat',
          messages: [],
          createdAt: '2026-05-22T00:00:00.000Z',
          model: 'claude-sonnet-4-6',
          planMode: false,
        },
      ],
    });
    const transcriptPath = path.join(runtimeDir, 'claude.jsonl');
    await writeFile(
      transcriptPath,
      `${JSON.stringify({
        type: 'permission-mode',
        uuid: 'perm1',
        permissionMode: 'bypassPermissions',
        sessionId: 'sdk',
      })}\n`,
      'utf8',
    );

    const result = await syncClaudeTerminalTranscript({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      sessionKey: 'session',
      sdkSessionId: 'sdk',
      transcriptPath,
      hookEventName: 'Stop',
      hookPayload: {},
    });

    expect(result.settingsSync).toBeUndefined();
    expect(mockWriteChatTabsFile).not.toHaveBeenCalled();
  });

  it('persists inline image attachments to disk and strips base64 payloads', async () => {
    const transcriptPath = path.join(runtimeDir, 'claude.jsonl');
    const imageData = Buffer.from('fake-png-bytes').toString('base64');
    await writeFile(
      transcriptPath,
      `${JSON.stringify({
        type: 'user',
        uuid: 'img1',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '[Image #1]what is this?' },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: imageData,
              },
            },
          ],
        },
      })}\n`,
      'utf8',
    );

    const result = await syncClaudeTerminalTranscript({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      sessionKey: 'session',
      sdkSessionId: 'sdk',
      transcriptPath,
      hookEventName: 'Stop',
      hookPayload: {},
    });

    expect(result.importedMessages).toHaveLength(1);
    expect(mockGetWorktreeAttachmentsDir).toHaveBeenCalledWith('p', 'w');
    const message = result.importedMessages[0];
    // The TUI's `[Image #N]` composer marker is stripped — the bubble shows
    // only the user's own words, with the image as an attachment pill.
    expect(message).toMatchObject({
      role: 'user',
      blocks: [{ type: 'text', text: 'what is this?' }],
    });
    const attachmentPath = message?.attachmentPaths?.[0];
    expect(attachmentPath).toMatch(/claude-terminal-[0-9a-f]{16}\.png$/);
    if (!attachmentPath) {
      throw new Error('Expected an attachment path');
    }
    const written = await readFile(attachmentPath);
    expect(written.toString('utf8')).toBe('fake-png-bytes');
    // Neither the message blocks nor the raw events fed to the audit trail
    // carry the base64 payload.
    expect(JSON.stringify(result.importedMessages)).not.toContain(imageData);
    expect(JSON.stringify(result.importedEvents)).not.toContain(imageData);
  });

  it('sanitizes TUI attachment artifacts out of imported user prompts', async () => {
    const transcriptPath = path.join(runtimeDir, 'claude.jsonl');
    const imageData = Buffer.from('fake-png-bytes').toString('base64');
    await writeFile(
      transcriptPath,
      [
        // Legacy Canopy send format: marker + "Attached context paths" block.
        JSON.stringify({
          type: 'user',
          uuid: 'legacy1',
          message: {
            role: 'user',
            content: [
              {
                type: 'text',
                text: terminalPresentationPrompt(
                  '[Image #1]what is this?\nAttached context paths:\n-',
                  'scheduled-turn',
                ),
              },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: imageData,
                },
              },
            ],
          },
        }),
        // Claude's image source reference line — pure artifact, hidden.
        JSON.stringify({
          type: 'user',
          uuid: 'src1',
          message: {
            role: 'user',
            content: '[Image: source: /Users/me/attachments/snapper.png]',
          },
        }),
        // Attachment-only send: empty sanitized text still keeps the bubble
        // so the attachment pill has a home.
        JSON.stringify({
          type: 'user',
          uuid: 'imgonly1',
          message: {
            role: 'user',
            content: [
              { type: 'text', text: '[Image #1]' },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: imageData,
                },
              },
            ],
          },
        }),
      ]
        .map((line) => `${line}\n`)
        .join(''),
      'utf8',
    );

    const result = await syncClaudeTerminalTranscript({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      sessionKey: 'session',
      sdkSessionId: 'sdk',
      transcriptPath,
      hookEventName: 'Stop',
      hookPayload: {},
    });

    expect(result.importedMessages).toHaveLength(2);
    expect(result.importedMessages[0]).toMatchObject({
      role: 'user',
      blocks: [{ type: 'text', text: 'what is this?' }],
    });
    expect(result.importedMessages[0]?.attachmentPaths).toHaveLength(1);
    expect(result.importedMessages[1]).toMatchObject({
      role: 'user',
      blocks: [{ type: 'text', text: '' }],
    });
    expect(result.importedMessages[1]?.attachmentPaths).toHaveLength(1);
  });

  it('derives turn-timer startedAt from turn durations so completed timers show elapsed time', async () => {
    const transcriptPath = path.join(runtimeDir, 'claude.jsonl');
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: 'system',
          subtype: 'turn_duration',
          uuid: 'td1',
          durationMs: 7714,
          timestamp: '2026-06-09T13:05:26.386Z',
        }),
        JSON.stringify({
          type: 'result',
          uuid: 'r1',
          subtype: 'success',
          duration_ms: 4200,
          timestamp: '2026-06-09T13:06:00.000Z',
        }),
      ].join('\n'),
      'utf8',
    );

    const result = await syncClaudeTerminalTranscript({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      sessionKey: 'session',
      sdkSessionId: 'sdk',
      transcriptPath,
      hookEventName: 'Stop',
      hookPayload: {},
    });

    const durationTimer = result.importedMessages.find(
      (message) => message.id === 'td1',
    )?.blocks[0];
    expect(durationTimer?.type).toBe('turn_timer');
    if (durationTimer?.type !== 'turn_timer') {
      throw new Error('Expected a turn timer block');
    }
    expect(durationTimer.completedAt).toBe(
      Date.parse('2026-06-09T13:05:26.386Z'),
    );
    expect(durationTimer.startedAt).toBe(
      Date.parse('2026-06-09T13:05:26.386Z') - 7714,
    );

    const resultTimer = result.importedMessages.find(
      (message) => message.id === 'r1',
    )?.blocks[0];
    expect(resultTimer?.type).toBe('turn_timer');
    if (resultTimer?.type !== 'turn_timer') {
      throw new Error('Expected a turn timer block');
    }
    expect(resultTimer.startedAt).toBe(
      Date.parse('2026-06-09T13:06:00.000Z') - 4200,
    );
  });

  it('returns raw imported events for observability consumers', async () => {
    const transcriptPath = path.join(runtimeDir, 'claude.jsonl');
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: 'user',
          uuid: 'u1',
          message: { role: 'user', content: 'hello' },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'a1',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: 'hi\n<memory_citation files="topics/x.md"/>',
              },
            ],
            usage: { input_tokens: 3, output_tokens: 2 },
          },
        }),
      ].join('\n'),
      'utf8',
    );

    const result = await syncClaudeTerminalTranscript({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      sessionKey: 'session',
      sdkSessionId: 'sdk',
      transcriptPath,
      hookEventName: 'Stop',
      hookPayload: {},
    });

    expect(result.importedEvents).toHaveLength(2);
    expect(result.importedEvents[0]).toMatchObject({ type: 'user' });
    expect(result.importedEvents[1]).toMatchObject({ type: 'assistant' });
    expect(JSON.stringify(result.importedEvents[1])).toContain(
      'memory_citation',
    );
    expect(result.importedMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          blocks: [{ type: 'text', text: 'hi' }],
        }),
      ]),
    );
  });

  it('strips citations from flat text-field events and drops citation-only ones', async () => {
    const transcriptPath = path.join(runtimeDir, 'claude.jsonl');
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: 'text',
          uuid: 'flat-citation-only',
          text: '<memory_citation files="topics/x.md"/>',
        }),
        JSON.stringify({
          type: 'text',
          uuid: 'flat-mixed',
          text: 'Visible answer.\n<memory_citation files="topics/x.md"/>',
        }),
      ].join('\n'),
      'utf8',
    );

    const result = await syncClaudeTerminalTranscript({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
      sessionKey: 'session',
      sdkSessionId: 'sdk',
      transcriptPath,
      hookEventName: 'Stop',
      hookPayload: {},
    });

    expect(
      result.importedMessages.find(
        (message) => message.id === 'flat-citation-only',
      ),
    ).toBeUndefined();
    const mixed = result.importedMessages.find(
      (message) => message.id === 'flat-mixed',
    );
    expect(mixed?.role).toBe('assistant');
    expect(mixed?.blocks).toEqual([{ type: 'text', text: 'Visible answer.' }]);
  });
});
