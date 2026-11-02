/**
 * Build queue goldens (CAN-5064), bound to today's build runner
 * (`code-graph/build-runner.ts`) with Electron's `utilityProcess` replaced by
 * the harness's scripted processes, plus the build service's queue-class
 * decision for automatic worktree builds.
 *
 * The scenarios and the golden are host-neutral (see
 * `packages/code-graph/src/__tests__/golden/`). Each
 * scenario runs on a fresh runner module and a virtual clock. It records the
 * process stream (forks, received requests, process priority, kills, exits),
 * how each build settled, and the generation queue snapshots it asked for.
 * Entries carry the step that produced them and the time since the scenario
 * started; the streams are not interleaved. Build ids are sequential rather
 * than random, so running entries that start in the same millisecond keep a
 * stable order (the queue breaks that tie by id).
 *
 * Re-record only for an intended behavior change:
 * `RECORD_CODE_GRAPH_GOLDEN=1 pnpm test code-graph-golden`.
 */
import { expectCodeGraphGolden } from '@canopy/code-graph/__tests__/golden/golden-file';
import {
  BUILD_QUEUE_SCENARIOS,
  type BuildQueueScenario,
  type BuildQueueStep,
} from '@canopy/code-graph/__tests__/golden/build-queue-scenarios';
import {
  ScriptedProcessPool,
  flushMicrotasks,
  type ScriptedProcess,
} from '@canopy/code-graph/__tests__/golden/scripted-process';
import type { CodeGraphGenerationQueueSnapshot } from '@canopy/desktop-shared/types';
import type * as NodeCryptoModule from 'node:crypto';
import type * as BuildRunnerModule from '../code-graph/build-runner';
import type * as AvailabilityModule from '../lib/code-graph-availability';
import type { CodeGraphWorkerBuildRequest } from '../code-graph/build-runner';
import { worktreeQueuePriority } from '../lib/code-graph-build-service';

// Every scenario loads a fresh runner module graph.
jest.setTimeout(120_000);

let mockPool = new ScriptedProcessPool();
let mockUuidCount = 0;
const mockPriorityCalls: Array<{ pid: number; background: boolean }> = [];
const mockLeaveBackground: number[] = [];

jest.mock('electron', () => ({
  utilityProcess: {
    fork: (): unknown => mockPool.fork(),
  },
}));

jest.mock('node:crypto', () => ({
  ...jest.requireActual<typeof NodeCryptoModule>('node:crypto'),
  randomUUID: (): string => {
    mockUuidCount += 1;
    return `00000000-0000-4000-8000-${String(mockUuidCount).padStart(12, '0')}`;
  },
}));

jest.mock('../lib/background-process', () => ({
  lowerSpawnedProcessPriority: (
    pid: number,
    options: { background: boolean },
  ): void => {
    mockPriorityCalls.push({ pid, background: options.background });
  },
  leaveBackgroundProcessPolicy: (pid: number): void => {
    mockLeaveBackground.push(pid);
  },
}));

interface BuildQueueTrace {
  processes: unknown[];
  builds: unknown[];
  queue: unknown[];
}

function buildRequest(
  step: Extract<BuildQueueStep, { build: string }>,
): CodeGraphWorkerBuildRequest {
  const key = step.key ?? step.build;
  return {
    dbPath: `/golden/${key}/graph.db`,
    worktreeRootPath: `/golden/${key}`,
    resourcesDir: '/golden/resources',
    repositories: [{ repoId: 'golden', rootPath: `/golden/${key}` }],
    options: {
      ...(step.verify === true ? { verifyContent: true } : {}),
      ...(step.forceReparse === true ? { forceReparse: true } : {}),
    },
  };
}

function keyOfRequest(request: unknown): string {
  if (
    typeof request === 'object' &&
    request !== null &&
    'dbPath' in request &&
    typeof request.dbPath === 'string'
  ) {
    return request.dbPath
      .replace(/^\/golden\//, '')
      .replace(/\/graph\.db$/, '');
  }
  return 'unknown';
}

function optionsOfRequest(request: unknown): unknown {
  return typeof request === 'object' && request !== null && 'options' in request
    ? request.options
    : undefined;
}

async function runScenario(
  scenario: BuildQueueScenario,
): Promise<BuildQueueTrace> {
  jest.resetModules();
  mockPool = new ScriptedProcessPool();
  mockUuidCount = 0;
  mockPriorityCalls.length = 0;
  mockLeaveBackground.length = 0;
  const pool = mockPool;
  const runner: typeof BuildRunnerModule =
    await import('../code-graph/build-runner');
  const availability: typeof AvailabilityModule =
    await import('../lib/code-graph-availability');
  const startedAt = Date.now();
  const elapsed = (): number => Date.now() - startedAt;
  const trace: BuildQueueTrace = { processes: [], builds: [], queue: [] };
  let step = 0;
  let recordedEvents = 0;
  let recordedPriority = 0;
  let recordedLeave = 0;
  const processPids = new Map<number, number>();

  const describeSnapshot = (
    snapshot: CodeGraphGenerationQueueSnapshot,
  ): unknown =>
    snapshot.entries.map((entry) => ({
      label: entry.label ?? null,
      status: entry.status,
      scope: entry.scope,
      reorderable: entry.reorderable,
      workspaceIds: entry.workspaceIds,
      trigger: entry.trigger,
    }));

  const recordProcessEvents = (): void => {
    for (const event of pool.events.slice(recordedEvents)) {
      const at = { step, t: elapsed(), process: event.process };
      if (event.event === 'request') {
        trace.processes.push({
          ...at,
          received: keyOfRequest(event.request),
          options: optionsOfRequest(event.request),
        });
      } else if (event.event === 'exit') {
        trace.processes.push({ ...at, exited: event.code });
      } else {
        if (event.event === 'fork') {
          processPids.set(pool.process(event.process).pid ?? 0, event.process);
        }
        trace.processes.push({ ...at, [event.event]: true });
      }
    }
    recordedEvents = pool.events.length;
    for (const call of mockPriorityCalls.slice(recordedPriority)) {
      trace.processes.push({
        step,
        t: elapsed(),
        process: processPids.get(call.pid) ?? 'unknown',
        priority: call.background ? 'background' : 'lowered',
      });
    }
    recordedPriority = mockPriorityCalls.length;
    for (const pid of mockLeaveBackground.slice(recordedLeave)) {
      trace.processes.push({
        step,
        t: elapsed(),
        process: processPids.get(pid) ?? 'unknown',
        priority: 'left-background',
      });
    }
    recordedLeave = mockLeaveBackground.length;
  };

  const servingProcess = (key: string): ScriptedProcess =>
    pool.serving((request) => keyOfRequest(request) === key);

  for (const action of scenario.steps) {
    step += 1;
    if ('build' in action) {
      const id = action.build;
      const project = action.project;
      runner
        .runCodeGraphWorkerBuild(action.key ?? id, buildRequest(action), {
          priority: action.class,
          metadata: {
            scope:
              action.class === 'maintenance' ? 'workspace-shadow' : 'worktree',
            workspaceIds: project === undefined ? [] : [project],
            label: id,
            trigger: 'golden',
          },
        })
        .then(
          (response) => {
            trace.builds.push({
              step,
              t: elapsed(),
              build: id,
              resolved: response.ok ? 'ok' : 'failed',
              ...(response.ok ? {} : { message: response.message }),
            });
          },
          (error: unknown) => {
            trace.builds.push({
              step,
              t: elapsed(),
              build: id,
              rejected:
                error instanceof runner.CodeGraphWorkerBuildError
                  ? error.reason
                  : 'unknown',
            });
          },
        );
    } else if ('advance' in action) {
      jest.advanceTimersByTime(action.advance);
    } else if ('complete' in action) {
      servingProcess(action.complete).reply(
        action.outcome === 'ok'
          ? {
              ok: true,
              result: {
                filesScanned: 1,
                filesParsed: 1,
                filesUnchanged: 0,
                filesSkipped: 0,
                filesRemoved: 0,
                parseFailures: 0,
                symbolCount: 1,
                edgeCount: 0,
                durationMs: 1,
                derived: [],
                customLanguages: null,
              },
            }
          : { ok: false, message: 'The fixture build failed.' },
      );
    } else if ('crash' in action) {
      servingProcess(action.crash).exit(1);
    } else if ('cancel' in action) {
      void runner.cancelBuild(action.cancel);
    } else if ('reorder' in action) {
      const snapshot = runner.getCodeGraphGenerationQueueSnapshot();
      const ids = action.reorder.map(
        (label) =>
          snapshot.entries.find((entry) => entry.label === label)?.id ??
          `missing-${label}`,
      );
      const result = runner.reorderCodeGraphGenerationQueue({
        revision:
          action.stale === true ? snapshot.revision - 1 : snapshot.revision,
        orderedQueuedEntryIds: ids,
      });
      trace.queue.push({
        step,
        reorder: action.reorder,
        result:
          'ok' in result
            ? {
                ok: result.ok,
                code: result.code,
                message: result.message,
                ...('snapshot' in result && result.snapshot !== undefined
                  ? { snapshot: describeSnapshot(result.snapshot) }
                  : {}),
              }
            : describeSnapshot(result),
      });
    } else if ('snapshot' in action) {
      trace.queue.push({
        step,
        t: elapsed(),
        snapshot: describeSnapshot(
          runner.getCodeGraphGenerationQueueSnapshot(),
        ),
      });
    } else if ('disableProject' in action) {
      availability.setCodeGraphPreferences({
        mode: 'selected-workspaces',
        selectedWorkspaceIds: ['some-other-project'],
        generationTimeoutMinutes: 30,
      });
    } else {
      void runner.killAllBuilds();
    }
    await flushMicrotasks();
    recordProcessEvents();
  }
  step = scenario.steps.length + 1;
  void runner.killAllBuilds();
  pool.exitAll();
  await flushMicrotasks();
  recordProcessEvents();
  return trace;
}

describe('code-graph build queue goldens', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('queues, orders, coalesces and settles builds exactly as recorded', async () => {
    const results: Record<string, unknown> = {
      'automatic-worktree-build-class': {
        'agent, graph completed': worktreeQueuePriority('agent', true),
        'agent, no completed graph': worktreeQueuePriority('agent', false),
        'automatic, graph completed': worktreeQueuePriority('worktree', true),
        'automatic, no completed graph': worktreeQueuePriority(
          'worktree',
          false,
        ),
      },
    };
    for (const scenario of BUILD_QUEUE_SCENARIOS) {
      results[scenario.name] = await runScenario(scenario);
    }
    expectCodeGraphGolden('build-queue', results);
  });
});
