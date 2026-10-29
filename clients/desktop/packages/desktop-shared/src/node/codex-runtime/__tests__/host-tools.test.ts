import { CodexHostToolDispatcher } from '../host-tools';
import type { CodexHostToolPolicy } from '../thread-handle';
import type { DynamicToolCallResponse } from '../generated/v2/DynamicToolCallResponse';

const result: DynamicToolCallResponse = {
  success: true,
  contentItems: [{ type: 'inputText', text: 'file contents' }],
};

function fixture(overrides: Partial<CodexHostToolPolicy> = {}): {
  dispatcher: CodexHostToolDispatcher;
  owner: AbortController;
  authorize: jest.Mock<Promise<boolean>>;
  execute: jest.Mock<Promise<DynamicToolCallResponse>>;
} {
  const owner = new AbortController();
  const authorize = jest.fn((): Promise<boolean> => Promise.resolve(true));
  const execute = jest.fn(
    (): Promise<DynamicToolCallResponse> => Promise.resolve(result),
  );
  return {
    owner,
    authorize,
    execute,
    dispatcher: new CodexHostToolDispatcher(
      'thread',
      () => 'turn',
      {
        allowedTools: [{ namespace: null, tool: 'read' }],
        authorize,
        execute,
        ...overrides,
      },
      owner.signal,
    ),
  };
}

function request(args: unknown = {}, callId = 'call'): unknown {
  return {
    params: {
      threadId: 'thread',
      turnId: 'turn',
      callId,
      namespace: null,
      tool: 'read',
      arguments: args,
    },
  };
}

describe('per-turn host tools', () => {
  afterEach(() => jest.useRealTimers());

  it('joins reordered identical input but rejects an identity reused with changed input', async () => {
    const { dispatcher, execute } = fixture();
    expect(await dispatcher.run(request({ a: 1, b: 2 }))).toEqual(result);
    expect(await dispatcher.run(request({ b: 2, a: 1 }))).toEqual(result);
    expect((await dispatcher.run(request({ a: 3 }))).success).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each([
    undefined,
    Number.NaN,
    'x'.repeat(32_769),
    { secret: '😀'.repeat(16_384) },
    Array.from({ length: 4097 }, () => 0),
  ])(
    'rejects invalid or excessive arguments before authorization (%#)',
    async (args) => {
      const { dispatcher, authorize } = fixture();
      const call = {
        params: {
          threadId: 'thread',
          turnId: 'turn',
          callId: 'call',
          namespace: null,
          tool: 'read',
          arguments: args,
        },
      };
      expect((await dispatcher.run(call)).success).toBe(false);
      expect(authorize).not.toHaveBeenCalled();
    },
  );

  it('bounds result text and strips host-private result properties', async () => {
    const oversized = fixture({
      execute: (): Promise<DynamicToolCallResponse> =>
        Promise.resolve({
          success: true,
          contentItems: [{ type: 'inputText', text: 'x'.repeat(65_537) }],
        }),
    });
    expect((await oversized.dispatcher.run(request())).success).toBe(false);
    const extra = {
      success: true,
      privateAccount: 'not public',
      contentItems: [
        { type: 'inputText' as const, text: 'okay', internalPath: '/private' },
      ],
    };
    const clean = fixture({
      execute: (): Promise<DynamicToolCallResponse> => Promise.resolve(extra),
    });
    expect(await clean.dispatcher.run(request())).toEqual({
      success: true,
      contentItems: [{ type: 'inputText', text: 'okay' }],
    });
  });

  it('aborts a stuck authorization at its deadline without executing and caches the denial', async () => {
    jest.useFakeTimers();
    let signal: AbortSignal | undefined;
    let approve: ((value: boolean) => void) | undefined;
    const { dispatcher, execute } = fixture({
      timeoutMs: 10,
      authorize: (_call, current): Promise<boolean> => {
        signal = current;
        return new Promise((resolve) => {
          approve = resolve;
        });
      },
    });
    const pending = dispatcher.run(request());
    await jest.advanceTimersByTimeAsync(10);
    expect((await pending).success).toBe(false);
    expect(signal?.aborted).toBe(true);
    approve?.(true);
    await Promise.resolve();
    expect(execute).not.toHaveBeenCalled();
    expect(await dispatcher.run(request())).toEqual(await pending);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('waits as long as a call takes when no deadline is set', async () => {
    jest.useFakeTimers();
    let finish: ((value: DynamicToolCallResponse) => void) | undefined;
    const { dispatcher } = fixture({
      execute: (): Promise<DynamicToolCallResponse> =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    const pending = dispatcher.run(request());
    await jest.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
    expect(jest.getTimerCount()).toBe(0);
    finish?.(result);
    expect(await pending).toEqual(result);
  });

  it('accepts a deadline longer than a minute', async () => {
    jest.useFakeTimers();
    let signal: AbortSignal | undefined;
    const { dispatcher } = fixture({
      timeoutMs: 10 * 60 * 1000,
      execute: (_call, current): Promise<DynamicToolCallResponse> => {
        signal = current;
        return new Promise(() => undefined);
      },
    });
    const pending = dispatcher.run(request());
    await jest.advanceTimersByTimeAsync(9 * 60 * 1000);
    expect(signal?.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(60 * 1000);
    expect((await pending).success).toBe(false);
    expect(signal?.aborted).toBe(true);
  });

  it('cancels an undeadlined call when its owner ends', async () => {
    let signal: AbortSignal | undefined;
    const { dispatcher, owner } = fixture({
      execute: (_call, current): Promise<DynamicToolCallResponse> => {
        signal = current;
        return new Promise(() => undefined);
      },
    });
    const pending = dispatcher.run(request());
    await Promise.resolve();
    owner.abort();
    expect((await pending).success).toBe(false);
    expect(signal?.aborted).toBe(true);
  });

  it('contains approval and execution errors without disclosing their details', async () => {
    for (const phase of ['authorize', 'execute'] as const) {
      const { dispatcher } = fixture({
        [phase]: (): Promise<never> =>
          Promise.reject(new Error('secret canary')),
      });
      const failure = await dispatcher.run(request());
      expect(failure.success).toBe(false);
      expect(JSON.stringify(failure)).not.toContain('secret canary');
    }
  });

  it('cancelling one owner leaves another owner able to execute', async () => {
    const left = fixture();
    const right = fixture();
    left.owner.abort();
    expect((await left.dispatcher.run(request())).success).toBe(false);
    expect(left.execute).not.toHaveBeenCalled();
    expect(await right.dispatcher.run(request())).toEqual(result);
  });
});
