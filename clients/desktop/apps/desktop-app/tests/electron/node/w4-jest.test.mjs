import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  W4_TEST_PATHS,
  runW4Jest,
  validateW4Results,
} from '../helpers/w4-jest.mjs';

const SUITE = 'w4-suite.test.ts';

function passing(overrides = {}) {
  return {
    success: true,
    numTotalTests: 2,
    numPassedTests: 2,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    numRuntimeErrorTestSuites: 0,
    testResults: [
      {
        name: `/repo/${SUITE}`,
        status: 'passed',
        assertionResults: [{ status: 'passed' }, { status: 'passed' }],
      },
    ],
    ...overrides,
  };
}

function testInfo(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'w4-jest-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const attachments = [];
  return {
    directory,
    attachments,
    outputPath: (name) => path.join(directory, 'out', name),
    attach: (name, { path: file }) => {
      attachments.push([name, path.basename(file)]);
      return Promise.resolve();
    },
  };
}

// The fake child reports its pid and private TMPDIR, then runs `body`.
function child(body) {
  return (json) => [
    process.execPath,
    [
      '-e',
      `const fs = require('node:fs');
       const json = ${JSON.stringify(json)};
       console.log(JSON.stringify({ pid: process.pid, tmp: process.env.TMPDIR }));
       ${body}`,
    ],
  ];
}

function reported(info) {
  const [line] = readFileSync(info.outputPath('w4-stdout.log'), 'utf8').split(
    '\n',
  );
  return JSON.parse(line);
}

async function started(info) {
  const marker = path.join(info.directory, 'started');
  for (let attempt = 0; attempt < 200 && !existsSync(marker); attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(existsSync(marker), 'child never started');
}

function startedBody(info, body) {
  return `setTimeout(() => fs.writeFileSync(${JSON.stringify(
    path.join(info.directory, 'started'),
  )}, ''), 100); ${body}`;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('selects every W4 suite by exact path', () => {
  assert.deepEqual(
    W4_TEST_PATHS.map((file) => path.basename(file)),
    [
      'w4-local-transport-parity.test.ts',
      'w4-filesystem-parity.test.ts',
      'w4-chat-parity.test.ts',
      'w4-acquisition.test.ts',
    ],
  );
});

test('accepts only complete, fully passing W4 results', () => {
  validateW4Results(passing(), [SUITE]);
  const suite = passing().testResults[0];
  for (const [label, result] of [
    ['failed run', passing({ success: false })],
    ['zero tests', passing({ numTotalTests: 0, numPassedTests: 0 })],
    ['skipped test', passing({ numPendingTests: 1, numPassedTests: 1 })],
    ['todo test', passing({ numTodoTests: 1 })],
    ['runtime error', passing({ numRuntimeErrorTestSuites: 1 })],
    ['missing suite', passing({ testResults: [] })],
    ['duplicate suite', passing({ testResults: [suite, suite] })],
    [
      'empty suite',
      passing({ testResults: [{ ...suite, assertionResults: [] }] }),
    ],
    [
      'skipped assertion',
      passing({
        testResults: [
          {
            ...suite,
            assertionResults: [{ status: 'passed' }, { status: 'pending' }],
          },
        ],
      }),
    ],
    [null, null],
  ])
    assert.throws(() => validateW4Results(result, [SUITE]), Error, label);
});

test('passes a complete child run, keeps its artifacts and removes its root', async (t) => {
  const info = testInfo(t);
  await runW4Jest(info, {
    paths: [SUITE],
    command: child(
      `fs.writeFileSync(json, ${JSON.stringify(JSON.stringify(passing()))});`,
    ),
  });
  const { tmp } = reported(info);
  assert.ok(Buffer.byteLength(tmp) < 40, tmp);
  assert.equal(existsSync(tmp), false);
  assert.deepEqual(info.attachments, [
    ['L4 fixture transport stdout', 'w4-stdout.log'],
    ['L4 fixture transport stderr', 'w4-stderr.log'],
    ['L4 fixture transport results', 'w4-jest.json'],
  ]);
});

for (const [label, body, failure] of [
  ['a nonzero exit', 'process.exitCode = 3;', /exit 3, signal none/],
  [
    'a signal',
    "setTimeout(() => process.kill(process.pid, 'SIGTERM'), 100);",
    /exit none, signal SIGTERM/,
  ],
  ['missing results', '', /wrote no results/],
  [
    'zero executed tests',
    `fs.writeFileSync(json, ${JSON.stringify(
      JSON.stringify(passing({ numTotalTests: 0, numPassedTests: 0 })),
    )});`,
    /acceptance missing, failed or unexpectedly skipped/,
  ],
])
  test(`fails on ${label} and still preserves logs`, async (t) => {
    const info = testInfo(t);
    await assert.rejects(
      runW4Jest(info, {
        paths: [SUITE],
        command: child(`console.error('child stderr'); ${body}`),
      }),
      failure,
    );
    const { tmp } = reported(info);
    assert.equal(existsSync(tmp), false);
    assert.match(
      readFileSync(info.outputPath('w4-stderr.log'), 'utf8'),
      /child stderr/,
    );
  });

test('times out, escalates past an ignored SIGTERM and awaits termination', async (t) => {
  const info = testInfo(t);
  const run = runW4Jest(info, {
    paths: [SUITE],
    timeoutMs: 1_500,
    killGraceMs: 200,
    command: child(
      startedBody(
        info,
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
      ),
    ),
  });
  await started(info);
  await assert.rejects(run, /W4 Jest timed out/);
  const { pid, tmp } = reported(info);
  assert.equal(alive(pid), false);
  assert.equal(existsSync(tmp), false);
});

test('cancels a running child and awaits termination', async (t) => {
  const info = testInfo(t);
  const controller = new AbortController();
  const run = runW4Jest(info, {
    paths: [SUITE],
    signal: controller.signal,
    command: child(startedBody(info, 'setInterval(() => {}, 1000);')),
  });
  await started(info);
  controller.abort();
  await assert.rejects(run, /W4 Jest cancelled/);
  const { pid, tmp } = reported(info);
  assert.equal(alive(pid), false);
  assert.equal(existsSync(tmp), false);
});

test('refuses to spawn after cancellation', async (t) => {
  const info = testInfo(t);
  let spawned = false;
  await assert.rejects(
    runW4Jest(info, {
      signal: AbortSignal.abort(),
      command: () => {
        spawned = true;
        return [process.execPath, ['-e', '']];
      },
    }),
    /cancelled before spawn/,
  );
  assert.equal(spawned, false);
});

test('reports a child that cannot start and still preserves logs', async (t) => {
  const info = testInfo(t);
  const missing = path.join(info.directory, 'missing-node');
  await assert.rejects(
    runW4Jest(info, { paths: [SUITE], command: () => [missing, []] }),
    (error) =>
      /W4 Jest could not start/.test(error.message) &&
      error.cause?.code === 'ENOENT',
  );
  assert.deepEqual(
    info.attachments.map(([name]) => name),
    ['L4 fixture transport stdout', 'L4 fixture transport stderr'],
  );
});

test('honours a cancellation that arrives during temporary-root setup', async (t) => {
  const info = testInfo(t);
  const controller = new AbortController();
  let spawned = false;
  const run = runW4Jest(info, {
    signal: controller.signal,
    timeoutMs: 3_000,
    command: () => {
      spawned = true;
      return [process.execPath, ['-e', 'setInterval(() => {}, 1000);']];
    },
  });
  // runW4Jest is now awaiting its output and temporary directories.
  controller.abort();
  await assert.rejects(run, /W4 Jest cancelled/);
  assert.equal(spawned, false);
});
