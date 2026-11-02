/** Real-host scenario fixtures shared by the lifecycle and latency suites. */
import type { query as ClaudeQuery } from '@anthropic-ai/claude-agent-sdk';
import type * as ChildProcess from 'node:child_process';
import type {
  InvariantContext,
  InvariantId,
  PipelineChatTarget,
  PipelineHarness,
  PipelineHost,
  PipelineHostAdapter,
  PipelineHostOptions,
  PipelineProvider,
  ScriptedProviderDriver,
  ScriptedProviderTurn,
} from './contracts';
import { createPipelineHarness } from './harness';
import type { PipelineStorage } from './storage';
import { claudeSdkModuleMock, createScriptedClaude } from './scripted-claude';
import { codexSpawnModuleMock, createScriptedCodex } from './scripted-codex';
import {
  checkDormantInvariants,
  checkInvariants,
  formatViolations,
  invariantActivation,
} from './invariants';

export interface ScenarioEnvironment {
  harness: PipelineHarness;
  host: PipelineHostAdapter;
  driver: ScriptedProviderDriver;
  target: PipelineChatTarget;
  hostVariant: ScenarioHostVariant;
  secrets: string[];
}

// Node built-in consumers may retain their first spawn binding across Jest's
// module reset. Keep that binding pointed at the current scenario's driver.
const activeDrivers: {
  claude?: ScriptedProviderDriver;
  codex?: ReturnType<typeof createScriptedCodex>;
} = {};
let scenarioModulesInitialized = false;

// Async-hooks instrumentation makes the first cold production-module load slow.
export const SCENARIO_TEST_TIMEOUT_MS = process.argv.includes(
  '--detectOpenHandles',
)
  ? 180_000
  : 60_000;

export function scenarioContext(secrets: readonly string[]): InvariantContext {
  return {
    secrets,
    deliveryBoundMs: 2000,
    gateBoundMs: 6000,
    absoluteTiming: process.env.CANOPY_PIPELINE_ABSOLUTE === '1',
  };
}

export async function createScenarioEnvironment(
  kind: PipelineHost,
  provider: PipelineProvider,
  options: {
    captureRows?: boolean;
    captureTranscript?: 'revision' | 'checkpoint' | 'off';
    emulateClaudeRootReceipt?: boolean;
    hostOptions?: PipelineHostOptions;
    prepareStorage?: (
      storage: PipelineStorage,
      target: PipelineChatTarget,
    ) => Promise<void>;
  } = {},
): Promise<ScenarioEnvironment> {
  // Each fixture disposes sessions, subscriptions, storage and service state.
  // Reloading the entire main-process module graph per row retains many copies
  // in Jest and exhausts the heap before a complete host matrix can finish.
  if (!scenarioModulesInitialized) {
    jest.resetModules();
    await import('../../../__tests__/jestElectronLogSetup');
    scenarioModulesInitialized = true;
  }
  // This harness intentionally has no renderer window. Avoid Jest constructing
  // a source-mapped warning stack for every provider frame; preserve all other
  // warnings and the ordered trace used for failures.
  // eslint-disable-next-line no-console -- Preserve unexpected warnings from real pipeline code.
  const warn = console.warn.bind(console);
  jest
    .spyOn(console, 'warn')
    .mockImplementation((...args: Parameters<typeof console.warn>) => {
      if (
        args[0] === '[chat-ipc] Renderer unavailable for worktree chat event' ||
        args[0] === '[chat-ipc] Renderer unavailable for chat event'
      )
        return;
      warn(...args);
    });
  jest.doMock('@anthropic-ai/claude-agent-sdk', () => ({
    ...jest.requireActual<Record<string, unknown>>(
      '@anthropic-ai/claude-agent-sdk',
    ),
    query: (
      input: Parameters<typeof ClaudeQuery>[0],
    ): ReturnType<ReturnType<typeof claudeSdkModuleMock>['query']> => {
      if (!activeDrivers.claude)
        throw new Error('Claude driver is not initialized');
      return claudeSdkModuleMock(activeDrivers.claude).query(input);
    },
  }));
  jest.doMock('node:child_process', () => ({
    ...jest.requireActual<typeof ChildProcess>('node:child_process'),
    spawn: (
      ...args: Parameters<ReturnType<typeof codexSpawnModuleMock>['spawn']>
    ): ReturnType<ReturnType<typeof codexSpawnModuleMock>['spawn']> => {
      if (!activeDrivers.codex)
        throw new Error('Codex used outside a Codex scenario');
      return codexSpawnModuleMock(activeDrivers.codex).spawn(...args);
    },
  }));
  const target: PipelineChatTarget = {
    projectId: kind === 'app-advisor' ? 'app-advisor' : `pipeline-${kind}`,
    worktreeId: 'entry',
    chatId: 'scenario-chat',
  };
  const prepareStorage = options.prepareStorage;
  const harness = await createPipelineHarness({
    ...(prepareStorage
      ? {
          prepareStorage: (storage): Promise<void> =>
            prepareStorage(storage, target),
        }
      : {}),
  });
  const driver =
    provider === 'claude'
      ? (activeDrivers.claude = createScriptedClaude(harness.recorder, {
          target,
          emulateRootReceipt: options.emulateClaudeRootReceipt,
        }))
      : (activeDrivers.codex = createScriptedCodex(harness.recorder, {
          target,
        }));
  harness.registerChat(target, {
    captureRows: options.captureRows ?? true,
    captureTranscript: options.captureTranscript ?? 'revision',
  });
  try {
    const host = await harness.host(
      kind,
      provider,
      target,
      options.hostOptions,
    );
    return {
      harness,
      host,
      driver,
      target,
      hostVariant: scenarioHostVariant(kind, options.hostOptions),
      secrets: [],
    };
  } catch (error) {
    await driver.dispose();
    await harness.dispose();
    throw error;
  }
}

export async function disposeScenario(env: ScenarioEnvironment): Promise<void> {
  env.harness.releaseCommits();
  env.harness.releaseDrainBarrier(env.target);
  try {
    await env.driver.dispose();
    // Transport exit callbacks can enqueue real router/disk work. Let that I/O
    // arrive and drain before the harness removes subscriptions and storage.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await env.host.drain();
  } finally {
    try {
      await env.harness.dispose();
    } finally {
      jest.restoreAllMocks();
    }
  }
}

export async function startRoot(
  env: ScenarioEnvironment,
  text = 'root prompt',
): Promise<ScriptedProviderTurn> {
  const sending = env.host.send({ text });
  const turn = await env.driver
    .nextTurn({ timeoutMs: 10_000 })
    .catch((error: unknown) => {
      throw new Error(
        `${String(error)}\n${JSON.stringify(env.harness.recorder.events.slice(-20))}`,
      );
    });
  expect(turn.prompt).toContain(text);
  await turn.emitText('root assistant');
  await sending;
  await env.host.drain();
  return turn;
}

/** Timers use logical time; each step also awaits real provider/disk work. */
export async function pumpUntil(
  env: ScenarioEnvironment,
  predicate: () => boolean,
  boundMs = 2000,
): Promise<void> {
  for (let elapsed = 0; !predicate() && elapsed < boundMs; elapsed += 25) {
    await env.harness.advanceLogicalClock(25);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await env.host.drain();
  }
  if (!predicate()) {
    throw new Error(
      `Logical deadline ${boundMs}ms exceeded: ${JSON.stringify(env.harness.recorder.events.slice(-12))}`,
    );
  }
}

export async function finishScenario(
  env: ScenarioEnvironment,
  targets: readonly InvariantId[],
  /** Advance past the 5 s settle window before the final checkpoint. */
  settle = false,
  scenarioId?: number | string,
  scenarioVariant = 'normal',
): Promise<void> {
  await env.host.drain();
  if (settle) {
    await env.harness.advanceLogicalClock(5001);
    await env.host.drain();
  }
  await env.harness.checkpoint('drained', env.target);
  const final = env.harness.recorder.events.at(-1);
  // Invariant 15 judges an armed gate only once the trace reaches its deadline.
  if (
    final?.kind === 'checkpoint' &&
    final.liveness?.foreground === false &&
    (final.queueTurnActive !== false || final.admissionBlocked === true)
  ) {
    await env.harness.advanceLogicalClock(
      scenarioContext(env.secrets).gateBoundMs,
    );
    await env.host.drain();
    await env.harness.checkpoint('gate-deadline', env.target);
  }
  const trace = env.harness.recorder.events;
  if (process.env.CANOPY_PIPELINE_DORMANT_CENSUS === '1') {
    const dormant = checkDormantInvariants(trace, scenarioContext(env.secrets));
    const invariantIds = Array.from(
      new Set(dormant.violations.map((violation) => violation.id)),
    ).sort((left, right) => left - right);
    const [host, dispatch] = env.hostVariant.split('/');
    const row = scenarioId ?? 'unassigned';
    const variants = [
      dispatch === 'desktop-ipc' ? 'desktop-ipc' : undefined,
      scenarioVariant === 'normal' ? undefined : scenarioVariant,
    ].filter((variant): variant is string => variant !== undefined);
    process.stdout.write(
      `[pipeline-dormant] ${host ?? env.hostVariant}:${env.driver.provider}:${row}${variants.map((variant) => `:${variant}`).join('')} => ${JSON.stringify(invariantIds)}\n`,
    );
  }
  const violations = checkInvariants(trace, scenarioContext(env.secrets));
  if (violations.length) throw new Error(formatViolations(violations, trace));
  expect(violations).toEqual([]);
  const drained = [...trace]
    .reverse()
    .find((event) => event.kind === 'checkpoint' && event.label === 'drained');
  if (drained?.kind !== 'checkpoint')
    throw new Error('Missing final drain checkpoint');
  const activation = invariantActivation(trace);
  for (const id of targets) {
    if (!(activation[id] && activation[id] > 0)) {
      throw new Error(
        `Invariant ${id} was vacuous: ${JSON.stringify(activation)}\n${JSON.stringify(trace.slice(-12))}`,
      );
    }
  }
}

export const SCENARIO_ROWS = [
  {
    id: 1,
    name: 'basic turn',
    providers: ['claude', 'codex'],
    targets: [11, 17, 19],
  },
  {
    id: 2,
    name: 'acknowledged steer',
    providers: ['claude', 'codex'],
    targets: [21],
  },
  {
    id: 3,
    name: 'refused generated steer',
    providers: ['claude', 'codex'],
    targets: [21],
  },
  {
    id: 4,
    name: 'generated foreground watcher',
    providers: ['claude', 'codex'],
    targets: [13, 14],
  },
  {
    id: 5,
    name: 'Monkey drain barrier and slow commits',
    providers: ['claude', 'codex'],
    targets: [13, 14, 15],
  },
  {
    id: 6,
    name: 'Rat steered notices',
    providers: ['claude'],
    targets: [13, 15, 19, 21],
  },
  {
    id: 7,
    name: 'Claude slow-commit steer',
    providers: ['claude'],
    targets: [16, 21],
  },
  {
    id: 8,
    name: 'live native child and root terminal',
    providers: ['claude'],
    targets: [9, 5],
  },
  {
    id: 9,
    name: 'settings change with live native work',
    providers: ['claude'],
    targets: [12, 5],
  },
  {
    id: 10,
    name: 'server-request cancellation',
    providers: ['codex'],
    targets: [18],
  },
  {
    id: 11,
    name: 'watcher registration transport retry',
    providers: ['codex'],
    targets: [20],
  },
  {
    id: 12,
    name: 'self-started wake turn',
    providers: ['claude', 'codex'],
    targets: [19, 17],
  },
  {
    id: 13,
    name: 'user Stop mid-turn',
    providers: ['claude', 'codex'],
    targets: [15, 12],
  },
] as const;

export function targetsFor(
  id: number,
  provider: PipelineProvider,
): readonly InvariantId[] {
  const row = SCENARIO_ROWS.find((candidate) => candidate.id === id);
  if (!row) throw new Error(`Unknown scenario ${id}`);
  return row.targets.filter((target) => provider === 'claude' || target !== 19);
}

type ScenarioHostVariant =
  | 'worktree/service'
  | 'cowork/service'
  | 'cowork/desktop-ipc'
  | 'app-advisor/service';

function scenarioHostVariant(
  kind: PipelineHost,
  options?: PipelineHostOptions,
): ScenarioHostVariant {
  if (kind === 'worktree') return 'worktree/service';
  if (kind === 'app-advisor') return 'app-advisor/service';
  return options?.coworkDispatch === 'desktop-ipc'
    ? 'cowork/desktop-ipc'
    : 'cowork/service';
}

export function defineLifecycleScenarios(
  kind: PipelineHost,
  ids?: readonly number[],
  hostOptions: PipelineHostOptions = {},
): void {
  describe(`${kind} real provider turn lifecycle`, () => {
    for (const row of SCENARIO_ROWS) {
      if (ids && !ids.includes(row.id)) continue;
      if (kind !== 'worktree' && row.id >= 8 && row.id <= 11) continue;
      for (const provider of row.providers) {
        const variants =
          row.id === 6
            ? ['normal', 'prior-terminal', 'stop-overlap']
            : ['normal'];
        for (const variant of variants) {
          it(
            `${provider} row ${row.id}: ${row.name} [${variant}]`,
            async () => {
              const env = await createScenarioEnvironment(kind, provider, {
                hostOptions,
                // Root-receipt emulation changes scripted Claude input.
                emulateClaudeRootReceipt: provider === 'claude',
              });
              try {
                if (row.id === 5 || row.id === 6 || row.id === 7) {
                  const { runPortScenario } = await import('./scenarios-ports');
                  await runPortScenario(row.id, env, variant);
                } else {
                  const { runCoreScenario } = await import('./scenarios-core');
                  await runCoreScenario(row.id, env);
                }
                await finishScenario(
                  env,
                  targetsFor(row.id, provider),
                  true,
                  row.id,
                  variant,
                );
              } finally {
                await disposeScenario(env);
              }
            },
            SCENARIO_TEST_TIMEOUT_MS,
          );
        }
      }
    }
  });
}
