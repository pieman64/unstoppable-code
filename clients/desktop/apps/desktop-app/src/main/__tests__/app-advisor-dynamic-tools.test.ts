const mockMcpTools = new Map<
  string,
  { schema: object; handler: (args: unknown) => Promise<unknown> }
>();
const mockGetGitHubPullRequestStatus = jest.fn();
jest.mock('../lib/github-pr-read-model', () => ({
  getGitHubPullRequestStatus: (...args: unknown[]): unknown =>
    mockGetGitHubPullRequestStatus(...args),
}));

import {
  APP_ADVISOR_TOOL_ENTRIES,
  APP_ADVISOR_TOOL_REGISTRY,
  getAppAdvisorProviderToolName,
  isAppAdvisorLedgerToolKey,
} from '@canopy/desktop-shared/lib/app-advisor-tools';
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
} from '@canopy/desktop-shared/types';
import {
  buildAppAdvisorDynamicToolSpecs,
  handleAppAdvisorDynamicToolCall,
} from '../app-advisor/codex-dynamic-tools';
import {
  dispatchActionJsonSchema,
  dispatchActionSchema,
  searchActionsToolShape,
  searchActionsJsonSchema,
  searchWatchersToolShape,
  setupWatchersToolShape,
  searchWatchersJsonSchema,
  dispatchActionToolSchema,
  watchGitHubItemsJsonSchema,
  watchGitHubItemsSchema,
} from '../app-advisor/definitions';
import { z } from 'zod/v4';
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { createAppAdvisorMcpServer } from '../app-advisor/mcp-server';
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: jest.fn(
    (
      name: string,
      description: string,
      inputSchema: z.ZodRawShape,
      handler: (args: unknown) => Promise<unknown>,
    ) => {
      mockMcpTools.set(name, { schema: inputSchema, handler });
      return { name, description, inputSchema, handler };
    },
  ),
  createSdkMcpServer: jest.fn((options: unknown): unknown => options),
}));
import Ajv, { type AnySchema } from 'ajv';
import {
  watchGitHubItemsJsonSchema as worktreeWatchGitHubItemsJsonSchema,
  watchGitHubItemsSchema as worktreeWatchGitHubItemsSchema,
} from '../canopy-tools/definitions';
import { executeAppAdvisorTool } from '../app-advisor/tool-executor';
import { APP_ADVISOR_ACTION_CATALOG } from '@canopy/desktop-shared/lib/app-advisor-actions';
import type { AppAdvisorToolRuntime } from '../app-advisor/runtime';
import {
  CLIENT_FEATURE_FLAGS,
  getDefaultFeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import { getFeatureFlagService } from '../feature-flags';
import { readWatcherOutputPreview } from '../app-advisor/local-watcher-output';

function compileJsonSchema(schema: unknown): ReturnType<Ajv['compile']> {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new Error('Expected a JSON Schema object.');
  }

  // Generated schemas are object-shaped JSON values, while Ajv accepts AnySchema.
  return new Ajv({ strict: false }).compile(schema as AnySchema);
}

jest.mock('../app-advisor/local-watcher-output', () => ({
  readWatcherOutputPreview: jest.fn(),
}));

function createRuntime(
  overrides: Partial<AppAdvisorToolRuntime> = {},
): AppAdvisorToolRuntime {
  return {
    watcherDestination: {
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: APP_ADVISOR_WORKTREE_ID,
      chatId: 'advisor-chat',
    },
    requestUserAnswers: jest.fn(),
    loadScriptOutput: jest.fn(),
    loadPipelineYaml: jest.fn(),
    showFiles: jest.fn(),
    getScopedFileComments: jest.fn(),
    respondToScopedFileComment: jest.fn(),
    searchWatchers: jest.fn().mockResolvedValue({
      catalog: [],
      activeWatchers: [],
    }),
    setupWatchers: jest.fn().mockResolvedValue({ ok: true, results: [] }),
    setupCanonicalChatWatchers: jest
      .fn()
      .mockResolvedValue({ ok: true, results: [] }),
    watchGitHubItems: jest.fn().mockResolvedValue({
      ok: true,
      status: 'created',
      watcherId: 'watcher-github',
      itemCount: 1,
    }),
    watchCommand: jest.fn().mockResolvedValue({ id: 'watcher-command' }),
    requestUiState: jest.fn().mockResolvedValue({
      version: 1,
      revision: 1,
      capturedAt: '2026-05-19T00:00:00.000Z',
      digest: 'digest',
      snapshot: {
        activePage: 'main',
        overlays: {
          commandPaletteOpen: false,
          fileSearchPaletteOpen: false,
          prPickerOpen: false,
          canopyPortalOpen: false,
          appAdvisorOpen: true,
        },
      },
    }),
    dispatchRendererAction: jest.fn(),
    getPipelineDebugContext: jest.fn(),
    ...overrides,
  };
}

describe('App Advisor Codex dynamic tools', () => {
  it('registers the exported provider-facing MCP shapes, not runtime enums', () => {
    jest.mocked(tool).mockClear();
    createAppAdvisorMcpServer(createRuntime());
    expect(createSdkMcpServer).toHaveBeenCalled();
    for (const [key, shape] of [
      ['search_actions', searchActionsToolShape],
      ['dispatch_action', dispatchActionToolSchema.shape],
      ['search_watchers', searchWatchersToolShape],
      ['setup_watchers', setupWatchersToolShape],
    ] as const) {
      expect(
        jest
          .mocked(tool)
          .mock.calls.find(
            ([name]) => name === APP_ADVISOR_TOOL_REGISTRY[key].displayName,
          )?.[2],
      ).toBe(shape);
    }
  });

  it('advertises canonical Codex search and open dispatch schemas', () => {
    const specs = buildAppAdvisorDynamicToolSpecs();
    const searchActionsTool = specs.find(
      (spec) =>
        spec.name === getAppAdvisorProviderToolName('search_actions', 'codex'),
    );
    const dispatchActionTool = specs.find(
      (spec) =>
        spec.name === getAppAdvisorProviderToolName('dispatch_action', 'codex'),
    );
    expect(
      searchActionsTool?.type === 'namespace'
        ? undefined
        : searchActionsTool?.inputSchema,
    ).toEqual(searchActionsJsonSchema);
    expect(
      dispatchActionTool?.type === 'namespace'
        ? undefined
        : dispatchActionTool?.inputSchema,
    ).toEqual(dispatchActionJsonSchema);
    const schema = z.toJSONSchema(dispatchActionToolSchema);
    expect(schema.properties?.action).toMatchObject({
      properties: { type: { type: 'string' } },
    });
    expect(JSON.stringify(schema)).not.toContain('worktree-chat.send_message');
    expect(dispatchActionJsonSchema).toMatchObject({
      properties: { action: { properties: { type: { type: 'string' } } } },
    });
    const validateJson = compileJsonSchema(dispatchActionJsonSchema);
    expect(
      validateJson({
        action: { type: 'future.action', arbitrary: { nested: true } },
      }),
    ).toBe(true);
  });

  it('preserves and dispatches all 20 compatibility action examples through the MCP shape', async () => {
    const dispatchRendererAction = jest
      .fn()
      .mockResolvedValue({ ok: true, result: { unchanged: true } });
    const runtime = createRuntime({ dispatchRendererAction });
    const entries = APP_ADVISOR_ACTION_CATALOG.filter((entry) => entry.hidden);
    expect(entries).toHaveLength(20);
    const validateJson = compileJsonSchema(dispatchActionJsonSchema);
    for (const entry of entries) {
      const input = { action: entry.example };
      expect(validateJson(input)).toBe(true);
      const registered = dispatchActionToolSchema.parse(input);
      expect(registered).toEqual(input);
      const result = await executeAppAdvisorTool(
        'dispatch_action',
        registered,
        runtime,
      );
      expect(result.isError).toBe(false);
      expect(dispatchRendererAction).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: entry.type }),
        undefined,
        undefined,
      );
      expect(JSON.parse(result.text)).toEqual({
        ok: true,
        result: { unchanged: true },
      });
    }
    expect(dispatchRendererAction).toHaveBeenCalledTimes(20);
  });

  it('preserves legacy existing-tab navigation through the provider and executor', async () => {
    const action = {
      type: 'worktree-chat.open_tab',
      projectId: 'p',
      worktreeId: 't',
      chatId: 'existing-chat',
    };
    const response = {
      ok: true,
      result: { chatId: 'existing-chat', selected: true },
    };
    const dispatchRendererAction = jest.fn().mockResolvedValue(response);
    const result = await executeAppAdvisorTool(
      'dispatch_action',
      dispatchActionToolSchema.parse({ action }),
      createRuntime({ dispatchRendererAction }),
    );
    expect(result.isError).toBe(false);
    expect(dispatchRendererAction).toHaveBeenCalledWith(
      action,
      undefined,
      undefined,
    );
    expect(JSON.parse(result.text)).toEqual(response);
  });

  it('preserves malformed canonical dispatch payloads for strict executor rejection', async () => {
    const input = {
      action: {
        type: 'projects.send_message',
        projectId: 'p',
        taskId: 't',
        chatId: 'c',
        text: 'hi',
        sender: 'spoof',
      },
    };
    const registered = dispatchActionToolSchema.parse(input);
    expect(registered).toEqual(input);
    const dispatchRendererAction = jest.fn();
    const runtime = createRuntime({ dispatchRendererAction });
    const result = await executeAppAdvisorTool(
      'dispatch_action',
      registered,
      runtime,
    );
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Invalid arguments for DispatchAction');
    expect(dispatchRendererAction).not.toHaveBeenCalled();
  });

  it('keeps canonical raw entries intact through the MCP registration shape and executor', async () => {
    const registration = z.object(setupWatchersToolShape);
    const setupWatchers = jest
      .fn()
      .mockResolvedValue({ ok: true, results: [] });
    const runtime = createRuntime({ setupWatchers });
    const canonical = {
      trigger: 'project_task_chat_completion',
      target: { projectId: 'p', taskId: 't', chatId: 'c' },
    };
    for (const entry of [
      { ...canonical, kind: 'project_task_chat' },
      {
        ...canonical,
        target: { ...canonical.target, kind: 'project_task_chat' },
      },
      { ...canonical, destinationChatId: 'bad' },
      { ...canonical, target: { ...canonical.target, sessionId: 'bad' } },
    ]) {
      const input = { watchers: [entry] };
      const registered = registration.parse(input);
      expect(registered).toEqual(input);
      const result = await executeAppAdvisorTool(
        'setup_watchers',
        registered,
        runtime,
      );
      expect(result.text).toContain('Invalid arguments for SetupWatchers');
      expect(result.isError).toBe(true);
    }
    expect(setupWatchers).not.toHaveBeenCalled();
    const result = await executeAppAdvisorTool(
      'setup_watchers',
      registration.parse({
        watchers: [
          {
            trigger: 'standalone_chat_completion',
            target: { kind: 'standalone_chat', projectId: 'p', chatId: 'c' },
          },
        ],
      }),
      runtime,
    );
    expect(result.isError).toBe(false);
    expect(setupWatchers).toHaveBeenCalledTimes(1);
  });
  it('routes all four canonical triggers atomically without changing entries', async () => {
    const setupWatchers = jest.fn();
    const response = { ok: true, results: [] };
    const setupCanonicalChatWatchers = jest.fn().mockResolvedValue(response);
    const runtime = createRuntime({
      setupWatchers,
      setupCanonicalChatWatchers,
    });
    const entries = [
      {
        trigger: 'project_task_chat_completion',
        target: { projectId: ' p ', taskId: ' t ', chatId: ' c ' },
        label: ' Canonical label ',
        armForNextCompletion: true,
      },
      { trigger: 'project_new_chat_started', target: { projectId: 'p' } },
      {
        trigger: 'bot_task_chat_completion',
        target: { botId: 'app_advisor', taskId: 't', chatId: 'c' },
      },
      {
        trigger: 'bot_new_chat_started',
        target: { botId: 'app_advisor', taskId: 't' },
      },
    ];
    const result = await executeAppAdvisorTool(
      'setup_watchers',
      { watchers: entries },
      runtime,
    );
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toEqual(response);
    expect(setupCanonicalChatWatchers).toHaveBeenCalledTimes(1);
    expect(setupCanonicalChatWatchers).toHaveBeenCalledWith(
      { watchers: entries },
      { toolUseId: undefined },
    );
    expect(setupWatchers).not.toHaveBeenCalled();
  });

  it('projects mixed setup results without expanding redacted rows or leaking legacy destinations', async () => {
    const redacted = {
      id: 'denied',
      trigger: 'project_task_chat_completion',
      availability: 'owner_boundary',
    };
    const setupCanonicalChatWatchers = jest.fn().mockResolvedValue({
      ok: true,
      results: [
        { status: 'deduped', watcher: redacted },
        {
          status: 'created',
          watcher: {
            id: 'pipeline',
            trigger: 'worktree_pipeline_completion',
            status: 'active',
            label: 'Pipeline',
            target: {
              kind: 'worktree_pipeline',
              projectId: 'p',
              worktreeId: 't',
            },
            destination: {
              projectId: 'PRIVATE recipient project',
              worktreeId: 'private',
              chatId: 'private',
            },
          },
        },
      ],
    });
    const result = await executeAppAdvisorTool(
      'setup_watchers',
      {
        watchers: [
          { trigger: 'project_new_chat_started', target: { projectId: 'p' } },
          {
            trigger: 'worktree_pipeline_completion',
            target: {
              kind: 'worktree_pipeline',
              projectId: 'p',
              worktreeId: 't',
            },
          },
        ],
      },
      createRuntime({ setupCanonicalChatWatchers }),
    );
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toEqual({
      ok: true,
      results: [
        { status: 'deduped', watcher: redacted },
        {
          status: 'created',
          watcher: {
            id: 'pipeline',
            trigger: 'worktree_pipeline_completion',
            status: 'active',
            label: 'Pipeline',
            targetKind: 'worktree_pipeline',
          },
        },
      ],
    });
    expect(result.text).not.toContain('PRIVATE');
  });

  it('preserves typed canonical failures without a legacy fallback', async () => {
    const response = {
      ok: false,
      code: 'not_found',
      error: 'Unavailable target.',
      rejectedIndex: 0,
    };
    const setupWatchers = jest.fn();
    const runtime = createRuntime({
      setupWatchers,
      setupCanonicalChatWatchers: jest.fn().mockResolvedValue(response),
    });
    const result = await executeAppAdvisorTool(
      'setup_watchers',
      {
        watchers: [
          { trigger: 'project_new_chat_started', target: { projectId: 'p' } },
        ],
      },
      runtime,
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.text)).toEqual(response);
    expect(setupWatchers).not.toHaveBeenCalled();
  });

  it('fails closed if the canonical runtime is missing', async () => {
    const setupWatchers = jest.fn();
    const result = await executeAppAdvisorTool(
      'setup_watchers',
      {
        watchers: [
          { trigger: 'project_new_chat_started', target: { projectId: 'p' } },
        ],
      },
      createRuntime({ setupWatchers, setupCanonicalChatWatchers: undefined }),
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.text)).toMatchObject({
      ok: false,
      code: 'runtime_unavailable',
    });
    expect(setupWatchers).not.toHaveBeenCalled();
  });
  it('never normalizes canonical aliases, extra fields, or malformed mixed batches into valid input', async () => {
    const setupWatchers = jest
      .fn()
      .mockResolvedValue({ ok: true, results: [] });
    const setupCanonicalChatWatchers = jest
      .fn()
      .mockResolvedValue({ ok: true, results: [] });
    const runtime = createRuntime({
      setupWatchers,
      setupCanonicalChatWatchers,
    });
    const entry = {
      trigger: 'project_task_chat_completion',
      target: { projectId: 'p', taskId: 't', chatId: 'c' },
    };
    const legacyAlias = {
      trigger: 'worktree_chat_completion',
      targetKind: 'worktree_chat',
      projectId: 'p',
      worktreeId: 't',
      target: { id: 'legacy-chat', title: 'ignored legacy title' },
    };
    const invalid: unknown[] = [
      entry,
      [entry],
      JSON.stringify({ watchers: [entry] }),
      { watchers: JSON.stringify([entry]) },
      { watchers: [JSON.stringify(entry)] },
      { watchers: [entry], destinationChatId: 'bad' },
      { watchers: [{ ...entry, targetKind: 'worktree_chat' }] },
      { watchers: [{ ...entry, target: JSON.stringify(entry.target) }] },
    ];
    for (const key of [
      'kind',
      'owner',
      'destinationChatId',
      'sessionId',
      'display',
      'ui',
      'unknown',
    ]) {
      invalid.push({ watchers: [{ ...entry, [key]: 'bad' }, legacyAlias] });
      invalid.push({
        watchers: [
          { ...entry, target: { ...entry.target, [key]: 'bad' } },
          legacyAlias,
        ],
      });
    }
    for (const input of invalid) {
      const result = await executeAppAdvisorTool(
        'setup_watchers',
        input,
        runtime,
      );
      expect(result.isError).toBe(true);
      expect(result.text).toContain('Invalid arguments for SetupWatchers');
    }
    expect(setupCanonicalChatWatchers).not.toHaveBeenCalled();
    const mixed = await executeAppAdvisorTool(
      'setup_watchers',
      { watchers: [entry, legacyAlias] },
      runtime,
    );
    expect(mixed.isError).toBe(false);
    expect(setupCanonicalChatWatchers).toHaveBeenCalledTimes(1);
    expect(setupCanonicalChatWatchers).toHaveBeenCalledWith(
      {
        watchers: [
          entry,
          {
            trigger: 'worktree_chat_completion',
            target: {
              kind: 'worktree_chat',
              projectId: 'p',
              worktreeId: 't',
              chatId: 'legacy-chat',
            },
          },
        ],
      },
      { toolUseId: undefined },
    );
    expect(setupWatchers).not.toHaveBeenCalled();
    const legacy = await executeAppAdvisorTool(
      'setup_watchers',
      legacyAlias,
      runtime,
    );
    expect(legacy.isError).toBe(false);
    expect(setupWatchers).toHaveBeenCalledWith(
      {
        watchers: [
          {
            trigger: 'worktree_chat_completion',
            target: {
              kind: 'worktree_chat',
              projectId: 'p',
              worktreeId: 't',
              chatId: 'legacy-chat',
            },
          },
        ],
      },
      { toolUseId: undefined },
    );
  });
  it('registers the provider-specific App Advisor tool names', () => {
    const names = buildAppAdvisorDynamicToolSpecs().map((tool) => tool.name);
    expect(names).toEqual(
      APP_ADVISOR_TOOL_ENTRIES.filter(
        (entry) => !isAppAdvisorLedgerToolKey(entry.canonicalKey),
      ).map((entry) => entry.codexToolName),
    );
    expect(names).toContain('canopy_app_advisor_watch_command');
    expect(names).not.toContain('canopy_app_advisor_add_feed_entry');
    expect(names).toContain('canopy_app_advisor_start_forked_agent');
    expect(names).not.toContain('canopy_app_advisor_start_branched_agent');
  });

  it('registers every App Advisor tool name for a session whose Ledger tools are exposed', () => {
    const names = buildAppAdvisorDynamicToolSpecs({ includeLedger: true }).map(
      (tool) => tool.name,
    );
    expect(names).toEqual(
      APP_ADVISOR_TOOL_ENTRIES.map((entry) => entry.codexToolName),
    );
    expect(names).toEqual(
      expect.arrayContaining([
        'canopy_app_advisor_add_feed_entry',
        'canopy_app_advisor_search_feed_entries',
        'canopy_app_advisor_update_feed_entry',
      ]),
    );
  });

  it('advertises the current-chat auto-archive tool with the shared schema', () => {
    const spec = buildAppAdvisorDynamicToolSpecs().find(
      (tool) => tool.name === 'canopy_app_advisor_set_auto_archive',
    );
    expect(spec).toBeDefined();
    if (spec?.type !== 'function') throw new Error('Expected function tool');
    expect(JSON.stringify(spec.inputSchema)).toContain('enabled');
    expect(
      JSON.stringify(spec?.type === 'function' ? spec.inputSchema : undefined),
    ).not.toContain('chatId');
  });

  it.each([true, false])(
    'sets auto-archive to %s through the chat runtime',
    async (enabled) => {
      const setAutoArchiveForCurrentChat = jest
        .fn()
        .mockResolvedValue(undefined);
      const response = await handleAppAdvisorDynamicToolCall(
        {
          threadId: 'thread-1',
          turnId: 'turn-1',
          callId: 'archive-call',
          namespace: null,
          tool: 'canopy_app_advisor_set_auto_archive',
          arguments: { enabled },
        },
        createRuntime({ setAutoArchiveForCurrentChat }),
      );
      expect(response.success).toBe(true);
      expect(setAutoArchiveForCurrentChat).toHaveBeenCalledWith(enabled);
    },
  );

  it('advertises only a follow-up instruction for App Advisor forks', () => {
    const spec = buildAppAdvisorDynamicToolSpecs().find(
      (tool) => tool.name === 'canopy_app_advisor_start_forked_agent',
    );
    expect(spec).toBeDefined();
    const schema = JSON.stringify(
      spec?.type === 'function' ? spec.inputSchema : undefined,
    );
    expect(schema).toContain('followUpInstruction');
    expect(schema).not.toContain('projectId');
    expect(schema).not.toContain('worktreeId');
    expect(schema).not.toContain('chatId');
  });

  it('does not inject the worktree-only DeleteWatchers tool', () => {
    const names = buildAppAdvisorDynamicToolSpecs().map((tool) => tool.name);
    expect(names).not.toContain('canopy_app_advisor_delete_watchers');
    expect(names).not.toContain('app_advisor_delete_watchers');
  });

  it('executes WatchCommand through the shared App Advisor runtime', async () => {
    const watchCommand = jest.fn().mockResolvedValue({ id: 'watcher-command' });
    const result = await executeAppAdvisorTool(
      'watch_command',
      { command: 'printf ready', intervalSeconds: 5, maxAttempts: 2 },
      createRuntime({ watchCommand }),
      { toolUseId: 'tool-command' },
    );

    expect(result.isError).not.toBe(true);
    expect(watchCommand).toHaveBeenCalledWith(
      { command: 'printf ready', intervalSeconds: 5, maxAttempts: 2 },
      { toolUseId: 'tool-command' },
    );
  });

  it('reads retained watcher output through App Advisor GetScriptOutput', async () => {
    jest.mocked(readWatcherOutputPreview).mockResolvedValue('retained output');
    const loadScriptOutput = jest.fn();
    const runtime = createRuntime({ loadScriptOutput });
    const result = await executeAppAdvisorTool(
      'get_script_output',
      { scriptId: 'watcher:test-watcher:1' },
      runtime,
    );

    expect(result).toEqual({ text: 'retained output' });
    expect(readWatcherOutputPreview).toHaveBeenCalledWith(
      runtime.watcherDestination,
      'watcher:test-watcher:1',
      200,
    );
    expect(loadScriptOutput).not.toHaveBeenCalled();
  });

  it('marks every Codex dynamic tool as a function tool', () => {
    for (const tool of buildAppAdvisorDynamicToolSpecs()) {
      expect(tool).toHaveProperty('type', 'function');
    }
  });

  it('does not expose runtime-owned transport ids in provider schemas', () => {
    const specs = buildAppAdvisorDynamicToolSpecs();
    expect(specs.every((tool) => tool.type === 'function')).toBe(true);
    const serializedSchemas = JSON.stringify(
      specs.map((tool) => (tool.type === 'function' ? tool.inputSchema : null)),
    );
    const mcpDispatchKeys = Object.keys(dispatchActionToolSchema.shape);

    expect(serializedSchemas).not.toContain('requestId');
    expect(serializedSchemas).not.toContain('toolUseId');
    expect(serializedSchemas).not.toContain('sessionKey');
    expect(serializedSchemas).not.toContain('clientRequestId');
    expect(mcpDispatchKeys).toEqual(['expectedUiRevision', 'action']);
  });

  it('does not expose watcher display metadata in setup provider schemas', () => {
    const setupSpec = buildAppAdvisorDynamicToolSpecs().find(
      (tool) =>
        tool.name === getAppAdvisorProviderToolName('setup_watchers', 'codex'),
    );
    const setupSchema = JSON.stringify(
      setupSpec?.type === 'function' ? setupSpec.inputSchema : undefined,
    );

    expect(setupSchema).not.toContain('workspaceName');
    expect(setupSchema).not.toContain('chatTitle');
    expect(setupSchema).not.toContain('providerType');
    expect(setupSchema).not.toContain('targetKind');
  });

  it('keeps App Advisor and worktree WatchGitHubItems schemas equivalent and bounded', () => {
    expect(watchGitHubItemsJsonSchema).toEqual(
      worktreeWatchGitHubItemsJsonSchema,
    );
    const valid = {
      repository: 'acme/api',
      items: [
        '123',
        'acme/web#456/2',
        {
          kind: 'workflow_run',
          target:
            'https://github.com/acme/mobile/actions/runs/789/job/101112#step:3:1',
        },
      ],
      notifyOn: {
        run: { statuses: ['in_progress'], conclusions: 'any' },
        jobs: { conclusions: 'any' },
      },
    };
    expect(watchGitHubItemsSchema.safeParse(valid).success).toBe(true);
    expect(worktreeWatchGitHubItemsSchema.safeParse(valid).success).toBe(true);
    for (const items of [
      [1.5],
      [{ kind: 'workflow_run', target: 0 }],
      [{ kind: 'workflow_run', runId: -1 }],
      [{ kind: 'workflow_run', runId: 1, runAttempt: 1.5 }],
      [{ kind: 'workflow_run', runId: 1, runAttempt: 0 }],
    ]) {
      const invalidIdentifiers = { ...valid, items };
      expect(watchGitHubItemsSchema.safeParse(invalidIdentifiers).success).toBe(
        false,
      );
      expect(
        worktreeWatchGitHubItemsSchema.safeParse(invalidIdentifiers).success,
      ).toBe(false);
    }
    for (const notifyOn of [
      { run: { statuses: ['queued', 'queued'] } },
      { run: { conclusions: ['failure', 'failure'] } },
      { jobs: { conclusions: ['success', 'success'] } },
    ]) {
      const duplicateSelection = { ...valid, notifyOn };
      expect(watchGitHubItemsSchema.safeParse(duplicateSelection).success).toBe(
        false,
      );
      expect(
        worktreeWatchGitHubItemsSchema.safeParse(duplicateSelection).success,
      ).toBe(false);
    }
    const pullRequest = {
      kind: 'pull_request',
      target: 'https://github.com/acme/api/pull/42',
    };
    for (const notifyOn of [
      undefined,
      { queue: { entered: true } },
      { queue: { phases: 'any' } },
      { queue: { entered: false, phases: ['locked', 'unmergeable'] } },
    ]) {
      const pullRequestWatch = { items: [pullRequest], notifyOn };
      expect(watchGitHubItemsSchema.safeParse(pullRequestWatch).success).toBe(
        true,
      );
      expect(
        worktreeWatchGitHubItemsSchema.safeParse(pullRequestWatch).success,
      ).toBe(true);
    }
    for (const notifyOn of [
      { run: { conclusions: 'any' } },
      { jobs: { conclusions: 'any' } },
      { conclusions: 'any' },
      { queue: { entered: true }, run: { statuses: 'any' } },
      { queue: {} },
      { queue: { phases: ['unknown'] } },
      { queue: { phases: ['locked', 'locked'] } },
    ]) {
      const pullRequestWatch = { items: [pullRequest], notifyOn };
      expect(watchGitHubItemsSchema.safeParse(pullRequestWatch).success).toBe(
        false,
      );
      expect(
        worktreeWatchGitHubItemsSchema.safeParse(pullRequestWatch).success,
      ).toBe(false);
    }
    const pullRequestRun = watchGitHubItemsSchema.safeParse({
      items: [pullRequest],
      notifyOn: { run: { conclusions: 'any' } },
    });
    expect(pullRequestRun.error?.issues).toEqual([
      expect.objectContaining({
        path: ['notifyOn', 'run'],
        message:
          'notifyOn.run is for workflow runs. Pull requests accept only notifyOn.queue.',
      }),
    ]);
    const runQueue = watchGitHubItemsSchema.safeParse({
      items: ['123'],
      repository: 'acme/api',
      notifyOn: { queue: { entered: true } },
    });
    expect(runQueue.error?.issues).toEqual([
      expect.objectContaining({
        path: ['notifyOn', 'queue'],
        message: 'notifyOn.queue is for pull requests only.',
      }),
    ]);
    expect(
      worktreeWatchGitHubItemsSchema.safeParse({
        ...valid,
        notifyOn: { ...valid.notifyOn, queue: { entered: true } },
      }).success,
    ).toBe(false);
    const serialized = JSON.stringify(watchGitHubItemsJsonSchema);
    expect(serialized).toContain('"maxItems":20');
    expect(serialized).toContain('"type":"integer","minimum":1');
    expect(serialized).not.toContain('{"type":"integer"}');
    expect(serialized).not.toContain('destination');
    expect(serialized).not.toContain('runtimeState');
    expect(serialized).not.toContain('display');
    expect(serialized).not.toContain('pendingDelivery');
  });

  it('keeps provider schemas free of top-level composition keywords', () => {
    for (const tool of buildAppAdvisorDynamicToolSpecs()) {
      if (tool.type !== 'function') throw new Error('Expected function tool');
      const schema = tool.inputSchema;
      expect(schema).not.toHaveProperty('oneOf');
      expect(schema).not.toHaveProperty('anyOf');
      expect(schema).not.toHaveProperty('allOf');
    }
  });

  it('describes the dispatch_action discriminator in the model-facing schema', () => {
    expect(dispatchActionJsonSchema).toMatchObject({ type: 'object' });
    expect(dispatchActionJsonSchema).toMatchObject({
      properties: {
        expectedUiRevision: {
          type: 'integer',
        },
        action: {
          required: ['type'],
          properties: {
            type: {
              type: 'string',
            },
          },
        },
      },
      required: ['action'],
    });
  });

  it('does not use top-level JSON schema composition keywords in dispatch_action', () => {
    const schema = dispatchActionJsonSchema as Record<string, unknown>;

    expect(schema).not.toHaveProperty('oneOf');
    expect(schema).not.toHaveProperty('anyOf');
    expect(schema).not.toHaveProperty('allOf');
  });

  it('accepts Canopy Cloud account actions in the DispatchAction schema', () => {
    expect(
      dispatchActionToolSchema.safeParse({
        action: { type: 'canopy_cloud.load_account' },
      }).success,
    ).toBe(true);
    expect(
      dispatchActionToolSchema.safeParse({
        action: {
          type: 'canopy_cloud.validate_api_key',
          apiKey: 'csk_valid',
        },
      }).success,
    ).toBe(true);
    expect(
      dispatchActionToolSchema.safeParse({
        action: { type: 'canopy_cloud.save_api_key', apiKey: 'csk_valid' },
      }).success,
    ).toBe(true);
    expect(
      dispatchActionToolSchema.safeParse({
        action: { type: 'canopy_cloud.clear_api_key' },
      }).success,
    ).toBe(true);
  });

  it('exposes workspace.find_repository_owner to both providers through dispatch_action (CAN-3592)', () => {
    for (const payload of [
      { path: '/repos/payments' },
      { remoteUrl: 'https://github.com/acme/payments.git' },
    ]) {
      expect(
        dispatchActionToolSchema.safeParse({
          action: { type: 'workspace.find_repository_owner', ...payload },
        }).success,
      ).toBe(true);
    }
    // The provider schema passes payloads through; the executor's runtime
    // union is authoritative and rejects both keys together.
    expect(
      dispatchActionSchema.safeParse({
        action: {
          type: 'workspace.find_repository_owner',
          path: '/repos/payments',
          remoteUrl: 'https://github.com/acme/payments.git',
        },
      }).success,
    ).toBe(false);
    // The Codex dynamic tool's JSON schema enumerates catalog types.
    expect(JSON.stringify(buildAppAdvisorDynamicToolSpecs())).toContain(
      'workspace.find_repository_owner',
    );
  });

  it('accepts worktree chat scheduled-message actions in the DispatchAction schema', () => {
    expect(
      dispatchActionSchema.safeParse({
        expectedUiRevision: 12,
        action: {
          type: 'worktree-chat.schedule_message',
          projectId: 'registrar-platform',
          worktreeId: 'dev-kookaburra',
          chatId: 'chat-1-1780333778355',
          text: 'howdy',
          runAt: '2026-06-07T01:36:13.000Z',
          name: 'howdy',
        },
      }).success,
    ).toBe(true);

    expect(
      dispatchActionSchema.safeParse({
        action: {
          type: 'worktree-chat.schedule_message',
          projectId: 'registrar-platform',
          worktreeId: 'dev-kookaburra',
          chatId: 'chat-1-1780333778355',
          text: 'howdy',
          runAt: '2026-06-07T01:36:13.000Z',
          timezone: 'UTC',
        },
      }).success,
    ).toBe(false);
  });

  it('accepts merge-conflict resolution actions in the DispatchAction schema', () => {
    expect(
      dispatchActionToolSchema.safeParse({
        action: {
          type: 'worktree.start_merge_conflict_resolution',
          projectId: 'registrar-platform',
          worktreeId: 'dev-kookaburra',
          repoId: 'web',
          repoName: 'web',
          branchName: 'main',
        },
      }).success,
    ).toBe(true);
  });

  it('dispatches shared editor setup navigation through the presentation port', async () => {
    const dispatchRendererAction = jest
      .fn()
      .mockResolvedValue({ requestId: 'editor-review', ok: true });
    const action = {
      type: 'navigation.open_editor_setup',
      workspaceId: 'workspace-1',
    };
    const response = await executeAppAdvisorTool(
      'dispatch_action',
      { action },
      createRuntime({ dispatchRendererAction }),
    );
    expect(response.isError).toBe(false);
    expect(dispatchRendererAction).toHaveBeenCalledTimes(1);
    expect(dispatchRendererAction).toHaveBeenCalledWith(
      action,
      undefined,
      undefined,
      undefined,
    );
  });

  it('dispatches worktree archive actions through the main-process schema', async () => {
    const dispatchRendererAction = jest.fn().mockResolvedValue({
      requestId: 'archive-request',
      ok: true,
    });
    const action = {
      type: 'worktree.archive',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      deleteBranch: false,
    };

    const response = await executeAppAdvisorTool(
      'dispatch_action',
      { action },
      createRuntime({ dispatchRendererAction }),
    );

    expect(response.isError).toBe(false);
    expect(dispatchRendererAction).toHaveBeenCalledWith(
      action,
      undefined,
      undefined,
    );
  });

  describe('Agent actions', () => {
    const pluginSelections = {
      collectionIds: ['collection-1'],
      skillRefs: [{ sourceId: 'source-1', skillName: 'review' }],
      pluginRefs: [{ marketplaceId: 'market-1', pluginName: 'lint' }],
      mcpServerRefs: [{ serverId: 'server-1', configId: 'config-1' }],
    };
    const agentActions = [
      ...APP_ADVISOR_ACTION_CATALOG.filter((entry) =>
        entry.type.startsWith('agents.'),
      ).flatMap((entry) => [
        entry.example,
        ...(entry.additionalExamples ?? []),
      ]),
      { type: 'agents.list', query: 'review', limit: 2 },
      {
        type: 'agents.list_shared',
        query: 'review',
        limit: 5,
        cursor: 'cursor-1',
        createdBy: 'me',
      },
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
    ];

    it.each(agentActions)(
      'dispatches $type with its payload intact',
      async (action) => {
        const dispatchRendererAction = jest.fn().mockResolvedValue({
          requestId: 'agent-contract',
          ok: true,
          result: { reached: true },
        });

        const response = await executeAppAdvisorTool(
          'dispatch_action',
          { action },
          createRuntime({ dispatchRendererAction }),
        );

        expect(response.isError).toBe(false);
        expect(dispatchRendererAction).toHaveBeenCalledWith(
          action,
          undefined,
          undefined,
        );
        expect(JSON.parse(response.text)).toMatchObject({
          ok: true,
          result: { reached: true },
        });
      },
    );

    it.each([
      { type: 'agents.get' },
      { type: 'agents.import_shared', agentId: '' },
      { type: 'agents.list_shared', createdBy: 'team' },
      { type: 'agents.create', name: 'Reviewer', baseModel: 'opus' },
      {
        type: 'agents.create',
        name: 'Reviewer',
        baseModel: 'opus',
        instructions: 'Review.',
        pluginSelections: { collectionIds: ['collection-1'] },
      },
      { type: 'agents.update', id: 'agent_model_code_reviewer' },
    ])(
      'rejects invalid $type payloads before renderer dispatch',
      async (action) => {
        const dispatchRendererAction = jest.fn();

        const response = await executeAppAdvisorTool(
          'dispatch_action',
          { action },
          createRuntime({ dispatchRendererAction }),
        );

        expect(response.isError).toBe(true);
        expect(response.text).toContain('Invalid arguments for DispatchAction');
        expect(dispatchRendererAction).not.toHaveBeenCalled();
      },
    );
  });

  it('keeps worktree chat messages to their frozen fields, dropping select', async () => {
    const dispatchRendererAction = jest.fn().mockResolvedValue({
      requestId: 'send-request',
      ok: true,
    });
    const action = {
      type: 'worktree-chat.send_message',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      text: 'Summarize the current diff.',
    };

    const response = await executeAppAdvisorTool(
      'dispatch_action',
      { action: { ...action, select: false } },
      createRuntime({ dispatchRendererAction }),
      { toolUseId: 'send-request' },
    );

    expect(response.isError).toBe(false);
    expect(dispatchRendererAction).toHaveBeenCalledWith(
      action,
      undefined,
      'send-request',
    );
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
  ])('dispatches $type with its full dialog payload', async (input) => {
    const dispatchRendererAction = jest.fn().mockResolvedValue({
      requestId: 'dialog-request',
      ok: true,
    });
    const action = {
      ...input,
      browserId: 'browser-1',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      expectedRuntimeGeneration: 7,
    };

    const response = await executeAppAdvisorTool(
      'dispatch_action',
      { action },
      createRuntime({ dispatchRendererAction }),
      { toolUseId: 'dialog-request' },
    );

    expect(response.isError).toBe(false);
    expect(dispatchRendererAction).toHaveBeenCalledTimes(1);
    expect(dispatchRendererAction).toHaveBeenCalledWith(
      action,
      undefined,
      'dialog-request',
    );
  });

  it('routes get_current_ui_state calls through the App Advisor runtime', async () => {
    const requestUiState = jest.fn().mockResolvedValue({
      version: 1,
      revision: 1,
      capturedAt: '2026-05-19T00:00:00.000Z',
      digest: 'digest',
      snapshot: {
        activePage: 'main',
        overlays: {
          commandPaletteOpen: false,
          fileSearchPaletteOpen: false,
          prPickerOpen: false,
          canopyPortalOpen: false,
          appAdvisorOpen: true,
        },
      },
    });
    const runtime = createRuntime({ requestUiState });
    const response = await handleAppAdvisorDynamicToolCall(
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        callId: 'call-1',
        namespace: null,
        tool: getAppAdvisorProviderToolName('get_current_ui_state', 'codex'),
        arguments: {},
      },
      runtime,
    );

    expect(requestUiState).toHaveBeenCalled();
    expect(response.success).toBe(true);
    expect(response.contentItems[0]?.type).toBe('inputText');
    expect(
      response.contentItems.find((item) => item.type === 'inputText')?.text,
    ).toContain('"revision": 1');
  });

  it('routes search_actions calls through the App Advisor action catalog', async () => {
    const response = await handleAppAdvisorDynamicToolCall(
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        callId: 'call-search',
        namespace: null,
        tool: getAppAdvisorProviderToolName('search_actions', 'codex'),
        arguments: { query: 'pipeline debug', limit: 3 },
      },
      createRuntime(),
    );

    expect(response.success).toBe(true);
    expect(
      response.contentItems.find((item) => item.type === 'inputText')?.text,
    ).toContain('pipeline.debug_run');
    expect(
      response.contentItems.find((item) => item.type === 'inputText')?.text,
    ).toContain('executionId');
  });

  it('refreshes renderer page availability on every action search', async () => {
    const requestUiState = jest
      .fn()
      .mockResolvedValueOnce({
        snapshot: { availablePages: ['home', 'plugins'] },
      })
      .mockResolvedValueOnce({ snapshot: { availablePages: ['home'] } });
    const runtime = createRuntime({ requestUiState });
    const flags = getDefaultFeatureFlagSnapshot();
    const snapshotSpy = jest
      .spyOn(getFeatureFlagService(), 'getSnapshot')
      .mockReturnValue({
        ...flags,
        values: {
          ...flags.values,
          [CLIENT_FEATURE_FLAGS.canopySharedCustomAgents.key]: true,
        },
      });
    try {
      const allowed = await executeAppAdvisorTool(
        'search_actions',
        { category: 'agents' },
        runtime,
      );
      const denied = await executeAppAdvisorTool(
        'search_actions',
        { category: 'agents' },
        runtime,
      );
      const allowedResult: unknown = JSON.parse(allowed.text);
      const deniedResult: unknown = JSON.parse(denied.text);
      expect(allowedResult).toHaveProperty(
        'actions',
        expect.arrayContaining([
          expect.objectContaining({ type: 'agents.open_manager' }),
        ]),
      );
      expect(deniedResult).toHaveProperty(
        'actions',
        expect.arrayContaining([
          expect.objectContaining({ type: 'agents.list' }),
        ]),
      );
      expect(deniedResult).not.toHaveProperty(
        'actions',
        expect.arrayContaining([
          expect.objectContaining({ type: 'agents.open_manager' }),
        ]),
      );
      expect(requestUiState).toHaveBeenCalledTimes(2);
    } finally {
      snapshotSpy.mockRestore();
    }
  });

  it('re-evaluates the agents flag on each search without trusting caller flags', async () => {
    const runtime = createRuntime({
      requestUiState: jest.fn().mockResolvedValue({
        snapshot: { availablePages: ['home', 'plugins'] },
      }),
    });
    const flags = getDefaultFeatureFlagSnapshot();
    const snapshotSpy = jest
      .spyOn(getFeatureFlagService(), 'getSnapshot')
      .mockReturnValueOnce({
        ...flags,
        values: {
          ...flags.values,
          [CLIENT_FEATURE_FLAGS.canopySharedCustomAgents.key]: true,
        },
      })
      .mockReturnValueOnce({
        ...flags,
        values: {
          ...flags.values,
          [CLIENT_FEATURE_FLAGS.canopySharedCustomAgents.key]: false,
        },
      });
    try {
      const allowed = await executeAppAdvisorTool(
        'search_actions',
        { category: 'agents' },
        runtime,
      );
      const disabled = await executeAppAdvisorTool(
        'search_actions',
        {
          category: 'agents',
          featureFlags: {
            [CLIENT_FEATURE_FLAGS.canopySharedCustomAgents.key]: true,
          },
        },
        runtime,
      );
      const allowedResult: unknown = JSON.parse(allowed.text);
      const disabledResult: unknown = JSON.parse(disabled.text);
      expect(allowedResult).toHaveProperty(
        'actions',
        expect.arrayContaining([
          expect.objectContaining({ type: 'agents.open_manager' }),
          expect.objectContaining({ type: 'agents.list' }),
        ]),
      );
      expect(disabledResult).toMatchObject({ actions: [] });
    } finally {
      snapshotSpy.mockRestore();
    }
  });

  it.each(['missing availability', 'failed refresh', 'collapsed availability'])(
    'keeps unrelated discovery with %s',
    async (scenario) => {
      const requestUiState =
        scenario === 'failed refresh'
          ? jest.fn().mockRejectedValue(new Error('renderer disconnected'))
          : jest.fn().mockResolvedValue({
              snapshot:
                scenario === 'collapsed availability'
                  ? { availablePages: { count: 20 } }
                  : {},
            });
      const runtime = createRuntime({ requestUiState });
      const agents = await executeAppAdvisorTool(
        'search_actions',
        { category: 'agents' },
        runtime,
      );
      const agentsResult: unknown = JSON.parse(agents.text);
      expect(agentsResult).toHaveProperty(
        'actions',
        expect.arrayContaining([
          expect.objectContaining({ type: 'agents.list' }),
        ]),
      );
      expect(agentsResult).not.toHaveProperty(
        'actions',
        expect.arrayContaining([
          expect.objectContaining({ type: 'agents.open_manager' }),
        ]),
      );
      const unrelated = await executeAppAdvisorTool(
        'search_actions',
        { actionType: 'pipeline.debug_run' },
        runtime,
      );
      const unrelatedResult: unknown = JSON.parse(unrelated.text);
      expect(unrelatedResult).toMatchObject({
        actions: [expect.objectContaining({ type: 'pipeline.debug_run' })],
      });
    },
  );

  it('passes evaluated rollout flags into shared-container action search', async () => {
    const snapshot = getDefaultFeatureFlagSnapshot();
    const snapshotSpy = jest
      .spyOn(getFeatureFlagService(), 'getSnapshot')
      .mockReturnValue({
        ...snapshot,
        status: 'ready',
        values: {
          ...snapshot.values,
          [CLIENT_FEATURE_FLAGS.canopyDesktopSharedContainers.key]: false,
        },
      });

    const response = await handleAppAdvisorDynamicToolCall(
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        callId: 'call-search-shared-container-flags',
        namespace: null,
        tool: getAppAdvisorProviderToolName('search_actions', 'codex'),
        arguments: {
          query: 'invite teammate shared container revoke recipient',
          limit: 20,
        },
      },
      createRuntime(),
    );
    snapshotSpy.mockRestore();

    expect(response.success).toBe(true);
    expect(
      response.contentItems.find((item) => item.type === 'inputText')?.text,
    ).not.toContain('shared-containers.open_invite');
    expect(
      response.contentItems.find((item) => item.type === 'inputText')?.text,
    ).toContain('shared-containers.revoke_recipient');
  });

  it('routes read_pipeline_yaml calls through the App Advisor runtime', async () => {
    const loadPipelineYaml = jest.fn().mockResolvedValue({
      ok: true,
      text: 'Pipeline YAML: Review (review)\n---\n1: pipeline:',
    });
    const response = await handleAppAdvisorDynamicToolCall(
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        callId: 'call-read-yaml',
        namespace: null,
        tool: getAppAdvisorProviderToolName('read_pipeline_yaml', 'codex'),
        arguments: {
          pipelineId: 'review',
          startLine: 1,
          endLine: 5,
          pattern: 'pipeline',
          fixedString: true,
        },
      },
      createRuntime({ loadPipelineYaml }),
    );

    expect(loadPipelineYaml).toHaveBeenCalledWith({
      pipelineId: 'review',
      startLine: 1,
      endLine: 5,
      pattern: 'pipeline',
      fixedString: true,
    });
    expect(response.success).toBe(true);
    expect(
      response.contentItems.find((item) => item.type === 'inputText')?.text,
    ).toContain('Pipeline YAML');
  });

  it('routes ShowFiles calls with an optional target project', async () => {
    const showFiles = jest.fn().mockResolvedValue({
      opened: 1,
      failed: 0,
      files: [{ path: 'README.md', ok: true, tabId: 'file-1' }],
    });
    const response = await handleAppAdvisorDynamicToolCall(
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        callId: 'call-show-files',
        namespace: null,
        tool: getAppAdvisorProviderToolName('show_files', 'codex'),
        arguments: {
          files: [{ path: 'README.md', line: 12, view: 'rich' }],
          workspace: { projectId: 'project-1', worktreeId: 'worktree-1' },
        },
      },
      createRuntime({ showFiles }),
    );

    expect(showFiles).toHaveBeenCalledWith(
      [{ path: 'README.md', line: 12, view: 'rich' }],
      { projectId: 'project-1', worktreeId: 'worktree-1' },
    );
    expect(response.success).toBe(true);
    expect(
      response.contentItems.find((item) => item.type === 'inputText')?.text,
    ).toContain('"opened": 1');
  });

  it('reads and responds to file comments in an explicit project', async () => {
    const getScopedFileComments = jest.fn().mockResolvedValue({
      ok: true,
      text: 'Thread file-thread [open]',
    });
    const respondToScopedFileComment = jest.fn().mockResolvedValue({
      ok: true,
      resolved: true,
    });
    const runtime = createRuntime({
      getScopedFileComments,
      respondToScopedFileComment,
    });
    const workspace = { projectId: 'project-1', worktreeId: 'worktree-1' };

    const read = await handleAppAdvisorDynamicToolCall(
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        callId: 'call-read-file-comments',
        namespace: null,
        tool: getAppAdvisorProviderToolName('get_file_comments', 'codex'),
        arguments: { threadId: 'file-thread', workspace },
      },
      runtime,
    );
    const reply = await handleAppAdvisorDynamicToolCall(
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        callId: 'call-reply-file-comment',
        namespace: null,
        tool: getAppAdvisorProviderToolName('respond_to_file_comment', 'codex'),
        arguments: {
          threadId: 'file-thread',
          body: 'Addressed.',
          resolve: true,
          workspace,
        },
      },
      runtime,
    );

    expect(getScopedFileComments).toHaveBeenCalledWith({
      threadId: 'file-thread',
      workspace,
    });
    expect(respondToScopedFileComment).toHaveBeenCalledWith({
      threadId: 'file-thread',
      body: 'Addressed.',
      resolve: true,
      workspace,
    });
    expect(read.success).toBe(true);
    expect(reply.success).toBe(true);
  });

  it('advertises and preserves independent watcher instance search fields for MCP and Codex', async () => {
    const input = {
      query: 'catalog',
      limit: 100,
      activePageSize: 200,
      activeCursor: 'cursor',
      activeQuery: 'chat',
      targetProjectId: 'p',
      targetTaskId: 't',
      targetChatId: 'c',
    };
    const registered = z.object(searchWatchersToolShape).parse(input);
    expect(registered).toEqual(input);
    const spec = buildAppAdvisorDynamicToolSpecs().find(
      (tool) =>
        tool.name === getAppAdvisorProviderToolName('search_watchers', 'codex'),
    );
    expect(spec?.type === 'namespace' ? undefined : spec?.inputSchema).toEqual(
      searchWatchersJsonSchema,
    );
    const searchWatchers = jest.fn().mockResolvedValue({
      catalog: [],
      activeWatchers: [],
      activeReturned: 0,
      activeTotalMatches: 0,
    });
    const runtime = createRuntime({ searchWatchers });
    await executeAppAdvisorTool('search_watchers', registered, runtime);
    expect(searchWatchers).toHaveBeenCalledWith(input);
    const rejected = await executeAppAdvisorTool(
      'search_watchers',
      { targetProjectId: 'p', targetBotId: 'app_advisor' },
      runtime,
    );
    expect(rejected.isError).toBe(true);
    expect(searchWatchers).toHaveBeenCalledTimes(1);
  });

  it('routes watcher tools through the runtime and passes Codex tool call ids', async () => {
    const searchWatchers = jest.fn().mockResolvedValue({
      catalog: [],
      activeWatchers: [],
    });
    const setupWatchers = jest.fn().mockResolvedValue({
      ok: true,
      results: [],
    });
    const runtime = createRuntime({ searchWatchers, setupWatchers });

    await handleAppAdvisorDynamicToolCall(
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        callId: 'call-search-watchers',
        namespace: null,
        tool: getAppAdvisorProviderToolName('search_watchers', 'codex'),
        arguments: { query: 'finished' },
      },
      runtime,
    );
    await handleAppAdvisorDynamicToolCall(
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        callId: 'call-setup-watchers',
        namespace: null,
        tool: getAppAdvisorProviderToolName('setup_watchers', 'codex'),
        arguments: {
          watchers: [
            {
              trigger: 'worktree_chat_completion',
              target: {
                kind: 'worktree_chat',
                projectId: 'project-1',
                worktreeId: 'worktree-1',
                chatId: 'chat-1',
              },
            },
          ],
        },
      },
      runtime,
    );

    expect(searchWatchers).toHaveBeenCalledWith({ query: 'finished' });
    expect(setupWatchers).toHaveBeenCalledWith(expect.any(Object), {
      toolUseId: 'codex-call-setup-watchers',
    });
  });

  it('normalizes common malformed watcher setup payloads before validation', async () => {
    const setupWatchers = jest.fn().mockResolvedValue({
      ok: true,
      results: [],
    });
    const runtime = createRuntime({ setupWatchers });

    const response = await handleAppAdvisorDynamicToolCall(
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        callId: 'call-setup-watchers-near-miss',
        namespace: null,
        tool: getAppAdvisorProviderToolName('setup_watchers', 'codex'),
        arguments: {
          trigger: 'worktree_chat_completion',
          targetKind: 'worktree_chat',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          destinationChatId: 'advisor-chat',
          target: {
            id: 'chat-1',
            title: 'Display title only',
            providerType: 'codex',
          },
        },
      },
      runtime,
    );

    expect(response.success).toBe(true);
    expect(setupWatchers).toHaveBeenCalledWith(
      {
        watchers: [
          {
            trigger: 'worktree_chat_completion',
            target: {
              kind: 'worktree_chat',
              projectId: 'project-1',
              worktreeId: 'worktree-1',
              chatId: 'chat-1',
            },
          },
        ],
      },
      { toolUseId: 'codex-call-setup-watchers-near-miss' },
    );
  });

  it('routes WatchGitHubItems through the shared runtime with bounded output', async () => {
    const watchGitHubItems = jest.fn().mockResolvedValue({
      ok: true,
      status: 'created',
      watcherId: 'watcher-1',
      itemCount: 1,
      events: ['workflow_job_completed'],
    });
    const response = await handleAppAdvisorDynamicToolCall(
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        callId: 'call-watch-github',
        namespace: null,
        tool: getAppAdvisorProviderToolName('watch_github_items', 'codex'),
        arguments: {
          items: ['https://github.com/acme/api/actions/runs/1/attempts/2'],
          notifyOn: { jobs: { conclusions: 'any' } },
        },
      },
      createRuntime({ watchGitHubItems }),
    );
    expect(watchGitHubItems).toHaveBeenCalledWith(
      expect.objectContaining({
        notifyOn: { jobs: { conclusions: 'any' } },
      }),
      { toolUseId: 'codex-call-watch-github' },
    );
    expect(response.success).toBe(true);
    expect(response.contentItems[0]).toMatchObject({
      type: 'inputText',
      text: JSON.stringify({
        ok: true,
        status: 'created',
        watcherId: 'watcher-1',
        itemCount: 1,
        events: ['workflow_job_completed'],
      }),
    });
  });

  it('advertises and runs the cached pull request status read', async () => {
    const name = getAppAdvisorProviderToolName(
      'get_github_pull_request_status',
      'codex',
    );
    expect(name).toBe('canopy_app_advisor_get_github_pull_request_status');
    const spec = buildAppAdvisorDynamicToolSpecs().find(
      (tool) => tool.name === name,
    );
    expect(spec?.description).toContain('use WatchGitHubItems instead');
    mockGetGitHubPullRequestStatus.mockRejectedValue(
      new Error('github-pr-read-model not integrated'),
    );
    const response = await handleAppAdvisorDynamicToolCall(
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        callId: 'call-pr-status',
        namespace: null,
        tool: name,
        arguments: { pullRequest: 'acme/api#7' },
      },
      createRuntime(),
    );
    expect(mockGetGitHubPullRequestStatus).toHaveBeenCalledWith(
      { owner: 'acme', repo: 'api', number: 7 },
      { priority: 'interactive', caller: 'agent-pr-status' },
    );
    expect(response.success).toBe(false);
    const [item] = response.contentItems;
    expect(item?.type === 'inputText' ? item.text : '').toContain(
      '"code":"unavailable"',
    );
  });

  it('rejects malformed WatchGitHubItems arguments before calling the runtime', async () => {
    const watchGitHubItems = jest.fn();
    const result = await executeAppAdvisorTool(
      'watch_github_items',
      {
        items: [{ kind: 'workflow_run', repository: 'not-a-repo', runId: 'x' }],
        notifyOn: {},
      },
      createRuntime({ watchGitHubItems }),
    );

    expect(result).toEqual({
      text:
        'Invalid arguments for WatchGitHubItems.\n' +
        '- notifyOn: Select notifyOn.run or notifyOn.jobs for workflow runs, or notifyOn.queue for pull requests.\n' +
        '- For every completed job use {"notifyOn":{"jobs":{"conclusions":"any"}}}.',
      isError: true,
    });
    expect(watchGitHubItems).not.toHaveBeenCalled();
  });

  it('normalizes stringified watcher target objects before validation', async () => {
    const setupWatchers = jest.fn().mockResolvedValue({
      ok: true,
      results: [],
    });
    const runtime = createRuntime({ setupWatchers });

    const response = await handleAppAdvisorDynamicToolCall(
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        callId: 'call-setup-watchers-string-target',
        namespace: null,
        tool: getAppAdvisorProviderToolName('setup_watchers', 'codex'),
        arguments: {
          watchers: [
            {
              trigger: 'worktree_chat_completion',
              target:
                '{"projectId":"canopy","worktreeId":"dev-seal","chatId":"chat-1-1779674019122"}',
              label: 'Current chat finished',
              followUpInstruction:
                'Notify me when this current worktree chat finishes.',
              allowDuplicate: true,
              armForNextCompletion: true,
            },
          ],
        },
      },
      runtime,
    );

    expect(response.success).toBe(true);
    expect(setupWatchers).toHaveBeenCalledWith(
      {
        watchers: [
          {
            trigger: 'worktree_chat_completion',
            label: 'Current chat finished',
            target: {
              kind: 'worktree_chat',
              projectId: 'canopy',
              worktreeId: 'dev-seal',
              chatId: 'chat-1-1779674019122',
            },
            followUpInstruction:
              'Notify me when this current worktree chat finishes.',
            allowDuplicate: true,
            armForNextCompletion: true,
          },
        ],
      },
      { toolUseId: 'codex-call-setup-watchers-string-target' },
    );
  });

  it.each([
    { type: 'browser.click', locator: '#ready' },
    { type: 'browser.fill', locator: '#ready', text: 'value' },
    {
      type: 'browser.set_checked',
      locator: '#terms',
      checked: true,
      actionId: 'checked-action',
      timeoutMs: 2_345,
    },
    {
      type: 'browser.select_option',
      locator: '#country',
      values: ['ca'],
      searchText: 'Canada',
      actionId: 'select-action',
      timeoutMs: 3_456,
    },
    {
      type: 'browser.type',
      locator: '#search',
      text: 'query',
      delayMs: 37,
      actionId: 'type-action',
      timeoutMs: 4_567,
    },
    { type: 'browser.press', locator: '#ready', key: 'Enter' },
    {
      type: 'browser.drag',
      from: { locator: '#card', frame: 'f-source' },
      to: { locator: '#column', frame: 'f-source' },
      steps: 8,
      modifiers: ['Shift'],
    },
    { type: 'browser.hover', locator: '#ready' },
    {
      type: 'browser.scroll',
      direction: 'down',
      locator: '#ready',
      pages: 0.5,
    },
    { type: 'browser.scroll', toText: 'Ready' },
    { type: 'browser.focus', locator: '#ready' },
    { type: 'browser.wait_for', locator: '#ready' },
    { type: 'browser.wait_for', text: 'Ready' },
    { type: 'browser.inspect', locator: '#ready' },
    { type: 'browser.input_snapshot', role: 'textbox' },
  ])(
    'carries browser action payload through App Advisor provider DispatchAction for %j',
    async (payload) => {
      const dispatchRendererAction = jest
        .fn()
        .mockResolvedValue({ requestId: 'codex-frame', ok: true });
      const action = {
        ...payload,
        expectedRuntimeGeneration: 1,
        ...(payload.type === 'browser.drag'
          ? {}
          : { frame: '  iframe.checkout  ' }),
      };
      await handleAppAdvisorDynamicToolCall(
        {
          threadId: 'thread-1',
          turnId: 'turn-1',
          callId: 'frame',
          namespace: null,
          tool: getAppAdvisorProviderToolName('dispatch_action', 'codex'),
          arguments: { action },
        },
        createRuntime({ dispatchRendererAction }),
      );
      expect(dispatchRendererAction).toHaveBeenCalledWith(
        action,
        undefined,
        'codex-frame',
      );
    },
  );

  it('uses the Codex tool call id instead of a legacy model requestId when dispatching actions', async () => {
    const dispatchRendererAction = jest.fn().mockResolvedValue({
      requestId: 'codex-call-create-a',
      ok: true,
    });
    const runtime = createRuntime({ dispatchRendererAction });
    const args = {
      requestId: 'stable-create-worktree-id',
      action: { type: 'worktree.create', workspaceId: 'canopy' },
    };

    await handleAppAdvisorDynamicToolCall(
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        callId: 'call-create-a',
        namespace: null,
        tool: getAppAdvisorProviderToolName('dispatch_action', 'codex'),
        arguments: args,
      },
      runtime,
    );
    await handleAppAdvisorDynamicToolCall(
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        callId: 'call-create-b',
        namespace: null,
        tool: getAppAdvisorProviderToolName('dispatch_action', 'codex'),
        arguments: args,
      },
      runtime,
    );

    expect(dispatchRendererAction).toHaveBeenNthCalledWith(
      1,
      args.action,
      undefined,
      'codex-call-create-a',
    );
    expect(dispatchRendererAction).toHaveBeenNthCalledWith(
      2,
      args.action,
      undefined,
      'codex-call-create-b',
    );
  });

  it('ignores legacy model requestIds for dispatch_action without provider call context', async () => {
    const dispatchRendererAction = jest.fn().mockResolvedValue({
      requestId: 'generated-request-id',
      ok: true,
    });
    const runtime = createRuntime({ dispatchRendererAction });

    await executeAppAdvisorTool(
      'dispatch_action',
      {
        requestId: 'stable-model-controlled-id',
        action: { type: 'navigation.go_to_page', page: 'pipelines' },
      },
      runtime,
    );

    expect(dispatchRendererAction).toHaveBeenCalledWith(
      { type: 'navigation.go_to_page', page: 'pipelines' },
      undefined,
      undefined,
    );
  });

  it('rejects project add actions without join project ids in the provider schema', async () => {
    const dispatchRendererAction = jest.fn();
    const response = await executeAppAdvisorTool(
      'dispatch_action',
      {
        action: {
          type: 'worktree.add_workspace',
          sourceWorkspaceId: 'project-1',
          sourceWorktreeId: 'worktree-1',
        },
      },
      createRuntime({ dispatchRendererAction }),
    );

    expect(response.isError).toBe(true);
    expect(response.text).toContain('Invalid arguments for DispatchAction');
    expect(dispatchRendererAction).not.toHaveBeenCalled();
  });

  it('says why a browser action was refused by the provider schema', async () => {
    const dispatchRendererAction = jest.fn();
    const response = await executeAppAdvisorTool(
      'dispatch_action',
      {
        action: {
          type: 'browser.wait_for',
          browserId: 'browser-1',
          expectedRuntimeGeneration: 1,
          frame: 'f-1',
          url: 'checkout',
        },
      },
      createRuntime({ dispatchRendererAction }),
    );

    expect(response.isError).toBe(true);
    expect(response.text.split('\n')).toEqual([
      'Invalid arguments for DispatchAction.',
      '- browser.wait_for frame requires locator or text and cannot be combined with url or loadState.',
    ]);
    expect(dispatchRendererAction).not.toHaveBeenCalled();
  });

  it('returns a structured error for unknown App Advisor tool keys', async () => {
    const response = await executeAppAdvisorTool(
      'future_tool' as never,
      {},
      createRuntime(),
    );

    expect(response.isError).toBe(true);
    expect(response.text).toContain('Unhandled App Advisor tool key');
  });

  it('rejects non-App Advisor dynamic tool names', async () => {
    const response = await handleAppAdvisorDynamicToolCall(
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        callId: 'call-2',
        namespace: null,
        tool: 'canopy_get_script_output',
        arguments: { scriptId: 'setup' },
      },
      createRuntime(),
    );

    expect(response.success).toBe(false);
    expect(
      response.contentItems.find((item) => item.type === 'inputText')?.text,
    ).toContain('Unsupported Orchestrator');
  });
});

describe('App Advisor transcript reads through both providers', () => {
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
  it.each(actions)(
    'discovers $type by exact type without a renderer',
    async (action) => {
      const runtime = createRuntime({
        requestUiState: jest.fn().mockRejectedValue(new Error('disconnected')),
      });
      const response = await executeAppAdvisorTool(
        'search_actions',
        { actionType: action.type, category: 'chat', limit: 1 },
        runtime,
      );
      expect(JSON.parse(response.text)).toMatchObject({
        totalMatches: 1,
        returned: 1,
        actions: [{ type: action.type, category: 'chat' }],
      });
    },
  );
  it('uses one combined ranking and one final limit', async () => {
    const result = await executeAppAdvisorTool(
      'search_actions',
      { query: 'transcript', limit: 2 },
      createRuntime(),
    );
    expect(JSON.parse(result.text)).toMatchObject({ returned: 2 });
    const parsed: unknown = JSON.parse(result.text);
    expect(parsed).toMatchObject({
      actions: [
        { type: 'delegation.transcript' },
        { type: 'chat.transcript.page' },
      ],
    });
  });
  it.each(actions)(
    'dispatches $type through Codex dynamic tools',
    async (action) => {
      const dispatchRendererAction = jest.fn().mockResolvedValue({
        requestId: 'provider',
        ok: true,
        result: { marker: 'shared' },
      });
      const response = await handleAppAdvisorDynamicToolCall(
        {
          threadId: 'thread-1',
          turnId: 'turn-1',
          callId: 'transcript-call',
          namespace: null,
          tool: getAppAdvisorProviderToolName('dispatch_action', 'codex'),
          arguments: { action },
        },
        createRuntime({ dispatchRendererAction }),
      );
      expect(response.success).toBe(true);
      expect(dispatchRendererAction).toHaveBeenCalledWith(
        expect.objectContaining(action),
        undefined,
        expect.any(String),
      );
    },
  );
  it.each(actions)(
    'dispatches $type through Claude MCP registered tools',
    async (action) => {
      const dispatchRendererAction = jest
        .fn()
        .mockResolvedValue({ requestId: 'provider', ok: true });
      createAppAdvisorMcpServer(createRuntime({ dispatchRendererAction }));
      const tool = mockMcpTools.get('DispatchAction');
      expect(tool).toBeDefined();
      const response = await tool?.handler({ action });
      expect(response).toMatchObject({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ requestId: 'provider', ok: true }, null, 2),
          },
        ],
      });
      // MCP supplies no transport id here; the main runtime owns its default.
      expect(dispatchRendererAction).toHaveBeenCalledWith(
        expect.objectContaining(action),
        undefined,
        undefined,
      );
    },
  );
});
it('passes request cancellation through an Advisor independent fork', async () => {
  const fork = jest.fn().mockResolvedValue({ ok: true });
  const signal = new AbortController().signal;
  await executeAppAdvisorTool(
    'start_forked_agent',
    { followUpInstruction: 'Inspect' },
    createRuntime({ startForkedAgent: fork }),
    { signal },
  );
  expect(fork).toHaveBeenCalledWith('Inspect', signal);
  fork.mockClear();
  const refused = await executeAppAdvisorTool(
    'start_forked_agent',
    { followUpInstruction: 'Inspect' },
    createRuntime({ startForkedAgent: fork }),
    { signal: AbortSignal.abort(new Error('Stop requested')) },
  );
  expect(refused).toMatchObject({ isError: true });
  expect(fork).not.toHaveBeenCalled();
});
