/** @jest-environment jsdom */
import { act, useRef, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PanelVisibilityContext } from '../../code/panels/panel-contexts';
import { useSurfaceFindStore } from '../surface-find-store';
import {
  DOM_TEXT_FIND_DEBOUNCE_MS,
  DOM_TEXT_FIND_MIN_LENGTH,
  useDomTextFind,
} from '../useDomTextFind';
import {
  CHAT_FIND_DEBOUNCE_MS,
  CHAT_FIND_MIN_LENGTH,
} from '../useChatTranscriptFind';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

class TestHighlight extends Set<Range> {}

const CONTENT_SELECTOR = '[data-testid="plan-explore-plan-panel"]';

function PlanSurface({
  enabled,
  title = 'Roadmap',
}: {
  enabled: boolean;
  title?: string;
}): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const find = useDomTextFind({
    mode: 'plan',
    enabled,
    scopeKey: 'p/w/plan-1',
    title,
    rootRef,
    contentSelector: CONTENT_SELECTOR,
  });
  return (
    <div ref={rootRef} {...find.surfaceProps}>
      <style>{find.highlightStyle}</style>
      <div data-testid="plan-explore-plan-panel">
        <p>baseline alpha alpha</p>
      </div>
      <aside data-testid="plan-explore-comments-tray">
        <p>alpha in a comment</p>
      </aside>
    </div>
  );
}

const store = (): ReturnType<typeof useSurfaceFindStore.getState> =>
  useSurfaceFindStore.getState();
const counts = (): { currentIndex: number; totalCount: number } | undefined =>
  store().controllerStates['plan:p/w/plan-1'];

let registry = new Map<string, TestHighlight>();
const highlights = (): Map<string, TestHighlight> => registry;

describe('useDomTextFind', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    // jsdom lays nothing out; scrolling to a match measures its range.
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      writable: true,
      value: (): DOMRect => DOMRect.fromRect({ width: 10, height: 10 }),
    });
    registry = new Map<string, TestHighlight>();
    Object.assign(window, {
      Highlight: TestHighlight,
      CSS: { highlights: registry },
    });
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
    Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect');
  });

  function render(enabled: boolean, title?: string): void {
    act(() => root.render(<PlanSurface enabled={enabled} title={title} />));
  }

  function search(query: string): void {
    act(() => {
      store().openFor('plan', 'p/w/plan-1');
      store().setQuery(query);
    });
    act(() => {
      jest.advanceTimersByTime(DOM_TEXT_FIND_DEBOUNCE_MS);
    });
  }

  it('keeps the chat constants as aliases', () => {
    expect(CHAT_FIND_DEBOUNCE_MS).toBe(DOM_TEXT_FIND_DEBOUNCE_MS);
    expect(CHAT_FIND_MIN_LENGTH).toBe(DOM_TEXT_FIND_MIN_LENGTH);
  });

  it('registers a titled plan controller and marks the root only while enabled', () => {
    render(false);
    expect(store().hasController('plan', 'p/w/plan-1')).toBe(false);
    expect(host.querySelector('[data-find-surface]')).toBeNull();

    render(true);
    expect(store().controllers['plan:p/w/plan-1']?.title).toBe('Roadmap');
    const surface = host.querySelector('[data-find-surface="plan"]');
    expect(surface?.getAttribute('data-find-scope')).toBe('p/w/plan-1');
    expect(surface?.getAttribute('tabindex')).toBe('-1');

    render(true, 'Roadmap v2');
    expect(store().controllers['plan:p/w/plan-1']?.title).toBe('Roadmap v2');

    render(false);
    expect(store().hasController('plan', 'p/w/plan-1')).toBe(false);
  });

  it('adds no highlight rules until a search runs', () => {
    // A stylesheet's rules invalidate styles across the document when they
    // are added, so a panel that is never searched must not pay for them.
    render(true);
    expect(host.querySelector('style')?.textContent).toBe('');

    search('alpha');
    expect(host.querySelector('style')?.textContent).toContain('::highlight(');
  });

  it('searches only the content element, under plan-prefixed highlight names', () => {
    render(true);
    search('alpha');

    // Two in the document; the comments tray's match is out of scope.
    expect(counts()).toMatchObject({ currentIndex: 0, totalCount: 2 });
    const names = Array.from(highlights().keys());
    expect(names).toHaveLength(2);
    expect(names.every((name) => name.startsWith('plan-find-'))).toBe(true);
    const matches = names.find((name) => name.startsWith('plan-find-matches-'));
    expect(matches === undefined ? 0 : highlights().get(matches)?.size).toBe(2);
    expect(host.querySelector('style')?.textContent).toContain(
      `::highlight(${matches ?? ''})`,
    );

    act(() => store().next());
    expect(counts()).toMatchObject({ currentIndex: 1, totalCount: 2 });
  });

  it('re-scans for changes to the searched content, not the rest of the panel', async () => {
    render(true);
    search('alpha');
    const walks = jest.spyOn(document, 'createTreeWalker');
    const settle = async (): Promise<void> => {
      // Let the observer deliver, then run the scheduled frame.
      await act(async () => {
        await Promise.resolve();
        jest.advanceTimersByTime(32);
      });
    };

    host
      .querySelector('[data-testid="plan-explore-comments-tray"]')
      ?.append(document.createTextNode(' alpha again'));
    await settle();
    expect(walks).not.toHaveBeenCalled();

    host
      .querySelector(CONTENT_SELECTOR)
      ?.append(document.createTextNode(' alpha'));
    await settle();
    expect(walks).toHaveBeenCalled();
    expect(counts()).toMatchObject({ totalCount: 3 });
    walks.mockRestore();
  });

  it('clears its highlights when disabled with a query active', () => {
    render(true);
    search('alpha');
    expect(highlights().size).toBe(2);

    render(false);
    expect(highlights().size).toBe(0);
    expect(store().hasController('plan', 'p/w/plan-1')).toBe(false);
  });

  it('cancels a pending scan when disabled', () => {
    render(true);
    act(() => {
      store().openFor('plan', 'p/w/plan-1');
      store().setQuery('alpha');
    });
    render(false);
    act(() => {
      jest.advanceTimersByTime(DOM_TEXT_FIND_DEBOUNCE_MS);
    });
    expect(highlights().size).toBe(0);
  });

  it('unregisters while its panel tab is hidden', () => {
    const renderIn = (tabVisible: boolean): void => {
      act(() =>
        root.render(
          <PanelVisibilityContext.Provider value={tabVisible}>
            <PlanSurface enabled />
          </PanelVisibilityContext.Provider>,
        ),
      );
    };
    renderIn(true);
    expect(store().hasController('plan', 'p/w/plan-1')).toBe(true);
    renderIn(false);
    expect(store().hasController('plan', 'p/w/plan-1')).toBe(false);
  });
});
