/** Lexical identity only; opening always goes through the host's scoped reader. */
export function turnFilePath(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    Array.from(value).some((character) => character.charCodeAt(0) < 32)
  )
    return undefined;
  if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value))
    return undefined;
  const slash = value.replace(/\\/g, '/');
  const prefix = slash.startsWith('//')
    ? '//'
    : slash.startsWith('/')
      ? '/'
      : '';
  const segments: string[] = [];
  for (const segment of slash.slice(prefix.length).split('/')) {
    if (!segment || segment === '.') continue;
    if (
      segment === '..' &&
      segments.length &&
      segments[segments.length - 1] !== '..' &&
      !/^[a-z]:$/i.test(segments[segments.length - 1] ?? '')
    )
      segments.pop();
    else segments.push(segment);
  }
  return segments.length ? prefix + segments.join('/') : undefined;
}
