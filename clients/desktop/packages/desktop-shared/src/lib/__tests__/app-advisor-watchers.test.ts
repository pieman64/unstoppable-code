import type { CanonicalChatWatcherSetupResult } from '../chat-watcher-contracts';
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  type AppAdvisorWatcherSummary,
  type AppAdvisorWatcherTriggerType,
} from '../../types';
import {
  APP_ADVISOR_WATCHER_CATALOG,
  describeWatcherFiredKind,
  HOOK_TRIGGER_CATALOG,
  rankHookTriggers,
  githubPullRequestWatcherEventKinds,
  isPersistedGitHubPullRequestTarget,
  normalizeWatchGitHubItemsFamilyRequest,
  normalizeWatchGitHubItemsInput,
  normalizeWatchGitHubItemsRequest,
  searchAppAdvisorWatchers,
  projectSetupWatchersResultForProvider,
  pageActiveWatchers,
  watcherSearchTarget,
} from '../app-advisor-watchers';

const EXPECTED_TARGET_KINDS: Record<
  AppAdvisorWatcherTriggerType,
  | 'project_task_chat'
  | 'project_chat_scope'
  | 'bot_task_chat'
  | 'bot_chat_scope'
  | 'worktree_chat'
  | 'standalone_chat'
  | 'worktree_chat_scope'
  | 'standalone_chat_project'
  | 'worktree_pipeline'
  | 'worktree_hook'
  | 'automation'
  | 'managed_delegation'
  | 'github_workflow_runs'
  | 'github_pull_requests'
  | 'scheduled_wakeup'
  | 'command_watch'
> = {
  project_task_chat_completion: 'project_task_chat',
  project_new_chat_started: 'project_chat_scope',
  bot_task_chat_completion: 'bot_task_chat',
  bot_new_chat_started: 'bot_chat_scope',
  scheduled_wakeup: 'scheduled_wakeup',
  command_watch_resolved: 'command_watch',
  worktree_chat_completion: 'worktree_chat',
  standalone_chat_completion: 'standalone_chat',
  worktree_new_chat_started: 'worktree_chat_scope',
  standalone_new_chat_started: 'standalone_chat_project',
  worktree_pipeline_completion: 'worktree_pipeline',
  worktree_hook_triggered: 'worktree_hook',
  automation_run: 'automation',
  managed_delegation_completion: 'managed_delegation',
  // The GitHub workflow-run catalog entry value is populated by the backend
  // plan; the trigger→targetKind pairing is fixed here for when it lands.
  github_workflow_runs_changed: 'github_workflow_runs',
  github_pull_requests_changed: 'github_pull_requests',
};

function makeActiveWatcher(
  overrides: Partial<AppAdvisorWatcherSummary> = {},
): AppAdvisorWatcherSummary {
  return {
    id: overrides.id ?? 'watcher-1',
    trigger: overrides.trigger ?? 'worktree_chat_completion',
    status: overrides.status ?? 'active',
    label: overrides.label ?? 'Active worktree chat watcher',
    target:
      overrides.target ??
      ({
        kind: 'worktree_chat',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      } as const),
    destination:
      overrides.destination ??
      ({
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: APP_ADVISOR_WORKTREE_ID,
        chatId: 'advisor-chat-1',
      } as const),
    createdAt: overrides.createdAt ?? '2026-05-23T00:00:00.000Z',
    ...(overrides.followUpInstruction !== undefined
      ? { followUpInstruction: overrides.followUpInstruction }
      : {}),
    ...(overrides.firedAt !== undefined ? { firedAt: overrides.firedAt } : {}),
    ...(overrides.deliveryError !== undefined
      ? { deliveryError: overrides.deliveryError }
      : {}),
  };
}

describe('App Advisor watcher catalog', () => {
  it('preserves computed advisor access availability at both detail levels', () => {
    const watcher: AppAdvisorWatcherSummary = {
      ...makeActiveWatcher({
        trigger: 'automation_run',
        target: { kind: 'automation', automationId: 'advisor-automation' },
      }),
      availability: 'advisor_access_disabled',
    };
    for (const detailLevel of ['minimal', 'standard'] as const) {
      expect(
        searchAppAdvisorWatchers({ detailLevel }, [watcher]).activeWatchers,
      ).toEqual([
        expect.objectContaining({ availability: 'advisor_access_disabled' }),
      ]);
    }
    expect(
      searchAppAdvisorWatchers({}, [makeActiveWatcher()]).activeWatchers[0],
    ).not.toHaveProperty('availability');
  });

  it('contains exactly the supported watcher triggers (uniquely)', () => {
    expect(APP_ADVISOR_WATCHER_CATALOG).toHaveLength(16);

    const triggers = APP_ADVISOR_WATCHER_CATALOG.map((entry) => entry.trigger);
    expect(new Set(triggers).size).toBe(triggers.length);

    expect(triggers).toEqual(
      expect.arrayContaining([
        'worktree_chat_completion',
        'standalone_chat_completion',
        'worktree_new_chat_started',
        'standalone_new_chat_started',
        'worktree_pipeline_completion',
        'worktree_hook_triggered',
        'automation_run',
        'github_workflow_runs_changed',
        'github_pull_requests_changed',
        'managed_delegation_completion',
      ]),
    );
  });

  it('pairs each catalog entry with the matching target kind', () => {
    for (const entry of APP_ADVISOR_WATCHER_CATALOG) {
      expect(entry.targetKind).toBe(EXPECTED_TARGET_KINDS[entry.trigger]);
    }
  });

  it('marks every existing (non-GitHub) trigger as created via setup_watchers', () => {
    for (const entry of APP_ADVISOR_WATCHER_CATALOG.filter(
      (candidate) =>
        ![
          'github_workflow_runs_changed',
          'github_pull_requests_changed',
          'scheduled_wakeup',
          'command_watch_resolved',
          'managed_delegation_completion',
        ].includes(candidate.trigger),
    )) {
      expect(entry.setupTool).toBe('setup_watchers');
    }
    expect(
      APP_ADVISOR_WATCHER_CATALOG.find(
        (entry) => entry.trigger === 'github_workflow_runs_changed',
      )?.setupTool,
    ).toBe('watch_github_items');
    expect(
      APP_ADVISOR_WATCHER_CATALOG.find(
        (entry) => entry.trigger === 'github_pull_requests_changed',
      )?.setupTool,
    ).toBe('watch_github_items');
    expect(
      APP_ADVISOR_WATCHER_CATALOG.find(
        (entry) => entry.trigger === 'managed_delegation_completion',
      )?.setupTool,
    ).toBe('watch_delegates');
  });

  it('guides canonical discovery without UI state or legacy list actions', () => {
    for (const trigger of [
      'project_task_chat_completion',
      'project_new_chat_started',
      'bot_task_chat_completion',
      'bot_new_chat_started',
    ] as const) {
      const row = APP_ADVISOR_WATCHER_CATALOG.find(
        (entry) => entry.trigger === trigger,
      );
      const guidance = row?.usageGuidance ?? '';
      const prefix = trigger.startsWith('bot_') ? 'bots' : 'projects';
      const sequence = [
        'SearchActions',
        `${prefix}.list`,
        `${prefix}.list_tasks`,
        `${prefix}.list_task_chats`,
        'SearchWatchers',
        'SetupWatchers',
      ];
      let previous = -1;
      for (const step of sequence) {
        const index = guidance.indexOf(step);
        expect(index).toBeGreaterThan(previous);
        previous = index;
      }
      expect(guidance).not.toMatch(
        /get_current_ui_state|GetCurrentUiState|workspace\.list|worktree-chat\.list_tabs|standalone-chat\.list/,
      );
      expect(guidance).not.toContain('"kind"');
    }
  });

  it('retains automation discovery and dispatch-as-completion guidance', () => {
    const guidance =
      APP_ADVISOR_WATCHER_CATALOG.find(
        (row) => row.trigger === 'automation_run',
      )?.usageGuidance ?? '';
    expect(guidance).toContain('automation.list');
    expect(guidance).toContain('automation.run_now');
    expect(guidance).toContain('skipped');
    expect(guidance).toContain(
      'App Advisor prompt dispatches still fire at dispatch',
    );
    expect(guidance).toContain('bot chat completion watches are separate');
  });

  it('advertises exact canonical target and entry fields at both detail levels', () => {
    for (const detailLevel of ['minimal', 'standard'] as const) {
      const rows = searchAppAdvisorWatchers({ detailLevel }).catalog;
      for (const [
        trigger,
        targetKind,
        requiredFields,
        optionalFields,
        optionalEntryFields,
      ] of [
        [
          'project_task_chat_completion',
          'project_task_chat',
          ['projectId', 'taskId', 'chatId'],
          [],
          ['armForNextCompletion'],
        ],
        [
          'project_new_chat_started',
          'project_chat_scope',
          ['projectId'],
          ['taskId'],
          [],
        ],
        [
          'bot_task_chat_completion',
          'bot_task_chat',
          ['botId', 'taskId', 'chatId'],
          [],
          ['armForNextCompletion'],
        ],
        ['bot_new_chat_started', 'bot_chat_scope', ['botId'], ['taskId'], []],
      ] as const) {
        expect(rows.find((row) => row.trigger === trigger)).toMatchObject({
          trigger,
          targetKind,
          setupTool: 'setup_watchers',
          requiredFields,
          optionalFields,
          optionalEntryFields,
        });
      }
    }
  });

  it.each(['minimal', 'standard'] as const)(
    'retains legacy adapters but hides exact searches at %s detail',
    (detailLevel) => {
      for (const trigger of [
        'worktree_chat_completion',
        'standalone_chat_completion',
        'worktree_new_chat_started',
        'standalone_new_chat_started',
      ] as const) {
        expect(
          APP_ADVISOR_WATCHER_CATALOG.find((row) => row.trigger === trigger),
        ).toMatchObject({ hidden: true });
        expect(
          searchAppAdvisorWatchers({ trigger, detailLevel }).catalog,
        ).toEqual([]);
        expect(
          searchAppAdvisorWatchers({ query: trigger, detailLevel }).catalog.map(
            (row) => row.trigger,
          ),
        ).not.toContain(trigger);
        expect(
          searchAppAdvisorWatchers({ trigger, detailLevel }, [], {
            includeLegacyChatTriggers: true,
          }).catalog.map((row) => row.trigger),
        ).toEqual([trigger]);
      }
    },
  );

  it('filters bot rows before ranking and limiting without hiding Advisor defaults', () => {
    expect(
      searchAppAdvisorWatchers({}).catalog.filter((row) =>
        row.trigger.startsWith('bot_'),
      ),
    ).toHaveLength(2);
    const enabled = searchAppAdvisorWatchers({ query: 'bot', limit: 1 }, [], {
      botsEnabled: true,
    });
    expect(enabled.catalog[0]?.trigger.startsWith('bot_')).toBe(true);
    const disabled = searchAppAdvisorWatchers({ query: 'bot', limit: 1 }, [], {
      botsEnabled: false,
    });
    expect(disabled.catalog).toHaveLength(1);
    expect(disabled.catalog[0]?.trigger.startsWith('bot_')).toBe(false);
    for (const trigger of [
      'bot_task_chat_completion',
      'bot_new_chat_started',
    ] as const) {
      expect(
        searchAppAdvisorWatchers({ trigger, limit: 1 }, [], {
          botsEnabled: false,
        }).catalog,
      ).toEqual([]);
    }
    expect(
      searchAppAdvisorWatchers({}, [], { botsEnabled: false }).catalog,
    ).toHaveLength(10);
  });

  it('declares the expected required and optional fields per trigger', () => {
    const byTrigger = Object.fromEntries(
      APP_ADVISOR_WATCHER_CATALOG.map((entry) => [entry.trigger, entry]),
    );

    expect(byTrigger.managed_delegation_completion).toMatchObject({
      setupTool: 'watch_delegates',
      requiredFields: ['delegationIds', 'mode', 'timeoutMs'],
      optionalFields: [],
    });

    expect(byTrigger.worktree_chat_completion).toMatchObject({
      requiredFields: ['projectId', 'worktreeId', 'chatId'],
      optionalFields: [],
      optionalEntryFields: ['armForNextCompletion'],
    });
    expect(byTrigger.standalone_chat_completion).toMatchObject({
      requiredFields: ['projectId', 'chatId'],
      optionalFields: [],
      optionalEntryFields: ['armForNextCompletion'],
    });
    expect(byTrigger.worktree_chat_completion?.usageGuidance).toContain(
      '},"armForNextCompletion":true',
    );
    expect(byTrigger.worktree_new_chat_started).toMatchObject({
      requiredFields: ['projectId', 'worktreeId'],
      optionalFields: [],
    });
    expect(byTrigger.standalone_new_chat_started).toMatchObject({
      requiredFields: ['projectId'],
      optionalFields: [],
    });
    expect(byTrigger.worktree_pipeline_completion).toMatchObject({
      requiredFields: ['projectId', 'worktreeId'],
      optionalFields: ['executionId', 'pipelineId', 'terminalStatuses'],
    });
    expect(byTrigger.worktree_hook_triggered).toMatchObject({
      requiredFields: ['projectId', 'worktreeId', 'triggerName'],
      optionalFields: ['hookKey', 'scope', 'repoId'],
    });
    expect(byTrigger.automation_run).toMatchObject({
      requiredFields: ['automationId'],
      optionalFields: [],
    });
    expect(byTrigger.github_workflow_runs_changed).toMatchObject({
      requiredFields: ['items', 'notifyOn'],
      optionalFields: [
        'repository',
        'label',
        'followUpInstruction',
        'allowDuplicate',
      ],
      setupTool: 'watch_github_items',
    });
    expect(byTrigger.github_pull_requests_changed).toMatchObject({
      title:
        'GitHub pull request merged, closed, or removed from the merge queue',
      requiredFields: ['items'],
      optionalFields: [
        'repository',
        'notifyOn',
        'label',
        'followUpInstruction',
        'allowDuplicate',
      ],
      setupTool: 'watch_github_items',
    });
    const pullRequestGuidance =
      byTrigger.github_pull_requests_changed?.usageGuidance ?? '';
    expect(pullRequestGuidance).toContain(
      '{"items":[{"kind":"pull_request","target":"https://github.com/owner/repository/pull/123"}]}',
    );
    expect(pullRequestGuidance).toContain('Removal is reported by default');
    expect(pullRequestGuidance).toContain(
      '{"notifyOn":{"queue":{"entered":true,"phases":["unmergeable"]}}}',
    );
    expect(pullRequestGuidance).toContain(
      'queued, awaiting_checks, mergeable, locked, unmergeable',
    );
    expect(pullRequestGuidance).toContain(
      'Queue position changes never wake the chat',
    );
    expect(pullRequestGuidance).not.toContain('does not report merge queue');
    expect(pullRequestGuidance).toContain('gh pr view');
  });

  it('ranks the pull request entry first for a merge queue removal query', () => {
    const result = searchAppAdvisorWatchers({
      query: 'pull request removed from merge queue',
      includeActive: false,
    });
    expect(result.catalog[0]?.trigger).toBe('github_pull_requests_changed');
  });

  it('ranks the pull request entry first for a merged PR query', () => {
    const result = searchAppAdvisorWatchers({
      query: 'pull request merged',
      includeActive: false,
    });
    expect(result.catalog[0]?.trigger).toBe('github_pull_requests_changed');
  });
});

describe('searchAppAdvisorWatchers', () => {
  it('returns the full catalog with a baseline score when no query is supplied', () => {
    const result = searchAppAdvisorWatchers({});

    expect(result.catalog).toHaveLength(12);
    expect(result.activeWatchers).toEqual([]);
    for (const row of result.catalog) {
      expect(row.score).toBeGreaterThan(0);
      expect(row.setupTool).toBe(
        row.trigger === 'scheduled_wakeup'
          ? 'schedule_wakeup'
          : row.trigger === 'command_watch_resolved'
            ? 'watch_command'
            : row.trigger === 'managed_delegation_completion'
              ? 'watch_delegates'
              : row.trigger === 'github_workflow_runs_changed' ||
                  row.trigger === 'github_pull_requests_changed'
                ? 'watch_github_items'
                : 'setup_watchers',
      );
      expect(row.usageGuidance).toBeUndefined();
    }
  });

  it('matches the query against title, usageGuidance, and trigger key (case-insensitive)', () => {
    const titleResult = searchAppAdvisorWatchers({ query: 'PIPELINE' });
    expect(titleResult.catalog[0]?.trigger).toBe(
      'worktree_pipeline_completion',
    );

    const guidanceResult = searchAppAdvisorWatchers({
      query: 'project task chat',
    });
    expect(guidanceResult.catalog.map((row) => row.trigger)).toEqual(
      expect.arrayContaining(['project_task_chat_completion']),
    );

    const triggerKeyResult = searchAppAdvisorWatchers({
      query: 'project_task_chat_completion',
    });
    expect(triggerKeyResult.catalog[0]?.trigger).toBe(
      'project_task_chat_completion',
    );
  });

  it('returns ranked hook trigger names for PR comment watcher discovery', () => {
    const result = searchAppAdvisorWatchers({
      query: 'PR comments',
      detailLevel: 'standard',
    });
    const hookEntry = result.catalog.find(
      (entry) => entry.trigger === 'worktree_hook_triggered',
    );

    expect(hookEntry?.hookTriggers?.[0]).toMatchObject({
      triggerName: 'pr:update:comments',
      title: 'PR Comments Updated',
      setupTarget: { triggerName: 'pr:update:comments' },
    });
    expect(
      hookEntry?.hookTriggers?.some(
        (entry) => entry.triggerName === 'pr:reviews:new:has-comments',
      ),
    ).toBe(true);
    expect(hookEntry?.usageGuidance).toContain('hookTriggers');
  });

  it('ranks the merge queue hook triggers for queue discovery', () => {
    const top = (query: string): string | undefined =>
      rankHookTriggers(HOOK_TRIGGER_CATALOG, query)[0]?.triggerName;
    expect(top('merge queue removal')).toBe('pr:queue:removed');
    expect(top('kicked out of the queue')).toBe('pr:queue:removed');
    expect(top('pull request enqueued')).toBe('pr:queue:entered');
    expect(
      rankHookTriggers(HOOK_TRIGGER_CATALOG, 'merge queue')
        .slice(0, 2)
        .map((entry) => entry.triggerName)
        .sort(),
    ).toEqual(['pr:queue:entered', 'pr:queue:removed']);
  });

  it('filters catalog rows by the supplied trigger', () => {
    const result = searchAppAdvisorWatchers({
      trigger: 'project_task_chat_completion',
    });

    expect(result.catalog.map((row) => row.trigger)).toEqual([
      'project_task_chat_completion',
    ]);
  });

  it('returns caller-supplied active watchers when includeActive is undefined or true', () => {
    const active = [
      makeActiveWatcher({ id: 'watcher-a' }),
      makeActiveWatcher({
        id: 'watcher-b',
        trigger: 'worktree_pipeline_completion',
        target: {
          kind: 'worktree_pipeline',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
        },
      }),
    ];

    const defaultResult = searchAppAdvisorWatchers({}, active);
    expect(defaultResult.activeWatchers).toEqual([
      {
        id: 'watcher-a',
        trigger: 'worktree_chat_completion',
        status: 'active',
        label: 'Active worktree chat watcher',
        targetKind: 'worktree_chat',
      },
      {
        id: 'watcher-b',
        trigger: 'worktree_pipeline_completion',
        status: 'active',
        label: 'Active worktree chat watcher',
        targetKind: 'worktree_pipeline',
        target: { projectId: 'project-1', taskId: 'worktree-1' },
      },
    ]);

    const trueResult = searchAppAdvisorWatchers(
      { includeActive: true },
      active,
    );
    expect(trueResult.activeWatchers).toEqual(defaultResult.activeWatchers);
  });

  it('returns no active watchers when includeActive is false', () => {
    const active = [makeActiveWatcher()];

    const result = searchAppAdvisorWatchers({ includeActive: false }, active);

    expect(result.activeWatchers).toEqual([]);
  });

  it('clamps the catalog row count to the supplied limit', () => {
    const result = searchAppAdvisorWatchers({ limit: 1 });

    expect(result.catalog).toHaveLength(1);
  });
});

describe('projectSetupWatchersResultForProvider', () => {
  it('preserves available canonical projections while compacting legacy siblings', () => {
    const canonical = {
      id: 'canonical-1',
      trigger: 'project_task_chat_completion',
      status: 'active',
      target: { projectId: 'project-1', taskId: 'task-1', chatId: 'chat-1' },
      targetKind: 'project_task_chat',
      label: 'Watch task',
      createdAt: '2026-10-17T00:00:00.000Z',
    } as const;
    const result: CanonicalChatWatcherSetupResult = {
      ok: true,
      results: [
        { status: 'created', watcher: canonical },
        { status: 'deduped', watcher: makeActiveWatcher() },
      ],
    };
    expect(projectSetupWatchersResultForProvider(result)).toEqual({
      ok: true,
      results: [
        { status: 'created', watcher: canonical },
        {
          status: 'deduped',
          watcher: {
            id: 'watcher-1',
            trigger: 'worktree_chat_completion',
            status: 'active',
            label: 'Active worktree chat watcher',
            targetKind: 'worktree_chat',
          },
        },
      ],
    });
  });

  it('preserves unavailable canonical identities without assuming a target', () => {
    const result: CanonicalChatWatcherSetupResult = {
      ok: true,
      results: [
        {
          status: 'deduped',
          watcher: {
            id: 'denied-1',
            trigger: 'bot_task_chat_completion',
            availability: 'advisor_access_disabled',
          },
        },
      ],
    };
    expect(projectSetupWatchersResultForProvider(result)).toEqual(result);
  });

  it('preserves typed canonical failures and their rejected index', () => {
    const result: CanonicalChatWatcherSetupResult = {
      ok: false,
      code: 'not_found',
      error: 'Target unavailable',
      rejectedIndex: 1,
    };
    expect(projectSetupWatchersResultForProvider(result)).toEqual(result);
  });
});

describe('normalizeWatchGitHubItemsInput', () => {
  it('validates each request item before returning the typed envelope', () => {
    for (const item of [
      { kind: 'workflow_run', repository: 42, runId: '1' },
      { kind: 'workflow_run', target: '1', runId: '1' },
      { kind: 'workflow_run', target: '1', runAttempt: 0 },
      { kind: 'other', target: '1' },
    ]) {
      expect(
        normalizeWatchGitHubItemsRequest({
          items: [item],
          notifyOn: { conclusions: ['failure'] },
        }),
      ).toMatchObject({ ok: false, code: 'invalid_input', field: 'items' });
    }
  });

  it('canonicalizes repositories, run ids, item order, and any selections', () => {
    const result = normalizeWatchGitHubItemsInput({
      items: [
        { kind: 'workflow_run', repository: 'Acme/Web', runId: '20' },
        { kind: 'workflow_run', repository: 'acme/API', runId: '003' },
      ],
      notifyOn: { statuses: 'any', conclusions: ['failure', 'success'] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items).toEqual([
      { kind: 'workflow_run', repository: 'acme/api', runId: '3' },
      { kind: 'workflow_run', repository: 'acme/web', runId: '20' },
    ]);
    expect(result.value.notifyOn.statuses).toHaveLength(5);
    expect(result.value.notifyOn.conclusions).toEqual(['failure', 'success']);
    expect(result.value.notifyOn.jobConclusions).toEqual([]);
  });

  it('normalizes the explicit run and completed-job notification domains', () => {
    const result = normalizeWatchGitHubItemsInput({
      items: [{ kind: 'workflow_run', repository: 'acme/api', runId: '3' }],
      notifyOn: {
        run: { conclusions: ['failure'] },
        jobs: { conclusions: 'any' },
      },
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        notifyOn: {
          statuses: [],
          conclusions: ['failure'],
          jobConclusions: [
            'action_required',
            'cancelled',
            'failure',
            'neutral',
            'skipped',
            'stale',
            'startup_failure',
            'success',
            'timed_out',
          ],
        },
      },
    });
  });

  it.each([
    'https://github.com/acme/api',
    'github.com/acme/api',
    'github.com/acme',
    'acme/api/extra',
    'acme//api',
    './api',
    'acme/..',
    'acme/api?tab=actions',
  ])('rejects malformed repository %s', (repository) => {
    expect(
      normalizeWatchGitHubItemsInput({
        items: [{ kind: 'workflow_run', repository, runId: '1' }],
        notifyOn: { conclusions: ['failure'] },
      }),
    ).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  it('rejects canonical duplicates and extra backend-owned properties', () => {
    expect(
      normalizeWatchGitHubItemsInput({
        items: [
          { kind: 'workflow_run', repository: 'Acme/API', runId: '01' },
          { kind: 'workflow_run', repository: 'acme/api', runId: '1' },
        ],
        notifyOn: { conclusions: ['failure'] },
      }),
    ).toMatchObject({ ok: false, code: 'duplicate_item' });
    expect(
      normalizeWatchGitHubItemsInput({
        items: [
          {
            kind: 'workflow_run',
            repository: 'acme/api',
            runId: '1',
            runtimeState: {},
          },
        ],
        notifyOn: { conclusions: ['failure'] },
      }),
    ).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  it('returns the compact capacity error before API work for 21 items', () => {
    const result = normalizeWatchGitHubItemsInput({
      items: Array.from({ length: 21 }, (_, index) => ({
        kind: 'workflow_run',
        repository: 'acme/api',
        runId: String(index + 1),
      })),
      notifyOn: { conclusions: ['failure'] },
    });
    expect(result).toEqual({
      ok: false,
      code: 'capacity_exceeded',
      message: 'A GitHub workflow watcher can include at most 20 runs.',
      field: 'items',
    });
  });
});

describe('normalizeWatchGitHubItemsFamilyRequest', () => {
  const prUrl = 'https://github.com/Acme/API/pull/42';

  it('normalizes pull request targets in request order with bounded fields', () => {
    expect(
      normalizeWatchGitHubItemsFamilyRequest({
        items: [
          { kind: 'pull_request', target: prUrl },
          { kind: 'pull_request', target: 'acme/web#7' },
          { kind: 'pull_request', number: '9' },
          { kind: 'pull_request', repository: 'acme/docs', number: 3 },
        ],
        repository: 'Acme/Tools',
        label: 'Ship',
        followUpInstruction: 'Rebase the stack.',
        allowDuplicate: true,
      }),
    ).toEqual({
      ok: true,
      value: {
        family: 'pull_request',
        items: [
          { kind: 'pull_request', repository: 'acme/api', number: 42 },
          { kind: 'pull_request', repository: 'acme/web', number: 7 },
          { kind: 'pull_request', repository: 'acme/tools', number: 9 },
          { kind: 'pull_request', repository: 'acme/docs', number: 3 },
        ],
        label: 'Ship',
        followUpInstruction: 'Rebase the stack.',
        allowDuplicate: true,
      },
    });
  });

  it('falls back to a single repository candidate for numbered pull requests', () => {
    expect(
      normalizeWatchGitHubItemsFamilyRequest(
        { items: [{ kind: 'pull_request', number: 5 }] },
        { repositoryCandidates: ['https://github.com/acme/api'] },
      ),
    ).toMatchObject({
      ok: true,
      value: { items: [{ repository: 'acme/api', number: 5 }] },
    });
    expect(
      normalizeWatchGitHubItemsFamilyRequest(
        { items: [{ kind: 'pull_request', number: 5 }] },
        { repositoryCandidates: ['acme/api', 'acme/web'] },
      ),
    ).toMatchObject({
      ok: false,
      code: 'repository_required',
      itemIndex: 0,
      field: 'items',
    });
  });

  it('rejects mixed target families', () => {
    for (const run of ['123', 123, { kind: 'workflow_run', runId: '1' }]) {
      expect(
        normalizeWatchGitHubItemsFamilyRequest({
          items: [run, { kind: 'pull_request', target: prUrl }],
          repository: 'acme/api',
          notifyOn: { conclusions: 'any' },
        }),
      ).toEqual({
        ok: false,
        code: 'invalid_input',
        message:
          'Use one target family per watcher: workflow runs or pull requests, not both.',
        field: 'items',
      });
    }
  });

  it('forbids workflow-run notification selectors on pull request watchers', () => {
    expect(
      normalizeWatchGitHubItemsFamilyRequest({
        items: [{ kind: 'pull_request', target: prUrl }],
        notifyOn: { conclusions: 'any' },
      }),
    ).toMatchObject({ ok: false, code: 'invalid_input', field: 'notifyOn' });
    for (const notifyOn of [
      { run: { conclusions: 'any' } },
      { jobs: { conclusions: 'any' } },
      { statuses: 'any' },
      { queue: { entered: true }, conclusions: ['failure'] },
      [],
      'queue',
    ]) {
      expect(
        normalizeWatchGitHubItemsFamilyRequest({
          items: [{ kind: 'pull_request', target: prUrl }],
          notifyOn,
        }),
      ).toMatchObject({ ok: false, code: 'invalid_input', field: 'notifyOn' });
    }
  });

  it('keeps the default pull request selection implicit', () => {
    for (const notifyOn of [
      undefined,
      {},
      { queue: {} },
      { queue: { entered: false, phases: [] } },
    ]) {
      const result = normalizeWatchGitHubItemsFamilyRequest({
        items: [{ kind: 'pull_request', target: prUrl }],
        ...(notifyOn === undefined ? {} : { notifyOn }),
      });
      expect(result).toMatchObject({
        ok: true,
        value: { family: 'pull_request' },
      });
      expect(result.ok && 'notifyOn' in result.value).toBe(false);
    }
  });

  it('normalizes merge queue entry and phase selections', () => {
    expect(
      normalizeWatchGitHubItemsFamilyRequest({
        items: [{ kind: 'pull_request', target: prUrl }],
        notifyOn: {
          queue: {
            entered: true,
            phases: ['unmergeable', 'awaiting_checks', 'unmergeable'],
          },
        },
      }),
    ).toMatchObject({
      ok: true,
      value: {
        family: 'pull_request',
        notifyOn: {
          queueEntered: true,
          queuePhases: ['awaiting_checks', 'unmergeable'],
        },
      },
    });
    expect(
      normalizeWatchGitHubItemsFamilyRequest({
        items: [{ kind: 'pull_request', target: prUrl }],
        notifyOn: { queue: { phases: 'any' } },
      }),
    ).toMatchObject({
      ok: true,
      value: {
        notifyOn: {
          queueEntered: false,
          queuePhases: [
            'queued',
            'awaiting_checks',
            'mergeable',
            'locked',
            'unmergeable',
          ],
        },
      },
    });
  });

  it('rejects unknown, unrecognized, or malformed queue selections', () => {
    for (const queue of [
      { phases: ['unknown'] },
      { phases: ['ejected'] },
      { phases: 'all' },
      { phases: [1] },
      { entered: 'yes' },
      { entered: true, position: true },
      null,
      true,
    ]) {
      expect(
        normalizeWatchGitHubItemsFamilyRequest({
          items: [{ kind: 'pull_request', target: prUrl }],
          notifyOn: { queue },
        }),
      ).toMatchObject({ ok: false, code: 'invalid_input', field: 'notifyOn' });
    }
  });

  it('rejects queue selections on workflow-run watchers', () => {
    const result = normalizeWatchGitHubItemsFamilyRequest({
      items: ['acme/api#1'],
      notifyOn: { conclusions: ['failure'], queue: { entered: true } },
    });
    expect(result).toEqual({
      ok: false,
      code: 'invalid_input',
      message: 'notifyOn.queue applies only to pull request watchers.',
      field: 'notifyOn',
    });
  });

  it('rejects duplicates, oversize requests, and missing repositories', () => {
    expect(
      normalizeWatchGitHubItemsFamilyRequest({
        items: [
          { kind: 'pull_request', target: prUrl },
          { kind: 'pull_request', repository: 'acme/api', number: '42' },
        ],
      }),
    ).toMatchObject({
      ok: false,
      code: 'duplicate_item',
      itemIndex: 1,
      field: 'items',
    });
    expect(
      normalizeWatchGitHubItemsFamilyRequest({
        items: Array.from({ length: 21 }, (_, index) => ({
          kind: 'pull_request',
          target: `acme/api#${index + 1}`,
        })),
      }),
    ).toMatchObject({ ok: false, code: 'capacity_exceeded', field: 'items' });
    expect(
      normalizeWatchGitHubItemsFamilyRequest({
        items: [{ kind: 'pull_request', number: 1 }],
      }),
    ).toMatchObject({ ok: false, code: 'repository_required', itemIndex: 0 });
    expect(
      normalizeWatchGitHubItemsFamilyRequest({
        items: [{ kind: 'pull_request', target: prUrl, number: 42 }],
      }),
    ).toMatchObject({ ok: false, code: 'invalid_input', itemIndex: 0 });
  });

  it('points pull request URLs passed as workflow runs at the pull_request form', () => {
    for (const item of [prUrl, { kind: 'workflow_run', target: prUrl }]) {
      const result = normalizeWatchGitHubItemsFamilyRequest({
        items: ['1', item],
        repository: 'acme/api',
        notifyOn: { conclusions: 'any' },
      });
      expect(result).toMatchObject({
        ok: false,
        code: 'invalid_reference',
        itemIndex: 1,
        field: 'items',
      });
      expect(result.ok ? '' : result.message).toContain(
        '{"kind":"pull_request","target":',
      );
    }
  });

  it('keeps notifyOn required for workflow runs and tags the family', () => {
    expect(
      normalizeWatchGitHubItemsFamilyRequest({
        items: ['acme/api#1'],
      }),
    ).toMatchObject({ ok: false, code: 'invalid_input', field: 'notifyOn' });
    expect(
      normalizeWatchGitHubItemsFamilyRequest({
        items: ['acme/api#1'],
        notifyOn: { conclusions: ['failure'] },
      }),
    ).toMatchObject({
      ok: true,
      value: { family: 'workflow_run', items: ['acme/api#1'] },
    });
  });

  it('keeps the workflow-run request function free of the family tag', () => {
    const runs = normalizeWatchGitHubItemsRequest({
      items: ['acme/api#1'],
      notifyOn: { conclusions: ['failure'] },
    });
    expect(runs.ok && 'family' in runs.value).toBe(false);
    expect(
      normalizeWatchGitHubItemsRequest({
        items: [{ kind: 'pull_request', target: prUrl }],
      }),
    ).toMatchObject({ ok: false, code: 'invalid_input', field: 'items' });
  });

  it('arms merge, close, and queue removal events by default', () => {
    const defaults = [
      'pull_request_merged',
      'pull_request_closed',
      'pull_request_queue_removed',
      'pull_request_queue_history_incomplete',
    ];
    expect(githubPullRequestWatcherEventKinds()).toEqual(defaults);
    expect(
      githubPullRequestWatcherEventKinds({
        queueEntered: false,
        queuePhases: [],
      }),
    ).toEqual(defaults);
  });

  it('arms queue entry and phase events only when selected', () => {
    expect(
      githubPullRequestWatcherEventKinds({
        queueEntered: true,
        queuePhases: [],
      }),
    ).toContain('pull_request_queue_entered');
    expect(
      githubPullRequestWatcherEventKinds({
        queueEntered: true,
        queuePhases: ['locked'],
      }),
    ).toEqual([
      'pull_request_merged',
      'pull_request_closed',
      'pull_request_queue_removed',
      'pull_request_queue_history_incomplete',
      'pull_request_queue_entered',
      'pull_request_queue_phase_changed',
    ]);
    expect(
      githubPullRequestWatcherEventKinds({
        queueEntered: false,
        queuePhases: ['locked'],
      }),
    ).not.toContain('pull_request_queue_entered');
  });
});

describe('isPersistedGitHubPullRequestTarget', () => {
  const target = {
    kind: 'github_pull_requests',
    items: [{ kind: 'pull_request', repository: 'acme/api', number: 42 }],
    display: {
      repositories: ['acme/api'],
      sample: [{ repository: 'acme/api', number: 42, title: 'Add search' }],
    },
  };

  it('accepts a canonical persisted target', () => {
    expect(isPersistedGitHubPullRequestTarget(target)).toBe(true);
  });

  it('accepts a non-default merge queue selection', () => {
    for (const notifyOn of [
      { queueEntered: true, queuePhases: [] },
      { queueEntered: false, queuePhases: ['awaiting_checks', 'unmergeable'] },
    ]) {
      expect(isPersistedGitHubPullRequestTarget({ ...target, notifyOn })).toBe(
        true,
      );
    }
  });

  it.each([
    { queueEntered: false, queuePhases: [] },
    { queueEntered: 'yes', queuePhases: [] },
    { queueEntered: true },
    { queueEntered: false, queuePhases: ['unknown'] },
    { queueEntered: false, queuePhases: ['locked', 'locked'] },
    { queueEntered: true, queuePhases: [], extra: true },
    null,
  ])('rejects malformed or default persisted notifyOn %#', (notifyOn) => {
    expect(isPersistedGitHubPullRequestTarget({ ...target, notifyOn })).toBe(
      false,
    );
  });

  it.each([
    { ...target, extra: true },
    { ...target, items: [] },
    {
      ...target,
      items: [{ kind: 'pull_request', repository: 'Acme/API', number: 42 }],
    },
    {
      ...target,
      items: [{ kind: 'pull_request', repository: 'acme/api', number: '42' }],
    },
    { ...target, items: [target.items[0], target.items[0]] },
    { ...target, display: { repositories: ['acme/api'] } },
  ])('rejects malformed persisted target %#', (candidate) => {
    expect(isPersistedGitHubPullRequestTarget(candidate)).toBe(false);
  });
});

describe('describeWatcherFiredKind', () => {
  it('describes chat completion watchers with the chat title', () => {
    expect(
      describeWatcherFiredKind({
        trigger: 'worktree_chat_completion',
        target: {
          kind: 'worktree_chat',
          projectId: 'p1',
          worktreeId: 'w1',
          chatId: 'c1',
          chatTitle: 'Fix login bug',
        },
      }),
    ).toBe('Chat completion (Fix login bug)');
    expect(
      describeWatcherFiredKind({
        trigger: 'standalone_chat_completion',
        target: {
          kind: 'standalone_chat',
          projectId: 'p1',
          chatId: 'c1',
        },
      }),
    ).toBe('Chat completion');
  });

  it('describes new-chat watchers with worktree/project context', () => {
    expect(
      describeWatcherFiredKind({
        trigger: 'worktree_new_chat_started',
        target: {
          kind: 'worktree_chat_scope',
          projectId: 'p1',
          worktreeId: 'w1',
          worktreeBranchName: 'feature/fennec',
        },
      }),
    ).toBe('New chat (feature/fennec)');
    expect(
      describeWatcherFiredKind({
        trigger: 'standalone_new_chat_started',
        target: {
          kind: 'standalone_chat_project',
          projectId: 'p1',
          projectName: 'Research',
        },
      }),
    ).toBe('New chat (Research)');
  });

  it('describes pipeline completion watchers with the pipeline name', () => {
    expect(
      describeWatcherFiredKind({
        trigger: 'worktree_pipeline_completion',
        target: {
          kind: 'worktree_pipeline',
          projectId: 'p1',
          worktreeId: 'w1',
          pipelineName: 'Deploy',
        },
      }),
    ).toBe('Pipeline completion (Deploy)');
    expect(
      describeWatcherFiredKind({
        trigger: 'worktree_pipeline_completion',
        target: {
          kind: 'worktree_pipeline',
          projectId: 'p1',
          worktreeId: 'w1',
        },
      }),
    ).toBe('Pipeline completion');
  });

  it('describes hook watchers with the hook label or trigger display name', () => {
    expect(
      describeWatcherFiredKind({
        trigger: 'worktree_hook_triggered',
        target: {
          kind: 'worktree_hook',
          projectId: 'p1',
          worktreeId: 'w1',
          triggerName: 'pr:checks:fail',
          hookLabel: 'CI guard',
        },
      }),
    ).toBe('Hook (CI guard)');
    const withoutLabel = describeWatcherFiredKind({
      trigger: 'worktree_hook_triggered',
      target: {
        kind: 'worktree_hook',
        projectId: 'p1',
        worktreeId: 'w1',
        triggerName: 'pr:checks:fail',
      },
    });
    expect(withoutLabel.startsWith('Hook (')).toBe(true);
    expect(withoutLabel).not.toBe('Hook (pr:checks:fail)');
  });

  it('describes automation-run watchers with the automation name', () => {
    expect(
      describeWatcherFiredKind({
        trigger: 'automation_run',
        target: {
          kind: 'automation',
          automationId: 'auto-1',
          automationName: 'Nightly triage',
        },
      }),
    ).toBe('Automation run (Nightly triage)');
  });

  it('describes GitHub workflow-run watchers by repository', () => {
    expect(
      describeWatcherFiredKind({
        trigger: 'github_workflow_runs_changed',
        target: {
          kind: 'github_workflow_runs',
          items: [{ kind: 'workflow_run', repository: 'acme/api', runId: '1' }],
          notifyOn: {
            statuses: [],
            conclusions: ['failure'],
            jobConclusions: [],
          },
          display: { repositories: ['acme/api'], sample: [] },
        },
      }),
    ).toBe('GitHub workflow run (acme/api)');
    expect(
      describeWatcherFiredKind({
        trigger: 'github_workflow_runs_changed',
        target: {
          kind: 'github_workflow_runs',
          items: [
            { kind: 'workflow_run', repository: 'acme/api', runId: '1' },
            { kind: 'workflow_run', repository: 'acme/web', runId: '2' },
          ],
          notifyOn: {
            statuses: [],
            conclusions: ['failure'],
            jobConclusions: [],
          },
          display: { repositories: ['acme/api', 'acme/web'], sample: [] },
        },
      }),
    ).toBe('GitHub workflow run (2 repositories)');
  });

  it('describes GitHub pull request watchers by reference or count', () => {
    const display = { repositories: ['acme/api'], sample: [] };
    expect(
      describeWatcherFiredKind({
        trigger: 'github_pull_requests_changed',
        target: {
          kind: 'github_pull_requests',
          items: [{ kind: 'pull_request', repository: 'acme/api', number: 42 }],
          display,
        },
      }),
    ).toBe('GitHub pull request (acme/api#42)');
    expect(
      describeWatcherFiredKind({
        trigger: 'github_pull_requests_changed',
        target: {
          kind: 'github_pull_requests',
          items: [
            { kind: 'pull_request', repository: 'acme/api', number: 42 },
            { kind: 'pull_request', repository: 'acme/api', number: 43 },
          ],
          display,
        },
      }),
    ).toBe('GitHub pull request (2 pull requests)');
  });
});

describe('SearchWatchers instance identity and paging', () => {
  const rows = [
    {
      id: 'chat-a',
      label: 'Review finished',
      target: { projectId: 'p1', taskId: 't1', chatId: 'c1' },
    },
    { id: 'scope', label: 'New chats', target: { projectId: 'p1' } },
    {
      id: 'bot',
      label: 'Advisor reply',
      target: { botId: 'app_advisor', taskId: 'e1', chatId: 'c9' },
    },
    { id: 'github', label: 'CI runs' },
  ];

  it('maps pipeline and hook identity, omitting a cowork task', () => {
    expect(
      watcherSearchTarget({
        kind: 'worktree_pipeline',
        projectId: 'p1',
        worktreeId: 't1',
        executionId: 'x1',
      }),
    ).toEqual({ projectId: 'p1', taskId: 't1', executionId: 'x1' });
    expect(
      watcherSearchTarget(
        {
          kind: 'worktree_pipeline',
          projectId: 'cowork-1',
          worktreeId: 'home',
          pipelineId: 'pl',
        },
        (projectId) => projectId.startsWith('cowork-'),
      ),
    ).toEqual({ projectId: 'cowork-1', pipelineId: 'pl' });
    expect(
      watcherSearchTarget({
        kind: 'worktree_hook',
        projectId: 'p1',
        worktreeId: 't1',
        triggerName: 'pr_created',
      }),
    ).toEqual({ projectId: 'p1', taskId: 't1', triggerName: 'pr_created' });
    expect(
      watcherSearchTarget({ kind: 'automation', automationId: 'a1' }),
    ).toBeUndefined();
  });

  it('filters by target IDs and never matches untargeted rows', () => {
    const page = pageActiveWatchers(rows, { targetProjectId: 'p1' });
    expect(page).toMatchObject({ ok: true, activeTotalMatches: 2 });
    if (!page.ok) throw new Error(page.error);
    expect(page.activeWatchers.map((row) => row.id)).toEqual([
      'chat-a',
      'scope',
    ]);
    const tasked = pageActiveWatchers(rows, { targetTaskId: 't1' });
    if (!tasked.ok) throw new Error(tasked.error);
    // A project-wide scope has no task and is not a wildcard match.
    expect(tasked.activeWatchers.map((row) => row.id)).toEqual(['chat-a']);
    expect(
      pageActiveWatchers(rows, { targetProjectId: 'p1', targetBotId: 'b' }),
    ).toEqual({
      ok: false,
      error: 'targetProjectId and targetBotId cannot be combined.',
    });
  });

  it('searches labels and target IDs and pages with a bound cursor', () => {
    const queried = pageActiveWatchers(rows, { activeQuery: 'C9' });
    if (!queried.ok) throw new Error(queried.error);
    expect(queried.activeWatchers.map((row) => row.id)).toEqual(['bot']);

    const first = pageActiveWatchers(rows, { activePageSize: 3 });
    if (!first.ok) throw new Error(first.error);
    expect(first).toMatchObject({ activeReturned: 3, activeTotalMatches: 4 });
    expect(first.activeNextCursor).toEqual(expect.any(String));
    const second = pageActiveWatchers(rows, {
      activePageSize: 3,
      activeCursor: first.activeNextCursor,
    });
    if (!second.ok) throw new Error(second.error);
    expect(second.activeWatchers.map((row) => row.id)).toEqual(['github']);
    expect(second.activeNextCursor).toBeUndefined();
    // A cursor from different filters, or a malformed one, is rejected.
    expect(
      pageActiveWatchers(rows, {
        activeQuery: 'review',
        activeCursor: first.activeNextCursor,
      }),
    ).toEqual({ ok: false, error: 'Invalid activeCursor.' });
    expect(pageActiveWatchers(rows, { activeCursor: 'nope' })).toEqual({
      ok: false,
      error: 'Invalid activeCursor.',
    });
  });

  it('projects pipeline identity in minimal and standard search results', () => {
    for (const detailLevel of ['minimal', 'standard'] as const) {
      const result = searchAppAdvisorWatchers({ detailLevel }, [
        makeActiveWatcher({
          id: 'pipe',
          trigger: 'worktree_pipeline_completion',
          target: {
            kind: 'worktree_pipeline',
            projectId: 'p1',
            worktreeId: 't1',
          },
        }),
      ]);
      expect(result.activeWatchers[0]?.target).toEqual({
        projectId: 'p1',
        taskId: 't1',
      });
    }
  });
});
