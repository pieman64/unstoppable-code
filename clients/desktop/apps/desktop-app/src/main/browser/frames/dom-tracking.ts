import { bounded, type HostSend } from './host-cdp';
import { requestPiercedDocument } from './pierced-document';

/**
 * How long tracking stays on after the last build, wait probe or action
 * ends (D11). Agents act in steps a few seconds apart; one stays tracked
 * within a step's follow-ups, and an idle page stops streaming DOM events
 * to the main process soon after. Longer than the 500 ms model cache.
 */
export const DOM_TRACKING_IDLE_MS = 5_000;

/** Pierced documents get 4 s; domain toggles get 1 s each. Even a pending
 * release followed by establishment stays within the minimum 10 s lane. */
export const DOM_TRACKING_ESTABLISH_MS = 4_000;
export const DOM_TRACKING_TOGGLE_MS = 1_000;

export type DomTrackingState = 'on' | 'off';

export interface DomTrackingDeps {
  send: HostSend;
  /** Every CDP session of the browser: the root (`''`) and child sessions. */
  sessions(): string[];
  /** After a release or establishment push: frontend ids may be gone. */
  onReleased(): void;
  idleMs?: number;
}

/**
 * DOM tracking follows agent activity (D11). A pierced `DOM.getDocument`
 * makes Chromium report every DOM mutation of the page until the document
 * is replaced; that is what the model cache key and `effects.domChanged`
 * count. Builds, wait probes and actions establish it; after an idle
 * period with none in flight each possibly streaming session is released with
 * `DOM.disable` then `DOM.enable({ includeWhitespace: 'all' })`, which stops
 * the events until the next `DOM.getDocument`. Release and establish are
 * serialized with activity: a release never runs while any is in flight,
 * and activity waits for a release in progress.
 */
export class DomTracking {
  /** Sent a pierced document request; events may flow even if it failed. */
  private readonly streaming = new Set<string>();

  /** The current document was captured or successfully pushed. */
  private readonly established = new Set<string>();

  private readonly generations = new Map<string, number>();

  /** Possible event streaming, not whether current documents are established. */
  public get state(): DomTrackingState {
    return this.streaming.size > 0 ? 'on' : 'off';
  }

  public readonly idleMs: number;

  private activity = 0;

  private timer: ReturnType<typeof setTimeout> | undefined;

  private transition: Promise<void> = Promise.resolve();

  private disposed = false;

  private releasing = false;

  /** The documents being pushed, shared by concurrent establishments. */
  private readonly establishing = new Map<
    string,
    { generation: number; promise: Promise<void> }
  >();

  public constructor(private readonly deps: DomTrackingDeps) {
    this.idleMs = deps.idleMs ?? DOM_TRACKING_IDLE_MS;
  }

  /** Starts an activity; the returned function ends it (idempotent). */
  public begin(): () => void {
    this.activity += 1;
    this.cancelRelease();
    let ended = false;
    return (): void => {
      if (ended) return;
      ended = true;
      this.activity = Math.max(0, this.activity - 1);
      this.scheduleRelease();
    };
  }

  /**
   * A release in progress, which CDP use must wait for so it cannot
   * interleave with it; undefined when none is (no extra await).
   */
  public pending(): Promise<void> | undefined {
    return this.releasing ? this.transition : undefined;
  }

  /** Marks the send, not its completion; stale or failed pushes can stream. */
  public noteStreaming(sessionId: string): void {
    if (this.disposed) return;
    this.streaming.add(sessionId);
    this.scheduleRelease();
  }

  /** Document replacement, detach and release stop this session's stream. */
  public stopStreaming(sessionId: string): void {
    this.invalidateSession(sessionId);
    this.streaming.delete(sessionId);
  }

  /** A frame navigation retires establishment, but can leave events flowing. */
  public invalidateSession(sessionId: string): void {
    this.generations.set(sessionId, this.generation(sessionId) + 1);
    this.established.delete(sessionId);
  }

  private generation(sessionId: string): number {
    return this.generations.get(sessionId) ?? 0;
  }

  /** A build marks only captured sessions, and only in the generation it began. */
  public capture(): (sessions: Iterable<string>) => void {
    const generations = new Map(
      this.deps.sessions().map((id) => [id, this.generation(id)]),
    );
    return (sessions: Iterable<string>): void => {
      if (this.disposed) return;
      for (const id of Array.from(sessions)) {
        if (generations.get(id) === this.generation(id))
          this.established.add(id);
      }
    };
  }

  /**
   * Pushes each unestablished session's whole document (pierced),
   * so DOM events are reported for actions that need no model (by ref or
   * point). A session that does not answer is skipped. Establishing is an
   * activity of its own (review R2 finding 5): when it finishes with none
   * other open, the idle release is arranged, even if the action that
   * asked for it was cancelled meanwhile; a disposed tracker is never
   * marked on.
   */
  public async establish(): Promise<void> {
    const end = this.begin();
    try {
      await this.transition;
      if (this.disposed) return;
      const missing = this.deps
        .sessions()
        .filter((id) => !this.established.has(id));
      // A model can still be fresh when a hidden session was not captured.
      // Re-pushing documents replaces frontend ids: invalidate before the
      // request, even if it later rejects or times out.
      if (missing.length > 0) this.deps.onReleased();
      await Promise.all(missing.map((id) => this.pushDocument(id)));
    } finally {
      end();
    }
  }

  private pushDocument(sessionId: string): Promise<void> {
    const generation = this.generation(sessionId);
    const pending = this.establishing.get(sessionId);
    if (pending?.generation === generation) return pending.promise;
    this.noteStreaming(sessionId);
    const promise = bounded(
      requestPiercedDocument((method, params) =>
        this.deps.send(method, params, sessionId),
      ),
      DOM_TRACKING_ESTABLISH_MS,
    )
      .then(
        (): void => {
          if (!this.disposed && this.generation(sessionId) === generation)
            this.established.add(sessionId);
        },
        (): void => {
          /* A failed session is skipped, not marked established. */
        },
      )
      .finally(() => {
        if (this.establishing.get(sessionId)?.promise === promise)
          this.establishing.delete(sessionId);
      });
    this.establishing.set(sessionId, { generation, promise });
    return promise;
  }

  public dispose(): void {
    this.disposed = true;
    this.cancelRelease();
    this.established.clear();
    this.streaming.clear();
  }

  private cancelRelease(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private scheduleRelease(): void {
    this.cancelRelease();
    if (this.activity > 0 || this.disposed || this.state === 'off') return;
    const timer = setTimeout(() => {
      this.timer = undefined;
      if (this.activity > 0 || this.disposed) return;
      this.releasing = true;
      this.transition = this.transition
        .then(() => this.release())
        .finally(() => {
          this.releasing = false;
        });
    }, this.idleMs);
    // A pending release must not keep the process alive on its own.
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    this.timer = timer;
  }

  private async release(): Promise<void> {
    if (this.state === 'off' || this.disposed) return;
    const sessions = Array.from(this.streaming);
    for (const id of sessions) this.stopStreaming(id);
    await Promise.all(
      sessions.map(async (sessionId) => {
        await bounded(
          this.deps.send('DOM.disable', {}, sessionId),
          DOM_TRACKING_TOGGLE_MS,
        ).catch(() => undefined);
        await bounded(
          this.deps.send('DOM.enable', { includeWhitespace: 'all' }, sessionId),
          DOM_TRACKING_TOGGLE_MS,
        ).catch(() => undefined);
      }),
    );
    this.deps.onReleased();
  }
}
