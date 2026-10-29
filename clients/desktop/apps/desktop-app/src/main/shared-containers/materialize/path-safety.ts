import { isAbsolute, resolve, sep, win32 } from 'node:path';

const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const FORBIDDEN = /[<>:"|?*]/;

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => character.charCodeAt(0) < 32);
}

export function validateMaterializedRelativePath(value: string): string {
  const normalized = value.normalize('NFC');
  if (
    !normalized ||
    normalized.length > 1024 ||
    normalized.includes('\\') ||
    isAbsolute(normalized) ||
    win32.isAbsolute(normalized) ||
    /^[A-Za-z]:/.test(normalized)
  ) {
    throw new Error(`Unsafe shared-container output path: ${value}`);
  }
  const segments = normalized.split('/');
  for (const segment of segments) {
    if (
      !segment ||
      segment === '.' ||
      segment === '..' ||
      segment.endsWith('.') ||
      segment.endsWith(' ') ||
      WINDOWS_DEVICE.test(segment) ||
      FORBIDDEN.test(segment) ||
      containsControlCharacter(segment)
    ) {
      throw new Error(`Non-portable shared-container output path: ${value}`);
    }
  }
  return normalized;
}

export function resolveMaterializedPath(
  root: string,
  relative: string,
): string {
  const safe = validateMaterializedRelativePath(relative);
  const rootPath = resolve(root);
  const destination = resolve(rootPath, ...safe.split('/'));
  if (!destination.startsWith(`${rootPath}${sep}`)) {
    throw new Error(
      `Shared-container output path escaped its root: ${relative}`,
    );
  }
  return destination;
}

export function reserveMaterializedPath(
  seen: Set<string>,
  relative: string,
): string {
  const normalized = validateMaterializedRelativePath(relative);
  const collisionKey = normalized.toLocaleLowerCase('en-US');
  if (seen.has(collisionKey)) {
    throw new Error(`Shared-container output path collision: ${relative}`);
  }
  seen.add(collisionKey);
  return normalized;
}
