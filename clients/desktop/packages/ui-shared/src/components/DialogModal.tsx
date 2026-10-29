import {
  useEffect,
  useRef,
  type JSX,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { focusableWithin } from '../lib/focusable';
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

interface DialogModalProps {
  onClose: () => void;
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
  /** Render the header close button (default: true). */
  showCloseButton?: boolean;
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
   * OPT-IN, defaulting to off. The card has always carried `aria-modal="true"`
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
  /**
   * @deprecated Dialogs always mount and unmount instantly. Retained for
   * source compatibility with callers that previously opted out of motion.
   */
  noEnterAnimation?: boolean;
}

export function CloseButton({
  onClick,
  disabled = false,
}: {
  onClick: () => void;
  disabled?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="focus-ring rounded-md p-1 fg-secondary hover:bg-secondary hover:fg-primary disabled:cursor-not-allowed disabled:opacity-40"
      aria-label="Close"
    >
      <AppCatalogCloseIcon width="16" height="16" aria-hidden="true" />
    </button>
  );
}

export function DialogModal({
  onClose,
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
  dataTestId,
  headerActions,
  topRightActions,
  showCloseButton = true,
  overlayClassName = '',
  placement = 'center',
  closeOnEscape = closeOnBackdrop,
  ownerDocument,
  portalContainer,
  trapFocus = false,
  initialFocusRef,
  restoreFocusRef,
}: DialogModalProps): JSX.Element {
  const id = titleId ?? 'dialog-modal-title';
  const borderClass = headerBorder ? 'border-b' : '';
  const headerPadClass = headerSpacing === 'tight' ? 'pb-2' : 'pb-4';
  // Both derived strings reproduce today's values for every non-`'full'`
  // width, so existing callers are byte-identical.
  const overlayPadClass = maxWidth === 'full' ? 'p-0 sm:p-4' : 'p-4';
  const placementClass =
    placement === 'top'
      ? `items-start ${TOP_PLACEMENT_PADDING_CLASS}`
      : 'items-center';
  const resolvedMaxHeight =
    maxHeight ??
    (placement === 'top' ? TOP_PLACEMENT_MAX_HEIGHT : 'min(80vh, 85dvh)');
  const radiusClass =
    maxWidth === 'full' ? 'rounded-none sm:rounded-2xl' : 'rounded-2xl';
  // Full-bleed on a phone means the height as well as the width.
  const heightClass = maxWidth === 'full' ? 'h-full sm:h-auto' : '';
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
  const restoreFocusRefRef = useRef(restoreFocusRef);
  restoreFocusRefRef.current = restoreFocusRef;

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
    const initial =
      named !== null && named !== undefined && focusables.includes(named)
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
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = doc.activeElement;
      const inside = active !== null && card.contains(active);
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
      if (!stillOurs) return;

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
        className={`w-full ${maxWidthClasses[maxWidth]} ${heightClass} flex flex-col overflow-hidden ${radiusClass} bg-card shadow-xl ${className}`}
        style={{ maxHeight: resolvedMaxHeight, height, minHeight }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className={`flex items-start justify-between p-5 ${headerPadClass} ${borderClass}`}
        >
          <div className="min-w-0 flex-1">
            <h2 id={id} className="text-lg font-semibold fg-primary">
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
            {showCloseButton ? (
              <CloseButton onClick={onClose} disabled={closeButtonDisabled} />
            ) : null}
          </div>
        </div>
        {scrollableBody ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
            {children}
          </div>
        ) : (
          children
        )}
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
