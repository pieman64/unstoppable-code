'use client';

import { useMemo } from 'react';
import { BILLING_CARD_DECLINED_ERROR } from '@canopy/app-state/billing';
import {
  logSettingsError,
  settingsActionErrorCopy,
  settingsFailure,
  settingsLoadErrorCopy,
  type KnownSettingsError,
  type SettingsErrorCopy,
  type SettingsFailure,
} from '../errors';
import { useOptionalSettingsHost } from '../host/settings-host';

/**
 * Local copy for the billing failures a viewer can act on. Billing routes
 * answer with a status and, for a few refusals, a structured `code`; the
 * route's `{ error }` text is never shown. Codes come first so a coded 409
 * wins over any bare-status case a call site appends.
 */
export const BILLING_KNOWN_ERRORS: readonly KnownSettingsError[] = [
  {
    serverCode: 'subscription_billing_stopped',
    copy: 'Billing is stopped for this plan. Contact support to resume it.',
  },
  {
    serverCode: 'subscription_complimentary',
    copy: "This plan is complimentary, so it can't be changed here. Contact support to change it.",
  },
  {
    serverCode: 'subscription_free_access',
    copy: "You don't need a plan right now. Every app feature is free.",
  },
  { status: 402, copy: BILLING_CARD_DECLINED_ERROR },
];

/** Shown when an organization billing action is refused with a 403. */
export const ORG_BILLING_OWNER_ONLY_COPY =
  'Only organization owners can manage billing.';

/**
 * {@link BILLING_KNOWN_ERRORS} for organization billing actions, which are
 * owner-only: a 403 means the viewer is no longer an owner.
 */
export const ORG_BILLING_KNOWN_ERRORS: readonly KnownSettingsError[] = [
  ...BILLING_KNOWN_ERRORS,
  { status: 403, copy: ORG_BILLING_OWNER_ONLY_COPY },
];

/**
 * `useSettingsErrorCopy` for billing controls that also render outside a
 * settings host (web billing slots under test, checkout surfaces). It logs
 * through the host's `logger(scope)` when there is one and returns the same
 * failure (our sentence and the raw reason as `details`) either way. Call it where the failure is caught, not during render.
 */
export function useBillingErrorCopy(scope: string): SettingsErrorCopy {
  const host = useOptionalSettingsHost();
  return useMemo((): SettingsErrorCopy => {
    const logger = host?.logger(scope) ?? null;
    return {
      loadFailure: (error, known): SettingsFailure => {
        if (logger !== null) logSettingsError(logger, 'load', error);
        return settingsFailure(error, settingsLoadErrorCopy(error, known));
      },
      actionFailure: (error, options): SettingsFailure => {
        if (logger !== null) logSettingsError(logger, options.action, error);
        return settingsFailure(error, settingsActionErrorCopy(error, options));
      },
    };
  }, [host, scope]);
}
