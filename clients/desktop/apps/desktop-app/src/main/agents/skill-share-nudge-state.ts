import { randomUUID } from 'node:crypto';
import {
  shareTargetKey,
  type SkillShareTarget as ShareTarget,
  type SkillShareNudgeOrigin,
  type PendingSkillShareNudge,
  type ResolveSkillShareNudgeRequest,
} from '@canopy/desktop-shared/lib/skill-share-nudge';
import {
  recordSkillUse,
  resolveSkillShareNudge,
} from '../lib/skill-usage-registry';

const originKey = (origin: SkillShareNudgeOrigin): string =>
  JSON.stringify([origin.projectId, origin.worktreeId, origin.chatId]);
interface PendingEntry {
  origin: SkillShareNudgeOrigin;
  pending: PendingSkillShareNudge;
  shownBy?: number;
  isLive: () => boolean;
}
/** Separate durable once-ever suppression from the banner currently displayed in one window. */
export class SkillShareNudgeState {
  private readonly pending = new Map<string, PendingEntry>();
  private readonly listeners = new Set<
    (origin: SkillShareNudgeOrigin) => void
  >();
  private chain: Promise<unknown> = Promise.resolve();
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const attempt = this.chain.then(operation, operation);
    this.chain = attempt.catch(() => undefined);
    return attempt;
  }
  subscribe(listener: (origin: SkillShareNudgeOrigin) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private changed(origin: SkillShareNudgeOrigin): void {
    const payload = {
      projectId: origin.projectId,
      worktreeId: origin.worktreeId,
      chatId: origin.chatId,
    };
    for (const listener of Array.from(this.listeners)) listener(payload);
  }
  recordUse(
    origin: SkillShareNudgeOrigin,
    target: ShareTarget,
    isLive: () => boolean,
  ): Promise<void> {
    return this.enqueue(async () => {
      const result = await recordSkillUse(shareTargetKey(target));
      if (!result.shouldEvaluateNudge || !isLive()) return;
      const key = originKey(origin);
      const existing = this.pending.get(key);
      if (
        existing &&
        shareTargetKey(existing.pending.target) === shareTargetKey(target)
      ) {
        existing.isLive = isLive;
        return;
      }
      this.pending.set(key, {
        isLive,
        origin: {
          projectId: origin.projectId,
          worktreeId: origin.worktreeId,
          chatId: origin.chatId,
        },
        pending: { id: randomUUID(), target: { ...target }, state: 'pending' },
      });
      this.changed(origin);
    });
  }
  /** Whether any window has a share suggestion pending for this chat. */
  hasPending(origin: SkillShareNudgeOrigin): boolean {
    return this.pending.has(originKey(origin));
  }
  getPending(
    origin: SkillShareNudgeOrigin,
    senderId: number,
  ): PendingSkillShareNudge | null {
    const entry = this.pending.get(originKey(origin));
    if (!entry || (entry.shownBy !== undefined && entry.shownBy !== senderId))
      return null;
    return { ...entry.pending, target: { ...entry.pending.target } };
  }
  resolve(
    request: ResolveSkillShareNudgeRequest,
    senderId: number,
  ): Promise<boolean> {
    return this.enqueue(async () => {
      const key = originKey(request);
      const entry = this.pending.get(key);
      if (
        !entry ||
        entry.pending.id !== request.pendingId ||
        shareTargetKey(entry.pending.target) !==
          shareTargetKey(request.target) ||
        (entry.shownBy !== undefined && entry.shownBy !== senderId)
      )
        return false;
      await resolveSkillShareNudge(
        shareTargetKey(entry.pending.target),
        request.resolution,
      );
      // The entry can be removed synchronously by session disposal while persistence is in flight.
      if (request.resolution === 'shown') {
        entry.shownBy = senderId;
        entry.pending.state = 'shown';
      } else if (this.pending.get(key) === entry) {
        this.pending.delete(key);
      }
      for (const [otherKey, other] of Array.from(this.pending)) {
        if (
          other === entry ||
          shareTargetKey(other.pending.target) !==
            shareTargetKey(request.target)
        )
          continue;
        // Preserve an already visible banner until its frontend confirms sharing/dismissal.
        if (other.pending.state === 'shown') continue;
        this.pending.delete(otherKey);
        this.changed(other.origin);
      }
      this.changed(entry.origin);
      return true;
    });
  }
  clear(origin: SkillShareNudgeOrigin, owner?: () => boolean): void {
    const key = originKey(origin);
    if (owner && this.pending.get(key)?.isLive !== owner) return;
    if (this.pending.delete(key)) this.changed(origin);
  }
}
export const skillShareNudgeState = new SkillShareNudgeState();
