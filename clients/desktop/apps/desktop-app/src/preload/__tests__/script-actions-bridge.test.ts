import { createScriptActionsBridge } from '../script-actions-bridge';
it('validates returned snapshots and preserves typed backend failures', async () => {
  const invoke = jest.fn<Promise<unknown>, [string, unknown]>();
  const bridge = createScriptActionsBridge({
    invoke,
    subscribe: (): (() => void) => () => undefined,
  });
  invoke.mockResolvedValue({ ok: true, value: { actions: 'bad' } });
  await expect(
    bridge.list({ projectId: 'p', worktreeId: 'w' }),
  ).rejects.toThrow('Invalid script action response');
  invoke.mockResolvedValue({
    ok: false,
    error: { code: 'stale_revision', message: 'Refresh this action.' },
  });
  await expect(
    bridge.review({
      projectId: 'p',
      worktreeId: 'w',
      entries: [{ id: 'a', revision: 'r' }],
      decision: 'approve',
    }),
  ).rejects.toMatchObject({ code: 'stale_revision' });
});

it('recovers a completed add receipt delivered before the renderer subscribes', () => {
  const listeners = new Map<string, (payload: unknown) => void>();
  const bridge = createScriptActionsBridge({
    invoke: (): Promise<unknown> => Promise.resolve(null),
    subscribe: (channel, listener) => {
      listeners.set(channel, listener);
      return (): void => {
        listeners.delete(channel);
      };
    },
  });
  const receipt = {
    projectId: 'p',
    worktreeId: null,
    operationId: 'add-1',
    repoIds: ['r'],
    status: 'complete',
    pendingCount: 2,
    completedAt: '2026-10-21T00:00:00Z',
  };
  listeners.get('script-actions:found')?.(receipt);
  const received = jest.fn();
  const unsubscribe = bridge.onFound(received);
  expect(received).toHaveBeenCalledWith(receipt);
  unsubscribe();
});
