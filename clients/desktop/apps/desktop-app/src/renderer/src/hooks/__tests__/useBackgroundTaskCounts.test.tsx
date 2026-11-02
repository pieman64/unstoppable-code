/** @jest-environment jsdom */

// A row counts background work that was already running before the renderer
// subscribed: the live-task mirror is push-only, so the hook pulls its rows'
// snapshots (turn-state phase 38a review).
import { act, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { useBackgroundTaskCounts } from '../useBackgroundTaskCounts';
import { resetLiveBackgroundTaskStoreForTests } from '@/stores/liveBackgroundTaskStore';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

function Probe({ ids }: { ids: readonly string[] }): JSX.Element {
  const counts = useBackgroundTaskCounts('project', ids);
  return <span data-testid="count">{counts['entry-1'] ?? 0}</span>;
}

describe('useBackgroundTaskCounts', () => {
  afterEach(() => {
    resetLiveBackgroundTaskStoreForTests();
    Reflect.deleteProperty(window, 'api');
  });

  it('pulls its rows’ live tasks so work that predates the subscription counts', async () => {
    const listLiveBgTasks = jest.fn().mockResolvedValue({
      chats: {
        'chat-1': {
          sessionActive: true,
          liveTasks: [{ taskId: 'server', taskType: 'local_bash' }],
        },
      },
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { activity: { listLiveBgTasks } },
    });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<Probe ids={['entry-1']} />);
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(listLiveBgTasks).toHaveBeenCalledWith({
      projectId: 'project',
      worktreeId: 'entry-1',
    });
    expect(host.textContent).toBe('1');
    act(() => root.unmount());
    host.remove();
  });
});
