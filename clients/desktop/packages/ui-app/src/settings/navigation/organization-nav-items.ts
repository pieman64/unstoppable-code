import {
  BarChart3,
  Boxes,
  Database,
  FeedIcon,
  FileText,
  FolderGit2,
  Settings,
  Users,
} from '@canopy/ui-shared/icons/AppIcons';
import { organizationBillingPath } from '@canopy/protocol/billing';
import {
  LAPSED_LIVE_TABS,
  organizationSettingsNavTabForRoute,
  type OrganizationSettingsNavTab,
} from '@canopy/protocol/settings';
import { parseSettingsPathname } from './settings-path';

export { LAPSED_LIVE_TABS };

export type TeamTab = OrganizationSettingsNavTab;

export interface TeamNavItem {
  readonly key: TeamTab;
  readonly label: string;
  /** One sentence under the page header title. See `docs/ux-writing.md`. */
  readonly description: string;
  readonly icon: typeof FeedIcon;
  readonly href: (orgId: string) => string;
}

/**
 * Shared by the settings rail, which lists these in this order, and the
 * organization page header, which shows the current item's label and
 * description.
 */
export const TEAM_NAV_ITEMS: readonly TeamNavItem[] = [
  {
    key: 'feed',
    label: 'Timeline',
    description: 'Recent work from everyone in this organization.',
    icon: FeedIcon,
    href: (id) => `/organization/${id}`,
  },
  {
    key: 'statistics',
    label: 'Statistics',
    description: 'Usage, savings and impact across this organization.',
    icon: BarChart3,
    href: (id) => `/organization/${id}/statistics`,
  },
  {
    key: 'digests',
    label: 'Organization digests',
    description: "Regular summaries of this organization's work.",
    icon: FileText,
    href: (id) => `/organization/${id}/digests`,
  },
  {
    key: 'members',
    label: 'Members',
    description: 'The people in this organization and their roles.',
    icon: Users,
    href: (id) => `/organization/${id}/members`,
  },
  {
    key: 'groups',
    label: 'Teams',
    description: 'Groups of members inside this organization.',
    icon: Boxes,
    href: (id) => `/organization/${id}/teams`,
  },
  {
    key: 'projects',
    label: 'Projects',
    description: 'Projects in this organization and who can use them.',
    icon: FolderGit2,
    href: (id) => `/organization/${id}/projects`,
  },
  {
    key: 'memory',
    label: 'Organization memory',
    description: "Facts agents have learned from this organization's work.",
    icon: Database,
    href: (id) => `/organization/${id}/memory`,
  },
  {
    key: 'settings',
    label: 'Settings',
    description:
      'Control how this organization is set up, governed and billed.',
    icon: Settings,
    href: (id) => `/organization/${id}/settings`,
  },
];

/** The item for a tab; the page header reads its label and description. */
export function teamNavItem(tab: TeamTab): TeamNavItem {
  const item = TEAM_NAV_ITEMS.find((candidate) => candidate.key === tab);
  if (!item) throw new Error(`Unknown organization nav item: ${tab}`);
  return item;
}

/**
 * Where a tab links. When billing needs the viewer's action, Settings
 * deep-links to its Billing subtab so the attention dot does not cost an extra
 * click. Callers must gate `billingNeedsAttention` on the viewer's LIVE role.
 */
export function teamTabHref(
  item: TeamNavItem,
  orgId: string,
  billingNeedsAttention: boolean,
): string {
  return item.key === 'settings' && billingNeedsAttention
    ? organizationBillingPath(orgId)
    : item.href(orgId);
}

/**
 * The tab a route belongs to within ONE organization. `null` for any other
 * organization's routes, routes outside `/organization/<orgId>`, and unknown
 * sub-routes, so a caller never marks an unrelated tab current. Timeline
 * permalinks light Timeline, member details and their digests light Members,
 * Memory views and facts light Memory, and invoice details light Settings.
 */
export function matchTeamNavTab(
  pathname: string | null | undefined,
  orgId: string,
): TeamTab | null {
  return organizationSettingsNavTabForRoute(
    parseSettingsPathname(pathname),
    orgId,
  );
}
