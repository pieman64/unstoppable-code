/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStuckAgentTimer } from '../useStuckAgentTimer';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

interface Probe {
  current: number | null;
}

interface HarnessProps {
  probe: Probe;
  isStreaming: boolean;
  lastEventAt: number | undefined;
  tabId: string;
  confirmQuietPeriod?: () => Promise<boolean>;
}

const confirmed = (): Promise<boolean> => Promise.resolve(true);

function Harness({
  probe,
  isStreaming,
  lastEventAt,
  tabId,
  confirmQuietPeriod = confirmed,
}: HarnessProps): JSX.Element {
  probe.current = useStuckAgentTimer(
    isStreaming,
    lastEventAt,
    tabId,
    confirmQuietPeriod,
  );
  return <></>;
}

/** Lets the awaited confirmation settle and commit. */
async function flushConfirmation(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('useStuckAgentTimer', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-31T12:13:00.000Z'));
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('clears immediately when a new agent event arrives', async () => {
    const probe: Probe = { current: null };
    const container = document.createElement('div');
    const root: Root = createRoot(container);
    const staleEventAt = Date.now() - 13 * 60_000;

    act(() => {
      root.render(
        <Harness
          probe={probe}
          isStreaming
          lastEventAt={staleEventAt}
          tabId="chat-1"
        />,
      );
    });
    await flushConfirmation();
    expect(probe.current).toBe(13);

    act(() => {
      root.render(
        <Harness
          probe={probe}
          isStreaming
          lastEventAt={Date.now()}
          tabId="chat-1"
        />,
      );
    });

    expect(probe.current).toBeNull();

    act(() => root.unmount());
  });

  it('shows the warning only after the fresh read confirms the turn', async () => {
    const probe: Probe = { current: null };
    const root: Root = createRoot(document.createElement('div'));
    let resolve: (active: boolean) => void = () => undefined;
    const confirm = jest.fn(
      () =>
        new Promise<boolean>((done) => {
          resolve = done;
        }),
    );

    act(() => {
      root.render(
        <Harness
          probe={probe}
          isStreaming
          lastEventAt={Date.now() - 6 * 60_000}
          tabId="chat-1"
          confirmQuietPeriod={confirm}
        />,
      );
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(probe.current).toBeNull();

    await act(async () => {
      resolve(true);
      await Promise.resolve();
    });
    expect(probe.current).toBe(6);

    // Later polls in the same quiet period do not read again.
    act(() => {
      jest.advanceTimersByTime(60_000);
    });
    expect(probe.current).toBe(7);
    expect(confirm).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
  });

  it.each<[string, () => Promise<boolean>]>([
    ['inactive', (): Promise<boolean> => Promise.resolve(false)],
    ['unknown', (): Promise<boolean> => Promise.reject(new Error('timeout'))],
  ])(
    'keeps the warning hidden when the confirmation is %s',
    async (_label, answer) => {
      const probe: Probe = { current: null };
      const root: Root = createRoot(document.createElement('div'));
      const confirm = jest.fn(answer);

      act(() => {
        root.render(
          <Harness
            probe={probe}
            isStreaming
            lastEventAt={Date.now() - 6 * 60_000}
            tabId="chat-1"
            confirmQuietPeriod={confirm}
          />,
        );
      });
      await flushConfirmation();
      expect(probe.current).toBeNull();

      act(() => {
        jest.advanceTimersByTime(60_000);
      });
      await flushConfirmation();
      expect(probe.current).toBeNull();
      expect(confirm).toHaveBeenCalledTimes(1);

      act(() => root.unmount());
    },
  );

  it('confirms again for a new quiet period', async () => {
    const probe: Probe = { current: null };
    const root: Root = createRoot(document.createElement('div'));
    const confirm = jest
      .fn<Promise<boolean>, []>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const render = (lastEventAt: number): void => {
      act(() => {
        root.render(
          <Harness
            probe={probe}
            isStreaming
            lastEventAt={lastEventAt}
            tabId="chat-1"
            confirmQuietPeriod={confirm}
          />,
        );
      });
    };

    render(Date.now() - 6 * 60_000);
    await flushConfirmation();
    expect(probe.current).toBeNull();

    // An agent event starts a new quiet period; once it is long enough, the
    // hook reads again instead of reusing the earlier answer.
    render(Date.now() - 5 * 60_000);
    await flushConfirmation();
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(probe.current).toBe(5);

    act(() => root.unmount());
  });

  it('keeps a confirmed warning while a newer quiet period of the same tab confirms', async () => {
    const probe: Probe = { current: null };
    const root: Root = createRoot(document.createElement('div'));
    let resolveSecond: (active: boolean) => void = () => undefined;
    const confirm = jest
      .fn<Promise<boolean>, []>()
      .mockResolvedValueOnce(true)
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((done) => {
            resolveSecond = done;
          }),
      );
    const render = (lastEventAt: number, tabId = 'chat-1'): void => {
      act(() => {
        root.render(
          <Harness
            probe={probe}
            isStreaming
            lastEventAt={lastEventAt}
            tabId={tabId}
            confirmQuietPeriod={confirm}
          />,
        );
      });
    };

    render(Date.now() - 7 * 60_000);
    await flushConfirmation();
    expect(probe.current).toBe(7);

    // A runtime write moves lastEventAt while the period stays over the
    // threshold. The warning must not drop (and remount the notice, losing
    // its checked state) while the newer period is confirmed.
    render(Date.now() - 6 * 60_000);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(probe.current).toBe(6);

    await act(async () => {
      resolveSecond(false);
      await Promise.resolve();
    });
    expect(probe.current).toBeNull();

    act(() => root.unmount());
  });

  it('never carries a confirmed warning to another tab', async () => {
    const probe: Probe = { current: null };
    const root: Root = createRoot(document.createElement('div'));
    const confirm = jest
      .fn<Promise<boolean>, []>()
      .mockResolvedValueOnce(true)
      .mockImplementationOnce(() => new Promise<boolean>(() => undefined));
    const render = (tabId: string): void => {
      act(() => {
        root.render(
          <Harness
            probe={probe}
            isStreaming
            lastEventAt={Date.now() - 6 * 60_000}
            tabId={tabId}
            confirmQuietPeriod={confirm}
          />,
        );
      });
    };

    render('chat-1');
    await flushConfirmation();
    expect(probe.current).toBe(6);

    render('chat-2');
    expect(probe.current).toBeNull();

    act(() => root.unmount());
  });

  it('never confirms or warns while the turn does not qualify', async () => {
    const probe: Probe = { current: null };
    const root: Root = createRoot(document.createElement('div'));
    const confirm = jest.fn(confirmed);

    act(() => {
      root.render(
        <Harness
          probe={probe}
          isStreaming={false}
          lastEventAt={Date.now() - 30 * 60_000}
          tabId="chat-1"
          confirmQuietPeriod={confirm}
        />,
      );
    });
    act(() => {
      jest.advanceTimersByTime(60_000);
    });
    await flushConfirmation();
    expect(probe.current).toBeNull();
    expect(confirm).not.toHaveBeenCalled();

    act(() => root.unmount());
  });
});
