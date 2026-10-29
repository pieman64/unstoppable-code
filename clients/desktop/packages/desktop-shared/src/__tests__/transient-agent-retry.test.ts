import {
  isTransientAgentRetryExhaustedError,
  runWithTransientAgentRetry,
} from '../agent-failures/transient-retry';
import { readClaudeRetrySessionId } from '../agent-failures/resume';
import { getStructuredHelperQueryErrorUsage } from '../lib/structured-helper-query';

function hasRef(value: unknown): value is { hasRef: () => boolean } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'hasRef') === 'function'
  );
}

describe('runWithTransientAgentRetry', () => {
  it('retains billed usage when the proxy capacity wait is cancelled', async () => {
    const cancelled = new Error('Capacity wait cancelled');
    const promise = runWithTransientAgentRetry({
      provider: 'claude',
      delaysMs: [],
      waitForQuotaRecovery: () => Promise.reject(cancelled),
      runAttempt: (captureEvent) => {
        captureEvent({ type: 'assistant', error: 'rate_limit' });
        return Promise.reject(
          Object.assign(new Error('Quota reached'), {
            usage: { inputTokens: 12, outputTokens: 4, totalCostUsd: 0.12 },
          }),
        );
      },
    });
    await expect(promise).rejects.toBe(cancelled);
    expect(getStructuredHelperQueryErrorUsage(cancelled)).toEqual({
      inputTokens: 12,
      outputTokens: 4,
      totalCostUsd: 0.12,
    });
  });

  it('waits for proxy quota without consuming the transient retry budget', async () => {
    let attempts = 0;
    const waitForQuotaRecovery = jest.fn(() => Promise.resolve());
    const options = {
      provider: 'claude' as const,
      delaysMs: [],
      waitForQuotaRecovery,
      runAttempt: (captureEvent: (event: unknown) => void): Promise<string> => {
        attempts += 1;
        if (attempts < 4) {
          captureEvent({ type: 'assistant', error: 'rate_limit' });
          return Promise.reject(new Error('Quota reached'));
        }
        return Promise.resolve('continued session');
      },
    };
    await expect(runWithTransientAgentRetry(options)).resolves.toBe(
      'continued session',
    );
    expect(waitForQuotaRecovery).toHaveBeenCalledTimes(3);
  });

  it('retries classified transient failures and returns a later success', async () => {
    const notices: Array<{ attempt: number; nextAttempt: number }> = [];
    let attempts = 0;

    const result = await runWithTransientAgentRetry({
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      delaysMs: [0, 0],
      runAttempt: (captureEvent) => {
        attempts += 1;
        if (attempts < 3) {
          captureEvent({
            type: 'assistant',
            error: 'server_error',
          });
          throw new Error('Claude SDK error: server_error');
        }
        return Promise.resolve('recovered');
      },
      onRetry: ({ attempt, nextAttempt }) => {
        notices.push({ attempt, nextAttempt });
      },
    });

    expect(result).toBe('recovered');
    expect(attempts).toBe(3);
    expect(notices).toEqual([
      { attempt: 1, nextAttempt: 2 },
      { attempt: 2, nextAttempt: 3 },
    ]);
  });

  it('accumulates usage from failed attempts into a later success', async () => {
    let attempts = 0;

    const result = await runWithTransientAgentRetry({
      provider: 'claude',
      delaysMs: [0],
      runAttempt: (captureEvent) => {
        attempts += 1;
        if (attempts === 1) {
          captureEvent({ type: 'assistant', error: 'server_error' });
          return Promise.reject(
            Object.assign(new Error('Claude SDK error: server_error'), {
              usage: {
                inputTokens: 12,
                outputTokens: 4,
                totalCostUsd: 0.12,
                messageCount: 1,
                assistantMessageCount: 1,
              },
            }),
          );
        }
        return Promise.resolve({
          value: 'recovered',
          usage: {
            inputTokens: 10,
            outputTokens: 3,
            totalCostUsd: 0.1,
            messageCount: 1,
            assistantMessageCount: 1,
          },
        });
      },
    });

    expect(result).toEqual({
      value: 'recovered',
      usage: {
        inputTokens: 22,
        outputTokens: 7,
        totalCostUsd: 0.22,
        messageCount: 2,
        assistantMessageCount: 2,
      },
    });
  });

  it('only treats a real Claude session id as resumable', () => {
    expect(
      readClaudeRetrySessionId({
        type: 'assistant',
        session_id: 'session-from-provider',
        error: 'server_error',
      }),
    ).toBe('session-from-provider');
    expect(readClaudeRetrySessionId({ type: 'error' })).toBeUndefined();
  });

  it('does not retry unclassified failures', async () => {
    const runAttempt = jest.fn(() =>
      Promise.reject(new Error('Invalid request')),
    );

    await expect(
      runWithTransientAgentRetry({
        provider: 'claude',
        delaysMs: [0],
        runAttempt,
      }),
    ).rejects.toThrow('Invalid request');
    expect(runAttempt).toHaveBeenCalledTimes(1);
  });

  it('preserves earlier transient usage on a later non-transient failure', async () => {
    let attempts = 0;
    const promise = runWithTransientAgentRetry({
      provider: 'claude',
      delaysMs: [0],
      runAttempt: (captureEvent) => {
        attempts += 1;
        if (attempts === 1) {
          captureEvent({ type: 'assistant', error: 'server_error' });
          return Promise.reject(
            Object.assign(new Error('Claude SDK error: server_error'), {
              usage: { inputTokens: 7, outputTokens: 3 },
            }),
          );
        }
        return Promise.reject(new Error('Invalid request'));
      },
    });

    const error = await promise.catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      message: 'Invalid request',
      usage: { inputTokens: 7, outputTokens: 3 },
    });
    expect(attempts).toBe(2);
  });

  it('reads cumulative usage attached to a plain retry error', () => {
    const error = Object.assign(new Error('Invalid request'), {
      usage: {
        inputTokens: 7,
        outputTokens: 3,
        totalCostUsd: 0.07,
      },
    });

    expect(getStructuredHelperQueryErrorUsage(error)).toEqual({
      inputTokens: 7,
      outputTokens: 3,
      totalCostUsd: 0.07,
    });
  });

  it('uses the shared classifier for Codex transient failures', async () => {
    const runAttempt = jest
      .fn<Promise<string>, [(event: unknown) => void]>()
      .mockImplementationOnce((captureEvent) => {
        captureEvent({
          type: 'turn.failed',
          error: { codexErrorInfo: 'serverOverloaded' },
        });
        return Promise.reject(new Error('Codex helper failed'));
      })
      .mockResolvedValueOnce('recovered');

    await expect(
      runWithTransientAgentRetry({
        provider: 'codex',
        delaysMs: [0],
        runAttempt,
      }),
    ).resolves.toBe('recovered');
    expect(runAttempt).toHaveBeenCalledTimes(2);
  });

  it('cancels a scheduled retry when its abort signal fires', async () => {
    const abortController = new AbortController();
    let retryScheduled: (() => void) | undefined;
    const scheduled = new Promise<void>((resolve) => {
      retryScheduled = resolve;
    });
    const runAttempt = jest.fn((captureEvent: (event: unknown) => void) => {
      captureEvent({ type: 'assistant', error: 'server_error' });
      return Promise.reject(new Error('Claude SDK error: server_error'));
    });

    const result = runWithTransientAgentRetry({
      provider: 'claude',
      signal: abortController.signal,
      delaysMs: [30_000],
      runAttempt,
      onRetry: () => retryScheduled?.(),
    });
    await scheduled;
    abortController.abort(new Error('Stop helper retry'));

    await expect(result).rejects.toThrow('Stop helper retry');
    expect(runAttempt).toHaveBeenCalledTimes(1);
  });

  it('keeps the process alive while a retry is scheduled', async () => {
    const abortController = new AbortController();
    const timerSpy = jest.spyOn(global, 'setTimeout');
    let retryScheduled: (() => void) | undefined;
    const scheduled = new Promise<void>((resolve) => {
      retryScheduled = resolve;
    });
    const runAttempt = jest
      .fn<Promise<void>, [(event: unknown) => void]>()
      .mockImplementation((captureEvent) => {
        captureEvent({ type: 'assistant', error: 'server_error' });
        return Promise.reject(new Error('Claude SDK error: server_error'));
      });

    const result = runWithTransientAgentRetry({
      provider: 'claude',
      signal: abortController.signal,
      delaysMs: [30_000],
      runAttempt,
      onRetry: () => {
        const unrelatedTimer = setTimeout(() => undefined, 0);
        unrelatedTimer.unref();
        retryScheduled?.();
      },
    });
    const rejected = expect(result).rejects.toThrow('Stop helper retry');
    try {
      await scheduled;
      await new Promise<void>((resolve) => setImmediate(resolve));

      const retryTimerIndex = timerSpy.mock.calls.findIndex(
        ([, delay]) => delay === 30_000,
      );
      expect(retryTimerIndex).toBeGreaterThanOrEqual(0);
      const retryTimer: unknown = timerSpy.mock.results[retryTimerIndex]?.value;
      if (!hasRef(retryTimer)) {
        throw new Error('Expected the retry timer to expose hasRef().');
      }
      expect(retryTimer.hasRef()).toBe(true);
      abortController.abort(new Error('Stop helper retry'));
    } finally {
      abortController.abort(new Error('Stop helper retry'));
      await rejected;
      timerSpy.mockRestore();
    }
  });

  it('marks a transient failure after the chat retry schedule is exhausted', async () => {
    let attempts = 0;
    const runAttempt = jest.fn((captureEvent: (event: unknown) => void) => {
      attempts += 1;
      captureEvent({ type: 'assistant', error: 'server_error' });
      return Promise.reject(
        Object.assign(new Error('Claude SDK error: server_error'), {
          usage: {
            inputTokens: attempts,
            outputTokens: 1,
          },
        }),
      );
    });

    const promise = runWithTransientAgentRetry({
      provider: 'claude',
      delaysMs: [0, 0],
      runAttempt,
    });

    const error = await promise.catch((caught: unknown) => caught);
    expect(isTransientAgentRetryExhaustedError(error)).toBe(true);
    if (!isTransientAgentRetryExhaustedError(error)) {
      throw new Error('Expected transient retry exhaustion');
    }
    expect(error.usage).toEqual({
      inputTokens: 6,
      outputTokens: 3,
    });
    expect(runAttempt).toHaveBeenCalledTimes(3);
  });
});
