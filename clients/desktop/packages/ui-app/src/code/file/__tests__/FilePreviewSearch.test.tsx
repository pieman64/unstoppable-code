/** @jest-environment jsdom */
import { act, useContext, useRef, type ContextType, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useSurfaceFindStore } from '../../../find/surface-find-store';
import { useFilePreviewFindController } from '../../../find/useFilePreviewFindController';
import {
  FilePreviewSearch,
  PreviewSearchContext,
  type PreviewSearchControlled,
  type PreviewSearchState,
} from '../FilePreviewSearch';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const executor = {
  findMatches: jest.fn<number, [string]>(() => 3),
  clearHighlights: jest.fn(),
  setActiveMatch: jest.fn(),
  scrollToMatch: jest.fn(),
};

jest.mock('@canopy/ui-shared/lib/dom-search-highlight', () => ({
  createDomSearchExecutor: (): typeof executor => executor,
}));

let context: ContextType<typeof PreviewSearchContext> = null;
function ContextProbe(): JSX.Element {
  context = useContext(PreviewSearchContext);
  return <p>preview text</p>;
}

describe('FilePreviewSearch', () => {
  let host: HTMLDivElement;
  let root: Root;
  let states: PreviewSearchState[];

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    states = [];
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    jest.useRealTimers();
  });

  function render(
    props: {
      presentation?: 'inline' | 'headless';
      controlled?: PreviewSearchControlled;
      onSearchRequest?: (operation: 'open' | 'close') => void;
      remote?: boolean;
      resetKey?: string;
    } = {},
  ): void {
    act(() => {
      root.render(
        <FilePreviewSearch
          enabled
          remote={props.remote ?? false}
          resetKey={props.resetKey}
          searchShortcutActive
          header={null}
          presentation={props.presentation}
          controlled={props.controlled}
          onSearchRequest={props.onSearchRequest}
          onStateChange={(state) => states.push(state)}
        >
          <ContextProbe />
        </FilePreviewSearch>,
      );
    });
  }

  function pressCmdF(target: EventTarget): KeyboardEvent {
    const event = new KeyboardEvent('keydown', {
      key: 'f',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  }

  const drawer = (): Element | null =>
    host.querySelector('[data-testid="file-preview-search-drawer"]');
  const viewer = (): Element => {
    const element = host.querySelector('[data-testid="file-viewer"]');
    if (!element) throw new Error('file viewer missing');
    return element;
  };

  it('keeps the inline drawer and its Cmd+F by default', () => {
    render();
    const event = pressCmdF(viewer());

    expect(event.defaultPrevented).toBe(true);
    expect(drawer()).not.toBeNull();
  });

  it('renders no drawer and ignores Cmd+F when headless', () => {
    render({ presentation: 'headless' });
    const event = pressCmdF(viewer());

    expect(event.defaultPrevented).toBe(false);
    expect(drawer()).toBeNull();
  });

  it('closes search on a view change while keeping its root mounted', () => {
    render({ resetKey: 'preview' });
    const originalViewer = viewer();
    pressCmdF(originalViewer);
    expect(drawer()).not.toBeNull();

    render({ resetKey: 'raw' });
    expect(viewer()).toBe(originalViewer);
    expect(drawer()).toBeNull();
    expect(executor.clearHighlights).toHaveBeenCalled();
    expect(states.at(-1)).toMatchObject({
      open: false,
      totalCount: 0,
      currentIndex: 0,
    });

    pressCmdF(viewer());
    expect(drawer()).not.toBeNull();
    render({ resetKey: 'preview' });
    expect(drawer()).toBeNull();
  });

  it('drives highlights and reported state from the controlled search', () => {
    render({
      presentation: 'headless',
      controlled: { open: true, query: 'needle', index: 0 },
    });
    act(() => {
      jest.advanceTimersByTime(150);
    });

    expect(executor.findMatches).toHaveBeenLastCalledWith('needle');
    expect(executor.setActiveMatch).toHaveBeenLastCalledWith(0);
    expect(states.at(-1)).toEqual({
      enabled: true,
      open: true,
      queryPresent: true,
      currentIndex: 0,
      totalCount: 3,
    });

    render({
      presentation: 'headless',
      controlled: { open: true, query: 'needle', index: 2 },
    });
    expect(executor.setActiveMatch).toHaveBeenLastCalledWith(2);
    expect(states.at(-1)?.currentIndex).toBe(2);

    render({
      presentation: 'headless',
      controlled: { open: false, query: 'needle', index: 2 },
    });
    act(() => {
      jest.advanceTimersByTime(150);
    });
    expect(executor.clearHighlights).toHaveBeenCalled();
    expect(states.at(-1)).toMatchObject({ open: false, totalCount: 0 });
  });

  it('clamps a controlled index that is past the last match', () => {
    render({
      presentation: 'headless',
      controlled: { open: true, query: 'needle', index: 5 },
    });
    act(() => {
      jest.advanceTimersByTime(150);
    });

    expect(executor.setActiveMatch).toHaveBeenLastCalledWith(0);
    expect(executor.setActiveMatch).not.toHaveBeenCalledWith(5);
    expect(states.at(-1)).toMatchObject({ currentIndex: 0, totalCount: 3 });
  });

  it('shares the controlled query with a remote preview and forwards its requests', () => {
    const onSearchRequest = jest.fn();
    render({
      presentation: 'headless',
      remote: true,
      controlled: { open: true, query: 'needle', index: 1 },
      onSearchRequest,
    });

    expect(context?.query).toBe('needle');
    expect(context?.index).toBe(1);
    act(() => context?.report('needle', 4));
    expect(states.at(-1)?.totalCount).toBe(4);

    act(() => context?.open());
    act(() => context?.close());
    expect(onSearchRequest.mock.calls).toEqual([['open'], ['close']]);
    expect(executor.findMatches).not.toHaveBeenCalled();
  });

  it('reports no matches for a query it has not scanned yet', () => {
    render({
      presentation: 'headless',
      controlled: { open: true, query: 'needle', index: 0 },
    });
    act(() => {
      jest.advanceTimersByTime(150);
    });
    expect(states.at(-1)?.totalCount).toBe(3);

    render({
      presentation: 'headless',
      controlled: { open: true, query: 'other', index: 0 },
    });
    expect(states.at(-1)).toMatchObject({ queryPresent: true, totalCount: 0 });
  });

  it('shows the first match of a new query when the find bar steps before the scan', () => {
    function FindBarPreview(): JSX.Element {
      const rootRef = useRef<HTMLDivElement>(null);
      const find = useFilePreviewFindController({
        enabled: true,
        scopeKey: 'tab-1',
        title: 'README.md',
        rootRef,
      });
      return (
        <div ref={rootRef} {...find.surfaceProps}>
          <FilePreviewSearch
            enabled
            remote={false}
            searchShortcutActive
            header={null}
            presentation="headless"
            controlled={find.viewerProps.previewSearchControlled}
            onStateChange={find.viewerProps.onPreviewSearchStateChange}
          >
            <p>preview text</p>
          </FilePreviewSearch>
        </div>
      );
    }
    const store = useSurfaceFindStore.getState;
    act(() => root.render(<FindBarPreview />));
    act(() => store().openFor('file', 'tab-1'));
    act(() => store().setQuery('needle'));
    act(() => {
      jest.advanceTimersByTime(150);
    });
    expect(store().controllerStates['file:tab-1']?.totalCount).toBe(3);

    // A new query, then Enter inside the preview's scan debounce.
    act(() => store().setQuery('other'));
    act(() => store().next());
    act(() => {
      jest.advanceTimersByTime(150);
    });

    expect(executor.findMatches).toHaveBeenLastCalledWith('other');
    expect(executor.setActiveMatch).toHaveBeenLastCalledWith(0);
    expect(store().controllerStates['file:tab-1']).toMatchObject({
      currentIndex: 0,
      totalCount: 3,
    });
    act(() => store().close());
  });
});
