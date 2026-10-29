import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import {
  readFile,
  mkdir,
  mkdtemp,
  writeFile,
  rm,
  symlink,
  realpath,
  readdir,
  copyFile,
  open,
} from 'node:fs/promises';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { COPILOT_MOCK_BASELINES } from './copilot-mock-baselines.mjs';
import {
  parseE2EOptions,
  e2eChildEnvironment,
  withLocalE2ELease,
  e2eCommand,
  prepareE2EPaths,
  withLocalRunnerConfig,
  LOCAL_RUNNER_CONFIG,
  BASELINE_NATIVE_UI_OVERLAY,
  buildExactSourceOverlay,
  withExactSourceOverlay,
  assertCandidateNativeUiObservation,
  assertMockEndpointUnserved,
  assertMockStartupOwnership,
  observeMockCommandOutput,
  completeMockCommandCleanup,
  verifiedMockCleanupGroups,
  observeOwnedMockServer,
  assertObservedMockGroupsGone,
  withE2EInterruption,
  persistE2EFinalization,
  comparableBuildConfig,
  assertMatchedBuildInputs,
  matchedHarnessSource,
  assertAllowedHarnessOverlay,
  nativeUiCounts,
  dependencyManifest,
  compareDependencyManifests,
  harnessFiles,
  aggregatePopulation,
  assertMatchedPopulations,
  metricPolicies,
  runtimeOverlay,
  schedule,
  THRESHOLDS,
  validateRun,
} from './browser-profiles-e2e-ci.mjs';
import { applyDevScriptSafetyWithWait } from '../../../../scripts/lib/dev-script-safety.mjs';
import {
  requireLocalPhysicalMac,
  assertReleaseStageIdentity,
  BASELINE_SHA,
  runCommandProcess,
} from './browser-profiles-release-ci.mjs';
import { parsePerformanceArgs } from './profiles.mjs';
import { comparePerformanceResults } from './comparison.mjs';
import { prepareAllBrands } from '../../../../scripts/brand/prepare-brand.mjs';

prepareAllBrands({ currentBrand: 'canopy', log: false });

function admittedWindow() {
  return {
    id: 1,
    webContentsId: 2,
    rendererPid: 3,
    ownerMatches: true,
    destroyed: false,
    minimized: false,
    visible: false,
    focused: false,
    url: 'file:///app/index.html',
    nativeUrl: 'file:///app/index.html',
    documentVisible: true,
    documentFocused: false,
    viewport: { width: 1400, height: 900 },
    contentBounds: { width: 1400, height: 900 },
    bounds: { x: 0, y: 0, width: 1000, height: 665 },
    display: { workArea: { x: 0, y: 0, width: 1024, height: 700 } },
  };
}
function row(pair = 0, value = 100, stage = 'baseline') {
  const identity = {
    commit: stage,
    executable: `/${stage}/electron`,
    electronVersion: '42.3.0',
    bundleHash: stage,
    harnessHash: 'identical',
    dependencyHash: 'identical',
  };
  const attempt = {
    pair,
    phase: 'measured',
    stage,
    profile: 'baseline',
    status: 'ok',
    code: 0,
    reportPath: `${stage}-${pair}.json`,
  };
  const raw = {
    schemaVersion: 2,
    suite: 'desktop-app-performance',
    benchmarkKind: 'e2e-relative',
    profile: 'baseline',
    config: parsePerformanceArgs([
      '--profile',
      'baseline',
      '--scenarios',
      'browser-panels',
    ]).config,
    requestedScenarios: ['browser-panels'],
    source: { commit: stage },
    environment: {
      electronVersion: '42.3.0',
      windowVisible: false,
      viewport: { width: 1400, height: 900 },
      studyViewportPreset: 'hidden-native-1400x900-v1',
      studyWindowMode: 'hidden-native-1400x900-v1',
    },
    metrics: {
      'browser-panels.wall_ms': {
        value,
        unit: 'ms',
        direction: 'lower',
        description: 'Wall time',
        minRegressionAbsolute: 20,
      },
    },
    scenarios: [
      {
        name: 'browser-panels',
        status: 'ok',
        tasks: Array.from({ length: 12 }, () => ({
          status: 'ok',
          durationMs: 1,
        })),
        windowEvidence: {
          mode: 'hidden-native-1400x900-v1',
          windowVisible: false,
          viewport: { width: 1400, height: 900 },
          setup: {
            status: 'ready',
            before: admittedWindow(),
            after: admittedWindow(),
          },
          atStart: admittedWindow(),
          atEnd: admittedWindow(),
        },
        counters: {
          panelsCreated: 2,
          lifecycleCycles: 2,
          seededHistoricalPartitions: 270,
          runtime: {
            electron: '42.3.0',
            chrome: '144',
            node: '24',
            executable: identity.executable,
          },
        },
        monitoring: {
          raw: {
            ipcSamples: [{}],
            resourceSamples: [{}],
            renderer: {
              frames: [{}],
              taskEvents: Array(24).fill({}),
              longTaskObserverAvailable: true,
              longTasks: [],
            },
          },
          summary: Object.fromEntries(
            [
              'ipcOuterMs',
              'rendererFrameDelayMs',
              'totalWorkingSetMb',
              'totalCpuPercent',
            ].map((key) => [key, { count: 1, max: 1 }]),
          ),
        },
        responsiveness: { passed: true },
      },
    ],
  };
  return { identity, attempt, raw };
}
const population = (stage = 'baseline') =>
  [100, 200, 300, 400, 500].map((value, pair) => row(pair, value, stage));

test('schedule retains smoke, separate excluded warmups, and five alternating AB/BA pairs', () => {
  const plan = schedule();
  assert.equal(plan.length, 13);
  assert.deepEqual(plan[0], {
    stage: 'candidate',
    profile: 'smoke',
    phase: 'smoke',
    pair: -2,
  });
  assert.equal(plan.filter((run) => run.phase === 'warmup').length, 2);
  assert.deepEqual(
    plan.slice(3).map((run) => run.stage),
    [
      'baseline',
      'candidate',
      'candidate',
      'baseline',
      'baseline',
      'candidate',
      'candidate',
      'baseline',
      'baseline',
      'candidate',
    ],
  );
});
test('aggregate uses all five values with canonical interpolation and original policies', () => {
  const rows = population(),
    original = structuredClone(rows);
  const median = aggregatePopulation(rows, 'median'),
    p95 = aggregatePopulation(rows, 'p95');
  assert.equal(median.metrics['browser-panels.wall_ms'].value, 300);
  assert.equal(p95.metrics['browser-panels.wall_ms'].value, 480);
  assert.deepEqual(
    metricPolicies(median.metrics),
    metricPolicies(rows[0].raw.metrics),
  );
  assert.equal(p95.aggregation.count, 5);
  assert.deepEqual(rows, original);
});
test('failed primary command or scenario never becomes successful through diagnostics', () => {
  for (const mutate of [
    (r) => {
      r.attempt.code = 1;
    },
    (r) => {
      r.raw.scenarios[0].status = 'unresponsive';
      r.raw.scenarios[0].diagnostics = { status: 'ok' };
    },
    (r) => {
      r.raw.scenarios[0].monitoring.summary.ipcOuterMs.max = 1000;
    },
  ]) {
    const r = row();
    mutate(r);
    assert.throws(() => validateRun(r.raw, r.attempt, r.identity));
  }
});
test('incomplete, duplicated, warmup, missing metrics and changed policies/identities fail closed', () => {
  assert.throws(() => aggregatePopulation(population().slice(0, 4), 'median'));
  for (const mutate of [
    (rows) => {
      rows[4].attempt.pair = 0;
    },
    (rows) => {
      rows[4].attempt.status = 'failed';
    },
    (rows) => {
      rows[4].attempt.phase = 'warmup';
    },
    (rows) => {
      rows[4].raw.metrics = {};
    },
    (rows) => {
      rows[4].raw.metrics.extra = { value: 1, unit: 'ms', direction: 'lower' };
    },
    (rows) => {
      rows[4].raw.metrics['browser-panels.wall_ms'].unit = 'mb';
    },
    (rows) => {
      rows[4].raw.metrics['browser-panels.wall_ms'].minRegressionAbsolute = 100;
    },
    (rows) => {
      rows[4].identity.bundleHash = 'changed';
    },
    (rows) => {
      delete rows[4].raw.scenarios[0].counters.runtime.chrome;
    },
    (rows) => {
      rows[4].raw.scenarios[0].monitoring.raw.resourceSamples = [];
    },
    (rows) => {
      rows[4].raw.config.browserHistoricalPartitions = 16;
    },
    (rows) => {
      rows[4].raw.source.commit = 'other';
    },
    (rows) => {
      rows[4].raw.scenarios[0].counters.runtime.executable = '/other/electron';
    },
  ]) {
    const rows = population();
    mutate(rows);
    assert.throws(() => aggregatePopulation(rows, 'p95'));
  }
  for (const value of [NaN, Infinity, null, undefined]) {
    const rows = population();
    rows[4].raw.metrics['browser-panels.wall_ms'].value = value;
    assert.throws(() => aggregatePopulation(rows, 'median'));
  }
});
test('cross-stage runtime and keyset equality are required even when individually complete', () => {
  const before = aggregatePopulation(population(), 'median'),
    after = aggregatePopulation(population('candidate'), 'median');
  assert.doesNotThrow(() => assertMatchedPopulations(before, after));
  after.scenarios[0].counters.runtime.chrome = 'changed';
  assert.throws(() => assertMatchedPopulations(before, after));
});
test('canonical comparator preserves 10 percent gate, 20ms floor, and zero baseline policy', () => {
  const before = aggregatePopulation(population(), 'median'),
    after = structuredClone(before),
    key = 'browser-panels.wall_ms';
  assert.deepEqual(THRESHOLDS, {
    maxRegressionPercent: 10,
    minRegressionMs: 20,
  });
  after.metrics[key].value = 330;
  assert(comparePerformanceResults(before, after, THRESHOLDS).passed);
  after.metrics[key].value = 331;
  assert(!comparePerformanceResults(before, after, THRESHOLDS).passed);
  before.metrics[key].value = 0;
  after.metrics[key].value = 20;
  assert(comparePerformanceResults(before, after, THRESHOLDS).passed);
  after.metrics[key].value = 21;
  assert(!comparePerformanceResults(before, after, THRESHOLDS).passed);
});
test('runtime overlay is additive, single-use, and rejects ambiguous anchors', () => {
  const source = 'return {\n    panelsCreated: bindings.length,\n};';
  const changed = runtimeOverlay(source);
  assert(changed.includes('process.versions.electron'));
  assert(changed.includes('    panelsCreated: bindings.length,'));
  assert.throws(() => runtimeOverlay(changed));
  assert.throws(() => runtimeOverlay('no anchor'));
  assert.throws(() => runtimeOverlay(source + source));
});
test('workflow/template remain byte-identical and constrained to one hosted job', async () => {
  const root = new URL('../../../../', import.meta.url);
  const workflow = await readFile(
    new URL('.github/workflows/browser-profile-e2e-performance.yml', root),
    'utf8',
  );
  assert.equal(
    workflow,
    await readFile(
      new URL(
        'docs/planning/2026-09-09-browser-profiles/spikes/browser-profile-e2e-performance.workflow.yml',
        root,
      ),
      'utf8',
    ),
  );
  assert(
    workflow.includes("runs-on: ${{ vars.MACOS_HOSTED_LABEL || 'macos-26' }}"),
  );
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /if: always\(\)/);
  assert.match(workflow, /node-version: 24\.15\.0/);
  assert.match(workflow, /contents: read/);
  assert.equal(workflow.match(/runs-on:/g).length, 1);
});

// Exact gzip-compressed original bytes for every changed immutable harness source
// in baseline 50ad63d648b27f867aa248cf3e8517aac0b4308d. This bounded fixture
// keeps the admission contract executable in shallow checkouts.
const FROZEN_CHANGED_HARNESS_BASELINES_GZIP_BASE64 = [
  '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',
].join('');
const FROZEN_CHANGED_HARNESS_BASELINES = JSON.parse(
  gunzipSync(
    Buffer.from(FROZEN_CHANGED_HARNESS_BASELINES_GZIP_BASE64, 'base64'),
  ).toString('utf8'),
);
Object.assign(
  FROZEN_CHANGED_HARNESS_BASELINES,
  JSON.parse(
    gunzipSync(
      Buffer.from(
        [
          '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',
          '/w88nuPcj1wCAA==',
        ].join(''),
        'base64',
      ),
    ).toString('utf8'),
  ),
);
// REG-3033 lets the curated plugin seeder take plugin definitions, so a spec
// can seed a plugin that folds into an integration card. The study's original
// seeder bytes stay here so the closed study identity is still provable.
Object.assign(
  FROZEN_CHANGED_HARNESS_BASELINES,
  JSON.parse(
    gunzipSync(
      Buffer.from(
        [
          'H4sIAAAAAAACE91b/XIjuXF/lb51yiTvyOGeYl8SnnVnnaS15ZO0KlHr1GW1tQPNNMk5DQcTAJREy6rKX3mAVJ7QT5LqxsdghtTH',
          '7jl/JC5XnTgAGkB//rrRe/9K1LUe56ivjaxHoq7HBrXRYywxM0pWY42Yo9L83/2VEgbzs3I1LyqdLH/WryavimUtlYF7yBQKg38U',
          'egEPMFNyCb1K5jjJ1Lo2svftZRWm4l2hjZ6uq2wIy+u8UPZPhSJ/U5Rof92qwqD/2SY50xG5WphFPEi/W7sxoT9pWQUiyXim/4hl',
          'jYpvQbMvq0xW2sDR9C3sQm/n9c43o9ffjL7+p4vXryf8/+T169f/ZqeOx3BSKCWVhnT/3fnexeHBx7Pjd384Ov14snf+4+HF2fHe',
          '/uHHo4MUxk/OmL59d75/+PHd+XHKVIsK0lpk12KOjVT0QijMx1plY7OuUY9rJwCj0wR+xNqA0FAWBpUoNSxQIRPrm0WhodAgoC5F',
          'UQHdFRZCVag1zIo7s1I4hEoSD5UBOQOzQLiYwtWqKHOYK1EvBonnjL9G+4bErMzqxTgr5SonDj2+oLlwtHASFsaMnaNpKdyJUNdo',
          '6lJkeCqW2B8Qc+nAjgrkha5LsYZKLBEKK6Z0Q7+JjUtRVJ6LY7d8ZH+P9LrKiLMgqtyS6ExYNufgeTOp+Bg5zsSqNJBmopL1OoUr',
          '5Un0U/5bj+3QmH8lP2tZpRN/bLoTXL7a5xmXr4ZQVAZVJUo3kLkBEsh4DBdOtk6MbLaQCyOsQFca1WgmsqKaQ61kvsoMZLJeD0FL',
          'KAytxDtc1oaJsVXQHfhgowpXRokS3h2NaA2oVYnQ14iwf7z37uAwWeZw+eoHmltUc3ukx0V+dv72z0cHh+cfT/dODlnqfJORY+vT',
          '+nJwND073vsprLXsAacYEOnEM3QOp/vnR2cXR29PYfeyAuh5Ek4NgOSOecMKt1MmjCjlPIl9xOHJ2cVPHw8OL/aOjqewC/0B7H4H',
          '/Xuiq6+LstQTeP9hSD/FHCvT/MzkckmKED4spLxufi2zeorqBlXzqdQbnxZCn6PIlziBmSg1Di+rhwEfb7aqMlPICvRC7Pz2m34m',
          'K4OVGQAfTaFZqSry0/2endcbJKs6Fwb9giH0Vmb2z71Bkhdz1KbfW+Bdj/Z4YPf35ZeXFXwJFwsEcyuBY0Qe7NC7J0jZ86qRkbK8',
          'LkwKmaSLMHuZT0xlKQyqQpTFXwSfnf15f/rj0fExKdpXICsEvDNKwKwocfAtpAprOdIoVLaIiTK5NFlmtbWtraQTeFNgmbOX0LBk',
          'b2MXtrzNYWXUOh2n9teZkjdFjuqNyNCk7FxoxS90LkTi07w9rRl7NXTx5ODwDSnhexIxyxngGtcT6LW53xvascjdTKD3rzwHLtpz',
          '9EIqc4A6U0VNjJtA70CJmSFvIqocMC/474WNoewCS1nNRzOplhxvi2qeeGokHkvk62Qnee0/i5VZSOXO0bZrPyUTBudS0WWcEytu',
          'CrP2wwrJnrDKMZ+AUSv0V5SZfqfKCfQWxtR6Mh7jnVjWJSaZXI5pdLydN6yUE89Fz8fcXX1USYPazwXWoJgzp+3hvMW/fVGTn2b2',
          'STUXVfEXBE8ZmHJg2IP7b3AHE6hWZclf7VhLzpE1bBfyOdYSpq0JGxL2p+7ZeSAyJbUGoq0LI9UanG+Am0KAgIXU7ID3z0DzGbeI',
          '+3XyL58r7hxvsJS1E1Hg6gsku4UbTqyBhy3OdoS9ZTnAqrUl+Zd42y1LHoKsPrQdM+vdBd6ZPvmyM2EWQ2h76YCH++yt8kKRnoXp',
          'gyHck+KvlC5u0Ko9sPuHNmLe3CB4de/Hw6myUqxy9DCrKmbk83OcDSnWnISg1I4jjnHWCnKcJde47qoAfXY/vARjq6Dhria21GUC',
          '99EGjQoFE1nIJdZi7iY49XBjSZL0W+eH7+G+FWN7yThEix48wATuHwZWdJs8kjnefR6LkiR5KYejozNzSHP52B5X9JKx/XPcPjBY',
          'vDgTGRLTWg6AWROhzIfHrsiHjDAVB0E6yIsl/1LxPqEhWq4UXSJNxv9w76g/pBsugkb8r7+vztDXKLQw+zdCzUu05Rdx0rPhPvzV',
          'K2Umyt6QYUyXP+F2tSyLbE3rikobUZbCRaC9P+8dHe/9cHzYGzKnsDJF5gffnn48Op1e7B0f9wKlX87rhy5iPAmADDXjOgtuIC8U',
          'ZhxlCBveivUvxVepNmLu7C2Fryw59o9TGsi9Dep0HH+esmmlcCtXZT6BK2kWlD4x9oOlXzNkcqICySotyhh0DjnEtwadwf7uGtff',
          'jZMkScEoRLgtzAIE0wpoty5XugN4GfTxrHNWGoef11U2KmV2DUiq5bLQQnuOUrq2BdZSZDiW2bWFtwP423/8N6S0iya0XGtAkS0i',
          '3IwWpvINRgpJmW7QQnQjQVDJpnTZBtUPCqM5Chms4GpNmAZO314cTsjei1nhqIm5IN2EVGeicseLbOVdlYlsgTll+B5pP5OD0zWY',
          'K5lwCYSsyjX8afr2NKmF0tjkB0GKLKdbUV5HCYluNPFbSpMrvEEFCkcLoReoWR4+nLauQhRIGpxfmwVqBLdEKGThuEQdZkWOZWHW',
          '9oSsKwoJADI9KoHBlciu4YoG12ZB8HBVkf5Riu8zgOBoIlFZCfcj3hwUagiN07Fpg2XhQaFg1yZEP8vtq8ixWGBhF7Zj6S588QVN',
          'CvGUgQ401ba+80dhi7DxEHouIDp59obQs3/ZUOxD2idFzQgDvWB78s/P7f6yiB82bzjFBgW7cP8Qsc+p8ElW/4hrGn3/wS0qZtBv',
          'sXLgA4NducxqLl/uNmA1RjHhI8D7FhkS4Ady0ZRIOgDbG1o02564UmVw+03+YU8f8/QRbgYMNRj6ww7c2vatk3qlF/2NQ9rJD21u',
          'sEF2OMHfuqobH8Vacc/qL/9o6LeInOQ+Z+asZzQaNXA/tSHNRldLhL4EEAKQtnBOPDEaiOa36feirX711DbxxD+silxUmXUmj+yY',
          'GHksb1HtC439wTZCHyzLepeXVa/NFYUzVFhl2OHMr+Dcj2y/wSFHqrA8eKRQGN24oJVA8sLjNSlTI3KvB0Po+dBJuuck+8KV4chu',
          'dcQBT4EN+b0P4PFFCHSN/d7pB9j1NbfOGZ6hEJ8hprJxFmccbdzoIhHV8iZ+ZdqAwt/bPx28fkgHLwDfXAXdMxN6CBlGVxhuM+ft',
          'IO8Hej2wQdWVz46qmUxBydvHQj6FesZcrlhttVx06oOhtuiQGSU7RkMt61XJlcd+xfhkbP/DqMAdmCn5Ui8HXI7sKd7ZIvuUMXaa',
          'D+nYa54hSgrGa2DUDbLKcOM4g2FAJjYr8OiP4vlojWbkMLg7QDov5ZUoj+zHqRFmpVNCDCnxzByFOqObcSYqLFNQlHcobS/tKFq0',
          'IG91AlNESJeo5uiXW65zsVLbd5KUwOaJqAjkeplEh+gPUiZI70/Pg24PtlHdFBaAbcASfkFqhM/BuAMxODK6jNNGV65W2IDJ2VPn',
          'K8Xey+rvg2VyNKIoKQq3ivl9O2d7CHJr7FcXyu7bxcC2o9teCtzqucNUm9vxXajyducc4iNxzQfq4COeAhP+/A12ePQOregcztaC',
          'Ea3a2Aaa2DhYhINY5qycDaLxSdYEenbcb7CkJ13oWYv2H/+XKg8+p23nsi/Jhp8qKTiDPZY+2W7wSpzpn21J6j0PGn22sx4xmyDi',
          '4JcDz8mgnmA5DX86x5+oMf2/Ekp3bFMeW/3VpjheWEP7P8zXT9Hlo3zySFPBFvYF6NF66WmV5bp1u93d3Xjultgb5U7WpChZEjei',
          'KMVV6YrrQwgx3L23RpkSC/6TFy0wu+6CrFC+c1Y5XdXUvkK0/dGCSfpt/Yew2AKieE3kbMOyyBk8Vgkm5HNITTpFNd+nYkyfSzJv',
          '/COE5RuFmi+aXp7OnBB3vMY32rgzhFJoc44zhXpBPCJGxLrBr93OhXFYoxpXKxXksg6lKk2Rpx83ELVPE94+PC6nszsSv/61I+Yt',
          'hDVnh77vKSXWSaH5v25+Eh+zuWW4p53ltuGzP5A9ZQs/czyGN6IswSyUXM1dIY05ATc7wMeGKyzlbRJu/8tY2ELnU8ScWoJasLr9',
          'dB9TmTCOl9UoL/S1rVv68iOTw2peVAj99JFK7KCN64dcIqRBVy5juNyq8dk2IpsuMKrN6WlDQvo7amo5EEYcFOo7D0ZHzC9bem0q',
          'pW9kWcpbKp2l1JzgOtZYk6kJipoGqhsqgMtKT2yeqMe8mc1bbnbc6/zmJr7oSf1JMV2vaYS3uYpn760Rh+G1P5fZakkNIbwJYepR',
          'rWSG/NAqclTNDU42Byefh82ZHDx53r/9539RJ4LHz3M0js39QaiNxUzo2XSBKR+dnL09v9g7vYDDncOR7Ry7VUV1TT1DvuzblHxL',
          'KeLET8dF3s2zDyau9pkW+nAHObPsDyjLsnaSk8XEOg+CLNXmMtq+TOewNx0dTW2pm2Xs8qDuMfq3iyJbeLllYmvpWY+j7caps1tZ',
          'AeWTlCyKfMBbXxd1jTlV5wuF5Tqxxiet9diGma3qpeStbeHq2t2QyN4uhAmlbJsXogKRmZUoyzUR1gn35bQsls5j6CWxZfTUKEh5',
          'NtPaKE/3qX5PDR0j+gNKsZYr9ro0yE8X/izuEaDjEaxRDdjANXu4FW/AjWqGlsoaKRn33OCspqfjPoOWEU7ICkaZXNaywsqQlWlZ',
          '3qC2+3OVIrIfa8zsOfpKmAUV0Bf0LHODynWo0OHWthmVXcUWcVA9n+nx2wq9LlwxL1BhTlI3sqZ3jw0vY9XaCpvew0Ltnon9vhZK',
          'LOFeXv2MmXlwT0W6NaaNKqp5GEsi5wfiSstyZRD2907fnv308WDvYu/jwdG5JaDcM9H9vTP9ViScgKU8dIPtZLk7qt170WOrLcuo',
          'FuRHbJPal/Dw4GoCeMd9uE1v2kYncd/dsZXa30N84wfY9ZyA77/3hXUGING0EIwptN5ChbdwSP1d/d7mpqDw31eFQh3v09uWr9pl',
          '51KaVpUhWjYMrazeS/TiYkObxS0iEfEh9KKJLQKb+V6LyAayblKVjYcW9zl+QGOPHj2hRCnj521pmx7DXp4lL9+7q3VPsCy8g7rA',
          '5LKs8Ri+TuLnZvuwufHc/BVksqRe94BLokfVpDkRffSKE951qEbZ9/WkGfmBqCUv6GK09L3LhqjQ+7KHu1gdx2PYad+JC4LRsuhx',
          's89uJ7zYli7R9e+gRAwArlZVXmLO5ToqVraIrejZlKImdf5uh3ewYGQySNpPb1vqE+2E99k+4S2tg6+bXrJOa92j4JUlZHvNQnva',
          'Eo2gPmnukonpPNc27JMseVth1PjgetmaJMyHq1gZkqWo+9vba1wHSff1crOk8HkcfLwr6Nl26+cvtK3JJbqP07N/TGDqAT+bU6E5',
          'wDOIsEA4QiUEWDrq1HUHgRVBPb5+4vkiHD8yxI0z/iaxiKH1DwpiTaJ4wmBiEyQMXRcx9cIHy+LIvxA1PvXkcWVfSoqqWfdMp0PS',
          'rX2TO+rKxfYZ7X5n798txXfdzDZj3aJ9RHPDUYdqBZdT3kgKbn3/cdgtlEVt8k2hw0vOCEPWdCPKIjSEiizDulvzsffel6vKTEKv',
          'eYnVPJTdKDHe31ZkWbb/CcnLrahzkceKiFvi4cNgSwtApFehHFs8Vw2rXmS12zzkM56tVbq7sDX+rN2Za8e48/bpf9XzCZyxcnrH',
          '//Agj6V0Zd/Cmn/d8Hj1bylvbNEtnvq8gtSRF4COEm+pCW5oeT88UmyxnkG3OrhtuS24b9rZoFMOZHPwz3pU0Wl2dkQ+tKrLTs9i',
          'wP8EaN2W2UfqGjKj3WcLgtvRrm46CZIk8eRaBbRkVpQGVb+/ZO+wTIocvtjdfcQUBp1n6IYQD3zoBtF2CbAbNXYiPYwKaeGcre/w',
          '179GOkp9oq15XkZu/p7xSkDdo1sndDbaGLeVP/pf3OUb864dxTqtAa2rPwHXN4JrbCI2sXssvoSH1biK/OrhfwDvupvkVToAAA==',
        ].join(''),
        'base64',
      ),
    ).toString('utf8'),
  ),
);
// Freeze the reviewed source before the delegated CLI launch-argument change.
FROZEN_CHANGED_HARNESS_BASELINES[
  'packages/desktop-shared/src/pipelines/config-paths.ts'
] = gunzipSync(
  Buffer.from(
    [
      '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',
      'r/tfAAA=',
    ].join(''),
    'base64',
  ),
).toString('utf8');
const FROZEN_DIAGNOSTICS_SOURCE = gunzipSync(
  Buffer.from(
    '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',
    'base64',
  ),
).toString('utf8');
// This one additional helper is proven absent from the frozen baseline.
FROZEN_CHANGED_HARNESS_BASELINES[
  'apps/desktop-app/tests/electron/browser-profile-test-lifecycle.mjs'
] = null;
for (const file of [
  'apps/desktop-app/tests/electron/cowork-summary-fixture.mjs',
  'apps/desktop-app/tests/electron/fixtures/curatedPipelinesCloud.mjs',
  'apps/desktop-app/tests/electron/seeders/connectMockCloudAccount.mjs',
  'apps/desktop-app/tests/electron/seeders/claudeQueryPrelude.mjs',
  'apps/desktop-app/tests/electron/seeders/seedBlueprintCatalog.mjs',
  'apps/desktop-app/tests/electron/seeders/seedChatsSectionFixture.mjs',
  'apps/desktop-app/tests/electron/seeders/seedCuratedPipelinesCapture.mjs',
  'apps/desktop-app/tests/electron/seeders/seedOrgContextScoping.mjs',
  'apps/desktop-app/tests/electron/seeders/seedPipelineShareUnresolvedInvocations.mjs',
  'apps/desktop-app/tests/electron/stress-transcript-driver.mjs',
  'apps/desktop-app/tests/electron/stress-transcript-fixture.mjs',
  'scripts/lib/e2e-harness-measurement.mjs',
])
  FROZEN_CHANGED_HARNESS_BASELINES[file] = null;
FROZEN_CHANGED_HARNESS_BASELINES[
  'apps/desktop-app/tests/electron/mock-server/start.mjs'
] = gunzipSync(
  Buffer.from(
    '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',
    'base64',
  ),
).toString('utf8');
FROZEN_CHANGED_HARNESS_BASELINES[
  'apps/desktop-app/tests/electron/seeders/registerScenario.mjs'
] = gunzipSync(
  Buffer.from(
    [
      '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',
    ].join(''),
    'base64',
  ),
).toString('utf8');
// Original study bytes for the pipeline execution seeder before pause-checkpoint coverage.
FROZEN_CHANGED_HARNESS_BASELINES[
  'apps/desktop-app/tests/electron/seeders/seedPipelineExecution.mjs'
] = gunzipSync(
  Buffer.from(
    [
      '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',
    ].join(''),
    'base64',
  ),
).toString('utf8');
const ACTUAL_HARNESS_IDENTITIES = Object.freeze({
  'apps/desktop-app/tests/electron/browser-profile-test-lifecycle.mjs': [
    null,
    'b2191a0b2253628f906ff6b8d83b018ea4e00de6d36c365812a1682b8fa8a6f4',
  ],
  'apps/desktop-app/tests/electron/canopyApp.mjs': [
    '32901c00d59424d256ae6d84e307da3204240d454a9a2c3a86f05e9ce92dde7a',
    '2ce655e6a2782cb311f928f95ba62f854d17f4d4d1318e896ccf9eddac20dc8d',
  ],
  'apps/desktop-app/tests/electron/launchCanopy.mjs': [
    'fd591e8a4999aecea184e1201bc4167f2e954efcbab0e6fef1481f6254be7c4a',
    'f5ac00a1ab88f5df076ddfee3b5a8f51f0170686c765b239f66ad0005a31291b',
  ],
  'apps/desktop-app/tests/electron/cowork-summary-fixture.mjs': [
    null,
    '122d0aeef498f3753f5139e97ecc84332c3b133e9c317658859a70adb1f8b2a6',
  ],
  'apps/desktop-app/tests/electron/fixtures/curatedPipelinesCloud.mjs': [
    null,
    '45d0a2980f5fa48c899d4111d357184887c7a281a30710bda00d07124926d993',
  ],
  'apps/desktop-app/tests/electron/seeders/connectMockCloudAccount.mjs': [
    null,
    '30847468fc532def0e0059fa04e13fbfe29b1076493f3a8cc1d8921e65c52361',
  ],
  'apps/desktop-app/tests/electron/seeders/claudeQueryPrelude.mjs': [
    null,
    '05896d8ae9bb064a4c488fa367d4ad4ea8151162291c9f65234a95c96aecb0a6',
  ],
  'apps/desktop-app/tests/electron/seeders/seedBlueprintCatalog.mjs': [
    null,
    'aba9fe191d693342d12feb7f01310d9c4e3a1b85b11148bfb047ff40d6caa87d',
  ],
  'apps/desktop-app/tests/electron/seeders/seedChatsSectionFixture.mjs': [
    null,
    'cf7116abd4c0fc106197a3aaa326d510712aabbf86c74b555ecb233bc4511fd4',
  ],
  'apps/desktop-app/tests/electron/seeders/seedCuratedPipelinesCapture.mjs': [
    null,
    'badbd26dfa2d6bb0f2e6b4c4c0f1bad841a9efe72d3c86ce872bfd2ca9038440',
  ],
  'apps/desktop-app/tests/electron/seeders/seedOrgContextScoping.mjs': [
    null,
    'fbbe9d20d09e7a8826a5cf6a9e08217102bab47adcd67eef944207d159825363',
  ],
  'apps/desktop-app/tests/electron/seeders/seedPipelineShareUnresolvedInvocations.mjs':
    [null, 'f1effdc2674b689298cb7c7a37b32084eb6a0e071ce40f14d3811e3ce86a19e4'],
  'apps/desktop-app/tests/electron/stress-transcript-driver.mjs': [
    null,
    '4b36b4a0685bfc64c493af1a8922f454dbaa0f9791ecd7788c6291a6facf8c92',
  ],
  'apps/desktop-app/tests/electron/stress-transcript-fixture.mjs': [
    null,
    'dc0d8f1bb92bb2b7a5fb9747e3141b49e513c764a49e9eb14755d508e7ff1131',
  ],
  'scripts/lib/e2e-harness-measurement.mjs': [
    null,
    'd9f0634bd0ec475ede901072aabb8b3196b5da14d3142786a18cdb4475241fff',
  ],
  'apps/desktop-app/tests/electron/panelHarness.mjs': [
    '51e0b756ff3312e3e4464233c63438f590b7fe60aedd299ad87f67d58f91f57b',
    '005fef7d8a7adef90cc2e7b78c7a8a689a792cf6b5141ad69bb8e0ec07bb0163',
  ],
  'apps/desktop-app/tests/performance/browser-profiles-evidence.mjs': [
    null,
    '5746d0a79c90fb6963b83b8d727388bfe30905a69c9a26dfb1a934c0d7c7fdf8',
  ],
  'apps/desktop-app/tests/performance/browser-profiles-production-headless-bootstrap.cjs':
    [null, '024dd62703709dc18cb4ff1ec35aeeaccd42940f6f5e8f43bc638753d9abf9b4'],
  'apps/desktop-app/tests/performance/compare.mjs': [
    '8fcc3452ce5c3a6f93500a965d44126e09de7cf79aca6f09ee0f217a7a3ebeda',
    '9c45997ac0311bc500b5a92b17ba7923343e6f92be7838a5a28bbd9d9b3fbff5',
  ],
  'apps/desktop-app/tests/performance/comparison.mjs': [
    'a27d241c8e1f32bc04cde6d2a0a699e0b6e9d1e9b641d5f7bce3215444ac4493',
    '7b29a5bb0bc2f2bc380b07d74388a2c1c29375356241cb0c72153081aa1ddf67',
  ],
  'apps/desktop-app/tests/performance/diagnostic-replay.mjs': [
    '42e55c9eb0da37905b69d523c49799203f487f7fd868380fedbd5aae00f98301',
    '2ec63a05968b2fd06ed601d3a966348e8804106e381f39b7fb352e9508d7f240',
  ],
  'apps/desktop-app/tests/performance/monitor.mjs': [
    '5d644bd000078fce4776cc0f8d09072cfc3ec719cf98da331dd1e27db53de02c',
    '909b52498c7a3ade1f4d6eb9e2fa5ee742e50dd85ad55e2833741b505de7eba3',
  ],
  'apps/desktop-app/tests/performance/process-tree-supervisor.mjs': [
    '0cff1607b1d40332ef15c1e96135a4d53c73d3ca5e9aed45dc67eaf53851a04d',
    'dbe4df44ed6d7b0e99936a7dc6dc4da30f68ee8f7b65de7023da4aae3f93a80e',
  ],
  'apps/desktop-app/tests/performance/profiles.mjs': [
    '63217c1d9d4714ec0602a0f4cca00f157322ea101a2a207e3ea4d3c9f9a10667',
    '99559a2c82b97167abc7ed6459c05fdbe3f36f7c876d9c28fad64f1716612ad9',
  ],
  'apps/desktop-app/tests/performance/run.mjs': [
    'cb020cfeb90787f53f1288dd6cb7ac60a27b31287ea0b2015b279c05998d96bf',
    '9d6816edaef9949be3326f57eb346c057e3f12d5a602758fc8496c17e2a3a9bb',
  ],
  'apps/desktop-app/tests/performance/scenarios.mjs': [
    'dba1f957e931f61e9e42d1d22d3e6d1ac36510d3567661d1ae9cd4756df7501b',
    '6c4cdbe1a0abcf6f63077a4f2657dd6314c2c2331f82f2061b81afdfdc96ac86',
  ],
  'apps/desktop-app/tests/performance/scenario-failure-diagnostics.mjs': [
    null,
    '95c1c7ed143878f0a9040dcbf0792f74a61190dcda8d8195d3d7ae08a303479f',
  ],
  'apps/desktop-app/tests/performance/work-ratchet.mjs': [
    null,
    'bceefe47969f1d2bd750cae7f5d85f8f2b45a8439f1fa612984d41b425ff47f6',
  ],
  'apps/desktop-app/tests/performance/disk-io.mjs': [
    null,
    'ecfc8f6c8b674e8b162411ed62524f43ceadade1bb8ff4ae9f51a19914235dac',
  ],
  'apps/desktop-app/tests/performance/scaling-ratios.mjs': [
    null,
    '73a17e278ea268de44a429b9a9daa8941d47901833a3c14140dd7c7a77599e54',
  ],
  'apps/desktop-app/tests/performance/verdicts.mjs': [
    null,
    '5d72193df4523fd9e67d97cbffcf4d8b17fb3eea71bf39b807118327d7054acb',
  ],
  'apps/desktop-app/tests/electron/demoWorkspaces.mjs': [
    '3c3a8a1c3623d17bc3e37021f651c9293e1a698b6c5f47c9b4e7ca5ed26675e7',
    '3c3a8a1c3623d17bc3e37021f651c9293e1a698b6c5f47c9b4e7ca5ed26675e7',
  ],
  'apps/desktop-app/tests/electron/mock-server/control-plane.mjs': [
    '26151d75fd5f5113976d7828ec8de5eee3ce04b6f56eadf547695adb39356bb0',
    '26151d75fd5f5113976d7828ec8de5eee3ce04b6f56eadf547695adb39356bb0',
  ],
  'apps/desktop-app/tests/electron/mock-server/request-guard.mjs': [
    null,
    '0254f93ecf269ff96f381a1218f067dcc62df4ab222db65e5d3f914aa318be73',
  ],
  'apps/desktop-app/tests/electron/mock-server/routes/authUsage.mjs': [
    '906969adafd4cbeb19ced6eff9999b8d020d90060fc9677d4f58ec36af9f4cc7',
    '4c8c7811d599950a3db18e2456bd3b5c19f976dedbb3052979ec1f524de76fec',
  ],
  'apps/desktop-app/tests/electron/mock-server/routes/cloud.mjs': [
    '601aa335a9629e230303be07b12984a3660fa07209462e61bc52f35ed320b6b6',
    '80fea9cd834b7b68450cd17d7adfbf6b0b71a779e647bc8908cff0e40471e545',
  ],
  'apps/desktop-app/tests/electron/mock-server/routes/github.mjs': [
    '8133d1c52c17c84cb8f5ecd82842d197b7b5af257326fd1b5ce1415d84b0eae5',
    '8133d1c52c17c84cb8f5ecd82842d197b7b5af257326fd1b5ce1415d84b0eae5',
  ],
  'apps/desktop-app/tests/electron/mock-server/routes/linear.mjs': [
    'e7784a752425a492af075f427559a6b87997050c753ee5d6602bd177d14bb507',
    'e7784a752425a492af075f427559a6b87997050c753ee5d6602bd177d14bb507',
  ],
  'apps/desktop-app/tests/electron/mock-server/routes/llm.mjs': [
    'c754a74d2376a9c8f17cf3bb6eec41bfd2061762ff54777e895543a9219cdbdc',
    'ec36d6173928a2287919f890193adc0304cb1854d711c2634929263853a300dd',
  ],
  'apps/desktop-app/tests/electron/mock-server/routes/responsesWs.mjs': [
    '00ae19cf7a13c7d7a3f268455649cbbce5601d203a20762aaf86439c38eafc50',
    '00ae19cf7a13c7d7a3f268455649cbbce5601d203a20762aaf86439c38eafc50',
  ],
  'apps/desktop-app/tests/electron/mock-server/routes/shared-containers.mjs': [
    '5cc71d2e9400c2548e75d18bde4455605720aaff7e1014b45bc8abd80d55f629',
    '5cc71d2e9400c2548e75d18bde4455605720aaff7e1014b45bc8abd80d55f629',
  ],
  'apps/desktop-app/tests/electron/mock-server/start.mjs': [
    'b8bf252001dea13c8ec6a8527cc83f463c861998434c3bf88a430171c12cbbf2',
    '588706289cf2b6b46f2e1fd583b30030ae88025433c519329b2a2e83198cfc89',
  ],
  'apps/desktop-app/tests/electron/seeders/deferredToolsReloadFixture.mjs': [
    '4abbc84ef6948a7fd8224aa0cb93017f6cffc6eccd81252ad0e3e947da1f68e7',
    '4abbc84ef6948a7fd8224aa0cb93017f6cffc6eccd81252ad0e3e947da1f68e7',
  ],
  'apps/desktop-app/tests/electron/seeders/fsHelpers.mjs': [
    'd956424809278b0d65e4ec5b9f37dfde312a84641408a21a6a6b160971a690bd',
    'd956424809278b0d65e4ec5b9f37dfde312a84641408a21a6a6b160971a690bd',
  ],
  'apps/desktop-app/tests/electron/seeders/index.mjs': [
    '5a6c6afa74f46a3450ff05484a8675b278a8c762eb2182937bf9274b6437c1f7',
    '9e70d5f1e698eb7c3f67af325031c911fd439c55f3605d1319615647cdb43cc1',
  ],
  'apps/desktop-app/tests/electron/seeders/initializeIsolatedCodexState.mjs': [
    '1e96ae69471e8ab2d997ba74b7603828b8c82651d75f1d05a5f3e6931efa905d',
    '1e96ae69471e8ab2d997ba74b7603828b8c82651d75f1d05a5f3e6931efa905d',
  ],
  'apps/desktop-app/tests/electron/seeders/injectApprovalRequestEvent.mjs': [
    '2cd63cbd0c78953f29e4861f33d73e4fea2e9794874bc1a8005ab5faa991d959',
    '2cd63cbd0c78953f29e4861f33d73e4fea2e9794874bc1a8005ab5faa991d959',
  ],
  'apps/desktop-app/tests/electron/seeders/injectChatEvent.mjs': [
    '0c1d284aa96662d2171f706003cf9f4cd9bb9c6faee52130888527d9d6064fb2',
    '0c1d284aa96662d2171f706003cf9f4cd9bb9c6faee52130888527d9d6064fb2',
  ],
  'apps/desktop-app/tests/electron/seeders/injectCodeGraphBuildStatusEvent.mjs':
    [
      '90d05e1f3c18cf667a6c9c7033f777ff886c873df4ae7a610861ecbbec5d5dd1',
      '90d05e1f3c18cf667a6c9c7033f777ff886c873df4ae7a610861ecbbec5d5dd1',
    ],
  'apps/desktop-app/tests/electron/seeders/injectGithubPrStatus.mjs': [
    'a0558f9f6beca1ff1bf65c6abe9eb90ae403d4a58b63b63abc5e01a63eaef637',
    'a0558f9f6beca1ff1bf65c6abe9eb90ae403d4a58b63b63abc5e01a63eaef637',
  ],
  'apps/desktop-app/tests/electron/seeders/injectScriptRunEvent.mjs': [
    '0b222ae644f09e8a8f6f20faba96bd1b8616af2bf9d73269f0f1ce59bccd8cbf',
    '0b222ae644f09e8a8f6f20faba96bd1b8616af2bf9d73269f0f1ce59bccd8cbf',
  ],
  'apps/desktop-app/tests/electron/seeders/injectTerminalActivityEvent.mjs': [
    'f40b0400783c7fadbf1846cf44c34a4421c5da8354d57293271089f3a2825362',
    'f40b0400783c7fadbf1846cf44c34a4421c5da8354d57293271089f3a2825362',
  ],
  'apps/desktop-app/tests/electron/seeders/registerScenario.mjs': [
    '97592c545b5ef2b726a2d52c74476f02d3b313a31dcb46d89811bac12e2375fb',
    'c64cf244d9ae5d4ab1df2bbe3b4baaee984320a35ee39302d87b5ff2f9d916b2',
  ],
  'apps/desktop-app/tests/electron/seeders/seedAgentModels.mjs': [
    '4cd5ccfbeab20a1cf390f02b27d0f3b116291852224f1e1415c1d84bdcf3bf30',
    '4cd5ccfbeab20a1cf390f02b27d0f3b116291852224f1e1415c1d84bdcf3bf30',
  ],
  'apps/desktop-app/tests/electron/seeders/seedAutomations.mjs': [
    '346792dc24c09a0fdbbe4fb6ecf8d4d7dc39460e17e3d0238731f77f6fdf8c14',
    '346792dc24c09a0fdbbe4fb6ecf8d4d7dc39460e17e3d0238731f77f6fdf8c14',
  ],
  'apps/desktop-app/tests/electron/seeders/seedBrowserSnapshot.mjs': [
    '5ea43218affa7d35b6a23f71af81386f80418c89c5a1d65528c3926fbb266093',
    '5ea43218affa7d35b6a23f71af81386f80418c89c5a1d65528c3926fbb266093',
  ],
  'apps/desktop-app/tests/electron/seeders/seedCodeReviewState.mjs': [
    '1ea0fcbbefc90dc72b4ff828f89d8cf7f8ed44dff16e13a7bc29d14fdc70378a',
    '1ea0fcbbefc90dc72b4ff828f89d8cf7f8ed44dff16e13a7bc29d14fdc70378a',
  ],
  'apps/desktop-app/tests/electron/seeders/seedCoworkWorkspace.mjs': [
    '72f1500fb176e3d769f39189d227a108b9c78d25028f4393158f3702c06cd8af',
    '72f1500fb176e3d769f39189d227a108b9c78d25028f4393158f3702c06cd8af',
  ],
  'apps/desktop-app/tests/electron/seeders/seedCuratedPlugins.mjs': [
    '5395ab3bc9ee12656266cc03d3de649d1fe5da075c489b85a7048724c32d174f',
    '5395ab3bc9ee12656266cc03d3de649d1fe5da075c489b85a7048724c32d174f',
  ],
  'apps/desktop-app/tests/electron/seeders/seedGlobalInstructionsPreferences.mjs':
    [
      '1e5d5768179d9fe28bc1ca261ab9eedfaf546345e08fe439cbd01a7c1b0bfd9d',
      '1e5d5768179d9fe28bc1ca261ab9eedfaf546345e08fe439cbd01a7c1b0bfd9d',
    ],
  'apps/desktop-app/tests/electron/seeders/seedInnerPanelLayout.mjs': [
    '0909cd340e293bf3ea6b6dba18b45fd66807100a58f6b4db3b638b506a578a45',
    '0909cd340e293bf3ea6b6dba18b45fd66807100a58f6b4db3b638b506a578a45',
  ],
  'apps/desktop-app/tests/electron/seeders/seedMcpServers.mjs': [
    'e571107abff250e1d5d2628b8676e4b8846805709511376842fe7b2be7162fe1',
    'e571107abff250e1d5d2628b8676e4b8846805709511376842fe7b2be7162fe1',
  ],
  'apps/desktop-app/tests/electron/seeders/seedObservabilityAudit.mjs': [
    'cd4f4bef7e79da5a5987a25ad333937462e5a451c264dbb04b6d5f6444094d56',
    'cd4f4bef7e79da5a5987a25ad333937462e5a451c264dbb04b6d5f6444094d56',
  ],
  'apps/desktop-app/tests/electron/seeders/seedOrphanedStreamingTurn.mjs': [
    '7a90393b6af955775ebebcdc0c1fe67c5a0c81dde3085f80d286f96f6fe2236f',
    '7a90393b6af955775ebebcdc0c1fe67c5a0c81dde3085f80d286f96f6fe2236f',
  ],
  'apps/desktop-app/tests/electron/seeders/seedPipelineExecution.mjs': [
    'f5e8f97569647201d7635d502b5cb721ec20ee2cfe2c8c9214bb39e8abebb961',
    'f5e8f97569647201d7635d502b5cb721ec20ee2cfe2c8c9214bb39e8abebb961',
  ],
  'apps/desktop-app/tests/electron/seeders/seedPluginsCache.mjs': [
    '5261125033d1822c48e072da6c32aec28f42441c48416c282f58210b366c3ef5',
    '5261125033d1822c48e072da6c32aec28f42441c48416c282f58210b366c3ef5',
  ],
  'apps/desktop-app/tests/electron/seeders/seedResourceSnapshot.mjs': [
    '48c15da387666c1e0c179033ea6863156ef5a836e169c4c9ef017ff811808d44',
    '48c15da387666c1e0c179033ea6863156ef5a836e169c4c9ef017ff811808d44',
  ],
  'apps/desktop-app/tests/electron/seeders/seedScriptRun.mjs': [
    '1eec93ebd2f1c6e4df1a502c98a650aa44b647427709c65d6e2bbaf770389d9d',
    '1eec93ebd2f1c6e4df1a502c98a650aa44b647427709c65d6e2bbaf770389d9d',
  ],
  'apps/desktop-app/tests/electron/seeders/seedSharedContainerRecipientReplicas.mjs':
    [
      '8c6ccc783e0351d804ad8cebdf5d3329fd81ef638e034cd7071e7f51a124881c',
      '8c6ccc783e0351d804ad8cebdf5d3329fd81ef638e034cd7071e7f51a124881c',
    ],
  'apps/desktop-app/tests/electron/seeders/seedSplitPr.mjs': [
    'ccc26df4f2754d9774f0aff52044a49dbd9731e17605705b4aa9528744d7c8f2',
    'ccc26df4f2754d9774f0aff52044a49dbd9731e17605705b4aa9528744d7c8f2',
  ],
  'apps/desktop-app/tests/electron/seeders/seedStoredPipeline.mjs': [
    '9069f9eb1d990c17d342b58317273955e0a5b2857a2de6465f5b0f62f2ab710e',
    '9069f9eb1d990c17d342b58317273955e0a5b2857a2de6465f5b0f62f2ab710e',
  ],
  'apps/desktop-app/tests/electron/seeders/seedTrackedPlans.mjs': [
    'a9f3daba4838b23ac3c050dab5dfe2779a1fc7ba1ce9e46f3fa7b25ee43a78b8',
    'a9f3daba4838b23ac3c050dab5dfe2779a1fc7ba1ce9e46f3fa7b25ee43a78b8',
  ],
  'apps/desktop-app/tests/electron/seeders/seedUnreadPreviewWorkspace.mjs': [
    '81f6800ab922e74076c043e901b25e2ccae9baaa87e46081d5d0e3c82271a4a3',
    '81f6800ab922e74076c043e901b25e2ccae9baaa87e46081d5d0e3c82271a4a3',
  ],
  'apps/desktop-app/tests/electron/seeders/seedUsageEvents.mjs': [
    '88fd4c0731ef9ee775b633c8da243efd6ed0a4cad7415e506cfb51d99e7abfc2',
    '88fd4c0731ef9ee775b633c8da243efd6ed0a4cad7415e506cfb51d99e7abfc2',
  ],
  'apps/desktop-app/tests/electron/seeders/seedUsageLimitedChats.mjs': [
    '09fb238255e8a2dc55e8166164c4857f490a1cde313a383fe908539589a4a106',
    '09fb238255e8a2dc55e8166164c4857f490a1cde313a383fe908539589a4a106',
  ],
  'apps/desktop-app/tests/electron/seeders/seedWatchers.mjs': [
    'cadeeb6b2827cf3dc3bf4ea3259c758b02a7b924ba0b97bc59c7b3c9de7d3efa',
    'cadeeb6b2827cf3dc3bf4ea3259c758b02a7b924ba0b97bc59c7b3c9de7d3efa',
  ],
  'apps/desktop-app/tests/electron/seeders/seedWorkspaceApprovals.mjs': [
    'bb178ebbee0ba55af5a1db4b66788d66ad1ee529a8fdf9d7346a0ad01a197780',
    'bb178ebbee0ba55af5a1db4b66788d66ad1ee529a8fdf9d7346a0ad01a197780',
  ],
  'apps/desktop-app/tests/electron/seeders/seedWorktreeChat.mjs': [
    'e5f3141115896689a380646646a5fed7a3d132d5d909016a06d394fa8c36247f',
    'e5f3141115896689a380646646a5fed7a3d132d5d909016a06d394fa8c36247f',
  ],
  'apps/desktop-app/tests/electron/sharedContainersCloudFixtureKey.mjs': [
    'faceed82a0eafe2d88dfd709e44a641db9e2590bf562cf315287e97f8a8e6502',
    'faceed82a0eafe2d88dfd709e44a641db9e2590bf562cf315287e97f8a8e6502',
  ],
  'apps/desktop-app/tests/performance/diagnostics.mjs': [
    '401515b0ac2ffa36f8ceb8979044f987c79f12d9e517e600b107421f984a9120',
    '1cb298b806a9e7159942cc06d0ccfd8eebb555e74599c08617703b5f6a14944b',
  ],
  'apps/desktop-app/tests/performance/git-attribution.mjs': [
    '3e2df6352edd17e280e73d9052b29ac3989902e7a24fa55ac5efd18a39f13d9d',
    '3e2df6352edd17e280e73d9052b29ac3989902e7a24fa55ac5efd18a39f13d9d',
  ],
  'apps/desktop-app/tests/performance/hotspots.mjs': [
    '69ca90c612620e7b54a5e85b58d82bedcdfff312240e147963c8d0ec967a3a13',
    '69ca90c612620e7b54a5e85b58d82bedcdfff312240e147963c8d0ec967a3a13',
  ],
  'apps/desktop-app/tests/performance/inspector-client.mjs': [
    'b8122da08eaf9c0835a0ac11378fbba2a98486cb9eec5f99f1dac40ad760010f',
    'b8122da08eaf9c0835a0ac11378fbba2a98486cb9eec5f99f1dac40ad760010f',
  ],
  'apps/desktop-app/tests/performance/mixed-provider-validation.mjs': [
    '21f87dd92414566c8454a991e74447dbe5ce95b6ad2f4362a400ae91155a001a',
    '21f87dd92414566c8454a991e74447dbe5ce95b6ad2f4362a400ae91155a001a',
  ],
  'apps/desktop-app/tests/performance/mock-server.mjs': [
    'f9d4058a79aece92bf1c90938547f833725d8cad43c2326ba77aaf3f98ef2c7f',
    'f9d4058a79aece92bf1c90938547f833725d8cad43c2326ba77aaf3f98ef2c7f',
  ],
  'apps/desktop-app/tests/performance/responsiveness.mjs': [
    'c2529ae8fc04b3151dd1c6c783091a54615d899a3ce11a9d7e9b8b4274c1cf84',
    'c2529ae8fc04b3151dd1c6c783091a54615d899a3ce11a9d7e9b8b4274c1cf84',
  ],
  'apps/desktop-app/tests/performance/results.mjs': [
    '3db81289f98f79850d8b483eec1986efe3fb6d850592ef4c17385dc822cc6ab3',
    '3db81289f98f79850d8b483eec1986efe3fb6d850592ef4c17385dc822cc6ab3',
  ],
  'apps/desktop-app/tests/performance/scenario-status.mjs': [
    '54dc006dbacd28e9fb2b555d28007d6cc9eb92de493ae1e7de0c9be1b6569820',
    '54dc006dbacd28e9fb2b555d28007d6cc9eb92de493ae1e7de0c9be1b6569820',
  ],
  'apps/desktop-app/tests/performance/smoke-artifact-retention.mjs': [
    'b7d20221bfe95c60e60994128652f440c6b7c5f4448aa660319a1a098c16378b',
    'b7d20221bfe95c60e60994128652f440c6b7c5f4448aa660319a1a098c16378b',
  ],
  'apps/desktop-app/tests/performance/statistics.mjs': [
    '83235fd86f5852c6380ed3d3b7c4698949f9b92bd9271739dc5131ac28415168',
    '83235fd86f5852c6380ed3d3b7c4698949f9b92bd9271739dc5131ac28415168',
  ],
  'demo-apps/lib/archive.mjs': [
    'f1dace1e1f2b23dd06866597fc74e93b717f59e026ca0a15129c9cad7ac0b55f',
    'f1dace1e1f2b23dd06866597fc74e93b717f59e026ca0a15129c9cad7ac0b55f',
  ],
  'demo-apps/lib/catalog.mjs': [
    'd1677ee4e40c119a4155ed97d30001746f25cd46756c98ad32e7d844e4069a90',
    'd1677ee4e40c119a4155ed97d30001746f25cd46756c98ad32e7d844e4069a90',
  ],
  'demo-apps/lib/git.mjs': [
    'dd68843f3563b4032413368eeadc369dcc0c9ca81010105cfabf85185ccd3721',
    'dd68843f3563b4032413368eeadc369dcc0c9ca81010105cfabf85185ccd3721',
  ],
  'demo-apps/lib/runtimes.mjs': [
    'a37751fa141eb43c47799ac3673d5505dde9f39a92054b2df8007f0b226f83ef',
    'a37751fa141eb43c47799ac3673d5505dde9f39a92054b2df8007f0b226f83ef',
  ],
  'demo-apps/lib/workspace-state.mjs': [
    'f98012725443e4b179ba6a99f5df430f201c6992fba0462d32ceeaba457bc4f6',
    'f98012725443e4b179ba6a99f5df430f201c6992fba0462d32ceeaba457bc4f6',
  ],
  'demo-apps/seed-canopy-data.mjs': [
    'c7951d52007f8e46cb4e8dd2fdadb23d8f37b5354f5a1ab459d3b820cf43fa8e',
    'c7951d52007f8e46cb4e8dd2fdadb23d8f37b5354f5a1ab459d3b820cf43fa8e',
  ],
  'packages/desktop-shared/src/brand/env.ts': [
    '6cfe825fe8ab368fd5193532469b781e7ebd3b205788c7f536e5500e245b68cb',
    '6cfe825fe8ab368fd5193532469b781e7ebd3b205788c7f536e5500e245b68cb',
  ],
  'packages/desktop-shared/src/canopy-paths.ts': [
    'b4a49766eabe22676c6d440f56e348349d70bb530d4fed067f375885daad745a',
    'b4a49766eabe22676c6d440f56e348349d70bb530d4fed067f375885daad745a',
  ],
  'packages/desktop-shared/src/node/lib/path-lookup.ts': [
    '284e4f4135b481bd488979593d8ab6f1c20c25f8d8a750054187080710ca965a',
    '284e4f4135b481bd488979593d8ab6f1c20c25f8d8a750054187080710ca965a',
  ],
  'packages/desktop-shared/src/pipelines/config-paths.ts': [
    'ca1693b07d8d06c7a429b05ef0a27408405f8bc4bebbdd011367031888b01c91',
    'ca1693b07d8d06c7a429b05ef0a27408405f8bc4bebbdd011367031888b01c91',
  ],
});
const MERGED_BASE_HARNESS_IDENTITIES = Object.freeze({
  // The PR merge ref includes the base branch's PostHog E2E flag defaults.
  // The base branch also extends the cloud mock route for shared pipelines,
  // organization model policies, and curated automations.
  // launchCanopy.mjs no longer force-seeds manual sidebar ordering, which is
  // now the product default.
  'apps/desktop-app/tests/electron/mock-server/routes/cloud.mjs':
    '3914e3bc31665221b9dfad05d9026ce1e153ea346dea06feb5f424d750307b0a',
  'apps/desktop-app/tests/electron/launchCanopy.mjs':
    '0416da57f6a35d8d2fe62f37a468c0e61042e73e39f45eede9b323b7a1415677',
  // #4154 updated this helper for the model picker's harness tabs; #4429 adds
  // `selectModelOnHarness` for picking a model under a harness tab.
  'apps/desktop-app/tests/electron/model-selection-fixture.mjs':
    '2b5a9b5b48af48b6c8cec94e033614646a45159db3eea51047377ff2c003cb7e',
  // The shared delete modal preserves a worktree's branch with one
  // "Preserve local" action instead of a branch-choice menu.
  'apps/desktop-app/tests/electron/seeders/archiveActivityFixture.mjs':
    '888967604e1eaf564ac6cbf1d4cf8c6e9bacd546428304e4a194f488930f4586',
  'apps/desktop-app/tests/electron/seeders/index.mjs':
    '9e70d5f1e698eb7c3f67af325031c911fd439c55f3605d1319615647cdb43cc1',
  'apps/desktop-app/tests/electron/seeders/injectApprovalAutoResolvedEvent.mjs':
    'bbc0d9b53133bec94e1cf053d14f60fbc98df51c1d8c13b2e0e9f0b70356c799',
  // The shared delete modal shows "Preserve local" directly, without the
  // branch-choice button.
  'apps/desktop-app/tests/electron/seeders/largeArchiveFixture.mjs':
    '035df97dcd38183c631c8e3c53b7de566e24a287b5968edfeeb6e27a9e3ccf1d',
  // CAN-3463 adds the organization-owned workspace seeder to the harness.
  'apps/desktop-app/tests/electron/seeders/markWorkspaceOrganizationOwned.mjs':
    '337f1046d46b003d70dfb514109e52f87234f4bc88fb904c9cf7dbaa87315862',
  // Share-dialog E2E specs added this seeder to the transitive harness closure.
  'apps/desktop-app/tests/electron/seeders/shareMembership.mjs':
    '56f2a212b236f7aa8311336aef30e7c9062f7f455a2a4e42142e50c008502c37',
  // Phase 09: the delta-journal storage spec seeds its Experiments
  // preference through this seeder.
  'apps/desktop-app/tests/electron/seeders/seedChatDeltaJournalPreference.mjs':
    '2a4c2cd12ebd2eb2f26bd28e95c99b93d8e90b46d1e4f0bbadb2925e0af1540b',
  // Plan workspace panel fixtures add the shared-plan mock route (via
  // start.mjs) and the tracked-plan/shared-plan seeders (via the seeder index
  // and the opt-in plan-open scenario) to the transitive harness closure.
  'apps/desktop-app/tests/electron/mock-server/routes/shared-plans.mjs':
    '863c2c4ddc844b6b456c485d4129c03e5fccd189e5d68e795f4381d1f0b1348c',
  'apps/desktop-app/tests/electron/seeders/sharedPlanCloud.mjs':
    '8d3816cbc557120193652f49d1eab5d3c8e93dbb8e9a960debf19d074939d2a6',
  'apps/desktop-app/tests/electron/seeders/trackedPlanFixtures.mjs':
    '98b46afbb1df70963eae2b6f3251c34fc31c69cac4d303cb9258269fa5f414e2',
  // CAN-1570 phase 03 adds the opt-in browser-actions scenario, which starts an isolated Browser Lab server.
  // develop's sentence-case copy pass changed its "Saving…" status text.
  'apps/desktop-app/tests/electron/mock-server/routes/browser-lab.mjs':
    '82b9f68af1ce0279ad91c6155a21780c7009fcde989d2f8ad461705a69f9a2f6',
  'apps/desktop-app/tests/electron/mock-server/routes/browser-lab-cases/auth.mjs':
    '3c0b3250534c6053aa557b640224cf0d5f7749a521369c17b766197079a52b2c',
  'apps/desktop-app/tests/electron/mock-server/routes/browser-lab-cases/controls.mjs':
    'a996a70ad4d2d81f54f81d30cf2cea72ca9f6defda16ce16b0a9db09bb8f5b1c',
  'apps/desktop-app/tests/electron/mock-server/routes/browser-lab-cases/dialog-surfaces.mjs':
    'd40163c54131e05be32b63e81054f3cb1357ec0656f9b1168b039f69c2c8c69a',
  // CAN-1570 phase 07a adds the resumable, stalled, and named download routes.
  'apps/desktop-app/tests/electron/mock-server/routes/browser-lab-cases/downloads.mjs':
    'd6ac7417a408efc236e5b71cf999c106fb2a0be18c4a90dfaa3140dab83003fb',
  'apps/desktop-app/tests/electron/mock-server/routes/browser-lab-cases/drag.mjs':
    '2e2724a1a88784c283d31b7115e3df8a04f5e6849339a02bd74e16b51eadf5f4',
  // CAN-1570 phase 10b adds a Save control that posts the leaf editor's text
  // to a JSON echo route, for the document editor workflow.
  'apps/desktop-app/tests/electron/mock-server/routes/browser-lab-cases/editor.mjs':
    '85b925253df873b9c5c0b8562df3b95de820596a54cef59b341aa2d242d869d8',
  // CAN-1570 phases 04 and 04b add seeded-secret and visible-note controls to
  // the frames and shadow cases.
  'apps/desktop-app/tests/electron/mock-server/routes/browser-lab-cases/frames.mjs':
    'fa43d34a0cfd0e88e37cf7ad891c4b0822ef330d2df3e5e140d5b5d5c2525fe4',
  'apps/desktop-app/tests/electron/mock-server/routes/browser-lab-cases/heavy.mjs':
    '2693cf26ad646ef9304d28c7d5d99a8caddc33395a0bb3f2d5873a497d9e7b72',
  'apps/desktop-app/tests/electron/mock-server/routes/browser-lab-cases/hostile-transfers.mjs':
    '2d8b286de6b10916f3203c89db3667f698bc69a910dac359ae3075e4703c8474',
  'apps/desktop-app/tests/electron/mock-server/routes/browser-lab-cases/menus.mjs':
    '81a9e00cc21fbcf39ea357cf3c926068c147caf2e89b95ba8792a29cba51beca',
  'apps/desktop-app/tests/electron/mock-server/routes/browser-lab-cases/popups-permissions.mjs':
    '9a8420893dd34e2bcce46b077bfa3f9ec25ba670c298359af9c55f75e5dffb3b',
  'apps/desktop-app/tests/electron/mock-server/routes/browser-lab-cases/print.mjs':
    'c14e39667b60b8c54d7f776d1d575676a3244eb00c69205a3f4a7c034b6c6c14',
  'apps/desktop-app/tests/electron/mock-server/routes/browser-lab-cases/scroll.mjs':
    '3e117e1ae2a5edac9a278dc77453a1f6bba0f7a7a1bd2a4bd41a20ed6428763e',
  'apps/desktop-app/tests/electron/mock-server/routes/browser-lab-cases/shadow.mjs':
    '8dc7039fcf189af9504e431f27a8a5847e8e5869dff730c9cf7b450540e57283',
  'apps/desktop-app/tests/electron/mock-server/routes/browser-lab-cases/typing.mjs':
    '74c1a4b55676b5ecb3c7ff3348d12d8f5e6fbccb76947abbc63ea461597b95d7',
  // CAN-1570 phase 08c adds a drop zone that a cross-origin frame fills, and
  // that frame's own drop zone, to the upload case.
  'apps/desktop-app/tests/electron/mock-server/routes/browser-lab-cases/upload.mjs':
    'c839bb171560f2ef0b8b3b85989a4f39d5b2ca89880c13a3fa78a28f0753e684',
  // The Agent Ledger scenarios (phase 15) seed their Ledger through this
  // fixture.
  'apps/desktop-app/tests/performance/ledger-fixture.mjs':
    '006b561a7d1525fc9d239c974b0239a76081210a665426815cdde1db8a02f1f0',
});
// PR #4621 adds a pinned-items seeder through the shared seeder index. It is
// part of the current harness closure but was absent from the original study.
const ADDED_PR_HARNESS_IDENTITIES = Object.freeze({
  // CAN-3753 extends the transitive harness with host evidence and local smoke acceptance.
  'apps/desktop-app/tests/performance/host-measurement.mjs':
    '22a2d849f2c7f915a6648619eab29cb80c8ce06f692ec15d1a1d01426f132187',
  'apps/desktop-app/tests/performance/smoke-acceptance.mjs':
    '6cac5b77bc724aae3af55e6082bf417e3b7e6c9cfdc8589f1e57e6a5322819ea',
  'apps/desktop-app/tests/electron/seeders/hostedSettingsCloud.mjs':
    '7727df3daf3f476fa3a8d1659dd4e853c703c0a92e7cc49347a6bf48199d3288',
  // CAN-4532 extends the hosted settings fixtures for the Projects page;
  // CAN-4553 adds organization membership routes and an invitation fixture;
  // CAN-4558 matches production's organization lists and memory header.
  'apps/desktop-app/tests/electron/mock-server/routes/hosted-settings-fixtures.mjs':
    '37b9d625ef77f7e8f33932c62decfd8a9fd12da1989fe257226dc8609c9cf832',
  'apps/desktop-app/tests/electron/mock-server/routes/hosted-settings.mjs':
    'e7b18506d0bbe33f47da7b098c13a374cb19058b9d01cdce5bfcfd8b62d84461',
  // Cost's fixtures and their transitive seeders join the current closure.
  // Keep the closed study's original identities unchanged.
  'apps/desktop-app/tests/electron/seeders/seedCostInsights.mjs':
    'e152f221243c83be25e4d5a28044d502c05472dbe2d971ee7f310c9f29d3899f',
  'apps/desktop-app/tests/electron/seeders/seedEarlyAccess.mjs':
    '6c5bc0ea2a4754332d6d2cd81740f90779601ff6f249cca54315477d09d813d9',
  'apps/desktop-app/tests/electron/seeders/subagentViewerCapture.mjs':
    'c75266f465bb35d5568246d073439151a5d3bf9b4aac2e3b09627e485e7ca7e1',
  'apps/desktop-app/tests/electron/seeders/subagentViewerRecords.mjs':
    'ac0b028a428e694052d1321142d70585f19e55246e3fd990e6e205cb8c11ce7b',
  'apps/desktop-app/tests/performance/cost-index-fixture.mjs':
    'e64956dc86938be3a581ecb521857a311381b46fe30d8ecb1d1ea1e35a0c788d',
  'apps/desktop-app/tests/electron/seeders/seedPinnedItemsFixture.mjs':
    'c2cf38ee1613b22826c71b89ef68256d3613d01b0deb9c5d9dbb845f57c1a9ce',
  // CAN-3804 holds the worktree scenario's checkout at a Git smudge filter.
  'apps/desktop-app/tests/performance/worktree-git-gate.mjs':
    'e6df795505869a09eba919a089330356dcc5aad77db5a1c78a9b50b3c4a3af49',
});
// Later fixture changes extend the shared harness. Pin their reviewed current
// compositions while keeping the study's original/installed identities intact.
const REVIEWED_CURRENT_HARNESS_IDENTITIES = Object.freeze({
  // CAN-3606 extends the Linear mock with bounded issue attachments; transcript
  // reference previews add team-key catalog and exact-issue routes.
  // reviewedLinearBaseline strips them to recover the study's original bytes.
  'apps/desktop-app/tests/electron/mock-server/routes/linear.mjs':
    Object.freeze({
      e7784a752425a492af075f427559a6b87997050c753ee5d6602bd177d14bb507:
        'a843e2d31f599f1c37e5411da4b123e41c27e34627200aef950cfdeae504fadd',
    }),
  // Copilot device-flow routes extend the shared mock server after the study.
  'apps/desktop-app/tests/electron/mock-server/control-plane.mjs':
    Object.freeze({
      '26151d75fd5f5113976d7828ec8de5eee3ce04b6f56eadf547695adb39356bb0':
        'e746b5a24cd7b8b5a251f338068ef4adf0c5e96556251bcd4d02eb793fff45b5',
    }),
  // CAN-3707 adds merge queue responses to the reviewed GitHub mock; CAN-3781
  // adds pull request watcher responses; CAN-3838 adds the merge queue timeline.
  'apps/desktop-app/tests/electron/mock-server/routes/github.mjs':
    Object.freeze({
      '8133d1c52c17c84cb8f5ecd82842d197b7b5af257326fd1b5ce1415d84b0eae5':
        '893dcb0402469bae6597e02a17d94b80db98b0a5c47c78afcff8beda942c596b',
    }),
  // Project template checklist coverage (CAN-3032) seeds built-in marketplace
  // plugins in the plugins cache, and the additionalPlugins docs now describe
  // `details` and `facets` rows for member previews; preserve the original
  // study identity.
  'apps/desktop-app/tests/electron/seeders/seedPluginsCache.mjs': Object.freeze(
    {
      '5261125033d1822c48e072da6c32aec28f42441c48416c282f58210b366c3ef5':
        '8a4926e6d2c0f7dce21c5b1b3a8d3cd8604c80e6584eddaf20e19ac66e6b43c0',
    },
  ),
  // Codex speed discovery keeps full model/list service-tier records in the
  // mock response; Cursor policy-refusal coverage adds the optional
  // AvailableModels route. Preserve the closed study's original identities.
  'apps/desktop-app/tests/electron/mock-server/routes/authUsage.mjs':
    Object.freeze({
      '4c8c7811d599950a3db18e2456bd3b5c19f976dedbb3052979ec1f524de76fec':
        // PR #5286 adds an opt-in Retry-After response header to usage fixtures.
        'cf3fd4c3b62f8bc037365a83555ac94202eafa28b3c8cab2cd9d76b9fe30f68e',
    }),
  // Start-page recipient coverage extends the shared-container seeder while
  // preserving the source identity used by the closed performance study. The
  // reload check keeps the seeded Launch command alive until revocation.
  // CAN-4187 can seed a web page into the publisher's preferred layout.
  'apps/desktop-app/tests/electron/seeders/seedSharedContainerRecipientReplicas.mjs':
    Object.freeze({
      '8c6ccc783e0351d804ad8cebdf5d3329fd81ef638e034cd7071e7f51a124881c':
        '2c0c974c3a3dcbb9453f2bb6b1d084e03b22d7223ede0c1e6bd2b03a72d6b7b2',
    }),
  // CAN-3486 lets the curated pipeline fixture hold list responses while a
  // refresh is in flight; keep the study's original identity intact.
  'apps/desktop-app/tests/electron/fixtures/curatedPipelinesCloud.mjs':
    Object.freeze({
      '45d0a2980f5fa48c899d4111d357184887c7a281a30710bda00d07124926d993':
        'f90bc544429d327b3d0b5be942e9a2807626c02222737876c18ee92b96aba6d9',
    }),
  // Stress transcript coverage now seeds a supported GPT-6 Sol model.
  'apps/desktop-app/tests/electron/stress-transcript-fixture.mjs':
    Object.freeze({
      dc0d8f1bb92bb2b7a5fb9747e3141b49e513c764a49e9eb14755d508e7ff1131:
        '0b859bde4c37e5964874e88a52419ab787e3d46ef0edbe896f2fe13d71de4460',
    }),
  // Project template checklist coverage (CAN-3032) adds template stamping,
  // starter prompts, default plugin selections, and index merging to the
  // cowork seeder; preserve the original study identity.
  'apps/desktop-app/tests/electron/seeders/seedCoworkWorkspace.mjs':
    Object.freeze({
      '72f1500fb176e3d769f39189d227a108b9c78d25028f4393158f3702c06cd8af':
        '70ecdc752d747535445d6ad545197b36a9e1029c89c45917a6cfb9dc2791993f',
    }),
  // Chat history import coverage adds a canned memory profile helper response,
  // tool observers read Codex 0.159's `additional_tools` input item, demo
  // videos key marker-less prompts as `prompt:<line>` scenarios, phase 05
  // lets a scripted tool call carry its own tool-use id, and plan-mode
  // coverage lets a scripted Write take the plan file's path from the request.
  // CAN-3637 (PR #5135) lets Codex reach the real credits broker in mock runs.
  'apps/desktop-app/tests/electron/mock-server/routes/llm.mjs': Object.freeze({
    ec36d6173928a2287919f890193adc0304cb1854d711c2634929263853a300dd:
      'f2a17499ff701c4722f4964d4c58e195a0b6e9b211eead7e31c7d3a395efa59e',
  }),
  'apps/desktop-app/tests/electron/mock-server/routes/cloud.mjs': Object.freeze(
    {
      '5ecddb7775f6dbf09c571134998ffc94d31e66e0d67b66cf68e2624dea2c43ec':
        '0ed78545ce732798f21f8cdd06213c79986b29ba0b76389ee15eff586b341a3a',
      '9fd0d3e1514673a37905a05fe244396d7b1cffc1062eb26ec8617321db4d54f7':
        'f6045dbda2c321f28f8993235d4f2047e04d18bc60602b12c91d870c3ba887cf',
      // The shared-container fixture now exposes the organization's external
      // sharing policy and optional team membership for share-dialog coverage.
      // Automation share coverage also delays mock writes to exercise saving.
      // CAN-3388 adds an optional per-scenario delay to the org project catalog
      // route so the org-view flip can be reproduced; it is unused otherwise.
      // CAN-3448 adds per-scenario shared-automation summaries for context
      // scoping, optionally paged so the Shared tab has to page past a page
      // with nothing for the selected context.
      // The organization-project routes also record converted-project activity
      // moves and returns (CAN-3418).
      // CAN-3457 gives the memory-owner spec its own API key and records the
      // organization selected for each mock memory search.
      '80fea9cd834b7b68450cd17d7adfbf6b0b71a779e647bc8908cff0e40471e545':
        // The merged fixture includes org default Chats, converted-project
        // activity transfer, and organization-scoped memory search routes.
        // CAN-3459 uses a UUID for the telemetry-locked organization fixture.
        // CAN-3489 adds the member repository refresh route, which can list
        // scripted repositories "created on GitHub" in a catalog.
        // Project setup claims, completions and detaches are also counted per
        // project, so specs can exclude the default Chats claim (#4159).
        // CAN-3453 adds private member Cowork project creation and a simulated
        // project-claim failure to the cloud mock routes.
        // CAN-3515 records telemetry ingest destinations for scenarios that
        // opt in; every other key keeps the unhandled route. CAN-3517 adds the
        // activity-return route for the scope repair. Default Chats ensure
        // calls from unregistered credentials get their own scenario instead
        // of writing into the frozen shared fallback (from #4229).
        // CAN-3464 gives the model-policy organization a valid UUID for
        // gateway-ownership coverage in the shared cloud mock.
        // CAN-3324 defaults public publisher discovery to an empty catalog.
        // CAN-3532 adds private member multi-repo project creation.
        // CAN-3533 renames Plugins to Marketplace and adds Automations as a
        // Marketplace kind, served by the curated automation catalog routes.
        // CAN-3534 creates and adopts local Code projects for org members,
        // CAN-3546 creates organization Multi-Repo projects by name, and
        // CAN-3568 adds optional shared-pipeline capability overrides.
        '3914e3bc31665221b9dfad05d9026ce1e153ea346dea06feb5f424d750307b0a',
    },
  ),
  // Share-dialog and link-sharing coverage extend the shared-container routes;
  // seeded owners take their name from the scenario roster. CAN-4052 adds the
  // recipient's recoverable share removal and restore routes. CAN-4266 serves
  // empty signed-in listings for accounts without seeded shares.
  'apps/desktop-app/tests/electron/mock-server/routes/shared-containers.mjs':
    Object.freeze({
      '5cc71d2e9400c2548e75d18bde4455605720aaff7e1014b45bc8abd80d55f629':
        '15ca8e02098cc3d4a34483acd6e957b37bdecfa25620eff6ce1399e338961e84',
    }),
  // The shared mock server now catches failing route handlers.
  // CAN-3522 serves offline organization logos for the scope switcher.
  // Plan workspace panel fixtures dispatch the shared-plan routes.
  'apps/desktop-app/tests/electron/mock-server/start.mjs': Object.freeze({
    '588706289cf2b6b46f2e1fd583b30030ae88025433c519329b2a2e83198cfc89':
      '637c2267218e7f69a3dbf5ba1f663d1ef5ac36003e09a0a4cd3196997383ed96',
  }),
  // CAN-3388 lets the org-context seeder add extra Personal clones of one
  // repository for the org-view duplicate-row coverage, and CAN-3416's
  // organization-context env opts out of automatic conversion. CAN-3461 adds
  // Org B for context-scoping coverage. CAN-3846 adds explicitly owned Org A
  // repositories/worktrees for the post-pass combination ownership regression.
  'apps/desktop-app/tests/electron/seeders/seedOrgContextScoping.mjs':
    Object.freeze({
      fbbe9d20d09e7a8826a5cf6a9e08217102bab47adcd67eef944207d159825363:
        'f0c080893291c7176edb5b8125c918bfa7e263ea8a3e652063e07dd4a6e315a2',
    }),
  // CAN-3463 exports the organization-owned workspace seeder, and the plan
  // workspace panel fixtures re-export the tracked-plan and shared-plan
  // seeders from the index.
  'apps/desktop-app/tests/electron/seeders/index.mjs': Object.freeze({
    '9e70d5f1e698eb7c3f67af325031c911fd439c55f3605d1319615647cdb43cc1':
      'd346d74b5678eaf2d12826e689b7011a745e715b849dcee142d8c925374fce78',
  }),
  // The work-counter metric layer adds count metrics, a renderer work-counter
  // session, the counters profile and its local ratchet to these helpers; the
  // app-side counters then add the IPC, chat-storage, provider, and React
  // sources to the monitor, the scenario brackets, and the results. Phase 06
  // adds the repeated-sample three-way comparison and the interleaved driver.
  'apps/desktop-app/tests/performance/compare.mjs': Object.freeze({
    '9c45997ac0311bc500b5a92b17ba7923343e6f92be7838a5a28bbd9d9b3fbff5':
      '0faaceaedbf4d7a0798587195717c5214eb23253b4ec2ffe5a77ec6b97db0d3b',
  }),
  'apps/desktop-app/tests/performance/comparison.mjs': Object.freeze({
    '7b29a5bb0bc2f2bc380b07d74388a2c1c29375356241cb0c72153081aa1ddf67':
      '5067ad7b1b30ab1b6e4fad321aac84525c0381bdb8237db92b0777af49f479b7',
  }),
  // Phase 05 adds the opt-in Long Animation Frame observer, per-reply frame
  // budgets, the display refresh rate, a spread-safe frame summary, and
  // retried main-process counter reads.
  // Regression follow-up: timed runs no longer estimate IPC bytes; only the
  // counters profile does. CAN-4307 keeps the window's routed-read counters
  // as `summary.routeWork` evidence; they are never bracketed or a metric.
  'apps/desktop-app/tests/performance/monitor.mjs': Object.freeze({
    '909b52498c7a3ade1f4d6eb9e2fa5ee742e50dd85ad55e2833741b505de7eba3':
      '078c8f8ab1627b82c22047d9cbc781944fbf194ac3b6437b7998b72143685d27',
  }),
  // Phase 05 adds the opt-in scenarios, their scoped sizing keys, and the
  // startup trace option; phase 06 adds --repeat and --e2e-root; phase 09
  // adds --chat-delta-journal; phase 17 adds --renderer-code-cache-scheme
  // and --warm-launches.
  // The opt-in Agent Ledger workloads add their scenarios and scoped sizing
  // keys beside those; defaults are unchanged.
  // CAN-1570 phase 03 adds --browser-actions-iterations and the opt-in browser-actions scenario.
  'apps/desktop-app/tests/performance/profiles.mjs': Object.freeze({
    '99559a2c82b97167abc7ed6459c05fdbe3f36f7c876d9c28fad64f1716612ad9':
      // Compose CAN-385 backfill with foreground-first streaming scenarios and
      // the CAN-1570 opt-in browser-actions and browser-agent-actions scenarios.
      'edfe8b821b674a87b99a98c627c3f9aff99650d4a3ac9980033a59cd1c9bf2f0',
  }),
  // The disk work source joins the work metric sources (phase 04); the
  // code-graph and scaling sources and journey timings follow (phase 05), then
  // repeated-sample metrics (phase 06).
  'apps/desktop-app/tests/performance/results.mjs': Object.freeze({
    '3db81289f98f79850d8b483eec1986efe3fb6d850592ef4c17385dc822cc6ab3':
      '9676b31b6707037cf8801d155bdbc2d0ec788feb1908178084b6e34d2b0affb6',
  }),
  // Phase 05 prints the scaling ratios and the startup journey; phase 06
  // adds repeated samples and another checkout's E2E build; phase 09 seeds
  // the delta-journal preference; phase 17 records the code-cache scheme
  // and warm-launch caveats.
  'apps/desktop-app/tests/performance/run.mjs': Object.freeze({
    '9d6816edaef9949be3326f57eb346c057e3f12d5a602758fc8496c17e2a3a9bb':
      'a95853e0e115665bc93dbe6d8b50f7ff60061eebccdb94edea64e55145f9250a',
  }),
  // Benchmark scenarios sample per-process disk bytes in the measured
  // window; the hidden browser-profile study does not (phase 04). Phase 05
  // adds the multi-chat streaming and code-graph journeys, sized active
  // turns, startup journeys, and frame-budget brackets. Phase 09 seeds the
  // delta-journal preference; phase 17 passes the code-cache scheme switch
  // and primes repeat-state startups with --warm-launches.
  // The opt-in plan-open workload adds a scenario and its profile keys; the
  // mock server dispatches the shared-plan routes. Defaults are unchanged.
  // Phase 06 S5 makes the `plan-open` driver surface-agnostic
  // (`planOpenSurface`) so the same bytes measure both the takeover and the
  // Plan panel.
  // PR #4470 waits for native browser readiness before first navigation and
  // navigation after reopen; both stages install the same corrected driver.
  // The Agent Ledger workloads add their panel and disabled-idle drivers.
  // Phase 21 retries the typing probe's composer clear and fixes two timing
  // assumptions: `worktrees` snapshots existing rows after they render and
  // clicks the listed row instead of its hidden pinned copy, and
  // `code-graph-concurrency` confirms overlap once every request is admitted
  // and waits for derived analysis to release the queue.
  // Regression follow-up: only the counters profile asks the monitor to
  // estimate IPC bytes. CAN-3980 opens Pipelines through its page shortcut
  // now that the sidebar row folded into Workflows. CAN-3981 also accepts the
  // Workflows Library page that the shortcut now lands on. CAN-4307 adds the
  // opt-in CANOPY_PERFORMANCE_DATA_ROOT_PARENT; unset keeps the temp directory.
  // It also records each scenario's pinned client flags (on unresponsive
  // records too) and copies the routed-read evidence into `work.route`,
  // outside the work metric sources.
  // CAN-1570 phase 03 adds the opt-in browser-actions scenario, which starts an isolated Browser Lab server.
  // Phase 04b measures browser-agent-actions on the production snapshot path.
  'apps/desktop-app/tests/performance/scenarios.mjs': Object.freeze({
    '6c4cdbe1a0abcf6f63077a4f2657dd6314c2c2331f82f2061b81afdfdc96ac86':
      // Compose CAN-385 backfill with foreground-first streaming drivers and
      // CAN-3753 scenario cleanup that preserves failures during app close,
      // plus the CAN-1570 browser-actions and browser-agent-actions scenarios.
      '03f478d72bd0159939e8d711fd32cdb39a56f71de88734e42285a25598187f54',
  }),
  // Regression follow-up: a timed run records no IPC bytes, so the Codex output
  // ratio is unavailable rather than a flat 1.
  'apps/desktop-app/tests/performance/scaling-ratios.mjs': Object.freeze({
    '73a17e278ea268de44a429b9a9daa8941d47901833a3c14140dd7c7a77599e54':
      '124a1141a3d6e256e7be0261e510e2f1a8c96f5fab4edfe6276bf093161afc73',
  }),
  // REG-3033 lets the curated plugin seeder take `pluginDefs`, so a spec can
  // seed a plugin that folds into its integration card. The study's seeder
  // identity stays pinned above; this is the reviewed current composition.
  'apps/desktop-app/tests/electron/seeders/seedCuratedPlugins.mjs':
    Object.freeze({
      '5395ab3bc9ee12656266cc03d3de649d1fe5da075c489b85a7048724c32d174f':
        '1c8ebb49c8d3bb95ca0fee31ae43b42a3220b8b9b97557059555338ce5a84aa1',
    }),
  // Injected pipeline events now carry their input pause checkpoint. Retain
  // the study's original seeder identity and pin the reviewed current bytes.
  'apps/desktop-app/tests/electron/seeders/seedPipelineExecution.mjs':
    Object.freeze({
      f5e8f97569647201d7635d502b5cb721ec20ee2cfe2c8c9214bb39e8abebb961:
        '31748ae7e78be9b3429f93ab319288f97ac55391155c12ce53d6f3fdba3f696e',
    }),
  // Demo seeding drops inherited repository Git env vars and refuses a path
  // that does not own its Git directory, so it cannot configure the caller's
  // repository.
  'demo-apps/lib/git.mjs': Object.freeze({
    dd68843f3563b4032413368eeadc369dcc0c9ca81010105cfabf85185ccd3721:
      '6bfbd61985893654924b066533f526acd28ead8dcdbbf2e1547746039c45ddde',
  }),
  // Phase 16 gives App Advisor its own renderer page, so the window evidence
  // accepts app-advisor.html?surface=app-advisor beside index.html.
  'apps/desktop-app/tests/performance/browser-profiles-evidence.mjs':
    Object.freeze({
      '5746d0a79c90fb6963b83b8d727388bfe30905a69c9a26dfb1a934c0d7c7fdf8':
        '4af2354caaa78098dbc1de4fd0f6328f0ac93786f6df2fd91abffa9c2f89ce71',
    }),
  // Phase 17 adds the local-only CANOPY_E2E_RENDERER_CODE_CACHE_SCHEME switch
  // that seeds the code-cache scheme experiment, expects its window URL and
  // gives that launch its own Electron --user-data-dir.
  // The develop sync brings 18cc0b87ad's per-space notification menu
  // coverage into launchCanopy.mjs on top of the stack's changes. The Cursor
  // inherited-capabilities fixture also isolates the simulated user's home.
  // The merged launcher also passes the opt-in application's arguments,
  // and pins the device remote-control flag on (CAN-3755).
  'apps/desktop-app/tests/electron/launchCanopy.mjs': Object.freeze({
    ba654cacd0b7c2a841cdf6ffb57e1238a69609771f1f19481f5e924a09e667ec:
      '570da6af1143ceac8acbad587a6bd2350ca8f00543d2fa9bc41f96391113d6a0',
    f5ac00a1ab88f5df076ddfee3b5a8f51f0170686c765b239f66ad0005a31291b:
      // CAN-3122 autocapture and CAN-3755 remote control share the E2E defaults.
      // PR #5286 sets only the E2E Claude usage freshness override to zero.
      // CAN-3662 pins Labs early access to offered in the E2E defaults.
      // Native window identity is also rechecked on load.
      // CAN-3678 seeds the page experiment defaults.
      // CAN-385 pins skill suggestions on in the shared E2E defaults.
      // Frozen study identities and original-source proof stay unchanged.
      // CAN-4386 pins the hosted settings flag on in the E2E defaults.
      // PR #5730 pins the external-agents menu on in shared E2E defaults.
      // CAN-4455 isolates the test renderer from an inherited Crashpad pipe.
      // CAN-4266 drops the retired Labs Agents page flag from the E2E defaults.
      'a4ee92c012e743bd7aa8e0a748ff1c22d9e81848a5ffcba65f7d31c8cd75bc98',
  }),
  // CAN-3972 adds Home Getting Started checklist helpers to the app driver
  // while the sidebar card is hidden on Home. CAN-3980 adds Workflows tab and
  // Marketplace "Shared by me" navigation helpers.
  // CAN-3981 adds Workflows Library search, row and New workflow helpers.
  // PR #5101 adds the first-run import page's skip helper.
  // CAN-4072 adds the full-page Workflows edit shell helpers.
  // PR #5369 adds the edit shell's More menu and delete confirmation helpers.
  // PR #5404 opens Environments from Settings instead of the sidebar.
  // CAN-3678 moves page features behind Labs experiments: More menu and
  // Settings → Labs helpers.
  // CAN-3659 opens Remote Control from the account menu.
  // CAN-4421 adds consolidated Settings rail and hosted settings helpers.
  // CAN-4260 renames the plugins page heading from Marketplace to Customize.
  // CAN-4266 opens local agents from the Marketplace Agents tab.
  // CAN-4261 merges the shared Installed rows and breadcrumb navigation.
  'apps/desktop-app/tests/electron/canopyApp.mjs': Object.freeze({
    '2ce655e6a2782cb311f928f95ba62f854d17f4d4d1318e896ccf9eddac20dc8d':
      'e777bcd14b37cddd0ebc7c06abf80614a32fa059892eff8681aa3005e868439d',
  }),
});
// CAN-3534 extends member project creation to Code projects. The PR merge ref
// also includes CAN-3324's empty publisher catalog route. The latest merge
// includes CAN-3533's curated automation routes and model policy fixture.
// Pin the reviewed compositions without changing the closed study identities.
const REVIEWED_PR_HARNESS_IDENTITIES = Object.freeze({
  // CAN-4605 rejects incomplete disk snapshots and missed sample intervals.
  // Preserve the closed study's absent baseline and installed helper identity.
  'apps/desktop-app/tests/performance/disk-io.mjs': Object.freeze([
    'a67ab4302f12b71f2eb84faaf4c865c029fce2ab0f88edf5dbcbf0016c535f98',
  ]),
  // Foreground-first phase 06: the interleaved driver forwards the opt-in
  // foreground-first switches as flags, to the scenarios that read them only.
  'apps/desktop-app/tests/performance/compare.mjs': Object.freeze([
    'f3575723b4772134ffb407ff2da86344069594036c7c9501db7630ab02b6e0ad',
    // Foreground-first delivery graduates: --foreground-first-delivery is gone.
    'e1b1389a5c61662cf26aac54c567e161402824b2e4adcc4b04cff1c022d1e5cb',
    // CAN-3753 local smoke acceptance.
    'e2f29bf58385652d6d5e8ed97a686ee321c7c2f2d7ef8979fa56b9f1cd6ba02b',
    // CAN-3753 local smoke acceptance composed with foreground-first switches.
    '277c1cc38d77a08f8a97e5d20027353878a2adb66ac4f812385c5fb317638bcf',
  ]),
  // CAN-2053 rejects scripted responses when forbidden repository instructions
  // reach the provider. Preserve the closed study's historical fixture hashes.
  'apps/desktop-app/tests/electron/mock-server/routes/llm.mjs': Object.freeze([
    'ad3e01dbc7656f11a6fc84550b3b8d6b76a5cdc403009a6e68676ab2f28c2ba9',
  ]),
  // CAN-3662 replaces the retired preference with durable Labs choices.
  // PR #5422 seeds cache tokens for the cost token label assertions.
  'apps/desktop-app/tests/electron/seeders/seedCostInsights.mjs': Object.freeze(
    [
      'ad5886f5455285856539254fbe1fde4c7bfc6ae91bf2ca50106247d8163ff997',
      'ccaa70de629282d3d650439438d8e7b2d9bb6036be7a620dd016dc682c53fbd9',
    ],
  ),
  'apps/desktop-app/tests/electron/seeders/seedEarlyAccess.mjs': Object.freeze([
    '416e1fb3cba46281cdd2951ea4a8d90a4808ba04da83e0ce5d96e4e8ae04b5cd',
  ]),
  // CAN-2798 normalizes ps creation-time rendering across caller environments.
  // Preserve the closed study's original and installed supervisor identities.
  'apps/desktop-app/tests/performance/process-tree-supervisor.mjs':
    Object.freeze([
      '22623fb692fe4a827b0134bb91a3133e91d74ddacb302362b1f504ab56c9cdee',
    ]),
  // PR #4824 composes merge queue and watcher GraphQL responses in the shared
  // GitHub mock. Keep the closed study's original and prior reviewed hashes.
  'apps/desktop-app/tests/electron/mock-server/routes/github.mjs':
    Object.freeze([
      '6fe02a9428f909c3cda815fd70ecc4db53ec1c76d9318e20563cad8382222d13',
      // CAN-3979 adds GitHub transcript reference preview responses.
      '549fcb341c8fdbaac5f5b49a09b5cb842648cb878839ade71abf78ec5baa2f4b',
      // CAN-4529 adds pull request search responses.
      '231c36cd058ff5922ed0c9753eceec2da2a529ab7f76bd555713ddd1dc6626c8',
    ]),
  // CAN-4529 caches parsed JSON bodies so routes sharing /graphql can inspect
  // a request and decline it; the Linear mock reuses that reader.
  'apps/desktop-app/tests/electron/mock-server/control-plane.mjs':
    Object.freeze([
      '8acab84ea9371142075c38bd33e6a91fb7a29e9a6c3fc44c70796557201cb063',
    ]),
  'apps/desktop-app/tests/electron/mock-server/routes/linear.mjs':
    Object.freeze([
      '246ce4fcefec010d2e733b0cbc9447626cd365c7a512b5b681aa2a2ceb164b63',
    ]),
  'apps/desktop-app/tests/electron/seeders/index.mjs': Object.freeze([
    // CAN-4386 exports the hosted settings scenario helpers.
    '15f0a2c58d77028dc8de5c70d0e8ab7de87462e5738d0a5a42f5f590ff64bcc1',
    // PR #4973 exports the Cost input fixture from the shared seeder index.
    'e5f94ace491210bc816c9272721a87114ff184a80f8bc302740458fa53b3638e',
    // Forced journal cutover removes the retired experiment switch and seeder.
    '382f4a6c3bd2bd75d92f8094b68a272768b5269005b8b5b792679b5671eb1211',
    // PR #4621's pinned-items export composed with develop's journal seeder.
    'bd62053fad1e5b4757a255c59462e107407a5e065120d9451047160bdd20f5c8',
  ]),
  // Sidebar groundwork isolates the native production profile and skips the
  // E2E-only activity hydration shim for the already-expanded loaded fixture.
  // Pin these exact bytes; retain all historical study identities above.
  'apps/desktop-app/tests/performance/scenarios.mjs': Object.freeze([
    // CAN-1570's browser scenarios composed with the reviewed shared Add-menu fix.
    '1f028e0299e7bc5fab11b4fe1a714c10654b4cd13047dd0885f880cbd20f2729',
    // PR #5966 matches the plugin picker's `Search by name…` placeholder.
    '609d03b8e7560aa66696c53aea2c947d41d79d20fda752239550ec1243962985',
    // CAN-1570's browser scenarios composed with PR #5966's placeholder text.
    '995e02260eb7b1bf57e25038efaf2e41c89675245c9cf29fe6a1c6e878a86b7d',
    // Graduated filled rows open the browser Add menu from the tab-strip control.
    '90b4bb2d083ddc1c214758e5fc303e4ebd9618a80b814b6882aa2fee3331314d',
    // CAN-3753 keeps the scenario outcome when the app close step also fails.
    'cf69203c2be7f26673bcde5e009ce7499bb9444f06714e4a05d4cf35519a90ad',
    // CAN-3753 close-failure handling composed with foreground-first scenarios.
    '036bdb00db3da07961df8602eac9625d7857c7efba1a46d96db91bbcf81ae5ad',
    // CAN-3753 local smoke policy composed with current develop workloads.
    'e8347775271c8e0bad13f8a0d52c5f7da0f04fb635824bf2a400626a76e7dfb3',
    // CAN-3753 separates local smoke acceptance; strict study verdicts are unchanged.
    'e4bacc8a97ea734211c570287e6f67d0141abe9c14fe067cbd1601faea1d2c87',
    // PR #4973 adds the opt-in cost-index-first-build workload.
    '7009cef212a0ca62fd8c95dcfc83423c1377c39ea83e94b930eefaa1baa4b733',
    // Forced journal cutover removes the retired experiment switch and seeder.
    '572af6533655e3def54aa859aa670787ac81f2e666319239b71f5291a3f95d2c',
    '95b9c41cb81af3110f8a9b6fdc00cbdeaa2588907038ba1000b34aee2771cb73',
    // Merge composition preserves both reviewed scenario changes.
    '28430fd0433c013db0385fe742a00f5e11b24d897341e626b891a9ad2a303e18',
    // Develop merge composes release-like Electron arguments with startup
    // trace arguments without changing the closed study's source identity.
    // The counters profile now estimates IPC bytes in the merged composition.
    'a25d697b0be6d5e7ff7521650cc9186905b6adb2c457bb366eb6cc5f0b13c544',
    // Transcript reference previews add the opt-in linear-reference-transcripts
    // workload.
    '33e5a39d15ae79225b6fc880c003f916b975c0988be0f45fdeee25e17b94a4c5',
    // This merge composes the Ledger and reference-preview scenario additions.
    'b2895e68050e6a8e0ccadecd35251f5a644c3d090bd8e50d0ee13ff2c19b8537',
    // CAN-3840 adds matched enabled-reference probes and release-like coverage.
    '0832d55a84836489840a2d343900efb34dfb2c8b02a729b548404f05db033bd8',
    // The Ledger and reference-preview scenarios composed with CAN-3840's
    // enabled-reference probes.
    'a76c61e29c4fd1080a674c654d349be5660e8e884152b1df55afd7b0a7003aa8',
    // Adds the opt-in managed-delegation-concurrency scenario and refuses
    // chat-search-indexing in release-like mode.
    'd931a75c8a6d9c8a4773c2cea541b49357202b88fadd3bb42c9f5a6b1e731318',
    // The managed-delegation-concurrency scenario composed with develop's
    // linear-reference-transcripts workload.
    '444ad2d8b8fd0d8fc33bca4021036eb9feff5c0a451ca850c6e3fdb32f5eda84',
    // The Ledger scenarios composed with develop's managed-delegation
    // concurrency scenario and release-like chat-search-indexing refusal.
    '84288786936e79e520e86727a3e702175dd6e5f72ff665fc26f6b2a65545a3ee',
    // Reads the brand tool namespace from the generated JSON on first use, so
    // Playwright can load the Electron specs that import this module.
    '7fdee9fc6d8c3fcf61b70b862dbca0a369eaa88b86ae23812fad1a918b3ecb83',
    // CAN-3804 holds each created worktree's checkout at the Git gate during
    // the worktrees scenario; other scenarios are unchanged.
    '96ad5a2536ca8e4dbf2c0277840306d25d7c311bbdc6e540e7422e75656cc1e0',
    // Foreground-first streaming phase 01 adds the opt-in background-streaming
    // and chat-switch-catch-up scenarios; other scenarios are unchanged.
    '8c0e0115989176cce332f55e8dd6f1e42a8905bb9beb65f144467831e20fccee',
    // Phase 04 seeds the foreground-first preference when that switch is set.
    '3b4b365a793c9701a8de6a3521f98a28de26db9c3baccaddcc32b3103dfd2dd1',
    // Phase 06 rests the pointer on the target row for --chat-switch-hover-ms.
    '29586ccf953dd59b3374da14e187ba7199bc06b0a6121ff0f2893108379fd760',
    // Foreground-first delivery graduates: no preference to seed.
    'd822fadeb9f99d89aaececeebe4586d4c2c015ace7550b2792329e7b51bfa557',
    // Compose foreground-first scenarios with develop's routed-read evidence,
    // short data-root option, and pinned client-flag reporting.
    '5972a87e4c7bceef9ff99e38954620dc847d680af894bc2f2984e2a59ff8194a',
    // PR #5894 accepts native dictation after clearing a draft while still
    // rejecting an enabled Send button.
    'a97538fff497564b635a286d1469d7bfe597a95aa9e2b03e3d0fb1fde07fc3b7',
    // File explorer and concurrent chat workloads use the graduated Add menu.
    // Task assertions, workload sizes, deadlines, and budgets are unchanged.
    'cce9bc792b30e92c226599af53b4e5ae06643e5caae28b7f676f119765dbd2b7',
    // Compose the plugin picker placeholder with graduated Add menu controls.
    // Task assertions, workload sizes, deadlines, and budgets are unchanged.
    '9176fbbeb078ed186588ca7ee8a7ccda6c20dd39c5fef14833a29bd558d9a3a2',
  ]),
  // The opt-in managed-delegation-concurrency scenario and its scoped sizing.
  'apps/desktop-app/tests/performance/profiles.mjs': Object.freeze([
    // PR #4973 sizes only the opt-in Cost index workload.
    'b2efbead6cb4008eec9b7794d2552efd9893d07190729b23b6bd18951e167878',
    // Forced journal cutover removes the retired experiment switch and seeder.
    '6865e2b97dd2a3474c5797a0516e54b034ef57ebbc22aecb61da4ed9c950c217',
    'f35a3da6b8ba3063bcdb1842eb5c28a88cc47c5429fcbc259361cf9615a5dbf7',
    // Composed with develop's linear-reference-transcripts scenario.
    '5ba936896779c0e670d708329014aefeca46fdcee26bcccdd3704405f4d7b792',
    // Composed with the opt-in Agent Ledger workloads.
    '5531dd72cc31643d574a250549a4e8cbf868f46bc9080f868f3f1abe0aa124fa',
    // CAN-3804 adds the worktree Git gate keys; other defaults are unchanged.
    '00cd2c4f0cad69f514534340936c59bf4042b9c0642a0681bcf5335aef2f6950',
    // Foreground-first streaming phase 01 adds the opt-in background-streaming
    // and chat-switch-catch-up scenarios and their scoped sizing keys.
    '53ca569eea1720afbb677b67828cc1b3a8d91149d554e3aa8b94a1c98c10bbfc',
    // Foreground-first streaming phase 04 adds the opt-in
    // --foreground-first-delivery switch for the streaming scenarios.
    'ee3ddbfd82d78c3f5ed72508efaa93cdecfe311d8f54e82382d766535d5cbcc4',
    // Phase 06 adds the opt-in --chat-switch-hover-ms switch and names the
    // scenarios each opt-in switch belongs to.
    'a725fcfaa636513318d1ac7417076255328413bafd1f96fb5a1dd3f5f8c25745',
    // Foreground-first delivery graduates: --foreground-first-delivery is gone.
    '8505542582d823d84ef7483af94111e9f6328c6ea88541259bb77feb7735da51',
  ]),
  // managed-delegation-concurrency needs both provider binaries.
  'apps/desktop-app/tests/performance/run.mjs': Object.freeze([
    // CAN-3753 local smoke policy composed with current develop workloads.
    '4270fa3776d53b7a77666b76a84cb448bc49bd2bd235eaf0c2168ffd8801dfd7',
    // CAN-3753 separates local smoke acceptance; strict study verdicts are unchanged.
    'ff158c7128f1f64deb031ceb9ba744e5bc28ed04abd9e5fbb6a49d91ede88d54',
    // Forced journal cutover removes the retired experiment switch and seeder.
    '905c783b0ec62134eccf50675245d09698c73ed5e6b08888d156910f9632b8b2',
    '606bae162cf63f33d16974dc1dced465d2157246f8e0080ed0656060ef663b43',
    // PR #5080 builds a failed scenario's record in the diagnostics helper.
    '8a4a81ff70a7ed3b76e8a053d7f27e34491cc1887940e337683abae4ec7c57ac',
  ]),
  // PR #5080 keeps window-selection evidence on a failed scenario's record.
  'apps/desktop-app/tests/performance/scenario-failure-diagnostics.mjs':
    Object.freeze([
      // CAN-3753 records a close failure beside the original scenario error.
      'a1c9674d926cb967537ecc8c75b74fc2a27adad3e67bb2e7c27a083862bd0c43',
      '23a839f7e12b84ef2b4b9407737a0b8984e2c77349a644407c403b14df940fa7',
    ]),
  // PR #4560 extends the share-dialog seeder with an expression-model fixture.
  // Keep the closed study's original identity pinned above.
  'apps/desktop-app/tests/electron/seeders/seedPipelineShareUnresolvedInvocations.mjs':
    Object.freeze([
      '1c07e0435fb2fb9330904adb849d6ff70d199831e7c62ee68a8cc09cc4d970e3',
    ]),
  // CAN-3615 pins the enabled space-notification flag in the shared E2E
  // launcher; the closed study still installs the same reviewed helper in
  // both stages.
  // CAN-3180 composes Linux isolation with the rebased launcher changes.
  'apps/desktop-app/tests/electron/launchCanopy.mjs': Object.freeze([
    'e85a95fe39748c34bb0209ba8d6ff47a6d2f433547710b04f531604b6ad77d0a',
    // CAN-3696 enables the OpenCode harness in the shared E2E launcher.
    '666366e47308534fec72981fae35ab884c1730b00178d0046db7f906e9a3d902',
    // The PR adds applicationArgs to the merged launcher for the opt-in flow.
    '3a24d464111541297019278a6b5af6c30e0a76cb80d7177fdc9821bde44ab7ff',
    // The chat visuals follow-up pins canopy-desktop-chat-visuals on.
    'bfc57a1a3f8293b8fe8dd8af7a57dc40ee62dc063d35d15186692e0091d194c2',
    // PR #4608 merged the OpenCode opt-in defaults with applicationArgs.
    '2eeb24b176f51704e709d3846b639cb8c46131e3ca934d73acd537585c059dd0',
    '37199d2e3480a086bf483a2d8f47e4e6a50216251233099782b66d4d10a751c4',
    // CAN-3180 composes Linux Chromium profile isolation with the merged launcher.
    '5a35415ce538aae879236d3ccdaf970f4edf00149a4741ce9f5ab8f9dbd5e76c',
    // CAN-3122 adds PostHog autocapture to that composed launcher.
    '3117e9e59ab65f59c82aa3483f5ba5165e47a37bbe160adf3997206bc330346d',
    // PR #4608 preserves those defaults and Linux isolation while enabling OpenCode.
    'd1127343f78c2ec72037e4f32e388008f33f2e7c1b95d704b03a21d1c0185ae2',
    // PR #5080 rechecks main-window identity on the page load event.
    '0c4ffe64d417b1c497e333297cda69cc44d03a5d425ba3529057098db9d098af',
    // CAN-4019 pins the account proxy flag on in the shared E2E defaults;
    // the flag itself defaults off.
    'aee7ce7f1071568cf2635961f8eb54b43442372a8753aa16534e0e6b6a17f576',
    // PR #5080 composes its load-event identity recheck with CAN-4019.
    '3df00c325de92a88b1011f1984bdfc4a5aa2c83fd69060b064e5580f66349ab8',
    // CAN-3755 also pins the device remote control flag on.
    'd8e8a73de58375636458e96b7cd73f1cdb3f1e4844fa998d7c42f0c4a1bbff93',
    // PR #5080 load-event recheck composed with CAN-3755 remote control.
    '5edb561bb2d685c83210489d4fdf5d1c294964ed371d60f540cc6bbcfe3c1f66',
    // The chat visuals stack pins canopy-desktop-chat-visuals on in that launcher.
    '99fa33da63b8cd56cd998fe428a56aadfe7f34312a742fc7c00f96d653e9968a',
    // CAN-3662 pins the Early access availability to offered.
    '2bde26558800312b79dbf27451a1cd9cf9e6b554b04b048de04710fe40d1d06c',
    // PR #5080 load-event recheck composed with the chat visuals defaults.
    '06905a97ce8e5068cb2515212fb1a5ed9fd535d30e0391db18906d0289890e7c',
    // Merged Labs defaults, page experiment defaults and native window load
    // identity recheck.
    // CAN-4386 pins the hosted settings flag on in the E2E defaults.
    '9c185c5345361d44a33d7f7064e1c5b4fab3d3cf1e9c9f7ff0d17e1c9d4e49fc',
  ]),
  // CAN-3597 uses the bound mock-server port in request URL parsing.
  'apps/desktop-app/tests/electron/mock-server/start.mjs': Object.freeze([
    // CAN-4386 composes hosted settings routing with the existing dispatch.
    '2a4d4a766337be7bb63e6147b52d6bd651fd0de4806576074c8804cec3c4adf4',
    '88b456247b464dd38aa3af1ce9ea9b8b23e1ff79f5e953e54f4cb043d4765e7f',
  ]),
  'apps/desktop-app/tests/electron/mock-server/routes/cloud.mjs': Object.freeze(
    [
      // Labs v2 migrates extracted choices and retains the v1 projection.
      '63bae839cc465acf55d5841f4d3b652216cdd3160aa74b259ceca3f3728c0846',
      // CAN-4396 serves the public curated MCP catalog to signed-out guests.
      '40b58dd1694c96bfab2567785f433911196b3da876a1251c7b7bc404ec71fdee',
      // CAN-2334 account preferences combined with CAN-4386 hosted settings.
      '92b9d4236b63bfb0e4a24d1661cdf73c22a2ed11fc7ce6144ef9e7ffefd3b405',
      // CAN-2334 preference routes composed with CAN-3488 publication tracking.
      '13bd8bfa4b33775f94e7fa32574f61548ddb097bdcd6dbb7da4b6fa10049ac6b',
      // CAN-2334 adds account notification preference reads and partial writes.
      '45396919b9dffe7c0766dc73eef8b3190d2be1e1ad9506cf9ad1a08b7fec4ec7',
      // Combined CAN-4386 hosted settings and CAN-3488 sharing recovery fixtures.
      '9bc758ce296ffa7dffa16a99f32bec6133a3b267ec682cba3530af9bd84c2bbe',
      // CAN-4386 exposes the account identity to the hosted settings fixture.
      'aaed081afe0c6ee86bff87ee93cc108c243d7f9684e50986d2d97fb7f7d09ed6',
      // CAN-3488 records skill and pipeline publication attempts for sharing
      // recovery coverage; preserve the closed study's historical identities.
      'dde5e3b79ca4718c62ccff94adedcdb6b349d68e1f02d6d278cd1dc887f85874',
      // CAN-3662 serves account-scoped Labs experiment choices.
      '63d5de981a3c8352a032a028dc425c5ef155435e0335368cec12d877e43e8615',
      // CAN-3706 adds opt-in organization promotion, invitation, and member
      // project sharing fixtures without changing the closed study identities.
      '0605dab2ca4ab57d043dc7659094c94b30581777401ce6bdce13321a6329848b',
      // CAN-3706 recovery fixes use stable creation receipts and the canonical
      // sharing read; these opt-in fixtures retain the closed study baselines.
      '11b8c6be437cfda54a84014555f52980e3fdd2c45885711827ee4635dd1e1b7a',
      // CAN-3706 adds opt-in lost-invite replies and terminal refusal recovery.
      // Closed study scenarios, budgets, and historical identities stay fixed.
      '9a05dba02c22b16971bd95be6f4e5f08c3067259bde79c2fb5334bf7797f03dd',
      // CAN-3706 recovery fixtures composed with develop's current mock routes.
      '5b9e92037206fbaf40accccb4a3ad03a924b6b54f822f626ff673427d5f7fe03',
      // CAN-3706 recovery fixtures composed with develop's activity sharing
      // and Ledger routes; retain the closed study's historical identities.
      '335c27eeba5e2799f658d78726557c709292396320d2335493dd6bd76a633f3a',
      // CAN-3597 exposes the scenario's personal organization identifier.
      '73b2b5c11b71315ec3f29e331933335c4dfc10635188d3495b20424518165e1a',
      // CAN-3761 adds daily-credit opt-in routes to the merged cloud fixture.
      // Keep the closed study's historical source identities unchanged.
      'f35349030a7759894248c74a06d01011577859afa46ca395cff866ab0fc211de',
      // The develop merge also includes the Privacy fixture changes.
      '9741dcf598c8dee0623931597cda3dc8f05929cdddeec610c76dc1a75709cbb5',
      '8bee6fb6d4792ecb9eded4f6827bd2407173ff752f71d91af8a9871b4642697a',
      '312e71be22217ab93c1d5f8221381381a654ee424358bab6ec17d8435c9cbf64',
      '54da49327add9939f61c24e12cab8d1424f651fc90e71f8ecc898d030f60772a',
      'bbc0553c4ec6317c65e77dd7e2b3a45f7c8508774ca8f2c4a178ae82ab860cc3',
      // CAN-3009 adds Marketplace sharing discovery to the cloud fixture.
      '9c1501818d542b4c3d7c06ae2a7dc1cd86ef9663b4559aedfe4ab4838e58150b',
      // Pinned install authorization reads do not advance the retry fixture.
      'b3f760106bf3813202a8bfccb27f84da49e3e97a150a349cf1f75c5ca556b581',
      // Collection authoring serves its committed package instead of a fixed fixture.
      '423ee1154b183c741f6561984e137190e7aa6fdb2ea46ee4a9e4118060b225ee',
      // Shared-pipeline replay coverage adds optional capability overrides.
      '52f8d92e669881bad0fb2897fae7a1dd66d6c4b0258b77dcc95eec4ef7a9ebe0',
      // CAN-3009 sharing routes and develop's shared-pipeline fixture coexist.
      'ccff85505972a6b45b9535776eb9c216d5f67739cacd9947f0e5ac53432c766c',
      // CAN-3561 adds the opt-in chat-turn activity route to the cloud mock.
      '419f510e2e929791a4f35723ee38f797c8a3db6d6eaf60ed72f4c466b6eec020',
      // Develop's mock additions and CAN-3561's activity route together.
      '98dfbdc15828aae791f668ee647905f113ca8945f9d54567d107f63e0adacd66',
      // CAN-3009 sharing routes and CAN-3561's activity route coexist.
      '146384c3460f9454e748baeca5fe1e407808aa055dc4be4a068f52ec3c6a09b3',
      // Develop after the #4426 squash merge over CAN-3546.
      '3914e3bc31665221b9dfad05d9026ce1e153ea346dea06feb5f424d750307b0a',
      // CAN-3710 uses a UUID collection fixture for install-review resolution.
      'f878db810d2298bfe51b467f2b2482d84670709e920addc2817e823060b88e10',
      // CAN-3129 models lapsed leases, supersedes and the verified reclaim.
      '43de886e6c1f6ae389eb119892b9cec856ce45738dee00c4e711063f06939da4',
      '9a1182d8e6621aceb17a8a5559fbff57d3f38bd2fb91d4f4e459b6d965edce8b',
      // CAN-3633 adds isolated activity-row share routes to the cloud fixture.
      'a116a2afe7df19f5b43ad0a170f66080bc380abe2d998b47f8840941d03f2ebc',
      // Agent Ledger sync adds the Ledger register and push routes.
      '6b18b1fa425fbd701482cdd1999ba2600ff643a28df25bcc6d622d44201803e1',
      // CAN-3755 adds the device relay token route for remote control.
      '6821817c40084e0e96193371ea75fdad6a1f2312e81baf539c27f0821290377b',
      // The Agent Ledger Feed adds the mirror's search and entry routes.
      '10e220eb54fd96e85be0cabefa3c2d39fd7a54aea8eda4b45bbed04e0cdab364',
      // The Agent Ledger rollout fixtures share the mock guest account ID.
      '7de87fed882dae23316340cab4748d481e937dbf4b237ded91e3e4b8c2a5d2c0',
      // PR #4569 composes the Ledger mirror and guest-account fixture with develop.
      'f14fa50f31460dfeee4494b843eb4fc53bc53e3cdc9a77b05bc827c73d7009fe',
      // CAN-3734 advertises automation target requirements in the cloud fixture.
      '5b97e4f4e117934bb195d2780a9b9a66a06e8c17d0727cab3535dae24369c5c4',
      // CAN-3777 rewords the cloud fixture's Privacy upgrade comments.
      'e5c78ddd97e38da197fb763a54d518e912d3d3da2c612f18f432b6c71f51b9ab',
      // Both changes coexist in the merged cloud fixture.
      '2667c664e6f3878c15961bff83f6f4504c940a53312789b532399fd9d83edb04',
      // CAN-2989 moves the seeded public share paths to the one web
      // Marketplace under /portal/plugins/*; the fixture data is otherwise
      // unchanged.
      '226eab28cb252dfe3d16037bfd1a2f54bed0fef043cb6a2e4a8999c7b79b5d2d',
      // CAN-2989's share paths composed with CAN-3777's Privacy comments.
      'a1dc1e98de3831d883eccdbb95d1e05cbb0819a9d09c432df6ba9393d7e0d734',
      // Develop also moves workspace-template shares to Marketplace paths.
      '3a05150605a7e0ef86f0e8b945f05912b7f0fdfd545273f24e9acc4fae693400',
      // CAN-3734's target requirements composed with CAN-2989's share paths.
      '8d44c0eb4716bbf24b5f93e61388e8ed6ae73b2cb2be234c2d21694204e6a86d',
      // CAN-3734's target requirements and workspace-template Marketplace paths coexist.
      'e37411cf83a476eb55b720a762518ad91782d0ed63b35873ddfac4a9c1dda1df',
      // PR #4569's Ledger mirror and guest fixture composed with CAN-2989's
      // share paths and CAN-3777's Privacy comments.
      'fb51ea8d50b31b1e986fc2d40a72c47efc63fbeb2a26216d984bfe673b94f0a4',
      // PR #4569's Ledger fixture composed with CAN-3734's target requirements
      // and CAN-2989's share paths.
      '2c13e35a3fa9897cb57d2bce42c353512496e6cb912d92ea533501a6fa12d388',
      // This merge composes Ledger routes with the workspace-template Marketplace paths.
      'ab19132d0e0ba1f22854ae58537149eabd1af0a2b76e767eac94b8f7dc73f50f',
      // CAN-3761's daily-credit opt-in routes composed with develop's fixture.
      '3bc4f4e75c92a532b069d5ca5b6810662c53e8cbb3a0fd6f733730fefa2d4890',
      // CAN-3761's daily-credit routes composed with the Ledger fixture.
      '6dab64843f81f163e29ea75b69d2d9e856f66fd6a6c128428255094e09376e4f',
      // CAN-3597's Personal fixture composed with CAN-3761's daily-credit routes.
      '8effd9e155b4d2f86e0d7874b7a7d18486bebb4efeb475709708b06b269dca2d',
      // CAN-3129's reclaim fixture composed with the current develop routes.
      '1b308008228f16232a97d932dadce9d9520c745ea61f4b6aa0c411e93f20eb38',
      // CAN-3129's reclaim fixture composed with develop after #5038.
      '1d0e95f9f2cbd36f7ed649e747f00a5d4ac6b281d1d6fe4b17f2be67c02a6209',
      // CAN-3129's reclaim fixture composed with develop on 2026-10-13.
      'e45af5f905a208714fbd5eef438e7dcb499f3f935407cdacac3273f0e62cc762',
      // CAN-4052 lets a scenario withhold the shared-container dismissals capability.
      '4c8c106008510a0e8655802fffd9c2efaf8d4585b76e5d92cb9d3d3365315fd7',
      // PR #4463: CAN-3129 reclaim composed with develop on 2026-10-14.
      'ab77329e052e2594ce5d9ae254a85ba00065de71ea1c0506cf8f400c5879459f',
      // CAN-3844 (PR #5093) adds the organization team parent to the share
      // fixture, composed with CAN-4052's dismissals capability.
      '953639abffe4c6b0a90119708ab5fb8a655fd4dcf11cf85cbce563a0f76efd5d',
      // PR #4463 (CAN-3129) reclaim composed with CAN-3844's share fixture.
      '2a6b5e7f0c2f7197a56fcd5a029579904a962185e1b318e7f2a63276d0e3efa6',
      // CAN-3710 uses a valid UUID for the shared collection install fixture.
      '75d3ec4d4e5eb255f22bde83312b950a76f48c75072cc07041fca85f95024964',
      // CAN-3710's UUID fixture composed with develop's hosted settings routes.
      '2cab97e0ee26ca245a9aa5de00eecd660375d082aa88b9d9bdd1dc0e5ad9e20d',
      // The daily-drip mock default drops from 25 to 10 credits.
      '495faa64ba749ec80b828dbd8ce7f221be5e35199f51999b959ba820e40f5121',
      // CAN-4266 pages and searches the shared agents list.
      '4e4df01dcad10314d40c0b17e6b7a7d7f5ce3d21f33d64e41a3c139b4a95af5d',
      // CAN-3959 advertises the run-condition automation capability, composed
      // with CAN-4266's shared agents paging.
      'f6dba8bada89ff87344b7c081c29ca807fb322618ff79c0759974d8b23051af3',
    ],
  ),
  // CAN-3753 local smoke acceptance.
  'apps/desktop-app/tests/performance/comparison.mjs': Object.freeze([
    '5ce7f3372b875bde241a04b8d3a3e5ccd8097b324ea355c8c43155b703f5cb3d',
  ]),
  // CAN-3753 local smoke acceptance.
  'apps/desktop-app/tests/performance/results.mjs': Object.freeze([
    '8ecee0dbc867d0be65bb0f00d583284c879cf4ed7d591319dd90ea12deeade71',
  ]),
});
// CAN-3533 adds curated automation routes to the cloud fixture. Keep the
// closed study identity and the prior reviewed fixture identity intact. The
// second input is the PR merge ref, which includes develop's publisher route.
// The latest develop merge advances the reviewed cloud fixture from c5e78e3.
const CAN3533_CLOUD_ROUTE_IDENTITIES = Object.freeze({
  '2bff5bbd0777c2a038871e386c2eb3cd4845ac9eefa102419f682b1ec8ef044b':
    '85d29aa4c7473e2e01754ded75ed07d5e8b35da8b8fafa249084b61fe19fca66',
  '8db995b1a73e07e1da11cc0d91a7d98b6fcda2071339c4b8a89f1086a1ce3c4e':
    '5aeba02aa712e17f8aaf94ace6066b5c268f0b8138b5a913be54f1c1f650ac78',
  c5e78e375a642cfdaea1d66d54e55512edafc6e2b15544167c67654ab17cb534:
    '943815afff1f3b5a07f0fbc30dad7e6fd9449c5624ea1801ffc4531dd70d22e2',
  e7c707be811154ac0b6b4705419f9973e91770ea4edb9f30b54155a332202a90:
    '9a1182d8e6621aceb17a8a5559fbff57d3f38bd2fb91d4f4e459b6d965edce8b',
  // CAN-3755 adds relay tokens to the current develop cloud fixture.
  '9a1182d8e6621aceb17a8a5559fbff57d3f38bd2fb91d4f4e459b6d965edce8b':
    '9f8350d930a06d1f8437fd54969a37d0384bdc7bd1427c0201143fcb66a48a28',
});
// Original shared-container fixture bytes before share-dialog coverage. Keep
// the study baseline separate from the reviewed current fixture identity.
const REVIEWED_SHARED_CONTAINERS_BASELINE = gunzipSync(
  Buffer.from(
    [
      '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',
    ].join(''),
    'base64',
  ),
).toString('utf8');

// Original study bytes for the demo Git helper before it isolated its Git env.
const REVIEWED_DEMO_GIT_BASELINE = gunzipSync(
  Buffer.from(
    [
      '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',
    ].join(''),
    'base64',
  ),
).toString('utf8');

// Original study bytes for the shared-container recipient seeder.
const REVIEWED_SHARED_CONTAINER_RECIPIENT_SEEDER_BASELINE = gunzipSync(
  Buffer.from(
    [
      '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',
    ].join(''),
    'base64',
  ),
).toString('utf8');

// Original study bytes for the plugins cache seeder.
const REVIEWED_PLUGINS_CACHE_SEEDER_BASELINE = gunzipSync(
  Buffer.from(
    [
      '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',
      'kOIvAF6kvWceneVvZv8GfqqHvasSAAA=',
    ].join(''),
    'base64',
  ),
).toString('utf8');

// Original study bytes for the cowork seeder before external-folder coverage.
const REVIEWED_COWORK_SEEDER_BASELINE = gunzipSync(
  Buffer.from(
    [
      'H4sIAAAAAAAAE5VWbW8iNxD+zq8YqZUMEbuQqHdVN0JqCpUuVa+tkkhVe0KHWQ+7Trz2yjZJENr/Xo2XfYFLclc+APa8P/PM7Mqi',
      'NNZDyX0OG2sKYNoITOjMLgeylu7hyUqPvzmjoTqoxZON+4CqROvi4t6xy8FgcnY2gDO4RRRgNEJqnox9APpyJU8Rhqv2f3zvjI79',
      'rkSYzWbAal22GoHU3gAHj84zR/5WW4d2wT1fSLuCJ+lz4OCkzhQChZfOo4A0534MBfdpLnUGPkcojfNRITPLvTSaXG213EgU0OXh',
      'JitQfGe2PpgUXGoorUnRObDIhUtCCj19qQU+h/RXMHRS4JpbQO3tbjQ+UtxLUU2OC16Rs+EBl9TojcxeMqJa3CQ3BTZxFGY83UFp',
      'MQqhQrnkzCnjR8C1eNlLlEvnjd1N9nS6FtWkQM8br8fokTslnZc6G8XUxYDI6rYucR6S/ruJcWOeVgEgtI7Ck7EwqZvUxUVdMnEh',
      '4gEEZvxccssL2Jv1Paa+AlNSY1xf5LyVOmtFca/3gRKRS02JAuZXf/z51z+fF1d3V58X1zcvufjU+GhzuRbLNxU1L/BtjdQoY49U',
      '1sYo5PpYR/HSoVhCQw9rnsB5br2DVvp2nNCtr+SSc38nvQopTwb4HGZ1s9UpycEhipOmDfcDgB6i4wFADxyYASMrFNFhHEmBQCHJ',
      'bZDAvJMEMEj03Y/zn355v2gu6/pgBt5uMdyFar5wH9E9axRCKV8EgnmtU41gH7xr57uc3Y0xHmZhfcX3RuphvzpgnSIbXbbmqUXu',
      'UVyRJbuYXryPpu+i6fnd+UUynSbTaTydTv+lhQbd3ht2IY6jj4F1G4GNxiFNgEcaLaMTOB+Hc2eUwKdwAwdN+kiR9BsxbgUEfnei',
      'dZm0u7K7D404OtYt6K6MFWgTmDY3Vf1nST/VKJR6Ai0NXB/Y06p76QZo30TqpBtfweqlMi2WhqBb1sdalrQQti1tChS44VvlPxqB',
      'KgGWlT56F/8QFVLLFjiH3Kb5NXVP6uxXzdcKRdKylj6kIB/xBj1qmqoF37kE9FapWqNqAPwmAMJeZ2Ng7Wp/HQSeevmId3x9LZLD',
      'AB3Q4etXOdTXC7o0U0k3Xp1EoEutDJskgdX3+1alIiJQMuGhueqx6hRioAfloxRo75qGCXzu0bJUXFMDEthw5fDIrjSOq1rI6oXG',
      'Vc/U51I/SJ39jo+hf7nM8p64QOd41p+lYywaPA6FXYsqosUQnffqCawyBA8jGTuWrJVJH8j/vqGjx2fPxkA/CbAPqJSpX4XoKVnv',
      'tQB0zKBaHjvzskDneVEmsOAe45Jbh8PT1XPerp5R37zqDsvXxveb2de8D7BxwxVg7RvB62Q85dbLvPp/nDrh06Glc7PVvo2ruPMf',
      'a8GVT05N3qDfYW5Fj3qHNWfRb62mV9revm2eUNXloBr8B4oVqjsTCwAA',
    ].join(''),
    'base64',
  ),
).toString('utf8');

// Original study bytes for results.mjs before the work-counter metric layer.
const REVIEWED_RESULTS_BASELINE = gunzipSync(
  Buffer.from(
    [
      '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',
    ].join(''),
    'base64',
  ),
).toString('utf8');
assert.equal(
  createHash('sha256')
    .update(JSON.stringify(FROZEN_CHANGED_HARNESS_BASELINES))
    .digest('hex'),
  // Pause-checkpoint coverage adds the pipeline execution seeder's original
  // bytes to the frozen baselines, so the map's digest moves with it.
  'd8a700522206a6c24866995adaa23030bdc866a541ec827287786bbdadb47635',
);

/**
 * Closure members that are ordinary PRODUCT source rather than study-owned
 * harness code.
 *
 * `ACTUAL_HARNESS_IDENTITIES` still records the bytes the closed study measured
 * for each of these, and that historical record is deliberately not edited.
 * What changed is what the CURRENT tree is required to hold: these files belong
 * to the product, ordinary product work changes them, and a new product
 * dependency can legitimately join the closure. Gating their current bytes made
 * this study test fail for reasons that say nothing about the study's trust —
 * the first such failure was the secret-values env helper joining through
 * `config-paths.ts`.
 *
 * What is still enforced for them is COVERAGE: every product input the study
 * measured must still be reached by the harness closure, so the study cannot
 * quietly stop depending on one. Byte identity, original-source proof and
 * unreviewed-delta rejection continue to apply to every study-owned file.
 */
const STUDY_PRODUCT_INPUTS = Object.freeze([
  'packages/desktop-shared/src/brand/env.ts',
  'packages/desktop-shared/src/canopy-paths.ts',
  'packages/desktop-shared/src/node/lib/path-lookup.ts',
  'packages/desktop-shared/src/pipelines/config-paths.ts',
]);

function reviewedLinearBaseline(after) {
  const previewRoute =
    /[ ]{4}\/\/ Transcript reference previews: the accessible team-key catalog\.\n[\s\S]*?\n[ ]{4}case 'referencePreviewIssue': \{[\s\S]*?\n[ ]{4}\}\n\n(?=[ ]{4}case 'issue_attachments':)/;
  assert.match(after, previewRoute);
  const attachmentRoute =
    /[ ]{4}case 'issue_attachments': \{[\s\S]*?\n[ ]{4}\}\n\n(?=[ ]{4}case 'issue_labels':)/;
  assert.match(after, attachmentRoute);
  // CAN-4529 replaced the local body reader with the control plane's cached one.
  const sharedReaderImport =
    "import { getScenario, keyFromApiKey, readJsonBody } from '../control-plane.mjs';\n";
  assert(after.includes(sharedReaderImport));
  const fieldBuilders =
    '// ── Field builders (return shapes the @linear/sdk models parse) ────────────\n';
  assert(after.includes(fieldBuilders));
  return after
    .replace(previewRoute, '')
    .replace(attachmentRoute, '')
    .replace(
      sharedReaderImport,
      "import { getScenario, keyFromApiKey } from '../control-plane.mjs';\n",
    )
    .replace(
      fieldBuilders,
      `${LOCAL_LINEAR_JSON_BODY_READER}\n${fieldBuilders}`,
    );
}

const LOCAL_LINEAR_JSON_BODY_READER = `function readJsonBody(request) {
  return new Promise((resolve) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
    });
    request.on('end', () => {
      if (!raw.trim()) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(undefined);
      }
    });
    request.on('error', () => resolve(undefined));
  });
}
`;

function matchedPinnedHarnessSource(file, after) {
  const pinnedIdentity = ACTUAL_HARNESS_IDENTITIES[file];
  const mergedBaseIdentity = MERGED_BASE_HARNESS_IDENTITIES[file];
  const addedPrIdentity = ADDED_PR_HARNESS_IDENTITIES[file];
  const identity =
    pinnedIdentity ??
    (mergedBaseIdentity
      ? [mergedBaseIdentity, mergedBaseIdentity]
      : addedPrIdentity
        ? [null, addedPrIdentity]
        : null);
  assert(identity, `Missing pinned immutable harness identity: ${file}`);
  const afterIdentity = createHash('sha256').update(after).digest('hex');
  const reviewedIdentity =
    REVIEWED_CURRENT_HARNESS_IDENTITIES[file]?.[identity[1]] ??
    (afterIdentity === mergedBaseIdentity ? mergedBaseIdentity : identity[1]);
  const expectedIdentity =
    file === 'apps/desktop-app/tests/electron/mock-server/routes/cloud.mjs'
      ? (CAN3533_CLOUD_ROUTE_IDENTITIES[reviewedIdentity] ?? reviewedIdentity)
      : reviewedIdentity;
  assert.equal(
    afterIdentity,
    REVIEWED_PR_HARNESS_IDENTITIES[file]?.includes(afterIdentity)
      ? afterIdentity
      : expectedIdentity,
    `Current immutable harness source changed: ${file}`,
  );
  const before =
    COPILOT_MOCK_BASELINES[file] ??
    (file === 'apps/desktop-app/tests/electron/mock-server/routes/linear.mjs'
      ? reviewedLinearBaseline(after)
      : file ===
          'apps/desktop-app/tests/electron/mock-server/routes/shared-containers.mjs'
        ? REVIEWED_SHARED_CONTAINERS_BASELINE
        : file ===
            'apps/desktop-app/tests/electron/seeders/seedSharedContainerRecipientReplicas.mjs'
          ? REVIEWED_SHARED_CONTAINER_RECIPIENT_SEEDER_BASELINE
          : file ===
              'apps/desktop-app/tests/electron/seeders/seedCoworkWorkspace.mjs'
            ? REVIEWED_COWORK_SEEDER_BASELINE
            : file ===
                'apps/desktop-app/tests/electron/seeders/seedPluginsCache.mjs'
              ? REVIEWED_PLUGINS_CACHE_SEEDER_BASELINE
              : file === 'apps/desktop-app/tests/performance/results.mjs'
                ? REVIEWED_RESULTS_BASELINE
                : file === 'demo-apps/lib/git.mjs'
                  ? REVIEWED_DEMO_GIT_BASELINE
                  : identity[0] === null
                    ? null
                    : identity[0] === identity[1] &&
                        afterIdentity === identity[0]
                      ? after
                      : file ===
                          'apps/desktop-app/tests/performance/diagnostics.mjs'
                        ? FROZEN_DIAGNOSTICS_SOURCE
                        : FROZEN_CHANGED_HARNESS_BASELINES[file]);
  assert(
    identity[0] === null ||
      identity[0] === identity[1] ||
      file ===
        'apps/desktop-app/tests/electron/mock-server/routes/shared-containers.mjs' ||
      file === 'apps/desktop-app/tests/performance/diagnostics.mjs' ||
      Object.hasOwn(FROZEN_CHANGED_HARNESS_BASELINES, file),
    `Missing frozen changed harness baseline: ${file}`,
  );
  assert.equal(
    before === null ? null : createHash('sha256').update(before).digest('hex'),
    identity[0],
    `Original immutable harness source changed: ${file}`,
  );
  return { before, installed: matchedHarnessSource(file, before, after) };
}

test('hosted settings fixture admission rejects mutated bytes and invented original sources', async () => {
  for (const file of [
    'apps/desktop-app/tests/electron/seeders/hostedSettingsCloud.mjs',
    'apps/desktop-app/tests/electron/mock-server/routes/hosted-settings-fixtures.mjs',
    'apps/desktop-app/tests/electron/mock-server/routes/hosted-settings.mjs',
  ]) {
    const source = await readFile(file, 'utf8');
    assert.equal(matchedHarnessSource(file, null, source), source);
    assert.throws(() => matchedHarnessSource(file, source, source));
    assert.throws(() => matchedHarnessSource(file, null, source + '\n'));
    assert.throws(() => matchedHarnessSource(file + '.unknown', null, source));
  }
});

test('Cost fixture admission rejects mutated bytes and invented original sources', async () => {
  const root = new URL('../../../../', import.meta.url);
  for (const file of [
    'apps/desktop-app/tests/electron/seeders/seedCostInsights.mjs',
    'apps/desktop-app/tests/electron/seeders/seedEarlyAccess.mjs',
    'apps/desktop-app/tests/electron/seeders/subagentViewerCapture.mjs',
    'apps/desktop-app/tests/electron/seeders/subagentViewerRecords.mjs',
    'apps/desktop-app/tests/performance/cost-index-fixture.mjs',
  ]) {
    const source = await readFile(new URL(file, root), 'utf8');
    assert.equal(matchedHarnessSource(file, null, source), source);
    assert.throws(() => matchedHarnessSource(file, source, source));
    assert.throws(() => matchedHarnessSource(file, null, source + '\n'));
    assert.throws(() => matchedHarnessSource(file + '.unknown', null, source));
  }
});

test('disk collector current-source admission preserves the absent baseline and rejects mutations', async () => {
  const file = 'apps/desktop-app/tests/performance/disk-io.mjs';
  const root = new URL('../../../../', import.meta.url);
  const after = await readFile(new URL(file, root), 'utf8');
  const { before, installed } = matchedPinnedHarnessSource(file, after);
  assert.equal(before, null);
  assert.equal(installed, after);
  assert.equal(
    ACTUAL_HARNESS_IDENTITIES[file][1],
    'ecfc8f6c8b674e8b162411ed62524f43ceadade1bb8ff4ae9f51a19914235dac',
  );
  assert.throws(
    () => matchedPinnedHarnessSource(file, after + '\n'),
    /Current immutable harness source changed/,
  );
  assert.throws(
    () =>
      matchedPinnedHarnessSource(
        'apps/desktop-app/tests/performance/scaling-ratios.mjs',
        after,
      ),
    /Current immutable harness source changed/,
  );
  assert.throws(
    () => matchedPinnedHarnessSource(file + '.unknown', after),
    /Missing pinned immutable harness identity/,
  );
  assert.throws(
    () => matchedHarnessSource(file, after, after),
    /New study helper unexpectedly exists in baseline/,
  );
  assert.throws(
    () => matchedHarnessSource(file + '.unknown', null, after),
    /Unreviewed harness delta/,
  );
});

test('actual harness closure covers spawned services, canonical comparison helpers and generated brand inputs', async () => {
  const files = await harnessFiles(
    new URL('../../../../', import.meta.url).pathname.replace(/\/$/, ''),
  );
  for (const file of [
    'apps/desktop-app/tests/performance/run.mjs',
    'apps/desktop-app/tests/performance/scenarios.mjs',
    'apps/desktop-app/tests/performance/statistics.mjs',
    'apps/desktop-app/tests/performance/comparison.mjs',
    'apps/desktop-app/tests/performance/browser-profiles-evidence.mjs',
    'apps/desktop-app/tests/electron/mock-server/start.mjs',
    'apps/desktop-app/tests/electron/mock-server/routes/cloud.mjs',
    'demo-apps/seed-canopy-data.mjs',
    '.cache/brand/current/desktop-brand.ts',
  ])
    assert(files.has(file), file);
  const addedHarnessHelpers = [
    ...Object.keys(MERGED_BASE_HARNESS_IDENTITIES),
    ...Object.keys(ADDED_PR_HARNESS_IDENTITIES),
    // The cutover retires this helper from the current closure. Its historical
    // source identity remains pinned above.
  ].filter(
    (file) =>
      !Object.hasOwn(ACTUAL_HARNESS_IDENTITIES, file) &&
      file !==
        'apps/desktop-app/tests/electron/seeders/seedChatDeltaJournalPreference.mjs',
  );
  // Product dependencies are validated for COVERAGE; study-owned files are
  // validated byte for byte below. Keeping the two apart is what lets ordinary
  // product work proceed without weakening the study's proof.
  const isProductInput = (file) => file.startsWith('packages/');
  for (const file of STUDY_PRODUCT_INPUTS) assert(files.has(file), file);
  for (const file of [...files].filter(isProductInput))
    assert(file.endsWith('.ts') || file.endsWith('.mjs'), file);
  const studyFiles = [...files].filter((file) => !isProductInput(file));
  assert.equal(studyFiles.length, 98 + addedHarnessHelpers.length);
  for (const file of addedHarnessHelpers) assert(files.has(file), file);
  const root = new URL('../../../../', import.meta.url).pathname.replace(
    /\/$/,
    '',
  );
  const generated = [
    '.cache/brand/canopy/desktop-brand.ts',
    '.cache/brand/current/desktop-brand.ts',
  ];
  for (const file of generated) {
    assert(files.has(file), file);
    const after = await readFile(path.join(root, file), 'utf8');
    assert.equal(matchedHarnessSource(file, after, after), after, file);
  }
  const immutable = studyFiles
    .filter((file) => !generated.includes(file))
    .sort();
  const rejectedOverlays = [];
  assert.equal(immutable.length, 96 + addedHarnessHelpers.length);
  const expectedIdentities = Object.keys(ACTUAL_HARNESS_IDENTITIES).filter(
    (file) => !STUDY_PRODUCT_INPUTS.includes(file),
  );
  expectedIdentities.push(...addedHarnessHelpers);
  assert.equal(expectedIdentities.length, immutable.length);
  assert.deepEqual(expectedIdentities.sort(), immutable);
  for (const file of immutable) {
    const after = await readFile(path.join(root, file), 'utf8');
    const { before, installed } = matchedPinnedHarnessSource(file, after);
    if (before !== installed) {
      try {
        assertAllowedHarnessOverlay(file);
      } catch {
        rejectedOverlays.push(file);
      }
    }
    if (
      [
        'apps/desktop-app/tests/electron/canopyApp.mjs',
        'apps/desktop-app/tests/electron/panelHarness.mjs',
      ].includes(file)
    )
      assert.equal(installed, before, file);
    else if (file === 'apps/desktop-app/tests/performance/scenarios.mjs')
      assert.equal(installed, runtimeOverlay(after), file);
    else assert.equal(installed, after, file);
  }
  assert.deepEqual(rejectedOverlays, []);
  assert.throws(
    () => assertAllowedHarnessOverlay('demo-apps/seed-canopy-data.mjs'),
    /Production overlay prohibited/,
  );
  assert.throws(
    () =>
      matchedHarnessSource(
        'scripts/lib/e2e-harness-measurement.mjs',
        null,
        'unreviewed helper',
      ),
    /Unreviewed measurement helper bytes/,
  );
  const supervisorFile =
    'apps/desktop-app/tests/performance/process-tree-supervisor.mjs';
  const supervisorBefore = FROZEN_CHANGED_HARNESS_BASELINES[supervisorFile];
  const supervisorAfter = await readFile(
    path.join(root, supervisorFile),
    'utf8',
  );
  assert.throws(
    () =>
      matchedHarnessSource(
        supervisorFile,
        supervisorBefore + '\n',
        supervisorAfter,
      ),
    /Original reviewed helper bytes changed/,
  );
  assert.throws(() =>
    matchedHarnessSource(supervisorFile, null, supervisorAfter),
  );
  // The curated plugin seeder's overlay pins its installed bytes too: the
  // candidate seeder is verified before it is installed into either root, not
  // only the study's original.
  const seederFile =
    'apps/desktop-app/tests/electron/seeders/seedCuratedPlugins.mjs';
  const seederBefore = FROZEN_CHANGED_HARNESS_BASELINES[seederFile];
  const seederAfter = await readFile(path.join(root, seederFile), 'utf8');
  assert.equal(
    createHash('sha256').update(seederBefore).digest('hex'),
    '5395ab3bc9ee12656266cc03d3de649d1fe5da075c489b85a7048724c32d174f',
  );
  assert.equal(
    matchedHarnessSource(seederFile, seederBefore, seederAfter),
    seederAfter,
  );
  assert.throws(
    () => matchedHarnessSource(seederFile, seederBefore, seederAfter + '\n'),
    /Installed reviewed helper bytes changed/,
  );
  assert.throws(
    () =>
      matchedHarnessSource(
        'apps/desktop-app/tests/performance/unreviewed.mjs',
        supervisorBefore,
        supervisorAfter,
      ),
    /Unreviewed harness delta/,
  );
  const currentScenarios = await readFile(
    path.join(root, 'apps/desktop-app/tests/performance/scenarios.mjs'),
    'utf8',
  );
  assert.throws(
    () =>
      matchedPinnedHarnessSource(
        'apps/desktop-app/tests/performance/scenarios.mjs',
        currentScenarios + '\n',
      ),
    /Current immutable harness source changed/,
  );
  const unchangedFile = 'apps/desktop-app/tests/performance/statistics.mjs';
  const unchangedSource = await readFile(
    path.join(root, unchangedFile),
    'utf8',
  );
  assert.throws(
    () => matchedPinnedHarnessSource(unchangedFile, unchangedSource + '\n'),
    /Current immutable harness source changed/,
  );
  // Coverage is a requirement, not a formality: dropping a product input the
  // study measured has to fail.
  const withoutProductInput = new Set(files);
  withoutProductInput.delete(
    'packages/desktop-shared/src/pipelines/config-paths.ts',
  );
  assert.throws(() => {
    for (const file of STUDY_PRODUCT_INPUTS)
      assert(withoutProductInput.has(file), file);
  });
  // The historical record was not edited to match whatever the tree holds now:
  // every product input still carries the single set of bytes the closed study
  // measured, and none was rewritten into a changed original/installed pair.
  for (const file of STUDY_PRODUCT_INPUTS) {
    const identity = ACTUAL_HARNESS_IDENTITIES[file];
    assert(identity, file);
    assert.equal(identity[0], identity[1], file);
  }
});
test('frozen build inputs match without post-study cache helpers and reject changed or missing required inputs', async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), 'e2e-frozen-build-inputs-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const roots = {
    baseline: path.join(parent, 'baseline'),
    candidate: path.join(parent, 'candidate'),
  };
  // Input inventory from the pinned 50ad study, independent of local Git objects.
  const files = [
    'scripts/build-e2e.mjs',
    'scripts/lib/e2e-build-cache.mjs',
    'scripts/run-guarded-dev-script.mjs',
    'scripts/lib/dev-script-safety.mjs',
    'tsconfig.json',
    'tsconfig.base.json',
  ];
  for (const root of Object.values(roots)) {
    for (const file of files) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), `frozen input: ${file}`);
    }
  }
  await assertMatchedBuildInputs(roots);
  const required = path.join(roots.candidate, files[0]);
  await writeFile(required, 'changed build script');
  await assert.rejects(
    assertMatchedBuildInputs(roots),
    /Build\/guard config differs: scripts\/build-e2e.mjs/,
  );
  await rm(required);
  await assert.rejects(assertMatchedBuildInputs(roots), { code: 'ENOENT' });
});

test('build normalization permits only the inventory worker addition, retaining changes to settings', () => {
  const base = 'const sourcemap = true;\n';
  const added =
    "const browserProfileInventoryWorkerEntry = resolve(\n  repoRoot,\n  'apps/desktop-app/src/main/browser/inventory-worker.ts',\n);\n\n";
  assert.equal(comparableBuildConfig(base + added), base);
  assert.notEqual(
    comparableBuildConfig(base + added + 'const minify = false;'),
    base,
  );
});

async function dependencyFixture(t, { bookkeeping = false } = {}) {
  const parent = await realpath(
    await mkdtemp(path.join(tmpdir(), 'e2e-dependencies-')),
  );
  t.after(() => rm(parent, { recursive: true, force: true }));
  const roots = ['baseline', 'candidate'].map((stage) =>
    path.join(parent, stage),
  );
  const write = async (root, file, value) => {
    const target = path.join(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, value);
  };
  const workspaces = ['apps/desktop-app', 'packages/ui-rich'];
  for (const root of roots) {
    const packages = {
      '': { workspaces },
      'apps/desktop-app': { name: '@fixture/desktop' },
      'packages/ui-rich': { name: '@fixture/ui-rich' },
      'node_modules/node-pty': { version: '1.1.0' },
      'apps/desktop-app/node_modules/ajv': { version: '8.20.0' },
      'packages/ui-rich/node_modules/dompurify': { version: '3.0.0' },
    };
    await write(root, 'package.json', JSON.stringify({ workspaces }));
    await write(
      root,
      'package-lock.json',
      JSON.stringify({ lockfileVersion: 3, packages }),
    );
    for (const workspace of workspaces)
      await write(root, `${workspace}/package.json`, '{}');
    for (const [file, value] of Object.entries({
      'node_modules/node-pty/package.json': JSON.stringify({
        version: '1.1.0',
      }),
      'node_modules/node-pty/lib/index.js': 'runtime',
      'node_modules/node-pty/build/Release/pty.node': 'native',
      'node_modules/node-pty/build/Release/spawn-helper': 'executable',
      'node_modules/electron/dist/Electron': 'electron',
      'apps/desktop-app/node_modules/ajv/index.js': 'ajv',
      'packages/ui-rich/node_modules/dompurify/index.js': 'dompurify',
    }))
      await write(root, file, value);
    if (bookkeeping) {
      await write(
        root,
        'node_modules/node-pty/build/Makefile',
        `# generated\ncmd_regen_makefile = cd $(srcdir); ${root}/node_modules/node-gyp/gyp/gyp_main.py -fmake "-Dnode_gyp_dir=${root}/node_modules/node-gyp" "-Dmodule_root_dir=${root}/node_modules/node-pty" -I${root}/node_modules/node-pty/build/config.gypi -I${root}/node_modules/node-gyp/addon.gypi\n`,
      );
      await write(
        root,
        'node_modules/node-pty/build/config.gypi',
        `# Do not edit. File was generated by node-gyp's "configure" step\n{\n  "variables": {\n    "local_prefix": "${root}",\n    "target_arch": "arm64"\n  }\n}\n`,
      );
    }
  }
  return { roots, write };
}
test('independent node-pty bookkeeping paths normalize while complete raw evidence stays distinct', async (t) => {
  const { roots } = await dependencyFixture(t, { bookkeeping: true });
  const [before, after] = await Promise.all(
    roots.map((root) => dependencyManifest(root)),
  );
  assert.notDeepEqual(before.raw, after.raw);
  const compared = compareDependencyManifests(before, after);
  assert.equal(
    compared.passed,
    true,
    'Own-checkout node-gyp bookkeeping must not fail runtime identity',
  );
  assert.equal(compared.rawDifferences.length, 2);
  assert.equal(before.normalizations.length, 2);
});
test('workspace-local dependency mutation is detected across stages and against the sealed stage', async (t) => {
  const {
    roots: [beforeRoot, afterRoot],
    write,
  } = await dependencyFixture(t);
  const before = await dependencyManifest(beforeRoot),
    sealed = await dependencyManifest(afterRoot);
  assert(compareDependencyManifests(before, sealed).passed);
  await write(
    afterRoot,
    'apps/desktop-app/node_modules/ajv/index.js',
    'changed-ajv',
  );
  const changed = await dependencyManifest(afterRoot);
  assert.equal(
    compareDependencyManifests(before, changed).passed,
    false,
    'Nested workspace dependency mutation must fail cross-stage identity',
  );
  assert.notDeepEqual(
    changed.raw,
    sealed.raw,
    'Nested workspace dependency mutation must fail sealed identity',
  );
});

test('bookkeeping normalization never accepts changed native/runtime/code bytes or unreviewed fields', async (t) => {
  for (const file of [
    'node_modules/node-pty/build/Release/pty.node',
    'node_modules/node-pty/build/Release/spawn-helper',
    'node_modules/electron/dist/Electron',
    'node_modules/node-pty/lib/index.js',
    'node_modules/node-pty/build/pty.target.mk',
    'node_modules/node-pty/build/unknown.gypi',
  ]) {
    const {
      roots: [beforeRoot, afterRoot],
      write,
    } = await dependencyFixture(t, { bookkeeping: true });
    await write(beforeRoot, file, `unchanged ${beforeRoot}`);
    await write(afterRoot, file, `changed ${afterRoot}`);
    const compared = compareDependencyManifests(
      await dependencyManifest(beforeRoot),
      await dependencyManifest(afterRoot),
    );
    assert.equal(compared.passed, false, file);
    assert(compared.mismatches.includes(file), file);
  }
  for (const [file, from, to] of [
    ['node_modules/node-pty/build/config.gypi', '"arm64"', '"x64"'],
    [
      'node_modules/node-pty/build/config.gypi',
      '"target_arch": "arm64"',
      '"target_arch": "arm64", "other_checkout_path": "<ROOT>"',
    ],
    ['node_modules/node-pty/build/Makefile', '-fmake', '-fother'],
    [
      'node_modules/node-pty/build/Makefile',
      '-fmake',
      '-fmake "-Dunknown_checkout_path=<ROOT>"',
    ],
  ]) {
    const {
      roots: [beforeRoot, afterRoot],
      write,
    } = await dependencyFixture(t, { bookkeeping: true });
    const source = await readFile(path.join(afterRoot, file), 'utf8');
    await write(
      afterRoot,
      file,
      source.replace(from, to.replace('<ROOT>', afterRoot)),
    );
    assert.equal(
      compareDependencyManifests(
        await dependencyManifest(beforeRoot),
        await dependencyManifest(afterRoot),
      ).passed,
      false,
      file,
    );
  }
});
test('unknown path-only bookkeeping differences and unreviewed versions fail closed', async (t) => {
  const { roots, write } = await dependencyFixture(t, { bookkeeping: true });
  for (const root of roots)
    await write(
      root,
      'node_modules/node-pty/build/unknown.gypi',
      JSON.stringify({ local_prefix: root }),
    );
  assert.equal(
    compareDependencyManifests(
      ...(await Promise.all(roots.map((root) => dependencyManifest(root)))),
    ).passed,
    false,
  );
  await write(
    roots[1],
    'node_modules/node-pty/package.json',
    JSON.stringify({ version: '1.2.0' }),
  );
  await assert.rejects(
    dependencyManifest(roots[1]),
    /Unreviewed installed node-pty/,
  );
});
test('every workspace tree includes added files and empty directories and remains sealed by raw bytes', async (t) => {
  for (const relative of [
    'packages/ui-rich/node_modules/dompurify/index.js',
    'packages/ui-rich/node_modules/pako/index.js',
    'apps/desktop-app/node_modules/extra/index.js',
  ]) {
    const {
      roots: [beforeRoot, afterRoot],
      write,
    } = await dependencyFixture(t);
    const baseline = await dependencyManifest(beforeRoot),
      sealed = await dependencyManifest(afterRoot);
    await write(afterRoot, relative, 'changed or newly installed');
    const changed = await dependencyManifest(afterRoot);
    assert.equal(
      compareDependencyManifests(baseline, changed).passed,
      false,
      relative,
    );
    assert.notDeepEqual(sealed.raw, changed.raw);
    assert(Object.hasOwn(changed.raw, relative));
  }
  const {
    roots: [beforeRoot, afterRoot],
  } = await dependencyFixture(t);
  const sealed = await dependencyManifest(afterRoot);
  await mkdir(
    path.join(afterRoot, 'packages/ui-rich/node_modules/empty-extra'),
  );
  const changed = await dependencyManifest(afterRoot);
  assert.notDeepEqual(sealed.raw, changed.raw);
  assert.equal(
    compareDependencyManifests(await dependencyManifest(beforeRoot), changed)
      .passed,
    false,
  );
});
test('contained workspace/bin links stay attested; escaped or unrelated ignored targets are rejected', async (t) => {
  const { roots, write } = await dependencyFixture(t);
  for (const root of roots) {
    const lock = JSON.parse(
      await readFile(path.join(root, 'package-lock.json'), 'utf8'),
    );
    lock.packages['node_modules/@fixture/desktop'] = {
      link: true,
      resolved: 'apps/desktop-app',
    };
    await write(root, 'package-lock.json', JSON.stringify(lock));
    await mkdir(path.join(root, 'node_modules/@fixture'));
    await symlink(
      '../../apps/desktop-app',
      path.join(root, 'node_modules/@fixture/desktop'),
    );
    await mkdir(path.join(root, 'node_modules/.bin'));
    await symlink(
      '../node-pty/build/Release/spawn-helper',
      path.join(root, 'node_modules/.bin/helper'),
    );
  }
  const [before, after] = await Promise.all(
    roots.map((root) => dependencyManifest(root)),
  );
  assert(compareDependencyManifests(before, after).passed);
  assert.equal(
    typeof after.raw['node_modules/.bin/helper'].targetSha256,
    'string',
  );
  assert(after.raw['apps/desktop-app/node_modules/ajv/index.js']);
  await symlink(roots[0], path.join(roots[1], 'node_modules/escaped'));
  await assert.rejects(dependencyManifest(roots[1]), /escapes checkout/);
  await rm(path.join(roots[1], 'node_modules/escaped'));
  await write(
    roots[1],
    'ignored/vendor/runtime.js',
    'not an installed dependency root',
  );
  await symlink(
    '../ignored/vendor',
    path.join(roots[1], 'node_modules/unknown'),
  );
  await assert.rejects(
    dependencyManifest(roots[1]),
    /Unattested dependency directory link/,
  );
});

test('reviewed panel diagnostic delta uses the pinned baseline selection contract in both staged harnesses', async (t) => {
  const root = new URL('../../../../', import.meta.url).pathname.replace(
    /\/$/,
    '',
  );
  const relative = 'apps/desktop-app/tests/electron/panelHarness.mjs';
  // Pinned original selection contract from panelHarness.mjs at recovered
  // 50ad63d648b27f867aa248cf3e8517aac0b4308d (lines 104–107). This small
  // inline fixture tests byte selection without requiring Git history. Hosted
  // orchestration separately attests the complete baseline checkout and helper.
  const before =
    '  const app = new CanopyAppDriver(window);\n' +
    '  await app.waitForShell({ timeout: 30_000 });\n' +
    '  await app.openMainPage();\n' +
    '  await app.selectWorktree(branch);\n';
  assert.equal(
    createHash('sha256').update(before).digest('hex'),
    '9b332e2ee343dc303fc647c1a3b32271b77ccb33fa5eb22ee835257c09ab5014',
  );
  const after = await readFile(path.join(root, relative), 'utf8');
  assert.notEqual(before, after);
  assert(after.includes('onSelectWorktreeFailure'));
  assert(!before.includes('onSelectWorktreeFailure'));
  assert((await harnessFiles(root)).has(relative));
  const installed = matchedHarnessSource(relative, before, after);
  assert.equal(installed, before);
  const fixture = await dependencyFixture(t);
  for (const stage of fixture.roots) {
    await fixture.write(stage, relative, installed);
    assert.equal(await readFile(path.join(stage, relative), 'utf8'), before);
  }
  assert.throws(
    () =>
      matchedHarnessSource(
        'apps/desktop-app/tests/electron/unreviewed.mjs',
        before,
        after,
      ),
    /Unreviewed harness delta/,
  );
  assert.throws(
    () =>
      matchedHarnessSource(
        'apps/desktop-app/src/main/browser/manager.ts',
        before,
        after,
      ),
    /Unreviewed harness delta/,
  );
});

test('fixed E2E qualification has seven primaries and exactly two forced diagnostic warmups', () => {
  const plan = schedule('qualification');
  assert.equal(plan.length, 7);
  assert.deepEqual(
    plan.map((x) => x.stage),
    [
      'candidate',
      'baseline',
      'candidate',
      'baseline',
      'candidate',
      'candidate',
      'baseline',
    ],
  );
  assert.deepEqual(
    plan.filter((x) => x.diagnose).map((x) => x.phase),
    ['warmup', 'warmup'],
  );
  assert.throws(() => schedule('stable'));
  assert.throws(() => schedule(2));
});

test('study validation rejects visible windows, wrong geometry and absent primary timing evidence', () => {
  for (const mutate of [
    (raw) => (raw.environment.windowVisible = true),
    (raw) =>
      (raw.scenarios[0].windowEvidence.atStart.contentBounds.height = 640),
    (raw) => (raw.scenarios[0].monitoring.raw.renderer.frames = []),
    (raw) => raw.scenarios[0].tasks.pop(),
  ]) {
    const entry = row();
    mutate(entry.raw);
    assert.throws(() => validateRun(entry.raw, entry.attempt, entry.identity));
  }
});
test('performance workflows are manual-only, default to closed qualification, and preserve matched templates', async () => {
  for (const [name, full] of [
    ['browser-profile-performance', 'exploratory'],
    ['browser-profile-e2e-performance', 'full'],
  ]) {
    const active = await readFile(
      new URL(`../../../../.github/workflows/${name}.yml`, import.meta.url),
      'utf8',
    );
    const template = await readFile(
      new URL(
        `../../../../docs/planning/2026-09-09-browser-profiles/spikes/${name}.workflow.yml`,
        import.meta.url,
      ),
      'utf8',
    );
    assert.equal(active, template);
    assert.match(active, /^on:\n {2}workflow_dispatch:\n/m);
    assert.doesNotMatch(active, /^ {2}push:/m);
    assert.match(active, /^ {8}default: qualification$/m);
    assert(active.includes(`options: [qualification, ${full}]`));
    assert(
      active.includes(
        "STUDY_PROTOCOL: ${{ inputs.protocol || 'qualification' }}",
      ),
    );
    assert(active.includes('--protocol "$STUDY_PROTOCOL"'));
    assert(!active.includes('options: [qualification, stable]'));
  }
});

test('native UI reporting retains actual terminal counts through ANSI line reporter output', () => {
  assert.deepEqual(nativeUiCounts('\u001b[1A\u001b[2K  4 passed (52.6s)\n'), {
    passed: 4,
    failed: 0,
    skipped: 0,
    flaky: 0,
  });
  assert.deepEqual(
    nativeUiCounts('  1 failed\n  1 skipped\n  2 passed (10s)\n'),
    { passed: 2, failed: 1, skipped: 1, flaky: 0 },
  );
  assert.deepEqual(nativeUiCounts('No final reporter summary'), {
    passed: 0,
    failed: 0,
    skipped: 0,
    flaky: 0,
  });
});

test('E2E requires affirmative long-task coverage while accepting an observed empty stream', () => {
  const valid = row();
  assert.doesNotThrow(() =>
    validateRun(valid.raw, valid.attempt, valid.identity),
  );
  for (const available of [false, undefined]) {
    const entry = row();
    if (available === undefined)
      delete entry.raw.scenarios[0].monitoring.raw.renderer
        .longTaskObserverAvailable;
    else
      entry.raw.scenarios[0].monitoring.raw.renderer.longTaskObserverAvailable =
        available;
    assert.throws(
      () => validateRun(entry.raw, entry.attempt, entry.identity),
      /long.task observer/i,
    );
  }
});

test('local options are closed before host admission or preparation', () => {
  const result = spawnSync(
    process.execPath,
    [
      'apps/desktop-app/tests/performance/browser-profiles-e2e-ci.mjs',
      '--execution',
      'local-physical',
      '--protocol',
      'full',
      '--workspace',
      '/never-prepared',
      '--baseline',
      '/never-prepared/baseline',
      '--candidate',
      '/never-prepared/candidate',
      '--candidate-commit',
      'a'.repeat(40),
      '--output',
      '/never-prepared/output',
      '--resume',
    ],
    { encoding: 'utf8', env: { PATH: process.env.PATH } },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown option '--resume'/);
});
for (const outcome of [
  'normal',
  'preparation-failure',
  'interruption',
  'timeout',
  'finalization-failure',
]) {
  test(`actual local safety lease encloses owned execution and releases after ${outcome}`, async () => {
    const lockRoot = await mkdtemp(path.join(tmpdir(), 'e2e-local-lease-'));
    const controller = new AbortController();
    let owner,
      acquisitions = 0,
      finalizationObserved = false;
    const slots = () => readdir(path.join(lockRoot, 'desktop-runtime'));
    const acquire = async (options) => {
      acquisitions++;
      assert.deepEqual(Object.keys(options).sort(), ['env', 'signal', 'suite']);
      assert.equal(options.suite, 'e2e');
      assert.deepEqual(options.env, {});
      // Real safety implementation; isolate unit-test lock files and memory probe only.
      return applyDevScriptSafetyWithWait({
        ...options,
        lockRoot,
        availableMemoryMb: () => 8192,
      });
    };
    try {
      const running = withLocalE2ELease(
        async (token) => {
          owner = token;
          assert.deepEqual(await slots(), ['slot-1']);
          await assert.rejects(
            applyDevScriptSafetyWithWait({
              suite: 'performance',
              env: {},
              lockRoot,
              availableMemoryMb: () => 8192,
              noGuardWait: true,
            }),
            /host-global maximum concurrency 1/,
          );
          assert.deepEqual(
            e2eCommand('local-physical', 'driver', [], owner).args.slice(0, 2),
            ['--import', 'tsx'],
          );
          let finalizationFailure;
          try {
            if (outcome === 'preparation-failure')
              throw new Error('preparation failure');
            const result = await runCommandProcess({
              executable: process.execPath,
              args: [
                '-e',
                outcome === 'timeout' || outcome === 'interruption'
                  ? 'console.log("ready"); setInterval(()=>{}, 1000)'
                  : 'if (process.env.CI || process.env.GITHUB_ACTIONS) process.exit(2)',
              ],
              cwd: lockRoot,
              env: e2eChildEnvironment('local-physical', process.env),
              stdio: ['ignore', 'pipe', 'ignore'],
              timeoutMs: outcome === 'timeout' ? 50 : 2000,
              termGraceMs: 100,
              killGraceMs: 500,
              signal: controller.signal,
              onSpawn: (child) => {
                child.stdout.once('data', () => {
                  if (outcome === 'interruption') controller.abort();
                });
              },
            });
            assert.equal(
              result.cleanup.groupGone,
              true,
              JSON.stringify(result),
            );
            assert.deepEqual(
              await slots(),
              ['slot-1'],
              'Lease stays held through owned group cleanup',
            );
            if (outcome === 'interruption')
              assert.equal(result.interrupted, true);
            else if (outcome === 'timeout') assert.equal(result.timedOut, true);
            else assert.equal(result.code, 0);
          } finally {
            assert.deepEqual(
              await slots(),
              ['slot-1'],
              'Lease remains held through finalization',
            );
            finalizationObserved = true;
            if (outcome === 'finalization-failure')
              finalizationFailure = new Error('finalization failure');
          }
          if (finalizationFailure) throw finalizationFailure;
        },
        { acquire, env: {}, signal: controller.signal },
      );
      if (outcome.endsWith('failure')) await assert.rejects(running, /failure/);
      else await running;
      assert.equal(acquisitions, 1);
      assert(finalizationObserved);
      assert.deepEqual(await slots(), []);
      assert.throws(
        () =>
          e2eCommand('local-physical', 'driver', [], owner).args.slice(0, 2),
        /active lease/,
      );
    } finally {
      await rm(lockRoot, { recursive: true, force: true });
    }
  });
}
test('interruption during actual safety admission retains the foreign lease and never prepares a study', async () => {
  const lockRoot = await mkdtemp(path.join(tmpdir(), 'e2e-local-wait-'));
  const options = {
    suite: 'performance',
    env: {},
    lockRoot,
    availableMemoryMb: () => 8192,
  };
  const existing = await applyDevScriptSafetyWithWait(options);
  const controller = new AbortController();
  let entered = false;
  try {
    await assert.rejects(
      withLocalE2ELease(
        () => {
          entered = true;
        },
        {
          env: {},
          signal: controller.signal,
          acquire: (requested) =>
            applyDevScriptSafetyWithWait({
              ...requested,
              lockRoot,
              availableMemoryMb: () => 8192,
              logGuardWait: () => controller.abort(),
            }),
        },
      ),
      /abort/i,
    );
    assert(!entered);
    const holder = JSON.parse(
      await readFile(path.join(existing.lease.slotPath, 'holder.json'), 'utf8'),
    );
    assert.equal(holder.token, existing.lease.metadata.token);
  } finally {
    await existing.lease.release();
    await rm(lockRoot, { recursive: true, force: true });
  }
});

const localOptions = [
  '--execution',
  'local-physical',
  '--protocol',
  'full',
  '--workspace',
  '/workspace',
  '--baseline',
  '/workspace/baseline',
  '--candidate',
  '/workspace/candidate',
  '--candidate-commit',
  'a'.repeat(40),
  '--output',
  '/workspace/fresh',
];

test('local parser preserves the closed full population and rejects execution modifiers', () => {
  assert.equal(parseE2EOptions(localOptions).execution, 'local-physical');
  for (const flag of [
    '--samples',
    '--warmups',
    '--scenarios',
    '--resume',
    '--reuse',
    '--retries',
    '--retry',
    '--qualification',
    '--no-guard-wait',
    '--guard-wait',
    '--danger-skip-memory-pressure-safety-check',
    '--danger-skip-concurrency-safety-lock',
  ])
    assert.throws(() => parseE2EOptions([...localOptions, flag, '1']));
  for (const protocol of ['qualification', 'stable', 'exploratory'])
    assert.throws(() =>
      parseE2EOptions([...localOptions, '--protocol', protocol]),
    );
  for (const sha of ['', 'HEAD', 'a'.repeat(39), 'A'.repeat(40)])
    assert.throws(() =>
      parseE2EOptions([...localOptions, '--candidate-commit', sha]),
    );
  assert.throws(() =>
    parseE2EOptions([...localOptions, '--execution', 'hosted']),
  );
  const hosted = parseE2EOptions([
    '--baseline',
    'a',
    '--candidate',
    'b',
    '--output',
    'c',
  ]);
  assert.equal(hosted.execution, 'hosted');
  assert.equal(hosted.protocol, 'full');
  assert.equal(schedule().length, 13);
  assert.deepEqual(THRESHOLDS, {
    maxRegressionPercent: 10,
    minRegressionMs: 20,
  });
});

test('local E2E reuses exact physical host and stage identity admission', () => {
  requireLocalPhysicalMac({}, 'darwin', 'v24.21.0');
  assert.throws(
    () => requireLocalPhysicalMac({}, 'linux', 'v24.21.0'),
    /Darwin/,
  );
  assert.throws(
    () => requireLocalPhysicalMac({}, 'darwin', 'v24.15.0'),
    /actual Node/,
  );
  for (const key of [
    'CI',
    'GITHUB_ACTIONS',
    'GITHUB_SHA',
    'RUNNER_OS',
    'RUNNER_TEMP',
    'ImageOS',
    'ImageVersion',
    'CANOPY_DEV_SCRIPT_MEMORY_PRESSURE_THRESHOLD_MB',
    'CANOPY_DEV_PERF_SUITE_MAX_RUN_CONCURRENCY',
    'CANOPY_DEV_E2E_SUITE_MAX_RUN_CONCURRENCY',
  ])
    for (const value of ['', 'false', '1'])
      assert.throws(
        () => requireLocalPhysicalMac({ [key]: value }, 'darwin', 'v24.21.0'),
        /rejects/,
      );
  const tree = '7e063f1552bea71e55690d57538ccbbb71bf730a';
  assertReleaseStageIdentity('baseline', BASELINE_SHA, tree, 'a'.repeat(40));
  assertReleaseStageIdentity(
    'candidate',
    'a'.repeat(40),
    'b'.repeat(40),
    'a'.repeat(40),
  );
  assert.throws(
    () =>
      assertReleaseStageIdentity(
        'baseline',
        BASELINE_SHA,
        'b'.repeat(40),
        'a'.repeat(40),
      ),
    /tree/,
  );
  assert.throws(
    () =>
      assertReleaseStageIdentity(
        'candidate',
        'c'.repeat(40),
        'b'.repeat(40),
        'a'.repeat(40),
      ),
    /identity/,
  );
});

test('local environment retains matched E2E settings without hosted metadata or guard overrides', () => {
  const source = {
    PATH: '/usr/bin',
    HOME: '/example',
    CI: '1',
    GITHUB_ACTIONS: '1',
    RUNNER_OS: 'macOS',
    GITHUB_WORKSPACE: '/runner',
    ImageOS: 'macos',
    CANOPY_DEV_E2E_SUITE_MAX_RUN_CONCURRENCY: '10',
  };
  const local = e2eChildEnvironment('local-physical', source),
    hosted = e2eChildEnvironment('hosted', source);
  for (const key of Object.keys(local))
    assert(
      !/^(CI$|GITHUB_|RUNNER_|ImageOS$|ImageVersion$|CANOPY_DEV_)/.test(key),
    );
  assert.equal(local.CANOPY_E2E_BUILD, '1');
  assert.equal(local.CANOPY_E2E_BUILD_CACHE, '0');
  assert.equal(local.CANOPY_E2E_OUT_DIR, 'out-e2e');
  assert.equal(local.CANOPY_PERFORMANCE_SOURCEMAPS, '1');
  assert.equal(local.CANOPY_E2E_MOCK_BASE_URL, 'http://127.0.0.1:4011');
  assert.equal(local.PATH, `${path.dirname(process.execPath)}:/usr/bin`);
  assert.equal(hosted.CI, 'true');
  assert.equal(hosted.RUNNER_OS, 'macOS');
  for (const [key, value] of Object.entries(local))
    if (key !== 'PATH') assert.equal(value, hosted[key]);
});

test('stage preparation refuses reused roots, output collision, overlap, and canonical escapes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'e2e-local-paths-'));
  try {
    const baseline = path.join(root, 'baseline'),
      candidate = path.join(root, 'candidate');
    await mkdir(baseline);
    await mkdir(candidate);
    const values = {
      execution: 'local-physical',
      workspace: root,
      baseline,
      candidate,
      output: path.join(root, 'fresh'),
    };
    assert.equal(
      (await prepareE2EPaths(values)).output,
      path.join(await realpath(root), 'fresh'),
    );
    await assert.rejects(prepareE2EPaths(values), /EEXIST/);
    await assert.rejects(
      prepareE2EPaths({ ...values, candidate: baseline }),
      /disjoint/,
    );
    await assert.rejects(
      prepareE2EPaths({ ...values, output: path.join(candidate, 'inside') }),
      /outside/,
    );
    const escape = path.join(root, 'escape');
    await symlink(tmpdir(), escape);
    await assert.rejects(
      prepareE2EPaths({ ...values, candidate: escape }),
      /canonical/,
    );
    for (const name of ['node_modules', 'out', 'out-e2e', '.cache']) {
      await mkdir(path.join(baseline, name));
      await assert.rejects(
        prepareE2EPaths({ ...values, output: path.join(root, 'other') }),
        /must be fresh/,
      );
      await rm(path.join(baseline, name), { recursive: true });
    }
    await mkdir(path.join(root, 'nested'));
    await assert.rejects(
      prepareE2EPaths(
        {
          ...values,
          execution: 'hosted',
          output: path.join(root, 'nested', 'output'),
        },
        root,
      ),
      /new workspace child/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('hosted command wrappers stay unchanged and every local child needs the live e2e owner', async () => {
  const tail = ['browser-chrome.spec.mjs', '--reporter=line', '--retries=0'];
  assert.deepEqual(e2eCommand('hosted', 'ui', tail), {
    executable: 'pnpm',
    args: ['run', 'test:electron:built', ...tail],
  });
  assert.deepEqual(e2eCommand('hosted', 'build').args, [
    'scripts/run-guarded-dev-script.mjs',
    '--suite',
    'performance',
    '--',
    'pnpm',
    'run',
    'build:e2e',
    '--performance-sourcemaps',
  ]);
  assert.deepEqual(e2eCommand('hosted', 'driver').args.slice(0, 7), [
    'scripts/run-guarded-dev-script.mjs',
    '--suite',
    'performance',
    '--',
    process.execPath,
    '--import',
    'tsx',
  ]);
  for (const kind of ['build', 'ui', 'driver'])
    assert.throws(
      () => e2eCommand('local-physical', kind, [], {}),
      /active lease/,
    );
  const lockRoot = await mkdtemp(path.join(tmpdir(), 'e2e-command-lease-'));
  try {
    await withLocalE2ELease(
      async (owner) => {
        assert.deepEqual(e2eCommand('local-physical', 'build', [], owner), {
          executable: 'pnpm',
          args: ['run', 'build:e2e', '--performance-sourcemaps'],
        });
        assert.deepEqual(e2eCommand('local-physical', 'ui', tail, owner).args, [
          'node_modules/@playwright/test/cli.js',
          'test',
          '--config',
          LOCAL_RUNNER_CONFIG,
          ...tail,
        ]);
        for (const kind of ['build', 'ui', 'driver'])
          assert(
            !e2eCommand('local-physical', kind, [], owner).args.some((arg) =>
              /guard|danger/.test(arg),
            ),
          );
      },
      {
        env: {},
        acquire: (options) =>
          applyDevScriptSafetyWithWait({
            ...options,
            lockRoot,
            availableMemoryMb: () => 8192,
          }),
      },
    );
  } finally {
    await rm(lockRoot, { recursive: true, force: true });
  }
});

test('exclusive adapter imports the actual unchanged config and changes only local server reuse', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'e2e-adapter-composition-'));
  const evidence = {};
  try {
    await copyFile(
      'playwright.config.mjs',
      path.join(root, 'playwright.config.mjs'),
    );
    await symlink(
      path.resolve('node_modules'),
      path.join(root, 'node_modules'),
    );
    const before = await readFile(
      path.join(root, 'playwright.config.mjs'),
      'utf8',
    );
    await withLocalRunnerConfig(root, evidence, async () => {
      const original = (
        await import(
          pathToFileURL(path.join(root, 'playwright.config.mjs')).href
        )
      ).default;
      const composed = (
        await import(pathToFileURL(path.join(root, LOCAL_RUNNER_CONFIG)).href)
      ).default;
      assert.deepEqual(composed, {
        ...original,
        webServer: { ...original.webServer, reuseExistingServer: false },
      });
      assert.equal(
        await readFile(path.join(root, LOCAL_RUNNER_CONFIG), 'utf8'),
        evidence.bytes,
      );
      assert.equal(
        createHash('sha256').update(evidence.bytes).digest('hex'),
        evidence.sha256,
      );
      await assert.rejects(
        withLocalRunnerConfig(root, {}, () =>
          assert.fail('must not reuse adapter'),
        ),
        /EEXIST/,
      );
    });
    assert.equal(evidence.status, 'removed');
    assert.equal(
      await readFile(path.join(root, 'playwright.config.mjs'), 'utf8'),
      before,
    );
    await assert.rejects(
      readFile(path.join(root, LOCAL_RUNNER_CONFIG)),
      /ENOENT/,
    );
    await assert.rejects(
      withLocalRunnerConfig(root, {}, () => {
        throw new Error('preparation failed');
      }),
      /preparation failed/,
    );
    await assert.rejects(
      readFile(path.join(root, LOCAL_RUNNER_CONFIG)),
      /ENOENT/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function sourceOverlayFixture() {
  const originalBlock = 'old observation\n',
    installedBlock = 'reviewed observation\n',
    original = `fixture before\n${originalBlock}fixture after\n`,
    installed = `fixture before\n${installedBlock}fixture after\n`,
    sha256 = (value) => createHash('sha256').update(value).digest('hex');
  return {
    original,
    installed,
    contract: Object.freeze({
      path: 'apps/desktop-app/tests/electron/browser-chrome.spec.mjs',
      scope:
        'Fixture-only baseline native UI observation overlay; no production bytes.',
      baselineCommit: 'baseline-fixture',
      replacementSourceCommit: 'reviewed-fixture',
      originalSha256: sha256(original),
      installedSha256: sha256(installed),
      originalBlock,
      originalBlockSha256: sha256(originalBlock),
      installedBlock,
      installedBlockSha256: sha256(installedBlock),
      patch: 'fixture patch\n',
      patchSha256: sha256('fixture patch\n'),
      artifactPrefix: 'baseline-native-ui-observation-overlay',
    }),
  };
}

// Exact gzip-compressed browser-chrome.spec.mjs bytes from frozen baseline
// 50ad63d648b27f867aa248cf3e8517aac0b4308d. The decoded full-file hashes below
// make this fixture self-contained in shallow checkouts.
const FROZEN_BASELINE_BROWSER_CHROME_GZIP_BASE64 = [
  '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',
].join('');

test('default source overlay produces the exact reviewed file from the frozen baseline bytes', () => {
  const original = gunzipSync(
      Buffer.from(FROZEN_BASELINE_BROWSER_CHROME_GZIP_BASE64, 'base64'),
    ).toString('utf8'),
    originalHash = createHash('sha256').update(original).digest('hex');
  assert.equal(
    originalHash,
    'bfbbcd244957a2fcf5e2f83c193f104c456519cfd9647d0f178d8947349ec77c',
  );
  const installed = buildExactSourceOverlay(original),
    installedHash = createHash('sha256').update(installed).digest('hex'),
    originalIndex = original.indexOf(BASELINE_NATIVE_UI_OVERLAY.originalBlock),
    installedIndex = installed.indexOf(
      BASELINE_NATIVE_UI_OVERLAY.installedBlock,
    );
  assert.equal(
    installedHash,
    '71f9c7d382eb06047e8fbc50ec19632092ac4067172a1686fd5b015fbbaf9b9e',
  );
  assert(originalIndex > 0);
  assert.equal(installedIndex, originalIndex);
  assert.equal(
    installed.slice(0, installedIndex),
    original.slice(0, originalIndex),
  );
  assert.equal(
    installed.slice(
      installedIndex + BASELINE_NATIVE_UI_OVERLAY.installedBlock.length,
    ),
    original.slice(
      originalIndex + BASELINE_NATIVE_UI_OVERLAY.originalBlock.length,
    ),
  );
});

test('baseline native UI overlay constants pin the frozen source and reviewed geometry blocks', () => {
  assert.deepEqual(
    {
      path: BASELINE_NATIVE_UI_OVERLAY.path,
      baselineCommit: BASELINE_NATIVE_UI_OVERLAY.baselineCommit,
      replacementSourceCommit:
        BASELINE_NATIVE_UI_OVERLAY.replacementSourceCommit,
      originalSha256: BASELINE_NATIVE_UI_OVERLAY.originalSha256,
      installedSha256: BASELINE_NATIVE_UI_OVERLAY.installedSha256,
      originalBlockSha256: BASELINE_NATIVE_UI_OVERLAY.originalBlockSha256,
      installedBlockSha256: BASELINE_NATIVE_UI_OVERLAY.installedBlockSha256,
      patchSha256: BASELINE_NATIVE_UI_OVERLAY.patchSha256,
    },
    {
      path: 'apps/desktop-app/tests/electron/browser-chrome.spec.mjs',
      baselineCommit: '50ad63d648b27f867aa248cf3e8517aac0b4308d',
      replacementSourceCommit: 'd6d6d526b4c71874b2f9ab8f8a299cd4f5ecaac7',
      originalSha256:
        'bfbbcd244957a2fcf5e2f83c193f104c456519cfd9647d0f178d8947349ec77c',
      installedSha256:
        '71f9c7d382eb06047e8fbc50ec19632092ac4067172a1686fd5b015fbbaf9b9e',
      originalBlockSha256:
        '365b9c22d8c60a004eda3673eb648236a9ad2814e723fa32230c16ef5ca40292',
      installedBlockSha256:
        'f58c78b8e9f072a6b3ad41a0bcbe85ff92e46ce192098a298a7bc0926269b103',
      patchSha256:
        '74068f620d0212fc3cc2a191c0584f13b6a85f75841c2b1c4d44dff6fe9ee18c',
    },
  );
  assert.match(BASELINE_NATIVE_UI_OVERLAY.scope, /test-only|UI test/i);
  assert.match(
    BASELINE_NATIVE_UI_OVERLAY.installedBlock,
    /expect\s*\n\s*\.poll/,
  );
  assert.match(BASELINE_NATIVE_UI_OVERLAY.installedBlock, /height > 0/);
  assert.match(BASELINE_NATIVE_UI_OVERLAY.installedBlock, /nonOverlapping/);
  assert.doesNotMatch(
    BASELINE_NATIVE_UI_OVERLAY.installedBlock,
    /timeout|retries/,
  );
});

test('exact source overlay accepts one frozen preimage substitution and rejects every other source shape', () => {
  const { original, installed, contract } = sourceOverlayFixture();
  assert.equal(buildExactSourceOverlay(original, contract), installed);
  assert.throws(
    () =>
      buildExactSourceOverlay(
        original.replace(contract.originalBlock, ''),
        contract,
      ),
    /original observation block exactly once/,
  );
  assert.throws(
    () =>
      buildExactSourceOverlay(
        original.replace(
          contract.originalBlock,
          contract.originalBlock.repeat(2),
        ),
        contract,
      ),
    /original observation block exactly once/,
  );
  assert.throws(
    () => buildExactSourceOverlay(installed, contract),
    /Reviewed observation block already present/,
  );
  assert.throws(
    () => buildExactSourceOverlay(`modified\n${original}`, contract),
    /frozen source preimage changed/i,
  );
  assert.throws(
    () =>
      buildExactSourceOverlay(original, {
        ...contract,
        installedSha256: '0'.repeat(64),
      }),
    /installed source identity differs/i,
  );
});

test('source overlay composes with the local runner config, retains artifacts, and restores both scopes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'e2e-source-overlay-')),
    output = path.join(root, 'evidence'),
    evidence = { localRunner: {} },
    { original, installed, contract } = sourceOverlayFixture(),
    target = path.join(root, contract.path);
  try {
    await mkdir(path.dirname(target), { recursive: true });
    await mkdir(output);
    await writeFile(target, original);
    await writeFile(
      path.join(root, 'playwright.config.mjs'),
      'export default {};\n',
    );
    await withExactSourceOverlay(
      { root, output, evidence, contract },
      async () => {
        assert.equal(await readFile(target, 'utf8'), installed);
        await withLocalRunnerConfig(root, evidence.localRunner, async () => {
          assert.equal(await readFile(target, 'utf8'), installed);
          assert.equal(
            await readFile(path.join(root, LOCAL_RUNNER_CONFIG), 'utf8'),
            evidence.localRunner.bytes,
          );
        });
        await assert.rejects(
          readFile(path.join(root, LOCAL_RUNNER_CONFIG)),
          /ENOENT/,
        );
      },
    );
    assert.equal(await readFile(target, 'utf8'), original);
    assert.equal(evidence.apply.status, 'applied');
    assert.equal(evidence.restore.status, 'restored');
    assert.equal(evidence.original.bytes, original);
    assert.equal(evidence.installed.bytes, installed);
    for (const [name, expected] of [
      [`${contract.artifactPrefix}-source-before.mjs`, original],
      [`${contract.artifactPrefix}-source-applied.mjs`, installed],
      [`${contract.artifactPrefix}.patch`, contract.patch],
    ])
      assert.equal(await readFile(path.join(output, name), 'utf8'), expected);
    assert.deepEqual(
      JSON.parse(
        await readFile(
          path.join(output, `${contract.artifactPrefix}.json`),
          'utf8',
        ),
      ),
      evidence,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('source overlay restores after failure and preserves the original error beside restoration tampering', async () => {
  for (const tamper of [false, true]) {
    const root = await mkdtemp(path.join(tmpdir(), 'e2e-source-restore-')),
      output = path.join(root, 'evidence'),
      evidence = {},
      { original, contract } = sourceOverlayFixture(),
      target = path.join(root, contract.path);
    try {
      await mkdir(path.dirname(target), { recursive: true });
      await mkdir(output);
      await writeFile(target, original);
      let started = 0;
      await assert.rejects(
        withExactSourceOverlay(
          { root, output, evidence, contract },
          async () => {
            started += 1;
            if (tamper) await writeFile(target, 'concurrent source change\n');
            throw new Error('original UI command failure');
          },
        ),
        (error) => {
          assert.match(String(error), /original UI command failure/);
          if (tamper) {
            assert(error instanceof AggregateError);
            assert.match(String(error), /restoration failed/);
            assert.equal(error.cause?.message, 'original UI command failure');
          }
          return true;
        },
      );
      assert.equal(started, 1);
      assert.equal(
        await readFile(target, 'utf8'),
        tamper ? 'concurrent source change\n' : original,
      );
      assert.equal(evidence.restore.status, tamper ? 'failed' : 'restored');
      assert.match(evidence.operation.error, /original UI command failure/);
      if (tamper) assert.match(evidence.restore.error, /refuse overwrite/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('source overlay reconciles an installed file when installation verification fails and starts no work', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'e2e-source-install-')),
    output = path.join(root, 'evidence'),
    evidence = {},
    { original, contract } = sourceOverlayFixture(),
    target = path.join(root, contract.path);
  let hashes = 0,
    started = false;
  const sourceHash = async (file) => {
    hashes += 1;
    if (hashes === 2)
      throw new Error('fixture post-install verification failed');
    return createHash('sha256')
      .update(await readFile(file))
      .digest('hex');
  };
  try {
    await mkdir(path.dirname(target), { recursive: true });
    await mkdir(output);
    await writeFile(target, original);
    await assert.rejects(
      withExactSourceOverlay(
        {
          root,
          output,
          evidence,
          contract,
          sourceHash,
          workDeadline: 100,
          cleanupDeadline: () => 200,
          now: () => 50,
        },
        async () => {
          started = true;
        },
      ),
      /post-install verification failed/,
    );
    assert.equal(started, false);
    assert.equal(evidence.apply.status, 'failed');
    assert.match(evidence.apply.error, /post-install verification failed/);
    assert.equal(evidence.operation.status, 'not-started');
    assert.equal(evidence.restore.status, 'restored');
    assert.equal(evidence.restore.mode, 'owned-installed-source');
    assert.equal(await readFile(target, 'utf8'), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('source overlay uses reserved cleanup time after the work deadline expires', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'e2e-source-deadline-')),
    output = path.join(root, 'evidence'),
    evidence = {},
    { original, contract } = sourceOverlayFixture(),
    target = path.join(root, contract.path);
  let clock = 50,
    benchmarkStarted = false;
  const sourceHash = async (file) =>
    createHash('sha256')
      .update(await readFile(file))
      .digest('hex');
  try {
    await mkdir(path.dirname(target), { recursive: true });
    await mkdir(output);
    await writeFile(target, original);
    await assert.rejects(
      withExactSourceOverlay(
        {
          root,
          output,
          evidence,
          contract,
          sourceHash,
          workDeadline: 100,
          cleanupDeadline: () => 200,
          now: () => clock,
        },
        async () => {
          clock = 150;
          throw new Error('fixture work deadline expired');
        },
      ).then(() => {
        benchmarkStarted = true;
      }),
      /work deadline expired/,
    );
    assert.equal(benchmarkStarted, false);
    assert.equal(evidence.operation.status, 'failed');
    assert.equal(evidence.restore.status, 'restored');
    assert.equal(evidence.restore.cleanupDeadline, 200);
    assert.equal(await readFile(target, 'utf8'), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('source overlay restores after interruption and prevents subsequent benchmark work', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'e2e-source-interrupt-')),
    output = path.join(root, 'evidence'),
    evidence = {},
    { original, contract } = sourceOverlayFixture(),
    target = path.join(root, contract.path),
    controller = new AbortController();
  let benchmarkStarted = false;
  try {
    await mkdir(path.dirname(target), { recursive: true });
    await mkdir(output);
    await writeFile(target, original);
    controller.abort(new Error('fixture interruption'));
    await assert.rejects(
      withExactSourceOverlay({ root, output, evidence, contract }, async () =>
        controller.signal.throwIfAborted(),
      ).then(() => {
        benchmarkStarted = true;
      }),
      /fixture interruption/,
    );
    assert.equal(benchmarkStarted, false);
    assert.equal(evidence.operation.status, 'failed');
    assert.equal(evidence.restore.status, 'restored');
    assert.equal(await readFile(target, 'utf8'), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('source overlay refuses artifact backup collisions before mutation or gate execution', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'e2e-source-collision-')),
    output = path.join(root, 'evidence'),
    evidence = {},
    { original, contract } = sourceOverlayFixture(),
    target = path.join(root, contract.path);
  try {
    await mkdir(path.dirname(target), { recursive: true });
    await mkdir(output);
    await writeFile(target, original);
    await writeFile(
      path.join(output, `${contract.artifactPrefix}-source-before.mjs`),
      'collision\n',
    );
    let started = false;
    await assert.rejects(
      withExactSourceOverlay({ root, output, evidence, contract }, async () => {
        started = true;
      }),
      /EEXIST/,
    );
    assert.equal(started, false);
    assert.equal(await readFile(target, 'utf8'), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('candidate observation validation requires exactly the reviewed replacement block', () => {
  const source = `before\n${BASELINE_NATIVE_UI_OVERLAY.installedBlock}after\n`;
  const observed = assertCandidateNativeUiObservation(source);
  assert.equal(observed.path, BASELINE_NATIVE_UI_OVERLAY.path);
  assert.equal(
    observed.blockSha256,
    BASELINE_NATIVE_UI_OVERLAY.installedBlockSha256,
  );
  assert.throws(
    () => assertCandidateNativeUiObservation('candidate without block'),
    /reviewed observation block exactly once/,
  );
  assert.throws(
    () =>
      assertCandidateNativeUiObservation(
        source + BASELINE_NATIVE_UI_OVERLAY.installedBlock,
      ),
    /reviewed observation block exactly once/,
  );
  assert.throws(
    () =>
      assertCandidateNativeUiObservation(
        source + BASELINE_NATIVE_UI_OVERLAY.originalBlock,
      ),
    /original observation block absent/,
  );
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
}
const closeServer = (server) =>
  new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );

for (const scenario of ['owned-start', 'foreign-race', 'bind-failure']) {
  test(`actual generated runner ${scenario} retains fixture ownership and refuses foreign reuse`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'e2e-runner-fixture-'));
    const foreign = createServer((_request, response) => {
      response.end('healthy');
    });
    let foreignListening = false;
    const previousExitCode = process.exitCode;
    try {
      await listen(foreign);
      foreignListening = true;
      const port = foreign.address().port,
        endpoint = `http://127.0.0.1:${port}`;
      await assert.rejects(assertMockEndpointUnserved(port), /already served/);
      assert(foreign.listening, 'precheck must not stop foreign listener');
      await closeServer(foreign);
      foreignListening = false;
      await assertMockEndpointUnserved(port);
      const mock = 'apps/desktop-app/tests/electron/mock-server/start.mjs';
      await mkdir(path.dirname(path.join(root, mock)), { recursive: true });
      await symlink(
        path.resolve('node_modules'),
        path.join(root, 'node_modules'),
      );
      await writeFile(
        path.join(root, mock),
        `import {createServer} from 'node:http';\nconst server=createServer((_req,res)=>res.end('healthy'));\nserver.listen(${port},'127.0.0.1',()=>console.log('[mock-server] listening on ${endpoint}'));\nprocess.on('SIGTERM',()=>server.close(()=>process.exit(0)));\n`,
      );
      await writeFile(
        path.join(root, 'fixture.spec.mjs'),
        `import {test,expect} from '@playwright/test';\nfor(let i=0;i<4;i++) test('owned fixture '+i,async()=>expect(1).toBe(1));\n`,
      );
      // A deliberately unreachable readiness URL forces a bind/startup failure for
      // the owned command; the foreign listener is never reused or stopped.
      const url =
        scenario === 'bind-failure' ? `${endpoint}/never-ready` : endpoint;
      await writeFile(
        path.join(root, 'playwright.config.mjs'),
        `export default { testDir: '.', testMatch:'fixture.spec.mjs', workers:1, retries:0, reporter:'line', webServer: {command:'node ${mock}', url:${JSON.stringify(url)}, stdout:'pipe', stderr:'pipe', reuseExistingServer:true, timeout:3000} };\n`,
      );
      if (scenario !== 'owned-start') {
        if (scenario === 'bind-failure')
          foreign
            .removeAllListeners('request')
            .on('request', (_request, response) => {
              response.statusCode = 404;
              response.end('not ready');
            });
        await new Promise((resolve) =>
          foreign.listen(port, '127.0.0.1', resolve),
        );
        foreignListening = true;
      }
      const evidence = {},
        record = {},
        controller = new AbortController();
      const log = await open(path.join(root, 'runner.log'), 'wx');
      try {
        await withLocalRunnerConfig(root, evidence, async () => {
          Object.assign(
            record,
            await runCommandProcess({
              executable: process.execPath,
              args: [
                path.resolve('node_modules/@playwright/test/cli.js'),
                'test',
                '--config',
                LOCAL_RUNNER_CONFIG,
                '--reporter=line',
                '--retries=0',
              ],
              cwd: root,
              env: e2eChildEnvironment('local-physical'),
              stdio: ['ignore', 'pipe', 'pipe'],
              timeoutMs: 10_000,
              termGraceMs: 1000,
              killGraceMs: 1000,
              signal: controller.signal,
              onSpawn: observeMockCommandOutput(
                log.fd,
                record,
                controller,
                endpoint,
              ),
            }),
          );
          await completeMockCommandCleanup(record, Date.now() + 5000);
        });
      } finally {
        await log.close();
      }
      const output = await readFile(path.join(root, 'runner.log'), 'utf8');
      assert(record.cleanup.groupGone);
      assert.equal(evidence.status, 'removed');
      if (scenario === 'owned-start') {
        assert.equal(record.code, 0, output);
        assert.deepEqual(nativeUiCounts(output), {
          passed: 4,
          failed: 0,
          skipped: 0,
          flaky: 0,
        });
        assert.equal(
          assertMockStartupOwnership(output, record, endpoint)
            .startupBeforeTests,
          true,
        );
        assert(
          record.mockStartup.processes.some((row) =>
            row.command.includes(mock),
          ),
        );
        assert.equal(record.mockCleanupError, undefined);
        await assertMockEndpointUnserved(port);
      } else {
        assert.notEqual(record.code, 0, output);
        assert.throws(
          () => assertMockStartupOwnership(output, record, endpoint),
          /startup|race/,
        );
        assert(
          foreign.listening,
          'failed owned command must preserve foreign listener',
        );
        await assert.rejects(
          assertMockEndpointUnserved(port),
          /already served/,
        );
        assert(!output.includes('4 passed'), output);
        assert.match(
          output,
          scenario === 'bind-failure' ? /EADDRINUSE/ : /already used/,
        );
      }
    } finally {
      process.exitCode = previousExitCode;
      if (foreignListening) await closeServer(foreign);
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('ownership requires actual descendant identity and observed group disappearance', () => {
  const row = (pid, ppid, pgid, command) =>
    `${pid} ${ppid} ${pgid} Sun Sep 13 10:00:00 2026 ${command}`;
  const leader = row(100, 10, 100, 'node playwright'),
    owned = row(
      101,
      100,
      101,
      'node apps/desktop-app/tests/electron/mock-server/start.mjs',
    ),
    foreign = row(
      300,
      30,
      300,
      'node apps/desktop-app/tests/electron/mock-server/start.mjs',
    );
  assert.throws(
    () => observeOwnedMockServer(100, `${leader}\n${foreign}`),
    /descendant/,
  );
  const observation = observeOwnedMockServer(
    100,
    `${leader}\n${owned}\n${foreign}`,
  );
  assert.deepEqual(observation.groups, [100, 101]);
  assert.throws(
    () => assertObservedMockGroupsGone(observation, owned),
    /remains/,
  );
  assert.equal(
    assertObservedMockGroupsGone(observation, foreign).groupsGone,
    true,
  );
});

async function processSnapshotWithExecutor(
  execFileSync,
  { baseline = false } = {},
) {
  const source = await readFile(
    new URL('./browser-profiles-e2e-ci.mjs', import.meta.url),
    'utf8',
  );
  const start = source.indexOf(
    source.includes('const PROCESS_SNAPSHOT_MAX_BUFFER =')
      ? 'const PROCESS_SNAPSHOT_MAX_BUFFER ='
      : 'const processSnapshot =',
  );
  const end = source.indexOf('function processRows', start);
  assert(start >= 0 && end > start, 'process snapshot source is available');
  const { runInNewContext } = await import('node:vm');
  const implementation = source.slice(start, end);
  const baselineImplementation = implementation.replace(
    /\n {4}maxBuffer: PROCESS_SNAPSHOT_MAX_BUFFER,/,
    '',
  );
  return runInNewContext(
    `${baseline ? baselineImplementation : implementation}\nprocessSnapshot`,
    {
      execFileSync,
    },
  );
}

function processSnapshotChild(input, expectedMaxBuffer) {
  return (file, args, options) => {
    assert.equal(file, '/bin/ps');
    assert.deepEqual(Array.from(args), [
      '-axo',
      'pid=,ppid=,pgid=,lstart=,command=',
    ]);
    assert.equal(options.maxBuffer, expectedMaxBuffer);
    const childOptions = {
      encoding: options.encoding,
      input,
      timeout: options.timeout,
    };
    if (options.maxBuffer !== undefined)
      childOptions.maxBuffer = options.maxBuffer;
    return execFileSync(
      process.execPath,
      ['-e', 'process.stdin.pipe(process.stdout)'],
      childOptions,
    );
  };
}

test('owned mock process snapshot enforces its complete bounded child capture and parses ownership', async () => {
  const maximum = 16 * 1024 * 1024;
  const complete = [
    '700 1 700 Sun Sep 17 13:19:00 2026 node playwright',
    '701 700 701 Sun Sep 17 13:19:01 2026 node apps/desktop-app/tests/electron/mock-server/start.mjs',
    'x'.repeat(1024 * 1024 + 1),
  ].join('\n');
  const snapshot = await processSnapshotWithExecutor(
    processSnapshotChild(complete, maximum),
  );
  const observation = observeOwnedMockServer(700, snapshot(321));
  assert.deepEqual(observation.groups, [700, 701]);

  const baseline = await processSnapshotWithExecutor(
    processSnapshotChild(complete, undefined),
    { baseline: true },
  );
  assert.throws(() => baseline(321), { code: 'ENOBUFS' });

  const overflow = await processSnapshotWithExecutor(
    processSnapshotChild('x'.repeat(maximum + 1), maximum),
  );
  assert.throws(() => overflow(), { code: 'ENOBUFS' });
});

function e2eFinalizationFixture() {
  return {
    execution: 'local-physical',
    releaseAcceptance: false,
    schedule: schedule(),
    attempts: schedule().map((entry) => ({ ...entry, status: 'ok', code: 0 })),
    nativeBaselineUi: {
      code: 0,
      counts: { passed: 4, failed: 0, skipped: 0, flaky: 0 },
    },
    nativeBaselineUiOverlay: {
      restore: { status: 'restored' },
      productionChanged: false,
    },
    comparisons: {
      median: { passed: true, cliCode: 0 },
      p95: { passed: true, cliCode: 0 },
    },
    limitations: [],
  };
}
for (const interruptAt of [null, 'batch.json', 'finalization.json']) {
  test(`real terminal persistence ${interruptAt ? `interrupted after ${interruptAt}` : 'completes'} retains coherent hashes under the lease`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'e2e-finalization-'));
    const output = path.join(root, 'evidence'),
      lockRoot = path.join(root, 'locks');
    const batch = e2eFinalizationFixture(),
      writes = new Map();
    const previousExitCode = process.exitCode;
    let injected = false;
    const listeners = ['SIGINT', 'SIGTERM'].map((name) =>
      process.listenerCount(name),
    );
    try {
      await mkdir(output);
      const retained = [
        'failed-primary.log',
        'baseline-warmup.json',
        'baseline-out-e2e.tar.gz',
        'candidate-out-e2e.tar.gz',
        'dependency-comparison.json',
        'harness-manifest.json',
        'baseline-median.json',
        'candidate-p95.json',
        'comparison-median.json',
        'compare-p95.log',
      ];
      for (const name of retained)
        await writeFile(path.join(output, name), `retained fixture ${name}\n`);
      await withE2EInterruption(({ signal }) =>
        withLocalE2ELease(
          async () => {
            await persistE2EFinalization(
              {
                batch,
                qualification: false,
                output,
                execution: 'local-physical',
                signal,
                finalizationStartedAt: Date.now(),
              },
              {
                writeJson: async (name, value) => {
                  writes.set(name, (writes.get(name) ?? 0) + 1);
                  await writeFile(
                    path.join(output, name),
                    `${JSON.stringify(value, null, 2)}\n`,
                  );
                  assert.deepEqual(
                    await readdir(path.join(lockRoot, 'desktop-runtime')),
                    ['slot-1'],
                  );
                  if (name === interruptAt && !injected) {
                    injected = true;
                    process.emit('SIGINT');
                  } else if (injected) process.emit('SIGTERM');
                },
              },
            );
            assert.deepEqual(
              await readdir(path.join(lockRoot, 'desktop-runtime')),
              ['slot-1'],
            );
          },
          {
            signal,
            env: {},
            acquire: (options) =>
              applyDevScriptSafetyWithWait({
                ...options,
                lockRoot,
                availableMemoryMb: () => 8192,
              }),
          },
        ),
      );
      const json = async (name) =>
        JSON.parse(await readFile(path.join(output, name), 'utf8'));
      const persisted = await json('batch.json'),
        finalization = await json('finalization.json'),
        artifacts = await json('artifact-manifest.json');
      assert.equal(persisted.passed, !interruptAt);
      assert.equal(persisted.releaseAcceptance, false);
      assert.equal(finalization.interrupted, Boolean(interruptAt));
      assert.equal(persisted.finalization.interrupted, Boolean(interruptAt));
      assert.equal(persisted.counts.expected, 13);
      assert.equal(artifacts['artifact-manifest.json'], undefined);
      assert.equal(artifacts['finalization.json'], undefined);
      for (const [name, count] of writes)
        assert.equal(
          count,
          (interruptAt ? 2 : 1) * (name === 'batch.json' ? 2 : 1),
          name,
        );
      for (const name of retained) assert(artifacts[name]);
      for (const [name, hash] of Object.entries(artifacts))
        assert.equal(
          createHash('sha256')
            .update(await readFile(path.join(output, name)))
            .digest('hex'),
          hash,
          name,
        );
      assert.match(persisted.finalization.uploadTiming, /Local evidence only/);
      if (interruptAt) {
        assert.equal(process.exitCode, 1);
        assert.match(persisted.interruption.reason, /SIGINT/);
        assert.match(
          await readFile(path.join(output, 'report.md'), 'utf8'),
          /failed\/incomplete/,
        );
      }
      assert.deepEqual(
        await readdir(path.join(lockRoot, 'desktop-runtime')),
        [],
      );
      assert.deepEqual(
        ['SIGINT', 'SIGTERM'].map((name) => process.listenerCount(name)),
        listeners,
      );
    } finally {
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('terminal analysis preserves failed and missing primaries and requires both comparisons', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'e2e-final-analysis-'));
  const previousExitCode = process.exitCode;
  try {
    for (const change of [
      (batch) => {
        batch.attempts[1].status = 'failed';
      },
      (batch) => {
        batch.attempts[0].status = 'running';
      },
      (batch) => {
        batch.attempts.pop();
      },
      (batch) => {
        batch.comparisons.p95.cliCode = 1;
      },
      (batch) => {
        batch.comparisons.median.passed = false;
      },
      (batch) => {
        batch.nativeBaselineUiOverlay.restore.status = 'failed';
      },
      (batch) => {
        batch.nativeBaselineUiOverlay.productionChanged = true;
      },
    ]) {
      const batch = e2eFinalizationFixture();
      change(batch);
      await persistE2EFinalization({
        batch,
        qualification: false,
        output: root,
        execution: 'local-physical',
        finalizationStartedAt: Date.now(),
      });
      assert.equal(batch.passed, false);
      assert(!batch.attempts.some((entry) => entry.status === 'running'));
      assert.equal(batch.counts.observed, batch.attempts.length);
    }
  } finally {
    process.exitCode = previousExitCode;
    await rm(root, { recursive: true, force: true });
  }
});

// Last-resort fixture cleanup keeps a failing regression test from contaminating
// the host. It checks the original PID/PGID/start/command again and only kills
// that fixture's group, while the test's real isolated lease is still held.
const FIXTURE_PROCESS_SNAPSHOT_MAX_BUFFER = 16 * 1024 * 1024;

async function removeSurvivingFixtureGroups(
  observation,
  {
    spawnProcess = spawnSync,
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  for (const group of observation?.groups ?? []) {
    const originals = observation.processes.filter(
      (entry) => entry.pgid === group,
    );
    const alive = originals.some((entry) => {
      const result = spawnProcess(
        '/bin/ps',
        ['-p', String(entry.pid), '-o', 'pgid=,lstart=,command='],
        { encoding: 'utf8', maxBuffer: FIXTURE_PROCESS_SNAPSHOT_MAX_BUFFER },
      );
      return (
        result.status === 0 &&
        result.stdout.trim().replace(/\s+/g, ' ') ===
          `${entry.pgid} ${entry.started} ${entry.command}`.replace(/\s+/g, ' ')
      );
    });
    if (alive) {
      try {
        process.kill(-group, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
  }
  const end = Date.now() + 1000;
  for (;;) {
    const snapshot = spawnProcess(
      '/bin/ps',
      ['-axo', 'pid=,ppid=,pgid=,lstart=,command='],
      { encoding: 'utf8', maxBuffer: FIXTURE_PROCESS_SNAPSHOT_MAX_BUFFER },
    );
    if (
      snapshot.error ||
      snapshot.status !== 0 ||
      typeof snapshot.stdout !== 'string'
    )
      throw new Error(
        `Fixture process snapshot failed: ${snapshot.error?.code ?? snapshot.status ?? 'unknown'}`,
      );
    try {
      assertObservedMockGroupsGone(observation, snapshot.stdout);
      return;
    } catch (error) {
      if (Date.now() >= end) throw error;
      await wait(25);
    }
  }
}

test('emergency detached fixture cleanup refuses an overflowing process snapshot', async () => {
  let calls = 0;
  await assert.rejects(
    removeSurvivingFixtureGroups(
      { groups: [], processes: [] },
      {
        spawnProcess(_file, _args, options) {
          calls++;
          assert.equal(options.maxBuffer, 16 * 1024 * 1024);
          return {
            status: null,
            error: Object.assign(new Error('overflow'), { code: 'ENOBUFS' }),
            stdout: 'partial-owned-row-must-not-be-used',
          };
        },
      },
    ),
    /Fixture process snapshot failed: ENOBUFS/,
  );
  assert.equal(calls, 1);
});

async function reconstructedBaselineFixtureCleanup(spawnSync, assertGone) {
  const source = await readFile(new URL(import.meta.url), 'utf8');
  const start = source.indexOf('async function removeSurvivingFixtureGroups(');
  const end = source.indexOf(
    "test('emergency detached fixture cleanup refuses",
    start,
  );
  assert(start >= 0 && end > start, 'fixture cleanup source is available');
  const baseline = source
    .slice(start, end)
    .replace(
      /,\n {2}\{\n {4}spawnProcess = spawnSync,\n {4}wait = \(ms\) => new Promise\(\(resolve\) => setTimeout\(resolve, ms\)\),\n {2}\} = \{\},\n/,
      '\n',
    )
    .replaceAll('spawnProcess(', 'spawnSync(')
    .replaceAll(', maxBuffer: FIXTURE_PROCESS_SNAPSHOT_MAX_BUFFER', '')
    .replace(
      /\n {4}if \(\n {6}snapshot\.error \|\|\n {6}snapshot\.status !== 0 \|\|\n {6}typeof snapshot\.stdout !== 'string'\n {4}\)\n {6}throw new Error\(\n {8}`Fixture process snapshot failed: \$\{snapshot\.error\?\.code \?\? snapshot\.status \?\? 'unknown'\}`,\n {6}\);/,
      '',
    );
  assert(!baseline.includes('spawnProcess'));
  assert(!baseline.includes('FIXTURE_PROCESS_SNAPSHOT_MAX_BUFFER'));
  assert(!baseline.includes('Fixture process snapshot failed'));
  const { runInNewContext } = await import('node:vm');
  return runInNewContext(`${baseline}\nremoveSurvivingFixtureGroups`, {
    assertObservedMockGroupsGone: assertGone,
    process: { kill: () => {} },
    spawnSync,
  });
}

test('posthoc reconstructed baseline cleanup passed an overflowing partial snapshot to absence assertion', async () => {
  const partial = 'partial-owned-row-must-not-be-used';
  let calls = 0;
  let observed;
  const cleanup = await reconstructedBaselineFixtureCleanup(
    (_file, _args, options) => {
      calls++;
      assert.equal(options.encoding, 'utf8');
      assert.equal(options.maxBuffer, undefined);
      return {
        status: null,
        error: Object.assign(new Error('overflow'), { code: 'ENOBUFS' }),
        stdout: partial,
      };
    },
    (_observation, snapshot) => {
      observed = snapshot;
      return { groupsGone: true };
    },
  );
  await cleanup({ groups: [], processes: [] });
  assert.equal(calls, 1);
  assert.equal(observed, partial);
});

for (const failure of [
  'runner-killed',
  'runner-interrupted',
  'runner-killed-ignore-term',
]) {
  test(`actual generated runner ${failure} reaps owned detached mock before releasing its lease`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'e2e-detached-cleanup-'));
    const lockRoot = path.join(root, 'locks'),
      record = {},
      controller = new AbortController();
    const foreign = createServer((_request, response) =>
      response.end('foreign'),
    );
    let log,
      injected = false;
    const previousExitCode = process.exitCode;
    try {
      await listen(foreign);
      const foreignPort = foreign.address().port;
      const mock = 'apps/desktop-app/tests/electron/mock-server/start.mjs';
      await mkdir(path.dirname(path.join(root, mock)), { recursive: true });
      await symlink(
        path.resolve('node_modules'),
        path.join(root, 'node_modules'),
      );
      await writeFile(
        path.join(root, mock),
        `import {createServer} from 'node:http';\nconst server=createServer((_req,res)=>res.end('owned'));\nprocess.on('SIGTERM',()=>{${failure.endsWith('ignore-term') ? '' : 'server.close(()=>process.exit(0));'}});\nserver.listen(0,'127.0.0.1',()=>console.log('[mock-server] listening on http://127.0.0.1:'+server.address().port));\n`,
      );
      await writeFile(
        path.join(root, 'playwright.config.mjs'),
        `export default {testDir:'.',testMatch:'fixture.spec.mjs',workers:1,retries:0,webServer:{command:'node ${mock}',wait:{stdout:/listening/},stdout:'pipe',stderr:'pipe',reuseExistingServer:true,timeout:3000}};\n`,
      );
      await writeFile(
        path.join(root, 'fixture.spec.mjs'),
        `import {test} from '@playwright/test';for(let i=0;i<4;i++)test('fixture '+i,async()=>new Promise(r=>setTimeout(r,10000)));\n`,
      );
      log = await open(path.join(root, 'runner.log'), 'wx');
      await withLocalE2ELease(
        async () => {
          try {
            await withLocalRunnerConfig(root, {}, async () => {
              Object.assign(
                record,
                await runCommandProcess({
                  executable: process.execPath,
                  args: [
                    path.resolve('node_modules/@playwright/test/cli.js'),
                    'test',
                    '--config',
                    LOCAL_RUNNER_CONFIG,
                    '--reporter=line',
                  ],
                  cwd: root,
                  env: e2eChildEnvironment('local-physical'),
                  stdio: ['ignore', 'pipe', 'pipe'],
                  timeoutMs: 5000,
                  termGraceMs: 1000,
                  killGraceMs: 1000,
                  signal: controller.signal,
                  onSpawn: (child) => {
                    observeMockCommandOutput(
                      log.fd,
                      record,
                      controller,
                      'http://127.0.0.1:',
                    )(child);
                    child.stdout.on('data', () => {
                      if (!record.mockStartup || injected) return;
                      injected = true;
                      if (failure === 'runner-interrupted')
                        controller.abort(new Error('fixture interruption'));
                      else child.kill('SIGKILL');
                    });
                  },
                }),
              );
              await completeMockCommandCleanup(record, Date.now() + 2000);
            });
            assert(injected, 'real runner must reach observed owned startup');
            assert.equal(record.cleanup.groupGone, true);
            assert.equal(
              record.mockCleanupError,
              undefined,
              JSON.stringify(record),
            );
            assert.equal(record.mockCleanup?.groupsGone, true);
            if (failure.endsWith('ignore-term')) {
              assert(
                record.mockCleanup.actions.some(
                  (action) => action.signal === 'SIGTERM' && action.sent,
                ),
              );
              assert(
                record.mockCleanup.actions.some(
                  (action) => action.signal === 'SIGKILL' && action.sent,
                ),
              );
            }
            assert.deepEqual(
              await readdir(path.join(lockRoot, 'desktop-runtime')),
              ['slot-1'],
            );
            const output = await readFile(
              path.join(root, 'runner.log'),
              'utf8',
            );
            const port = Number(
              output.match(
                /\[mock-server\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
              )?.[1],
            );
            assert(port > 0, 'owned endpoint retained');
            await assertMockEndpointUnserved(port);
            await assert.rejects(
              assertMockEndpointUnserved(foreignPort),
              /already served/,
            );
            assert(foreign.listening);
            if (failure === 'runner-interrupted')
              assert.equal(record.interrupted, true);
            else assert.equal(record.signal, 'SIGKILL');
          } finally {
            if (record.mockStartup)
              await removeSurvivingFixtureGroups(record.mockStartup);
            assert.deepEqual(
              await readdir(path.join(lockRoot, 'desktop-runtime')),
              ['slot-1'],
            );
          }
        },
        {
          env: {},
          signal: controller.signal,
          acquire: (options) =>
            applyDevScriptSafetyWithWait({
              ...options,
              lockRoot,
              availableMemoryMb: () => 8192,
            }),
        },
      );
      assert.deepEqual(
        await readdir(path.join(lockRoot, 'desktop-runtime')),
        [],
      );
    } finally {
      process.exitCode = previousExitCode;
      await log?.close();
      if (foreign.listening) await closeServer(foreign);
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('detached mock cleanup requires a fresh original identity before every signal', () => {
  const row = (pid, ppid, pgid, started, command) =>
    `${pid} ${ppid} ${pgid} ${started} ${command}`;
  const started = 'Sun Sep 13 10:00:00 2026',
    command = 'node apps/desktop-app/tests/electron/mock-server/start.mjs';
  const observation = observeOwnedMockServer(
    100,
    [
      row(100, 10, 100, started, 'node playwright'),
      row(101, 100, 101, started, command),
    ].join('\n'),
  );
  assert.deepEqual(
    verifiedMockCleanupGroups(observation, row(101, 1, 101, started, command)),
    [
      {
        group: 101,
        anchor: { pid: 101, ppid: 1, pgid: 101, started, command },
      },
    ],
  );
  for (const changed of [
    row(101, 1, 101, 'Sun Sep 13 10:00:01 2026', command),
    row(101, 1, 101, started, 'node foreign'),
    row(999, 1, 101, started, command),
  ])
    assert.throws(
      () => verifiedMockCleanupGroups(observation, changed),
      /identity|refusing/,
    );
  assert.deepEqual(
    verifiedMockCleanupGroups(observation, row(101, 1, 999, started, command)),
    [],
  );
});

test('headless controller defaults and accepts only the explicit headless mode', () => {
  const args = [
    '--baseline',
    '/baseline',
    '--candidate',
    '/candidate',
    '--output',
    '/output',
  ];
  assert.equal(parseE2EOptions(args)['window-mode'], 'headless');
  assert.equal(
    parseE2EOptions([...args, '--window-mode', 'headless'])['window-mode'],
    'headless',
  );
  for (const mode of ['headed', 'unknown', ''])
    assert.throws(() => parseE2EOptions([...args, '--window-mode', mode]));
  assert.throws(() =>
    parseE2EOptions([
      ...args,
      '--window-mode',
      'headed',
      '--window-mode',
      'headless',
    ]),
  );
});

test('headless primary and replay require complete consistent native evidence despite passing metrics', () => {
  const good = row();
  validateRun(good.raw, good.attempt, good.identity);
  for (const mutate of [
    (raw) => delete raw.environment.studyWindowMode,
    (raw) => (raw.environment.studyWindowMode = 'unknown'),
    (raw) => delete raw.scenarios[0].windowEvidence,
    (raw) => (raw.scenarios[0].windowEvidence.mode = 'headed-native-1000x640'),
    (raw) => raw.scenarios[0].windowEvidence.atEnd.id++,
    (raw) => raw.scenarios[0].windowEvidence.atEnd.rendererPid++,
    (raw) => (raw.scenarios[0].windowEvidence.atStart.focused = true),
    (raw) => (raw.scenarios[0].windowEvidence.atEnd.documentVisible = false),
    (raw) => delete raw.scenarios[0].windowEvidence.setup,
  ]) {
    const entry = row();
    mutate(entry.raw);
    assert.throws(() => validateRun(entry.raw, entry.attempt, entry.identity));
  }
  good.attempt.diagnose = true;
  good.raw.scenarios[0].diagnostics = {
    status: 'ok',
    replay: structuredClone(good.raw.scenarios[0]),
  };
  validateRun(good.raw, good.attempt, good.identity);
  good.raw.scenarios[0].diagnostics.replay.windowEvidence.mode =
    'headed-native-1000x640';
  assert.throws(() => validateRun(good.raw, good.attempt, good.identity));
  for (const mutate of [
    (replay) => (replay.monitoring.raw.renderer.frames = []),
    (replay) => (replay.monitoring.raw.renderer.taskEvents = []),
    (replay) => (replay.monitoring.raw.resourceSamples = []),
    (replay) => (replay.monitoring.summary.totalCpuPercent.count = 0),
    (replay) => replay.tasks.pop(),
  ]) {
    const entry = row();
    entry.attempt.diagnose = true;
    const replay = structuredClone(entry.raw.scenarios[0]);
    mutate(replay);
    entry.raw.scenarios[0].diagnostics = { status: 'ok', replay };
    assert.throws(() => validateRun(entry.raw, entry.attempt, entry.identity));
  }
});

test('reviewed headless comparator overlay validates the frozen baseline preimage without historical Git objects', async () => {
  // Exact comparison.mjs from 50ad63d648b27f867aa248cf3e8517aac0b4308d.
  // Kept inline so sparse hosted history cannot change the test or hide a missing object.
  const before =
    "function compatibleBaseline(baseline, current) {\n  const mismatches = [];\n  if (baseline.schemaVersion !== current.schemaVersion) {\n    mismatches.push('schemaVersion');\n  }\n  if (baseline.suite !== current.suite) mismatches.push('suite');\n  if (baseline.benchmarkKind !== current.benchmarkKind) {\n    mismatches.push('benchmarkKind');\n  }\n  if (baseline.profile !== current.profile) mismatches.push('profile');\n  const baselineScenarios = (baseline.scenarios ?? [])\n    .map(({ name }) => name)\n    .sort();\n  const currentScenarios = (current.scenarios ?? [])\n    .map(({ name }) => name)\n    .sort();\n  if (JSON.stringify(baselineScenarios) !== JSON.stringify(currentScenarios)) {\n    mismatches.push('scenarios');\n  }\n  if (JSON.stringify(baseline.config) !== JSON.stringify(current.config)) {\n    mismatches.push('config');\n  }\n  const environmentKeys = [\n    'electronVersion',\n    'playwrightVersion',\n    'nodeVersion',\n    'platform',\n    'osRelease',\n    'architecture',\n    'cpuModel',\n    'logicalCpuCount',\n    'totalMemoryMb',\n    'viewport',\n    'windowVisible',\n  ];\n  const environmentSnapshot = (result) =>\n    Object.fromEntries(\n      environmentKeys.map((key) => [key, result.environment?.[key]]),\n    );\n  if (\n    JSON.stringify(environmentSnapshot(baseline)) !==\n    JSON.stringify(environmentSnapshot(current))\n  ) {\n    mismatches.push('environment');\n  }\n  if (\n    [...(baseline.scenarios ?? []), ...(current.scenarios ?? [])].some(\n      (scenario) => scenario.status !== 'ok',\n    )\n  ) {\n    mismatches.push('scenarioStatus');\n  }\n  return mismatches;\n}\n\nfunction normalizeLegacyLongTaskMetrics(metrics) {\n  const normalized = { ...metrics };\n  const countSuffix = '.renderer.long_tasks.count';\n  for (const [key, entry] of Object.entries(metrics)) {\n    if (!key.endsWith(countSuffix) || entry?.value !== 0) continue;\n    const prefix = key.slice(0, -countSuffix.length);\n    const maxKey = `${prefix}.renderer.long_tasks.max_ms`;\n    if (normalized[maxKey]) continue;\n    normalized[maxKey] = {\n      value: 0,\n      unit: 'ms',\n      direction: 'lower',\n      description: 'Renderer longest long task',\n    };\n  }\n  return normalized;\n}\n\nexport function comparePerformanceResults(\n  baseline,\n  current,\n  { maxRegressionPercent = 15, minRegressionMs = 20 } = {},\n) {\n  const incompatibilities = compatibleBaseline(baseline, current);\n  const comparisons = [];\n  const regressions = [];\n  const baselineMetrics = normalizeLegacyLongTaskMetrics(\n    baseline.metrics ?? {},\n  );\n  const currentMetrics = normalizeLegacyLongTaskMetrics(current.metrics ?? {});\n  const baselineMetricKeys = Object.keys(baselineMetrics).sort();\n  const currentMetricKeys = Object.keys(currentMetrics).sort();\n  let metricMismatch =\n    JSON.stringify(baselineMetricKeys) !== JSON.stringify(currentMetricKeys);\n\n  for (const [key, baselineMetric] of Object.entries(baselineMetrics)) {\n    const currentMetric = currentMetrics[key];\n    if (!currentMetric || baselineMetric.unit !== currentMetric.unit) {\n      metricMismatch = true;\n      continue;\n    }\n    const baselineValue = baselineMetric.value;\n    const currentValue = currentMetric.value;\n    if (!Number.isFinite(baselineValue) || !Number.isFinite(currentValue))\n      continue;\n    const delta = currentValue - baselineValue;\n    const percent =\n      baselineValue === 0 ? null : (delta / Math.abs(baselineValue)) * 100;\n    const absoluteFloor = Number.isFinite(baselineMetric.minRegressionAbsolute)\n      ? baselineMetric.minRegressionAbsolute\n      : baselineMetric.unit === 'ms'\n        ? minRegressionMs\n        : 0;\n    const regression =\n      delta > absoluteFloor &&\n      (percent === null\n        ? currentValue > absoluteFloor\n        : percent > maxRegressionPercent);\n    const entry = {\n      key,\n      unit: baselineMetric.unit,\n      baseline: baselineValue,\n      current: currentValue,\n      delta,\n      percent,\n      regression,\n    };\n    comparisons.push(entry);\n    if (regression) regressions.push(entry);\n  }\n  if (metricMismatch) incompatibilities.push('metrics');\n\n  return {\n    compatible: incompatibilities.length === 0,\n    incompatibilities,\n    thresholds: { maxRegressionPercent, minRegressionMs },\n    comparisons,\n    regressions,\n    regressedScenarios: [\n      ...new Set(regressions.map((entry) => entry.key.split('.')[0])),\n    ],\n    passed: incompatibilities.length === 0 && regressions.length === 0,\n  };\n}\n";
  const file = 'apps/desktop-app/tests/performance/comparison.mjs';
  assert.equal(
    createHash('sha256').update(before).digest('hex'),
    'a27d241c8e1f32bc04cde6d2a0a699e0b6e9d1e9b641d5f7bce3215444ac4493',
  );
  const after = await readFile(
    new URL('../../../../' + file, import.meta.url),
    'utf8',
  );
  assert.equal(matchedHarnessSource(file, before, after), after);
  assert.throws(
    () => matchedHarnessSource(file, before + '\n', after),
    /Original reviewed helper bytes changed/,
  );
  assert.throws(
    () =>
      matchedHarnessSource('apps/desktop-app/src/main/index.ts', before, after),
    /Unreviewed harness delta/,
  );
  assert.equal(
    matchedHarnessSource(
      'apps/desktop-app/tests/performance/browser-profiles-evidence.mjs',
      null,
      'reviewed candidate helper',
    ),
    'reviewed candidate helper',
  );
  assert.throws(
    () =>
      matchedHarnessSource(
        'apps/desktop-app/tests/performance/browser-profiles-evidence.mjs',
        'present',
        'reviewed candidate helper',
      ),
    /unexpectedly exists/,
  );
});

test('diagnostics overlay requires the frozen preimage and current reviewed bytes', async () => {
  const file = 'apps/desktop-app/tests/performance/diagnostics.mjs';
  const before = FROZEN_DIAGNOSTICS_SOURCE;
  const after = await readFile(file, 'utf8');
  assert.equal(
    createHash('sha256').update(before).digest('hex'),
    '401515b0ac2ffa36f8ceb8979044f987c79f12d9e517e600b107421f984a9120',
  );
  assert.equal(
    createHash('sha256').update(after).digest('hex'),
    '1cb298b806a9e7159942cc06d0ccfd8eebb555e74599c08617703b5f6a14944b',
  );
  assert.equal(matchedHarnessSource(file, before, after), after);
  assert.throws(() => matchedHarnessSource(file, `${before}\n`, after));
  assert.throws(() => matchedHarnessSource(file, before, `${after}\n`));
});

test('inactive production adapter has one explicit E2E baseline-absent closure exception', async () => {
  const { matchedHarnessSource } =
    await import('./browser-profiles-e2e-ci.mjs');
  const file =
    'apps/desktop-app/tests/performance/browser-profiles-production-headless-bootstrap.cjs';
  const source = 'reviewed inactive adapter';
  assert.equal(matchedHarnessSource(file, null, source), source);
  assert.throws(
    () => matchedHarnessSource(file, 'existing bytes', source),
    /unexpectedly exists/,
  );
  assert.throws(
    () =>
      matchedHarnessSource(
        file.replace('bootstrap.cjs', 'arbitrary.cjs'),
        null,
        source,
      ),
    /Unreviewed/,
  );
});

test('generated hosted and active-lease local E2E driver tails parse through the real performance parser', async () => {
  const tail = [
    '--profile',
    'baseline',
    '--scenarios',
    'browser-panels',
    '--headless',
    '--study-window-mode',
    'headless',
  ];
  const check = (execution, owner) => {
    const command = e2eCommand(execution, 'driver', tail, owner);
    const driverIndex = command.args.indexOf(
      'apps/desktop-app/tests/performance/run.mjs',
    );
    assert(driverIndex >= 0);
    const actualTail = command.args.slice(driverIndex + 1);
    assert.deepEqual(
      parsePerformanceArgs(actualTail),
      parsePerformanceArgs(tail),
    );
  };
  const lockRoot = await mkdtemp(path.join(tmpdir(), 'e2e-parser-lease-'));
  const errors = [];
  try {
    try {
      check('hosted');
    } catch (error) {
      errors.push(error);
    }
    await withLocalE2ELease(
      async (owner) => {
        try {
          check('local-physical', owner);
        } catch (error) {
          errors.push(error);
        }
      },
      {
        env: {},
        acquire: (options) =>
          applyDevScriptSafetyWithWait({
            ...options,
            lockRoot,
            availableMemoryMb: () => 8192,
          }),
      },
    );
    assert.equal(errors.length, 0, errors.map(String).join('\n'));
  } finally {
    await rm(lockRoot, { recursive: true, force: true });
  }
});

test('diagnostic launch and panel helpers retain exact admission and reject current or original mutations', async () => {
  const root = new URL('../../../../', import.meta.url).pathname;
  for (const file of [
    'apps/desktop-app/tests/electron/launchCanopy.mjs',
    'apps/desktop-app/tests/electron/panelHarness.mjs',
  ]) {
    const after = await readFile(path.join(root, file), 'utf8');
    const { before, installed } = matchedPinnedHarnessSource(file, after);
    assert.equal(installed, file.endsWith('panelHarness.mjs') ? before : after);
    assert.throws(
      () => matchedPinnedHarnessSource(file, after + '\n'),
      /Current immutable harness source changed/,
    );
    const originalSha256 = ACTUAL_HARNESS_IDENTITIES[file][0];
    assert.notEqual(
      createHash('sha256')
        .update(before + '\n')
        .digest('hex'),
      originalSha256,
    );
    if (file.endsWith('launchCanopy.mjs'))
      assert.throws(
        () => matchedHarnessSource(file, before + '\n', after),
        /Original reviewed helper bytes changed/,
      );
  }
  assert.throws(
    () =>
      matchedHarnessSource(
        'apps/desktop-app/tests/electron/browser-profile-test-lifecycle.mjs',
        null,
        'unadmitted helper',
      ),
    /Unreviewed harness delta/,
  );
});

test('exact lifecycle helper admission preserves its absent baseline and rejects every other preimage', async () => {
  const module = await import('./browser-profiles-e2e-ci.mjs');
  const file =
    'apps/desktop-app/tests/electron/browser-profile-test-lifecycle.mjs';
  const after = await readFile(file, 'utf8');
  assert.equal(
    createHash('sha256').update(after).digest('hex'),
    'b2191a0b2253628f906ff6b8d83b018ea4e00de6d36c365812a1682b8fa8a6f4',
  );
  assert.equal(module.matchedHarnessSource(file, null, after), after);
  assert.throws(() => module.matchedHarnessSource(file, after, after));
  assert.throws(() => module.matchedHarnessSource(file, null, after + '\n'));
  assert.throws(() =>
    module.matchedHarnessSource(file + '.unknown', null, after),
  );
  const root = await mkdtemp(path.join(tmpdir(), 'lifecycle-baseline-'));
  try {
    assert.equal(
      await module.readBaselineHarnessSource(root, file, after),
      null,
    );
    await assert.rejects(
      module.readBaselineHarnessSource(root, file, after + '\n'),
    );
    await assert.rejects(
      module.readBaselineHarnessSource(root, file + '.unknown', after),
      { code: 'ENOENT' },
    );
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), 'unexpected existing baseline');
    const before = await module.readBaselineHarnessSource(root, file, after);
    assert.equal(before, 'unexpected existing baseline');
    assert.throws(() => module.matchedHarnessSource(file, before, after));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('exact mock-server overlay installs identical reviewed bytes and rejects every other preimage', async () => {
  const module = await import('./browser-profiles-e2e-ci.mjs');
  const file = 'apps/desktop-app/tests/electron/mock-server/start.mjs';
  const before = FROZEN_CHANGED_HARNESS_BASELINES[file];
  const after = await readFile(file, 'utf8');
  assert.equal(
    createHash('sha256').update(before).digest('hex'),
    'b8bf252001dea13c8ec6a8527cc83f463c861998434c3bf88a430171c12cbbf2',
  );
  // The study installed '5887…'; CAN-3597's port-aware request parsing is the
  // reviewed PR composition on top of the shared-plan route dispatch.
  assert.equal(
    createHash('sha256').update(after).digest('hex'),
    REVIEWED_PR_HARNESS_IDENTITIES[file][0],
  );
  assert.equal(module.matchedHarnessSource(file, before, after), after);
  assert.throws(
    () => module.matchedHarnessSource(file, `${before}\n`, after),
    /Original reviewed helper bytes changed/,
  );
  assert.throws(() => module.matchedHarnessSource(file, null, after));
  assert.throws(
    () => module.matchedHarnessSource(`${file}.unknown`, before, after),
    /Unreviewed harness delta/,
  );
});
