import type { ComponentType } from 'react';
import { BuildingIcon } from '@canopy/ui-shared/icons/AppIcons';
import type { SettingsNavModel } from '@canopy/protocol/settings';
import {
  matchAccountNavKey,
  visibleAccountNavItems,
} from './account-nav-items';
import {
  matchTeamNavTab,
  teamTabHref,
  TEAM_NAV_ITEMS,
} from './organization-nav-items';
import { pathSegments } from './settings-path';

export type SettingsNavIcon = ComponentType<{ size?: number }>;

/**
 * The shared groups. Hosts may append their own groups (web adds Admin;
 * desktop renders its local settings groups below these).
 */
export type SettingsNavGroupId = 'account' | 'organizations' | 'organization';

export interface SettingsNavRow {
  /** Stable, group-prefixed identity, e.g. `account-security`. */
  readonly key: string;
  readonly label: string;
  readonly icon: SettingsNavIcon;
  /** Where the row links. May differ from the row's logical destination. */
  readonly href: string;
  /** Blocked rows are shown but inert. Takes precedence over `attention`. */
  readonly disabled: boolean;
  /** Billing needs the viewer's action; the row deep-links to it. */
  readonly attention: boolean;
}

export interface SettingsNavGroup<Id extends string = SettingsNavGroupId> {
  readonly id: Id;
  readonly label: string;
  readonly rows: readonly SettingsNavRow[];
}

export const ORGANIZATIONS_ROW_KEY = 'organizations-list';

/**
 * The settings rail's shared groups, in order: Account, Organizations, and
 * the current organization (only while browsing one). Visibility follows each
 * destination's own page guard; it is display policy, never an authorization
 * boundary. `model.adminVisible` is read by hosts that append Admin.
 */
export function buildSettingsNavGroups(
  model: SettingsNavModel,
): readonly SettingsNavGroup[] {
  const groups: SettingsNavGroup[] = [
    {
      id: 'account',
      label: 'Account',
      rows: visibleAccountNavItems(model.account).map((item) => ({
        key: `account-${item.key}`,
        label: item.label,
        icon: item.icon,
        href: item.href,
        disabled: false,
        attention: false,
      })),
    },
    {
      id: 'organizations',
      label: 'Organizations',
      rows: [
        {
          key: ORGANIZATIONS_ROW_KEY,
          label: 'Organizations',
          icon: BuildingIcon,
          href: '/organization',
          disabled: false,
          attention: false,
        },
      ],
    },
  ];

  const organization = model.organization;
  if (organization !== null) {
    const visible = new Set(organization.visibleTabs);
    const disabled = new Set(organization.disabledTabs);
    groups.push({
      id: 'organization',
      label: organization.name,
      rows: TEAM_NAV_ITEMS.filter((item) => visible.has(item.key)).map(
        (item) => {
          const isDisabled = disabled.has(item.key);
          const attention =
            !isDisabled &&
            item.key === 'settings' &&
            organization.billingNeedsAttention;
          return {
            key: `organization-${item.key}`,
            label: item.label,
            icon: item.icon,
            href: teamTabHref(item, organization.id, attention),
            disabled: isDisabled,
            attention,
          };
        },
      ),
    });
  }

  return groups;
}

/**
 * The logical row a pathname belongs to among the shared groups, before
 * checking that the row is visible. Hosts with extra groups resolve their own
 * paths first and fall back to this.
 */
export function settingsNavLogicalRowKey(
  pathname: string | null | undefined,
  organizationId: string | null,
): string | null {
  const [root, second] = pathSegments(pathname);
  if (root === 'account') {
    const key = matchAccountNavKey(pathname);
    return key === null ? null : `account-${key}`;
  }
  if (root === 'organization') {
    if (second === undefined) return ORGANIZATIONS_ROW_KEY;
    if (organizationId === null) return null;
    const tab = matchTeamNavTab(pathname, organizationId);
    return tab === null ? null : `organization-${tab}`;
  }
  return null;
}

/**
 * The one row current for a route, or `null`. Selection follows the row's
 * logical destination rather than its href, so Settings stays current on its
 * billing descendants even while attention rewrites its link. A hidden,
 * unknown, or foreign-organization destination selects nothing rather than
 * falling back to a root row.
 */
export function selectSettingsNavRow(
  groups: readonly SettingsNavGroup<string>[],
  pathname: string | null | undefined,
  organizationId: string | null,
  logicalKey: (
    pathname: string | null | undefined,
    organizationId: string | null,
  ) => string | null = settingsNavLogicalRowKey,
): string | null {
  const key = logicalKey(pathname, organizationId);
  if (key === null) return null;
  return groups.some((group) => group.rows.some((row) => row.key === key))
    ? key
    : null;
}
