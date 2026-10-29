import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

/**
 * The bytecode main build (electron-vite `build.bytecode`) runs
 * `@babel/plugin-transform-arrow-functions` over the bundle. The plugin hoists
 * an arrow's captured `this` into a `var` at the top of the enclosing function
 * body, but a parameter default is evaluated in the parameter scope, before
 * and outside that body. An arrow in a parameter default that captures `this`
 * therefore compiles to an unbound `_this` and throws a ReferenceError when
 * the default is used. Source runs, Jest and dev builds never see it.
 */
const REPO_ROOT = resolve(__dirname, '../../../../../..');
/** Main-process sources and the workspace packages the main bundle inlines. */
const SCANNED_ROOTS = [
  'apps/desktop-app/src/main',
  ...readdirSync(join(REPO_ROOT, 'packages'))
    .map((name) => `packages/${name}/src`)
    .filter((root) => existsSync(join(REPO_ROOT, root))),
];

/**
 * Babel as electron-vite's bytecode plugin loads it. The hazard belongs to that
 * build step, and this repository has no direct Babel dependency of its own.
 */
const electronViteRequire = createRequire(
  require.resolve('electron-vite/package.json'),
);

interface BabelCore {
  transformSync(
    code: string,
    options: { babelrc: boolean; configFile: boolean; plugins: string[] },
  ): { code?: string | null } | null;
}

function isBabelCore(value: unknown): value is BabelCore {
  return (
    typeof value === 'object' &&
    value !== null &&
    'transformSync' in value &&
    typeof value.transformSync === 'function'
  );
}

function bytecodeArrowTransform(code: string): string {
  const babel: unknown = electronViteRequire('@babel/core');
  if (!isBabelCore(babel)) throw new Error('electron-vite has no @babel/core');
  const result = babel.transformSync(code, {
    babelrc: false,
    configFile: false,
    plugins: [
      electronViteRequire.resolve('@babel/plugin-transform-arrow-functions'),
    ],
  });
  if (!result?.code) throw new Error('Babel produced no output');
  return result.code;
}

function sourceFiles(root: string): string[] {
  return readdirSync(join(REPO_ROOT, root), {
    recursive: true,
    withFileTypes: true,
  })
    .filter(
      (entry) =>
        entry.isFile() &&
        /\.tsx?$/.test(entry.name) &&
        !entry.name.endsWith('.d.ts') &&
        !/\.(test|spec)\.tsx?$/.test(entry.name),
    )
    .map((entry) => join(entry.parentPath, entry.name))
    .filter(
      (path) =>
        !/[\\/](node_modules|__tests__|__mocks__|dist|out)[\\/]/.test(
          relative(REPO_ROOT, path),
        ),
    );
}

/** True when `node` uses the enclosing function's `this`, `super` or `arguments`. */
function capturesEnclosingFunctionEnvironment(node: ts.Node): boolean {
  let captured = false;
  const visit = (child: ts.Node): void => {
    if (captured) return;
    if (
      child.kind === ts.SyntaxKind.ThisKeyword ||
      child.kind === ts.SyntaxKind.SuperKeyword ||
      (ts.isIdentifier(child) && child.text === 'arguments')
    ) {
      captured = true;
      return;
    }
    // Ordinary functions and classes bind their own `this`; arrows do not.
    if (
      ts.isFunctionDeclaration(child) ||
      ts.isFunctionExpression(child) ||
      ts.isClassLike(child) ||
      ts.isMethodDeclaration(child) ||
      ts.isAccessor(child) ||
      ts.isConstructorDeclaration(child)
    ) {
      return;
    }
    ts.forEachChild(child, visit);
  };
  ts.forEachChild(node, visit);
  return captured;
}

function capturingArrowsInParameterDefaults(path: string): string[] {
  const text = readFileSync(path, 'utf8');
  if (!/\bthis\b|\bsuper\b|\barguments\b/.test(text)) return [];
  const source = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    false,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const findings: string[] = [];
  const scanDefault = (node: ts.Node): void => {
    if (ts.isArrowFunction(node)) {
      if (capturesEnclosingFunctionEnvironment(node)) {
        const { line } = source.getLineAndCharacterOfPosition(
          node.getStart(source),
        );
        findings.push(`${relative(REPO_ROOT, path)}:${line + 1}`);
      }
      return;
    }
    if (ts.isFunctionExpression(node) || ts.isClassLike(node)) return;
    ts.forEachChild(node, scanDefault);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isParameter(node) && node.initializer) {
      scanDefault(node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

describe('bytecode main build arrow transform', () => {
  it('leaves a this-capturing arrow in a parameter default unbound', () => {
    const compiled = bytecodeArrowTransform(`
      class Pages {
        visible(entry) { return entry !== 'hidden'; }
        collect(entries, isVisible = (entry) => this.visible(entry)) {
          return entries.filter((entry) => isVisible(entry));
        }
      }
      result = new Pages().collect(['shown', 'hidden']);
    `);
    // Pins the transform's hazard that the source scan below guards against.
    expect((): void => {
      runInNewContext(compiled, {});
    }).toThrow(/_this\d* is not defined/);
  });

  it('compiles a default resolved inside the function body', () => {
    const context: { result?: unknown } = {};
    runInNewContext(
      bytecodeArrowTransform(`
        class Pages {
          visible(entry) { return entry !== 'hidden'; }
          collect(entries, isVisible) {
            const predicate = isVisible ?? ((entry) => this.visible(entry));
            return entries.filter((entry) => predicate(entry));
          }
        }
        result = new Pages().collect(['shown', 'hidden']);
      `),
      context,
    );
    expect(context.result).toEqual(['shown']);
  });

  it('main-process sources have no this-capturing arrow in a parameter default', () => {
    const findings = SCANNED_ROOTS.flatMap(sourceFiles).flatMap(
      capturingArrowsInParameterDefaults,
    );
    // Resolve such a default inside the body instead, e.g.
    // `const predicate = isVisible ?? ((entry) => this.isVisibleEntry(entry));`.
    expect(findings).toEqual([]);
  });
});
