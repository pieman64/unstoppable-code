import { projectLegacyDelegateOutput } from './output-page';
import { createHash, randomUUID } from 'node:crypto';
import {
  parseAgentDelegationSpawnRequest,
  type AgentDelegationResult,
  type AgentDelegationSnapshot,
  type AgentDelegationSpawnRequest,
  type AgentDelegationTerminalStatus,
  type AgentDelegationWaitRequest,
  type AgentDelegationWaitResult,
  type GetDelegateOutputRequest,
  type GetDelegateOutputValue,
  type DelegateSettledStatus,
} from '@canopy/protocol/delegation';
import { InMemoryDelegationTranscriptPort } from './in-memory-transcript-port';
import {
  createDelegationRunState,
  isDelegationTerminal,
  reduceDelegationEvent,
  type DelegationRunState,
} from './lifecycle';
import {
  projectAgentRoute,
  retainAgentRoute,
  validateAgentRoute,
} from './route';
import { waitForDelegations } from './wait';
import type {
  DelegationParentContext,
  ResolvedAgentRouteSnapshot,
} from './types';
import type {
  DelegationTranscriptPort,
  DelegationTranscriptTarget,
} from './transcript-port';

interface ProbeRecord {
  readonly parent: DelegationParentContext;
  readonly route: ResolvedAgentRouteSnapshot;
  state: DelegationRunState;
}

function isSettledStatus(
  status: AgentDelegationSnapshot['status'],
): status is DelegateSettledStatus {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'deadline_exceeded' ||
    status === 'interrupted'
  );
}

function ownerKey(parent: DelegationParentContext): string {
  return JSON.stringify([
    parent.harnessId,
    parent.projectId,
    parent.worktreeId,
    parent.chatId,
    parent.sessionKey,
    parent.runtimeGeneration,
  ]);
}

function unavailable(): AgentDelegationResult<never> {
  return {
    ok: false,
    error: {
      code: 'parent_unavailable',
      message: 'The delegation is unavailable to this parent.',
      retryable: false,
    },
  };
}

/** Phase 0 only: manually driven children, no provider or process launch path. */
export class DevelopmentDelegationBroker {
  readonly transcriptPort: DelegationTranscriptPort;
  private readonly records = new Map<string, ProbeRecord>();
  private readonly calls = new Map<
    string,
    {
      hash: string;
      result: Promise<AgentDelegationResult<AgentDelegationSnapshot>>;
    }
  >();
  private readonly listeners = new Set<() => void>();
  private readonly pendingOwners = new Map<string, number>();
  private readonly revokedOwners = new Set<string>();
  private closed = false;

  constructor(
    private readonly options: {
      readonly mode: 'development-probe';
      readonly resolveRoute: (
        task: AgentDelegationSpawnRequest,
      ) => Promise<AgentDelegationResult<ResolvedAgentRouteSnapshot>>;
      readonly capacity?: number;
      readonly transcriptPort?: DelegationTranscriptPort;
    },
  ) {
    if (options.mode !== 'development-probe')
      throw new Error('Development delegation requires an explicit probe host');
    if (
      options.capacity !== undefined &&
      (!Number.isInteger(options.capacity) ||
        options.capacity < 1 ||
        options.capacity > 16)
    )
      throw new Error('Invalid probe capacity');
    this.transcriptPort =
      options.transcriptPort ??
      new InMemoryDelegationTranscriptPort({
        owns: (target: DelegationTranscriptTarget): boolean => {
          const record = this.records.get(target.delegationId);
          return (
            record !== undefined &&
            record.parent.chatId === target.chatId &&
            record.state.runGeneration === target.runGeneration
          );
        },
      });
  }

  spawn(
    parent: DelegationParentContext,
    input: unknown,
  ): Promise<AgentDelegationResult<AgentDelegationSnapshot>> {
    const task = parseAgentDelegationSpawnRequest(input);
    if (!task.ok) return Promise.resolve(task);
    if (!this.validParent(parent)) return Promise.resolve(unavailable());
    const owner = ownerKey(parent);
    const key = JSON.stringify([owner, parent.turnId, parent.toolCallId]);
    const hash = createHash('sha256')
      .update(JSON.stringify(task.value))
      .digest('hex');
    const prior = this.calls.get(key);
    if (prior)
      return prior.hash === hash
        ? prior.result
        : Promise.resolve(unavailable());
    if (
      this.calls.size >= 256 ||
      this.activeCount(parent) >= (this.options.capacity ?? 4)
    )
      return Promise.resolve({
        ok: false,
        error: {
          code: 'capacity_exceeded',
          message: 'The delegation probe reached its capacity.',
          retryable: false,
        },
      });
    const context = Object.freeze({ ...parent });
    this.pendingOwners.set(owner, (this.pendingOwners.get(owner) ?? 0) + 1);
    const result = this.create(context, task.value).finally(() => {
      const remaining = (this.pendingOwners.get(owner) ?? 1) - 1;
      if (remaining === 0) this.pendingOwners.delete(owner);
      else this.pendingOwners.set(owner, remaining);
    });
    this.calls.set(key, { hash, result });
    return result;
  }

  inspect(
    parent: DelegationParentContext,
    id: string,
  ): AgentDelegationSnapshot | undefined {
    const record = this.records.get(id);
    return record &&
      ownerKey(record.parent) === ownerKey(parent) &&
      parent.depth === 0
      ? this.project(record)
      : undefined;
  }

  list(parent: DelegationParentContext): readonly AgentDelegationSnapshot[] {
    return Array.from(this.records.values())
      .filter(
        (record) =>
          ownerKey(record.parent) === ownerKey(parent) && parent.depth === 0,
      )
      .map((record) => this.project(record));
  }

  activeCount(parent: DelegationParentContext): number {
    return (
      (this.pendingOwners.get(ownerKey(parent)) ?? 0) +
      this.list(parent).filter((record) => !isDelegationTerminal(record.status))
        .length
    );
  }

  wait(
    parent: DelegationParentContext,
    request: AgentDelegationWaitRequest,
    signal?: AbortSignal,
  ): Promise<AgentDelegationResult<AgentDelegationWaitResult>> {
    return waitForDelegations(
      request,
      {
        getSnapshot: (id) => this.inspect(parent, id),
        subscribe: (listener) => {
          this.listeners.add(listener);
          return () => {
            this.listeners.delete(listener);
          };
        },
      },
      signal,
    );
  }

  getOutput(
    parent: DelegationParentContext,
    request: GetDelegateOutputRequest,
  ): Promise<AgentDelegationResult<GetDelegateOutputValue>> {
    return Promise.resolve(this.readOutput(parent, request));
  }

  private readOutput(
    parent: DelegationParentContext,
    request: GetDelegateOutputRequest,
  ): AgentDelegationResult<GetDelegateOutputValue> {
    const snapshot = this.inspect(parent, request.delegationId);
    if (!snapshot) return unavailable();
    const settled = isSettledStatus(snapshot.status);
    if (request.resultIndex !== undefined && request.resultIndex !== 1)
      return {
        ok: false,
        error: {
          code: 'invalid_request',
          message: 'Result index is not available.',
          retryable: false,
        },
      };
    const reply: AgentDelegationResult<GetDelegateOutputValue> = {
      ok: true,
      value: {
        delegationId: request.delegationId,
        currentRunGeneration: 1,
        currentStatus: snapshot.status,
        latestResultIndex: settled ? 1 : null,
        result: settled
          ? {
              resultIndex: 1,
              runGeneration: 1,
              status: snapshot.status,
              ...(snapshot.finalText !== undefined
                ? { finalText: snapshot.finalText }
                : {}),
              outputTruncated: snapshot.outputTruncated,
            }
          : null,
      },
    };
    if (
      reply.value.result &&
      (request.offset !== undefined || request.limit !== undefined)
    ) {
      const page = projectLegacyDelegateOutput(
        reply.value.result,
        request.offset ?? 0,
        request.limit ?? 65_536,
      );
      if (!page.ok) return page;
      return { ok: true, value: { ...reply.value, result: page.value } };
    }
    return reply;
  }

  stop(
    parent: DelegationParentContext,
    id: string,
  ): AgentDelegationResult<AgentDelegationSnapshot> {
    const record = this.inspect(parent, id);
    if (!record) return unavailable();
    this.finish(id, 'cancelled');
    const stopped = this.inspect(parent, id);
    return stopped ? { ok: true, value: stopped } : unavailable();
  }

  /** Host-only fixture completion. This is never present in either tool schema. */
  finish(
    id: string,
    status: AgentDelegationTerminalStatus,
    finalText?: string,
  ): void {
    const record = this.records.get(id);
    if (!record || isDelegationTerminal(record.state.status)) return;
    record.state = reduceDelegationEvent(record.state, {
      delegationId: id,
      runGeneration: 1,
      sequence: record.state.sequence + 1,
      occurredAt: Date.now(),
      event: {
        type: 'terminal',
        status,
        ...(finalText !== undefined ? { finalText } : {}),
      },
    });
    this.notify();
  }

  /** Explicit owner teardown only. Ordinary root completion does not call this. */
  closeOwner(parent: DelegationParentContext): void {
    this.revokedOwners.add(ownerKey(parent));
    for (const record of this.list(parent))
      this.finish(record.delegationId, 'cancelled');
  }

  close(): void {
    this.closed = true;
    for (const id of Array.from(this.records.keys()))
      this.finish(id, 'cancelled');
  }

  private validParent(parent: DelegationParentContext): boolean {
    return (
      !this.closed &&
      !this.revokedOwners.has(ownerKey(parent)) &&
      parent.depth === 0 &&
      Number.isSafeInteger(parent.runtimeGeneration) &&
      parent.runtimeGeneration > 0 &&
      [
        parent.harnessId,
        parent.projectId,
        parent.worktreeId,
        parent.chatId,
        parent.sessionKey,
        parent.turnId,
        parent.toolCallId,
      ].every((id) => id.length > 0 && id.length <= 512)
    );
  }

  private async create(
    parent: DelegationParentContext,
    task: AgentDelegationSpawnRequest,
  ): Promise<AgentDelegationResult<AgentDelegationSnapshot>> {
    try {
      const resolved = await this.options.resolveRoute(task);
      if (!resolved.ok) return resolved;
      if (!this.validParent(parent)) return unavailable();
      const checked = validateAgentRoute(
        task.modelId,
        task.thinkingLevel,
        resolved.value,
      );
      if (!checked.ok) return checked;
      const route = retainAgentRoute({
        ...resolved.value,
        requestedThinkingLevel: task.thinkingLevel,
        effectiveThinkingLevel: checked.value,
      });
      const delegationId = randomUUID();
      const record: ProbeRecord = {
        parent,
        route,
        state: reduceDelegationEvent(
          createDelegationRunState(delegationId, 1),
          {
            delegationId,
            runGeneration: 1,
            sequence: 1,
            occurredAt: Date.now(),
            event: {
              type: 'started',
              nativeSessionId: `probe:${delegationId}`,
            },
          },
        ),
      };
      this.records.set(delegationId, record);
      this.notify();
      return { ok: true, value: this.project(record) };
    } catch {
      return {
        ok: false,
        error: {
          code: 'route_unavailable',
          message: 'The probe route is unavailable.',
          retryable: false,
        },
      };
    }
  }

  private project(record: ProbeRecord): AgentDelegationSnapshot {
    const state = record.state;
    return Object.freeze({
      delegationId: state.delegationId,
      status: state.status,
      routeSnapshot: projectAgentRoute(record.route),
      outputTruncated: state.outputTruncated,
      ...(state.nativeSessionId
        ? { nativeSessionId: state.nativeSessionId }
        : {}),
      ...(state.finalText !== undefined ? { finalText: state.finalText } : {}),
    });
  }

  private notify(): void {
    for (const listener of Array.from(this.listeners)) {
      try {
        listener();
      } catch {
        /* A probe observer cannot prevent other waits from settling. */
      }
    }
  }
}
