export interface TerminalFileDataTransfer {
  readonly types?: ArrayLike<string>;
  readonly files?: ArrayLike<File>;
}

export function dataTransferHasFiles(
  dataTransfer: TerminalFileDataTransfer | null | undefined,
): boolean {
  if (!dataTransfer) {
    return false;
  }
  return Array.from(dataTransfer.types ?? []).includes('Files');
}

/**
 * Paths the backend can open for the dropped files. The host may need to
 * upload them first (a window that shows another computer), so this is
 * asynchronous; files it cannot resolve are left out.
 */
export async function resolveDroppedFilePaths(
  dataTransfer: TerminalFileDataTransfer | null | undefined,
  getPathsForFiles: (files: ReadonlyArray<File>) => Promise<string[]>,
): Promise<string[]> {
  if (!dataTransfer?.files || dataTransfer.files.length === 0) {
    return [];
  }
  const paths = await getPathsForFiles(Array.from(dataTransfer.files));
  return paths.filter((filePath) => filePath.length > 0);
}

export function formatFilePathsForTerminalPaste(paths: string[]): string {
  const escapedPaths = paths
    .filter((filePath) => filePath.length > 0)
    .map(escapeTerminalPath);

  return escapedPaths.length > 0 ? `${escapedPaths.join(' ')} ` : '';
}

function escapeTerminalPath(filePath: string): string {
  if (looksLikeWindowsPath(filePath)) {
    return needsWindowsQuoting(filePath)
      ? `"${filePath.replace(/"/g, '\\"')}"`
      : filePath;
  }

  return filePath.replace(/([\\\s"'`$!#&;<>()[\]{}|?*])/g, '\\$1');
}

function looksLikeWindowsPath(filePath: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(filePath) || filePath.startsWith('\\\\');
}

function needsWindowsQuoting(filePath: string): boolean {
  return /[\s"&|<>^]/.test(filePath);
}
