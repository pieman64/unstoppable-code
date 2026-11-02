import {
  forwardRef,
  type ButtonHTMLAttributes,
  type JSX,
  type ReactNode,
} from 'react';

export interface MobileTopBarButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * Accessible name. Required rather than optional: every call site is an
   * icon-only control, so without it the button has no name at all.
   */
  readonly 'aria-label': string;
  readonly children?: ReactNode;
}

/**
 * The 44px touch-target icon button used by mobile top bars.
 *
 * Deliberately NOT `HeaderActionButton`: that primitive is `h-7` desktop
 * geometry wrapped in a tooltip, which is neither the size a thumb needs nor a
 * behavior a touch surface can use. This one owns only geometry — the class
 * string that was previously inlined at three call sites (the `/chat` shell's
 * menu and right-panel buttons and the App Advisor overlay's close button).
 *
 * The `pointer-coarse:min-*` floors are carried because two of those three call
 * sites had them; they are inert next to the explicit `h-11 w-11`, so adopting
 * this primitive is a visual no-op at the third.
 */
export const MobileTopBarButton = forwardRef<
  HTMLButtonElement,
  MobileTopBarButtonProps
>(function MobileTopBarButton(
  { type = 'button', className = '', children, ...rest },
  ref,
): JSX.Element {
  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      className={`focus-ring flex h-11 w-11 shrink-0 items-center justify-center rounded-md fg-secondary transition-colors hover:bg-fg-primary/[0.08] hover:fg-primary pointer-coarse:min-h-11 pointer-coarse:min-w-11 ${className}`.trim()}
    >
      {children}
    </button>
  );
});
