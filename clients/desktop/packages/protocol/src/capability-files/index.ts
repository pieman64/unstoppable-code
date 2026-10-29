/** Shared file metadata used by capability-package and capability-bundle manifests. */
export interface CapabilityFileEntryBase {
  path: string;
  sha256: string;
  size: number;
}

export const CAPABILITY_FILE_SHA256_PATTERN = /^[a-f0-9]{64}$/;

const WINDOWS_RESERVED_NAME_PATTERN =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const WINDOWS_INVALID_SEGMENT_CHARACTER_PATTERN = /[<>:"\\|?*]/;

/** Whether a single path segment materializes portably on POSIX and Windows. */
export function isPortableCapabilityPathSegment(
  value: unknown,
  options: { maxLength?: number } = {},
): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    (options.maxLength === undefined || value.length <= options.maxLength) &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.endsWith('.') &&
    !value.endsWith(' ') &&
    !WINDOWS_INVALID_SEGMENT_CHARACTER_PATTERN.test(value) &&
    !Array.from(value).some((character) => character.charCodeAt(0) <= 0x1f) &&
    !WINDOWS_RESERVED_NAME_PATTERN.test(value)
  );
}

/** Whether a relative POSIX path is safe and portable to materialize. */
export function isSafeCapabilityRelativePath(
  value: unknown,
  options: { maxPathLength?: number; maxSegmentLength?: number } = {},
): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    (options.maxPathLength !== undefined &&
      value.length > options.maxPathLength) ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.includes('\0') ||
    /^[A-Za-z]:/.test(value)
  ) {
    return false;
  }
  return value.split('/').every((segment) =>
    isPortableCapabilityPathSegment(segment, {
      maxLength: options.maxSegmentLength,
    }),
  );
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('');
}

export function base64UrlEncode(bytes: Uint8Array): string {
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const combined = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    output += alphabet[(combined >>> 18) & 63];
    output += alphabet[(combined >>> 12) & 63];
    output += second === undefined ? '=' : alphabet[(combined >>> 6) & 63];
    output += third === undefined ? '=' : alphabet[combined & 63];
  }
  return output.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bgh[opusr]_[A-Za-z0-9]{20,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\b(?:Authorization|Proxy-Authorization|Cookie|Set-Cookie|X-Api-Key|X-Auth-Token|X-Amz-Security-Token)\s*:\s*[^\r\n]+/i,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/,
  /["']?(?:api[_-]?key|access[_-]?key|secret[_-]?access[_-]?key|secret[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|password|passwd|pwd)["']?\s*:\s*["']?[^"',}\]\s]+/i,
  /\b(?:api[_-]?key|access[_-]?key|secret[_-]?access[_-]?key|secret[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|password|passwd|pwd)=[^\s&"']+/i,
];

/** Return whether text contains a high-confidence secret signature. */
export function containsSecretMaterial(text: string): boolean {
  return (
    text.length > 0 && SECRET_PATTERNS.some((pattern) => pattern.test(text))
  );
}
