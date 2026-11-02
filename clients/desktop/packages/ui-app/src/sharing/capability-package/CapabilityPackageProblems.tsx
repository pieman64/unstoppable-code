import { useState, type JSX, type ReactNode } from 'react';
import { Notice, NoticeButton } from '@canopy/ui-shared/components';
import type {
  PipelinePackageAnalysisBlocker,
  PipelinePackageInvocationDismissal,
  PipelinePackageReferenceDismissal,
} from '@canopy/protocol/pipelines';
import {
  buildCapabilityPackageProblems,
  DISMISS_INVOCATION_PHRASE,
  DISMISS_REFERENCE_PHRASES,
  slugifyProblemPart,
  type CapabilityPackageProblem,
} from './capability-package-blockers';

/**
 * Publisher-facing problem card for a self-contained share: one card, one
 * row per issue (not per occurrence), severity ordered. A single problem is
 * the card's headline; several get a count headline with the rows under it.
 * The card offers at most one button, Fix it with AI, which covers every
 * problem. A token that only looked like a command is marked from a link
 * inside its own sentence.
 *
 * Display + intent only. Dismissing re-runs the main-process analysis, and
 * the hosting dialog rechecks on its own; this component never decides that
 * the share is allowed.
 */

const VISIBLE_LIMIT = 8;

/**
 * The card draws the notice tray itself, so the header notice and the rows
 * share one surface. Keep it in step with `Notice`'s own `tray` surface.
 */
const CARD_CLASS =
  'overflow-hidden rounded-xl bg-base bg-[linear-gradient(var(--bg-subtle),var(--bg-subtle))] ring-[length:var(--border-hairline)] ring-line-secondary';
/** Lines a section up with the header copy: the 12px inset, 16px glyph, 8px gap. */
const COPY_INSET_CLASS = 'pl-9 pr-3';
const SECTION_CLASS = `border-t border-line-base py-2 ${COPY_INSET_CLASS}`;
const DISCLOSURE_CLASS =
  'focus-ring rounded text-xs fg-secondary underline-offset-2 hover:fg-primary hover:underline';
const INLINE_ACTION_CLASS =
  'focus-ring rounded fg-secondary underline underline-offset-2 hover:fg-primary disabled:cursor-not-allowed disabled:opacity-40';

const RESOLVED_TITLE = 'All problems resolved.';
const UNDO_LABEL = 'Undo';
const DETAILS_LABEL = 'Details';
const SHOW_FEWER_LABEL = 'Show fewer';
export const FIX_WITH_AI_LABEL = 'Fix it with AI';
export const FIX_WITH_AI_PENDING_LABEL = 'Opening chat…';
export const FIX_WITH_AI_FAILURE_LABEL = "Couldn't start the chat. Try again.";

function problemCountTitle(count: number): string {
  return `${String(count)} problems block this share`;
}

function dismissedDetail(invocations: number, references: number): string {
  const parts: string[] = [];
  if (invocations > 0) {
    parts.push(`${String(invocations)} marked as not commands.`);
  }
  if (references > 0) {
    parts.push(
      `${String(references)} pipeline ${references === 1 ? 'mention' : 'mentions'} left out.`,
    );
  }
  return parts.join(' ');
}

function referenceAriaLabel(
  dismissal: PipelinePackageReferenceDismissal,
): string {
  return dismissal.kind === 'pipeline_reference'
    ? `Mark ${dismissal.token} as not a pipeline`
    : `Share without the child pipeline ${dismissal.token}`;
}

function stepsLabel(count: number): string {
  return `Used in ${String(count)} ${count === 1 ? 'step' : 'steps'}`;
}

function dismissedInvocationSlug(
  dismissal: PipelinePackageInvocationDismissal,
): string {
  const tokenSlug = slugifyProblemPart(dismissal.token);
  return dismissal.provider === 'claude' ? tokenSlug : `codex-${tokenSlug}`;
}

interface CapabilityPackageProblemsProps {
  blockers: readonly PipelinePackageAnalysisBlocker[];
  /**
   * Tokens the publisher has already marked as not commands, echoed by main.
   * Optional: a host whose capabilities are explicit refs (an automation)
   * can produce no ambiguous-token blocker, so it omits these and the
   * dismissal affordance does not render.
   */
  dismissedInvocations?: readonly PipelinePackageInvocationDismissal[];
  onDismiss?: (dismissal: PipelinePackageInvocationDismissal) => void;
  onRestore?: (dismissal: PipelinePackageInvocationDismissal) => void;
  /** Pipeline references the publisher left out, echoed by main. */
  dismissedReferences?: readonly PipelinePackageReferenceDismissal[];
  onDismissReference?: (dismissal: PipelinePackageReferenceDismissal) => void;
  onRestoreReference?: (dismissal: PipelinePackageReferenceDismissal) => void;
  bindingLabelFor?: (binding: {
    jobId: string;
    stepId: string;
  }) => string | null;
  disabled: boolean;
  /**
   * Opens a repair chat for these problems. Absent when the host cannot
   * repair this item, and then no Fix it with AI button renders.
   */
  onFixWithAI?: () => void;
  /** A repair chat is being opened; conflicting actions wait. */
  fixWithAIDisabled?: boolean;
  fixWithAIPending?: boolean;
  /** The last attempt to open a repair chat failed. */
  fixWithAIFailed?: boolean;
  /** Hosting dialog's test-id prefix; rows get `${prefix}-dependency-problems-*`. */
  testIdPrefix: string;
}

export function CapabilityPackageProblems({
  blockers,
  dismissedInvocations: dismissedInput,
  onDismiss,
  onRestore,
  dismissedReferences: dismissedReferencesInput,
  onDismissReference,
  onRestoreReference,
  bindingLabelFor = (binding): string => `${binding.jobId}.${binding.stepId}`,
  disabled: disabledInput,
  onFixWithAI,
  fixWithAIDisabled = false,
  fixWithAIPending = false,
  fixWithAIFailed = false,
  testIdPrefix,
}: CapabilityPackageProblemsProps): JSX.Element | null {
  const disabled = disabledInput || fixWithAIPending;
  const [expanded, setExpanded] = useState(false);
  const [showDismissed, setShowDismissed] = useState(false);
  const dismissedInvocations = dismissedInput ?? [];
  const dismissedReferences = dismissedReferencesInput ?? [];
  const problems = buildCapabilityPackageProblems(blockers);
  if (
    problems.length === 0 &&
    dismissedInvocations.length === 0 &&
    dismissedReferences.length === 0
  )
    return null;
  const dismissProps = {
    ...(onDismiss !== undefined ? { onDismiss } : {}),
    ...(onDismissReference !== undefined ? { onDismissReference } : {}),
  };

  const visible = expanded ? problems : problems.slice(0, VISIBLE_LIMIT);
  const hidden = problems.length - visible.length;
  const [onlyProblem] = problems;
  const single = problems.length === 1 ? onlyProblem : undefined;

  const fixWithAI =
    problems.length > 0 && onFixWithAI !== undefined ? (
      <NoticeButton
        variant="primary"
        data-testid={`${testIdPrefix}-dependency-problems-fix-with-ai`}
        disabled={disabled || fixWithAIDisabled}
        aria-busy={fixWithAIPending}
        onClick={onFixWithAI}
      >
        {fixWithAIPending ? FIX_WITH_AI_PENDING_LABEL : FIX_WITH_AI_LABEL}
      </NoticeButton>
    ) : undefined;
  const noticeTestId = `${testIdPrefix}-dependency-problems-notice`;

  return (
    <div
      className={CARD_CLASS}
      data-testid={`${testIdPrefix}-dependency-problems`}
      data-problem-count={String(problems.length)}
      data-dismissed-count={String(dismissedInvocations.length)}
      data-dismissed-reference-count={String(dismissedReferences.length)}
    >
      {single !== undefined ? (
        <div {...problemAttributes(single, testIdPrefix)}>
          <Notice
            intent="destructive"
            surface="none"
            title={single.title}
            {...(fixWithAI !== undefined ? { actions: fixWithAI } : {})}
            data-testid={noticeTestId}
          >
            <ProblemDetail
              problem={single}
              disabled={disabled}
              testIdPrefix={testIdPrefix}
              {...dismissProps}
            />
          </Notice>
          <ProblemDisclosures
            problem={single}
            bindingLabelFor={bindingLabelFor}
            testIdPrefix={testIdPrefix}
            className={`pb-2 ${COPY_INSET_CLASS}`}
          />
        </div>
      ) : problems.length > 0 ? (
        <Notice
          intent="destructive"
          surface="none"
          {...(fixWithAI !== undefined ? { actions: fixWithAI } : {})}
          data-testid={noticeTestId}
        >
          <span className="font-medium">
            {problemCountTitle(problems.length)}
          </span>
        </Notice>
      ) : (
        <Notice
          intent="positive"
          surface="none"
          detail={dismissedDetail(
            dismissedInvocations.length,
            dismissedReferences.length,
          )}
          data-testid={noticeTestId}
        >
          {RESOLVED_TITLE}
        </Notice>
      )}

      {problems.length > 0 && onFixWithAI !== undefined && fixWithAIFailed && (
        <p
          role="alert"
          className={`pb-2 text-xs fg-destructive ${COPY_INSET_CLASS}`}
          data-testid={`${testIdPrefix}-dependency-problems-fix-with-ai-error`}
        >
          {FIX_WITH_AI_FAILURE_LABEL}
        </p>
      )}

      {single === undefined && problems.length > 0 && (
        <ul className="divide-y divide-line-base border-t border-line-base">
          {visible.map((problem) => (
            <ProblemRow
              key={problem.slug}
              problem={problem}
              disabled={disabled}
              bindingLabelFor={bindingLabelFor}
              testIdPrefix={testIdPrefix}
              {...dismissProps}
            />
          ))}
        </ul>
      )}

      {(hidden > 0 || expanded) && problems.length > VISIBLE_LIMIT && (
        <div className={SECTION_CLASS}>
          <button
            type="button"
            data-testid={`${testIdPrefix}-dependency-problems-show-all`}
            aria-expanded={expanded}
            onClick={(): void => {
              setExpanded((open) => !open);
            }}
            className={DISCLOSURE_CLASS}
          >
            {expanded
              ? SHOW_FEWER_LABEL
              : `Show all ${String(problems.length)} problems`}
          </button>
        </div>
      )}

      {dismissedInvocations.length > 0 && onRestore !== undefined && (
        <div
          className={`space-y-1 ${SECTION_CLASS}`}
          data-testid={`${testIdPrefix}-dependency-problems-dismissed-list`}
        >
          <button
            type="button"
            aria-expanded={showDismissed}
            onClick={(): void => {
              setShowDismissed((open) => !open);
            }}
            className={DISCLOSURE_CLASS}
          >
            Marked as not commands ({String(dismissedInvocations.length)})
          </button>
          {showDismissed && (
            <ul className="space-y-1">
              {dismissedInvocations.map((dismissal) => (
                <li
                  key={`${dismissal.provider}:${dismissal.token}`}
                  data-testid={`${testIdPrefix}-dependency-problems-dismissed-${dismissedInvocationSlug(dismissal)}`}
                  className="flex items-center gap-2 text-xs fg-secondary"
                >
                  <span className="min-w-0 truncate fg-primary">
                    {dismissal.token} (
                    {dismissal.provider === 'claude' ? 'Claude' : 'Codex'})
                  </span>
                  <button
                    type="button"
                    data-testid={`${testIdPrefix}-dependency-problems-dismissed-undo-${dismissedInvocationSlug(dismissal)}`}
                    disabled={disabled}
                    onClick={(): void => {
                      onRestore(dismissal);
                    }}
                    className={`${DISCLOSURE_CLASS} disabled:opacity-40`}
                  >
                    {UNDO_LABEL}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {dismissedReferences.length > 0 && onRestoreReference !== undefined && (
        <DismissedReferenceList
          dismissals={dismissedReferences}
          disabled={disabled}
          onRestore={onRestoreReference}
          testIdPrefix={testIdPrefix}
        />
      )}
    </div>
  );
}

function DismissedReferenceList({
  dismissals,
  disabled,
  onRestore,
  testIdPrefix,
}: {
  dismissals: readonly PipelinePackageReferenceDismissal[];
  disabled: boolean;
  onRestore: (dismissal: PipelinePackageReferenceDismissal) => void;
  testIdPrefix: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div
      className={`space-y-1 ${SECTION_CLASS}`}
      data-testid={`${testIdPrefix}-dependency-problems-dismissed-references`}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={(): void => {
          setOpen((value) => !value);
        }}
        className={DISCLOSURE_CLASS}
      >
        Pipeline mentions left out ({String(dismissals.length)})
      </button>
      {open && (
        <ul className="space-y-1">
          {dismissals.map((dismissal) => {
            const slug = `${dismissal.kind === 'pipeline_reference' ? 'name' : 'child'}-${slugifyProblemPart(dismissal.token)}`;
            return (
              <li
                key={`${dismissal.kind}:${dismissal.token}`}
                data-testid={`${testIdPrefix}-dependency-problems-dismissed-reference-${slug}`}
                className="flex items-center gap-2 text-xs fg-secondary"
              >
                <span className="min-w-0 truncate fg-primary">
                  {dismissal.token}
                </span>
                <button
                  type="button"
                  data-testid={`${testIdPrefix}-dependency-problems-dismissed-reference-undo-${slug}`}
                  disabled={disabled}
                  onClick={(): void => {
                    onRestore(dismissal);
                  }}
                  className={`${DISCLOSURE_CLASS} disabled:opacity-40`}
                >
                  {UNDO_LABEL}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function problemAttributes(
  problem: CapabilityPackageProblem,
  testIdPrefix: string,
): Record<string, string> {
  return {
    'data-testid': `${testIdPrefix}-dependency-problems-item-${problem.slug}`,
    'data-code': problem.code,
    ...(problem.subject ? { 'data-subject': problem.subject } : {}),
    'data-dismissible': problem.dismissible ? 'true' : 'false',
  };
}

interface ProblemDetailProps {
  problem: CapabilityPackageProblem;
  disabled: boolean;
  /** Absent when the host cannot produce an ambiguous-token blocker. */
  onDismiss?: (dismissal: PipelinePackageInvocationDismissal) => void;
  onDismissReference?: (dismissal: PipelinePackageReferenceDismissal) => void;
  testIdPrefix: string;
}

/**
 * The problem's one-sentence fix. On a dismissible problem the words "mark
 * it as not a command" are the dismiss control, so the escape hatch reads as
 * part of the advice instead of competing with Fix it with AI.
 */
function dismissAction(
  problem: CapabilityPackageProblem,
  onDismiss: ProblemDetailProps['onDismiss'],
  onDismissReference: ProblemDetailProps['onDismissReference'],
): { phrase: string; ariaLabel: string; dismiss: () => void } | null {
  if (!problem.dismissible) return null;
  const { dismissal, referenceDismissal } = problem;
  if (dismissal !== undefined && onDismiss !== undefined) {
    return {
      phrase: DISMISS_INVOCATION_PHRASE,
      ariaLabel: `Mark ${dismissal.token} as not a command`,
      dismiss: (): void => {
        onDismiss(dismissal);
      },
    };
  }
  const phrase = DISMISS_REFERENCE_PHRASES[problem.code];
  if (
    referenceDismissal !== undefined &&
    onDismissReference !== undefined &&
    phrase !== undefined
  ) {
    return {
      phrase,
      ariaLabel: referenceAriaLabel(referenceDismissal),
      dismiss: (): void => {
        onDismissReference(referenceDismissal);
      },
    };
  }
  return null;
}

function ProblemDetail({
  problem,
  disabled,
  onDismiss,
  onDismissReference,
  testIdPrefix,
}: ProblemDetailProps): JSX.Element {
  const action = dismissAction(problem, onDismiss, onDismissReference);
  const phraseAt = action === null ? -1 : problem.detail.indexOf(action.phrase);
  if (action === null || phraseAt < 0) {
    return <>{problem.detail}</>;
  }
  const link: ReactNode = (
    <button
      type="button"
      data-testid={`${testIdPrefix}-dependency-problems-dismiss-${problem.slug}`}
      aria-label={action.ariaLabel}
      disabled={disabled}
      onClick={action.dismiss}
      className={INLINE_ACTION_CLASS}
    >
      {action.phrase}
    </button>
  );
  return (
    <>
      {problem.detail.slice(0, phraseAt)}
      {link}
      {problem.detail.slice(phraseAt + action.phrase.length)}
    </>
  );
}

interface ProblemDisclosuresProps {
  problem: CapabilityPackageProblem;
  bindingLabelFor: (binding: {
    jobId: string;
    stepId: string;
  }) => string | null;
  testIdPrefix: string;
  className: string;
}

/** Where the problem is used, and the analyzer's own words, on request. */
function ProblemDisclosures({
  problem,
  bindingLabelFor,
  testIdPrefix,
  className,
}: ProblemDisclosuresProps): JSX.Element {
  const [showSteps, setShowSteps] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const locations = problem.occurrences
    .map(bindingLabelFor)
    .filter((label): label is string => label !== null);

  return (
    <div className={`space-y-1 ${className}`}>
      <div className="flex flex-wrap gap-3">
        {locations.length > 0 && (
          <button
            type="button"
            aria-expanded={showSteps}
            data-testid={`${testIdPrefix}-dependency-problems-steps-${problem.slug}`}
            onClick={(): void => {
              setShowSteps((open) => !open);
            }}
            className={DISCLOSURE_CLASS}
          >
            {stepsLabel(locations.length)}
          </button>
        )}
        <button
          type="button"
          aria-expanded={showDetails}
          data-testid={`${testIdPrefix}-dependency-problems-details-${problem.slug}`}
          onClick={(): void => {
            setShowDetails((open) => !open);
          }}
          className={DISCLOSURE_CLASS}
        >
          {DETAILS_LABEL}
        </button>
      </div>
      {showSteps && locations.length > 0 && (
        <p className="text-xs fg-secondary">Used in {locations.join(', ')}</p>
      )}
      {showDetails && (
        <p className="text-xs fg-secondary">
          {problem.message}
          {problem.relativePath ? ` (${problem.relativePath})` : ''}
        </p>
      )}
    </div>
  );
}

interface ProblemRowProps {
  problem: CapabilityPackageProblem;
  disabled: boolean;
  /** Absent when the host cannot produce an ambiguous-token blocker. */
  onDismiss?: (dismissal: PipelinePackageInvocationDismissal) => void;
  onDismissReference?: (dismissal: PipelinePackageReferenceDismissal) => void;
  bindingLabelFor: (binding: {
    jobId: string;
    stepId: string;
  }) => string | null;
  testIdPrefix: string;
}

function ProblemRow({
  problem,
  disabled,
  onDismiss,
  onDismissReference,
  bindingLabelFor,
  testIdPrefix,
}: ProblemRowProps): JSX.Element {
  return (
    <li
      className={`space-y-0.5 py-2 text-xs ${COPY_INSET_CLASS}`}
      {...problemAttributes(problem, testIdPrefix)}
    >
      <p className="font-medium fg-primary">{problem.title}</p>
      <p className="fg-tertiary">
        <ProblemDetail
          problem={problem}
          disabled={disabled}
          testIdPrefix={testIdPrefix}
          {...(onDismiss !== undefined ? { onDismiss } : {})}
          {...(onDismissReference !== undefined ? { onDismissReference } : {})}
        />
      </p>
      <ProblemDisclosures
        problem={problem}
        bindingLabelFor={bindingLabelFor}
        testIdPrefix={testIdPrefix}
        className="pt-0.5"
      />
    </li>
  );
}
