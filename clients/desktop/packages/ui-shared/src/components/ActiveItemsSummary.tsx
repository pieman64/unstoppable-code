'use client';

import type { JSX } from 'react';
import { CUSTOMIZE_LABEL } from '@canopy/protocol/ui-labels';
import type { ActiveInstalledItemCounts } from '../lib/installed-item-status';
import { Button } from './Button';
import { InlineTextSkeleton } from './InlineTextSkeleton';
import { SettingsRowsRow } from './settings/SettingsRows';
import { StatusLabel } from './StatusLabel';

/**
 * Settings summary of what loads into every new chat (CAN-4255). Counts come
 * from `countActiveInstalledItems`, so an MCP server counts once whatever its
 * configurations, and other kinds count unique installed items.
 */

/**
 * The action that opens Customize, worded as on the MCP servers page so both
 * Settings pages name it the same way.
 */
export const OPEN_CUSTOMIZE_LABEL = `Open ${CUSTOMIZE_LABEL}`;

export const ACTIVE_ITEMS_SUMMARY_DESCRIPTION =
  'Active items are added to every new chat. Any project or chat can turn one off from its plugin picker.';

const COUNT_NOUNS: ReadonlyArray<
  readonly [keyof ActiveInstalledItemCounts, string, string]
> = [
  ['plugins', 'plugin', 'plugins'],
  ['skills', 'skill', 'skills'],
  ['mcpServers', 'MCP server', 'MCP servers'],
  ['collections', 'collection', 'collections'],
];

/** `3 plugins, 1 skill and 2 MCP servers`, or null when nothing is active. */
export function activeItemsSummaryText(
  counts: ActiveInstalledItemCounts,
): string | null {
  const parts = COUNT_NOUNS.flatMap(([key, singular, plural]) => {
    const count = counts[key];
    return count > 0 ? [`${count} ${count === 1 ? singular : plural}`] : [];
  });
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

export type ActiveItemsSummaryState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ready'; readonly counts: ActiveInstalledItemCounts };

export interface ActiveItemsSummaryProps {
  readonly state: ActiveItemsSummaryState;
  /** Opens the Installed list filtered to Active items. */
  readonly onManage: () => void;
  readonly testId?: string;
}

export function ActiveItemsSummary({
  state,
  onManage,
  testId = 'active-items-summary',
}: ActiveItemsSummaryProps): JSX.Element {
  let line: JSX.Element;
  if (state.kind === 'loading') {
    line = <InlineTextSkeleton className="w-32" />;
  } else if (state.kind === 'error') {
    line = <StatusLabel>{state.message}</StatusLabel>;
  } else {
    const text = activeItemsSummaryText(state.counts);
    const { plugins, skills, mcpServers, collections } = state.counts;
    const total = plugins + skills + mcpServers + collections;
    line = (
      <span className={text ? 'fg-primary' : 'fg-tertiary'}>
        {text
          ? `${text} ${total === 1 ? 'is' : 'are'} active.`
          : 'Nothing is active yet.'}
      </span>
    );
  }
  return (
    <SettingsRowsRow
      dataTestId={testId}
      label={<span data-testid={`${testId}-counts`}>{line}</span>}
      description={ACTIVE_ITEMS_SUMMARY_DESCRIPTION}
      control={
        <Button
          variant="secondary"
          size="compact"
          data-testid={`${testId}-manage`}
          onClick={onManage}
        >
          {OPEN_CUSTOMIZE_LABEL}
        </Button>
      }
    />
  );
}
