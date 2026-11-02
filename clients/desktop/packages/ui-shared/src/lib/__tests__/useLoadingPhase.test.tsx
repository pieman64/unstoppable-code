/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  LOADING_PLACEHOLDER_DELAY_MS,
  SLOW_LOAD_NOTE_DELAY_MS,
  useLoadingPhase,
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

function Probe({ loading }: { readonly loading: boolean }): JSX.Element {
  return <output>{useLoadingPhase(loading)}</output>;
}

function render(loading: boolean): void {
  act(() => {
    root.render(<Probe loading={loading} />);
  });
}

function phase(): string | null | undefined {
  return container.querySelector('output')?.textContent;
}

function advance(ms: number): void {
  act(() => {
    jest.advanceTimersByTime(ms);
  });
}

describe('useLoadingPhase', () => {
  it('waits 200ms for the skeleton and 8s for the note', () => {
    expect(LOADING_PLACEHOLDER_DELAY_MS).toBe(200);
    expect(SLOW_LOAD_NOTE_DELAY_MS).toBe(8_000);
  });

  it('is idle while nothing loads', () => {
    render(false);
    advance(SLOW_LOAD_NOTE_DELAY_MS * 2);
    expect(phase()).toBe('idle');
  });

  it('shows nothing, then the skeleton, then the note', () => {
    render(true);
    expect(phase()).toBe('pending');
    advance(LOADING_PLACEHOLDER_DELAY_MS - 1);
    expect(phase()).toBe('pending');
    advance(1);
    expect(phase()).toBe('skeleton');
    advance(SLOW_LOAD_NOTE_DELAY_MS - LOADING_PLACEHOLDER_DELAY_MS - 1);
    expect(phase()).toBe('skeleton');
    advance(1);
    expect(phase()).toBe('slow');
  });

  it('never flashes for a load that ends inside the delay', () => {
    render(true);
    advance(LOADING_PLACEHOLDER_DELAY_MS - 50);
    render(false);
    advance(SLOW_LOAD_NOTE_DELAY_MS);
    expect(phase()).toBe('idle');
  });

  it('starts both clocks again for the next load', () => {
    render(true);
    advance(SLOW_LOAD_NOTE_DELAY_MS);
    expect(phase()).toBe('slow');
    render(false);
    expect(phase()).toBe('idle');
    render(true);
    expect(phase()).toBe('pending');
    advance(LOADING_PLACEHOLDER_DELAY_MS);
    expect(phase()).toBe('skeleton');
  });
});
