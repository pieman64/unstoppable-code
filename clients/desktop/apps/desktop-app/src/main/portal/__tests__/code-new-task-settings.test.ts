import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initClaudeModels,
  initCodexModels,
  initModelHarnessAssignments,
  type ChatStateCommandPort,
  type ChatSendMessageRequest,
  type PortalCommandEnvelope,
  type PortalCommandType,
  type PortalEventEnvelope,
} from '@canopy/desktop-shared/types';
import type * as ChatServiceModule from '../../services/chat-service';
import type * as OpenCodeRuntimeAvailability from '../../opencode/runtime-availability';
import { registerWorkspaceTypes } from '../../lib/workspace-registry';
import { ChatStateService } from '../../services/chat-state-service';
import { ChatStateV2Repository } from '../../services/chat-state-v2-repository';
import { createDesktopRuntime } from '../../canopy-runtime/desktop-runtime';
import { handlePortalCommand } from '../portal-command-handlers';

let mockPort: ChatStateCommandPort;
const mockLegacySend = jest.fn();
const mockBuildOptions = jest.fn<
  ReturnType<typeof ChatServiceModule.buildExistingTabDispatchOptions>,
  Parameters<typeof ChatServiceModule.buildExistingTabDispatchOptions>
>();
const mockBlocked = jest.fn<Promise<boolean>, [string]>();
let mockOpenCodeAvailable = false;

jest.mock('../../services/chat-service', () => ({
  buildExistingTabDispatchOptions: (
    ...args: Parameters<
      typeof ChatServiceModule.buildExistingTabDispatchOptions
    >
  ): ReturnType<typeof ChatServiceModule.buildExistingTabDispatchOptions> =>
    mockBuildOptions(...args),
  assertWorktreeChatSendNotSplitLocked: jest.fn(),
  sendWorktreeChatMessage: (...args: unknown[]): unknown =>
    mockLegacySend(...args),
}));
jest.mock('../../opencode/runtime-availability', () => ({
  ...jest.requireActual<typeof OpenCodeRuntimeAvailability>(
    '../../opencode/runtime-availability',
  ),
  isOpenCodeRuntimeAvailable: (): Promise<boolean> =>
    Promise.resolve(mockOpenCodeAvailable),
}));
jest.mock('../../lib/model-policy-state', () => ({
  isModelBlockedByStoredPolicy: (model: string): Promise<boolean> =>
    mockBlocked(model),
  isOrgModelPolicyActiveForStoredAccount: (): Promise<boolean> =>
    Promise.resolve(false),
}));
jest.mock('../../lib/default-model-lane-resolver', () => ({
  resolveConcreteModelDispatchability: (): Promise<string> =>
    Promise.resolve('dispatchable'),
  resolveLaneAwareDefaultSelection: (): Promise<{
    outcome: 'resolved';
    selection: { model: string };
  }> =>
    Promise.resolve({
      outcome: 'resolved',
      selection: { model: 'gpt-5.2-codex' },
    }),
}));
jest.mock('../../lib/preferences-store', () => ({
  readPreferencesFile: (): Promise<object> => Promise.resolve({}),
}));
jest.mock('../../ipc/chat-state', () => ({
  getChatStateCommandPort: (): ChatStateCommandPort => mockPort,
}));
jest.mock('../portal-session-manager', () => ({
  getCanopyPortalState: (): { sessionId: string } => ({
    sessionId: 'session-original',
  }),
}));
jest.mock('../portal-snapshot-builders', () => ({
  buildPortalSnapshot: jest.fn(),
}));

const scope = { projectId: 'code-workspace', worktreeId: 'task-one' };
const target = {
  workspaceLocalId: scope.projectId,
  worktreeLocalId: scope.worktreeId,
};
const pluginSelections = {
  collectionIds: ['collection-one'],
  skillRefs: [{ sourceId: 'source-one', skillName: 'review' }],
  pluginRefs: [{ marketplaceId: 'market-one', pluginName: 'lint' }],
};

function envelope(
  id: string,
  type: PortalCommandType,
  payload: Record<string, unknown>,
): PortalCommandEnvelope {
  return {
    id,
    sequence: 1,
    type,
    target,
    payload: { ...scope, chatId: 'chat-one', ...payload },
    createdAt: new Date().toISOString(),
    expiresAt: null,
  };
}

// These tests do real filesystem and git work. Under a loaded multi-worker
// Jest run they have exceeded Jest's default 5 s, so leave headroom here.
jest.setTimeout(30_000);

describe('remote Code New Task settings', () => {
  let directory = '';
  let service: ChatStateService;
  let repository: ChatStateV2Repository;
  let runtime: ReturnType<typeof createDesktopRuntime>;
  let events: PortalEventEnvelope[];
  const dispatch = jest.fn<Promise<void>, [ChatSendMessageRequest]>();

  async function run(command: PortalCommandEnvelope): Promise<void> {
    await handlePortalCommand(command, {
      chatDispatcher: runtime,
      sessionId: 'session-original',
      pairingCode: null,
      canReadAssets: (): boolean => true,
      getWindow: () => null,
      markAuthenticated: jest.fn(),
      stop: (): Promise<void> => Promise.resolve(),
      enqueueEvent: (event): void => {
        events.push(event);
      },
    });
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    events = [];
    mockBlocked.mockReset().mockResolvedValue(false);
    mockOpenCodeAvailable = false;
    directory = await mkdtemp(join(tmpdir(), 'code-new-task-settings-'));
    registerWorkspaceTypes(new Map([[scope.projectId, 'single-repo']]));
    initClaudeModels([{ id: 'claude-opus-4-6', label: 'Opus' }]);
    initCodexModels([{ id: 'gpt-5.2-codex', label: 'Codex' }]);
    initModelHarnessAssignments({ revision: 0, assignments: [] });
    repository = new ChatStateV2Repository({
      resolvePaths: (): {
        tabs: string;
        archives: string;
        journal: string;
      } => ({
        tabs: join(directory, 'chats.json'),
        archives: join(directory, 'archives.json'),
        journal: join(directory, 'journal.jsonl'),
      }),
    });
    dispatch.mockReset().mockResolvedValue(undefined);
    service = new ChatStateService({
      repository,
      dispatch,
      cleanupSession: (): Promise<void> => Promise.resolve(),
      onInputPickup: (): Promise<void> => Promise.resolve(),
      authorizeSend: (): Promise<void> => Promise.resolve(),
      recordDiagnostic: jest.fn(),
    });
    mockPort = service;
    runtime = createDesktopRuntime({
      chatCommandPort: service,
      getChatStatePort: () => mockPort,
      chatServices: { getPort: () => mockPort },
    });
    mockBuildOptions.mockImplementation(async () => {
      const state = await service.getState(scope);
      const tab = state.tabsFile.tabs.find(({ id }) => id === 'chat-one');
      return {
        ...(tab?.model ? { model: tab.model } : {}),
        ...(tab?.providerType ? { providerType: tab.providerType } : {}),
        ...(tab?.modelConfig ? { modelConfig: tab.modelConfig } : {}),
      };
    });
  });

  afterEach(async () => {
    await runtime.shutdown();
    await repository.drainAll();
    await rm(directory, { recursive: true, force: true });
    registerWorkspaceTypes(new Map());
  });

  it('runs the first prompt with the submitted model, Auto mode and plugins', async () => {
    // The browser's New Task sequence: create the chat it minted, then send
    // the draft to it through the canonical path.
    await run(
      envelope('create-chat', 'portal.chat.create_tab', {
        model: 'claude-opus-4-6',
        providerType: 'claude',
        pluginSelections,
      }),
    );
    expect(events.at(-1)?.type).toBe('portal.command.completed');
    await run(
      envelope('send-draft', 'portal.chat.send', {
        userMessageId: 'message-one',
        text: 'Start the task',
        planMode: false,
        model: 'claude-opus-4-6',
        providerType: 'claude',
        modelSelectionMode: 'auto',
        pluginSelections,
      }),
    );
    expect(events.at(-1)?.type).toBe('portal.command.completed');
    expect(mockLegacySend).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0]).toMatchObject({
      chatId: 'chat-one',
      model: 'claude-opus-4-6',
      providerType: 'claude',
      modelSelectionMode: 'auto',
      pluginSelections,
    });
    const tab = (await service.getState(scope)).tabsFile.tabs.find(
      ({ id }) => id === 'chat-one',
    );
    expect(tab).toMatchObject({
      model: 'claude-opus-4-6',
      providerType: 'claude',
      modelSelectionMode: 'auto',
      pluginSelections,
    });
    // An explicit choice is not a default stamp that a later default change
    // may silently reconcile away.
    expect(tab).not.toHaveProperty('defaultStampModel');
  });

  it('still seeds the desktop default when the browser submits no settings', async () => {
    await run(envelope('create-chat', 'portal.chat.create_tab', {}));
    await run(
      envelope('send-draft', 'portal.chat.send', {
        userMessageId: 'message-one',
        text: 'Start the task',
      }),
    );
    expect(dispatch.mock.calls[0][0]).toMatchObject({
      model: 'gpt-5.2-codex',
      providerType: 'codex',
    });
    expect(dispatch.mock.calls[0][0]).not.toHaveProperty('modelSelectionMode');
  });

  it.each([
    ['an unsupported provider', { model: 'claude-opus-4-6', providerType: 7 }],
    ['a non-string model', { model: 42 }],
    ['malformed plugin selections', { pluginSelections: ['collection-one'] }],
  ])('refuses %s before creating the chat', async (_label, settings) => {
    await run(envelope('create-chat', 'portal.chat.create_tab', settings));
    expect(events.at(-1)?.type).toBe('portal.command.failed');
    expect((await service.getState(scope)).tabsFile.tabs).toEqual([]);
  });

  it('refuses a policy-blocked submitted model before creating the chat', async () => {
    mockBlocked.mockImplementation((model) =>
      Promise.resolve(model === 'claude-opus-4-6'),
    );
    await run(
      envelope('create-chat', 'portal.chat.create_tab', {
        model: 'claude-opus-4-6',
      }),
    );
    expect(events.at(-1)).toMatchObject({
      type: 'portal.command.failed',
      payload: {
        error: {
          code: 'invalid_payload',
          message: 'This model is blocked by your organization policy.',
        },
      },
    });
    expect((await service.getState(scope)).tabsFile.tabs).toEqual([]);
  });

  it.each([
    ['provider', { model: 'claude-opus-4-6', providerType: 'opencode' }],
    ['model', { model: 'opencode:fixture%2Fmodel' }],
    ['harness', { model: 'gateway-model' }],
  ])(
    'refuses an OpenCode %s with connect guidance while the runtime is unavailable',
    async (route, settings) => {
      // A non-OpenCode model can still run on the OpenCode harness.
      if (route === 'harness')
        initModelHarnessAssignments({
          revision: 1,
          assignments: [
            {
              modelId: 'gateway-model',
              source: 'ai-gateway',
              harness: 'opencode',
              defaultHarness: 'claude',
              configurable: true,
              overridden: true,
            },
          ],
        });
      await run(envelope('create-chat', 'portal.chat.create_tab', settings));
      expect(events.at(-1)).toMatchObject({
        type: 'portal.command.failed',
        payload: {
          error: {
            code: 'invalid_payload',
            message: 'Connect OpenCode in the desktop app to use it here.',
          },
        },
      });
      expect((await service.getState(scope)).tabsFile.tabs).toEqual([]);
    },
  );

  it('creates an OpenCode chat when the runtime is available', async () => {
    mockOpenCodeAvailable = true;
    await run(
      envelope('create-chat', 'portal.chat.create_tab', {
        model: 'opencode:fixture%2Fmodel',
        providerType: 'opencode',
      }),
    );
    expect(events.at(-1)?.type).toBe('portal.command.completed');
    expect(
      (await service.getState(scope)).tabsFile.tabs.find(
        ({ id }) => id === 'chat-one',
      ),
    ).toMatchObject({
      model: 'opencode:fixture%2Fmodel',
      providerType: 'opencode',
    });
  });
});
