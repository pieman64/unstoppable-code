import { renderToString } from 'react-dom/server';
import type { ReactNode } from 'react';
import type {
  PrMergedFeedItem,
  RunFailedFeedItem,
  RunSharedFeedItem,
  WorktreeUpdatedFeedItem,
} from '@canopy/protocol';
import { FeedItemCard } from '../team-feed-cards';
import {
  createTestSettingsHost,
  TestSettingsHost,
} from '../../__tests__/helpers/test-settings-host';

const baseActor = { userId: '42', displayName: 'Grace Hopper' };

function render(node: ReactNode, host = createTestSettingsHost().host): string {
  return renderToString(
    <TestSettingsHost host={host}>{node}</TestSettingsHost>,
  );
}

describe('FeedItemCard', () => {
  it('renders a merged PR card with diff stats and enrichment', () => {
    const item: PrMergedFeedItem = {
      id: 'pr_merged:1',
      type: 'pr_merged',
      occurredAt: new Date().toISOString(),
      actor: baseActor,
      worktreeId: 'wt-1',
      repoName: 'canopy',
      prNumber: 373,
      prUrl: 'https://github.com/example/canopy/pull/373',
      title: 'Team activity feed',
      branchName: 'qrtp/can-373',
      summary: 'Adds the read side of the feed.',
      additions: 120,
      deletions: 8,
      changedFiles: 14,
      totalCostUsd: 0.42,
      totalTokens: 12345,
      models: ['claude-opus-4-8', 'gpt-5-codex'],
      planId: 'plan-ext-1',
      sharedPlanId: null,
      planTitle: 'Team activity feed rollout',
      runUrl: 'https://example.com/run/1',
    };

    const html = render(<FeedItemCard item={item} orgId="org-1" />);

    expect(html).toContain('Grace Hopper');
    expect(html).toContain('#373');
    expect(html).toContain('Team activity feed');
    // React SSR splits adjacent text/expressions with comment markers, so
    // assert on the stable pieces rather than concatenated strings.
    expect(html).toContain('120');
    expect(html).toContain('fg-success');
    expect(html).toContain('$0.4200');
    // One meta chip per distinct primary-work model.
    expect(html).toContain('claude-opus-4-8');
    expect(html).toContain('gpt-5-codex');
    // Plan chip renders the human-readable plan title.
    expect(html).toContain('Team activity feed rollout');
    // With only planId (no sharedPlanId), the chip links to the viewable plan.
    expect(html).toContain('/plans/implemented/plan-ext-1');
    expect(html).toContain('View run');
  });

  it('prefers the shareable plan link over the viewable one on the plan chip', () => {
    const item: PrMergedFeedItem = {
      id: 'pr_merged:2',
      type: 'pr_merged',
      occurredAt: new Date().toISOString(),
      actor: baseActor,
      worktreeId: 'wt-1',
      repoName: 'canopy',
      prNumber: 374,
      prUrl: 'https://github.com/example/canopy/pull/374',
      title: 'Shared plan link',
      branchName: 'qrtp/can-374',
      summary: null,
      additions: null,
      deletions: null,
      changedFiles: null,
      totalCostUsd: null,
      totalTokens: null,
      models: [],
      planId: 'plan-ext-2',
      sharedPlanId: 'shared-2',
      planTitle: 'Shared plan rollout',
      runUrl: null,
    };

    const html = render(<FeedItemCard item={item} orgId="org-1" />);

    expect(html).toContain('Shared plan rollout');
    // Shared plan wins over the implemented link.
    expect(html).toContain('/plans/shared-2');
    expect(html).not.toContain('/plans/implemented/plan-ext-2');
  });

  it('renders the plan chip as plain text when there is no linkable plan id', () => {
    const item: PrMergedFeedItem = {
      id: 'pr_merged:no-plan-id',
      type: 'pr_merged',
      occurredAt: new Date().toISOString(),
      actor: baseActor,
      worktreeId: 'wt-1',
      repoName: 'canopy',
      prNumber: 375,
      prUrl: 'https://github.com/example/canopy/pull/375',
      title: 'Plan title without an id',
      branchName: null,
      summary: null,
      additions: null,
      deletions: null,
      changedFiles: null,
      totalCostUsd: null,
      totalTokens: null,
      models: [],
      planId: null,
      sharedPlanId: null,
      planTitle: 'Uncorrelated plan rollout',
      runUrl: null,
    };

    const html = render(<FeedItemCard item={item} orgId="org-1" />);

    // The plan title still renders...
    expect(html).toContain('Uncorrelated plan rollout');
    // ...but as a plain chip with no plan link (no dead link).
    expect(html).not.toContain('/plans/');
  });

  it('renders a run-shared card linking to the run viewer with session stats', () => {
    const item: RunSharedFeedItem = {
      id: 'run_shared:run-uuid',
      type: 'run_shared',
      occurredAt: new Date().toISOString(),
      actor: baseActor,
      worktreeId: null,
      sharedRunId: 'run-uuid',
      title: 'Punchier hero headline',
      shareScope: 'organization',
      status: 'success',
      turnCount: 4,
      toolUseCount: 16,
      model: 'claude-opus-4-8',
      totalCostUsd: 4.82,
    };

    const html = render(<FeedItemCard item={item} orgId="org-1" />);

    expect(html).toContain('shared a session');
    expect(html).toContain('Punchier hero headline');
    // Links to the standalone run viewer (was a no-op empty fragment before).
    expect(html).toContain('/runs/run-uuid');
    expect(html).toContain('View session');
    // Rollup meta chips. React SSR splits adjacent text/expressions with comment
    // markers, so assert on the stable pieces rather than concatenated strings.
    expect(html).toContain('turn');
    expect(html).toContain('success');
    expect(html).toContain('tool call');
    expect(html).toContain('claude-opus-4-8');
    expect(html).toContain('$4.82');
  });

  it('renders a run-failed card with notification-worthy danger tone', () => {
    const item: RunFailedFeedItem = {
      id: 'run_failed:1',
      type: 'run_failed',
      occurredAt: new Date().toISOString(),
      actor: baseActor,
      worktreeId: 'wt-1',
      clientChatId: 'chat-1',
      label: 'Refactor auth',
      status: 'FAILURE',
      model: 'claude',
      notificationWorthy: true,
    };

    const html = render(<FeedItemCard item={item} orgId="org-1" highlighted />);

    expect(html).toContain('Refactor auth');
    expect(html).toContain('FAILURE');
    // Danger tone + highlight ring should be applied.
    expect(html).toContain('border-line-destructive/40');
    expect(html).toContain('ring-line-accent');
  });

  it('renders a worktree-updated card with split title and markdown body', () => {
    const item: WorktreeUpdatedFeedItem = {
      id: 'worktree_updated:1',
      type: 'worktree_updated',
      occurredAt: new Date().toISOString(),
      actor: baseActor,
      worktreeId: 'wt-1',
      branchName: 'qrtp/can-393',
      summary:
        'Refined the feed card\nAdds markdown rendering.\n- Bold title\n- Collapsible body',
    };

    const html = render(<FeedItemCard item={item} orgId="org-1" />);

    // New action label.
    expect(html).toContain('updated a worktree');
    // First line becomes the bold title heading.
    expect(html).toContain('Refined the feed card');
    expect(html).toContain('font-semibold fg-primary');
    // Remainder is passed to the markdown renderer inside a prose container
    // through the shared markdown renderer.
    expect(html).toContain('Adds markdown rendering.');
    expect(html).toContain('[--tw-prose-body:var(--fg-primary)]');
    expect(html).toContain('break-words');
  });

  it('renders the actor avatar with an activity-type badge overlay', () => {
    const item: PrMergedFeedItem = {
      id: 'pr_merged:2',
      type: 'pr_merged',
      occurredAt: new Date().toISOString(),
      actor: baseActor,
      worktreeId: 'wt-1',
      repoName: 'canopy',
      prNumber: 1,
      prUrl: 'https://github.com/example/canopy/pull/1',
      title: 'A change',
      branchName: null,
      summary: null,
      additions: null,
      deletions: null,
      changedFiles: null,
      totalCostUsd: null,
      totalTokens: null,
      models: [],
      planId: null,
      sharedPlanId: null,
      planTitle: null,
      runUrl: null,
    };

    // No resolved member + no image → initials placeholder from displayName.
    const html = render(<FeedItemCard item={item} orgId="org-1" />);
    expect(html).toContain('feed-item-avatar');
    // Initials placeholder for "Grace Hopper".
    expect(html).toContain('GH');
    // Badge overlay rings against the card and is corner-positioned.
    expect(html).toContain('ring-card');
    expect(html).toContain('-bottom-1');
    expect(html).toContain('-right-1');
  });

  it('uses the resolved member image for the actor avatar', () => {
    const item: PrMergedFeedItem = {
      id: 'pr_merged:3',
      type: 'pr_merged',
      occurredAt: new Date().toISOString(),
      actor: baseActor,
      worktreeId: 'wt-1',
      repoName: 'canopy',
      prNumber: 2,
      prUrl: 'https://github.com/example/canopy/pull/2',
      title: 'Another change',
      branchName: null,
      summary: null,
      additions: null,
      deletions: null,
      changedFiles: null,
      totalCostUsd: null,
      totalTokens: null,
      models: [],
      planId: null,
      sharedPlanId: null,
      planTitle: null,
      runUrl: null,
    };

    const html = render(
      <FeedItemCard
        item={item}
        orgId="org-1"
        member={{
          id: '42',
          name: 'Grace Hopper',
          email: 'grace@example.com',
          image: 'https://example.com/grace.png',
          role: 'MEMBER',
          subTeamIds: [],
        }}
      />,
    );
    expect(html).toContain('<img');
  });

  it('renders a single-line worktree summary as title only with no body', () => {
    const item: WorktreeUpdatedFeedItem = {
      id: 'worktree_updated:2',
      type: 'worktree_updated',
      occurredAt: new Date().toISOString(),
      actor: baseActor,
      worktreeId: 'wt-2',
      branchName: 'qrtp/can-394',
      summary: 'Just a quick fix',
    };

    const html = render(<FeedItemCard item={item} orgId="org-1" />);

    expect(html).toContain('Just a quick fix');
    // No markdown body container and no toggle for a single-line summary.
    expect(html).not.toContain('prose');
    expect(html).not.toContain('Show more');
  });
});
