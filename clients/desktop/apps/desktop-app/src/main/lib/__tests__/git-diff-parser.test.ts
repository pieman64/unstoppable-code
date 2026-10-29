import { parseDiffOutput } from '../git-diff-parser';

describe('parseDiffOutput', () => {
  it('keeps text line counts', () => {
    const files = parseDiffOutput('M\tsrc/app.ts', '3\t1\tsrc/app.ts');
    expect(files.get('src/app.ts')).toEqual({
      path: 'src/app.ts',
      status: 'modified',
      insertions: 3,
      deletions: 1,
    });
  });

  it('marks a file numstat reports as binary (REG-3024)', () => {
    const files = parseDiffOutput('A\tlogo.png', '-\t-\tlogo.png');
    expect(files.get('logo.png')).toEqual({
      path: 'logo.png',
      status: 'added',
      insertions: 0,
      deletions: 0,
      binary: true,
    });
  });
});
