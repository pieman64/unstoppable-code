'use client';

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { focusMenuRow } from '../lib/input-modality';
import { DropdownMenuSurface } from './DropdownMenu';
import {
  ActionMenuItems,
  ActionMenuRowStyle,
  type ActionMenuItem,
} from './ActionMenuItems';

/**
 * A right-click menu row. Tab, message and other point-anchored menus use the
 * same rows as every action menu: an icon on each row, groups split by
 * `separatorBefore`, and close or removal rows in the last group.
 */
export type TabContextMenuItem = ActionMenuItem;

export interface TabContextMenuProps {
  x: number;
  y: number;
  items: readonly TabContextMenuItem[];
  onClose: () => void;
  /**
   * The document that owns the element the menu was opened from. Defaults to
   * the renderer's global `document`. Pass the child document for a menu
   * opened inside a pulled-out auxiliary window so the menu portals into (and
   * clamps/positions against) that window instead of the main one.
   */
  ownerDocument?: Document;
  /** Optional root `data-testid` for the menu container. */
  dataTestId?: string;
  /**
   * Move focus to the first enabled item when the menu opens, so a menu
   * opened from the keyboard can be driven with the arrow keys right away.
   * Off by default: pointer-opened tab menus leave focus where it was.
   */
  focusOnOpen?: boolean;
}

const VIEWPORT_PADDING = 4;

const ENABLED_ITEM_SELECTOR = '[role="menuitem"]:not(:disabled)';

/**
 * Arrow-key, Home and End movement between the enabled items. Disabled items
 * are skipped; focus wraps at either end.
 */
function handleMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
  const { key } = event;
  if (
    key !== 'ArrowDown' &&
    key !== 'ArrowUp' &&
    key !== 'Home' &&
    key !== 'End'
  ) {
    return;
  }
  const items = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(ENABLED_ITEM_SELECTOR),
  );
  if (items.length === 0) return;
  event.preventDefault();
  const active = event.currentTarget.ownerDocument.activeElement;
  const current = items.findIndex((item) => item === active);
  const next =
    key === 'Home'
      ? 0
      : key === 'End'
        ? items.length - 1
        : key === 'ArrowDown'
          ? (current + 1) % items.length
          : current <= 0
            ? items.length - 1
            : current - 1;
  items[next]?.focus();
}

export function TabContextMenu({
  x,
  y,
  items,
  onClose,
  ownerDocument,
  dataTestId,
  focusOnOpen = false,
}: TabContextMenuProps): JSX.Element | null {
  const doc = ownerDocument ?? document;
  const view = doc.defaultView ?? window;
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number }>({
    top: y,
    left: x,
  });

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    let nextLeft = x;
    let nextTop = y;
    if (nextLeft + rect.width > view.innerWidth - VIEWPORT_PADDING) {
      nextLeft = Math.max(
        VIEWPORT_PADDING,
        view.innerWidth - rect.width - VIEWPORT_PADDING,
      );
    }
    if (nextTop + rect.height > view.innerHeight - VIEWPORT_PADDING) {
      nextTop = Math.max(
        VIEWPORT_PADDING,
        view.innerHeight - rect.height - VIEWPORT_PADDING,
      );
    }
    setPosition({ top: nextTop, left: nextLeft });
  }, [x, y, view]);

  useEffect(() => {
    if (!focusOnOpen) return;
    // A right-click open leaves the row unpainted; see `focusMenuRow`.
    const first = menuRef.current?.querySelector<HTMLElement>(
      ENABLED_ITEM_SELECTOR,
    );
    if (first) focusMenuRow(first, { preventScroll: true });
  }, [focusOnOpen]);

  useEffect(() => {
    const handleMouseDown = (event: MouseEvent): void => {
      const menu = menuRef.current;
      // A menu portaled into an auxiliary window receives nodes from that
      // window's realm. Testing against the opener's Node dismisses the menu
      // on mousedown, before its Rename item can receive the click.
      if (
        event.target instanceof view.Node &&
        (menu?.contains(event.target) ||
          // A submenu opens in its own layer beside the menu.
          (event.target instanceof view.Element &&
            event.target.closest('[data-floating-menu-nested="true"]')))
      ) {
        return;
      }
      onClose();
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    const handleDismiss = (): void => onClose();
    doc.addEventListener('mousedown', handleMouseDown, true);
    doc.addEventListener('keydown', handleKeyDown);
    view.addEventListener('resize', handleDismiss);
    view.addEventListener('blur', handleDismiss);
    return (): void => {
      doc.removeEventListener('mousedown', handleMouseDown, true);
      doc.removeEventListener('keydown', handleKeyDown);
      view.removeEventListener('resize', handleDismiss);
      view.removeEventListener('blur', handleDismiss);
    };
  }, [onClose, doc, view]);

  if (!doc.body) return null;

  const selectItem = (item: TabContextMenuItem): void => {
    if (item.disabled || !item.onSelect) return;
    item.onSelect();
    if (item.role !== 'menuitemradio') onClose();
  };

  return createPortal(
    <DropdownMenuSurface
      ref={menuRef}
      data-testid={dataTestId}
      style={{ position: 'fixed', top: position.top, left: position.left }}
      className="z-dropdown min-w-45"
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={handleMenuKeyDown}
    >
      <ActionMenuRowStyle>
        <ActionMenuItems items={items} onSelect={selectItem} />
      </ActionMenuRowStyle>
    </DropdownMenuSurface>,
    doc.body,
  );
}
