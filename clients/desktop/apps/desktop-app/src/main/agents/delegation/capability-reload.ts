import { randomUUID } from 'node:crypto';
import {
  DEFERRED_TOOLS_RELOAD_CONTINUATION_TEMPLATE,
  type DeferredResourceSummary,
  type DeferredToolsReloadAdditions,
} from '@canopy/desktop-shared/types';
import { delegationAgentCapabilityError } from './agent-capability-error';

/**
 * In-run capability reload for managed delegates (capabilities 03, "Reload
 * semantics"). A child's Load Deferred Tools call records one pending reload;
 * the runner stops the provider turn once the Load result is delivered, the
 * host commits the grant and re-prepares the run, and the runner resumes the
 * same provider session inside the same run generation with a hidden
 * continuation. The broker run stays `running` throughout, so a reload never
 * publishes a result, fires a watcher, or consumes a generation slot.
 */

/** At most this many reloads per run generation; the next Load is refused. */
export const DELEGATION_CAPABILITY_RELOADS_PER_RUN = 3;

export interface DelegationCapabilityReloadRequest {
  /** The provider-visible id of the Load call, when the transport has one. */
  readonly toolCallId: string;
  /** Catalog IDs (`deferred:v1:…`) the Load call enables. */
  readonly refs: readonly string[];
  readonly additions: DeferredToolsReloadAdditions;
  readonly enabledResources: readonly DeferredResourceSummary[];
}

export type DelegationCapabilityReloadRefusal =
  | 'reload_in_progress'
  | 'reload_limit';

export type DelegationCapabilityReloadAdmission =
  | { readonly accepted: true; readonly reloadId: string }
  | {
      readonly accepted: false;
      readonly code: DelegationCapabilityReloadRefusal;
      readonly message: string;
    };

export interface PendingDelegationCapabilityReload extends DelegationCapabilityReloadRequest {
  readonly reloadId: string;
  /** 1-based position among the reloads accepted in this run generation. */
  readonly ordinal: number;
}

/**
 * Host side of a reload. Phase B wires this to the broker's grant extension
 * and to route re-preparation.
 */
export interface DelegationCapabilityReloadHost<P> {
  /**
   * Commit the loaded IDs to the delegation's grant (one durable write), then
   * re-prepare the run with the new capability overlay. Implementations
   * revoke the previous run's MCP routes before registering new ones.
   * Throwing leaves the grant as it was and triggers `restore`.
   */
  apply(
    reload: PendingDelegationCapabilityReload,
    signal: AbortSignal,
  ): Promise<P>;
  /** Re-prepare with the overlay that was in force before `apply` failed. */
  restore(
    reload: PendingDelegationCapabilityReload,
    signal: AbortSignal,
  ): Promise<P>;
  /**
   * Safe, path-free reasons for requested items that a successful `apply`
   * of this reload could not enable (a partial load). Read once, right after
   * `apply` resolves; empty or omitted when every item was enabled.
   */
  skipped?(reload: PendingDelegationCapabilityReload): readonly string[];
}

export type DelegationCapabilityReloadResult<P> =
  | {
      readonly status: 'loaded';
      readonly reload: PendingDelegationCapabilityReload;
      readonly prepared: P;
      /** Hidden continuation the runner sends to resume the provider turn. */
      readonly continuation: string;
      /** Reasons for requested items this partial load did not enable. */
      readonly skipped?: readonly string[];
    }
  | {
      readonly status: 'failed';
      readonly reload: PendingDelegationCapabilityReload;
      readonly prepared: P;
      readonly continuation: string;
      /** Safe, path-free reason; also embedded in `continuation`. */
      readonly message: string;
    };

/** A reload failure whose message is safe to show the child. */
export class DelegationCapabilityReloadFailure extends Error {
  constructor(readonly publicMessage: string) {
    super(publicMessage);
    this.name = 'DelegationCapabilityReloadFailure';
  }
}

const GENERIC_RELOAD_FAILURE =
  'The requested items could not be prepared for this delegated task.';

function publicReloadMessage(error: unknown): string {
  if (error instanceof DelegationCapabilityReloadFailure)
    return error.publicMessage;
  return (
    delegationAgentCapabilityError(error)?.publicMessage ??
    GENERIC_RELOAD_FAILURE
  );
}

/** Hidden continuation after a failed re-preparation; the run is not failed. */
export function delegationCapabilityReloadFailedContinuation(
  message: string,
): string {
  const reason = message.replace(/[<>]/g, '').trim() || GENERIC_RELOAD_FAILURE;
  return `<system_instruction>The requested items could not be enabled: ${reason} Continue the interrupted request without them.</system_instruction>`;
}

const PARTIAL_RELOAD_PREFIX =
  '<system_instruction>Some requested items are now enabled. These could not be: ';
const RELOAD_WITHOUT_SUFFIX =
  ' Continue the interrupted request without them.</system_instruction>';

/**
 * Hidden continuation after a partial load: the enabled items are available,
 * and the child learns which ones are not so it does not try to use them.
 */
export function delegationCapabilityReloadPartialContinuation(
  reasons: readonly string[],
): string {
  const detail =
    reasons
      .map((reason) => reason.replace(/[<>]/g, '').trim())
      .filter(Boolean)
      .join(' ') || GENERIC_RELOAD_FAILURE;
  return `${PARTIAL_RELOAD_PREFIX}${detail}${RELOAD_WITHOUT_SUFFIX}`;
}

/** Whether `text` is a hidden reload continuation: loaded, partial or failed. */
export function isDelegationCapabilityReloadContinuation(
  text: string,
): boolean {
  return (
    text === DEFERRED_TOOLS_RELOAD_CONTINUATION_TEMPLATE ||
    ((text.startsWith(
      '<system_instruction>The requested items could not be enabled: ',
    ) ||
      text.startsWith(PARTIAL_RELOAD_PREFIX)) &&
      text.endsWith(RELOAD_WITHOUT_SUFFIX))
  );
}

/**
 * One controller per run generation. It holds at most one pending reload,
 * enforces the per-run limit, and hands the delivered reload to the runner.
 */
export class DelegationCapabilityReloadController {
  private current: PendingDelegationCapabilityReload | undefined;
  private deliveredReload = false;
  private accepted = 0;
  private closed = false;

  constructor(
    private readonly limit: number = DELEGATION_CAPABILITY_RELOADS_PER_RUN,
  ) {}

  /** Reloads accepted in this run generation. */
  get count(): number {
    return this.accepted;
  }

  /** The reload recorded by a Load call and not yet performed. */
  get pending(): PendingDelegationCapabilityReload | undefined {
    return this.current;
  }

  /** Whether the provider has received the pending Load result. */
  get delivered(): boolean {
    return this.current !== undefined && this.deliveredReload;
  }

  /** Called by the child's Load Deferred Tools call. */
  request(
    request: DelegationCapabilityReloadRequest,
  ): DelegationCapabilityReloadAdmission {
    if (this.closed || this.current)
      return {
        accepted: false,
        code: 'reload_in_progress',
        message:
          'Another capability reload is already in progress for this delegated task.',
      };
    if (this.accepted >= this.limit)
      return {
        accepted: false,
        code: 'reload_limit',
        message: `This delegated task already loaded capabilities ${String(this.limit)} times in this run. Continue with the tools you have.`,
      };
    this.accepted += 1;
    const reload: PendingDelegationCapabilityReload = {
      toolCallId: request.toolCallId,
      refs: [...request.refs],
      additions: request.additions,
      enabledResources: [...request.enabledResources],
      reloadId: randomUUID(),
      ordinal: this.accepted,
    };
    this.current = reload;
    this.deliveredReload = false;
    return { accepted: true, reloadId: reload.reloadId };
  }

  /**
   * The runner observed the provider receive the Load result. A transport
   * that knows the Load call id passes it; a mismatch is ignored. Returns the
   * reload the runner must now perform.
   */
  markDelivered(
    toolCallId?: string,
  ): PendingDelegationCapabilityReload | undefined {
    const reload = this.current;
    if (!reload || this.closed) return undefined;
    if (toolCallId !== undefined && toolCallId !== reload.toolCallId)
      return undefined;
    this.deliveredReload = true;
    return reload;
  }

  /**
   * Commit and re-prepare through the host. A failed `apply` restores the
   * previous preparation and returns a continuation that tells the child the
   * load failed and why. Cancellation propagates; a failed `restore` throws.
   */
  async perform<P>(
    host: DelegationCapabilityReloadHost<P>,
    signal: AbortSignal,
  ): Promise<DelegationCapabilityReloadResult<P>> {
    const reload = this.current;
    if (!reload || !this.deliveredReload || this.closed)
      throw new Error('No delivered capability reload is pending');
    try {
      signal.throwIfAborted();
      const prepared = await host.apply(reload, signal);
      signal.throwIfAborted();
      const skipped = host.skipped?.(reload) ?? [];
      return {
        status: 'loaded',
        reload,
        prepared,
        continuation: skipped.length
          ? delegationCapabilityReloadPartialContinuation(skipped)
          : DEFERRED_TOOLS_RELOAD_CONTINUATION_TEMPLATE,
        ...(skipped.length ? { skipped } : {}),
      };
    } catch (error) {
      if (signal.aborted) throw error;
      const message = publicReloadMessage(error);
      const prepared = await host.restore(reload, signal);
      signal.throwIfAborted();
      return {
        status: 'failed',
        reload,
        prepared,
        continuation: delegationCapabilityReloadFailedContinuation(message),
        message,
      };
    } finally {
      if (this.current === reload) {
        this.current = undefined;
        this.deliveredReload = false;
      }
    }
  }

  /** Drop a reload whose Load result never reached the provider. */
  discardUndelivered(): void {
    if (this.current && !this.deliveredReload) this.current = undefined;
  }

  /** Stop, Interrupt, or shutdown: drop the pending reload, refuse new ones. */
  cancel(): void {
    this.closed = true;
    this.current = undefined;
    this.deliveredReload = false;
  }
}
