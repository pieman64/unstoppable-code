import { randomUUID } from 'node:crypto';
import type {
  BrowserHandoffEvent,
  BrowserHandoff,
  BrowserHandoffHydration,
  ShowFilesChatOrigin,
} from '@canopy/desktop-shared/types';
import { presentationChatKey } from '../canopy-tools/presentation-state';

type HandoffEvent = Extract<
  BrowserHandoffEvent,
  { type: 'handoff-requested' | 'handoff-released' }
>;
interface PendingHandoff {
  handoff: BrowserHandoff;
  publish: (event: HandoffEvent) => void;
}

/** Process-local core authority. No disk writer, timers, or renderer-owned lifecycle. */
export interface BrowserHandoffAdmission {
  targetRevision: number;
  originRevision: number;
  chatRevision: number;
}

export class BrowserHandoffStore {
  private readonly worktreeRevisions = new Map<string, number>();
  private readonly chatRevisions = new Map<string, number>();

  captureAdmission(
    projectId: string,
    worktreeId: string,
    origin: ShowFilesChatOrigin,
  ): BrowserHandoffAdmission {
    return {
      targetRevision:
        this.worktreeRevisions.get(`${projectId}/${worktreeId}`) ?? 0,
      originRevision:
        this.worktreeRevisions.get(
          `${origin.projectId}/${origin.worktreeId}`,
        ) ?? 0,
      chatRevision: this.chatRevisions.get(origin.chatTabId) ?? 0,
    };
  }

  isAdmissionCurrent(
    projectId: string,
    worktreeId: string,
    origin: ShowFilesChatOrigin,
    admission: BrowserHandoffAdmission,
  ): boolean {
    const current = this.captureAdmission(projectId, worktreeId, origin);
    return (
      current.targetRevision === admission.targetRevision &&
      current.originRevision === admission.originRevision &&
      current.chatRevision === admission.chatRevision
    );
  }

  private revision = 0;
  private readonly pending = new Map<string, PendingHandoff>();

  snapshot(projectId: string, worktreeId: string): BrowserHandoffHydration {
    return {
      revision: this.revision,
      handoff: structuredClone(
        this.pending.get(`${projectId}/${worktreeId}`)?.handoff ?? null,
      ),
    };
  }

  request(
    input: Omit<BrowserHandoff, 'handoffId' | 'requestedAt'>,
    publish: PendingHandoff['publish'],
  ): BrowserHandoff {
    const key = `${input.projectId}/${input.worktreeId}`;
    const previous = this.pending.get(key)?.handoff;
    if (
      previous?.browserId === input.browserId &&
      previous.runtimeGeneration === input.runtimeGeneration &&
      presentationChatKey(previous.origin) === presentationChatKey(input.origin)
    )
      return structuredClone(previous);
    const handoff: BrowserHandoff = {
      ...input,
      origin: { ...input.origin },
      handoffId: randomUUID(),
      requestedAt: Date.now(),
    };
    this.pending.set(key, { handoff, publish });
    publish({
      type: 'handoff-requested',
      browserId: handoff.browserId,
      handoff: structuredClone(handoff),
      revision: ++this.revision,
      runtimeGeneration: handoff.runtimeGeneration,
    });
    return structuredClone(handoff);
  }

  release(handoffId: string): void {
    for (const [key, entry] of Array.from(this.pending)) {
      if (entry.handoff.handoffId !== handoffId) continue;
      this.pending.delete(key);
      entry.publish({
        type: 'handoff-released',
        browserId: entry.handoff.browserId,
        handoffId,
        projectId: entry.handoff.projectId,
        worktreeId: entry.handoff.worktreeId,
        revision: ++this.revision,
        runtimeGeneration: entry.handoff.runtimeGeneration,
      });
      return;
    }
  }

  captureOrigin(origin: ShowFilesChatOrigin): string[] {
    return Array.from(this.pending.values())
      .filter(
        (entry) =>
          presentationChatKey(entry.handoff.origin) ===
          presentationChatKey(origin),
      )
      .map((entry) => entry.handoff.handoffId);
  }

  releaseOrigin(origin: ShowFilesChatOrigin): void {
    this.chatRevisions.set(
      origin.chatTabId,
      (this.chatRevisions.get(origin.chatTabId) ?? 0) + 1,
    );
    for (const id of this.captureOrigin(origin)) this.release(id);
  }

  releaseChat(chatTabId: string): void {
    this.chatRevisions.set(
      chatTabId,
      (this.chatRevisions.get(chatTabId) ?? 0) + 1,
    );
    for (const { handoff } of Array.from(this.pending.values()))
      if (handoff.origin.chatTabId === chatTabId)
        this.release(handoff.handoffId);
  }

  releaseBrowser(browserId: string): void {
    for (const { handoff } of Array.from(this.pending.values()))
      if (handoff.browserId === browserId) this.release(handoff.handoffId);
  }

  releaseWorktree(projectId: string, worktreeId: string): void {
    const key = `${projectId}/${worktreeId}`;
    this.worktreeRevisions.set(key, (this.worktreeRevisions.get(key) ?? 0) + 1);
    for (const { handoff } of Array.from(this.pending.values())) {
      if (
        (handoff.projectId === projectId &&
          handoff.worktreeId === worktreeId) ||
        (handoff.origin.projectId === projectId &&
          handoff.origin.worktreeId === worktreeId)
      )
        this.release(handoff.handoffId);
    }
  }
}

export const browserHandoffs = new BrowserHandoffStore();
