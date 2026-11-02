import {
  HOOK_ENV_VAR_DEFINITIONS,
  SUPPORTED_HOOK_TRIGGERS,
  SUPPORTED_PR_HOOK_TRIGGERS,
  SUPPORTED_WORKTREE_HOOK_TRIGGERS,
  isHookTriggerName,
  compareTriggerNames,
  normalizeTriggerName,
  normalizeHookValue,
  normalizeHookInputMap,
  createHookKey,
  parseHookKey,
  listRunnableHooks,
  getHookTriggerDisplayName,
  getHookActionLabel,
  getHookActionLogLabel,
  interpolateHookPrompt,
  interpolateHookTemplate,
  pipelineHookUnsupportedSpeedError,
  type HookOverrides,
  type HookAction,
} from '../hooks';

describe('SUPPORTED_PR_HOOK_TRIGGERS', () => {
  it('contains all supported PR trigger names in deterministic order', () => {
    expect(SUPPORTED_PR_HOOK_TRIGGERS).toEqual([
      'pr:create',
      'pr:update:comments',
      'pr:reviews:new',
      'pr:reviews:new:has-comments',
      'pr:update:labels',
      'pr:checks:fail',
      'pr:checks:pass',
      'pr:checks:pass:all',
      'pr:checks:finished',
      'pr:checks:finished:has-fail',
      'pr:merge-conflicts',
      'pr:queue:removed',
      'pr:queue:entered',
      'pr:merged',
      'pr:closed',
    ]);
  });
});

describe('SUPPORTED_WORKTREE_HOOK_TRIGGERS', () => {
  it('contains worktree trigger names in deterministic order', () => {
    expect(SUPPORTED_WORKTREE_HOOK_TRIGGERS).toEqual([
      'worktree:precommit:failure',
    ]);
  });
});

describe('hook chat plugin selections', () => {
  it('preserves configured file occurrences when trimming a hook prompt', () => {
    const prompt = '  Read src/a.ts and src/a.ts  ';
    const action: HookAction = {
      type: 'chat',
      prompt,
      planMode: true,
      promptReferences: [
        {
          kind: 'file',
          textStart: 7,
          displayText: 'src/a.ts',
          root: { kind: 'workspace' },
          relativePath: 'src/a.ts',
        },
      ],
    };

    expect(normalizeHookValue([action])).toMatchObject([
      {
        prompt: 'Read src/a.ts and src/a.ts',
        planMode: true,
        promptReferences: [{ textStart: 5, displayText: 'src/a.ts' }],
      },
    ]);
  });

  it('preserves full local selections including custom skills and MCP servers', () => {
    const action: HookAction = {
      type: 'chat',
      prompt: 'Review the release',
      pluginSelections: {
        collectionIds: ['release-tools'],
        skillRefs: [
          { sourceId: 'custom:local', skillName: 'release-checklist' },
        ],
        pluginRefs: [],
        mcpServerRefs: [{ serverId: 'linear', configId: 'work' }],
      },
    };

    expect(normalizeHookValue([action])).toEqual([
      {
        type: 'chat',
        prompt: 'Review the release',
        pluginSelections: {
          collectionIds: ['release-tools'],
          skillRefs: [
            { sourceId: 'custom:local', skillName: 'release-checklist' },
          ],
          pluginRefs: [],
          mcpServerRefs: [{ serverId: 'linear', configId: 'work' }],
        },
      },
    ]);
  });
});

describe('SUPPORTED_HOOK_TRIGGERS', () => {
  it('orders worktree hooks before PR hooks', () => {
    expect(SUPPORTED_HOOK_TRIGGERS).toEqual([
      'worktree:precommit:failure',
      ...SUPPORTED_PR_HOOK_TRIGGERS,
    ]);
  });
});

describe('isHookTriggerName', () => {
  it('returns true for known triggers', () => {
    for (const t of SUPPORTED_HOOK_TRIGGERS) {
      expect(isHookTriggerName(t)).toBe(true);
    }
  });

  it('returns false for unknown strings', () => {
    expect(isHookTriggerName('unknown')).toBe(false);
    expect(isHookTriggerName('')).toBe(false);
    expect(isHookTriggerName('constructor')).toBe(false);
    expect(isHookTriggerName('toString')).toBe(false);
  });
});

describe('compareTriggerNames', () => {
  it('sorts known triggers in dispatch order', () => {
    const triggers = [
      'pr:closed',
      'worktree:precommit:failure',
      'pr:create',
      'pr:checks:fail',
      'pr:checks:pass',
      'pr:checks:pass:all',
      'pr:merged',
      'pr:checks:finished:has-fail',
      'pr:reviews:new',
      'pr:reviews:new:has-comments',
      'pr:update:labels',
      'pr:checks:finished',
      'pr:update:comments',
      'pr:queue:entered',
      'pr:merge-conflicts',
      'pr:queue:removed',
    ];
    triggers.sort(compareTriggerNames);
    expect(triggers).toEqual(SUPPORTED_HOOK_TRIGGERS);
  });

  it('sorts unknown triggers after known ones, lexicographically', () => {
    const triggers = ['custom-b', 'pr:create', 'custom-a'];
    triggers.sort(compareTriggerNames);
    expect(triggers).toEqual(['pr:create', 'custom-a', 'custom-b']);
  });
});

describe('normalizeTriggerName', () => {
  it('returns undefined for empty/blank values', () => {
    expect(normalizeTriggerName(undefined)).toBeUndefined();
    expect(normalizeTriggerName('')).toBeUndefined();
    expect(normalizeTriggerName('   ')).toBeUndefined();
  });

  it('trims whitespace', () => {
    expect(normalizeTriggerName('  pr:create  ')).toBe('pr:create');
  });
});

describe('normalizeHookValue', () => {
  it('passes through null', () => {
    expect(normalizeHookValue(null)).toBeNull();
  });

  it('passes through undefined', () => {
    expect(normalizeHookValue(undefined)).toBeUndefined();
  });

  it('filters out invalid actions', () => {
    const actions: HookAction[] = [
      {
        type: 'command',
        command: 'echo hello',
        shell: { windows: 'bash', mac: 'zsh' },
        interactive: true,
      },
      {
        type: 'command',
        command: 'echo invalid shell',
        // @ts-expect-error intentionally invalid shell values for runtime normalization.
        shell: { windows: 'zsh', mac: 'fish' },
      },
      { type: 'command', command: '' },
      { type: 'command', command: '   ' },
      {
        type: 'chat',
        prompt: 'Review changes',
        model: ' gpt-6-sol ',
        'if-command': ' test -f "$CANOPY_PR_CURRENT_FILE" ',
      },
      { type: 'chat', prompt: '   ' },
    ];
    const result = normalizeHookValue(actions);
    expect(result).toEqual([
      {
        type: 'command',
        command: 'echo hello',
        shell: { windows: 'bash', mac: 'zsh' },
        interactive: true,
      },
      { type: 'command', command: 'echo invalid shell' },
      {
        type: 'chat',
        prompt: 'Review changes',
        model: 'gpt-6-sol',
        'if-command': 'test -f "$CANOPY_PR_CURRENT_FILE"',
      },
    ]);
  });

  it('returns undefined if all actions are invalid', () => {
    expect(
      normalizeHookValue([{ type: 'command', command: '' }]),
    ).toBeUndefined();
  });

  it('keeps valid thinking levels for chat actions', () => {
    expect(
      normalizeHookValue([
        {
          type: 'chat',
          prompt: 'Review comments',
          thinking: 'medium',
        },
      ]),
    ).toEqual([
      {
        type: 'chat',
        prompt: 'Review comments',
        modelConfig: { thinkingLevel: 'medium' },
      },
    ]);
  });

  it('normalizes chat-hook Codex speed with speed-first precedence', () => {
    expect(
      normalizeHookValue([
        {
          type: 'chat',
          prompt: 'Ultra',
          modelConfig: { speed: 'ultrafast', fastMode: true },
          codexFastMode: true,
        },
        {
          type: 'chat',
          prompt: 'Legacy false',
          modelConfig: { fastMode: false },
          codexFastMode: true,
        },
        { type: 'chat', prompt: 'Alias', codexFastMode: true },
        {
          type: 'chat',
          prompt: 'Invalid speed falls back',
          // @ts-expect-error exercises runtime normalization of persisted data.
          modelConfig: { speed: 'turbo', fastMode: true },
        },
      ]),
    ).toEqual([
      {
        type: 'chat',
        prompt: 'Ultra',
        modelConfig: { speed: 'ultrafast', fastMode: false },
      },
      {
        type: 'chat',
        prompt: 'Legacy false',
        modelConfig: { fastMode: false },
      },
      { type: 'chat', prompt: 'Alias', modelConfig: { fastMode: true } },
      {
        type: 'chat',
        prompt: 'Invalid speed falls back',
        modelConfig: { fastMode: true },
      },
    ]);
  });

  it('keeps pipeline hooks boolean but never drops or downgrades an Ultra request', () => {
    const [fastAction, ultraAction] =
      normalizeHookValue([
        {
          type: 'pipeline',
          source: 'bundled',
          id: 'review',
          modelConfig: { speed: 'fast' },
        },
        {
          type: 'pipeline',
          source: 'bundled',
          id: 'review',
          modelConfig: { speed: 'ultrafast' },
        },
      ]) ?? [];
    expect(fastAction).toEqual({
      type: 'pipeline',
      source: 'bundled',
      id: 'review',
      modelConfig: { fastMode: true },
    });
    expect(ultraAction).toEqual({
      type: 'pipeline',
      source: 'bundled',
      id: 'review',
      modelConfig: { speed: 'ultrafast', fastMode: false },
    });
    expect(
      ultraAction?.type === 'pipeline'
        ? pipelineHookUnsupportedSpeedError(ultraAction)
        : undefined,
    ).toBe('Workflow hooks do not support Ultra fast. Choose Regular or Fast.');
    expect(
      fastAction?.type === 'pipeline'
        ? pipelineHookUnsupportedSpeedError(fastAction)
        : 'missing',
    ).toBeUndefined();
  });

  it('preserves valid chat approval modes and drops invalid values', () => {
    expect(
      normalizeHookValue([
        {
          type: 'chat',
          prompt: 'Safe review',
          approvalMode: 'ask',
        },
        {
          type: 'chat',
          prompt: 'Invalid review',
          // @ts-expect-error exercises runtime normalization of persisted data.
          approvalMode: 'unrestricted',
        },
      ]),
    ).toEqual([
      { type: 'chat', prompt: 'Safe review', approvalMode: 'ask' },
      { type: 'chat', prompt: 'Invalid review' },
    ]);
  });

  it('preserves allowChatConcurrency: true on chat actions', () => {
    expect(
      normalizeHookValue([
        {
          type: 'chat',
          prompt: 'Review comments',
          allowChatConcurrency: true,
        },
      ]),
    ).toEqual([
      {
        type: 'chat',
        prompt: 'Review comments',
        allowChatConcurrency: true,
      },
    ]);
  });

  it('omits allowChatConcurrency when absent from chat actions', () => {
    const result = normalizeHookValue([
      {
        type: 'chat',
        prompt: 'Review comments',
      },
    ]);
    expect(result).toEqual([
      {
        type: 'chat',
        prompt: 'Review comments',
      },
    ]);
    const [chatAction] = result ?? [];
    expect(chatAction).toBeDefined();
    if (chatAction && chatAction.type === 'chat') {
      expect('allowChatConcurrency' in chatAction).toBe(false);
    }
  });

  it('omits allowChatConcurrency when explicitly false on chat actions', () => {
    const result = normalizeHookValue([
      {
        type: 'chat',
        prompt: 'Review comments',
        allowChatConcurrency: false,
      },
    ]);
    expect(result).toEqual([
      {
        type: 'chat',
        prompt: 'Review comments',
      },
    ]);
    const [chatAction] = result ?? [];
    expect(chatAction).toBeDefined();
    if (chatAction && chatAction.type === 'chat') {
      expect('allowChatConcurrency' in chatAction).toBe(false);
    }
  });

  it('preserves autoArchive: true on chat actions', () => {
    expect(
      normalizeHookValue([
        { type: 'chat', prompt: 'Review comments', autoArchive: true },
      ]),
    ).toEqual([{ type: 'chat', prompt: 'Review comments', autoArchive: true }]);
  });

  it('preserves local plugin selection overlay metadata through normalization', () => {
    expect(
      normalizeHookValue([
        {
          type: 'chat',
          prompt: 'Review comments',
          localPluginSelectionOverlay: true,
          localPluginSelectionOverlayKey: 'chat:Review comments',
          pluginSelections: {
            collectionIds: ['review-tools'],
            skillRefs: [],
            pluginRefs: [],
          },
        },
      ]),
    ).toEqual([
      {
        type: 'chat',
        prompt: 'Review comments',
        localPluginSelectionOverlay: true,
        localPluginSelectionOverlayKey: 'chat:Review comments',
        pluginSelections: {
          collectionIds: ['review-tools'],
          skillRefs: [],
          pluginRefs: [],
        },
      },
    ]);
  });

  it('omits autoArchive when absent or explicitly false', () => {
    for (const action of [
      { type: 'chat' as const, prompt: 'Review comments' },
      { type: 'chat' as const, prompt: 'Review comments', autoArchive: false },
    ]) {
      const result = normalizeHookValue([action]);
      const [chatAction] = result ?? [];
      expect(chatAction && chatAction.type === 'chat').toBe(true);
      if (chatAction && chatAction.type === 'chat') {
        expect('autoArchive' in chatAction).toBe(false);
      }
    }
  });

  it('preserves curated pipeline hook references', () => {
    const action: HookAction = {
      type: 'pipeline',
      source: 'curated',
      id: 'curated:review',
    };
    expect(normalizeHookValue([action])).toEqual([action]);
  });

  it('normalizes valid pipeline actions for each source', () => {
    const actions: HookAction[] = [
      { type: 'pipeline', source: 'bundled', id: 'code-review' },
      { type: 'pipeline', source: 'local', id: '  my-pipeline  ' },
      { type: 'pipeline', source: 'project', id: 'review.yaml' },
    ];
    expect(normalizeHookValue(actions)).toEqual([
      { type: 'pipeline', source: 'bundled', id: 'code-review' },
      { type: 'pipeline', source: 'local', id: 'my-pipeline' },
      { type: 'pipeline', source: 'project', id: 'review.yaml' },
    ]);
  });

  it('normalizes pipeline inputs: trims keys, drops blanks/non-strings, sorts keys', () => {
    const actions: HookAction[] = [
      {
        type: 'pipeline',
        source: 'bundled',
        id: 'code-review',
        inputs: {
          '  pr_url  ': '{{CANOPY_PR_URL}}',
          '': 'ignored-blank-key',
          '   ': 'ignored-whitespace-key',
          number_input: 'ignored-non-string',
          base_branch: 'main',
        },
      },
    ];
    const action = actions[0];
    if (action.type === 'pipeline' && action.inputs) {
      Object.defineProperty(action.inputs, 'number_input', {
        value: 42,
      });
    }
    const result = normalizeHookValue(actions);
    expect(result).toEqual([
      {
        type: 'pipeline',
        source: 'bundled',
        id: 'code-review',
        inputs: {
          base_branch: 'main',
          pr_url: '{{CANOPY_PR_URL}}',
        },
      },
    ]);
  });

  it('omits inputs when normalized result is empty', () => {
    const actions: HookAction[] = [
      {
        type: 'pipeline',
        source: 'bundled',
        id: 'code-review',
        inputs: {
          '   ': 'blank',
          x: 'ignored-non-string',
        },
      },
    ];
    const action = actions[0];
    if (action.type === 'pipeline' && action.inputs) {
      Object.defineProperty(action.inputs, 'x', {
        value: 7,
      });
    }
    const result = normalizeHookValue(actions);
    expect(result).toEqual([
      { type: 'pipeline', source: 'bundled', id: 'code-review' },
    ]);
    const [pipelineAction] = result ?? [];
    expect(pipelineAction).toBeDefined();
    if (pipelineAction && pipelineAction.type === 'pipeline') {
      expect('inputs' in pipelineAction).toBe(false);
    }
  });

  it('drops invalid pipeline action drafts', () => {
    const actions: HookAction[] = [
      {
        type: 'pipeline',
        source: 'bundled',
        id: '',
      },
      {
        type: 'pipeline',
        source: 'bundled',
        id: '   ',
      },
      {
        type: 'pipeline',
        source: 'bundled',
        id: 'code-review',
      },
      {
        type: 'pipeline',
        source: 'bundled',
        id: 'non-string-id',
      },
    ];
    const invalidSourceAction = actions[2];
    if (invalidSourceAction.type === 'pipeline') {
      Object.defineProperty(invalidSourceAction, 'source', {
        value: 'unknown',
      });
    }
    const nonStringIdAction = actions[3];
    if (nonStringIdAction.type === 'pipeline') {
      Object.defineProperty(nonStringIdAction, 'id', {
        value: 42,
      });
    }
    const result = normalizeHookValue(actions);
    expect(result).toBeUndefined();
  });

  it('preserves only allowPipelineConcurrency: true', () => {
    expect(
      normalizeHookValue([
        {
          type: 'pipeline',
          source: 'bundled',
          id: 'code-review',
          allowPipelineConcurrency: true,
        },
      ]),
    ).toEqual([
      {
        type: 'pipeline',
        source: 'bundled',
        id: 'code-review',
        allowPipelineConcurrency: true,
      },
    ]);
  });

  it('omits allowPipelineConcurrency when absent on pipeline actions', () => {
    const result = normalizeHookValue([
      {
        type: 'pipeline',
        source: 'bundled',
        id: 'code-review',
      },
    ]);
    expect(result).toEqual([
      { type: 'pipeline', source: 'bundled', id: 'code-review' },
    ]);
    const [pipelineAction] = result ?? [];
    expect(pipelineAction).toBeDefined();
    if (pipelineAction && pipelineAction.type === 'pipeline') {
      expect('allowPipelineConcurrency' in pipelineAction).toBe(false);
    }
  });

  it('omits allowPipelineConcurrency when explicitly false on pipeline actions', () => {
    const result = normalizeHookValue([
      {
        type: 'pipeline',
        source: 'bundled',
        id: 'code-review',
        allowPipelineConcurrency: false,
      },
    ]);
    expect(result).toEqual([
      { type: 'pipeline', source: 'bundled', id: 'code-review' },
    ]);
    const [pipelineAction] = result ?? [];
    expect(pipelineAction).toBeDefined();
    if (pipelineAction && pipelineAction.type === 'pipeline') {
      expect('allowPipelineConcurrency' in pipelineAction).toBe(false);
    }
  });
});

describe('normalizeHookInputMap', () => {
  it('returns undefined for empty/undefined input', () => {
    expect(normalizeHookInputMap(undefined)).toBeUndefined();
    expect(normalizeHookInputMap({})).toBeUndefined();
  });

  it('normalizes and sorts entries by trigger order', () => {
    const input = {
      'pr:closed': [{ type: 'command' as const, command: 'cleanup' }],
      'pr:create': [
        { type: 'command' as const, command: 'notify' },
        { type: 'chat' as const, prompt: 'Review the PR' },
      ],
    };
    const result = normalizeHookInputMap(input);
    expect(result).toBeDefined();
    expect(Object.keys(result ?? {})).toEqual(['pr:create', 'pr:closed']);
  });

  it('preserves null values (used for disabling inherited hooks)', () => {
    const input = {
      'pr:create': null,
    };
    const result = normalizeHookInputMap(input);
    expect(result).toEqual({ 'pr:create': null });
  });
});

describe('createHookKey / parseHookKey', () => {
  it('handles project scope', () => {
    const key = createHookKey('project', 'pr:create');
    expect(key).toBe('project:pr:create');
    expect(parseHookKey(key)).toEqual({
      scope: 'project',
      triggerName: 'pr:create',
    });
  });

  it('handles workspace-root scope', () => {
    const key = createHookKey('workspace-root', 'pr:merged');
    expect(key).toBe('workspace-root:pr:merged');
    expect(parseHookKey(key)).toEqual({
      scope: 'workspace-root',
      triggerName: 'pr:merged',
    });
  });

  it('handles workspace-repo scope', () => {
    const key = createHookKey('workspace-repo', 'pr:closed', 'repo-1');
    expect(key).toBe('workspace-repo:repo-1:pr:closed');
    expect(parseHookKey(key)).toEqual({
      scope: 'workspace-repo',
      repoId: 'repo-1',
      triggerName: 'pr:closed',
    });
  });

  it('throws when workspace-repo scope is missing repoId', () => {
    expect(() => createHookKey('workspace-repo', 'pr:create')).toThrow(
      'repoId is required',
    );
  });

  it('returns null for invalid keys', () => {
    expect(parseHookKey('project:')).toBeNull();
    expect(parseHookKey('workspace-root:')).toBeNull();
    expect(parseHookKey('workspace-repo:')).toBeNull();
    expect(parseHookKey('workspace-repo:repo-1')).toBeNull();
    expect(parseHookKey('unknown:foo')).toBeNull();
  });
});

describe('listRunnableHooks', () => {
  it('returns empty array for undefined', () => {
    expect(listRunnableHooks(undefined)).toEqual([]);
  });

  it('filters out null and empty values', () => {
    const hooks: HookOverrides = {
      'pr:create': [{ type: 'command', command: 'echo hello' }],
      'pr:merged': null,
      'pr:closed': [],
    };
    const result = listRunnableHooks(hooks);
    expect(result).toHaveLength(1);
    expect(result[0].triggerName).toBe('pr:create');
  });

  it('sorts by trigger order', () => {
    const hooks: HookOverrides = {
      'pr:closed': [{ type: 'command', command: 'c' }],
      'pr:create': [{ type: 'command', command: 'a' }],
    };
    const result = listRunnableHooks(hooks);
    expect(result.map((e) => e.triggerName)).toEqual([
      'pr:create',
      'pr:closed',
    ]);
  });
});

describe('interpolateHookPrompt', () => {
  it('interpolates CANOPY_WORKTREE_NAME', () => {
    expect(
      interpolateHookPrompt('Review {{CANOPY_WORKTREE_NAME}}', {
        CANOPY_WORKTREE_NAME: 'gorilla',
      }),
    ).toBe('Review gorilla');
  });

  it('interpolates CONDUCTOR_WORKSPACE_NAME', () => {
    expect(
      interpolateHookPrompt('Review {{CONDUCTOR_WORKSPACE_NAME}}', {
        CONDUCTOR_WORKSPACE_NAME: 'gorilla',
      }),
    ).toBe('Review gorilla');
  });

  it('defines the merge queue variables and interpolates them', () => {
    const names = HOOK_ENV_VAR_DEFINITIONS.map((definition) => definition.name);
    expect(names).toContain('CANOPY_PR_QUEUE_ENTRY_ID');
    expect(names).toContain('CANOPY_PR_QUEUE_REMOVAL_REASON');
    expect(
      interpolateHookPrompt(
        'Entry {{CANOPY_PR_QUEUE_ENTRY_ID}} left: {{CANOPY_PR_QUEUE_REMOVAL_REASON}}',
        {
          CANOPY_PR_QUEUE_ENTRY_ID: 'MQE_1',
          CANOPY_PR_QUEUE_REMOVAL_REASON: 'failed_checks',
        },
      ),
    ).toBe('Entry MQE_1 left: failed_checks');
  });

  it('does not expose CONDUCTOR_WORKSPACE_NAME in hook dropdown definitions', () => {
    expect(
      HOOK_ENV_VAR_DEFINITIONS.some(
        (definition) => definition.name === 'CONDUCTOR_WORKSPACE_NAME',
      ),
    ).toBe(false);
  });
});

describe('hook action labels', () => {
  it('marks chat actions that use if-command', () => {
    const action: HookAction = {
      type: 'chat',
      prompt: 'Review the PR',
      'if-command': 'test -f "$CANOPY_PR_CURRENT_FILE"',
    };

    expect(getHookActionLabel(action)).toBe('Chat: Review the PR [if-command]');
    expect(getHookActionLogLabel(action)).toBe('Chat action [if-command]');
  });

  it('formats labels for pipeline actions', () => {
    const bundled: HookAction = {
      type: 'pipeline',
      source: 'bundled',
      id: 'code-review',
    };
    expect(getHookActionLabel(bundled)).toBe('Workflow: bundled/code-review');
    expect(getHookActionLogLabel(bundled)).toBe(
      'Workflow action (bundled/code-review)',
    );

    const local: HookAction = {
      type: 'pipeline',
      source: 'local',
      id: 'my-pipeline',
    };
    expect(getHookActionLabel(local)).toBe('Workflow: local/my-pipeline');
    expect(getHookActionLogLabel(local)).toBe(
      'Workflow action (local/my-pipeline)',
    );

    const project: HookAction = {
      type: 'pipeline',
      source: 'project',
      id: 'ci/review.yaml',
    };
    expect(getHookActionLabel(project)).toBe(
      'Workflow: project/ci/review.yaml',
    );
    expect(getHookActionLogLabel(project)).toBe(
      'Workflow action (project/ci/review.yaml)',
    );
  });
});

describe('display helpers', () => {
  it('returns known display names', () => {
    expect(getHookTriggerDisplayName('pr:create')).toBe('PR Created');
    expect(getHookTriggerDisplayName('pr:merged')).toBe('PR Merged');
    expect(getHookTriggerDisplayName('pr:closed')).toBe('PR Closed');
    expect(getHookTriggerDisplayName('pr:update:comments')).toBe(
      'PR Comments Updated',
    );
    expect(getHookTriggerDisplayName('pr:reviews:new')).toBe(
      'New PR Review Submitted',
    );
    expect(getHookTriggerDisplayName('pr:reviews:new:has-comments')).toBe(
      'New PR Review With Inline Comments',
    );
    expect(getHookTriggerDisplayName('pr:update:labels')).toBe(
      'PR Labels Updated',
    );
    expect(getHookTriggerDisplayName('pr:checks:fail')).toBe('PR Check Failed');
    expect(getHookTriggerDisplayName('pr:checks:pass')).toBe('PR Check Passed');
    expect(getHookTriggerDisplayName('pr:checks:pass:all')).toBe(
      'All PR Checks Passed',
    );
    expect(getHookTriggerDisplayName('pr:checks:finished')).toBe(
      'PR Checks Finished',
    );
    expect(getHookTriggerDisplayName('pr:checks:finished:has-fail')).toBe(
      'PR Checks Finished With Failures',
    );
    expect(getHookTriggerDisplayName('pr:merge-conflicts')).toBe(
      'PR Merge Conflicts Detected',
    );
    expect(getHookTriggerDisplayName('pr:queue:entered')).toBe(
      'PR Entered Merge Queue',
    );
    expect(getHookTriggerDisplayName('pr:queue:removed')).toBe(
      'PR Removed From Merge Queue',
    );
  });

  it('falls back to title-cased version for unknown triggers', () => {
    expect(getHookTriggerDisplayName('custom-trigger')).toBe('Custom Trigger');
  });

  it('getHookActionLabel returns the command', () => {
    expect(getHookActionLabel({ type: 'command', command: 'echo test' })).toBe(
      'echo test',
    );
  });

  it('getHookActionLabel returns a concise chat label', () => {
    expect(
      getHookActionLabel({
        type: 'chat',
        prompt: 'Review the failed checks\nand summarize root cause.',
      }),
    ).toBe('Chat: Review the failed checks');
  });

  it('getHookActionLogLabel redacts chat prompt content', () => {
    expect(
      getHookActionLogLabel({
        type: 'chat',
        prompt: 'Sensitive prompt details',
        model: 'gpt-6-sol',
      }),
    ).toBe('Chat action (gpt-6-sol)');
  });

  it('interpolateHookPrompt replaces supported placeholders', () => {
    expect(
      interpolateHookPrompt(
        'Review {{CANOPY_PR_URL}} from {{ CANOPY_PR_BRANCH }}',
        {
          CANOPY_PR_URL: 'https://example.com/pr/42',
          CANOPY_PR_BRANCH: 'feature/test',
        },
      ),
    ).toBe('Review https://example.com/pr/42 from feature/test');
  });

  it('interpolateHookPrompt preserves unsupported placeholders', () => {
    expect(
      interpolateHookPrompt('Review {{CANOPY_NOT_REAL}}', {
        CANOPY_NOT_REAL: 'ignored',
      }),
    ).toBe('Review {{CANOPY_NOT_REAL}}');
  });
});

describe('interpolateHookTemplate', () => {
  it('replaces supported placeholders in pipeline-input templates', () => {
    expect(
      interpolateHookTemplate(
        '{{CANOPY_PR_URL}}?base={{ CANOPY_PR_BASE_BRANCH }}',
        {
          CANOPY_PR_URL: 'https://example.com/pr/42',
          CANOPY_PR_BASE_BRANCH: 'main',
        },
      ),
    ).toBe('https://example.com/pr/42?base=main');
  });

  it('preserves unsupported placeholders in pipeline-input templates', () => {
    expect(
      interpolateHookTemplate('Branch={{CANOPY_NOT_REAL}}', {
        CANOPY_NOT_REAL: 'ignored',
      }),
    ).toBe('Branch={{CANOPY_NOT_REAL}}');
  });

  it('substitutes empty string for missing supported placeholders', () => {
    expect(interpolateHookTemplate('PR={{CANOPY_PR_URL}}', {})).toBe('PR=');
  });

  it('interpolateHookPrompt remains a wrapper for compatibility', () => {
    const env = { CANOPY_PR_URL: 'https://example.com/pr/1' };
    expect(interpolateHookPrompt('PR={{CANOPY_PR_URL}}', env)).toBe(
      interpolateHookTemplate('PR={{CANOPY_PR_URL}}', env),
    );
  });
});
