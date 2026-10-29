import { useState, type JSX } from 'react';
import {
  Notice,
  NoticeButton,
  NotificationDetailsDialog,
  summarizeCommandFailure,
} from '@canopy/ui-shared';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { useProjectsStore } from '@/stores/projectsStore';

/**
 * The last worktree create, repair, or join failure, above the main page. A
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

  const { summary, truncated } = summarizeCommandFailure(worktreeError ?? '');
  // The dialog follows the store: an error that is cleared, or replaced by
  // one with nothing more to show, closes it, so the next failure starts
  // with the notice alone.
  if (detailsOpen && !truncated) setDetailsOpen(false);
  if (worktreeError === null || summary === '') return null;

  return (
    <div className="pointer-events-none absolute inset-x-0 top-11 z-20 flex justify-center px-3">
      <div className="pointer-events-auto w-full max-w-lg">
        <Notice
          data-testid="worktree-error-notice"
          intent="destructive"
          role="alert"
          onDismiss={clearWorktreeError}
          dismissLabel="Dismiss error"
          dismissTestId="worktree-error-dismiss"
          actions={
            truncated ? (
              <NoticeButton
                data-testid="worktree-error-details"
                onClick={(): void => setDetailsOpen(true)}
              >
                Show details
              </NoticeButton>
            ) : undefined
          }
        >
          {/* Command output can name paths and branches. */}
          <span
            className={`${POSTHOG_REPLAY_BLOCK_CLASS} block max-h-24 overflow-y-auto whitespace-pre-wrap break-words`}
          >
            {summary}
          </span>
        </Notice>
      </div>
      {detailsOpen && truncated && (
        <NotificationDetailsDialog
          title="Worktree error"
          titleId="worktree-error-details-title"
          message={worktreeError}
          onClose={(): void => setDetailsOpen(false)}
          blockFromReplay
          dataTestId="worktree-error-details-dialog"
          trapFocus
        />
      )}
    </div>
  );
}
