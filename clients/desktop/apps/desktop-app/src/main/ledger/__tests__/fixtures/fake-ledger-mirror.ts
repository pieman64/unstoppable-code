import type {
  LedgerScopeAudience,
  LedgerScopeRegisterRequest,
  LedgerScopeRegisterResponse,
  LedgerSyncPushRequest,
  LedgerSyncPushResponse,
  LedgerWriterSession,
} from '@canopy/protocol/ledger-sync';
import type {
  LedgerMirrorClient,
  LedgerSyncFailure,
  LedgerSyncResult,
} from '../../sync-client';

/*
 * An in-memory mirror that answers as the web mirror does: one writer
 * session per scope, exact replay of what it acknowledged, no gaps, and its
 * own view of who may share what. It keeps every request it was sent.
 */

export const FAKE_MIRROR_ORGANIZATION_ID =
  '00000000-0000-4000-8000-0000000000b1';

interface FakeMirrorScope {
  readonly accountId: string;
  session: LedgerWriterSession;
  epoch: number;
  readonly superseded: string[];
  acknowledged: number;
  /** Payload hash by scope sequence. */
  readonly events: Map<number, string>;
  audience: LedgerScopeAudience;
}

function fingerprint(session: LedgerWriterSession): string {
  return JSON.stringify([
    session.deviceId,
    session.installationGeneration,
    session.nonce,
  ]);
}

function refused<Value>(failure: LedgerSyncFailure): LedgerSyncResult<Value> {
  return { ok: false, failure };
}

/** One request, as a test reads the order they arrived in. */
export type FakeMirrorCall =
  | {
      readonly kind: 'register';
      readonly ledgerId: string;
      readonly audience: 'private' | 'organization';
    }
  | {
      readonly kind: 'push';
      readonly ledgerId: string;
      /** The first and last scope sequence the batch carried. */
      readonly sequences: readonly [number, number];
    };

export class FakeLedgerMirror implements LedgerMirrorClient {
  readonly registrations: LedgerScopeRegisterRequest[] = [];
  readonly pushes: LedgerSyncPushRequest[] = [];
  /** Every request, in the order it arrived. */
  readonly calls: FakeMirrorCall[] = [];
  readonly scopes = new Map<string, FakeMirrorScope>();
  /** An organization the account belongs to prohibits sharing summaries. */
  prohibited = false;
  /** Projects that cannot share a scope with an organization. */
  readonly forbiddenProjects = new Set<string>();
  /** The time leases are stamped with. */
  now: () => number = Date.now;
  private readonly registerFailures: LedgerSyncFailure[] = [];
  private readonly pushFailures: LedgerSyncFailure[] = [];
  private lostPushResponses = 0;
  private pushGate: Promise<void> | null = null;

  /** Refuses the next registration with `failure`, applying nothing. */
  failNextRegister(failure: LedgerSyncFailure): void {
    this.registerFailures.push(failure);
  }

  /** Refuses the next push with `failure`, applying nothing. */
  failNextPush(failure: LedgerSyncFailure): void {
    this.pushFailures.push(failure);
  }

  /** Applies the next push, then loses its response. */
  loseNextPushResponse(): void {
    this.lostPushResponses += 1;
  }

  /** Holds every push until the returned function is called. */
  holdPushes(): () => void {
    let release: () => void = (): void => undefined;
    this.pushGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return (): void => {
      this.pushGate = null;
      release();
    };
  }

  /** The sequences a scope holds, in order. */
  heldSequences(ledgerId: string): number[] {
    return Array.from(this.scopes.get(ledgerId)?.events.keys() ?? []).sort(
      (left, right) => left - right,
    );
  }

  register(
    request: LedgerScopeRegisterRequest,
  ): Promise<LedgerSyncResult<LedgerScopeRegisterResponse>> {
    this.registrations.push(request);
    this.calls.push({
      kind: 'register',
      ledgerId: request.ledgerId,
      audience: request.audience.kind,
    });
    return Promise.resolve(this.applyRegistration(request));
  }

  async push(
    request: LedgerSyncPushRequest,
    signal?: AbortSignal,
  ): Promise<LedgerSyncResult<LedgerSyncPushResponse>> {
    this.pushes.push(request);
    this.calls.push({
      kind: 'push',
      ledgerId: request.ledgerId,
      sequences: [
        Number(request.events[0]?.scopeSequence ?? 0),
        Number(request.events[request.events.length - 1]?.scopeSequence ?? 0),
      ],
    });
    if (this.pushGate !== null) {
      // A cancelled request answers as a network failure does.
      const cancelled = new Promise<'cancelled'>((resolve) => {
        if (signal?.aborted === true) resolve('cancelled');
        signal?.addEventListener('abort', (): void => resolve('cancelled'), {
          once: true,
        });
      });
      if ((await Promise.race([this.pushGate, cancelled])) === 'cancelled') {
        return refused({ kind: 'retry' });
      }
    }
    return this.applyPush(request);
  }

  /** A refusal the mirror's policy gives before it looks at the scope. */
  private policyRefusal(
    request: LedgerScopeRegisterRequest,
    existing: FakeMirrorScope | undefined,
  ): LedgerSyncFailure | null {
    const forbidden =
      request.audience.kind === 'organization' &&
      this.forbiddenProjects.has(request.audience.trackedWorkspaceId);
    if (!this.prohibited && !forbidden) return null;
    // A refused audience is dropped, as the mirror drops it.
    if (existing !== undefined) existing.audience = { kind: 'private' };
    return { kind: this.prohibited ? 'prohibited' : 'audience_forbidden' };
  }

  private audienceFor(
    request: LedgerScopeRegisterRequest,
  ): LedgerScopeAudience {
    return request.audience.kind === 'private'
      ? { kind: 'private' }
      : {
          kind: 'organization',
          organizationId: FAKE_MIRROR_ORGANIZATION_ID,
          trackedWorkspaceId: request.audience.trackedWorkspaceId,
          expiresAt: new Date(this.now() + 72 * 60 * 60 * 1000).toISOString(),
        };
  }

  /**
   * Takes the scope for the request's session: the same session keeps its
   * epoch, a new one supersedes it. False for a superseded session, or one
   * naming an epoch it does not hold.
   */
  private takeSession(
    existing: FakeMirrorScope,
    request: LedgerScopeRegisterRequest,
  ): boolean {
    const held = request.writerEpoch;
    if (fingerprint(existing.session) === fingerprint(request.session)) {
      return held === undefined || held === String(existing.epoch);
    }
    if (
      held !== undefined ||
      existing.superseded.includes(fingerprint(request.session))
    ) {
      return false;
    }
    existing.superseded.push(fingerprint(existing.session));
    existing.session = request.session;
    existing.epoch += 1;
    return true;
  }

  private applyRegistration(
    request: LedgerScopeRegisterRequest,
  ): LedgerSyncResult<LedgerScopeRegisterResponse> {
    const failure = this.registerFailures.shift();
    if (failure !== undefined) return refused(failure);
    const existing = this.scopes.get(request.ledgerId);
    const policy = this.policyRefusal(request, existing);
    if (policy !== null) return refused(policy);
    const audience = this.audienceFor(request);
    const scope = existing ?? {
      accountId: request.accountId,
      session: request.session,
      epoch: 1,
      superseded: [],
      acknowledged: 0,
      events: new Map<number, string>(),
      audience,
    };
    if (scope.accountId !== request.accountId) {
      return refused({ kind: 'not_registered' });
    }
    if (existing !== undefined && !this.takeSession(existing, request)) {
      return refused({ kind: 'repair', reason: 'stale_writer' });
    }
    scope.audience = audience;
    this.scopes.set(request.ledgerId, scope);
    return {
      ok: true,
      value: {
        ledgerId: request.ledgerId,
        writerEpoch: String(scope.epoch),
        acknowledgedSequence: String(scope.acknowledged),
        audience,
      },
    };
  }

  /** Why a push cannot be applied to the scope at all, if it cannot. */
  private pushRefusal(
    request: LedgerSyncPushRequest,
    scope: FakeMirrorScope | undefined,
  ): LedgerSyncFailure | null {
    if (this.prohibited) {
      if (scope !== undefined) scope.audience = { kind: 'private' };
      return { kind: 'prohibited' };
    }
    if (scope === undefined || scope.accountId !== request.accountId) {
      return { kind: 'not_registered' };
    }
    if (String(scope.epoch) !== request.writerEpoch) {
      return { kind: 'repair', reason: 'stale_writer' };
    }
    if (Number(request.acknowledgedSequence) > scope.acknowledged) {
      return { kind: 'repair', reason: 'sequence_gap' };
    }
    return null;
  }

  /**
   * Checks a batch against what the scope holds: an exact replay of what it
   * acknowledged, then contiguous new events. Returns the new events, or the
   * refusal.
   */
  private freshEvents(
    request: LedgerSyncPushRequest,
    scope: FakeMirrorScope,
  ): Array<[number, string]> | LedgerSyncFailure {
    const fresh: Array<[number, string]> = [];
    for (const event of request.events) {
      const sequence = Number(event.scopeSequence);
      if (sequence <= scope.acknowledged) {
        if (scope.events.get(sequence) !== event.payloadHash) {
          return { kind: 'repair', reason: 'divergent_event' };
        }
      } else if (sequence === scope.acknowledged + fresh.length + 1) {
        fresh.push([sequence, event.payloadHash]);
      } else {
        return { kind: 'repair', reason: 'sequence_gap' };
      }
    }
    return fresh;
  }

  private applyPush(
    request: LedgerSyncPushRequest,
  ): LedgerSyncResult<LedgerSyncPushResponse> {
    const failure = this.pushFailures.shift();
    if (failure !== undefined) return refused(failure);
    const scope = this.scopes.get(request.ledgerId);
    const refusal = this.pushRefusal(request, scope);
    if (refusal !== null || scope === undefined) {
      return refused(refusal ?? { kind: 'not_registered' });
    }
    const fresh = this.freshEvents(request, scope);
    if (!Array.isArray(fresh)) return refused(fresh);
    for (const [sequence, hash] of fresh) scope.events.set(sequence, hash);
    scope.acknowledged += fresh.length;
    if (this.lostPushResponses > 0) {
      this.lostPushResponses -= 1;
      return refused({ kind: 'retry' });
    }
    return {
      ok: true,
      value: {
        ledgerId: request.ledgerId,
        acknowledgedSequence: String(scope.acknowledged),
        applied: fresh.length,
        replayed: request.events.length - fresh.length,
      },
    };
  }
}
