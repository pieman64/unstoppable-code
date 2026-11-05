import type { LedgerContainer } from '@canopy/protocol/canopy-core';

/*
 * The port through which managed delegation offers its retained delegates to
 * the Ledger as owner candidates. Managed delegation registers its source
 * when it first loads, so the Ledger never loads delegation, and this module
 * imports nothing that could: the delegation bundle depends on it without
 * pulling in the Ledger's own module graph.
 */

/**
 * A retained managed delegate that can still accept a continuation under the
 * current delegation policy, as the delegation host reports it. Its root chat
 * must also be live for it to be selectable.
 */
export interface LedgerLiveDelegate {
  /** The durable delegation ID: the delegate's actor in every ledger. */
  readonly delegationId: string;
  /** The delegate's task description, its display name. */
  readonly description: string;
  /** Its current run generation; eligibility tokens bind it. */
  readonly runGeneration: number;
  /** The chat the delegation belongs to. */
  readonly rootChatId: string;
  /** Orders owner candidates; null when unknown. */
  readonly createdAt: string | null;
}

/** Lists a container's retained delegates that can accept a continuation. */
export type LedgerDelegateLivenessSource = (
  container: LedgerContainer,
) => Promise<readonly LedgerLiveDelegate[]>;

let registeredSource: LedgerDelegateLivenessSource | undefined;

/** Registers the delegation host's source; undefined removes it. */
export function registerLedgerDelegateSource(
  source: LedgerDelegateLivenessSource | undefined,
): void {
  registeredSource = source;
}

/**
 * The container's retained delegates from the registered delegation host;
 * none until one registered, and none when it fails.
 */
export async function readLedgerContainerLiveDelegates(
  container: LedgerContainer,
): Promise<readonly LedgerLiveDelegate[]> {
  const source = registeredSource;
  // A global (workflow) Ledger has no chats, so no delegates of them.
  if (source === undefined || container.kind === 'global') return [];
  try {
    return await source(container);
  } catch {
    return [];
  }
}

/** Whose delegates a lineage read asks for: a root chat or a delegation. */
export type LedgerDelegateLineageOwner =
  | { readonly kind: 'chat'; readonly chatId: string }
  | { readonly kind: 'managed_delegation'; readonly delegationId: string };

/**
 * Lists the durable IDs of every retained delegation under an owner in a
 * container, at any depth: a chat's whole tree, or a delegation's own
 * delegates and theirs. Settled and stopped delegations count; their entries
 * stay theirs until handed back.
 */
export type LedgerDelegateLineageSource = (
  container: LedgerContainer,
  owner: LedgerDelegateLineageOwner,
) => Promise<readonly string[]>;

let registeredLineageSource: LedgerDelegateLineageSource | undefined;

/** Registers the delegation host's lineage source; undefined removes it. */
export function registerLedgerDelegateLineageSource(
  source: LedgerDelegateLineageSource | undefined,
): void {
  registeredLineageSource = source;
}

/**
 * The owner's delegations at any depth, or null when no source is registered
 * or it fails: then a caller may change only its own entries.
 */
export async function readLedgerDelegateLineage(
  container: LedgerContainer,
  owner: LedgerDelegateLineageOwner,
): Promise<readonly string[] | null> {
  const source = registeredLineageSource;
  if (source === undefined) return null;
  try {
    return await source(container, owner);
  } catch {
    return null;
  }
}

/**
 * Lists an owner's own new delegations: durable (admitted, possibly queued or
 * still preparing) but not yet able to accept a continuation, so the retained
 * delegate source leaves them out. The Ledger accepts these as owner
 * candidates only for that owner, so a parent can hand its new delegate its
 * tasks before the delegate starts, without widening eligibility for anyone
 * else.
 */
export type LedgerNewDelegateSource = (
  container: LedgerContainer,
  owner: LedgerDelegateLineageOwner,
) => Promise<readonly LedgerLiveDelegate[]>;

let registeredNewDelegateSource: LedgerNewDelegateSource | undefined;

/** Registers the delegation host's new-delegate source; undefined removes it. */
export function registerLedgerNewDelegateSource(
  source: LedgerNewDelegateSource | undefined,
): void {
  registeredNewDelegateSource = source;
}

/** The owner's new delegations; none when no source or it fails. */
export async function readLedgerNewDelegates(
  container: LedgerContainer,
  owner: LedgerDelegateLineageOwner,
): Promise<readonly LedgerLiveDelegate[]> {
  const source = registeredNewDelegateSource;
  if (source === undefined) return [];
  try {
    return await source(container, owner);
  } catch {
    return [];
  }
}
