import { CanopyCloudClientError } from '../canopy-cloud/client';
import {
  SharedContainerPublicationStateStore,
  type SharedContainerPublicationRecord,
} from '../shared-containers/publication-state';
import {
  SharedContainerPublishScheduler,
  SHARED_CONTAINER_PUBLISH_IDLE_DEBOUNCE_MS,
  classifySharedContainerPublishFailure,
  type SharedContainerPublishTarget,
} from '../shared-containers/publish/scheduler';
import { SharedContainerPublishInventoryChangedError } from '../shared-containers/publish/source-files';

describe('shared-container publish scheduler', () => {
  const target = {
    projectId: 'project-1',
    worktreeId: 'entry-1',
    organizationId: 'org-1',
    containerId: 'container-1',
    containerType: 'COWORK_WORK_ENTRY' as const,
  };

  afterEach(() => jest.useRealTimers());

  it('bounds package recovery after successful degraded publications and resumes it after restart', async () => {
    jest.useFakeTimers();
    let state: SharedContainerPublicationRecord = {
      ...target,
      status: 'published',
      updatedAt: 'now',
      packageRecoveryPending: true,
      packageRecoveryAttempts: 1,
    };
    const stateStore = new SharedContainerPublicationStateStore();
    jest
      .spyOn(stateStore, 'get')
      .mockImplementation(() => Promise.resolve(state));
    const publish = jest.fn(() => {
      state = {
        ...state,
        packageRecoveryAttempts: (state.packageRecoveryAttempts ?? 0) + 1,
      };
      return Promise.resolve(state);
    });
    const scheduler = new SharedContainerPublishScheduler({
      publish,
      stateStore,
      hasAudience: (): Promise<boolean> => Promise.resolve(true),
      random: (): number => 0,
      pruneStaging: (): Promise<void> => Promise.resolve(),
    });
    await scheduler.recover([state]);
    expect(publish).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(120_000);
    expect(publish).toHaveBeenCalledTimes(4);
    expect(jest.getTimerCount()).toBe(0);
    await scheduler.recover([state]);
    expect(publish).toHaveBeenCalledTimes(4);
  });

  it('schedules known code publications and collapses repeated activity', async () => {
    jest.useFakeTimers();
    const publish = jest.fn().mockResolvedValue(undefined);
    const state = {
      ...target,
      containerType: 'CODE_WORKTREE' as const,
      status: 'published' as const,
      updatedAt: 'now',
    };
    const list = jest.fn(() => Promise.resolve([state]));
    const scheduler = new SharedContainerPublishScheduler({
      publish,
      hasAudience: (): Promise<boolean> => Promise.resolve(true),
      stateStore: {
        get: jest.fn(() => Promise.resolve(state)),
        list,
        set: jest.fn((value: unknown) => Promise.resolve(value)),
      } as unknown as SharedContainerPublicationStateStore,
      random: (): number => 0,
    });

    await scheduler.scheduleKnown(target.projectId, target.worktreeId);
    await jest.advanceTimersByTimeAsync(5_000);
    await scheduler.scheduleKnown(target.projectId, target.worktreeId);
    expect(list).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(9_999);
    expect(publish).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ containerType: 'CODE_WORKTREE' }),
    );
  });

  it('observes a replacement published while an earlier known-state lookup is pending', async () => {
    jest.useFakeTimers();
    const replacement = { ...target, containerId: 'container-2' };
    const oldState = {
      ...target,
      status: 'published' as const,
      updatedAt: 'old',
    };
    const newState = {
      ...replacement,
      status: 'published' as const,
      updatedAt: 'new',
    };
    let releaseOldLookup: ((states: (typeof oldState)[]) => void) | undefined;
    const oldLookup = new Promise<(typeof oldState)[]>((resolve) => {
      releaseOldLookup = resolve;
    });
    const stateStore = new SharedContainerPublicationStateStore();
    const list = jest
      .spyOn(stateStore, 'list')
      .mockReturnValueOnce(oldLookup)
      .mockResolvedValueOnce([newState]);
    jest.spyOn(stateStore, 'get').mockResolvedValue(newState);
    jest
      .spyOn(stateStore, 'set')
      .mockImplementation((state) => Promise.resolve(state));
    const publish = jest.fn().mockResolvedValue(undefined);
    const scheduler = new SharedContainerPublishScheduler({
      publish,
      hasAudience: (): Promise<boolean> => Promise.resolve(true),
      stateStore,
      random: (): number => 0,
    });

    const first = scheduler.scheduleKnown(target.projectId, target.worktreeId);
    const afterChange = scheduler.scheduleKnown(
      target.projectId,
      target.worktreeId,
    );
    if (!releaseOldLookup) throw new Error('Expected old lookup to start');
    releaseOldLookup([oldState]);
    await Promise.all([first, afterChange]);
    await jest.advanceTimersByTimeAsync(
      SHARED_CONTAINER_PUBLISH_IDLE_DEBOUNCE_MS,
    );

    expect(list).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(replacement);
  });

  it('settles a failed known-state lookup without losing a queued caller or later retry', async () => {
    jest.useFakeTimers();
    const failure = new Error('publication state temporarily unavailable');
    const state = { ...target, status: 'published' as const, updatedAt: 'now' };
    let rejectFirst: ((reason: Error) => void) | undefined;
    const firstLookup = new Promise<(typeof state)[]>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const stateStore = new SharedContainerPublicationStateStore();
    const list = jest
      .spyOn(stateStore, 'list')
      .mockReturnValueOnce(firstLookup)
      .mockResolvedValue([state]);
    jest.spyOn(stateStore, 'get').mockResolvedValue(state);
    jest
      .spyOn(stateStore, 'set')
      .mockImplementation((value) => Promise.resolve(value));
    const publish = jest.fn().mockResolvedValue(undefined);
    const scheduler = new SharedContainerPublishScheduler({
      publish,
      hasAudience: (): Promise<boolean> => Promise.resolve(true),
      stateStore,
      random: (): number => 0,
    });

    const first = scheduler.scheduleKnown(target.projectId, target.worktreeId);
    const firstFailure = expect(first).rejects.toBe(failure);
    const queued = scheduler.scheduleKnown(target.projectId, target.worktreeId);
    if (!rejectFirst) throw new Error('Expected first lookup to start');
    rejectFirst(failure);
    await firstFailure;
    await expect(queued).resolves.toBeUndefined();
    expect(list).toHaveBeenCalledTimes(2);
    await expect(
      scheduler.scheduleKnown(target.projectId, target.worktreeId),
    ).resolves.toBeUndefined();
    expect(list).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(
      SHARED_CONTAINER_PUBLISH_IDLE_DEBOUNCE_MS,
    );
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('retries a known-state lookup after a failed cycle without a queued caller', async () => {
    const failure = new Error('publication state read failed');
    const stateStore = new SharedContainerPublicationStateStore();
    const list = jest
      .spyOn(stateStore, 'list')
      .mockRejectedValueOnce(failure)
      .mockResolvedValue([]);
    jest.spyOn(stateStore, 'get').mockResolvedValue(null);
    jest
      .spyOn(stateStore, 'set')
      .mockImplementation((state) => Promise.resolve(state));
    const scheduler = new SharedContainerPublishScheduler({
      publish: jest.fn().mockResolvedValue(undefined),
      hasAudience: (): Promise<boolean> => Promise.resolve(true),
      stateStore,
      random: (): number => 0,
    });

    await expect(
      scheduler.scheduleKnown(target.projectId, target.worktreeId),
    ).rejects.toBe(failure);
    await expect(
      scheduler.scheduleKnown(target.projectId, target.worktreeId),
    ).resolves.toBeUndefined();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('preserves a late explicit known-state request behind ordinary activity', async () => {
    jest.useFakeTimers();
    const state = {
      ...target,
      status: 'error' as const,
      terminalError: true,
      updatedAt: 'now',
    };
    let releaseFirst: ((states: (typeof state)[]) => void) | undefined;
    const firstLookup = new Promise<(typeof state)[]>((resolve) => {
      releaseFirst = resolve;
    });
    let releaseExplicit: ((states: (typeof state)[]) => void) | undefined;
    const explicitLookup = new Promise<(typeof state)[]>((resolve) => {
      releaseExplicit = resolve;
    });
    const stateStore = new SharedContainerPublicationStateStore();
    const list = jest
      .spyOn(stateStore, 'list')
      .mockReturnValueOnce(firstLookup)
      .mockReturnValueOnce(explicitLookup);
    jest.spyOn(stateStore, 'get').mockResolvedValue(state);
    const set = jest
      .spyOn(stateStore, 'set')
      .mockImplementation((value) => Promise.resolve(value));
    const publish = jest.fn().mockResolvedValue(undefined);
    const scheduler = new SharedContainerPublishScheduler({
      publish,
      hasAudience: (): Promise<boolean> => Promise.resolve(true),
      stateStore,
      random: (): number => 0,
    });

    const activity = scheduler.scheduleKnown(
      target.projectId,
      target.worktreeId,
    );
    const explicit = scheduler.scheduleKnown(
      target.projectId,
      target.worktreeId,
      true,
    );
    if (!releaseFirst) throw new Error('Expected first lookup to start');
    releaseFirst([state]);
    await activity;
    if (!releaseExplicit) throw new Error('Expected explicit lookup to start');
    releaseExplicit([state]);
    await explicit;
    expect(list).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(
      SHARED_CONTAINER_PUBLISH_IDLE_DEBOUNCE_MS,
    );
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'not-published' }),
    );
    expect(set.mock.calls[0]?.[0]).not.toHaveProperty('terminalError');
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('efficiency: bounds concurrent known-state reads to an active lookup and one rerun', async () => {
    jest.useFakeTimers();
    const state = { ...target, status: 'published' as const, updatedAt: 'now' };
    let releaseFirst: ((states: (typeof state)[]) => void) | undefined;
    const firstLookup = new Promise<(typeof state)[]>((resolve) => {
      releaseFirst = resolve;
    });
    const stateStore = new SharedContainerPublicationStateStore();
    const list = jest
      .spyOn(stateStore, 'list')
      .mockReturnValueOnce(firstLookup)
      .mockResolvedValue([state]);
    jest.spyOn(stateStore, 'get').mockResolvedValue(state);
    jest
      .spyOn(stateStore, 'set')
      .mockImplementation((value) => Promise.resolve(value));
    const publish = jest.fn().mockResolvedValue(undefined);
    const scheduler = new SharedContainerPublishScheduler({
      publish,
      hasAudience: (): Promise<boolean> => Promise.resolve(true),
      stateStore,
      random: (): number => 0,
    });

    const requests = Array.from({ length: 12 }, () =>
      scheduler.scheduleKnown(target.projectId, target.worktreeId),
    );
    if (!releaseFirst) throw new Error('Expected first lookup to start');
    releaseFirst([state]);
    await Promise.all(requests);
    expect(list).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(
      SHARED_CONTAINER_PUBLISH_IDLE_DEBOUNCE_MS,
    );
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('does not coalesce a replacement container into an in-flight old target', async () => {
    jest.useFakeTimers();
    let resolveOldPublish!: () => void;
    let currentState: SharedContainerPublicationRecord = {
      ...target,
      status: 'not-published' as const,
      updatedAt: 'now',
    };
    const replacement = { ...target, containerId: 'container-2' };
    const publish = jest.fn<
      Promise<SharedContainerPublicationRecord>,
      [scheduled: SharedContainerPublishTarget]
    >((scheduled): Promise<SharedContainerPublicationRecord> => {
      if (scheduled.containerId !== target.containerId) {
        return Promise.resolve(currentState);
      }
      return new Promise<SharedContainerPublicationRecord>((resolve) => {
        resolveOldPublish = (): void => resolve(currentState);
      });
    });
    const scheduler = new SharedContainerPublishScheduler({
      publish,
      hasAudience: (): Promise<boolean> => Promise.resolve(true),
      stateStore: {
        get: jest.fn(() => Promise.resolve(currentState)),
        list: jest.fn(() => Promise.resolve([])),
        set: jest.fn((state: typeof currentState) => Promise.resolve(state)),
      } as unknown as SharedContainerPublicationStateStore,
      random: (): number => 0,
    });

    scheduler.schedule(target, true);
    await jest.advanceTimersByTimeAsync(
      SHARED_CONTAINER_PUBLISH_IDLE_DEBOUNCE_MS,
    );
    expect(publish).toHaveBeenCalledWith(target);

    currentState = {
      ...currentState,
      containerId: replacement.containerId,
    };
    scheduler.schedule(replacement, true);
    await jest.advanceTimersByTimeAsync(
      SHARED_CONTAINER_PUBLISH_IDLE_DEBOUNCE_MS,
    );

    resolveOldPublish();
    await Promise.resolve();
    expect(publish).toHaveBeenCalledWith(replacement);
  });

  it('classifies validation failures as terminal and network/429/5xx as transient', () => {
    expect(
      classifySharedContainerPublishFailure(
        new CanopyCloudClientError(
          'http-error',
          'bad',
          422,
          undefined,
          undefined,
          true,
        ),
      ),
    ).toBe('terminal');
    expect(
      classifySharedContainerPublishFailure(
        new CanopyCloudClientError('http-error', 'busy', 429),
      ),
    ).toBe('transient');
    expect(
      classifySharedContainerPublishFailure(
        new CanopyCloudClientError('http-error', 'down', 503),
      ),
    ).toBe('transient');
    expect(
      classifySharedContainerPublishFailure(
        new CanopyCloudClientError('network-error', 'offline'),
      ),
    ).toBe('transient');
    expect(
      classifySharedContainerPublishFailure(
        new SharedContainerPublishInventoryChangedError(),
      ),
    ).toBe('transient');
    expect(
      classifySharedContainerPublishFailure(
        new CanopyCloudClientError(
          'http-error',
          'cleanup in progress',
          409,
          'shared-container-cleanup-in-progress',
        ),
      ),
    ).toBe('transient');
    expect(
      classifySharedContainerPublishFailure(
        new CanopyCloudClientError(
          'http-error',
          'signed upload expired',
          403,
          undefined,
          undefined,
          false,
        ),
      ),
    ).toBe('transient');
    expect(
      classifySharedContainerPublishFailure(
        new CanopyCloudClientError(
          'http-error',
          'permission denied',
          403,
          'insufficient-role',
          undefined,
          true,
        ),
      ),
    ).toBe('terminal');
    for (const status of [404, 409, 422]) {
      expect(
        classifySharedContainerPublishFailure(
          new CanopyCloudClientError(
            'http-error',
            'synthetic upstream response',
            status,
            undefined,
            undefined,
            false,
          ),
        ),
      ).toBe('transient');
    }
    expect(
      classifySharedContainerPublishFailure(
        new CanopyCloudClientError(
          'http-error',
          'container not found',
          404,
          undefined,
          undefined,
          true,
        ),
      ),
    ).toBe('terminal');
  });

  it('parks a terminal failure and does not retry it', async () => {
    jest.useFakeTimers();
    const publish = jest
      .fn()
      .mockRejectedValue(
        new CanopyCloudClientError(
          'http-error',
          'invalid',
          422,
          undefined,
          undefined,
          true,
        ),
      );
    const set = jest.fn((state: unknown) => Promise.resolve(state));
    const stateStore = {
      get: jest.fn(() =>
        Promise.resolve({
          ...target,
          status: 'not-published',
          updatedAt: 'now',
        }),
      ),
      list: jest.fn(() => Promise.resolve([])),
      set,
    } as unknown as SharedContainerPublicationStateStore;
    const scheduler = new SharedContainerPublishScheduler({
      publish,
      hasAudience: (): Promise<boolean> => Promise.resolve(true),
      stateStore,
      random: (): number => 0,
    });

    scheduler.schedule(target, true);
    await jest.advanceTimersByTimeAsync(
      SHARED_CONTAINER_PUBLISH_IDLE_DEBOUNCE_MS,
    );
    expect(publish).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error', terminalError: true }),
    );
    await jest.runOnlyPendingTimersAsync();
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('honors Retry-After and reuses the retry path without overlap', async () => {
    jest.useFakeTimers();
    let resolvePublish!: () => void;
    const retryable = new CanopyCloudClientError(
      'http-error',
      'busy',
      503,
      undefined,
      undefined,
      false,
      5_000,
    );
    const publish = jest
      .fn()
      .mockRejectedValueOnce(retryable)
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolvePublish = resolve;
          }),
      );
    const stateStore = {
      get: jest.fn(() =>
        Promise.resolve({
          ...target,
          status: 'not-published',
          updatedAt: 'now',
          idempotencyKey: 'same-key',
        }),
      ),
      list: jest.fn(() => Promise.resolve([])),
      set: jest.fn((state: unknown) => Promise.resolve(state)),
    } as unknown as SharedContainerPublicationStateStore;
    const scheduler = new SharedContainerPublishScheduler({
      publish,
      hasAudience: (): Promise<boolean> => Promise.resolve(true),
      stateStore,
      random: (): number => 0,
    });

    scheduler.schedule(target, true);
    await jest.advanceTimersByTimeAsync(
      SHARED_CONTAINER_PUBLISH_IDLE_DEBOUNCE_MS,
    );
    expect(publish).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(4_999);
    expect(publish).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(publish).toHaveBeenCalledTimes(2);
    scheduler.schedule(target);
    await jest.advanceTimersByTimeAsync(
      SHARED_CONTAINER_PUBLISH_IDLE_DEBOUNCE_MS,
    );
    expect(publish).toHaveBeenCalledTimes(2);
    resolvePublish();
    await Promise.resolve();
  });

  it('does not let ordinary activity preempt Retry-After backoff', async () => {
    jest.useFakeTimers();
    const retryable = new CanopyCloudClientError(
      'http-error',
      'busy',
      503,
      undefined,
      undefined,
      false,
      5_000,
    );
    const publish = jest
      .fn()
      .mockRejectedValueOnce(retryable)
      .mockResolvedValue(undefined);
    const stateStore = {
      get: jest.fn(() =>
        Promise.resolve({
          ...target,
          status: 'error' as const,
          updatedAt: 'now',
          idempotencyKey: 'same-key',
        }),
      ),
      list: jest.fn(() => Promise.resolve([])),
      set: jest.fn((state: unknown) => Promise.resolve(state)),
    } as unknown as SharedContainerPublicationStateStore;
    const scheduler = new SharedContainerPublishScheduler({
      publish,
      hasAudience: (): Promise<boolean> => Promise.resolve(true),
      stateStore,
      random: (): number => 0,
    });

    scheduler.schedule(target, true);
    await jest.advanceTimersByTimeAsync(
      SHARED_CONTAINER_PUBLISH_IDLE_DEBOUNCE_MS,
    );
    expect(publish).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1_000);
    scheduler.schedule(target);
    await jest.advanceTimersByTimeAsync(3_999);
    expect(publish).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it('allows later activity to re-arm an exhausted transient failure', async () => {
    jest.useFakeTimers();
    let state: Record<string, unknown> = {
      ...target,
      status: 'not-published',
      updatedAt: 'now',
      idempotencyKey: 'same-key',
      stagingSessionId: 'same-stage',
      stagedRevisionId: 'same-revision',
      stageRequestHash: 'sha256:same-request',
    };
    const publish = jest
      .fn()
      .mockRejectedValue(
        new CanopyCloudClientError('network-error', 'offline'),
      );
    const stateStore = {
      get: jest.fn(() => Promise.resolve(state)),
      list: jest.fn(() => Promise.resolve([])),
      set: jest.fn((next: Record<string, unknown>) => {
        state = next;
        return Promise.resolve(next);
      }),
    } as unknown as SharedContainerPublicationStateStore;
    const scheduler = new SharedContainerPublishScheduler({
      publish,
      hasAudience: (): Promise<boolean> => Promise.resolve(true),
      stateStore,
      random: (): number => 0,
    });

    scheduler.schedule(target, true);
    await jest.advanceTimersByTimeAsync(
      SHARED_CONTAINER_PUBLISH_IDLE_DEBOUNCE_MS,
    );
    await jest.runAllTimersAsync();
    expect(publish).toHaveBeenCalledTimes(5);
    expect(state).toMatchObject({ status: 'error' });
    expect(state).not.toHaveProperty('terminalError', true);

    scheduler.schedule(target);
    await jest.advanceTimersByTimeAsync(
      SHARED_CONTAINER_PUBLISH_IDLE_DEBOUNCE_MS,
    );
    expect(publish).toHaveBeenCalledTimes(6);
    expect(state).toMatchObject({
      idempotencyKey: 'same-key',
      stagingSessionId: 'same-stage',
      stagedRevisionId: 'same-revision',
      stageRequestHash: 'sha256:same-request',
    });
  });

  it('recovers first, in-flight, and transient Cowork publications', async () => {
    const notPublished = {
      ...target,
      organizationId: 'org-0',
      containerType: 'COWORK_WORK_ENTRY' as const,
      status: 'not-published' as const,
      updatedAt: 'now',
    };
    const publishing = {
      ...target,
      containerType: 'COWORK_WORK_ENTRY' as const,
      status: 'publishing' as const,
      idempotencyKey: 'publishing-key',
      stagingSessionId: 'publishing-stage',
      updatedAt: 'now',
    };
    const transientError = {
      ...target,
      organizationId: 'org-2',
      containerType: 'COWORK_WORK_ENTRY' as const,
      status: 'error' as const,
      error: 'offline',
      idempotencyKey: 'retry-key',
      updatedAt: 'now',
    };
    const ignored = [
      {
        ...target,
        organizationId: 'org-3',
        containerType: 'COWORK_WORK_ENTRY' as const,
        status: 'published' as const,
        updatedAt: 'now',
      },
      {
        ...target,
        organizationId: 'org-4',
        containerType: 'COWORK_WORK_ENTRY' as const,
        status: 'error' as const,
        terminalError: true,
        idempotencyKey: 'terminal-key',
        updatedAt: 'now',
      },
      {
        ...target,
        organizationId: 'org-5',
        containerType: 'CODE_WORKTREE' as const,
        status: 'publishing' as const,
        idempotencyKey: 'code-key',
        updatedAt: 'now',
      },
    ];
    const states = [notPublished, publishing, transientError, ...ignored];
    const publish = jest.fn().mockResolvedValue(undefined);
    const pruneStaging = jest.fn().mockResolvedValue(undefined);
    const stateStore = {
      get: jest.fn(
        (_projectId: string, _worktreeId: string, organizationId: string) =>
          Promise.resolve(
            states.find((state) => state.organizationId === organizationId) ??
              null,
          ),
      ),
      list: jest.fn(() => Promise.resolve([])),
      set: jest.fn((state: unknown) => Promise.resolve(state)),
    } as unknown as SharedContainerPublicationStateStore;
    const dependencies = {
      publish,
      hasAudience: (): Promise<boolean> => Promise.resolve(true),
      stateStore,
      random: (): number => 0,
      pruneStaging,
    };
    const scheduler = new SharedContainerPublishScheduler(dependencies);

    await scheduler.recover(states);

    expect(pruneStaging).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(4);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-0' }),
    );
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1' }),
    );
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-2' }),
    );
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-5',
        containerType: 'CODE_WORKTREE',
      }),
    );
  });

  it('recovers a transient publication that must restart with a fresh stage', async () => {
    const restartWithFreshStage = {
      ...target,
      containerType: 'COWORK_WORK_ENTRY' as const,
      status: 'error' as const,
      error: 'Upload target refresh limit exceeded',
      restartWithFreshStage: true,
      updatedAt: 'now',
    };
    const publish = jest.fn().mockResolvedValue(undefined);
    const scheduler = new SharedContainerPublishScheduler({
      publish,
      hasAudience: (): Promise<boolean> => Promise.resolve(true),
      stateStore: {
        get: jest.fn(() => Promise.resolve(restartWithFreshStage)),
        list: jest.fn(() => Promise.resolve([])),
        set: jest.fn((state: unknown) => Promise.resolve(state)),
      } as unknown as SharedContainerPublicationStateStore,
      random: (): number => 0,
      pruneStaging: jest.fn().mockResolvedValue(undefined),
    });

    await scheduler.recover([restartWithFreshStage]);

    expect(publish).toHaveBeenCalledWith(target);
  });

  it('retries a classified terminal refusal after later owner activity', async () => {
    jest.useFakeTimers();
    let state = {
      ...target,
      status: 'error' as const,
      error: 'Push the current commit',
      errorReason: 'unpushed-head' as const,
      terminalError: true,
      updatedAt: 'then',
    };
    const publish = jest.fn().mockResolvedValue(undefined);
    const set = jest.fn((next: typeof state) => {
      state = next;
      return Promise.resolve(next);
    });
    const scheduler = new SharedContainerPublishScheduler({
      publish,
      hasAudience: (): Promise<boolean> => Promise.resolve(true),
      stateStore: {
        get: jest.fn(() => Promise.resolve(state)),
        list: jest.fn(() => Promise.resolve([])),
        set,
      } as unknown as SharedContainerPublicationStateStore,
      random: (): number => 0,
    });

    scheduler.schedule(target);
    await jest.advanceTimersByTimeAsync(
      SHARED_CONTAINER_PUBLISH_IDLE_DEBOUNCE_MS,
    );

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'not-published' }),
    );
    expect(set.mock.calls[0][0]).not.toHaveProperty('terminalError');
    expect(set.mock.calls[0][0]).not.toHaveProperty('errorReason');
    expect(publish).toHaveBeenCalledWith(target);
  });

  it('does not carry a previous refusal reason onto an unrelated failure', async () => {
    jest.useFakeTimers();
    // The record already holds a classified refusal from an earlier run.
    const current = {
      ...target,
      status: 'error' as const,
      error: 'Repository uses Git LFS',
      errorReason: 'git-lfs' as const,
      updatedAt: 'then',
    };
    // The next attempt fails for an unclassified reason. The renderer prefers
    // errorReason's remedy over the exception string, so a stale reason would
    // show the owner an LFS remedy for an offline failure.
    const publish = jest.fn().mockRejectedValue(new Error('offline'));
    const set = jest.fn((state: unknown) => Promise.resolve(state));
    const scheduler = new SharedContainerPublishScheduler({
      publish,
      hasAudience: (): Promise<boolean> => Promise.resolve(true),
      stateStore: {
        get: jest.fn(() => Promise.resolve(current)),
        list: jest.fn(() => Promise.resolve([])),
        set,
      } as unknown as SharedContainerPublicationStateStore,
      random: (): number => 0,
    });

    scheduler.schedule(target, false);
    await jest.advanceTimersByTimeAsync(
      SHARED_CONTAINER_PUBLISH_IDLE_DEBOUNCE_MS,
    );

    expect(set).toHaveBeenCalledTimes(1);
    const parked = set.mock.calls[0][0] as Record<string, unknown>;
    expect(parked.status).toBe('error');
    expect(parked.error).toBe('offline');
    expect(parked).not.toHaveProperty('errorReason');
  });
});
