/**
 * Parse a GitHub repo identifier from either a full URL or `owner/repo`
 * shorthand. Returns `owner/repo` on success, or `null` if the input is
 * invalid.
 *
 * Originally hoisted from the desktop renderer's `lib/format.ts` into
 * `@canopy/desktop-shared` so the Electron main process — specifically the
 * `portal.marketplace.add` adapter — validated browser-supplied repo
 * references with the SAME parser the desktop's add-marketplace UI uses.
 *
 * It now lives HERE, in the environment-neutral package, because the portal's
 * add-marketplace form in `apps/web` needs that same parser and `apps/web` is
 * (correctly) forbidden from importing `@canopy/desktop-shared` at all — see
 * that app's `no-restricted-imports` boundary. Duplicating the regexes into
 * web would let browser-side validation drift away from the desktop-side
 * validation that actually accepts or rejects the command, which is exactly
 * the bug this parser was hoisted to prevent the first time.
 *
 * `@canopy/desktop-shared/lib/github-repo` re-exports this, so every existing
 * desktop importer is unaffected.
 *
 * Keep it dependency-free: the renderer, the Electron main process, and the
 * browser bundle all import it.
 */
export function parseGitHubRepo(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Try full URL: https://(www.)github.com/owner/repo
  const urlMatch = trimmed.match(
    /^https?:\/\/(?:www\.)?github\.com\/([^/]+\/[^/]+?)(?:\.git)?(?:\/.*)?$/i,
  );
  if (urlMatch) return urlMatch[1];

  // Try shorthand: owner/repo
  const shortMatch = trimmed.match(/^([^/\s]+\/[^/\s]+)$/);
  if (shortMatch) return shortMatch[1];

  return null;
}

const GITHUB_HOSTS = new Set(['github.com', 'www.github.com']);
const GITHUB_SEGMENT = /^[A-Za-z0-9_.-]+$/;

/**
 * The GitHub `owner/repo` a marketplace source names, or `undefined` when the
 * source is not a plain GitHub repository. Strict on purpose: the result is
 * published inside public plugin share references, so a source carrying
 * userinfo, a query, a fragment, an extra path or a non-GitHub host must never
 * become a share reference (a credentialed marketplace URL would otherwise
 * leak through the anonymous share endpoint).
 */
export function parseShareableGitHubSource(
  sourceUrl: string | null | undefined,
): string | undefined {
  const trimmed = (sourceUrl ?? '').trim();
  if (trimmed.length === 0) return undefined;
  let owner: string;
  let repo: string;
  if (trimmed.includes('://')) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return undefined;
    }
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== '' ||
      !GITHUB_HOSTS.has(url.hostname.toLowerCase())
    ) {
      return undefined;
    }
    const segments = url.pathname.split('/').filter((part) => part !== '');
    if (segments.length !== 2) return undefined;
    [owner, repo] = segments;
  } else {
    if (trimmed.startsWith('git@') || /[\s?#@:]/.test(trimmed)) {
      return undefined;
    }
    const segments = trimmed.split('/');
    if (segments.length !== 2) return undefined;
    [owner, repo] = segments;
  }
  repo = repo.endsWith('.git') ? repo.slice(0, -'.git'.length) : repo;
  if (!GITHUB_SEGMENT.test(owner) || !GITHUB_SEGMENT.test(repo)) {
    return undefined;
  }
  return `${owner}/${repo}`;
}
