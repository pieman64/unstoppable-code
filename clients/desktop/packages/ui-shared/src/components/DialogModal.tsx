import {
  useEffect,
  useRef,
  type JSX,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { focusableWithin } from '../lib/focusable';
import { Button } from './Button';
import { useOverlayEscape } from './useOverlayEscape';
import { CloseIcon as AppCatalogCloseIcon } from '../icons/AppIcons';

/**
 * Is this element still a real focus target in `doc`?
 *
 * `isConnected` is the load-bearing check: a confirmation frequently removes
 * the control that opened it, and `HTMLElement.focus()` on a detached node
 * silently does nothing.
 *
 * The realm check is deliberate too. `instanceof HTMLElement` uses the calling
 * realm's constructor, so a dialog rendered into an `ownerDocument` from
 * another window — an iframe, or a second Electron window, both already
 * supported by this component — would fail it for every element and skip
 * restoration entirely. Resolve the constructor from the owning view instead,
 * exactly as `useOverlayEscape` already does.
 */
function isRestorable(
  candidate: Element,
  doc: Document,
  ownerDocument: Document | undefined,
): candidate is HTMLElement {
  const view = (ownerDocument ?? doc).defaultView;
  const ElementConstructor = view?.HTMLElement;
  return (
    ElementConstructor !== undefined &&
    candidate instanceof ElementConstructor &&
    candidate.isConnected
  );
}

/** Caller-named fallback when the original trigger no longer exists. */
function resolveFallbackFocus(
  restoreFocusRef: RefObject<HTMLElement | null> | undefined,
  doc: Document,
): HTMLElement | null {
  const named = restoreFocusRef?.current;
  if (named && named.isConnected) return named;
  // Nothing named and nothing to go back to. `<body>` is a poor destination,
  // but it is at least a real one and it is where the browser would have put
  // focus anyway; returning null here would leave focus on a node that is
  // about to be removed from the document.
  return doc.body;
}

// Pure display dialog shell. Callers pass `onClose` and children; no Electron,
// no window.api, no Next router or stores referenced from this module.

type DialogTitle = ReactNode;

export type DialogPlacement = 'center' | 'top';

/**
 * A top-placed card's gap above it: a tenth of the window, kept between 1rem
 * (short windows) and 6rem (tall ones). The max height leaves that gap and the
 * overlay's 1rem bottom padding, so the card never runs off the window and its
 * body scrolls instead.
 */
const TOP_PLACEMENT_GAP = 'clamp(1rem, 10dvh, 6rem)';
// Tailwind needs the literal; keep it in step with TOP_PLACEMENT_GAP.
const TOP_PLACEMENT_PADDING_CLASS = 'pt-[clamp(1rem,10dvh,6rem)]';
const TOP_PLACEMENT_MAX_HEIGHT = `calc(100dvh - ${TOP_PLACEMENT_GAP} - 1rem)`;

const maxWidthClasses: Record<string, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-xl',
  '2xl': 'max-w-2xl',
  '3xl': 'max-w-3xl',
  '4xl': 'max-w-4xl',
  '5xl': 'max-w-5xl',
  // `'full'` is the near-viewport surface: a card that is as wide as its
  // overlay allows. Pair it with `maxHeight` and `scrollableBody={false}`
  // when the body manages its own independently scrolling panes.
  full: 'max-w-none',
};

let nextFocusTrapId = 0;
const focusTrapStacks = new WeakMap<Document, number[]>();

function addFocusTrap(doc: Document, trapId: number): void {
  const stack = focusTrapStacks.get(doc) ?? [];
  stack.push(trapId);
  focusTrapStacks.set(doc, stack);
}

function removeFocusTrap(doc: Document, trapId: number): void {
  const stack = focusTrapStacks.get(doc);
  if (!stack) return;
  const index = stack.lastIndexOf(trapId);
  if (index !== -1) stack.splice(index, 1);
  if (stack.length === 0) focusTrapStacks.delete(doc);
}

function isTopmostFocusTrap(doc: Document, trapId: number): boolean {
  const stack = focusTrapStacks.get(doc);
  return stack?.[stack.length - 1] === trapId;
}

/**
 * `confirm` is the compact confirmation and short-form shape: a 380px card
 * with the title, one sentence and the actions, no header rule and no close
 * button (Cancel and Escape close it). `confirm-wide` is the same card at
 * 400px, for a footer with three buttons. Both override `maxWidth`,
 * `headerBorder`, `headerSpacing` and `showCloseButton`.
 *
 * `page` is a whole page opened over the app (Settings, project settings, a
 * run or skill detail): the card fills the window inside a margin of scrim,
 * keeps the dialog radius and header, and traps focus by default, so Escape,
 * focus and motion match every other dialog. It overrides `maxWidth` and the
 * default `maxHeight`; a body with its own panes passes
 * `scrollableBody={false}`.
 */
export type DialogModalVariant =
  | 'default'
  | 'confirm'
  | 'confirm-wide'
  | 'page';

export type DialogInset = 'section' | 'flush';

interface DialogModalProps {
  onClose: () => void;
  /** Card shape. Default keeps the classic header; see {@link DialogModalVariant}. */
  variant?: DialogModalVariant;
  title: DialogTitle;
  /**
   * Optional subtitle shown below the title. A node, so a caller can block
   * one value in it (such as a person's name) from session replay.
   */
  subtitle?: ReactNode;
  titleId?: string;
  /**
   * Card width. `'full'` is the near-viewport surface — the card fills the
   * overlay, which drops its padding and corner radius below `sm` so the
   * dialog is genuinely full-bleed on a phone, and the card fills the phone's
   * height too, sizing to its content again from `sm` up. Use it for a detail
   * surface whose own layout needs the viewport (see CAN-3020); pair it with
   * `maxHeight="100%"` and `scrollableBody={false}`.
   *
   * A discrete union rather than a `className` width passthrough: the card
   * already emits a `max-w-*` utility, and appending a second one leaves two
   * declarations of equal specificity resolved by stylesheet order rather
   * than by the caller (the same trap `headerSpacing` documents above).
   */
  maxWidth?: 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl' | '4xl' | '5xl' | 'full';
  children: ReactNode;
  /** Extra classes on the dialog card element */
  className?: string;
  /** CSS max-height for the dialog card element (default: min(80vh, 85dvh)); dvh tracks the visible mobile viewport so the card stays above browser chrome and keyboards */
  maxHeight?: string;
  /**
   * CSS height for the card. A body that fills its parent through
   * `position: absolute` (a virtualized transcript) contributes no intrinsic
   * height, so the card needs a definite one, not only `maxHeight`, for its
   * flex body to size.
   */
  height?: string;
  /** CSS min-height for the card, so a short or still-loading body does not collapse it. */
  minHeight?: string;
  /** Wrap children in a scrollable body (default: true); callers that manage their own card-level layout or scrolling can opt out */
  scrollableBody?: boolean;
  /** Close when clicking the backdrop (default: true) */
  closeOnBackdrop?: boolean;
  /** Close when pressing Escape (default: closeOnBackdrop) */
  closeOnEscape?: boolean;
  /** Document that receives Escape events and whose body hosts the portaled overlay (default: global document) */
  ownerDocument?: Document;
  portalContainer?: HTMLElement;
  /** Show border below header (default: true) */
  headerBorder?: boolean;
  /** Keep the close affordance visible but inert while work is committing. */
  closeButtonDisabled?: boolean;
  /**
   * Space between the header block and the body (default: `'default'`, 16px).
   *
   * `'tight'` (8px) is for a dialog whose body opens with a supporting line
   * that belongs to the title. At the default the header's 16px plus a body's
   * own top padding puts that line as far from the title as from the content
   * below it, so it reads as attached to neither.
   *
   * A discrete union rather than a `headerClassName` passthrough: the header
   * already sets `pb-4`, and appending a competing `pb-*` would leave both
   * declarations in the class list with equal specificity, resolved by
   * stylesheet order rather than by the caller.
   */
  headerSpacing?: 'default' | 'tight';
  /**
   * The dialog owns its insets (docs/design/layout.md#page-column-and-dialog-body).
   * Header, body and footer line up 24px (`section`) from the sides.
   *
   * - `'section'` (the default): the dialog also pads the body, 24px below the
   *   header's divider and on every side, and spaces the body's direct
   *   children 16px (`group`) apart. Callers pass blocks, never padding.
   * - `'flush'`: the body is left to the caller, for a body that lays itself
   *   out (a tab bar, a full-bleed list, a bordered footer, its own
   *   scroller). Its content aligns at 24px itself.
   */
  inset?: DialogInset;
  /** Stable test ID placed on the dialog card element */
  dataTestId?: string;
  /** Optional actions rendered at the right end of the subtitle row */
  headerActions?: ReactNode;
  /**
   * Optional actions rendered inline with (to the left of) the close button
   * in the top-right corner of the dialog. Use for primary affordances that
   * belong in the header chrome, not the body.
   */
  topRightActions?: ReactNode;
  /**
   * The dialog's action buttons (Cancel, Save, Done), drawn in the footer at
   * the bottom right in that order, outside the scrolling body. A dialog's
   * actions always go here, never beside the title in `topRightActions`.
   */
  footer?: ReactNode;
  /** Render the header close button (default: true). */
  showCloseButton?: boolean;
  /** Compact list dialogs align their title and circular close control. */
  headerAlignment?: 'start' | 'center';
  closeButtonAppearance?: 'default' | 'compact';
  /** Extra classes on the full-screen backdrop/overlay element */
  overlayClassName?: string;
  /**
   * Where the card sits vertically (default: `center`). `top` pins its top
   * edge a viewport-relative gap below the window's top, so a dialog whose
   * content changes height (switching panels) grows downward instead of
   * jumping. The card's default max height then fills the rest of the window.
   */
  placement?: DialogPlacement;
  /**
   * Move focus into the dialog on mount and keep it there while open, then
   * restore it on close.
   *
   * OPT-IN, defaulting to off (on for `variant="page"`). The card has always carried `aria-modal="true"`
   * while doing no focus management at all, so opening one left focus wherever
   * it was — on `<body>` if the activating control unmounted — and Tab walked
   * the page behind an overlay that claims to be modal. Every consumer would
   * benefit, but flipping the default would change focus behavior for ~120
   * existing call sites at once; callers adopt it deliberately instead.
   *
   * Restoration is conditional: if something else has claimed focus by the
   * time this unmounts (a surface reopening behind the dialog, say), that
   * wins rather than being yanked back.
   */
  trapFocus?: boolean;
  /**
   * First focus target when `trapFocus` is set. Defaults to the first
   * focusable descendant, which is the header close button.
   *
   * Read through a latest-ref internally, so an inline conditional
   * (`enabled ? aRef : bRef`) is safe and will not rebuild the trap.
   */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /**
   * What takes focus first when `trapFocus` is set (default: `'control'`, the
   * `initialFocusRef` target or first focusable descendant).
   *
   * `'dialog'` focuses the card itself. Use it for a dialog that can open
   * without the user asking, such as one an agent raises while the user is
   * typing: on a button, the next space or Enter would answer the dialog.
   * Tab from the card moves to the first control, Shift+Tab to the last.
   */
  initialFocus?: 'control' | 'dialog';
  /**
   * Where focus goes on close when the element that opened the dialog is gone.
   *
   * Confirmations routinely destroy their own trigger — removing a member,
   * revoking a key, deleting the row the menu belonged to. Without a fallback,
   * restoration targets a detached node, `focus()` no-ops, and focus is left on
   * `<body>`. Point this at a stable ancestor (the list, the toolbar) so
   * keyboard users resume somewhere meaningful. Falls back to `<body>` when
   * unset or itself detached.
   */
  restoreFocusRef?: RefObject<HTMLElement | null>;
  /** A scoped host can prevent restoration after its chat/account has changed. */
  restoreFocusWhen?: () => boolean;
  /**
   * @deprecated Dialogs always mount and unmount instantly. Retained for
   * source compatibility with callers that previously opted out of motion.
   */
  noEnterAnimation?: boolean;
}

export function CloseButton({
  onClick,
  disabled = false,
  appearance = 'default',
}: {
  appearance?: 'default' | 'compact';
  onClick: () => void;
  disabled?: boolean;
}): JSX.Element {
  return (
    <Button
      variant="ghost"
      size="compact"
      iconOnly
      onClick={onClick}
      disabled={disabled}
      aria-label="Close"
    >
      <AppCatalogCloseIcon
        size={16}
        exactSize={appearance === 'compact'}
        aria-hidden="true"
      />
    </Button>
  );
}

export function DialogModal({
  onClose,
  variant = 'default',
  title,
  subtitle,
  titleId,
  maxWidth = 'lg',
  children,
  className = '',
  maxHeight,
  height,
  minHeight,
  scrollableBody = true,
  closeOnBackdrop = true,
  headerBorder = true,
  closeButtonDisabled = false,
  headerSpacing = 'default',
  inset = 'section',
  dataTestId,
  headerActions,
  topRightActions,
  footer,
  showCloseButton = true,
  headerAlignment = 'start',
  closeButtonAppearance = 'default',
  overlayClassName = '',
  placement = 'center',
  closeOnEscape = closeOnBackdrop,
  ownerDocument,
  portalContainer,
  trapFocus: trapFocusProp,
  initialFocus = 'control',
  initialFocusRef,
  restoreFocusRef,
  restoreFocusWhen,
}: DialogModalProps): JSX.Element {
  const id = titleId ?? 'dialog-modal-title';
  const pageShape = variant === 'page';
  const trapFocus = trapFocusProp ?? pageShape;
  const confirmShape = variant === 'confirm' || variant === 'confirm-wide';
  const borderClass = headerBorder && !confirmShape ? 'border-b' : '';
  // Both insets put the header and footer at 24px; only `section` pads the body.
  const owned = inset === 'section';
  const headerBottomClass = headerSpacing === 'tight' ? 'pb-2' : 'pb-4';
  const headerPadClass = confirmShape
    ? 'px-6 pt-6'
    : `px-6 pt-6 ${headerBottomClass}`;
  // The owned body: 24px sides, 24px below a header divider (the header's
  // own bottom inset is the gap without one), blocks 16px apart. Above a
  // footer the body keeps 4px under its last control so the scroll edge
  // never clips its focus ring; without one it ends on the 24px inset.
  // The body always grows into the card, so a fixed-height dialog's
  // `flex-1` / `h-full` children get a height. Inside the dialog's scroller
  // it keeps its content height and scrolls; a body the caller lays out
  // itself (`scrollableBody={false}`) may also shrink, so its own scroller
  // keeps a definite height.
  const ownedBodyClass = `flex ${scrollableBody ? 'flex-1 ' : 'min-h-0 flex-1 '}flex-col gap-4 px-6 ${
    headerBorder && !confirmShape ? 'pt-6' : ''
  } ${footer ? 'pb-1' : 'pb-6'}`;
  const footerPadClass = 'px-6 pb-6 pt-4';
  const titleClass = confirmShape
    ? 'text-m font-medium text-balance fg-primary'
    : 'text-lg font-semibold fg-primary';
  const widthClass =
    variant === 'confirm'
      ? 'max-w-95'
      : variant === 'confirm-wide'
        ? 'max-w-100'
        : pageShape
          ? 'max-w-none'
          : maxWidthClasses[maxWidth];
  const renderCloseButton = showCloseButton && !confirmShape;
  // Both derived strings reproduce today's values for every non-`'full'`
  // width, so existing callers are byte-identical.
  const overlayPadClass = pageShape
    ? 'p-4 sm:p-6'
    : maxWidth === 'full'
      ? 'p-0 sm:p-4'
      : 'p-4';
  const placementClass =
    placement === 'top'
      ? `items-start ${TOP_PLACEMENT_PADDING_CLASS}`
      : 'items-center';
  const resolvedMaxHeight =
    maxHeight ??
    (pageShape
      ? '100%'
      : placement === 'top'
        ? TOP_PLACEMENT_MAX_HEIGHT
        : 'min(80vh, 85dvh)');
  const radiusClass =
    maxWidth === 'full' && !pageShape
      ? 'rounded-none sm:rounded-2xl'
      : 'rounded-2xl';
  // Full-bleed on a phone means the height as well as the width.
  const heightClass = pageShape
    ? 'h-full'
    : maxWidth === 'full'
      ? 'h-full sm:h-auto'
      : '';
  const cardRef = useRef<HTMLDivElement | null>(null);
  const focusTrapIdRef = useRef<number | null>(null);
  if (focusTrapIdRef.current === null) {
    nextFocusTrapId += 1;
    focusTrapIdRef.current = nextFocusTrapId;
  }

  // A mounted dialog must remain the top Escape boundary even when it is not
  // dismissible. Dropping it from the shared overlay stack would expose a
  // dialog underneath, so one Escape could close the parent and unmount this
  // pending operation indirectly.
  useOverlayEscape(
    true,
    (): void => {
      if (closeOnEscape) onClose();
    },
    ownerDocument,
  );

  // Read through a latest-ref so the effect depends on `trapFocus` alone. With
  // `initialFocusRef` in the dep array, a caller passing an inline conditional
  // (`enabled ? aRef : bRef`) would tear the trap down and rebuild it mid-
  // dialog: cleanup would restore focus, then the new run would re-capture
  // `previouslyFocused` from whatever happened to be focused INSIDE the dialog,
  // so closing would strand focus there instead of returning it.
  const initialFocusRefRef = useRef(initialFocusRef);
  initialFocusRefRef.current = initialFocusRef;
  const restoreFocusWhenRef = useRef(restoreFocusWhen);
  restoreFocusWhenRef.current = restoreFocusWhen;
  const restoreFocusRefRef = useRef(restoreFocusRef);
  restoreFocusRefRef.current = restoreFocusRef;
  const focusCard = trapFocus && initialFocus === 'dialog';
  const focusCardRef = useRef(focusCard);
  focusCardRef.current = focusCard;

  useEffect(() => {
    if (!trapFocus) return;
    const card = cardRef.current;
    if (!card) return;
    const doc = card.ownerDocument;
    const previouslyFocused = doc.activeElement;
    const trapId = focusTrapIdRef.current;
    if (trapId === null) return;
    addFocusTrap(doc, trapId);

    // Resolve the named target against the focusable set rather than trusting
    // it. A caller naturally names a semantic target ("the Cancel button"),
    // which can be `disabled` at mount — `ConfirmDialog` disables Cancel while
    // busy, so a dialog opened already-busy would `focus()` a disabled node,
    // silently no-op, and strand focus on `<body>` inside an `aria-modal`
    // surface: exactly the failure the trap exists to prevent.
    const focusables = focusableWithin(card);
    const named = initialFocusRefRef.current?.current;
    const initial = focusCardRef.current
      ? card
      : named !== null && named !== undefined && focusables.includes(named)
        ? named
        : focusables[0];
    initial?.focus();

    // Capture phase so the dialog claims Tab before anything underneath it.
    // A const arrow rather than a function declaration: declarations hoist, so
    // TypeScript drops the `if (!card) return` narrowing inside one.
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab' || !isTopmostFocusTrap(doc, trapId)) return;
      const focusables = focusableWithin(card);
      if (focusables.length === 0) {
        // Nothing to move to; leaving Tab alone would walk the page behind an
        // `aria-modal` surface, which is the whole failure being closed here.
        event.preventDefault();
        return;
      }
      const active = doc.activeElement;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      // A dropdown opened from the dialog draws its menu at the page body.
      // Tab there closes the menu with focus back on its trigger, and Tab
      // moves on from the trigger, so the trap judges the boundary by the
      // trigger: past the last (or before the first) control it wraps.
      // A menu with no trigger linked in this dialog falls through to the
      // ordinary wrap below.
      const menu = active?.closest('.canopy-floating-menu');
      const trigger = menu
        ? Array.from(card.querySelectorAll('[aria-controls]')).find(
            (element) => element.getAttribute('aria-controls') === menu.id,
          )
        : undefined;
      if (trigger) {
        if (event.shiftKey ? trigger === first : trigger === last) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        }
        return;
      }
      // A dialog that does not trap (a report or follow-up opened over a
      // page) draws beside this card at the body. Tab inside it belongs to
      // that dialog; pulling it back here would put focus behind it.
      const otherDialog = active?.closest('[role="dialog"][aria-modal="true"]');
      if (
        otherDialog &&
        otherDialog !== card &&
        !card.contains(otherDialog) &&
        !otherDialog.contains(card)
      )
        return;
      // The card itself is not a Tab stop, so Tab from it enters the controls
      // the same way Tab from behind the dialog does.
      const inside =
        active !== null && active !== card && card.contains(active);
      if (event.shiftKey) {
        if (!inside || active === first) {
          event.preventDefault();
          last.focus();
        }
        return;
      }
      if (!inside || active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    doc.addEventListener('keydown', handleKeyDown, true);
    return (): void => {
      doc.removeEventListener('keydown', handleKeyDown, true);
      removeFocusTrap(doc, trapId);
      const active = doc.activeElement;
      // Only reclaim focus we still own. A caller that reopens its own surface
      // as the dialog resolves has already placed focus deliberately, and
      // pulling it back to the pre-dialog element would fight that.
      const stillOurs =
        active === null || active === doc.body || card.contains(active);
      if (!stillOurs || restoreFocusWhenRef.current?.() === false) return;

      // The confirmed action often REMOVES the control that opened the dialog —
      // removing a member, revoking a key, deleting a row. Focusing a detached
      // node is a silent no-op that leaves focus on `<body>`, which is the
      // exact failure this trap exists to prevent, just moved to the exit. Fall
      // back to a target the caller named, then to the still-mounted overlay
      // host, so focus always lands somewhere real.
      const restoreTarget =
        previouslyFocused !== null &&
        previouslyFocused !== doc.body &&
        isRestorable(previouslyFocused, doc, ownerDocument)
          ? previouslyFocused
          : resolveFallbackFocus(restoreFocusRefRef.current, doc);
      restoreTarget?.focus();
    };
  }, [trapFocus, ownerDocument]);

  const overlay: JSX.Element = (
    <div
      data-canopy-browser-native-overlay="true"
      data-canopy-overlay-root="modal"
      className={`fixed inset-0 z-modal flex ${placementClass} justify-center bg-overlay-scrim ${overlayPadClass} ${overlayClassName}`}
      onClick={closeOnBackdrop ? onClose : undefined}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        data-testid={dataTestId}
        tabIndex={focusCard ? -1 : undefined}
        className={`w-full ${widthClass} ${heightClass} flex flex-col overflow-hidden ${radiusClass} bg-card shadow-xl ${focusCard ? 'outline-none' : ''} ${className}`}
        style={{ maxHeight: resolvedMaxHeight, height, minHeight }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className={`flex ${headerAlignment === 'center' ? 'items-center' : 'items-start'} justify-between ${headerPadClass} ${borderClass}`}
        >
          <div className="min-w-0 flex-1">
            <h2 id={id} className={titleClass}>
              {title}
            </h2>
            {(subtitle || headerActions) && (
              <div className="mt-0.5 flex items-center gap-3">
                {subtitle && <p className="text-s fg-secondary">{subtitle}</p>}
                {headerActions && (
                  <div className="ml-auto flex items-center gap-2">
                    {headerActions}
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            {topRightActions}
            {renderCloseButton ? (
              <CloseButton
                onClick={onClose}
                disabled={closeButtonDisabled}
                appearance={closeButtonAppearance}
              />
            ) : null}
          </div>
        </div>
        {scrollableBody ? (
          <div
            // Above a footer the body keeps 4px under its last control, so
            // the scroll edge never clips that control's edge or focus ring.
            className={`flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain ${footer && !owned ? 'pb-1' : ''}`}
            data-dialog-body=""
          >
            {owned ? (
              <div className={ownedBodyClass}>{children}</div>
            ) : (
              children
            )}
          </div>
        ) : owned ? (
          <div className={ownedBodyClass} data-dialog-body="">
            {children}
          </div>
        ) : (
          children
        )}
        {footer ? (
          <div
            data-dialog-footer=""
            className={`flex shrink-0 items-center justify-end gap-2 ${footerPadClass}`}
          >
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );

  const targetDocument =
    ownerDocument ?? (typeof document !== 'undefined' ? document : undefined);

  // Portal so ancestor overflow/transform/stacking contexts cannot clip or
  // re-anchor the modal, including iOS Safari's fixed-in-scroll quirk (CAN-1294).
  const targetContainer = portalContainer ?? targetDocument?.body;
  return targetContainer ? createPortal(overlay, targetContainer) : overlay;
}
