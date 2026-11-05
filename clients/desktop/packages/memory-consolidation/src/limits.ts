export const MEMORY_INDEX_MAX_LINES = 200;
export const MEMORY_INDEX_MAX_BYTES = 25 * 1024;
export const MAX_UNUSED_DAYS = 90;

export const MAX_TOPIC_OUTPUT_FILES = 100;
export const MAX_TOPIC_BYTES = 100 * 1024;
export const MAX_TOPIC_FILENAME_BYTES = 200;

export const TOPICS_INPUT_BUDGET_BYTES = 192 * 1024;
export const INBOX_INPUT_BUDGET_BYTES = 192 * 1024;
export const IMPORTS_INPUT_BUDGET_BYTES = 192 * 1024;

// Upper bound on inbox notes consumed by a single consolidation run. Notes
// are taken oldest-first, only the included notes are archived on success,
// and the remainder drains on subsequent runs.
export const MAX_INBOX_FILES_PER_RUN = 200;
