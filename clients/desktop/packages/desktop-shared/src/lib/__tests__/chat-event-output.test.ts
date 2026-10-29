import type { ChatEvent } from '../../types';
import {
  ChatEventOutputDecoder,
  ChatEventOutputEncoder,
  type ChatEventMessage,
} from '../chat-event-output';
import { clampOutputTail } from '../output-append';

const NOTICE = '[truncated earlier command output]\n';
const LIMIT = 2_048;

function chatEvent(data: unknown, chatId = 'chat-1'): ChatEvent {
  return { projectId: 'project-1', worktreeId: 'wt-1', chatId, data };
}

function commandItem(
  id: string,
  output: string,
  status = 'inProgress',
): Record<string, unknown> {
  return {
    type: 'command_execution',
    id,
    command: 'npm test',
    aggregated_output: output,
    status,
    exit_code: null,
  };
}

function codexEvent(
  type: string,
  item: Record<string, unknown>,
  threadId?: string,
): ChatEvent {
  return chatEvent({
    type: 'codex',
    event: {
      type,
      item,
      ...(threadId ? { thread_id: threadId, turn_id: 'turn-1' } : {}),
    },
  });
}

/** A long command's events as main emits them: growing, then clamped, output. */
function longCommandEvents(
  itemId: string,
  updates: number,
  threadId?: string,
  varyLines = true,
): ChatEvent[] {
  const events: ChatEvent[] = [
    codexEvent('item.started', commandItem(itemId, ''), threadId),
  ];
  let output = '';
  for (let index = 0; index < updates; index += 1) {
    output = clampOutputTail(
      `${output}${itemId} line ${String(index).padStart(4, '0')} ${'x'.repeat(varyLines ? index % 40 : 20)}\n`,
      LIMIT,
      NOTICE,
    );
    events.push(
      codexEvent('item.updated', commandItem(itemId, output), threadId),
    );
  }
  events.push(
    codexEvent(
      'item.completed',
      commandItem(itemId, output, 'completed'),
      threadId,
    ),
  );
  return events;
}

function interleave(...streams: ChatEvent[][]): ChatEvent[] {
  const result: ChatEvent[] = [];
  const longest = Math.max(...streams.map((stream) => stream.length));
  for (let index = 0; index < longest; index += 1) {
    for (const stream of streams) {
      const event = stream[index];
      if (event) result.push(event);
    }
  }
  return result;
}

function newPipe(): {
  encoder: ChatEventOutputEncoder;
  page: () => ChatEventOutputDecoder;
  resets: string[];
} {
  let rev = 0;
  let epoch = 0;
  const resets: string[] = [];
  const encoder = new ChatEventOutputEncoder({
    nextRev: (): number => ++rev,
    heads: [NOTICE],
  });
  return {
    encoder,
    resets,
    page: () =>
      new ChatEventOutputDecoder({
        newEpoch: (): string => `epoch-${++epoch}`,
        requestReset: (value): Promise<void> => {
          resets.push(value);
          return Promise.resolve();
        },
      }),
  };
}

/** Structured clone, as IPC does, so nothing is shared by reference. */
function overIpc(message: ChatEvent | ChatEventMessage): ChatEventMessage {
  return structuredClone(message);
}

function byteLength(message: unknown): number {
  return Buffer.byteLength(JSON.stringify(message));
}

describe('Codex command output over chat:event', () => {
  it('delivers exactly the events main produced, key order included', () => {
    const events = [
      chatEvent({ type: 'codex', event: { type: 'turn.started' } }),
      ...interleave(
        longCommandEvents('cmd-a', 120),
        longCommandEvents('cmd-b', 40, 'thread-sub'),
      ),
      chatEvent({ type: 'codex', event: { type: 'turn.completed' } }),
      chatEvent({ type: 'result', subtype: 'success' }),
    ];
    const { encoder, page } = newPipe();
    const decoder = page();
    encoder.reset('epoch-1');

    const decoded = events.map((event) =>
      decoder.decode(overIpc(encoder.encode(event))),
    );

    expect(decoded).toStrictEqual(events);
    expect(decoded.map((event) => JSON.stringify(event))).toEqual(
      events.map((event) => JSON.stringify(event)),
    );
  });

  it('keeps IPC bytes per update flat as the output grows, through the clamp', () => {
    const events = longCommandEvents('cmd-a', 400, undefined, false).filter(
      (event) =>
        JSON.stringify(event).includes('"item.updated"') &&
        !JSON.stringify(event).includes('"completed"'),
    );
    const { encoder, page } = newPipe();
    const decoder = page();
    encoder.reset('epoch-1');
    const sentBytes = events.map((event) => {
      const message = encoder.encode(event);
      expect(decoder.decode(overIpc(message))).toStrictEqual(event);
      return byteLength(message);
    });
    const fullBytes = events.map((event) => byteLength(event));

    const early = sentBytes.slice(1, 9).reduce((sum, value) => sum + value, 0);
    const late = sentBytes.slice(-8).reduce((sum, value) => sum + value, 0);
    // Full resends grow about tenfold over the same updates.
    expect(
      fullBytes.slice(-8).reduce((sum, value) => sum + value, 0) /
        fullBytes.slice(1, 9).reduce((sum, value) => sum + value, 0),
    ).toBeGreaterThan(5);
    // One full value goes out when the truncation notice first appears.
    const firstClamped = events.findIndex((event) =>
      JSON.stringify(event).includes('truncated earlier'),
    );
    expect(sentBytes[firstClamped]).toBeGreaterThan(LIMIT);
    expect(late / early).toBeLessThan(1.1);
  });

  it('recovers a reloaded page: it never shows a wrong output and resumes with full values', () => {
    const events = longCommandEvents('cmd-a', 30);
    const { encoder, page, resets } = newPipe();
    const before = page();
    encoder.reset(resets[0] ?? '');
    for (const event of events.slice(0, 10)) {
      expect(before.decode(overIpc(encoder.encode(event)))).toStrictEqual(
        event,
      );
    }

    // A reload: the new page's decoder asks to start over, but main sends
    // two more updates before it handles that request.
    const after = page();
    expect(resets).toEqual(['epoch-1', 'epoch-2']);
    const inFlight = events
      .slice(10, 12)
      .map((event) => after.decode(overIpc(encoder.encode(event))));
    expect(inFlight).toEqual([undefined, undefined]);
    // Dropping them did not ask again: main has not answered the first request.
    expect(resets).toEqual(['epoch-1', 'epoch-2']);

    encoder.reset('epoch-2');
    const resumed = events
      .slice(12)
      .map((event) => after.decode(overIpc(encoder.encode(event))));
    expect(resumed).toStrictEqual(events.slice(12));
  });

  it('drops duplicate and out-of-order appends and asks for full values once', () => {
    const events = longCommandEvents('cmd-a', 8);
    const { encoder, page, resets } = newPipe();
    const decoder = page();
    encoder.reset('epoch-1');
    const messages = events.map((event) => overIpc(encoder.encode(event)));
    const [started, first, second, third, fourth] = messages;
    if (!started || !first || !second || !third || !fourth)
      throw new Error('expected messages');

    expect(decoder.decode(started)).toStrictEqual(events[0]);
    expect(decoder.decode(first)).toStrictEqual(events[1]);
    expect(decoder.decode(second)).toStrictEqual(events[2]);
    expect(decoder.decode(second)).toBeUndefined();
    expect(resets).toEqual(['epoch-1']);
    expect(decoder.decode(fourth)).toBeUndefined();
    expect(resets).toEqual(['epoch-1', 'epoch-2']);
    expect(decoder.decode(third)).toStrictEqual(events[3]);

    encoder.reset('epoch-2');
    const rest = events
      .slice(5)
      .map((event) => decoder.decode(overIpc(encoder.encode(event))));
    expect(rest).toStrictEqual(events.slice(5));
  });

  it('lets the completed item win and restarts its chain with a full value', () => {
    const { encoder, page } = newPipe();
    const decoder = page();
    encoder.reset('epoch-1');
    const updates = [
      codexEvent('item.updated', commandItem('cmd-a', 'one\n')),
      codexEvent('item.updated', commandItem('cmd-a', 'one\ntwo\n')),
      codexEvent(
        'item.completed',
        commandItem('cmd-a', 'final\n', 'completed'),
      ),
      // An item id reused by a later update starts over, never extends.
      codexEvent('item.updated', commandItem('cmd-a', 'final\nmore\n')),
    ];
    const messages = updates.map((event) => encoder.encode(event));
    expect(messages.map((message) => 'outputDelta' in message)).toEqual([
      true,
      true,
      false,
      true,
    ]);
    const last = messages[3];
    expect(
      last && 'outputDelta' in last
        ? last.outputDelta?.output?.append
        : 'missing',
    ).toBeUndefined();
    expect(
      messages.map((message) => decoder.decode(overIpc(message))),
    ).toStrictEqual(updates);
  });

  it('treats an unencoded output update (an injected event) as the full value and not a base', () => {
    const { encoder, page, resets } = newPipe();
    const decoder = page();
    encoder.reset('epoch-1');
    const first = codexEvent('item.updated', commandItem('cmd-a', 'one\n'));
    const injected = codexEvent(
      'item.updated',
      commandItem('cmd-a', 'injected\n'),
    );
    const next = codexEvent('item.updated', commandItem('cmd-a', 'one\ntwo\n'));

    expect(decoder.decode(overIpc(encoder.encode(first)))).toStrictEqual(first);
    expect(decoder.decode(overIpc(injected))).toStrictEqual(injected);
    // Main's append extends what main sent, which the page no longer holds.
    expect(decoder.decode(overIpc(encoder.encode(next)))).toBeUndefined();
    expect(resets).toEqual(['epoch-1', 'epoch-2']);
  });

  it('sends the next update in full after a failed send', () => {
    const { encoder, page } = newPipe();
    const decoder = page();
    encoder.reset('epoch-1');
    const first = codexEvent('item.updated', commandItem('cmd-a', 'one\n'));
    const lost = codexEvent('item.updated', commandItem('cmd-a', 'one\ntwo\n'));
    const next = codexEvent(
      'item.updated',
      commandItem('cmd-a', 'one\ntwo\nthree\n'),
    );
    expect(decoder.decode(overIpc(encoder.encode(first)))).toStrictEqual(first);
    encoder.encode(lost);
    encoder.discard(lost);
    const message = encoder.encode(next);
    expect(
      'outputDelta' in message && message.outputDelta?.output?.append,
    ).toBe(undefined);
    expect(decoder.decode(overIpc(message))).toStrictEqual(next);
  });

  it('asks again after a failed reset request', async () => {
    let rev = 0;
    const resets: string[] = [];
    const encoder = new ChatEventOutputEncoder({
      nextRev: (): number => ++rev,
      heads: [NOTICE],
    });
    let epoch = 0;
    const decoder = new ChatEventOutputDecoder({
      newEpoch: (): string => `epoch-${++epoch}`,
      requestReset: (value): Promise<void> => {
        resets.push(value);
        return Promise.reject(new Error('main is gone'));
      },
    });
    await Promise.resolve();
    const first = codexEvent('item.updated', commandItem('cmd-a', 'one\n'));
    const second = codexEvent(
      'item.updated',
      commandItem('cmd-a', 'one\ntwo\n'),
    );
    encoder.encode(first);
    expect(decoder.decode(overIpc(encoder.encode(second)))).toBeUndefined();
    expect(resets).toEqual(['epoch-1', 'epoch-2']);
  });

  it('rebuilds delegate cards exactly, across a reload, including items that are not flat', () => {
    const card = (
      sequence: number,
      items: unknown[],
      partial: string,
    ): ChatEvent =>
      chatEvent({
        type: 'canopy_delegation',
        delegation: {
          delegationId: 'child',
          runGeneration: 1,
          sequence,
          transcript: items,
          snapshot: { status: 'running', partialText: partial },
        },
      });
    const items: unknown[] = [];
    const events: ChatEvent[] = [];
    let partial = '';
    for (let index = 0; index < 30; index += 1) {
      items.push(
        index % 7 === 3
          ? { id: `nested-${index}`, meta: { nested: true } }
          : { id: `item-${index}`, type: 'text', text: `text ${index}` },
      );
      partial += `chunk ${index} `;
      events.push(
        card(
          index + 1,
          items.map((item) => structuredClone(item)),
          partial,
        ),
      );
    }
    // A patch-mode event ends the chain; the next card starts over in full.
    events.splice(
      20,
      0,
      chatEvent({
        type: 'canopy_delegation',
        delegation: {
          delegationId: 'child',
          runGeneration: 1,
          sequence: 21,
          transcriptMode: 'patch',
          transcript: [],
          snapshot: { status: 'running' },
        },
      }),
    );
    const { encoder, page, resets } = newPipe();
    const before = page();
    encoder.reset('epoch-1');
    const first = events
      .slice(0, 10)
      .map((event) => before.decode(overIpc(encoder.encode(event))));
    expect(first).toStrictEqual(events.slice(0, 10));

    const after = page();
    expect(
      after.decode(overIpc(encoder.encode(events[10] ?? chatEvent(null)))),
    ).toBe(undefined);
    encoder.reset(resets[1] ?? '');
    const rest = events
      .slice(11)
      .map((event) => after.decode(overIpc(encoder.encode(event))));
    expect(rest).toStrictEqual(events.slice(11));
  });

  it('sends a settled delegate card in full and forgets the run on both sides', () => {
    const card = (status: string, text: string): ChatEvent =>
      chatEvent({
        type: 'canopy_delegation',
        delegation: {
          delegationId: 'child',
          runGeneration: 1,
          transcript: [{ id: 'item-1', type: 'text', text }],
          snapshot: { status, partialText: text },
        },
      });
    const { encoder, page } = newPipe();
    const decoder = page();
    encoder.reset('epoch-1');
    const events = [
      card('running', 'a'),
      card('running', 'ab'),
      card('completed', 'abc'),
      card('running', 'abcd'),
    ];
    const messages = events.map((event) => encoder.encode(event));
    const kinds = messages.map((message) =>
      'outputDelta' in message &&
      message.outputDelta?.transcript?.append === undefined &&
      message.outputDelta?.partialText?.append === undefined
        ? 'full'
        : 'append',
    );
    expect(kinds).toEqual(['full', 'append', 'full', 'full']);
    expect(
      messages.map((message) => decoder.decode(overIpc(message))),
    ).toStrictEqual(events);
  });

  it('passes every other event through unchanged', () => {
    const { encoder, page } = newPipe();
    const decoder = page();
    const events = [
      chatEvent({ type: 'assistant', message: { content: [] } }),
      chatEvent({ type: 'canopy_delegation', delegation: { id: 'd' } }),
      chatEvent('not a record'),
      codexEvent('item.updated', {
        type: 'agent_message',
        id: 'msg-1',
        text: 'hello',
      }),
      codexEvent('item.updated', { type: 'command_execution', id: 'cmd-x' }),
    ];
    for (const event of events) {
      const message = encoder.encode(event);
      expect(message).toBe(event);
      expect(decoder.decode(overIpc(message))).toStrictEqual(event);
    }
  });
});
