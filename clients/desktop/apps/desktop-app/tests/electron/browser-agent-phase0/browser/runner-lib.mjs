// S0.3 probe runner helpers: argument parsing, the child environment, and the
// console summary. Pure; unit tested. Used by ../browser-probe.mjs.

export const PINNED_ELECTRON = '42.3.0';

/** The documented, boundary-clean entry wrapper recorded in every report. */
export const PROBE_ENTRY =
  'scripts/probes/browser-agent-phase0/browser-probe.mjs';

export const DEFAULTS = Object.freeze({
  outDir: '.playwright/browser-agent-phase0',
  deadlineMs: 900_000,
  caseTimeoutMs: 12_000,
  settleMs: 400,
  killGraceMs: 30_000,
});

const BOUNDS = Object.freeze({
  deadlineMs: [60_000, 1_800_000],
  caseTimeoutMs: [2_000, 60_000],
  settleMs: [0, 5_000],
});

/**
 * @param {string[]} argv
 * @returns {{ prepareOnly: boolean, outDir: string, deadlineMs: number, caseTimeoutMs: number, settleMs: number }}
 */
export function parseProbeArgs(argv) {
  const options = { prepareOnly: false, ...DEFAULTS };
  for (const arg of argv) {
    if (arg === '--prepare-only') {
      options.prepareOnly = true;
      continue;
    }
    const match =
      /^--(out-dir|deadline-ms|case-timeout-ms|settle-ms)=(.+)$/.exec(arg);
    if (!match) throw new Error(`Unknown argument: ${arg}`);
    const [, name, value] = match;
    if (name === 'out-dir') {
      if (!value.startsWith('.playwright/'))
        throw new Error(
          '--out-dir must stay under .playwright/ (not committed).',
        );
      if (value.split('/').includes('..'))
        throw new Error('--out-dir must not contain "..".');
      options.outDir = value;
      continue;
    }
    const key = name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const number = Number(value);
    const [min, max] = BOUNDS[key];
    if (!Number.isInteger(number) || number < min || number > max) {
      throw new Error(`--${name} must be an integer from ${min} to ${max}.`);
    }
    options[key] = number;
  }
  return options;
}

/**
 * A minimal environment for the probe's Electron child. Proxy, Electron
 * override, Node option, and credential-bearing variables from the parent
 * never pass through; HOME and TMPDIR point into the disposable work dir.
 *
 * @param {Record<string, string|undefined>} parentEnv
 * @param {{ workDir: string, home: string, tmp: string, config: object }} input
 */
export function buildChildEnv(parentEnv, { home, tmp, config }) {
  const env = {
    PATH: parentEnv.PATH ?? '/usr/bin:/bin',
    HOME: home,
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    LANG: 'en_US.UTF-8',
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    S03_PROBE_CONFIG: JSON.stringify(config),
  };
  if (parentEnv.SYSTEMROOT) env.SYSTEMROOT = parentEnv.SYSTEMROOT;
  return env;
}

/** Counts case statuses and lists refusals per binding for the console. */
export function summarizeReport(report) {
  const lines = [];
  const summary = report?.summary;
  if (!summary) return ['No probe summary: see the report errors.'];
  lines.push(
    `outcome=${report.outcome} qualified=${summary.qualified} productionCompositionQualified=${summary.productionCompositionQualified}`,
  );
  for (const [binding, verdict] of Object.entries(summary.bindings ?? {})) {
    const counts = {};
    for (const entry of Object.values(verdict.vectors))
      counts[entry.status] = (counts[entry.status] ?? 0) + 1;
    lines.push(
      `${binding}: qualified=${verdict.qualified} vectors=${JSON.stringify(counts)}`,
    );
    for (const refusal of verdict.mustRefuse)
      lines.push(`  refuse ${refusal.vector} (${refusal.status})`);
  }
  if (report.lab) {
    const labCounts = {};
    for (const entry of report.lab.cases ?? [])
      labCounts[entry.status] = (labCounts[entry.status] ?? 0) + 1;
    lines.push(
      `browser-lab: ${JSON.stringify(labCounts)} attacks=${JSON.stringify((report.lab.attacks ?? []).map((a) => `${a.id}:${a.status}`))}`,
    );
  }
  for (const reason of summary.reasons ?? []) lines.push(`reason: ${reason}`);
  return lines;
}
