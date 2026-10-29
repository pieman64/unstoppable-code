import { toPortalFile } from '../ChangedFilesSection';

describe('toPortalFile', () => {
  it('forwards line counts for a text file', () => {
    expect(
      toPortalFile({
        path: 'src/a.ts',
        status: 'modified',
        insertions: 2,
        deletions: 1,
      }),
    ).toMatchObject({ filePath: 'src/a.ts', insertions: 2, deletions: 1 });
  });

  it('forwards a binary file as binary, without line counts (REG-3024)', () => {
    const file = toPortalFile({
      path: 'logo.png',
      status: 'added',
      insertions: 0,
      deletions: 0,
      binary: true,
    });
    expect(file).toMatchObject({ filePath: 'logo.png', binary: true });
    expect(file.insertions).toBeUndefined();
    expect(file.deletions).toBeUndefined();
  });
});
