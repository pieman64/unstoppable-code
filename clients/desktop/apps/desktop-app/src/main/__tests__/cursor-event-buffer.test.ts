import { CursorEventBuffer } from '../agents/cursor-event-buffer';

function patch(
  revision: number,
  text: string,
  initial = false,
): Record<string, unknown> {
  return {
    type: 'canopy_assistant_patch',
    provider: 'cursor',
    messageId: 'answer',
    timestamp: 1,
    revision,
    canopy_turn_user_message_id: 'turn',
    patches: [
      initial
        ? { index: 0, block: { type: 'text', text } }
        : { index: 0, appendText: text },
    ],
  };
}

test('batches pending text behind a slow commit and preserves tool/message boundaries', async () => {
  let release = (): void => {};
  const committing = new Promise<void>((resolve) => {
    release = resolve;
  });
  const delivered: Record<string, unknown>[] = [];
  const buffer = new CursorEventBuffer(async (event) => {
    delivered.push(event);
    if (delivered.length === 1) await committing;
  });
  let settled = false;
  const first = buffer.push(patch(1, 'Hello', true)).then(() => {
    settled = true;
  });
  const flushing = buffer.flush();
  await Promise.resolve();
  const tail = [buffer.push(patch(2, ' ')), buffer.push(patch(3, 'world'))];
  const tool = {
    type: 'canopy_assistant_patch',
    provider: 'cursor',
    messageId: 'activity',
    timestamp: 2,
    revision: 4,
    patches: [
      {
        index: 0,
        block: {
          type: 'tool_use',
          toolUseId: 'tool',
          toolName: 'Bash',
          input: '{}',
        },
      },
    ],
  };
  tail.push(buffer.push(tool));
  tail.push(buffer.push({ ...patch(5, 'Next', true), messageId: 'next' }));
  expect(settled).toBe(false);
  expect(delivered).toHaveLength(1);
  release();
  await Promise.all([first, flushing, ...tail]);
  expect(delivered).toEqual([
    patch(1, 'Hello', true),
    patch(3, ' world'),
    tool,
    { ...patch(5, 'Next', true), messageId: 'next' },
  ]);
});

test('bounds a merged text record and does not mutate provider events', async () => {
  const delivered: Record<string, unknown>[] = [];
  const buffer = new CursorEventBuffer((event) => {
    delivered.push(event);
    return Promise.resolve();
  });
  const original = patch(1, 'a'.repeat(10_000), true);
  const completions = [
    buffer.push(original),
    buffer.push(patch(2, 'b'.repeat(10_000))),
    buffer.push(patch(3, 'c')),
  ];
  await buffer.flush();
  await Promise.all(completions);
  expect(delivered).toEqual([original, patch(3, 'b'.repeat(10_000) + 'c')]);
  expect(original).toEqual(patch(1, 'a'.repeat(10_000), true));
});

test('flush includes text enqueued by a just-settled producer', async () => {
  const delivered: Record<string, unknown>[] = [];
  const buffer = new CursorEventBuffer((event) => {
    delivered.push(event);
    return Promise.resolve();
  });
  const producer = buffer
    .push(patch(1, 'a', true))
    .then(() => buffer.push(patch(2, 'b')));
  await buffer.flush();
  await producer;
  expect(delivered).toEqual([patch(1, 'a', true), patch(2, 'b')]);
});

test('delivery failure rejects all queued producers and the terminal flush', async () => {
  const failure = new Error('commit failed');
  const buffer = new CursorEventBuffer(() => Promise.reject(failure));
  const completions = [
    buffer.push(patch(1, 'a', true)),
    buffer.push(patch(2, 'b')),
    buffer.push({ type: 'system' }),
  ];
  const outcomes = Promise.allSettled(completions);
  await expect(buffer.flush()).rejects.toBe(failure);
  expect(await outcomes).toEqual(
    completions.map(() => ({ status: 'rejected', reason: failure })),
  );
  await expect(buffer.push(patch(3, 'c'))).rejects.toBe(failure);
});

test.each(['copilot', 'opencode'])(
  'coalesces %s text while preserving the provider and terminal order',
  async (provider) => {
    const delivered: Record<string, unknown>[] = [];
    const buffer = new CursorEventBuffer((event) => {
      delivered.push(event);
      return Promise.resolve();
    });
    const first = { ...patch(1, 'Hello', true), provider };
    const last = { type: 'result', provider, subtype: 'success' };
    const completions = [
      buffer.push(first),
      buffer.push({ ...patch(2, ' '), provider }),
      buffer.push({ ...patch(3, 'world'), provider }),
      buffer.push(last),
    ];
    await buffer.flush();
    await Promise.all(completions);
    expect(delivered).toEqual([
      { ...patch(3, 'Hello world', true), provider },
      last,
    ]);
    expect(first).toEqual({ ...patch(1, 'Hello', true), provider });
  },
);
