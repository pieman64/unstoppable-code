import type { JSX, ReactNode } from 'react';
import { GettingStartedSidebarTile } from './GettingStartedSidebarTile';
import {
  OnboardingNavigationControls,
  type OnboardingNextAction,
} from './OnboardingNavigationControls';

export interface GettingStartedChecklistProps {
  title: string;
  currentStep: number;
  totalSteps: number;
  completed: boolean;
  /**
   * The sidebar card: the front of a deck of step cards, with the step's
   * action and Skip; the steps still to come peek out behind it.
   */
  compact?: boolean;
  /** The sidebar card's sentence under the title. */
  description?: string;
  /** The sidebar card's action label; defaults to `Start`. */
  actionLabel?: string;
  onActivate?: () => void;
  onBack?: () => void;
  onSkip: () => void;
  /**
   * The step's own way forward (Next once a choice is made). It relabels the
   * forward arrow instead of Skip, so a step never shows two ways forward.
   */
  next?: OnboardingNextAction;
  /**
   * Whether the heading keeps the 16px inset that lines it up with a pill
   * row's text. A step whose body is a flush tile group (the roles) turns it
   * off so heading and tiles share one edge, as on desktop.
   */
  headingInset?: boolean;
  /** Host placement only (margins), so the card can sit inside a gutter. */
  className?: string;
  /** Id for the title, so a body group can be labelled by it. */
  titleId?: string;
  children?: ReactNode;
}

/**
 * Display-only setup progression, laid out like the desktop Home checklist:
 * the step title is the heading, with the progress count and the arrows on
 * the same line, and the step's rows beneath. Hosts
 * own completion, navigation and storage.
 */
export function GettingStartedChecklist({
  title,
  currentStep,
  totalSteps,
  completed,
  compact = false,
  description,
  actionLabel,
  onActivate,
  onBack,
  onSkip,
  next,
  headingInset = true,
  className = '',
  titleId,
  children,
}: GettingStartedChecklistProps): JSX.Element {
  const progressLabel = `Step ${currentStep} of ${totalSteps}`;
  const skipLabel = completed ? 'Next' : 'Skip';
  if (compact) {
    return (
      <GettingStartedSidebarTile
        title={title}
        description={description}
        actionLabel={actionLabel}
        onActivate={onActivate}
        onSkip={onSkip}
        skipLabel={skipLabel}
        upcoming={totalSteps - currentStep}
      />
    );
  }
  return (
    <section
      aria-label="Getting started"
      data-testid="web-onboarding-checklist"
      data-completed={completed ? 'true' : undefined}
      className={`flex min-w-0 flex-col ${className}`.trim()}
    >
      <div
        className={`mb-3 flex min-h-7 items-center gap-2 ${headingInset ? 'px-4' : 'px-0'}`}
      >
        <h2
          id={titleId}
          className="min-w-0 flex-1 break-words text-left text-m font-medium fg-primary"
        >
          {title}
        </h2>
        <span className="flex shrink-0 items-center gap-2">
          {/* The arrow relabels to Next; assistive tech gets the state too.
              Keyed by title so a step that completes in place announces,
              while navigating to an already completed step does not. */}
          <span
            key={title}
            className="sr-only"
            aria-live="polite"
            data-testid="web-onboarding-completed"
          >
            {completed ? 'Completed' : ''}
          </span>
          <span
            data-testid="web-onboarding-progress"
            className="text-s font-normal tabular-nums fg-tertiary"
            aria-label={progressLabel}
          >
            {currentStep}/{totalSteps}
          </span>
          <OnboardingNavigationControls
            previousDisabled={!onBack}
            previousLabel="Back"
            skipLabel={skipLabel}
            skipTitle={skipLabel}
            testId="web-onboarding-skip"
            onPrevious={() => onBack?.()}
            onSkip={onSkip}
            next={next}
          />
        </span>
      </div>
      <div className="flex min-w-0 flex-col gap-3">{children}</div>
    </section>
  );
}
