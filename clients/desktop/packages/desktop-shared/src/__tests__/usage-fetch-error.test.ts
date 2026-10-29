import {
  classifyUsageFetchErrorMessage,
  classifyUsageFetchHttpStatus,
  usageFetchErrorHeadline,
} from '../lib/usage-fetch-error';

describe('classifyUsageFetchErrorMessage', () => {
  it('classifies revoked/unauthorized credentials as auth', () => {
    expect(
      classifyUsageFetchErrorMessage(
        'GET https://chatgpt.com/backend-api/n/usage failed: 401 Unauthorized; body={"error":{"code":"token_revoked"}}',
      ),
    ).toBe('auth');
    expect(classifyUsageFetchErrorMessage('HTTP 403 Forbidden')).toBe('auth');
    expect(
      classifyUsageFetchErrorMessage(
        'Encountered invalidated oauth token for user, failing request',
      ),
    ).toBe('auth');
  });

  it('classifies transport failures as network, even with no status', () => {
    expect(classifyUsageFetchErrorMessage('fetch failed')).toBe('network');
    expect(
      classifyUsageFetchErrorMessage('getaddrinfo ENOTFOUND chatgpt.com'),
    ).toBe('network');
    expect(classifyUsageFetchErrorMessage('socket hang up')).toBe('network');
    expect(classifyUsageFetchErrorMessage('request timed out after 30s')).toBe(
      'network',
    );
  });

  it('classifies the real-world Codex wham/usage 404 as unsupported', () => {
    expect(
      classifyUsageFetchErrorMessage(
        'failed to fetch codex rate limits: GET https://chatgpt.com/backend-api/wham/usage failed: 404 Not Found; content-type=; body=',
      ),
    ).toBe('unsupported');
  });

  it('classifies server errors and invalid payloads as service', () => {
    expect(
      classifyUsageFetchErrorMessage('GET https://x failed: 500 Internal'),
    ).toBe('service');
    expect(classifyUsageFetchErrorMessage('503 Service Unavailable')).toBe(
      'service',
    );
    expect(
      classifyUsageFetchErrorMessage(
        'Codex app-server returned an invalid rate limits payload',
      ),
    ).toBe('service');
    expect(classifyUsageFetchErrorMessage('API overloaded, retry later')).toBe(
      'service',
    );
  });

  it('classifies explicit throttling as rate_limited', () => {
    expect(
      classifyUsageFetchErrorMessage(
        'GET https://x/usage failed: 429 Too Many Requests',
      ),
    ).toBe('rate_limited');
    expect(classifyUsageFetchErrorMessage('Too many requests')).toBe(
      'rate_limited',
    );
    expect(classifyUsageFetchErrorMessage('rate_limit_error: slow down')).toBe(
      'rate_limited',
    );
    expect(classifyUsageFetchErrorMessage('Rate limit exceeded')).toBe(
      'rate_limited',
    );
    expect(classifyUsageFetchErrorMessage('request was rate-limited')).toBe(
      'rate_limited',
    );
  });

  it('does not treat the rate limits resource name as throttling', () => {
    expect(
      classifyUsageFetchErrorMessage(
        'failed to fetch codex rate limits: 503 Service Unavailable',
      ),
    ).toBe('service');
    expect(
      classifyUsageFetchErrorMessage(
        'failed to fetch codex rate limits: GET https://x failed: 404 Not Found',
      ),
    ).toBe('unsupported');
  });

  it('prefers auth markers over co-occurring status buckets', () => {
    expect(
      classifyUsageFetchErrorMessage(
        '401 Unauthorized while proxying: 502 Bad Gateway',
      ),
    ).toBe('auth');
  });

  it('falls back to unknown for unrecognized messages', () => {
    expect(classifyUsageFetchErrorMessage('something odd happened')).toBe(
      'unknown',
    );
    expect(classifyUsageFetchErrorMessage('')).toBe('unknown');
  });
});

describe('classifyUsageFetchHttpStatus', () => {
  it('maps 401/403 to auth', () => {
    expect(classifyUsageFetchHttpStatus(401)).toBe('auth');
    expect(classifyUsageFetchHttpStatus(403)).toBe('auth');
  });

  it('maps 404 to unsupported', () => {
    expect(classifyUsageFetchHttpStatus(404)).toBe('unsupported');
  });

  it('maps 429 to rate_limited', () => {
    expect(classifyUsageFetchHttpStatus(429)).toBe('rate_limited');
  });

  it('maps everything else to service', () => {
    expect(classifyUsageFetchHttpStatus(500)).toBe('service');
    expect(classifyUsageFetchHttpStatus(418)).toBe('service');
  });
});

describe('usageFetchErrorHeadline', () => {
  it('describes throttling without claiming numbers are shown', () => {
    const headline = usageFetchErrorHeadline('rate_limited', 'Claude');
    expect(headline).toBe(
      'Claude is limiting usage checks right now. Try again later.',
    );
    expect(headline).not.toMatch(/last numbers/i);
  });
});
