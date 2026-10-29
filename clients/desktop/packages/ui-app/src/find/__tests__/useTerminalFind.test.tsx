/** @jest-environment jsdom */
import { act, useRef, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PanelVisibilityContext } from '../../code/panels/panel-contexts';
import { useSurfaceFindStore } from '../surface-find-store';
import {
  TERMINAL_FIND_DEBOUNCE_MS,
  useTerminalFind,
  type TerminalFind,
  type TerminalFindEntry,
} from '../useTerminalFind';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

interface ResultsEvent {
  resultIndex: number;
  resultCount: number;
}

const DECORATIONS = {
  matchOverviewRuler: '#111111',
  activeMatchColorOverviewRuler: '#222222',
};

interface FakeEntry {
  entry: TerminalFindEntry;
  findNext: jest.Mock;
  findPrevious: jest.Mock;
  clearDecorations: jest.Mock;
  clearSelection: jest.Mock;
  unsubscribe: jest.Mock;
  emit: (event: ResultsEvent) => void;
}

/**
 * A cached terminal entry whose search addon reports `resultsFor(query)`
 * through `onDidChangeResults`, as the addon does when decorations are set.
 */
function fakeEntry(
  resultsFor: (query: string, step: number) => ResultsEvent = () => ({
    resultIndex: 0,
    resultCount: 3,
  }),
): FakeEntry {
  let listener: ((event: ResultsEvent) => void) | null = null;
  let steps = 0;
  const emit = (event: ResultsEvent): void => listener?.(event);
  const unsubscribe = jest.fn(() => {
    listener = null;
  });
  const findNext = jest.fn((query: string) => {
    emit(resultsFor(query, steps++));
    return true;
  });
  const findPrevious = jest.fn((query: string) => {
    emit(resultsFor(query, steps--));
    return true;
  });
  const clearDecorations = jest.fn();
  const clearSelection = jest.fn();
  const search = {
    findNext,
    findPrevious,
    clearDecorations,
    onDidChangeResults: (
      next: (event: ResultsEvent) => void,
    ): { dispose: () => void } => {
      listener = next;
      return { dispose: unsubscribe };
    },
  };
  const entry: TerminalFindEntry = {
    term: { clearSelection },
    search,
    findShortcutClaimed: false,
    disposed: false,
  };
  return {
    entry,
    findNext,
    findPrevious,
    clearDecorations,
    clearSelection,
    unsubscribe,
    emit,
  };
}

const finds: Record<string, TerminalFind> = {};
const entryRefs: Record<string, { current: TerminalFindEntry | null }> = {};

function Surface({
  enabled,
  entry,
  scopeKey = 'term-1',
  title = 'zsh',
}: {
  enabled: boolean;
  entry: TerminalFindEntry | null;
  scopeKey?: string;
  title?: string;
}): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const entryRef = useRef<TerminalFindEntry | null>(null);
  entryRef.current = entry;
  entryRefs[scopeKey] = entryRef;
  const find = useTerminalFind({
    enabled,
    scopeKey,
    title,
    rootRef,
    entryRef,
    decorations: DECORATIONS,
  });
  finds[scopeKey] = find;
  return <div ref={rootRef} {...find.surfaceProps} />;
}

const store = (): ReturnType<typeof useSurfaceFindStore.getState> =>
  useSurfaceFindStore.getState();
const counts = (
  scopeKey = 'term-1',
): { currentIndex: number; totalCount: number } | undefined =>
  store().controllerStates[`terminal:${scopeKey}`];
const active = (scopeKey = 'term-1'): boolean | undefined =>
  finds[scopeKey]?.activeRef.current;

describe('useTerminalFind', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    jest.useFakeTimers();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    store().close();
    for (const entry of Object.values(store().controllers)) {
      store().unregisterController(entry.controller);
    }
    useSurfaceFindStore.setState({ rememberedQueries: {} });
    host.remove();
    jest.useRealTimers();
  });

  function render(
    enabled: boolean,
    entry: TerminalFindEntry | null,
    title?: string,
  ): void {
    act(() =>
      root.render(<Surface enabled={enabled} entry={entry} title={title} />),
    );
  }

  function type(query: string): void {
    act(() => {
      if (!store().open) store().openFor('terminal', 'term-1');
      store().setQuery(query);
    });
  }

  function search(query: string): void {
    type(query);
    act(() => {
      jest.advanceTimersByTime(TERMINAL_FIND_DEBOUNCE_MS);
    });
  }

  it('registers a titled controller, marks the root, and claims the chord only while enabled', () => {
    const fake = fakeEntry();
    render(false, fake.entry);
    expect(store().hasController('terminal', 'term-1')).toBe(false);
    expect(host.firstElementChild?.getAttributeNames()).toEqual([]);
    expect(fake.entry.findShortcutClaimed).toBe(false);

    render(true, fake.entry);
    expect(store().hasController('terminal', 'term-1')).toBe(true);
    expect(store().controllers['terminal:term-1']?.title).toBe('zsh');
    const surface = host.querySelector('[data-find-surface="terminal"]');
    expect(surface?.getAttribute('data-find-scope')).toBe('term-1');
    expect(surface?.getAttribute('tabindex')).toBe('-1');
    expect(fake.entry.findShortcutClaimed).toBe(true);

    render(true, fake.entry, 'build');
    expect(store().controllers['terminal:term-1']?.title).toBe('build');

    render(false, fake.entry);
    expect(store().hasController('terminal', 'term-1')).toBe(false);
    expect(fake.entry.findShortcutClaimed).toBe(false);
  });

  it('does not register before the terminal entry exists', () => {
    render(true, null);
    expect(store().hasController('terminal', 'term-1')).toBe(false);
  });

  it('unregisters while its panel tab is hidden', () => {
    const fake = fakeEntry();
    const renderIn = (tabVisible: boolean): void => {
      act(() =>
        root.render(
          <PanelVisibilityContext.Provider value={tabVisible}>
            <Surface enabled entry={fake.entry} />
          </PanelVisibilityContext.Provider>,
        ),
      );
    };
    renderIn(true);
    expect(store().hasController('terminal', 'term-1')).toBe(true);
    renderIn(false);
    expect(store().hasController('terminal', 'term-1')).toBe(false);
    expect(fake.entry.findShortcutClaimed).toBe(false);
  });

  it('debounces an incremental, decorated search and reports its counts', () => {
    const fake = fakeEntry(() => ({ resultIndex: 0, resultCount: 3 }));
    render(true, fake.entry);
    type('needle');
    expect(fake.findNext).not.toHaveBeenCalled();
    expect(active()).toBe(false);

    act(() => {
      jest.advanceTimersByTime(TERMINAL_FIND_DEBOUNCE_MS);
    });
    expect(fake.findNext).toHaveBeenCalledTimes(1);
    expect(fake.findNext).toHaveBeenCalledWith('needle', {
      incremental: true,
      decorations: DECORATIONS,
    });
    expect(counts()).toEqual({ currentIndex: 0, totalCount: 3, error: null });
    expect(active()).toBe(true);
  });

  it('clears highlights and selection for a one-character query', () => {
    const fake = fakeEntry();
    render(true, fake.entry);
    search('needle');
    fake.clearDecorations.mockClear();

    type('n');
    expect(fake.clearDecorations).toHaveBeenCalled();
    expect(fake.clearSelection).toHaveBeenCalled();
    expect(counts()).toMatchObject({ currentIndex: 0, totalCount: 0 });
    expect(active()).toBe(false);
    act(() => {
      jest.advanceTimersByTime(TERMINAL_FIND_DEBOUNCE_MS);
    });
    expect(fake.findNext).toHaveBeenCalledTimes(1);
  });

  it('runs a pending search once on Enter instead of stepping past its first match', () => {
    const fake = fakeEntry();
    render(true, fake.entry);
    type('needle');

    act(() => store().next());
    expect(fake.findNext).toHaveBeenCalledTimes(1);
    expect(fake.findNext).toHaveBeenLastCalledWith('needle', {
      incremental: true,
      decorations: DECORATIONS,
    });
    act(() => {
      jest.advanceTimersByTime(TERMINAL_FIND_DEBOUNCE_MS);
    });
    expect(fake.findNext).toHaveBeenCalledTimes(1);
  });

  it('steps forward and back without the incremental flag', () => {
    const fake = fakeEntry((_query, step) => ({
      resultIndex: ((step % 3) + 3) % 3,
      resultCount: 3,
    }));
    render(true, fake.entry);
    search('needle');

    act(() => store().next());
    expect(fake.findNext).toHaveBeenLastCalledWith('needle', {
      decorations: DECORATIONS,
    });
    expect(counts()).toMatchObject({ currentIndex: 1, totalCount: 3 });

    act(() => store().previous());
    expect(fake.findPrevious).toHaveBeenLastCalledWith('needle', {
      decorations: DECORATIONS,
    });
    expect(counts()).toMatchObject({ currentIndex: 2, totalCount: 3 });
  });

  it('maps an unselected result to the first index and does not step with no results', () => {
    const fake = fakeEntry(() => ({ resultIndex: -1, resultCount: 0 }));
    render(true, fake.entry);
    search('missing');
    expect(counts()).toEqual({ currentIndex: 0, totalCount: 0, error: null });

    act(() => store().next());
    act(() => store().previous());
    expect(fake.findNext).toHaveBeenCalledTimes(1);
    expect(fake.findPrevious).not.toHaveBeenCalled();
  });

  it('still steps past the highlight limit, where the addon selects no index', () => {
    const fake = fakeEntry(() => ({ resultIndex: -1, resultCount: 1000 }));
    render(true, fake.entry);
    search('ee');
    expect(counts()).toMatchObject({ currentIndex: 0, totalCount: 1000 });

    act(() => store().next());
    expect(fake.findNext).toHaveBeenCalledTimes(2);
  });

  it('follows live re-searches the addon runs as output arrives', () => {
    const fake = fakeEntry();
    render(true, fake.entry);
    search('needle');

    act(() => fake.emit({ resultIndex: 2, resultCount: 5 }));
    expect(counts()).toMatchObject({ currentIndex: 2, totalCount: 5 });
  });

  it('clears highlights and selection on close', () => {
    const fake = fakeEntry();
    render(true, fake.entry);
    search('needle');

    act(() => store().close());
    expect(fake.clearDecorations).toHaveBeenCalled();
    expect(fake.clearSelection).toHaveBeenCalled();
    expect(counts()).toMatchObject({ currentIndex: 0, totalCount: 0 });
    expect(active()).toBe(false);
  });

  it('ends the find before clearing its selection, so the pane recomputes its pill', () => {
    const fake = fakeEntry();
    const activeAtClear: Array<boolean | undefined> = [];
    fake.clearSelection.mockImplementation(() => {
      activeAtClear.push(active());
    });
    render(true, fake.entry);
    search('needle');

    act(() => store().close());
    expect(activeAtClear).toEqual([false]);
  });

  it('keeps a selection the user made when no search ran', () => {
    const fake = fakeEntry();
    const renderIn = (tabVisible: boolean): void => {
      act(() =>
        root.render(
          <PanelVisibilityContext.Provider value={tabVisible}>
            <Surface enabled entry={fake.entry} />
          </PanelVisibilityContext.Provider>,
        ),
      );
    };
    renderIn(true);
    act(() => store().openFor('terminal', 'term-1'));
    type('n');
    act(() => store().close());
    expect(fake.clearSelection).not.toHaveBeenCalled();

    renderIn(false);
    expect(fake.clearSelection).not.toHaveBeenCalled();
    expect(fake.entry.findShortcutClaimed).toBe(false);
  });

  it('tears down highlights, a pending search, and the claim when hidden', () => {
    const fake = fakeEntry();
    const renderIn = (tabVisible: boolean): void => {
      act(() =>
        root.render(
          <PanelVisibilityContext.Provider value={tabVisible}>
            <Surface enabled entry={fake.entry} />
          </PanelVisibilityContext.Provider>,
        ),
      );
    };
    renderIn(true);
    search('needle');
    type('needles');
    fake.clearDecorations.mockClear();

    renderIn(false);
    expect(fake.clearDecorations).toHaveBeenCalled();
    expect(fake.clearSelection).toHaveBeenCalled();
    expect(fake.unsubscribe).toHaveBeenCalled();
    expect(fake.entry.findShortcutClaimed).toBe(false);
    expect(store().open).toBe(false);
    act(() => {
      jest.advanceTimersByTime(TERMINAL_FIND_DEBOUNCE_MS);
    });
    expect(fake.findNext).toHaveBeenCalledTimes(1);
  });

  it('leaves the claim and highlights to a newer pane that took the terminal over', () => {
    const fake = fakeEntry();
    act(() => root.render(<Surface key="old" enabled entry={fake.entry} />));
    // Old and new panes overlap during navigation: the new one registers
    // before the old one unmounts.
    act(() =>
      root.render(
        <>
          <Surface key="old" enabled entry={fake.entry} />
          <Surface key="new" enabled entry={fake.entry} />
        </>,
      ),
    );
    search('needle');
    fake.clearDecorations.mockClear();

    act(() => root.render(<Surface key="new" enabled entry={fake.entry} />));
    expect(fake.entry.findShortcutClaimed).toBe(true);
    expect(fake.clearDecorations).not.toHaveBeenCalled();
    expect(fake.clearSelection).not.toHaveBeenCalled();
    expect(store().hasController('terminal', 'term-1')).toBe(true);
    expect(counts()).toMatchObject({ currentIndex: 0, totalCount: 3 });
  });

  it('never calls into an entry the cache has dropped', () => {
    const fake = fakeEntry();
    render(true, fake.entry);
    search('needle');
    fake.clearDecorations.mockClear();
    fake.clearSelection.mockClear();
    // The cache disposed the entry (session closed) while the bar is open.
    const ref = entryRefs['term-1'];
    if (!ref) throw new Error('surface not rendered');
    ref.current = null;

    act(() => store().next());
    act(() => fake.emit({ resultIndex: 1, resultCount: 9 }));
    type('other');
    act(() => {
      jest.advanceTimersByTime(TERMINAL_FIND_DEBOUNCE_MS);
    });
    act(() => store().close());

    expect(fake.findNext).toHaveBeenCalledTimes(1);
    expect(fake.findPrevious).not.toHaveBeenCalled();
    expect(fake.clearDecorations).not.toHaveBeenCalled();
    expect(fake.clearSelection).not.toHaveBeenCalled();
    expect(counts()).toMatchObject({ currentIndex: 0, totalCount: 0 });
  });

  it('never calls into an entry the cache disposed under an open bar', () => {
    const fake = fakeEntry();
    render(true, fake.entry);
    search('needle');
    fake.clearDecorations.mockClear();
    fake.clearSelection.mockClear();
    fake.entry.disposed = true;

    act(() => store().next());
    act(() => store().close());
    act(() => root.unmount());
    root = createRoot(host);

    expect(fake.findNext).toHaveBeenCalledTimes(1);
    expect(fake.clearDecorations).not.toHaveBeenCalled();
    expect(fake.clearSelection).not.toHaveBeenCalled();
  });

  it('registers two terminals independently', () => {
    const first = fakeEntry(() => ({ resultIndex: 0, resultCount: 2 }));
    const second = fakeEntry(() => ({ resultIndex: 0, resultCount: 4 }));
    act(() =>
      root.render(
        <>
          <Surface enabled entry={first.entry} scopeKey="term-1" title="a" />
          <Surface enabled entry={second.entry} scopeKey="term-2" title="b" />
        </>,
      ),
    );
    expect(store().hasController('terminal', 'term-1')).toBe(true);
    expect(store().hasController('terminal', 'term-2')).toBe(true);

    act(() => {
      store().openFor('terminal', 'term-2');
      store().setQuery('needle');
    });
    act(() => {
      jest.advanceTimersByTime(TERMINAL_FIND_DEBOUNCE_MS);
    });
    expect(second.findNext).toHaveBeenCalledTimes(1);
    expect(first.findNext).not.toHaveBeenCalled();
    expect(counts('term-2')).toMatchObject({ totalCount: 4 });
  });
});
