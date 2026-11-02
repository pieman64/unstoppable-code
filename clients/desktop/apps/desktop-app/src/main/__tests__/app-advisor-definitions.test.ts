import Ajv, { type AnySchema } from 'ajv';
import { dispatchActionToolSchema } from '../app-advisor/definitions';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import path from 'node:path';
import { ORG_PROJECT_LIMITS } from '@canopy/protocol/org-projects';
import {
  appAdvisorActionSchema,
  appAdvisorGetFileCommentsSchema,
  appAdvisorRespondToFileCommentSchema,
  appAdvisorShowFilesSchema,
  dispatchActionJsonSchema,
  dispatchActionSchema,
  searchActionsSchema,
  searchActionsToolShape,
  searchActionsJsonSchema,
  searchWatchersToolShape,
  SETUP_WATCHERS_DESCRIPTION,
  SEARCH_WATCHERS_DESCRIPTION,
  searchWatchersSchema,
  searchWatchersJsonSchema,
} from '../app-advisor/definitions';
import { z } from 'zod/v4';
import { APP_ADVISOR_SYSTEM_PROMPT } from '../app-advisor/system-prompt';
import {
  searchWatchersJsonSchema as rootSearchWatchersJsonSchema,
  searchWatchersSchema as rootSearchWatchersSchema,
  setupWatchersJsonSchema as rootSetupWatchersJsonSchema,
  setupWatchersSchema as rootSetupWatchersSchema,
  SETUP_WATCHERS_DESCRIPTION as ROOT_SETUP_WATCHERS_DESCRIPTION,
  SEARCH_WATCHERS_DESCRIPTION as ROOT_SEARCH_WATCHERS_DESCRIPTION,
} from '../canopy-tools/definitions';
import { browserActionInputSchema } from '@canopy/agent-actions';
import { scopedWorktreeActionSchema } from '../canopy-tools/definitions';
import {
  APP_ADVISOR_ACTION_CATALOG,
  searchAppAdvisorActions,
} from '@canopy/desktop-shared/lib/app-advisor-actions';
import { MAX_ARCHIVE_RETENTION_DAYS } from '@canopy/desktop-shared/lib/archive-retention';
import { setupWatchersSchema as advisorSetupWatchersSchema } from '../app-advisor/definitions';
import { setupWatchersJsonSchema as advisorSetupWatchersJsonSchema } from '../app-advisor/definitions';

function compileJsonSchema(schema: unknown): ReturnType<Ajv['compile']> {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new Error('Expected a JSON Schema object.');
  }

  // Generated schemas are object-shaped JSON values, while Ajv accepts AnySchema.
  return new Ajv({ strict: false }).compile(schema as AnySchema);
}

describe('Advisor watcher instance search validation', () => {
  const validateJson = compileJsonSchema(searchWatchersJsonSchema);
  it.each([
    [
      {
        activePageSize: 1,
        activeQuery: 'x'.repeat(500),
        targetProjectId: 'p',
        targetTaskId: 't',
        targetChatId: 'c',
        activeCursor: 'cursor',
        limit: 100,
      },
      true,
    ],
    [{ activePageSize: 200, targetBotId: 'app_advisor' }, true],
    [{ activePageSize: 0 }, false],
    [{ activePageSize: 201 }, false],
    [{ activePageSize: 1.5 }, false],
    [{ activeQuery: 'x'.repeat(501) }, false],
    [{ activeCursor: '' }, false],
    [{ activeCursor: 'x'.repeat(1025) }, false],
    [{ targetProjectId: '' }, false],
    [{ targetBotId: '' }, false],
    [{ targetTaskId: '' }, false],
    [{ targetChatId: '' }, false],
    [{ targetProjectId: 'p', targetBotId: 'app_advisor' }, false],
  ] as const)('validates instance search independently: %j', (input, valid) => {
    expect(searchWatchersSchema.safeParse(input).success).toBe(valid);
    expect(validateJson(input)).toBe(valid);
  });
});

describe('canonical chat watcher raw validators', () => {
  const entries = [
    {
      trigger: 'project_task_chat_completion',
      target: { projectId: 'p', taskId: 't', chatId: 'c' },
    },
    { trigger: 'project_new_chat_started', target: { projectId: 'p' } },
    {
      trigger: 'bot_task_chat_completion',
      target: { botId: 'app_advisor', taskId: 't', chatId: 'c' },
    },
    { trigger: 'bot_new_chat_started', target: { botId: 'app_advisor' } },
  ];
  it.each(entries)('accepts $trigger in both actual validators', (entry) => {
    for (const schema of [
      rootSetupWatchersSchema,
      advisorSetupWatchersSchema,
    ]) {
      expect(schema.safeParse({ watchers: [entry] }).success).toBe(true);
      expect(
        schema.safeParse({ watchers: [entry], destinationChatId: 'bad' })
          .success,
      ).toBe(false);
      expect(
        schema.safeParse({
          watchers: [{ ...entry, target: { ...entry.target, kind: 'bad' } }],
        }).success,
      ).toBe(false);
    }
  });
  it.each([
    ['root', rootSetupWatchersSchema, rootSetupWatchersJsonSchema],
    ['Advisor', advisorSetupWatchersSchema, advisorSetupWatchersJsonSchema],
  ] as const)(
    '%s executes strict canonical validation with JSON parity',
    (_name, schema, json) => {
      const validateJson = compileJsonSchema(json);
      const expectInput = (input: unknown, valid: boolean): void => {
        expect(schema.safeParse(input).success).toBe(valid);
        expect(validateJson(input)).toBe(valid);
      };
      for (const entry of entries) {
        expectInput({ watchers: [entry] }, true);
        expectInput(
          {
            watchers: [
              {
                ...entry,
                label: 'x'.repeat(160),
                followUpInstruction: 'x'.repeat(8000),
              },
            ],
          },
          true,
        );
        expectInput(
          { watchers: [{ ...entry, label: 'x'.repeat(161) }] },
          false,
        );
        expectInput(
          { watchers: [{ ...entry, followUpInstruction: 'x'.repeat(8001) }] },
          false,
        );
        for (const key of [
          'unknown',
          'kind',
          'targetKind',
          'destination',
          'destinationChatId',
          'sessionId',
          'owner',
          'display',
          'ui',
          'title',
        ]) {
          expectInput({ watchers: [entry], [key]: 'bad' }, false);
          expectInput({ watchers: [{ ...entry, [key]: 'bad' }] }, false);
          expectInput(
            {
              watchers: [
                { ...entry, target: { ...entry.target, [key]: 'bad' } },
              ],
            },
            false,
          );
        }
        for (const alias of [
          entry,
          [entry],
          JSON.stringify({ watchers: [entry] }),
          { watchers: JSON.stringify([entry]) },
          { watchers: [JSON.stringify(entry)] },
        ]) {
          expectInput(alias, false);
        }
        expectInput({ watchers: Array(10).fill(entry) }, true);
        expectInput({ watchers: Array(11).fill(entry) }, false);
        if (entry.trigger.endsWith('started')) {
          expectInput(
            { watchers: [{ ...entry, armForNextCompletion: false }] },
            false,
          );
          expectInput(
            {
              watchers: [
                { ...entry, target: { ...entry.target, chatId: 'c' } },
              ],
            },
            false,
          );
        } else {
          const { taskId: _taskId, ...target } = entry.target;
          void _taskId;
          expectInput({ watchers: [{ ...entry, target }] }, false);
        }
        const extra =
          'botId' in entry.target
            ? { projectId: 'p' }
            : { botId: 'app_advisor' };
        expectInput(
          { watchers: [{ ...entry, target: { ...entry.target, ...extra } }] },
          false,
        );
      }
    },
  );
  it('retains legacy-only stripping and limits but uses a strict mixed-batch envelope', () => {
    const rootLegacy = {
      trigger: 'worktree_chat_completion',
      target: { projectId: 'p', worktreeId: 't', chatId: 'c' },
      extra: true,
      label: 'x'.repeat(161),
    };
    const advisorLegacy = {
      ...rootLegacy,
      target: { ...rootLegacy.target, kind: 'worktree_chat', extra: true },
    };
    for (const [schema, legacy] of [
      [rootSetupWatchersSchema, rootLegacy],
      [advisorSetupWatchersSchema, advisorLegacy],
    ] as const) {
      const parsed = schema.safeParse({
        watchers: Array(11).fill(legacy),
        extra: true,
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data).not.toHaveProperty('extra');
      expect(schema.safeParse({ watchers: [entries[0], legacy] }).success).toBe(
        true,
      );
      expect(
        schema.safeParse({ watchers: [entries[0], legacy], extra: true })
          .success,
      ).toBe(false);
      expect(
        schema.safeParse({ watchers: [{ ...entries[0], extra: true }, legacy] })
          .success,
      ).toBe(false);
    }
  });
});
import {
  APP_ADVISOR_PROJECT_ID,
  NAVIGATION_PAGE_MAP,
} from '@canopy/desktop-shared/types';

describe('multi-repo project action contracts (CAN-3573)', () => {
  const createType = 'workspace.create_multi_repo';
  const addType = 'workspace.add_repo';
  const removeType = 'workspace.remove_repo';

  it('trims names and strips unsupported creation inputs at the dispatch boundary', () => {
    expect(
      dispatchActionSchema.parse({
        action: {
          type: createType,
          name: '  Payments  ',
          folderPath: '/repos/payments',
          localWorkspaceId: 'existing-project',
        },
        expectedUiRevision: 7,
      }),
    ).toEqual({
      action: { type: createType, name: 'Payments' },
      expectedUiRevision: 7,
    });
  });

  it('accepts the exact name limit after trimming', () => {
    const name = 'x'.repeat(ORG_PROJECT_LIMITS.nameLength);
    expect(
      appAdvisorActionSchema.parse({ type: createType, name: ` ${name} ` }),
    ).toEqual({ type: createType, name });
    expect(
      appAdvisorActionSchema.safeParse({ type: createType, name: 'x' }).success,
    ).toBe(true);
  });

  it.each([
    undefined,
    null,
    '',
    ' \t\n',
    42,
    {},
    'x'.repeat(ORG_PROJECT_LIMITS.nameLength + 1),
  ])('rejects invalid create name %p', (name) => {
    expect(
      appAdvisorActionSchema.safeParse({ type: createType, name }).success,
    ).toBe(false);
  });

  it.each([undefined, null, '', ' \t\n', 42, {}])(
    'rejects invalid IDs %p',
    (id) => {
      for (const action of [
        { type: addType, workspaceId: id, repoPath: '/repos/payments' },
        { type: removeType, workspaceId: id, repoId: 'repo-1' },
        { type: removeType, workspaceId: 'project-1', repoId: id },
      ]) {
        expect(appAdvisorActionSchema.safeParse(action).success).toBe(false);
      }
    },
  );

  it.each([
    undefined,
    null,
    '',
    ' \t\n',
    42,
    {},
    'repos/payments',
    './repo',
    '~/repo',
    'https://github.com/acme/payments.git',
    'file:///repos/payments',
  ])('rejects invalid local repository path %p', (repoPath) => {
    expect(
      appAdvisorActionSchema.safeParse({
        type: addType,
        workspaceId: 'project-1',
        repoPath,
      }).success,
    ).toBe(false);
  });

  it('preserves opaque IDs without rewriting them', () => {
    const action = {
      type: removeType,
      workspaceId: ' Project-1 ',
      repoId: ' Repo-1 ',
    };
    expect(appAdvisorActionSchema.parse(action)).toEqual(action);
  });

  describe.each([
    {
      platform: 'macOS',
      isAbsolute: path.posix.isAbsolute.bind(path.posix),
      paths: ['/repos/Payments service', '/repos/ payments '],
      rejected: ['C:\\repos\\payments', ' \\repo'],
    },
    {
      platform: 'Windows',
      isAbsolute: path.win32.isAbsolute.bind(path.win32),
      paths: [
        'C:\\repos\\Payments service',
        'C:\\repos\\ payments ',
        '\\repos\\ payments ',
        '\\\\server\\share\\ payments ',
      ],
      rejected: ['C:repo', ' \\repo'],
    },
  ])('$platform executing host', ({ isAbsolute, paths, rejected }) => {
    // Exercise the native-path seam without changing process.platform or touching the filesystem.
    beforeEach(() => {
      jest.spyOn(path, 'isAbsolute').mockImplementation(isAbsolute);
    });
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it.each(paths)('preserves the absolute local path %s', (repoPath) => {
      const action = { type: addType, workspaceId: ' Project-1 ', repoPath };
      expect(dispatchActionSchema.parse({ action }).action).toEqual(action);
    });
    it.each(rejected)(
      'rejects paths that are relative on this host: %s',
      (repoPath) => {
        expect(
          appAdvisorActionSchema.safeParse({
            type: addType,
            workspaceId: 'project-1',
            repoPath,
          }).success,
        ).toBe(false);
      },
    );
  });
});

describe('create-from-link action contract', () => {
  it('accepts a URL and optional prompt without a Home draft or project id', () => {
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'worktree.create_from_link',
        url: 'https://github.com/acme/app/pull/7',
        prompt: 'Fix the bug',
      }).success,
    ).toBe(true);
  });

  it.each(['', '  ', 'not a URL', 'file:///tmp/repo'])(
    'rejects invalid link %s',
    (url) => {
      expect(
        appAdvisorActionSchema.safeParse({
          type: 'worktree.create_from_link',
          url,
        }).success,
      ).toBe(false);
    },
  );
});

/**
 * Catalog entries whose documented example does not currently parse against
 * `appAdvisorActionSchema`. Each is a pre-existing gap (CAN-2348), not a
 * licence to add more: the ratchet below fails if this list grows.
 */
const ACTIONS_MISSING_DISPATCH_SCHEMA: readonly string[] = [
  'collections.create',
  'collections.delete',
  'collections.delete_shared',
  'collections.import_shared',
  'collections.list',
  'collections.list_shared',
  'collections.open_manager',
  'collections.share',
  'collections.update',
  'collections.update_shared',
  'pipeline.set_enabled',
  'plugins.list_marketplaces',
  'plugins.open_marketplaces',
  'plugins.refresh_marketplace',
  'plugins.remove_marketplace',
  'preferences.get_global_plugin_selections',
  'preferences.set_global_plugin_selections',
  'worktree-chat.set_interface_mode',
];

describe('App Advisor action schema coverage', () => {
  it.each(['status', 'models', 'connect', 'cancel', 'disconnect'])(
    'accepts OpenCode %s through the tool dispatch boundary',
    (operation) => {
      const action = { type: 'opencode.connection', operation };
      expect(appAdvisorActionSchema.safeParse(action).success).toBe(true);
      expect(dispatchActionSchema.safeParse({ action }).success).toBe(true);
    },
  );

  it.each([undefined, null, '', 'install', 'sign-in', 'change-account', 1])(
    'rejects unsupported OpenCode operation %s',
    (operation) => {
      const action = { type: 'opencode.connection', operation };
      expect(dispatchActionSchema.safeParse({ action }).success).toBe(false);
    },
  );

  it('accepts account proxy routing changes and nothing empty or unknown', () => {
    for (const action of [
      { type: 'account_proxy.set_routing', codex: false },
      {
        type: 'account_proxy.set_routing',
        claude: true,
        keepChatOnOneAccount: true,
      },
    ]) {
      expect(dispatchActionSchema.safeParse({ action }).success).toBe(true);
    }
    for (const action of [
      { type: 'account_proxy.set_routing' },
      { type: 'account_proxy.set_routing', claude: 'yes' },
      { type: 'account_proxy.set_routing', connection: 'https://x.example' },
    ]) {
      expect(dispatchActionSchema.safeParse({ action }).success).toBe(false);
    }
  });

  it('accepts only the read-only account proxy status action', () => {
    for (const action of [
      { type: 'account_proxy.status' },
      { type: 'account_proxy.status', refresh: true },
    ]) {
      expect(dispatchActionSchema.safeParse({ action }).success).toBe(true);
    }
    for (const action of [
      { type: 'account_proxy.status', refresh: 'yes' },
      { type: 'account_proxy.connect', url: 'https://proxy.example.com' },
    ]) {
      expect(dispatchActionSchema.safeParse({ action }).success).toBe(false);
    }
  });

  it('discovers and validates conversation handoff settings actions', () => {
    const types = searchAppAdvisorActions({
      query: 'conversation handoff model',
    }).actions.map((entry) => entry.type);
    expect(types).toContain('settings.get_handoff_model');
    expect(types).toContain('settings.set_handoff_model');
    for (const action of [
      { type: 'settings.get_handoff_model' },
      { type: 'settings.set_handoff_model', model: 'haiku' },
      {
        type: 'settings.set_handoff_model',
        model: 'gpt-5.5',
        thinkingLevel: 'high',
      },
    ])
      expect(appAdvisorActionSchema.safeParse(action).success).toBe(true);
    for (const action of [
      { type: 'settings.set_handoff_model' },
      { type: 'settings.set_handoff_model', model: '' },
      {
        type: 'settings.set_handoff_model',
        model: 'haiku',
        thinkingLevel: 'extreme',
      },
    ])
      expect(appAdvisorActionSchema.safeParse(action).success).toBe(false);
  });
  it('discovers and validates Claude turn-limit actions', () => {
    for (const maxTurns of [1, 500, 9999, null]) {
      expect(
        appAdvisorActionSchema.safeParse({
          type: 'settings.set_claude_max_turns',
          maxTurns,
        }).success,
      ).toBe(true);
    }
    for (const maxTurns of [0, -1, 10000, 1.5, '500', undefined]) {
      expect(
        appAdvisorActionSchema.safeParse({
          type: 'settings.set_claude_max_turns',
          maxTurns,
        }).success,
      ).toBe(false);
    }
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'settings.get_claude_max_turns',
      }).success,
    ).toBe(true);
    const types = searchAppAdvisorActions({
      query: 'Claude turn limit',
    }).actions.map((entry) => entry.type);
    expect(types).toContain('settings.get_claude_max_turns');
    expect(types).toContain('settings.set_claude_max_turns');
  });
  it('finds remote control actions only when the feature is on', () => {
    const flag = CLIENT_FEATURE_FLAGS.canopyDeviceRemoteControl.key;
    const search = (enabled: boolean): string[] =>
      searchAppAdvisorActions({
        query: 'remote control other computer',
        featureFlags: { [flag]: enabled },
      }).actions.map((entry) => entry.type);
    expect(search(true)).toEqual(
      expect.arrayContaining([
        'remote_control.get_state',
        'remote_control.open_computer',
        'remote_control.set_allow_incoming',
      ]),
    );
    expect(
      search(false).filter((type) => type.startsWith('remote_control.')),
    ).toEqual([]);
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'remote_control.open_computer',
        deviceId: null,
      }).success,
    ).toBe(true);
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'remote_control.open_computer',
        deviceId: '',
      }).success,
    ).toBe(false);
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'remote_control.set_allow_incoming',
        enabled: 'yes',
      }).success,
    ).toBe(false);
  });

  it('discovers canonical bot entry and chat actions without an automation', () => {
    for (const type of [
      'bots.create_task',
      'bots.create_task_chat',
      'bots.send_message',
    ]) {
      const [entry] = searchAppAdvisorActions({ actionType: type }).actions;
      expect(entry?.type).toBe(type);
      expect(entry?.fields.map((field) => field.name)).toContain('botId');
      expect(entry?.fields.map((field) => field.name)).not.toContain(
        'projectId',
      );
    }
  });

  it('accepts only valid direct Advisor chat creation and target actions', () => {
    for (const action of [
      { type: 'advisor-chat.create_entry', title: 'Fresh task', text: 'Begin' },
      {
        type: 'advisor-chat.create_chat',
        workEntryId: 'entry-1',
        text: 'Begin',
      },
      {
        type: 'advisor-chat.send_message',
        workEntryId: 'entry-1',
        chatId: 'chat-1',
        text: 'Continue',
      },
    ]) {
      expect(appAdvisorActionSchema.safeParse(action).success).toBe(true);
    }
    for (const action of [
      { type: 'advisor-chat.create_entry', text: '  ' },
      { type: 'advisor-chat.create_chat', workEntryId: '', text: 'Begin' },
      {
        type: 'advisor-chat.send_message',
        workEntryId: 'entry-1',
        chatId: '',
        text: 'Continue',
      },
    ]) {
      expect(appAdvisorActionSchema.safeParse(action).success).toBe(false);
    }
  });

  it('retains compatibility queued-message steering acceptance', () => {
    const entry = APP_ADVISOR_ACTION_CATALOG.find(
      (candidate) => candidate.type === 'worktree-chat.steer_queued_message',
    );
    expect(entry).toBeDefined();
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'worktree-chat.steer_queued_message',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        queuedMessageId: 'queued-1',
      }).success,
    ).toBe(true);
  });

  it('advertises and accepts the exact Codex speed setter', () => {
    const entry = APP_ADVISOR_ACTION_CATALOG.find(
      (candidate) => candidate.type === 'worktree-chat.set_speed',
    );
    const speedField = entry?.fields.find((field) => field.name === 'speed');
    expect(entry?.category).toBe('worktree-chat');
    expect(speedField).toMatchObject({
      type: "'standard' | 'fast' | 'ultrafast'",
      required: true,
    });
    expect(speedField?.description).toContain('Regular');
    for (const query of [
      'set chat speed to ultra fast',
      'switch codex speed back to regular',
      'ultrafast',
    ]) {
      expect(
        searchAppAdvisorActions({ query }).actions.map((action) => action.type),
      ).toContain('worktree-chat.set_speed');
    }
    for (const speed of ['standard', 'fast', 'ultrafast']) {
      expect(
        appAdvisorActionSchema.safeParse({
          type: 'worktree-chat.set_speed',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
          speed,
        }).success,
      ).toBe(true);
    }
    for (const action of [
      { type: 'worktree-chat.set_speed', speed: 'turbo' },
      { type: 'worktree-chat.set_speed', speed: true },
      { type: 'worktree-chat.set_speed', enabled: true },
    ]) {
      expect(appAdvisorActionSchema.safeParse(action).success).toBe(false);
    }
  });

  it('keeps the legacy boolean fast-mode setter and documents its replacement', () => {
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'worktree-chat.set_fast_mode',
        enabled: false,
      }).success,
    ).toBe(true);
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'worktree-chat.set_fast_mode',
        speed: 'ultrafast',
      }).success,
    ).toBe(false);
    // An explicit boolean replaces the speed, including Ultra fast, so the
    // catalog must say so rather than read as a harmless toggle.
    expect(
      APP_ADVISOR_ACTION_CATALOG.find(
        (candidate) => candidate.type === 'worktree-chat.set_fast_mode',
      )?.summary,
    ).toContain('replacing the current speed');
  });

  it.each(['claude', 'codex'])(
    'preserves a %s worktree model harness through dispatch parsing',
    (executionHarness) => {
      const action = {
        type: 'worktree-chat.set_model',
        model: 'ollama-qwen3',
        executionHarness,
      };
      expect(dispatchActionSchema.parse({ action }).action).toEqual(action);
    },
  );

  it('rejects an unsupported worktree model harness', () => {
    expect(
      dispatchActionSchema.safeParse({
        action: {
          type: 'worktree-chat.set_model',
          model: 'ollama-qwen3',
          executionHarness: 'cursor',
        },
      }).success,
    ).toBe(false);
  });

  it('accepts worktree script actions with a bounded wait', () => {
    const target = { projectId: 'project-1', worktreeId: 'worktree-1' };
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'worktree.list_scripts',
        ...target,
      }).success,
    ).toBe(true);
    for (const waitSeconds of [0, 600]) {
      expect(
        appAdvisorActionSchema.safeParse({
          type: 'worktree.run_script',
          ...target,
          scriptId: 'test',
          repo: 'api',
          waitSeconds,
        }).success,
      ).toBe(true);
    }
    for (const action of [
      { type: 'worktree.list_scripts' },
      { type: 'worktree.run_script', ...target },
      { type: 'worktree.run_script', ...target, scriptId: '' },
      {
        type: 'worktree.run_script',
        ...target,
        scriptId: 'test',
        waitSeconds: 601,
      },
      {
        type: 'worktree.run_script',
        ...target,
        scriptId: 'test',
        waitSeconds: 2.5,
      },
    ]) {
      expect(appAdvisorActionSchema.safeParse(action).success).toBe(false);
    }
  });

  it('accepts active preview search drawer controls', () => {
    expect(
      appAdvisorActionSchema.safeParse({ type: 'file.preview_search_open' })
        .success,
    ).toBe(true);
    expect(
      appAdvisorActionSchema.safeParse({ type: 'file.preview_search_close' })
        .success,
    ).toBe(true);
  });
  // `searchActionsJsonSchema`/`dispatchActionJsonSchema` build their `type`
  // enum from the catalog, so the assistant is taught every action listed
  // there. A catalog entry with no matching member in the
  // `appAdvisorActionSchema` discriminated union is rejected at dispatch
  // (`tool-executor.ts` safeParse) — the assistant is taught a call that can
  // only ever error. `satisfies z.ZodType<AppAdvisorAction>` does not catch
  // this, because a union missing a member still satisfies the supertype.
  // `toSearchResultAction` returns `additionalExamples` to the model too, so a
  // broken extra advertises the same undispatchable call as a broken primary.
  function unparsableCatalogActionTypes(): string[] {
    return APP_ADVISOR_ACTION_CATALOG.filter((entry) =>
      [entry.example, ...(entry.additionalExamples ?? [])].some(
        (example) => !appAdvisorActionSchema.safeParse(example).success,
      ),
    ).map((entry) => entry.type);
  }

  it('accepts the documented examples for every dispatchable catalog action', () => {
    const regressions = unparsableCatalogActionTypes().filter(
      (type) => !ACTIONS_MISSING_DISPATCH_SCHEMA.includes(type),
    );
    expect(regressions).toEqual([]);
  });

  it('has no stale entries in the known-gap list', () => {
    const unparsable = new Set<string>(unparsableCatalogActionTypes());

    const fixed = ACTIONS_MISSING_DISPATCH_SCHEMA.filter(
      (type) => !unparsable.has(type),
    );
    expect(fixed).toEqual([]);
  });

  it('validates publisher marketplace search options at the main boundary', () => {
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'skills.list_marketplace',
        query: 'Anthropic',
        limit: 200,
      }).success,
    ).toBe(true);
    for (const limit of [0, 201, 1.5, '10']) {
      expect(
        appAdvisorActionSchema.safeParse({
          type: 'skills.list_marketplace',
          limit,
        }).success,
      ).toBe(false);
    }
  });

  it('accepts every documented example for settings.set_profile_role', () => {
    const entry = APP_ADVISOR_ACTION_CATALOG.find(
      (candidate) => candidate.type === 'settings.set_profile_role',
    );
    if (!entry) throw new Error('Expected a settings.set_profile_role entry');

    for (const example of [
      entry.example,
      ...(entry.additionalExamples ?? []),
    ]) {
      expect(appAdvisorActionSchema.safeParse(example).success).toBe(true);
    }
  });

  it('rejects an unknown profile role', () => {
    const result = appAdvisorActionSchema.safeParse({
      type: 'settings.set_profile_role',
      role: 'astronaut',
    });
    expect(result.success).toBe(false);
  });

  it('accepts Terminal settings navigation', () => {
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'navigation.open_settings',
        section: 'terminal',
      }).success,
    ).toBe(true);
  });

  it('accepts pipeline resume with requested pause inputs', () => {
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'pipeline.execution_resume',
        executionId: 'execution-1',
        pauseResponses: [
          {
            checkpointId: 'checkpoint-1',
            jobId: 'review',
            stepId: 'approval',
            answers: { approved: true, reviewer: 'Ada', score: 10 },
          },
        ],
      }).success,
    ).toBe(true);
  });

  it('requires an exact checkpoint id for requested pause inputs', () => {
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'pipeline.execution_resume',
        executionId: 'execution-1',
        pauseResponses: [
          {
            jobId: 'review',
            stepId: 'approval',
            answers: { approved: true },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('accepts Plugins entry-detail navigation with a non-empty entry id', () => {
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'plugins.open_entry_detail',
        entryId: 'skill:builtin:app:review-checklist',
      }).success,
    ).toBe(true);
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'plugins.open_entry_detail',
        entryId: '',
      }).success,
    ).toBe(false);
  });

  it('bounds the organization Cowork project name (CAN-3453)', (): void => {
    const parsed = appAdvisorActionSchema.safeParse({
      type: 'org_project.create_cowork',
      name: '  Launch plan  ',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({
      type: 'org_project.create_cowork',
      name: 'Launch plan',
    });
    for (const name of ['', '   ', 'x'.repeat(257)]) {
      expect(
        appAdvisorActionSchema.safeParse({
          type: 'org_project.create_cowork',
          name,
        }).success,
      ).toBe(false);
    }
  });

  it('bounds the organization Code project name and takes an optional folder (CAN-3534)', (): void => {
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'org_project.create_code',
        name: '  Payments service  ',
      }).data,
    ).toEqual({ type: 'org_project.create_code', name: 'Payments service' });
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'org_project.create_code',
        name: 'Payments service',
        folderPath: ' /Users/me/payments ',
      }).data,
    ).toEqual({
      type: 'org_project.create_code',
      name: 'Payments service',
      folderPath: '/Users/me/payments',
    });
    for (const name of ['', '   ', 'x'.repeat(257)]) {
      expect(
        appAdvisorActionSchema.safeParse({
          type: 'org_project.create_code',
          name,
        }).success,
      ).toBe(false);
    }
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'org_project.create_code',
        name: 'Payments service',
        folderPath: '   ',
      }).success,
    ).toBe(false);
  });

  describe('workspace.find_repository_owner (CAN-3592)', (): void => {
    const type = 'workspace.find_repository_owner';

    it('accepts exactly one absolute folder path and projects it alone', (): void => {
      const parsed = appAdvisorActionSchema.safeParse({
        type,
        path: '/repos/payments',
      });
      expect(parsed.success).toBe(true);
      expect(parsed.data).toStrictEqual({ type, path: '/repos/payments' });
      // An explicit undefined for the other key is still "one key".
      const withUndefined = appAdvisorActionSchema.safeParse({
        type,
        path: '/repos/payments',
        remoteUrl: undefined,
      });
      expect(withUndefined.success).toBe(true);
      expect(withUndefined.data).toStrictEqual({
        type,
        path: '/repos/payments',
      });
      // The IPC bound is inclusive: exactly 4096 characters is accepted.
      expect(
        appAdvisorActionSchema.safeParse({ type, path: `/${'x'.repeat(4095)}` })
          .success,
      ).toBe(true);
    });

    it('accepts exactly one bounded clone URL and projects it verbatim', (): void => {
      const parsed = appAdvisorActionSchema.safeParse({
        type,
        remoteUrl: 'https://github.com/acme/payments.git',
      });
      expect(parsed.success).toBe(true);
      expect(parsed.data).toStrictEqual({
        type,
        remoteUrl: 'https://github.com/acme/payments.git',
      });
      // The IPC bound is inclusive: exactly 2048 characters is accepted.
      expect(
        appAdvisorActionSchema.safeParse({ type, remoteUrl: 'x'.repeat(2048) })
          .success,
      ).toBe(true);
      // Parity with the IPC parser, which forwards the URL untrimmed.
      expect(
        appAdvisorActionSchema.safeParse({
          type,
          remoteUrl: '  https://github.com/acme/x.git ',
        }).data,
      ).toStrictEqual({
        type,
        remoteUrl: '  https://github.com/acme/x.git ',
      });
    });

    it.each([
      ['neither key', {}],
      [
        'both keys',
        { path: '/repos/payments', remoteUrl: 'https://github.com/acme/x.git' },
      ],
      [
        'a null for the other key',
        { path: '/repos/payments', remoteUrl: null },
      ],
      ['a relative path', { path: 'relative/payments' }],
      ['an empty path', { path: '' }],
      ['a non-string path', { path: 42 }],
      ['a path over 4096 characters', { path: `/${'x'.repeat(4096)}` }],
      ['an empty URL', { remoteUrl: '' }],
      ['a whitespace-only URL', { remoteUrl: '   ' }],
      ['a URL over 2048 characters', { remoteUrl: 'x'.repeat(2049) }],
      ['an unknown key', { path: '/repos/payments', extra: true }],
    ])('rejects %s', (_label, payload): void => {
      expect(
        appAdvisorActionSchema.safeParse({ type, ...payload }).success,
      ).toBe(false);
    });
  });
});

describe('App Advisor file and browser targeting', () => {
  it('requires the advertised runtime generation for existing-tab actions', () => {
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'browser.navigate',
        browserId: 'browser-1',
        url: 'http://localhost:3000',
      }).success,
    ).toBe(false);
  });

  it.each([
    { type: 'browser.get_dialog' },
    {
      type: 'browser.handle_dialog',
      dialogId: 'dialog-1',
      accept: false,
      promptText: 'retained prompt text',
    },
    {
      type: 'browser.click',
      ref: 'control-1',
      dialogResponse: { accept: false },
    },
    {
      type: 'browser.press',
      key: 'Enter',
      dialogResponse: { accept: true, promptText: 'confirmed prompt text' },
    },
  ])('preserves $type dialog fields and browser authority', (input) => {
    const action = {
      ...input,
      browserId: 'browser-1',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      expectedRuntimeGeneration: 7,
    };

    const result = dispatchActionSchema.safeParse({ action });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.action).toEqual(action);
    }
  });

  it('accepts up to ten ShowFiles entries and ignores invalid view/line hints', () => {
    const result = appAdvisorShowFilesSchema.safeParse({
      files: [{ path: 'README.md', view: 'not-a-view', line: -1 }],
      workspace: { projectId: 'project-1', worktreeId: 'worktree-1' },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.files[0]).toEqual({
        path: 'README.md',
        view: undefined,
        line: undefined,
      });
    }
    expect(
      appAdvisorShowFilesSchema.safeParse({
        files: Array.from({ length: 11 }, (_, index) => ({
          path: `file-${index}.txt`,
        })),
      }).success,
    ).toBe(false);
  });

  it.each([
    [
      'ShowFiles',
      appAdvisorShowFilesSchema,
      { files: [{ path: 'README.md' }] },
    ],
    ['GetFileComments', appAdvisorGetFileCommentsSchema, {}],
    [
      'RespondToFileComment',
      appAdvisorRespondToFileCommentSchema,
      { threadId: 'thread-1', body: 'Done' },
    ],
  ])('rejects unsafe project ids for %s', (_name, schema, input) => {
    expect(
      schema.safeParse({
        ...input,
        workspace: {
          projectId: '../../outside',
          worktreeId: 'worktree-1',
        },
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...input,
        workspace: {
          projectId: 'project-1',
          worktreeId: 'INVALID',
        },
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...input,
        workspace: {
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: 'worktree-1',
        },
      }).success,
    ).toBe(false);
  });

  it('accepts an explicit project scope on every browser action', () => {
    const actions = [
      { type: 'browser.list' },
      { type: 'browser.open' },
      {
        type: 'browser.navigate',
        expectedRuntimeGeneration: 1,
        url: 'http://localhost:3000',
      },
      { type: 'browser.back', expectedRuntimeGeneration: 1 },
      { type: 'browser.forward', expectedRuntimeGeneration: 1 },
      { type: 'browser.reload', expectedRuntimeGeneration: 1 },
      { type: 'browser.stop', expectedRuntimeGeneration: 1 },
      {
        type: 'browser.click',
        expectedRuntimeGeneration: 1,
        ref: 'control-1',
      },
      {
        type: 'browser.fill',
        expectedRuntimeGeneration: 1,
        ref: 'control-1',
        text: 'hello',
      },
      { type: 'browser.press', expectedRuntimeGeneration: 1, key: 'Enter' },
      { type: 'browser.screenshot', expectedRuntimeGeneration: 1 },
      { type: 'browser.input_snapshot', expectedRuntimeGeneration: 1 },
      {
        type: 'browser.inspect',
        expectedRuntimeGeneration: 1,
        ref: 'control-1',
      },
      { type: 'browser.get_console', expectedRuntimeGeneration: 1 },
      { type: 'browser.get_network', expectedRuntimeGeneration: 1 },
      { type: 'browser.start_recording', expectedRuntimeGeneration: 1 },
      { type: 'browser.stop_recording', expectedRuntimeGeneration: 1 },
      { type: 'browser.open_external', expectedRuntimeGeneration: 1 },
    ];

    for (const action of actions) {
      expect(
        appAdvisorActionSchema.safeParse({
          ...action,
          projectId: 'project-1',
          worktreeId: 'worktree-1',
        }).success,
      ).toBe(true);
    }
  });

  it('accepts the browser focus and wait_for actions with runtime scope', () => {
    const common = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      expectedRuntimeGeneration: 3,
    };

    expect(
      appAdvisorActionSchema.safeParse({
        type: 'browser.focus',
        ...common,
        locator: 'button[title="Save"]',
        actionId: 'focus-save',
      }).success,
    ).toBe(true);

    for (const condition of [
      { locator: 'button[title="Save"]', state: 'visible' },
      { text: 'Saved', state: 'hidden' },
      { url: '**/settings' },
      { loadState: 'domcontentloaded' },
    ]) {
      expect(
        appAdvisorActionSchema.safeParse({
          type: 'browser.wait_for',
          ...common,
          ...condition,
          timeoutMs: 120_000,
          actionId: 'wait-for-save',
        }).success,
      ).toBe(true);
    }

    for (const action of [
      { type: 'browser.focus', ...common },
      { type: 'browser.focus', ...common, ref: 'control-1', locator: 'button' },
      {
        type: 'browser.focus',
        ...common,
        ref: 'control-1',
        expectedRuntimeGeneration: undefined,
      },
      { type: 'browser.wait_for', ...common },
      { type: 'browser.wait_for', ...common, locator: 'button', text: 'Saved' },
      {
        type: 'browser.wait_for',
        ...common,
        locator: 'button',
        state: 'disabled',
      },
      { type: 'browser.wait_for', ...common, loadState: 'idle' },
      {
        type: 'browser.wait_for',
        ...common,
        locator: 'button',
        timeoutMs: 120_001,
      },
    ]) {
      expect(appAdvisorActionSchema.safeParse(action).success).toBe(false);
    }

    expect(
      appAdvisorActionSchema.safeParse({
        type: 'browser.wait_for',
        ...common,
        locator: 'button',
        state: 'visible',
        timeoutMs: 120_000,
      }).success,
    ).toBe(true);
  });

  it('accepts, trims, and preserves the expanded browser click fields', () => {
    const action = {
      type: 'browser.click',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      expectedRuntimeGeneration: 3,
      ref: 'control-1',
      button: 'middle',
      clickCount: 3,
      modifiers: ['Alt', 'Meta'],
      position: { x: 0, y: 8 },
      actionId: ' click-save ',
      timeoutMs: 60_000,
    };
    const result = appAdvisorActionSchema.safeParse(action);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ ...action, actionId: 'click-save' });
    }

    const { position: _position, ...clickWithoutPosition } = action;
    void _position;
    expect(
      appAdvisorActionSchema.safeParse({
        ...clickWithoutPosition,
        force: true,
      }).success,
    ).toBe(true);

    for (const invalid of [
      { button: 'top' },
      { clickCount: 0 },
      { clickCount: 4 },
      { clickCount: 1.5 },
      { modifiers: ['Alt', 'Alt'] },
      { modifiers: ['Alt', 'Control', 'Meta', 'Shift', 'Alt'] },
      { modifiers: ['Command'] },
      { position: { x: -1, y: 0 } },
      { position: { x: Number.POSITIVE_INFINITY, y: 0 } },
      { position: { x: 0 } },
      { position: { x: 1, y: 2 }, force: true },
      { force: 'true' },
      { actionId: '   ' },
      { actionId: 'a'.repeat(129) },
      { timeoutMs: 0 },
      { timeoutMs: 60_001 },
    ]) {
      expect(
        appAdvisorActionSchema.safeParse({ ...action, ...invalid }).success,
      ).toBe(false);
    }
  });

  it.each(['projectId', 'worktreeId'])(
    'rejects empty and unsafe browser %s values',
    (field) => {
      for (const value of ['', '../../outside', 'INVALID']) {
        expect(
          appAdvisorActionSchema.safeParse({
            type: 'browser.list',
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            [field]: value,
          }).success,
        ).toBe(false);
      }
    },
  );

  it('rejects the reserved App Advisor project id for browser actions', () => {
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'browser.list',
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'worktree-1',
      }).success,
    ).toBe(false);
  });
});

describe('appAdvisorActionSchema — agent resources', () => {
  it.each([
    { type: 'skills.read_shared', skillId: 'skill-1' },
    { type: 'skills.open_shared_viewer', skillId: 'skill-1' },
    { type: 'automation.open_editor', id: 'activity-1' },
    { type: 'automation.open_editor', id: 'activity-1', section: 'runs' },
    { type: 'pipeline.open_editor', pipelineId: 'build', section: 'trigger' },
    {
      type: 'automation.open_shared_pipeline_review',
      id: 'activity-1',
    },
  ])('accepts $type', (action) => {
    expect(appAdvisorActionSchema.safeParse(action).success).toBe(true);
  });

  it.each([
    { type: 'skills.read_shared' },
    { type: 'skills.open_shared_viewer', skillId: '' },
    { type: 'automation.open_editor', id: '' },
    { type: 'automation.open_editor', id: 'activity-1', section: 'history' },
    { type: 'pipeline.open_editor', pipelineId: 'build', section: 'settings' },
    { type: 'automation.open_shared_pipeline_review', id: '' },
  ])('rejects invalid $type payloads', (action) => {
    expect(appAdvisorActionSchema.safeParse(action).success).toBe(false);
  });

  it.each(['automation.create', 'automation.run_now'] as const)(
    'rejects pipeline-only terminalStatuses on %s inline watchers',
    (type) => {
      const action =
        type === 'automation.create'
          ? {
              type,
              input: {},
              watchers: [{ terminalStatuses: ['failure'] }],
            }
          : {
              type,
              id: 'activity-1',
              watchers: [{ terminalStatuses: ['failure'] }],
            };

      expect(appAdvisorActionSchema.safeParse(action).success).toBe(false);
    },
  );

  it.each(['automation.create', 'automation.run_now'] as const)(
    'accepts supported %s inline watcher fields',
    (type) => {
      const action =
        type === 'automation.create'
          ? {
              type,
              input: {},
              watchers: [{ followUpInstruction: 'Report the outcome.' }],
            }
          : {
              type,
              id: 'activity-1',
              watchers: [{ followUpInstruction: 'Report the outcome.' }],
            };

      expect(appAdvisorActionSchema.safeParse(action).success).toBe(true);
    },
  );

  it('preserves project pipeline repository scope', () => {
    const result = appAdvisorActionSchema.safeParse({
      type: 'pipeline.open_editor',
      pipelineId: 'project--build.yaml',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      repoId: 'child-repo',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({ repoId: 'child-repo' });
    }
  });
});

describe('appAdvisorActionSchema — Agent actions', () => {
  const agentEntries = APP_ADVISOR_ACTION_CATALOG.filter((entry) =>
    entry.type.startsWith('agents.'),
  );
  const agentExamples = agentEntries.flatMap((entry) =>
    [entry.example, ...(entry.additionalExamples ?? [])].map((action) => ({
      type: entry.type,
      action,
    })),
  );
  const pluginSelections = {
    collectionIds: ['collection-1'],
    skillRefs: [{ sourceId: 'source-1', skillName: 'review' }],
    pluginRefs: [{ marketplaceId: 'market-1', pluginName: 'lint' }],
    mcpServerRefs: [{ serverId: 'server-1', configId: 'config-1' }],
  };

  it('catalogs the eleven agreed Agent actions', () => {
    expect(agentEntries.map((entry) => entry.type).sort()).toEqual([
      'agents.create',
      'agents.delete',
      'agents.delete_shared',
      'agents.get',
      'agents.import_shared',
      'agents.list',
      'agents.list_shared',
      'agents.open_manager',
      'agents.publish_public_share',
      'agents.revoke_public_share',
      'agents.update',
    ]);
  });

  // Independent of ACTIONS_MISSING_DISPATCH_SCHEMA: re-exempting an Agent
  // action there cannot hide an undispatchable Agent example.
  it.each(agentExamples)(
    'dispatches every documented $type example',
    ({ action }) => {
      expect(appAdvisorActionSchema.safeParse(action).success).toBe(true);
      expect(dispatchActionSchema.safeParse({ action }).success).toBe(true);
    },
  );

  it('keeps every Agent action out of the known-gap list', () => {
    expect(
      ACTIONS_MISSING_DISPATCH_SCHEMA.filter((type) =>
        type.startsWith('agents.'),
      ),
    ).toEqual([]);
  });

  it.each([
    { type: 'agents.list', query: 'review', limit: 2 },
    {
      type: 'agents.list_shared',
      query: 'review',
      limit: 5,
      cursor: 'cursor-1',
      createdBy: 'me',
    },
    { type: 'agents.list_shared', createdBy: 'anyone' },
    {
      type: 'agents.create',
      name: 'Code Reviewer',
      baseModel: 'opus',
      instructions: '  Review code.\n',
      modelIdSlug: 'code_reviewer',
      pluginSelections,
    },
    {
      type: 'agents.update',
      id: 'agent_model_code_reviewer',
      name: 'Reviewer',
      baseModel: 'sonnet',
      instructions: 'Call out missing tests.',
      pluginSelections,
    },
    { type: 'agents.update', id: 'agent_model_code_reviewer', name: '' },
    {
      type: 'agents.update',
      id: 'agent_model_code_reviewer',
      pluginSelections,
    },
  ])('preserves the optional fields of $type', (action) => {
    const result = appAdvisorActionSchema.safeParse(action);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(action);
  });

  it.each([
    { type: 'agents.get' },
    { type: 'agents.get', id: '' },
    { type: 'agents.delete', id: 7 },
    { type: 'agents.list', query: 7 },
    { type: 'agents.list', limit: '2' },
    { type: 'agents.list_shared', createdBy: 'team' },
    { type: 'agents.list_shared', cursor: 1 },
    { type: 'agents.import_shared' },
    { type: 'agents.delete_shared', agentId: '' },
    { type: 'agents.create', baseModel: 'opus', instructions: 'Review.' },
    { type: 'agents.create', name: 'Reviewer', instructions: 'Review.' },
    { type: 'agents.create', name: 'Reviewer', baseModel: 'opus' },
    {
      type: 'agents.create',
      name: 'Reviewer',
      baseModel: 'opus',
      instructions: '',
    },
    {
      type: 'agents.create',
      name: 'Reviewer',
      baseModel: 'opus',
      instructions: 'Review.',
      modelIdSlug: 3,
    },
    {
      type: 'agents.create',
      name: 'Reviewer',
      baseModel: 'opus',
      instructions: 'Review.',
      pluginSelections: { collectionIds: ['collection-1'] },
    },
    { type: 'agents.update', name: 'Reviewer' },
    { type: 'agents.update', id: 'agent_model_code_reviewer' },
    { type: 'agents.update', id: 'agent_model_code_reviewer', name: 5 },
    {
      type: 'agents.update',
      id: 'agent_model_code_reviewer',
      pluginSelections: { skillRefs: 'review' },
    },
  ])('rejects invalid $type payloads', (action) => {
    expect(appAdvisorActionSchema.safeParse(action).success).toBe(false);
    expect(dispatchActionSchema.safeParse({ action }).success).toBe(false);
  });
});

describe('appAdvisorActionSchema — archived containers', () => {
  it.each([
    { type: 'archived.list', workspaceId: 'workspace-1' },
    {
      type: 'archived.open',
      workspaceId: 'workspace-1',
      containerId: 'archive-1',
      tab: 'chats',
      chatId: 'chat-1',
    },
    {
      type: 'archived.open',
      workspaceId: 'workspace-1',
      containerId: 'archive-1',
      tab: 'changes',
    },
    {
      type: 'archived.open',
      workspaceId: 'workspace-1',
      containerId: 'archive-1',
      tab: 'attachments',
    },
    {
      type: 'archived.open',
      workspaceId: 'workspace-1',
      containerId: 'archive-1',
      tab: 'pipelines',
    },
    {
      type: 'archived.open',
      workspaceId: 'workspace-1',
      containerId: 'archive-1',
      tab: 'plans',
      planId: 'plan-1',
    },
    {
      type: 'archived.read_chat',
      workspaceId: 'workspace-1',
      containerId: 'archive-1',
      chatId: 'chat-1',
      limit: 100,
    },
    {
      type: 'archived.restore',
      workspaceId: 'workspace-1',
      containerId: 'archive-1',
    },
    {
      type: 'archived.set_locked',
      workspaceId: 'workspace-1',
      containerId: 'archive-1',
      locked: true,
    },
    {
      type: 'app_advisor.update_settings',
      archiveRetentionDays: 30,
      autoArchiveDays: 7,
    },
    {
      type: 'archived.open_overview',
      workspaceId: 'workspace-1',
    },
    {
      type: 'archived.open_empty_trash',
      workspaceId: 'workspace-1',
    },
  ])('accepts $type', (action) => {
    const result = appAdvisorActionSchema.safeParse(action);
    expect(result.success).toBe(true);
    if (
      result.success &&
      action.type === 'archived.open' &&
      'planId' in action
    ) {
      expect(result.data).toMatchObject({ planId: action.planId });
    }
  });

  it.each([
    {
      type: 'archived.open',
      workspaceId: 'workspace-1',
      containerId: 'archive-1',
      tab: 'files',
    },
    {
      type: 'archived.read_chat',
      workspaceId: 'workspace-1',
      containerId: '',
      chatId: 'chat-1',
    },
    {
      type: 'archived.restore',
      workspaceId: '',
      containerId: 'archive-1',
    },
    {
      type: 'archived.set_locked',
      workspaceId: 'workspace-1',
      containerId: 'archive-1',
      locked: 'yes',
    },
  ])('rejects invalid $type payloads', (action) => {
    expect(appAdvisorActionSchema.safeParse(action).success).toBe(false);
  });

  it.each([0, null])(
    'rejects %p as an archive-retention value for new actions',
    (archiveRetentionDays) => {
      expect(
        appAdvisorActionSchema.safeParse({
          type: 'standalone-chat.update_settings',
          projectId: 'workspace-1',
          archiveRetentionDays,
        }).success,
      ).toBe(false);
    },
  );

  it.each([
    {
      type: 'workspace.update_local_settings',
      workspaceId: 'workspace-1',
      autoArchiveDays: 0,
    },
    {
      type: 'standalone-chat.update_settings',
      projectId: 'workspace-1',
      autoArchiveDays: 0,
    },
    { type: 'app_advisor.update_settings', autoArchiveDays: 0 },
  ])('rejects zero Auto Delete days for $type', (action) => {
    expect(appAdvisorActionSchema.safeParse(action).success).toBe(false);
  });

  it('accepts Auto Delete settings on code and cowork workspace updates', () => {
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'workspace.update_local_settings',
        workspaceId: 'workspace-1',
        archiveRetentionDays: 30,
        autoArchiveDays: 7,
        autoArchiveDeleteBranch: true,
      }).success,
    ).toBe(true);
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'standalone-chat.update_settings',
        projectId: 'cowork-1',
        archiveRetentionDays: 30,
        autoArchiveDays: 7,
      }).success,
    ).toBe(true);
  });

  it('accepts cowork visibility and project environment assignment updates', () => {
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'standalone-chat.update_settings',
        projectId: 'workspace-1',
        alwaysShow: false,
      }).success,
    ).toBe(true);
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'environment.update_workspace_assignment',
        workspaceId: 'workspace-1',
        runtimes: { agent: 'environment-1', pipeline: null },
      }).success,
    ).toBe(true);
  });

  it('rejects unknown project environment runtime keys', () => {
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'environment.update_workspace_assignment',
        workspaceId: 'workspace-1',
        runtimes: { agents: 'environment-1' },
      }).success,
    ).toBe(false);
  });

  it('rejects deletion retention above the supported maximum', () => {
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'standalone-chat.update_settings',
        projectId: 'workspace-1',
        archiveRetentionDays: MAX_ARCHIVE_RETENTION_DAYS,
      }).success,
    ).toBe(true);
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'standalone-chat.update_settings',
        projectId: 'workspace-1',
        archiveRetentionDays: MAX_ARCHIVE_RETENTION_DAYS + 1,
      }).success,
    ).toBe(false);
  });
});

describe('dispatch_action JSON Schema scope', () => {
  if (
    dispatchActionJsonSchema === null ||
    typeof dispatchActionJsonSchema !== 'object' ||
    Array.isArray(dispatchActionJsonSchema)
  )
    throw new Error('Expected dispatch_action JSON Schema object');
  const validate = new Ajv({ strict: false }).compile(dispatchActionJsonSchema);

  it('leaves other actions their own scope values', () => {
    for (const action of [
      { type: 'memory.list_snapshots', scope: 'user' },
      { type: 'memory.rebuild', scope: 'workspace' },
      {
        type: 'sidebar.item_groups.list',
        scope: { appAdvisor: true },
      },
    ]) {
      expect(appAdvisorActionSchema.safeParse(action).success).toBe(true);
      expect(validate({ action })).toBe(true);
    }
  });

  it('limits pipeline.run to the global scope', () => {
    expect(
      validate({
        action: { type: 'pipeline.run', pipelineId: 'p', scope: 'global' },
      }),
    ).toBe(true);
    expect(
      validate({
        action: { type: 'pipeline.run', pipelineId: 'p', scope: 'user' },
      }),
    ).toBe(false);
  });
});

describe('appAdvisorActionSchema — local memory settings', () => {
  it('accepts the local memory toggle, folder, and import actions', () => {
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'settings.set_local_memory_enabled',
        enabled: false,
      }).success,
    ).toBe(true);
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'settings.open_memory_folder',
      }).success,
    ).toBe(true);
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'memory.import_external',
      }).success,
    ).toBe(true);
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'memory.consolidate_now',
      }).success,
    ).toBe(true);
  });

  it('accepts the memory snapshot list and restore actions', () => {
    const snapshotId = '2026-09-30T12-00-00-000Z-0123abcd';
    for (const action of [
      { type: 'memory.list_snapshots', scope: 'user' },
      {
        type: 'memory.list_snapshots',
        scope: 'workspace',
        workspaceId: 'project-1',
      },
      { type: 'memory.restore_snapshot', scope: 'user', snapshotId },
      {
        type: 'memory.restore_snapshot',
        scope: 'workspace',
        workspaceId: 'project-1',
        snapshotId,
      },
    ]) {
      expect(appAdvisorActionSchema.safeParse(action).success).toBe(true);
    }
  });

  it('rejects memory snapshot actions without a scope or snapshot id', () => {
    for (const action of [
      { type: 'memory.list_snapshots' },
      { type: 'memory.list_snapshots', scope: 'organization' },
      { type: 'memory.list_snapshots', scope: 'workspace', workspaceId: '' },
      { type: 'memory.restore_snapshot', scope: 'user' },
      { type: 'memory.restore_snapshot', scope: 'user', snapshotId: '' },
      { type: 'memory.restore_snapshot', scope: 'user', snapshotId: 42 },
      {
        type: 'memory.restore_snapshot',
        snapshotId: '2026-09-30T12-00-00-000Z-0123abcd',
      },
    ]) {
      expect(appAdvisorActionSchema.safeParse(action).success).toBe(false);
    }
  });

  it('accepts the local memory model actions', () => {
    for (const action of [
      { type: 'settings.get_local_memory_model' },
      { type: 'settings.set_local_memory_model', model: 'claude-sonnet-4-6' },
      { type: 'settings.set_local_memory_model', model: 'sonnet' },
      {
        type: 'settings.set_local_memory_model',
        model: 'gpt-5.5',
        thinkingLevel: 'xhigh',
      },
    ]) {
      expect(appAdvisorActionSchema.safeParse(action).success).toBe(true);
    }
    const types = searchAppAdvisorActions({
      query: 'memory model',
    }).actions.map((entry) => entry.type);
    expect(types).toContain('settings.get_local_memory_model');
    expect(types).toContain('settings.set_local_memory_model');
  });

  it('rejects a local memory model without a model or with an unknown thinking level', () => {
    for (const action of [
      { type: 'settings.set_local_memory_model' },
      { type: 'settings.set_local_memory_model', model: '' },
      { type: 'settings.set_local_memory_model', model: 42 },
      {
        type: 'settings.set_local_memory_model',
        model: 'claude-sonnet-4-6',
        thinkingLevel: 'extreme',
      },
      {
        type: 'settings.set_local_memory_model',
        model: 'claude-sonnet-4-6',
        thinkingLevel: 'auto',
      },
    ]) {
      expect(appAdvisorActionSchema.safeParse(action).success).toBe(false);
    }
  });

  it('rejects a local memory toggle without a boolean enabled value', () => {
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'settings.set_local_memory_enabled',
      }).success,
    ).toBe(false);
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'settings.set_local_memory_enabled',
        enabled: 'yes',
      }).success,
    ).toBe(false);
  });

  it('accepts the Agents add to the Feed toggle only with a boolean', () => {
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'settings.set_ledger_agent_recording_enabled',
        enabled: false,
      }).success,
    ).toBe(true);
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'settings.set_ledger_agent_recording_enabled',
      }).success,
    ).toBe(false);
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'settings.set_ledger_agent_recording_enabled',
        enabled: 'off',
      }).success,
    ).toBe(false);
  });
});

describe('appAdvisorActionSchema — skill suggestions (CAN-385)', () => {
  it('accepts the switch only with a boolean and the reads without fields', () => {
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'settings.set_skill_suggestions_enabled',
        enabled: true,
      }).success,
    ).toBe(true);
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'settings.set_skill_suggestions_enabled',
        enabled: 'on',
      }).success,
    ).toBe(false);
    for (const type of ['skill_suggestions.list', 'skill_suggestions.open']) {
      expect(appAdvisorActionSchema.safeParse({ type }).success).toBe(true);
    }
  });
});

describe('appAdvisorActionSchema — launch at sign-in', () => {
  it('accepts a boolean enabled value', () => {
    for (const enabled of [true, false]) {
      expect(
        appAdvisorActionSchema.safeParse({
          type: 'settings.set_launch_at_login',
          enabled,
        }).success,
      ).toBe(true);
    }
  });

  it('rejects a missing or non-boolean enabled value', () => {
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'settings.set_launch_at_login',
      }).success,
    ).toBe(false);
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'settings.set_launch_at_login',
        enabled: 'on',
      }).success,
    ).toBe(false);
  });
});

describe('appAdvisorActionSchema — file.send_selection_to_chat', () => {
  it('accepts the parameterless editor action', () => {
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'file.send_selection_to_chat',
      }).success,
    ).toBe(true);
  });
});

describe('appAdvisorActionSchema — pipeline.execution_resume', () => {
  it('rejects automation resume without an observed pause identity', () => {
    const action = {
      type: 'pipeline.execution_resume',
      executionId: 'execution-1',
    } as const;

    expect(appAdvisorActionSchema.safeParse(action).success).toBe(false);
    expect(scopedWorktreeActionSchema.safeParse(action).success).toBe(false);
  });

  it('accepts a safe execution id and UUID status-reason ids', () => {
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'pipeline.execution_resume',
        executionId: 'execution-1',
        statusReasonIds: ['123e4567-e89b-42d3-a456-426614174000'],
      }).success,
    ).toBe(true);
  });

  it('rejects traversal execution ids', () => {
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'pipeline.execution_resume',
        executionId: '../outside',
        statusReasonIds: ['123e4567-e89b-42d3-a456-426614174000'],
      }).success,
    ).toBe(false);
  });

  it.each([
    ['jobId', '../review'],
    ['jobId', 'review/job'],
    ['stepId', '../approve'],
    ['stepId', 'approve/step'],
  ])('rejects invalid persisted pause-response %s values', (field, value) => {
    const pauseResponse = {
      checkpointId: 'checkpoint-1',
      jobId: 'review',
      stepId: 'approve',
      [field]: value,
    };
    const action = {
      type: 'pipeline.execution_resume',
      executionId: 'execution-1',
      pauseResponses: [pauseResponse],
    } as const;

    expect(appAdvisorActionSchema.safeParse(action).success).toBe(false);
    expect(scopedWorktreeActionSchema.safeParse(action).success).toBe(false);
  });
});

describe('appAdvisorActionSchema — matrix execution actions', () => {
  it('accepts targeted retry and cancellation payloads', () => {
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'pipeline.execution_retry_matrix_job',
        executionId: 'execution-1',
        jobId: 'review',
        mode: 'variants',
        variantJobIds: ['__matrix__review__0'],
      }).success,
    ).toBe(true);
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'pipeline.execution_cancel_matrix_variant',
        executionId: 'execution-1',
        jobId: 'review',
        variantJobId: '__matrix__review__0',
      }).success,
    ).toBe(true);
  });
});

describe('appAdvisorActionSchema — Work Entry actions', () => {
  it('accepts the advertised rename and delete actions', () => {
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'standalone-chat.rename_work_entry',
        projectId: 'project-1',
        workEntryId: 'entry-1',
        title: 'Release research',
      }).success,
    ).toBe(true);
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'standalone-chat.delete_work_entry',
        projectId: 'project-1',
        workEntryId: 'entry-1',
      }).success,
    ).toBe(true);
  });

  it('accepts clearing a Work Entry title and rejects missing entry ids', () => {
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'standalone-chat.rename_work_entry',
        projectId: 'project-1',
        workEntryId: 'entry-1',
        title: null,
      }).success,
    ).toBe(true);
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'standalone-chat.delete_work_entry',
        projectId: 'project-1',
      }).success,
    ).toBe(false);
  });
});

describe('appAdvisorActionSchema — navigation.go_to_page page schema', () => {
  it('accepts the kanban page (unified left-sidebar rework)', () => {
    const result = appAdvisorActionSchema.safeParse({
      type: 'navigation.go_to_page',
      page: 'kanban',
    });

    expect(result.success).toBe(true);
  });

  it('accepts the pre-existing workers page (schema previously lagged NavigationPage)', () => {
    const result = appAdvisorActionSchema.safeParse({
      type: 'navigation.go_to_page',
      page: 'workers',
    });

    expect(result.success).toBe(true);
  });

  it('accepts the watchers page (Workflows → Watchers)', () => {
    const result = appAdvisorActionSchema.safeParse({
      type: 'navigation.go_to_page',
      page: 'watchers',
    });

    expect(result.success).toBe(true);
  });

  it('accepts the Workflows tab page ids as they are', () => {
    for (const page of [
      'workflows',
      'workflows-schedule',
      'workflows-library',
    ]) {
      const result = appAdvisorActionSchema.safeParse({
        type: 'navigation.go_to_page',
        page,
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ type: 'navigation.go_to_page', page });
    }
  });

  it('resolves workflows with a legacy tab to the automations page and keeps the tab', () => {
    const result = appAdvisorActionSchema.safeParse({
      type: 'navigation.go_to_page',
      page: 'workflows',
      tab: 'watchers',
    });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      type: 'navigation.go_to_page',
      page: 'automations',
      tab: 'watchers',
    });
  });

  it('still accepts the shared tab for compatibility', () => {
    const result = appAdvisorActionSchema.safeParse({
      type: 'navigation.go_to_page',
      page: 'automations',
      tab: 'shared',
    });

    expect(result.success).toBe(true);
  });

  it('still rejects an unknown page value', () => {
    const result = appAdvisorActionSchema.safeParse({
      type: 'navigation.go_to_page',
      page: 'not-a-real-page',
    });

    expect(result.success).toBe(false);
  });

  it('accepts every other documented NavigationPage value', () => {
    const pages = [
      'main',
      'overview',
      'chat',
      'pipelines',
      'automations',
      'plugins',
      'audit',
      'statistics',
      'usage',
      'environments',
    ];

    for (const page of pages) {
      const result = appAdvisorActionSchema.safeParse({
        type: 'navigation.go_to_page',
        page,
      });
      expect(result.success).toBe(true);
    }
  });
});

describe('appAdvisorActionSchema — curated pipeline preview', () => {
  it('accepts a curated catalog key and rejects a missing key', () => {
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'pipeline.open_curated_preview',
        key: 'review-code',
      }).success,
    ).toBe(true);
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'pipeline.open_curated_preview',
      }).success,
    ).toBe(false);
  });
});

describe('appAdvisorActionSchema — project readiness', () => {
  it('accepts typed readiness inspection and fix actions', () => {
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'workspace.read_readiness',
        workspaceId: 'workspace-1',
        worktreeId: 'worktree-1',
      }).success,
    ).toBe(true);
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'workspace.start_readiness_fix',
        workspaceId: 'workspace-1',
        issueCode: 'configure-hooks',
        repoId: 'api',
      }).success,
    ).toBe(true);
  });

  it('rejects unknown readiness issue codes', () => {
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'workspace.start_readiness_fix',
        workspaceId: 'workspace-1',
        issueCode: 'run-arbitrary-prompt',
      }).success,
    ).toBe(false);
  });
});

describe('appAdvisorActionSchema — ollama.install', () => {
  it('accepts the native installation action', () => {
    expect(
      appAdvisorActionSchema.safeParse({ type: 'ollama.install' }).success,
    ).toBe(true);
  });
});

describe('appAdvisorActionSchema — usage.open_resume_modal', () => {
  it('accepts native providers and rejects unsupported providers', () => {
    for (const provider of ['claude', 'codex']) {
      expect(
        appAdvisorActionSchema.safeParse({
          type: 'usage.open_resume_modal',
          provider,
        }).success,
      ).toBe(true);
    }
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'usage.open_resume_modal',
        provider: 'ollama',
      }).success,
    ).toBe(false);
  });
});

describe('appAdvisorActionSchema — resume queue', () => {
  it('accepts queue open and supported controls', () => {
    expect(
      appAdvisorActionSchema.safeParse({ type: 'usage.open_resume_queue' })
        .success,
    ).toBe(true);
    for (const action of ['pause', 'resume', 'stop', 'dismiss']) {
      expect(
        appAdvisorActionSchema.safeParse({
          type: 'usage.control_resume_queue',
          action,
        }).success,
      ).toBe(true);
    }
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'usage.control_resume_queue',
        action: 'delete',
      }).success,
    ).toBe(false);
  });
});

describe('appAdvisorActionSchema — navigation.open_code_graph', () => {
  it('requires a non-empty project id', () => {
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'navigation.open_code_graph',
        workspaceId: 'workspace-1',
      }).success,
    ).toBe(true);
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'navigation.open_code_graph',
        workspaceId: '',
      }).success,
    ).toBe(false);
  });
});

describe('appAdvisorActionSchema — navigation.open_workspace_settings', () => {
  it('accepts a project id and supported optional tab', () => {
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'navigation.open_workspace_settings',
        workspaceId: 'workspace-1',
        tab: 'environment',
      }).success,
    ).toBe(true);
  });

  it('rejects an empty project id or unsupported tab', () => {
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'navigation.open_workspace_settings',
        workspaceId: '',
      }).success,
    ).toBe(false);
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'navigation.open_workspace_settings',
        workspaceId: 'workspace-1',
        tab: 'secrets',
      }).success,
    ).toBe(false);
  });
});

describe('appAdvisorActionSchema — panel layout mode', () => {
  it('accepts only Minimal and Advanced project layout modes', () => {
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'panel.set_layout_mode',
        mode: 'minimal',
      }).success,
    ).toBe(true);
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'panel.set_layout_mode',
        mode: 'unsupported',
      }).success,
    ).toBe(false);
  });
});

describe('appAdvisorActionSchema — panel.add_tab Usage variants', () => {
  it('accepts every recognized Usage panel variant', () => {
    for (const variant of [
      'all',
      'active-chat',
      'codex',
      'claude',
      'cursor',
      'copilot',
    ]) {
      expect(
        appAdvisorActionSchema.safeParse({
          type: 'panel.add_tab',
          kind: 'usage',
          variant,
        }).success,
      ).toBe(true);
    }
  });

  it('accepts bindings for entity-bound panel kinds and empty file tabs', () => {
    for (const action of [
      { type: 'panel.add_tab', kind: 'chat', chatTabId: 'chat-1' },
      { type: 'panel.add_tab', kind: 'file-diff', fileTabId: 'file-1' },
      { type: 'panel.add_tab', kind: 'file-diff' },
      {
        type: 'panel.add_tab',
        kind: 'activity-card',
        sectionId: 'changed-files',
      },
    ]) {
      expect(appAdvisorActionSchema.safeParse(action).success).toBe(true);
    }
  });

  it('accepts Subagents as a bare kind and rejects subagent-chat', () => {
    for (const action of [
      { type: 'panel.add_tab', kind: 'subagents' },
      { type: 'panel.add_tab', kind: 'subagents', groupId: 'group-side' },
    ]) {
      expect(appAdvisorActionSchema.safeParse(action).success).toBe(true);
    }
    for (const action of [
      { type: 'panel.add_tab', kind: 'subagent-chat' },
      {
        type: 'panel.add_tab',
        kind: 'subagent-chat',
        rootChatId: 'chat-1',
        subagentId: 'agent-1',
        subagentKind: 'managed',
      },
    ]) {
      expect(appAdvisorActionSchema.safeParse(action).success).toBe(false);
    }
  });

  it('rejects entity-bound panel kinds without their bindings', () => {
    for (const action of [
      { type: 'panel.add_tab', kind: 'chat' },
      { type: 'panel.add_tab', kind: 'activity-card' },
      { type: 'panel.add_tab', kind: 'plan' },
      { type: 'panel.add_tab', kind: 'plan-diagram' },
      { type: 'panel.add_tab', kind: 'plan', planId: '' },
    ]) {
      expect(appAdvisorActionSchema.safeParse(action).success).toBe(false);
    }
  });

  it('accepts plan and plan-diagram tabs bound to a tracked plan', () => {
    for (const action of [
      { type: 'panel.add_tab', kind: 'plan', planId: 'plan-1' },
      {
        type: 'panel.add_tab',
        kind: 'plan',
        planId: 'plan-1',
        groupId: 'group-chat',
      },
      { type: 'panel.add_tab', kind: 'plan-diagram', planId: 'plan-1' },
    ]) {
      expect(appAdvisorActionSchema.safeParse(action).success).toBe(true);
    }
  });

  it('rejects an unknown Usage panel variant', () => {
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'panel.add_tab',
        kind: 'usage',
        variant: 'other',
      }).success,
    ).toBe(false);
  });

  it('accepts every recognized Automations panel variant', () => {
    for (const variant of ['full', 'upcoming', 'overview', 'completed']) {
      expect(
        appAdvisorActionSchema.safeParse({
          type: 'panel.add_tab',
          kind: 'automations',
          variant,
        }).success,
      ).toBe(true);
    }
  });

  it('rejects an unknown Automations panel variant', () => {
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'panel.add_tab',
        kind: 'automations',
        variant: 'other',
      }).success,
    ).toBe(false);
  });
});

describe('appAdvisorActionSchema — tracked-plan Plan panel', () => {
  it('keeps tracked-plan.open_explore dispatchable', () => {
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'tracked-plan.open_explore',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        planId: 'plan-1',
      }).success,
    ).toBe(true);
  });

  it('rejects the retired plan-explore-chat actions', () => {
    for (const action of [
      { type: 'plan-explore-chat.list_tabs', planId: 'plan-1' },
      { type: 'plan-explore-chat.switch_tab', planId: 'plan-1', tabId: 'c' },
      { type: 'plan-explore-chat.read_history', planId: 'plan-1' },
      {
        type: 'plan-explore-chat.send_message',
        planId: 'plan-1',
        chatId: 'c',
        text: 'hi',
      },
    ]) {
      expect(appAdvisorActionSchema.safeParse(action).success).toBe(false);
    }
  });
});

describe('appAdvisorActionSchema — navigation.open_settings', () => {
  it('accepts the Instructions settings section', () => {
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'navigation.open_settings',
        section: 'instructions',
      }).success,
    ).toBe(true);
  });

  it('accepts the advertised experiments section', () => {
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'navigation.open_settings',
        section: 'experiments',
      }).success,
    ).toBe(true);
  });

  it('accepts the Harnesses settings section', () => {
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'navigation.open_settings',
        section: 'harnesses',
      }).success,
    ).toBe(true);
  });
});

describe('appAdvisorActionSchema — navigation.open_settings section schema', () => {
  it('accepts the Plugins settings section', () => {
    const result = appAdvisorActionSchema.safeParse({
      type: 'navigation.open_settings',
      section: 'plugins',
    });
    expect(result.success).toBe(true);
  });

  it('accepts the browser settings section', () => {
    const result = appAdvisorActionSchema.safeParse({
      type: 'navigation.open_settings',
      section: 'browser',
    });

    expect(result.success).toBe(true);
  });

  it('accepts the approvals settings section', () => {
    const result = appAdvisorActionSchema.safeParse({
      type: 'navigation.open_settings',
      section: 'approvals',
    });

    expect(result.success).toBe(true);
  });

  it('accepts the Code Graph settings section', () => {
    const result = appAdvisorActionSchema.safeParse({
      type: 'navigation.open_settings',
      section: 'code-graph',
    });

    expect(result.success).toBe(true);
  });
});

describe('appAdvisorActionSchema — runs.share (CAN-395)', () => {
  it('accepts the catalog example with an organization target', () => {
    const result = appAdvisorActionSchema.safeParse({
      type: 'runs.share',
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      shareScope: 'organization',
      organizationId: 'org-1',
    });

    expect(result.success).toBe(true);
  });

  it('rejects a share with no audience', () => {
    // Every run share is a first share, so the audience is never implied.
    const result = appAdvisorActionSchema.safeParse({
      type: 'runs.share',
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
    });

    expect(result.success).toBe(false);
  });

  it('accepts a team-scoped share', () => {
    const result = appAdvisorActionSchema.safeParse({
      type: 'runs.share',
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      shareScope: 'team',
      teamId: 'team-1',
    });

    expect(result.success).toBe(true);
  });

  it('rejects a private share', () => {
    const result = appAdvisorActionSchema.safeParse({
      type: 'runs.share',
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      shareScope: 'private',
    });

    expect(result.success).toBe(false);
  });

  it('rejects a share missing the required chatId', () => {
    const result = appAdvisorActionSchema.safeParse({
      type: 'runs.share',
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
    });

    expect(result.success).toBe(false);
  });
});

describe('appAdvisorActionSchema — share audiences', () => {
  it.each([
    { type: 'skills.share_custom', name: 'review', shareScope: 'private' },
    {
      type: 'pipeline.share',
      pipelineId: 'pipeline-1',
      shareScope: 'private',
    },
    {
      type: 'plan.share',
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      planId: 'plan-1',
      shareScope: 'private',
    },
    { type: 'automation.share', id: 'automation-1', shareScope: 'private' },
  ])('rejects private for $type', (action) => {
    expect(appAdvisorActionSchema.safeParse(action).success).toBe(false);
  });

  it.each([
    { type: 'skills.share_custom', name: 'review' },
    { type: 'pipeline.share', pipelineId: 'pipeline-1' },
    {
      type: 'plan.share',
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      planId: 'plan-1',
    },
  ])('requires an audience for $type', (action) => {
    expect(appAdvisorActionSchema.safeParse(action).success).toBe(false);
  });

  it('allows an existing automation share to preserve its audience', () => {
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'automation.share',
        id: 'automation-1',
      }).success,
    ).toBe(true);
  });
});

describe('appAdvisorActionSchema — runs.unshare (CAN-395)', () => {
  it('accepts the catalog example', () => {
    const result = appAdvisorActionSchema.safeParse({
      type: 'runs.unshare',
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
    });

    expect(result.success).toBe(true);
  });

  it('rejects an unshare missing the required chatId', () => {
    const result = appAdvisorActionSchema.safeParse({
      type: 'runs.unshare',
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
    });

    expect(result.success).toBe(false);
  });
});

describe('appAdvisorActionSchema — worktree.create_from', () => {
  it('accepts branch, pr, and linear sources with an optional tracked base branch', () => {
    for (const source of ['branch', 'pr', 'linear']) {
      expect(
        appAdvisorActionSchema.safeParse({
          type: 'worktree.create_from',
          workspaceId: 'workspace-1',
          source,
          reference: 'feature/foo',
          baseBranch: 'develop',
        }).success,
      ).toBe(true);
    }
  });

  it('rejects unknown sources and missing references', () => {
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'worktree.create_from',
        workspaceId: 'workspace-1',
        source: 'jira',
        reference: 'x',
      }).success,
    ).toBe(false);
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'worktree.create_from',
        workspaceId: 'workspace-1',
        source: 'branch',
      }).success,
    ).toBe(false);
  });
});

describe('appAdvisorActionSchema — worktree.create', () => {
  it('accepts an explicit base branch', () => {
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'worktree.create',
        workspaceId: 'workspace-1',
        baseBranch: 'origin/release/next',
      }).success,
    ).toBe(true);
  });

  it('rejects conflicting base worktree and base branch inputs', () => {
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'worktree.create',
        workspaceId: 'workspace-1',
        baseWorktreeId: 'worktree-1',
        baseBranch: 'develop',
      }).success,
    ).toBe(false);
  });

  it('rejects blank explicit base branches instead of treating them as omitted', () => {
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'worktree.create',
        workspaceId: 'workspace-1',
        baseBranch: '   ',
      }).success,
    ).toBe(false);
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'worktree.create_from',
        workspaceId: 'workspace-1',
        source: 'branch',
        reference: 'feature/foo',
        baseBranch: '',
      }).success,
    ).toBe(false);
  });

  it.each(['--force', '-b', 'HEAD'])(
    'rejects option-like and reserved explicit base branch %s',
    (baseBranch) => {
      expect(
        appAdvisorActionSchema.safeParse({
          type: 'worktree.create',
          workspaceId: 'workspace-1',
          baseBranch,
        }).success,
      ).toBe(false);
      expect(
        appAdvisorActionSchema.safeParse({
          type: 'worktree.create_from',
          workspaceId: 'workspace-1',
          source: 'branch',
          reference: 'feature/foo',
          baseBranch,
        }).success,
      ).toBe(false);
    },
  );
});

describe('appAdvisorActionSchema — worktree.set_base_branch', () => {
  it('accepts a scoped base-branch change', () => {
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'worktree.set_base_branch',
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        repoId: 'repo-a',
        baseBranch: 'release/next',
      }).success,
    ).toBe(true);
  });

  it('rejects a missing base branch', () => {
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'worktree.set_base_branch',
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
      }).success,
    ).toBe(false);
  });
});

describe('dispatchActionSchema — worktree.split_temporary_workspace', () => {
  it('does not expose model-supplied destructive approval fields', () => {
    const result = dispatchActionSchema.safeParse({
      action: {
        type: 'worktree.split_temporary_workspace',
        workspaceId: 'workspace-1',
        worktreeId: 'worktree-1',
        selections: { 'repo-1': 'remove' },
        rootAction: 'archive',
        confirmedRepositoryDeleteRepoIds: ['repo-1'],
        confirmRootDelete: true,
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.action).not.toHaveProperty(
        'confirmedRepositoryDeleteRepoIds',
      );
      expect(result.data.action).not.toHaveProperty('confirmRootDelete');
    }
  });
});

describe('appAdvisorActionSchema — worktree.resolve_branch_from_confirmation', () => {
  it.each(['commit-first', 'do-not-commit', 'cancel'])(
    'accepts the %s choice',
    (choice) => {
      expect(
        appAdvisorActionSchema.safeParse({
          type: 'worktree.resolve_branch_from_confirmation',
          confirmationId: 'confirmation-1',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          choice,
        }).success,
      ).toBe(true);
    },
  );

  it('rejects missing confirmation identity and unknown choices', () => {
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'worktree.resolve_branch_from_confirmation',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        choice: 'cancel',
      }).success,
    ).toBe(false);
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'worktree.resolve_branch_from_confirmation',
        confirmationId: 'confirmation-1',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        choice: 'retry',
      }).success,
    ).toBe(false);
  });
});

describe('appAdvisorActionSchema — github.resolve_base_branch_alignment', () => {
  it.each(['confirm', 'cancel'])('accepts the %s choice', (choice) => {
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'github.resolve_base_branch_alignment',
        confirmationId: 'confirmation-1',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        choice,
      }).success,
    ).toBe(true);
  });

  it('rejects missing confirmation identity and unknown choices', () => {
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'github.resolve_base_branch_alignment',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        choice: 'confirm',
      }).success,
    ).toBe(false);
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'github.resolve_base_branch_alignment',
        confirmationId: 'confirmation-1',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        choice: 'retry',
      }).success,
    ).toBe(false);
  });
});

it('accepts account MCP navigation and validates primary actions', (): void => {
  expect(
    appAdvisorActionSchema.safeParse({
      type: 'navigation.go_to_page',
      page: 'mcp-account-connections',
    }).success,
  ).toBe(true);
  for (const operation of ['connect', 'reconnect', 'disconnect', 'promote']) {
    expect(
      appAdvisorActionSchema.safeParse({
        type: `mcp.account_${operation}`,
        serverId: 'github',
      }).success,
    ).toBe(true);
    expect(
      appAdvisorActionSchema.safeParse({ type: `mcp.account_${operation}` })
        .success,
    ).toBe(false);
  }
});

it('validates Personal catalog enrollment actions', (): void => {
  expect(
    appAdvisorActionSchema.safeParse({
      type: 'settings.personalCatalog.set',
      enabled: true,
    }).success,
  ).toBe(true);
  expect(
    appAdvisorActionSchema.safeParse({
      type: 'settings.personalCatalog.set',
      enabled: 'yes',
    }).success,
  ).toBe(false);
});

describe('phase07 transfer installed routes', () => {
  it.each([
    {
      type: 'browser.list_transfers',
      expectedRuntimeGeneration: 9,
      kind: 'download',
      status: 'paused',
      offset: 2,
      limit: 50,
    },
    {
      type: 'browser.cancel_transfer',
      expectedRuntimeGeneration: 9,
      transferId: 'download-1',
    },
  ])('discovers and preserves $type on both routes', (action) => {
    expect(appAdvisorActionSchema.parse(action)).toEqual(action);
    expect(browserActionInputSchema.parse(action)).toEqual(action);
    const entry = APP_ADVISOR_ACTION_CATALOG.find(
      (entry) => entry.type === action.type,
    );
    expect(entry).toBeDefined();
    expect(entry?.fields.map((field) => field.name)).toContain(
      'expectedRuntimeGeneration',
    );
    expect(appAdvisorActionSchema.safeParse(entry?.example).success).toBe(true);
  });
});

describe('appAdvisorActionSchema — daily free AI Credits', () => {
  it('accepts the daily credit drip toggle with a boolean', () => {
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'settings.set_daily_credit_drip',
        enabled: true,
      }).success,
    ).toBe(true);
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'settings.set_daily_credit_drip',
        enabled: false,
      }).success,
    ).toBe(true);
  });

  it('rejects a daily credit drip toggle without a boolean enabled value', () => {
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'settings.set_daily_credit_drip',
      }).success,
    ).toBe(false);
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'settings.set_daily_credit_drip',
        enabled: 'yes',
      }).success,
    ).toBe(false);
  });
});

describe('App Advisor Code Graph actions', () => {
  const examples = [
    { type: 'code-graph.get_context' },
    { type: 'code-graph.build' },
    { type: 'code-graph.query', mode: 'callers', target: 'src/a.ts::run' },
    { type: 'code-graph.search', query: 'run' },
    { type: 'code-graph.explain', qualifiedName: 'src/a.ts::run' },
    { type: 'code-graph.impact', target: 'src/a.ts::run' },
    { type: 'code-graph.detect_changes', baseRef: 'HEAD' },
    { type: 'code-graph.compare_changes', baseRef: 'main' },
    { type: 'code-graph.review', baseRef: 'main' },
  ];
  it.each(examples)(
    'discovers and validates $type for an explicit worktree',
    (example) => {
      const action = {
        ...example,
        projectId: 'project-2',
        worktreeId: 'worktree-2',
      };
      expect(appAdvisorActionSchema.safeParse(action).success).toBe(true);
      expect(
        APP_ADVISOR_ACTION_CATALOG.some((entry) => entry.type === example.type),
      ).toBe(true);
    },
  );
  it.each([
    { type: 'code-graph.query', mode: 'unknown' },
    { type: 'code-graph.impact', target: 'x', maxDepth: 50 },
    { type: 'code-graph.search', query: '' },
    { type: 'code-graph.search', query: 'x', limit: 1000 },
  ])('rejects invalid graph arguments $type', (example) => {
    expect(
      appAdvisorActionSchema.safeParse({
        ...example,
        projectId: 'project',
        worktreeId: 'worktree',
      }).success,
    ).toBe(false);
  });
  it.each([
    { projectId: 'app-advisor', worktreeId: 'entry' },
    { projectId: '../project', worktreeId: 'main' },
    { projectId: 'project', worktreeId: '../main' },
    { projectId: 'project' },
    {},
  ])('requires a safe, explicit worktree target %j', (target) => {
    expect(
      appAdvisorActionSchema.safeParse({
        type: 'code-graph.get_context',
        ...target,
      }).success,
    ).toBe(false);
  });
});

it('hides Code Graph actions from discovery when its feature gate is off', () => {
  const enabled = searchAppAdvisorActions({
    category: 'code-graph',
    limit: 50,
    featureFlags: { 'canopy-desktop-workspace-code-graph': true },
  });
  expect(enabled.actions).toHaveLength(9);
  expect(
    searchAppAdvisorActions({
      category: 'code-graph',
      limit: 50,
      featureFlags: { 'canopy-desktop-workspace-code-graph': false },
    }).actions,
  ).toEqual([]);
});

describe('navigation page validity', () => {
  it.each(Object.values(NAVIGATION_PAGE_MAP))(
    'keeps %s valid independently of availability',
    (page) => {
      expect(
        appAdvisorActionSchema.safeParse({
          type: 'navigation.go_to_page',
          page,
        }).success,
      ).toBe(true);
    },
  );
});

describe('App Advisor shared transcript-read composition', () => {
  const target = {
    kind: 'delegation',
    chatId: 'owner',
    delegationId: 'child',
    runGeneration: 1,
  };
  const actions = [
    { type: 'chat.transcript.page', target },
    {
      type: 'chat.content.read',
      target,
      messageId: 'row',
      blockOrdinal: 0,
      field: 'text',
      offset: 0,
    },
    { type: 'chat.transcript.blocks.page', target, messageId: 'row' },
  ];
  if (
    !dispatchActionJsonSchema ||
    typeof dispatchActionJsonSchema !== 'object' ||
    Array.isArray(dispatchActionJsonSchema) ||
    !searchActionsJsonSchema ||
    typeof searchActionsJsonSchema !== 'object' ||
    Array.isArray(searchActionsJsonSchema)
  ) {
    throw new Error('Provider schemas must be objects');
  }
  const validateDispatch = new Ajv({ strict: false }).compile(
    dispatchActionJsonSchema,
  );
  const validateSearch = new Ajv({ strict: false }).compile(
    searchActionsJsonSchema,
  );
  it.each(actions)(
    'composes shared parser and both provider schemas for $type',
    (action) => {
      expect(dispatchActionSchema.safeParse({ action }).success).toBe(true);
      expect(dispatchActionToolSchema.safeParse({ action }).success).toBe(true);
      expect(validateDispatch({ action })).toBe(true);
      expect(
        searchActionsSchema.safeParse({ actionType: action.type }).success,
      ).toBe(true);
      expect(validateSearch({ actionType: action.type })).toBe(true);
      expect(
        APP_ADVISOR_ACTION_CATALOG.some((entry) => entry.type === action.type),
      ).toBe(false);
    },
  );
  it.each(actions)(
    'keeps $type strict and rejects model-owned scope in Zod and JSON',
    (action) => {
      for (const invalid of [
        { ...action, mystery: true },
        { ...action, scope: { workspaceId: 'foreign' } },
        { ...action, projectId: 'foreign', worktreeId: 'foreign' },
        { ...action, target: { ...target, workspaceId: 'foreign' } },
        { ...action, target: { ...target, runGeneration: 0 } },
      ]) {
        expect(
          dispatchActionSchema.safeParse({ action: invalid }).success,
        ).toBe(false);
        expect(validateDispatch({ action: invalid })).toBe(false);
        // Provider registration remains passthrough; the executor owns validation.
        expect(
          dispatchActionToolSchema.safeParse({ action: invalid }).success,
        ).toBe(true);
      }
    },
  );
  it('does not impose transcript target fields on existing file-tree actions', () => {
    const action = {
      type: 'file-tree.create_file',
      projectId: 'workspace',
      worktreeId: 'tree',
      target: { repoId: 'repo', relativePath: 'new-file.ts' },
    };
    expect(dispatchActionToolSchema.safeParse({ action }).success).toBe(true);
    expect(validateDispatch({ action })).toBe(true);
  });
  it('preserves shared block cursor and ordinal exclusivity in both schemas', () => {
    const action = {
      type: 'chat.transcript.blocks.page',
      target,
      messageId: 'row',
      cursor: 'cursor',
      firstBlockOrdinal: 0,
    };
    expect(dispatchActionSchema.safeParse({ action }).success).toBe(false);
    expect(validateDispatch({ action })).toBe(false);
  });
});
it.each([
  { type: 'projects.list' },
  { type: 'projects.list_tasks', projectId: 'target' },
  { type: 'projects.list_task_chats', projectId: 'target', taskId: 'task' },
])(
  'accepts $type through Advisor DispatchAction without UI revision',
  (action) => {
    expect(dispatchActionSchema.parse({ action }).action).toMatchObject(action);
    for (const extra of [
      { projectId: '' },
      { pageSize: 201 },
      { cursor: '' },
      { ui: {} },
    ]) {
      expect(
        dispatchActionSchema.safeParse({ action: { ...action, ...extra } })
          .success,
      ).toBe(false);
    }
  },
);

describe('phase 12 advertised schemas and compatibility acceptance', () => {
  const legacyTriggers = [
    'worktree_chat_completion',
    'standalone_chat_completion',
    'worktree_new_chat_started',
    'standalone_new_chat_started',
  ];

  it('advertises only visible SearchActions types while retaining legacy runtime search', () => {
    const validateJson = compileJsonSchema(searchActionsJsonSchema);
    const provider = z.object(searchActionsToolShape);
    for (const entry of APP_ADVISOR_ACTION_CATALOG) {
      expect(
        searchActionsSchema.safeParse({ actionType: entry.type }).success,
      ).toBe(true);
      expect(provider.safeParse({ actionType: entry.type }).success).toBe(
        !entry.hidden,
      );
      expect(validateJson({ actionType: entry.type })).toBe(!entry.hidden);
    }
  });

  it('does not advertise replaced actions in provider schemas or Advisor prompting', () => {
    const advertised = JSON.stringify([
      searchActionsJsonSchema,
      dispatchActionJsonSchema,
      z.toJSONSchema(z.object(searchActionsToolShape)),
      APP_ADVISOR_SYSTEM_PROMPT,
    ]);
    const hidden = APP_ADVISOR_ACTION_CATALOG.filter((entry) => entry.hidden);
    expect(hidden).toHaveLength(20);
    for (const entry of hidden) {
      expect(advertised).not.toMatch(
        new RegExp(entry.type.replaceAll('.', '\\.') + '(?![\\w.])'),
      );
    }
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain('standalone-chat.switch_chat');
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain('workspace.list_join_options');
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain(
      'pipeline-assistant-chat.read_history',
    );
  });

  it('advertises canonical watcher triggers without legacy trigger tutorials on either provider', () => {
    const advertised = JSON.stringify([
      searchWatchersJsonSchema,
      advisorSetupWatchersJsonSchema,
      rootSearchWatchersJsonSchema,
      rootSetupWatchersJsonSchema,
      z.toJSONSchema(z.object(searchWatchersToolShape)),
      SETUP_WATCHERS_DESCRIPTION,
      SEARCH_WATCHERS_DESCRIPTION,
      ROOT_SETUP_WATCHERS_DESCRIPTION,
      ROOT_SEARCH_WATCHERS_DESCRIPTION,
      APP_ADVISOR_SYSTEM_PROMPT,
    ]);
    for (const trigger of legacyTriggers)
      expect(advertised).not.toContain(trigger);
    for (const trigger of [
      'project_task_chat_completion',
      'project_new_chat_started',
      'bot_task_chat_completion',
      'bot_new_chat_started',
      'worktree_pipeline_completion',
      'worktree_hook_triggered',
      'automation_run',
    ])
      expect(advertised).toContain(trigger);
  });

  it.each(legacyTriggers)(
    'still accepts %s in legacy-only and mixed watcher JSON',
    (trigger) => {
      const target =
        trigger === 'worktree_chat_completion'
          ? { projectId: 'p', worktreeId: 't', chatId: 'c' }
          : trigger === 'standalone_chat_completion'
            ? { projectId: 'p', chatId: 'c' }
            : trigger === 'worktree_new_chat_started'
              ? { projectId: 'p', worktreeId: 't' }
              : { projectId: 'p' };
      const kind =
        trigger === 'worktree_chat_completion'
          ? 'worktree_chat'
          : trigger === 'standalone_chat_completion'
            ? 'standalone_chat'
            : trigger === 'worktree_new_chat_started'
              ? 'worktree_chat_scope'
              : 'standalone_chat_project';
      const canonical = {
        trigger: 'project_task_chat_completion',
        target: { projectId: 'p', taskId: 't', chatId: 'c' },
      };
      for (const [runtime, json, legacy] of [
        [
          rootSetupWatchersSchema,
          rootSetupWatchersJsonSchema,
          { trigger, target },
        ],
        [
          advisorSetupWatchersSchema,
          advisorSetupWatchersJsonSchema,
          { trigger, target: { ...target, kind } },
        ],
      ] as const) {
        const validate = compileJsonSchema(json);
        for (const watchers of [[legacy], [legacy, canonical]]) {
          expect(runtime.safeParse({ watchers }).success).toBe(true);
          expect(validate({ watchers })).toBe(true);
        }
      }
      for (const runtime of [rootSearchWatchersSchema, searchWatchersSchema]) {
        expect(runtime.safeParse({ trigger }).success).toBe(true);
      }
      for (const json of [
        rootSearchWatchersJsonSchema,
        searchWatchersJsonSchema,
      ]) {
        expect(compileJsonSchema(json)({ trigger })).toBe(true);
      }
    },
  );
});
