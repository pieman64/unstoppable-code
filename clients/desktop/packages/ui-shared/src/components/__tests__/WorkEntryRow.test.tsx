/** @jest-environment jsdom */

/**
 * The shared Work Entry sidebar row (CAN-3053). It must reproduce desktop's
 * private cowork row exactly — classes, automation ids, data attributes —
 * so the desktop rail can switch to it with no visual diff, while leaving
 * every command, dialog, and menu row to the host.
 */
import { act, createRef, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import {
  WorkEntryRow,
  WorkEntryRowMenuItems,
  workEntryRowTestId,
  type WorkEntryRowMenuRenderProps,
} from '../WorkEntryRow';

// React only honors act() when the environment flag is set on the global.
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const BASE = 'sidebar-work-entry-e1';

type RowProps = ComponentProps<typeof WorkEntryRow>;

describe('WorkEntryRow', () => {
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

  function render(props: Partial<RowProps> = {}): void {
    act(() => {
      root.render(
        <WorkEntryRow
          title="Plan the launch"
          testId={BASE}
          entryId="e1"
          {...props}
        />,
      );
    });
  }

  function byTestId(testId: string): HTMLElement | null {
    return document.body.querySelector<HTMLElement>(
      `[data-testid="${testId}"]`,
    );
  }

  function row(): HTMLElement {
    const element = byTestId(BASE);
    if (element === null) throw new Error('row not rendered');
    return element;
  }

  function withMenu(): Partial<RowProps> {
    return {
      renderMenuItems: (menu) => (
        <WorkEntryRowMenuItems menu={menu} onRename={(): void => undefined} />
      ),
    };
  }

  describe('structure', () => {
    it('renders the title, the row attributes, and the empty leading slot', () => {
      render();
      const element = row();

      expect(element.getAttribute('role')).toBe('button');
      expect(element.getAttribute('tabindex')).toBe('0');
      expect(element.getAttribute('data-standalone-chat-id')).toBe('e1');
      expect(element.getAttribute('data-entry-status')).toBe('active');
      expect(element.hasAttribute('data-sidebar-selected-item')).toBe(false);
      expect(element.hasAttribute('data-sidebar-selected-pin-disabled')).toBe(
        false,
      );
      const title = element.querySelector('p');
      expect(title?.textContent).toBe('Plan the launch');
      expect(title?.getAttribute('title')).toBe('Plan the launch');
      const leading = byTestId(`${BASE}-leading-slot`);
      expect(leading?.getAttribute('aria-hidden')).toBe('true');
      expect(leading?.childElementCount).toBe(0);
      expect(byTestId(`${BASE}-status-slot`)).toBeNull();
      expect(byTestId(`${BASE}-done`)).toBeNull();
    });

    it('matches the chats-section row selector', () => {
      render();
      expect(
        container.querySelector('[data-testid^="sidebar-work-entry-"]'),
      ).toBe(row());
    });

    it('uses desktop row geometry and the resting ink', () => {
      render();
      const className = row().className;

      for (const token of [
        'group',
        'group/sidebar-item',
        'relative',
        'flex',
        'h-8',
        'w-full',
        'cursor-default',
        'items-center',
        'gap-1.5',
        'rounded-row',
        'px-1.5',
        'py-0',
        'text-left',
        'text-s',
        'transition',
        'fg-secondary',
        'hover:bg-subtle',
      ]) {
        expect(className.split(/\s+/)).toContain(token);
      }
      expect(className).not.toContain('bg-muted');
      expect(className).not.toContain('touch-none');
      expect(row().querySelector('p')?.className).toContain(
        'min-w-0 flex-1 truncate text-s font-normal leading-snug',
      );
    });

    it('raises a touch-target row to the 44px minimum instead of 32px', () => {
      render({ touchTarget: true });
      const tokens = row().className.split(/\s+/);
      expect(tokens).toContain('min-h-11');
      expect(tokens).not.toContain('h-8');
    });

    it('marks the selected row with the muted surface and the pin mark', () => {
      render({ selected: true });
      expect(row().className).toContain('bg-muted fg-primary');
      expect(row().className).not.toContain('hover:bg-subtle');
      expect(row().getAttribute('data-sidebar-selected-item')).toBe('');
    });

    it('opts a row out of the selected-item pin on request', () => {
      render({ selected: true, disableSelectedPin: true });
      expect(row().getAttribute('data-sidebar-selected-pin-disabled')).toBe('');
      expect(row().getAttribute('data-sidebar-selected-item')).toBe('');
    });

    it('names the selected-item pin seat on request, and none by default', () => {
      render({ selected: true });
      expect(row().hasAttribute('data-sidebar-selected-pin-seat')).toBe(false);
      render({ selected: true, selectedPinSeat: 'chats' });
      expect(row().getAttribute('data-sidebar-selected-pin-seat')).toBe(
        'chats',
      );
      expect(row().getAttribute('data-sidebar-selected-item')).toBe('');
    });

    it('fades and disables a row while it is being removed', () => {
      render({ removing: true });
      expect(row().className).toContain('pointer-events-none opacity-50');
    });
  });

  describe('status', () => {
    it('shows the purple done checkmark and no trailing status when done', () => {
      render({
        status: 'done',
        working: true,
        hasPendingQuestion: true,
        hasUnread: true,
      });

      expect(row().getAttribute('data-entry-status')).toBe('done');
      const done = byTestId(`${BASE}-done`);
      expect(done?.getAttribute('aria-label')).toBe('Done');
      expect(done?.className).toContain('fg-purple');
      expect(done?.querySelector('svg')).not.toBeNull();
      expect(
        byTestId(`${BASE}-leading-slot`)?.hasAttribute('aria-hidden'),
      ).toBe(false);
      expect(byTestId(`${BASE}-status-slot`)).toBeNull();
      expect(byTestId(`${BASE}-thinking`)).toBeNull();
      expect(byTestId(`${BASE}-question`)).toBeNull();
      expect(byTestId(`${BASE}-unread`)).toBeNull();
    });

    it('shows the Working spinner in the status slot', () => {
      render({ working: true });
      const slot = byTestId(`${BASE}-status-slot`);
      const thinking = byTestId(`${BASE}-thinking`);
      expect(thinking?.getAttribute('aria-label')).toBe('Working');
      expect(slot?.contains(thinking ?? null)).toBe(true);
      expect(thinking?.className).toBe(
        'inline-flex h-5 w-6 shrink-0 items-center justify-center',
      );
    });

    it('lets a question beat unread, beside the Working spinner', () => {
      render({ working: true, hasPendingQuestion: true, hasUnread: true });
      const question = byTestId(`${BASE}-question`);
      expect(question?.getAttribute('aria-label')).toBe('Question waiting');
      expect(question?.getAttribute('tabindex')).toBe('0');
      expect(question?.querySelector('.bg-fg-warning')).not.toBeNull();
      expect(byTestId(`${BASE}-unread`)).toBeNull();
      expect(byTestId(`${BASE}-thinking`)).not.toBeNull();
    });

    it('shows the blue unread dot when nothing outranks it', () => {
      render({ hasUnread: true });
      const unread = byTestId(`${BASE}-unread`);
      expect(unread?.getAttribute('aria-label')).toBe('Unread messages');
      expect(unread?.querySelector('.bg-fg-blue')).not.toBeNull();
      expect(byTestId(`${BASE}-thinking`)).toBeNull();
    });

    it('renders the shared badge with the row suffix convention', () => {
      render({ sharedWithTeammates: true });
      expect(byTestId('worktree-row-shared-badge')).not.toBeNull();
    });
  });

  describe('pinned to top', () => {
    it('renders the quiet pin with its accessible name', () => {
      render({ pinnedToTop: true });
      const pin = byTestId('worktree-row-pinned-badge');
      expect(pin?.getAttribute('aria-label')).toBe('Pinned');
      expect(pin?.className).toContain(
        'pointer-fine:group-hover/sidebar-item:opacity-0',
      );
    });

    it('is absent unless the host opts in', () => {
      render();
      expect(byTestId('worktree-row-pinned-badge')).toBeNull();
    });

    it('sits left of the shared badge and the status', () => {
      render({ pinnedToTop: true, sharedWithTeammates: true, working: true });
      const order = Array.from(
        row().querySelectorAll<HTMLElement>('[data-testid]'),
        (element) => element.dataset.testid,
      );
      const pin = order.indexOf('worktree-row-pinned-badge');
      expect(pin).toBeGreaterThan(-1);
      expect(order.indexOf('worktree-row-shared-badge')).toBeGreaterThan(pin);
      expect(order.indexOf(`${BASE}-status-slot`)).toBeGreaterThan(pin);
    });

    it('suffixes its automation id on pinned copies', () => {
      render({ pinnedToTop: true, pinnedSurface: 'pin-top' });
      expect(byTestId('worktree-row-pinned-badge-pin-top')).not.toBeNull();
      expect(byTestId('worktree-row-pinned-badge')).toBeNull();
    });
  });

  describe('action reserve', () => {
    const titleClass = (): string => row().querySelector('p')?.className ?? '';

    it('reserves two buttons on the title when no status renders', () => {
      render({ onDelete: jest.fn(), ...withMenu() });
      expect(titleClass()).toContain(
        'group-hover/sidebar-item:pr-12 group-focus-within/sidebar-item:pr-12',
      );
      expect(titleClass()).toContain('pointer-coarse:pr-12');
    });

    it('moves the coarse reserve to the shared badge', () => {
      render({ onDelete: jest.fn(), ...withMenu(), sharedWithTeammates: true });
      expect(titleClass()).not.toContain('pointer-coarse:pr-12');
      expect(titleClass()).toContain('group-hover/sidebar-item:pr-12');
      expect(byTestId('worktree-row-shared-badge')?.className).toContain(
        'pointer-coarse:mr-11.5',
      );
    });

    it('moves the coarse reserve to the pin when it is the last badge', () => {
      render({ onDelete: jest.fn(), ...withMenu(), pinnedToTop: true });
      expect(titleClass()).not.toContain('pointer-coarse:pr-12');
      expect(titleClass()).toContain('group-hover/sidebar-item:pr-12');
      expect(byTestId('worktree-row-pinned-badge')?.className).toContain(
        'pointer-coarse:mr-11.5',
      );
    });

    it('keeps the coarse reserve on the shared badge beside a pin', () => {
      render({
        onDelete: jest.fn(),
        ...withMenu(),
        pinnedToTop: true,
        sharedWithTeammates: true,
      });
      expect(byTestId('worktree-row-pinned-badge')?.className).not.toContain(
        'pointer-coarse:mr',
      );
      expect(byTestId('worktree-row-shared-badge')?.className).toContain(
        'pointer-coarse:mr-11.5',
      );
    });

    it('moves the whole reserve to the status slot while a status renders', () => {
      render({
        onDelete: jest.fn(),
        ...withMenu(),
        working: true,
        sharedWithTeammates: true,
      });
      expect(titleClass()).not.toContain('pr-12');
      expect(byTestId('worktree-row-shared-badge')?.className).not.toContain(
        'pointer-coarse:mr',
      );
      expect(byTestId(`${BASE}-status-slot`)?.className).toBe(
        'inline-flex h-5 shrink-0 items-center justify-end -mr-0.5 pointer-fine:group-hover:mr-11.5 pointer-fine:group-focus-within:mr-11.5 pointer-coarse:mr-11.5',
      );
    });

    it('reserves one button when only one action renders', () => {
      render({ ...withMenu() });
      expect(titleClass()).toContain('group-hover/sidebar-item:pr-6');
      expect(titleClass()).toContain('pointer-coarse:pr-6');
      expect(titleClass()).not.toContain('pr-12');

      render({ ...withMenu(), hasUnread: true });
      expect(byTestId(`${BASE}-status-slot`)?.className).toContain(
        'pointer-fine:group-hover:mr-5.5',
      );
    });

    it('reserves nothing and renders no action rail without actions', () => {
      render({ hasUnread: true });
      expect(titleClass()).not.toContain('pr-');
      expect(byTestId(`${BASE}-status-slot`)?.className).toBe(
        'inline-flex h-5 shrink-0 items-center justify-end -mr-0.5',
      );
      expect(row().querySelector('.absolute')).toBeNull();
    });
  });

  describe('actions', () => {
    it('hides Delete and the menu when the host supplies neither', () => {
      render();
      expect(byTestId(`${BASE}-delete-button`)).toBeNull();
      expect(byTestId(`${BASE}-menu`)).toBeNull();
    });

    it('opens the entry on click, Enter, and Space', () => {
      const onOpen = jest.fn();
      render({ onOpen });
      act(() => row().click());
      act(() => {
        row().dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
        );
      });
      act(() => {
        row().dispatchEvent(
          new KeyboardEvent('keydown', { key: ' ', bubbles: true }),
        );
      });
      act(() => {
        row().dispatchEvent(
          new KeyboardEvent('keydown', { key: 'a', bubbles: true }),
        );
      });
      expect(onOpen).toHaveBeenCalledTimes(3);
    });

    it('leaves Enter on the ••• button to the button', () => {
      const onOpen = jest.fn();
      render({ onOpen, ...withMenu() });
      act(() => {
        byTestId(`${BASE}-menu`)?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
        );
      });
      expect(onOpen).not.toHaveBeenCalled();
    });

    it('runs the host Delete without opening the entry', () => {
      const onOpen = jest.fn();
      const onDelete = jest.fn();
      render({ onOpen, onDelete });
      const button = byTestId(`${BASE}-delete-button`);
      expect(button?.getAttribute('aria-label')).toBe('Delete');
      act(() => button?.click());
      expect(onDelete).toHaveBeenCalledTimes(1);
      expect(onOpen).not.toHaveBeenCalled();
    });

    it('disables Delete with the host reason as its tooltip', () => {
      const onOpen = jest.fn();
      const onDelete = jest.fn();
      render({
        onOpen,
        onDelete,
        deleteDisabledReason: 'Delegates are still running here.',
      });
      const button = byTestId(`${BASE}-delete-button`);
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error('Delete button not rendered');
      }
      expect(button.disabled).toBe(true);
      // The accessible name stays the action; the reason is the tooltip.
      expect(button.getAttribute('aria-label')).toBe('Delete');
      act(() => {
        button.parentElement?.dispatchEvent(
          new MouseEvent('mouseover', { bubbles: true }),
        );
      });
      expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(
        'Delegates are still running here.',
      );
      act(() => button.click());
      expect(onDelete).not.toHaveBeenCalled();
    });

    it('keeps Delete enabled with its own tooltip by default', () => {
      render({ onDelete: jest.fn() });
      const button = byTestId(`${BASE}-delete-button`);
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error('Delete button not rendered');
      }
      expect(button.disabled).toBe(false);
      act(() => {
        button.parentElement?.dispatchEvent(
          new MouseEvent('mouseover', { bubbles: true }),
        );
      });
      expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(
        'Delete',
      );
    });

    it('toggles the shared menu from the ••• button', () => {
      const onOpen = jest.fn();
      render({ onOpen, ...withMenu() });
      const button = byTestId(`${BASE}-menu`);
      expect(button?.getAttribute('aria-label')).toBe('More actions');
      expect(button?.getAttribute('aria-haspopup')).toBe('menu');
      expect(button?.getAttribute('aria-expanded')).toBe('false');

      act(() => button?.click());
      const popover = byTestId(`${BASE}-menu-popover`);
      expect(popover).not.toBeNull();
      expect(popover?.className).toContain('sidebar-instant-interactions');
      expect(button?.getAttribute('aria-expanded')).toBe('true');
      expect(byTestId(`${BASE}-rename`)?.textContent).toBe('Rename');
      expect(onOpen).not.toHaveBeenCalled();

      act(() => button?.click());
      expect(byTestId(`${BASE}-menu-popover`)).toBeNull();
    });

    it('closes the menu before running a menu command', () => {
      const onRename = jest.fn();
      render({
        renderMenuItems: (menu) => (
          <WorkEntryRowMenuItems menu={menu} onRename={onRename} />
        ),
      });
      act(() => byTestId(`${BASE}-menu`)?.click());
      act(() => byTestId(`${BASE}-rename`)?.click());
      expect(onRename).toHaveBeenCalledTimes(1);
      expect(byTestId(`${BASE}-menu-popover`)).toBeNull();
    });

    it('opens the same menu at the pointer on right-click', () => {
      render({ ...withMenu() });
      const event = new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 40,
        clientY: 80,
      });
      act(() => {
        row().dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(true);
      expect(byTestId(`${BASE}-menu-popover`)).not.toBeNull();
      const anchor = Array.from(
        document.body.querySelectorAll<HTMLElement>('span.fixed'),
      ).find((element) => element.style.left === '40px');
      expect(anchor?.style.top).toBe('80px');
    });

    it('leaves the browser menu alone without a row menu', () => {
      render();
      const event = new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        row().dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(false);
    });

    it('hands the whole menu to a host renderMenu', () => {
      const calls: WorkEntryRowMenuRenderProps[] = [];
      render({
        renderMenu: (menu) => {
          calls.push(menu);
          return menu.open ? (
            <div data-testid={menu.popoverTestId}>host menu</div>
          ) : null;
        },
        renderMenuItems: () => <div data-testid="ignored" />,
      });

      expect(calls.at(-1)?.open).toBe(false);
      expect(byTestId(`${BASE}-menu`)).not.toBeNull();

      act(() => byTestId(`${BASE}-menu`)?.click());
      const opened = calls.at(-1);
      expect(opened?.open).toBe(true);
      expect(opened?.anchorPoint).toBeNull();
      expect(opened?.anchorRef.current).toBe(byTestId(`${BASE}-menu`));
      expect(opened?.popoverTestId).toBe(`${BASE}-menu-popover`);
      expect(opened?.testIdFor('-rename')).toBe(`${BASE}-rename`);
      expect(byTestId(`${BASE}-menu-popover`)?.textContent).toBe('host menu');
      expect(byTestId('ignored')).toBeNull();

      act(() => opened?.close());
      expect(calls.at(-1)?.open).toBe(false);

      act(() => {
        row().dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: 12,
            clientY: 34,
          }),
        );
      });
      expect(calls.at(-1)?.open).toBe(true);
      expect(calls.at(-1)?.anchorPoint).toEqual({ x: 12, y: 34 });
    });
  });

  describe('unread preview', () => {
    it('shows the host preview while the dot is hovered, until the row is left', () => {
      const renderUnreadPreview = jest.fn((rect: DOMRect) => (
        <div data-testid="preview">{rect.width}</div>
      ));
      render({ hasUnread: true, renderUnreadPreview });
      expect(byTestId('preview')).toBeNull();

      act(() => {
        byTestId(`${BASE}-unread`)?.dispatchEvent(
          new MouseEvent('mouseover', { bubbles: true }),
        );
      });
      expect(byTestId('preview')).not.toBeNull();
      expect(renderUnreadPreview).toHaveBeenCalled();

      act(() => {
        row().dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
      });
      expect(byTestId('preview')).toBeNull();
    });

    it('opens on focus and closes on blur', () => {
      render({
        hasUnread: true,
        renderUnreadPreview: () => <div data-testid="preview" />,
      });
      act(() => byTestId(`${BASE}-unread`)?.focus());
      expect(byTestId('preview')).not.toBeNull();
      act(() => byTestId(`${BASE}-unread`)?.blur());
      expect(byTestId('preview')).toBeNull();
    });

    it('shows nothing from the question dot when nothing is unread', () => {
      render({
        hasPendingQuestion: true,
        renderUnreadPreview: () => <div data-testid="preview" />,
      });
      act(() => byTestId(`${BASE}-question`)?.focus());
      expect(byTestId('preview')).toBeNull();
    });
  });

  describe('pinned copies', () => {
    it('suffixes every automation id and drops the identity marks', () => {
      render({
        pinnedSurface: 'pin-top',
        selected: true,
        working: true,
        hasUnread: true,
        sharedWithTeammates: true,
        onDelete: jest.fn(),
        ...withMenu(),
      });

      const copy = byTestId(`${BASE}-pin-top`);
      expect(copy).not.toBeNull();
      expect(byTestId(BASE)).toBeNull();
      expect(copy?.hasAttribute('data-standalone-chat-id')).toBe(false);
      expect(copy?.hasAttribute('data-sidebar-selected-item')).toBe(false);
      expect(copy?.className).toContain('bg-muted fg-primary');
      for (const part of [
        '-leading-slot',
        '-status-slot',
        '-thinking',
        '-unread',
        '-delete-button',
        '-menu',
      ]) {
        expect(byTestId(`${BASE}${part}-pin-top`)).not.toBeNull();
      }
      expect(byTestId('worktree-row-shared-badge-pin-top')).not.toBeNull();
    });

    it('suffixes the done mark, the menu surface, and its rows', () => {
      render({ pinnedSurface: 'pin-bottom', status: 'done', ...withMenu() });
      expect(byTestId(`${BASE}-done-pin-bottom`)).not.toBeNull();
      act(() => byTestId(`${BASE}-menu-pin-bottom`)?.click());
      expect(byTestId(`${BASE}-menu-popover-pin-bottom`)).not.toBeNull();
      expect(byTestId(`${BASE}-rename-pin-bottom`)).not.toBeNull();
    });

    it('ignores a drag binding', () => {
      const onPointerDown = jest.fn();
      render({ pinnedSurface: 'pin-top', drag: { onPointerDown } });
      const copy = byTestId(`${BASE}-pin-top`);
      expect(copy?.className).not.toContain('touch-none');
      act(() => {
        copy?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      });
      expect(onPointerDown).not.toHaveBeenCalled();
    });
  });

  describe('portaled menu events', () => {
    // FloatingMenu portals its rows into document.body, but React still
    // bubbles their synthetic events through the row that rendered them.
    function openHostMenu(props: Partial<RowProps>): HTMLElement {
      render({
        ...props,
        renderMenuItems: () => (
          <button type="button" role="menuitem" data-testid="host-item">
            Rename
          </button>
        ),
      });
      act(() => byTestId(`${BASE}-menu`)?.click());
      const item = byTestId('host-item');
      if (item === null) throw new Error('menu item not rendered');
      expect(row().contains(item)).toBe(false);
      return item;
    }

    it('does not open the entry on Enter or Space in an open menu', () => {
      const onOpen = jest.fn();
      const item = openHostMenu({ onOpen });
      act(() => {
        item.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
        );
      });
      act(() => {
        item.dispatchEvent(
          new KeyboardEvent('keydown', { key: ' ', bubbles: true }),
        );
      });
      expect(onOpen).not.toHaveBeenCalled();
    });

    it('does not open the entry when a menu row is clicked', () => {
      const onOpen = jest.fn();
      const item = openHostMenu({ onOpen });
      act(() => item.click());
      expect(onOpen).not.toHaveBeenCalled();
    });

    it('does not start a drag from a menu row', () => {
      const onPointerDown = jest.fn();
      const item = openHostMenu({ drag: { onPointerDown } });
      act(() => {
        item.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      });
      expect(onPointerDown).not.toHaveBeenCalled();
    });

    it('does not reopen the menu at a right-click inside it', () => {
      const item = openHostMenu({});
      const event = new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 7,
        clientY: 9,
      });
      act(() => {
        item.dispatchEvent(event);
      });
      const anchor = Array.from(
        document.body.querySelectorAll<HTMLElement>('span.fixed'),
      ).find((element) => element.style.left === '7px');
      expect(anchor).toBeUndefined();
    });
  });

  describe('drag binding', () => {
    it('binds the sortable ref, style, attributes, and drag state', () => {
      const ref = createRef<HTMLDivElement>();
      render({
        drag: {
          ref,
          style: { transform: 'translate3d(0px, 4px, 0)' },
          attributes: { 'aria-roledescription': 'sortable', role: 'listitem' },
          isDragging: true,
        },
      });
      expect(ref.current).toBe(row());
      expect(row().style.transform).toBe('translate3d(0px, 4px, 0)');
      expect(row().getAttribute('aria-roledescription')).toBe('sortable');
      // The row keeps its own role over the sortable one.
      expect(row().getAttribute('role')).toBe('button');
      expect(row().className).toContain('touch-none select-none');
      expect(row().className).toContain('opacity-50');
    });

    it('starts a drag from the row but not from its controls', () => {
      const onPointerDown = jest.fn();
      render({ drag: { onPointerDown }, onDelete: jest.fn() });
      act(() => {
        byTestId(`${BASE}-delete-button`)?.dispatchEvent(
          new MouseEvent('pointerdown', { bubbles: true }),
        );
      });
      expect(onPointerDown).not.toHaveBeenCalled();
      act(() => {
        row()
          .querySelector('p')
          ?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      });
      expect(onPointerDown).toHaveBeenCalledTimes(1);
    });
  });

  describe('WorkEntryRowMenuItems', () => {
    function openWith(
      props: Partial<ComponentProps<typeof WorkEntryRowMenuItems>>,
    ): void {
      render({
        renderMenuItems: (menu) => (
          <WorkEntryRowMenuItems menu={menu} {...props} />
        ),
      });
      act(() => byTestId(`${BASE}-menu`)?.click());
    }

    it('lists exactly the commands the host supplies, in the standard order', () => {
      openWith({
        onTogglePin: jest.fn(),
        onRename: jest.fn(),
        onToggleDone: jest.fn(),
        onShare: jest.fn(),
        onArchive: jest.fn(),
        onDelete: jest.fn(),
      });
      const ids = Array.from(
        byTestId(`${BASE}-menu-popover`)?.querySelectorAll('[data-testid]') ??
          [],
      ).map((element) => element.getAttribute('data-testid'));
      expect(ids).toEqual([
        `${BASE}-toggle-pin`,
        `${BASE}-rename`,
        `${BASE}-toggle-done`,
        `${BASE}-invite`,
        `${BASE}-archive`,
        `${BASE}-delete`,
      ]);
    });

    it('leads every row with an icon and ends with Archive and Delete in their own group', () => {
      openWith({
        onTogglePin: jest.fn(),
        onRename: jest.fn(),
        onToggleDone: jest.fn(),
        onShare: jest.fn(),
        onArchive: jest.fn(),
        onDelete: jest.fn(),
      });
      const popover = byTestId(`${BASE}-menu-popover`);
      const rows = Array.from(
        popover?.querySelectorAll('[role="menuitem"]') ?? [],
      );
      expect(rows).toHaveLength(6);
      for (const row of rows) {
        expect(row.querySelector('[aria-hidden="true"] svg')).not.toBeNull();
      }
      const separators = popover?.querySelectorAll('[role="separator"]');
      expect(separators).toHaveLength(1);
      expect(
        byTestId(`${BASE}-archive`)?.previousElementSibling?.getAttribute(
          'role',
        ),
      ).toBe('separator');
    });

    it('draws no divider above Archive when it is the only row', () => {
      openWith({ onArchive: jest.fn() });
      expect(
        byTestId(`${BASE}-menu-popover`)?.querySelector('[role="separator"]'),
      ).toBeNull();
    });

    it('omits the commands the host cannot run', () => {
      openWith({ onRename: jest.fn() });
      expect(byTestId(`${BASE}-toggle-pin`)).toBeNull();
      expect(byTestId(`${BASE}-toggle-done`)).toBeNull();
      expect(byTestId(`${BASE}-invite`)).toBeNull();
      expect(byTestId(`${BASE}-archive`)).toBeNull();
      expect(byTestId(`${BASE}-delete`)).toBeNull();
    });

    it('labels pin and done by the current state and passes the next one', () => {
      const onTogglePin = jest.fn();
      const onToggleDone = jest.fn();
      openWith({ pinned: true, onTogglePin, done: true, onToggleDone });
      expect(byTestId(`${BASE}-toggle-pin`)?.textContent).toBe('Unpin');
      expect(byTestId(`${BASE}-toggle-done`)?.textContent).toBe('Mark active');
      act(() => byTestId(`${BASE}-toggle-pin`)?.click());
      expect(onTogglePin).toHaveBeenCalledWith(false);
      expect(byTestId(`${BASE}-menu-popover`)).toBeNull();

      act(() => byTestId(`${BASE}-menu`)?.click());
      act(() => byTestId(`${BASE}-toggle-done`)?.click());
      expect(onToggleDone).toHaveBeenCalledWith('active');
    });

    it('offers Pin to top and Mark done on an unpinned active entry', () => {
      const onToggleDone = jest.fn();
      openWith({ onTogglePin: jest.fn(), onToggleDone });
      expect(byTestId(`${BASE}-toggle-pin`)?.textContent).toBe('Pin to top');
      expect(byTestId(`${BASE}-toggle-done`)?.textContent).toBe('Mark done');
      act(() => byTestId(`${BASE}-toggle-done`)?.click());
      expect(onToggleDone).toHaveBeenCalledWith('done');
    });

    it('labels Share, Archive, and Delete and carries their explanations', () => {
      const onShare = jest.fn();
      const onArchive = jest.fn();
      const onDelete = jest.fn();
      openWith({
        onShare,
        onArchive,
        archiveTitle: 'Keeps it until you delete it',
        onDelete,
        deleteTitle: 'Kept for 30 days',
      });
      expect(byTestId(`${BASE}-invite`)?.textContent).toBe('Share');
      expect(byTestId(`${BASE}-archive`)?.textContent).toBe('Archive');
      expect(byTestId(`${BASE}-archive`)?.getAttribute('title')).toBe(
        'Keeps it until you delete it',
      );
      expect(byTestId(`${BASE}-delete`)?.textContent).toBe('Delete');
      expect(byTestId(`${BASE}-delete`)?.getAttribute('title')).toBe(
        'Kept for 30 days',
      );
      act(() => byTestId(`${BASE}-invite`)?.click());
      expect(onShare).toHaveBeenCalledTimes(1);
      act(() => byTestId(`${BASE}-menu`)?.click());
      act(() => byTestId(`${BASE}-archive`)?.click());
      expect(onArchive).toHaveBeenCalledTimes(1);
      act(() => byTestId(`${BASE}-menu`)?.click());
      act(() => byTestId(`${BASE}-delete`)?.click());
      expect(onDelete).toHaveBeenCalledTimes(1);
    });

    it('disables Archive and Delete with the host reason as their explanation', () => {
      const onArchive = jest.fn();
      const onDelete = jest.fn();
      openWith({
        onRename: jest.fn(),
        onArchive,
        archiveTitle: 'Keeps it until you delete it',
        onDelete,
        deleteTitle: 'Kept for 30 days',
        removalDisabledReason: 'Delegates are still running here.',
      });
      const archive = byTestId(`${BASE}-archive`);
      const remove = byTestId(`${BASE}-delete`);
      if (
        !(archive instanceof HTMLButtonElement) ||
        !(remove instanceof HTMLButtonElement)
      ) {
        throw new Error('Archive and Delete not rendered');
      }
      expect(archive.disabled).toBe(true);
      expect(remove.disabled).toBe(true);
      expect(archive.getAttribute('title')).toBe(
        'Delegates are still running here.',
      );
      expect(remove.getAttribute('title')).toBe(
        'Delegates are still running here.',
      );
      // Only removal is blocked; the other commands stay available.
      const rename = byTestId(`${BASE}-rename`);
      expect(rename instanceof HTMLButtonElement && rename.disabled).toBe(
        false,
      );
      act(() => archive.click());
      act(() => remove.click());
      expect(onArchive).not.toHaveBeenCalled();
      expect(onDelete).not.toHaveBeenCalled();
    });
  });
});

describe('WorkEntryRow server rendering', () => {
  it('renders without a DOM for the web portal', () => {
    const html = renderToString(
      <WorkEntryRow
        title="Plan the launch"
        testId={BASE}
        entryId="e1"
        working
        hasUnread
        onDelete={(): void => undefined}
        renderMenuItems={(): null => null}
      />,
    );
    expect(html).toContain(`data-testid="${BASE}"`);
    expect(html).toContain(`data-testid="${BASE}-thinking"`);
    expect(html).toContain(`data-testid="${BASE}-unread"`);
    expect(html).toContain(`data-testid="${BASE}-menu"`);
    expect(html).not.toContain(`${BASE}-menu-popover`);
  });
});

describe('workEntryRowTestId', () => {
  it('appends the part suffix, then the pinned-copy suffix', () => {
    expect(workEntryRowTestId(BASE)).toBe(BASE);
    expect(workEntryRowTestId(BASE, '-menu')).toBe(`${BASE}-menu`);
    expect(workEntryRowTestId(BASE, '-menu', 'pin-top')).toBe(
      `${BASE}-menu-pin-top`,
    );
    expect(workEntryRowTestId(BASE, '', 'pin-bottom')).toBe(
      `${BASE}-pin-bottom`,
    );
  });
});
