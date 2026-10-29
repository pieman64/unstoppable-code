import type { PrPickerOption } from '@/stores/navigationStore';

function matchesPrPickerQuery(option: PrPickerOption, query: string): boolean {
  if (query.length === 0) {
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

  return haystack.includes(query);
}

export function getFilteredPrPickerOptions(
  options: PrPickerOption[],
  query: string,
): PrPickerOption[] {
  const normalized = query.trim().toLowerCase();
  return options.filter((option) => matchesPrPickerQuery(option, normalized));
}

export function getSelectedPrPickerOption(
  options: PrPickerOption[],
  query: string,
  selectedIndex: number,
): PrPickerOption | undefined {
  if (selectedIndex < 0) {
    return undefined;
  }

  return getFilteredPrPickerOptions(options, query)[selectedIndex];
}
