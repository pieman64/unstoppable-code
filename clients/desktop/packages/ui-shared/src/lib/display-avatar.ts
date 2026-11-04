// The initials rule for `DisplayAvatar`: one rule for every avatar rather than
// a per-surface copy. Avatars are neutral, so there is no per-name color.

/**
 * Two-letter initials for an avatar. Uses the first letter of the first and
 * last whitespace-separated words, falling back to the first two letters of a
 * single word, then `?` for empty input.
 */
export function displayInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return '?';
  }
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
