// Regression guard for Electron main's Linear boundary. Main used to load all
// of `@linear/sdk` (one 2.4 MB bundle, about 7.8 MB resident) at startup for
// five operations. `linear-api.ts` now owns every Linear request main makes,
// with fixed GraphQL documents and data only in variables. This test keeps
// the SDK out of main and keeps every document a constant in the helper.
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

const mockLoadedModuleIds: string[] = [];

jest.mock('@linear/sdk', () => {
  mockLoadedModuleIds.push('@linear/sdk');
  return {};
});

const MAIN_ROOT = path.resolve(__dirname, '../..');
const HELPER_PATH = path.join(MAIN_ROOT, 'lib', 'linear-api.ts');
const SDK_IMPORT_PATTERN =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]@linear\/sdk(?:\/[^'"]*)?['"]/m;
const LINEAR_ENDPOINT_PATTERN = /api\.linear\.app/;
const GRAPHQL_OPERATION_PATTERN = /\b(?:query|mutation)\s+([A-Za-z_]\w*)\b/;
const HELPER_OPERATIONS = [
  'issue_attachments',
  'referencePreviewIssue',
  'referencePreviewTeams',
  'searchIssues',
  'viewer',
];
const LINEAR_DOCUMENT_PATTERN = new RegExp(
  `\\b(?:query|mutation)\\s+(?:${HELPER_OPERATIONS.join('|')})\\b`,
);

function listMainSources(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      files.push(...listMainSources(fullPath));
    } else if (
      /\.(?:c|m)?tsx?$/.test(entry.name) &&
      !/\.(?:test|spec)\.(?:c|m)?tsx?$/.test(entry.name)
    ) {
      files.push(fullPath);
    }
  }
  return files;
}

function relativeToMain(filePath: string): string {
  return path.relative(MAIN_ROOT, filePath);
}

interface DocumentScan {
  readonly documents: string[];
  readonly violations: string[];
}

/**
 * Finds the helper's GraphQL documents and every way the source could alter
 * one. A document must be a top-level `const` string with no substitutions,
 * and each reference to it must be the value of a `query:` property, so the
 * text sent is always the constant itself.
 */
function scanDocuments(source: string): DocumentScan {
  const file = ts.createSourceFile(
    'scan.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const documentNames = new Set<string>();
  const documentLiterals = new Set<ts.Node>();
  const documents: string[] = [];
  const violations: string[] = [];
  const isDocumentText = (text: string): boolean =>
    GRAPHQL_OPERATION_PATTERN.test(text);

  for (const statement of file.statements) {
    if (
      !ts.isVariableStatement(statement) ||
      (statement.declarationList.flags & ts.NodeFlags.Const) === 0
    ) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      const initializer = declaration.initializer;
      if (
        ts.isIdentifier(declaration.name) &&
        initializer &&
        (ts.isNoSubstitutionTemplateLiteral(initializer) ||
          ts.isStringLiteral(initializer)) &&
        isDocumentText(initializer.text)
      ) {
        documentNames.add(declaration.name.text);
        documentLiterals.add(initializer);
        documents.push(initializer.text);
      }
    }
  }

  const visit = (node: ts.Node): void => {
    if (
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateExpression(node)) &&
      !documentLiterals.has(node) &&
      isDocumentText(node.getText())
    ) {
      violations.push(`inline document: ${node.getText().slice(0, 60)}`);
    }
    if (
      ts.isIdentifier(node) &&
      documentNames.has(node.text) &&
      !(ts.isVariableDeclaration(node.parent) && node.parent.name === node)
    ) {
      const parent = node.parent;
      const sentAsQuery =
        ts.isPropertyAssignment(parent) &&
        parent.initializer === node &&
        ts.isIdentifier(parent.name) &&
        parent.name.text === 'query';
      if (!sentAsQuery) {
        violations.push(`${node.text} used in ${ts.SyntaxKind[parent.kind]}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);

  return { documents, violations };
}

describe('Electron main Linear boundary', () => {
  const sources = listMainSources(MAIN_ROOT);

  it('finds main-process sources to scan', () => {
    expect(sources.length).toBeGreaterThan(100);
    expect(sources).toContain(HELPER_PATH);
  });

  it('never imports @linear/sdk from main', () => {
    const importers = sources
      .filter((filePath) =>
        SDK_IMPORT_PATTERN.test(readFileSync(filePath, 'utf8')),
      )
      .map(relativeToMain);
    expect(importers).toEqual([]);
  });

  it('keeps the Linear endpoint and GraphQL documents in the helper only', () => {
    const offenders = sources
      .filter((filePath) => filePath !== HELPER_PATH)
      .filter((filePath) => {
        const source = readFileSync(filePath, 'utf8');
        return (
          LINEAR_ENDPOINT_PATTERN.test(source) ||
          LINEAR_DOCUMENT_PATTERN.test(source)
        );
      })
      .map(relativeToMain);
    expect(offenders).toEqual([]);
  });

  it('defines every document as a top-level constant sent unchanged', () => {
    const scan = scanDocuments(readFileSync(HELPER_PATH, 'utf8'));
    expect(scan.violations).toEqual([]);

    const operations: string[] = [];
    for (const document of scan.documents) {
      const pattern = new RegExp(GRAPHQL_OPERATION_PATTERN.source, 'g');
      for (
        let match = pattern.exec(document);
        match;
        match = pattern.exec(document)
      ) {
        operations.push(match[1]);
      }
    }
    expect(operations.sort()).toEqual(HELPER_OPERATIONS);
  });

  it('rejects documents that are altered, aliased or built inline', () => {
    const declaration =
      'const VIEWER_QUERY = `query viewer { viewer { name } }`;';
    const altered = [
      'send({ query: VIEWER_QUERY + suffix });',
      'send({ query: `${VIEWER_QUERY}` });',
      "send({ query: VIEWER_QUERY.replace('viewer', name) });",
      'const alias = VIEWER_QUERY;',
      'send({ query: flag ? VIEWER_QUERY : other });',
      'send({ VIEWER_QUERY });',
      'send({ query: `query viewer { ${field} }` });',
      "send({ query: 'query viewer { viewer { id } }' });",
    ];
    for (const usage of altered) {
      expect(scanDocuments(`${declaration}\n${usage}`).violations).not.toEqual(
        [],
      );
    }
    expect(
      scanDocuments(`${declaration}\nsend({ query: VIEWER_QUERY });`)
        .violations,
    ).toEqual([]);
  });

  it('loads neither the helper nor the preview reader through @linear/sdk', () => {
    jest.isolateModules(() => {
      jest.requireActual('../linear-api');
      jest.requireActual('../linear-reference-preview');
    });
    expect(mockLoadedModuleIds).toEqual([]);
  });
});
