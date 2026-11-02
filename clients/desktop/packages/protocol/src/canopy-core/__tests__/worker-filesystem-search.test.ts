import {
  WORKER_FILESYSTEM_SEARCH_MAX_PATH_LENGTH,
  WORKER_FILESYSTEM_SEARCH_MAX_RESULT_BYTES,
  WorkerFilesystemSearchResultSchema,
} from '../index';

const ENVELOPE_ALLOWANCE_BYTES = 4 * 1024;

function match(path: string, name: string): Record<string, unknown> {
  return {
    fileRootId: 'r'.repeat(512),
    path,
    kind: 'file',
    name,
    isIgnored: false,
  };
}

describe('worker.filesystem.search match bounds', () => {
  it('accepts a path and name at the Windows extended path limit', () => {
    // Windows long paths exceed the 4,096 and 1,024 bounds of earlier drafts.
    const longest = 'a'.repeat(WORKER_FILESYSTEM_SEARCH_MAX_PATH_LENGTH);
    expect(WORKER_FILESYSTEM_SEARCH_MAX_PATH_LENGTH).toBe(32_767);
    expect(
      WorkerFilesystemSearchResultSchema.safeParse({
        matches: [match(longest, longest)],
        nextCursor: null,
        truncated: false,
      }).success,
    ).toBe(true);
    expect(
      WorkerFilesystemSearchResultSchema.safeParse({
        matches: [match(`${longest}a`, 'a')],
        nextCursor: null,
        truncated: false,
      }).success,
    ).toBe(false);
  });

  it('keeps the largest encodable match inside one framed page', () => {
    // Every unit a six-byte `\u0001` escape: the worst case for JSON size.
    const longest = '\u0001'.repeat(WORKER_FILESYSTEM_SEARCH_MAX_PATH_LENGTH);
    const page = {
      matches: [match(longest, longest)],
      nextCursor: `fs1.${'c'.repeat(2044)}`,
      truncated: true,
      catalogRevision: 'v'.repeat(128),
    };
    expect(WorkerFilesystemSearchResultSchema.safeParse(page).success).toBe(
      true,
    );
    expect(
      Buffer.byteLength(JSON.stringify(page.matches[0]), 'utf8'),
    ).toBeLessThan(
      WORKER_FILESYSTEM_SEARCH_MAX_RESULT_BYTES - ENVELOPE_ALLOWANCE_BYTES,
    );
  });
});
