export type FilesTabEditorMode = 'create-file' | 'create-directory' | 'rename';
export interface FilesTabInlineEditorState {
  readonly mode: FilesTabEditorMode;
  readonly parentDir: string;
  readonly targetPath?: string;
  readonly originalName?: string;
  readonly isDir: boolean;
  readonly value: string;
}
export type FilesTabEditorValidation =
  | { ok: true; value: string; unchanged: boolean }
  | { ok: false; error: string };
export function validateFilesTabEditorValue(
  editor: FilesTabInlineEditorState,
): FilesTabEditorValidation {
  const value = editor.value.trim().replace(/\\/g, '/');
  if (!value) return { ok: false, error: 'Enter a file or folder name.' };
  if (editor.mode === 'rename' && value.includes('/'))
    return { ok: false, error: 'Names cannot contain path separators.' };
  if (value.split('/').includes('..'))
    return { ok: false, error: 'Names cannot contain "..".' };
  if (
    value.startsWith('/') ||
    value.split('/').some((part): boolean => part === '' || part === '.') ||
    Array.from(value).some(
      (character): boolean =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    return { ok: false, error: 'Enter a relative file or folder name.' };
  return {
    ok: true,
    value,
    unchanged: editor.mode === 'rename' && value === editor.originalName,
  };
}
export function joinRelativePath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}
export function parentDirOf(relativePath: string): string {
  return relativePath.split('/').slice(0, -1).join('/');
}
