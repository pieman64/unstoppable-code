// Shared constants for the browser-agent Phase 0 provider probes (S0.1/S0.2).
// Planning-only evidence tooling; nothing here is a production contract.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SHARED_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Repository root, found by walking up to the workspace root manifest, so
 * the provider tree can be relocated without editing path depths.
 */
function findRepoRoot(start) {
  let current = start;
  while (true) {
    const manifest = path.join(current, 'package.json');
    if (existsSync(manifest)) {
      try {
        const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
        if (
          pkg.name === 'canopy' &&
          existsSync(path.join(current, 'pnpm-workspace.yaml'))
        )
          return current;
      } catch {
        // Keep walking.
      }
    }
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`No workspace root above ${start}`);
    current = parent;
  }
}

export const REPO_ROOT = findRepoRoot(SHARED_DIR);

/** Directory containing `provider/` (and the orchestrator in the original layout). */
export const PROBE_DIR = path.resolve(SHARED_DIR, '../..');

/** Pins the probe is written against (05 §5 Phase 0, 06 §1). */
export const EXPECTED_PINS = Object.freeze({
  codexCli: '0.159.0',
  claudeCli: '2.1.284',
  claudeAgentSdk: '0.3.284',
});

/** Default artifact directory; one timestamped subdirectory per run. */
export const DEFAULT_OUTPUT_ROOT = path.resolve(
  REPO_ROOT,
  '.playwright/browser-agent-phase0/provider',
);

/** Hard per-provider child deadline (ms). The child also has its own. */
export const DEFAULT_CHILD_DEADLINE_MS = 240_000;
/** Grace between SIGTERM and SIGKILL of a probe process group. */
export const KILL_GRACE_MS = 5_000;

/** Exit codes shared by the orchestrator and provider children. */
export const EXIT = Object.freeze({
  /** Probe ran; report written; no requirement failed. */
  ok: 0,
  /** Probe crashed or could not write a report. */
  crash: 1,
  /** Probe ran; report written; at least one requirement failed. */
  requirementFailed: 2,
  /** A canonical-state precondition failed before any turn; nothing sent. */
  preconditionFailed: 3,
});

/** Environment names the orchestrator passes to a provider child. */
export const CHILD_ENV = Object.freeze({
  manifest: 'BROWSER_AGENT_PROBE_MANIFEST',
  output: 'BROWSER_AGENT_PROBE_OUTPUT',
  deadlineMs: 'BROWSER_AGENT_PROBE_DEADLINE_MS',
});
