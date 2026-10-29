import type { CachedIndexEntry } from '@/stores/fileListStore';
import type { TurnGroupOrMessage, TurnMessage } from './types';

/** A small number of long reports can cost more layout work than many turns. */
export function shouldVirtualizeTranscript(
  groups: readonly TurnGroupOrMessage[],
): boolean {
  if (groups.length >= 80) return true;
  if (groups.length < 2) return false;
  let characters = 0;
  for (const group of groups) {
    const messages =
      group.kind === 'turn-group'
        ? [group.userMessage, ...group.assistantMessages]
        : [group.message];
    for (const message of messages) {
      for (const block of message.blocks) {
        // Collapsed tool output is not rendered text. Counting its size would
        // unnecessarily window short chats with a large deferred result.
        if (block.type !== 'text') continue;
        characters += block.text.length;
        if (characters >= 128 * 1024) return true;
      }
    }
  }
  return false;
}

export function shouldPreloadTranscriptFileIndex(
  hasMessages: boolean,
  entry: CachedIndexEntry | undefined,
  isLoading: boolean,
  error: string | undefined,
): boolean {
  return (
    hasMessages && entry === undefined && !isLoading && error === undefined
  );
}

export interface TranscriptWindowRange {
  startIndex: number;
  endIndex: number;
  overscan: number;
  count: number;
}

/**
 * The transcript window's sections: every visible one, plus its overscan
 * neighbours added progressively.
 *
 * A transcript section can be a whole turn of rendered Markdown, so a jump
 * that mounts the visible sections and all of their overscan at once builds,
 * styles and lays out several of them in one frame. Overscan sections that
 * are already mounted stay, and ones `measured` reports (a restored
 * position's saved sizes) join at once. Other new ones wait until every
 * visible section is mounted, then join one per pass, nearest first.
 */
export function progressiveTranscriptRange(
  range: TranscriptWindowRange,
  mounted: ReadonlySet<number>,
  measured: (index: number) => boolean = () => false,
): number[] {
  const { startIndex, endIndex, overscan, count } = range;
  const indexes: number[] = [];
  for (let index = startIndex; index <= endIndex; index += 1) {
    indexes.push(index);
  }
  let admissions = indexes.every((index) => mounted.has(index)) ? 1 : 0;
  for (let distance = 1; distance <= overscan; distance += 1) {
    for (const index of [endIndex + distance, startIndex - distance]) {
      if (index < 0 || index >= count) continue;
      if (mounted.has(index) || measured(index)) {
        indexes.push(index);
      } else if (admissions > 0) {
        indexes.push(index);
        admissions -= 1;
      }
    }
  }
  return indexes.sort((left, right) => left - right);
}

/** Height assumed for a transcript section before it is measured. */
const MIN_ESTIMATED_SECTION_HEIGHT_PX = 168;
/**
 * Rendered Markdown runs at roughly a quarter pixel of height per character
 * of source at the transcript's reading width. The estimate stays below that
 * so it does not overshoot ordinary turns.
 */
const ESTIMATED_HEIGHT_PX_PER_CHARACTER = 0.15;
const visibleCharacterCache = new WeakMap<TurnGroupOrMessage, number>();

function textCharacters(message: TurnMessage | undefined): number {
  let characters = 0;
  for (const block of message?.blocks ?? []) {
    if (block.type === 'text') characters += block.text.length;
  }
  return characters;
}

/** Characters of the text a collapsed item shows: its prompt and final reply. */
function visibleCharacters(item: TurnGroupOrMessage): number {
  const cached = visibleCharacterCache.get(item);
  if (cached !== undefined) return cached;
  let characters: number;
  if (item.kind === 'turn-group') {
    let reply = 0;
    for (
      let index = item.assistantMessages.length - 1;
      index >= 0;
      index -= 1
    ) {
      reply = textCharacters(item.assistantMessages[index]);
      if (reply > 0) break;
    }
    characters = textCharacters(item.userMessage) + reply;
  } else {
    characters = textCharacters(item.message);
  }
  visibleCharacterCache.set(item, characters);
  return characters;
}

/**
 * Pre-measurement height of a transcript section.
 *
 * Until a section is measured the virtualizer places it with this estimate.
 * A flat estimate makes a section holding a long report look a few lines
 * tall, so a jump to it counts several of its neighbours as visible and
 * builds them all, only to drop them once the first one is measured.
 */
export function estimateTranscriptSectionHeight(
  items: readonly TurnGroupOrMessage[],
): number {
  let characters = 0;
  for (const item of items) characters += visibleCharacters(item);
  return Math.max(
    MIN_ESTIMATED_SECTION_HEIGHT_PX,
    Math.round(characters * ESTIMATED_HEIGHT_PX_PER_CHARACTER),
  );
}
