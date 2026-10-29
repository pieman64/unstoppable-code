import { isCDPRecord, readCDPInteger, readCDPString } from './cdp-decode';

export interface ExecutionContextInfo {
  frameId: string;
  /** The world name; empty for main worlds. */
  name: string;
  isolated: boolean;
  isDefault: boolean;
}

/**
 * The execution contexts each session reports through
 * `Runtime.executionContextCreated`, per frame. Ids are only meaningful in
 * their session.
 */
export class ExecutionContexts {
  private readonly bySession = new Map<
    string,
    Map<number, ExecutionContextInfo>
  >();

  public noteEvent(method: string, params: unknown, sessionId = ''): void {
    if (!isCDPRecord(params)) return;
    if (
      method === 'Runtime.executionContextCreated' &&
      isCDPRecord(params.context)
    ) {
      const context = params.context;
      const aux = isCDPRecord(context.auxData) ? context.auxData : {};
      const id = readCDPInteger(context.id);
      const frameId = readCDPString(aux.frameId);
      if (id === undefined || !frameId) return;
      let contexts = this.bySession.get(sessionId);
      if (!contexts) {
        contexts = new Map();
        this.bySession.set(sessionId, contexts);
      }
      contexts.set(id, {
        frameId,
        name: readCDPString(context.name) ?? '',
        isolated: aux.type === 'isolated',
        isDefault: aux.isDefault === true,
      });
    } else if (method === 'Runtime.executionContextDestroyed') {
      const id = readCDPInteger(params.executionContextId);
      if (id !== undefined) this.bySession.get(sessionId)?.delete(id);
    } else if (method === 'Runtime.executionContextsCleared') {
      this.bySession.delete(sessionId);
    }
  }

  public frameDetached(frameId: string): void {
    for (const contexts of Array.from(this.bySession.values())) {
      for (const [id, context] of Array.from(contexts.entries())) {
        if (context.frameId === frameId) contexts.delete(id);
      }
    }
  }

  public sessionDetached(sessionId: string): void {
    this.bySession.delete(sessionId);
  }

  public clear(): void {
    this.bySession.clear();
  }

  public get(
    sessionId: string,
    contextId: number,
  ): ExecutionContextInfo | undefined {
    return this.bySession.get(sessionId)?.get(contextId);
  }

  private frameContexts(
    frameId: string,
    sessionId: string,
  ): Array<[number, ExecutionContextInfo]> {
    return Array.from(this.bySession.get(sessionId)?.entries() ?? []).filter(
      ([, context]) => context.frameId === frameId,
    );
  }

  /** Isolated worlds of a frame, oldest first, without the excluded names. */
  public isolated(
    frameId: string,
    sessionId: string,
    exclude: readonly string[] = [],
  ): number[] {
    return this.frameContexts(frameId, sessionId)
      .filter(
        ([, context]) => context.isolated && !exclude.includes(context.name),
      )
      .map(([id]) => id);
  }

  /** Contexts of a frame with this world name, newest first. */
  public named(frameId: string, sessionId: string, name: string): number[] {
    return this.frameContexts(frameId, sessionId)
      .filter(([, context]) => context.name === name)
      .map(([id]) => id)
      .reverse();
  }

  /** The frame's main-world (default) context; the newest if several. */
  public mainWorld(frameId: string, sessionId: string): number | undefined {
    let found: number | undefined;
    for (const [id, context] of this.frameContexts(frameId, sessionId)) {
      if (context.isDefault) found = id;
    }
    return found;
  }
}
