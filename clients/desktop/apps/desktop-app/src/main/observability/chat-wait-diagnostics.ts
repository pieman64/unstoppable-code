import { AsyncLocalStorage } from 'node:async_hooks';
import { performance as nativePerformance } from 'node:perf_hooks';
import {
  clearTimeout as nativeClearTimeout,
  setTimeout as nativeSetTimeout,
} from 'node:timers';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import type { SessionDiagnosticRecord } from './service';

// `APP_ADVISOR_BOT_ID` of `@canopy/agent-actions`, without its schema imports.
const APP_ADVISOR_BOT_ID = 'app_advisor';

export interface ChatWaitScope {
  projectId?: string;
  worktreeId?: string;
  taskId?: string;
  chatId?: string;
  botId?: string;
}

type ChatWaitQueueOwner = () =>
  | Pick<ChatWaitOperation, 'id' | 'name'>
  | undefined;

export interface ChatWaitOperation {
  readonly id: string;
  readonly name: string;
  readonly currentPhase: string;
  phase(name: string, queueDepth?: number, scope?: ChatWaitScope): void;
  /** Names the owner of an unowned operation without closing its phase. */
  attributeOwner(scope: ChatWaitScope): void;
  /** Enters `queue_wait`; its records name whichever operation `owner` reports. */
  enterQueue(queueDepth: number, owner: ChatWaitQueueOwner): void;
  /** The current phase closes as failed, whichever call closes it. */
  failPhase(): void;
  claim(): void;
  finish(outcome: 'completed' | 'failed' | 'released'): void;
  noteProjectInventoryCall(): void;
}

interface ChatWaitOptions {
  name: string;
  scope: ChatWaitScope;
  queueDepth: number;
  ownerTokenId?: string;
  operationEpoch?: number;
  gateOwnerInputId?: string;
  gateAgeMs?: () => number;
  stallTimer?: boolean;
  recordEnd?: boolean;
  bounded?: boolean;
  nativeTiming?: boolean;
  record?: (record: SessionDiagnosticRecord) => void;
}

const SLOW_PHASE_MS = 1_000;
const MAX_BOUNDED_RECORDS_PER_MINUTE = 512;
const PAIRED_RECORDS_PER_MINUTE = 128;
const activeOperation = new AsyncLocalStorage<ChatWaitOperation>();
let nextOperationId = 0;
let recordWindowStartedAtMs = 0;
let routineRecordsInWindow = 0;
let pairedRecordsInWindow = 0;
let unspentTerminalRecords = 0;

/*
 * Bounded volume. A stall or a recovery claim opens an interval, so it is
 * admitted only with its terminal records (the close or release, plus the
 * operation's end) paid for up front from the paired allowance. Unspent
 * terminals stay charged to every window they may land in, so no window
 * exceeds the cap.
 *
 * Cap: 512 records per minute, 128 of them paired. Known limit: an operation
 * that never finishes keeps its reservation (two terminals, three with a
 * claim) in every later window, so 63 such stalled operations (42 that also
 * hold a claim) saturate the paired allowance for the life of the process. Once saturated,
 * stall and recovery acquire/release records are dropped; slow-phase closes
 * and ends still record from the routine allowance. Revisit if diagnostics
 * show saturation in practice.
 */
function rollRecordWindow(): void {
  const now = performance.now();
  if (
    now < recordWindowStartedAtMs ||
    now - recordWindowStartedAtMs >= 60_000
  ) {
    recordWindowStartedAtMs = now;
    routineRecordsInWindow = 0;
    pairedRecordsInWindow = unspentTerminalRecords;
  }
}

/** Clears the per-minute record budget that earlier tests' records spent. */
export function resetChatWaitRecordBudgetForTests(): void {
  recordWindowStartedAtMs = 0;
  routineRecordsInWindow = 0;
  pairedRecordsInWindow = 0;
  unspentTerminalRecords = 0;
}

function admitRoutineRecord(): boolean {
  rollRecordWindow();
  if (
    routineRecordsInWindow >=
    MAX_BOUNDED_RECORDS_PER_MINUTE - PAIRED_RECORDS_PER_MINUTE
  )
    return false;
  routineRecordsInWindow += 1;
  return true;
}

function admitPairedRecord(terminalRecords: number): boolean {
  rollRecordWindow();
  if (pairedRecordsInWindow + 1 + terminalRecords > PAIRED_RECORDS_PER_MINUTE)
    return false;
  pairedRecordsInWindow += 1 + terminalRecords;
  unspentTerminalRecords += terminalRecords;
  return true;
}

function spendTerminalRecord(): void {
  rollRecordWindow();
  unspentTerminalRecords = Math.max(0, unspentTerminalRecords - 1);
}

function safeId(value: string | undefined): string | undefined {
  return value && value.length <= 128 && /^[a-zA-Z0-9._:-]+$/.test(value)
    ? value
    : undefined;
}

function safeScope(input: ChatWaitScope): ChatWaitScope {
  const projectId = safeId(input.projectId);
  const worktreeId = safeId(input.worktreeId);
  const taskId = safeId(input.taskId);
  const chatId = safeId(input.chatId);
  const botId = safeId(input.botId);
  return {
    ...(projectId ? { projectId } : {}),
    ...(worktreeId ? { worktreeId } : {}),
    ...(taskId ? { taskId } : {}),
    ...(chatId ? { chatId } : {}),
    ...(botId ? { botId } : {}),
  };
}

function recordLocally(record: SessionDiagnosticRecord): void {
  void import('./index')
    .then(({ getObservabilityService }) => {
      getObservabilityService().recordSessionDiagnostic(record);
    })
    .catch(() => undefined);
}

export interface PurgedWorktreeRecorder {
  readonly record: (record: SessionDiagnosticRecord) => void;
  /** Removes what `record` recorded, with its worktree's later diagnostics. */
  readonly purge: () => Promise<void>;
}

/**
 * Records one operation that runs after its worktree's purge, such as a
 * deletion's watcher commit: its records name the worktree while it runs,
 * and `purge` then removes them with the worktree.
 */
export function recordForPurgedWorktree(): PurgedWorktreeRecorder {
  let delivered = Promise.resolve();
  let recorded:
    | { projectId: string; worktreeId: string; waitOperationId: string }
    | undefined;
  let records = 0;
  return {
    record: (record): void => {
      delivered = delivered
        .then(async () => {
          const { getObservabilityService } = await import('./index');
          getObservabilityService().recordSessionDiagnostic(record);
          records += 1;
          if (record.worktreeId && record.waitOperationId)
            recorded ??= {
              projectId: record.projectId,
              worktreeId: record.worktreeId,
              waitOperationId: record.waitOperationId,
            };
        })
        .catch(() => undefined);
    },
    purge: async (): Promise<void> => {
      try {
        await delivered;
        if (!recorded) return;
        const { getObservabilityService } = await import('./index');
        await getObservabilityService().purgeLateWorktreeSessionDiagnostics(
          recorded.projectId,
          recorded.worktreeId,
          recorded.waitOperationId,
          records,
        );
      } catch {
        // Diagnostics cannot change the operation they observe.
      }
    },
  };
}

export function runWithChatWaitOperation<T>(
  operation: ChatWaitOperation,
  fn: () => T,
): T {
  return activeOperation.run(operation, fn);
}

export function noteProjectInventoryCall(): void {
  activeOperation.getStore()?.noteProjectInventoryCall();
}

/** The phase a queued mutation is in until its body names a narrower one. */
export const GENERIC_MUTATION_PHASE = 'mutation';

/**
 * Attribute a shared dependency await to `name` when the active operation has
 * not named its own phase; an operation that labels its phases keeps them.
 */
export async function withinChatWaitPhase<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  const operation = activeOperation.getStore();
  if (operation?.currentPhase !== GENERIC_MUTATION_PHASE) return fn();
  operation.phase(name);
  try {
    return await fn();
  } catch (error) {
    if (operation.currentPhase === name) operation.failPhase();
    throw error;
  } finally {
    if (operation.currentPhase === name)
      operation.phase(GENERIC_MUTATION_PHASE);
  }
}

export function startChatWaitOperation(
  options: ChatWaitOptions,
): ChatWaitOperation {
  const gateOwnerInputId = safeId(options.gateOwnerInputId);
  let scope = safeScope(options.scope);
  const operationId = `chat-wait-${process.pid}-${++nextOperationId}`;
  const now = (): number =>
    options.nativeTiming ? nativePerformance.now() : performance.now();
  const startedAtMs = now();
  const durations: Record<string, number> = {};
  let currentPhase = 'start';
  let phaseStartedAtMs = startedAtMs;
  let queueDepth = options.queueDepth;
  let inventoryCalls = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let diagnosed = false;
  let stalled = false;
  let phaseFailed = false;
  let finished = false;
  let claimed = false;
  let claimedAtMs: number | undefined;
  let acquiredRecorded = false;
  let queueOwner: ChatWaitQueueOwner | undefined;
  let closeReserved = false;
  let releaseReserved = false;
  let endReserved = false;

  /** Admits an opening record with its terminal and, once, the end. */
  const admitOpening = (): boolean => {
    if (!options.bounded) return true;
    if (!admitPairedRecord(endReserved ? 1 : 2)) return false;
    endReserved = true;
    return true;
  };
  /** Spends a reserved terminal, or admits an unpaired record as routine. */
  const admitTerminal = (reserved: boolean): boolean => {
    if (!options.bounded) return true;
    if (!reserved) return admitRoutineRecord();
    spendTerminalRecord();
    return true;
  };

  const emit = (
    phase: string,
    phaseStart: number,
    elapsedMs: number,
    outcome: 'stalled' | 'completed' | 'failed' | 'released',
    includeDurations = false,
  ): void => {
    try {
      const owner = phase === 'queue_wait' ? queueOwner?.() : undefined;
      // Worktree purges match the top-level IDs: a canonical task scope names
      // its worktree as `taskId`, and the Orchestrator bot's tasks live in its
      // project.
      const projectId =
        scope.projectId ??
        (scope.botId === APP_ADVISOR_BOT_ID ? APP_ADVISOR_PROJECT_ID : '');
      const worktreeId = scope.worktreeId ?? scope.taskId ?? '';
      (options.record ?? recordLocally)({
        version: 1,
        timestamp: new Date().toISOString(),
        kind: 'chat_wait_phase',
        sessionKey: `${scope.projectId ?? scope.botId ?? ''}/${worktreeId}/${scope.chatId ?? ''}`,
        projectId,
        worktreeId,
        chatId: scope.chatId ?? '',
        providerType: 'unknown',
        waitOperationId: operationId,
        waitOperation: options.name,
        waitScope: scope,
        waitPhase: phase,
        ...(phase === 'recovery_acquired' || phase === 'recovery_released'
          ? { waitAwaitingPhase: currentPhase }
          : {}),
        ...(phase === 'recovery_released' && claimedAtMs !== undefined
          ? { waitRecoveryElapsedMs: Math.max(0, now() - claimedAtMs) }
          : {}),
        waitStartedAtMs: phaseStart,
        waitElapsedMs: elapsedMs,
        waitQueueDepth: queueDepth,
        ...(owner
          ? {
              waitQueueOwnerOperationId: owner.id,
              waitQueueOwnerOperation: owner.name,
            }
          : {}),
        waitOutcome: outcome,
        waitProjectInventoryCalls: inventoryCalls,
        ...(options.ownerTokenId
          ? { waitOwnerTokenId: options.ownerTokenId }
          : {}),
        ...(options.operationEpoch === undefined
          ? {}
          : { waitOperationEpoch: options.operationEpoch }),
        ...(gateOwnerInputId === undefined
          ? {}
          : { waitGateOwnerInputId: gateOwnerInputId }),
        ...(options.gateAgeMs === undefined
          ? {}
          : { queueGateAgeMs: options.gateAgeMs() }),
        ...(includeDurations ? { waitPhaseDurationsMs: durations } : {}),
      });
    } catch {
      // Diagnostics cannot change the operation they observe.
    }
  };

  const arm = (): void => {
    if (options.stallTimer === false) return;
    const phase = currentPhase;
    const phaseStart = phaseStartedAtMs;
    const schedule = options.nativeTiming ? nativeSetTimeout : setTimeout;
    timer = schedule(() => {
      if (finished || currentPhase !== phase || phaseStartedAtMs !== phaseStart)
        return;
      diagnosed = true;
      stalled = true;
      if (!admitOpening()) return;
      closeReserved = true;
      emit(phase, phaseStart, now() - phaseStart, 'stalled');
    }, SLOW_PHASE_MS);
    timer.unref?.();
  };

  const closePhase = (outcome: 'completed' | 'failed' | 'released'): void => {
    if (timer)
      (options.nativeTiming ? nativeClearTimeout : clearTimeout)(timer);
    const elapsedMs = Math.max(0, now() - phaseStartedAtMs);
    durations[currentPhase] = (durations[currentPhase] ?? 0) + elapsedMs;
    if (stalled || elapsedMs >= SLOW_PHASE_MS) {
      diagnosed = true;
      if (admitTerminal(closeReserved))
        emit(
          currentPhase,
          phaseStartedAtMs,
          elapsedMs,
          phaseFailed ? 'failed' : outcome,
        );
    }
    stalled = false;
    phaseFailed = false;
    closeReserved = false;
  };

  const enterPhase = (
    name: string,
    nextQueueDepth?: number,
    nextScope?: ChatWaitScope,
    owner?: ChatWaitQueueOwner,
  ): void => {
    if (finished) return;
    closePhase('completed');
    queueOwner = owner;
    currentPhase = name;
    phaseStartedAtMs = now();
    queueDepth = nextQueueDepth ?? queueDepth;
    if (nextScope) scope = safeScope(nextScope);
    arm();
  };

  arm();
  return {
    id: operationId,
    name: options.name,
    get currentPhase(): string {
      return currentPhase;
    },
    phase(name, nextQueueDepth, nextScope): void {
      enterPhase(name, nextQueueDepth, nextScope);
    },
    attributeOwner(nextScope): void {
      if (!finished && Object.keys(scope).length === 0)
        scope = safeScope(nextScope);
    },
    enterQueue(nextQueueDepth, owner): void {
      enterPhase('queue_wait', nextQueueDepth, undefined, owner);
    },
    failPhase(): void {
      if (!finished) phaseFailed = true;
    },
    claim(): void {
      if (finished || claimed) return;
      claimed = true;
      claimedAtMs = now();
      if (!admitOpening()) return;
      releaseReserved = true;
      acquiredRecorded = true;
      emit('recovery_acquired', claimedAtMs, 0, 'completed');
    },
    finish(outcome): void {
      if (finished) return;
      closePhase(outcome);
      finished = true;
      // A refused claim records neither half of the recovery interval.
      if (acquiredRecorded && admitTerminal(releaseReserved)) {
        emit('recovery_released', now(), 0, outcome);
      }
      // A failure is always attributable, even when it was fast.
      if (
        (diagnosed || claimed || options.recordEnd || outcome === 'failed') &&
        admitTerminal(endReserved)
      )
        emit('end', startedAtMs, now() - startedAtMs, outcome, true);
    },
    noteProjectInventoryCall(): void {
      inventoryCalls += 1;
    },
  };
}
