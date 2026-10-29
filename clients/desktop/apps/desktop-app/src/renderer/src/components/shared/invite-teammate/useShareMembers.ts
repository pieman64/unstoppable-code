import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SharedContainerMemberSummary } from '@canopy/protocol/shared-containers';
import { MAX_SHARED_CONTAINER_MEMBER_SEARCH_LIMIT } from '@canopy/protocol/shared-containers';
import { MEMBER_ERROR_LABEL, SEARCH_DEBOUNCE_MS } from './shareCopy';
import type { ShareRequestScope } from './shareRequestScope';

export interface UseShareMembersOptions {
  /**
   * Organization to search, or `''` when the selected audience does not pick
   * people from a member list (Public takes an email address instead).
   */
  organizationId: string;
  /** Narrows the search to one team (Team audience). */
  teamId?: string;
  /** Owner key the modal's request scope is keyed by. */
  ownerKey: string;
  newInvitesEnabled: boolean;
  eligible: boolean;
  scope: ShareRequestScope;
  existingRecipientIds: Set<string>;
  resetToken: number;
}

export interface UseShareMembersResult {
  memberQuery: string;
  setMemberQuery: (query: string) => void;
  members: SharedContainerMemberSummary[];
  /** Members not already holding a grant - the ones actually invitable. */
  selectableMembers: SharedContainerMemberSummary[];
  membersLoading: boolean;
  membersError: string | null;
  /**
   * False until the first search for the current organization has settled.
   * The empty states must not render before this: an unresolved fetch is not
   * evidence that the organization has nobody in it.
   */
  membersResolved: boolean;
  /**
   * True when the last search came back at the server's page ceiling, so the
   * returned members are not provably the whole organization.
   *
   * A capped page is evidence about the members it returned and about nothing
   * else. Any claim that spans the members it did *not* return - "everyone
   * already has access", "you're the only person here" - has to stay
   * unclaimed while this is true, and the search box has to stay on screen so
   * the owner can still reach the rest by name.
   */
  membersTruncated: boolean;
  selectedMember: SharedContainerMemberSummary | null;
  setSelectedMember: (member: SharedContainerMemberSummary | null) => void;
}

/** Owns the debounced organization member search and the picked recipient. */
export function useShareMembers({
  organizationId,
  teamId,
  ownerKey,
  newInvitesEnabled,
  eligible,
  scope,
  existingRecipientIds,
  resetToken,
}: UseShareMembersOptions): UseShareMembersResult {
  const [memberQuery, setMemberQuery] = useState('');
  const [members, setMembers] = useState<SharedContainerMemberSummary[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [membersResolved, setMembersResolved] = useState(false);
  const [membersTruncated, setMembersTruncated] = useState(false);
  const [selectedMember, setSelectedMember] =
    useState<SharedContainerMemberSummary | null>(null);
  const memberRequestRef = useRef(0);

  useEffect(() => {
    memberRequestRef.current += 1;
    setMemberQuery('');
    setMembers([]);
    setMembersLoading(false);
    setMembersError(null);
    setMembersResolved(false);
    setMembersTruncated(false);
    setSelectedMember(null);
  }, [resetToken]);

  // A different team (or leaving the member list) is a different set of
  // people: drop the old page and the pick rather than showing a member the
  // new search would not return.
  useEffect(() => {
    memberRequestRef.current += 1;
    setMembers([]);
    setMembersResolved(false);
    setMembersTruncated(false);
    setSelectedMember(null);
  }, [organizationId, teamId]);

  useEffect(() => {
    if (!newInvitesEnabled || !eligible || !organizationId) return;
    const requestId = ++memberRequestRef.current;
    const requestOrganizationId = organizationId;
    const requestOwnerKey = ownerKey;
    setMembersLoading(true);
    setMembersError(null);
    const timer = setTimeout(() => {
      void (async (): Promise<void> => {
        try {
          const result = await window.api.sharedContainers.searchMembers({
            organizationId: requestOrganizationId,
            ...(teamId ? { teamId } : {}),
            query: memberQuery.trim() || undefined,
            // Asked for explicitly rather than left to the server's default
            // (20), both to return as much of a small organization as one
            // page can hold and so the cap is a number this hook knows and
            // can compare against.
            limit: MAX_SHARED_CONTAINER_MEMBER_SEARCH_LIMIT,
          });
          if (
            !scope.isStale(requestOwnerKey) &&
            memberRequestRef.current === requestId
          ) {
            setMembers(result.members);
            setMembersTruncated(
              result.members.length >= MAX_SHARED_CONTAINER_MEMBER_SEARCH_LIMIT,
            );
          }
        } catch {
          if (
            !scope.isStale(requestOwnerKey) &&
            memberRequestRef.current === requestId
          ) {
            setMembersError(MEMBER_ERROR_LABEL);
          }
        } finally {
          if (
            !scope.isStale(requestOwnerKey) &&
            memberRequestRef.current === requestId
          ) {
            setMembersLoading(false);
            setMembersResolved(true);
          }
        }
      })();
    }, SEARCH_DEBOUNCE_MS);
    return (): void => clearTimeout(timer);
  }, [
    eligible,
    organizationId,
    teamId,
    ownerKey,
    memberQuery,
    newInvitesEnabled,
    scope,
  ]);

  const selectableMembers = useMemo(
    () => members.filter((member) => !existingRecipientIds.has(member.userId)),
    [members, existingRecipientIds],
  );

  const handleSetMemberQuery = useCallback((query: string): void => {
    setMemberQuery(query);
  }, []);

  return {
    memberQuery,
    setMemberQuery: handleSetMemberQuery,
    members,
    selectableMembers,
    membersLoading,
    membersError,
    membersResolved,
    membersTruncated,
    selectedMember,
    setSelectedMember,
  };
}
