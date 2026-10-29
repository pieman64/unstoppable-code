const FILE_URL_RE = /^file:/i;
const WINDOWS_ROOTED_RE = /^(?:[A-Za-z]:[\\/]|\\)/;

function isHostAbsolutePath(value: string): boolean {
  return (
    value.startsWith('/') ||
    FILE_URL_RE.test(value) ||
    WINDOWS_ROOTED_RE.test(value)
  );
}

export function hasHostAbsolutePath(value: unknown): boolean {
  if (typeof value === 'string') return isHostAbsolutePath(value);
  if (Array.isArray(value)) return value.some(hasHostAbsolutePath);
  if (value !== null && typeof value === 'object') {
    return Object.values(value).some(hasHostAbsolutePath);
  }
  return false;
}
