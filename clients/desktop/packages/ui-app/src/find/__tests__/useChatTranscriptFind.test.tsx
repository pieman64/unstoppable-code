/** @jest-environment jsdom */
import { act, useRef, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  PanelHostContext,
  PanelVisibilityContext,
} from '../../code/panels/panel-contexts';
import { useSurfaceFindStore } from '../surface-find-store';
import {
  CHAT_FIND_DEBOUNCE_MS,
  useChatTranscriptFind,
} from '../useChatTranscriptFind';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function Surface({
  enabled,
  text,
}: {
  enabled: boolean;
  text: string;
}): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const find = useChatTranscriptFind({
    enabled,
    scopeKey: 'c1',
    title: 'Launch plan',
    rootRef,
  });
  return (
    <div ref={rootRef} {...find.surfaceProps}>
      <style>{find.highlightStyle}</style>
      <div data-testid="chat-transcript">
        <p>{text}</p>
      </div>
    </div>
  );
}

const store = (): ReturnType<typeof useSurfaceFindStore.getState> =>
  useSurfaceFindStore.getState();
const counts = (): { currentIndex: number; totalCount: number } | undefined =>
  store().controllerStates['chat:c1'];

/** jsdom lays nothing out; the executor's visible-only scan needs rects. */
function stubLayoutRects(): () => void {
  const rect = {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 10,
    bottom: 10,
    width: 10,
    height: 10,
    toJSON: (): string => '',
  };
  const rects = (): DOMRectList =>
    Object.assign([rect], {
      item: (): DOMRect => rect,
    });
  const targets: Array<[object, string]> = [
    [Element.prototype, 'getClientRects'],
    [Range.prototype, 'getClientRects'],
    [Range.prototype, 'getBoundingClientRect'],
  ];
  const saved = targets.map(([target, name]) => ({
    target,
    name,
    descriptor: Object.getOwnPropertyDescriptor(target, name),
  }));
  for (const [target, name] of targets) {
    Object.defineProperty(target, name, {
      configurable: true,
      writable: true,
      value: name === 'getBoundingClientRect' ? (): DOMRect => rect : rects,
    });
  }
  return (): void => {
    for (const { target, name, descriptor } of saved) {
      if (descriptor) Object.defineProperty(target, name, descriptor);
      else Reflect.deleteProperty(target, name);
    }
  };
}

describe('useChatTranscriptFind', () => {
  let host: HTMLDivElement;
  let root: Root;
  let restoreRects: () => void;

  beforeEach(() => {
    restoreRects = stubLayoutRects();
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
    restoreRects();
  });

  function render(enabled: boolean, text = 'alpha beta alpha'): void {
    act(() => root.render(<Surface enabled={enabled} text={text} />));
  }

  it('registers a titled chat controller and marks the surface only while enabled', () => {
    render(false);
    expect(store().hasController('chat', 'c1')).toBe(false);
    expect(host.querySelector('[data-find-surface="chat"]')).toBeNull();

    render(true);
    expect(store().hasController('chat', 'c1')).toBe(true);
    expect(store().controllers['chat:c1']?.title).toBe('Launch plan');
    expect(
      host
        .querySelector('[data-find-surface="chat"]')
        ?.getAttribute('data-find-scope'),
    ).toBe('c1');

    render(false);
    expect(store().hasController('chat', 'c1')).toBe(false);
  });

  it('watches the transcript for changes only while a query is active', () => {
    const observe = jest.spyOn(MutationObserver.prototype, 'observe');
    const disconnect = jest.spyOn(MutationObserver.prototype, 'disconnect');
    render(true);
    // Registration alone costs nothing during a transcript render.
    expect(observe).not.toHaveBeenCalled();

    act(() => {
      store().openFor('chat', 'c1');
      store().setQuery('alpha');
      jest.advanceTimersByTime(CHAT_FIND_DEBOUNCE_MS);
    });
    expect(observe).toHaveBeenCalledTimes(1);

    act(() => store().close());
    expect(disconnect).toHaveBeenCalled();
    observe.mockRestore();
    disconnect.mockRestore();
  });

  it('counts matches in the rendered transcript and steps through them', () => {
    render(true);
    act(() => {
      store().openFor('chat', 'c1');
      store().setQuery('alpha');
    });
    act(() => {
      jest.advanceTimersByTime(CHAT_FIND_DEBOUNCE_MS);
    });
    expect(counts()).toMatchObject({ currentIndex: 0, totalCount: 2 });

    act(() => store().next());
    expect(counts()).toMatchObject({ currentIndex: 1, totalCount: 2 });
    act(() => store().next());
    expect(counts()).toMatchObject({ currentIndex: 0, totalCount: 2 });
    act(() => store().previous());
    expect(counts()).toMatchObject({ currentIndex: 1, totalCount: 2 });
  });

  it('lands on the first match when Enter arrives before the debounced scan', () => {
    render(true);
    act(() => {
      store().openFor('chat', 'c1');
      store().setQuery('alpha');
    });
    // Enter inside the debounce window runs the pending scan; it must not
    // also step past the first match.
    act(() => store().next());
    expect(counts()).toMatchObject({ currentIndex: 0, totalCount: 2 });
  });

  it('returns focus to the surface root when the bar closes without an opener', () => {
    render(true);
    const surface = host.querySelector('[data-find-surface="chat"]');
    act(() => store().openFor('chat', 'c1'));
    act(() => store().close());
    expect(document.activeElement).toBe(surface);
  });

  it('unregisters while its panel tab or page host is hidden', () => {
    const renderIn = (hostVisible: boolean, tabVisible: boolean): void => {
      act(() =>
        root.render(
          <PanelHostContext.Provider
            value={{
              viewMode: 'list',
              viewModeReady: true,
              visible: hostVisible,
            }}
          >
            <PanelVisibilityContext.Provider value={tabVisible}>
              <Surface enabled text="alpha" />
            </PanelVisibilityContext.Provider>
          </PanelHostContext.Provider>,
        ),
      );
    };
    renderIn(true, true);
    expect(store().hasController('chat', 'c1')).toBe(true);
    act(() => store().openFor('chat', 'c1'));

    // A shown-then-hidden tab stays mounted behind the active one.
    renderIn(true, false);
    expect(store().hasController('chat', 'c1')).toBe(false);
    expect(store().open).toBe(false);

    renderIn(true, true);
    expect(store().hasController('chat', 'c1')).toBe(true);

    renderIn(false, true);
    expect(store().hasController('chat', 'c1')).toBe(false);
  });

  it('needs two characters and reports nothing for a miss', () => {
    render(true);
    act(() => {
      store().openFor('chat', 'c1');
      store().setQuery('a');
      jest.advanceTimersByTime(CHAT_FIND_DEBOUNCE_MS);
    });
    expect(counts()).toMatchObject({ currentIndex: 0, totalCount: 0 });

    act(() => {
      store().setQuery('zzz');
      jest.advanceTimersByTime(CHAT_FIND_DEBOUNCE_MS);
    });
    expect(counts()).toMatchObject({ currentIndex: 0, totalCount: 0 });
  });

  it('resets the counts when the bar closes', () => {
    render(true);
    act(() => {
      store().openFor('chat', 'c1');
      store().setQuery('beta');
      jest.advanceTimersByTime(CHAT_FIND_DEBOUNCE_MS);
    });
    expect(counts()).toMatchObject({ totalCount: 1 });

    act(() => store().close());
    expect(counts()).toMatchObject({ currentIndex: 0, totalCount: 0 });
  });
});
