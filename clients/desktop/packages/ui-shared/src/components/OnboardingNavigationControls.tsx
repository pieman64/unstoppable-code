import type { JSX } from 'react';
import {
  ChevronLeftMediumIcon,
  ChevronRightMediumIcon,
} from '../icons/AppIcons';

/**
 * The step's own way forward (a choice made, a connection finished). It
 * relabels the forward arrow; it is never rendered as a second button.
 */
export interface OnboardingNextAction {
  /** Accessible name and tooltip for the arrow. Defaults to `Next`. */
  label?: string;
  onClick: () => void;
  /** Test id for the arrow while it acts as Next. Defaults to the Skip id. */
  testId?: string;
  disabled?: boolean;
}

interface OnboardingNavigationControlsProps {
  previousDisabled: boolean;
  previousLabel?: string;
  skipTitle?: string;
  skipLabel: string;
  testId: string;
  onPrevious: () => void;
  onSkip: () => void;
  /**
   * When set, the forward arrow becomes Next: it takes this label, test id
   * and handler instead of Skip, and keeps the same plain styling.
   */
  next?: OnboardingNextAction;
}

/**
 * Shared previous/forward arrows for every Getting Started surface. The
 * forward arrow is the single way forward: it reads Skip until the step's own
 * action is ready, then relabels to Next. A labeled Next button never
 * appears beside it.
 */
export function OnboardingNavigationControls({
  previousDisabled,
  previousLabel = 'Previous',
  skipTitle = 'Skip',
  skipLabel,
  testId,
  onPrevious,
  onSkip,
  next,
}: OnboardingNavigationControlsProps): JSX.Element {
  const buttonClassName =
    "focus-ring relative before:absolute pointer-coarse:before:-inset-2 before:content-[''] flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-transparent fg-tertiary transition-colors hover:bg-subtle hover:fg-primary disabled:pointer-events-none disabled:opacity-30";
  const nextLabel = next ? (next.label ?? 'Next') : undefined;
  return (
    <span className="flex shrink-0 items-center gap-0.5 pointer-coarse:gap-4">
      <button
        type="button"
        aria-label={previousLabel}
        title={previousLabel}
        data-testid={`${testId}-previous`}
        data-checklist-navigation="true"
        onClick={onPrevious}
        disabled={previousDisabled}
        className={buttonClassName}
      >
        <ChevronLeftMediumIcon width={16} height={16} aria-hidden="true" />
      </button>
      {next ? (
        <button
          type="button"
          aria-label={nextLabel}
          title={nextLabel}
          data-testid={next.testId ?? testId}
          data-checklist-navigation="true"
          data-checklist-next="true"
          onClick={next.onClick}
          disabled={next.disabled}
          className={buttonClassName}
        >
          <ChevronRightMediumIcon width={16} height={16} aria-hidden="true" />
        </button>
      ) : (
        <button
          type="button"
          aria-label={skipLabel}
          title={skipTitle}
          data-testid={testId}
          data-checklist-dismiss="true"
          data-checklist-navigation="true"
          onClick={onSkip}
          className={buttonClassName}
        >
          <ChevronRightMediumIcon width={16} height={16} aria-hidden="true" />
        </button>
      )}
    </span>
  );
}
