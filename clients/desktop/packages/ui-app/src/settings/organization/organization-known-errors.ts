import type { KnownSettingsError } from '../errors';

/**
 * Known failures that any organization mutation can return, for the `known`
 * list of `settingsActionErrorCopy`. Matched by the route's structured code,
 * never by its text.
 */

/**
 * The organization has no active plan (CAN-2311): the server refuses its
 * gated reads and mutations with `403 org_teams_lapsed`. The copy stays
 * cause-neutral, per "Organization without an active plan" in
 * `docs/ux-writing.md`: a trial that ended and an organization that never
 * subscribed read the same, and it never says "restore" or "renew".
 */
export const ORGANIZATION_LAPSED_COPY =
  'This organization has no active plan. An owner can choose one in Billing.';

/** {@link ORGANIZATION_LAPSED_COPY} as a known case, matched by its code. */
export const ORGANIZATION_LAPSED_ERROR: KnownSettingsError = {
  status: 403,
  serverCode: 'org_teams_lapsed',
  copy: ORGANIZATION_LAPSED_COPY,
};
