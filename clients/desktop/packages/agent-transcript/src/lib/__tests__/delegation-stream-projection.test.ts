import type { PersistedChatBlock } from '../../types';
import { TOOL_OUTPUT_INLINE_BYTES } from '../../transcript-storage';
import { delegationLivePreview } from '../delegation-live-preview';
import {
  DelegationChildRowBuilder,
  projectDelegationAssistantPatch,
  type DelegationLogicalItem,
} from '../delegation-stream-projection';

function textBlock(text: string): PersistedChatBlock {
  return { type: 'text', text };
}

function logicalItem(
  id: string,
  text: string,
  options: Partial<DelegationLogicalItem> = {},
): DelegationLogicalItem {
  return {
    id,
    role: 'assistant',
    blocks: [textBlock(text)],
    final: false,
    segment: 'segment-1',
    timestamp: 100,
    ...options,
  };
}

describe('DelegationChildRowBuilder', () => {
  it('keeps first-observation order, timestamp, and segment stable', () => {
    const builder = new DelegationChildRowBuilder('agent-block');
    const first = logicalItem('first', 'one');
    const second = logicalItem('second', 'two', {
      timestamp: 200,
      segment: 'turn-2',
    });

    const initialRows = builder.update([first, second]);
    expect(initialRows.map((row) => row.id)).toEqual([
      'agent-block:first',
      'agent-block:second',
    ]);
    expect(initialRows.map((row) => row.delegationSequence)).toEqual([0, 1]);
    expect(initialRows.map((row) => row.itemRevision)).toEqual([0, 0]);

    const reordered = builder.update([
      logicalItem('second', 'two changed', {
        timestamp: 999,
        segment: 'later-turn',
      }),
      logicalItem('first', 'one'),
    ]);
    expect(reordered.map((row) => row.id)).toEqual([
      'agent-block:first',
      'agent-block:second',
    ]);
    expect(reordered[1]).toMatchObject({
      timestamp: 200,
      delegationSegment: 'turn-2',
      itemRevision: 1,
    });
  });

  it('increments only for changed content or final and latches final rows', () => {
    const builder = new DelegationChildRowBuilder('agent-block');
    builder.update([logicalItem('item', 'same')]);

    const unchanged = builder.update([
      logicalItem('item', 'same', { timestamp: 500, segment: 'new-segment' }),
    ])[0];
    expect(unchanged).toMatchObject({
      timestamp: 100,
      delegationSegment: 'segment-1',
      itemRevision: 0,
    });

    const changed = builder.update([logicalItem('item', 'changed')])[0];
    expect(changed.itemRevision).toBe(1);
    expect(
      builder.update([logicalItem('item', 'changed')])[0].itemRevision,
    ).toBe(1);

    const finalized = builder.update([
      logicalItem('item', 'changed', { final: true }),
    ])[0];
    expect(finalized).toMatchObject({ final: true, itemRevision: 2 });

    const late = builder.update([
      logicalItem('item', 'late overwrite', {
        final: false,
        timestamp: 800,
        segment: 'late-segment',
      }),
    ])[0];
    expect(late).toMatchObject({
      final: true,
      itemRevision: 2,
      timestamp: 100,
      delegationSegment: 'segment-1',
    });
    expect(late.blocks).toEqual([textBlock('changed')]);
  });

  it('snapshots both input blocks and returned rows', () => {
    const builder = new DelegationChildRowBuilder('agent-block');
    const block = textBlock('snapshot');
    const input = logicalItem('item', 'snapshot', { blocks: [block] });
    const rows = builder.update([input]);
    if (block.type === 'text') block.text = 'mutated input';

    const rowBlock = rows[0].blocks[0];
    if (rowBlock.type === 'text') rowBlock.text = 'mutated output';

    const next = builder.update([
      logicalItem('item', 'snapshot', { blocks: [textBlock('snapshot')] }),
    ])[0];
    expect(next.blocks).toEqual([textBlock('snapshot')]);
    expect(next.itemRevision).toBe(0);
  });
});

describe('projectDelegationAssistantPatch', () => {
  it('groups tool results by use id and finalizes prose only explicitly', () => {
    const projected = projectDelegationAssistantPatch(
      undefined,
      {
        role: 'system',
        messageId: 'delegate-message',
        timestamp: 123,
        patches: [
          {
            index: 0,
            block: {
              type: 'tool_use',
              toolUseId: 'tool-1',
              toolName: 'raw-tool-name',
              input: '{"raw":true}',
              display: { toolName: 'Friendly tool', input: 'display input' },
            },
          },
          {
            index: 1,
            block: {
              type: 'tool_result',
              toolUseId: 'tool-1',
              toolName: 'raw-tool-name',
              output: 'done',
              isError: false,
            },
          },
          { index: 2, block: { type: 'thinking', text: 'working' } },
        ],
      },
      'native-turn-1',
    );

    expect(projected).toBeDefined();
    expect(projected?.message.role).toBe('system');
    expect(projected?.items).toEqual([
      {
        id: 'delegate-message:tool-1',
        role: 'system',
        blocks: [
          {
            type: 'tool_use',
            toolUseId: 'tool-1',
            toolName: 'raw-tool-name',
            input: '{"raw":true}',
            display: { toolName: 'Friendly tool', input: 'display input' },
          },
          {
            type: 'tool_result',
            toolUseId: 'tool-1',
            toolName: 'raw-tool-name',
            output: 'done',
            isError: false,
          },
        ],
        final: true,
        segment: 'native-turn-1',
        timestamp: 123,
      },
      {
        id: 'delegate-message:2',
        role: 'system',
        blocks: [{ type: 'thinking', text: 'working' }],
        final: false,
        segment: 'native-turn-1',
        timestamp: 123,
      },
    ]);

    const finalized = projectDelegationAssistantPatch(
      projected?.message,
      {
        role: 'system',
        messageId: 'delegate-message',
        timestamp: 124,
        patches: [{ index: 2, appendText: ' now' }],
      },
      'native-turn-2',
      true,
    );
    expect(finalized?.items[0].final).toBe(true);
    expect(finalized?.items[1]).toMatchObject({
      id: 'delegate-message:2',
      blocks: [{ type: 'thinking', text: 'working now' }],
      final: true,
      segment: 'native-turn-2',
      timestamp: 124,
    });
  });
});

describe('projectDelegationAssistantPatch unmatched results', () => {
  it('keeps a tool result whose start was not observed', () => {
    const projected = projectDelegationAssistantPatch(
      undefined,
      {
        role: 'assistant',
        messageId: 'result-only',
        timestamp: 7,
        patches: [
          {
            index: 0,
            block: {
              type: 'tool_result',
              toolUseId: 'tool-9',
              toolName: 'bash',
              output: 'permission denied',
              isError: true,
            },
          },
        ],
      },
      'native-turn-9',
    );

    expect(projected?.items).toEqual([
      {
        id: 'result-only:tool-9',
        role: 'assistant',
        blocks: [
          {
            type: 'tool_result',
            toolUseId: 'tool-9',
            toolName: 'bash',
            output: 'permission denied',
            isError: true,
          },
        ],
        final: true,
        segment: 'native-turn-9',
        timestamp: 7,
      },
    ]);
  });
});

describe('DelegationChildRowBuilder publication state', () => {
  it('allocates contiguous revisions at publication despite coalescing', () => {
    const builder = new DelegationChildRowBuilder('agent');
    builder.observe(logicalItem('a', 'one'));
    expect(builder.take('all')[0].itemRevision).toBe(0);
    for (const text of ['two', 'three', 'four']) {
      builder.observe(logicalItem('a', text));
      expect(builder.take('final')).toEqual([]);
    }
    expect(builder.take('all')[0]).toMatchObject({
      itemRevision: 1,
      blocks: [textBlock('four')],
    });
    builder.observe(logicalItem('a', 'five'));
    builder.observe(logicalItem('a', 'six', { final: true }));
    expect(builder.take('final')[0]).toMatchObject({
      itemRevision: 2,
      final: true,
    });
    expect(builder.take('all')).toEqual([]);
  });

  it('assigns sequence at observation and flushes only never-published predecessors of finals', () => {
    const builder = new DelegationChildRowBuilder('agent');
    builder.observe(logicalItem('published', 'old'));
    builder.take('all');
    builder.observe(logicalItem('published', 'dirty but already published'));
    builder.observe(
      logicalItem('early', 'first', { timestamp: 20, segment: 'original' }),
    );
    builder.observe(logicalItem('middle', 'middle'));
    builder.observe(logicalItem('later-final', 'last', { final: true }));
    builder.observe(logicalItem('after', 'after'));
    builder.observe(
      logicalItem('early', 'latest', { timestamp: 999, segment: 'changed' }),
    );
    const rows = builder.take('final');
    expect(
      rows.map((row) => [row.id, row.delegationSequence, row.itemRevision]),
    ).toEqual([
      ['agent:early', 1, 0],
      ['agent:middle', 2, 0],
      ['agent:later-final', 3, 0],
    ]);
    expect(rows[0]).toMatchObject({
      timestamp: 20,
      delegationSegment: 'original',
      blocks: [textBlock('latest')],
    });
    expect(builder.take('final')).toEqual([]);
    expect(
      builder.take('all').map((row) => [row.id, row.itemRevision]),
    ).toEqual([
      ['agent:published', 1],
      ['agent:after', 0],
    ]);
  });

  it('does not republish identical content or allocate revisions for changes reverted before take', () => {
    const builder = new DelegationChildRowBuilder('agent');
    builder.observe(logicalItem('a', 'same'));
    builder.take('all');
    builder.observe(logicalItem('a', 'different'));
    builder.observe(
      logicalItem('a', 'same', { timestamp: 500, segment: 'ignored' }),
    );
    expect(builder.take('all')).toEqual([]);
    builder.observe(
      logicalItem('a', 'same', {
        role: 'user',
        author: { kind: 'user' },
        delivery: 'follow_up',
      }),
    );
    expect(builder.take('all')[0]).toMatchObject({
      itemRevision: 1,
      role: 'user',
      delegationAuthor: { kind: 'user' },
      delegationDelivery: 'follow_up',
    });
    builder.observe(
      logicalItem('a', 'same', {
        role: 'user',
        author: { kind: 'user' },
        delivery: 'follow_up',
      }),
    );
    expect(builder.take('all')).toEqual([]);
    builder.observe(
      logicalItem('a', 'same', {
        final: true,
        role: 'user',
        author: { kind: 'user' },
        delivery: 'follow_up',
      }),
    );
    expect(builder.take('final')[0].itemRevision).toBe(2);
  });

  it('evicts only an exactly acknowledged published final and retains a rejecting tombstone', () => {
    const builder = new DelegationChildRowBuilder('agent');
    builder.observe(logicalItem('a', 'open'));
    builder.take('all');
    const retained = builder['observed'].get('agent:a');
    builder.evict('agent:a', 0); // Open acknowledgements cannot remove content.
    expect(builder['observed'].get('agent:a')).toBe(retained);
    builder.observe(logicalItem('a', 'final', { final: true }));
    builder.evict('agent:a', 0); // A stale acknowledgement before publication cannot erase the final.
    expect(builder['observed'].get('agent:a')).toBe(retained);
    expect(builder.take('final')[0]).toMatchObject({
      itemRevision: 1,
      final: true,
    });
    builder.evict('agent:a', 0);
    expect(builder['observed'].get('agent:a')).toBe(retained);
    expect(builder.observe(logicalItem('a', 'late'))).toBe(false);
    builder.evict('agent:a', 2);
    builder.evict('a', 1); // Logical ids must not match published row ids.
    expect(builder['observed'].get('agent:a')).toBe(retained);
    builder.evict('agent:a', 1);
    expect(builder['observed'].get('agent:a')).toEqual({
      sequence: 0,
      revision: 1,
      final: true,
    });
    expect(builder['dirty'].size).toBe(0);
    expect(builder['dirtyFinals'].size).toBe(0);
    expect(builder['unpublished'].size).toBe(0);
    builder.evict('agent:a', 1); // Idempotent acknowledgement.
    expect(
      builder.observe(logicalItem('a', 'resurrect', { final: true })),
    ).toBe(false);
    expect(builder.take('all')).toEqual([]);
    builder.observe(logicalItem('b', 'next', { final: true }));
    expect(builder.take('final')[0]).toMatchObject({
      id: 'agent:b',
      delegationSequence: 1,
      itemRevision: 0,
    });
  });

  it('keeps observe by reference and snapshots publications independently of input and output', () => {
    const builder = new DelegationChildRowBuilder('agent');
    const input = logicalItem('a', 'observed');
    const clone = jest.spyOn(globalThis, 'structuredClone');
    try {
      builder.observe(input);
      expect(clone).not.toHaveBeenCalled();
      input.blocks = [textBlock('changed before publication')];
      const rows = builder.take('all');
      expect(rows[0].blocks).toEqual([textBlock('changed before publication')]);
      rows[0].blocks = [textBlock('caller mutation')];
      input.blocks = [textBlock('input mutation')];
      builder.observe(logicalItem('a', 'changed before publication'));
      expect(builder.take('all')).toEqual([]);
    } finally {
      clone.mockRestore();
    }
  });

  it('publishes a final before its first tick at revision zero', () => {
    const builder = new DelegationChildRowBuilder('agent');
    builder.observe(logicalItem('a', 'one'));
    builder.observe(logicalItem('a', 'two'));
    builder.observe(logicalItem('a', 'complete', { final: true }));
    expect(builder.observe(logicalItem('a', 'late before publication'))).toBe(
      false,
    );
    expect(builder.take('final')[0]).toMatchObject({
      itemRevision: 0,
      final: true,
      blocks: [textBlock('complete')],
    });
    expect(builder.observe(logicalItem('a', 'late'))).toBe(false);
  });

  it('materializes only touched rows across 65,537 final events', () => {
    const builder = new DelegationChildRowBuilder('agent');
    let published = 0;
    for (let index = 0; index < 65_537; index += 1) {
      builder.observe(logicalItem(String(index), 'small', { final: true }));
      const rows = builder.take('final');
      expect(rows).toHaveLength(1);
      published += rows.length;
      builder.evict(rows[0].id, rows[0].itemRevision);
    }
    expect(published).toBe(65_537);
    expect(builder.materializedRows).toBe(published);
    expect(builder.take('all')).toEqual([]);
  });

  it('does no historical work on final-only ticks with dirty open rows', () => {
    const builder = new DelegationChildRowBuilder('agent');
    builder.observe(logicalItem('a', 'first'));
    for (let index = 0; index < 100; index += 1) {
      builder.observe(logicalItem('a', String(index)));
      expect(builder.take('final')).toEqual([]);
    }
    expect(builder.materializedRows).toBe(0);
    expect(builder.take('all')).toHaveLength(1);
    expect(builder.materializedRows).toBe(1);
  });
});

describe('DelegationChildRowBuilder live previews', () => {
  it.each(['text', 'thinking', 'tool_use'] as const)(
    'previews open %s fields only when materialized and leaves final fields whole',
    (type) => {
      const builder = new DelegationChildRowBuilder('agent');
      const whole = 'x'.repeat(TOOL_OUTPUT_INLINE_BYTES + 10);
      const block: PersistedChatBlock =
        type === 'tool_use'
          ? { type, input: whole, toolUseId: 'tool', toolName: 'bash' }
          : { type, text: whole };
      builder.observe(logicalItem('a', '', { blocks: [block] }));
      expect(builder.take('final')).toEqual([]);
      const previewBlock = builder.take('all')[0].blocks[0];
      expect(previewBlock).toEqual(
        type === 'tool_use'
          ? { ...block, input: delegationLivePreview(whole) }
          : { ...block, text: delegationLivePreview(whole) },
      );
      expect(block).toEqual(
        type === 'tool_use'
          ? { ...block, input: whole }
          : { ...block, text: whole },
      );
      builder.observe(logicalItem('a', '', { blocks: [block], final: true }));
      expect(builder.take('final')[0]).toMatchObject({
        itemRevision: 1,
        blocks: [block],
      });
    },
  );

  it('coalesces identical previews even when omitted middle text changes', () => {
    const builder = new DelegationChildRowBuilder('agent');
    const edge = 'x'.repeat(TOOL_OUTPUT_INLINE_BYTES);
    builder.observe(logicalItem('a', edge + 'first omitted middle' + edge));
    builder.take('all');
    builder.observe(logicalItem('a', edge + 'different omitted middle' + edge));
    expect(builder.take('all')).toEqual([]);
    builder.observe(
      logicalItem('a', edge + 'different omitted middle' + edge, {
        final: true,
      }),
    );
    expect(builder.take('final')[0].itemRevision).toBe(1);
  });

  it('leaves tool results and already-final large rows untouched', () => {
    const builder = new DelegationChildRowBuilder('agent');
    const whole = '界'.repeat(TOOL_OUTPUT_INLINE_BYTES);
    const result: PersistedChatBlock = {
      type: 'tool_result',
      toolUseId: 'tool',
      toolName: 'bash',
      output: whole,
      isError: false,
    };
    builder.observe(logicalItem('a', '', { blocks: [result] }));
    expect(builder.take('all')[0].blocks).toEqual([result]);
    builder.observe(logicalItem('b', whole, { final: true }));
    expect(builder.take('final')[0].blocks).toEqual([textBlock(whole)]);
  });
});

describe('projectDelegationAssistantPatch indexed pairing', () => {
  it('pairs 200 tool uses with their results and preserves repeated-id and orphan order', () => {
    const blocks: PersistedChatBlock[] = [];
    for (let index = 0; index < 200; index += 1) {
      blocks.push({
        type: 'tool_use',
        toolUseId: `tool-${index}`,
        toolName: 'bash',
        input: String(index),
      });
    }
    for (let index = 199; index >= 0; index -= 1) {
      blocks.push({
        type: 'tool_result',
        toolUseId: `tool-${index}`,
        toolName: 'bash',
        output: String(index),
        isError: false,
      });
    }
    blocks.push(
      {
        type: 'tool_result',
        toolUseId: 'repeat',
        toolName: 'bash',
        output: 'first',
        isError: false,
      },
      {
        type: 'tool_use',
        toolUseId: 'repeat',
        toolName: 'bash',
        input: 'first use',
      },
      {
        type: 'tool_use',
        toolUseId: 'repeat',
        toolName: 'bash',
        input: 'second use',
      },
      {
        type: 'tool_result',
        toolUseId: 'repeat',
        toolName: 'bash',
        output: 'second',
        isError: false,
      },
      {
        type: 'tool_use',
        toolUseId: 'missing',
        toolName: 'bash',
        input: 'no result',
      },
      {
        type: 'tool_result',
        toolUseId: 'orphan',
        toolName: 'bash',
        output: 'orphan',
        isError: true,
      },
      {
        type: 'tool_result',
        toolUseId: 'repeat',
        toolName: 'bash',
        output: 'extra',
        isError: false,
      },
    );
    const projected = projectDelegationAssistantPatch(
      undefined,
      {
        messageId: 'message',
        role: 'assistant',
        timestamp: 10,
        patches: blocks.map((block, index) => ({ index, block })),
      },
      'segment',
    );
    expect(projected?.items).toHaveLength(205);
    for (let index = 0; index < 200; index += 1) {
      expect(projected?.items[index]).toMatchObject({
        id: `message:tool-${index}`,
        final: true,
        blocks: [blocks[index], blocks[399 - index]],
      });
    }
    expect(
      projected?.items
        .slice(200)
        .map((item) => [item.id, item.final, item.blocks]),
    ).toEqual([
      ['message:repeat', true, [blocks[401], blocks[400]]],
      ['message:repeat', true, [blocks[402], blocks[403]]],
      ['message:missing', false, [blocks[404]]],
      ['message:orphan', true, [blocks[405]]],
      ['message:repeat', true, [blocks[406]]],
    ]);
  });
});
