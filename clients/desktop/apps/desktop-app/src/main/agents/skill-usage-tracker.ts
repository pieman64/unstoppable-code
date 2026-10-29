import {
  shareTargetFromEnableRef,
  shareTargetKey,
  type SkillShareNudgeOrigin,
} from '@canopy/desktop-shared/lib/skill-share-nudge';
import type { InvocableInventoryEntry } from '@canopy/desktop-shared/types/invocable-inventory';
import { matchInvocationEntry } from '../plugins/invocation-prefix-normalizer';
import {
  skillShareNudgeState,
  type SkillShareNudgeState,
} from './skill-share-nudge-state';

export interface SkillUsageTurn {
  id: string;
  eligible: boolean;
  used: Set<string>;
}
/** A session owns its tracker; observations carry the captured dequeued turn, never the next turn. */
export class SkillUsageTracker {
  private turn?: SkillUsageTurn;
  private disposed = false;
  private readonly isLive = (): boolean => !this.disposed;
  private readonly toolCalls = new Set<string>();
  private readonly origin: SkillShareNudgeOrigin;
  constructor(
    origin: SkillShareNudgeOrigin,
    private readonly state: SkillShareNudgeState = skillShareNudgeState,
  ) {
    // Session options also contain host paths and services. Project only the DTO ids.
    this.origin = {
      projectId: origin.projectId,
      worktreeId: origin.worktreeId,
      chatId: origin.chatId,
    };
  }
  startTurn(id: string, eligible: boolean): SkillUsageTurn {
    if (this.turn?.id === id) return this.turn;
    this.turn = { id, eligible, used: new Set() };
    return this.turn;
  }
  currentTurn(): SkillUsageTurn | undefined {
    return this.turn;
  }
  endTurn(): void {
    this.turn = undefined;
  }
  observeInvocation(
    turn: SkillUsageTurn | undefined,
    text: string,
    entries: readonly InvocableInventoryEntry[],
  ): void {
    if (this.disposed || !turn?.eligible || turn !== this.turn) return;
    const entry = matchInvocationEntry(text, entries);
    if (entry) this.observeEntry(turn, entry);
  }
  /** Claim synchronously before inventory I/O; replayed/delayed hooks retain the original turn. */
  claimToolCall(id: string, subagent: boolean): SkillUsageTurn | undefined {
    if (subagent || this.toolCalls.has(id)) return undefined;
    this.toolCalls.add(id);
    return this.turn?.eligible ? this.turn : undefined;
  }
  observeEntry(
    turn: SkillUsageTurn | undefined,
    entry: InvocableInventoryEntry,
  ): void {
    if (this.disposed || !turn || turn !== this.turn || !turn.eligible) return;
    const target = shareTargetFromEnableRef(entry.enableRef);
    // An inherited home-folder row is not a Canopy resource: nothing to share.
    if (!target) return;
    const key = shareTargetKey(target);
    if (turn.used.has(key)) return;
    turn.used.add(key);
    void this.state.recordUse(this.origin, target, this.isLive).catch(() => {
      // Deliberately exclude names, content, identities, and registry contents from diagnostics.
      // eslint-disable-next-line no-console
      console.error('Failed to persist local skill usage');
    });
  }
  dispose(): void {
    this.disposed = true;
    this.turn = undefined;
    this.toolCalls.clear();
    this.state.clear(this.origin, this.isLive);
  }
}
