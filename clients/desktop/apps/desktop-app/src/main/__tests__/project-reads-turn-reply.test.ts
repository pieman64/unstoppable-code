jest.mock('../project-discovery/reads/binding', () => ({
  resolveReadBinding: jest.fn(),
}));
jest.mock('../project-discovery/bots/target', () => ({
  resolveBotReadBinding: jest.fn(),
}));
jest.mock('../canopy-runtime/desktop-runtime', () => ({
  getActiveDesktopRuntime: (): {
    queryChatTranscriptPageForLegacyIpc: typeof mockQuery;
  } => ({ queryChatTranscriptPageForLegacyIpc: mockQuery }),
}));

import type { PersistedChatMessage } from '@canopy/agent-transcript';
import type {
  TranscriptPage,
  TranscriptTurnSummary,
} from '@canopy/agent-transcript/transcript-storage';
import type { CoreChatTranscriptPageParams } from '@canopy/protocol/canopy-core';
import { PROJECT_READ_MESSAGE_MAX_CHARS } from '@canopy/agent-actions/families/projects/actions';
import type { ProjectDiscoveryCaller } from '../project-discovery';
import { resolveBotReadBinding } from '../project-discovery/bots/target';
import type { ChatReadContext } from '../project-discovery/chat-target';
import { DiscoveryError } from '../project-discovery/errors';
import { resolveReadBinding } from '../project-discovery/reads/binding';
import { readTurnReply } from '../project-discovery/reads/turn-reply';

const mockQuery = jest.fn<
  Promise<{ legacyResult: TranscriptPage }>,
  [CoreChatTranscriptPageParams]
>();

const address = { projectId: 'proj-1', taskId: 'task-1', chatId: 'chat-1' };
const botAddress = {
  botId: 'app_advisor',
  taskId: 'entry-1',
  chatId: 'chat-1',
};
const pipelineCaller: ProjectDiscoveryCaller = {
  kind: 'pipeline',
  owner: { kind: 'personal' },
};
const scope = { workspaceId: 'proj-1', worktreeId: 'task-1', chatId: 'chat-1' };
// The reader only uses the scope; the binding resolver is mocked.
const context = { scope } as unknown as ChatReadContext;

const emptyCounts = Object.fromEntries(
  [
    'messages',
    'thinking',
    'bash',
    'read',
    'readLines',
    'writeEdit',
    'plan',
    'fileEdit',
    'fileAdd',
    'fileDelete',
    'search',
    'grep',
    'web',
    'agent',
    'workflow',
    'tasks',
    'taskStop',
    'skills',
    'monitor',
    'claude',
    'scheduleWakeup',
    'askUser',
    'scriptOutput',
    'watcher',
    'canopy',
    'graph',
    'appAdvisor',
    'pipelineEditor',
    'computerUse',
    'mcp',
    'other',
  ].map((key) => [key, 0]),
) as unknown as TranscriptTurnSummary['summary'];

interface FakeTurn {
  id: string;
  complete: boolean;
  messages: PersistedChatMessage[];
  finalMessageIds: string[];
}

function assistant(id: string, text: string): PersistedChatMessage {
  return {
    id,
    role: 'assistant',
    timestamp: 1_791_000_000_000,
    blocks: [{ type: 'text', text }],
  };
}

function user(id: string, text: string): PersistedChatMessage {
  return {
    id,
    role: 'user',
    timestamp: 1_791_000_000_000,
    blocks: [{ type: 'text', text }],
  };
}

let turns: FakeTurn[];
let revision: number;
let revisionAfterFirstPage: number | undefined;
let turnsPerPage: number;

/** Serves the core turn view over the in-memory turns, newest page first. */
function servePage(params: CoreChatTranscriptPageParams): TranscriptPage {
  const ordered: Array<{ turn: FakeTurn; start: number; end: number }> = [];
  let ordinal = 0;
  for (const turn of turns) {
    const start = ordinal;
    ordinal += turn.messages.length;
    ordered.push({ turn, start, end: ordinal });
  }
  const end = params.before ?? ordinal;
  const selected = ordered
    .filter((entry) => entry.start < end)
    .slice(-turnsPerPage);
  const first = selected[0];
  const page: TranscriptPage = {
    messages: selected.flatMap((entry) => entry.turn.messages),
    view: 'turns',
    turns: selected.map((entry) => ({
      id: entry.turn.id,
      start: entry.start,
      end: entry.end,
      complete: entry.turn.complete,
      summary: emptyCounts,
      finalMessageIds: entry.turn.finalMessageIds,
    })),
    totalMessages: ordinal,
    transcriptRevision: revision,
    ...(first && first.start > 0 ? { before: first.start } : {}),
  };
  if (revisionAfterFirstPage !== undefined) {
    revision = revisionAfterFirstPage;
    revisionAfterFirstPage = undefined;
  }
  return page;
}

function setFinalMessage(turnId: string, id: string, text: string): void {
  const turn = turns.find((candidate) => candidate.id === turnId);
  if (!turn) throw new Error(`no turn ${turnId}`);
  turn.messages = [
    turn.messages[0] ?? user(turnId, 'question'),
    assistant(id, text),
  ];
  turn.finalMessageIds = [id];
}

function transcriptRequests(): CoreChatTranscriptPageParams[] {
  return mockQuery.mock.calls.map(([params]) => params);
}

beforeEach(() => {
  revision = 7;
  revisionAfterFirstPage = undefined;
  turnsPerPage = 100;
  turns = [
    {
      id: 'turn-a',
      complete: true,
      messages: [
        user('turn-a', 'first question'),
        assistant('a-reply-1', 'first answer'),
        assistant('a-reply-2', 'second answer'),
      ],
      finalMessageIds: ['a-reply-1', 'a-reply-2'],
    },
    {
      id: 'turn-b',
      complete: true,
      messages: [
        user('turn-b', 'later question'),
        assistant('b-reply', 'later answer'),
      ],
      finalMessageIds: ['b-reply'],
    },
  ];
  mockQuery.mockReset();
  mockQuery.mockImplementation((params) =>
    Promise.resolve({ legacyResult: servePage(params) }),
  );
  jest.mocked(resolveReadBinding).mockReset();
  jest
    .mocked(resolveReadBinding)
    .mockResolvedValue({ binding: 'binding-1', context: context as never });
  jest.mocked(resolveBotReadBinding).mockReset();
  jest
    .mocked(resolveBotReadBinding)
    .mockResolvedValue({ binding: 'bot-binding-1', context: context as never });
});

describe('readTurnReply', () => {
  it('returns the watched turn reply even when a later turn already finished', async () => {
    await expect(
      readTurnReply(address, 'turn-a', pipelineCaller),
    ).resolves.toEqual({
      kind: 'reply',
      reply: {
        messageId: 'a-reply-2',
        text: 'second answer',
        truncated: false,
        fullText: 'second answer',
      },
    });
    expect(transcriptRequests()[0]).toMatchObject({ view: 'turns', scope });
    expect(resolveReadBinding).toHaveBeenCalledWith(
      { type: 'projects.get_last_agent_response', ...address },
      pipelineCaller,
    );
  });

  it('finds an older turn on a later turn-view page', async () => {
    turnsPerPage = 1;
    await expect(
      readTurnReply(address, 'turn-a', pipelineCaller),
    ).resolves.toMatchObject({
      kind: 'reply',
      reply: { messageId: 'a-reply-2' },
    });
    expect(transcriptRequests()[1]).toMatchObject({
      view: 'turns',
      before: 3,
      transcriptRevision: 7,
    });
  });

  it('skips a sticky context row older than the page window and reads the turn from its own page', async () => {
    // The newest page carries turn-a only as a sticky context row (it starts
    // before `page.before`), with a partial summary; its own page is complete.
    mockQuery.mockImplementation((params) => {
      const page = servePage(params);
      if (params.before !== undefined)
        return Promise.resolve({ legacyResult: page });
      return Promise.resolve({
        legacyResult: {
          ...page,
          before: 3,
          turns: [
            {
              id: 'turn-a',
              start: 0,
              end: 1,
              complete: false,
              summary: emptyCounts,
              finalMessageIds: [],
            },
            ...(page.turns ?? []).filter((turn) => turn.id !== 'turn-a'),
          ],
        },
      });
    });
    await expect(
      readTurnReply(address, 'turn-a', pipelineCaller),
    ).resolves.toMatchObject({
      kind: 'reply',
      reply: { messageId: 'a-reply-2' },
    });
  });

  it('caps text at 8,000 characters and keeps the full text', async () => {
    const long = 'x'.repeat(PROJECT_READ_MESSAGE_MAX_CHARS + 500);
    setFinalMessage('turn-a', 'a-reply-2', long);
    const read = await readTurnReply(address, 'turn-a', pipelineCaller);
    expect(read.kind === 'reply' && read.reply.text.length).toBe(
      PROJECT_READ_MESSAGE_MAX_CHARS,
    );
    expect(read.kind === 'reply' && read.reply.truncated).toBe(true);
    expect(read.kind === 'reply' && read.reply.fullText).toBe(long);
  });

  it('reports a turn without an assistant reply', async () => {
    const turn = turns[0];
    if (turn) {
      turn.messages = [user('turn-a', 'question')];
      turn.finalMessageIds = [];
    }
    await expect(
      readTurnReply(address, 'turn-a', pipelineCaller),
    ).resolves.toEqual({ kind: 'no_reply' });
  });

  it('reports a turn whose final messages are all non-assistant as no_reply', async () => {
    const turn = turns[0];
    if (turn) {
      turn.messages = [user('turn-a', 'question')];
      turn.finalMessageIds = ['turn-a'];
    }
    await expect(
      readTurnReply(address, 'turn-a', pipelineCaller),
    ).resolves.toEqual({ kind: 'no_reply' });
  });

  it('reports a turn the transcript has not completed yet', async () => {
    const turn = turns[0];
    if (turn) turn.complete = false;
    await expect(
      readTurnReply(address, 'turn-a', pipelineCaller),
    ).resolves.toEqual({ kind: 'not_settled' });
  });

  it('reports a turn the transcript does not hold at all as not_settled', async () => {
    await expect(
      readTurnReply(address, 'turn-missing', pipelineCaller),
    ).resolves.toEqual({ kind: 'not_settled' });
  });

  it('throws cursor_context_changed when the transcript revision moves during the read', async () => {
    revisionAfterFirstPage = 8;
    await expect(
      readTurnReply(address, 'turn-a', pipelineCaller),
    ).rejects.toMatchObject({ code: 'cursor_context_changed' });
  });

  it('throws cursor_context_changed when the read binding changes during the read', async () => {
    jest
      .mocked(resolveReadBinding)
      .mockResolvedValueOnce({
        binding: 'binding-1',
        context: context as never,
      })
      .mockResolvedValueOnce({
        binding: 'binding-2',
        context: context as never,
      });
    await expect(
      readTurnReply(address, 'turn-a', pipelineCaller),
    ).rejects.toMatchObject({ code: 'cursor_context_changed' });
  });

  it('refuses a cross-owner chat as not_found', async () => {
    jest
      .mocked(resolveReadBinding)
      .mockRejectedValueOnce(
        new DiscoveryError('not_found', 'Project was not found.'),
      );
    await expect(
      readTurnReply(address, 'turn-a', pipelineCaller),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('reads a bot chat through the bot binding', async () => {
    await expect(
      readTurnReply(botAddress, 'turn-b', pipelineCaller),
    ).resolves.toMatchObject({
      kind: 'reply',
      reply: { messageId: 'b-reply' },
    });
    expect(resolveBotReadBinding).toHaveBeenCalledWith(
      { type: 'bots.get_last_agent_response', ...botAddress },
      pipelineCaller,
    );
    expect(resolveReadBinding).not.toHaveBeenCalled();
  });
});
