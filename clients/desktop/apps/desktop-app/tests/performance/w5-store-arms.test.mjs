import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { comparePerformanceResults } from './comparison.mjs';
import { parsePerformanceArgs } from './profiles.mjs';
import { seedWorkspace } from './scenarios.mjs';
import * as decisionApplyModule from '../../src/main/lib/worktree-record-decision-apply.ts';
import {
  W5_SIDEBAR_PROJECT_PAGE,
  sumW5Deltas,
  w5CaptureCost,
  w5CapturesPer,
  w5CommitAttempts,
  w5CommitMs,
  w5ReadOnlyCheck,
  w5StoreScenarios,
  w5WriteRefusal,
} from './w5-store-scenario.mjs';
import {
  W5_STORE_ENV,
  parseW5StoreArms,
  w5StoreLaunchEnv,
  w5StoreTreatment,
} from './w5-store-arms.mjs';

const { CHAT_BADGES_SUMMARY_VERSION } =
  decisionApplyModule.default ?? decisionApplyModule;
const repoRoot = path.resolve(import.meta.dirname, '../../../..');

function withBundle(contents, run) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'canopy-w5-arms-'));
  try {
    const bundleEntry = path.join(dir, 'index.js');
    writeFileSync(bundleEntry, contents, 'utf8');
    return run(bundleEntry);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function artifact(treatment) {
  return {
    schemaVersion: 2,
    suite: 'desktop-app-performance',
    benchmarkKind: 'e2e-relative',
    profile: 'smoke',
    config: {},
    treatment,
    environment: {},
    scenarios: [{ name: 'w5-store-writes', status: 'ok' }],
    metrics: {},
  };
}

test('the W5 store arm is a launch treatment, never workload configuration', () => {
  const options = parsePerformanceArgs([
    '--scenarios',
    'loaded-ui',
    '--w5-store',
    'daemon-record-port',
  ]);
  assert.equal(options.w5Store, 'daemon-record-port');
  assert.equal(JSON.stringify(options.config).includes('w5'), false);
  assert.deepEqual(w5StoreLaunchEnv(options.w5Store), {
    [W5_STORE_ENV]: 'daemon-record-port',
  });
  assert.deepEqual(w5StoreLaunchEnv(''), {});
  assert.throws(
    () => parsePerformanceArgs(['--scenarios', 'loaded-ui', '--w5-store', 'x']),
    /in-process or daemon-record-port/,
  );
  assert.throws(
    () =>
      parsePerformanceArgs([
        '--scenarios',
        'loaded-ui',
        '--w5-store',
        'in-process',
        '--release-like',
      ]),
    /cannot be used with --release-like/,
  );
  assert.deepEqual(parseW5StoreArms('in-process, daemon-record-port'), {
    baseline: 'in-process',
    candidate: 'daemon-record-port',
  });
});

test('W5 store sizing enters only the configuration of the scenarios that read it', () => {
  const writes = parsePerformanceArgs([
    '--profile',
    'smoke',
    '--scenarios',
    'w5-store-writes',
  ]).config;
  assert.equal(writes.w5StoreBurstSequential, 20);
  assert.equal(writes.w5StoreWorkspaces, 5);
  assert.equal(writes.w5StoreReloads, undefined);
  const other = parsePerformanceArgs(['--scenarios', 'startup-settle']).config;
  assert.equal(
    Object.keys(other).some((key) => key.startsWith('w5Store')),
    false,
  );
  assert.equal(
    parsePerformanceArgs([
      '--scenarios',
      'w5-store-startup',
      '--w5-store-workspaces',
      '140',
    ]).config.w5StoreWorkspaces,
    140,
  );
  assert.throws(
    () =>
      parsePerformanceArgs([
        '--scenarios',
        'w5-store-reload',
        '--w5-store-workspaces',
        '1',
      ]),
    /--w5-store-workspaces must be at least 2/,
  );
  assert.throws(
    () =>
      parsePerformanceArgs([
        '--scenarios',
        'loaded-ui',
        '--w5-store-workspaces',
        '10',
      ]),
    /requires the w5-store-startup or w5-store-reload or w5-store-writes scenario/,
  );
});

test('both arms of one artifact are comparable; arms across artifacts are not', () => {
  withBundle('main bundle', (bundleEntry) => {
    const off = w5StoreTreatment('in-process', {
      bundleEntry,
      brand: 'canopy',
    });
    const on = w5StoreTreatment('daemon-record-port', {
      bundleEntry,
      brand: 'canopy',
    });
    assert.deepEqual(
      { arm: off.arm, enabled: off.enabled, choice: off.choice },
      { arm: 'off', enabled: false, choice: false },
    );
    assert.deepEqual(
      { arm: on.arm, enabled: on.enabled, choice: on.choice },
      { arm: 'on', enabled: true, choice: true },
    );
    assert.match(on.artifactSha256, /^[a-f0-9]{64}$/);
    assert.equal(on.artifactSha256, off.artifactSha256);
    assert.equal(
      comparePerformanceResults(artifact(off), artifact(on)).compatible,
      true,
    );
    assert.equal(
      comparePerformanceResults(artifact(off), artifact(off)).compatible,
      true,
    );
    withBundle('another bundle', (otherEntry) => {
      const other = w5StoreTreatment('daemon-record-port', {
        bundleEntry: otherEntry,
        brand: 'canopy',
      });
      const result = comparePerformanceResults(artifact(off), artifact(other));
      assert.equal(result.compatible, false);
      assert.ok(result.incompatibilities.includes('treatment.artifactSha256'));
    });
  });
});

test('the W5 store fixture is settled, so startup and reloads write nothing', () => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-w5-fixture-'));
  try {
    const { prepare } = w5StoreScenarios({ seedWorkspace });
    const fixture = prepare(userDataDir, {
      w5StoreWorkspaces: 3,
      w5StoreLargeWorkspaceWorktrees: 4,
    });
    const root = path.join(userDataDir, 'workspaces');
    const read = (...parts) =>
      JSON.parse(readFileSync(path.join(root, ...parts), 'utf8'));
    assert.equal(fixture.workspaceIds.length, 3);
    // The default Chats workspace is seeded, not created by the first launch.
    assert.deepEqual(
      read('index.json').workspaces.map((workspace) => workspace.id),
      [...fixture.workspaceIds, 'cowork-default'],
    );
    assert.equal(read('cowork-default', 'workspace.json').type, 'cowork');
    for (const id of fixture.workspaceIds)
      // The capture's workspace id rule.
      assert.match(id, /^[A-Za-z0-9_-]{1,128}$/);
    assert.equal(fixture.largeRowIds.length, 4);
    for (const workspaceId of fixture.workspaceIds) {
      const rows = read(workspaceId, 'worktrees.json').worktrees;
      assert.equal(
        rows.length,
        workspaceId === fixture.largeWorkspaceId ? 4 : 1,
      );
      for (const row of rows) {
        assert.equal(row.chatBadges.needsHydration, false, row.id);
        // An older summary version is rewritten by the launch backfill.
        assert.ok(
          row.chatBadges.version >= CHAT_BADGES_SUMMARY_VERSION,
          row.id,
        );
        // What the poller derives for a checkout without a GitHub remote,
        // so its observation is equivalent and writes nothing.
        assert.deepEqual(row.lastKnownPrStatus.repos, [
          {
            repoId: row.id,
            repoName: row.id,
            status: null,
            prLookupAvailable: false,
          },
        ]);
        assert.ok(
          existsSync(path.join(root, workspaceId, 'worktrees', row.id, '.git')),
          row.id,
        );
      }
    }
    assert.ok(existsSync(fixture.repoPath));
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('a refused W5 write and the captures per load are read from the w5 deltas', () => {
  assert.equal(
    w5WriteRefusal({
      'port.commit': 1,
      'port.reserve.refused.writeRefused.unlisted_writer': 1,
    }),
    'port.reserve.refused.writeRefused.unlisted_writer',
  );
  assert.equal(
    w5WriteRefusal({ 'port.commit.refused.keyReused': 1 }),
    undefined,
  );
  assert.equal(w5WriteRefusal(null), undefined);
  assert.deepEqual(
    w5CapturesPer(
      [
        {
          kind: 'w5_projects_load',
          w5: { 'host.capture': 2, 'host.capture.files': 9 },
        },
        { kind: 'w5_projects_load', w5: { 'host.capture': 2 } },
        { kind: 'w5_projects_load', w5: null },
        { kind: 'w5_sidebar_reload', w5: { 'host.capture': 5 } },
      ],
      'w5_projects_load',
      'w5CapturesPerProjectsLoad',
    ),
    { w5CapturesPerProjectsLoadP50: 2, w5CapturesPerProjectsLoadSamples: 2 },
  );
});

test('startup waits for the sidebar project page the app renders', () => {
  const source = readFileSync(
    path.join(
      repoRoot,
      'packages/ui-app/src/code/shell/sidebar/useProjectListPagination.ts',
    ),
    'utf8',
  );
  assert.equal(
    Number(/const PROJECT_PAGE_SIZE = (\d+);/.exec(source)?.[1]),
    W5_SIDEBAR_PROJECT_PAGE,
  );
});

test('commit attempts, per-write commit time and capture cost come from the w5 deltas', () => {
  assert.equal(
    w5CommitAttempts({
      'host.commit.core.worktree.update': 1,
      'host.commit.us': 900,
      'host.commit.failed': 1,
    }),
    1,
  );
  // The daemon arm counts refused port commits that never reach the host.
  assert.equal(w5CommitAttempts({ 'port.commit': 2 }), 2);
  assert.equal(w5CommitAttempts(null), 0);
  assert.equal(
    w5CommitMs({
      'host.commit.core.worktree.update': 1,
      'host.commit.us': 4_000,
    }),
    4,
  );
  assert.equal(
    w5CommitMs({
      'port.commit': 1,
      'port.commit.us': 9_000,
      'host.commit.core.worktree.update': 1,
      'host.commit.us': 4_000,
    }),
    9,
  );
  assert.equal(w5CommitMs({ 'host.capture': 1 }), null);
  assert.equal(w5CommitMs(null), null);
  assert.deepEqual(
    w5CaptureCost({
      'host.capture': 4,
      'host.capture.us': 8_000,
      'host.capture.chainDecisions': 40,
      'host.capture.retainedCommits': 400,
    }),
    {
      w5CaptureMeanMs: 2,
      w5CaptureMeanChainDecisions: 10,
      w5CaptureMeanRetainedCommits: 100,
    },
  );
  assert.equal(w5CaptureCost({}).w5CaptureMeanMs, null);
  assert.deepEqual(
    sumW5Deltas([{ w5: { a: 1 } }, { w5: null }, { w5: { a: 2, b: 1 } }]),
    { a: 3, b: 1 },
  );
  assert.equal(sumW5Deltas([{ w5: null }]), null);
  assert.deepEqual(
    w5ReadOnlyCheck(
      [
        { kind: 'w5_projects_load', w5: { 'host.capture': 2 } },
        {
          kind: 'w5_sidebar_reload',
          w5: { 'host.commit.w5.worktree_list.write': 3 },
        },
        { kind: 'w5_burst_sequential_write', w5: { 'port.commit': 1 } },
        { kind: 'w5_projects_load', w5: null },
      ],
      ['w5_sidebar_reload', 'w5_projects_load'],
    ),
    { w5ReadTaskCommits: 3, w5ReadTaskSamples: 2 },
  );
});
