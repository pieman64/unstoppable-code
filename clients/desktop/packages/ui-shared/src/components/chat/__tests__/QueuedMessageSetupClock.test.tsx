/** @jest-environment jsdom */
import { act, StrictMode, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  formatSetupClock,
  QueuedMessageSetupClock,
  readSetupClock,
  resetSetupTickerForTests,
  setupTickerStateForTests,
} from '../QueuedMessageSetupClock';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  value: true,
  configurable: true,
});

describe('formatSetupClock', () => {
  it.each([
    [0, '0:00'],
    [999, '0:00'],
    [1_000, '0:01'],
    [12_000, '0:12'],
    [59_999, '0:59'],
    [60_000, '1:00'],
    [65_000, '1:05'],
    [3_600_000, '60:00'],
    [4_500_000, '75:00'],
    [-5_000, '0:00'],
  ])('formats %d ms as %s', (ms, text) => {
    expect(formatSetupClock(ms)).toBe(text);
  });
});

describe('readSetupClock', () => {
  it('reads elapsed time without an estimate', () => {
    expect(readSetupClock({ startedAtMs: 1_000 }, 13_000)).toEqual({
      kind: 'elapsed',
      text: '0:12 elapsed',
      spoken: '12 seconds elapsed',
    });
  });

  it('clamps a start in the future to zero', () => {
    expect(readSetupClock({ startedAtMs: 20_000 }, 10_000)?.text).toBe(
      '0:00 elapsed',
    );
  });

  it('counts the estimate down, rounded up to five seconds', () => {
    const wait = { startedAtMs: 0, estimateMs: 25_000 };
    expect(readSetupClock(wait, 10_000)?.text).toBe('about 0:15 left');
    expect(readSetupClock(wait, 10_001)?.text).toBe('about 0:15 left');
    expect(readSetupClock(wait, 14_999)?.text).toBe('about 0:15 left');
    expect(readSetupClock(wait, 15_000)?.text).toBe('about 0:10 left');
    expect(readSetupClock(wait, 24_999)?.text).toBe('about 0:05 left');
    expect(readSetupClock(wait, 10_000)?.spoken).toBe('About 15 seconds left');
  });

  it('switches to elapsed time exactly when the estimate runs out', () => {
    const wait = { startedAtMs: 0, estimateMs: 25_000 };
    expect(readSetupClock(wait, 25_000)).toMatchObject({
      kind: 'elapsed',
      text: '0:25 elapsed',
    });
    expect(readSetupClock(wait, 90_000)?.text).toBe('1:30 elapsed');
  });

  it('ignores an invalid estimate and keeps the elapsed time', () => {
    for (const estimateMs of [0, -1, Number.NaN, Infinity]) {
      expect(readSetupClock({ startedAtMs: 0, estimateMs }, 5_000)?.text).toBe(
        '0:05 elapsed',
      );
    }
  });

  it('reads nothing without a valid start or now', () => {
    expect(readSetupClock({ startedAtMs: Number.NaN }, 5_000)).toBeNull();
    expect(readSetupClock({ startedAtMs: 0 }, Number.NaN)).toBeNull();
  });

  it('speaks minutes and seconds', () => {
    expect(readSetupClock({ startedAtMs: 0 }, 65_000)?.spoken).toBe(
      '1 minute 5 seconds elapsed',
    );
    expect(readSetupClock({ startedAtMs: 0 }, 120_000)?.spoken).toBe(
      '2 minutes elapsed',
    );
  });
});

describe('QueuedMessageSetupClock', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(100_000);
    resetSetupTickerForTests();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    jest.useRealTimers();
  });

  function clockText(index = 0): string | null | undefined {
    return container
      .querySelectorAll('[data-testid="queued-message-setup-clock"]')
      .item(index)
      ?.querySelector('[aria-hidden="true"]')?.textContent;
  }

  it('renders a fixed reading without starting the ticker', () => {
    act(() =>
      root.render(<QueuedMessageSetupClock startedAtMs={0} nowMs={12_000} />),
    );
    expect(clockText()).toBe('0:12 elapsed');
    expect(setupTickerStateForTests().running).toBe(false);
    act(() => jest.advanceTimersByTime(5_000));
    expect(clockText()).toBe('0:12 elapsed');
  });

  it('shares one ticker between clocks and stops it after the last', () => {
    act(() =>
      root.render(
        <>
          <QueuedMessageSetupClock startedAtMs={88_000} />
          <QueuedMessageSetupClock startedAtMs={95_000} estimateMs={30_000} />
        </>,
      ),
    );
    expect(setupTickerStateForTests()).toEqual({
      running: true,
      subscribers: 2,
    });
    expect(clockText(0)).toBe('0:12 elapsed');
    expect(clockText(1)).toBe('about 0:25 left');

    act(() => jest.advanceTimersByTime(3_000));
    expect(clockText(0)).toBe('0:15 elapsed');

    act(() => root.render(<QueuedMessageSetupClock startedAtMs={88_000} />));
    expect(setupTickerStateForTests().subscribers).toBe(1);
    act(() => root.render(<></>));
    expect(setupTickerStateForTests()).toEqual({
      running: false,
      subscribers: 0,
    });
  });

  it('cleans up under Strict Mode', () => {
    act(() =>
      root.render(
        <StrictMode>
          <QueuedMessageSetupClock startedAtMs={88_000} />
        </StrictMode>,
      ),
    );
    expect(setupTickerStateForTests().subscribers).toBe(1);
    act(() => root.render(<StrictMode />));
    expect(setupTickerStateForTests().running).toBe(false);
  });

  it('catches up from the wall clock after a throttled background stretch', () => {
    act(() => root.render(<QueuedMessageSetupClock startedAtMs={100_000} />));
    // A background window can skip ticks; the next one reads the real time.
    act(() => {
      jest.setSystemTime(190_000);
      jest.advanceTimersByTime(1_000);
    });
    expect(clockText()).toBe('1:31 elapsed');
  });

  it('never moves backward or restarts a finished countdown', () => {
    act(() =>
      root.render(
        <QueuedMessageSetupClock startedAtMs={90_000} estimateMs={15_000} />,
      ),
    );
    expect(clockText()).toBe('about 0:05 left');
    act(() => jest.advanceTimersByTime(6_000));
    expect(clockText()).toBe('0:16 elapsed');
    // The system clock jumps back a minute.
    act(() => {
      jest.setSystemTime(50_000);
      jest.advanceTimersByTime(1_000);
    });
    expect(clockText()).toBe('0:16 elapsed');
  });

  it('renders a stable server snapshot', () => {
    expect(
      renderToStaticMarkup(<QueuedMessageSetupClock startedAtMs={0} />),
    ).toContain('0:00 elapsed');
  });

  it('starts an unrelated later wait from the current wall clock', () => {
    act(() => root.render(<QueuedMessageSetupClock startedAtMs={90_000} />));
    act(() => root.render(<></>));
    jest.setSystemTime(50_000);
    act(() => root.render(<QueuedMessageSetupClock startedAtMs={49_000} />));
    expect(clockText()).toBe('0:01 elapsed');
  });

  it('updates only the clock child on ticks', () => {
    const rendered = jest.fn();
    function Parent(): JSX.Element {
      rendered();
      return <QueuedMessageSetupClock startedAtMs={90_000} />;
    }
    act(() => root.render(<Parent />));
    const before = rendered.mock.calls.length;
    act(() => jest.advanceTimersByTime(5_000));
    expect(clockText()).toBe('0:15 elapsed');
    expect(rendered).toHaveBeenCalledTimes(before);
    act(() => root.render(<></>));
    expect(jest.getTimerCount()).toBe(0);
  });
});
