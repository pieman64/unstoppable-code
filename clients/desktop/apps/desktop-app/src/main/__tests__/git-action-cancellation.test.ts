import {
  beginGitActionCancellationScope,
  isGitActionActive,
  finishGitActionCancellationScope,
  requestGitActionCancellation,
  resetGitActionCancellationsForTests,
} from '../ipc/git-action-cancellation';

const request = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  operationId: 'operation-1',
};

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((reason: unknown) => void) | undefined;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return {
    promise,
    resolve(value: T): void {
      if (!resolve) throw new Error('Deferred resolver was not initialized');
      resolve(value);
    },
    reject(reason: unknown): void {
      if (!reject) throw new Error('Deferred rejecter was not initialized');
      reject(reason);
    },
  };
}

describe('Git action cancellation', () => {
  it('reports worktree-scoped eligibility until the Git action finishes', () => {
    expect(isGitActionActive(request)).toBe(false);
    const scope = beginGitActionCancellationScope(request);
    expect(isGitActionActive(request)).toBe(true);
    expect(isGitActionActive({ ...request, worktreeId: 'other' })).toBe(false);
    finishGitActionCancellationScope(request, scope);
    expect(isGitActionActive(request)).toBe(false);
  });

  afterEach(() => {
    resetGitActionCancellationsForTests();
  });

  it('aborts an agent step and discards its eventual result', async () => {
    const scope = beginGitActionCancellationScope(request);
    const agentResult = deferred<string>();
    let observedSignal: AbortSignal | undefined;
    const running = scope.runAgentStep((controller) => {
      observedSignal = controller.signal;
      return agentResult.promise;
    });

    expect(requestGitActionCancellation(request)).toEqual({
      accepted: true,
      reason: 'cancel_requested',
    });
    expect(observedSignal?.aborted).toBe(true);

    agentResult.resolve('must be discarded');
    await expect(running).rejects.toMatchObject({
      name: 'GitActionCancelledError',
    });
    finishGitActionCancellationScope(request, scope);
  });

  it('lets a Git step finish before stopping at the next boundary', async () => {
    const scope = beginGitActionCancellationScope(request);
    const gitResult = deferred<string>();
    const running = scope.runGitStep(() => gitResult.promise);

    expect(requestGitActionCancellation(request).accepted).toBe(true);
    let settled = false;
    void running.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    gitResult.resolve('finished safely');
    await expect(running).rejects.toMatchObject({
      name: 'GitActionCancelledError',
    });
    finishGitActionCancellationScope(request, scope);
  });

  it('preserves a Git step failure when cancellation is requested', async () => {
    const scope = beginGitActionCancellationScope(request);
    const gitResult = deferred<string>();
    const running = scope.runGitStep(() => gitResult.promise);

    expect(requestGitActionCancellation(request).accepted).toBe(true);
    const failure = new Error('push rejected');
    gitResult.reject(failure);

    await expect(running).rejects.toBe(failure);
    finishGitActionCancellationScope(request, scope);
  });

  it('refuses cancellation after refreshing starts', () => {
    const scope = beginGitActionCancellationScope(request);
    scope.enterRefreshing();

    expect(requestGitActionCancellation(request)).toEqual({
      accepted: false,
      reason: 'refreshing',
    });
    finishGitActionCancellationScope(request, scope);
  });

  it('does not cancel a newer operation with a stale operation id', () => {
    const scope = beginGitActionCancellationScope({
      ...request,
      operationId: 'operation-2',
    });

    expect(requestGitActionCancellation(request)).toEqual({
      accepted: false,
      reason: 'not_active',
    });
    finishGitActionCancellationScope(
      { ...request, operationId: 'operation-2' },
      scope,
    );
  });

  it('rejects an overlapping action without orphaning the active scope', () => {
    const scope = beginGitActionCancellationScope(request);

    expect(() =>
      beginGitActionCancellationScope({
        ...request,
        operationId: 'operation-2',
      }),
    ).toThrow('A Git action is already active for this worktree');
    expect(requestGitActionCancellation(request)).toEqual({
      accepted: true,
      reason: 'cancel_requested',
    });

    finishGitActionCancellationScope(request, scope);
  });
});
