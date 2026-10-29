const mockGetCodeGraphContext = jest.fn();
const mockBuildOrUpdateCodeGraph = jest.fn();
const mockQueryCodeGraph = jest.fn();
const mockSearchCodeGraph = jest.fn();
const mockExplainCodeSymbol = jest.fn();
const mockGetImpactRadius = jest.fn();
const mockDetectChangedSymbols = jest.fn();
const mockCompareChangeImpact = jest.fn();
const mockGetReviewContext = jest.fn();
const mockSetCurrentWorktreeBaseBranch = jest.fn();

// `core.ts` imports `code-graph-runtime.ts` statically (unlike the dynamic
// `import('../app-advisor/watchers')` used elsewhere in that module), so this
// mock must be registered — and its `mock*` fns declared — before the first
// `import` of `../canopy-tools/core` below triggers that static require.
jest.mock('../canopy-tools/code-graph-runtime', () => ({
  getCodeGraphContext: mockGetCodeGraphContext,
  buildOrUpdateCodeGraph: mockBuildOrUpdateCodeGraph,
  queryCodeGraph: mockQueryCodeGraph,
  searchCodeGraph: mockSearchCodeGraph,
  explainCodeSymbol: mockExplainCodeSymbol,
  getImpactRadius: mockGetImpactRadius,
  detectChangedSymbols: mockDetectChangedSymbols,
  compareChangeImpact: mockCompareChangeImpact,
  getReviewContext: mockGetReviewContext,
}));

const mockStartSplitAgent = jest.fn();
jest.mock('../canopy-tools/start-split-agent-runtime', () => ({
  startSplitAgent: (...args: unknown[]): unknown =>
    mockStartSplitAgent(...args),
}));
jest.mock('../canopy-tools/set-base-branch-runtime', () => ({
  setCurrentWorktreeBaseBranch: mockSetCurrentWorktreeBaseBranch,
}));

const mockGetGitHubPullRequestStatus = jest.fn();
jest.mock('../lib/github-pr-read-model', () => ({
  getGitHubPullRequestStatus: (...args: unknown[]): unknown =>
    mockGetGitHubPullRequestStatus(...args),
}));

const mockIsEnabled = jest.fn();
jest.mock('../feature-flags', (): unknown => ({
  getFeatureFlagService: () => ({
    isEnabled: mockIsEnabled,
  }),
}));

import {
  executeCanopyInjectedTool,
  type CanopyInjectedToolRuntime,
} from '../canopy-tools/core';
import {
  DISPATCH_ACTION_DESCRIPTION,
  SEARCH_ACTIONS_DESCRIPTION,
} from '../canopy-tools/definitions';
import * as worktreeActions from '../canopy-tools/worktree-actions';
import { getChatQueueService } from '../services/chat-queue-service';
import {
  claimPendingAuthFailures,
  clearPendingAuthFailures,
} from '../mcp/pending-auth-failures';
import type { ScriptOutputSnapshot } from '../mcp/script-output';
import { setDelegationActivity } from '../agents/delegation/activity';
import { ASK_USER_TIMEOUT_MESSAGE } from '@canopy/desktop-shared/lib/canopy-injected-tools';
import {
  ADVISOR_ACCESS_DISABLED,
  ADVISOR_ACCESS_DISABLED_MESSAGE,
} from '../lib/app-advisor-project-agent-access';
import { searchAppAdvisorWatchers } from '@canopy/desktop-shared/lib/app-advisor-watchers';
import {
  APP_ADVISOR_PROJECT_ID,
  type ChatStateSnapshot,
} from '@canopy/desktop-shared/types';
import type {
  CodeGraphBuildToolResult,
  CodeGraphContextResult,
  CodeGraphExplainResult,
  CodeGraphImpactResult,
  CodeGraphQueryResult,
  CodeGraphSearchResultPayload,
  CompareChangeImpactResult,
  DetectChangedSymbolsResult,
  GetReviewContextResult,
} from '@canopy/desktop-shared/types/code-graph-tools';

const mockSearchWatchers = jest.fn();
const mockSetupWatchers = jest.fn();
const mockWatchGitHubItems = jest.fn();
const mockDeleteAgentWatchers = jest.fn();
const mockCreateLocalWatcher = jest.fn();
const mockSetupCanonicalChatWatchers = jest.fn();
const mockProjectCanonicalChatWatchers = jest.fn();
const mockIsBotAccessAllowed = jest.fn<Promise<boolean>, [unknown]>(() =>
  Promise.resolve(false),
);

jest.mock('../app-advisor/watchers', () => ({
  getAppAdvisorWatcherService: jest.fn(() => ({
    search: mockSearchWatchers,
    setup: mockSetupWatchers,
    setupCanonicalChatWatchers: mockSetupCanonicalChatWatchers,
    projectCanonicalChatWatchers: mockProjectCanonicalChatWatchers,
    watchGitHubItems: mockWatchGitHubItems,
    deleteAgentWatchers: mockDeleteAgentWatchers,
    createLocalWatcher: mockCreateLocalWatcher,
  })),
}));

type MockAppAdvisorAccessDecision =
  | { allowed: true }
  | { allowed: false; reason: 'advisor_access_disabled' | 'owner_unknown' };

interface MockAutomationActivity {
  id: string;
  action: { type: string };
}

const mockDecideAppAdvisorAccessForCaller = jest.fn<
  Promise<MockAppAdvisorAccessDecision>,
  [{ projectId: string; worktreeId: string }]
>();
const mockFindAutomationActivityForBackgroundAuthorization = jest.fn<
  Promise<MockAutomationActivity | undefined>,
  [string]
>();

type MockProjectOwner =
  | { kind: 'personal' }
  | { kind: 'organization'; organizationId: string }
  | { kind: 'none' }
  | { kind: 'unknown' };
type MockAutomationTarget =
  | { kind: 'project'; projectId: string; worktreeId?: string }
  | { kind: 'app_advisor' }
  | { kind: 'unknown' };
type MockSameOwnerDecision =
  | { kind: 'allowed' }
  | { kind: 'hidden' }
  | { kind: 'caller_owner_unknown' }
  | { kind: 'target_owner_unknown' };

const mockResolveProjectSavedOwner = jest.fn<
  Promise<MockProjectOwner>,
  [{ projectId: string; worktreeId?: string }]
>();
const mockResolveAutomationTargetProject = jest.fn<
  MockAutomationTarget,
  [{ type: string }]
>();
const mockDecideSameOwnerAccess = jest.fn<
  Promise<MockSameOwnerDecision>,
  [MockProjectOwner, { projectId: string; worktreeId?: string }]
>();

jest.mock('../lib/app-advisor-project-agent-access', () => ({
  ADVISOR_ACCESS_DISABLED: 'advisor_access_disabled',
  ADVISOR_ACCESS_DISABLED_MESSAGE:
    'App Advisor access is turned off for agents in this project. The user controls this in Settings > App Advisor.',
  decideAppAdvisorAccessForCaller: (caller: {
    projectId: string;
    worktreeId: string;
  }): Promise<MockAppAdvisorAccessDecision> =>
    mockDecideAppAdvisorAccessForCaller(caller),
}));

jest.mock('../automations/service', () => ({
  getAutomationsService: jest.fn(() => ({
    findActivityForBackgroundAuthorization:
      mockFindAutomationActivityForBackgroundAuthorization,
  })),
}));

jest.mock('../lib/project-owner', () => ({
  resolveProjectSavedOwner: (target: {
    projectId: string;
    worktreeId?: string;
  }): Promise<MockProjectOwner> => mockResolveProjectSavedOwner(target),
  resolveAutomationTargetProject: (action: {
    type: string;
  }): MockAutomationTarget => mockResolveAutomationTargetProject(action),
  decideSameOwnerAccess: (
    callerOwner: MockProjectOwner,
    target: { projectId: string; worktreeId?: string },
  ): Promise<MockSameOwnerDecision> =>
    mockDecideSameOwnerAccess(callerOwner, target),
}));

jest.mock('../project-discovery/bots', () => ({
  ...jest.requireActual<object>('../project-discovery/bots'),
  isBotAccessAllowed: (caller: unknown): Promise<boolean> =>
    mockIsBotAccessAllowed(caller),
}));

// `executeWatchGitHubItems` resolves the chat's repositories before calling the
// watcher service; the real helper walks the workspace on disk.
const mockResolveGitHubRepositoryCandidates = jest.fn<
  Promise<string[]>,
  [{ projectId: string; worktreeId: string; cwd?: string }]
>(() => Promise.resolve(['acme/widgets']));
jest.mock('../lib/github-repository-context', () => ({
  resolveGitHubRepositoryCandidates: (options: {
    projectId: string;
    worktreeId: string;
    cwd?: string;
  }): Promise<string[]> => mockResolveGitHubRepositoryCandidates(options),
}));

interface ParsedWatcherCatalog {
  catalog: Array<{
    trigger: string;
    requiredFields: string[];
    optionalFields: string[];
    optionalEntryFields: string[];
    usageGuidance: string;
    hookTriggers?: Array<{ triggerName: string; title: string }>;
  }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'string')
  );
}

function parseWatcherCatalog(text: string): ParsedWatcherCatalog {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed) || !Array.isArray(parsed.catalog)) {
    throw new Error('Expected watcher catalog result.');
  }
  const catalog: ParsedWatcherCatalog['catalog'] = [];
  for (const entry of parsed.catalog) {
    if (
      !isRecord(entry) ||
      typeof entry.trigger !== 'string' ||
      !isStringArray(entry.requiredFields) ||
      !isStringArray(entry.optionalFields) ||
      !isStringArray(entry.optionalEntryFields) ||
      typeof entry.usageGuidance !== 'string'
    ) {
      throw new Error('Expected watcher catalog entry.');
    }
    const hookTriggers = Array.isArray(entry.hookTriggers)
      ? entry.hookTriggers.flatMap((hookTrigger) => {
          if (
            !isRecord(hookTrigger) ||
            typeof hookTrigger.triggerName !== 'string' ||
            typeof hookTrigger.title !== 'string'
          ) {
            return [];
          }
          return [
            {
              triggerName: hookTrigger.triggerName,
              title: hookTrigger.title,
            },
          ];
        })
      : undefined;
    catalog.push({
      trigger: entry.trigger,
      requiredFields: entry.requiredFields,
      optionalFields: entry.optionalFields,
      optionalEntryFields: entry.optionalEntryFields,
      usageGuidance: entry.usageGuidance,
      ...(hookTriggers ? { hookTriggers } : {}),
    });
  }
  return { catalog };
}

interface WatcherRuntimeScope {
  projectId: string;
  worktreeId: string;
  chatId: string;
  delegationId?: string;
}

function createAutomationWatcherRuntime(
  scope: WatcherRuntimeScope,
): CanopyInjectedToolRuntime {
  return {
    requestUserAnswers: jest.fn(),
    loadScriptOutput: jest.fn(),
    worktreeActionRuntime: {
      projectId: scope.projectId,
      worktreeId: scope.worktreeId,
      chatId: scope.chatId,
      cwd: '/repo',
      getWindow: () => null,
    },
    worktreeWatcherRuntime: scope,
  };
}

const rootAndDelegateScopes = [
  {
    name: 'root caller',
    scope: {
      projectId: 'root-project',
      worktreeId: 'root-worktree',
      chatId: 'root-chat',
    },
  },
  {
    name: 'managed delegate',
    scope: {
      projectId: 'root-project',
      worktreeId: 'root-worktree',
      chatId: 'root-chat',
      delegationId: 'delegate-1',
    },
  },
];

/** A refused SetupWatchers result with its single per-entry refusal. */
function refusedSetup(result: {
  ok: false;
  error: string;
  code?: string;
  rejectedIndex: number;
}): object {
  return {
    ...result,
    watchers: [
      { ok: false, error: { code: 'invalid_target', message: result.error } },
    ],
  };
}

const automationCallerScopes = [
  ...rootAndDelegateScopes,
  {
    name: 'cowork root caller',
    scope: {
      projectId: 'cowork-project',
      worktreeId: 'cowork-work-entry',
      chatId: 'cowork-chat',
    },
  },
  {
    name: 'cowork managed delegate',
    scope: {
      projectId: 'cowork-project',
      worktreeId: 'cowork-work-entry',
      chatId: 'cowork-chat',
      delegationId: 'cowork-delegate',
    },
  },
];

describe('canopy injected tools core', () => {
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
    {
      type: 'browser.list_transfers',
      kind: 'download',
      status: 'paused',
      offset: 2,
      limit: 50,
    },
    { type: 'browser.cancel_transfer', transferId: 'download-1' },
  ])(
    'carries browser action payload through generic DispatchAction for %j',
    async (payload) => {
      const dispatch = jest
        .spyOn(worktreeActions, 'dispatchWorktreeAction')
        .mockResolvedValue({ requestId: '', ok: true });
      const runtime: CanopyInjectedToolRuntime = {
        requestUserAnswers: jest.fn(),
        loadScriptOutput: jest.fn(),
        worktreeActionRuntime: {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
          cwd: '/repo',
          getWindow: () => null,
        },
      };
      const action = {
        ...payload,
        expectedRuntimeGeneration: 1,
        ...([
          'browser.drag',
          'browser.list_transfers',
          'browser.cancel_transfer',
        ].includes(payload.type)
          ? {}
          : { frame: '  iframe.checkout  ' }),
      };
      const result = await executeCanopyInjectedTool(
        'dispatch_action',
        { action },
        runtime,
      );
      expect(result.isError).toBe(false);
      expect(dispatch).toHaveBeenCalledWith(
        { action },
        runtime.worktreeActionRuntime,
      );
      dispatch.mockRestore();
    },
  );

  it('fails closed for ShowVisual without an eligible port or live flag', async () => {
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers: jest.fn(),
      loadScriptOutput: jest.fn(),
    };
    const input = {
      html: '<!doctype html><title>Chart</title>',
      title: 'Chart',
      height: 400,
    };
    expect(
      await executeCanopyInjectedTool('show_visual', input, runtime),
    ).toMatchObject({
      isError: true,
      text: "ShowVisual isn't available in this chat.",
    });
    const stageVisual = jest.fn();
    runtime.showVisual = {
      scope: { projectId: 'p', worktreeId: 'w' },
      chatId: 'c',
      cwd: '/workspace',
      stageVisual,
    };
    mockIsEnabled.mockReturnValue(false);
    expect(
      await executeCanopyInjectedTool('show_visual', input, runtime),
    ).toMatchObject({
      isError: true,
      text: 'Visuals are turned off.',
    });
    expect(stageVisual).not.toHaveBeenCalled();
    mockIsEnabled.mockReturnValue(true);
    expect(
      await executeCanopyInjectedTool(
        'show_visual',
        { ...input, html: '界'.repeat(170_667) },
        runtime,
      ),
    ).toMatchObject({
      isError: true,
      text: 'Check the HTML, title, and height for ShowVisual.',
    });
  });

  it('rejects PreviewVisual without a host or when the live flag turns off', async () => {
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers: jest.fn(),
      loadScriptOutput: jest.fn(),
    };
    expect(
      await executeCanopyInjectedTool(
        'preview_visual',
        { html: '<p>ok</p>' },
        runtime,
      ),
    ).toMatchObject({
      isError: true,
      text: "PreviewVisual isn't available in this chat.",
    });
    const stageVisual = jest.fn();
    runtime.showVisual = {
      scope: { projectId: 'p', worktreeId: 'w' },
      chatId: 'c',
      cwd: '/workspace',
      stageVisual,
    };
    mockIsEnabled.mockReturnValue(false);
    expect(
      await executeCanopyInjectedTool(
        'preview_visual',
        { html: '<p>ok</p>' },
        runtime,
      ),
    ).toMatchObject({ isError: true, text: 'Visuals are turned off.' });
    expect(stageVisual).not.toHaveBeenCalled();
  });

  it('reads pull request status through the read model without any chat scope', async () => {
    mockGetGitHubPullRequestStatus.mockResolvedValue({
      ref: { owner: 'acme', repo: 'api', number: 7 },
      url: 'https://github.com/acme/api/pull/7',
      title: 'Thing',
      state: 'merged',
      isDraft: false,
      headBranch: 'feature',
      baseBranch: 'main',
      headSha: 'b'.repeat(40),
      mergeable: 'unknown',
      reviewDecision: 'approved',
      checks: {
        state: 'success',
        total: 1,
        passed: 1,
        failed: 0,
        pending: 0,
        failedNames: [],
      },
      mergeQueue: { inQueue: false, position: null },
      fetchedAt: '2026-10-13T12:00:00.000Z',
    });
    const controller = new AbortController();
    const result = await executeCanopyInjectedTool(
      'get_github_pull_request_status',
      { pullRequest: 'https://github.com/acme/api/pull/7' },
      { requestUserAnswers: jest.fn(), loadScriptOutput: jest.fn() },
      { toolUseId: 'tool-pr', signal: controller.signal },
    );
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.text)).toMatchObject({
      ok: true,
      pullRequest: { repository: 'acme/api', number: 7, state: 'merged' },
    });
    expect(mockGetGitHubPullRequestStatus).toHaveBeenCalledWith(
      { owner: 'acme', repo: 'api', number: 7 },
      {
        priority: 'interactive',
        caller: 'agent-pr-status',
        signal: controller.signal,
      },
    );
  });

  it('captures local watcher scope and rejects supplied destinations and invalid bounds', async () => {
    mockCreateLocalWatcher.mockResolvedValue({ id: 'watcher-one' });
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers: jest.fn(),
      loadScriptOutput: jest.fn(),
      worktreeWatcherRuntime: { projectId: 'p', worktreeId: 'w', chatId: 'c' },
      worktreeActionRuntime: {
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'c',
        cwd: '/workspace',
        getWindow: () => null,
      },
    };
    expect(
      (
        await executeCanopyInjectedTool(
          'schedule_wakeup',
          { delaySeconds: 60 },
          runtime,
          { toolUseId: 'tool-wake' },
        )
      ).isError,
    ).not.toBe(true);
    expect(mockCreateLocalWatcher).toHaveBeenCalledWith(
      { kind: 'scheduled_wakeup', delaySeconds: 60, scheduledFor: '' },
      { projectId: 'p', worktreeId: 'w', chatId: 'c' },
      'tool-wake',
      undefined,
    );
    for (const delaySeconds of [0, 59, 3601, 60.5])
      expect(
        (
          await executeCanopyInjectedTool(
            'schedule_wakeup',
            { delaySeconds },
            runtime,
          )
        ).isError,
      ).toBe(true);
    expect(
      (
        await executeCanopyInjectedTool(
          'schedule_wakeup',
          { delaySeconds: 60, chatId: 'other' },
          runtime,
        )
      ).isError,
    ).toBe(true);
    expect(
      (
        await executeCanopyInjectedTool(
          'watch_command',
          { command: 'test -f ready', intervalSeconds: 5, maxAttempts: 100 },
          runtime,
          { toolUseId: 'tool-watch' },
        )
      ).isError,
    ).not.toBe(true);
    expect(mockCreateLocalWatcher).toHaveBeenLastCalledWith(
      {
        kind: 'command_watch',
        command: 'test -f ready',
        intervalSeconds: 5,
        maxAttempts: 100,
        cwd: '/workspace',
      },
      { projectId: 'p', worktreeId: 'w', chatId: 'c' },
      'tool-watch',
      undefined,
    );
    expect(
      (
        await executeCanopyInjectedTool(
          'watch_command',
          { command: 'x', intervalSeconds: 4, maxAttempts: 101 },
          runtime,
        )
      ).isError,
    ).toBe(true);
    const denied = {
      ...runtime,
      authorizeWatchCommand: (): Promise<boolean> => Promise.resolve(false),
    };
    mockCreateLocalWatcher.mockClear();
    expect(
      (
        await executeCanopyInjectedTool(
          'watch_command',
          { command: 'x', intervalSeconds: 5, maxAttempts: 1 },
          denied,
        )
      ).isError,
    ).toBe(true);
    expect(mockCreateLocalWatcher).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    mockIsEnabled.mockReset();
    mockIsEnabled.mockReturnValue(true);
    mockSearchWatchers.mockReset();
    mockSetupWatchers.mockReset();
    mockSetupCanonicalChatWatchers.mockReset();
    mockProjectCanonicalChatWatchers.mockReset().mockResolvedValue([]);
    mockIsBotAccessAllowed.mockReset().mockResolvedValue(false);
    mockWatchGitHubItems.mockReset();
    mockDeleteAgentWatchers.mockReset();
    mockDecideAppAdvisorAccessForCaller.mockReset();
    mockDecideAppAdvisorAccessForCaller.mockResolvedValue({ allowed: true });
    mockFindAutomationActivityForBackgroundAuthorization.mockReset();
    mockFindAutomationActivityForBackgroundAuthorization.mockResolvedValue(
      undefined,
    );
    mockResolveProjectSavedOwner.mockReset();
    mockResolveProjectSavedOwner.mockResolvedValue({ kind: 'personal' });
    mockResolveAutomationTargetProject.mockReset();
    mockResolveAutomationTargetProject.mockReturnValue({
      kind: 'project',
      projectId: 'target-project',
    });
    mockDecideSameOwnerAccess.mockReset();
    mockDecideSameOwnerAccess.mockResolvedValue({ kind: 'allowed' });
    mockGetCodeGraphContext.mockReset();
    mockBuildOrUpdateCodeGraph.mockReset();
    mockQueryCodeGraph.mockReset();
    mockSearchCodeGraph.mockReset();
    mockExplainCodeSymbol.mockReset();
    mockGetImpactRadius.mockReset();
    mockDetectChangedSymbols.mockReset();
    mockCompareChangeImpact.mockReset();
    mockGetReviewContext.mockReset();
    mockSetCurrentWorktreeBaseBranch.mockReset();
  });

  it('advertises resource-management actions in the injected tool descriptions', () => {
    expect(SEARCH_ACTIONS_DESCRIPTION).toContain(
      'skills, pipeline, worktree, automations',
    );
    expect(DISPATCH_ACTION_DESCRIPTION).toContain(
      'skills, pipeline, and automation management',
    );
    expect(DISPATCH_ACTION_DESCRIPTION).toContain(
      'listing and running configured worktree scripts',
    );
  });

  it('returns actionable browser target validation errors', async () => {
    const result = await executeCanopyInjectedTool(
      'dispatch_action',
      { action: { type: 'browser.inspect' } },
      {},
    );

    expect(result.isError).toBe(true);
    expect(result.text).toContain(
      'browser.inspect requires exactly one target',
    );
    expect(result.text).toContain('browser.input_snapshot');
  });

  it('limits SearchActions and DispatchAction to the runtime allowedActionTypes', async () => {
    const allowedActionTypes = ['worktree.list_scripts', 'worktree.run_script'];
    const dispatch = jest.spyOn(worktreeActions, 'dispatchWorktreeAction');
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers: jest.fn(),
      loadScriptOutput: jest.fn(),
      worktreeActionRuntime: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        cwd: '/repo',
        getWindow: () => null,
        allowedActionTypes,
      },
      worktreeWatcherRuntime: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      },
    };

    const search = await executeCanopyInjectedTool(
      'search_actions',
      { query: 'run' },
      runtime,
    );
    const searched: unknown = JSON.parse(search.text);
    if (!isRecord(searched) || !Array.isArray(searched.actions)) {
      throw new Error('Expected a SearchActions result.');
    }
    const types = searched.actions.map((action) =>
      isRecord(action) ? action.type : null,
    );
    expect(types).toContain('worktree.run_script');
    expect(
      types.every(
        (type) => typeof type === 'string' && allowedActionTypes.includes(type),
      ),
    ).toBe(true);

    const rejected = await executeCanopyInjectedTool(
      'dispatch_action',
      {
        action: {
          type: 'automation.run_now',
          id: 'auto-1',
          watchers: [{ followUpInstruction: 'Report the outcome.' }],
        },
      },
      runtime,
    );
    expect(rejected.isError).toBe(true);
    expect(JSON.parse(rejected.text)).toMatchObject({
      ok: false,
      error: {
        code: 'unsupported_action',
        message:
          'automation.run_now is not available here. Available actions: worktree.list_scripts, worktree.run_script.',
      },
    });
    // The restriction applies before inline watchers are armed.
    expect(mockSetupWatchers).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    dispatch.mockRestore();
  });

  it('keeps a successful pipeline run successful when inline watcher setup throws', async () => {
    const dispatch = jest
      .spyOn(worktreeActions, 'dispatchWorktreeAction')
      .mockResolvedValue({
        requestId: '',
        ok: true,
        result: { execution: { id: 'execution-1' } },
      });
    mockSetupWatchers.mockRejectedValue(new Error('watcher store unavailable'));
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers: jest.fn(),
      loadScriptOutput: jest.fn(),
      worktreeActionRuntime: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        cwd: '/repo',
        getWindow: () => null,
      },
      worktreeWatcherRuntime: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      },
    };

    const result = await executeCanopyInjectedTool(
      'dispatch_action',
      {
        action: {
          type: 'pipeline.run',
          pipelineId: 'pipeline-1',
          watchers: [{ target: { pipelineId: 'pipeline-1' } }],
        },
      },
      runtime,
    );

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toMatchObject({
      ok: true,
      result: {
        execution: { id: 'execution-1' },
        inlineWatcherSetup: {
          ok: false,
          error: 'watcher store unavailable',
        },
      },
    });
    dispatch.mockRestore();
  });

  it('reports a pipeline run inline watcher setup as its JSON projection', async () => {
    const dispatch = jest
      .spyOn(worktreeActions, 'dispatchWorktreeAction')
      .mockResolvedValue({
        requestId: '',
        ok: true,
        result: { execution: { id: 'execution-1' } },
      });
    mockSetupWatchers.mockResolvedValue({
      ok: true,
      results: [
        {
          status: 'created',
          watcher: {
            id: 'watcher-1',
            trigger: 'worktree_pipeline_completion',
            status: 'active',
            label: 'Pipeline done',
            target: {
              kind: 'worktree_pipeline',
              projectId: 'project-1',
              worktreeId: 'worktree-1',
              executionId: 'execution-1',
            },
            createdAt: '2026-10-12T00:00:00.000Z',
            followUpInstruction: undefined,
          },
        },
      ],
    });
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers: jest.fn(),
      loadScriptOutput: jest.fn(),
      worktreeActionRuntime: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        cwd: '/repo',
        getWindow: () => null,
      },
      worktreeWatcherRuntime: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      },
    };

    const result = await executeCanopyInjectedTool(
      'dispatch_action',
      {
        action: {
          type: 'pipeline.run',
          pipelineId: 'pipeline-1',
          watchers: [{ label: 'Pipeline done' }],
        },
      },
      runtime,
    );

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toEqual({
      requestId: '',
      ok: true,
      result: {
        execution: { id: 'execution-1' },
        inlineWatcherSetup: {
          ok: true,
          results: [
            {
              status: 'created',
              watcher: {
                id: 'watcher-1',
                trigger: 'worktree_pipeline_completion',
                status: 'active',
                label: 'Pipeline done',
                targetKind: 'worktree_pipeline',
              },
            },
          ],
        },
      },
    });
    dispatch.mockRestore();
  });

  it('formats ask-user answers and forwards the deterministic toolUseId', async () => {
    const requestUserAnswers = jest.fn().mockResolvedValue([
      {
        question: 'Deploy now?',
        selectedOptions: ['Yes'],
        freeformText: 'after tests',
      },
    ]);
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers,
      loadScriptOutput: jest.fn(),
    };

    const result = await executeCanopyInjectedTool(
      'ask_user_question',
      {
        questions: [
          {
            question: 'Deploy now?',
            options: ['Yes', 'No'],
            multiSelect: false,
          },
        ],
      },
      runtime,
      { toolUseId: 'codex-call-1' },
    );

    expect(result).toEqual({
      text: 'Q: Deploy now?\nA: Yes\nAdditional: after tests',
    });
    expect(requestUserAnswers).toHaveBeenCalledWith(
      [
        {
          question: 'Deploy now?',
          options: ['Yes', 'No'],
          multiSelect: false,
        },
      ],
      { toolUseId: 'codex-call-1' },
    );
  });

  it.each([
    {
      enabled: true,
      text: 'Auto-archive is enabled for this chat when the current agent turn completes.',
    },
    {
      enabled: false,
      text: 'Auto-archive is disabled for this chat; it will stay open when the current agent turn completes.',
    },
  ])(
    'sets current-chat auto-archive to $enabled',
    async ({ enabled, text }) => {
      const setAutoArchiveForCurrentChat = jest.fn();
      const runtime: CanopyInjectedToolRuntime = {
        requestUserAnswers: jest.fn(),
        loadScriptOutput: jest.fn(),
        setAutoArchiveForCurrentChat,
      };

      const result = await executeCanopyInjectedTool(
        'set_auto_archive',
        { enabled },
        runtime,
      );

      expect(result).toEqual({ text });
      expect(setAutoArchiveForCurrentChat).toHaveBeenCalledWith(enabled);
    },
  );

  it('defers SetAutoArchive until the chat delegates finish', async () => {
    const setAutoArchiveForCurrentChat = jest.fn();
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers: jest.fn(),
      loadScriptOutput: jest.fn(),
      setAutoArchiveForCurrentChat,
      worktreeWatcherRuntime: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      },
    };
    setDelegationActivity(
      'auto-archive-tool',
      'project-1/worktree-1/chat-1',
      1,
    );
    try {
      await expect(
        executeCanopyInjectedTool(
          'set_auto_archive',
          { enabled: true },
          runtime,
        ),
      ).resolves.toEqual({
        text: 'Auto-archive is on. This chat will be archived after its delegates finish.',
      });
      await expect(
        executeCanopyInjectedTool(
          'set_auto_archive',
          { enabled: false },
          runtime,
        ),
      ).resolves.toEqual({
        text: 'Auto-archive is disabled for this chat; it will stay open when the current agent turn completes.',
      });
    } finally {
      setDelegationActivity(
        'auto-archive-tool',
        'project-1/worktree-1/chat-1',
        0,
      );
    }
    expect(setAutoArchiveForCurrentChat.mock.calls).toEqual([[true], [false]]);

    await expect(
      executeCanopyInjectedTool('set_auto_archive', { enabled: true }, runtime),
    ).resolves.toEqual({
      text: 'Auto-archive is enabled for this chat when the current agent turn completes.',
    });
  });

  it('rejects SetAutoArchive when no current-chat callback is available', async () => {
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers: jest.fn(),
      loadScriptOutput: jest.fn(),
    };

    const result = await executeCanopyInjectedTool(
      'set_auto_archive',
      { enabled: true },
      runtime,
    );

    expect(result).toEqual({
      text: 'SetAutoArchive is only available for chats.',
      isError: true,
    });
  });

  it('requires an enabled boolean for SetAutoArchive', async () => {
    const setAutoArchiveForCurrentChat = jest.fn();
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers: jest.fn(),
      loadScriptOutput: jest.fn(),
      setAutoArchiveForCurrentChat,
    };

    const result = await executeCanopyInjectedTool(
      'set_auto_archive',
      {},
      runtime,
    );

    expect(result).toEqual({
      text: 'Invalid arguments for SetAutoArchive.',
      isError: true,
    });
    expect(setAutoArchiveForCurrentChat).not.toHaveBeenCalled();
  });

  it('sets the current worktree base branch without accepting target ids', async () => {
    mockSetCurrentWorktreeBaseBranch.mockResolvedValue({
      requestId: 'tool-call-1',
      ok: true,
      result: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        repoId: 'repo-a',
        baseBranch: 'release/next',
        pullRequestUpdated: false,
      },
      uiState: {
        selectedWorktree: { workspaceName: 'Private workspace' },
        activeChat: { title: 'Private chat' },
      },
    });
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers: jest.fn(),
      loadScriptOutput: jest.fn(),
      worktreeActionRuntime: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        cwd: '/repo',
        getWindow: () => null,
      },
    };

    const result = await executeCanopyInjectedTool(
      'set_base_branch',
      { baseBranch: 'release/next', repoId: 'repo-a' },
      runtime,
      { toolUseId: 'tool-call-1' },
    );

    expect(mockSetCurrentWorktreeBaseBranch).toHaveBeenCalledWith(
      { baseBranch: 'release/next', repoId: 'repo-a' },
      expect.objectContaining({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      }),
      { toolUseId: 'tool-call-1' },
    );
    expect(result.isError).toBe(false);
    const parsedResult: unknown = JSON.parse(result.text);
    expect(parsedResult).toEqual({
      ok: true,
      result: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        repoId: 'repo-a',
        baseBranch: 'release/next',
        pullRequestUpdated: false,
      },
    });
  });

  it('rejects SetBaseBranch outside a current worktree chat', async () => {
    const result = await executeCanopyInjectedTool(
      'set_base_branch',
      { baseBranch: 'develop' },
      {
        requestUserAnswers: jest.fn(),
        loadScriptOutput: jest.fn(),
      },
    );

    expect(result).toEqual({
      text: 'SetBaseBranch is only available for worktree chats.',
      isError: true,
    });
  });

  it('rejects SetBaseBranch in a cowork directory runtime', async () => {
    const result = await executeCanopyInjectedTool(
      'set_base_branch',
      { baseBranch: 'develop' },
      {
        requestUserAnswers: jest.fn(),
        loadScriptOutput: jest.fn(),
        worktreeActionRuntime: {
          projectId: 'cowork-project',
          worktreeId: 'cowork-home',
          chatId: 'chat-1',
          cwd: '/workspace',
          executionScope: 'directory',
          getWindow: () => null,
        },
      },
    );

    expect(result).toEqual({
      text: 'SetBaseBranch is only available for worktree chats.',
      isError: true,
    });
    expect(mockSetCurrentWorktreeBaseBranch).not.toHaveBeenCalled();
  });

  it('rejects target ids and invalid base branches for SetBaseBranch', async () => {
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers: jest.fn(),
      loadScriptOutput: jest.fn(),
      worktreeActionRuntime: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        cwd: '/repo',
        getWindow: () => null,
      },
    };

    for (const args of [
      { baseBranch: '' },
      { baseBranch: 'develop', projectId: 'other-project' },
      { baseBranch: 'develop', worktreeId: 'other-worktree' },
    ]) {
      const result = await executeCanopyInjectedTool(
        'set_base_branch',
        args,
        runtime,
      );
      expect(result).toEqual({
        text: 'Invalid arguments for SetBaseBranch.',
        isError: true,
      });
    }
    expect(mockSetCurrentWorktreeBaseBranch).not.toHaveBeenCalled();
  });

  it('preserves interactive controls through the agent question tool', async () => {
    const questions = [
      { question: 'Continue?', options: ['Yes', 'No'], control: 'buttons' },
      {
        question: 'Project name',
        options: [],
        control: 'text',
        required: true,
      },
      {
        question: 'Environment',
        options: ['Staging', 'Production'],
        control: 'select',
      },
    ];
    const requestUserAnswers = jest.fn().mockResolvedValue([]);
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers,
      loadScriptOutput: jest.fn(),
    };
    await executeCanopyInjectedTool(
      'ask_user_question',
      { questions },
      runtime,
    );
    expect(requestUserAnswers).toHaveBeenCalledWith(questions, undefined);
  });

  it.each([
    { control: 'select', options: [] },
    { control: 'buttons', options: ['Yes', 'Yes'] },
    { control: 'text', options: ['Unexpected'] },
    { control: 'date', options: [], multiSelect: true },
    { control: 'html', options: [] },
  ])('rejects an unusable interactive question: %j', async (question) => {
    const requestUserAnswers = jest.fn();
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers,
      loadScriptOutput: jest.fn(),
    };
    const result = await executeCanopyInjectedTool(
      'ask_user_question',
      {
        questions: [{ question: 'Example', ...question }],
      },
      runtime,
    );
    expect(result.isError).toBe(true);
    expect(requestUserAnswers).not.toHaveBeenCalled();
  });

  it('returns the ask-user dismissal text for cancelled questions', async () => {
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers: jest.fn().mockRejectedValue(new Error('cancelled')),
      loadScriptOutput: jest.fn(),
    };

    const result = await executeCanopyInjectedTool(
      'ask_user_question',
      { questions: [{ question: 'Pick', options: ['A'] }] },
      runtime,
    );

    expect(result).toEqual({
      text: 'User dismissed the question.',
      isError: true,
    });
  });

  it('keeps renderer unavailability distinct from user dismissal', async () => {
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers: jest
        .fn()
        .mockRejectedValue(new Error('Window not available')),
      loadScriptOutput: jest.fn(),
    };

    const result = await executeCanopyInjectedTool(
      'ask_user_question',
      { questions: [{ question: 'Pick', options: ['A'] }] },
      runtime,
    );

    expect(result).toEqual({
      text: 'Window not available',
      isError: true,
    });
  });

  it('returns the timeout message when ask-user times out', async () => {
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers: () => Promise.reject(new Error('ask_user_timeout')),
      loadScriptOutput: jest.fn(),
    };

    const result = await executeCanopyInjectedTool(
      'ask_user_question',
      { questions: [{ question: 'Q', options: ['a'] }] },
      runtime,
    );

    expect(result.isError).toBe(true);
    expect(result.text).toBe(ASK_USER_TIMEOUT_MESSAGE);
  });

  it('returns a deterministic error for malformed ask-user args', async () => {
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers: jest.fn(),
      loadScriptOutput: jest.fn(),
    };

    const result = await executeCanopyInjectedTool(
      'ask_user_question',
      { questions: [{ question: 'Pick' }] },
      runtime,
    );

    expect(result).toEqual({
      text: 'Invalid arguments for AskUserQuestion.',
      isError: true,
    });
  });

  it('formats script output and defaults maxLines to 200', async () => {
    const snapshot: ScriptOutputSnapshot = {
      found: true,
      scriptKey: 'workspace-repo:api:launch',
      label: 'API - Launch',
      invocation: 'manual-run',
      humanStatus: 'succeeded',
      lines: ['ready'],
    };
    const loadScriptOutput = jest.fn().mockResolvedValue(snapshot);
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers: jest.fn(),
      loadScriptOutput,
    };

    const result = await executeCanopyInjectedTool(
      'get_script_output',
      { scriptId: 'launch', repo: 'api' },
      runtime,
    );

    expect(loadScriptOutput).toHaveBeenCalledWith({
      scriptId: 'launch',
      repo: 'api',
      maxLines: 200,
    });
    expect(result.text).toContain('[API - Launch - succeeded]');
    expect(result.text).toContain('Script ID: workspace-repo:api:launch');
    expect(result.text).toContain('ready');
  });

  it('returns the missing-output fallback when no loader error is present', async () => {
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers: jest.fn(),
      loadScriptOutput: jest.fn().mockResolvedValue({
        found: false,
        lines: [],
      }),
    };

    const result = await executeCanopyInjectedTool(
      'get_script_output',
      { scriptId: 'launch' },
      runtime,
    );

    expect(result).toEqual({
      text: 'No persisted output found for script "launch".',
      isError: true,
    });
  });

  it('returns a deterministic error for malformed maxLines', async () => {
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers: jest.fn(),
      loadScriptOutput: jest.fn(),
    };

    const result = await executeCanopyInjectedTool(
      'get_script_output',
      { scriptId: 'launch', maxLines: '200' },
      runtime,
    );

    expect(result).toEqual({
      text: 'Invalid arguments for GetScriptOutput.',
      isError: true,
    });
  });

  it('loads Git preferences by type', async () => {
    const loadGitPreferences = jest
      .fn()
      .mockResolvedValue('Git preferences for branch-name:\n\nNo instructions');
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers: jest.fn(),
      loadScriptOutput: jest.fn(),
      loadGitPreferences,
    };

    const result = await executeCanopyInjectedTool(
      'get_git_preferences',
      { type: 'branch-name' },
      runtime,
    );

    expect(loadGitPreferences).toHaveBeenCalledWith({ type: 'branch-name' });
    expect(result).toEqual({
      text: 'Git preferences for branch-name:\n\nNo instructions',
    });
  });

  it('returns a deterministic error for malformed Git preference args', async () => {
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers: jest.fn(),
      loadScriptOutput: jest.fn(),
      loadGitPreferences: jest.fn(),
    };

    const result = await executeCanopyInjectedTool(
      'get_git_preferences',
      { type: 'branch' },
      runtime,
    );

    expect(result).toEqual({
      text: 'Invalid arguments for GetGitPreferences.',
      isError: true,
    });
  });

  it('validates and forwards SaveMemory arguments', async () => {
    const saveLocalMemory = jest
      .fn()
      .mockResolvedValue('Saved project memory to inbox/2026-08.md');
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers: jest.fn(),
      loadScriptOutput: jest.fn(),
      saveLocalMemory,
    };

    await expect(
      executeCanopyInjectedTool(
        'save_memory',
        { text: 'This repo uses pnpm.', scope: 'workspace' },
        runtime,
      ),
    ).resolves.toEqual({
      text: 'Saved project memory to inbox/2026-08.md',
    });
    expect(saveLocalMemory).toHaveBeenCalledWith({
      text: 'This repo uses pnpm.',
      scope: 'workspace',
    });

    await expect(
      executeCanopyInjectedTool(
        'save_memory',
        { text: '', scope: 'workspace' },
        runtime,
      ),
    ).resolves.toEqual({
      text: 'Invalid arguments for SaveMemory.',
      isError: true,
    });
  });

  it('validates and forwards SearchMemory queries', async () => {
    const searchLocalMemory = jest.fn().mockResolvedValue('No matches.');
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers: jest.fn(),
      loadScriptOutput: jest.fn(),
      searchLocalMemory,
    };

    await expect(
      executeCanopyInjectedTool(
        'search_memory',
        { query: 'package manager' },
        runtime,
      ),
    ).resolves.toEqual({ text: 'No matches.' });
    expect(searchLocalMemory).toHaveBeenCalledWith({
      query: 'package manager',
    });

    await expect(
      executeCanopyInjectedTool('search_memory', { query: '' }, runtime),
    ).resolves.toEqual({
      text: 'Invalid arguments for SearchMemory.',
      isError: true,
    });
  });

  it('validates and forwards ReadMemory reads and preserves result messages', async () => {
    const truncated = `${'x'.repeat(100)}\n\n[Memory content truncated at 24 KiB.]`;
    const readLocalMemory = jest
      .fn()
      .mockResolvedValueOnce('User memory content')
      .mockResolvedValueOnce('Project memory content')
      .mockResolvedValueOnce(truncated)
      .mockResolvedValueOnce(
        'Local memory file not found: [user] topics/missing.md.',
      )
      .mockResolvedValueOnce('Local memory is disabled');
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers: jest.fn(),
      loadScriptOutput: jest.fn(),
      readLocalMemory,
    };

    await expect(
      executeCanopyInjectedTool(
        'read_memory',
        { scope: 'user', file: 'topics/editor.md' },
        runtime,
      ),
    ).resolves.toEqual({ text: 'User memory content' });
    await expect(
      executeCanopyInjectedTool(
        'read_memory',
        { scope: 'workspace', file: 'MEMORY.md' },
        runtime,
      ),
    ).resolves.toEqual({ text: 'Project memory content' });
    await expect(
      executeCanopyInjectedTool(
        'read_memory',
        { scope: 'workspace', file: 'inbox/large.md' },
        runtime,
      ),
    ).resolves.toEqual({ text: truncated });
    await expect(
      executeCanopyInjectedTool(
        'read_memory',
        { scope: 'user', file: 'topics/missing.md' },
        runtime,
      ),
    ).resolves.toEqual({
      text: 'Local memory file not found: [user] topics/missing.md.',
    });
    await expect(
      executeCanopyInjectedTool(
        'read_memory',
        { scope: 'user', file: 'MEMORY.md' },
        runtime,
      ),
    ).resolves.toEqual({ text: 'Local memory is disabled' });

    expect(readLocalMemory).toHaveBeenNthCalledWith(1, {
      scope: 'user',
      file: 'topics/editor.md',
    });
    expect(readLocalMemory).toHaveBeenNthCalledWith(2, {
      scope: 'workspace',
      file: 'MEMORY.md',
    });

    for (const file of ['../x.md', 'topics/../../x', '/tmp/x.md']) {
      await expect(
        executeCanopyInjectedTool(
          'read_memory',
          { scope: 'user', file },
          runtime,
        ),
      ).resolves.toEqual({
        text: 'Invalid arguments for ReadMemory.',
        isError: true,
      });
    }
    expect(readLocalMemory).toHaveBeenCalledTimes(5);
  });

  it('forwards pipeline YAML range and grep options to the loader', async () => {
    const loadPipelineYaml = jest.fn().mockResolvedValue({
      ok: true,
      text: 'Pipeline YAML: Review (review)\n---\n10: jobs:',
    });
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers: jest.fn(),
      loadScriptOutput: jest.fn(),
      loadPipelineYaml,
    };

    const result = await executeCanopyInjectedTool(
      'read_pipeline_yaml',
      {
        pipelineId: 'review',
        repoId: 'workspace-root',
        ranges: [{ startLine: 10, endLine: 20 }],
        pattern: 'jobs',
        fixedString: true,
        ignoreCase: true,
        context: 2,
        maxMatches: 5,
      },
      runtime,
    );

    expect(loadPipelineYaml).toHaveBeenCalledWith({
      pipelineId: 'review',
      repoId: 'workspace-root',
      ranges: [{ startLine: 10, endLine: 20 }],
      pattern: 'jobs',
      fixedString: true,
      ignoreCase: true,
      context: 2,
      maxMatches: 5,
    });
    expect(result).toEqual({
      text: 'Pipeline YAML: Review (review)\n---\n10: jobs:',
      isError: false,
    });
  });

  it('opens valid ShowFiles entries and ignores invalid view/line hints', async () => {
    const showFiles = jest.fn().mockResolvedValue({
      opened: 1,
      failed: 1,
      files: [
        { path: 'README.md', ok: true, tabId: 'file-1' },
        { path: 'archive.bin', ok: false, error: 'Unsupported file type.' },
      ],
    });
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers: jest.fn(),
      loadScriptOutput: jest.fn(),
      showFiles,
    };

    const result = await executeCanopyInjectedTool(
      'show_files',
      {
        files: [
          { path: 'README.md', view: 'invalid', line: -10 },
          { path: 'archive.bin', view: 'raw', line: 2 },
        ],
      },
      runtime,
    );

    expect(showFiles).toHaveBeenCalledWith([
      { path: 'README.md', view: undefined, line: undefined },
      { path: 'archive.bin', view: 'raw', line: 2 },
    ]);
    expect(result.isError).toBe(false);
    expect(result.text).toContain('"opened": 1');
    expect(result.text).toContain('"failed": 1');
  });

  it('rejects ShowFiles calls with more than ten files', async () => {
    const showFiles = jest.fn();
    const result = await executeCanopyInjectedTool(
      'show_files',
      {
        files: Array.from({ length: 11 }, (_, index) => ({
          path: `file-${index}.txt`,
        })),
      },
      {
        requestUserAnswers: jest.fn(),
        loadScriptOutput: jest.fn(),
        showFiles,
      },
    );

    expect(showFiles).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.text).toContain('between 1 and 10');
  });

  it('reads file comment threads through the scoped runtime', async () => {
    const getFileComments = jest.fn().mockResolvedValue({
      ok: true,
      text: 'Thread thread-1 [open]',
    });
    const result = await executeCanopyInjectedTool(
      'get_file_comments',
      { threadId: 'thread-1' },
      {
        requestUserAnswers: jest.fn(),
        loadScriptOutput: jest.fn(),
        getFileComments,
      },
    );

    expect(getFileComments).toHaveBeenCalledWith({ threadId: 'thread-1' });
    expect(result).toEqual({ text: 'Thread thread-1 [open]', isError: false });
  });

  it('replies to and resolves a file comment thread', async () => {
    const respondToFileComment = jest.fn().mockResolvedValue({
      ok: true,
      resolved: true,
    });
    const result = await executeCanopyInjectedTool(
      'respond_to_file_comment',
      { threadId: 'thread-1', body: 'Fixed.', resolve: true },
      {
        requestUserAnswers: jest.fn(),
        loadScriptOutput: jest.fn(),
        respondToFileComment,
      },
    );

    expect(respondToFileComment).toHaveBeenCalledWith({
      threadId: 'thread-1',
      body: 'Fixed.',
      resolve: true,
    });
    expect(result).toEqual({
      text: 'Reply posted to file thread thread-1 and the thread was resolved.',
      isError: false,
    });
  });

  it('replies to and resolves a plan comment thread', async () => {
    const respondToFileComment = jest.fn().mockResolvedValue({
      ok: true,
      resolved: true,
      store: 'plan',
    });
    const result = await executeCanopyInjectedTool(
      'respond_to_file_comment',
      { threadId: 'plan-thread-1', body: 'Fixed.', resolve: true },
      {
        requestUserAnswers: jest.fn(),
        loadScriptOutput: jest.fn(),
        respondToFileComment,
      },
    );

    expect(respondToFileComment).toHaveBeenCalledWith({
      threadId: 'plan-thread-1',
      body: 'Fixed.',
      resolve: true,
    });
    expect(result).toEqual({
      text: 'Reply posted to plan comment thread plan-thread-1 and the thread was resolved.',
      isError: false,
    });
  });

  it('returns ranked hook trigger names from worktree SearchWatchers results', async () => {
    mockSearchWatchers.mockImplementation(
      (
        input: Parameters<typeof searchAppAdvisorWatchers>[0],
        _destination: unknown,
        options?: Parameters<typeof searchAppAdvisorWatchers>[2],
      ) =>
        Promise.resolve(
          searchAppAdvisorWatchers(
            { ...input, detailLevel: 'standard' },
            [],
            options,
          ),
        ),
    );
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers: jest.fn(),
      loadScriptOutput: jest.fn(),
      worktreeWatcherRuntime: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      },
    };

    const result = await executeCanopyInjectedTool(
      'search_watchers',
      { query: 'PR comments', includeActive: false },
      runtime,
    );
    const parsed = parseWatcherCatalog(result.text);
    const hookEntry = parsed.catalog.find(
      (entry) => entry.trigger === 'worktree_hook_triggered',
    );

    expect(mockSearchWatchers).toHaveBeenCalledWith(
      {
        query: 'PR comments',
        includeActive: false,
        trigger: 'worktree_hook_triggered',
        limit: undefined,
      },
      { projectId: 'project-1', worktreeId: 'worktree-1', chatId: 'chat-1' },
      { includeLegacyChatTriggers: false },
    );
    expect(hookEntry?.requiredFields).toEqual(['triggerName']);
    expect(hookEntry?.usageGuidance).toContain('pr:update:comments');
    expect(hookEntry?.hookTriggers?.[0]).toMatchObject({
      triggerName: 'pr:update:comments',
      title: 'PR Comments Updated',
    });
  });

  it('applies worktree SearchWatchers limits after trigger scoping', async () => {
    mockSearchWatchers.mockImplementation(
      (
        input: Parameters<typeof searchAppAdvisorWatchers>[0],
        _destination: unknown,
        options?: Parameters<typeof searchAppAdvisorWatchers>[2],
      ) =>
        Promise.resolve(
          searchAppAdvisorWatchers(
            { ...input, detailLevel: 'standard' },
            [],
            options,
          ),
        ),
    );
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers: jest.fn(),
      loadScriptOutput: jest.fn(),
      worktreeWatcherRuntime: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      },
    };

    const result = await executeCanopyInjectedTool(
      'search_watchers',
      { query: 'pipeline', includeActive: false, limit: 1 },
      runtime,
    );
    const parsed = parseWatcherCatalog(result.text);

    expect(mockSearchWatchers).toHaveBeenCalledWith(
      {
        query: 'pipeline',
        includeActive: false,
        trigger: 'worktree_pipeline_completion',
        limit: undefined,
      },
      { projectId: 'project-1', worktreeId: 'worktree-1', chatId: 'chat-1' },
      { includeLegacyChatTriggers: false },
    );
    expect(mockSearchWatchers).toHaveBeenCalledWith(
      {
        query: 'pipeline',
        includeActive: false,
        trigger: 'worktree_hook_triggered',
        limit: undefined,
      },
      { projectId: 'project-1', worktreeId: 'worktree-1', chatId: 'chat-1' },
      { includeLegacyChatTriggers: false },
    );
    expect(parsed.catalog).toHaveLength(1);
    expect(parsed.catalog[0]?.trigger).toBe('worktree_pipeline_completion');
  });

  it('advertises pipeline, chat, automation, and GitHub watchers but no hook trigger in cowork chats', async () => {
    mockSearchWatchers.mockImplementation(
      (
        input: Parameters<typeof searchAppAdvisorWatchers>[0],
        _destination: unknown,
        options?: Parameters<typeof searchAppAdvisorWatchers>[2],
      ) =>
        Promise.resolve(
          searchAppAdvisorWatchers(
            { ...input, detailLevel: 'standard' },
            [],
            options,
          ),
        ),
    );
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers: jest.fn(),
      loadScriptOutput: jest.fn(),
      worktreeWatcherRuntime: {
        projectId: 'standalone-chat',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      },
    };

    const result = await executeCanopyInjectedTool(
      'search_watchers',
      { includeActive: false },
      runtime,
    );

    const catalog = parseWatcherCatalog(result.text).catalog;
    expect(catalog.map((entry) => entry.trigger).sort()).toEqual([
      'automation_run',
      'command_watch_resolved',
      'github_pull_requests_changed',
      'github_workflow_runs_changed',
      'project_new_chat_started',
      'project_task_chat_completion',
      'scheduled_wakeup',
      'worktree_pipeline_completion',
    ]);
    const pipelineEntry = catalog.find(
      (entry) => entry.trigger === 'worktree_pipeline_completion',
    );
    expect(pipelineEntry?.usageGuidance).toContain(
      'pipeline execution in this same cowork project',
    );
  });

  it('advertises chat and automation triggers to worktree chats', async () => {
    mockSearchWatchers.mockImplementation(
      (
        input: Parameters<typeof searchAppAdvisorWatchers>[0],
        _destination: unknown,
        options?: Parameters<typeof searchAppAdvisorWatchers>[2],
      ) =>
        Promise.resolve(
          searchAppAdvisorWatchers(
            { ...input, detailLevel: 'standard' },
            [],
            options,
          ),
        ),
    );
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers: jest.fn(),
      loadScriptOutput: jest.fn(),
      worktreeWatcherRuntime: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      },
    };

    const result = await executeCanopyInjectedTool(
      'search_watchers',
      { includeActive: false, detailLevel: 'standard' },
      runtime,
    );
    const catalog = parseWatcherCatalog(result.text).catalog;
    const triggers = catalog.map((entry) => entry.trigger);

    expect(triggers).toEqual(
      expect.arrayContaining([
        'project_task_chat_completion',
        'project_new_chat_started',
        'automation_run',
        'worktree_pipeline_completion',
        'worktree_hook_triggered',
        'github_workflow_runs_changed',
      ]),
    );
    // Legacy chat triggers are aliases; bot rows wait for bot access.
    expect(triggers).not.toContain('worktree_chat_completion');
    expect(triggers).not.toContain('bot_task_chat_completion');
    const chatEntry = catalog.find(
      (entry) => entry.trigger === 'project_task_chat_completion',
    );
    expect(chatEntry?.requiredFields).toEqual([
      'projectId',
      'taskId',
      'chatId',
    ]);
    expect(chatEntry?.optionalFields).toEqual([]);
    expect(chatEntry?.optionalEntryFields).toContain('armForNextCompletion');
    expect(chatEntry?.usageGuidance).toContain('cannot watch itself');
    expect(chatEntry?.usageGuidance).toContain('armForNextCompletion');
    expect(chatEntry?.usageGuidance).toContain('},"armForNextCompletion":true');
    const automationEntry = catalog.find(
      (entry) => entry.trigger === 'automation_run',
    );
    expect(automationEntry?.requiredFields).toEqual(['automationId']);
    expect(automationEntry?.usageGuidance).toContain('automation.list');
    expect(automationEntry?.usageGuidance).toContain(
      'dispatched chat turn ends',
    );
  });

  it('builds foreign chat watcher targets from caller-supplied ids', async () => {
    mockSetupWatchers.mockResolvedValue({ ok: true, results: [] });
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers: jest.fn(),
      loadScriptOutput: jest.fn(),
      worktreeWatcherRuntime: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      },
    };

    const result = await executeCanopyInjectedTool(
      'setup_watchers',
      {
        watchers: [
          {
            trigger: 'worktree_chat_completion',
            armForNextCompletion: true,
            target: {
              projectId: 'project-2',
              worktreeId: 'worktree-9',
              chatId: 'chat-9',
            },
          },
          {
            trigger: 'standalone_chat_completion',
            target: { projectId: 'cowork-1', chatId: 'cowork-chat-1' },
          },
          {
            trigger: 'worktree_new_chat_started',
            target: { projectId: 'project-2', worktreeId: 'worktree-9' },
          },
          {
            trigger: 'standalone_new_chat_started',
            target: { projectId: 'cowork-1' },
          },
        ],
      },
      runtime,
    );

    expect(result.isError).toBe(false);
    expect(mockSetupWatchers).toHaveBeenCalledWith(
      {
        watchers: [
          {
            trigger: 'worktree_chat_completion',
            armForNextCompletion: true,
            target: {
              kind: 'worktree_chat',
              projectId: 'project-2',
              worktreeId: 'worktree-9',
              chatId: 'chat-9',
            },
          },
          {
            trigger: 'standalone_chat_completion',
            target: {
              kind: 'standalone_chat',
              projectId: 'cowork-1',
              chatId: 'cowork-chat-1',
            },
          },
          {
            trigger: 'worktree_new_chat_started',
            target: {
              kind: 'worktree_chat_scope',
              projectId: 'project-2',
              worktreeId: 'worktree-9',
            },
          },
          {
            trigger: 'standalone_new_chat_started',
            target: {
              kind: 'standalone_chat_project',
              projectId: 'cowork-1',
            },
          },
        ],
      },
      { projectId: 'project-1', worktreeId: 'worktree-1', chatId: 'chat-1' },
      { toolUseId: undefined },
    );
  });

  it('infers the automation trigger from an automation-shaped setup target', async () => {
    mockSetupWatchers.mockResolvedValue({ ok: true, results: [] });
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers: jest.fn(),
      loadScriptOutput: jest.fn(),
      worktreeWatcherRuntime: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      },
    };

    const result = await executeCanopyInjectedTool(
      'setup_watchers',
      { watchers: [{ target: { automationId: 'auto-1' } }] },
      runtime,
    );

    expect(result.isError).toBe(false);
    expect(mockSetupWatchers).toHaveBeenCalledWith(
      {
        watchers: [
          {
            trigger: 'automation_run',
            target: { kind: 'automation', automationId: 'auto-1' },
          },
        ],
      },
      { projectId: 'project-1', worktreeId: 'worktree-1', chatId: 'chat-1' },
      { toolUseId: undefined },
    );
  });

  it('rejects chat-shaped setup targets without an explicit chat trigger', async () => {
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers: jest.fn(),
      loadScriptOutput: jest.fn(),
      worktreeWatcherRuntime: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      },
    };

    const result = await executeCanopyInjectedTool(
      'setup_watchers',
      {
        watchers: [
          {
            target: {
              projectId: 'project-2',
              worktreeId: 'worktree-9',
              chatId: 'chat-9',
            },
          },
        ],
      },
      runtime,
    );

    expect(result.isError).toBe(true);
    expect(mockSetupWatchers).not.toHaveBeenCalled();
  });

  it('rejects chat triggers whose target is missing required ids', async () => {
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers: jest.fn(),
      loadScriptOutput: jest.fn(),
      worktreeWatcherRuntime: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      },
    };

    const result = await executeCanopyInjectedTool(
      'setup_watchers',
      {
        watchers: [
          {
            trigger: 'worktree_chat_completion',
            target: { projectId: 'project-2' },
          },
        ],
      },
      runtime,
    );

    expect(result.isError).toBe(true);
    expect(mockSetupWatchers).not.toHaveBeenCalled();
  });

  it.each(rootAndDelegateScopes)(
    'refuses explicit App Advisor automation watchers for a $name with the typed code',
    async ({ scope }) => {
      mockFindAutomationActivityForBackgroundAuthorization.mockResolvedValue({
        id: 'advisor-auto',
        action: { type: 'app_advisor_prompt' },
      });
      mockDecideAppAdvisorAccessForCaller.mockResolvedValue({
        allowed: false,
        reason: 'advisor_access_disabled',
      });
      mockSetupWatchers.mockResolvedValue({ ok: true, results: [] });

      const result = await executeCanopyInjectedTool(
        'setup_watchers',
        { watchers: [{ target: { automationId: 'advisor-auto' } }] },
        createAutomationWatcherRuntime(scope),
      );

      expect(result.isError).toBe(true);
      expect(JSON.parse(result.text)).toEqual(
        refusedSetup({
          ok: false,
          error: ADVISOR_ACCESS_DISABLED_MESSAGE,
          code: ADVISOR_ACCESS_DISABLED,
          rejectedIndex: 0,
        }),
      );
      expect(mockSetupWatchers).not.toHaveBeenCalled();
      expect(
        mockFindAutomationActivityForBackgroundAuthorization,
      ).toHaveBeenCalledWith('advisor-auto');
      expect(mockDecideAppAdvisorAccessForCaller).toHaveBeenCalledWith({
        projectId: 'root-project',
        worktreeId: 'root-worktree',
      });
    },
  );

  it('reports owner_unknown with the Advisor disabled code and a confirmation message', async () => {
    mockFindAutomationActivityForBackgroundAuthorization.mockResolvedValue({
      id: 'advisor-auto',
      action: { type: 'app_advisor_prompt' },
    });
    mockDecideAppAdvisorAccessForCaller.mockResolvedValue({
      allowed: false,
      reason: 'owner_unknown',
    });
    mockSetupWatchers.mockResolvedValue({ ok: true, results: [] });

    const result = await executeCanopyInjectedTool(
      'setup_watchers',
      { watchers: [{ target: { automationId: 'advisor-auto' } }] },
      createAutomationWatcherRuntime({
        projectId: 'root-project',
        worktreeId: 'root-worktree',
        chatId: 'root-chat',
      }),
    );

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.text)).toMatchObject({
      ok: false,
      code: ADVISOR_ACCESS_DISABLED,
    });
    expect(result.text).toContain('project owner could not be confirmed');
    expect(mockSetupWatchers).not.toHaveBeenCalled();
  });

  it('refuses a padded Advisor automation id with the same trimmed lookup', async () => {
    mockFindAutomationActivityForBackgroundAuthorization.mockImplementation(
      (id: string) =>
        Promise.resolve(
          id === 'advisor-auto'
            ? { id: 'advisor-auto', action: { type: 'app_advisor_prompt' } }
            : undefined,
        ),
    );
    mockDecideAppAdvisorAccessForCaller.mockResolvedValue({
      allowed: false,
      reason: 'advisor_access_disabled',
    });
    mockSetupWatchers.mockResolvedValue({ ok: true, results: [] });

    const result = await executeCanopyInjectedTool(
      'setup_watchers',
      { watchers: [{ target: { automationId: '  advisor-auto  ' } }] },
      createAutomationWatcherRuntime({
        projectId: 'root-project',
        worktreeId: 'root-worktree',
        chatId: 'root-chat',
      }),
    );

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.text)).toMatchObject({
      ok: false,
      code: ADVISOR_ACCESS_DISABLED,
    });
    expect(
      mockFindAutomationActivityForBackgroundAuthorization,
    ).toHaveBeenCalledWith('advisor-auto');
    expect(mockSetupWatchers).not.toHaveBeenCalled();
  });

  it('allows Advisor automation watcher setup when the trusted caller is allowed', async () => {
    mockFindAutomationActivityForBackgroundAuthorization.mockResolvedValue({
      id: 'advisor-auto',
      action: { type: 'app_advisor_prompt' },
    });
    mockDecideAppAdvisorAccessForCaller.mockResolvedValue({ allowed: true });
    mockSetupWatchers.mockResolvedValue({ ok: true, results: [] });
    const runtime = createAutomationWatcherRuntime({
      projectId: 'root-project',
      worktreeId: 'root-worktree',
      chatId: 'root-chat',
    });

    const result = await executeCanopyInjectedTool(
      'setup_watchers',
      { watchers: [{ target: { automationId: 'advisor-auto' } }] },
      runtime,
    );

    expect(result.isError).toBe(false);
    expect(
      mockFindAutomationActivityForBackgroundAuthorization,
    ).toHaveBeenCalledWith('advisor-auto');
    expect(mockDecideAppAdvisorAccessForCaller).toHaveBeenCalledWith({
      projectId: 'root-project',
      worktreeId: 'root-worktree',
    });
    expect(mockSetupWatchers).toHaveBeenCalled();
  });

  it('does not gate ordinary automation watchers', async () => {
    mockFindAutomationActivityForBackgroundAuthorization.mockResolvedValue({
      id: 'ordinary-auto',
      action: { type: 'standalone_prompt' },
    });
    mockDecideAppAdvisorAccessForCaller.mockResolvedValue({
      allowed: false,
      reason: 'advisor_access_disabled',
    });
    mockSetupWatchers.mockResolvedValue({ ok: true, results: [] });

    const result = await executeCanopyInjectedTool(
      'setup_watchers',
      { watchers: [{ target: { automationId: 'ordinary-auto' } }] },
      createAutomationWatcherRuntime({
        projectId: 'root-project',
        worktreeId: 'root-worktree',
        chatId: 'root-chat',
      }),
    );

    expect(result.isError).toBe(false);
    expect(
      mockFindAutomationActivityForBackgroundAuthorization,
    ).toHaveBeenCalledWith('ordinary-auto');
    expect(mockDecideAppAdvisorAccessForCaller).not.toHaveBeenCalled();
    expect(mockSetupWatchers).toHaveBeenCalled();
  });

  const automationNotFoundError = (automationId: string): string =>
    `Watcher target automation "${automationId}" was not found. Discover automation ids with the automation.list or automation.get actions.`;

  it.each(automationCallerScopes)(
    'allows same-owner automation watchers for a $name',
    async ({ scope }) => {
      const activity = {
        id: 'ordinary-auto',
        action: { type: 'standalone_prompt' },
      };
      mockFindAutomationActivityForBackgroundAuthorization.mockResolvedValue(
        activity,
      );
      mockSetupWatchers.mockResolvedValue({ ok: true, results: [] });

      const result = await executeCanopyInjectedTool(
        'setup_watchers',
        { watchers: [{ target: { automationId: 'ordinary-auto' } }] },
        createAutomationWatcherRuntime(scope),
      );

      expect(result.isError).toBe(false);
      expect(mockResolveProjectSavedOwner).toHaveBeenCalledWith({
        projectId: scope.projectId,
        worktreeId: scope.worktreeId,
      });
      expect(mockResolveAutomationTargetProject).toHaveBeenCalledWith(
        activity.action,
      );
      expect(mockDecideSameOwnerAccess).toHaveBeenCalledWith(
        { kind: 'personal' },
        { kind: 'project', projectId: 'target-project' },
      );
      expect(mockSetupWatchers).toHaveBeenCalled();
    },
  );

  it.each(automationCallerScopes)(
    'hides a different-owner automation exactly like a missing id for a $name',
    async ({ scope }) => {
      const activity = {
        id: 'other-auto',
        action: { type: 'standalone_prompt' },
      };
      mockFindAutomationActivityForBackgroundAuthorization
        .mockResolvedValueOnce(activity)
        .mockResolvedValueOnce(undefined);
      mockDecideSameOwnerAccess.mockResolvedValue({ kind: 'hidden' });
      mockSetupWatchers.mockResolvedValue({
        ok: false,
        error: automationNotFoundError('other-auto'),
        rejectedIndex: 0,
      });

      const args = {
        watchers: [{ target: { automationId: 'other-auto' } }],
      };
      const runtime = createAutomationWatcherRuntime(scope);
      const otherOwner = await executeCanopyInjectedTool(
        'setup_watchers',
        args,
        runtime,
      );
      expect(mockSetupWatchers).not.toHaveBeenCalled();

      const missingId = await executeCanopyInjectedTool(
        'setup_watchers',
        args,
        runtime,
      );

      expect(otherOwner).toEqual(missingId);
      expect(otherOwner.isError).toBe(true);
      expect(JSON.parse(otherOwner.text)).toEqual(
        refusedSetup({
          ok: false,
          error: automationNotFoundError('other-auto'),
          rejectedIndex: 0,
        }),
      );
      expect(otherOwner.text).not.toContain('owner');
      expect(otherOwner.text).not.toContain('advisor_access_disabled');
    },
  );

  it.each(automationCallerScopes)(
    'treats an automation with an unknown target as hidden for a $name',
    async ({ scope }) => {
      mockFindAutomationActivityForBackgroundAuthorization
        .mockResolvedValueOnce({
          id: 'unknown-target-auto',
          action: { type: 'standalone_prompt' },
        })
        .mockResolvedValueOnce(undefined);
      mockResolveAutomationTargetProject.mockReturnValue({ kind: 'unknown' });
      mockSetupWatchers.mockResolvedValue({
        ok: false,
        error: automationNotFoundError('unknown-target-auto'),
        rejectedIndex: 0,
      });

      const args = {
        watchers: [{ target: { automationId: 'unknown-target-auto' } }],
      };
      const runtime = createAutomationWatcherRuntime(scope);
      const hiddenTarget = await executeCanopyInjectedTool(
        'setup_watchers',
        args,
        runtime,
      );
      const missingId = await executeCanopyInjectedTool(
        'setup_watchers',
        args,
        runtime,
      );

      expect(hiddenTarget).toEqual(missingId);
      expect(mockDecideSameOwnerAccess).not.toHaveBeenCalled();
    },
  );

  it.each(automationCallerScopes)(
    'reports unavailable owner context for caller or target on a $name',
    async ({ scope }) => {
      for (const outcome of [
        {
          owner: { kind: 'unknown' } as const,
          decision: { kind: 'caller_owner_unknown' } as const,
        },
        {
          owner: { kind: 'personal' } as const,
          decision: { kind: 'target_owner_unknown' } as const,
        },
      ]) {
        mockFindAutomationActivityForBackgroundAuthorization.mockResolvedValue({
          id: 'ordinary-auto',
          action: { type: 'standalone_prompt' },
        });
        mockResolveProjectSavedOwner.mockResolvedValue(outcome.owner);
        mockDecideSameOwnerAccess.mockResolvedValue(outcome.decision);

        const result = await executeCanopyInjectedTool(
          'setup_watchers',
          { watchers: [{ target: { automationId: 'ordinary-auto' } }] },
          createAutomationWatcherRuntime(scope),
        );

        expect(result.isError).toBe(true);
        expect(JSON.parse(result.text)).toEqual(
          refusedSetup({
            ok: false,
            error:
              'The project owner could not be confirmed, so automation watcher access is denied for safety.',
            code: 'owner_context_unavailable',
            rejectedIndex: 0,
          }),
        );
        expect(mockSetupWatchers).not.toHaveBeenCalled();
        mockResolveProjectSavedOwner.mockResolvedValue({ kind: 'personal' });
        mockDecideSameOwnerAccess.mockResolvedValue({ kind: 'allowed' });
      }
    },
  );

  it.each(automationCallerScopes)(
    'allows same-owner inline automation.create watchers for a $name',
    async ({ scope }) => {
      const dispatch = jest
        .spyOn(worktreeActions, 'dispatchWorktreeAction')
        .mockResolvedValue({
          requestId: 'req-create',
          ok: true,
          result: { activity: { id: 'created-auto', enabled: false } },
        });
      mockFindAutomationActivityForBackgroundAuthorization.mockResolvedValue({
        id: 'created-auto',
        action: { type: 'worktree_prompt' },
      });
      mockSetupWatchers.mockResolvedValue({ ok: true, results: [] });

      const result = await executeCanopyInjectedTool(
        'dispatch_action',
        {
          action: {
            type: 'automation.create',
            input: {
              name: 'Created',
              schedule: {
                kind: 'cron',
                expression: '0 3 * * *',
                timezone: 'local',
              },
              action: {
                type: 'standalone_prompt',
                chatProjectId: 'target',
                prompt: 'Run',
              },
            },
            watchers: [{}],
          },
        },
        createAutomationWatcherRuntime(scope),
      );

      expect(result.isError).toBe(false);
      expect(JSON.parse(result.text)).toMatchObject({
        ok: true,
        result: { inlineWatcherSetup: { ok: true } },
      });
      expect(mockSetupWatchers).toHaveBeenCalled();
      dispatch.mockRestore();
    },
  );

  it.each(automationCallerScopes)(
    'hides a different-owner automation.create watcher like a missing id for a $name',
    async ({ scope }) => {
      const dispatch = jest
        .spyOn(worktreeActions, 'dispatchWorktreeAction')
        .mockResolvedValue({
          requestId: 'req-create',
          ok: true,
          result: { activity: { id: 'created-auto', enabled: false } },
        });
      mockFindAutomationActivityForBackgroundAuthorization
        .mockResolvedValueOnce({
          id: 'created-auto',
          action: { type: 'standalone_prompt' },
        })
        .mockResolvedValueOnce(undefined);
      mockDecideSameOwnerAccess.mockResolvedValue({ kind: 'hidden' });
      mockSetupWatchers.mockResolvedValue({
        ok: false,
        error: automationNotFoundError('created-auto'),
        rejectedIndex: 0,
      });
      const args = {
        action: {
          type: 'automation.create' as const,
          input: {
            name: 'Created',
            schedule: {
              kind: 'cron' as const,
              expression: '0 3 * * *',
              timezone: 'local',
            },
            action: {
              type: 'standalone_prompt' as const,
              chatProjectId: 'target',
              prompt: 'Run',
            },
          },
          watchers: [{}],
        },
      };
      const runtime = createAutomationWatcherRuntime(scope);
      const otherOwner = await executeCanopyInjectedTool(
        'dispatch_action',
        args,
        runtime,
      );
      const missingId = await executeCanopyInjectedTool(
        'dispatch_action',
        args,
        runtime,
      );

      expect(otherOwner).toEqual(missingId);
      expect(otherOwner.isError).toBe(false);
      expect(JSON.parse(otherOwner.text)).toMatchObject({
        ok: true,
        result: {
          inlineWatcherSetup: {
            ok: false,
            error: automationNotFoundError('created-auto'),
          },
        },
      });
      dispatch.mockRestore();
    },
  );

  it.each(automationCallerScopes)(
    'allows same-owner run_now pre-arming for a $name',
    async ({ scope }) => {
      const dispatch = jest
        .spyOn(worktreeActions, 'dispatchWorktreeAction')
        .mockResolvedValue({
          requestId: 'req-run',
          ok: true,
          result: { run: { id: 'run-1', status: 'success' } },
        });
      mockFindAutomationActivityForBackgroundAuthorization.mockResolvedValue({
        id: 'auto-run',
        action: { type: 'standalone_prompt' },
      });
      mockSetupWatchers.mockResolvedValue({ ok: true, results: [] });

      const result = await executeCanopyInjectedTool(
        'dispatch_action',
        {
          action: {
            type: 'automation.run_now',
            id: 'auto-run',
            watchers: [{}],
          },
        },
        createAutomationWatcherRuntime(scope),
      );

      expect(result.isError).toBe(false);
      expect(JSON.parse(result.text)).toMatchObject({
        ok: true,
        result: { inlineWatcherSetup: { ok: true } },
      });
      expect(dispatch).toHaveBeenCalled();
      dispatch.mockRestore();
    },
  );

  it.each(automationCallerScopes)(
    'hides a different-owner run_now watcher like a missing id for a $name',
    async ({ scope }) => {
      const dispatch = jest.spyOn(worktreeActions, 'dispatchWorktreeAction');
      mockFindAutomationActivityForBackgroundAuthorization
        .mockResolvedValueOnce({
          id: 'auto-run',
          action: { type: 'standalone_prompt' },
        })
        .mockResolvedValueOnce(undefined);
      mockDecideSameOwnerAccess.mockResolvedValue({ kind: 'hidden' });
      mockSetupWatchers.mockResolvedValue({
        ok: false,
        error: automationNotFoundError('auto-run'),
        rejectedIndex: 0,
      });
      const args = {
        action: {
          type: 'automation.run_now' as const,
          id: 'auto-run',
          watchers: [{}],
        },
      };
      const runtime = createAutomationWatcherRuntime(scope);
      const otherOwner = await executeCanopyInjectedTool(
        'dispatch_action',
        args,
        runtime,
      );
      const missingId = await executeCanopyInjectedTool(
        'dispatch_action',
        args,
        runtime,
      );

      expect(otherOwner).toEqual(missingId);
      expect(otherOwner.isError).toBe(true);
      expect(JSON.parse(otherOwner.text)).toEqual({
        ok: false,
        error: `Inline watcher setup failed, so the automation was not run: ${automationNotFoundError('auto-run')}`,
      });
      expect(dispatch).not.toHaveBeenCalled();
      dispatch.mockRestore();
    },
  );

  it.each(automationCallerScopes)(
    'uses owner_context_unavailable for caller/target uncertainty on inline and run_now paths for a $name',
    async ({ scope }) => {
      for (const outcome of [
        {
          owner: { kind: 'unknown' } as const,
          decision: { kind: 'caller_owner_unknown' } as const,
        },
        {
          owner: { kind: 'personal' } as const,
          decision: { kind: 'target_owner_unknown' } as const,
        },
      ]) {
        const dispatch = jest
          .spyOn(worktreeActions, 'dispatchWorktreeAction')
          .mockResolvedValue({
            requestId: 'req',
            ok: true,
            result: { activity: { id: 'owner-auto', enabled: false } },
          });
        mockFindAutomationActivityForBackgroundAuthorization.mockResolvedValue({
          id: 'owner-auto',
          action: { type: 'standalone_prompt' },
        });
        mockResolveProjectSavedOwner.mockResolvedValue(outcome.owner);
        mockDecideSameOwnerAccess.mockResolvedValue(outcome.decision);

        const createResult = await executeCanopyInjectedTool(
          'dispatch_action',
          {
            action: {
              type: 'automation.create',
              input: {
                name: 'Owner test',
                schedule: {
                  kind: 'cron',
                  expression: '0 3 * * *',
                  timezone: 'local',
                },
                action: {
                  type: 'standalone_prompt',
                  chatProjectId: 'target',
                  prompt: 'Run',
                },
              },
              watchers: [{}],
            },
          },
          createAutomationWatcherRuntime(scope),
        );

        expect(createResult.isError).toBe(false);
        expect(JSON.parse(createResult.text)).toMatchObject({
          result: {
            inlineWatcherSetup: {
              ok: false,
              code: 'owner_context_unavailable',
              error:
                'The project owner could not be confirmed, so automation watcher access is denied for safety.',
            },
          },
        });
        dispatch.mockRestore();

        const runDispatch = jest.spyOn(
          worktreeActions,
          'dispatchWorktreeAction',
        );
        mockFindAutomationActivityForBackgroundAuthorization.mockResolvedValue({
          id: 'owner-auto',
          action: { type: 'standalone_prompt' },
        });
        const runResult = await executeCanopyInjectedTool(
          'dispatch_action',
          {
            action: {
              type: 'automation.run_now',
              id: 'owner-auto',
              watchers: [{}],
            },
          },
          createAutomationWatcherRuntime(scope),
        );
        expect(runResult.isError).toBe(true);
        expect(runResult.text).toContain('owner_context_unavailable');
        expect(runResult.text).toContain(
          'project owner could not be confirmed',
        );
        expect(runDispatch).not.toHaveBeenCalled();
        runDispatch.mockRestore();

        mockResolveProjectSavedOwner.mockResolvedValue({ kind: 'personal' });
        mockDecideSameOwnerAccess.mockResolvedValue({ kind: 'allowed' });
      }
    },
  );

  it('exempts the App Advisor project from the caller access gate', async () => {
    mockSetupWatchers.mockResolvedValue({ ok: true, results: [] });

    const result = await executeCanopyInjectedTool(
      'setup_watchers',
      { watchers: [{ target: { automationId: 'advisor-auto' } }] },
      createAutomationWatcherRuntime({
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'advisor-entry',
        chatId: 'advisor-chat',
      }),
    );

    expect(result.isError).toBe(false);
    expect(mockDecideAppAdvisorAccessForCaller).not.toHaveBeenCalled();
    expect(
      mockFindAutomationActivityForBackgroundAuthorization,
    ).not.toHaveBeenCalled();
    expect(mockSetupWatchers).toHaveBeenCalled();
  });

  it.each(rootAndDelegateScopes)(
    'returns the typed refusal in inlineWatcherSetup for a $name creating an Advisor automation',
    async ({ scope }) => {
      const dispatch = jest
        .spyOn(worktreeActions, 'dispatchWorktreeAction')
        .mockResolvedValue({
          requestId: '',
          ok: true,
          result: {
            activity: { id: 'advisor-auto', name: 'Advisor', enabled: false },
          },
        });
      mockFindAutomationActivityForBackgroundAuthorization.mockResolvedValue({
        id: 'advisor-auto',
        action: { type: 'app_advisor_prompt' },
      });
      mockDecideAppAdvisorAccessForCaller.mockResolvedValue({
        allowed: false,
        reason: 'advisor_access_disabled',
      });
      mockSetupWatchers.mockResolvedValue({ ok: true, results: [] });

      const result = await executeCanopyInjectedTool(
        'dispatch_action',
        {
          action: {
            type: 'automation.create',
            input: {
              name: 'Advisor',
              schedule: {
                kind: 'cron',
                expression: '0 3 * * *',
                timezone: 'local',
              },
              action: {
                type: 'app_advisor_prompt',
                prompt: 'Review this project.',
              },
            },
            watchers: [{}],
          },
        },
        createAutomationWatcherRuntime(scope),
      );

      expect(result.isError).toBe(false);
      expect(JSON.parse(result.text)).toMatchObject({
        ok: true,
        result: {
          activity: { enabled: false },
          inlineWatcherSetup: {
            ok: false,
            error: ADVISOR_ACCESS_DISABLED_MESSAGE,
            code: ADVISOR_ACCESS_DISABLED,
          },
        },
      });
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(dispatch.mock.calls[0]?.[0].action).toMatchObject({
        type: 'automation.create',
        input: { enabled: false },
      });
      expect(mockSetupWatchers).not.toHaveBeenCalled();
      expect(
        mockFindAutomationActivityForBackgroundAuthorization,
      ).toHaveBeenCalledWith('advisor-auto');
      expect(mockDecideAppAdvisorAccessForCaller).toHaveBeenCalledWith({
        projectId: 'root-project',
        worktreeId: 'root-worktree',
      });
      dispatch.mockRestore();
    },
  );

  it('preserves the Advisor refusal code when run_now pre-arming fails', async () => {
    const dispatch = jest.spyOn(worktreeActions, 'dispatchWorktreeAction');
    mockFindAutomationActivityForBackgroundAuthorization.mockResolvedValue({
      id: 'advisor-auto',
      action: { type: 'app_advisor_prompt' },
    });
    mockDecideAppAdvisorAccessForCaller.mockResolvedValue({
      allowed: false,
      reason: 'advisor_access_disabled',
    });

    const result = await executeCanopyInjectedTool(
      'dispatch_action',
      {
        action: {
          type: 'automation.run_now',
          id: 'advisor-auto',
          watchers: [{}],
        },
      },
      createAutomationWatcherRuntime({
        projectId: 'root-project',
        worktreeId: 'root-worktree',
        chatId: 'root-chat',
        delegationId: 'delegate-1',
      }),
    );

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.text)).toMatchObject({
      ok: false,
      code: ADVISOR_ACCESS_DISABLED,
    });
    expect(
      mockFindAutomationActivityForBackgroundAuthorization,
    ).toHaveBeenCalledWith('advisor-auto');
    expect(result.text).toContain('the automation was not run');
    expect(dispatch).not.toHaveBeenCalled();
    expect(mockSetupWatchers).not.toHaveBeenCalled();
    expect(mockDecideAppAdvisorAccessForCaller).toHaveBeenCalledWith({
      projectId: 'root-project',
      worktreeId: 'root-worktree',
    });
    dispatch.mockRestore();
  });

  it('does not gate automation.run_now execution unless inline watcher setup is requested', async () => {
    const dispatch = jest
      .spyOn(worktreeActions, 'dispatchWorktreeAction')
      .mockResolvedValue({
        requestId: '',
        ok: true,
        result: { run: { id: 'run-1', status: 'success' } },
      });

    const result = await executeCanopyInjectedTool(
      'dispatch_action',
      { action: { type: 'automation.run_now', id: 'advisor-auto' } },
      createAutomationWatcherRuntime({
        projectId: 'root-project',
        worktreeId: 'root-worktree',
        chatId: 'root-chat',
      }),
    );

    expect(result.isError).toBe(false);
    expect(dispatch).toHaveBeenCalled();
    expect(mockDecideAppAdvisorAccessForCaller).not.toHaveBeenCalled();
    expect(
      mockFindAutomationActivityForBackgroundAuthorization,
    ).not.toHaveBeenCalled();
    dispatch.mockRestore();
  });

  it('rejects chat-shaped setup targets without an explicit chat trigger', async () => {
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers: jest.fn(),
      loadScriptOutput: jest.fn(),
      worktreeWatcherRuntime: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      },
    };

    const result = await executeCanopyInjectedTool(
      'setup_watchers',
      {
        watchers: [
          {
            target: {
              projectId: 'project-2',
              worktreeId: 'worktree-9',
              chatId: 'chat-9',
            },
          },
        ],
      },
      runtime,
    );

    expect(result.isError).toBe(true);
    expect(mockSetupWatchers).not.toHaveBeenCalled();
  });

  it('rejects chat triggers whose target is missing required ids', async () => {
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers: jest.fn(),
      loadScriptOutput: jest.fn(),
      worktreeWatcherRuntime: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      },
    };

    const result = await executeCanopyInjectedTool(
      'setup_watchers',
      {
        watchers: [
          {
            trigger: 'worktree_chat_completion',
            target: { projectId: 'project-2' },
          },
        ],
      },
      runtime,
    );

    expect(result.isError).toBe(true);
    expect(mockSetupWatchers).not.toHaveBeenCalled();
  });
  it('arms inline automation watchers before dispatching automation.run_now', async () => {
    const dispatch = jest
      .spyOn(worktreeActions, 'dispatchWorktreeAction')
      .mockResolvedValue({
        requestId: '',
        ok: true,
        result: { run: { id: 'run-1', status: 'success' } },
      });
    mockSetupWatchers.mockResolvedValue({
      ok: true,
      results: [
        {
          status: 'created',
          watcher: {
            id: 'watcher-1',
            trigger: 'automation_run',
            status: 'active',
            label: 'Automation run completion: auto-1',
            target: { kind: 'automation', automationId: 'auto-1' },
            destination: {
              projectId: 'project-1',
              worktreeId: 'worktree-1',
              chatId: 'chat-1',
            },
            createdAt: '2026-08-18T00:00:00.000Z',
          },
        },
      ],
    });
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers: jest.fn(),
      loadScriptOutput: jest.fn(),
      worktreeActionRuntime: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        cwd: '/repo',
        getWindow: () => null,
      },
      worktreeWatcherRuntime: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      },
    };

    const result = await executeCanopyInjectedTool(
      'dispatch_action',
      {
        action: {
          type: 'automation.run_now',
          id: 'auto-1',
          watchers: [{ followUpInstruction: 'Report the outcome.' }],
        },
      },
      runtime,
      { toolUseId: 'tool-call-9' },
    );

    expect(result.isError).toBe(false);
    expect(mockSetupWatchers).toHaveBeenCalledWith(
      {
        watchers: [
          {
            trigger: 'automation_run',
            target: { kind: 'automation', automationId: 'auto-1' },
            followUpInstruction: 'Report the outcome.',
          },
        ],
      },
      { projectId: 'project-1', worktreeId: 'worktree-1', chatId: 'chat-1' },
      { toolUseId: 'tool-call-9' },
    );
    // Arm-before-dispatch: run_now completes the dispatched run before it
    // returns, so a watcher armed afterwards would miss the run event.
    const setupOrder = mockSetupWatchers.mock.invocationCallOrder[0] ?? 0;
    const dispatchOrder = dispatch.mock.invocationCallOrder[0] ?? 0;
    expect(setupOrder).toBeLessThan(dispatchOrder);
    expect(JSON.parse(result.text)).toMatchObject({
      ok: true,
      result: {
        run: { id: 'run-1' },
        inlineWatcherSetup: { ok: true },
      },
    });
    dispatch.mockRestore();
  });

  it('dispatches automation.run_now non-fatally when no watcher destination exists on the surface', async () => {
    // Surfaces without a watcher runtime (no worktreeWatcherRuntime) cannot
    // arm ANY watcher, so blocking the run there would make run_now+watchers
    // permanently unusable. Dispatch and report the limitation instead.
    const dispatch = jest
      .spyOn(worktreeActions, 'dispatchWorktreeAction')
      .mockResolvedValue({
        requestId: 'req-1',
        ok: true,
        result: { run: { id: 'run-1', status: 'success' } },
      });
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers: jest.fn(),
      loadScriptOutput: jest.fn(),
      worktreeActionRuntime: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        cwd: '/repo',
        getWindow: () => null,
      },
    };

    const result = await executeCanopyInjectedTool(
      'dispatch_action',
      {
        action: { type: 'automation.run_now', id: 'auto-1', watchers: [{}] },
      },
      runtime,
    );

    expect(dispatch).toHaveBeenCalled();
    expect(result.isError).toBe(false);
    expect(result.text).toContain('inlineWatcherSetup');
    expect(result.text).toContain('only available for worktree chats');
    expect(mockSetupWatchers).not.toHaveBeenCalled();
    dispatch.mockRestore();
  });

  it('does not dispatch automation.run_now when inline watcher arming fails', async () => {
    const dispatch = jest.spyOn(worktreeActions, 'dispatchWorktreeAction');
    mockSetupWatchers.mockResolvedValue({
      ok: false,
      error: 'This chat already has the maximum number of active watchers.',
    });
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers: jest.fn(),
      loadScriptOutput: jest.fn(),
      worktreeActionRuntime: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        cwd: '/repo',
        getWindow: () => null,
      },
      worktreeWatcherRuntime: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      },
    };

    const result = await executeCanopyInjectedTool(
      'dispatch_action',
      {
        action: {
          type: 'automation.run_now',
          id: 'auto-1',
          watchers: [{}],
        },
      },
      runtime,
    );

    expect(dispatch).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.text).toContain('the automation was not run');
    expect(result.text).toContain('maximum number of active watchers');
    dispatch.mockRestore();
  });

  it('deletes inline run_now watchers when the dispatch fails', async () => {
    const dispatch = jest
      .spyOn(worktreeActions, 'dispatchWorktreeAction')
      .mockResolvedValue({
        requestId: '',
        ok: false,
        error: { code: 'not_found', message: 'Activity auto-1 was not found.' },
      });
    mockSetupWatchers.mockResolvedValue({
      ok: true,
      results: [
        {
          status: 'created',
          watcher: {
            id: 'watcher-1',
            trigger: 'automation_run',
            status: 'active',
            label: 'Automation run completion: auto-1',
            target: { kind: 'automation', automationId: 'auto-1' },
            destination: {
              projectId: 'project-1',
              worktreeId: 'worktree-1',
              chatId: 'chat-1',
            },
            createdAt: '2026-08-18T00:00:00.000Z',
          },
        },
      ],
    });
    mockDeleteAgentWatchers.mockResolvedValue({
      ok: true,
      results: [{ watcherId: 'watcher-1', status: 'deleted' }],
    });
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers: jest.fn(),
      loadScriptOutput: jest.fn(),
      worktreeActionRuntime: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        cwd: '/repo',
        getWindow: () => null,
      },
      worktreeWatcherRuntime: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      },
    };

    const result = await executeCanopyInjectedTool(
      'dispatch_action',
      {
        action: {
          type: 'automation.run_now',
          id: 'auto-1',
          watchers: [{}],
        },
      },
      runtime,
      { toolUseId: 'tool-call-9' },
    );

    expect(result.isError).toBe(true);
    expect(mockDeleteAgentWatchers).toHaveBeenCalledWith(
      { watcherIds: ['watcher-1'] },
      { projectId: 'project-1', worktreeId: 'worktree-1', chatId: 'chat-1' },
    );
    dispatch.mockRestore();
  });

  it('creates automation disabled, arms its watcher, then enables it', async () => {
    const dispatch = jest
      .spyOn(worktreeActions, 'dispatchWorktreeAction')
      .mockResolvedValueOnce({
        requestId: '',
        ok: true,
        result: {
          activity: { id: 'auto-created', name: 'Created', enabled: false },
        },
      })
      .mockResolvedValueOnce({
        requestId: '',
        ok: true,
        result: {
          activity: { id: 'auto-created', name: 'Created', enabled: true },
        },
      });
    mockSetupWatchers.mockResolvedValue({ ok: true, results: [] });
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers: jest.fn(),
      loadScriptOutput: jest.fn(),
      worktreeActionRuntime: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        cwd: '/repo',
        getWindow: () => null,
      },
      worktreeWatcherRuntime: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      },
    };

    const result = await executeCanopyInjectedTool(
      'dispatch_action',
      {
        action: {
          type: 'automation.create',
          input: {
            name: 'Nightly',
            schedule: {
              kind: 'cron',
              expression: '0 3 * * *',
              timezone: 'local',
            },
            action: {
              type: 'standalone_prompt',
              chatProjectId: 'cowork-1',
              prompt: 'Run the nightly sweep',
            },
          },
          watchers: [{}],
        },
      },
      runtime,
      { toolUseId: 'tool-call-9' },
    );

    expect(result.isError).toBe(false);
    expect(mockSetupWatchers).toHaveBeenCalledWith(
      {
        watchers: [
          {
            trigger: 'automation_run',
            target: { kind: 'automation', automationId: 'auto-created' },
          },
        ],
      },
      { projectId: 'project-1', worktreeId: 'worktree-1', chatId: 'chat-1' },
      { toolUseId: 'tool-call-9' },
    );
    expect(dispatch.mock.calls[0]?.[0].action).toMatchObject({
      type: 'automation.create',
      input: { enabled: false },
    });
    expect(dispatch.mock.calls[0]?.[1]).toBe(runtime.worktreeActionRuntime);
    expect(dispatch.mock.calls[1]?.[0].action).toEqual({
      type: 'automation.update',
      id: 'auto-created',
      patch: { enabled: true },
    });
    expect(dispatch.mock.calls[1]?.[1]).toBe(runtime.worktreeActionRuntime);
    const createOrder = dispatch.mock.invocationCallOrder[0] ?? 0;
    const setupOrder = mockSetupWatchers.mock.invocationCallOrder[0] ?? 0;
    const enableOrder = dispatch.mock.invocationCallOrder[1] ?? 0;
    expect(createOrder).toBeLessThan(setupOrder);
    expect(setupOrder).toBeLessThan(enableOrder);
    expect(JSON.parse(result.text)).toMatchObject({
      ok: true,
      result: {
        activity: { id: 'auto-created', enabled: true },
        inlineWatcherSetup: { ok: true },
      },
    });
    dispatch.mockRestore();
  });

  it('preserves hook triggerName when setting up worktree hook watchers', async () => {
    mockSetupWatchers.mockResolvedValue({
      ok: true,
      results: [],
    });
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers: jest.fn(),
      loadScriptOutput: jest.fn(),
      worktreeWatcherRuntime: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      },
    };

    const result = await executeCanopyInjectedTool(
      'setup_watchers',
      {
        watchers: [
          {
            trigger: 'worktree_hook_triggered',
            target: {
              hookKey: 'project:pr:update:comments',
              triggerName: 'pr:update:comments',
            },
          },
        ],
      },
      runtime,
      { toolUseId: 'tool-call-1' },
    );

    expect(result.isError).toBe(false);
    expect(mockSetupWatchers).toHaveBeenCalledWith(
      {
        watchers: [
          {
            trigger: 'worktree_hook_triggered',
            target: {
              kind: 'worktree_hook',
              projectId: 'project-1',
              worktreeId: 'worktree-1',
              hookKey: 'project:pr:update:comments',
              triggerName: 'pr:update:comments',
            },
          },
        ],
      },
      { projectId: 'project-1', worktreeId: 'worktree-1', chatId: 'chat-1' },
      { toolUseId: 'tool-call-1' },
    );
  });

  it('infers hook watcher trigger from a hook-shaped setup target', async () => {
    mockSetupWatchers.mockResolvedValue({
      ok: true,
      results: [],
    });
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers: jest.fn(),
      loadScriptOutput: jest.fn(),
      worktreeWatcherRuntime: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      },
    };

    const result = await executeCanopyInjectedTool(
      'setup_watchers',
      {
        watchers: [
          {
            target: {
              triggerName: 'pr:update:comments',
            },
          },
        ],
      },
      runtime,
    );

    expect(result.isError).toBe(false);
    expect(mockSetupWatchers).toHaveBeenCalledWith(
      {
        watchers: [
          {
            trigger: 'worktree_hook_triggered',
            target: {
              kind: 'worktree_hook',
              projectId: 'project-1',
              worktreeId: 'worktree-1',
              triggerName: 'pr:update:comments',
            },
          },
        ],
      },
      { projectId: 'project-1', worktreeId: 'worktree-1', chatId: 'chat-1' },
      { toolUseId: undefined },
    );
  });

  it('rejects malformed hook-shaped setup targets instead of treating them as pipeline watchers', async () => {
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers: jest.fn(),
      loadScriptOutput: jest.fn(),
      worktreeWatcherRuntime: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      },
    };

    const result = await executeCanopyInjectedTool(
      'setup_watchers',
      {
        watchers: [
          {
            target: {
              triggerName: 'pr:update:comment',
            },
          },
        ],
      },
      runtime,
    );

    expect(result).toEqual({
      text: 'Invalid arguments for SetupWatchers.',
      isError: true,
    });
    expect(mockSetupWatchers).not.toHaveBeenCalled();
  });

  it('rejects hook-shaped setup targets paired with the pipeline watcher trigger', async () => {
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers: jest.fn(),
      loadScriptOutput: jest.fn(),
      worktreeWatcherRuntime: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      },
    };

    const result = await executeCanopyInjectedTool(
      'setup_watchers',
      {
        watchers: [
          {
            trigger: 'worktree_pipeline_completion',
            target: {
              triggerName: 'pr:update:comments',
            },
          },
        ],
      },
      runtime,
    );

    expect(result).toEqual({
      text: 'Invalid arguments for SetupWatchers.',
      isError: true,
    });
    expect(mockSetupWatchers).not.toHaveBeenCalled();
  });

  it('rejects watcher setup entries without an explicit target filter', async () => {
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers: jest.fn(),
      loadScriptOutput: jest.fn(),
      worktreeWatcherRuntime: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      },
    };

    const result = await executeCanopyInjectedTool(
      'setup_watchers',
      {
        watchers: [
          {
            followUpInstruction: 'Check the test results and report',
          },
        ],
      },
      runtime,
    );

    expect(result).toEqual({
      text: 'Invalid arguments for SetupWatchers.',
      isError: true,
    });
    expect(mockSetupWatchers).not.toHaveBeenCalled();
  });

  it('rejects watcher setup entries with an empty target filter', async () => {
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers: jest.fn(),
      loadScriptOutput: jest.fn(),
      worktreeWatcherRuntime: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      },
    };

    const result = await executeCanopyInjectedTool(
      'setup_watchers',
      {
        watchers: [
          {
            target: {},
            followUpInstruction: 'Check the test results and report',
          },
        ],
      },
      runtime,
    );

    expect(result).toEqual({
      text: [
        'Invalid arguments for SetupWatchers.',
        '- SetupWatchers requires target.executionId, target.pipelineId, or target.terminalStatuses.',
      ].join('\n'),
      isError: true,
    });
    expect(mockSetupWatchers).not.toHaveBeenCalled();
  });

  it('rejects malformed WatchGitHubItems arguments before calling the service', async () => {
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers: jest.fn(),
      loadScriptOutput: jest.fn(),
      worktreeWatcherRuntime: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      },
    };

    const result = await executeCanopyInjectedTool(
      'watch_github_items',
      {
        items: [{ kind: 'workflow_run', repository: 'not-a-repo', runId: 'x' }],
        notifyOn: {},
      },
      runtime,
    );

    expect(result).toEqual({
      text:
        'Invalid arguments for WatchGitHubItems.\n' +
        '- notifyOn: Select notifyOn.run or notifyOn.jobs for workflow runs, or notifyOn.queue for pull requests.\n' +
        '- For every completed job use {"notifyOn":{"jobs":{"conclusions":"any"}}}.',
      isError: true,
    });
    expect(mockWatchGitHubItems).not.toHaveBeenCalled();
  });

  it('deletes agent-created watchers through the captured worktree-chat destination', async () => {
    const runtime: CanopyInjectedToolRuntime = {
      requestUserAnswers: jest.fn(),
      loadScriptOutput: jest.fn(),
      worktreeWatcherRuntime: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      },
    };
    mockDeleteAgentWatchers.mockResolvedValue({
      ok: true,
      results: [{ watcherId: 'watcher-1', status: 'deleted' }],
    });

    const result = await executeCanopyInjectedTool(
      'delete_watchers',
      { watcherIds: ['watcher-1'] },
      runtime,
    );

    expect(mockDeleteAgentWatchers).toHaveBeenCalledWith(
      { watcherIds: ['watcher-1'] },
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      },
    );
    expect(result).toEqual({
      text: JSON.stringify({
        ok: true,
        results: [{ watcherId: 'watcher-1', status: 'deleted' }],
      }),
    });
  });

  it('rejects duplicate DeleteWatchers ids before calling the service', async () => {
    const result = await executeCanopyInjectedTool(
      'delete_watchers',
      { watcherIds: ['watcher-1', 'watcher-1'] },
      {
        requestUserAnswers: jest.fn(),
        loadScriptOutput: jest.fn(),
        worktreeWatcherRuntime: {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
        },
      },
    );

    expect(result).toEqual({
      text: 'Invalid arguments for DeleteWatchers.',
      isError: true,
    });
    expect(mockDeleteAgentWatchers).not.toHaveBeenCalled();
  });

  describe('code graph tools', () => {
    const codeGraphRuntime = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
    };

    function runtimeWithCodeGraph(): CanopyInjectedToolRuntime {
      return {
        requestUserAnswers: jest.fn(),
        loadScriptOutput: jest.fn(),
        codeGraphRuntime,
      };
    }

    function runtimeWithoutCodeGraph(): CanopyInjectedToolRuntime {
      return {
        requestUserAnswers: jest.fn(),
        loadScriptOutput: jest.fn(),
      };
    }

    it('returns the disabled error for a code-graph tool and never delegates when the feature flag is off', async () => {
      mockIsEnabled.mockReturnValue(false);

      const result = await executeCanopyInjectedTool(
        'get_code_graph_context',
        {},
        runtimeWithCodeGraph(),
      );

      expect(result).toEqual({
        text: 'Code graph tools are not available for this project.',
        isError: true,
      });
      expect(mockGetCodeGraphContext).not.toHaveBeenCalled();
    });

    it('still executes non-code-graph tools when the code-graph feature flag is off', async () => {
      mockIsEnabled.mockReturnValue(false);
      const setAutoArchiveForCurrentChat = jest.fn();
      const runtime: CanopyInjectedToolRuntime = {
        requestUserAnswers: jest.fn(),
        loadScriptOutput: jest.fn(),
        setAutoArchiveForCurrentChat,
      };

      const result = await executeCanopyInjectedTool(
        'set_auto_archive',
        { enabled: true },
        runtime,
      );

      expect(result.isError).toBeUndefined();
      expect(setAutoArchiveForCurrentChat).toHaveBeenCalledWith(true);
    });

    it('delegates GetCodeGraphContext to the code graph runtime', async () => {
      const contextResult: CodeGraphContextResult = {
        status: 'ok',
        summary: 'Code graph: 1 file(s), 2 symbol(s), 3 edge(s).',
        truncated: false,
        suggestedNextTools: ['QueryCodeGraph', 'SearchCodeGraph'],
        hasGraph: true,
        lastBuildAt: 1700000000000,
        fileCount: 1,
        symbolCount: 2,
        edgeCount: 3,
        unresolvedEdgeCount: 0,
        filesWithErrors: 0,
        repositories: [{ repoId: 'workspace-root', fileCount: 1 }],
        communityCount: 0,
        flowCount: 0,
        derivedAt: null,
        topCommunities: [],
      };
      mockGetCodeGraphContext.mockResolvedValue(contextResult);

      const result = await executeCanopyInjectedTool(
        'get_code_graph_context',
        {},
        runtimeWithCodeGraph(),
      );

      expect(mockGetCodeGraphContext).toHaveBeenCalledWith(codeGraphRuntime);
      expect(result).toEqual({
        text: JSON.stringify(contextResult, null, 2),
        isError: false,
      });
    });

    it('returns a deterministic error for malformed GetCodeGraphContext args', async () => {
      const result = await executeCanopyInjectedTool(
        'get_code_graph_context',
        { unexpected: true },
        runtimeWithCodeGraph(),
      );

      expect(result).toEqual({
        text: 'Invalid arguments for GetCodeGraphContext.',
        isError: true,
      });
      expect(mockGetCodeGraphContext).not.toHaveBeenCalled();
    });

    it('rejects GetCodeGraphContext when no worktree code graph runtime is available', async () => {
      const result = await executeCanopyInjectedTool(
        'get_code_graph_context',
        {},
        runtimeWithoutCodeGraph(),
      );

      expect(result).toEqual({
        text: 'GetCodeGraphContext is only available for worktree chats.',
        isError: true,
      });
      expect(mockGetCodeGraphContext).not.toHaveBeenCalled();
    });

    it('delegates BuildOrUpdateCodeGraph to the code graph runtime', async () => {
      const buildResult: CodeGraphBuildToolResult = {
        status: 'ok',
        summary: 'Built code graph: 3 parsed, 0 unchanged, 0 removed in 10ms.',
        truncated: false,
        suggestedNextTools: ['GetCodeGraphContext', 'QueryCodeGraph'],
        filesScanned: 3,
        filesParsed: 3,
        filesUnchanged: 0,
        filesRemoved: 0,
        filesSkipped: 0,
        parseFailures: 0,
        durationMs: 10,
      };
      mockBuildOrUpdateCodeGraph.mockResolvedValue(buildResult);

      const result = await executeCanopyInjectedTool(
        'build_or_update_code_graph',
        {},
        runtimeWithCodeGraph(),
      );

      expect(mockBuildOrUpdateCodeGraph).toHaveBeenCalledWith(codeGraphRuntime);
      expect(result).toEqual({
        text: JSON.stringify(buildResult, null, 2),
        isError: false,
      });
    });

    it('returns a deterministic error for malformed BuildOrUpdateCodeGraph args', async () => {
      const result = await executeCanopyInjectedTool(
        'build_or_update_code_graph',
        { unexpected: true },
        runtimeWithCodeGraph(),
      );

      expect(result).toEqual({
        text: 'Invalid arguments for BuildOrUpdateCodeGraph.',
        isError: true,
      });
      expect(mockBuildOrUpdateCodeGraph).not.toHaveBeenCalled();
    });

    it('rejects BuildOrUpdateCodeGraph when no worktree code graph runtime is available', async () => {
      const result = await executeCanopyInjectedTool(
        'build_or_update_code_graph',
        {},
        runtimeWithoutCodeGraph(),
      );

      expect(result).toEqual({
        text: 'BuildOrUpdateCodeGraph is only available for worktree chats.',
        isError: true,
      });
      expect(mockBuildOrUpdateCodeGraph).not.toHaveBeenCalled();
    });

    it('delegates QueryCodeGraph to the code graph runtime', async () => {
      const queryResult: CodeGraphQueryResult = {
        status: 'ok',
        summary: 'callers for "src/foo.ts::Bar": 1 result(s).',
        truncated: false,
        mode: 'callers',
        target: 'src/foo.ts::Bar',
        hits: [
          {
            qualifiedName: 'src/baz.ts::Qux',
            kind: 'function',
            filePath: 'src/baz.ts',
            line: 10,
          },
        ],
      };
      mockQueryCodeGraph.mockResolvedValue(queryResult);

      const result = await executeCanopyInjectedTool(
        'query_code_graph',
        { mode: 'callers', target: 'src/foo.ts::Bar' },
        runtimeWithCodeGraph(),
      );

      expect(mockQueryCodeGraph).toHaveBeenCalledWith(codeGraphRuntime, {
        mode: 'callers',
        target: 'src/foo.ts::Bar',
      });
      expect(result).toEqual({
        text: JSON.stringify(queryResult, null, 2),
        isError: false,
      });
    });

    it('preserves path parameters through the shared tool schema', async () => {
      const request = {
        mode: 'call-path',
        target: 'src/a.ts::a',
        to: 'src/b.ts::b',
        maxDepth: 4,
        maxNodes: 20,
      };
      mockQueryCodeGraph.mockResolvedValue({
        status: 'ok',
        mode: 'call-path',
        target: request.target,
        hits: [],
        summary: 'path',
        truncated: false,
      });
      await executeCanopyInjectedTool(
        'query_code_graph',
        request,
        runtimeWithCodeGraph(),
      );
      expect(mockQueryCodeGraph).toHaveBeenCalledWith(
        codeGraphRuntime,
        request,
      );
    });

    it('returns a deterministic error for malformed QueryCodeGraph args', async () => {
      const result = await executeCanopyInjectedTool(
        'query_code_graph',
        { mode: 'bogus-mode', target: 'src/foo.ts' },
        runtimeWithCodeGraph(),
      );

      expect(result).toEqual({
        text: 'Invalid arguments for QueryCodeGraph.',
        isError: true,
      });
      expect(mockQueryCodeGraph).not.toHaveBeenCalled();
    });

    it('rejects QueryCodeGraph when no worktree code graph runtime is available', async () => {
      const result = await executeCanopyInjectedTool(
        'query_code_graph',
        { mode: 'callers', target: 'src/foo.ts::Bar' },
        runtimeWithoutCodeGraph(),
      );

      expect(result).toEqual({
        text: 'QueryCodeGraph is only available for worktree chats.',
        isError: true,
      });
      expect(mockQueryCodeGraph).not.toHaveBeenCalled();
    });

    it('marks QueryCodeGraph results as errors when the runtime reports a failure', async () => {
      const errorResult: CodeGraphQueryResult = {
        status: 'error',
        summary: 'Failed to query code graph: boom.',
        truncated: false,
        mode: 'callers',
        target: 'src/foo.ts::Bar',
        hits: [],
      };
      mockQueryCodeGraph.mockResolvedValue(errorResult);

      const result = await executeCanopyInjectedTool(
        'query_code_graph',
        { mode: 'callers', target: 'src/foo.ts::Bar' },
        runtimeWithCodeGraph(),
      );

      expect(result).toEqual({
        text: JSON.stringify(errorResult, null, 2),
        isError: true,
      });
    });

    it('delegates SearchCodeGraph to the code graph runtime', async () => {
      const searchResult: CodeGraphSearchResultPayload = {
        status: 'ok',
        summary: 'Search "Foo": 1 result(s).',
        truncated: false,
        hits: [
          {
            qualifiedName: 'src/foo.ts::Foo',
            kind: 'class',
            filePath: 'src/foo.ts',
            line: 1,
          },
        ],
      };
      mockSearchCodeGraph.mockResolvedValue(searchResult);

      const result = await executeCanopyInjectedTool(
        'search_code_graph',
        { query: 'Foo' },
        runtimeWithCodeGraph(),
      );

      expect(mockSearchCodeGraph).toHaveBeenCalledWith(codeGraphRuntime, {
        query: 'Foo',
      });
      expect(result).toEqual({
        text: JSON.stringify(searchResult, null, 2),
        isError: false,
      });
    });

    it('returns a deterministic error for malformed SearchCodeGraph args', async () => {
      const result = await executeCanopyInjectedTool(
        'search_code_graph',
        { query: '' },
        runtimeWithCodeGraph(),
      );

      expect(result).toEqual({
        text: 'Invalid arguments for SearchCodeGraph.',
        isError: true,
      });
      expect(mockSearchCodeGraph).not.toHaveBeenCalled();
    });

    it('rejects SearchCodeGraph when no worktree code graph runtime is available', async () => {
      const result = await executeCanopyInjectedTool(
        'search_code_graph',
        { query: 'Foo' },
        runtimeWithoutCodeGraph(),
      );

      expect(result).toEqual({
        text: 'SearchCodeGraph is only available for worktree chats.',
        isError: true,
      });
      expect(mockSearchCodeGraph).not.toHaveBeenCalled();
    });

    it('delegates ExplainCodeSymbol to the code graph runtime', async () => {
      const explainResult: CodeGraphExplainResult = {
        status: 'ok',
        summary:
          'src/foo.ts::Bar (function): 1 caller(s), 0 callee(s), 1 test(s).',
        truncated: false,
        symbol: {
          qualifiedName: 'src/foo.ts::Bar',
          kind: 'function',
          filePath: 'src/foo.ts',
          lineStart: 1,
          lineEnd: 3,
          signature: 'function Bar(): void',
          exported: true,
        },
        callers: [],
        callees: [],
        tests: ['src/__tests__/foo.test.ts'],
        community: null,
        flows: [],
      };
      mockExplainCodeSymbol.mockResolvedValue(explainResult);

      const result = await executeCanopyInjectedTool(
        'explain_code_symbol',
        { qualifiedName: 'src/foo.ts::Bar' },
        runtimeWithCodeGraph(),
      );

      expect(mockExplainCodeSymbol).toHaveBeenCalledWith(codeGraphRuntime, {
        qualifiedName: 'src/foo.ts::Bar',
      });
      expect(result).toEqual({
        text: JSON.stringify(explainResult, null, 2),
        isError: false,
      });
    });

    it('returns a deterministic error for malformed ExplainCodeSymbol args', async () => {
      const result = await executeCanopyInjectedTool(
        'explain_code_symbol',
        { qualifiedName: '' },
        runtimeWithCodeGraph(),
      );

      expect(result).toEqual({
        text: 'Invalid arguments for ExplainCodeSymbol.',
        isError: true,
      });
      expect(mockExplainCodeSymbol).not.toHaveBeenCalled();
    });

    it('rejects ExplainCodeSymbol when no worktree code graph runtime is available', async () => {
      const result = await executeCanopyInjectedTool(
        'explain_code_symbol',
        { qualifiedName: 'src/foo.ts::Bar' },
        runtimeWithoutCodeGraph(),
      );

      expect(result).toEqual({
        text: 'ExplainCodeSymbol is only available for worktree chats.',
        isError: true,
      });
      expect(mockExplainCodeSymbol).not.toHaveBeenCalled();
    });

    it('delegates GetImpactRadius to the code graph runtime', async () => {
      const impactResult: CodeGraphImpactResult = {
        status: 'ok',
        summary:
          'Impact radius for "src/foo.ts::Bar" (depth ≤ 2): 1 symbol(s).',
        truncated: false,
        impacted: [
          {
            qualifiedName: 'src/baz.ts::Qux',
            kind: 'function',
            filePath: 'src/baz.ts',
            line: null,
            depth: 1,
          },
        ],
        maxDepth: 2,
      };
      mockGetImpactRadius.mockResolvedValue(impactResult);

      const result = await executeCanopyInjectedTool(
        'get_impact_radius',
        { target: 'src/foo.ts::Bar' },
        runtimeWithCodeGraph(),
      );

      expect(mockGetImpactRadius).toHaveBeenCalledWith(codeGraphRuntime, {
        target: 'src/foo.ts::Bar',
      });
      expect(result).toEqual({
        text: JSON.stringify(impactResult, null, 2),
        isError: false,
      });
    });

    it('returns a deterministic error for malformed GetImpactRadius args', async () => {
      const result = await executeCanopyInjectedTool(
        'get_impact_radius',
        {},
        runtimeWithCodeGraph(),
      );

      expect(result).toEqual({
        text: 'Invalid arguments for GetImpactRadius.',
        isError: true,
      });
      expect(mockGetImpactRadius).not.toHaveBeenCalled();
    });

    it('rejects GetImpactRadius when no worktree code graph runtime is available', async () => {
      const result = await executeCanopyInjectedTool(
        'get_impact_radius',
        { target: 'src/foo.ts::Bar' },
        runtimeWithoutCodeGraph(),
      );

      expect(result).toEqual({
        text: 'GetImpactRadius is only available for worktree chats.',
        isError: true,
      });
      expect(mockGetImpactRadius).not.toHaveBeenCalled();
    });

    it('delegates DetectChangedSymbols to the code graph runtime', async () => {
      const detectResult: DetectChangedSymbolsResult = {
        status: 'ok',
        summary: 'Detected 1 changed symbol(s) vs HEAD.',
        truncated: false,
        baseRef: 'HEAD',
        changed: [
          {
            qualifiedName: 'src/foo.ts::Bar',
            kind: 'function',
            filePath: 'src/foo.ts',
            lineStart: 1,
            lineEnd: 3,
            changeKind: 'modified',
          },
        ],
        unmatchedFiles: [],
      };
      mockDetectChangedSymbols.mockResolvedValue(detectResult);

      const result = await executeCanopyInjectedTool(
        'detect_changed_symbols',
        { baseRef: 'main' },
        runtimeWithCodeGraph(),
      );

      expect(mockDetectChangedSymbols).toHaveBeenCalledWith(codeGraphRuntime, {
        baseRef: 'main',
      });
      expect(result).toEqual({
        text: JSON.stringify(detectResult, null, 2),
        isError: false,
      });
    });

    it('returns a deterministic error for malformed DetectChangedSymbols args', async () => {
      const result = await executeCanopyInjectedTool(
        'detect_changed_symbols',
        { baseRef: 42 },
        runtimeWithCodeGraph(),
      );

      expect(result).toEqual({
        text: 'Invalid arguments for DetectChangedSymbols.',
        isError: true,
      });
      expect(mockDetectChangedSymbols).not.toHaveBeenCalled();
    });

    it('rejects DetectChangedSymbols when no worktree code graph runtime is available', async () => {
      const result = await executeCanopyInjectedTool(
        'detect_changed_symbols',
        {},
        runtimeWithoutCodeGraph(),
      );

      expect(result).toEqual({
        text: 'DetectChangedSymbols is only available for worktree chats.',
        isError: true,
      });
      expect(mockDetectChangedSymbols).not.toHaveBeenCalled();
    });

    it('delegates CompareChangeImpact to the code graph runtime', async () => {
      const compareResult: CompareChangeImpactResult = {
        status: 'ok',
        summary:
          'Change impact vs HEAD: +1 added, -0 removed, 0 signature change(s); 1 impacted symbol(s), risk low.',
        truncated: false,
        baseRef: 'HEAD',
        delta: { addedCount: 1, removedCount: 0, signatureChangedCount: 0 },
        impacted: [
          {
            qualifiedName: 'src/baz.ts::Qux',
            kind: 'function',
            filePath: 'src/baz.ts',
            line: null,
            depth: 1,
          },
        ],
        impactedTests: [],
        risk: { score: 0, level: 'low', reasons: [], formula: 'formula' },
      };
      mockCompareChangeImpact.mockResolvedValue(compareResult);

      const result = await executeCanopyInjectedTool(
        'compare_change_impact',
        { maxDepth: 3 },
        runtimeWithCodeGraph(),
      );

      expect(mockCompareChangeImpact).toHaveBeenCalledWith(codeGraphRuntime, {
        maxDepth: 3,
      });
      expect(result).toEqual({
        text: JSON.stringify(compareResult, null, 2),
        isError: false,
      });
    });

    it('returns a deterministic error for malformed CompareChangeImpact args', async () => {
      const result = await executeCanopyInjectedTool(
        'compare_change_impact',
        { maxDepth: 0 },
        runtimeWithCodeGraph(),
      );

      expect(result).toEqual({
        text: 'Invalid arguments for CompareChangeImpact.',
        isError: true,
      });
      expect(mockCompareChangeImpact).not.toHaveBeenCalled();
    });

    it('rejects CompareChangeImpact when no worktree code graph runtime is available', async () => {
      const result = await executeCanopyInjectedTool(
        'compare_change_impact',
        {},
        runtimeWithoutCodeGraph(),
      );

      expect(result).toEqual({
        text: 'CompareChangeImpact is only available for worktree chats.',
        isError: true,
      });
      expect(mockCompareChangeImpact).not.toHaveBeenCalled();
    });

    it('delegates GetReviewContext to the code graph runtime', async () => {
      const reviewResult: GetReviewContextResult = {
        status: 'ok',
        summary:
          'Review context vs HEAD: 1 changed symbol(s), 0 test gap(s), risk low.',
        truncated: false,
        baseRef: 'HEAD',
        changedSymbols: [
          {
            qualifiedName: 'src/foo.ts::Bar',
            kind: 'function',
            filePath: 'src/foo.ts',
            changeKind: 'modified',
            riskScore: 0.1,
            riskReasons: [],
          },
        ],
        impactedFiles: ['src/foo.ts'],
        impactedTests: [],
        testGaps: [],
        reviewPriorities: [{ qualifiedName: 'src/foo.ts::Bar', score: 0.1 }],
        risk: { score: 0.1, level: 'low', reasons: [], formula: 'formula' },
      };
      mockGetReviewContext.mockResolvedValue(reviewResult);

      const result = await executeCanopyInjectedTool(
        'get_review_context',
        { repoId: 'workspace-root' },
        runtimeWithCodeGraph(),
      );

      expect(mockGetReviewContext).toHaveBeenCalledWith(codeGraphRuntime, {
        repoId: 'workspace-root',
      });
      expect(result).toEqual({
        text: JSON.stringify(reviewResult, null, 2),
        isError: false,
      });
    });

    it('returns a deterministic error for malformed GetReviewContext args', async () => {
      const result = await executeCanopyInjectedTool(
        'get_review_context',
        { detailLevel: 'bogus' },
        runtimeWithCodeGraph(),
      );

      expect(result).toEqual({
        text: 'Invalid arguments for GetReviewContext.',
        isError: true,
      });
      expect(mockGetReviewContext).not.toHaveBeenCalled();
    });

    it('rejects GetReviewContext when no worktree code graph runtime is available', async () => {
      const result = await executeCanopyInjectedTool(
        'get_review_context',
        {},
        runtimeWithoutCodeGraph(),
      );

      expect(result).toEqual({
        text: 'GetReviewContext is only available for worktree chats.',
        isError: true,
      });
      expect(mockGetReviewContext).not.toHaveBeenCalled();
    });
  });
});

/**
 * CAN-1814 PR 4. `WatchGitHubItems` is the one Canopy-injected tool that talks
 * to the first-party GitHub integration, and the broker gives it an
 * unambiguous verdict: `not_authenticated` is raised only AFTER the token cache
 * was invalidated and the credential re-resolved. That is a structured "the
 * user must reconnect GitHub" signal, so it becomes an `integration`-class
 * failure on the turn instead of an opaque tool error.
 */
describe('WatchGitHubItems GitHub authentication failures', () => {
  const OWNER = 'project-1/worktree-1/chat-1';

  function runtime(): CanopyInjectedToolRuntime {
    return {
      requestUserAnswers: jest.fn(),
      loadScriptOutput: jest.fn(),
      worktreeWatcherRuntime: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      },
    };
  }

  const validArgs = {
    items: [{ kind: 'workflow_run', repository: 'acme/widgets', runId: 42 }],
    notifyOn: { jobs: { conclusions: 'any' } },
  };

  beforeEach(() => {
    mockWatchGitHubItems.mockReset();
    clearPendingAuthFailures(OWNER);
  });
  afterEach(() => clearPendingAuthFailures(OWNER));

  it('publishes an integration failure with a github_login recovery', async () => {
    mockWatchGitHubItems.mockResolvedValue({
      ok: false,
      code: 'not_authenticated',
      message:
        'No GitHub token is available. Configure a PAT or sign in with the GitHub CLI.',
    });

    const result = await executeCanopyInjectedTool(
      'watch_github_items',
      validArgs,
      runtime(),
    );

    expect(result.isError).toBe(true);
    const claimed = claimPendingAuthFailures(OWNER);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].anchor).toEqual({
      kind: 'injected-tool',
      toolKey: 'watch_github_items',
    });
    expect(claimed[0].failure.dependencyClass).toBe('integration');
    expect(claimed[0].failure.displayName).toBe('GitHub');
    expect(claimed[0].failure.failureClass).toBe('unauthenticated');
    expect(claimed[0].failure.recovery).toEqual({ kind: 'github_login' });
  });

  // A retriable broker error is projected into one of these codes. Telling the
  // user to reconnect a working GitHub would be a false accusation, and it
  // would also burn the turn (PR 6 stops a turn on any recoverable failure).
  it.each([
    'github_unavailable',
    'internal_error',
    'not_found_or_inaccessible',
  ])('publishes nothing for a retriable %s failure', async (code) => {
    mockWatchGitHubItems.mockResolvedValue({
      ok: false,
      code,
      message: 'GitHub workflow run information is temporarily unavailable.',
    });

    const result = await executeCanopyInjectedTool(
      'watch_github_items',
      validArgs,
      runtime(),
    );

    expect(result.isError).toBe(true);
    expect(claimPendingAuthFailures(OWNER)).toEqual([]);
  });

  it('publishes nothing on success', async () => {
    mockWatchGitHubItems.mockResolvedValue({
      ok: true,
      status: 'created',
      watcherId: 'watcher-1',
      itemCount: 1,
      events: ['job_completed'],
    });

    await executeCanopyInjectedTool('watch_github_items', validArgs, runtime());

    expect(claimPendingAuthFailures(OWNER)).toEqual([]);
  });
});

describe('WatchGitHubItems in cowork chats', () => {
  const destination = {
    projectId: 'cowork-1',
    worktreeId: 'entry-1',
    chatId: 'chat-a',
  };

  beforeEach(() => {
    mockWatchGitHubItems.mockReset();
    mockResolveGitHubRepositoryCandidates.mockClear();
  });

  it('watches for the cowork chat with candidates from the cowork folder', async () => {
    mockResolveGitHubRepositoryCandidates.mockResolvedValueOnce([]);
    mockWatchGitHubItems.mockResolvedValue({
      ok: true,
      status: 'created',
      watcherId: 'watcher-1',
      itemCount: 1,
      events: ['merged'],
    });
    const args = {
      items: [{ kind: 'pull_request', repository: 'acme/api', number: 7 }],
      notifyOn: { queue: { entered: true } },
    };

    const result = await executeCanopyInjectedTool(
      'watch_github_items',
      args,
      {
        requestUserAnswers: jest.fn(),
        loadScriptOutput: jest.fn(),
        worktreeActionRuntime: {
          ...destination,
          cwd: '/cowork/folder',
          executionScope: 'directory',
          getWindow: () => null,
        },
        worktreeWatcherRuntime: destination,
      },
      { toolUseId: 'tool-1' },
    );

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toMatchObject({ watcherId: 'watcher-1' });
    expect(mockResolveGitHubRepositoryCandidates).toHaveBeenCalledWith({
      projectId: 'cowork-1',
      worktreeId: 'entry-1',
      cwd: '/cowork/folder',
    });
    expect(mockWatchGitHubItems).toHaveBeenCalledWith(
      expect.objectContaining({ items: args.items }),
      destination,
      { toolUseId: 'tool-1', repositoryCandidates: [] },
    );
  });
});

describe('independent agent tool validation', () => {
  const runtime: CanopyInjectedToolRuntime = {
    requestUserAnswers: jest.fn(),
    loadScriptOutput: jest.fn(),
  };
  it.each(['start_forked_agent', 'start_branched_agent'] as const)(
    'rejects invalid or caller-selected scope for %s',
    async (key) => {
      for (const args of [
        { followUpInstruction: ' ' },
        { followUpInstruction: 'Do work', worktreeId: 'other' },
        { followUpInstruction: 'Do work', chatId: 'other' },
      ]) {
        expect(
          await executeCanopyInjectedTool(key, args, runtime),
        ).toMatchObject({ isError: true });
      }
    },
  );
  const coworkRuntime: CanopyInjectedToolRuntime = {
    ...runtime,
    worktreeActionRuntime: {
      projectId: 'project',
      worktreeId: 'entry',
      chatId: 'chat',
      cwd: '/tmp',
      getWindow: () => null,
      executionScope: 'directory',
    },
  };
  it.each(['start_forked_agent', 'start_branched_agent'] as const)(
    'rejects a missing runtime for %s',
    async (key) => {
      expect(
        await executeCanopyInjectedTool(
          key,
          { followUpInstruction: 'Do work' },
          runtime,
        ),
      ).toMatchObject({ isError: true });
    },
  );
  it('rejects branching from a Cowork chat', async () => {
    expect(
      await executeCanopyInjectedTool(
        'start_branched_agent',
        { followUpInstruction: 'Do work' },
        coworkRuntime,
      ),
    ).toMatchObject({ isError: true });
    expect(mockStartSplitAgent).not.toHaveBeenCalled();
  });
  it('carries transport cancellation into independent context transfers', async () => {
    const controller = new AbortController();
    const runningTurn = jest
      .spyOn(getChatQueueService(), 'runningTurnUserMessageId')
      .mockReturnValue('cancellation-turn');
    mockStartSplitAgent.mockResolvedValue({ ok: true });
    try {
      const result = await executeCanopyInjectedTool(
        'start_forked_agent',
        { followUpInstruction: 'Continue separately' },
        coworkRuntime,
        { signal: controller.signal },
      );
      expect(result.isError).not.toBe(true);
      expect(mockStartSplitAgent).toHaveBeenCalledWith(
        'start_forked_agent',
        { followUpInstruction: 'Continue separately' },
        expect.objectContaining({ signal: controller.signal }),
      );
    } finally {
      runningTurn.mockRestore();
    }
  });
  it('forks a Cowork chat within its Work Entry', async () => {
    // A fork is a limited write, keyed by the turn the chat is running.
    const runningTurn = jest
      .spyOn(getChatQueueService(), 'runningTurnUserMessageId')
      .mockReturnValue('running-turn');
    mockStartSplitAgent.mockResolvedValue({
      ok: true,
      chatId: 'fork',
      worktreeId: 'entry',
    });
    expect(
      await executeCanopyInjectedTool(
        'start_forked_agent',
        { followUpInstruction: 'Do work' },
        coworkRuntime,
      ),
    ).toEqual({
      text: JSON.stringify({ ok: true, chatId: 'fork', worktreeId: 'entry' }),
    });
    expect(mockStartSplitAgent).toHaveBeenCalledWith(
      'start_forked_agent',
      { followUpInstruction: 'Do work' },
      coworkRuntime.worktreeActionRuntime,
    );
    runningTurn.mockRestore();
  });
});

describe('delegate watcher runtime', () => {
  const recipient = {
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    chatId: 'root-chat',
    delegationId: 'delegation-1',
  };
  const delegateCwd = '/data/delegation/worktrees/delegation-1';

  // An isolated delegate has a watcher runtime but no worktree action
  // runtime: the parent worktree's scripts do not apply to its checkout.
  function delegateRuntime(): CanopyInjectedToolRuntime {
    return {
      requestUserAnswers: jest.fn(),
      loadScriptOutput: jest.fn(),
      worktreeWatcherRuntime: { ...recipient, cwd: delegateCwd },
    };
  }

  beforeEach(() => {
    mockSetupWatchers.mockReset();
    mockSearchWatchers.mockReset();
    mockProjectCanonicalChatWatchers.mockReset().mockResolvedValue([]);
    mockDeleteAgentWatchers.mockReset();
    mockCreateLocalWatcher.mockReset();
    mockWatchGitHubItems.mockReset();
    clearPendingAuthFailures('project-1/worktree-1/root-chat');
  });

  it('registers a command watch in the delegate working directory for the delegate recipient', async () => {
    mockCreateLocalWatcher.mockResolvedValue({ id: 'watcher-delegate' });
    const result = await executeCanopyInjectedTool(
      'watch_command',
      { command: 'test -f ready', intervalSeconds: 5, maxAttempts: 3 },
      delegateRuntime(),
      { toolUseId: 'delegate-call' },
    );
    expect(result.isError).not.toBe(true);
    expect(mockCreateLocalWatcher).toHaveBeenCalledWith(
      {
        kind: 'command_watch',
        command: 'test -f ready',
        intervalSeconds: 5,
        maxAttempts: 3,
        cwd: delegateCwd,
      },
      recipient,
      'delegate-call',
      undefined,
    );
    expect(result.text).toContain('this delegated task');
    expect(result.text).not.toContain('this same chat');
  });

  it('names the owning delegate on the watcher destination', async () => {
    mockCreateLocalWatcher.mockResolvedValue({ id: 'wake' });
    await executeCanopyInjectedTool(
      'schedule_wakeup',
      { delaySeconds: 60 },
      {
        ...delegateRuntime(),
        worktreeWatcherRuntime: {
          ...recipient,
          delegationDescription: 'Review auth flow',
          delegationDepth: 2,
          cwd: delegateCwd,
        },
      },
      { toolUseId: 'wake-call' },
    );
    expect(mockCreateLocalWatcher).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'scheduled_wakeup' }),
      {
        ...recipient,
        delegationDescription: 'Review auth flow',
        delegationDepth: 2,
      },
      'wake-call',
      undefined,
    );
  });

  it('passes the delegate recipient to wakeups, setup, search, and deletion', async () => {
    mockCreateLocalWatcher.mockResolvedValue({ id: 'wake' });
    mockSetupWatchers.mockResolvedValue({ ok: true, results: [] });
    mockSearchWatchers.mockResolvedValue({ catalog: [], activeWatchers: [] });
    mockDeleteAgentWatchers.mockResolvedValue({ ok: true, results: [] });
    const runtime = delegateRuntime();
    await executeCanopyInjectedTool(
      'schedule_wakeup',
      { delaySeconds: 60 },
      runtime,
      { toolUseId: 'wake-call' },
    );
    expect(mockCreateLocalWatcher).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'scheduled_wakeup' }),
      recipient,
      'wake-call',
      undefined,
    );
    await executeCanopyInjectedTool(
      'setup_watchers',
      {
        watchers: [{ target: { pipelineId: 'pipeline-1' }, label: 'Pipeline' }],
      },
      runtime,
    );
    expect(mockSetupWatchers).toHaveBeenCalledWith(
      {
        watchers: [
          {
            trigger: 'worktree_pipeline_completion',
            label: 'Pipeline',
            target: {
              kind: 'worktree_pipeline',
              projectId: 'project-1',
              worktreeId: 'worktree-1',
              pipelineId: 'pipeline-1',
            },
          },
        ],
      },
      recipient,
      { toolUseId: undefined },
    );
    await executeCanopyInjectedTool('search_watchers', {}, runtime);
    for (const [, destination] of mockSearchWatchers.mock.calls)
      expect(destination).toEqual(recipient);
    await executeCanopyInjectedTool(
      'delete_watchers',
      { watcherIds: ['watcher-1'] },
      runtime,
    );
    expect(mockDeleteAgentWatchers).toHaveBeenCalledWith(
      { watcherIds: ['watcher-1'] },
      recipient,
    );
  });

  it('watches GitHub runs for the delegate without failing the root chat turn', async () => {
    mockWatchGitHubItems.mockResolvedValue({
      ok: false,
      code: 'not_authenticated',
      message: 'No GitHub token is available.',
    });
    const result = await executeCanopyInjectedTool(
      'watch_github_items',
      {
        items: [
          { kind: 'workflow_run', repository: 'acme/widgets', runId: 42 },
        ],
        notifyOn: { jobs: { conclusions: 'any' } },
      },
      delegateRuntime(),
    );
    expect(result.isError).toBe(true);
    expect(mockWatchGitHubItems).toHaveBeenCalledWith(
      expect.anything(),
      recipient,
      expect.anything(),
    );
    // The delegate's own tool result reports the failure. The root chat's
    // turn must not receive a reconnect card (and stop) for it.
    expect(claimPendingAuthFailures('project-1/worktree-1/root-chat')).toEqual(
      [],
    );
  });
});

describe('Ledger tool routing', () => {
  const baseRuntime: CanopyInjectedToolRuntime = {
    requestUserAnswers: jest.fn(),
    loadScriptOutput: jest.fn(),
  };

  it.each([
    'add_ledger_entry',
    'search_ledger_entries',
    'update_ledger_entry',
  ] as const)(
    'answers %s as unavailable in a session without Ledger tools',
    async (key) => {
      const result = await executeCanopyInjectedTool(key, {}, baseRuntime);

      expect(result.isError).toBe(true);
      expect(JSON.parse(result.text)).toMatchObject({
        ok: false,
        error: { code: 'FEED_UNAVAILABLE', reason: 'no_ledger_scope' },
      });
    },
  );

  it('hands the call, its invocation identity and its signal to the session runtime', async () => {
    const execute = jest.fn(() => Promise.resolve({ text: '{"ok":true}' }));
    const signal = new AbortController().signal;

    const result = await executeCanopyInjectedTool(
      'update_ledger_entry',
      { entryId: 'entry', expectedRevision: 1, status: 'BLOCKED' },
      { ...baseRuntime, ledgerRuntime: { execute } },
      { toolUseId: 'codex-call', invocationId: 'codex:t:u:call', signal },
    );

    expect(result).toEqual({ text: '{"ok":true}' });
    expect(execute).toHaveBeenCalledWith(
      'update_ledger_entry',
      { entryId: 'entry', expectedRevision: 1, status: 'BLOCKED' },
      { invocationId: 'codex:t:u:call', signal },
    );
  });
});

function parseWatcherResult(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) throw new Error('Expected watcher result object');
  return value;
}

describe('canonical chat watcher surface routing', () => {
  const scope = {
    projectId: 'root-project',
    worktreeId: 'root-task',
    chatId: 'root-chat',
  };
  const canonical = {
    trigger: 'project_task_chat_completion',
    target: {
      projectId: 'target-project',
      taskId: 'target-task',
      chatId: 'target-chat',
    },
    armForNextCompletion: true,
  };
  function runtime(delegationId?: string): CanopyInjectedToolRuntime {
    return {
      requestUserAnswers: jest.fn(),
      loadScriptOutput: jest.fn(),
      worktreeWatcherRuntime: {
        ...scope,
        ...(delegationId ? { delegationId } : {}),
      },
    };
  }
  beforeEach(() => {
    mockSetupWatchers.mockReset();
    mockSetupCanonicalChatWatchers
      .mockReset()
      .mockResolvedValue({ ok: true, results: [] });
    mockProjectCanonicalChatWatchers.mockReset().mockResolvedValue([]);
    mockIsBotAccessAllowed.mockReset().mockResolvedValue(false);
    mockSearchWatchers
      .mockReset()
      .mockImplementation(
        (input: Parameters<typeof searchAppAdvisorWatchers>[0]) =>
          Promise.resolve(searchAppAdvisorWatchers(input)),
      );
  });
  function seedSearchInstances(): void {
    mockSearchWatchers.mockImplementation(
      (input: Parameters<typeof searchAppAdvisorWatchers>[0]) =>
        Promise.resolve(
          searchAppAdvisorWatchers(input, [
            {
              id: 'pipeline',
              trigger: 'worktree_pipeline_completion',
              status: 'active',
              label: 'Build',
              target: {
                kind: 'worktree_pipeline',
                projectId: 'target-project',
                worktreeId: 'target-task',
                pipelineId: 'build',
                executionId: 'execution-1',
              },
              destination: scope,
              createdAt: '2026-10-16T00:00:00.000Z',
            },
          ]),
        ),
    );
    mockProjectCanonicalChatWatchers.mockResolvedValue([
      {
        id: 'chat',
        trigger: 'project_task_chat_completion',
        status: 'active',
        target: canonical.target,
      },
      {
        id: 'project-wide',
        trigger: 'project_new_chat_started',
        status: 'active',
        target: { projectId: 'target-project' },
      },
      {
        id: 'bot',
        trigger: 'bot_task_chat_completion',
        status: 'active',
        target: {
          botId: 'app_advisor',
          taskId: 'bot-task',
          chatId: 'bot-chat',
        },
      },
      {
        id: 'redacted',
        trigger: 'project_task_chat_completion',
        availability: 'owner_boundary',
      },
    ]);
  }

  it.each(['minimal', 'standard'] as const)(
    'returns authorized chat and pipeline target IDs in %s instance rows',
    async (detailLevel) => {
      seedSearchInstances();
      const result = await executeCanopyInjectedTool(
        'search_watchers',
        { detailLevel },
        runtime(),
      );
      expect(parseWatcherResult(result.text)).toMatchObject({
        activeWatchers: [
          {
            id: 'pipeline',
            target: {
              projectId: 'target-project',
              taskId: 'target-task',
              pipelineId: 'build',
              executionId: 'execution-1',
            },
          },
          { id: 'chat', target: canonical.target },
          { id: 'project-wide', target: { projectId: 'target-project' } },
          {
            id: 'bot',
            target: {
              botId: 'app_advisor',
              taskId: 'bot-task',
              chatId: 'bot-chat',
            },
          },
          { id: 'redacted', availability: 'owner_boundary' },
        ],
        activeReturned: 5,
        activeTotalMatches: 5,
      });
      const rows = parseWatcherResult(result.text).activeWatchers;
      if (!Array.isArray(rows)) throw new Error('Expected instance rows');
      expect(
        rows.find((row: unknown) => isRecord(row) && row.id === 'project-wide'),
      ).toEqual({
        id: 'project-wide',
        watcherId: 'project-wide',
        trigger: 'project_new_chat_started',
        status: 'active',
        target: { projectId: 'target-project' },
      });
      expect(
        rows.find((row: unknown) => isRecord(row) && row.id === 'redacted'),
      ).not.toHaveProperty('target');
    },
  );

  it('filters and pages the final instance list independently of catalog query and limit', async () => {
    seedSearchInstances();
    const input = {
      query: 'pipeline',
      limit: 1,
      activeQuery: 'TARGET-PROJECT',
      targetProjectId: 'target-project',
      activePageSize: 1,
    };
    const first = parseWatcherResult(
      (await executeCanopyInjectedTool('search_watchers', input, runtime()))
        .text,
    );
    expect(first).toMatchObject({
      activeWatchers: [{ id: 'pipeline' }],
      activeReturned: 1,
      activeTotalMatches: 3,
    });
    expect(first.catalog).toHaveLength(1);
    if (typeof first.activeNextCursor !== 'string')
      throw new Error('Expected next cursor');
    const second = parseWatcherResult(
      (
        await executeCanopyInjectedTool(
          'search_watchers',
          { ...input, activeCursor: first.activeNextCursor },
          runtime(),
        )
      ).text,
    );
    expect(second).toMatchObject({
      activeWatchers: [{ id: 'chat' }],
      activeReturned: 1,
      activeTotalMatches: 3,
    });
    if (typeof second.activeNextCursor !== 'string')
      throw new Error('Expected next cursor');
    const last = parseWatcherResult(
      (
        await executeCanopyInjectedTool(
          'search_watchers',
          { ...input, activeCursor: second.activeNextCursor },
          runtime(),
        )
      ).text,
    );
    expect(last).toMatchObject({
      activeWatchers: [
        { id: 'project-wide', target: { projectId: 'target-project' } },
      ],
      activeReturned: 1,
      activeTotalMatches: 3,
    });
    expect(last).not.toHaveProperty('activeNextCursor');
  });

  it.each([
    [{ targetTaskId: 'target-task' }, ['pipeline', 'chat']],
    [{ targetChatId: 'target-chat' }, ['chat']],
    [{ targetBotId: 'app_advisor' }, ['bot']],
    [{ targetProjectId: 'revoked-project' }, []],
    [{ activeQuery: 'Build' }, ['pipeline']],
    [{ activeQuery: 'project-wide' }, ['project-wide']],
  ])('matches only visible instance metadata for %j', async (input, ids) => {
    seedSearchInstances();
    const result = parseWatcherResult(
      (await executeCanopyInjectedTool('search_watchers', input, runtime()))
        .text,
    );
    const rows = result.activeWatchers;
    if (!Array.isArray(rows)) throw new Error('Expected instance rows');
    expect(
      rows.map((row: unknown) => (isRecord(row) ? row.id : undefined)),
    ).toEqual(ids);
    expect(result.activeTotalMatches).toBe(ids.length);
  });

  it.each([undefined, 200])(
    'uses the default page size or requested maximum %s',
    async (activePageSize) => {
      mockProjectCanonicalChatWatchers.mockResolvedValue(
        Array.from({ length: 201 }, (_, index) => ({
          id: `chat-${index}`,
          trigger: 'project_task_chat_completion',
          target: canonical.target,
        })),
      );
      const result = parseWatcherResult(
        (
          await executeCanopyInjectedTool(
            'search_watchers',
            { activePageSize },
            runtime(),
          )
        ).text,
      );
      expect(result.activeReturned).toBe(activePageSize ?? 50);
      expect(result.activeTotalMatches).toBe(201);
      expect(typeof result.activeNextCursor).toBe('string');
    },
  );

  it('returns a tool error for a malformed or foreign active cursor', async () => {
    seedSearchInstances();
    const first = parseWatcherResult(
      (
        await executeCanopyInjectedTool(
          'search_watchers',
          { activePageSize: 1 },
          runtime(),
        )
      ).text,
    );
    if (typeof first.activeNextCursor !== 'string')
      throw new Error('Expected next cursor');
    for (const input of [
      { activeCursor: 'not-a-cursor' },
      { activeCursor: first.activeNextCursor, targetTaskId: 'target-task' },
    ]) {
      const result = await executeCanopyInjectedTool(
        'search_watchers',
        input,
        runtime(),
      );
      expect(result).toEqual({ text: 'Invalid activeCursor.', isError: true });
    }
  });

  it.each([
    { targetProjectId: 'p', targetBotId: 'b' },
    { activePageSize: 0 },
    { activePageSize: 201 },
    { activePageSize: 1.5 },
    { activeCursor: '' },
    { activeCursor: 'x'.repeat(201) },
    { activeQuery: 'x'.repeat(501) },
    { targetProjectId: '' },
    { targetBotId: '' },
    { targetTaskId: '' },
    { targetChatId: '' },
    { limit: 51 },
  ])(
    'rejects invalid instance search arguments %j before service access',
    async (input) => {
      const result = await executeCanopyInjectedTool(
        'search_watchers',
        input,
        runtime(),
      );
      expect(result.isError).toBe(true);
      expect(result.text).toContain('Invalid arguments');
      expect(mockSearchWatchers).not.toHaveBeenCalled();
    },
  );

  it('returns no instances and zero counts when includeActive is false', async () => {
    seedSearchInstances();
    const result = await executeCanopyInjectedTool(
      'search_watchers',
      { includeActive: false },
      runtime(),
    );
    expect(parseWatcherResult(result.text)).toMatchObject({
      activeWatchers: [],
      activeReturned: 0,
      activeTotalMatches: 0,
    });
    expect(parseWatcherResult(result.text)).not.toHaveProperty(
      'activeNextCursor',
    );
    expect(mockProjectCanonicalChatWatchers).not.toHaveBeenCalled();
  });

  it('searches only the trusted delegate recipient before filtering and paging', async () => {
    mockSearchWatchers.mockImplementation(
      (
        input: Parameters<typeof searchAppAdvisorWatchers>[0],
        destination: { delegationId?: string },
      ) =>
        Promise.resolve({
          catalog: searchAppAdvisorWatchers(input).catalog,
          activeWatchers:
            destination.delegationId === 'delegate-1'
              ? [
                  {
                    id: 'delegate-pipeline',
                    trigger: 'worktree_pipeline_completion',
                    target: {
                      projectId: 'target-project',
                      taskId: 'target-task',
                    },
                  },
                ]
              : [
                  {
                    id: 'root-pipeline',
                    trigger: 'worktree_pipeline_completion',
                  },
                ],
        }),
    );
    mockProjectCanonicalChatWatchers.mockImplementation(
      ({ recipient }: { recipient: { kind: string; delegationId?: string } }) =>
        Promise.resolve(
          recipient.delegationId === 'delegate-1'
            ? [
                {
                  id: 'delegate-chat',
                  trigger: 'project_task_chat_completion',
                  target: canonical.target,
                },
              ]
            : [
                {
                  id: 'root-chat-watch',
                  trigger: 'project_task_chat_completion',
                  target: canonical.target,
                },
              ],
        ),
    );
    const result = await executeCanopyInjectedTool(
      'search_watchers',
      { targetProjectId: 'target-project', activePageSize: 1 },
      runtime('delegate-1'),
    );
    expect(parseWatcherResult(result.text)).toMatchObject({
      activeWatchers: [{ id: 'delegate-pipeline' }],
      activeReturned: 1,
      activeTotalMatches: 2,
    });
    expect(typeof parseWatcherResult(result.text).activeNextCursor).toBe(
      'string',
    );
    for (const [, destination] of mockSearchWatchers.mock.calls)
      expect(destination).toEqual({ ...scope, delegationId: 'delegate-1' });
    expect(mockProjectCanonicalChatWatchers).toHaveBeenCalledWith({
      destination: { ...scope, delegationId: 'delegate-1' },
      recipient: { kind: 'delegate', delegationId: 'delegate-1' },
    });
    expect(result.text).not.toContain('root-pipeline');
    expect(result.text).not.toContain('root-chat-watch');
  });

  it('records the calling tool use on canonical batches for DeleteWatchers', async () => {
    await executeCanopyInjectedTool(
      'setup_watchers',
      { watchers: [canonical] },
      runtime(),
      { toolUseId: 'tool-canonical' },
    );
    expect(mockSetupCanonicalChatWatchers).toHaveBeenCalledWith(
      expect.objectContaining({ createdByToolUseId: 'tool-canonical' }),
    );
  });
  it.each([undefined, 'delegate-1'])(
    'routes canonical and mixed batches atomically with trusted identity %s',
    async (delegationId) => {
      const result = await executeCanopyInjectedTool(
        'setup_watchers',
        { watchers: [{ target: { executionId: 'execution-1' } }, canonical] },
        runtime(delegationId),
      );
      expect(result.isError).toBe(false);
      expect(mockSetupWatchers).not.toHaveBeenCalled();
      expect(mockSetupCanonicalChatWatchers).toHaveBeenCalledTimes(1);
      expect(mockSetupCanonicalChatWatchers).toHaveBeenCalledWith({
        destination: { ...scope, ...(delegationId ? { delegationId } : {}) },
        recipient: delegationId
          ? { kind: 'delegate', delegationId }
          : { kind: 'root' },
        watchers: [
          {
            trigger: 'worktree_pipeline_completion',
            target: {
              kind: 'worktree_pipeline',
              projectId: scope.projectId,
              worktreeId: scope.worktreeId,
              executionId: 'execution-1',
            },
          },
          canonical,
        ],
      });
    },
  );
  it.each([
    (entry: typeof canonical): unknown => ({
      watchers: [entry],
      destination: scope,
    }),
    (entry: typeof canonical): unknown => ({
      watchers: [{ ...entry, owner: 'forged' }],
    }),
    (entry: typeof canonical): unknown => ({
      watchers: [
        { ...entry, target: { ...entry.target, kind: 'project_task_chat' } },
      ],
    }),
    (entry: typeof canonical): unknown => ({
      watchers: [
        { target: { executionId: 'x' } },
        { ...entry, target: { ...entry.target, sessionId: 'forged' } },
      ],
    }),
    (entry: typeof canonical): unknown => [entry],
  ])(
    'rejects raw canonical smuggling before service mutation',
    async (args) => {
      const result = await executeCanopyInjectedTool(
        'setup_watchers',
        args(canonical),
        runtime('delegate-1'),
      );
      expect(result.isError).toBe(true);
      expect(result.text).toContain('Invalid arguments');
      expect(mockSetupCanonicalChatWatchers).not.toHaveBeenCalled();
      expect(mockSetupWatchers).not.toHaveBeenCalled();
    },
  );
  it('compacts unrelated legacy rows and preserves canonical redaction in mixed setup results', async () => {
    mockSetupCanonicalChatWatchers.mockResolvedValue({
      ok: true,
      results: [
        {
          status: 'created',
          watcher: {
            id: 'legacy',
            trigger: 'worktree_pipeline_completion',
            status: 'active',
            label: 'Pipeline',
            destination: { chatId: 'hidden' },
            target: {
              kind: 'worktree_pipeline',
              projectId: 'p',
              worktreeId: 't',
            },
          },
        },
        {
          status: 'deduped',
          watcher: {
            id: 'canonical',
            trigger: 'project_task_chat_completion',
            availability: 'owner_boundary',
          },
        },
      ],
    });
    const result = await executeCanopyInjectedTool(
      'setup_watchers',
      { watchers: [{ target: { executionId: 'e' } }, canonical] },
      runtime(),
    );
    expect(parseWatcherResult(result.text).results).toEqual([
      {
        status: 'created',
        watcher: {
          id: 'legacy',
          trigger: 'worktree_pipeline_completion',
          status: 'active',
          label: 'Pipeline',
          targetKind: 'worktree_pipeline',
        },
      },
      {
        status: 'deduped',
        watcher: {
          id: 'canonical',
          trigger: 'project_task_chat_completion',
          availability: 'owner_boundary',
        },
      },
    ]);
    expect(result.text).not.toContain('hidden');
  });
  it('uses only redacted service projections for chat instances', async () => {
    mockSearchWatchers.mockResolvedValue({
      catalog: [],
      activeWatchers: [
        {
          id: 'secret',
          trigger: 'project_task_chat_completion',
          label: 'secret label',
          target: { projectId: 'secret' },
        },
      ],
    });
    mockProjectCanonicalChatWatchers.mockResolvedValue([
      {
        id: 'secret',
        trigger: 'project_task_chat_completion',
        availability: 'owner_boundary',
      },
    ]);
    const result = await executeCanopyInjectedTool(
      'search_watchers',
      {},
      runtime('delegate-1'),
    );
    expect(parseWatcherResult(result.text).activeWatchers).toEqual([
      {
        id: 'secret',
        watcherId: 'secret',
        trigger: 'project_task_chat_completion',
        availability: 'owner_boundary',
      },
    ]);
    expect(result.text).not.toContain('secret label');
    const filtered = await executeCanopyInjectedTool(
      'search_watchers',
      { targetProjectId: 'secret' },
      runtime('delegate-1'),
    );
    expect(parseWatcherResult(filtered.text)).toMatchObject({
      activeWatchers: [],
      activeReturned: 0,
      activeTotalMatches: 0,
    });
    expect(mockProjectCanonicalChatWatchers).toHaveBeenCalledWith({
      destination: { ...scope, delegationId: 'delegate-1' },
      recipient: { kind: 'delegate', delegationId: 'delegate-1' },
    });
  });
  it('fails closed with identity-only availability when projection fails', async () => {
    mockSearchWatchers.mockResolvedValue({
      catalog: [],
      activeWatchers: [
        {
          id: 'secret',
          trigger: 'project_task_chat_completion',
          label: 'secret label',
          target: { projectId: 'secret' },
        },
      ],
    });
    mockProjectCanonicalChatWatchers.mockRejectedValue(
      new Error('secret target data'),
    );
    const result = await executeCanopyInjectedTool(
      'search_watchers',
      {},
      runtime(),
    );
    expect(parseWatcherResult(result.text).activeWatchers).toEqual([
      {
        id: 'secret',
        watcherId: 'secret',
        trigger: 'project_task_chat_completion',
        availability: 'runtime_unavailable',
      },
    ]);
    expect(result.text).not.toContain('secret label');
    expect(result.text).not.toContain('secret target');
  });
  it('does not project chat instances for catalog-only discovery', async () => {
    await executeCanopyInjectedTool(
      'search_watchers',
      { includeActive: false },
      runtime(),
    );
    expect(mockProjectCanonicalChatWatchers).not.toHaveBeenCalled();
  });
  it('re-evaluates bot access per call and filters before limits and exact trigger recovery', async () => {
    mockIsBotAccessAllowed
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const denied = await executeCanopyInjectedTool(
      'search_watchers',
      { trigger: 'bot_task_chat_completion', limit: 1 },
      runtime(),
    );
    expect(parseWatcherResult(denied.text).catalog).toEqual([]);
    const allowed = await executeCanopyInjectedTool(
      'search_watchers',
      { trigger: 'bot_task_chat_completion', limit: 1 },
      runtime(),
    );
    expect(parseWatcherResult(allowed.text).catalog).toHaveLength(1);
    const revoked = await executeCanopyInjectedTool(
      'search_watchers',
      { trigger: 'bot_task_chat_completion', limit: 1 },
      runtime(),
    );
    expect(parseWatcherResult(revoked.text).catalog).toEqual([]);
    expect(mockIsBotAccessAllowed).toHaveBeenCalledTimes(3);
    expect(mockIsBotAccessAllowed).toHaveBeenCalledWith({
      kind: 'project_agent',
      ...scope,
    });
  });

  it('keeps every active watcher when the exact trigger is not offered', async () => {
    seedSearchInstances();
    const result = parseWatcherResult(
      (
        await executeCanopyInjectedTool(
          'search_watchers',
          { trigger: 'bot_task_chat_completion' },
          runtime(),
        )
      ).text,
    );
    expect(result.catalog).toEqual([]);
    const rows = result.activeWatchers;
    if (!Array.isArray(rows)) throw new Error('Expected instance rows');
    expect(
      rows.map((row: unknown) => (isRecord(row) ? row.id : undefined)),
    ).toEqual(['pipeline', 'chat', 'project-wide', 'bot', 'redacted']);
    expect(result.activeTotalMatches).toBe(5);
  });
});

describe('canonical watcher discovery capabilities', () => {
  it('advertises bot and project chat watching only after canonical routing is installed', async () => {
    const { requireBot } = await import('../project-discovery/bots/registry');
    const { botChatRow } = await import('../project-discovery/bots/rows');
    const { projectChatRow } = await import('../project-discovery/chats-list');
    const tab = {
      id: 'chat-1',
      title: 'Target chat',
      messages: [],
      createdAt: '2026-10-16T00:00:00.000Z',
    };
    const snapshot: ChatStateSnapshot = {
      schemaVersion: 1,
      projectId: 'p',
      worktreeId: 'task-1',
      revision: 1,
      tabsFile: { version: 1, tabs: [tab], activeTabId: tab.id },
      archives: [],
      runtimeByChatId: {},
      queue: [],
    };
    expect(requireBot('app_advisor').capabilities.watchChats).toBe(true);
    expect(
      botChatRow('app_advisor', 'task-1', tab, snapshot).capabilities.canWatch,
    ).toBe(true);
    expect(
      botChatRow('app_advisor', 'task-1', tab, snapshot).capabilities
        .unavailableReason,
    ).not.toContain('watching');
    expect(
      projectChatRow('p', 'task-1', tab, snapshot).capabilities.canWatch,
    ).toBe(true);
  });
});
