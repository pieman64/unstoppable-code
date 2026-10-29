import ts from 'typescript';
import { resolve } from 'node:path';
import type {
  FileIndexingCustomGlob,
  FileIndexingPreferences,
} from '@canopy/protocol/file-indexing';
import type {
  FileIndexingPreferences as DesktopFileIndexingPreferences,
  FileIndexingCustomGlob as DesktopFileIndexingCustomGlob,
} from '../types';
import {
  buildFileGlobMatcher,
  buildFileExplorerGlobMatcher,
  normalizeFileIndexingPreferences,
  type FileGlobMatcher,
  type FileIndexingMatchPolicy,
} from '@canopy/core-runtime/node';
import { createFileIndexingMatchPolicy } from '@canopy/core-platform';
import {
  BUILTIN_INDEX_GLOBS,
  BUILTIN_INDEX_GLOB_IDS,
  getBuiltinIndexGlob,
} from '../file-indexing';

describe('file-indexing shared module', () => {
  it('exports a non-empty list of built-in globs', () => {
    expect(BUILTIN_INDEX_GLOBS.length).toBeGreaterThan(0);
  });

  it('uses unique kebab-case ids', () => {
    const ids = BUILTIN_INDEX_GLOBS.map((g) => g.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  });

  it('every built-in has a non-empty label and pattern', () => {
    for (const glob of BUILTIN_INDEX_GLOBS) {
      expect(glob.label.length).toBeGreaterThan(0);
      expect(glob.pattern.length).toBeGreaterThan(0);
      expect(glob.pattern.startsWith('**/')).toBe(true);
    }
  });

  it('includes the canonical Node modules glob', () => {
    const node = getBuiltinIndexGlob('node-modules');
    expect(node).toBeDefined();
    expect(node?.pattern).toBe('**/node_modules/**');
  });

  it('does NOT default-exclude generic build/dist directories', () => {
    // Per plan: users may legitimately want to find generated files. They
    // can opt-in via custom globs. Locking this expectation in so a future
    // editor of BUILTIN_INDEX_GLOBS does not silently regress.
    expect(getBuiltinIndexGlob('build')).toBeUndefined();
    expect(getBuiltinIndexGlob('dist')).toBeUndefined();
  });

  it('BUILTIN_INDEX_GLOB_IDS matches BUILTIN_INDEX_GLOBS', () => {
    expect(BUILTIN_INDEX_GLOB_IDS.size).toBe(BUILTIN_INDEX_GLOBS.length);
    for (const glob of BUILTIN_INDEX_GLOBS) {
      expect(BUILTIN_INDEX_GLOB_IDS.has(glob.id)).toBe(true);
    }
  });

  it('getBuiltinIndexGlob returns undefined for unknown ids', () => {
    expect(getBuiltinIndexGlob('definitely-not-a-real-id')).toBeUndefined();
  });
});

it('preserves the complete ordered catalog', () => {
  expect(
    BUILTIN_INDEX_GLOBS.map(({ id, label, pattern }) => [id, label, pattern]),
  ).toEqual([
    ['node-modules', 'Node dependencies', '**/node_modules/**'],
    ['bower-components', 'Bower components', '**/bower_components/**'],
    ['pnpm-store', 'pnpm store', '**/.pnpm-store/**'],
    ['yarn-cache', 'Yarn cache', '**/.yarn/cache/**'],
    ['yarn-unplugged', 'Yarn unplugged', '**/.yarn/unplugged/**'],
    ['python-venv', 'Python virtualenvs', '**/{.venv,venv,env}/**'],
    [
      'python-caches',
      'Python caches',
      '**/{__pycache__,.pytest_cache,.mypy_cache,.ruff_cache}/**',
    ],
    ['tox', 'tox envs', '**/.tox/**'],
    ['nox', 'nox envs', '**/.nox/**'],
    ['ruby-vendor-bundle', 'Ruby vendor/bundle', '**/vendor/bundle/**'],
    ['gradle', 'Gradle cache', '**/.gradle/**'],
    ['jvm-target', 'JVM target output', '**/target/**'],
  ]);
});

it('consumes the published portable APIs with compatible desktop preference types', () => {
  const custom: FileIndexingCustomGlob = {
    id: 'a',
    pattern: 'a/**',
    enabled: true,
  };
  const desktopCustom: DesktopFileIndexingCustomGlob = custom;
  const portable: FileIndexingPreferences = {
    disabledBuiltinGlobIds: [],
    customGlobs: [desktopCustom],
  };
  const desktop: DesktopFileIndexingPreferences = portable;
  const normalized: FileIndexingPreferences =
    normalizeFileIndexingPreferences(desktop);
  const policy: FileIndexingMatchPolicy =
    createFileIndexingMatchPolicy('linux');
  const index: FileGlobMatcher = buildFileGlobMatcher(normalized, policy);
  const explorer: FileGlobMatcher = buildFileExplorerGlobMatcher(policy);
  expect(index.isIndexExcluded('a/file', 'file')).toBe(true);
  expect(explorer.isIndexExcluded('a/file', 'file')).toBe(false);
});

it('typechecks public file-indexing exports without workspace path aliases', () => {
  // Jest uses isolatedModules, and workspace builds exclude this test file.
  const entry = resolve(__dirname, 'file-indexing-consumer.typecheck.ts');
  const source = `
    import { createDefaultFileIndexingPreferences,
      type BuiltinIndexGlob, type FileIndexingPreferences,
      type FileIndexingCustomGlob } from '@canopy/protocol/file-indexing';
    import { getBuiltinIndexGlob, type FileIndexingPreferences as CompatiblePreferences,
      type FileIndexingCustomGlob as CompatibleCustomGlob }
      from '@canopy/desktop-shared/file-indexing';
    import { normalizeFileIndexingPreferences, buildFileGlobMatcher,
      buildFileExplorerGlobMatcher, type FileGlobMatcher,
      type FileIndexingMatchPolicy } from '@canopy/core-runtime/node';
    import { createFileIndexingMatchPolicy } from '@canopy/core-platform';
    const custom: FileIndexingCustomGlob = { id: 'a', pattern: 'a/**', enabled: true };
    const compatibleCustom: CompatibleCustomGlob = custom;
    const portable: FileIndexingPreferences = createDefaultFileIndexingPreferences();
    const compatible: CompatiblePreferences = portable;
    compatible.customGlobs.push(compatibleCustom);
    const normalized: FileIndexingPreferences = normalizeFileIndexingPreferences(compatible);
    const policy: FileIndexingMatchPolicy = createFileIndexingMatchPolicy('linux');
    const index: FileGlobMatcher = buildFileGlobMatcher(normalized, policy);
    const explorer: FileGlobMatcher = buildFileExplorerGlobMatcher(policy);
    export const builtin: BuiltinIndexGlob | undefined = getBuiltinIndexGlob('node-modules');
    export const excluded: boolean = index.isIndexExcluded('a/x', 'file');
    export const deferred: boolean | undefined = explorer.isTraversalDeferred?.('node_modules');
    // @ts-expect-error Policy injection is required for the portable API.
    buildFileGlobMatcher(normalized);
    // @ts-expect-error Explorer policy injection is required too.
    buildFileExplorerGlobMatcher();
    // @ts-expect-error Only file and directory kinds are supported.
    index.isIndexExcluded('a/x', 'symlink');
    // @ts-expect-error Case policy cannot be changed through this contract.
    policy.caseSensitive = false;
    // @ts-expect-error Platform selection is restricted to supported OS values.
    createFileIndexingMatchPolicy('freebsd');
  `;
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    esModuleInterop: true,
    types: ['node'],
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (
    file,
    languageVersion,
    onError,
    shouldCreateNewSourceFile,
  ): ts.SourceFile | undefined =>
    file === entry
      ? ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true)
      : getSourceFile(
          file,
          languageVersion,
          onError,
          shouldCreateNewSourceFile,
        );
  const program = ts.createProgram([entry], options, host);
  expect(
    ts
      .getPreEmitDiagnostics(program)
      .map((diagnostic) =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
      ),
  ).toEqual([]);
});
