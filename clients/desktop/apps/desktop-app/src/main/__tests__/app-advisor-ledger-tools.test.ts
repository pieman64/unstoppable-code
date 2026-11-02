/**
 * Agent Ledger tools in App Advisor Work Entry chats (phase 06). App Advisor
 * advertises AddFeedEntry, SearchFeedEntries and UpdateFeedEntry under
 * its own tool names, only to a session whose Ledger exposure gate passed when
 * it started, and every call stays bound to the Work Entry that session
 * started in. These tests pin the Advisor names, the Codex dynamic tools, the
 * Claude HTTP MCP route, the prompt and hint wording, and that binding.
 */
import { createServer, type Server } from 'node:http';
import type { LedgerContainer } from '@canopy/protocol/canopy-core';
import { BRAND } from '@canopy/brand/current';
import {
  APP_ADVISOR_TOOL_ENTRIES,
  APP_ADVISOR_TOOL_KEYS,
  APP_ADVISOR_TOOL_REGISTRY,
  getAppAdvisorLedgerToolNames,
  getCanonicalAppAdvisorToolKey,
  isAppAdvisorLedgerToolKey,
  type AppAdvisorToolKey,
} from '@canopy/desktop-shared/lib/app-advisor-tools';
import { getCanonicalCanopyToolKey } from '@canopy/desktop-shared/lib/canopy-injected-tools';
import type {
  AppAdvisorWindowUiState,
  WorkspaceType,
} from '@canopy/desktop-shared/types';
import type { DynamicToolSpec } from '@canopy/desktop-shared/node/codex-runtime/generated/v2/DynamicToolSpec';
import {
  buildAppAdvisorDynamicToolSpecs,
  handleAppAdvisorDynamicToolCall,
} from '../app-advisor/codex-dynamic-tools';
import { executeAppAdvisorTool } from '../app-advisor/tool-executor';
import { setLatestAppAdvisorWindowUiState } from '../app-advisor/window-ui-state';
import {
  addLedgerEntryJsonSchema,
  searchLedgerEntriesJsonSchema,
  updateLedgerEntryJsonSchema,
} from '../canopy-tools/definitions';
import {
  openLedgerChatTools,
  type LedgerChatSettings,
  type LedgerChatTarget,
  type LedgerToolsDispatcher,
  type LedgerToolsHost,
  type LedgerToolsRuntime,
} from '../canopy-tools/ledger-tools-runtime';
import type { CanopyInjectedToolTextResult } from '../canopy-tools/core';
import { createDesktopRuntime } from '../canopy-runtime/desktop-runtime';
import { buildCodexSessionDynamicToolSpecs } from '../codex/session-dynamic-tools';
import type { LedgerCallerBindingRegistration } from '../ledger/caller-bindings';
import {
  createLedgerServiceHarness,
  type LedgerServiceHarness,
} from '../ledger/__tests__/fixtures/in-process-ledger-store-client';
import { McpHttpProxyService } from '../mcp/http-proxy-service';
import { createAppAdvisorRuntimeFixture } from './fixtures/app-advisor-runtime';

jest.mock('../feature-flags', (): unknown => ({
  getFeatureFlagService: (): {
    isEnabled: () => boolean;
    getSnapshot: () => { values: Record<string, unknown> };
  } => ({
    isEnabled: (): boolean => true,
    getSnapshot: (): { values: Record<string, unknown> } => ({ values: {} }),
  }),
}));

const NAMESPACE = BRAND.tools.namespace;
const LEDGER_KEYS = [
  'add_ledger_entry',
  'search_ledger_entries',
  'update_ledger_entry',
] as const;
const LEDGER_DISPLAY_NAMES = [
  'AddFeedEntry',
  'SearchFeedEntries',
  'UpdateFeedEntry',
];
const ADVISOR_CLAUDE_LEDGER_NAMES = LEDGER_DISPLAY_NAMES.map(
  (name) => `mcp__${NAMESPACE}_app_advisor__${name}`,
);
const ADVISOR_CODEX_LEDGER_NAMES = [
  'add_feed_entry',
  'search_feed_entries',
  'update_feed_entry',
].map((suffix) => `${NAMESPACE}_app_advisor_${suffix}`);
/** App Advisor's own tools, which the Ledger tools must leave unchanged. */
const ADVISOR_OWN_TOOL_KEYS: readonly AppAdvisorToolKey[] = [
  'ask_user_question',
  'get_script_output',
  'read_pipeline_yaml',
  'show_files',
  'show_capabilities',
  'get_file_comments',
  'respond_to_file_comment',
  'search_actions',
  'get_current_ui_state',
  'dispatch_action',
  'get_pipeline_debug_context',
  'search_watchers',
  'setup_watchers',
  'watch_github_items',
  'get_github_pull_request_status',
  'watch_command',
  'schedule_wakeup',
  'set_auto_archive',
  'start_forked_agent',
  'search_deferred_tools',
  'load_deferred_tools',
];

const ENTRY_A = 'entry-a';
const ENTRY_B = 'entry-b';
const ADVISOR_CHAT = 'advisor-chat';
const ENTRY_CREATED_AT = '2026-09-20T09:00:00.000Z';
const SETTINGS: LedgerChatSettings = {
  model: 'claude-sonnet',
  thinkingEffort: 'medium',
  planMode: false,
};
const DEFAULT_WINDOW_UI_STATE: AppAdvisorWindowUiState = {
  activeWorkEntryId: null,
  activeChatId: null,
  navCollapsed: false,
  settingsModalOpen: false,
  archivedOverviewOpen: false,
  archivedOverviewWorkspaceId: null,
  emptyTrashConfirmationOpen: false,
  emptyTrashRunning: false,
  lastArchivedOverviewRequestId: null,
  lastArchivedOverviewConfirmationOpened: null,
};

function advisorTarget(
  entryId: string,
  chatId = ADVISOR_CHAT,
): LedgerChatTarget {
  return {
    projectId: 'app-advisor',
    worktreeId: entryId,
    chatId,
    assistantMode: 'app-advisor',
  };
}

function advisorContainer(entryId: string): LedgerContainer {
  return { kind: 'advisor_entry', appWorkspaceId: 'app-advisor', entryId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function functionSpecNames(specs: readonly DynamicToolSpec[]): string[] {
  return specs.map((spec) => spec.name);
}

function functionSpec(
  specs: readonly DynamicToolSpec[],
  name: string,
): DynamicToolSpec | undefined {
  return specs.find((spec) => spec.name === name);
}

function fakeLedgerRuntime(): {
  execute: jest.Mock<
    Promise<CanopyInjectedToolTextResult>,
    Parameters<LedgerToolsRuntime['execute']>
  >;
} {
  return {
    execute: jest.fn<
      Promise<CanopyInjectedToolTextResult>,
      Parameters<LedgerToolsRuntime['execute']>
    >(() => Promise.resolve({ text: '{"ok":true}' })),
  };
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address === 'string' || address === null) {
        reject(new Error('Expected TCP server address.'));
        return;
      }
      resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function getFreePort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

function listedToolNames(payload: unknown): string[] {
  if (!isRecord(payload) || !isRecord(payload.result)) return [];
  const tools = payload.result.tools;
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((tool) =>
    isRecord(tool) && typeof tool.name === 'string' ? [tool.name] : [],
  );
}

function listedTool(
  payload: unknown,
  name: string,
): Record<string, unknown> | undefined {
  if (!isRecord(payload) || !isRecord(payload.result)) return undefined;
  const tools = payload.result.tools;
  if (!Array.isArray(tools)) return undefined;
  return tools.filter(isRecord).find((tool) => tool.name === name);
}

/** The text of a `tools/call` result, parsed as JSON. */
function callResultJson(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload) || !isRecord(payload.result)) {
    throw new Error('Expected a tools/call result');
  }
  const content = payload.result.content;
  const first: unknown = Array.isArray(content) ? content[0] : undefined;
  if (!isRecord(first) || typeof first.text !== 'string') {
    throw new Error('Expected text content');
  }
  const parsed: unknown = JSON.parse(first.text);
  if (!isRecord(parsed)) throw new Error('Expected a JSON object result');
  return parsed;
}

describe('App Advisor Ledger tool registry', () => {
  it('names the Ledger tools on App Advisor surfaces for Claude and Codex', () => {
    expect(
      LEDGER_KEYS.map((key) => APP_ADVISOR_TOOL_REGISTRY[key].claudeToolName),
    ).toEqual(ADVISOR_CLAUDE_LEDGER_NAMES);
    expect(
      LEDGER_KEYS.map((key) => APP_ADVISOR_TOOL_REGISTRY[key].codexToolName),
    ).toEqual(ADVISOR_CODEX_LEDGER_NAMES);
    expect(
      LEDGER_KEYS.map((key) => APP_ADVISOR_TOOL_REGISTRY[key].displayName),
    ).toEqual(LEDGER_DISPLAY_NAMES);
    expect(getAppAdvisorLedgerToolNames('claude')).toEqual({
      add: ADVISOR_CLAUDE_LEDGER_NAMES[0],
      search: ADVISOR_CLAUDE_LEDGER_NAMES[1],
      update: ADVISOR_CLAUDE_LEDGER_NAMES[2],
    });
    expect(getAppAdvisorLedgerToolNames('codex')).toEqual({
      add: ADVISOR_CODEX_LEDGER_NAMES[0],
      search: ADVISOR_CODEX_LEDGER_NAMES[1],
      update: ADVISOR_CODEX_LEDGER_NAMES[2],
    });
  });

  it('resolves the Advisor names to App Advisor keys and never to injected Code and Cowork tools', () => {
    const cases = LEDGER_KEYS.map((key, index) => ({
      key,
      claudeName: ADVISOR_CLAUDE_LEDGER_NAMES[index],
      codexName: ADVISOR_CODEX_LEDGER_NAMES[index],
    }));
    for (const { key, claudeName, codexName } of cases) {
      expect(getCanonicalAppAdvisorToolKey(claudeName)).toBe(key);
      expect(getCanonicalAppAdvisorToolKey(codexName)).toBe(key);
      expect(getCanonicalCanopyToolKey(claudeName)).toBeNull();
      expect(getCanonicalCanopyToolKey(codexName)).toBeNull();
      expect(isAppAdvisorLedgerToolKey(key)).toBe(true);
    }
    // The Code and Cowork chat names stay out of the Advisor registry.
    expect(
      getCanonicalAppAdvisorToolKey(`mcp__${NAMESPACE}__AddFeedEntry`),
    ).toBeNull();
    expect(
      getCanonicalAppAdvisorToolKey(`${NAMESPACE}_add_feed_entry`),
    ).toBeNull();
  });

  it('adds only the three Ledger tools and keeps the Advisor tools unchanged', () => {
    expect(APP_ADVISOR_TOOL_KEYS).toEqual([
      ...ADVISOR_OWN_TOOL_KEYS,
      ...LEDGER_KEYS,
    ]);
    expect(APP_ADVISOR_TOOL_ENTRIES.map((entry) => entry.canonicalKey)).toEqual(
      APP_ADVISOR_TOOL_KEYS,
    );
    for (const key of ADVISOR_OWN_TOOL_KEYS) {
      expect(isAppAdvisorLedgerToolKey(key)).toBe(false);
    }
  });
});

describe('App Advisor Codex Ledger dynamic tools', () => {
  it('advertises the Advisor Ledger tools only to an exposed session', () => {
    const hidden = functionSpecNames(buildAppAdvisorDynamicToolSpecs());
    const exposed = functionSpecNames(
      buildAppAdvisorDynamicToolSpecs({ includeLedger: true }),
    );
    const ownNames = ADVISOR_OWN_TOOL_KEYS.map(
      (key) => APP_ADVISOR_TOOL_REGISTRY[key].codexToolName,
    );

    expect(hidden).toEqual(ownNames);
    expect(exposed).toEqual([...ownNames, ...ADVISOR_CODEX_LEDGER_NAMES]);
    // Never the Code and Cowork chat names, and never the whole injected set.
    expect(exposed).not.toContain(`${NAMESPACE}_add_feed_entry`);
    expect(exposed).not.toContain(`${NAMESPACE}_get_git_preferences`);
  });

  it('builds the App Advisor session tools from the exposure decision', () => {
    const base = {
      assistantMode: 'app-advisor' as const,
      workspaceMode: 'worktree' as const,
      isPlanExplore: false,
      isCodeReview: false,
      includeCodeGraph: true,
      includeChatVisuals: false,
      toolSchemaProfile: 'standard' as const,
    };

    expect(
      functionSpecNames(
        buildCodexSessionDynamicToolSpecs({ ...base, includeLedger: true }),
      ),
    ).toEqual(expect.arrayContaining(ADVISOR_CODEX_LEDGER_NAMES));
    for (const includeLedger of [false, undefined]) {
      const names = functionSpecNames(
        buildCodexSessionDynamicToolSpecs({
          ...base,
          ...(includeLedger === undefined ? {} : { includeLedger }),
        }),
      );
      for (const name of ADVISOR_CODEX_LEDGER_NAMES) {
        expect(names).not.toContain(name);
      }
    }
  });

  it('reuses the Ledger input schemas and names the Advisor search tool', () => {
    const specs = buildAppAdvisorDynamicToolSpecs({ includeLedger: true });
    const [add, search, update] = ADVISOR_CODEX_LEDGER_NAMES.map((name) =>
      functionSpec(specs, name),
    );

    expect(add).toMatchObject({
      type: 'function',
      inputSchema: addLedgerEntryJsonSchema,
    });
    expect(search).toMatchObject({
      type: 'function',
      inputSchema: searchLedgerEntriesJsonSchema,
    });
    expect(update).toMatchObject({
      type: 'function',
      inputSchema: updateLedgerEntryJsonSchema,
    });
    for (const spec of [add, update]) {
      const description =
        spec?.type === 'function' ? spec.description : undefined;
      expect(description).toContain(ADVISOR_CODEX_LEDGER_NAMES[1]);
      expect(description).not.toContain(`${NAMESPACE}_search_feed_entries`);
    }
  });

  it('runs a Codex Ledger call on the session runtime with the Codex invocation', async () => {
    const ledgerRuntime = fakeLedgerRuntime();
    const args = { type: 'TASK', title: 'Plan', content: 'Plan the work.' };

    const response = await handleAppAdvisorDynamicToolCall(
      {
        threadId: 'thread',
        turnId: 'turn',
        callId: 'call',
        namespace: null,
        tool: ADVISOR_CODEX_LEDGER_NAMES[0],
        arguments: args,
      },
      createAppAdvisorRuntimeFixture(),
      { ledgerRuntime },
    );

    expect(ledgerRuntime.execute).toHaveBeenCalledWith(
      'add_ledger_entry',
      args,
      { invocationId: 'codex:thread:turn:call' },
    );
    expect(response).toEqual({
      contentItems: [{ type: 'inputText', text: '{"ok":true}' }],
      success: true,
    });
  });

  it('answers a Codex Ledger call without a Ledger runtime with no_ledger_scope', async () => {
    const response = await handleAppAdvisorDynamicToolCall(
      {
        threadId: 'thread',
        turnId: 'turn',
        callId: 'call',
        namespace: null,
        tool: ADVISOR_CODEX_LEDGER_NAMES[1],
        arguments: {},
      },
      createAppAdvisorRuntimeFixture(),
    );

    expect(response.success).toBe(false);
    expect(JSON.stringify(response.contentItems)).toContain('no_ledger_scope');
  });

  it('answers a direct Advisor Ledger call without a Ledger runtime with no_ledger_scope', async () => {
    const result = await executeAppAdvisorTool(
      'update_ledger_entry',
      {},
      createAppAdvisorRuntimeFixture(),
      { toolUseId: 'tool-1' },
    );

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.text)).toMatchObject({
      ok: false,
      error: { code: 'FEED_UNAVAILABLE', reason: 'no_ledger_scope' },
    });
  });
});

describe('App Advisor Claude Ledger route', () => {
  let service: McpHttpProxyService;
  let harness: LedgerServiceHarness;
  let dispatcher: ReturnType<typeof createDesktopRuntime>;
  let registrations: LedgerCallerBindingRegistration[];
  let gate: { flag: boolean; recording: boolean };
  let host: LedgerToolsHost;
  const disposers: Array<() => void> = [];

  async function registerAdvisorRoute(
    sessionKey: string,
    options: {
      readonly entryId?: string;
      readonly ledgerTools?: LedgerToolsRuntime;
      readonly authorizeToolCall?: jest.Mock<Promise<boolean>, [string]>;
    } = {},
  ): Promise<string> {
    await service.registerCanopyWorktreeSessionRoute({
      sessionKey,
      projectId: 'app-advisor',
      worktreeId: options.entryId ?? ENTRY_A,
      chatId: ADVISOR_CHAT,
      assistantMode: 'app-advisor',
      cwd: '/advisor/home',
      sdkSessionId: `${sessionKey}-sdk`,
      providerType: 'claude',
      authToken: `${sessionKey}-token`,
      createdAt: Date.now(),
      hookHandler: jest.fn(),
      appAdvisorRuntime: createAppAdvisorRuntimeFixture(),
      ...(options.ledgerTools ? { ledgerTools: options.ledgerTools } : {}),
      ...(options.authorizeToolCall
        ? { authorizeToolCall: options.authorizeToolCall }
        : {}),
    });
    return sessionKey;
  }

  async function rpc(
    sessionKey: string,
    body: Record<string, unknown>,
    server: 'main' | 'ui' = 'main',
  ): Promise<unknown> {
    const url =
      server === 'main'
        ? service.getCanopyWorktreeMcpUrl(sessionKey)
        : service.getCanopyWorktreeUiMcpUrl(sessionKey);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sessionKey}-token`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', ...body }),
    });
    const payload: unknown = await response.json();
    return payload;
  }

  async function openAdvisorLedger(
    entryId: string,
    chatId = ADVISOR_CHAT,
  ): Promise<NonNullable<Awaited<ReturnType<typeof openLedgerChatTools>>>> {
    const session = await openLedgerChatTools({
      target: advisorTarget(entryId, chatId),
      harness: 'claude',
      toolNames: getAppAdvisorLedgerToolNames('claude'),
      readSettings: (): LedgerChatSettings => SETTINGS,
      host,
    });
    if (session === null) throw new Error('Expected exposed Ledger tools');
    disposers.push(() => session.dispose());
    return session;
  }

  beforeEach(async () => {
    harness = createLedgerServiceHarness();
    dispatcher = createDesktopRuntime({
      services: {
        listFileTreeRoots: (): Promise<{ roots: [] }> =>
          Promise.resolve({ roots: [] }),
        listFileTreeDirectory: (): Promise<{ entries: [] }> =>
          Promise.resolve({ entries: [] }),
      },
      ledgerService: harness.service,
    });
    registrations = [];
    gate = { flag: true, recording: true };
    host = {
      dispatcher: (): LedgerToolsDispatcher => dispatcher,
      registry: (): {
        register: (registration: LedgerCallerBindingRegistration) => string;
        resolve: (bindingId: string) => unknown;
        revoke: (bindingId: string) => boolean;
      } => ({
        register: (registration): string => {
          registrations.push(registration);
          return harness.bindings.register(registration);
        },
        resolve: (bindingId): unknown => harness.bindings.resolve(bindingId),
        revoke: (bindingId): boolean => harness.bindings.revoke(bindingId),
      }),
      isFlagEnabled: (): boolean => gate.flag,
      isRecordingEnabled: (): Promise<boolean> =>
        Promise.resolve(gate.recording),
      workspaceType: (): WorkspaceType | null => null,
      containerCreatedAt: (): Promise<string | null> =>
        Promise.resolve(ENTRY_CREATED_AT),
      chatTitle: (): Promise<string | null> => Promise.resolve('Advisor chat'),
      databaseMayExist: (): Promise<boolean> => Promise.resolve(true),
    };
    for (const entryId of [ENTRY_A, ENTRY_B]) {
      harness.setLiveChats(advisorContainer(entryId), [
        { chatId: ADVISOR_CHAT, title: 'Advisor chat', createdAt: null },
      ]);
    }
    setLatestAppAdvisorWindowUiState(DEFAULT_WINDOW_UI_STATE);
    service = new McpHttpProxyService();
    await service.ensureStarted(await getFreePort());
  });

  afterEach(async () => {
    for (const dispose of disposers.splice(0)) dispose();
    setLatestAppAdvisorWindowUiState(DEFAULT_WINDOW_UI_STATE);
    await service.shutdown();
    await dispatcher.shutdown();
    harness.dispose();
  });

  it('lists the Ledger tools on the Advisor server only for a session with Ledger tools', async () => {
    const exposed = await registerAdvisorRoute('advisor-exposed', {
      ledgerTools: fakeLedgerRuntime(),
    });
    const hidden = await registerAdvisorRoute('advisor-hidden');

    const exposedList = await rpc(exposed, { id: 1, method: 'tools/list' });
    const hiddenNames = listedToolNames(
      await rpc(hidden, { id: 2, method: 'tools/list' }),
    );
    const uiNames = listedToolNames(
      await rpc(exposed, { id: 3, method: 'tools/list' }, 'ui'),
    );

    expect(listedToolNames(exposedList)).toEqual(
      expect.arrayContaining([
        ...LEDGER_DISPLAY_NAMES,
        'SearchActions',
        'DispatchAction',
      ]),
    );
    for (const name of LEDGER_DISPLAY_NAMES) {
      expect(hiddenNames).not.toContain(name);
      expect(uiNames).not.toContain(name);
    }
    expect(hiddenNames).toEqual(
      expect.arrayContaining(['SearchActions', 'DispatchAction']),
    );
    expect(uiNames).toEqual(['AskUserQuestion']);
    expect(listedTool(exposedList, 'AddFeedEntry')).toMatchObject({
      inputSchema: addLedgerEntryJsonSchema,
    });
    expect(listedTool(exposedList, 'UpdateFeedEntry')).toMatchObject({
      inputSchema: updateLedgerEntryJsonSchema,
    });
  });

  it('runs a Ledger call on the session runtime with the Claude tool use ID', async () => {
    const ledgerTools = fakeLedgerRuntime();
    const sessionKey = await registerAdvisorRoute('advisor-call', {
      ledgerTools,
    });
    const args = { type: 'TASK', title: 'Plan', content: 'Plan the work.' };

    const payload = await rpc(sessionKey, {
      id: 8,
      method: 'tools/call',
      params: {
        name: 'AddFeedEntry',
        arguments: args,
        _meta: { 'claudecode/toolUseId': 'toolu_advisor' },
      },
    });

    expect(callResultJson(payload)).toEqual({ ok: true });
    expect(ledgerTools.execute).toHaveBeenCalledWith('add_ledger_entry', args, {
      invocationId: 'claude:toolu_advisor',
    });
  });

  it('falls back to a per-route invocation ID when the CLI sends no tool use ID', async () => {
    const ledgerTools = fakeLedgerRuntime();
    const first = await registerAdvisorRoute('advisor-fallback-a', {
      ledgerTools,
    });
    const second = await registerAdvisorRoute('advisor-fallback-b', {
      ledgerTools,
    });
    const search = (sessionKey: string, id: number): Promise<unknown> =>
      rpc(sessionKey, {
        id,
        method: 'tools/call',
        params: { name: 'SearchFeedEntries', arguments: {} },
      });

    await search(first, 1);
    await search(first, 2);
    await search(second, 1);

    const ids = ledgerTools.execute.mock.calls.map(
      ([, , invocation]) => invocation?.invocationId,
    );
    expect(ids).toHaveLength(3);
    for (const id of ids) {
      expect(id).toEqual(expect.stringMatching(/^mcp:/));
    }
    expect(new Set(ids).size).toBe(3);
  });

  it('answers no_ledger_scope for a Ledger call on a session without Ledger tools', async () => {
    // A route gate (Cursor installs one) is never asked about a call that
    // cannot run.
    const authorizeToolCall = jest.fn<Promise<boolean>, [string]>(() =>
      Promise.resolve(true),
    );
    const sessionKey = await registerAdvisorRoute('advisor-no-ledger', {
      authorizeToolCall,
    });

    const payload = await rpc(sessionKey, {
      id: 9,
      method: 'tools/call',
      params: {
        name: 'AddFeedEntry',
        arguments: { type: 'TASK', title: 'T', content: 'C' },
      },
    });

    expect(payload).toMatchObject({ result: { isError: true } });
    expect(callResultJson(payload)).toMatchObject({
      ok: false,
      error: { code: 'FEED_UNAVAILABLE', reason: 'no_ledger_scope' },
    });
    expect(authorizeToolCall).not.toHaveBeenCalled();
    expect(registrations).toEqual([]);
  });

  it('asks the route gate about a Ledger call and runs nothing it denies', async () => {
    const ledgerTools = fakeLedgerRuntime();
    const authorizeToolCall = jest.fn<Promise<boolean>, [string]>(() =>
      Promise.resolve(false),
    );
    const sessionKey = await registerAdvisorRoute('advisor-gated', {
      ledgerTools,
      authorizeToolCall,
    });

    const payload = await rpc(sessionKey, {
      id: 10,
      method: 'tools/call',
      params: {
        name: 'UpdateFeedEntry',
        arguments: { entryId: 'entry-1', expectedRevision: 1 },
      },
    });

    expect(authorizeToolCall).toHaveBeenCalledWith(
      'update_ledger_entry',
      { entryId: 'entry-1', expectedRevision: 1 },
      { requestId: '10' },
    );
    expect(payload).toMatchObject({
      result: {
        isError: true,
        content: [{ type: 'text', text: 'UpdateFeedEntry was denied.' }],
      },
    });
    expect(ledgerTools.execute).not.toHaveBeenCalled();
  });

  it('binds calls to the Work Entry the session started in, whatever entry the window selects later', async () => {
    setLatestAppAdvisorWindowUiState({
      ...DEFAULT_WINDOW_UI_STATE,
      activeWorkEntryId: ENTRY_A,
      activeChatId: ADVISOR_CHAT,
    });
    const entryA = await openAdvisorLedger(ENTRY_A);
    const sessionKey = await registerAdvisorRoute('advisor-scope', {
      entryId: ENTRY_A,
      ledgerTools: entryA,
    });
    // The user moves to another Work Entry while the session stays open.
    setLatestAppAdvisorWindowUiState({
      ...DEFAULT_WINDOW_UI_STATE,
      activeWorkEntryId: ENTRY_B,
      activeChatId: 'another-chat',
    });

    const added = await rpc(sessionKey, {
      id: 1,
      method: 'tools/call',
      params: {
        name: 'AddFeedEntry',
        arguments: {
          type: 'TASK',
          title: 'Check the release notes',
          content: 'Review the draft.',
        },
        _meta: { 'claudecode/toolUseId': 'toolu_scope' },
      },
    });
    const found = await rpc(sessionKey, {
      id: 2,
      method: 'tools/call',
      params: { name: 'SearchFeedEntries', arguments: {} },
    });

    expect(callResultJson(added)).toMatchObject({
      ok: true,
      changed: true,
      entry: { title: 'Check the release notes', status: 'TODO' },
    });
    expect(registrations).toHaveLength(1);
    expect(registrations[0]).toMatchObject({
      container: advisorContainer(ENTRY_A),
      containerCreatedAt: ENTRY_CREATED_AT,
      role: 'interactive_chat',
      actor: { kind: 'chat', originKey: ADVISOR_CHAT },
      authorDetails: { harness: 'claude', model: 'claude-sonnet' },
    });
    expect(callResultJson(found)).toMatchObject({
      entries: [{ title: 'Check the release notes' }],
    });

    // The entry the window selected has a Ledger of its own, untouched.
    const entryB = await openAdvisorLedger(ENTRY_B);
    const other = await entryB.execute('search_ledger_entries', {});
    expect(JSON.parse(other.text)).toMatchObject({ entries: [] });
    expect(registrations[1]).toMatchObject({
      container: advisorContainer(ENTRY_B),
    });
  });

  it('prompts and hints with the Advisor tool names', async () => {
    const claude = await openAdvisorLedger(ENTRY_A);
    const codex = await openLedgerChatTools({
      target: advisorTarget(ENTRY_A, 'advisor-codex-chat'),
      harness: 'codex',
      toolNames: getAppAdvisorLedgerToolNames('codex'),
      readSettings: (): LedgerChatSettings => SETTINGS,
      host,
    });
    if (codex === null) throw new Error('Expected exposed Ledger tools');
    disposers.push(() => codex.dispose());
    const [claudeAdd, claudeSearch, claudeUpdate] = ADVISOR_CLAUDE_LEDGER_NAMES;
    const [codexAdd, codexSearch, codexUpdate] = ADVISOR_CODEX_LEDGER_NAMES;

    expect(claude.systemPrompt()).toContain(
      `${claudeSearch} searches this chat's Feed, ${claudeAdd} records an entry, and ${claudeUpdate} changes`,
    );
    expect(claude.systemPrompt()).toContain('rootId "app-advisor"');
    expect(claude.systemPrompt()).not.toContain(`mcp__${NAMESPACE}__`);
    expect(codex.systemPrompt()).toContain(
      `${codexSearch} searches this chat's Feed, ${codexAdd} records an entry, and ${codexUpdate} changes`,
    );
    expect(codex.systemPrompt()).not.toContain(
      `${NAMESPACE}_search_feed_entries`,
    );

    await claude.execute('add_ledger_entry', {
      type: 'TASK',
      title: 'Follow up',
      content: 'Follow up on the release.',
    });
    await expect(claude.assignmentHint()).resolves.toContain(
      `Use ${claudeSearch} with owner "self"`,
    );
  });

  it.each([
    ['the Ledger flag is off', { flag: false, recording: true }],
    ['agent recording is off', { flag: true, recording: false }],
  ])(
    'opens no Ledger tools for an App Advisor session when %s',
    async (_label, next) => {
      gate = next;

      const session = await openLedgerChatTools({
        target: advisorTarget(ENTRY_A),
        harness: 'claude',
        toolNames: getAppAdvisorLedgerToolNames('claude'),
        readSettings: (): LedgerChatSettings => SETTINGS,
        host,
      });

      expect(session).toBeNull();
    },
  );

  it('refuses a call once the Ledger turns off during an open session', async () => {
    const session = await openAdvisorLedger(ENTRY_A);
    const sessionKey = await registerAdvisorRoute('advisor-flag-off', {
      ledgerTools: session,
    });
    gate.flag = false;

    const listed = listedToolNames(
      await rpc(sessionKey, { id: 1, method: 'tools/list' }),
    );
    const payload = await rpc(sessionKey, {
      id: 2,
      method: 'tools/call',
      params: { name: 'SearchFeedEntries', arguments: {} },
    });

    // The tools stay listed for the session; the call is refused.
    expect(listed).toEqual(expect.arrayContaining(LEDGER_DISPLAY_NAMES));
    expect(callResultJson(payload)).toMatchObject({
      ok: false,
      error: { code: 'FEED_UNAVAILABLE', reason: 'ledger_disabled' },
    });
  });
});
