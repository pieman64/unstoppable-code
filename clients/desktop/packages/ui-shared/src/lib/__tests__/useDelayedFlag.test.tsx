/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  LOADING_PLACEHOLDER_DELAY_MS,
  useDelayedFlag,
} from '../useDelayedFlag';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  jest.useFakeTimers();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  jest.useRealTimers();
});

function Probe({
  value,
  delayMs = LOADING_PLACEHOLDER_DELAY_MS,
}: {
  readonly value: boolean;
  readonly delayMs?: number;
}): JSX.Element {
  return <output>{String(useDelayedFlag(value, delayMs))}</output>;
}

function render(value: boolean, delayMs?: number): void {
  act(() => {
    root.render(<Probe value={value} delayMs={delayMs} />);
  });
}

function flag(): string | null | undefined {
  return container.querySelector('output')?.textContent;
}

function advance(ms: number): void {
  act(() => {
    jest.advanceTimersByTime(ms);
  });
}

describe('useDelayedFlag', () => {
  it('uses the 200ms placeholder delay', () => {
    expect(LOADING_PLACEHOLDER_DELAY_MS).toBe(200);
  });

  it('flips only after the value has held for the delay', () => {
    render(true);
    expect(flag()).toBe('false');
    advance(LOADING_PLACEHOLDER_DELAY_MS - 1);
    expect(flag()).toBe('false');
    advance(1);
    expect(flag()).toBe('true');
  });

  it('resets as soon as the value goes false, and waits the delay again', () => {
    render(true);
    advance(LOADING_PLACEHOLDER_DELAY_MS);
    expect(flag()).toBe('true');

    render(false);
    expect(flag()).toBe('false');

    render(true);
    expect(flag()).toBe('false');
    advance(LOADING_PLACEHOLDER_DELAY_MS - 1);
    expect(flag()).toBe('false');
    advance(1);
    expect(flag()).toBe('true');
  });

  it('never flips when the value goes false before the delay', () => {
    render(true);
    advance(LOADING_PLACEHOLDER_DELAY_MS - 50);
    render(false);
    expect(jest.getTimerCount()).toBe(0);
    advance(LOADING_PLACEHOLDER_DELAY_MS * 5);
    expect(flag()).toBe('false');
  });

  it('never flips while the value is false', () => {
    render(false);
    advance(LOADING_PLACEHOLDER_DELAY_MS * 5);
    expect(flag()).toBe('false');
    expect(jest.getTimerCount()).toBe(0);
  });
});
