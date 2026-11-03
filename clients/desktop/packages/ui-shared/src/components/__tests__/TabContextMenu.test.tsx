/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TabContextMenu, type TabContextMenuItem } from '../TabContextMenu';

const icon = <svg data-testid="row-icon" />;

const ITEMS: TabContextMenuItem[] = [
  { key: 'pin', label: 'Pin tab', icon, onSelect: jest.fn(), testId: 'pin' },
  {
    key: 'close',
    label: 'Close',
    icon,
    separatorBefore: true,
    onSelect: jest.fn(),
    testId: 'close',
  },
];

describe('TabContextMenu rows', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(): void {
    act(() => {
      root.render(
        <TabContextMenu x={10} y={10} items={ITEMS} onClose={jest.fn()} />,
      );
    });
  }

  it('draws the shared action rows, each with its leading icon', () => {
    render();
    for (const testId of ['pin', 'close']) {
      const row = document.body.querySelector(`[data-testid="${testId}"]`);
      expect(row?.getAttribute('role')).toBe('menuitem');
      expect(row?.classList.contains('canopy-dropdown-menu-item')).toBe(true);
      expect(row?.querySelector('[data-testid="row-icon"]')).toBeInstanceOf(
        Element,
      );
    }
  });

  it('splits groups with one hairline divider', () => {
    render();
    const separators = document.body.querySelectorAll('[role="separator"]');
    expect(separators).toHaveLength(1);
    expect(separators[0]?.nextElementSibling?.getAttribute('data-testid')).toBe(
      'close',
    );
  });

  it('allows selecting menu items in an auxiliary document', () => {
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const doc = frame.contentDocument;
    const view = doc?.defaultView;
    if (!doc || !view) throw new Error('auxiliary document missing');
    const onClose = jest.fn();
    const onSelect = jest.fn();
    try {
      act(() => {
        root.render(
          <TabContextMenu
            x={10}
            y={10}
            ownerDocument={doc}
            onClose={onClose}
            items={[
              {
                key: 'rename',
                label: 'Rename',
                icon,
                testId: 'rename',
                onSelect,
              },
            ]}
          />,
        );
      });
      const item = doc.querySelector('[data-testid="rename"]');
      if (!item) throw new Error('rename item missing');
      act(() => {
        item.dispatchEvent(new view.MouseEvent('mousedown', { bubbles: true }));
      });
      expect(onClose).not.toHaveBeenCalled();
      act(() => {
        item.dispatchEvent(new view.MouseEvent('click', { bubbles: true }));
      });
      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      act(() => root.render(null));
      frame.remove();
    }
  });
});

describe('TabContextMenu keyboard', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const KEYBOARD_ITEMS: TabContextMenuItem[] = [
    { key: 'one', label: 'One', icon, onSelect: jest.fn(), testId: 'one' },
    {
      key: 'two',
      label: 'Two',
      icon,
      onSelect: jest.fn(),
      testId: 'two',
      disabled: true,
    },
    {
      key: 'three',
      label: 'Three',
      icon,
      separatorBefore: true,
      onSelect: jest.fn(),
      testId: 'three',
    },
  ];

  function render(focusOnOpen: boolean): void {
    act(() => {
      root.render(
        <TabContextMenu
          x={10}
          y={10}
          items={KEYBOARD_ITEMS}
          onClose={jest.fn()}
          dataTestId="menu"
          focusOnOpen={focusOnOpen}
        />,
      );
    });
  }

  function press(key: string): void {
    const active = document.activeElement;
    if (!active) throw new Error('no focused element');
    act(() => {
      active.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
      );
    });
  }

  function focusedTestId(): string | null {
    return document.activeElement?.getAttribute('data-testid') ?? null;
  }

  it('leaves focus in place unless asked to focus on open', () => {
    const before = document.activeElement;
    render(false);
    expect(document.activeElement).toBe(before);
  });

  it('focuses the first enabled item and moves over disabled items', () => {
    render(true);
    expect(focusedTestId()).toBe('one');
    press('ArrowDown');
    expect(focusedTestId()).toBe('three');
    press('ArrowDown');
    expect(focusedTestId()).toBe('one');
    press('ArrowUp');
    expect(focusedTestId()).toBe('three');
    press('Home');
    expect(focusedTestId()).toBe('one');
    press('End');
    expect(focusedTestId()).toBe('three');
  });
});

describe('TabContextMenu dismissal', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function renderMenu(onClose: () => void): void {
    act(() => {
      root.render(
        <TabContextMenu
          x={10}
          y={10}
          items={[{ key: 'one', label: 'One', icon, onSelect: jest.fn() }]}
          onClose={onClose}
          focusOnOpen
        />,
      );
    });
  }

  it('closes on Escape, a window resize and a window blur', () => {
    const onClose = jest.fn();
    renderMenu(onClose);
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(onClose).toHaveBeenCalledTimes(2);
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('returns focus to what held it when the menu opened', () => {
    const tab = document.createElement('button');
    document.body.append(tab);
    act(() => tab.focus());
    renderMenu(jest.fn());
    expect(document.activeElement).not.toBe(tab);
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(document.activeElement).toBe(tab);
    tab.remove();
  });
});
