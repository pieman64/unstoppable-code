import * as nodePath from 'node:path';
import {
  AnnotationEntityPathSchema,
  AnnotationFileRefSchema,
  hasHostAbsolutePath,
} from '@canopy/protocol/canopy-core';
import { createAnnotationPathProjection } from '../paths';

const scope = { projectId: 'project', worktreeId: 'worktree' };
const roots = [
  { id: 'workspace-root', absolutePath: '/work/tree' },
  { id: 'repo-a', absolutePath: '/work/tree/repos/a' },
  { id: 'attachments', absolutePath: '/data/attachments' },
];

describe('annotation path projection', () => {
  const projection = createAnnotationPathProjection(scope, roots);

  it('projects a file to its most specific root and resolves it exactly', () => {
    const ref = projection.fileRef('/work/tree/repos/a/src/index.ts');
    expect(ref).toEqual({
      kind: 'root',
      rootId: 'repo-a',
      path: 'src/index.ts',
    });
    expect(projection.resolveFile(ref)).toBe('/work/tree/repos/a/src/index.ts');
    expect(projection.fileRef('/work/tree/README.md')).toEqual({
      kind: 'root',
      rootId: 'workspace-root',
      path: 'README.md',
    });
  });

  it('issues a host handle for files outside every root, without the path', () => {
    const outside = '/Users/someone/.config/notes.md';
    const ref = projection.fileRef(outside);
    expect(ref.kind).toBe('host');
    expect(AnnotationFileRefSchema.safeParse(ref).success).toBe(true);
    expect(hasHostAbsolutePath(ref)).toBe(false);
    expect(JSON.stringify(ref)).not.toContain('someone');
    expect(projection.resolveFile(ref)).toBe(outside);
    // Stable for the same scope and path.
    expect(projection.fileRef(outside)).toEqual(ref);
  });

  it('keeps inexact projections as handles so the original string returns', () => {
    for (const recorded of [
      '/work/tree/src/../src/a.ts',
      '/work/tree/src//a.ts',
      '/work/tree',
      '/work/tree/',
    ]) {
      const ref = projection.fileRef(recorded);
      expect(ref.kind).toBe('host');
      expect(projection.resolveFile(ref)).toBe(recorded);
    }
  });

  it('refuses references another scope issued or that escape a root', () => {
    const other = createAnnotationPathProjection(
      { projectId: 'other', worktreeId: 'worktree' },
      roots,
    );
    const ref = projection.fileRef('/elsewhere/file.ts');
    expect(() => other.resolveFile(ref)).toThrow(
      'The annotated file is not available in this scope.',
    );
    expect(() =>
      projection.resolveFile({ kind: 'root', rootId: 'missing', path: 'a.ts' }),
    ).toThrow('The annotated file is not available in this scope.');
    expect(() =>
      projection.resolveFile({
        kind: 'host',
        handle: 'h-00000000000000000000000000000000',
      }),
    ).toThrow('The annotated file is not available in this scope.');
    expect(
      AnnotationFileRefSchema.safeParse({
        kind: 'root',
        rootId: 'repo-a',
        path: '../escape.ts',
      }).success,
    ).toBe(false);
  });

  it('refuses a Windows root-relative path that would escape its root', () => {
    const windows = createAnnotationPathProjection(
      scope,
      [{ id: 'repo', absolutePath: 'C:\\work\\repo' }],
      nodePath.win32,
    );
    expect(windows.fileRef('C:\\work\\repo\\src\\a.ts')).toEqual({
      kind: 'root',
      rootId: 'repo',
      path: 'src/a.ts',
    });
    expect(
      windows.resolveFile({ kind: 'root', rootId: 'repo', path: 'src/a.ts' }),
    ).toBe('C:\\work\\repo\\src\\a.ts');
    expect(() =>
      windows.resolveFile({
        kind: 'root',
        rootId: 'repo',
        path: 'a\\..\\..\\x',
      }),
    ).toThrow('The annotated file is not available in this scope.');
  });

  it('keeps recorded text that is no host path and projects host paths', () => {
    expect(projection.entityPath('src/a.ts')).toBe('src/a.ts');
    expect(projection.entityPath('')).toBe('');
    const ref = projection.entityPath('/work/tree/src/a.ts');
    expect(ref).toEqual({
      kind: 'root',
      rootId: 'workspace-root',
      path: 'src/a.ts',
    });
    expect(projection.resolveEntityPath(ref)).toBe('/work/tree/src/a.ts');
    expect(AnnotationEntityPathSchema.safeParse('/abs/path').success).toBe(
      false,
    );
    expect(AnnotationEntityPathSchema.safeParse('file:///x').success).toBe(
      false,
    );
  });

  it('ignores unusable roots', () => {
    const odd = createAnnotationPathProjection(scope, [
      { id: '', absolutePath: '/work' },
      { id: 'relative', absolutePath: 'work' },
    ]);
    expect(odd.fileRef('/work/a.ts').kind).toBe('host');
  });
});
