import {
  buildUsageLimitedEntry,
  buildAccountProxyUsageLimitedEntry,
  classifyAccountChangeResume,
  classifyAccountChangeResumeReason,
} from '../lib/usage-limited-chats-recording';

describe('buildUsageLimitedEntry', () => {
  it.each([
    {
      provider: 'claude' as const,
      event: { type: 'assistant', error: 'rate_limit' },
    },
    {
      provider: 'codex' as const,
      event: { type: 'rate_limit.reached', resets_at: 2000000000 },
    },
  ])(
    'records $provider proxy quota failures independently of native quota',
    ({ provider, event }) => {
      const input = {
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'c',
        provider,
        detectedAt: 5,
        interruptedUserMessageId: 'original',
        accountProxyConnectionId: 'proxy-a',
      };
      expect(buildAccountProxyUsageLimitedEntry(input, event)).toMatchObject({
        accountProxyConnectionId: 'proxy-a',
        resumeReason: 'usage_limit',
        interruptedUserMessageId: 'original',
        provider,
      });
      expect(
        buildAccountProxyUsageLimitedEntry(
          { ...input, accountProxyConnectionId: undefined },
          event,
        ),
      ).toBeNull();
      expect(
        buildAccountProxyUsageLimitedEntry(input, {
          type: 'assistant',
          error: 'authentication_failed',
        }),
      ).toBeNull();
    },
  );

  it('preserves the proxy connection so recovery cannot use a native account', () => {
    const input = {
      projectId: 'ws',
      worktreeId: 'wt',
      chatId: 'c',
      provider: 'codex' as const,
      detectedAt: 5,
      accountProxyConnectionId: 'proxy-a',
    };
    expect(buildUsageLimitedEntry(input)).toMatchObject({
      accountProxyConnectionId: 'proxy-a',
    });
  });

  it('omits resetsAt when undefined and defaults empty snapshots', () => {
    const e = buildUsageLimitedEntry({
      projectId: 'ws',
      worktreeId: 'wt',
      chatId: 'c',
      provider: 'claude',
      detectedAt: 5,
    });
    expect(e).toEqual({
      projectId: 'ws',
      worktreeId: 'wt',
      chatId: 'c',
      provider: 'claude',
      detectedAt: 5,
      workspaceName: '',
      chatTitle: '',
    });
    expect('resetsAt' in e).toBe(false);
  });

  it('classifies auth failures for account-change resume without calling them usage limits', () => {
    expect(
      classifyAccountChangeResumeReason(
        'claude',
        {
          type: 'result',
          is_error: true,
          api_error_status: 429,
          result:
            'Failed to authenticate: OAuth session expired and could not be refreshed',
        },
        'native',
      ),
    ).toBe('authentication');
  });

  it.each(['ai_credits', 'local'] as const)(
    'ignores account-change failures from %s scope',
    (accountScope) => {
      const events = [
        {
          type: 'result',
          is_error: true,
          result:
            'Failed to authenticate: OAuth session expired and could not be refreshed',
        },
        {
          type: 'result',
          is_error: true,
          api_error_status: 429,
          result: 'Rate limited',
        },
      ];

      for (const event of events) {
        expect(
          classifyAccountChangeResumeReason('claude', event, accountScope),
        ).toBeNull();
      }
    },
  );

  it('includes resetsAt and snapshots when provided', () => {
    const e = buildUsageLimitedEntry({
      projectId: 'ws',
      worktreeId: 'wt',
      chatId: 'c',
      provider: 'codex',
      detectedAt: 5,
      resetsAt: 9000,
      workspaceName: 'W',
      chatTitle: 'T',
    });
    expect(e.resetsAt).toBe(9000);
    expect(e.workspaceName).toBe('W');
  });

  it('includes workspaceType when provided and omits it otherwise', () => {
    const withType = buildUsageLimitedEntry({
      projectId: 'ws',
      worktreeId: 'wt',
      chatId: 'c',
      provider: 'claude',
      detectedAt: 5,
      workspaceType: 'cowork',
    });
    expect(withType.workspaceType).toBe('cowork');

    const withoutType = buildUsageLimitedEntry({
      projectId: 'ws',
      worktreeId: 'wt',
      chatId: 'c',
      provider: 'claude',
      detectedAt: 5,
    });
    expect('workspaceType' in withoutType).toBe(false);
  });
});

describe('classifyAccountChangeResume (CAN-4200)', () => {
  it('returns the usage-limit reset time in ms', () => {
    expect(
      classifyAccountChangeResume(
        'claude',
        {
          type: 'result',
          is_error: true,
          api_error_status: 429,
          result: 'rate limited',
          resets_at: 1_800_000_000,
        },
        'native',
      ),
    ).toEqual({ reason: 'usage_limit', resetsAt: 1_800_000_000_000 });
  });

  it('omits the reset time when the classifier has none', () => {
    const resume = classifyAccountChangeResume(
      'claude',
      { type: 'assistant', error: 'rate_limit' },
      'native',
    );
    expect(resume).toEqual({ reason: 'usage_limit' });
    expect(
      classifyAccountChangeResumeReason(
        'claude',
        { type: 'assistant', error: 'rate_limit' },
        'native',
      ),
    ).toBe('usage_limit');
  });

  it('returns null outside the native scope', () => {
    expect(
      classifyAccountChangeResume(
        'claude',
        { type: 'assistant', error: 'rate_limit' },
        'ai_credits',
      ),
    ).toBeNull();
  });
});
