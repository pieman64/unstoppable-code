import { spawn } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const W4_REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
export const W4_TEST_PATHS = Object.freeze(
  [
    'w4-local-transport-parity',
    'w4-filesystem-parity',
    'w4-chat-parity',
    'w4-acquisition',
  ].map(
    (name) =>
      `apps/desktop-app/src/main/canopy-runtime/__tests__/${name}.test.ts`,
  ),
);

/** Every W4 suite ran exactly once and every acceptance test passed. */
export function validateW4Results(result, paths = W4_TEST_PATHS) {
  if (
    result?.success !== true ||
    !(result.numTotalTests > 0) ||
    result.numPassedTests !== result.numTotalTests ||
    result.numFailedTests !== 0 ||
    result.numPendingTests !== 0 ||
    result.numTodoTests !== 0 ||
    result.numRuntimeErrorTestSuites !== 0
  )
    throw new Error('W4 acceptance missing, failed or unexpectedly skipped.');
  for (const path of paths) {
    const suites = (result.testResults ?? []).filter((suite) =>
      suite.name?.endsWith(path),
    );
    if (
      suites.length !== 1 ||
      suites[0].status !== 'passed' ||
      !suites[0].assertionResults?.length ||
      suites[0].assertionResults.some((test) => test.status !== 'passed')
    )
      throw new Error(`Missing executed W4 suite: ${path}`);
  }
}

function jestCommand(json) {
  return [
    process.execPath,
    [
      resolve(W4_REPO_ROOT, 'node_modules/jest/bin/jest.js'),
      '--runInBand',
      '--runTestsByPath',
      ...W4_TEST_PATHS,
      '--json',
      `--outputFile=${json}`,
    ],
  ];
}

// Socket paths must fit sun_path, so the child gets a short private root.
function shortTemporaryBase() {
  return process.platform === 'win32' ? tmpdir() : '/tmp';
}

/**
 * Runs the W4 Jest acceptance under the ordinary macOS allocation; it does not
 * recreate parity in Playwright. Logs and Jest JSON stay in the test output.
 */
export async function runW4Jest(
  testInfo,
  {
    signal,
    timeoutMs = 240_000,
    killGraceMs = 5_000,
    command = jestCommand,
    paths,
  } = {},
) {
  if (signal?.aborted) throw new Error('W4 acceptance cancelled before spawn.');
  const json = testInfo.outputPath('w4-jest.json');
  const logs = {
    stdout: testInfo.outputPath('w4-stdout.log'),
    stderr: testInfo.outputPath('w4-stderr.log'),
  };
  const output = { stdout: [], stderr: [] };
  let child;
  let killTimer;
  let stopped = null;
  const stop = (reason) => {
    stopped ??= reason;
    child?.kill('SIGTERM');
    killTimer ??= setTimeout(() => child?.kill('SIGKILL'), killGraceMs);
  };
  const onAbort = () => stop('cancelled');
  // Armed before any await so a stop during setup prevents the spawn.
  const timer = setTimeout(() => stop('timed out'), timeoutMs);
  signal?.addEventListener('abort', onAbort, { once: true });
  let directory;
  let failure;
  try {
    await mkdir(dirname(json), { recursive: true });
    directory = await mkdtemp(join(shortTemporaryBase(), 'w4j-'));
    const childTemporaryRoot = await realpath(directory);
    if (stopped) throw new Error(`W4 Jest ${stopped}.`);
    const [file, args] = command(json);
    child = spawn(file, args, {
      cwd: W4_REPO_ROOT,
      env: { ...process.env, TMPDIR: childTemporaryRoot },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => output.stdout.push(chunk));
    child.stderr.on('data', (chunk) => output.stderr.push(chunk));
    // `close` follows exit and stdio drain, so the child has terminated. A
    // spawned child's `error` (such as a failed kill) still waits for `close`.
    const outcome = await new Promise((done) => {
      child.on('error', (error) => {
        if (child.pid === undefined) done({ error });
      });
      child.once('close', (code, exitSignal) => done({ code, exitSignal }));
    });
    if (outcome.error)
      throw new Error('W4 Jest could not start.', { cause: outcome.error });
    if (stopped) throw new Error(`W4 Jest ${stopped}.`);
    if (outcome.exitSignal || outcome.code !== 0)
      throw new Error(
        `W4 Jest failed: exit ${outcome.code ?? 'none'}, signal ${outcome.exitSignal ?? 'none'}.`,
      );
    const results = await readFile(json, 'utf8').catch((error) => {
      throw new Error('W4 Jest wrote no results.', { cause: error });
    });
    validateW4Results(JSON.parse(results), paths);
  } catch (error) {
    failure = error;
  } finally {
    clearTimeout(timer);
    clearTimeout(killTimer);
    signal?.removeEventListener('abort', onAbort);
  }
  const cleanup = [];
  const attempt = async (work) => {
    try {
      await work();
    } catch (error) {
      cleanup.push(error);
    }
  };
  await attempt(() => writeFile(logs.stdout, Buffer.concat(output.stdout)));
  await attempt(() => writeFile(logs.stderr, Buffer.concat(output.stderr)));
  if (directory)
    await attempt(() => rm(directory, { recursive: true, force: true }));
  for (const [name, path] of [
    ['stdout', logs.stdout],
    ['stderr', logs.stderr],
    ['results', json],
  ]) {
    // Failed runs may leave no results; the logs still record why.
    const present = await access(path).then(
      () => true,
      () => false,
    );
    if (present)
      await attempt(() =>
        testInfo.attach(`L4 fixture transport ${name}`, { path }),
      );
  }
  if (failure && cleanup.length)
    throw new AggregateError(
      [failure, ...cleanup],
      `${failure.message} Cleanup also failed.`,
    );
  if (failure) throw failure;
  if (cleanup.length)
    throw new AggregateError(cleanup, 'W4 Jest artifact cleanup failed.');
}
