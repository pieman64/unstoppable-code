import type { JSX } from 'react';
import { Notice, NoticeButton } from '@canopy/ui-shared';
import type { OrgFolderConflictResolution } from '@/lib/orgProjectFolderConflict';

/** Every outcome the dialog shows; `null` while the check is running. */
export type OrgFolderConflictShown = Exclude<
  OrgFolderConflictResolution,
  { status: 'superseded' }
> | null;

interface OrgFolderConflictNoticeProps {
  readonly resolution: OrgFolderConflictShown;
  /** The organization a failed switch targeted; shown as a detail line. */
  readonly switchFailedOrganizationName: string | null;
  readonly busy: boolean;
  readonly onOpen: () => void;
  readonly onRetry: () => void;
  readonly onChooseAnother: () => void;
}

function message(resolution: OrgFolderConflictShown): string {
  if (resolution === null) return 'Checking organization project…';
  switch (resolution.status) {
    case 'ready':
      return `This repository is already managed by ${resolution.organizationName} as "${resolution.projectName}". Open the organization project to continue.`;
    case 'unfinished':
      return `This repository is already managed by ${resolution.organizationName} as "${resolution.projectName}", but its setup didn't finish on this device. Finishing it isn't available yet.`;
    case 'denied':
      if (resolution.reason === 'feature-disabled')
        return "This repository is managed by an organization, but organization projects aren't available right now.";
      return resolution.organizationName === null
        ? "This repository is managed by an organization you're not a member of, so it can't be opened here."
        : `This repository is managed by ${resolution.organizationName}, but it can't be opened right now.`;
    case 'unknown':
      return "Couldn't check this organization project right now. Try again.";
  }
}

/**
 * Personal → Existing folder picked a checkout an organization already owns
 * (CAN-3648). Replaces the import's duplicate error with what the member can
 * do next; names come only from current membership and a usable catalog row.
 */
export function OrgFolderConflictNotice({
  resolution,
  switchFailedOrganizationName,
  busy,
  onOpen,
  onRetry,
  onChooseAnother,
}: OrgFolderConflictNoticeProps): JSX.Element {
  const status = resolution?.status ?? 'resolving';
  const primary =
    resolution?.status === 'ready' ? (
      <NoticeButton
        variant="primary"
        data-testid="add-workspace-org-conflict-open"
        onClick={onOpen}
        disabled={busy}
      >
        {busy ? 'Opening…' : `Open in ${resolution.organizationName}`}
      </NoticeButton>
    ) : resolution?.status === 'unfinished' ? (
      <NoticeButton
        variant="primary"
        data-testid="add-workspace-org-conflict-open"
        onClick={onOpen}
        disabled={busy}
      >
        {busy ? 'Switching…' : `Show in ${resolution.organizationName}`}
      </NoticeButton>
    ) : resolution?.status === 'unknown' ? (
      <NoticeButton
        variant="primary"
        data-testid="add-workspace-org-conflict-retry"
        onClick={onRetry}
        disabled={busy}
      >
        {busy ? 'Checking…' : 'Try again'}
      </NoticeButton>
    ) : null;
  return (
    <Notice
      intent={
        resolution === null || resolution.status === 'ready'
          ? 'neutral'
          : 'attention'
      }
      data-testid="add-workspace-org-conflict"
      data-conflict-status={status}
      aria-busy={resolution === null || busy}
      actionsPlacement="below"
      detail={
        switchFailedOrganizationName === null
          ? undefined
          : `Couldn't switch to ${switchFailedOrganizationName}. Try again.`
      }
      actions={
        resolution === null ? undefined : (
          <>
            <NoticeButton
              data-testid="add-workspace-org-conflict-choose-another"
              onClick={onChooseAnother}
              disabled={busy}
            >
              Choose another folder
            </NoticeButton>
            {primary}
          </>
        )
      }
    >
      {message(resolution)}
    </Notice>
  );
}
