import { useState, type JSX } from 'react';
import { Notice, NoticeButton } from '@canopy/ui-shared/components';

export interface OrgProjectRelationshipActions {
  dismiss: () => Promise<void>;
  view: () => Promise<void>;
}
interface OrgProjectRelationshipNoticeProps {
  actions: OrgProjectRelationshipActions;
  onSetupSeparately: () => void;
}
/** Private desktop UI. Never included in App Advisor or Portal snapshots. */
export function OrgProjectRelationshipNotice({
  actions,
  onSetupSeparately,
}: OrgProjectRelationshipNoticeProps): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const perform = (action: () => Promise<void>): void => {
    setPending(true);
    setError(null);
    void action()
      .catch((): void => setError('Could not update repository relationship'))
      .finally((): void => setPending(false));
  };
  return (
    <Notice
      data-testid="org-project-relationship-notice"
      // The standing copy is not news: it sits beside the row for as long as
      // the relationship exists, so announcing it on every render would talk
      // over a member who did not just enter that state. A failed action IS
      // news, and it arrives asynchronously after a button press, so it
      // carries its own live region rather than making the whole notice live.
      role="none"
      actionsPlacement="below"
      detail={error === null ? undefined : <span role="alert">{error}</span>}
      actions={
        <>
          <NoticeButton
            disabled={pending}
            onClick={(): void => perform(actions.dismiss)}
          >
            Dismiss
          </NoticeButton>
          <NoticeButton disabled={pending} onClick={onSetupSeparately}>
            Set up separately
          </NoticeButton>
          <NoticeButton
            disabled={pending}
            onClick={(): void => perform(actions.view)}
          >
            View organization project
          </NoticeButton>
        </>
      }
    >
      You already have this repository in Personal
    </Notice>
  );
}
