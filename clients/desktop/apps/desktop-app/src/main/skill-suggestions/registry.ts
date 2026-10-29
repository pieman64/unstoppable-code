import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  SkillSuggestionKind,
  SkillSuggestionState,
} from '@canopy/desktop-shared/lib/skill-suggestions';
import { writeFileAtomically } from '../lib/atomic-file';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { getSkillSuggestionsStateFilePath } from '../lib/paths';
import {
  MIN_CHAIN_CHATS,
  MIN_GROUP_CHATS,
  MIN_GROUP_MEMBERS,
} from './clustering';
import { matchIdChatKey, matchIdProjectId } from './fingerprint-store';
import { isPrivatePartition, isPrivatePartitionOfWorkspace } from './partition';

/**
 * Durable, main-owned repeat-task skill suggestion state (CAN-385), written
 * atomically. Lost or corrupt state only means suggestions can recur.
 */
export const MAX_SUGGESTION_MEMBERS = 15;

export interface SuggestionMember {
  tokens: string[];
  tools: string[];
}

export interface StoredSkillSuggestion {
  id: string;
  kind: SkillSuggestionKind;
  state: SkillSuggestionState;
  partition: string;
  title: string;
  summary: string;
  proposedSkillName: string;
  proposedDescription: string;
  parameters: string[];
  chainSkills: string[];
  /** Redacted examples; never kept for private partitions or once resolved. */
  exemplars: string[];
  /** Up to {@link MAX_SUGGESTION_MEMBERS} member shapes for live matching. */
  members: SuggestionMember[];
  /** Cluster members plus every distinct live match; never duplicated. */
  matchedTurnIds: string[];
  showCount: number;
  createdAt: number;
  lastMatchedAt: number;
  resolvedAt?: number;
}

export interface BackfillCursor {
  done: boolean;
  nextChatIndex: number;
  chatIdsSnapshot?: string[];
}

export interface SkillSuggestionsFile {
  version: 1;
  suggestions: StoredSkillSuggestion[];
  lastBannerShownAt: number | null;
  /** Last scan per partition key, recorded for finished and failed scans. */
  lastScanAt: Record<string, number>;
  consecutiveBannerDismissals: number;
  bannerPausedUntil: number | null;
  backfill: BackfillCursor;
}

export const OPEN_STATES: ReadonlySet<SkillSuggestionState> =
  new Set<SkillSuggestionState>(['confirmed', 'shown']);
export const RESOLVED_STATES: ReadonlySet<SkillSuggestionState> =
  new Set<SkillSuggestionState>(['accepted', 'dismissed', 'expired']);

export function isOpenSuggestion(suggestion: StoredSkillSuggestion): boolean {
  return OPEN_STATES.has(suggestion.state);
}

export function emptySkillSuggestionsFile(): SkillSuggestionsFile {
  return {
    version: 1,
    suggestions: [],
    lastBannerShownAt: null,
    lastScanAt: {},
    consecutiveBannerDismissals: 0,
    bannerPausedUntil: null,
    backfill: { done: false, nextChatIndex: 0 },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function stringArray(value: unknown, max: number): string[] | null {
  if (!Array.isArray(value)) return null;
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') return null;
    result.push(entry);
  }
  return result.slice(0, max);
}
function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function isState(value: unknown): value is SkillSuggestionState {
  return (
    value === 'confirmed' ||
    value === 'shown' ||
    value === 'accepted' ||
    value === 'dismissed' ||
    value === 'expired'
  );
}

function parseMember(value: unknown): SuggestionMember | null {
  if (!isRecord(value)) return null;
  const tokens = stringArray(value.tokens, 200);
  const tools = stringArray(value.tools, 50);
  return tokens && tools ? { tokens, tools } : null;
}

function parseSuggestion(value: unknown): StoredSkillSuggestion | null {
  if (!isRecord(value)) return null;
  const parameters = stringArray(value.parameters, 5);
  const chainSkills = stringArray(value.chainSkills, 5);
  const exemplars = stringArray(value.exemplars, 3);
  const matchedTurnIds = stringArray(value.matchedTurnIds, 10_000);
  const createdAt = finiteNumber(value.createdAt);
  const lastMatchedAt = finiteNumber(value.lastMatchedAt);
  const showCount = finiteNumber(value.showCount);
  if (
    typeof value.id !== 'string' ||
    !value.id ||
    (value.kind !== 'prompt' && value.kind !== 'chain') ||
    !isState(value.state) ||
    typeof value.partition !== 'string' ||
    typeof value.title !== 'string' ||
    typeof value.summary !== 'string' ||
    typeof value.proposedSkillName !== 'string' ||
    typeof value.proposedDescription !== 'string' ||
    !parameters ||
    !chainSkills ||
    !exemplars ||
    !matchedTurnIds ||
    !Array.isArray(value.members) ||
    createdAt === null ||
    lastMatchedAt === null ||
    showCount === null
  )
    return null;
  const members: SuggestionMember[] = [];
  for (const entry of value.members.slice(0, MAX_SUGGESTION_MEMBERS)) {
    const member = parseMember(entry);
    if (member) members.push(member);
  }
  const resolvedAt = finiteNumber(value.resolvedAt);
  return {
    id: value.id,
    kind: value.kind,
    state: value.state,
    partition: value.partition,
    title: value.title,
    summary: value.summary,
    proposedSkillName: value.proposedSkillName,
    proposedDescription: value.proposedDescription,
    parameters,
    chainSkills,
    exemplars: isPrivatePartition(value.partition) ? [] : exemplars,
    members,
    matchedTurnIds: Array.from(new Set(matchedTurnIds)),
    showCount,
    createdAt,
    lastMatchedAt,
    ...(resolvedAt === null ? {} : { resolvedAt }),
  };
}

export function parseSkillSuggestionsFile(
  value: unknown,
): SkillSuggestionsFile | null {
  if (!isRecord(value) || value.version !== 1) return null;
  if (!Array.isArray(value.suggestions)) return null;
  const result = emptySkillSuggestionsFile();
  const seen = new Set<string>();
  for (const entry of value.suggestions) {
    const suggestion = parseSuggestion(entry);
    if (!suggestion || seen.has(suggestion.id)) continue;
    seen.add(suggestion.id);
    result.suggestions.push(suggestion);
  }
  result.lastBannerShownAt = finiteNumber(value.lastBannerShownAt);
  if (isRecord(value.lastScanAt)) {
    for (const [key, at] of Object.entries(value.lastScanAt)) {
      const parsed = finiteNumber(at);
      if (parsed !== null) result.lastScanAt[key] = parsed;
    }
  }
  const dismissals = finiteNumber(value.consecutiveBannerDismissals);
  result.consecutiveBannerDismissals =
    dismissals !== null && dismissals >= 0 ? Math.floor(dismissals) : 0;
  result.bannerPausedUntil = finiteNumber(value.bannerPausedUntil);
  if (isRecord(value.backfill)) {
    const next = finiteNumber(value.backfill.nextChatIndex);
    const snapshot = stringArray(value.backfill.chatIdsSnapshot, 10_000);
    result.backfill = {
      done: value.backfill.done === true,
      nextChatIndex: next !== null && next >= 0 ? Math.floor(next) : 0,
      ...(snapshot ? { chatIdsSnapshot: snapshot } : {}),
    };
  }
  return result;
}

/** Appends a turn id unless it is already counted. Returns whether it was new. */
export function addMatchedTurn(
  suggestion: StoredSkillSuggestion,
  turnId: string,
  now: number,
): boolean {
  if (suggestion.matchedTurnIds.includes(turnId)) return false;
  suggestion.matchedTurnIds.push(turnId);
  suggestion.lastMatchedAt = now;
  return true;
}

/**
 * Terminal transition. Neither raw text nor prompt-derived member tokens are
 * kept once a suggestion is resolved; only open suggestions match live turns.
 */
export function resolveStoredSuggestion(
  suggestion: StoredSkillSuggestion,
  state: 'accepted' | 'dismissed' | 'expired',
  now: number,
): void {
  suggestion.state = state;
  suggestion.resolvedAt = now;
  suggestion.exemplars = [];
  suggestion.members = [];
}

/**
 * The preference was turned off: open suggestions are dropped and the
 * backfill restarts on re-enable; resolved suggestions stay resolved so
 * dismissed work is never proposed again. Returns whether anything changed,
 * so an already-reset state is not rewritten.
 */
export function resetForPreferenceOff(state: SkillSuggestionsFile): boolean {
  const before = state.suggestions.length;
  state.suggestions = state.suggestions.filter(
    (entry) => !isOpenSuggestion(entry),
  );
  const changed =
    state.suggestions.length !== before ||
    state.backfill.done ||
    state.backfill.nextChatIndex !== 0 ||
    state.backfill.chatIdsSnapshot !== undefined ||
    Object.keys(state.lastScanAt).length > 0;
  state.backfill = { done: false, nextChatIndex: 0 };
  state.lastScanAt = {};
  return changed;
}

export interface WorkspacePurgeResult {
  suggestionsRemoved: number;
  matchesRemoved: number;
}

/** Match ids carry workspace and chat but not day, so days are not checked. */
function meetsStoredGroupRule(suggestion: StoredSkillSuggestion): boolean {
  const ids = suggestion.matchedTurnIds;
  if (suggestion.kind === 'chain') return ids.length >= MIN_CHAIN_CHATS;
  return (
    ids.length >= MIN_GROUP_MEMBERS &&
    new Set(ids.map(matchIdChatKey)).size >= MIN_GROUP_CHATS
  );
}

/** A deleted workspace's private suggestions and turn ids are dropped. */
export function purgeWorkspaceFromState(
  state: SkillSuggestionsFile,
  workspaceId: string,
  now: number,
): WorkspacePurgeResult {
  const before = state.suggestions.length;
  state.suggestions = state.suggestions.filter(
    (entry) => !isPrivatePartitionOfWorkspace(entry.partition, workspaceId),
  );
  let matchesRemoved = 0;
  const touched = new Set<StoredSkillSuggestion>();
  for (const suggestion of state.suggestions) {
    const kept = suggestion.matchedTurnIds.filter(
      (id) => matchIdProjectId(id) !== workspaceId,
    );
    matchesRemoved += suggestion.matchedTurnIds.length - kept.length;
    // Examples and member tokens carry no workspace, so any that may have
    // come from the deleted one are dropped.
    if (kept.length !== suggestion.matchedTurnIds.length) {
      suggestion.exemplars = [];
      suggestion.members = [];
      touched.add(suggestion);
    }
    suggestion.matchedTurnIds = kept;
  }
  // Like a scan, an open suggestion this purge leaves below its group rule
  // goes. One that still meets it can no longer match without its member
  // tokens, so it expires and the next scan may propose it again. Resolved
  // ones stay so dismissed work is never proposed again.
  state.suggestions = state.suggestions.filter(
    (entry) =>
      !touched.has(entry) ||
      !isOpenSuggestion(entry) ||
      meetsStoredGroupRule(entry),
  );
  for (const entry of state.suggestions) {
    if (touched.has(entry) && isOpenSuggestion(entry)) {
      resolveStoredSuggestion(entry, 'expired', now);
    }
  }
  // A pending backfill skips chats whose workspace no longer exists.
  return {
    suggestionsRemoved: before - state.suggestions.length,
    matchesRemoved,
  };
}

export class SkillSuggestionsRegistry {
  private chain: Promise<unknown> = Promise.resolve();
  private cache: SkillSuggestionsFile | null = null;
  private loggedCorruption = false;

  constructor(
    private readonly path: () => string = getSkillSuggestionsStateFilePath,
  ) {}

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.chain.then(operation, operation);
    this.chain = pending.catch(() => undefined);
    return pending;
  }

  private async load(): Promise<SkillSuggestionsFile> {
    if (this.cache) return this.cache;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.path(), 'utf8'));
    } catch (error) {
      if (isRecord(error) && error.code === 'ENOENT') {
        this.cache = emptySkillSuggestionsFile();
        return this.cache;
      }
      if (!(error instanceof SyntaxError)) throw error;
      parsed = null;
    }
    const state = parseSkillSuggestionsFile(parsed);
    if (!state && !this.loggedCorruption) {
      this.loggedCorruption = true;
      logMainProcessWarn(
        '[skill-suggestions] state file unreadable; starting empty',
      );
    }
    this.cache = state ?? emptySkillSuggestionsFile();
    return this.cache;
  }

  private async write(state: SkillSuggestionsFile): Promise<void> {
    const path = this.path();
    await mkdir(dirname(path), { recursive: true });
    await writeFileAtomically(path, JSON.stringify(state, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
  }

  /** A deep copy, so callers cannot mutate the cache outside `update`. */
  read(): Promise<SkillSuggestionsFile> {
    return this.serialize(async () => structuredClone(await this.load()));
  }

  /**
   * Serialized read-modify-write. The mutator edits a draft; returning
   * `false` skips the write. The cache only changes once the write lands.
   */
  update<T>(
    mutator: (draft: SkillSuggestionsFile) => T | false,
  ): Promise<T | false> {
    return this.serialize(async () => {
      const draft = structuredClone(await this.load());
      const result = mutator(draft);
      if (result === false) return false;
      await this.write(draft);
      this.cache = draft;
      return result;
    });
  }

  /** Test hook: forget the cache so the next read hits disk. */
  resetCacheForTests(): void {
    this.cache = null;
  }
}

let defaultRegistry: SkillSuggestionsRegistry | null = null;
export function getSkillSuggestionsRegistry(): SkillSuggestionsRegistry {
  defaultRegistry ??= new SkillSuggestionsRegistry();
  return defaultRegistry;
}
