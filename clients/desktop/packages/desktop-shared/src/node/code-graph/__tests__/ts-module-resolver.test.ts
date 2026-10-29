import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  resolutionInputsChanged,
  TsModuleResolver,
} from '../resolve/ts-module-resolver';

describe('TsModuleResolver', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'code-graph-tsres-'));
    mkdirSync(path.join(root, 'src', 'lib'), { recursive: true });
    writeFileSync(
      path.join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          moduleResolution: 'bundler',
          paths: { '@lib/*': ['src/lib/*'] },
        },
      }),
    );
    writeFileSync(
      path.join(root, 'src', 'lib', 'util.ts'),
      'export const u = 1;\n',
    );
    writeFileSync(
      path.join(root, 'src', 'main.ts'),
      "import { u } from '@lib/util';\n",
    );
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves relative specifiers to absolute file paths', () => {
    const resolver = new TsModuleResolver(root);
    const resolved = resolver.resolveSpecifier(
      './lib/util',
      path.join(root, 'src', 'main.ts'),
    );
    expect(resolved).toBe(path.join(root, 'src', 'lib', 'util.ts'));
  });

  it('resolves tsconfig paths aliases via the compiler API', () => {
    const resolver = new TsModuleResolver(root);
    const resolved = resolver.resolveSpecifier(
      '@lib/util',
      path.join(root, 'src', 'main.ts'),
    );
    expect(resolved).toBe(path.join(root, 'src', 'lib', 'util.ts'));
  });

  it('returns null for external and unresolvable modules', () => {
    const resolver = new TsModuleResolver(root);
    expect(
      resolver.resolveSpecifier('node:fs', path.join(root, 'src', 'main.ts')),
    ).toBeNull();
    expect(
      resolver.resolveSpecifier(
        './nope/missing',
        path.join(root, 'src', 'main.ts'),
      ),
    ).toBeNull();
  });

  it('invalidates persisted existence probes when a package appears or disappears', async () => {
    const containingPath = path.join(root, 'src', 'main.ts');
    const missing = new TsModuleResolver(root);
    expect(
      missing.resolveSpecifierWithKind('installed-later', containingPath),
    ).toEqual({ kind: 'unresolved' });
    const missingInputs = JSON.stringify(missing.getInputFingerprints());
    expect(await resolutionInputsChanged(root, missingInputs)).toBe(false);

    const packageRoot = path.join(root, 'node_modules', 'installed-later');
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      path.join(packageRoot, 'package.json'),
      JSON.stringify({ name: 'installed-later', types: 'index.d.ts' }),
    );
    writeFileSync(
      path.join(packageRoot, 'index.d.ts'),
      'export declare function installed(): void;\n',
    );
    expect(await resolutionInputsChanged(root, missingInputs)).toBe(true);

    const installed = new TsModuleResolver(root);
    expect(
      installed.resolveSpecifierWithKind('installed-later', containingPath),
    ).toEqual({ kind: 'external' });
    const installedInputs = JSON.stringify(installed.getInputFingerprints());
    expect(await resolutionInputsChanged(root, installedInputs)).toBe(false);

    rmSync(packageRoot, { recursive: true, force: true });
    expect(await resolutionInputsChanged(root, installedInputs)).toBe(true);
  });
});
