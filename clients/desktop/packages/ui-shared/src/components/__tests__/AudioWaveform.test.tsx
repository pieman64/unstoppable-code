/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AudioWaveform } from '../AudioWaveform';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

class TestResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

describe('AudioWaveform', () => {
  let container: HTMLDivElement;
  let root: Root;
  const originalResizeObserver = globalThis.ResizeObserver;
  const clientWidth = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'clientWidth',
  );

  beforeEach(() => {
    jest.useFakeTimers();
    globalThis.ResizeObserver = TestResizeObserver;
    // 30px of room: ten 3px slots (1px bar + 2px gap).
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => 30,
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    jest.useRealTimers();
    globalThis.ResizeObserver = originalResizeObserver;
    if (clientWidth) {
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', clientWidth);
    }
  });

  function bars(): HTMLElement[] {
    return Array.from(
      container.querySelectorAll<HTMLElement>('[data-waveform-bar]'),
    );
  }

  it('fills its width with quiet bars before any sound', () => {
    act(() => {
      root.render(<AudioWaveform readLevel={(): number => 0} />);
    });
    expect(bars()).toHaveLength(10);
    expect(bars().every((bar) => bar.dataset.waveformBar === 'quiet')).toBe(
      true,
    );
  });

  it('polls the level and scrolls the newest sample in on the right', () => {
    const levels = [0.9, 0];
    const readLevel = jest.fn((): number => levels.shift() ?? 0);
    act(() => {
      root.render(<AudioWaveform readLevel={readLevel} sampleMs={100} />);
    });
    act(() => {
      jest.advanceTimersByTime(100);
    });
    expect(readLevel).toHaveBeenCalledTimes(1);
    expect(bars().at(-1)?.dataset.waveformBar).toBe('speech');
    // The envelope eases down, so silence reads as quiet a sample later.
    act(() => {
      jest.advanceTimersByTime(200);
    });
    expect(bars().at(-3)?.dataset.waveformBar).toBe('speech');
    expect(bars().at(-1)?.dataset.waveformBar).toBe('quiet');
  });

  it('stays still while paused', () => {
    const readLevel = jest.fn((): number => 1);
    act(() => {
      root.render(
        <AudioWaveform readLevel={readLevel} sampleMs={100} paused />,
      );
    });
    act(() => {
      jest.advanceTimersByTime(500);
    });
    expect(readLevel).not.toHaveBeenCalled();
  });
});
