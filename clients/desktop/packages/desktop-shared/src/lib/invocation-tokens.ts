const INVOCATION_PATTERN =
  /(?:^|[^A-Za-z0-9_-])(\/[A-Za-z0-9._-]+(?::[A-Za-z0-9._-]+)*|\$[A-Za-z0-9._-]+(?::[A-Za-z0-9._-]+)*)(?=$|[^A-Za-z0-9._-])/g;

export interface InvocationToken {
  value: string;
  before: string;
  after: string;
}

export function extractInvocationTokens(value: string): InvocationToken[] {
  return Array.from(value.matchAll(INVOCATION_PATTERN)).flatMap((match) => {
    const rawInvocation = match[1];
    if (typeof rawInvocation !== 'string') return [];
    const invocationOffset = match[0].indexOf(rawInvocation);
    const invocationStart = (match.index ?? 0) + invocationOffset;
    if (
      rawInvocation.startsWith('/') &&
      value.slice(Math.max(0, invocationStart - 2), invocationStart) === ':/'
    ) {
      return [];
    }
    const invocation = rawInvocation.replace(/[.,;:!?]+$/, '');
    return [
      {
        value: invocation,
        before: value.slice(Math.max(0, invocationStart - 1), invocationStart),
        after: value.slice(
          invocationStart + rawInvocation.length,
          invocationStart + rawInvocation.length + 1,
        ),
      },
    ];
  });
}

export function isPathShapedInvocationToken(token: InvocationToken): boolean {
  if (isExplicitPathInvocationToken(token)) return true;
  if (!token.value.startsWith('/')) return false;
  return /\.[A-Za-z0-9]{1,10}$/.test(token.value);
}

export function isExplicitPathInvocationToken(token: InvocationToken): boolean {
  if (token.after === '/') return true;
  if (!token.value.startsWith('/')) return false;
  return ['/', '=', '.', '~'].includes(token.before);
}
