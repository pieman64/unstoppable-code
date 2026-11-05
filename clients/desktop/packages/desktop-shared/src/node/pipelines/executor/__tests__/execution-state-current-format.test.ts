import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizePipeline } from '@canopy/desktop-shared/pipelines/normalize-pipeline';
import {
  loadExecutionState,
  prepareActiveExecutionResume,
  saveExecutionState,
} from '../execution-state';
import { createInitialState, resumePipeline } from '../pipeline-executor';
import type {
  AgentRecoveryCheckpoint,
  ExecutionRuntime,
  ExecutionState,
  JobResult,
  PipelinePauseCheckpoint,
  PipelineStatusReason,
} from '../types';

function listStateDirectory(dir: string): string[] {
  return fs.readdirSync(dir).filter((name) => name !== '.locks');
}

const EXECUTION_ID = 'current-format';
const STARTED_AT = '2026-01-01T00:00:00.000Z';
const INPUT_REASON_ID = '123e4567-e89b-42d3-a456-426614174001';
const PROVIDER_REASON_ID = '123e4567-e89b-42d3-a456-426614174002';
const CHILD_REASON_ID = '123e4567-e89b-42d3-a456-426614174003';
const INPUT_CHECKPOINT_ID = '123e4567-e89b-42d3-a456-426614174004';
const AUTHENTICATION_ATTEMPT_ID = '123e4567-e89b-42d3-a456-426614174005';
const INPUT_REQUEST = {
  fields: [{ key: 'answer', label: 'Answer', type: 'string' as const }],
};

/** Mirrors the store's deterministic legacy pause identity. */
function deterministicId(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(
    17,
    20,
  )}-${hex.slice(20, 32)}`;
}

function inputReason(): PipelineStatusReason {
  return {
    id: INPUT_REASON_ID,
    kind: 'input_required',
    code: 'input_requested',
    detected_at: '2026-01-01T00:01:00.000Z',
    source: { job_id: 'ask', step_id: 'question', attempt: 0, iteration: 1 },
  };
}

function providerReason(): PipelineStatusReason {
  return {
    id: PROVIDER_REASON_ID,
    kind: 'provider_usage_limit',
    code: 'rate_limit',
    provider: 'copilot',
    agent_harness: 'copilot',
    authentication_attempt_id: AUTHENTICATION_ATTEMPT_ID,
    account_scope: 'native',
    account_proxy_connection_id: 'proxy-connection',
    auto_resume_suppressed: true,
    model: 'gpt-5',
    detected_at: '2026-01-01T00:02:00.000Z',
    resets_at: '2026-01-01T05:00:00.000Z',
    diagnostic_message: 'Usage limit reached',
    source: {
      job_id: 'agent',
      step_id: 'prompt',
      attempt: 0,
      iteration: 1,
      child_execution_id: 'child-execution',
      child_reason_id: CHILD_REASON_ID,
    },
  };
}

function recoveryCheckpoint(dir: string): AgentRecoveryCheckpoint {
  return {
    version: 2,
    reason_id: PROVIDER_REASON_ID,
    action: 'agent-prompt',
    provider: 'copilot',
    harness: 'copilot',
    step_id: 'prompt',
    session_id: 'copilot-conversation',
    had_agent_activity: true,
    strategy: 'continue_session',
    recovery_count: 0,
    paused_at: '2026-01-01T00:02:00.000Z',
    transcript_file: join(dir, EXECUTION_ID, 'agent', 'transcript.jsonl'),
    failure_message: 'Usage limit reached',
  };
}

function inputCheckpoint(): PipelinePauseCheckpoint {
  return {
    id: INPUT_CHECKPOINT_ID,
    kind: 'input',
    job_id: 'ask',
    logical_job_id: 'ask',
    step_id: 'question',
    attempt: 0,
    iteration: 1,
    detected_at: '2026-01-01T00:01:00.000Z',
    request: INPUT_REQUEST,
  };
}

function createRuntime(dir: string): ExecutionRuntime {
  return {
    // Pipeline fixtures do not enforce an org model policy.
    isModelBlockedByOrgPolicy: (): Promise<boolean> => Promise.resolve(false),
    isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
    executionsDir: dir,
    tempRootDir: join(dir, 'tmp'),
    bundledActionsDir: join(dir, 'actions'),
    getProjectActionsDir: (repoPath: string): string => repoPath,
    getProjectPipelinesDir: (repoPath: string): string => repoPath,
  };
}

/** A paused current-format execution: one input pause and one provider pause. */
function pausedState(dir: string): ExecutionState {
  const state = createInitialState(
    normalizePipeline({
      name: 'Current format',
      on: 'dispatch',
      jobs: {
        ask: { steps: [{ id: 'question', run: 'echo question' }] },
        agent: { steps: [{ id: 'prompt', run: 'echo prompt' }] },
      },
    }),
    { cwd: dir, pipelineId: 'current-format', runtime: createRuntime(dir) },
    EXECUTION_ID,
  );
  state.started_at = STARTED_AT;
  state.status = 'paused';
  state.jobs.ask = {
    status: 'paused',
    steps: {
      question: {
        status: 'paused',
        outputs: {},
        dynamic_env: {},
        pause_requested: true,
        input_request: INPUT_REQUEST,
      },
    },
    outputs: {},
    retry_count: 0,
    iteration_count: 1,
  };
  state.jobs.agent = {
    status: 'paused',
    steps: {
      prompt: {
        status: 'paused',
        outputs: {},
        dynamic_env: {},
        recovery_count: 0,
        agent_recovery: recoveryCheckpoint(dir),
      },
    },
    outputs: {},
    retry_count: 0,
    iteration_count: 1,
  };
  state.status_reasons = [inputReason(), providerReason()];
  state.pending_pauses = [inputCheckpoint()];
  state.pending_input = {
    job_id: 'ask',
    step_id: 'question',
    request: INPUT_REQUEST,
  };
  state.authentication_pause = {
    attempt_id: AUTHENTICATION_ATTEMPT_ID,
    reason_ids: [PROVIDER_REASON_ID],
  };
  return state;
}

function serializedRecord(value: unknown): Record<string, unknown> {
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Expected a serialized record');
  }
  const record: Record<string, unknown> = {};
  Object.assign(record, parsed);
  return record;
}

/** Rewrites the current fixture in the shape each historical writer produced. */
function legacyFixture(
  state: ExecutionState,
  version: number,
): Record<string, unknown> {
  const raw = serializedRecord(state);
  raw.version = version;
  if (version < 8) {
    delete raw.job_definitions;
    delete raw.job_groups;
    delete raw.pending_pauses;
    const jobs = structuredClone(state.jobs);
    for (const job of Object.values(jobs)) {
      for (const step of Object.values(job.steps)) delete step.pause_requested;
      // v1 counted iterations from zero.
      if (version === 1) job.iteration_count = 0;
    }
    raw.jobs = jobs;
  }
  if (version < 6) delete raw.status_reasons;
  return raw;
}

describe('current-format execution state', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'execution-current-format-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeRaw(raw: unknown, id = EXECUTION_ID): Promise<string> {
    const filePath = join(dir, `${id}.json`);
    await writeFile(filePath, JSON.stringify(raw, null, 2), 'utf8');
    return filePath;
  }

  describe('status reason metadata', () => {
    it.each([
      ['claude', 'claude'],
      ['codex', 'codex'],
      ['copilot', 'copilot'],
      ['opencode', 'opencode'],
      ['cursor', 'cursor'],
      ['ollama', 'codex'],
    ] as const)(
      'round-trips a %s reason with its %s harness and authentication attempt',
      async (provider, harness) => {
        const state = pausedState(dir);
        const reason = {
          ...providerReason(),
          provider,
          agent_harness: harness,
        };
        state.status_reasons = [inputReason(), reason];

        await saveExecutionState(state, dir);
        const persisted: unknown = JSON.parse(
          await readFile(join(dir, `${EXECUTION_ID}.json`), 'utf8'),
        );
        const loaded = await loadExecutionState(EXECUTION_ID, dir);

        expect(persisted).toMatchObject({
          status_reasons: [inputReason(), reason],
        });
        expect(loaded?.status_reasons).toEqual([inputReason(), reason]);
      },
    );

    it('preserves reason metadata in a current file loaded without saving', async () => {
      await writeRaw(pausedState(dir));

      const loaded = await loadExecutionState(EXECUTION_ID, dir);

      expect(loaded?.status_reasons).toEqual([inputReason(), providerReason()]);
    });

    it('drops unknown provider and harness values but keeps the reason', async () => {
      const state = pausedState(dir);
      const raw = serializedRecord(state);
      raw.status_reasons = [
        inputReason(),
        {
          ...providerReason(),
          provider: 'invented',
          agent_harness: 'invented',
          authentication_attempt_id: '',
        },
      ];
      await writeRaw(raw);

      const loaded = await loadExecutionState(EXECUTION_ID, dir);

      const expected: PipelineStatusReason = providerReason();
      delete expected.provider;
      delete expected.agent_harness;
      delete expected.authentication_attempt_id;
      expect(loaded?.status_reasons).toEqual([inputReason(), expected]);
    });
  });

  describe('structural validation after migration', () => {
    const inconsistencies: Array<
      [string, (raw: ExecutionState) => void, RegExp]
    > = [
      [
        'a physical result without a definition',
        (raw): void => {
          raw.jobs.extra = structuredClone(raw.jobs.ask);
        },
        /job definitions and results are inconsistent/,
      ],
      [
        'a physical job outside every group',
        (raw): void => {
          raw.job_groups.ask.variant_job_ids = [];
        },
        /Physical job "ask" has no job group/,
      ],
      [
        'a group without a logical definition',
        (raw): void => {
          raw.job_groups.ghost = { ...raw.job_groups.ask, job_id: 'ghost' };
        },
        /Job group "ghost" has no logical definition/,
      ],
      [
        'a stale pause checkpoint',
        (raw): void => {
          raw.jobs.ask.status = 'queued';
        },
        /Pause checkpoint ".*" is stale/,
      ],
      [
        'no job definitions',
        (raw): void => {
          Reflect.deleteProperty(raw, 'job_definitions');
        },
        /Execution state has no job_definitions record/,
      ],
      [
        'no pause checkpoint list',
        (raw): void => {
          Reflect.deleteProperty(raw, 'pending_pauses');
        },
        /Execution state has no pending_pauses list/,
      ],
      [
        'a group without a variant list',
        (raw): void => {
          Reflect.deleteProperty(raw.job_groups.ask, 'variant_job_ids');
        },
        /Job group "ask" has no variant_job_ids list/,
      ],
      [
        'an escaping log path',
        (raw): void => {
          raw.jobs.ask.steps.question.log_file = join(dir, '..', 'outside.log');
        },
        /log_file escapes the execution output directory/,
      ],
    ];

    it.each(
      [8, 9, 10].flatMap((version) =>
        inconsistencies.map(
          ([label, corrupt, message]) =>
            [version, label, corrupt, message] as const,
        ),
      ),
    )(
      'rejects a v%s file with %s',
      async (version, _label, corrupt, message) => {
        const state = pausedState(dir);
        corrupt(state);
        await writeRaw({ ...state, version });

        await expect(loadExecutionState(EXECUTION_ID, dir)).rejects.toThrow(
          message,
        );
      },
    );

    it.each(inconsistencies)(
      'refuses to save current state with %s and keeps the prior snapshot',
      async (_label, corrupt, message) => {
        const state = pausedState(dir);
        await saveExecutionState(state, dir);
        const before = await readFile(
          join(dir, `${EXECUTION_ID}.json`),
          'utf8',
        );

        const corrupted = structuredClone(state);
        corrupt(corrupted);
        await expect(saveExecutionState(corrupted, dir)).rejects.toThrow(
          message,
        );

        await expect(
          readFile(join(dir, `${EXECUTION_ID}.json`), 'utf8'),
        ).resolves.toBe(before);
        expect(listStateDirectory(dir)).toEqual([`${EXECUTION_ID}.json`]);
      },
    );
  });

  describe('resuming a migrated provider pause by reason', () => {
    // V7->V8 gives a legacy provider-paused step an action checkpoint. Resuming
    // the job through its provider reason must retire that checkpoint too.
    it.each([6, 7])(
      'resumes a v%s provider-paused job selected by status reason',
      async (version) => {
        const state = createInitialState(
          normalizePipeline({
            name: 'Legacy provider pause',
            on: 'dispatch',
            jobs: {
              agent: {
                steps: [
                  {
                    id: 'prompt',
                    shell: 'node',
                    run: "process.stdout.write('resumed')",
                  },
                ],
              },
            },
          }),
          { cwd: dir, pipelineId: 'legacy', runtime: createRuntime(dir) },
          EXECUTION_ID,
        );
        state.status = 'paused';
        state.jobs.agent = {
          status: 'paused',
          steps: {
            prompt: {
              status: 'paused',
              outputs: {},
              dynamic_env: {},
              agent_recovery: {
                ...recoveryCheckpoint(dir),
                had_agent_activity: false,
                strategy: 'restart_step',
                session_id: undefined,
              },
            },
          },
          outputs: {},
          retry_count: 0,
          iteration_count: 1,
        };
        state.status_reasons = [providerReason()];
        state.pending_input = undefined;
        await writeRaw(legacyFixture(state, version));

        const handle = await resumePipeline(EXECUTION_ID, {
          cwd: dir,
          runtime: createRuntime(dir),
          statusReasonIds: [PROVIDER_REASON_ID],
        });

        await expect(handle.waitForCompletion()).resolves.toMatchObject({
          status: 'success',
          status_reasons: [],
          pending_pauses: [],
          jobs: { agent: { status: 'success' } },
        });
      },
    );

    it('resumes a second v7 provider pause while the execution is running', async () => {
      const secondReasonId = '123e4567-e89b-42d3-a456-426614174006';
      const started = join(dir, 'second-started');
      const release = join(dir, 'second-release');
      const providerPausedJob = (reasonId: string): JobResult => ({
        status: 'paused',
        steps: {
          prompt: {
            status: 'paused',
            outputs: {},
            dynamic_env: {},
            agent_recovery: {
              ...recoveryCheckpoint(dir),
              reason_id: reasonId,
              had_agent_activity: false,
              strategy: 'restart_step',
              session_id: undefined,
            },
          },
        },
        outputs: {},
        retry_count: 0,
        iteration_count: 1,
      });
      const state = createInitialState(
        normalizePipeline({
          name: 'Legacy provider pauses',
          on: 'dispatch',
          jobs: {
            agent: {
              steps: [
                {
                  id: 'prompt',
                  shell: 'node',
                  run: "process.stdout.write('first')",
                },
              ],
            },
            second: {
              steps: [
                {
                  id: 'prompt',
                  shell: 'node',
                  // Holds the execution running until the test releases it.
                  run: `const fs = process.getBuiltinModule('node:fs');
fs.writeFileSync(${JSON.stringify(started)}, '');
const timer = setInterval(() => {
  if (fs.existsSync(${JSON.stringify(release)})) clearInterval(timer);
}, 10);`,
                },
              ],
            },
          },
        }),
        { cwd: dir, pipelineId: 'legacy', runtime: createRuntime(dir) },
        EXECUTION_ID,
      );
      state.status = 'paused';
      state.jobs.agent = providerPausedJob(PROVIDER_REASON_ID);
      state.jobs.second = providerPausedJob(secondReasonId);
      state.status_reasons = [
        providerReason(),
        {
          ...providerReason(),
          id: secondReasonId,
          source: {
            job_id: 'second',
            step_id: 'prompt',
            attempt: 0,
            iteration: 1,
          },
        },
      ];
      state.pending_input = undefined;
      await writeRaw(legacyFixture(state, 7));

      const handle = await resumePipeline(EXECUTION_ID, {
        cwd: dir,
        runtime: createRuntime(dir),
        statusReasonIds: [secondReasonId],
      });
      for (let attempt = 0; attempt < 500; attempt += 1) {
        if (await stat(started).catch(() => undefined)) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (!handle.resumePaused) throw new Error('Expected a live handle');
      const live = await handle.resumePaused([PROVIDER_REASON_ID]);
      await writeFile(release, '');

      expect(live.pending_pauses).toEqual([]);
      await expect(handle.waitForCompletion()).resolves.toMatchObject({
        status: 'success',
        status_reasons: [],
        pending_pauses: [],
        jobs: { agent: { status: 'success' }, second: { status: 'success' } },
      });
    });

    it('retires only the selected job checkpoint during a live resume', async () => {
      await writeRaw(legacyFixture(pausedState(dir), 7));
      const loaded = await loadExecutionState(EXECUTION_ID, dir);
      if (!loaded) throw new Error('Expected a loaded execution');
      loaded.status = 'running';

      const prepared = prepareActiveExecutionResume(loaded, {
        statusReasonIds: [PROVIDER_REASON_ID],
      });

      expect(prepared.jobs.agent.status).toBe('queued');
      expect(prepared.pending_pauses).toEqual([
        { ...inputCheckpoint(), id: INPUT_REASON_ID },
      ]);
      await expect(saveExecutionState(prepared, dir)).resolves.toBeUndefined();
    });
  });

  describe('v1-v10 fixture matrix', () => {
    const versions = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

    function expectedReasons(version: number): PipelineStatusReason[] {
      if (version >= 6) return [inputReason(), providerReason()];
      // v1-v5 had no reasons; the loader synthesizes the input pause reason.
      return [
        {
          id: deterministicId(`${EXECUTION_ID}:input:ask::question`),
          kind: 'input_required',
          code: 'input_requested',
          detected_at: STARTED_AT,
          source: {
            job_id: 'ask',
            step_id: 'question',
            attempt: 0,
            iteration: 1,
          },
        },
      ];
    }

    function expectedPauses(version: number): PipelinePauseCheckpoint[] {
      if (version >= 8) return [inputCheckpoint()];
      // v1-v7 checkpoints are rebuilt from paused jobs. The provider pause
      // becomes an action checkpoint, and the input checkpoint adopts its reason.
      const [askReason] = expectedReasons(version);
      return [
        {
          ...inputCheckpoint(),
          id: askReason.id,
          detected_at: askReason.detected_at,
        },
        {
          id: deterministicId(`${EXECUTION_ID}:pause:agent:prompt`),
          kind: 'action',
          job_id: 'agent',
          logical_job_id: 'agent',
          step_id: 'prompt',
          attempt: 0,
          iteration: 1,
          detected_at: STARTED_AT,
        },
      ];
    }

    it.each(versions)(
      'loads v%s with complete reason and checkpoint identity and round-trips it',
      async (version) => {
        const fixture = legacyFixture(pausedState(dir), version);
        const filePath = await writeRaw(fixture);
        const bytesBefore = await readFile(filePath, 'utf8');
        const mtimeBefore = (await stat(filePath)).mtimeMs;

        const loaded = await loadExecutionState(EXECUTION_ID, dir);
        const loadedAgain = await loadExecutionState(EXECUTION_ID, dir);
        if (!loaded) throw new Error('Expected a loaded execution');

        // Loading never rewrites the file, whatever its version.
        await expect(readFile(filePath, 'utf8')).resolves.toBe(bytesBefore);
        expect((await stat(filePath)).mtimeMs).toBe(mtimeBefore);
        expect(loadedAgain).toEqual(loaded);

        expect(loaded.version).toBe(10);
        expect(loaded.status_reasons).toEqual(expectedReasons(version));
        expect(loaded.pending_pauses).toEqual(expectedPauses(version));
        expect(loaded.pending_input).toEqual(
          version >= 8
            ? { job_id: 'ask', step_id: 'question', request: INPUT_REQUEST }
            : undefined,
        );
        expect(loaded.authentication_pause).toEqual({
          attempt_id: AUTHENTICATION_ATTEMPT_ID,
          reason_ids: [PROVIDER_REASON_ID],
        });
        expect(loaded.jobs.agent.steps.prompt.agent_recovery).toEqual(
          recoveryCheckpoint(dir),
        );
        expect(loaded.jobs.ask.steps.question).toMatchObject({
          pause_requested: true,
          input_request: INPUT_REQUEST,
        });
        expect(loaded.job_groups).toMatchObject({
          ask: { kind: 'single', variant_job_ids: ['ask'] },
          agent: { kind: 'single', variant_job_ids: ['agent'] },
        });
        expect(
          Object.values(loaded.job_definitions).map(
            (definition) => definition.logical_job_id,
          ),
        ).toEqual(['ask', 'agent']);

        await saveExecutionState(loaded, dir);
        await expect(loadExecutionState(EXECUTION_ID, dir)).resolves.toEqual(
          loaded,
        );
      },
    );
  });
});
