/**
 * Coverage for the renderer-session file view-mode memory and the resolver
 * new file tabs start from (CAN-4955).
 */
import {
  nextFileViewModeSequence,
  readRememberedFileViewMode,
  rememberClosedFileViewMode,
  rememberFileViewModeChoice,
  resetFileViewModeMemoryForTests,
  resolveNewFileTabViewMode,
  type FileViewModeIdentity,
} from '../last-view-mode';

const notes: FileViewModeIdentity = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  absolutePath: '/repo/docs/notes.md',
};

function observe(tabId = 'tab-1'): { sequence: number; tabId: string } {
  return { sequence: nextFileViewModeSequence(), tabId };
}

afterEach(() => {
  resetFileViewModeMemoryForTests();
});

describe('resolveNewFileTabViewMode', () => {
  it.each([
    ['/repo/notes.md', 'preview'],
    ['/repo/page.HTML', 'preview'],
    ['/repo/rows.csv', 'table'],
    ['/repo/src/index.ts', undefined],
  ])('defaults %s by kind', (absolutePath, expected) => {
    expect(resolveNewFileTabViewMode({ ...notes, absolutePath })).toBe(
      expected,
    );
  });

  it('prefers an explicit mode, then memory, then the kind default', () => {
    rememberFileViewModeChoice(notes, 'raw', observe());
    expect(resolveNewFileTabViewMode(notes)).toBe('raw');
    expect(resolveNewFileTabViewMode(notes, 'preview')).toBe('preview');
    expect(resolveNewFileTabViewMode(notes, 'diff')).toBe('diff');
  });

  it('falls back to the kind default for a remembered mode the file cannot show', () => {
    const code = { ...notes, absolutePath: '/repo/src/index.ts' };
    const image = { ...notes, absolutePath: '/repo/logo.png' };
    rememberFileViewModeChoice(notes, 'table', observe());
    rememberFileViewModeChoice(code, 'preview', observe());
    rememberFileViewModeChoice(image, 'raw', observe());
    expect(resolveNewFileTabViewMode(notes)).toBe('preview');
    expect(resolveNewFileTabViewMode(code)).toBeUndefined();
    expect(resolveNewFileTabViewMode(image)).toBeUndefined();
  });
});

describe('file view-mode memory', () => {
  it('isolates files by project and worktree without normalizing paths', () => {
    rememberFileViewModeChoice(notes, 'raw', observe());
    expect(
      readRememberedFileViewMode({ ...notes, worktreeId: 'worktree-2' }),
    ).toBeUndefined();
    expect(
      readRememberedFileViewMode({ ...notes, projectId: 'project-2' }),
    ).toBeUndefined();
    expect(
      readRememberedFileViewMode({
        ...notes,
        absolutePath: '/repo/docs/NOTES.md',
      }),
    ).toBeUndefined();
  });

  it('never records a choice without a complete identity', () => {
    rememberFileViewModeChoice(
      { ...notes, worktreeId: undefined },
      'raw',
      observe(),
    );
    rememberFileViewModeChoice(
      { ...notes, absolutePath: '' },
      'raw',
      observe(),
    );
    expect(
      readRememberedFileViewMode({ ...notes, worktreeId: undefined }),
    ).toBeUndefined();
    expect(readRememberedFileViewMode(notes)).toBeUndefined();
  });

  it('ignores diff and absent modes without erasing an earlier choice', () => {
    rememberFileViewModeChoice(notes, 'raw', observe());
    rememberFileViewModeChoice(notes, 'diff', observe());
    rememberClosedFileViewMode(notes, 'diff', observe());
    rememberClosedFileViewMode(notes, undefined, observe());
    expect(readRememberedFileViewMode(notes)).toBe('raw');
  });

  it('remembers the mode a tab closed with when it had no toggle', () => {
    rememberClosedFileViewMode(notes, 'raw', observe('restored-tab'));
    expect(readRememberedFileViewMode(notes)).toBe('raw');
  });

  it('keeps a choice applied in a tab over that tab’s close snapshot', () => {
    rememberFileViewModeChoice(notes, 'raw', observe('tab-1'));
    rememberClosedFileViewMode(notes, 'preview', observe('tab-1'));
    expect(readRememberedFileViewMode(notes)).toBe('raw');
  });

  it('does not let a delayed close overwrite a newer choice', () => {
    const closeStarted = observe('tab-1');
    rememberFileViewModeChoice(notes, 'preview', observe('tab-2'));
    rememberClosedFileViewMode(notes, 'raw', closeStarted);
    expect(readRememberedFileViewMode(notes)).toBe('preview');
  });

  it('keeps an accepted choice whose reply follows its tab’s stale close snapshot', () => {
    const choice = observe('tab-1');
    rememberClosedFileViewMode(notes, 'preview', observe('tab-1'));
    rememberFileViewModeChoice(notes, 'raw', choice);
    expect(readRememberedFileViewMode(notes)).toBe('raw');
  });

  it('does not let an older accepted choice overwrite a later tab’s close', () => {
    const choice = observe('tab-1');
    rememberClosedFileViewMode(notes, 'preview', observe('tab-2'));
    rememberFileViewModeChoice(notes, 'raw', choice);
    expect(readRememberedFileViewMode(notes)).toBe('preview');
  });

  it('forgets every choice on reset', () => {
    rememberFileViewModeChoice(notes, 'raw', observe());
    resetFileViewModeMemoryForTests();
    expect(readRememberedFileViewMode(notes)).toBeUndefined();
  });
});
