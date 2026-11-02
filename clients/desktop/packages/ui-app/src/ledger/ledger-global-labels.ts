import type { LedgerGlobalOwner } from '@canopy/protocol/canopy-core';

/** A global (workflow) row's work, when nothing names its owner. */
export const LEDGER_GLOBAL_CONTEXT_LABEL = 'Workflows';

/**
 * How a global (workflow) row reads: `Workflows · Personal`, `Workflows ·
 * {organization}`, or `Workflows` when the reader has no name for the
 * organization. Hosts pass a name only from the account's own organizations
 * or the mirror, never from the selected context.
 */
export function ledgerGlobalContextLabel(
  owner: LedgerGlobalOwner,
  organizationName: string | undefined,
): string {
  if (owner.kind === 'personal') {
    return `${LEDGER_GLOBAL_CONTEXT_LABEL} · Personal`;
  }
  const name = organizationName?.trim();
  return name === undefined || name.length === 0
    ? LEDGER_GLOBAL_CONTEXT_LABEL
    : `${LEDGER_GLOBAL_CONTEXT_LABEL} · ${name}`;
}
