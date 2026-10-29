import { toDiffFileStatus } from '../diff-status';

describe('toDiffFileStatus', () => {
  it('maps single-letter git codes', () => {
    expect(toDiffFileStatus('A')).toBe('added');
    expect(toDiffFileStatus('M')).toBe('modified');
    expect(toDiffFileStatus('D')).toBe('deleted');
    expect(toDiffFileStatus('R')).toBe('renamed');
    expect(toDiffFileStatus('C')).toBe('copied');
    expect(toDiffFileStatus('U')).toBe('unmerged');
    expect(toDiffFileStatus('T')).toBe('type-changed');
  });

  it('maps the untracked porcelain code', () => {
    expect(toDiffFileStatus('??')).toBe('untracked');
  });

  it('maps canonical word statuses', () => {
    expect(toDiffFileStatus('added')).toBe('added');
    expect(toDiffFileStatus('modified')).toBe('modified');
    expect(toDiffFileStatus('deleted')).toBe('deleted');
    expect(toDiffFileStatus('renamed')).toBe('renamed');
    expect(toDiffFileStatus('copied')).toBe('copied');
    expect(toDiffFileStatus('unmerged')).toBe('unmerged');
    expect(toDiffFileStatus('type-changed')).toBe('type-changed');
    expect(toDiffFileStatus('untracked')).toBe('untracked');
  });

  it('considers only the first significant character (e.g. rename score)', () => {
    expect(toDiffFileStatus('R100')).toBe('renamed');
    expect(toDiffFileStatus(' M')).toBe('modified');
  });

  it('falls back to unknown for unrecognised codes', () => {
    expect(toDiffFileStatus('X')).toBe('unknown');
    expect(toDiffFileStatus('unknown')).toBe('unknown');
    expect(toDiffFileStatus('')).toBe('unknown');
  });
});
