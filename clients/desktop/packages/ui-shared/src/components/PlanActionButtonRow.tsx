import type { JSX, KeyboardEvent, MouseEvent, ReactNode } from 'react';

export interface PlanActionButtonRowItem {
  /** Visible label. */
  label: string;
  /** Icon glyph rendered to the left of the label. */
  icon: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  /** Test ID hook for automation. */
  dataTestId?: string;
}

export interface PlanActionButtonRowProps {
  items: PlanActionButtonRowItem[];
  /** Optional trailing slot for additional controls (e.g., copy button). */
  trailing?: ReactNode;
}

/**
 * Sky-tinted action button used inside the plan card. Pure display.
 */
function PlanActionButton({
  item,
}: {
  item: PlanActionButtonRowItem;
}): JSX.Element {
  return (
    <button
      type="button"
      data-testid={item.dataTestId}
      onClick={(event: MouseEvent<HTMLButtonElement>): void => {
        event.stopPropagation();
        item.onClick();
      }}
      onKeyDown={(event: KeyboardEvent<HTMLButtonElement>): void => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.stopPropagation();
        }
      }}
      disabled={item.disabled}
      className="focus-ring inline-flex items-center gap-1.5 rounded-md border border-sky-500/20 bg-sky-500/10 px-2.5 py-1 text-2xs font-medium fg-primary transition hover:bg-sky-500/18 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {item.icon}
      {item.label}
    </button>
  );
}

/**
 * Row of plan action buttons (approve/dismiss/chat/pipeline). Pure display.
 */
export function PlanActionButtonRow({
  items,
  trailing,
}: PlanActionButtonRowProps): JSX.Element {
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {items.map((item) => (
        <PlanActionButton key={item.label} item={item} />
      ))}
      {trailing}
    </div>
  );
}
