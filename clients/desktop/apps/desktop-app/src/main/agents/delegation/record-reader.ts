import type {
  DelegatedAgentCallBlock,
  PersistedChatMessage,
} from '@canopy/agent-transcript';
import { overlayStreamBackedDelegationCard } from '@canopy/agent-transcript';
import type {
  AgentDelegationSnapshot,
  AgentDelegationStatus,
} from '@canopy/protocol/delegation';
import type { DelegationRecordReadMetadata } from '@canopy/desktop-shared/node/delegation/record-read-metadata';
import { validateDelegationRecordReadMetadata } from '@canopy/desktop-shared/node/delegation/record-read-metadata';
import type {
  DelegationTranscriptGeneration,
  DelegationTranscriptGenerationRequest,
  DelegationTranscriptPortError,
  DelegationTranscriptResultEntry,
  DelegationTranscriptStreamState,
  DelegationTranscriptTarget,
} from '@canopy/desktop-shared/node/delegation/transcript-port';
import { DELEGATION_REGISTRY_MAX_PAGE_LIMIT } from '@canopy/desktop-shared/node/delegation/transcript-port';
import {
  delegationNestingState,
  delegationPhase,
  delegationQueueIdentity,
  type StoredDelegation,
} from '@canopy/desktop-shared/node/delegation/broker';
import {
  currentStopPolicy,
  delegationRecordLastActivityAt,
  legacyPrefixView,
} from '@canopy/desktop-shared/node/delegation/record-v3';
import { DelegationRegistryOperationError } from '../../lib/chat-delta-journal/delegation-registry-error';
import { projectAgentRoute } from '@canopy/desktop-shared/node/delegation/route';
import type { ChatScopeKey } from '../../services/chat-state-contracts';
import type {
  DelegationGenerationOutcome,
  DelegationRecordReader,
  DelegationRecordReadInput,
  ResolvedDelegationGeneration,
} from './record-reader-contract';
import type { DelegationRecordReadPort } from './repository-transcript-port';

export type { DelegationRecordReadPort } from './repository-transcript-port';

export interface DelegationRecordReaderDependencies {
  readonly port: DelegationRecordReadPort;
  readonly scope: ChatScopeKey;
}

function unsupported<T>(): Promise<T> {
  return Promise.reject(
    new Error('Stream-backed delegation readers are not available yet'),
  );
}

/** Compatibility default: no metadata source keeps every call on A0 behavior. */
export class UnsupportedDelegationRecordReader implements DelegationRecordReader {
  public resolveActivity(): Promise<number> {
    return unsupported();
  }

  public resolveGenerationOutcome(): Promise<DelegationGenerationOutcome> {
    return unsupported();
  }

  public resolveGenerationHeader(): Promise<ResolvedDelegationGeneration> {
    return unsupported();
  }

  public resolveGenerationList(): Promise<
    readonly ResolvedDelegationGeneration[]
  > {
    return unsupported();
  }
}

function validatedMetadata(
  input: DelegationRecordReadInput,
): DelegationRecordReadMetadata | undefined {
  return input.readMetadata === undefined
    ? undefined
    : validateDelegationRecordReadMetadata(input.record, input.readMetadata);
}

function legacyHistory(
  record: StoredDelegation,
): readonly ResolvedDelegationGeneration[] {
  return (legacyPrefixView(record).history ?? []).map((transcript) => ({
    kind: 'legacy',
    runGeneration: transcript.runGeneration,
  }));
}

function generationRequest(
  target: DelegationTranscriptTarget,
): DelegationTranscriptGenerationRequest {
  return {
    chatId: target.chatId,
    delegationId: target.delegationId,
    runGeneration: target.runGeneration,
  };
}

function failureOf(error: unknown): DelegationTranscriptPortError {
  if (error instanceof DelegationRegistryOperationError)
    return structuredClone(error.failure);
  return {
    code: 'storage_failure',
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
  };
}

function notFoundFailure(): DelegationTranscriptPortError {
  return {
    code: 'not_found',
    message: 'The delegation generation was not found.',
    retryable: false,
  };
}

function targetForGeneration(
  metadata: DelegationRecordReadMetadata,
  runGeneration: number,
): DelegationTranscriptTarget {
  return { ...metadata.current.target, runGeneration };
}

function streamState(
  generation: DelegationTranscriptGeneration,
): DelegationTranscriptStreamState | null {
  if (generation.stream === null) return null;
  return {
    target: generation.stream.target,
    status: generation.stream.status,
    streamRevision: generation.stream.streamRevision,
    openedAt: generation.stream.openedAt,
    latestRowTimestamp: generation.stream.latestRowTimestamp,
    cardState: generation.stream.cardState,
  };
}

function cardFromMessage(
  message: PersistedChatMessage | undefined,
  entry: DelegationTranscriptGeneration['entry'],
): DelegatedAgentCallBlock | undefined {
  const block = message?.blocks.find(
    (candidate) =>
      candidate.type === 'delegated_agent_call' &&
      candidate.delegationId === entry.delegationId &&
      candidate.runGeneration === entry.runGeneration,
  );
  return block?.type === 'delegated_agent_call' ? block : undefined;
}

function cardSnapshot(
  card: DelegatedAgentCallBlock | undefined,
  delegationId: string,
  status: AgentDelegationStatus,
  durableState = false,
): AgentDelegationSnapshot {
  return {
    delegationId,
    status,
    outputTruncated: card?.outputTruncated ?? false,
    ...(card?.depth === undefined ? {} : { depth: card.depth }),
    ...(card?.nestedDelegation === undefined
      ? {}
      : { nestedDelegation: card.nestedDelegation }),
    ...(card?.parentDelegationId === undefined
      ? {}
      : { parentDelegationId: card.parentDelegationId }),
    ...(card?.parentDescription === undefined
      ? {}
      : { parentDescription: card.parentDescription }),
    ...(card?.permissions === undefined
      ? {}
      : { permissions: card.permissions }),
    ...(card?.workspaceDiscarded === undefined
      ? {}
      : { workspaceDiscarded: card.workspaceDiscarded }),
    ...(card?.routeSnapshot === undefined
      ? {}
      : { routeSnapshot: card.routeSnapshot }),
    ...(card?.requestedModelId === undefined
      ? {}
      : { requestedModelId: card.requestedModelId }),
    ...(card?.isolatedWorkspace === undefined
      ? {}
      : { isolatedWorkspace: card.isolatedWorkspace }),
    ...(card?.approvalPending === undefined
      ? {}
      : { approvalPending: card.approvalPending }),
    ...(card?.nativeSessionId === undefined
      ? {}
      : { nativeSessionId: card.nativeSessionId }),
    ...(card?.partialText === undefined
      ? {}
      : { partialText: card.partialText }),
    ...(card?.finalText === undefined ? {} : { finalText: card.finalText }),
    ...(card?.childDelegationIds === undefined
      ? {}
      : { childDelegationIds: card.childDelegationIds }),
    ...(card?.capabilities === undefined
      ? {}
      : { capabilities: card.capabilities }),
    ...(card?.phase === undefined ? {} : { phase: card.phase }),
    ...(card?.queue === undefined ? {} : { queue: card.queue }),
    ...(durableState && card?.control !== undefined
      ? { control: card.control }
      : {}),
    ...(durableState && card?.resultIndex !== undefined
      ? { resultIndex: card.resultIndex }
      : {}),
    ...(durableState && card?.error !== undefined ? { error: card.error } : {}),
    ...(durableState && card?.usage !== undefined ? { usage: card.usage } : {}),
    ...(durableState && card?.stopReason !== undefined
      ? { stopReason: card.stopReason }
      : {}),
    ...(durableState && card?.cancelledByUser !== undefined
      ? { cancelledByUser: card.cancelledByUser }
      : {}),
    ...(durableState && card?.stoppedBy !== undefined
      ? { stoppedBy: card.stoppedBy }
      : {}),
  };
}

function currentControlSnapshot(
  record: StoredDelegation,
): AgentDelegationSnapshot['control'] {
  const control = record.control;
  if (!control) return undefined;
  return {
    operationId: control.operationId,
    operation: control.operation,
    status: control.status,
    ...(control.steeringDelivery === undefined
      ? {}
      : { steeringDelivery: control.steeringDelivery }),
    ...(control.error === undefined ? {} : { error: control.error }),
    ...(control.applyFailure === undefined
      ? {}
      : { applyFailure: control.applyFailure }),
  };
}

function currentSnapshot(
  record: StoredDelegation,
  base: AgentDelegationSnapshot,
  status: AgentDelegationStatus,
  includeRecordOutcome: boolean,
): AgentDelegationSnapshot {
  const state = record.state;
  const route = record.route;
  const control = currentControlSnapshot(record);
  const { stopRequested } = currentStopPolicy(record);
  const permissions = { writePaths: record.task.permissions?.writePaths ?? [] };
  const nestedDelegation = delegationNestingState(record);
  return {
    delegationId: base.delegationId,
    runGeneration: base.runGeneration,
    ...(base.partialText === undefined
      ? {}
      : { partialText: base.partialText }),
    ...(base.finalText === undefined ? {} : { finalText: base.finalText }),
    status,
    depth: record.depth ?? record.parent.depth + 1,
    ...(nestedDelegation === undefined ? {} : { nestedDelegation }),
    phase:
      status === 'running'
        ? 'running'
        : status === 'pending'
          ? delegationPhase(record)
          : 'idle',
    queue: delegationQueueIdentity(),
    ...(record.executionCwd
      ? {
          isolatedWorkspace: {
            revision: record.isolationRevision ?? '',
            dirtyParentChangesIncluded: false,
          },
        }
      : {}),
    ...(record.workspaceObservation === undefined
      ? {}
      : { workspaceObservation: record.workspaceObservation }),
    ...(record.capabilityGrant === undefined
      ? {}
      : { capabilities: record.capabilityGrant.summary }),
    outputTruncated: includeRecordOutcome
      ? state.outputTruncated
      : base.outputTruncated,
    ...(record.parentDelegationId === undefined
      ? {}
      : { parentDelegationId: record.parentDelegationId }),
    ...(record.parentDescription === undefined
      ? {}
      : { parentDescription: record.parentDescription }),
    permissions,
    ...(record.workspaceDiscarded === undefined
      ? {}
      : { workspaceDiscarded: record.workspaceDiscarded }),
    ...(route === undefined
      ? { requestedModelId: record.task.modelId }
      : { routeSnapshot: projectAgentRoute(route) }),
    ...(control === undefined ? {} : { control }),
    ...(stopRequested === undefined
      ? {}
      : {
          stopRequested: {
            operationId: stopRequested.operationId,
            status: stopRequested.status,
          },
        }),
    ...(state.approvalPending === undefined
      ? {}
      : { approvalPending: state.approvalPending }),
    ...(state.nativeSessionId === undefined || record.notificationOnly
      ? {}
      : { nativeSessionId: state.nativeSessionId }),
    ...(includeRecordOutcome && state.error !== undefined
      ? { error: state.error }
      : {}),
    ...(includeRecordOutcome && state.usage !== undefined
      ? { usage: state.usage }
      : {}),
    ...(includeRecordOutcome && state.stopReason !== undefined
      ? { stopReason: state.stopReason }
      : {}),
    ...(includeRecordOutcome && state.cancelledByUser !== undefined
      ? { cancelledByUser: state.cancelledByUser }
      : {}),
    ...(includeRecordOutcome && state.stoppedBy !== undefined
      ? { stoppedBy: state.stoppedBy }
      : {}),
  };
}

function canonicalSnapshot(
  base: AgentDelegationSnapshot,
  result: DelegationTranscriptResultEntry,
): AgentDelegationSnapshot {
  const outcome = result.outcome;
  return {
    ...base,
    status: outcome.status,
    resultIndex: result.resultIndex,
    ...(outcome.error === undefined ? {} : { error: outcome.error }),
    ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
    ...(outcome.stopReason === undefined
      ? {}
      : { stopReason: outcome.stopReason }),
  };
}

function taskForGeneration(
  card: DelegatedAgentCallBlock | undefined,
  executionMode: DelegationTranscriptGeneration['entry']['executionMode'],
): {
  readonly description: string;
  readonly prompt: string;
  readonly executionMode: DelegationTranscriptGeneration['entry']['executionMode'];
} {
  return {
    description: card?.description ?? '',
    prompt: card?.prompt ?? '',
    executionMode: card?.executionMode ?? executionMode,
  };
}

function generationFailure(
  target: DelegationTranscriptTarget,
  runGeneration: number,
  failure: DelegationTranscriptPortError,
): ResolvedDelegationGeneration {
  return {
    kind: 'content_unavailable',
    runGeneration,
    target,
    failure,
  };
}

class RepositoryDelegationRecordReader implements DelegationRecordReader {
  public constructor(
    private readonly dependencies: DelegationRecordReaderDependencies,
  ) {}

  public async resolveActivity(
    input: DelegationRecordReadInput,
  ): Promise<number> {
    const metadata = validatedMetadata(input);
    if (!metadata || metadata.current.store === 'legacy')
      return delegationRecordLastActivityAt(input.record);
    const descriptor = await this.dependencies.port.getChildStreamState(
      this.dependencies.scope,
      metadata.current.target,
    );
    if (
      descriptor &&
      (descriptor.target.chatId !== metadata.current.target.chatId ||
        descriptor.target.delegationId !==
          metadata.current.target.delegationId ||
        descriptor.target.runGeneration !==
          metadata.current.target.runGeneration)
    )
      throw new Error('Delegation transcript descriptor target did not match.');
    return Math.max(
      metadata.lastActivityAt,
      descriptor?.openedAt ?? 0,
      descriptor?.latestRowTimestamp ?? 0,
      input.record.state.startedAt ?? 0,
      input.record.state.finishedAt ?? 0,
      input.record.control?.occurredAt ?? 0,
      (legacyPrefixView(input.record).controls ?? []).reduce(
        (latest, control) => Math.max(latest, control.occurredAt ?? 0),
        0,
      ),
    );
  }

  public async resolveGenerationOutcome(
    input: DelegationRecordReadInput,
    runGeneration: number,
  ): Promise<DelegationGenerationOutcome> {
    const metadata = validatedMetadata(input);
    if (!metadata || metadata.current.store === 'legacy')
      return { kind: 'unsettled' };
    if (!validGenerationNumber(runGeneration))
      return { kind: 'unavailable', failure: invalidGenerationFailure() };
    const target = targetForGeneration(metadata, runGeneration);
    try {
      const generation = await this.dependencies.port.generation(
        this.dependencies.scope,
        generationRequest(target),
      );
      if (generation) {
        return validGeneration(generation, target)
          ? outcomeFromGeneration(generation)
          : { kind: 'unavailable', failure: corruptionFailure() };
      }
      const result = await this.dependencies.port.resultByGeneration(
        this.dependencies.scope,
        generationRequest(target),
      );
      if (result && result.runGeneration !== runGeneration)
        return { kind: 'unavailable', failure: corruptionFailure() };
      return result
        ? { kind: 'settled', result }
        : { kind: 'unavailable', failure: notFoundFailure() };
    } catch (error) {
      return { kind: 'unavailable', failure: failureOf(error) };
    }
  }

  public async resolveGenerationHeader(
    input: DelegationRecordReadInput,
    runGeneration: number,
  ): Promise<ResolvedDelegationGeneration> {
    const metadata = validatedMetadata(input);
    if (
      !metadata ||
      metadata.current.store === 'legacy' ||
      isLegacyPrefixGeneration(input.record, runGeneration)
    )
      return { kind: 'legacy', runGeneration };
    if (!validGenerationNumber(runGeneration))
      return generationFailure(
        targetForGeneration(metadata, runGeneration),
        runGeneration,
        invalidGenerationFailure(),
      );
    const target = targetForGeneration(metadata, runGeneration);
    let generation: DelegationTranscriptGeneration | undefined;
    try {
      generation = await this.dependencies.port.generation(
        this.dependencies.scope,
        generationRequest(target),
      );
    } catch (error) {
      return generationFailure(target, runGeneration, failureOf(error));
    }
    if (!generation)
      return generationFailure(target, runGeneration, notFoundFailure());
    if (!validGeneration(generation, target))
      return generationFailure(target, runGeneration, corruptionFailure());
    if (generation.entry.store === 'legacy')
      return { kind: 'legacy', runGeneration };
    return this.resolveStreamGeneration(input, metadata, generation);
  }

  public async resolveGenerationList(
    input: DelegationRecordReadInput,
  ): Promise<readonly ResolvedDelegationGeneration[]> {
    const metadata = validatedMetadata(input);
    if (!metadata || metadata.current.store === 'legacy')
      return legacyHistory(input.record);

    const generations: ResolvedDelegationGeneration[] = [];
    const seenGenerations = new Set<number>();
    for (const transcript of legacyPrefixView(input.record).history ?? []) {
      if (seenGenerations.has(transcript.runGeneration)) continue;
      seenGenerations.add(transcript.runGeneration);
      generations.push({
        kind: 'legacy',
        runGeneration: transcript.runGeneration,
      });
    }

    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.dependencies.port.generationsPage(
        this.dependencies.scope,
        {
          chatId: metadata.current.target.chatId,
          delegationId: metadata.current.target.delegationId,
          limit: DELEGATION_REGISTRY_MAX_PAGE_LIMIT,
          ...(cursor === undefined ? {} : { cursor }),
        },
      );
      for (const generation of page.generations) {
        const runGeneration = generation.entry.runGeneration;
        if (seenGenerations.has(runGeneration)) continue;
        const expectedTarget = targetForGeneration(metadata, runGeneration);
        if (!validGeneration(generation, expectedTarget))
          throw new Error('Delegation generation page identity did not match.');
        seenGenerations.add(runGeneration);
        if (generation.entry.store === 'legacy') {
          generations.push({ kind: 'legacy', runGeneration });
          continue;
        }
        generations.push(
          await this.resolveStreamGeneration(input, metadata, generation),
        );
      }
      cursor = page.cursor;
      if (cursor !== undefined) {
        if (seenCursors.has(cursor))
          throw new Error('Delegation generation page cursor repeated.');
        seenCursors.add(cursor);
      }
    } while (cursor !== undefined);
    return generations;
  }

  private async resolveStreamGeneration(
    input: DelegationRecordReadInput,
    metadata: DelegationRecordReadMetadata,
    generation: DelegationTranscriptGeneration,
  ): Promise<ResolvedDelegationGeneration> {
    const entry = generation.entry;
    const target = targetForGeneration(metadata, entry.runGeneration);
    const current =
      entry.runGeneration === input.record.state.runGeneration &&
      entry.delegationId === input.record.state.delegationId;
    const result = generation.result;
    const settling =
      result === null &&
      metadata.settling?.runGeneration === entry.runGeneration;
    let status: AgentDelegationStatus = result
      ? result.outcome.status
      : settling
        ? 'running'
        : current
          ? input.record.state.status
          : 'interrupted';
    let card: DelegatedAgentCallBlock | undefined;
    if (entry.origin.anchorMessageId !== undefined) {
      try {
        const message = await this.dependencies.port.readStoredParentMessage(
          this.dependencies.scope,
          entry.chatId,
          entry.origin.anchorMessageId,
        );
        card = cardFromMessage(message, entry);
      } catch (error) {
        const failure = failureOf(error);
        if (failure.code !== 'not_found' && failure.code !== 'unauthorized')
          return generationFailure(target, entry.runGeneration, failure);
      }
    }
    const stream = generation.stream;
    const cardState = stream?.cardState;
    const durableState = cardState?.version === 2 && card !== undefined;
    if (stream !== null && card !== undefined) {
      card = overlayStreamBackedDelegationCard(
        card,
        stream.cardState ?? null,
        stream.streamRevision,
      );
      // Registry outcomes, settling and old-generation status keep their
      // existing precedence over descriptor display. Only V2 state owns
      // current status; V1 and null retain the live record's precedence.
      if (durableState && !result && !settling && current) status = card.status;
    }
    const task = taskForGeneration(card, entry.executionMode);
    const base: AgentDelegationSnapshot = {
      ...cardSnapshot(card, entry.delegationId, status, durableState),
      runGeneration: entry.runGeneration,
    };
    let currentBase = current
      ? currentSnapshot(input.record, base, status, result === null)
      : base;
    if (durableState) {
      // Overlay raw storage first, then restore only the reader's existing
      // live-only metadata. Never let a retained record overwrite a durable
      // route, truncation, control result or post-settle workspace update.
      const live = currentBase;
      currentBase = { ...base };
      if (
        current &&
        !result &&
        (status === 'running' || status === 'pending')
      ) {
        currentBase = {
          ...currentBase,
          ...(live.phase === undefined ? {} : { phase: live.phase }),
          ...(live.queue === undefined ? {} : { queue: live.queue }),
          ...(live.approvalPending === undefined
            ? {}
            : { approvalPending: live.approvalPending }),
          ...(live.stopRequested === undefined
            ? {}
            : { stopRequested: live.stopRequested }),
          ...(live.workspaceObservation === undefined
            ? {}
            : { workspaceObservation: live.workspaceObservation }),
          ...(live.control?.status === 'accepted'
            ? { control: live.control }
            : {}),
        };
      }
      if (result) {
        // Missing registry outcome fields clear descriptor fallbacks just as
        // they cleared retained-record fields before V2 display existed.
        const { error, usage, stopReason, ...withoutOutcome } = currentBase;
        void error;
        void usage;
        void stopReason;
        currentBase = withoutOutcome;
      }
    }
    const snapshot = result
      ? canonicalSnapshot(currentBase, result)
      : currentBase;
    if (settling)
      return {
        kind: 'settling',
        runGeneration: entry.runGeneration,
        target,
        entry,
        stream: streamState(generation),
        snapshot: { ...snapshot, status: 'running' },
        ...(input.record.state.startedAt === undefined
          ? { startedAt: entry.createdAt }
          : { startedAt: input.record.state.startedAt }),
        task,
        ...(card === undefined ? { taskUnavailable: true } : {}),
      };

    const resolved: ResolvedDelegationGeneration = {
      kind: 'stream',
      runGeneration: entry.runGeneration,
      target,
      entry,
      stream: streamState(generation),
      result,
      status,
      snapshot,
      ...(result
        ? result.outcome.startedAt === undefined
          ? {}
          : { startedAt: result.outcome.startedAt }
        : current
          ? input.record.state.startedAt === undefined
            ? {}
            : { startedAt: input.record.state.startedAt }
          : { startedAt: entry.createdAt }),
      ...(result
        ? { finishedAt: result.outcome.finishedAt }
        : current && !settling && input.record.state.finishedAt !== undefined
          ? { finishedAt: input.record.state.finishedAt }
          : {}),
      task,
      ...(card === undefined ? { taskUnavailable: true } : {}),
    };
    return resolved;
  }
}

/** A run kept in the record's own legacy history needs no registry read. */
export function isLegacyPrefixGeneration(
  record: StoredDelegation,
  runGeneration: number,
): boolean {
  return (legacyPrefixView(record).history ?? []).some(
    (transcript) => transcript.runGeneration === runGeneration,
  );
}

function validGenerationNumber(runGeneration: number): boolean {
  return Number.isSafeInteger(runGeneration) && runGeneration >= 1;
}

function invalidGenerationFailure(): DelegationTranscriptPortError {
  return {
    code: 'invalid_request',
    message: 'Invalid delegation generation.',
    retryable: false,
  };
}

function corruptionFailure(): DelegationTranscriptPortError {
  return {
    code: 'corruption',
    message: 'The stored delegation generation identity did not match.',
    retryable: false,
  };
}

function validGeneration(
  generation: DelegationTranscriptGeneration,
  target: DelegationTranscriptTarget,
): boolean {
  return (
    generation.entry.chatId === target.chatId &&
    generation.entry.delegationId === target.delegationId &&
    generation.entry.runGeneration === target.runGeneration &&
    (generation.result === null ||
      generation.result.runGeneration === target.runGeneration)
  );
}

function outcomeFromGeneration(
  generation: DelegationTranscriptGeneration,
): DelegationGenerationOutcome {
  return generation.result
    ? { kind: 'settled', result: generation.result }
    : { kind: 'unsettled' };
}

/**
 * The default stays A0-compatible; S2 opts in by supplying its narrow read
 * port and trusted scope.
 */
export function createDelegationRecordReader(
  dependencies?: DelegationRecordReaderDependencies,
): DelegationRecordReader {
  return dependencies
    ? new RepositoryDelegationRecordReader(dependencies)
    : new UnsupportedDelegationRecordReader();
}
