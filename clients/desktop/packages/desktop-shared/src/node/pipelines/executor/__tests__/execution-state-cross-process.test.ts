import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { normalizePipeline } from '@canopy/execution-engine/pipelines/normalize-pipeline';
import { createInitialState } from '../pipeline-executor';
import { loadExecutionState, saveExecutionState } from '../execution-state';

interface WriterResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

const REPOSITORY_ROOT = resolve(__dirname, '../../../../../../..');
const WRITER = join(__dirname, 'execution-state-writer-process.ts');

function runWriter(
  role: string,
  dir: string,
  fixture: string,
  startAt: number,
  releaseAt?: number,
): { child: ChildProcessWithoutNullStreams; done: Promise<WriterResult> } {
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      WRITER,
      role,
      dir,
      fixture,
      '50',
      String(startAt),
      String(releaseAt ?? 0),
    ],
    {
      cwd: REPOSITORY_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const done = new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) =>
      resolve({ code, stdout: stdout.trim(), stderr }),
    );
  });
  return { child, done };
}

describe('execution state writes across processes', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'execution-writers-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function fixture(): ReturnType<typeof createInitialState> {
    return createInitialState(
      normalizePipeline({
        name: 'Writer admission',
        on: 'dispatch',
        jobs: { main: { steps: [{ run: 'echo ok' }] } },
      }),
      {
        cwd: dir,
        pipelineId: 'writer-admission',
        runtime: {
          isModelBlockedByOrgPolicy: (): Promise<boolean> =>
            Promise.resolve(false),
          isOrgModelPolicyActive: (): Promise<boolean> =>
            Promise.resolve(false),
          executionsDir: dir,
          tempRootDir: dir,
          bundledActionsDir: dir,
          getProjectActionsDir: (repoPath: string) => repoPath,
          getProjectPipelinesDir: (repoPath: string) => repoPath,
        },
      },
      'writer-admission',
    );
  }

  it('excludes a second process while another process runs the execution', async () => {
    const state = fixture();
    const fixturePath = join(dir, 'fixture.json');
    await writeFile(fixturePath, JSON.stringify(state));
    const startAt = Date.now() + 4_000;
    const owner = runWriter('owner', dir, fixturePath, startAt);
    const intruder = runWriter('intruder', dir, fixturePath, startAt);
    state.status = 'running';
    state.owner_pid = owner.child.pid;
    let intruderResult: WriterResult;
    let ownerResult: WriterResult;
    try {
      await saveExecutionState(state, dir);
      intruderResult = await intruder.done;
    } finally {
      owner.child.stdin.end();
      ownerResult = await owner.done;
    }
    expect([ownerResult.code, intruderResult.code]).toEqual([0, 0]);
    expect([ownerResult.stderr, intruderResult.stderr]).toEqual(['', '']);
    expect(JSON.parse(intruderResult.stdout)).toEqual({
      saveSucceeded: 0,
      hideSucceeded: 0,
      refusals: { owned_by_other_process: 100 },
    });
    const final = await loadExecutionState(state.id, dir);
    expect(final).toMatchObject({
      status: 'running',
      owner_pid: owner.child.pid,
      env: { TEST_SEQUENCE: '49' },
    });
    expect(final?.hidden).toBeUndefined();
    expect(
      (await readdir(join(dir, '.locks'))).filter((name) =>
        name.endsWith('.lock'),
      ),
    ).toEqual([]);
  }, 60_000);

  it('admits exactly one of two processes resuming the same paused execution', async () => {
    const state = fixture();
    state.status = 'paused';
    await saveExecutionState(state, dir);
    const fixturePath = join(dir, 'fixture.json');
    await writeFile(fixturePath, JSON.stringify(state));
    const startAt = Date.now() + 4_000;
    const writers = [
      runWriter('resumer', dir, fixturePath, startAt, startAt + 3_000),
      runWriter('resumer', dir, fixturePath, startAt, startAt + 3_000),
    ];
    const results = await Promise.all(writers.map((writer) => writer.done));
    expect(results.map((result) => result.code)).toEqual([0, 0]);
    expect(results.map((result) => result.stderr)).toEqual(['', '']);
    expect(results.map((result) => result.stdout).sort()).toEqual([
      'admitted',
      'refused:owned_by_other_process',
    ]);
    const admitted = results.findIndex(
      (result) => result.stdout === 'admitted',
    );
    const final: unknown = JSON.parse(
      await readFile(join(dir, `${state.id}.json`), 'utf8'),
    );
    if (typeof final !== 'object' || final === null)
      throw new Error('Expected an execution state');
    expect(Reflect.get(final, 'owner_pid')).toBe(writers[admitted].child.pid);
  }, 60_000);
});
