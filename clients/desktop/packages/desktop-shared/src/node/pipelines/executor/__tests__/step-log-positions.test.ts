import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  initCodexModels,
  initCursorModels,
  initModelHarnessAssignments,
  initOllamaModels,
} from '@canopy/desktop-shared/types';
import { runStep } from '../step-runner';
import { runSpawnedProcessLocally } from '../spawned-process';
import { getStepLogGeneration, readStepLogFile } from '../step-log-positions';
import type {
  AgentPromptWorkerResult,
  CodexPromptRunnerRequest,
  CodexPromptRunnerResult,
  ExecutionRuntime,
  NormalizedStep,
  SpawnedProcessResult,
  StepOutputEvent,
} from '../types';

/**
 * Writer position equivalence for the phase 02 log catch-up seam: every
 * positioned step output event names exactly the bytes its writer persisted,
 * at the offset they occupy, in the log file of the event's identity.
 */

function createRuntime(rootDir: string): ExecutionRuntime {
  return {
    // Pipeline fixtures do not enforce an org model policy.
    isModelBlockedByOrgPolicy: (): Promise<boolean> => Promise.resolve(false),
    isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
    executionsDir: path.join(rootDir, 'executions'),
    tempRootDir: path.join(rootDir, 'tmp'),
    bundledActionsDir: path.join(rootDir, 'actions'),
    getProjectActionsDir: (repoPath: string): string =>
      path.join(repoPath, '.canopy', 'actions'),
    getProjectPipelinesDir: (repoPath: string): string =>
      path.join(repoPath, '.canopy', 'pipelines'),
  };
}

function createStep(partial: Partial<NormalizedStep>): NormalizedStep {
  return {
    id: partial.id ?? 'step',
    shell: partial.shell ?? 'bash',
    continue_on_error: partial.continue_on_error ?? false,
    timeout_minutes: partial.timeout_minutes ?? 1,
    skip_on_missing_action: partial.skip_on_missing_action ?? false,
    ...partial,
  };
}

function writeAction(
  runtime: ExecutionRuntime,
  name: string,
  script: string,
  logFormatHint?: 'agent',
): void {
  const actionDir = path.join(runtime.bundledActionsDir, name);
  fs.mkdirSync(actionDir, { recursive: true });
  fs.writeFileSync(
    path.join(actionDir, 'action.yml'),
    [
      `name: ${name}`,
      ...(logFormatHint ? [`log_format_hint: ${logFormatHint}`] : []),
      'inputs:',
      '  model: {}',
      '  prompt: {}',
      '  permission_preset: { default: read_only }',
      'outputs: {}',
      'runs:',
      '  using: node',
      '  main: index.js',
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(path.join(actionDir, 'index.js'), script, 'utf8');
}

function writeAgentPromptAction(runtime: ExecutionRuntime): void {
  writeAction(
    runtime,
    'agent-prompt',
    "throw new Error('a host runner should intercept this step');",
    'agent',
  );
}

/**
 * The equivalence oracle: positions are contiguous in emission order, one
 * generation, each naming exactly its chunk's bytes in the persisted file,
 * and together covering the file from `base` to its end.
 */
function expectPositionsMatchFile(
  events: readonly StepOutputEvent[],
  logFile: string,
  base = 0,
): number {
  const file = fs.readFileSync(logFile);
  const generation = events[0]?.logPosition?.generation;
  expect(generation).toEqual(expect.any(Number));
  let offset = base;
  for (const event of events) {
    const position = event.logPosition;
    expect(position).toEqual({
      generation,
      offset,
      byteLength: Buffer.byteLength(event.data, 'utf8'),
    });
    if (!position) continue;
    expect(
      file.subarray(position.offset, position.offset + position.byteLength),
    ).toEqual(Buffer.from(event.data, 'utf8'));
    offset += position.byteLength;
  }
  expect(offset).toBe(file.length);
  return generation ?? -1;
}

const TRANSCRIPT_LINES = [
  JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
  JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: 'café 🙂 done' },
  }),
];
const UNSTREAMED_LINE = JSON.stringify({ type: 'turn.completed' });

function streamingResult(
  request: CodexPromptRunnerRequest,
): Promise<CodexPromptRunnerResult> {
  for (const line of TRANSCRIPT_LINES) request.onTranscriptLine?.(line);
  return Promise.resolve({
    status: 'success',
    sessionId: 'thread-1',
    rawText: 'done',
    // One line the runner never streamed: persisted and emitted as the
    // remainder after the streamed lines.
    transcript: `${[...TRANSCRIPT_LINES, UNSTREAMED_LINE].join('\n')}\n`,
    usage: {},
  });
}

describe('step log positions', () => {
  let tempDir: string;
  let runtime: ExecutionRuntime;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-step-log-pos-'));
    runtime = createRuntime(tempDir);
    writeAgentPromptAction(runtime);
    initCodexModels([{ id: 'gpt-5.5', label: 'GPT 5.5' }]);
    initCursorModels([
      {
        id: 'cursor-default',
        rawModelId: 'default[]',
        label: 'Cursor default',
      },
    ]);
    initModelHarnessAssignments({ revision: 0, assignments: [] });
    initOllamaModels([]);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function configureHostRunners(model: string): void {
    runtime.codexPromptRunner = { runCodexPrompt: streamingResult };
    runtime.cursorPromptRunner = { runCursorPrompt: streamingResult };
    runtime.resolveModelHarnessInvocation = (
      resolved,
    ): ReturnType<
      NonNullable<ExecutionRuntime['resolveModelHarnessInvocation']>
    > =>
      Promise.resolve(
        model === 'cursor-default'
          ? {
              source: 'cursor-managed',
              harness: 'cursor',
              runtimeModel: resolved ?? '',
              aiCreditsRouted: false,
            }
          : {
              source: 'native',
              harness: 'codex',
              runtimeModel: resolved ?? '',
              aiCreditsRouted: false,
            },
      );
  }

  describe('spawned-process writers', () => {
    it('positions interleaved stdout/stderr, partial lines, and multibyte output of a run step', async () => {
      const events: StepOutputEvent[] = [];
      const result = await runStep({
        executionId: 'exec-run',
        jobId: 'job-1',
        step: createStep({
          id: 'mixed',
          run: [
            "printf 'caf\\303\\251 '",
            "printf 'warn \\360\\237\\231\\202\\n' >&2",
            "printf 'done\\n'",
            "printf 'no newline'",
          ].join('\n'),
        }),
        cwd: tempDir,
        env: {},
        runtime,
        signal: new AbortController().signal,
        onStepOutput: (event) => events.push(event),
      });

      expect(result.status).toBe('success');
      const logFile = result.log_file ?? '';
      expect(new Set(events.map((event) => event.stream))).toEqual(
        new Set(['stdout', 'stderr']),
      );
      const generation = expectPositionsMatchFile(events, logFile);
      expect(fs.readFileSync(logFile, 'utf8')).toContain('café');
      expect(fs.readFileSync(logFile, 'utf8')).toContain('warn 🙂');
      expect(getStepLogGeneration(logFile)).toBe(generation);
      await expect(
        readStepLogFile(logFile, { format: 'text' }),
      ).resolves.toEqual({
        lines: [],
        text: fs.readFileSync(logFile, 'utf8'),
        byteLength: fs.statSync(logFile).size,
        generation,
      });
    });

    it('starts after setup lines appended before the process, which are persisted but not emitted', async () => {
      // `agent` makes the step resolve log metadata, which runs the
      // `onLogMetadataResolved` hook used below to append a setup line.
      writeAction(
        runtime,
        'printer',
        "process.stdout.write('from action\\n');",
        'agent',
      );
      const events: StepOutputEvent[] = [];
      const setupLine = '[plugin-collection] optional default missing\n';
      const result = await runStep({
        executionId: 'exec-action',
        jobId: 'job-1',
        step: createStep({ id: 'printer', uses: 'builtin/printer' }),
        cwd: tempDir,
        env: {},
        runtime,
        signal: new AbortController().signal,
        onStepOutput: (event) => events.push(event),
        // Runs after the log was created and before the process starts, like
        // the plugin-collection warnings the action path appends.
        onLogMetadataResolved: async () => {
          const logFile = path.join(
            runtime.executionsDir,
            'exec-action',
            'logs',
            'job-1--printer.log',
          );
          await fsp.appendFile(logFile, setupLine, 'utf8');
        },
      });

      expect(result.status).toBe('success');
      const logFile = result.log_file ?? '';
      expect(fs.readFileSync(logFile, 'utf8')).toBe(
        `${setupLine}from action\n`,
      );
      expectPositionsMatchFile(
        events,
        logFile,
        Buffer.byteLength(setupLine, 'utf8'),
      );
    });

    it('positions chunks from arrival order when an injected host writes and batches them', async () => {
      // The desktop utility host writes each chunk in its own process and
      // emits contiguous same-stream runs as one batch; main only sees the
      // batches, in order.
      runtime.spawnedProcessRunner = async (
        _spec,
        options,
      ): Promise<SpawnedProcessResult> => {
        const written: Array<['stdout' | 'stderr', string]> = [
          ['stdout', 'a'],
          ['stdout', 'é'],
          ['stderr', 'E\n'],
          ['stdout', '🙂\n'],
        ];
        for (const [, data] of written) {
          await fsp.appendFile(options.logFile, data, 'utf8');
        }
        options.onOutput?.('stdout', 'aé');
        options.onOutput?.('stderr', 'E\n');
        options.onOutput?.('stdout', '🙂\n');
        return {
          status: 'success',
          conclusion: 'success',
          outcome: 'success',
          exit_code: 0,
          outputs: {},
          dynamic_env: {},
          log_file: options.logFile,
        };
      };
      const events: StepOutputEvent[] = [];
      const result = await runStep({
        executionId: 'exec-hosted',
        jobId: 'job-1',
        step: createStep({ id: 'hosted', run: 'true' }),
        cwd: tempDir,
        env: {},
        runtime,
        signal: new AbortController().signal,
        onStepOutput: (event) => events.push(event),
      });

      expect(events.map((event) => event.data)).toEqual(['aé', 'E\n', '🙂\n']);
      expectPositionsMatchFile(events, result.log_file ?? '');
    });

    it('emits exactly the bytes the utility host process writes, in order', async () => {
      // `runSpawnedProcessLocally` is the writer inside the desktop utility
      // host: its emitted chunks, concatenated in order, must be the file.
      const logFile = path.join(tempDir, 'hosted.log');
      const outputFile = path.join(tempDir, 'output.txt');
      const envFile = path.join(tempDir, 'env.txt');
      const secret = 'pipeline-secret-value';
      const chunks: Array<['stdout' | 'stderr', string]> = [];

      const result = await runSpawnedProcessLocally(
        {
          command: process.execPath,
          args: [
            '-e',
            [
              "process.stdout.write('caf');",
              'process.stdout.write(Buffer.from([0xc3]));',
              'setTimeout(() => {process.stdout.write(Buffer.from([0xa9]));',
              "process.stderr.write('err 🙂 ' + process.env.TEST_SECRET + '\\n');",
              "process.stdout.write(' tail\\n');}, 20);",
            ].join(''),
          ],
        },
        {
          cwd: tempDir,
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(
                (entry): entry is [string, string] => entry[1] !== undefined,
              ),
            ),
            TEST_SECRET: secret,
          },
          signal: new AbortController().signal,
          timeout_minutes: 1,
          logFile,
          outputFile,
          envFile,
          secretValues: [secret],
          onOutput: (stream, data) => chunks.push([stream, data]),
        },
      );

      expect(result.status).toBe('success');
      const file = fs.readFileSync(logFile);
      expect(
        Buffer.concat(chunks.map(([, data]) => Buffer.from(data, 'utf8'))),
      ).toEqual(file);
      expect(file.toString('utf8')).not.toContain(secret);
      expect(file.toString('utf8')).toContain('café');
    });
  });

  describe('host-runner transcript writers', () => {
    it.each([
      ['Codex', 'gpt-5.5'],
      ['Cursor', 'cursor-default'],
    ])(
      'positions %s streamed lines and the unstreamed remainder from offset zero',
      async (_label, model) => {
        configureHostRunners(model);
        const events: StepOutputEvent[] = [];
        const result = await runStep({
          executionId: 'exec-agent',
          jobId: 'job-1',
          step: createStep({
            id: 'agent',
            uses: 'builtin/agent-prompt',
            with: { model, prompt: 'go' },
          }),
          cwd: tempDir,
          env: {},
          runtime,
          signal: new AbortController().signal,
          onStepOutput: (event) => events.push(event),
          // Setup lines appended before the runner starts are dropped by the
          // transcript's truncation, as the first transcript write always did.
          onLogMetadataResolved: async () => {
            await fsp.appendFile(
              path.join(
                runtime.executionsDir,
                'exec-agent',
                'logs',
                'job-1--agent.log',
              ),
              '[plugin-collection] warning\n',
              'utf8',
            );
          },
        });

        expect(result.status).toBe('success');
        const logFile = result.log_file ?? '';
        expect(events.map((event) => event.data)).toEqual([
          `${TRANSCRIPT_LINES[0]}\n`,
          `${TRANSCRIPT_LINES[1]}\n`,
          `${UNSTREAMED_LINE}\n`,
        ]);
        const generation = expectPositionsMatchFile(events, logFile);
        // The identical-content rewrite of the transcript at success keeps
        // the generation: readers only ever observed a prefix of it.
        expect(getStepLogGeneration(logFile)).toBe(generation);
      },
    );

    it.each([
      ['Codex', 'gpt-5.5'],
      ['Cursor', 'cursor-default'],
    ])(
      'stamps %s transcript events with the recovery number of their log file',
      async (_label, model) => {
        configureHostRunners(model);
        const events: StepOutputEvent[] = [];

        const result = await runStep({
          executionId: 'exec-recovery',
          jobId: 'job-1',
          step: createStep({
            id: 'agent',
            uses: 'builtin/agent-prompt',
            with: { model, prompt: 'go' },
          }),
          cwd: tempDir,
          env: {},
          runtime,
          signal: new AbortController().signal,
          recovery: 2,
          onStepOutput: (event) => events.push(event),
        });

        expect(result.status).toBe('success');
        expect(result.log_file).toMatch(/--recovery2\.log$/);
        expect(events.length).toBeGreaterThan(0);
        for (const event of events) expect(event.recovery).toBe(2);
        expectPositionsMatchFile(events, result.log_file ?? '');
      },
    );

    it('starts a newer generation, from offset zero, when the same identity reruns', async () => {
      configureHostRunners('gpt-5.5');
      const run = async (): Promise<StepOutputEvent[]> => {
        const events: StepOutputEvent[] = [];
        await runStep({
          executionId: 'exec-rerun',
          jobId: 'job-1',
          step: createStep({
            id: 'agent',
            uses: 'builtin/agent-prompt',
            with: { model: 'gpt-5.5', prompt: 'go' },
          }),
          cwd: tempDir,
          env: {},
          runtime,
          signal: new AbortController().signal,
          onStepOutput: (event) => events.push(event),
        });
        return events;
      };

      const first = await run();
      const second = await run();
      const firstGeneration = first[0]?.logPosition?.generation ?? 0;
      const secondGeneration = second[0]?.logPosition?.generation ?? 0;
      expect(secondGeneration).toBeGreaterThan(firstGeneration);
      expect(second[0]?.logPosition?.offset).toBe(0);
    });
  });

  describe('Claude terminal worker', () => {
    const transcript = `${JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'worker café' }],
      },
    })}\n`;

    async function runWorker(
      result: AgentPromptWorkerResult,
    ): Promise<{ events: StepOutputEvent[]; logFile: string }> {
      const events: StepOutputEvent[] = [];
      const stepResult = await runStep({
        executionId: 'exec-worker',
        jobId: 'job-1',
        step: createStep({
          id: 'agent',
          uses: 'builtin/agent-prompt',
          with: { prompt: 'hello' },
        }),
        cwd: tempDir,
        env: {},
        runtime: {
          ...runtime,
          agentPromptWorker: {
            runAgentPrompt: (): Promise<AgentPromptWorkerResult> =>
              Promise.resolve(result),
          },
        },
        signal: new AbortController().signal,
        agentTerminalMode: true,
        recovery: 1,
        onStepOutput: (event) => events.push(event),
      });
      return { events, logFile: stepResult.log_file ?? '' };
    }

    it('positions the whole transcript and leaves the unpersisted projection unpositioned', async () => {
      const { events, logFile } = await runWorker({
        status: 'success',
        workerId: 'worker-1',
        sessionId: 'session-1',
        rawText: 'worker café',
        transcript,
        projectedMessages: [
          {
            id: 'msg-1',
            role: 'assistant',
            timestamp: 1,
            blocks: [{ type: 'text', text: 'worker café' }],
          },
        ],
      });

      const [transcriptEvent, projectionEvent] = events;
      expect(transcriptEvent?.data).toBe(transcript);
      expect(transcriptEvent?.recovery).toBe(1);
      const generation = expectPositionsMatchFile(
        transcriptEvent ? [transcriptEvent] : [],
        logFile,
      );
      expect(getStepLogGeneration(logFile)).toBe(generation);
      expect(projectionEvent?.data).toContain(
        'claude_terminal_projected_messages',
      );
      expect(projectionEvent?.recovery).toBe(1);
      expect(projectionEvent?.logPosition).toBeUndefined();
    });

    it('positions a failed worker transcript', async () => {
      const { events, logFile } = await runWorker({
        status: 'failure',
        workerId: 'worker-1',
        transcript,
        failure: {
          version: 1,
          provider: 'claude',
          agent_harness: 'claude',
          had_agent_activity: false,
          message: 'boom',
        },
      });

      expect(events).toHaveLength(1);
      expectPositionsMatchFile(events, logFile);
    });
  });
});
