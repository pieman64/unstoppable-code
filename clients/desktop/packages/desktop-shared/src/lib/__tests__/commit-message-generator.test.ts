import { TransientAgentRetryExhaustedError } from '../../agent-failures/transient-retry';
import { generateCommitMessageWithUsage } from '../commit-message-generator';
import type { CodexStructuredHelperRunner } from '../structured-helper-query';

const ROUTED_GATEWAY_MODEL = 'anthropic/claude-sonnet-5.5';

describe('generateCommitMessageWithUsage', () => {
  it('accumulates mixed-failure usage into a later successful result', async () => {
    const runner = jest
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('Invalid request after retry'), {
          usage: {
            inputTokens: 13,
            outputTokens: 5,
            totalCostUsd: 0.13,
          },
        }),
      )
      .mockResolvedValueOnce({
        value: { message: 'fix: preserve all usage' },
        usage: {
          inputTokens: 8,
          outputTokens: 3,
          totalCostUsd: 0.08,
        },
      });

    const result = await generateCommitMessageWithUsage(
      {
        repoPath: '/repo',
        branchName: 'fix/preserve-all-usage',
        diff: 'diff --git a/file b/file',
        model: 'claude-sonnet-4-6',
        instructions: '',
        instructionMode: 'append',
      },
      runner,
    );

    expect(result).toMatchObject({
      message: 'fix: preserve all usage',
      usage: {
        inputTokens: 21,
        outputTokens: 8,
      },
      source: 'model',
    });
    expect(result.usage.totalCostUsd).toBeCloseTo(0.21);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('preserves exhausted retry usage in the fallback result', async () => {
    const runner = jest.fn(() =>
      Promise.reject(
        new TransientAgentRetryExhaustedError(
          new Error('Claude SDK error: server_error'),
          {
            kind: 'provider_temporarily_unavailable',
            code: 'server_overloaded',
            provider: 'claude',
            account_scope: 'native',
            diagnostic_message: 'Claude SDK error: server_error',
          },
          {
            inputTokens: 21,
            outputTokens: 8,
            totalCostUsd: 0.42,
          },
        ),
      ),
    );

    const result = await generateCommitMessageWithUsage(
      {
        repoPath: '/repo',
        branchName: 'fix/preserve-retry-usage',
        diff: 'diff --git a/file b/file',
        model: 'claude-sonnet-4-6',
        instructions: '',
        instructionMode: 'append',
      },
      runner,
    );

    const { lastError, ...rest } = result;
    expect(rest).toEqual({
      message: 'Preserve retry usage',
      usage: {
        inputTokens: 21,
        outputTokens: 8,
        totalCostUsd: 0.42,
      },
      source: 'fallback',
    });
    expect(lastError).toBeInstanceOf(TransientAgentRetryExhaustedError);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('does not turn cancellation into a fallback commit message', async () => {
    const abortController = new AbortController();
    const cancellation = new Error('cancelled');
    const runner = jest.fn(() => {
      abortController.abort(cancellation);
      return Promise.reject(cancellation);
    });

    await expect(
      generateCommitMessageWithUsage(
        {
          repoPath: '/repo',
          branchName: 'fix/cancel-generation',
          diff: 'diff --git a/file b/file',
          model: 'claude-sonnet-4-6',
          instructions: '',
          instructionMode: 'append',
          abortController,
        },
        runner,
      ),
    ).rejects.toBe(cancellation);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('seeds a routed gateway model under the Claude harness instead of throwing', async () => {
    const seed = jest.fn(() => Promise.resolve());
    const runner = jest.fn(() =>
      Promise.resolve({
        value: { message: 'feat: routed commit' },
        usage: {},
      }),
    );

    const result = await generateCommitMessageWithUsage(
      {
        repoPath: '/repo',
        branchName: 'feat/routed-commit',
        diff: 'diff --git a/file b/file',
        model: ROUTED_GATEWAY_MODEL,
        executionHarness: 'claude',
        localMemoryEnabled: false,
        instructions: '',
        instructionMode: 'append',
        transcriptObserver: { seed, appendEvent: jest.fn() },
      },
      runner,
    );

    expect(seed).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'claude' }),
    );
    expect(runner).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      message: 'feat: routed commit',
      source: 'model',
    });
  });

  it('seeds a routed gateway model under the Codex harness instead of throwing', async () => {
    const seed = jest.fn(() => Promise.resolve());
    const run = jest.fn().mockResolvedValue({
      value: { message: 'feat: routed codex commit' },
      usage: {},
    });
    const codexRunner: CodexStructuredHelperRunner = { run };

    const result = await generateCommitMessageWithUsage({
      repoPath: '/repo',
      branchName: 'feat/routed-codex-commit',
      diff: 'diff --git a/file b/file',
      model: 'openai/gpt-5.5',
      executionHarness: 'codex',
      localMemoryEnabled: false,
      instructions: '',
      instructionMode: 'append',
      transcriptObserver: { seed, appendEvent: jest.fn() },
      codexRunner,
    });

    expect(seed).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'codex' }),
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      message: 'feat: routed codex commit',
      source: 'model',
    });
  });

  it('reports the last attempt error on a fallback result', async () => {
    const failure = new Error('Invalid request');
    const runner = jest.fn(() => Promise.reject(failure));

    const result = await generateCommitMessageWithUsage(
      {
        repoPath: '/repo',
        branchName: 'fix/last-error',
        diff: 'diff --git a/file b/file',
        model: 'claude-sonnet-4-6',
        localMemoryEnabled: false,
        instructions: '',
        instructionMode: 'append',
      },
      runner,
    );

    expect(result.source).toBe('fallback');
    expect(result.lastError).toBe(failure);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('skips the second attempt when the caller declines a retry', async () => {
    const failure = new Error('usage limit');
    const runner = jest.fn(() => Promise.reject(failure));
    const shouldRetryAfterError = jest.fn(() => false);

    const result = await generateCommitMessageWithUsage(
      {
        repoPath: '/repo',
        branchName: 'fix/no-retry',
        diff: 'diff --git a/file b/file',
        model: 'claude-sonnet-4-6',
        localMemoryEnabled: false,
        instructions: '',
        instructionMode: 'append',
        shouldRetryAfterError,
      },
      runner,
    );

    expect(result.source).toBe('fallback');
    expect(result.lastError).toBe(failure);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(shouldRetryAfterError).toHaveBeenCalledWith(failure);
  });

  it('leaves lastError undefined when the model returns nothing usable', async () => {
    const runner = jest.fn(() => Promise.resolve({ value: null, usage: {} }));

    const result = await generateCommitMessageWithUsage(
      {
        repoPath: '/repo',
        branchName: 'fix/no-message',
        diff: 'diff --git a/file b/file',
        model: 'claude-sonnet-4-6',
        localMemoryEnabled: false,
        instructions: '',
        instructionMode: 'append',
      },
      runner,
    );

    expect(result.source).toBe('fallback');
    expect(result.lastError).toBeUndefined();
  });

  it('keeps an earlier attempt error when the last attempt returns nothing usable', async () => {
    const runner = jest
      .fn()
      .mockRejectedValueOnce(new Error('first attempt failed'))
      .mockResolvedValueOnce({ value: null, usage: {} });

    const result = await generateCommitMessageWithUsage(
      {
        repoPath: '/repo',
        branchName: 'fix/no-message',
        diff: 'diff --git a/file b/file',
        model: 'claude-sonnet-4-6',
        localMemoryEnabled: false,
        instructions: '',
        instructionMode: 'append',
      },
      runner,
    );

    expect(result.source).toBe('fallback');
    expect(runner).toHaveBeenCalledTimes(2);
    expect(result.lastError).toEqual(new Error('first attempt failed'));
  });
});
