import { StoppedTurnResumeService } from '../stopped-turn-resume-service';

const TARGET = {
  projectId: 'project',
  worktreeId: 'worktree',
  chatId: 'chat',
};

describe('StoppedTurnResumeService', () => {
  it('allows only one in-flight resume dispatch', async () => {
    const service = new StoppedTurnResumeService();
    service.offer(TARGET, 'user-message');
    let releaseDispatch: (() => void) | undefined;
    const dispatch = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseDispatch = resolve;
        }),
    );

    const first = service.resume(
      { ...TARGET, userMessageId: 'user-message' },
      dispatch,
    );
    const second = await service.resume(
      { ...TARGET, userMessageId: 'user-message' },
      dispatch,
    );

    expect(second).toEqual({ disposition: 'in_progress' });
    expect(dispatch).toHaveBeenCalledTimes(1);

    releaseDispatch?.();
    await expect(first).resolves.toEqual({ disposition: 'dispatched' });
    await expect(
      service.resume({ ...TARGET, userMessageId: 'user-message' }, dispatch),
    ).resolves.toEqual({ disposition: 'already_dispatched' });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('restores a failed offer so the user can retry', async () => {
    const service = new StoppedTurnResumeService();
    service.offer(TARGET, 'user-message');
    const dispatch = jest
      .fn<Promise<void>, [string]>()
      .mockRejectedValueOnce(new Error('Provider session expired'))
      .mockResolvedValueOnce(undefined);

    await expect(
      service.resume({ ...TARGET, userMessageId: 'user-message' }, dispatch),
    ).resolves.toEqual({
      disposition: 'failed',
      error: 'Could not resume the stopped turn. Try again.',
      retryable: true,
    });
    await expect(
      service.resume({ ...TARGET, userMessageId: 'user-message' }, dispatch),
    ).resolves.toEqual({ disposition: 'dispatched' });
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('rejects an offer after a new turn invalidates it', async () => {
    const service = new StoppedTurnResumeService();
    service.offer(TARGET, 'user-message');
    service.invalidate(TARGET);
    const dispatch = jest.fn().mockResolvedValue(undefined);

    await expect(
      service.resume({ ...TARGET, userMessageId: 'user-message' }, dispatch),
    ).resolves.toEqual({ disposition: 'stale' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('rejects an older stopped turn after a newer stop replaces it', async () => {
    const service = new StoppedTurnResumeService();
    service.offer(TARGET, 'older-user-message');
    service.offer(TARGET, 'newer-user-message');
    const dispatch = jest.fn().mockResolvedValue(undefined);

    await expect(
      service.resume(
        { ...TARGET, userMessageId: 'older-user-message' },
        dispatch,
      ),
    ).resolves.toEqual({ disposition: 'stale' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('does not publish an offer when a new turn starts while stop is settling', async () => {
    const service = new StoppedTurnResumeService();
    const pending = service.beginOffer(TARGET, 'stopped-user-message');
    service.invalidateForNewTurn(TARGET, 'new-user-message');

    expect(service.completeOffer(TARGET, pending)).toBe(false);
    await expect(
      service.resume(
        { ...TARGET, userMessageId: 'stopped-user-message' },
        jest.fn(),
      ),
    ).resolves.toEqual({ disposition: 'stale' });
  });

  it('does not publish an offer when unpersisted turn context is recorded while stop is settling', async () => {
    const service = new StoppedTurnResumeService();
    const pending = service.beginOffer(TARGET, 'stopped-user-message');

    service.recordTurnContext(TARGET, 'stopped-user-message', true);

    expect(service.completeOffer(TARGET, pending)).toBe(false);
    await expect(
      service.resume(
        { ...TARGET, userMessageId: 'stopped-user-message' },
        jest.fn(),
      ),
    ).resolves.toEqual({ disposition: 'stale' });
  });

  it('keeps dispatched settlement ownership while a follow-up turn queues', async () => {
    const service = new StoppedTurnResumeService();
    service.offer(TARGET, 'stopped-user-message');
    let dispatchedAttemptId = '';
    let dispatchedExecutionId = '';

    await expect(
      service.resume(
        { ...TARGET, userMessageId: 'stopped-user-message' },
        async (attemptId, _isCurrent, executionId) => {
          await Promise.resolve();
          dispatchedAttemptId = attemptId;
          dispatchedExecutionId = executionId;
          expect(
            service.markDispatchStarted(
              TARGET,
              'stopped-user-message',
              attemptId,
              executionId,
            ),
          ).toBe(true);
        },
      ),
    ).resolves.toEqual({ disposition: 'dispatched' });

    service.invalidateForNewTurn(TARGET, 'follow-up-message');

    expect(
      service.ownsTerminalSettlement(
        TARGET,
        'stopped-user-message',
        dispatchedAttemptId,
        dispatchedExecutionId,
      ),
    ).toBe(true);
    expect(
      service.ownsTerminalSettlement(
        TARGET,
        'stopped-user-message',
        dispatchedAttemptId,
        `${dispatchedExecutionId}-stale`,
      ),
    ).toBe(false);
    await expect(
      service.resume(
        { ...TARGET, userMessageId: 'stopped-user-message' },
        jest.fn(),
      ),
    ).resolves.toEqual({ disposition: 'stale' });

    service.settleTerminalOwnership(
      TARGET,
      'stopped-user-message',
      dispatchedAttemptId,
      dispatchedExecutionId,
    );

    expect(
      service.ownsTerminalSettlement(
        TARGET,
        'stopped-user-message',
        dispatchedAttemptId,
        dispatchedExecutionId,
      ),
    ).toBe(false);
  });

  it('keeps the unfenced path for callers that carry no execution identity yet', async () => {
    const service = new StoppedTurnResumeService();
    service.offer(TARGET, 'stopped-user-message');

    await expect(
      service.resume(
        { ...TARGET, userMessageId: 'stopped-user-message' },
        (attemptId) => {
          expect(
            service.markDispatchStarted(
              TARGET,
              'stopped-user-message',
              attemptId,
            ),
          ).toBe(true);
          return Promise.resolve(true);
        },
      ),
    ).resolves.toEqual({ disposition: 'dispatched' });
    expect(service.ownsTerminalSettlement(TARGET, 'stopped-user-message')).toBe(
      true,
    );
    service.settleTerminalOwnership(TARGET, 'stopped-user-message');
    expect(service.ownsTerminalSettlement(TARGET, 'stopped-user-message')).toBe(
      false,
    );
  });

  it('gives retries of one offer distinct execution ids and fences old callbacks', async () => {
    const service = new StoppedTurnResumeService();
    service.offer(TARGET, 'same-anchor');
    let oldIsCurrent: (() => boolean) | undefined;
    let oldAttemptId = '';
    let oldExecutionId = '';
    await expect(
      service.resume(
        { ...TARGET, userMessageId: 'same-anchor' },
        async (attemptId, isCurrent, executionId) => {
          await Promise.resolve();
          oldIsCurrent = isCurrent;
          oldAttemptId = attemptId;
          oldExecutionId = executionId;
          throw new Error('retry this offer');
        },
      ),
    ).resolves.toMatchObject({ disposition: 'failed', retryable: true });

    let retryAttemptId = '';
    let retryExecutionId = '';
    await expect(
      service.resume(
        { ...TARGET, userMessageId: 'same-anchor' },
        async (attemptId, _isCurrent, executionId) => {
          await Promise.resolve();
          retryAttemptId = attemptId;
          retryExecutionId = executionId;
        },
      ),
    ).resolves.toEqual({ disposition: 'dispatched' });

    expect(retryAttemptId).toBe(oldAttemptId);
    expect(retryExecutionId).not.toBe(oldExecutionId);
    expect(oldIsCurrent?.()).toBe(false);
    expect(
      service.markDispatchStarted(
        TARGET,
        'same-anchor',
        oldAttemptId,
        oldExecutionId,
      ),
    ).toBe(false);
    expect(
      service.ownsTerminalSettlement(
        TARGET,
        'same-anchor',
        oldAttemptId,
        oldExecutionId,
      ),
    ).toBe(false);
    expect(
      service.ownsTerminalSettlement(
        TARGET,
        'same-anchor',
        retryAttemptId,
        retryExecutionId,
      ),
    ).toBe(true);
  });

  it('fences the predecessor Stop and terminal when two Resumes reuse the same anchor', async () => {
    const service = new StoppedTurnResumeService();
    const executions: { attemptId: string; executionId: string }[] = [];
    for (let index = 0; index < 2; index += 1) {
      service.offer(TARGET, 'same-anchor');
      await service.resume(
        { ...TARGET, userMessageId: 'same-anchor' },
        (attemptId, _isCurrent, executionId) => {
          executions.push({ attemptId, executionId });
          return Promise.resolve();
        },
      );
    }
    const first = executions[0];
    const second = executions[1];
    if (!first || !second) throw new Error('Expected two Resume executions');
    expect(first.executionId).not.toBe(second.executionId);
    expect(
      service.markDispatchStarted(
        TARGET,
        'same-anchor',
        first.attemptId,
        first.executionId,
      ),
    ).toBe(false);
    expect(
      service.ownsTerminalSettlement(
        TARGET,
        'same-anchor',
        first.attemptId,
        first.executionId,
      ),
    ).toBe(false);
    service.settleTerminalOwnership(
      TARGET,
      'same-anchor',
      first.attemptId,
      first.executionId,
    );
    expect(
      service.ownsTerminalSettlement(
        TARGET,
        'same-anchor',
        second.attemptId,
        second.executionId,
      ),
    ).toBe(true);
  });
});
