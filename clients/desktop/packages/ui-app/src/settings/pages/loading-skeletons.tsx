'use client';

import type { JSX } from 'react';
import {
  CenteredLoadingSpinner,
  DelayedLoadingPlaceholder,
  SettingsCardsSkeleton,
  SettingsChartSkeleton,
  SettingsFormSkeleton,
  SettingsListSkeleton,
  SettingsTableSkeleton,
} from '@canopy/ui-shared/components';
import type { SettingsPageDataKind } from '@canopy/protocol/settings';

/**
 * The shape a settings page's body takes while it loads. A page whose shape
 * is predictable gets a skeleton of it; a page whose shape is not gets one
 * centered spinner.
 */
export type SettingsPageSkeletonVariant =
  | 'list'
  | 'form'
  | 'table'
  | 'cards'
  | 'chart'
  | 'graph'
  | 'spinner';

/**
 * The loading body of every hosted settings page, keyed by page-data kind.
 * Kept apart from the lazy page registry so a loading frame can import it
 * without loading page chunks. The mapped type makes a new page kind fail to
 * compile until it is listed here.
 */
export const HOSTED_SETTINGS_PAGE_SKELETONS: {
  readonly [K in SettingsPageDataKind]: SettingsPageSkeletonVariant;
} = {
  'account.account': 'form',
  'account.profile': 'form',
  'account.digests': 'cards',
  'account.digest': 'cards',
  'account.notifications': 'form',
  'account.integrations': 'list',
  'account.security': 'form',
  'account.billing': 'cards',
  'account.invoice': 'table',
  'account.labs': 'form',
  'account.appearance': 'form',
  'organization.list': 'list',
  'organization.feed': 'list',
  'organization.feedItem': 'spinner',
  'organization.statistics': 'chart',
  'organization.digests': 'cards',
  'organization.digest': 'cards',
  'organization.members': 'list',
  'organization.member': 'spinner',
  'organization.memberDigest': 'cards',
  'organization.groups': 'list',
  'organization.projects': 'list',
  'organization.memory.facts': 'list',
  'organization.memory.graph': 'graph',
  'organization.memory.ops': 'table',
  'organization.memory.fact': 'spinner',
  'organization.settings': 'form',
  'organization.invoice': 'table',
};

/** Lists of organizations, teams, projects and tools show square logos. */
const SQUARE_AVATAR_KINDS: ReadonlySet<SettingsPageDataKind> = new Set([
  'account.integrations',
  'organization.list',
  'organization.groups',
  'organization.projects',
]);

function skeletonBody(
  kind: SettingsPageDataKind,
  rows: number | undefined,
): JSX.Element {
  switch (HOSTED_SETTINGS_PAGE_SKELETONS[kind]) {
    case 'list':
      return (
        <SettingsListSkeleton
          rows={rows}
          avatarShape={SQUARE_AVATAR_KINDS.has(kind) ? 'square' : 'circle'}
        />
      );
    case 'form':
      return <SettingsFormSkeleton rows={rows} />;
    case 'table':
      return <SettingsTableSkeleton rows={rows} />;
    case 'cards':
      return <SettingsCardsSkeleton />;
    case 'chart':
      return <SettingsChartSkeleton variant="bars" />;
    case 'graph':
      return <SettingsChartSkeleton variant="graph" />;
    case 'spinner':
      return <CenteredLoadingSpinner />;
  }
}

/** Said below a settings page's skeleton once its load runs long. */
export const SETTINGS_PAGE_SLOW_LOAD_NOTE = 'Still loading settings…';

/**
 * The loading body for a settings page of `kind`: its skeleton (or the
 * centered spinner), in a box reserved from the first render and shown only
 * once loading takes noticeably long, with one quiet line below it if the
 * load runs long. `rows` sets the row count of list, form and table
 * skeletons. `delayMs` overrides the delay, for example `0` when the
 * previous page already held the screen for it.
 */
export function settingsPageSkeleton(
  kind: SettingsPageDataKind,
  rows?: number,
  delayMs?: number,
): JSX.Element {
  return (
    <DelayedLoadingPlaceholder
      delayMs={delayMs}
      slowNote={SETTINGS_PAGE_SLOW_LOAD_NOTE}
    >
      {skeletonBody(kind, rows)}
    </DelayedLoadingPlaceholder>
  );
}
