import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SharedContainerGrantSummary } from '@canopy/protocol/shared-containers';
import { subscribeToSharedContainerRevocationConfirmationRequests } from '@/lib/sharedContainerRevocationConfirmationEvents';
import {
  publicationStateKey,
  useSharedContainersStore,
} from '@/stores/sharedContainersStore';
import { MAX_CURSOR_PAGES, REVOKE_ERROR_LABEL } from './shareCopy';
import {
  organizationIdForOwnerKey,
  type ShareRequestScope,
} from './shareRequestScope';

export function upsertGrants(
  current: readonly SharedContainerGrantSummary[],
  incoming: readonly SharedContainerGrantSummary[],
): SharedContainerGrantSummary[] {
  const byId = new Map(current.map((grant) => [grant.id, grant]));
  for (const grant of incoming) byId.set(grant.id, grant);
  return Array.from(byId.values());
}

export interface UseShareRecipientsOptions {
  projectId: string;
  worktreeId: string;
  /**
   * Owner key of the container (an organization id, or the personal key), or
   * `''` while ownership is not known yet. Requests wait for a key.
   */
  ownerKey: string;
  scope: ShareRequestScope;
  onInlineError: (message: string | null) => void;
  onRevocationRequested: () => void;
  resetToken: number;
}

export interface UseShareRecipientsResult {
  containerId: string | null;
  /**
   * The server's revision count for this container, or null when no server
   * record was resolved. `0` means "exists, never published"; `>= 1` means it
   * has been published at least once.
   */
  serverRevision: number | null;
  recipients: SharedContainerGrantSummary[];
  recipientsLoading: boolean;
  recipientsError: boolean;
  /** User ids of organization members who already hold a grant. */
  existingRecipientIds: Set<string>;
  /** Lower-cased addresses already invited by email. */
  existingRecipientEmails: Set<string>;
  revokingId: string | null;
  pendingRevokeGrant: SharedContainerGrantSummary | null;
  isMutating: boolean;
  requestRevoke: (grant: SharedContainerGrantSummary) => void;
  cancelRevoke: () => void;
  confirmRevoke: () => void;
  /** Applied by the shell after a successful invite. */
  applyInvitedGrant: (
    containerId: string,
    grant: SharedContainerGrantSummary,
  ) => void;
  /** Applied when first enabling a link creates the owner container. */
  applyCreatedContainer: (containerId: string, revision: number) => void;
  beginMutation: () => number;
  isCurrentMutation: (mutationId: number) => boolean;
}

/**
 * Owns container resolution, recipient paging, and revocation.
 *
 * This path stays available when rollout flags disable new invitations, so
 * existing access can never be stranded behind a feature gate.
 */
export function useShareRecipients({
  projectId,
  worktreeId,
  ownerKey,
  scope,
  onInlineError,
  onRevocationRequested,
  resetToken,
}: UseShareRecipientsOptions): UseShareRecipientsResult {
  const [containerId, setContainerId] = useState<string | null>(null);
  const [serverRevision, setServerRevision] = useState<number | null>(null);
  /**
   * True once this modal's own owner lookup has given a definite answer
   * (a container, or definitively none). Until then the account-level owner
   * listing is the only server truth available, and after a *failed* lookup it
   * is the only one left - which is exactly the offline "published from
   * another build" case the revision reconciliation exists for.
   */
  const [containerResolved, setContainerResolved] = useState(false);
  // The account-level org-wide owner listing (CAN-2551), already hydrated at
  // startup for the sidebar badge. Reusing it here is why that listing is
  // fetched once per account rather than once per surface. It resolved the
  // same container from the same server, so it is a stand-in for this modal's
  // own lookup rather than a weaker guess.
  const hydratedTarget = useSharedContainersStore((s) =>
    ownerKey
      ? (s.sharedTargets[
          publicationStateKey(
            projectId,
            worktreeId,
            organizationIdForOwnerKey(ownerKey),
          )
        ] ?? null)
      : null,
  );
  // Only stands in while this modal's own lookup has not answered. Reading it
  // is deliberately side-effect free: recipient loading is driven by the
  // explicit `loadRecipients` call below, never derived from this id, so a
  // hydrated fallback never fires a request of its own.
  const fallbackTarget = containerResolved ? null : hydratedTarget;
  const [recipients, setRecipients] = useState<SharedContainerGrantSummary[]>(
    [],
  );
  const [recipientsLoading, setRecipientsLoading] = useState(true);
  const [recipientsError, setRecipientsError] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [pendingRevokeGrant, setPendingRevokeGrant] =
    useState<SharedContainerGrantSummary | null>(null);

  const recipientRequestRef = useRef(0);
  const containerRequestRef = useRef(0);
  const mutationRequestRef = useRef(0);
  /**
   * Latest committed recipient list. `confirmRevoke` needs to know whether the
   * revoke it just performed emptied the list, and neither alternative works:
   * depending on `recipients` would rebuild the callback on every page load,
   * and deciding inside the `setRecipients` updater would put a store mutation
   * in a function React is free to invoke twice.
   */
  const recipientsRef = useRef<SharedContainerGrantSummary[]>([]);
  useEffect(() => {
    recipientsRef.current = recipients;
  }, [recipients]);

  useEffect(() => {
    recipientRequestRef.current += 1;
    containerRequestRef.current += 1;
    mutationRequestRef.current += 1;
    setContainerId(null);
    setServerRevision(null);
    setContainerResolved(false);
    setRecipients([]);
    setRecipientsLoading(true);
    setRecipientsError(false);
    setRevokingId(null);
    setPendingRevokeGrant(null);
  }, [resetToken]);

  const loadRecipients = useCallback(
    (id: string, requestOwnerKey: string): void => {
      const orgId = organizationIdForOwnerKey(requestOwnerKey);
      const requestId = ++recipientRequestRef.current;
      setRecipientsLoading(true);
      setRecipientsError(false);
      void (async (): Promise<void> => {
        try {
          const allRecipients: SharedContainerGrantSummary[] = [];
          let cursor: string | null = null;
          let pageCount = 0;
          const seenCursors = new Set<string>();
          let truncated = false;
          do {
            const result = await window.api.sharedContainers.listRecipients({
              containerId: id,
              ...(orgId ? { organizationId: orgId } : {}),
              ...(cursor ? { cursor } : {}),
            });
            allRecipients.push(...result.recipients);
            pageCount += 1;
            const nextCursor = result.nextCursor;
            truncated =
              nextCursor !== null &&
              (seenCursors.has(nextCursor) || pageCount >= MAX_CURSOR_PAGES);
            cursor = nextCursor === null || truncated ? null : nextCursor;
            if (cursor) seenCursors.add(cursor);
          } while (cursor);
          if (
            !scope.isStale(requestOwnerKey) &&
            recipientRequestRef.current === requestId
          ) {
            setRecipients(upsertGrants([], allRecipients));
            setRecipientsError(truncated);
          }
        } catch {
          // Leave the previous list in place; a transient list failure is not
          // a reason to claim nobody has access.
          if (
            !scope.isStale(requestOwnerKey) &&
            recipientRequestRef.current === requestId
          ) {
            setRecipientsError(true);
          }
        } finally {
          if (
            !scope.isStale(requestOwnerKey) &&
            recipientRequestRef.current === requestId
          ) {
            setRecipientsLoading(false);
          }
        }
      })();
    },
    [scope],
  );

  // Resolve the durable local telemetry anchor in main, then use the bounded
  // owner-side server listing.
  //
  // `match.revision` is kept alongside `match.id` on purpose: the server is
  // authoritative about whether this container was ever published, while the
  // local publication record is only ever a same-machine cache. Throwing the
  // revision away here is what made an already-published share read as
  // "Not yet published" from a second build.
  useEffect(() => {
    if (!ownerKey) return;
    const requestId = ++containerRequestRef.current;
    const requestOwnerKey = ownerKey;
    const requestOrgId = organizationIdForOwnerKey(ownerKey);
    setRecipientsLoading(true);
    setRecipientsError(false);
    void (async (): Promise<void> => {
      try {
        const result = await window.api.sharedContainers.listSharedByMe({
          ...(requestOrgId ? { organizationId: requestOrgId } : {}),
          projectId,
          worktreeId,
        });
        const match = result.containers[0];
        if (match) {
          if (
            scope.isStale(requestOwnerKey) ||
            containerRequestRef.current !== requestId
          ) {
            return;
          }
          setContainerId(match.id);
          setServerRevision(match.revision);
          setContainerResolved(true);
          loadRecipients(match.id, requestOwnerKey);
          return;
        }
        if (
          !scope.isStale(requestOwnerKey) &&
          containerRequestRef.current === requestId
        ) {
          // A definite "no container here" retires the cached account-level
          // hint, so a stale badge entry can never assert a publish state for
          // a container the server says does not exist.
          setContainerResolved(true);
          setRecipientsLoading(false);
          setRecipientsError(false);
          // Retire it in the store too, not just locally. The container may
          // have been revoked from another device or from the web, and the
          // renderer only re-fans the account-level owner listing at init and
          // on account change - so without this the sidebar's "shared with
          // teammates" badge keeps asserting a share the server has already
          // dropped until the app restarts. Reached only from the *successful*
          // lookup's zero-container branch: the `catch` below deliberately
          // leaves the cache alone, because a failed lookup is not evidence
          // the share is gone and clearing a badge on a network blip would be
          // the worse bug.
          useSharedContainersStore
            .getState()
            .removeSharedTarget(projectId, worktreeId, requestOrgId);
        }
      } catch {
        if (
          !scope.isStale(requestOwnerKey) &&
          containerRequestRef.current === requestId
        ) {
          setRecipientsLoading(false);
          setRecipientsError(true);
        }
      }
    })();
  }, [ownerKey, projectId, worktreeId, loadRecipients, scope]);

  const existingRecipientIds = useMemo(
    () =>
      new Set(
        recipients.flatMap((grant) =>
          grant.recipient.kind === 'member' ? [grant.recipient.userId] : [],
        ),
      ),
    [recipients],
  );
  const existingRecipientEmails = useMemo(
    () =>
      new Set(
        recipients.flatMap((grant) =>
          grant.recipient.kind === 'email'
            ? [grant.recipient.email.trim().toLowerCase()]
            : [],
        ),
      ),
    [recipients],
  );

  useEffect(
    () =>
      subscribeToSharedContainerRevocationConfirmationRequests((request) => {
        if (
          request.containerId !== containerId ||
          request.organizationId !== organizationIdForOwnerKey(ownerKey)
        ) {
          return false;
        }
        // A member row matches by user id; an email row has no exposed user
        // id, so it matches by grant id.
        const grant = recipients.find(
          (candidate) =>
            candidate.id === request.recipientId ||
            (candidate.recipient.kind === 'member' &&
              candidate.recipient.userId === request.recipientId),
        );
        if (!grant) return false;
        setPendingRevokeGrant(grant);
        onRevocationRequested();
        return true;
      }),
    [containerId, ownerKey, recipients, onRevocationRequested],
  );

  const requestRevoke = useCallback(
    (grant: SharedContainerGrantSummary): void => {
      if (!containerId) return;
      setPendingRevokeGrant(grant);
      onInlineError(null);
    },
    [containerId, onInlineError],
  );

  const cancelRevoke = useCallback((): void => {
    setPendingRevokeGrant(null);
  }, []);

  const confirmRevoke = useCallback((): void => {
    if (!containerId || !pendingRevokeGrant) return;
    const grant = pendingRevokeGrant;
    const mutationId = ++mutationRequestRef.current;
    const requestOwnerKey = ownerKey;
    const requestOrgId = organizationIdForOwnerKey(ownerKey);
    setPendingRevokeGrant(null);
    setRevokingId(grant.id);
    onInlineError(null);
    void (async (): Promise<void> => {
      try {
        // Always by grant id: an email recipient (pending invite or direct
        // grant) exposes no user id.
        await window.api.sharedContainers.revokeRecipient({
          containerId,
          grantId: grant.id,
          ...(requestOrgId ? { organizationId: requestOrgId } : {}),
        });
        if (
          scope.isStale(requestOwnerKey) ||
          mutationRequestRef.current !== mutationId
        ) {
          return;
        }
        recipientRequestRef.current += 1;
        const nextRecipients = recipientsRef.current.filter(
          (entry) => entry.id !== grant.id,
        );
        setRecipients(nextRecipients);
        setRecipientsLoading(false);
        if (nextRecipients.length === 0) {
          // The last grant is gone, so the server has already dropped this
          // container from the owner listing (`listSharedByMe` filters on
          // `grants: { some: {} }`). The renderer only re-fans that listing at
          // init and on account change, so without this the sidebar's "shared
          // with teammates" badge would survive a full revoke until restart.
          // A one-shot `getState()` read on purpose: this hook has no reason
          // to re-render when the owner cache changes.
          useSharedContainersStore
            .getState()
            .removeSharedTarget(projectId, worktreeId, requestOrgId);
        }
      } catch {
        if (
          scope.isStale(requestOwnerKey) ||
          mutationRequestRef.current !== mutationId
        ) {
          return;
        }
        onInlineError(REVOKE_ERROR_LABEL);
      } finally {
        if (
          !scope.isStale(requestOwnerKey) &&
          mutationRequestRef.current === mutationId
        ) {
          setRevokingId(null);
        }
      }
    })();
  }, [
    containerId,
    ownerKey,
    projectId,
    worktreeId,
    pendingRevokeGrant,
    scope,
    onInlineError,
  ]);

  const applyInvitedGrant = useCallback(
    (nextContainerId: string, grant: SharedContainerGrantSummary): void => {
      // A discovery request that started before the mutation cannot be
      // allowed to overwrite the server's newer grant state.
      containerRequestRef.current += 1;
      recipientRequestRef.current += 1;
      setContainerId(nextContainerId);
      // The invite just completed in this dialog, so put it where the owner
      // can see the result immediately instead of appending it below an
      // arbitrarily long existing list.
      setRecipients((current) => [
        grant,
        ...current.filter((entry) => entry.id !== grant.id),
      ]);
      setRecipientsLoading(false);
      setRecipientsError(false);
    },
    [],
  );

  const applyCreatedContainer = useCallback(
    (nextContainerId: string, revision: number): void => {
      containerRequestRef.current += 1;
      recipientRequestRef.current += 1;
      setContainerId(nextContainerId);
      setServerRevision(revision);
      setContainerResolved(true);
      setRecipientsLoading(false);
      setRecipientsError(false);
    },
    [],
  );

  const beginMutation = useCallback(
    (): number => ++mutationRequestRef.current,
    [],
  );
  const isCurrentMutation = useCallback(
    (mutationId: number): boolean => mutationRequestRef.current === mutationId,
    [],
  );

  return {
    // The modal's own lookup wins once it has answered. Before that (and when
    // it failed) the account-level owner listing stands in, so an already
    // published share never reads as unknown just because this one request is
    // still in flight or the machine is offline.
    containerId: containerId ?? fallbackTarget?.containerId ?? null,
    serverRevision: serverRevision ?? fallbackTarget?.revision ?? null,
    recipients,
    recipientsLoading,
    recipientsError,
    existingRecipientIds,
    existingRecipientEmails,
    revokingId,
    pendingRevokeGrant,
    isMutating: revokingId !== null || pendingRevokeGrant !== null,
    requestRevoke,
    cancelRevoke,
    confirmRevoke,
    applyInvitedGrant,
    applyCreatedContainer,
    beginMutation,
    isCurrentMutation,
  };
}
