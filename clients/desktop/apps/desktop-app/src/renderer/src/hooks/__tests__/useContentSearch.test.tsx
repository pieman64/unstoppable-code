/**
 * @jest-environment jsdom
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useContentSearch } from '../useContentSearch';
import type { SearchExecutor } from '@/components/shared/search/search-types';

interface HookProbe {
  current: ReturnType<typeof useContentSearch> | null;
}

function makeExecutor(matchCount: number): jest.Mocked<SearchExecutor> {
  return {
    findMatches: jest.fn().mockReturnValue(matchCount),
    clearHighlights: jest.fn(),
    setActiveMatch: jest.fn(),
    scrollToMatch: jest.fn(),
  };
}

function HookHarness({
  probe,
  executor,
}: {
  probe: HookProbe;
  executor: SearchExecutor;
}): null {
  const executorRef = useRef<SearchExecutor | null>(executor);
  executorRef.current = executor;
  probe.current = useContentSearch(executorRef);
  return null;
}

describe('useContentSearch refresh (highlight restore on refocus)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let probe: HookProbe;

  beforeEach(() => {
    jest.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    probe = { current: null };
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    jest.useRealTimers();
  });

  function mount(executor: SearchExecutor): void {
    act(() => {
      root.render(<HookHarness probe={probe} executor={executor} />);
    });
  }

  function runQuery(query: string): void {
    act(() => probe.current?.setQuery(query));
    act(() => {
      jest.advanceTimersByTime(150);
    });
  }

  it('re-runs the current query and restores the active match without scrolling', () => {
    const executor = makeExecutor(3);
    mount(executor);
    runQuery('foo');

    // Advance to a non-first match, then simulate a sibling clobbering us.
    act(() => probe.current?.goToNext());
    expect(probe.current?.currentIndex).toBe(1);
    executor.findMatches.mockClear();
    executor.setActiveMatch.mockClear();
    executor.scrollToMatch.mockClear();

    act(() => probe.current?.refresh());

    expect(executor.findMatches).toHaveBeenCalledWith('foo');
    // Preserves the current position (index 1), does not reset to 0.
    expect(probe.current?.currentIndex).toBe(1);
    expect(executor.setActiveMatch).toHaveBeenCalledWith(1);
    // Refocus restores highlights in place — it must not scroll the view.
    expect(executor.scrollToMatch).not.toHaveBeenCalled();
  });

  it('falls back to the first match when the prior index is now out of range', () => {
    const executor = makeExecutor(5);
    mount(executor);
    runQuery('bar');
    act(() => probe.current?.goToNext());
    act(() => probe.current?.goToNext());
    expect(probe.current?.currentIndex).toBe(2);

    // Transcript changed while unfocused: fewer matches on re-run.
    executor.findMatches.mockReturnValue(1);
    act(() => probe.current?.refresh());

    expect(probe.current?.totalCount).toBe(1);
    expect(probe.current?.currentIndex).toBe(0);
    expect(executor.setActiveMatch).toHaveBeenLastCalledWith(0);
  });

  it('is a no-op below the minimum query length', () => {
    const executor = makeExecutor(0);
    mount(executor);
    runQuery('x');
    executor.findMatches.mockClear();

    act(() => probe.current?.refresh());

    expect(executor.findMatches).not.toHaveBeenCalled();
  });

  it('cancels a pending debounced search when refresh re-applies the query', () => {
    const executor = makeExecutor(2);
    mount(executor);

    act(() => probe.current?.setQuery('foo'));
    act(() => probe.current?.refresh());
    executor.scrollToMatch.mockClear();

    act(() => {
      jest.advanceTimersByTime(150);
    });

    expect(executor.findMatches).toHaveBeenCalledTimes(1);
    expect(executor.scrollToMatch).not.toHaveBeenCalled();
  });
});
