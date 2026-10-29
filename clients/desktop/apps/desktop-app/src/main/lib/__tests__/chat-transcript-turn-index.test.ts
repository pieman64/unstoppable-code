import type { PersistedChatMessage } from '@canopy/agent-transcript/types';
import { indexTurn } from '../chat-transcript-turn-index';

const visualRef = {
  version: 1 as const,
  visualId: 'vis_123e4567-e89b-42d3-a456-426614174000',
  artifactId: `sha256-v1-${'a'.repeat(64)}`,
  byteLength: 8,
  sha256: 'a'.repeat(64),
  mediaType: 'text/html' as const,
  title: 'Revenue chart',
  maxHeight: 320,
};

function toolRows(id: string, timestamp: number): PersistedChatMessage[] {
  return [
    {
      id: `${id}-call`,
      role: 'assistant',
      timestamp,
      blocks: [
        { type: 'tool_use', toolUseId: id, toolName: 'Read', input: '{}' },
      ],
    },
    {
      id: `${id}-result`,
      role: 'assistant',
      timestamp: timestamp + 1,
      blocks: [
        {
          type: 'tool_result',
          toolUseId: id,
          toolName: 'Read',
          output: 'ok',
          isError: false,
        },
      ],
    },
  ];
}

describe('indexTurn', () => {
  it('retains a visual call and result that fall before the sparse tail', () => {
    // A collapsed turn keeps its visual, so a sparse page must load the rows
    // that render it even when many tool rows follow.
    const rows: PersistedChatMessage[] = [
      {
        id: 'user',
        role: 'user',
        timestamp: 1,
        blocks: [{ type: 'text', text: 'Chart revenue' }],
      },
      {
        id: 'visual-call',
        role: 'assistant',
        timestamp: 2,
        blocks: [
          {
            type: 'tool_use',
            toolUseId: 'visual',
            toolName: 'mcp__canopy__ShowVisual',
            input: '{"title":"Revenue chart"}',
          },
        ],
      },
      {
        id: 'visual-result',
        role: 'assistant',
        timestamp: 3,
        blocks: [
          {
            type: 'tool_result',
            toolUseId: 'visual',
            toolName: 'mcp__canopy__ShowVisual',
            output: `${visualRef.visualId} Shown to the user above your reply.`,
            isError: false,
            visualRef,
          },
        ],
      },
      ...Array.from({ length: 12 }, (_, index) =>
        toolRows(`read-${index}`, 10 + index * 2),
      ).flat(),
      {
        id: 'final',
        role: 'assistant',
        timestamp: 100,
        blocks: [{ type: 'text', text: 'Revenue rose every quarter.' }],
      },
      {
        id: 'timer',
        role: 'system',
        timestamp: 101,
        blocks: [{ type: 'turn_timer', startedAt: 1, completedAt: 101 }],
      },
    ];
    const indexed = indexTurn(rows, 0, true);
    expect(indexed.complete).toBe(true);
    const retainedIds = indexed.retained.map((ordinal) => rows[ordinal]?.id);
    expect(retainedIds).toEqual(
      expect.arrayContaining(['visual-call', 'visual-result']),
    );
    // Unrelated rows before the tail stay out of the sparse page.
    expect(retainedIds).not.toContain('read-0-call');
  });
});

it.each([
  'mcp__canopy__DispatchAction',
  'mcp__canopy__ShowCapabilities',
  'unstoppable_code_show_capabilities',
])('retains valid receipt rows and their calls for %s', (toolName) => {
  const receipt = {
    version: 1,
    kind: 'automation',
    operation: 'automation.create',
    dedupeKey: 'canopy:automation:global:a1',
    createdAt: '2026-10-16T00:00:00.000Z',
    activityId: 'a1',
    name: 'Daily',
    enabled: true,
    running: false,
    schedule: 'daily',
    actionKind: 'app_advisor_prompt',
    targetSummary: 'App Advisor',
    ifCommandConfigured: false,
    navigationTarget: { kind: 'automation_editor', activityId: 'a1' },
  };
  const make = (valid: boolean): PersistedChatMessage[] => [
    {
      id: 'u',
      role: 'user',
      timestamp: 1,
      blocks: [{ type: 'text', text: 'Create automation' }],
    },
    ...toolRows('receipt', 2).map((row) => ({
      ...row,
      blocks: row.blocks.map((block) =>
        block.type === 'tool_use'
          ? { ...block, toolName }
          : block.type === 'tool_result'
            ? {
                ...block,
                toolName,
                output: JSON.stringify({
                  ok: true,
                  result: {
                    agentArtifacts: valid
                      ? [receipt]
                      : [{ kind: 'automation' }],
                  },
                }),
              }
            : block,
      ),
    })),
    ...Array.from({ length: 24 }, (_, i) =>
      toolRows(`later-${i}`, 10 + i * 2),
    ).flat(),
    {
      id: 'final',
      role: 'assistant',
      timestamp: 100,
      blocks: [{ type: 'text', text: 'Saved' }],
    },
    {
      id: 'timer',
      role: 'system',
      timestamp: 101,
      blocks: [{ type: 'turn_timer', completedAt: 101 }],
    },
  ];
  expect(indexTurn(make(true), 0, true).retained).toEqual(
    expect.arrayContaining([1, 2]),
  );
  expect(indexTurn(make(false), 0, true).retained).not.toContain(1);
  expect(indexTurn(make(false), 0, true).retained).not.toContain(2);
});
