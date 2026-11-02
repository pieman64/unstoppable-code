import type { JSX } from 'react';
import { Notice, NoticeButton } from '@canopy/ui-shared';
import { useInterruptedSessions } from '@/hooks/useInterruptedSessions';
import { useContextScopedWorkspaces } from '@/hooks/useContextScopedWorkspaces';
import { dispatchAppAction } from '@/lib/app-actions/dispatcher';

/**
 * One notice above the Usage groups for every interrupted session, whatever
 * stopped it: the application stopping, a usage limit, or an authentication
 * issue. It opens the same review the Home Continue row opens, scoped to the
 * same workspaces, so the count here matches the sessions listed there.
 */
export function InterruptedSessionsNotice(): JSX.Element | null {
  const { isInContext } = useContextScopedWorkspaces();
  const { count } = useInterruptedSessions(true, isInContext);
  if (count === 0) return null;
  return (
    <Notice
      shape="settings"
      data-testid="usage-interrupted-sessions"
      actions={
        <NoticeButton
          data-testid="usage-interrupted-sessions-resume"
          onClick={(): void => {
            void dispatchAppAction({
              requestId: `ui-usage.open_resume_modal-${Date.now()}`,
              source: 'ui',
              action: { type: 'usage.open_resume_modal' },
            });
          }}
        >
          Resume…
        </NoticeButton>
      }
    >
      {count === 1
        ? '1 session was interrupted.'
        : `${count} sessions were interrupted.`}
    </Notice>
  );
}
