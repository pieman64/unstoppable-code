/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useGitHubStore } from '@/stores/githubStore';
import { CommitMessageReviewModalHost } from '../CommitMessageReviewModal';

describe('CommitMessageReviewModalHost', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
      configurable: true,
      value: true,
    });
    useGitHubStore.setState({ commitReviewPending: {} });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useGitHubStore.setState({ commitReviewPending: {} });
  });

  it('renders a pending review without a worktree-local status bar', () => {
    useGitHubStore.setState({
      commitReviewPending: {
        'project/worktree': {
          repos: [
            {
              repoId: 'repo',
              repoName: 'Repository',
              message: 'feat: preserve changes',
            },
          ],
          resolve: jest.fn(),
          actionLabel: 'Commit',
        },
      },
    });

    act(() => root.render(<CommitMessageReviewModalHost />));

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.textContent).toContain('Review commit messages');
    expect(dialog?.textContent).toContain('Commit');
    expect(dialog?.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(
      'feat: preserve changes',
    );
  });

  it('renders queued reviews sequentially as earlier entries are removed', () => {
    const secondEntry = {
      repos: [
        {
          repoId: 'repo-b',
          repoName: 'Repository B',
          message: 'fix: second queued review',
        },
      ],
      resolve: jest.fn(),
      actionLabel: 'Commit' as const,
    };
    useGitHubStore.setState({
      commitReviewPending: {
        'project/worktree-a': {
          repos: [
            {
              repoId: 'repo-a',
              repoName: 'Repository A',
              message: 'fix: first queued review',
            },
          ],
          resolve: jest.fn(),
          actionLabel: 'Commit',
        },
        'project/worktree-b': secondEntry,
      },
    });

    act(() => root.render(<CommitMessageReviewModalHost />));
    expect(document.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(
      'fix: first queued review',
    );

    act(() => {
      useGitHubStore.setState({
        commitReviewPending: { 'project/worktree-b': secondEntry },
      });
    });

    expect(document.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(
      'fix: second queued review',
    );
  });
});
