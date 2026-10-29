'use client';

// ---------------------------------------------------------------------------
// The create-time nudge of the hybrid organization-project model: the Add
// project dialog is about to add a repository that one of the member's
// organizations already holds, so it suggests adding it there, where the
// organization's skills, connectors and shared settings apply. The member may
// still add it where they are. Presentational: the host decides when to show
// it and what each choice does. Shared so the portal renders the same copy.
// ---------------------------------------------------------------------------

import type { JSX } from 'react';
import { Notice, NoticeButton } from '@canopy/ui-shared';

export interface OrgRepositoryOwnerNoticeCopyInput {
  /**
   * What the member picked: the folder's name for a local folder, or
   * `owner/name` for a clone, whose folder name is decided later.
   */
  readonly repositoryName: string;
  /** The organization that holds the repository. */
  readonly organizationName: string;
  /** Where the dialog adds today: `Personal`, or another organization's name. */
  readonly currentScopeName: string;
}

export interface OrgRepositoryOwnerNoticeCopy {
  readonly title: string;
  readonly message: string;
  readonly addLabel: string;
  readonly continueLabel: string;
}

export function orgRepositoryOwnerNoticeCopy({
  repositoryName,
  organizationName,
  currentScopeName,
}: OrgRepositoryOwnerNoticeCopyInput): OrgRepositoryOwnerNoticeCopy {
  return {
    title: `${organizationName} has set up ${repositoryName}.`,
    message: `Adding it to ${currentScopeName} leaves out its skills, connectors and shared settings.`,
    addLabel: `Add to ${organizationName}`,
    continueLabel: `Add to ${currentScopeName}`,
  };
}

/** Shown with the notice when "Add to <organization>" could not switch. */
export function orgRepositoryOwnerSwitchFailure(
  organizationName: string,
): string {
  return `Couldn't switch to ${organizationName}. Try again.`;
}

export interface OrgRepositoryOwnerNoticeProps extends OrgRepositoryOwnerNoticeCopyInput {
  /** Switch to the organization and continue the same add there. */
  readonly onAddToOrganization: () => void;
  /** Add where the member already is, exactly as without the notice. */
  readonly onContinue: () => void;
  /** A choice is in progress: both actions are disabled. */
  readonly pending?: boolean;
  /** Placement only. */
  readonly className?: string;
  /** Base test id; the buttons append `-add` and `-continue`. */
  readonly 'data-testid'?: string;
}

export function OrgRepositoryOwnerNotice({
  repositoryName,
  organizationName,
  currentScopeName,
  onAddToOrganization,
  onContinue,
  pending = false,
  className,
  'data-testid': testId = 'add-workspace-org-owner-notice',
}: OrgRepositoryOwnerNoticeProps): JSX.Element {
  const copy = orgRepositoryOwnerNoticeCopy({
    repositoryName,
    organizationName,
    currentScopeName,
  });
  return (
    <Notice
      // Adding it elsewhere loses the organization's setup, so it is a
      // warning, though both choices stay open (CAN-3909).
      intent="attention"
      data-testid={testId}
      className={className}
      title={copy.title}
      actions={
        <>
          <NoticeButton
            data-testid={`${testId}-continue`}
            disabled={pending}
            onClick={onContinue}
          >
            {copy.continueLabel}
          </NoticeButton>
          <NoticeButton
            variant="primary"
            data-testid={`${testId}-add`}
            disabled={pending}
            onClick={onAddToOrganization}
          >
            {copy.addLabel}
          </NoticeButton>
        </>
      }
    >
      {copy.message}
    </Notice>
  );
}
