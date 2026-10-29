import { PROJECT_READ_ACTION_TYPES } from '../project-reads';
import { BOT_ACTION_TYPES } from '../bot-discovery';
import { CHAT_UNIT_LABEL } from '@canopy/protocol';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import {
  MEMBER_ORG_PROJECT_LIMIT,
  ORG_PROJECT_LIMITS,
} from '@canopy/protocol/org-projects';
import {
  APP_ADVISOR_ACTION_CATALOG,
  APP_ADVISOR_REVISION_AGNOSTIC_ACTION_TYPES,
  searchAppAdvisorActions,
  type SearchAppAdvisorActionsInput,
} from '../app-advisor-actions';
import { validateAutomationCreateRequest } from '../automations';
import { MAX_ARCHIVE_RETENTION_DAYS } from '../archive-retention';

describe('multi-repo project action discovery (CAN-3573)', () => {
  it.each([
    {
      type: 'workspace.create_multi_repo',
      query: 'create multi-repo project',
      requiredFields: ['name'],
      example: { type: 'workspace.create_multi_repo', name: 'Payments' },
    },
    {
      type: 'workspace.add_repo',
      query: 'add local repository to project',
      requiredFields: ['workspaceId', 'repoPath'],
      example: {
        type: 'workspace.add_repo',
        workspaceId: 'project-1',
        repoPath: '/path/to/payments',
      },
    },
    {
      type: 'workspace.remove_repo',
      query: 'remove repository from project',
      requiredFields: ['workspaceId', 'repoId'],
      example: {
        type: 'workspace.remove_repo',
        workspaceId: 'project-1',
        repoId: 'repo-1',
      },
    },
  ])(
    'discovers $type without an organization flag or revision exemption',
    ({ type, query, requiredFields, example }) => {
      const result = searchAppAdvisorActions({
        query,
        featureFlags: {
          [CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key]: false,
        },
      });
      expect(result.actions.map((action) => action.type)).toContain(type);
      const entry = result.actions.find((action) => action.type === type);
      expect(entry).toMatchObject({
        type,
        category: 'workspace',
        requiredFields,
        optionalFields: [],
        example,
      });
      expect(
        APP_ADVISOR_ACTION_CATALOG.find((action) => action.type === type)
          ?.requiredFeatureFlag,
      ).toBeUndefined();
      expect(APP_ADVISOR_REVISION_AGNOSTIC_ACTION_TYPES).not.toContain(type);
    },
  );

  it('documents the name and organization limits from shared constants', () => {
    const entry = APP_ADVISOR_ACTION_CATALOG.find(
      (action) => action.type === 'workspace.create_multi_repo',
    );
    expect(entry?.fields[0]?.description).toContain(
      String(ORG_PROJECT_LIMITS.nameLength),
    );
    expect(entry?.notes?.join(' ')).toContain(
      `up to ${MEMBER_ORG_PROJECT_LIMIT} private projects per organization`,
    );
  });
});

describe('App Advisor action catalog', () => {
  const replacedTypes = [
    'workspace.list',
    'workspace.list_worktrees',
    'worktree-chat.open_tab',
    'worktree-chat.list_tabs',
    'worktree-chat.send_message',
    'worktree-chat.steer_queued_message',
    'worktree-chat.schedule_message',
    'worktree-chat.get_last_user_message',
    'worktree-chat.get_last_agent_response',
    'worktree-chat.read_history',
    'standalone-chat.list_projects',
    'standalone-chat.list_chats',
    'standalone-chat.create_chat',
    'standalone-chat.send_message',
    'standalone-chat.get_last_user_message',
    'standalone-chat.get_last_agent_response',
    'standalone-chat.read_history',
    'advisor-chat.create_entry',
    'advisor-chat.create_chat',
    'advisor-chat.send_message',
  ] as const;

  it.each(replacedTypes)(
    'hides %s across discovery filters while retaining its catalog adapter',
    (type) => {
      const entry = APP_ADVISOR_ACTION_CATALOG.find(
        (candidate) => candidate.type === type,
      );
      expect(entry).toBeDefined();
      for (const input of [
        { actionType: type },
        { query: type },
        { category: entry?.category },
        { allowedActionTypes: [type] },
        { query: '' },
        { limit: 1 },
        { actionType: type, limit: 1, allowedActionTypes: [type] },
      ]) {
        const result = searchAppAdvisorActions({
          ...input,
          limit: input.limit ?? 50,
        });
        expect(
          result.actions.some((action) =>
            replacedTypes.some((hidden) => hidden === action.type),
          ),
        ).toBe(false);
        for (const action of result.actions) {
          expect(replacedTypes).not.toContain(action.example.type);
          for (const example of action.additionalExamples ?? []) {
            expect(replacedTypes).not.toContain(example.type);
          }
        }
      }
    },
  );

  it('filters compatibility rows before limits and advertises canonical and retained UI actions', () => {
    const result = searchAppAdvisorActions({
      allowedActionTypes: ['workspace.list', 'projects.list'],
      limit: 1,
    });
    expect(result.actions.map((entry) => entry.type)).toEqual([
      'projects.list',
    ]);
    expect(result.categories).not.toContain('advisor-chat');
    for (const type of [
      'projects.list',
      'projects.list_tasks',
      'projects.list_task_chats',
      'projects.get_last_user_message',
      'projects.get_last_agent_response',
      'projects.read_history',
      'projects.send_message',
      'projects.create_task',
      'bots.list',
      'bots.list_tasks',
      'bots.list_task_chats',
      'bots.send_message',
      'bots.create_task',
      'bots.create_task_chat',
      'workspace.list_join_options',
      'workspace.list_existing_worktree_join_options',
      'worktree-chat.switch_tab',
      'worktree-chat.set_model',
      'standalone-chat.get_settings',
    ]) {
      expect(
        searchAppAdvisorActions({ actionType: type }).actions.map(
          (entry) => entry.type,
        ),
      ).toContain(type);
    }
  });

  it.each([
    ['skills.open_manager', 'Open Customize with the Skills tab selected.'],
    [
      'skills.open_viewer',
      "Open an installed skill's Customize detail page, optionally on one of its supporting files.",
    ],
    [
      'skills.open_shared_viewer',
      'Open Customize, select the Skills tab, and show a shared skill in the read-only viewer.',
    ],
    [
      'skills.list_marketplace',
      'Find reviewed Anthropic and OpenAI skills in Customize on desktop. Open a returned entryId with plugins.open_entry_detail for source, license, setup and explicit installation.',
    ],
    [
      'plugins.open_marketplaces',
      'Open Customize with the Marketplaces tab selected.',
    ],
    [
      'plugins.open_mcp_browse',
      'Open Customize and search the curated MCP server (app) catalog.',
    ],
    [
      'collections.open_manager',
      'Open Customize with the Collections tab selected.',
    ],
    [
      'plugins.list_marketplaces',
      'List plugin marketplaces with provider validity, plugin counts, source, and provider errors.',
    ],
  ])(
    'describes %s with the correct section or source terminology',
    (type, summary) => {
      expect(
        searchAppAdvisorActions({ actionType: type }).actions[0],
      ).toMatchObject({
        type,
        summary,
      });
    },
  );

  it('names Customize in the legacy shared-automations navigation contract', () => {
    const navigation = APP_ADVISOR_ACTION_CATALOG.find(
      (entry) => entry.type === 'navigation.go_to_page',
    );
    expect(
      navigation?.fields.find((field) => field.name === 'tab')?.description,
    ).toContain(
      'shared opens Customize → Automations filtered to Shared by me.',
    );
  });
  it('catalogs revision-independent delegation reads', () => {
    for (const type of [
      'delegation.tree',
      'delegation.roots',
      'delegation.transcript',
      'delegation.worktree_summary',
    ] as const) {
      expect(
        searchAppAdvisorActions({ actionType: type }).actions[0],
      ).toMatchObject({ type, category: 'delegation' });
      expect(APP_ADVISOR_REVISION_AGNOSTIC_ACTION_TYPES).toContain(type);
    }
  });

  describe('snapshot-driven page discovery', () => {
    const searchNavigation = (
      availablePages?: readonly string[],
    ):
      | ReturnType<typeof searchAppAdvisorActions>['actions'][number]
      | undefined => {
      const input = { actionType: 'navigation.go_to_page', availablePages };
      return searchAppAdvisorActions(input).actions[0];
    };

    it('intersects available pages with valid targets and hides the Settings alias', () => {
      const action = searchNavigation([
        'home',
        'workers',
        'notice-states',
        'mcp-account-connections',
        'unknown',
        'agents',
        'home',
      ]);
      expect(action?.fields.find((field) => field.name === 'page')?.type).toBe(
        "'home' | 'workers' | 'notice-states'",
      );
      expect(action?.summary).not.toMatch(/Workers|Agents|More menu/);
      expect(action?.example).toEqual({
        type: 'navigation.go_to_page',
        page: 'home',
      });
      expect(
        action?.fields.find((field) => field.name === 'page')?.description,
      ).toContain('mcp-account-connections');
    });

    it('omits gated choices and Agents actions when availability is unknown', () => {
      const action = searchNavigation();
      expect(
        action?.fields.find((field) => field.name === 'page')?.type,
      ).not.toMatch(/agents|workers|states|change-review/);
      expect(
        action?.fields
          .find((field) => field.name === 'page')
          ?.type.split(' | '),
      ).not.toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^'(overview|kanban|statistics|audit)'$/),
        ]),
      );
      expect(searchAppAdvisorActions({ category: 'agents' }).actions).toEqual(
        [],
      );
      expect(
        searchAppAdvisorActions({ actionType: 'pipeline.debug_run' }).actions,
      ).toHaveLength(1);
    });

    it.each([{ count: 20 }, 'home,agents,workers', 12, null])(
      'treats malformed snapshot availability as unknown: %j',
      (availablePages) => {
        const input: SearchAppAdvisorActionsInput = {};
        Object.defineProperty(input, 'availablePages', {
          value: availablePages,
          enumerable: true,
        });
        const result = searchAppAdvisorActions({
          ...input,
          actionType: 'navigation.go_to_page',
        });
        expect(
          result.actions[0]?.fields.find((field) => field.name === 'page')
            ?.type,
        ).not.toMatch(/agents|workers|states|change-review/);
        expect(
          searchAppAdvisorActions({ ...input, category: 'agents' }).actions,
        ).toEqual([]);
        expect(
          searchAppAdvisorActions({
            ...input,
            actionType: 'pipeline.debug_run',
          }).actions,
        ).toHaveLength(1);
      },
    );

    it('keeps agent operations discoverable independently of page availability', () => {
      const before = JSON.stringify(APP_ADVISOR_ACTION_CATALOG);
      const input = {
        category: 'agents',
        availablePages: ['home'],
        featureFlags: {
          [CLIENT_FEATURE_FLAGS.canopySharedCustomAgents.key]: true,
        },
      };
      expect(
        searchAppAdvisorActions(input).actions.map((action) => action.type),
      ).toEqual(
        expect.arrayContaining(['agents.list', 'agents.get', 'agents.create']),
      );
      expect(
        searchAppAdvisorActions(input).actions.map((action) => action.type),
      ).not.toContain('agents.open_manager');
      expect(
        searchAppAdvisorActions({
          ...input,
          availablePages: ['home', 'plugins'],
        }).actions.map((action) => action.type),
      ).toContain('agents.open_manager');
      expect(
        searchAppAdvisorActions(input).actions.map((action) => action.type),
      ).not.toContain('agents.open_manager');
      expect(JSON.stringify(APP_ADVISOR_ACTION_CATALOG)).toBe(before);
    });

    it.each([false, undefined])(
      'hides all agent actions when the flag is %s',
      (enabled) => {
        expect(
          searchAppAdvisorActions({
            category: 'agents',
            availablePages: ['home', 'agents', 'plugins'],
            featureFlags: {
              [CLIENT_FEATURE_FLAGS.canopySharedCustomAgents.key]: enabled,
            },
          }).actions,
        ).toEqual([]);
      },
    );

    it.each([undefined, [], ['home'], ['home', 'agents']])(
      'preserves non-navigation agent operations with pages %j',
      (availablePages) => {
        const result = searchAppAdvisorActions({
          category: 'agents',
          availablePages,
          featureFlags: {
            [CLIENT_FEATURE_FLAGS.canopySharedCustomAgents.key]: true,
          },
          limit: 50,
        });
        expect(result.actions.map((action) => action.type)).toEqual(
          APP_ADVISOR_ACTION_CATALOG.filter(
            (entry) =>
              entry.type.startsWith('agents.') &&
              entry.type !== 'agents.open_manager',
          ).map((entry) => entry.type),
        );
      },
    );

    it.each([
      'workers',
      'header-states',
      'worktree-states',
      'activity-states',
      'message-bubble-states',
      'change-review',
      'notice-states',
    ])('discovers %s only when the renderer lists it', (page) => {
      expect(
        searchNavigation(['home', page])?.fields.find(
          (field) => field.name === 'page',
        )?.type,
      ).toContain(`'${page}'`);
      expect(
        searchNavigation(['home'])?.fields.find(
          (field) => field.name === 'page',
        )?.type,
      ).not.toContain(`'${page}'`);
    });

    it('does not offer navigation when a fresh list has no valid destinations', () => {
      expect(searchNavigation([])).toBeUndefined();
      expect(searchNavigation(['unknown'])).toBeUndefined();
      // The retired Agents page (CAN-4266) is not a destination even when a
      // stale renderer still lists it.
      expect(searchNavigation(['agents'])).toBeUndefined();
    });
  });
  it('catalogs background-process inspection and control', () => {
    expect(
      searchAppAdvisorActions({
        actionType: 'worktree-chat.list_background_processes',
      }).actions[0],
    ).toMatchObject({
      type: 'worktree-chat.list_background_processes',
      category: 'worktree-chat',
    });
    expect(
      searchAppAdvisorActions({
        actionType: 'worktree-chat.stop_background_process',
      }).actions[0],
    ).toMatchObject({
      type: 'worktree-chat.stop_background_process',
      category: 'worktree-chat',
    });
    expect(APP_ADVISOR_REVISION_AGNOSTIC_ACTION_TYPES).toContain(
      'worktree-chat.list_background_processes',
    );
    expect(APP_ADVISOR_REVISION_AGNOSTIC_ACTION_TYPES).not.toContain(
      'worktree-chat.stop_background_process',
    );
  });

  it('catalogs user stops for managed delegations', () => {
    for (const type of ['delegation.stop', 'delegation.stop_all'] as const) {
      expect(
        searchAppAdvisorActions({ actionType: type }).actions[0],
      ).toMatchObject({ type, category: 'delegation' });
      expect(APP_ADVISOR_REVISION_AGNOSTIC_ACTION_TYPES).not.toContain(type);
    }
    expect(
      searchAppAdvisorActions({ actionType: 'delegation.stop' }).actions[0],
    ).toMatchObject({
      requiredFields: ['projectId', 'worktreeId', 'chatId', 'delegationId'],
    });
    expect(
      searchAppAdvisorActions({ category: 'delegations' }).actions.map(
        (entry) => entry.type,
      ),
    ).toEqual([
      'delegation.tree',
      'delegation.roots',
      'delegation.transcript',
      'delegation.worktree_summary',
      'delegation.stop',
      'delegation.read_changes',
      'delegation.stop_all',
    ]);
    expect(
      searchAppAdvisorActions({ query: 'stop all delegates' }).actions.map(
        (entry) => entry.type,
      ),
    ).toContain('delegation.stop_all');
    expect(
      searchAppAdvisorActions({ query: 'stop delegated task' }).actions.map(
        (entry) => entry.type,
      ),
    ).toContain('delegation.stop');
  });

  it("catalogs a read-only view of an isolated delegate's changes", () => {
    expect(
      searchAppAdvisorActions({ actionType: 'delegation.read_changes' })
        .actions[0],
    ).toMatchObject({
      category: 'delegation',
      requiredFields: ['projectId', 'worktreeId', 'delegationId', 'revision'],
    });
    expect(APP_ADVISOR_REVISION_AGNOSTIC_ACTION_TYPES).toContain(
      'delegation.read_changes',
    );
    expect(
      searchAppAdvisorActions({ query: 'delegate changes diff' }).actions.map(
        (entry) => entry.type,
      ),
    ).toContain('delegation.read_changes');
  });

  it.each([
    'schedule',
    'scheduled task',
    'recurring',
    'reminder',
    'remind me tomorrow',
    'please remind me tomorrow',
    'remind me next week',
  ])(
    'discovers automation creation in the default result window for %s',
    (query): void => {
      expect(
        searchAppAdvisorActions({ query }).actions.map((entry) => entry.type),
      ).toContain('automation.create');
    },
  );

  it('preserves short action words and explicit action/category filters', () => {
    const result = searchAppAdvisorActions({ query: 'pr', limit: 100 });
    expect(result.actions[0].type.split(/[._-]/)).toContain('pr');
    expect(
      searchAppAdvisorActions({
        query: 'remind me tomorrow',
        category: 'automations',
      }).actions.map((entry) => entry.type),
    ).toContain('automation.create');
    expect(
      searchAppAdvisorActions({
        query: 'remind me tomorrow',
        actionType: 'automation.create',
      }).actions.map((entry) => entry.type),
    ).toEqual(['automation.create']);
  });

  it('discovers the exact automation creation payload without a query', (): void => {
    const result = searchAppAdvisorActions({ actionType: 'automation.create' });
    expect(result.actions.map((entry) => entry.type)).toEqual([
      'automation.create',
    ]);
    expect(result.actions[0]?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'input',
          type: 'AutomationCreateRequest',
          required: true,
        }),
      ]),
    );
  });

  it('documents navigation to a curated pipeline preview', () => {
    const entry = APP_ADVISOR_ACTION_CATALOG.find(
      (action) => action.type === 'pipeline.open_curated_preview',
    );
    expect(entry).toMatchObject({
      category: 'pipeline',
      example: { type: 'pipeline.open_curated_preview', key: 'review-code' },
    });
    expect(entry?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'key', required: true }),
      ]),
    );
  });

  it('discovers the workspace context switch action (CAN-2952)', () => {
    const result = searchAppAdvisorActions({
      query: 'switch to my organization context',
    });
    expect(result.actions.map((action) => action.type)).toContain(
      'workspace_context.switch',
    );
    const entry = APP_ADVISOR_ACTION_CATALOG.find(
      (action) => action.type === 'workspace_context.switch',
    );
    expect(entry?.requiredFeatureFlag).toBe(
      CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
    );
    expect(entry?.category).toBe('navigation');
    expect(entry?.example).toEqual({
      type: 'workspace_context.switch',
      context: { kind: 'personal' },
    });
  });

  it('filters workspace context switches when organization projects are disabled', (): void => {
    const result = searchAppAdvisorActions({
      query: 'switch to my organization context',
      featureFlags: {
        [CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key]: false,
      },
    });
    expect(result.actions.map((action) => action.type)).not.toContain(
      'workspace_context.switch',
    );
  });

  it('discovers the file explorer search action', () => {
    const result = searchAppAdvisorActions({
      query: 'filter files in the explorer',
    });

    expect(result.actions.map((action) => action.type)).toContain(
      'file-tree.set_search',
    );
  });

  it('discovers active preview search drawer actions', () => {
    const result = searchAppAdvisorActions({
      query: 'open find in active file preview',
    });

    expect(result.actions.map((action) => action.type)).toContain(
      'file.preview_search_open',
    );
    expect(
      searchAppAdvisorActions({
        query: 'close preview search drawer',
      }).actions.map((action) => action.type),
    ).toContain('file.preview_search_close');
  });

  it('discovers file explorer mutation actions', () => {
    const queries = [
      ['create file in the explorer', 'file-tree.create_file'],
      ['create directory in the explorer', 'file-tree.create_directory'],
      ['copy file in the explorer', 'file-tree.copy'],
      ['move file in the explorer', 'file-tree.move'],
      ['delete file in the explorer', 'file-tree.delete'],
    ] as const;

    for (const [query, actionType] of queries) {
      expect(
        searchAppAdvisorActions({ query }).actions.map((action) => action.type),
      ).toContain(actionType);
    }
  });

  it('discovers repository readiness inspection and fix actions', () => {
    const fixResult = searchAppAdvisorActions({
      query: 'fix project readiness',
    });
    const readResult = searchAppAdvisorActions({
      query: 'audit repository setup',
    });

    expect(fixResult.actions.map((action) => action.type)).toContain(
      'workspace.start_readiness_fix',
    );
    expect(readResult.actions.map((action) => action.type)).toContain(
      'workspace.read_readiness',
    );
  });

  it('discovers the project panel layout mode action', () => {
    const result = searchAppAdvisorActions({
      query: 'switch project panel layout mode',
    });

    expect(result.actions.map((action) => action.type)).toContain(
      'panel.set_layout_mode',
    );
  });

  it('advertises the same optional project scope on every browser action', () => {
    const browserActions = APP_ADVISOR_ACTION_CATALOG.filter((entry) =>
      entry.type.startsWith('browser.'),
    );

    expect(browserActions.length).toBeGreaterThan(0);
    for (const action of browserActions) {
      expect(action.fields.map((field) => field.name)).toEqual(
        expect.arrayContaining(['projectId', 'worktreeId']),
      );
      expect(
        action.fields
          .filter(
            (field) =>
              field.name === 'projectId' || field.name === 'worktreeId',
          )
          .every((field) => field.required === false),
      ).toBe(true);
    }
  });

  it('includes every dispatchable action type once', () => {
    const types = APP_ADVISOR_ACTION_CATALOG.map((entry) => entry.type);

    expect(new Set(types).size).toBe(types.length);
    expect(types).toEqual(
      expect.arrayContaining([
        'navigation.go_to_page',
        'ollama.install',
        'usage.open_resume_modal',
        'usage.open_resume_queue',
        'usage.control_resume_queue',
        'memory.import_external',
        'memory.consolidate_now',
        'memory.rebuild',
        'memory.list_snapshots',
        'memory.restore_snapshot',
        'skills.open_manager',
        'skills.open_viewer',
        'skills.open_shared_viewer',
        'skills.list',
        'skills.read',
        'skills.read_file',
        'skills.create_custom',
        'skills.update_custom',
        'skills.delete_custom',
        'skills.read_shared',
        'plugins.open_marketplaces',
        'plugins.open_mcp_browse',
        'plugins.open_management',
        'plugins.list_marketplaces',
        'plugins.refresh_marketplace',
        'plugins.remove_marketplace',
        'collections.open_manager',
        'collections.list',
        'collections.create',
        'collections.update',
        'collections.delete',
        'collections.share',
        'collections.list_shared',
        'collections.import_shared',
        'collections.update_shared',
        'collections.delete_shared',
        'agents.open_manager',
        'agents.list',
        'agents.get',
        'agents.create',
        'agents.update',
        'agents.delete',
        'agents.list_shared',
        'agents.import_shared',
        'agents.delete_shared',
        'agents.publish_public_share',
        'agents.revoke_public_share',
        'workspace.list',
        'workspace.list_worktrees',
        'workspace.list_join_options',
        'workspace.list_existing_worktree_join_options',
        'worktree.archive',
        'worktree.create',
        'worktree.create_from',
        'worktree.set_base_branch',
        'worktree.resolve_branch_from_confirmation',
        'worktree.add_workspace',
        'worktree.add_existing_worktree',
        'workspace.get_settings',
        'workspace.update_local_settings',
        'workspace.apply_source_edits',
        'workspace.promote_temporary',
        'worktree.list_git_actions',
        'worktree.run_git_action',
        'worktree.cancel_git_action',
        'github.split_pr',
        'worktree-chat.open_tab',
        'worktree-chat.list_tabs',
        'worktree-chat.retry_state_refresh',
        'worktree-chat.dismiss_state_notice',
        'worktree-chat.switch_tab',
        'worktree-chat.run_chat_action',
        'worktree-chat.send_message',
        'worktree-chat.schedule_message',
        'worktree-chat.get_last_user_message',
        'worktree-chat.get_last_agent_response',
        'worktree-chat.read_history',
        'worktree-chat.set_plan_mode',
        'worktree-chat.set_interface_mode',
        'worktree-chat.set_fast_mode',
        'worktree-chat.set_speed',
        'worktree-chat.set_model',
        'worktree-chat.set_thinking_level',
        'worktree-chat.list_plugins',
        'worktree-chat.update_plugin_selection',
        'worktree-chat.set_plugin_selections',
        'standalone-chat.list_projects',
        'standalone-chat.list_chats',
        'standalone-chat.switch_project',
        'standalone-chat.switch_chat',
        'standalone-chat.create_chat',
        'standalone-chat.rename_work_entry',
        'standalone-chat.delete_work_entry',
        'standalone-chat.send_message',
        'standalone-chat.get_last_user_message',
        'standalone-chat.get_last_agent_response',
        'standalone-chat.read_history',
        'standalone-chat.list_prompts',
        'standalone-chat.get_prompt',
        'standalone-chat.list_notes',
        'standalone-chat.get_note',
        'standalone-chat.list_attachments',
        'standalone-chat.get_attachment',
        'standalone-chat.get_settings',
        'standalone-chat.update_settings',
        'pipeline.list',
        'pipeline.get',
        'pipeline.create',
        'pipeline.update',
        'pipeline.delete',
        'pipeline.duplicate',
        'pipeline.share',
        'pipeline.update_shared',
        'pipeline.delete_shared',
        'pipeline.set_enabled',
        'pipeline.debug_run',
        'pipeline.execution_list',
        'pipeline.execution_get',
        'pipeline.execution_chain',
        'browser.list',
        'browser.open',
        'browser.inspect',
        'browser.get_console',
        'browser.get_network',
        'browser.screenshot',
        'browser.start_recording',
        'browser.stop_recording',
        'file.send_selection_to_chat',
        'file.save_active',
        'panel.split',
        'panel.focus',
        'panel.close',
        'panel.maximize',
        'panel.add_tab',
        'panel.move',
        'panel.arrange',
        'panel.save_default_layout',
        'canopy_cloud.load_account',
        'canopy_cloud.validate_api_key',
        'canopy_cloud.save_api_key',
        'canopy_cloud.clear_api_key',
        'canopy_portal.open_account_settings',
        'app_advisor.toggle',
        'watcher.list',
        'watcher.get',
        'watcher.delete',
        'automation.open_editor',
        'automation.open_shared_pipeline_review',
        'automation.list',
        'automation.get',
        'automation.create',
        'automation.update',
        'automation.disable',
        'automation.delete',
        'automation.run_now',
      ]),
    );
  });

  it('discovers the external memory import action', () => {
    const result = searchAppAdvisorActions({
      query: 'import memories from Claude Code',
    });

    expect(result.actions.map((action) => action.type)).toContain(
      'memory.import_external',
    );
  });

  it('discovers the manual memory consolidation action', () => {
    const result = searchAppAdvisorActions({ query: 'consolidate memory' });
    expect(result.actions.map((action) => action.type)).toContain(
      'memory.consolidate_now',
    );
  });

  it('discovers the memory snapshot actions', () => {
    const types = searchAppAdvisorActions({
      query: 'memory snapshots',
    }).actions.map((action) => action.type);
    expect(types).toContain('memory.list_snapshots');
    expect(types).toContain('memory.restore_snapshot');
    expect(
      searchAppAdvisorActions({ query: 'restore memory' }).actions.map(
        (action) => action.type,
      ),
    ).toContain('memory.restore_snapshot');
  });

  it('requires a current revision for a memory restore but not a snapshot list', () => {
    expect(APP_ADVISOR_REVISION_AGNOSTIC_ACTION_TYPES).toContain(
      'memory.list_snapshots',
    );
    expect(APP_ADVISOR_REVISION_AGNOSTIC_ACTION_TYPES).not.toContain(
      'memory.restore_snapshot',
    );
    expect(APP_ADVISOR_REVISION_AGNOSTIC_ACTION_TYPES).not.toContain(
      'memory.rebuild',
    );
  });

  it('discovers the curated MCP browser action', () => {
    const result = searchAppAdvisorActions({ query: 'browse mcp servers' });
    expect(result.actions.map((entry) => entry.type)).toContain(
      'plugins.open_mcp_browse',
    );
  });

  it('discovers the installed-plugin management action with its sections', () => {
    const result = searchAppAdvisorActions({
      query: 'manage installed plugins',
    });
    const entry = result.actions.find(
      (candidate) => candidate.type === 'plugins.open_management',
    );
    expect(entry).toBeDefined();
    expect(entry?.category).toBe('plugins');
    expect(entry?.requiredFields).toEqual([]);
    const catalogEntry = APP_ADVISOR_ACTION_CATALOG.find(
      (candidate) => candidate.type === 'plugins.open_management',
    );
    expect(
      catalogEntry?.fields.find((field) => field.name === 'section')
        ?.description,
    ).toContain('marketplaces');
  });

  it('discovers the Plugins entry-detail navigation action', () => {
    const result = searchAppAdvisorActions({ query: 'open plugin detail' });
    const entry = result.actions.find(
      (candidate) => candidate.type === 'plugins.open_entry_detail',
    );
    expect(entry).toBeDefined();
    expect(entry?.requiredFields).toEqual(['entryId']);
  });

  it('finds the native Ollama installation action', () => {
    const result = searchAppAdvisorActions({
      query: 'install native ollama',
    });

    expect(result.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'ollama.install',
          category: 'ollama',
          requiredFields: [],
        }),
      ]),
    );
  });

  it('offers the Agents add to the Feed action only while the Ledger flag is on', () => {
    const query = 'stop agents recording in the ledger';
    const types = (
      flags: Record<string, boolean | undefined> | undefined,
    ): string[] =>
      searchAppAdvisorActions({ query, featureFlags: flags }).actions.map(
        (action) => action.type,
      );

    expect(types({ 'canopy-ledger-enabled': true })).toContain(
      'settings.set_ledger_agent_recording_enabled',
    );
    expect(types({ 'canopy-ledger-enabled': false })).not.toContain(
      'settings.set_ledger_agent_recording_enabled',
    );
    expect(APP_ADVISOR_REVISION_AGNOSTIC_ACTION_TYPES).toContain(
      'settings.set_ledger_agent_recording_enabled',
    );
  });

  it('hides skill suggestion actions while their flag is off (CAN-385)', () => {
    const types = (
      flags: Record<string, boolean | undefined> | undefined,
    ): string[] =>
      searchAppAdvisorActions({
        query: 'skill suggestions',
        featureFlags: flags,
      }).actions.map((action) => action.type);
    const all = [
      'settings.set_skill_suggestions_enabled',
      'skill_suggestions.list',
      'skill_suggestions.open',
    ];
    const on = types({ 'canopy-desktop-skill-suggestions': true });
    const off = types({ 'canopy-desktop-skill-suggestions': false });
    for (const type of all) {
      expect(on).toContain(type);
      expect(off).not.toContain(type);
      expect(APP_ADVISOR_REVISION_AGNOSTIC_ACTION_TYPES).toContain(type);
    }
  });

  it('finds the local memory settings actions', () => {
    const toggleResult = searchAppAdvisorActions({
      query: 'disable local memory',
    });
    const folderResult = searchAppAdvisorActions({
      query: 'open memory folder',
    });

    expect(toggleResult.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'settings.set_local_memory_enabled',
          category: 'settings',
          requiredFields: ['enabled'],
        }),
      ]),
    );
    expect(folderResult.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'settings.open_memory_folder',
          category: 'settings',
          requiredFields: [],
        }),
      ]),
    );
    expect(APP_ADVISOR_REVISION_AGNOSTIC_ACTION_TYPES).toEqual(
      expect.arrayContaining([
        'settings.set_local_memory_enabled',
        'settings.open_memory_folder',
      ]),
    );
  });

  it.each([
    'open the app when I sign in',
    'start automatically at startup',
    'login items',
  ])('finds the launch at sign-in action for %p', (query) => {
    const result = searchAppAdvisorActions({ query });

    expect(result.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'settings.set_launch_at_login',
          category: 'settings',
          requiredFields: ['enabled'],
        }),
      ]),
    );
    expect(APP_ADVISOR_REVISION_AGNOSTIC_ACTION_TYPES).toContain(
      'settings.set_launch_at_login',
    );
  });

  it('finds the managed consultation settings action', () => {
    const result = searchAppAdvisorActions({
      query: 'turn off read-only consultation',
    });

    expect(result.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'settings.set_managed_delegation_mode',
          category: 'settings',
          requiredFields: ['mode'],
        }),
      ]),
    );
    expect(APP_ADVISOR_REVISION_AGNOSTIC_ACTION_TYPES).toContain(
      'settings.set_managed_delegation_mode',
    );

    const depthResult = searchAppAdvisorActions({
      query: 'maximum nested delegation depth',
    });
    expect(depthResult.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'settings.set_managed_delegation_max_depth',
          category: 'settings',
          requiredFields: ['maxDepth'],
        }),
      ]),
    );
    expect(APP_ADVISOR_REVISION_AGNOSTIC_ACTION_TYPES).toContain(
      'settings.set_managed_delegation_max_depth',
    );
  });

  it('routes local memory queries to settings navigation', () => {
    const result = searchAppAdvisorActions({
      query: 'local memory experiments settings',
      limit: 10,
    });

    expect(result.actions.map((action) => action.type)).toContain(
      'navigation.open_settings',
    );
  });

  it('finds the editor selection-to-chat action', () => {
    const result = searchAppAdvisorActions({
      query: 'send highlighted editor selection to composer',
    });

    expect(result.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'file.send_selection_to_chat',
          category: 'file',
          requiredFields: [],
        }),
      ]),
    );
  });

  it('finds the interrupted-session resume action', () => {
    const result = searchAppAdvisorActions({
      query: 'resume interrupted Claude sessions',
    });

    expect(result.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'usage.open_resume_modal',
          category: 'usage',
          requiredFields: [],
        }),
      ]),
    );
  });

  it('finds durable resume queue actions', () => {
    const result = searchAppAdvisorActions({ query: 'pause resume queue' });
    expect(result.actions.map((action) => action.type)).toEqual(
      expect.arrayContaining([
        'usage.open_resume_queue',
        'usage.control_resume_queue',
      ]),
    );
  });

  it('finds panel grid actions by user-facing terms and category', () => {
    const queryResult = searchAppAdvisorActions({
      query: 'split panel group side by side',
    });
    expect(queryResult.actions.map((action) => action.type)).toContain(
      'panel.split',
    );

    const categoryResult = searchAppAdvisorActions({
      category: 'panels',
      limit: 20,
    });
    expect(categoryResult.actions.map((action) => action.type)).toEqual(
      expect.arrayContaining([
        'panel.split',
        'panel.focus',
        'panel.close',
        'panel.maximize',
        'panel.add_tab',
        'panel.move',
        'panel.arrange',
        'panel.save_default_layout',
      ]),
    );

    const split = categoryResult.actions.find(
      (action) => action.type === 'panel.split',
    );
    expect(split?.requiredFields).toEqual(['direction']);
    expect(split?.optionalFields).toEqual(['groupId']);

    const move = categoryResult.actions.find(
      (action) => action.type === 'panel.move',
    );
    expect(move?.requiredFields).toEqual(
      expect.arrayContaining(['panelId', 'targetGroupId', 'edge']),
    );

    const addTab = categoryResult.actions.find(
      (action) => action.type === 'panel.add_tab',
    );
    expect(
      addTab?.fields.find((field) => field.name === 'kind')?.type,
    ).toContain("'terminal'");
    expect(
      addTab?.fields.find((field) => field.name === 'kind')?.type,
    ).toContain("'usage'");
    expect(addTab?.fields.find((field) => field.name === 'variant')?.type).toBe(
      "'all' | 'active-chat' | 'codex' | 'claude' | 'cursor' | 'copilot' | 'full' | 'upcoming' | 'overview' | 'completed'",
    );
    expect(addTab?.fields.map((field) => field.name)).toEqual(
      expect.arrayContaining([
        'chatTabId',
        'fileTabId',
        'filePath',
        'sectionId',
      ]),
    );
    expect(addTab?.additionalExamples).toEqual(
      expect.arrayContaining([
        { type: 'panel.add_tab', kind: 'chat', chatTabId: 'chat-123' },
        {
          type: 'panel.add_tab',
          kind: 'activity-card',
          sectionId: 'changed-files',
        },
        { type: 'panel.add_tab', kind: 'usage', variant: 'all' },
        { type: 'panel.add_tab', kind: 'usage', variant: 'active-chat' },
        { type: 'panel.add_tab', kind: 'usage', variant: 'codex' },
        { type: 'panel.add_tab', kind: 'usage', variant: 'claude' },
        { type: 'panel.add_tab', kind: 'usage', variant: 'cursor' },
        { type: 'panel.add_tab', kind: 'usage', variant: 'copilot' },
        { type: 'panel.add_tab', kind: 'automations', variant: 'full' },
        { type: 'panel.add_tab', kind: 'automations', variant: 'upcoming' },
        { type: 'panel.add_tab', kind: 'automations', variant: 'overview' },
        { type: 'panel.add_tab', kind: 'automations', variant: 'completed' },
      ]),
    );

    expect(addTab?.notes?.join(' ')).toContain(
      "The 'cursor' and 'copilot' variants require their harness rollouts to be enabled.",
    );

    const saveDefault = searchAppAdvisorActions({
      query: 'save current layout as default for new worktrees',
      category: 'panels',
      limit: 10,
    });
    expect(saveDefault.actions.map((action) => action.type)).toContain(
      'panel.save_default_layout',
    );
  });

  it('documents the automations navigation page on navigation.go_to_page', () => {
    const entry = APP_ADVISOR_ACTION_CATALOG.find(
      (candidate) => candidate.type === 'navigation.go_to_page',
    );
    expect(entry).toBeDefined();
    const pageField = entry?.fields.find((f) => f.name === 'page');
    expect(pageField?.type).toContain("'automations'");
  });

  it('advertises branch grouping through worktree settings actions', () => {
    const result = searchAppAdvisorActions({
      query: 'ungroup child branches branch grouping override',
      category: 'worktree',
      limit: 10,
    });

    expect(result.actions.map((action) => action.type)).toEqual(
      expect.arrayContaining([
        'worktree.get_settings',
        'worktree.update_settings',
      ]),
    );
    const updateAction = result.actions.find(
      (action) => action.type === 'worktree.update_settings',
    );
    expect(updateAction?.fields.map((field) => field.name)).toContain(
      'branchGroupingOverride',
    );
  });

  it('exposes hook trigger discovery for hook pause/resume actions', () => {
    const result = searchAppAdvisorActions({
      query: 'pause PR comments hook',
      category: 'hook',
      limit: 10,
    });

    const pauseAction = result.actions.find(
      (action) => action.type === 'hook.pause',
    );
    expect(pauseAction?.hookTriggers?.[0]).toMatchObject({
      triggerName: 'pr:update:comments',
      title: 'PR Comments Updated',
      hookKeyExamples: {
        project: 'project:pr:update:comments',
        workspaceRoot: 'workspace-root:pr:update:comments',
        workspaceRepoPattern: 'workspace-repo:<repoId>:pr:update:comments',
      },
    });
    expect(pauseAction?.notes?.join(' ')).toContain('hookKeyExamples');

    const resumeResult = searchAppAdvisorActions({
      query: 'resume inline review comments hook',
      category: 'hook',
      limit: 10,
    });
    const resumeAction = resumeResult.actions.find(
      (action) => action.type === 'hook.resume',
    );
    expect(
      resumeAction?.hookTriggers?.some(
        (entry) => entry.triggerName === 'pr:reviews:new:has-comments',
      ),
    ).toBe(true);
  });

  it('defaults the worktree chat interface-mode example to canopy', () => {
    const entry = APP_ADVISOR_ACTION_CATALOG.find(
      (candidate) => candidate.type === 'worktree-chat.set_interface_mode',
    );

    expect(entry?.example).toMatchObject({
      type: 'worktree-chat.set_interface_mode',
      mode: 'canopy',
    });
  });

  it('exposes watcher management and automation actions with the expected fields', () => {
    const watcherResult = searchAppAdvisorActions({
      query: 'watcher notify delete',
      limit: 20,
    });
    expect(watcherResult.actions.map((action) => action.type)).toEqual(
      expect.arrayContaining(['watcher.list', 'watcher.get', 'watcher.delete']),
    );

    const scheduledMessageResult = searchAppAdvisorActions({
      query:
        'schedule response current existing worktree chat scheduled message continue',
      category: 'projects',
      limit: 10,
    });
    expect(scheduledMessageResult.actions.map((action) => action.type)).toEqual(
      expect.arrayContaining(['projects.schedule_message']),
    );

    const scheduleMessageEntry = APP_ADVISOR_ACTION_CATALOG.find(
      (entry) => entry.type === 'worktree-chat.schedule_message',
    );
    expect(scheduleMessageEntry?.summary).toContain('(worktree)');
    expect(scheduleMessageEntry?.summary).toContain(CHAT_UNIT_LABEL);
    expect(scheduleMessageEntry?.fields.map((f) => f.name)).toEqual([
      'projectId',
      'worktreeId',
      'chatId',
      'text',
      'runAt',
      'timezone',
      'name',
      'fileReferences',
      'attachmentPaths',
      'attachmentPromptContexts',
      'inputMode',
    ]);
    expect(scheduleMessageEntry?.notes?.join(' ')).toContain(
      'not automation.create with worktree_prompt',
    );

    const result = searchAppAdvisorActions({
      category: 'automations',
      limit: 50,
    });
    const automations = result.actions.filter((action) =>
      action.type.startsWith('automation.'),
    );
    expect(automations.map((action) => action.type)).toEqual(
      expect.arrayContaining([
        'automation.open_shared_pipeline_review',
        'automation.list',
        'automation.get',
        'automation.create',
        'automation.update',
        'automation.disable',
        'automation.delete',
        'automation.run_now',
      ]),
    );

    const reviewEntry = APP_ADVISOR_ACTION_CATALOG.find(
      (entry) => entry.type === 'automation.open_shared_pipeline_review',
    );
    expect(reviewEntry?.summary).toContain('review');
    expect(reviewEntry?.example).toEqual({
      type: 'automation.open_shared_pipeline_review',
      id: 'activity-1',
    });

    const createEntry = APP_ADVISOR_ACTION_CATALOG.find(
      (entry) => entry.type === 'automation.create',
    );
    expect(createEntry?.example).toMatchObject({
      type: 'automation.create',
      input: {
        name: 'Daily standup prep',
        schedule: { kind: 'cron', timezone: 'local' },
        action: { type: 'app_advisor_prompt' },
      },
    });
    expect(createEntry?.summary).toContain('automation-owned worktree');
    expect(createEntry?.summary).toContain(
      'directory-scoped at the cowork root',
    );
    expect(createEntry?.notes?.join(' ')).toContain(
      'chatProjectId IS the cowork project id',
    );
    expect(createEntry?.notes?.join(' ')).toContain(
      'runs the pipeline directory-scoped at the cowork root without creating a worktree',
    );
    expect(
      createEntry?.additionalExamples?.some((example) => {
        const serialized = JSON.stringify(example);
        return (
          serialized.includes('"type":"worktree_pipeline"') &&
          serialized.includes('"workspaceId":"cowork-workspace-1"')
        );
      }),
    ).toBe(true);
    expect(createEntry?.notes?.join(' ')).toContain(
      'not a scheduled send into an existing chat tab/session',
    );
    expect(createEntry?.notes?.join(' ')).toContain(
      'use projects.schedule_message instead',
    );
    expect(createEntry?.summary).not.toContain('If Command');
    expect(createEntry?.fields[0]?.description).toContain('ifCommand');
    expect(createEntry?.fields.map((field) => field.name)).toEqual([
      'input',
      'watchers',
    ]);
    expect(createEntry?.fields[1]?.description).toContain(
      'Include only when the user explicitly asks to watch, wait, or be notified',
    );
    expect(createEntry?.example).not.toHaveProperty('watchers');
    expect(createEntry?.keywords).toEqual(
      expect.arrayContaining(['ifCommand']),
    );
    expect(createEntry?.notes?.join(' ')).toContain(
      'cannot configure an If Command gate',
    );
    expect(createEntry?.notes?.join(' ')).toContain(
      'sidebarGroupName is an optional destination-local group name',
    );
    expect(createEntry?.notes?.join(' ')).toContain(
      'not included in a shared automation document',
    );
    expect(
      createEntry?.additionalExamples?.some((example) => {
        return (
          example.type === 'automation.create' &&
          'ifCommand' in example.input &&
          example.input.ifCommand === 'test -f package.json'
        );
      }),
    ).toBe(false);

    const updateEntry = APP_ADVISOR_ACTION_CATALOG.find(
      (entry) => entry.type === 'automation.update',
    );
    expect(updateEntry?.fields.map((f) => f.name)).toEqual(['id', 'patch']);
    expect(updateEntry?.summary).toContain(
      'existing scheduled worktree chat messages',
    );
    expect(updateEntry?.summary).not.toContain('If Command');
    expect(updateEntry?.fields[1]?.description).toContain('ifCommand');
    expect(updateEntry?.fields[1]?.description).toContain(
      'only enabled: false is allowed',
    );
    expect(updateEntry?.notes?.join(' ')).toContain(
      'prompt, fileReferences, attachmentPaths, attachmentPromptContexts, inputMode',
    );
    expect(updateEntry?.notes?.join(' ')).toContain(
      'cannot add or replace an If Command gate',
    );
    expect(updateEntry?.notes?.join(' ')).toContain('sidebarGroupName');
    expect(updateEntry?.notes?.join(' ')).toContain(
      'only enabled: false is allowed',
    );
    expect(updateEntry?.notes?.join(' ')).not.toContain(
      'omit it to preserve the current gate',
    );
    expect(updateEntry?.additionalExamples?.[0]).toMatchObject({
      type: 'automation.update',
      patch: {
        schedule: { kind: 'one_time', timezone: 'local' },
        action: { type: 'worktree_session_prompt', purpose: 'scheduled_send' },
      },
    });

    const runNowEntry = APP_ADVISOR_ACTION_CATALOG.find(
      (entry) => entry.type === 'automation.run_now',
    );
    expect(runNowEntry?.fields.map((f) => f.name)).toEqual(['id', 'watchers']);
    if (runNowEntry?.example.type !== 'automation.run_now') {
      throw new Error('Expected an automation.run_now catalog example');
    }
    expect(runNowEntry?.fields[1]?.description).toContain(
      'Include only when the user explicitly asks to watch, wait, or be notified',
    );
    expect(runNowEntry.example).not.toHaveProperty('watchers');
  });

  it('finds automation If Command gate support by user-facing terms', () => {
    const result = searchAppAdvisorActions({
      query: 'add if command gate condition before running automation',
      category: 'automations',
      limit: 10,
    });

    expect(result.actions.map((action) => action.type)).toEqual(
      expect.arrayContaining([
        'automation.list',
        'automation.get',
        'automation.create',
        'automation.update',
      ]),
    );
    const createAction = result.actions.find(
      (action) => action.type === 'automation.create',
    );
    expect(createAction).toBeDefined();
    expect(createAction?.notes?.join(' ')).toContain(
      'cannot configure an If Command gate',
    );
  });

  it('returns an exact action type even when category uses a common alias', () => {
    const result = searchAppAdvisorActions({
      actionType: 'automation.create',
      category: 'automation',
      limit: 5,
    });

    expect(result.totalMatches).toBe(1);
    expect(result.actions[0]?.type).toBe('automation.create');
  });

  it('finds browser control and diagnostics actions', () => {
    const result = searchAppAdvisorActions({
      query:
        'browser inspect input controls console network screenshot recording',
      category: 'browser',
      limit: 20,
    });

    expect(result.categories).toContain('browser');
    expect(result.actions.map((action) => action.type)).toEqual(
      expect.arrayContaining([
        'browser.inspect',
        'browser.input_snapshot',
        'browser.get_console',
        'browser.get_network',
        'browser.screenshot',
        'browser.start_recording',
        'browser.stop_recording',
      ]),
    );
  });

  it('catalogs focus and waits with action budgets and retry keys', () => {
    for (const actionType of [
      'browser.click',
      'browser.fill',
      'browser.press',
      'browser.set_checked',
      'browser.select_option',
      'browser.type',
      'browser.hover',
      'browser.scroll',
      'browser.drag',
      'browser.focus',
      'browser.wait_for',
    ]) {
      const entry = searchAppAdvisorActions({ actionType }).actions[0];
      expect(entry?.type).toBe(actionType);
      expect(entry?.fields.map((field) => field.name)).toEqual(
        expect.arrayContaining(['actionId', 'timeoutMs']),
      );
      const timeout = entry?.fields.find((field) => field.name === 'timeoutMs');
      expect(timeout?.description).toContain(
        actionType === 'browser.wait_for' ? '10,000' : '5,000',
      );
      expect(timeout?.description).toContain(
        actionType === 'browser.wait_for' ? '120,000' : '60,000',
      );
    }
    const click = searchAppAdvisorActions({ actionType: 'browser.click' })
      .actions[0];
    expect(click?.fields.map((field) => field.name)).toEqual(
      expect.arrayContaining([
        'button',
        'clickCount',
        'modifiers',
        'position',
        'force',
      ]),
    );
    expect(click?.notes?.join(' ')).toContain('actionability');
    expect(click?.notes?.join(' ')).toContain('force: true');
    expect(click?.notes?.join(' ')).toContain('original result');
    expect(click?.notes?.join(' ')).toContain('different arguments');
    const wait = searchAppAdvisorActions({ actionType: 'browser.wait_for' })
      .actions[0];
    expect(wait?.fields.map((field) => field.name)).toEqual(
      expect.arrayContaining(['locator', 'text', 'url', 'loadState', 'state']),
    );
    expect(wait?.notes?.join(' ')).toContain('exactly one');
  });

  it('catalogs searchable form-control actions and their safe alternatives', () => {
    const actions = [
      {
        type: 'browser.set_checked',
        query: 'check checkbox radio switch checked state',
        keywords: ['checkbox', 'radio', 'switch'],
        fields: ['checked', 'ref', 'locator', 'frame'],
      },
      {
        type: 'browser.select_option',
        query: 'choose select option dropdown combobox labels values',
        keywords: ['select', 'option', 'dropdown', 'combobox'],
        fields: ['values', 'labels', 'indexes', 'searchText', 'ref', 'locator'],
      },
      {
        type: 'browser.type',
        query: 'type masked password autocomplete key events',
        keywords: ['type', 'masked', 'password', 'autocomplete'],
        fields: ['text', 'delayMs', 'ref', 'locator', 'frame'],
      },
    ];

    for (const action of actions) {
      expect(
        searchAppAdvisorActions({
          query: action.query,
          category: 'browser',
          limit: 50,
        }).actions.map((entry) => entry.type),
      ).toContain(action.type);

      const entry = APP_ADVISOR_ACTION_CATALOG.find(
        (candidate) => candidate.type === action.type,
      );
      expect(entry?.category).toBe('browser');
      expect(entry?.summary.length).toBeGreaterThan(0);
      expect(entry?.example.type).toBe(action.type);
      expect(entry?.example).toMatchObject({ expectedRuntimeGeneration: 1 });
      expect(entry?.keywords).toEqual(expect.arrayContaining(action.keywords));
      expect(entry?.fields.map((field) => field.name)).toEqual(
        expect.arrayContaining([...action.fields, 'actionId', 'timeoutMs']),
      );
    }

    const notes = (actionType: string): string =>
      searchAppAdvisorActions({ actionType }).actions[0]?.notes?.join(' ') ??
      '';
    expect(notes('browser.set_checked')).toContain(
      'Use browser.set_checked instead of browser.click',
    );
    expect(notes('browser.select_option')).toContain(
      'Use browser.select_option instead of browser.click',
    );
    expect(notes('browser.select_option')).toContain(
      'never opens the native popup',
    );
    expect(notes('browser.type')).toContain('masked inputs and autocomplete');
    expect(notes('browser.type')).toContain('real key events');
    expect(notes('browser.type')).toContain('readback');

    const fillNotes = notes('browser.fill');
    expect(fillNotes).toContain('browser.set_checked');
    expect(fillNotes).toContain('browser.select_option');
    expect(fillNotes).toContain('editable combobox');
    expect(fillNotes).toContain('file input');
    expect(fillNotes).toContain(
      'ask the user to choose the file in the browser',
    );
    expect(fillNotes).toContain('readback');
    expect(fillNotes).toContain(
      'Wait for suggestions and click one instead of pressing Enter.',
    );

    const clickNotes = notes('browser.click');
    expect(clickNotes).toContain('browser.select_option');
    expect(clickNotes).toContain('file input');
    expect(clickNotes).toContain(
      'ask the user to choose the file in the browser',
    );
    expect(clickNotes).toContain('force: true');
    expect(clickNotes).toContain('A forced click is refused too.');
  });

  it('describes pre-armed dialog responses as optional browser action optimizations', () => {
    for (const actionType of ['browser.click', 'browser.press']) {
      const result = searchAppAdvisorActions({ actionType });
      const action = result.actions[0];
      const dialogResponseField = action?.fields.find(
        (field) => field.name === 'dialogResponse',
      );

      expect(dialogResponseField?.description).toContain('Optional pre-armed');
      expect(action?.notes?.join(' ')).toContain('browser.handle_dialog');
      expect(action?.notes?.join(' ')).toContain('promptText');
    }
  });

  it('validates every automation.create catalog example', () => {
    const createEntry = APP_ADVISOR_ACTION_CATALOG.find(
      (entry) => entry.type === 'automation.create',
    );
    const examples = [
      createEntry?.example,
      ...(createEntry?.additionalExamples ?? []),
    ];

    expect(examples.length).toBeGreaterThanOrEqual(5);
    for (const example of examples) {
      expect(example?.type).toBe('automation.create');
      if (example?.type !== 'automation.create') continue;
      expect(validateAutomationCreateRequest(example.input)).toBeNull();
    }
  });

  it('finds pipeline debug payload details by query', () => {
    const result = searchAppAdvisorActions({ query: 'debug failed pipeline' });

    expect(result.actions[0]?.type).toBe('pipeline.debug_run');
    expect(result.actions[0]?.requiredFields).toEqual(['executionId']);
    expect(result.actions[0]?.example).toEqual({
      type: 'pipeline.debug_run',
      executionId: 'execution-1',
    });
  });

  it('finds pipeline inspection and follow-up actions', () => {
    const result = searchAppAdvisorActions({
      query: 'pipeline execution report plan follow up chain',
      limit: 20,
    });

    expect(result.actions.map((action) => action.type)).toEqual(
      expect.arrayContaining([
        'pipeline.execution_list',
        'pipeline.execution_get',
        'pipeline.execution_read_report',
        'pipeline.execution_read_plan',
        'pipeline.execution_send_report_to_chat',
        'pipeline.execution_send_plan_to_chat',
        'pipeline.execution_chain',
      ]),
    );
  });

  it('finds selected paused-job resume action details', () => {
    const result = searchAppAdvisorActions({
      actionType: 'pipeline.execution_resume',
    });

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]?.requiredFields).toEqual(['executionId']);
    expect(result.actions[0]?.example).toEqual({
      type: 'pipeline.execution_resume',
      executionId: 'execution-1',
      statusReasonIds: ['123e4567-e89b-42d3-a456-426614174000'],
    });
    expect(result.actions[0]?.additionalExamples).toContainEqual({
      type: 'pipeline.execution_resume',
      executionId: 'execution-1',
      pauseResponses: [
        {
          checkpointId: 'checkpoint-1',
          jobId: 'review',
          stepId: 'approval',
          answers: { reviewer: 'Ada' },
        },
      ],
    });
    expect(result.actions[0]?.summary).toContain('automation-initiated');
    const pauseResponses = result.actions[0]?.fields.find(
      (field) => field.name === 'pauseResponses',
    );
    expect(pauseResponses?.type).toContain('checkpointId: string');
    expect(pauseResponses?.type).not.toContain('checkpointId?: string');
    expect(pauseResponses?.description).toContain('exact checkpointId');
  });

  it('finds matrix retry and cancellation action details', () => {
    const result = searchAppAdvisorActions({
      query: 'matrix retry failed variant cancel',
      limit: 20,
    });

    expect(result.actions.map((action) => action.type)).toEqual(
      expect.arrayContaining([
        'pipeline.execution_retry_matrix_job',
        'pipeline.execution_cancel_matrix_variant',
      ]),
    );
  });

  it('finds pipeline custom edit and sharing actions', () => {
    // The catalog now carries automation.share/.list_shared/.unshare, which
    // also match the share/publish terms; widen the window so the pipeline
    // actions this test pins remain within the result set.
    const result = searchAppAdvisorActions({
      query: 'custom shared pipeline create update share publish duplicate',
      category: 'pipeline',
      limit: 50,
    });

    expect(result.actions.map((action) => action.type)).toEqual(
      expect.arrayContaining([
        'pipeline.create',
        'pipeline.update',
        'pipeline.delete',
        'pipeline.duplicate',
        'pipeline.share',
        'pipeline.update_shared',
        'pipeline.delete_shared',
      ]),
    );
    for (const type of ['pipeline.create', 'pipeline.update']) {
      const entry = APP_ADVISOR_ACTION_CATALOG.find(
        (action) => action.type === type,
      );
      expect(entry?.notes?.join(' ')).toContain('rejects shell run steps');
      expect(JSON.stringify(entry?.example)).not.toContain('run:');
    }
  });

  it('offers only team and organization audiences for share actions', () => {
    const shareActions = APP_ADVISOR_ACTION_CATALOG.filter((action) =>
      [
        'skills.share_custom',
        'collections.share',
        'pipeline.share',
        'plan.share',
        'runs.share',
        'automation.share',
      ].includes(action.type),
    );

    expect(shareActions).not.toHaveLength(0);
    expect(JSON.stringify(shareActions)).not.toContain('private');
    for (const requiredType of ['pipeline.share']) {
      const scope = shareActions
        .find((action) => action.type === requiredType)
        ?.fields.find((field) => field.name === 'shareScope');
      expect(scope).toMatchObject({
        type: "'team' | 'organization'",
        required: true,
      });
    }
    const automationScope = shareActions
      .find((action) => action.type === 'automation.share')
      ?.fields.find((field) => field.name === 'shareScope');
    expect(automationScope).toMatchObject({
      type: "'team' | 'organization'",
      required: false,
    });
    expect(automationScope?.description).toContain(
      'Required for a first share',
    );
  });

  it('finds pipeline enablement actions', () => {
    const result = searchAppAdvisorActions({
      query: 'disable pipeline hide from run picker enable disabled',
      limit: 20,
    });

    expect(result.actions.map((action) => action.type)).toEqual(
      expect.arrayContaining(['pipeline.set_enabled', 'pipeline.list']),
    );
  });

  it('can inspect one exact action type', () => {
    const result = searchAppAdvisorActions({
      actionType: 'navigation.open_settings',
      limit: 5,
    });

    expect(result.totalMatches).toBe(1);
    expect(result.actions[0]).toMatchObject({
      type: 'navigation.open_settings',
      optionalFields: ['section'],
      example: { type: 'navigation.open_settings', section: 'harnesses' },
    });
    expect(result.actions[0]?.fields[0]?.description).toContain('harnesses');
  });

  it('finds settings navigation by the Instructions feature name', () => {
    const result = searchAppAdvisorActions({
      query: 'instructions',
      limit: 10,
    });

    expect(result.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'navigation.open_settings' }),
      ]),
    );
  });

  it('finds Code Graph detail-panel navigation', () => {
    const result = searchAppAdvisorActions({
      query: 'open project code graph status',
      limit: 10,
    });

    expect(result.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'navigation.open_code_graph',
          requiredFields: ['workspaceId'],
        }),
      ]),
    );
  });

  it('finds project settings navigation with an optional tab', () => {
    const result = searchAppAdvisorActions({
      query: 'open cowork project settings environment tab',
      limit: 10,
    });

    expect(result.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'navigation.open_workspace_settings',
          requiredFields: ['workspaceId'],
          optionalFields: ['tab'],
        }),
      ]),
    );
  });

  it('feature-gates Code Graph detail-panel navigation', () => {
    const entry = APP_ADVISOR_ACTION_CATALOG.find(
      (candidate) => candidate.type === 'navigation.open_code_graph',
    );
    expect(entry?.requiredFeatureFlag).toBe(
      CLIENT_FEATURE_FLAGS.canopyDesktopWorkspaceCodeGraph.key,
    );

    const result = searchAppAdvisorActions({
      query: 'open project code graph status',
      limit: 10,
      featureFlags: {
        [CLIENT_FEATURE_FLAGS.canopyDesktopWorkspaceCodeGraph.key]: false,
      },
    });
    expect(result.actions.map((action) => action.type)).not.toContain(
      'navigation.open_code_graph',
    );
  });

  it('carries Portal feature-flag metadata in presented search results', () => {
    const result = searchAppAdvisorActions({
      actionType: 'canopy_portal.open',
    });

    expect(result.actions[0]).toMatchObject({
      type: 'canopy_portal.open',
      requiredFeatureFlag: CLIENT_FEATURE_FLAGS.canopyPortalEnabled.key,
    });
  });

  it('filters disabled feature-gated Portal actions from presented catalogs', () => {
    const result = searchAppAdvisorActions({
      query: 'canopy portal',
      limit: 20,
      featureFlags: {
        [CLIENT_FEATURE_FLAGS.canopyPortalEnabled.key]: false,
      },
    });

    expect(result.actions.map((action) => action.type)).not.toEqual(
      expect.arrayContaining([
        'canopy_portal.open',
        'canopy_portal.start',
        'canopy_portal.open_account_settings',
      ]),
    );
    expect(result.actions.map((action) => action.type)).toEqual(
      expect.arrayContaining(['canopy_portal.close', 'canopy_portal.stop']),
    );
  });

  it.each([CLIENT_FEATURE_FLAGS.canopyDesktopSharedContainers.key])(
    'filters new shared-container invites when %s is disabled',
    (flagKey) => {
      const result = searchAppAdvisorActions({
        query: 'invite teammate shared container revoke recipient',
        limit: 20,
        featureFlags: { [flagKey]: false },
      });

      expect(result.actions.map((action) => action.type)).not.toContain(
        'shared-containers.open_invite',
      );
      expect(result.actions.map((action) => action.type)).not.toContain(
        'shared-containers.open_received',
      );
      expect(result.actions.map((action) => action.type)).not.toContain(
        'shared-containers.retry_received',
      );
      expect(result.actions.map((action) => action.type)).toContain(
        'shared-containers.revoke_recipient',
      );
    },
  );

  it('finds chat history actions by transcript query', () => {
    const result = searchAppAdvisorActions({
      query: 'transcript history',
      category: 'projects',
      limit: 50,
    });

    expect(result.actions.map((action) => action.type)).toEqual(
      expect.arrayContaining(['projects.read_history']),
    );
  });

  it('finds worktree tab actions by tab query', () => {
    const result = searchAppAdvisorActions({
      query:
        'list switch active file tabs unsaved changes handoff expired session fork branch chat action',
      limit: 20,
    });

    expect(result.actions.map((action) => action.type)).toEqual(
      expect.arrayContaining([
        'worktree-chat.switch_tab',
        'worktree-chat.run_chat_action',
      ]),
    );
  });

  it('finds worktree git action discovery and dispatch', () => {
    const result = searchAppAdvisorActions({
      query: 'worktree git commit push create pr cancel stop available action',
      limit: 10,
    });

    expect(result.actions.map((action) => action.type)).toEqual(
      expect.arrayContaining([
        'worktree.list_git_actions',
        'worktree.run_git_action',
        'worktree.cancel_git_action',
      ]),
    );
  });

  it('exposes the Split PR action with the expected fields and gating notes', () => {
    const entry = APP_ADVISOR_ACTION_CATALOG.find(
      (candidate) => candidate.type === 'github.split_pr',
    );
    expect(entry).toBeDefined();
    expect(entry?.category).toBe('worktree');
    expect(entry?.requiredFeatureFlag).toBe(
      CLIENT_FEATURE_FLAGS.canopyDesktopPrSplit.key,
    );
    expect(entry?.example.type).toBe('github.split_pr');
    expect(
      entry?.fields
        .filter((field) => field.required)
        .map((field) => field.name),
    ).toEqual(['projectId', 'worktreeId']);
    expect(entry?.notes?.join(' ')).toContain('single-repo');
    expect(entry?.notes?.join(' ')).toContain('threshold');
    expect(entry?.notes?.join(' ')).toContain('pre-flight dialog');
    // A5/A8: dispatching this action against an already split-locked worktree
    // is refused rather than opening a second pre-flight dialog, matching
    // every other worktree-mutating dispatcher action.
    expect(entry?.notes?.join(' ')).toContain('split-locked');

    const result = searchAppAdvisorActions({
      query: 'split large pull request into stack of smaller prs',
      limit: 10,
    });
    expect(result.actions.map((action) => action.type)).toEqual(
      expect.arrayContaining(['github.split_pr']),
    );
  });

  it('filters the Split PR action when the desktop PR Split flag is disabled', () => {
    const result = searchAppAdvisorActions({
      query: 'split large pull request into stack of smaller prs',
      limit: 10,
      featureFlags: {
        [CLIENT_FEATURE_FLAGS.canopyDesktopPrSplit.key]: false,
      },
    });

    expect(result.actions.map((action) => action.type)).not.toEqual(
      expect.arrayContaining(['github.split_pr']),
    );
  });

  it('finds cowork project chat and context actions', () => {
    const result = searchAppAdvisorActions({
      query: 'cowork project chat prompts attachments settings',
      category: 'standalone-chat',
      limit: 50,
    });

    expect(result.actions.map((action) => action.type)).toEqual(
      expect.arrayContaining([
        'standalone-chat.switch_project',
        'standalone-chat.rename_work_entry',
        'standalone-chat.delete_work_entry',
        'standalone-chat.list_prompts',
        'standalone-chat.list_attachments',
        'standalone-chat.get_settings',
        'standalone-chat.update_settings',
      ]),
    );
    expect(
      result.actions
        .find((action) => action.type === 'standalone-chat.update_settings')
        ?.fields.map((field) => field.name),
    ).toContain('alwaysShow');
    const retentionField = result.actions
      .find((action) => action.type === 'standalone-chat.update_settings')
      ?.fields.find((field) => field.name === 'archiveRetentionDays');
    expect(retentionField?.type).toBe('number');
    expect(retentionField?.description).toBe(
      `Deletion retention in days (1-${MAX_ARCHIVE_RETENTION_DAYS}).`,
    );
  });

  it('finds project environment assignment actions', () => {
    const result = searchAppAdvisorActions({
      actionType: 'environment.update_workspace_assignment',
    });

    expect(result.actions.map((action) => action.type)).toContain(
      'environment.update_workspace_assignment',
    );
  });

  it('catalogs archived-container actions with archive discovery terms', () => {
    const entries = APP_ADVISOR_ACTION_CATALOG.filter((entry) =>
      entry.type.startsWith('archived.'),
    );

    expect(entries.map((entry) => entry.type)).toEqual([
      'archived.list',
      'archived.open_overview',
      'archived.open_empty_trash',
      'archived.open',
      'archived.read_chat',
      'archived.restore',
      'archived.set_locked',
    ]);
    for (const entry of entries) {
      expect(entry.keywords).toEqual(
        expect.arrayContaining(['archive', 'archived', 'retention']),
      );
      if (entry.type !== 'archived.set_locked') {
        expect(entry.keywords).toEqual(
          expect.arrayContaining(['restore', 'deleted']),
        );
      }
    }
    const setLocked = entries.find(
      (entry) => entry.type === 'archived.set_locked',
    );
    expect(setLocked?.keywords).toEqual(
      expect.arrayContaining(['lock', 'unlock']),
    );
    const open = entries.find((entry) => entry.type === 'archived.open');
    expect(open?.fields.map((field) => field.name)).toContain('planId');
    expect(
      entries.find((entry) => entry.type === 'archived.open_empty_trash')
        ?.summary,
    ).toContain('confirmation');
  });

  it('catalogs Auto Delete settings without the retired live lock action', () => {
    const result = searchAppAdvisorActions({
      query: 'auto delete settings',
    });

    expect(result.actions.map((action) => action.type)).toEqual(
      expect.arrayContaining([
        'workspace.update_local_settings',
        'standalone-chat.update_settings',
        'app_advisor.update_settings',
      ]),
    );
    expect(result.actions.map((action) => action.type)).not.toContain(
      'auto_archive.set_locked',
    );
  });

  it('finds project source-control settings actions', () => {
    const result = searchAppAdvisorActions({
      query: 'project source controlled settings',
    });

    expect(result.actions.map((action) => action.type)).toEqual(
      expect.arrayContaining([
        'workspace.get_settings',
        'workspace.update_local_settings',
        'workspace.apply_source_edits',
      ]),
    );
  });

  it('finds temporary project join and promotion actions', () => {
    const result = searchAppAdvisorActions({
      query: 'add project join temporary promote',
      limit: 20,
    });

    expect(result.actions.map((action) => action.type)).toEqual(
      expect.arrayContaining([
        'workspace.list_join_options',
        'workspace.list_existing_worktree_join_options',
        'worktree.add_workspace',
        'worktree.add_existing_worktree',
        'workspace.promote_temporary',
      ]),
    );
  });

  it('finds chat configuration and plugin actions', () => {
    const result = searchAppAdvisorActions({
      query: 'chat plugins model thinking planning mode',
      limit: 50,
    });

    expect(result.actions.map((action) => action.type)).toEqual(
      expect.arrayContaining([
        'worktree-chat.set_plan_mode',
        'worktree-chat.set_model',
        'worktree-chat.set_thinking_level',
        'worktree-chat.list_plugins',
        'worktree-chat.update_plugin_selection',
      ]),
    );
  });

  it('finds pipeline assistant chat read/write and configuration actions', () => {
    const result = searchAppAdvisorActions({
      query: 'pipeline assistant chat send history plugins model',
      limit: 20,
    });

    expect(result.actions.map((action) => action.type)).toEqual(
      expect.arrayContaining([
        'pipeline-assistant-chat.list_tabs',
        'pipeline-assistant-chat.create_tab',
        'pipeline-assistant-chat.read_history',
        'pipeline-assistant-chat.send_message',
        'pipeline-assistant-chat.set_model',
        'pipeline-assistant-chat.list_plugins',
      ]),
    );
  });

  it('finds custom skill management actions', () => {
    const result = searchAppAdvisorActions({
      query: 'custom skill create edit rename delete read',
      limit: 20,
    });

    expect(result.actions.map((action) => action.type)).toEqual(
      expect.arrayContaining([
        'skills.open_manager',
        'skills.open_viewer',
        'skills.list',
        'skills.read',
        'skills.read_file',
        'skills.create_custom',
        'skills.update_custom',
        'skills.delete_custom',
      ]),
    );
  });

  it('catalogs supporting-file inspection and viewer targeting', () => {
    const openViewer = APP_ADVISOR_ACTION_CATALOG.find(
      (entry) => entry.type === 'skills.open_viewer',
    );
    const readFile = APP_ADVISOR_ACTION_CATALOG.find(
      (entry) => entry.type === 'skills.read_file',
    );

    expect(openViewer?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'filePath', required: false }),
      ]),
    );
    expect(readFile?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'filePath', required: true }),
      ]),
    );
    expect(APP_ADVISOR_REVISION_AGNOSTIC_ACTION_TYPES).toContain(
      'skills.read_file',
    );
  });

  it('does not list the environments settings alias on navigation.go_to_page (CAN-4269)', () => {
    const entry = APP_ADVISOR_ACTION_CATALOG.find(
      (catalogEntry) => catalogEntry.type === 'navigation.go_to_page',
    );

    expect(entry).toBeDefined();
    const pageField = entry?.fields.find((f) => f.name === 'page');
    expect(pageField?.type).not.toContain("'environments'");
    expect(pageField?.type).not.toContain("'mcp-account-connections'");
    expect(entry?.keywords).not.toEqual(
      expect.arrayContaining(['environment']),
    );
  });

  it('describes Settings → Environments on navigation.open_settings', () => {
    const entry = APP_ADVISOR_ACTION_CATALOG.find(
      (catalogEntry) => catalogEntry.type === 'navigation.open_settings',
    );

    expect(entry).toBeDefined();
    const sectionField = entry?.fields.find((f) => f.name === 'section');
    expect(sectionField?.description).toContain('environment');
    expect(sectionField?.description).not.toContain('deprecated');
    expect(entry?.keywords).toEqual(
      expect.arrayContaining([
        'environment',
        'environments',
        'env vars',
        'runtime',
      ]),
    );
  });

  it('routes environment-related queries to navigation.open_settings', () => {
    const result = searchAppAdvisorActions({
      query: 'environment env vars runtime',
      limit: 5,
    });

    expect(result.actions.map((action) => action.type)).toContain(
      'navigation.open_settings',
    );
  });

  it('never advertises the environments alias even when the renderer reports it available', () => {
    const result = searchAppAdvisorActions({
      query: 'go to page',
      limit: 20,
      availablePages: ['plugins', 'environments', 'mcp-account-connections'],
    });
    const goToPage = result.actions.find(
      (action) => action.type === 'navigation.go_to_page',
    );

    expect(goToPage).toBeDefined();
    const pageField = goToPage?.fields.find((f) => f.name === 'page');
    expect(pageField?.type).toContain("'plugins'");
    expect(pageField?.type).not.toContain("'environments'");
  });

  it('lists the navigation history actions in the catalog', () => {
    const types = APP_ADVISOR_ACTION_CATALOG.map((entry) => entry.type);

    expect(types).toEqual(
      expect.arrayContaining(['navigation.go_back', 'navigation.go_forward']),
    );
    expect(APP_ADVISOR_REVISION_AGNOSTIC_ACTION_TYPES).toEqual(
      expect.arrayContaining(['navigation.go_back', 'navigation.go_forward']),
    );
  });

  it('routes back-navigation queries to navigation.go_back', () => {
    const result = searchAppAdvisorActions({
      query: 'go back previous page navigation history',
      limit: 5,
    });

    expect(result.actions.map((action) => action.type)).toContain(
      'navigation.go_back',
    );
  });

  it('lists the workers page on navigation.go_to_page', () => {
    const entry = APP_ADVISOR_ACTION_CATALOG.find(
      (catalogEntry) => catalogEntry.type === 'navigation.go_to_page',
    );

    expect(entry).toBeDefined();
    const pageField = entry?.fields.find((f) => f.name === 'page');
    expect(pageField?.type).toContain("'workers'");
    expect(entry?.keywords).toEqual(
      expect.arrayContaining(['workers', 'claude workers', 'terminal mode']),
    );
  });

  it('routes worker-related queries to navigation.go_to_page', () => {
    const result = searchAppAdvisorActions({
      query: 'claude workers terminal mode worker terminals page',
      limit: 5,
    });

    expect(result.actions.map((action) => action.type)).toContain(
      'navigation.go_to_page',
    );
  });

  it('does not list the retired agents page on navigation.go_to_page (CAN-4266)', () => {
    const entry = APP_ADVISOR_ACTION_CATALOG.find(
      (catalogEntry) => catalogEntry.type === 'navigation.go_to_page',
    );

    expect(entry).toBeDefined();
    const pageField = entry?.fields.find((f) => f.name === 'page');
    expect(pageField?.type).not.toContain("'agents'");
    for (const keyword of ['agents', 'custom agents', 'agent models']) {
      expect(entry?.keywords).not.toContain(keyword);
    }
  });

  it('lists the kanban page on navigation.go_to_page', () => {
    const entry = APP_ADVISOR_ACTION_CATALOG.find(
      (catalogEntry) => catalogEntry.type === 'navigation.go_to_page',
    );

    expect(entry).toBeDefined();
    const pageField = entry?.fields.find((f) => f.name === 'page');
    expect(pageField?.type).toContain("'kanban'");
    expect(entry?.keywords).toEqual(
      expect.arrayContaining(['kanban', 'kanban board', 'worktree board']),
    );
  });

  it('routes agent-related queries to the Agents manager action', () => {
    const result = searchAppAdvisorActions({
      query: 'custom agents agent models page',
      availablePages: ['home', 'plugins'],
      featureFlags: {
        [CLIENT_FEATURE_FLAGS.canopySharedCustomAgents.key]: true,
      },
      limit: 5,
    });

    expect(result.actions.map((action) => action.type)).toContain(
      'agents.open_manager',
    );
  });

  it('routes kanban-related queries to navigation.go_to_page', () => {
    const result = searchAppAdvisorActions({
      query: 'kanban board worktree view',
      limit: 5,
    });

    expect(result.actions.map((action) => action.type)).toContain(
      'navigation.go_to_page',
    );
  });

  it('finds Agent management actions', () => {
    const result = searchAppAdvisorActions({
      query: 'custom agents create import shared delete',
      availablePages: ['home', 'plugins'],
      featureFlags: {
        [CLIENT_FEATURE_FLAGS.canopySharedCustomAgents.key]: true,
      },
      limit: 20,
    });

    expect(result.actions.map((action) => action.type)).toEqual(
      expect.arrayContaining([
        'agents.create',
        'agents.import_shared',
        'agents.delete',
        'agents.delete_shared',
      ]),
    );
  });

  it('finds Agent public-link management actions', () => {
    const result = searchAppAdvisorActions({
      query: 'agent public link publish revoke',
      availablePages: ['home', 'plugins'],
      featureFlags: {
        [CLIENT_FEATURE_FLAGS.canopySharedCustomAgents.key]: true,
      },
      limit: 20,
    });

    expect(result.actions.map((action) => action.type)).toEqual(
      expect.arrayContaining([
        'agents.publish_public_share',
        'agents.revoke_public_share',
      ]),
    );
  });

  it('uses a neutral navigation summary while retaining menu search terms', () => {
    const entry = APP_ADVISOR_ACTION_CATALOG.find(
      (catalogEntry) => catalogEntry.type === 'navigation.go_to_page',
    );

    expect(entry).toBeDefined();
    expect(entry?.summary).toContain('available destination');
    expect(entry?.summary).not.toMatch(/Agents|Workers/);
    expect(entry?.keywords).toEqual(
      expect.arrayContaining([
        'more menu',
        'account menu',
        'overview',
        'remote control',
        'audit trail',
      ]),
    );
  });

  it('finds Collection actions by legacy bundle compatibility terms', () => {
    const result = searchAppAdvisorActions({
      query: 'open bundles share bundle import',
      limit: 20,
    });
    const listResult = searchAppAdvisorActions({
      query: 'list local bundles',
      limit: 10,
    });

    expect(result.actions.map((action) => action.type)).toEqual(
      expect.arrayContaining([
        'collections.open_manager',
        'collections.share',
        'collections.import_shared',
      ]),
    );
    expect(listResult.actions.map((action) => action.type)).toContain(
      'collections.list',
    );
    expect(result.actions.map((action) => action.summary).join(' ')).toContain(
      'Collection',
    );
  });

  it('finds tracked-plan and Plan panel actions', () => {
    const planResult = searchAppAdvisorActions({
      query: 'tracked plans view inspect open explore import plan',
      limit: 20,
    });
    const commentResult = searchAppAdvisorActions({
      query: 'staged resolved outdated comment threads read thread',
      limit: 20,
    });
    const panelResult = searchAppAdvisorActions({
      query: 'open plan panel',
      limit: 5,
    });

    expect(planResult.actions.map((action) => action.type)).toEqual(
      expect.arrayContaining([
        'tracked-plan.list',
        'tracked-plan.import',
        'tracked-plan.get',
        'tracked-plan.open_explore',
      ]),
    );
    expect(commentResult.actions.map((action) => action.type)).toEqual(
      expect.arrayContaining([
        'tracked-plan.list_comment_threads',
        'tracked-plan.get_comment_thread',
      ]),
    );
    expect(panelResult.actions.map((action) => action.type)).toContain(
      'tracked-plan.open_explore',
    );
    expect(APP_ADVISOR_REVISION_AGNOSTIC_ACTION_TYPES).toEqual(
      expect.arrayContaining([
        'tracked-plan.import',
        'tracked-plan.open_explore',
      ]),
    );
  });

  it('describes open_explore as opening the Plan panel, not the Explore modal', () => {
    const entry = APP_ADVISOR_ACTION_CATALOG.find(
      (candidate) => candidate.type === 'tracked-plan.open_explore',
    );

    expect(entry?.summary).toBe(
      "Open a tracked plan's Plan panel in its worktree, switching to that worktree first. Returns the plan and where its panel is.",
    );
    expect(JSON.stringify(entry)).not.toMatch(
      /explore modal|plan-explore-chat/i,
    );
  });

  it('retires the plan-explore-chat action family', () => {
    const retired = (type: string): boolean =>
      type.startsWith('plan-explore-chat.');

    expect(
      APP_ADVISOR_ACTION_CATALOG.map((entry) => entry.type).filter(retired),
    ).toEqual([]);
    expect(
      APP_ADVISOR_ACTION_CATALOG.map((entry) => entry.category),
    ).not.toContain('plan-explore-chat');
    expect(APP_ADVISOR_REVISION_AGNOSTIC_ACTION_TYPES.filter(retired)).toEqual(
      [],
    );
    expect(
      searchAppAdvisorActions({ category: 'plan-explore-chat' }).actions,
    ).toEqual([]);
  });

  it('documents plan and plan-diagram tabs on panel.add_tab', () => {
    const entry = APP_ADVISOR_ACTION_CATALOG.find(
      (candidate) => candidate.type === 'panel.add_tab',
    );

    expect(
      entry?.fields.find((candidate) => candidate.name === 'kind')?.type,
    ).toContain("'plan' | 'plan-diagram'");
    expect(entry?.fields.map((candidate) => candidate.name)).toContain(
      'planId',
    );
    expect(entry?.additionalExamples).toEqual(
      expect.arrayContaining([
        {
          type: 'panel.add_tab',
          kind: 'plan',
          planId: 'plan-1',
          groupId: 'group-chat',
        },
        { type: 'panel.add_tab', kind: 'plan-diagram', planId: 'plan-1' },
      ]),
    );
  });

  it('documents opening or revealing Subagents without offering blank subagent chats', () => {
    const entry = APP_ADVISOR_ACTION_CATALOG.find(
      (candidate) => candidate.type === 'panel.add_tab',
    );

    const kindField = entry?.fields.find(
      (candidate) => candidate.name === 'kind',
    );
    expect(kindField?.type).toContain("'subagents'");
    expect(kindField?.type).not.toContain("'subagent-chat'");
    expect(entry?.additionalExamples).toEqual(
      expect.arrayContaining([{ type: 'panel.add_tab', kind: 'subagents' }]),
    );
    expect(entry?.notes?.join(' ')).toContain('revealed where it is');
  });

  it('does not require UI revisions for state-independent actions', () => {
    expect(APP_ADVISOR_REVISION_AGNOSTIC_ACTION_TYPES).toEqual(
      expect.arrayContaining([
        'skills.create_custom',
        'skills.update_custom',
        'skills.delete_custom',
        'skills.list_shared',
        'skills.share_custom',
        'skills.import_shared',
        'skills.update_shared',
        'skills.delete_shared',
        'collections.create',
        'collections.update',
        'collections.delete',
        'collections.share',
        'collections.list_shared',
        'collections.import_shared',
        'collections.update_shared',
        'collections.delete_shared',
        'agents.list',
        'agents.get',
        'agents.create',
        'agents.update',
        'agents.delete',
        'agents.list_shared',
        'agents.import_shared',
        'agents.delete_shared',
        'pipeline.open_editor',
        'pipeline.create',
        'pipeline.update',
        'pipeline.delete',
        'pipeline.duplicate',
        'pipeline.share',
        'pipeline.update_shared',
        'pipeline.delete_shared',
        'pipeline.set_enabled',
        'pipeline.list',
        'pipeline.get',
        'pipeline.open_run',
        'pipeline.debug_run',
        'pipeline.execution_list_for_worktree',
        'pipeline.execution_list',
        'pipeline.execution_get',
        'pipeline.execution_cancel',
        'pipeline.execution_retry_matrix_job',
        'pipeline.execution_cancel_matrix_variant',
        'pipeline.execution_resume',
        'pipeline.execution_retry',
        'pipeline.execution_start_over',
        'pipeline.execution_read_report',
        'pipeline.execution_read_plan',
        'pipeline.execution_chain',
        'worktree.select',
        'file.open',
        'terminal.open',
        'canopy_portal.start',
        'canopy_portal.stop',
        'watcher.delete',
      ]),
    );
    expect(APP_ADVISOR_REVISION_AGNOSTIC_ACTION_TYPES).toEqual(
      expect.not.arrayContaining(['hook.pause', 'hook.resume']),
    );
  });
});

it('catalogs the read-only account proxy status behind its flag', () => {
  const entry = searchAppAdvisorActions({
    actionType: 'account_proxy.status',
    featureFlags: { 'canopy-desktop-account-proxy': true },
  }).actions[0];
  expect(entry?.fields.map((field) => field.name)).toEqual(['refresh']);
  expect(
    searchAppAdvisorActions({
      actionType: 'account_proxy.status',
      featureFlags: { 'canopy-desktop-account-proxy': false },
    }).actions,
  ).toEqual([]);
});

it('catalogs the five managed OpenCode operations behind the rollout flag', () => {
  const entry = searchAppAdvisorActions({
    actionType: 'opencode.connection',
    featureFlags: { 'canopy-desktop-opencode-harness': true },
  }).actions[0];
  expect(entry).toBeDefined();
  expect(entry?.fields.find((field) => field.name === 'operation')?.type).toBe(
    'status | models | connect | cancel | disconnect',
  );
  expect(
    searchAppAdvisorActions({
      actionType: 'opencode.connection',
      featureFlags: { 'canopy-desktop-opencode-harness': false },
    }).actions,
  ).toEqual([]);
});

it.each(['cursor.connection', 'cursor.approval_check'])(
  'hides %s while the Cursor harness flag is off',
  (actionType) => {
    expect(
      searchAppAdvisorActions({
        actionType,
        featureFlags: { 'canopy-desktop-cursor-harness': false },
      }).actions,
    ).toEqual([]);
    expect(
      searchAppAdvisorActions({
        actionType,
        featureFlags: { 'canopy-desktop-cursor-harness': true },
      }).actions.map((action) => action.type),
    ).toContain(actionType);
  },
);

it.each([
  'workspace.open_add_dialog',
  'workspace.add_org_project',
  'org_project.create_cowork',
  'org_project.create_code',
  'workspace.find_repository_owner',
])('gates %s on organization projects', (type): void => {
  expect(
    APP_ADVISOR_ACTION_CATALOG.find((action) => action.type === type)
      ?.requiredFeatureFlag,
  ).toBe(CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key);
});

it.each(['connect', 'reconnect', 'disconnect', 'promote'])(
  'catalogs mcp.account_%s behind the shared account connections flag',
  (operation): void => {
    const entry = APP_ADVISOR_ACTION_CATALOG.find(
      (candidate): boolean => candidate.type === `mcp.account_${operation}`,
    );
    expect(entry).toBeDefined();
    expect(entry?.requiredFeatureFlag).toBe(
      CLIENT_FEATURE_FLAGS.canopySharedMcpAccountConnections.key,
    );
  },
);

describe('worktree script actions in the catalog', () => {
  it('catalogs listing and running configured worktree scripts', () => {
    const run = searchAppAdvisorActions({ query: 'run script' }).actions[0];
    expect(run).toMatchObject({
      type: 'worktree.run_script',
      category: 'worktree',
      requiredFields: ['projectId', 'worktreeId', 'scriptId'],
      optionalFields: ['repo', 'waitSeconds'],
    });
    expect(
      searchAppAdvisorActions({ query: 'list scripts' }).actions[0],
    ).toMatchObject({
      type: 'worktree.list_scripts',
      requiredFields: ['projectId', 'worktreeId'],
    });
    expect(APP_ADVISOR_REVISION_AGNOSTIC_ACTION_TYPES).toContain(
      'worktree.list_scripts',
    );
    expect(APP_ADVISOR_REVISION_AGNOSTIC_ACTION_TYPES).not.toContain(
      'worktree.run_script',
    );
  });

  it('restricts search to allowedActionTypes before ranking and limiting', () => {
    const allowedActionTypes = ['worktree.list_scripts', 'worktree.run_script'];
    const everything = searchAppAdvisorActions({
      allowedActionTypes,
      limit: 50,
    });
    expect(everything.actions.map((action) => action.type).sort()).toEqual(
      allowedActionTypes,
    );
    expect(everything.totalMatches).toBe(2);
    // "setup" matches many App Advisor actions; the filter must apply first
    // so a small allowed set is never crowded out of the result window.
    expect(
      searchAppAdvisorActions({
        query: 'setup',
        allowedActionTypes,
        limit: 1,
      }).actions.map((action) => action.type),
    ).toEqual([expect.stringMatching(/^worktree\.(list|run)_script/)]);
    expect(
      searchAppAdvisorActions({
        actionType: 'navigation.go_to_page',
        allowedActionTypes,
      }).actions,
    ).toEqual([]);
  });
});

it('discovers Personal catalog enrollment with its feature gate', (): void => {
  const result = searchAppAdvisorActions({
    query: 'personal catalog enrollment',
  });
  expect(result.actions.map((action) => action.type)).toContain(
    'settings.personalCatalog.set',
  );
  expect(
    searchAppAdvisorActions({
      query: 'personal catalog enrollment',
      featureFlags: {
        [CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key]: false,
      },
    }).actions.map((action) => action.type),
  ).not.toContain('settings.personalCatalog.set');
});

it('discovers organization Cowork project creation behind its gate (CAN-3453)', (): void => {
  const query = 'create a new cowork project in my organization';
  expect(
    searchAppAdvisorActions({ query }).actions.map((action) => action.type),
  ).toContain('org_project.create_cowork');
  expect(
    searchAppAdvisorActions({
      query,
      featureFlags: {
        [CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key]: false,
      },
    }).actions.map((action) => action.type),
  ).not.toContain('org_project.create_cowork');
  expect(APP_ADVISOR_REVISION_AGNOSTIC_ACTION_TYPES).not.toContain(
    'org_project.create_cowork',
  );
  const entry = APP_ADVISOR_ACTION_CATALOG.find(
    (action) => action.type === 'org_project.create_cowork',
  );
  expect(entry?.example).toEqual({
    type: 'org_project.create_cowork',
    name: 'Launch plan',
  });
  expect(entry?.notes?.join(' ')).toContain('workspace_context.switch');
});

it('discovers organization Code project creation behind its gate (CAN-3534)', (): void => {
  const query =
    'create a code project from a git repository in my organization';
  expect(
    searchAppAdvisorActions({ query }).actions.map((action) => action.type),
  ).toContain('org_project.create_code');
  expect(
    searchAppAdvisorActions({
      query,
      featureFlags: {
        [CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key]: false,
      },
    }).actions.map((action) => action.type),
  ).not.toContain('org_project.create_code');
  expect(APP_ADVISOR_REVISION_AGNOSTIC_ACTION_TYPES).not.toContain(
    'org_project.create_code',
  );
  const entry = APP_ADVISOR_ACTION_CATALOG.find(
    (action) => action.type === 'org_project.create_code',
  );
  expect(entry?.example).toEqual({
    type: 'org_project.create_code',
    name: 'Payments service',
  });
  // The folder is optional: without it a new repository is started.
  expect(entry?.fields.map((item) => [item.name, item.required])).toEqual([
    ['name', true],
    ['folderPath', false],
  ]);
  expect(entry?.notes?.join(' ')).toContain('workspace_context.switch');
});

it('discovers the read-only repository owner lookup behind its gate (CAN-3592)', (): void => {
  const query = 'which organization owns this repository before I add it';
  expect(
    searchAppAdvisorActions({ query }).actions.map((action) => action.type),
  ).toContain('workspace.find_repository_owner');
  expect(
    searchAppAdvisorActions({
      query,
      featureFlags: {
        [CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key]: false,
      },
    }).actions.map((action) => action.type),
  ).not.toContain('workspace.find_repository_owner');
  // Read-only: a stale UI snapshot is no reason to refuse it.
  expect(APP_ADVISOR_REVISION_AGNOSTIC_ACTION_TYPES).toContain(
    'workspace.find_repository_owner',
  );
  const entry = APP_ADVISOR_ACTION_CATALOG.find(
    (action) => action.type === 'workspace.find_repository_owner',
  );
  expect(entry?.category).toBe('workspace');
  expect(entry?.example).toEqual({
    type: 'workspace.find_repository_owner',
    path: '/path/to/payments',
  });
  expect(entry?.additionalExamples).toEqual([
    {
      type: 'workspace.find_repository_owner',
      remoteUrl: 'https://github.com/acme/payments.git',
    },
  ]);
  expect(entry?.fields.map((item) => [item.name, item.required])).toEqual([
    ['path', false],
    ['remoteUrl', false],
  ]);
  const notes = entry?.notes?.join(' ') ?? '';
  expect(notes).toContain('exactly one');
  expect(notes).toContain('workspace.add_org_project');
  // The offered add refuses unless the owning organization is selected.
  expect(notes).toContain(
    "first call workspace_context.switch with { context: { kind: 'organization', organizationId } } from the result",
  );
  expect(notes).toContain("{ kind: 'none' }");
  expect(notes).toContain('never moves');
});

it('requires a current revision for consent-bearing Personal catalog changes', (): void => {
  expect(APP_ADVISOR_REVISION_AGNOSTIC_ACTION_TYPES).not.toContain(
    'settings.personalCatalog.set',
  );
});

describe('browser frame discovery', () => {
  it.each([
    'click',
    'fill',
    'press',
    'focus',
    'wait_for',
    'inspect',
    'input_snapshot',
  ])('advertises frame on browser.%s', (kind) => {
    const entry = searchAppAdvisorActions({ actionType: `browser.${kind}` })
      .actions[0];
    expect(entry?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'frame',
          type: 'string',
          required: false,
        }),
      ]),
    );
  });
});

it('catalogs pointer/viewport receipts and limits', () => {
  const notes = (actionType: string): string =>
    searchAppAdvisorActions({ actionType }).actions[0]?.notes?.join(' ') ?? '';
  expect(notes('browser.hover')).toContain('no synthetic fallback');
  expect(notes('browser.scroll')).toContain('effects.scroll');
  expect(notes('browser.scroll')).toContain('point-in-time');
  expect(notes('browser.drag')).toContain('one document');
  expect(notes('browser.drag')).toContain('new position');
});

it('discovers the privacy opt-in review as a confirmation-only action', (): void => {
  const result = searchAppAdvisorActions({
    query: 'leaderboard sharing privacy',
  });
  const entry = result.actions.find(
    (action) => action.type === 'settings.review_privacy_opt_in',
  );
  expect(entry).toBeDefined();
  expect(entry?.notes?.join(' ')).toContain('Nothing is saved');
});

it.each([
  'turn on free daily credits',
  'daily free AI Credits',
  'stop daily credits',
])('finds the daily credit drip action for %s', (query: string) => {
  const result = searchAppAdvisorActions({ query });

  expect(result.actions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: 'settings.set_daily_credit_drip',
        category: 'settings',
        requiredFields: ['enabled'],
      }),
    ]),
  );
  expect(APP_ADVISOR_REVISION_AGNOSTIC_ACTION_TYPES).toEqual(
    expect.arrayContaining(['settings.set_daily_credit_drip']),
  );
});

describe('searchAppAdvisorActions ranking characterization', () => {
  type SearchInput = NonNullable<Parameters<typeof searchAppAdvisorActions>[0]>;

  const describeResult = (input: SearchInput): object => {
    const result = searchAppAdvisorActions(input);
    return {
      query: result.query,
      category: result.category,
      actionType: result.actionType,
      totalMatches: result.totalMatches,
      returned: result.returned,
      actions: result.actions.map((action) =>
        [
          action.type,
          `[${action.category}]`,
          `req=${action.requiredFields.join(',')}`,
          `opt=${action.optionalFields.join(',')}`,
          ...(action.hookTriggers
            ? [
                `hooks=${action.hookTriggers.map((hook) => hook.triggerName).join(',')}`,
              ]
            : []),
        ].join(' '),
      ),
    };
  };

  const cases: Array<[string, SearchInput]> = [
    ['empty input', {}],
    ['project steer', { actionType: 'projects.steer_queued_message' }],
    ['project schedule', { actionType: 'projects.schedule_message' }],
    ['project send', { actionType: 'projects.send_message' }],
    ['bot send', { actionType: 'bots.send_message' }],
    ['single word query', { query: 'pipeline' }],
    ['multi word query', { query: 'run pipeline' }],
    ['short abbreviation', { query: 'pr' }],
    ['short abbreviation above the limit cap', { query: 'pr', limit: 100 }],
    ['two letter word', { query: 'me' }],
    ['segment-prefixed word', { query: 'view' }],
    ['hook trigger query', { query: 'hook' }],
    [
      'hook trigger phrase',
      { query: 'pause hook after setup worktree created' },
    ],
    ['watcher phrase', { query: 'notify me when pipeline finished' }],
    ['category alias', { category: 'automation' }],
    ['category alias with query', { category: 'watcher', query: 'chat' }],
    ['category with small limit', { category: 'browser', limit: 5 }],
    [
      'category token stripped from query',
      { category: 'skills', query: 'skills list' },
    ],
    ['exact action type', { actionType: 'pipeline.run' }],
    ['partial action type', { actionType: 'pipeline' }],
    [
      'exact action type outside category',
      { actionType: 'pipeline.run', category: 'skills' },
    ],
    ['unknown action type', { actionType: 'nonexistent.action' }],
    ['unmatched query', { query: 'zzzz qqqq' }],
    ['schedule phrase', { query: 'schedule recurring reminder' }],
    ['normalized punctuation', { query: '  Skills.LIST  ' }],
    ['delegation category alias', { category: 'delegations', query: 'stop' }],
    [
      'allowed types without query',
      {
        allowedActionTypes: ['worktree.run_script', 'worktree.list_scripts'],
        limit: 50,
      },
    ],
    [
      'allowed types with query',
      {
        query: 'run pipeline',
        allowedActionTypes: [
          'pipeline.run',
          'pipeline.list',
          'worktree.run_script',
        ],
      },
    ],
    [
      'feature flag disabled',
      {
        query: 'org project',
        featureFlags: {
          [CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key]: false,
        },
      },
    ],
    ['zero limit', { query: 'chat', limit: 0 }],
    ['non-finite limit', { query: 'chat', limit: Number.NaN }],
    ['fractional limit', { query: 'chat', limit: 3.7 }],
  ];

  it.each(cases)('ranks %s', (_name, input) => {
    expect(describeResult(input)).toMatchSnapshot();
  });

  it('keeps the categories list and result key order', () => {
    const result = searchAppAdvisorActions({ query: 'hook', limit: 50 });
    expect(Object.keys(result)).toEqual([
      'query',
      'totalMatches',
      'returned',
      'categories',
      'actions',
    ]);
    expect(result.categories).toMatchSnapshot();
    expect(
      Array.from(
        new Set(result.actions.map((action) => Object.keys(action).join(','))),
      ),
    ).toMatchSnapshot();
    expect(
      Object.keys(
        searchAppAdvisorActions({
          query: 'x',
          category: 'browser',
          actionType: 'browser.open',
        }),
      ),
    ).toEqual([
      'query',
      'category',
      'actionType',
      'totalMatches',
      'returned',
      'categories',
      'actions',
    ]);
  });

  it('returns hook triggers as fresh copies ranked by the query', () => {
    const [entry] = searchAppAdvisorActions({
      actionType: 'hook.pause',
      query: 'pr review comments',
    }).actions;
    expect(
      entry?.hookTriggers?.map((hook) => hook.triggerName),
    ).toMatchSnapshot();
    expect(entry?.hookTriggers?.length).toBeGreaterThan(0);
    const catalogEntry = APP_ADVISOR_ACTION_CATALOG.find(
      (action) => action.type === 'hook.pause',
    );
    expect(entry?.hookTriggers?.[0]).not.toBe(catalogEntry?.hookTriggers?.[0]);
  });
});

it.each(['projects.list', 'projects.list_tasks', 'projects.list_task_chats'])(
  'catalogs revision-independent explicit discovery %s',
  (type) => {
    const result = searchAppAdvisorActions({ actionType: type });
    expect(result.categories).toContain('projects');
    expect(result.actions[0]).toMatchObject({ type, category: 'projects' });
    expect(APP_ADVISOR_REVISION_AGNOSTIC_ACTION_TYPES).toContain(type);
    expect(result.actions[0]?.fields.map((field) => field.name)).toEqual(
      expect.arrayContaining(['pageSize', 'cursor', 'query', 'name']),
    );
    expect(result.actions[0]?.fields.map((field) => field.name)).not.toContain(
      'expectedUiRevision',
    );
    expect(result.actions[0]?.notes?.join(' ')).toContain('unsupported_filter');
  },
);

it.each(PROJECT_READ_ACTION_TYPES)(
  'catalogs revision-independent explicit read %s',
  (type) => {
    const result = searchAppAdvisorActions({ actionType: type });
    const entry = result.actions[0];
    expect(entry).toMatchObject({ type, category: 'projects' });
    expect(APP_ADVISOR_REVISION_AGNOSTIC_ACTION_TYPES).toContain(type);
    expect(entry?.requiredFields).toEqual(
      expect.arrayContaining(['projectId', 'taskId', 'chatId']),
    );
    expect(entry?.fields.map(({ name }) => name)).not.toContain(
      'expectedUiRevision',
    );
    expect(entry?.notes?.join(' ')).toContain('8,000');
    if (type === 'projects.read_history')
      expect(entry?.notes?.join(' ')).toContain('countsExact');
  },
);

it.each(BOT_ACTION_TYPES)(
  'catalogs revision-independent explicit bot action %s',
  (type) => {
    const result = searchAppAdvisorActions({ actionType: type });
    const entry = result.actions[0];
    expect(result.categories).toContain('bots');
    expect(entry).toMatchObject({ type, category: 'bots' });
    expect(APP_ADVISOR_REVISION_AGNOSTIC_ACTION_TYPES).toContain(type);
    expect(entry?.fields.map(({ name }) => name)).not.toContain(
      'expectedUiRevision',
    );
    if (type !== 'bots.list') {
      expect(entry?.requiredFields).toContain('botId');
    }
    if (type === 'bots.list_tasks' || type === 'bots.list_task_chats') {
      expect(entry?.notes?.join(' ')).toContain('unsupported_filter');
    }
    if (type === 'bots.list_task_chats') {
      expect(entry?.notes?.join(' ')).toContain('previews are omitted');
    }
  },
);

it.each(['projects.send_message', 'bots.send_message'] as const)(
  'catalogs revision-independent %s with receipt guidance',
  (type) => {
    expect(APP_ADVISOR_REVISION_AGNOSTIC_ACTION_TYPES).toContain(type);
    const action = searchAppAdvisorActions({ actionType: type }).actions[0];
    expect(action?.summary).toContain('without');
    expect(action?.notes.join(' ')).toContain('AcceptedInputReceipt');
    expect(action?.optionalFields).toContain('watchers');
  },
);

it.each(['projects.steer_queued_message', 'projects.schedule_message'])(
  'catalogs revision-independent %s',
  (type) => {
    expect(APP_ADVISOR_REVISION_AGNOSTIC_ACTION_TYPES).toContain(type);
    const action = searchAppAdvisorActions({ actionType: type }).actions[0];
    expect(action?.requiredFields).toEqual(
      expect.arrayContaining(['projectId', 'taskId', 'chatId']),
    );
    expect(action?.notes.join(' ')).toContain('Receipt');
    expect(action?.fields.map(({ name }) => name)).not.toContain(
      'expectedUiRevision',
    );
  },
);

it.each([
  'projects.create_task',
  'projects.create_task_chat',
  'bots.create_task',
  'bots.create_task_chat',
])('catalogs revision-independent creation %s', (type) => {
  expect(APP_ADVISOR_REVISION_AGNOSTIC_ACTION_TYPES).toContain(type);
  const action = searchAppAdvisorActions({ actionType: type }).actions[0];
  expect(action?.requiredFields).toContain(
    type.startsWith('projects.') ? 'projectId' : 'botId',
  );
  expect(action?.notes.join(' ')).toContain('CreatedTaskChatReceipt');
  expect(action?.fields.map(({ name }) => name)).not.toContain(
    'expectedUiRevision',
  );
  if (type.endsWith('_chat')) {
    expect(action?.requiredFields).toContain('taskId');
    expect(action?.notes.join(' ')).toContain('reuse');
  }
  if (type.startsWith('bots.'))
    expect(action?.requiredFields).toContain('initialMessage');
});
