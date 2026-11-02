import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

export const D11_LIFECYCLE_SCHEDULE = Object.freeze(
  [
    'parent-stop',
    'follow_up',
    'draft',
    'fail',
    'start',
    'settle-apply',
    'apply',
    'settle-discard',
    'discard',
    'stop',
    'follow_up-final',
    'start-final',
    'settle-final',
    'foreground-resume',
  ].map((operation, index) =>
    Object.freeze({
      ordinal: index + 1,
      operation,
      trigger: 'after-first-foreground-commit',
    }),
  ),
);

export const D11_REQUIRED_CATEGORIES = Object.freeze([
  'parent-stop',
  'continuation',
  'draft',
  'fail',
  'start',
  'settle',
  'apply',
  'discard',
  'stop',
  'foreground-resume',
]);

/** Count durable completions, not calls scheduled by the driver. */
// The fixed schedule takes about 15 s under load. An admission window this
// long must hold every lifecycle outcome; shorter ones (the 6 s smoke) only
// report the overlap.
export const D11_FOREGROUND_OVERLAP_FLOOR_MS = 60_000;

export function evaluateD11Replay(evidence) {
  const violations = D11_REQUIRED_CATEGORIES.filter(
    (category) => !(evidence.counts?.[category] > 0),
  ).map((category) => `missing durable category: ${category}`);
  for (const [condition, message] of [
    [evidence.policy === 'd11-cards', 'not the D11 policy'],
    [
      evidence.insideMeasuredReplay === true,
      'lifecycle outside measured foreground replay',
    ],
    [
      !(evidence.admissionWindowMs >= D11_FOREGROUND_OVERLAP_FLOOR_MS) ||
        evidence.lifecycleCompletedDuringForeground === true,
      'lifecycle completed after the foreground drained',
    ],
    [evidence.delegatedCardRewrites === 0, 'delegated-card rewrite'],
    [evidence.statusForcedCheckpoints === 0, 'status-forced checkpoint'],
    [evidence.rawCardsUnchanged === true, 'changed pre-existing card bytes'],
    [
      evidence.rawReferencesUnchanged === true,
      'changed pre-existing reference bytes',
    ],
    [
      evidence.continuationTailOnly === true,
      'non-tail or duplicate continuation',
    ],
    [
      evidence.independentMergedReaderPassed === true,
      'independent merged-reader check failed',
    ],
    [
      Array.isArray(evidence.missingOutcomes) &&
        evidence.missingOutcomes.length === 0,
      'missing durable outcome',
    ],
  ])
    if (!condition) violations.push(message);
  return { passed: violations.length === 0, violations };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function barrier(map, key) {
  if (!map.has(key)) map.set(key, deferred());
  return map.get(key);
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function seedRow(chatId, index, bytes) {
  const row = {
    id: `seed-${chatId}-${index}`,
    role: 'assistant',
    timestamp: index,
    blocks: [{ type: 'text', text: '' }],
  };
  row.blocks[0].text = 's'.repeat(
    Math.max(1, bytes - Buffer.byteLength(JSON.stringify(row)) - 1),
  );
  return row;
}

function requireOk(result) {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

/** Real host composition shared by all captured scopes, never a Jest helper. */
export async function createD11Replay(plan, root) {
  const primary = plan.owners.find(
    (owner) => owner.cardByteFractions.length >= 4,
  );
  if (!primary)
    throw new Error(
      'd11-cards requires a captured owner with at least four card positions',
    );
  const runtime = {
    ...(await load('../../src/main/services/chat-state-service.ts')),
    ...(await load('../../src/main/services/chat-state-v2-repository.ts')),
    ...(await load('../../src/main/services/chat-state-v2-backend.ts')),
    ...(await load(
      '../../src/main/agents/delegation/repository-transcript-port.ts',
    )),
    ...(await load('../../src/main/lib/chat-delta-journal/writer.ts')),
    ...(await load('../../src/main/lib/chat-turn-stop.ts')),
    ...(await load(
      '../../../../packages/desktop-shared/src/node/delegation/broker.ts',
    )),
    ...(await load(
      '../../../../packages/desktop-shared/src/node/delegation/runner-registry.ts',
    )),
    ...(await load(
      '../../../../packages/desktop-shared/src/node/delegation/storage.ts',
    )),
    ...(await load(
      '../../../../packages/desktop-shared/src/node/delegation/record-v3.ts',
    )),
    ...(await load(
      '../../../../packages/agent-transcript/src/lib/delegation-transcript.ts',
    )),
  };
  const repository = new runtime.ChatStateV2Repository({
    resolvePaths: (scope) => ({
      tabs: join(root, `${scope.worktreeId}.json`),
      archives: join(root, `${scope.worktreeId}-archives.json`),
      journal: join(root, `${scope.worktreeId}-journal.json`),
    }),
    enableFormat4: true,
    delegationReadMetadata: runtime.readMetadataOfRecord,
    // Deliberately retain the default idle and 4 MiB size checkpoint triggers.
  });
  const service = new runtime.ChatStateService({
    repository,
    recordDiagnostic: () => undefined,
  });
  runtime.resetChatStateServiceForTests(service);
  const context = new AsyncLocalStorage();
  const checkpointInputs = [];
  const parentWrites = [];
  const checkpoints = [];
  const rewriteDiagnostics = [];
  const restore = [];
  // Plain Node has no desktop log directory. Keep the real console transport,
  // but never let this test composition write outside its temporary fixture.
  const log = await load('electron-log/main.js');
  const fileLevel = log.transports.file.level;
  log.transports.file.level = false;
  restore.push(() => {
    log.transports.file.level = fileLevel;
  });
  let measuring = false;
  const wrap = (prototype, method, observe) => {
    const original = prototype[method];
    prototype[method] = function (...args) {
      if (measuring)
        observe.call(this, context.getStore() ?? { phase: 'ambient' }, ...args);
      return Reflect.apply(original, this, args);
    };
    restore.push(() => {
      prototype[method] = original;
    });
  };
  for (const method of ['transact', 'admit'])
    wrap(
      runtime.ChatStateV2Backend.prototype,
      method,
      (source, _build, options) => {
        if (options?.checkpoint === true)
          checkpointInputs.push({ ...source, method });
      },
    );
  for (const method of ['commit', 'admit'])
    wrap(runtime.ChatDeltaJournalWriter.prototype, method, (source, input) => {
      for (const write of input.writes)
        parentWrites.push({
          ...source,
          kind: write.kind,
          chatId: write.chatId,
        });
    });
  const pendingCheckpoint =
    runtime.ChatStateV2Backend.prototype.checkpointPendingJournal;
  runtime.ChatStateV2Backend.prototype.checkpointPendingJournal = function (
    trigger,
  ) {
    return context.run(
      {
        phase:
          trigger === 'timer'
            ? 'natural-checkpoint'
            : (context.getStore()?.phase ?? 'ambient'),
        trigger,
      },
      () => Reflect.apply(pendingCheckpoint, this, [trigger]),
    );
  };
  restore.push(() => {
    runtime.ChatStateV2Backend.prototype.checkpointPendingJournal =
      pendingCheckpoint;
  });
  wrap(
    runtime.ChatDeltaJournalWriter.prototype,
    'checkpoint',
    function (source) {
      checkpoints.push({
        ...source,
        sizeDue: this.needsCheckpoint(),
        committedRowChanges: this.hasCommittedRowChanges(),
      });
    },
  );
  const scopes = new Map();
  const ownerStates = new Map();
  const errors = [];
  const outcomes = [];
  const missingOutcomes = [];
  const initialCards = [];
  const allCards = [];
  const continuations = [];
  const rawBaselines = [];
  const placements = [];
  let syntheticCardSeeds = 0;
  let foregroundCommits = 0;
  let startedAt;
  let deadline;
  let schedulePromise;
  let scheduleStartedMs;
  let measurementMs;
  let sequence = 0;
  let primaryState;
  let naturalReferences = 0;
  const counts = Object.fromEntries(
    D11_REQUIRED_CATEGORIES.map((category) => [category, 0]),
  );
  const keyOf = (owner) => `${owner.scope}/${owner.chat}`;
  const primaryKey = keyOf(primary);
  const parent = (owner) => ({
    harnessId: 'claude',
    projectId: 'field-load',
    worktreeId: owner.scope,
    chatId: `chat-${owner.chat}`,
    sessionKey: `field-load/${owner.scope}/chat-${owner.chat}`,
    turnId: `seed-origin-${owner.chat}`,
    toolCallId: `d11-call-${++sequence}`,
    runtimeGeneration: 1,
    depth: 0,
  });
  const targetOf = (card) => ({
    kind: 'delegation',
    chatId: card.chatId,
    delegationId: card.delegationId,
    runGeneration: card.runGeneration,
  });
  const commit = (scope, chatId, mutations) =>
    repository.transact(scope, mutations, {
      source: 'provider',
      chatIds: [chatId],
      mutationId: `d11-foreground:${++sequence}`,
    });
  const drain = async (entry, card) => {
    if (card) await entry.broker.flushCardPublication(targetOf(card));
    for (;;) {
      const captured = entry.ingress;
      await captured;
      if (captured === entry.ingress) break;
    }
    if (errors.length) throw errors[0];
  };
  const emit = async (card, event, publish = true) => {
    const entry = scopes.get(card.scope);
    const run = await barrier(
      entry.launches,
      `${card.delegationId}:${card.runGeneration}`,
    ).promise;
    const eventSequence =
      (entry.sequences.get(`${card.delegationId}:${card.runGeneration}`) ?? 0) +
      1;
    entry.sequences.set(
      `${card.delegationId}:${card.runGeneration}`,
      eventSequence,
    );
    await run.sink({
      delegationId: card.delegationId,
      runGeneration: card.runGeneration,
      sequence: eventSequence,
      occurredAt: 1_000_000 + eventSequence,
      event,
    });
    if (publish) await drain(entry, card);
  };
  const terminal = async (card, status) => {
    await emit(card, {
      type: 'terminal',
      status,
      ...(status === 'completed' ? { finalText: 'D11 scripted answer.' } : {}),
      ...(status === 'failed'
        ? {
            error: {
              code: 'runtime_error',
              message: 'D11 scripted failure',
              retryable: false,
            },
          }
        : {}),
    });
    const entry = scopes.get(card.scope);
    await barrier(
      entry.settlements,
      `${card.delegationId}:${card.runGeneration}`,
    ).promise;
    await drain(entry, card);
  };
  const snapshot = async (card) => {
    const entry = scopes.get(card.scope);
    await drain(entry, card);
    const record = await entry.storage.loadOne(card.delegationId);
    const descriptor = await service.getChildStreamState(
      entry.scope,
      targetOf(card),
    );
    const registered = await entry.port.generation(targetOf(card));
    if (!registered.ok)
      throw new Error(
        `Missing generation ${JSON.stringify({ target: targetOf(card), registration: record?.registration, descriptor, error: registered.error })}`,
      );
    const generation = registered.value;
    if (record?.version !== 3 || !descriptor || !generation)
      throw new Error('Missing durable generation, record or descriptor');
    return { record, descriptor, generation };
  };
  const recordOutcome = async (category, card, extra = {}) => {
    const missingBefore = missingOutcomes.length;
    const evidence = card ? await snapshot(card) : {};
    const completedMs = performance.now() - startedAt;
    const accepted = {
      category,
      foregroundCommits,
      completedMs,
      ...(card
        ? {
            scope: card.scope,
            target: targetOf(card),
            cardId: card.messageId,
            descriptor: {
              streamRevision: evidence.descriptor.streamRevision,
              contentRevision: evidence.descriptor.contentRevision,
              status: evidence.descriptor.status,
            },
            result: evidence.record.latestResult ?? null,
            control: evidence.record.control ?? null,
          }
        : {}),
      ...extra,
    };
    if (!measuring || foregroundCommits === 0)
      missingOutcomes.push(
        `${category}: completed outside measured foreground replay`,
      );
    const terminalStatus = {
      settle: 'completed',
      fail: 'failed',
      stop: 'cancelled',
    }[category];
    if (terminalStatus) {
      const locator = evidence.record.latestResult;
      if (
        locator?.runGeneration !== card.runGeneration ||
        locator.status !== terminalStatus ||
        locator.notified !== true
      )
        missingOutcomes.push(`${category}: missing notified terminal locator`);
      const entry = scopes.get(card.scope);
      const result = requireOk(
        await entry.port.resultByGeneration(targetOf(card)),
      );
      accepted.result = { ...locator, settlementKey: result.settlementKey };
      if (
        result.resultIndex !== locator?.resultIndex ||
        result.runGeneration !== card.runGeneration ||
        result.outcome.status !== terminalStatus
      )
        missingOutcomes.push(
          `${category}: canonical result disagrees with terminal locator`,
        );
    }
    if (
      category === 'start' &&
      (evidence.record.state.runGeneration !== card.runGeneration ||
        evidence.record.state.status !== 'running')
    )
      missingOutcomes.push('start: running generation not durably accepted');
    accepted.completedMs = performance.now() - startedAt;
    accepted.durablyAccepted = missingOutcomes.length === missingBefore;
    outcomes.push(accepted);
    if (accepted.durablyAccepted) counts[category]++;
    return evidence;
  };
  const rawCards = new Map();
  const verifyMerged = async (card, status) => {
    const entry = scopes.get(card.scope);
    let before;
    for (;;) {
      const page = await service.getTranscriptPage({
        ...entry.scope,
        chatId: card.chatId,
        before,
      });
      const row = page.messages.find(
        (message) => message.id === card.messageId,
      );
      if (row) {
        const block = row.blocks.find(
          (value) => value.type === 'delegated_agent_call',
        );
        return (
          block?.status === status &&
          block.delegationId === card.delegationId &&
          block.runGeneration === card.runGeneration
        );
      }
      if (page.before === undefined || page.before === before) return false;
      before = page.before;
    }
  };
  const expectedMerged = new Map();
  const followUp = async (card) => {
    const entry = scopes.get(card.scope);
    requireOk(
      await entry.broker.manage(parent(primary), {
        delegationId: card.delegationId,
        operation: 'follow_up',
        message: 'D11 continuation prompt.',
      }),
    );
    const next = {
      ...card,
      runGeneration: card.runGeneration + 1,
      messageId: runtime.delegationBlockId(
        card.delegationId,
        card.runGeneration + 1,
      ),
    };
    allCards.push(next);
    await barrier(entry.ingested, `${next.delegationId}:${next.runGeneration}`)
      .promise;
    await drain(entry, next);
    const page = await service.getTranscriptPage({
      ...entry.scope,
      chatId: card.chatId,
    });
    continuations.push({
      target: targetOf(next),
      messageId: next.messageId,
      atTail: page.messages.at(-1)?.id === next.messageId,
      occurrences: page.messages.filter(
        (message) => message.id === next.messageId,
      ).length,
    });
    expectedMerged.set(next, 'pending');
    return next;
  };
  const manage = async (card, operation) => {
    const entry = scopes.get(card.scope);
    requireOk(
      await entry.broker.manage(parent(primary), {
        delegationId: card.delegationId,
        operation,
      }),
    );
    const accepted = await entry.storage.loadOne(card.delegationId);
    if (!accepted?.control || accepted.control.operation !== operation)
      throw new Error('Missing admitted control');
    await barrier(entry.controls, accepted.control.operationId).promise;
    const completed = await entry.storage.loadOne(card.delegationId);
    if (completed.control.status !== 'completed')
      throw new Error('Control did not durably complete');
    await recordOutcome(operation, card);
  };
  const runSchedule = async () => {
    const cards = initialCards.filter((card) => card.ownerKey === primaryKey);
    const [ancestor, applyCard, discardCard, failCard] = cards;
    let continuation;
    const entry = scopes.get(primary.scope);
    const actions = {
      'parent-stop': async () => {
        primaryState.paused = deferred();
        await Promise.all(Array.from(primaryState.active));
        await context.run(
          { phase: 'turn-boundary', operation: 'parent-stop' },
          () =>
            runtime.stopChatTurn({ ...entry.scope, chatId: ancestor.chatId }),
        );
        const state = await service.getState({
          ...entry.scope,
          chatIds: [ancestor.chatId],
        });
        if (state.runtimeByChatId?.[ancestor.chatId]?.status !== 'cancelled')
          throw new Error(
            'Normal Stop did not durably cancel the active parent turn',
          );
        await recordOutcome('parent-stop', null, {
          scope: primary.scope,
          chatId: ancestor.chatId,
          api: 'stopChatTurn',
          durableStatus: 'cancelled',
        });
      },
      follow_up: async () => {
        continuation = await followUp(ancestor);
      },
      draft: async () => {
        requireOk(
          await entry.broker.deliverHostMessage(
            continuation.delegationId,
            'D11 queued amendment.',
            randomUUID(),
          ),
        );
        const record = await entry.storage.loadOne(continuation.delegationId);
        if (!record.task.prompt.includes('D11 queued amendment.'))
          throw new Error('Draft amendment was not durably accepted');
      },
      fail: async () => {
        await terminal(failCard, 'failed');
        expectedMerged.set(failCard, 'failed');
        await recordOutcome('fail', failCard);
      },
      start: async () => {
        await emit(continuation, {
          type: 'started',
          nativeSessionId: 'd11-run-2',
        });
        expectedMerged.set(continuation, 'running');
        const evidence = await snapshot(continuation);
        if (
          !JSON.stringify(evidence.descriptor.cardState).includes(
            'D11 queued amendment.',
          )
        )
          throw new Error('Draft amendment was not durably published');
        await recordOutcome('continuation', continuation);
        await recordOutcome('draft', continuation);
        await recordOutcome('start', continuation);
      },
      'settle-apply': async () => {
        await terminal(applyCard, 'completed');
        expectedMerged.set(applyCard, 'completed');
        await recordOutcome('settle', applyCard);
      },
      apply: () => manage(applyCard, 'apply'),
      'settle-discard': async () => {
        await terminal(discardCard, 'completed');
        expectedMerged.set(discardCard, 'completed');
        await recordOutcome('settle', discardCard);
      },
      discard: () => manage(discardCard, 'discard'),
      stop: async () => {
        requireOk(
          await entry.broker.stop(
            parent(primary),
            continuation.delegationId,
            'user_cancelled',
          ),
        );
        await barrier(
          entry.settlements,
          `${continuation.delegationId}:${continuation.runGeneration}`,
        ).promise;
        await drain(entry, continuation);
        expectedMerged.set(continuation, 'cancelled');
        await recordOutcome('stop', continuation);
      },
      'follow_up-final': async () => {
        continuation = await followUp(continuation);
      },
      'start-final': async () => {
        await emit(continuation, {
          type: 'started',
          nativeSessionId: 'd11-run-3',
        });
        expectedMerged.set(continuation, 'running');
        await recordOutcome('continuation', continuation);
        await recordOutcome('start', continuation);
      },
      'settle-final': async () => {
        await terminal(continuation, 'completed');
        expectedMerged.set(continuation, 'completed');
        await recordOutcome('settle', continuation);
      },
      'foreground-resume': async () => {
        await context.run(
          { phase: 'turn-boundary', operation: 'foreground-resume' },
          () =>
            commit(entry.scope, ancestor.chatId, [
              {
                type: 'runtime.patched',
                chatId: ancestor.chatId,
                runtime: { status: 'streaming', queuedMessageIds: [] },
              },
              {
                type: 'message.upserted',
                chatId: ancestor.chatId,
                message: {
                  id: 'd11-resumed-user',
                  role: 'user',
                  timestamp: 2_000_000,
                  blocks: [
                    { type: 'text', text: 'Separate resumed foreground turn' },
                  ],
                },
              },
            ]),
        );
        await recordOutcome('foreground-resume', null, {
          scope: primary.scope,
          chatId: ancestor.chatId,
        });
        primaryState.paused.resolve();
        primaryState.paused = null;
      },
    };
    try {
      for (const step of plan.lifecycleSchedule) {
        try {
          await context.run(
            {
              phase: ['follow_up', 'follow_up-final'].includes(step.operation)
                ? 'creation'
                : 'status',
              operation: step.operation,
            },
            actions[step.operation],
          );
        } catch (error) {
          throw new Error(`D11 stage ${step.operation}: ${error.message}`, {
            cause: error,
          });
        }
      }
    } finally {
      primaryState.paused?.resolve();
      primaryState.paused = null;
    }
  };
  return {
    observeRewrite(record) {
      if (measuring)
        rewriteDiagnostics.push({ ...context.getStore(), diagnostic: record });
    },
    async *seedMessages(owner, chatId, seeded) {
      seeded.bytes = 0;
      const prefix = owner.cardByteFractions.length
        ? owner.cardByteFractions[0] * owner.committedBytes
        : owner.committedBytes;
      // A real oversized tool result supplies a reference-bearing raw row.
      seeded.rows++;
      seeded.bytes += 512;
      yield {
        id: `reference-${chatId}`,
        role: 'assistant',
        timestamp: 1,
        blocks: [
          {
            type: 'tool_result',
            toolUseId: `ref-${chatId}`,
            toolName: 'shell',
            output: 'r'.repeat(73_728),
            isError: false,
          },
        ],
      };
      while (seeded.bytes < prefix) {
        seeded.rows++;
        const row = seedRow(chatId, seeded.rows, owner.meanRowBytes);
        seeded.bytes += Buffer.byteLength(JSON.stringify(row)) + 1;
        yield row;
        if (seeded.rows % 512 === 0)
          await new Promise((resolve) => setImmediate(resolve));
      }
    },
    async attachScope(scopeName, owners, chats, store) {
      const scope = { projectId: 'field-load', worktreeId: scopeName };
      const entry = {
        scope,
        launches: new Map(),
        ingested: new Map(),
        sequences: new Map(),
        settlements: new Map(),
        controls: new Map(),
        ingress: Promise.resolve(),
        store,
      };
      class DurableStorage extends runtime.FileDelegationStorage {
        async commit(record) {
          await super.commit(record);
          if (record.version === 3 && record.latestResult?.notified)
            barrier(
              entry.settlements,
              `${record.state.delegationId}:${record.latestResult.runGeneration}`,
            ).resolve();
          if (
            record.version === 3 &&
            record.control &&
            record.control.status !== 'accepted'
          )
            barrier(entry.controls, record.control.operationId).resolve();
        }
      }
      entry.storage = new DurableStorage(
        join(root, scopeName, 'delegation', 'runs'),
      );
      entry.port = new runtime.RepositoryDelegationTranscriptPort(
        service,
        scope,
      );
      const registry = new runtime.AgentRunnerRegistry();
      registry.register({
        apiVersion: 1,
        registrationId: 'd11-scripted',
        adapter: {
          harnessId: 'd11-scripted',
          adapterVersion: '1',
          runtimeKind: 'local-sdk',
          canRun: () => Promise.resolve({ available: true }),
          start: (request, sink) => {
            barrier(
              entry.launches,
              `${request.delegationId}:${request.runGeneration}`,
            ).resolve({ request, sink });
            return Promise.resolve({ runId: request.delegationId });
          },
          stop: async (handle) => {
            const card = allCards.findLast(
              (candidate) => candidate.delegationId === handle.runId,
            );
            await emit(card, { type: 'terminal', status: 'cancelled' }, false);
            return { stopped: true };
          },
          close: () => Promise.resolve(),
        },
      });
      const cardCount = owners.reduce(
        (sum, owner) => sum + owner.cardByteFractions.length,
        0,
      );
      entry.broker = new runtime.AgentDelegationBroker({
        registry,
        storage: entry.storage,
        cwd: root,
        capacity: Math.max(
          1,
          cardCount - (scopeName === primary.scope ? 1 : 0),
        ),
        maxDepthForParent: () => 5,
        resolveRoute: () =>
          Promise.resolve({
            ok: true,
            value: {
              selectedModelId: 'd11-model',
              runtimeModelId: 'scripted',
              harnessId: 'd11-scripted',
              runtimeKind: 'local-sdk',
              runnerRegistrationId: 'd11-scripted',
              runtimeVersion: '1',
              adapterVersion: '1',
              modelSource: 'test',
              providerType: 'test-inference',
              assignmentRevision: '1',
              billingAuthority: 'native',
              aiCreditsRouted: false,
              capabilities: ['read', 'write', 'worktree', 'progress', 'resume'],
              supportedThinkingLevels: ['low'],
              capabilitySnapshotHash: 'd11',
              capabilityGeneration: 1,
              policyRevision: '1',
              authAccountKey: 'd11-scripted-fixture',
            },
          }),
        authorize: () => Promise.resolve({ ok: true, value: undefined }),
        testOnlyStreamGeneration: true,
        transcriptPort: entry.port,
        prepareWorkspace: (_parent, _task, id) =>
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
        ) => {
          if (operation === 'apply') await hooks.applied([]);
        },
        onError: (error) => errors.push(error),
        onTranscript: (_parent, transcript) => {
          entry.ingress = entry.ingress.then(async () => {
            const outcome = await service.ingestProviderEventWithOutcome({
              ...scope,
              chatId: _parent.chatId,
              data: {
                type: 'canopy_delegation',
                delegation: transcript,
                canopy_turn_user_message_id: transcript.parentTurnId,
              },
              mutationId: `d11-ingest:${++sequence}`,
            });
            if (!['applied', 'not-applied'].includes(outcome))
              throw new Error(`Provider ingestion failed: ${outcome}`);
            barrier(
              entry.ingested,
              `${transcript.delegationId}:${transcript.runGeneration}`,
            ).resolve();
          });
        },
        onSettled: () => Promise.resolve(),
      });
      scopes.set(scopeName, entry);
      await entry.broker.initialize();
      for (const { owner, chatId, seeded } of chats) {
        seeded.bytes = (
          await readFile(
            join(store.directory, 'transcripts', `${chatId}.jsonl`),
          )
        ).length;
        const appendUntil = async (limit) => {
          let rows = [];
          while (seeded.bytes < limit) {
            seeded.rows++;
            const row = seedRow(chatId, seeded.rows, owner.meanRowBytes);
            seeded.bytes += Buffer.byteLength(JSON.stringify(row)) + 1;
            rows.push({ type: 'message.upserted', chatId, message: row });
            if (rows.length === 256) {
              await commit(scope, chatId, rows);
              rows = [];
            }
          }
          if (rows.length) await commit(scope, chatId, rows);
        };
        for (let index = 0; index < owner.cardByteFractions.length; index++) {
          await appendUntil(
            owner.cardByteFractions[index] * owner.committedBytes,
          );
          const isolated =
            keyOf(owner) === primaryKey && [1, 2].includes(index);
          const spawned = requireOk(
            await entry.broker.spawn(parent(owner), {
              modelId: 'd11-model',
              description: 'D11 scripted field card',
              prompt: 'D11 captured-owner task.',
              executionMode: 'background',
              contextPolicy: 'task_only',
              isolation: isolated ? 'worktree' : 'shared_worktree',
              ...(isolated ? { permissions: { writePaths: ['src'] } } : {}),
            }),
          );
          const card = {
            scope: scopeName,
            ownerKey: keyOf(owner),
            chatId,
            capturedFraction: owner.cardByteFractions[index],
            delegationId: spawned.delegationId,
            runGeneration: 1,
            messageId: runtime.delegationBlockId(spawned.delegationId, 1),
          };
          initialCards.push(card);
          allCards.push(card);
          seeded.rows++;
          await emit(card, {
            type: 'started',
            nativeSessionId: `d11-native-${index}`,
          });
          const raw = await service.readStoredParentMessage(
            scope,
            chatId,
            card.messageId,
          );
          seeded.bytes += Buffer.byteLength(JSON.stringify(raw)) + 1;
          if (keyOf(owner) === primaryKey && index === 0)
            await terminal(card, 'completed');
        }
        await appendUntil(owner.committedBytes);
      }
      return {
        commit: (chatId, mutations) => commit(scope, chatId, mutations),
      };
    },
    wrapForeground(owner, next) {
      const state = { paused: null, active: new Set() };
      ownerStates.set(keyOf(owner), state);
      if (keyOf(owner) === primaryKey) primaryState = state;
      return async () => {
        if (state.paused) await state.paused.promise;
        const work = context.run(
          { phase: 'foreground', owner: keyOf(owner) },
          next,
        );
        state.active.add(work);
        try {
          await work;
        } finally {
          state.active.delete(work);
        }
        if (measuring) {
          foregroundCommits++;
          if (!schedulePromise) {
            scheduleStartedMs = performance.now() - startedAt;
            schedulePromise = runSchedule().catch((error) => {
              errors.push(error);
            });
          }
        }
      };
    },
    async prepareMeasurement() {
      for (const entry of scopes.values())
        await repository.flushScope(entry.scope);
      for (const card of initialCards) {
        const entry = scopes.get(card.scope);
        await drain(entry, card);
        rawCards.set(
          card,
          JSON.stringify(
            await service.readStoredParentMessage(
              entry.scope,
              card.chatId,
              card.messageId,
            ),
          ),
        );
      }
      for (const entry of scopes.values())
        for (const owner of plan.owners.filter(
          (candidate) => candidate.scope === entry.scope.worktreeId,
        )) {
          const chatId = `chat-${owner.chat}`;
          const bytes = await readFile(
            join(entry.store.directory, 'transcripts', `${chatId}.jsonl`),
          );
          const references = bytes
            .toString('utf8')
            .split('\n')
            .filter((line) => line.includes('Ref'));
          let offset = 0;
          const expectedCards = new Map(
            initialCards
              .filter(
                (card) =>
                  card.scope === entry.scope.worktreeId &&
                  card.chatId === chatId,
              )
              .map((card) => [card.messageId, card]),
          );
          for (const line of bytes
            .toString('utf8')
            .split('\n')
            .filter(Boolean)) {
            const row = JSON.parse(line);
            if (
              row.blocks?.some((block) => block.type === 'delegated_agent_call')
            ) {
              const card = expectedCards.get(row.id);
              if (!card) syntheticCardSeeds++;
              else
                placements.push({
                  target: targetOf(card),
                  scope: card.scope,
                  capturedFraction: card.capturedFraction,
                  capturedOffsetBytes: Math.round(
                    owner.committedBytes * card.capturedFraction,
                  ),
                  actualOffsetBytes: offset,
                  creationBytes: Buffer.byteLength(line) + 1,
                  placementErrorBytes:
                    offset -
                    Math.round(owner.committedBytes * card.capturedFraction),
                });
            }
            offset += Buffer.byteLength(line) + 1;
          }
          naturalReferences += references.length;
          rawBaselines.push({
            scope: entry.scope.worktreeId,
            chatId,
            file: join(entry.store.directory, 'transcripts', `${chatId}.jsonl`),
            length: bytes.length,
            hash: hash(bytes),
            references,
          });
        }
    },
    begin(start, end) {
      startedAt = start;
      deadline = end;
      measuring = true;
    },
    // Inside the measured window: wait for the lifecycle schedule.
    async drain() {
      if (schedulePromise) await schedulePromise;
      if (errors.length) throw errors[0];
      measuring = false;
      measurementMs = performance.now() - startedAt;
    },
    // After the measured window: the correctness oracle's reads and checks.
    async verify({ foregroundDrainedMs }) {
      if (measurementMs === undefined)
        throw new Error('D11 verify requires a drained schedule');
      let rawCardsUnchanged = true;
      let rawReferencesUnchanged = naturalReferences > 0;
      const rawParents = [];
      for (const baseline of rawBaselines) {
        const bytes = await readFile(baseline.file);
        const unchanged =
          hash(bytes.subarray(0, baseline.length)) === baseline.hash;
        rawParents.push({
          scope: baseline.scope,
          chatId: baseline.chatId,
          preExistingBytes: baseline.length,
          finalBytes: bytes.length,
          prefixUnchanged: unchanged,
        });
        rawCardsUnchanged &&= unchanged;
        const lines = new Set(bytes.toString('utf8').split('\n'));
        rawReferencesUnchanged &&= baseline.references.every((line) =>
          lines.has(line),
        );
      }
      for (const [card, original] of rawCards) {
        const entry = scopes.get(card.scope);
        rawCardsUnchanged &&=
          JSON.stringify(
            await service.readStoredParentMessage(
              entry.scope,
              card.chatId,
              card.messageId,
            ),
          ) === original;
      }
      const mergedReader = [];
      for (const [card, status] of expectedMerged)
        mergedReader.push({
          target: targetOf(card),
          expectedStatus: status,
          passed: await verifyMerged(card, status),
        });
      const lifecycleWrites = parentWrites.filter((write) =>
        ['status', 'creation'].includes(write.phase),
      );
      const evidence = {
        policy: 'd11-cards',
        insideMeasuredReplay:
          foregroundCommits > 0 &&
          scheduleStartedMs >= 0 &&
          scheduleStartedMs <= plan.durationMs &&
          outcomes.every((entry) => entry.completedMs <= measurementMs),
        counts,
        outcomes,
        missingOutcomes,
        delegatedCardRewrites:
          lifecycleWrites.filter((write) =>
            ['patch', 'replace', 'delete'].includes(write.kind),
          ).length +
          rewriteDiagnostics.filter((entry) =>
            entry.diagnostic.chatTranscriptRewritePatchedBlockTypes.includes(
              'delegated_agent_call',
            ),
          ).length,
        rewriteDiagnostics,
        statusForcedCheckpoints:
          checkpointInputs.filter((input) => input.phase === 'status').length +
          checkpoints.filter(
            (checkpoint) =>
              checkpoint.phase === 'status' && !checkpoint.sizeDue,
          ).length,
        rawCardsUnchanged,
        rawReferencesUnchanged,
        continuationTailOnly:
          continuations.length === 2 &&
          continuations.every(
            (entry) => entry.atTail && entry.occurrences === 1,
          ),
        independentMergedReaderPassed:
          mergedReader.length > 0 &&
          mergedReader.every((entry) => entry.passed),
        syntheticCardSeeds,
        genuineSeedCards: initialCards.length,
        placements,
        measurementMs,
        foregroundDrainedMs,
        lifecycleCompletedDuringForeground: outcomes.every(
          (entry) => entry.completedMs <= foregroundDrainedMs,
        ),
        admissionWindowMs: deadline - startedAt,
        scheduleStartedMs,
        foregroundCommits,
        lifecycleSchedule: plan.lifecycleSchedule,
        simulatedExecution: true,
        simulatedWorkspaceControls: true,
        evidenceClass: 'report-only-plain-node-non-release',
        measurementBoundary:
          'Admission stops at the profile deadline; measurement includes draining already-admitted foreground and interleaved lifecycle work. Correctness-oracle reads run after the measured window, its event-loop monitor and its storage activity counters stop.',
        rawParents,
        referenceRows: naturalReferences,
        continuations,
        mergedReader,
        checkpointInputs,
        checkpoints,
        parentWriteCounts: Object.fromEntries(
          ['foreground', 'creation', 'status', 'turn-boundary', 'ambient'].map(
            (phase) => [
              phase,
              parentWrites.filter((write) => write.phase === phase).length,
            ],
          ),
        ),
        placementApproximation:
          'Offsets rounded to the next synthetic filler row; genuine card byte sizes are compensated with filler to retain owner totals. One reference-bearing tool result per owner; first primary card baseline-completed; two measured tail continuations are extra driver rows.',
      };
      return { ...evidence, correctness: evaluateD11Replay(evidence) };
    },
    async close() {
      measuring = false;
      try {
        const closed = await Promise.allSettled(
          Array.from(scopes.values(), async (entry) => {
            try {
              await entry.broker.close();
            } finally {
              await entry.ingress;
            }
          }),
        );
        const failed = closed.find((result) => result.status === 'rejected');
        if (failed)
          throw new Error(
            `D11 cleanup failed; scenario errors: ${errors.map((error) => error.message).join('; ')}`,
            { cause: failed.reason },
          );
      } finally {
        try {
          await service.drain();
        } finally {
          runtime.resetChatStateServiceForTests();
          for (const undo of restore.reverse()) undo();
        }
      }
    },
  };
}

async function load(specifier) {
  const module = await import(specifier);
  return module.default ?? module;
}

/**
 * G7's small runtime gate, not a field replay or a replacement ingestion path.
 * Execution is scripted; persistence, publication and provider ingestion are real.
 * Keep host imports lazy so node:test can report the concrete feasibility failure.
 */
export async function runD11FeasibilityScenario(root) {
  const { ChatStateService } = await load(
    '../../src/main/services/chat-state-service.ts',
  );
  const { ChatStateV2Repository } = await load(
    '../../src/main/services/chat-state-v2-repository.ts',
  );
  const { ChatStorageV2 } = await load('../../src/main/lib/chat-storage-v2.ts');
  const { ChatStateV2Backend } = await load(
    '../../src/main/services/chat-state-v2-backend.ts',
  );
  const { RepositoryDelegationTranscriptPort } = await load(
    '../../src/main/agents/delegation/repository-transcript-port.ts',
  );
  const { AgentDelegationBroker } = await load(
    '../../../../packages/desktop-shared/src/node/delegation/broker.ts',
  );
  const { AgentRunnerRegistry } = await load(
    '../../../../packages/desktop-shared/src/node/delegation/runner-registry.ts',
  );
  const { FileDelegationStorage } = await load(
    '../../../../packages/desktop-shared/src/node/delegation/storage.ts',
  );
  const { readMetadataOfRecord } = await load(
    '../../../../packages/desktop-shared/src/node/delegation/record-v3.ts',
  );
  const { delegationBlockId } = await load(
    '../../../../packages/agent-transcript/src/lib/delegation-transcript.ts',
  );
  const scope = { projectId: 'd11-gate', worktreeId: 'scope' };
  const chatId = 'parent';
  const directory = join(root, scope.projectId, scope.worktreeId);
  const store = new ChatStorageV2(directory, scope.worktreeId, undefined, {
    maxManifestVersion: 4,
  });
  await store.migrate(() =>
    Promise.resolve({
      revision: 0,
      index: { activeTabId: chatId, runtimeByChatId: {} },
      recovery: {
        receipts: [],
        mutationIds: [],
        removedTabIds: [],
        removedArchiveEntryIds: [],
        removedMessageIds: [],
      },
      chats: (async function* () {
        yield await Promise.resolve({
          metadata: { id: chatId, title: chatId, createdAt: '2026-10-01' },
          messages: (async function* () {
            yield await Promise.resolve({
              id: 'seed',
              role: 'assistant',
              timestamp: 1,
              blocks: [{ type: 'text', text: 'gate seed' }],
            });
          })(),
        });
      })(),
    }),
  );
  const backend = new ChatStateV2Backend(store, {
    deltaJournal: {},
    enableFormat4: true,
  });
  try {
    await backend.promoteToDeltaJournal();
    await backend.promoteToFormat4();
    await backend.flush();
  } finally {
    backend.releaseJournal();
    await backend.disposeArtifactMaintenance();
  }
  const repository = new ChatStateV2Repository({
    resolvePaths: () => ({
      tabs: join(directory, `${scope.worktreeId}.json`),
      archives: join(directory, 'archives.json'),
      journal: join(directory, 'journal.json'),
    }),
    enableFormat4: true,
    delegationReadMetadata: readMetadataOfRecord,
  });
  const service = new ChatStateService({
    repository,
    recordDiagnostic: () => undefined,
  });
  const storage = new FileDelegationStorage(
    join(directory, 'delegation', 'runs'),
  );
  const registry = new AgentRunnerRegistry();
  let launch;
  const launched = new Promise((resolve) => {
    launch = resolve;
  });
  registry.register({
    apiVersion: 1,
    registrationId: 'd11-scripted',
    adapter: {
      harnessId: 'd11-scripted',
      adapterVersion: '1',
      runtimeKind: 'local-sdk',
      canRun: () => Promise.resolve({ available: true }),
      start: (request, sink) => {
        launch({ request, sink });
        return Promise.resolve({ runId: request.delegationId });
      },
      stop: () => Promise.resolve({ stopped: true }),
      close: () => Promise.resolve(),
    },
  });
  const errors = [];
  let ingress = Promise.resolve();
  let accepted = 0;
  let notified;
  const settled = new Promise((resolve) => {
    notified = resolve;
  });
  const broker = new AgentDelegationBroker({
    registry,
    storage,
    cwd: root,
    capacity: 1,
    maxDepthForParent: () => 5,
    resolveRoute: () =>
      Promise.resolve({
        ok: true,
        value: {
          selectedModelId: 'd11-model',
          runtimeModelId: 'scripted',
          harnessId: 'd11-scripted',
          runtimeKind: 'local-sdk',
          runnerRegistrationId: 'd11-scripted',
          runtimeVersion: '1',
          adapterVersion: '1',
          modelSource: 'test',
          providerType: 'test-inference',
          assignmentRevision: '1',
          billingAuthority: 'native',
          aiCreditsRouted: false,
          capabilities: ['read', 'progress'],
          supportedThinkingLevels: ['low'],
          capabilitySnapshotHash: 'd11-gate',
          capabilityGeneration: 1,
          policyRevision: '1',
          authAccountKey: 'd11-scripted-fixture',
        },
      }),
    authorize: () => Promise.resolve({ ok: true, value: undefined }),
    testOnlyStreamGeneration: true,
    transcriptPort: new RepositoryDelegationTranscriptPort(service, scope),
    onError: (error) => errors.push(error),
    onTranscript: (_parent, transcript) => {
      ingress = ingress.then(async () => {
        await service.ingestProviderEventWithOutcome({
          ...scope,
          chatId,
          data: {
            type: 'canopy_delegation',
            delegation: transcript,
            canopy_turn_user_message_id: transcript.parentTurnId,
          },
          mutationId: `d11-gate:${++accepted}`,
        });
      });
    },
    onSettled: (_parent, id, result) => {
      notified({ id, result });
      return Promise.resolve();
    },
  });
  try {
    await broker.initialize();
    const spawned = await broker.spawn(
      {
        ...scope,
        harnessId: 'claude',
        chatId,
        sessionKey: `${scope.projectId}/${scope.worktreeId}/${chatId}`,
        turnId: 'gate-origin',
        toolCallId: 'gate-spawn',
        runtimeGeneration: 1,
        depth: 0,
      },
      {
        modelId: 'd11-model',
        description: 'Scripted feasibility gate',
        prompt: 'Produce the scripted gate answer.',
        executionMode: 'background',
        contextPolicy: 'task_only',
        isolation: 'shared_worktree',
      },
    );
    if (!spawned.ok) throw new Error(JSON.stringify(spawned.error));
    const { request, sink } = await launched;
    const target = {
      kind: 'delegation',
      chatId,
      delegationId: request.delegationId,
      runGeneration: request.runGeneration,
    };
    const emit = (sequence, event) =>
      sink({
        delegationId: request.delegationId,
        runGeneration: request.runGeneration,
        sequence,
        occurredAt: 1_000_000 + sequence,
        event,
      });
    await emit(1, { type: 'started', nativeSessionId: 'gate-native' });
    await broker.flushCardPublication(target);
    await ingress;
    await emit(2, {
      type: 'terminal',
      status: 'completed',
      answer: 'Scripted gate answer.',
    });
    const notification = await settled;
    await broker.flushCardPublication(target);
    await ingress;
    const card = await service.readStoredParentMessage(
      scope,
      chatId,
      delegationBlockId(target.delegationId, target.runGeneration),
    );
    return {
      target,
      card,
      notification,
      records: await storage.load(),
      errors,
    };
  } finally {
    try {
      await broker.close();
    } finally {
      try {
        await ingress;
      } finally {
        await service.drain();
      }
    }
  }
}
