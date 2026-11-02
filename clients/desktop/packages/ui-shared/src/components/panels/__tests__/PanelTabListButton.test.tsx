/**
 * @jest-environment jsdom
 */
// The ⌄ button after a fill tab strip and its list of every tab.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PanelTabModel } from '../../../panels/registry-types';
import { PanelTabListButton } from '../PanelTabListButton';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

function tabs(count: number): PanelTabModel[] {
  return Array.from({ length: count }, (_, index) => ({
    panelId: `panel-${index + 1}`,
    kind: 'chat',
    title: index === 4 ? 'Release notes' : `Chat ${index + 1}`,
  }));
}

describe('PanelTabListButton', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    // jsdom has no layout; the list scrolls its highlighted row into view.
    Element.prototype.scrollIntoView = jest.fn();
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function render(
    overrides: Partial<Parameters<typeof PanelTabListButton>[0]> = {},
  ): { onSelectTab: jest.Mock; onCloseTab: jest.Mock } {
    const onSelectTab = jest.fn();
    const onCloseTab = jest.fn();
    act(() => {
      root.render(
        <PanelTabListButton
          groupId="group-1"
          tabs={tabs(12)}
          activePanelId="panel-3"
          onSelectTab={onSelectTab}
          onCloseTab={onCloseTab}
          renderIcon={(_tab, position) => (
            <span data-testid="row-number">{position}</span>
          )}
          renderLabel={(tab) => tab.title}
          renderTrailing={(tab) =>
            tab.panelId === 'panel-2' ? <span data-testid="row-dot" /> : null
          }
          getTitle={(tab) => tab.title}
          {...overrides}
        />,
      );
    });
    return { onSelectTab, onCloseTab };
  }

  function open(): void {
    act(() => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="panel-tab-list-group-1"]',
        )
        ?.click();
    });
  }

  /** Each row's group (it carries the highlight and the end slot). */
  function rows(): HTMLElement[] {
    return Array.from(
      document.querySelectorAll<HTMLElement>('.canopy-panel-tab-list-row'),
    );
  }

  /** Each row's shared menu option (the `option` role and test id). */
  function options(): HTMLElement[] {
    return Array.from(
      document.querySelectorAll<HTMLElement>(
        '.canopy-panel-tab-list-row [role="option"]',
      ),
    );
  }

  function search(): HTMLInputElement {
    const input = document.querySelector(
      '[data-testid="panel-tab-list-search-group-1"]',
    );
    if (!(input instanceof HTMLInputElement)) {
      throw new Error('search field not rendered');
    }
    return input;
  }

  function type(value: string): void {
    const input = search();
    act(() => {
      // Through the prototype's setter, so React sees a real change.
      Reflect.set(HTMLInputElement.prototype, 'value', value, input);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  function key(name: string): void {
    act(() => {
      search().dispatchEvent(
        new KeyboardEvent('keydown', { key: name, bubbles: true }),
      );
    });
  }

  it('lists every tab with its number and title, starting on the selected one', () => {
    render();
    const button = document.querySelector(
      '[data-testid="panel-tab-list-group-1"]',
    );
    expect(button?.getAttribute('aria-expanded')).toBe('false');
    open();
    expect(button?.getAttribute('aria-expanded')).toBe('true');
    expect(rows().map((row) => row.textContent)).toEqual(
      tabs(12).map((tab, index) => `${index + 1}${tab.title}`),
    );
    const selected = options().filter(
      (option) => option.getAttribute('aria-selected') === 'true',
    );
    expect(selected.map((option) => option.dataset.testid)).toEqual([
      'panel-tab-list-row-panel-3',
    ]);
    expect(
      selected[0]?.closest<HTMLElement>('.canopy-panel-tab-list-row')?.dataset
        .highlighted,
    ).toBe('true');
  });

  it('draws each row as the shared menu row, its corners nested in the menu', () => {
    render();
    open();
    const option = options()[0];
    // The shared PickerMenuOption recipe: 8px corners, 4px inside the 12px
    // menu, on the row and its group alike.
    expect(option?.classList.contains('canopy-picker-menu-option')).toBe(true);
    expect(option?.classList.contains('rounded-md')).toBe(true);
    expect(
      option
        ?.closest('.canopy-panel-tab-list-row')
        ?.classList.contains('rounded-md'),
    ).toBe(true);
  });

  it('keeps the dot and the close button in one slot at the end of each row', () => {
    render();
    open();
    const row = document
      .querySelector('[data-testid="panel-tab-list-row-panel-2"]')
      ?.closest('.canopy-panel-tab-list-row');
    const end = row?.lastElementChild;
    expect(end?.className).toBe('canopy-panel-tab-list-end');
    expect(end?.querySelector('[data-testid="row-dot"]')).toBeInstanceOf(
      Element,
    );
    expect(
      end?.querySelector('[data-testid="panel-tab-list-close-panel-2"]'),
    ).toBeInstanceOf(Element);
  });

  it('offers no close button for a tab that cannot close', () => {
    render({ canCloseTab: (tab) => tab.panelId !== 'panel-1' });
    open();
    expect(
      document.querySelector('[data-testid="panel-tab-list-close-panel-1"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="panel-tab-list-close-panel-2"]'),
    ).toBeInstanceOf(Element);
  });

  it('closes a tab from its row and stays open, with typing still in the search', () => {
    const { onSelectTab, onCloseTab } = render();
    open();
    const close = document.querySelector<HTMLButtonElement>(
      '[data-testid="panel-tab-list-close-panel-5"]',
    );
    const pointerDown = new MouseEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      close?.dispatchEvent(pointerDown);
      close?.click();
    });
    // Pressing the button does not take focus from the search field.
    expect(pointerDown.defaultPrevented).toBe(true);
    expect(onCloseTab).toHaveBeenCalledWith('group-1', 'panel-5');
    expect(onSelectTab).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(12);
  });

  it('searches a long list, and Enter opens the highlighted match', () => {
    const { onSelectTab } = render();
    open();
    expect(search().placeholder).toBe('Search 12 tabs');
    type('release');
    expect(options().map((option) => option.dataset.testid)).toEqual([
      'panel-tab-list-row-panel-5',
    ]);
    key('Enter');
    expect(onSelectTab).toHaveBeenCalledWith('group-1', 'panel-5');
    expect(rows()).toHaveLength(0);
  });

  it('moves the highlight with the arrow keys, wrapping at the ends', () => {
    const { onSelectTab } = render({ activePanelId: 'panel-12' });
    open();
    key('ArrowDown');
    expect(
      rows()
        .find((row) => row.dataset.highlighted === 'true')
        ?.querySelector<HTMLElement>('[role="option"]')?.dataset.testid,
    ).toBe('panel-tab-list-row-panel-1');
    key('ArrowUp');
    key('ArrowUp');
    key('Enter');
    expect(onSelectTab).toHaveBeenCalledWith('group-1', 'panel-11');
    // The list's focus returns to the ⌄ button.
    expect(document.activeElement).toBe(
      document.querySelector('[data-testid="panel-tab-list-group-1"]'),
    );
  });

  it('clears the search with the shared clear button, never a native one', () => {
    render();
    open();
    // Still a search field; the shared base rule keeps the browser's own
    // clear control from drawing (panel-tab-crowding.css.test.ts).
    expect(search().type).toBe('search');
    type('release');
    const clear = document.querySelector<HTMLButtonElement>(
      '[aria-label="Clear search"]',
    );
    expect(clear).toBeInstanceOf(HTMLButtonElement);
    act(() => {
      clear?.click();
    });
    expect(search().value).toBe('');
    expect(rows()).toHaveLength(12);
    expect(document.querySelector('[aria-label="Clear search"]')).toBeNull();
  });

  it('takes focus into a short list, so its keys select a tab', async () => {
    const { onSelectTab } = render({ tabs: tabs(5), activePanelId: 'panel-1' });
    open();
    // Focus lands in the list (no search field to take it).
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    const list = document.querySelector<HTMLElement>('[role="listbox"]');
    expect(document.activeElement).toBe(list);
    act(() => {
      list?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      );
    });
    act(() => {
      list?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    expect(onSelectTab).toHaveBeenCalledWith('group-1', 'panel-2');
  });

  it('keeps the search field through closes that shorten the list', () => {
    render({ tabs: tabs(9) });
    open();
    type('chat');
    // Closing a tab drops the list to 8, below the search threshold.
    render({ tabs: tabs(9).filter((tab) => tab.panelId !== 'panel-9') });
    expect(search().value).toBe('chat');
    expect(rows()).toHaveLength(7);
  });

  it('sets up an arrow-key opening like a click: search, selected tab', async () => {
    render();
    const button = document.querySelector<HTMLButtonElement>(
      '[data-testid="panel-tab-list-group-1"]',
    );
    act(() => {
      button?.focus();
      button?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(search().placeholder).toBe('Search 12 tabs');
    expect(
      rows()
        .find((row) => row.dataset.highlighted === 'true')
        ?.querySelector<HTMLElement>('[role="option"]')?.dataset.testid,
    ).toBe('panel-tab-list-row-panel-3');
  });

  it('moves the highlight to the new last row when the last one closes', () => {
    render({ activePanelId: 'panel-12' });
    open();
    // Closing tab 12 (highlighted) leaves 11 rows.
    const { onSelectTab } = render({
      tabs: tabs(11),
      activePanelId: 'panel-11',
    });
    expect(
      rows()
        .find((row) => row.dataset.highlighted === 'true')
        ?.querySelector<HTMLElement>('[role="option"]')?.dataset.testid,
    ).toBe('panel-tab-list-row-panel-11');
    key('Enter');
    expect(onSelectTab).toHaveBeenCalledWith('group-1', 'panel-11');
    // The list's focus returns to the ⌄ button.
    expect(document.activeElement).toBe(
      document.querySelector('[data-testid="panel-tab-list-group-1"]'),
    );
  });

  it('leaves Enter and arrows to an IME composition in the search', () => {
    const { onSelectTab } = render();
    open();
    const highlighted = (): string | undefined =>
      rows()
        .find((row) => row.dataset.highlighted === 'true')
        ?.querySelector<HTMLElement>('[role="option"]')?.dataset.testid;
    const before = highlighted();
    act(() => {
      for (const name of ['ArrowDown', 'Enter']) {
        search().dispatchEvent(
          new KeyboardEvent('keydown', {
            key: name,
            bubbles: true,
            isComposing: true,
          }),
        );
      }
    });
    expect(onSelectTab).not.toHaveBeenCalled();
    expect(highlighted()).toBe(before);
    expect(rows()).toHaveLength(12);
  });

  it('marks the current tab with the checkmark in the row status slot', () => {
    render();
    open();
    const checks = Array.from(
      document.querySelectorAll('[data-testid^="panel-tab-list-check-"]'),
    );
    expect(checks).toHaveLength(1);
    expect(checks[0]?.closest('.canopy-panel-tab-list-end')).not.toBeNull();
    expect(
      checks[0]
        ?.closest<HTMLElement>('.canopy-panel-tab-list-row')
        ?.querySelector<HTMLElement>('[role="option"]')?.dataset.testid,
    ).toBe('panel-tab-list-row-panel-3');
    expect(rows().some((row) => row.classList.contains('bg-muted'))).toBe(
      false,
    );
  });

  it('stays shown while its list is open, even once the tabs fit', () => {
    render({ hidden: false });
    open();
    // The tabs fit again (say a tab was closed from the list): ⌄ keeps its
    // place until the list closes, so the list never loses its anchor.
    render({ hidden: true });
    const root = document.querySelector<HTMLElement>(
      '[data-testid="panel-tab-list-root-group-1"]',
    );
    expect(root?.dataset.hidden).toBeUndefined();
    // Once the list closes, ⌄ hides.
    act(() => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="panel-tab-list-group-1"]',
        )
        ?.click();
    });
    expect(root?.dataset.hidden).toBeDefined();
  });

  it('reveals the selected row again once the menu has settled', () => {
    // The test runs the frames itself, so the late reveal never races a
    // real-time wait on a loaded runner.
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    const requestFrame = jest
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        frames.set(++nextFrame, callback);
        return nextFrame;
      });
    const cancelFrame = jest
      .spyOn(window, 'cancelAnimationFrame')
      .mockImplementation((id) => {
        frames.delete(id);
      });
    try {
      render({ tabs: tabs(30), activePanelId: 'panel-30' });
      const reveal = jest.spyOn(Element.prototype, 'scrollIntoView');
      reveal.mockClear();
      open();
      const isLastRow = (call: unknown): boolean =>
        call instanceof HTMLElement && call.dataset.index === '29';
      const calls = (): number =>
        reveal.mock.contexts.filter((context) => isLastRow(context)).length;
      const first = calls();
      expect(first).toBeGreaterThan(0);
      // After the menu's own placement frames: run each frame, and any it
      // schedules, until none are left.
      // A frame cancelled earlier in its round is skipped, as a browser would.
      for (let round = 0; frames.size > 0 && round < 10; round += 1) {
        const due = Array.from(frames.entries());
        act(() => {
          for (const [id, callback] of due) {
            if (!frames.delete(id)) continue;
            callback(round * 16);
          }
        });
      }
      expect(frames.size).toBe(0);
      expect(calls()).toBeGreaterThan(first);
      // Unmount while the stubs are still in place, so the effect's cleanup
      // cancels through the fake queue rather than jsdom's real one.
      act(() => {
        root.unmount();
      });
    } finally {
      requestFrame.mockRestore();
      cancelFrame.mockRestore();
    }
  });

  it('names the highlighted row for screen readers as the arrows move', () => {
    render();
    open();
    const highlightedId = (): string | undefined =>
      rows()
        .find((row) => row.dataset.highlighted === 'true')
        ?.querySelector<HTMLElement>('[role="option"]')?.id;
    expect(search().getAttribute('aria-activedescendant')).toBe(
      highlightedId(),
    );
    key('ArrowDown');
    const id = highlightedId();
    expect(id).toBeTruthy();
    expect(search().getAttribute('aria-activedescendant')).toBe(id);
    expect(document.getElementById(id ?? '')?.dataset.testid).toBe(
      'panel-tab-list-row-panel-4',
    );
    expect(search().getAttribute('aria-controls')).toBe(
      document.querySelector('[role="listbox"]')?.id,
    );
  });

  it('says so when nothing matches', () => {
    render();
    open();
    type('zzz');
    expect(rows()).toHaveLength(0);
    expect(
      document.querySelector('.canopy-panel-tab-list-empty')?.textContent,
    ).toBe('No matching tabs');
  });

  it('leaves out the search field for a short list', () => {
    render({ tabs: tabs(8) });
    open();
    expect(
      document.querySelector('[data-testid="panel-tab-list-search-group-1"]'),
    ).toBeNull();
    expect(rows()).toHaveLength(8);
  });
});
