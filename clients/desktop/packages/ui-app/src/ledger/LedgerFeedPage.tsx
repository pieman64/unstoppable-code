'use client';

import type { JSX, ReactNode } from 'react';
import type { CanopyCapabilities } from '@canopy/app-core';
import { PageHeader } from '@canopy/ui-shared/components';
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
  /** Places the heading in the host's page chrome. */
  readonly frameHeading: (heading: JSX.Element) => ReactNode;
  /**
   * `page` (default) when the heading opens the page under a title bar;
   * `none` when the host's frame already insets the top.
   */
  readonly headingInset?: 'page' | 'none';
  /** Places the Feed itself in the host's page chrome. */
  readonly frameFeed: (feed: JSX.Element) => ReactNode;
}

/**
 * The Feed page on every host: its heading, then the Feed. The window chrome
 * around them stays the host's. A host that holds a Ledger itself
 * (`ledgerLocal`) adds its scopes, the composer and every change; one that
 * only reads the mirror shows the same list, filters, threads and details,
 * read only.
 */
export function LedgerFeedPage({
  capabilities,
  frameHeading,
  headingInset,
  frameFeed,
  local,
  ...feed
}: LedgerFeedPageProps): JSX.Element | null {
  if (capabilities.ledgerFeed !== true) return null;
  return (
    <>
      {frameHeading(<LedgerFeedHeading inset={headingInset} />)}
      {frameFeed(
        <LedgerFeed
          {...feed}
          {...(capabilities.ledgerLocal === true && local !== undefined
            ? { local }
            : {})}
        />,
      )}
    </>
  );
}
