/** Shared bounds for the managed Cursor runtime installer, its hash worker, and the pin script. */
export const MAX_RUNTIME_ENTRIES = 2_000;
export const MAX_UNPACKED_BYTES = 800 * 1024 * 1024;
/** Upper bound for any archive the pin script is willing to download. */
export const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
