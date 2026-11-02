import { randomUUID } from 'node:crypto';
import {
  APP_ADVISOR_PROJECT_ID,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_MODEL,
  IPC_CHANNELS,
  type ChatSendMessageRequest,
  type AppAdvisorWindowState,
  type WorkspaceType,
} from '@canopy/desktop-shared/types';
import { BrowserWindow, ipcMain } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import type {
  PipelineChatTarget,
  PipelineGeneratedInput,
  PipelineHost,
  PipelineHostAdapter,
  PipelineHostOptions,
  PipelineProvider,
  PipelineSendInput,
  PipelineSettingsPatch,
} from './contracts';
import type { WindowAccessors } from '../../ipc';
import { dispatchAppAdvisorChatMessage } from '../../app-advisor/chat-service';
import type { AppAdvisorToolRuntimeSurfaces } from '../../app-advisor/runtime';
import { stopChatTurn } from '../../lib/chat-turn-stop';
import { installDelegationLifecycle } from '../../agents/delegation/lifecycle';
import * as paths from '../../lib/paths';
import * as workspaceRegistry from '../../lib/workspace-registry';
import * as resolveWorktree from '../../lib/resolve-worktree';
import * as workspacePersistence from '../../lib/workspace-persistence';
import * as coworkWorkEntries from '../../lib/cowork-work-entries';
import { drainCurrentSessionEvents } from '../../agents/session-event-router';
import {
  buildExistingTabDispatchOptions,
  dispatchHostQueuedWorktreeChatMessage,
  sendWorktreeChatMessage,
  setSpecialNativeChatDispatcher,
} from '../../services/chat-service';
import type { ChatQueueService } from '../../services/chat-queue-service';
import { sendStandaloneChatMessage } from '../../services/standalone-chat-service';
import type { ChatStateService } from '../../services/chat-state-service';
import { deliverWatcherMessageToChat } from '../../services/watcher-chat-delivery';

interface PipelineHostAdapterOptions {
  kind: PipelineHost;
  provider: PipelineProvider;
  target: PipelineChatTarget;
  hostOptions?: PipelineHostOptions;
  service: ChatStateService;
  queue: ChatQueueService;
  root: string;
  drain: () => Promise<void>;
}

const workspaceTypes = new Map<string, WorkspaceType>();
const rootsByProject = new Map<string, string>();
const rootsByScope = new Map<string, string>();
const workEntries = new Map<string, Map<string, Set<string>>>();
const delegationDeliveries = new Map<
  string,
  { target: PipelineChatTarget; active: boolean; claimed: boolean }
>();

function scopeKey(projectId: string, worktreeId: string): string {
  return JSON.stringify([projectId, worktreeId]);
}

function deliveryKey(target: PipelineChatTarget, deliveryId: string): string {
  return JSON.stringify([
    target.projectId,
    target.worktreeId,
    target.chatId,
    deliveryId,
  ]);
}

function installPipelineDelegationLifecycle(): void {
  installDelegationLifecycle({
    shutdown(): Promise<void> {
      delegationDeliveries.clear();
      return Promise.resolve();
    },
    revoke(): Promise<void> {
      delegationDeliveries.clear();
      return Promise.resolve();
    },
    closeScope(scope): Promise<void> {
      Array.from(delegationDeliveries.entries()).forEach(([key, delivery]) => {
        if (
          delivery.target.projectId === scope.projectId &&
          delivery.target.worktreeId === scope.worktreeId &&
          (scope.chatId === undefined ||
            delivery.target.chatId === scope.chatId)
        ) {
          delivery.active = false;
          delegationDeliveries.delete(key);
        }
      });
      return Promise.resolve();
    },
    isDeliveryActive(target, deliveryId): boolean {
      return (
        delegationDeliveries.get(deliveryKey(target, deliveryId))?.active ??
        false
      );
    },
    claimDelivery(target, deliveryId): boolean {
      const delivery = delegationDeliveries.get(
        deliveryKey(target, deliveryId),
      );
      if (!delivery?.active || delivery.claimed) return false;
      delivery.claimed = true;
      return true;
    },
    releaseDelivery(target, deliveryId): void {
      const delivery = delegationDeliveries.get(
        deliveryKey(target, deliveryId),
      );
      if (delivery?.active) delivery.claimed = false;
    },
    retireDelivery(target, deliveryId): void {
      const key = deliveryKey(target, deliveryId);
      const delivery = delegationDeliveries.get(key);
      if (delivery) delivery.active = false;
      delegationDeliveries.delete(key);
    },
  });
}

function registerDelegationDelivery(
  target: PipelineChatTarget,
  deliveryId: string,
): void {
  delegationDeliveries.set(deliveryKey(target, deliveryId), {
    target,
    active: true,
    claimed: false,
  });
}

function registerHostScope(
  kind: PipelineHost,
  target: PipelineChatTarget,
  root: string,
): void {
  rootsByProject.set(target.projectId, root);
  rootsByScope.set(scopeKey(target.projectId, target.worktreeId), root);

  if (kind === 'worktree') workspaceTypes.set(target.projectId, 'single-repo');
  if (kind === 'cowork') workspaceTypes.set(target.projectId, 'cowork');

  let entries = workEntries.get(target.projectId);
  if (!entries) {
    entries = new Map<string, Set<string>>();
    workEntries.set(target.projectId, entries);
  }
  let chats = entries.get(target.worktreeId);
  if (!chats) {
    chats = new Set<string>();
    entries.set(target.worktreeId, chats);
  }
  chats.add(target.chatId);

  jest
    .spyOn(workspaceRegistry, 'getWorkspaceType')
    .mockImplementation((projectId) => workspaceTypes.get(projectId) ?? null);
  jest
    .spyOn(workspaceRegistry, 'isCoworkWorkspace')
    .mockImplementation(
      (projectId) => workspaceTypes.get(projectId) === 'cowork',
    );
  jest
    .spyOn(workspaceRegistry, 'isWorkEntryWorkspace')
    .mockImplementation(
      (projectId) =>
        projectId === APP_ADVISOR_PROJECT_ID ||
        workspaceTypes.get(projectId) === 'cowork',
    );

  jest
    .spyOn(resolveWorktree, 'resolveWorktreeCwd')
    .mockImplementation((projectId, worktreeId) => {
      const resolvedRoot = rootsByScope.get(scopeKey(projectId, worktreeId));
      if (!resolvedRoot) {
        throw new Error(`No pipeline host root for ${projectId}/${worktreeId}`);
      }
      return resolvedRoot;
    });
  jest
    .spyOn(resolveWorktree, 'resolveWorktreeTargetIds')
    .mockImplementation((projectId, worktreeId) =>
      rootsByScope.has(scopeKey(projectId, worktreeId))
        ? { projectId, worktreeId }
        : null,
    );
  jest
    .spyOn(workspacePersistence, 'readWorkspaceConfig')
    .mockImplementation(() =>
      Promise.resolve({
        version: 1,
        type: 'multi-repo',
        repos: [],
        alwaysShow: true,
      }),
    );
  // Registration authorizes against persisted workspace provenance, not the
  // selected navigation context. This fixture is an explicit personal scope.
  jest
    .spyOn(workspacePersistence, 'readWorkspaceConfigDetailed')
    .mockImplementation((projectId) =>
      Promise.resolve({
        config: {
          version: 1,
          type: workspaceTypes.get(projectId) ?? 'multi-repo',
          repos: [],
          alwaysShow: true,
        },
        authority: 'ok',
        ownerMalformed: false,
        memoryMalformed: false,
      }),
    );
  jest
    .spyOn(coworkWorkEntries, 'listWorkEntryIds')
    .mockImplementation((projectId) =>
      Promise.resolve(Array.from(workEntries.get(projectId)?.keys() ?? [])),
    );
  jest
    .spyOn(coworkWorkEntries, 'resolveWorkEntryForChat')
    .mockImplementation((projectId, chatId) => {
      const entriesForProject = workEntries.get(projectId);
      const match = entriesForProject
        ? Array.from(entriesForProject.entries()).find(([, chatIds]) =>
            chatIds.has(chatId),
          )
        : undefined;
      return Promise.resolve({
        entryId: match?.[0] ?? null,
        archivedInEntryId: null,
      });
    });
  jest
    .spyOn(paths, 'getAppAdvisorHomeDir')
    .mockImplementation(
      () => rootsByProject.get(APP_ADVISOR_PROJECT_ID) ?? root,
    );
}

function modelForProvider(provider: PipelineProvider): string {
  return provider === 'claude' ? DEFAULT_CLAUDE_MODEL : DEFAULT_CODEX_MODEL;
}

function noWindow(): null {
  return null;
}

function createAppAdvisorToolSurfaces(): AppAdvisorToolRuntimeSurfaces {
  return {
    getMainWindow: noWindow,
    getAppAdvisorWindow: noWindow,
    openAppAdvisorWindow: () =>
      Promise.resolve({ open: false, focused: false }),
    ensureAppAdvisorWindow: () =>
      Promise.resolve({ open: false, focused: false }),
  };
}

function createChatIpcWindowAccessors(): WindowAccessors {
  const state = (): AppAdvisorWindowState => ({ open: false, focused: false });
  return {
    getMainWindow: noWindow,
    getAppAdvisorWindow: noWindow,
    openAppAdvisorWindow: () => Promise.resolve(state()),
    ensureAppAdvisorWindow: () => Promise.resolve(state()),
    closeAppAdvisorWindow: () => Promise.resolve(state()),
    toggleAppAdvisorWindow: () => Promise.resolve(state()),
    getAppAdvisorWindowState: state,
    markAppAdvisorWindowRendererReady: state,
    setAppAdvisorFloatingSize: state,
    sendAppAdvisorWindowCommand: () => undefined,
    sendChatWindowCommand: () => false,
    notifyStartupUnlocked: () => undefined,
  };
}

type RegisteredIpcHandler = Parameters<typeof ipcMain.handle>[1];

async function createDesktopChatSendInvoker(): Promise<
  (request: ChatSendMessageRequest) => Promise<void>
> {
  const { registerChatHandlers } = await import('../../ipc/chat');
  const handlers = new Map<string, RegisteredIpcHandler>();
  const handleSpy = jest
    .spyOn(ipcMain, 'handle')
    .mockImplementation((channel, handler) => {
      handlers.set(channel, handler);
    });
  try {
    // Register the production chat IPC handler; only the Electron transport
    // registration is captured so this headless harness can invoke the exact
    // handler the renderer calls.
    registerChatHandlers(createChatIpcWindowAccessors());
  } finally {
    handleSpy.mockRestore();
  }

  const handler = handlers.get(IPC_CHANNELS.chatSendMessage);
  if (!handler)
    throw new Error('The desktop chat-send IPC handler was not registered');
  const event = {
    sender: new BrowserWindow().webContents,
  } as IpcMainInvokeEvent;
  return async (request): Promise<void> => {
    await handler(event, request);
  };
}

function installSpecialNativeDispatcher(
  toolSurfaces: AppAdvisorToolRuntimeSurfaces,
): void {
  setSpecialNativeChatDispatcher(
    async (request: ChatSendMessageRequest, authorization): Promise<void> => {
      if (request.projectId === APP_ADVISOR_PROJECT_ID) {
        // As production's dispatcher does, the queue's capability travels on.
        await dispatchAppAdvisorChatMessage(request, {
          getMainWindow: noWindow,
          getAppAdvisorWindow: noWindow,
          toolSurfaces,
          ...(authorization ? { authorization } : {}),
        });
        return;
      }
      if (workspaceRegistry.isCoworkWorkspace(request.projectId)) {
        // Native IPC uses its private desktop-origin dispatch closure. This
        // adapter instead routes an already-claimed row through the production
        // queue compatibility path: the work-entry send adapter would create
        // a second row, while portal origin avoids this desktop-only branch.
        // Ordinary Cowork sends still enter through sendStandaloneChatMessage.
        await dispatchHostQueuedWorktreeChatMessage(
          request,
          'portal',
          true,
          authorization,
        );
        return;
      }
      throw new Error(
        `No special-native pipeline host for ${request.projectId}`,
      );
    },
    toolSurfaces,
  );
}

async function sendThroughHost(
  kind: PipelineHost,
  provider: PipelineProvider,
  target: PipelineChatTarget,
  settings: PipelineSettingsPatch,
  input: PipelineSendInput,
  hostOptions: PipelineHostOptions,
  sendDesktopIpc?: (request: ChatSendMessageRequest) => Promise<void>,
): Promise<{ userMessageId: string }> {
  const model = settings.model ?? modelForProvider(provider);
  const planMode = settings.planMode ?? false;
  const userMessageId = input.userMessageId ?? randomUUID();

  if (kind === 'worktree') {
    const persistedOptions = input.resume
      ? await buildExistingTabDispatchOptions(
          target.projectId,
          target.worktreeId,
          target.chatId,
        )
      : {};
    const request: ChatSendMessageRequest = {
      ...persistedOptions,
      ...target,
      userMessageId,
      text: input.text,
      model,
      providerType: provider,
      executionHarness: provider,
      planMode,
      initiationSource: 'user',
    };
    await sendWorktreeChatMessage(request, { getWindow: noWindow });
    return { userMessageId };
  }

  if (kind === 'cowork') {
    if (hostOptions.coworkDispatch === 'desktop-ipc') {
      if (!sendDesktopIpc)
        throw new Error('The desktop Cowork IPC dispatcher was not installed');
      const request: ChatSendMessageRequest = {
        ...target,
        userMessageId,
        text: input.text,
        model,
        providerType: provider,
        executionHarness: provider,
        planMode,
        initiationSource: 'user',
      };
      await sendDesktopIpc(request);
      return { userMessageId };
    }
    const result = await sendStandaloneChatMessage(
      {
        projectLocalId: target.projectId,
        workEntryId: target.worktreeId,
        chatId: target.chatId,
        message: input.text,
        model,
        providerType: provider,
        executionHarness: provider,
        planMode,
      },
      { getWindow: noWindow },
    );
    return { userMessageId: result.userMessageId };
  }

  const request: ChatSendMessageRequest = {
    ...target,
    userMessageId,
    text: input.text,
    model,
    providerType: provider,
    executionHarness: provider,
    planMode,
    assistantMode: 'app-advisor',
    initiationSource: 'user',
  };
  // The production entry: queue admission, then the special-native dispatcher.
  await sendWorktreeChatMessage(request, {
    getWindow: noWindow,
    appAdvisorSurfaces: createAppAdvisorToolSurfaces(),
  });
  return { userMessageId };
}

async function deliverGenerated(
  kind: PipelineHost,
  provider: PipelineProvider,
  target: PipelineChatTarget,
  queue: ChatQueueService,
  input: PipelineGeneratedInput,
): Promise<void> {
  if (input.kind === 'watcher') {
    await deliverWatcherMessageToChat({
      ...target,
      watcherId: input.watcherId ?? input.deliveryId,
      deliveryId: input.deliveryId,
      text: input.text,
      // Fired watchers always carry their kind; it marks the row generated.
      watcherFired: { kind: 'scheduled_wakeup' },
      ...(input.hiddenContextText !== undefined
        ? { hiddenContextText: input.hiddenContextText }
        : {}),
    });
    return;
  }

  const model = modelForProvider(provider);
  registerDelegationDelivery(target, input.deliveryId);
  const request: ChatSendMessageRequest = {
    ...target,
    userMessageId: input.deliveryId,
    text: input.hiddenContextText ?? input.text,
    model,
    providerType: provider,
    executionHarness: provider,
    initiationSource: 'automation',
    managedDelegationDeliveryId: input.deliveryId,
    internalRow: {
      kind: 'delegation-request',
      delegationId: input.deliveryId,
      displayLine:
        input.text.split(/\r?\n/, 1)[0]?.trim() ||
        'A delegated agent needs a response.',
    },
    ...(kind === 'app-advisor' ? { assistantMode: 'app-advisor' } : {}),
  };
  try {
    await queue.submit(request, 'desktop');
  } catch (error) {
    const key = deliveryKey(target, input.deliveryId);
    const delivery = delegationDeliveries.get(key);
    if (delivery) delivery.active = false;
    delegationDeliveries.delete(key);
    throw error;
  }
}

export async function createPipelineHostAdapter({
  kind,
  provider,
  target,
  hostOptions = {},
  service,
  queue,
  root,
  drain,
}: PipelineHostAdapterOptions): Promise<PipelineHostAdapter> {
  registerHostScope(kind, target, root);
  installPipelineDelegationLifecycle();
  const toolSurfaces = createAppAdvisorToolSurfaces();
  installSpecialNativeDispatcher(toolSurfaces);

  if (hostOptions.createInitialChat !== false)
    await service.ensureChatForTrustedSend({
      ...target,
      userMessageId: randomUUID(),
      text: '',
      model: modelForProvider(provider),
      providerType: provider,
      executionHarness: provider,
    });

  let settings: PipelineSettingsPatch = { model: modelForProvider(provider) };
  const sendDesktopIpc =
    kind === 'cowork' && hostOptions.coworkDispatch === 'desktop-ipc'
      ? await createDesktopChatSendInvoker()
      : undefined;

  return {
    host: kind,
    provider,
    target,
    send: (input) =>
      sendThroughHost(
        kind,
        provider,
        target,
        settings,
        input,
        hostOptions,
        sendDesktopIpc,
      ),
    deliverGenerated: (input) =>
      deliverGenerated(kind, provider, target, queue, input),
    async changeSettings(patch): Promise<void> {
      const settingsPatch = {
        ...(patch.model !== undefined ? { model: patch.model } : {}),
        ...(patch.planMode !== undefined ? { planMode: patch.planMode } : {}),
      };
      if (Object.keys(settingsPatch).length === 0) return;
      await service.command({
        schemaVersion: 1,
        commandId: randomUUID(),
        ...target,
        command: {
          type: 'chat.patch_tab_settings',
          tabId: target.chatId,
          patch: settingsPatch,
        },
      });
      settings = { ...settings, ...patch };
    },
    async stop(): Promise<void> {
      await stopChatTurn(target);
    },
    async drain(): Promise<void> {
      await drainCurrentSessionEvents(target);
      await drain();
    },
  };
}

/** Clean host-scoped leaf fixtures when the harness is disposed. */
export function resetPipelineHostAdapterFixtures(): Promise<void> {
  delegationDeliveries.clear();
  workspaceTypes.clear();
  rootsByProject.clear();
  rootsByScope.clear();
  workEntries.clear();
  return Promise.resolve();
}
