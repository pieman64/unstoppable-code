'use client';

import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type Ref,
  type RefObject,
} from 'react';
import { focusableWithin } from '../lib/focusable';
import { focusMenuRow } from '../lib/input-modality';
import { suppressNextClick } from '../lib/suppress-next-click';
import { pushMenuOpenBodyFlag } from '../lib/menu-open-body-flag';
import { createPortal, flushSync } from 'react-dom';
import { getDocument, getWindow } from '../panels/window-registry';
import {
  DropdownMenuSurface,
  type DropdownMenuSurfaceProps,
} from './DropdownMenu';
import { OverlayScrollArea } from './OverlayScrollArea';

export type FloatingMenuPlacement =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right';

type FloatingMenuSide = 'top' | 'bottom';
type FloatingMenuAlignment = 'left' | 'center' | 'right';

export interface FloatingMenuPositionInput {
  readonly anchorRect: Pick<
    DOMRect,
    'top' | 'right' | 'bottom' | 'left' | 'width'
  >;
  readonly menuWidth: number;
  readonly menuHeight: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly placement: FloatingMenuPlacement;
  readonly allowFlip?: boolean;
  readonly gap?: number;
  readonly viewportPadding?: number;
}

export interface FloatingMenuPosition {
  readonly top: number;
  readonly left: number;
  readonly maxHeight: number;
  readonly placement: FloatingMenuPlacement;
  readonly transformOrigin: string;
}

/** Chromium's `focusVisible` focus option, not yet in TypeScript's DOM lib. */
interface FocusWithoutRingOptions extends FocusOptions {
  readonly focusVisible?: boolean;
}

export interface FloatingMenuProps extends Omit<
  DropdownMenuSurfaceProps,
  'children'
> {
  /** Disable when a composite owns trigger keys and anchors on a larger surface. */
  readonly openOnArrowKeys?: boolean;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly anchorRef: RefObject<HTMLElement | null>;
  /**
   * Lines the menu's horizontal edges up with this element while
   * `anchorRef` still sets the vertical side and gap (a composer control
   * whose menu should share the composer's left edge).
   */
  readonly alignRef?: RefObject<HTMLElement | null>;
  /**
   * Moves the menu's horizontal edges by this many pixels (negative is
   * left), so its row content can line up with the trigger's own content.
   */
  readonly alignOffset?: number;
  /**
   * Optional focus target when positioning is anchored to a non-interactive
   * wrapper (for example, a complete sidebar row containing adjacent actions).
   * Defaults to `anchorRef`.
   */
  readonly returnFocusRef?: RefObject<HTMLElement | null>;
  readonly placement?: FloatingMenuPlacement;
  readonly allowFlip?: boolean;
  readonly gap?: number;
  readonly viewportPadding?: number;
  /** Optional intrinsic height cap applied before collision placement. */
  readonly heightLimit?: number;
  /** Keep multi-select menus open after activating an enabled row. */
  readonly closeOnSelect?: boolean;
  /**
   * Optional first focus target for a searchable/manual composite. Focus is
   * applied only after the portaled surface has its resolved position.
   */
  readonly initialFocusRef?: RefObject<HTMLElement | null>;
  /** Pointer-opened submenus preserve focus until keyboard activation. */
  readonly focusOnOpen?: boolean;
  /**
   * The keyboard/focus contract owned by the floating layer. `menu` is the
   * action-menu default, `listbox` applies the same roving behavior to
   * `role="option"` rows, and `manual` leaves focus/navigation to a composite
   * picker such as a searchable dialog while retaining dismissal/positioning.
   */
  readonly interaction?: 'menu' | 'listbox' | 'manual';
  /**
   * Keep keyboard focus inside the surface while it is open, as a modeless
   * `role="dialog"` requires.
   *
   * `manual` alone is not enough for a dialog: it deliberately leaves focus on
   * the trigger and closes on ANY Tab (the inside-the-surface early return
   * below is skipped for `manual`), so a surface whose contents are meant to
   * be operated — buttons, toggles, links — is reachable by pointer only. With
   * this flag, opening focuses the first focusable descendant (unless
   * `initialFocusRef` names one) and Tab/Shift+Tab cycle within the surface
   * instead of dismissing it. Escape and outside-press dismissal are
   * unchanged, so this is a focus contract, not a modal one.
   *
   * Opt-in: composites that intentionally want Tab to commit-and-leave (the
   * searchable pickers built on `manual`) must not set it.
   *
   * Note the exit contract: both Tab and Shift+Tab cycle within the surface,
   * so Escape (or an outside press) is the only keyboard way out. Consumers
   * must keep that discoverable — this is a total keyboard trap for as long
   * as the surface is open, even though the surface is not `aria-modal`.
   *
   * Pair this with `interaction="manual"`. For `menu`/`listbox` the
   * inside-the-surface early return in the document key handler fires first,
   * so a Tab raised inside the surface never reaches the trap and escapes the
   * portal normally — the flag would apply only to Tabs raised outside, which
   * is worse than not setting it.
   */
  readonly trapFocus?: boolean;
  /**
   * Optional element whose subtree is treated as part of this surface for
   * OUTSIDE-PRESS purposes, in addition to the trigger and the surface itself.
   *
   * A trigger that sits in a cluster of sibling controls (a banner with its own
   * dismiss button) would otherwise have every one of those siblings read as an
   * outside press: the surface closes AND `suppressNextClick` swallows the
   * click, so the sibling's own handler never runs and the user has to click it
   * twice. Pointing this at the shared container makes the cluster one
   * interaction boundary.
   */
  readonly outsidePressBoundaryRef?: RefObject<HTMLElement | null>;
  /**
   * Optional element where any press still dismisses this surface but is
   * not swallowed: the click goes on to whatever is under the pointer. For a
   * surface attached to a composer, a press on the composer's own controls
   * (send, attach) is a deliberate action, not a dismissal gesture. Presses
   * inside `outsidePressBoundaryRef` keep the surface open, as before.
   */
  readonly outsidePressClickThroughRef?: RefObject<HTMLElement | null>;
  /**
   * Marks this surface as a NESTED menu (a submenu flyout). Nested surfaces
   * portal to the document body like every other floating menu, so without
   * this marker an ancestor menu treats a click inside them as an outside
   * pointerdown and unmounts the whole tree before the click can activate.
   */
  readonly nested?: boolean;
  /**
   * Entry motion. `enter` is the shared scale-and-fade; `none` mounts the
   * surface in place, for high-frequency surfaces such as context menus and
   * the composer's plus menu, where the motion would only delay the rows.
   */
  readonly motion?: 'enter' | 'none';
  readonly children: DropdownMenuSurfaceProps['children'];
}

export const FLOATING_MENU_GAP = 4;
export const FLOATING_PICKER_GAP = 8;
/**
 * The chat composer's settings row: menus opened from the row under the box
 * (permission, model, effort, usage) sit 4px above their trigger, so they
 * overlap the box's lower edge rather than floating clear of it.
 */
export const COMPOSER_ROW_MENU_GAP = 4;
export const FLOATING_MENU_VIEWPORT_PADDING = 8;

const MENU_ITEM_SELECTOR = [
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
].join(',');
const LISTBOX_ITEM_SELECTOR = '[role="option"]';
function splitPlacement(placement: FloatingMenuPlacement): {
  side: FloatingMenuSide;
  alignment: FloatingMenuAlignment;
} {
  const [side, alignment] = placement.split('-') as [
    FloatingMenuSide,
    FloatingMenuAlignment,
  ];
  return { side, alignment };
}

function placementName(
  side: FloatingMenuSide,
  alignment: FloatingMenuAlignment,
): FloatingMenuPlacement {
  return `${side}-${alignment}`;
}

function nearestAlignment(
  anchorPoint: number,
  menuLeft: number,
  menuWidth: number,
): FloatingMenuAlignment {
  const candidates: ReadonlyArray<{
    alignment: FloatingMenuAlignment;
    point: number;
  }> = [
    { alignment: 'left', point: menuLeft },
    { alignment: 'center', point: menuLeft + menuWidth / 2 },
    { alignment: 'right', point: menuLeft + menuWidth },
  ];
  return candidates.reduce((closest, candidate) =>
    Math.abs(candidate.point - anchorPoint) <
    Math.abs(closest.point - anchorPoint)
      ? candidate
      : closest,
  ).alignment;
}

function transformOriginForPlacement(placement: FloatingMenuPlacement): string {
  const { side, alignment } = splitPlacement(placement);
  return `${side === 'bottom' ? 'top' : 'bottom'} ${alignment}`;
}

/**
 * Pure collision geometry for the shared action-menu layer.
 *
 * The preferred vertical side flips only when it cannot fit and the opposite
 * side has more room. Horizontal positioning shifts inside the viewport, then
 * resolves the closest left/center/right anchor so entry motion grows from the
 * final collision-adjusted attachment point.
 */
export function computeFloatingMenuPosition({
  anchorRect,
  menuWidth,
  menuHeight,
  viewportWidth,
  viewportHeight,
  placement,
  allowFlip = true,
  gap = FLOATING_MENU_GAP,
  viewportPadding = FLOATING_MENU_VIEWPORT_PADDING,
}: FloatingMenuPositionInput): FloatingMenuPosition {
  const preferred = splitPlacement(placement);
  const availableTop = Math.max(0, anchorRect.top - gap - viewportPadding);
  const availableBottom = Math.max(
    0,
    viewportHeight - anchorRect.bottom - gap - viewportPadding,
  );
  const preferredAvailable =
    preferred.side === 'top' ? availableTop : availableBottom;
  const oppositeAvailable =
    preferred.side === 'top' ? availableBottom : availableTop;
  const side =
    allowFlip &&
    menuHeight > preferredAvailable &&
    oppositeAvailable > preferredAvailable
      ? preferred.side === 'top'
        ? 'bottom'
        : 'top'
      : preferred.side;
  const maxHeight = side === 'top' ? availableTop : availableBottom;
  const effectiveHeight = Math.min(menuHeight, maxHeight);
  const maxMenuWidth = Math.max(0, viewportWidth - viewportPadding * 2);
  const effectiveWidth = Math.min(menuWidth, maxMenuWidth);

  let preferredLeft: number;
  let horizontalAnchorPoint: number;
  if (preferred.alignment === 'center') {
    horizontalAnchorPoint = anchorRect.left + anchorRect.width / 2;
    preferredLeft = horizontalAnchorPoint - effectiveWidth / 2;
  } else if (preferred.alignment === 'right') {
    horizontalAnchorPoint = anchorRect.right;
    preferredLeft = anchorRect.right - effectiveWidth;
  } else {
    horizontalAnchorPoint = anchorRect.left;
    preferredLeft = anchorRect.left;
  }

  const maxLeft = Math.max(
    viewportPadding,
    viewportWidth - effectiveWidth - viewportPadding,
  );
  const left = Math.min(Math.max(viewportPadding, preferredLeft), maxLeft);
  const maxTop = Math.max(
    viewportPadding,
    viewportHeight - effectiveHeight - viewportPadding,
  );
  const preferredTop =
    side === 'bottom'
      ? anchorRect.bottom + gap
      : anchorRect.top - gap - effectiveHeight;
  const top = Math.min(Math.max(viewportPadding, preferredTop), maxTop);
  const resolvedAlignment = nearestAlignment(
    horizontalAnchorPoint,
    left,
    effectiveWidth,
  );
  const resolvedPlacement = placementName(side, resolvedAlignment);

  return {
    top,
    left,
    maxHeight,
    placement: resolvedPlacement,
    transformOrigin: transformOriginForPlacement(resolvedPlacement),
  };
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === 'function') ref(value);
  else if (ref) ref.current = value;
}

function enabledItems(menu: HTMLElement, selector: string): HTMLElement[] {
  return Array.from(menu.querySelectorAll<HTMLElement>(selector)).filter(
    (item) =>
      !(item as HTMLButtonElement).disabled &&
      item.getAttribute('aria-disabled') !== 'true' &&
      !item.hidden &&
      item.getAttribute('aria-hidden') !== 'true',
  );
}

function focusMenuItem(item: HTMLElement | undefined): void {
  if (!item) return;
  item.focus();
  item.scrollIntoView?.({ block: 'nearest' });
}

/**
 * Shared portaled action menu.
 *
 * Owns owner-document-aware placement, collision handling, entry motion,
 * outside/Escape/Tab dismissal, and roving menu focus. Callers own only the
 * controlled open state, trigger markup, menu width, and action contents.
 */
export const FloatingMenu = forwardRef<HTMLDivElement, FloatingMenuProps>(
  function FloatingMenu(
    {
      open,
      onOpenChange,
      anchorRef,
      alignRef,
      alignOffset = 0,
      returnFocusRef,
      placement = 'bottom-left',
      allowFlip = true,
      gap = FLOATING_MENU_GAP,
      viewportPadding = FLOATING_MENU_VIEWPORT_PADDING,
      heightLimit,
      closeOnSelect = true,
      nested = false,
      initialFocusRef,
      focusOnOpen = true,
      interaction = 'menu',
      trapFocus = false,
      outsidePressBoundaryRef,
      openOnArrowKeys = true,
      outsidePressClickThroughRef,
      motion = 'enter',
      className = '',
      id: idProp,
      onClick,
      onKeyDown,
      style,
      children,
      ...props
    },
    forwardedRef,
  ): JSX.Element | null {
    const generatedId = useId();
    const menuId = idProp ?? generatedId;
    const menuRef = useRef<HTMLDivElement | null>(null);
    const scrollViewportRef = useRef<HTMLDivElement | null>(null);
    const [position, setPosition] = useState<FloatingMenuPosition | null>(null);
    const initialItemFocusRef = useRef<'first' | 'last'>('first');
    const focusedForOpenRef = useRef(false);
    const typeaheadRef = useRef({ value: '', at: 0 });
    const managesScrollViewport = interaction !== 'manual';

    const setMenuRef = useCallback(
      (node: HTMLDivElement | null): void => {
        menuRef.current = node;
        assignRef(forwardedRef, node);
      },
      [forwardedRef],
    );

    const updatePosition = useCallback((): void => {
      const anchor = anchorRef.current;
      const menu = menuRef.current;
      if (!anchor || !menu) return;
      const view = getWindow(anchor);
      const triggerRect = anchor.getBoundingClientRect();
      const alignRect = alignRef?.current?.getBoundingClientRect();
      const edges = alignRect ?? triggerRect;
      const anchorRect = {
        top: triggerRect.top,
        bottom: triggerRect.bottom,
        left: edges.left + alignOffset,
        right: edges.right + alignOffset,
        width: edges.width,
      };
      // Consumers can follow the anchor width without a second resize observer.
      const anchorWidth = `${anchorRect.width}px`;
      if (
        menu.style.getPropertyValue('--floating-menu-anchor-width') !==
        anchorWidth
      ) {
        menu.style.setProperty('--floating-menu-anchor-width', anchorWidth);
      }
      const scrollViewport = scrollViewportRef.current;
      // offsetWidth rounds fractional menu rows; transformed bounds include
      // the entry animation's scale. Resolved CSS width keeps layout precision.
      const menuStyle = view.getComputedStyle(menu);
      const cssWidth = Number.parseFloat(menuStyle.width);
      const horizontalInsets =
        menuStyle.boxSizing === 'border-box'
          ? 0
          : [
              menuStyle.paddingLeft,
              menuStyle.paddingRight,
              menuStyle.borderLeftWidth,
              menuStyle.borderRightWidth,
            ].reduce(
              (total, value) => total + (Number.parseFloat(value) || 0),
              0,
            );
      const menuWidth = Number.isFinite(cssWidth)
        ? cssWidth + horizontalInsets
        : menu.offsetWidth;
      const intrinsicMenuHeight = scrollViewport
        ? scrollViewport.scrollHeight +
          Math.max(0, menu.offsetHeight - scrollViewport.clientHeight)
        : Math.max(menu.scrollHeight, menu.offsetHeight);
      const next = computeFloatingMenuPosition({
        anchorRect,
        menuWidth,
        menuHeight: Math.min(
          intrinsicMenuHeight,
          heightLimit ?? Number.POSITIVE_INFINITY,
        ),
        viewportWidth: view.innerWidth,
        viewportHeight: view.innerHeight,
        placement,
        allowFlip,
        gap,
        viewportPadding,
      });
      const constrainedNext =
        heightLimit === undefined
          ? next
          : { ...next, maxHeight: Math.min(next.maxHeight, heightLimit) };
      // Composites that own an inner scroller (the model picker's tabbed
      // layout) cap themselves to the room the surface actually has.
      const maxHeight = `${constrainedNext.maxHeight}px`;
      if (
        menu.style.getPropertyValue('--floating-menu-max-height') !== maxHeight
      ) {
        menu.style.setProperty('--floating-menu-max-height', maxHeight);
      }
      setPosition((previous) =>
        previous &&
        previous.top === constrainedNext.top &&
        previous.left === constrainedNext.left &&
        previous.maxHeight === constrainedNext.maxHeight &&
        previous.placement === constrainedNext.placement
          ? previous
          : constrainedNext,
      );
    }, [
      anchorRef,
      alignRef,
      alignOffset,
      allowFlip,
      gap,
      heightLimit,
      placement,
      viewportPadding,
    ]);

    useLayoutEffect((): void => {
      if (!open) {
        setPosition(null);
        focusedForOpenRef.current = false;
        initialItemFocusRef.current = 'first';
        return;
      }
      updatePosition();
    }, [open, updatePosition]);

    useLayoutEffect((): (() => void) | void => {
      if (!open) return;
      const anchor = anchorRef.current;
      const menu = menuRef.current;
      if (!anchor || !menu) return;
      const view = getWindow(anchor);
      let frame: number | null = null;
      const schedulePosition = (): void => {
        if (frame !== null) return;
        frame = view.requestAnimationFrame(() => {
          frame = null;
          updatePosition();
        });
      };
      // Size changes reposition before paint. ResizeObserver delivers after
      // layout and before paint, so committing here keeps a menu whose
      // content shrinks or grows (a model picker tab switch) anchored to its
      // trigger instead of painting one frame shrunk away from it.
      const repositionBeforePaint = (): void => {
        if (frame !== null) {
          view.cancelAnimationFrame(frame);
          frame = null;
        }
        flushSync(updatePosition);
      };
      const observer =
        typeof view.ResizeObserver === 'function'
          ? new view.ResizeObserver(repositionBeforePaint)
          : null;
      observer?.observe(anchor);
      observer?.observe(menu);
      if (scrollViewportRef.current) {
        observer?.observe(scrollViewportRef.current);
      }
      view.addEventListener('resize', schedulePosition);
      view.addEventListener('scroll', schedulePosition, {
        capture: true,
        passive: true,
      });
      return (): void => {
        if (frame !== null) view.cancelAnimationFrame(frame);
        observer?.disconnect();
        view.removeEventListener('resize', schedulePosition);
        view.removeEventListener('scroll', schedulePosition, {
          capture: true,
        });
      };
    }, [anchorRef, open, updatePosition]);

    useEffect((): (() => void) | void => {
      if (!openOnArrowKeys) return;
      const trigger = anchorRef.current;
      if (!trigger) return;
      const handleTriggerKeyDown = (event: globalThis.KeyboardEvent): void => {
        if (open || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) {
          return;
        }
        event.preventDefault();
        initialItemFocusRef.current =
          event.key === 'ArrowUp' ? 'last' : 'first';
        onOpenChange(true);
      };
      trigger.addEventListener('keydown', handleTriggerKeyDown);
      return (): void =>
        trigger.removeEventListener('keydown', handleTriggerKeyDown);
    }, [anchorRef, onOpenChange, open, openOnArrowKeys]);

    useEffect((): (() => void) | void => {
      if (!open) return;
      const trigger = anchorRef.current;
      const doc = getDocument(trigger);
      const NodeConstructor = doc.defaultView?.Node;

      const handlePointerDown = (event: PointerEvent): void => {
        if (
          !NodeConstructor ||
          !(event.target instanceof NodeConstructor) ||
          trigger?.contains(event.target) ||
          menuRef.current?.contains(event.target) ||
          outsidePressBoundaryRef?.current?.contains(event.target)
        ) {
          return;
        }
        // A nested flyout is a sibling in the body, so its clicks would read
        // as "outside" and tear this menu (and the flyout) down before the
        // click activates. Ignore them; the nested menu owns its own
        // dismissal, and closing it closes this menu through the same path.
        const ElementConstructor = doc.defaultView?.Element;
        if (
          ElementConstructor &&
          event.target instanceof ElementConstructor &&
          event.target.closest('[data-floating-menu-nested="true"]') !== null
        ) {
          return;
        }
        // The press only dismisses — swallow the click it completes so the
        // element under the pointer is not activated. A NESTED flyout never
        // suppresses: its parent hierarchy owns outside-dismissal semantics,
        // and eating the click here broke both parent-row activation (the
        // hover-out grace period keeps the flyout mounted while the pointer
        // is over a parent row) and the parent trigger's own toggle. For a
        // genuinely outside press the parent's handler still suppresses.
        // A press inside the click-through region dismisses and still
        // activates its target.
        if (
          !nested &&
          !outsidePressClickThroughRef?.current?.contains(event.target)
        ) {
          suppressNextClick(doc);
        }
        onOpenChange(false);
      };
      const handleDocumentKeyDown = (event: globalThis.KeyboardEvent): void => {
        if (event.defaultPrevented) return;
        if (
          NodeConstructor &&
          event.target instanceof NodeConstructor &&
          menuRef.current?.contains(event.target) &&
          interaction !== 'manual'
        ) {
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          onOpenChange(false);
          (returnFocusRef?.current ?? trigger)?.focus({ preventScroll: true });
        } else if (event.key === 'Tab') {
          // A focus-trapping surface keeps Tab; everything else treats it as
          // commit-and-leave and dismisses.
          //
          // Scope matters: this listener is on the DOCUMENT, so without the
          // containment check an open surface would capture Tab from unrelated
          // UI. That is reachable — the command/file palettes and Settings
          // open by keyboard shortcut, which neither presses outside nor sends
          // Escape, so both can be open at once and Tab would yank focus out
          // of the palette and into this surface.
          const surface = menuRef.current;
          if (trapFocus && surface && surface.contains(doc.activeElement)) {
            const items = focusableWithin(surface);
            if (items.length === 0) {
              // Nothing to cycle to yet. Hold the surface and the focus rather
              // than dismissing: an asynchronously populated body is empty on
              // first paint, and closing here would destroy it on the user's
              // first keystroke and drop focus to <body>.
              event.preventDefault();
              surface.focus();
              return;
            }
            event.preventDefault();
            // `activeElement` may sit inside a stop rather than being it.
            const currentIndex = items.findIndex((item) =>
              item.contains(doc.activeElement),
            );
            const step = event.shiftKey ? -1 : 1;
            const nextIndex =
              currentIndex === -1
                ? event.shiftKey
                  ? items.length - 1
                  : 0
                : (currentIndex + step + items.length) % items.length;
            items[nextIndex]?.focus();
            return;
          }
          onOpenChange(false);
        }
      };

      doc.addEventListener('pointerdown', handlePointerDown);
      doc.addEventListener('keydown', handleDocumentKeyDown);
      // Any open menu suppresses background hover feedback app-wide.
      const releaseMenuOpenFlag = pushMenuOpenBodyFlag(doc);
      return (): void => {
        doc.removeEventListener('pointerdown', handlePointerDown);
        doc.removeEventListener('keydown', handleDocumentKeyDown);
        releaseMenuOpenFlag();
      };
    }, [
      anchorRef,
      interaction,
      nested,
      onOpenChange,
      open,
      outsidePressBoundaryRef,
      outsidePressClickThroughRef,
      returnFocusRef,
      trapFocus,
    ]);

    useLayoutEffect((): void => {
      if (!open || !position || !menuRef.current || focusedForOpenRef.current) {
        return;
      }
      if (initialFocusRef?.current) {
        initialFocusRef.current.focus();
        focusedForOpenRef.current = true;
        return;
      }
      // A focus-trapping surface must land focus inside itself, otherwise the
      // trap has nothing to cycle and the contents stay pointer-only.
      if (trapFocus) {
        const [firstItem] = focusableWithin(menuRef.current);
        (firstItem ?? menuRef.current).focus();
        focusedForOpenRef.current = true;
        return;
      }
      if (!focusOnOpen) return;
      if (interaction === 'manual') {
        focusedForOpenRef.current = true;
        return;
      }
      const itemSelector =
        interaction === 'listbox' ? LISTBOX_ITEM_SELECTOR : MENU_ITEM_SELECTOR;
      const items = enabledItems(menuRef.current, itemSelector);
      const selectedItem =
        interaction === 'listbox'
          ? items.find((item) => item.getAttribute('aria-selected') === 'true')
          : items.find((item) => item.getAttribute('aria-checked') === 'true');
      // A listbox opens on its chosen option from either arrow, as a native
      // select does, so Enter right away keeps the current choice.
      const target =
        interaction === 'listbox' && selectedItem
          ? selectedItem
          : initialItemFocusRef.current === 'last'
            ? items[items.length - 1]
            : (selectedItem ?? items[0]);
      // A pointer open focuses the row unpainted; see `focusMenuRow`.
      if (target) focusMenuRow(target);
      else menuRef.current.focus();
      focusedForOpenRef.current = true;
    }, [focusOnOpen, initialFocusRef, interaction, open, position, trapFocus]);

    const handleMenuClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
      onClick?.(event);
      if (
        event.defaultPrevented ||
        interaction === 'manual' ||
        !closeOnSelect
      ) {
        return;
      }
      const menu = menuRef.current;
      const ElementConstructor = menu?.ownerDocument.defaultView?.Element;
      if (
        !menu ||
        !ElementConstructor ||
        !(event.target instanceof ElementConstructor)
      ) {
        return;
      }
      const itemSelector =
        interaction === 'listbox' ? LISTBOX_ITEM_SELECTOR : MENU_ITEM_SELECTOR;
      const item = event.target.closest<HTMLElement>(itemSelector);
      if (
        !item ||
        !menu.contains(item) ||
        !enabledItems(menu, itemSelector).includes(item)
      ) {
        return;
      }
      onOpenChange(false);
      // A pointer pick hands focus back without drawing the keyboard ring;
      // `detail` is 0 for a click synthesized from Enter or Space.
      const focusOptions: FocusWithoutRingOptions =
        event.detail > 0
          ? { focusVisible: false, preventScroll: true }
          : { preventScroll: true };
      (returnFocusRef?.current ?? anchorRef.current)?.focus(focusOptions);
    };

    const handleMenuKeyDown = (
      event: ReactKeyboardEvent<HTMLDivElement>,
    ): void => {
      onKeyDown?.(event);
      // Tab always leaves a listbox. A focus trap that already placed focus
      // (it prevented the Tab at its boundary) keeps that focus; otherwise
      // focus goes back to the trigger so the browser's Tab moves on from it.
      if (interaction === 'listbox' && event.key === 'Tab') {
        if (!event.defaultPrevented) {
          (returnFocusRef?.current ?? anchorRef.current)?.focus({
            preventScroll: true,
          });
        }
        onOpenChange(false);
        return;
      }
      if (
        event.defaultPrevented ||
        interaction === 'manual' ||
        !menuRef.current
      ) {
        return;
      }

      const itemSelector =
        interaction === 'listbox' ? LISTBOX_ITEM_SELECTOR : MENU_ITEM_SELECTOR;
      const items = enabledItems(menuRef.current, itemSelector);
      const activeIndex = items.indexOf(
        menuRef.current.ownerDocument.activeElement as HTMLElement,
      );
      let target: HTMLElement | undefined;

      if (event.key === 'ArrowDown') {
        target = items[(activeIndex + 1 + items.length) % items.length];
      } else if (event.key === 'ArrowUp') {
        target = items[(activeIndex <= 0 ? items.length : activeIndex) - 1];
      } else if (event.key === 'Home') {
        target = items[0];
      } else if (event.key === 'End') {
        target = items[items.length - 1];
      } else if (event.key === 'Enter' || event.key === ' ') {
        const activeItem = items[activeIndex];
        if (!activeItem) return;
        event.preventDefault();
        activeItem.click();
        return;
      } else if (event.key === 'Escape') {
        event.preventDefault();
        onOpenChange(false);
        (returnFocusRef?.current ?? anchorRef.current)?.focus({
          preventScroll: true,
        });
        return;
      } else if (event.key === 'Tab') {
        // Hand focus back to the trigger before the menu (and the focused
        // option) unmounts, so the browser's Tab moves on from the trigger
        // to the next control, as it does from a native select.
        (returnFocusRef?.current ?? anchorRef.current)?.focus({
          preventScroll: true,
        });
        onOpenChange(false);
        return;
      } else if (
        event.key.length === 1 &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey
      ) {
        const now = Date.now();
        const previous = typeaheadRef.current;
        const value =
          now - previous.at > 500
            ? event.key.toLocaleLowerCase()
            : `${previous.value}${event.key.toLocaleLowerCase()}`;
        typeaheadRef.current = { value, at: now };
        target = [...items.slice(activeIndex + 1), ...items].find((item) =>
          item.textContent?.trim().toLocaleLowerCase().startsWith(value),
        );
      } else {
        return;
      }

      if (!target) return;
      event.preventDefault();
      focusMenuItem(target);
    };

    if (!open) return null;

    const positionedStyle: CSSProperties = position
      ? {
          top: position.top,
          left: position.left,
          maxHeight: position.maxHeight,
          transformOrigin: position.transformOrigin,
        }
      : {
          top: 0,
          left: 0,
          visibility: 'hidden',
          pointerEvents: 'none',
        };
    const menu = (
      <DropdownMenuSurface
        {...props}
        ref={setMenuRef}
        id={menuId}
        // Only the menu-family roles take an orientation. `role="dialog"`
        // surfaces (the CTA popover) do not, and an unsupported ARIA
        // attribute there is a validity error, not a harmless extra.
        {...(props.role === 'dialog'
          ? {}
          : { 'aria-orientation': 'vertical' as const })}
        tabIndex={-1}
        className={`canopy-floating-menu ${motion === 'none' ? 'canopy-floating-menu-no-motion' : ''} ${className}`}
        data-positioned={position ? 'true' : 'false'}
        data-placement={position?.placement ?? placement}
        data-scroll-viewport={managesScrollViewport ? 'true' : 'false'}
        {...(nested ? { 'data-floating-menu-nested': 'true' } : {})}
        onClick={handleMenuClick}
        onKeyDown={handleMenuKeyDown}
        style={{
          ...style,
          position: 'fixed',
          ...positionedStyle,
        }}
      >
        {managesScrollViewport ? (
          // Overlay scrollbar: the native one is hidden and never takes
          // layout, so menu rows keep symmetric left/right insets inside the
          // surface's 4px padding. Inset the thumb beyond the rounded corners.
          <OverlayScrollArea
            // The surface is a grid whose single row is `minmax(0, 1fr)`;
            // without an explicit min-width the wrapper takes its content's
            // intrinsic width and overflows the menu box.
            className="min-w-0"
            viewport="menu"
            contentInset
            viewportRef={scrollViewportRef}
            viewportProps={{
              role: 'presentation',
              'data-floating-menu-scroll-viewport': 'true',
            }}
            railClassName="right-0"
            thumbEndInset={8}
          >
            {children}
          </OverlayScrollArea>
        ) : (
          children
        )}
      </DropdownMenuSurface>
    );

    return createPortal(menu, getDocument(anchorRef.current).body);
  },
);

FloatingMenu.displayName = 'FloatingMenu';
