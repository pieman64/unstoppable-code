import type { TelemetrySharingVisibility } from '@canopy/desktop-shared/types';
import {
  LedgerUuidSchema,
  type LedgerContainer,
} from '@canopy/protocol/canopy-core';
import type {
  LedgerRequestedAudience,
  LedgerScopeAudience,
} from '@canopy/protocol/ledger-sync';

/*
 * Whether a scope may sync, and who may read its mirror (LD01, LD02). Pure:
 * every input is a fact the caller read. The rules, in order:
 *
 * - A scope first used signed out stays on this device, whoever signs in.
 * - A scope syncs only to the account it was bound to. While that account is
 *   not the one signed in, it waits.
 * - An organization's `summaries` prohibition blocks every upload.
 * - Summary sharing turned off keeps the scope on this device.
 * - Otherwise it syncs. An organization can read it only when the workspace
 *   is one of that organization's projects, sharing resolves to the
 *   organization, the person still belongs to it and its teams capability has
 *   not lapsed. Personal and Advisor scopes are always private.
 * - A global (workflow) Ledger's owner is its container's, never a workspace
 *   read: a Personal one is private, an organization's follows the same
 *   sharing choice and membership facts.
 */

/** What policy reads of a scope: the account it is bound to and where it lives. */
export interface LedgerSyncScope {
  /** Account registered at first use; null when first used signed out. */
  readonly accountId: string | null;
  readonly container: LedgerContainer;
}

/** What owns the workspace a scope's container lives in. */
export type LedgerWorkspaceOwner =
  | { readonly kind: 'personal' }
  | {
      readonly kind: 'organization';
      readonly organizationId: string;
      /** The tracked workspace: the organization's project. */
      readonly projectId: string;
    }
  /** The owner could not be read: nothing is assumed about it. */
  | { readonly kind: 'unknown' };

/** The signed-in account and what it may share right now. */
export interface LedgerSyncAccount {
  /** The account's server ID. */
  readonly id: string;
  /** Organizations the person belongs to. */
  readonly organizationIds: ReadonlySet<string>;
  /** Organizations whose teams capability lapsed. */
  readonly lapsedOrganizationIds: ReadonlySet<string>;
  /** The person's stored `summaries` sharing. */
  readonly summaries: TelemetrySharingVisibility;
  /**
   * An organization the person belongs to prohibits sharing summaries, or the
   * organizations' policy could not be read.
   */
  readonly summariesProhibited: boolean;
}

/** Why a scope does not sync, as its entries are labeled. */
export type LedgerSyncHold = 'local_only' | 'policy_restricted';

export type LedgerSyncDisposition =
  | { readonly kind: 'sync'; readonly audience: LedgerRequestedAudience }
  | {
      readonly kind: 'hold';
      readonly hold: LedgerSyncHold;
      /**
       * The scope's own account is signed in, so the mirror can still be told
       * that no organization may read it any more.
       */
      readonly canNarrow: boolean;
    };

const PRIVATE_AUDIENCE: LedgerRequestedAudience = { kind: 'private' };

/** The mirror names accounts and projects by UUID. */
function isUuid(value: string): boolean {
  return LedgerUuidSchema.safeParse(value).success;
}

function hold(hold: LedgerSyncHold, canNarrow: boolean): LedgerSyncDisposition {
  return { kind: 'hold', hold, canNarrow };
}

/** The label an unsent revision takes while its scope's account may sync. */
export function ledgerAccountHold(
  account: LedgerSyncAccount,
): LedgerSyncHold | null {
  if (account.summariesProhibited) return 'policy_restricted';
  return account.summaries === 'off' ? 'local_only' : null;
}

/** Everything about an account that decides what may sync, and where. */
export function ledgerSyncPolicyKey(account: LedgerSyncAccount | null): string {
  if (account === null) return 'signed_out';
  return JSON.stringify([
    account.id,
    Array.from(account.organizationIds).sort(),
    Array.from(account.lapsedOrganizationIds).sort(),
    account.summaries,
    account.summariesProhibited,
  ]);
}

/**
 * Whether a scope is the signed-in account's to sync. The mirror names
 * accounts by UUID; a scope bound to anything else never left this device.
 */
export function isLedgerScopeOfAccount(
  scopeAccountId: string | null,
  account: LedgerSyncAccount | null,
): account is LedgerSyncAccount {
  return (
    scopeAccountId !== null &&
    account !== null &&
    scopeAccountId === account.id &&
    isUuid(scopeAccountId)
  );
}

/**
 * A global (workflow) Ledger's audience, from the owner its container pins:
 * a Personal one is always private, and an organization's current members
 * may read an organization's when sharing resolves to the organization, the
 * person still belongs to it and its teams capability has not lapsed. The
 * mirror checks all of it again before it grants anything.
 */
function globalAudience(
  scope: LedgerSyncScope,
  account: LedgerSyncAccount,
): LedgerRequestedAudience {
  const { container } = scope;
  if (
    container.kind !== 'global' ||
    container.owner.kind !== 'organization' ||
    account.summaries !== 'organization'
  ) {
    return PRIVATE_AUDIENCE;
  }
  const { organizationId } = container.owner;
  if (
    !account.organizationIds.has(organizationId) ||
    account.lapsedOrganizationIds.has(organizationId)
  ) {
    return PRIVATE_AUDIENCE;
  }
  return { kind: 'organization_global', organizationId };
}

function organizationAudience(
  scope: LedgerSyncScope,
  account: LedgerSyncAccount,
  owner: LedgerWorkspaceOwner,
): LedgerRequestedAudience {
  if (scope.container.kind === 'global') return globalAudience(scope, account);
  if (
    scope.container.kind === 'advisor_entry' ||
    owner.kind !== 'organization' ||
    account.summaries !== 'organization' ||
    !account.organizationIds.has(owner.organizationId) ||
    account.lapsedOrganizationIds.has(owner.organizationId) ||
    !isUuid(owner.projectId)
  ) {
    return PRIVATE_AUDIENCE;
  }
  return { kind: 'organization', trackedWorkspaceId: owner.projectId };
}

export function resolveLedgerSyncDisposition(
  scope: LedgerSyncScope,
  account: LedgerSyncAccount | null,
  owner: LedgerWorkspaceOwner,
): LedgerSyncDisposition {
  if (!isLedgerScopeOfAccount(scope.accountId, account)) {
    return hold('local_only', false);
  }
  const held = ledgerAccountHold(account);
  if (held !== null) return hold(held, true);
  return {
    kind: 'sync',
    audience: organizationAudience(scope, account, owner),
  };
}

/** The audience the mirror should hold for a scope: private while it waits. */
export function desiredLedgerAudience(
  disposition: LedgerSyncDisposition,
): LedgerRequestedAudience {
  return disposition.kind === 'sync' ? disposition.audience : PRIVATE_AUDIENCE;
}

/**
 * Whether the mirror already holds the audience asked for. A lease's expiry
 * and its organization are the mirror's to say; the project names both.
 */
export function isLedgerAudienceApplied(
  requested: LedgerRequestedAudience,
  applied: LedgerScopeAudience | null,
): boolean {
  if (applied === null) return false;
  switch (requested.kind) {
    case 'private':
      return applied.kind === 'private';
    case 'organization':
      return (
        applied.kind === 'organization' &&
        applied.trackedWorkspaceId === requested.trackedWorkspaceId
      );
    case 'organization_global':
      return (
        applied.kind === 'organization_global' &&
        applied.organizationId === requested.organizationId
      );
  }
}
