import {
  validateFilesTabEditorValue,
  joinRelativePath,
  parentDirOf,
} from '../files-tab-inline-editor';
describe('inline file names', () => {
  it('allows nested creation and rejects unsafe names', () => {
    const editor = {
      mode: 'create-file',
      parentDir: '',
      isDir: false,
      value: '',
    } as const;
    expect(validateFilesTabEditorValue(editor)).toEqual({
      ok: false,
      error: 'Enter a file or folder name.',
    });
    expect(validateFilesTabEditorValue({ ...editor, value: 'a\\b' })).toEqual({
      ok: true,
      value: 'a/b',
      unchanged: false,
    });
    expect(validateFilesTabEditorValue({ ...editor, value: 'a/../b' })).toEqual(
      { ok: false, error: 'Names cannot contain "..".' },
    );
    expect(validateFilesTabEditorValue({ ...editor, value: '/a' }).ok).toBe(
      false,
    );
  });
  it('validates rename and preserves unchanged names', () => {
    const editor = {
      mode: 'rename',
      parentDir: '',
      isDir: false,
      originalName: 'a',
      value: 'a',
    } as const;
    expect(validateFilesTabEditorValue(editor)).toEqual({
      ok: true,
      value: 'a',
      unchanged: true,
    });
    expect(validateFilesTabEditorValue({ ...editor, value: 'a/b' })).toEqual({
      ok: false,
      error: 'Names cannot contain path separators.',
    });
    expect(joinRelativePath('', 'a')).toBe('a');
    expect(joinRelativePath('d', 'a')).toBe('d/a');
    expect(parentDirOf('a/b/c')).toBe('a/b');
    expect(parentDirOf('a')).toBe('');
  });
});
