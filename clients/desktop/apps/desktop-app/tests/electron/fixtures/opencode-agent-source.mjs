import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

/**
 * Read a fixture agent for installation as the downloaded `opencode` binary.
 * The copy runs from a temp directory, so its repo-relative imports must
 * resolve against the original file.
 */
export async function readOpenCodeAgentSource(file) {
  const url = pathToFileURL(file);
  const source = (await readFile(file, 'utf8')).replace(
    /from '(\.{1,2}\/[^']+)'/g,
    (_, specifier) => `from ${JSON.stringify(new URL(specifier, url).href)}`,
  );
  // Only single-quoted static imports are rewritten; fail before launch otherwise.
  if (/\b(?:from|import)\s*\(?\s*['"`]\.{1,2}\//.test(source))
    throw new Error(
      `${file} has a relative import the fixture cannot resolve.`,
    );
  return source;
}
