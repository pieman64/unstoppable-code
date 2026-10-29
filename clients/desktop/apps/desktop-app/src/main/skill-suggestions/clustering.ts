import type {
  ChatChainFingerprint,
  TurnFingerprint,
} from './fingerprint-store';
import { turnMatchId } from './fingerprint-store';
import {
  countContentTokens,
  isSlotToken,
  MIN_SHARED_CONTENT_TOKENS,
  pairScore,
  sharedContentTokenCount,
  skillsInToolShape,
} from './normalize';
import type { TimeSlicer } from './time-slicer';

/**
 * Deterministic grouping for one partition's fingerprints (CAN-385). Only
 * groups that pass these rules ever reach the model; with no candidates the
 * model is never called.
 */
export const CLUSTER_SCORE_THRESHOLD = 0.4;
export const MIN_GROUP_MEMBERS = 3;
export const MIN_GROUP_CHATS = 2;
export const MIN_GROUP_DAYS = 2;
export const MIN_CHAIN_CHATS = 3;
export const MIN_CHAIN_DAYS = 2;
export const MIN_CHAIN_LENGTH = 2;
export const MAX_CHAIN_LENGTH = 5;
/** Tokens in more than this share of rows are too common to index. */
export const COMMON_TOKEN_SHARE = 0.2;
const COMMON_TOKEN_FLOOR = 5;
/**
 * Each row always looks up its rarest tokens, even common ones, so a task
 * repeated in more than a fifth of rows still finds its other members.
 */
const MIN_LOOKUP_TOKENS = 2;

export interface PromptCandidate {
  kind: 'prompt';
  /** Newest first. */
  members: TurnFingerprint[];
}

export interface ChainCandidate {
  kind: 'chain';
  skills: string[];
  /** Newest first, one row per chat. */
  chats: ChatChainFingerprint[];
}

export type ClusterCandidate = PromptCandidate | ChainCandidate;

/** A turn whose only action is invoking one skill is already a skill. */
export function isSingleSkillTurn(row: TurnFingerprint): boolean {
  return (
    countContentTokens(row.tokens) === 0 &&
    row.tools.length === 1 &&
    row.tools[0]?.startsWith('skill:') === true
  );
}

function distinctCount<T>(rows: readonly T[], key: (row: T) => string): number {
  return new Set(rows.map(key)).size;
}

export function meetsGroupThreshold(rows: readonly TurnFingerprint[]): boolean {
  return (
    rows.length >= MIN_GROUP_MEMBERS &&
    distinctCount(rows, (row) => row.chatId) >= MIN_GROUP_CHATS &&
    distinctCount(rows, (row) => row.day) >= MIN_GROUP_DAYS
  );
}

class UnionFind {
  private readonly parent: number[];
  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, index) => index);
  }
  find(index: number): number {
    let root = index;
    while (this.parent[root] !== root) root = this.parent[root] ?? root;
    let current = index;
    while (this.parent[current] !== root) {
      const next = this.parent[current] ?? root;
      this.parent[current] = root;
      current = next;
    }
    return root;
  }
  union(a: number, b: number): void {
    const left = this.find(a);
    const right = this.find(b);
    if (left !== right) this.parent[right] = left;
  }
}

export interface PromptClusteringOptions {
  /** Turn ids already counted by an open suggestion. */
  excludeTurnIds?: ReadonlySet<string>;
  slicer?: TimeSlicer;
}

/**
 * Connected components of rows whose pair score is at least
 * {@link CLUSTER_SCORE_THRESHOLD}. Pairs are only compared when they share a
 * content token that is not too common (an inverted index), and the work runs
 * in time slices. Returns `null` when the slicer stops the run.
 */
export async function findPromptCandidates(
  input: readonly TurnFingerprint[],
  options: PromptClusteringOptions = {},
): Promise<PromptCandidate[] | null> {
  const exclude = options.excludeTurnIds ?? new Set<string>();
  const rows = input.filter(
    (row) => !isSingleSkillTurn(row) && !exclude.has(turnMatchId(row)),
  );
  const slicer = options.slicer;
  const index = new Map<string, number[]>();
  for (let i = 0; i < rows.length; i += 1) {
    for (const token of rows[i]?.tokens ?? []) {
      if (isSlotToken(token)) continue;
      const list = index.get(token);
      if (list) list.push(i);
      else index.set(token, [i]);
    }
    if (slicer && !(await slicer.tick())) return null;
  }
  const maxDocumentFrequency = Math.max(
    COMMON_TOKEN_FLOOR,
    Math.floor(rows.length * COMMON_TOKEN_SHARE),
  );
  const unions = new UnionFind(rows.length);
  const compared = new Set<number>();
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row) continue;
    compared.clear();
    const lookups = row.tokens
      .map((token) => index.get(token))
      .filter((list): list is number[] => list !== undefined)
      .sort((a, b) => a.length - b.length);
    for (let t = 0; t < lookups.length; t += 1) {
      const list = lookups[t] ?? [];
      // Sorted rarest first: past the guaranteed lookups, stop at common ones.
      if (t >= MIN_LOOKUP_TOKENS && list.length > maxDocumentFrequency) break;
      for (const j of list) {
        if (j <= i || compared.has(j)) continue;
        compared.add(j);
        // Already in one component: scoring the pair changes nothing.
        if (unions.find(i) === unions.find(j)) continue;
        const other = rows[j];
        if (
          other &&
          pairScore(row, other) >= CLUSTER_SCORE_THRESHOLD &&
          sharedContentTokenCount(row.tokens, other.tokens) >=
            MIN_SHARED_CONTENT_TOKENS
        ) {
          unions.union(i, j);
        }
      }
    }
    if (slicer && !(await slicer.tick())) return null;
  }
  const components = new Map<number, TurnFingerprint[]>();
  rows.forEach((row, i) => {
    const root = unions.find(i);
    const list = components.get(root);
    if (list) list.push(row);
    else components.set(root, [row]);
  });
  const candidates: PromptCandidate[] = [];
  for (const members of Array.from(components.values())) {
    if (!meetsGroupThreshold(members)) continue;
    candidates.push({
      kind: 'prompt',
      members: [...members].sort((a, b) => b.createdAt - a.createdAt),
    });
  }
  return candidates.sort(
    (a, b) =>
      b.members.length - a.members.length ||
      (b.members[0]?.createdAt ?? 0) - (a.members[0]?.createdAt ?? 0),
  );
}

export function collapseRepeats(skills: readonly string[]): string[] {
  const collapsed: string[] = [];
  for (const skill of skills) {
    if (collapsed[collapsed.length - 1] !== skill) collapsed.push(skill);
  }
  return collapsed;
}

function isContiguousSubsequence(
  needle: readonly string[],
  haystack: readonly string[],
): boolean {
  if (needle.length > haystack.length) return false;
  outer: for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

/** Whether `chain` ends with `suffix` after collapsing repeats. */
export function chainEndsWith(
  chain: readonly string[],
  suffix: readonly string[],
): boolean {
  const collapsed = collapseRepeats(chain);
  if (suffix.length === 0 || suffix.length > collapsed.length) return false;
  const offset = collapsed.length - suffix.length;
  return suffix.every((skill, i) => collapsed[offset + i] === skill);
}

export interface ChainClusteringOptions {
  /** Skill sequences any suggestion (open or resolved) already proposes. */
  existingChains?: readonly (readonly string[])[];
}

/**
 * Ordered skill subsequences of length 2 to 5, contiguous after collapsing
 * consecutive repeats, that appear in at least three chats on at least two
 * days. The longest qualifying chain wins and its sub-chains are dropped.
 */
export function findChainCandidates(
  chains: readonly ChatChainFingerprint[],
  options: ChainClusteringOptions = {},
): ChainCandidate[] {
  const bySequence = new Map<
    string,
    { skills: string[]; chats: Map<string, ChatChainFingerprint> }
  >();
  for (const row of chains) {
    const sequence = collapseRepeats(row.skills);
    for (
      let length = MIN_CHAIN_LENGTH;
      length <= MAX_CHAIN_LENGTH;
      length += 1
    ) {
      for (let start = 0; start + length <= sequence.length; start += 1) {
        const skills = sequence.slice(start, start + length);
        const key = JSON.stringify(skills);
        let entry = bySequence.get(key);
        if (!entry) {
          entry = { skills, chats: new Map() };
          bySequence.set(key, entry);
        }
        entry.chats.set(row.chatId, row);
      }
    }
  }
  const existing = new Set(
    (options.existingChains ?? []).map((skills) => JSON.stringify(skills)),
  );
  const qualifying = Array.from(bySequence.values())
    .map((entry) => ({
      skills: entry.skills,
      chats: Array.from(entry.chats.values()).sort(
        (a, b) => b.lastActivityAt - a.lastActivityAt,
      ),
    }))
    .filter(
      (entry) =>
        entry.chats.length >= MIN_CHAIN_CHATS &&
        distinctCount(entry.chats, (row) => row.day) >= MIN_CHAIN_DAYS,
    )
    .sort(
      (a, b) =>
        b.skills.length - a.skills.length || b.chats.length - a.chats.length,
    );
  const kept: ChainCandidate[] = [];
  for (const entry of qualifying) {
    if (
      kept.some((chain) => isContiguousSubsequence(entry.skills, chain.skills))
    )
      continue;
    kept.push({ kind: 'chain', skills: entry.skills, chats: entry.chats });
  }
  return kept.filter((entry) => !existing.has(JSON.stringify(entry.skills)));
}

/** Skill names a turn invoked, in order. */
export function turnSkills(row: { tools: readonly string[] }): string[] {
  return skillsInToolShape(row.tools);
}
