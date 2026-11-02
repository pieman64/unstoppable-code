import assert from 'node:assert/strict';
import test from 'node:test';
import { renderHotspotMarkdown, summarizeCpuProfile } from './hotspots.mjs';

test('CPU profile summaries aggregate self time and rank application frames', () => {
  const summary = summarizeCpuProfile(
    {
      startTime: 0,
      endTime: 10_000,
      nodes: [
        {
          id: 1,
          callFrame: {
            functionName: 'renderMessages',
            url: '/repo/apps/desktop-app/src/renderer/Chat.tsx',
            lineNumber: 9,
            columnNumber: 4,
          },
        },
        {
          id: 2,
          callFrame: {
            functionName: 'vendorWork',
            url: '/repo/out-e2e/renderer/assets/vendor-react.js',
            lineNumber: 3,
            columnNumber: 2,
          },
        },
        {
          id: 3,
          callFrame: {
            functionName: 'obfuscatorLookup',
            url: '/repo/out-e2e/renderer/assets/chunk-app.js',
            lineNumber: 20,
            columnNumber: 1,
          },
        },
      ],
      samples: [1, 2, 1, 3],
      timeDeltas: [2_000, 1_000, 3_000, 500],
    },
    { processName: 'renderer' },
  );

  assert.equal(summary.sampledMs, 6.5);
  assert.equal(summary.topApplication[0].functionName, 'renderMessages');
  assert.equal(summary.topApplication[0].selfMs, 5);
  assert.equal(summary.topOverall[1].category, 'dependency');
  assert.equal(summary.topGenerated[0].functionName, 'obfuscatorLookup');
});

test('CPU profile summaries attribute native spawn self time to mapped application ancestry', () => {
  const summary = summarizeCpuProfile(
    {
      startTime: 0,
      endTime: 20_000,
      nodes: [
        {
          id: 1,
          callFrame: {
            functionName: '(root)',
            url: '',
            lineNumber: -1,
            columnNumber: -1,
          },
          children: [2, 6],
        },
        {
          id: 2,
          callFrame: {
            functionName: 'getWorktreeStats',
            url: '/repo/apps/desktop-app/src/main/lib/worktree-service.ts',
            lineNumber: 99,
            columnNumber: 2,
          },
          children: [3],
        },
        {
          id: 3,
          callFrame: {
            functionName: 'getDiffStats',
            url: '/repo/apps/desktop-app/src/main/lib/git.ts',
            lineNumber: 149,
            columnNumber: 4,
          },
          children: [4],
        },
        {
          id: 4,
          callFrame: {
            functionName: 'execFile',
            url: 'node:child_process',
            lineNumber: 320,
            columnNumber: 10,
          },
          children: [5],
        },
        {
          id: 5,
          callFrame: {
            functionName: 'spawn',
            url: '',
            lineNumber: -1,
            columnNumber: -1,
          },
        },
        {
          id: 6,
          callFrame: {
            functionName: 'createWorktree',
            url: '/repo/apps/desktop-app/src/main/lib/git.ts',
            lineNumber: 199,
            columnNumber: 4,
          },
          children: [7],
        },
        {
          id: 7,
          callFrame: {
            functionName: 'spawn',
            url: '',
            lineNumber: -1,
            columnNumber: -1,
          },
        },
      ],
      samples: [5, 5, 7],
      timeDeltas: [3_000, 2_000, 1_000],
    },
    { processName: 'Electron main' },
  );

  assert.equal(summary.runtimeCallerPaths.length, 2);
  assert.equal(summary.runtimeCallerPaths[0].runtimeFunction, 'spawn');
  assert.equal(summary.runtimeCallerPaths[0].selfMs, 5);
  assert.equal(summary.runtimeCallerPaths[0].runtimePercent, 100 * (5 / 6));
  assert.deepEqual(
    summary.runtimeCallerPaths[0].applicationPath.map(
      (frame) => frame.functionName,
    ),
    ['getDiffStats', 'getWorktreeStats'],
  );
  assert.deepEqual(
    summary.runtimeCallerPaths[1].applicationPath.map(
      (frame) => frame.functionName,
    ),
    ['createWorktree'],
  );
});

test('CPU profile summaries attribute native SQLite self time to the issuing graph phase', () => {
  const summary = summarizeCpuProfile(
    {
      startTime: 0,
      endTime: 12_000,
      nodes: [
        {
          id: 1,
          callFrame: {
            functionName: '(root)',
            url: '',
            lineNumber: -1,
            columnNumber: -1,
          },
          children: [2],
        },
        {
          id: 2,
          callFrame: {
            functionName: 'resolveCallEdges',
            url: '/repo/packages/code-graph/src/resolve/call-resolver.ts',
            lineNumber: 53,
            columnNumber: 2,
          },
          children: [3],
        },
        {
          id: 3,
          callFrame: {
            functionName: 'listSymbolsForFile',
            url: '/repo/packages/code-graph/src/store/graph-store.ts',
            lineNumber: 644,
            columnNumber: 2,
          },
          children: [4],
        },
        {
          id: 4,
          callFrame: {
            functionName: 'all',
            url: '',
            lineNumber: -1,
            columnNumber: -1,
          },
        },
      ],
      samples: [4, 4],
      timeDeltas: [4_000, 3_000],
    },
    { processName: 'Code Graph utility' },
  );

  assert.equal(summary.runtimeCallerPaths.length, 1);
  assert.equal(summary.runtimeCallerPaths[0].runtimeFunction, 'all');
  assert.equal(summary.runtimeCallerPaths[0].selfMs, 7);
  assert.deepEqual(
    summary.runtimeCallerPaths[0].applicationPath.map(
      (frame) => frame.functionName,
    ),
    ['listSymbolsForFile', 'resolveCallEdges'],
  );
});

test('hotspot report explains profiler limitations and links raw artifacts', () => {
  const markdown = renderHotspotMarkdown({
    scenarioName: 'chats',
    summaries: [
      {
        process: 'renderer',
        sampledMs: 10,
        applicationSelfPercent: 50,
        samplingIntervalUs: 1_000,
        topApplication: [],
        topOverall: [],
      },
    ],
    benchmarkContext: {
      status: 'unresponsive',
      responsiveness: {
        violations: [
          {
            metric: 'renderer.frame_delay.max_ms',
            value: 150,
            budgetMs: 100,
          },
        ],
      },
    },
  });
  assert.match(markdown, /diagnostic replay/i);
  assert.match(markdown, /blocked I\/O/i);
  assert.match(markdown, /electron-trace\.json/);
  assert.match(markdown, /renderer\.frame_delay\.max_ms/);
});

test('hotspot report renders attributed native caller paths', () => {
  const markdown = renderHotspotMarkdown({
    scenarioName: 'worktree-concurrency',
    summaries: [
      {
        process: 'Electron main',
        sampledMs: 20,
        applicationSelfPercent: 5,
        samplingIntervalUs: 1_000,
        topApplication: [],
        topGenerated: [],
        topOverall: [],
        runtimeCallerPaths: [
          {
            runtimeFunction: 'spawn',
            selfMs: 8,
            runtimePercent: 80,
            applicationPath: [
              {
                functionName: 'getDiffStats',
                url: '../../apps/desktop-app/src/main/lib/git.ts',
                line: 150,
              },
            ],
          },
        ],
      },
    ],
  });

  assert.match(markdown, /Native\/runtime caller paths/);
  assert.match(markdown, /getDiffStats/);
  assert.match(markdown, /80\.0% of `spawn`/);
});
