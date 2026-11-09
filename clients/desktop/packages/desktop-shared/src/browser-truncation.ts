import type {
  BrowserConsoleEntry,
  BrowserNetworkEntry,
} from '@canopy/execution-engine/types/browser';

export const BROWSER_ACTION_ROW_LIMIT = 200;
export const BROWSER_CONSOLE_MESSAGE_MAX_CHARS = 2000;
export const BROWSER_URL_MAX_CHARS = 500;

export interface TruncatedString {
  value: string;
  truncated: boolean;
  originalLength: number;
}

export type TruncatedBrowserConsoleEntry = BrowserConsoleEntry & {
  truncated: boolean;
};

export type TruncatedBrowserNetworkEntry = BrowserNetworkEntry & {
  truncated: boolean;
};

export function truncateString(
  value: string,
  maxChars: number,
): TruncatedString {
  return {
    value: value.length > maxChars ? value.slice(0, maxChars) : value,
    truncated: value.length > maxChars,
    originalLength: value.length,
  };
}

export function truncateBrowserConsoleEntry(
  entry: BrowserConsoleEntry,
): TruncatedBrowserConsoleEntry {
  const text = truncateString(entry.text, BROWSER_CONSOLE_MESSAGE_MAX_CHARS);
  const url = entry.url
    ? truncateString(entry.url, BROWSER_URL_MAX_CHARS)
    : null;
  return {
    ...entry,
    text: text.value,
    ...(url ? { url: url.value } : {}),
    truncated: text.truncated || url?.truncated === true,
  };
}

export function truncateBrowserNetworkEntry(
  entry: BrowserNetworkEntry,
): TruncatedBrowserNetworkEntry {
  const url = truncateString(entry.url, BROWSER_URL_MAX_CHARS);
  return {
    ...entry,
    url: url.value,
    truncated: url.truncated,
  };
}
