/**
 * Whether a filename may be imported as a tracked plan document. Only markdown
 * (`.md`) and plain text (`.txt`) files qualify; extension-less files and
 * dotfiles are excluded.
 */
export function isImportablePlanFile(filename: string): boolean {
  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex <= 0) {
    // -1: no extension (e.g. "README"); 0: dotfile (e.g. ".gitignore").
    return false;
  }
  const extension = filename.slice(dotIndex + 1).toLowerCase();
  return extension === 'md' || extension === 'txt';
}
