/** One file chip a turn summary actually displays. */
export interface TurnFilesHeadingEntry {
  /** Omitted for saved (legacy and newly written) files. */
  readonly change?: 'updated';
  /** The change is still in flight. */
  readonly pending?: boolean;
  /** The pending change waits for approval rather than running. */
  readonly waiting?: boolean;
}

export interface TurnFilesHeadingOptions {
  /** The files sit beside a turn diff: "1 other file updated". */
  readonly other?: boolean;
}

/**
 * Heading for the file chips a turn summary shows, shared by every host and
 * chat look. Count only displayed entries, after deduplication, existence
 * checks, failure filtering and diff suppression. Pending updates never read
 * as completed ones; a mix of pending and finished work keeps a neutral
 * total until it settles, as does any change waiting for approval. Returns
 * undefined when nothing is displayed.
 */
export function formatTurnFilesHeading(
  entries: readonly TurnFilesHeadingEntry[],
  options: TurnFilesHeadingOptions = {},
): string | undefined {
  const total = entries.length;
  if (total === 0) return undefined;
  const files = `${total} ${options.other ? 'other ' : ''}${total === 1 ? 'file' : 'files'}`;
  const updated = entries.filter((entry) => entry.change === 'updated').length;
  if (updated === 0) return files;
  if (entries.some((entry) => entry.pending && entry.waiting)) return files;
  const pending = entries.filter((entry) => entry.pending).length;
  if (pending > 0)
    return pending === total && updated === total ? `${files} updating` : files;
  return updated === total
    ? `${files} updated`
    : `${files}, ${updated} updated`;
}
