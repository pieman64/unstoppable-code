import { renderToStaticMarkup } from 'react-dom/server';
import { PrMergeMultiRepoModal } from '../PrMergeMultiRepoModal';

const noop = (): void => undefined;

describe('PrMergeMultiRepoModal', () => {
  it('shows progress while fresh GitHub state is loading', () => {
    const markup = renderToStaticMarkup(
      <PrMergeMultiRepoModal
        repos={[]}
        isChecking
        checkFailed={false}
        isSubmitting={false}
        onConfirm={noop}
        onRetry={noop}
        onClose={noop}
      />,
    );

    expect(markup).toContain('Checking pull requests…');
    expect(markup).toContain('Refreshing mergeability and review threads');
    expect(markup).toContain('Checking…');
  });

  it('offers a retry when the fresh GitHub check fails', () => {
    const markup = renderToStaticMarkup(
      <PrMergeMultiRepoModal
        repos={[]}
        isChecking={false}
        checkFailed
        isSubmitting={false}
        onConfirm={noop}
        onRetry={noop}
        onClose={noop}
      />,
    );

    expect(markup).toContain('Couldn’t check pull requests');
    expect(markup).toContain('Try again');
  });

  it('labels a repo the main process refused as already queued', () => {
    const markup = renderToStaticMarkup(
      <PrMergeMultiRepoModal
        repos={[
          {
            repoId: 'repo-a',
            repoName: 'repo-a',
            prNumber: 12,
            prUrl: 'https://github.com/o/repo-a/pull/12',
            mergeable: false,
            unresolvedReviewThreadCount: 0,
            blockedReason: 'in_merge_queue',
          },
        ]}
        isChecking={false}
        checkFailed={false}
        isSubmitting={false}
        onConfirm={noop}
        onRetry={noop}
        onClose={noop}
      />,
    );

    expect(markup).toContain('In merge queue');
    expect(markup).not.toContain('Not mergeable');
  });

  it('marks merge queue rows without blocking their selection', () => {
    const markup = renderToStaticMarkup(
      <PrMergeMultiRepoModal
        repos={[
          {
            repoId: 'repo-a',
            repoName: 'repo-a',
            prNumber: 12,
            prUrl: 'https://github.com/o/repo-a/pull/12',
            mergeable: true,
            usesMergeQueue: true,
            startsAgentChat: true,
            unresolvedReviewThreadCount: 0,
          },
          {
            repoId: 'repo-b',
            repoName: 'repo-b',
            prNumber: 13,
            prUrl: 'https://github.com/o/repo-b/pull/13',
            mergeable: true,
            usesMergeQueue: false,
            unresolvedReviewThreadCount: 0,
          },
        ]}
        isChecking={false}
        checkFailed={false}
        isSubmitting={false}
        onConfirm={noop}
        onRetry={noop}
        onClose={noop}
      />,
    );

    expect(markup).toContain(
      'data-testid="pr-merge-multi-repo-queue-hint-repo-a"',
    );
    expect(markup).not.toContain('pr-merge-multi-repo-queue-hint-repo-b');
    expect(markup.match(/Uses a merge queue/g)).toHaveLength(1);
    expect(markup).toContain(
      'Pull requests on a merge queue open a chat that merges through the queue.',
    );
    // Both rows stay selectable and selected by default.
    expect(markup).not.toContain('disabled=""');
    expect(markup).toContain('Merge 2 PRs');
  });

  it.each([
    [
      'every merge queue row is added to the queue directly',
      [false, false],
      'Pull requests on a merge queue are added to the queue.',
    ],
    [
      'only some merge queue rows open a chat',
      [true, false],
      'Pull requests on a merge queue are added to the queue. Those with no merge queue hook open a chat that oversees the merge.',
    ],
  ])('explains the merge queue route when %s', (_label, chats, note) => {
    const markup = renderToStaticMarkup(
      <PrMergeMultiRepoModal
        repos={chats.map((startsAgentChat, index) => ({
          repoId: `repo-${index}`,
          repoName: `repo-${index}`,
          prNumber: 20 + index,
          prUrl: `https://github.com/o/repo-${index}/pull/${20 + index}`,
          mergeable: true,
          usesMergeQueue: true,
          startsAgentChat,
          unresolvedReviewThreadCount: 0,
        }))}
        isChecking={false}
        checkFailed={false}
        isSubmitting={false}
        onConfirm={noop}
        onRetry={noop}
        onClose={noop}
      />,
    );

    expect(markup).toContain(note);
    expect(markup.match(/Uses a merge queue/g)).toHaveLength(2);
  });

  it('omits merge queue copy when no row uses a merge queue', () => {
    const markup = renderToStaticMarkup(
      <PrMergeMultiRepoModal
        repos={[
          {
            repoId: 'repo-a',
            repoName: 'repo-a',
            prNumber: 12,
            prUrl: 'https://github.com/o/repo-a/pull/12',
            mergeable: true,
            unresolvedReviewThreadCount: 0,
          },
        ]}
        isChecking={false}
        checkFailed={false}
        isSubmitting={false}
        onConfirm={noop}
        onRetry={noop}
        onClose={noop}
      />,
    );

    expect(markup).not.toContain('Uses a merge queue');
    expect(markup).not.toContain('open a chat that merges through the queue');
  });
});
