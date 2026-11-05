import type {
  LocalMemoryFile,
  LocalMemoryFileDocument,
  LocalMemoryScope,
} from '@canopy/app-core/local-memory';

/** One scope the panel lists, with how its memories say where they apply. */
export interface MemoryPanelScope {
  readonly scope: LocalMemoryScope;
  /** Row metadata and filter label: "Everywhere" or the project name. */
  readonly label: string;
  /** The detail view's "Saved for" value: "Every project" or the project. */
  readonly savedFor: string;
}

export type MemoryKind = LocalMemoryFile['kind'];

/** A scope's index, a topic or a recent note. */
export interface MemoryEntry {
  /** Unique across scopes: the scope's key (or position) and the file key. */
  readonly id: string;
  readonly scopeIndex: number;
  readonly file: LocalMemoryFile;
  readonly title: string;
}

export interface MemoryFilters {
  readonly kinds: ReadonlySet<MemoryKind>;
  /** Scope indexes shown; every scope by default. */
  readonly scopes: ReadonlySet<number>;
}

/**
 * An opaque id for a memory row in tests. File names can hold the memory's
 * own words, and session replay records attributes as written, so rows carry
 * this 32-bit FNV-1a hash of the file key instead of the key itself.
 */
export function memoryRowId(fileKey: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < fileKey.length; index += 1) {
    hash ^= fileKey.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export const MEMORY_KIND_LABELS: Record<MemoryKind, string> = {
  index: 'Index',
  topic: 'Topic',
  inbox: 'Recent note',
};

export function defaultFilters(scopeCount: number): MemoryFilters {
  return {
    kinds: new Set<MemoryKind>(['index', 'topic', 'inbox']),
    scopes: new Set(Array.from({ length: scopeCount }, (_, index) => index)),
  };
}

/** How many filter choices are turned off. */
export function hiddenFilterCount(
  filters: MemoryFilters,
  scopeCount: number,
): number {
  return (
    3 -
    filters.kinds.size +
    (scopeCount > 1 ? scopeCount - filters.scopes.size : 0)
  );
}

function fileName(fileKey: string): string {
  return fileKey.replace(/^(topics|inbox)\//, '');
}

/** A scope's lasting key, so its rows keep their ids as scopes change. */
export function memoryScopeKey(scope: LocalMemoryScope): string {
  return scope.scope === 'user' ? 'user' : `workspace:${scope.workspaceId}`;
}

/**
 * Every scope's index, topics and recent notes, newest first. Ids start with
 * the scope's key from `scopeKeys` when given, else its position.
 */
export function memoryEntries(
  lists: readonly (readonly LocalMemoryFile[])[],
  scopeKeys?: readonly string[],
): MemoryEntry[] {
  const entries: MemoryEntry[] = [];
  lists.forEach((files, scopeIndex) => {
    const scopeKey = scopeKeys?.[scopeIndex] ?? String(scopeIndex);
    for (const file of files) {
      entries.push({
        id: `${scopeKey}:${file.fileKey}`,
        scopeIndex,
        file,
        title: file.title ?? fileName(file.fileKey),
      });
    }
  });
  return entries.sort(
    (left, right) =>
      Date.parse(right.file.modifiedAt) - Date.parse(left.file.modifiedAt) ||
      left.id.localeCompare(right.id),
  );
}

export function visibleEntries(
  entries: readonly MemoryEntry[],
  filters: MemoryFilters,
  query: string,
  hidden: ReadonlySet<string>,
): MemoryEntry[] {
  const needle = query.trim().toLocaleLowerCase();
  return entries.filter(
    (entry) =>
      !hidden.has(entry.id) &&
      filters.kinds.has(entry.file.kind) &&
      filters.scopes.has(entry.scopeIndex) &&
      (needle === '' ||
        `${entry.title}\n${entry.file.excerpt ?? ''}`
          .toLocaleLowerCase()
          .includes(needle)),
  );
}

export type DayGroup = 'Today' | 'This week' | 'Earlier';

function startOfDay(time: Date): number {
  return new Date(
    time.getFullYear(),
    time.getMonth(),
    time.getDate(),
  ).getTime();
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function dayGroup(iso: string, now: Date): DayGroup {
  const today = startOfDay(now);
  const time = Date.parse(iso);
  if (time >= today) return 'Today';
  if (time >= today - 6 * DAY_MS) return 'This week';
  return 'Earlier';
}

export function groupByDay(
  entries: readonly MemoryEntry[],
  now: Date,
): { group: DayGroup; entries: MemoryEntry[] }[] {
  const groups: { group: DayGroup; entries: MemoryEntry[] }[] = [];
  for (const entry of entries) {
    const group = dayGroup(entry.file.modifiedAt, now);
    const last = groups[groups.length - 1];
    if (last?.group === group) last.entries.push(entry);
    else groups.push({ group, entries: [entry] });
  }
  return groups;
}

const TIME = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
});
const DAY = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
});
const DAY_WITH_YEAR = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

function dayLabel(time: Date, now: Date): string {
  const today = startOfDay(now);
  if (time.getTime() >= today) return 'Today';
  if (time.getTime() >= today - DAY_MS) return 'Yesterday';
  return (
    time.getFullYear() === now.getFullYear() ? DAY : DAY_WITH_YEAR
  ).format(time);
}

/** A row's time: the clock time today, then "Yesterday", then the date. */
export function rowTime(iso: string, now: Date): string {
  const time = new Date(iso);
  const label = dayLabel(time, now);
  return label === 'Today' ? TIME.format(time) : label;
}

/** The detail view's time: "Today at 10:42 AM", "Oct 20 at 11:30 AM". */
export function savedTime(iso: string, now: Date): string {
  const time = new Date(iso);
  return `${dayLabel(time, now)} at ${TIME.format(time)}`;
}

/**
 * A level-1 ATX heading's text, following CommonMark: up to three spaces of
 * indent, a closing `#` run only after a space or tab, and Unicode
 * whitespace kept as content. Undefined for any other line.
 */
export function levelOneHeading(line: string): string | undefined {
  const marker = /^ {0,3}#(?:[ \t]+|$)/.exec(line);
  if (!marker) return undefined;
  let end = line.length;
  while (
    end > marker[0].length &&
    (line[end - 1] === ' ' || line[end - 1] === '\t')
  )
    end -= 1;
  const title = line.slice(marker[0].length, end);
  let hashes = title.length;
  while (hashes > 0 && title[hashes - 1] === '#') hashes -= 1;
  if (hashes === title.length) return title;
  if (hashes === 0) return '';
  const before = title[hashes - 1];
  return before === ' ' || before === '\t'
    ? title.slice(0, hashes).replace(/[ \t]+$/, '')
    : title;
}

/** A document as the detail view and editor use it: a title and a body. */
export interface MemoryContent {
  /** The level-1 heading that starts the file, when it has one. */
  readonly title?: string;
  /** The Markdown after the title, exactly as written. */
  readonly body: string;
}

function withoutLeadingBlankLines(text: string): string {
  return text.replace(/^(?:[ \t]*\n)+/, '');
}

/** Block text of an older host's items, which carry no raw Markdown. */
function itemsMarkdown(items: LocalMemoryFileDocument['items']): string {
  return items
    .flatMap((item) => [item.text, itemsMarkdown(item.children)])
    .filter((text) => text.trim() !== '')
    .join('\n\n');
}

export function memoryContent(
  document: LocalMemoryFileDocument,
): MemoryContent {
  const markdown = (document.markdown ?? itemsMarkdown(document.items)).replace(
    /\r\n?/g,
    '\n',
  );
  const lines = markdown.split('\n');
  const first = lines.findIndex((line) => line.trim() !== '');
  const title = first === -1 ? undefined : levelOneHeading(lines[first]);
  if (title === undefined)
    return { body: withoutLeadingBlankLines(markdown).replace(/\n+$/, '') };
  return {
    title,
    body: withoutLeadingBlankLines(lines.slice(first + 1).join('\n')).replace(
      /\n+$/,
      '',
    ),
  };
}
