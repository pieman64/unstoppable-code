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
}

function Harness({
  probe,
  isStreaming,
  lastEventAt,
  tabId,
}: HarnessProps): JSX.Element {
  probe.current = useStuckAgentTimer(isStreaming, lastEventAt, tabId);
  return <></>;
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

  it('clears immediately when a new agent event arrives', () => {
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
});
