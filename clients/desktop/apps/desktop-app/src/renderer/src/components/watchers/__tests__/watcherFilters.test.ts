import {
  visibleWatchers,
  watchersForChatDestination,
  watchersForHook,
  watchersForPipelineExecution,
  watchersForSubscriberDestination,
} from '@/components/watchers/watcherFilters';
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  type AppAdvisorWatcherSummary,
} from '@canopy/desktop-shared/types';

function pipelineWatcher(
  overrides: Partial<AppAdvisorWatcherSummary> & {
    target: Extract<
      AppAdvisorWatcherSummary['target'],
      { kind: 'worktree_pipeline' }
    >;
  },
): AppAdvisorWatcherSummary {
  const watcherOverrides: Partial<AppAdvisorWatcherSummary> = { ...overrides };
  delete watcherOverrides.target;
  return {
    id: overrides.id ?? `watcher-${Math.random().toString(36).slice(2)}`,
    trigger: 'worktree_pipeline_completion',
    status: 'active',
    label: 'Pipeline watcher',
    target: overrides.target,
    destination: {
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: APP_ADVISOR_WORKTREE_ID,
      chatId: 'advisor-chat',
    },
    createdAt: new Date('2026-01-01T00:00:00Z').toISOString(),
    ...watcherOverrides,
  };
}

function chatWatcher(
  overrides: Partial<AppAdvisorWatcherSummary> & {
    target: Extract<
      AppAdvisorWatcherSummary['target'],
      { kind: 'worktree_chat' | 'standalone_chat' }
    >;
  },
): AppAdvisorWatcherSummary {
  const watcherOverrides: Partial<AppAdvisorWatcherSummary> = { ...overrides };
  delete watcherOverrides.target;
  return {
    id: overrides.id ?? `watcher-${Math.random().toString(36).slice(2)}`,
    trigger:
      overrides.trigger ??
      (overrides.target.kind === 'worktree_chat'
        ? 'worktree_chat_completion'
        : 'standalone_chat_completion'),
    status: 'active',
    label: 'Chat watcher',
    target: overrides.target,
    destination: {
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: APP_ADVISOR_WORKTREE_ID,
      chatId: 'advisor-chat',
    },
    createdAt: new Date('2026-01-01T00:00:00Z').toISOString(),
    ...watcherOverrides,
  };
}

function hookWatcher(
  overrides: Partial<AppAdvisorWatcherSummary> & {
    target: Extract<
      AppAdvisorWatcherSummary['target'],
      { kind: 'worktree_hook' }
    >;
  },
): AppAdvisorWatcherSummary {
  const watcherOverrides: Partial<AppAdvisorWatcherSummary> = { ...overrides };
  delete watcherOverrides.target;
  return {
    id: overrides.id ?? `watcher-${Math.random().toString(36).slice(2)}`,
    trigger: 'worktree_hook_triggered',
    status: 'active',
    label: 'Hook watcher',
    target: overrides.target,
    destination: {
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: APP_ADVISOR_WORKTREE_ID,
      chatId: 'advisor-chat',
    },
    createdAt: new Date('2026-01-01T00:00:00Z').toISOString(),
    ...watcherOverrides,
  };
}

describe('watcherFilters.visibleWatchers', () => {
  it('keeps only active and delivery_failed watchers', () => {
    const watchers: AppAdvisorWatcherSummary[] = [
      pipelineWatcher({
        id: 'a',
        status: 'active',
        target: { kind: 'worktree_pipeline', projectId: 'p', worktreeId: 'w' },
      }),
      pipelineWatcher({
        id: 'b',
        status: 'delivery_failed',
        target: { kind: 'worktree_pipeline', projectId: 'p', worktreeId: 'w' },
      }),
      pipelineWatcher({
        id: 'c',
        status: 'firing',
        target: { kind: 'worktree_pipeline', projectId: 'p', worktreeId: 'w' },
      }),
      pipelineWatcher({
        id: 'd',
        status: 'fired',
        target: { kind: 'worktree_pipeline', projectId: 'p', worktreeId: 'w' },
      }),
    ];
    expect(visibleWatchers(watchers).map((w) => w.id)).toEqual(['a', 'b']);
  });
});

describe('watcherFilters.watchersForPipelineExecution', () => {
  const exactExecution = pipelineWatcher({
    id: 'exact',
    target: {
      kind: 'worktree_pipeline',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      executionId: 'exec-42',
      pipelineId: 'pipeline-A',
    },
  });
  const pipelineScoped = pipelineWatcher({
    id: 'pipeline',
    target: {
      kind: 'worktree_pipeline',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      pipelineId: 'pipeline-A',
    },
  });
  const worktreeWide = pipelineWatcher({
    id: 'worktree',
    target: {
      kind: 'worktree_pipeline',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
    },
  });
  const wrongProject = pipelineWatcher({
    id: 'wrong-project',
    target: {
      kind: 'worktree_pipeline',
      projectId: 'project-2',
      worktreeId: 'worktree-1',
    },
  });
  const wrongTrigger: AppAdvisorWatcherSummary = {
    ...pipelineScoped,
    id: 'wrong-trigger',
    trigger: 'worktree_chat_completion',
  };

  const watchers = [
    exactExecution,
    pipelineScoped,
    worktreeWide,
    wrongProject,
    wrongTrigger,
  ];

  it('matches the exact execution-pinned watcher', () => {
    const result = watchersForPipelineExecution(watchers, {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      executionId: 'exec-42',
      pipelineId: 'pipeline-A',
    });
    expect(result.map((w) => w.id).sort()).toEqual(
      ['exact', 'pipeline', 'worktree'].sort(),
    );
  });

  it('matches the pipeline-id scope for any execution of the pipeline', () => {
    const result = watchersForPipelineExecution(watchers, {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      executionId: 'exec-other',
      pipelineId: 'pipeline-A',
    });
    expect(result.map((w) => w.id).sort()).toEqual(
      ['pipeline', 'worktree'].sort(),
    );
  });

  it('omits exact-execution watchers when the row is a different execution', () => {
    const result = watchersForPipelineExecution(watchers, {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      executionId: 'exec-other',
      pipelineId: 'pipeline-A',
    });
    expect(result.map((w) => w.id)).not.toContain('exact');
  });

  it('skips wrong-project watchers', () => {
    const result = watchersForPipelineExecution(watchers, {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      executionId: 'exec-42',
    });
    expect(result.map((w) => w.id)).not.toContain('wrong-project');
  });

  it('skips non-pipeline triggers', () => {
    const result = watchersForPipelineExecution(watchers, {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      executionId: 'exec-42',
    });
    expect(result.map((w) => w.id)).not.toContain('wrong-trigger');
  });
});

describe('watcherFilters.watchersForHook', () => {
  const worktreeWide = hookWatcher({
    id: 'worktree-wide',
    target: {
      kind: 'worktree_hook',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      triggerName: 'worktree:precommit:failure',
    },
  });
  const projectScoped = hookWatcher({
    id: 'project-scoped',
    target: {
      kind: 'worktree_hook',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      triggerName: 'worktree:precommit:failure',
      scope: 'project',
    },
  });
  const repoScoped = hookWatcher({
    id: 'repo-scoped',
    target: {
      kind: 'worktree_hook',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      triggerName: 'worktree:precommit:failure',
      scope: 'workspace-repo',
      repoId: 'repo-1',
    },
  });

  it('requires hook metadata for watcher scope and repo constraints', () => {
    expect(
      watchersForHook([worktreeWide, projectScoped, repoScoped], {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      }).map((w) => w.id),
    ).toEqual(['worktree-wide']);

    expect(
      watchersForHook([worktreeWide, projectScoped, repoScoped], {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        scope: 'workspace-repo',
      }).map((w) => w.id),
    ).toEqual(['worktree-wide']);

    expect(
      watchersForHook([worktreeWide, projectScoped, repoScoped], {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        scope: 'workspace-repo',
        repoId: 'repo-1',
      }).map((w) => w.id),
    ).toEqual(['worktree-wide', 'repo-scoped']);
  });
});

describe('watcherFilters.watchersForChatDestination', () => {
  it('matches worktree chat watchers by target, not destination', () => {
    const match = chatWatcher({
      id: 'match',
      target: {
        kind: 'worktree_chat',
        projectId: 'p1',
        worktreeId: 'w1',
        chatId: 'c1',
      },
    });
    const other = chatWatcher({
      id: 'other',
      target: {
        kind: 'worktree_chat',
        projectId: 'p1',
        worktreeId: 'w1',
        chatId: 'c2',
      },
    });
    const result = watchersForChatDestination([match, other], {
      projectId: 'p1',
      worktreeId: 'w1',
      chatId: 'c1',
    });
    expect(result.map((w) => w.id)).toEqual(['match']);
  });

  it('respects the visible-status filter for chat watchers', () => {
    const fired = chatWatcher({
      id: 'fired',
      status: 'fired',
      target: {
        kind: 'worktree_chat',
        projectId: 'p1',
        worktreeId: 'w1',
        chatId: 'c1',
      },
    });
    const active = chatWatcher({
      id: 'active',
      target: {
        kind: 'worktree_chat',
        projectId: 'p1',
        worktreeId: 'w1',
        chatId: 'c1',
      },
    });
    const result = watchersForChatDestination([fired, active], {
      projectId: 'p1',
      worktreeId: 'w1',
      chatId: 'c1',
    });
    expect(result.map((w) => w.id)).toEqual(['active']);
  });
});

function githubWatcher(
  overrides: Partial<AppAdvisorWatcherSummary> & {
    destination: AppAdvisorWatcherSummary['destination'];
  },
): AppAdvisorWatcherSummary {
  const target: AppAdvisorWatcherSummary['target'] = {
    kind: 'github_workflow_runs',
    items: [{ kind: 'workflow_run', repository: 'acme/api', runId: '1' }],
    notifyOn: {
      statuses: [],
      conclusions: ['failure', 'success'],
      jobConclusions: [],
    },
    display: {
      repositories: ['acme/api'],
      sample: [{ repository: 'acme/api', runId: '1', runAttempt: 1 }],
    },
  };
  const watcherOverrides: Partial<AppAdvisorWatcherSummary> = { ...overrides };
  delete watcherOverrides.destination;
  return {
    id: overrides.id ?? `watcher-${Math.random().toString(36).slice(2)}`,
    trigger: 'github_workflow_runs_changed',
    status: overrides.status ?? 'active',
    label: 'GitHub watcher',
    target,
    destination: overrides.destination,
    createdAt: new Date('2026-01-01T00:00:00Z').toISOString(),
    ...watcherOverrides,
  };
}

describe('watcherFilters.watchersForSubscriberDestination', () => {
  it('includes grouped GitHub watchers by subscriber destination without special-casing', () => {
    const destination = {
      projectId: 'subscriber-project',
      worktreeId: 'subscriber-worktree',
      chatId: 'subscriber-chat',
    };
    const matching = githubWatcher({ id: 'github-match', destination });
    const otherDestination = githubWatcher({
      id: 'github-other',
      destination: {
        projectId: 'elsewhere',
        worktreeId: 'elsewhere',
        chatId: 'elsewhere',
      },
    });
    const firedGithub = githubWatcher({
      id: 'github-fired',
      status: 'fired',
      destination,
    });

    const result = watchersForSubscriberDestination(
      [matching, otherDestination, firedGithub],
      destination,
    );

    expect(result.map((watcher) => watcher.id)).toEqual(['github-match']);
  });

  it('matches the subscribing destination chat across watcher target types', () => {
    const worktreeChatWatcher = chatWatcher({
      id: 'worktree-chat-target',
      target: {
        kind: 'worktree_chat',
        projectId: 'watched-project',
        worktreeId: 'watched-worktree',
        chatId: 'watched-chat',
      },
      destination: {
        projectId: 'subscriber-project',
        worktreeId: 'subscriber-worktree',
        chatId: 'subscriber-chat',
      },
    });
    const pipelineWatcherForSameDestination = pipelineWatcher({
      id: 'pipeline-target',
      target: {
        kind: 'worktree_pipeline',
        projectId: 'watched-project',
        worktreeId: 'watched-worktree',
        pipelineId: 'pipeline-1',
      },
      destination: {
        projectId: 'subscriber-project',
        worktreeId: 'subscriber-worktree',
        chatId: 'subscriber-chat',
      },
    });
    const targetOnly = chatWatcher({
      id: 'target-only',
      target: {
        kind: 'worktree_chat',
        projectId: 'subscriber-project',
        worktreeId: 'subscriber-worktree',
        chatId: 'subscriber-chat',
      },
      destination: {
        projectId: 'elsewhere',
        worktreeId: 'elsewhere',
        chatId: 'elsewhere',
      },
    });

    const result = watchersForSubscriberDestination(
      [worktreeChatWatcher, pipelineWatcherForSameDestination, targetOnly],
      {
        projectId: 'subscriber-project',
        worktreeId: 'subscriber-worktree',
        chatId: 'subscriber-chat',
      },
    );

    expect(result.map((watcher) => watcher.id)).toEqual([
      'worktree-chat-target',
      'pipeline-target',
    ]);
  });

  it('respects the visible-status filter for subscriber destinations', () => {
    const destination = {
      projectId: 'subscriber-project',
      worktreeId: 'subscriber-worktree',
      chatId: 'subscriber-chat',
    };
    const fired = chatWatcher({
      id: 'fired',
      status: 'fired',
      target: {
        kind: 'worktree_chat',
        projectId: 'p1',
        worktreeId: 'w1',
        chatId: 'c1',
      },
      destination,
    });
    const active = chatWatcher({
      id: 'active',
      target: {
        kind: 'worktree_chat',
        projectId: 'p1',
        worktreeId: 'w1',
        chatId: 'c1',
      },
      destination,
    });

    const result = watchersForSubscriberDestination(
      [fired, active],
      destination,
    );

    expect(result.map((watcher) => watcher.id)).toEqual(['active']);
  });
});

describe('automation_run watchers across the filters', () => {
  function automationWatcher(): AppAdvisorWatcherSummary {
    return {
      id: 'automation-watcher',
      trigger: 'automation_run',
      status: 'active',
      label: 'Automation watcher',
      target: {
        kind: 'automation',
        automationId: 'auto-1',
        automationName: 'Nightly triage',
      },
      destination: {
        projectId: 'p1',
        worktreeId: 'w1',
        chatId: 'subscriber-chat',
      },
      createdAt: new Date('2026-01-01T00:00:00Z').toISOString(),
    };
  }

  it('never lights pipeline, hook, or chat surfaces', () => {
    const watchers = [automationWatcher()];
    expect(
      watchersForPipelineExecution(watchers, {
        projectId: 'p1',
        worktreeId: 'w1',
        executionId: 'exec-1',
      }),
    ).toEqual([]);
    expect(
      watchersForHook(watchers, { projectId: 'p1', worktreeId: 'w1' }),
    ).toEqual([]);
    expect(
      watchersForChatDestination(watchers, {
        projectId: 'p1',
        worktreeId: 'w1',
        chatId: 'subscriber-chat',
      }),
    ).toEqual([]);
  });

  it('is listed for its subscribing chat destination', () => {
    const result = watchersForSubscriberDestination([automationWatcher()], {
      projectId: 'p1',
      worktreeId: 'w1',
      chatId: 'subscriber-chat',
    });
    expect(result.map((watcher) => watcher.id)).toEqual(['automation-watcher']);
  });
});
