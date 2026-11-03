'use client';

import {
  useEffect,
  useRef,
  type JSX,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  FloatingMenu,
  FloatingMenuPointAnchor,
  type FloatingMenuPlacement,
  type FloatingMenuPoint,
} from './FloatingMenu';

interface PopoverBaseProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Names the panel for assistive tech; or pass `aria-labelledby`. */
  readonly 'aria-label'?: string;
  readonly 'aria-labelledby'?: string;
  readonly 'data-testid'?: string;
  readonly id?: string;
  readonly placement?: FloatingMenuPlacement;
  readonly gap?: number;
  /**
   * The panel's width: `sm` 224px, `md` 288px (default), `lg` 320px, or
   * `content` to fit what it holds. Surface, inset, radius, shadow and layer
   * belong to the popover.
   */
  readonly width?: PopoverWidth;
  /** First focus target; defaults to the first focusable descendant. */
  readonly initialFocusRef?: RefObject<HTMLElement | null>;
  /** Where focus returns on close; defaults to the anchor. */
  readonly returnFocusRef?: RefObject<HTMLElement | null>;
  /** Presses inside this element do not close the popover. */
  readonly outsidePressBoundaryRef?: RefObject<HTMLElement | null>;
  /**
   * `false` while it may not close (an action it started is running): an
   * outside press is ignored and its click still lands.
   */
  readonly closeOnOutsidePress?: boolean;
  /**
   * `none` for a popover opened from a frequently used control (a composer
   * control), where entry motion would only delay it.
   */
  readonly motion?: 'enter' | 'none';
  readonly children: ReactNode;
}

interface PopoverAtControlProps extends PopoverBaseProps {
  /** The control the popover hangs off. */
  readonly anchorRef: RefObject<HTMLElement | null>;
  readonly anchorPoint?: never;
  readonly ownerDocument?: Document;
}

interface PopoverAtPointProps extends PopoverBaseProps {
  readonly anchorRef?: never;
  /** A point in `ownerDocument`'s viewport, such as a selection's end. */
  readonly anchorPoint: FloatingMenuPoint;
  readonly ownerDocument: Document;
}

export type PopoverProps = PopoverAtControlProps | PopoverAtPointProps;

export type PopoverWidth = 'sm' | 'md' | 'lg' | 'content';

/**
 * A small panel tied to a control or a point: a preview, a short form.
 * Built on `FloatingMenu`, so it places, flips and clamps in the window like
 * every menu, on the menu surface (fill, radius, shadow) with a 12px inset.
 * Opening moves focus into it and keeps Tab inside; Escape, an outside
 * press, and for a point a window resize or blur close it, and focus goes
 * back to the control. A `dialog` role names it; it is not modal.
 */
export function Popover(props: PopoverProps): JSX.Element {
  const {
    open,
    onOpenChange,
    placement = 'bottom-left',
    gap,
    width = 'md',
    initialFocusRef,
    returnFocusRef,
    outsidePressBoundaryRef,
    closeOnOutsidePress = true,
    motion = 'enter',
    children,
    id,
  } = props;
  const pointAnchorRef = useRef<HTMLSpanElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const anchorRef = props.anchorRef ?? pointAnchorRef;
  const atPoint = props.anchorPoint !== undefined;
  const focusWasInside = useRef(false);

  // When the popover closes itself (a Done or Cancel inside it), its focused
  // control unmounts and focus would fall to <body>; send it back instead.
  useEffect((): (() => void) | void => {
    if (!open) return;
    const surface = surfaceRef.current;
    if (!surface) return;
    const doc = surface.ownerDocument;
    const track = (): void => {
      focusWasInside.current = surface.contains(doc.activeElement);
    };
    doc.addEventListener('focusin', track);
    track();
    return (): void => {
      doc.removeEventListener('focusin', track);
      const active = doc.activeElement;
      const lost =
        active === null || active === doc.body || surface.contains(active);
      if (focusWasInside.current && lost) {
        (returnFocusRef?.current ?? props.anchorRef?.current)?.focus({
          preventScroll: true,
        });
      }
      focusWasInside.current = false;
    };
  }, [open, props.anchorRef, returnFocusRef]);

  return (
    <>
      {props.anchorPoint !== undefined && open ? (
        <FloatingMenuPointAnchor
          ref={pointAnchorRef}
          x={props.anchorPoint.x}
          y={props.anchorPoint.y}
          ownerDocument={props.ownerDocument}
        />
      ) : null}
      <FloatingMenu
        ref={surfaceRef}
        open={open}
        onOpenChange={onOpenChange}
        anchorRef={anchorRef}
        {...(props.anchorPoint !== undefined
          ? { anchorPoint: props.anchorPoint }
          : {})}
        {...(props.ownerDocument !== undefined
          ? { ownerDocument: props.ownerDocument }
          : {})}
        {...(returnFocusRef ? { returnFocusRef } : {})}
        {...(initialFocusRef ? { initialFocusRef } : {})}
        {...(outsidePressBoundaryRef ? { outsidePressBoundaryRef } : {})}
        {...(gap === undefined ? {} : { gap })}
        closeOnWindowChange={atPoint}
        closeOnOutsidePress={closeOnOutsidePress}
        placement={placement}
        interaction="manual"
        trapFocus
        openOnArrowKeys={false}
        motion={motion}
        role="dialog"
        padding="readout"
        id={id}
        aria-label={props['aria-label']}
        aria-labelledby={props['aria-labelledby']}
        data-testid={props['data-testid']}
        // `manual` turns off FloatingMenu's scroll viewport, so the surface
        // scrolls itself within the max height FloatingMenu measures for the
        // window: a tall popover in a short window keeps every control
        // reachable.
        className={
          width === 'sm'
            ? 'w-56 overflow-y-auto overscroll-contain'
            : width === 'lg'
              ? 'w-80 overflow-y-auto overscroll-contain'
              : width === 'content'
                ? 'w-max overflow-y-auto overscroll-contain'
                : 'w-72 overflow-y-auto overscroll-contain'
        }
      >
        {children}
      </FloatingMenu>
    </>
  );
}
