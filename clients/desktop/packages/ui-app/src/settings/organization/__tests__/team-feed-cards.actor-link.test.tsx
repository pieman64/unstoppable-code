import { renderToString } from 'react-dom/server';
import type { ReactNode } from 'react';
import type { WorktreeStartedFeedItem } from '@canopy/protocol';
import {
  FeedActorProfileLinksProvider,
  FeedItemCard,
} from '../team-feed-cards';
import { TestSettingsHost } from '../../__tests__/helpers/test-settings-host';

function renderCard(node: ReactNode): string {
  return renderToString(<TestSettingsHost>{node}</TestSettingsHost>);
}

function makeItem(actor: {
  userId: string;
  displayName: string | null;
}): WorktreeStartedFeedItem {
  return {
    id: 'worktree_started:1',
    type: 'worktree_started',
    occurredAt: new Date().toISOString(),
    actor,
    worktreeId: 'wt-1',
    branchName: 'qrtp/can-1',
    workspaceName: null,
  };
}

describe('FeedItemCard actor byline link', () => {
  it('links the actor to their member profile when the actor resolves', () => {
    const html = renderCard(
      <FeedItemCard
        item={makeItem({ userId: 'user-uuid', displayName: 'Grace Hopper' })}
        orgId="org-1"
      />,
    );
    expect(html).toContain('href="/organization/org-1/members/user-uuid"');
    expect(html).toContain('Grace Hopper');
  });

  it('links the actor avatar to their member profile when the actor resolves', () => {
    const html = renderCard(
      <FeedItemCard
        item={makeItem({ userId: 'user-uuid', displayName: 'Grace Hopper' })}
        orgId="org-1"
      />,
    );
    expect(html).toContain('data-testid="feed-actor-avatar-link"');
    expect(html).toContain('aria-label="View Grace Hopper');
  });

  it('renders the actor as plain text when the actor was removed/unknown', () => {
    const html = renderCard(
      <FeedItemCard
        item={makeItem({ userId: 'user-uuid', displayName: null })}
        orgId="org-1"
      />,
    );
    expect(html).not.toContain('/organization/org-1/members/user-uuid');
    expect(html).not.toContain('data-testid="feed-actor-avatar-link"');
    expect(html).toContain('A teammate');
  });

  it('renders the actor as text in a personal organization feed', () => {
    const html = renderCard(
      <FeedActorProfileLinksProvider value={false}>
        <FeedItemCard
          item={makeItem({ userId: 'user-uuid', displayName: 'Grace Hopper' })}
          orgId="org-1"
        />
      </FeedActorProfileLinksProvider>,
    );
    expect(html).not.toContain('/organization/org-1/members/user-uuid');
    expect(html).not.toContain('data-testid="feed-actor-avatar-link"');
    expect(html).not.toContain('data-testid="feed-actor-link"');
    expect(html).toContain('Grace Hopper');
  });
});
