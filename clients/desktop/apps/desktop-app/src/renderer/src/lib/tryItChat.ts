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
import { pluginSelectionsEqual } from '@canopy/desktop-shared/lib/effective-plugin-selections';
import { draftHasContent } from '@/lib/chat-draft-content';
import {
  INSERT_CHAT_TEXT_EVENT,
  type InsertChatTextDetail,
} from '@/lib/editorSelectionContext';
import { useNavigationStore } from '@/stores/navigationStore';
import { useChatStore, navigateToWorktreeChat } from '@/stores/chatStore';
import {
  isEditableChatTab,
  resolveTabProviderType,
} from '@/stores/chat/tab-utils';
import type { ChatTab } from '@/stores/chat/types';
import {
  useStandaloneChatStore,
  currentDefaultCoworkWorkspaceId,
} from '@/stores/standaloneChatStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { getSidebarScopingContext } from '@/components/sidebar/useSidebarScopingContext';
import { selectionBelongsToContext } from './standaloneChatSelection';
import { pendingTabCreation } from '@/stores/chat/pending-tab-creation';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import type { TryItHarnessSupport } from './tryItRuntime';
import { readTryItDraft, saveTryItDraft } from './tryItDraftStorage';
import { queueDesktopTryItSelectionUpdate } from './tryItContinuationRunner';
import {
  appendTryItStarter,
  chooseTryItStageTarget,
  mergeTryItSelections,
  tryItProviderSupported,
} from './tryItStage';

/**
 * Detail-page Try it (CAN-4359, CAN-5218): stages the capability's starter
 * prompt as an editable, unsent draft with the capability selected. The
 * selected worktree's editable chat receives it; otherwise a new chat in that
 * worktree, or a new standalone chat when no worktree is selected. Only an
 * explicit Send starts a turn.
 *
 * Each account-scoped capability key owns one launch record, written before
 * any asynchronous step. A repeated Try it into the same chat while its
 * staged draft remains reopens it instead of appending another starter.
 */

export interface TryItChatLocation {
  projectId: string;
  worktreeId: string;
}

/**
 * A CAN-4359 record, whose launch sent the example. Read only so the sign-in
 * notice keeps working for its chat; never resumed and never proof that a
 * draft was staged.
 */
export interface LegacyDesktopTryItLaunch extends TryItLaunch {
  destination: 'standalone';
  location?: TryItChatLocation;
}

/** A draft-staging launch (CAN-5218). */
export interface StagedDesktopTryItLaunch {
  version: 2;
  operation: 'stage-draft';
  contextKey?: string;
  accountId: string;
  requestId: string;
  /** Draft insertion identity retained when sign-in moves the launch. */
  stagingId?: string;
  capability: TryItCapability;
  chatId: string;
  prompt: string;
  /** `standalone` only for the no-worktree fallback chat. */
  destination: 'worktree' | 'standalone';
  /** `staged` once the selections and the draft were accepted. */
  status: 'staging' | 'staged';
  /** Set once the destination chat exists. */
  location?: TryItChatLocation;
}

export type DesktopTryItLaunch =
  | LegacyDesktopTryItLaunch
  | StagedDesktopTryItLaunch;

export interface TryItChatRequest {
  /** Selected account/organization context captured at activation. */
  contextKey?: string;
  /** From `useTryItAccount`; `guest` for guest and signed-out viewers. */
  accountId: string;
  capability: TryItCapability;
  prompt: string;
  /**
   * The installed runtime reference, when one exists. A capability without
   * one is carried as an unresolved catalog identity so a later install or
   * authorization resolves it in the same chat.
   */
  runtimeSelections?: Omit<ChatTabPluginSelections, 'collectionIds'>;
  /**
   * A supported harness's default model, when the viewer's default cannot
   * run the capability; see `resolveTryItRuntime`. Absent keeps the default.
   */
  model?: ProviderModelSelection;
  /** Which harnesses run the capability; an existing chat must be on one. */
  harnessSupport?: TryItHarnessSupport;
  /** Rechecks the launching account after each asynchronous step. */
  isCurrent?: () => boolean;
}

/** `reopened`: the same chat still holds this capability's staged draft. */
export type TryItStageResult = 'staged' | 'reopened' | 'joined';

/** The account, worktree, or chat changed while Try it was launching. */
export class TryItStageCancelledError extends Error {
  constructor() {
    super('Try it was cancelled because the destination changed');
    this.name = 'TryItStageCancelledError';
  }
}

export interface TryItChatStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem?: (key: string) => void;
}

export type TryItStageDestination =
  | { kind: 'existing'; location: TryItChatLocation; chatId: string }
  | { kind: 'new-tab'; location: TryItChatLocation }
  | { kind: 'standalone' };

export interface TryItChatDeps {
  storage: TryItChatStorage | null;
  newId: () => string;
  /** The current destination, from the live selection; see `chooseTryItStageTarget`. */
  resolveTarget: (request: TryItChatRequest) => Promise<TryItStageDestination>;
  /** Creates an empty chat with `chatId`; never sends. */
  createChat: (params: {
    target: Exclude<TryItStageDestination, { kind: 'existing' }>;
    chatId: string;
    pluginSelections: ChatTabPluginSelections;
    model?: ProviderModelSelection;
    onChatCreated: (location: TryItChatLocation) => void;
  }) => Promise<TryItChatLocation>;
  /**
   * Opens a prior fallback chat. `missing` means its project or work entry
   * was confirmed gone after a fresh read, never merely unloaded.
   */
  openChat: (
    location: TryItChatLocation,
    chatId: string,
  ) => Promise<'opened' | 'missing'>;
  /** Whether the chat's composer, live or saved, holds any draft. */
  hasDraft: (chatId: string) => boolean;
  /** Merges the selections, appends the starter once, then shows and focuses the chat. */
  stageDraft: (params: {
    stagingId: string;
    location: TryItChatLocation;
    chatId: string;
    prompt: string;
    pluginSelections: ChatTabPluginSelections;
    isCurrent: () => boolean;
    /** Reapply selections without changing the user's already-staged draft. */
    preserveDraft?: boolean;
    /** The destination was resolved from a no-worktree fallback activation. */
    allowUnselected?: boolean;
  }) => Promise<void>;
  isStageAccepted?: (chatId: string, stagingId: string) => boolean;
  isCompatible?: (
    location: TryItChatLocation,
    chatId: string,
    request: TryItChatRequest,
  ) => boolean;
  /** Shows and focuses an existing chat. */
  showChat: (
    location: TryItChatLocation,
    chatId: string,
    isCurrent?: () => boolean,
  ) => Promise<void>;
}

const STORAGE_PREFIX = 'canopy:try-it-launch:';
const LAUNCH_CHANGED_EVENT = 'canopy:try-it-launch-changed';

/** Observe accepted launch writes here and in other renderer windows. */
export function subscribeTryItChatLaunch(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const onStorage = (event: StorageEvent): void => {
    if (event.key === null || event.key.startsWith(STORAGE_PREFIX)) listener();
  };
  window.addEventListener(LAUNCH_CHANGED_EVENT, listener);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(LAUNCH_CHANGED_EVENT, listener);
    window.removeEventListener('storage', onStorage);
  };
}

function notifyLaunchChanged(): void {
  if (typeof window !== 'undefined')
    window.dispatchEvent(new Event(LAUNCH_CHANGED_EVENT));
}

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

function sameLocation(
  a: TryItChatLocation | undefined,
  b: TryItChatLocation,
): boolean {
  return a?.projectId === b.projectId && a.worktreeId === b.worktreeId;
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
    value.accountId !== accountId ||
    typeof requestId !== 'string' ||
    typeof chatId !== 'string' ||
    typeof prompt !== 'string' ||
    !isTryItCapability(stored) ||
    buildTryItCapabilityKey(accountId, stored) !==
      buildTryItCapabilityKey(accountId, capability)
  ) {
    return null;
  }
  const location = parseLocation(value.location);
  if (value.version === 2) {
    const { destination } = value;
    if (
      value.operation !== 'stage-draft' ||
      (destination !== 'worktree' && destination !== 'standalone') ||
      (status !== 'staging' && status !== 'staged')
    )
      return null;
    return {
      version: 2,
      operation: 'stage-draft',
      ...(typeof value.contextKey === 'string'
        ? { contextKey: value.contextKey }
        : {}),
      accountId,
      requestId,
      ...(typeof value.stagingId === 'string'
        ? { stagingId: value.stagingId }
        : {}),
      capability: stored,
      chatId,
      prompt,
      destination,
      status,
      ...(location ? { location } : {}),
    };
  }
  if (
    value.version !== 1 ||
    value.destination !== 'standalone' ||
    (status !== 'pending' && status !== 'completed')
  )
    return null;
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
  start: (request: TryItChatRequest) => Promise<TryItStageResult>;
  readLaunch: (
    accountId: string,
    capability: TryItCapability,
    contextKey?: string,
  ) => DesktopTryItLaunch | null;
  rebindLaunch: (input: {
    contextKey?: string;
    fromAccountId: string;
    toAccountId: string;
    capability: TryItCapability;
    chatId: string;
  }) => TryItRebindResult;
} {
  const inFlight = new Map<string, Promise<TryItStageResult>>();

  const storageKey = (
    accountId: string,
    capability: TryItCapability,
    contextKey?: string,
  ): string =>
    `${STORAGE_PREFIX}${buildTryItCapabilityKey(accountId, capability)}${contextKey === undefined ? '' : `:context:${contextKey}`}`;

  const readLaunch = (
    accountId: string,
    capability: TryItCapability,
    contextKey?: string,
  ): DesktopTryItLaunch | null => {
    return parseLaunch(
      deps.storage?.getItem(storageKey(accountId, capability, contextKey)) ??
        deps.storage?.getItem(storageKey(accountId, capability)) ??
        null,
      accountId,
      capability,
    );
  };

  const writeLaunch = (launch: DesktopTryItLaunch): void => {
    if (!deps.storage)
      throw new Error('Recoverable chat storage is unavailable');
    deps.storage.setItem(
      storageKey(
        launch.accountId,
        launch.capability,
        launch.version === 2 ? launch.contextKey : undefined,
      ),
      JSON.stringify(launch),
    );
    notifyLaunchChanged();
  };

  const run = async (request: TryItChatRequest): Promise<TryItStageResult> => {
    const isCurrent = (): boolean => request.isCurrent?.() ?? true;
    const guard = (): void => {
      if (!isCurrent()) throw new TryItStageCancelledError();
    };
    if (!deps.storage)
      throw new Error('Recoverable chat storage is unavailable');
    const stored = readLaunch(
      request.accountId,
      request.capability,
      request.contextKey,
    );
    const rawLaunch = deps.storage.getItem(
      storageKey(request.accountId, request.capability, request.contextKey),
    );
    const stagingKey = JSON.stringify([
      request.contextKey ?? null,
      buildTryItCapabilityKey(request.accountId, request.capability),
    ]);
    // A legacy record sent its example; it never licenses reuse or a send.
    const prior =
      stored?.version === 2 && stored.contextKey === request.contextKey
        ? stored
        : null;

    // The current destination wins over any prior launch.
    let target = await deps.resolveTarget(request);
    guard();
    const allowUnselected = target.kind === 'standalone';
    if (
      target.kind === 'new-tab' &&
      prior?.status === 'staging' &&
      prior.location &&
      sameLocation(prior.location, target.location)
    ) {
      const opened = await deps.openChat(prior.location, prior.chatId);
      guard();
      if (
        opened === 'opened' &&
        (deps.isCompatible?.(prior.location, prior.chatId, request) ?? true)
      )
        target = {
          kind: 'existing',
          location: prior.location,
          chatId: prior.chatId,
        };
    }
    if (
      target.kind === 'standalone' &&
      prior?.destination === 'standalone' &&
      prior.location
    ) {
      // Reuse this context's earlier fallback chat rather than another one.
      const opened = await deps.openChat(prior.location, prior.chatId);
      guard();
      if (
        opened === 'opened' &&
        (deps.isCompatible?.(prior.location, prior.chatId, request) ?? true)
      )
        target = {
          kind: 'existing',
          location: prior.location,
          chatId: prior.chatId,
        };
    }
    if (
      target.kind === 'existing' &&
      deps.isStageAccepted?.(
        target.chatId,
        prior?.chatId === target.chatId &&
          sameLocation(prior.location, target.location)
          ? (prior.stagingId ?? stagingKey)
          : stagingKey,
      ) &&
      deps.hasDraft(target.chatId)
    ) {
      // Explicit Try it selects the capability again, keeping any draft edits.
      await deps.stageDraft({
        stagingId: stagingKey,
        location: target.location,
        chatId: target.chatId,
        prompt: request.prompt,
        pluginSelections: tryItChatPluginSelections(request),
        isCurrent,
        preserveDraft: true,
        allowUnselected,
      });
      guard();
      if (
        prior?.status === 'staging' &&
        prior.chatId === target.chatId &&
        sameLocation(prior.location, target.location)
      ) {
        writeLaunch({ ...prior, status: 'staged' });
      }
      return 'reopened';
    }
    if (rawLaunch && stored === null)
      throw new Error('Recoverable chat storage is malformed');

    const pluginSelections = tryItChatPluginSelections(request);
    const resume =
      prior?.status === 'staging' &&
      ((target.kind === 'standalone' && prior.destination === 'standalone') ||
        (target.kind !== 'standalone' &&
          sameLocation(prior.location, target.location) &&
          (target.kind !== 'existing' || target.chatId === prior.chatId)));
    let launch: StagedDesktopTryItLaunch = {
      version: 2,
      operation: 'stage-draft',
      ...(request.contextKey !== undefined
        ? { contextKey: request.contextKey }
        : {}),
      accountId: request.accountId,
      requestId: resume ? prior.requestId : deps.newId(),
      stagingId: stagingKey,
      capability: request.capability,
      chatId:
        target.kind === 'existing'
          ? target.chatId
          : resume
            ? prior.chatId
            : deps.newId(),
      prompt: request.prompt,
      destination: allowUnselected ? 'standalone' : 'worktree',
      status: 'staging',
      ...(target.kind === 'standalone' ? {} : { location: target.location }),
    };
    writeLaunch(launch);
    let location: TryItChatLocation;
    if (target.kind === 'existing') {
      location = target.location;
    } else {
      location = await deps.createChat({
        target,
        chatId: launch.chatId,
        pluginSelections,
        ...(request.model ? { model: request.model } : {}),
        onChatCreated: (created) => {
          launch = { ...launch, location: created };
          writeLaunch(launch);
        },
      });
      launch = { ...launch, location };
    }
    guard();
    await deps.stageDraft({
      stagingId: stagingKey,
      location,
      chatId: launch.chatId,
      prompt: request.prompt,
      pluginSelections,
      isCurrent,
      allowUnselected,
    });
    guard();
    writeLaunch({ ...launch, location, status: 'staged' });
    return 'staged';
  };

  /**
   * Moves the launch for `chatId` to the account that signed in, so that
   * account's Try it finds the same chat. The destination is verified
   * before the source is removed; an existing destination record is never
   * overwritten. A conflict leaves both records and the chat untouched.
   */
  const rebindLaunch = (input: {
    contextKey?: string;
    fromAccountId: string;
    toAccountId: string;
    capability: TryItCapability;
    chatId: string;
  }): TryItRebindResult => {
    let source: DesktopTryItLaunch | null;
    let existing: DesktopTryItLaunch | null;
    try {
      source = readLaunch(
        input.fromAccountId,
        input.capability,
        input.contextKey,
      );
      existing = readLaunch(
        input.toAccountId,
        input.capability,
        input.contextKey,
      );
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
      ...(source.version === 2
        ? {
            stagingId:
              source.stagingId ??
              JSON.stringify([
                source.contextKey ?? null,
                buildTryItCapabilityKey(source.accountId, source.capability),
              ]),
          }
        : {}),
    };
    try {
      if (!existing) writeLaunch(moved);
      if (
        readLaunch(input.toAccountId, input.capability, input.contextKey)
          ?.requestId !== source.requestId
      )
        return 'failed';
    } catch {
      return 'failed';
    }
    if (input.fromAccountId === input.toAccountId) return 'rebound';
    try {
      deps.storage?.removeItem?.(
        storageKey(
          input.fromAccountId,
          input.capability,
          source.version === 2 ? source.contextKey : undefined,
        ),
      );
      notifyLaunchChanged();
    } catch {
      // A leftover guest record only reopens the same chat for a guest.
    }
    return 'rebound';
  };

  return {
    readLaunch,
    rebindLaunch,
    start: (request: TryItChatRequest): Promise<TryItStageResult> => {
      const key =
        buildTryItCapabilityKey(request.accountId, request.capability) +
        JSON.stringify(request.contextKey ?? null);
      const existing = inFlight.get(key);
      if (existing) return existing.then(() => 'joined');
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
  const project = useProjectsStore
    .getState()
    .projects.find((entry) => entry.id === location.projectId);
  if (
    project &&
    !selectionBelongsToContext(location, [project], getSidebarScopingContext())
  )
    return 'missing';
  if (project && project.type !== 'cowork') {
    if (
      !selectionBelongsToContext(
        location,
        [project],
        getSidebarScopingContext(),
      ) ||
      !project.worktrees.some((entry) => entry.id === location.worktreeId)
    )
      return 'missing';
    await useChatStore
      .getState()
      .loadTabsForTarget(location.projectId, location.worktreeId);
    return isEditableChatTab(findTab(location, chatId)) ? 'opened' : 'missing';
  }
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
  const entries = await window.api.workEntries.list({
    projectId: location.projectId,
  });
  if (!entries.entries.some((entry) => entry.id === location.worktreeId)) {
    return 'missing';
  }
  await useChatStore
    .getState()
    .loadTabsForTarget(location.projectId, location.worktreeId);
  const scopeKey = `${location.projectId}/${location.worktreeId}`;
  if (
    !useChatStore
      .getState()
      .worktreeChats[scopeKey]?.tabs.some((tab) => tab.id === chatId)
  ) {
    return 'missing';
  }
  return isEditableChatTab(findTab(location, chatId)) ? 'opened' : 'missing';
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

function findTab(
  location: TryItChatLocation,
  chatId: string,
): ChatTab | undefined {
  return useChatStore
    .getState()
    .worktreeChats[
      `${location.projectId}/${location.worktreeId}`
    ]?.tabs.find((tab) => tab.id === chatId);
}

async function resolveDesktopTarget(
  request: TryItChatRequest,
): Promise<TryItStageDestination> {
  const worktree = useChatStore.getState().selectedWorktree;
  if (!worktree) return { kind: 'standalone' };
  const location = {
    projectId: worktree.projectId,
    worktreeId: worktree.worktreeId,
  };
  const projects = useProjectsStore.getState().projects;
  const activeAtStart =
    useChatStore.getState().worktreeChats[
      `${location.projectId}/${location.worktreeId}`
    ]?.activeTabId;
  const project = projects.find((entry) => entry.id === location.projectId);
  if (
    !selectionBelongsToContext(location, projects, getSidebarScopingContext())
  ) {
    const standalone = useStandaloneChatStore
      .getState()
      .chatProjects.find((entry) => entry.id === location.projectId);
    if (!standalone || location.projectId !== currentDefaultCoworkWorkspaceId())
      throw new Error(
        'The selected worktree is not accessible in this context',
      );
  }
  if (
    project &&
    project.type !== 'cowork' &&
    !project.worktrees.some((entry) => entry.id === location.worktreeId)
  )
    throw new Error('The selected worktree is no longer available');
  // Decide only once the worktree's tabs are loaded.
  await useChatStore
    .getState()
    .loadTabsForTarget(location.projectId, location.worktreeId);
  const state = useChatStore.getState();
  if (
    !state.selectedWorktree ||
    !sameLocation(state.selectedWorktree, location)
  )
    throw new TryItStageCancelledError();
  const chats =
    state.worktreeChats[`${location.projectId}/${location.worktreeId}`];
  if (activeAtStart !== undefined && chats?.activeTabId !== activeAtStart)
    throw new TryItStageCancelledError();
  // A failed load is not a reason to move the draft to another chat.
  if (!chats) throw new Error('The worktree chats did not load');
  const choice = chooseTryItStageTarget(
    {
      worktreeSelected: true,
      tabs: chats.tabs,
      activeTabId: chats.activeTabId,
      lastActiveEditableChatId: chats.lastActiveEditableChatId,
    },
    (tab) =>
      tryItProviderSupported(
        resolveTabProviderType(tab),
        request.harnessSupport,
      ),
  );
  return choice.kind === 'existing'
    ? { kind: 'existing', location, chatId: choice.tabId }
    : { kind: 'new-tab', location };
}

/**
 * Appends the starter to the chat's composer exactly once: the mounted
 * editor (visible or hidden) when one acknowledges it, else the saved draft
 * that composer loads when it mounts.
 */
function insertTryItStarter(
  chatId: string,
  prompt: string,
  stagingId: string,
): void {
  if (readTryItDraft(chatId)?.stagingIds.includes(stagingId)) return;
  let handled = false;
  let failure: { error: unknown } | undefined;
  const detail: InsertChatTextDetail = {
    text: prompt,
    targetTabId: chatId,
    stagingId,
    markHandled: (): void => {
      handled = true;
    },
    markFailed: (error: unknown): void => {
      failure = { error };
    },
  };
  document.dispatchEvent(new CustomEvent(INSERT_CHAT_TEXT_EVENT, { detail }));
  if (failure)
    throw failure.error instanceof Error
      ? failure.error
      : new Error('The draft could not be saved');
  if (handled) return;
  const chat = useChatStore.getState();
  const next = appendTryItStarter(chat.getTabDraft(chatId), prompt);
  saveTryItDraft(chatId, next, stagingId);
  chat.saveTabDraft(chatId, next);
}

/** Focus the visible composer after navigation has mounted it. */
async function requestComposerFocus(
  chatId: string,
  isCurrent: () => boolean,
): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (!isCurrent()) throw new TryItStageCancelledError();
    const focused = await new Promise<boolean>((resolve) => {
      requestAnimationFrame(() => {
        let handled = false;
        document.dispatchEvent(
          new CustomEvent('canopy:focus-chat-input', {
            detail: {
              targetTabId: chatId,
              markHandled: (): void => {
                handled = true;
              },
            },
          }),
        );
        resolve(handled);
      });
    });
    if (focused) return;
  }
  throw new Error('The chat composer did not become ready');
}

async function showDesktopChat(
  location: TryItChatLocation,
  chatId: string,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  const project = useProjectsStore
    .getState()
    .projects.find((entry) => entry.id === location.projectId);
  if (project && project.type !== 'cowork') {
    if (!isCurrent()) throw new TryItStageCancelledError();
    await navigateToWorktreeChat({ ...location, chatId }, isCurrent);
    await requestComposerFocus(chatId, isCurrent);
    return;
  }
  await useStandaloneChatStore.getState().initialize();
  if (!isCurrent()) throw new TryItStageCancelledError();
  const standalone = useStandaloneChatStore
    .getState()
    .chatProjects.some((project) => project.id === location.projectId);
  if (standalone) {
    const switched = await useStandaloneChatStore
      .getState()
      .switchChatProject(location.projectId, location.worktreeId);
    if (!switched) throw new TryItStageCancelledError();
    if (!isCurrent()) throw new TryItStageCancelledError();
    await useStandaloneChatStore
      .getState()
      .selectWorkEntry(location.worktreeId);
    useStandaloneChatStore.getState().dismissColdStart();
  }
  if (!isCurrent() || !isEditableChatTab(findTab(location, chatId)))
    throw new TryItStageCancelledError();
  useChatStore.getState().switchTab(chatId, location);
  useNavigationStore.getState().navigate(standalone ? 'chat' : 'main');
  await requestComposerFocus(chatId, isCurrent);
}

const launcher = createTryItChatLauncher({
  storage: browserStorage(),
  newId: () => crypto.randomUUID(),
  resolveTarget: resolveDesktopTarget,
  createChat: async ({
    target,
    chatId,
    pluginSelections,
    model,
    onChatCreated,
  }) => {
    if (target.kind === 'standalone') {
      const created: { location?: TryItChatLocation } = {};
      await useStandaloneChatStore.getState().createStandaloneChatWithMessage({
        chatId,
        message: '',
        onChatCreated: ({ projectId, worktreeId }) => {
          created.location = { projectId, worktreeId };
          onChatCreated(created.location);
        },
        config: { pluginSelections, ...tabModelConfig(model) },
      });
      if (!created.location) throw new Error('The chat was not created');
      return created.location;
    }
    useChatStore.getState().createTab({
      ...target.location,
      id: chatId,
      pluginSelections,
      ...tabModelConfig(model),
    });
    if (!findTab(target.location, chatId))
      throw new Error('The chat was not created');
    onChatCreated(target.location);
    return target.location;
  },
  openChat: openStandaloneChat,
  isCompatible: (location, chatId, request) => {
    const tab = findTab(location, chatId);
    return (
      isEditableChatTab(tab) &&
      tryItProviderSupported(
        resolveTabProviderType(tab),
        request.harnessSupport,
      )
    );
  },
  isStageAccepted: (chatId, stagingId) =>
    readTryItDraft(chatId)?.stagingIds.includes(stagingId) === true,
  hasDraft: (chatId) => {
    const state = useChatStore.getState();
    const saved = state.getTabDraft(chatId);
    return (
      state.composerTextPresent[chatId] === true ||
      (saved !== undefined && draftHasContent(saved))
    );
  },
  stageDraft: async ({
    stagingId,
    location,
    chatId,
    prompt,
    pluginSelections,
    isCurrent,
    preserveDraft,
    allowUnselected,
  }) => {
    const selectionAtStart = useChatStore.getState().selectedWorktree;
    if (
      !sameLocation(selectionAtStart ?? undefined, location) &&
      (!allowUnselected || selectionAtStart !== null)
    )
      throw new TryItStageCancelledError();
    const activeAtStart =
      useChatStore.getState().worktreeChats[
        `${location.projectId}/${location.worktreeId}`
      ]?.activeTabId;
    const creation = await pendingTabCreation(
      location.projectId,
      location.worktreeId,
      chatId,
    );
    if (creation !== undefined && creation !== 'accepted')
      throw new Error('The chat could not be created');
    let navigating = false;
    const destinationCurrent = (): boolean => {
      const state = useChatStore.getState();
      const active =
        state.worktreeChats[`${location.projectId}/${location.worktreeId}`]
          ?.activeTabId;
      return (
        isCurrent() &&
        ((state.selectedWorktree?.projectId === selectionAtStart?.projectId &&
          state.selectedWorktree?.worktreeId ===
            selectionAtStart?.worktreeId) ||
          (navigating &&
            sameLocation(state.selectedWorktree ?? undefined, location))) &&
        (active === activeAtStart || (navigating && active === chatId))
      );
    };
    if (!destinationCurrent()) throw new TryItStageCancelledError();
    await queueDesktopTryItSelectionUpdate(
      { ...location, chatId },
      async () => {
        if (!destinationCurrent()) throw new TryItStageCancelledError();
        const tab = findTab(location, chatId);
        if (!isEditableChatTab(tab))
          throw new Error('The chat can no longer be edited');
        const merged = mergeTryItSelections(
          tab.pluginSelections,
          pluginSelections,
        );
        if (!pluginSelectionsEqual(merged, tab.pluginSelections)) {
          const response = await window.api.chat.updatePlugins({
            ...location,
            chatId,
            pluginSelections: merged,
          });
          if (
            !destinationCurrent() ||
            !isEditableChatTab(findTab(location, chatId))
          )
            throw new TryItStageCancelledError();
          useChatStore
            .getState()
            .setPluginSelections(
              response.pluginSelections,
              { ...location, chatId },
              response.deferredToolsAllowed,
              {
                runtimeAlreadyUpdated: true,
                ...(response.sdkSessionId
                  ? { sdkSessionId: response.sdkSessionId }
                  : {}),
              },
            );
        }
      },
    );
    if (!destinationCurrent()) throw new TryItStageCancelledError();
    if (!preserveDraft) insertTryItStarter(chatId, prompt, stagingId);
    navigating = true;
    await showDesktopChat(location, chatId, destinationCurrent);
  },
  showChat: showDesktopChat,
});

/**
 * Stages, joins, or reopens the Try it draft for one account-scoped
 * capability. Rejects without changing any draft when no writable chat is
 * available; `TryItStageCancelledError` when the destination changed.
 */
export function startTryItChat(
  request: TryItChatRequest,
): Promise<TryItStageResult> {
  const contextKey = JSON.stringify(
    getSidebarScopingContext() ?? { kind: 'personal' },
  );
  const contextRevision = useWorkspaceContextStore.getState().state.revision;
  let accountInvalidated = false;
  const invalidate = (): void => {
    accountInvalidated = true;
  };
  window.addEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, invalidate);
  return launcher
    .start({
      ...request,
      contextKey,
      isCurrent: () =>
        !accountInvalidated &&
        useWorkspaceContextStore.getState().state.revision ===
          contextRevision &&
        JSON.stringify(getSidebarScopingContext() ?? { kind: 'personal' }) ===
          contextKey &&
        (request.isCurrent?.() ?? true),
    })
    .finally(() =>
      window.removeEventListener(
        CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT,
        invalidate,
      ),
    );
}

/** The launch record for one account-scoped capability, if any. */
export function readTryItChatLaunch(
  accountId: string,
  capability: TryItCapability,
): DesktopTryItLaunch | null {
  try {
    return launcher.readLaunch(
      accountId,
      capability,
      JSON.stringify(getSidebarScopingContext() ?? { kind: 'personal' }),
    );
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
  return launcher.rebindLaunch({
    ...input,
    contextKey: JSON.stringify(
      getSidebarScopingContext() ?? { kind: 'personal' },
    ),
  });
}
