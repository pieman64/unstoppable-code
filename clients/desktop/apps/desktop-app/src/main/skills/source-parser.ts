/**
 * Adapted from https://github.com/vercel-labs/skills
 * Original source: MIT License
 * https://github.com/vercel-labs/skills/blob/main/src/source-parser.ts
 */

export interface ParsedGitHubSource {
  owner: string;
  repo: string;
  branch?: string;
  subPath?: string;
}

/**
 * Parse a GitHub source string into its components.
 * Accepts: `owner/repo`, `github.com/owner/repo`,
 * `https://github.com/owner/repo/tree/branch/path`, with optional `.git` suffix.
 */
export function parseGitHubSource(input: string): ParsedGitHubSource | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Full URL: https://github.com/owner/repo/tree/branch/path
  const urlMatch = trimmed.match(
    /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/([^/]+)(?:\/(.+))?)?(?:\/)?$/i,
  );
  if (urlMatch) {
    return {
      owner: urlMatch[1],
      repo: urlMatch[2],
      branch: urlMatch[3] || undefined,
      subPath: urlMatch[4] || undefined,
    };
  }

  // github.com/owner/repo (no protocol)
  const noPrefixMatch = trimmed.match(
    /^(?:www\.)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/)?$/i,
  );
  if (noPrefixMatch) {
    return { owner: noPrefixMatch[1], repo: noPrefixMatch[2] };
  }

  // owner/repo shorthand (strip @skill-name suffix if present)
  const shortMatch = trimmed.match(/^([^/\s]+)\/([^/\s@]+)(?:@[^/\s]+)?$/);
  if (shortMatch) {
    return { owner: shortMatch[1], repo: shortMatch[2] };
  }

  return null;
}
