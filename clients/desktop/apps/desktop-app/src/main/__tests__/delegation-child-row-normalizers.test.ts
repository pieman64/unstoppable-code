import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DelegationChildNormalizer } from '../agents/delegation/child-row-normalizers';
import type {
  DelegationCommandSpools,
  CommandSpoolOperation,
} from '../agents/delegation/command-output-spools';
import { DelegationTranscriptRecorder } from '../agents/delegation/transcript-recorder';
import type { DelegationTranscriptChange } from '@canopy/desktop-shared/node/delegation/transcript-port';

const thread = { threadId: 'thread-1', turnId: 'turn-1' };

function codex(
  normalizer: DelegationChildNormalizer,
  method: string,
  params: Record<string, unknown>,
): Promise<readonly DelegationTranscriptChange[]> {
  return normalizer.codex({ method, params: { ...thread, ...params } });
}

function text(changes: readonly DelegationTranscriptChange[]): string {
  return JSON.stringify(changes.map((change) => change.row.blocks));
}

describe('DelegationChildNormalizer Codex streaming', () => {
  it('applies agent message deltas before the item completes', async () => {
    const normalizer = new DelegationChildNormalizer('delegated-agent-d');
    await codex(normalizer, 'item/started', {
      item: { type: 'agentMessage', id: 'message-1', text: '' },
    });
    const changes = await codex(normalizer, 'item/agentMessage/delta', {
      itemId: 'message-1',
      delta: 'streamed answer',
    });
    expect(text(changes)).toContain('streamed answer');
    expect(changes.every((change) => !change.row.final)).toBe(true);
  });

  it.each([
    ['item/reasoning/summaryTextDelta', 'summaryIndex'],
    ['item/reasoning/textDelta', 'contentIndex'],
  ])(
    'applies %s to an item whose reasoning starts empty',
    async (method, indexField) => {
      const normalizer = new DelegationChildNormalizer('delegated-agent-d');
      await codex(normalizer, 'item/started', {
        item: {
          type: 'reasoning',
          id: 'reasoning-1',
          summary: [],
          content: [],
        },
      });
      const changes = await codex(normalizer, method, {
        itemId: 'reasoning-1',
        delta: 'thinking aloud',
        [indexField]: 0,
      });
      expect(text(changes)).toContain('thinking aloud');
    },
  );

  it('keeps streamed command output when the completion has none', async () => {
    const normalizer = new DelegationChildNormalizer('delegated-agent-d');
    const command = {
      type: 'commandExecution',
      id: 'command-1',
      command: 'ls',
      cwd: '/tmp',
      status: 'inProgress',
      aggregatedOutput: null,
    };
    await codex(normalizer, 'item/started', { item: command });
    await codex(normalizer, 'item/commandExecution/outputDelta', {
      itemId: 'command-1',
      delta: 'file-a\nfile-b\n',
    });
    const changes = await codex(normalizer, 'item/completed', {
      item: { ...command, status: 'completed', exitCode: 0 },
    });
    const final = changes.filter((change) => change.row.final);
    expect(final).toHaveLength(1);
    expect(text(final)).toContain('file-a');
  });

  it('keeps streamed command output when the stream ends before completion', async () => {
    const normalizer = new DelegationChildNormalizer('delegated-agent-d');
    await codex(normalizer, 'item/started', {
      item: {
        type: 'commandExecution',
        id: 'command-1',
        command: 'ls',
        cwd: '/tmp',
        status: 'inProgress',
        aggregatedOutput: null,
      },
    });
    await codex(normalizer, 'item/commandExecution/outputDelta', {
      itemId: 'command-1',
      delta: 'partial-output\n',
    });
    const final = await normalizer.finish();
    expect(final).toHaveLength(1);
    expect(final[0]?.row.final).toBe(true);
    expect(final[0]?.row.blocks).toEqual([
      expect.objectContaining({
        type: 'tool_use',
        toolUseId: 'codex-command-1',
      }),
      expect.objectContaining({
        type: 'tool_result',
        toolUseId: 'codex-command-1',
        output: 'partial-output\n',
        isError: true,
      }),
    ]);
  });
});

describe('DelegationChildNormalizer publication windows', () => {
  afterEach(() => jest.restoreAllMocks());

  it('bounds streamed prose admissions by windows instead of admitting every delta', async () => {
    let now = 1_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const normalizer = new DelegationChildNormalizer('agent');
    const admissions: DelegationTranscriptChange[] = [];
    admissions.push(
      ...(await codex(normalizer, 'item/started', {
        item: { type: 'agentMessage', id: 'prose', text: 'start' },
      })),
    );
    for (let index = 0; index < 20; index += 1) {
      now += 10;
      admissions.push(
        ...(await codex(normalizer, 'item/agentMessage/delta', {
          itemId: 'prose',
          delta: 'x',
        })),
      );
    }
    expect(admissions).toHaveLength(1);
    now = 1_250;
    const tick = await codex(normalizer, 'item/agentMessage/delta', {
      itemId: 'prose',
      delta: 'tick',
    });
    expect(tick).toHaveLength(1);
    expect(tick[0]?.row.itemRevision).toBe(1);
    expect(text(tick)).toContain(`start${'x'.repeat(20)}tick`);
  });

  it('drops duplicate Claude results before and after acknowledgement without orphan rows', async () => {
    const normalizer = new DelegationChildNormalizer('agent');
    const open = await normalizer.claude({
      type: 'assistant',
      message: {
        id: 'use-message',
        content: [{ type: 'tool_use', id: 'tool', name: 'Read', input: {} }],
      },
    });
    const result = {
      type: 'user',
      message: {
        id: 'result-message',
        content: [
          { type: 'tool_result', tool_use_id: 'tool', content: 'answer' },
        ],
      },
    };
    const final = await normalizer.claude(result);
    expect(final).toHaveLength(1);
    expect(final[0]?.row.id).toBe(open[0]?.row.id);
    expect(final[0]?.row.final).toBe(true);
    expect(await normalizer.claude(result)).toEqual([]);
    normalizer.acknowledge(final);
    expect(await normalizer.claude(result)).toEqual([]);
    expect(await normalizer.finish()).toEqual([]);
  });
});

function nativeMap(
  normalizer: DelegationChildNormalizer,
  key: string,
): Map<unknown, unknown> {
  const value: unknown = Reflect.get(normalizer, key);
  if (!(value instanceof Map)) throw new Error(`Missing state map: ${key}`);
  return value;
}

describe('DelegationChildNormalizer incremental state', () => {
  it('does not flush published open rows for interleaved finals and preserves observation order', async () => {
    let now = 0;
    const normalizer = new DelegationChildNormalizer('agent', {
      now: (): number => now,
    });
    const first = await codex(normalizer, 'item/started', {
      item: { id: 'open', type: 'agentMessage', text: 'first' },
    });
    now = 10;
    expect(
      await codex(normalizer, 'item/agentMessage/delta', {
        itemId: 'open',
        delta: '-pending',
      }),
    ).toEqual([]);
    expect(
      await codex(normalizer, 'item/started', {
        item: { id: 'second', type: 'agentMessage', text: 'second' },
      }),
    ).toEqual([]);
    const final = await codex(normalizer, 'item/completed', {
      item: { id: 'third', type: 'agentMessage', text: 'third' },
    });
    expect(final.map(({ row }) => row.delegationSequence)).toEqual([1, 2]);
    expect(final.map(({ row }) => row.final)).toEqual([false, true]);
    expect(final.some(({ row }) => row.id === first[0]?.row.id)).toBe(false);
    const another = await codex(normalizer, 'item/completed', {
      item: { id: 'fourth', type: 'agentMessage', text: 'fourth' },
    });
    expect(another.map(({ row }) => row.delegationSequence)).toEqual([3]);
    now = 250;
    const tick = await codex(normalizer, 'thread/notification', {});
    expect(tick.map(({ row }) => row.delegationSequence)).toEqual([0]);
    expect(text(tick)).toContain('first-pending');
  });

  it('publishes a final before the next tick and finish flushes pending state only once', async () => {
    const normalizer = new DelegationChildNormalizer('agent', {
      now: (): number => 0,
    });
    await codex(normalizer, 'item/started', {
      item: { id: 'a', type: 'agentMessage', text: 'a' },
    });
    expect(
      await codex(normalizer, 'item/agentMessage/delta', {
        itemId: 'a',
        delta: 'b',
      }),
    ).toEqual([]);
    const final = await codex(normalizer, 'item/completed', {
      item: { id: 'a', type: 'agentMessage', text: 'ab' },
    });
    expect(final).toHaveLength(1);
    expect(final[0]?.row).toEqual(
      expect.objectContaining({ final: true, itemRevision: 1 }),
    );
    expect(
      await codex(normalizer, 'item/started', {
        item: { id: 'b', type: 'agentMessage', text: 'pending' },
      }),
    ).toEqual([]);
    expect(
      await codex(normalizer, 'item/agentMessage/delta', {
        itemId: 'b',
        delta: '-tail',
      }),
    ).toEqual([]);
    const finished = await normalizer.finish();
    expect(finished).toHaveLength(1);
    expect(finished[0]?.row).toEqual(
      expect.objectContaining({
        final: true,
        itemRevision: 0,
        delegationSequence: 1,
      }),
    );
    expect(text(finished)).toContain('pending-tail');
    expect(await normalizer.finish()).toEqual([]);
    expect(
      await codex(normalizer, 'item/started', {
        item: { id: 'new', type: 'agentMessage', text: 'late' },
      }),
    ).toEqual([]);
  });

  it('does not republish identical open previews but finalizes with the exact field', async () => {
    let now = 0;
    const normalizer = new DelegationChildNormalizer('agent', {
      now: (): number => now,
    });
    const firstText = `${'h'.repeat(100_000)}first-middle${'t'.repeat(100_000)}`;
    const nextText = firstText.replace('first-middle', 'other-middle');
    const open = await codex(normalizer, 'item/started', {
      item: { id: 'preview', type: 'agentMessage', text: firstText },
    });
    expect(text(open)).not.toContain('first-middle');
    now = 250;
    expect(
      await codex(normalizer, 'item/updated', {
        item: { id: 'preview', type: 'agentMessage', text: nextText },
      }),
    ).toEqual([]);
    const final = await codex(normalizer, 'item/completed', {
      item: { id: 'preview', type: 'agentMessage', text: nextText },
    });
    expect(final[0]?.row.itemRevision).toBe(1);
    expect(final[0]?.row.blocks).toEqual([{ type: 'text', text: nextText }]);
  });

  it('retains unfinished and final-in-flight native state until the matching final ack', async () => {
    const normalizer = new DelegationChildNormalizer('agent', {
      now: (): number => 0,
    });
    const command = {
      id: 'command',
      type: 'commandExecution',
      command: 'ls',
      status: 'inProgress',
    };
    const open = await codex(normalizer, 'item/started', { item: command });
    normalizer.acknowledge(open);
    expect(nativeMap(normalizer, 'items').size).toBe(1);
    expect(nativeMap(normalizer, 'codexItems').size).toBe(1);
    await codex(normalizer, 'item/commandExecution/outputDelta', {
      itemId: 'command',
      delta: 'buffered',
    });
    const final = await codex(normalizer, 'item/completed', {
      item: { ...command, status: 'completed' },
    });
    const nativeBefore = Array.from(
      nativeMap(normalizer, 'codexItems').values(),
    );
    expect(
      await codex(normalizer, 'item/commandExecution/outputDelta', {
        itemId: 'command',
        delta: 'late',
      }),
    ).toEqual([]);
    expect(
      await codex(normalizer, 'item/started', {
        item: { ...command, aggregatedOutput: 'duplicate' },
      }),
    ).toEqual([]);
    expect(Array.from(nativeMap(normalizer, 'codexItems').values())).toEqual(
      nativeBefore,
    );
    normalizer.acknowledge(
      final.map(({ row }) => ({
        row: { ...row, itemRevision: row.itemRevision + 1 },
      })),
    );
    expect(nativeMap(normalizer, 'items').size).toBe(1);
    normalizer.acknowledge(final);
    expect(nativeMap(normalizer, 'items').size).toBe(0);
    expect(nativeMap(normalizer, 'codexItems').size).toBe(0);
    expect(nativeMap(normalizer, 'codexItemKeys').size).toBe(0);
    expect(nativeMap(normalizer, 'timestamps').size).toBe(0);
    expect(
      await codex(normalizer, 'item/completed', {
        item: { ...command, status: 'completed', aggregatedOutput: 'late' },
      }),
    ).toEqual([]);
    expect(
      await codex(normalizer, 'item/commandExecution/outputDelta', {
        itemId: 'command',
        delta: 'late',
      }),
    ).toEqual([]);
    expect(nativeMap(normalizer, 'codexItems').size).toBe(0);
    expect(await normalizer.finish()).toEqual([]);
  });

  it('scopes reused Codex native ids to their turns after eviction', async () => {
    const normalizer = new DelegationChildNormalizer('agent', {
      now: (): number => 0,
    });
    const first = await codex(normalizer, 'item/completed', {
      item: { id: 'reused', type: 'agentMessage', text: 'first' },
    });
    normalizer.acknowledge(first);
    await codex(normalizer, 'turn/started', { turnId: 'turn-2' });
    const second = await normalizer.codex({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        item: { id: 'reused', type: 'agentMessage', text: 'second' },
      },
    });
    expect(second).toHaveLength(1);
    expect(second[0]?.row.id).not.toBe(first[0]?.row.id);
    expect(second[0]?.row.delegationSequence).toBe(1);
    expect(text(second)).toContain('second');
    expect(
      await codex(normalizer, 'item/updated', {
        item: { id: 'reused', type: 'agentMessage', text: 'late-first' },
      }),
    ).toEqual([]);
  });

  it('evicts Claude block/tool payloads but retains native tombstones for late events', async () => {
    const normalizer = new DelegationChildNormalizer('agent', {
      now: (): number => 0,
    });
    await normalizer.claude({
      type: 'message_start',
      message: { id: 'message' },
    });
    const start = {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'tool', name: 'Read', input: {} },
    };
    const open = await normalizer.claude(start);
    normalizer.acknowledge(open);
    expect(nativeMap(normalizer, 'claudeBlocks').size).toBe(1);
    const result = {
      type: 'user',
      message: {
        id: 'later',
        content: [
          { type: 'tool_result', tool_use_id: 'tool', content: 'done' },
        ],
      },
    };
    const final = await normalizer.claude(result);
    expect(final[0]?.row.id).toBe(open[0]?.row.id);
    expect(nativeMap(normalizer, 'claudeTools').size).toBe(1);
    expect(
      await normalizer.claude({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: 'late' },
      }),
    ).toEqual([]);
    normalizer.acknowledge(final);
    expect(nativeMap(normalizer, 'claudeBlocks').size).toBe(0);
    expect(nativeMap(normalizer, 'claudeTools').size).toBe(0);
    expect(nativeMap(normalizer, 'claudeMessageBlocks').size).toBe(0);
    expect(nativeMap(normalizer, 'timestamps').size).toBe(0);
    expect(await normalizer.claude(result)).toEqual([]);
    expect(await normalizer.claude(start)).toEqual([]);
    expect(nativeMap(normalizer, 'claudeBlocks').size).toBe(0);
    expect(nativeMap(normalizer, 'timestamps').size).toBe(0);
  });

  it('coalesces Claude tool-input deltas and finalizes the complete input with a later result', async () => {
    let now = 0;
    const normalizer = new DelegationChildNormalizer('agent', {
      now: (): number => now,
    });
    await normalizer.claude({ type: 'message_start', message: { id: 'm' } });
    const open = await normalizer.claude({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 't', name: 'Read', input: {} },
    });
    for (const partial_json of ['{"path":', '"file"}']) {
      expect(
        await normalizer.claude({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json },
        }),
      ).toEqual([]);
    }
    now = 250;
    const tick = await normalizer.claude({ type: 'ping' });
    expect(tick[0]?.row.id).toBe(open[0]?.row.id);
    expect(text(tick)).toContain('file');
    const final = await normalizer.claude({
      type: 'user',
      message: {
        id: 'result',
        content: [{ type: 'tool_result', tool_use_id: 't', content: 'done' }],
      },
    });
    expect(final[0]?.row.blocks).toEqual([
      expect.objectContaining({ type: 'tool_use', input: '{"path":"file"}' }),
      expect.objectContaining({ type: 'tool_result', output: 'done' }),
    ]);
  });
});

describe('DelegationChildNormalizer payload lifetimes', () => {
  it('does not resurrect Claude prose payloads on aggregate or stream duplicates after eviction', async () => {
    const normalizer = new DelegationChildNormalizer('agent', {
      now: (): number => 0,
    });
    const start = { type: 'message_start', message: { id: 'message' } };
    await normalizer.claude(start);
    await normalizer.claude({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: 'open' },
    });
    const aggregate = {
      type: 'assistant',
      message: { id: 'message', content: [{ type: 'text', text: 'final' }] },
    };
    const final = await normalizer.claude(aggregate);
    const before = structuredClone(
      Array.from(nativeMap(normalizer, 'claudeBlocks').values()),
    );
    expect(
      await normalizer.claude({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'late' },
      }),
    ).toEqual([]);
    expect(
      await normalizer.claude({ type: 'content_block_stop', index: 0 }),
    ).toEqual([]);
    expect(Array.from(nativeMap(normalizer, 'claudeBlocks').values())).toEqual(
      before,
    );
    normalizer.acknowledge(final);
    expect(await normalizer.claude(aggregate)).toEqual([]);
    expect(await normalizer.claude(start)).toEqual([]);
    expect(
      await normalizer.claude({
        type: 'content_block_start',
        message: { id: 'message' },
        index: 0,
        content_block: { type: 'text', text: 'late' },
      }),
    ).toEqual([]);
    expect(nativeMap(normalizer, 'claudeBlocks').size).toBe(0);
    expect(nativeMap(normalizer, 'claudeMessageBlocks').size).toBe(0);
    expect(nativeMap(normalizer, 'timestamps').size).toBe(0);
  });

  it('retains patch messages until finish while evicting acknowledged final logical rows', async () => {
    const normalizer = new DelegationChildNormalizer('agent', {
      now: (): number => 0,
    });
    const final = await normalizer.patch({
      type: 'canopy_assistant_patch',
      provider: 'cursor',
      role: 'assistant',
      messageId: 'patch',
      timestamp: 0,
      revision: 1,
      patches: [
        {
          index: 0,
          block: {
            type: 'tool_use',
            toolUseId: 'tool',
            toolName: 'Read',
            input: '{}',
          },
        },
        {
          index: 1,
          block: {
            type: 'tool_result',
            toolUseId: 'tool',
            toolName: 'Read',
            output: 'done',
            isError: false,
          },
        },
        { index: 2, block: { type: 'text', text: 'open' } },
      ],
    });
    normalizer.acknowledge(final);
    expect(nativeMap(normalizer, 'items').size).toBe(1);
    expect(nativeMap(normalizer, 'patchMessages').size).toBe(1);
    const finished = await normalizer.finish();
    expect(finished).toHaveLength(1);
    expect(finished[0]?.row.final).toBe(true);
    expect(nativeMap(normalizer, 'patchMessages').size).toBe(0);
    normalizer.acknowledge(finished);
    expect(nativeMap(normalizer, 'items').size).toBe(0);
  });
});

const command = {
  id: 'cmd',
  type: 'commandExecution',
  command: 'test',
  status: 'inProgress',
};

function results(changes: readonly DelegationTranscriptChange[]): unknown[] {
  return changes.flatMap(({ row }) =>
    row.blocks.filter((block) => block.type === 'tool_result'),
  );
}

describe('Codex turn settlement regression reds', () => {
  it('admits terminal-only command fallback', async () => {
    const normalizer = new DelegationChildNormalizer('agent');
    await codex(normalizer, 'turn/completed', {
      turn: {
        id: thread.turnId,
        items: [
          {
            ...command,
            status: 'completed',
            aggregatedOutput: 'terminal-only',
          },
        ],
      },
    });
    const final = [
      ...(await normalizer.settleTurn({ ...thread, kind: 'completed' })),
      ...(await normalizer.finish()),
    ];
    expect(results(final)).toEqual([
      expect.objectContaining({ output: 'terminal-only', isError: false }),
    ]);
  });

  it.each(['completed', 'inProgress'])(
    'reconciles terminal command status %s',
    async (status) => {
      const normalizer = new DelegationChildNormalizer('agent');
      await codex(normalizer, 'item/started', { item: command });
      await codex(normalizer, 'turn/completed', {
        turn: {
          id: thread.turnId,
          items: [{ ...command, status, aggregatedOutput: 'native-terminal' }],
        },
      });
      const final = [
        ...(await normalizer.settleTurn({ ...thread, kind: 'completed' })),
        ...(await normalizer.finish()),
      ];
      expect(results(final)).toEqual([
        expect.objectContaining({
          output: 'native-terminal',
          isError: status === 'inProgress',
        }),
      ]);
    },
  );

  it('settles unfinished outcome-only segments without latching the run', async () => {
    const normalizer = new DelegationChildNormalizer('agent');
    await codex(normalizer, 'item/started', { item: command });
    const final = await normalizer.settleTurn({ ...thread, kind: 'failed' });
    expect(results(final)).toEqual([
      expect.objectContaining({ isError: true }),
    ]);
    expect(
      await codex(normalizer, 'item/started', {
        item: { ...command, id: 'late' },
      }),
    ).toEqual([]);
    expect(nativeMap(normalizer, 'codexItems').size).toBe(1);
    const next = await codex(normalizer, 'item/completed', {
      turnId: 'turn-2',
      item: { ...command, status: 'completed', aggregatedOutput: 'next' },
    });
    expect(results(next)).toEqual([
      expect.objectContaining({ output: 'next' }),
    ]);
  });

  it('does not retain delta output or a transferred large seed in native state', async () => {
    const owner = memorySpools();
    const normalizer = new DelegationChildNormalizer('agent', {
      spools: owner,
    });
    await codex(normalizer, 'item/started', {
      item: { ...command, aggregatedOutput: 's'.repeat(1_000_000) },
    });
    for (let index = 0; index < 8; index++) {
      await codex(normalizer, 'item/commandExecution/outputDelta', {
        itemId: 'cmd',
        delta: 'd'.repeat(10_000),
      });
    }
    const retainedBytes = JSON.stringify([
      ...nativeMap(normalizer, 'codexItems').values(),
    ]).length;
    expect(retainedBytes).toBeLessThan(1_000);
    expect(
      JSON.stringify([...nativeMap(normalizer, 'commandOutputs').values()])
        .length,
    ).toBeLessThan(1_000);
    expect(owner.contents()).toEqual([
      's'.repeat(1_000_000) + 'd'.repeat(80_000),
    ]);
  });
});

interface MemoryHandle {
  key: string;
  text: string;
  discarded: boolean;
  reads: number;
  discards: number;
}
function memorySpools(
  before: (operation: CommandSpoolOperation) => Promise<void> = () =>
    Promise.resolve(),
): {
  acquire: (key: string) => ReturnType<DelegationCommandSpools['acquire']>;
  close: () => Promise<void>;
  handles: MemoryHandle[];
  contents: () => string[];
} {
  const handles: MemoryHandle[] = [];
  return {
    acquire: jest.fn(async (key: string) => {
      await before('create');
      const state = { key, text: '', discarded: false, reads: 0, discards: 0 };
      handles.push(state);
      return {
        append: jest.fn(async (value: string) => {
          await before('append');
          state.text += value;
        }),
        read: jest.fn(async () => {
          state.reads++;
          await before('read');
          return state.text;
        }),
        discard: jest.fn(async () => {
          state.discards++;
          await before('remove');
          state.discarded = true;
          state.text = '';
        }),
      };
    }),
    close: jest.fn(async () => {
      // Attempt every handle even when one close/removal fails.
      const failures: unknown[] = [];
      for (const state of handles) {
        try {
          await before('close');
        } catch (error) {
          failures.push(error);
        }
        try {
          await before('remove');
        } catch (error) {
          failures.push(error);
        }
        state.discarded = true;
        state.text = '';
      }
      if (failures.length) throw failures[0];
    }),
    handles,
    contents: () =>
      handles
        .filter((handle) => !handle.discarded)
        .map((handle) => handle.text),
  };
}

async function startCommand(
  normalizer: DelegationChildNormalizer,
  aggregatedOutput?: string | null,
): Promise<void> {
  await codex(normalizer, 'item/started', {
    item: { ...command, aggregatedOutput },
  });
}

function deltaCommand(
  normalizer: DelegationChildNormalizer,
  delta: string,
): Promise<readonly DelegationTranscriptChange[]> {
  return codex(normalizer, 'item/commandExecution/outputDelta', {
    itemId: command.id,
    delta,
  });
}

function endCommand(
  normalizer: DelegationChildNormalizer,
  aggregatedOutput?: string | null,
): Promise<readonly DelegationTranscriptChange[]> {
  return codex(normalizer, 'item/completed', {
    item: { ...command, status: 'completed', aggregatedOutput },
  });
}

describe('Codex command spool ownership', () => {
  it('transfers seed once, preserves null updates and joins deltas without retaining output', async () => {
    const owner = memorySpools();
    const normalizer = new DelegationChildNormalizer('agent', {
      spools: owner,
    });
    await startCommand(normalizer, 'seed');
    await deltaCommand(normalizer, '-one');
    await codex(normalizer, 'item/updated', {
      item: { ...command, aggregatedOutput: null },
    });
    await deltaCommand(normalizer, '-two');
    expect(
      JSON.stringify([...nativeMap(normalizer, 'commandOutputs').values()]),
    ).not.toContain('seed');
    expect(results(await endCommand(normalizer, null))).toEqual([
      expect.objectContaining({ output: 'seed-one-two', isError: false }),
    ]);
    expect(owner.handles).toEqual([
      expect.objectContaining({ reads: 1, discards: 1, discarded: true }),
    ]);
    expect(owner.acquire).toHaveBeenCalledTimes(1);
    await normalizer.close();
  });

  it('resets on string snapshots and repeated starts, discarding each old spool exactly once', async () => {
    const owner = memorySpools();
    const normalizer = new DelegationChildNormalizer('agent', {
      spools: owner,
    });
    await startCommand(normalizer, 'old');
    await deltaCommand(normalizer, '-tail');
    await codex(normalizer, 'item/updated', {
      item: { ...command, aggregatedOutput: 'replacement' },
    });
    await deltaCommand(normalizer, '-delta');
    await startCommand(normalizer, 'restart');
    await deltaCommand(normalizer, '-last');
    expect(results(await endCommand(normalizer))).toEqual([
      expect.objectContaining({ output: 'restart-last' }),
    ]);
    expect(
      owner.handles.map((handle) => [handle.reads, handle.discards]),
    ).toEqual([
      [0, 1],
      [0, 1],
      [1, 1],
    ]);
  });

  it.each(['aggregate', ''])(
    'a completion string %j replaces rather than concatenates spool output',
    async (aggregate) => {
      const owner = memorySpools();
      const normalizer = new DelegationChildNormalizer('agent', {
        spools: owner,
      });
      await startCommand(normalizer, 'seed');
      await deltaCommand(normalizer, '-delta');
      expect(results(await endCommand(normalizer, aggregate))).toEqual([
        expect.objectContaining({
          output: aggregate || 'Done',
          isError: false,
        }),
      ]);
      expect(owner.handles[0]).toEqual(
        expect.objectContaining({ reads: 0, discards: 1 }),
      );
    },
  );

  it.each([undefined, null, '', 'snapshot'])(
    'no-spool completion uses seed %j without acquiring or reading',
    async (seed) => {
      const owner = memorySpools();
      const normalizer = new DelegationChildNormalizer('agent', {
        spools: owner,
      });
      await deltaCommand(normalizer, 'ignored-before-start');
      await startCommand(normalizer, seed);
      await deltaCommand(normalizer, '');
      expect(results(await endCommand(normalizer))).toEqual([
        expect.objectContaining({ output: seed || 'Done' }),
      ]);
      expect(owner.acquire).not.toHaveBeenCalled();
    },
  );

  it('keeps the pre-existing late-Claude/patch finish fence while Codex finalization is asynchronous', async () => {
    const normalizer = new DelegationChildNormalizer('agent');
    await normalizer.claude({
      type: 'assistant',
      message: { id: 'before', content: [{ type: 'text', text: 'before' }] },
    });
    const finishing = normalizer.finish();
    expect(
      await normalizer.claude({
        type: 'assistant',
        message: { id: 'late', content: [{ type: 'text', text: 'late' }] },
      }),
    ).toEqual([]);
    expect(
      await normalizer.patch({
        provider: 'cursor',
        messageId: 'late',
        blocks: [{ type: 'text', text: 'late' }],
      }),
    ).toEqual([]);
    await finishing;
  });

  it('releases the shared finish promise after settlement rather than retaining acknowledged final bodies', async () => {
    const owner = memorySpools();
    const normalizer = new DelegationChildNormalizer('agent', {
      spools: owner,
    });
    await startCommand(normalizer, 'final-body');
    const final = await normalizer.finish();
    normalizer.acknowledge(final);
    expect(nativeMap(normalizer, 'items').size).toBe(0);
    expect(Reflect.get(normalizer, 'finishPromise')).toBeUndefined();
  });

  it('shares concurrent finish and close work and drains gated append before the single read', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operations: string[] = [];
    const owner = memorySpools(async (operation) => {
      operations.push(operation);
      if (operation === 'append') await gate;
    });
    const normalizer = new DelegationChildNormalizer('agent', {
      spools: owner,
    });
    await startCommand(normalizer);
    const append = deltaCommand(normalizer, 'gated');
    const first = normalizer.finish();
    const second = normalizer.finish();
    const close = normalizer.close();
    const anotherClose = normalizer.close();
    expect(first).toBe(second);
    expect(close).toBe(anotherClose);
    await Promise.resolve();
    expect(operations).not.toContain('read');
    release();
    await append;
    const final = await first;
    expect(await second).toBe(final);
    expect(results(final)).toEqual([
      expect.objectContaining({ output: 'gated', isError: true }),
    ]);
    await close;
    expect(owner.handles[0]?.reads).toBe(1);
    expect(owner.close).toHaveBeenCalledTimes(1);
  });

  it.each(['append', 'read'] as const)(
    'latches %s failure before failing removal cleanup and never publishes truncated output',
    async (failedOperation) => {
      const original = new Error('required storage failed');
      const removal = new Error('cleanup remove failed');
      const observations: string[] = [];
      const failures: unknown[] = [];
      const owner = memorySpools((operation): Promise<void> => {
        observations.push(operation);
        if (operation === 'remove') return Promise.reject(removal);
        return operation === failedOperation
          ? Promise.reject(original)
          : Promise.resolve();
      });
      const normalizer = new DelegationChildNormalizer('agent', {
        spools: owner,
        onStorageFailure: (error): void => {
          failures.push(error);
          observations.push('latched');
        },
      });
      await startCommand(normalizer);
      if (failedOperation === 'append')
        await expect(deltaCommand(normalizer, 'output')).rejects.toBe(original);
      else {
        await deltaCommand(normalizer, 'output');
        await expect(endCommand(normalizer)).rejects.toBe(original);
      }
      expect(failures).toEqual([original]);
      await expect(normalizer.finish()).rejects.toBe(original);
      await expect(normalizer.close()).rejects.toBe(removal);
      expect(observations.indexOf('latched')).toBeLessThan(
        observations.indexOf('close'),
      );
      expect(observations).toContain('remove');
      expect(owner.contents()).toEqual([]);
      expect(nativeMap(normalizer, 'items').size).toBe(1);
    },
  );
});

describe('Codex segment lifecycle', () => {
  it('settles the tracked turn without an outcome id, leaving unrelated published open rows unchanged', async () => {
    let now = 0;
    const normalizer = new DelegationChildNormalizer('agent', {
      now: (): number => now,
    });
    const unrelated = await normalizer.codex({
      method: 'item/started',
      params: {
        threadId: 'other',
        turnId: 'other-turn',
        item: { id: 'text', type: 'agentMessage', text: 'open' },
      },
    });
    now = 300;
    await codex(normalizer, 'turn/started', {});
    await startCommand(normalizer, 'partial');
    await normalizer.codex({
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'other',
        turnId: 'other-turn',
        itemId: 'text',
        delta: '-pending',
      },
    });
    const final = await normalizer.settleTurn({
      threadId: thread.threadId,
      kind: 'failed',
    });
    expect(results(final)).toEqual([
      expect.objectContaining({ output: 'partial', isError: true }),
    ]);
    expect(final.filter(({ row }) => row.final)).toHaveLength(1);
    expect(final.some(({ row }) => row.id === unrelated[0]?.row.id)).toBe(
      false,
    );
    expect(await normalizer.settleTurn({ ...thread, kind: 'failed' })).toEqual(
      [],
    );
    expect(results(await normalizer.finish())).toEqual([]);
  });

  it('reconciles mixed terminal-only prose/reasoning and notified finals once, preserving final identity through wrong and matching acknowledgements', async () => {
    const normalizer = new DelegationChildNormalizer('agent');
    const notified = await endCommand(normalizer, 'notified');
    await codex(normalizer, 'turn/completed', {
      turn: {
        id: thread.turnId,
        items: [
          {
            ...command,
            status: 'completed',
            aggregatedOutput: 'must-not-replace',
          },
          { id: 'prose', type: 'agentMessage', text: 'terminal prose' },
          {
            id: 'thought',
            type: 'reasoning',
            summary: ['terminal reasoning'],
            content: [],
          },
        ],
      },
    });
    const final = await normalizer.settleTurn({ ...thread, kind: 'completed' });
    expect(final).toHaveLength(2);
    expect(text(final)).toContain('terminal prose');
    expect(text(final)).toContain('terminal reasoning');
    const row = notified[0]?.row;
    const before = [...nativeMap(normalizer, 'items').values()];
    if (!row) throw new Error('missing final');
    normalizer.acknowledge([
      { row: { ...row, itemRevision: row.itemRevision + 1 } },
    ]);
    expect([...nativeMap(normalizer, 'items').values()]).toEqual(before);
    expect(await endCommand(normalizer, 'late')).toEqual([]);
    normalizer.acknowledge(notified);
    normalizer.acknowledge(final);
    expect(nativeMap(normalizer, 'items').size).toBe(0);
    expect(await normalizer.finish()).toEqual([]);
  });

  it.each(['completed', 'failed', 'declined', 'inProgress'])(
    'uses native terminal %s status with absent aggregate and exact spooled output',
    async (status) => {
      const owner = memorySpools();
      const normalizer = new DelegationChildNormalizer('agent', {
        spools: owner,
      });
      await startCommand(normalizer, 'prefix');
      await deltaCommand(normalizer, '-partial');
      await codex(normalizer, 'turn/completed', {
        turn: {
          id: thread.turnId,
          items: [{ ...command, status, aggregatedOutput: null }],
        },
      });
      const final = await normalizer.settleTurn({
        ...thread,
        kind: 'interrupted',
      });
      expect(results(final)).toEqual([
        expect.objectContaining({
          output: 'prefix-partial',
          isError: status !== 'completed',
        }),
      ]);
      expect(owner.contents()).toEqual([]);
      expect(owner.handles[0]).toEqual(
        expect.objectContaining({ reads: 1, discards: 1 }),
      );
    },
  );

  it('global finish publishes only once per item after all interleaved segments settle', async () => {
    const normalizer = new DelegationChildNormalizer('agent', {
      now: (): number => 0,
    });
    normalizer.acknowledge(
      await normalizer.claude({
        type: 'assistant',
        message: {
          id: 'window',
          content: [{ type: 'text', text: 'published' }],
        },
      }),
    );
    await normalizer.codex({
      method: 'turn/started',
      params: { threadId: 'a', turnId: 'a' },
    });
    await normalizer.codex({
      method: 'item/started',
      params: { threadId: 'b', turnId: 'b', item: command },
    });
    await normalizer.codex({
      method: 'item/started',
      params: { threadId: 'a', turnId: 'a', item: command },
    });
    const final = await normalizer.finish();
    expect(final).toHaveLength(2);
    expect(new Set(final.map(({ row }) => row.id)).size).toBe(2);
    expect(final.every(({ row }) => row.final && row.itemRevision === 0)).toBe(
      true,
    );
  });

  it('never shares an unknown-turn fence across start failures or threads', async () => {
    const normalizer = new DelegationChildNormalizer('agent');
    const send = (
      threadId: string,
      method: string,
      item: Record<string, unknown>,
    ): Promise<readonly DelegationTranscriptChange[]> =>
      normalizer.codex({ method, params: { threadId, item } });
    await send('no-id', 'item/started', command);
    const old = await normalizer.settleTurn({
      threadId: 'no-id',
      kind: 'failed',
    });
    expect(results(old)).toEqual([expect.objectContaining({ isError: true })]);
    await normalizer.codex({
      method: 'turn/started',
      params: { threadId: 'no-id' },
    });
    const next = await send('no-id', 'item/completed', {
      ...command,
      status: 'completed',
      aggregatedOutput: 'next',
    });
    expect(results(next)).toEqual([
      expect.objectContaining({ output: 'next' }),
    ]);
    expect(next[0]?.row.delegationSegment).not.toBe(
      old[0]?.row.delegationSegment,
    );
    const other = await send('other-no-id', 'item/completed', {
      ...command,
      status: 'completed',
      aggregatedOutput: 'other',
    });
    expect(results(other)).toEqual([
      expect.objectContaining({ output: 'other' }),
    ]);
    expect(
      [...nativeMap(normalizer, 'codexSegments').keys()].join(' '),
    ).not.toContain('turn-unknown');
  });

  it('preserves canonical explicit-empty precedence without changing the legacy recorder fallback', async () => {
    const normalizer = new DelegationChildNormalizer('agent', {
      spools: memorySpools(),
    });
    const legacy = new DelegationTranscriptRecorder();
    const events = [
      { method: 'item/started', params: { ...thread, item: command } },
      {
        method: 'item/commandExecution/outputDelta',
        params: { ...thread, itemId: command.id, delta: 'streamed' },
      },
      {
        method: 'item/completed',
        params: {
          ...thread,
          item: { ...command, status: 'completed', aggregatedOutput: '' },
        },
      },
    ];
    let final: readonly DelegationTranscriptChange[] = [];
    for (const event of events) {
      final = await normalizer.codex(event);
      legacy.codex(event);
    }
    expect(results(final)).toEqual([
      expect.objectContaining({ output: 'Done' }),
    ]);
    expect(legacy.snapshot()).toEqual([
      expect.objectContaining({ output: 'streamed' }),
    ]);
  });

  it('counts closed-segment drops once without allocations and permits reused ids on a new turn', async () => {
    const diagnostics = jest.fn();
    const owner = memorySpools();
    const normalizer = new DelegationChildNormalizer('agent', {
      spools: owner,
      onDiagnostic: diagnostics,
    });
    await startCommand(normalizer);
    await deltaCommand(normalizer, 'first');
    const final = await normalizer.settleTurn({ ...thread, kind: 'failed' });
    normalizer.acknowledge(final);
    await startCommand(normalizer, 'late');
    await deltaCommand(normalizer, 'late');
    await endCommand(normalizer, 'late');
    // Thread-level events after the terminal event name no item; not drops.
    await normalizer.codex({
      method: 'thread/status/changed',
      params: { threadId: 'thread-1', status: { type: 'idle' } },
    });
    await codex(normalizer, 'thread/tokenUsage/updated', { tokenUsage: {} });
    expect(nativeMap(normalizer, 'items').size).toBe(0);
    expect(nativeMap(normalizer, 'codexItems').size).toBe(0);
    expect(owner.acquire).toHaveBeenCalledTimes(1);
    const next = await codex(normalizer, 'item/completed', {
      turnId: 'new',
      item: { ...command, status: 'completed', aggregatedOutput: 'new-turn' },
    });
    expect(results(next)).toEqual([
      expect.objectContaining({ output: 'new-turn', isError: false }),
    ]);
    await normalizer.close();
    await normalizer.close();
    // A provider event after the run closed the normalizer is inert.
    await expect(deltaCommand(normalizer, 'after close')).resolves.toEqual([]);
    await expect(
      normalizer.settleTurn({ ...thread, turnId: 'new', kind: 'completed' }),
    ).resolves.toEqual([]);
    expect(diagnostics).toHaveBeenCalledTimes(1);
    expect(diagnostics).toHaveBeenCalledWith({
      kind: 'closed-segment-events',
      segment: 'codex:thread-1:turn-1',
      count: 3,
    });
  });
});

interface CapturedEvent {
  method: string;
  params: Record<string, unknown>;
}

function capturedTurn(name: 'completed' | 'interrupted'): CapturedEvent[] {
  const parsed: unknown = JSON.parse(
    readFileSync(
      join(__dirname, 'fixtures', 'codex-command-turn-ordering.json'),
      'utf8',
    ),
  );
  const turns =
    typeof parsed === 'object' && parsed !== null && 'turns' in parsed
      ? parsed.turns
      : undefined;
  const events: unknown =
    typeof turns === 'object' && turns !== null
      ? Object.entries(turns).find(([key]) => key === name)?.[1]
      : undefined;
  if (!Array.isArray(events)) throw new Error(`missing captured ${name} turn`);
  return events.flatMap((event: unknown) =>
    typeof event === 'object' &&
    event !== null &&
    'method' in event &&
    typeof event.method === 'string' &&
    'params' in event &&
    typeof event.params === 'object' &&
    event.params !== null &&
    !Array.isArray(event.params)
      ? [{ method: event.method, params: { ...event.params } }]
      : [],
  );
}

describe('captured bundled Codex turn ordering (F3)', () => {
  async function replay(
    name: 'completed' | 'interrupted',
    kind: 'completed' | 'interrupted',
  ): Promise<{
    normalizer: DelegationChildNormalizer;
    changes: DelegationTranscriptChange[];
    diagnostics: jest.Mock;
    threadId: string;
    turnId: string;
  }> {
    const diagnostics = jest.fn();
    const normalizer = new DelegationChildNormalizer('agent', {
      spools: memorySpools(),
      onDiagnostic: diagnostics,
    });
    const events = capturedTurn(name);
    const terminal = events.at(-1);
    // The capture's last event is the turn's terminal event.
    expect(terminal?.method).toBe('turn/completed');
    const changes: DelegationTranscriptChange[] = [];
    for (const event of events) {
      const emitted = await normalizer.codex(event);
      normalizer.acknowledge(emitted);
      changes.push(...emitted);
    }
    const threadId = `${name}-thread`;
    const turnId = `${name}-turn`;
    const settled = await normalizer.settleTurn({ threadId, turnId, kind });
    normalizer.acknowledge(settled);
    changes.push(...settled);
    return { normalizer, changes, diagnostics, threadId, turnId };
  }

  it('finalizes a completed command from its completion aggregate, not its partial deltas', async () => {
    const { normalizer, changes, diagnostics } = await replay(
      'completed',
      'completed',
    );
    // The runtime streamed only lines 3-5; the completion carries all five.
    expect(results(changes)).toEqual([
      expect.objectContaining({
        output: 'line1\nline2\nline3\nline4\nline5\n',
        isError: false,
      }),
    ]);
    expect(changes.filter(({ row }) => row.final)).toHaveLength(
      new Set(changes.map(({ row }) => row.id)).size,
    );
    await normalizer.close();
    expect(diagnostics).not.toHaveBeenCalled();
  });

  it('finalizes an interrupted command that never completes, and counts a hypothetical late completion', async () => {
    const { normalizer, changes, diagnostics, threadId, turnId } = await replay(
      'interrupted',
      'interrupted',
    );
    // The bundled runtime sends no item/completed for the running command.
    expect(results(changes)).toEqual([
      expect.objectContaining({ isError: true }),
    ]);
    const command = capturedTurn('interrupted').find(
      (event) =>
        event.method === 'item/started' &&
        typeof event.params.item === 'object' &&
        event.params.item !== null &&
        'type' in event.params.item &&
        event.params.item.type === 'commandExecution',
    );
    expect(command).toBeDefined();
    const item =
      typeof command?.params.item === 'object' ? command.params.item : {};
    const late = await normalizer.codex({
      method: 'item/completed',
      params: {
        threadId,
        turnId,
        item: { ...item, status: 'completed', aggregatedOutput: 'late' },
      },
    });
    expect(late).toEqual([]);
    await normalizer.close();
    expect(diagnostics).toHaveBeenCalledWith({
      kind: 'closed-segment-events',
      segment: `codex:${threadId}:${turnId}`,
      count: 1,
    });
  });
});
