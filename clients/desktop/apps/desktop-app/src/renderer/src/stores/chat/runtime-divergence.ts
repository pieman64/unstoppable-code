import {
  isTerminalBackedInterfaceMode,
  type ChatRuntimeState,
} from '@canopy/desktop-shared/types';
import { getEffectiveClaudeChatInterfaceMode } from '@/lib/claude-tui-chats';
import { isReadOnlyAppAdvisorMirrorTarget } from './surface';
import {
  canonicalTurnStateFor,
  confirmCanonicalTurn,
} from './turn-confirmation';
import { chatScopeKey } from './revisioned-sync';
import { chatStoreApi } from './store-ref';
import type { ChatState } from './state';
import type { ChatTab } from './types';

export const RUNTIME_DIVERGENCE_GRACE_MS = 3_000;

export type StatusWriter =
  | 'keep-streaming'
  | 'deferred-tools-reload'
  | 'send'
  | 'terminal-send'
  | 'stale-session'
  | 'resume'
  | 'question-answer'
  | 'hook-start'
  | 'verify-streaming-tabs'
  | 'divergence-repair'
  | 'unknown';

export interface RuntimeDivergenceRecord {
  writer: StatusWriter;
  tabStatus: ChatTab['status'];
  runtimeStatus: ChatRuntimeState['status'];
  divergedMs: number;
}

export interface RuntimeDivergenceDeps {
  now: () => number;
  confirm: typeof confirmCanonicalTurn;
  /** Observes each repaired divergence; nothing records it by default. */
  record?: (event: RuntimeDivergenceRecord) => void;
}

interface PendingStatusWrite {
  writer: StatusWriter;
  taggedAt: number;
}

interface RuntimeOverride {
  state: 'active' | 'inactive';
  runtimeRef: ChatRuntimeState;
}

interface TrackedDivergence extends RuntimeDivergenceRecord {
  target: { projectId: string; worktreeId: string; chatId: string };
  since: number;
  lastActivityAt: number;
  runtimeRef: ChatRuntimeState;
  timer: ReturnType<typeof setTimeout> | undefined;
  attempts: number;
  retryAt: number | undefined;
  inFlight: boolean;
  activityVersion: number;
}

interface RegisteredScope {
  projectId: string;
  worktreeId: string;
  tabs: Map<string, ChatTab>;
}

interface EligibleChat {
  tab: ChatTab;
  runtime: ChatRuntimeState;
}

interface EvaluationChanges {
  localStatusChanged?: boolean;
  runtimeChanged?: boolean;
}

const STATUS_TAG_MAX_AGE_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;

let deps: RuntimeDivergenceDeps | undefined;
let activeUninstall: (() => void) | undefined;

const pendingStatusWrites = new Map<string, PendingStatusWrite>();
const trackedByKey = new Map<string, TrackedDivergence>();
const overridesByKey = new Map<string, RuntimeOverride>();
const registeredScopes = new Map<string, RegisteredScope>();
const scopeKeysByChatId = new Map<string, Set<string>>();

function divergenceKey(target: {
  projectId: string;
  worktreeId: string;
  chatId: string;
}): string {
  return `${target.projectId}/${target.worktreeId}/${target.chatId}`;
}

function now(): number {
  return deps?.now() ?? Date.now();
}

function clearTracking(key: string): void {
  const tracked = trackedByKey.get(key);
  if (tracked?.timer !== undefined) clearTimeout(tracked.timer);
  trackedByKey.delete(key);
}

function clearAllTimersAndState(): void {
  for (const tracked of Array.from(trackedByKey.values())) {
    if (tracked.timer !== undefined) clearTimeout(tracked.timer);
  }
  pendingStatusWrites.clear();
  trackedByKey.clear();
  overridesByKey.clear();
  registeredScopes.clear();
  scopeKeysByChatId.clear();
}

function consumeStatusWrite(
  chatId: string,
  at: number,
): StatusWriter | undefined {
  const pending = pendingStatusWrites.get(chatId);
  pendingStatusWrites.delete(chatId);
  if (!pending) return undefined;
  const age = at - pending.taggedAt;
  return age >= 0 && age <= STATUS_TAG_MAX_AGE_MS ? pending.writer : undefined;
}

/** Called immediately before a renderer-local store write that may change status. */
export function tagStatusWrite(chatId: string, writer: StatusWriter): void {
  pendingStatusWrites.set(chatId, { writer, taggedAt: now() });
}

function parseScopeKey(
  key: string,
): { projectId: string; worktreeId: string } | undefined {
  const separator = key.indexOf('/');
  if (separator <= 0 || separator === key.length - 1) return undefined;
  return {
    projectId: key.slice(0, separator),
    worktreeId: key.slice(separator + 1),
  };
}

function addChatLocation(chatId: string, scopeKey: string): void {
  const scopes = scopeKeysByChatId.get(chatId) ?? new Set<string>();
  scopes.add(scopeKey);
  scopeKeysByChatId.set(chatId, scopes);
}

function removeChatLocation(
  chatId: string,
  scopeKey: string,
  target: { projectId: string; worktreeId: string; chatId: string },
): void {
  const scopes = scopeKeysByChatId.get(chatId);
  scopes?.delete(scopeKey);
  if (scopes?.size === 0) {
    scopeKeysByChatId.delete(chatId);
    pendingStatusWrites.delete(chatId);
  }
  const key = divergenceKey(target);
  clearTracking(key);
  overridesByKey.delete(key);
}

function eligibleChat(
  state: ChatState,
  target: { projectId: string; worktreeId: string; chatId: string },
  tab?: ChatTab,
): EligibleChat | undefined {
  const scopeKey = chatScopeKey(target.projectId, target.worktreeId);
  if (state.chatStateSync[scopeKey]?.phase !== 'live') return undefined;
  const currentTab =
    tab ??
    state.worktreeChats[scopeKey]?.tabs.find(
      (candidate) => candidate.id === target.chatId,
    );
  const runtime = state.runtimeByChatId[target.chatId];
  if (
    !currentTab ||
    !runtime ||
    currentTab.kind === 'file' ||
    currentTab.claudeTerminal !== undefined ||
    isTerminalBackedInterfaceMode(
      getEffectiveClaudeChatInterfaceMode(currentTab.interfaceMode),
    ) ||
    isReadOnlyAppAdvisorMirrorTarget(target.projectId, target.worktreeId)
  ) {
    return undefined;
  }
  return { tab: currentTab, runtime };
}

function matchesTurnState(tab: ChatTab, state: 'active' | 'inactive'): boolean {
  return (tab.status === 'streaming') === (state === 'active');
}

function isDiverged(
  key: string,
  tab: ChatTab,
  runtime: ChatRuntimeState,
): boolean {
  const override = overridesByKey.get(key);
  if (override && override.runtimeRef !== runtime) {
    overridesByKey.delete(key);
  } else if (override && matchesTurnState(tab, override.state)) {
    return false;
  }
  return (
    (tab.status === 'streaming') !==
    (canonicalTurnStateFor(runtime) === 'active')
  );
}

function armTimer(tracked: TrackedDivergence): void {
  if (
    tracked.inFlight ||
    trackedByKey.get(divergenceKey(tracked.target)) !== tracked
  ) {
    return;
  }
  if (tracked.timer !== undefined) clearTimeout(tracked.timer);
  const graceDeadline =
    Math.max(tracked.since, tracked.lastActivityAt) +
    RUNTIME_DIVERGENCE_GRACE_MS;
  const deadline = Math.max(graceDeadline, tracked.retryAt ?? 0);
  const delay = Math.max(0, deadline - now());
  tracked.timer = setTimeout(() => {
    tracked.timer = undefined;
    void checkTrackedDivergence(tracked).catch(() => undefined);
  }, delay);
}

function evaluateTarget(
  state: ChatState,
  target: { projectId: string; worktreeId: string; chatId: string },
  tab: ChatTab,
  changes: EvaluationChanges = {},
): void {
  const key = divergenceKey(target);
  const existing = trackedByKey.get(key);
  const statusChanged =
    changes.localStatusChanged === true ||
    (existing !== undefined && existing.tabStatus !== tab.status);
  let taggedWriter = statusChanged
    ? consumeStatusWrite(target.chatId, now())
    : undefined;
  const override = overridesByKey.get(key);
  if (
    override &&
    override.runtimeRef !== state.runtimeByChatId[target.chatId]
  ) {
    overridesByKey.delete(key);
  }
  const eligible = eligibleChat(state, target, tab);
  if (!eligible) {
    clearTracking(key);
    return;
  }

  const runtimeChanged =
    changes.runtimeChanged === true ||
    (existing !== undefined && existing.runtimeRef !== eligible.runtime);
  const diverged = isDiverged(key, tab, eligible.runtime);
  if (!statusChanged && !existing && diverged) {
    taggedWriter = consumeStatusWrite(target.chatId, now());
  }
  if (!diverged) {
    clearTracking(key);
    return;
  }

  if (existing) {
    const activityChanged = runtimeChanged || statusChanged;
    if (statusChanged) {
      existing.writer = taggedWriter ?? 'unknown';
      existing.tabStatus = tab.status;
    }
    if (runtimeChanged) existing.runtimeStatus = eligible.runtime.status;
    existing.runtimeRef = eligible.runtime;
    if (activityChanged) {
      existing.lastActivityAt = now();
      existing.attempts = 0;
      existing.retryAt = undefined;
      existing.activityVersion += 1;
      armTimer(existing);
    }
    return;
  }

  const currentTime = now();
  const tracked: TrackedDivergence = {
    target,
    since: currentTime,
    lastActivityAt: currentTime,
    writer: taggedWriter ?? 'unknown',
    tabStatus: tab.status,
    runtimeStatus: eligible.runtime.status,
    runtimeRef: eligible.runtime,
    timer: undefined,
    attempts: 0,
    retryAt: undefined,
    inFlight: false,
    activityVersion: 0,
    divergedMs: 0,
  };
  trackedByKey.set(key, tracked);
  armTimer(tracked);
}

function findTargetTab(
  state: ChatState,
  target: { projectId: string; worktreeId: string; chatId: string },
): ChatTab | undefined {
  const scopeKey = chatScopeKey(target.projectId, target.worktreeId);
  return state.worktreeChats[scopeKey]?.tabs.find(
    (candidate) => candidate.id === target.chatId,
  );
}

function reEvaluateTracked(
  tracked: TrackedDivergence,
  state: ChatState,
  changes: EvaluationChanges = {},
): boolean {
  const tab = findTargetTab(state, tracked.target);
  if (!tab) {
    clearTracking(divergenceKey(tracked.target));
    return false;
  }
  const current = eligibleChat(state, tracked.target, tab);
  if (!current) {
    clearTracking(divergenceKey(tracked.target));
    return false;
  }
  evaluateTarget(state, tracked.target, tab, changes);
  return trackedByKey.get(divergenceKey(tracked.target)) === tracked;
}

function repairStatus(
  target: { projectId: string; worktreeId: string; chatId: string },
  runtimeRef: ChatRuntimeState,
  status: ChatTab['status'],
  error: string | null,
): boolean {
  const api = chatStoreApi();
  const beforeState = api.getState();
  const beforeTab = findTargetTab(beforeState, target);
  const beforeEligible = eligibleChat(beforeState, target, beforeTab);
  if (
    !beforeTab ||
    !beforeEligible ||
    beforeEligible.runtime !== runtimeRef ||
    (beforeTab.status === status && beforeTab.error === error)
  ) {
    return false;
  }

  tagStatusWrite(target.chatId, 'divergence-repair');
  const scopeKey = chatScopeKey(target.projectId, target.worktreeId);
  api.setState((state) => {
    const scope = state.worktreeChats[scopeKey];
    const currentTab = scope?.tabs.find(
      (candidate) => candidate.id === target.chatId,
    );
    if (
      !scope ||
      !currentTab ||
      (currentTab.status === status && currentTab.error === error)
    ) {
      return {};
    }
    return {
      worktreeChats: {
        ...state.worktreeChats,
        [scopeKey]: {
          ...scope,
          tabs: scope.tabs.map((candidate) =>
            candidate.id === target.chatId
              ? { ...candidate, status, error }
              : candidate,
          ),
        },
      },
    };
  });

  const afterTab = findTargetTab(api.getState(), target);
  return (
    afterTab !== beforeTab &&
    afterTab?.status === status &&
    afterTab.error === error
  );
}

function scheduleUnknownRetry(tracked: TrackedDivergence): void {
  tracked.attempts += 1;
  const exponent = Math.min(tracked.attempts, 20);
  const delay = Math.min(
    MAX_RETRY_DELAY_MS,
    RUNTIME_DIVERGENCE_GRACE_MS * 2 ** exponent,
  );
  tracked.retryAt = now() + delay;
  armTimer(tracked);
}

async function checkTrackedDivergence(
  tracked: TrackedDivergence,
): Promise<void> {
  const key = divergenceKey(tracked.target);
  if (trackedByKey.get(key) !== tracked) return;
  const api = chatStoreApi();
  const state = api.getState();
  const tab = findTargetTab(state, tracked.target);
  if (!tab) {
    clearTracking(key);
    return;
  }
  const eligible = eligibleChat(state, tracked.target, tab);
  if (!eligible) {
    clearTracking(key);
    return;
  }
  if (eligible.runtime !== tracked.runtimeRef) {
    reEvaluateTracked(tracked, state, { runtimeChanged: true });
    return;
  }
  if (tab.status !== tracked.tabStatus) {
    reEvaluateTracked(tracked, state, { localStatusChanged: true });
    return;
  }
  if (!isDiverged(key, tab, eligible.runtime)) {
    clearTracking(key);
    return;
  }

  const dueAt =
    Math.max(tracked.since, tracked.lastActivityAt) +
    RUNTIME_DIVERGENCE_GRACE_MS;
  if (
    now() < dueAt ||
    (tracked.retryAt !== undefined && now() < tracked.retryAt)
  ) {
    armTimer(tracked);
    return;
  }
  if (tracked.inFlight) return;

  tracked.inFlight = true;
  const confirmStartedAt = now();
  const confirmActivityVersion = tracked.activityVersion;
  let confirmation: Awaited<ReturnType<typeof confirmCanonicalTurn>>;
  try {
    confirmation = await (deps?.confirm ?? confirmCanonicalTurn)(
      tracked.target,
    );
  } catch {
    confirmation = { state: 'unknown' };
  }
  tracked.inFlight = false;
  if (trackedByKey.get(key) !== tracked) return;

  const currentState = api.getState();
  const currentTab = findTargetTab(currentState, tracked.target);
  if (!currentTab) {
    clearTracking(key);
    return;
  }
  const currentEligible = eligibleChat(
    currentState,
    tracked.target,
    currentTab,
  );
  if (!currentEligible) {
    clearTracking(key);
    return;
  }
  if (currentEligible.runtime !== eligible.runtime) {
    reEvaluateTracked(tracked, currentState, { runtimeChanged: true });
    return;
  }
  if (
    tracked.activityVersion !== confirmActivityVersion ||
    !isDiverged(key, currentTab, currentEligible.runtime)
  ) {
    if (reEvaluateTracked(tracked, currentState)) armTimer(tracked);
    return;
  }

  if (confirmation.state === 'unknown') {
    scheduleUnknownRetry(tracked);
    return;
  }

  tracked.retryAt = undefined;
  tracked.attempts = 0;
  const cachedState = canonicalTurnStateFor(currentEligible.runtime);
  if (confirmation.state !== cachedState) {
    overridesByKey.set(key, {
      state: confirmation.state,
      runtimeRef: currentEligible.runtime,
    });
  }

  let repaired = false;
  if (confirmation.state === 'active') {
    if (currentTab.status !== 'streaming') {
      repaired = repairStatus(
        tracked.target,
        currentEligible.runtime,
        'streaming',
        null,
      );
    }
  } else if (currentTab.status === 'streaming') {
    const failed = currentEligible.runtime.status === 'failed';
    repaired = repairStatus(
      tracked.target,
      currentEligible.runtime,
      failed ? 'error' : 'idle',
      failed ? (currentEligible.runtime.error?.message ?? null) : null,
    );
  }

  if (repaired) {
    try {
      deps?.record?.({
        writer: tracked.writer,
        tabStatus: tracked.tabStatus,
        runtimeStatus: tracked.runtimeStatus,
        divergedMs: now() - tracked.since,
      });
    } catch {
      // Diagnostics must never affect the chat store.
    }
    const repairedState = api.getState();
    const repairedTab = findTargetTab(repairedState, tracked.target);
    if (repairedTab) evaluateTarget(repairedState, tracked.target, repairedTab);
    return;
  }

  if (
    confirmation.state !== cachedState &&
    matchesTurnState(currentTab, confirmation.state)
  ) {
    clearTracking(key);
    return;
  }
  reEvaluateTracked(tracked, api.getState());
  // A read which produced no repair can otherwise immediately re-enter a
  // zero-delay timer if the tab is still divergent but already has the
  // confirmed state. Keep the next read behind the ordinary grace window.
  const stillTracked = trackedByKey.get(key);
  if (stillTracked === tracked && !stillTracked.inFlight) {
    const afterConfirmAt = now();
    stillTracked.lastActivityAt = Math.max(
      stillTracked.lastActivityAt,
      confirmStartedAt,
      afterConfirmAt,
    );
    armTimer(stillTracked);
  }
}

function changedRecordKeys<T>(
  previous: Record<string, T>,
  current: Record<string, T>,
): string[] {
  const keys = new Set([...Object.keys(previous), ...Object.keys(current)]);
  return Array.from(keys).filter((key) => previous[key] !== current[key]);
}

function processScope(
  scopeKey: string,
  state: ChatState,
  previousScope: ChatState['worktreeChats'][string] | undefined,
  currentScope: ChatState['worktreeChats'][string] | undefined,
  syncChanged: boolean,
): void {
  const registered = registeredScopes.get(scopeKey);
  const coordinates = registered
    ? {
        projectId: registered.projectId,
        worktreeId: registered.worktreeId,
      }
    : parseScopeKey(scopeKey);
  if (!coordinates) return;
  const previousTabs = new Map(
    (previousScope?.tabs ?? []).map((tab) => [tab.id, tab]),
  );
  if (!previousScope && registered) {
    for (const [chatId, tab] of Array.from(registered.tabs)) {
      previousTabs.set(chatId, tab);
    }
  }

  if (!currentScope) {
    for (const [chatId] of Array.from(previousTabs)) {
      removeChatLocation(chatId, scopeKey, {
        ...coordinates,
        chatId,
      });
    }
    registeredScopes.delete(scopeKey);
    return;
  }

  const nextTabs = new Map(currentScope.tabs.map((tab) => [tab.id, tab]));
  for (const [chatId] of Array.from(previousTabs)) {
    if (!nextTabs.has(chatId)) {
      removeChatLocation(chatId, scopeKey, {
        ...coordinates,
        chatId,
      });
    }
  }
  registeredScopes.set(scopeKey, {
    ...coordinates,
    tabs: nextTabs,
  });

  for (const tab of currentScope.tabs) {
    addChatLocation(tab.id, scopeKey);
    const previousTab = previousTabs.get(tab.id);
    const tabChanged = previousTab !== tab;
    const localStatusChanged =
      previousTab !== undefined && previousTab.status !== tab.status;
    if (tabChanged || syncChanged) {
      evaluateTarget(state, { ...coordinates, chatId: tab.id }, tab, {
        localStatusChanged,
      });
    }
  }
}

function handleStoreChange(state: ChatState, previous: ChatState): void {
  try {
    const changedScopes = new Set<string>();
    if (state.worktreeChats !== previous.worktreeChats) {
      for (const key of changedRecordKeys(
        previous.worktreeChats,
        state.worktreeChats,
      )) {
        changedScopes.add(key);
      }
    }
    if (state.chatStateSync !== previous.chatStateSync) {
      for (const key of changedRecordKeys(
        previous.chatStateSync,
        state.chatStateSync,
      )) {
        changedScopes.add(key);
      }
    }

    for (const key of Array.from(changedScopes)) {
      const scopeChanged =
        state.worktreeChats[key] !== previous.worktreeChats[key];
      processScope(
        key,
        state,
        scopeChanged ? previous.worktreeChats[key] : state.worktreeChats[key],
        state.worktreeChats[key],
        state.chatStateSync[key] !== previous.chatStateSync[key],
      );
    }

    if (state.runtimeByChatId !== previous.runtimeByChatId) {
      for (const chatId of changedRecordKeys(
        previous.runtimeByChatId,
        state.runtimeByChatId,
      )) {
        const scopes = scopeKeysByChatId.get(chatId);
        if (!scopes) continue;
        for (const scopeKey of Array.from(scopes)) {
          const scope = registeredScopes.get(scopeKey);
          const tab = scope?.tabs.get(chatId);
          if (!scope || !tab) continue;
          evaluateTarget(
            state,
            {
              projectId: scope.projectId,
              worktreeId: scope.worktreeId,
              chatId,
            },
            tab,
            { runtimeChanged: true },
          );
        }
      }
    }
  } catch {
    // Store listeners are synchronous; a diagnostic failure must not break a
    // chat action or another subscriber.
  }
}

/** Idempotently install the singleton store subscription. */
export function installRuntimeDivergenceDetector(
  overrides: Partial<RuntimeDivergenceDeps> = {},
): () => void {
  if (activeUninstall) return activeUninstall;
  deps = {
    now: overrides.now ?? Date.now,
    confirm: overrides.confirm ?? confirmCanonicalTurn,
    ...(overrides.record === undefined ? {} : { record: overrides.record }),
  };
  const api = chatStoreApi();
  const unsubscribe = api.subscribe(handleStoreChange);
  let uninstalled = false;
  const uninstall = (): void => {
    if (uninstalled) return;
    uninstalled = true;
    unsubscribe();
    if (activeUninstall === uninstall) activeUninstall = undefined;
    deps = undefined;
    clearAllTimersAndState();
  };
  activeUninstall = uninstall;

  try {
    const state = api.getState();
    for (const [key, scope] of Object.entries(state.worktreeChats)) {
      processScope(key, state, undefined, scope, false);
    }
  } catch {
    // A failed initial scan is recoverable on the next immutable store update.
  }
  return uninstall;
}
