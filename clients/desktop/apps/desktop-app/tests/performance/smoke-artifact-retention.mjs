import { readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const SMOKE_JSON_PATTERN =
  /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-smoke)\.json$/;
const SMOKE_DIAGNOSTICS_PATTERN =
  /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-smoke)-diagnostics$/;

export function pruneSmokeDiagnosticArtifacts(outputDir, { keep = 2 } = {}) {
  if (!Number.isSafeInteger(keep) || keep < 0) {
    throw new Error(
      'Smoke diagnostic retention must be a non-negative integer.',
    );
  }

  const jsonBasenames = new Set();
  const diagnosticBasenames = new Set();
  for (const entry of readdirSync(outputDir, { withFileTypes: true })) {
    const match = entry.isFile()
      ? entry.name.match(SMOKE_JSON_PATTERN)
      : entry.isDirectory()
        ? entry.name.match(SMOKE_DIAGNOSTICS_PATTERN)
        : null;
    if (!match) continue;
    if (entry.isFile()) jsonBasenames.add(match[1]);
    if (entry.isDirectory()) diagnosticBasenames.add(match[1]);
  }

  const retained = new Set([...jsonBasenames].sort().reverse().slice(0, keep));
  const removed = [...new Set([...jsonBasenames, ...diagnosticBasenames])]
    .filter((basename) => !retained.has(basename))
    .sort();
  for (const basename of removed) {
    rmSync(path.join(outputDir, `${basename}.json`), { force: true });
    rmSync(path.join(outputDir, `${basename}-diagnostics`), {
      recursive: true,
      force: true,
    });
  }
  return removed;
}
