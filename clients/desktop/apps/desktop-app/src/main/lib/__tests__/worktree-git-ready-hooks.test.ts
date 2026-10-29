jest.mock('../main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));

import { logMainProcessWarn } from '../main-process-logging';
import {
  publishWorktreeGitReady,
  registerWorktreeGitReadyHook,
  type WorktreeGitReadyHookEvent,
} from '../worktree-git-ready-hooks';

const event: WorktreeGitReadyHookEvent = {
  projectId: 'ws-1',
  worktreeId: 'wt-1',
  branchName: 'wt-1-1792088684150',
  workspaceKind: 'single-repo',
};

const unregisters: Array<() => void> = [];

function register(
  hook: Parameters<typeof registerWorktreeGitReadyHook>[0],
): () => void {
  const unregister = registerWorktreeGitReadyHook(hook);
  unregisters.push(unregister);
  return unregister;
}

afterEach(() => {
  for (const unregister of unregisters.splice(0)) unregister();
  jest.clearAllMocks();
});

describe('worktree git-ready hooks', () => {
  it('delivers the published event to each registered hook', async () => {
    const first = jest.fn();
    const second = jest.fn(() => Promise.resolve());
    register(first);
    register(second);

    await publishWorktreeGitReady(event);

    expect(first).toHaveBeenCalledWith(event);
    expect(second).toHaveBeenCalledWith(event);
  });

  it('isolates a hook that throws or rejects', async () => {
    const after = jest.fn();
    register(() => {
      throw new Error('sync failure');
    });
    register(() => Promise.reject(new Error('async failure')));
    register(after);

    await expect(publishWorktreeGitReady(event)).resolves.toBeUndefined();

    expect(after).toHaveBeenCalledWith(event);
    expect(logMainProcessWarn).toHaveBeenCalledTimes(2);
  });

  it('does not call an unregistered hook', async () => {
    const hook = jest.fn();
    const unregister = register(hook);
    unregister();

    await publishWorktreeGitReady(event);

    expect(hook).not.toHaveBeenCalled();
  });

  it('keeps one registration for the same hook', async () => {
    const hook = jest.fn();
    register(hook);
    register(hook);

    await publishWorktreeGitReady(event);

    expect(hook).toHaveBeenCalledTimes(1);
  });
});
