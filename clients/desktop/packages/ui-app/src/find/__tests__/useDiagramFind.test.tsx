/** @jest-environment jsdom */
import { act, useRef, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PanelVisibilityContext } from '../../code/panels/panel-contexts';
import type { DiagramSearchHandle } from '../diagram-search-handle';
import { useSurfaceFindStore } from '../surface-find-store';
import {
  DIAGRAM_FIND_DEBOUNCE_MS,
  useDiagramFind,
  type DiagramFind,
} from '../useDiagramFind';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

interface FakeHandle extends DiagramSearchHandle {
  search: jest.Mock<string[], [string]>;
  reveal: jest.Mock<void, [string]>;
  clear: jest.Mock<void, []>;
}

function fakeHandle(nodes: readonly string[]): FakeHandle {
  return {
    search: jest.fn<string[], [string]>((query) =>
      nodes.filter((node) => node.includes(query.trim())),
    ),
    reveal: jest.fn<void, [string]>(),
    clear: jest.fn<void, []>(),
  };
}

let latest: DiagramFind | null = null;

function Surface({
  enabled,
  handle,
  title = 'Roadmap (Diagram)',
}: {
  enabled: boolean;
  handle: DiagramSearchHandle | null;
  title?: string;
}): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<DiagramSearchHandle | null>(null);
  handleRef.current = handle;
  const find = useDiagramFind({
    enabled,
    scopeKey: 'p/w',
    title,
    rootRef,
    handleRef,
  });
  latest = find;
  return <div ref={rootRef} {...find.surfaceProps} />;
}

const store = (): ReturnType<typeof useSurfaceFindStore.getState> =>
  useSurfaceFindStore.getState();
const counts = (): { currentIndex: number; totalCount: number } | undefined =>
  store().controllerStates['diagram:p/w'];

function refresh(): void {
  if (!latest) throw new Error('surface not rendered');
  latest.refresh();
}

describe('useDiagramFind', () => {
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
    latest = null;
  });

  function render(
    enabled: boolean,
    handle: DiagramSearchHandle | null,
    title?: string,
  ): void {
    act(() =>
      root.render(<Surface enabled={enabled} handle={handle} title={title} />),
    );
  }

  function search(query: string): void {
    act(() => {
      store().openFor('diagram', 'p/w');
      store().setQuery(query);
    });
    act(() => {
      jest.advanceTimersByTime(DIAGRAM_FIND_DEBOUNCE_MS);
    });
  }

  it('registers a titled diagram controller and marks the root only while enabled', () => {
    render(false, fakeHandle([]));
    expect(store().hasController('diagram', 'p/w')).toBe(false);
    expect(host.firstElementChild?.getAttributeNames()).toEqual([]);

    render(true, fakeHandle([]));
    expect(store().hasController('diagram', 'p/w')).toBe(true);
    expect(store().controllers['diagram:p/w']?.title).toBe('Roadmap (Diagram)');
    const surface = host.querySelector('[data-find-surface="diagram"]');
    expect(surface?.getAttribute('data-find-scope')).toBe('p/w');
    expect(surface?.getAttribute('tabindex')).toBe('-1');

    render(true, fakeHandle([]), 'Renamed (Diagram)');
    expect(store().controllers['diagram:p/w']?.title).toBe('Renamed (Diagram)');

    render(false, fakeHandle([]));
    expect(store().hasController('diagram', 'p/w')).toBe(false);
  });

  it('unregisters while its panel tab is hidden', () => {
    const renderIn = (tabVisible: boolean): void => {
      act(() =>
        root.render(
          <PanelVisibilityContext.Provider value={tabVisible}>
            <Surface enabled handle={fakeHandle([])} />
          </PanelVisibilityContext.Provider>,
        ),
      );
    };
    renderIn(true);
    expect(store().hasController('diagram', 'p/w')).toBe(true);
    renderIn(false);
    expect(store().hasController('diagram', 'p/w')).toBe(false);
  });

  it('debounces, reveals the first match, and reports counts', () => {
    const handle = fakeHandle(['task-1', 'task-2', 'other']);
    render(true, handle);
    act(() => {
      store().openFor('diagram', 'p/w');
      store().setQuery('task');
    });
    expect(handle.search).not.toHaveBeenCalled();

    act(() => {
      jest.advanceTimersByTime(DIAGRAM_FIND_DEBOUNCE_MS);
    });
    expect(handle.search).toHaveBeenCalledWith('task');
    expect(handle.reveal).toHaveBeenLastCalledWith('task-1');
    expect(counts()).toMatchObject({ currentIndex: 0, totalCount: 2 });
  });

  it('needs two characters and clears below that', () => {
    const handle = fakeHandle(['task-1']);
    render(true, handle);
    search('t ');
    expect(handle.search).not.toHaveBeenCalled();
    expect(handle.clear).toHaveBeenCalled();
    expect(counts()).toMatchObject({ currentIndex: 0, totalCount: 0 });

    search('zz');
    expect(handle.search).toHaveBeenCalledWith('zz');
    expect(counts()).toMatchObject({ currentIndex: 0, totalCount: 0 });
  });

  it('wraps next and previous, revealing each match', () => {
    const handle = fakeHandle(['task-1', 'task-2']);
    render(true, handle);
    search('task');

    act(() => store().next());
    expect(counts()).toMatchObject({ currentIndex: 1, totalCount: 2 });
    expect(handle.reveal).toHaveBeenLastCalledWith('task-2');
    act(() => store().next());
    expect(counts()).toMatchObject({ currentIndex: 0, totalCount: 2 });
    expect(handle.reveal).toHaveBeenLastCalledWith('task-1');
    act(() => store().previous());
    expect(counts()).toMatchObject({ currentIndex: 1, totalCount: 2 });
    expect(handle.reveal).toHaveBeenLastCalledWith('task-2');
  });

  it('lands on the first match when Enter arrives before the debounced scan', () => {
    const handle = fakeHandle(['task-1', 'task-2']);
    render(true, handle);
    act(() => {
      store().openFor('diagram', 'p/w');
      store().setQuery('task');
    });
    act(() => store().next());
    expect(counts()).toMatchObject({ currentIndex: 0, totalCount: 2 });
    expect(handle.reveal).toHaveBeenLastCalledWith('task-1');

    act(() => {
      jest.advanceTimersByTime(DIAGRAM_FIND_DEBOUNCE_MS);
    });
    expect(handle.search).toHaveBeenCalledTimes(1);
  });

  it('refreshes in place, keeping the active node while it still matches', () => {
    const nodes = ['task-1', 'task-2', 'task-3'];
    const handle = fakeHandle(nodes);
    render(true, handle);
    search('task');
    act(() => store().next());
    act(() => store().next());
    expect(counts()).toMatchObject({ currentIndex: 2, totalCount: 3 });

    act(() => refresh());
    expect(counts()).toMatchObject({ currentIndex: 2, totalCount: 3 });
    expect(handle.reveal).toHaveBeenLastCalledWith('task-3');

    // The same diagram gained a match ahead of the active node.
    handle.search.mockReturnValue(['task-0', 'task-1', 'task-2', 'task-3']);
    act(() => refresh());
    expect(counts()).toMatchObject({ currentIndex: 3, totalCount: 4 });
    expect(handle.reveal).toHaveBeenLastCalledWith('task-3');
  });

  it('starts from the first match when the refresh shows another diagram', () => {
    const handle = fakeHandle(['task-1', 'task-2', 'task-3']);
    render(true, handle);
    search('task');
    act(() => store().next());
    act(() => store().next());
    expect(counts()).toMatchObject({ currentIndex: 2, totalCount: 3 });

    // Another diagram, with as many matches but none of the same nodes.
    handle.search.mockReturnValue(['task-a', 'task-b', 'task-c']);
    act(() => refresh());
    expect(counts()).toMatchObject({ currentIndex: 0, totalCount: 3 });
    expect(handle.reveal).toHaveBeenLastCalledWith('task-a');

    handle.search.mockReturnValue(['task-x']);
    act(() => refresh());
    expect(counts()).toMatchObject({ currentIndex: 0, totalCount: 1 });
    expect(handle.reveal).toHaveBeenLastCalledWith('task-x');
  });

  it('starts from the first match on another diagram even when node ids repeat', () => {
    const sequence = fakeHandle(['task-api', 'task-auth', 'task-db']);
    render(true, sequence);
    search('task');
    act(() => store().next());
    expect(counts()).toMatchObject({ currentIndex: 1, totalCount: 3 });

    // The host shows another diagram (a new handle) that shares node ids.
    const logic = fakeHandle(['task-db', 'task-auth']);
    render(true, logic);
    act(() => refresh());
    expect(counts()).toMatchObject({ currentIndex: 0, totalCount: 2 });
    expect(logic.reveal).toHaveBeenLastCalledWith('task-db');
  });

  it('reports nothing until the handle attaches, then counts on the next refresh', () => {
    render(true, null);
    search('task');
    expect(counts()).toMatchObject({ currentIndex: 0, totalCount: 0 });

    const handle = fakeHandle(['task-1', 'task-2']);
    render(true, handle);
    act(() => refresh());
    expect(counts()).toMatchObject({ currentIndex: 0, totalCount: 2 });
  });

  it('does nothing on refresh without an active query', () => {
    const handle = fakeHandle(['task-1']);
    render(true, handle);
    act(() => refresh());
    expect(handle.search).not.toHaveBeenCalled();
    expect(handle.clear).not.toHaveBeenCalled();
  });

  it('keeps refresh referentially stable across renders', () => {
    render(true, fakeHandle([]));
    const first = latest?.refresh;
    render(true, fakeHandle(['task-1']), 'Other');
    render(false, fakeHandle([]));
    expect(latest?.refresh).toBe(first);
  });

  it('clears the outlines and counts when the bar closes', () => {
    const handle = fakeHandle(['task-1']);
    render(true, handle);
    search('task');
    handle.clear.mockClear();

    act(() => store().close());
    expect(handle.clear).toHaveBeenCalledTimes(1);
    expect(counts()).toMatchObject({ currentIndex: 0, totalCount: 0 });

    act(() => refresh());
    expect(handle.search).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending scan and clears when disabled', () => {
    const handle = fakeHandle(['task-1']);
    render(true, handle);
    act(() => {
      store().openFor('diagram', 'p/w');
      store().setQuery('task');
    });
    render(false, handle);
    expect(handle.clear).toHaveBeenCalled();
    act(() => {
      jest.advanceTimersByTime(DIAGRAM_FIND_DEBOUNCE_MS);
    });
    expect(handle.search).not.toHaveBeenCalled();
    expect(store().hasController('diagram', 'p/w')).toBe(false);
  });

  it('unmounts without a handle', () => {
    render(true, null);
    search('task');
    expect(() => act(() => root.render(<></>))).not.toThrow();
    expect(store().hasController('diagram', 'p/w')).toBe(false);
  });
});
