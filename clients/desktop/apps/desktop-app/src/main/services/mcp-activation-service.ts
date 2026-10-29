import { createHash, randomUUID } from 'node:crypto';
import {
  MCP_ACTIVATION_CONTINUATION,
  mcpCapabilityIdentityKey,
  mcpActivationRecordSchema,
  mcpRetryActivationRequestSchema,
  type McpActivationFailure,
  type McpActivationReceipt,
  type McpActivationRecord,
  type McpActivationScope,
  type McpCapabilityIdentity,
  type McpRetryActivationRequest,
} from '@canopy/protocol/mcp-servers';
import type {
  McpSessionAvailability,
  McpSessionBinding,
} from '../mcp/session-availability';
import type { McpActivationStore } from './mcp-activation-store';

export type { McpActivationReceipt } from '@canopy/protocol/mcp-servers';

export interface McpActivationInput {
  binding: McpSessionBinding;
  /** Reserved by the trusted host for the replacement connection. */
  desiredGeneration?: number;
  originatingMessageId: string;
  targets: McpCapabilityIdentity[];
  trigger: 'load' | 'selection' | 'auth';
  toolCallId?: string;
  continuationContextHash?: string;
}

export interface McpActivationAuthClaim {
  binding: McpSessionBinding;
  attemptId: string;
  identity: McpCapabilityIdentity;
  /** Trusted host binding after committed credentials invalidate the original generation. */
  refreshedBinding?: McpSessionBinding;
}

/** Trusted host adapter. Dispatch resolves at provider admission, never enqueue. */
export interface McpActivationHost {
  isCurrent(
    scope: McpActivationScope,
    record: McpActivationRecord,
  ): Promise<boolean>;
  /** Drains the old segment, commits selections under its transition lock, and prepares the owner session. */
  prepare(
    scope: McpActivationScope,
    record: McpActivationRecord,
    signal: AbortSignal,
  ): Promise<McpSessionBinding>;
  /** Rechecks task ownership, generation, cancellation and readiness at the provider boundary. */
  dispatch(
    scope: McpActivationScope,
    record: McpActivationRecord,
    instruction: string,
    signal: AbortSignal,
  ): Promise<'accepted' | 'not_sent' | 'uncertain'>;
  stop(scope: McpActivationScope): Promise<void>;
  /** Read-only provider/canonical reconciliation. An uncertain result must never cause replay. */
  reconcile(
    scope: McpActivationScope,
    record: McpActivationRecord,
  ): Promise<'accepted' | 'not_sent' | 'uncertain'>;
}

interface PendingInstallation {
  controller: AbortController;
  settled: Promise<unknown>;
}

interface ActivationRun {
  scope: McpActivationScope;
  ownerId: string;
  record: McpActivationRecord;
  toolCallId?: string;
  controller: AbortController;
  timeout: ReturnType<typeof setTimeout>;
  running?: Promise<void>;
  pendingWrite?: Promise<boolean>;
  expiring?: boolean;
}

function key(scope: McpActivationScope): string {
  return JSON.stringify([scope.projectId, scope.worktreeId, scope.chatId]);
}

function receipt(record: McpActivationRecord): McpActivationReceipt {
  return {
    activationId: record.activationId,
    attemptId: record.attemptId,
    generation: record.desiredGeneration,
  };
}

const MAX_ACTIVATION_ATTEMPTS = 3;

/** Clients render recovery from this flag, so it must match retry() admission. */
function hasAttemptsLeft(record: McpActivationRecord): boolean {
  return (record.attemptNumber ?? 1) < MAX_ACTIVATION_ATTEMPTS;
}

function targetKey(targets: readonly McpCapabilityIdentity[]): string {
  return createHash('sha256')
    .update(JSON.stringify(targets.map(mcpCapabilityIdentityKey).sort()))
    .digest('hex');
}

function duplicateLoadReceipt(
  previous: McpActivationRecord | undefined,
  input: McpActivationInput,
): McpActivationReceipt | undefined {
  if (!previous || input.trigger !== 'load') return undefined;
  const original = [
    ...(previous.retainedLoads ?? []),
    ...(previous.loadRequest ? [previous.loadRequest] : []),
  ].find(
    (request) =>
      request.toolCallId === input.toolCallId &&
      request.originatingMessageId === input.originatingMessageId &&
      request.provider === input.binding.provider &&
      request.sessionId === input.binding.sessionId &&
      request.generation === input.binding.generation,
  );
  if (!original) return undefined;
  if (
    previous.ownerId !== input.binding.ownerId ||
    original.targetKey !== targetKey(input.targets)
  )
    throw new Error('Load activation identity changed');
  return {
    activationId: original.activationId,
    attemptId: original.attemptId,
    generation: original.desiredGeneration ?? original.generation,
  };
}

/** Host-owned orchestration. Adapters must register only after runtime readiness/admission evidence exists. */
export class McpActivationService {
  private readonly runs = new Map<string, ActivationRun>();
  private readonly pendingInstallations = new Map<
    string,
    Set<PendingInstallation>
  >();
  private readonly cancellations = new Map<string, Promise<void>>();
  private readonly pendingStops = new Set<string>();
  private readonly stopsInFlight = new Map<string, Promise<void>>();
  private readonly initializations = new Map<
    string,
    Promise<McpActivationReceipt>
  >();
  private readonly listeners = new Set<
    (scope: McpActivationScope, record: McpActivationRecord) => void
  >();

  constructor(
    private readonly store: Pick<McpActivationStore, 'read' | 'compareAndSet'>,
    private readonly availability: McpSessionAvailability,
    private readonly host: McpActivationHost,
    private readonly setupTimeoutMs = 600_000,
    private readonly resultTimeoutMs = 30_000,
  ) {
    if (
      !Number.isFinite(setupTimeoutMs) ||
      !Number.isFinite(resultTimeoutMs) ||
      setupTimeoutMs <= 0 ||
      setupTimeoutMs > 600_000 ||
      resultTimeoutMs <= 0 ||
      resultTimeoutMs > 30_000
    )
      throw new Error('Invalid activation deadline');
  }

  subscribe(
    listener: (scope: McpActivationScope, record: McpActivationRecord) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async activate(input: McpActivationInput): Promise<McpActivationReceipt> {
    if (
      input.desiredGeneration !== undefined &&
      input.desiredGeneration < input.binding.generation
    )
      throw new Error('Activation generation is stale');
    const scope = input.binding.scope;
    if (input.trigger === 'load' && !input.toolCallId)
      throw new Error('Load activation requires correlated result delivery');
    const previous = await this.store.read(scope);
    const duplicate = duplicateLoadReceipt(previous, input);
    if (duplicate) return this.afterInitialization(duplicate);
    const priorRequests = [
      ...(previous?.retainedLoads ?? []),
      ...(previous?.loadRequest ? [previous.loadRequest] : []),
    ];
    if (
      this.runs.has(key(scope)) ||
      (previous &&
        (!['completed', 'failed', 'cancelled'].includes(previous.phase) ||
          previous.admission === 'uncertain'))
    )
      throw new Error('Activation recovery is pending');
    const attemptId = randomUUID();
    const activationId = randomUUID();
    const record = mcpActivationRecordSchema.parse({
      version: 1,
      ownerId: input.binding.ownerId,
      activationId,
      attemptId,
      attemptNumber: 1,
      originatingMessageId: input.originatingMessageId,
      providerSessionId: input.binding.sessionId,
      provider: input.binding.provider,
      ...(input.continuationContextHash
        ? { continuationContextHash: input.continuationContextHash }
        : {}),
      ...(input.trigger === 'load'
        ? {
            loadRequest: {
              activationId,
              originatingMessageId: input.originatingMessageId,
              provider: input.binding.provider,
              toolCallId: input.toolCallId,
              sessionId: input.binding.sessionId,
              attemptId,
              generation: input.binding.generation,
              ...(input.desiredGeneration !== undefined
                ? { desiredGeneration: input.desiredGeneration }
                : {}),
              targetKey: targetKey(input.targets),
            },
          }
        : {}),
      ...(previous?.ownerId === input.binding.ownerId &&
      previous.originatingMessageId === input.originatingMessageId
        ? { retainedLoads: priorRequests.slice(-16) }
        : {}),
      trigger: input.trigger,
      requiredTargets: input.targets,
      desiredGeneration: input.desiredGeneration ?? input.binding.generation,
      phase: input.trigger === 'load' ? 'result_pending' : 'preparing',
      cancelled: false,
      retryEligible: false,
      admission: 'not_sent',
    });
    const initialization = this.withInstallation(scope, (signal) =>
      this.initialize(input, previous, record, signal),
    );
    this.initializations.set(record.attemptId, initialization);
    try {
      return await initialization;
    } finally {
      this.initializations.delete(record.attemptId);
    }
  }

  private async withInstallation<T>(
    scope: McpActivationScope,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const scopeKey = key(scope);
    if (this.cancellations.has(scopeKey) || this.pendingStops.has(scopeKey))
      throw new Error('Activation cancellation is pending');
    const controller = new AbortController();
    // Register before the operation starts, including its first durable write.
    const settled = Promise.resolve().then(() => operation(controller.signal));
    const pending = { controller, settled };
    const installations =
      this.pendingInstallations.get(scopeKey) ?? new Set<PendingInstallation>();
    installations.add(pending);
    this.pendingInstallations.set(scopeKey, installations);
    try {
      return await settled;
    } finally {
      installations.delete(pending);
      if (installations.size === 0) this.pendingInstallations.delete(scopeKey);
    }
  }

  private async afterInitialization(
    retained: McpActivationReceipt,
  ): Promise<McpActivationReceipt> {
    // The durable record can be visible before post-commit publication ends.
    // Do not release a duplicate result until its run can receive delivery.
    await this.initializations.get(retained.attemptId);
    return retained;
  }

  private async initialize(
    input: McpActivationInput,
    previous: McpActivationRecord | undefined,
    record: McpActivationRecord,
    signal: AbortSignal,
  ): Promise<McpActivationReceipt> {
    const scope = input.binding.scope;
    if (!(await this.host.isCurrent(scope, record)))
      throw new Error('Activation task changed');
    if (!(await this.store.compareAndSet(scope, previous, record))) {
      const admitted = duplicateLoadReceipt(
        await this.store.read(scope),
        input,
      );
      if (admitted) return this.afterInitialization(admitted);
      throw new Error('Activation task changed');
    }
    if (signal.aborted) return receipt(record);
    const run = this.install(
      scope,
      input.binding.ownerId,
      record,
      input.toolCallId,
    );
    if (record.phase !== 'result_pending') this.launch(run);
    return receipt(record);
  }

  /** Provider result-delivery hook only. Interface acknowledgements cannot release this gate. */
  deliverResult(
    binding: McpSessionBinding,
    activationId: string,
    toolCallId: string,
  ): boolean {
    const run = this.runs.get(key(binding.scope));
    if (
      !run ||
      run.ownerId !== binding.ownerId ||
      run.record.providerSessionId !== binding.sessionId ||
      run.record.provider !== binding.provider ||
      (run.record.loadRequest?.generation ?? run.record.desiredGeneration) !==
        binding.generation ||
      run.record.activationId !== activationId ||
      run.toolCallId !== toolCallId ||
      run.record.phase !== 'result_pending' ||
      run.running
    )
      return false;
    clearTimeout(run.timeout);
    run.timeout = setTimeout(() => {
      void this.expire(run).catch(() => {});
    }, this.setupTimeoutMs);
    this.launch(run);
    return true;
  }

  async retry(
    ownerId: string,
    rawRequest: McpRetryActivationRequest,
  ): Promise<McpActivationReceipt> {
    const request = mcpRetryActivationRequestSchema.parse(rawRequest);
    const previous = await this.store.read(request.scope);
    // Lost replies remain answerable after restart or later task changes.
    // This returns a historical receipt only; it cannot admit more work.
    const retained =
      previous?.ownerId === ownerId &&
      previous.activationId === request.activationId
        ? previous.retryReceipts?.find(
            (row) =>
              row.idempotencyKey === request.idempotencyKey &&
              row.generation === request.expectedGeneration,
          )
        : undefined;
    if (retained)
      return {
        activationId: request.activationId,
        attemptId: retained.attemptId,
        generation: retained.generation,
      };
    if (
      !previous ||
      previous.ownerId !== ownerId ||
      previous.activationId !== request.activationId ||
      previous.desiredGeneration !== request.expectedGeneration ||
      !(await this.host.isCurrent(request.scope, previous))
    )
      throw new Error('Stale activation retry');
    if (
      !previous.retryEligible ||
      previous.admission !== 'not_sent' ||
      previous.cancelled ||
      !hasAttemptsLeft(previous) ||
      this.runs.has(key(request.scope))
    )
      throw new Error('Activation cannot be retried');
    const attemptId = randomUUID();
    const next: McpActivationRecord = {
      ...previous,
      attemptId,
      attemptNumber: (previous.attemptNumber ?? 1) + 1,
      trigger: 'retry',
      retryReceipts: [
        ...(previous.retryReceipts ?? []),
        {
          idempotencyKey: request.idempotencyKey,
          attemptId,
          generation: request.expectedGeneration,
        },
      ],
      phase: 'preparing',
      retryEligible: false,
    };
    delete next.failureCode;
    return this.withInstallation(request.scope, async (signal) => {
      if (!(await this.store.compareAndSet(request.scope, previous, next))) {
        const current = await this.store.read(request.scope);
        const admitted = current?.retryReceipts?.find(
          (row) => row.idempotencyKey === request.idempotencyKey,
        );
        if (admitted && current?.activationId === request.activationId)
          return {
            activationId: current.activationId,
            attemptId: admitted.attemptId,
            generation: admitted.generation,
          };
        throw new Error('Activation retry changed');
      }
      if (!signal.aborted)
        this.launch(this.install(request.scope, ownerId, next));
      return receipt(next);
    });
  }

  /** Callback identity must match before claiming; a wrong callback leaves recovery untouched. */
  async resumeAfterAuth(
    ownerId: string,
    scope: McpActivationScope,
    activationId: string,
    claim?: McpActivationAuthClaim,
  ): Promise<boolean> {
    if (
      !claim ||
      claim.binding.ownerId !== ownerId ||
      key(claim.binding.scope) !== key(scope)
    )
      return false;
    const previous = await this.store.read(scope);
    if (
      !previous ||
      previous.ownerId !== ownerId ||
      previous.activationId !== activationId ||
      previous.attemptId !== claim.attemptId ||
      previous.providerSessionId !== claim.binding.sessionId ||
      previous.provider !== claim.binding.provider ||
      previous.desiredGeneration !== claim.binding.generation ||
      !previous.requiredTargets.some(
        (target) =>
          mcpCapabilityIdentityKey(target) ===
          mcpCapabilityIdentityKey(claim.identity),
      ) ||
      (previous.phase !== 'awaiting_auth' &&
        previous.phase !== 'connecting' &&
        !(
          previous.phase === 'failed' &&
          previous.failureCode === 'stale_task' &&
          claim.refreshedBinding &&
          claim.refreshedBinding.generation > previous.desiredGeneration
        )) ||
      previous.admission !== 'not_sent' ||
      previous.cancelled
    )
      return false;
    const refreshed = claim.refreshedBinding ?? claim.binding;
    if (
      refreshed.ownerId !== ownerId ||
      key(refreshed.scope) !== key(scope) ||
      refreshed.provider !== previous.provider ||
      refreshed.sessionId !== previous.providerSessionId ||
      !Number.isSafeInteger(refreshed.generation) ||
      refreshed.generation < previous.desiredGeneration
    )
      return false;
    const next: McpActivationRecord = {
      ...previous,
      phase: 'preparing',
      desiredGeneration: refreshed.generation,
    };
    delete next.failureCode;
    if (!(await this.host.isCurrent(scope, next))) return false;
    return this.withInstallation(scope, async (signal) => {
      if (!(await this.store.compareAndSet(scope, previous, next)))
        return false;
      if (signal.aborted) return false;
      const oldRun = this.runs.get(key(scope));
      if (oldRun) this.release(oldRun);
      this.launch(this.install(scope, ownerId, next));
      return true;
    });
  }

  async cancel(scope: McpActivationScope): Promise<void> {
    const scopeKey = key(scope);
    const pending = this.cancellations.get(scopeKey);
    if (pending) return pending;
    const cancellation = this.cancelActive(scope);
    this.cancellations.set(scopeKey, cancellation);
    try {
      await cancellation;
    } finally {
      this.cancellations.delete(scopeKey);
    }
  }

  private async cancelActive(scope: McpActivationScope): Promise<void> {
    const scopeKey = key(scope);
    const pendingStop = this.stopsInFlight.get(scopeKey);
    const installations = Array.from(
      this.pendingInstallations.get(scopeKey) ?? [],
    );
    for (const pending of installations) pending.controller.abort();
    const run = this.runs.get(scopeKey);
    let stopRequired =
      this.pendingStops.has(scopeKey) ||
      (run !== undefined && run.record.admission !== 'not_sent');
    run?.controller.abort();
    if (run) this.release(run);
    try {
      // A commit may finish before its acknowledgement. Prevent installation,
      // then observe every settled write before making cancellation durable.
      await Promise.allSettled(installations.map((pending) => pending.settled));
      for (let attempt = 0; attempt < 3; attempt++) {
        const previous = await this.store.read(scope);
        if (
          !previous ||
          previous.phase === 'cancelled' ||
          previous.phase === 'completed'
        )
          return;
        stopRequired ||= previous.admission !== 'not_sent';
        const next: McpActivationRecord = {
          ...previous,
          phase: 'cancelled',
          cancelled: true,
          retryEligible: false,
        };
        if (!(await this.store.compareAndSet(scope, previous, next))) continue;
        this.emit(scope, next);
        return;
      }
      throw new Error('Activation cancellation changed concurrently');
    } finally {
      // A failed provider stop must not leave replay authority in durable state.
      if (stopRequired) await (pendingStop ?? this.stopProvider(scope));
    }
  }

  private stopProvider(scope: McpActivationScope): Promise<void> {
    const scopeKey = key(scope);
    const pending = this.stopsInFlight.get(scopeKey);
    if (pending) return pending;
    // Fence new work before entering the host, and retain the fence on failure.
    this.pendingStops.add(scopeKey);
    const stopping = Promise.resolve().then(async (): Promise<void> => {
      try {
        await this.host.stop(scope);
        this.pendingStops.delete(scopeKey);
      } finally {
        this.stopsInFlight.delete(scopeKey);
      }
    });
    this.stopsInFlight.set(scopeKey, stopping);
    return stopping;
  }

  /** Restart never trusts persisted readiness or blindly dispatches a continuation. */
  async recover(
    scope: McpActivationScope,
  ): Promise<McpActivationRecord | undefined> {
    const previous = await this.store.read(scope);
    if (
      !previous ||
      previous.phase === 'completed' ||
      (['failed', 'cancelled'].includes(previous.phase) &&
        previous.admission !== 'uncertain')
    )
      return previous;
    let next: McpActivationRecord;
    if (previous.cancelled || !(await this.host.isCurrent(scope, previous)))
      next = {
        ...previous,
        phase: 'cancelled',
        cancelled: true,
        // Stop removes replay authority, but native admission may still have
        // settled. Resolve that fact so a later task is not blocked forever.
        admission:
          previous.admission === 'uncertain'
            ? await this.host.reconcile(scope, previous)
            : previous.admission,
        retryEligible: false,
      };
    else if (
      previous.admission === 'uncertain' ||
      previous.admission === 'accepted'
    ) {
      const admission =
        previous.admission === 'accepted'
          ? 'accepted'
          : await this.host.reconcile(scope, previous);
      next =
        admission === 'accepted'
          ? { ...previous, phase: 'completed', admission, retryEligible: false }
          : {
              ...previous,
              phase: 'failed',
              admission,
              failureCode:
                admission === 'uncertain'
                  ? 'admission_uncertain'
                  : 'resume_failed',
              retryEligible:
                admission === 'not_sent' && hasAttemptsLeft(previous),
            };
    } else
      next = {
        ...previous,
        phase: 'failed',
        failureCode:
          previous.phase === 'result_pending'
            ? 'result_delivery_failed'
            : 'startup_failed',
        retryEligible:
          previous.phase !== 'result_pending' && hasAttemptsLeft(previous),
      };
    if (!(await this.store.compareAndSet(scope, previous, next)))
      return this.store.read(scope);
    this.emit(scope, next);
    return next;
  }

  private install(
    scope: McpActivationScope,
    ownerId: string,
    record: McpActivationRecord,
    toolCallId?: string,
  ): ActivationRun {
    const run: ActivationRun = {
      scope: structuredClone(scope),
      ownerId,
      record,
      toolCallId,
      controller: new AbortController(),
      timeout: setTimeout(
        () => {
          void this.expire(run).catch(() => {});
        },
        record.phase === 'result_pending'
          ? this.resultTimeoutMs
          : this.setupTimeoutMs,
      ),
    };
    this.runs.set(key(scope), run);
    this.emit(scope, record);
    return run;
  }

  private launch(run: ActivationRun): void {
    run.running = this.prepareAndResume(run)
      .catch(async (): Promise<void> => {
        if (!run.controller.signal.aborted)
          await this.fail(
            run,
            run.record.admission === 'not_sent'
              ? 'startup_failed'
              : 'admission_uncertain',
          );
      })
      .finally(() => {
        // Expiry keeps ownership until its durable transition has settled.
        if (!run.expiring) this.release(run);
      });
    // Store failure keeps the last durable record for restart reconciliation.
    void run.running.catch(() => {});
  }

  private async prepareAndResume(run: ActivationRun): Promise<void> {
    if (!(await this.host.isCurrent(run.scope, run.record)))
      return this.fail(run, 'stale_task');
    if (!(await this.update(run, { phase: 'preparing' }))) return;
    const binding = await this.host.prepare(
      run.scope,
      structuredClone(run.record),
      run.controller.signal,
    );
    run.controller.signal.throwIfAborted();
    if (
      binding.ownerId !== run.ownerId ||
      binding.provider !== run.record.provider ||
      key(binding.scope) !== key(run.scope) ||
      binding.generation !== run.record.desiredGeneration
    )
      return this.fail(run, 'stale_task');
    if (
      !(await this.update(run, {
        phase: 'connecting',
        providerSessionId: binding.sessionId,
      }))
    )
      return;
    const readiness = await this.availability.waitForRequiredTargets(
      binding,
      run.record.requiredTargets,
      { timeoutMs: this.setupTimeoutMs, signal: run.controller.signal },
    );
    if (readiness.kind === 'cancelled') {
      if (!run.controller.signal.aborted) await this.fail(run, 'stale_task');
      return;
    }
    if (readiness.kind === 'awaiting_auth') {
      await this.update(run, { phase: 'awaiting_auth' });
      return;
    }
    if (readiness.kind === 'failed')
      return this.fail(
        run,
        readiness.reasonCode === 'unchecked' ||
          readiness.reasonCode === 'disconnected'
          ? 'startup_failed'
          : readiness.reasonCode,
      );
    if (!(await this.host.isCurrent(run.scope, run.record)))
      return this.fail(run, 'stale_task');
    const statuses = this.availability.snapshot(binding);
    if (
      !run.record.requiredTargets.every((target) =>
        statuses.some(
          (status) =>
            mcpCapabilityIdentityKey(status.identity) ===
              mcpCapabilityIdentityKey(target) &&
            status.availability === 'ready',
        ),
      )
    )
      return this.fail(run, 'startup_failed');
    // Commit uncertainty before crossing the provider boundary. A thrown/lost reply is never evidence of non-admission.
    if (
      !(await this.update(run, { phase: 'resuming', admission: 'uncertain' }))
    )
      return;
    run.controller.signal.throwIfAborted();
    const admission = await this.host.dispatch(
      run.scope,
      structuredClone(run.record),
      MCP_ACTIVATION_CONTINUATION,
      run.controller.signal,
    );
    run.controller.signal.throwIfAborted();
    if (admission === 'accepted')
      await this.update(run, {
        admission,
        phase: 'completed',
        retryEligible: false,
      });
    else if (admission === 'not_sent') {
      await this.update(run, { admission });
      await this.fail(run, 'resume_failed');
    } else await this.fail(run, 'admission_uncertain');
  }

  private async update(
    run: ActivationRun,
    patch: Partial<McpActivationRecord>,
  ): Promise<boolean> {
    if (run.controller.signal.aborted) return false;
    const next = mcpActivationRecordSchema.parse({ ...run.record, ...patch });
    const write = this.store.compareAndSet(run.scope, run.record, next);
    run.pendingWrite = write;
    if (!(await write)) return false;
    run.record = next;
    if (!run.controller.signal.aborted) this.emit(run.scope, next);
    return !run.controller.signal.aborted;
  }

  private async fail(
    run: ActivationRun,
    failureCode: McpActivationFailure,
  ): Promise<void> {
    await this.update(run, {
      phase: 'failed',
      failureCode,
      retryEligible:
        run.record.admission === 'not_sent' &&
        hasAttemptsLeft(run.record) &&
        ['timeout', 'startup_failed', 'resume_failed'].includes(failureCode),
    });
  }

  private async expire(run: ActivationRun): Promise<void> {
    if (this.runs.get(key(run.scope)) !== run || run.expiring) return;
    // Invalidate dispatch immediately, then wait for a phase commit already in flight.
    run.expiring = true;
    run.controller.abort();
    try {
      await run.pendingWrite;
      for (let attempt = 0; attempt < 3; attempt++) {
        const current = await this.store.read(run.scope);
        if (
          this.runs.get(key(run.scope)) !== run ||
          !current ||
          current.activationId !== run.record.activationId ||
          current.attemptId !== run.record.attemptId ||
          current.desiredGeneration !== run.record.desiredGeneration
        )
          return;
        run.record = current;
        if (['completed', 'failed', 'cancelled'].includes(current.phase))
          return;
        const failureCode =
          current.phase === 'result_pending'
            ? 'result_delivery_failed'
            : current.admission === 'not_sent'
              ? 'timeout'
              : 'admission_uncertain';
        const next = mcpActivationRecordSchema.parse({
          ...current,
          phase: 'failed',
          failureCode,
          retryEligible: failureCode === 'timeout' && hasAttemptsLeft(current),
        });
        if (!(await this.store.compareAndSet(run.scope, current, next)))
          continue;
        run.record = next;
        this.emit(run.scope, next);
        return;
      }
      throw new Error('Activation expiry changed concurrently');
    } finally {
      const ownsRun = this.runs.get(key(run.scope)) === run;
      run.expiring = false;
      this.release(run);
      if (
        ownsRun &&
        run.record.admission !== 'not_sent' &&
        run.record.phase !== 'completed'
      )
        await this.stopProvider(run.scope);
    }
  }

  private release(run: ActivationRun): void {
    clearTimeout(run.timeout);
    if (run.record.phase !== 'completed') run.controller.abort();
    if (this.runs.get(key(run.scope)) === run) this.runs.delete(key(run.scope));
  }

  private emit(scope: McpActivationScope, record: McpActivationRecord): void {
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(structuredClone(scope), structuredClone(record));
      } catch {
        /* Publication cannot change a durable admission. */
      }
    }
  }
}
