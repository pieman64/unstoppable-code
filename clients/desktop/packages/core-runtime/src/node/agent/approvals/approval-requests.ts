import { randomUUID } from 'node:crypto';
import type { ApprovalPromptDecision } from '@canopy/protocol/approvals';
import type {
  ChatWaitLifecycle,
  ChatWaitScope,
  ChatWaitSettlement,
} from '../waits';

/*
 * The core approval request broker (CAN-4129). Each tool-approval request is
 * one `approval` wait on the shared chat wait lifecycle (CAN-4128), which owns
 * its settlement, timeout, teardown and the no-client rule. The broker adds
 * what the lifecycle leaves to callers: request identity, delivery to the
 * request's window, responder eligibility, the authority policy revision and
 * revalidation. It never evaluates policy and never allows on its own: only a
 * valid client allow at the current revision, or a host release, allows.
 * Requests live in memory only, so a restart denies.
 */

export const APPROVAL_POLICY_DENIED_REASON = 'approval_policy_denied';
export const APPROVAL_REVALIDATION_FAILED_REASON =
  'approval_revalidation_failed';

/** One monotonic policy revision per authority (ADR 22a rule 2). */
export interface ApprovalAuthorityRevisions {
  current(): number;
  /** Called after the revision advances; returns an unsubscribe. */
  subscribe(listener: (revision: number) => void): () => void;
}

/** The window that shows one request; used only to deliver and re-deliver it. */
export interface ApprovalDeliveryPresence {
  attached(): boolean;
  /** Resolves once attached (at once if already), or when the signal aborts. */
  whenAttached(signal: AbortSignal): Promise<void>;
  /** Resolves once the attached client goes away, or when the signal aborts. */
  whenDetached(signal: AbortSignal): Promise<void>;
}

export interface DeliveredApprovalRequest<TPresentation> {
  readonly requestId: string;
  readonly scope: ChatWaitScope;
  readonly policyRevision: number;
  readonly presentation: TPresentation;
}

export interface ApprovalClientPort<TPresentation> {
  readonly presence: ApprovalDeliveryPresence;
  /** Shows, or shows again, the request to its clients. */
  deliver(request: DeliveredApprovalRequest<TPresentation>): void;
  /** Takes the request down wherever it was shown. */
  withdraw(requestId: string): void;
  /** Whether `responder` may answer this request now. */
  accepts(responder: unknown): boolean;
}

export type ApprovalRevalidation = 'allow' | 'deny' | 'prompt' | 'failed';

/** The value an approval wait is answered with. */
export interface ApprovalAnswer {
  readonly decision: ApprovalPromptDecision;
  readonly by: 'client' | 'host';
}

export interface OpenApprovalRequest<TPresentation> {
  /** Ownership token and the wait's sessionKey: the approval session's sessionKey. */
  owner: string;
  scope: ChatWaitScope;
  presentation(requestId: string): TPresentation;
  port: ApprovalClientPort<TPresentation>;
  /** The caller's deadline in ms; null or <= 0 for none. */
  timeoutMs: number | null;
  /** Re-runs policy for this request under the current revision. */
  revalidate(): Promise<ApprovalRevalidation>;
}

export type ApprovalSettlement =
  | {
      readonly state: 'allowed';
      readonly by: 'client' | 'host';
      readonly decision: ApprovalPromptDecision;
    }
  | {
      readonly state: 'denied';
      readonly by: 'client' | 'host';
      readonly decision: ApprovalPromptDecision;
    }
  | {
      readonly state: 'denied';
      readonly by: 'policy';
      readonly reason: 'policy_denied' | 'revalidation_failed';
    }
  | { readonly state: 'cancelled'; readonly reason: string }
  | { readonly state: 'expired' }
  | { readonly state: 'failed'; readonly reason: string };

export interface ApprovalRequestHandle {
  readonly requestId: string;
  /** Resolves exactly once; never rejects. */
  readonly settled: Promise<ApprovalSettlement>;
}

export interface ApprovalResponse {
  readonly requestId: string;
  /** Must equal the request's scope, or the response is refused not_found. */
  readonly scope: ChatWaitScope;
  /** Stable id of the answering client, for replay detection. */
  readonly responderId: string;
  /** Opaque client reference passed to the port's `accepts`. */
  readonly responder: unknown;
  readonly policyRevision: number | null;
  readonly decision: ApprovalPromptDecision;
}

export const APPROVAL_RESPONSE_REFUSALS = [
  'not_found',
  'not_eligible',
  'already_settled',
  'stale_revision',
  'revalidating',
  'not_delivered',
] as const;
export type ApprovalResponseRefusal =
  (typeof APPROVAL_RESPONSE_REFUSALS)[number];

export type ApprovalRespondResult =
  | { readonly status: 'accepted' | 'replayed' }
  | { readonly status: 'refused'; readonly reason: ApprovalResponseRefusal };

export interface PendingApprovalView<TPresentation> {
  readonly requestId: string;
  readonly owner: string;
  readonly scope: ChatWaitScope;
  readonly phase: 'waiting' | 'delivered' | 'revalidating';
  readonly policyRevision: number;
  readonly presentation: TPresentation;
  readonly port: ApprovalClientPort<TPresentation>;
}

/** Accepted client answers kept for replay detection, oldest evicted first. */
export const APPROVAL_SETTLED_ANSWER_MEMORY = 256;

/** Maps a lifecycle settlement to an approval settlement; only `answered` can allow. */
export function approvalSettlementOf(
  settlement: ChatWaitSettlement<ApprovalAnswer>,
): ApprovalSettlement {
  switch (settlement.status) {
    case 'answered': {
      const { decision, by } = settlement.value;
      return decision.behavior === 'allow'
        ? { state: 'allowed', by, decision }
        : { state: 'denied', by, decision };
    }
    case 'cancelled':
      if (settlement.reason === APPROVAL_POLICY_DENIED_REASON) {
        return { state: 'denied', by: 'policy', reason: 'policy_denied' };
      }
      if (settlement.reason === APPROVAL_REVALIDATION_FAILED_REASON) {
        return { state: 'denied', by: 'policy', reason: 'revalidation_failed' };
      }
      return { state: 'cancelled', reason: settlement.reason };
    case 'expired':
      return { state: 'expired' };
    case 'failed':
      return { state: 'failed', reason: settlement.reason };
  }
}

interface Entry<TPresentation> {
  readonly requestId: string;
  readonly owner: string;
  readonly scope: ChatWaitScope;
  readonly presentation: TPresentation;
  readonly port: ApprovalClientPort<TPresentation>;
  readonly revalidate: () => Promise<ApprovalRevalidation>;
  policyRevision: number;
  attached: boolean;
  /** The revision last delivered successfully since the client attached. */
  deliveredRevision: number | null;
  revalidating: boolean;
  revalidateAgain: boolean;
  readonly controller: AbortController;
}

interface RememberedAnswer {
  readonly responderId: string;
  readonly behavior: ApprovalPromptDecision['behavior'];
  readonly scope: ApprovalPromptDecision['scope'];
  readonly scopeKey: string;
}

function scopeKeyOf(scope: ChatWaitScope): string {
  return `${scope.workspaceId}\0${scope.worktreeId}\0${scope.chatId}`;
}

function settledHandle(
  requestId: string,
  settlement: ApprovalSettlement,
): ApprovalRequestHandle {
  return { requestId, settled: Promise.resolve(settlement) };
}

export class CoreApprovalRequests<TPresentation> {
  private readonly waits: ChatWaitLifecycle;
  private readonly revisions: ApprovalAuthorityRevisions;
  private readonly newId: () => string;
  private readonly onError: (error: unknown, context: string) => void;
  private readonly entries = new Map<string, Entry<TPresentation>>();
  private readonly answers = new Map<string, RememberedAnswer>();
  private unsubscribe: (() => void) | null;
  private disposed = false;

  constructor(options: {
    waits: ChatWaitLifecycle;
    revisions: ApprovalAuthorityRevisions;
    newId?: () => string;
    onError?: (error: unknown, context: string) => void;
  }) {
    this.waits = options.waits;
    this.revisions = options.revisions;
    this.newId = options.newId ?? randomUUID;
    this.onError = options.onError ?? ((): void => undefined);
    this.unsubscribe = this.revisions.subscribe((revision) => {
      this.onRevision(revision);
    });
  }

  open(request: OpenApprovalRequest<TPresentation>): ApprovalRequestHandle {
    if (this.disposed) {
      return settledHandle('', {
        state: 'cancelled',
        reason: 'broker_disposed',
      });
    }
    const requestId = this.newId();
    let presentation: TPresentation;
    try {
      presentation = request.presentation(requestId);
    } catch (error) {
      this.onError(error, 'approval presentation');
      return settledHandle(requestId, {
        state: 'failed',
        reason: 'presentation_failed',
      });
    }

    let settled: Promise<ChatWaitSettlement<ApprovalAnswer>>;
    try {
      settled = this.waits.open<ApprovalAnswer>({
        waitId: requestId,
        kind: 'approval',
        scope: request.scope,
        sessionKey: request.owner,
        ...(request.timeoutMs !== null && request.timeoutMs > 0
          ? { timeoutMs: request.timeoutMs }
          : {}),
      }).settled;
    } catch (error) {
      this.onError(error, 'approval wait');
      return settledHandle(requestId, {
        state: 'failed',
        reason: 'wait_unavailable',
      });
    }
    const handle: ApprovalRequestHandle = {
      requestId,
      settled: settled.then(approvalSettlementOf),
    };
    if (!this.waits.isOpen(requestId)) return handle;

    const entry: Entry<TPresentation> = {
      requestId,
      owner: request.owner,
      scope: request.scope,
      presentation,
      port: request.port,
      revalidate: (): Promise<ApprovalRevalidation> => request.revalidate(),
      policyRevision: this.revisions.current(),
      attached: false,
      deliveredRevision: null,
      revalidating: false,
      revalidateAgain: false,
      controller: new AbortController(),
    };
    this.entries.set(requestId, entry);
    void settled.then((settlement) => {
      this.finish(entry, settlement);
    });

    if (this.presenceAttached(entry)) {
      entry.attached = true;
      this.deliver(entry);
    }
    void this.followPresence(entry);
    if (entry.policyRevision !== this.revisions.current()) {
      this.startRevalidation(entry);
    }
    return handle;
  }

  respond(response: ApprovalResponse): ApprovalRespondResult {
    const entry = this.entries.get(response.requestId);
    if (!entry || !this.waits.isOpen(response.requestId)) {
      return this.respondToSettled(response);
    }
    if (scopeKeyOf(response.scope) !== scopeKeyOf(entry.scope)) {
      return { status: 'refused', reason: 'not_found' };
    }
    if (!this.portAccepts(entry, response.responder)) {
      return { status: 'refused', reason: 'not_eligible' };
    }
    if (response.decision.behavior === 'allow') {
      if (entry.revalidating) {
        return { status: 'refused', reason: 'revalidating' };
      }
      if (!entry.attached) {
        return { status: 'refused', reason: 'not_delivered' };
      }
      const current = this.revisions.current();
      if (
        response.policyRevision !== entry.policyRevision ||
        entry.policyRevision !== current
      ) {
        if (entry.policyRevision === current) this.deliver(entry);
        return { status: 'refused', reason: 'stale_revision' };
      }
      if (entry.deliveredRevision !== entry.policyRevision) {
        this.deliver(entry);
        return { status: 'refused', reason: 'not_delivered' };
      }
    }
    if (
      !this.waits.answer<ApprovalAnswer>(response.requestId, {
        decision: response.decision,
        by: 'client',
      })
    ) {
      return { status: 'refused', reason: 'already_settled' };
    }
    this.remember(entry, response);
    return { status: 'accepted' };
  }

  /** Host release (CAN-3083 mode widening). Ignores revision and phase. */
  resolveFromHost(
    requestId: string,
    owner: string,
    decision: ApprovalPromptDecision,
  ): boolean {
    const entry = this.entries.get(requestId);
    if (!entry || entry.owner !== owner) return false;
    return this.waits.answer<ApprovalAnswer>(requestId, {
      decision,
      by: 'host',
    });
  }

  /** Cancels an approval this broker opened; never a question wait. */
  cancel(requestId: string, reason: string): boolean {
    return (
      this.entries.has(requestId) && this.waits.cancel(requestId, { reason })
    );
  }

  /** `waits.cancelSession(owner, 'approval', { reason })`. */
  cancelForOwner(owner: string, reason: string): number {
    return this.waits.cancelSession(owner, 'approval', { reason });
  }

  hasPendingForOwner(owner: string): boolean {
    return this.waits.hasOpenForSession(owner, 'approval');
  }

  /** Open requests in open order. */
  pending(): PendingApprovalView<TPresentation>[] {
    const views: PendingApprovalView<TPresentation>[] = [];
    for (const entry of this.entries.values()) {
      if (!this.waits.isOpen(entry.requestId)) continue;
      views.push({
        requestId: entry.requestId,
        owner: entry.owner,
        scope: entry.scope,
        phase: entry.revalidating
          ? 'revalidating'
          : entry.attached && entry.deliveredRevision === entry.policyRevision
            ? 'delivered'
            : 'waiting',
        policyRevision: entry.policyRevision,
        presentation: entry.presentation,
        port: entry.port,
      });
    }
    return views;
  }

  /** Cancels every open request with reason 'broker_disposed' and stops observing revisions. */
  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.disposed = true;
    for (const requestId of Array.from(this.entries.keys())) {
      this.cancel(requestId, 'broker_disposed');
    }
  }

  private respondToSettled(response: ApprovalResponse): ApprovalRespondResult {
    const answer = this.answers.get(response.requestId);
    if (!answer || answer.scopeKey !== scopeKeyOf(response.scope)) {
      return { status: 'refused', reason: 'not_found' };
    }
    if (
      answer.responderId === response.responderId &&
      answer.behavior === response.decision.behavior &&
      answer.scope === response.decision.scope
    ) {
      return { status: 'replayed' };
    }
    return { status: 'refused', reason: 'already_settled' };
  }

  private remember(
    entry: Entry<TPresentation>,
    response: ApprovalResponse,
  ): void {
    this.answers.set(entry.requestId, {
      responderId: response.responderId,
      behavior: response.decision.behavior,
      scope: response.decision.scope,
      scopeKey: scopeKeyOf(entry.scope),
    });
    while (this.answers.size > APPROVAL_SETTLED_ANSWER_MEMORY) {
      const oldest = this.answers.keys().next();
      if (oldest.done) break;
      this.answers.delete(oldest.value);
    }
  }

  private finish(
    entry: Entry<TPresentation>,
    settlement: ChatWaitSettlement<ApprovalAnswer>,
  ): void {
    if (this.entries.get(entry.requestId) === entry) {
      this.entries.delete(entry.requestId);
    }
    entry.controller.abort();
    if (settlement.status === 'answered' && settlement.value.by === 'host') {
      return;
    }
    try {
      entry.port.withdraw(entry.requestId);
    } catch (error) {
      this.onError(error, 'approval withdrawal');
    }
  }

  private deliver(entry: Entry<TPresentation>): void {
    try {
      entry.port.deliver({
        requestId: entry.requestId,
        scope: entry.scope,
        policyRevision: entry.policyRevision,
        presentation: entry.presentation,
      });
      entry.deliveredRevision = entry.policyRevision;
    } catch (error) {
      this.onError(error, 'approval delivery');
    }
  }

  private presenceAttached(entry: Entry<TPresentation>): boolean {
    try {
      return entry.port.presence.attached();
    } catch (error) {
      this.onError(error, 'approval presence');
      return false;
    }
  }

  private portAccepts(
    entry: Entry<TPresentation>,
    responder: unknown,
  ): boolean {
    try {
      return entry.port.accepts(responder);
    } catch (error) {
      this.onError(error, 'approval eligibility');
      return false;
    }
  }

  // A detach never settles anything (CAN-4128 rule 5); it only stops delivery
  // until the request's client comes back.
  private async followPresence(entry: Entry<TPresentation>): Promise<void> {
    const { signal } = entry.controller;
    const { presence } = entry.port;
    try {
      while (!signal.aborted) {
        if (entry.attached) {
          await presence.whenDetached(signal);
          if (signal.aborted) return;
          entry.attached = false;
          entry.deliveredRevision = null;
        } else {
          await presence.whenAttached(signal);
          if (signal.aborted) return;
          entry.attached = true;
          if (!entry.revalidating) this.deliver(entry);
        }
      }
    } catch (error) {
      entry.attached = false;
      entry.deliveredRevision = null;
      this.onError(error, 'approval presence');
    }
  }

  private onRevision(revision: number): void {
    for (const entry of Array.from(this.entries.values())) {
      if (entry.policyRevision < revision) this.startRevalidation(entry);
    }
  }

  private startRevalidation(entry: Entry<TPresentation>): void {
    if (entry.revalidating) {
      entry.revalidateAgain = true;
      return;
    }
    entry.revalidating = true;
    void this.revalidate(entry);
  }

  private async revalidate(entry: Entry<TPresentation>): Promise<void> {
    for (;;) {
      const target = this.revisions.current();
      let result: ApprovalRevalidation;
      try {
        result = await entry.revalidate();
      } catch (error) {
        this.onError(error, 'approval revalidation');
        result = 'failed';
      }
      if (!this.waits.isOpen(entry.requestId)) return;
      if (result === 'deny') {
        this.waits.cancel(entry.requestId, {
          reason: APPROVAL_POLICY_DENIED_REASON,
        });
        return;
      }
      if (result !== 'prompt' && result !== 'allow') {
        this.waits.cancel(entry.requestId, {
          reason: APPROVAL_REVALIDATION_FAILED_REASON,
        });
        return;
      }
      if (entry.revalidateAgain || this.revisions.current() !== target) {
        entry.revalidateAgain = false;
        continue;
      }
      entry.policyRevision = target;
      entry.revalidating = false;
      if (entry.attached) this.deliver(entry);
      return;
    }
  }
}
