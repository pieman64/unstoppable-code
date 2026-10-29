import type { Node, Tree } from 'web-tree-sitter';
import type { CodeGraphEdgeRecord } from '../../../types/code-graph';
import { edgeRowId } from '../ids';
import type {
  CodeGraphParserRuntime,
  LoadedCodeGraphGrammar,
} from '../parser/runtime';

export interface ExtractedImport {
  source: string;
  line: number;
  isReExport: boolean;
  exportAll?: boolean;
  names: Array<{ imported: string; local: string }>;
  namespaceLocal: string | null;
  defaultLocal: string | null;
}

function sourceSpecifier(statement: Node): string | null {
  const sourceNode = statement.childForFieldName('source');
  if (sourceNode === null) {
    return null;
  }
  const fragment = sourceNode.descendantsOfType('string_fragment')[0];
  return fragment === undefined ? null : fragment.text;
}

function collectBindings(
  statement: Node,
): Pick<ExtractedImport, 'names' | 'namespaceLocal' | 'defaultLocal'> {
  const names: Array<{ imported: string; local: string }> = [];
  let namespaceLocal: string | null = null;
  let defaultLocal: string | null = null;
  for (const specifier of statement.descendantsOfType([
    'import_specifier',
    'export_specifier',
  ])) {
    const nameNode = specifier.childForFieldName('name');
    const aliasNode = specifier.childForFieldName('alias');
    if (nameNode !== null) {
      names.push({
        imported: nameNode.text,
        local: (aliasNode ?? nameNode).text,
      });
    }
  }
  const namespace = statement.descendantsOfType('namespace_import')[0];
  if (namespace !== undefined) {
    const identifier = namespace.descendantsOfType('identifier')[0];
    namespaceLocal = identifier === undefined ? null : identifier.text;
  }
  const clause = statement.descendantsOfType('import_clause')[0];
  if (clause !== undefined) {
    for (const child of clause.children) {
      if (child !== null && child.type === 'identifier') {
        defaultLocal = child.text;
        break;
      }
    }
  }
  return { names, namespaceLocal, defaultLocal };
}

export function extractImportsFromTree(tree: Tree): ExtractedImport[] {
  const results: ExtractedImport[] = [];
  for (const statement of tree.rootNode.descendantsOfType([
    'import_statement',
    'export_statement',
  ])) {
    const specifier = sourceSpecifier(statement);
    if (specifier === null) {
      continue; // export without source = local export, handled by tags extraction.
    }
    results.push({
      source: specifier,
      line: statement.startPosition.row + 1,
      isReExport: statement.type === 'export_statement',
      ...(statement.type === 'export_statement' &&
      statement.children.some((child) => child.type === '*') &&
      statement.descendantsOfType('namespace_export').length === 0
        ? { exportAll: true }
        : {}),
      ...collectBindings(statement),
    });
  }
  return results;
}

export function extractImports(
  runtime: CodeGraphParserRuntime,
  grammar: LoadedCodeGraphGrammar,
  source: string,
): ExtractedImport[] {
  return runtime.withParser(grammar, (parser) =>
    runtime.withTree(parser, source, (tree) =>
      tree === null ? [] : extractImportsFromTree(tree),
    ),
  );
}

export function importsToEdges(input: {
  repoId: string;
  relativePath: string;
  fileSymbolId: string;
  fileId: string;
  imports: readonly ExtractedImport[];
}): CodeGraphEdgeRecord[] {
  return input.imports.map((imported) => ({
    id: edgeRowId({
      repoId: input.repoId,
      kind: 'IMPORTS_FROM',
      sourceId: input.fileSymbolId,
      target: imported.source,
      line: imported.line,
    }),
    repositoryId: input.repoId,
    kind: 'IMPORTS_FROM',
    sourceSymbolId: input.fileSymbolId,
    targetSymbolId: null,
    sourceFileId: input.fileId,
    targetRef: imported.source,
    line: imported.line,
    confidenceTier: 'EXTRACTED',
    confidenceScore: 1.0,
    resolverId: null,
    evidence: {
      names: imported.names,
      defaultLocal: imported.defaultLocal,
      namespaceLocal: imported.namespaceLocal,
      isReExport: imported.isReExport,
      ...(imported.exportAll === true ? { exportAll: true } : {}),
    },
  }));
}
