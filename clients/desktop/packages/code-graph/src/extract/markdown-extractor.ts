import type { Node } from 'web-tree-sitter';
import type {
  CodeGraphEdgeRecord,
  CodeGraphFileFacts,
  CodeGraphFileRecord,
  CodeGraphSymbolRecord,
} from '../types/code-graph';
import {
  edgeRowId,
  fileQualifiedName,
  fileRowId,
  symbolQualifiedName,
  symbolRowId,
} from '../ids';
import type {
  CodeGraphParserRuntime,
  LoadedMarkdownGrammar,
  Range,
} from '../parser/runtime';
import type { NonCodeExtractorInput } from './extractor-registry';
import { isTestFilePath } from './tags-extractor';

// Doc sections are capped like code-definition containment (Phase 1 parity):
// past this many headings in one file, remaining headings are dropped and the
// drop count is recorded on the file symbol's `extra_json.truncatedFacts`.
const MAX_DOC_SECTIONS = 200;
const MAX_HEADING_NAME_LENGTH = 120;

// External targets (a URI scheme, e.g. `https:`/`mailto:`, in any letter
// case — `HTTPS://x` is exactly as external as `https://x`) or
// protocol-relative (`//host/...`) links are never repo-relative doc links.
// This pattern also (intentionally, and unchanged by the `i` flag) matches a
// Windows drive letter like `C:\...` / `c:\...`, which is likewise never a
// repo-relative reference.
const EXTERNAL_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i;
// `[[wikilink]]` targets — the markdown grammar has no concept of these (they
// parse as an ordinary `shortcut_link` with no destination), so they are
// recovered with a regex over the raw source instead of the parsed tree.
const WIKILINK_PATTERN = /\[\[([^\]]+)\]\]/g;

interface HeadingInfo {
  level: number;
  text: string;
  lineStart: number;
  byteStart: number;
}

interface LinkCandidate {
  target: string;
  line: number;
  raw: string;
}

interface PlacedSection {
  lineStart: number;
  lineEnd: number;
  symbol: CodeGraphSymbolRecord;
}

function headingLevel(node: Node): number | null {
  if (node.type === 'atx_heading') {
    for (const child of node.children) {
      if (child === null) {
        continue;
      }
      const match = /^atx_h([1-6])_marker$/.exec(child.type);
      if (match !== null) {
        return Number(match[1]);
      }
    }
    return null;
  }
  if (node.type === 'setext_heading') {
    const underline = node.descendantsOfType([
      'setext_h1_underline',
      'setext_h2_underline',
    ])[0];
    if (underline === undefined) {
      return null;
    }
    return underline.type === 'setext_h1_underline' ? 1 : 2;
  }
  return null;
}

function headingText(node: Node): string {
  const inline = node.descendantsOfType('inline')[0];
  return inline === undefined ? '' : inline.text.trim();
}

function collectHeadings(root: Node): HeadingInfo[] {
  const nodes = root.descendantsOfType(['atx_heading', 'setext_heading']);
  const headings: HeadingInfo[] = [];
  for (const node of nodes) {
    const level = headingLevel(node);
    if (level === null) {
      continue; // defensive: every heading node the grammar emits has a marker/underline
    }
    headings.push({
      level,
      text: headingText(node),
      lineStart: node.startPosition.row + 1,
      byteStart: node.startIndex,
    });
  }
  headings.sort((a, b) => a.byteStart - b.byteStart);
  return headings;
}

// Section end = the line just before the next heading at the SAME OR
// SHALLOWER level (standard heading-based sectioning), or end of file. This
// intentionally looks ahead across the FULL heading list (not just the
// retained/under-cap slice) so a truncated tail heading still correctly
// terminates the last retained section's span instead of letting it swallow
// content that conceptually belongs to a dropped section.
function computeLineEnd(
  headings: readonly HeadingInfo[],
  index: number,
  totalLines: number,
): number {
  const level = headings[index].level;
  for (let j = index + 1; j < headings.length; j += 1) {
    if (headings[j].level <= level) {
      return headings[j].lineStart - 1;
    }
  }
  return totalLines;
}

function slugify(text: string): string {
  const lowered = text.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const trimmed = lowered.replace(/^-+|-+$/g, '');
  return trimmed.length > 0 ? trimmed : 'section';
}

function buildLineStarts(source: string): number[] {
  const lineStarts = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '\n') {
      lineStarts.push(i + 1);
    }
  }
  return lineStarts;
}

function lineForIndex(lineStarts: readonly number[], index: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (lineStarts[mid] <= index) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low + 1; // 1-based line number
}

// Collects every `inline` node range in the block tree — headings AND
// paragraphs alike — exactly the recipe confirmed against the real grammar in
// the parser-runtime spike/test: a single inline-grammar parse over these
// ranges (via `{ includedRanges }`) recovers link destinations without a
// second full reparse.
function collectInlineRanges(root: Node): Range[] {
  const ranges: Range[] = [];
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) {
      continue;
    }
    if (node.type === 'inline') {
      ranges.push({
        startIndex: node.startIndex,
        endIndex: node.endIndex,
        startPosition: node.startPosition,
        endPosition: node.endPosition,
      });
    }
    for (let i = node.childCount - 1; i >= 0; i -= 1) {
      const child = node.child(i);
      if (child !== null) {
        stack.push(child);
      }
    }
  }
  ranges.sort((a, b) => a.startIndex - b.startIndex);
  return ranges;
}

function dedupeLinkCandidates(
  candidates: readonly LinkCandidate[],
): LinkCandidate[] {
  const seen = new Set<string>();
  const deduped: LinkCandidate[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.target} ${candidate.line}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(candidate);
  }
  return deduped;
}

function containsEdge(
  repoId: string,
  fileId: string,
  parentId: string,
  symbol: CodeGraphSymbolRecord,
): CodeGraphEdgeRecord {
  return {
    id: edgeRowId({
      repoId,
      kind: 'CONTAINS',
      sourceId: parentId,
      target: symbol.id,
      line: symbol.lineStart,
    }),
    repositoryId: repoId,
    kind: 'CONTAINS',
    sourceSymbolId: parentId,
    targetSymbolId: symbol.id,
    sourceFileId: fileId,
    targetRef: null,
    line: symbol.lineStart,
    confidenceTier: 'EXTRACTED',
    confidenceScore: 1.0,
    resolverId: null,
    evidence: {},
  };
}

interface DocSectionStackEntry {
  symbol: CodeGraphSymbolRecord;
  level: number;
  ownSlug: string;
  ancestorSlugs: readonly string[];
}

// Builds the `doc_section` symbols + CONTAINS edges for a file's heading
// hierarchy: a level stack (an h3 under the preceding h2 gets it as parent,
// exactly like code-definition containment), a per-file slug dedupe map
// (GitHub-anchor style `-2`/`-3` suffixes so colliding headings never drop a
// section), and the 200-section cap.
function buildDocSections(input: {
  repoId: string;
  relativePath: string;
  fileId: string;
  fileSymbolId: string;
  blockRoot: Node;
  totalLines: number;
}): {
  symbols: CodeGraphSymbolRecord[];
  edges: CodeGraphEdgeRecord[];
  truncatedFacts: number;
  placedSections: PlacedSection[];
} {
  const headings = collectHeadings(input.blockRoot);
  const retained = headings.slice(0, MAX_DOC_SECTIONS);
  const truncatedFacts = Math.max(0, headings.length - MAX_DOC_SECTIONS);

  const symbols: CodeGraphSymbolRecord[] = [];
  const edges: CodeGraphEdgeRecord[] = [];
  const placedSections: PlacedSection[] = [];
  // Tracks FINAL (already-suffixed) slugs, not raw pre-suffix slugs. A count
  // keyed on the raw slug alone can hand out a suffix that collides with a
  // heading whose OWN literal text already is that suffixed form (e.g.
  // "Section", "Section 2", "Section" — the count-based scheme assigns the
  // third heading "section-2", colliding with the second heading's literal
  // "section-2" slug). Looping suffix increments until the candidate is
  // actually unused avoids that collision regardless of literal heading text.
  const usedSlugs = new Set<string>();
  const stack: DocSectionStackEntry[] = [];

  for (let i = 0; i < retained.length; i += 1) {
    const heading = retained[i];
    while (stack.length > 0 && stack[stack.length - 1].level >= heading.level) {
      stack.pop();
    }
    const parentEntry = stack.length > 0 ? stack[stack.length - 1] : null;
    const ancestorSlugs =
      parentEntry === null
        ? []
        : [...parentEntry.ancestorSlugs, parentEntry.ownSlug];

    const rawSlug = slugify(heading.text);
    let ownSlug = rawSlug;
    let suffix = 2;
    while (usedSlugs.has(ownSlug)) {
      ownSlug = `${rawSlug}-${suffix}`;
      suffix += 1;
    }
    usedSlugs.add(ownSlug);

    const qualifiedName = symbolQualifiedName(
      input.relativePath,
      ancestorSlugs,
      ownSlug,
    );
    const symbol: CodeGraphSymbolRecord = {
      id: symbolRowId(input.repoId, qualifiedName),
      repositoryId: input.repoId,
      fileId: input.fileId,
      kind: 'doc_section',
      name: heading.text.slice(0, MAX_HEADING_NAME_LENGTH),
      qualifiedName,
      parentSymbolId: parentEntry === null ? null : parentEntry.symbol.id,
      lineStart: heading.lineStart,
      lineEnd: computeLineEnd(headings, i, input.totalLines),
      byteStart: heading.byteStart,
      byteEnd: heading.byteStart,
      signature: null,
      exported: false,
      isTest: false,
      extra: {},
    };
    symbols.push(symbol);
    placedSections.push({
      lineStart: symbol.lineStart,
      lineEnd: symbol.lineEnd,
      symbol,
    });

    const parentId =
      parentEntry === null ? input.fileSymbolId : parentEntry.symbol.id;
    edges.push(containsEdge(input.repoId, input.fileId, parentId, symbol));

    stack.push({ symbol, level: heading.level, ownSlug, ancestorSlugs });
  }

  return { symbols, edges, truncatedFacts, placedSections };
}

// Runs the inline-grammar parse over the block tree's `inline` ranges to
// recover `link_destination` texts, then adds `[[wikilink]]` targets found by
// a raw-source regex (the grammar has no concept of wikilinks). Returned
// candidates are deduped by (target, line).
function extractLinkCandidates(input: {
  runtime: CodeGraphParserRuntime;
  inlineGrammar: LoadedMarkdownGrammar;
  source: string;
  blockRoot: Node;
}): LinkCandidate[] {
  const candidates: LinkCandidate[] = [];
  const normalizeLabel = (text: string): string =>
    text
      .replace(/^\[|\]$/g, '')
      .trim()
      .replace(/\s+/g, ' ')
      .toLowerCase();
  const definitions = new Map<string, string>();
  for (const definition of input.blockRoot.descendantsOfType(
    'link_reference_definition',
  )) {
    const label = definition.descendantsOfType('link_label')[0];
    const destination = definition.descendantsOfType('link_destination')[0];
    if (
      label !== undefined &&
      destination !== undefined &&
      !definitions.has(normalizeLabel(label.text))
    ) {
      definitions.set(normalizeLabel(label.text), destination.text);
    }
  }
  const inlineRanges = collectInlineRanges(input.blockRoot);
  if (inlineRanges.length > 0) {
    input.runtime.withParserForLanguage(
      input.inlineGrammar.language,
      (inlineParser) =>
        input.runtime.withTreeOptions(
          inlineParser,
          input.source,
          { includedRanges: inlineRanges },
          (inlineTree) => {
            if (inlineTree === null) {
              return;
            }
            for (const link of inlineTree.rootNode.descendantsOfType([
              'full_reference_link',
              'collapsed_reference_link',
              'shortcut_link',
            ])) {
              const label =
                link.descendantsOfType('link_label')[0] ??
                link.descendantsOfType('link_text')[0];
              const target =
                label === undefined
                  ? undefined
                  : definitions.get(normalizeLabel(label.text));
              if (target !== undefined)
                candidates.push({
                  target,
                  line: link.startPosition.row + 1,
                  raw: link.text,
                });
            }
            for (const destination of inlineTree.rootNode.descendantsOfType(
              'link_destination',
            )) {
              candidates.push({
                target: destination.text,
                line: destination.startPosition.row + 1,
                raw: destination.text,
              });
            }
          },
        ),
    );
  }

  // Wikilinks are scanned only within the SAME `inline` node ranges used
  // above (headings and paragraphs), not the raw source — otherwise a
  // `[[literal]]`-looking sequence inside a fenced code block (or any other
  // non-inline block content) would be recovered as a spurious doc-link
  // candidate. Each range is scanned independently and match offsets are
  // rebased onto the full source before computing line numbers.
  const lineStarts = buildLineStarts(input.source);
  for (const range of inlineRanges) {
    const rangeSource = input.source.slice(range.startIndex, range.endIndex);
    WIKILINK_PATTERN.lastIndex = 0;
    let wikilinkMatch: RegExpExecArray | null;
    while ((wikilinkMatch = WIKILINK_PATTERN.exec(rangeSource)) !== null) {
      const captured = wikilinkMatch[1];
      const absoluteIndex = range.startIndex + wikilinkMatch.index;
      candidates.push({
        target: captured,
        line: lineForIndex(lineStarts, absoluteIndex),
        raw: captured,
      });
    }
  }

  return dedupeLinkCandidates(candidates);
}

function enclosingSectionId(
  placedSections: readonly PlacedSection[],
  fileSymbolId: string,
  line: number,
): string {
  let best: PlacedSection | null = null;
  for (const entry of placedSections) {
    if (entry.lineStart <= line && line <= entry.lineEnd) {
      if (best === null || entry.lineStart >= best.lineStart) {
        best = entry;
      }
    }
  }
  return best === null ? fileSymbolId : best.symbol.id;
}

// Filters link candidates down to repo doc references (skipping external
// schemes, protocol-relative, and pure-fragment links) and emits a
// `DOCUMENTS` edge per surviving link, sourced from its enclosing doc_section
// (by line containment) or the file symbol.
function buildDocumentEdges(input: {
  repoId: string;
  fileId: string;
  fileSymbolId: string;
  placedSections: readonly PlacedSection[];
  links: readonly LinkCandidate[];
}): CodeGraphEdgeRecord[] {
  const edges: CodeGraphEdgeRecord[] = [];
  for (const link of input.links) {
    const target = link.target;
    if (target.length === 0) {
      continue;
    }
    if (EXTERNAL_SCHEME_PATTERN.test(target) || target.startsWith('//')) {
      continue; // external link, not a repo doc reference
    }
    if (target.startsWith('#')) {
      continue; // pure-fragment link (same-doc anchor), not a doc reference
    }
    const hashIndex = target.indexOf('#');
    const targetRef = hashIndex === -1 ? target : target.slice(0, hashIndex);
    if (targetRef.length === 0) {
      continue; // defensive: malformed target left nothing after stripping the fragment
    }
    const sourceSymbolId = enclosingSectionId(
      input.placedSections,
      input.fileSymbolId,
      link.line,
    );
    edges.push({
      id: edgeRowId({
        repoId: input.repoId,
        kind: 'DOCUMENTS',
        sourceId: sourceSymbolId,
        target: targetRef,
        line: link.line,
      }),
      repositoryId: input.repoId,
      kind: 'DOCUMENTS',
      sourceSymbolId,
      targetSymbolId: null,
      sourceFileId: input.fileId,
      targetRef,
      line: link.line,
      confidenceTier: 'EXTRACTED',
      confidenceScore: 1.0,
      resolverId: null,
      evidence: { raw: link.raw },
    });
  }
  return edges;
}

export async function extractMarkdownFacts(
  input: NonCodeExtractorInput,
): Promise<CodeGraphFileFacts> {
  const relativePath = input.relativePath;
  const fileId = fileRowId(input.repoId, relativePath);
  const totalLines = Math.max(1, input.source.split('\n').length);
  const fileSymbol: CodeGraphSymbolRecord = {
    id: symbolRowId(input.repoId, fileQualifiedName(relativePath)),
    repositoryId: input.repoId,
    fileId,
    kind: 'file',
    name: relativePath.split('/').pop() ?? relativePath,
    qualifiedName: fileQualifiedName(relativePath),
    parentSymbolId: null,
    lineStart: 1,
    lineEnd: totalLines,
    byteStart: 0,
    byteEnd: input.sizeBytes,
    signature: null,
    exported: false,
    isTest: isTestFilePath(relativePath),
    extra: {},
  };
  const baseFile: Omit<
    CodeGraphFileRecord,
    'parseStatus' | 'hasErrors' | 'lineCount'
  > = {
    id: fileId,
    repositoryId: input.repoId,
    relativePath,
    absolutePath: input.absolutePath,
    language: 'markdown',
    contentHash: input.contentHash,
    sizeBytes: input.sizeBytes,
    mtimeNs: input.mtimeNs,
    grammarId: 'markdown',
    grammarAbi: null,
    updatedAt: Date.now(),
  };

  const { block, inline } = await input.runtime.getMarkdownGrammars();

  return input.runtime.withParserForLanguage(block.language, (blockParser) =>
    input.runtime.withTreeOptions(
      blockParser,
      input.source,
      undefined,
      (blockTree) => {
        if (blockTree === null) {
          return {
            file: {
              ...baseFile,
              parseStatus: 'failed',
              hasErrors: true,
              lineCount: null,
            },
            symbols: [fileSymbol],
            edges: [],
          };
        }

        const sections = buildDocSections({
          repoId: input.repoId,
          relativePath,
          fileId,
          fileSymbolId: fileSymbol.id,
          blockRoot: blockTree.rootNode,
          totalLines,
        });
        if (sections.truncatedFacts > 0) {
          fileSymbol.extra = {
            ...fileSymbol.extra,
            truncatedFacts: sections.truncatedFacts,
          };
        }

        const links = extractLinkCandidates({
          runtime: input.runtime,
          inlineGrammar: inline,
          source: input.source,
          blockRoot: blockTree.rootNode,
        });
        const documentEdges = buildDocumentEdges({
          repoId: input.repoId,
          fileId,
          fileSymbolId: fileSymbol.id,
          placedSections: sections.placedSections,
          links,
        });

        return {
          file: {
            ...baseFile,
            parseStatus: 'parsed',
            hasErrors: blockTree.rootNode.hasError,
            lineCount: totalLines,
          },
          symbols: [fileSymbol, ...sections.symbols],
          edges: [...sections.edges, ...documentEdges],
        };
      },
    ),
  );
}
