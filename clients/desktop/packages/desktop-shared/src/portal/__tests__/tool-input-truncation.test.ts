import {
  PORTAL_CHAT_PART_TEXT_MAX_CHARS,
  persistedParts,
  truncateToolInput,
} from '../persisted-chat-projection';
import { runtimeChatEventToPortalMessage } from '../runtime-chat-projection';
import { getToolRowInput } from '@canopy/ui-shared/components/chat/tool-display';

// Models often write the HTML before the title, so the title sits past a
// plain character cut.
const LONG_FIELDS = {
  html: `<div>${'x'.repeat(10_000)}</div>`,
  title: 'Revenue chart',
  height: 360,
};
const LONG_INPUT = JSON.stringify(LONG_FIELDS);

function inputOf(part: { data?: unknown } | undefined): string {
  const data = part?.data;
  if (
    !data ||
    typeof data !== 'object' ||
    !('input' in data) ||
    typeof data.input !== 'string'
  )
    throw new Error('tool_use part has no string input');
  return data.input;
}

describe('Portal tool input truncation', () => {
  it('keeps an oversized JSON input valid with its short fields', () => {
    const bounded = truncateToolInput(
      LONG_INPUT,
      PORTAL_CHAT_PART_TEXT_MAX_CHARS,
    );
    expect(bounded.length).toBeLessThanOrEqual(PORTAL_CHAT_PART_TEXT_MAX_CHARS);
    expect(JSON.parse(bounded)).toMatchObject({
      title: 'Revenue chart',
      height: 360,
    });
  });

  it('leaves inputs within the limit and non-JSON text unchanged in shape', () => {
    expect(truncateToolInput('{"a":1}', 100)).toBe('{"a":1}');
    expect(truncateToolInput('y'.repeat(200), 100)).toMatch(
      /^y+\n\n\[truncated/,
    );
  });

  it('keeps the ShowVisual title for persisted and live Portal rows', () => {
    const persisted = persistedParts({
      id: 'm1',
      role: 'assistant',
      timestamp: 1,
      blocks: [
        {
          type: 'tool_use',
          toolUseId: 'call-1',
          toolName: 'mcp__canopy__ShowVisual',
          input: LONG_INPUT,
        },
      ],
    });
    const live = runtimeChatEventToPortalMessage({
      scope: 'worktree',
      chatId: 'chat-1',
      fallbackMessageId: 'live-1',
      data: {
        type: 'assistant',
        message: {
          id: 'msg-1',
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'call-1',
              name: 'mcp__canopy__ShowVisual',
              input: LONG_FIELDS,
            },
          ],
        },
      },
    });
    for (const input of [
      inputOf(persisted[0]),
      inputOf(live?.parts?.find((part) => part.kind === 'tool_use')),
    ]) {
      expect(getToolRowInput('mcp__canopy__ShowVisual', input)).toBe(
        'Revenue chart',
      );
    }
  });
});

it('bounds aggregate live receipt metadata across Claude result blocks', () => {
  const receipt = {
    version: 1,
    kind: 'agent',
    operation: 'agents.create',
    dedupeKey: 'canopy:agent:local:agent-1',
    createdAt: '2026-10-16T12:00:00.000Z',
    source: 'local',
    agentId: 'agent-1',
    name: 'Helper',
    description: '🪴'.repeat(500),
    navigationTarget: { kind: 'agent_editor', agentId: 'agent-1' },
  };
  const output = JSON.stringify({
    ok: true,
    result: {
      agentArtifacts: Array.from({ length: 64 }, () => receipt),
    },
  });
  const projected = runtimeChatEventToPortalMessage({
    scope: 'worktree',
    chatId: 'chat-1',
    fallbackMessageId: 'live-1',
    data: {
      type: 'user',
      message: {
        id: 'results',
        role: 'user',
        content: Array.from({ length: 8 }, (_, index) => ({
          type: 'tool_result',
          tool_use_id: `call-${index}`,
          content: output,
        })),
      },
    },
  });
  const metadata = projected?.parts?.map((part) => {
    const data = part.data;
    return data && typeof data === 'object' && 'agentArtifacts' in data
      ? data.agentArtifacts
      : [];
  });
  expect(projected?.parts).toHaveLength(8);
  expect(
    new TextEncoder().encode(JSON.stringify(metadata)).byteLength,
  ).toBeLessThanOrEqual(512 * 1024);
  expect(JSON.stringify(metadata)).toContain('agent-1');
});
