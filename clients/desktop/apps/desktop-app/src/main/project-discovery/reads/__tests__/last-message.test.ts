jest.mock('../transcript', () => ({
  RAW_PAGE_BUDGET: 20,
  turnLookup: jest.fn(),
}));
import type { PersistedChatMessage } from '@canopy/agent-transcript';
import type {
  TranscriptPage,
  TranscriptTurnSummary,
} from '@canopy/agent-transcript/transcript-storage';
import { finalVisibleAssistantMessage } from '../last-message';

const emptyCounts: TranscriptTurnSummary['summary'] = {
  messages: 0,
  thinking: 0,
  bash: 0,
  read: 0,
  readLines: 0,
  writeEdit: 0,
  plan: 0,
  fileEdit: 0,
  fileAdd: 0,
  fileDelete: 0,
  search: 0,
  grep: 0,
  web: 0,
  agent: 0,
  workflow: 0,
  tasks: 0,
  taskStop: 0,
  skills: 0,
  monitor: 0,
  claude: 0,
  scheduleWakeup: 0,
  askUser: 0,
  scriptOutput: 0,
  watcher: 0,
  canopy: 0,
  graph: 0,
  appAdvisor: 0,
  pipelineEditor: 0,
  computerUse: 0,
  mcp: 0,
  other: 0,
};

function message(
  id: string,
  text: string,
  extra: Partial<PersistedChatMessage> = {},
): PersistedChatMessage {
  return {
    id,
    role: 'assistant',
    timestamp: 1_791_000_000_000,
    blocks: [{ type: 'text', text }],
    ...extra,
  };
}
function fixture(
  messages: PersistedChatMessage[],
  finalMessageIds: string[],
): { page: TranscriptPage; turn: TranscriptTurnSummary } {
  return {
    page: {
      messages,
      totalMessages: messages.length,
      transcriptRevision: 1,
      view: 'turns',
      turnId: 'watched-input',
    },
    turn: {
      id: 'watched-input',
      start: 0,
      end: messages.length,
      complete: true,
      summary: emptyCounts,
      finalMessageIds,
    },
  };
}

describe('finalVisibleAssistantMessage shared turn selector', () => {
  test('returns final visible text from the bound turn, ignoring thinking, tools, children and a newer turn', () => {
    const { page, turn } = fixture(
      [
        message('earlier', 'earlier answer'),
        message('final', '', {
          blocks: [
            { type: 'thinking', text: 'private reasoning' },
            {
              type: 'tool_result',
              toolUseId: 'tool',
              toolName: 'Read',
              output: 'private tool output',
              isError: false,
            },
            { type: 'text', text: 'Bound final answer' },
          ],
        }),
        message('tools-only', '', {
          blocks: [{ type: 'thinking', text: 'private tail' }],
        }),
        message('child', 'private child', { parentToolUseId: 'tool' }),
        message('hidden', 'private hidden', { hidden: true }),
        message('newer-turn', 'unrelated newer answer'),
      ],
      ['final', 'tools-only', 'child', 'hidden'],
    );
    expect(finalVisibleAssistantMessage(page, turn)).toEqual({
      messageId: 'final',
      turnId: 'watched-input',
      role: 'assistant',
      timestamp: new Date(1_791_000_000_000).toISOString(),
      text: 'Bound final answer',
      truncated: false,
    });
  });
  test('returns no output rather than falling back to an earlier turn', () => {
    const { page, turn } = fixture(
      [
        message('old', 'earlier answer'),
        message('thinking', '', {
          blocks: [{ type: 'thinking', text: 'private' }],
        }),
      ],
      ['thinking'],
    );
    expect(finalVisibleAssistantMessage(page, turn)).toBeUndefined();
  });
  test('treats an omitted final row as a failed read, not no output', () => {
    const { page, turn } = fixture(
      [message('old', 'earlier answer')],
      ['missing'],
    );
    expect(() => finalVisibleAssistantMessage(page, turn)).toThrow(
      'Chat transcript could not be read.',
    );
  });
  test('uses shared visible projection truncation and marks it', () => {
    const { page, turn } = fixture(
      [message('final', 'x'.repeat(9000))],
      ['final'],
    );
    const result = finalVisibleAssistantMessage(page, turn);
    expect(result).toMatchObject({
      messageId: 'final',
      turnId: 'watched-input',
      truncated: true,
    });
    expect(result?.text.length).toBeLessThanOrEqual(8000);
  });
});
