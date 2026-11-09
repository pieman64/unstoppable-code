import {
  CHAT_WAIT_KINDS,
  CHAT_WAIT_NO_CLIENT_MODE,
  ChatWaitLifecycle,
  type ChatWaitClientPresence,
  type ChatWaitNoClientMode,
  type ChatWaitObserver,
  type ChatWaitScope,
} from '..';

const SCOPE: ChatWaitScope = {
  workspaceId: 'workspace-1',
  worktreeId: 'worktree-1',
  chatId: 'chat-1',
};

interface PresenceDouble extends ChatWaitClientPresence {
  isAttached: boolean;
  calls: number;
}

function presenceDouble(isAttached: boolean): PresenceDouble {
  const presence: PresenceDouble = {
    isAttached,
    calls: 0,
    attached: (): boolean => {
      presence.calls += 1;
      return presence.isAttached;
    },
  };
  return presence;
}

function recordingObserver(log: string[]): ChatWaitObserver {
  return {
    opened: (wait): void => {
      log.push(`opened:${wait.waitId}:${wait.kind}:${wait.clientAttached}`);
    },
    settled: (wait): void => {
      log.push(`settled:${wait.status}`);
    },
  };
}

function lifecycleWith(options: {
  attached: boolean;
  noClientMode?: ChatWaitNoClientMode;
}): { lifecycle: ChatWaitLifecycle; presence: PresenceDouble; log: string[] } {
  const presence = presenceDouble(options.attached);
  const lifecycle = new ChatWaitLifecycle({
    presence,
    noClientMode: options.noClientMode ?? 'wait',
  });
  const log: string[] = [];
  lifecycle.observe(recordingObserver(log));
  return { lifecycle, presence, log };
}

describe('ChatWaitLifecycle', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('the first settlement wins and later ones change nothing', async () => {
    const { lifecycle, log } = lifecycleWith({ attached: true });
    const wait = lifecycle.open<string>({
      waitId: 'w1',
      kind: 'question',
      scope: SCOPE,
      sessionKey: 'A',
    });

    expect(lifecycle.answer('w1', 'first')).toBe(true);
    expect(lifecycle.answer('w1', 'second')).toBe(false);
    expect(lifecycle.cancel('w1', { reason: 'cancelled' })).toBe(false);
    expect(lifecycle.fail('w1', 'broken')).toBe(false);
    await expect(wait.settled).resolves.toEqual({
      status: 'answered',
      value: 'first',
    });
    expect(log).toEqual(['opened:w1:question:true', 'settled:answered']);
  });

  it('the provider timeout expires the wait after onExpired', async () => {
    const { lifecycle, log } = lifecycleWith({ attached: true });
    const wait = lifecycle.open({
      waitId: 'w1',
      kind: 'question',
      sessionKey: 'A',
      timeoutMs: 1000,
      onExpired: () => log.push('onExpired'),
    });
    log.length = 0;

    jest.advanceTimersByTime(999);
    expect(lifecycle.isOpen('w1')).toBe(true);
    jest.advanceTimersByTime(1);
    expect(log).toEqual(['onExpired', 'settled:expired']);
    await expect(wait.settled).resolves.toEqual({ status: 'expired' });

    lifecycle.open({
      waitId: 'zero',
      kind: 'question',
      sessionKey: 'A',
      timeoutMs: 0,
    });
    lifecycle.open({ waitId: 'none', kind: 'question', sessionKey: 'A' });
    jest.advanceTimersByTime(60 * 60 * 1000);
    expect(lifecycle.isOpen('zero')).toBe(true);
    expect(lifecycle.isOpen('none')).toBe(true);
  });

  it('an abort cancels and refuses late answers', async () => {
    const { lifecycle } = lifecycleWith({ attached: true });
    const controller = new AbortController();
    const wait = lifecycle.open({
      waitId: 'w1',
      kind: 'approval',
      sessionKey: 'A',
      signal: controller.signal,
      abortReason: 'ask_user_cancelled',
    });

    controller.abort();
    await expect(wait.settled).resolves.toEqual({
      status: 'cancelled',
      reason: 'ask_user_cancelled',
    });
    expect(lifecycle.answer('w1', 'late')).toBe(false);
    expect(lifecycle.refusesLateAnswers('w1')).toBe(true);
    lifecycle.forgetLateAnswerRefusal('w1');
    expect(lifecycle.refusesLateAnswers('w1')).toBe(false);

    const aborted = new AbortController();
    aborted.abort();
    const early = lifecycle.open({
      waitId: 'w2',
      kind: 'question',
      sessionKey: 'A',
      signal: aborted.signal,
    });
    expect(lifecycle.isOpen('w2')).toBe(false);
    expect(lifecycle.refusesLateAnswers('w2')).toBe(true);
    await expect(early.settled).resolves.toEqual({
      status: 'cancelled',
      reason: 'cancelled',
    });
  });

  it("cancelSession settles only that session's waits of that kind", () => {
    const { lifecycle } = lifecycleWith({ attached: true });
    lifecycle.open({ waitId: 'a1', kind: 'question', sessionKey: 'A' });
    lifecycle.open({ waitId: 'a2', kind: 'question', sessionKey: 'A' });
    lifecycle.open({ waitId: 'a3', kind: 'approval', sessionKey: 'A' });
    lifecycle.open({ waitId: 'b1', kind: 'question', sessionKey: 'B' });

    expect(
      lifecycle.cancelSession('A', 'question', { reason: 'session_destroyed' }),
    ).toBe(2);
    expect(lifecycle.isOpen('a1')).toBe(false);
    expect(lifecycle.isOpen('a2')).toBe(false);
    expect(lifecycle.isOpen('a3')).toBe(true);
    expect(lifecycle.isOpen('b1')).toBe(true);
  });

  it('questions and approvals behave identically in wait mode', async () => {
    const { lifecycle, log } = lifecycleWith({ attached: false });
    const question = lifecycle.open<string>({
      waitId: 'q',
      kind: 'question',
      scope: SCOPE,
      sessionKey: 'A',
    });
    const approval = lifecycle.open<string>({
      waitId: 'a',
      kind: 'approval',
      scope: SCOPE,
      sessionKey: 'A',
    });

    expect(log).toEqual(['opened:q:question:false', 'opened:a:approval:false']);
    expect(lifecycle.answer('q', 'yes')).toBe(true);
    expect(lifecycle.answer('a', 'yes')).toBe(true);
    await expect(question.settled).resolves.toEqual({
      status: 'answered',
      value: 'yes',
    });
    await expect(approval.settled).resolves.toEqual({
      status: 'answered',
      value: 'yes',
    });
  });

  it('fail mode fails both kinds immediately with no client', async () => {
    const { lifecycle, presence } = lifecycleWith({
      attached: false,
      noClientMode: 'fail',
    });
    for (const kind of CHAT_WAIT_KINDS) {
      const wait = lifecycle.open({ waitId: kind, kind, sessionKey: 'A' });
      await expect(wait.settled).resolves.toEqual({
        status: 'failed',
        reason: 'no_client',
      });
      expect(lifecycle.isOpen(kind)).toBe(false);
    }

    presence.isAttached = true;
    for (const kind of CHAT_WAIT_KINDS) {
      lifecycle.open({ waitId: `${kind}-attached`, kind, sessionKey: 'A' });
      expect(lifecycle.isOpen(`${kind}-attached`)).toBe(true);
    }
  });

  it('no settlement but answered carries a value', async () => {
    const { lifecycle } = lifecycleWith({ attached: true });
    const cancelled = lifecycle.open({
      waitId: 'c',
      kind: 'question',
      sessionKey: 'A',
    });
    const expired = lifecycle.open({
      waitId: 'e',
      kind: 'question',
      sessionKey: 'A',
      timeoutMs: 10,
    });
    const failed = lifecycle.open({
      waitId: 'f',
      kind: 'approval',
      sessionKey: 'A',
    });
    lifecycle.cancel('c', { reason: 'cancelled' });
    jest.advanceTimersByTime(10);
    lifecycle.fail('f', 'ask_user_persistence_failed');

    for (const wait of [cancelled, expired, failed]) {
      const settlement = await wait.settled;
      expect('value' in settlement).toBe(false);
    }
  });

  it('plan review is not a wait kind', () => {
    const { lifecycle } = lifecycleWith({ attached: true });
    expect(CHAT_WAIT_KINDS).toEqual(['question', 'approval']);
    expect(() =>
      lifecycle.open({
        waitId: 'p',
        kind: 'plan_review' as never,
        sessionKey: 'A',
      }),
    ).toThrow(TypeError);
    expect(lifecycle.isOpen('p')).toBe(false);
  });

  it('a disconnect never settles a wait', () => {
    const { lifecycle, presence } = lifecycleWith({
      attached: true,
      noClientMode: 'fail',
    });
    lifecycle.open({ waitId: 'w1', kind: 'question', sessionKey: 'A' });
    presence.isAttached = false;
    jest.advanceTimersByTime(60 * 60 * 1000);

    expect(lifecycle.isOpen('w1')).toBe(true);
    expect(presence.calls).toBe(1);
  });

  it('the shipped mode is fail', () => {
    expect(CHAT_WAIT_NO_CLIENT_MODE).toBe('fail');
  });
});
