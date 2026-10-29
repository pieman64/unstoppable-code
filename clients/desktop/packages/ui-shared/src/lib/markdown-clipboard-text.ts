import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { decodeEntity } from 'markdown-to-jsx/entities';

/**
 * Structural view of an mdast node: just the fields the clipboard walk
 * reads. Every node `fromMarkdown` produces satisfies it.
 */
interface ClipboardNode {
  readonly type: string;
  readonly value?: unknown;
  readonly alt?: unknown;
  readonly url?: unknown;
  readonly identifier?: unknown;
  readonly label?: unknown;
  readonly ordered?: unknown;
  readonly start?: unknown;
  readonly spread?: unknown;
  readonly checked?: unknown;
  readonly children?: readonly ClipboardNode[];
}

/** Mutable walk state: reference-link targets and raw-HTML skipping. */
interface WalkContext {
  readonly definitions: ReadonlyMap<string, string>;
  /** Set while inside `<script>` or `<style>`, whose contents are dropped. */
  skipUntilClosing: string | null;
}

/** Nodes with no visible text of their own. */
const SILENT_BLOCK_TYPES: ReadonlySet<string> = new Set([
  'definition',
  'thematicBreak',
  'yaml',
  'toml',
]);

/** Raw-HTML elements whose contents are never visible text. */
const SKIPPED_HTML_ELEMENTS: ReadonlySet<string> = new Set(['script', 'style']);

/** Raw-HTML elements that start or end a line where they appear. */
const HTML_BLOCK_ELEMENTS: ReadonlySet<string> = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'dd',
  'details',
  'div',
  'dl',
  'dt',
  'figcaption',
  'figure',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'tr',
  'ul',
]);

/**
 * One raw-HTML token: a comment (closed or running to the end), a tag (its
 * closing `>` optional, so a malformed trailing `<div` is still a tag), a lone
 * `<` that starts no tag, or a run of text.
 */
const HTML_TOKEN =
  /<!--[\s\S]*?(?:-->|$)|<(\/?)([A-Za-z][\w-]*)\b(?:[^>"']|"[^"]*(?:"|$)|'[^']*(?:'|$))*>?|<|[^<]+/g;

const HTML_ENTITY = /&(?:#(\d+)|#[xX]([0-9A-Fa-f]+)|([A-Za-z][A-Za-z0-9]+));/g;

function decodeHtmlEntities(text: string): string {
  return text.replace(
    HTML_ENTITY,
    (entity, decimal?: string, hex?: string, name?: string): string => {
      // Only an isolated, validated entity name reaches the Markdown
      // dependency's decoder. The original HTML is never passed to a DOM.
      if (name !== undefined) return decodeEntity(name) ?? entity;
      const codePoint = Number.parseInt(
        decimal ?? hex ?? '',
        decimal ? 10 : 16,
      );
      if (!Number.isFinite(codePoint) || codePoint < 1 || codePoint > 0x10ffff)
        return entity;
      return String.fromCodePoint(codePoint);
    },
  );
}

/** Read a real attribute, skipping quoted values of preceding attributes. */
function htmlAttribute(tag: string, name: string): string | undefined {
  const attributes =
    /\s+([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const attribute of tag.matchAll(attributes)) {
    if (attribute[1].toLowerCase() === name) {
      return attribute[2] ?? attribute[3] ?? attribute[4] ?? '';
    }
  }
  return undefined;
}

/**
 * Reduce raw HTML to inert text with string scanning only: nothing is parsed
 * into a DOM, mounted, executed, or fetched. Tags and comments are dropped,
 * `<script>`/`<style>` contents are skipped (across sibling inline nodes, via
 * `context`), `<br>` becomes a line break and, in `block` mode, block-level
 * elements start new lines.
 */
function htmlToText(
  html: string,
  context: WalkContext,
  mode: 'block' | 'inline',
): string {
  let text = '';
  let preformatted = false;
  let trailingBlockBoundary = false;
  const blockBoundary = (): void => {
    if (text.length > 0 && !text.endsWith('\n')) {
      text += '\n';
      trailingBlockBoundary = true;
    }
  };
  for (const match of html.matchAll(HTML_TOKEN)) {
    const token = match[0];
    const isClosing = match[1] === '/';
    const tagName = match[2]?.toLowerCase();
    if (context.skipUntilClosing !== null) {
      if (isClosing && tagName === context.skipUntilClosing) {
        context.skipUntilClosing = null;
      }
      continue;
    }
    if (token.startsWith('<!--')) continue;
    if (tagName === undefined) {
      // Source indentation between HTML blocks is not a visible line break.
      // Explicit <br> breaks and text inside <pre> remain exact.
      if (!preformatted && token.includes('\n') && token.trim().length === 0) {
        continue;
      }
      text += decodeHtmlEntities(token);
      trailingBlockBoundary = false;
      continue;
    }
    if (!isClosing && SKIPPED_HTML_ELEMENTS.has(tagName)) {
      if (!/\/>$/.test(token)) context.skipUntilClosing = tagName;
      continue;
    }
    if (tagName === 'img' && !isClosing) {
      const alt = htmlAttribute(token, 'alt');
      if (alt) {
        text += decodeHtmlEntities(alt);
        trailingBlockBoundary = false;
      }
    } else if (tagName === 'br') {
      text += '\n';
      trailingBlockBoundary = false;
    } else if (mode === 'block' && HTML_BLOCK_ELEMENTS.has(tagName)) {
      blockBoundary();
    }
    if (tagName === 'pre') preformatted = !isClosing;
  }
  // Remove only the synthetic final boundary, never text/code whitespace or
  // an explicit trailing <br>.
  return trailingBlockBoundary ? text.slice(0, -1) : text;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** `text (url)`, or just one of them when the other adds nothing. */
function linkText(text: string, url: string | undefined): string {
  if (!url) return text;
  if (text.length === 0) return url;
  if (
    url === text ||
    url === `http://${text}` ||
    url === `https://${text}` ||
    url === `mailto:${text}`
  ) {
    return text;
  }
  return `${text} (${url})`;
}

function phrasing(
  nodes: readonly ClipboardNode[] | undefined,
  context: WalkContext,
): string {
  if (!nodes) return '';
  let text = '';
  for (const node of nodes) {
    text += phrasingNode(node, context);
  }
  return text;
}

function phrasingNode(node: ClipboardNode, context: WalkContext): string {
  if (node.type === 'html') {
    return htmlToText(asString(node.value) ?? '', context, 'inline');
  }
  if (context.skipUntilClosing !== null) return '';
  switch (node.type) {
    case 'text':
    case 'inlineCode':
      return asString(node.value) ?? '';
    case 'break':
      return '\n';
    case 'image':
    case 'imageReference':
      return asString(node.alt) ?? '';
    case 'link':
      return linkText(phrasing(node.children, context), asString(node.url));
    case 'linkReference': {
      const identifier = asString(node.identifier);
      const url =
        identifier === undefined
          ? undefined
          : context.definitions.get(identifier);
      return linkText(phrasing(node.children, context), url);
    }
    case 'footnoteReference':
      return `[${asString(node.label) ?? asString(node.identifier) ?? ''}]`;
    default:
      return phrasing(node.children, context);
  }
}

/** Indent every line after the first that has content by `width` spaces. */
function indentContinuation(text: string, width: number): string {
  const pad = ' '.repeat(width);
  return text
    .split('\n')
    .map((line, index) =>
      index === 0 || line.length === 0 ? line : pad + line,
    )
    .join('\n');
}

function listText(list: ClipboardNode, context: WalkContext): string {
  const ordered = list.ordered === true;
  const start = typeof list.start === 'number' ? list.start : 1;
  const items = (list.children ?? []).map((item, index) => {
    const marker = ordered ? `${start + index}. ` : '- ';
    const task =
      item.checked === true ? '[x] ' : item.checked === false ? '[ ] ' : '';
    const body = blocks(
      item.children,
      context,
      item.spread === true ? '\n\n' : '\n',
    );
    return marker + task + indentContinuation(body, marker.length);
  });
  return items.join(list.spread === true ? '\n\n' : '\n');
}

function blockText(node: ClipboardNode, context: WalkContext): string {
  if (SILENT_BLOCK_TYPES.has(node.type)) return '';
  switch (node.type) {
    case 'paragraph':
    case 'heading':
    case 'tableCell':
      return phrasing(node.children, context);
    case 'code':
      return asString(node.value) ?? '';
    case 'html':
      return htmlToText(asString(node.value) ?? '', context, 'block');
    case 'list':
      return listText(node, context);
    case 'table':
      return (node.children ?? [])
        .map((row) =>
          (row.children ?? [])
            .map((cell) => phrasing(cell.children, context))
            .join('  '),
        )
        .join('\n');
    case 'footnoteDefinition': {
      const label = asString(node.label) ?? asString(node.identifier) ?? '';
      return `[${label}] ${blocks(node.children, context, '\n\n')}`;
    }
    default:
      // Blockquotes and any other container: their blocks, unmarked.
      return node.children ? blocks(node.children, context, '\n\n') : '';
  }
}

function blocks(
  nodes: readonly ClipboardNode[] | undefined,
  context: WalkContext,
  separator: string,
): string {
  if (!nodes) return '';
  const parts: string[] = [];
  for (const node of nodes) {
    const text = blockText(node, context);
    if (text.length > 0) parts.push(text);
  }
  return parts.join(separator);
}

function collectDefinitions(
  node: ClipboardNode,
  definitions: Map<string, string>,
): void {
  if (node.type === 'definition') {
    const identifier = asString(node.identifier);
    const url = asString(node.url);
    if (
      identifier !== undefined &&
      url !== undefined &&
      !definitions.has(identifier)
    ) {
      definitions.set(identifier, url);
    }
    return;
  }
  for (const child of node.children ?? []) {
    collectDefinitions(child, definitions);
  }
}

/**
 * Convert a whole chat message's Markdown into structured plain text for the
 * clipboard (CAN-4277's Copy message). Unlike `markdownToPlainText`, which
 * flattens a bounded prefix into one line for compact rows, this keeps the
 * whole message and its structure:
 *
 * - Top-level blocks are separated by a blank line; soft and hard line
 *   breaks inside a paragraph are kept.
 * - Heading, emphasis, strong, strikethrough and inline-code delimiters are
 *   removed; their text stays.
 * - Lists keep their order, nesting and starting number, with `- ` for
 *   unordered items and `[x]` / `[ ]` for task items.
 * - Blockquote markers are removed; code blocks keep their contents exactly,
 *   without fences or language.
 * - Links read `text (url)` unless the text already is the URL; reference
 *   links resolve through their definitions, which are omitted.
 * - Images become their alt text, table rows become lines with two spaces
 *   between cells, and thematic breaks are omitted.
 * - Raw HTML is reduced to its text by string scanning, never mounted or
 *   fetched; `<script>`/`<style>` contents are dropped.
 *
 * Nothing is truncated, cached or whitespace-collapsed. If the parser throws,
 * the original input is returned. Call it on demand (when copying), not
 * while rendering rows.
 */
export function markdownToClipboardText(markdown: string): string {
  if (markdown.length === 0) return '';
  try {
    const tree: ClipboardNode = fromMarkdown(markdown, {
      extensions: [gfm()],
      mdastExtensions: [gfmFromMarkdown()],
    });
    const definitions = new Map<string, string>();
    collectDefinitions(tree, definitions);
    return blocks(
      tree.children,
      { definitions, skipUntilClosing: null },
      '\n\n',
    );
  } catch {
    return markdown;
  }
}
