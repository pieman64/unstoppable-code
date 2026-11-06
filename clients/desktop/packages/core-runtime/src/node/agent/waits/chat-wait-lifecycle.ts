/*
 * The one wait lifecycle for chat requests that block a provider turn on a
 * person: ordinary questions (CAN-4128) and tool approvals (CAN-4129). It owns
 * open, first-wins settlement, the provider's timeout and abort, session
 * teardown, late-answer refusal and the shared no-client rule. Callers own the
 * canonical record and every notification. Only an explicit answer carries a
 * value: waiting never authorizes anything.
 */

export const CHAT_WAIT_KINDS = ['question', 'approval'] as const;
export type ChatWaitKind = (typeof CHAT_WAIT_KINDS)[number];
export type ChatWaitNoClientMode = 'wait' | 'fail';
/** The shipped no-client rule for every chat wait kind (CAN-4128). */
export const CHAT_WAIT_NO_CLIENT_MODE: ChatWaitNoClientMode = 'wait';
export const CHAT_WAIT_NO_CLIENT_REASON = 'no_client';

export interface ChatWaitScope {
  readonly workspaceId: string;
  readonly worktreeId: string;
  readonly chatId: string;
}
export type ChatWaitSettlement<T> =
  | { readonly status: 'answered'; readonly value: T }
  | { readonly status: 'cancelled'; readonly reason: string }
  | { readonly status: 'expired' }
  | { readonly status: 'failed'; readonly reason: string };
export type ChatWaitStatus = ChatWaitSettlement<unknown>['status'];

export interface ChatWaitOpenRequest {
  readonly waitId: string;
  readonly kind: ChatWaitKind;
  /** Absent only for legacy callers without a chat scope (tests); such waits never reach the turn seam. */
  readonly scope?: ChatWaitScope;
  /** Provider session that owns the wait; cancelSession settles by it. */
  readonly sessionKey: string;
  /** The provider's own timeout. Undefined or <= 0: none. */
  readonly timeoutMs?: number;
  /** Runs synchronously when the timeout elapses, before the wait settles. */
  readonly onExpired?: () => void;
  /** The provider's abort signal; abort settles cancelled with abortReason. */
  readonly signal?: AbortSignal;
  readonly abortReason?: string;
}
export interface ChatWait<T> {
  readonly waitId: string;
  readonly kind: ChatWaitKind;
  readonly scope: ChatWaitScope | null;
  /** Resolves once with the settlement. Never rejects. */
  readonly settled: Promise<ChatWaitSettlement<T>>;
}
export interface ChatWaitClientPresence {
  attached(scope: ChatWaitScope | null): boolean;
}
export interface ChatWaitObserver {
  opened(wait: {
    waitId: string;
    kind: ChatWaitKind;
    scope: ChatWaitScope | null;
    clientAttached: boolean;
  }): void;
  settled(wait: {
    waitId: string;
    kind: ChatWaitKind;
    scope: ChatWaitScope | null;
    status: ChatWaitStatus;
  }): void;
}
export class ChatWaitIdInUseError extends Error {
  constructor() {
    super('A chat wait with this id is already open.');
    this.name = 'ChatWaitIdInUseError';
  }
}

// A method signature, so a wait's typed resolver fits every settlement path.
interface SettlementSink {
  resolve(settlement: ChatWaitSettlement<unknown>): void;
}

interface OpenWait {
  readonly kind: ChatWaitKind;
  readonly scope: ChatWaitScope | null;
  readonly sessionKey: string;
  timer?: ReturnType<typeof setTimeout>;
  abort?: { readonly signal: AbortSignal; readonly listener: () => void };
  readonly sink: SettlementSink;
}

export class ChatWaitLifecycle {
  private readonly presence: ChatWaitClientPresence;
  private readonly noClientMode: ChatWaitNoClientMode;
  private readonly onError: (error: unknown, context: string) => void;
  private readonly openWaits = new Map<string, OpenWait>();
  private readonly refusals = new Set<string>();
  private readonly observers = new Set<ChatWaitObserver>();

  constructor(options: {
    presence: ChatWaitClientPresence;
    noClientMode?: ChatWaitNoClientMode;
    onError?: (error: unknown, context: string) => void;
  }) {
    this.presence = options.presence;
    this.noClientMode = options.noClientMode ?? CHAT_WAIT_NO_CLIENT_MODE;
    this.onError = options.onError ?? ((): void => undefined);
  }

  open<T>(request: ChatWaitOpenRequest): ChatWait<T> {
    if (!CHAT_WAIT_KINDS.some((kind) => kind === request.kind)) {
      throw new TypeError('Unknown chat wait kind.');
    }
    if (this.openWaits.has(request.waitId)) throw new ChatWaitIdInUseError();

    const { waitId, kind } = request;
    const scope = request.scope ?? null;
    let clientAttached = false;
    try {
      clientAttached = this.presence.attached(scope);
    } catch (error) {
      this.onError(error, 'chat wait presence');
    }

    let sink: SettlementSink = { resolve: (): void => undefined };
    const settled = new Promise<ChatWaitSettlement<T>>((done) => {
      sink = {
        resolve: (settlement: ChatWaitSettlement<T>): void => done(settlement),
      };
    });
    const wait: ChatWait<T> = { waitId, kind, scope, settled };
    this.notify((observer) =>
      observer.opened({ waitId, kind, scope, clientAttached }),
    );

    if (this.noClientMode === 'fail' && !clientAttached) {
      this.finish(waitId, kind, scope, sink, {
        status: 'failed',
        reason: CHAT_WAIT_NO_CLIENT_REASON,
      });
      return wait;
    }
    if (request.signal?.aborted) {
      this.finish(waitId, kind, scope, sink, {
        status: 'cancelled',
        reason: request.abortReason ?? 'cancelled',
      });
      this.refusals.add(waitId);
      return wait;
    }

    const entry: OpenWait = {
      kind,
      scope,
      sessionKey: request.sessionKey,
      sink,
    };
    this.openWaits.set(waitId, entry);
    if (request.timeoutMs !== undefined && request.timeoutMs > 0) {
      entry.timer = setTimeout(() => {
        if (this.openWaits.get(waitId) !== entry) return;
        this.openWaits.delete(waitId);
        try {
          request.onExpired?.();
        } catch (error) {
          this.onError(error, 'chat wait expiry');
        }
        this.release(waitId, entry, { status: 'expired' });
      }, request.timeoutMs);
    }
    if (request.signal) {
      const listener = (): void => {
        this.cancel(waitId, {
          reason: request.abortReason ?? 'cancelled',
          refuseLateAnswers: true,
        });
      };
      request.signal.addEventListener('abort', listener, { once: true });
      entry.abort = { signal: request.signal, listener };
    }
    return wait;
  }

  answer<T>(waitId: string, value: T): boolean {
    return this.settle(waitId, { status: 'answered', value });
  }

  cancel(
    waitId: string,
    options: { reason: string; refuseLateAnswers?: boolean },
  ): boolean {
    if (!this.settle(waitId, { status: 'cancelled', reason: options.reason })) {
      return false;
    }
    if (options.refuseLateAnswers === true) this.refusals.add(waitId);
    return true;
  }

  fail(waitId: string, reason: string): boolean {
    return this.settle(waitId, { status: 'failed', reason });
  }

  cancelSession(
    sessionKey: string,
    kind: ChatWaitKind,
    options: { reason: string; refuseLateAnswers?: boolean },
  ): number {
    const ids = Array.from(this.openWaits.entries())
      .filter(
        ([, entry]) => entry.sessionKey === sessionKey && entry.kind === kind,
      )
      .map(([waitId]) => waitId);
    let count = 0;
    for (const waitId of ids) {
      if (this.cancel(waitId, options)) count += 1;
    }
    return count;
  }

  isOpen(waitId: string): boolean {
    return this.openWaits.has(waitId);
  }

  scopeOf(waitId: string): ChatWaitScope | null {
    return this.openWaits.get(waitId)?.scope ?? null;
  }

  hasOpenForSession(sessionKey: string, kind: ChatWaitKind): boolean {
    for (const entry of this.openWaits.values()) {
      if (entry.sessionKey === sessionKey && entry.kind === kind) return true;
    }
    return false;
  }

  refusesLateAnswers(waitId: string): boolean {
    return this.refusals.has(waitId);
  }

  forgetLateAnswerRefusal(waitId: string): void {
    this.refusals.delete(waitId);
  }

  observe(observer: ChatWaitObserver): () => void {
    this.observers.add(observer);
    return (): void => {
      this.observers.delete(observer);
    };
  }

  private settle(
    waitId: string,
    settlement: ChatWaitSettlement<unknown>,
  ): boolean {
    const entry = this.openWaits.get(waitId);
    if (!entry) return false;
    this.openWaits.delete(waitId);
    this.release(waitId, entry, settlement);
    return true;
  }

  private release(
    waitId: string,
    entry: OpenWait,
    settlement: ChatWaitSettlement<unknown>,
  ): void {
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entry.abort?.signal.removeEventListener('abort', entry.abort.listener);
    this.finish(waitId, entry.kind, entry.scope, entry.sink, settlement);
  }

  private finish(
    waitId: string,
    kind: ChatWaitKind,
    scope: ChatWaitScope | null,
    sink: SettlementSink,
    settlement: ChatWaitSettlement<unknown>,
  ): void {
    sink.resolve(settlement);
    this.notify((observer) =>
      observer.settled({ waitId, kind, scope, status: settlement.status }),
    );
  }

  private notify(call: (observer: ChatWaitObserver) => void): void {
    for (const observer of Array.from(this.observers)) {
      try {
        call(observer);
      } catch (error) {
        this.onError(error, 'chat wait observer');
      }
    }
  }
}
