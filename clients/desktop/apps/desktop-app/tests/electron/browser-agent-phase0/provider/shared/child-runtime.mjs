// Helpers used inside a provider child (`provider/<name>/run.mjs`).
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CHILD_ENV, EXIT } from './constants.mjs';
import { attachLayoutHelpers, isInside } from './synthetic-root.mjs';

/**
 * Manifest written by the orchestrator.
 *
 * @typedef {object} ChildManifest
 * @property {'codex' | 'claude'} provider
 * @property {import('./synthetic-root.mjs').SyntheticLayout} layout
 * @property {Record<string, string>} canaries  CANARY_CATALOG id -> token
 * @property {string} hostFile   absolute path of the planted host-file canary
 * @property {string} startedAt
 */

/**
 * Load the manifest and verify the child really runs against the synthetic
 * root. Throws before any provider work if not.
 */
export function loadChildContext(expectedProvider) {
  const manifestPath = process.env[CHILD_ENV.manifest];
  const outputDir = process.env[CHILD_ENV.output];
  const deadlineMs = Number(process.env[CHILD_ENV.deadlineMs] ?? '0');
  if (!manifestPath || !outputDir || !(deadlineMs > 0))
    throw new Error(
      'Run through provider-probe.mjs; manifest, output and deadline are required.',
    );
  /** @type {ChildManifest} */
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.provider !== expectedProvider)
    throw new Error(
      `Manifest is for ${manifest.provider}, not ${expectedProvider}`,
    );
  const layout = attachLayoutHelpers(manifest.layout);
  const problems = [];
  if (process.env.HOME !== layout.home) problems.push('HOME');
  if (process.env.CODEX_HOME !== layout.codexHome) problems.push('CODEX_HOME');
  if (process.env.CLAUDE_CONFIG_DIR !== layout.claudeConfigDir)
    problems.push('CLAUDE_CONFIG_DIR');
  if (!isInside(layout.root, process.env.TMPDIR ?? '')) problems.push('TMPDIR');
  if (problems.length)
    throw new Error(
      `Child environment is not synthetic: ${problems.join(', ')}`,
    );
  return {
    manifest,
    layout,
    outputDir,
    deadlineMs,
    canaries: manifest.canaries,
  };
}

/**
 * Arm the child's own hard deadline (slightly shorter than the orchestrator's).
 * `onTimeout` should best-effort write a partial report and release resources;
 * the process exits with EXIT.crash regardless after `graceMs`.
 */
export function armChildDeadline(deadlineMs, onTimeout, graceMs = 10_000) {
  const timer = setTimeout(
    () => {
      const hard = setTimeout(() => process.exit(EXIT.crash), graceMs);
      hard.unref();
      Promise.resolve()
        .then(onTimeout)
        .catch(() => {})
        .finally(() => process.exit(EXIT.crash));
    },
    Math.max(1_000, deadlineMs - 15_000),
  );
  timer.unref();
  return () => clearTimeout(timer);
}

/** Write a JSON artifact under the child output directory. */
export async function writeArtifact(outputDir, name, value) {
  if (!/^[a-z0-9][a-z0-9._-]{0,80}\.json$/.test(name))
    throw new Error(`Invalid artifact name ${name}`);
  await mkdir(outputDir, { recursive: true });
  const file = path.join(outputDir, name);
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

/** Active Node handles at shutdown (sockets, timers, child processes). */
export function activeResourceSummary() {
  const counts = {};
  for (const kind of process.getActiveResourcesInfo())
    counts[kind] = (counts[kind] ?? 0) + 1;
  return counts;
}

/**
 * Standard report shape every provider child writes as `report.json`.
 *
 * @param {object} fields
 * @param {'codex'|'claude'} fields.provider
 * @param {ReturnType<import('./ledger.mjs').createLedger>['finalize'] extends (...a: any) => infer R ? R : never} fields.ledger
 * @param {number[]} fields.listenPorts loopback ports this child listened on
 * @param {object} fields.identity pins, binary paths, PIDs, thread/session ids
 * @param {object} fields.s02 timing, overhead, growth and token records
 * @param {string[]} fields.artifacts artifact file names written
 * @param {string[]} fields.notes free-form limitations
 */
export function buildReport(fields) {
  return {
    schema: 'browser-agent-phase0-provider-report/v1',
    finishedAt: new Date().toISOString(),
    ...fields,
    activeResourcesAtExit: activeResourceSummary(),
  };
}
