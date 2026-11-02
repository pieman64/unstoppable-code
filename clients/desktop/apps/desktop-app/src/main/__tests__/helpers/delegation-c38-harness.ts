import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import { delegationBlockId } from '@canopy/agent-transcript';
import {
  AgentDelegationBroker,
  type AgentDelegationBrokerOptions,
  type StoredDelegation,
} from '@canopy/desktop-shared/node/delegation/broker';
import { AgentRunnerRegistry } from '@canopy/desktop-shared/node/delegation/runner-registry';
import { FileDelegationStorage } from '@canopy/desktop-shared/node/delegation/storage';
import {
  readMetadataOfRecord,
  type StoredDelegationV3,
} from '@canopy/desktop-shared/node/delegation/record-v3';
import type {
  AgentRunRequest,
  DelegatedEventSink,
  NativeRunHandle,
} from '@canopy/desktop-shared/node/delegation/types';
import type { DelegationTranscriptTarget } from '@canopy/desktop-shared/node/delegation/transcript-port';
import {
  baseTask,
  rootParent,
} from '../../../../../../packages/desktop-shared/src/node/delegation/__tests__/broker-harness';
import {
  FakeRunner,
  routeFixture,
} from '../../../../../../packages/desktop-shared/src/node/delegation/__tests__/fixtures';
import { RepositoryDelegationTranscriptPort } from '../../agents/delegation/repository-transcript-port';
import { ChatStateService } from '../../services/chat-state-service';
import { ChatStateV2Repository } from '../../services/chat-state-v2-repository';
import type { ChatScopeKey } from '../../services/chat-state-contracts';
import { format4Scope } from './chat-format4-scope';
import {
  message,
  toolMessage,
  scopeSource,
} from './chat-delta-journal-harness';
import { idle, streaming, text, upsert } from './chat-delta-journal-scope';
import type {
  C38IoClass,
  C38Observation,
  C38ObservationWindow,
} from './delegation-c38-observation';

export type C38Size = 'small' | 'full';
export type C38Probe =
  | 'old-apply'
  | 'old-discard'
  | 'middle-apply'
  | 'middle-discard'
  | 'tail-fail'
  | 'tail-stop';
export type C38Operation = Readonly<{
  probe: C38Probe;
  operation:
    | 'progress'
    | 'completed'
    | 'failed'
    | 'stopped'
    | 'apply'
    | 'discard'
    | 'publication';
  window: 'idle' | 'active';
}>;

/** Frozen BEFORE measurement. Literal payload lengths are UTF-16 code units;
 * all typical payloads except the explicit Unicode answer are ASCII. */
export const C38_MANIFEST = Object.freeze({
  version: 1,
  capacity: 8,
  small: Object.freeze({
    seedRows: 768,
    minimumParentBytes: 3 * 1024 * 1024,
    cards: 25,
    distinctDelegations: 24,
    generation1Rows: 24,
    generation2Rows: 1,
    afterContinuation: 26,
    afterContinuationGeneration1Rows: 24,
    afterContinuationGeneration2Rows: 2,
    settledBeforeWindows: 19,
    completedBeforeWindows: 6,
    failedBeforeWindows: 7,
    stoppedBeforeWindows: 6,
  }),
  full: Object.freeze({
    seedRows: 2560,
    minimumParentBytes: 10 * 1024 * 1024,
    cards: 500,
    distinctDelegations: 499,
    generation1Rows: 499,
    generation2Rows: 1,
    afterContinuation: 501,
    afterContinuationGeneration1Rows: 499,
    afterContinuationGeneration2Rows: 2,
    settledBeforeWindows: 494,
    completedBeforeWindows: 164,
    failedBeforeWindows: 164,
    stoppedBeforeWindows: 166,
  }),
  seedTextLength: 4096,
  seedReferenceBodyLength: 73728,
  creationPromptLength: 256,
  descriptionLength: 64,
  queuedOverrides: 1,
  queuedOverrideLength: 2048,
  queuedPromptLength: 2306,
  // broker.ts:8736-8737: only queued continuations (generation > 1)
  // can coalesce host prompts. G4 adversarial overrides use these too.
  queuedAncestorIndex: 3,
  idleContinuationAncestorIndex: 6,
  maximumPromptGeneration: 'continuation',
  previewLength: 128,
  smallAnswerLength: 256,
  largeAnswerRepeats: 12288,
  largeAnswerUnit: 'answer 🌲漢字\n',
  failedErrorLength: 128,
  continuationPromptLength: 256,
  creationRowCeilingBytes: 8192,
  heldCards: 6,
  completedHeldCards: 4,
  failedHeldCards: 1,
  stoppedHeldCards: 1,
  applyCards: 2,
  discardCards: 2,
  heldAnswers: Object.freeze({
    'old-apply': 'large',
    'old-discard': 'large',
    'middle-apply': 'absent',
    'middle-discard': 'empty',
  }),
  // Baseline settled cards cycle completed/failed/cancelled by index modulo 3.
  baselineOutcomeCycle: Object.freeze(['completed', 'failed', 'cancelled']),
  // Exact same probes/windows in CI; only their indices and seed size differ.
  operations: Object.freeze(
    (
      [
        { probe: 'old-apply', operation: 'progress', window: 'idle' },
        { probe: 'old-discard', operation: 'progress', window: 'idle' },
        { probe: 'middle-apply', operation: 'progress', window: 'idle' },
        { probe: 'middle-discard', operation: 'progress', window: 'idle' },
        { probe: 'tail-fail', operation: 'progress', window: 'idle' },
        { probe: 'tail-stop', operation: 'progress', window: 'idle' },
        { probe: 'old-apply', operation: 'progress', window: 'active' },
        { probe: 'old-discard', operation: 'progress', window: 'active' },
        { probe: 'middle-apply', operation: 'progress', window: 'active' },
        { probe: 'middle-discard', operation: 'progress', window: 'active' },
        { probe: 'tail-fail', operation: 'progress', window: 'active' },
        { probe: 'tail-stop', operation: 'progress', window: 'active' },
        { probe: 'old-apply', operation: 'progress', window: 'active' },
        { probe: 'old-discard', operation: 'progress', window: 'active' },
        { probe: 'middle-apply', operation: 'progress', window: 'active' },
        { probe: 'middle-discard', operation: 'progress', window: 'active' },
        { probe: 'tail-fail', operation: 'progress', window: 'active' },
        { probe: 'tail-stop', operation: 'progress', window: 'active' },
        { probe: 'old-apply', operation: 'progress', window: 'idle' },
        { probe: 'tail-stop', operation: 'progress', window: 'idle' },
        { probe: 'old-apply', operation: 'completed', window: 'idle' },
        { probe: 'old-discard', operation: 'completed', window: 'idle' },
        { probe: 'middle-apply', operation: 'completed', window: 'idle' },
        { probe: 'middle-discard', operation: 'completed', window: 'idle' },
        { probe: 'tail-fail', operation: 'failed', window: 'idle' },
        { probe: 'tail-stop', operation: 'stopped', window: 'idle' },
        { probe: 'old-apply', operation: 'apply', window: 'idle' },
        { probe: 'old-discard', operation: 'discard', window: 'idle' },
        { probe: 'middle-apply', operation: 'apply', window: 'idle' },
        { probe: 'middle-discard', operation: 'discard', window: 'idle' },
        { probe: 'old-apply', operation: 'publication', window: 'idle' },
        { probe: 'middle-discard', operation: 'publication', window: 'idle' },
      ] satisfies C38Operation[]
    ).map((operation) => Object.freeze(operation)),
  ),
});

export const C38_LARGE_ANSWER = C38_MANIFEST.largeAnswerUnit.repeat(
  C38_MANIFEST.largeAnswerRepeats,
);
export const C38_SCOPE: ChatScopeKey = Object.freeze({
  projectId: 'c38-project',
  worktreeId: 'c38-worktree',
});
export const C38_CHAT_ID = 'c38-parent';
export const C38_MAX_MAINTENANCE_BARRIERS = 10000;

export interface C38Card {
  readonly delegationId: string;
  readonly runGeneration: number;
  readonly messageId: string;
  readonly index: number;
  readonly isolated: boolean;
}

export function c38Target(card: C38Card): DelegationTranscriptTarget {
  return {
    kind: 'delegation',
    chatId: C38_CHAT_ID,
    delegationId: card.delegationId,
    runGeneration: card.runGeneration,
  };
}

export function c38ProbeIndices(
  size: C38Size,
): Readonly<Record<C38Probe, number>> {
  const count = C38_MANIFEST[size].cards;
  return Object.freeze({
    'old-apply': 0,
    'old-discard': 1,
    'middle-apply': Math.floor(count / 2) - 1,
    'middle-discard': Math.floor(count / 2),
    'tail-fail': count - 2,
    'tail-stop': count - 1,
  });
}

/** Independent creation denominator: callers supply the logically NEW expected
 * rows, not observed write buffers or a diff of bytes the candidate wrote. */
export function c38CreationBytes(expectedRows: readonly object[]): number {
  return expectedRows.reduce(
    (sum, row) => sum + Buffer.byteLength(`${JSON.stringify(row)}\n`),
    0,
  );
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolveValue: (value: T) => void = () => {
    throw new Error('Uninitialized barrier');
  };
  const promise = new Promise<T>((resolve) => {
    resolveValue = resolve;
  });
  return { promise, resolve: resolveValue };
}

/** Manual execution only; per-generation sinks, with launch acknowledgements.
 * No timer polling, vendor process, fixed UUID or synthetic card state. */
export class C38Runner extends FakeRunner {
  onStop?: (id: string) => Promise<void>;
  private readonly launched = new Map<
    string,
    ReturnType<typeof deferred<AgentRunRequest>>
  >();
  private readonly generationSinks = new Map<string, DelegatedEventSink>();
  override start(
    request: AgentRunRequest,
    sink: DelegatedEventSink,
  ): Promise<NativeRunHandle> {
    const result = super.start(request, sink);
    const key = `${request.delegationId}:${request.runGeneration}`;
    this.generationSinks.set(key, sink);
    this.launchBarrier(key).resolve(request);
    return result;
  }
  override async stop(handle: NativeRunHandle): Promise<{ stopped: true }> {
    this.stopped.push(handle.runId);
    await this.onStop?.(handle.runId);
    return { stopped: true };
  }
  private launchBarrier(
    key: string,
  ): ReturnType<typeof deferred<AgentRunRequest>> {
    const existing = this.launched.get(key);
    if (existing) return existing;
    const pending = deferred<AgentRunRequest>();
    this.launched.set(key, pending);
    return pending;
  }
  waitForLaunch(card: C38Card): Promise<AgentRunRequest> {
    return this.launchBarrier(`${card.delegationId}:${card.runGeneration}`)
      .promise;
  }
  event(
    card: C38Card,
    envelope: Parameters<DelegatedEventSink>[0],
  ): Promise<void> {
    const sink = this.generationSinks.get(
      `${card.delegationId}:${card.runGeneration}`,
    );
    if (!sink) throw new Error('No runner sink for this generation');
    return sink(envelope);
  }
}

/** Observes successfully committed notification state, not a void callback. */
class C38Storage extends FileDelegationStorage {
  private readonly notified = new Map<
    string,
    ReturnType<typeof deferred<void>>
  >();
  private readonly controls = new Map<
    string,
    ReturnType<typeof deferred<void>>
  >();
  override async commit(record: StoredDelegation): Promise<void> {
    await super.commit(record);
    if (
      record.version === 3 &&
      record.control &&
      record.control.status !== 'accepted'
    ) {
      this.controlBarrier(record.control.operationId).resolve();
    }
    if (record.version === 3 && record.latestResult?.notified) {
      this.barrier(
        record.state.delegationId,
        record.latestResult.runGeneration,
      ).resolve();
    }
  }
  private barrier(
    id: string,
    generation: number,
  ): ReturnType<typeof deferred<void>> {
    const key = `${id}:${generation}`;
    const existing = this.notified.get(key);
    if (existing) return existing;
    const pending = deferred<void>();
    this.notified.set(key, pending);
    return pending;
  }
  settled(card: C38Card): Promise<void> {
    return this.barrier(card.delegationId, card.runGeneration).promise;
  }
  private controlBarrier(id: string): ReturnType<typeof deferred<void>> {
    const existing = this.controls.get(id);
    if (existing) return existing;
    const pending = deferred<void>();
    this.controls.set(id, pending);
    return pending;
  }
  controlCompleted(id: string): Promise<void> {
    return this.controlBarrier(id).promise;
  }
}

export interface C38Backing {
  readonly size: C38Size;
  readonly scope: ChatScopeKey;
  readonly chatId: string;
  readonly directory: string;
  readonly parentLog: string;
  readonly seed: Readonly<{
    physicalBytes: number;
    rowHashes: readonly string[];
    referenceRowHash: string;
  }>;
  readonly service: ChatStateService;
  readonly repository: ChatStateV2Repository;
  readonly storage: FileDelegationStorage;
  readonly port: RepositoryDelegationTranscriptPort;
  readonly broker: AgentDelegationBroker;
  readonly runner: C38Runner;
  readonly cards: readonly C38Card[];
  readonly errors: readonly unknown[];
  readonly ingressErrors: readonly unknown[];
  readonly ingress: Readonly<{ enqueued: number; completed: number }>;
  readonly notifications: readonly string[];
  /** Null is explicitly unavailable when no observation was supplied. */
  readonly parentTurnBoundaries: readonly {
    label: string;
    warmView: boolean;
    observation: C38ObservationWindow | null;
  }[];
  ioOwnerForPath(path: string): C38IoClass | undefined;
  spawn(
    index: number,
    options?: { isolated?: boolean; queued?: boolean },
  ): Promise<C38Card>;
  start(card: C38Card): Promise<void>;
  progress(card: C38Card): Promise<void>;
  terminal(
    card: C38Card,
    status?: 'completed' | 'failed' | 'cancelled',
    answer?: string,
  ): Promise<void>;
  stop(card: C38Card): Promise<void>;
  createCards(): Promise<readonly C38Card[]>;
  runOperation(operation: C38Operation): Promise<void>;
  manage(card: C38Card, operation: 'apply' | 'discard'): Promise<void>;
  followUp(
    card: C38Card,
    options?: { index?: number; queued?: boolean },
  ): Promise<C38Card>;
  record(card: C38Card): Promise<StoredDelegationV3>;
  rawCard(
    card: C38Card,
  ): ReturnType<ChatStateService['readStoredParentMessage']>;
  beginParentTurn(options?: { warmView?: boolean }): Promise<void>;
  endParentTurn(options?: { warmView?: boolean }): Promise<void>;
  drain(): Promise<void>;
  restart(): Promise<void>;
  reopenRepository(): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * Stands in for the phase-14 card anchor supply: production registers stream
 * generations without `anchorMessageId`, so the record reader returns empty
 * task fields until phase 14 anchors them (or falls back to the record task).
 */
export async function c38Backing(
  root: string,
  options: {
    size?: C38Size;
    ambientCheckpoints?: boolean;
    observation?: C38Observation;
    /** Anchor each generation to its card message (the phase-14 stand-in). */
  } = {},
): Promise<C38Backing> {
  const size = options.size ?? 'small';
  const manifest = C38_MANIFEST[size];
  const directory = join(root, C38_SCOPE.projectId, C38_SCOPE.worktreeId);
  const seedRows = Array.from({ length: manifest.seedRows }, (_, index) =>
    message(
      `seed-${index}`,
      's'.repeat(C38_MANIFEST.seedTextLength),
      'assistant',
      index + 1,
    ),
  );
  seedRows.push(
    toolMessage(
      'seed-reference',
      'r'.repeat(C38_MANIFEST.seedReferenceBodyLength),
      manifest.seedRows + 1,
    ),
  );
  const { backend, store } = await format4Scope(
    directory,
    C38_SCOPE.worktreeId,
    scopeSource([{ id: C38_CHAT_ID, messages: seedRows }]),
  );
  await backend.flush();
  backend.releaseJournal();
  await backend.disposeArtifactMaintenance();
  // The store resolves storage paths; do not infer metadata locations from the checkout.
  const actualParentLog = join(
    store.directory,
    'transcripts',
    `${C38_CHAT_ID}.jsonl`,
  );
  const seedBytes = await fs.readFile(actualParentLog);
  const physicalRows = seedBytes.toString('utf8').trimEnd().split('\n');
  const rowHashes = physicalRows.map((row) =>
    crypto.createHash('sha256').update(`${row}\n`).digest('hex'),
  );
  for (let index = 0; index < manifest.seedRows; index++) {
    const expected = crypto
      .createHash('sha256')
      .update(`${JSON.stringify(seedRows[index])}\n`)
      .digest('hex');
    if (rowHashes[index] !== expected)
      throw new Error(
        `Seed row ${index} differs from its literal payload hash`,
      );
  }
  const referenceRow = physicalRows[physicalRows.length - 1];
  if (
    seedBytes.length < manifest.minimumParentBytes ||
    physicalRows.length !== manifest.seedRows + 1 ||
    !referenceRow?.includes('Ref')
  )
    throw new Error('Seed physical size/row/reference verification failed');
  const seed = Object.freeze({
    physicalBytes: seedBytes.length,
    rowHashes: Object.freeze(rowHashes),
    referenceRowHash: crypto
      .createHash('sha256')
      .update(`${referenceRow}\n`)
      .digest('hex'),
  });
  seedRows.length = 0;
  const repositoryOptions = {
    resolvePaths: (): { tabs: string; archives: string; journal: string } => ({
      tabs: join(directory, `${C38_SCOPE.worktreeId}.json`),
      archives: join(directory, 'archives.json'),
      journal: join(directory, 'journal.json'),
    }),
    enableFormat4: true,
    delegationReadMetadata: readMetadataOfRecord,
    ...(options.ambientCheckpoints
      ? {}
      : {
          deltaJournalIdleCheckpointMs: 3600_000,
          deltaJournalCheckpointBytes: Number.MAX_SAFE_INTEGER,
        }),
  } satisfies ConstructorParameters<typeof ChatStateV2Repository>[0];
  let repository = new ChatStateV2Repository(repositoryOptions);
  let service = new ChatStateService({
    repository,
    recordDiagnostic: (): void => undefined,
  });
  const servicePort = new Proxy(service, {
    get: (_target, key): unknown => {
      const member: unknown = Reflect.get(service, key);
      return typeof member === 'function' ? member.bind(service) : member;
    },
  });
  const repositoryPort = new RepositoryDelegationTranscriptPort(
    servicePort,
    C38_SCOPE,
  );
  const port = repositoryPort;
  const storage = new C38Storage(join(directory, 'delegation', 'runs'));
  const errors: unknown[] = [];
  const ingressErrors: unknown[] = [];
  const ingressCounts = { enqueued: 0, completed: 0 };
  const notifications: string[] = [];
  const parentTurnBoundaries: Array<{
    label: string;
    warmView: boolean;
    observation: C38ObservationWindow | null;
  }> = [];
  const cards: C38Card[] = [];
  const sequences = new Map<string, number>();
  const ingestedGenerations = new Map<
    string,
    ReturnType<typeof deferred<void>>
  >();
  const ingestedGeneration = (
    id: string,
    generation: number,
  ): ReturnType<typeof deferred<void>> => {
    const key = `${id}:${generation}`;
    const existing = ingestedGenerations.get(key);
    if (existing) return existing;
    const pending = deferred<void>();
    ingestedGenerations.set(key, pending);
    return pending;
  };
  let ingress = Promise.resolve();
  let call = 0;
  const parent = (): typeof rootParent => ({
    ...rootParent,
    ...C38_SCOPE,
    chatId: C38_CHAT_ID,
    sessionKey: `${C38_SCOPE.projectId}/${C38_SCOPE.worktreeId}/${C38_CHAT_ID}`,
    turnId: 'c38-origin',
    toolCallId: `c38-call-${++call}`,
  });
  const makeBroker = (): {
    broker: AgentDelegationBroker;
    runner: C38Runner;
  } => {
    const runner = new C38Runner('local-sdk');
    runner.onStop = async (id): Promise<void> => {
      const generations = cards.filter((card) => card.delegationId === id);
      const card = generations[generations.length - 1];
      if (!card) throw new Error('Stopped runner has no fixture generation');
      // Emit within the public adapter stop callback, BEFORE the broker can
      // synthesize finishWithoutRun from an acknowledgement alone.
      await event(card, { type: 'terminal', status: 'cancelled' });
    };
    const registry = new AgentRunnerRegistry();
    registry.register({
      apiVersion: 1,
      registrationId: 'third-local',
      adapter: runner,
    });
    const broker = new AgentDelegationBroker({
      registry,
      storage,
      cwd: root,
      capacity: C38_MANIFEST.capacity,
      maxDepthForParent: (): number => 5,
      resolveRoute: (): ReturnType<
        AgentDelegationBrokerOptions['resolveRoute']
      > =>
        Promise.resolve({
          ok: true,
          value: routeFixture({
            capabilities: ['read', 'write', 'worktree', 'progress', 'resume'],
          }),
        }),
      authorize: (): ReturnType<AgentDelegationBrokerOptions['authorize']> =>
        Promise.resolve({ ok: true, value: undefined }),
      testOnlyStreamGeneration: true,
      transcriptPort: port,
      // Deterministic PUBLIC workspace adapters, NOT real Git apply coverage.
      prepareWorkspace: (
        _parent,
        _task,
        id,
      ): ReturnType<
        NonNullable<AgentDelegationBrokerOptions['prepareWorkspace']>
      > =>
        Promise.resolve({
          cwd: join(root, 'isolated', id),
          revision: 'a'.repeat(40),
        }),
      manageWorkspace: async (
        _parent,
        _record,
        operation,
        _signal,
        hooks,
      ): Promise<void> => {
        if (operation === 'apply') await hooks.applied([]);
      },
      onError: (error): void => {
        errors.push(error);
      },
      onTranscript: (_parent, transcript): void => {
        ingressCounts.enqueued++;
        ingress = ingress.then(async () => {
          try {
            await service.ingestProviderEventWithOutcome({
              ...C38_SCOPE,
              chatId: C38_CHAT_ID,
              data: {
                type: 'canopy_delegation',
                delegation: transcript,
                canopy_turn_user_message_id: transcript.parentTurnId,
              },
              mutationId: `c38:${crypto.randomUUID()}`,
            });
          } catch (error) {
            ingressErrors.push(error);
          } finally {
            ingressCounts.completed++;
            ingestedGeneration(
              transcript.delegationId,
              transcript.runGeneration,
            ).resolve();
          }
        });
      },
      onSettled: (_parent, id, result): Promise<void> => {
        notifications.push(`${id}:${result.runGeneration}`);
        return Promise.resolve();
      },
    } satisfies AgentDelegationBrokerOptions);
    return { broker, runner };
  };
  let current = makeBroker();
  const all = [current.broker];
  await current.broker.initialize();
  const drain = async (): Promise<void> => {
    const latestCards = new Map<string, C38Card>();
    for (const card of cards) latestCards.set(card.delegationId, card);
    for (const card of cards) {
      if (latestCards.get(card.delegationId) === card)
        await current.broker.flushCardPublication(c38Target(card));
    }
    // Await exactly the ingress captured by publication; drain a subsequently
    // enqueued chain as well without mistaking a void callback for an ack.
    for (;;) {
      const captured = ingress;
      await captured;
      if (captured === ingress) break;
    }
    // Public status + the repository's public serialized revision read form
    // a causal scheduler barrier. Yield an event-loop turn (NOT a timer or
    // arbitrary sleep), then await the scope lease behind its queued chunk.
    for (let round = 0; ; round++) {
      const maintenance = repository.getArtifactMaintenanceStatus(C38_SCOPE);
      const pausedForReplay =
        maintenance.failure ===
        'Artifact maintenance deferred while replay is pending';
      if (
        (maintenance.failure || maintenance.deferredChats > 0) &&
        !pausedForReplay
      )
        throw new Error(
          `Artifact maintenance is deferred or failed; causal drain unavailable: ${JSON.stringify(maintenance)}`,
        );
      // Pending journal replay legitimately PAUSES maintenance: no scheduler
      // work remains. Do not force a checkpoint just to make it eligible.
      // The end-turn checkpoint requests it again and its boundary drains it.
      if (maintenance.pendingChats === 0) break;
      if (round >= C38_MAX_MAINTENANCE_BARRIERS)
        throw new Error(
          `Artifact maintenance did not drain after ${C38_MAX_MAINTENANCE_BARRIERS} scheduler barriers: ${JSON.stringify(maintenance)}`,
        );
      await new Promise<void>((resolve) => setImmediate(resolve));
      await repository.getRevision(C38_SCOPE);
    }
  };
  const event = async (
    card: C38Card,
    data: Parameters<DelegatedEventSink>[0]['event'],
  ): Promise<void> => {
    const key = `${card.delegationId}:${card.runGeneration}`;
    const sequence = (sequences.get(key) ?? 0) + 1;
    sequences.set(key, sequence);
    await current.runner.event(card, {
      delegationId: card.delegationId,
      runGeneration: card.runGeneration,
      sequence,
      occurredAt: 1_000_000 + call + sequence,
      event: data,
    });
  };
  const backing: C38Backing = {
    size,
    scope: C38_SCOPE,
    chatId: C38_CHAT_ID,
    directory,
    parentLog: actualParentLog,
    seed,
    storage,
    port,
    cards,
    errors,
    ingressErrors,
    ingress: ingressCounts,
    notifications,
    parentTurnBoundaries,
    get service(): ChatStateService {
      return service;
    },
    get repository(): ChatStateV2Repository {
      return repository;
    },
    get broker(): AgentDelegationBroker {
      return current.broker;
    },
    get runner(): C38Runner {
      return current.runner;
    },
    ioOwnerForPath(path): C38IoClass | undefined {
      const within = relative(directory, path);
      if (within.startsWith(`..${sep}`) || within === '..') return undefined;
      const name = basename(path);
      if (
        within.includes(`${sep}artifacts${sep}`) ||
        within.includes(`${sep}tool-output${sep}`)
      )
        return 'artifact';
      if (within.includes(`${sep}delegations${sep}`)) {
        return name.startsWith('transcript.') &&
          (name.endsWith('.jsonl') ||
            name.includes('.active.json') ||
            name.endsWith('.append.tmp') ||
            name.endsWith('.rewrite.tmp'))
          ? 'child-log'
          : 'metadata';
      }
      if (
        dirname(path) === dirname(actualParentLog) &&
        name.startsWith(`${C38_CHAT_ID}.`)
      ) {
        if (name.endsWith('.jsonl') || name.endsWith('.rewrite.tmp'))
          return 'parent-jsonl';
        if (name.includes('.active.json') || name.endsWith('.append.tmp'))
          return 'active-sidecar';
        return 'parent-index';
      }
      if (
        path.startsWith(
          join(dirname(actualParentLog), 'message-index', C38_CHAT_ID),
        )
      )
        return 'parent-index';
      return 'metadata';
    },
    async spawn(index, taskOptions = {}): Promise<C38Card> {
      const result = await current.broker.spawn(parent(), {
        ...baseTask,
        prompt: 'p'.repeat(C38_MANIFEST.creationPromptLength),
        description: 'd'.repeat(C38_MANIFEST.descriptionLength),
        ...(taskOptions.isolated
          ? { isolation: 'worktree', permissions: { writePaths: ['src'] } }
          : {}),
      });
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      const card = Object.freeze({
        delegationId: result.value.delegationId,
        runGeneration: 1,
        messageId: delegationBlockId(result.value.delegationId, 1),
        index,
        isolated: taskOptions.isolated ?? false,
      });
      cards.push(card);
      if (!taskOptions.queued) await backing.start(card);
      await drain();
      return card;
    },
    async start(card): Promise<void> {
      await current.runner.waitForLaunch(card);
      await event(card, {
        type: 'started',
        nativeSessionId: `c38-native-${card.delegationId}`,
      });
      await drain();
    },
    async progress(card): Promise<void> {
      const nextSequence =
        (sequences.get(`${card.delegationId}:${card.runGeneration}`) ?? 0) + 1;
      const prefix = `preview-${nextSequence}:`;
      await event(card, {
        type: 'progress',
        text: prefix + 'v'.repeat(C38_MANIFEST.previewLength - prefix.length),
        truncated: true,
      });
      await drain();
    },
    async terminal(card, status = 'completed', answer): Promise<void> {
      await event(card, {
        type: 'terminal',
        status,
        ...(answer === undefined ? {} : { finalText: answer }),
        ...(status === 'failed'
          ? {
              error: {
                code: 'runtime_error',
                message: 'e'.repeat(C38_MANIFEST.failedErrorLength),
                retryable: false,
              },
            }
          : {}),
      });
      await storage.settled(card);
      await drain();
    },
    async stop(card): Promise<void> {
      const receipt = await current.broker.stop(
        parent(),
        card.delegationId,
        'user_cancelled',
      );
      if (!receipt.ok) throw new Error(JSON.stringify(receipt.error));
      await storage.settled(card);
      await drain();
    },
    async createCards(): Promise<readonly C38Card[]> {
      if (cards.length)
        throw new Error('Populate requires a fresh, zero-card fixture');
      const indices = c38ProbeIndices(size);
      const held = new Set(Object.values(indices));
      const temporary: C38Card[] = [];
      for (let index = 0; index < manifest.cards; index++) {
        const queued = index === manifest.cards - 1;
        const isolated =
          index === indices['old-apply'] ||
          index === indices['old-discard'] ||
          index === indices['middle-apply'] ||
          index === indices['middle-discard'];
        const ancestor = cards.find(
          (candidate) => candidate.index === C38_MANIFEST.queuedAncestorIndex,
        );
        let card: C38Card;
        if (queued) {
          if (!ancestor)
            throw new Error('Missing queued continuation ancestor');
          card = await backing.followUp(ancestor, { index, queued: true });
        } else {
          card = await backing.spawn(index, { isolated });
        }
        if (queued) {
          const amended = await current.broker.deliverHostMessage(
            card.delegationId,
            'q'.repeat(C38_MANIFEST.queuedOverrideLength),
            crypto.randomUUID(),
          );
          if (!amended.ok) throw new Error(JSON.stringify(amended.error));
          for (const pending of temporary)
            await backing.terminal(
              pending,
              pending.index % 3 === 0
                ? 'completed'
                : pending.index % 3 === 1
                  ? 'failed'
                  : 'cancelled',
              pending.index % 3 === 0
                ? 'a'.repeat(C38_MANIFEST.smallAnswerLength)
                : undefined,
            );
          await backing.start(card);
        } else if (!held.has(index)) {
          if (index >= manifest.cards - 5) temporary.push(card);
          else
            await backing.terminal(
              card,
              index % 3 === 0
                ? 'completed'
                : index % 3 === 1
                  ? 'failed'
                  : 'cancelled',
              index % 3 === 0
                ? 'a'.repeat(C38_MANIFEST.smallAnswerLength)
                : undefined,
            );
        }
        const raw = await backing.rawCard(card);
        if (
          !raw ||
          Buffer.byteLength(`${JSON.stringify(raw)}\n`) >
            C38_MANIFEST.creationRowCeilingBytes
        )
          throw new Error(
            'Creation row missing or above the frozen 8 KiB ceiling',
          );
      }
      await drain();
      return cards;
    },
    async runOperation(operation): Promise<void> {
      const card = cards.find(
        (candidate) =>
          candidate.index === c38ProbeIndices(size)[operation.probe],
      );
      if (!card) throw new Error('Missing manifest probe');
      switch (operation.operation) {
        case 'progress':
          await backing.progress(card);
          break;
        case 'failed':
          await backing.terminal(card, 'failed');
          break;
        case 'stopped':
          await backing.stop(card);
          break;
        case 'completed':
          await backing.terminal(
            card,
            'completed',
            operation.probe === 'old-apply' || operation.probe === 'old-discard'
              ? C38_LARGE_ANSWER
              : operation.probe === 'middle-discard'
                ? ''
                : undefined,
          );
          break;
        case 'apply':
        case 'discard':
          await backing.manage(card, operation.operation);
          break;
        case 'publication':
          await current.broker.flushCardPublication(c38Target(card));
          await drain();
          break;
      }
    },
    async manage(card, operation): Promise<void> {
      const result = await current.broker.manage(parent(), {
        delegationId: card.delegationId,
        operation,
      });
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      const admitted = await storage.loadOne(card.delegationId);
      if (admitted?.version !== 3 || admitted.control?.operation !== operation)
        throw new Error('Missing admitted workspace control');
      await storage.controlCompleted(admitted.control.operationId);
      await drain();
      const completed = await storage.loadOne(card.delegationId);
      if (completed?.version !== 3 || completed.control?.status !== 'completed')
        throw new Error('Workspace control did not durably complete');
    },
    async followUp(card, followOptions = {}): Promise<C38Card> {
      const result = await current.broker.manage(parent(), {
        delegationId: card.delegationId,
        operation: 'follow_up',
        message: 'f'.repeat(C38_MANIFEST.continuationPromptLength),
      });
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      const next = Object.freeze({
        ...card,
        index: followOptions.index ?? card.index,
        runGeneration: card.runGeneration + 1,
        messageId: delegationBlockId(card.delegationId, card.runGeneration + 1),
      });
      await ingestedGeneration(next.delegationId, next.runGeneration).promise;
      cards.push(next);
      if (!followOptions.queued) await backing.start(next);
      await drain();
      return next;
    },
    async record(card): Promise<StoredDelegationV3> {
      await drain();
      const record = await storage.loadOne(card.delegationId);
      if (!record || record.version !== 3)
        throw new Error('Missing stream-backed record');
      return record;
    },
    async rawCard(card): Promise<Awaited<ReturnType<C38Backing['rawCard']>>> {
      await drain();
      return service.readStoredParentMessage(
        C38_SCOPE,
        C38_CHAT_ID,
        card.messageId,
      );
    },
    async beginParentTurn(turnOptions = {}): Promise<void> {
      const turnId = `c38-active-parent-${++call}`;
      const begin = async (): Promise<void> => {
        await drain();
        await repository.transact(
          C38_SCOPE,
          [
            upsert(
              C38_CHAT_ID,
              text(turnId, 'ordinary active parent input', 'user'),
            ),
            streaming(C38_CHAT_ID, turnId),
          ],
          { mutationId: `c38:begin:${++call}`, source: 'provider' },
        );
        if (turnOptions.warmView !== false) {
          // G1/B4: foreground turn-boundary hydration is measured separately,
          // before isolated card status windows. The un-warmed control remains
          // available to prove this cost independently of delegation events.
          await repository.transact(
            C38_SCOPE,
            [
              upsert(
                C38_CHAT_ID,
                text(`${turnId}-foreground`, 'ordinary foreground warmup'),
              ),
            ],
            {
              mutationId: `c38:foreground:${++call}`,
              source: 'provider',
              chatIds: [C38_CHAT_ID],
            },
          );
        }
      };
      const label = `${turnId}-boundary-hydration`;
      if (options.observation) {
        const result = await options.observation.withDrainedWindow(
          label,
          drain,
          begin,
          drain,
        );
        parentTurnBoundaries.push({
          label,
          warmView: turnOptions.warmView !== false,
          observation: result.window,
        });
      } else {
        await begin();
        parentTurnBoundaries.push({
          label,
          warmView: turnOptions.warmView !== false,
          observation: null,
        });
      }
    },
    async endParentTurn(turnOptions = {}): Promise<void> {
      const label = `c38-end-parent-${++call}-boundary-hydration-maintenance`;
      const end = async (): Promise<void> => {
        await drain();
        await repository.transact(C38_SCOPE, [idle(C38_CHAT_ID)], {
          mutationId: `c38:end:${++call}`,
          source: 'provider',
          checkpoint: true,
        });
        await drain();
        if (turnOptions.warmView !== false)
          await repository.getState(C38_SCOPE, { chatIds: [C38_CHAT_ID] });
      };
      if (options.observation) {
        const result = await options.observation.withDrainedWindow(
          label,
          drain,
          end,
          drain,
        );
        parentTurnBoundaries.push({
          label,
          warmView: turnOptions.warmView !== false,
          observation: result.window,
        });
      } else {
        await end();
        parentTurnBoundaries.push({
          label,
          warmView: turnOptions.warmView !== false,
          observation: null,
        });
      }
    },
    drain,
    async restart(): Promise<void> {
      await drain();
      await current.broker.close();
      await ingress;
      current = makeBroker();
      all.push(current.broker);
      await current.broker.initialize();
      await drain();
    },
    async reopenRepository(): Promise<void> {
      await drain();
      await service.drain();
      repository = new ChatStateV2Repository(repositoryOptions);
      service = new ChatStateService({
        repository,
        recordDiagnostic: (): void => undefined,
      });
    },
    async dispose(): Promise<void> {
      // Never let one failure skip later broker/repository cleanup. No global
      // spy is installed here; observer owners restore theirs in finally.
      const closed = await Promise.allSettled(
        all.map((broker) => broker.close()),
      );
      try {
        await ingress;
      } finally {
        await service.drain();
      }
      const failed = closed.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    },
  };
  return backing;
}
