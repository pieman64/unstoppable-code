import { randomUUID } from 'node:crypto';

const MAX_REFS = 5000;

/** Error prefix when a node's frame left the registry after the build. */
export const DETACHED_FRAME_ERROR_PREFIX = 'frame_detached:';

export interface RegisteredFrame {
  frameId: string;
  sessionId: string;
  loaderId: string;
  url: string;
  parentId?: string;
  targetId?: string;
  frameRef: string;
}

export interface NodeIdentity {
  frameId: string;
  sessionId: string;
  loaderId: string;
  backendNodeId: number;
}

export interface FrameRecordInput {
  frameId: string;
  sessionId?: string;
  loaderId?: string;
  url?: string;
  parentId?: string;
  targetId?: string;
}

export interface FrameTargetInfo {
  targetId: string;
  type: string;
  url?: string;
}

export interface NavigatedFrameInfo {
  id: string;
  loaderId: string;
  url: string;
  parentId?: string;
}

interface DocumentNamespace {
  sessionId: string;
  loaderId: string;
  value: string;
}

/**
 * Tracks stable frame references and document-scoped node references for one browser.
 *
 * CDP backend node IDs are only unique within a session and document. Public refs
 * therefore map to the full identity and are removed whenever that identity stops
 * describing the current document.
 */
export class FrameRegistry {
  private readonly frameNamespace: string = randomUUID();

  private nextFrameRef: number = 1;

  private nextNodeRef: number = 1;

  private readonly framesById: Map<string, RegisteredFrame> = new Map();

  private readonly frameIdByTargetId: Map<string, string> = new Map();

  private readonly pendingTargetUrls: Map<string, string> = new Map();

  private readonly documentNamespaces: Map<string, DocumentNamespace> =
    new Map();

  /** Insertion order is the recency order used by the bounded reference cache. */
  private readonly identitiesByRef: Map<string, NodeIdentity> = new Map();

  private readonly refByIdentity: Map<string, string> = new Map();

  public noteAttached(
    sessionId: string,
    targetInfo: FrameTargetInfo,
  ): RegisteredFrame | undefined {
    if (targetInfo.type !== 'iframe') {
      return undefined;
    }
    const mappedFrameId = this.frameIdByTargetId.get(targetInfo.targetId);
    const frameId = mappedFrameId ?? targetInfo.targetId;
    const previous =
      this.framesById.get(frameId) ??
      (mappedFrameId ? this.framesById.get(mappedFrameId) : undefined);

    let targetUrl = targetInfo.url ?? '';
    if (this.pendingTargetUrls.has(targetInfo.targetId)) {
      targetUrl = this.pendingTargetUrls.get(targetInfo.targetId) ?? targetUrl;
      this.pendingTargetUrls.delete(targetInfo.targetId);
    }

    if (previous && previous.sessionId !== sessionId) {
      this.dropRefsForFrame(previous.frameId);
      this.documentNamespaces.delete(previous.frameId);
    }

    const next = this.createFrame(
      frameId,
      sessionId,
      previous?.loaderId ?? '',
      targetUrl || previous?.url || '',
      previous?.parentId,
      targetInfo.targetId,
      previous?.frameRef,
    );

    if (previous && previous.frameId !== frameId) {
      this.rekeyFrame(previous.frameId, frameId, next);
    } else {
      this.framesById.set(frameId, next);
    }
    this.frameIdByTargetId.set(targetInfo.targetId, frameId);
    return this.copyFrame(next);
  }

  public noteFrameNavigated(
    sessionId: string,
    frameInfo: NavigatedFrameInfo,
  ): RegisteredFrame {
    const navigationFrameId = frameInfo.id;
    if (navigationFrameId.length === 0) {
      throw new Error('A navigated frame must have a frame ID.');
    }
    const previous =
      this.framesById.get(navigationFrameId) ??
      this.provisionalFrameForSession(sessionId);

    let frameId = navigationFrameId;
    if (previous && previous.frameId !== frameId) {
      const rekeyed = this.createFrame(
        frameId,
        sessionId,
        previous.loaderId,
        previous.url,
        frameInfo.parentId ?? previous.parentId,
        previous.targetId,
        previous.frameRef,
      );
      this.rekeyFrame(previous.frameId, frameId, rekeyed);
      frameId = rekeyed.frameId;
    }

    const current = this.framesById.get(frameId);
    if (current && current.loaderId !== frameInfo.loaderId) {
      this.resetDocument(frameId, frameInfo.loaderId);
    }

    const refreshed = this.framesById.get(frameId);
    const next = this.createFrame(
      frameId,
      sessionId,
      frameInfo.loaderId,
      frameInfo.url,
      frameInfo.parentId ?? refreshed?.parentId,
      refreshed?.targetId,
      refreshed?.frameRef ?? previous?.frameRef,
    );
    this.framesById.set(frameId, next);
    if (next.targetId !== undefined) {
      this.frameIdByTargetId.set(next.targetId, frameId);
    }
    return this.copyFrame(next);
  }

  /**
   * Applies the document identity carried by a committed frame navigation.
   * A same-document notification is idempotent; a replaced document invalidates
   * refs in the frame and every descendant frame before updating the loader ID.
   */
  public resetDocument(frameId: string, loaderId: string): void {
    const current = this.framesById.get(frameId);
    if (!current) {
      this.framesById.set(
        frameId,
        this.createFrame(frameId, '', loaderId, '', undefined, undefined),
      );
      return;
    }
    if (current.loaderId === loaderId) return;

    this.dropDescendants(frameId);
    this.dropRefsForFrame(frameId);
    this.documentNamespaces.delete(frameId);
    this.framesById.set(
      frameId,
      this.createFrame(
        current.frameId,
        current.sessionId,
        loaderId,
        current.url,
        current.parentId,
        current.targetId,
        current.frameRef,
      ),
    );
  }

  /**
   * TargetInfo is an update to a known target, never a frame identity source.
   * If attachment has not arrived yet, retain the URL until that stable target
   * identity is available.
   */
  public noteTargetInfoChanged(
    targetInfo: FrameTargetInfo,
  ): RegisteredFrame | undefined {
    const url = targetInfo.url;
    if (url === undefined) return undefined;
    const mappedFrameId = this.frameIdByTargetId.get(targetInfo.targetId);
    const frameId =
      mappedFrameId ??
      (this.framesById.has(targetInfo.targetId)
        ? targetInfo.targetId
        : undefined);
    if (frameId === undefined) {
      this.pendingTargetUrls.set(targetInfo.targetId, url);
      return undefined;
    }

    const current = this.framesById.get(frameId);
    if (!current) return undefined;
    const updated = this.createFrame(
      current.frameId,
      current.sessionId,
      current.loaderId,
      url,
      current.parentId,
      current.targetId,
      current.frameRef,
    );
    this.framesById.set(frameId, updated);
    return this.copyFrame(updated);
  }

  public noteFrameDetached(frameId: string): void {
    this.removeFrameSubtree(frameId);
  }

  /** Removes the attached frame session and all frame descendants it owns. */
  public noteSessionDetached(sessionId: string): void {
    const detachedRoots = this.frames()
      .filter((frame) => frame.sessionId === sessionId)
      .filter((frame) => !this.hasAncestorWithSession(frame, sessionId));
    for (const frame of detachedRoots) {
      this.removeFrameSubtree(frame.frameId);
    }
  }

  /** Returns the stable frame ref, provisioning a provisional record if needed. */
  public frameRefFor(frame: FrameRecordInput): string;
  public frameRefFor(
    frameId: string,
    metadata?: Omit<FrameRecordInput, 'frameId'>,
  ): string;
  public frameRefFor(
    frameOrId: FrameRecordInput | string,
    metadata?: Omit<FrameRecordInput, 'frameId'>,
  ): string {
    const input: FrameRecordInput =
      typeof frameOrId === 'string'
        ? { frameId: frameOrId, ...metadata }
        : frameOrId;
    const current = this.framesById.get(input.frameId);
    if (current) return current.frameRef;

    const provisional = this.createFrame(
      input.frameId,
      input.sessionId ?? '',
      input.loaderId ?? '',
      input.url ?? '',
      input.parentId,
      input.targetId,
    );
    this.framesById.set(input.frameId, provisional);
    if (provisional.targetId !== undefined) {
      this.frameIdByTargetId.set(provisional.targetId, input.frameId);
    }
    return provisional.frameRef;
  }

  /**
   * Returns a stable ref for the current node identity. A frame that left the
   * registry (detached since the build) is never re-registered, and a caller
   * cannot mint a ref for a loader/session that is stale for its frame.
   */
  public mintRef(identity: NodeIdentity): string {
    const frame = this.framesById.get(identity.frameId);
    if (
      !frame ||
      frame.sessionId !== identity.sessionId ||
      frame.loaderId !== identity.loaderId
    ) {
      throw new Error(
        `${DETACHED_FRAME_ERROR_PREFIX} The node's document is no longer current.`,
      );
    }

    const identityKey = this.identityKey(identity);
    const existing = this.refByIdentity.get(identityKey);
    const existingIdentity =
      existing === undefined ? undefined : this.identitiesByRef.get(existing);
    if (existing !== undefined && existingIdentity !== undefined) {
      // Least-recently-used eviction: a reused ref becomes the newest.
      this.identitiesByRef.delete(existing);
      this.identitiesByRef.set(existing, existingIdentity);
      return existing;
    }

    let document = this.documentNamespaces.get(identity.frameId);
    if (
      !document ||
      document.sessionId !== identity.sessionId ||
      document.loaderId !== identity.loaderId
    ) {
      document = {
        sessionId: identity.sessionId,
        loaderId: identity.loaderId,
        value: randomUUID(),
      };
      this.documentNamespaces.set(identity.frameId, document);
    }

    const ref = `r-${document.value}-${this.nextNodeRef}`;
    this.nextNodeRef += 1;
    this.identitiesByRef.set(ref, this.copyIdentity(identity));
    this.refByIdentity.set(identityKey, ref);
    this.evictOldRefs();
    return ref;
  }

  /** Resolves only refs that still belong to the currently registered document. */
  public resolveRef(ref: string): NodeIdentity | undefined {
    const identity = this.identitiesByRef.get(ref);
    if (!identity) return undefined;

    const frame = this.framesById.get(identity.frameId);
    if (
      !frame ||
      frame.sessionId !== identity.sessionId ||
      frame.loaderId !== identity.loaderId
    ) {
      this.deleteRef(ref, identity);
      return undefined;
    }
    // Least-recently-used: a ref in use is the last one to be evicted.
    this.identitiesByRef.delete(ref);
    this.identitiesByRef.set(ref, identity);
    return this.copyIdentity(identity);
  }

  public getFrame(frameId: string): RegisteredFrame | undefined {
    const frame = this.framesById.get(frameId);
    return frame ? this.copyFrame(frame) : undefined;
  }

  public getFrameForTarget(targetId: string): RegisteredFrame | undefined {
    const frameId = this.frameIdByTargetId.get(targetId);
    return frameId === undefined ? undefined : this.getFrame(frameId);
  }

  public getFramesForSession(sessionId: string): RegisteredFrame[] {
    return this.frames().filter((frame) => frame.sessionId === sessionId);
  }

  public frames(): RegisteredFrame[] {
    return Array.from(this.framesById.values(), (frame) =>
      this.copyFrame(frame),
    );
  }

  private createFrame(
    frameId: string,
    sessionId: string,
    loaderId: string,
    url: string,
    parentId: string | undefined,
    targetId: string | undefined,
    existingFrameRef?: string,
  ): RegisteredFrame {
    const frameRef =
      existingFrameRef ?? `f-${this.frameNamespace}-${this.nextFrameRef}`;
    if (existingFrameRef === undefined) this.nextFrameRef += 1;
    return {
      frameId,
      sessionId,
      loaderId,
      url,
      ...(parentId === undefined ? {} : { parentId }),
      ...(targetId === undefined ? {} : { targetId }),
      frameRef,
    };
  }

  private rekeyFrame(
    oldFrameId: string,
    newFrameId: string,
    replacement: RegisteredFrame,
  ): void {
    const current = this.framesById.get(oldFrameId);
    if (!current || oldFrameId === newFrameId) {
      this.framesById.set(newFrameId, replacement);
      return;
    }
    this.dropRefsForFrame(oldFrameId);
    this.documentNamespaces.delete(oldFrameId);
    this.framesById.delete(oldFrameId);
    this.framesById.set(newFrameId, replacement);
    for (const [targetId, mappedFrameId] of Array.from(
      this.frameIdByTargetId.entries(),
    )) {
      if (mappedFrameId === oldFrameId) {
        this.frameIdByTargetId.set(targetId, newFrameId);
      }
    }
    for (const [childId, child] of Array.from(this.framesById.entries())) {
      if (child.parentId === oldFrameId) {
        this.framesById.set(
          childId,
          this.createFrame(
            child.frameId,
            child.sessionId,
            child.loaderId,
            child.url,
            newFrameId,
            child.targetId,
            child.frameRef,
          ),
        );
      }
    }
  }

  private dropDescendants(frameId: string): void {
    const descendants = this.descendantIds(frameId);
    for (const descendantId of descendants) {
      this.removeFrameOnly(descendantId);
    }
  }

  private removeFrameSubtree(frameId: string): void {
    const subtree = [frameId, ...this.descendantIds(frameId)];
    for (const id of subtree) this.removeFrameOnly(id);
  }

  private descendantIds(frameId: string): string[] {
    const descendants: string[] = [];
    const pending = [frameId];
    const seen = new Set<string>(pending);
    while (pending.length > 0) {
      const parentId = pending.shift();
      if (parentId === undefined) continue;
      for (const child of Array.from(this.framesById.values())) {
        if (child.parentId !== parentId || seen.has(child.frameId)) continue;
        seen.add(child.frameId);
        descendants.push(child.frameId);
        pending.push(child.frameId);
      }
    }
    return descendants;
  }

  private removeFrameOnly(frameId: string): void {
    const frame = this.framesById.get(frameId);
    if (!frame) return;
    this.dropRefsForFrame(frameId);
    this.documentNamespaces.delete(frameId);
    this.framesById.delete(frameId);
    if (frame.targetId !== undefined) {
      this.frameIdByTargetId.delete(frame.targetId);
    }
    this.pendingTargetUrls.delete(frame.frameId);
  }

  private dropRefsForFrame(frameId: string): void {
    for (const [ref, identity] of Array.from(this.identitiesByRef.entries())) {
      if (identity.frameId === frameId) this.deleteRef(ref, identity);
    }
  }

  private hasAncestorWithSession(
    frame: RegisteredFrame,
    sessionId: string,
  ): boolean {
    let parentId = frame.parentId;
    const seen = new Set<string>();
    while (parentId !== undefined && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = this.framesById.get(parentId);
      if (!parent) return false;
      if (parent.sessionId === sessionId) return true;
      parentId = parent.parentId;
    }
    return false;
  }

  private provisionalFrameForSession(
    sessionId: string,
  ): RegisteredFrame | undefined {
    const provisional = this.frames().filter(
      (frame) => frame.sessionId === sessionId && frame.loaderId.length === 0,
    );
    return provisional.length === 1 ? provisional[0] : undefined;
  }

  private evictOldRefs(): void {
    while (this.identitiesByRef.size > MAX_REFS) {
      const oldest = this.identitiesByRef.entries().next();
      if (oldest.done) return;
      this.deleteRef(oldest.value[0], oldest.value[1]);
    }
  }

  private deleteRef(ref: string, identity: NodeIdentity): void {
    this.identitiesByRef.delete(ref);
    const identityKey = this.identityKey(identity);
    if (this.refByIdentity.get(identityKey) === ref) {
      this.refByIdentity.delete(identityKey);
    }
  }

  private identityKey(identity: NodeIdentity): string {
    return JSON.stringify([
      identity.sessionId,
      identity.frameId,
      identity.loaderId,
      identity.backendNodeId,
    ]);
  }

  private copyIdentity(identity: NodeIdentity): NodeIdentity {
    return {
      frameId: identity.frameId,
      sessionId: identity.sessionId,
      loaderId: identity.loaderId,
      backendNodeId: identity.backendNodeId,
    };
  }

  private copyFrame(frame: RegisteredFrame): RegisteredFrame {
    return {
      frameId: frame.frameId,
      sessionId: frame.sessionId,
      loaderId: frame.loaderId,
      url: frame.url,
      ...(frame.parentId === undefined ? {} : { parentId: frame.parentId }),
      ...(frame.targetId === undefined ? {} : { targetId: frame.targetId }),
      frameRef: frame.frameRef,
    };
  }
}
