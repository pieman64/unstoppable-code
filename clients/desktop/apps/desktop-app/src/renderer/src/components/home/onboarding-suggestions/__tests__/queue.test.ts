/**
 * Pure derivation + reducer logic for the dynamic Home onboarding
 * suggestions module: per-entry step resolution from live product state and
 * persisted latches, persistent completion and deferred states, role-driven
 * filtering, the consolidated tools step, and persisted-state reducers.
 */

import { DEFAULT_DAILY_DRIP_CAP_CREDITS } from '@canopy/protocol/billing';
import type { HomeOnboardingSuggestionsPreferences } from '@canopy/desktop-shared/types';
import type { ProfileRoleId } from '@canopy/protocol/plugin-catalog';
import {
  addRepoTryPrompt,
  advancedOnboardingPrompts,
  deriveOnboardingChecklist,
  deriveOnboardingSuggestionQueue,
  LINEAR_TRY_PROMPT,
  MAX_BLUEPRINT_STARTER_PROMPT_ITEMS,
  NONTECHNICAL_FIRST_PROMPT,
  onboardingChecklistSteps,
  withDismissalsCleared,
  withEntryCompleted,
  withEntryDismissed,
  type OnboardingBlueprintInputs,
  type OnboardingPluginSuggestionInput,
  type OnboardingSuggestionLiveInputs,
} from '../queue';

function liveInputs(
  overrides: Partial<OnboardingSuggestionLiveInputs> = {},
): OnboardingSuggestionLiveInputs {
  return {
    hasCodeWorkspace: false,
    latestRepoName: null,
    github: 'not-connected',
    claude: 'not-connected',
    codex: 'not-connected',
    linear: 'not-connected',
    aiCreditsEligible: false,
    selectedRoles: null,
    pluginSuggestions: [],
    focusShortcut: { enabled: false, registered: false, shortcut: '⌘⇧O' },
    dailyCreditDrip: { state: 'unavailable', enabled: false, capCredits: null },
    ...overrides,
  };
}

function persisted(
  entries: HomeOnboardingSuggestionsPreferences['entries'] = {},
): HomeOnboardingSuggestionsPreferences {
  return {
    startedAt: '2026-08-27T00:00:00.000Z',
    entries: { ...entries },
  };
}

function pluginInput(
  name: string,
  overrides: Partial<OnboardingPluginSuggestionInput> = {},
): OnboardingPluginSuggestionInput {
  return {
    key: `curated/${name}`,
    name,
    displayName: name,
    description: `${name} plugin`,
    promptText: `Try ${name}`,
    promptTexts: [`Try ${name}`, `Summarize ${name}`, `Plan with ${name}`],
    enabled: false,
    enableKeys: [`curated/${name}`],
    searchQuery: name,
    ...overrides,
  };
}

describe('deriveOnboardingChecklist', () => {
  it('ignores a persisted automation entry while preserving checklist order', () => {
    const checklist = deriveOnboardingChecklist(
      persisted({ automation: { completedAt: 'x' } }),
      liveInputs(),
    );

    expect(checklist.map((view) => view.entryId)).toEqual([
      'agent-connections',
      'add-repo',
      'github',
      'plan-mode',
      'focus-shortcut',
    ]);
    expect(checklist.map((view) => view.entryId)).not.toContain('automation');
    expect(JSON.stringify(checklist)).not.toContain(
      ['create', 'automation'].join('-'),
    );
  });

  // A contextual entry the user already resolved stays in the list as a done
  // step even without its live trigger (a connected tool, promo eligibility),
  // so the step count is right from first paint instead of moving when the
  // catalog or the activation probe settles later.
  it('keeps a resolved examples preview and mobile promo without their live trigger', () => {
    const state = persisted({
      'plugin-examples-preview': { completedAt: 'x' },
      'mobile-app': { dismissedAt: 'x' },
    });
    const live = liveInputs({ selectedRoles: ['software-engineer'] });
    for (const pluginsReady of [false, true]) {
      const { checklist } = deriveOnboardingSuggestionQueue(
        state,
        live,
        pluginsReady,
      );
      expect(
        checklist.find((view) => view.entryId === 'plugin-examples-preview')
          ?.status,
      ).toBe('completed');
      expect(
        checklist.find((view) => view.entryId === 'mobile-app')?.status,
      ).toBe('dismissed');
    }
    // Unresolved, they still wait for their trigger.
    const fresh = deriveOnboardingSuggestionQueue(persisted(), live, true);
    expect(
      fresh.checklist.some(
        (view) =>
          view.entryId === 'plugin-examples-preview' ||
          view.entryId === 'mobile-app',
      ),
    ).toBe(false);
  });

  it('consolidates the growing catalog into one tools step before plan mode and the focus shortcut', () => {
    const queue = deriveOnboardingSuggestionQueue(
      persisted({
        'add-repo': { dismissedAt: 'x' },
        github: { dismissedAt: 'x' },
        'agent-connections': { dismissedAt: 'x' },
        linear: { dismissedAt: 'x' },
      }),
      liveInputs({
        pluginSuggestions: [
          ...['google', 'slack', 'notion', 'datadog'].map((name) =>
            pluginInput(name, { key: `universal:${name}` }),
          ),
          ...Array.from({ length: 80 }, (_, i) => pluginInput(`plugin-${i}`)),
        ],
      }),
      true,
    );
    expect(queue.checklist.map((view) => view.entryId)).toEqual([
      'agent-connections',
      'add-repo',
      'github',
      'plan-mode',
      'focus-shortcut',
    ]);
    const tools = queue.checklist.find((view) => view.entryId === 'github');
    expect(tools?.step).toMatchObject({ kind: 'connect-tools' });
    if (tools?.step.kind !== 'connect-tools') throw new Error('tools step');
    // GitHub is offered when a push or pull request first needs it (CAN-4006).
    expect(tools.step.tools.slice(0, 5).map((tool) => tool.key)).toEqual([
      'linear',
      'plugin:universal:google',
      'plugin:universal:slack',
      'plugin:universal:notion',
      'plugin:universal:datadog',
    ]);
  });

  it('keeps the tools step, and its category row, when a category pick leaves no tools', () => {
    const state = persisted({ 'agent-connections': { completedAt: 'x' } });
    const technical = deriveOnboardingSuggestionQueue(
      state,
      liveInputs({ selectedRoles: null, pluginSuggestions: [] }),
      true,
    );
    expect(technical.visible.map((view) => view.entryId)).toEqual(['add-repo']);
    // A design-only pick drops GitHub and Linear; with no catalog tools the
    // step must stay so the categories can still be changed.
    const design = deriveOnboardingSuggestionQueue(
      state,
      liveInputs({ selectedRoles: ['designer'], pluginSuggestions: [] }),
      true,
    );
    const tools = design.visible.find((view) => view.entryId === 'github');
    expect(tools?.step).toEqual({ kind: 'connect-tools', tools: [] });
  });

  it('keeps the tools step with no catalog tools whether the categories are unanswered or cleared', () => {
    const state = persisted({
      'agent-connections': { completedAt: 'x' },
      'add-repo': { completedAt: 'x' },
    });
    for (const selectedRoles of [null, []] as const) {
      const queue = deriveOnboardingSuggestionQueue(
        state,
        liveInputs({ selectedRoles, pluginSuggestions: [] }),
        true,
      );
      const tools = queue.visible.find((view) => view.entryId === 'github');
      // The step hosts the category row, so it is the only place to answer
      // the question; it must stay even when the catalog offers nothing.
      expect(tools?.step.kind).toBe('connect-tools');
    }
  });

  it('places role picks after universal connectors inside the tools step', () => {
    const views = deriveOnboardingChecklist(
      persisted(),
      liveInputs({
        selectedRoles: ['product-manager'],
        pluginSuggestions: [
          pluginInput('slack', { key: 'universal:slack' }),
          pluginInput('figma', { recommendationTier: 'role' }),
          pluginInput('posthog', { recommendationTier: 'role' }),
          pluginInput('airtable'),
        ],
      }),
    );

    const tools = views.find((view) => view.entryId === 'github');
    if (tools?.step.kind !== 'connect-tools') throw new Error('tools step');
    expect(tools.step.tools.map((tool) => tool.key)).toEqual([
      'plugin:universal:slack',
      'plugin:curated/figma',
      'plugin:curated/posthog',
      'plugin:curated/airtable',
    ]);
  });

  it('derives every activity in order, including completed and dismissed entries', () => {
    const views = deriveOnboardingChecklist(
      persisted({
        'agent-connections': { completedAt: 'x' },
        github: { dismissedAt: 'x' },
      }),
      liveInputs(),
    );
    expect(views.map((v) => v.entryId)).toEqual([
      'agent-connections',
      'add-repo',
      'github',
      'plan-mode',
      'focus-shortcut',
    ]);
    // AI providers lead; the roles question is the tools step's category
    // row now, not an entry of its own.
    expect(views[0]).toMatchObject({
      status: 'completed',
      step: { kind: 'connect-agents' },
    });
    expect(views.some((v) => v.entryId === 'roles')).toBe(false);
    expect(views.find((v) => v.entryId === 'github')?.status).toBe('dismissed');
  });

  it('preserves dismissal when live or persisted setup later completes', () => {
    const views = deriveOnboardingChecklist(
      persisted({
        notifications: { dismissedAt: 'x' },
        github: { dismissedAt: 'x', completedAt: 'y' },
      }),
      liveInputs({
        selectedRoles: ['software-engineer'],
        pluginSuggestions: [pluginInput('notion', { enabled: true })],
      }),
    );
    expect(
      views
        .filter((view) => view.status === 'dismissed')
        .map((view) => view.entryId),
    ).toEqual(['github']);
  });

  it('converts add-repo into the first-prompt step once a code project exists', () => {
    const views = deriveOnboardingChecklist(
      persisted(),
      liveInputs({ hasCodeWorkspace: true, latestRepoName: 'canopy' }),
    );
    expect(views.find((v) => v.entryId === 'add-repo')).toEqual({
      entryId: 'add-repo',
      status: 'completed',
      step: { kind: 'prompt', promptText: addRepoTryPrompt('canopy') },
    });
  });

  it('falls back to generic wording when the repo name is unknown', () => {
    expect(addRepoTryPrompt(null)).toBe(
      'Find a simple TODO in my repo and implement it',
    );
  });

  it('keeps connected GitHub examples, with a repo-specific prompt, without a tile', () => {
    const views = deriveOnboardingChecklist(
      persisted(),
      liveInputs({
        github: 'connected',
        hasCodeWorkspace: true,
        latestRepoName: 'canopy',
      }),
    );
    const tools = views.find((v) => v.entryId === 'github');
    if (tools?.step.kind !== 'connect-tools') throw new Error('tools step');
    expect(tools.step.tools.map((tool) => tool.key)).not.toContain('github');
    const examples = views.find((v) => v.entryId === 'plugin-examples-preview');
    if (examples?.step.kind !== 'plugin-examples-preview')
      throw new Error('examples step');
    expect(examples.step.tools).toEqual([
      expect.objectContaining({ key: 'github', connected: true }),
    ]);
    expect(examples.step.tools[0]?.promptTexts).toContain(
      addRepoTryPrompt('canopy'),
    );
  });

  it.each(['checking', 'not-connected', 'needs-attention'] as const)(
    'offers no GitHub tile in the tools step while %s',
    (state) => {
      const views = deriveOnboardingChecklist(
        persisted(),
        liveInputs({ github: state }),
      );
      const tools = views.find((v) => v.entryId === 'github');
      if (tools?.step.kind !== 'connect-tools') throw new Error('tools step');
      expect(tools.step.tools.map((tool) => tool.key)).not.toContain('github');
      expect(tools.step.tools[0]).toMatchObject({ key: 'linear' });
    },
  );

  it.each([
    ['claude connected', { claude: 'connected' as const }],
    ['codex connected', { codex: 'connected' as const }],
    ['AI credits eligible', { aiCreditsEligible: true }],
  ])(
    'keeps provider setup visible and puts create-plan in its own step when %s',
    (_label, overrides) => {
      const views = deriveOnboardingChecklist(
        persisted(),
        liveInputs({ ...overrides, hasCodeWorkspace: true }),
      );
      expect(
        views.find((v) => v.entryId === 'agent-connections')?.step.kind,
      ).toBe('connect-agents');
      expect(views.find((v) => v.entryId === 'plan-mode')?.step.kind).toBe(
        'create-plan',
      );
    },
  );

  it('keeps agents on connect while provider state is unresolved', () => {
    const views = deriveOnboardingChecklist(
      persisted(),
      liveInputs({ claude: 'checking', codex: 'needs-attention' }),
    );
    const agents = views.find((v) => v.entryId === 'agent-connections');
    expect(agents?.step.kind).toBe('connect-agents');
  });

  it('defers the plan-mode step until a code project exists', () => {
    // The task-plan pipeline is worktree-scoped, so a lane without a repo
    // must queue the entry rather than advertise an unrunnable CTA.
    const withoutRepo = deriveOnboardingChecklist(
      persisted(),
      liveInputs({ claude: 'connected' }),
    );
    expect(withoutRepo.find((v) => v.entryId === 'plan-mode')?.status).toBe(
      'deferred',
    );

    const withRepo = deriveOnboardingChecklist(
      persisted(),
      liveInputs({ claude: 'connected', hasCodeWorkspace: true }),
    );
    expect(withRepo.find((v) => v.entryId === 'plan-mode')?.step.kind).toBe(
      'create-plan',
    );
  });

  it('does not repeat the repo prerequisite after the add-repo step was skipped', () => {
    const state = persisted({
      'add-repo': { dismissedAt: 'x' },
      github: { completedAt: 'x' },
      'agent-connections': { completedAt: 'x' },
    });
    const queue = deriveOnboardingSuggestionQueue(
      state,
      liveInputs({
        selectedRoles: ['software-engineer'],
        aiCreditsEligible: true,
      }),
      true,
    );

    expect(
      queue.checklist.find((view) => view.entryId === 'plan-mode'),
    ).toEqual(
      expect.objectContaining({
        status: 'dismissed',
        step: { kind: 'create-plan' },
      }),
    );
    expect(queue.visible[0]?.entryId).toBe('focus-shortcut');
  });

  it('offers a repo-free planning prompt to nontechnical users with an agent lane', () => {
    for (const role of ['student', 'other'] as const) {
      const views = deriveOnboardingChecklist(
        persisted(),
        liveInputs({ selectedRoles: [role], claude: 'connected' }),
      );
      expect(views.find((view) => view.entryId === 'plan-mode')).toMatchObject({
        status: 'pending',
        step: { kind: 'prompt', promptText: NONTECHNICAL_FIRST_PROMPT },
      });
    }
  });

  it('walks Linear from connect to prompts inside the tools step', () => {
    const disconnected = deriveOnboardingChecklist(persisted(), liveInputs());
    const connected = deriveOnboardingChecklist(
      persisted(),
      liveInputs({ linear: 'connected', hasCodeWorkspace: true }),
    );
    for (const [views, expectedConnected] of [
      [disconnected, false],
      [connected, true],
    ] as const) {
      const tools = views.find((view) => view.entryId === 'github');
      if (tools?.step.kind !== 'connect-tools') throw new Error('tools step');
      expect(tools.step.tools[0]).toMatchObject({
        key: 'linear',
        connected: expectedConnected,
      });
      expect(tools.step.tools[0].promptTexts).toContain(LINEAR_TRY_PROMPT);
    }
    expect(LINEAR_TRY_PROMPT).toMatch(/assigned to me.*ready/i);
    expect(LINEAR_TRY_PROMPT).toMatch(/Plan mode/i);
    expect(LINEAR_TRY_PROMPT).toMatch(/Do not make code changes yet/i);
  });

  it('distinguishes dismissed from completed activities', () => {
    const views = deriveOnboardingChecklist(
      persisted({
        notifications: { dismissedAt: '2026-08-27T01:00:00.000Z' },
        github: { dismissedAt: '2026-08-27T01:00:00.000Z' },
        'add-repo': { completedAt: '2026-08-27T01:00:00.000Z' },
      }),
      liveInputs(),
    );
    expect(views.map((v) => v.status)).toEqual([
      'pending',
      'completed',
      'dismissed',
      'dismissed',
      'pending',
    ]);
  });

  describe('role-driven filtering', () => {
    it.each([
      ['designer', 'marketing-sales'],
      ['marketing'],
      ['sales'],
      ['marketing', 'sales'],
      ['student'],
      ['other'],
      ['student', 'other'],
    ] as ProfileRoleId[][])(
      'removes repo setup and developer tools for nontechnical selections %j',
      (...selectedRoles) => {
        const views = deriveOnboardingChecklist(
          persisted(),
          liveInputs({
            selectedRoles,
          }),
        );
        expect(views.map((v) => v.entryId)).toEqual([
          'agent-connections',
          'github',
          'plan-mode',
          'focus-shortcut',
        ]);
      },
    );

    // The role step comes after a resolved project step in the done-first
    // numbering, so dropping it would repeat the role step's number.
    it.each([
      ['an existing project', {}, true, 'completed'],
      [
        'a dismissed project step',
        { 'add-repo': { dismissedAt: 'x' } },
        false,
        'dismissed',
      ],
    ] as const)(
      'keeps repo setup the user got past for nontechnical selections with %s',
      (_, entries, hasCodeWorkspace, status) => {
        const views = deriveOnboardingChecklist(
          persisted({ roles: { completedAt: 'x' }, ...entries }),
          liveInputs({ selectedRoles: ['designer'], hasCodeWorkspace }),
        );
        expect(views.find((view) => view.entryId === 'add-repo')?.status).toBe(
          status,
        );
      },
    );

    it('keeps the full queue when any selected role is technical', () => {
      const views = deriveOnboardingChecklist(
        persisted(),
        liveInputs({ selectedRoles: ['designer', 'software-engineer'] }),
      );
      expect(views.map((v) => v.entryId)).toContain('github');
      expect(views.map((v) => v.entryId)).toContain('add-repo');
      const tools = views.find((view) => view.entryId === 'github');
      if (tools?.step.kind !== 'connect-tools') throw new Error('tools step');
      expect(tools.step.tools[0]?.key).toBe('linear');
    });

    it('filters technical plugin suggestions for nontechnical users', () => {
      const views = deriveOnboardingChecklist(
        persisted({
          'add-repo': { completedAt: 'x' },
          'agent-connections': { completedAt: 'x' },
        }),
        liveInputs({
          selectedRoles: ['operations-support'],
          pluginSuggestions: [
            pluginInput('datadog'),
            pluginInput('vercel'),
            pluginInput('notion'),
          ],
        }),
      );
      const tools = views.find((view) => view.entryId === 'github');
      if (tools?.step.kind !== 'connect-tools') throw new Error('tools step');
      expect(tools.step.tools.map((tool) => tool.key)).toEqual([
        'plugin:curated/notion',
      ]);
    });
  });

  describe('plugin suggestions', () => {
    it('places connected and unconnected plugins together in the tools step', () => {
      const views = deriveOnboardingChecklist(
        persisted({
          'add-repo': { completedAt: 'x' },
          github: { dismissedAt: 'x' },
          'agent-connections': { completedAt: 'x' },
          linear: { dismissedAt: 'x' },
        }),
        liveInputs({
          selectedRoles: ['software-engineer'],
          pluginSuggestions: [
            pluginInput('notion'),
            pluginInput('figma', { enabled: true }),
          ],
        }),
      );
      const tools = views.find((view) => view.entryId === 'github');
      if (tools?.step.kind !== 'connect-tools') throw new Error('tools step');
      expect(tools.step.tools.slice(-2)).toEqual([
        expect.objectContaining({
          key: 'plugin:curated/notion',
          connected: false,
          enableKeys: ['curated/notion'],
        }),
        expect.objectContaining({
          key: 'plugin:curated/figma',
          connected: true,
          promptTexts: ['Try figma', 'Summarize figma', 'Plan with figma'],
        }),
      ]);
    });

    it('uses one persisted lifecycle for the whole tools step', () => {
      const views = deriveOnboardingChecklist(
        persisted({
          github: { dismissedAt: 'x' },
        }),
        liveInputs({
          selectedRoles: ['software-engineer'],
          pluginSuggestions: [pluginInput('notion')],
        }),
      );
      expect(views.find((v) => v.entryId === 'github')?.status).toBe(
        'dismissed',
      );
    });
  });
});

describe('persisted-state reducers', () => {
  it('withEntryDismissed records the timestamp without clobbering other entries', () => {
    const next = withEntryDismissed(
      persisted({ github: { latchedSteps: ['x'] } }),
      'linear',
      '2026-08-27T02:00:00.000Z',
    );
    expect(next.entries.linear?.dismissedAt).toBe('2026-08-27T02:00:00.000Z');
    expect(next.entries.github?.latchedSteps).toEqual(['x']);
  });

  it('withEntryCompleted records the timestamp for dynamic ids too', () => {
    const next = withEntryCompleted(
      persisted(),
      'plugin:curated/notion',
      '2026-08-27T02:00:00.000Z',
    );
    expect(next.entries['plugin:curated/notion']?.completedAt).toBe(
      '2026-08-27T02:00:00.000Z',
    );
  });

  it('reducers do not mutate their input', () => {
    const base = persisted();
    withEntryDismissed(base, 'github', 'x');
    withEntryCompleted(base, 'github', 'x');
    expect(base.entries).toEqual({});
  });
});

describe('withDismissalsCleared', () => {
  it('drops every dismissal and keeps completions and latched steps', () => {
    // Settings' "Show setup checklist" restores dismissed rows without
    // undoing finished work or forgetting a multi-step entry's progress.
    const next = withDismissalsCleared(
      persisted({
        github: { dismissedAt: 'x' },
        linear: { dismissedAt: 'x', latchedSteps: ['legacy-picker-step'] },
        'advanced:project': { dismissedAt: 'x' },
      }),
    );
    expect(next.entries.github).toEqual({});
    expect(next.entries.linear).toEqual({
      latchedSteps: ['legacy-picker-step'],
    });
    expect(next.entries['advanced:project']).toEqual({});
  });

  it('drops the legacy whole-module retirement', () => {
    const next = withDismissalsCleared({
      ...persisted({ github: { dismissedAt: 'x' } }),
      retiredAt: '2026-08-28T00:00:00.000Z',
    });
    expect(next.retiredAt).toBeUndefined();
    expect(next.startedAt).toBe('2026-08-27T00:00:00.000Z');
  });

  it('does not mutate its input', () => {
    const base = persisted({ github: { dismissedAt: 'x' } });
    withDismissalsCleared(base);
    expect(base.entries.github).toEqual({ dismissedAt: 'x' });
  });
});

describe('retired notifications entry (CAN-4005)', () => {
  // Notifications are offered after a background completion now. Legacy
  // records stay in preferences (they answer that offer) but never render.
  it.each([
    ['no record', {}],
    ['a completed record', { notifications: { completedAt: 'x' } }],
    ['a dismissed record', { notifications: { dismissedAt: 'x' } }],
  ])('has no row and no count with %s', (_label, entries) => {
    const state = persisted(entries);
    const views = deriveOnboardingChecklist(state, liveInputs());
    expect(views.map((view) => view.entryId)).not.toContain('notifications');
    expect(views).toHaveLength(
      deriveOnboardingChecklist(persisted(), liveInputs()).length,
    );
    expect(
      deriveOnboardingSuggestionQueue(state, liveInputs(), true).visible.some(
        (view) => view.entryId === 'notifications',
      ),
    ).toBe(false);
  });
});

describe('advanced examples', () => {
  it('ends introductory setup with mobile before any advanced examples', () => {
    const live = liveInputs({
      github: 'connected',
      mobileAppPromoEligible: true,
    });
    const checklist = deriveOnboardingChecklist(persisted(), live);
    expect(checklist.at(-1)).toMatchObject({
      entryId: 'mobile-app',
      step: { kind: 'get-mobile-app' },
    });
    const state = persisted(
      Object.fromEntries(
        checklist
          .filter(({ entryId }) => entryId !== 'mobile-app')
          .map(({ entryId }) => [entryId, { completedAt: 'x' }]),
      ),
    );
    expect(
      deriveOnboardingSuggestionQueue(state, live, true).visible.map(
        ({ entryId }) => entryId,
      ),
    ).toEqual(['mobile-app']);
    const skipped = withEntryDismissed(state, 'mobile-app', 'x');
    expect(
      deriveOnboardingSuggestionQueue(skipped, live, true).visible.every(
        ({ step }) => step.kind === 'advanced-prompt',
      ),
    ).toBe(true);
  });

  it('omits mobile when the shared promo gate is false, including activated accounts', () => {
    expect(
      deriveOnboardingChecklist(
        persisted(),
        liveInputs({ mobileAppPromoEligible: false }),
      ).some(({ entryId }) => entryId === 'mobile-app'),
    ).toBe(false);
  });

  it('shows three distinct connected tools and rotates unused tools forward as examples resolve', () => {
    const live = liveInputs({
      selectedRoles: ['software-engineer'],
      pluginSuggestions: ['gmail', 'slack', 'notion', 'google-drive'].map(
        (name) => pluginInput(name, { enabled: true }),
      ),
    });
    let state = persisted(
      Object.fromEntries(
        deriveOnboardingChecklist(persisted(), live).map(({ entryId }) => [
          entryId,
          { completedAt: 'x' },
        ]),
      ),
    );
    const first = deriveOnboardingSuggestionQueue(state, live, true).visible;
    expect(
      first.map(({ step }) =>
        step.kind === 'advanced-prompt' ? step.tool.pluginName : null,
      ),
    ).toEqual(['gmail', 'slack', 'notion']);
    state = withEntryCompleted(state, first[0].entryId, 'x');
    const next = deriveOnboardingSuggestionQueue(state, live, true).visible;
    expect(
      next.map(({ step }) =>
        step.kind === 'advanced-prompt' ? step.tool.pluginName : null,
      ),
    ).toEqual(['slack', 'notion', 'google-drive']);
    state = withEntryDismissed(state, next[0].entryId, 'x');
    expect(
      deriveOnboardingSuggestionQueue(state, live, true).visible.map(
        ({ entryId }) => entryId,
      ),
    ).not.toContain(first[0].entryId);
  });
  it('omits evidence-only recovery steps while keeping fixable readiness steps', () => {
    const live = liveInputs({
      selectedRoles: ['software-engineer'],
      readiness: {
        workspaceId: 'ws-1',
        issues: [
          {
            code: 'recovery-required',
            title: 'Recover interrupted worktree creation',
            message: 'Review retained checkout',
            repoName: 'app',
            fixPrompt: null,
          },
          {
            code: 'configure-hooks',
            title: 'Add repository hooks',
            message: 'Missing hooks',
            repoName: 'app',
            fixPrompt: 'Configure hooks',
          },
        ],
      },
    });
    const resolved = persisted(
      Object.fromEntries(
        deriveOnboardingChecklist(persisted(), live).map(({ entryId }) => [
          entryId,
          { completedAt: 'x' },
        ]),
      ),
    );
    const queue = deriveOnboardingSuggestionQueue(resolved, live, true);
    expect(
      queue.checklist.filter(({ step }) => step.kind === 'advanced-readiness'),
    ).toMatchObject([
      { entryId: 'advanced:readiness:ws-1:app:configure-hooks' },
    ]);
  });

  it('puts repo setup fixes before advanced project examples on the technical path', () => {
    const live = liveInputs({
      selectedRoles: ['software-engineer'],
      hasCodeWorkspace: true,
      github: 'connected',
      readiness: {
        workspaceId: 'ws-1',
        issues: [
          {
            code: 'configure-scripts',
            title: 'Add setup and launch scripts',
            message: 'Missing scripts',
            repoName: 'app',
            fixPrompt: 'Add scripts',
          },
        ],
      },
    });
    const resolved = persisted(
      Object.fromEntries(
        deriveOnboardingChecklist(persisted(), live).map((entry) => [
          entry.entryId,
          { completedAt: 'x' },
        ]),
      ),
    );
    const queue = deriveOnboardingSuggestionQueue(resolved, live, true);
    expect(queue.visible[0]).toMatchObject({
      entryId: 'advanced:readiness:ws-1:app:configure-scripts',
      step: { kind: 'advanced-readiness' },
    });
    expect(queue.checklist.at(-1)?.entryId).toBe('advanced:github:4');
    const nontechnical = deriveOnboardingSuggestionQueue(
      resolved,
      { ...live, selectedRoles: ['student'] },
      true,
    );
    expect(
      nontechnical.checklist.some((entry) =>
        entry.entryId.startsWith('advanced:readiness:'),
      ),
    ).toBe(false);
    expect(
      nontechnical.checklist.some(
        (entry) => entry.entryId === 'advanced:project',
      ),
    ).toBe(false);
  });

  it('falls back to generic developer examples and prefers connected tools', () => {
    expect(
      advancedOnboardingPrompts(liveInputs())
        .slice(0, 3)
        .map((prompt) => prompt.text),
    ).toEqual([
      'Explain the architecture of this codebase',
      'Find and fix a small bug worth cleaning up',
      'Review my latest changes and suggest fixes',
    ]);
    expect(
      advancedOnboardingPrompts(
        liveInputs({
          hasCodeWorkspace: true,
          github: 'connected',
          linear: 'connected',
        }),
      ).map((p) => p.id),
    ).toEqual([
      'github:0',
      'linear:0',
      'github:1',
      'linear:1',
      'github:2',
      'linear:2',
      'github:3',
      'linear:3',
      'github:4',
    ]);
    expect(
      advancedOnboardingPrompts(liveInputs({ linear: 'connected' })).some(
        (p) => p.requiresCodeWorkspace,
      ),
    ).toBe(false);
  });
  it('requires enabled plugins and honors role filtering', () => {
    const prompts = advancedOnboardingPrompts(
      liveInputs({
        selectedRoles: ['designer'],
        pluginSuggestions: [
          pluginInput('notion', { enabled: true }),
          pluginInput('slack'),
          pluginInput('datadog', { enabled: true }),
        ],
      }),
    );
    expect(prompts.map((p) => p.id)).toEqual([
      'plugin:curated/notion:0',
      'plugin:curated/notion:1',
      'plugin:curated/notion:2',
    ]);
  });
  it('excludes connected developer tools from the advanced queue for nontechnical roles', () => {
    const live = liveInputs({
      selectedRoles: ['designer', 'marketing-sales'],
      hasCodeWorkspace: true,
      github: 'connected',
      linear: 'connected',
      pluginSuggestions: [
        pluginInput('notion', { enabled: true }),
        pluginInput('datadog', { enabled: true }),
        pluginInput('vercel', { enabled: true }),
      ],
    });
    const entries = Object.fromEntries(
      deriveOnboardingChecklist(persisted(), live).map(({ entryId }) => [
        entryId,
        { completedAt: 'x' },
      ]),
    );
    expect(
      deriveOnboardingSuggestionQueue(
        persisted(entries),
        live,
        true,
      ).visible.map(({ entryId }) => entryId),
    ).toEqual([
      'advanced:plugin:curated/notion:0',
      'advanced:plugin:curated/notion:1',
      'advanced:plugin:curated/notion:2',
    ]);
    expect(
      advancedOnboardingPrompts({
        ...live,
        selectedRoles: ['designer', 'software-engineer'],
      })
        .slice(0, 5)
        .map(({ tool }) => tool.pluginName),
    ).toEqual(['github', 'linear', 'notion', 'datadog', 'vercel']);
  });
});

describe('shared suggestion window', () => {
  it('shows one setup step and backfills after completion and dismissal', () => {
    let state = persisted();
    const live = liveInputs();
    const ids = (): string[] =>
      deriveOnboardingSuggestionQueue(state, live, true).visible.map(
        (row) => row.entryId,
      );
    expect(ids()).toEqual(['agent-connections']);
    state = withEntryCompleted(state, 'agent-connections', 'x');
    expect(ids()).toEqual(['add-repo']);
    state = withEntryDismissed(state, 'github', 'x');
    expect(ids()).toEqual(['add-repo']);
    expect(
      deriveOnboardingSuggestionQueue(state, live, true).completedCount,
    ).toBe(2);
  });

  it('groups only consecutive interchangeable suggestions and stops at a setup step', () => {
    const state = persisted({
      'agent-connections': { completedAt: 'x' },
      'add-repo': { completedAt: 'x' },
    });
    const live = liveInputs({ github: 'connected', hasCodeWorkspace: true });
    expect(
      deriveOnboardingSuggestionQueue(state, live, true).visible.map(
        (row) => row.entryId,
      ),
    ).toEqual(['github']);
  });

  it('keeps all connected and unconnected plugins in the single tools row', () => {
    const plugins = ['a', 'b', 'c', 'd'].map((name) =>
      pluginInput(name, { enabled: true }),
    );
    plugins.push(pluginInput('e'));
    const queue = deriveOnboardingSuggestionQueue(
      persisted({
        'agent-connections': { completedAt: 'x' },
        'add-repo': { completedAt: 'x' },
      }),
      liveInputs({ pluginSuggestions: plugins }),
      true,
    );
    expect(queue.visible.map((row) => row.entryId)).toEqual(['github']);
    const tools = queue.visible[0].step;
    if (tools.kind !== 'connect-tools') throw new Error('tools step');
    expect(
      tools.tools.slice(-5).map(({ key, connected }) => [key, connected]),
    ).toEqual([
      ['plugin:curated/a', true],
      ['plugin:curated/b', true],
      ['plugin:curated/c', true],
      ['plugin:curated/d', true],
      ['plugin:curated/e', false],
    ]);
  });

  it('names the added repository in the connected GitHub TODO prompt', () => {
    const queue = deriveOnboardingSuggestionQueue(
      persisted({
        'agent-connections': { completedAt: 'x' },
        'add-repo': { completedAt: 'x' },
      }),
      liveInputs({
        hasCodeWorkspace: true,
        latestRepoName: 'canopy',
        github: 'connected',
      }),
      true,
    );
    const github = queue.checklist
      .flatMap((view) =>
        view.step.kind === 'plugin-examples-preview' ? view.step.tools : [],
      )
      .find((tool) => tool.key === 'github');
    expect(github?.promptTexts[0]).toBe(
      'Find a simple TODO in canopy and implement it',
    );
  });

  it('keeps a long catalog inside the bounded tools step', () => {
    const plugins = Array.from({ length: 80 }, (_, index) =>
      pluginInput(`tool-${index}`),
    );
    const queue = deriveOnboardingSuggestionQueue(
      persisted({
        'agent-connections': { completedAt: 'x' },
        'add-repo': { completedAt: 'x' },
      }),
      liveInputs({ pluginSuggestions: plugins }),
      true,
    );
    expect(queue.visible.map((row) => row.entryId)).toEqual(['github']);
    const tools = queue.visible[0].step;
    if (tools.kind !== 'connect-tools') throw new Error('tools step');
    expect(tools.tools).toHaveLength(81);
  });

  it('uses the same dismissal and completion lifecycle for advanced examples', () => {
    const state = persisted(
      Object.fromEntries(
        [
          'agent-connections',
          'add-repo',
          'github',
          'plugin-examples-preview',
          'plan-mode',
          'linear',
          'focus-shortcut',
        ].map((id) => [id, { dismissedAt: 'x' }]),
      ),
    );
    expect(
      deriveOnboardingSuggestionQueue(state, liveInputs(), false).visible,
    ).toEqual([]);
    const live = liveInputs({
      pluginSuggestions: [pluginInput('slack', { enabled: true })],
    });
    const queue = deriveOnboardingSuggestionQueue(state, live, true);
    expect(queue.visible[0].entryId).toBe('advanced:plugin:curated/slack:0');
    const completed = withEntryCompleted(
      state,
      'advanced:plugin:curated/slack:0',
      'x',
    );
    expect(
      deriveOnboardingSuggestionQueue(completed, live, true).visible.map(
        (view) => view.entryId,
      ),
    ).toEqual([
      'advanced:plugin:curated/slack:1',
      'advanced:plugin:curated/slack:2',
    ]);
    expect(
      deriveOnboardingSuggestionQueue(
        withEntryDismissed(completed, 'advanced:plugin:curated/slack:1', 'x'),
        live,
        true,
      ).visible.map((view) => view.entryId),
    ).toEqual(['advanced:plugin:curated/slack:2']);
  });
});

describe('focus-shortcut entry (CAN-1963)', () => {
  it('offers the enable step with the shortcut label when the OS shortcut is off', () => {
    const views = deriveOnboardingChecklist(
      persisted(),
      liveInputs({
        focusShortcut: { enabled: false, registered: false, shortcut: '⌘⇧O' },
      }),
    );

    expect(
      views.find((view) => view.entryId === 'focus-shortcut')?.step,
    ).toEqual({ kind: 'enable-focus-shortcut', shortcut: '⌘⇧O' });
  });

  it('sits after plan mode, with the tour immediately afterward', () => {
    const queue = deriveOnboardingSuggestionQueue(
      persisted({
        'add-repo': { dismissedAt: 'x' },
        github: { dismissedAt: 'x' },
        'agent-connections': { dismissedAt: 'x' },
        'plan-mode': { dismissedAt: 'x' },
        linear: { dismissedAt: 'x' },
      }),
      liveInputs({
        pluginSuggestions: [
          pluginInput('slack', { key: 'universal:slack' }),
          pluginInput('notion'),
        ],
      }),
      true,
    );

    expect(queue.checklist.map((view) => view.entryId)).toEqual([
      'agent-connections',
      'add-repo',
      'github',
      'plan-mode',
      'focus-shortcut',
    ]);
  });

  it('completes once the shortcut is on and the OS accepted it', () => {
    // Someone who turned it on in Settings has nothing left to be asked.
    const views = deriveOnboardingChecklist(
      persisted(),
      liveInputs({
        focusShortcut: { enabled: true, registered: true, shortcut: '⌘⇧O' },
      }),
    );

    expect(
      views.find((view) => view.entryId === 'focus-shortcut')?.status,
    ).toBe('completed');
  });

  it('offers a change-shortcut step when the chord is on but another app holds it', () => {
    const views = deriveOnboardingChecklist(
      persisted(),
      liveInputs({
        focusShortcut: { enabled: true, registered: false, shortcut: '⌘⇧O' },
      }),
    );

    expect(
      views.find((view) => view.entryId === 'focus-shortcut')?.step,
    ).toEqual({ kind: 'focus-shortcut-blocked', shortcut: '⌘⇧O' });
    expect(
      views.find((view) => view.entryId === 'focus-shortcut')?.status,
    ).toBe('pending');
  });

  it('stays dismissed after the user dismisses it', () => {
    const views = deriveOnboardingChecklist(
      persisted({
        'focus-shortcut': { dismissedAt: '2026-09-10T00:00:00.000Z' },
      }),
      liveInputs(),
    );

    expect(
      views.find((view) => view.entryId === 'focus-shortcut')?.status,
    ).toBe('dismissed');
  });

  it('shows without a code project', () => {
    const views = deriveOnboardingChecklist(
      persisted(),
      liveInputs({ hasCodeWorkspace: false }),
    );

    expect(views.map((view) => view.entryId)).toContain('focus-shortcut');
  });
});

describe('launch-at-login entry (CAN-3449)', () => {
  const off = { supported: true, enabled: false, pendingApproval: false };

  it('is left out when the build cannot manage it', () => {
    for (const launchAtLogin of [
      undefined,
      { supported: false, enabled: false, pendingApproval: false },
    ]) {
      const views = deriveOnboardingChecklist(
        persisted(),
        liveInputs({ launchAtLogin }),
      );
      expect(views.map((view) => view.entryId)).not.toContain(
        'launch-at-login',
      );
    }
  });

  it('sits right after the focus shortcut, before the tour', () => {
    const views = deriveOnboardingChecklist(
      persisted(),
      liveInputs({ launchAtLogin: off }),
    );
    expect(views.map((view) => view.entryId)).toEqual([
      'agent-connections',
      'add-repo',
      'github',
      'plan-mode',
      'focus-shortcut',
      'launch-at-login',
    ]);
  });

  it('offers to turn it on while the OS will not open the app', () => {
    const view = deriveOnboardingChecklist(
      persisted(),
      liveInputs({ launchAtLogin: off }),
    ).find((entry) => entry.entryId === 'launch-at-login');
    expect(view).toMatchObject({
      status: 'pending',
      step: { kind: 'enable-launch-at-login' },
    });
  });

  it('completes once the OS will open the app', () => {
    // Someone who turned it on in Settings has nothing left to be asked.
    const view = deriveOnboardingChecklist(
      persisted(),
      liveInputs({ launchAtLogin: { ...off, enabled: true } }),
    ).find((entry) => entry.entryId === 'launch-at-login');
    expect(view?.status).toBe('completed');
  });

  it('points at System Settings while macOS waits for approval', () => {
    const view = deriveOnboardingChecklist(
      persisted(),
      liveInputs({ launchAtLogin: { ...off, pendingApproval: true } }),
    ).find((entry) => entry.entryId === 'launch-at-login');
    expect(view).toMatchObject({
      status: 'pending',
      step: { kind: 'launch-at-login-needs-approval' },
    });
  });

  it('stays completed after it is turned off again', () => {
    const view = deriveOnboardingChecklist(
      persisted({ 'launch-at-login': { completedAt: 'x' } }),
      liveInputs({ launchAtLogin: off }),
    ).find((entry) => entry.entryId === 'launch-at-login');
    expect(view?.status).toBe('completed');
  });

  it('stays dismissed after the user dismisses it', () => {
    const view = deriveOnboardingChecklist(
      persisted({
        'launch-at-login': { dismissedAt: '2026-09-29T00:00:00.000Z' },
      }),
      liveInputs({ launchAtLogin: off }),
    ).find((entry) => entry.entryId === 'launch-at-login');
    expect(view?.status).toBe('dismissed');
  });
});

describe('import-projects entry (CAN-2439)', () => {
  it('follows AI providers only when a Claude or Codex store exists locally', () => {
    const withStore = deriveOnboardingChecklist(
      persisted(),
      liveInputs({ providerStoresPresent: true }),
    );
    expect(withStore[0]?.entryId).toBe('agent-connections');
    expect(withStore[1]).toMatchObject({
      entryId: 'import-projects',
      step: { kind: 'import-projects-cta' },
      status: 'pending',
    });

    const withoutStore = deriveOnboardingChecklist(persisted(), liveInputs());
    expect(
      withoutStore.some((view) => view.entryId === 'import-projects'),
    ).toBe(false);
  });

  it('counts an imported or dismissed entry toward progress', () => {
    const completed = deriveOnboardingChecklist(
      persisted({ 'import-projects': { completedAt: 'x' } }),
      liveInputs({ providerStoresPresent: true }),
    );
    expect(completed[1]).toMatchObject({
      entryId: 'import-projects',
      status: 'completed',
    });
    const dismissed = deriveOnboardingChecklist(
      persisted({ 'import-projects': { dismissedAt: 'x' } }),
      liveInputs({ providerStoresPresent: true }),
    );
    expect(dismissed[1]?.status).toBe('dismissed');
  });
});

describe('import-editor-setup entry (CAN-2053)', () => {
  const editorSetup = (
    views: ReturnType<typeof deriveOnboardingChecklist>,
  ): ReturnType<typeof deriveOnboardingChecklist>[number] | undefined =>
    views.find((view) => view.entryId === 'import-editor-setup');

  it('is hidden until a code project reports Cursor rules', () => {
    expect(
      editorSetup(deriveOnboardingChecklist(persisted(), liveInputs())),
    ).toBeUndefined();
    expect(
      editorSetup(
        deriveOnboardingChecklist(
          persisted(),
          liveInputs({ cursorRulesPresent: false }),
        ),
      ),
    ).toBeUndefined();
  });

  it('offers the rules review when a code project has Cursor rules', () => {
    const views = deriveOnboardingChecklist(
      persisted(),
      liveInputs({ providerStoresPresent: true, cursorRulesPresent: true }),
    );
    const ids = views.map((view) => view.entryId);
    expect(ids.indexOf('import-editor-setup')).toBe(
      ids.indexOf('import-projects') + 1,
    );
    expect(editorSetup(views)).toMatchObject({
      step: { kind: 'import-editor-setup-cta' },
      status: 'pending',
    });
  });

  it('keeps a resolved entry while presence is unknown', () => {
    expect(
      editorSetup(
        deriveOnboardingChecklist(
          persisted({ 'import-editor-setup': { completedAt: 'x' } }),
          liveInputs(),
        ),
      )?.status,
    ).toBe('completed');
    expect(
      editorSetup(
        deriveOnboardingChecklist(
          persisted({ 'import-editor-setup': { dismissedAt: 'x' } }),
          liveInputs({ cursorRulesPresent: true }),
        ),
      )?.status,
    ).toBe('dismissed');
  });
});

describe('blueprint-tailored checklist (CAN-3032)', () => {
  const blueprint = (
    overrides: Partial<OnboardingBlueprintInputs> = {},
  ): OnboardingBlueprintInputs => ({
    projectId: 'marketing-1',
    name: 'Marketing',
    plugins: [
      pluginInput('builtin-git', {
        key: 'builtin/builtin-git',
        displayName: 'Git',
        enableKeys: ['builtin/builtin-git'],
      }),
      pluginInput('slack', { displayName: 'Slack', enabled: true }),
    ],
    starterPrompts: [
      { id: 'ws-1', text: 'Draft a launch announcement' },
      { id: 'ws-2', text: 'Turn this brief into a content calendar' },
    ],
    ...overrides,
  });

  it('leads with the project template plugins and starter prompts, keyed per project', () => {
    const checklist = deriveOnboardingChecklist(
      persisted(),
      liveInputs({ blueprint: blueprint() }),
    );
    expect(checklist.slice(0, 4)).toEqual([
      {
        entryId: 'blueprint:marketing-1:plugin:builtin-git',
        blueprint: { projectId: 'marketing-1', name: 'Marketing' },
        status: 'pending',
        step: {
          kind: 'plugin-add',
          pluginKey: 'builtin/builtin-git',
          pluginName: 'builtin-git',
          displayName: 'Git',
          description: 'builtin-git plugin',
          enableKeys: ['builtin/builtin-git'],
          searchQuery: 'builtin-git',
        },
      },
      {
        entryId: 'blueprint:marketing-1:plugin:slack',
        blueprint: { projectId: 'marketing-1', name: 'Marketing' },
        // Already enabled: reflected as done rather than asked again.
        status: 'completed',
        step: {
          kind: 'plugin-add',
          pluginKey: 'curated/slack',
          pluginName: 'slack',
          displayName: 'Slack',
          description: 'slack plugin',
          enableKeys: ['curated/slack'],
          searchQuery: 'slack',
        },
      },
      {
        entryId: 'blueprint:marketing-1:prompt:ws-1',
        blueprint: { projectId: 'marketing-1', name: 'Marketing' },
        status: 'pending',
        step: {
          kind: 'prompt',
          label: 'Draft a launch announcement',
          promptText: 'Draft a launch announcement',
        },
      },
      {
        entryId: 'blueprint:marketing-1:prompt:ws-2',
        blueprint: { projectId: 'marketing-1', name: 'Marketing' },
        status: 'pending',
        step: {
          kind: 'prompt',
          label: 'Turn this brief into a content calendar',
          promptText: 'Turn this brief into a content calendar',
        },
      },
    ]);
    // The general checklist follows, unchanged.
    expect(checklist[4]?.entryId).toBe('agent-connections');
    expect(checklist[4]?.blueprint).toBeUndefined();
  });

  it('shows the pending plugin rows first, then the starter prompts', () => {
    const live = liveInputs({ blueprint: blueprint() });
    const first = deriveOnboardingSuggestionQueue(persisted(), live, true);
    expect(first.visible.map((view) => view.entryId)).toEqual([
      'blueprint:marketing-1:plugin:builtin-git',
    ]);
    const afterPlugin = deriveOnboardingSuggestionQueue(
      withEntryCompleted(
        persisted(),
        'blueprint:marketing-1:plugin:builtin-git',
        'x',
      ),
      live,
      true,
    );
    expect(afterPlugin.visible.map((view) => view.entryId)).toEqual([
      'blueprint:marketing-1:prompt:ws-1',
      'blueprint:marketing-1:prompt:ws-2',
    ]);
    expect(afterPlugin.completedCount).toBe(2);
  });

  it('honors dismissal and completion per project', () => {
    const live = liveInputs({ blueprint: blueprint() });
    const state = withEntryDismissed(
      withEntryCompleted(persisted(), 'blueprint:marketing-1:prompt:ws-1', 'x'),
      'blueprint:marketing-1:plugin:builtin-git',
      'x',
    );
    const checklist = deriveOnboardingChecklist(state, live);
    expect(
      checklist.find(
        (view) => view.entryId === 'blueprint:marketing-1:plugin:builtin-git',
      )?.status,
    ).toBe('dismissed');
    expect(
      checklist.find(
        (view) => view.entryId === 'blueprint:marketing-1:prompt:ws-1',
      )?.status,
    ).toBe('completed');
    // Another project seeded from the same template starts fresh.
    const other = deriveOnboardingChecklist(
      state,
      liveInputs({ blueprint: blueprint({ projectId: 'marketing-2' }) }),
    );
    expect(other[0]).toMatchObject({
      entryId: 'blueprint:marketing-2:plugin:builtin-git',
      status: 'pending',
    });
  });

  it('does not offer a template plugin again in the general tools step', () => {
    const slack = pluginInput('slack', { displayName: 'Slack' });
    const notion = pluginInput('notion', { displayName: 'Notion' });
    const checklist = deriveOnboardingChecklist(
      persisted(),
      liveInputs({
        selectedRoles: ['marketing'],
        pluginSuggestions: [slack, notion],
        blueprint: blueprint({ plugins: [slack], starterPrompts: [] }),
      }),
    );
    const tools = checklist.find((view) => view.entryId === 'github');
    expect(tools?.step.kind).toBe('connect-tools');
    expect(
      tools?.step.kind === 'connect-tools'
        ? tools.step.tools.map((tool) => tool.pluginName)
        : [],
    ).toEqual(['notion']);
    expect(checklist[0]).toMatchObject({
      entryId: 'blueprint:marketing-1:plugin:slack',
    });
  });

  it('never shows tailored and general rows in one window', () => {
    // The template's last starter prompt would otherwise share its window
    // with the general first prompt under the template heading.
    const state = persisted({
      roles: { completedAt: 'x' },
      'add-repo': { completedAt: 'x' },
      github: { completedAt: 'x' },
      'agent-connections': { completedAt: 'x' },
    });
    const live = liveInputs({
      selectedRoles: ['marketing'],
      blueprint: blueprint({
        plugins: [],
        starterPrompts: [{ id: 'ws-1', text: 'Draft a launch announcement' }],
      }),
    });
    const queue = deriveOnboardingSuggestionQueue(state, live, true);
    expect(queue.visible.map((view) => view.entryId)).toEqual([
      'blueprint:marketing-1:prompt:ws-1',
    ]);
    // Once the tailored rows are done, the general prompt leads on its own.
    const after = deriveOnboardingSuggestionQueue(
      withEntryCompleted(state, 'blueprint:marketing-1:prompt:ws-1', 'x'),
      live,
      true,
    );
    expect(after.visible[0]).toMatchObject({ entryId: 'plan-mode' });
    expect(after.visible.every((view) => view.blueprint === undefined)).toBe(
      true,
    );
  });

  it('makes each template group one step of up to three rows', () => {
    // The window shows a step's rows together, so Next and Back move
    // between whole steps and the counter counts each once.
    const live = liveInputs({
      blueprint: blueprint({
        plugins: ['a', 'b', 'c', 'd'].map((name) => pluginInput(name)),
      }),
    });
    const checklist = deriveOnboardingChecklist(persisted(), live);
    const steps = onboardingChecklistSteps(checklist);
    expect(
      steps.slice(0, 3).map((step) => step.map((view) => view.entryId)),
    ).toEqual([
      [
        'blueprint:marketing-1:plugin:a',
        'blueprint:marketing-1:plugin:b',
        'blueprint:marketing-1:plugin:c',
      ],
      ['blueprint:marketing-1:plugin:d'],
      [
        'blueprint:marketing-1:prompt:ws-1',
        'blueprint:marketing-1:prompt:ws-2',
      ],
    ]);
    // General entries stay one step each, in checklist order.
    expect(steps.slice(3).flat()).toEqual(checklist.slice(6));
    expect(steps.slice(3).every((step) => step.length === 1)).toBe(true);
  });

  it('shows the pending rows of the template step that leads', () => {
    const live = liveInputs({
      blueprint: blueprint({
        plugins: ['a', 'b', 'c', 'd'].map((name) => pluginInput(name)),
      }),
    });
    const afterA = deriveOnboardingSuggestionQueue(
      withEntryCompleted(persisted(), 'blueprint:marketing-1:plugin:a', 'x'),
      live,
      true,
    );
    // The step's remaining rows, not a window sliding into the next step.
    expect(afterA.visible.map((view) => view.entryId)).toEqual([
      'blueprint:marketing-1:plugin:b',
      'blueprint:marketing-1:plugin:c',
    ]);
    const afterStep = deriveOnboardingSuggestionQueue(
      withEntryDismissed(
        withEntryDismissed(
          withEntryCompleted(
            persisted(),
            'blueprint:marketing-1:plugin:a',
            'x',
          ),
          'blueprint:marketing-1:plugin:b',
          'x',
        ),
        'blueprint:marketing-1:plugin:c',
        'x',
      ),
      live,
      true,
    );
    expect(afterStep.visible.map((view) => view.entryId)).toEqual([
      'blueprint:marketing-1:plugin:d',
    ]);
  });

  it('keeps one row per starter prompt id', () => {
    const rows = deriveOnboardingChecklist(
      persisted(),
      liveInputs({
        blueprint: blueprint({
          plugins: [],
          starterPrompts: [
            { id: 'ws-1', text: 'Draft a launch announcement' },
            { id: 'ws-1', text: 'Draft it again' },
            { id: 'ws-2', text: 'Plan the week' },
          ],
        }),
      }),
    ).filter((view) => view.blueprint !== undefined);
    expect(rows.map((view) => view.entryId)).toEqual([
      'blueprint:marketing-1:prompt:ws-1',
      'blueprint:marketing-1:prompt:ws-2',
    ]);
  });

  it('caps the starter prompt items and keeps the general checklist without a template', () => {
    const many = blueprint({
      plugins: [],
      starterPrompts: Array.from({ length: 6 }, (_, index) => ({
        id: `ws-${index + 1}`,
        text: `Prompt ${index + 1}`,
      })),
    });
    const capped = deriveOnboardingChecklist(
      persisted(),
      liveInputs({ blueprint: many }),
    ).filter((view) => view.blueprint !== undefined);
    expect(capped.map((view) => view.entryId)).toEqual(
      Array.from(
        { length: MAX_BLUEPRINT_STARTER_PROMPT_ITEMS },
        (_, index) => `blueprint:marketing-1:prompt:ws-${index + 1}`,
      ),
    );
    const general = deriveOnboardingChecklist(persisted(), liveInputs());
    expect(general[0]?.entryId).toBe('agent-connections');
    expect(general.every((view) => view.blueprint === undefined)).toBe(true);
  });
});

describe('daily-credits entry', () => {
  const undecided = {
    dailyCreditDrip: {
      state: 'undecided' as const,
      enabled: false,
      capCredits: 10,
    },
  };

  it('follows AI providers, ahead of import-projects, for an undecided user', () => {
    const views = deriveOnboardingChecklist(
      persisted(),
      liveInputs({ ...undecided, providerStoresPresent: true }),
    );
    expect(views.slice(0, 3).map((view) => view.entryId)).toEqual([
      'agent-connections',
      'daily-credits',
      'import-projects',
    ]);
    expect(views[1]).toMatchObject({
      status: 'pending',
      step: { kind: 'enable-daily-credits', capCredits: 10 },
    });
  });

  it('follows project template setup when a template is active', () => {
    const views = deriveOnboardingChecklist(
      persisted(),
      liveInputs({
        ...undecided,
        blueprint: {
          projectId: 'marketing-1',
          name: 'Marketing',
          plugins: [],
          starterPrompts: [{ id: 'intro', text: 'Draft an introduction' }],
        },
      }),
    );
    expect(views.slice(0, 3).map((view) => view.entryId)).toEqual([
      'blueprint:marketing-1:prompt:intro',
      'agent-connections',
      'daily-credits',
    ]);
  });

  it('falls back to the default cap when the cap is unknown', () => {
    const views = deriveOnboardingChecklist(
      persisted(),
      liveInputs({
        dailyCreditDrip: {
          state: 'undecided',
          enabled: false,
          capCredits: null,
        },
      }),
    );
    expect(views[1]?.step).toEqual({
      kind: 'enable-daily-credits',
      capCredits: DEFAULT_DAILY_DRIP_CAP_CREDITS,
    });
  });

  it.each([true, false])(
    'is complete once decided, whichever way (enabled: %s)',
    (enabled) => {
      const views = deriveOnboardingChecklist(
        persisted(),
        liveInputs({
          dailyCreditDrip: { state: 'decided', enabled, capCredits: 10 },
        }),
      );
      expect(views[1]).toMatchObject({
        entryId: 'daily-credits',
        status: 'completed',
      });
    },
  );

  it.each(['unavailable', 'loading'] as const)(
    'is left out entirely while %s',
    (state) => {
      const live = liveInputs({
        dailyCreditDrip: { state, enabled: false, capCredits: null },
      });
      const queue = deriveOnboardingSuggestionQueue(persisted(), live, true);
      expect(
        queue.checklist.some((view) => view.entryId === 'daily-credits'),
      ).toBe(false);
      expect(
        queue.visible.some((view) => view.entryId === 'daily-credits'),
      ).toBe(false);
    },
  );

  it('does not count toward progress or hold back advanced prompts while unavailable', () => {
    // Every curated entry resolved; the opt-in is the only thing that could
    // block the advanced examples.
    const allResolved = persisted({
      roles: { completedAt: 'x' },
      'add-repo': { completedAt: 'x' },
      github: { completedAt: 'x' },
      'agent-connections': { completedAt: 'x' },
      'plan-mode': { completedAt: 'x' },
      linear: { completedAt: 'x' },
      notifications: { completedAt: 'x' },
      'focus-shortcut': { completedAt: 'x' },
    });
    const unavailable = deriveOnboardingSuggestionQueue(
      allResolved,
      liveInputs(),
      true,
    );
    const curated = unavailable.checklist.filter(
      (view) => view.step.kind !== 'advanced-prompt',
    );
    expect(unavailable.completedCount).toBe(curated.length);
    expect(
      unavailable.checklist.some(
        (view) => view.step.kind === 'advanced-prompt',
      ),
    ).toBe(true);

    // The same user, undecided: the card is the one open item and the
    // advanced examples wait for it.
    const pending = deriveOnboardingSuggestionQueue(
      allResolved,
      liveInputs(undecided),
      true,
    );
    expect(pending.visible[0]?.entryId).toBe('daily-credits');
    expect(
      pending.checklist.some((view) => view.step.kind === 'advanced-prompt'),
    ).toBe(false);
  });
});
