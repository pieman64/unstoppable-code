import { encodeCursorProjectDir } from '../project-dir';

describe('encodeCursorProjectDir', () => {
  it('replaces every non-alphanumeric run with one dash and trims the ends', () => {
    expect(encodeCursorProjectDir('/Users/dev/My Project/repo')).toBe(
      'Users-dev-My-Project-repo',
    );
    expect(encodeCursorProjectDir('/tmp//a__b.c/')).toBe('tmp-a-b-c');
  });

  it('collapses paths that differ only in separators to the same directory', () => {
    expect(encodeCursorProjectDir('/a/b')).toBe(encodeCursorProjectDir('/a-b'));
  });

  it('keeps non-ASCII segments out of the encoded name', () => {
    expect(encodeCursorProjectDir('/Users/dev/日本/repo')).toBe(
      'Users-dev-repo',
    );
  });
});
