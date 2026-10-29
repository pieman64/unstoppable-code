/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { useResumeQueueStore } from '@/stores/resumeQueueStore';
import { useUsageLimitedSessionCount } from '../useUsageLimitedSessionCount';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function CountProbe({
  onCount,
}: {
  onCount: (count: number) => void;
}): JSX.Element {
  onCount(useUsageLimitedSessionCount('claude', 1));
  return <></>;
}

describe('useUsageLimitedSessionCount', () => {
  it('refreshes after the asynchronous resume queue clears the registry', async () => {
    let registryCount = 1;
    const listUsageLimitedIdleSessions = jest.fn(() =>
      Promise.resolve([
        { sessions: Array.from({ length: registryCount }, () => ({})) },
      ]),
    );
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { listUsageLimitedIdleSessions },
    });
    const counts: number[] = [];
    const root = createRoot(document.createElement('div'));

    try {
      await act(async () => {
        root.render(<CountProbe onCount={(count) => counts.push(count)} />);
        await Promise.resolve();
      });
      expect(counts.at(-1)).toBe(1);

      registryCount = 0;
      await act(async () => {
        useResumeQueueStore.getState().apply({
          version: 1,
          revision: 1,
          paused: false,
          entries: [],
        });
        await Promise.resolve();
      });

      expect(listUsageLimitedIdleSessions).toHaveBeenCalledTimes(2);
      expect(counts.at(-1)).toBe(0);
    } finally {
      act(() => root.unmount());
      useResumeQueueStore.setState({ snapshot: null, isOpen: false });
      Reflect.deleteProperty(window, 'api');
    }
  });
});
