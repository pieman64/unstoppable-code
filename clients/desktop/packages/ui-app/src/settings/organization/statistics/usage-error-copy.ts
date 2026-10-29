import type { KnownSettingsError } from '../../errors';
import { ORGANIZATION_LAPSED_ERROR } from '../organization-known-errors';

/** Logger scope for the organization Statistics page. */
export const STATISTICS_ERROR_SCOPE = 'settings.organization.statistics';

/**
 * Failures of the organization usage reads (Statistics, member profile usage,
 * plan pricing) that have their own copy. Both are 403s: the route checks the
 * viewer's role against the organization's usage-stats setting, then the
 * organization's plan (`org_teams_lapsed`). The plan case is listed first so
 * it wins over the bare-status role case.
 */
export const USAGE_KNOWN_LOAD_ERRORS: readonly KnownSettingsError[] = [
  ORGANIZATION_LAPSED_ERROR,
  {
    status: 403,
    copy: 'Usage statistics aren’t available to your role in this organization.',
  },
];
