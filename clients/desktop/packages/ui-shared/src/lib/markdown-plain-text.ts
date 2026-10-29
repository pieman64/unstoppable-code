import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';

/**
 * Structural view of an mdast node: just the fields the plain-text walk
 * reads. Every node `fromMarkdown` produces satisfies it.
 */
interface PlainTextNode {
  readonly type: string;
  readonly value?: unknown;
  readonly alt?: unknown;
  readonly children?: readonly PlainTextNode[];
}

/**
 * Containers whose children are blocks (paragraphs, headings, list items),
 * joined as sentences so a flattened list does not read as one run-on line.
 */
const BLOCK_CONTAINER_TYPES: ReadonlySet<string> = new Set([
  'blockquote',
  'list',
  'listItem',
  'root',
]);

/**
 * Table containers: their children are rows and cells, separated by a plain
 * space. Every other container holds phrasing content, whose children join
 * without a separator so `**bold**text` stays `boldtext` and `[link](url).`
 * stays `link.`.
 */
const TABLE_CONTAINER_TYPES: ReadonlySet<string> = new Set([
  'table',
  'tableRow',
]);

/**
 * Anything the parser could change: line breaks, inline syntax, entities and
 * escapes anywhere, or a block marker (list, quote, heading, rule) at the
 * start. Text without any of these is already its own plain-text form.
 */
const MARKDOWN_SYNTAX = /[\r\n\\`*_#[\]!<>|~&]|^\s*(?:[-+=]|\d+[.)])/;

/**
 * A block that already ends a sentence, introduces the next one, or trails
 * off into it (a comma or dash), so no period is added after it.
 */
const BLOCK_END_PUNCTUATION = /[.!?:;,…–—]["')\]]*$/;

/** Nodes with no visible text of their own (URLs, definitions, rules). */
const SILENT_NODE_TYPES: ReadonlySet<string> = new Set([
  'definition',
  'footnoteDefinition',
  'footnoteReference',
  'thematicBreak',
  'yaml',
]);

const HTML_COMMENT = /<!--[\s\S]*?(?:-->|$)/g;
const HTML_TAG = /<[^>]*>/g;

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function nodeText(node: PlainTextNode): string {
  if (SILENT_NODE_TYPES.has(node.type)) return '';
  if (node.type === 'break') return ' ';
  if (node.type === 'html' && typeof node.value === 'string') {
    // Raw HTML: keep any text between tags, drop the tags and comments.
    return node.value.replace(HTML_COMMENT, ' ').replace(HTML_TAG, ' ');
  }
  if (node.type === 'image' || node.type === 'imageReference') {
    return typeof node.alt === 'string' ? node.alt : '';
  }
  if (typeof node.value === 'string') return node.value;
  if (!node.children) return '';
  if (BLOCK_CONTAINER_TYPES.has(node.type)) {
    return joinBlocks(node.children.map(nodeText));
  }
  const separator = TABLE_CONTAINER_TYPES.has(node.type) ? ' ' : '';
  return node.children.map(nodeText).join(separator);
}

/**
 * Join sibling blocks as sentences: a block that does not already end in
 * punctuation gets a period, so `1. Build` / `2. Ship` reads `Build. Ship`.
 */
function joinBlocks(blocks: readonly string[]): string {
  let text = '';
  for (const block of blocks) {
    const trimmed = collapseWhitespace(block);
    if (trimmed.length === 0) continue;
    if (text.length === 0) {
      text = trimmed;
    } else {
      text += BLOCK_END_PUNCTUATION.test(text) ? ` ${trimmed}` : `. ${trimmed}`;
    }
  }
  return text;
}

/**
 * The parser's cost grows faster than linearly with container nesting
 * (`> > > …`, nested lists), and descriptions reach it from public pages on
 * every request, so only this many leading characters are ever parsed. That
 * is far more than any row, card, or meta description shows.
 */
export const MAX_PLAIN_TEXT_SOURCE_CHARS = 1000;

/**
 * The opening `limit` characters of `markdown`, cut at the last whitespace
 * inside the limit so a word (or a link or emphasis with no spaces in it) is
 * not split. A multi-word construct crossing the cut can still leave its
 * opening syntax behind.
 */
export function boundedMarkdownSource(markdown: string, limit: number): string {
  if (markdown.length <= limit) return markdown;
  const prefix = markdown.slice(0, limit + 1);
  const lastSpace = prefix.search(/\s\S*$/);
  return lastSpace > 0 ? prefix.slice(0, lastSpace) : prefix.slice(0, limit);
}

function parseToPlainText(markdown: string): string {
  if (!MARKDOWN_SYNTAX.test(markdown)) return collapseWhitespace(markdown);
  try {
    const tree = fromMarkdown(markdown, {
      extensions: [gfm()],
      mdastExtensions: [gfmFromMarkdown()],
    });
    return collapseWhitespace(nodeText(tree));
  } catch {
    return collapseWhitespace(markdown);
  }
}

/**
 * Table rows call this on every render, so results are memoized by source
 * text in a bounded least-recently-used cache.
 */
const PLAIN_TEXT_CACHE_LIMIT = 500;
const plainTextCache = new Map<string, string>();

/**
 * Flatten an author-written Markdown description into one line of plain
 * text for compact rows, cards, and OG/meta descriptions.
 *
 * Link and image-reference text is kept while URLs are dropped, image alt
 * text stands in for the image, code keeps its text, and raw HTML keeps only
 * the text between its tags.
 * Blocks (paragraphs, headings, list items) are joined as sentences, while
 * typed lines inside one paragraph and cells in a table row are separated by
 * a single space. Only the first {@link MAX_PLAIN_TEXT_SOURCE_CHARS}
 * characters are read. If the parser throws, that prefix is returned with its
 * whitespace collapsed.
 */
export function markdownToPlainText(markdown: string): string {
  // Keyed by the bounded source so the cache never retains a huge input.
  const source = boundedMarkdownSource(markdown, MAX_PLAIN_TEXT_SOURCE_CHARS);
  const cached = plainTextCache.get(source);
  if (cached !== undefined) {
    // Re-insert so a hit counts as recent use.
    plainTextCache.delete(source);
    plainTextCache.set(source, cached);
    return cached;
  }
  const text = parseToPlainText(source);
  if (plainTextCache.size >= PLAIN_TEXT_CACHE_LIMIT) {
    // Least-recently-used eviction: Map iteration follows insertion order.
    const oldest = plainTextCache.keys().next();
    if (!oldest.done) plainTextCache.delete(oldest.value);
  }
  plainTextCache.set(source, text);
  return text;
}

/**
 * Plain-text form of an optional description, or `undefined` when there is
 * nothing left to show, so callers can fall back to their default copy.
 */
export function markdownDescriptionToPlainText(
  markdown: string | null | undefined,
): string | undefined {
  if (!markdown) return undefined;
  const text = markdownToPlainText(markdown);
  return text.length > 0 ? text : undefined;
}

/**
 * Whether a description has anything to show once rendered. `---`, a bare
 * link definition, or an image with no alt text is non-empty source but
 * renders nothing, so detail views use this to pick their empty state.
 *
 * This reads the mdast parse, while `DescriptionMarkdown` renders with
 * markdown-to-jsx. The two agree for ordinary descriptions; rare edge syntax
 * (such as footnotes, which flatten to nothing) can differ.
 */
export function hasMarkdownDescriptionText(
  markdown: string | null | undefined,
): markdown is string {
  if (!markdown) return false;
  if (markdownToPlainText(markdown).length > 0) return true;
  // Only a bounded prefix is flattened; assume text past it is visible.
  return markdown.length > MAX_PLAIN_TEXT_SOURCE_CHARS;
}
