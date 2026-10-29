import { memo, useCallback, type JSX } from 'react';
import { PrMergeWarningDialog } from '@canopy/ui-app/pull-requests';

interface PrMergeWarningModalProps {
  /** Number of unresolved review threads on the PR being merged; undefined when unknown. */
  unresolvedReviewThreadCount?: number;
  /** GitHub URL of the PR, opened externally from the modal. */
  prUrl: string;
  isSubmitting: boolean;
  /** True while the triage-review-comments chat is being started. */
  isTriaging: boolean;
  onConfirm: () => void;
  /** Start an agent chat to triage the PR's review comments. */
  onTriageReviewComments: () => void;
  onClose: () => void;
}

/**
 * Desktop's unresolved-comments merge confirmation: the shared
 * `PrMergeWarningDialog`, opening the PR through the app's link preference.
 */
export const PrMergeWarningModal = memo(function PrMergeWarningModal({
  unresolvedReviewThreadCount,
  prUrl,
  isSubmitting,
  isTriaging,
  onConfirm,
  onTriageReviewComments,
  onClose,
}: PrMergeWarningModalProps): JSX.Element {
  const handleOpenPr = useCallback((): void => {
    void window.api.browser.openLink({ url: prUrl });
  }, [prUrl]);

  return (
    <PrMergeWarningDialog
      {...(unresolvedReviewThreadCount === undefined
        ? {}
        : { unresolvedReviewThreadCount })}
      prUrl={prUrl}
      isSubmitting={isSubmitting}
      isTriaging={isTriaging}
      onConfirm={onConfirm}
      onTriageReviewComments={onTriageReviewComments}
      onOpenPr={handleOpenPr}
      onClose={onClose}
    />
  );
});
