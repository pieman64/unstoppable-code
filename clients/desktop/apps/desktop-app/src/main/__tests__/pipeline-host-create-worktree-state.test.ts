import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CreateWorktreeInputs } from '@canopy/desktop-shared/pipelines/host-create-worktree';
import type { PipelineHostActionCaller } from '@canopy/desktop-shared/node/pipelines/executor/types';
import {
  ATTEMPT_JOURNAL_FILE,
  createWorktreeRequestFingerprint,
  newAttemptRecord,
  readAttemptRecord,
  setBeforeJournalWriteForTests,
  writeAttemptRecord,
  type AttemptPhase,
  type AttemptRecord,
} from '../pipelines/host-create-worktree-state';

const INPUTS: CreateWorktreeInputs = {
  projectId: 'ws-1',
  branch: { kind: 'new', name: 'feature/x' },
  repair: false,
  setup: 'run_and_wait',
  group: 'Reviews',
};

const CALLER: PipelineHostActionCaller = {
  executionId: 'exec-1',
  jobId: 'job',
  stepId: 'create',
  attempt: 0,
  iteration: 0,
  idempotencyKey: 'pipeline-host:exec-1:job::create:0:0',
  executionContext: 'personal',
};

describe('create-worktree attempt journal', () => {
  let artifactsDir: string;

  beforeEach(() => {
    artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-journal-'));
  });

  afterEach(() => {
    setBeforeJournalWriteForTests(undefined);
    fs.rmSync(artifactsDir, { recursive: true, force: true });
  });

  describe('request fingerprint', () => {
    it('ignores key order and omitted values', () => {
      const reordered: CreateWorktreeInputs = {
        group: 'Reviews',
        setup: 'run_and_wait',
        repair: false,
        branch: { name: 'feature/x', kind: 'new' },
        projectId: 'ws-1',
        baseBranch: undefined,
      };
      expect(createWorktreeRequestFingerprint(reordered)).toBe(
        createWorktreeRequestFingerprint(INPUTS),
      );
    });

    it.each([
      ['setup mode', { ...INPUTS, setup: 'run' as const }],
      ['group', { ...INPUTS, group: 'Other' }],
      [
        'branch',
        { ...INPUTS, branch: { kind: 'existing' as const, name: 'feature/x' } },
      ],
      ['base task', { ...INPUTS, baseTaskId: 'wt-1' }],
    ])('changes with the %s', (_label, changed) => {
      expect(createWorktreeRequestFingerprint(changed)).not.toBe(
        createWorktreeRequestFingerprint(INPUTS),
      );
    });
  });

  it('records the trusted owner and attempt identity', () => {
    expect(newAttemptRecord(INPUTS, CALLER)).toEqual({
      version: 1,
      fingerprint: createWorktreeRequestFingerprint(INPUTS),
      owner: 'personal',
      attempt: {
        executionId: 'exec-1',
        jobId: 'job',
        stepId: 'create',
        attempt: 0,
        iteration: 0,
      },
      phase: 'creating',
      scripts: [],
    });
  });

  it('reads absent before the first write and round-trips a record', async () => {
    await expect(readAttemptRecord(artifactsDir)).resolves.toEqual({
      kind: 'absent',
    });
    const record: AttemptRecord = {
      ...newAttemptRecord(INPUTS, CALLER),
      phase: 'finalized',
      worktree: {
        taskId: 'wt-2',
        branchName: 'feature/x',
        createdAt: '2026-10-21T00:00:00.000Z',
        path: '/w/wt-2',
        workspaceKind: 'single-repo',
      },
      setupConfigured: true,
      setupSettled: true,
      scripts: [
        {
          scriptKey: 'setup',
          runId: 'run-1',
          target: 'project',
          lifecycle: 'setup',
          logProjectId: 'ws-1',
          logFile: 'setup.log',
        },
      ],
      group: { group_id: 'grp-1', grouped: 'true' },
      result: {
        status: 'failure',
        failureReason: 'setup_failed',
        error: 'Setup for task `wt-2` failed; check its setup log',
        outputs: { task_id: 'wt-2', setup_exit_code: '3' },
      },
    };

    await writeAttemptRecord(artifactsDir, record);

    await expect(readAttemptRecord(artifactsDir)).resolves.toEqual({
      kind: 'ok',
      record,
    });
    // Atomic writes leave no temp files behind.
    expect(fs.readdirSync(artifactsDir)).toEqual([ATTEMPT_JOURNAL_FILE]);
  });

  it.each([
    ['unparsable JSON', '{"version": 1,'],
    ['an unknown version', JSON.stringify({ version: 2, phase: 'creating' })],
    [
      'an unknown phase',
      JSON.stringify({ ...newAttemptRecord(INPUTS, CALLER), phase: 'later' }),
    ],
    [
      'an unknown failure reason',
      JSON.stringify({
        ...newAttemptRecord(INPUTS, CALLER),
        phase: 'finalized',
        result: {
          status: 'failure',
          failureReason: 'nope',
          error: '',
          outputs: {},
        },
      }),
    ],
  ])('reads %s as corrupt', async (_label, text) => {
    fs.writeFileSync(path.join(artifactsDir, ATTEMPT_JOURNAL_FILE), text);
    await expect(readAttemptRecord(artifactsDir)).resolves.toEqual({
      kind: 'corrupt',
    });
  });

  it('propagates read errors other than a missing file', async () => {
    fs.mkdirSync(path.join(artifactsDir, ATTEMPT_JOURNAL_FILE));
    await expect(readAttemptRecord(artifactsDir)).rejects.toThrow();
  });

  it('serializes writes so the last queued phase lands', async () => {
    const record = newAttemptRecord(INPUTS, CALLER);
    const phases: AttemptPhase[] = [
      'creating',
      'created',
      'setup_starting',
      'setup_running',
    ];
    const order: AttemptPhase[] = [];
    setBeforeJournalWriteForTests((snapshot) => order.push(snapshot.phase));

    await Promise.all(
      phases.map((phase) => {
        record.phase = phase;
        return writeAttemptRecord(artifactsDir, record);
      }),
    );

    expect(order).toEqual(phases);
    const read = await readAttemptRecord(artifactsDir);
    expect(read.kind === 'ok' && read.record.phase).toBe('setup_running');
  });

  it.each(['created', 'setup_starting', 'setup_running', 'finalized'] as const)(
    'keeps the previous phase when a crash interrupts the %s write',
    async (phase) => {
      const record = newAttemptRecord(INPUTS, CALLER);
      const sequence: AttemptPhase[] = [
        'creating',
        'created',
        'setup_starting',
        'setup_running',
        'finalized',
      ];
      setBeforeJournalWriteForTests((snapshot) => {
        if (snapshot.phase === phase) throw new Error('crash');
      });

      let previous: AttemptPhase | undefined;
      for (const next of sequence) {
        record.phase = next;
        try {
          await writeAttemptRecord(artifactsDir, record);
          previous = next;
        } catch {
          break;
        }
      }

      const read = await readAttemptRecord(artifactsDir);
      expect(read.kind === 'ok' && read.record.phase).toBe(previous);
      expect(previous).toBe(sequence[sequence.indexOf(phase) - 1]);
    },
  );

  it('keeps writing after a failed write', async () => {
    const record = newAttemptRecord(INPUTS, CALLER);
    setBeforeJournalWriteForTests((snapshot) => {
      if (snapshot.phase === 'created') throw new Error('disk full');
    });
    record.phase = 'created';
    const failed = writeAttemptRecord(artifactsDir, record);
    record.phase = 'setup_starting';
    const next = writeAttemptRecord(artifactsDir, record);

    await expect(failed).rejects.toThrow('disk full');
    await expect(next).resolves.toBeUndefined();
    const read = await readAttemptRecord(artifactsDir);
    expect(read.kind === 'ok' && read.record.phase).toBe('setup_starting');
  });
});
