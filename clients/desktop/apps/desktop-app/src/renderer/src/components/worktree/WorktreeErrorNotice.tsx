import { useState, type JSX } from 'react';
import {
  NoticeButton,
  NotificationDetailsDialog,
  summarizeCommandFailure,
} from '@canopy/ui-shared';
import { DesktopErrorBanner } from '@/components/shared/DesktopErrorBanner';
import { inlineFailureText } from '@/lib/inline-app-error';
import { showsRawErrorDetail } from '@canopy/protocol/app-errors';
import { rendererAppErrorDisplayPolicy } from '@/lib/renderer-app-error';
import { useProjectsStore } from '@/stores/projectsStore';

/**
 * The last worktree create, repair, join, archive or delete failure, over
 * whichever page is open (it is mounted once, in the app's main frame). A
 * failed git command can print kilobytes of progress, so the notice shows only
 * the command's first line and its cause; Show details opens the full output
 * in a scrolling dialog.
 */
export function WorktreeErrorNotice(): JSX.Element | null {
  const worktreeError = useProjectsStore((state) => state.worktreeError);
  const clearWorktreeError = useProjectsStore(
    (state) => state.clearWorktreeError,
  );
  const [detailsOpen, setDetailsOpen] = useState(false);

  const message = inlineFailureText(worktreeError) ?? '';
  const details = worktreeError?.details;
  const { truncated } = summarizeCommandFailure(details ?? message);
  const canShowDetails =
    truncated && showsRawErrorDetail(rendererAppErrorDisplayPolicy);
  // The dialog follows the store: an error that is cleared, or replaced by
  // one with nothing more to show, closes it, so the next failure starts
  // with the notice alone.
  if (detailsOpen && !canShowDetails) setDetailsOpen(false);
  if (worktreeError === null || message === '') return null;

  return (
    <div className="pointer-events-none absolute inset-x-0 top-11 z-20 flex justify-center px-3">
      <div className="pointer-events-auto w-full max-w-lg">
        {/* Command output can name paths and branches. */}
        <DesktopErrorBanner
          className=""
          error={worktreeError.error}
          {...(details === undefined ? {} : { details })}
          blockMessageFromReplay
          testId="worktree-error-notice"
          onDismiss={clearWorktreeError}
          dismissLabel="Dismiss error"
          dismissTestId="worktree-error-dismiss"
          secondaryAction={
            canShowDetails ? (
              <NoticeButton
                data-testid="worktree-error-details"
                onClick={(): void => setDetailsOpen(true)}
              >
                Show details
              </NoticeButton>
            ) : undefined
          }
        />
      </div>
      {detailsOpen && canShowDetails && (
        <NotificationDetailsDialog
          title="Worktree error"
          titleId="worktree-error-details-title"
          message={details ?? message}
          onClose={(): void => setDetailsOpen(false)}
          blockFromReplay
          dataTestId="worktree-error-details-dialog"
          trapFocus
        />
      )}
    </div>
  );
}
