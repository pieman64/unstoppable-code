import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const config = ts.createSourceFile(
  'electron.vite.config.ts',
  readFileSync(join(__dirname, '../../../electron.vite.config.ts'), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);

// Exercise the real build configuration without importing Vite plugins or
// preparing brand/native assets. Removing the define must fail this test even
// though updater unit tests supply their own bundled constant.
const factorySource = ['readEnvString', 'createDependencyVersionDefines']
  .map((name) => {
    const declaration = config.statements.find(
      (statement) =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === name,
    );
    if (!declaration)
      throw new Error(`Missing Vite configuration function: ${name}`);
    return declaration.getText(config);
  })
  .join('\n');
const compiledFactory = ts.transpileModule(factorySource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

describe.each(['development', 'production'])(
  'source build identity (%s)',
  (mode) => {
    it.each([
      [undefined, 'false'],
      ['', 'false'],
      ['false', 'false'],
      ['true', 'true'],
      [' true ', 'true'],
    ])('bundles CANOPY_SOURCE_BUILD=%s as boolean %s', (value, expected) => {
      const defines: unknown = runInNewContext(
        `${compiledFactory}\ncreateDependencyVersionDefines(mode)`,
        {
          mode,
          pkg: {},
          process: { env: { CANOPY_SOURCE_BUILD: value } },
          readCanopyCloudBaseUrlForBuild: (): string =>
            'https://app.unstoppable.ai',
        },
      );
      expect(defines).toMatchObject({ __CANOPY_SOURCE_BUILD__: expected });
    });
  },
);
