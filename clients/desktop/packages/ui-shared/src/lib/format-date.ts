const DATE_FORMAT_OPTIONS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
};

/** One formatter and a bounded ISO-string cache for large catalog tables. */
const dateFormatter = new Intl.DateTimeFormat(undefined, DATE_FORMAT_OPTIONS);
const formattedDateCache = new Map<string, string>();
const FORMATTED_DATE_CACHE_LIMIT = 5_000;

export function formatDate(isoString: string): string {
  const cached = formattedDateCache.get(isoString);
  if (cached !== undefined) return cached;

  let formatted: string;
  try {
    const parsed = new Date(isoString);
    try {
      formatted = dateFormatter.format(parsed);
    } catch {
      formatted = parsed.toLocaleDateString(undefined, DATE_FORMAT_OPTIONS);
    }
  } catch {
    return isoString;
  }

  if (formattedDateCache.size >= FORMATTED_DATE_CACHE_LIMIT) {
    formattedDateCache.clear();
  }
  formattedDateCache.set(isoString, formatted);
  return formatted;
}

export function formatDateOrEmpty(value: string | undefined): string {
  if (value === undefined || value === '') return '';
  return Number.isNaN(new Date(value).getTime()) ? '' : formatDate(value);
}
