import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  computeContentHash,
  enumerateSourceFiles,
  planFileWork,
} from '../scan/scanner';

describe('code-graph scanner', () => {
  let root: string;
  let externalRoot: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'code-graph-scan-'));
    externalRoot = mkdtempSync(
      path.join(tmpdir(), 'code-graph-scan-external-'),
    );
    mkdirSync(path.join(root, 'src'), { recursive: true });
    mkdirSync(path.join(root, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(path.join(root, 'src', 'b.tsx'), 'export const b = 2;\n');
    writeFileSync(path.join(root, 'readme.md'), '# no\n');
    writeFileSync(path.join(root, 'package.json'), '{}\n');
    writeFileSync(path.join(root, 'tsconfig.json'), '{}\n');
    writeFileSync(path.join(root, '.mcp.json'), '{}\n');
    writeFileSync(
      path.join(root, 'node_modules', 'dep', 'ignored.ts'),
      'export const x = 1;\n',
    );
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(externalRoot, { recursive: true, force: true });
  });

  it('walks the filesystem when the root is not a git repo', async () => {
    const files = await enumerateSourceFiles(root);
    // Non-code shapes (markdown, package.json, tsconfig.json, .mcp.json) are
    // now routed through the non-code extractor pipeline alongside the
    // grammar-backed source files (Phase 3 corpus widening).
    expect(files.map((f) => f.relativePath)).toEqual([
      '.mcp.json',
      'package.json',
      'readme.md',
      'src/a.ts',
      'src/b.tsx',
      'tsconfig.json',
    ]);
    expect(files[0].sizeBytes).toBeGreaterThan(0);
    expect(files[0].mtimeNs).toMatch(/^\d+$/);
  });

  it('uses git enumeration (including untracked, excluding gitignored) when available', async () => {
    execFileSync('git', ['-C', root, 'init', '--quiet']);
    writeFileSync(path.join(root, '.gitignore'), 'src/b.tsx\n');
    const files = await enumerateSourceFiles(root);
    expect(files.map((f) => f.relativePath)).toEqual([
      '.mcp.json',
      'package.json',
      'readme.md',
      'src/a.ts',
      'tsconfig.json',
    ]);
  });

  it('rejects git-listed symlinks before accepting a source file', async () => {
    const outsidePath = path.join(externalRoot, 'outside.ts');
    writeFileSync(outsidePath, 'export const secret = 1;\n');
    try {
      symlinkSync(outsidePath, path.join(root, 'src', 'leak.ts'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        return;
      }
      throw error;
    }
    execFileSync('git', ['-C', root, 'init', '--quiet']);

    const files = await enumerateSourceFiles(root);

    expect(files.map((file) => file.relativePath)).not.toContain('src/leak.ts');
  });

  it('picks up all four non-code shapes (markdown, package.json, tsconfig, mcp-config)', async () => {
    const files = await enumerateSourceFiles(root);
    const relativePaths = files.map((f) => f.relativePath);
    expect(relativePaths).toEqual(
      expect.arrayContaining([
        'readme.md',
        'package.json',
        'tsconfig.json',
        '.mcp.json',
      ]),
    );
  });

  it('hashes content deterministically', () => {
    expect(computeContentHash('abc')).toBe(computeContentHash('abc'));
    expect(computeContentHash('abc')).not.toBe(computeContentHash('abd'));
    expect(computeContentHash('abc')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('plans work with the stat fastpath', () => {
    const scanned = [
      {
        relativePath: 'src/a.ts',
        absolutePath: '/r/src/a.ts',
        sizeBytes: 10,
        mtimeNs: '100',
      },
      {
        relativePath: 'src/new.ts',
        absolutePath: '/r/src/new.ts',
        sizeBytes: 5,
        mtimeNs: '200',
      },
      {
        relativePath: 'src/touched.ts',
        absolutePath: '/r/src/touched.ts',
        sizeBytes: 7,
        mtimeNs: '999',
      },
    ];
    const existing = [
      { relativePath: 'src/a.ts', sizeBytes: 10, mtimeNs: '100' },
      { relativePath: 'src/touched.ts', sizeBytes: 7, mtimeNs: '500' },
      { relativePath: 'src/deleted.ts', sizeBytes: 3, mtimeNs: '50' },
    ];
    const plan = planFileWork(scanned, existing, { forceFullReparse: false });
    expect(plan.unchanged).toBe(1);
    expect(plan.toParse.map((f) => f.relativePath).sort()).toEqual([
      'src/new.ts',
      'src/touched.ts',
    ]);
    expect(plan.toRemove).toEqual(['src/deleted.ts']);
    const forced = planFileWork(scanned, existing, { forceFullReparse: true });
    expect(forced.toParse).toHaveLength(3);
    expect(forced.unchanged).toBe(0);
  });
});
