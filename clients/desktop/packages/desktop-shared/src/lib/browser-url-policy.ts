const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const WINDOWS_DRIVE_PATH = /^[a-zA-Z]:[\\/]/;
const WINDOWS_DEVICE_PATH = /^\\\\[?.]\\/;
const HOST_WITH_PORT = /^[a-zA-Z\d.-]+:\d+(?:[/?#]|$)/;

export type InAppBrowserInputVerdict =
  | { kind: 'ok'; url: string }
  | { kind: 'blocked-by-local-only' }
  | { kind: 'network-path' }
  | { kind: 'unsupported' };

function hasScheme(input: string): boolean {
  return /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(input);
}

function encodePathSegment(segment: string): string {
  return encodeURIComponent(segment);
}

function normalizePosixPath(input: string): string {
  const encodedPath = input.split('/').map(encodePathSegment).join('/');
  return new URL(`file://${encodedPath}`).href;
}

function normalizeWindowsDrivePath(input: string): string {
  const normalized = input.replace(/\\/g, '/');
  const [drive = '', ...segments] = normalized.split('/');
  const encodedPath = [drive, ...segments.map(encodePathSegment)].join('/');
  return new URL(`file:///${encodedPath}`).href;
}

function normalizeWindowsNetworkPath(input: string): string {
  const [host = '', ...segments] = input
    .slice(2)
    .replace(/\\/g, '/')
    .split('/');
  const encodedPath = segments.map(encodePathSegment).join('/');
  const networkUrl = new URL(`file://${host}/${encodedPath}`);
  return host && networkUrl.hostname === ''
    ? new URL(`file:////${host}/${encodedPath}`).href
    : networkUrl.href;
}

export function normalizeBrowserUrlInput(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return '';
  }
  if (trimmed === 'about:blank') {
    return trimmed;
  }
  if (
    trimmed === '~' ||
    trimmed.startsWith('~/') ||
    trimmed.startsWith('~\\')
  ) {
    return '';
  }
  if (WINDOWS_DEVICE_PATH.test(trimmed)) {
    return '';
  }
  try {
    if (WINDOWS_DRIVE_PATH.test(trimmed)) {
      return normalizeWindowsDrivePath(trimmed);
    }
    if (trimmed.startsWith('\\\\')) {
      return normalizeWindowsNetworkPath(trimmed);
    }
    if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
      return normalizePosixPath(trimmed);
    }
    if (HOST_WITH_PORT.test(trimmed) || /^[a-zA-Z]:/.test(trimmed)) {
      return `http://${trimmed}`;
    }
    if (hasScheme(trimmed)) {
      return trimmed.toLowerCase().startsWith('file:')
        ? new URL(trimmed).href
        : trimmed;
    }
    return `http://${trimmed}`;
  } catch {
    return '';
  }
}

export function isFileBrowserUrl(rawUrl: string): boolean {
  const normalized = normalizeBrowserUrlInput(rawUrl);
  if (!normalized) return false;
  try {
    return new URL(normalized).protocol === 'file:';
  } catch {
    return false;
  }
}

export function isAllowedInAppBrowserUrl(
  rawUrl: string,
  localServersOnly: boolean,
): boolean {
  const normalized = normalizeBrowserUrlInput(rawUrl);
  if (normalized === 'about:blank') {
    return true;
  }
  if (normalized.length === 0) {
    return false;
  }
  try {
    const parsed = new URL(normalized);
    switch (parsed.protocol) {
      case 'file:':
        return (
          parsed.hostname === '' &&
          parsed.pathname !== '/' &&
          !parsed.pathname.startsWith('//')
        );
      case 'http:':
      case 'https:':
        return (
          !localServersOnly || LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())
        );
      default:
        return false;
    }
  } catch {
    return false;
  }
}

export function isSafeExternalBrowserUrl(rawUrl: string): boolean {
  const normalized = normalizeBrowserUrlInput(rawUrl);
  if (!normalized) return false;
  try {
    const parsed = new URL(normalized);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function sameBrowserUrl(left: string, right: string): boolean {
  const normalizedLeft = normalizeBrowserUrlInput(left);
  const normalizedRight = normalizeBrowserUrlInput(right);
  if (!normalizedLeft || !normalizedRight) return false;
  try {
    return new URL(normalizedLeft).href === new URL(normalizedRight).href;
  } catch {
    return false;
  }
}

export function classifyInAppBrowserInput(
  input: string,
  localServersOnly: boolean,
): InAppBrowserInputVerdict {
  const normalized = normalizeBrowserUrlInput(input);
  if (isAllowedInAppBrowserUrl(normalized, localServersOnly)) {
    return { kind: 'ok', url: normalized };
  }
  if (!normalized) {
    return { kind: 'unsupported' };
  }
  try {
    const parsed = new URL(normalized);
    if (
      parsed.protocol === 'file:' &&
      (parsed.hostname !== '' || parsed.pathname.startsWith('//'))
    ) {
      return { kind: 'network-path' };
    }
    if (
      localServersOnly &&
      (parsed.protocol === 'http:' || parsed.protocol === 'https:')
    ) {
      return { kind: 'blocked-by-local-only' };
    }
  } catch {
    // Fall through to the unsupported verdict.
  }
  return { kind: 'unsupported' };
}
