/** Reuse origin normalization with an opt-in, conservative relationship policy.
 * The default remains compatible with existing repo import/combine callers.
 */
export function normalizeRemoteUrl(
  remoteUrl: string,
  strictRelationship = false,
): string | null {
  const trimmed = remoteUrl.trim();
  if (!trimmed) {
    return null;
  }

  if (strictRelationship && /[%?#\\\s]|(?:^|\/)\.\.?(?:\/|$)/.test(trimmed))
    return null;

  const scpMatch = trimmed.match(/^(?:[^@]+@)?([^:/]+):(.+)$/);
  if (scpMatch && !trimmed.includes('://')) {
    const host = scpMatch[1].toLowerCase();
    if (strictRelationship && /^[a-z0-9.-]+$/i.test(host) === false)
      return null;
    const path = normalizeRepoPath(
      scpMatch[2],
      strictRelationship === false || host === 'github.com',
      strictRelationship,
    );
    return path ? `${host}/${path}` : null;
  }

  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase();
    if (strictRelationship) {
      const authority = trimmed
        .split('://')[1]
        ?.split('/')[0]
        ?.split('@')
        .slice(-1)[0];
      if (
        (parsed.protocol === 'https:' || parsed.protocol === 'ssh:') ===
          false ||
        authority === undefined ||
        authority.length === 0 ||
        authority.includes(':') ||
        parsed.password ||
        parsed.search ||
        parsed.hash
      )
        return null;
    }
    const path = normalizeRepoPath(
      strictRelationship
        ? parsed.pathname.slice(1)
        : parsed.pathname.replace(/^\/+/, ''),
      strictRelationship === false || host === 'github.com',
      strictRelationship,
    );
    return path ? `${host}/${path}` : null;
  } catch {
    return null;
  }
}

export function remoteUrlsMatch(left: string, right: string): boolean {
  const normalizedLeft = normalizeRemoteUrl(left);
  const normalizedRight = normalizeRemoteUrl(right);

  return normalizedLeft !== null && normalizedLeft === normalizedRight;
}

function normalizeRepoPath(
  pathname: string,
  foldCase = true,
  strictRelationship = false,
): string | null {
  if (
    strictRelationship &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(pathname) === false
  )
    return null;
  const trimmed = pathname
    .trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');
  if (!trimmed) {
    return null;
  }

  return trimmed
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => (foldCase ? segment.toLowerCase() : segment))
    .join('/');
}
