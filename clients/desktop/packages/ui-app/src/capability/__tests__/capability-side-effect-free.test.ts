// eslint-disable-next-line no-restricted-imports
import { readdirSync, readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import path from 'node:path';
import ts from 'typescript';

/**
 * `@canopy/ui-app` declares every source folder except `capability/` as
 * having side effects. That lets bundlers drop the Marketplace capability
 * modules a route never uses even though the package barrels re-export them,
 * which keeps the web chat routes inside their first-load budget. It is only
 * correct while capability modules do nothing at import time, so this pins
 * both halves: the declaration and the absence of import-time statements.
 */
const PACKAGE_ROOT = path.join(__dirname, '..', '..', '..');
const SOURCE_ROOT = path.join(PACKAGE_ROOT, 'src');
const CAPABILITY_ROOT = path.join(SOURCE_ROOT, 'capability');

function readSideEffects(): unknown {
  const manifest: unknown = JSON.parse(
    readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'),
  );
  return typeof manifest === 'object' && manifest !== null
    ? Reflect.get(manifest, 'sideEffects')
    : undefined;
}

function capabilityModules(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '__tests__' ? [] : capabilityModules(full);
    }
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
      ? [full]
      : [];
  });
}

function importTimeStatements(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  return source.statements.flatMap((statement) => {
    if (ts.isImportDeclaration(statement) && !statement.importClause) {
      return [`bare import ${statement.moduleSpecifier.getText()}`];
    }
    if (ts.isExpressionStatement(statement)) {
      const text = statement.getText();
      return /^['"]use (client|strict)['"]/.test(text) ? [] : [text];
    }
    return [];
  });
}

describe('capability modules stay side-effect free', () => {
  it('declares side effects for every source folder except capability', () => {
    const folders = readdirSync(SOURCE_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== 'capability')
      .map((entry) => `./src/${entry.name}/**`)
      .sort();
    expect(readSideEffects()).toEqual([
      '**/*.css',
      './src/*.ts',
      './src/*.tsx',
      ...folders,
    ]);
  });

  it('runs nothing at import time', () => {
    const offending = capabilityModules(CAPABILITY_ROOT).flatMap((file) =>
      importTimeStatements(file).map(
        (statement) => `${path.relative(CAPABILITY_ROOT, file)}: ${statement}`,
      ),
    );
    expect(offending).toEqual([]);
  });
});
