'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AccountOrganizationSettingsClient } from '@canopy/app-core/settings';
import type { IncomingTeamInvitation } from '@canopy/protocol/settings/organization';
import type { WorkspaceContextOrganization } from '@canopy/protocol/workspace-context';
import { listIncomingInvitations } from '../../settings/organization/team-api';
import {
  settingsActionErrorCopy,
  settingsErrorFacts,
  SETTINGS_UNCERTAIN_ERROR_COPY,
} from '../../settings/errors/settings-error-copy';

/** Copy for an invitation the server no longer offers (404). */
export const INVITATION_UNAVAILABLE_COPY =
  'This invitation is no longer available.';

/** Follow-up copy when a host's follow-up rejects instead of resolving. */
export const ACCEPTED_FOLLOW_UP_FALLBACK_COPY =
  "You joined the organization, but it couldn't open. Open Organizations to continue.";

/** How a switcher invitation response ended. */
export type PendingInvitationResponse =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'declined' }
  /** The server no longer offers it: removed, never treated as accepted. */
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'failed'; readonly message: string }
  /** Another response was in flight, or the account changed meanwhile. */
  | { readonly kind: 'cancelled' };

export interface PendingInvitationError {
  readonly message: string;
  /**
   * `follow-up`: the invitation was accepted but its organization could not
   * open; the surface offers Settings > Organizations instead of a retry.
   */
  readonly kind: 'action' | 'follow-up';
}

/**
 * The switcher's pending organization invitations (CAN-3672): what
 * {@link SidebarContextRow} renders and the actions it calls.
 */
export interface SidebarContextInvitations {
  /** In server order; empty when there are none or none are readable. */
  readonly items: readonly IncomingTeamInvitation[];
  /** Opaque account/client generation for pending dialogs. */
  readonly scope?: object | null;
  /** The response in flight, through the accept follow-up. */
  readonly pending: {
    readonly inviteId: string;
    readonly action: 'accept' | 'decline';
  } | null;
  readonly error: PendingInvitationError | null;
  /** Re-reads the list; the row calls it each time the menu opens. */
  readonly refresh: () => void;
  readonly accept: (
    invite: IncomingTeamInvitation,
    onAcknowledged?: () => void,
  ) => Promise<PendingInvitationResponse>;
  readonly decline: (
    invite: IncomingTeamInvitation,
  ) => Promise<PendingInvitationResponse>;
  /** Opens the consent flow for an invitation with enforced settings. */
  readonly review: () => void;
  readonly dismissError: () => void;
  /** A newer explicit context choice cancels destination work, never the write. */
  readonly cancelFollowUp?: () => void;
}

export interface AcceptedInvitationFollowUp {
  readonly invitation: IncomingTeamInvitation;
  /** Memberships just before the accept write, for older payloads. */
  readonly before: readonly WorkspaceContextOrganization[];
  /** Aborted when the account or client changes, or the host unmounts. */
  readonly signal: AbortSignal;
}

export interface PendingOrganizationInvitationsOptions {
  /** The host's settings client; `null` reads and shows nothing. */
  readonly client: AccountOrganizationSettingsClient | null;
  /** The signed-in, non-guest account; `null` reads and shows nothing. */
  readonly accountKey: string | null;
  /** An authenticated first list for this account; only used on mount. */
  readonly initialSnapshot?: {
    readonly accountKey: string;
    readonly items: readonly IncomingTeamInvitation[];
  };
  /**
   * Changes once per completed host account refresh, including one that
   * left memberships unchanged. Not read on mount.
   */
  readonly refreshSignal: unknown;
  /** The memberships right now, snapshotted before an accept write. */
  readonly readMemberships: () => readonly WorkspaceContextOrganization[];
  /**
   * Selects the joined organization and opens its Projects. Resolves `null`
   * on success, or copy saying the invitation was accepted but the
   * organization could not open.
   */
  readonly onAccepted: (
    followUp: AcceptedInvitationFollowUp,
  ) => Promise<string | null>;
  readonly onReview: () => void;
  /** Refresh account membership after an unavailable or uncertain response. */
  readonly reconcileAccount?: () => Promise<void>;
}

interface Scope {
  readonly client: AccountOrganizationSettingsClient;
  readonly accountKey: string;
  readonly abort: AbortController;
  /** Invitations this scope answered; a late read never brings them back. */
  readonly consumed: Set<string>;
  readSequence: number;
  /** Reads started at or before this sequence are discarded. */
  staleThrough: number;
  reading: Promise<void> | null;
  followUp: AbortController | null;
  trailing: boolean;
  /** Synchronous guard: one response (and its follow-up) at a time. */
  responding: boolean;
}

interface ScopedState<T> {
  readonly scope: Scope | null;
  readonly value: T;
}

const EMPTY: readonly IncomingTeamInvitation[] = [];

function createScope(
  client: AccountOrganizationSettingsClient,
  accountKey: string,
): Scope {
  return {
    client,
    accountKey,
    abort: new AbortController(),
    consumed: new Set(),
    readSequence: 0,
    staleThrough: 0,
    reading: null,
    followUp: null,
    trailing: false,
    responding: false,
  };
}

/**
 * Reads and answers the signed-in account's pending organization invitations
 * for the context switcher (CAN-3672), on desktop and web alike. Reads on
 * activation, on each host account refresh, and on each menu open; never
 * polls. Everything is keyed to the account and client: a change hides the
 * list at once and drops late results, including follow-ups. Within one
 * account only the newest read applies, and a read that started before a
 * response never restores the invitation it answered.
 */
export function usePendingOrganizationInvitations({
  client,
  accountKey,
  initialSnapshot,
  refreshSignal,
  readMemberships,
  onAccepted,
  onReview,
  reconcileAccount,
}: PendingOrganizationInvitationsOptions): SidebarContextInvitations {
  // A server-provided list must be visible on the first paint. Bind it to the
  // same account/client scope as later reads, so an account swap hides it.
  const [initialState] = useState(() => {
    const scope =
      client !== null &&
      accountKey !== null &&
      initialSnapshot?.accountKey === accountKey
        ? createScope(client, accountKey)
        : null;
    return { scope, items: scope ? (initialSnapshot?.items ?? EMPTY) : EMPTY };
  });
  const initialActivation = useRef(true);
  const scopeRef = useRef<Scope | null>(initialState.scope);
  const callbacks = useRef({
    readMemberships,
    onAccepted,
    onReview,
    reconcileAccount,
  });
  useEffect(() => {
    callbacks.current = {
      readMemberships,
      onAccepted,
      onReview,
      reconcileAccount,
    };
  });

  const [list, setList] = useState<
    ScopedState<readonly IncomingTeamInvitation[]>
  >({
    scope: initialState.scope,
    value: initialState.items,
  });
  const [pending, setPending] = useState<
    ScopedState<SidebarContextInvitations['pending']>
  >({ scope: null, value: null });
  const [error, setError] = useState<
    ScopedState<PendingInvitationError | null>
  >({ scope: null, value: null });

  const read = useCallback((target: Scope): Promise<void> => {
    if (target.reading !== null) {
      target.trailing = true;
      return target.reading;
    }
    const run = async (): Promise<void> => {
      do {
        target.trailing = false;
        const sequence = ++target.readSequence;
        try {
          const invitations = await listIncomingInvitations(target.client);
          if (scopeRef.current === target && sequence > target.staleThrough) {
            setList({
              scope: target,
              value: invitations.filter(
                (invite) => !target.consumed.has(invite.id),
              ),
            });
          }
        } catch {
          // Keep the last successful list and any useful action feedback.
        }
      } while (target.trailing && scopeRef.current === target);
    };
    target.reading = run().finally((): void => {
      target.reading = null;
    });
    return target.reading;
  }, []);

  useEffect(() => {
    if (client === null || accountKey === null) {
      scopeRef.current = null;
      return undefined;
    }
    const seeded = initialActivation.current ? initialState.scope : null;
    initialActivation.current = false;
    const scope =
      seeded?.client === client && seeded.accountKey === accountKey
        ? seeded
        : createScope(client, accountKey);
    scopeRef.current = scope;
    if (scope !== seeded) void read(scope);
    return (): void => {
      scope.abort.abort();
      scope.followUp?.abort();
      if (scopeRef.current === scope) scopeRef.current = null;
    };
  }, [accountKey, client, initialState.scope, read]);

  // A host refresh after mount; the activation read covers the first value.
  const lastSignal = useRef(refreshSignal);
  useEffect(() => {
    if (Object.is(lastSignal.current, refreshSignal)) return;
    lastSignal.current = refreshSignal;
    const current = scopeRef.current;
    if (current !== null) void read(current);
  }, [read, refreshSignal]);

  const refresh = useCallback((): void => {
    const current = scopeRef.current;
    if (current !== null) void read(current);
  }, [read]);

  /** Drops an answered invitation now and outdates reads already running. */
  const consume = useCallback(
    (target: Scope, inviteId: string): void => {
      target.consumed.add(inviteId);
      target.staleThrough = target.readSequence;
      setList((current) =>
        current.scope === target
          ? {
              scope: target,
              value: current.value.filter((invite) => invite.id !== inviteId),
            }
          : current,
      );
      void read(target);
    },
    [read],
  );

  const respond = useCallback(
    async (
      invite: IncomingTeamInvitation,
      action: 'accept' | 'decline',
      onAcknowledged?: () => void,
    ): Promise<PendingInvitationResponse> => {
      const target = scopeRef.current;
      if (target === null || target.responding) return { kind: 'cancelled' };
      target.responding = true;
      const followUp = action === 'accept' ? new AbortController() : null;
      target.followUp = followUp;
      const live = (): boolean =>
        scopeRef.current === target && !target.abort.signal.aborted;
      const before =
        action === 'accept' ? callbacks.current.readMemberships() : [];
      setPending({ scope: target, value: { inviteId: invite.id, action } });
      setError({ scope: target, value: null });
      try {
        try {
          // Preserve the client's `uncertain` write code, including on a 5xx.
          // The Settings panel's TeamApiError adapter keeps only HTTP facts.
          await target.client.write('organization.invitations.respond', {
            inviteId: invite.id,
            action,
          });
        } catch (err: unknown) {
          if (!live()) return { kind: 'cancelled' };
          const facts = settingsErrorFacts(err);
          if (facts.status === 404) {
            consume(target, invite.id);
            setError({
              scope: target,
              value: { kind: 'action', message: INVITATION_UNAVAILABLE_COPY },
            });
            await callbacks.current.reconcileAccount?.().catch(() => undefined);
            return live() ? { kind: 'unavailable' } : { kind: 'cancelled' };
          }
          const message = settingsActionErrorCopy(err, {
            known: [{ code: 'uncertain', copy: SETTINGS_UNCERTAIN_ERROR_COPY }],
            action:
              action === 'accept'
                ? 'accept the invitation'
                : 'decline the invitation',
          });
          setError({ scope: target, value: { kind: 'action', message } });
          // Re-read before anyone retries: an unanswered write may have
          // landed, and the server decides expiry and revocation.
          await read(target);
          if (!live()) return { kind: 'cancelled' };
          await callbacks.current.reconcileAccount?.().catch(() => undefined);
          return live() ? { kind: 'failed', message } : { kind: 'cancelled' };
        }
        if (!live()) return { kind: 'cancelled' };
        consume(target, invite.id);
        if (action === 'decline') return { kind: 'declined' };
        // The accept stands even when its follow-up fails: it is reported,
        // never retried as a second write.
        if (followUp === null || followUp.signal.aborted)
          return { kind: 'cancelled' };
        onAcknowledged?.();
        let timedOut = false;
        let release: (message: string | null) => void = () => {};
        const cancelled = new Promise<string | null>((resolve) => {
          release = resolve;
        });
        const abort = (): void =>
          release(timedOut ? ACCEPTED_FOLLOW_UP_FALLBACK_COPY : null);
        followUp.signal.addEventListener('abort', abort);
        const timeout = setTimeout((): void => {
          timedOut = true;
          followUp.abort();
        }, 15_000);
        const followUpError = await Promise.race([
          callbacks.current
            .onAccepted({ invitation: invite, before, signal: followUp.signal })
            .catch((): string => ACCEPTED_FOLLOW_UP_FALLBACK_COPY),
          cancelled,
        ]);
        clearTimeout(timeout);
        followUp.signal.removeEventListener('abort', abort);
        if (target.followUp === followUp) target.followUp = null;

        if (live() && followUpError !== null) {
          setError({
            scope: target,
            value: { kind: 'follow-up', message: followUpError },
          });
        }
        return live() && (!followUp.signal.aborted || timedOut)
          ? { kind: 'accepted' }
          : { kind: 'cancelled' };
      } finally {
        if (target.followUp === followUp) target.followUp = null;
        target.responding = false;
        setPending((current) =>
          current.scope === target ? { scope: target, value: null } : current,
        );
      }
    },
    [consume, read],
  );

  const cancelFollowUp = useCallback((): void => {
    scopeRef.current?.followUp?.abort();
  }, []);

  const accept = useCallback(
    (invite: IncomingTeamInvitation, onAcknowledged?: () => void) =>
      respond(invite, 'accept', onAcknowledged),
    [respond],
  );
  const decline = useCallback(
    (invite: IncomingTeamInvitation) => respond(invite, 'decline'),
    [respond],
  );
  const review = useCallback((): void => callbacks.current.onReview(), []);
  const dismissError = useCallback((): void => {
    setError((current) =>
      current.value === null ? current : { scope: current.scope, value: null },
    );
  }, []);

  // Keyed by account and client, so a change hides the old values at once.
  const current = (state: ScopedState<unknown>): boolean =>
    state.scope !== null &&
    state.scope === scopeRef.current &&
    state.scope.client === client &&
    state.scope.accountKey === accountKey;
  const items = current(list) ? list.value : EMPTY;
  const pendingValue = current(pending) ? pending.value : null;
  const errorValue = current(error) ? error.value : null;
  return useMemo(
    () => ({
      items,
      scope: scopeRef.current,
      pending: pendingValue,
      error: errorValue,
      refresh,
      accept,
      decline,
      review,
      dismissError,
      cancelFollowUp,
    }),
    [
      items,
      pendingValue,
      errorValue,
      refresh,
      accept,
      decline,
      review,
      dismissError,
      cancelFollowUp,
    ],
  );
}
