import { randomUUID } from 'node:crypto';
import type {
  PendingSkillSuggestion,
  ResolveSkillSuggestionRequest,
  SkillSuggestion,
  SkillSuggestionChangedEvent,
  SkillSuggestionOrigin,
} from '@canopy/desktop-shared/lib/skill-suggestions';
import { chainEndsWith } from './clustering';
import {
  MIN_SHARED_CONTENT_TOKENS,
  pairScore,
  sharedContentTokenCount,
  type PromptShape,
} from './normalize';
import {
  isOwnerAvailable,
  ownerLabelFor,
  type MemberOrganizations,
} from './owners';
import { parsePartitionKey } from './partition';
import {
  addMatchedTurn,
  isOpenSuggestion,
  resolveStoredSuggestion,
  type SkillSuggestionsFile,
  type SkillSuggestionsRegistry,
  type StoredSkillSuggestion,
} from './registry';

/**
 * Deterministic, model-free surfacing for repeat-task skill suggestions
 * (CAN-385). A completed turn that repeats an open suggestion counts toward
 * it and, within the throttles, becomes the chat's pending banner. Mirrors
 * the share nudge: per-chat pending entries, a per-window `shownBy` claim,
 * serialized writes, and `changed` notifications.
 */
export const MATCH_SCORE_THRESHOLD = 0.4;
export const BANNER_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const SUGGESTION_MAX_SHOWS = 3;
export const SUGGESTION_IDLE_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;
export const BANNER_DISMISSALS_BEFORE_PAUSE = 3;
export const BANNER_PAUSE_MS = 30 * 24 * 60 * 60 * 1000;

export interface SurfacingTurn {
  origin: SkillSuggestionOrigin;
  partition: string;
  /** `turnMatchId` of the turn. */
  turnId: string;
  /** `chainMatchId` of the turn's chat. */
  chainId: string;
  shape: PromptShape;
  /** The chat's skill sequence after this turn; `null` without skills. */
  chain: readonly string[] | null;
}

export type SkillSuggestionTelemetryAction = 'shown' | 'dismissed' | 'accepted';

export interface SurfacingDeps {
  registry: SkillSuggestionsRegistry;
  isEnabled: () => boolean;
  now: () => number;
  isShareNudgePending: (origin: SkillSuggestionOrigin) => boolean;
  memberOrganizations: () => MemberOrganizations;
  onAction?: (
    action: SkillSuggestionTelemetryAction,
    occurrenceCount: number,
  ) => void;
}

interface PendingEntry {
  origin: SkillSuggestionOrigin;
  id: string;
  suggestionId: string;
  state: 'pending' | 'shown';
  shownBy?: number;
  snapshot: SkillSuggestion;
}

const originKey = (origin: SkillSuggestionOrigin): string =>
  JSON.stringify([origin.projectId, origin.worktreeId, origin.chatId]);

function copyOrigin(origin: SkillSuggestionOrigin): SkillSuggestionOrigin {
  return {
    projectId: origin.projectId,
    worktreeId: origin.worktreeId,
    chatId: origin.chatId,
  };
}

/** The portable view of a stored suggestion; `null` for a closed partition. */
export function toSkillSuggestionDto(
  stored: StoredSkillSuggestion,
  organizations: MemberOrganizations,
): SkillSuggestion | null {
  const partition = parsePartitionKey(stored.partition);
  if (!partition || !isOpenSuggestion(stored)) return null;
  if (stored.state !== 'confirmed' && stored.state !== 'shown') return null;
  const isPrivate = partition.privateWorkspaceId !== null;
  return {
    id: stored.id,
    kind: stored.kind,
    title: stored.title,
    occurrenceCount: stored.matchedTurnIds.length,
    summary: stored.summary,
    proposedSkillName: stored.proposedSkillName,
    proposedDescription: stored.proposedDescription,
    parameters: [...stored.parameters],
    chainSkills: [...stored.chainSkills],
    examples: isPrivate ? [] : stored.exemplars.slice(0, 3),
    owner:
      partition.owner.kind === 'organization'
        ? {
            kind: 'organization',
            organizationId: partition.owner.organizationId,
          }
        : { kind: 'personal' },
    ownerLabel: ownerLabelFor(partition, organizations),
    isPrivate,
    lastSeenAt: stored.lastMatchedAt,
    state: stored.state,
  };
}

/** Best open suggestion this turn repeats, with its match id. */
export function findMatchingSuggestion(
  turn: SurfacingTurn,
  suggestions: readonly StoredSkillSuggestion[],
): { suggestion: StoredSkillSuggestion; matchId: string } | null {
  let best: {
    suggestion: StoredSkillSuggestion;
    matchId: string;
    score: number;
  } | null = null;
  for (const suggestion of suggestions) {
    if (
      !isOpenSuggestion(suggestion) ||
      suggestion.partition !== turn.partition
    )
      continue;
    if (suggestion.kind === 'chain') {
      if (turn.chain && chainEndsWith(turn.chain, suggestion.chainSkills)) {
        if (!best || best.score < 1) {
          best = { suggestion, matchId: turn.chainId, score: 1 };
        }
      }
      continue;
    }
    for (const member of suggestion.members) {
      const score = pairScore(turn.shape, member);
      if (
        score >= MATCH_SCORE_THRESHOLD &&
        sharedContentTokenCount(turn.shape.tokens, member.tokens) >=
          MIN_SHARED_CONTENT_TOKENS &&
        (!best || score > best.score)
      ) {
        best = { suggestion, matchId: turn.turnId, score };
      }
    }
  }
  return best ? { suggestion: best.suggestion, matchId: best.matchId } : null;
}

/** Expires suggestions shown three times or unmatched for 30 days. */
export function expireStaleSuggestions(
  state: SkillSuggestionsFile,
  now: number,
): string[] {
  const expired: string[] = [];
  for (const suggestion of state.suggestions) {
    if (!isOpenSuggestion(suggestion)) continue;
    if (
      suggestion.showCount >= SUGGESTION_MAX_SHOWS ||
      now - suggestion.lastMatchedAt > SUGGESTION_IDLE_EXPIRY_MS
    ) {
      resolveStoredSuggestion(suggestion, 'expired', now);
      expired.push(suggestion.id);
    }
  }
  return expired;
}

export class SkillSuggestionSurfacingState {
  private readonly pending = new Map<string, PendingEntry>();
  private readonly listeners = new Set<
    (event: SkillSuggestionChangedEvent) => void
  >();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: SurfacingDeps) {}

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const attempt = this.chain.then(operation, operation);
    this.chain = attempt.catch(() => undefined);
    return attempt;
  }

  subscribe(
    listener: (event: SkillSuggestionChangedEvent) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Scan confirmations and modal resolutions notify without an origin. */
  notifyChanged(origin?: SkillSuggestionOrigin): void {
    const event: SkillSuggestionChangedEvent = origin
      ? { origin: copyOrigin(origin) }
      : {};
    for (const listener of Array.from(this.listeners)) listener(event);
  }

  /** Counts a completed turn toward a matching suggestion and may surface it. */
  matchTurn(turn: SurfacingTurn): Promise<void> {
    return this.enqueue(async () => {
      if (!this.deps.isEnabled()) return;
      const now = this.deps.now();
      const organizations = this.deps.memberOrganizations();
      const key = originKey(turn.origin);
      const result = await this.deps.registry.update(
        (
          draft,
        ):
          | { surfaced: StoredSkillSuggestion | null; expired: boolean }
          | false => {
          const expired = expireStaleSuggestions(draft, now).length > 0;
          const match = findMatchingSuggestion(turn, draft.suggestions);
          if (!match) return expired ? { surfaced: null, expired } : false;
          const owner = parsePartitionKey(match.suggestion.partition)?.owner;
          if (!owner || !isOwnerAvailable(owner, organizations)) {
            return expired ? { surfaced: null, expired } : false;
          }
          // A turn already counted is not a new repeat.
          const counted = addMatchedTurn(match.suggestion, match.matchId, now);
          const canSurface =
            counted &&
            match.suggestion.showCount < SUGGESTION_MAX_SHOWS &&
            !this.pending.has(key) &&
            (draft.lastBannerShownAt === null ||
              now - draft.lastBannerShownAt >= BANNER_COOLDOWN_MS) &&
            (draft.bannerPausedUntil === null ||
              draft.bannerPausedUntil <= now) &&
            !this.deps.isShareNudgePending(turn.origin);
          return {
            surfaced: canSurface ? structuredClone(match.suggestion) : null,
            expired,
          };
        },
      );
      // Open lists (the modal and the Settings badge) drop expired rows.
      if (result !== false && result.expired) this.notifyChanged();
      const stored = result === false ? null : result.surfaced;
      if (!stored || !this.deps.isEnabled() || this.pending.has(key)) return;
      const snapshot = toSkillSuggestionDto(stored, organizations);
      if (!snapshot) return;
      this.pending.set(key, {
        origin: copyOrigin(turn.origin),
        id: randomUUID(),
        suggestionId: stored.id,
        state: 'pending',
        snapshot,
      });
      this.notifyChanged(turn.origin);
    });
  }

  getPending(
    origin: SkillSuggestionOrigin,
    senderId: number,
  ): PendingSkillSuggestion | null {
    if (!this.deps.isEnabled()) return null;
    const entry = this.pending.get(originKey(origin));
    if (!entry || (entry.shownBy !== undefined && entry.shownBy !== senderId))
      return null;
    const owner = entry.snapshot.owner;
    if (
      owner.kind === 'organization' &&
      !this.deps.memberOrganizations().has(owner.organizationId)
    )
      return null;
    return {
      id: entry.id,
      suggestion: structuredClone(entry.snapshot),
      state: entry.state,
    };
  }

  /** Every open suggestion for the modal and badge; never throttled. */
  async list(): Promise<SkillSuggestion[]> {
    if (!this.deps.isEnabled()) return [];
    const state = await this.deps.registry.read();
    const organizations = this.deps.memberOrganizations();
    const result: SkillSuggestion[] = [];
    for (const stored of state.suggestions) {
      const partition = parsePartitionKey(stored.partition);
      if (!partition || !isOwnerAvailable(partition.owner, organizations))
        continue;
      const dto = toSkillSuggestionDto(stored, organizations);
      if (dto) result.push(dto);
    }
    return result.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  resolve(
    request: ResolveSkillSuggestionRequest,
    senderId: number,
  ): Promise<boolean> {
    return this.enqueue(async () => {
      const now = this.deps.now();
      if (request.source === 'banner') {
        const key = originKey(request);
        const entry = this.pending.get(key);
        if (
          !entry ||
          entry.id !== request.pendingId ||
          entry.suggestionId !== request.suggestionId ||
          (entry.shownBy !== undefined && entry.shownBy !== senderId)
        )
          return false;
        // A repeated shown report from the window that showed it is a no-op,
        // so it never spends one of the suggestion's shows.
        if (request.resolution === 'shown' && entry.state === 'shown')
          return true;
        let occurrenceCount = entry.snapshot.occurrenceCount;
        let staleShown = false;
        let decided = false;
        const written = await this.deps.registry.update((draft) => {
          const stored = draft.suggestions.find(
            (candidate) => candidate.id === request.suggestionId,
          );
          if (request.resolution === 'shown') {
            // A stale banner for a resolved suggestion never spends the slot.
            if (!stored || !isOpenSuggestion(stored)) {
              staleShown = true;
              return false;
            }
            draft.lastBannerShownAt = now;
            stored.state = 'shown';
            stored.showCount += 1;
            occurrenceCount = stored.matchedTurnIds.length;
            return true;
          }
          // A banner decision also overrides an expiry that happened while
          // the banner was on screen (for example its third show).
          if (
            stored &&
            (isOpenSuggestion(stored) || stored.state === 'expired')
          ) {
            occurrenceCount = stored.matchedTurnIds.length;
            resolveStoredSuggestion(stored, request.resolution, now);
            decided = true;
          }
          if (request.resolution === 'dismissed') {
            // Only a dismissal that decided this suggestion counts; one that
            // no longer exists or was resolved elsewhere does not.
            if (decided) draft.consecutiveBannerDismissals += 1;
            if (
              draft.consecutiveBannerDismissals >=
              BANNER_DISMISSALS_BEFORE_PAUSE
            ) {
              draft.bannerPausedUntil = now + BANNER_PAUSE_MS;
              draft.consecutiveBannerDismissals = 0;
            }
          } else if (decided) {
            draft.consecutiveBannerDismissals = 0;
          }
          return true;
        });
        if (staleShown) {
          // Nothing is counted or claimed; the stale banner just goes away.
          if (this.pending.get(key) === entry) this.pending.delete(key);
          this.notifyChanged(entry.origin);
          return false;
        }
        if (written === false) return false;
        // Session disposal can remove the entry while the write is in flight.
        if (request.resolution === 'shown') {
          entry.shownBy = senderId;
          entry.state = 'shown';
          // One banner a day: unrendered banners in other chats are dropped.
          this.dropUnshownExcept(entry);
        } else {
          if (this.pending.get(key) === entry) this.pending.delete(key);
          this.dropPendingFor(request.suggestionId, entry);
        }
        // A decision on a suggestion that no longer exists is not an action.
        if (request.resolution === 'shown' || decided)
          this.deps.onAction?.(request.resolution, occurrenceCount);
        this.notifyChanged(entry.origin);
        if (request.resolution !== 'shown') this.notifyChanged();
        return true;
      }
      let occurrenceCount = 0;
      const resolved = await this.deps.registry.update((draft) => {
        const stored = draft.suggestions.find(
          (candidate) => candidate.id === request.suggestionId,
        );
        if (!stored || !isOpenSuggestion(stored)) return false;
        occurrenceCount = stored.matchedTurnIds.length;
        resolveStoredSuggestion(stored, request.resolution, now);
        // Modal dismissals never count toward the banner pause.
        if (request.resolution === 'accepted') {
          draft.consecutiveBannerDismissals = 0;
        }
        return true;
      });
      if (resolved === false) return false;
      this.dropPendingFor(request.suggestionId, null, true);
      this.deps.onAction?.(request.resolution, occurrenceCount);
      this.notifyChanged();
      return true;
    });
  }

  /** Suggestions removed outside a resolution (workspace deletion). */
  dropPendingForSuggestions(suggestionIds: readonly string[]): void {
    for (const id of suggestionIds) this.dropPendingFor(id, null, true);
  }

  private dropPendingFor(
    suggestionId: string,
    except: PendingEntry | null,
    includeShown = false,
  ): void {
    for (const [key, other] of Array.from(this.pending)) {
      if (other === except || other.suggestionId !== suggestionId) continue;
      // A visible banner stays until its own window resolves it, unless the
      // suggestion was resolved globally from the modal.
      if (!includeShown && other.state === 'shown') continue;
      this.pending.delete(key);
      this.notifyChanged(other.origin);
    }
  }

  private dropUnshownExcept(except: PendingEntry): void {
    for (const [key, other] of Array.from(this.pending)) {
      if (other === except || other.state === 'shown') continue;
      this.pending.delete(key);
      this.notifyChanged(other.origin);
    }
  }

  /** The chat's session was disposed. */
  clear(origin: SkillSuggestionOrigin): void {
    if (this.pending.delete(originKey(origin))) this.notifyChanged(origin);
  }

  /** The gate closed: every pending banner disappears. */
  clearAll(): void {
    const origins = Array.from(this.pending.values()).map(
      (entry) => entry.origin,
    );
    this.pending.clear();
    for (const origin of origins) this.notifyChanged(origin);
    this.notifyChanged();
  }

  pendingOrigins(): SkillSuggestionOrigin[] {
    return Array.from(this.pending.values()).map((entry) =>
      copyOrigin(entry.origin),
    );
  }
}
