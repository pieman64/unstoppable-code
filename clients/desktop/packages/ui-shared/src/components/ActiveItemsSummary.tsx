'use client';

import type { JSX } from 'react';
import type { ActiveInstalledItemCounts } from '../lib/installed-item-status';
import { Button } from './Button';

/**
 * Settings summary of what loads into every new chat (CAN-4255). Counts come
 * from `countActiveInstalledItems`, so an MCP server counts once whatever its
 * configurations, and other kinds count unique installed items.
 */

/**
 * Temporary shared name for the capability management surface until the
 * Customize naming work (#5727) exports its canonical label.
 */
export const CUSTOMIZE_SURFACE_LABEL = 'Customize';

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
    line = <span className="fg-tertiary">Loading…</span>;
  } else if (state.kind === 'error') {
    line = (
      <span role="alert" className="fg-destructive">
        {state.message}
      </span>
    );
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
    <div
      data-testid={testId}
      className="flex items-start justify-between gap-4"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <p data-testid={`${testId}-counts`} className="text-s">
          {line}
        </p>
        <p className="text-xs fg-tertiary">
          {ACTIVE_ITEMS_SUMMARY_DESCRIPTION}
        </p>
      </div>
      <Button
        variant="secondary"
        size="sm"
        data-testid={`${testId}-manage`}
        onClick={onManage}
      >
        {`Manage in ${CUSTOMIZE_SURFACE_LABEL}`}
      </Button>
    </div>
  );
}
