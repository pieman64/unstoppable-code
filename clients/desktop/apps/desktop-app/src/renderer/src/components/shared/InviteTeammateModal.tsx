import {
  type JSX,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
} from 'react';
import {
  Stack,
  LoadingSpinner,
  OrgTeamPicker,
  ShareAudienceSelector,
  isEmailRecipientValid,
} from '@canopy/ui-shared/components';
import { ShareSetupCta } from '@/components/shared/ShareSetupCta';
import {
  ContextChangedNotice,
  contextLabel,
  defaultOrganizationForContext,
  ShareDialogFrame,
  toShareTarget,
  useContextRebind,
  useShareAudience,
  type ShareFooterSecondaryAction,
} from '@canopy/ui-app/sharing';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { useCanopyDesktopSharedContainersEnabled } from '@/hooks/useCanopyDesktopSharedContainersEnabled';
import { useCanopySharedContainerExternalSharingEnabled } from '@/hooks/useCanopySharedContainerExternalSharingEnabled';
import type {
  SharedContainerEligibilityResponse,
  SharedContainerGithubReadiness,
  SharedContainerInviteAudience,
  SharedContainerPublicationState,
} from '@canopy/desktop-shared/types';
import type {
  SharedContainerMemberSummary,
  SharedContainerRecipientRequest,
  SharedContainerSummary,
  SharedContainerType,
} from '@canopy/protocol/shared-containers';
import type { ShareAudience } from '@canopy/protocol/sharing';
import {
  serializeWorkspaceContext,
  type WorkspaceContext,
} from '@canopy/protocol/workspace-context';
import { consumeRequestedSharedContainerInviteAudience } from '@/lib/sharedContainerInviteEvents';
import { isOrgTeamsLapsed } from '@canopy/desktop-shared/lib/org-billing-state-parsing';
import {
  publicationStateKey,
  useSharedContainersStore,
} from '@/stores/sharedContainersStore';
import { ShareBlockedState } from './invite-teammate/ShareBlockedState';
import {
  InviteRecipientSection,
  memberPickerState,
  recipientReadiness,
} from './invite-teammate/InviteRecipientSection';
import { PeopleWithAccessSection } from './invite-teammate/PeopleWithAccessSection';
import {
  SharePublishIssue,
  SharePublishStatus,
} from './invite-teammate/SharePublishStatus';
import { LinkSharingSection } from './invite-teammate/LinkSharingSection';
import { useShareLink } from './invite-teammate/useShareLink';
import {
  ACCOUNT_UNAVAILABLE_BODY,
  ACCOUNT_UNAVAILABLE_TITLE,
  AUDIENCE_DESCRIPTIONS,
  AUDIENCE_LEGEND,
  CHECKING_LABEL,
  FAILURE_LABEL,
  GITHUB_PUSH_ERROR_LABEL,
  BILLING_REFUSAL_LABEL,
  INSUFFICIENT_ROLE_LABEL,
  MANAGE_TITLE,
  MANAGE_EXISTING_LABEL,
  PUBLIC_EXTERNAL_SHARING_OFF_HINT,
  PUBLIC_UNAVAILABLE_HINT,
  PUSHING_LABEL,
  PUSH_TO_GITHUB_LABEL,
  REGISTRATION_RECHECK_INTERVAL_MS,
  REGISTRATION_RECHECK_LIMIT,
  SHARE_LABEL,
  SHARING_LABEL,
  TEAM_LABEL,
  TEAM_UNAVAILABLE_HINT,
  TITLE,
  TRY_AGAIN_LABEL,
  accountRefusal,
  allOrganizationsIneligibleCopy,
  externalAudienceNotice,
  githubRecoveryCopy,
  invitedToastMessage,
  shareFailureMessage,
} from './invite-teammate/shareCopy';
import { useShareEligibility } from './invite-teammate/useShareEligibility';
import { useShareMembers } from './invite-teammate/useShareMembers';
import {
  flushShareLayoutSave,
  useSharePreview,
} from './invite-teammate/useSharePreview';
import { useShareRecipients } from './invite-teammate/useShareRecipients';
import {
  organizationFieldsForOwnerKey,
  organizationIdForOwnerKey,
  ownerKeyForOrganizationId,
  useShareRequestScope,
} from './invite-teammate/shareRequestScope';
import { postShareToast } from '@/lib/share-toast';
import { useSidebarScopingContext } from '@/components/sidebar/useSidebarScopingContext';

/** The invite audiences, in the selector's fixed order. */
const ALL_INVITE_AUDIENCES: readonly SharedContainerInviteAudience[] = [
  'team',
  'organization',
  'public',
];
const MEMBER_INVITE_AUDIENCES: readonly SharedContainerInviteAudience[] = [
  'team',
  'organization',
];

function toInviteAudience(
  audience: ShareAudience | null,
): SharedContainerInviteAudience | null {
  return audience === 'team' ||
    audience === 'organization' ||
    audience === 'public'
    ? audience
    : null;
}

type ModalState = 'idle' | 'sharing' | 'error';

/**
 * Lifecycle of the one-click GitHub recovery, tracked separately from
 * `ModalState` because the two are about different mutations: `ModalState`
 * describes the invite, and this describes the push that has to succeed before
 * an invite is even offered.
 */
type GithubPushState = 'idle' | 'pushing' | 'push-error';

export interface InviteTeammateModalProps {
  projectId: string;
  worktreeId: string;
  containerType: SharedContainerType;
  /** Display name of the worktree or Work Entry, used in the disclosure copy. */
  containerName: string;
  onClose: () => void;
  ownerDocument?: Document;
  /** Context immediately before a sidebar-driven remount of this open dialog. */
  previousContext?: WorkspaceContext;
}

/**
 * Dialog shell for the publisher side of shared containers: organization
 * resolution, tab state, and the invite mutation.
 *
 * Everything else lives in `./invite-teammate/` - one hook per request family
 * (eligibility, preview + approved scope, container/recipients, members) and
 * one component per pane. This file is deliberately the only public entry: its
 * callers and the App Advisor action must not have to know about the split.
 */
export function InviteTeammateModal({
  projectId,
  worktreeId,
  containerType,
  containerName,
  onClose,
  ownerDocument,
  previousContext,
}: InviteTeammateModalProps): JSX.Element {
  const sharedContainersEnabled = useCanopyDesktopSharedContainersEnabled();
  const externalSharingEnabled =
    useCanopySharedContainerExternalSharingEnabled();
  const organizations = useSharedContainersStore((s) => s.organizations);
  const teams = useSharedContainersStore((s) => s.teams);
  const orgBillingStates = useSharedContainersStore((s) => s.orgBillingStates);
  const setPublicationState = useSharedContainersStore(
    (s) => s.setPublicationState,
  );
  const recordSharedTarget = useSharedContainersStore(
    (s) => s.recordSharedTarget,
  );
  const context = useSidebarScopingContext();
  const contextKey =
    context === undefined ? null : serializeWorkspaceContext(context);

  /**
   * Organizations whose plan still includes teammate sharing.
   *
   * `isOrgTeamsLapsed` fails open by design - only a literal
   * `teamsEntitled: false` gates, so an absent or malformed billing state
   * keeps the organization visible. That asymmetry is load-bearing: filtering
   * on unknown state would let a degraded account read silently hide sharing
   * from an entitled user.
   */
  const eligibleOrganizations = useMemo(
    () =>
      organizations.filter(
        (organization) => !isOrgTeamsLapsed(orgBillingStates, organization.id),
      ),
    [organizations, orgBillingStates],
  );
  const allOrganizationsIneligible =
    organizations.length > 0 && eligibleOrganizations.length === 0;

  const [organizationId, setOrganizationId] = useState(
    () => defaultOrganizationForContext(context, eligibleOrganizations) ?? '',
  );
  const [contextChangedLabel, setContextChangedLabel] = useState<string | null>(
    () =>
      previousContext !== undefined &&
      context !== undefined &&
      serializeWorkspaceContext(previousContext) !== contextKey
        ? contextLabel(context, organizations)
        : null,
  );
  const [organizationSearch, setOrganizationSearch] = useState('');
  const organizationLabelId = useId();
  // The eligible list is already in memory, so the picker filters it locally
  // instead of searching through the shared-target loaders. The selected
  // organization always stays listed: the picker is the only place the
  // current choice is shown, so a query must not hide it.
  const organizationTargets = useMemo(() => {
    const query = organizationSearch.trim().toLowerCase();
    return eligibleOrganizations
      .filter(
        (organization) =>
          query.length === 0 ||
          organization.id === organizationId ||
          organization.name.toLowerCase().includes(query),
      )
      .map(toShareTarget);
  }, [eligibleOrganizations, organizationSearch, organizationId]);
  const [resetToken, setResetToken] = useState(0);

  const [managingExistingAccess, setManagingExistingAccess] = useState(
    !sharedContainersEnabled,
  );
  const [modalState, setModalState] = useState<ModalState>('idle');
  const [committed, setCommitted] = useState(false);
  const [focusToken, setFocusToken] = useState(0);
  const [highlightedGrantId, setHighlightedGrantId] = useState<string | null>(
    null,
  );
  const [eligibilityLoading, setEligibilityLoading] = useState(true);
  const [eligibility, setEligibility] =
    useState<SharedContainerEligibilityResponse | null>(null);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [githubPushState, setGithubPushState] =
    useState<GithubPushState>('idle');
  /**
   * Automatic re-checks spent on a `not-yet-synced` project. The cloud usually
   * finishes registering within seconds, so the modal waits in place instead
   * of handing the owner a dead end; once the cap is reached the state falls
   * through to the Try again failure.
   */
  const [registrationRecheckCount, setRegistrationRecheckCount] = useState(0);
  const [emailRecipient, setEmailRecipient] = useState('');
  const [teamId, setTeamId] = useState('');
  const [teamSearch, setTeamSearch] = useState('');
  const [requestedAudience] = useState(() =>
    consumeRequestedSharedContainerInviteAudience(projectId, worktreeId),
  );

  useEffect(() => {
    if (highlightedGrantId === null) return undefined;
    const timer = window.setTimeout(() => setHighlightedGrantId(null), 2_000);
    return (): void => window.clearTimeout(timer);
  }, [highlightedGrantId]);

  /**
   * Who owns the container. An org-owned workspace or an existing anchor fixes
   * it (no organization choice); otherwise Team and Organization use the
   * picked organization and Public makes a personal container.
   */
  const ownerFixed = eligibility?.ownerFixed === true;
  // Teams come from the organization that will own the share.
  const teamOrganizationId = ownerFixed
    ? (eligibility?.ownerOrganizationId ?? '')
    : organizationId;
  const organizationTeams = useMemo(
    () => teams.filter((team) => team.organization.id === teamOrganizationId),
    [teams, teamOrganizationId],
  );

  const offeredAudiences = externalSharingEnabled
    ? ALL_INVITE_AUDIENCES
    : MEMBER_INVITE_AUDIENCES;
  const eligibleTeamAudience = eligibility?.audiences?.team;
  const eligibleOrganizationAudience = eligibility?.audiences?.organization;
  const eligiblePublicAudience = eligibility?.audiences?.public;
  const audienceAvailability = useMemo(
    (): Record<SharedContainerInviteAudience, boolean> => ({
      team: (eligibleTeamAudience ?? true) && organizationTeams.length > 0,
      organization:
        eligibleOrganizationAudience ?? eligibleOrganizations.length > 0,
      public: externalSharingEnabled && eligiblePublicAudience === true,
    }),
    [
      eligibleTeamAudience,
      eligibleOrganizationAudience,
      eligiblePublicAudience,
      organizationTeams.length,
      eligibleOrganizations.length,
      externalSharingEnabled,
    ],
  );
  const { audience: selectedAudience, setAudience } = useShareAudience({
    offered: offeredAudiences,
    availability: audienceAvailability,
    initial: requestedAudience,
    ready: !sharedContainersEnabled || eligibility !== null,
  });
  // Nothing usable selected (e.g. every audience is off) keeps the
  // organization path, which is what the refusals are written for.
  const audience: SharedContainerInviteAudience =
    toInviteAudience(selectedAudience) ?? 'organization';
  const eligibilityAudience =
    externalSharingEnabled &&
    (organizations.length === 0 || allOrganizationsIneligible)
      ? 'public'
      : audience;

  const fixedOwnerOrganizationId = eligibility?.ownerOrganizationId;
  const ownerOrganizationIdFor = useCallback(
    (nextAudience: SharedContainerInviteAudience): string | undefined =>
      ownerFixed
        ? fixedOwnerOrganizationId
        : nextAudience === 'public'
          ? undefined
          : organizationId || undefined,
    [ownerFixed, fixedOwnerOrganizationId, organizationId],
  );
  const ownerOrganizationId = ownerOrganizationIdFor(audience);
  /**
   * The key every request is scoped by: the owning organization, or the
   * personal key. Empty while eligibility (which decides ownership) is still
   * being checked. Management-only mode never probes, so it keys by the picked
   * organization exactly as before.
   */
  const ownerKey = !sharedContainersEnabled
    ? organizationId
    : eligibility === null ||
        (ownerOrganizationId === undefined && !externalSharingEnabled)
      ? ''
      : ownerKeyForOrganizationId(ownerOrganizationId);

  const publicationState = useSharedContainersStore((s) =>
    ownerKey
      ? s.publicationStates[
          publicationStateKey(
            projectId,
            worktreeId,
            organizationIdForOwnerKey(ownerKey),
          )
        ]
      : undefined,
  );

  const scope = useShareRequestScope(ownerKey);
  const accountKind = useSharedContainersStore((s) => s.accountKind);

  const onManageExistingOnly = useCallback((): void => {
    setManagingExistingAccess(true);
  }, []);

  const {
    blockedReason,
    blockedOrgNames,
    accountReadUnavailable,
    retryAccountRead,
    refreshEligibility,
    invalidateEligibility,
  } = useShareEligibility({
    projectId,
    worktreeId,
    organizationId,
    organizationPickRequired:
      organizationId === '' && eligibleOrganizations.length > 0,
    audience: eligibilityAudience,
    containerType,
    newInvitesEnabled: sharedContainersEnabled,
    externalSharingEnabled,
    scope,
    eligibility,
    setEligibility,
    setEligibilityLoading,
    onManageExistingOnly,
  });

  const selectOrganization = useCallback(
    (nextOrganizationId: string): void => {
      // Invalidate first, synchronously: a request from the previous
      // organization may settle in the same turn as this state transition,
      // before React renders the new id. With invites on, ownership is
      // unknown until the new probe answers, so the scope goes empty.
      scope.setActiveOrganizationId(
        sharedContainersEnabled ? '' : nextOrganizationId,
      );
      invalidateEligibility();
      setResetToken((current) => current + 1);
      setOrganizationId(nextOrganizationId);
      setManagingExistingAccess(!sharedContainersEnabled);
      setModalState('idle');
      setGithubPushState('idle');
      setRegistrationRecheckCount(0);
      setTeamId('');
      setTeamSearch('');
      const probesWithoutOrganization =
        externalSharingEnabled && accountKind === 'connected';
      setEligibilityLoading(
        nextOrganizationId.length > 0 || probesWithoutOrganization,
      );
      setEligibility(
        nextOrganizationId ||
          accountKind === 'unknown' ||
          probesWithoutOrganization
          ? null
          : {
              eligible: false,
              reason:
                accountKind === 'guest'
                  ? 'guest-account'
                  : accountKind === 'disconnected'
                    ? 'no-cloud-account'
                    : 'no-organization',
            },
      );
      setInlineError(null);
    },
    [
      accountKind,
      externalSharingEnabled,
      invalidateEligibility,
      sharedContainersEnabled,
      scope,
    ],
  );

  useEffect(() => {
    if (
      organizationId &&
      eligibleOrganizations.some(
        (organization) => organization.id === organizationId,
      )
    ) {
      return;
    }
    const nextOrganizationId =
      defaultOrganizationForContext(context, eligibleOrganizations) ?? '';
    // There is nothing to switch to. Re-running the reset would bump
    // `resetToken` on every render, and the empty-organization refusal is
    // already produced by the eligibility probe's `!organizationId` branch.
    if (nextOrganizationId === organizationId) return;
    selectOrganization(nextOrganizationId);
  }, [context, eligibleOrganizations, organizationId, selectOrganization]);

  /**
   * Switching audience can change who owns the container (Public on a
   * personal workspace makes a personal one). When it does, everything keyed
   * by the old owner is invalidated at the click, exactly like an
   * organization switch; otherwise only the recipient input resets.
   */
  const selectAudience = useCallback(
    (next: ShareAudience): void => {
      const nextAudience = toInviteAudience(next);
      if (!nextAudience || nextAudience === audience) return;
      const nextOwnerKey = ownerKeyForOrganizationId(
        ownerOrganizationIdFor(nextAudience),
      );
      if (eligibility !== null && nextOwnerKey !== ownerKey) {
        scope.setActiveOrganizationId(nextOwnerKey);
        setResetToken((current) => current + 1);
      }
      setAudience(nextAudience);
      setEmailRecipient('');
      setModalState('idle');
      setInlineError(null);
    },
    [
      audience,
      eligibility,
      ownerKey,
      ownerOrganizationIdFor,
      scope,
      setAudience,
    ],
  );

  // Context narrows the list, but choosing a team grants access and therefore
  // always remains explicit.
  const selectedTeam =
    organizationTeams.find((team) => team.id === teamId) ?? null;
  const selectedTeamId = selectedTeam?.id;
  const teamTargets = useMemo(() => {
    const query = teamSearch.trim().toLowerCase();
    return organizationTeams
      .filter(
        (team) =>
          query.length === 0 ||
          team.id === selectedTeamId ||
          team.name.toLowerCase().includes(query),
      )
      .map(toShareTarget);
  }, [organizationTeams, teamSearch, selectedTeamId]);

  const onRevocationRequested = useCallback((): void => {
    setManagingExistingAccess(true);
    setInlineError(null);
  }, []);

  const recipients = useShareRecipients({
    projectId,
    worktreeId,
    ownerKey,
    scope,
    onInlineError: setInlineError,
    onRevocationRequested,
    resetToken,
  });

  const share = useSharePreview({
    projectId,
    worktreeId,
    ownerKey,
    containerType,
    newInvitesEnabled: sharedContainersEnabled,
    eligible: eligibility?.eligible === true,
    scope,
    onScopeError: setInlineError,
    resetToken,
  });

  // Team and Organization pick from the owning organization's member list;
  // Public takes an email address, so no member search runs for it.
  const memberSearchOrganizationId =
    audience === 'public' || (audience === 'team' && !selectedTeamId)
      ? ''
      : (organizationIdForOwnerKey(ownerKey) ?? '');
  const members = useShareMembers({
    organizationId: memberSearchOrganizationId,
    teamId: audience === 'team' ? selectedTeamId : undefined,
    ownerKey,
    newInvitesEnabled: sharedContainersEnabled,
    eligible: eligibility?.eligible === true,
    scope,
    existingRecipientIds: recipients.existingRecipientIds,
    resetToken,
  });

  // Link sharing is part of the external-sharing rollout and exists only for
  // worktree and Cowork containers.
  const linkSharingOffered =
    externalSharingEnabled && containerType !== 'CLOUD_CHAT';
  const { refreshPreferredLayoutAfterShare } = share;
  const handleLinkContainerCreated = useCallback(
    (
      container: SharedContainerSummary,
      nextPublicationState: SharedContainerPublicationState | undefined,
    ): void => {
      recipients.applyCreatedContainer(container.id, container.revision);
      if (nextPublicationState) setPublicationState(nextPublicationState);
      recordSharedTarget({
        projectId,
        worktreeId,
        ...(container.organizationId
          ? { organizationId: container.organizationId }
          : {}),
        containerId: container.id,
        revision: container.revision,
      });
      setCommitted(true);
      refreshPreferredLayoutAfterShare();
    },
    [
      projectId,
      recipients,
      recordSharedTarget,
      refreshPreferredLayoutAfterShare,
      setPublicationState,
      worktreeId,
    ],
  );
  const shareLink = useShareLink({
    containerId: linkSharingOffered ? recipients.containerId : null,
    createTarget:
      linkSharingOffered && eligibility?.eligible === true && ownerKey
        ? {
            projectId,
            worktreeId,
            containerType,
            ...organizationFieldsForOwnerKey(ownerKey),
          }
        : null,
    onContainerCreated: handleLinkContainerCreated,
  });

  const isBusy =
    modalState === 'sharing' ||
    recipients.isMutating ||
    shareLink.saving ||
    share.fileScopeSaving ||
    // A push mutates the remote. Folding it into the shared busy flag is what
    // stops an organization switch, a backdrop click, or a second share action
    // from racing it.
    githubPushState === 'pushing' ||
    share.budgetPush.state === 'pushing';

  useContextRebind(
    context,
    (next): void => {
      selectOrganization(
        defaultOrganizationForContext(next, eligibleOrganizations) ?? '',
      );
      setContextChangedLabel(contextLabel(next, organizations));
    },
    ownerFixed || committed || isBusy,
  );

  useCurrentUiStateReporter('sharedContainers.inviteModal', {
    open: true,
    projectId,
    worktreeId,
    containerType,
    containerName,
    organizationId: organizationIdForOwnerKey(ownerKey) ?? null,
    audience,
    availableAudiences: offeredAudiences.filter(
      (candidate) => audienceAvailability[candidate],
    ),
    status: modalState,
    contextChanged: contextChangedLabel !== null,
    committed,
    blockedReason: blockedReason ?? null,
    containerId: recipients.containerId,
    recipientCount: recipients.recipients.length,
    // Email recipients are reported by grant id and status only; the address
    // never crosses the provider boundary.
    recipients: recipients.recipients.slice(0, 50).map(
      (grant): Record<string, string> =>
        grant.recipient.kind === 'member'
          ? {
              grantId: grant.id,
              kind: 'member',
              userId: grant.recipient.userId,
              name: grant.recipient.name,
            }
          : {
              grantId: grant.id,
              kind: 'email',
              status: grant.recipient.status,
            },
    ),
    selectedRecipientUserId: members.selectedMember?.userId ?? null,
    // The audience only: the link itself is a capability and never leaves
    // the renderer.
    linkAudience: linkSharingOffered
      ? (shareLink.link?.audience ?? 'off')
      : null,
    // Two facts about the layout only; the approved scope stays out.
    preferredLayoutEnabled: share.preferredLayoutEnabled,
    preferredLayoutPinnedAt: share.preferredLayoutPinnedAt,
  });

  const clearTransientState = useCallback((): void => {
    setInlineError(null);
    setModalState((current) => (current === 'error' ? 'idle' : current));
  }, []);

  const handleQueryChange = useCallback(
    (next: string): void => {
      members.setMemberQuery(next);
      members.setSelectedMember(null);
      clearTransientState();
    },
    [members, clearTransientState],
  );

  const handleEmailChange = useCallback(
    (next: string): void => {
      setEmailRecipient(next);
      clearTransientState();
    },
    [clearTransientState],
  );

  const handleSelectMember = useCallback(
    (member: SharedContainerMemberSummary | null): void => {
      members.setSelectedMember(member);
      clearTransientState();
    },
    [members, clearTransientState],
  );

  const handleInvite = useCallback((): void => {
    if (!ownerKey) return;
    const selectedMember = members.selectedMember;
    const email = emailRecipient.trim();
    let recipient: SharedContainerRecipientRequest;
    let recipientLabel: string;
    if (audience === 'public') {
      if (!isEmailRecipientValid(email)) return;
      recipient = { kind: 'email', email };
      recipientLabel = email;
    } else {
      if (!selectedMember) return;
      recipient = { kind: 'member', userId: selectedMember.userId };
      recipientLabel = selectedMember.name;
    }
    const mutationId = recipients.beginMutation();
    const requestOrganizationId = ownerKey;
    const requestOrganizationFields = organizationFieldsForOwnerKey(ownerKey);
    setModalState('sharing');
    setInlineError(null);
    void (async (): Promise<void> => {
      try {
        // The first invite saves the layout, so main must read the one on
        // screen rather than the last debounced save.
        await flushShareLayoutSave(projectId, worktreeId);
        const response = await window.api.sharedContainers.invite({
          projectId,
          worktreeId,
          ...requestOrganizationFields,
          containerType,
          audience,
          recipient,
          capabilities: ['VIEW'],
        });
        if (
          scope.isStale(requestOrganizationId) ||
          !recipients.isCurrentMutation(mutationId)
        ) {
          return;
        }
        if (!response.invited) {
          if (
            response.reason === 'insufficient-role' ||
            response.reason === 'blocked-by-org-billing' ||
            response.reason === 'external-sharing-disabled'
          ) {
            setInlineError(
              response.reason === 'insufficient-role'
                ? INSUFFICIENT_ROLE_LABEL
                : response.reason === 'external-sharing-disabled'
                  ? (accountRefusal(
                      'external-sharing-disabled',
                      response.blockedByOrganizationNames ?? [],
                    )?.description ?? FAILURE_LABEL)
                  : BILLING_REFUSAL_LABEL,
            );
            setModalState('error');
          } else {
            setEligibility({
              eligible: false,
              reason: response.reason,
              blockedByOrganizationNames: response.blockedByOrganizationNames,
            });
            setModalState('idle');
            if (response.reason === 'github-not-ready') {
              // The invite refusal names the blocker but carries no Git
              // classification, and an unclassified one renders as "could not
              // check". Re-probe so the state the user lands on is the real
              // one - which, for a branch that simply moved ahead of its
              // remote, is the recoverable push.
              refreshEligibility();
            }
          }
          return;
        }
        recipients.applyInvitedGrant(response.container.id, response.grant);
        setPublicationState(response.publicationState);
        // The container now exists on the server. Record it so the sidebar
        // badge appears immediately rather than at the next account-level
        // hydration. The revision comes from the server's own container
        // summary rather than being assumed: inviting a second teammate
        // reuses an already-published container, and writing a fabricated `0`
        // over its real revision would contradict the field's contract
        // ("0 means never published").
        recordSharedTarget({
          projectId,
          worktreeId,
          ...requestOrganizationFields,
          containerId: response.container.id,
          revision: response.container.revision,
        });
        members.setSelectedMember(null);
        members.setMemberQuery('');
        setEmailRecipient('');
        setCommitted(true);
        // Main saved the layout when it created the share.
        refreshPreferredLayoutAfterShare();
        setModalState('idle');
        setFocusToken((current) => current + 1);
        setHighlightedGrantId(response.grant.id);
        const invitedLabel =
          response.grant.recipient.kind === 'email'
            ? response.grant.recipient.email
            : recipientLabel;
        postShareToast({
          tone: 'success',
          message: invitedToastMessage(invitedLabel),
          // It names the invited person or address.
          blockMessageFromReplay: true,
        });
      } catch {
        if (
          scope.isStale(requestOrganizationId) ||
          !recipients.isCurrentMutation(mutationId)
        ) {
          return;
        }
        setInlineError(FAILURE_LABEL);
        setModalState('error');
      }
    })();
  }, [
    audience,
    emailRecipient,
    members,
    ownerKey,
    projectId,
    worktreeId,
    containerType,
    setPublicationState,
    recordSharedTarget,
    recipients,
    scope,
    refreshEligibility,
    refreshPreferredLayoutAfterShare,
  ]);

  /**
   * The classified Git state behind a `github-not-ready` refusal.
   *
   * An absent detail field fails safe as `blocked/unavailable`: a response
   * from an older main process, or one that lost the field, must not be read
   * as "a push will fix this" and grow a mutating button.
   */
  const githubReadiness: SharedContainerGithubReadiness | null =
    blockedReason === 'github-not-ready'
      ? (eligibility?.githubReadiness ?? {
          status: 'blocked',
          reason: 'unavailable',
        })
      : null;
  const githubRecovery = githubReadiness
    ? githubRecoveryCopy(githubReadiness)
    : null;

  const handlePushToGithub = useCallback((): void => {
    if (!ownerKey) return;
    const requestOrganizationId = ownerKey;
    setGithubPushState('pushing');
    setInlineError(null);
    void (async (): Promise<void> => {
      try {
        const response = await window.api.sharedContainers.prepareGithub({
          projectId,
          worktreeId,
          ...organizationFieldsForOwnerKey(requestOrganizationId),
          containerType,
        });
        // The organization changed, or the modal went away, while the push was
        // in flight. The push itself still happened - it is safe and
        // idempotent - but this answer no longer describes what is on screen.
        //
        // Clear `pushing` unconditionally before returning: it feeds `isBusy`,
        // which disables the backdrop, the X, and the organization selector.
        // Leaving it set relies on every caller that can make a response stale
        // also resetting the state, which is an invariant spread across files
        // rather than one this function guarantees.
        if (scope.isStale(requestOrganizationId)) {
          setGithubPushState('idle');
          return;
        }
        if (response.status === 'ready') {
          setGithubPushState('idle');
          // Continue in place: re-ask the whole eligibility question so the
          // normal invite surface replaces the blocker without the user
          // closing and reopening Share.
          refreshEligibility();
          return;
        }
        if (response.status === 'blocked') {
          // A re-probe found something a push cannot fix. Swap in the new
          // classification so the concise guidance for it renders now.
          setGithubPushState('idle');
          setEligibility({
            eligible: false,
            reason: 'github-not-ready',
            githubReadiness: response.readiness,
          });
          return;
        }
        setGithubPushState('push-error');
      } catch {
        if (scope.isStale(requestOrganizationId)) {
          setGithubPushState('idle');
          return;
        }
        setGithubPushState('push-error');
      }
    })();
  }, [
    ownerKey,
    projectId,
    worktreeId,
    containerType,
    scope,
    refreshEligibility,
  ]);

  const handleRecheckGithub = useCallback((): void => {
    setGithubPushState('idle');
    refreshEligibility();
  }, [refreshEligibility]);

  const registrationPending = blockedReason === 'not-yet-synced';
  // While a re-check is in flight the last answer is still `not-yet-synced`,
  // so keep showing progress rather than flashing "Checking access...".
  const showRegistrationProgress =
    registrationPending &&
    (registrationRecheckCount < REGISTRATION_RECHECK_LIMIT ||
      eligibilityLoading);
  const showRegistrationFailure =
    (blockedReason === 'registration-failed' ||
      (registrationPending && !showRegistrationProgress)) &&
    !eligibilityLoading;

  useEffect(() => {
    if (
      !registrationPending ||
      eligibilityLoading ||
      registrationRecheckCount >= REGISTRATION_RECHECK_LIMIT
    ) {
      return;
    }
    const timer = window.setTimeout(() => {
      setRegistrationRecheckCount((current) => current + 1);
      refreshEligibility();
    }, REGISTRATION_RECHECK_INTERVAL_MS);
    return (): void => {
      window.clearTimeout(timer);
    };
  }, [
    registrationPending,
    eligibilityLoading,
    registrationRecheckCount,
    refreshEligibility,
  ]);

  const handleRetryRegistration = useCallback((): void => {
    setRegistrationRecheckCount(0);
    refreshEligibility();
  }, [refreshEligibility]);

  const refusal =
    blockedReason !== undefined
      ? accountRefusal(blockedReason, blockedOrgNames)
      : null;
  const registrationProgressCopy = accountRefusal('not-yet-synced', []);
  const registrationFailureCopy = accountRefusal('registration-failed', []);
  const setupCtaReason =
    blockedReason === 'sync-disabled' || blockedReason === 'sync-blocked-by-org'
      ? blockedReason
      : null;
  const modalTitle = sharedContainersEnabled ? TITLE : MANAGE_TITLE;
  const nameOrganizationId = ownerOrganizationId ?? organizationId;
  const selectedOrganizationName =
    eligibleOrganizations.find(
      (organization) => organization.id === nameOrganizationId,
    )?.name ??
    organizations.find((organization) => organization.id === nameOrganizationId)
      ?.name ??
    null;

  const showManageExisting = recipients.containerId
    ? (): void => {
        setManagingExistingAccess(true);
      }
    : undefined;

  // Ownership fixed by the workspace or an existing share, or a personal
  // (Public) share, leaves no organization to choose.
  const organizationSelector =
    (eligibleOrganizations.length >= 2 || !organizationId) &&
    !(sharedContainersEnabled && (ownerFixed || audience === 'public')) ? (
      <Stack gap="tight" role="group" aria-labelledby={organizationLabelId}>
        <p id={organizationLabelId} className="text-xs fg-secondary">
          Organization
        </p>
        <OrgTeamPicker
          kind="organization"
          items={organizationTargets}
          selectedId={organizationId}
          onSelect={(organization) => {
            // Picker rows fire on every click, unlike the <select> they
            // replaced. Re-selecting the current organization must be a
            // no-op: selectOrganization resets eligibility, and the probe only
            // re-runs when the id changes, so it would never finish loading.
            if (organization.id !== organizationId) {
              selectOrganization(organization.id);
            }
          }}
          searchValue={organizationSearch}
          onSearchChange={setOrganizationSearch}
          loading={false}
          error={null}
          disabled={isBusy}
          dataTestId="shared-container-invite-modal-organization"
        />
      </Stack>
    ) : selectedOrganizationName ? (
      <p
        className="text-s fg-primary"
        data-testid="shared-container-invite-modal-organization-name"
      >
        {selectedOrganizationName}
      </p>
    ) : null;

  const publicHint =
    offeredAudiences.includes('public') && !audienceAvailability.public
      ? eligibility?.publicBlockedReason === 'external-sharing-disabled'
        ? PUBLIC_EXTERNAL_SHARING_OFF_HINT
        : eligibility?.publicBlockedReason === 'feature-disabled'
          ? PUBLIC_UNAVAILABLE_HINT
          : null
      : null;
  const teamHint =
    !audienceAvailability.team && audienceAvailability.organization
      ? TEAM_UNAVAILABLE_HINT
      : null;
  // Shown on the invite pane only. Never in management-only mode or over a
  // refusal: the audience only decides who a *new* invite reaches.
  const audienceSelector =
    sharedContainersEnabled && eligibility !== null ? (
      <ShareAudienceSelector
        contentGap="inline"
        offered={offeredAudiences}
        availability={audienceAvailability}
        value={selectedAudience}
        onChange={selectAudience}
        legend={AUDIENCE_LEGEND}
        descriptions={AUDIENCE_DESCRIPTIONS}
        hint={
          publicHint || teamHint ? (
            <p
              className="text-xs fg-secondary"
              data-testid="shared-container-invite-scope-hint"
            >
              {[teamHint, publicHint].filter(Boolean).join(' ')}
            </p>
          ) : undefined
        }
        disabled={isBusy}
        dataTestId="shared-container-invite-scope"
      />
    ) : null;
  const teamSelector =
    sharedContainersEnabled &&
    audience === 'team' &&
    organizationTeams.length > 0 ? (
      <Stack gap="tight" role="group" aria-label={TEAM_LABEL}>
        <p className="text-xs fg-secondary">{TEAM_LABEL}</p>
        <OrgTeamPicker
          kind="team"
          items={teamTargets}
          selectedId={selectedTeamId ?? ''}
          onSelect={(team) => {
            if (team.id !== selectedTeamId) {
              setTeamId(team.id);
              clearTransientState();
            }
          }}
          searchValue={teamSearch}
          onSearchChange={setTeamSearch}
          loading={false}
          error={null}
          disabled={isBusy}
          dataTestId="shared-container-invite-modal-team"
        />
        {selectedTeam === null ? (
          <p className="text-xs fg-secondary">Choose a team.</p>
        ) : null}
      </Stack>
    ) : null;

  const ineligibleCopy =
    allOrganizationsIneligible &&
    (!externalSharingEnabled ||
      (eligibility !== null && !audienceAvailability.public))
      ? allOrganizationsIneligibleCopy(
          organizations.map((organization) => organization.name),
        )
      : null;

  const pickerState = memberPickerState(
    members,
    eligibility?.eligible === true,
  );
  const readiness = recipientReadiness(
    audience,
    {
      value: emailRecipient,
      existing: recipients.existingRecipientEmails,
    },
    members.selectedMember,
  );
  const inviteAvailable =
    sharedContainersEnabled &&
    eligibility?.eligible === true &&
    !managingExistingAccess;
  const showScopeInInvite =
    inviteAvailable && (audience === 'public' || !pickerState.hideSearch);
  // An empty list is noise on a first share: the section appears once
  // somebody holds access (or the list could not load). Managing existing
  // access keeps it, since there the list is the whole dialog.
  const showPeople =
    managingExistingAccess ||
    !sharedContainersEnabled ||
    recipients.recipients.length > 0 ||
    recipients.recipientsError;

  // A container's link belongs to whoever owns the container: its
  // organization, or nobody for a personal one.
  const linkOrganizationId = organizationIdForOwnerKey(ownerKey);
  const linkOrganizationName = linkOrganizationId
    ? (organizations.find(
        (organization) => organization.id === linkOrganizationId,
      )?.name ?? selectedOrganizationName)
    : null;
  // An owner or admin of the link's organization can change the policy that
  // keeps links for outside people off.
  const linkOrganizationRole = linkOrganizationId
    ? organizations.find(
        (organization) => organization.id === linkOrganizationId,
      )?.role
    : undefined;
  const linkPolicyManageable =
    linkOrganizationRole === 'OWNER' || linkOrganizationRole === 'ADMIN';
  const linkAvailability = eligibility?.link ?? {
    anyone: audienceAvailability.public,
    organization: linkOrganizationId !== undefined,
  };
  // With no People with access section, a live link is the only audience and
  // its heading carries the publish status instead.
  const linkPublishStatusShown =
    !showPeople && recipients.containerId !== null && shareLink.link !== null;
  const linkSection = linkSharingOffered ? (
    <LinkSharingSection
      link={shareLink}
      organizationName={linkOrganizationName}
      availability={{
        anyone: linkAvailability.anyone,
        organization:
          linkAvailability.organization && linkOrganizationId !== undefined,
      }}
      anyoneBlockedByPolicy={
        eligibility?.publicBlockedReason === 'external-sharing-disabled'
      }
      {...(linkOrganizationId && linkPolicyManageable
        ? {
            policyLink: {
              organizationId: linkOrganizationId,
              onOpened: onClose,
            },
          }
        : {})}
      disabled={modalState === 'sharing' || recipients.isMutating}
      separated={showPeople ? true : inviteAvailable}
      {...(linkPublishStatusShown
        ? {
            status: (
              <SharePublishStatus
                publicationState={publicationState}
                serverRevision={recipients.serverRevision}
              />
            ),
            issue: (
              <SharePublishIssue
                publicationState={publicationState}
                serverRevision={recipients.serverRevision}
                budgetPush={share.budgetPush}
                onRetry={share.retryPublication}
                retrying={share.fileScopeSaving}
              />
            ),
          }
        : {})}
      {...(ownerDocument ? { ownerDocument } : {})}
    />
  ) : null;

  // A live link is already the share. Until the owner starts adding someone,
  // a disabled Share button would only read as one more required step, so it
  // steps aside and Copy link and Done carry the footer.
  const linkShared = linkSection !== null && shareLink.link !== null;
  const recipientPending =
    audience === 'public'
      ? emailRecipient.trim().length > 0
      : members.selectedMember !== null ||
        members.memberQuery.trim().length > 0;

  let gate: JSX.Element | null = null;
  let gateSubmit:
    | {
        label: string;
        loadingLabel: string;
        onSubmit: () => void;
        testId?: string;
      }
    | undefined;

  const organizationPickRequired =
    organizationId === '' &&
    eligibleOrganizations.length > 0 &&
    !(sharedContainersEnabled && ownerFixed);

  if (organizationPickRequired) {
    gate = (
      <ShareBlockedState
        dataTestId="shared-container-invite-choose-organization"
        title="Choose an organization"
        description="Choose which organization should own this share."
        header={organizationSelector}
      />
    );
  } else if (accountReadUnavailable) {
    gate = (
      <ShareBlockedState
        dataTestId="shared-container-invite-account-unavailable"
        title={ACCOUNT_UNAVAILABLE_TITLE}
        description={ACCOUNT_UNAVAILABLE_BODY}
      />
    );
    gateSubmit = {
      label: TRY_AGAIN_LABEL,
      loadingLabel: CHECKING_LABEL,
      onSubmit: retryAccountRead,
      testId: 'shared-container-invite-account-retry',
    };
  } else if (ineligibleCopy && !managingExistingAccess) {
    gate = (
      <ShareBlockedState
        dataTestId="shared-container-invite-orgs-ineligible"
        title={ineligibleCopy.title}
        description={ineligibleCopy.description}
      />
    );
  } else if (
    showRegistrationProgress &&
    registrationProgressCopy &&
    !managingExistingAccess
  ) {
    gate = (
      <ShareBlockedState
        dataTestId="shared-container-invite-registration-pending"
        title={registrationProgressCopy.title}
        description={registrationProgressCopy.description}
        header={organizationSelector}
        busy
      >
        <div
          className="flex items-center"
          data-testid="shared-container-invite-registration-spinner"
        >
          <LoadingSpinner tone="secondary" />
        </div>
      </ShareBlockedState>
    );
  } else if (eligibilityLoading) {
    gate = (
      <div className="px-1 py-6 text-center">
        <p className="text-s fg-secondary">{CHECKING_LABEL}</p>
      </div>
    );
  } else if (setupCtaReason && !managingExistingAccess) {
    gate = (
      <ShareBlockedState
        dataTestId="shared-container-invite-setup"
        header={organizationSelector}
      >
        <ShareSetupCta
          reason={setupCtaReason}
          blockedByOrganizationNames={blockedOrgNames}
          // The owner eligibility evaluated: null for personal work, even when
          // an organization is picked, so a Public share asks for Just me.
          // With external sharing off, every share is organization-owned and
          // the answer names no owner, so the picked organization stands.
          organizationId={
            eligibility?.ownerOrganizationId ??
            (externalSharingEnabled ? null : organizationId || null)
          }
          onSharingEnabled={refreshEligibility}
          onNavigate={onClose}
        />
      </ShareBlockedState>
    );
  } else if (githubRecovery && !managingExistingAccess) {
    gate = (
      <ShareBlockedState
        dataTestId="shared-container-invite-blocked"
        title={githubRecovery.title}
        description={githubRecovery.description}
        header={organizationSelector}
        busy={githubPushState === 'pushing'}
        actionError={
          githubPushState === 'push-error' ? GITHUB_PUSH_ERROR_LABEL : null
        }
      />
    );
    if (githubRecovery.action !== 'none') {
      const pushing = githubRecovery.action === 'push';
      gateSubmit = {
        label:
          githubRecovery.action === 'recheck' ||
          githubPushState === 'push-error'
            ? TRY_AGAIN_LABEL
            : PUSH_TO_GITHUB_LABEL,
        loadingLabel: pushing ? PUSHING_LABEL : CHECKING_LABEL,
        onSubmit: pushing ? handlePushToGithub : handleRecheckGithub,
        testId: pushing
          ? 'shared-container-invite-push-github'
          : 'shared-container-invite-recheck-github',
      };
    }
  } else if (
    showRegistrationFailure &&
    registrationFailureCopy &&
    !managingExistingAccess
  ) {
    gate = (
      <ShareBlockedState
        dataTestId="shared-container-invite-registration-failed"
        title={registrationFailureCopy.title}
        description={registrationFailureCopy.description}
        header={organizationSelector}
      />
    );
    gateSubmit = {
      label: TRY_AGAIN_LABEL,
      loadingLabel: CHECKING_LABEL,
      onSubmit: handleRetryRegistration,
      testId: 'shared-container-invite-registration-retry',
    };
  } else if (refusal && !managingExistingAccess) {
    gate = (
      <ShareBlockedState
        dataTestId="shared-container-invite-blocked"
        title={refusal.title}
        description={refusal.description}
        header={organizationSelector}
      />
    );
  }

  if (gate && contextChangedLabel) {
    gate = (
      <Stack gap="item">
        <ContextChangedNotice
          label={contextChangedLabel}
          data-testid="shared-container-invite-context-changed"
        />
        {gate}
      </Stack>
    );
  }

  const manageExistingAction: ShareFooterSecondaryAction | undefined =
    gate && showManageExisting
      ? {
          label: MANAGE_EXISTING_LABEL,
          onClick: showManageExisting,
          disabled: isBusy,
          testId: 'shared-container-invite-modal-manage-existing',
        }
      : undefined;
  const frameSharing =
    modalState === 'sharing' || githubPushState === 'pushing';
  const frameError = inlineError !== null;
  const managementOnly = managingExistingAccess || !sharedContainersEnabled;

  return (
    <ShareDialogFrame
      title={modalTitle}
      subtitle={containerName}
      maxWidth="md"
      testIdPrefix="shared-container-invite"
      ownerDocument={ownerDocument}
      onDismiss={onClose}
      lifecycle={{
        status: frameSharing ? 'sharing' : frameError ? 'error' : 'idle',
        committed: committed || managementOnly,
      }}
      busy={isBusy && !frameSharing}
      {...(gate ? { gate } : {})}
      {...(!gate && inviteAvailable
        ? {
            scope: (
              <>
                {audienceSelector}
                {organizationSelector}
                {teamSelector}
              </>
            ),
            content: (
              <InviteRecipientSection
                audience={audience}
                email={{
                  value: emailRecipient,
                  onChange: handleEmailChange,
                  existing: recipients.existingRecipientEmails,
                  ...(ownerOrganizationId && selectedOrganizationName
                    ? {
                        externalNotice: externalAudienceNotice(
                          selectedOrganizationName,
                        ),
                      }
                    : {}),
                }}
                organizationId={organizationId}
                organizationName={selectedOrganizationName ?? ''}
                containerType={containerType}
                eligible
                members={members}
                pickerState={pickerState}
                readiness={readiness}
                share={share}
                isBusy={isBusy}
                showScopePanel={showScopeInInvite}
                focusToken={focusToken}
                onQueryChange={handleQueryChange}
                onSelectMember={handleSelectMember}
                onSubmit={handleInvite}
                onClose={onClose}
              />
            ),
          }
        : {})}
      {...(!gate && (showPeople || linkSection)
        ? {
            // Google's order: People with access, then Share with a link. A
            // never-shared container has no people yet, so the link section
            // can stand on its own.
            after: (
              <>
                {showPeople ? (
                  <PeopleWithAccessSection
                    containerType={containerType}
                    recipients={recipients}
                    share={share}
                    publicationState={publicationState}
                    linkLive={shareLink.link !== null}
                    showScopePanel={!showScopeInInvite}
                    highlightedGrantId={highlightedGrantId}
                    accessActionsDisabled={modalState === 'sharing'}
                    separated={inviteAvailable}
                  />
                ) : null}
                {linkSection}
              </>
            ),
          }
        : {})}
      {...(linkSection && shareLink.url
        ? { link: { url: shareLink.url, kind: 'scoped' } }
        : {})}
      {...(frameError
        ? {
            errorMessage:
              modalState === 'error'
                ? shareFailureMessage(inlineError ?? FAILURE_LABEL)
                : (inlineError ?? FAILURE_LABEL),
          }
        : {})}
      {...(contextChangedLabel && !gate
        ? {
            notes: (
              <ContextChangedNotice
                label={contextChangedLabel}
                data-testid="shared-container-invite-context-changed"
              />
            ),
          }
        : {})}
      showSubmit={
        organizationPickRequired ||
        gateSubmit !== undefined ||
        (!gate && inviteAvailable && (!linkShared || recipientPending))
      }
      submitLabel={gateSubmit?.label ?? SHARE_LABEL}
      sharingLabel={gateSubmit?.loadingLabel ?? SHARING_LABEL}
      submitDisabled={
        gateSubmit === undefined
          ? organizationPickRequired ||
            isBusy ||
            !readiness.canSubmit ||
            !ownerKey
          : isBusy && !frameSharing
      }
      {...(gateSubmit?.testId ? { submitTestId: gateSubmit.testId } : {})}
      onSubmit={gateSubmit?.onSubmit ?? handleInvite}
      {...(manageExistingAction
        ? { secondaryAction: manageExistingAction }
        : {})}
    />
  );
}
