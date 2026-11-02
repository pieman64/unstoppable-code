import type {
  PortalChangedFile,
  PortalChangedFilesGroup,
  PortalChangedFilesPayload,
} from '@canopy/protocol/portal';
import {
  capChangedFilesPayload,
  decodeChangedFilesCursor,
  encodeChangedFilesCursor,
  getChangedFilesRevision,
  pageChangedFiles,
  sortChangedFiles,
} from '../changed-files-paging';

function file(
  filePath: string,
  status = 'modified',
  repoId?: string,
): PortalChangedFile {
  return {
    filePath,
    status,
    ...(repoId ? { repoId } : {}),
  };
}

function payload(
  uncommitted: PortalChangedFile[],
  committed: PortalChangedFile[] = [],
): PortalChangedFilesPayload {
  return {
    workspaceLocalId: 'workspace-1',
    worktreeLocalId: 'worktree-1',
    uncommitted,
    committed,
  };
}

function successFiles(
  result: ReturnType<typeof pageChangedFiles>,
): PortalChangedFile[] {
  if ('error' in result.changedFilesPage) {
    throw new Error(`Unexpected page error: ${result.changedFilesPage.error}`);
  }
  return result.changedFilesPage.files;
}

describe('Portal changed-files paging', () => {
  it('sorts by repo id and file path using code-point order', () => {
    expect(
      sortChangedFiles([
        file('z.ts', 'modified', 'repo-b'),
        file('é.ts', 'modified', 'repo-a'),
        file('a.ts', 'modified', 'repo-b'),
        file('Z.ts', 'modified', 'repo-a'),
      ]),
    ).toEqual([
      file('Z.ts', 'modified', 'repo-a'),
      file('é.ts', 'modified', 'repo-a'),
      file('a.ts', 'modified', 'repo-b'),
      file('z.ts', 'modified', 'repo-b'),
    ]);
    expect(sortChangedFiles([file('\u{10000}'), file('\uE000')])).toEqual([
      file('\uE000'),
      file('\u{10000}'),
    ]);
  });

  it('revises both sorted group identities, including status and repo ties', () => {
    const first = payload(
      [
        file('same.ts', 'added', 'repo-a'),
        file('same.ts', 'modified', 'repo-b'),
      ],
      [file('same.ts', 'deleted', 'repo-a')],
    );
    const reordered = payload(
      [
        file('same.ts', 'modified', 'repo-b'),
        file('same.ts', 'added', 'repo-a'),
      ],
      [file('same.ts', 'deleted', 'repo-a')],
    );

    expect(getChangedFilesRevision(first)).toBe(
      getChangedFilesRevision(reordered),
    );
    expect(getChangedFilesRevision(first)).not.toBe(
      getChangedFilesRevision(
        payload([file('same.ts', 'modified', 'repo-a')], first.committed),
      ),
    );
    expect(getChangedFilesRevision(first)).toMatch(/^[a-f0-9]{16}$/);
  });

  it('encodes and strictly validates versioned base64url cursors', () => {
    const cursor = encodeChangedFilesCursor({
      revision: 'revision-1',
      group: 'committed',
      offset: 9,
    });

    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(
      decodeChangedFilesCursor(cursor, 'committed', 'revision-1', 10),
    ).toEqual({
      ok: true,
      revision: 'revision-1',
      group: 'committed',
      offset: 9,
    });
    expect(
      decodeChangedFilesCursor('not-json', 'committed', 'revision-1', 10),
    ).toEqual({
      ok: false,
      error: 'invalid_cursor',
    });
    expect(
      decodeChangedFilesCursor(cursor, 'uncommitted', 'revision-1', 10),
    ).toEqual({
      ok: false,
      error: 'invalid_cursor',
    });
    expect(
      decodeChangedFilesCursor(cursor, 'committed', 'revision-2', 10),
    ).toEqual({
      ok: false,
      error: 'stale_cursor',
    });
    expect(
      decodeChangedFilesCursor(
        Buffer.from(
          '{"v":1,"revision":"revision-1","group":"committed","offset":-1}',
        ).toString('base64url'),
        'committed',
        'revision-1',
        10,
      ),
    ).toEqual({ ok: false, error: 'invalid_cursor' });
  });

  it('keeps the unchanged payload identity when the fast path fits', () => {
    const original = payload([file('a.ts')], [file('b.ts')]);
    const result = capChangedFilesPayload(original, () => 1, 1);

    expect(result).toBe(original);
    expect(result).not.toHaveProperty('notices');
    expect(result).not.toHaveProperty('page');
  });

  it('keeps an exact byte boundary and includes both groups fairly', () => {
    const longFile = (name: string): PortalChangedFile =>
      file(`${name}${'x'.repeat(256)}`);
    const original = payload(
      [longFile('a'), longFile('b')],
      [longFile('c'), longFile('d')],
    );
    const revision = getChangedFilesRevision(original);
    const fairPrefix: PortalChangedFilesPayload = {
      ...original,
      uncommitted: [longFile('a')],
      committed: [longFile('c')],
      notices: [{ kind: 'truncated' }],
      page: {
        revision,
        uncommitted: {
          total: 2,
          nextCursor: encodeChangedFilesCursor({
            revision,
            group: 'uncommitted',
            offset: 1,
          }),
        },
        committed: {
          total: 2,
          nextCursor: encodeChangedFilesCursor({
            revision,
            group: 'committed',
            offset: 1,
          }),
        },
      },
    };
    const exactBoundary = Buffer.byteLength(JSON.stringify(fairPrefix), 'utf8');

    const capped = capChangedFilesPayload(
      original,
      (candidate) => Buffer.byteLength(JSON.stringify(candidate), 'utf8'),
      exactBoundary,
    );

    expect(capped.uncommitted).toEqual([longFile('a')]);
    expect(capped.committed).toEqual([longFile('c')]);
    expect(Buffer.byteLength(JSON.stringify(capped), 'utf8')).toBe(
      exactBoundary,
    );
    expect(capped.notices).toEqual([{ kind: 'truncated' }]);
    expect(capped.page?.uncommitted.total).toBe(2);
    expect(capped.page?.committed.total).toBe(2);
    expect(capped.page?.uncommitted.nextCursor).toBeDefined();
    expect(capped.page?.committed.nextCursor).toBeDefined();
  });

  it('stops at an oversized first entry and retains Unicode and repo identity', () => {
    const unicode = file('🚀/é.ts', 'modified', 'repo-🚀');
    const tied = file('same.ts', 'modified', 'repo-b');
    const capped = capChangedFilesPayload(
      payload([unicode, tied]),
      (candidate) => Buffer.byteLength(JSON.stringify(candidate), 'utf8'),
      64,
    );

    expect(capped.uncommitted).toEqual([]);
    expect(capped.notices).toEqual([{ kind: 'truncated' }]);
    expect(capped.page?.uncommitted.nextCursor).toBeDefined();
    expect(
      Buffer.byteLength(JSON.stringify(payload([unicode, tied])), 'utf8'),
    ).toBeGreaterThan(JSON.stringify(payload([unicode, tied])).length);
  });

  it('allocates prefixes round-robin and respects tied paths in two repos', () => {
    const original = payload(
      [
        file('same.ts', 'added', 'repo-a'),
        file('same.ts', 'modified', 'repo-b'),
      ],
      [
        file('same.ts', 'deleted', 'repo-a'),
        file('same.ts', 'modified', 'repo-c'),
      ],
    );
    const capped = capChangedFilesPayload(
      original,
      (candidate) => {
        if (!candidate.notices) return Number.MAX_SAFE_INTEGER;
        return candidate.uncommitted.length <= 1 &&
          candidate.committed.length <= 1
          ? 0
          : 2;
      },
      1,
    );

    expect(capped.uncommitted).toEqual([file('same.ts', 'added', 'repo-a')]);
    expect(capped.committed).toEqual([file('same.ts', 'deleted', 'repo-a')]);
  });

  it('keeps paging the other group when its next prefix still fits', () => {
    const oversized = file(`a.ts${'x'.repeat(500)}`, 'modified', 'repo-a');
    const small = file('small.ts', 'added', 'repo-b');
    const capped = capChangedFilesPayload(
      payload([oversized], [small]),
      (candidate) => {
        if (!candidate.notices) return Number.MAX_SAFE_INTEGER;
        return candidate.uncommitted.length === 0 &&
          candidate.committed.length === 1
          ? 0
          : 2;
      },
      1,
    );

    expect(capped.uncommitted).toEqual([]);
    expect(capped.committed).toEqual([small]);
  });

  it('measures a logarithmic number of candidates for a large list', () => {
    const files = Array.from({ length: 10_000 }, (_, index) =>
      file(`src/${String(index).padStart(5, '0')}.ts`),
    );
    let measured = 0;
    const capped = capChangedFilesPayload(
      payload(files, [file('c.ts')]),
      (candidate) => {
        measured += 1;
        return candidate.uncommitted.length + candidate.committed.length;
      },
      5_000,
    );

    expect(capped.uncommitted).toEqual(files.slice(0, 4_999));
    expect(capped.committed).toEqual([file('c.ts')]);
    expect(measured).toBeLessThan(64);
  });

  it('pages every sorted file exactly once and reports stale or invalid cursors', () => {
    const groups = {
      uncommitted: sortChangedFiles([file('c.ts'), file('a.ts'), file('b.ts')]),
      committed: sortChangedFiles([file('f.ts'), file('d.ts'), file('e.ts')]),
    };
    const revision = getChangedFilesRevision(groups);
    const allPages = (group: PortalChangedFilesGroup): PortalChangedFile[] => {
      const complete = groups[group];
      const firstCursor = encodeChangedFilesCursor({
        revision,
        group,
        offset: 0,
      });
      let cursor: string | undefined = firstCursor;
      const files: PortalChangedFile[] = [];
      while (cursor) {
        const result = pageChangedFiles(
          groups,
          {
            workspaceLocalId: 'workspace-1',
            worktreeLocalId: 'worktree-1',
            group,
            cursor,
            limit: 2,
          },
          () => true,
        );
        if ('error' in result.changedFilesPage) {
          throw new Error(
            `Unexpected page error: ${result.changedFilesPage.error}`,
          );
        }
        files.push(...result.changedFilesPage.files);
        cursor = result.changedFilesPage.nextCursor;
      }
      expect(files).toEqual(complete);
      return files;
    };

    expect(allPages('uncommitted')).toEqual(groups.uncommitted);
    expect(allPages('committed')).toEqual(groups.committed);
    expect(
      pageChangedFiles(
        groups,
        {
          workspaceLocalId: 'workspace-1',
          worktreeLocalId: 'worktree-1',
          group: 'uncommitted',
          cursor: 'bad',
          limit: 2,
        },
        () => true,
      ),
    ).toMatchObject({
      changedFilesPage: {
        workspaceLocalId: 'workspace-1',
        worktreeLocalId: 'worktree-1',
        group: 'uncommitted',
        cursor: 'bad',
        error: 'invalid_cursor',
      },
    });
    expect(
      pageChangedFiles(
        groups,
        {
          workspaceLocalId: 'workspace-1',
          worktreeLocalId: 'worktree-1',
          group: 'uncommitted',
          cursor: encodeChangedFilesCursor({
            revision: 'old',
            group: 'uncommitted',
            offset: 0,
          }),
          limit: 2,
        },
        () => true,
      ),
    ).toMatchObject({
      changedFilesPage: { group: 'uncommitted', error: 'stale_cursor' },
    });
  });

  it('bounds pages by the injected completion-envelope budget', () => {
    const groups = {
      uncommitted: sortChangedFiles([file('a.ts'), file('b.ts'), file('c.ts')]),
      committed: [],
    };
    const revision = getChangedFilesRevision(groups);
    const cursor = encodeChangedFilesCursor({
      revision,
      group: 'uncommitted',
      offset: 0,
    });
    const result = pageChangedFiles(
      groups,
      {
        workspaceLocalId: 'workspace-1',
        worktreeLocalId: 'worktree-1',
        group: 'uncommitted',
        cursor,
        limit: 3,
      },
      (candidate) => successFiles(candidate).length <= 2,
    );

    expect(successFiles(result)).toEqual(groups.uncommitted.slice(0, 2));
    expect(
      'error' in result.changedFilesPage
        ? undefined
        : result.changedFilesPage.nextCursor,
    ).toBeDefined();
  });
});
