import { useState, type JSX, type ReactNode } from 'react';
import { ChevronRightIcon } from '../icons/ChevronRightIcon';

export const ADVANCED_DISCLOSURE_LABEL = 'Advanced';

export interface AdvancedDisclosureProps {
  readonly children: ReactNode;
  /**
   * A non-default choice inside, named beside the collapsed label so closing
   * the disclosure never hides it (for example `Private memory on`).
   */
  readonly collapsedHint?: string | null;
  readonly defaultExpanded?: boolean;
  /** Toggle label; defaults to {@link ADVANCED_DISCLOSURE_LABEL}. */
  readonly label?: string;
  /** Root test id; the toggle and body append `-toggle` / `-body`. */
  readonly dataTestId?: string;
}

/**
 * The low-profile `Advanced` expander for optional settings a form should
 * not lead with. Only optional choices belong inside: anything that blocks the
 * form's action stays outside, always visible.
 */
export function AdvancedDisclosure({
  children,
  collapsedHint,
  defaultExpanded = false,
  label = ADVANCED_DISCLOSURE_LABEL,
  dataTestId = 'advanced-disclosure',
}: AdvancedDisclosureProps): JSX.Element {
  const [expanded, setExpanded] = useState(defaultExpanded);
  return (
    <div data-testid={dataTestId}>
      <button
        type="button"
        aria-expanded={expanded}
        data-testid={`${dataTestId}-toggle`}
        className="focus-ring inline-flex items-center gap-1 rounded-md py-0.5 pr-1 text-xs font-medium fg-secondary transition hover:fg-primary"
        onClick={() => setExpanded((current) => !current)}
      >
        <ChevronRightIcon
          width={14}
          height={14}
          aria-hidden="true"
          className={`shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
        />
        {label}
        {!expanded && collapsedHint && (
          <span className="font-normal fg-tertiary">{` · ${collapsedHint}`}</span>
        )}
      </button>
      {expanded && (
        <div className="mt-2 space-y-2" data-testid={`${dataTestId}-body`}>
          {children}
        </div>
      )}
    </div>
  );
}
