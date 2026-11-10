import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import ts from 'typescript';

const root = resolve(__dirname, '../../../../../..');
const fallback = 'apps/desktop-app/src/main/lib/w5-fallback-read.ts';
const fileStore = 'packages/core-runtime/src/node/w5/file-store.ts';
const read = (file: string): string => readFileSync(join(root, file), 'utf8');
const parse = (file: string): ts.SourceFile =>
  ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);

function valueImports(file: string): ts.ImportDeclaration[] {
  return parse(file).statements.filter(
    (node): node is ts.ImportDeclaration =>
      ts.isImportDeclaration(node) &&
      !node.importClause?.isTypeOnly &&
      (!node.importClause?.namedBindings ||
        !ts.isNamedImports(node.importClause.namedBindings) ||
        node.importClause.namedBindings.elements.some(
          (entry) => !entry.isTypeOnly,
        )),
  );
}

it('keeps the fallback value-import closure free of W5 writers and transports', () => {
  const visited = new Set<string>();
  function visit(file: string): void {
    if (visited.has(file)) return;
    visited.add(file);
    expect(file).not.toMatch(
      /atomic-file|storage-admission|w5-commit-scope|commit-log-file-store|record-port\/|commit-log\/|w5-commit-log\/|workspace-persistence|sidebar-items|workspace-registry/,
    );
    for (const declaration of valueImports(file)) {
      if (!ts.isStringLiteral(declaration.moduleSpecifier))
        throw new Error('Nonliteral import');
      const specifier = declaration.moduleSpecifier.text;
      const target = specifier.startsWith('.')
        ? posix.join(posix.dirname(file), specifier) + '.ts'
        : specifier.startsWith('@canopy/core-runtime/')
          ? specifier.replace(
              '@canopy/core-runtime/',
              'packages/core-runtime/src/',
            ) + '.ts'
          : undefined;
      if (target === fileStore) {
        const bindings = declaration.importClause?.namedBindings;
        if (!bindings || !ts.isNamedImports(bindings))
          throw new Error('Only named read imports are allowed');
        expect(
          bindings.elements
            .filter((entry) => !entry.isTypeOnly)
            .map((entry) => (entry.propertyName ?? entry.name).text),
        ).toEqual(['readNodeW5File']);
      } else if (target) visit(target);
      else expect(specifier).toBe('node:async_hooks');
    }
    const source = parse(file);
    function scan(node: ts.Node): void {
      if (ts.isIdentifier(node))
        expect(node.text).not.toBe('createNodeW5FileStore');
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        expect(callee.kind).not.toBe(ts.SyntaxKind.ImportKeyword);
        const name = ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : ts.isElementAccessExpression(callee) &&
              ts.isStringLiteral(callee.argumentExpression)
            ? callee.argumentExpression.text
            : ts.isIdentifier(callee)
              ? callee.text
              : '';
        expect(name).not.toMatch(
          /^(?:require|eval|withW5Commit|runW5Commit|replace|commit|reserve|release|register.*|writeFile.*|appendFile.*|mkdir.*|unlink.*|rename.*|rm|rmSync|rmdir.*|truncate.*|copyFile.*|createWriteStream|chmod.*|chown.*|symlink.*|link.*|open.*)$/,
        );
      }
      ts.forEachChild(node, scan);
    }
    scan(source);
  }
  visit(fallback);
  expect(visited.size).toBeGreaterThan(0);
});

function sources(directory: string): string[] {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap(
    (entry) => {
      const child = posix.join(directory, entry.name);
      return entry.isDirectory()
        ? ['__tests__', '__mocks__', 'node_modules'].includes(entry.name)
          ? []
          : sources(child)
        : /\.tsx?$/.test(child) && !/\.(?:test|spec)\.tsx?$/.test(child)
          ? [child]
          : [];
    },
  );
}

it('allows projection-only permission only at the Electron presentation boundary', () => {
  const production = [
    ...sources('apps/desktop-app/src'),
    ...sources('packages'),
  ];
  const consumers = production.filter(
    (file) =>
      file !== fallback &&
      /\b(?:W5_PROJECTION_ONLY_READ|withW5ProjectionOnlyRead|W5ProjectionOnlyRead)\b/.test(
        read(file),
      ),
  );
  expect(consumers.sort()).toEqual([
    'apps/desktop-app/src/main/ipc/projects.ts',
  ]);
  expect(
    production.filter(
      (file) => file !== fallback && /\brunW5FallbackRead\b/.test(read(file)),
    ),
  ).toEqual(['apps/desktop-app/src/main/lib/w5-commit-log-file-store.ts']);
  expect(read(fallback)).toContain(
    "const projectionBrand = Symbol('W5ProjectionOnlyRead')",
  );
});

it('routes only typed-unreachable opt-ins to the fallback runner and keeps writes fenced', () => {
  const store = read(
    'apps/desktop-app/src/main/lib/w5-commit-log-file-store.ts',
  );
  expect(store).toMatch(
    /error instanceof W5AuthorityUnreachableError[\s\S]*?if \(allowsW5ProjectionOnlyRead\(\)\) return runW5FallbackRead\(work\)/,
  );
  const view = read('apps/desktop-app/src/main/lib/w5-read-view.ts');
  expect(view).toMatch(/currentView\(\) \|\| isW5ProjectionOnlyView\(\)/);
  expect(view).toContain('if (isW5ProjectionOnlyView()) return true;');
  expect(existsSync(join(root, fileStore))).toBe(true);
});
