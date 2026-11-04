/**
 * Read admission goldens (CAN-5064), bound to today's read runner
 * (`code-graph/read-runner.ts`) with Electron's `utilityProcess` replaced by
 * the harness's scripted processes.
 *
 * The scenarios and the golden are host-neutral (see
 * `packages/code-graph/src/__tests__/golden/`). Each
 * scenario runs on a fresh runner module and a virtual clock. It records two
 * ordered streams: process forks, received requests, kills and exits; and how
 * each read settled. Entries carry the step that produced them and the time
 * since the scenario started; the two streams are not interleaved, so their
 * relative order within one step is not part of the contract.
 *
 * Re-record only for an intended behavior change:
 * `RECORD_CODE_GRAPH_GOLDEN=1 pnpm test code-graph-golden`.
 */
import { expectCodeGraphGolden } from '@canopy/code-graph/__tests__/golden/golden-file';
import {
  READ_ADMISSION_SCENARIOS,
  type GoldenReadTaskClass,
  type GoldenWorkerReply,
  type ReadAdmissionScenario,
} from '@canopy/code-graph/__tests__/golden/read-admission-scenarios';
import {
  ScriptedProcessPool,
  flushMicrotasks,
  type ScriptedProcess,
} from '@canopy/code-graph/__tests__/golden/scripted-process';
import type * as ReadRunnerModule from '../code-graph/read-runner';
import type {
  CodeGraphWorkerReadInput,
  CodeGraphWorkerReadTask,
} from '../code-graph/read-runner';

// Every scenario loads a fresh runner module graph.
jest.setTimeout(120_000);

let mockPool = new ScriptedProcessPool();

jest.mock('electron', () => ({
  utilityProcess: {
    fork: (): unknown => mockPool.fork(),
  },
}));

jest.mock('../lib/code-graph-telemetry', () => ({
  recordCodeGraphReadDiagnostic: (): void => undefined,
  flushCodeGraphReadDiagnostics: (): void => undefined,
  recordCodeGraphQueryTelemetry: (): void => undefined,
  flushCodeGraphQueryTelemetry: (): void => undefined,
}));

const BASE_IDENTITY = {
  repoId: 'golden',
  canonicalRepoRoot: '/golden/repo',
  customLanguagesFingerprint: 'none',
};

function readInput(
  key: string,
  taskClass: GoldenReadTaskClass,
): CodeGraphWorkerReadInput {
  const request = (
    task: CodeGraphWorkerReadTask,
  ): CodeGraphWorkerReadInput['request'] => ({
    dbPath: `/golden/${key}/graph.db`,
    task,
  });
  switch (taskClass) {
    case 'query':
      return {
        key,
        kind: 'query',
        request: request({
          kind: 'calls',
          calls: [{ method: 'callers', target: 'src/calc.ts::add' }],
        }),
      };
    case 'summary':
      return {
        key,
        kind: 'ui-summary',
        request: request({ kind: 'readonly-summary' }),
      };
    case 'base-summary':
      return {
        key,
        kind: 'base-validation',
        request: request({ kind: 'readonly-summary' }),
      };
    case 'detect-changed':
      return {
        key,
        kind: 'detect-changed',
        request: request({
          kind: 'detect-changed',
          repoId: 'golden',
          rootPath: '/golden/repo',
          baseRef: 'golden-base',
        }),
      };
    case 'change-impact':
      return {
        key,
        kind: 'compare-impact',
        request: request({
          kind: 'change-impact',
          repoId: 'golden',
          rootPath: '/golden/repo',
          baseRef: 'golden-base',
          resourcesDir: '/golden/resources',
        }),
      };
    case 'fingerprint-metadata':
      return {
        key,
        kind: 'fingerprint-metadata',
        request: request({ kind: 'fingerprint-metadata' }),
      };
    // The read lane no longer writes the end-of-build fingerprint: the build
    // host stores it (CAN-5084). The case's other maintenance-class read keeps
    // the recorded admission behavior.
    case 'persist-fingerprint':
      return {
        key,
        kind: 'fingerprint-metadata',
        request: request({ kind: 'fingerprint-metadata' }),
      };
    case 'validate-base':
      return {
        key,
        kind: 'base-validation',
        request: request({
          kind: 'validate-base',
          identity: BASE_IDENTITY,
          gitHead: null,
        }),
      };
    case 'base-identity':
      return {
        key,
        kind: 'base-validation',
        request: request({
          kind: 'base-identity',
          identity: BASE_IDENTITY,
          gitHead: null,
        }),
      };
  }
}

function okResult(task: CodeGraphWorkerReadTask): unknown {
  switch (task.kind) {
    case 'calls':
      return { kind: 'calls', value: task.calls.map(() => []) };
    case 'readonly-summary':
      return { kind: 'readonly-summary', value: { state: 'missing' } };
    case 'base-identity':
      return { kind: 'base-identity', value: { state: 'missing' } };
    case 'fingerprint-metadata':
      return {
        kind: 'fingerprint-metadata',
        value: {
          fingerprint: null,
          schemaVersion: null,
          extractorVersion: null,
          completed: false,
          derivedPending: false,
          lastBuildAt: null,
        },
      };
    case 'validate-base':
      return { kind: 'validate-base', value: true };
    case 'detect-changed':
      return {
        kind: 'detect-changed',
        value: { changed: [], unmatchedFiles: [], lastBuildAt: null },
      };
    case 'change-impact':
      return {
        kind: 'change-impact',
        value: { report: {}, lastBuildAt: null },
      };
  }
}

function replyFor(
  task: CodeGraphWorkerReadTask,
  reply: GoldenWorkerReply,
): unknown {
  switch (reply) {
    case 'ok':
      return { ok: true, result: okResult(task) };
    case 'failure-busy':
      return { ok: false, code: 'busy', message: 'worker detail' };
    case 'summary-busy':
      return {
        ok: true,
        result: {
          kind: 'readonly-summary',
          value: { state: 'error', classification: 'busy' },
        },
      };
    case 'malformed':
      return { ok: true, result: { kind: 'not-a-read' } };
  }
}

interface AdmissionTrace {
  processes: unknown[];
  reads: unknown[];
}

async function runScenario(
  scenario: ReadAdmissionScenario,
): Promise<AdmissionTrace> {
  jest.resetModules();
  mockPool = new ScriptedProcessPool();
  const pool = mockPool;
  const runner: typeof ReadRunnerModule =
    await import('../code-graph/read-runner');
  const startedAt = Date.now();
  const elapsed = (): number => Date.now() - startedAt;
  const trace: AdmissionTrace = { processes: [], reads: [] };
  let step = 0;
  const reads = new Map<string, CodeGraphWorkerReadInput>();
  const readIds = new Map<unknown, string>();
  const fences = new Map<string, () => void>();
  let recorded = 0;

  const recordProcessEvents = (): void => {
    for (const event of pool.events.slice(recorded)) {
      const at = { step, t: elapsed(), process: event.process };
      if (event.event === 'request') {
        trace.processes.push({
          ...at,
          received: readIds.get(event.request) ?? 'unknown',
        });
      } else if (event.event === 'exit') {
        trace.processes.push({ ...at, exited: event.code });
      } else {
        trace.processes.push({ ...at, [event.event]: true });
      }
    }
    recorded = pool.events.length;
  };

  const settle = async (): Promise<void> => {
    await flushMicrotasks();
    recordProcessEvents();
  };

  const issue = (id: string, input: CodeGraphWorkerReadInput): void => {
    reads.set(id, input);
    readIds.set(input.request, id);
    runner.runCodeGraphWorkerRead(input).then(
      (response) => {
        trace.reads.push({
          step,
          t: elapsed(),
          read: id,
          resolved: response.ok ? 'ok' : response.code,
          ...(response.ok ? {} : { message: response.message }),
        });
      },
      (error: unknown) => {
        trace.reads.push({
          step,
          t: elapsed(),
          read: id,
          rejected: runner.codeGraphReadFailure(error),
        });
      },
    );
  };

  const servingProcess = (
    id: string,
  ): { input: CodeGraphWorkerReadInput; process: ScriptedProcess } => {
    const input = reads.get(id);
    if (input === undefined) throw new Error(`Unknown read ${id}`);
    return {
      input,
      process: pool.serving((request) => request === input.request),
    };
  };

  for (const action of scenario.steps) {
    step += 1;
    if ('read' in action) {
      if (action.count === undefined) {
        issue(action.read, readInput(action.key, action.task));
      } else {
        for (let ordinal = 1; ordinal <= action.count; ordinal += 1) {
          issue(`${action.read}${ordinal}`, readInput(action.key, action.task));
        }
      }
    } else if ('advance' in action) {
      jest.advanceTimersByTime(action.advance);
    } else if ('reply' in action) {
      const { input, process } = servingProcess(action.reply);
      process.reply(replyFor(input.request.task, action.with));
    } else if ('crash' in action) {
      servingProcess(action.crash).process.exit(1);
    } else if ('cancelKey' in action) {
      void runner.cancelCodeGraphReads(action.cancelKey);
    } else if ('cancelProject' in action) {
      void runner.cancelCodeGraphReadsForWorkspace(action.cancelProject);
    } else if ('fenceKey' in action) {
      fences.set(action.fenceKey, runner.fenceCodeGraphReads(action.fenceKey));
    } else if ('releaseFence' in action) {
      fences.get(action.releaseFence)?.();
    } else {
      void runner.shutdownCodeGraphReadWorkers();
    }
    await settle();
  }
  step = scenario.steps.length + 1;
  pool.exitAll();
  await settle();
  return trace;
}

describe('code-graph read admission goldens', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('admits, orders and refuses reads exactly as recorded', async () => {
    const results: Record<string, AdmissionTrace> = {};
    for (const scenario of READ_ADMISSION_SCENARIOS) {
      results[scenario.name] = await runScenario(scenario);
    }
    expectCodeGraphGolden('read-admission', results);
  });
});
