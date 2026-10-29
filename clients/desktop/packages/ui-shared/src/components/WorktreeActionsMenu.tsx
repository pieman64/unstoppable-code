'use client';

import {
  Fragment,
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import type { AppIcon } from '../icons/AppIcons';
import { MoreHorizontalIcon } from '../icons/AppIcons';
import {
  DropdownMenuDivider,
  DropdownMenuItem,
  DropdownMenuItemIcon,
  DropdownMenuLabel,
  DropdownMenuSurface,
} from './DropdownMenu';
import {
  ActionMenuItems,
  ActionMenuLabelRow,
  ActionMenuRichTooltip,
  ActionMenuRowStyle,
  ActionMenuShortcut,
  actionMenuRowIcon,
  type ActionMenuItem,
} from './ActionMenuItems';
import {
  SpaceNotificationMenuStatusLine,
  type SpaceNotificationMenuChoiceKey,
} from './SpaceNotificationMenu';
import { RailIconButton } from './RailIconButton';
import {
  placeContextMenuAtPoint,
  useContextMenuPlacement,
} from './context-menu-placement';
import { useOverlayEscape } from './useOverlayEscape';
import { WorktreeRowActionChip } from './WorktreeRow';
import { NestedMenuFlyout } from './NestedMenuFlyout';

export type WorktreeMenuItemKey =
  | 'set-label'
  | 'branch-info'
  | 'invite'
  | 'debug-info'
  | 'launch'
  | 'dispatch-pipeline'
  | 'split-pr'
  | 'create-branch'
  | 'ungroup-from-base'
  | 'ungroup-children'
  | 'group-children'
  | 'group-with-base'
  | 'add-repository'
  | 'move-to-organization'
  | 'split-workspace'
  | 'toggle-pin'
  | 'toggle-hidden'
  | 'toggle-selection'
  | 'bulk-archive'
  | 'bulk-delete'
  | 'clear-selection'
  | 'share-chat'
  | 'more'
  | 'notifications'
  | SpaceNotificationMenuChoiceKey
  | 'archive'
  | 'delete'
  | `sidebar-group-${string}`;

/** A worktree menu row: the shared action menu row, keyed by worktree action. */
export type WorktreeMenuItem = ActionMenuItem<WorktreeMenuItemKey>;

/** The worktree menu's rows inside a submenu or another host's surface. */
export const WorktreeActionMenuItems = ActionMenuItems<WorktreeMenuItemKey>;

export interface WorktreeDirectAction {
  readonly key: string;
  readonly icon: AppIcon;
  readonly label: string;
  readonly onSelect: () => void;
  readonly tone?: 'neutral' | 'warning' | 'destructive';
  readonly testId?: string;
  readonly className?: string;
  /** Shown but unavailable; `tooltip` says why. */
  readonly disabled?: boolean;
  /** The hover tooltip; defaults to `label`. */
  readonly tooltip?: string;
}

export interface WorktreeActionsMenuProps {
  readonly items: readonly WorktreeMenuItem[];
  readonly accessibleLabel: string;
  readonly triggerTestId?: string;
  readonly menuTestId?: string;
  readonly triggerDataAttributes?: Readonly<Record<`data-${string}`, string>>;
  readonly alwaysVisible?: boolean;
  readonly directActions?: readonly WorktreeDirectAction[];
  /**
   * Hides the ••• trigger for fine pointers, for a host whose menu opens by
   * right-click. The trigger stays mounted, so the right-click still opens
   * the menu (and touch keeps the button).
   */
  readonly hideTriggerForFinePointer?: boolean;
  /**
   * Holds an empty fine-pointer button slot after the direct actions, for a
   * host whose last action is sometimes unavailable: the actions before it
   * keep their place instead of sliding right.
   */
  readonly reserveTrailingSlot?: boolean;
  /** Called once each time the menu opens, for hosts that read lazily. */
  readonly onOpen?: () => void;
}

/**
 * Registry connecting a mounted trigger button to its own `openAtPoint`, so a
 * host that only holds the row's DOM node (a right-click on the row, not the
 * button) can still open that row's existing menu, anchored at the pointer,
 * without threading an imperative handle through every intermediate slot.
 * Entries are added on mount/openAtPoint change and removed on unmount.
 */
const OPEN_AT_POINT_BY_TRIGGER = new WeakMap<
  HTMLButtonElement,
  (point: { x: number; y: number }) => void
>();

/** Stable hook for {@link openWorktreeActionsMenuAt} to find the trigger. */
const TRIGGER_SELECTOR = '[data-worktree-actions-trigger="true"]';

/**
 * Opens the `WorktreeActionsMenu` mounted somewhere inside `container`
 * (typically a row's own DOM element), anchored at `point`, mirroring the
 * legacy desktop rail's right-click-anywhere-on-the-row behavior. Returns
 * `false` when the row has no menu to open (for example, a menu emptied down
 * to nothing), so the caller can fall back to the browser's native menu.
 */
export function openWorktreeActionsMenuAt(
  container: HTMLElement,
  point: { x: number; y: number },
): boolean {
  const trigger = container.querySelector<HTMLButtonElement>(TRIGGER_SELECTOR);
  const openAtPoint = trigger
    ? OPEN_AT_POINT_BY_TRIGGER.get(trigger)
    : undefined;
  if (!openAtPoint) return false;
  openAtPoint(point);
  return true;
}

/**
 * Compact buttons {@link WorktreeActionsMenu} renders for these props on a
 * fine pointer: every direct action, plus the More trigger when the menu has
 * items. Hosts pass it to `WorktreeRow.actionChipButtonCount` so the row's
 * hover reserve always matches the chip. Keep it beside the render conditions
 * it mirrors (CAN-3053).
 */
export function worktreeActionsMenuButtonCount({
  items,
  directActions = [],
}: Pick<WorktreeActionsMenuProps, 'items' | 'directActions'>): number {
  return directActions.length + (items.length > 0 ? 1 : 0);
}

function enabledIndex(
  items: readonly WorktreeMenuItem[],
  edge: 'first' | 'last',
): number {
  if (edge === 'first')
    return items.findIndex((item) => !item.disabled && item.kind !== 'label');
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (!items[index]?.disabled && items[index]?.kind !== 'label') return index;
  }
  return -1;
}

function adjacentEnabledIndex(
  items: readonly WorktreeMenuItem[],
  from: number,
  step: 1 | -1,
): number {
  for (let offset = 1; offset <= items.length; offset += 1) {
    const index =
      (((from + step * offset) % items.length) + items.length) % items.length;
    if (!items[index]?.disabled && items[index]?.kind !== 'label') return index;
  }
  return -1;
}

export const WorktreeActionsMenu = forwardRef<
  HTMLButtonElement,
  WorktreeActionsMenuProps
>(function WorktreeActionsMenu(
  {
    items,
    accessibleLabel,
    triggerTestId,
    menuTestId,
    triggerDataAttributes,
    alwaysVisible = false,
    directActions = [],
    hideTriggerForFinePointer = false,
    reserveTrailingSlot = false,
    onOpen,
  },
  forwardedRef,
): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const contextMenuPlacement = useContextMenuPlacement();
  const [activeKey, setActiveKey] = useState<WorktreeMenuItemKey | null>(null);
  const [position, setPosition] = useState<{
    top: number;
    right: number;
  } | null>(null);
  // Set only for a right-click/context-menu-key open (`openAtPoint`); a
  // button-triggered open (`openAt`) clears it so the menu re-anchors to the
  // trigger the next time it opens normally.
  const [pointerAnchor, setPointerAnchor] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const activeIndexFromKey = items.findIndex(
    (item) => item.key === activeKey && !item.disabled,
  );
  const activeIndex =
    activeIndexFromKey === -1
      ? enabledIndex(items, 'first')
      : activeIndexFromKey;
  const itemCount = items.length;

  const setTriggerRef = useCallback(
    (node: HTMLButtonElement | null): void => {
      triggerRef.current = node;
      if (typeof forwardedRef === 'function') forwardedRef(node);
      else if (forwardedRef) forwardedRef.current = node;
    },
    [forwardedRef],
  );
  // Mirrors the legacy desktop rail's `updateActionsMenuPosition`
  // (`WorktreeItem.tsx`) exactly: a right-click anchor is treated as a
  // zero-height "trigger rect" at the pointer, then the same vertical-flip
  // and horizontal-clamp math applies to both anchor kinds. Without the
  // horizontal clamp, anchoring the menu's right edge directly at the
  // pointer pushed it off the left edge of the viewport for any right-click
  // on a left-docked rail (CAN-3053 follow-up).
  const updatePosition = useCallback((): void => {
    const VIEWPORT_PADDING = 8;
    const GAP = 4;
    // `position: fixed; right` resolves against the viewport minus any
    // reserved scrollbar gutter. The web portal sets
    // `html { scrollbar-gutter: stable }`, which narrows that box without
    // shrinking `window.innerWidth` or (in Chromium, while no scrollbar is
    // shown) `documentElement.clientWidth`; the root element's own layout
    // width is the one that matches. Height follows the viewport, not the
    // root's content height. jsdom lays nothing out, so fall back to
    // `window.inner*` when a measurement is zero.
    const viewportWidth =
      document.documentElement.getBoundingClientRect().width ||
      window.innerWidth;
    const viewportHeight =
      document.documentElement.clientHeight || window.innerHeight;
    // Early access: a right-click opens the menu at the pointer, flipping
    // where it would not fit (`placeContextMenuAtPoint`).
    if (pointerAnchor && contextMenuPlacement === 'cursor') {
      const menu = menuRef.current;
      if (!menu) return;
      const menuWidth = menu.offsetWidth;
      const { left, top } = placeContextMenuAtPoint({
        x: pointerAnchor.x,
        y: pointerAnchor.y,
        menuWidth,
        menuHeight: menu.offsetHeight,
        viewportWidth,
        viewportHeight,
      });
      const right = viewportWidth - left - menuWidth;
      setPosition((previous) =>
        previous && previous.top === top && previous.right === right
          ? previous
          : { top, right },
      );
      return;
    }
    let triggerRect: { top: number; bottom: number; right: number };
    if (pointerAnchor) {
      triggerRect = {
        top: pointerAnchor.y,
        bottom: pointerAnchor.y,
        right: pointerAnchor.x,
      };
    } else {
      const trigger = triggerRef.current;
      if (!trigger) return;
      triggerRect = trigger.getBoundingClientRect();
    }
    const menuHeight = menuRef.current?.offsetHeight ?? 0;
    const spaceBelow = viewportHeight - triggerRect.bottom - VIEWPORT_PADDING;
    const spaceAbove = triggerRect.top - VIEWPORT_PADDING;
    // Flip up only when the menu has been measured (menuHeight > 0) AND it
    // doesn't fit below AND it does fit above. Falls through to "drop down"
    // on the first render before the menu has measurable dimensions.
    const flipUp =
      menuHeight > 0 && menuHeight > spaceBelow && menuHeight <= spaceAbove;
    const unclampedTop = flipUp
      ? triggerRect.top - menuHeight - GAP
      : triggerRect.bottom + GAP;
    // Clamp vertically once measured, so a menu that fits neither fully
    // below nor fully above still stays entirely on-screen.
    const top =
      menuHeight > 0
        ? Math.min(
            Math.max(VIEWPORT_PADDING, unclampedTop),
            Math.max(
              VIEWPORT_PADDING,
              viewportHeight - menuHeight - VIEWPORT_PADDING,
            ),
          )
        : unclampedTop;
    // Clamp horizontally so the menu is always fully visible: the right
    // offset may not push the menu's LEFT edge past the viewport padding
    // (left edge = viewportWidth - right - menuWidth). Falls through
    // unclamped on the first render before the menu has measurable width.
    const menuWidth = menuRef.current?.offsetWidth ?? 0;
    const maxRight =
      menuWidth > 0
        ? viewportWidth - menuWidth - VIEWPORT_PADDING
        : Number.POSITIVE_INFINITY;
    const right = Math.max(
      VIEWPORT_PADDING,
      Math.min(viewportWidth - triggerRect.right, maxRight),
    );
    setPosition((previous) => {
      if (previous && previous.top === top && previous.right === right) {
        return previous;
      }
      return { top, right };
    });
  }, [pointerAnchor, contextMenuPlacement]);
  const closeAndReturnFocus = useCallback((): void => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);
  const openAt = useCallback(
    (index: number): void => {
      const item = items[index];
      if (items.length === 0) return;
      setPointerAnchor(null);
      setActiveKey(item?.key ?? null);
      setOpen(true);
    },
    [items],
  );
  // Opens the menu anchored at an arbitrary point (a right-click, or the
  // ContextMenu key, on the row rather than this trigger button).
  // Registered per trigger element in `OPEN_AT_POINT_BY_TRIGGER` below so a
  // host holding only the row's DOM node can still reach it.
  const openAtPoint = useCallback(
    (point: { x: number; y: number }): void => {
      const first = enabledIndex(items, 'first');
      setPointerAnchor(point);
      setActiveKey(first >= 0 ? (items[first]?.key ?? null) : null);
      setOpen(true);
    },
    [items],
  );
  useEffect(() => {
    const node = triggerRef.current;
    if (!node) return undefined;
    OPEN_AT_POINT_BY_TRIGGER.set(node, openAtPoint);
    return (): void => {
      OPEN_AT_POINT_BY_TRIGGER.delete(node);
    };
  }, [openAtPoint]);
  useEffect(() => {
    if (!open) setPointerAnchor(null);
  }, [open]);
  // The latest callback is read through a ref so a host passing a fresh
  // closure each render does not re-run the read while the menu stays open.
  const onOpenRef = useRef(onOpen);
  useEffect(() => {
    onOpenRef.current = onOpen;
  }, [onOpen]);
  useEffect(() => {
    if (open) onOpenRef.current?.();
  }, [open]);

  useOverlayEscape(open, closeAndReturnFocus);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    const handlePointerDown = (event: MouseEvent): void => {
      const target = event.target;
      if (
        !(target instanceof Node) ||
        triggerRef.current?.contains(target) ||
        menuRef.current?.contains(target) ||
        (target instanceof Element &&
          target.closest('[data-floating-menu-nested="true"]'))
      ) {
        return;
      }
      setOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return (): void => {
      document.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [itemCount, open, updatePosition]);

  useEffect(() => {
    if (open && position) {
      if (activeIndex >= 0) itemRefs.current[activeIndex]?.focus();
      else menuRef.current?.focus();
    }
  }, [activeIndex, open, position]);

  const selectItem = (item: WorktreeMenuItem): void => {
    if (item.disabled || !item.onSelect) return;
    item.onSelect();
    if (item.role !== 'menuitemradio') closeAndReturnFocus();
  };
  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === 'ArrowUp') {
      const last = enabledIndex(items, 'last');
      event.preventDefault();
      openAt(last);
    } else if (
      event.key === 'ArrowDown' ||
      event.key === 'Enter' ||
      event.key === ' '
    ) {
      const first = enabledIndex(items, 'first');
      event.preventDefault();
      openAt(first);
    }
  };
  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (
      !(event.target instanceof Node) ||
      !menuRef.current?.contains(event.target)
    )
      return;
    let nextIndex = -1;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      nextIndex = adjacentEnabledIndex(
        items,
        activeIndex,
        event.key === 'ArrowDown' ? 1 : -1,
      );
    } else if (event.key === 'Home' || event.key === 'End') {
      nextIndex = enabledIndex(items, event.key === 'Home' ? 'first' : 'last');
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const item = items[activeIndex];
      if (item) selectItem(item);
      return;
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeAndReturnFocus();
      return;
    } else if (event.key === 'Tab') {
      setOpen(false);
      return;
    } else {
      return;
    }
    event.preventDefault();
    const next = items[nextIndex];
    if (next) setActiveKey(next.key);
  };

  // Nothing to trigger, so no trigger. A host that withholds every row command
  // — the web rail on any route but `/chat`, which is navigation-only by
  // policy — otherwise rendered a "More actions" button whose click handler
  // opened at `items[-1]` and returned, i.e. a control that looked live on
  // hover and did nothing on press. Direct actions still render on their own.
  if (worktreeActionsMenuButtonCount({ items, directActions }) === 0)
    return null;

  return (
    <WorktreeRowActionChip
      menuOpen={open}
      // Early access (pointer-placed menus): the row stays lit while its menu
      // is open, so it is clear which row the menu acts on.
      marksRowWhileOpen={contextMenuPlacement === 'cursor'}
      alwaysVisible={alwaysVisible}
    >
      {directActions.map((action) => (
        <RailIconButton
          key={action.key}
          icon={action.icon}
          tone={action.tone}
          hoverSurface
          revealOnItemHover={!open && !alwaysVisible}
          aria-label={action.label}
          tooltipLabel={action.tooltip}
          disabled={action.disabled}
          data-testid={action.testId}
          className={action.className}
          onClick={(event) => {
            event.stopPropagation();
            if (action.disabled === true) return;
            action.onSelect();
          }}
        />
      ))}
      {reserveTrailingSlot && (
        <span
          aria-hidden="true"
          className="w-6 shrink-0 pointer-coarse:hidden"
        />
      )}
      {itemCount > 0 && (
        <RailIconButton
          ref={setTriggerRef}
          icon={MoreHorizontalIcon}
          hoverSurface
          revealOnItemHover={!open && !alwaysVisible}
          coarsePointerTarget
          className={
            hideTriggerForFinePointer ? 'pointer-fine:hidden' : undefined
          }
          aria-label="More actions"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          data-worktree-actions-trigger="true"
          {...triggerDataAttributes}
          data-testid={triggerTestId}
          onClick={(event) => {
            event.stopPropagation();
            if (open) setOpen(false);
            else openAt(enabledIndex(items, 'first'));
          }}
          onKeyDown={onTriggerKeyDown}
        />
      )}
      {open &&
        createPortal(
          <DropdownMenuSurface
            ref={menuRef}
            id={menuId}
            aria-label={accessibleLabel}
            aria-orientation="vertical"
            tabIndex={-1}
            data-testid={menuTestId}
            // A fixed compact width, as the sidebar's other menus have: a
            // long status line wraps rather than widening the menu.
            className="z-dropdown w-45"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={onMenuKeyDown}
            style={
              position
                ? {
                    position: 'fixed',
                    top: position.top,
                    right: position.right,
                  }
                : { position: 'fixed', visibility: 'hidden' }
            }
          >
            <ActionMenuRowStyle>
              {items.map((item, index) => {
                const menuItem =
                  item.kind === 'label' ? (
                    <ActionMenuLabelRow label={item.label} />
                  ) : item.kind === 'submenu' ? (
                    <NestedMenuFlyout
                      triggerRef={(node): void => {
                        itemRefs.current[index] = node;
                      }}
                      disabled={item.disabled}
                      tabIndex={index === activeIndex ? 0 : -1}
                      onTriggerFocus={(): void => setActiveKey(item.key)}
                      label={item.label}
                      leading={actionMenuRowIcon(items, index)}
                      triggerTestId={item.testId ?? item.key}
                      menuTestId={`${item.testId ?? item.key}-menu`}
                    >
                      <WorktreeActionMenuItems
                        items={item.submenu}
                        onSelect={selectItem}
                      />
                    </NestedMenuFlyout>
                  ) : (
                    <DropdownMenuItem
                      ref={(node) => {
                        itemRefs.current[index] = node;
                      }}
                      disabled={item.disabled}
                      title={item.tooltip}
                      tabIndex={index === activeIndex ? 0 : -1}
                      data-testid={item.testId}
                      tone={item.tone}
                      role={item.role}
                      aria-checked={
                        item.role === 'menuitemradio'
                          ? item.checked === true
                          : undefined
                      }
                      aria-busy={item.busy === true ? true : undefined}
                      onClick={() => selectItem(item)}
                    >
                      <DropdownMenuItemIcon>
                        {actionMenuRowIcon(items, index)}
                      </DropdownMenuItemIcon>
                      {item.label}
                      <ActionMenuShortcut shortcut={item.shortcut} />
                    </DropdownMenuItem>
                  );
                return (
                  <Fragment key={item.key}>
                    {item.separatorBefore && <DropdownMenuDivider />}
                    {item.sectionLabel !== undefined && (
                      <DropdownMenuLabel>{item.sectionLabel}</DropdownMenuLabel>
                    )}
                    <ActionMenuRichTooltip item={item}>
                      {menuItem}
                    </ActionMenuRichTooltip>
                    {item.sectionStatus && (
                      <SpaceNotificationMenuStatusLine
                        status={item.sectionStatus}
                        testId={item.sectionStatusTestId}
                      />
                    )}
                  </Fragment>
                );
              })}
            </ActionMenuRowStyle>
          </DropdownMenuSurface>,
          document.body,
        )}
    </WorktreeRowActionChip>
  );
});

WorktreeActionsMenu.displayName = 'WorktreeActionsMenu';
