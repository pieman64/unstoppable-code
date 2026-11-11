import type {
  ChangedFileInfo,
  ChangedFileStatus,
} from '@canopy/desktop-shared/types';

const GIT_C_ESCAPES: Readonly<Record<string, number>> = {
  a: 0x07,
  b: 0x08,
  t: 0x09,
  n: 0x0a,
  v: 0x0b,
  f: 0x0c,
  r: 0x0d,
  '"': 0x22,
  '\\': 0x5c,
};

/**
 * Non-`-z` Git paths remain C-quoted for backslashes, quotes and controls even
 * with `core.quotePath=false`. ChangedFileInfo carries actual filename identity,
 * not that display spelling (CAN-3224 supersedes CAN-4103's quoted-path parity).
 * Decode only a complete valid field; malformed escapes are never path aliases.
 */
export function decodeGitPath(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"')) return path;
  const bytes: number[] = [];
  const input = Buffer.from(path.slice(1, -1), 'utf8');
  for (let index = 0; index < input.length; index += 1) {
    const byte = input[index];
    if (byte === 0x22) return path;
    if (byte !== 0x5c) {
      bytes.push(byte);
      continue;
    }
    const escape = GIT_C_ESCAPES[String.fromCharCode(input[index + 1])];
    if (escape !== undefined) {
      bytes.push(escape);
      index += 1;
      continue;
    }
    const octal = input.subarray(index + 1, index + 4).toString('utf8');
    if (!/^[0-3][0-7]{2}$/.test(octal)) return path;
    bytes.push(Number.parseInt(octal, 8));
    index += 3;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      Uint8Array.from(bytes),
    );
  } catch {
    return path;
  }
}

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
    const path = decodeGitPath(parts[parts.length - 1]);
    const previousPath =
      (statusCode.startsWith('R') || statusCode.startsWith('C')) &&
      parts.length >= 3
        ? decodeGitPath(parts[1])
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
    const path = decodeGitPath(parts[parts.length - 1]);
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
