import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  PERFORMANCE_PROFILES,
  SCENARIO_NAMES,
  performanceUsage,
} from './profiles.mjs';

const runbook = readFileSync(
  new URL('../../../../docs/desktop-app-performance.md', import.meta.url),
  'utf8',
);
const localReadme = readFileSync(
  new URL('./README.md', import.meta.url),
  'utf8',
);

test('the canonical runbook documents every runner option and workload', () => {
  const options = [...performanceUsage().matchAll(/^\s+(--[a-z-]+)/gm)].map(
    (match) => match[1],
  );
  for (const option of options) {
    assert.ok(runbook.includes(`\`${option}`), `missing option ${option}`);
  }
  for (const profile of Object.keys(PERFORMANCE_PROFILES)) {
    assert.ok(runbook.includes(`\`${profile}\``), `missing profile ${profile}`);
  }
  for (const scenario of SCENARIO_NAMES) {
    assert.ok(
      runbook.includes(`\`${scenario}\``),
      `missing scenario ${scenario}`,
    );
  }
});

test('the canonical runbook documents comparison controls and artifacts', () => {
  for (const option of [
    '--max-regression-percent',
    '--min-regression-ms',
    '--no-diagnostics',
  ]) {
    assert.ok(runbook.includes(`\`${option}\``), `missing option ${option}`);
  }
  for (const artifact of [
    'triage.md',
    'hotspots.json',
    'renderer.cpuprofile',
    'main.cpuprofile',
    'electron-trace.json',
  ]) {
    assert.ok(
      runbook.includes(`\`${artifact}\``),
      `missing artifact ${artifact}`,
    );
  }
  for (const field of [
    'schemaVersion',
    'benchmarkKind',
    'config',
    'environment',
    'scenarios',
    'metrics',
    'monitoring.raw',
    'monitoring.summary',
    'scenarios[].diagnostics',
  ]) {
    assert.ok(runbook.includes(`\`${field}\``), `missing field ${field}`);
  }
});

test('the canonical runbook documents work counters and the local ratchet', () => {
  for (const term of [
    "kind: 'count'",
    "kind: 'time'",
    'Performance.getMetrics',
    'work-metrics.json',
    'work-ceilings.json',
    'work-ratchet.mjs',
    'workComparisons',
    'workUnavailable',
    'workRatchet',
    'scenarios[].work',
    'tasks[].work',
    'ipc',
    'chatStorage',
    'provider',
    'react',
    'disk',
    'disk-io.mjs',
    'proc_pid_rusage',
    'Win32_Process',
    'globalThis.__CANOPY_WORK_COUNTERS__',
    'window.__CANOPY_REACT_WORK__',
    'sendToWebContents',
  ]) {
    assert.ok(runbook.includes(`\`${term}`), `missing ${term}`);
  }
  for (const status of ['advisory', 'gating', 'evicted']) {
    assert.ok(runbook.includes(`\`${status}\``), `missing status ${status}`);
  }
  assert.match(localReadme, /work-ratchet\.mjs/);
});

test('the canonical runbook says only the counters profile estimates IPC bytes', () => {
  const flat = runbook.replace(/\s+/g, ' ');
  assert.match(
    flat,
    /the harness asks only under the `counters` profile/,
    'IPC byte estimation is limited to the counters profile',
  );
  assert.match(flat, /asking for IPC byte estimates only if the run needs/);
});

test('the suite-local README points contributors to the canonical runbook', () => {
  assert.match(localReadme, /docs\/desktop-app-performance\.md/);
  assert.match(localReadme, /canonical runbook/i);
});
