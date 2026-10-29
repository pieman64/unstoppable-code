import type {
  ChangedFileInfo,
  ChangedFileStatus,
} from '@canopy/desktop-shared/types';

function mapChangedFileStatus(statusCode: string): ChangedFileStatus {
  switch (statusCode[0]) {
    case 'A':
      return 'added';
    case 'M':
      return 'modified';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    case 'U':
      return 'unmerged';
    case 'T':
      return 'type-changed';
    default:
      return 'unknown';
  }
}

export function parseDiffOutput(
  statusOutput: string,
  numstatOutput: string,
): Map<string, ChangedFileInfo> {
  const files = new Map<string, ChangedFileInfo>();

  for (const line of statusOutput.split('\n').filter(Boolean)) {
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    const statusCode = parts[0];
    const path = parts[parts.length - 1];
    const previousPath =
      (statusCode.startsWith('R') || statusCode.startsWith('C')) &&
      parts.length >= 3
        ? parts[1]
        : undefined;
    files.set(path, {
      path,
      status: mapChangedFileStatus(statusCode),
      insertions: 0,
      deletions: 0,
      ...(previousPath ? { previousPath } : {}),
    });
  }

  for (const line of numstatOutput.split('\n').filter(Boolean)) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const path = parts[parts.length - 1];
    const existing = files.get(path);
    if (!existing) continue;
    // numstat reports a binary file as `-\t-`: no line counts exist for it.
    const binary = parts[0] === '-' && parts[1] === '-';
    files.set(path, {
      ...existing,
      insertions: parts[0] === '-' ? 0 : Number.parseInt(parts[0], 10) || 0,
      deletions: parts[1] === '-' ? 0 : Number.parseInt(parts[1], 10) || 0,
      ...(binary ? { binary: true } : {}),
    });
  }

  return files;
}
