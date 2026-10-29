import {
  canonicalQualifiedName,
  canonicalRelativePath,
  communityFingerprint,
  communityRowId,
  edgeRowId,
  fileQualifiedName,
  fileRowId,
  repositoryRowId,
  symbolQualifiedName,
  symbolRowId,
} from '../ids';

describe('code-graph canonical ids', () => {
  it('canonicalizes relative paths (posix, NFC, no leading ./)', () => {
    expect(canonicalRelativePath('src\\lib\\a.ts')).toBe('src/lib/a.ts');
    expect(canonicalRelativePath('./src/a.ts')).toBe('src/a.ts');
    expect(canonicalRelativePath('src/café.ts')).toBe('src/café.ts');
  });

  it('builds qualified names in file::Parent.name form', () => {
    expect(fileQualifiedName('./src/a.ts')).toBe('src/a.ts');
    expect(symbolQualifiedName('src/a.ts', [], 'top')).toBe('src/a.ts::top');
    expect(symbolQualifiedName('src/a.ts', ['Cls'], 'method')).toBe(
      'src/a.ts::Cls.method',
    );
  });

  it('canonicalizes a qualified name by its path head only (split on FIRST ::)', () => {
    expect(canonicalQualifiedName('src\\lib.ts::doWork')).toBe(
      'src/lib.ts::doWork',
    );
    expect(canonicalQualifiedName('./src/lib.ts::doWork')).toBe(
      'src/lib.ts::doWork',
    );
    expect(canonicalQualifiedName('src/lib.ts::Cls.method')).toBe(
      'src/lib.ts::Cls.method',
    );
    // Bare path (no ::) is canonicalized whole.
    expect(canonicalQualifiedName('./src/lib.ts')).toBe('src/lib.ts');
  });

  it('produces deterministic, distinct, prefixed row ids', () => {
    const a = symbolRowId('repo-1', 'src/a.ts::top');
    expect(a).toBe(symbolRowId('repo-1', 'src/a.ts::top'));
    expect(a).toMatch(/^sym_[0-9a-f]{32}$/);
    expect(a).not.toBe(symbolRowId('repo-2', 'src/a.ts::top'));
    expect(repositoryRowId('repo-1')).toMatch(/^repo_[0-9a-f]{32}$/);
    expect(fileRowId('repo-1', './src/a.ts')).toBe(
      fileRowId('repo-1', 'src/a.ts'),
    );
  });

  it('includes line in edge identity so distinct call sites survive', () => {
    const base = {
      repoId: 'r',
      kind: 'CALLS',
      sourceId: 'sym_x',
      target: 'beta',
    };
    expect(edgeRowId({ ...base, line: 3 })).not.toBe(
      edgeRowId({ ...base, line: 9 }),
    );
    expect(edgeRowId({ ...base, line: 3 })).toBe(
      edgeRowId({ ...base, line: 3 }),
    );
  });

  it('community fingerprint/id is deterministic, order-independent per caller-sorted input, and member-set sensitive', () => {
    const fp = communityFingerprint(['sym_a', 'sym_b']);
    expect(fp).toBe(communityFingerprint(['sym_a', 'sym_b']));
    expect(fp).toMatch(/^[0-9a-f]{32}$/);
    // Not sorted internally -- a caller-provided different order hashes
    // differently, since this function trusts the caller to have sorted.
    expect(communityFingerprint(['sym_b', 'sym_a'])).not.toBe(fp);
    expect(communityFingerprint(['sym_a', 'sym_c'])).not.toBe(fp);

    expect(communityRowId(fp)).toBe(`com_${fp}`);
    expect(communityRowId(fp)).toMatch(/^com_[0-9a-f]{32}$/);
  });
});
