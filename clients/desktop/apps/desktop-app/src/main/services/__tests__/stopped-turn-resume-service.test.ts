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

    await expect(
      service.resume(
        { ...TARGET, userMessageId: 'stopped-user-message' },
        jest.fn().mockResolvedValue(undefined),
      ),
    ).resolves.toEqual({ disposition: 'dispatched' });

    service.invalidateForNewTurn(TARGET, 'follow-up-message');

    expect(service.ownsTerminalSettlement(TARGET, 'stopped-user-message')).toBe(
      true,
    );
    await expect(
      service.resume(
        { ...TARGET, userMessageId: 'stopped-user-message' },
        jest.fn(),
      ),
    ).resolves.toEqual({ disposition: 'stale' });

    service.settleTerminalOwnership(TARGET, 'stopped-user-message');

    expect(service.ownsTerminalSettlement(TARGET, 'stopped-user-message')).toBe(
      false,
    );
  });
});
