#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WORK_RATCHET_PROFILE } from './profiles.mjs';
import {
  WORK_METRIC_SOURCES,
  collectedWorkScopes,
  parseWorkMetricKey,
  workMetricScope,
} from './results.mjs';
import { percentile, roundMetric } from './statistics.mjs';

export const WORK_METRIC_REGISTRY_PATH = fileURLToPath(
  new URL('./work-metrics.json', import.meta.url),
);
export const WORK_CEILINGS_PATH = fileURLToPath(
  new URL('./work-ceilings.json', import.meta.url),
);
export const WORK_METRIC_STATUSES = Object.freeze([
  'advisory',
  'gating',
  'evicted',
]);
export const WORK_SCENARIO_VARIANTS = Object.freeze([
  'sequential',
  'concurrent',
]);
export const DEFAULT_WORK_TOLERANCE_PERCENT = 1;

// Methodology R2: five runs explore a counter, ten admit it.
const ADMISSION_RUNS = 10;
// Counts can shift with any of these, so ceilings hold only where they match.
const FINGERPRINT_FIELDS = Object.freeze([
  'benchmarkKind',
  'configSha256',
  'electronVersion',
  'viewport',
  'windowVisible',
]);
const GATING_FAILURES = new Set([
  'exceeded',
  'missing',
  'not-run',
  'incompatible',
]);

function fail(message) {
  throw new Error(message);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function sortedObject(value) {
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, value[key]]),
  );
}

export function workPlatform(environment) {
  return `${environment?.platform ?? 'unknown'}-${environment?.architecture ?? 'unknown'}`;
}

/** What a run's counts depend on besides the code under test. */
export function workRatchetFingerprint(result) {
  return {
    benchmarkKind: result.benchmarkKind,
    configSha256: createHash('sha256')
      .update(canonicalJson(result.config ?? {}))
      .digest('hex'),
    electronVersion: result.environment?.electronVersion,
    viewport: result.environment?.viewport,
    windowVisible: result.environment?.windowVisible,
  };
}

function fingerprintDifferences(recorded, fingerprint) {
  return FINGERPRINT_FIELDS.filter(
    (field) =>
      canonicalJson(recorded[field]) !== canonicalJson(fingerprint[field]),
  );
}

/**
 * The registry (`work-metrics.json`) is the gate policy. A counter gates only
 * in a sequential scenario, after ten-run determinism within its tolerance and
 * at least one correlation proof (methodology R2); concurrent variants report.
 */
export function validateWorkMetricRegistry(registry) {
  if (!isObject(registry) || registry.version !== 1) {
    fail('The work metric registry must be version 1');
  }
  if (!isObject(registry.scenarios) || !isObject(registry.metrics)) {
    fail('The work metric registry needs scenarios and metrics maps');
  }
  for (const [scenario, entry] of Object.entries(registry.scenarios)) {
    if (!WORK_SCENARIO_VARIANTS.includes(entry?.variant)) {
      fail(`${scenario} needs a sequential or concurrent variant`);
    }
  }
  if (!Array.isArray(registry.qualifications)) {
    fail('The work metric registry needs a qualifications list');
  }
  const qualifications = new Map();
  for (const qualification of registry.qualifications) {
    const id = qualification?.id;
    if (typeof id !== 'string' || id.length === 0 || qualifications.has(id)) {
      fail(`Qualification ids must be unique strings: ${id}`);
    }
    if (!Number.isInteger(qualification.runs) || qualification.runs < 2) {
      fail(`Qualification ${id} needs at least two runs`);
    }
    for (const field of ['date', 'platform', 'profile']) {
      if (typeof qualification[field] !== 'string') {
        fail(`Qualification ${id} needs a ${field}`);
      }
    }
    if (
      !Array.isArray(qualification.scenarios) ||
      qualification.scenarios.some((scenario) => typeof scenario !== 'string')
    ) {
      fail(`Qualification ${id} needs its scenario list`);
    }
    qualifications.set(id, qualification);
  }
  for (const [key, entry] of Object.entries(registry.metrics)) {
    const parsed = parseWorkMetricKey(key);
    if (!parsed) fail(`${key} is not a work metric key`);
    const variant = registry.scenarios[parsed.scenario]?.variant;
    if (!variant) {
      fail(
        `${key} belongs to ${parsed.scenario}, which has no declared variant`,
      );
    }
    if (!WORK_METRIC_STATUSES.includes(entry?.status)) {
      fail(`${key} has unknown status ${entry?.status}`);
    }
    if (
      !Number.isFinite(entry.tolerancePercent) ||
      entry.tolerancePercent < 0
    ) {
      fail(`${key} needs a non-negative tolerancePercent`);
    }
    if (
      !Array.isArray(entry.determinism) ||
      !Array.isArray(entry.correlation)
    ) {
      fail(`${key} needs determinism and correlation evidence lists`);
    }
    for (const evidence of entry.determinism) {
      const qualification = qualifications.get(evidence?.qualification);
      if (!qualification) {
        fail(`${key} cites unknown qualification ${evidence?.qualification}`);
      }
      // Evidence holds only for the workload the qualification ran.
      if (!qualification.scenarios.includes(parsed.scenario)) {
        fail(
          `${key} cites qualification ${qualification.id}, which did not run ${parsed.scenario}`,
        );
      }
      for (const field of ['min', 'max', 'median']) {
        if (!Number.isFinite(evidence[field])) {
          fail(`${key} evidence needs a finite ${field}`);
        }
      }
      if (
        evidence.spreadPercent !== null &&
        !(
          Number.isFinite(evidence.spreadPercent) && evidence.spreadPercent >= 0
        )
      ) {
        fail(`${key} evidence needs a non-negative spreadPercent or null`);
      }
    }
    for (const correlation of entry.correlation) {
      if (!isObject(correlation) || typeof correlation.summary !== 'string') {
        fail(`${key} correlation evidence needs a summary`);
      }
    }
    if (entry.status !== 'gating') continue;
    if (variant !== 'sequential') {
      fail(
        `${key} cannot gate: ${parsed.scenario} is a concurrent variant, whose counts only report`,
      );
    }
    const admitted = entry.determinism.some(
      (evidence) =>
        qualifications.get(evidence.qualification).runs >= ADMISSION_RUNS &&
        evidence.spreadPercent !== null &&
        evidence.spreadPercent <= entry.tolerancePercent,
    );
    if (!admitted) {
      fail(`${key} is gating without ten-run determinism within its tolerance`);
    }
    if (entry.correlation.length === 0) {
      fail(`${key} is gating without a correlation proof`);
    }
  }
  return registry;
}

/**
 * Ceilings (`work-ceilings.json`) are per platform, then per scenario. An
 * intentional increase records a one-line reason under the platform's
 * `reasons`, keyed by the full metric key.
 */
export function validateWorkCeilings(ceilings, registry) {
  if (!isObject(ceilings) || ceilings.version !== 1) {
    fail('Work ceilings must be version 1');
  }
  if (ceilings.profile !== WORK_RATCHET_PROFILE) {
    fail(`Work ceilings belong to the ${WORK_RATCHET_PROFILE} profile`);
  }
  if (!isObject(ceilings.platforms)) fail('Work ceilings need a platforms map');
  for (const [platform, entry] of Object.entries(ceilings.platforms)) {
    if (!isObject(entry?.scenarios)) {
      fail(`${platform} ceilings need a scenarios map`);
    }
    for (const field of FINGERPRINT_FIELDS) {
      if (!(field in entry)) fail(`${platform} ceilings need their ${field}`);
    }
    for (const [scenario, values] of Object.entries(entry.scenarios)) {
      if (!isObject(values))
        fail(`${platform} ${scenario} needs a ceiling map`);
      for (const [suffix, ceiling] of Object.entries(values)) {
        const key = `${scenario}.${suffix}`;
        if (parseWorkMetricKey(key)?.scenario !== scenario) {
          fail(`${key} is not a work metric key`);
        }
        if (!registry.metrics[key]) {
          fail(`${key} has a ceiling but no registry entry`);
        }
        if (!Number.isFinite(ceiling)) fail(`${key} needs a finite ceiling`);
      }
    }
    if (entry.reasons === undefined) continue;
    if (!isObject(entry.reasons)) fail(`${platform} reasons must be a map`);
    for (const [key, reason] of Object.entries(entry.reasons)) {
      const scenario = parseWorkMetricKey(key)?.scenario;
      const suffix = scenario ? key.slice(scenario.length + 1) : undefined;
      if (entry.scenarios[scenario]?.[suffix] === undefined) {
        fail(`${platform} has a reason for ${key}, which has no ceiling`);
      }
      if (
        typeof reason !== 'string' ||
        reason.trim().length === 0 ||
        reason.includes('\n')
      ) {
        fail(`${platform} needs a one-line reason for ${key}`);
      }
    }
  }
  return ceilings;
}

export function readWorkRatchetInputs({
  registryPath = WORK_METRIC_REGISTRY_PATH,
  ceilingsPath = WORK_CEILINGS_PATH,
} = {}) {
  const registry = validateWorkMetricRegistry(
    JSON.parse(readFileSync(registryPath, 'utf8')),
  );
  const ceilings = validateWorkCeilings(
    JSON.parse(readFileSync(ceilingsPath, 'utf8')),
    registry,
  );
  return { registry, ceilings };
}

/**
 * `exceeded` and `below` both mean a change beyond the counter's tolerance;
 * noise inside it is `within` or `within-tolerance`.
 */
function ceilingOutcome(value, ceiling, band) {
  if (value > ceiling + band) return 'exceeded';
  if (value > ceiling) return 'within-tolerance';
  return value < ceiling - band ? 'below' : 'within';
}

/**
 * Compares a counters-profile run with the ceilings recorded for its
 * platform. Only `gating` counters can fail the verdict; `advisory` and
 * `evicted` ones are reported. A counter absent from a scenario that collected
 * its source is zero; one whose source was not collected is `missing`.
 */
export function evaluateWorkRatchet(result, { registry, ceilings }) {
  const platform = workPlatform(result.environment);
  const recorded = ceilings.platforms[platform];
  const incompatibilities = [];
  if (result.profile !== ceilings.profile) incompatibilities.push('profile');
  if (recorded) {
    incompatibilities.push(
      ...fingerprintDifferences(recorded, workRatchetFingerprint(result)),
    );
  }
  const scenarios = new Map(
    (result.scenarios ?? []).map((scenario) => [scenario.name, scenario]),
  );
  const entries = [];
  for (const [name, values] of Object.entries(recorded?.scenarios ?? {})) {
    const scenario = scenarios.get(name);
    const collected = collectedWorkScopes(scenario);
    for (const [suffix, ceiling] of Object.entries(values)) {
      const key = `${name}.${suffix}`;
      const policy = registry.metrics[key];
      const band = (Math.abs(ceiling) * policy.tolerancePercent) / 100;
      const allowed = roundMetric(ceiling + band);
      const entry = {
        key,
        status: policy.status,
        ceiling,
        allowed,
        tolerancePercent: policy.tolerancePercent,
      };
      if (incompatibilities.length > 0) entry.outcome = 'incompatible';
      else if (!scenario) entry.outcome = 'not-run';
      else if (
        scenario.status === 'error' ||
        !collected.has(workMetricScope(key))
      ) {
        // A failed workload's counts are incomplete, whatever it recorded,
        // and so are those of a source or task kind that was not collected
        // in full: absence there is not a measured zero.
        entry.outcome = 'missing';
      } else {
        entry.value = result.metrics?.[key]?.value ?? 0;
        entry.outcome = ceilingOutcome(entry.value, ceiling, band);
      }
      entries.push(entry);
    }
  }
  entries.sort((left, right) => left.key.localeCompare(right.key));
  const failures = entries.filter(
    (entry) => entry.status === 'gating' && GATING_FAILURES.has(entry.outcome),
  );
  return {
    profile: result.profile,
    platform,
    ceilingsRecorded: Boolean(recorded),
    passed: failures.length === 0,
    incompatibilities,
    entries,
    failures,
    unregistered: Object.entries(result.metrics ?? {}).filter(
      ([key, metric]) => metric?.kind === 'count' && !registry.metrics[key],
    ).length,
  };
}

/**
 * The verdict a counters-profile run stores with its result. A registry or
 * ceilings file that cannot be read or validated fails the ratchet instead of
 * skipping it.
 */
export function judgeWorkRatchet(result, readInputs = readWorkRatchetInputs) {
  try {
    return evaluateWorkRatchet(result, readInputs());
  } catch (error) {
    return {
      passed: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function scenariosOf(entries) {
  return [...new Set(entries.map((entry) => entry.key.split('.')[0]))];
}

export function formatWorkRatchetVerdict(verdict) {
  if (verdict.error) {
    return [`[perf] Work-counter ratchet: FAIL - ${verdict.error}`];
  }
  const count = (status) =>
    verdict.entries.filter((entry) => entry.status === status).length;
  const lines = [
    `[perf] Work-counter ratchet (${verdict.profile}, ${verdict.platform}): ${verdict.passed ? 'PASS' : 'FAIL'} - ${count('gating')} gating, ${count('advisory')} advisory, ${count('evicted')} evicted ceilings`,
  ];
  if (!verdict.ceilingsRecorded) {
    lines.push(
      `[perf]   no ceilings recorded for ${verdict.platform}; nothing is gated on this platform`,
    );
  }
  if (verdict.incompatibilities.length > 0) {
    lines.push(
      `[perf]   ceilings were recorded with a different ${verdict.incompatibilities.join(', ')}; re-baseline them as a reviewed change`,
    );
  }
  for (const entry of verdict.entries) {
    if (entry.outcome === 'exceeded') {
      lines.push(
        `[perf]   ${entry.status} exceeded: ${entry.key} ${entry.value} > ${entry.ceiling} (allowed ${entry.allowed})`,
      );
    } else if (
      entry.status === 'gating' &&
      GATING_FAILURES.has(entry.outcome)
    ) {
      lines.push(`[perf]   gating ${entry.outcome}: ${entry.key}`);
    }
  }
  const below = verdict.entries.filter((entry) => entry.outcome === 'below');
  if (below.length > 0) {
    lines.push(
      `[perf]   ${below.length} counter(s) below their ceiling by more than their tolerance (first: ${below[0].key} ${below[0].value} < ${below[0].ceiling}); lower them in this change with work-ratchet.mjs qualify --write`,
    );
  }
  for (const outcome of ['missing', 'not-run']) {
    const unjudged = verdict.entries.filter(
      (entry) => entry.outcome === outcome && entry.status !== 'gating',
    );
    if (unjudged.length > 0) {
      lines.push(
        `[perf]   ${outcome}: ${unjudged.length} non-gating ceiling(s) in ${scenariosOf(unjudged).join(', ')}`,
      );
    }
  }
  if (verdict.unregistered > 0) {
    lines.push(
      `[perf]   ${verdict.unregistered} unregistered work counter(s) are reported, never judged`,
    );
  }
  return lines;
}

/**
 * Per-counter determinism over repeated runs of one build: the spread is
 * (max - min) / median. An absent counter is zero in a run that collected its
 * source; a zero median with any variation has no defined spread (`null`).
 */
export function summarizeWorkDeterminism(
  results,
  { scenarios, tolerancePercent = DEFAULT_WORK_TOLERANCE_PERCENT } = {},
) {
  if (!Array.isArray(results) || results.length < 2) {
    fail('Determinism needs at least two runs');
  }
  const [first] = results;
  const platform = workPlatform(first.environment);
  const fingerprint = workRatchetFingerprint(first);
  for (const [index, result] of results.entries()) {
    if (result.profile !== first.profile) {
      fail(`Run ${index + 1} used the ${result.profile} profile`);
    }
    if (workPlatform(result.environment) !== platform) {
      fail(`Run ${index + 1} ran on ${workPlatform(result.environment)}`);
    }
    const differences = fingerprintDifferences(
      fingerprint,
      workRatchetFingerprint(result),
    );
    if (differences.length > 0) {
      fail(`Run ${index + 1} differs in ${differences.join(', ')}`);
    }
  }
  const selected =
    scenarios ??
    (first.scenarios ?? [])
      .filter((scenario) => scenario.work)
      .map((scenario) => scenario.name);
  const rows = [];
  const skipped = [];
  for (const name of selected) {
    const runs = results.map((result) =>
      (result.scenarios ?? []).find((scenario) => scenario.name === name),
    );
    for (const [index, scenario] of runs.entries()) {
      if (!scenario?.work || scenario.status === 'error') {
        fail(`Run ${index + 1}: ${name} did not collect work`);
      }
    }
    for (const source of WORK_METRIC_SOURCES) {
      if (!runs.every((scenario) => scenario.work[source])) {
        skipped.push({ scenario: name, source });
        continue;
      }
      const keys = new Set(
        results.flatMap((result) =>
          Object.keys(result.metrics ?? {}).filter((key) => {
            const parsed = parseWorkMetricKey(key);
            return parsed?.scenario === name && parsed.source === source;
          }),
        ),
      );
      for (const key of keys) {
        const values = results.map((result) => result.metrics[key]?.value ?? 0);
        const min = Math.min(...values);
        const max = Math.max(...values);
        const median = percentile(values, 0.5);
        const spreadPercent =
          max === min
            ? 0
            : median === 0
              ? null
              : roundMetric(((max - min) / Math.abs(median)) * 100);
        rows.push({
          key,
          scenario: name,
          source,
          values,
          min,
          max,
          median,
          spreadPercent,
          deterministic:
            spreadPercent !== null && spreadPercent <= tolerancePercent,
        });
      }
    }
  }
  rows.sort((left, right) => left.key.localeCompare(right.key));
  return {
    runs: results.length,
    profile: first.profile,
    platform,
    fingerprint,
    commits: [...new Set(results.map((result) => result.source?.commit))],
    // Evidence from an uncommitted tree says so, beside the commit it built on.
    dirty: results.some((result) => result.source?.dirty === true),
    scenarios: selected,
    rows,
    skipped,
  };
}

/**
 * Records a qualification's evidence in the registry and seeds or tightens
 * ceilings for its deterministic counters. It never raises a ceiling: an
 * intentional increase is a reviewed manual edit with a one-line reason.
 * New counters start `advisory`. Reapplying a qualification id replaces all
 * of its earlier evidence.
 */
export function applyWorkQualification({
  registry,
  ceilings,
  summary,
  id,
  date,
  note,
}) {
  for (const scenario of summary.scenarios) {
    if (!registry.scenarios?.[scenario]?.variant) {
      fail(
        `Declare ${scenario}'s variant (sequential or concurrent) in the registry before qualifying it`,
      );
    }
  }
  const nextRegistry = structuredClone(registry);
  const nextCeilings = structuredClone(ceilings);
  nextRegistry.qualifications = [
    ...nextRegistry.qualifications.filter((entry) => entry.id !== id),
    {
      id,
      date,
      platform: summary.platform,
      profile: summary.profile,
      runs: summary.runs,
      commits: summary.commits,
      dirty: summary.dirty,
      fingerprint: summary.fingerprint,
      scenarios: summary.scenarios,
      ...(note ? { note } : {}),
    },
  ];
  for (const entry of Object.values(nextRegistry.metrics)) {
    entry.determinism = entry.determinism.filter(
      (evidence) => evidence.qualification !== id,
    );
  }
  const platformEntry = (nextCeilings.platforms[summary.platform] ??= {
    ...summary.fingerprint,
    qualification: id,
    scenarios: {},
  });
  const differences = fingerprintDifferences(
    platformEntry,
    summary.fingerprint,
  );
  if (differences.length > 0) {
    fail(
      `${summary.platform} ceilings were recorded with a different ${differences.join(', ')}; re-baseline them as a reviewed change`,
    );
  }
  platformEntry.qualification = id;
  const notRaised = [];
  for (const row of summary.rows) {
    const entry = (nextRegistry.metrics[row.key] ??= {
      status: 'advisory',
      tolerancePercent: DEFAULT_WORK_TOLERANCE_PERCENT,
      determinism: [],
      correlation: [],
    });
    entry.determinism.push({
      qualification: id,
      min: row.min,
      max: row.max,
      median: row.median,
      spreadPercent: row.spreadPercent,
    });
    if (
      row.spreadPercent === null ||
      row.spreadPercent > entry.tolerancePercent
    ) {
      continue;
    }
    const values = (platformEntry.scenarios[row.scenario] ??= {});
    const suffix = row.key.slice(row.scenario.length + 1);
    if (values[suffix] === undefined || row.max < values[suffix]) {
      values[suffix] = row.max;
    } else if (row.max > values[suffix]) {
      notRaised.push({
        key: row.key,
        ceiling: values[suffix],
        observedMax: row.max,
      });
    }
  }
  nextRegistry.metrics = sortedObject(nextRegistry.metrics);
  platformEntry.scenarios = sortedObject(
    Object.fromEntries(
      Object.entries(platformEntry.scenarios)
        .filter(([, values]) => Object.keys(values).length > 0)
        .map(([scenario, values]) => [scenario, sortedObject(values)]),
    ),
  );
  return { registry: nextRegistry, ceilings: nextCeilings, notRaised };
}

function usage() {
  return `Usage:
  node apps/desktop-app/tests/performance/work-ratchet.mjs verdict <counters-run.json>
  node apps/desktop-app/tests/performance/work-ratchet.mjs qualify [--scenarios <csv>] [--id <id>] [--note <text>] [--write] <run.json> <run.json>...

verdict  re-evaluates a counters-profile artifact against work-ceilings.json.
qualify  prints each work counter's spread across repeated runs of one build;
         --write records the evidence in work-metrics.json (new counters are
         advisory) and seeds or tightens ceilings for deterministic counters.
`;
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

/** The local calendar date the qualification is recorded on. */
function localDate(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function runQualify(argv) {
  const paths = [];
  let scenarios;
  let id;
  let note;
  let write = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--write') write = true;
    else if (arg === '--scenarios') {
      scenarios = (argv[++index] ?? '').split(',').filter(Boolean);
    } else if (arg === '--id') id = argv[++index];
    else if (arg === '--note') note = argv[++index];
    else if (arg.startsWith('--')) fail(`Unknown option: ${arg}`);
    else paths.push(arg);
  }
  const summary = summarizeWorkDeterminism(paths.map(readJson), { scenarios });
  const date = localDate();
  console.log(
    `${summary.runs} runs of ${summary.scenarios.join(', ')} (${summary.profile}, ${summary.platform}, ${summary.commits.join(', ')}${summary.dirty ? ' with uncommitted changes' : ''})`,
  );
  console.log('Counter | min | max | median | spread');
  for (const row of summary.rows) {
    console.log(
      `${row.deterministic ? '' : 'NOT DETERMINISTIC '}${row.key} | ${row.min} | ${row.max} | ${row.median} | ${row.spreadPercent === null ? 'undefined (zero median)' : `${row.spreadPercent}%`}`,
    );
  }
  for (const { scenario, source } of summary.skipped) {
    console.log(`Skipped ${scenario} ${source}: not collected in every run`);
  }
  const deterministic = summary.rows.filter((row) => row.deterministic).length;
  console.log(
    `${deterministic} of ${summary.rows.length} counters within ${DEFAULT_WORK_TOLERANCE_PERCENT}% spread`,
  );
  if (!write) return;
  const qualificationId =
    id ?? `${date}-${summary.platform}-${summary.profile}-x${summary.runs}`;
  const { registry, ceilings } = readWorkRatchetInputs();
  const updated = applyWorkQualification({
    registry,
    ceilings,
    summary,
    id: qualificationId,
    date,
    note,
  });
  validateWorkCeilings(
    updated.ceilings,
    validateWorkMetricRegistry(updated.registry),
  );
  writeJson(WORK_METRIC_REGISTRY_PATH, updated.registry);
  writeJson(WORK_CEILINGS_PATH, updated.ceilings);
  for (const { key, ceiling, observedMax } of updated.notRaised) {
    console.log(
      `Not raised: ${key} ceiling ${ceiling} < observed ${observedMax}; raise it only as a reviewed edit`,
    );
  }
  console.log(
    `Recorded ${qualificationId}; run npm run prettier:dirty:fix before committing`,
  );
}

function main() {
  const [command, ...argv] = process.argv.slice(2);
  try {
    if (command === 'verdict' && argv.length === 1) {
      const verdict = evaluateWorkRatchet(
        readJson(argv[0]),
        readWorkRatchetInputs(),
      );
      for (const line of formatWorkRatchetVerdict(verdict)) console.log(line);
      if (!verdict.passed) process.exitCode = 1;
    } else if (command === 'qualify') {
      runQualify(argv);
    } else {
      console.log(usage());
      if (command !== '--help') process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage());
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
