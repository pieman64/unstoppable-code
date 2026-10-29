import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  findFirstExistingPath,
  formatMissingNodeModuleFileError,
  getNodeModuleFileCandidates,
  loadRequiredNodeModule,
  loadRequiredNodeModuleExport,
} from '../packaged-module-loader';

describe('packaged-module-loader', () => {
  it('builds source and packaged node module file candidates', () => {
    const candidates = getNodeModuleFileCandidates({
      packageName: '@scope/pkg',
      packageRelativePath: ['dist', 'index.js'],
      cwd: '/repo',
      fromDir: '/repo/packages/shared/src',
      ancestorDepths: [3, 2],
      resourcesPath: '/Applications/Canopy.app/Contents/Resources',
    });

    expect(candidates).toEqual([
      path.join('/repo', 'node_modules', '@scope', 'pkg', 'dist', 'index.js'),
      path.join(
        '/repo',
        'packages',
        'node_modules',
        '@scope',
        'pkg',
        'dist',
        'index.js',
      ),
      path.join(
        '/Applications/Canopy.app/Contents/Resources',
        'app.asar',
        'node_modules',
        '@scope',
        'pkg',
        'dist',
        'index.js',
      ),
      path.join(
        '/Applications/Canopy.app/Contents/Resources',
        'app',
        'node_modules',
        '@scope',
        'pkg',
        'dist',
        'index.js',
      ),
    ]);
  });

  it('deduplicates candidate paths', () => {
    const candidates = getNodeModuleFileCandidates({
      packageName: 'pkg',
      packageRelativePath: 'dist/index.js',
      cwd: '/repo',
      fromDir: '/repo/packages/shared/src',
      ancestorDepths: [3],
      resourcesPath: undefined,
    });

    expect(candidates).toEqual([
      path.join('/repo', 'node_modules', 'pkg', 'dist', 'index.js'),
    ]);
  });

  it('finds the first existing path', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'module-loader-'));
    const first = path.join(tempDir, 'missing.js');
    const second = path.join(tempDir, 'module.js');

    try {
      fs.writeFileSync(second, '');

      expect(findFirstExistingPath([first, second])).toBe(second);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('formats checked path diagnostics', () => {
    expect(
      formatMissingNodeModuleFileError(
        '@scope/pkg',
        ['dist', 'index.js'],
        ['/one', '/two'],
      ),
    ).toBe('Unable to locate @scope/pkg/dist/index.js. Checked: /one, /two');
  });

  it('loads and validates a required module export', () => {
    const join = loadRequiredNodeModuleExport<typeof path.join>({
      moduleId: 'node:path',
      exportName: 'join',
      requireFrom: __filename,
      validate: (value): value is typeof path.join =>
        typeof value === 'function',
    });

    expect(join('a', 'b')).toBe(path.join('a', 'b'));
  });

  it('throws when a required module export is missing without a validator', () => {
    expect(() =>
      loadRequiredNodeModuleExport({
        moduleId: 'node:path',
        exportName: 'notARealExport',
        requireFrom: __filename,
      }),
    ).toThrow('node:path did not export notARealExport');
  });

  it('loads and validates a required module', () => {
    const pathModule = loadRequiredNodeModule<typeof path>({
      moduleId: 'node:path',
      requireFrom: __filename,
      validate: (value): value is typeof path =>
        typeof value === 'object' &&
        value !== null &&
        'join' in value &&
        typeof value.join === 'function',
    });

    expect(pathModule.join('a', 'b')).toBe(path.join('a', 'b'));
  });
});
