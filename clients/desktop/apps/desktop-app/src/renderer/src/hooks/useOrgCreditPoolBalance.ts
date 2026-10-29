import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { CreditsBillingTarget } from '@canopy/protocol/billing';

export interface OrgCreditPoolBalance {
  /**
   * The pool's balance, or `null` while loading, after a failed read, for a
   * personal target, and while signed out.
   */
  readonly balanceCredits: number | null;
  /**
   * Asks for a fresh read of the current target. Stable for the hook's
   * lifetime, so a row that refreshes on mount never loops.
   */
  readonly refresh: () => void;
}

interface PoolTarget {
  readonly key: string;
  readonly organizationId: string;
}

/**
 * The credit pool balance of the organization an AI Credits target names
 * (CAN-3926), read for the signed-in account `accountKey`.
 *
 * Read through the navigation-scoped native availability IPC, which probes the
 * selected organization's pool. A result is kept only while it still belongs to
 * the current account and target, so a slow read never shows one
 * organization's pool beside another's page; a known balance stays visible
 * while the same target refreshes. Re-read when the window regains focus, since
 * a top-up happens in the browser. Every read (initial, focus, `refresh`)
 * shares one ordering fence: only the latest issued read lands.
 */
export function useOrgCreditPoolBalance(
  target: CreditsBillingTarget,
  accountKey: string | null,
): OrgCreditPoolBalance {
  const organizationId =
    target.kind === 'organization' && accountKey !== null
      ? target.organizationId
      : null;
  const key =
    organizationId === null
      ? null
      : `${accountKey ?? ''}\u0000${organizationId.toLowerCase()}`;
  const [state, setState] = useState<{
    readonly key: string;
    readonly balance: number;
  } | null>(null);
  const targetRef = useRef<PoolTarget | null>(null);
  const requestRef = useRef(0);

  const refresh = useCallback((): void => {
    const current = targetRef.current;
    if (current === null) return;
    const load = window.api?.loadNativeAiCreditsAvailability;
    if (typeof load !== 'function') return;
    const request = ++requestRef.current;
    const stale = (): boolean =>
      request !== requestRef.current || targetRef.current?.key !== current.key;
    void load()
      .then((availability) => {
        if (stale()) return;
        const balance = availability.ownerOrganizationBalanceCredits;
        if (
          availability.ownerOrganization?.id.toLowerCase() ===
            current.organizationId.toLowerCase() &&
          typeof balance === 'number' &&
          Number.isFinite(balance)
        ) {
          setState({ key: current.key, balance });
        } else {
          // Another organization's pool, or no number: unknown, not stale.
          setState(null);
        }
      })
      .catch(() => {
        if (stale()) return;
        // Unknown stays unknown: the row shows no number.
        setState(null);
      });
  }, []);

  // Before any passive effect (a row's mount refresh included) sees the new
  // target, point reads at it and fence off the previous target's reads.
  useLayoutEffect(() => {
    targetRef.current =
      key === null || organizationId === null ? null : { key, organizationId };
    requestRef.current += 1;
    // A balance read for another account or organization is dropped, so
    // switching back never flashes a number from before the switch.
    setState((previous) =>
      previous !== null && previous.key !== key ? null : previous,
    );
    return (): void => {
      targetRef.current = null;
      requestRef.current += 1;
    };
  }, [key, organizationId]);

  useEffect(() => {
    if (key === null) return;
    refresh();
    window.addEventListener('focus', refresh);
    return (): void => {
      window.removeEventListener('focus', refresh);
    };
  }, [key, refresh]);

  return {
    balanceCredits: state !== null && state.key === key ? state.balance : null,
    refresh,
  };
}
