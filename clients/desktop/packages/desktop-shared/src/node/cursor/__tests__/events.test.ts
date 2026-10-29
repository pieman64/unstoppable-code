import { parseAgentTranscriptLines } from '@canopy/agent-transcript';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import { CursorEventProjection, type CursorToolInvocation } from '../events';
import { overlapMatcherWorkCounters } from '../../../lib/overlap-matcher';
import {
  splitFinalMessages,
  type TurnMessage,
} from '@canopy/desktop-shared/lib/turn-utils';
import { cursorCanopyMcpServerNames } from '@canopy/desktop-shared/lib/cursor-mcp-tool-call';
import { CANOPY_INJECTED_TOOL_REGISTRY } from '@canopy/desktop-shared/lib/canopy-injected-tools';
import { APP_ADVISOR_TOOL_REGISTRY } from '@canopy/desktop-shared/lib/app-advisor-tools';

const anyToolUseId: unknown = expect.any(String);

describe('Cursor transcript projection', () => {
  it('reports each invocation with its persisted UUID and merged raw input before returning the patch', () => {
    const invocations: CursorToolInvocation[] = [];
    let patchReturned = false;
    const projection = new CursorEventProjection(undefined, {
      onToolInvocation: (invocation): void => {
        expect(patchReturned).toBe(false);
        invocations.push(invocation);
      },
    });
    const first = projection.update({
      sessionId: 's',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'acp-id',
        title: 'canopy: ShowVisual',
        kind: 'other',
        status: 'in_progress',
        rawInput: { providerIdentifier: 'canopy', toolName: 'ShowVisual' },
      },
    });
    patchReturned = true;
    const id = invocations[0]?.toolUseId;
    expect(first).toMatchObject({
      patches: [{ block: { type: 'tool_use', toolUseId: id } }],
    });
    patchReturned = false;
    projection.update({
      sessionId: 's',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'acp-id',
        status: 'completed',
        rawOutput: { ok: true },
      },
    });
    expect(invocations).toEqual([
      {
        toolUseId: id,
        title: 'canopy: ShowVisual',
        rawInput: { providerIdentifier: 'canopy', toolName: 'ShowVisual' },
        kind: 'other',
        status: 'in_progress',
      },
      {
        toolUseId: id,
        title: 'canopy: ShowVisual',
        rawInput: { providerIdentifier: 'canopy', toolName: 'ShowVisual' },
        kind: 'other',
        status: 'completed',
      },
    ]);
  });

  const providerError = '\n\nError: RetriableError: [resource_exhausted] Error';
  const textUpdate = (text: string): SessionNotification => ({
    sessionId: 's',
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text },
    },
  });

  it('recognizes the pinned CLI terminal error envelope after partial output', () => {
    const projection = new CursorEventProjection();
    projection.update(textUpdate('Starting the request.'));
    projection.update(textUpdate(providerError));
    expect(projection.getTerminalError()).toContain('resource_exhausted');
  });

  it.each([
    'Error: something went wrong in the example',
    `Example response:${providerError}`,
    `\`\`\`text${providerError}\n\`\`\``,
    `${providerError}\nHere is the explanation.`,
    '\n\nError: RetriableError: [unrecognized_status] Error',
  ])('does not classify ordinary content as a provider failure: %s', (text) => {
    const projection = new CursorEventProjection();
    projection.update(textUpdate(text));
    expect(projection.getTerminalError()).toBeUndefined();
  });

  it('does not keep an error-shaped chunk if the assistant continues', () => {
    const projection = new CursorEventProjection();
    projection.update(textUpdate(providerError));
    projection.update(textUpdate(' is the error being explained.'));
    expect(projection.getTerminalError()).toBeUndefined();
  });

  it.each([
    [
      '\n\nPlease sign in to continue',
      'login',
      'Reconnect Cursor in Settings and try again.',
    ],
    [
      '\n\nUpgrade your plan to continue',
      'upgrade',
      "Your Cursor plan doesn't include this request. Upgrade your plan or choose another model.",
    ],
    [
      '\n\nAdd a payment method to continue',
      'payment',
      'Add a payment method to your Cursor account, then try again.',
    ],
    [
      '\n\nCheck your settings to continue',
      'config',
      "Your Cursor account settings don't allow this request. Check them in your Cursor dashboard, then try again, or choose another model.",
    ],
  ] as const)(
    'recognizes the pinned CLI action-required notice %j',
    (text, action, message) => {
      const projection = new CursorEventProjection();
      projection.update(textUpdate('Starting the request.'));
      projection.update(textUpdate(text));
      expect(projection.getTerminalError()).toBe(message);
      expect(projection.getTerminalAction()).toBe(action);
    },
  );

  it.each([
    'Check your settings to continue',
    '\n\nCheck your settings to continue.',
    'Example notice:\n\nCheck your settings to continue',
    '\n\nCheck your settings to continue\nThen open the dashboard.',
  ])('does not classify ordinary content as an account action: %j', (text) => {
    const projection = new CursorEventProjection();
    projection.update(textUpdate(text));
    expect(projection.getTerminalError()).toBeUndefined();
    expect(projection.getTerminalAction()).toBeUndefined();
  });

  it('does not keep an account action if the assistant continues', () => {
    const projection = new CursorEventProjection();
    projection.update(textUpdate('\n\nCheck your settings to continue'));
    projection.update(textUpdate(' is what the banner said.'));
    expect(projection.getTerminalError()).toBeUndefined();
    expect(projection.getTerminalAction()).toBeUndefined();
  });

  it('reports no account action for a provider error', () => {
    const projection = new CursorEventProjection();
    projection.update(textUpdate(providerError));
    expect(projection.getTerminalError()).toContain('resource_exhausted');
    expect(projection.getTerminalAction()).toBeUndefined();
  });

  it('does not interpret tool output or thoughts as the provider error envelope', () => {
    const projection = new CursorEventProjection();
    projection.update({
      sessionId: 's',
      update: {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: providerError },
      },
    });
    projection.update({
      sessionId: 's',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 't',
        title: 'Read',
        kind: 'read',
        status: 'completed',
        rawOutput: providerError,
      },
    });
    expect(projection.getTerminalError()).toBeUndefined();
  });

  it('does not retransmit the entire accumulated reply on every token chunk', () => {
    const projection = new CursorEventProjection();
    let bytes = 0;
    for (let index = 0; index < 1000; index += 1) {
      bytes += JSON.stringify(
        projection.update({
          sessionId: 's',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'x'.repeat(100) },
          },
        }),
      ).length;
    }
    expect(bytes).toBeLessThan(500_000);
  });
  it('replays streamed text and a completed tool without duplicate assistant rows', () => {
    const projection = new CursorEventProjection();
    const events = [
      projection.update({
        sessionId: 's',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Checking ' },
        },
      }),
      projection.update({
        sessionId: 's',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'the file.' },
        },
      }),
      projection.update({
        sessionId: 's',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 't',
          title: 'Read',
          kind: 'read',
          status: 'in_progress',
          rawInput: { file_path: '/tmp/a' },
        },
      }),
      projection.update({
        sessionId: 's',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 't',
          status: 'completed',
          rawOutput: 'content',
        },
      }),
      { type: 'result', provider: 'cursor', is_error: false, result: '' },
    ];
    const parsed = parseAgentTranscriptLines(
      events.map((event) => JSON.stringify(event)),
      'cursor',
    );
    expect(parsed.providerType).toBe('cursor');
    const messages = parsed.messages.filter(
      (message) => message.role === 'assistant',
    );
    expect(messages).toHaveLength(2);
    expect(messages.flatMap((message) => message.blocks)).toEqual([
      { type: 'text', text: 'Checking the file.' },
      {
        type: 'tool_use',
        toolUseId: anyToolUseId,
        toolName: 'Read',
        input: '{"file_path":"/tmp/a"}',
        display: { toolName: 'Read', input: '{"file_path":"/tmp/a"}' },
      },
      {
        type: 'tool_result',
        toolUseId: anyToolUseId,
        toolName: 'Read',
        output: '"content"',
        isError: false,
      },
    ]);
  });

  const cases: Array<{
    title: string;
    kind: Extract<
      SessionNotification['update'],
      { sessionUpdate: 'tool_call' }
    >['kind'];
    rawInput: unknown;
    toolName: string;
    input: unknown;
  }> = [
    {
      title: 'Read package.json',
      kind: 'read',
      rawInput: { path: '/repo/package.json' },
      toolName: 'Read',
      input: { file_path: '/repo/package.json' },
    },
    {
      title: 'Edit `src/app.ts`',
      kind: 'edit',
      rawInput: { path: 'src/app.ts' },
      toolName: 'Edit',
      input: { file_path: 'src/app.ts' },
    },
    {
      title: '`git status`',
      kind: 'execute',
      rawInput: { command: 'git status' },
      toolName: 'Bash',
      input: { command: 'git status' },
    },
    {
      title: 'Find `README*`',
      kind: 'search',
      rawInput: { pattern: 'README*' },
      toolName: 'Glob',
      input: { pattern: 'README*' },
    },
    {
      title: 'grep "needle"',
      kind: 'search',
      rawInput: { pattern: 'needle', path: '/repo' },
      toolName: 'Grep',
      input: { pattern: 'needle', path: '/repo' },
    },
    {
      title: 'grep -i "needle"',
      kind: 'search',
      rawInput: { pattern: 'needle' },
      toolName: 'Grep',
      input: { pattern: 'needle' },
    },
    {
      title: 'Web Search: "ACP"',
      kind: 'search',
      rawInput: { searchTerm: 'ACP' },
      toolName: 'WebSearch',
      input: { query: 'ACP' },
    },
    {
      title: 'Fetch: https://example.test',
      kind: 'fetch',
      rawInput: { url: 'https://example.test' },
      toolName: 'WebFetch',
      input: { url: 'https://example.test' },
    },
    {
      title: 'plugin-test: echo',
      kind: 'other',
      rawInput: {
        providerIdentifier: 'plugin-test',
        toolName: 'echo',
        args: { message: 'hello' },
      },
      toolName: 'mcp__plugin-test__echo',
      input: { message: 'hello' },
    },
    {
      title: `${cursorCanopyMcpServerNames().main}: GetGitPreferences`,
      kind: 'other',
      rawInput: {
        providerIdentifier: cursorCanopyMcpServerNames().main,
        toolName: 'GetGitPreferences',
        args: { type: 'branch-name' },
      },
      toolName:
        CANOPY_INJECTED_TOOL_REGISTRY.get_git_preferences.claudeToolName,
      input: { type: 'branch-name' },
    },
    {
      title: `${cursorCanopyMcpServerNames('app-advisor').main}: GetCurrentUiState`,
      kind: 'other',
      rawInput: {
        providerIdentifier: cursorCanopyMcpServerNames('app-advisor').main,
        toolName: 'GetCurrentUiState',
        args: {},
      },
      toolName: APP_ADVISOR_TOOL_REGISTRY.get_current_ui_state.claudeToolName,
      input: {},
    },
    {
      title: `${cursorCanopyMcpServerNames('app-advisor').main}: DispatchAction`,
      kind: 'other',
      rawInput: {
        providerIdentifier: cursorCanopyMcpServerNames('app-advisor').main,
        toolName: 'DispatchAction',
        args: { action: { type: 'navigation.open_settings' } },
      },
      toolName: APP_ADVISOR_TOOL_REGISTRY.dispatch_action.claudeToolName,
      input: { action: { type: 'navigation.open_settings' } },
    },
    {
      title: 'Create Plan: Implement feature',
      kind: 'other',
      rawInput: { _toolName: 'createPlan', name: 'Implement feature' },
      toolName: 'Create Plan: Implement feature',
      input: { _toolName: 'createPlan', name: 'Implement feature' },
    },
    {
      title: "List the current directory's contents",
      kind: 'search',
      rawInput: { path: '.' },
      toolName: "List the current directory's contents",
      input: { path: '.' },
    },
    {
      title: 'plugin-one: echo',
      kind: 'other',
      rawInput: {
        providerIdentifier: 'plugin-two',
        toolName: 'echo',
        args: {},
      },
      toolName: 'plugin-one: echo',
      input: { providerIdentifier: 'plugin-two', toolName: 'echo', args: {} },
    },
  ];
  it.each(cases)(
    'persists raw $title and separate display data while preserving approval facts',
    ({ title, kind, rawInput, toolName, input }) => {
      const projection = new CursorEventProjection();
      const event = projection.update({
        sessionId: 's',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool',
          title,
          kind,
          rawInput,
          status: 'pending',
        },
      });
      const replay = parseAgentTranscriptLines(
        [JSON.stringify(event)],
        'cursor',
      );
      expect(
        replay.messages.flatMap((message) => message.blocks),
      ).toContainEqual({
        type: 'tool_use',
        toolUseId: anyToolUseId,
        toolName: title,
        input: JSON.stringify(rawInput),
        display: { toolName, input: JSON.stringify(input) },
      });
      expect(projection.getTool('tool')).toEqual({
        name: title,
        input: rawInput,
        kind,
      });
    },
  );

  it.each([
    { error: 'blocked' },
    { rejected: true },
    { permissionDenied: true },
    { exitCode: 1, stdout: '', stderr: 'failed' },
  ])('marks a completed ACP failure as an error: %j', (rawOutput) => {
    const projection = new CursorEventProjection();
    const event = projection.update({
      sessionId: 's',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 't',
        title: 'tool',
        status: 'completed',
        rawOutput,
      },
    });
    const replay = parseAgentTranscriptLines([JSON.stringify(event)], 'cursor');
    expect(replay.messages.flatMap((message) => message.blocks)).toContainEqual(
      expect.objectContaining({ type: 'tool_result', isError: true }),
    );
  });

  it.each([
    { content: '{"error":"example file contents"}' },
    { exitCode: 0, stdout: 'error: an example', stderr: '' },
    { errorCount: 3 },
  ])('does not treat successful tool data as an error: %j', (rawOutput) => {
    const projection = new CursorEventProjection();
    const event = projection.update({
      sessionId: 's',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 't',
        title: 'tool',
        status: 'completed',
        rawOutput,
      },
    });
    const replay = parseAgentTranscriptLines([JSON.stringify(event)], 'cursor');
    expect(replay.messages.flatMap((message) => message.blocks)).toContainEqual(
      expect.objectContaining({ type: 'tool_result', isError: false }),
    );
  });

  it('separates final text from activity and keeps late tool results on their original message', () => {
    const projection = new CursorEventProjection();
    const events = [
      projection.update(textUpdate('Checking the project.')),
      projection.update({
        sessionId: 's',
        update: {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'Inspect the files.' },
        },
      }),
      projection.update({
        sessionId: 's',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'read',
          title: 'Read package.json',
          kind: 'read',
          rawInput: { path: 'package.json' },
        },
      }),
      projection.update(textUpdate('This is ')),
      projection.update({
        sessionId: 's',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'read',
          status: 'completed',
          rawOutput: { content: 'package contents' },
        },
      }),
      projection.update(textUpdate('a TypeScript app.')),
      { type: 'result', provider: 'cursor', is_error: false, result: '' },
    ];
    const replay = parseAgentTranscriptLines(
      events.map((event) => JSON.stringify(event)),
      'cursor',
    );
    const messages = replay.messages.filter(
      (message) => message.role === 'assistant',
    );
    expect(messages).toHaveLength(3);
    expect(messages[2].blocks).toEqual([
      { type: 'text', text: 'This is a TypeScript app.' },
    ]);
    expect(messages[1].blocks).toContainEqual(
      expect.objectContaining({
        type: 'tool_result',
        toolUseId: anyToolUseId,
      }),
    );
    const display: TurnMessage[] = messages.map((message) => ({
      ...message,
      blocks: message.blocks.filter(
        (block) =>
          block.type === 'text' ||
          block.type === 'thinking' ||
          block.type === 'tool_use',
      ),
    }));
    const split = splitFinalMessages(display);
    expect(split.intermediateMessages).toHaveLength(2);
    expect(split.finalMessages).toEqual([display[2]]);
  });
  it('retains separate invocations and results when Cursor reuses a tool ID', () => {
    const projection = new CursorEventProjection();
    const events = [];
    for (const [title, kind, output] of [
      ['Read file', 'read', { content: 'original' }],
      ['Edit file', 'edit', { diff: 'changed' }],
    ] as const) {
      events.push(
        projection.update({
          sessionId: 's',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'reused',
            title,
            kind,
            rawInput: { path: 'file' },
            status: 'pending',
          },
        }),
      );
      events.push(
        projection.update({
          sessionId: 's',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'reused',
            status: 'completed',
            rawOutput: output,
          },
        }),
      );
      events.push(projection.update(textUpdate('Continuing.')));
    }
    const replay = parseAgentTranscriptLines(
      events.map((event) => JSON.stringify(event)),
      'cursor',
    );
    const blocks = replay.messages.flatMap((message) => message.blocks);
    const uses = blocks.filter((block) => block.type === 'tool_use');
    const results = blocks.filter((block) => block.type === 'tool_result');
    expect(uses.map((block) => block.toolName)).toEqual([
      'Read file',
      'Edit file',
    ]);
    expect(new Set(uses.map((block) => block.toolUseId)).size).toBe(2);
    expect(results.map((block) => block.toolUseId)).toEqual(
      uses.map((block) => block.toolUseId),
    );
    expect(results.map((block) => block.output)).toEqual([
      JSON.stringify({ content: 'original' }),
      JSON.stringify({ diff: 'changed' }),
    ]);
    expect(projection.getTool('reused')).toEqual({
      name: 'Edit file',
      kind: 'edit',
      input: { path: 'file' },
    });
  });

  it('replays host notices as separate system rows without relabeling model text', () => {
    const projection = new CursorEventProjection();
    const text = 'Earlier Cursor context could not be restored.';
    const events = [
      projection.notice(text),
      projection.update(textUpdate(text)),
    ];
    const replay = parseAgentTranscriptLines(
      events.map((event) => JSON.stringify(event)),
      'cursor',
    );
    const messages = replay.messages.filter((message) =>
      message.blocks.some((block) => block.type === 'text'),
    );
    expect(messages.map((message) => message.role)).toEqual([
      'system',
      'assistant',
    ]);
    expect(messages.map((message) => message.blocks)).toEqual([
      [{ type: 'text', text }],
      [{ type: 'text', text }],
    ]);
  });

  it('accumulates response text across chunks and ignores thoughts and notices', () => {
    const projection = new CursorEventProjection();
    const chunk = (
      sessionUpdate: 'agent_message_chunk' | 'agent_thought_chunk',
      text: string,
    ): void => {
      projection.update({
        sessionId: 's',
        update: { sessionUpdate, content: { type: 'text', text } },
      });
    };
    chunk('agent_thought_chunk', 'thinking ');
    chunk('agent_message_chunk', 'Hello, ');
    projection.notice('notice text');
    chunk('agent_message_chunk', 'world.');
    expect(projection.getResponseText()).toBe('Hello, world.');
  });
});

describe('Cursor transcript projection with configured secret values', () => {
  const SECRET = 'sk-live-FAKE-0123456789abcdef';
  const chunk = (
    sessionUpdate: 'agent_message_chunk' | 'agent_thought_chunk',
    text: string,
  ): SessionNotification => ({
    sessionId: 's',
    update: { sessionUpdate, content: { type: 'text', text } },
  });
  type Patch = {
    index: number;
    block?: { text?: string };
    appendText?: string;
  };
  type PatchEvent = { messageId: string; patches: Patch[] };
  const isPatchEvent = (event: unknown): event is PatchEvent =>
    typeof event === 'object' &&
    event !== null &&
    'type' in event &&
    event.type === 'canopy_assistant_patch' &&
    'messageId' in event &&
    typeof event.messageId === 'string' &&
    'patches' in event &&
    Array.isArray(event.patches);

  /** Drives the projection the way the turn driver does. */
  const drive = (
    projection: CursorEventProjection,
    steps: readonly (SessionNotification | { notice: string })[],
  ): PatchEvent[] => {
    const events: unknown[] = [];
    for (const step of steps) {
      const event =
        'notice' in step
          ? projection.notice(step.notice)
          : projection.update(step);
      events.push(...projection.takeFlushed());
      if (event) events.push(event);
    }
    events.push(...projection.finish());
    return events.filter(isPatchEvent);
  };

  /** Each streamed text block's final text, in creation order. */
  const blocks = (events: readonly PatchEvent[]): string[] => {
    const order: string[] = [];
    const texts = new Map<string, string>();
    for (const event of events)
      for (const patch of event.patches) {
        const key = `${event.messageId}#${String(patch.index)}`;
        if (typeof patch.block?.text === 'string') {
          if (!texts.has(key)) order.push(key);
          texts.set(key, patch.block.text);
        } else if (typeof patch.appendText === 'string') {
          texts.set(key, (texts.get(key) ?? '') + patch.appendText);
        }
      }
    return order.map((key) => texts.get(key) ?? '');
  };

  it.each(['agent_message_chunk', 'agent_thought_chunk'] as const)(
    'masks a value split across %s deltas without moving it to another block',
    (kind) => {
      const events = drive(
        new CursorEventProjection(undefined, { secretValues: [SECRET] }),
        [
          chunk(kind, 'The key is sk-live-'),
          chunk(kind, 'FAKE-0123'),
          chunk(kind, '456789abcdef'),
          chunk(kind, '. Tail.'),
        ],
      );
      expect(blocks(events)).toEqual(['The key is ***. Tail.']);
      // One block, one message, one event per delta, in order.
      expect(new Set(events.map((event) => event.messageId)).size).toBe(1);
      expect(
        events.flatMap((event) => event.patches.map((patch) => patch.index)),
      ).toEqual([0, 0, 0, 0, 0]);
      expect(JSON.stringify(events)).not.toContain('FAKE-0123');
    },
  );

  it('keeps a partial value held across other blocks and returns it to its own block', () => {
    // The response stream continues past the thought, so its held tail is
    // released only when more response text or the end of the turn decides
    // it. It still lands in the block it came from.
    const projection = new CursorEventProjection(undefined, {
      secretValues: [SECRET],
    });
    const events = drive(projection, [
      chunk('agent_message_chunk', 'Stopping at sk-live-FAKE'),
      chunk('agent_thought_chunk', 'Thinking.'),
      chunk('agent_message_chunk', 'Resumed.'),
    ]);
    expect(blocks(events)).toEqual([
      'Stopping at sk-live-FAKE',
      'Thinking.',
      'Resumed.',
    ]);
    const firstMessage = events[0]?.messageId;
    const ofFirst = events.filter((event) => event.messageId === firstMessage);
    // Every piece of its text went to its own block, and some of it only
    // after the later messages had started.
    expect(
      ofFirst.every((event) =>
        event.patches.every((patch) => patch.index === 0),
      ),
    ).toBe(true);
    const lastOfFirst = events.lastIndexOf(
      ofFirst[ofFirst.length - 1] ?? events[0],
    );
    const firstOfOthers = events.findIndex(
      (event) => event.messageId !== firstMessage,
    );
    expect(lastOfFirst).toBeGreaterThan(firstOfOthers);
  });

  it('keeps a thought tail held through a tool call and releases it into the thought block', () => {
    const projection = new CursorEventProjection(undefined, {
      secretValues: [SECRET],
    });
    projection.update(
      chunk('agent_thought_chunk', 'Reading sk-live-FAKE-0123456789abcdef now'),
    );
    expect(projection.takeFlushed()).toEqual([]);
    const toolEvent = projection.update({
      sessionId: 's',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'read-1',
        title: 'Read file',
        kind: 'read',
        status: 'pending',
        rawInput: { path: '/w/a' },
      },
    });
    expect(projection.takeFlushed()).toEqual([]);
    expect(isPatchEvent(toolEvent)).toBe(true);
    if (!isPatchEvent(toolEvent)) return;
    // The tool block is the only change; the thought's tail is still held.
    expect(toolEvent.patches.map((patch) => patch.index)).toEqual([1]);
    const released = projection.finish();
    expect(released.filter(isPatchEvent).map((event) => event.patches)).toEqual(
      [[{ index: 0, appendText: ' now' }]],
    );
  });

  it('flushes the open block before a host notice', () => {
    const events = drive(
      new CursorEventProjection(undefined, { secretValues: [SECRET] }),
      [
        chunk('agent_message_chunk', 'Value sk-live-FAKE-0123456789abc'),
        { notice: 'Host notice.' },
      ],
    );
    expect(blocks(events)).toEqual([
      'Value sk-live-FAKE-0123456789abc',
      'Host notice.',
    ]);
  });

  it('completes a match that ends in the last delta of the turn', () => {
    const events = drive(
      new CursorEventProjection(undefined, { secretValues: [SECRET] }),
      [
        chunk('agent_message_chunk', 'trailing sk-live-FAKE-0123456789abc'),
        chunk('agent_message_chunk', 'def and a cut-off sk-li'),
      ],
    );
    expect(blocks(events)).toEqual(['trailing *** and a cut-off sk-li']);
  });

  it('masks overlapping and periodic values as one span, like the joined-text masking', () => {
    expect(
      blocks(
        drive(
          new CursorEventProjection(undefined, {
            secretValues: ['ABCDEF', 'CDEFGH'],
          }),
          ['xxAB', 'CDEFG', 'Hyy'].map((text) =>
            chunk('agent_message_chunk', text),
          ),
        ),
      ),
    ).toEqual(['xx***yy']);
    expect(
      blocks(
        drive(
          new CursorEventProjection(undefined, { secretValues: ['ABABAB'] }),
          ['[AB', 'ABA', 'BAB', 'AB]'].map((text) =>
            chunk('agent_message_chunk', text),
          ),
        ),
      ),
    ).toEqual(['[***]']);
  });

  it('ignores values under six characters, as the transcript masking does', () => {
    expect(
      blocks(
        drive(
          new CursorEventProjection(undefined, { secretValues: ['short'] }),
          [chunk('agent_message_chunk', 'a short answer')],
        ),
      ),
    ).toEqual(['a short answer']);
  });

  it('holds back no more than one value length of text', () => {
    const projection = new CursorEventProjection(undefined, {
      secretValues: [SECRET],
    });
    let sent = 0;
    let emitted = 0;
    for (let index = 0; index < 2_000; index += 1) {
      const text = `line ${String(index)} of ordinary output. `;
      sent += text.length;
      const event = projection.update(chunk('agent_message_chunk', text));
      for (const patch of isPatchEvent(event) ? event.patches : [])
        emitted += (patch.block?.text ?? patch.appendText ?? '').length;
      expect(sent - emitted).toBeLessThan(SECRET.length);
    }
  });

  it('leaves every delta exactly as received when no value is configured', () => {
    const events = drive(new CursorEventProjection(), [
      chunk('agent_message_chunk', 'The key is sk-live-'),
      chunk('agent_message_chunk', 'FAKE-0123'),
    ]);
    expect(
      events.flatMap((event) =>
        event.patches.map((patch) => patch.block?.text ?? patch.appendText),
      ),
    ).toEqual(['The key is sk-live-', 'FAKE-0123']);
  });
});

describe('Cursor projection masking beyond one block', () => {
  // What leaves the projection is written to a transcript and a live stream
  // record by record. The step masks each record's OUTER JSON; anything the
  // projection nests as a JSON string, or splits between blocks, must already
  // be masked when it leaves.
  const chunk = (
    sessionUpdate: 'agent_message_chunk' | 'agent_thought_chunk',
    text: string,
  ): SessionNotification => ({
    sessionId: 's',
    update: { sessionUpdate, content: { type: 'text', text } },
  });
  type Step = SessionNotification | { notice: string };
  const run = (
    projection: CursorEventProjection,
    steps: readonly Step[],
  ): string[] => {
    const lines: string[] = [];
    for (const step of steps) {
      const event =
        'notice' in step
          ? projection.notice(step.notice)
          : projection.update(step);
      for (const flushed of projection.takeFlushed())
        lines.push(JSON.stringify(flushed));
      if (event) lines.push(JSON.stringify(event));
    }
    for (const event of projection.finish()) lines.push(JSON.stringify(event));
    return lines;
  };
  /** The transcript the renderer rebuilds from those records. */
  const rebuilt = (
    lines: readonly string[],
  ): { role: string; blocks: unknown[] }[] =>
    parseAgentTranscriptLines([...lines], 'cursor').messages.map((message) => ({
      role: message.role,
      blocks: message.blocks,
    }));
  const texts = (lines: readonly string[]): string[] =>
    rebuilt(lines).flatMap((message) =>
      message.blocks.flatMap((block) =>
        typeof block === 'object' &&
        block !== null &&
        'text' in block &&
        typeof block.text === 'string'
          ? [block.text]
          : [],
      ),
    );

  describe('tool values nested as JSON strings', () => {
    const tool = (
      value: string,
    ): {
      call: SessionNotification;
      done: SessionNotification;
      failed: SessionNotification;
    } => ({
      call: {
        sessionId: 's',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'write-1',
          title: 'Write',
          kind: 'edit',
          status: 'pending',
          rawInput: { path: '/w/notes.txt', content: `before ${value} after` },
        },
      },
      done: {
        sessionId: 's',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'write-1',
          status: 'completed',
          rawOutput: { stdout: `wrote ${value}`, lines: [value, 'kept'] },
        },
      },
      failed: {
        sessionId: 's',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'write-1',
          status: 'failed',
          rawOutput: { error: `refused ${value}` },
        },
      },
    });
    /** Every tool block field, decoded once more the way consumers read it. */
    const toolFields = (lines: readonly string[]): unknown[] =>
      rebuilt(lines).flatMap((message) =>
        message.blocks.flatMap((block) => {
          if (typeof block !== 'object' || block === null) return [];
          const fields: unknown[] = [];
          if ('input' in block && typeof block.input === 'string')
            fields.push(JSON.parse(block.input));
          if ('output' in block && typeof block.output === 'string')
            fields.push(JSON.parse(block.output));
          if (
            'display' in block &&
            typeof block.display === 'object' &&
            block.display !== null &&
            'input' in block.display &&
            typeof block.display.input === 'string'
          )
            fields.push(JSON.parse(block.display.input));
          return fields;
        }),
      );

    it.each([
      ['a multi-line value', 'SYNTHETIC-KEY-ABC\nDEF-GHI-123'],
      ['a quoted value', 'SYNTHETIC-KEY-"ABCDEF123'],
      ['a backslash value', 'SYNTHETIC-KEY-ABC\\DEF123'],
      ['a plain value', 'SYNTHETIC-KEY-ABCDEF123'],
    ])('masks %s in input, display input and output', (_name, value) => {
      const projection = new CursorEventProjection(undefined, {
        secretValues: [value],
      });
      const { call, done } = tool(value);
      const lines = run(projection, [call, done]);
      // tool_use input, its display input, then the tool_result output.
      expect(toolFields(lines)).toEqual([
        { path: '/w/notes.txt', content: 'before *** after' },
        { content: 'before *** after', file_path: '/w/notes.txt' },
        { stdout: 'wrote ***', lines: ['***', 'kept'] },
      ]);
      // Approval and integrity correlation still see what the tool got.
      expect(projection.getTool('write-1')?.input).toEqual({
        path: '/w/notes.txt',
        content: `before ${value} after`,
      });
    });

    it('masks a failed result and a late input update', () => {
      const value = 'SYNTHETIC-KEY-ABC\nDEF-GHI-123';
      const projection = new CursorEventProjection(undefined, {
        secretValues: [value],
      });
      const { call, failed } = tool(value);
      const late: SessionNotification = {
        sessionId: 's',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'write-1',
          rawInput: { path: '/w/notes.txt', content: `late ${value}` },
        },
      };
      const lines = run(projection, [call, late, failed]);
      const fields = toolFields(lines);
      expect(fields[fields.length - 1]).toEqual({ error: 'refused ***' });
      expect(fields).toContainEqual({
        path: '/w/notes.txt',
        content: 'late ***',
      });
      expect(JSON.stringify(fields)).not.toContain('DEF-GHI');
    });

    it('masks a reflowed value in a tool value, keeping its layout', () => {
      const projection = new CursorEventProjection(undefined, {
        secretValues: ['SYNTHETIC  TOKEN  ABCDEF'],
      });
      const { call } = tool('SYNTHETIC\nTOKEN ABCDEF');
      expect(toolFields(run(projection, [call]))[0]).toEqual({
        path: '/w/notes.txt',
        content: 'before *** after',
      });
    });

    it('leaves a tool with no configured value in it byte for byte', () => {
      const { call, done } = tool('ordinary\ntext "quoted" \\ back');
      const withValues = run(
        new CursorEventProjection(undefined, {
          secretValues: ['SYNTHETIC-KEY-ABCDEF123'],
        }),
        [call, done],
      );
      const without = run(new CursorEventProjection(), [call, done]);
      const strip = (line: string): string =>
        line
          .replace(/"toolUseId":"[^"]+"/g, '')
          .replace(/"messageId":"[^"]+"/g, '')
          .replace(/"timestamp":\d+/g, '');
      expect(withValues.map(strip)).toEqual(without.map(strip));
    });
  });

  describe('reflowed values in streamed text', () => {
    const VALUE = 'SYNTHETIC  TOKEN  ABCDEF';
    it.each(['agent_message_chunk', 'agent_thought_chunk'] as const)(
      'masks a single-spaced echo split across %s deltas',
      (kind) => {
        const lines = run(
          new CursorEventProjection(undefined, { secretValues: [VALUE] }),
          ['value: SYNTHETIC ', 'TOKEN ', 'ABCDEF done'].map((text) =>
            chunk(kind, text),
          ),
        );
        expect(texts(lines)).toEqual(['value: *** done']);
        expect(lines.join('\n')).not.toContain('TOKEN');
      },
    );

    it('masks a value reflowed across lines and keeps the text around it', () => {
      const lines = run(
        new CursorEventProjection(undefined, { secretValues: [VALUE] }),
        ['a  b\n\n  SYNTHETIC\n', '   TOKEN\tABCDEF\n\nend  '].map((text) =>
          chunk('agent_message_chunk', text),
        ),
      );
      expect(texts(lines)).toEqual(['a  b\n\n  ***\n\nend  ']);
    });

    it('protects a normalized form shorter than six characters', () => {
      // `ab    cd` qualifies on its own length; its normalized `ab cd` is
      // protected even though it would not qualify alone.
      const lines = run(
        new CursorEventProjection(undefined, { secretValues: ['ab    cd'] }),
        [chunk('agent_message_chunk', 'x ab cd y')],
      );
      expect(texts(lines)).toEqual(['x *** y']);
      expect(
        texts(
          run(
            new CursorEventProjection(undefined, { secretValues: ['ab cd'] }),
            [chunk('agent_message_chunk', 'x ab cd y')],
          ),
        ),
      ).toEqual(['x ab cd y']);
    });

    it('leaves unrelated whitespace exactly as received', () => {
      const text = ' lead\n\n\tindent  two  spaces \r\n trailing   ';
      expect(
        texts(
          run(new CursorEventProjection(undefined, { secretValues: [VALUE] }), [
            chunk('agent_message_chunk', text.slice(0, 9)),
            chunk('agent_message_chunk', text.slice(9)),
          ]),
        ),
      ).toEqual([text]);
    });
  });

  describe('work while a long configured value is held back', () => {
    // A value thousands of characters long (a PEM key) makes the projection
    // hold that many characters back on every delta. Searching that whole
    // held window for every value on every character cost about 1.6 million
    // `indexOf` calls for 200,000 characters of ordinary prose, in one
    // synchronous update on the desktop main process. Counted, not timed, so
    // the bound holds on any machine.
    const PEM = [
      '-----BEGIN PRIVATE KEY-----',
      ...Array.from(
        { length: 40 },
        (_, line) =>
          `MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC${String(line).padStart(13, '0')}`,
      ),
      '-----END PRIVATE KEY-----',
    ].join('\n');
    const SHORT = 'synthetic-short-token-012345';
    const PROSE =
      'lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(4_000);

    /** Characters `String.prototype.indexOf` examines while `work` runs. */
    const indexOfWork = <T>(work: () => T): { result: T; scanned: number } => {
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const original = String.prototype.indexOf;
      let scanned = 0;
      const spy = jest
        .spyOn(String.prototype, 'indexOf')
        .mockImplementation(function (
          this: string,
          search: string,
          from?: number,
        ): number {
          const start = Math.max(0, from ?? 0);
          const at = original.call(this, search, from);
          scanned += (at === -1 ? this.length : at) - start;
          return at;
        });
      try {
        return { result: work(), scanned };
      } finally {
        spy.mockRestore();
      }
    };

    const deltas = (text: string, size: number): string[] => {
      const pieces: string[] = [];
      for (let at = 0; at < text.length; at += size)
        pieces.push(text.slice(at, at + size));
      return pieces;
    };

    it.each([
      ['no match, one delta', PROSE.slice(0, 200_000), 200_000],
      ['no match, 4 KiB deltas', PROSE.slice(0, 200_000), 4_096],
      [
        'both values present, 4 KiB deltas',
        `${PROSE.slice(0, 90_000)}${PEM} ${SHORT}${PROSE.slice(0, 90_000)}${SHORT}.`,
        4_096,
      ],
    ])('stays linear with %s', (_name, text, size) => {
      const expected = text.split(PEM).join('***').split(SHORT).join('***');
      const steps = overlapMatcherWorkCounters.searchSteps;
      const { result: lines, scanned } = indexOfWork(() =>
        run(
          new CursorEventProjection(undefined, { secretValues: [PEM, SHORT] }),
          deltas(text, size).map((piece) =>
            chunk('agent_message_chunk', piece),
          ),
        ),
      );
      // Exact against whole-text masking, so the bound is not bought with
      // different output.
      expect(texts(lines).join('')).toBe(expected);
      expect(scanned).toBeLessThanOrEqual(4 * text.length);
      // The matchers' own search work, over every masked form of both values
      // (plain and JSON-escaped): linear in the text, not in the PEM length.
      expect(
        overlapMatcherWorkCounters.searchSteps - steps,
      ).toBeLessThanOrEqual(32 * text.length);
    });
  });

  describe('a configured value printed JSON-escaped', () => {
    // An agent that JSON-encodes a value before printing it (or prints a JSON
    // list of values) streams its ESCAPED form, which is not the value.
    const VALUE = 'SYNTHETIC-KEY\nCANARY-ESCAPED-5521\n"END"';
    const once = JSON.stringify(VALUE).slice(1, -1);
    const twice = JSON.stringify(once).slice(1, -1);

    it.each(['agent_message_chunk', 'agent_thought_chunk'] as const)(
      'masks it once and twice escaped across %s deltas',
      (kind) => {
        const lines = run(
          new CursorEventProjection(undefined, { secretValues: [VALUE] }),
          [
            `a ${once.slice(0, 9)}`,
            `${once.slice(9)} b ${twice.slice(0, 20)}`,
            `${twice.slice(20)} c`,
          ].map((text) => chunk(kind, text)),
        );
        expect(texts(lines)).toEqual(['a *** b *** c']);
        expect(lines.join('\n')).not.toContain('CANARY-ESCAPED-5521');
      },
    );

    it('masks it inside a tool result', () => {
      const lines = run(
        new CursorEventProjection(undefined, { secretValues: [VALUE] }),
        [
          {
            sessionId: 's',
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'shell-1',
              title: 'Shell',
              kind: 'execute',
              status: 'completed',
              rawInput: { command: 'printenv VALUES' },
              rawOutput: { stdout: `VALUES=["${once}"]` },
            },
          },
        ],
      );
      expect(lines.join('\n')).not.toContain('CANARY-ESCAPED-5521');
    });
  });

  describe('a longer value containing a shorter one', () => {
    const URL = 'postgres://admin:S3cretPass@db.internal:5432/app';
    const PASSWORD = 'S3cretPass';
    const orders = [
      ['URL first', [URL, PASSWORD]],
      ['password first', [PASSWORD, URL]],
    ] as const;

    it.each(
      orders.flatMap(([order, values]) =>
        (['agent_message_chunk', 'agent_thought_chunk'] as const).map(
          (kind) => [order, kind, values] as const,
        ),
      ),
    )('masks the whole URL (%s, %s)', (_order, kind, values) => {
      const one = run(
        new CursorEventProjection(undefined, { secretValues: values }),
        [chunk(kind, `DB is ${URL} ok`)],
      );
      expect(texts(one)).toEqual(['DB is *** ok']);
      const split = run(
        new CursorEventProjection(undefined, { secretValues: values }),
        [
          'DB is postgres://admin:S3cr',
          'etPass@db.internal',
          ':5432/app ok',
        ].map((text) => chunk(kind, text)),
      );
      expect(texts(split)).toEqual(['DB is *** ok']);
      expect([...one, ...split].join('\n')).not.toContain('db.internal');
    });

    it('masks the whole URL split by a tool call', () => {
      const lines = run(
        new CursorEventProjection(undefined, { secretValues: [PASSWORD, URL] }),
        [
          chunk('agent_message_chunk', 'DB is postgres://admin:S3cretPass'),
          {
            sessionId: 's',
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'read-url',
              title: 'Read',
              kind: 'read',
              status: 'completed',
              rawInput: { path: '/w/ordinary.txt' },
              rawOutput: 'ordinary',
            },
          },
          chunk('agent_message_chunk', '@db.internal:5432/app ok'),
        ],
      );
      expect(texts(lines)).toEqual(['DB is ***', ' ok']);
      expect(lines.join('\n')).not.toContain('db.internal');
    });

    it('still masks the password when the URL never completes', () => {
      expect(
        texts(
          run(
            new CursorEventProjection(undefined, {
              secretValues: [URL, PASSWORD],
            }),
            [
              chunk(
                'agent_message_chunk',
                'at postgres://admin:S3cretPass@other',
              ),
            ],
          ),
        ),
      ).toEqual(['at postgres://admin:***@other']);
    });
  });

  describe('a configured value that is only whitespace', () => {
    // Six spaces qualify on their own length. Their normalized form is empty,
    // which must never become a match for everything, yet the value itself
    // must still be masked where it appears exactly.
    const SPACES = '      ';
    it.each(['agent_message_chunk', 'agent_thought_chunk'] as const)(
      'masks it when %s deltas split it',
      (kind) => {
        const lines = run(
          new CursorEventProjection(undefined, { secretValues: [SPACES] }),
          [chunk(kind, 'before   '), chunk(kind, '   after')],
        );
        expect(texts(lines)).toEqual(['before***after']);
      },
    );

    it('masks a longer run as one span and leaves shorter runs alone', () => {
      const lines = run(
        new CursorEventProjection(undefined, { secretValues: [SPACES] }),
        [chunk('agent_message_chunk', 'a        b  c\n\nd')],
      );
      expect(texts(lines)).toEqual(['a***b  c\n\nd']);
    });

    it('lets a longer value spanning the run own it', () => {
      const lines = run(
        new CursorEventProjection(undefined, {
          secretValues: [SPACES, 'alpha      beta'],
        }),
        [chunk('agent_message_chunk', 'x alpha      beta y alpha   beta z')],
      );
      expect(texts(lines)).toEqual(['x *** y *** z']);
    });
  });

  describe('text separated by other blocks', () => {
    const VALUE = 'SYNTHETIC-CROSS-BLOCK-123456';
    const read: SessionNotification = {
      sessionId: 's',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'read-1',
        title: 'Read',
        kind: 'read',
        status: 'pending',
        rawInput: { path: '/w/ordinary.txt' },
      },
    };
    const readDone: SessionNotification = {
      sessionId: 's',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'read-1',
        status: 'completed',
        rawOutput: 'ordinary tool result',
      },
    };

    it('masks a response value split by a tool call', () => {
      const lines = run(
        new CursorEventProjection(undefined, { secretValues: [VALUE] }),
        [
          chunk('agent_message_chunk', 'value: SYNTHETIC-CROSS-'),
          read,
          readDone,
          chunk('agent_message_chunk', 'BLOCK-123456 done'),
        ],
      );
      expect(lines.join('\n')).not.toContain('CROSS-');
      expect(lines.join('\n')).not.toContain('BLOCK-123456');
      // The mask sits where the value began; the tool stays between.
      expect(texts(lines)).toEqual(['value: ***', ' done']);
      const kinds = rebuilt(lines).flatMap((message) =>
        message.blocks.map((block) =>
          typeof block === 'object' && block !== null && 'type' in block
            ? block.type
            : undefined,
        ),
      );
      expect(kinds).toEqual(['text', 'tool_use', 'tool_result', 'text']);
    });

    it.each([
      [
        'a thought and a response',
        [
          chunk('agent_thought_chunk', 'thinking SYNTHETIC-CR'),
          chunk('agent_message_chunk', 'answer '),
          chunk('agent_thought_chunk', 'OSS-BLOCK-123456 more'),
        ],
        ['thinking ***', 'answer ', ' more'],
      ],
      [
        'a host notice',
        [
          chunk('agent_message_chunk', 'value: SYNTHETIC-CROSS-'),
          { notice: 'Host notice.' },
          chunk('agent_message_chunk', 'BLOCK-123456 done'),
        ],
        ['value: ***', 'Host notice.', ' done'],
      ],
    ])('masks a value split by %s', (_name, steps, expected) => {
      const lines = run(
        new CursorEventProjection(undefined, { secretValues: [VALUE] }),
        steps,
      );
      expect(texts(lines)).toEqual(expected);
      expect(lines.join('\n')).not.toContain('CROSS-');
    });

    it('releases an unmatched prefix into its own block when the turn ends', () => {
      const lines = run(
        new CursorEventProjection(undefined, { secretValues: [VALUE] }),
        [
          chunk('agent_message_chunk', 'value: SYNTHETIC-CROSS-'),
          read,
          readDone,
          chunk('agent_message_chunk', 'unrelated'),
        ],
      );
      expect(texts(lines)).toEqual(['value: SYNTHETIC-CROSS-', 'unrelated']);
    });

    it('releases held text when the turn stops mid-value', () => {
      // `finish()` runs however the turn ended: completion, error or cancel.
      const projection = new CursorEventProjection(undefined, {
        secretValues: [VALUE],
      });
      const lines = run(projection, [
        chunk('agent_message_chunk', 'partial SYNTHETIC-CROSS-BLO'),
        read,
      ]);
      expect(texts(lines)).toEqual(['partial SYNTHETIC-CROSS-BLO']);
    });

    it('rebuilds the same blocks as an unmasked projection when nothing matches', () => {
      const steps = [
        chunk('agent_thought_chunk', 'plan  one'),
        chunk('agent_message_chunk', 'first\n'),
        read,
        readDone,
        chunk('agent_message_chunk', 'second '),
        { notice: 'Host notice.' },
        chunk('agent_thought_chunk', 'plan two'),
        chunk('agent_message_chunk', 'third'),
      ];
      const strip = (message: { role: string; blocks: unknown[] }): unknown =>
        JSON.parse(JSON.stringify(message), (key, value: unknown) =>
          key === 'toolUseId' ? undefined : value,
        );
      expect(
        rebuilt(
          run(
            new CursorEventProjection(undefined, { secretValues: [VALUE] }),
            steps,
          ),
        ).map(strip),
      ).toEqual(rebuilt(run(new CursorEventProjection(), steps)).map(strip));
    });

    it('holds back no more than one value length across tool calls', () => {
      const projection = new CursorEventProjection(undefined, {
        secretValues: [VALUE],
      });
      let sent = 0;
      let emitted = 0;
      for (let index = 0; index < 500; index += 1) {
        const text = `line ${String(index)} of ordinary output. `;
        sent += text.length;
        for (const step of [
          chunk('agent_message_chunk', text),
          read,
          readDone,
        ]) {
          const events = [projection.update(step)];
          events.unshift(...projection.takeFlushed());
          for (const event of events) {
            const patches: unknown = event?.patches;
            const list: unknown[] = Array.isArray(patches) ? patches : [];
            for (const patch of list)
              if (typeof patch === 'object' && patch !== null) {
                if (
                  'appendText' in patch &&
                  typeof patch.appendText === 'string'
                )
                  emitted += patch.appendText.length;
                if (
                  'block' in patch &&
                  typeof patch.block === 'object' &&
                  patch.block !== null &&
                  'text' in patch.block &&
                  typeof patch.block.text === 'string'
                )
                  emitted += patch.block.text.length;
              }
          }
        }
        expect(sent - emitted).toBeLessThan(VALUE.length);
      }
    });
  });
});

describe('the projection block limit', () => {
  it('still bounds cumulative output when large edit diffs are supported', () => {
    const projection = new CursorEventProjection();
    const text = 'x'.repeat(1024 * 1024);
    for (let index = 0; index < 63; index += 1)
      projection.update({
        sessionId: 's',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'large-output',
          title: 'Read file',
          kind: 'read',
          status: 'completed',
          rawOutput: text,
        },
      });
    // Notices share the same byte budget as provider updates.
    expect(() => projection.notice(text)).toThrow('limit');
  });

  const toolCall = (id: string): SessionNotification => ({
    sessionId: 's',
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: id,
      title: 'Read file',
      kind: 'read',
      status: 'pending',
      rawInput: { path: 'x' },
    },
  });

  it('admits exactly 4,096 blocks and refuses the next one', () => {
    // The guard ran on entry and compared the count BEFORE the update added
    // its block, so a 4,097th distinct block was accepted.
    const projection = new CursorEventProjection();
    for (let index = 0; index < 4_096; index += 1)
      projection.update(toolCall(`block-${index}`));

    expect(() => projection.update(toolCall('block-4096'))).toThrow();
  });

  it('still accepts an update that adds no new block at capacity', () => {
    // Admission is per new block, so text continuing the block already open
    // must keep flowing at capacity. A blanket pre-update guard would drop it.
    const projection = new CursorEventProjection();
    for (let index = 0; index < 4_095; index += 1)
      projection.update(toolCall(`block-${index}`));
    const chunk = (text: string): SessionNotification => ({
      sessionId: 's',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text },
      },
    });
    // The 4,096th block: the open text block.
    projection.update(chunk('first'));

    expect(() => projection.update(chunk(' and more'))).not.toThrow();
    // ...while a genuinely new block is still refused.
    expect(() => projection.update(toolCall('one-too-many'))).toThrow();
  });
});
