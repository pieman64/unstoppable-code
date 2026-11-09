import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AppAdvisorActionResponse,
  AppAdvisorUiStateSnapshot,
} from '@canopy/desktop-shared/types';
import type * as AppAdvisorIpcModule from '../../ipc/app-advisor';
import type { AdvisorStoredChatTab } from '../advisor-chat-reads';
import type {
  AdvisorChatSettingsHost,
  ChatUpdateOutcome,
} from '../advisor-chat-settings';

jest.mock('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: { getAllWindows: (): [] => [] },
  ipcMain: { on: jest.fn(), removeHandler: jest.fn(), handle: jest.fn() },
}));

const mockRequestRendererTool = jest.fn();
jest.mock('../../ipc/app-advisor', (): object => ({
  ...jest.requireActual<typeof AppAdvisorIpcModule>('../../ipc/app-advisor'),
  requestAppAdvisorRendererTool: (...args: unknown[]): unknown =>
    mockRequestRendererTool(...args),
  routeRendererToolRequest: (): null => null,
}));

let mockHost: AdvisorChatSettingsHost;
jest.mock('../advisor-chat-settings-host', () => ({
  mainAdvisorChatSettingsHost: (): AdvisorChatSettingsHost => mockHost,
}));

import { normalizePluginSelections } from '@canopy/desktop-shared/lib/plugin-selections-normalization';
import { AdvisorActionRuns } from '@canopy/core-runtime/node/agent/advisor';
import { OperationService } from '@canopy/core-runtime/node/operations';
import { OperationLedger } from '@canopy/core-runtime/node/operations/ledger';
import {
  APP_ADVISOR_GUARDED_PRESENTATION_ACTION_TYPES,
  appAdvisorActionDisposition,
} from '@canopy/desktop-shared/lib/app-advisor-action-dispositions';
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  initClaudeModels,
  initCodexModels,
} from '@canopy/desktop-shared/types';
import {
  routeAppAdvisorAction,
  type AppAdvisorActionCall,
} from '../action-router';
import { ADVISOR_CHAT_SETTING_ACTION_TYPES } from '../advisor-chat-settings';
import { dispatchActionSchema } from '../definitions';
import { createAppAdvisorToolRuntime } from '../runtime';

const GUARDED = [
  'worktree-chat.set_model',
  'worktree-chat.set_plan_mode',
  'worktree-chat.set_thinking_level',
  'standalone-chat.set_model',
  'standalone-chat.set_thinking_level',
  'pipeline-assistant-chat.set_model',
  'pipeline-assistant-chat.set_thinking_level',
];

function tab(
  overrides: Partial<AdvisorStoredChatTab> = {},
): AdvisorStoredChatTab {
  return {
    id: 'chat-1',
    title: 'Chat',
    createdAt: '2026-11-08T00:00:00.000Z',
    messages: [],
    status: 'idle',
    queuedMessages: [],
    model: 'sonnet',
    providerType: 'claude',
    ...overrides,
  };
}

let root: string;
let operations: OperationService;
let runs: AdvisorActionRuns;
let calls: Record<string, unknown[]>;
let storedTab: AdvisorStoredChatTab;
let windowOpen: boolean;
let leased: boolean;
let ui: AppAdvisorUiStateSnapshot | null;
let updateOutcome: ChatUpdateOutcome;
let liveApplies: boolean;

function recordingHost(): AdvisorChatSettingsHost {
  return {
    readUiState: () => Promise.resolve(ui),
    readTabs: () =>
      Promise.resolve({ activeTabId: 'chat-1', tabs: [storedTab] }),
    locateCoworkChat: (projectId, chatId) => {
      (calls.locate ??= []).push([projectId, chatId]);
      return Promise.resolve(
        chatId === 'archived'
          ? { entryId: null, archivedInEntryId: 'entry-1' }
          : { entryId: 'entry-1', archivedInEntryId: null },
      );
    },
    isMainWindowOpen: () => windowOpen,
    hasPresentationLease: () => Promise.resolve(leased),
    presentInMainWindow: (action) => {
      (calls.present ??= []).push(action);
      return Promise.resolve({
        requestId: 'presented',
        ok: true,
        result: { applied: action.type },
      });
    },
    updateChat: (request) => {
      (calls.update ??= []).push(request);
      return Promise.resolve({ outcome: updateOutcome });
    },
    applyLivePluginSelections: (request) => {
      (calls.live ??= []).push(request);
      return Promise.resolve(liveApplies);
    },
    restartTerminal: (target) => {
      (calls.restart ??= []).push(target);
      return Promise.resolve();
    },
  };
}

function setup(): {
  route(
    input: unknown,
    call?: Partial<AppAdvisorActionCall>,
  ): Promise<AppAdvisorActionResponse>;
} {
  const runtime = createAppAdvisorToolRuntime(
    {
      getMainWindow: jest.fn(() => null),
      getAppAdvisorWindow: jest.fn(() => null),
      openAppAdvisorWindow: jest.fn(),
      ensureAppAdvisorWindow: jest.fn(),
    },
    {
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: APP_ADVISOR_WORKTREE_ID,
      chatId: 'advisor-chat',
    },
  );
  return {
    route: async (input, call) => {
      const routed = await routeAppAdvisorAction(
        dispatchActionSchema.parse({ action: input }).action,
        runtime,
        { toolUseId: 'toolu_1', ...call },
        { runs: () => runs },
      );
      return JSON.parse(routed.text) as AppAdvisorActionResponse;
    },
  };
}

const TARGET = { projectId: 'proj', worktreeId: 'wt', chatId: 'chat-1' };

beforeEach(() => {
  initClaudeModels([
    { id: 'opus[1m]', label: 'Opus' },
    { id: 'sonnet', label: 'Sonnet' },
  ]);
  initCodexModels([{ id: 'gpt-6.1-sol', label: 'Codex default' }]);
  root = mkdtempSync(join(tmpdir(), 'can-5999-settings-'));
  const ledgerPath = join(root, 'ledger.sqlite');
  operations = new OperationService({
    openLedger: (): OperationLedger => OperationLedger.open(ledgerPath),
  });
  runs = new AdvisorActionRuns({ operations });
  calls = {};
  storedTab = tab();
  windowOpen = false;
  leased = false;
  ui = null;
  updateOutcome = 'applied';
  liveApplies = true;
  mockHost = recordingHost();
  mockRequestRendererTool.mockClear();
});
afterEach(() => {
  operations.close();
  rmSync(root, { recursive: true, force: true });
});

describe('App Advisor chat setters in main (CAN-5999 part 2)', () => {
  it('the fifteen setters are core chat writes; model, plan and thinking may be presented when guarded', () => {
    expect(ADVISOR_CHAT_SETTING_ACTION_TYPES).toHaveLength(15);
    for (const type of ADVISOR_CHAT_SETTING_ACTION_TYPES)
      expect(appAdvisorActionDisposition(type)).toEqual({
        kind: 'core',
        access: 'write',
        executor: 'worktree-actions',
        grants: ['core.chat.write'],
        revision: 'none',
        ...(GUARDED.includes(type) ? { presentationWhenGuarded: true } : {}),
      });
    expect([...APP_ADVISOR_GUARDED_PRESENTATION_ACTION_TYPES].sort()).toEqual(
      [...GUARDED].sort(),
    );
    expect(
      appAdvisorActionDisposition('worktree-chat.set_interface_mode'),
    ).toMatchObject({ kind: 'legacy' });
  });

  it('with no window, a model change runs through core.chat.update and restarts the terminal', async () => {
    const result = await setup().route({
      type: 'worktree-chat.set_model',
      ...TARGET,
      model: 'opus[1m]',
    });

    expect(result).toMatchObject({ ok: true, result: { model: 'opus[1m]' } });
    expect(calls.update).toEqual([
      {
        projectId: 'proj',
        worktreeId: 'wt',
        action: {
          type: 'chat.set_model',
          tabId: 'chat-1',
          model: 'opus[1m]',
          providerType: 'claude',
        },
        idempotencyKey: 'app-advisor-action:advisor-chat:toolu_1:settings',
      },
    ]);
    expect(calls.restart).toEqual([TARGET]);
    expect(calls.present).toBeUndefined();
  });

  it('with a window open, a model change is applied in the window and never written through core', async () => {
    windowOpen = true;
    leased = true;
    const result = await setup().route({
      type: 'worktree-chat.set_model',
      ...TARGET,
      model: 'opus[1m]',
    });

    expect(result).toMatchObject({
      ok: true,
      result: {
        applied: 'worktree-chat.set_model',
        presentedInMainWindow: true,
        guard: 'model_with_window',
      },
    });
    expect(calls.update).toBeUndefined();
  });

  it('a guarded model change with no lease is refused with its reason, and nothing is written', async () => {
    windowOpen = true;
    const windowed = await setup().route({
      type: 'worktree-chat.set_model',
      ...TARGET,
      model: 'opus[1m]',
    });
    windowOpen = false;
    const unsupported = await setup().route(
      { type: 'worktree-chat.set_model', ...TARGET, model: 'copilot:gpt-5' },
      { toolUseId: 'toolu_2' },
    );

    expect(windowed).toMatchObject({
      ok: false,
      error: { code: 'surface_unavailable' },
    });
    expect(unsupported).toMatchObject({
      ok: false,
      error: { code: 'surface_unavailable' },
    });
    expect(unsupported.error?.message).toContain('can only be chosen in');
    expect(calls.update).toBeUndefined();
    expect(calls.present).toBeUndefined();
  });

  it('an unsupported model provider is applied in the window when one serves the lease', async () => {
    leased = true;
    const result = await setup().route({
      type: 'worktree-chat.set_model',
      ...TARGET,
      model: 'copilot:gpt-5',
    });

    expect(result).toMatchObject({
      ok: true,
      result: { guard: 'unsupported_provider', presentedInMainWindow: true },
    });
    expect(calls.update).toBeUndefined();
  });

  it('turning plan mode off over a pending plan goes to the window, and otherwise through core', async () => {
    storedTab = tab({ planMode: true, pendingPlanExitRequestId: 'exit-1' });
    const refused = await setup().route({
      type: 'worktree-chat.set_plan_mode',
      ...TARGET,
      enabled: false,
    });
    leased = true;
    const presented = await setup().route(
      { type: 'worktree-chat.set_plan_mode', ...TARGET, enabled: false },
      { toolUseId: 'toolu_2' },
    );
    expect(refused).toMatchObject({
      ok: false,
      error: { code: 'surface_unavailable' },
    });
    expect(presented).toMatchObject({
      ok: true,
      result: { guard: 'pending_plan', presentedInMainWindow: true },
    });
    expect(calls.update).toBeUndefined();

    storedTab = tab({ planMode: false });
    const core = await setup().route(
      { type: 'worktree-chat.set_plan_mode', ...TARGET, enabled: true },
      { toolUseId: 'toolu_3' },
    );
    expect(core).toMatchObject({ ok: true, result: { planMode: true } });
    expect(calls.update).toEqual([
      expect.objectContaining({
        action: {
          type: 'chat.patch_tab_settings',
          tabId: 'chat-1',
          patch: { planMode: true },
        },
      }),
    ]);
  });

  it('thinking on a visible Claude terminal goes to the window; with no window it runs through core and restarts the terminal', async () => {
    storedTab = tab({ interfaceMode: 'claude-code' });
    windowOpen = true;
    const refused = await setup().route({
      type: 'worktree-chat.set_thinking_level',
      ...TARGET,
      level: 'high',
    });
    leased = true;
    const presented = await setup().route(
      { type: 'worktree-chat.set_thinking_level', ...TARGET, level: 'high' },
      { toolUseId: 'toolu_2' },
    );
    expect(refused).toMatchObject({
      ok: false,
      error: { code: 'surface_unavailable' },
    });
    expect(presented).toMatchObject({
      ok: true,
      result: { guard: 'visible_terminal', presentedInMainWindow: true },
    });
    expect(calls.update).toBeUndefined();

    windowOpen = false;
    const core = await setup().route(
      { type: 'worktree-chat.set_thinking_level', ...TARGET, level: 'low' },
      { toolUseId: 'toolu_3' },
    );
    expect(core).toMatchObject({ ok: true, result: { thinkingLevel: 'low' } });
    expect(calls.update).toEqual([
      expect.objectContaining({
        action: {
          type: 'chat.patch_tab_settings',
          tabId: 'chat-1',
          patch: { modelConfig: { thinkingLevel: 'low' } },
        },
      }),
    ]);
    expect(calls.restart).toEqual([TARGET]);
  });

  it('fast mode and speed run through core on a Codex chat and are refused on others, never presented', async () => {
    storedTab = tab({ model: 'gpt-6.1-sol', providerType: 'codex' });
    const fast = await setup().route({
      type: 'worktree-chat.set_fast_mode',
      ...TARGET,
      enabled: true,
    });
    const speed = await setup().route(
      { type: 'worktree-chat.set_speed', ...TARGET, speed: 'standard' },
      { toolUseId: 'toolu_2' },
    );
    expect(fast).toMatchObject({ ok: true, result: { speed: 'fast' } });
    expect(speed).toMatchObject({ ok: true, result: { speed: 'standard' } });
    expect(calls.update).toEqual([
      expect.objectContaining({
        action: {
          type: 'chat.patch_tab_settings',
          tabId: 'chat-1',
          patch: { modelConfig: { fastMode: true } },
        },
      }),
      expect.objectContaining({
        action: {
          type: 'chat.patch_tab_settings',
          tabId: 'chat-1',
          patch: { modelConfig: { speed: 'standard' } },
        },
      }),
    ]);

    storedTab = tab();
    leased = true;
    const claudeFast = await setup().route(
      { type: 'worktree-chat.set_fast_mode', ...TARGET, enabled: true },
      { toolUseId: 'toolu_3' },
    );
    const claudeSpeed = await setup().route(
      { type: 'worktree-chat.set_speed', ...TARGET, speed: 'fast' },
      { toolUseId: 'toolu_4' },
    );
    expect(claudeFast).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_target',
        message: 'Fast mode is only available for supported model providers.',
      },
    });
    expect(claudeSpeed).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_target',
        message: 'Speed is only available for Codex chats.',
      },
    });
    expect(calls.update).toHaveLength(2);
    expect(calls.present).toBeUndefined();
  });

  it('Ultra fast on an Auto model is refused as the speed picker refuses it', async () => {
    storedTab = tab({
      model: 'gpt-6.1-sol',
      providerType: 'codex',
      modelSelectionMode: 'auto',
    });
    const result = await setup().route({
      type: 'worktree-chat.set_speed',
      ...TARGET,
      speed: 'ultrafast',
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'invalid_target' },
    });
    expect(calls.update).toBeUndefined();
  });

  it('a read-only chat is refused for every setter, and nothing is written or presented', async () => {
    storedTab = tab({ readOnly: true });
    leased = true;
    const result = await setup().route({
      type: 'worktree-chat.set_thinking_level',
      ...TARGET,
      level: 'high',
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'invalid_target', message: 'This chat is read-only.' },
    });
    expect(calls.update).toBeUndefined();
    expect(calls.present).toBeUndefined();
  });

  it('a read-only chat refuses a model change even with a window open and a lease', async () => {
    storedTab = tab({ readOnly: true });
    windowOpen = true;
    leased = true;
    const result = await setup().route({
      type: 'worktree-chat.set_model',
      ...TARGET,
      model: 'opus[1m]',
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'invalid_target', message: 'This chat is read-only.' },
    });
    expect(calls.present).toBeUndefined();
    expect(calls.update).toBeUndefined();
  });

  it('the window applies the change to the chat main checked, not its current selection', async () => {
    ui = {
      selectedWorktree: { projectId: 'proj', worktreeId: 'wt' },
    } as AppAdvisorUiStateSnapshot;
    windowOpen = true;
    leased = true;
    await setup().route({ type: 'worktree-chat.set_model', model: 'opus[1m]' });
    await setup().route(
      { type: 'pipeline-assistant-chat.set_model', model: 'opus[1m]' },
      { toolUseId: 'toolu_2' },
    );

    expect(calls.present).toEqual([
      {
        type: 'worktree-chat.set_model',
        model: 'opus[1m]',
        projectId: 'proj',
        worktreeId: 'wt',
        chatId: 'chat-1',
      },
      {
        type: 'pipeline-assistant-chat.set_model',
        model: 'opus[1m]',
        chatId: 'chat-1',
      },
    ]);
  });

  it('an archived Cowork chat is refused before any write', async () => {
    const result = await setup().route({
      type: 'standalone-chat.set_thinking_level',
      projectId: 'cw',
      chatId: 'archived',
      level: 'high',
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_target',
        message:
          'Archived standalone chats are read-only. Restore the chat before applying mutations.',
      },
    });
    expect(calls.update).toBeUndefined();
  });

  it('a Cursor model is refused before any chat is read', async () => {
    const result = await setup().route({
      type: 'pipeline-assistant-chat.set_model',
      model: 'cursor:auto',
    });

    expect(result).toMatchObject({
      ok: false,
      error: { message: 'Cursor is not available in Pipeline Assistant.' },
    });
    expect(calls.update).toBeUndefined();
  });

  it('an implicit worktree with no lease is refused, never guessed', async () => {
    const result = await setup().route({
      type: 'worktree-chat.set_thinking_level',
      level: 'high',
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'surface_unavailable' },
    });
    expect(calls.update).toBeUndefined();
  });

  it('a change core rejects answers its reason', async () => {
    updateOutcome = 'rejected';
    const result = await setup().route({
      type: 'standalone-chat.set_model',
      projectId: 'cw',
      chatId: 'chat-1',
      model: 'opus[1m]',
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_target',
        message: 'The model or harness change was not accepted.',
      },
    });
    expect(calls.locate).toEqual([['cw', 'chat-1']]);
  });

  it('a plugin change commits against the selections main read, then updates the live session, with no window', async () => {
    windowOpen = true;
    storedTab = tab({
      pluginSelections: {
        collectionIds: [],
        skillRefs: [{ sourceId: 'user', skillName: 'deploy' }],
        pluginRefs: [],
      },
    });
    const result = await setup().route({
      type: 'worktree-chat.update_plugin_selection',
      ...TARGET,
      kind: 'skill',
      key: 'user/review',
      enabled: true,
    });
    const selections = {
      collectionIds: [],
      skillRefs: [
        { sourceId: 'user', skillName: 'deploy' },
        { sourceId: 'user', skillName: 'review' },
      ],
      pluginRefs: [],
      mcpServerRefs: [],
    };

    expect(result).toMatchObject({
      ok: true,
      result: { liveSessionUpdated: true },
    });
    expect(calls.update).toEqual([
      {
        projectId: 'proj',
        worktreeId: 'wt',
        action: {
          type: 'chat.patch_tab_settings',
          tabId: 'chat-1',
          patch: { pluginSelections: selections },
          expectedPluginSelections: normalizePluginSelections(
            storedTab.pluginSelections,
          ),
        },
        idempotencyKey: 'app-advisor-action:advisor-chat:toolu_1:settings',
      },
    ]);
    expect(calls.live).toEqual([{ ...TARGET, pluginSelections: selections }]);
    expect(calls.present).toBeUndefined();
  });

  it('the Pipeline Assistant keeps its required skill', async () => {
    await setup().route({
      type: 'pipeline-assistant-chat.set_plugin_selections',
      selections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
    });

    const live = calls.live as Array<{
      pluginSelections: { skillRefs: unknown[] };
    }>;
    expect(live[0]?.pluginSelections.skillRefs).toHaveLength(1);
  });

  it('a plugin change that conflicts updates no live session', async () => {
    updateOutcome = 'conflict';
    const result = await setup().route({
      type: 'standalone-chat.set_plugin_selections',
      projectId: 'cw',
      chatId: 'chat-1',
      selections: { collectionIds: ['c1'], skillRefs: [], pluginRefs: [] },
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'stale_ui_state', retryable: true },
    });
    expect(calls.live).toBeUndefined();
    // A chat with no stored selections is still compared, so a concurrent
    // edit to it conflicts instead of being replaced.
    expect(calls.update?.[0]).toMatchObject({
      action: {
        expectedPluginSelections: normalizePluginSelections(undefined),
      },
    });
  });

  it('a committed plugin change the live session cannot take now still succeeds, and says so', async () => {
    liveApplies = false;
    const result = await setup().route({
      type: 'worktree-chat.set_plugin_selections',
      ...TARGET,
      selections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
    });

    expect(result).toMatchObject({
      ok: true,
      result: { liveSessionUpdated: false },
    });
  });

  it('a read-only chat refuses a plugin change before any write', async () => {
    storedTab = tab({ readOnly: true });
    const result = await setup().route({
      type: 'worktree-chat.set_plugin_selections',
      ...TARGET,
      selections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'invalid_target' },
    });
    expect(calls.update).toBeUndefined();
    expect(calls.live).toBeUndefined();
  });

  it('a setter writes once per tool call', async () => {
    const h = setup();
    const input = {
      type: 'worktree-chat.set_thinking_level',
      ...TARGET,
      level: 'high',
    };
    const first = await h.route(input, { toolUseId: 'toolu_9' });
    const second = await h.route(input, { toolUseId: 'toolu_9' });

    expect(second).toEqual(first);
    expect(calls.update).toHaveLength(1);
  });
});
