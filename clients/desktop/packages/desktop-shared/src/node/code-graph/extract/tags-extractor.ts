import { indexLexicalBindings } from './lexical-bindings';
import type { Node, Tree } from 'web-tree-sitter';
import type {
  CodeGraphEdgeRecord,
  CodeGraphFileFacts,
  CodeGraphFileRecord,
  CodeGraphSymbolKind,
  CodeGraphSymbolRecord,
} from '../../../types/code-graph';
import {
  edgeRowId,
  fileQualifiedName,
  fileRowId,
  symbolQualifiedName,
  symbolRowId,
} from '../ids';
import type {
  CodeGraphParserRuntime,
  LoadedCodeGraphGrammar,
} from '../parser/runtime';

export interface ExtractFileInput {
  grammar: LoadedCodeGraphGrammar;
  runtime: CodeGraphParserRuntime;
  repoId: string;
  relativePath: string;
  absolutePath: string;
  source: string;
  sizeBytes: number;
  mtimeNs: string;
  contentHash: string;
  isTestFile: boolean;
  // Invoked with the parsed tree AND the definitions extracted so far (every
  // non-file symbol built below; the file symbol itself is always excluded)
  // after fact extraction, inside the tree's lifetime scope, so a single
  // parse can serve additional passes (import extraction, rationale-comment
  // binding) without reparsing the source. The definitions list must be
  // handed over here rather than read back off the returned `CodeGraphFileFacts`
  // afterwards: `extractFileFacts` returns only after this hook runs, and the
  // underlying `Tree` is `.delete()`-d once `withTree`'s scope closes, so any
  // pass that needs both the tree AND the definitions (e.g. rationale target
  // binding) has to run synchronously inside this callback.
  onTree?: (tree: Tree, definitions: readonly CodeGraphSymbolRecord[]) => void;
}

const DEFINITION_KIND_MAP: ReadonlyMap<string, CodeGraphSymbolKind> = new Map([
  ['definition.class', 'class'],
  ['definition.interface', 'interface'],
  ['definition.function', 'function'],
  ['definition.method', 'method'],
  ['definition.module', 'module'],
  ['definition.constant', 'variable'],
  ['definition.type', 'type'],
  ['definition.enum', 'enum'],
]);

const REFERENCE_CAPTURES: ReadonlySet<string> = new Set([
  'reference.call',
  'reference.class',
  'reference.type',
  'reference.implementation',
]);

export function isTestFilePath(relativePath: string): boolean {
  return (
    /(^|\/)__tests__\//.test(relativePath) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(relativePath)
  );
}

interface RawDefinition {
  capture: string;
  kind: CodeGraphSymbolKind;
  name: string;
  node: Node;
}

interface RawReference {
  node: Node;
  capture: string;
  name: string;
  line: number;
}

function exportStatement(node: Node): Node | null {
  let current = node.parent;
  // Only wrappers around this declaration can export it. An enclosing
  // function/class being exported does not export its nested declarations.
  while (current !== null) {
    if (current.type === 'export_statement') return current;
    if (
      ![
        'ambient_declaration',
        'lexical_declaration',
        'variable_declaration',
        'variable_declarator',
      ].includes(current.type)
    )
      return null;
    current = current.parent;
  }
  return null;
}

function firstLineSignature(node: Node): string {
  const firstLine = node.text.split('\n', 1)[0] ?? '';
  return firstLine.trim().slice(0, 200);
}

export function extractFileFacts(input: ExtractFileInput): CodeGraphFileFacts {
  const relativePath = input.relativePath;
  const fileId = fileRowId(input.repoId, relativePath);
  const fileSymbol: CodeGraphSymbolRecord = {
    id: symbolRowId(input.repoId, fileQualifiedName(relativePath)),
    repositoryId: input.repoId,
    fileId,
    kind: 'file',
    name: relativePath.split('/').pop() ?? relativePath,
    qualifiedName: fileQualifiedName(relativePath),
    parentSymbolId: null,
    lineStart: 1,
    lineEnd: Math.max(1, input.source.split('\n').length),
    byteStart: 0,
    byteEnd: input.sizeBytes,
    signature: null,
    exported: false,
    isTest: input.isTestFile,
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
    language: input.grammar.definition.id,
    contentHash: input.contentHash,
    sizeBytes: input.sizeBytes,
    mtimeNs: input.mtimeNs,
    grammarId: input.grammar.definition.id,
    grammarAbi: input.grammar.abiVersion,
    updatedAt: Date.now(),
  };

  return input.runtime.withParser(input.grammar, (parser) =>
    input.runtime.withTree(parser, input.source, (tree) => {
      if (tree === null) {
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

      const definitions: RawDefinition[] = [];
      const references: RawReference[] = [];
      const seenReferences = new Set<string>();
      for (const match of input.grammar.tagsQuery.matches(tree.rootNode)) {
        let capture: string | null = null;
        let captureNode: Node | null = null;
        let nameNode: Node | null = null;
        for (const c of match.captures) {
          if (
            c.name.startsWith('definition.') ||
            REFERENCE_CAPTURES.has(c.name)
          ) {
            capture = c.name;
            captureNode = c.node;
          } else if (c.name === 'name') {
            nameNode = c.node;
          }
        }
        if (capture === null || captureNode === null) {
          continue;
        }
        if (capture.startsWith('definition.')) {
          const kind = DEFINITION_KIND_MAP.get(capture);
          if (kind === undefined || nameNode === null) {
            continue;
          }
          definitions.push({
            capture,
            kind,
            name: nameNode.text,
            node: captureNode,
          });
        } else {
          const name = nameNode !== null ? nameNode.text : captureNode.text;
          const line = captureNode.startPosition.row + 1;
          const referenceKey = `${capture} ${name} ${captureNode.startIndex}`;
          if (seenReferences.has(referenceKey)) {
            continue; // JS + TS queries can both capture the same reference.
          }
          seenReferences.add(referenceKey);
          references.push({ capture, name, line, node: captureNode });
        }
      }

      // Containment: sort so parents precede children, then walk a stack.
      definitions.sort(
        (a, b) =>
          a.node.startIndex - b.node.startIndex ||
          b.node.endIndex - a.node.endIndex,
      );
      const symbols: CodeGraphSymbolRecord[] = [fileSymbol];
      const edges: CodeGraphEdgeRecord[] = [];
      const seenQualifiedNames = new Set<string>([fileSymbol.qualifiedName]);
      interface StackEntry {
        symbol: CodeGraphSymbolRecord;
        endIndex: number;
        ancestors: readonly string[];
      }
      const stack: StackEntry[] = [];
      const placed: Array<{
        startIndex: number;
        endIndex: number;
        symbol: CodeGraphSymbolRecord;
        definitionTypes: Set<string>;
      }> = [];
      const placedByQualifiedName = new Map<string, (typeof placed)[number]>();

      const addContains = (
        parentId: string,
        childId: string,
        line: number,
      ): void => {
        edges.push({
          id: edgeRowId({
            repoId: input.repoId,
            kind: 'CONTAINS',
            sourceId: parentId,
            target: childId,
            line,
          }),
          repositoryId: input.repoId,
          kind: 'CONTAINS',
          sourceSymbolId: parentId,
          targetSymbolId: childId,
          sourceFileId: fileId,
          targetRef: null,
          line,
          confidenceTier: 'EXTRACTED',
          confidenceScore: 1.0,
          resolverId: null,
          evidence: {},
        });
      };

      for (const definition of definitions) {
        while (
          stack.length > 0 &&
          definition.node.startIndex >= stack[stack.length - 1].endIndex
        ) {
          stack.pop();
        }
        const parentEntry = stack.length > 0 ? stack[stack.length - 1] : null;
        const ancestors =
          parentEntry === null
            ? []
            : [...parentEntry.ancestors, parentEntry.symbol.name];
        const qualifiedName = symbolQualifiedName(
          relativePath,
          ancestors,
          definition.name,
        );
        if (seenQualifiedNames.has(qualifiedName)) {
          const existing = placedByQualifiedName.get(qualifiedName);
          if (
            existing !== undefined &&
            existing.symbol.kind === 'function' &&
            definition.kind === 'function' &&
            (existing.definitionTypes.has('function_signature') ||
              definition.node.type === 'function_signature') &&
            (existing.startIndex !== definition.node.startIndex ||
              existing.endIndex !== definition.node.endIndex)
          ) {
            existing.definitionTypes.add(definition.node.type);
            existing.startIndex = Math.min(
              existing.startIndex,
              definition.node.startIndex,
            );
            existing.endIndex = Math.max(
              existing.endIndex,
              definition.node.endIndex,
            );
            existing.symbol.lineStart = Math.min(
              existing.symbol.lineStart,
              definition.node.startPosition.row + 1,
            );
            existing.symbol.lineEnd = Math.max(
              existing.symbol.lineEnd,
              definition.node.endPosition.row + 1,
            );
            existing.symbol.byteStart = existing.startIndex;
            existing.symbol.byteEnd = existing.endIndex;
            const statement = exportStatement(definition.node);
            existing.symbol.exported ||= statement !== null;
            if (
              statement?.children.some((child) => child.type === 'default') ===
              true
            )
              existing.symbol.extra.defaultExport = true;
            stack.push({
              symbol: existing.symbol,
              endIndex: existing.endIndex,
              ancestors,
            });
          }
          continue; // JS + TS queries can both match the same definition.
        }
        seenQualifiedNames.add(qualifiedName);
        const symbol: CodeGraphSymbolRecord = {
          id: symbolRowId(input.repoId, qualifiedName),
          repositoryId: input.repoId,
          fileId,
          kind: definition.kind,
          name: definition.name,
          qualifiedName,
          parentSymbolId: parentEntry === null ? null : parentEntry.symbol.id,
          lineStart: definition.node.startPosition.row + 1,
          lineEnd: definition.node.endPosition.row + 1,
          byteStart: definition.node.startIndex,
          byteEnd: definition.node.endIndex,
          signature: firstLineSignature(definition.node),
          exported: exportStatement(definition.node) !== null,
          isTest: input.isTestFile,
          extra: exportStatement(definition.node)?.children.some(
            (child) => child.type === 'default',
          )
            ? { defaultExport: true }
            : {},
        };
        symbols.push(symbol);
        const placement = {
          startIndex: definition.node.startIndex,
          endIndex: definition.node.endIndex,
          symbol,
          definitionTypes: new Set([definition.node.type]),
        };
        placed.push(placement);
        placedByQualifiedName.set(qualifiedName, placement);
        addContains(
          parentEntry === null ? fileSymbol.id : parentEntry.symbol.id,
          symbol.id,
          symbol.lineStart,
        );
        stack.push({ symbol, endIndex: definition.node.endIndex, ancestors });
      }

      const enclosingSymbolForSpan = (node: Node): CodeGraphSymbolRecord => {
        let best: CodeGraphSymbolRecord | null = null;
        for (const entry of placed) {
          if (
            entry.startIndex <= node.startIndex &&
            node.endIndex <= entry.endIndex
          ) {
            if (best === null || entry.symbol.byteStart >= best.byteStart) {
              best = entry.symbol;
            }
          }
        }
        return best ?? fileSymbol;
      };

      const localExports: Array<{ exported: string; local: string }> = [];
      for (const statement of tree.rootNode.namedChildren) {
        if (
          statement.type !== 'export_statement' ||
          statement.childForFieldName('source') !== null
        )
          continue;
        for (const specifier of statement.descendantsOfType(
          'export_specifier',
        )) {
          const name = specifier.childForFieldName('name');
          const alias = specifier.childForFieldName('alias');
          if (name !== null)
            localExports.push({
              exported: (alias ?? name).text,
              local: name.text,
            });
        }
        if (statement.children.some((child) => child.type === 'default')) {
          const declaration =
            statement.childForFieldName('declaration') ??
            statement.childForFieldName('value');
          const name =
            declaration?.childForFieldName('name') ??
            (declaration?.type === 'identifier' ? declaration : null);
          if (name !== null && name !== undefined)
            localExports.push({ exported: 'default', local: name.text });
        }
      }
      fileSymbol.extra.localExports = localExports;
      if (input.grammar.definition.id === 'swift') {
        fileSymbol.extra.callResolution = 'unsupported';
        fileSymbol.extra.visibility = 'not-analyzed';
      }
      const lexicalEvidence = ['typescript', 'tsx', 'javascript'].includes(
        input.grammar.definition.id,
      )
        ? indexLexicalBindings(tree.rootNode, symbols.slice(1))
        : (): Record<string, unknown> =>
            input.grammar.definition.id === 'swift'
              ? { unsupportedLanguageResolution: true }
              : {};
      for (const reference of references) {
        const sourceSymbol = enclosingSymbolForSpan(reference.node);
        const kind =
          reference.capture === 'reference.call' ? 'CALLS' : 'REFERENCES';
        edges.push({
          id: edgeRowId({
            repoId: input.repoId,
            kind,
            sourceId: sourceSymbol.id,
            target: `${reference.name}@${reference.node.startIndex}`,
            line: reference.line,
          }),
          repositoryId: input.repoId,
          kind,
          sourceSymbolId: sourceSymbol.id,
          targetSymbolId: null,
          sourceFileId: fileId,
          targetRef: reference.name,
          line: reference.line,
          confidenceTier: 'EXTRACTED',
          confidenceScore: 1.0,
          resolverId: null,
          evidence: {
            capture: reference.capture,
            offset: reference.node.startIndex,
            ...lexicalEvidence(
              reference.node,
              reference.name,
              reference.capture,
            ),
          },
        });
      }

      // Reuse this same parsed tree for any additional passes (e.g. import
      // extraction, rationale binding) before it is disposed by withTree's
      // finally block. `symbols` is fully built by this point (fileSymbol at
      // index 0 followed by every definition), so `symbols.slice(1)` is
      // exactly "every definition in this file" -- safe to hand out here
      // since callers only read fields, never mutate this array.
      input.onTree?.(tree, symbols.slice(1));

      return {
        file: {
          ...baseFile,
          parseStatus: 'parsed',
          hasErrors: tree.rootNode.hasError,
          lineCount: input.source.split('\n').length,
        },
        symbols,
        edges,
      };
    }),
  );
}
