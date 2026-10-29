import type { OpenDialogOptions } from 'electron';

/** A pending chooser ends after this, or sooner when its frame navigates. */
export const FILE_CHOOSER_LIFETIME_MS = 10 * 60_000;

/**
 * The native open dialog for a file input: one file, several, or a folder,
 * filtered by the extensions its `accept` lists. An `accept` that names a
 * MIME type is not filtered, as a mismatch is the page's to judge.
 */
export function chooserDialogOptions(input: {
  multiple: boolean;
  directory?: boolean;
  accept?: string;
  title?: string;
}): OpenDialogOptions {
  const entries = (input.accept ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  const extensions = entries.every((entry) => /^\.[a-z0-9]+$/.test(entry))
    ? Array.from(new Set(entries.map((entry) => entry.slice(1))))
    : [];
  return {
    ...(input.title ? { title: input.title } : {}),
    properties: input.directory
      ? ['openDirectory']
      : input.multiple
        ? ['openFile', 'multiSelections']
        : ['openFile'],
    ...(extensions.length > 0
      ? { filters: [{ name: 'Files', extensions }] }
      : {}),
  };
}
