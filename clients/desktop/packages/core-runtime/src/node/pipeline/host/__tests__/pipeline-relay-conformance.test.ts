// CAN-6161 (cloud pipelines CP-03): the worker.pipeline relay contract
// between a remote primary (the web core) and a cloud runner. A fake core
// drives each runner over a serializing JSON-RPC pair; the supervisor
// composition a cloud runner reuses and the reference fake runner must both
// pass. See docs/planning/2026-11-10-cloud-pipelines-relay-binding/README.md.
import {
  WORKER_PIPELINE_PORTABLE_LAUNCH_HOST_MEMBERS,
  WorkerPipelineExecutionStartParamsSchema,
  WorkerPipelinePortableLaunchSchema,
  type CanopyHostExecution,
  type CanopyStreamCursor,
  type WorkerPipelineExecutionEventsItem,
} from '@canopy/protocol/canopy-core';
import type { CanopyHandlerContext } from '../../../../runtime/types';
import { NO_EXECUTION_SECRETS } from '../../../execution-secrets';
import {
  PIPELINE_REMOTE_OWNER_RETRY_DELAY_MS,
  PipelineEventJournal,
  createPipelineOwnerChannel,
  createWorkerPipelineHandlers,
  withPipelineEventJournal,
  type PipelineEventJournalEntry,
  type PipelineExecutionWorker,
} from '../../execution';
import {
  FakePipelineCore,
  FakeRunnerWorker,
  LEASE_TTL_MS,
  canarySecrets,
  RUNNER_PATHS,
  SECRET_CANARY,
  fakeRunner,
  portableLaunch,
  portableStart,
  settle,
  supervisorRunner,
  type RelayRunner,
  type RelayRunnerOptions,
} from './pipeline-relay-fixtures';

const SECRET_REF = `ssr1_${'b'.repeat(43)}`;

const runners: Array<[string, (options?: RelayRunnerOptions) => RelayRunner]> =
  [
    ['the supervisor runner', supervisorRunner],
    ['the fake runner', fakeRunner],
  ];

describe.each(runners)('worker.pipeline over a relay: %s', (_name, make) => {
  const open: Array<{ core: FakePipelineCore; runner: RelayRunner }> = [];
  const connect = (options?: RelayRunnerOptions): FakePipelineCore => {
    const runner = make(options);
    const core = new FakePipelineCore(runner);
    open.push({ core, runner });
    return core;
  };

  afterEach(async () => {
    for (const { core, runner } of open.splice(0)) {
      core.close();
      await runner.stop();
    }
  });

  it('runs a portable start in the runner’s own paths, with secrets by reference only', async () => {
    const core = connect();
    const launch = portableLaunch();
    const params = {
      ...portableStart('run-paths', launch),
      secrets: [
        {
          name: 'API_TOKEN',
          source: {
            kind: 'stored-secret' as const,
            family: 'environment' as const,
            record: 'config',
            ref: SECRET_REF,
          },
        },
      ],
    };
    const { execution } = await core.start(params);
    expect(execution).toMatchObject({
      executionId: 'run-paths',
      status: 'running',
      runScope: 'worktree',
    });

    const launched = core.runner.launched('run-paths');
    expect(launched?.launch).toMatchObject({
      pipeline: launch.definition.snapshot,
      cwd: RUNNER_PATHS.checkout,
      bundledActionsDir: RUNNER_PATHS.bundledActionsDir,
      nodeProcess: { command: RUNNER_PATHS.node },
      env: { STEP_VALUE: 'from-start' },
      inputs: { greeting: 'hello' },
      secretEnv: { API_TOKEN: SECRET_CANARY },
    });
    expect(launched?.params).not.toHaveProperty('portableLaunch');
    expect(launched?.params).not.toHaveProperty('secrets');

    // Nothing host-local crossed, in either direction.
    expect(core.wireKeys().has('_execution')).toBe(false);
    const wire = core.wireText();
    expect(wire).not.toContain(SECRET_CANARY);
    for (const path of Object.values(RUNNER_PATHS))
      expect(wire).not.toContain(path);
    expect(wire).toContain(SECRET_REF);
  });

  it('serves get, list, cancel and events for a portable run', async () => {
    const core = connect();
    await core.start(portableStart('run-read'));
    await core.start(portableStart('run-cancel'));

    await expect(core.get('run-read')).resolves.toMatchObject({
      execution: { executionId: 'run-read', status: 'running' },
    });
    const { executions } = await core.list();
    expect(
      executions.map(({ execution }) => execution.executionId).sort(),
    ).toEqual(['run-cancel', 'run-read']);

    const events = await core.events('run-read');
    await settle();
    await core.runner.finish('run-read', 'success');
    await expect(events.ended).resolves.toMatchObject({ outcome: 'completed' });
    const { items } = events;
    expect(items[0]).toMatchObject({ kind: 'execution', event: 'snapshot' });
    expect(items[items.length - 1]).toMatchObject({
      kind: 'execution',
      execution: { status: 'success' },
    });

    await expect(core.cancel('run-cancel')).resolves.toMatchObject({
      execution: { executionId: 'run-cancel' },
    });
    await expect(core.cancel('missing')).rejects.toMatchObject({
      payload: { code: 'worker.pipeline.executionNotFound' },
    });
  });

  it('joins a start resent with its idempotency key, without redeeming its secrets again', async () => {
    const core = connect();
    const params = {
      ...portableStart('run-keyed'),
      secrets: [
        {
          name: 'API_TOKEN',
          source: {
            kind: 'stored-secret' as const,
            family: 'environment' as const,
            record: 'config',
            ref: SECRET_REF,
          },
        },
      ],
    };
    const first = await core.start(params);
    // A lost reply: the same start again. Its grant is already redeemed.
    const again = await core.start(params);
    expect(again.execution.executionId).toBe(first.execution.executionId);
    expect((await core.list()).executions).toHaveLength(1);
  });

  it('joins a keyed resend that overlaps the first start, and one sent after its run settled', async () => {
    const core = connect();
    const params = {
      ...portableStart('run-replay'),
      secrets: [
        {
          name: 'API_TOKEN',
          source: {
            kind: 'stored-secret' as const,
            family: 'environment' as const,
            record: 'config',
            ref: SECRET_REF,
          },
        },
      ],
    };
    // Both reach the runner before either answers.
    const [first, overlapping] = await Promise.all([
      core.start(params),
      core.start(params),
    ]);
    expect(overlapping.execution.executionId).toBe(first.execution.executionId);
    await core.runner.finish('run-replay', 'success');

    // After the run settled, a resend answers the run as it is now.
    await expect(core.start(params)).resolves.toMatchObject({
      execution: { executionId: 'run-replay', status: 'success' },
    });
    expect((await core.list()).executions).toHaveLength(1);
  });

  it('answers a resend whose receipt is gone with the run the worker holds', async () => {
    // Another worker over the same runner state: a restart, or an evicted receipt.
    const runner = make();
    const first = new FakePipelineCore(runner);
    const second = new FakePipelineCore(runner.rehandled());
    open.push({ core: first, runner }, { core: second, runner });
    await first.start(portableStart('run-restarted'));
    await runner.finish('run-restarted', 'success');
    await expect(
      second.start(portableStart('run-restarted')),
    ).resolves.toMatchObject({
      execution: { executionId: 'run-restarted', status: 'success' },
    });
    expect((await second.list()).executions).toHaveLength(1);
  });

  it('refuses a start with no launch, and a portable start where the worker maps none', async () => {
    const core = connect();
    const { portableLaunch: _launch, ...bare } = portableStart('run-bare');
    void _launch;
    await expect(core.start(bare)).rejects.toMatchObject({
      payload: {
        code: 'worker.pipeline.launchUnavailable',
        retry: { kind: 'never' },
      },
    });

    const local = connect({ portable: false });
    await expect(local.start(portableStart('run-local'))).rejects.toMatchObject(
      {
        payload: {
          kind: 'invalid_argument',
          code: 'worker.pipeline.launchRefused',
          retry: { kind: 'never' },
        },
      },
    );
    expect(local.runner.launched('run-local')).toBeUndefined();
  });

  it('a remote owner retries an owner-bound start with its key once it subscribes, with its secrets', async () => {
    const core = connect({ remoteOwner: { leaseTtlMs: LEASE_TTL_MS } });
    const params = {
      ...portableStart('run-bound', portableLaunch({ ownerBound: true })),
      secrets: [
        {
          name: 'API_TOKEN',
          source: {
            kind: 'stored-secret' as const,
            family: 'environment' as const,
            record: 'config',
            ref: SECRET_REF,
          },
        },
      ],
    };
    await expect(core.start(params)).rejects.toMatchObject({
      payload: {
        kind: 'unavailable',
        code: 'worker.pipeline.ownerUnavailable',
        retry: {
          kind: 'same_idempotency_key',
          delayMs: PIPELINE_REMOTE_OWNER_RETRY_DELAY_MS,
        },
      },
    });
    expect(core.runner.launched('run-bound')).toBeUndefined();

    await core.own(() => ({ status: 'success', outputs: {} }));
    // The refusal left the secret grant for the retry.
    await expect(core.start(params)).resolves.toMatchObject({
      execution: { executionId: 'run-bound', status: 'running' },
    });
    expect(core.runner.launched('run-bound')?.launch.secretEnv).toEqual({
      API_TOKEN: SECRET_CANARY,
    });
  });

  it('resumes an events stream after its last cursor with what it missed during an outage', async () => {
    const core = connect();
    await core.start(portableStart('run-resume'));
    const first = await core.events('run-resume');
    // Without a cursor the stream starts from a snapshot, with a cursor of its own.
    expect(first.acceptedCursor).toBeNull();
    expect(first.items[0]).toMatchObject({
      kind: 'execution',
      event: 'snapshot',
      execution: { executionId: 'run-resume', status: 'running' },
    });
    await core.runner.output('run-resume', 'one');
    const last = first.cursors[first.cursors.length - 1];
    expect(first.items[first.items.length - 1]).toMatchObject({
      kind: 'output',
      text: 'one',
    });

    first.close();
    await settle();
    await core.runner.output('run-resume', 'two');
    await core.runner.output('run-resume', 'three');

    const second = await core.events('run-resume', last);
    expect(second.acceptedCursor).toEqual(last);
    expect(
      second.items.map((item) =>
        item.kind === 'output' ? item.text : item.kind,
      ),
    ).toEqual(['two', 'three']);
    await core.runner.finish('run-resume', 'success');
    await expect(second.ended).resolves.toMatchObject({ outcome: 'completed' });
    expect(second.items[second.items.length - 1]).toMatchObject({
      kind: 'execution',
      execution: { status: 'success' },
    });

    // One epoch, strictly increasing: the web core dedupes by (runtime, epoch, sequence).
    const cursors = [...first.cursors, ...second.cursors];
    expect(new Set(cursors.map(({ daemonEpoch }) => daemonEpoch)).size).toBe(1);
    for (let index = 1; index < cursors.length; index += 1)
      expect(cursors[index].sequence).toBeGreaterThan(
        cursors[index - 1].sequence,
      );
  });

  it('replays a run that finished during the outage to its end', async () => {
    const core = connect();
    await core.start(portableStart('run-finished'));
    const first = await core.events('run-finished');
    const last = first.cursors[first.cursors.length - 1];
    first.close();
    await settle();
    await core.runner.output('run-finished', 'late');
    await core.runner.finish('run-finished', 'failure');

    const second = await core.events('run-finished', last);
    await expect(second.ended).resolves.toMatchObject({ outcome: 'completed' });
    expect(second.items).toMatchObject([
      { kind: 'output', text: 'late' },
      { kind: 'execution', execution: { status: 'failure' } },
    ]);
  });

  it('answers snapshotRequired for another epoch’s cursor and one older than its journal', async () => {
    const core = connect({ journal: { maxEntries: 3 } });
    await core.start(portableStart('run-old'));
    const first = await core.events('run-old');
    const [{ daemonEpoch }] = first.cursors;
    first.close();
    for (const text of ['a', 'b', 'c', 'd', 'e'])
      await core.runner.output('run-old', text);

    for (const cursor of [
      { daemonEpoch: 'another-incarnation', sequence: 1 },
      { daemonEpoch, sequence: 1 },
    ]) {
      const stream = await core.events('run-old', cursor);
      await expect(stream.ended).resolves.toMatchObject({
        outcome: 'error',
        error: {
          kind: 'failed_precondition',
          code: 'worker.pipeline.snapshotRequired',
          retry: { kind: 'after_refresh' },
        },
      });
      expect(stream.items).toEqual([]);
    }

    // The documented recovery: read the run and reopen without a cursor.
    await expect(core.get('run-old')).resolves.toMatchObject({
      execution: { status: 'running' },
    });
    const fresh = await core.events('run-old');
    expect(fresh.items[0]).toMatchObject({
      kind: 'execution',
      event: 'snapshot',
    });
  });

  it('a worker without a journal answers snapshotRequired for a cursor and a snapshot without one', async () => {
    const core = connect({ journal: false });
    await core.start(portableStart('run-unjournaled'));
    const fresh = await core.events('run-unjournaled');
    expect(fresh.items[0]).toMatchObject({
      kind: 'execution',
      event: 'snapshot',
    });
    const resumed = await core.events('run-unjournaled', fresh.cursors[0]);
    await expect(resumed.ended).resolves.toMatchObject({
      outcome: 'error',
      error: { code: 'worker.pipeline.snapshotRequired' },
    });
  });

  it('opens a stream on a run that just finished with its snapshot first', async () => {
    const core = connect();
    await core.start(portableStart('run-done'));
    await core.runner.finish('run-done', 'success');
    const stream = await core.events('run-done');
    await expect(stream.ended).resolves.toMatchObject({ outcome: 'completed' });
    expect(stream.items).toMatchObject([
      {
        kind: 'execution',
        event: 'snapshot',
        execution: { status: 'success' },
      },
    ]);
  });

  it('gives a new stream only the notifications no stream received', async () => {
    const core = connect();
    await core.start(portableStart('run-notify'));
    const first = await core.events('run-notify');
    await core.runner.notify('run-notify', 'seen');
    expect(first.items[first.items.length - 1]).toMatchObject({
      kind: 'notification',
      title: 'seen',
    });
    first.close();
    await settle();
    await core.runner.notify('run-notify', 'unseen');

    const second = await core.events('run-notify');
    expect(second.items).toMatchObject([
      { kind: 'notification', title: 'unseen' },
      { kind: 'execution', event: 'snapshot' },
    ]);
  });

  it('follows a paused run to its cancel', async () => {
    const core = connect();
    await core.start(portableStart('run-pause-cancel'));
    const stream = await core.events('run-pause-cancel');
    await core.runner.finish('run-pause-cancel', 'paused');
    await core.cancel('run-pause-cancel');
    await expect(stream.ended).resolves.toMatchObject({
      outcome: 'completed',
    });
    expect(stream.items[stream.items.length - 1]).toMatchObject({
      kind: 'execution',
      execution: { status: 'cancelled' },
    });
  });

  it('starts a new stream from the run as last journaled, changes that keep its status included', async () => {
    const core = connect();
    await core.start(portableStart('run-count'));
    await core.runner.update('run-count', { pendingPauseCount: 2 });
    const stream = await core.events('run-count');
    expect(stream.items[0]).toMatchObject({
      kind: 'execution',
      event: 'snapshot',
      execution: { status: 'running', pendingPauseCount: 2 },
    });
  });

  it('ends a stream on a paused run with snapshotRequired once its journal expires', async () => {
    const core = connect({ journal: { retainMs: 30 } });
    await core.start(portableStart('run-paused'));
    await core.runner.finish('run-paused', 'paused');
    const stream = await core.events('run-paused');
    expect(stream.items[0]).toMatchObject({
      kind: 'execution',
      execution: { status: 'paused' },
    });
    await expect(stream.ended).resolves.toMatchObject({
      outcome: 'error',
      error: { code: 'worker.pipeline.snapshotRequired' },
    });
    const resumed = await core.events('run-paused', stream.cursors[0]);
    await expect(resumed.ended).resolves.toMatchObject({
      error: { code: 'worker.pipeline.snapshotRequired' },
    });
  });

  it('a local owner that is gone is never retried', async () => {
    const core = connect();
    await expect(
      core.start(
        portableStart('run-local-owner', portableLaunch({ ownerBound: true })),
      ),
    ).rejects.toMatchObject({
      payload: {
        code: 'worker.pipeline.ownerUnavailable',
        retry: { kind: 'never' },
      },
    });
  });
});

describe('the portable start contract', () => {
  it('admits no host-local launch member', () => {
    const launch = portableLaunch();
    expect(WorkerPipelinePortableLaunchSchema.safeParse(launch).success).toBe(
      true,
    );
    for (const member of Object.keys(
      WORKER_PIPELINE_PORTABLE_LAUNCH_HOST_MEMBERS,
    ))
      expect(
        WorkerPipelinePortableLaunchSchema.safeParse({
          ...launch,
          [member]: '/host/path',
        }).success,
      ).toBe(false);
  });

  it('pins the definition and carries the delegation lease TTL', () => {
    const launch = portableLaunch();
    const invalid = [
      { ...launch, definition: { ...launch.definition, pin: undefined } },
      {
        ...launch,
        definition: {
          ...launch.definition,
          pin: { contentHash: 'not-a-hash', packageDigest: null },
        },
      },
      {
        ...launch,
        definition: {
          ...launch.definition,
          pin: { contentHash: 'a'.repeat(64), packageDigest: 'sha256:abc' },
        },
      },
      { ...launch, delegationLease: undefined },
      { ...launch, delegationLease: { leaseTtlMs: 0 } },
    ];
    for (const value of invalid)
      expect(WorkerPipelinePortableLaunchSchema.safeParse(value).success).toBe(
        false,
      );
    expect(
      WorkerPipelinePortableLaunchSchema.safeParse({
        ...launch,
        definition: {
          ...launch.definition,
          pin: {
            contentHash: 'a'.repeat(64),
            packageDigest: `pp:v1:${'c'.repeat(43)}`,
          },
        },
      }).success,
    ).toBe(true);
    expect(
      WorkerPipelineExecutionStartParamsSchema.safeParse(
        portableStart('run-schema'),
      ).success,
    ).toBe(true);
  });

  it('a start never runs a portable launch beside a host-local one', async () => {
    const runner = supervisorRunner();
    const execution: CanopyHostExecution = {
      childEnvironment: { PATH: '/usr/bin' },
      pipelineLaunch: {
        pipeline: { name: 'p', on: 'dispatch', jobs: {} },
        cwd: '/work/tree',
        bundledActionsDir: '/app/actions',
        env: {},
        secretEnv: {},
      },
    };
    const start =
      runner.handlers.instructions['worker.pipeline.execution.start'];
    if (!start) throw new Error('The runner serves no start.');
    const context = {
      signal: new AbortController().signal,
      execution,
    } as unknown as CanopyHandlerContext;
    await expect(
      Promise.resolve(start(portableStart('run-both'), context)),
    ).rejects.toMatchObject({
      payload: { code: 'worker.pipeline.launchRefused' },
    });
    expect(runner.launched('run-both')).toBeUndefined();
    await runner.stop();
  });
});

/** Journals a run the reference worker holds, as the journaled worker's start does. */
function trackRun(
  worker: FakeRunnerWorker,
  journal: PipelineEventJournal,
  executionId: string,
): void {
  const run = worker.runs.get(executionId);
  if (!run) throw new Error(`No run ${executionId}.`);
  journal.track(worker, executionId, run.execution);
}

describe('the runner event journal', () => {
  const started = async (
    executionId: string,
  ): Promise<{
    worker: FakeRunnerWorker;
    journal: PipelineEventJournal;
  }> => {
    const worker = new FakeRunnerWorker(createPipelineOwnerChannel(), {});
    await worker.start(
      portableStart(executionId),
      new AbortController().signal,
      NO_EXECUTION_SECRETS,
    );
    return { worker, journal: new PipelineEventJournal({ retainMs: 10 }) };
  };
  const follow = (
    journal: PipelineEventJournal,
    executionId: string,
    cursor: CanopyStreamCursor | null,
  ): { opened: string; entries: PipelineEventJournalEntry[] } => {
    const entries: PipelineEventJournalEntry[] = [];
    const opened = journal.open(executionId, cursor, {
      entry: (entry) => entries.push(entry),
      end: () => undefined,
    });
    return { opened: opened.kind, entries };
  };

  it('numbers a run journaled again after its journal expired under a new epoch', async () => {
    const { worker, journal } = await started('run-again');
    trackRun(worker, journal, 'run-again');
    const before = follow(journal, 'run-again', null);
    worker.output('run-again', 'before');
    worker.finish('run-again', 'paused');
    const [first] = before.entries;
    await new Promise((resolve) => setTimeout(resolve, 30));

    // Resumed after its journal expired: a new journal, never the old cursors.
    const run = worker.runs.get('run-again');
    if (!run) throw new Error('No run.');
    run.execution = { ...run.execution, status: 'running' };
    trackRun(worker, journal, 'run-again');
    const after = follow(journal, 'run-again', null);
    worker.output('run-again', 'after');
    expect(after.entries[0].cursor.daemonEpoch).not.toBe(
      first.cursor.daemonEpoch,
    );
    expect(follow(journal, 'run-again', first.cursor).opened).toBe(
      'snapshot_required',
    );
    journal.close();
  });

  it('journals how a run that settled before it could be followed is now', async () => {
    const { worker, journal } = await started('run-instant');
    const run = worker.runs.get('run-instant');
    if (!run) throw new Error('No run.');
    // The start answered `running`, but the run finished in the same tick.
    const stale = run.execution;
    worker.finish('run-instant', 'success');
    journal.track(worker, 'run-instant', stale);
    await settle();
    const ends: unknown[] = [];
    const entries: PipelineEventJournalEntry[] = [];
    const opened = journal.open('run-instant', null, {
      entry: (entry) => entries.push(entry),
      end: (error) => ends.push(error),
    });
    expect(opened).toMatchObject({ kind: 'opened', ended: { error: null } });
    expect(entries[0]?.event).toMatchObject({
      kind: 'execution',
      execution: { status: 'success' },
    });
    journal.close();
  });

  it('reconciles a run that changed after its start answered but before the journal followed it', async () => {
    const { worker, journal } = await started('run-moved');
    const run = worker.runs.get('run-moved');
    if (!run) throw new Error('No run.');
    const stale = run.execution;
    // Changed unseen: no observer was attached yet.
    run.execution = { ...run.execution, pendingPauseCount: 3 };
    journal.track(worker, 'run-moved', stale);
    await settle();
    const entries: PipelineEventJournalEntry[] = [];
    journal.open('run-moved', null, {
      entry: (entry) => entries.push(entry),
      end: () => undefined,
    });
    expect(entries[entries.length - 1]?.event).toMatchObject({
      kind: 'execution',
      event: 'snapshot',
      execution: { status: 'running', pendingPauseCount: 3 },
    });
    journal.close();
  });

  it('keeps what the observer saw over a resume answer that arrives later', async () => {
    const { worker, journal } = await started('run-repaused');
    const run = worker.runs.get('run-repaused');
    if (!run) throw new Error('No run.');
    const resumed = run.execution;
    trackRun(worker, journal, 'run-repaused');
    worker.finish('run-repaused', 'paused');
    // The resume's answer, older than the pause the observer saw.
    journal.track(worker, 'run-repaused', resumed);
    const entries: PipelineEventJournalEntry[] = [];
    journal.open('run-repaused', null, {
      entry: (entry) => entries.push(entry),
      end: () => undefined,
    });
    expect(entries[0]?.event).toMatchObject({
      kind: 'execution',
      execution: { status: 'paused' },
    });
    journal.close();
  });

  it('starts a retried finished run on a new journal its old cursors cannot reach', async () => {
    const { worker, journal } = await started('run-retried');
    trackRun(worker, journal, 'run-retried');
    const before = follow(journal, 'run-retried', null);
    worker.finish('run-retried', 'failure');
    const run = worker.runs.get('run-retried');
    if (!run) throw new Error('No run.');
    run.execution = { ...run.execution, status: 'running', completedAt: null };
    trackRun(worker, journal, 'run-retried');
    expect(
      follow(journal, 'run-retried', before.entries[0].cursor).opened,
    ).toBe('snapshot_required');
    const after = follow(journal, 'run-retried', null);
    expect(after.entries[0]?.event).toMatchObject({
      kind: 'execution',
      execution: { status: 'running' },
    });
    expect(after.entries[0]?.cursor.daemonEpoch).not.toBe(
      before.entries[0].cursor.daemonEpoch,
    );
    journal.close();
  });

  it('keeps no journal for an unfinished run it cannot follow', async () => {
    const { worker, journal } = await started('run-unfollowed');
    const run = worker.runs.get('run-unfollowed');
    if (!run) throw new Error('No run.');
    const stale = run.execution;
    worker.finish('run-unfollowed', 'paused');
    const unobservable: PipelineExecutionWorker = Object.assign(
      Object.create(worker) as FakeRunnerWorker,
      { observe: (): null => null },
    );
    journal.track(unobservable, 'run-unfollowed', stale);
    await settle();
    expect(follow(journal, 'run-unfollowed', null).opened).toBe('untracked');
    journal.close();
  });

  it('keeps the notifications of an unfollowed run for the stream that reads the worker', async () => {
    const { worker, journal } = await started('run-early');
    const run = worker.runs.get('run-early');
    if (!run) throw new Error('No run.');
    const stale = run.execution;
    // Paused before its start answered, after notifying.
    worker.finish('run-early', 'paused');
    const early = { stepId: 's', title: 'early', body: '' };
    let kept = [early];
    const unobservable: PipelineExecutionWorker = Object.assign(
      Object.create(worker) as FakeRunnerWorker,
      {
        observe: (): null => null,
        takeNotifications: () => {
          const taken = kept;
          kept = [];
          return taken;
        },
      },
    );
    journal.track(unobservable, 'run-early', stale);
    await settle();
    expect(follow(journal, 'run-early', null).opened).toBe('untracked');
    expect(
      withPipelineEventJournal(unobservable, journal).takeNotifications?.(
        'run-early',
      ),
    ).toEqual([early]);
    journal.close();
  });

  it('keeps a notification a closed stream never sent for the next one', async () => {
    const { worker, journal } = await started('run-unsent');
    const handlers = createWorkerPipelineHandlers(
      withPipelineEventJournal(worker, journal),
      { secrets: canarySecrets(), journal },
    );
    trackRun(worker, journal, 'run-unsent');
    const open = async (
      blocked: boolean,
    ): Promise<{
      items: WorkerPipelineExecutionEventsItem[];
      stop: (() => void) | void;
    }> => {
      const items: WorkerPipelineExecutionEventsItem[] = [];
      let first = true;
      const sink = {
        // Blocked after the snapshot, as a consumer that stopped reading.
        buffered: (): number => (blocked && !first ? 100_000 : 0),
        emit: (): null => null,
        emitAt: (
          at: CanopyStreamCursor,
          item: WorkerPipelineExecutionEventsItem,
        ): CanopyStreamCursor => {
          first = false;
          items.push(item);
          return at;
        },
        endAt: (): void => undefined,
        end: (): void => undefined,
      };
      const stop = await handlers.streams['worker.pipeline.execution.events'](
        { executionId: 'run-unsent' },
        {
          signal: new AbortController().signal,
        } as unknown as CanopyHandlerContext,
        sink,
      );
      return { items, stop };
    };
    const stuck = await open(true);
    worker.notify('run-unsent', 'unsent');
    await settle();
    expect(stuck.items.map(({ kind }) => kind)).toEqual(['execution']);
    if (typeof stuck.stop === 'function') stuck.stop();

    const next = await open(false);
    expect(next.items).toMatchObject([
      { kind: 'notification', title: 'unsent' },
      { kind: 'execution', event: 'snapshot' },
    ]);
    if (typeof next.stop === 'function') next.stop();
    journal.close();
  });

  it('sends each pending notification once across a retry while an old stream drains', async () => {
    const { worker, journal } = await started('run-acks');
    const handlers = createWorkerPipelineHandlers(
      withPipelineEventJournal(worker, journal),
      { secrets: canarySecrets(), journal },
    );
    trackRun(worker, journal, 'run-acks');
    const stream = async (
      blocked: () => boolean,
    ): Promise<{
      items: WorkerPipelineExecutionEventsItem[];
      stop: (() => void) | void;
    }> => {
      const items: WorkerPipelineExecutionEventsItem[] = [];
      const sink = {
        buffered: (): number => (blocked() ? 100_000 : 0),
        emit: (): null => null,
        emitAt: (
          at: CanopyStreamCursor,
          item: WorkerPipelineExecutionEventsItem,
        ): CanopyStreamCursor => {
          items.push(item);
          return at;
        },
        endAt: (): void => undefined,
        end: (): void => undefined,
      };
      const stop = await handlers.streams['worker.pipeline.execution.events'](
        { executionId: 'run-acks' },
        {
          signal: new AbortController().signal,
        } as unknown as CanopyHandlerContext,
        sink,
      );
      return { items, stop };
    };
    let stalled = false;
    const old = await stream(() => stalled);
    stalled = true;
    worker.notify('run-acks', 'old');
    worker.finish('run-acks', 'failure');
    // A failed-only retry: the run runs again under the same id.
    const run = worker.runs.get('run-acks');
    if (!run) throw new Error('No run.');
    run.execution = { ...run.execution, status: 'running', completedAt: null };
    trackRun(worker, journal, 'run-acks');
    worker.notify('run-acks', 'new');
    // The old stream drains: it sends 'old' under the retired journal's cursor.
    stalled = false;
    await new Promise((resolve) => setTimeout(resolve, 120));
    const titles = (items: WorkerPipelineExecutionEventsItem[]): string[] =>
      items.flatMap((item) =>
        item.kind === 'notification' ? [item.title] : [],
      );
    expect(titles(old.items)).toEqual(['old']);

    const fresh = await stream(() => false);
    expect(titles(fresh.items)).toEqual(['new']);
    for (const opened of [old, fresh])
      if (typeof opened.stop === 'function') opened.stop();
    journal.close();
  });

  it('passes the notifications a worker kept for an unjournaled run through', async () => {
    const { worker, journal } = await started('run-kept');
    const kept = { stepId: 's', title: 'kept', body: '' };
    const journaled = withPipelineEventJournal(
      Object.assign(worker, { takeNotifications: () => [kept] }),
      journal,
    );
    expect(journaled.takeNotifications?.('run-kept')).toEqual([kept]);
    journal.close();
  });

  it('keeps a slow stream bounded: live output collapses into a gap', async () => {
    const { worker, journal } = await started('run-slow');
    const handlers = createWorkerPipelineHandlers(
      withPipelineEventJournal(worker, journal),
      { secrets: canarySecrets(), journal },
    );
    trackRun(worker, journal, 'run-slow');
    let blocked = false;
    const items: WorkerPipelineExecutionEventsItem[] = [];
    const ends: string[] = [];
    const sink = {
      buffered: (): number => (blocked ? 100_000 : 0),
      emit: (): null => null,
      emitAt: (
        at: CanopyStreamCursor,
        item: WorkerPipelineExecutionEventsItem,
      ): CanopyStreamCursor => {
        items.push(item);
        return at;
      },
      endAt: (): void => undefined,
      end: (outcome: string): void => {
        ends.push(outcome);
      },
    };
    const context = {
      signal: new AbortController().signal,
    } as unknown as CanopyHandlerContext;
    const stop = await handlers.streams['worker.pipeline.execution.events'](
      { executionId: 'run-slow' },
      context,
      sink,
    );
    expect(items).toMatchObject([{ kind: 'execution', event: 'snapshot' }]);

    blocked = true;
    worker.notify('run-slow', 'waits');
    for (let index = 0; index < 5_000; index += 1)
      worker.output('run-slow', `line ${index}`);
    blocked = false;
    await new Promise((resolve) => setTimeout(resolve, 120));
    // A gap is reported with the next item, as without a journal.
    worker.finish('run-slow', 'success');
    await settle();
    expect(ends).toEqual(['completed']);
    const outputs = items.filter((item) => item.kind === 'output').length;
    const gaps = items.flatMap((item) =>
      item.kind === 'gap' ? [item.droppedOutputItems] : [],
    );
    expect(items[1]).toMatchObject({ kind: 'notification', title: 'waits' });
    expect(outputs + gaps.reduce((total, count) => total + count, 0)).toBe(
      5_000,
    );
    expect(items.length).toBeLessThan(400);
    expect(items[items.length - 1]).toMatchObject({
      kind: 'execution',
      execution: { status: 'success' },
    });
    if (typeof stop === 'function') stop();
    journal.close();
  });
});
