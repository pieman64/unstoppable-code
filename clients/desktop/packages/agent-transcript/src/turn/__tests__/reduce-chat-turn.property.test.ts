import type {
  BackgroundSet,
  ChatTurnLifecycleEvent,
  ProducerBase,
  SessionState,
  SpawnedBy,
  TurnBinding,
  TurnEnded,
  TurnOrigin,
  TurnStarted,
} from '@canopy/protocol/canopy-core';
import {
  hydrateChatTurnState,
  initialChatTurnState,
  reduceChatTurn,
  reduceChatTurnHostEvent,
  serializeChatTurnState,
  settleChatTurnForRestart,
} from '../index';
import type {
  ChatTurnEffect,
  ChatTurnHostPauseEvent,
  ChatTurnOutcome,
  ChatTurnPauseOwnerKind,
  ChatTurnPause,
  ChatTurnPhase,
  ChatTurnRecord,
  ChatTurnState,
} from '../index';

/**
 * Test oracle: the turn's paused time up to its end, counting overlapping
 * pause intervals once.
 */
function expectedPausedMs(turn: ChatTurnRecord, endedAtMs: number): number {
  const intervals = turn.pauses
    .map((pause) => [
      Math.max(turn.startedAtMs, pause.startedAtMs),
      Math.min(endedAtMs, pause.endedAtMs ?? endedAtMs),
    ])
    .filter(([start, end]) => end > start)
    .sort(([left], [right]) => left - right);
  let pausedMs = 0;
  let coveredUntil = -Infinity;
  for (const [start, end] of intervals) {
    const from = Math.max(start, coveredUntil);
    if (end > from) pausedMs += end - from;
    coveredUntil = Math.max(coveredUntil, end);
  }
  return pausedMs;
}

interface ProducerScope {
  provider: 'claude' | 'codex';
  processEpoch: string;
}

interface ScenarioSteps {
  firstTurnStarted: number;
  decisionRequired: number;
  backgroundStarted: number;
  firstTurnBound: number;
  supersedingTurnStarted: number;
  supersededTurnEnded: number;
  backgroundCleared: number;
  settledTurnStarted: number;
  settledDecisionRequired: number;
  settledTurnEnded: number;
  settledSessionReconnecting: number;
  settledBackgroundCleared: number;
}

interface GeneratedStream {
  events: ChatTurnLifecycleEvent[];
  sequences: Record<string, number>;
  scenario: ScenarioSteps;
  firstTurnId: string;
  supersedingTurnId: string;
  settledTurnId: string;
  activeBackground: BackgroundSet;
}

type GeneratedMixedEvent =
  | { kind: 'provider'; event: ChatTurnLifecycleEvent }
  | { kind: 'host'; event: ChatTurnHostPauseEvent };

interface MixedScenarioSteps {
  firstOwnerOpened: number;
  firstOwnerOverlap: number;
  duplicateHostCounter: number;
  staleHostCounter: number;
  duplicateOwnerOpen: number;
  wrongOwnerClose: number;
  oneOwnerClosed: number;
  allOwnersClosed: number;
  pauseBeforeSupersession: number;
  pausedSupersession: number;
  wrongTurnHostEvent: number;
  settledTurnHostEvent: number;
  terminalPauseOpened: number;
  pausedTerminalEnd: number;
  randomHostSteps: number[];
}

interface GeneratedMixedStream {
  events: GeneratedMixedEvent[];
  scenario: MixedScenarioSteps;
}

interface ReductionResult {
  state: ChatTurnState;
  effects: ChatTurnEffect[];
}

interface SettledProbe {
  name: string;
  event: ChatTurnLifecycleEvent;
}

const PROPERTY_SEEDS: readonly number[] = [
  1, 7, 19, 42, 73, 101, 257, 1024, 2025, 4099, 8191, 99991,
];

const GENERATED_EVENT_COUNT = 128;

const CLAUDE_EPOCH_A: ProducerScope = {
  provider: 'claude',
  processEpoch: 'claude-epoch-a',
};
const CODEX_EPOCH_A: ProducerScope = {
  provider: 'codex',
  processEpoch: 'codex-epoch-a',
};
const CODEX_EPOCH_B: ProducerScope = {
  provider: 'codex',
  processEpoch: 'codex-epoch-b',
};
const CLAUDE_EPOCH_B: ProducerScope = {
  provider: 'claude',
  processEpoch: 'claude-epoch-b',
};
const PRODUCER_SCOPES: readonly ProducerScope[] = [
  CLAUDE_EPOCH_A,
  CODEX_EPOCH_A,
  CODEX_EPOCH_B,
  CLAUDE_EPOCH_B,
];

const TURN_ORIGINS: readonly TurnOrigin[] = [
  'user',
  'steer',
  'autonomous',
  'restart',
];

const TURN_BINDINGS: readonly TurnBinding['binding'][] = [
  'pending',
  'bound',
  'unbound',
];

const TURN_OUTCOMES: readonly TurnEnded['outcome'][] = [
  'completed',
  'cancelled',
  'failed',
];

const TURN_END_SOURCES: readonly TurnEnded['source'][] = [
  'result',
  'abort-fallback',
  'turn-completed',
];

const SESSION_STATES: readonly SessionState['state'][] = [
  'running',
  'requires_action',
  'idle',
  'reconnecting',
];

const SESSION_SOURCES: readonly SessionState['source'][] = [
  'provider',
  'result-fallback',
];

function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return (): number => {
    value += 0x6d2b79f5;
    let mixed = value;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function choose<T>(random: () => number, values: readonly T[]): T {
  const value = values[Math.floor(random() * values.length)];
  if (value === undefined) {
    throw new Error('Cannot choose a value from an empty list');
  }
  return value;
}

function assertAt(
  seed: number,
  step: number,
  description: string,
  assertion: () => void,
): void {
  try {
    assertion();
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`seed=${seed} step=${step} ${description}\n${detail}`);
  }
}

function producerKey(producer: ProducerScope): string {
  return `${producer.provider}:${producer.processEpoch}`;
}

function eventProducerKey(event: ChatTurnLifecycleEvent): string {
  return `${event.provider}:${event.processEpoch ?? 'no-epoch'}`;
}

function nextProducerBase(
  sequences: Record<string, number>,
  producer: ProducerScope,
  seed: number,
  step: number,
): ProducerBase {
  const key = producerKey(producer);
  const sequence = (sequences[key] ?? 0) + 1;
  sequences[key] = sequence;
  return {
    version: 1,
    provider: producer.provider,
    projectId: 'property-project',
    worktreeId: 'property-worktree',
    chatId: 'property-chat',
    processEpoch: producer.processEpoch,
    sequence,
    eventId: `seed-${seed}-step-${step}-${key}-${sequence}`,
    observedAtMs: seed * 1_000_000 + step * 100 + sequence,
    providerSessionId: `${key}-session`,
    sourceFrameUuid: `frame-${seed}-${step}-${sequence}`,
  };
}

function makeTurnBinding(
  random: () => number,
  turnId: string,
  step: number,
): TurnBinding {
  const binding: TurnBinding = {
    turnId,
    origin: choose(random, TURN_ORIGINS),
    binding: choose(random, TURN_BINDINGS),
    submissionIds: random() < 0.55 ? [`submission-${step}`] : [],
    userMessageIds: random() < 0.7 ? [`user-message-${step}`] : [],
    providerUserMessageUuids: random() < 0.6 ? [`provider-user-${step}`] : [],
    ...(random() < 0.45
      ? { providerOriginKind: `origin-kind-${step % 4}` }
      : {}),
    ...(random() < 0.35 ? { resultIndex: step % 5 } : {}),
    ...(random() < 0.25
      ? {
          spawnedBy: {
            ...(random() < 0.5 ? { taskId: `task-${step % 7}` } : {}),
            toolUseId: `tool-use-${step % 11}`,
          } satisfies SpawnedBy,
        }
      : {}),
  };
  return binding;
}

function makeTurnStarted(
  base: ProducerBase,
  binding: TurnBinding,
  phase: TurnStarted['phase'],
): TurnStarted {
  return {
    ...base,
    ...binding,
    type: 'TurnStarted',
    phase,
    startedAtMs: base.observedAtMs,
  };
}

function makeTurnEnded(
  random: () => number,
  base: ProducerBase,
  binding: TurnBinding,
): TurnEnded {
  return {
    ...base,
    ...binding,
    type: 'TurnEnded',
    endedAtMs: base.observedAtMs,
    outcome: choose(random, TURN_OUTCOMES),
    ...(random() < 0.45
      ? { terminalReason: `terminal-${Math.floor(random() * 5)}` }
      : {}),
    ...(random() < 0.6 ? { durationMs: Math.floor(random() * 50_000) } : {}),
    source: choose(random, TURN_END_SOURCES),
  };
}

function makeSessionState(
  random: () => number,
  base: ProducerBase,
  state: SessionState['state'],
  observedDuringTurnId?: string,
): SessionState {
  return {
    ...base,
    type: 'SessionState',
    state,
    ...(observedDuringTurnId === undefined ? {} : { observedDuringTurnId }),
    source: choose(random, SESSION_SOURCES),
  };
}

function makeBackgroundSet(
  base: ProducerBase,
  native: BackgroundSet['native'],
  managed: BackgroundSet['managed'],
  observedDuringTurnId?: string,
): BackgroundSet {
  return {
    ...base,
    type: 'BackgroundSet',
    semantics: 'replace',
    ...(observedDuringTurnId === undefined ? {} : { observedDuringTurnId }),
    native,
    managed,
  };
}

function makeRandomBackgroundSet(
  random: () => number,
  base: ProducerBase,
  step: number,
  observedDuringTurnId?: string,
): BackgroundSet {
  const native: BackgroundSet['native'] = [];
  const count = Math.floor(random() * 3);
  for (let index = 0; index < count; index += 1) {
    native.push({
      id: `native-${step}-${index}`,
      ...(random() < 0.6 ? { taskType: `task-type-${index % 4}` } : {}),
      ...(random() < 0.5 ? { toolUseId: `tool-${step}-${index}` } : {}),
      ...(random() < 0.5 ? { spawnedByTurnId: `turn-${step % 9}` } : {}),
    });
  }
  return makeBackgroundSet(
    base,
    native,
    {
      live: Math.floor(random() * 4),
      queued: Math.floor(random() * 4),
    },
    observedDuringTurnId,
  );
}

function getReferenceTurnId(
  random: () => number,
  activeTurnId: string | undefined,
  settledTurnIds: readonly string[],
): string {
  if (
    activeTurnId !== undefined &&
    (settledTurnIds.length === 0 || random() < 0.65)
  ) {
    return activeTurnId;
  }
  if (settledTurnIds.length > 0) {
    return choose(random, settledTurnIds);
  }
  return 'unmatched-turn';
}

function getObservedTurnId(
  random: () => number,
  activeTurnId: string | undefined,
  settledTurnIds: readonly string[],
): string | undefined {
  if (random() < 0.35 && activeTurnId !== undefined) {
    return activeTurnId;
  }
  if (random() < 0.55 && settledTurnIds.length > 0) {
    return choose(random, settledTurnIds);
  }
  return undefined;
}

function generateStream(seed: number): GeneratedStream {
  const random = mulberry32(seed);
  const events: ChatTurnLifecycleEvent[] = [];
  const sequences: Record<string, number> = {};
  const settledTurnIds: string[] = [];
  const bindings: Record<string, TurnBinding> = {};
  const scenario: ScenarioSteps = {
    firstTurnStarted: 0,
    decisionRequired: 0,
    backgroundStarted: 0,
    firstTurnBound: 0,
    supersedingTurnStarted: 0,
    supersededTurnEnded: 0,
    backgroundCleared: 0,
    settledTurnStarted: 0,
    settledDecisionRequired: 0,
    settledTurnEnded: 0,
    settledSessionReconnecting: 0,
    settledBackgroundCleared: 0,
  };
  const firstTurnId = `seed-${seed}-turn-first`;
  const supersedingTurnId = `seed-${seed}-turn-superseding`;
  const settledTurnId = `seed-${seed}-turn-settled`;
  const activeBackground: BackgroundSet = {
    version: 1,
    provider: 'codex',
    projectId: 'property-project',
    worktreeId: 'property-worktree',
    chatId: 'property-chat',
    processEpoch: CODEX_EPOCH_B.processEpoch,
    sequence: 2,
    eventId: `seed-${seed}-expected-background`,
    observedAtMs: seed * 1_000_000 + 2 * 100 + 2,
    providerSessionId: 'expected-background-session',
    sourceFrameUuid: `expected-background-frame-${seed}`,
    type: 'BackgroundSet',
    semantics: 'replace',
    observedDuringTurnId: firstTurnId,
    native: [{ id: `seed-${seed}-native-background`, taskType: 'delegate' }],
    managed: { live: 2, queued: 1 },
  };
  let activeTurnId: string | undefined;

  const append = (event: ChatTurnLifecycleEvent): number => {
    const step = events.length;
    events.push(event);
    return step;
  };

  const firstBinding = makeTurnBinding(random, firstTurnId, events.length);
  bindings[firstTurnId] = firstBinding;
  scenario.firstTurnStarted = append(
    makeTurnStarted(
      nextProducerBase(sequences, CLAUDE_EPOCH_A, seed, events.length),
      firstBinding,
      'start',
    ),
  );
  activeTurnId = firstTurnId;

  scenario.decisionRequired = append(
    makeSessionState(
      random,
      nextProducerBase(sequences, CODEX_EPOCH_A, seed, events.length),
      'requires_action',
      firstTurnId,
    ),
  );

  const backgroundStartBase = nextProducerBase(
    sequences,
    CODEX_EPOCH_B,
    seed,
    events.length,
  );
  const scenarioBackground = makeBackgroundSet(
    backgroundStartBase,
    activeBackground.native,
    activeBackground.managed,
    firstTurnId,
  );
  scenario.backgroundStarted = append(scenarioBackground);

  const updatedFirstBinding = makeTurnBinding(
    random,
    firstTurnId,
    events.length,
  );
  bindings[firstTurnId] = updatedFirstBinding;
  scenario.firstTurnBound = append(
    makeTurnStarted(
      nextProducerBase(sequences, CLAUDE_EPOCH_A, seed, events.length),
      updatedFirstBinding,
      'binding-update',
    ),
  );

  const supersedingBinding = makeTurnBinding(
    random,
    supersedingTurnId,
    events.length,
  );
  bindings[supersedingTurnId] = supersedingBinding;
  if (activeTurnId !== undefined) {
    settledTurnIds.push(activeTurnId);
  }
  scenario.supersedingTurnStarted = append(
    makeTurnStarted(
      nextProducerBase(sequences, CLAUDE_EPOCH_A, seed, events.length),
      supersedingBinding,
      'start',
    ),
  );
  activeTurnId = supersedingTurnId;

  scenario.supersededTurnEnded = append(
    makeTurnEnded(
      random,
      nextProducerBase(sequences, CLAUDE_EPOCH_A, seed, events.length),
      supersedingBinding,
    ),
  );
  activeTurnId = undefined;
  settledTurnIds.push(supersedingTurnId);

  append(
    makeSessionState(
      random,
      nextProducerBase(sequences, CODEX_EPOCH_A, seed, events.length),
      'idle',
    ),
  );
  scenario.backgroundCleared = append(
    makeBackgroundSet(
      nextProducerBase(sequences, CODEX_EPOCH_B, seed, events.length),
      [],
      { live: 0, queued: 0 },
    ),
  );

  const settledBinding = makeTurnBinding(random, settledTurnId, events.length);
  bindings[settledTurnId] = settledBinding;
  scenario.settledTurnStarted = append(
    makeTurnStarted(
      nextProducerBase(sequences, CLAUDE_EPOCH_A, seed, events.length),
      settledBinding,
      'start',
    ),
  );
  activeTurnId = settledTurnId;
  scenario.settledDecisionRequired = append(
    makeSessionState(
      random,
      nextProducerBase(sequences, CLAUDE_EPOCH_B, seed, events.length),
      'requires_action',
      settledTurnId,
    ),
  );
  scenario.settledTurnEnded = append(
    makeTurnEnded(
      random,
      nextProducerBase(sequences, CLAUDE_EPOCH_A, seed, events.length),
      settledBinding,
    ),
  );
  activeTurnId = undefined;
  settledTurnIds.push(settledTurnId);
  scenario.settledSessionReconnecting = append(
    makeSessionState(
      random,
      nextProducerBase(sequences, CODEX_EPOCH_A, seed, events.length),
      'reconnecting',
    ),
  );
  scenario.settledBackgroundCleared = append(
    makeBackgroundSet(
      nextProducerBase(sequences, CODEX_EPOCH_B, seed, events.length),
      [],
      { live: 0, queued: 0 },
    ),
  );

  while (events.length < GENERATED_EVENT_COUNT) {
    const step = events.length;
    const producer = choose(random, PRODUCER_SCOPES);
    const eventKind = Math.floor(random() * 6);
    const base = nextProducerBase(sequences, producer, seed, step);

    if (eventKind <= 1) {
      if (activeTurnId !== undefined) {
        settledTurnIds.push(activeTurnId);
      }
      const turnId = `seed-${seed}-turn-random-${step}`;
      const binding = makeTurnBinding(random, turnId, step);
      bindings[turnId] = binding;
      append(makeTurnStarted(base, binding, 'start'));
      activeTurnId = turnId;
      continue;
    }

    if (eventKind === 2) {
      const turnId = getReferenceTurnId(random, activeTurnId, settledTurnIds);
      let binding = bindings[turnId];
      if (binding === undefined) {
        binding = makeTurnBinding(random, turnId, step);
        bindings[turnId] = binding;
      }
      const updatedBinding = makeTurnBinding(random, turnId, step);
      bindings[turnId] = updatedBinding;
      append(makeTurnStarted(base, updatedBinding, 'binding-update'));
      continue;
    }

    if (eventKind === 3) {
      const turnId =
        activeTurnId !== undefined && random() < 0.72
          ? activeTurnId
          : getReferenceTurnId(random, activeTurnId, settledTurnIds);
      const endActive = activeTurnId !== undefined && turnId === activeTurnId;
      let binding = bindings[turnId];
      if (binding === undefined) {
        binding = makeTurnBinding(random, turnId, step);
        bindings[turnId] = binding;
      }
      append(makeTurnEnded(random, base, binding));
      if (endActive && turnId === activeTurnId) {
        activeTurnId = undefined;
        settledTurnIds.push(turnId);
      }
      continue;
    }

    if (eventKind === 4) {
      append(
        makeSessionState(
          random,
          base,
          choose(random, SESSION_STATES),
          getObservedTurnId(random, activeTurnId, settledTurnIds),
        ),
      );
      continue;
    }

    append(
      makeRandomBackgroundSet(
        random,
        base,
        step,
        getObservedTurnId(random, activeTurnId, settledTurnIds),
      ),
    );
  }

  return {
    events,
    sequences,
    scenario,
    firstTurnId,
    supersedingTurnId,
    settledTurnId,
    activeBackground: scenarioBackground,
  };
}

function makeHostPauseEvent(
  type: ChatTurnHostPauseEvent['type'],
  turnId: string,
  ownerKind: ChatTurnPauseOwnerKind,
  ownerId: string,
  atMs: number,
  hostSequence: number,
): ChatTurnHostPauseEvent {
  return { type, turnId, ownerKind, ownerId, atMs, hostSequence };
}

function providerEventTime(event: ChatTurnLifecycleEvent): number {
  switch (event.type) {
    case 'TurnStarted':
      return event.startedAtMs;
    case 'TurnEnded':
      return event.endedAtMs;
    case 'SessionState':
    case 'BackgroundSet':
      return event.observedAtMs;
  }
}

function generateMixedStream(
  seed: number,
  providerStream: GeneratedStream,
): GeneratedMixedStream {
  const random = mulberry32(seed ^ 0x7b19);
  const events: GeneratedMixedEvent[] = [];
  const scenario: MixedScenarioSteps = {
    firstOwnerOpened: 0,
    firstOwnerOverlap: 0,
    duplicateHostCounter: 0,
    staleHostCounter: 0,
    duplicateOwnerOpen: 0,
    wrongOwnerClose: 0,
    oneOwnerClosed: 0,
    allOwnersClosed: 0,
    pauseBeforeSupersession: 0,
    pausedSupersession: 0,
    wrongTurnHostEvent: 0,
    settledTurnHostEvent: 0,
    terminalPauseOpened: 0,
    pausedTerminalEnd: 0,
    randomHostSteps: [],
  };
  const firstStarted =
    providerStream.events[providerStream.scenario.firstTurnStarted];
  const supersedingStarted =
    providerStream.events[providerStream.scenario.supersedingTurnStarted];
  const supersedingEnded =
    providerStream.events[providerStream.scenario.supersededTurnEnded];
  if (firstStarted?.type !== 'TurnStarted') {
    throw new Error(`seed=${seed} first-turn start is missing`);
  }
  if (supersedingStarted?.type !== 'TurnStarted') {
    throw new Error(`seed=${seed} superseding-turn start is missing`);
  }
  if (supersedingEnded?.type !== 'TurnEnded') {
    throw new Error(`seed=${seed} superseding-turn end is missing`);
  }

  let hostSequence = 0;
  let activeTurnId: string | undefined;
  const settledTurnIds: string[] = [];
  let randomHostEventIndex = 0;
  const appendHost = (event: ChatTurnHostPauseEvent): number => {
    const step = events.length;
    events.push({ kind: 'host', event });
    return step;
  };
  const appendFixedHost = (
    type: ChatTurnHostPauseEvent['type'],
    turnId: string,
    ownerKind: ChatTurnPauseOwnerKind,
    ownerId: string,
    atMs: number,
    sequence: number,
  ): number => {
    hostSequence = Math.max(hostSequence, sequence);
    return appendHost(
      makeHostPauseEvent(type, turnId, ownerKind, ownerId, atMs, sequence),
    );
  };
  const addSettledTurn = (turnId: string): void => {
    if (!settledTurnIds.includes(turnId)) {
      settledTurnIds.push(turnId);
    }
  };
  const updateProviderTurnTracking = (event: ChatTurnLifecycleEvent): void => {
    if (event.type === 'TurnStarted' && event.phase !== 'binding-update') {
      if (activeTurnId !== undefined && activeTurnId !== event.turnId) {
        addSettledTurn(activeTurnId);
      }
      activeTurnId = event.turnId;
      return;
    }
    if (event.type === 'TurnEnded' && activeTurnId === event.turnId) {
      addSettledTurn(event.turnId);
      activeTurnId = undefined;
    }
  };
  const appendRandomHost = (
    providerIndex: number,
    providerEvent: ChatTurnLifecycleEvent,
  ): void => {
    hostSequence += 1;
    const chooseActive = activeTurnId !== undefined && random() < 0.55;
    const chooseSettled =
      !chooseActive && settledTurnIds.length > 0 && random() < 0.55;
    const invalidTurnId = `seed-${seed}-wrong-host-turn-${providerIndex}-${randomHostEventIndex}`;
    const turnId = chooseActive
      ? (activeTurnId ?? invalidTurnId)
      : chooseSettled
        ? (choose(random, settledTurnIds) ?? invalidTurnId)
        : invalidTurnId;
    const ownerKind = choose(random, ['approval', 'question'] as const);
    const type = choose(random, ['PauseOpened', 'PauseClosed'] as const);
    const ownerId = `random-owner-${seed}-${providerIndex}-${randomHostEventIndex}`;
    const atMs =
      providerEventTime(providerEvent) + Math.floor(random() * 2_001) - 1_000;
    const step = appendHost(
      makeHostPauseEvent(type, turnId, ownerKind, ownerId, atMs, hostSequence),
    );
    scenario.randomHostSteps.push(step);
    randomHostEventIndex += 1;
  };

  const firstStartedAtMs = firstStarted.startedAtMs;
  const supersedingEndedAtMs = supersedingEnded.endedAtMs;
  const randomStartIndex = providerStream.scenario.supersededTurnEnded;
  const randomEndIndex = providerStream.events.length - 2;
  const firstRandomIndex =
    randomStartIndex +
    Math.floor(random() * (randomEndIndex - randomStartIndex + 1));

  for (
    let providerIndex = 0;
    providerIndex < providerStream.events.length;
    providerIndex += 1
  ) {
    const providerEvent = providerStream.events[providerIndex];
    if (providerEvent === undefined) {
      throw new Error(
        `seed=${seed} step=${providerIndex} provider event is missing`,
      );
    }
    const providerStep = events.length;
    events.push({ kind: 'provider', event: providerEvent });
    if (providerIndex === providerStream.scenario.supersedingTurnStarted) {
      scenario.pausedSupersession = providerStep;
    }
    if (providerIndex === providerStream.scenario.supersededTurnEnded) {
      scenario.pausedTerminalEnd = providerStep;
    }
    updateProviderTurnTracking(providerEvent);

    if (providerIndex === providerStream.scenario.firstTurnStarted) {
      scenario.firstOwnerOpened = appendFixedHost(
        'PauseOpened',
        firstStarted.turnId,
        'approval',
        `approval-${seed}-overlap-a`,
        firstStartedAtMs + 10,
        1,
      );
      scenario.firstOwnerOverlap = appendFixedHost(
        'PauseOpened',
        firstStarted.turnId,
        'question',
        `question-${seed}-overlap-b`,
        firstStartedAtMs + 20,
        2,
      );
      scenario.duplicateHostCounter = appendFixedHost(
        'PauseClosed',
        firstStarted.turnId,
        'approval',
        `approval-${seed}-overlap-a`,
        firstStartedAtMs + 30,
        2,
      );
      scenario.staleHostCounter = appendFixedHost(
        'PauseClosed',
        firstStarted.turnId,
        'approval',
        `approval-${seed}-overlap-a`,
        firstStartedAtMs + 40,
        1,
      );
      scenario.duplicateOwnerOpen = appendFixedHost(
        'PauseOpened',
        firstStarted.turnId,
        'approval',
        `approval-${seed}-overlap-a`,
        firstStartedAtMs + 50,
        3,
      );
      scenario.wrongOwnerClose = appendFixedHost(
        'PauseClosed',
        firstStarted.turnId,
        'approval',
        `approval-${seed}-unmatched`,
        firstStartedAtMs + 60,
        4,
      );
      scenario.oneOwnerClosed = appendFixedHost(
        'PauseClosed',
        firstStarted.turnId,
        'approval',
        `approval-${seed}-overlap-a`,
        firstStartedAtMs + 70,
        5,
      );
      scenario.allOwnersClosed = appendFixedHost(
        'PauseClosed',
        firstStarted.turnId,
        'question',
        `question-${seed}-overlap-b`,
        firstStartedAtMs + 80,
        6,
      );
      scenario.pauseBeforeSupersession = appendFixedHost(
        'PauseOpened',
        firstStarted.turnId,
        'approval',
        `approval-${seed}-supersession`,
        firstStartedAtMs + 90,
        7,
      );
    }

    if (providerIndex === providerStream.scenario.supersedingTurnStarted) {
      scenario.wrongTurnHostEvent = appendFixedHost(
        'PauseOpened',
        'wrong-host-turn',
        'question',
        `question-${seed}-wrong-turn`,
        supersedingStarted.startedAtMs,
        8,
      );
      scenario.settledTurnHostEvent = appendFixedHost(
        'PauseOpened',
        firstStarted.turnId,
        'approval',
        `approval-${seed}-settled-turn`,
        supersedingStarted.startedAtMs + 1,
        9,
      );
      scenario.terminalPauseOpened = appendFixedHost(
        'PauseOpened',
        supersedingStarted.turnId,
        'question',
        `question-${seed}-terminal-end`,
        supersedingEndedAtMs - 1,
        10,
      );
    }

    if (
      providerIndex >= randomStartIndex &&
      (providerIndex === firstRandomIndex || random() < 0.12)
    ) {
      appendRandomHost(providerIndex, providerEvent);
    }
  }

  return { events, scenario };
}

function reduceStream(
  seed: number,
  events: readonly ChatTurnLifecycleEvent[],
  initialState: ChatTurnState = initialChatTurnState(),
  afterStep?: (state: ChatTurnState, step: number) => void,
): ReductionResult {
  let state = initialState;
  const effects: ChatTurnEffect[] = [];
  assertChatTurnStateInvariants(seed, 0, state);
  checkHydrationRoundTrip(seed, 0, state, 'initial provider state hydrates');
  for (let step = 0; step < events.length; step += 1) {
    const event = events[step];
    if (event === undefined) {
      throw new Error(`seed=${seed} step=${step} generated event is missing`);
    }
    const priorState = state;
    const result = reduceChatTurn(priorState, event);
    assertAt(
      seed,
      step,
      'chat.idle effects only accompany an idle phase',
      () => {
        if (result.effects.some((effect) => effect.type === 'chat.idle')) {
          expect(result.state.phase).toBe('idle');
        }
      },
    );
    if (
      event.type === 'SessionState' &&
      (event.state === 'idle' || event.state === 'reconnecting')
    ) {
      assertAt(
        seed,
        step,
        `${event.state} session state is cursor-only`,
        () => {
          expect(withoutCursors(result.state)).toEqual(
            withoutCursors(priorState),
          );
          expect(
            advancesExactlyOneCursor(priorState.cursors, result.state.cursors),
          ).toBe(true);
          expect(result.effects).toEqual([]);
        },
      );
    }
    state = result.state;
    effects.push(...result.effects);
    assertAt(seed, step, 'foreground/current invariant', () => {
      expect(state.phase === 'foreground').toBe(state.current !== undefined);
    });
    assertChatTurnStateInvariants(seed, step, state);
    checkHydrationRoundTrip(seed, step, state, 'provider state hydrates');
    if (afterStep !== undefined) {
      afterStep(state, step);
    }
  }
  return { state, effects };
}

function openPauseCount(record: ChatTurnRecord | undefined): number {
  return (
    record?.pauses.filter((pause) => pause.endedAtMs === undefined).length ?? 0
  );
}

function assertChatTurnStateInvariants(
  seed: number,
  step: number,
  state: ChatTurnState,
): void {
  assertAt(seed, step, 'at most one open pause per owner', () => {
    for (const record of [state.current, state.lastEnded]) {
      if (record === undefined) {
        continue;
      }
      const openOwnerIds: Record<ChatTurnPauseOwnerKind, Set<string>> = {
        approval: new Set<string>(),
        question: new Set<string>(),
      };
      for (const pause of record.pauses) {
        if (pause.endedAtMs === undefined) {
          const ownerIds = openOwnerIds[pause.ownerKind];
          expect(ownerIds.has(pause.ownerId)).toBe(false);
          ownerIds.add(pause.ownerId);
        } else {
          expect(pause.endedAtMs).toBeGreaterThanOrEqual(pause.startedAtMs);
        }
      }
    }
  });
  assertAt(seed, step, 'settled last-ended turn has no open pause', () => {
    expect(openPauseCount(state.lastEnded)).toBe(0);
  });
}

function checkHydrationRoundTrip(
  seed: number,
  step: number,
  state: ChatTurnState,
  description: string,
): void {
  const hydrated = hydrateChatTurnState(serializeChatTurnState(state));
  assertAt(seed, step, description, () => {
    expect(hydrated).toEqual({ ...withoutCursors(state), cursors: {} });
  });
  const restartAtMs = (state.current?.startedAtMs ?? 0) + step;
  const restarted = settleChatTurnForRestart(state, restartAtMs);
  assertAt(seed, step, 'restart-settled reachable state hydrates', () => {
    expect(
      hydrateChatTurnState(serializeChatTurnState(restarted.state)),
    ).toEqual({
      ...withoutCursors(restarted.state),
      cursors: {},
    });
    expect(restarted.state.current).toBeUndefined();
    expect(openPauseCount(restarted.state.lastEnded)).toBe(0);
    expect(
      restarted.effects.some((effect) => effect.type === 'timer.resume'),
    ).toBe(false);
  });
}

function providerCursors(
  cursors: Record<string, number>,
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [scope, sequence] of Object.entries(cursors)) {
    if (scope !== 'host') {
      result[scope] = sequence;
    }
  }
  return result;
}

function reduceMixedStream(
  seed: number,
  events: readonly GeneratedMixedEvent[],
  initialState: ChatTurnState = initialChatTurnState(),
  afterStep?: (
    state: ChatTurnState,
    previousState: ChatTurnState,
    result: ReductionResult,
    event: GeneratedMixedEvent,
    step: number,
  ) => void,
): ReductionResult {
  let state = initialState;
  const effects: ChatTurnEffect[] = [];
  const nextTimerTransition = new Map<string, 'timer.pause' | 'timer.resume'>();

  checkHydrationRoundTrip(seed, 0, state, 'initial mixed state hydrates');
  for (let step = 0; step < events.length; step += 1) {
    const event = events[step];
    if (event === undefined) {
      throw new Error(
        `seed=${seed} step=${step} generated mixed event is missing`,
      );
    }
    const previousState = state;
    let result: ReductionResult;
    if (event.kind === 'provider') {
      result = reduceChatTurn(previousState, event.event);
      assertAt(seed, step, 'provider event preserves host cursor', () => {
        expect(result.state.cursors.host).toBe(previousState.cursors.host);
      });
    } else {
      const previousHostSequence = previousState.cursors.host;
      result = reduceChatTurnHostEvent(previousState, event.event);
      assertAt(
        seed,
        step,
        'host event leaves provider cursors independent',
        () => {
          expect(providerCursors(result.state.cursors)).toEqual(
            providerCursors(previousState.cursors),
          );
        },
      );
      if (
        previousHostSequence !== undefined &&
        event.event.hostSequence <= previousHostSequence
      ) {
        assertAt(
          seed,
          step,
          'stale or duplicate host counter is fenced',
          () => {
            expect(result.state).toBe(previousState);
            expect(result.effects).toEqual([]);
          },
        );
      }
    }

    assertAt(
      seed,
      step,
      'chat.idle effects only accompany an idle phase',
      () => {
        if (result.effects.some((effect) => effect.type === 'chat.idle')) {
          expect(result.state.phase).toBe('idle');
        }
      },
    );
    for (const effect of result.effects) {
      if (effect.type === 'timer.pause' || effect.type === 'timer.resume') {
        const expectedTransition =
          nextTimerTransition.get(effect.turnId) ?? 'timer.pause';
        assertAt(
          seed,
          step,
          'timer pause and resume strictly alternate',
          () => {
            expect(effect.type).toBe(expectedTransition);
          },
        );
        nextTimerTransition.set(
          effect.turnId,
          effect.type === 'timer.pause' ? 'timer.resume' : 'timer.pause',
        );
      }
      if (effect.type === 'timer.close') {
        const ended = result.state.lastEnded;
        const finalizedTurn = previousState.current;
        if (ended === undefined || finalizedTurn === undefined) {
          throw new Error(
            `seed=${seed} step=${step} timer.close has no finalized turn`,
          );
        }
        const suppliedDurationMs =
          event.kind === 'provider' &&
          event.event.type === 'TurnEnded' &&
          event.event.turnId === finalizedTurn.id
            ? event.event.durationMs
            : undefined;
        assertAt(seed, step, 'finalized duration respects its source', () => {
          expect(ended.id).toBe(finalizedTurn.id);
          expect(ended.endedAtMs).toBe(effect.atMs);
          if (suppliedDurationMs !== undefined) {
            // A supplied duration is wall time, netted of the turn's pauses.
            expect(ended.durationMs).toBe(
              Math.max(
                0,
                suppliedDurationMs -
                  expectedPausedMs(finalizedTurn, effect.atMs),
              ),
            );
          } else {
            expect(ended.durationMs).toBeGreaterThanOrEqual(0);
            expect(ended.durationMs).toBeLessThanOrEqual(
              Math.max(0, effect.atMs - finalizedTurn.startedAtMs),
            );
          }
        });
      }
    }

    state = result.state;
    effects.push(...result.effects);
    assertAt(seed, step, 'foreground/current invariant', () => {
      expect(state.phase === 'foreground').toBe(state.current !== undefined);
    });
    assertChatTurnStateInvariants(seed, step, state);
    checkHydrationRoundTrip(seed, step, state, 'mixed state hydrates');
    if (afterStep !== undefined) {
      afterStep(state, previousState, result, event, step);
    }
  }
  return { state, effects };
}

function checkScenarioStep(
  seed: number,
  stream: GeneratedStream,
  state: ChatTurnState,
  step: number,
): void {
  const scenario = stream.scenario;
  if (step === scenario.firstTurnStarted) {
    assertAt(seed, step, 'new start opens the first foreground turn', () => {
      expect(state.current?.id).toBe(stream.firstTurnId);
      expect(state.phase).toBe('foreground');
    });
  }
  if (step === scenario.decisionRequired) {
    assertAt(seed, step, 'requires_action records a pending decision', () => {
      expect(state.decisionPending).toBe(true);
    });
  }
  if (step === scenario.backgroundStarted) {
    assertAt(
      seed,
      step,
      'background snapshot is applied during a foreground turn',
      () => {
        expect(state.background.native).toEqual(stream.activeBackground.native);
        expect(state.background.managed).toEqual(
          stream.activeBackground.managed,
        );
        expect(state.current?.id).toBe(stream.firstTurnId);
        expect(state.phase).toBe('foreground');
      },
    );
  }
  if (step === scenario.firstTurnBound) {
    assertAt(
      seed,
      step,
      'binding update does not replace the open turn',
      () => {
        expect(state.current?.id).toBe(stream.firstTurnId);
        expect(state.phase).toBe('foreground');
      },
    );
  }
  if (step === scenario.supersedingTurnStarted) {
    assertAt(seed, step, 'a new start supersedes the prior open turn', () => {
      expect(state.current?.id).toBe(stream.supersedingTurnId);
      expect(state.phase).toBe('foreground');
    });
  }
  if (step === scenario.supersededTurnEnded) {
    assertAt(seed, step, 'terminal end closes the current turn', () => {
      expect(state.current).toBeUndefined();
      expect(state.endedTurnIds).toContain(stream.supersedingTurnId);
      expect(state.lastEnded?.id).toBe(stream.supersedingTurnId);
    });
  }
  if (step === scenario.backgroundCleared) {
    assertAt(
      seed,
      step,
      'empty background snapshot clears background work',
      () => {
        expect(state.background).toEqual({
          native: [],
          managed: { live: 0, queued: 0 },
        });
        expect(state.phase).toBe('idle');
      },
    );
  }
  if (step === scenario.settledTurnStarted) {
    assertAt(
      seed,
      step,
      'a fresh turn can open after prior terminal closure',
      () => {
        expect(state.current?.id).toBe(stream.settledTurnId);
        expect(state.phase).toBe('foreground');
      },
    );
  }
  if (step === scenario.settledDecisionRequired) {
    assertAt(
      seed,
      step,
      'decision state is exercised on a second open turn',
      () => {
        expect(state.decisionPending).toBe(true);
      },
    );
  }
  if (step === scenario.settledTurnEnded) {
    assertAt(seed, step, 'settled probe target is terminally closed', () => {
      expect(state.current).toBeUndefined();
      expect(state.endedTurnIds).toContain(stream.settledTurnId);
      expect(state.lastEnded?.id).toBe(stream.settledTurnId);
    });
  }
  if (step === scenario.settledBackgroundCleared) {
    assertAt(
      seed,
      step,
      'generated prefix ends with no background work',
      () => {
        expect(state.background).toEqual({
          native: [],
          managed: { live: 0, queued: 0 },
        });
        expect(state.phase).toBe('idle');
      },
    );
  }
}

function checkGeneratedCoverage(seed: number, stream: GeneratedStream): void {
  const eventTypes = new Set(stream.events.map((event) => event.type));
  const producerScopes = new Set(stream.events.map(eventProducerKey));
  const hasStartPhase = stream.events.some(
    (event) => event.type === 'TurnStarted' && event.phase === 'start',
  );
  const hasBindingUpdate = stream.events.some(
    (event) => event.type === 'TurnStarted' && event.phase === 'binding-update',
  );
  const hasNonEmptyBackground = stream.events.some(
    (event) =>
      event.type === 'BackgroundSet' &&
      (event.native.length > 0 ||
        event.managed.live > 0 ||
        event.managed.queued > 0),
  );
  const hasEmptyBackground = stream.events.some(
    (event) =>
      event.type === 'BackgroundSet' &&
      event.native.length === 0 &&
      event.managed.live === 0 &&
      event.managed.queued === 0,
  );
  const hasDecisionState = stream.events.some(
    (event) =>
      event.type === 'SessionState' && event.state === 'requires_action',
  );
  const hasIdleState = stream.events.some(
    (event) => event.type === 'SessionState' && event.state === 'idle',
  );
  const hasReconnectingState = stream.events.some(
    (event) => event.type === 'SessionState' && event.state === 'reconnecting',
  );

  assertAt(
    seed,
    0,
    'seeded generator exercises lifecycle variants and producer scopes',
    () => {
      expect(stream.events.length).toBe(GENERATED_EVENT_COUNT);
      expect(eventTypes).toEqual(
        new Set(['TurnStarted', 'TurnEnded', 'SessionState', 'BackgroundSet']),
      );
      expect(producerScopes.size).toBeGreaterThanOrEqual(4);
      expect(hasStartPhase).toBe(true);
      expect(hasBindingUpdate).toBe(true);
      expect(hasNonEmptyBackground).toBe(true);
      expect(hasEmptyBackground).toBe(true);
      expect(hasDecisionState).toBe(true);
      expect(hasIdleState).toBe(true);
      expect(hasReconnectingState).toBe(true);
    },
  );
}

function checkMixedGeneratedCoverage(
  seed: number,
  providerStream: GeneratedStream,
  mixedStream: GeneratedMixedStream,
): void {
  const providerEvents = mixedStream.events.flatMap((event) =>
    event.kind === 'provider' ? [event.event] : [],
  );
  const hostEvents = mixedStream.events
    .filter(
      (event): event is Extract<GeneratedMixedEvent, { kind: 'host' }> =>
        event.kind === 'host',
    )
    .map((event) => event.event);
  const hostEventTypes = new Set(hostEvents.map((event) => event.type));
  const hostOwnerKinds = new Set(hostEvents.map((event) => event.ownerKind));
  const duplicateCounterEvent =
    mixedStream.events[mixedStream.scenario.duplicateHostCounter];
  const staleCounterEvent =
    mixedStream.events[mixedStream.scenario.staleHostCounter];
  const hasInterleavedHostEvent = mixedStream.events.some(
    (event, index) =>
      event.kind === 'host' &&
      index > 0 &&
      mixedStream.events[index - 1]?.kind === 'provider',
  );

  assertAt(
    seed,
    0,
    'mixed generator preserves provider coverage and adds host events',
    () => {
      expect(providerEvents).toEqual(providerStream.events);
      expect(hostEvents.length).toBeGreaterThan(0);
      expect(mixedStream.events.length).toBeGreaterThan(
        providerStream.events.length,
      );
      expect(mixedStream.scenario.randomHostSteps.length).toBeGreaterThan(0);
      expect(hasInterleavedHostEvent).toBe(true);
      expect(hostEventTypes).toEqual(new Set(['PauseOpened', 'PauseClosed']));
      expect(hostOwnerKinds).toEqual(new Set(['approval', 'question']));
      expect(
        duplicateCounterEvent?.kind === 'host'
          ? duplicateCounterEvent.event.hostSequence
          : undefined,
      ).toBe(2);
      expect(
        staleCounterEvent?.kind === 'host'
          ? staleCounterEvent.event.hostSequence
          : undefined,
      ).toBe(1);
    },
  );
}

function checkMixedScenarioStep(
  seed: number,
  providerStream: GeneratedStream,
  mixedStream: GeneratedMixedStream,
  state: ChatTurnState,
  previousState: ChatTurnState,
  result: ReductionResult,
  event: GeneratedMixedEvent,
  step: number,
): void {
  const scenario = mixedStream.scenario;
  const firstTurnId = providerStream.firstTurnId;
  const supersedingTurnId = providerStream.supersedingTurnId;
  if (step === scenario.firstOwnerOpened) {
    assertAt(seed, step, 'first host owner pauses active timer', () => {
      expect(state.current?.id).toBe(firstTurnId);
      expect(openPauseCount(state.current)).toBe(1);
      expect(result.effects).toContainEqual(
        expect.objectContaining({ type: 'timer.pause', turnId: firstTurnId }),
      );
    });
  }
  if (step === scenario.firstOwnerOverlap) {
    assertAt(seed, step, 'host owners overlap on one active turn', () => {
      expect(state.current?.id).toBe(firstTurnId);
      expect(openPauseCount(state.current)).toBe(2);
      expect(
        new Set(
          state.current?.pauses
            .filter((pause) => pause.endedAtMs === undefined)
            .map((pause) => pause.ownerKind),
        ),
      ).toEqual(new Set(['approval', 'question']));
      expect(result.effects).toEqual([]);
    });
  }
  if (step === scenario.duplicateHostCounter) {
    assertAt(seed, step, 'duplicate host counter is ignored', () => {
      expect(event.kind).toBe('host');
      expect(result.state).toBe(previousState);
      expect(result.effects).toEqual([]);
    });
  }
  if (step === scenario.staleHostCounter) {
    assertAt(seed, step, 'stale host counter is ignored', () => {
      expect(event.kind).toBe('host');
      expect(result.state).toBe(previousState);
      expect(result.effects).toEqual([]);
    });
  }
  if (step === scenario.duplicateOwnerOpen) {
    assertAt(
      seed,
      step,
      'duplicate open for an owner does not duplicate interval',
      () => {
        expect(state.current?.pauses).toHaveLength(2);
        expect(openPauseCount(state.current)).toBe(2);
        expect(result.effects).toEqual([]);
      },
    );
  }
  if (step === scenario.wrongOwnerClose) {
    assertAt(
      seed,
      step,
      'close for unknown owner leaves other owners open',
      () => {
        expect(openPauseCount(state.current)).toBe(2);
        expect(result.effects).toEqual([]);
      },
    );
  }
  if (step === scenario.oneOwnerClosed) {
    assertAt(
      seed,
      step,
      'closing one overlapping owner keeps timer paused',
      () => {
        expect(openPauseCount(state.current)).toBe(1);
        expect(
          result.effects.some((effect) => effect.type === 'timer.resume'),
        ).toBe(false);
      },
    );
  }
  if (step === scenario.allOwnersClosed) {
    assertAt(seed, step, 'closing last owner resumes timer', () => {
      expect(openPauseCount(state.current)).toBe(0);
      expect(result.effects).toContainEqual(
        expect.objectContaining({ type: 'timer.resume', turnId: firstTurnId }),
      );
    });
  }
  if (step === scenario.pauseBeforeSupersession) {
    assertAt(seed, step, 'first turn is paused before supersession', () => {
      expect(state.current?.id).toBe(firstTurnId);
      expect(openPauseCount(state.current)).toBe(1);
      expect(result.effects).toContainEqual(
        expect.objectContaining({ type: 'timer.pause', turnId: firstTurnId }),
      );
    });
  }
  if (step === scenario.pausedSupersession) {
    assertAt(seed, step, 'supersession finalizes a paused turn', () => {
      expect(previousState.current?.id).toBe(firstTurnId);
      expect(openPauseCount(previousState.current)).toBe(1);
      expect(state.current?.id).toBe(supersedingTurnId);
      expect(state.lastEnded?.id).toBe(firstTurnId);
      expect(openPauseCount(state.lastEnded)).toBe(0);
      expect(result.effects).toContainEqual(
        expect.objectContaining({ type: 'timer.close', turnId: firstTurnId }),
      );
    });
  }
  if (
    step === scenario.wrongTurnHostEvent ||
    step === scenario.settledTurnHostEvent
  ) {
    assertAt(seed, step, 'wrong or settled host turn id is ignored', () => {
      expect(event.kind).toBe('host');
      expect(withoutCursors(state)).toEqual(withoutCursors(previousState));
      expect(result.effects).toEqual([]);
    });
  }
  if (step === scenario.terminalPauseOpened) {
    assertAt(
      seed,
      step,
      'terminal target is paused before provider end',
      () => {
        expect(state.current?.id).toBe(supersedingTurnId);
        expect(openPauseCount(state.current)).toBe(1);
        expect(result.effects).toContainEqual(
          expect.objectContaining({
            type: 'timer.pause',
            turnId: supersedingTurnId,
          }),
        );
      },
    );
  }
  if (step === scenario.pausedTerminalEnd) {
    assertAt(
      seed,
      step,
      'terminal end closes a paused turn without resume',
      () => {
        expect(previousState.current?.id).toBe(supersedingTurnId);
        expect(openPauseCount(previousState.current)).toBe(1);
        expect(state.current).toBeUndefined();
        expect(state.lastEnded?.id).toBe(supersedingTurnId);
        expect(openPauseCount(state.lastEnded)).toBe(0);
        expect(
          result.effects.some((effect) => effect.type === 'timer.resume'),
        ).toBe(false);
        expect(result.effects).toContainEqual(
          expect.objectContaining({
            type: 'timer.close',
            turnId: supersedingTurnId,
          }),
        );
      },
    );
  }
}

function stateToJson(state: ChatTurnState): string {
  const serialized = JSON.stringify(state);
  if (serialized === undefined) {
    throw new Error('ChatTurnState did not serialize to JSON');
  }
  return serialized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isTurnOrigin(value: unknown): value is TurnOrigin {
  return (
    value === 'user' ||
    value === 'steer' ||
    value === 'autonomous' ||
    value === 'restart'
  );
}

function isChatTurnOutcome(value: unknown): value is ChatTurnOutcome {
  return value === 'completed' || value === 'cancelled' || value === 'failed';
}

function isPauseOwnerKind(value: unknown): value is ChatTurnPauseOwnerKind {
  return value === 'approval' || value === 'question';
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((entry: unknown) => typeof entry === 'string')
  );
}

function isSpawnedBy(value: unknown): value is SpawnedBy {
  return (
    isRecord(value) &&
    (value.taskId === undefined || typeof value.taskId === 'string') &&
    (value.toolUseId === undefined || typeof value.toolUseId === 'string')
  );
}

function isTurnPause(value: unknown): value is ChatTurnPause {
  return (
    isRecord(value) &&
    isPauseOwnerKind(value.ownerKind) &&
    typeof value.ownerId === 'string' &&
    isFiniteNumber(value.startedAtMs) &&
    (value.endedAtMs === undefined || isFiniteNumber(value.endedAtMs))
  );
}

function isChatTurnRecord(value: unknown): value is ChatTurnRecord {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    isTurnOrigin(value.origin) &&
    isFiniteNumber(value.startedAtMs) &&
    Array.isArray(value.pauses) &&
    value.pauses.every((pause: unknown) => isTurnPause(pause)) &&
    (value.userMessageId === undefined ||
      typeof value.userMessageId === 'string') &&
    (value.spawnedBy === undefined || isSpawnedBy(value.spawnedBy)) &&
    (value.endedAtMs === undefined || isFiniteNumber(value.endedAtMs)) &&
    (value.outcome === undefined || isChatTurnOutcome(value.outcome)) &&
    (value.durationMs === undefined || isFiniteNumber(value.durationMs)) &&
    (value.terminalReason === undefined ||
      typeof value.terminalReason === 'string')
  );
}

function isBackgroundSet(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !Array.isArray(value.native) ||
    !isRecord(value.managed)
  ) {
    return false;
  }
  return (
    value.native.every(
      (entry: unknown) =>
        isRecord(entry) &&
        typeof entry.id === 'string' &&
        (entry.taskType === undefined || typeof entry.taskType === 'string') &&
        (entry.toolUseId === undefined ||
          typeof entry.toolUseId === 'string') &&
        (entry.spawnedByTurnId === undefined ||
          typeof entry.spawnedByTurnId === 'string'),
    ) &&
    isFiniteNumber(value.managed.live) &&
    isFiniteNumber(value.managed.queued)
  );
}

function isChatTurnPhase(value: unknown): value is ChatTurnPhase {
  return value === 'foreground' || value === 'background' || value === 'idle';
}

function isChatTurnState(value: unknown): value is ChatTurnState {
  if (
    !isRecord(value) ||
    !isChatTurnPhase(value.phase) ||
    typeof value.decisionPending !== 'boolean' ||
    typeof value.catchingUp !== 'boolean' ||
    !isStringArray(value.endedTurnIds) ||
    !isBackgroundSet(value.background) ||
    !isRecord(value.cursors)
  ) {
    return false;
  }
  return (
    (value.current === undefined || isChatTurnRecord(value.current)) &&
    (value.lastEnded === undefined || isChatTurnRecord(value.lastEnded)) &&
    Object.values(value.cursors).every(isFiniteNumber)
  );
}

function stateFromJson(serialized: string): ChatTurnState {
  const parsed: unknown = JSON.parse(serialized);
  if (!isChatTurnState(parsed)) {
    throw new Error('JSON round trip did not preserve a valid ChatTurnState');
  }
  return parsed;
}

function withoutCursors(state: ChatTurnState): Omit<ChatTurnState, 'cursors'> {
  const { cursors, ...stateWithoutCursors } = state;
  void cursors;
  return stateWithoutCursors;
}

function advancesExactlyOneCursor(
  before: Record<string, number>,
  after: Record<string, number>,
): boolean {
  const beforeCursors = new Map<string, number>(Object.entries(before));
  const afterCursors = new Map<string, number>(Object.entries(after));
  const keys = new Set<string>([
    ...Array.from(beforeCursors.keys()),
    ...Array.from(afterCursors.keys()),
  ]);
  let advancedCount = 0;
  let invalidAdvance = false;
  keys.forEach((key: string) => {
    const previous = beforeCursors.get(key) ?? 0;
    const next = afterCursors.get(key) ?? 0;
    if (previous !== next) {
      if (next <= previous) {
        invalidAdvance = true;
        return;
      }
      advancedCount += 1;
    }
  });
  return !invalidAdvance && advancedCount === 1;
}

function assertIgnoredReplay(
  seed: number,
  step: number,
  state: ChatTurnState,
  event: ChatTurnLifecycleEvent,
  description: string,
): void {
  const stateJsonBeforeReplay = stateToJson(state);
  const replay = reduceChatTurn(state, event);
  assertAt(seed, step, description, () => {
    expect(replay.state).toBe(state);
    expect(stateToJson(replay.state)).toBe(stateJsonBeforeReplay);
    expect(replay.effects).toEqual([]);
  });
}

function checkDuplicateAndStaleFences(
  seed: number,
  events: readonly ChatTurnLifecycleEvent[],
): void {
  let state = initialChatTurnState();
  const historyByProducer: Record<string, ChatTurnLifecycleEvent[]> = {};

  for (let step = 0; step < events.length; step += 1) {
    const event = events[step];
    if (event === undefined) {
      throw new Error(`seed=${seed} step=${step} generated event is missing`);
    }
    state = reduceChatTurn(state, event).state;
    assertIgnoredReplay(seed, step, state, event, 'duplicate event is fenced');

    const key = eventProducerKey(event);
    const priorEvents = historyByProducer[key];
    if (priorEvents !== undefined && priorEvents.length > 0) {
      const staleEvent = priorEvents[priorEvents.length - 1];
      if (staleEvent === undefined) {
        throw new Error(
          `seed=${seed} step=${step} prior producer event is missing`,
        );
      }
      assertIgnoredReplay(
        seed,
        step,
        state,
        staleEvent,
        'stale producer event is fenced',
      );
      priorEvents.push(event);
    } else {
      historyByProducer[key] = [event];
    }
  }
}

function createSettledProbes(
  seed: number,
  stream: GeneratedStream,
  settledId: string,
): SettledProbe[] {
  const random = mulberry32(seed ^ 0x4a17);
  const firstScope = CLAUDE_EPOCH_A;
  const secondScope = CODEX_EPOCH_A;
  const thirdScope = CODEX_EPOCH_B;
  const probes: SettledProbe[] = [];
  const nextBase = (producer: ProducerScope, offset: number): ProducerBase =>
    nextProducerBase(
      stream.sequences,
      producer,
      seed,
      GENERATED_EVENT_COUNT + offset,
    );

  probes.push({
    name: 'fresh start for settled id',
    event: makeTurnStarted(
      nextBase(firstScope, 0),
      makeTurnBinding(random, settledId, GENERATED_EVENT_COUNT),
      'start',
    ),
  });
  probes.push({
    name: 'fresh binding update for settled id',
    event: makeTurnStarted(
      nextBase(firstScope, 1),
      makeTurnBinding(random, settledId, GENERATED_EVENT_COUNT + 1),
      'binding-update',
    ),
  });
  probes.push({
    name: 'fresh end for settled id',
    event: makeTurnEnded(
      random,
      nextBase(firstScope, 2),
      makeTurnBinding(random, settledId, GENERATED_EVENT_COUNT + 2),
    ),
  });
  probes.push({
    name: 'session state observed during settled id',
    event: makeSessionState(
      random,
      nextBase(secondScope, 3),
      'requires_action',
      settledId,
    ),
  });
  probes.push({
    name: 'background snapshot still applies when correlated with settled id',
    event: makeBackgroundSet(
      nextBase(thirdScope, 4),
      [{ id: `settled-probe-${seed}-native`, taskType: 'current-work' }],
      { live: 1, queued: 2 },
      settledId,
    ),
  });
  return probes;
}

function checkSettledTurnFences(
  seed: number,
  stream: GeneratedStream,
  initialState: ChatTurnState,
): void {
  let state = initialState;
  const settledId = state.endedTurnIds[state.endedTurnIds.length - 1];
  if (settledId === undefined) {
    throw new Error(
      `seed=${seed} step=${GENERATED_EVENT_COUNT} no retained settled turn`,
    );
  }
  if (state.current?.id === settledId) {
    throw new Error(
      `seed=${seed} step=${GENERATED_EVENT_COUNT} retained turn is current`,
    );
  }
  const probes = createSettledProbes(seed, stream, settledId);
  for (let index = 0; index < probes.length; index += 1) {
    const probe = probes[index];
    if (probe === undefined) {
      throw new Error(`seed=${seed} step=${index} settled probe is missing`);
    }
    const before = state;
    const result = reduceChatTurn(before, probe.event);
    assertAt(seed, GENERATED_EVENT_COUNT + index, probe.name, () => {
      expect(result.state.cursors).not.toEqual(before.cursors);
      expect(
        advancesExactlyOneCursor(before.cursors, result.state.cursors),
      ).toBe(true);
      if (probe.event.type === 'BackgroundSet') {
        expect(result.state.background).toEqual({
          native: probe.event.native,
          managed: probe.event.managed,
        });
        expect(result.state.phase).toBe(
          before.current === undefined ? 'background' : 'foreground',
        );
        expect(withoutCursors(result.state)).toEqual({
          ...withoutCursors(before),
          background: {
            native: probe.event.native,
            managed: probe.event.managed,
          },
          phase: before.current === undefined ? 'background' : 'foreground',
        });
      } else {
        expect(withoutCursors(result.state)).toEqual(withoutCursors(before));
      }
      expect(result.effects).toEqual([]);
    });
    state = result.state;
  }
}

function checkWholeStreamReplay(
  seed: number,
  events: readonly ChatTurnLifecycleEvent[],
  original: ReductionResult,
): void {
  const originalJson = stateToJson(original.state);
  let state = original.state;
  const replayEffects: ChatTurnEffect[] = [];
  for (let step = 0; step < events.length; step += 1) {
    const event = events[step];
    if (event === undefined) {
      throw new Error(
        `seed=${seed} step=${step} generated replay event is missing`,
      );
    }
    const before = state;
    const result = reduceChatTurn(before, event);
    assertAt(
      seed,
      step,
      'replaying the stream is fenced without effects',
      () => {
        expect(result.state).toBe(before);
        expect(stateToJson(result.state)).toBe(originalJson);
        expect(result.effects).toEqual([]);
      },
    );
    state = result.state;
    replayEffects.push(...result.effects);
  }
  assertAt(
    seed,
    events.length,
    'replay leaves the state equal to the first reduction',
    () => {
      expect(state).toBe(original.state);
      expect(state).toEqual(original.state);
      expect(replayEffects).toEqual([]);
    },
  );
}

function checkJsonPrefixContinuation(
  seed: number,
  events: readonly ChatTurnLifecycleEvent[],
  full: ReductionResult,
): void {
  const splitStep = Math.min(
    events.length - 1,
    Math.floor(events.length / 2) + (seed % 7) - 3,
  );
  const prefix = reduceStream(seed, events.slice(0, splitStep));
  const restoredPrefix = stateFromJson(stateToJson(prefix.state));
  const suffix = reduceStream(seed, events.slice(splitStep), restoredPrefix);
  const combinedEffects = [...prefix.effects, ...suffix.effects];

  assertAt(
    seed,
    splitStep,
    'JSON prefix checkpoint plus suffix equals full reduction',
    () => {
      expect(suffix.state).toEqual(full.state);
      expect(combinedEffects).toEqual(full.effects);
    },
  );
}

function checkMixedWholeStreamReplay(
  seed: number,
  events: readonly GeneratedMixedEvent[],
  original: ReductionResult,
): void {
  const originalJson = stateToJson(original.state);
  let state = original.state;
  const replayEffects: ChatTurnEffect[] = [];
  for (let step = 0; step < events.length; step += 1) {
    const event = events[step];
    if (event === undefined) {
      throw new Error(
        `seed=${seed} step=${step} mixed replay event is missing`,
      );
    }
    const before = state;
    const result =
      event.kind === 'provider'
        ? reduceChatTurn(before, event.event)
        : reduceChatTurnHostEvent(before, event.event);
    assertAt(
      seed,
      step,
      'replaying mixed stream is fenced without effects',
      () => {
        expect(result.state).toBe(before);
        expect(stateToJson(result.state)).toBe(originalJson);
        expect(result.effects).toEqual([]);
      },
    );
    state = result.state;
    replayEffects.push(...result.effects);
  }
  assertAt(
    seed,
    events.length,
    'mixed replay preserves first reduction',
    () => {
      expect(state).toBe(original.state);
      expect(state).toEqual(original.state);
      expect(replayEffects).toEqual([]);
    },
  );
}

function checkMixedJsonPrefixContinuation(
  seed: number,
  events: readonly GeneratedMixedEvent[],
  full: ReductionResult,
): void {
  const splitStep = Math.min(
    events.length - 1,
    Math.floor(events.length / 2) + (seed % 7) - 3,
  );
  const prefix = reduceMixedStream(seed, events.slice(0, splitStep));
  const restoredPrefix = stateFromJson(stateToJson(prefix.state));
  const suffix = reduceMixedStream(
    seed,
    events.slice(splitStep),
    restoredPrefix,
  );
  const combinedEffects = [...prefix.effects, ...suffix.effects];

  assertAt(
    seed,
    splitStep,
    'mixed JSON checkpoint plus suffix equals full reduction',
    () => {
      expect(suffix.state).toEqual(full.state);
      expect(combinedEffects).toEqual(full.effects);
    },
  );
}

describe('reduceChatTurn seeded generated stream properties', () => {
  it('preserves lifecycle invariants across generated provider streams', () => {
    for (const seed of PROPERTY_SEEDS) {
      const stream = generateStream(seed);
      checkGeneratedCoverage(seed, stream);
      const full = reduceStream(
        seed,
        stream.events,
        initialChatTurnState(),
        (state, step) => {
          checkScenarioStep(seed, stream, state, step);
        },
      );
      checkWholeStreamReplay(seed, stream.events, full);
      checkDuplicateAndStaleFences(seed, stream.events);
      checkSettledTurnFences(seed, stream, full.state);
      checkJsonPrefixContinuation(seed, stream.events, full);

      const mixedStream = generateMixedStream(seed, stream);
      checkMixedGeneratedCoverage(seed, stream, mixedStream);
      const mixedFull = reduceMixedStream(
        seed,
        mixedStream.events,
        initialChatTurnState(),
        (state, previousState, result, event, step) => {
          checkMixedScenarioStep(
            seed,
            stream,
            mixedStream,
            state,
            previousState,
            result,
            event,
            step,
          );
        },
      );
      checkMixedWholeStreamReplay(seed, mixedStream.events, mixedFull);
      checkMixedJsonPrefixContinuation(seed, mixedStream.events, mixedFull);
    }
  });
});
