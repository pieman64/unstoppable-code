import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  prepareGitAttributionCapture,
  summarizeGitAttributionLog,
} from './git-attribution.mjs';
import { removeRepositoryGitEnv } from '../../../../scripts/lib/git-repository-env.mjs';

// Git fixtures below must not reach the caller's repository when run from a hook.
removeRepositoryGitEnv();

test('Git attribution ranks bounded source and command-family summaries', () => {
  const summary = summarizeGitAttributionLog(
    [
      'start\t1.000\t101\trenderer-global-poll\tpoll-1\tstatus',
      'start\t1.010\t102\tdesktop-session-snapshot\tsession-1\trev-parse',
      'end\t1.020\t102\t0',
      'start\t1.025\t103\trenderer-global-poll\tpoll-1\tdiff',
      'end\t1.040\t101\t0',
      'end\t1.050\t103\t0',
      'start\t1.060\t104\tunexpected-source\tunset\t/private/repo',
      '',
    ].join('\n'),
  );

  assert.equal(summary.timingComparable, false);
  assert.equal(summary.commandCount, 4);
  assert.equal(summary.completedCommandCount, 3);
  assert.equal(summary.incompleteCommandCount, 1);
  assert.equal(summary.uniqueTaggedRequestCount, 2);
  assert.equal(summary.maxConcurrent, 2);
  assert.deepEqual(
    summary.bySource.map(({ source, commandCount }) => ({
      source,
      commandCount,
    })),
    [
      { source: 'renderer-global-poll', commandCount: 2 },
      { source: 'desktop-session-snapshot', commandCount: 1 },
      { source: 'other', commandCount: 1 },
    ],
  );
  assert.ok(
    summary.byCommandFamily.some(
      (entry) => entry.commandFamily === 'rev-parse',
    ),
  );
  assert.deepEqual(summary.crossSourceOverlaps, [
    {
      sources: ['desktop-session-snapshot', 'renderer-global-poll'],
      overlapCount: 1,
    },
  ]);
  assert.ok(
    summary.sourceCommandFamilies.some(
      (entry) => entry.sourceCommandFamily === 'other:other',
    ),
  );
});

test('Git attribution tolerates malformed and unmatched completion rows', () => {
  const summary = summarizeGitAttributionLog(
    'invalid\nend\t2.0\tmissing\t1\nstart\tnan\t1\tcli\tcli-1\tstatus\n',
  );
  assert.equal(summary.commandCount, 0);
  assert.equal(summary.maxConcurrent, 0);
  assert.deepEqual(summary.bySource, []);
});

test(
  'Git attribution wrapper preserves Git execution and emits one bounded record',
  { skip: process.platform !== 'darwin' },
  () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-perf-git-attribution-'),
    );
    try {
      const capture = prepareGitAttributionCapture(userDataDir);
      const output = execFileSync(
        capture.env.CANOPY_GIT_EXECUTABLE,
        ['--version'],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            ...capture.env,
            CANOPY_GIT_REQUEST_SOURCE: 'renderer-targeted',
            CANOPY_GIT_REQUEST_ID: 'targeted-1',
          },
        },
      );
      assert.match(output, /^git version /);
      const summary = capture.summarize();
      assert.equal(summary.commandCount, 1);
      assert.equal(summary.completedCommandCount, 1);
      assert.equal(summary.bySource[0].source, 'renderer-targeted');
      assert.equal(summary.byCommandFamily[0].commandFamily, 'version');
    } finally {
      rmSync(userDataDir, { recursive: true, force: true });
    }
  },
);

test(
  'Git attribution wrapper identifies a command after path and config options',
  { skip: process.platform !== 'darwin' },
  () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-perf-git-attribution-'),
    );
    const repositoryDir = path.join(userDataDir, 'repository');
    try {
      execFileSync('/usr/bin/git', ['init', repositoryDir], {
        stdio: 'ignore',
      });
      const capture = prepareGitAttributionCapture(userDataDir);
      execFileSync(
        capture.env.CANOPY_GIT_EXECUTABLE,
        ['-c', 'color.ui=false', '-C', repositoryDir, 'status', '--short'],
        {
          env: {
            ...process.env,
            ...capture.env,
          },
          stdio: 'ignore',
        },
      );

      const summary = capture.summarize();
      assert.equal(summary.commandCount, 1);
      assert.equal(summary.bySource[0].source, 'untagged');
      assert.equal(summary.byCommandFamily[0].commandFamily, 'status');
    } finally {
      rmSync(userDataDir, { recursive: true, force: true });
    }
  },
);
