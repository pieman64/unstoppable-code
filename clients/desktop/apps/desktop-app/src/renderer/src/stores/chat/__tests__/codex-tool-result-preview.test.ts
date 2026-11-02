import {
  applyCodexTranscriptEvent,
  createEmptyTranscriptReducerState,
} from '@canopy/agent-transcript';
import { applyTabEvent } from '../event-transforms';
import type { ChatTab } from '../types';

const text = 'x'.repeat(70_000);
const event = {
  type: 'item.completed',
  item: {
    id: 'mcp-1',
    type: 'mcp_tool_call',
    server: 'test',
    tool: 'large',
    arguments: {},
    status: 'completed',
    result: { content: [{ type: 'text', text }] },
    error: null,
  },
};

function toolOutput(messages: ChatTab['messages']): string | undefined {
  for (const message of messages)
    for (const block of message.blocks)
      if (block.type === 'tool_result') return block.output;
  return undefined;
}

describe('Codex tool results in the renderer live view', () => {
  it('keeps a bounded preview while the shared reducer keeps the full output', () => {
    const tab: ChatTab = {
      id: 'chat-1',
      title: 'Chat',
      messages: [],
      status: 'idle',
      error: null,
      createdAt: '2026-10-14T00:00:00.000Z',
      queuedMessages: [],
      planMode: false,
      proposalMode: 'optional',
      thinkingLevel: 'high',
      modelConfig: {
        thinkingLevel: 'high',
        speed: 'standard',
        fastMode: false,
      },
      fastModeExplicit: false,
    };
    const live = toolOutput(
      applyTabEvent(tab, { type: 'codex', event }).messages,
    );
    expect(live?.length).toBeLessThanOrEqual(65_536);
    expect(live?.endsWith('chars]')).toBe(true);

    const stored = toolOutput(
      applyCodexTranscriptEvent(createEmptyTranscriptReducerState(), event, {
        now: 1000,
        createMessageId: (): string => 'm',
        childToolLiveness: { kind: 'no-live-session' },
      }).messages,
    );
    expect(stored).toBe(text);
  });
});
