/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TabBar, type TabBarItem, type TabBarProps } from '../TabBar';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  value: true,
  configurable: true,
});

type Id = 'one' | 'two' | 'three';

const ITEMS: readonly TabBarItem<Id>[] = [
  { id: 'one', label: 'One', dataTestId: 'tab-one', tabId: 'el-one' },
  {
    id: 'two',
    label: 'Two',
    dataTestId: 'tab-two',
    tabId: 'el-two',
    count: 4,
    countTestId: 'tab-two-count',
  },
  {
    id: 'three',
    label: 'Three',
    dataTestId: 'tab-three',
    tabId: 'el-three',
    count: 0,
    countTestId: 'tab-three-count',
  },
];

describe('TabBar', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(props: Partial<TabBarProps<Id>> = {}): jest.Mock {
    const onChange = jest.fn();
    act(() => {
      root.render(
        <TabBar
          items={ITEMS}
          value="two"
          onChange={onChange}
          label="Sections"
          panelId="sections-panel"
          {...props}
        />,
      );
    });
    return onChange;
  }

  function tab(id: Id): HTMLButtonElement {
    const element = container.querySelector(`[data-testid="tab-${id}"]`);
    if (!(element instanceof HTMLButtonElement)) {
      throw new Error(`Missing tab ${id}`);
    }
    return element;
  }

  function press(id: Id, key: string): KeyboardEvent {
    const event = new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      tab(id).dispatchEvent(event);
    });
    return event;
  }

  it('names the list and ties each tab to its panel', () => {
    render();
    const list = container.querySelector('[role="tablist"]');
    expect(list?.getAttribute('aria-label')).toBe('Sections');
    expect(list?.hasAttribute('aria-orientation')).toBe(false);
    for (const item of ITEMS) {
      expect(tab(item.id).getAttribute('role')).toBe('tab');
      expect(tab(item.id).id).toBe(`el-${item.id}`);
      expect(tab(item.id).getAttribute('aria-controls')).toBe('sections-panel');
    }
  });

  it('marks only the selected tab selected and tabbable', () => {
    render();
    expect(tab('two').getAttribute('aria-selected')).toBe('true');
    expect(tab('two').tabIndex).toBe(0);
    expect(tab('one').getAttribute('aria-selected')).toBe('false');
    expect(tab('one').tabIndex).toBe(-1);
    expect(tab('three').tabIndex).toBe(-1);
  });

  it('keeps the first tab tabbable when the value names no tab', () => {
    // The value can briefly name a tab the host has just hidden.
    render({ value: 'missing' as Id });
    expect(tab('one').tabIndex).toBe(0);
    expect(tab('two').tabIndex).toBe(-1);
  });

  it('shows a positive count and hides zero', () => {
    render();
    expect(
      container.querySelector('[data-testid="tab-two-count"]')?.textContent,
    ).toBe('4');
    expect(
      container.querySelector('[data-testid="tab-three-count"]'),
    ).toBeNull();
  });

  it('reports a click as a pointer change', () => {
    const onChange = render();
    act(() => tab('three').click());
    expect(onChange).toHaveBeenCalledWith('three', 'pointer');
  });

  it('moves and selects with the arrow keys, wrapping at the ends', () => {
    const onChange = render();
    const right = press('two', 'ArrowRight');
    expect(onChange).toHaveBeenLastCalledWith('three', 'keyboard');
    expect(document.activeElement).toBe(tab('three'));
    expect(right.defaultPrevented).toBe(true);

    const fromLast = render({ value: 'three' });
    press('three', 'ArrowRight');
    expect(fromLast).toHaveBeenLastCalledWith('one', 'keyboard');

    const fromFirst = render({ value: 'one' });
    press('one', 'ArrowLeft');
    expect(fromFirst).toHaveBeenLastCalledWith('three', 'keyboard');
  });

  it('moves from the focused tab while the selection lags or names no tab', () => {
    // A router or a refusing host leaves the value behind; held arrows still
    // walk the tabs from the one that has focus.
    const onChange = render();
    press('two', 'ArrowRight');
    press('three', 'ArrowRight');
    expect(onChange).toHaveBeenLastCalledWith('one', 'keyboard');
    expect(document.activeElement).toBe(tab('one'));

    const fromMissing = render({ value: 'missing' as Id });
    press('one', 'ArrowLeft');
    expect(fromMissing).toHaveBeenLastCalledWith('three', 'keyboard');
  });

  it('jumps to the first and last tab with Home and End', () => {
    const onChange = render();
    press('two', 'Home');
    expect(onChange).toHaveBeenLastCalledWith('one', 'keyboard');
    expect(document.activeElement).toBe(tab('one'));
    press('two', 'End');
    expect(onChange).toHaveBeenLastCalledWith('three', 'keyboard');
    expect(document.activeElement).toBe(tab('three'));
  });

  it('ignores other keys and leaves them to the page', () => {
    const onChange = render();
    const event = press('two', 'ArrowDown');
    expect(onChange).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('uses Up and Down when vertical', () => {
    const onChange = render({ orientation: 'vertical' });
    expect(
      container
        .querySelector('[role="tablist"]')
        ?.getAttribute('aria-orientation'),
    ).toBe('vertical');
    press('two', 'ArrowDown');
    expect(onChange).toHaveBeenLastCalledWith('three', 'keyboard');
    press('two', 'ArrowUp');
    expect(onChange).toHaveBeenLastCalledWith('one', 'keyboard');
    const sideways = press('two', 'ArrowRight');
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(sideways.defaultPrevented).toBe(false);
  });

  it('draws a vertical tab’s focus ring inside the row, so the rail cannot clip it', () => {
    render();
    // A horizontal tab has no side padding; an inside ring would cover its label.
    expect(tab('one').classList).not.toContain('focus-ring-inset');
    render({ orientation: 'vertical' });
    expect(tab('one').classList).toContain('focus-ring-inset');
  });

  it('focuses the selected tab on mount only when asked', () => {
    render({ value: 'three' });
    expect(document.activeElement).not.toBe(tab('three'));
    act(() => root.unmount());
    root = createRoot(container);
    render({ value: 'three', focusSelectedOnMount: true });
    expect(document.activeElement).toBe(tab('three'));
  });
});
