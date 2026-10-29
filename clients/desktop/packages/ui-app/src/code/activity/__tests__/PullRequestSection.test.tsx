import { renderToString } from 'react-dom/server';
import type { PortalPrStatus } from '@canopy/protocol/portal';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { PullRequestSection } from '../sections/PullRequestSection';
import { portalPrStatusToSectionModel } from '../portal-pr-section-mapper';

describe('PullRequestSection', () => {
  it('renders an empty state when there is no PR', () => {
    expect(
      renderToString(<PullRequestSection prStatus={undefined} />),
    ).toContain('data-testid="activity-pr-empty"');
  });

  it('shows a failed refresh instead of "No pull request"', () => {
    const out = renderToString(
      <PullRequestSection
        prStatus={{
          worktreeLocalId: 'w',
          refreshError: "Couldn't reach GitHub. Try again.",
        }}
      />,
    );
    expect(out).toContain('data-testid="activity-pr-error"');
    expect(out).toContain('Try again.');
    expect(out).not.toContain('activity-pr-empty');
  });

  it('keeps the last PR read beside a failed refresh, marked as not current', () => {
    const out = renderToString(
      <PullRequestSection
        prStatus={{
          worktreeLocalId: 'w',
          number: 42,
          title: 'Add thing',
          state: 'open',
          refreshError: "Couldn't reach GitHub. Try again.",
        }}
      />,
    );
    expect(out).toContain('data-testid="activity-pr-error"');
    expect(out).toContain('Showing the last status read.');
    expect(out).toContain('Add thing');
  });

  it('renders the shared desktop card with number, title, and link', () => {
    const pr: PortalPrStatus = {
      worktreeLocalId: 'w',
      number: 42,
      title: 'Add thing',
      state: 'open',
      checkStatus: 'passing',
      reviewStatus: 'approved',
      url: 'https://example.test/pr/42',
    };
    // SSR inserts `<!-- -->` between adjacent text nodes; strip them so the
    // concatenated "#42" reads back.
    const out = renderToString(<PullRequestSection prStatus={pr} />).replace(
      /<!-- -->/g,
      '',
    );
    expect(out).toContain('data-testid="activity-pr"');
    expect(out).toContain('#42');
    expect(out).toContain('Add thing');
    expect(out).toContain('href="https://example.test/pr/42"');
    // The extracted desktop card renders its state badge testid.
    expect(out).toContain('data-testid="pr-status-badge"');
  });

  it('records the pull request detail in session replay', () => {
    const pr: PortalPrStatus = {
      worktreeLocalId: 'w',
      number: 42,
      title: 'Add thing',
      state: 'open',
      url: 'https://example.test/pr/42',
    };
    const out = renderToString(<PullRequestSection prStatus={pr} />);
    // The detail card is the first element inside the section root.
    expect(out).toMatch(
      /^<div data-testid="activity-pr"><div class="space-y-3">/,
    );
    expect(out).not.toContain(REPLAY_BLOCK_CLASS);
  });

  it('treats a null PR number with no title as empty (no bare "#")', () => {
    const pr: PortalPrStatus = {
      worktreeLocalId: 'w',
      number: null,
      state: 'open',
    };
    const out = renderToString(<PullRequestSection prStatus={pr} />);
    expect(out).toContain('data-testid="activity-pr-empty"');
    expect(out).not.toContain('#');
  });

  it('renders a card for unknown free-form states without throwing', () => {
    const pr: PortalPrStatus = {
      worktreeLocalId: 'w',
      number: 1,
      state: 'weird-state',
      checkStatus: 'none',
    };
    const out = renderToString(<PullRequestSection prStatus={pr} />);
    expect(out).toContain('data-testid="activity-pr"');
  });

  it('renders named check rows from checkDetails', () => {
    const pr: PortalPrStatus = {
      worktreeLocalId: 'w',
      number: 7,
      title: 'Checked',
      state: 'open',
      url: 'https://example.test/pr/7',
      checkStatus: 'failing',
      checkDetails: [
        { name: 'lint', status: 'success' },
        { name: 'tests', status: 'failure' },
      ],
    };
    const out = renderToString(<PullRequestSection prStatus={pr} />).replace(
      /<!-- -->/g,
      '',
    );
    expect(out).toContain('lint');
    expect(out).toContain('tests');
    expect(out).toContain('Checks (1/2 passing)');
  });

  it('renders labels and check-detail view links from the widened payload', () => {
    const pr: PortalPrStatus = {
      worktreeLocalId: 'w',
      number: 9,
      title: 'Labeled',
      state: 'open',
      url: 'https://example.test/pr/9',
      checkDetails: [
        { name: 'ci', status: 'success', detailsUrl: 'https://ci.test/run/1' },
      ],
      labels: [{ name: 'bug', color: 'd73a4a', description: null }],
    };
    const out = renderToString(<PullRequestSection prStatus={pr} />);
    expect(out).toContain('data-testid="pr-labels-section"');
    expect(out).toContain('bug');
    expect(out).toContain('href="https://ci.test/run/1"');
  });

  it('renders the "No reviews" badge when reviewStatus is absent', () => {
    const pr: PortalPrStatus = {
      worktreeLocalId: 'w',
      number: 3,
      title: 'Unreviewed',
      state: 'open',
      url: 'https://example.test/pr/3',
    };
    const out = renderToString(<PullRequestSection prStatus={pr} />);
    expect(out).toContain('No reviews');
  });

  it('hides the GitHub link when the snapshot has no URL', () => {
    const pr: PortalPrStatus = {
      worktreeLocalId: 'w',
      number: 5,
      title: 'No URL yet',
      state: 'open',
    };
    const out = renderToString(<PullRequestSection prStatus={pr} />);
    expect(out).toContain('data-testid="activity-pr"');
    expect(out).not.toContain('href=""');
    expect(out).not.toContain('GitHub');
  });

  it('renders an aggregate check row when only checkStatus is present', () => {
    const pr: PortalPrStatus = {
      worktreeLocalId: 'w',
      number: 6,
      title: 'Aggregate only',
      state: 'open',
      url: 'https://example.test/pr/6',
      checkStatus: 'failing',
    };
    const out = renderToString(<PullRequestSection prStatus={pr} />).replace(
      /<!-- -->/g,
      '',
    );
    expect(out).toContain('CI checks');
    expect(out).toContain('Checks (0/1 passing)');
  });
});

describe('portalPrStatusToSectionModel', () => {
  it('maps portal check statuses onto the desktop check vocabulary', () => {
    const model = portalPrStatusToSectionModel({
      worktreeLocalId: 'w',
      number: 1,
      state: 'open',
      checkDetails: [
        { name: 'a', status: 'success', detailsUrl: 'https://ci.test/a' },
        { name: 'b', status: 'failure' },
        { name: 'c', status: 'pending', detailsUrl: null },
        { name: 'd', status: 'neutral' },
      ],
    });
    expect(model.repos?.[0]?.status?.checkDetails).toEqual([
      { name: 'a', status: 'passing', detailsUrl: 'https://ci.test/a' },
      { name: 'b', status: 'failing', detailsUrl: null },
      { name: 'c', status: 'pending', detailsUrl: null },
      { name: 'd', status: 'neutral', detailsUrl: null },
    ]);
  });

  it('maps review statuses including the changes-requested spelling', () => {
    const changes = portalPrStatusToSectionModel({
      worktreeLocalId: 'w',
      number: 1,
      state: 'open',
      reviewStatus: 'changes-requested',
    });
    expect(changes.repos?.[0]?.status?.reviewStatus).toBe('changes_requested');
    const absent = portalPrStatusToSectionModel({
      worktreeLocalId: 'w',
      number: 1,
      state: 'open',
    });
    expect(absent.repos?.[0]?.status?.reviewStatus).toBe('none');
  });

  it('takes merge readiness from the desktop-computed mergeReady field', () => {
    const ready = portalPrStatusToSectionModel({
      worktreeLocalId: 'w',
      number: 1,
      state: 'open',
      mergeReady: true,
    });
    expect(ready.repos?.[0]?.status?.isMergeReady).toBe(true);
    // No heuristic: approved+passing without the wire field stays not-ready
    // (muted approved tone) — the desktop computation is authoritative.
    const absent = portalPrStatusToSectionModel({
      worktreeLocalId: 'w',
      number: 1,
      state: 'open',
      checkStatus: 'passing',
      reviewStatus: 'approved',
    });
    expect(absent.repos?.[0]?.status?.isMergeReady).toBe(false);
  });

  it('surfaces the explicit reviewStatus none', () => {
    const model = portalPrStatusToSectionModel({
      worktreeLocalId: 'w',
      number: 1,
      state: 'open',
      reviewStatus: 'none',
    });
    expect(model.repos?.[0]?.status?.reviewStatus).toBe('none');
  });

  it('passes labels through to the section status', () => {
    const model = portalPrStatusToSectionModel({
      worktreeLocalId: 'w',
      number: 1,
      state: 'open',
      labels: [{ name: 'bug', color: 'd73a4a', description: 'Bug reports' }],
    });
    expect(model.repos?.[0]?.status?.labels).toEqual([
      { name: 'bug', color: 'd73a4a', description: 'Bug reports' },
    ]);
  });

  it('maps the repos array into multi-repo grouped rows', () => {
    const model = portalPrStatusToSectionModel({
      worktreeLocalId: 'w',
      number: 1,
      state: 'open',
      title: 'Primary',
      repos: [
        {
          repoId: 'api',
          repoName: 'acme-api',
          status: {
            number: 11,
            url: 'https://example.test/api/11',
            state: 'open',
            title: 'API change',
            mergeReady: true,
          },
        },
        { repoId: 'web', repoName: 'acme-web', status: null },
      ],
    });
    expect(model.repos).toHaveLength(2);
    expect(model.repos?.[0]?.repoName).toBe('acme-api');
    expect(model.repos?.[0]?.status?.prNumber).toBe(11);
    expect(model.repos?.[0]?.status?.isMergeReady).toBe(true);
    expect(model.repos?.[1]?.status).toBeNull();
  });

  it('prefers the wire creationProgress over the legacy creationPhase', () => {
    const model = portalPrStatusToSectionModel({
      worktreeLocalId: 'w',
      number: null,
      creationPhase: 'gathering',
      creationProgress: {
        steps: [
          { phase: 'gathering_changes' },
          { phase: 'summarizing', repoName: 'acme-api' },
        ],
        currentPhase: 'summarizing',
      },
    });
    expect(model.isCreating).toBe(true);
    expect(model.creationProgress).toEqual({
      steps: [
        { phase: 'gathering_changes' },
        { phase: 'summarizing', repoName: 'acme-api' },
      ],
      currentPhase: 'summarizing',
    });
  });

  it('treats an explicit progress tombstone as cleared', () => {
    const model = portalPrStatusToSectionModel({
      worktreeLocalId: 'w',
      number: null,
      creationPhase: 'gathering',
      creationProgress: null,
    });
    expect(model.isCreating).toBe(false);
    expect(model.creationProgress).toBeUndefined();
  });

  it('stops reporting isCreating once the feed reaches a terminal phase', () => {
    const done = portalPrStatusToSectionModel({
      worktreeLocalId: 'w',
      number: 1,
      state: 'open',
      creationProgress: { steps: [{ phase: 'done' }], currentPhase: 'done' },
    });
    expect(done.isCreating).toBe(false);
    expect(done.creationProgress?.currentPhase).toBe('done');
  });

  it('synthesizes an aggregate check row only for renderable statuses', () => {
    const aggregate = portalPrStatusToSectionModel({
      worktreeLocalId: 'w',
      number: 1,
      state: 'open',
      checkStatus: 'pending',
    });
    expect(aggregate.repos?.[0]?.status?.checkDetails).toEqual([
      { name: 'CI checks', status: 'pending', detailsUrl: null },
    ]);
    const noChecks = portalPrStatusToSectionModel({
      worktreeLocalId: 'w',
      number: 1,
      state: 'open',
      checkStatus: 'none',
    });
    expect(noChecks.repos?.[0]?.status?.checkDetails).toEqual([]);
  });

  it('maps the legacy creationPhase onto the checklist vocabulary', () => {
    const model = portalPrStatusToSectionModel({
      worktreeLocalId: 'w',
      number: null,
      creationPhase: 'gathering',
    });
    expect(model.isCreating).toBe(true);
    expect(model.creationProgress).toEqual({
      steps: [],
      currentPhase: 'gathering_changes',
    });
  });
});
