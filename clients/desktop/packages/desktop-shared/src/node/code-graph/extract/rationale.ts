import type { Node, Tree } from 'web-tree-sitter';
import type {
  CodeGraphEdgeRecord,
  CodeGraphSymbolRecord,
} from '../../../types/code-graph';
import { edgeRowId, fileQualifiedName, symbolRowId } from '../ids';

// Comments whose text contains one of these markers (case-sensitive, word
// boundary immediately before the marker so e.g. "SOMENOTE:" never matches —
// there is no word boundary between the "E" of "SOME" and the "N" of "NOTE")
// are treated as rationale facts: NOTE/WHY/HACK explain a design decision,
// TODO/FIXME flag deferred work. Lowercase/mixed-case spellings (`todo:`) are
// intentionally NOT matched -- this is a narrow, high-signal marker set, not
// general comment mining. `.exec()` on a non-global pattern always returns
// the leftmost match, which is what gives us "first marker wins per comment".
const MARKER_PATTERN = /\b(NOTE|WHY|HACK|TODO|FIXME):/;

// A file's rationale comments are capped at this many entries; any surplus
// (in source order) is dropped. The caller (engine.ts) records the drop
// count on the file symbol's `extra.truncatedFacts`, mirroring the
// doc-section/manifest-entry cap convention in markdown-extractor.ts /
// manifest-extractors.ts. extractRationale itself has no access to the file
// symbol object (only its id), so it reports the count instead of mutating
// anything.
export const RATIONALE_MAX_PER_FILE = 100;

// A rationale comment "belongs" to a definition if the comment's line falls
// inside that definition's line range (e.g. a comment on the first line of a
// function/method body), or -- the far more common case -- a definition
// starts within this many lines AFTER the comment (a comment immediately
// above the thing it explains). Anything farther away, or when the file has
// no definitions at all, is attributed to the file symbol itself (a
// trailing/orphan comment).
const FOLLOWING_DEFINITION_LINE_WINDOW = 3;

const MAX_SIGNATURE_LENGTH = 200;

export interface ExtractRationaleInput {
  tree: Tree;
  source: string;
  repoId: string;
  relativePath: string;
  fileId: string;
  fileSymbolId: string;
  // Definitions already extracted for this file (tags-query matches from the
  // SAME parse), excluding the file symbol itself. Supplied by engine.ts via
  // the `onTree` hook's second parameter -- see the comment on
  // `ExtractFileInput.onTree` in tags-extractor.ts for why this can't wait
  // until after `extractFileFacts` returns.
  definitions: readonly CodeGraphSymbolRecord[];
}

export interface ExtractRationaleResult {
  symbols: CodeGraphSymbolRecord[];
  edges: CodeGraphEdgeRecord[];
  // Count of rationale comments found beyond RATIONALE_MAX_PER_FILE, dropped
  // in source order (first-found order, i.e. document order of the comment
  // nodes). Zero when under the cap.
  truncatedFacts: number;
}

// Generated-output directories are skipped for rationale purposes even
// though `dist`/`out`/`build` are already excluded from the scan corpus
// (`CODE_GRAPH_DEFAULT_IGNORED_DIRECTORIES` in scan/scanner.ts) -- this is an
// explicit, independently-testable belt-and-suspenders check scoped to
// rationale extraction, so a future change to the scan ignore list (or a
// committed `generated/` tree, which scanning does NOT exclude) can't
// silently start mining boilerplate TODOs for "rationale".
const GENERATED_DIR_PATTERN = /(^|\/)(dist|out|build|generated)\//;

export function isRationaleExcludedPath(
  relativePath: string,
  isTestFile: boolean,
): boolean {
  return isTestFile || GENERATED_DIR_PATTERN.test(relativePath);
}

interface RawRationaleComment {
  marker: string;
  line: number;
  // 0-based column of the marker's own start on `line`. Only consulted when
  // `line` collides with an earlier rationale comment on the SAME physical
  // line (e.g. two block comments like `/* NOTE: a */ /* HACK: b */`) --
  // see the qualifiedName construction in extractRationale below.
  column: number;
  byteStart: number;
  byteEnd: number;
  signature: string;
}

// Cleans the single physical line of comment text following the marker's
// colon: strips a trailing block-comment closer (`*/`), strips leftover
// leading comment punctuation (`*`, `/`, whitespace -- defensive, since a
// marker on its own JSDoc continuation line like ` * NOTE: ...` has already
// had its `*` prefix consumed by the marker match itself), trims, and caps
// at 200 chars.
function cleanSignatureLine(raw: string): string {
  const firstLine = raw.split('\n', 1)[0] ?? '';
  const withoutBlockClose = firstLine.replace(/\*+\/\s*$/, '');
  const withoutLeadingPunctuation = withoutBlockClose.replace(/^[\s*/]+/, '');
  return withoutLeadingPunctuation.trim().slice(0, MAX_SIGNATURE_LENGTH);
}

// Finds the first marker occurrence anywhere in a (possibly multi-line block)
// comment node's text, and returns the rationale fact for it, or null if no
// marker is present. Only the first match counts -- "multi-line block
// comments count once (first marker wins)".
function firstRationaleComment(node: Node): RawRationaleComment | null {
  const text = node.text;
  const match = MARKER_PATTERN.exec(text);
  if (match === null) {
    return null;
  }
  const marker = match[1];
  const matchIndex = match.index;
  const textBeforeMatch = text.slice(0, matchIndex);
  const lastNewlineBeforeMatch = textBeforeMatch.lastIndexOf('\n');
  const linesBeforeMatch = textBeforeMatch.split('\n').length - 1;
  const line = node.startPosition.row + 1 + linesBeforeMatch;
  // On the comment node's own first line, the marker's column is offset by
  // where the node itself starts; on any later line, a newline always
  // resets the column to 0, so the marker's column is simply its distance
  // past that last newline.
  const column =
    lastNewlineBeforeMatch === -1
      ? node.startPosition.column + matchIndex
      : matchIndex - lastNewlineBeforeMatch - 1;
  const afterMarker = text.slice(matchIndex + marker.length + 1); // +1 skips the colon
  return {
    marker,
    line,
    column,
    byteStart: node.startIndex,
    byteEnd: node.endIndex,
    signature: cleanSignatureLine(afterMarker),
  };
}

// Nearest-target resolution, in priority order: containment (innermost
// definition whose line range contains the comment line -- mirrors
// tags-extractor.ts's `enclosingSymbolForLine`'s "largest byteStart wins"
// tie-break for nested definitions), then the nearest definition starting
// within the following-line window, else the file symbol.
function resolveTargetSymbolId(
  definitions: readonly CodeGraphSymbolRecord[],
  fileSymbolId: string,
  line: number,
): string {
  let containing: CodeGraphSymbolRecord | null = null;
  for (const definition of definitions) {
    if (definition.lineStart <= line && line <= definition.lineEnd) {
      if (containing === null || definition.byteStart >= containing.byteStart) {
        containing = definition;
      }
    }
  }
  if (containing !== null) {
    return containing.id;
  }

  let nearestFollowing: CodeGraphSymbolRecord | null = null;
  for (const definition of definitions) {
    const distance = definition.lineStart - line;
    if (distance > 0 && distance <= FOLLOWING_DEFINITION_LINE_WINDOW) {
      if (
        nearestFollowing === null ||
        definition.lineStart < nearestFollowing.lineStart
      ) {
        nearestFollowing = definition;
      }
    }
  }
  if (nearestFollowing !== null) {
    return nearestFollowing.id;
  }

  return fileSymbolId;
}

export function extractRationale(
  input: ExtractRationaleInput,
): ExtractRationaleResult {
  const relativePath = input.relativePath;
  const comments = input.tree.rootNode.descendantsOfType('comment');
  const collected: RawRationaleComment[] = [];
  for (const comment of comments) {
    const rationale = firstRationaleComment(comment);
    if (rationale !== null) {
      collected.push(rationale);
    }
  }

  const truncatedFacts = Math.max(0, collected.length - RATIONALE_MAX_PER_FILE);
  const retained = collected.slice(0, RATIONALE_MAX_PER_FILE);

  const symbols: CodeGraphSymbolRecord[] = [];
  const edges: CodeGraphEdgeRecord[] = [];
  // Two rationale comments can share the same physical `line` (e.g. two
  // block comments on one line: `/* NOTE: a */ /* HACK: b */`), which would
  // otherwise collide on the same `rationale.L<line>` qualifiedName and have
  // one silently dropped by INSERT OR REPLACE. A column discriminator is
  // added ONLY when needed: the first comment seen on a given line keeps the
  // plain `L<line>` form; any subsequent comment on that same line gets
  // `L<line>C<column>` instead.
  const seenLines = new Set<number>();
  for (const rationale of retained) {
    const qualifiedName = seenLines.has(rationale.line)
      ? `${fileQualifiedName(relativePath)}::rationale.L${rationale.line}C${rationale.column}`
      : `${fileQualifiedName(relativePath)}::rationale.L${rationale.line}`;
    seenLines.add(rationale.line);
    const symbol: CodeGraphSymbolRecord = {
      id: symbolRowId(input.repoId, qualifiedName),
      repositoryId: input.repoId,
      fileId: input.fileId,
      kind: 'rationale',
      name: rationale.marker,
      qualifiedName,
      parentSymbolId: null,
      lineStart: rationale.line,
      lineEnd: rationale.line,
      byteStart: rationale.byteStart,
      byteEnd: rationale.byteEnd,
      signature: rationale.signature,
      exported: false,
      isTest: false,
      extra: {},
    };
    symbols.push(symbol);

    const targetSymbolId = resolveTargetSymbolId(
      input.definitions,
      input.fileSymbolId,
      rationale.line,
    );
    edges.push({
      id: edgeRowId({
        repoId: input.repoId,
        kind: 'RATIONALE_FOR',
        sourceId: symbol.id,
        target: targetSymbolId,
        line: rationale.line,
      }),
      repositoryId: input.repoId,
      kind: 'RATIONALE_FOR',
      sourceSymbolId: symbol.id,
      targetSymbolId,
      sourceFileId: input.fileId,
      targetRef: null,
      line: rationale.line,
      confidenceTier: 'EXTRACTED',
      confidenceScore: 1.0,
      resolverId: null,
      evidence: {},
    });
  }

  return { symbols, edges, truncatedFacts };
}
