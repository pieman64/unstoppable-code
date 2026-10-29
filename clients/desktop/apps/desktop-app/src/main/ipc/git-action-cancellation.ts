import type {
  CancelGitActionRequest,
  CancelGitActionResponse,
  GitActionOperationRequest,
} from '@canopy/desktop-shared/types/github';

type GitActionPhase = 'idle' | 'agent' | 'git' | 'refreshing';

interface ActiveGitAction {
  operationId: string;
  phase: GitActionPhase;
  cancelRequested: boolean;
  cancelListeners: Set<() => void>;
  agentControllers: Set<AbortController>;
  gitStepCount: number;
}

function actionKey(projectId: string, worktreeId: string): string {
  return `${projectId}:${worktreeId}`;
}

export class GitActionCancelledError extends Error {
  constructor() {
    super('Git action cancelled');
    this.name = 'GitActionCancelledError';
  }
}

export function isGitActionCancelledError(
  error: unknown,
): error is GitActionCancelledError {
  return error instanceof GitActionCancelledError;
}

export class GitActionCancellationScope {
  constructor(
    private readonly key: string,
    private readonly active: ActiveGitAction,
  ) {}

  get cancelled(): boolean {
    return this.active.cancelRequested;
  }

  checkpoint(): void {
    if (this.active.cancelRequested) {
      throw new GitActionCancelledError();
    }
  }

  onCancel(listener: () => void): () => void {
    if (this.active.cancelRequested) {
      listener();
      return (): void => undefined;
    }

    this.active.cancelListeners.add(listener);
    return (): void => {
      this.active.cancelListeners.delete(listener);
    };
  }

  async runAgentStep<T>(
    run: (controller: AbortController) => Promise<T>,
  ): Promise<T> {
    this.checkpoint();
    const controller = new AbortController();
    this.active.phase = 'agent';
    this.active.agentControllers.add(controller);
    try {
      const result = await run(controller);
      this.checkpoint();
      return result;
    } catch (error) {
      if (this.active.cancelRequested || controller.signal.aborted) {
        throw new GitActionCancelledError();
      }
      throw error;
    } finally {
      this.active.agentControllers.delete(controller);
      if (
        this.active.phase === 'agent' &&
        this.active.agentControllers.size === 0
      ) {
        this.active.phase = 'idle';
      }
    }
  }

  /**
   * Git and GitHub mutations are deliberately not aborted. A pending cancel is
   * observed only after the command settles, before any following phase starts.
   */
  async runGitStep<T>(run: () => Promise<T>): Promise<T> {
    this.checkpoint();
    this.active.phase = 'git';
    this.active.gitStepCount += 1;
    try {
      const result = await run();
      this.checkpoint();
      return result;
    } finally {
      this.active.gitStepCount -= 1;
      if (this.active.phase === 'git' && this.active.gitStepCount === 0) {
        this.active.phase = 'idle';
      }
    }
  }

  enterRefreshing(): void {
    this.checkpoint();
    this.active.phase = 'refreshing';
  }

  matches(key: string, operationId: string): boolean {
    return this.key === key && this.active.operationId === operationId;
  }
}

const activeGitActions = new Map<string, ActiveGitAction>();

/** Read-only eligibility for remote controls sharing the desktop Git lock. */
export function isGitActionActive(request: {
  projectId: string;
  worktreeId: string;
}): boolean {
  return activeGitActions.has(actionKey(request.projectId, request.worktreeId));
}

export function beginGitActionCancellationScope(
  request: GitActionOperationRequest & {
    projectId: string;
    worktreeId: string;
  },
): GitActionCancellationScope {
  const key = actionKey(request.projectId, request.worktreeId);
  if (activeGitActions.has(key)) {
    throw new Error('A Git action is already active for this worktree');
  }
  const operationId = request.operationId ?? key;
  const active: ActiveGitAction = {
    operationId,
    phase: 'idle',
    cancelRequested: false,
    cancelListeners: new Set(),
    agentControllers: new Set(),
    gitStepCount: 0,
  };
  activeGitActions.set(key, active);
  return new GitActionCancellationScope(key, active);
}

export function finishGitActionCancellationScope(
  request: GitActionOperationRequest & {
    projectId: string;
    worktreeId: string;
  },
  scope: GitActionCancellationScope,
): void {
  const key = actionKey(request.projectId, request.worktreeId);
  const operationId = request.operationId ?? key;
  if (scope.matches(key, operationId)) {
    const current = activeGitActions.get(key);
    if (current?.operationId === operationId) {
      activeGitActions.delete(key);
    }
  }
}

export function requestGitActionCancellation(
  request: CancelGitActionRequest,
): CancelGitActionResponse {
  const active = activeGitActions.get(
    actionKey(request.projectId, request.worktreeId),
  );
  if (!active || active.operationId !== request.operationId) {
    return { accepted: false, reason: 'not_active' };
  }
  if (active.phase === 'refreshing') {
    return { accepted: false, reason: 'refreshing' };
  }

  active.cancelRequested = true;
  active.cancelListeners.forEach((listener) => {
    listener();
  });
  active.cancelListeners.clear();
  active.agentControllers.forEach((controller) => {
    controller.abort(new GitActionCancelledError());
  });
  return { accepted: true, reason: 'cancel_requested' };
}

export function resetGitActionCancellationsForTests(): void {
  activeGitActions.clear();
}
