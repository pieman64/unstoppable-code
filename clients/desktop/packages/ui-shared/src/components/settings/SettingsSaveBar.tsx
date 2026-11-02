import { createContext, useContext, type JSX, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * The element under a Settings card's scroll area that holds a page's save
 * bar. The host's Settings card provides it; without one the bar sticks to
 * the bottom of the page column instead.
 */
export const SettingsSaveBarSlotContext = createContext<HTMLElement | null>(
  null,
);

export interface SettingsSaveBarProps {
  /** The draft's state at the leading edge: `Unsaved changes`, a problem. */
  readonly status?: ReactNode;
  /** Trailing: a saved note, an error, and the Save action last. */
  readonly actions: ReactNode;
  readonly dataTestId?: string;
}

/**
 * The save bar of a Settings page with a draft (an environment). It spans the
 * Settings content card edge to edge at the card's bottom, on the secondary
 * surface with a full-width hairline above it, and stays in view while the
 * page scrolls without covering it: it sits below the card's scroll area, not
 * over it. Its text and Save action stay on the page's 640px content column,
 * so they line up with the page content above.
 */
export function SettingsSaveBar({
  status,
  actions,
  dataTestId,
}: SettingsSaveBarProps): JSX.Element {
  const slot = useContext(SettingsSaveBarSlotContext);
  const bar = (
    <div
      data-testid={dataTestId}
      data-settings-save-bar=""
      className={`relative z-10 bg-secondary ${slot ? '' : 'sticky bottom-0'}`}
    >
      {/* The hairline above the bar, across its full width. */}
      <span
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-[var(--border-hairline)] bg-line-base"
      />
      {/* The page column's own width and side insets. */}
      <div className="mx-auto flex w-full max-w-176 items-center justify-between gap-4 px-4 py-3 sm:px-8">
        <div className="min-w-0 text-xs fg-secondary">{status}</div>
        <div className="flex shrink-0 items-center gap-3">{actions}</div>
      </div>
    </div>
  );
  return slot ? createPortal(bar, slot) : bar;
}
