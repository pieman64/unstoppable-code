import { publishMcpActivationChanged } from './activation-events';
import {
  mcpCapabilityIdentityKey,
  mcpSessionStatusSchema,
  type McpActivationScope,
  type McpActivationProvider,
  type McpAvailabilityReason,
  type McpCapabilityIdentity,
  type McpSessionStatus,
} from '@canopy/protocol/mcp-servers';

/** Supplied by the trusted session owner, never an interface DTO. */
export interface McpSessionBinding {
  ownerId: string;
  scope: McpActivationScope;
  sessionId: string;
  provider: McpActivationProvider;
  generation: number;
}

export interface McpSelectionFacts {
  identity: McpCapabilityIdentity;
  selected: boolean;
  enabled: boolean;
  permitted: boolean;
  authRequirement: McpSessionStatus['authRequirement'];
}

export type McpSessionObservation =
  | { kind: 'connecting'; identity: McpCapabilityIdentity }
  | {
      kind: 'tools';
      identity: McpCapabilityIdentity;
      initialized: true;
      complete: true;
      toolCount: number;
    }
  | { kind: 'auth_required'; identity: McpCapabilityIdentity }
  | {
      kind: 'unavailable';
      identity: McpCapabilityIdentity;
      reasonCode: McpAvailabilityReason;
    };

export type McpRequiredTargetsResult =
  | { kind: 'ready'; statuses: McpSessionStatus[] }
  | { kind: 'awaiting_auth'; statuses: McpSessionStatus[] }
  | {
      kind: 'failed';
      reasonCode: McpAvailabilityReason;
      statuses: McpSessionStatus[];
    }
  | { kind: 'cancelled'; statuses: McpSessionStatus[] };

interface SessionState {
  binding: McpSessionBinding;
  statuses: Map<string, McpSessionStatus>;
}

function scopeKey(binding: McpSessionBinding): string {
  return JSON.stringify([
    binding.ownerId,
    binding.scope.projectId,
    binding.scope.worktreeId,
    binding.scope.chatId,
  ]);
}

function sameBinding(
  left: McpSessionBinding,
  right: McpSessionBinding,
): boolean {
  return (
    scopeKey(left) === scopeKey(right) &&
    left.sessionId === right.sessionId &&
    left.provider === right.provider &&
    left.generation === right.generation
  );
}

/** Transient owning-session evidence. No discovery client can mark a session ready. */
export class McpSessionAvailability {
  private readonly sessions = new Map<string, SessionState>();
  private readonly listeners = new Set<(binding: McpSessionBinding) => void>();

  begin(
    binding: McpSessionBinding,
    selections: readonly McpSelectionFacts[],
  ): boolean {
    const key = scopeKey(binding);
    const previous = this.sessions.get(key);
    if (
      !Number.isSafeInteger(binding.generation) ||
      binding.generation < 0 ||
      !binding.ownerId ||
      !binding.sessionId
    )
      return false;
    // Every relevant change, including a session replacement, advances generation.
    if (previous && binding.generation <= previous.binding.generation)
      return false;
    const statuses = new Map<string, McpSessionStatus>();
    for (const selection of selections) {
      const status = mcpSessionStatusSchema.parse({
        ...selection,
        sessionId: binding.sessionId,
        generation: binding.generation,
        availability: !selection.selected
          ? 'not_selected'
          : !selection.enabled
            ? 'disabled'
            : !selection.permitted
              ? 'unavailable'
              : 'connecting',
        reasonCode:
          !selection.selected || !selection.enabled
            ? 'removed'
            : selection.permitted
              ? 'unchecked'
              : 'permission_denied',
      });
      statuses.set(mcpCapabilityIdentityKey(status.identity), status);
    }
    this.sessions.set(key, { binding: structuredClone(binding), statuses });
    this.emit(binding);
    return true;
  }

  observe(
    binding: McpSessionBinding,
    observation: McpSessionObservation,
  ): boolean {
    const session = this.current(binding);
    const key = mcpCapabilityIdentityKey(observation.identity);
    const previous = session?.statuses.get(key);
    if (
      !session ||
      !previous ||
      !previous.selected ||
      !previous.enabled ||
      !previous.permitted
    )
      return false;
    if (
      observation.kind === 'tools' &&
      (!observation.initialized || !observation.complete)
    )
      return false;
    const facts = { ...previous };
    delete facts.evidence;
    delete facts.toolCount;
    delete facts.reasonCode;
    const next = mcpSessionStatusSchema.safeParse(
      observation.kind === 'connecting'
        ? { ...facts, availability: 'connecting', reasonCode: 'unchecked' }
        : observation.kind === 'tools'
          ? {
              ...facts,
              availability: observation.toolCount > 0 ? 'ready' : 'unavailable',
              toolCount: observation.toolCount,
              evidence: { initialized: true, toolsDiscovered: true },
              ...(observation.toolCount === 0
                ? { reasonCode: 'no_tools' }
                : {}),
            }
          : observation.kind === 'auth_required'
            ? {
                ...facts,
                availability: 'auth_required',
                authRequirement:
                  facts.authRequirement === 'provider_managed'
                    ? 'provider_managed'
                    : 'required',
              }
            : {
                ...facts,
                availability: 'unavailable',
                reasonCode: observation.reasonCode,
              },
    );
    if (!next.success) return false;
    session.statuses.set(key, next.data);
    this.emit(binding);
    return true;
  }

  snapshot(binding: McpSessionBinding): McpSessionStatus[] {
    const session = this.current(binding);
    return session
      ? Array.from(session.statuses.values(), (status) =>
          structuredClone(status),
        )
      : [];
  }

  /** Withdraw authorization immediately; transport callbacks cannot reselect it. */
  revokeMissingSelections(
    binding: McpSessionBinding,
    selected: ReadonlySet<string>,
  ): void {
    const session = this.current(binding);
    if (!session) return;
    let changed = false;
    for (const [key, status] of Array.from(session.statuses)) {
      if (!status.selected || selected.has(key)) continue;
      const next: McpSessionStatus = {
        ...status,
        selected: false,
        availability: 'not_selected',
        reasonCode: 'removed',
      };
      delete next.evidence;
      delete next.toolCount;
      session.statuses.set(key, next);
      changed = true;
    }
    if (changed) this.emit(binding);
  }

  clear(binding: McpSessionBinding): boolean {
    if (!this.current(binding)) return false;
    this.sessions.delete(scopeKey(binding));
    this.emit(binding);
    return true;
  }

  subscribe(listener: (binding: McpSessionBinding) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  waitForRequiredTargets(
    binding: McpSessionBinding,
    targets: readonly McpCapabilityIdentity[],
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<McpRequiredTargetsResult> {
    if (
      !Number.isFinite(options.timeoutMs) ||
      options.timeoutMs < 0 ||
      options.timeoutMs > 600_000
    )
      throw new Error('Invalid MCP readiness deadline');
    const keys = new Set(targets.map(mcpCapabilityIdentityKey));
    if (keys.size === 0) throw new Error('MCP activation requires targets');
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: McpRequiredTargetsResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        unsubscribe();
        options.signal?.removeEventListener('abort', onAbort);
        resolve(result);
      };
      const selectedStatuses = (): McpSessionStatus[] =>
        this.snapshot(binding).filter((status) =>
          keys.has(mcpCapabilityIdentityKey(status.identity)),
        );
      const check = (): void => {
        const statuses = selectedStatuses();
        if (options.signal?.aborted || !this.current(binding))
          return finish({ kind: 'cancelled', statuses });
        if (statuses.length !== keys.size)
          return finish({ kind: 'failed', reasonCode: 'removed', statuses });
        const failed = statuses.find((status) =>
          ['unavailable', 'disabled', 'not_selected'].includes(
            status.availability,
          ),
        );
        if (failed)
          return finish({
            kind: 'failed',
            reasonCode: failed.reasonCode ?? 'removed',
            statuses,
          });
        if (statuses.some((status) => status.availability === 'auth_required'))
          return finish({ kind: 'awaiting_auth', statuses });
        if (statuses.every((status) => status.availability === 'ready'))
          finish({ kind: 'ready', statuses });
      };
      const onAbort = (): void =>
        finish({ kind: 'cancelled', statuses: selectedStatuses() });
      const unsubscribe = this.subscribe((changed) => {
        if (scopeKey(changed) === scopeKey(binding)) check();
      });
      const timeout = setTimeout(
        () =>
          finish({
            kind: 'failed',
            reasonCode: 'timeout',
            statuses: selectedStatuses(),
          }),
        options.timeoutMs,
      );
      options.signal?.addEventListener('abort', onAbort, { once: true });
      check();
    });
  }

  private current(binding: McpSessionBinding): SessionState | undefined {
    const session = this.sessions.get(scopeKey(binding));
    return session && sameBinding(session.binding, binding)
      ? session
      : undefined;
  }

  private emit(binding: McpSessionBinding): void {
    publishMcpActivationChanged(binding.scope);
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(structuredClone(binding));
      } catch {
        /* A failed subscriber cannot strand readiness waits. */
      }
    }
  }
}

export const mcpSessionAvailability = new McpSessionAvailability();
