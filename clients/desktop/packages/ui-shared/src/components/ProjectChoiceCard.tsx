import type { JSX } from 'react';

export interface ProjectChoiceCardProps {
  readonly testId: string;
  readonly selected: boolean;
  readonly disabled?: boolean;
  readonly onSelect: () => void;
  readonly icon: JSX.Element;
  readonly title: string;
  readonly description: string;
}

/** One option in the dialog's top row; Personal and organizations share it. */
export function ProjectChoiceCard({
  testId,
  selected,
  disabled,
  onSelect,
  icon,
  title,
  description,
}: ProjectChoiceCardProps): JSX.Element {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={selected}
      disabled={disabled}
      onClick={onSelect}
      className={`focus-ring flex min-w-0 flex-col justify-start rounded-xl border px-4 py-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
        selected
          ? 'border-line-accent bg-accent-subtle fg-primary'
          : 'bg-secondary/10 fg-secondary hover:bg-secondary/20'
      }`}
    >
      <div className="flex items-center gap-1.5 text-s font-medium fg-primary">
        {icon}
        {title}
      </div>
      {/* An organization's tile names it here, and a name can be one long
          word. */}
      <div className="mt-1 text-xs wrap-anywhere">{description}</div>
    </button>
  );
}
