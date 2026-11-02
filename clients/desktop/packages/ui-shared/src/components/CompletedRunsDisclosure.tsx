import type { JSX, ReactNode } from 'react';
import { ChevronRightIcon } from '../icons/ChevronRightIcon';

export interface CompletedRunsDisclosureProps {
  dataTestId?: string;
  /** Number of completed runs. Rendered in the disclosure label. */
  count: number;
  expanded: boolean;
  onToggle: () => void;
  /** Optional override for the disclosure label. Defaults to "Completed (n)". */
  label?: string;
  children: ReactNode;
}

/**
 * Trailing "Completed (n)" disclosure used in both Hooks and Scripts
 * sections to gate the list of completed run cards. Pure display.
 */
export function CompletedRunsDisclosure({
  dataTestId,
  count,
  expanded,
  onToggle,
  label,
  children,
}: CompletedRunsDisclosureProps): JSX.Element {
  return (
    <div className="pt-1">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        data-testid={dataTestId}
        className="focus-ring flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-xs font-medium fg-secondary/60 transition-colors hover:fg-secondary"
      >
        <ChevronRightIcon
          width={14}
          height={14}
          className={`transition-transform ${expanded ? 'rotate-90' : ''}`}
        />
        {label ?? `Completed (${count})`}
      </button>
      {expanded && <div className="mt-2 space-y-1.5">{children}</div>}
    </div>
  );
}
