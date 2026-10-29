import {
  GITHUB_WORKFLOW_JOB_CONCLUSIONS,
  GITHUB_WORKFLOW_RUN_CONCLUSIONS,
  GITHUB_WORKFLOW_RUN_INTERMEDIATE_STATUSES,
  type AppAdvisorWatcherSummary,
  type AppAdvisorWatcherTarget,
  type GitHubWorkflowRunConclusion,
  type GitHubWorkflowJobConclusion,
  type GitHubWorkflowRunIntermediateStatus,
} from '@canopy/desktop-shared/types';
import {
  formatGitHubRunSampleLabel,
  githubRunSampleOverflow,
  githubWatcherTargetDisplay,
  liveWatcherDestinationTitle,
  localWatcherProgressLabel,
  triggerTitle,
  watcherDestinationDisplay,
  watcherOwnerDelegateDisplay,
  watcherStatusLabelWithFailure,
  watcherTargetDisplay,
  watcherTitleReplayClass,
} from '@/components/watchers/watcherDisplay';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';

function githubTarget(args: {
  runCount: number;
  repoCount: number;
  sampleCount?: number;
  statuses?: GitHubWorkflowRunIntermediateStatus[];
  conclusions?: GitHubWorkflowRunConclusion[];
  jobConclusions?: GitHubWorkflowJobConclusion[];
}): Extract<AppAdvisorWatcherTarget, { kind: 'github_workflow_runs' }> {
  const repos = Array.from(
    { length: args.repoCount },
    (_, index) => `acme/repo-${index + 1}`,
  );
  const items = Array.from({ length: args.runCount }, (_, index) => ({
    kind: 'workflow_run' as const,
    repository: repos[index % args.repoCount],
    runId: String(index + 1),
  }));
  const sampleCount = args.sampleCount ?? Math.min(5, args.runCount);
  const sample = items.slice(0, sampleCount).map((item, index) => ({
    repository: item.repository,
    runId: item.runId,
    runAttempt: 1,
    workflowName: `Workflow ${index + 1}`,
    runNumber: (index + 1) * 10,
  }));
  return {
    kind: 'github_workflow_runs',
    items,
    notifyOn: {
      statuses: args.statuses ?? [],
      conclusions: args.conclusions ?? ['failure', 'success'],
      jobConclusions: args.jobConclusions ?? [],
    },
    display: { repositories: repos, sample },
  };
}

describe('watcherDisplay.triggerTitle', () => {
  it('resolves the GitHub trigger title from the static fallback', () => {
    expect(triggerTitle('github_workflow_runs_changed')).toBe(
      'GitHub workflow runs changed',
    );
  });

  it('uses the delegate completion category title', () => {
    expect(triggerTitle('managed_delegation_completion')).toBe(
      'Delegate completion',
    );
  });
});

describe('watcherDisplay managed delegation', () => {
  it('shows mode, target count, deadline, and nested recipient without raw ids', () => {
    const display = watcherTargetDisplay({
      kind: 'managed_delegation',
      projectId: 'project',
      worktreeId: 'worktree',
      mode: 'all',
      deadlineAt: Date.parse('2026-09-21T12:00:00.000Z'),
      targetCount: 2,
      recipient: 'delegate',
      outcome: 'timeout',
    });
    expect(display.title).toBe('Delegate watch timed out');
    expect(display.subtitle).toBe('All delegates · 2 delegates');
    expect(display.details).toEqual(
      expect.arrayContaining([
        { label: 'Mode', value: 'All delegates' },
        { label: 'Targets', value: '2 delegates' },
        { label: 'Recipient', value: 'Parent delegate' },
      ]),
    );
    expect(JSON.stringify(display)).not.toContain('project');
    expect(JSON.stringify(display)).not.toContain('worktree');
  });
});

describe('watcherDisplay.watcherStatusLabelWithFailure', () => {
  it('maps failureKind to the GitHub-specific status labels', () => {
    expect(watcherStatusLabelWithFailure('delivery_failed', 'delivery')).toBe(
      'Delivery failed',
    );
    expect(watcherStatusLabelWithFailure('delivery_failed', 'source')).toBe(
      'Source unavailable',
    );
  });

  it('falls back to the plain status label when no failureKind is present', () => {
    expect(watcherStatusLabelWithFailure('active')).toBe('Active');
    expect(watcherStatusLabelWithFailure('delivery_failed')).toBe(
      'Delivery failed',
    );
  });
});

describe('watcherDisplay.localWatcherProgressLabel', () => {
  const watcher: AppAdvisorWatcherSummary = {
    id: 'local-watcher',
    trigger: 'command_watch_resolved',
    status: 'fired',
    label: 'Command watcher',
    target: {
      kind: 'command_watch',
      command: 'printf ready',
      cwd: '/tmp',
      intervalSeconds: 5,
      maxAttempts: 2,
    },
    destination: {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
    },
    createdAt: '2026-09-07T00:00:00.000Z',
    localProgress: {
      attempts: 2,
      nextAttemptAt: '2026-09-07T00:00:00.000Z',
      outcome: 'failure',
      reason: 'execution_scope_unavailable',
    },
  };

  it('humanizes known watcher outcome reasons', () => {
    expect(localWatcherProgressLabel(watcher)).toBe(
      'Failed · Worktree no longer available',
    );
    expect(
      localWatcherProgressLabel({
        ...watcher,
        localProgress: {
          ...watcher.localProgress,
          attempts: 1,
          nextAttemptAt: '2026-09-07T00:00:00.000Z',
          outcome: 'failure',
          reason: 'capture_error: private runtime detail',
        },
      }),
    ).toBe('Failed · Could not capture command output');
  });

  it('uses a safe fallback instead of exposing unknown internal tokens', () => {
    expect(
      localWatcherProgressLabel({
        ...watcher,
        localProgress: {
          ...watcher.localProgress,
          attempts: 1,
          nextAttemptAt: '2026-09-07T00:00:00.000Z',
          outcome: 'failure',
          reason: 'future_internal_reason',
        },
      }),
    ).toBe('Failed · Command did not complete');
  });
});

describe('watcherDisplay.githubWatcherTargetDisplay', () => {
  it('returns null for non-GitHub targets', () => {
    expect(
      githubWatcherTargetDisplay({
        kind: 'worktree_chat',
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'c',
      }),
    ).toBeNull();
  });

  it('renders the one-run subtitle', () => {
    const display = githubWatcherTargetDisplay(
      githubTarget({ runCount: 1, repoCount: 1 }),
    );
    expect(display?.subtitle).toBe('1 workflow run in acme/repo-1');
    expect(display?.totalCount).toBe(1);
    expect(display?.repositoryCount).toBe(1);
  });

  it('renders the multi-run single-repository subtitle', () => {
    const display = githubWatcherTargetDisplay(
      githubTarget({ runCount: 3, repoCount: 1 }),
    );
    expect(display?.subtitle).toBe('3 workflow runs in acme/repo-1');
  });

  it('renders the multi-repository subtitle', () => {
    const display = githubWatcherTargetDisplay(
      githubTarget({ runCount: 20, repoCount: 2 }),
    );
    expect(display?.subtitle).toBe('20 workflow runs in 2 repositories');
  });

  it('caps the sample at five entries regardless of the run count', () => {
    const display = githubWatcherTargetDisplay(
      githubTarget({ runCount: 20, repoCount: 2, sampleCount: 5 }),
    );
    if (!display) throw new Error('expected a GitHub target display');
    expect(display.sample).toHaveLength(5);
    expect(githubRunSampleOverflow(display, 5)).toBe(15);
    expect(githubRunSampleOverflow(display, 3)).toBe(17);
  });

  it('does not overflow when the run count fits the shown sample', () => {
    const display = githubWatcherTargetDisplay(
      githubTarget({ runCount: 3, repoCount: 1 }),
    );
    if (!display) throw new Error('expected a GitHub target display');
    expect(display.sample).toHaveLength(3);
    expect(githubRunSampleOverflow(display, 3)).toBe(0);
  });

  it('renders `any` when the whole enum is selected and explicit values otherwise', () => {
    const anyDisplay = githubWatcherTargetDisplay(
      githubTarget({
        runCount: 2,
        repoCount: 1,
        statuses: [...GITHUB_WORKFLOW_RUN_INTERMEDIATE_STATUSES],
        conclusions: [...GITHUB_WORKFLOW_RUN_CONCLUSIONS],
      }),
    );
    expect(anyDisplay?.filters).toEqual([
      { label: 'Intermediate', value: 'any' },
      { label: 'Terminal', value: 'any' },
    ]);

    const explicitDisplay = githubWatcherTargetDisplay(
      githubTarget({
        runCount: 2,
        repoCount: 1,
        statuses: ['in_progress', 'waiting'],
        conclusions: ['failure', 'success'],
      }),
    );
    expect(explicitDisplay?.filters).toEqual([
      { label: 'Intermediate', value: 'in_progress, waiting' },
      { label: 'Terminal', value: 'failure, success' },
    ]);
  });

  it('omits a notify category that is not selected', () => {
    const display = githubWatcherTargetDisplay(
      githubTarget({
        runCount: 2,
        repoCount: 1,
        statuses: [],
        conclusions: ['failure'],
      }),
    );
    expect(display?.filters).toEqual([{ label: 'Terminal', value: 'failure' }]);
  });

  it('renders completed-job selections separately from whole-run filters', () => {
    const display = githubWatcherTargetDisplay(
      githubTarget({
        runCount: 1,
        repoCount: 1,
        statuses: [],
        conclusions: [],
        jobConclusions: [...GITHUB_WORKFLOW_JOB_CONCLUSIONS],
      }),
    );
    expect(display?.filters).toEqual([
      { label: 'Jobs completed', value: 'any' },
    ]);
  });
});

describe('watcherDisplay.formatGitHubRunSampleLabel', () => {
  it('prefers workflow name + run number', () => {
    expect(
      formatGitHubRunSampleLabel({
        repository: 'acme/api',
        runId: '9',
        runAttempt: 1,
        workflowName: 'Build',
        runNumber: 42,
      }),
    ).toBe('Build #42 · acme/api');
  });

  it('falls back to the run id when name/number are missing', () => {
    expect(
      formatGitHubRunSampleLabel({
        repository: 'acme/api',
        runId: '9',
        runAttempt: 1,
      }),
    ).toBe('Run #9 · acme/api');
  });

  it('shows rerun and explicitly selected attempts', () => {
    expect(
      formatGitHubRunSampleLabel({
        repository: 'acme/api',
        runId: '9',
        runAttempt: 2,
      }),
    ).toBe('Run #9 · acme/api · attempt 2');
    expect(
      formatGitHubRunSampleLabel({
        repository: 'acme/api',
        runId: '9',
        runAttempt: 1,
        requestedAttempt: 1,
      }),
    ).toBe('Run #9 · acme/api · attempt 1');
  });
});

describe('watcherDisplay.watcherTargetDisplay', () => {
  it('renders the GitHub target through the shared display shape', () => {
    const display = watcherTargetDisplay(
      githubTarget({
        runCount: 20,
        repoCount: 2,
        conclusions: ['failure', 'success'],
      }),
    );
    expect(display.title).toBe('GitHub workflow runs');
    expect(display.subtitle).toBe('20 workflow runs in 2 repositories');
    expect(display.details).toEqual([
      { label: 'Terminal', value: 'failure, success' },
    ]);
  });

  it('renders the automation target with its captured name', () => {
    const display = watcherTargetDisplay({
      kind: 'automation',
      automationId: 'auto-1',
      automationName: 'Nightly triage',
    });
    expect(display.title).toBe('Nightly triage');
    expect(display.subtitle).toBe('Automation run');
    expect(display.details).toEqual(
      expect.arrayContaining([
        { label: 'Automation', value: 'Nightly triage' },
        { label: 'Automation id', value: 'auto-1' },
      ]),
    );
  });

  it('falls back to the automation id when no name was captured', () => {
    const display = watcherTargetDisplay({
      kind: 'automation',
      automationId: 'auto-1',
    });
    expect(display.title).toBe('auto-1');
  });
});

describe('watcherDisplay.watcherTitleReplayClass', () => {
  it('blocks a command watcher title, which is its shell command', () => {
    expect(
      watcherTitleReplayClass({
        kind: 'command_watch',
        command: 'curl -H "Authorization: Bearer token" https://example.com',
        cwd: '/tmp',
        intervalSeconds: 5,
        maxAttempts: 2,
      }),
    ).toBe(POSTHOG_REPLAY_BLOCK_CLASS);
  });

  it('records other watcher titles', () => {
    expect(
      watcherTitleReplayClass(githubTarget({ runCount: 1, repoCount: 1 })),
    ).toBe('');
  });
});

describe('watcherDisplay pull request watchers', () => {
  function pullRequestTarget(
    numbers: number[],
  ): Extract<AppAdvisorWatcherTarget, { kind: 'github_pull_requests' }> {
    return {
      kind: 'github_pull_requests',
      items: numbers.map((number) => ({
        kind: 'pull_request',
        repository: 'acme/api',
        number,
      })),
      display: {
        repositories: ['acme/api'],
        sample: [{ repository: 'acme/api', number: 42, title: 'Add search' }],
      },
    };
  }

  it('titles the trigger from the shared catalog', () => {
    expect(triggerTitle('github_pull_requests_changed')).toBe(
      'GitHub pull request merged, closed, or removed from the merge queue',
    );
  });

  it('renders one pull request by reference and title', () => {
    expect(watcherTargetDisplay(pullRequestTarget([42]))).toEqual({
      title: 'acme/api#42',
      subtitle: 'Add search',
      details: [
        {
          label: 'Notifies on',
          value:
            'Merged, closed without merging, or removed from the merge queue',
        },
      ],
    });
  });

  it('lists selected merge queue notifications', () => {
    const target = pullRequestTarget([42]);
    target.notifyOn = {
      queueEntered: true,
      queuePhases: ['awaiting_checks', 'unmergeable'],
    };
    const display = watcherTargetDisplay(target);
    expect(display.subtitle).toBe(
      'Add search · also queue entry, awaiting checks, unmergeable',
    );
    expect(display.details).toEqual([
      {
        label: 'Notifies on',
        value:
          'Merged, closed without merging, or removed from the merge queue',
      },
      { label: 'Queue entry', value: 'Entered or re-entered' },
      { label: 'Queue phases', value: 'awaiting checks, unmergeable' },
    ]);
  });

  it('shows any queue phase when every phase is selected', () => {
    const target = pullRequestTarget([42]);
    target.notifyOn = {
      queueEntered: false,
      queuePhases: [
        'queued',
        'awaiting_checks',
        'mergeable',
        'locked',
        'unmergeable',
      ],
    };
    const display = watcherTargetDisplay(target);
    expect(display.subtitle).toBe('Add search · also any queue phase');
    expect(display.details).toEqual([
      {
        label: 'Notifies on',
        value:
          'Merged, closed without merging, or removed from the merge queue',
      },
      { label: 'Queue phases', value: 'any' },
    ]);
  });

  it('appends selected queue options to the default subtitle without a title', () => {
    const target = pullRequestTarget([7]);
    target.notifyOn = { queueEntered: false, queuePhases: ['unmergeable'] };
    expect(watcherTargetDisplay(target).subtitle).toBe(
      'Merged, closed, or removed from the queue · also unmergeable',
    );
  });

  it('appends selected queue options to the grouped subtitle', () => {
    const target = pullRequestTarget([1, 2]);
    target.notifyOn = { queueEntered: true, queuePhases: [] };
    expect(watcherTargetDisplay(target).subtitle).toBe(
      'in acme/api · merged, closed, or removed from the queue · also queue entry',
    );
  });

  it('renders grouped pull requests with a bounded list', () => {
    const display = watcherTargetDisplay(
      pullRequestTarget([1, 2, 3, 4, 5, 6, 7]),
    );
    expect(display.title).toBe('7 pull requests');
    expect(display.subtitle).toBe(
      'in acme/api · merged, closed, or removed from the queue',
    );
    expect(display.details).toContainEqual({
      label: 'Pull requests',
      value:
        'acme/api#1, acme/api#2, acme/api#3, acme/api#4, acme/api#5 +2 more',
    });
  });

  it('names the repository count for grouped pull requests across repositories', () => {
    const target = pullRequestTarget([1, 2]);
    target.items[1] = {
      kind: 'pull_request',
      repository: 'acme/web',
      number: 2,
    };
    target.display.repositories = ['acme/api', 'acme/web'];
    expect(watcherTargetDisplay(target).subtitle).toBe(
      'in 2 repositories · merged, closed, or removed from the queue',
    );
  });
});

describe('watcherDisplay.triggerTitle (automation_run)', () => {
  it('resolves the automation trigger title from the shared catalog', () => {
    expect(triggerTitle('automation_run')).toBe('Automation run completion');
  });
});

describe('watcher subscriber and owner labels', () => {
  const destination = {
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    chatId: 'chat-1',
  };

  it('prefers the live tab title, then the recorded one', () => {
    const worktreeChats = {
      'project-1/worktree-1': {
        tabs: [
          { id: 'other', title: 'Other' },
          { id: 'chat-1', title: '  Renamed chat ' },
        ],
      },
    };
    const live = liveWatcherDestinationTitle(worktreeChats, destination);
    expect(live).toBe('Renamed chat');
    expect(
      watcherDestinationDisplay(
        { ...destination, chatTitle: 'Old title' },
        live,
      ),
    ).toBe('Renamed chat');
    expect(
      watcherDestinationDisplay(
        { ...destination, chatTitle: 'Old title' },
        liveWatcherDestinationTitle({}, destination),
      ),
    ).toBe('Old title');
    expect(watcherDestinationDisplay(destination)).toBe('Untitled chat');
  });

  it('names the owning delegate and its depth', () => {
    expect(
      watcherOwnerDelegateDisplay({
        delegationId: 'delegate-1',
        description: 'Review auth flow',
        depth: 2,
      }),
    ).toEqual({ name: 'Review auth flow', detail: 'depth 2' });
    expect(watcherOwnerDelegateDisplay({ delegationId: 'delegate-1' })).toEqual(
      { name: 'Unnamed delegate' },
    );
  });
});
