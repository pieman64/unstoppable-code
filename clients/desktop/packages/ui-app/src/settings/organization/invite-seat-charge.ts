'use client';

import { useCallback, useEffect, useState } from 'react';
import type { AccountOrganizationSettingsClient } from '@canopy/app-core/settings';
import {
  useOptionalSettingsStore,
  useOptionalSettingsStoreApi,
} from '@canopy/app-state/settings';
import type { BillingSummary } from '@canopy/protocol/settings';
import { useSettingsClient } from '../host';
import { useOrganizationSettingsSlots } from './organization-settings-slots';
import { getOrgBillingSummary, TeamApiError } from './team-api';

/**
 * How the Members invite runs on this host:
 * - `inline`: the invite dialog opens here. With a seat-charge slot the
 *   dialog quotes and confirms any charge; without one no charge can apply.
 * - `handoff`: inviting may add a paid seat and this host cannot confirm the
 *   charge, so the invite continues on the web.
 * - `checking`: the organization's billing is still being read.
 */
export type InviteSeatChargeMode = 'checking' | 'inline' | 'handoff';

/**
 * Whether inviting into an organization in this billing state may charge a
 * prorated seat. Mirrors the server's charge gate (an ACTIVE, non-trial
 * subscription on a PER_SEAT plan) and errs toward `true`: a seat already
 * paid for this period is still reported, because only the financial quote
 * can tell.
 */
export function inviteMayAddPaidSeat(summary: BillingSummary): boolean {
  return (
    summary.status === 'ACTIVE' &&
    summary.plan?.billingModel === 'PER_SEAT' &&
    summary.trial?.active !== true
  );
}

/**
 * Resolve the invite mode from the organization's billing summary. A 404 or
 * 403 means billing is absent for this viewer, so nothing can be charged (the
 * same rule the web seat quote follows); any other failure hands off, since
 * an unconfirmed charge must never run here.
 */
export async function resolveInviteSeatChargeMode(
  client: AccountOrganizationSettingsClient,
  organizationId: string,
): Promise<Exclude<InviteSeatChargeMode, 'checking'>> {
  try {
    const summary = await getOrgBillingSummary(client, organizationId);
    return inviteMayAddPaidSeat(summary) ? 'handoff' : 'inline';
  } catch (error: unknown) {
    if (
      error instanceof TeamApiError &&
      (error.status === 404 || error.status === 403)
    )
      return 'inline';
    return 'handoff';
  }
}

export interface InviteSeatChargeOptions {
  readonly organizationId: string;
  /** The viewer may invite and the Members page is showing. */
  readonly enabled: boolean;
  /** `canopy-billing-enabled` for this viewer; off means no seat charges. */
  readonly billingEnabled: boolean;
  /** Free app access: the server never charges a seat. */
  readonly freeAccess: boolean;
}

export interface InviteSeatCharge {
  readonly mode: InviteSeatChargeMode;
  /**
   * Re-read the mode immediately before an inline invite without a
   * seat-charge slot, so a plan change since the page loaded never charges
   * a seat the viewer did not confirm. Resolves `inline` when no check is
   * needed.
   */
  readonly recheck: () => Promise<Exclude<InviteSeatChargeMode, 'checking'>>;
  /**
   * Forget the cached check after a member or billing change, so the next
   * Members visit reads billing again. The mode on screen stays as it is.
   */
  readonly invalidate: () => void;
}

/**
 * The invite mode for one organization. Hosts with the seat-charge slot (web)
 * always invite inline; hosts without it read the billing summary when a
 * charge could apply.
 *
 * With a settings store (desktop) the result is cached per organization, so
 * a second Members visit shows its action at once instead of a disabled
 * "Add member" that may swap to "Invite on the web". Without a store, every
 * visit reads billing, as before.
 */
export function useInviteSeatCharge({
  organizationId,
  enabled,
  billingEnabled,
  freeAccess,
}: InviteSeatChargeOptions): InviteSeatCharge {
  const client = useSettingsClient();
  const settingsStore = useOptionalSettingsStoreApi();
  const cached = useOptionalSettingsStore(
    (state) => state.seatCharges[organizationId],
  );
  const { seatCharge } = useOrganizationSettingsSlots();
  const needsCheck =
    enabled && seatCharge === undefined && billingEnabled && !freeAccess;
  const [resolved, setResolved] = useState<{
    readonly organizationId: string;
    readonly mode: Exclude<InviteSeatChargeMode, 'checking'>;
  } | null>(null);

  useEffect(() => {
    if (!needsCheck) return undefined;
    // A cached check is used as is; holding it locally keeps the mode on
    // screen if the cache is cleared while this page stays open.
    const known = settingsStore?.getState().seatCharges[organizationId];
    if (known !== undefined) {
      setResolved({ organizationId, mode: known });
      return undefined;
    }
    let cancelled = false;
    void resolveInviteSeatChargeMode(client, organizationId).then((mode) => {
      if (cancelled) return;
      setResolved({ organizationId, mode });
      settingsStore?.getState().rememberSeatCharge(organizationId, mode);
    });
    return (): void => {
      cancelled = true;
    };
  }, [client, needsCheck, organizationId, settingsStore]);

  const recheck = useCallback(async (): Promise<
    Exclude<InviteSeatChargeMode, 'checking'>
  > => {
    if (!needsCheck) return 'inline';
    const mode = await resolveInviteSeatChargeMode(client, organizationId);
    setResolved({ organizationId, mode });
    settingsStore?.getState().rememberSeatCharge(organizationId, mode);
    return mode;
  }, [client, needsCheck, organizationId, settingsStore]);

  const invalidate = useCallback((): void => {
    settingsStore?.getState().forgetSeatCharge(organizationId);
  }, [organizationId, settingsStore]);

  if (!needsCheck) return { mode: 'inline', recheck, invalidate };
  const mode =
    resolved !== null && resolved.organizationId === organizationId
      ? resolved.mode
      : (cached ?? 'checking');
  return { mode, recheck, invalidate };
}
