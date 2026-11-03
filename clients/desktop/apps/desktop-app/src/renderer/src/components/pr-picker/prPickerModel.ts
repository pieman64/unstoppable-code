import type { PrPickerOption } from '@/stores/navigationStore';

/** Whether a pull request matches the picker's search text. */
export function prPickerOptionMatches(
  option: PrPickerOption,
  query: string,
): boolean {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) {
    return true;
  }

  const haystack = [
    option.repoName,
    option.prTitle,
    `#${option.prNumber}`,
    option.prState,
  ]
    .join(' ')
    .toLowerCase();

  return haystack.includes(normalized);
}
