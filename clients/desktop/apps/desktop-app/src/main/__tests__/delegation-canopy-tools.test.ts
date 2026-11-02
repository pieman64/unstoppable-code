import type * as CanopyCoreModule from '../canopy-tools/core';
import type {
  CanopyInjectedToolContext,
  CanopyInjectedToolRuntime,
  CanopyInjectedToolTextResult,
} from '../canopy-tools/core';
import type { CanopyInjectedToolKey } from '@canopy/desktop-shared/lib/canopy-injected-tools';
import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';

const mockExecute = jest.fn(
  (
    key: CanopyInjectedToolKey,
    input: unknown,
    runtime: CanopyInjectedToolRuntime,
    context?: CanopyInjectedToolContext,
  ): Promise<CanopyInjectedToolTextResult> => {
    void key;
    void input;
    void runtime;
    void context;
    return Promise.resolve({ text: 'tool result' });
  },
);
jest.mock('../canopy-tools/core', () => ({
  executeCanopyInjectedTool: (
    key: CanopyInjectedToolKey,
    input: unknown,
    runtime: CanopyInjectedToolRuntime,
    context?: CanopyInjectedToolContext,
  ): Promise<CanopyInjectedToolTextResult> =>
    mockExecute(key, input, runtime, context),
}));
const mockLoadScriptOutput = jest.fn((request: unknown) => {
  void request;
  return Promise.resolve({ found: false, lines: [] });
});
const mockSaveLocalMemory = jest.fn((request: unknown) => {
  void request;
  return Promise.resolve('saved');
});
jest.mock('../canopy-tools/session-runtime', () => ({
  loadWorktreeScriptOutput: (request: unknown): Promise<unknown> =>
    mockLoadScriptOutput(request),
  saveLocalMemory: (request: unknown): Promise<string> =>
    mockSaveLocalMemory(request),
  searchLocalMemory: (): Promise<string> => Promise.resolve('found'),
  readLocalMemory: (): Promise<string> => Promise.resolve('read'),
  loadGitPreferences: (): Promise<string> => Promise.resolve('prefs'),
  loadWorktreePipelineYaml: (): Promise<unknown> =>
    Promise.resolve({ ok: true }),
  getFileCommentsInSession: (): Promise<unknown> =>
    Promise.resolve({ ok: true, text: '' }),
}));

interface MockSdkTool {
  name: string;
  shape: Record<string, unknown>;
}
const mockSdkTools: MockSdkTool[] = [];
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: (value: unknown): unknown => value,
  tool: (
    name: string,
    _description: string,
    shape: Record<string, unknown>,
  ): MockSdkTool => {
    const entry = { name, shape };
    mockSdkTools.push(entry);
    return entry;
  },
}));

import {
  CANOPY_INJECTED_TOOL_REGISTRY,
  CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS,
  CODE_GRAPH_INJECTED_TOOL_KEYS,
} from '@canopy/desktop-shared/lib/canopy-injected-tools';
import {
  createDelegateCanopyTools,
  delegateAppToolGuidance,
  DELEGATE_SCRIPT_ACTION_TYPES,
  type DelegateCanopyToolScope,
} from '../agents/delegation/canopy-tools';
import { createClaudeDelegateTools } from '../agents/delegation/child-tools';
import {
  createDelegateDeferredToolsSource,
  delegateCapabilityDiscoveryAllowed,
  type DelegateDeferredToolsSource,
} from '../agents/delegation/delegate-deferred-tools';
import type { DeferredToolsReloadSink } from '../deferred-tools/executor';
import { executeLoadDeferredTools } from '../deferred-tools/executor';

type DeferredToolsSourceOverrides = {
  readonly rootAllowed?: () => boolean | undefined;
  readonly grantDiscovery?: () => boolean;
  readonly reload?: DeferredToolsReloadSink;
};

function deferredToolsSource(
  overrides: DeferredToolsSourceOverrides = {},
): DelegateDeferredToolsSource {
  const reload: DeferredToolsReloadSink = overrides.reload ?? {
    request: (): { accepted: true; reloadId: string } => ({
      accepted: true,
      reloadId: 'reload-default',
    }),
  };
  return createDelegateDeferredToolsSource({
    scope: {
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'root-chat',
    },
    providerType: 'claude',
    pluginSelections: (): ChatTabPluginSelections => ({
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    }),
    rootDeferredToolsAllowed: overrides.rootAllowed ?? ((): boolean => true),
    grantDiscovery: overrides.grantDiscovery ?? ((): boolean => true),
    reload,
  });
}

function scope(
  overrides: Partial<DelegateCanopyToolScope> = {},
): DelegateCanopyToolScope {
  return {
    projectId: 'project',
    worktreeId: 'worktree',
    chatId: 'root-chat',
    delegationId: 'delegation',
    provider: 'claude',
    isolated: false,
    parentCwd: '/worktrees/project',
    executionCwd: '/worktrees/project',
    codeGraphAvailable: true,
    getWindow: (): null => null,
    authorizeCommand: (): Promise<boolean> => Promise.resolve(false),
    ...overrides,
  };
}

const WATCHER_TOOL_KEYS = [
  'search_watchers',
  'setup_watchers',
  'watch_github_items',
  'watch_command',
  'schedule_wakeup',
  'delete_watchers',
] as const;

const allow = jest.fn(
  (
    tool: string,
    readOnly: boolean,
    callId: string,
    signal?: AbortSignal,
  ): Promise<boolean> => {
    void tool;
    void readOnly;
    void callId;
    void signal;
    return Promise.resolve(true);
  },
);

beforeEach(() => {
  mockExecute.mockClear();
  mockLoadScriptOutput.mockClear();
  mockSaveLocalMemory.mockClear();
  allow.mockReset().mockResolvedValue(true);
});

describe('managed delegate Canopy tools', () => {
  it('advertises the managed-delegate surface with provider-accurate names', () => {
    const tools = createDelegateCanopyTools(scope(), allow).tools;
    expect(tools.map((tool) => tool.key)).toEqual(
      CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS['managed-delegate'].filter(
        (key): boolean =>
          key !== 'search_deferred_tools' && key !== 'load_deferred_tools',
      ),
    );
    for (const tool of tools) {
      expect(tool.name).toBe(
        CANOPY_INJECTED_TOOL_REGISTRY[tool.key].displayName,
      );
      expect(tool.codexName).toBe(
        CANOPY_INJECTED_TOOL_REGISTRY[tool.key].codexToolName,
      );
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  it('gates deferred tools as read-only', async (): Promise<void> => {
    expect(
      delegateCapabilityDiscoveryAllowed({
        rootDeferredToolsAllowed: (): boolean => true,
        grantDiscovery: (): boolean => true,
      }),
    ).toBe(true);
    expect(
      delegateCapabilityDiscoveryAllowed({
        rootDeferredToolsAllowed: (): boolean => false,
        grantDiscovery: (): boolean => true,
      }),
    ).toBe(false);
    expect(
      delegateCapabilityDiscoveryAllowed({
        rootDeferredToolsAllowed: (): boolean => true,
        grantDiscovery: (): boolean => false,
      }),
    ).toBe(false);
    const deferredKeys = [
      'search_deferred_tools',
      'load_deferred_tools',
    ] as const;
    const absentKeys = createDelegateCanopyTools(scope(), allow).tools.map(
      (tool): CanopyInjectedToolKey => tool.key,
    );
    const deniedKeys = createDelegateCanopyTools(
      scope({
        deferredTools: deferredToolsSource({
          rootAllowed: (): boolean => false,
        }),
      }),
      allow,
    ).tools.map((tool): CanopyInjectedToolKey => tool.key);
    const available = createDelegateCanopyTools(
      scope({ deferredTools: deferredToolsSource() }),
      allow,
    );

    for (const key of deferredKeys) {
      expect(absentKeys).not.toContain(key);
      expect(deniedKeys).not.toContain(key);
      const tool = available.tools.find(
        (candidate): boolean => candidate.key === key,
      );
      if (!tool) throw new Error(`Expected ${key} while discovery is allowed.`);
      expect(tool.readOnly).toBe(true);
      await expect(
        available.authorize(tool, { callId: `authorize-${key}` }),
      ).resolves.toBe(true);
      expect(allow).toHaveBeenCalledWith(
        tool.name,
        true,
        `authorize-${key}`,
        undefined,
      );
    }
  });

  it('rechecks the gate before Load', async (): Promise<void> => {
    let rootAllowed = true;
    const request = jest.fn((): { accepted: true; reloadId: string } => ({
      accepted: true,
      reloadId: 'reload-live-gate',
    }));
    const appTools = createDelegateCanopyTools(
      scope({
        deferredTools: deferredToolsSource({
          rootAllowed: (): boolean => rootAllowed,
          reload: { request },
        }),
      }),
      allow,
    );
    const tool = appTools.toolForClaudeName(
      CANOPY_INJECTED_TOOL_REGISTRY.load_deferred_tools.claudeToolName,
    );
    if (!tool) throw new Error('Expected LoadDeferredTools while allowed.');
    rootAllowed = false;
    mockExecute.mockImplementationOnce(
      (
        key: CanopyInjectedToolKey,
        input: unknown,
        runtime: CanopyInjectedToolRuntime,
        context?: CanopyInjectedToolContext,
      ): Promise<CanopyInjectedToolTextResult> => {
        if (key !== 'load_deferred_tools' || !runtime.deferredToolsRuntime)
          return Promise.resolve({ text: 'tool result' });
        return executeLoadDeferredTools(
          input,
          runtime.deferredToolsRuntime,
          context !== undefined && context.toolUseId !== undefined
            ? { toolUseId: context.toolUseId }
            : undefined,
        );
      },
    );

    const result = await appTools.execute(
      tool,
      { items: [{ ref: 'unused' }] },
      { callId: 'load-after-disable' },
    );

    expect(result).toEqual({
      text: 'Deferred tools are not available for this chat. Instruct user to enable using the plugin picker from the chat composer.',
      isError: true,
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('passes runtime and call id to Load', async (): Promise<void> => {
    const request = jest.fn((): { accepted: true; reloadId: string } => ({
      accepted: true,
      reloadId: 'reload-call-context',
    }));
    const source = deferredToolsSource({ reload: { request } });
    const firstRuntime = source.runtime();
    const secondRuntime = source.runtime();
    expect(firstRuntime).not.toBe(secondRuntime);
    expect(firstRuntime.pluginSelections).not.toBe(
      secondRuntime.pluginSelections,
    );
    const appTools = createDelegateCanopyTools(
      scope({ deferredTools: source }),
      allow,
    );
    const tool = appTools.toolForClaudeName(
      CANOPY_INJECTED_TOOL_REGISTRY.load_deferred_tools.claudeToolName,
    );
    if (!tool) throw new Error('Expected LoadDeferredTools.');

    await appTools.execute(
      tool,
      { items: [{ ref: 'deferred:v1:opaque' }] },
      { callId: 'provider-load-id' },
    );

    const [key, , runtime, context] = mockExecute.mock.calls[0] ?? [];
    expect(key).toBe('load_deferred_tools');
    expect(context).toEqual({ toolUseId: 'provider-load-id' });
    expect(runtime?.deferredToolsRuntime).toMatchObject({
      scope: {
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'root-chat',
      },
      providerType: 'claude',
      allowed: true,
      reloadSink: { request },
    });
  });

  it('guides only children with deferred tools', (): void => {
    const withoutTools = delegateAppToolGuidance(
      createDelegateCanopyTools(scope(), allow),
      'claude',
    );
    const withTools = delegateAppToolGuidance(
      createDelegateCanopyTools(
        scope({ deferredTools: deferredToolsSource() }),
        allow,
      ),
      'codex',
    );

    expect(withoutTools).not.toContain(
      CANOPY_INJECTED_TOOL_REGISTRY.search_deferred_tools.claudeToolName,
    );
    expect(withTools).toContain(
      CANOPY_INJECTED_TOOL_REGISTRY.search_deferred_tools.codexToolName,
    );
    expect(withTools).toContain('Batch multiple queries or items');
    expect(withTools).toContain('at most three loads per run');
  });

  it('limits the action tools to worktree script actions', () => {
    const tools = createDelegateCanopyTools(scope(), allow).tools;
    const dispatch = tools.find((tool) => tool.key === 'dispatch_action');
    expect(dispatch?.description).toContain('worktree.run_script');
    expect(dispatch?.inputSchema).toMatchObject({
      properties: {
        action: {
          properties: {
            type: { enum: [...DELEGATE_SCRIPT_ACTION_TYPES] },
          },
        },
      },
    });
    expect(dispatch?.readOnly).toBe(false);
    expect(tools.find((tool) => tool.key === 'search_actions')?.readOnly).toBe(
      true,
    );
  });

  it('omits the code graph when the workspace does not advertise it', () => {
    const keys = createDelegateCanopyTools(
      scope({ codeGraphAvailable: false }),
      allow,
    ).tools.map((tool) => tool.key);
    for (const key of CODE_GRAPH_INJECTED_TOOL_KEYS)
      expect(keys).not.toContain(key);
    expect(keys).toContain('get_script_output');
  });

  it('tells an isolated child that app tools describe the parent worktree', () => {
    const shared = delegateAppToolGuidance(
      createDelegateCanopyTools(scope(), allow),
      'claude',
    );
    const isolated = delegateAppToolGuidance(
      createDelegateCanopyTools(scope({ isolated: true }), allow),
      'codex',
    );
    expect(shared).toContain('run the parent worktree');
    expect(shared).not.toContain('can differ from this checkout');
    expect(isolated).toContain(
      CANOPY_INJECTED_TOOL_REGISTRY.search_memory.codexToolName,
    );
    expect(isolated).toContain(
      "describe the parent's worktree, which can differ from this checkout",
    );
    expect(isolated).not.toContain('run the parent worktree');
  });

  it('keeps parent-worktree script actions away from an isolated checkout', () => {
    const keys = createDelegateCanopyTools(
      scope({ isolated: true }),
      allow,
    ).tools.map((tool) => tool.key);
    expect(keys).not.toContain('dispatch_action');
    expect(keys).not.toContain('search_actions');
    expect(keys).toContain('search_memory');
  });

  it('resolves Claude MCP and Codex dynamic names to the same tool', () => {
    const delegateTools = createDelegateCanopyTools(scope(), allow);
    const claude = delegateTools.toolForClaudeName(
      CANOPY_INJECTED_TOOL_REGISTRY.get_script_output.claudeToolName,
    );
    const codex = delegateTools.toolForCodexName(
      CANOPY_INJECTED_TOOL_REGISTRY.get_script_output.codexToolName,
    );
    expect(claude?.key).toBe('get_script_output');
    expect(codex).toBe(claude);
    expect(delegateTools.toolForClaudeName('mcp__other__Tool')).toBeUndefined();
    expect(
      delegateTools.toolForCodexName(
        CANOPY_INJECTED_TOOL_REGISTRY.show_files.codexToolName,
      ),
    ).toBeUndefined();
  });

  it.each([false, true])(
    'gives a delegate (isolated: %s) watcher tools that notify the delegated task',
    (isolated) => {
      const tools = createDelegateCanopyTools(scope({ isolated }), allow).tools;
      for (const key of WATCHER_TOOL_KEYS) {
        const tool = tools.find((candidate) => candidate.key === key);
        expect(tool).toBeDefined();
        // Descriptions promise delivery to the calling delegate, never to a
        // chat the delegate is not.
        expect(tool?.description).not.toMatch(/this (same )?chat/i);
        expect(JSON.stringify(tool?.inputSchema)).not.toMatch(/this chat/i);
      }
      for (const key of [
        'setup_watchers',
        'watch_github_items',
        'watch_command',
        'schedule_wakeup',
      ] as const)
        expect(
          tools.find((candidate) => candidate.key === key)?.description,
        ).toContain('this delegated task');
    },
  );

  it('advertises SearchWatchers paging and filters from the shared JSON schema', () => {
    const tool = createDelegateCanopyTools(scope(), allow).tools.find(
      (entry) => entry.key === 'search_watchers',
    );
    expect(tool?.inputSchema).toMatchObject({
      properties: {
        activePageSize: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
          default: 50,
        },
        activeCursor: { type: 'string', minLength: 1, maxLength: 200 },
        activeQuery: { type: 'string', maxLength: 500 },
        targetProjectId: { type: 'string', minLength: 1 },
        targetBotId: { type: 'string', minLength: 1 },
        targetTaskId: { type: 'string', minLength: 1 },
        targetChatId: { type: 'string', minLength: 1 },
        limit: { minimum: 1, maximum: 50 },
      },
    });
  });

  it('uses root-supplied canonical watcher IDs and saved-owner policy without discovery grants', () => {
    const tools = createDelegateCanopyTools(scope(), allow).tools;
    for (const key of ['search_watchers', 'setup_watchers'] as const) {
      const description =
        tools.find((tool) => tool.key === key)?.description ?? '';
      expect(description).toContain('IDs your root supplied');
      expect(description).toContain("root project's saved owner");
      expect(description.split('formerly App Advisor').length - 1).toBe(1);
      expect(description).not.toMatch(
        /any project|in any project|GetCurrentUiState|projects\.list|bots\.list/,
      );
    }
    const setup = tools.find((tool) => tool.key === 'setup_watchers');
    for (const trigger of [
      'project_task_chat_completion',
      'project_new_chat_started',
      'bot_task_chat_completion',
      'bot_new_chat_started',
    ]) {
      expect(setup?.description).toContain(trigger);
      expect(JSON.stringify(setup?.inputSchema)).toContain(trigger);
    }
    expect(setup?.description).toContain('root chat cannot watch itself');
    expect(setup?.description).toContain('own start');
    const searchActions = tools.find((tool) => tool.key === 'search_actions');
    expect(JSON.stringify(searchActions?.inputSchema)).not.toMatch(
      /projects\.list|bots\.list/,
    );
  });

  it('refuses watcher mutations while the parent plans, but not watcher search', () => {
    const tools = createDelegateCanopyTools(scope(), allow).tools;
    const readOnly = new Map(tools.map((tool) => [tool.key, tool.readOnly]));
    expect(readOnly.get('search_watchers')).toBe(true);
    expect(readOnly.get('get_github_pull_request_status')).toBe(true);
    for (const key of [
      'setup_watchers',
      'watch_github_items',
      'watch_command',
      'schedule_wakeup',
      'delete_watchers',
    ] as const)
      expect(readOnly.get(key)).toBe(false);
  });

  it('offers the cached pull request status read, steering waits to WatchGitHubItems', () => {
    const tool = createDelegateCanopyTools(scope(), allow).toolForCodexName(
      CANOPY_INJECTED_TOOL_REGISTRY.get_github_pull_request_status
        .codexToolName,
    );
    expect(tool?.name).toBe('GetGitHubPullRequestStatus');
    expect(tool?.description).toContain('use WatchGitHubItems instead');
    expect(tool?.description).toContain('gh pr checks --watch');
  });

  it('gives a Codex child WatchCommand and script actions, approved per command', () => {
    // Probes and scripts run on the host, outside the Codex child's own
    // sandbox; each is approved as the exact command it runs instead.
    const codex = createDelegateCanopyTools(
      scope({ provider: 'codex' }),
      allow,
    );
    const keys = codex.tools.map((tool) => tool.key);
    expect(keys).toEqual(expect.arrayContaining([...WATCHER_TOOL_KEYS]));
    expect(keys).toEqual(
      expect.arrayContaining(['search_actions', 'dispatch_action']),
    );
    expect(
      codex.toolForCodexName(
        CANOPY_INJECTED_TOOL_REGISTRY.watch_command.codexToolName,
      )?.key,
    ).toBe('watch_command');
    expect(
      codex.toolForCodexName(
        CANOPY_INJECTED_TOOL_REGISTRY.dispatch_action.codexToolName,
      )?.key,
    ).toBe('dispatch_action');
  });

  it.each(['claude', 'codex'] as const)(
    'approves a %s delegate script run as the command it will run',
    async (provider) => {
      const authorizeCommand = jest.fn(
        (command: string, callId: string, signal?: AbortSignal) => {
          void command;
          void callId;
          void signal;
          return Promise.resolve(true);
        },
      );
      const delegateTools = createDelegateCanopyTools(
        scope({ provider, authorizeCommand }),
        allow,
      );
      const tool = delegateTools.toolForCodexName(
        CANOPY_INJECTED_TOOL_REGISTRY.dispatch_action.codexToolName,
      );
      if (!tool) throw new Error('Expected DispatchAction');
      await delegateTools.execute(
        tool,
        { action: { type: 'worktree.run_script', scriptId: 'test' } },
        { callId: `call-script-${provider}` },
      );
      const [, , runtime] = mockExecute.mock.calls[0] ?? [];
      expect(runtime?.worktreeActionRuntime).toBeDefined();
      await expect(
        runtime?.worktreeActionRuntime?.authorizeScriptCommand?.('npm test'),
      ).resolves.toBe(true);
      expect(authorizeCommand).toHaveBeenCalledWith(
        'npm test',
        `call-script-${provider}`,
        undefined,
      );
    },
  );

  it('tells the child that watcher notifications resume it', () => {
    const guidance = delegateAppToolGuidance(
      createDelegateCanopyTools(scope(), allow),
      'claude',
    );
    expect(guidance).toContain(
      CANOPY_INJECTED_TOOL_REGISTRY.schedule_wakeup.displayName,
    );
    expect(guidance).toContain('notify this delegated task');
    expect(guidance).toContain('resumes');
  });

  it('builds a Claude MCP schema for every delegate app tool', () => {
    mockSdkTools.length = 0;
    const appTools = createDelegateCanopyTools(scope(), allow);
    const server = createClaudeDelegateTools({ namespace: 'canopy', appTools });
    expect(server).toBeDefined();
    expect(mockSdkTools.map((entry) => entry.name)).toEqual(
      appTools.tools.map((tool) => tool.name),
    );
    const watchCommand = mockSdkTools.find(
      (entry) =>
        entry.name === CANOPY_INJECTED_TOOL_REGISTRY.watch_command.displayName,
    );
    expect(Object.keys(watchCommand?.shape ?? {})).toEqual(
      expect.arrayContaining(['command', 'intervalSeconds', 'maxAttempts']),
    );
  });

  it('binds watchers to the delegate recipient and its own working directory', async () => {
    const isolatedCwd = '/data/worktree-data/delegation/worktrees/delegation';
    const delegateTools = createDelegateCanopyTools(
      scope({
        isolated: true,
        executionCwd: isolatedCwd,
        delegationDescription: 'Review auth flow',
        delegationDepth: 2,
      }),
      allow,
    );
    const tool = delegateTools.toolForCodexName(
      CANOPY_INJECTED_TOOL_REGISTRY.watch_command.codexToolName,
    );
    if (!tool) throw new Error('Expected WatchCommand');
    await delegateTools.execute(
      tool,
      { command: 'test -f done', intervalSeconds: 5, maxAttempts: 3 },
      { callId: 'call-watch' },
    );
    const [key, , runtime] = mockExecute.mock.calls[0] ?? [];
    expect(key).toBe('watch_command');
    expect(runtime?.worktreeWatcherRuntime).toEqual({
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'root-chat',
      delegationId: 'delegation',
      // Display-only: the user's watcher list names the owning delegate.
      delegationDescription: 'Review auth flow',
      delegationDepth: 2,
      cwd: isolatedCwd,
    });
    // The watcher cwd does not give an isolated checkout the parent
    // worktree's script actions.
    expect(runtime?.worktreeActionRuntime).toBeUndefined();
  });

  it('approves a delegate WatchCommand as the command it will run', async () => {
    const authorizeCommand = jest.fn(
      (command: string, callId: string, signal?: AbortSignal) => {
        void command;
        void callId;
        void signal;
        return Promise.resolve(true);
      },
    );
    const delegateTools = createDelegateCanopyTools(
      scope({ authorizeCommand }),
      allow,
    );
    const tool = delegateTools.toolForClaudeName(
      CANOPY_INJECTED_TOOL_REGISTRY.watch_command.claudeToolName,
    );
    if (!tool) throw new Error('Expected WatchCommand');
    await delegateTools.execute(
      tool,
      { command: 'test -f done', intervalSeconds: 5, maxAttempts: 3 },
      { callId: 'call-watch' },
    );
    // One approval for the command itself, as for a parent chat. The
    // tool-identity approval would approve any command.
    expect(allow).not.toHaveBeenCalled();
    const [, , runtime] = mockExecute.mock.calls[0] ?? [];
    await expect(
      runtime?.authorizeWatchCommand?.({
        command: 'test -f done',
        intervalSeconds: 5,
        maxAttempts: 3,
      }),
    ).resolves.toBe(true);
    expect(authorizeCommand).toHaveBeenCalledWith(
      'test -f done',
      'call-watch',
      undefined,
    );

    // Other watcher tools keep the app-tool approval.
    const wakeup = delegateTools.toolForClaudeName(
      CANOPY_INJECTED_TOOL_REGISTRY.schedule_wakeup.claudeToolName,
    );
    if (!wakeup) throw new Error('Expected ScheduleWakeup');
    await delegateTools.execute(
      wakeup,
      { delaySeconds: 60 },
      { callId: 'call-wake' },
    );
    expect(allow).toHaveBeenCalledWith(
      'ScheduleWakeup',
      false,
      'call-wake',
      undefined,
    );
  });

  it('asks the parent approval policy before running a tool and runs nothing when denied', async () => {
    allow.mockResolvedValueOnce(false);
    const delegateTools = createDelegateCanopyTools(scope(), allow);
    const tool = delegateTools.toolForCodexName(
      CANOPY_INJECTED_TOOL_REGISTRY.save_memory.codexToolName,
    );
    if (!tool) throw new Error('Expected SaveMemory');
    const result = await delegateTools.execute(
      tool,
      { text: 'Remember this', scope: 'workspace' },
      { callId: 'call-1' },
    );
    expect(allow).toHaveBeenCalledWith(
      'SaveMemory',
      false,
      'call-1',
      undefined,
    );
    expect(result).toMatchObject({ isError: true });
    expect(result.text).toContain('denied');
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('runs approved tools with a delegate-scoped runtime', async () => {
    const delegateTools = createDelegateCanopyTools(scope(), allow);
    const tool = delegateTools.toolForCodexName(
      CANOPY_INJECTED_TOOL_REGISTRY.dispatch_action.codexToolName,
    );
    if (!tool) throw new Error('Expected DispatchAction');
    await expect(
      delegateTools.execute(
        tool,
        { action: { type: 'worktree.list_scripts' } },
        { callId: 'call-2' },
      ),
    ).resolves.toEqual({ text: 'tool result' });
    const [key, input, runtime, context] = mockExecute.mock.calls[0] ?? [];
    expect(key).toBe('dispatch_action');
    expect(input).toEqual({ action: { type: 'worktree.list_scripts' } });
    expect(context).toEqual({ toolUseId: 'call-2' });
    expect(runtime?.worktreeActionRuntime).toMatchObject({
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'root-chat',
      cwd: '/worktrees/project',
      allowedActionTypes: [...DELEGATE_SCRIPT_ACTION_TYPES],
    });
    // Watchers notify this delegate: the root chat identifies the watcher's
    // scope and the delegation id identifies its recipient.
    expect(runtime?.worktreeWatcherRuntime).toEqual({
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'root-chat',
      delegationId: 'delegation',
      cwd: '/worktrees/project',
    });
    // Chat-bound UI capabilities are never wired into a delegate runtime.
    expect(runtime?.showFiles).toBeUndefined();
    expect(runtime?.respondToFileComment).toBeUndefined();
    expect(runtime?.setAutoArchiveForCurrentChat).toBeUndefined();
    expect(runtime?.deferredToolsRuntime).toBeUndefined();
    await runtime?.loadScriptOutput({ scriptId: 'test' });
    expect(mockLoadScriptOutput).toHaveBeenCalledWith({
      projectId: 'project',
      worktreeId: 'worktree',
      scriptId: 'test',
    });
    await runtime?.saveLocalMemory?.({ text: 'Lesson', scope: 'workspace' });
    expect(mockSaveLocalMemory).toHaveBeenCalledWith({
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'root-chat',
      provider: 'claude',
      sessionId: 'delegation:delegation',
      text: 'Lesson',
      scope: 'workspace',
    });
  });

  it('passes raw canonical batches to the shared validator with trusted delegate identity', async () => {
    const setupCanonical = jest
      .fn()
      .mockResolvedValue({ ok: true, results: [] });
    jest.doMock('../app-advisor/watchers', (): object => ({
      getAppAdvisorWatcherService: () => ({
        setupCanonicalChatWatchers: setupCanonical,
      }),
    }));
    try {
      const direct = jest.requireActual<typeof CanopyCoreModule>(
        '../canopy-tools/core',
      ).executeCanopyInjectedTool;
      const tools = createDelegateCanopyTools(scope(), allow);
      const tool = tools.toolForCodexName(
        CANOPY_INJECTED_TOOL_REGISTRY.setup_watchers.codexToolName,
      );
      if (!tool) throw new Error('Expected SetupWatchers');
      const canonical = {
        trigger: 'project_task_chat_completion',
        target: {
          projectId: 'target-project',
          taskId: 'target-task',
          chatId: 'target-chat',
        },
        armForNextCompletion: true,
      };
      mockExecute.mockImplementationOnce(direct);
      expect(
        (
          await tools.execute(
            tool,
            { watchers: [canonical] },
            { callId: 'canonical-call' },
          )
        ).isError,
      ).toBe(false);
      expect(setupCanonical).toHaveBeenCalledWith({
        createdByToolUseId: 'canonical-call',
        destination: {
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'root-chat',
          delegationId: 'delegation',
        },
        recipient: { kind: 'delegate', delegationId: 'delegation' },
        watchers: [canonical],
      });
      setupCanonical.mockClear();
      for (const args of [
        { watchers: [canonical], destination: { chatId: 'forged' } },
        {
          watchers: [
            {
              ...canonical,
              target: { ...canonical.target, kind: 'project_task_chat' },
            },
          ],
        },
        {
          watchers: [
            { target: { executionId: 'e' } },
            { ...canonical, owner: 'forged' },
          ],
        },
      ]) {
        mockExecute.mockImplementationOnce(direct);
        const result = await tools.execute(tool, args, {
          callId: 'invalid-canonical-call',
        });
        expect(result.isError).toBe(true);
        expect(result.text).toContain('Invalid arguments');
      }
      expect(setupCanonical).not.toHaveBeenCalled();
    } finally {
      jest.dontMock('../app-advisor/watchers');
    }
  });

  it('rejects a tool that this delegate does not advertise', async () => {
    const delegateTools = createDelegateCanopyTools(
      scope({ isolated: true }),
      allow,
    );
    const result = await delegateTools.execute(
      {
        key: 'dispatch_action',
        name: 'DispatchAction',
        codexName: 'canopy_dispatch_action',
        description: '',
        inputSchema: {},
        readOnly: false,
      },
      { action: { type: 'worktree.run_script', scriptId: 'setup' } },
      { callId: 'call-3' },
    );
    expect(result).toMatchObject({ isError: true });
    expect(allow).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });
});
