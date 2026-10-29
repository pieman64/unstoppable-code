import type { CanopyApi } from '@canopy/desktop-shared/types';
import { useProjectsStore } from '@/stores/projectsStore';

declare global {
  interface Window {
    api: CanopyApi;
  }
}

beforeAll(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { api: {} },
  });
});

afterAll(() => {
  Reflect.deleteProperty(globalThis, 'window');
});

describe('projectsStore pendingScrollToWorktree', () => {
  beforeEach(() => {
    useProjectsStore.setState({ pendingScrollToWorktree: null });
  });

  it('defaults to null', () => {
    expect(useProjectsStore.getState().pendingScrollToWorktree).toBeNull();
  });

  it('requestScrollToWorktree defaults to the selected reason', () => {
    useProjectsStore.getState().requestScrollToWorktree('project-1', 'wt-1');

    expect(useProjectsStore.getState().pendingScrollToWorktree).toEqual({
      projectId: 'project-1',
      worktreeId: 'wt-1',
      reason: 'selected',
    });
  });

  it('requestScrollToWorktree records an explicit reason', () => {
    useProjectsStore
      .getState()
      .requestScrollToWorktree('project-1', 'wt-2', 'created');

    expect(useProjectsStore.getState().pendingScrollToWorktree).toEqual({
      projectId: 'project-1',
      worktreeId: 'wt-2',
      reason: 'created',
    });
  });

  it('does not let a follow-up selection downgrade a created scroll', () => {
    useProjectsStore
      .getState()
      .requestScrollToWorktree('project-1', 'wt-4', 'created');
    // Creation flows call selectWorktree (default reason) right after.
    useProjectsStore.getState().requestScrollToWorktree('project-1', 'wt-4');

    expect(useProjectsStore.getState().pendingScrollToWorktree).toEqual({
      projectId: 'project-1',
      worktreeId: 'wt-4',
      reason: 'created',
    });
  });

  it('a selection for a different worktree still replaces the signal', () => {
    useProjectsStore
      .getState()
      .requestScrollToWorktree('project-1', 'wt-4', 'created');
    useProjectsStore.getState().requestScrollToWorktree('project-1', 'wt-5');

    expect(useProjectsStore.getState().pendingScrollToWorktree).toEqual({
      projectId: 'project-1',
      worktreeId: 'wt-5',
      reason: 'selected',
    });
  });

  it('a selection for the same worktree id in another project replaces the signal', () => {
    useProjectsStore
      .getState()
      .requestScrollToWorktree('project-1', 'bluejay', 'created');
    useProjectsStore.getState().requestScrollToWorktree('project-2', 'bluejay');

    expect(useProjectsStore.getState().pendingScrollToWorktree).toEqual({
      projectId: 'project-2',
      worktreeId: 'bluejay',
      reason: 'selected',
    });
  });

  it('clearPendingScrollToWorktree resets the signal', () => {
    useProjectsStore.getState().requestScrollToWorktree('project-1', 'wt-3');
    useProjectsStore.getState().clearPendingScrollToWorktree();

    expect(useProjectsStore.getState().pendingScrollToWorktree).toBeNull();
  });
});
