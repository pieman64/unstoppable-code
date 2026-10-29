/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  PanelAddTabMenuView,
  type PanelAddTabMenuViewEntry,
  type PanelAddTabMenuViewSection,
} from '../PanelAddTabMenuView';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function entry(
  testId: string,
  label: string,
  onActivate: () => void = jest.fn(),
): PanelAddTabMenuViewEntry {
  return { testId, label, icon: <svg />, onActivate };
}

describe('PanelAddTabMenuView', () => {
  let container: HTMLDivElement;
  let anchor: HTMLButtonElement;
  let root: Root;
  const onClose = jest.fn();

  beforeEach(() => {
    container = document.createElement('div');
    anchor = document.createElement('button');
    document.body.append(container, anchor);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    anchor.remove();
    onClose.mockClear();
  });

  function render(sections: readonly PanelAddTabMenuViewSection[]): void {
    const node: JSX.Element = (
      <PanelAddTabMenuView
        anchor={anchor}
        groupId="group-1"
        entries={[entry('panel-add-menu-item-new-chat', 'New chat')]}
        sections={sections}
        onClose={onClose}
      />
    );
    act(() => {
      root.render(node);
    });
  }

  function menu(): HTMLElement {
    const element = document.querySelector<HTMLElement>(
      '[data-testid="panel-add-menu"]',
    );
    if (element === null) throw new Error('menu not rendered');
    return element;
  }

  it('renders the action-menu rows: small text and quiet tertiary icons', () => {
    render([]);
    const row = menu().querySelector<HTMLElement>(
      '[data-testid="panel-add-menu-item-new-chat"]',
    );
    expect(row?.className).toContain('text-xs');
    const icon = menu().querySelector<HTMLElement>(
      '[data-testid="panel-add-menu-item-new-chat-icon"]',
    );
    expect(icon?.className).toContain('fg-tertiary');
    expect(icon?.className).not.toContain('fg-secondary');
  });

  describe("'row' presentation", () => {
    it('renders the entry directly after the divider, with no label or flyout', () => {
      const onActivate = jest.fn();
      render([
        {
          id: 'plans',
          label: 'Plans',
          presentation: 'row',
          entries: [entry('panel-add-menu-item-plans', 'Plans', onActivate)],
        },
      ]);

      const divider = menu().querySelector(
        '[data-testid="panel-add-menu-plans-divider"]',
      );
      expect(divider).not.toBeNull();
      const row = menu().querySelector<HTMLElement>(
        '[data-testid="panel-add-menu-item-plans"]',
      );
      expect(row?.getAttribute('role')).toBe('menuitem');
      // The row is the divider's next sibling: no group wrapper, no label.
      expect(divider?.nextElementSibling).toBe(row);
      expect(
        menu().querySelector('[data-testid="panel-add-menu-plans-group"]'),
      ).toBeNull();
      expect(
        menu().querySelector('[data-testid="panel-add-menu-plans-submenu"]'),
      ).toBeNull();
      expect(
        menu().querySelector('.canopy-panel-chrome-menu-label'),
      ).toBeNull();

      act(() => row?.click());
      expect(onActivate).toHaveBeenCalledTimes(1);
    });

    it('omits the row and its divider when it has no entry', () => {
      render([
        { id: 'plans', label: 'Plans', presentation: 'row', entries: [] },
      ]);
      expect(
        menu().querySelector('[data-testid="panel-add-menu-plans-divider"]'),
      ).toBeNull();
    });
  });

  describe('submenu header entries', () => {
    function openSubmenu(): HTMLElement {
      const trigger = menu().querySelector<HTMLElement>(
        '[data-testid="panel-add-menu-plans-submenu"]',
      );
      if (trigger === null) throw new Error('submenu trigger not rendered');
      act(() => trigger.click());
      const group = document.querySelector<HTMLElement>(
        '[data-testid="panel-add-menu-plans-group"]',
      );
      if (group === null) throw new Error('submenu did not open');
      return group;
    }

    it('pins header entries before the content, separated by a divider', () => {
      const onAll = jest.fn();
      render([
        {
          id: 'plans',
          label: 'Plans',
          presentation: 'submenu',
          headerEntries: [
            entry('panel-add-menu-item-all-plans', 'All plans', onAll),
          ],
          entries: [
            entry('panel-add-menu-item-plan-a', 'Plan A'),
            entry('panel-add-menu-item-plan-b', 'Plan B'),
          ],
          footerEntries: [entry('panel-add-menu-plans-settings', 'Settings')],
        },
      ]);

      const group = openSubmenu();
      const children = Array.from(group.querySelectorAll('*')).filter(
        (element) =>
          element.getAttribute('role') === 'menuitem' ||
          element.getAttribute('role') === 'separator',
      );
      expect(
        children.map(
          (element) =>
            element.getAttribute('data-testid') ?? element.getAttribute('role'),
        ),
      ).toEqual([
        'panel-add-menu-item-all-plans',
        'separator',
        'panel-add-menu-item-plan-a',
        'panel-add-menu-item-plan-b',
        'separator',
        'panel-add-menu-plans-settings',
      ]);

      act(() =>
        group
          .querySelector<HTMLElement>(
            '[data-testid="panel-add-menu-item-all-plans"]',
          )
          ?.click(),
      );
      expect(onAll).toHaveBeenCalledTimes(1);
    });

    it('renders a submenu that only has header entries, without a trailing divider', () => {
      render([
        {
          id: 'plans',
          label: 'Plans',
          presentation: 'submenu',
          headerEntries: [entry('panel-add-menu-item-all-plans', 'All plans')],
          entries: [],
        },
      ]);

      const group = openSubmenu();
      expect(
        group.querySelector('[data-testid="panel-add-menu-item-all-plans"]'),
      ).not.toBeNull();
      expect(group.querySelector('[role="separator"]')).toBeNull();
    });
  });
});
