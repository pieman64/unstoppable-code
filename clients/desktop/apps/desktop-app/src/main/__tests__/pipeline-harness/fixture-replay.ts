/** Content-free lifecycle fixture loading, real-host replay and exact comparison. */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type {
  CodexAppServerConnection as CodexAppServerConnectionInstance,
  CodexAppServerConnectionOwner,
} from '@canopy/desktop-shared/node/codex-runtime/connection';
import type {
  LifecycleFixture,
  LifecycleEvidence,
  LifecycleFrame,
  LifecycleFrameObservation,
  LifecycleIds,
  LifecycleGroup,
  LifecycleLaunchProfile,
  LifecycleStep,
  PipelineTraceEvent,
} from './contracts';
import {
  createScenarioEnvironment,
  disposeScenario,
  finishScenario,
  pumpUntil,
  type ScenarioEnvironment,
} from './scenarios';

const scalar = z.union([z.string(), z.number().finite(), z.boolean()]);
const ids = z
  .object({
    session: z.string(),
    message: z.string(),
    turn: z.string(),
    thread: z.string(),
    item: z.string(),
    task: z.string(),
    call: z.string(),
    request: z.string(),
    toolUse: z.string(),
    agentThread: z.string(),
  })
  .partial()
  .strict();
const fields = z.record(
  z.string(),
  z.union([scalar, z.array(scalar), z.null()]),
);
const frame = z
  .object({
    kind: z.literal('frame'),
    lane: z.string().regex(/^(root|child:.+)$/),
    type: z.string().min(1),
    shape: z.array(z.string()).optional(),
    ids: ids.optional(),
    consumed: z.array(z.string()).optional(),
    fields: fields.optional(),
    template: z.string().min(1),
  })
  .strict();
const control = z
  .object({
    kind: z.literal('control'),
    action: z.enum([
      'send',
      'steer',
      'interrupt',
      'stop-task',
      'permission-allow',
      'permission-deny',
      'approve',
      'deny',
      'answer-tool',
      'release',
      'start-turn',
    ]),
    ids: ids.optional(),
    barrier: z.string().optional(),
  })
  .strict();
const evidenceRole = z.enum(['root', 'child', 'sibling']);
const evidenceIds = z.object({ thread: z.string(), turn: z.string() }).strict();
const evidence: z.ZodType<LifecycleEvidence> = z.discriminatedUnion('event', [
  z
    .object({
      kind: z.literal('evidence'),
      event: z.literal('admitted'),
      role: evidenceRole,
      ids: evidenceIds,
      barrier: z.string(),
      stepId: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('evidence'),
      event: z.literal('interrupt-sent'),
      role: z.enum(['root', 'child']),
      ids: evidenceIds,
    })
    .strict(),
  z
    .object({
      kind: z.literal('evidence'),
      event: z.literal('interrupt-ack'),
      role: z.enum(['root', 'child']),
      ids: evidenceIds,
      outcome: z.enum(['success', 'error']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('evidence'),
      event: z.literal('window-closed'),
      outcome: z.enum(['observed', 'inconclusive']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('evidence'),
      event: z.literal('release'),
      role: evidenceRole,
      ids: evidenceIds,
      barrier: z.string(),
    })
    .strict(),
]);
// A custom lane schema preserves the template-literal type without a cast.
const lane = z.custom<LifecycleFrame['lane']>(
  (value) => typeof value === 'string' && /^(root|child:.+)$/.test(value),
);
const step: z.ZodType<LifecycleStep> = z.lazy(() =>
  z.union([
    frame.extend({ lane }),
    control,
    evidence,
    z
      .object({ kind: z.literal('group'), lanes: z.array(z.array(step)) })
      .strict(),
  ]),
);
const fixtureSchema: z.ZodType<LifecycleFixture> = z
  .object({
    schemaVersion: z.literal(1),
    scenario: z.string().min(1),
    provider: z.enum(['claude', 'codex']),
    tier: z.enum(['fast', 'slow']),
    profile: z.string().min(1),
    provenance: z
      .object({ binaryVersion: z.string(), sdkVersion: z.string().optional() })
      .strict(),
    semantics: z.array(z.string()),
    steps: z.array(step),
  })
  .strict();
const profileSchema: z.ZodType<LifecycleLaunchProfile> = z
  .object({
    profile: z.string(),
    provider: z.enum(['claude', 'codex']),
    productProjection: z.record(z.string(), z.unknown()),
    contractOverrides: z.array(
      z
        .object({
          setting: z.string(),
          reason: z.string(),
          value: z.unknown().optional(),
          scenarios: z.array(z.string()).optional(),
        })
        .strict(),
    ),
  })
  .strict();

const lifecycleFieldNames = new Set([
  'commandState',
  'originKind',
  'terminalReason',
  'stopReason',
  'resultSubtype',
  'isError',
  'resultIndex',
  'sessionState',
  'taskType',
  'taskStatus',
  'isBackgrounded',
  'ambient',
  'workflowName',
  'workflowPhase',
  'membersSet',
  'backgroundMembersSet',
  'threadStatus',
  'activeFlagsSet',
  'turnStatus',
  'errorClass',
  'willRetry',
  'serverRequestResolution',
  'segment',
  'subagentKind',
]);

export function parseLifecycleFixture(value: unknown): LifecycleFixture {
  const fixture = fixtureSchema.parse(value);
  for (const entry of fixtureFrames(fixture.steps)) {
    for (const [key, value] of Object.entries(entry.fields ?? {})) {
      if (!lifecycleFieldNames.has(key)) {
        throw new Error(
          `Fixture ${fixture.scenario}: field ${key} is not lifecycle data`,
        );
      }
      if (
        key.endsWith('Set') &&
        (!Array.isArray(value) ||
          !isDeepStrictEqual(value, Array.from(new Set(value)).sort()))
      ) {
        throw new Error(
          `Fixture ${fixture.scenario}: ${key} must be a sorted set`,
        );
      }
    }
    if (fixture.provider === 'claude' && !entry.type.startsWith('sdk:')) {
      throw new Error(`Invalid Claude frame label ${entry.type}`);
    }
    if (
      fixture.provider === 'codex' &&
      !/^(notification|request|response):/.test(entry.type)
    ) {
      throw new Error(`Invalid Codex frame label ${entry.type}`);
    }
  }
  return fixture;
}

export function fixtureFrames(
  steps: readonly LifecycleStep[],
): LifecycleFrame[] {
  return steps.flatMap((entry) =>
    entry.kind === 'frame'
      ? [entry]
      : entry.kind === 'group'
        ? entry.lanes.flatMap(fixtureFrames)
        : [],
  );
}

function jsonPaths(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) =>
      entry.isDirectory()
        ? jsonPaths(join(root, entry.name))
        : entry.isFile() && entry.name.endsWith('.json')
          ? [join(root, entry.name)]
          : [],
    );
}

export function loadLifecycleFixtures(): {
  path: string;
  fixture: LifecycleFixture;
}[] {
  return (
    [
      resolve('scripts/harness-contract/lifecycle/fixtures'),
      join(__dirname, 'fixtures'),
    ]
      // The recorder's root index.json is coverage metadata, not a C2 fixture.
      .flatMap((root) =>
        ['claude', 'codex'].flatMap((provider) =>
          jsonPaths(join(root, provider)),
        ),
      )
      .map((path) => ({
        path,
        fixture: parseLifecycleFixture(JSON.parse(readFileSync(path, 'utf8'))),
      }))
  );
}

export function loadLifecycleProfiles(): LifecycleLaunchProfile[] {
  return jsonPaths(resolve('scripts/harness-contract/lifecycle/profiles')).map(
    (path) => profileSchema.parse(JSON.parse(readFileSync(path, 'utf8'))),
  );
}

export function expectedFrame(
  frame: LifecycleFrame,
): LifecycleFrameObservation {
  const { kind: _kind, template: _template, ...observation } = frame;
  void _kind;
  void _template;
  return observation;
}

/** Every inbound frame counts, including accidental automatic startup traffic. */
export function normalizedProviderFrames(
  trace: readonly PipelineTraceEvent[],
  fixture?: LifecycleFixture,
): LifecycleFrameObservation[] {
  const hasEvidence = fixture
    ? fixture.steps.some(containsEvidenceStep)
    : false;
  const interruptRequests = new Map<string, LifecycleFrameObservation>();
  if (hasEvidence) {
    for (const event of trace) {
      if (
        event.kind !== 'provider' ||
        event.provider !== 'codex' ||
        event.direction !== 'to-provider' ||
        event.type !== 'client:turn/interrupt' ||
        event.ids?.requestId === undefined ||
        !event.replayFrame
      )
        continue;
      interruptRequests.set(String(event.ids.requestId), event.replayFrame);
    }
  }

  return trace.flatMap((event) =>
    event.kind === 'provider' &&
    event.direction === 'to-canopy' &&
    // The scripted provider answers this pre-thread read itself; recorded
    // fixtures predate it, so it is not part of their frame contract.
    !(event.provider === 'codex' && event.type === 'response:config/read')
      ? [
          normalizeInterruptResponse(event, event.replayFrame, {
            hasEvidence,
            interruptRequests,
          }) ?? {
            lane: 'root',
            type: `UNPROJECTED:${event.type}`,
          },
        ]
      : [],
  );
}

function containsEvidenceStep(step: LifecycleStep): boolean {
  return step.kind === 'evidence'
    ? true
    : step.kind === 'group'
      ? step.lanes.some((lane) => lane.some(containsEvidenceStep))
      : false;
}

function normalizeInterruptResponse(
  event: Extract<PipelineTraceEvent, { kind: 'provider' }>,
  observation: LifecycleFrameObservation | undefined,
  context: {
    hasEvidence: boolean;
    interruptRequests: ReadonlyMap<string, LifecycleFrameObservation>;
  },
): LifecycleFrameObservation | undefined {
  if (event.provider !== 'codex' || event.type !== 'response:turn/interrupt')
    return observation;

  if (!context.hasEvidence) {
    if (!observation?.fields?.serverRequestResolution) return observation;
    const fields = { ...observation.fields };
    delete fields.serverRequestResolution;
    const frame = { ...observation };
    delete frame.fields;
    return {
      ...frame,
      ...(Object.keys(fields).length > 0 ? { fields } : {}),
    };
  }

  const requestId = event.ids?.requestId;
  const request =
    requestId === undefined
      ? undefined
      : context.interruptRequests.get(String(requestId));
  if (!observation || !request) return observation;

  const ids = { ...observation.ids };
  for (const kind of ['thread', 'turn'] as const) {
    const targetId = request.ids?.[kind];
    if (targetId === undefined) delete ids[kind];
    else ids[kind] = targetId;
  }
  const frame = { ...observation };
  delete frame.ids;
  return {
    ...frame,
    lane: request.lane,
    ...(Object.keys(ids).length > 0 ? { ids } : {}),
  };
}

function sameFrame(
  left: LifecycleFrameObservation | undefined,
  right: LifecycleFrameObservation,
): boolean {
  return sameContractValue(left, right);
}

/** Contract values can cross Jest VM realms; prototypes are not wire data. */
function sameContractValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (
    left === null ||
    right === null ||
    typeof left !== 'object' ||
    typeof right !== 'object'
  )
    return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length !== right.length
  )
    return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        sameContractValue(Reflect.get(left, key), Reflect.get(right, key)),
    )
  );
}

function isSubagentStartedFrame(frame: LifecycleFrame): boolean {
  return (
    frame.type === 'notification:item/started' &&
    frame.shape?.[0] === 'subAgentActivity' &&
    frame.fields?.subagentKind === 'started' &&
    typeof frame.ids?.agentThread === 'string'
  );
}

/**
 * Replay one lifecycle group in stable per-lane order. Child lanes wait for a
 * same-group subagent-start item, while the first currently-unblocked lane
 * always wins the next step.
 */
export async function replayLifecycleGroup(
  scenario: string,
  group: LifecycleGroup,
  emitStep: (step: LifecycleStep) => Promise<void>,
  emittedSubagentStartedFrames: Set<LifecycleFrame>,
): Promise<void> {
  const cursors = group.lanes.map(() => 0);
  const startedFrameByAlias = new Map<string, LifecycleFrame>();
  for (const frame of group.lanes.flatMap((items) => fixtureFrames(items))) {
    if (isSubagentStartedFrame(frame)) {
      const alias = frame.ids?.agentThread;
      if (alias) startedFrameByAlias.set(alias, frame);
    }
  }

  while (
    cursors.some((cursor, index) => cursor < (group.lanes[index]?.length ?? 0))
  ) {
    let progressed = false;
    for (let index = 0; index < group.lanes.length; index += 1) {
      const items = group.lanes[index];
      const cursor = cursors[index];
      if (!items || cursor === undefined) continue;
      const next = items[cursor];
      if (!next) continue;

      const firstFrame = fixtureFrames(items)[0];
      const childAlias = firstFrame?.lane.startsWith('child:')
        ? firstFrame.lane.slice('child:'.length)
        : undefined;
      const startGate = childAlias
        ? startedFrameByAlias.get(childAlias)
        : undefined;
      if (startGate && !emittedSubagentStartedFrames.has(startGate)) continue;

      await emitStep(next);
      if (next.kind === 'frame' && isSubagentStartedFrame(next))
        emittedSubagentStartedFrames.add(next);
      cursors[index] = cursor + 1;
      progressed = true;
      break;
    }
    if (!progressed) {
      throw new Error(
        `${scenario}: lifecycle group has no unblocked lane; a child lane is waiting for its subagent started frame`,
      );
    }
  }
}

/** A group is a shuffle of a multiset of ordered lanes, not a sorted bag of frames. */
function matchesGroup(
  actual: readonly LifecycleFrameObservation[],
  lanes: readonly LifecycleStep[][],
): boolean {
  const nodes: {
    observation: LifecycleFrameObservation;
    dependencies: number[];
  }[] = [];
  // Nested groups add parallel branches to the same ordering graph. A frame
  // after a group depends on every branch, preserving the outer lane's order.
  function append(
    steps: readonly LifecycleStep[],
    previous: number[],
  ): number[] {
    let frontier = previous;
    for (const entry of steps) {
      if (entry.kind === 'frame') {
        const index = nodes.length;
        nodes.push({
          observation: expectedFrame(entry),
          dependencies: frontier,
        });
        frontier = [index];
      } else if (entry.kind === 'group') {
        const branches = entry.lanes.flatMap((items) =>
          append(items, frontier),
        );
        frontier = branches.length ? branches : frontier;
      }
    }
    return frontier;
  }
  for (const items of lanes) append(items, []);
  if (nodes.length !== actual.length) return false;
  const completed = nodes.map(() => false);
  const visited = new Set<string>();
  function visit(index: number): boolean {
    if (index === actual.length) return true;
    const key = completed.map((done) => (done ? '1' : '0')).join('');
    if (visited.has(key)) return false;
    visited.add(key);
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i];
      if (
        node &&
        !completed[i] &&
        node.dependencies.every((dependency) => completed[dependency]) &&
        sameFrame(actual[index], node.observation)
      ) {
        completed[i] = true;
        if (visit(index + 1)) return true;
        completed[i] = false;
      }
    }
    return false;
  }
  return visit(0);
}

export function assertFixtureFrames(
  fixture: LifecycleFixture,
  actual: readonly LifecycleFrameObservation[],
): void {
  let offset = 0;
  for (const entry of fixture.steps) {
    if (entry.kind === 'control' || entry.kind === 'evidence') continue;
    if (entry.kind === 'frame') {
      if (!sameFrame(actual[offset], expectedFrame(entry))) {
        throw new Error(
          `${fixture.scenario}: frame ${offset} differs\nexpected ${JSON.stringify(expectedFrame(entry))}\nactual ${JSON.stringify(actual[offset])}`,
        );
      }
      offset += 1;
    } else {
      const count = entry.lanes.reduce(
        (sum, items) => sum + fixtureFrames(items).length,
        0,
      );
      const window = actual.slice(offset, offset + count);
      if (!matchesGroup(window, entry.lanes)) {
        throw new Error(
          `${fixture.scenario}: group at frame ${offset} differs (lane order or multiplicity)\nexpected lanes ${JSON.stringify(entry.lanes.map((items) => fixtureFrames(items).map(expectedFrame)))}\nactual ${JSON.stringify(window)}`,
        );
      }
      offset += count;
    }
  }
  if (offset !== actual.length)
    throw new Error(
      `${fixture.scenario}: ${actual.length - offset} extra provider frames`,
    );
}

export interface ReplayFixtureOptions {
  /** Specialized product approval/question paths must be supplied explicitly. */
  control?: (
    step: Extract<LifecycleStep, { kind: 'control' }>,
    env: ScenarioEnvironment,
  ) => Promise<void>;
  /** Adds a second owner through the real connection's public test seam. */
  registerAdditionalCodexPoolOwner?: boolean;
  /** Read-only view of the materialized envelope immediately before its write. */
  onBeforeCodexFrameWrite?: (observation: {
    frame: LifecycleFrame;
    envelope: Readonly<Record<string, unknown>>;
    liveId: (kind: keyof LifecycleIds, alias: string) => string | undefined;
    connection?: {
      clientCount(): number;
      resolveOwnerForThread(
        threadId: string,
      ): CodexAppServerConnectionOwner | null;
    };
    registeredSubagentThreadIds: readonly string[];
  }) => void;
}

function createReplayFallbackGuardOwner(): CodexAppServerConnectionOwner {
  return {
    hasActiveTurn: () => false,
    getActiveTurnInterruptTarget: () => null,
    cancelPendingTurnStart: () => undefined,
    rejectActiveTurn: () => undefined,
    markProcessSuspended: () => undefined,
    markProcessFailed: () => undefined,
    handleConnectionNotification: () => undefined,
    handleRequestUserInput: () => Promise.resolve(),
    handleDynamicToolCall: () => Promise.resolve(),
    handleApprovalRequest: () => Promise.resolve(),
    handleMcpElicitation: () => Promise.resolve(),
  };
}

interface ReplayNativeConnection {
  request(
    method: 'turn/start',
    params: {
      threadId: string;
      input: { type: 'text'; text: string; text_elements: [] }[];
    },
  ): Promise<unknown>;
}
function isReplayNativeConnection(
  value: unknown,
): value is ReplayNativeConnection {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'request') === 'function'
  );
}

export async function replayLifecycleFixture(
  fixture: LifecycleFixture,
  options: ReplayFixtureOptions = {},
): Promise<LifecycleFrameObservation[]> {
  const env = await createScenarioEnvironment('worktree', fixture.provider);
  const pending: Promise<void>[] = [];
  const restores: (() => void)[] = [];
  let nativeConnection: ReplayNativeConnection | undefined;
  let replayConnection: CodexAppServerConnectionInstance | undefined;
  let additionalCodexOwner: CodexAppServerConnectionOwner | undefined;
  const registeredSubagentThreadIds: string[] = [];
  let releaseDynamicTool = (): void => undefined;
  let dynamicToolEntered = false;
  let startControls = 0;
  const errors: unknown[] = [];
  let inFlight = 0;
  function track(promise: Promise<unknown>): void {
    inFlight += 1;
    pending.push(
      promise.then(
        () => {
          inFlight -= 1;
        },
        (error: unknown) => {
          inFlight -= 1;
          errors.push(error);
        },
      ),
    );
  }
  try {
    if (!env.driver.enableReplay)
      throw new Error(`${fixture.provider} replay is unavailable`);
    const replay = env.driver.enableReplay(fixture);
    const frames = fixtureFrames(fixture.steps);
    if (fixture.provider === 'codex') {
      const { CodexAppServerClient } =
        await import('../../codex/app-server-client');
      if (
        options.registerAdditionalCodexPoolOwner ||
        options.onBeforeCodexFrameWrite
      ) {
        const { CodexAppServerConnection } =
          await import('@canopy/desktop-shared/node/codex-runtime/connection');
        const noteReplayConnection = (
          connection: CodexAppServerConnectionInstance,
        ): void => {
          replayConnection = connection;
        };
        const prototype = CodexAppServerConnection.prototype;
        // eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked below with the real connection receiver.
        const registerRoot = prototype.registerRootThread;
        const rootRegistrationSpy = jest
          .spyOn(prototype, 'registerRootThread')
          .mockImplementation(function (
            this: CodexAppServerConnectionInstance,
            threadId,
            owner,
          ): void {
            registerRoot.call(this, threadId, owner);
            noteReplayConnection(this);
            if (
              options.registerAdditionalCodexPoolOwner &&
              !additionalCodexOwner
            ) {
              additionalCodexOwner = createReplayFallbackGuardOwner();
              this.createTestSeam().registerOwner(additionalCodexOwner);
            }
          });
        // eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked below with the real connection receiver.
        const registerSubagent = prototype.registerSubagentThread;
        const subagentRegistrationSpy = jest
          .spyOn(prototype, 'registerSubagentThread')
          .mockImplementation(function (
            this: CodexAppServerConnectionInstance,
            threadId,
            owner,
          ): void {
            registerSubagent.call(this, threadId, owner);
            noteReplayConnection(this);
            registeredSubagentThreadIds.push(threadId);
          });
        restores.push(
          () => subagentRegistrationSpy.mockRestore(),
          () => rootRegistrationSpy.mockRestore(),
        );
      }
      // Capture the owner-bound real runtime transport; a second native start is
      // deliberately not an AgentSession.sendMessage (which serializes turns).
      // eslint-disable-next-line @typescript-eslint/unbound-method -- Called below with the original receiver.
      const original = CodexAppServerClient.prototype.startTurn;
      const spy = jest
        .spyOn(CodexAppServerClient.prototype, 'startTurn')
        .mockImplementation(function (
          this: InstanceType<typeof CodexAppServerClient>,
          ...args
        ): ReturnType<typeof original> {
          const connection: unknown = Reflect.get(this, 'connection');
          if (!isReplayNativeConnection(connection))
            throw new Error('Missing owner-bound Codex request transport');
          nativeConnection = connection;
          return original.call(this, ...args);
        });
      restores.push(() => spy.mockRestore());
      if (frames.some((frame) => frame.type === 'request:item/tool/call')) {
        const { getChatStateService } =
          await import('../../services/chat-state-service');
        await getChatStateService().command({
          schemaVersion: 1,
          commandId: 'fixture-tool-access',
          ...env.target,
          command: {
            type: 'chat.set_approval_mode',
            tabId: env.target.chatId,
            approvalMode: 'full-access',
          },
        });
        const { getAppAdvisorWatcherService } =
          await import('../../app-advisor/watchers');
        const service = getAppAdvisorWatcherService();
        /* eslint-disable @typescript-eslint/unbound-method -- Preserve the existing harness observer, not its mutable Jest wrapper. */
        const originalWatcher = jest.isMockFunction(service.createLocalWatcher)
          ? jest.mocked(service.createLocalWatcher).getMockImplementation()
          : service.createLocalWatcher.bind(service);
        /* eslint-enable @typescript-eslint/unbound-method */
        if (!originalWatcher) throw new Error('Missing watcher observer');
        const held = new Promise<void>((resolve) => {
          releaseDynamicTool = resolve;
        });
        const watcherSpy = jest
          .spyOn(service, 'createLocalWatcher')
          .mockImplementation(async (...args) => {
            dynamicToolEntered = true;
            const signal = args[5]?.signal;
            if (!signal)
              throw new Error('Dynamic tool omitted cancellation signal');
            if (signal.aborted) releaseDynamicTool();
            else
              signal.addEventListener('abort', releaseDynamicTool, {
                once: true,
              });
            await held;
            return originalWatcher(...args);
          });
        restores.push(() => watcherSpy.mockRestore());
      }
    }
    const removeFrameObserver = replay.observeBeforeFrameWrite?.(
      (frame, envelope): void => {
        const connection = replayConnection
          ? {
              clientCount: (): number => replayConnection?.clientCount() ?? 0,
              resolveOwnerForThread: (
                threadId: string,
              ): CodexAppServerConnectionOwner | null =>
                replayConnection?.resolveOwnerForThread(threadId) ?? null,
            }
          : undefined;
        options.onBeforeCodexFrameWrite?.({
          frame,
          envelope,
          liveId: (kind, alias): string | undefined =>
            replay.liveId?.(kind, alias),
          ...(connection ? { connection } : {}),
          registeredSubagentThreadIds: [...registeredSubagentThreadIds],
        });
      },
    );
    if (removeFrameObserver) restores.push(removeFrameObserver);
    // Recorders may begin with provider startup frames; the initial prompt is
    // setup, not a captured mid-stream control. Still use the real host path.
    const firstStep = fixture.steps[0];
    if (firstStep?.kind !== 'control' || firstStep.action !== 'send') {
      track(env.host.send({ text: 'fixture initial input' }));
      if (fixture.provider === 'claude')
        track(replay.acceptControl({ kind: 'control', action: 'send' }));
    }
    const emittedSubagentStartedFrames = new Set<LifecycleFrame>();
    let lastTaskAlias: string | undefined;
    // A send inside an autonomous wake uses the native SDK queue; an ordinary
    // mid-turn host send must wait for the real product queue's terminal gate.
    let rootResultObservedSinceSend = false;
    const issueNativeInterrupt = async (): Promise<void> => {
      // Recorder interrupts are provider-native, not product Stop.
      const { getSession } = await import('../../agents/session-manager');
      const session = getSession(
        env.target.projectId,
        env.target.worktreeId,
        env.target.chatId,
      );
      if (!session) throw new Error('Native interrupt requires a live session');
      if (fixture.provider === 'claude') {
        if (!session.interruptWithPendingSweep)
          throw new Error('Claude native interrupt path is unavailable');
        track(session.interruptWithPendingSweep());
      } else track(session.cancel());
    };
    const run = async (steps: readonly LifecycleStep[]): Promise<void> => {
      for (const entry of steps) {
        if (entry.kind === 'group') {
          await replayLifecycleGroup(
            fixture.scenario,
            entry,
            (step) => run([step]),
            emittedSubagentStartedFrames,
          );
        } else if (entry.kind === 'frame') {
          lastTaskAlias = entry.ids?.task ?? lastTaskAlias;
          if (
            fixture.provider === 'claude' &&
            entry.type === 'sdk:command_lifecycle' &&
            entry.ids?.message
          ) {
            // Pickup may depend on the host queue's logical steering timer.
            // Pump it before materializing the receipt, which needs the live
            // input UUID; awaiting the frame alone would freeze that timer.
            const message = entry.ids.message;
            await pumpUntil(
              env,
              () => replay.liveId?.('message', message) !== undefined,
            );
          }
          await replay.emit(entry);
          if (entry.lane === 'root' && entry.type.startsWith('sdk:result:'))
            rootResultObservedSinceSend = true;
          if (entry.type === 'request:item/tool/call') {
            // The real tool handler is intentionally held until interrupt. Do
            // not globally drain the very work the next control cancels.
            // Logical time stays bounded; real time lets a slow CI host
            // finish the handler's I/O before the sink check.
            const realDeadline = Date.now() + 10_000;
            for (
              let elapsed = 0;
              !dynamicToolEntered && Date.now() < realDeadline;
              elapsed += 25
            ) {
              if (elapsed < 2000) await env.harness.advanceLogicalClock(25);
              await new Promise<void>((resolve) => setTimeout(resolve, 5));
            }
            if (!dynamicToolEntered)
              throw new Error(
                'Dynamic replay tool did not reach its held side-effect sink',
              );
          } else {
            await env.harness.advanceLogicalClock(25);
            await env.host.drain();
            if (entry.type.startsWith('sdk:result:')) {
              // Ordinary sends made during a turn remain in the real host
              // queue until terminal admission. Advance that queue logically.
              for (let elapsed = 0; elapsed < 250; elapsed += 25) {
                await env.harness.advanceLogicalClock(25);
                await new Promise<void>((resolve) => setImmediate(resolve));
                await env.host.drain();
              }
            }
          }
        } else if (entry.kind === 'evidence') {
          if (entry.event === 'interrupt-sent' && entry.role === 'root') {
            await issueNativeInterrupt();
            track(
              replay.acceptControl({
                kind: 'control',
                action: 'interrupt',
                ids: entry.ids,
              }),
            );
          }
        } else {
          if (
            entry.action === 'send' &&
            fixture.provider === 'claude' &&
            rootResultObservedSinceSend &&
            entry.ids?.message &&
            frames.some(
              (frame) =>
                frame.type === 'sdk:command_lifecycle' &&
                frame.ids?.message === entry.ids?.message,
            )
          ) {
            // A recorded native SDK send can be queued inside an autonomous
            // wake. Composer sends intentionally remain in the host queue;
            // use the real session input path for this native CLI control.
            const { getSession } = await import('../../agents/session-manager');
            const session = getSession(
              env.target.projectId,
              env.target.worktreeId,
              env.target.chatId,
            );
            if (!session)
              throw new Error('Native send requires a live Claude session');
            session.sendMessage(`fixture native input ${entry.ids.message}`);
          } else if (entry.action === 'send') {
            track(
              env.host.send({
                text: `fixture input ${entry.ids?.message ?? 'root'}`,
              }),
            );
          } else if (entry.action === 'steer') {
            track(
              env.host.deliverGenerated({
                kind: 'watcher',
                text: `fixture steer ${entry.ids?.message ?? 'generated'}`,
                watcherId: `fixture-${entry.ids?.message ?? 'watcher'}`,
                deliveryId: `fixture-${entry.ids?.message ?? 'delivery'}`,
              }),
            );
          } else if (entry.action === 'interrupt') {
            await issueNativeInterrupt();
          } else if (entry.action === 'stop-task') {
            const alias = entry.ids?.task ?? lastTaskAlias;
            const liveTask = alias ? replay.liveId?.('task', alias) : undefined;
            if (!liveTask)
              throw new Error('stop-task requires a bound native task alias');
            const { stopTaskForSession } =
              await import('../../agents/session-manager');
            track(
              stopTaskForSession(
                env.target.projectId,
                env.target.worktreeId,
                env.target.chatId,
                liveTask,
              ),
            );
          } else if (entry.action === 'release') {
            env.harness.releaseCommits();
            env.harness.releaseDrainBarrier(env.target);
          } else if (entry.action === 'start-turn') {
            if (fixture.provider === 'codex' && startControls++ > 0) {
              const threadAlias = frames.find((frame) => frame.ids?.thread)?.ids
                ?.thread;
              const threadId = threadAlias
                ? replay.liveId?.('thread', threadAlias)
                : undefined;
              if (!nativeConnection || !threadId)
                throw new Error(
                  'Merged start requires a live Codex owner and thread',
                );
              track(
                nativeConnection.request('turn/start', {
                  threadId,
                  input: [
                    {
                      type: 'text',
                      text: 'Synthetic merged input',
                      text_elements: [],
                    },
                  ],
                }),
              );
            }
          } else if (options.control) {
            track(options.control(entry, env));
          } else {
            throw new Error(
              `No host adapter supplied for fixture control ${entry.action}`,
            );
          }
          if (entry.action === 'send') rootResultObservedSinceSend = false;
          // Do not await input pickup here: the host may retain a mid-turn
          // send until its terminal gate opens. Frame materialization waits on
          // the live alias only when a receipt/consumed frame first needs it.
          const following = fixture.steps.slice(
            fixture.steps.indexOf(entry) + 1,
          );
          const turnAlias = fixtureFrames(following).find(
            (frame) => frame.type === 'response:turn/start',
          )?.ids?.turn;
          track(
            replay.acceptControl(
              entry.action === 'start-turn' && turnAlias
                ? { ...entry, ids: { ...entry.ids, turn: turnAlias } }
                : entry,
            ),
          );
        }
      }
    };
    await run(fixture.steps);
    await pumpUntil(env, () => inFlight === 0, 6000);
    await Promise.all(pending);
    if (errors.length) throw errors[0];
    await finishScenario(
      env,
      fixture.provider === 'claude' ? [11, 17, 19] : [11, 17],
    );
    const result = normalizedProviderFrames(
      env.harness.recorder.events,
      fixture,
    );
    assertFixtureFrames(fixture, result);
    return result;
  } finally {
    releaseDynamicTool();
    if (additionalCodexOwner && replayConnection)
      replayConnection.unregisterOwner(additionalCodexOwner);
    for (const restore of restores.reverse()) restore();
    await disposeScenario(env);
  }
}
