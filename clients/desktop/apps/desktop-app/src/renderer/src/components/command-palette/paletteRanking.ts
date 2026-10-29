import { fuzzyMatch } from '@/lib/fuzzySearch';
import {
  PALETTE_RECENT_CAP,
  PALETTE_SECTION_BY_KIND,
  PALETTE_SECTION_CAP,
  PALETTE_SECTION_ORDER,
  type PaletteItem,
  type PaletteItemKind,
} from './paletteItems';

/** An item plus its computed score and title highlight indices. */
export interface RankedPaletteItem {
  item: PaletteItem;
  score: number;
  /** Match indices into `item.title` (empty for empty-query / content rows). */
  titleIndices: number[];
}

export type PaletteFlatEntry =
  | { type: 'item'; id: string; ranked: RankedPaletteItem }
  | {
      type: 'show-more';
      id: string;
      sectionId: string;
      count: number;
      visibleItemCount: number;
    };

export interface PaletteSection {
  id: string;
  label: string;
  items: RankedPaletteItem[];
  /** Count hidden by the per-section cap (0 when nothing was truncated). */
  truncated: number;
}

export interface PaletteRanking {
  sections: PaletteSection[];
  /** Sections flattened in render order for keyboard navigation. */
  flat: PaletteFlatEntry[];
}

const COMMANDS_ONLY_PREFIX = '>';
const SUBTITLE_WEIGHT = 0.5;
const KEYWORD_WEIGHT = 0.4;
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

function applyFieldWeight(score: number, weight: number): number {
  return score >= 0 ? score * weight : score / weight;
}

/** Tiered recency rank used only after fuzzy scores tie. */
function recencyRank(timestamp: number | undefined, now: number): number {
  if (timestamp === undefined) {
    return 0;
  }
  const age = now - timestamp;
  if (age <= DAY_MS) {
    return 2;
  }
  if (age <= WEEK_MS) {
    return 1;
  }
  return 0;
}

interface FieldScore {
  score: number;
  titleIndices: number[];
}

/** Characters that start a new word/segment for coherence checks. */
const WORD_BOUNDARY = /[\s/._\-•:,("'\[]/;

/** Match the title from its start, allowing the final query word to be partial. */
export function isStrongCommandTitleMatch(
  query: string,
  title: string,
): boolean {
  const normalizedQuery = query.trim().toLowerCase().replace(/\s+/g, ' ');
  const normalizedTitle = title.trim().toLowerCase().replace(/\s+/g, ' ');
  if (normalizedQuery.length === 0) {
    return false;
  }

  // Completed words (including their separators) must match exactly. The
  // final word may be a prefix: "ope" and "open sett" both match Open Settings.
  let wordStart = normalizedQuery.length;
  while (
    wordStart > 0 &&
    WORD_BOUNDARY.test(normalizedQuery[wordStart - 1] ?? '') === false
  ) {
    wordStart -= 1;
  }
  return (
    normalizedTitle.slice(0, wordStart) ===
      normalizedQuery.slice(0, wordStart) &&
    normalizedTitle
      .slice(wordStart)
      .startsWith(normalizedQuery.slice(wordStart))
  );
}

function isWordStart(target: string, index: number): boolean {
  if (index === 0) {
    return true;
  }
  return WORD_BOUNDARY.test(target[index - 1] ?? '');
}

/**
 * Reject "scattered" subsequence matches. `fuzzyMatch` accepts any in-order
 * subsequence, so a 6-char query happily matches random characters spread
 * across a long chat title — pure noise in the palette. A match is coherent
 * when it contains a substring-like consecutive run, or when most characters
 * land on word starts (acronym-style, e.g. "bwa" → "build-web-apps").
 */
function isCoherentMatch(
  target: string,
  indices: readonly number[],
  queryLength: number,
): boolean {
  if (queryLength <= 1) {
    return true;
  }
  let run = 1;
  let bestRun = 1;
  let wordStartHits = isWordStart(target, indices[0] ?? 0) ? 1 : 0;
  for (let i = 1; i < indices.length; i += 1) {
    run = indices[i] === indices[i - 1] + 1 ? run + 1 : 1;
    bestRun = Math.max(bestRun, run);
    if (isWordStart(target, indices[i] ?? 0)) {
      wordStartHits += 1;
    }
  }
  if (bestRun >= Math.min(queryLength, 4)) {
    return true;
  }
  return wordStartHits >= Math.ceil(queryLength * 0.6);
}

function coherentFieldMatch(
  query: string,
  target: string,
): ReturnType<typeof fuzzyMatch> {
  const match = fuzzyMatch(query, target);
  // `indices.length` is the normalized (trimmed) query length — the number of
  // characters that actually had to match.
  if (!match || !isCoherentMatch(target, match.indices, match.indices.length)) {
    return null;
  }
  return match;
}

/**
 * Score an item against a non-empty query: title at full weight (keeping
 * indices for highlighting), subtitle and keywords at reduced weight
 * (match-only). Scattered subsequence matches are rejected per field (see
 * {@link isCoherentMatch}). Returns null when no field matches.
 */
function scoreItem(item: PaletteItem, query: string): FieldScore | null {
  let best = Number.NEGATIVE_INFINITY;
  let titleIndices: number[] = [];

  const titleMatch = coherentFieldMatch(query, item.title);
  if (titleMatch) {
    best = titleMatch.score;
    titleIndices = titleMatch.indices;
  }

  if (item.subtitle) {
    const subtitleMatch = coherentFieldMatch(query, item.subtitle);
    if (subtitleMatch) {
      best = Math.max(
        best,
        applyFieldWeight(subtitleMatch.score, SUBTITLE_WEIGHT),
      );
    }
  }

  for (const keyword of item.keywords ?? []) {
    if (!keyword) {
      continue;
    }
    const keywordMatch = coherentFieldMatch(query, keyword);
    if (keywordMatch) {
      best = Math.max(
        best,
        applyFieldWeight(keywordMatch.score, KEYWORD_WEIGHT),
      );
    }
  }

  if (best === Number.NEGATIVE_INFINITY) {
    return null;
  }
  return { score: best, titleIndices };
}

function compareRanked(
  a: RankedPaletteItem,
  b: RankedPaletteItem,
  now: number,
): number {
  if (b.score !== a.score) {
    return b.score - a.score;
  }
  const shortcutDifference =
    Number(Boolean(b.item.shortcut)) - Number(Boolean(a.item.shortcut));
  if (shortcutDifference !== 0) {
    return shortcutDifference;
  }
  const recencyDifference =
    recencyRank(b.item.timestamp, now) - recencyRank(a.item.timestamp, now);
  if (recencyDifference !== 0) {
    return recencyDifference;
  }
  const at = a.item.timestamp ?? 0;
  const bt = b.item.timestamp ?? 0;
  if (bt !== at) {
    return bt - at;
  }
  return a.item.title.localeCompare(b.item.title);
}

function cappedSection(
  id: string,
  label: string,
  ranked: RankedPaletteItem[],
  cap: number,
): PaletteSection {
  const items = cap === Infinity ? ranked : ranked.slice(0, cap);
  return {
    id,
    label,
    items,
    truncated: Math.max(0, ranked.length - items.length),
  };
}

function flatten(sections: PaletteSection[]): PaletteRanking {
  return {
    sections,
    flat: sections.flatMap((section): PaletteFlatEntry[] => {
      const itemEntries: PaletteFlatEntry[] = section.items.map((ranked) => ({
        type: 'item',
        id: ranked.item.id,
        ranked,
      }));
      if (section.truncated === 0) {
        return itemEntries;
      }
      return [
        ...itemEntries,
        {
          type: 'show-more',
          id: `show-more:${section.id}`,
          sectionId: section.id,
          count: section.truncated,
          visibleItemCount: section.items.length,
        },
      ];
    }),
  };
}

/**
 * Split a raw palette query into its `>`-commands-only flag and the trimmed
 * search text (prefix stripped). Exported so the palette can reuse the same
 * parsing to gate the tier-2 transcript query.
 */
export function parseQuery(rawQuery: string): {
  commandsOnly: boolean;
  query: string;
} {
  const leftTrimmed = rawQuery.replace(/^\s+/, '');
  const commandsOnly = leftTrimmed.startsWith(COMMANDS_ONLY_PREFIX);
  const query = (commandsOnly ? leftTrimmed.slice(1) : rawQuery)
    .trim()
    .replace(/\s+/g, ' ');
  return { commandsOnly, query };
}

/** Empty-query view: "Recent" chats/worktrees by recency + top commands. */
function buildEmptyQueryRanking(
  items: readonly PaletteItem[],
  commandsOnly: boolean,
  expandedSectionIds: ReadonlySet<string>,
): PaletteRanking {
  const toRanked = (item: PaletteItem): RankedPaletteItem => ({
    item,
    score: item.timestamp ?? 0,
    titleIndices: [],
  });

  const commands = items
    .filter((item) => item.kind === 'command')
    .map(toRanked)
    .sort(
      (a, b) =>
        Number(Boolean(b.item.shortcut)) - Number(Boolean(a.item.shortcut)) ||
        a.item.title.localeCompare(b.item.title),
    );

  if (commandsOnly) {
    // `>` with no text → the full commands catalog.
    return flatten([cappedSection('commands', 'Commands', commands, Infinity)]);
  }

  const recent = items
    .filter((item) => item.kind === 'chat' || item.kind === 'worktree')
    .map(toRanked)
    .sort((a, b) => (b.item.timestamp ?? 0) - (a.item.timestamp ?? 0));

  const sections: PaletteSection[] = [];
  if (recent.length > 0) {
    sections.push(
      cappedSection(
        'recent',
        'Recent',
        recent,
        expandedSectionIds.has('recent') ? Infinity : PALETTE_RECENT_CAP,
      ),
    );
  }
  if (commands.length > 0) {
    sections.push(
      cappedSection(
        'commands',
        'Commands',
        commands,
        expandedSectionIds.has('commands') ? Infinity : PALETTE_SECTION_CAP,
      ),
    );
  }
  return flatten(sections);
}

/**
 * Rank tier-0/tier-1 items into grouped, capped, ordered sections plus a
 * flattened keyboard-nav list. `chat-content` (tier 2) is NOT ranked here — it
 * is appended separately so existing indices stay stable when it arrives.
 *
 * - `>` prefix filters to commands only (prefix stripped before matching).
 * - Empty query returns "Recent" by recency + commands with shortcuts first,
 *   then alphabetical within each group.
 * - Otherwise: fuzzy score first, then shortcut presence, recency, and title.
 *   Sections are ordered by their best item's score (exact matches bubble to
 *   the top); commands stay last unless their best title match is strong.
 */
export function rankPaletteItems(
  items: readonly PaletteItem[],
  rawQuery: string,
  now: number = Date.now(),
  expandedSectionIds: ReadonlySet<string> = new Set(),
): PaletteRanking {
  const { commandsOnly, query } = parseQuery(rawQuery);
  const candidates = commandsOnly
    ? items.filter((item) => item.kind === 'command')
    : items.filter((item) => item.kind !== 'chat-content');

  if (query.length === 0) {
    return buildEmptyQueryRanking(candidates, commandsOnly, expandedSectionIds);
  }

  const grouped = new Map<PaletteItemKind, RankedPaletteItem[]>();
  for (const item of candidates) {
    const scored = scoreItem(item, query);
    if (!scored) {
      continue;
    }
    const ranked: RankedPaletteItem = {
      item,
      score: scored.score,
      titleIndices: scored.titleIndices,
    };
    const bucket = grouped.get(item.kind);
    if (bucket) {
      bucket.push(ranked);
    } else {
      grouped.set(item.kind, [ranked]);
    }
  }

  interface SectionCandidate {
    kind: PaletteItemKind;
    section: PaletteSection;
    bestScore: number;
    canonicalIndex: number;
  }

  const candidatesByScore: SectionCandidate[] = [];
  for (const kind of PALETTE_SECTION_ORDER) {
    const bucket = grouped.get(kind);
    if (!bucket || bucket.length === 0) {
      continue;
    }
    bucket.sort((a, b) => compareRanked(a, b, now));
    const meta = PALETTE_SECTION_BY_KIND[kind];
    const cap =
      (commandsOnly && kind === 'command') || expandedSectionIds.has(meta.id)
        ? Infinity
        : PALETTE_SECTION_CAP;
    candidatesByScore.push({
      kind,
      section: cappedSection(meta.id, meta.label, bucket, cap),
      bestScore: bucket[0]?.score ?? Number.NEGATIVE_INFINITY,
      canonicalIndex: PALETTE_SECTION_ORDER.indexOf(kind),
    });
  }

  // Sections are ordered by their strongest match so an exact hit (skill name,
  // chat title, …) always surfaces at the top regardless of its entity kind.
  // Weak command title matches stay last; strong matches compete by score.
  // Equal scores keep canonical order, including Commands last.
  const topCommand = grouped.get('command')?.[0];
  const commandsStrong =
    topCommand !== undefined &&
    isStrongCommandTitleMatch(query, topCommand.item.title);
  candidatesByScore.sort((a, b) => {
    const aCommand = a.kind === 'command' ? 1 : 0;
    const bCommand = b.kind === 'command' ? 1 : 0;
    if (commandsStrong === false && aCommand !== bCommand) {
      return aCommand - bCommand;
    }
    if (b.bestScore !== a.bestScore) {
      return b.bestScore - a.bestScore;
    }
    return a.canonicalIndex - b.canonicalIndex;
  });

  return flatten(candidatesByScore.map((candidate) => candidate.section));
}

/**
 * Append the tier-2 "In transcripts" section (already backend-ranked by bm25)
 * to an existing ranking. Appending keeps earlier section indices — and the
 * current keyboard selection — stable.
 */
export function withChatContentSection(
  ranking: PaletteRanking,
  contentItems: readonly PaletteItem[],
): PaletteRanking {
  if (contentItems.length === 0) {
    return ranking;
  }
  const meta = PALETTE_SECTION_BY_KIND['chat-content'];
  const items: RankedPaletteItem[] = contentItems.map((item) => ({
    item,
    score: 0,
    titleIndices: [],
  }));
  return flatten([
    ...ranking.sections,
    { id: meta.id, label: meta.label, items, truncated: 0 },
  ]);
}
