import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';

it('keeps the complete detector dependency graph free of execution and source imports', () => {
  const root = resolve(__dirname, '..');
  const visited = new Set<string>();
  const allowed = new Set([
    'node:fs/promises',
    'node:path',
    'node:crypto',
    '@canopy/protocol/script-actions',
    'js-yaml',
    'jsonc-parser',
  ]);
  const inspect = (file: string): void => {
    if (visited.has(file)) return;
    visited.add(file);
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const walk = (node: ts.Node): void => {
      expect(
        ts.isCallExpression(node) &&
          node.expression.kind === ts.SyntaxKind.ImportKeyword,
      ).toBe(false);
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression))
        expect(['eval', 'Function', 'require']).not.toContain(
          node.expression.text,
        );
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression))
        expect(node.expression.text).not.toBe('Function');
      if (
        (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) ||
        (ts.isExportDeclaration(node) && !node.isTypeOnly)
      ) {
        const specifier = node.moduleSpecifier;
        if (specifier && ts.isStringLiteral(specifier)) {
          if (specifier.text.startsWith('./')) {
            const child = resolve(root, `${specifier.text}.ts`);
            expect(child.startsWith(`${root}/`)).toBe(true);
            inspect(child);
          } else expect(allowed).toContain(specifier.text);
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
  };
  for (const file of readdirSync(root).filter((name) => name.endsWith('.ts')))
    inspect(join(root, file));
});
