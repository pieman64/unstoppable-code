import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEventHandler,
  type JSX,
  type KeyboardEventHandler,
  type SyntheticEvent,
  type MouseEventHandler,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal, flushSync } from 'react-dom';
import { ABOVE_BROWSER_ATTRIBUTE } from '../lib/above-browser';
import { trackInputModality, wasFocusVisible } from '../lib/input-modality';
import { useTooltipHandoff } from './tooltip-handoff';

const TOOLTIP_GAP = 6;
const VIEWPORT_PADDING = 8;
const INTERACTIVE_CLOSE_GRACE_MS = 120;
/** Keys that open an interactive surface from its trigger by default. */
const DEFAULT_TRIGGER_OPEN_KEYS: readonly string[] = ['Enter', ' '];

/**
 * Surface inset. `compact` (8px by 4px) is a single line that happens to
 * wrap, the same inset as {@link Tooltip}; `default` (8px by 6px) is the
 * multi-line surface; `relaxed` (10px by 6px) is the composer chip tooltips'
 * label-and-description pair; `card` (12px by 8px) holds a titled card such as
 * a pull request's details.
 */
export type RichHoverTooltipSurfacePadding =
  | 'compact'
  | 'default'
  | 'relaxed'
  | 'card';

const SURFACE_PADDING_CLASS_NAMES: Record<
  RichHoverTooltipSurfacePadding,
  string
> = {
  compact: 'px-2 py-1',
  default: 'px-2 py-1.5',
  relaxed: 'px-2.5 py-1.5',
  card: 'px-3 py-2',
};

/**
 * The surface's look without its placement: type, corners, shadow, fill and
 * inset. Exported so a gallery can draw a card on the exact surface it hovers
 * on.
 */
export function richHoverTooltipSurfaceClassName({
  elevation = 'tooltip',
  tone = 'default',
  surfacePadding = 'default',
  surfaceWidth,
}: {
  elevation?: 'tooltip' | 'menu';
  tone?: 'default' | 'inverse';
  surfacePadding?: RichHoverTooltipSurfacePadding;
  surfaceWidth?: RichHoverTooltipSurfaceWidth;
}): string {
  return `text-left text-2xs font-normal ${
    elevation === 'menu' ? 'rounded-lg shadow-xl' : 'rounded-md shadow-tooltip'
  } ${
    tone === 'inverse'
      ? 'bg-tooltip-inverse fg-tooltip-inverse'
      : 'bg-quaternary fg-primary'
  } ${SURFACE_PADDING_CLASS_NAMES[surfacePadding]}${
    surfaceWidth ? ` ${SURFACE_WIDTH_CLASS_NAMES[surfaceWidth]}` : ''
  }`;
}

/**
 * The hover card that previews an item: the sidebar worktree card and the
 * GitHub pull request card. The menu's corners and shadow, with card inset.
 */
export const PREVIEW_CARD_SURFACE = {
  elevation: 'menu',
  surfacePadding: 'card',
  surfaceWidth: 'preview-card',
} as const satisfies {
  elevation: 'menu';
  surfacePadding: RichHoverTooltipSurfacePadding;
  surfaceWidth: RichHoverTooltipSurfaceWidth;
};

/**
 * Surface width bands owned by the component. `preview-card` is a fixed 280px
 * (or the window less 16px each side): wide enough for a typical worktree,
 * branch and pull request line, so long names truncate at one steady edge.
 */
export type RichHoverTooltipSurfaceWidth = 'preview-card';

const SURFACE_WIDTH_CLASS_NAMES: Record<RichHoverTooltipSurfaceWidth, string> =
  {
    'preview-card': 'w-70 max-w-[calc(100vw-2rem)]',
  };

interface RichHoverTooltipProps {
  /** Rich content rendered inside the portaled tooltip surface. */
  content: ReactNode;
  /** Mount the controller on first interaction without replacing the trigger. */
  deferUntilInteraction?: boolean;
  /** Retire an activated controller when the described identity changes. */
  resetKey?: string | number;
  /** The single trigger element that receives tooltip interaction/ARIA props. */
  children: ReactElement<TooltipTriggerProps>;
  dataTestId?: string;
  /**
   * Surface id, for a trigger that already names its description (for
   * example a row whose `aria-describedby` also lists an unavailable reason).
   */
  id?: string;
  /**
   * When true, the tooltip never opens. Note the child is returned *bare*: the
   * wrapper span is not rendered at all, so `triggerWrapperClassName` does not
   * apply on this path and any layout the caller routes through it must move
   * onto the child. Used to suppress the tooltip for idle states.
   */
  disabled?: boolean;
  /** Hide the tooltip while preserving the trigger and its focus. */
  suppressed?: boolean;
  /** Undefined uses hover/focus behavior; true/false force the surface open/closed. */
  open?: boolean;
  /** Interaction requests; controlled callers update `open` to honor dismissal. */
  onOpenChange?: (open: boolean) => void;
  /** Delay before opening; leaving the trigger cancels the pending open. */
  openDelay?: number;
  /**
   * How the surface moves when it opens in place of a neighbour's: `jump`
   * (default) appears at its own place at once; `slide` glides over from the
   * previous surface, for tab hover cards.
   */
  handoffMotion?: 'jump' | 'slide';
  /** Delay for keyboard focus; defaults to `openDelay`. */
  focusOpenDelay?: number;
  /** Block pointer-triggered tooltips while content scrolls under a stationary cursor. */
  suppressPointerHover?: boolean;
  /**
   * Width classes for the tooltip surface (`w-max`, `min-w-*`, `max-w-*`).
   * Defaults to the multi-line surface's 180px–320px band; consumers can pass
   * narrower or wider sizing. The inset is `surfacePadding`, never a class.
   */
  surfaceClassName?: string;
  surfacePadding?: RichHoverTooltipSurfacePadding;
  /** A width band the component owns; `surfaceClassName` adds to it. */
  surfaceWidth?: RichHoverTooltipSurfaceWidth;
  /**
   * Surface color treatment. `inverse` is the reversed black sheet in light
   * mode and the regular dark tooltip surface in dark mode, matching
   * {@link Tooltip}'s inverse tone.
   */
  tone?: 'default' | 'inverse';
  /**
   * Surface corners and shadow. `tooltip` (default) is the tooltip's 8px
   * corners and light shadow; `menu` is {@link DropdownMenuSurface}'s 12px
   * corners and menu shadow, for a card that previews an item the way its
   * menu would sit beside it.
   */
  elevation?: 'tooltip' | 'menu';
  /**
   * When true, the tooltip prefers side placement to the right of the trigger
   * (left edge at the trigger's right edge plus the tooltip gap, vertically
   * centered on it). This is only used when the tooltip fits within the viewport
   * that way; otherwise it falls back to the default above/below,
   * horizontally-centered behavior.
   */
  preferRightPlacement?: boolean;
  /**
   * Vertical alignment for right placement: `center` (default) centers on the
   * trigger; `start` lines the surface's top up with the trigger's top, for a
   * card that previews a row.
   */
  rightPlacementAlign?: 'center' | 'start';
  /**
   * `below-start` hangs the surface under its anchor with its left edge on the
   * anchor's left edge, for a card that previews a tab. Near the right edge it
   * lines up with the anchor's right edge instead (or clamps when neither
   * fits), and it flips above when there is no room below. The default,
   * `auto`, prefers above and centers.
   */
  placement?: 'auto' | 'below-start';
  /** Distance between the anchor and the surface; defaults to 6px. */
  placementGap?: number;
  /**
   * The element the surface is placed against, when it is larger than the
   * trigger (for example the whole tab around a tab's label). Defaults to the
   * trigger itself. Its visibility also determines whether the surface can
   * show, including when a `contents` trigger has no layout box of its own.
   */
  getPlacementAnchor?: (trigger: HTMLElement) => Element | null;
  /**
   * Extra classes for the inline wrapper that hosts the trigger. The wrapper is
   * `relative inline-flex` by default (shrinks to the trigger); pass e.g.
   * `w-full` so the trigger can fill a grid/flex cell instead of hugging its
   * content.
   */
  triggerWrapperClassName?: string;
  /** Preserve the child's layout box when the entire child is the hover region. */
  triggerDisplay?: 'inline-flex' | 'contents';
  /**
   * Keep the portaled surface open while the pointer/focus moves into it and
   * allow pointer interaction (for example, scrolling a bounded detail list).
   */
  interactive?: boolean;
  /**
   * Draw a noninteractive surface over a live in-app browser page instead of
   * hiding the page behind a still frame ({@link ABOVE_BROWSER_ATTRIBUTE}). For
   * hover cards the pointer never enters; ignored with `interactive`. Web
   * ignores the attribute.
   */
  aboveBrowser?: boolean;
  /**
   * With `interactive`, Enter or Space on the trigger opens the surface and
   * moves focus into it. Turn it off when the trigger owns those keys (a row
   * that opens on Enter); the surface then stays a pointer affordance.
   */
  openOnTriggerKey?: boolean;
  /**
   * The trigger keys that open an interactive surface and move focus into
   * it; Enter and Space by default. A trigger that acts on Enter itself (a
   * button that opens a panel) can open its surface on ArrowDown instead,
   * the menu-button key.
   */
  triggerOpenKeys?: readonly string[];
  /**
   * Escape on the trigger closes a noninteractive surface until the pointer
   * leaves or focus moves. Interactive surfaces handle Escape themselves.
   */
  dismissOnEscape?: boolean;
  /**
   * With `interactive`, keep presses, clicks, and Enter or Space inside the
   * surface from bubbling (through the React tree) to the trigger's
   * ancestors. The surface is portaled out of the trigger's DOM, but React
   * still bubbles its events to them, so selecting text in a row's card would
   * otherwise start a drag on, open, or open the menu of that row.
   */
  containEvents?: boolean;
}

export interface TooltipTriggerProps {
  'aria-controls'?: string;
  'aria-describedby'?: string;
  'aria-expanded'?: boolean;
  onBlur?: FocusEventHandler<HTMLElement>;
  onFocus?: FocusEventHandler<HTMLElement>;
  onMouseEnter?: MouseEventHandler<HTMLElement>;
  onMouseLeave?: MouseEventHandler<HTMLElement>;
}

const mergeDescribedBy = (
  existing: string | undefined,
  tooltipId: string | undefined,
): string | undefined =>
  [existing, tooltipId]
    .filter((value): value is string => Boolean(value))
    .join(' ') || undefined;

function stopAtSurface(event: SyntheticEvent): void {
  event.stopPropagation();
}

interface TooltipControllerHandlers {
  enter: () => void;
  leave: () => void;
  focus: FocusEventHandler<HTMLSpanElement>;
  keyDown: KeyboardEventHandler<HTMLSpanElement>;
}

interface ExternalTooltipTrigger {
  ref: RefObject<HTMLSpanElement | null>;
  handlers: RefObject<TooltipControllerHandlers | null>;
  onOpenChange: (open: boolean) => void;
}

type FocusReturnTarget = Pick<HTMLElement, 'focus' | 'isConnected'>;

// Adoption changes ownerDocument without changing a node's prototype realm.
function isDomNode(target: EventTarget): target is Node {
  return 'nodeType' in target && typeof target.nodeType === 'number';
}

function isFocusReturnTarget(
  target: EventTarget,
): target is EventTarget & FocusReturnTarget {
  return (
    isDomNode(target) &&
    target.nodeType === Node.ELEMENT_NODE &&
    'focus' in target &&
    typeof target.focus === 'function'
  );
}

interface TooltipTimer {
  view: Window;
  id: number;
}

export function RichHoverTooltip(props: RichHoverTooltipProps): JSX.Element {
  return props.deferUntilInteraction ? (
    <DeferredRichHoverTooltip {...props} />
  ) : (
    <RichHoverTooltipController {...props} />
  );
}

function DeferredRichHoverTooltip(props: RichHoverTooltipProps): JSX.Element {
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const handlers = useRef<TooltipControllerHandlers | null>(null);
  const [activation, setActivation] = useState<{
    resetKey: RichHoverTooltipProps['resetKey'];
  } | null>(null);
  const active = activation !== null && activation.resetKey === props.resetKey;
  const [open, setOpen] = useState(false);
  const generatedId = useId();
  const tooltipId = props.id ?? generatedId;
  useEffect((): void => {
    const doc = triggerRef.current?.ownerDocument;
    if (doc) trackInputModality(doc);
  }, [props.disabled]);
  useLayoutEffect((): void => {
    setActivation(null);
    setOpen(false);
  }, [props.resetKey]);
  useLayoutEffect((): void => {
    if (props.open !== undefined && !props.disabled)
      setActivation({ resetKey: props.resetKey });
  }, [props.disabled, props.open, props.resetKey]);

  const activate = (): TooltipControllerHandlers | null => {
    if (props.disabled || props.suppressed) return null;
    // Commit the controller before forwarding this event: preserve its delay,
    // cancellation and preventDefault semantics without replaying browser input.
    if (!handlers.current) {
      flushSync(() => setActivation({ resetKey: props.resetKey }));
    }
    return handlers.current;
  };
  const enter = (): void => {
    if (props.suppressPointerHover) return;
    activate()?.enter();
  };
  const focus: FocusEventHandler<HTMLSpanElement> = (event): void => {
    if (wasFocusVisible(event.target)) activate()?.focus(event);
  };
  const keyDown: KeyboardEventHandler<HTMLSpanElement> = (event): void => {
    const opens =
      props.interactive &&
      props.openOnTriggerKey !== false &&
      (props.triggerOpenKeys ?? DEFAULT_TRIGGER_OPEN_KEYS).includes(event.key);
    (opens ? activate() : handlers.current)?.keyDown(event);
  };
  if (props.disabled) return <>{props.children}</>;
  const described = active && (props.open ?? open) && !props.suppressed;
  const trigger = cloneElement(props.children, {
    'aria-controls': props.interactive && described ? tooltipId : undefined,
    'aria-describedby': mergeDescribedBy(
      props.children.props['aria-describedby'],
      described ? tooltipId : undefined,
    ),
    'aria-expanded': props.interactive ? described : undefined,
  });
  return (
    <span
      ref={triggerRef}
      className={`relative ${props.triggerDisplay ?? 'inline-flex'} ${props.triggerWrapperClassName ?? ''}`.trim()}
      onMouseEnter={enter}
      onMouseMove={open ? undefined : enter}
      onMouseLeave={() => handlers.current?.leave()}
      onFocus={focus}
      onBlur={() => handlers.current?.leave()}
      onKeyDown={keyDown}
    >
      {trigger}
      {active && (
        <RichHoverTooltipController
          {...props}
          id={tooltipId}
          externalTrigger={{ ref: triggerRef, handlers, onOpenChange: setOpen }}
        />
      )}
    </span>
  );
}

/**
 * Generic portaled hover/focus tooltip for rich (multi-line / card-like)
 * content. Positions above the trigger, flips below and clamps to the viewport
 * when there is not enough room, and follows the trigger on scroll/resize.
 */
function RichHoverTooltipController({
  content,
  children,
  dataTestId,
  id,
  disabled = false,
  suppressed = false,
  open: controlledOpen,
  onOpenChange,
  openDelay = 0,
  handoffMotion = 'jump',
  focusOpenDelay = openDelay,
  suppressPointerHover = false,
  surfaceClassName,
  surfacePadding = 'default',
  surfaceWidth,
  tone = 'default',
  elevation = 'tooltip',
  preferRightPlacement = false,
  rightPlacementAlign = 'center',
  placement = 'auto',
  placementGap = TOOLTIP_GAP,
  getPlacementAnchor,
  triggerWrapperClassName = '',
  triggerDisplay = 'inline-flex',
  interactive = false,
  aboveBrowser = false,
  openOnTriggerKey = true,
  triggerOpenKeys = DEFAULT_TRIGGER_OPEN_KEYS,
  dismissOnEscape = false,
  containEvents = false,
  externalTrigger,
}: RichHoverTooltipProps & {
  externalTrigger?: ExternalTooltipTrigger;
}): JSX.Element {
  const containsEvents = interactive && containEvents;
  const ownTriggerRef = useRef<HTMLSpanElement | null>(null);
  const triggerRef = externalTrigger?.ref ?? ownTriggerRef;
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const closeTimerRef = useRef<TooltipTimer | null>(null);
  const returnFocusRef = useRef<FocusReturnTarget | null>(null);
  const focusTooltipOnOpenRef = useRef(false);
  const suppressNextTriggerFocusRef = useRef(false);
  const pointerHoverRef = useRef(false);
  const escapeDismissedRef = useRef(false);
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = useCallback(
    (next: boolean): void => {
      setInternalOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );
  const [position, setPosition] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const generatedTooltipId = useId();
  const tooltipId = id ?? generatedTooltipId;

  const openTimerRef = useRef<TooltipTimer | null>(null);
  const clearOpenTimer = useCallback((): void => {
    if (openTimerRef.current === null) return;
    openTimerRef.current.view.clearTimeout(openTimerRef.current.id);
    openTimerRef.current = null;
  }, []);
  useEffect(() => {
    if (disabled || suppressed) {
      clearOpenTimer();
      setInternalOpen(false);
    }
    return clearOpenTimer;
  }, [clearOpenTimer, disabled, suppressed, openDelay]);

  const clearCloseTimer = useCallback((): void => {
    if (closeTimerRef.current === null) return;
    closeTimerRef.current.view.clearTimeout(closeTimerRef.current.id);
    closeTimerRef.current = null;
  }, []);

  const closeTooltip = useCallback((): void => {
    clearOpenTimer();
    clearCloseTimer();
    setOpen(false);
  }, [clearOpenTimer, clearCloseTimer, setOpen]);

  const handoff = useTooltipHandoff({
    open: open && !suppressed && !disabled,
    positioned: position !== null,
    close: closeTooltip,
    triggerRef,
    surfaceRef: tooltipRef,
    slide: handoffMotion === 'slide',
  });

  const showTooltipAfter = useCallback(
    (delay: number): void => {
      if (suppressed || escapeDismissedRef.current) return;
      clearCloseTimer();
      handoff.setLeaving(false);
      if (openTimerRef.current !== null) return;
      if (delay <= 0) {
        setOpen(true);
        return;
      }
      const view = triggerRef.current?.ownerDocument.defaultView ?? window;
      const id = view.setTimeout(() => {
        openTimerRef.current = null;
        setOpen(true);
      }, delay);
      openTimerRef.current = { view, id };
    },
    [clearCloseTimer, handoff, suppressed, setOpen],
  );
  const showTooltip = useCallback(
    (): void => showTooltipAfter(openDelay),
    [openDelay, showTooltipAfter],
  );

  const showPointerTooltip = useCallback((): void => {
    if (suppressPointerHover) return;
    pointerHoverRef.current = true;
    showTooltipAfter(handoff.pointerOpenDelay(openDelay));
  }, [handoff, openDelay, showTooltipAfter, suppressPointerHover]);

  useEffect((): void => {
    if (controlledOpen === false) {
      clearOpenTimer();
      clearCloseTimer();
      setInternalOpen(false);
    }
  }, [clearCloseTimer, clearOpenTimer, controlledOpen]);

  useEffect((): void => {
    if (suppressPointerHover && pointerHoverRef.current) closeTooltip();
  }, [closeTooltip, suppressPointerHover]);

  const requestClose = useCallback((): void => {
    escapeDismissedRef.current = false;
    // The surface stays for the host's close delay (longer when interactive,
    // so the pointer can reach it); a neighbour that opens meanwhile replaces
    // it at once.
    const linger = Math.max(
      handoff.closeDelay,
      interactive ? INTERACTIVE_CLOSE_GRACE_MS : 0,
    );
    if (linger <= 0) {
      closeTooltip();
      return;
    }
    // Leaving before the open delay elapses cancels the open, or the surface
    // would appear later with nothing under the pointer to close it.
    clearOpenTimer();
    clearCloseTimer();
    handoff.setLeaving(true);
    const view = triggerRef.current?.ownerDocument.defaultView ?? window;
    const id = view.setTimeout((): void => {
      closeTimerRef.current = null;
      setOpen(false);
    }, linger);
    closeTimerRef.current = { view, id };
  }, [
    clearCloseTimer,
    clearOpenTimer,
    closeTooltip,
    handoff,
    interactive,
    setOpen,
  ]);

  const focusTooltipContent = useCallback((): boolean => {
    const focusTarget = tooltipRef.current?.querySelector<HTMLElement>(
      '[data-rich-tooltip-autofocus], [tabindex]:not([tabindex="-1"]), button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled])',
    );
    focusTarget?.focus();
    return Boolean(focusTarget);
  }, []);

  // Native `:focus-visible` semantics: open for focus the user reached by
  // keyboard, never for pointer or programmatic focus. A menu that returns
  // focus to its trigger after a pointer pick (the PR status bar's base-branch
  // picker) would otherwise pop the tooltip open until blur.
  const handleFocusVisible: FocusEventHandler<HTMLElement> = useCallback(
    (event): void => {
      if (!wasFocusVisible(event.target)) return;
      pointerHoverRef.current = false;
      showTooltipAfter(focusOpenDelay);
    },
    [focusOpenDelay, showTooltipAfter],
  );

  const handleTriggerFocus: FocusEventHandler<HTMLSpanElement> = useCallback(
    (event): void => {
      if (suppressNextTriggerFocusRef.current) {
        suppressNextTriggerFocusRef.current = false;
        return;
      }
      handleFocusVisible(event);
    },
    [handleFocusVisible],
  );

  const handleTriggerKeyDown: KeyboardEventHandler<HTMLSpanElement> =
    useCallback(
      (event): void => {
        if (dismissOnEscape && !interactive && event.key === 'Escape') {
          if (!open && openTimerRef.current === null) return;
          event.preventDefault();
          event.stopPropagation();
          escapeDismissedRef.current = true;
          closeTooltip();
          return;
        }
        if (
          !interactive ||
          !openOnTriggerKey ||
          !triggerOpenKeys.includes(event.key)
        ) {
          return;
        }
        if (
          isDomNode(event.target) &&
          tooltipRef.current?.contains(event.target)
        ) {
          return;
        }
        event.preventDefault();
        returnFocusRef.current = isFocusReturnTarget(event.target)
          ? event.target
          : null;
        clearCloseTimer();
        setOpen(true);
        if (!focusTooltipContent()) {
          focusTooltipOnOpenRef.current = true;
        }
      },
      [
        clearCloseTimer,
        closeTooltip,
        dismissOnEscape,
        focusTooltipContent,
        interactive,
        open,
        openOnTriggerKey,
        setOpen,
        triggerOpenKeys,
      ],
    );

  const handleTooltipKeyDown: KeyboardEventHandler<HTMLDivElement> =
    useCallback(
      (event): void => {
        if (!interactive) return;
        // Enter and Space would act on the trigger's row (open it, or start
        // dragging it) through the portal; other keys reach app shortcuts.
        if (containEvents && (event.key === 'Enter' || event.key === ' ')) {
          event.stopPropagation();
          return;
        }
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        const returnFocusTarget = returnFocusRef.current;
        const canRestoreFocus = returnFocusTarget?.isConnected === true;
        if (canRestoreFocus) suppressNextTriggerFocusRef.current = true;
        closeTooltip();
        if (canRestoreFocus) returnFocusTarget.focus();
      },
      [closeTooltip, containEvents, interactive],
    );

  const updatePosition = useCallback((): void => {
    const trigger = triggerRef.current;
    const tooltip = tooltipRef.current;
    if (!trigger || !tooltip) return;

    // A trigger that stops rendering never sees the pointer leave: clicking a
    // chat tile that navigates to another page only hides the always-mounted
    // main page. Its zeroed rect would otherwise pin the surface to the
    // viewport's top-left corner, over the sidebar, until the user returns
    // and hovers out. Check the placement anchor: a display:contents trigger
    // can still describe a visible tab without creating its own layout box.
    const anchor = getPlacementAnchor?.(trigger) ?? trigger;
    if (!trigger.isConnected || anchor.checkVisibility?.() === false) {
      closeTooltip();
      return;
    }

    const rect = anchor.getBoundingClientRect();
    const tooltipWidth = tooltip.offsetWidth;
    const tooltipHeight = tooltip.offsetHeight;
    const view = trigger.ownerDocument.defaultView ?? window;
    const viewportWidth = view.innerWidth;
    const viewportHeight = view.innerHeight;

    // Prefer side placement to the right of the trigger when requested and it
    // fits within the viewport. Otherwise fall through to the default
    // above/below, horizontally-centered behavior below.
    if (preferRightPlacement) {
      const rightLeft = rect.right + TOOLTIP_GAP;
      const fitsRight =
        rightLeft + tooltipWidth <= viewportWidth - VIEWPORT_PADDING;
      if (fitsRight) {
        const preferredSideTop =
          rightPlacementAlign === 'start'
            ? rect.top
            : rect.top + rect.height / 2 - tooltipHeight / 2;
        const top = Math.min(
          Math.max(VIEWPORT_PADDING, preferredSideTop),
          Math.max(
            VIEWPORT_PADDING,
            viewportHeight - tooltipHeight - VIEWPORT_PADDING,
          ),
        );
        setPosition((previous) => {
          if (previous && previous.top === top && previous.left === rightLeft) {
            return previous;
          }
          return { top, left: rightLeft };
        });
        return;
      }
    }

    if (placement === 'below-start') {
      const below = rect.bottom + placementGap;
      const above = rect.top - placementGap - tooltipHeight;
      const top =
        below + tooltipHeight <= viewportHeight - VIEWPORT_PADDING ||
        above < VIEWPORT_PADDING
          ? below
          : above;
      const maxLeft = viewportWidth - tooltipWidth - VIEWPORT_PADDING;
      const left =
        rect.left <= maxLeft
          ? Math.max(VIEWPORT_PADDING, rect.left)
          : Math.max(
              VIEWPORT_PADDING,
              Math.min(rect.right - tooltipWidth, maxLeft),
            );
      setPosition((previous) => {
        if (previous && previous.top === top && previous.left === left) {
          return previous;
        }
        return { top, left };
      });
      return;
    }

    const preferredTop = rect.top - TOOLTIP_GAP - tooltipHeight;
    const fallbackTop = rect.bottom + TOOLTIP_GAP;
    const clampedMaxTop = Math.max(
      VIEWPORT_PADDING,
      viewportHeight - tooltipHeight - VIEWPORT_PADDING,
    );
    const top =
      preferredTop >= VIEWPORT_PADDING
        ? preferredTop
        : Math.min(fallbackTop, clampedMaxTop);

    const centerLeft = rect.left + rect.width / 2 - tooltipWidth / 2;
    const clampedMaxLeft = Math.max(
      VIEWPORT_PADDING,
      viewportWidth - tooltipWidth - VIEWPORT_PADDING,
    );
    const left = Math.min(
      Math.max(VIEWPORT_PADDING, centerLeft),
      clampedMaxLeft,
    );

    setPosition((previous) => {
      if (previous && previous.top === top && previous.left === left) {
        return previous;
      }
      return { top, left };
    });
  }, [
    closeTooltip,
    getPlacementAnchor,
    placement,
    placementGap,
    preferRightPlacement,
    rightPlacementAlign,
  ]);

  // Portal into the TRIGGER's realm, like the shared Tooltip: a trigger
  // mounted in an auxiliary window (a popped-out activity card) must render
  // its surface in that window's body, not the module-global main document,
  // or the tooltip paints in the wrong window. Positioning already measures
  // against the trigger's own view. Declared above the `disabled` early
  // return so hook order is stable when a caller toggles `disabled`.
  // Resolved on first open rather than on mount: a mount-time state update
  // re-rendered every closed trigger once more before its first paint.
  const [portalBody, setPortalBody] = useState<HTMLElement | null>(null);
  useLayoutEffect((): void => {
    if (disabled || !open) return;
    setPortalBody(triggerRef.current?.ownerDocument.body ?? null);
  }, [disabled, open]);
  const canPortal = portalBody !== null;

  // `canPortal`: the first open mounts the surface one render later.
  useLayoutEffect((): void => {
    if (!open) {
      setPosition(null);
      return;
    }
    updatePosition();
  }, [canPortal, open, updatePosition]);

  // Focus requested by an Enter/Space open lands only once the surface has a
  // position: until then it is `visibility: hidden`, and Chromium refuses to
  // focus anything inside a hidden subtree.
  useLayoutEffect((): void => {
    if (!open || position === null || !focusTooltipOnOpenRef.current) return;
    focusTooltipOnOpenRef.current = false;
    focusTooltipContent();
  }, [focusTooltipContent, open, position]);

  useEffect((): (() => void) | undefined => {
    if (!open) return undefined;
    const view = triggerRef.current?.ownerDocument.defaultView ?? window;
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
    // Re-anchor when the tooltip's own content resizes (e.g. async PR data
    // populating the surface) or when the trigger resizes. Without this, a
    // tooltip that grows taller after positioning keeps its top fixed and
    // extends downward over the anchor it is supposed to sit above.
    const observer =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(schedule)
        : null;
    if (observer) {
      if (tooltipRef.current) observer.observe(tooltipRef.current);
      if (triggerRef.current) observer.observe(triggerRef.current);
    }
    return (): void => {
      view.removeEventListener('resize', schedule);
      view.removeEventListener('scroll', schedule, { capture: true });
      observer?.disconnect();
      if (frame !== null) {
        view.cancelAnimationFrame(frame);
      }
    };
  }, [canPortal, open, updatePosition]);

  useEffect(
    () => (): void => {
      clearCloseTimer();
    },
    [clearCloseTimer],
  );

  // Record input modality from mount, in the trigger's own document, so the
  // Tab press that precedes the user's first keyboard focus is seen by the
  // time `handleTriggerFocus` asks about it.
  useEffect((): void => {
    const doc = triggerRef.current?.ownerDocument;
    if (doc) trackInputModality(doc);
  }, [disabled]);

  useLayoutEffect(() => {
    if (!externalTrigger) return undefined;
    externalTrigger.handlers.current = {
      enter: showPointerTooltip,
      leave: requestClose,
      focus: handleTriggerFocus,
      keyDown: handleTriggerKeyDown,
    };
    return (): void => {
      externalTrigger.handlers.current = null;
    };
  });
  useLayoutEffect((): void => {
    externalTrigger?.onOpenChange(open && !suppressed && !disabled);
  }, [disabled, externalTrigger, open, suppressed]);

  if (disabled) {
    return <>{children}</>;
  }
  // Associate the tooltip with the trigger for assistive tech only. The
  // open/close handlers live on the wrapper span below — NOT on the trigger —
  // because a disabled trigger (e.g. an in-progress git button) emits no
  // pointer/focus events, so handlers cloned onto it would never fire and the
  // tooltip would never open exactly when it is supposed to.
  const trigger = cloneElement(children, {
    'aria-controls': interactive && open && !suppressed ? tooltipId : undefined,
    'aria-describedby': mergeDescribedBy(
      children.props['aria-describedby'],
      open && !suppressed ? tooltipId : undefined,
    ),
    'aria-expanded': interactive ? open && !suppressed : undefined,
  });

  const surface =
    open &&
    !suppressed &&
    canPortal &&
    createPortal(
      <div
        id={tooltipId}
        ref={tooltipRef}
        role="tooltip"
        data-testid={dataTestId}
        {...(aboveBrowser && !interactive
          ? { [ABOVE_BROWSER_ATTRIBUTE]: 'true' }
          : {})}
        onMouseEnter={interactive ? showTooltip : undefined}
        onMouseLeave={interactive ? requestClose : undefined}
        onFocus={interactive ? handleFocusVisible : undefined}
        onBlur={interactive ? requestClose : undefined}
        onKeyDown={interactive ? handleTooltipKeyDown : undefined}
        onPointerDown={containsEvents ? stopAtSurface : undefined}
        onMouseDown={containsEvents ? stopAtSurface : undefined}
        onClick={containsEvents ? stopAtSurface : undefined}
        onDoubleClick={containsEvents ? stopAtSurface : undefined}
        onContextMenu={containsEvents ? stopAtSurface : undefined}
        className={`${interactive ? 'pointer-events-auto' : 'pointer-events-none'} fixed z-tooltip ${richHoverTooltipSurfaceClassName(
          { elevation, tone, surfacePadding, surfaceWidth },
        )} ${surfaceClassName ?? (surfaceWidth ? '' : 'min-w-45 max-w-80')}`}
        style={
          position
            ? { top: position.top, left: position.left }
            : { visibility: 'hidden', top: 0, left: 0 }
        }
      >
        {content}
      </div>,
      portalBody,
    );
  if (externalTrigger) return <>{surface}</>;

  return (
    <span
      ref={triggerRef}
      className={`relative ${triggerDisplay} ${triggerWrapperClassName}`.trim()}
      onMouseEnter={showPointerTooltip}
      // Same swallowed-enter fallback as the shared Tooltip: when the trigger
      // mounts under a resting pointer, Chromium's `mouseover` names a
      // still-connected ancestor as `relatedTarget` and React never fires
      // `onMouseEnter`; the pointer's next `mousemove` inside the trigger
      // opens the tooltip instead. Only wired while closed.
      onMouseMove={open ? undefined : showPointerTooltip}
      onMouseLeave={requestClose}
      onFocus={handleTriggerFocus}
      onBlur={requestClose}
      onKeyDown={handleTriggerKeyDown}
    >
      {trigger}
      {surface}
    </span>
  );
}
