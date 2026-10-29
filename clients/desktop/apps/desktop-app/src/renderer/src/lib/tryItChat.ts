import {
  buildTryItCapabilityKey,
  isTryItCapability,
  type TryItCapability,
  type TryItLaunch,
} from '@canopy/protocol/try-it';
import type {
  ChatTabPluginSelections,
  ProviderModelSelection,
} from '@canopy/desktop-shared/types';
import { useNavigationStore } from '@/stores/navigationStore';
import { tryItContinuationCommandId } from './tryItSendReceipt';
import { useChatStore } from '@/stores/chatStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';

/**
 * Detail-page Try it (CAN-4359): opens one standalone Cowork chat with the
 * capability selected and its example prompt sent once.
 *
 * Each account-scoped capability key owns one launch record. The record is
 * written before any asynchronous step, carries a caller-minted chat id, and
 * records where the chat lives before the turn is sent, so a double click,
 * a remount, or a reload after an ambiguous response reopens the same chat
 * instead of creating another or resending.
 */

export interface TryItChatLocation {
  projectId: string;
  worktreeId: string;
}

export interface DesktopTryItLaunch extends TryItLaunch {
  destination: 'standalone';
  /** Set once the tab exists, before the turn is sent. */
  location?: TryItChatLocation;
}

export interface TryItChatRequest {
  /** From `useTryItAccount`; `guest` for guest and signed-out viewers. */
  accountId: string;
  capability: TryItCapability;
  prompt: string;
  /**
   * The installed runtime reference, when one exists. A capability without
   * one is carried as an unresolved catalog identity so a later install or
   * authorization continues in the same chat.
   */
  runtimeSelections?: Omit<ChatTabPluginSelections, 'collectionIds'>;
  /**
   * A supported harness's default model, when the viewer's default cannot
   * run the capability; see `resolveTryItRuntime`. Absent keeps the default.
   */
  model?: ProviderModelSelection;
}

export interface TryItChatStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem?: (key: string) => void;
}

export interface TryItContinueChatRequest {
  location: TryItChatLocation;
  chatId: string;
  requestId: string;
  message: string;
  pluginSelections: ChatTabPluginSelections;
  model?: ProviderModelSelection;
  /** Recheck the authenticated owner and tab after asynchronous preparation. */
  canContinue?: () => Promise<boolean>;
}

export interface TryItChatDeps {
  storage: TryItChatStorage | null;
  newId: () => string;
  /** Creates the chat with `chatId` and sends `message`; see the store seam. */
  createChat: (params: {
    chatId: string;
    requestId: string;
    message: string;
    pluginSelections: ChatTabPluginSelections;
    model?: ProviderModelSelection;
    onChatCreated: (location: TryItChatLocation) => void;
  }) => Promise<void>;
  /**
   * Opens an existing launch's chat. `missing` means its project or work
   * entry was confirmed gone after a fresh read, never merely unloaded.
   */
  openChat: (
    location: TryItChatLocation,
    chatId: string,
  ) => Promise<'opened' | 'missing'>;
  resumeChat: (
    params: TryItContinueChatRequest & { durableContinuation?: boolean },
  ) => Promise<void>;
}

const STORAGE_PREFIX = 'canopy:try-it-launch:';

export function tryItChatPluginSelections(
  request: Pick<TryItChatRequest, 'capability' | 'runtimeSelections'>,
): ChatTabPluginSelections {
  const runtime = request.runtimeSelections;
  const hasRuntime =
    (runtime?.skillRefs?.length ?? 0) > 0 ||
    (runtime?.pluginRefs?.length ?? 0) > 0 ||
    (runtime?.mcpServerRefs?.length ?? 0) > 0;
  return {
    collectionIds: [],
    skillRefs: runtime?.skillRefs ?? [],
    pluginRefs: runtime?.pluginRefs ?? [],
    ...(runtime?.mcpServerRefs?.length
      ? { mcpServerRefs: runtime.mcpServerRefs }
      : {}),
    ...(hasRuntime ? {} : { unresolvedCapabilities: [request.capability] }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseLocation(value: unknown): TryItChatLocation | undefined {
  if (!isRecord(value)) return undefined;
  const { projectId, worktreeId } = value;
  return typeof projectId === 'string' && typeof worktreeId === 'string'
    ? { projectId, worktreeId }
    : undefined;
}

function parseLaunch(
  raw: string | null,
  accountId: string,
  capability: TryItCapability,
): DesktopTryItLaunch | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const { requestId, chatId, prompt, status } = value;
  const stored = value.capability;
  if (
    value.version !== 1 ||
    value.accountId !== accountId ||
    value.destination !== 'standalone' ||
    typeof requestId !== 'string' ||
    typeof chatId !== 'string' ||
    typeof prompt !== 'string' ||
    (status !== 'pending' && status !== 'completed') ||
    !isTryItCapability(stored) ||
    buildTryItCapabilityKey(accountId, stored) !==
      buildTryItCapabilityKey(accountId, capability)
  ) {
    return null;
  }
  const location = parseLocation(value.location);
  return {
    version: 1,
    accountId,
    requestId,
    capability: stored,
    chatId,
    prompt,
    destination: 'standalone',
    status,
    ...(location ? { location } : {}),
  };
}

/** Outcome of moving a guest launch to the account that signed in. */
export type TryItRebindResult = 'rebound' | 'missing' | 'conflict' | 'failed';

export function createTryItChatLauncher(deps: TryItChatDeps): {
  start: (request: TryItChatRequest) => Promise<void>;
  readLaunch: (
    accountId: string,
    capability: TryItCapability,
  ) => DesktopTryItLaunch | null;
  rebindLaunch: (input: {
    fromAccountId: string;
    toAccountId: string;
    capability: TryItCapability;
    chatId: string;
  }) => TryItRebindResult;
  continueChat: (request: TryItContinueChatRequest) => Promise<void>;
} {
  const inFlight = new Map<string, Promise<void>>();

  const storageKey = (accountId: string, capability: TryItCapability): string =>
    `${STORAGE_PREFIX}${buildTryItCapabilityKey(accountId, capability)}`;

  const readLaunch = (
    accountId: string,
    capability: TryItCapability,
  ): DesktopTryItLaunch | null => {
    return parseLaunch(
      deps.storage?.getItem(storageKey(accountId, capability)) ?? null,
      accountId,
      capability,
    );
  };

  const writeLaunch = (launch: DesktopTryItLaunch): void => {
    if (!deps.storage)
      throw new Error('Recoverable chat storage is unavailable');
    deps.storage.setItem(
      storageKey(launch.accountId, launch.capability),
      JSON.stringify(launch),
    );
  };

  const freshLaunch = (request: TryItChatRequest): DesktopTryItLaunch => ({
    version: 1,
    accountId: request.accountId,
    requestId: deps.newId(),
    capability: request.capability,
    chatId: deps.newId(),
    prompt: request.prompt,
    destination: 'standalone',
    status: 'pending',
  });

  const run = async (request: TryItChatRequest): Promise<void> => {
    let launch =
      readLaunch(request.accountId, request.capability) ?? freshLaunch(request);

    if (launch.location) {
      // A recorded location means the tab exists and its turn was, or may
      // have been, sent. Reopen it; never resend into or beside it.
      const opened = await deps.openChat(launch.location, launch.chatId);
      if (opened === 'opened') {
        if (launch.status === 'pending') {
          await deps.resumeChat({
            location: launch.location,
            chatId: launch.chatId,
            requestId: launch.requestId,
            message: launch.prompt,
            pluginSelections: tryItChatPluginSelections(request),
            ...(request.model ? { model: request.model } : {}),
          });
          writeLaunch({ ...launch, status: 'completed' });
        }
        return;
      }
      // Confirmed deleted: start a new launch for the same capability.
      launch = freshLaunch(request);
    }

    writeLaunch(launch);
    const pending = launch;
    await deps.createChat({
      chatId: pending.chatId,
      requestId: pending.requestId,
      message: pending.prompt,
      pluginSelections: tryItChatPluginSelections(request),
      ...(request.model ? { model: request.model } : {}),
      onChatCreated: (location) => {
        writeLaunch({
          ...pending,
          location: {
            projectId: location.projectId,
            worktreeId: location.worktreeId,
          },
        });
      },
    });
    const created = readLaunch(request.accountId, request.capability);
    writeLaunch({ ...(created ?? pending), status: 'completed' });
  };

  /**
   * Moves the launch for `chatId` to the account that signed in, so that
   * account's Try it reopens the same chat. The destination is verified
   * before the source is removed; an existing destination record is never
   * overwritten. A conflict leaves both records and the chat untouched.
   */
  const rebindLaunch = (input: {
    fromAccountId: string;
    toAccountId: string;
    capability: TryItCapability;
    chatId: string;
  }): TryItRebindResult => {
    let source: DesktopTryItLaunch | null;
    let existing: DesktopTryItLaunch | null;
    try {
      source = readLaunch(input.fromAccountId, input.capability);
      existing = readLaunch(input.toAccountId, input.capability);
    } catch {
      return 'failed';
    }
    if (!source || source.chatId !== input.chatId) return 'missing';
    if (
      existing &&
      (existing.chatId !== input.chatId ||
        existing.requestId !== source.requestId)
    )
      return 'conflict';
    const moved: DesktopTryItLaunch = {
      ...source,
      accountId: input.toAccountId,
    };
    try {
      if (!existing) writeLaunch(moved);
      if (
        readLaunch(input.toAccountId, input.capability)?.requestId !==
        source.requestId
      )
        return 'failed';
    } catch {
      return 'failed';
    }
    if (input.fromAccountId === input.toAccountId) return 'rebound';
    try {
      deps.storage?.removeItem?.(
        storageKey(input.fromAccountId, input.capability),
      );
    } catch {
      // A leftover guest record only reopens the same chat for a guest.
    }
    return 'rebound';
  };

  return {
    readLaunch,
    rebindLaunch,
    continueChat: (request): Promise<void> => {
      const key = `continue:${request.location.projectId}/${request.location.worktreeId}/${request.chatId}/${request.requestId}`;
      const existing = inFlight.get(key);
      if (existing) return existing;
      const promise = deps
        .resumeChat({ ...request, durableContinuation: true })
        .finally(() => {
          inFlight.delete(key);
        });
      inFlight.set(key, promise);
      return promise;
    },
    start: (request: TryItChatRequest): Promise<void> => {
      const key = buildTryItCapabilityKey(
        request.accountId,
        request.capability,
      );
      const existing = inFlight.get(key);
      if (existing) return existing;
      const promise = run(request).finally(() => {
        inFlight.delete(key);
      });
      inFlight.set(key, promise);
      return promise;
    },
  };
}

async function openStandaloneChat(
  location: TryItChatLocation,
  chatId: string,
): Promise<'opened' | 'missing'> {
  const store = useStandaloneChatStore.getState();
  await store.initialize();
  await store.loadChatProjects();
  if (
    !useStandaloneChatStore
      .getState()
      .chatProjects.some((project) => project.id === location.projectId)
  ) {
    return 'missing';
  }
  const switched = await useStandaloneChatStore
    .getState()
    .switchChatProject(location.projectId, location.worktreeId);
  if (!switched) throw new Error('Opening the chat was superseded');
  await useStandaloneChatStore
    .getState()
    .refreshWorkEntries(location.projectId);
  if (
    !useStandaloneChatStore
      .getState()
      .workEntries.some((entry) => entry.id === location.worktreeId)
  ) {
    return 'missing';
  }
  await useStandaloneChatStore.getState().selectWorkEntry(location.worktreeId);
  await useChatStore
    .getState()
    .loadTabsForTarget(location.projectId, location.worktreeId);
  const scopeKey = `${location.projectId}/${location.worktreeId}`;
  if (
    !useChatStore
      .getState()
      .worktreeChats[scopeKey]?.tabs.some((tab) => tab.id === chatId)
  ) {
    const archives = await window.api.chat.loadArchives(location);
    if (!archives.some((chat) => chat.chatId === chatId)) return 'missing';
    await useChatStore
      .getState()
      .restoreArchivedChat(location.projectId, location.worktreeId, chatId);
    if (
      !useChatStore
        .getState()
        .worktreeChats[scopeKey]?.tabs.some((tab) => tab.id === chatId)
    ) {
      throw new Error('Restoring the chat did not reopen its tab');
    }
  }
  useChatStore.getState().switchTab(chatId, location);
  useNavigationStore.getState().navigate('chat');
  return 'opened';
}

function browserStorage(): TryItChatStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Tab fields that pin a Try it chat to its supported harness's model. */
function tabModelConfig(model: ProviderModelSelection | undefined): {
  model?: ProviderModelSelection['model'];
  thinkingLevel?: ProviderModelSelection['thinkingLevel'];
  modelExplicitlyChosen?: boolean;
} {
  // Explicit, so lane-aware default re-stamping cannot move the pristine
  // tab back onto a harness the capability does not support.
  return model
    ? {
        model: model.model,
        thinkingLevel: model.thinkingLevel,
        modelExplicitlyChosen: true,
      }
    : {};
}

const launcher = createTryItChatLauncher({
  storage: browserStorage(),
  newId: () => crypto.randomUUID(),
  createChat: async ({
    chatId,
    requestId,
    message,
    pluginSelections,
    model,
    onChatCreated,
  }) => {
    await useStandaloneChatStore.getState().createStandaloneChatWithMessage({
      chatId,
      initialMessageId: requestId,
      message,
      onChatCreated: ({ projectId, worktreeId }) =>
        onChatCreated({ projectId, worktreeId }),
      config: { pluginSelections, ...tabModelConfig(model) },
    });
    useNavigationStore.getState().navigate('chat');
  },
  openChat: openStandaloneChat,
  resumeChat: async ({
    location,
    chatId,
    requestId,
    message,
    pluginSelections,
    model,
    durableContinuation,
    canContinue,
  }) => {
    const store = useChatStore.getState();
    await store.loadTabsForTarget(location.projectId, location.worktreeId);
    const scope =
      useChatStore.getState().worktreeChats[
        `${location.projectId}/${location.worktreeId}`
      ];
    if (durableContinuation) {
      if (!scope?.tabs.some((tab) => tab.id === chatId))
        throw new Error('The saved chat is no longer available');
      if (canContinue && !(await canContinue()))
        throw new Error('The continuation account changed');
      // The canonical command owns durable acceptance and replay. Do not use
      // an optimistic renderer message as an acknowledgement.
      const result = await window.api.chat.command({
        schemaVersion: 1,
        ...location,
        commandId: tryItContinuationCommandId(requestId),
        command: {
          type: 'chat.send_message',
          chatId,
          userMessageId: requestId,
          text: message,
          ...(model
            ? {
                // The canonical tab owns the model. This send contract only
                // accepts the per-turn effort override in modelConfig.
                modelConfig: { thinkingLevel: model.thinkingLevel },
              }
            : {}),
        },
      });
      if (
        (result.outcome !== 'applied' &&
          result.outcome !== 'already_applied') ||
        result.entityId !== chatId ||
        result.messageId !== requestId
      )
        throw new Error('The continuation has not been acknowledged');
      return;
    }
    if (!scope?.tabs.some((tab) => tab.id === chatId)) {
      store.createTab({
        ...location,
        id: chatId,
        pluginSelections,
        ...tabModelConfig(model),
      });
      await store.ensureWorktreeHasChatTab(location);
    }
    useChatStore.getState().switchTab(chatId, location);
    let accepted = false;
    await useChatStore
      .getState()
      .sendMessage(message, undefined, { ...location, chatId }, undefined, {
        userMessageId: requestId,
        throwOnDispatchFailure: true,
        onDispatchAccepted: () => {
          accepted = true;
        },
      });
    if (!accepted)
      throw new Error('The initial message has not been acknowledged');
  },
});

/**
 * Starts, joins, or reopens the Try it launch for one account-scoped
 * capability. Rejects without navigating when the chat cannot be created;
 * the launch stays recoverable for a retry.
 */
export function startTryItChat(request: TryItChatRequest): Promise<void> {
  return launcher.start(request);
}

/** The launch record for one account-scoped capability, if any. */
export function readTryItChatLaunch(
  accountId: string,
  capability: TryItCapability,
): DesktopTryItLaunch | null {
  try {
    return launcher.readLaunch(accountId, capability);
  } catch {
    return null;
  }
}

/** Moves a guest launch to the account that signed in; see `rebindLaunch`. */
export function rebindTryItChatLaunch(input: {
  fromAccountId: string;
  toAccountId: string;
  capability: TryItCapability;
  chatId: string;
}): TryItRebindResult {
  return launcher.rebindLaunch(input);
}

export function continueTryItChat(
  request: TryItContinueChatRequest,
): Promise<void> {
  return launcher.continueChat(request);
}
