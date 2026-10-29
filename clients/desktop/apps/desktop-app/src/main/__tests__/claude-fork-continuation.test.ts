import { claudeContinuationSession } from '../lib/claude-fork-continuation';

describe('claudeContinuationSession', () => {
  const fork = {
    sdkSessionId: 'source-session',
    claudeForkSession: true,
    claudeForkResumeAt: 'source-anchor-uuid',
    claudeForkToolResults: [{ toolUseId: 'toolu_open', content: 'missing' }],
  };

  it('keeps the ordinary session precedence when the dispatch did not fork', () => {
    expect(
      claudeContinuationSession(
        { sdkSessionId: 'dispatched' },
        { requestedSessionId: 'requested', providerSessionId: 'provider' },
      ),
    ).toEqual({ sdkSessionId: 'requested' });
    expect(
      claudeContinuationSession(
        { sdkSessionId: 'dispatched' },
        { providerSessionId: 'provider' },
      ),
    ).toEqual({ sdkSessionId: 'provider' });
    expect(
      claudeContinuationSession({ sdkSessionId: 'dispatched' }, {}),
    ).toEqual({ sdkSessionId: 'dispatched' });
  });

  it('resumes the started fork child without the one-shot fork options', () => {
    const resumed = claudeContinuationSession(fork, {
      requestedSessionId: 'fork-child',
      providerSessionId: 'fork-child',
    });

    expect(resumed).toEqual({ sdkSessionId: 'fork-child' });
    // The explicit keys override the original dispatch options when spread.
    expect({ ...fork, ...resumed }).toEqual({ sdkSessionId: 'fork-child' });
  });

  it('prefers the provider-owned child over a stale requested source id', () => {
    expect(
      claudeContinuationSession(fork, {
        requestedSessionId: 'source-session',
        providerSessionId: 'fork-child',
      }).sdkSessionId,
    ).toBe('fork-child');
  });

  it('falls back to a requested child when the provider id is unavailable', () => {
    expect(
      claudeContinuationSession(fork, { requestedSessionId: 'fork-child' })
        .sdkSessionId,
    ).toBe('fork-child');
  });

  it('repeats the source fork while the child has not started', () => {
    const resumed = claudeContinuationSession(fork, {
      requestedSessionId: 'source-session',
      providerSessionId: 'source-session',
    });

    expect({ ...fork, ...resumed }).toEqual(fork);
  });
});
