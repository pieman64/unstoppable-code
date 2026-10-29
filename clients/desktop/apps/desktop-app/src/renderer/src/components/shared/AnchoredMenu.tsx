import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type ReactNode,
  type RefObject,
} from 'react';
import { pushMenuOpenBodyFlag } from '@canopy/ui-shared/lib';
import { getDocument as getMenuFlagDocument } from '@canopy/ui-shared/panels';
import { createPortal } from 'react-dom';
import {
  DropdownMenuSurface,
  DropdownMenuRowStyleProvider,
  DEFAULT_MENU_ROW_STYLE,
  QUIET_MENU_ROW_STYLE,
  placeContextMenuAtPoint,
  useContextMenuPlacement,
} from '@canopy/ui-shared';
import { getDocument, getWindow } from '@canopy/ui-shared/panels';
import { useCloseOnOutsideMouseDown } from '@/hooks/useCloseOnOutsideMouseDown';

export type AnchoredMenuPlacement =
  | 'below-start'
  | 'above-start'
  | 'right-start';

export interface AnchoredMenuProps {
  /** Whether the menu is rendered. Returns `null` when false. */
  open: boolean;
  /** Called when an outside mousedown or Escape closes the menu. */
  onClose: () => void;
  /**
   * The element that toggles this menu. Clicks on the anchor are excluded
   * from the outside-click close so the anchor can toggle itself. Also used
   * as the positioning anchor in `portal` mode.
   */
  anchorRef: RefObject<HTMLElement | null>;
  /**
   * Optional fixed viewport point (e.g. a right-click position) to anchor
   * from instead of `anchorRef`'s rect. Portal mode only.
   */
  anchorPoint?: { x: number; y: number } | null;
  /** Placement relative to the anchor. */
  placement: AnchoredMenuPlacement;
  /**
   * Render the menu in a portal at `document.body`, positioned `fixed` from
   * the anchor's rect (recomputed on scroll/resize). Use this when the menu
   * would otherwise be clipped by an ancestor's `overflow` (e.g. inside the
   * sidebar's scroll container). Defaults to the CSS-only absolute mode.
   */
  portal?: boolean;
  className?: string;
  children: ReactNode;
  /** Optional `data-testid` passthrough for the menu container. */
  testId?: string;
}

/** Gap (px) between the anchor and the menu in portal mode (matches mt-1/etc). */
const PORTAL_GAP_PX = 4;
/** Minimum inset (px) from the viewport edges in portal mode. */
const PORTAL_VIEWPORT_PADDING_PX = 8;

/**
 * Small reusable anchored popover for menus. By default renders `absolute`
 * inside a relatively-positioned wrapper the caller provides — no portal, no
 * measuring. Pass `portal` to escape ancestor `overflow` clipping by
 * rendering `fixed` in a `document.body` portal, positioned from the anchor's
 * bounding rect. Intentionally desktop-local (not `@canopy/ui-shared`)
 * because it owns open/close interaction state.
 */
export function AnchoredMenu({
  open,
  onClose,
  anchorRef,
  anchorPoint = null,
  placement,
  portal = false,
  className,
  children,
  testId,
}: AnchoredMenuProps): JSX.Element | null {
  const menuRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<CSSProperties | null>(null);
  const contextMenuPlacement = useContextMenuPlacement();
  // Early access: quieter rows (small text, tertiary icons).
  const rowStyle =
    contextMenuPlacement === 'cursor'
      ? QUIET_MENU_ROW_STYLE
      : DEFAULT_MENU_ROW_STYLE;

  useCloseOnOutsideMouseDown(open, anchorRef, menuRef, onClose, true);
  useEffect(() => {
    if (!open) {
      return;
    }
    // Any open menu suppresses background hover feedback app-wide.
    return pushMenuOpenBodyFlag(getMenuFlagDocument(anchorRef.current));
  }, [open, anchorRef]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    // Listen on the document that owns the anchor so Escape works when the
    // menu (and its anchor) live in a popped-out aux window.
    const doc = getDocument(anchorRef.current);
    doc.addEventListener('keydown', handleKeyDown);
    return (): void => {
      doc.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, onClose, anchorRef]);

  // Compute the fixed position from the anchor's rect (portal mode only),
  // clamped to the viewport once the menu has been measured.
  const updatePosition = useCallback((): void => {
    let rect: { top: number; bottom: number; left: number; right: number };
    if (anchorPoint) {
      rect = {
        top: anchorPoint.y,
        bottom: anchorPoint.y,
        left: anchorPoint.x,
        right: anchorPoint.x,
      };
    } else {
      const anchor = anchorRef.current;
      if (!anchor) return;
      rect = anchor.getBoundingClientRect();
    }
    const view = getWindow(anchorRef.current);
    const menu = menuRef.current;
    const width = menu?.offsetWidth ?? 0;
    const height = menu?.offsetHeight ?? 0;
    const pad = PORTAL_VIEWPORT_PADDING_PX;

    // Early access: a right-click opens the menu at the pointer, flipping
    // where it would not fit (`placeContextMenuAtPoint`).
    if (anchorPoint && contextMenuPlacement === 'cursor') {
      setCoords(
        placeContextMenuAtPoint({
          x: anchorPoint.x,
          y: anchorPoint.y,
          menuWidth: width,
          menuHeight: height,
          viewportWidth: view.innerWidth,
          viewportHeight: view.innerHeight,
          viewportPadding: pad,
        }),
      );
      return;
    }

    let next: CSSProperties;
    if (placement === 'above-start') {
      next = {
        bottom: view.innerHeight - rect.top + PORTAL_GAP_PX,
        left: rect.left,
      };
    } else if (placement === 'right-start') {
      next = { top: rect.top, left: rect.right + PORTAL_GAP_PX };
    } else {
      next = { top: rect.bottom + PORTAL_GAP_PX, left: rect.left };
    }

    if (typeof next.left === 'number' && width) {
      const maxLeft = Math.max(pad, view.innerWidth - width - pad);
      next.left = Math.min(Math.max(pad, next.left), maxLeft);
    }
    if (typeof next.top === 'number' && height) {
      const maxTop = Math.max(pad, view.innerHeight - height - pad);
      next.top = Math.min(Math.max(pad, next.top), maxTop);
    }

    setCoords(next);
  }, [anchorRef, anchorPoint, placement, contextMenuPlacement]);

  useLayoutEffect((): (() => void) | void => {
    if (!portal || !open) {
      setCoords(null);
      return;
    }
    updatePosition();
    const view = getWindow(anchorRef.current);
    const frame = view.requestAnimationFrame(updatePosition);
    return (): void => view.cancelAnimationFrame(frame);
  }, [portal, open, updatePosition, anchorRef]);

  useEffect((): (() => void) | void => {
    if (!portal || !open) return;
    const view = getWindow(anchorRef.current);
    let frame: number | null = null;
    const schedule = (): void => {
      if (frame !== null) return;
      frame = view.requestAnimationFrame((): void => {
        frame = null;
        updatePosition();
      });
    };
    view.addEventListener('resize', schedule);
    view.addEventListener('scroll', schedule, {
      capture: true,
      passive: true,
    });
    return (): void => {
      if (frame !== null) view.cancelAnimationFrame(frame);
      view.removeEventListener('resize', schedule);
      view.removeEventListener('scroll', schedule, { capture: true });
    };
  }, [portal, open, updatePosition, anchorRef]);

  if (!open) {
    return null;
  }

  if (portal) {
    const style: CSSProperties = {
      position: 'fixed',
      ...(coords ?? { visibility: 'hidden', top: 0, left: 0 }),
    };
    return createPortal(
      <DropdownMenuSurface
        ref={menuRef}
        className={`z-dropdown ${className ?? ''}`}
        style={style}
        data-testid={testId}
      >
        <DropdownMenuRowStyleProvider value={rowStyle}>
          {children}
        </DropdownMenuRowStyleProvider>
      </DropdownMenuSurface>,
      getDocument(anchorRef.current).body,
    );
  }

  // Literal placement, so the design-system lint can read what this wrapper
  // owns: the position beside the anchor and the 4px gap PORTAL_GAP_PX
  // mirrors.
  const placementClassName =
    placement === 'below-start'
      ? 'absolute left-0 top-full mt-1'
      : placement === 'above-start'
        ? 'absolute left-0 bottom-full mb-1'
        : 'absolute left-full top-0 ml-1';

  return (
    <DropdownMenuSurface
      ref={menuRef}
      className={
        className ? `${placementClassName} ${className}` : placementClassName
      }
      data-testid={testId}
    >
      <DropdownMenuRowStyleProvider value={rowStyle}>
        {children}
      </DropdownMenuRowStyleProvider>
    </DropdownMenuSurface>
  );
}
