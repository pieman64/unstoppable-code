import {
  hydrateChatTurnState,
  serializeChatTurnState,
} from '@canopy/agent-transcript/turn';
import type {
  ChatTurnBackground,
  ChatTurnEffect,
  ChatTurnRecord,
  PersistedChatTurnState,
} from '@canopy/agent-transcript/turn';
import {
  bindTurnOwnershipRecord,
  createTurnOwnershipRecord,
  evaluateTurnAdmission,
  matchesTurnOwnershipRecord,
} from './chat-turn-phase';
import type {
  TurnAdmissionInputs,
  TurnCanonicalView,
  TurnLifecycleOwnership,
  TurnOwnershipRecord,
} from './chat-turn-phase';
import type {
  ChatTurnStateChange,
  ChatTurnStateCommit,
  ChatTurnStateScope,
} from './chat-turn-state-handoff';

export interface ChatTurnOwnershipSnapshot extends Omit<
  TurnAdmissionInputs,
  'callerToken'
> {
  readonly scope: ChatTurnStateScope;
  /** Changes when the state service is replaced; generations are local to it. */
  readonly serviceEpoch: symbol;
  /** Monotonic within this aggregate/scope, including after reset and rebind. */
  readonly operationEpoch: number;
  /** Disk background is not proof that a runtime survived a cold restart. */
  readonly backgroundFreshness: 'unknown' | 'reconciling' | 'fresh';
  /** A known live background owner is retained across reconciliation. */
  readonly backgroundWorkRetained?: boolean;
  /** Latest active-runtime background observation, distinct from persistence. */
  readonly runtimeBackground?: ChatTurnBackground;
  readonly hostQueuedInputCount: number;
  readonly removalAwaitingSettle: boolean;
}

/** Existing ChatStateService read/notification methods, without its host surface. */
export interface ChatTurnStateSource {
  getTurnState(scope: ChatTurnStateScope): PersistedChatTurnState | undefined;
  onTurnStateChange(
    listener: (change: ChatTurnStateChange) => void,
  ): () => void;
  onTurnStateCommitted(
    listener: (commit: ChatTurnStateCommit) => void,
  ): () => void;
}

export interface TurnOwnerRegistration {
  readonly token: symbol;
  readonly userMessageId?: string;
  readonly turnId?: string;
}

/** Queue/Stop/reconciliation hooks layered onto the state projection. */
export interface ChatTurnOwnershipHost {
  registerDispatchOwner(
    scope: ChatTurnStateScope,
    owner: TurnOwnerRegistration,
  ): TurnOwnershipRecord;
  bindDispatchOwner(
    scope: ChatTurnStateScope,
    token: symbol,
    operationEpoch: number,
    turnId: string,
  ): TurnOwnershipRecord | undefined;
  removeDispatchOwner(
    scope: ChatTurnStateScope,
    token: symbol,
    operationEpoch: number,
  ): boolean;
  registerStopOwner(
    scope: ChatTurnStateScope,
    owner: TurnOwnerRegistration,
  ): TurnOwnershipRecord;
  removeStopOwner(
    scope: ChatTurnStateScope,
    token: symbol,
    operationEpoch: number,
  ): boolean;
  /** Atomic authorization continuation hand-off; `replacement` is the fresh D. */
  replaceOwner(
    scope: ChatTurnStateScope,
    token: symbol,
    operationEpoch: number,
    replacement: TurnOwnershipRecord,
  ): boolean;
  /** Convenience form that also fences a caller-captured service epoch. */
  replaceDispatchOwner(
    scope: ChatTurnStateScope,
    previous: { readonly token: symbol; readonly operationEpoch: number },
    next: TurnOwnerRegistration,
    expectedServiceEpoch: symbol,
  ): TurnOwnershipRecord | undefined;
  setHostQueuedInputCount(scope: ChatTurnStateScope, count: number): void;
  setRemovalAwaitingSettle(scope: ChatTurnStateScope, awaiting: boolean): void;
  markBackgroundReconciling(scope: ChatTurnStateScope): void;
  markBackgroundFresh(scope: ChatTurnStateScope): void;
  publishBackgroundFresh(
    scope: ChatTurnStateScope,
    background: ChatTurnBackground,
  ): void;
  /** Release this scope only after its owned reset/removal has durably settled. */
  resetScope(scope: ChatTurnStateScope): void;
}

export interface ChatTurnOwnershipSource extends ChatTurnOwnershipHost {
  getSnapshot(scope: ChatTurnStateScope): ChatTurnOwnershipSnapshot;
  /** Loads through the service outside repository mutation callbacks. */
  hydrate(scope: ChatTurnStateScope): Promise<void>;
  subscribe(
    listener: (snapshot: ChatTurnOwnershipSnapshot) => void,
  ): () => void;
  /** Bind an isolated aggregate; subscription is installed before any hydrate. */
  bind(
    source: ChatTurnStateSource,
    loadCommitted: (
      scope: ChatTurnStateScope,
    ) => Promise<PersistedChatTurnState>,
  ): () => void;
  dispose(): void;
}

interface LifecycleReceipt {
  readonly value: TurnLifecycleOwnership;
  readonly serviceEpoch: symbol;
}

interface ScopeEntry {
  readonly scope: ChatTurnStateScope;
  operationEpoch: number;
  identity: number;
  knowledge: ChatTurnOwnershipSnapshot['knowledge'];
  receipt?: TurnCanonicalView;
  committed?: TurnCanonicalView;
  /** Handoff incarnations of the cached views; see {@link isOlderNotification}. */
  receiptIncarnation?: number;
  committedIncarnation?: number;
  receiptServiceEpoch?: symbol;
  committedServiceEpoch?: symbol;
  receiptVersion: number;
  commitVersion: number;
  readonly unacknowledgedLifecycle: Map<number, LifecycleReceipt>;
  nextLifecycleId: number;
  dispatchOwners: TurnOwnershipRecord[];
  stopOwners: TurnOwnershipRecord[];
  backgroundFreshness: ChatTurnOwnershipSnapshot['backgroundFreshness'];
  backgroundWorkRetained: boolean;
  runtimeBackground?: ChatTurnBackground;
  suppressInstalledReceipt: boolean;
  hostQueuedInputCount: number;
  removalAwaitingSettle: boolean;
  hydration?: {
    readonly serviceEpoch: symbol;
    promise: Promise<void>;
  };
}

interface ServiceBinding {
  readonly source: ChatTurnStateSource;
  readonly loadCommitted: (
    scope: ChatTurnStateScope,
  ) => Promise<PersistedChatTurnState>;
  readonly serviceEpoch: symbol;
  active: boolean;
  unsubscribeChange?: () => void;
  unsubscribeCommitted?: () => void;
}

function scopeKey(scope: ChatTurnStateScope): string {
  return JSON.stringify([scope.projectId, scope.worktreeId, scope.chatId]);
}

function cloneScope(scope: ChatTurnStateScope): ChatTurnStateScope {
  return {
    projectId: scope.projectId,
    worktreeId: scope.worktreeId,
    chatId: scope.chatId,
  };
}

function normalizeState(value: unknown): PersistedChatTurnState {
  const hydrated = hydrateChatTurnState(value);
  if (!hydrated) throw new TypeError('Invalid persisted chat turn state');
  return serializeChatTurnState(hydrated);
}

function copyView(
  view: TurnCanonicalView | undefined,
): TurnCanonicalView | undefined {
  if (!view) return undefined;
  return { generation: view.generation, state: normalizeState(view.state) };
}

function hasBackgroundWork(
  background: ChatTurnBackground | undefined,
): boolean {
  return (
    background !== undefined &&
    (background.native.length > 0 ||
      background.managed.live > 0 ||
      background.managed.queued > 0)
  );
}

function copyBackground(
  background: ChatTurnBackground | undefined,
): ChatTurnBackground | undefined {
  if (!background) return undefined;
  return {
    native: background.native.map((task) => ({ ...task })),
    managed: { ...background.managed },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalField(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function lifecycleValues(value: unknown): TurnLifecycleOwnership[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: TurnLifecycleOwnership[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const candidate = item;
    if (
      typeof candidate.turnId !== 'string' ||
      candidate.turnId.length === 0 ||
      typeof candidate.generation !== 'number' ||
      !Number.isSafeInteger(candidate.generation) ||
      candidate.generation < 0 ||
      (candidate.transition !== 'start' &&
        candidate.transition !== 'binding' &&
        candidate.transition !== 'end') ||
      !Array.isArray(candidate.inputIds) ||
      !candidate.inputIds.every((id) => typeof id === 'string')
    ) {
      continue;
    }
    result.push({
      turnId: candidate.turnId,
      generation: candidate.generation,
      transition: candidate.transition,
      inputIds: Array.from(new Set(candidate.inputIds)),
    });
  }
  return result;
}

function sameLifecycle(
  left: TurnLifecycleOwnership,
  right: TurnLifecycleOwnership,
): boolean {
  return (
    left.turnId === right.turnId &&
    left.generation === right.generation &&
    left.transition === right.transition &&
    left.inputIds.length === right.inputIds.length &&
    left.inputIds.every((id, index) => id === right.inputIds[index])
  );
}

function sameLifecycleIdentity(
  left: TurnLifecycleOwnership,
  right: TurnLifecycleOwnership,
): boolean {
  return (
    left.turnId === right.turnId &&
    left.generation === right.generation &&
    left.transition === right.transition
  );
}

function inputIdsForTurn(record: ChatTurnRecord | undefined): string[] {
  if (!record) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const id of [...(record.inputIds ?? []), record.userMessageId ?? '']) {
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

function lifecycleFromEffects(
  change: ChatTurnStateChange,
  state: PersistedChatTurnState,
): TurnLifecycleOwnership[] {
  const result: TurnLifecycleOwnership[] = [];
  for (const effect of change.effects) {
    if (effect.type === 'timer.open') {
      const record = [state.current, state.lastEnded].find(
        (turnRecord) => turnRecord?.id === effect.turnId,
      );
      result.push({
        turnId: effect.turnId,
        generation: change.generation,
        transition: 'start',
        inputIds: inputIdsForTurn(record),
      });
    } else if (effect.type === 'turn.ended') {
      const record = [state.lastEnded, state.current].find(
        (turnRecord) => turnRecord?.id === effect.turnId,
      );
      result.push({
        turnId: effect.turnId,
        generation: change.generation,
        transition: 'end',
        inputIds: inputIdsForTurn(record),
      });
    }
  }
  return result;
}

function lifecycleFromInputDelta(
  previous: PersistedChatTurnState | undefined,
  current: PersistedChatTurnState,
  generation: number,
): TurnLifecycleOwnership[] {
  const previousTurn = previous?.current;
  const currentTurn = current.current;
  if (!previousTurn || !currentTurn || previousTurn.id !== currentTurn.id) {
    return [];
  }
  const previousInputIds = inputIdsForTurn(previousTurn);
  const currentInputIds = inputIdsForTurn(currentTurn);
  if (!currentInputIds.some((id) => !previousInputIds.includes(id))) return [];
  return [
    {
      turnId: currentTurn.id,
      generation,
      transition: 'binding',
      inputIds: currentInputIds,
    },
  ];
}

function lifecycleReflectedInState(
  lifecycle: TurnLifecycleOwnership,
  state: PersistedChatTurnState,
): boolean {
  if (lifecycle.transition === 'end') {
    return (
      state.lastEnded?.id === lifecycle.turnId ||
      state.endedTurnIds.includes(lifecycle.turnId)
    );
  }
  const record = [state.current, state.lastEnded].find(
    (turnRecord) => turnRecord?.id === lifecycle.turnId,
  );
  if (!record) return false;
  const inputIds = inputIdsForTurn(record);
  return lifecycle.inputIds.every((inputId) => inputIds.includes(inputId));
}

function validOwnerRegistration(owner: TurnOwnerRegistration): boolean {
  return (
    typeof owner.token === 'symbol' &&
    (owner.userMessageId === undefined ||
      (typeof owner.userMessageId === 'string' &&
        owner.userMessageId.length > 0)) &&
    (owner.turnId === undefined ||
      (typeof owner.turnId === 'string' && owner.turnId.length > 0))
  );
}

function dispatchStartIsDurable(
  owner: TurnOwnershipRecord,
  commit: ChatTurnStateCommit,
  lifecycle: readonly TurnLifecycleOwnership[] | undefined,
): boolean {
  if (!owner.userMessageId) return false;
  const matchesBoundTurn = (turnId: string): boolean =>
    owner.turnId === undefined || owner.turnId === turnId;
  if (lifecycle !== undefined) {
    const starts = lifecycle.filter(
      (item) =>
        (item.transition === 'start' || item.transition === 'binding') &&
        item.generation <= commit.generation &&
        item.inputIds.includes(owner.userMessageId ?? ''),
    );
    return starts.some(
      (start) =>
        matchesBoundTurn(start.turnId) &&
        (commit.state.current?.id === start.turnId ||
          commit.state.lastEnded?.id === start.turnId ||
          lifecycle.some(
            (item) =>
              item.turnId === start.turnId &&
              item.transition === 'end' &&
              item.generation <= commit.generation,
          )),
    );
  }

  const current = commit.state.current;
  if (
    current &&
    matchesBoundTurn(current.id) &&
    inputIdsForTurn(current).includes(owner.userMessageId)
  ) {
    return true;
  }
  const lastEnded = commit.state.lastEnded;
  return (
    lastEnded !== undefined &&
    matchesBoundTurn(lastEnded.id) &&
    inputIdsForTurn(lastEnded).includes(owner.userMessageId) &&
    committedEffects(commit).some(
      (effect) =>
        effect.type === 'turn.ended' && effect.turnId === lastEnded.id,
    )
  );
}

function committedEffects(
  commit: ChatTurnStateCommit,
): readonly ChatTurnEffect[] {
  const effects = optionalField(commit, 'effects');
  if (!Array.isArray(effects)) return [];
  return effects.filter((effect): effect is ChatTurnEffect => {
    if (!isRecord(effect) || typeof effect.type !== 'string') return false;
    return (
      effect.type === 'timer.open' ||
      effect.type === 'timer.pause' ||
      effect.type === 'timer.resume' ||
      effect.type === 'timer.close' ||
      effect.type === 'turn.ended' ||
      effect.type === 'chat.idle'
    );
  });
}

function snapshotOf(
  entry: ScopeEntry,
  serviceEpoch: symbol,
): ChatTurnOwnershipSnapshot {
  return {
    scope: cloneScope(entry.scope),
    serviceEpoch,
    operationEpoch: entry.operationEpoch,
    knowledge: entry.knowledge,
    receipt: copyView(entry.receipt),
    committed: copyView(entry.committed),
    unacknowledgedLifecycle: Array.from(
      entry.unacknowledgedLifecycle.values(),
      (record) => ({
        ...record.value,
        inputIds: [...record.value.inputIds],
      }),
    ),
    dispatchOwners: entry.dispatchOwners.map((owner) => ({ ...owner })),
    stopOwners: entry.stopOwners.map((owner) => ({ ...owner })),
    backgroundFreshness: entry.backgroundFreshness,
    backgroundWorkRetained: entry.backgroundWorkRetained,
    ...(entry.runtimeBackground === undefined
      ? {}
      : { runtimeBackground: copyBackground(entry.runtimeBackground) }),
    hostQueuedInputCount: entry.hostQueuedInputCount,
    removalAwaitingSettle: entry.removalAwaitingSettle,
  };
}

/** Service-bound per-chat ownership, admission, and power projection. */
/**
 * Whether `incoming` is older than the cached view. Generations restart when
 * eviction recreates a handoff entry, so compare them only within one
 * incarnation; a higher incarnation always supersedes.
 */
function isOlderNotification(
  incoming: { readonly generation: number; readonly incarnation?: number },
  cached: { readonly generation: number; readonly incarnation?: number },
): boolean {
  if (
    incoming.incarnation !== undefined &&
    cached.incarnation !== undefined &&
    incoming.incarnation !== cached.incarnation
  )
    return incoming.incarnation < cached.incarnation;
  return incoming.generation < cached.generation;
}

export class ChatTurnOwnershipAggregate implements ChatTurnOwnershipSource {
  private readonly scopes = new Map<string, ScopeEntry>();
  private readonly listeners = new Set<
    (snapshot: ChatTurnOwnershipSnapshot) => void
  >();
  private serviceEpoch = Symbol('chat-turn-service');
  private binding: ServiceBinding | undefined;
  private disposed = false;

  /** Whether a state service is bound; unbound means no canonical state exists. */
  public isBound(): boolean {
    return this.binding !== undefined && this.isCurrentBinding(this.binding);
  }

  public getSnapshot(scope: ChatTurnStateScope): ChatTurnOwnershipSnapshot {
    const entry = this.scopeEntry(scope);
    this.refreshInstalledReceipt(entry);
    return snapshotOf(entry, this.serviceEpoch);
  }

  /** The scopes this process tracks turn state for that hold `chatId`. */
  public scopesForChat(chatId: string): ChatTurnStateScope[] {
    return Array.from(this.scopes.values(), (entry) => entry.scope)
      .filter((scope) => scope.chatId === chatId)
      .map(cloneScope);
  }

  public subscribe(
    listener: (snapshot: ChatTurnOwnershipSnapshot) => void,
  ): () => void {
    this.listeners.add(listener);
    let active = true;
    return (): void => {
      if (!active) return;
      active = false;
      this.listeners.delete(listener);
    };
  }

  public bind(
    source: ChatTurnStateSource,
    loadCommitted: (
      scope: ChatTurnStateScope,
    ) => Promise<PersistedChatTurnState>,
  ): () => void {
    if (this.disposed) return () => undefined;
    if (this.binding) this.retireBinding(this.binding);

    const serviceEpoch = Symbol('chat-turn-service');
    this.serviceEpoch = serviceEpoch;
    this.invalidateForServiceReplacement();
    const binding: ServiceBinding = {
      source,
      loadCommitted,
      serviceEpoch,
      active: true,
    };
    this.binding = binding;
    try {
      binding.unsubscribeChange = source.onTurnStateChange((change) => {
        if (!this.isCurrentBinding(binding)) return;
        this.acceptChange(binding, change);
      });
      binding.unsubscribeCommitted = source.onTurnStateCommitted((commit) => {
        if (!this.isCurrentBinding(binding)) return;
        this.acceptCommit(binding, commit);
      });
    } catch {
      this.retireBinding(binding);
      this.binding = undefined;
      this.invalidateForServiceReplacement();
    }
    this.notifyAll();

    let active = true;
    return (): void => {
      if (!active) return;
      active = false;
      if (this.binding !== binding) return;
      this.retireBinding(binding);
      this.binding = undefined;
      this.serviceEpoch = Symbol('chat-turn-service');
      this.invalidateForServiceReplacement();
      this.notifyAll();
    };
  }

  public hydrate(scope: ChatTurnStateScope): Promise<void> {
    const entry = this.scopeEntry(scope);
    const binding = this.binding;
    if (!binding || !this.isCurrentBinding(binding)) {
      entry.knowledge = 'unknown';
      return Promise.reject(new Error('Chat turn state source is not bound'));
    }
    if (entry.hydration?.serviceEpoch === binding.serviceEpoch) {
      return entry.hydration.promise;
    }

    entry.knowledge = 'loading';
    if (entry.backgroundFreshness === 'unknown') {
      entry.backgroundFreshness = 'reconciling';
    }
    this.refreshInstalledReceipt(entry);
    const identity = entry.identity;
    const receiptVersion = entry.receiptVersion;
    const commitVersion = entry.commitVersion;
    const hydration: NonNullable<ScopeEntry['hydration']> = {
      serviceEpoch: binding.serviceEpoch,
      promise: Promise.resolve(),
    };
    entry.hydration = hydration;
    this.notify(entry.scope);
    hydration.promise = this.runHydration(
      entry,
      binding,
      identity,
      receiptVersion,
      commitVersion,
      hydration,
    );
    return hydration.promise;
  }

  public registerDispatchOwner(
    scope: ChatTurnStateScope,
    owner: TurnOwnerRegistration,
  ): TurnOwnershipRecord {
    return this.registerOwner(scope, 'dispatch', owner);
  }

  public bindDispatchOwner(
    scope: ChatTurnStateScope,
    token: symbol,
    operationEpoch: number,
    turnId: string,
  ): TurnOwnershipRecord | undefined {
    const entry = this.scopeEntry(scope);
    if (turnId.length === 0) return undefined;
    const index = entry.dispatchOwners.findIndex((owner) =>
      matchesTurnOwnershipRecord(owner, token, operationEpoch),
    );
    if (index < 0) return undefined;
    const owner = entry.dispatchOwners[index];
    if (!owner) return undefined;
    const bound = bindTurnOwnershipRecord(owner, turnId);
    entry.dispatchOwners[index] = bound;
    this.notify(entry.scope);
    return { ...bound };
  }

  public removeDispatchOwner(
    scope: ChatTurnStateScope,
    token: symbol,
    operationEpoch: number,
  ): boolean {
    return this.removeOwner(scope, 'dispatch', token, operationEpoch);
  }

  public registerStopOwner(
    scope: ChatTurnStateScope,
    owner: TurnOwnerRegistration,
  ): TurnOwnershipRecord {
    return this.registerOwner(scope, 'stop', owner);
  }

  public removeStopOwner(
    scope: ChatTurnStateScope,
    token: symbol,
    operationEpoch: number,
  ): boolean {
    return this.removeOwner(scope, 'stop', token, operationEpoch);
  }

  public replaceOwner(
    scope: ChatTurnStateScope,
    token: symbol,
    operationEpoch: number,
    replacement: TurnOwnershipRecord,
  ): boolean {
    const entry = this.scopeEntry(scope);
    const dispatchIndex = entry.dispatchOwners.findIndex((owner) =>
      matchesTurnOwnershipRecord(owner, token, operationEpoch),
    );
    const stopIndex = entry.stopOwners.findIndex((owner) =>
      matchesTurnOwnershipRecord(owner, token, operationEpoch),
    );
    const matchCount = Number(dispatchIndex >= 0) + Number(stopIndex >= 0);
    if (
      matchCount !== 1 ||
      !validOwnerRegistration(replacement) ||
      replacement.kind !== 'dispatch' ||
      replacement.token === token ||
      replacement.turnId !== undefined ||
      replacement.reason !== 'awaiting-start' ||
      replacement.operationEpoch !== entry.operationEpoch + 1 ||
      entry.dispatchOwners.some((owner) => owner.token === replacement.token) ||
      entry.stopOwners.some((owner) => owner.token === replacement.token)
    ) {
      return false;
    }

    const latest = this.getSnapshot(scope);
    const verdict = evaluateTurnAdmission({ ...latest, callerToken: token });
    if (verdict.kind !== 'allow') return false;

    const nextOwners = entry.dispatchOwners.filter(
      (_owner, index) => index !== dispatchIndex,
    );
    nextOwners.push({ ...replacement });
    entry.dispatchOwners = nextOwners;
    if (stopIndex >= 0) {
      entry.stopOwners = entry.stopOwners.filter(
        (_owner, index) => index !== stopIndex,
      );
    }
    entry.operationEpoch = replacement.operationEpoch;
    this.notify(entry.scope);
    return true;
  }

  public replaceDispatchOwner(
    scope: ChatTurnStateScope,
    previous: { readonly token: symbol; readonly operationEpoch: number },
    next: TurnOwnerRegistration,
    expectedServiceEpoch: symbol,
  ): TurnOwnershipRecord | undefined {
    const latest = this.getSnapshot(scope);
    if (
      latest.serviceEpoch !== expectedServiceEpoch ||
      !validOwnerRegistration(next)
    ) {
      return undefined;
    }
    const replacement = createTurnOwnershipRecord({
      kind: 'dispatch',
      ...next,
      operationEpoch: latest.operationEpoch + 1,
    });
    if (
      !this.replaceOwner(
        scope,
        previous.token,
        previous.operationEpoch,
        replacement,
      )
    ) {
      return undefined;
    }
    return { ...replacement };
  }

  public setHostQueuedInputCount(
    scope: ChatTurnStateScope,
    count: number,
  ): void {
    if (!Number.isSafeInteger(count) || count < 0) return;
    const entry = this.scopeEntry(scope);
    if (entry.hostQueuedInputCount === count) return;
    entry.hostQueuedInputCount = count;
    this.notify(entry.scope);
  }

  public setRemovalAwaitingSettle(
    scope: ChatTurnStateScope,
    awaiting: boolean,
  ): void {
    const entry = this.scopeEntry(scope);
    if (entry.removalAwaitingSettle === awaiting) return;
    entry.removalAwaitingSettle = awaiting;
    this.notify(entry.scope);
  }

  public markBackgroundReconciling(scope: ChatTurnStateScope): void {
    const entry = this.scopeEntry(scope);
    if (entry.backgroundFreshness === 'reconciling') return;
    if (entry.backgroundFreshness === 'fresh') {
      entry.backgroundWorkRetained = hasBackgroundWork(entry.runtimeBackground);
    }
    entry.backgroundFreshness = 'reconciling';
    this.notify(entry.scope);
  }

  public markBackgroundFresh(scope: ChatTurnStateScope): void {
    const entry = this.scopeEntry(scope);
    this.refreshInstalledReceipt(entry);
    const background = this.currentRuntimeBackground(entry);
    entry.backgroundFreshness = 'fresh';
    entry.runtimeBackground = copyBackground(background) ?? {
      native: [],
      managed: { live: 0, queued: 0 },
    };
    entry.backgroundWorkRetained = hasBackgroundWork(background);
    this.notify(entry.scope);
  }

  public publishBackgroundFresh(
    scope: ChatTurnStateScope,
    background: ChatTurnBackground,
  ): void {
    const entry = this.scopeEntry(scope);
    entry.backgroundFreshness = 'fresh';
    entry.runtimeBackground = copyBackground(background);
    entry.backgroundWorkRetained = hasBackgroundWork(background);
    this.notify(entry.scope);
  }

  public resetScope(scope: ChatTurnStateScope): void {
    const entry = this.scopeEntry(scope);
    entry.identity += 1;
    entry.hydration = undefined;
    entry.knowledge = 'unknown';
    entry.receipt = undefined;
    entry.committed = undefined;
    entry.receiptServiceEpoch = undefined;
    entry.committedServiceEpoch = undefined;
    entry.receiptVersion += 1;
    entry.commitVersion += 1;
    entry.unacknowledgedLifecycle.clear();
    entry.dispatchOwners = [];
    entry.stopOwners = [];
    entry.backgroundFreshness = 'unknown';
    entry.backgroundWorkRetained = false;
    entry.runtimeBackground = undefined;
    entry.suppressInstalledReceipt = true;
    entry.hostQueuedInputCount = 0;
    entry.removalAwaitingSettle = false;
    entry.operationEpoch += 1;
    this.notify(entry.scope);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.binding) {
      this.retireBinding(this.binding);
      this.binding = undefined;
    }
    this.serviceEpoch = Symbol('chat-turn-service');
    for (const entry of Array.from(this.scopes.values())) {
      entry.identity += 1;
      entry.hydration = undefined;
      entry.knowledge = 'unknown';
      entry.receipt = undefined;
      entry.committed = undefined;
      entry.unacknowledgedLifecycle.clear();
      entry.dispatchOwners = [];
      entry.stopOwners = [];
      entry.backgroundFreshness = 'unknown';
      entry.backgroundWorkRetained = false;
      entry.runtimeBackground = undefined;
      entry.suppressInstalledReceipt = true;
      entry.hostQueuedInputCount = 0;
      entry.removalAwaitingSettle = false;
      entry.operationEpoch += 1;
    }
    this.listeners.clear();
  }

  private scopeEntry(scope: ChatTurnStateScope): ScopeEntry {
    const key = scopeKey(scope);
    const existing = this.scopes.get(key);
    if (existing) return existing;
    const entry: ScopeEntry = {
      scope: cloneScope(scope),
      operationEpoch: 0,
      identity: 0,
      knowledge: 'unknown',
      receiptVersion: 0,
      commitVersion: 0,
      unacknowledgedLifecycle: new Map(),
      nextLifecycleId: 1,
      dispatchOwners: [],
      stopOwners: [],
      backgroundFreshness: 'unknown',
      backgroundWorkRetained: false,
      suppressInstalledReceipt: false,
      hostQueuedInputCount: 0,
      removalAwaitingSettle: false,
    };
    this.scopes.set(key, entry);
    return entry;
  }

  private registerOwner(
    scope: ChatTurnStateScope,
    kind: TurnOwnershipRecord['kind'],
    owner: TurnOwnerRegistration,
  ): TurnOwnershipRecord {
    const entry = this.scopeEntry(scope);
    if (!validOwnerRegistration(owner)) {
      throw new TypeError('Chat turn ownership token and ids must be valid');
    }
    const otherOwners =
      kind === 'dispatch' ? entry.stopOwners : entry.dispatchOwners;
    if (otherOwners.some((candidate) => candidate.token === owner.token)) {
      throw new TypeError('Chat turn ownership token must be unique per scope');
    }
    const owners =
      kind === 'dispatch' ? entry.dispatchOwners : entry.stopOwners;
    const duplicateIndex = owners.findIndex((candidate) =>
      matchesTurnOwnershipRecord(
        candidate,
        owner.token,
        candidate.operationEpoch,
      ),
    );
    entry.operationEpoch += 1;
    const record = createTurnOwnershipRecord({
      kind,
      ...owner,
      operationEpoch: entry.operationEpoch,
    });
    if (duplicateIndex >= 0) owners[duplicateIndex] = record;
    else owners.push(record);
    this.notify(entry.scope);
    return { ...record };
  }

  private removeOwner(
    scope: ChatTurnStateScope,
    kind: TurnOwnershipRecord['kind'],
    token: symbol,
    operationEpoch: number,
  ): boolean {
    const entry = this.scopeEntry(scope);
    const owners =
      kind === 'dispatch' ? entry.dispatchOwners : entry.stopOwners;
    const index = owners.findIndex((owner) =>
      matchesTurnOwnershipRecord(owner, token, operationEpoch),
    );
    if (index < 0) return false;
    if (kind === 'dispatch') {
      entry.dispatchOwners = owners.filter(
        (_owner, ownerIndex) => ownerIndex !== index,
      );
    } else {
      entry.stopOwners = owners.filter(
        (_owner, ownerIndex) => ownerIndex !== index,
      );
    }
    this.notify(entry.scope);
    return true;
  }

  private async runHydration(
    entry: ScopeEntry,
    binding: ServiceBinding,
    identity: number,
    receiptVersion: number,
    commitVersion: number,
    hydration: NonNullable<ScopeEntry['hydration']>,
  ): Promise<void> {
    try {
      const loadedState = normalizeState(
        await binding.loadCommitted(cloneScope(entry.scope)),
      );
      if (!this.isCurrentBinding(binding) || entry.identity !== identity)
        return;

      if (entry.commitVersion === commitVersion) {
        entry.committed = { generation: 0, state: loadedState };
        entry.committedServiceEpoch = binding.serviceEpoch;
      }
      if (entry.receiptVersion === receiptVersion) {
        let installed: PersistedChatTurnState | undefined;
        if (!entry.suppressInstalledReceipt) {
          try {
            installed = binding.source.getTurnState(cloneScope(entry.scope));
          } catch {
            installed = undefined;
          }
        }
        entry.receipt = {
          generation: 0,
          state: normalizeState(installed ?? loadedState),
        };
        entry.receiptServiceEpoch = binding.serviceEpoch;
        entry.suppressInstalledReceipt = false;
      }
      if (entry.backgroundFreshness === 'unknown') {
        entry.backgroundFreshness = 'reconciling';
      }
      entry.knowledge = entry.receipt && entry.committed ? 'known' : 'unknown';
      const reconciledState =
        entry.committedServiceEpoch === binding.serviceEpoch
          ? entry.committed?.state
          : undefined;
      if (reconciledState) {
        this.reconcileOldLifecycle(
          entry,
          binding.serviceEpoch,
          reconciledState,
        );
      }
      this.notify(entry.scope);
    } catch (error) {
      if (this.isCurrentBinding(binding) && entry.identity === identity) {
        entry.knowledge = 'unknown';
        this.notify(entry.scope);
      }
      throw error;
    } finally {
      if (entry.hydration === hydration) entry.hydration = undefined;
    }
  }

  private acceptChange(
    binding: ServiceBinding,
    change: ChatTurnStateChange,
  ): void {
    const entry = this.scopeEntry(change.scope);
    let state: PersistedChatTurnState;
    try {
      state = normalizeState(change.state);
    } catch {
      entry.knowledge = 'unknown';
      this.notify(entry.scope);
      return;
    }
    if (
      change.cause !== 'reset' &&
      entry.receiptServiceEpoch === binding.serviceEpoch &&
      entry.receipt &&
      isOlderNotification(change, {
        generation: entry.receipt.generation,
        incarnation: entry.receiptIncarnation,
      })
    ) {
      return;
    }
    if (change.cause === 'reset') {
      entry.identity += 1;
      entry.hydration = undefined;
      entry.receipt = undefined;
      entry.committed = undefined;
      entry.receiptServiceEpoch = undefined;
      entry.committedServiceEpoch = undefined;
      entry.receiptVersion += 1;
      entry.commitVersion += 1;
      entry.unacknowledgedLifecycle.clear();
      entry.knowledge = 'unknown';
      entry.backgroundFreshness = 'unknown';
      entry.backgroundWorkRetained = false;
      entry.runtimeBackground = undefined;
      entry.suppressInstalledReceipt = false;
      entry.operationEpoch += 1;
    }
    const previousState =
      change.cause === 'reset' ||
      entry.receiptServiceEpoch !== binding.serviceEpoch
        ? undefined
        : entry.receipt?.state;
    entry.receipt = {
      generation: change.generation,
      state,
    };
    entry.receiptIncarnation = change.incarnation;
    entry.receiptServiceEpoch = binding.serviceEpoch;
    entry.suppressInstalledReceipt = false;
    entry.receiptVersion += 1;

    const values = lifecycleValues(optionalField(change, 'lifecycle'));
    const additions = values ?? lifecycleFromEffects(change, state);
    const inferredBindings = lifecycleFromInputDelta(
      previousState,
      state,
      change.generation,
    );
    for (const value of additions.concat(inferredBindings)) {
      this.addLifecycle(entry, value, binding.serviceEpoch);
      this.bindDispatchOwnersForLifecycle(entry, value);
    }
    // Hydration reads persisted membership, not a surviving execution.
    if (change.cause !== 'hydrate' && change.cause !== 'reset') {
      entry.runtimeBackground = copyBackground(state.background);
      entry.backgroundFreshness = 'fresh';
      entry.backgroundWorkRetained = hasBackgroundWork(state.background);
    }
    if (
      entry.committed &&
      entry.committedServiceEpoch === binding.serviceEpoch
    ) {
      entry.knowledge = 'known';
    }
    this.notify(entry.scope);
  }

  private acceptCommit(
    binding: ServiceBinding,
    commit: ChatTurnStateCommit,
  ): void {
    const entry = this.scopeEntry(commit.scope);
    if (
      entry.committedServiceEpoch === binding.serviceEpoch &&
      entry.committed &&
      isOlderNotification(commit, {
        generation: entry.committed.generation,
        incarnation: entry.committedIncarnation,
      })
    ) {
      return;
    }
    const prefixValue = optionalField(commit, 'lifecycle');
    let committedState: PersistedChatTurnState;
    try {
      committedState = normalizeState(commit.state);
    } catch {
      entry.knowledge = 'unknown';
      this.notify(entry.scope);
      return;
    }
    entry.committed = {
      generation: commit.generation,
      state: committedState,
    };
    entry.committedIncarnation = commit.incarnation;
    entry.committedServiceEpoch = binding.serviceEpoch;
    entry.commitVersion += 1;
    if (
      !entry.receipt ||
      entry.receiptServiceEpoch !== binding.serviceEpoch ||
      !isOlderNotification(commit, {
        generation: entry.receipt.generation,
        incarnation: entry.receiptIncarnation,
      })
    ) {
      entry.receipt = {
        generation: commit.generation,
        state: committedState,
      };
      entry.receiptIncarnation = commit.incarnation;
      entry.receiptServiceEpoch = binding.serviceEpoch;
      entry.receiptVersion += 1;
    }
    entry.knowledge = entry.receipt ? 'known' : 'unknown';

    const hasLifecyclePrefix = Array.isArray(prefixValue);
    const acknowledgedLifecycle = lifecycleValues(prefixValue);
    for (const [id, record] of Array.from(
      entry.unacknowledgedLifecycle.entries(),
    )) {
      const acknowledgedByPrefix =
        record.serviceEpoch === binding.serviceEpoch &&
        (acknowledgedLifecycle?.some((item) =>
          sameLifecycleIdentity(item, record.value),
        ) ??
          false);
      const acknowledgedByGeneration =
        !hasLifecyclePrefix &&
        record.serviceEpoch === binding.serviceEpoch &&
        record.value.generation <= commit.generation;
      if (acknowledgedByPrefix || acknowledgedByGeneration) {
        entry.unacknowledgedLifecycle.delete(id);
      }
    }

    const normalizedCommit: ChatTurnStateCommit = {
      ...commit,
      state: committedState,
    };
    const owners = entry.dispatchOwners;
    const keptOwners = owners.filter(
      (owner) =>
        !dispatchStartIsDurable(owner, normalizedCommit, acknowledgedLifecycle),
    );
    if (keptOwners.length !== owners.length) {
      entry.dispatchOwners = keptOwners;
    }
    this.updateRuntimeBackground(entry, binding.serviceEpoch);
    this.notify(entry.scope);
  }

  private addLifecycle(
    entry: ScopeEntry,
    value: TurnLifecycleOwnership,
    serviceEpoch: symbol,
  ): void {
    const exists = Array.from(entry.unacknowledgedLifecycle.values()).some(
      (record) =>
        record.serviceEpoch === serviceEpoch &&
        sameLifecycle(record.value, value),
    );
    if (exists) return;
    const id = entry.nextLifecycleId;
    entry.nextLifecycleId += 1;
    entry.unacknowledgedLifecycle.set(id, {
      value: { ...value, inputIds: [...value.inputIds] },
      serviceEpoch,
    });
  }

  private bindDispatchOwnersForLifecycle(
    entry: ScopeEntry,
    lifecycle: TurnLifecycleOwnership,
  ): void {
    if (
      lifecycle.transition !== 'start' &&
      lifecycle.transition !== 'binding'
    ) {
      return;
    }
    entry.dispatchOwners = entry.dispatchOwners.map((owner) => {
      if (
        !owner.userMessageId ||
        !lifecycle.inputIds.includes(owner.userMessageId) ||
        (owner.turnId !== undefined && owner.turnId !== lifecycle.turnId)
      ) {
        return owner;
      }
      return bindTurnOwnershipRecord(owner, lifecycle.turnId);
    });
  }

  private reconcileOldLifecycle(
    entry: ScopeEntry,
    serviceEpoch: symbol,
    committedState: PersistedChatTurnState,
  ): void {
    for (const [id, record] of Array.from(
      entry.unacknowledgedLifecycle.entries(),
    )) {
      if (
        record.serviceEpoch !== serviceEpoch &&
        lifecycleReflectedInState(record.value, committedState)
      ) {
        entry.unacknowledgedLifecycle.delete(id);
      }
    }
  }

  private currentRuntimeBackground(
    entry: ScopeEntry,
  ): ChatTurnBackground | undefined {
    const serviceEpoch = this.binding?.serviceEpoch;
    if (!serviceEpoch) return entry.runtimeBackground;
    const receipt =
      entry.receiptServiceEpoch === serviceEpoch ? entry.receipt : undefined;
    const committed =
      entry.committedServiceEpoch === serviceEpoch
        ? entry.committed
        : undefined;
    if (!receipt) return committed?.state.background ?? entry.runtimeBackground;
    if (!committed) return receipt.state.background;
    return receipt.generation >= committed.generation
      ? receipt.state.background
      : committed.state.background;
  }

  private updateRuntimeBackground(
    entry: ScopeEntry,
    serviceEpoch: symbol,
  ): void {
    const receipt =
      entry.receiptServiceEpoch === serviceEpoch ? entry.receipt : undefined;
    const committed =
      entry.committedServiceEpoch === serviceEpoch
        ? entry.committed
        : undefined;
    const latest =
      receipt && committed
        ? receipt.generation >= committed.generation
          ? receipt
          : committed
        : (receipt ?? committed);
    if (!latest) return;
    entry.runtimeBackground = copyBackground(latest.state.background);
    entry.backgroundFreshness = 'fresh';
    entry.backgroundWorkRetained = hasBackgroundWork(latest.state.background);
  }

  private refreshInstalledReceipt(entry: ScopeEntry): void {
    const binding = this.binding;
    if (
      !binding ||
      !this.isCurrentBinding(binding) ||
      entry.suppressInstalledReceipt
    ) {
      return;
    }
    try {
      const installed = binding.source.getTurnState(cloneScope(entry.scope));
      if (!installed) return;
      const state = normalizeState(installed);
      if (
        entry.receiptServiceEpoch !== binding.serviceEpoch ||
        !entry.receipt ||
        JSON.stringify(entry.receipt.state) !== JSON.stringify(state)
      ) {
        entry.receipt = {
          generation:
            entry.receiptServiceEpoch === binding.serviceEpoch
              ? (entry.receipt?.generation ?? 0)
              : 0,
          state,
        };
        entry.receiptServiceEpoch = binding.serviceEpoch;
      }
    } catch {
      entry.knowledge = 'unknown';
    }
  }

  private registerOwnerEpochs(entry: ScopeEntry): void {
    entry.operationEpoch += 1;
    const epoch = entry.operationEpoch;
    entry.dispatchOwners = entry.dispatchOwners.map((owner) => ({
      ...owner,
      operationEpoch: epoch,
    }));
    entry.stopOwners = entry.stopOwners.map((owner) => ({
      ...owner,
      operationEpoch: epoch,
    }));
  }

  /** Test isolation: a new harness must not inherit another run's owners. */
  public resetScopesForTests(): void {
    this.scopes.clear();
  }

  private invalidateForServiceReplacement(): void {
    for (const entry of Array.from(this.scopes.values())) {
      entry.identity += 1;
      entry.hydration = undefined;
      entry.knowledge = 'unknown';
      if (entry.backgroundFreshness === 'fresh') {
        entry.backgroundWorkRetained = hasBackgroundWork(
          entry.runtimeBackground,
        );
      }
      entry.receiptServiceEpoch = undefined;
      entry.committedServiceEpoch = undefined;
      entry.receiptVersion += 1;
      entry.commitVersion += 1;
      entry.backgroundFreshness = 'reconciling';
      entry.suppressInstalledReceipt = true;
      this.registerOwnerEpochs(entry);
    }
  }

  private retireBinding(binding: ServiceBinding): void {
    if (!binding.active) return;
    binding.active = false;
    try {
      binding.unsubscribeChange?.();
    } catch {
      // Listener cleanup is best effort; the binding identity fences callbacks.
    }
    try {
      binding.unsubscribeCommitted?.();
    } catch {
      // Listener cleanup is best effort; the binding identity fences callbacks.
    }
  }

  private isCurrentBinding(binding: ServiceBinding): boolean {
    return (
      !this.disposed &&
      binding.active &&
      this.binding === binding &&
      this.serviceEpoch === binding.serviceEpoch
    );
  }

  private notify(scope: ChatTurnStateScope): void {
    const snapshot = this.getSnapshot(scope);
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(snapshot);
      } catch {
        // An ownership observer cannot block a provider or host operation.
      }
    }
  }

  private notifyAll(): void {
    Array.from(this.scopes.values()).forEach((entry) =>
      this.notify(entry.scope),
    );
  }
}

let singleton: ChatTurnOwnershipAggregate | undefined;

export function createChatTurnOwnershipSource(): ChatTurnOwnershipAggregate {
  return new ChatTurnOwnershipAggregate();
}

export function getChatTurnOwnership(): ChatTurnOwnershipAggregate {
  singleton ??= new ChatTurnOwnershipAggregate();
  return singleton;
}

export function bindChatTurnOwnership(
  source: ChatTurnStateSource,
  loadCommitted: (scope: ChatTurnStateScope) => Promise<PersistedChatTurnState>,
): () => void {
  return getChatTurnOwnership().bind(source, loadCommitted);
}

/** Admission uses knowledge and canonical ownership; power also owns D/S/T and background. */
export function shouldHoldChatWake(
  snapshot: ChatTurnOwnershipSnapshot,
): boolean {
  const retainedBackground = snapshot.backgroundWorkRetained === true;
  const freshBackground =
    snapshot.backgroundFreshness === 'fresh' &&
    (snapshot.runtimeBackground === undefined
      ? hasBackgroundWork(snapshot.receipt?.state.background) ||
        hasBackgroundWork(snapshot.committed?.state.background)
      : hasBackgroundWork(snapshot.runtimeBackground));
  return (
    snapshot.removalAwaitingSettle ||
    snapshot.dispatchOwners.length > 0 ||
    snapshot.stopOwners.length > 0 ||
    snapshot.unacknowledgedLifecycle.length > 0 ||
    snapshot.receipt?.state.current !== undefined ||
    snapshot.committed?.state.current !== undefined ||
    retainedBackground ||
    freshBackground
  );
}
