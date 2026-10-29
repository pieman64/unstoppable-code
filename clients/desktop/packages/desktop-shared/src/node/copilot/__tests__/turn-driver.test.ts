import type {
  CurrentToolMetadata,
  SessionConfig,
  SessionEvent,
} from '@github/copilot-sdk';
import type { CopilotToolMetadataRpc } from '../tool-snapshot';
import { runCopilotTurn, type CopilotTurnOptions } from '../turn-driver';

type EventPayload = {
  [K in SessionEvent['type']]: Pick<
    Extract<SessionEvent, { type: K }>,
    'type' | 'data'
  >;
}[SessionEvent['type']];

interface FixtureSession {
  sessionId: string;
  send: jest.Mock<Promise<string>, []>;
  abort: jest.Mock<Promise<void>, []>;
  rpc?: CopilotToolMetadataRpc;
}
interface FixtureRuntime {
  client: {
    createSession: jest.Mock<Promise<FixtureSession>, [SessionConfig]>;
    resumeSession: jest.Mock<Promise<FixtureSession>, [string, SessionConfig]>;
  };
  exited: Promise<void>;
  close: jest.Mock<Promise<void>, []>;
}
function fixture(): {
  options: CopilotTurnOptions & {
    emit: jest.Mock<Promise<void>, [Record<string, unknown>]>;
    onSession: jest.Mock<Promise<void>, []>;
  };
  runtime: FixtureRuntime;
  session: FixtureSession;
  event: (payload: EventPayload) => void;
  authorize: (name: string, args: Record<string, unknown>) => Promise<unknown>;
} {
  let config!: SessionConfig;
  let exited!: () => void;
  let sequence = 0;
  const session = {
    sessionId: 'native-session',
    send: jest.fn(() => Promise.resolve('send-id')),
    abort: jest.fn(() => Promise.resolve()),
  };
  const runtime = {
    client: {
      createSession: jest.fn((value: SessionConfig) => {
        config = value;
        return Promise.resolve(session);
      }),
      resumeSession: jest.fn((_id: string, value: SessionConfig) => {
        config = value;
        return Promise.resolve(session);
      }),
    },
    exited: new Promise<void>((resolve) => {
      exited = resolve;
    }),
    close: jest.fn(() => {
      exited();
      return Promise.resolve();
    }),
  };
  const options = {
    runtime,
    workingDirectory: '/workspace',
    configDirectory: '/private/session',
    model: 'copilot-model',
    turnId: 'turn',
    prompt: 'hello',
    signal: new AbortController().signal,
    authorize: (): Promise<{ decision: 'deny' }> =>
      Promise.resolve({ decision: 'deny' }),
    emit: jest.fn<Promise<void>, [Record<string, unknown>]>(() =>
      Promise.resolve(),
    ),
    onSession: jest.fn(() => Promise.resolve()),
  };
  const event = (payload: EventPayload): void =>
    config.onEvent?.({
      id: `${++sequence}`,
      ...payload,
      timestamp: '2026-09-29T00:00:00Z',
      parentId: null,
      ephemeral: true,
    });
  const authorize = async (
    toolName: string,
    toolArgs: Record<string, unknown>,
  ): Promise<unknown> =>
    config.hooks?.onPreToolUse?.(
      {
        toolName,
        toolArgs,
        timestamp: new Date(),
        workingDirectory: options.workingDirectory,
        sessionId: session.sessionId,
      },
      { sessionId: session.sessionId },
    );
  return { options, runtime, session, event, authorize };
}

test('interactive turns have no implicit one-hour deadline', async () => {
  jest.useFakeTimers();
  const f = fixture();
  const result = runCopilotTurn(f.options);
  void result.catch(() => undefined);
  try {
    await jest.advanceTimersByTimeAsync(60 * 60_000 + 1);
    expect(f.session.send).toHaveBeenCalledTimes(1);
    expect(f.runtime.close).not.toHaveBeenCalled();
    f.event({ type: 'session.idle', data: {} });
    await expect(result).resolves.toMatchObject({
      sessionId: 'native-session',
    });
  } finally {
    f.event({ type: 'session.idle', data: {} });
    await result.catch(() => undefined);
    jest.useRealTimers();
  }
});

test.each(['missing', 'denied', 'different-input'] as const)(
  'stops a successful write with %s authorization',
  async (authorization) => {
    const f = fixture();
    const args = { path: 'file.txt', file_text: 'changed' };
    f.session.send.mockImplementation(async () => {
      f.event({
        type: 'tool.execution_start',
        data: {
          toolCallId: 'write',
          toolName: 'create',
          arguments: args,
        },
      });
      if (authorization !== 'missing')
        await f.authorize(
          'create',
          authorization === 'different-input'
            ? { ...args, path: 'other.txt' }
            : args,
        );
      f.event({
        type: 'tool.execution_complete',
        data: {
          toolCallId: 'write',
          success: true,
          result: { content: 'written' },
        },
      });
      f.event({ type: 'session.idle', data: {} });
      return 'send-id';
    });
    await expect(
      runCopilotTurn({
        ...f.options,
        authorize: () =>
          Promise.resolve({
            decision: authorization === 'denied' ? 'deny' : 'allow',
          }),
      }),
    ).rejects.toThrow(/authorization/i);
    expect(f.runtime.close).toHaveBeenCalled();
  },
);

test.each(['allow', 'deny'] as const)(
  'accepts a correlated %s with an honest completion',
  async (decision) => {
    const f = fixture();
    const args = { path: 'file.txt', file_text: 'changed' };
    f.session.send.mockImplementation(async () => {
      f.event({
        type: 'tool.execution_start',
        data: {
          toolCallId: 'write',
          toolName: 'create',
          arguments: args,
        },
      });
      await f.authorize('create', args);
      f.event({
        type: 'tool.execution_complete',
        data: {
          toolCallId: 'write',
          success: decision === 'allow',
          result: { content: decision },
        },
      });
      f.event({ type: 'session.idle', data: {} });
      return 'send-id';
    });
    await expect(
      runCopilotTurn({
        ...f.options,
        authorize: () => Promise.resolve({ decision }),
      }),
    ).resolves.toMatchObject({ sessionId: 'native-session' });
  },
);

test.each(['view', 'mcp-read', 'unknown'] as const)(
  'only inspected native reads may complete without a hook: %s',
  async (toolName) => {
    const f = fixture();
    f.session.send.mockImplementation(() => {
      f.event({
        type: 'tool.execution_start',
        data: {
          toolCallId: 'read',
          toolName,
          arguments: { path: 'file.txt' },
          ...(toolName === 'mcp-read'
            ? { mcpServerName: 'selected', mcpToolName: 'read' }
            : {}),
        },
      });
      f.event({
        type: 'tool.execution_complete',
        data: {
          toolCallId: 'read',
          success: true,
          result: { content: 'data' },
        },
      });
      f.event({ type: 'session.idle', data: {} });
      return Promise.resolve('send-id');
    });
    const result = runCopilotTurn(f.options);
    if (toolName === 'view')
      await expect(result).resolves.toMatchObject({
        sessionId: 'native-session',
      });
    else await expect(result).rejects.toThrow(/authorization/i);
  },
);

test('an authorization failure settles even when runtime exit is never reported', async () => {
  const f = fixture();
  f.runtime.close.mockResolvedValue(undefined);
  f.session.send.mockImplementation(() => {
    f.event({
      type: 'tool.execution_complete',
      data: {
        toolCallId: 'unseen',
        success: true,
        result: { content: 'changed' },
      },
    });
    return Promise.resolve('send-id');
  });
  await expect(runCopilotTurn({ ...f.options, timeoutMs: 50 })).rejects.toThrow(
    /authorization/i,
  );
});

test.each(['failed-unobserved', 'denied-read', 'reused-id'] as const)(
  'rejects an integrity violation: %s',
  async (kind) => {
    const f = fixture();
    const name = kind === 'denied-read' ? 'view' : 'create';
    const args = { path: 'file.txt', file_text: 'changed' };
    f.session.send.mockImplementation(async () => {
      const start = (): void =>
        f.event({
          type: 'tool.execution_start',
          data: {
            toolCallId: 'same-id',
            toolName: name,
            arguments: args,
          },
        });
      const complete = (): void =>
        f.event({
          type: 'tool.execution_complete',
          data: {
            toolCallId: 'same-id',
            success: kind !== 'failed-unobserved',
            result: { content: 'result' },
          },
        });
      start();
      if (kind !== 'failed-unobserved') await f.authorize(name, args);
      complete();
      if (kind === 'reused-id') {
        start();
        complete();
      }
      f.event({ type: 'session.idle', data: {} });
      return 'send-id';
    });
    await expect(
      runCopilotTurn({
        ...f.options,
        authorize: () =>
          Promise.resolve({
            decision: kind === 'denied-read' ? 'deny' : 'allow',
          }),
      }),
    ).rejects.toThrow(/authorization/i);
  },
);

test.each<[boolean, string]>([
  [true, 'Missing conversation'],
  [false, 'Missing conversation'],
  [
    true,
    'Request session.resume failed with message: Failed to load session events: Session not found: lost',
  ],
  [
    false,
    'Request session.resume failed with message: Failed to load session events: Session not found: lost',
  ],
])(
  'only interactive turns recover a definitively missing session (%s, %s)',
  async (recover, message) => {
    const f = fixture();
    const onSessionUnavailable = jest.fn(() => Promise.resolve());
    f.runtime.client.resumeSession.mockRejectedValue(new Error(message));
    f.session.send.mockImplementation(() => {
      f.event({ type: 'session.idle', data: {} });
      return Promise.resolve('send-id');
    });
    const result = runCopilotTurn({
      ...f.options,
      sessionId: 'lost',
      ...(recover ? { onSessionUnavailable } : {}),
    });
    if (recover) {
      await expect(result).resolves.toMatchObject({
        sessionId: 'native-session',
      });
      expect(onSessionUnavailable).toHaveBeenCalledTimes(1);
      expect(f.runtime.client.createSession).toHaveBeenCalledTimes(1);
    } else {
      await expect(result).rejects.toThrow(message);
      expect(f.runtime.client.createSession).not.toHaveBeenCalled();
    }
  },
);

test.each([
  'Unauthorized',
  'Connection reset',
  'Failed to resume: unknown',
  'Session not found: some-other-session',
])('does not recover an ambiguous resume failure: %s', async (message) => {
  const f = fixture();
  const onSessionUnavailable = jest.fn(() => Promise.resolve());
  f.runtime.client.resumeSession.mockRejectedValue(new Error(message));
  f.session.send.mockImplementation(() => {
    f.event({ type: 'session.idle', data: {} });
    return Promise.resolve('send-id');
  });
  await expect(
    runCopilotTurn({
      ...f.options,
      sessionId: 'existing',
      onSessionUnavailable,
    }),
  ).rejects.toThrow(message);
  expect(onSessionUnavailable).not.toHaveBeenCalled();
  expect(f.runtime.client.createSession).not.toHaveBeenCalled();
});

test('waits for admitted output to be saved before completing and closes the runtime', async () => {
  const f = fixture();
  let release!: () => void;
  const commit = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.options.emit.mockImplementation(() => commit);
  f.session.send.mockImplementation(() => {
    f.event({
      type: 'assistant.message_delta',
      data: {
        messageId: 'answer',
        deltaContent: 'Hi',
      },
    });
    f.event({
      type: 'assistant.usage',
      data: {
        model: 'copilot-model',
        inputTokens: 10,
        outputTokens: 2,
      },
    });
    f.event({ type: 'session.idle', data: {} });
    return Promise.resolve('send-id');
  });
  let complete = false;
  const result = runCopilotTurn(f.options).then((value) => {
    complete = true;
    return value;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(f.options.emit).toHaveBeenCalled();
  expect(complete).toBe(false);
  release();
  await expect(result).resolves.toMatchObject({
    sessionId: 'native-session',
    text: 'Hi',
    usage: { input_tokens: 10, output_tokens: 2 },
  });
  expect(f.runtime.close).toHaveBeenCalledTimes(1);
});

test('resumes with a complete authority selection and ignores historical output', async () => {
  const f = fixture();
  f.runtime.client.resumeSession.mockImplementation(async (_id, config) => {
    config.onEvent?.({
      id: 'history',
      type: 'assistant.message',
      timestamp: '2026-09-28T00:00:00Z',
      parentId: null,
      ephemeral: false,
      data: { messageId: 'old', content: 'old answer' },
    });
    // The fixture keeps its callback through the normal create setter.
    return f.runtime.client.createSession(config);
  });
  f.session.send.mockImplementation(() => {
    f.event({
      type: 'assistant.message',
      data: { messageId: 'new', content: 'new answer' },
    });
    f.event({ type: 'session.idle', data: {} });
    return Promise.resolve('send-id');
  });
  await expect(
    runCopilotTurn({ ...f.options, sessionId: 'saved' }),
  ).resolves.toMatchObject({ text: 'new answer' });
  expect(f.runtime.client.resumeSession).toHaveBeenCalledWith(
    'saved',
    expect.objectContaining({
      enableConfigDiscovery: false,
      enableFileHooks: false,
      mcpServers: {},
      customAgents: [],
    }),
  );
  expect(JSON.stringify(f.options.emit.mock.calls)).not.toContain('old answer');
});

test('closes execution and rejects a failed transcript delivery', async () => {
  const f = fixture();
  f.options.emit.mockRejectedValue(new Error('disk unavailable'));
  f.session.send.mockImplementation(() => {
    f.event({
      type: 'assistant.message',
      data: { messageId: 'answer', content: 'Hi' },
    });
    return Promise.resolve('send-id');
  });
  await expect(runCopilotTurn(f.options)).rejects.toThrow('disk unavailable');
  expect(f.runtime.close).toHaveBeenCalled();
});

test('a bounded timeout terminates execution even without an idle event', async () => {
  const f = fixture();
  await expect(runCopilotTurn({ ...f.options, timeoutMs: 5 })).rejects.toThrow(
    'timed out',
  );
  expect(f.runtime.close).toHaveBeenCalledTimes(1);
});

test('normalizes inclusive native usage into disjoint canonical input/cache counts', async () => {
  const f = fixture();
  f.session.send.mockImplementation(() => {
    // Pinned CLI reports 6 uncached + 4 read + 2 written as inputTokens=12.
    f.event({
      type: 'assistant.usage',
      data: {
        model: 'copilot-model',
        inputTokens: 12,
        outputTokens: 3,
        cacheReadTokens: 4,
        cacheWriteTokens: 2,
      },
    });
    f.event({ type: 'session.idle', data: {} });
    return Promise.resolve('send-id');
  });
  expect((await runCopilotTurn(f.options)).usage).toEqual({
    input_tokens: 6,
    output_tokens: 3,
    cache_read_input_tokens: 4,
    cache_creation_input_tokens: 2,
  });
});

test('a child idle cannot finish the root turn', async () => {
  const f = fixture();
  f.runtime.client.createSession.mockImplementation((config) =>
    Promise.resolve({
      ...f.session,
      send: jest.fn(() => {
        config.onEvent?.({
          id: 'child-idle',
          type: 'session.idle',
          data: {},
          agentId: 'child',
          timestamp: '2026-09-29T00:00:00Z',
          parentId: null,
          ephemeral: true,
        });
        return Promise.resolve('send-id');
      }),
    }),
  );
  await expect(runCopilotTurn({ ...f.options, timeoutMs: 5 })).rejects.toThrow(
    'timed out',
  );
});

test('secret-bearing turns never publish partial deltas or unmasked tool values', async () => {
  const f = fixture();
  f.session.send.mockImplementation(() => {
    f.event({
      type: 'assistant.message_delta',
      data: {
        messageId: 'a',
        deltaContent: 'before secret-',
      },
    });
    expect(f.options.emit).not.toHaveBeenCalled();
    f.event({
      type: 'assistant.message_delta',
      data: {
        messageId: 'b',
        deltaContent: 'value after',
      },
    });
    expect(f.options.emit).not.toHaveBeenCalled();
    f.event({
      type: 'tool.execution_start',
      data: {
        toolCallId: 'call',
        toolName: 'bash',
        arguments: { command: 'echo secret-value' },
      },
    });
    f.event({ type: 'session.idle', data: {} });
    return Promise.resolve('send-id');
  });
  const result = await runCopilotTurn({
    ...f.options,
    secretValues: ['secret-value'],
  });
  expect(result.text).toBe('before *** after');
  const serialized = JSON.stringify(f.options.emit.mock.calls);
  expect(serialized).not.toContain('secret-');
  expect(serialized).toContain('before ***');
  expect(serialized).toContain(' after');
});

test('cancellation during session checkpoint never sends a prompt', async () => {
  const f = fixture();
  const abort = new AbortController();
  f.options.onSession.mockImplementation(() => {
    abort.abort();
    return Promise.resolve();
  });
  await expect(
    runCopilotTurn({ ...f.options, signal: abort.signal }),
  ).rejects.toThrow();
  expect(f.session.send).not.toHaveBeenCalled();
});

test('persists patches in provider order when the first write is slow', async () => {
  const f = fixture();
  let release!: () => void;
  const first = new Promise<void>((resolve) => {
    release = resolve;
  });
  const committed: number[] = [];
  f.options.emit.mockImplementation(async (event) => {
    if (event.revision === 1) await first;
    committed.push(Number(event.revision));
  });
  f.session.send.mockImplementation(() => {
    f.event({
      type: 'assistant.message_delta',
      data: {
        messageId: 'a',
        deltaContent: 'Hello',
      },
    });
    f.event({
      type: 'assistant.message_delta',
      data: {
        messageId: 'a',
        deltaContent: ' world',
      },
    });
    f.event({ type: 'session.idle', data: {} });
    return Promise.resolve('send-id');
  });
  const running = runCopilotTurn(f.options);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const beforeRelease = [...committed];
  release();
  await running;
  expect(beforeRelease).toEqual([]);
  expect(committed).toEqual([1, 2]);
});

test('preserves text/tool order and masks normalized nested tool values in secret-bearing turns', async () => {
  const f = fixture();
  f.session.send.mockImplementation(async () => {
    f.event({
      type: 'assistant.message',
      data: { messageId: 'before', content: 'before' },
    });
    f.event({
      type: 'tool.execution_start',
      data: {
        toolCallId: 'call',
        toolName: 'bash',
        arguments: { command: 'echo secret\nvalue', nested: ['secret\tvalue'] },
      },
    });
    await f.authorize('bash', {
      command: 'echo secret\nvalue',
      nested: ['secret\tvalue'],
    });
    f.event({
      type: 'tool.execution_complete',
      data: {
        toolCallId: 'call',
        success: true,
        result: { content: 'secret\nvalue' },
      },
    });
    f.event({
      type: 'assistant.message',
      data: { messageId: 'after', content: 'after' },
    });
    f.event({ type: 'session.idle', data: {} });
    return Promise.resolve('send-id');
  });
  await runCopilotTurn({
    ...f.options,
    authorize: () => Promise.resolve({ decision: 'allow' }),
    secretValues: ['secret value'],
  });
  expect([
    ...new Set(f.options.emit.mock.calls.map(([event]) => event.messageId)),
  ]).toEqual(['turn:message:before', 'turn:tool:call', 'turn:message:after']);
  const saved = JSON.stringify(f.options.emit.mock.calls);
  expect(saved).not.toContain('secret');
  expect(saved).toContain('***');
});

test('drains buffered text even when runtime cleanup fails after a timeout', async () => {
  const f = fixture();
  f.runtime.close.mockRejectedValue(new Error('cleanup failure'));
  f.session.send.mockImplementation(() => {
    f.event({
      type: 'assistant.message',
      data: {
        messageId: 'a',
        content: 'answer secret-value',
      },
    });
    return Promise.resolve('send-id');
  });
  await expect(
    runCopilotTurn({
      ...f.options,
      secretValues: ['secret-value'],
      timeoutMs: 5,
    }),
  ).rejects.toThrow('Copilot turn timed out.');
  expect(JSON.stringify(f.options.emit.mock.calls)).toContain('answer ***');
  expect(JSON.stringify(f.options.emit.mock.calls)).not.toContain(
    'secret-value',
  );
});

test.each(['text-first', 'tool-first'])(
  'redacts a secret split across assistant text and tool output in %s order',
  async (order) => {
    const f = fixture();
    f.session.send.mockImplementation(() => {
      const text = (): void =>
        f.event({
          type: 'assistant.message',
          data: {
            messageId: 'answer',
            content: order === 'text-first' ? 'secret-' : 'value',
          },
        });
      const tool = (): void => {
        f.event({
          type: 'tool.execution_start',
          data: {
            toolCallId: 'call',
            toolName: 'view',
            arguments: { path: 'file' },
          },
        });
        f.event({
          type: 'tool.execution_complete',
          data: {
            toolCallId: 'call',
            success: true,
            result: { content: order === 'text-first' ? 'value' : 'secret-' },
          },
        });
      };
      if (order === 'text-first') {
        text();
        tool();
      } else {
        tool();
        text();
      }
      f.event({ type: 'session.idle', data: {} });
      return Promise.resolve('send-id');
    });
    const result = await runCopilotTurn({
      ...f.options,
      secretValues: ['secret-value'],
    });
    const saved = JSON.stringify(f.options.emit.mock.calls);
    expect(saved).not.toContain('secret-');
    expect(saved).not.toContain('"text":"value"');
    expect(saved).not.toContain('"output":"value"');
    expect(saved).toContain('***');
    expect(result.text).not.toContain('secret-');
    expect(result.text).not.toBe('value');
  },
);

test('preserves cancellation when runtime cleanup also fails', async () => {
  const f = fixture();
  const controller = new AbortController();
  f.runtime.close.mockRejectedValue(new Error('cleanup failure'));
  const result = expect(
    runCopilotTurn({ ...f.options, signal: controller.signal }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  await result;
});

test('surfaces runtime cleanup failure after a successful turn', async () => {
  const f = fixture();
  f.runtime.close.mockRejectedValue(new Error('cleanup failure'));
  f.session.send.mockImplementation(() => {
    f.event({ type: 'session.idle', data: {} });
    return Promise.resolve('send-id');
  });
  await expect(runCopilotTurn(f.options)).rejects.toThrow('cleanup failure');
});

test('redacts a secret split across consecutive tool results before persistence', async () => {
  const f = fixture();
  f.session.send.mockImplementation(() => {
    for (const [id, content] of [
      ['first', 'secret-'],
      ['second', 'value'],
    ]) {
      f.event({
        type: 'tool.execution_start',
        data: { toolCallId: id, toolName: 'view', arguments: { path: id } },
      });
      f.event({
        type: 'tool.execution_complete',
        data: { toolCallId: id, success: true, result: { content } },
      });
    }
    f.event({ type: 'session.idle', data: {} });
    return Promise.resolve('send-id');
  });
  await runCopilotTurn({ ...f.options, secretValues: ['secret-value'] });
  const saved = JSON.stringify(f.options.emit.mock.calls);
  expect(saved).not.toContain('secret-');
  expect(saved).not.toContain('value');
  expect(saved).toContain('***');
});

test('reports cancellation and aborts the SDK send even if the runtime exits first', async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.signal.addEventListener('abort', () => {
    void f.runtime.close();
  });
  f.session.send.mockImplementation(() => new Promise(() => undefined));
  const running = runCopilotTurn({ ...f.options, signal: controller.signal });
  const result = expect(running).rejects.toMatchObject({ name: 'AbortError' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  await result;
  expect(f.session.abort).toHaveBeenCalledTimes(1);
});

test.each(['start', 'completion'])(
  'masks secrets split in tool %s order when parallel tools complete in reverse order',
  async (order) => {
    const f = fixture();
    f.session.send.mockImplementation(() => {
      for (const id of ['first', 'second'])
        f.event({
          type: 'tool.execution_start',
          data: { toolCallId: id, toolName: 'view', arguments: { path: id } },
        });
      for (const [id, content] of [
        ['second', order === 'completion' ? 'secret-' : 'value'],
        ['first', order === 'completion' ? 'value' : 'secret-'],
      ])
        f.event({
          type: 'tool.execution_complete',
          data: { toolCallId: id, success: true, result: { content } },
        });
      f.event({ type: 'session.idle', data: {} });
      return Promise.resolve('send-id');
    });
    await runCopilotTurn({ ...f.options, secretValues: ['secret-value'] });
    expect(f.options.emit.mock.calls.map(([event]) => event.messageId)).toEqual(
      ['turn:tool:first', 'turn:tool:second'],
    );
    const saved = JSON.stringify(f.options.emit.mock.calls);
    expect(saved).not.toContain('secret-');
    expect(saved).not.toContain('value');
    expect(saved).toContain('***');
  },
);

test('an SDK-aborted root idle rejects as cancellation and drains masked output', async () => {
  const f = fixture();
  f.session.send.mockImplementation(() => {
    f.event({
      type: 'assistant.message',
      data: { messageId: 'partial', content: 'partial secret-value' },
    });
    f.event({ type: 'session.idle', data: { aborted: true } });
    return Promise.resolve('send-id');
  });
  await expect(
    runCopilotTurn({ ...f.options, secretValues: ['secret-value'] }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(f.options.signal.aborted).toBe(false);
  expect(f.runtime.close).toHaveBeenCalled();
  const saved = JSON.stringify(f.options.emit.mock.calls);
  expect(saved).toContain('partial ***');
  expect(saved).not.toContain('secret-value');
});

const nativeMetadata: CurrentToolMetadata = {
  name: 'fixture-inspect',
  namespacedName: 'fixture/inspect',
  mcpServerName: 'fixture',
  mcpToolName: 'inspect',
  description: 'Inspect selected evidence',
  input_schema: { type: 'object', properties: { value: { type: 'string' } } },
};

interface MetadataFixture {
  initializeAndValidate: jest.Mock<
    ReturnType<CopilotToolMetadataRpc['tools']['initializeAndValidate']>,
    []
  >;
  getCurrentMetadata: jest.Mock<
    ReturnType<CopilotToolMetadataRpc['tools']['getCurrentMetadata']>,
    []
  >;
  list: jest.Mock<ReturnType<CopilotToolMetadataRpc['mcp']['list']>, []>;
}
function attachToolMetadata(f: ReturnType<typeof fixture>): MetadataFixture {
  const initializeAndValidate = jest.fn(() => Promise.resolve({}));
  const getCurrentMetadata = jest.fn(() =>
    Promise.resolve({ tools: [nativeMetadata] }),
  );
  const list = jest.fn(() =>
    Promise.resolve({
      servers: [{ name: 'fixture', status: 'connected' as const }],
    }),
  );
  Object.assign(f.session, {
    rpc: {
      tools: { initializeAndValidate, getCurrentMetadata },
      mcp: { list },
    },
  });
  f.session.send.mockImplementation(() => {
    f.event({ type: 'session.idle', data: {} });
    return Promise.resolve('send-id');
  });
  return { initializeAndValidate, getCurrentMetadata, list };
}

test('verifies native MCP metadata before publishing the session or sending', async () => {
  const f = fixture();
  const metadata = attachToolMetadata(f);
  const onToolsReady = jest.fn(() => {
    expect(metadata.initializeAndValidate).toHaveBeenCalledTimes(1);
    expect(metadata.getCurrentMetadata).toHaveBeenCalledTimes(1);
    expect(f.options.onSession).not.toHaveBeenCalled();
    expect(f.session.send).not.toHaveBeenCalled();
  });
  await runCopilotTurn(
    Object.assign(f.options, {
      onToolsReady,
      mcpServers: {
        fixture: {
          type: 'http' as const,
          url: 'http://127.0.0.1/mcp',
          tools: ['*'],
        },
      },
    }),
  );
  expect(onToolsReady.mock.calls).toHaveLength(1);
  expect(onToolsReady.mock.calls[0]).toEqual([
    expect.objectContaining({ version: 1 }),
    [{ name: 'fixture', status: 'connected' }],
  ]);
});

test('rejects a changed native tool table before a resumed prompt', async () => {
  const f = fixture();
  attachToolMetadata(f);
  const onToolsReady = jest.fn(() => {
    throw new Error('Native capability mismatch');
  });
  await expect(
    runCopilotTurn(
      Object.assign(f.options, {
        onToolsReady,
        sessionId: 'retained',
        mcpServers: {
          fixture: {
            type: 'http' as const,
            url: 'http://127.0.0.1/mcp',
            tools: ['*'],
          },
        },
      }),
    ),
  ).rejects.toThrow('Native capability mismatch');
  expect(f.session.send).not.toHaveBeenCalled();
  expect(f.options.onSession).not.toHaveBeenCalled();
  expect(f.runtime.close).toHaveBeenCalledTimes(1);
});

test('does not accept a selected server that failed to connect as an empty tool table', async () => {
  const f = fixture();
  const metadata = attachToolMetadata(f);
  metadata.list.mockResolvedValue({
    servers: [{ name: 'fixture', status: 'failed' }],
  });
  await expect(
    runCopilotTurn(
      Object.assign(f.options, {
        onToolsReady: jest.fn(),
        mcpServers: {
          fixture: {
            type: 'http' as const,
            url: 'http://127.0.0.1/mcp',
            tools: ['*'],
          },
        },
      }),
    ),
  ).rejects.toThrow(/MCP|capabilit|connect/i);
  expect(f.session.send).not.toHaveBeenCalled();
  expect(f.options.onSession).not.toHaveBeenCalled();
});

test('cancellation stops native metadata setup without publishing or sending', async () => {
  const f = fixture();
  const metadata = attachToolMetadata(f);
  const abort = new AbortController();
  let release!: () => void;
  metadata.initializeAndValidate.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = (): void => resolve({});
      }),
  );
  const onToolsReady = jest.fn();
  const outcome = runCopilotTurn(
    Object.assign(f.options, { onToolsReady, signal: abort.signal }),
  );
  void outcome.catch(() => undefined);
  await new Promise((resolve) => setImmediate(resolve));
  abort.abort(new Error('Stop native metadata setup'));
  try {
    await expect(outcome).rejects.toThrow(
      /Stop native metadata setup|cancelled/,
    );
    expect(f.options.onSession).not.toHaveBeenCalled();
    expect(f.session.send).not.toHaveBeenCalled();
    expect(onToolsReady).not.toHaveBeenCalled();
  } finally {
    release?.();
    await outcome.catch(() => undefined);
  }
});

test('native metadata setup times out and ignores a late response', async () => {
  jest.useFakeTimers();
  const f = fixture();
  const metadata = attachToolMetadata(f);
  let release!: () => void;
  metadata.initializeAndValidate.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = (): void => resolve({});
      }),
  );
  const onToolsReady = jest.fn();
  const outcome = runCopilotTurn(Object.assign(f.options, { onToolsReady }));
  void outcome.catch(() => undefined);
  try {
    await jest.advanceTimersByTimeAsync(30_001);
    await expect(outcome).rejects.toThrow(/metadata verification timed out/);
    release();
    await jest.advanceTimersByTimeAsync(0);
    expect(metadata.getCurrentMetadata).not.toHaveBeenCalled();
    expect(onToolsReady).not.toHaveBeenCalled();
    expect(f.options.onSession).not.toHaveBeenCalled();
    expect(f.session.send).not.toHaveBeenCalled();
    expect(f.runtime.close).toHaveBeenCalledTimes(1);
  } finally {
    release?.();
    await outcome.catch(() => undefined);
    jest.useRealTimers();
  }
});

test('runtime exit stops native metadata setup and suppresses late verification', async () => {
  const f = fixture();
  const metadata = attachToolMetadata(f);
  let release!: () => void;
  metadata.initializeAndValidate.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = (): void => resolve({});
      }),
  );
  const onToolsReady = jest.fn();
  let failure: unknown;
  const outcome = runCopilotTurn(
    Object.assign(f.options, {
      onToolsReady,
      mcpServers: {
        fixture: {
          type: 'http' as const,
          url: 'http://127.0.0.1/mcp',
          tools: ['*'],
        },
      },
    }),
  );
  void outcome.catch((error: unknown) => {
    failure = error;
  });
  await new Promise((resolve) => setImmediate(resolve));
  await f.runtime.close();
  await new Promise((resolve) => setImmediate(resolve));
  try {
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toMatch(/runtime stopped/);
  } finally {
    release();
    await outcome.catch(() => undefined);
  }
  expect(onToolsReady).not.toHaveBeenCalled();
  expect(f.options.onSession).not.toHaveBeenCalled();
  expect(f.session.send).not.toHaveBeenCalled();
});

test('prepares the prompt after the native session id is known and before sending', async () => {
  const f = fixture();
  f.session.send.mockImplementation(() => {
    f.event({ type: 'session.idle', data: {} });
    return Promise.resolve('sent');
  });
  const preparePrompt = jest.fn((id: string) => {
    expect(f.options.onSession).toHaveBeenCalledWith(id);
    expect(f.session.send).not.toHaveBeenCalled();
    return Promise.resolve(`Restored context for ${id}`);
  });
  await runCopilotTurn({ ...f.options, preparePrompt });
  expect(preparePrompt).toHaveBeenCalledWith('native-session');
  expect(f.session.send).toHaveBeenCalledWith({
    prompt: 'Restored context for native-session',
  });
});

test('a failed history preparation never sends a contextless prompt', async () => {
  const f = fixture();
  f.session.send.mockImplementation(() => {
    f.event({ type: 'session.idle', data: {} });
    return Promise.resolve('sent');
  });
  const options = {
    ...f.options,
    preparePrompt: (): Promise<string> => {
      return Promise.reject(new Error('history unavailable'));
    },
  };
  await expect(runCopilotTurn(options)).rejects.toThrow('history unavailable');
  expect(f.session.send).not.toHaveBeenCalled();
  expect(f.runtime.close).toHaveBeenCalledTimes(1);
});

test('cancellation during history preparation stops before sending', async () => {
  const f = fixture();
  const controller = new AbortController();
  const options = {
    ...f.options,
    signal: controller.signal,
    timeoutMs: 20,
    preparePrompt: (): Promise<string> => {
      controller.abort(new Error('cancelled while preparing history'));
      return Promise.resolve('unused history');
    },
  };
  await expect(runCopilotTurn(options)).rejects.toThrow(
    'cancelled while preparing history',
  );
  expect(f.session.send).not.toHaveBeenCalled();
});

test('cancels a pending history read without waiting for it to settle', async () => {
  const f = fixture();
  const controller = new AbortController();
  const pending: Promise<string> = new Promise(() => undefined);
  const options = {
    ...f.options,
    signal: controller.signal,
    preparePrompt: (): Promise<string> => pending,
  };
  const running = runCopilotTurn(options);
  const stopped = expect(running).rejects.toThrow('cancel pending history');
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort(new Error('cancel pending history'));
  await stopped;
  expect(f.session.send).not.toHaveBeenCalled();
  expect(f.runtime.close).toHaveBeenCalledTimes(1);
});

test('bounds history preparation before any native send', async () => {
  const f = fixture();
  const pending: Promise<string> = new Promise(() => undefined);
  const options = {
    ...f.options,
    timeoutMs: 20,
    preparePrompt: (): Promise<string> => pending,
  };
  await expect(runCopilotTurn(options)).rejects.toThrow(
    'Copilot prompt preparation timed out.',
  );
  expect(f.session.send).not.toHaveBeenCalled();
  expect(f.runtime.close).toHaveBeenCalledTimes(1);
});

test('records native prompt acceptance before a later model failure', async () => {
  const f = fixture();
  const onPromptAccepted = jest.fn(() => Promise.resolve());
  f.session.send.mockImplementation(() => {
    setImmediate(() =>
      f.event({
        type: 'session.error',
        data: { errorType: 'provider', message: 'model failed after send' },
      }),
    );
    return Promise.resolve('accepted');
  });
  const options = { ...f.options, onPromptAccepted };
  await expect(runCopilotTurn(options)).rejects.toThrow(
    'model failed after send',
  );
  expect(onPromptAccepted).toHaveBeenCalledWith('native-session');
});

test('a rejected native send does not acknowledge prompt history', async () => {
  const f = fixture();
  const onPromptAccepted = jest.fn(() => Promise.resolve());
  f.session.send.mockRejectedValue(new Error('send rejected'));
  const options = { ...f.options, onPromptAccepted };
  await expect(runCopilotTurn(options)).rejects.toThrow('send rejected');
  expect(onPromptAccepted).not.toHaveBeenCalled();
});

test('bounds a pending host acknowledgement after native prompt acceptance', async () => {
  const f = fixture();
  f.session.send.mockImplementation(() => {
    f.event({ type: 'session.idle', data: {} });
    return Promise.resolve('accepted');
  });
  const options = {
    ...f.options,
    timeoutMs: 20,
    onPromptAccepted: (): Promise<void> => new Promise<void>(() => undefined),
  };
  await expect(runCopilotTurn(options)).rejects.toThrow(/timed out/);
  expect(f.runtime.close).toHaveBeenCalledTimes(1);
});

test('reports selected MCP servers that did not connect and still sends', async () => {
  const f = fixture();
  f.session.rpc = {
    tools: {
      initializeAndValidate: (): ReturnType<
        CopilotToolMetadataRpc['tools']['initializeAndValidate']
      > => Promise.resolve({}),
      getCurrentMetadata: (): ReturnType<
        CopilotToolMetadataRpc['tools']['getCurrentMetadata']
      > => Promise.resolve({ tools: [] }),
    },
    mcp: {
      list: (): ReturnType<CopilotToolMetadataRpc['mcp']['list']> =>
        Promise.resolve({
          servers: [
            { name: 'selected', status: 'connected' },
            { name: 'slack', status: 'needs-auth' },
          ],
        }),
    },
  };
  f.options.mcpServers = {
    selected: {
      type: 'http',
      url: 'http://127.0.0.1:1/selected',
      tools: ['*'],
    },
    slack: { type: 'http', url: 'http://127.0.0.1:1/slack', tools: ['*'] },
  };
  const onToolsReady = jest.fn(() => Promise.resolve());
  f.options.onToolsReady = onToolsReady;
  f.session.send.mockImplementation(() => {
    f.event({ type: 'session.idle', data: {} });
    return Promise.resolve('send-id');
  });
  await expect(runCopilotTurn(f.options)).resolves.toMatchObject({
    sessionId: 'native-session',
  });
  expect(onToolsReady).toHaveBeenCalledWith(
    expect.objectContaining({ version: 1 }),
    [
      { name: 'selected', status: 'connected' },
      { name: 'slack', status: 'needs-auth' },
    ],
  );
  expect(f.session.send).toHaveBeenCalledTimes(1);
});
