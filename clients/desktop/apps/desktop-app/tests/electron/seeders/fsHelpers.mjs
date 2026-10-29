import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Write a JSON value to `filePath`, creating parent directories as needed.
 * Matches the existing spec helpers (2-space indent + trailing newline) so
 * seeded files look identical to what the main process writes.
 *
 * @param {string} filePath absolute path to write
 * @param {unknown} value JSON-serializable value
 */
export function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * Write a JSON Lines file (one JSON object per line) to `filePath`, creating
 * parent directories as needed. The main-process readers split on `\n` and
 * skip blank lines, so a trailing newline is safe.
 *
 * @param {string} filePath absolute path to write
 * @param {unknown[]} values one JSON-serializable value per line
 */
export function writeJsonl(filePath, values) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    `${values.map((value) => JSON.stringify(value)).join('\n')}\n`,
    'utf8',
  );
}

/**
 * Return the UTC ISO day prefix (`YYYY-MM-DD`) for a timestamp.
 *
 * The observability service derives day-file names with
 * `new Date(value).toISOString().slice(0, 10)` (see
 * `apps/desktop-app/src/main/observability/service.ts` `toIsoDay`), so we
 * mirror that here. The harness launches with `TZ=UTC` (see
 * `launchCanopy.mjs`), so UTC and local days coincide.
 *
 * @param {string | number | Date} [value] defaults to now
 * @returns {string} `YYYY-MM-DD`
 */
export function isoDay(value = Date.now()) {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString().slice(0, 10);
}
