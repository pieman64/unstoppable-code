import type { DiffFileStatus } from '@canopy/ui-shared/components';

/**
 * Map either a git porcelain status code (`'M'`, `'A'`, `'D'`, `'R'`, `'C'`,
 * `'U'`, `'T'`, `'??'`, …) or its canonical word spelling onto the shared
 * {@link DiffFileStatus} union used by `DiffFileTree`. For porcelain codes,
 * only the first significant character is considered; anything unrecognised
 * maps to `'unknown'` so the tree still renders a neutral dot.
 */
export function toDiffFileStatus(status: string): DiffFileStatus {
  const code = status.trim();
  // Word statuses are matched case-insensitively so the contract does not
  // silently depend on diff-service emitting exact lowercase.
  const word = code.toLowerCase();
  switch (word) {
    case 'added':
    case 'modified':
    case 'deleted':
    case 'renamed':
    case 'copied':
    case 'unmerged':
    case 'type-changed':
    case 'untracked':
      return word;
  }
  if (code === '??') {
    return 'untracked';
  }
  switch (code.charAt(0)) {
    case 'A':
      return 'added';
    case 'M':
      return 'modified';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    case 'U':
      return 'unmerged';
    case 'T':
      return 'type-changed';
    case '?':
      return 'untracked';
    default:
      return 'unknown';
  }
}
