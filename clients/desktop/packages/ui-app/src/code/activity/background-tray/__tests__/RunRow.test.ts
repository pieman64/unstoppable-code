import type { GitHubWorkflowRunRowData } from '../../github/GitHubWorkflowRunRow';
import {
  githubBackgroundTrayRun,
  githubPullRequestBackgroundTrayRun,
  type GitHubPullRequestRowData,
} from '../RunRow';

function githubRun(
  state: GitHubWorkflowRunRowData['state'],
): GitHubWorkflowRunRowData {
  return {
    repository: 'acme/api',
    runId: '101',
    runAttempt: 1,
    workflowName: 'CI',
    runNumber: 42,
    htmlUrl: 'https://github.com/acme/api/actions/runs/101',
    state,
    observedAt: '2026-10-26T00:00:00.000Z',
  };
}

describe('githubBackgroundTrayRun', () => {
  it.each([
    ['success', 'succeeded'],
    ['failure', 'failed'],
    ['timed_out', 'failed'],
    ['startup_failure', 'failed'],
    ['action_required', 'failed'],
    ['cancelled', 'cancelled'],
    // Ended without a success GitHub confirmed.
    ['skipped', 'completed'],
    ['neutral', 'completed'],
    ['stale', 'completed'],
    ['something_new', 'completed'],
  ] as const)('maps a %s conclusion to %s', (conclusion, status) => {
    expect(
      githubBackgroundTrayRun('gh', githubRun({ kind: 'terminal', conclusion }))
        .status,
    ).toBe(status);
  });

  it('maps an unsupported terminal state to completed, and a live one to running', () => {
    expect(
      githubBackgroundTrayRun(
        'gh',
        githubRun({
          kind: 'unsupported',
          status: 'completed',
          conclusion: null,
          terminal: true,
        }),
      ).status,
    ).toBe('completed');
    expect(
      githubBackgroundTrayRun(
        'gh',
        githubRun({ kind: 'intermediate', status: 'queued' }),
      ).status,
    ).toBe('running');
  });
});

describe('githubPullRequestBackgroundTrayRun', () => {
  function pr(
    overrides: Partial<GitHubPullRequestRowData> = {},
  ): GitHubPullRequestRowData {
    return {
      repository: 'acme/api',
      number: 12,
      title: 'Fix checkout',
      state: 'open',
      baseRefName: 'develop',
      queue: null,
      ...overrides,
    };
  }

  it('lists an open pull request as live, into its base', () => {
    expect(githubPullRequestBackgroundTrayRun('pr', pr())).toEqual({
      id: 'pr',
      kind: 'github-pr',
      name: '#12 Fix checkout',
      status: 'running',
      statusLabel: 'Open',
      pullRequestState: 'open',
      startedAt: null,
      dag: null,
      question: null,
      repository: 'acme/api',
      note: 'into develop',
    });
  });

  it('names its merge queue position while queued', () => {
    const run = githubPullRequestBackgroundTrayRun(
      'pr',
      pr({ queue: { position: 2 } }),
    );
    expect(run.statusLabel).toBe('In merge queue');
    expect(run.pullRequestState).toBe('merge-queue');
    expect(run.note).toBe('into develop · position 2 in the merge queue');
    expect(
      githubPullRequestBackgroundTrayRun(
        'pr',
        pr({ queue: { position: null } }),
      ).note,
    ).toBe('into develop · in the merge queue');
  });

  it('finishes merged or closed, and takes its number alone without a title', () => {
    expect(
      githubPullRequestBackgroundTrayRun('pr', pr({ state: 'merged' })),
    ).toMatchObject({
      status: 'succeeded',
      statusLabel: 'Merged',
      pullRequestState: 'merged',
    });
    expect(
      githubPullRequestBackgroundTrayRun('pr', pr({ state: 'closed' })),
    ).toMatchObject({
      status: 'cancelled',
      statusLabel: 'Closed',
      pullRequestState: 'closed',
    });
    expect(
      githubPullRequestBackgroundTrayRun('pr', pr({ title: undefined })).name,
    ).toBe('#12');
  });
});
