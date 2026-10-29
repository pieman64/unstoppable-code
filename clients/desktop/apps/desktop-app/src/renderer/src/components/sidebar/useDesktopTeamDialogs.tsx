import { useState, type JSX } from 'react';
import type { WorkspaceContextOrganization } from '@canopy/protocol/workspace-context';
import {
  DesktopCreateTeamDialog,
  DesktopInviteTeamDialog,
} from './DesktopCreateTeamDialog';

export interface DesktopTeamDialogsOptions {
  /** The signed-in, non-guest account, or `null` when neither dialog applies. */
  readonly accountId: string | null;
  readonly personalOrganizationId: string | null;
}

type TeamDialog = { readonly accountId: string } & (
  | { readonly kind: 'create'; readonly personalOrganizationId: string }
  | {
      readonly kind: 'invite';
      readonly organization: WorkspaceContextOrganization;
    }
);

export interface DesktopTeamDialogs {
  /**
   * Opens Create a team from Personal; `undefined` until the account and its
   * personal organization are known, so the row stays hidden.
   */
  readonly openCreateTeam: (() => void) | undefined;
  /**
   * Opens the invite dialog for an organization the switcher resolved as
   * invitable; `undefined` while signed out or a guest.
   */
  readonly openInvite:
    | ((organization: WorkspaceContextOrganization) => void)
    | undefined;
  /** Mount outside the menu so the dialog outlives the closed menu. */
  readonly dialog: JSX.Element | null;
}

/**
 * The context switcher's Invite your team dialogs on desktop (CAN-3706): in
 * Personal it promotes Personal into a team, in an organization the viewer
 * owns or administers it invites people into it. A dialog is bound to the
 * account that opened it and the organization chosen then, so a later context
 * switch keeps its target and a sign-out or account change closes it.
 */
export function useDesktopTeamDialogs({
  accountId,
  personalOrganizationId,
}: DesktopTeamDialogsOptions): DesktopTeamDialogs {
  const [open, setOpen] = useState<TeamDialog | null>(null);
  // Signing out or into another account drops the dialog for good, so
  // returning to the first account never reopens it.
  if (open !== null && open.accountId !== accountId) setOpen(null);
  const close = (): void => setOpen(null);
  const dialog =
    accountId === null ||
    open === null ||
    open.accountId !== accountId ? null : open.kind === 'create' ? (
      <DesktopCreateTeamDialog
        accountId={accountId}
        personalOrganizationId={open.personalOrganizationId}
        onClose={close}
      />
    ) : (
      <DesktopInviteTeamDialog
        accountId={accountId}
        organizationId={open.organization.id}
        organizationName={open.organization.name}
        onClose={close}
      />
    );
  return {
    openCreateTeam:
      accountId !== null && personalOrganizationId !== null
        ? (): void =>
            setOpen({ accountId, kind: 'create', personalOrganizationId })
        : undefined,
    openInvite:
      accountId !== null
        ? (organization): void =>
            setOpen({ accountId, kind: 'invite', organization })
        : undefined,
    dialog,
  };
}
