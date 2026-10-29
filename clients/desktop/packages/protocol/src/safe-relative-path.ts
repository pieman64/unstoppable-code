export function isSafePortableRelativePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4096 &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !/^[A-Za-z]:/.test(value) &&
    value
      .split('/')
      .every((segment) => segment !== '' && segment !== '.' && segment !== '..')
  );
}
