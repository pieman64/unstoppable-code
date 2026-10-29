import {
  classifyRetryableCodexTransportFailure,
  isRetryableCodexTransportFailureEvent,
} from '../agent-failures';

function failure(detail: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'result',
    is_error: true,
    subtype: 'codex_error',
    result: 'failed',
    errors: ['failed'],
    ...detail,
  };
}

describe('isRetryableCodexTransportFailureEvent', () => {
  it.each([
    [{ codex_error_code: 'thread_closing' }],
    [{ codex_error_code: 'app_server_shared_restart' }],
    [
      {
        codex_error_code: 'app_server_request_timeout',
        codex_error_method: 'thread/resume',
      },
    ],
    [
      {
        codex_error_code: 'app_server_request_timeout',
        codex_error_method: 'thread/start',
      },
    ],
  ])('accepts %j', (detail) => {
    expect(isRetryableCodexTransportFailureEvent(failure(detail))).toBe(true);
  });

  it('never retries an unanswered turn/start, which may already be running', () => {
    expect(
      isRetryableCodexTransportFailureEvent(
        failure({
          codex_error_code: 'app_server_request_timeout',
          codex_error_method: 'turn/start',
        }),
      ),
    ).toBe(false);
  });

  it.each([
    [
      'a timeout without a method',
      { codex_error_code: 'app_server_request_timeout' },
    ],
    ['an unknown code', { codex_error_code: 'something_else' }],
    ['no code', {}],
  ])('rejects %s', (_label, detail) => {
    expect(isRetryableCodexTransportFailureEvent(failure(detail))).toBe(false);
  });

  it('requires a terminal Codex error result', () => {
    const marked = { codex_error_code: 'thread_closing' };
    expect(
      isRetryableCodexTransportFailureEvent({
        ...failure(marked),
        is_error: false,
      }),
    ).toBe(false);
    expect(
      isRetryableCodexTransportFailureEvent({
        ...failure(marked),
        subtype: 'error_during_execution',
      }),
    ).toBe(false);
    expect(
      isRetryableCodexTransportFailureEvent({ type: 'error', ...marked }),
    ).toBe(false);
    expect(isRetryableCodexTransportFailureEvent('thread_closing')).toBe(false);
    expect(isRetryableCodexTransportFailureEvent(null)).toBe(false);
  });

  it('does not infer a marker from the message text', () => {
    expect(
      isRetryableCodexTransportFailureEvent(
        failure({
          result:
            'Codex app-server did not respond to thread/resume within 120s',
        }),
      ),
    ).toBe(false);
  });
});

describe('classifyRetryableCodexTransportFailure', () => {
  const context = {
    provider: 'codex' as const,
    accountScope: 'native' as const,
    model: 'gpt-6-sol',
  };

  it('classifies a retryable transport failure as a temporary outage', () => {
    expect(
      classifyRetryableCodexTransportFailure(
        { codex_error_code: 'thread_closing' },
        context,
        'thread t-1 is closing',
      ),
    ).toEqual({
      kind: 'provider_temporarily_unavailable',
      code: 'provider_timeout',
      provider: 'codex',
      account_scope: 'native',
      model: 'gpt-6-sol',
      diagnostic_message: 'thread t-1 is closing',
    });
  });

  it('returns null for an unanswered turn/start and for no marker', () => {
    expect(
      classifyRetryableCodexTransportFailure(
        {
          codex_error_code: 'app_server_request_timeout',
          codex_error_method: 'turn/start',
        },
        context,
        'timed out',
      ),
    ).toBeNull();
    expect(
      classifyRetryableCodexTransportFailure(null, context, 'x'),
    ).toBeNull();
  });
});
