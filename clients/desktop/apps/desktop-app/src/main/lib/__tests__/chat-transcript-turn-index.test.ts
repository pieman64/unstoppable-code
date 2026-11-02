import type { PersistedChatMessage } from '@canopy/agent-transcript/types';
import { placeSafetyDenialReceipts } from '@/components/chat/safety-denial-placement';
import {
  mergeToolResults,
  reorderMessagesForDisplay,
} from '@canopy/desktop-shared/lib/message-transforms';
import {
  computeTurnOutcomes,
  groupIntoTurns,
  splitFinalMessages,
} from '@canopy/desktop-shared/lib/turn-utils';
import {
  buildTurnIndex,
  indexTurn,
  isTranscriptTurnIndex,
} from '../chat-transcript-turn-index';

function outcomeRows(): PersistedChatMessage[] {
  return [
    {
      id: 'u',
      role: 'user',
      timestamp: 1,
      blocks: [{ type: 'text', text: 'Work' }],
    },
    ...toolRows('blocked', 2),
    ...toolRows('failed', 4).map((row) => ({
      ...row,
      blocks: row.blocks.map((block) =>
        block.type === 'tool_result' ? { ...block, isError: true } : block,
      ),
    })),
    {
      id: 'receipt',
      role: 'system',
      timestamp: 6,
      blocks: [
        { type: 'text', text: 'Safety notice' },
        {
          type: 'approval_safety_denied_info',
          receiptId: 'receipt',
          timestamp: 6,
          reason: 'force-push',
          command: 'fixture only',
          mode: 'ask',
          toolUseId: 'blocked',
          turnUserMessageId: 'u',
        },
      ],
    },
    {
      id: 'final',
      role: 'assistant',
      timestamp: 7,
      blocks: [{ type: 'text', text: 'Done' }],
    },
    {
      id: 'timer',
      role: 'system',
      timestamp: 8,
      blocks: [{ type: 'turn_timer', completedAt: 8 }],
    },
  ];
}

describe('turn outcome index', () => {
  it('keeps a child-directed prompt inside its root recovery turn in display and index projections', async () => {
    const rows = outcomeRows();
    const timer = rows.pop();
    if (!timer) throw new Error('Missing fixture timer');
    rows.splice(
      1,
      0,
      timer,
      {
        id: 'agent',
        role: 'assistant',
        timestamp: 2,
        blocks: [
          {
            type: 'tool_use',
            toolUseId: 'helper',
            toolName: 'Agent',
            input: '{"run_in_background":true}',
          },
          {
            type: 'tool_result',
            toolUseId: 'helper',
            toolName: 'Agent',
            output: 'Background review started',
            isError: false,
          },
        ],
      },
      {
        id: 'child',
        role: 'user',
        parentToolUseId: 'helper',
        timestamp: 3,
        blocks: [{ type: 'text', text: 'Check in the background' }],
      },
    );
    for (const row of rows)
      for (const block of row.blocks) {
        if (block.type === 'tool_result' && block.toolUseId === 'failed')
          block.interruption = { reason: 'app_restart', at: 8 };
      }
    const displayed = reorderMessagesForDisplay(rows);
    expect(displayed.at(-1)?.id).toBe(timer.id);
    const turns = await buildTurnIndex(rows);
    expect(turns).toHaveLength(1);
    expect(turns[0].outcomes).toEqual({
      blocked: 1,
      failed: 0,
      interrupted: 1,
    });
    const group = groupIntoTurns(mergeToolResults(displayed)).find(
      (item) => item.kind === 'turn-group',
    );
    expect(
      group?.kind === 'turn-group'
        ? group.assistantMessages.some((row) =>
            row.blocks.some(
              (block) =>
                block.type === 'tool_use' && block.toolUseId === 'failed',
            ),
          )
        : false,
    ).toBe(true);
  });

  it('counts a resultless call only after its complete canonical turn settles', () => {
    const rows: PersistedChatMessage[] = [
      {
        id: 'u',
        role: 'user',
        timestamp: 1,
        blocks: [{ type: 'text', text: 'Edit' }],
      },
      {
        id: 'call',
        role: 'assistant',
        timestamp: 2,
        blocks: [
          {
            type: 'tool_use',
            toolUseId: 'edit',
            toolName: 'Edit',
            input: '{}',
          },
        ],
      },
    ];
    expect(indexTurn(rows, 0).outcomes).toEqual({
      blocked: 0,
      failed: 0,
      interrupted: 0,
    });
    rows.push({
      id: 'timer',
      role: 'system',
      timestamp: 3,
      blocks: [{ type: 'turn_timer', completedAt: 3 }],
    });
    expect(indexTurn(rows, 0).outcomes).toEqual({
      blocked: 0,
      failed: 0,
      interrupted: 1,
    });
  });
  it('promotes interrupted steps exactly once for late duplicate blocked receipts', async () => {
    const rows = outcomeRows().map(
      (row): PersistedChatMessage => ({
        ...row,
        blocks: row.blocks.map((block) =>
          block.type === 'tool_result' && block.toolUseId === 'failed'
            ? { ...block, interruption: { reason: 'app_restart', at: 7 } }
            : block,
        ),
      }),
    );
    expect(indexTurn(rows, 0).outcomes).toEqual({
      blocked: 1,
      failed: 0,
      interrupted: 1,
    });
    rows.push({
      id: 'next',
      role: 'user',
      timestamp: 9,
      blocks: [{ type: 'text', text: 'Continue' }],
    });
    const receipt: PersistedChatMessage = {
      id: 'late',
      role: 'system',
      timestamp: 10,
      blocks: [
        {
          type: 'approval_safety_denied_info',
          receiptId: 'late',
          timestamp: 10,
          reason: 'force-push',
          mode: 'ask',
          command: 'fixture',
          toolUseId: 'failed',
          turnUserMessageId: 'u',
        },
      ],
    };
    rows.push(receipt, { ...receipt, id: 'duplicate' });
    const turns = await buildTurnIndex(rows);
    expect(turns[0].outcomes).toEqual({
      blocked: 2,
      failed: 0,
      interrupted: 0,
    });
  });
  it('matches renderer outcomes when a receipt arrives after its owner turn', async () => {
    const rows: PersistedChatMessage[] = ['first', 'next'].flatMap(
      (id, index) => [
        {
          id,
          role: 'user',
          timestamp: index * 10,
          blocks: [{ type: 'text', text: id }],
        },
        ...toolRows('reused', index * 10 + 1).map((row) => ({
          ...row,
          id: `${id}-${row.id}`,
          blocks: row.blocks.map((block) =>
            block.type === 'tool_result'
              ? { ...block, isError: index === 0 }
              : block,
          ),
        })),
        {
          id: `${id}-final`,
          role: 'assistant',
          timestamp: index * 10 + 3,
          blocks: [{ type: 'text', text: 'Done' }],
        },
        {
          id: `${id}-timer`,
          role: 'system',
          timestamp: index * 10 + 4,
          blocks: [{ type: 'turn_timer', completedAt: index * 10 + 4 }],
        },
      ],
    );
    rows.push({
      id: 'late-receipt',
      role: 'system',
      timestamp: 20,
      blocks: [
        {
          type: 'approval_safety_denied_info',
          receiptId: 'late-receipt',
          timestamp: 20,
          reason: 'force-push',
          command: 'fixture only',
          mode: 'ask',
          toolUseId: 'reused',
          turnUserMessageId: 'first',
        },
      ],
    });
    const expected = [
      { blocked: 1, failed: 0, interrupted: 0 },
      { blocked: 0, failed: 0, interrupted: 0 },
    ];
    const renderer = groupIntoTurns(
      mergeToolResults(
        reorderMessagesForDisplay(placeSafetyDenialReceipts(rows)),
      ),
    );
    expect(
      renderer
        .filter((group) => group.kind === 'turn-group')
        .map((group) => {
          const { intermediateMessages, trailingToolMessages } =
            splitFinalMessages(group.assistantMessages);
          return computeTurnOutcomes(
            [...intermediateMessages, ...trailingToolMessages],
            group.assistantMessages,
          );
        }),
    ).toEqual(expected);
    expect((await buildTurnIndex(rows)).map((turn) => turn.outcomes)).toEqual(
      expected,
    );
  });

  it('includes separate system receipts promoted beside the final answer', () => {
    expect(indexTurn(outcomeRows(), 0)).toMatchObject({
      summary: { read: 2 },
      outcomes: { blocked: 1, failed: 1, interrupted: 0 },
    });
  });

  it('matches in-memory outcomes with duplicated and trailing authoritative results', () => {
    const rows = outcomeRows();
    rows.splice(rows.length - 1, 0, {
      id: 'late-error',
      role: 'assistant',
      timestamp: 7.5,
      blocks: [
        {
          type: 'tool_result',
          toolUseId: 'blocked',
          toolName: 'Read',
          output: 'denied',
          isError: true,
        },
        {
          type: 'tool_result',
          toolUseId: 'failed',
          toolName: 'Read',
          output: 'failed',
          isError: true,
        },
        {
          type: 'tool_result',
          toolUseId: 'orphan',
          toolName: 'Read',
          output: 'failed',
          isError: true,
        },
      ],
    });
    const group = groupIntoTurns(
      mergeToolResults(reorderMessagesForDisplay(rows)),
    ).find((item) => item.kind === 'turn-group');
    if (group?.kind !== 'turn-group') throw new Error('Expected fixture turn');
    const { intermediateMessages, trailingToolMessages } = splitFinalMessages(
      group.assistantMessages,
    );
    const inMemory = computeTurnOutcomes(
      [...intermediateMessages, ...trailingToolMessages],
      group.assistantMessages,
    );
    expect(inMemory).toEqual({ blocked: 1, failed: 1, interrupted: 0 });
    expect(indexTurn(rows, 0).outcomes).toEqual(inMemory);
  });

  it('isolates reused step IDs and receipts across neighboring turns', async () => {
    const rows = outcomeRows();
    const next: PersistedChatMessage[] = [
      {
        id: 'next-user',
        role: 'user',
        timestamp: 9,
        blocks: [{ type: 'text', text: 'Next' }],
      },
      ...toolRows('blocked', 10),
      {
        id: 'next-final',
        role: 'assistant',
        timestamp: 12,
        blocks: [{ type: 'text', text: 'Done' }],
      },
      {
        id: 'next-timer',
        role: 'system',
        timestamp: 13,
        blocks: [{ type: 'turn_timer', completedAt: 13 }],
      },
    ];
    expect(await buildTurnIndex([...rows, ...next])).toEqual([
      expect.objectContaining({
        outcomes: { blocked: 1, failed: 1, interrupted: 0 },
      }),
      expect.objectContaining({
        outcomes: { blocked: 0, failed: 0, interrupted: 0 },
      }),
    ]);
  });

  it('requires three safe non-negative outcome counts in version 10', () => {
    const turn = indexTurn(outcomeRows(), 0);
    const index = {
      version: 10,
      committedByteLength: 100,
      committedMessageCount: turn.end,
      turns: [turn],
    };
    expect(isTranscriptTurnIndex(index)).toBe(true);
    for (const deniedToolUseIds of [
      undefined,
      null,
      [1],
      [''],
      ['same', 'same'],
    ]) {
      expect(
        isTranscriptTurnIndex({
          ...index,
          turns: [{ ...turn, deniedToolUseIds }],
        }),
      ).toBe(false);
    }
    expect(isTranscriptTurnIndex({ ...index, version: 6 })).toBe(false);
    expect(isTranscriptTurnIndex({ ...index, version: 7 })).toBe(false);
    expect(isTranscriptTurnIndex({ ...index, version: 8 })).toBe(false);
    expect(isTranscriptTurnIndex({ ...index, version: 9 })).toBe(false);
    expect(isTranscriptTurnIndex(JSON.parse(JSON.stringify(index)))).toBe(true);
    for (const file of [
      { path: 'report.md', state: 'ready' },
      { path: 'report.md', state: 'ready', change: 'updated' },
      { path: 'report.md', state: 'ready', saved: true },
      { path: 'report.md', state: 'ready', movedFrom: ['old.md'] },
      { path: 'report.md', state: 'ready', removed: true },
      {
        path: 'report.md',
        state: 'ready',
        evidence: [
          { key: 'edit', path: 'report.md', state: 'ready', change: 'updated' },
        ],
      },
    ]) {
      expect(
        isTranscriptTurnIndex({
          ...index,
          turns: [{ ...turn, files: [file] }],
        }),
      ).toBe(true);
    }
    for (const change of [null, 'created', 'deleted', 1]) {
      expect(
        isTranscriptTurnIndex({
          ...index,
          turns: [
            { ...turn, files: [{ path: 'report.md', state: 'ready', change }] },
          ],
        }),
      ).toBe(false);
    }
    for (const saved of [false, null, 'true']) {
      expect(
        isTranscriptTurnIndex({
          ...index,
          turns: [
            { ...turn, files: [{ path: 'report.md', state: 'ready', saved }] },
          ],
        }),
      ).toBe(false);
    }
    for (const file of [
      {
        path: 'report.md',
        state: 'ready',
        evidence: [
          { key: 'same', path: 'a.md', state: 'ready' },
          { key: 'same', path: 'b.md', state: 'ready' },
        ],
      },
      { path: 'report.md', state: 'ready', evidence: [] },
      {
        path: 'report.md',
        state: 'ready',
        evidence: [{ key: 1, path: 'report.md', state: 'ready' }],
      },
      {
        path: 'report.md',
        state: 'ready',
        evidence: [
          { key: 'x', path: 'report.md', state: 'ready', evidence: [] },
        ],
      },
      { path: 'report.md', state: 'creating', removed: true },
      { path: 'report.md', state: 'ready', removed: false },
      { path: 'report.md', state: 'ready', movedFrom: [] },
      { path: 'report.md', state: 'ready', movedFrom: ['a/../old.md'] },
      { path: 'report.md', state: 'ready', movedFrom: [1] },
      { path: 'report.md', state: 'failed', movedFrom: ['old.md'] },
    ])
      expect(
        isTranscriptTurnIndex({
          ...index,
          turns: [{ ...turn, files: [file] }],
        }),
      ).toBe(false);
    for (const outcomes of [
      undefined,
      null,
      {},
      { blocked: 0 },
      { failed: 0 },
      { blocked: 0, failed: 0 },
      ...[-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1'].flatMap(
        (invalid) => [
          { blocked: invalid, failed: 0, interrupted: 0 },
          { blocked: 0, failed: invalid, interrupted: 0 },
          { blocked: 0, failed: 0, interrupted: invalid },
        ],
      ),
    ]) {
      expect(
        isTranscriptTurnIndex({ ...index, turns: [{ ...turn, outcomes }] }),
      ).toBe(false);
    }
    expect(
      isTranscriptTurnIndex({
        ...index,
        turns: [
          { ...turn, outcomes: { blocked: 0, failed: 0, interrupted: 0 } },
        ],
      }),
    ).toBe(true);
  });
});

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

describe('chat transcript turn index', () => {
  it("indexes a prompt turn's own final answer, not its wake's (turn-state phase 40d)", async () => {
    const rows: PersistedChatMessage[] = [
      {
        id: 'u1',
        role: 'user',
        timestamp: 1,
        blocks: [{ type: 'text', text: 'Run the tests in the background' }],
      },
      {
        id: 'a1',
        role: 'assistant',
        timestamp: 2,
        blocks: [{ type: 'text', text: 'Started the tests.' }],
      },
      {
        id: 'turn-1:timer',
        role: 'system',
        timestamp: 1,
        blocks: [
          {
            type: 'turn_timer',
            turnId: 'turn-1',
            userMessageId: 'u1',
            startedAt: 1,
            completedAt: 3,
          },
        ],
      },
      {
        id: 'wake:timer',
        role: 'system',
        timestamp: 4,
        blocks: [
          {
            type: 'turn_timer',
            turnId: 'wake',
            spawnedBy: { taskId: 'task-1' },
            startedAt: 4,
            completedAt: 6,
          },
        ],
      },
      {
        id: 'a-wake',
        role: 'assistant',
        timestamp: 5,
        blocks: [{ type: 'text', text: 'The tests passed.' }],
      },
    ];

    const [turn] = await buildTurnIndex(rows);

    // One indexed turn per prompt; the transcript shows the wake on its own.
    expect(turn).toMatchObject({ id: 'u1', start: 0, end: 5, complete: true });
    expect(turn?.finalMessageIds).toEqual(['a1']);
  });
});

describe('tools-loaded continuations', () => {
  it("applies a late denial receipt to its continuation step's outcome", async () => {
    const timer = (
      id: string,
      fields: Record<string, unknown>,
    ): PersistedChatMessage => ({
      id,
      role: 'system',
      timestamp: 1,
      blocks: [{ type: 'turn_timer', startedAt: 1, completedAt: 2, ...fields }],
    });
    const rows: PersistedChatMessage[] = [
      {
        id: 'u1',
        role: 'user',
        timestamp: 1,
        blocks: [{ type: 'text', text: 'Load Slack, then push' }],
      },
      timer('turn-1:timer', { turnId: 'turn-1', userMessageId: 'u1' }),
      {
        id: 'a-load',
        role: 'assistant',
        timestamp: 2,
        blocks: [{ type: 'text', text: 'Loading Slack.' }],
      },
      timer('turn-2:timer', {
        turnId: 'turn-2',
        userMessageId: 'u1',
        spawnedBy: { toolUseId: 'tool-load', toolsLoaded: true },
      }),
      {
        id: 'push',
        role: 'assistant',
        timestamp: 3,
        blocks: [
          {
            type: 'tool_use',
            toolUseId: 'push-1',
            toolName: 'Bash',
            input: JSON.stringify({ command: 'git push --force' }),
          },
        ],
      },
      {
        id: 'tool:push-1',
        role: 'system',
        timestamp: 4,
        blocks: [
          {
            type: 'tool_result',
            toolUseId: 'push-1',
            toolName: '',
            output: 'denied',
            isError: true,
          },
        ],
      },
      {
        id: 'a-answer',
        role: 'assistant',
        timestamp: 5,
        blocks: [{ type: 'text', text: 'The push was denied.' }],
      },
      {
        id: 'u2',
        role: 'user',
        timestamp: 10,
        blocks: [{ type: 'text', text: 'Next' }],
      },
      timer('turn-3:timer', { turnId: 'turn-3', userMessageId: 'u2' }),
      // The receipt for the continuation's step arrives after the next prompt.
      {
        id: 'late-receipt',
        role: 'system',
        timestamp: 11,
        blocks: [
          {
            type: 'approval_safety_denied_info',
            receiptId: 'late-receipt',
            timestamp: 11,
            reason: 'force-push',
            command: 'git push --force',
            mode: 'ask',
            toolUseId: 'push-1',
            turnUserMessageId: 'u1',
          },
        ],
      },
    ];

    const [turn] = await buildTurnIndex(rows);

    expect(turn?.outcomes).toEqual({ blocked: 0, failed: 0, interrupted: 0 });
    expect(turn?.continuations?.['turn-2:timer:wake']?.outcomes).toEqual({
      blocked: 1,
      failed: 0,
      interrupted: 0,
    });
  });

  it("indexes a tools-loaded continuation's own metadata and keeps its answer when compacted", async () => {
    const steps: PersistedChatMessage[] = Array.from(
      { length: 20 },
      (_, index): PersistedChatMessage[] => [
        {
          id: `step-${index}`,
          role: 'assistant',
          timestamp: 10 + index,
          blocks: [
            {
              type: 'tool_use',
              toolUseId: `bash-${index}`,
              toolName: 'Bash',
              input: JSON.stringify({ command: `echo ${index}` }),
            },
          ],
        },
        {
          id: `tool:bash-${index}`,
          role: 'system',
          timestamp: 10 + index,
          blocks: [
            {
              type: 'tool_result',
              toolUseId: `bash-${index}`,
              toolName: '',
              output: `${index}`,
              isError: index === 0,
            },
          ],
        },
      ],
    ).flat();
    const rows: PersistedChatMessage[] = [
      {
        id: 'u1',
        role: 'user',
        timestamp: 1,
        blocks: [{ type: 'text', text: 'Load Slack, then report' }],
      },
      {
        id: 'turn-1:timer',
        role: 'system',
        timestamp: 1,
        blocks: [
          {
            type: 'turn_timer',
            turnId: 'turn-1',
            userMessageId: 'u1',
            startedAt: 1,
            completedAt: 3,
          },
        ],
      },
      {
        id: 'a-load',
        role: 'assistant',
        timestamp: 2,
        blocks: [{ type: 'text', text: 'Loading Slack.' }],
      },
      {
        id: 'turn-2:timer',
        role: 'system',
        timestamp: 4,
        blocks: [
          {
            type: 'turn_timer',
            turnId: 'turn-2',
            userMessageId: 'u1',
            spawnedBy: { toolUseId: 'tool-load', toolsLoaded: true },
            startedAt: 4,
            completedAt: 40,
          },
        ],
      },
      ...steps,
      {
        id: 'a-answer',
        role: 'assistant',
        timestamp: 50,
        blocks: [{ type: 'text', text: 'Here is the report.' }],
      },
    ];

    const [turn] = await buildTurnIndex(rows);

    // The prompt's own group keeps its answer; the continuation, which a
    // reopened chat shows as its own turn, keeps its own projection.
    expect(turn).toMatchObject({ id: 'u1', finalMessageIds: ['a-load'] });
    const continuation = turn?.continuations?.['turn-2:timer:wake'];
    expect(continuation).toMatchObject({
      complete: true,
      finalMessageIds: ['a-answer'],
      // Its failed first step falls before the sparse tail.
      outcomes: { blocked: 0, failed: 1, interrupted: 0 },
    });
    expect(continuation?.summary.bash).toBe(20);
    expect(turn?.retained).not.toContain(
      rows.findIndex((row) => row.id === 'tool:bash-0'),
    );
    expect(turn?.retained).toContain(
      rows.findIndex((row) => row.id === 'a-answer'),
    );

    // A persisted index keeps a well-formed projection and rejects others.
    const index = {
      version: 10,
      committedByteLength: 100,
      committedMessageCount: rows.length,
      turns: [turn],
    };
    expect(isTranscriptTurnIndex(index)).toBe(true);
    for (const continuations of [
      [],
      { 'turn-2:timer:wake': null },
      { 'turn-2:timer:wake': { ...continuation, finalMessageIds: [1] } },
      { 'turn-2:timer:wake': { ...continuation, complete: 'yes' } },
    ])
      expect(
        isTranscriptTurnIndex({
          ...index,
          turns: [{ ...turn, continuations }],
        }),
      ).toBe(false);
  });
});

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
