/** @jest-environment jsdom */
import {
  dataTransferHasFiles,
  formatFilePathsForTerminalPaste,
  resolveDroppedFilePaths,
} from '../terminal-file-drop';

describe('terminal file drop helpers', () => {
  it('detects file data transfers', () => {
    expect(dataTransferHasFiles({ types: ['Files'] })).toBe(true);
    expect(dataTransferHasFiles({ types: ['text/plain'] })).toBe(false);
  });

  it('resolves dropped files to paths through the host', async () => {
    const files = [
      new File([], 'file.ts'),
      new File([], 'blob-without-path.png'),
      new File([], 'notes.md'),
    ];
    const paths = new Map<File, string>([
      [files[0], '/Users/tirish/project/file.ts'],
      [files[1], ''],
      [files[2], '/Users/tirish/project/notes.md'],
    ]);
    const dataTransfer = { files };

    await expect(
      resolveDroppedFilePaths(dataTransfer, (dropped) =>
        Promise.resolve(dropped.map((file) => paths.get(file) ?? '')),
      ),
    ).resolves.toEqual([
      '/Users/tirish/project/file.ts',
      '/Users/tirish/project/notes.md',
    ]);
  });

  it('asks the host nothing when no files were dropped', async () => {
    const getPathsForFiles = jest.fn(() => Promise.resolve(['/never']));
    await expect(
      resolveDroppedFilePaths({ files: [] }, getPathsForFiles),
    ).resolves.toEqual([]);
    expect(getPathsForFiles).not.toHaveBeenCalled();
  });

  it('formats POSIX paths as terminal paste text', () => {
    expect(
      formatFilePathsForTerminalPaste([
        '/tmp/simple.txt',
        '/tmp/with space.txt',
        "/tmp/quote's.md",
      ]),
    ).toBe("/tmp/simple.txt /tmp/with\\ space.txt /tmp/quote\\'s.md ");
  });

  it('quotes Windows paths only when needed', () => {
    expect(
      formatFilePathsForTerminalPaste([
        'C:\\Users\\tirish\\simple.txt',
        'C:\\Users\\tirish\\with space.txt',
      ]),
    ).toBe(
      'C:\\Users\\tirish\\simple.txt "C:\\Users\\tirish\\with space.txt" ',
    );
  });
});
