const MAX_SUMMARY_CHARS = 300;
/** Errors print near the end; looking further back finds unrelated noise. */
const SCAN_LINES = 40;
// CSI sequences (colors, cursor moves) that terminal-runtime output carries.
// eslint-disable-next-line no-control-regex
const ANSI_CSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
// GitHub Actions workflow command, e.g. `::error title=Setup::message`.
const ERROR_COMMAND = /^::error(?:\s[^:]*)?::(.+)$/;
const ERROR_WORD = /error|fatal|failed/i;
// A tally such as `Found 0 errors.` or `0 failed, 2 passed` reports success.
const NO_ERRORS = /\b(?:0|no)\s+(?:errors?|failed|failures?)\b/i;
const NOISE = [
  /^at\s/, // stack frame
  /^\^+$/, // caret under a source line
  /ELIFECYCLE/, // pnpm's "Command failed with exit code N"
  /^Node\.js v\d/,
];

function cleanLine(line: string): string {
  // A progress redraw overwrites the line; keep what was drawn last.
  return (line.split('\r').pop() ?? '').replace(ANSI_CSI, '').trim();
}

function shorten(text: string): string {
  return text.length <= MAX_SUMMARY_CHARS
    ? text
    : `${text.slice(0, MAX_SUMMARY_CHARS - 1).trimEnd()}…`;
}

/**
 * The one output line that best says why a script failed: its last
 * `::error::` line, else the last line near the end that reads like an error,
 * else null. Scripts own their wording, so `::error::` is the reliable path.
 */
export function summarizeScriptFailure(
  outputLines: readonly string[],
): string | null {
  const lines = outputLines.map(cleanLine);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const message = ERROR_COMMAND.exec(lines[index] ?? '')?.[1]?.trim();
    if (message) return shorten(message);
  }
  for (
    let index = lines.length - 1;
    index >= Math.max(0, lines.length - SCAN_LINES);
    index -= 1
  ) {
    const line = lines[index] ?? '';
    if (line === '' || NOISE.some((pattern) => pattern.test(line))) continue;
    if (ERROR_WORD.test(line) && !NO_ERRORS.test(line)) return shorten(line);
  }
  return null;
}
