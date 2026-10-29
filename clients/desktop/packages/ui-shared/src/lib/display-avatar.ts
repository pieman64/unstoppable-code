// Pure display helpers for round initials avatars. These started life inside
// the plan-comment thread; they moved here when the share target pickers
// needed the same treatment, so there is one initials rule and one color hash
// rather than a per-surface copy. `plan-comments.ts` re-exports them under
// their original names.

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

/**
 * Deterministic, theme-agnostic avatar background derived from a stable key
 * (a user id when available, else the display name). Returns inline style so
 * the color survives in both light and dark mode without a Tailwind palette.
 */
export function displayAvatarColor(key: string): {
  backgroundColor: string;
  color: string;
} {
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return {
    backgroundColor: `hsl(${hue} 52% 42%)`,
    color: 'hsl(0 0% 100%)',
  };
}
