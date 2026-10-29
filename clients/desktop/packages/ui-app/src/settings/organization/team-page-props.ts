import type { OrganizationTeamPageData } from '@canopy/protocol/settings';
import type { TeamPageProps } from './team-page';

/** The {@link TeamPage} props every organization tab takes from its page data. */
export type TeamPageDataProps = Pick<
  TeamPageProps,
  | 'initialDetail'
  | 'organizations'
  | 'viewerEmail'
  | 'billingEnabled'
  | 'memoryEnabled'
  | 'projectsEnabled'
  | 'billingNeedsAttention'
  | 'freeAccess'
  | 'lapsed'
  | 'mobileBrowser'
>;

/**
 * Map the shared `OrganizationTeamPageData` DTO (the web server loader's
 * projection, or `settings.pageData` on desktop) onto the {@link TeamPage}
 * props. `digestsEnabled` drives only the settings rail, so TeamPage does not
 * take it.
 */
export function teamPagePropsFromData(
  data: OrganizationTeamPageData,
): TeamPageDataProps {
  return {
    initialDetail: data.detail,
    organizations: data.organizations,
    viewerEmail: data.viewerEmail,
    billingEnabled: data.billingEnabled,
    memoryEnabled: data.memoryEnabled,
    projectsEnabled: data.projectsEnabled,
    billingNeedsAttention: data.billingNeedsAttention,
    freeAccess: data.freeAccess,
    lapsed: data.lapsed,
    mobileBrowser: data.mobileBrowser,
  };
}

/** A one-shot `?<name>=1` flag, read the way the web route read it. */
export function searchFlagIsSet(
  values: readonly string[],
  options: { readonly allowRepeated: boolean },
): boolean {
  return options.allowRepeated
    ? values.includes('1')
    : values.length === 1 && values[0] === '1';
}
