import { createHash, randomUUID } from 'node:crypto';
import {
  canopyJsonValueSchemaWithin,
  INTERFACE_TOOL_CATALOG,
  INTERFACE_TOOL_INPUT_MAX_BYTES,
  INTERFACE_TOOL_REPLY_MAX_BYTES,
  isInterfaceToolName,
  type CANOPY_INTERFACE_KINDS,
  type CanopyErrorPayload,
  type CanopyJsonValue,
  type CanopySchemaOutput,
  type CoreClientToolsRegisterParamsSchema,
  type CoreClientToolsRegisterResult,
  type CoreClientToolsUnregisterParamsSchema,
  type CoreClientToolsUnregisterResult,
  type InterfaceSurface,
  type InterfaceToolName,
} from '@canopy/protocol/canopy-core';
import { stableStringify } from '@canopy/protocol/plans';
import { CanopyOperationError } from '../../runtime/errors';

/** No named type exists for this union (`packages/protocol/src/canopy-core/common.ts:48`). */
export type CanopyInterfaceKind = (typeof CANOPY_INTERFACE_KINDS)[number];
export type InterfaceToolPayload = Readonly<Record<string, CanopyJsonValue>>;

export interface InterfaceLeaseDescriptor {
  /** Host-made; never taken from an interface's params. */
  readonly leaseId: string;
  readonly surface: InterfaceSurface;
  readonly interfaceKind: CanopyInterfaceKind;
}
export interface InterfaceToolScope {
  readonly workspaceId: string;
  readonly worktreeId: string;
  readonly chatId: string;
}
export interface InterfaceToolCall {
  readonly callId: string;
  readonly toolName: InterfaceToolName;
  readonly input: InterfaceToolPayload;
  /** Epoch milliseconds. */
  readonly deadlineAt: number;
  readonly scope: InterfaceToolScope;
}
/** How core reaches one lease's interface. Supplied by the host that opened the lease. */
export interface InterfaceToolCallPort {
  /** Deliver one call. Returns false, or throws, when the interface cannot receive it now. */
  deliver(call: InterfaceToolCall): boolean;
  /** Best-effort notice that a delivered call ended without its reply. Must not throw; a throw is reported to onError. */
  cancel(callId: string): void;
}
export type InterfaceToolOutcome =
  | {
      readonly ok: true;
      readonly reply: InterfaceToolPayload;
      readonly servedBy: {
        readonly leaseId: string;
        readonly surface: InterfaceSurface;
      };
    }
  | { readonly ok: false; readonly error: CanopyErrorPayload };
export type InterfaceToolReplyDisposition =
  | 'settled'
  | 'unknown_call'
  | 'wrong_lease'
  | 'invalid';
export interface InterfaceToolAvailability {
  /** Increments whenever toolNames changes. */
  readonly revision: number;
  /** Catalog tools with at least one live serving lease, sorted. */
  readonly toolNames: readonly InterfaceToolName[];
}
export interface InterfaceToolInvokeRequest {
  readonly toolName: InterfaceToolName;
  readonly input: InterfaceToolPayload;
  readonly scope: InterfaceToolScope;
  readonly signal?: AbortSignal;
}
export interface InterfaceToolDeliveredEvent {
  toolName: InterfaceToolName;
  callId: string;
  leaseId: string;
  surface: InterfaceSurface;
  scope: InterfaceToolScope;
}
export interface InterfaceToolRegistryOptions {
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => { cancel(): void };
  newCallId?: () => string;
  onError?: (error: unknown, context: string) => void;
  /** One line per delivered call; never receives inputs or replies. */
  onDelivered?: (event: InterfaceToolDeliveredEvent) => void;
}
export const INTERFACE_TOOL_MAX_LEASES = 64;
export const INTERFACE_TOOL_MAX_KEYS_PER_LEASE = 32;
export const INTERFACE_TOOL_MAX_PENDING_PER_LEASE = 32;

type RegisterParams = CanopySchemaOutput<
  typeof CoreClientToolsRegisterParamsSchema
>;
type UnregisterParams = CanopySchemaOutput<
  typeof CoreClientToolsUnregisterParamsSchema
>;
interface Pending {
  readonly toolName: InterfaceToolName;
  settle(outcome: InterfaceToolOutcome): void;
}
interface Lease {
  readonly descriptor: InterfaceLeaseDescriptor;
  readonly port: InterfaceToolCallPort;
  readonly tools: Map<InterfaceToolName, { sequence: number }>;
  revision: number;
  readonly keys: Map<
    string,
    { digest: string; result: CoreClientToolsRegisterResult }
  >;
  readonly pending: Map<string, Pending>;
}

const never = { kind: 'never' } as const;
const failure = (
  kind: CanopyErrorPayload['kind'],
  message: string,
): InterfaceToolOutcome => ({
  ok: false,
  error: { kind, message, retry: never },
});
const invalid = (message: string): CanopyOperationError =>
  new CanopyOperationError({ kind: 'invalid_argument', message, retry: never });
const disconnected = (): InterfaceToolOutcome =>
  failure(
    'capability_unavailable',
    'The interface that served this tool disconnected.',
  );
const cancelled = (): InterfaceToolOutcome =>
  failure('cancelled', 'The tool call was cancelled.');

const inputSchema = canopyJsonValueSchemaWithin(INTERFACE_TOOL_INPUT_MAX_BYTES);
const replySchema = canopyJsonValueSchemaWithin(INTERFACE_TOOL_REPLY_MAX_BYTES);

function jsonObjectWithin(
  value: unknown,
  schema: typeof inputSchema,
): value is InterfaceToolPayload {
  return isPayload(value) && schema.safeParse(value).success;
}

function isPayload(value: unknown): value is InterfaceToolPayload {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const sameNames = (
  left: readonly InterfaceToolName[],
  right: readonly InterfaceToolName[],
): boolean =>
  left.length === right.length && left.every((name, i) => name === right[i]);

/**
 * Lease-bound interface agent tools (CAN-4131). A host opens a lease for each
 * connected interface and supplies the port that reaches it; the interface
 * registers catalog tools on that lease; core invokes a tool through exactly
 * one serving lease and settles the call only from that lease's reply.
 */
export class InterfaceToolRegistry {
  private readonly now: () => number;
  private readonly setTimer: NonNullable<
    InterfaceToolRegistryOptions['setTimer']
  >;
  private readonly newCallId: () => string;
  private readonly onError: (error: unknown, context: string) => void;
  private readonly onDelivered:
    | ((event: InterfaceToolDeliveredEvent) => void)
    | undefined;
  private readonly leases = new Map<string, Lease>();
  private readonly calls = new Map<string, string>();
  private readonly listeners = new Set<
    (availability: InterfaceToolAvailability) => void
  >();
  private sequence = 0;
  private availability: InterfaceToolAvailability = {
    revision: 0,
    toolNames: [],
  };
  private closed = false;

  constructor(options: InterfaceToolRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.setTimer =
      options.setTimer ??
      ((callback, delayMs): { cancel(): void } => {
        const timer = setTimeout(callback, delayMs);
        timer.unref?.();
        return { cancel: (): void => clearTimeout(timer) };
      });
    this.newCallId = options.newCallId ?? randomUUID;
    this.onError = options.onError ?? ((): undefined => undefined);
    this.onDelivered = options.onDelivered;
  }

  /** Host only. Throws Error('Interface lease already open.') for a live id; CanopyOperationError resource_exhausted past 64 leases. */
  openLease(
    lease: InterfaceLeaseDescriptor,
    port: InterfaceToolCallPort,
  ): void {
    if (this.closed) throw new Error('Interface tool registry closed.');
    if (this.leases.has(lease.leaseId))
      throw new Error('Interface lease already open.');
    if (this.leases.size >= INTERFACE_TOOL_MAX_LEASES)
      throw new CanopyOperationError({
        kind: 'resource_exhausted',
        message: 'Too many interfaces are connected.',
        retry: never,
      });
    this.leases.set(lease.leaseId, {
      descriptor: { ...lease },
      port,
      tools: new Map(),
      revision: 0,
      keys: new Map(),
      pending: new Map(),
    });
  }

  /** Host only. Atomic: removes every registration and fails every pending call. Returns the released registration count; 0 for an unknown id. */
  endLease(leaseId: string): number {
    const lease = this.leases.get(leaseId);
    if (!lease) return 0;
    const released = lease.tools.size;
    this.failPending(lease, () => true);
    lease.tools.clear();
    this.leases.delete(leaseId);
    this.refreshAvailability();
    return released;
  }

  hasLease(leaseId: string): boolean {
    return this.leases.has(leaseId);
  }

  /** For CAN-4127: whether any lease is open, registered or not. */
  hasLiveLease(): boolean {
    return this.leases.size > 0;
  }

  register(
    leaseId: string,
    params: RegisterParams,
  ): CoreClientToolsRegisterResult {
    const lease = this.requireLease(leaseId);
    const key = params._meta.idempotencyKey;
    const digest = createHash('sha256')
      .update(stableStringify(params.tools))
      .digest('hex');
    const known = lease.keys.get(key);
    if (known) {
      if (known.digest === digest) return known.result;
      throw new CanopyOperationError({
        kind: 'conflict',
        code: 'core.client.tools.revisionConflict',
        message: 'The registration key was used with different tools.',
        retry: { kind: 'after_refresh', resource: 'core.client.tools' },
      });
    }
    const names = new Set<InterfaceToolName>();
    for (const tool of params.tools) {
      if (!isInterfaceToolName(tool.name))
        throw invalid('This tool is not in the interface tool catalog.');
      const entry = INTERFACE_TOOL_CATALOG[tool.name];
      if (tool.version !== entry.version || tool.category !== entry.category)
        throw invalid(
          'This tool version or category does not match the catalog.',
        );
      const surfaces: readonly InterfaceSurface[] = entry.surfaces;
      if (!surfaces.includes(lease.descriptor.surface))
        throw invalid('This interface cannot serve this tool.');
      if (names.has(tool.name)) throw invalid('Tool names must be unique.');
      names.add(tool.name);
    }
    if (lease.keys.size >= INTERFACE_TOOL_MAX_KEYS_PER_LEASE)
      throw new CanopyOperationError({
        kind: 'resource_exhausted',
        message:
          'This interface has used all its registration keys; reload it to register again.',
        retry: never,
      });
    this.failPending(lease, (pending) => !names.has(pending.toolName));
    lease.tools.clear();
    for (const name of names)
      lease.tools.set(name, { sequence: ++this.sequence });
    lease.revision += 1;
    const result: CoreClientToolsRegisterResult = {
      registrationRevision: lease.revision,
      effectiveToolNames: [...names].sort(),
    };
    lease.keys.set(key, { digest, result });
    this.refreshAvailability();
    return result;
  }

  unregister(
    leaseId: string,
    params: UnregisterParams,
  ): CoreClientToolsUnregisterResult {
    const lease = this.requireLease(leaseId);
    const requested = new Set<string>(params.toolNames ?? []);
    const removed = [...lease.tools.keys()].filter(
      (name) => params.all === true || requested.has(name),
    );
    if (removed.length) {
      const gone = new Set<InterfaceToolName>(removed);
      this.failPending(lease, (pending) => gone.has(pending.toolName));
      for (const name of removed) lease.tools.delete(name);
      lease.revision += 1;
      this.refreshAvailability();
    }
    return {
      registrationRevision: lease.revision,
      removedToolNames: removed.sort(),
    };
  }

  available(): InterfaceToolAvailability {
    return this.availability;
  }

  /** Fires once per availability change, after the change. A throwing listener is reported to onError and skipped. */
  onChange(
    listener: (availability: InterfaceToolAvailability) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Never rejects. */
  invoke(request: InterfaceToolInvokeRequest): Promise<InterfaceToolOutcome> {
    const { toolName, input, scope, signal } = request;
    if (signal?.aborted) return Promise.resolve(cancelled());
    if (!jsonObjectWithin(input, inputSchema))
      return Promise.resolve(
        failure(
          'invalid_argument',
          'The tool input is too large or not an object.',
        ),
      );
    let lease: Lease | undefined;
    let best = -1;
    for (const candidate of this.leases.values()) {
      const sequence = candidate.tools.get(toolName)?.sequence;
      if (sequence !== undefined && sequence > best) {
        best = sequence;
        lease = candidate;
      }
    }
    if (!lease)
      return Promise.resolve(
        failure(
          'capability_unavailable',
          'No connected interface serves this tool.',
        ),
      );
    if (lease.pending.size >= INTERFACE_TOOL_MAX_PENDING_PER_LEASE)
      return Promise.resolve(
        failure(
          'resource_exhausted',
          'Too many tool calls are waiting on this interface.',
        ),
      );
    const serving = lease;
    const callId = this.newCallId();
    const { deadlineMs } = INTERFACE_TOOL_CATALOG[toolName];
    const call: InterfaceToolCall = {
      callId,
      toolName,
      input,
      deadlineAt: this.now() + deadlineMs,
      scope,
    };
    return new Promise<InterfaceToolOutcome>((resolve) => {
      let settled = false;
      const onAbort = (): void => {
        if (settle(cancelled())) this.cancelAtInterface(serving, callId);
      };
      const timer = this.setTimer(() => {
        if (
          settle(
            failure(
              'deadline_exceeded',
              'The interface did not answer in time.',
            ),
          )
        )
          this.cancelAtInterface(serving, callId);
      }, deadlineMs);
      const settle = (outcome: InterfaceToolOutcome): boolean => {
        if (settled) return false;
        settled = true;
        timer.cancel();
        signal?.removeEventListener('abort', onAbort);
        serving.pending.delete(callId);
        this.calls.delete(callId);
        resolve(outcome);
        return true;
      };
      serving.pending.set(callId, { toolName, settle });
      this.calls.set(callId, serving.descriptor.leaseId);
      signal?.addEventListener('abort', onAbort, { once: true });
      let delivered = false;
      try {
        delivered = serving.port.deliver(call);
      } catch (error) {
        this.onError(error, 'interface tool delivery');
      }
      if (!delivered) {
        settle(
          failure(
            'capability_unavailable',
            'The interface could not receive this tool call.',
          ),
        );
        return;
      }
      try {
        this.onDelivered?.({
          toolName,
          callId,
          leaseId: serving.descriptor.leaseId,
          surface: serving.descriptor.surface,
          scope,
        });
      } catch (error) {
        this.onError(error, 'interface tool delivery log');
      }
    });
  }

  /** Host only: a reply arrived from the interface holding `leaseId`. */
  reply(
    leaseId: string,
    callId: string,
    reply: unknown,
  ): InterfaceToolReplyDisposition {
    const owner = this.calls.get(callId);
    if (owner === undefined) return 'unknown_call';
    if (owner !== leaseId) return 'wrong_lease';
    const lease = this.leases.get(owner);
    const pending = lease?.pending.get(callId);
    if (!lease || !pending) return 'unknown_call';
    if (!jsonObjectWithin(reply, replySchema)) {
      pending.settle(
        failure('internal', 'The interface returned an invalid result.'),
      );
      return 'invalid';
    }
    pending.settle({
      ok: true,
      reply,
      servedBy: { leaseId, surface: lease.descriptor.surface },
    });
    return 'settled';
  }

  /** Ends every lease. Later calls to openLease throw Error('Interface tool registry closed.'). */
  close(): void {
    this.closed = true;
    for (const leaseId of [...this.leases.keys()]) this.endLease(leaseId);
  }

  private requireLease(leaseId: string): Lease {
    const lease = this.leases.get(leaseId);
    if (lease) return lease;
    throw new CanopyOperationError({
      kind: 'not_found',
      code: 'core.client.tools.notFound',
      message: 'This registration requires a live interface lease.',
      retry: never,
    });
  }

  private failPending(
    lease: Lease,
    matches: (pending: Pending) => boolean,
  ): void {
    for (const [callId, pending] of [...lease.pending]) {
      if (!matches(pending)) continue;
      pending.settle(disconnected());
      this.cancelAtInterface(lease, callId);
    }
  }

  private cancelAtInterface(lease: Lease, callId: string): void {
    try {
      lease.port.cancel(callId);
    } catch (error) {
      this.onError(error, 'interface tool cancel');
    }
  }

  private refreshAvailability(): void {
    const names = new Set<InterfaceToolName>();
    for (const lease of this.leases.values())
      for (const name of lease.tools.keys()) names.add(name);
    const toolNames = [...names].sort();
    if (sameNames(toolNames, this.availability.toolNames)) return;
    this.availability = {
      revision: this.availability.revision + 1,
      toolNames,
    };
    for (const listener of [...this.listeners]) {
      try {
        listener(this.availability);
      } catch (error) {
        this.onError(error, 'interface tool availability listener');
      }
    }
  }
}
