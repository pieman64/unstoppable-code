import { type JSX, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useOverlayEscape } from './useOverlayEscape';

// Pure display slide-in drawer shell. Mirrors DialogModal's scrim,
// Escape-stack, and backdrop-click conventions. No Electron, no
// window.api, no Next router or stores referenced from this module.

interface SheetProps {
  /** Edge the panel slides in from. */
  side: 'left' | 'right';
  /** Whether the sheet is currently shown. When false, renders nothing. */
  open: boolean;
  onClose: () => void;
  /** Accessible label for the drawer dialog. */
  ariaLabel: string;
  children: ReactNode;
  /**
   * Override the panel width. Defaults to `w-[85vw] max-w-sm`. Pass a full
   * Tailwind width utility (e.g. `w-[90vw] max-w-md`) to replace it.
   */
  widthClassName?: string;
  /** Extra classes on the sliding panel element. */
  className?: string;
  /** Close when clicking the backdrop (default: true). */
  closeOnBackdrop?: boolean;
  /** Close when pressing Escape (default: closeOnBackdrop). */
  closeOnEscape?: boolean;
  /** Stable test ID placed on the sliding panel element. */
  dataTestId?: string;
}

export function Sheet({
  side,
  open,
  onClose,
  ariaLabel,
  children,
  widthClassName = 'w-[85vw] max-w-sm',
  className = '',
  closeOnBackdrop = true,
  closeOnEscape = closeOnBackdrop,
  dataTestId,
}: SheetProps): JSX.Element {
  // An open sheet remains the top Escape boundary even when it is not
  // dismissible. Otherwise Escape leaks through and closes the overlay below.
  useOverlayEscape(open, (): void => {
    if (closeOnEscape) onClose();
  });

  if (!open) return <></>;

  const isLeft = side === 'left';
  const justifyClass = isLeft ? 'justify-start' : 'justify-end';
  const panelAnimation = isLeft
    ? 'animate-slide-in-left'
    : 'animate-slide-in-right';
  const edgeClass = isLeft
    ? 'border-r rounded-r-2xl'
    : 'border-l rounded-l-2xl';
  // Pad the panel's own outer edge (the one flush with the screen) and its
  // bottom by the device safe-area insets so drawer content clears a notch or
  // home indicator (CAN-1206). `env(safe-area-inset-*)` is 0 on non-notch
  // devices and desktop, so this is a no-op outside mobile. `overscroll-contain`
  // stops a scroll that reaches the drawer's top/bottom from chaining to the
  // page behind the backdrop.
  const safeAreaClass = `overscroll-contain pb-[env(safe-area-inset-bottom)] ${
    isLeft
      ? 'pl-[env(safe-area-inset-left)]'
      : 'pr-[env(safe-area-inset-right)]'
  }`;

  const overlay = (
    <div
      data-canopy-browser-native-overlay="true"
      className={`fixed inset-0 z-drawer flex ${justifyClass} bg-overlay-scrim animate-fade-in`}
      onClick={closeOnBackdrop ? onClose : undefined}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        data-testid={dataTestId}
        className={`${panelAnimation} ${widthClassName} ${edgeClass} ${safeAreaClass} flex h-full flex-col overflow-y-auto bg-base shadow-xl ${className}`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );

  // Portal to `<body>`, exactly as `DialogModal` already does, so no ancestor
  // can clip or re-anchor a viewport-anchored drawer.
  //
  // `fixed` is only viewport-relative while no ancestor establishes a
  // containing block for it. `container-type: size` computes to
  // `contain: size layout style`, and layout containment does exactly that —
  // so the web app shell's scrolling content region (which carries
  // `[container-type:size]` for its `100cqh` consumers) would otherwise inset
  // this scrim by the sidebar rail's width and the banner's height instead of
  // covering the viewport. Ancestor `overflow`/`transform` stacking contexts
  // and iOS Safari's fixed-in-scroll quirk (CAN-1294) are the same class of
  // problem.
  const targetDocument = typeof document !== 'undefined' ? document : undefined;
  return targetDocument?.body
    ? createPortal(overlay, targetDocument.body)
    : overlay;
}
