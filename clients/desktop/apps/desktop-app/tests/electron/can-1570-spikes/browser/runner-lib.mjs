// CAN-1570 runner helpers: arguments, disposable child environment, summary.

import path from 'node:path';

export const PINNED_ELECTRON = '42.3.0';

/** The documented, boundary-clean entry wrapper recorded in every report. */
export const PROBE_ENTRY = 'scripts/probes/can-1570-spikes/spike-probe.mjs';

export const DEFAULTS = Object.freeze({
  outDir: '.playwright/can-1570-spikes',
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
  const options = {
    prepareOnly: false,
    measureCost: false,
    labHeavy: false,
    costSamples: 20,
    externalPageUrl: null,
    ...DEFAULTS,
  };
  for (const arg of argv) {
    if (arg === '--measure-cost') {
      options.measureCost = true;
      continue;
    }
    if (arg === '--measure-cost-on-lab-heavy') {
      options.measureCost = true;
      options.labHeavy = true;
      continue;
    }
    if (arg.startsWith('--external-page-url=')) {
      const url = new URL(arg.slice(20));
      if (
        url.protocol !== 'http:' ||
        !['127.0.0.1', 'localhost'].includes(url.hostname) ||
        url.username ||
        url.password
      )
        throw new Error(
          'External fixture URL must be credential-free loopback http',
        );
      options.externalPageUrl = url.href;
      continue;
    }
    if (arg.startsWith('--cost-samples=')) {
      const n = Number(arg.slice(15));
      if (!Number.isInteger(n) || n < 2 || n > 200)
        throw new Error('cost samples must be 2..200');
      options.costSamples = n;
      continue;
    }
    if (arg === '--prepare-only') {
      options.prepareOnly = true;
      continue;
    }
    const match =
      /^--(out-dir|deadline-ms|case-timeout-ms|settle-ms)=(.+)$/.exec(arg);
    if (!match) throw new Error(`Unknown argument: ${arg}`);
    const [, name, value] = match;
    if (name === 'out-dir') {
      if (value.split('/').includes('..'))
        throw new Error('--out-dir must not contain "..".');
      const artifactRoot = '.playwright/can-1570-spikes';
      const normalized = path.posix.relative(
        '/repo',
        path.posix.resolve('/repo', value),
      );
      if (
        value.includes('\\') ||
        path.posix.isAbsolute(value) ||
        (normalized !== artifactRoot &&
          !normalized.startsWith(`${artifactRoot}/`))
      )
        throw new Error(
          '--out-dir must stay under .playwright/can-1570-spikes/ (not committed).',
        );
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
  if (options.labHeavy && options.externalPageUrl)
    throw new Error(
      '--measure-cost-on-lab-heavy serves its own page; omit --external-page-url',
    );
  if (options.measureCost && !options.labHeavy && !options.externalPageUrl)
    throw new Error('--measure-cost requires --external-page-url=loopbackURL');
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
    CAN1570_PROBE_CONFIG: JSON.stringify(config),
  };
  if (parentEnv.SYSTEMROOT) env.SYSTEMROOT = parentEnv.SYSTEMROOT;
  return env;
}

export function summarizeReport(report) {
  return [
    `outcome=${report.outcome}`,
    ...Object.entries(report.spikes ?? {}).map(
      ([key, value]) => `${key}: ${value.status ?? 'recorded'}`,
    ),
    ...(report.errors ?? []),
  ];
}
