import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildChildEnv,
  DEFAULTS,
  parseProbeArgs,
  summarizeReport,
} from './runner-lib.mjs';

test('parses defaults and bounded overrides', () => {
  assert.deepEqual(parseProbeArgs([]), { prepareOnly: false, ...DEFAULTS });
  const options = parseProbeArgs([
    '--prepare-only',
    '--deadline-ms=120000',
    '--case-timeout-ms=5000',
    '--settle-ms=0',
  ]);
  assert.equal(options.prepareOnly, true);
  assert.equal(options.deadlineMs, 120000);
  assert.equal(options.caseTimeoutMs, 5000);
  assert.equal(options.settleMs, 0);
});

test('rejects unknown, unbounded, and out-of-tree arguments', () => {
  assert.throws(() => parseProbeArgs(['--headed']), /Unknown argument/);
  assert.throws(
    () => parseProbeArgs(['--deadline-ms=1']),
    /must be an integer/,
  );
  assert.throws(
    () => parseProbeArgs(['--deadline-ms=abc']),
    /must be an integer/,
  );
  assert.throws(() => parseProbeArgs(['--out-dir=/tmp/x']), /\.playwright/);
  assert.throws(
    () => parseProbeArgs(['--out-dir=.playwright/../docs']),
    /\.\./,
  );
});

test('child environment drops proxies, credentials, and Electron overrides', () => {
  const env = buildChildEnv(
    {
      PATH: '/bin',
      HOME: '/Users/someone',
      HTTP_PROXY: 'http://proxy',
      https_proxy: 'http://proxy',
      ELECTRON_RUN_AS_NODE: '1',
      NODE_OPTIONS: '--require x',
      ANTHROPIC_API_KEY: 'secret',
    },
    { workDir: '/w', home: '/w/home', tmp: '/w/tmp', config: { a: 1 } },
  );
  assert.equal(env.HOME, '/w/home');
  assert.equal(env.TMPDIR, '/w/tmp');
  for (const key of [
    'HTTP_PROXY',
    'https_proxy',
    'ELECTRON_RUN_AS_NODE',
    'NODE_OPTIONS',
    'ANTHROPIC_API_KEY',
  ]) {
    assert.equal(key in env, false, key);
  }
  assert.deepEqual(JSON.parse(env.S03_PROBE_CONFIG), { a: 1 });
});

test('summary lists refusals and reasons', () => {
  const lines = summarizeReport({
    outcome: 'completed',
    summary: {
      qualified: false,
      productionCompositionQualified: false,
      bindings: {
        shared: {
          qualified: false,
          vectors: { a: { status: 'pass' }, b: { status: 'fail' } },
          mustRefuse: [{ vector: 'b', status: 'fail' }],
        },
      },
      reasons: ['Windows qualification outstanding'],
    },
    lab: {
      cases: [{ status: 'pass' }],
      attacks: [{ id: 'file-link', status: 'pass' }],
    },
  });
  assert.ok(lines.some((line) => line.includes('refuse b (fail)')));
  assert.ok(
    lines.some((line) => line.includes('Windows qualification outstanding')),
  );
  assert.deepEqual(summarizeReport(null), [
    'No probe summary: see the report errors.',
  ]);
});
