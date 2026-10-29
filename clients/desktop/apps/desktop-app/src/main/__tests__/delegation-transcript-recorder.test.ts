import {
  DELEGATION_TRANSCRIPT_RECORDER_LIMITS,
  DelegationTranscriptRecorder,
} from '../agents/delegation/transcript-recorder';

describe('delegation activity normalization', () => {
  it('retains Cursor patches and pairs tools without copying tool output into text', () => {
    const recorder = new DelegationTranscriptRecorder();
    recorder.cursor({
      type: 'canopy_assistant_patch',
      messageId: 'answer',
      patches: [
        { index: 0, block: { type: 'text', text: 'Found' } },
        {
          index: 1,
          block: {
            type: 'tool_use',
            toolUseId: 'read',
            toolName: 'Read',
            input: '{"file_path":"/worktree/a"}',
          },
        },
      ],
    });
    recorder.cursor({
      type: 'canopy_assistant_patch',
      messageId: 'answer',
      patches: [
        { index: 0, appendText: ' evidence' },
        {
          index: 2,
          block: {
            type: 'tool_result',
            toolUseId: 'read',
            toolName: 'Read',
            output: 'source',
            isError: false,
          },
        },
      ],
    });
    expect(recorder.snapshot()).toEqual([
      expect.objectContaining({ type: 'text', text: 'Found evidence' }),
      expect.objectContaining({
        type: 'tool',
        toolName: 'Read',
        output: 'source',
        input: '{"file_path":"/worktree/a"}',
      }),
    ]);
  });

  it('reconciles Claude streamed thinking and text with completed blocks and pairs tool output', () => {
    const recorder = new DelegationTranscriptRecorder();
    const stream = (event: unknown): void =>
      recorder.claude({ type: 'stream_event', event });
    stream({ type: 'message_start', message: { id: 'response' } });
    stream({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    });
    stream({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'Checking the cause.' },
    });
    stream({
      type: 'content_block_start',
      index: 1,
      content_block: {
        type: 'tool_use',
        id: 'read',
        name: 'Read',
        input: {},
      },
    });
    recorder.claude({
      type: 'assistant',
      message: {
        id: 'response',
        content: [
          { type: 'thinking', thinking: 'Checking the cause.' },
          {
            type: 'tool_use',
            id: 'read',
            name: 'Read',
            input: { path: 'src/index.ts' },
          },
        ],
      },
    });
    recorder.claude({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'read',
            content: [{ type: 'text', text: 'source' }],
          },
        ],
      },
    });
    const snapshot = recorder.snapshot();
    expect(snapshot).toHaveLength(2);
    expect(snapshot[0]).toMatchObject({
      type: 'thinking',
      text: 'Checking the cause.',
      sequence: 1,
    });
    expect(snapshot[1]).toMatchObject({
      type: 'tool',
      input: '{"path":"src/index.ts"}',
      output: 'source',
      sequence: 2,
    });
    recorder.claude({
      type: 'assistant',
      message: {
        id: 'encrypted',
        content: [{ type: 'redacted_thinking', data: 'ciphertext' }],
      },
    });
    expect(recorder.snapshot()).toEqual(snapshot);
  });

  it('reconciles Codex activity without allowing late deltas or tool output into assistant text', () => {
    const recorder = new DelegationTranscriptRecorder();
    recorder.codex({
      method: 'item/agentMessage/delta',
      params: { itemId: 'answer', delta: 'Partial' },
    });
    const completed = {
      method: 'item/completed',
      params: {
        item: { type: 'agentMessage', id: 'answer', text: 'Full finding' },
      },
    };
    recorder.codex(completed);
    recorder.codex(completed);
    recorder.codex({
      method: 'item/agentMessage/delta',
      params: { itemId: 'answer', delta: 'late' },
    });
    recorder.codex({
      method: 'item/completed',
      params: {
        item: {
          type: 'reasoning',
          id: 'reason',
          summary: ['Checking error paths.'],
        },
      },
    });
    recorder.codex({
      method: 'item/started',
      params: {
        item: {
          type: 'dynamicToolCall',
          id: 'read',
          tool: 'request_steering',
          arguments: { message: 'Check the source.' },
        },
      },
    });
    recorder.codex({
      method: 'item/completed',
      params: {
        item: {
          type: 'dynamicToolCall',
          id: 'read',
          tool: 'request_steering',
          arguments: { message: 'Check the source.' },
          contentItems: [{ type: 'inputText', text: 'source' }],
          success: true,
        },
      },
    });
    expect(recorder.snapshot()).toMatchObject([
      { type: 'text', text: 'Full finding' },
      { type: 'thinking', text: 'Checking error paths.' },
      { type: 'tool', output: 'source', isError: false },
    ]);
    expect(recorder.take()).toHaveLength(3);
    expect(recorder.take()).toBeUndefined();
  });

  it('retains long child transcripts without discarding items or content', () => {
    const recorder = new DelegationTranscriptRecorder();
    for (let i = 0; i < 500; i++)
      recorder.codex({
        method: 'item/completed',
        params: {
          item: {
            type: 'agentMessage',
            id: String(i),
            text: 'x'.repeat(20000),
          },
        },
      });
    expect(recorder.snapshot()).toHaveLength(500);
    expect(recorder.truncated).toBe(false);
    const total = recorder
      .snapshot()
      .reduce(
        (size, item) =>
          size +
          (item.type === 'tool'
            ? item.input.length + (item.output?.length ?? 0)
            : item.text.length),
        0,
      );
    expect(total).toBe(500 * 20000);
  });

  it('publishes additional items and text beyond the former limits', () => {
    const itemLimited = new DelegationTranscriptRecorder();
    for (let i = 0; i < 128; i++)
      itemLimited.codex({
        method: 'item/completed',
        params: {
          item: { type: 'agentMessage', id: String(i), text: 'retained' },
        },
      });
    expect(itemLimited.take()).toHaveLength(128);
    expect(itemLimited.take()).toBeUndefined();

    itemLimited.codex({
      method: 'item/completed',
      params: {
        item: { type: 'agentMessage', id: 'discarded', text: 'discarded' },
      },
    });

    expect(itemLimited.truncated).toBe(false);
    expect(itemLimited.take()).toHaveLength(129);

    const textLimited = new DelegationTranscriptRecorder();
    textLimited.codex({
      method: 'item/agentMessage/delta',
      params: { itemId: 'answer', delta: 'x'.repeat(8192) },
    });
    expect(textLimited.take()).toHaveLength(1);
    expect(textLimited.take()).toBeUndefined();

    textLimited.codex({
      method: 'item/agentMessage/delta',
      params: { itemId: 'answer', delta: 'discarded' },
    });

    expect(textLimited.truncated).toBe(false);
    expect(textLimited.take()).toHaveLength(1);
  });

  it('stops retaining provider events at the item and byte budgets', () => {
    const itemLimited = new DelegationTranscriptRecorder();
    for (
      let i = 0;
      i < DELEGATION_TRANSCRIPT_RECORDER_LIMITS.items + 1;
      i += 1
    ) {
      itemLimited.codex({
        method: 'item/completed',
        params: {
          item: { type: 'agentMessage', id: String(i), text: 'retained' },
        },
      });
    }
    expect(itemLimited.snapshot()).toHaveLength(
      DELEGATION_TRANSCRIPT_RECORDER_LIMITS.items,
    );
    expect(itemLimited.limitExceeded).toBe(true);
    expect(itemLimited.truncated).toBe(true);

    const byteLimited = new DelegationTranscriptRecorder();
    byteLimited.codex({
      method: 'item/completed',
      params: {
        item: {
          type: 'agentMessage',
          id: 'oversized',
          text: 'x'.repeat(DELEGATION_TRANSCRIPT_RECORDER_LIMITS.itemBytes + 1),
        },
      },
    });
    expect(byteLimited.snapshot()).toEqual([]);
    expect(byteLimited.limitExceeded).toBe(true);
    expect(byteLimited.truncated).toBe(true);

    const aggregateLimited = new DelegationTranscriptRecorder();
    const chunk = 'x'.repeat(512 * 1024);
    for (let i = 0; i < 40; i += 1) {
      aggregateLimited.codex({
        method: 'item/completed',
        params: {
          item: { type: 'agentMessage', id: `aggregate-${i}`, text: chunk },
        },
      });
    }
    expect(aggregateLimited.snapshot().length).toBeLessThan(40);
    expect(aggregateLimited.limitExceeded).toBe(true);
    expect(
      aggregateLimited
        .snapshot()
        .reduce(
          (bytes, item) =>
            bytes + Buffer.byteLength(JSON.stringify(item), 'utf8'),
          0,
        ),
    ).toBeLessThanOrEqual(DELEGATION_TRANSCRIPT_RECORDER_LIMITS.totalBytes);
  });
});

it('maps native Codex patches to file edits and retains paths through completion', () => {
  const recorder = new DelegationTranscriptRecorder();
  const changes = [
    { path: 'src/added.ts', kind: { type: 'add' }, diff: '+new' },
    {
      path: 'src/edited.ts',
      kind: { type: 'update', move_path: null },
      diff: '-old\n+new',
    },
    { path: 'src/removed.ts', kind: { type: 'delete' }, diff: '-old' },
  ];
  recorder.codex({
    method: 'item/started',
    params: {
      item: { id: 'patch', type: 'fileChange', changes, status: 'inProgress' },
    },
  });
  expect(recorder.snapshot()[0]).toMatchObject({
    toolName: 'file_change',
    input: 'add: src/added.ts\nupdate: src/edited.ts\ndelete: src/removed.ts',
  });
  recorder.codex({
    method: 'item/completed',
    params: {
      item: { id: 'patch', type: 'fileChange', changes, status: 'completed' },
    },
  });
  expect(recorder.snapshot()).toHaveLength(1);
  expect(recorder.snapshot()[0]).toMatchObject({
    toolName: 'file_change',
    input: 'add: src/added.ts\nupdate: src/edited.ts\ndelete: src/removed.ts',
    output: 'completed',
    isError: false,
  });
});

it.each([
  ['declined', null, true],
  ['failed', null, true],
  ['completed', 1, true],
  ['completed', 0, false],
])(
  'preserves command status %s with exit code %s',
  (status, exitCode, isError) => {
    const recorder = new DelegationTranscriptRecorder();
    recorder.codex({
      method: 'item/completed',
      params: {
        item: {
          id: 'command',
          type: 'commandExecution',
          command: 'echo denied',
          status,
          exitCode,
          aggregatedOutput: '',
        },
      },
    });
    expect(recorder.snapshot()[0]).toMatchObject({
      type: 'tool',
      isError,
      output: status === 'completed' ? 'Done' : status,
    });
  },
);

it('preserves Claude denied tool results as errors', () => {
  const recorder = new DelegationTranscriptRecorder();
  recorder.claude({
    type: 'assistant',
    message: {
      id: 'msg',
      content: [
        {
          type: 'tool_use',
          id: 'denied',
          name: 'Read',
          input: { file_path: 'private.txt' },
        },
      ],
    },
  });
  recorder.claude({
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'denied',
          content: 'User denied this tool.',
          is_error: true,
        },
      ],
    },
  });
  expect(recorder.snapshot()[0]).toMatchObject({
    type: 'tool',
    isError: true,
    output: 'User denied this tool.',
  });
});

describe('Codex command output', () => {
  const started = {
    method: 'item/started',
    params: {
      item: {
        id: 'command',
        type: 'commandExecution',
        command: 'node -v',
        cwd: '/worktree',
        status: 'inProgress',
      },
    },
  };
  const completed = (
    extra: Record<string, unknown> = {},
  ): { method: string; params: Record<string, unknown> } => ({
    method: 'item/completed',
    params: {
      item: {
        id: 'command',
        type: 'commandExecution',
        command: 'node -v',
        cwd: '/worktree',
        status: 'completed',
        exitCode: 0,
        aggregatedOutput: null,
        ...extra,
      },
    },
  });
  const delta = (
    text: string,
    itemId = 'command',
  ): { method: string; params: Record<string, unknown> } => ({
    method: 'item/commandExecution/outputDelta',
    params: { threadId: 't', turnId: 'u', itemId, delta: text },
  });

  it('records streamed output when the completed item carries none', () => {
    const recorder = new DelegationTranscriptRecorder();
    recorder.codex(started);
    recorder.codex(delta('v24.21'));
    recorder.codex(delta('.0\n'));
    recorder.codex(completed());
    expect(recorder.snapshot()).toMatchObject([
      { type: 'tool', toolName: 'Bash', output: 'v24.21.0\n', isError: false },
    ]);
  });

  it('prefers the aggregated output and keeps the sandbox error of a failed command', () => {
    const aggregated = new DelegationTranscriptRecorder();
    aggregated.codex(delta('streamed'));
    aggregated.codex(completed({ aggregatedOutput: 'aggregated' }));
    expect(aggregated.snapshot()[0]).toMatchObject({ output: 'aggregated' });

    const failed = new DelegationTranscriptRecorder();
    failed.codex(delta('zsh:1: operation not permitted: notes.txt\n'));
    failed.codex(completed({ status: 'failed', exitCode: 1 }));
    expect(failed.snapshot()[0]).toMatchObject({
      output: 'zsh:1: operation not permitted: notes.txt\n',
      isError: true,
    });
  });

  it('keeps Done only for a command with no output at all', () => {
    const recorder = new DelegationTranscriptRecorder();
    recorder.codex(delta('other command', 'other'));
    recorder.codex(completed());
    expect(recorder.snapshot()[0]).toMatchObject({ output: 'Done' });
  });

  it('bounds streamed output and ignores deltas after completion', () => {
    const recorder = new DelegationTranscriptRecorder();
    const chunk = 'y'.repeat(4096);
    for (let index = 0; index < 64; index++) recorder.codex(delta(chunk));
    recorder.codex(delta('tail marker'));
    recorder.codex(completed());
    recorder.codex(delta('late'));
    const item = recorder.snapshot()[0];
    const output = item?.type === 'tool' ? (item.output ?? '') : '';
    expect(output.length).toBeLessThan(64 * 1024);
    expect(output.startsWith('yyyy')).toBe(true);
    expect(output.endsWith('tail marker')).toBe(true);
    expect(output).toContain('output truncated');
    expect(output).not.toContain('late');
    expect(recorder.limitExceeded).toBe(false);
  });
});
