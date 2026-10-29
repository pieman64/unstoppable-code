import { dispatchDelegationReadAction } from '../app-advisor/delegation-read-actions';
const mockTree = jest.fn();
const mockRoots = jest.fn();
const mockTranscript = jest.fn();
const mockSummary = jest.fn();
jest.mock('../agents/delegation/service', () => ({
  readManagedDelegationTreeForUser: (...args: unknown[]): unknown =>
    mockTree(...args),
  readManagedDelegationRootsForUser: (...args: unknown[]): unknown =>
    mockRoots(...args),
  readManagedDelegationTranscriptForUser: (...args: unknown[]): unknown =>
    mockTranscript(...args),
  readManagedDelegationWorktreeSummaryForUser: (...args: unknown[]): unknown =>
    mockSummary(...args),
}));
const target = { projectId: 'project', worktreeId: 'worktree', chatId: 'chat' };
beforeEach(() => jest.clearAllMocks());
describe('App Advisor delegation reads', () => {
  it('dispatches trees and roots in main without a renderer or live turn', async () => {
    mockTree.mockResolvedValueOnce([
      { description: 'Review', snapshot: { phase: 'queued' } },
    ]);
    expect(
      await dispatchDelegationReadAction({
        type: 'delegation.tree',
        ...target,
      }),
    ).toMatchObject({ ok: true, result: [{ description: 'Review' }] });
    mockRoots.mockResolvedValueOnce([
      { chatId: 'chat', total: 1, live: 0, lastActivityAt: 1 },
    ]);
    expect(
      await dispatchDelegationReadAction({
        type: 'delegation.roots',
        ...target,
      }),
    ).toMatchObject({ ok: true, result: [{ total: 1 }] });
  });
  it('preserves transcript not_found authorization and bounds', async () => {
    mockTranscript.mockResolvedValueOnce({
      ok: false,
      code: 'not_found',
      error: 'Not found',
    });
    expect(
      await dispatchDelegationReadAction({
        type: 'delegation.transcript',
        ...target,
        delegationId: 'foreign',
        limit: 100,
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_target' } });
  });
  it('forwards the requested run of a transcript', async () => {
    mockTranscript.mockResolvedValueOnce({
      ok: true,
      task: {
        description: 'Task',
        prompt: 'Prompt',
        executionMode: 'background',
      },
      runGeneration: 1,
      items: [],
      hasMore: false,
    });
    await dispatchDelegationReadAction({
      type: 'delegation.transcript',
      ...target,
      delegationId: 'child',
      runGeneration: 1,
    });
    expect(mockTranscript).toHaveBeenLastCalledWith(
      expect.objectContaining({ delegationId: 'child', runGeneration: 1 }),
    );
  });
  it('forwards summary revision and a timeout signal', async () => {
    mockSummary.mockResolvedValueOnce({
      delegationId: 'child',
      checkout: 'retained',
      startingRevision: 'a'.repeat(40),
      topFiles: [],
    });
    expect(
      await dispatchDelegationReadAction({
        type: 'delegation.worktree_summary',
        ...target,
        delegationId: 'child',
        revision: 'a'.repeat(40),
      }),
    ).toMatchObject({ ok: true, result: { checkout: 'retained' } });
    expect(mockSummary).toHaveBeenCalledWith(
      { projectId: target.projectId, worktreeId: target.worktreeId },
      'child',
      'a'.repeat(40),
      expect.any(AbortSignal),
    );
  });
  it('rejects unsafe targets before service reads and sanitizes failures', async () => {
    expect(
      await dispatchDelegationReadAction({
        type: 'delegation.tree',
        ...target,
        chatId: '../chat',
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_target' } });
    expect(mockTree).not.toHaveBeenCalled();
    mockTree.mockRejectedValueOnce(new Error('/private/path'));
    expect(
      await dispatchDelegationReadAction({
        type: 'delegation.tree',
        ...target,
      }),
    ).toEqual({
      ok: false,
      error: {
        code: 'execution_failed',
        message: "Couldn't read the delegation.",
      },
    });
  });
});
