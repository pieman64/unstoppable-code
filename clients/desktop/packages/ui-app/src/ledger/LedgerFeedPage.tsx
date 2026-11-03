'use client';

import type { JSX } from 'react';
import type { CanopyCapabilities } from '@canopy/app-core';
import { PageColumn, PageHeader, Stack } from '@canopy/ui-shared/components';
import { LedgerFeed, type LedgerFeedProps } from './LedgerFeed';

/** The Feed page's title, on every host. */
export const LEDGER_FEED_TITLE = 'Feed';

/** What the Feed page lists, under its title on every host. */
export const LEDGER_FEED_SUBTITLE =
  'Entries from all your projects, tasks and workflows, newest change first.';

/** The Feed page's header, shared by the desktop and web pages. */
export function LedgerFeedHeading({
  className,
  inset,
}: {
  readonly className?: string;
  /** `none` when the host's page frame already insets the top. */
  readonly inset?: 'page' | 'none';
}): JSX.Element {
  return (
    <PageHeader
      title={LEDGER_FEED_TITLE}
      description={LEDGER_FEED_SUBTITLE}
      inset={inset}
      className={className}
    />
  );
}

export interface LedgerFeedPageProps extends LedgerFeedProps {
  /** What the host can do with the Feed; local features need `ledgerLocal`. */
  readonly capabilities: Pick<CanopyCapabilities, 'ledgerFeed' | 'ledgerLocal'>;
  /**
   * `page` (default) when the heading opens the page under a title bar;
   * `none` when the host's frame already insets the top.
   */
  readonly headingInset?: 'page' | 'none';
}

/**
 * The Feed page on every host: its heading, then the Feed, in one 640px page
 * column so the title, tabs, search row and list share one left and right
 * edge (design, 2026-11-01). The window chrome around it stays the host's. A host that holds a Ledger itself
 * (`ledgerLocal`) adds its scopes, the composer and every change; one that
 * only reads the mirror shows the same list, filters, threads and details,
 * read only.
 */
export function LedgerFeedPage({
  capabilities,
  headingInset,
  local,
  ...feed
}: LedgerFeedPageProps): JSX.Element | null {
  if (capabilities.ledgerFeed !== true) return null;
  return (
    <PageColumn
      width="content"
      className="min-h-0 flex-1"
      data-testid="ledger-feed-page-column"
    >
      {/* The heading introduces the list, so both are one section: 16px
          apart, as before the column. */}
      <Stack gap="group" className="min-h-0 flex-1">
        <LedgerFeedHeading inset={headingInset} />
        <div className="flex min-h-0 flex-1 flex-col">
          <LedgerFeed
            {...feed}
            {...(capabilities.ledgerLocal === true && local !== undefined
              ? { local }
              : {})}
          />
        </div>
      </Stack>
    </PageColumn>
  );
}
