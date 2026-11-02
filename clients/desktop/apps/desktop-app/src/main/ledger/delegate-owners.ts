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
