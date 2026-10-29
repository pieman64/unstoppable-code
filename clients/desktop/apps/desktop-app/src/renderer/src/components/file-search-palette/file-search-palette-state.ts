import {
  isFileIndexStale,
  type CachedIndexEntry,
} from '@/stores/fileListStore';

export function shouldFetchFileSearchPaletteEntry(
  entry: CachedIndexEntry | undefined,
  isLoading: boolean,
  error: string | undefined,
): boolean {
  return isFileIndexStale(entry) && !isLoading && error === undefined;
}
