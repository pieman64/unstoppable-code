'use client';

import { useCallback, type JSX } from 'react';
import {
  DialogModal,
  ThinkingSpinner,
  Tooltip,
} from '@canopy/ui-shared/components';
import { ChatIcon } from '@canopy/ui-shared/icons';

export interface PrMergeWarningDialogProps {
  /** Number of unresolved review threads on the PR being merged; undefined when unknown. */
  readonly unresolvedReviewThreadCount?: number;
  /** GitHub URL of the PR. */
  readonly prUrl: string;
  readonly isSubmitting: boolean;
  /** True while the triage-review-comments chat is being started. */
  readonly isTriaging?: boolean;
  readonly onConfirm: () => void;
  /**
   * Start an agent chat to triage the PR's review comments. A host that
   * cannot shows the action unavailable, with the reason.
   */
  readonly onTriageReviewComments?: () => void;
  /**
   * Open the PR the host's way (desktop honors its link preference). Absent,
   * the link opens in a new tab.
   */
  readonly onOpenPr?: () => void;
  readonly onClose: () => void;
}

const TRIAGE_UNAVAILABLE = "Triaging review comments isn't available here yet.";

const TRIAGE_BUTTON =
  'electron-no-drag focus-ring inline-flex items-center gap-1.5 self-start rounded-md border bg-fg-primary/5 px-3 py-1.5 text-xs font-medium fg-primary/80 transition hover:bg-fg-primary/10 disabled:opacity-60';

/**
 * Confirmation shown when the user clicks Merge on a PR that still has
 * unresolved review comments (REG-3025, shared by desktop and web). Lets them
 * open the PR to resolve them, triage them with an agent, or merge anyway.
 * Rendered in the merge button's warning state.
 */
export function PrMergeWarningDialog({
  unresolvedReviewThreadCount,
  prUrl,
  isSubmitting,
  isTriaging = false,
  onConfirm,
  onTriageReviewComments,
  onOpenPr,
  onClose,
}: PrMergeWarningDialogProps): JSX.Element {
  const handleConfirm = useCallback((): void => {
    if (isSubmitting) return;
    onConfirm();
  }, [isSubmitting, onConfirm]);

  const handleTriage = useCallback((): void => {
    if (isSubmitting || isTriaging) return;
    onTriageReviewComments?.();
  }, [isSubmitting, isTriaging, onTriageReviewComments]);

  const count = unresolvedReviewThreadCount;
  const unresolvedText =
    count === undefined
      ? 'an unknown number of unresolved comments'
      : `${count} unresolved ${count === 1 ? 'comment' : 'comments'}`;
  const reviewPronoun = count === 1 ? 'it' : 'them';

  return (
    <DialogModal
      onClose={isSubmitting ? (): void => undefined : onClose}
      title="Unresolved comments"
      maxWidth="md"
      closeOnBackdrop={!isSubmitting}
      dataTestId="pr-merge-warning-modal"
    >
      <div className="flex flex-col gap-3 p-5 text-s fg-primary">
        <p>
          This pull request has{' '}
          <span className="font-semibold">{unresolvedText}</span>. You can
          review {reviewPronoun} before merging, or merge anyway.
        </p>
        {onOpenPr === undefined ? (
          <a
            href={prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="focus-ring self-start text-xs font-medium fg-accent underline-offset-2 hover:underline"
          >
            View pull request on GitHub
          </a>
        ) : (
          <button
            type="button"
            onClick={onOpenPr}
            className="focus-ring self-start text-xs font-medium fg-accent underline-offset-2 hover:underline"
          >
            View pull request on GitHub
          </button>
        )}
        {onTriageReviewComments === undefined ? (
          // Capability-gated: shown unavailable with its reason, not hidden.
          <Tooltip label={TRIAGE_UNAVAILABLE}>
            <button
              type="button"
              aria-disabled="true"
              data-testid="pr-merge-warning-triage"
              className={`${TRIAGE_BUTTON} cursor-not-allowed opacity-60 hover:bg-fg-primary/5`}
            >
              <ChatIcon className="h-3.5 w-3.5" />
              Triage review comments
            </button>
          </Tooltip>
        ) : (
          <button
            type="button"
            onClick={handleTriage}
            disabled={isSubmitting || isTriaging}
            data-testid="pr-merge-warning-triage"
            className={TRIAGE_BUTTON}
          >
            {isTriaging ? (
              <ThinkingSpinner tone="primary" quiet />
            ) : (
              <ChatIcon className="h-3.5 w-3.5" />
            )}
            {isTriaging ? 'Starting…' : 'Triage review comments'}
          </button>
        )}
      </div>
      <div className="flex items-center justify-end gap-2 border-t p-4">
        <button
          type="button"
          onClick={onClose}
          disabled={isSubmitting}
          className="focus-ring rounded-md border bg-secondary px-3 py-1.5 text-xs font-medium fg-primary transition hover:bg-secondary/80 disabled:opacity-60"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleConfirm}
          disabled={isSubmitting}
          data-testid="pr-merge-warning-confirm"
          className="focus-ring rounded-md bg-warning px-3 py-1.5 text-xs font-medium fg-emphasis transition hover:bg-warning/90 disabled:opacity-60"
        >
          {isSubmitting ? 'Merging…' : 'Merge anyway'}
        </button>
      </div>
    </DialogModal>
  );
}
