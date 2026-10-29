import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import {
  LEDGER_ROUND_TRIP_BUDGETS_MS,
  PERFORMANCE_PIPELINE_OUTPUT_BYTES_PER_REVIEWER,
  PERFORMANCE_PIPELINE_REVIEWER_COUNT,
  assertRequestedPipelineConcurrency,
  assertE2eRootSupported,
  assertReleaseLikeScenarioSupported,
  assertReleaseLikeRootSupported,
  applyCodeGraphFixtureEdit,
  bracketWork,
  buildCodeGraphFixtureSource,
  clearComposerDraft,
  TOOL_ACTIVE_TURN_BATCH,
  buildMultiChatClaudeConversation,
  buildMultiChatCodexScript,
  buildChatSwitchCatchUpPlan,
  chatSwitchTranscriptPageCounters,
  buildSizedToolActiveTurnConversation,
  codeGraphBuildTimings,
  codeGraphBuildWork,
  costIndexCheckpointSummary,
  diskAccuracyCheck,
  directoryFileBytes,
  managedDelegationDescriptors,
  managedDelegationScripts,
  managedDelegationStepText,
  multiChatClaudeStepCount,
  measuredBuildRootOption,
  multiChatStreamingChats,
  readCodeGraphBuildDiagnostics,
  readCodeGraphBuildMetadata,
  scenarioWorkCollection,
  startupJourneyMilestones,
  startupTraceElectronArgs,
  summarizeV8CompileTrace,
  toolActiveTurnTimeoutMs,
  transcriptToolActiveTurnSizeFixtures,
  requireQuiescence,
  waitForQuiescence,
  buildPerformancePipelineYaml,
  buildSyntheticTranscriptMessages,
  buildTranscriptStreamConversation,
  buildTranscriptToolActiveTurnConversation,
  countPersistedAssistantReplies,
  codexRootsCompletedWithoutSpawn,
  codeGraphManualOverlapConfirmed,
  codeGraphQueueCounts,
  drainTransientItems,
  laterTurnActivationObserved,
  mixedProviderWorkCompleted,
  registerMixedProviderAgentScenarios,
  missingRealisticStartupProcedureEvents,
  nextPaint,
  panelIdFromTabTestId,
  performanceElectronArgs,
  parseBrowserPartitionHandles,
  pluginPickerDomRowCount,
  providerRequestWaitTimeoutMs,
  powerUserIdleShape,
  preparePowerUserIdle,
  prepareTranscriptStreamWorkspace,
  prepareDefaultCoworkWorkspace,
  prepareChatSearchIndexing,
  prepareHomeCoworkLegacy,
  preparePlanOpen,
  projectTranscriptWork,
  readPreexistingWorktreeIds,
  readWorktreeSetupStatus,
  recordResponsiveTask,
  recordTask,
  readPluginPickerSelections,
  resolvePluginPickerChatIndex,
  realisticStartupWorktreeDistribution,
  ledgerFixtureAccountId,
  ledgerUnavailableReason,
  performanceDataRootParent,
  scenarioClientFeatureFlags,
  runLoadedUi,
  scenarioWorkCounters,
  seedWorkspace,
  sidebarWorktreeRow,
  transcriptContentCounters,
  transcriptStopFenceWaitMs,
  waitForCodeGraphQueueDrain,
  waitUntil,
  FatalWaitError,
  worktreeGitPendingError,
  worktreeSetupSelectionTimeoutMs,
} from './scenarios.mjs';
import {
  PERFORMANCE_PROFILES,
  STARTUP_JOURNEY_SCENARIO_NAMES,
} from './profiles.mjs';
import { toolActiveTurnTaskKind } from './scaling-ratios.mjs';
import { buildScenarioMetrics } from './results.mjs';
import {
  handleLlmRequest,
  resolveCannedStep,
} from '../electron/mock-server/routes/llm.mjs';
import {
  clearScenario,
  registerScenario as registerMockScenario,
} from '../electron/mock-server/control-plane.mjs';
import {
  isDataModelDiffDiagram,
  isLogicDiffDiagram,
  isParsedPlanGraph,
  isPlanDiagramArtifacts,
} from '@canopy/protocol/plans';
import {
  buildLargePlanFixture,
  LARGE_PLAN_SENTINEL,
} from '../electron/seeders/trackedPlanFixtures.mjs';
import { MOCK_GUEST_ACCOUNT_ID } from '../electron/mock-server/routes/cloud.mjs';
import {
  boundScenarioFailureValue,
  captureScenarioFailure,
} from './scenario-failure-diagnostics.mjs';

test('loaded UI navigation uses its seeded activity layout without the E2E rail shim', async () => {
  const assertions = [];
  const selections = [];
  class Locator {
    constructor(name) {
      this.name = name;
    }
    first() {
      return this;
    }
    nth() {
      return this;
    }
    or() {
      return this;
    }
    async click() {}
    async _expect(expression) {
      assertions.push({ name: this.name, expression });
      return { matches: true };
    }
  }
  const page = {
    evaluate: async () => undefined,
    keyboard: { press: async () => undefined },
    getByTestId: (name) => new Locator(name),
    locator: (name) => new Locator(name),
  };
  const tasks = [];
  await runLoadedUi({
    page,
    app: {
      selectWorktree: async (branch, options) => {
        selections.push({ branch, options });
      },
    },
    config: {
      loadedChatTabs: 1,
      navigationIterations: 1,
      loadedTurnsPerChat: 1,
      loadedPipelineExecutions: 1,
    },
    tasks,
  });
  assert.equal(selections.length, 2);
  for (const selection of selections) {
    assert.equal(
      selection.options?.expandDefaultActivityRail,
      false,
      'measured navigation must not wait for the E2E-only panel test API',
    );
  }
  assert.ok(
    assertions.some(
      ({ name, expression }) =>
        name === 'panel-content-activity-section' &&
        expression === 'to.be.visible',
    ),
    'the seeded activity panel must remain a visible workload postcondition',
  );
  assert.deepEqual(
    tasks.map(({ kind }) => kind),
    ['select_worktree', 'switch_loaded_chat', 'navigate_page'],
  );
});

test('a composer clear that leaves the previous draft is retried until it is gone', async () => {
  // Under concurrent streaming the first `fill('')` can leave the Slate
  // composer's text in place. Typing the next draft on top of it, or saving
  // it as the tab's draft on the next switch, corrupts the next iteration.
  const marker = 'worktree-concurrency responsiveness ';
  let text = `${marker}7: typing through active background work`;
  let fills = 0;
  const composer = {
    async fill(value) {
      fills += 1;
      if (fills > 1) text = value;
    },
    async textContent() {
      return text;
    },
  };
  await clearComposerDraft(composer, marker, { timeoutMs: 5_000 });
  assert.equal(text, '');
  assert.equal(fills, 2);
});

test('scenario failure capture bounds evidence and rethrows the original assertion', async () => {
  const original = new Error('original assertion');
  const lines = [];
  await assert.rejects(
    captureScenarioFailure(
      original,
      'explorer-mutation-appeared',
      () => ({
        rows: Array.from({ length: 30 }, (_, index) => `row-${index}`),
        errorText: 'x'.repeat(500),
      }),
      { write: (line) => lines.push(line) },
    ),
    (error) => error === original,
  );
  assert.equal(lines.length, 1);
  const payload = JSON.parse(lines[0].split(' ', 2)[1]);
  assert.equal(payload.kind, 'explorer-mutation-appeared');
  assert.equal(payload.diagnosticOnly, true);
  assert.equal(payload.evidence.rows.length, 12);
  assert.equal(payload.evidence.errorText.length, 256);
  assert.equal(
    boundScenarioFailureValue({ nested: { value: 'ok' } }).nested.value,
    'ok',
  );
  const cyclic = { value: 'ok' };
  cyclic.self = cyclic;
  assert.equal(boundScenarioFailureValue(cyclic).self, '[circular]');
  assert.equal(
    Object.keys(
      boundScenarioFailureValue(
        Object.fromEntries(
          Array.from({ length: 30 }, (_, index) => [`key${index}`, index]),
        ),
      ),
    ).length,
    20,
  );
});

test('scenario failure capture keeps the original assertion on collector errors and timeouts', async () => {
  const original = new Error('original assertion');
  const lines = [];
  await assert.rejects(
    captureScenarioFailure(
      original,
      'dispatch-pipeline',
      () => {
        throw new Error('collector broke');
      },
      { write: (line) => lines.push(line) },
    ),
    (error) => error === original,
  );
  await assert.rejects(
    captureScenarioFailure(
      original,
      'dispatch-pipeline',
      () => new Promise(() => undefined),
      { timeoutMs: 5, write: (line) => lines.push(line) },
    ),
    (error) => error === original,
  );
  assert.match(lines[0], /"collection":"failed"/);
  assert.match(lines[1], /"collection":"timed-out"/);
  await assert.rejects(
    captureScenarioFailure(
      original,
      'dispatch-pipeline',
      () => ({ modalOpen: true }),
      {
        write: () => {
          throw new Error('writer failed');
        },
      },
    ),
    (error) => error === original,
  );
});

test('release-like mode rejects scenarios that require E2E-only provider mocks', () => {
  assert.throws(
    () => assertReleaseLikeScenarioSupported('transcript-streaming-tail', true),
    /cannot run in release-like mode.*E2E-only provider mocks/i,
  );
  assert.throws(
    () =>
      assertReleaseLikeScenarioSupported('transcript-active-turn-tools', true),
    /cannot run in release-like mode.*E2E-only provider mocks/i,
  );
  assert.throws(
    () =>
      assertReleaseLikeScenarioSupported(
        'multi-chat-streaming-sequential',
        true,
      ),
    /cannot run in release-like mode.*E2E-only provider mocks/i,
  );
  for (const name of ['background-streaming', 'chat-switch-catch-up']) {
    assert.throws(
      () => assertReleaseLikeScenarioSupported(name, true),
      /cannot run in release-like mode.*E2E-only provider mocks/i,
      name,
    );
  }
  assert.throws(
    () =>
      assertReleaseLikeScenarioSupported(
        'managed-delegation-concurrency',
        true,
      ),
    /cannot run in release-like mode.*E2E-only provider mocks/i,
  );
  assert.throws(
    () => assertReleaseLikeScenarioSupported('chat-search-indexing', true),
    /cannot run in release-like mode.*E2E-only chat-event ingress/i,
  );
  assert.throws(
    () => assertReleaseLikeScenarioSupported('code-graph-small-edit', true),
    /cannot run in release-like mode.*Code Graph performance scheduler/i,
  );
  assert.doesNotThrow(() =>
    assertReleaseLikeScenarioSupported('stress-transcript', true),
  );
  assert.doesNotThrow(() =>
    assertReleaseLikeScenarioSupported('transcript-streaming-tail', false),
  );
});

test('release-like mode refuses the skill suggestion backfill seam', () => {
  assert.throws(
    () =>
      assertReleaseLikeScenarioSupported('skill-suggestions-backfill', true),
    /cannot run in release-like mode.*E2E-only hooks/i,
  );
});

test('release-like mode runs the Ledger panel but not its E2E-only idle check', () => {
  assert.throws(
    () => assertReleaseLikeScenarioSupported('ledger-disabled-idle', true),
    /cannot run in release-like mode.*E2E-only hooks/i,
  );
  assert.doesNotThrow(() =>
    assertReleaseLikeScenarioSupported('ledger-panel', true),
  );
});

test('the Ledger budgets stay the targets recorded before measuring', () => {
  // docs/desktop-app-performance.md records these; a miss is fixed or taken
  // back to the user, never met by loosening the budget.
  assert.deepEqual(LEDGER_ROUND_TRIP_BUDGETS_MS, {
    firstPageP95: 200,
    searchP95: 200,
    localCommitP95: 100,
    feedFirstPageP95: 200,
  });
  assert(Object.isFrozen(LEDGER_ROUND_TRIP_BUDGETS_MS));
});

test('the Ledger fixture is first used under the account the app will hold', () => {
  // An E2E build keeps guest mode off, so the app stays signed out.
  assert.equal(ledgerFixtureAccountId(false), null);
  // A production build mints the mock cloud's guest account at launch.
  assert.equal(ledgerFixtureAccountId(true), MOCK_GUEST_ACCOUNT_ID);
  assert.equal(typeof MOCK_GUEST_ACCOUNT_ID, 'string');
});

test('the Ledger scenario says up front when the build leaves the Ledger off', () => {
  assert.equal(
    ledgerUnavailableReason({ status: 'ok', value: { entries: [] } }, true),
    null,
  );
  const off = { status: 'unavailable', reason: 'disabled' };
  // A production build ignores the E2E flag override.
  assert.match(
    ledgerUnavailableReason(off, true),
    /Ledger is off in this production build.*LaunchDarkly/,
  );
  assert.match(
    ledgerUnavailableReason(off, false),
    /Ledger is off.*canopy-ledger-enabled/,
  );
  assert.match(
    ledgerUnavailableReason(
      { status: 'error', reason: 'STORAGE_UNAVAILABLE', message: 'x' },
      false,
    ),
    /could not be read: error STORAGE_UNAVAILABLE/,
  );
  assert.match(
    ledgerUnavailableReason(undefined, false),
    /could not be read: no result/,
  );
});

test('scenario data roots use the system temp directory unless a short absolute parent is pinned', () => {
  assert.equal(performanceDataRootParent({}), os.tmpdir());
  assert.equal(
    performanceDataRootParent({ CANOPY_PERFORMANCE_DATA_ROOT_PARENT: '' }),
    os.tmpdir(),
  );
  assert.equal(
    performanceDataRootParent({ CANOPY_PERFORMANCE_DATA_ROOT_PARENT: '/tmp' }),
    '/tmp',
  );
  assert.throws(
    () =>
      performanceDataRootParent({
        CANOPY_PERFORMANCE_DATA_ROOT_PARENT: 'tmp',
      }),
    /must be an absolute directory/,
  );
});

test('scenarios launch with the client flags the caller pinned, under their own', () => {
  assert.equal(scenarioClientFeatureFlags('startup-settle', {}), null);
  assert.deepEqual(scenarioClientFeatureFlags('ledger-panel', {}), {
    'canopy-ledger-enabled': true,
  });
  assert.deepEqual(scenarioClientFeatureFlags('ledger-disabled-idle', {}), {
    'canopy-ledger-enabled': false,
  });

  // A matched flag-off/flag-on comparison pins the Ledger for every scenario.
  const ledgerOn = {
    CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
      'canopy-ledger-enabled': true,
      'canopy-portal-enabled': false,
    }),
  };
  assert.deepEqual(scenarioClientFeatureFlags('loaded-ui', ledgerOn), {
    'canopy-ledger-enabled': true,
    'canopy-portal-enabled': false,
  });
  // The Ledger scenarios keep their own Ledger flag.
  assert.deepEqual(
    scenarioClientFeatureFlags('ledger-disabled-idle', ledgerOn),
    {
      'canopy-ledger-enabled': false,
      'canopy-portal-enabled': false,
    },
  );
  assert.equal(
    scenarioClientFeatureFlags('loaded-ui', {
      CANOPY_E2E_CLIENT_FEATURE_FLAGS: '  ',
    }),
    null,
  );

  for (const raw of ['not json', '[true]', 'null', '7']) {
    assert.throws(
      () =>
        scenarioClientFeatureFlags('loaded-ui', {
          CANOPY_E2E_CLIENT_FEATURE_FLAGS: raw,
        }),
      /CANOPY_E2E_CLIENT_FEATURE_FLAGS must be a JSON object/,
    );
  }
});

test('release-like roots cannot select a foreign bundle for an E2E-relative run', () => {
  assert.throws(
    () => assertReleaseLikeRootSupported(false, '/tmp/frozen-root'),
    /release-like root requires release-like mode/i,
  );
  assert.doesNotThrow(() =>
    assertReleaseLikeRootSupported(true, '/tmp/frozen-root'),
  );
  assert.doesNotThrow(() => assertReleaseLikeRootSupported(false, ''));
});

test('each build kind launches the checkout its own root option names', () => {
  assert.equal(measuredBuildRootOption({}), undefined);
  assert.equal(measuredBuildRootOption({ e2eRoot: '/e2e' }), '/e2e');
  assert.equal(
    measuredBuildRootOption({ releaseLike: true, releaseLikeRoot: '/prod' }),
    '/prod',
  );
  // A root for the other build kind is never launched.
  assert.equal(
    measuredBuildRootOption({ releaseLike: true, e2eRoot: '/e2e' }),
    undefined,
  );
  assert.equal(
    measuredBuildRootOption({ releaseLikeRoot: '/prod', e2eRoot: '' }),
    undefined,
  );
  assert.throws(
    () => assertE2eRootSupported(true, '/e2e'),
    /E2E root cannot be used in release-like mode/,
  );
  assert.doesNotThrow(() => assertE2eRootSupported(false, '/e2e'));
  assert.doesNotThrow(() => assertE2eRootSupported(true, ''));
});

test('tool-active transcript scenario advances from tools to its final step', () => {
  const marker = 'Canopy-CTRANSCRIPTTOOLACTIVETURN';
  const conversation = buildTranscriptToolActiveTurnConversation(marker, 24);
  const scenario = { llm: conversation };
  const userText = `[${marker}] [Canopy-Mock-Request:tool-active-turn] run`;

  const initial = resolveCannedStep({
    userText,
    systemText: '',
    assistantTurns: 0,
    assistantTurnsAfterRequestTag: 0,
    scenario,
  });
  const completed = resolveCannedStep({
    userText,
    systemText: '',
    assistantTurns: 1,
    assistantTurnsAfterRequestTag: 1,
    scenario,
  });

  assert.equal(initial.step.stopReason, 'tool_use');
  assert.equal(initial.step.toolCalls.length, 24);
  assert.equal(completed.step.stopReason, 'end_turn');
  assert.equal(completed.step.text, `${marker} complete.`);
});

test('stopped transcript fence waits beyond the controlled stream completion', () => {
  assert.ok(transcriptStopFenceWaitMs(2_000) > 2_000);
  assert.equal(transcriptStopFenceWaitMs(2_000), 2_250);
});

test('tail and history transcript streams share a tool-bearing late-result schedule', () => {
  const marker = 'Canopy-CTRANSCRIPTSTREAMINGHISTORY';
  const conversation = buildTranscriptStreamConversation(marker, 'Final text', {
    transcriptStreamMs: 2_000,
    transcriptStreamChunkCharacters: 32,
  });
  const scenario = { llm: conversation };
  const userText = `[${marker}] run`;

  const toolStep = resolveCannedStep({
    userText,
    systemText: '',
    assistantTurns: 0,
    scenario,
  });
  const finalStep = resolveCannedStep({
    userText,
    systemText: '',
    assistantTurns: 1,
    scenario,
  });

  assert.equal(toolStep.step.stopReason, 'tool_use');
  assert.equal(toolStep.step.toolCalls.length, 2);
  assert.equal(finalStep.step.stopReason, 'end_turn');
  assert.equal(finalStep.step.text, 'Final text');
  assert.equal(finalStep.step.streamMs, 2_000);
  assert.equal(finalStep.step.chunkChars, 32);
});

test('the transcript accumulator projects stage runs, work units, and counters but no timings', () => {
  const flat = projectTranscriptWork({
    stages: {
      turn_grouping: {
        count: 2,
        totalMs: 15,
        maxMs: 11,
        work: { messages: 100, groups: 10 },
      },
      resize_observer: {
        count: 3,
        totalMs: 1,
        maxMs: 1,
        work: { pinned: 1, collapsed: Number.NaN },
      },
    },
    counters: { canonical_changes: 4, loaded_bytes: 8_000, broken: Infinity },
    correlations: [{ id: 'ignored', elapsedMs: 3, work: { changes: 1 } }],
  });

  assert.deepEqual(flat, {
    'turn_grouping.count': 2,
    'turn_grouping.work.messages': 100,
    'turn_grouping.work.groups': 10,
    'resize_observer.count': 3,
    'resize_observer.work.pinned': 1,
    'counters.canonical_changes': 4,
    'counters.loaded_bytes': 8_000,
  });
  assert.deepEqual(projectTranscriptWork(null), {});
});

test('a work bracket records the signed change of every observed counter for each source', () => {
  const work = bracketWork(
    {
      transcript: {
        stages: {
          turn_grouping: {
            count: 1,
            totalMs: 5,
            maxMs: 5,
            work: { messages: 40 },
          },
        },
        counters: {
          loaded_message_rows: 40,
          mounted_turn_groups: 5,
          page_installs: 1,
        },
      },
      chromium: {
        LayoutCount: 10,
        RecalcStyleCount: 20,
        Nodes: 500,
        JSEventListeners: 30,
        Documents: 1,
        Frames: 1,
      },
      errors: [],
    },
    {
      transcript: {
        stages: {
          turn_grouping: {
            count: 3,
            totalMs: 9,
            maxMs: 5,
            work: { messages: 120 },
          },
          page_install: {
            count: 1,
            totalMs: 2,
            maxMs: 2,
            work: { pageRows: 20 },
          },
        },
        counters: {
          loaded_message_rows: 20,
          mounted_turn_groups: 5,
          page_installs: 2,
        },
      },
      chromium: {
        LayoutCount: 14,
        RecalcStyleCount: 20,
        Nodes: 450,
        JSEventListeners: 30,
        Documents: 1,
        Frames: 1,
      },
      errors: [],
    },
  );

  // Unchanged counters stay as explicit zeros; timings never become work.
  assert.deepEqual(work, {
    transcript: {
      'counters.loaded_message_rows': -20,
      'counters.mounted_turn_groups': 0,
      'counters.page_installs': 1,
      'page_install.count': 1,
      'page_install.work.pageRows': 20,
      'turn_grouping.count': 2,
      'turn_grouping.work.messages': 80,
    },
    chromium: {
      Documents: 0,
      Frames: 0,
      JSEventListeners: 0,
      LayoutCount: 4,
      Nodes: -50,
      RecalcStyleCount: 0,
    },
  });
});

test('a work bracket keeps sampling errors and omits a source missing from either end', () => {
  const error = {
    source: 'chromium',
    message: 'Performance.getMetrics: timed out after 5000ms',
  };
  assert.deepEqual(
    bracketWork(
      { transcript: { stages: {}, counters: {} }, errors: [error] },
      {
        transcript: { stages: {}, counters: { page_installs: 1 } },
        chromium: { LayoutCount: 2 },
        errors: [],
      },
    ),
    { transcript: { 'counters.page_installs': 1 }, errors: [error] },
  );
});

test('a work bracket diffs app counters and rejects a bracket that spans a reset', () => {
  const main = (generation, ipc) => ({ generation, counters: ipc });
  const work = bracketWork(
    {
      ipc: main(1, { 'invoke.chat:load-tabs': 1 }),
      chatStorage: main(1, { commits: 2, 'syncs.file': 10 }),
      provider: main(1, { eventsIngested: 2 }),
      react: main('page-a:1', { commits: 4, performedWorkFibers: 40 }),
      errors: [],
    },
    {
      ipc: main(1, {
        'invoke.chat:load-tabs': 1,
        'send.chat:event.main.messages': 3,
      }),
      chatStorage: main(1, { commits: 3, 'syncs.file': 15 }),
      provider: main(1, { eventsIngested: 3 }),
      // The page reloaded: its counts restarted, so the change is unknown.
      react: main('page-b:0', { commits: 1, performedWorkFibers: 12 }),
      errors: [],
    },
  );

  assert.deepEqual(work, {
    ipc: { 'invoke.chat:load-tabs': 0, 'send.chat:event.main.messages': 3 },
    chatStorage: { commits: 1, 'syncs.file': 5 },
    provider: { eventsIngested: 1 },
    errors: [
      {
        source: 'react',
        message: 'counters were reset between samples',
      },
    ],
  });
});

test('scenario work includes each app source the window collected without errors', () => {
  const appWork = {
    ipc: { 'send.chat:event.main.messages': 6 },
    chatStorage: { commits: 3 },
    provider: { eventsIngested: 3 },
    react: { commits: 5, performedWorkFibers: 80 },
  };
  assert.deepEqual(
    scenarioWorkCounters({ chromiumWork: {}, appWork, workErrors: [] }, []),
    { transcript: {}, chromium: {}, ...appWork },
  );
  assert.deepEqual(
    scenarioWorkCounters(
      {
        appWork: { ipc: appWork.ipc },
        workErrors: [
          { source: 'chatStorage', message: 'reset: not installed' },
          { source: 'provider', message: 'reset: not installed' },
        ],
      },
      [
        {
          kind: 'open',
          status: 'ok',
          work: {
            errors: [{ source: 'react', message: 'snapshot: timed out' }],
          },
        },
      ],
    ),
    {
      transcript: {},
      ipc: appWork.ipc,
      errors: [
        { source: 'chatStorage', message: 'reset: not installed' },
        { source: 'provider', message: 'reset: not installed' },
        { source: 'react', message: 'snapshot: timed out', task: 'open' },
      ],
    },
  );
});

test('scenario work carries the routed-read evidence without making it a work metric', () => {
  const routeWork = { 'files.roots.daemon': 1, 'files.roots.daemon.served': 1 };
  const scenario = {
    name: 'file-explorer',
    status: 'ok',
    tasks: [{ kind: 'open_file_explorer', status: 'ok', work: {} }],
    work: scenarioWorkCounters(
      { appWork: { ipc: { 'invoke.file-tree:roots': 1 } }, routeWork },
      [],
    ),
  };
  assert.deepEqual(scenario.work, {
    transcript: {},
    ipc: { 'invoke.file-tree:roots': 1 },
    route: routeWork,
  });
  // A build without route counters, or a window that lost them, adds nothing.
  assert.equal(
    Object.hasOwn(scenarioWorkCounters({ appWork: {} }, []), 'route'),
    false,
  );
  const metricKeys = Object.keys(buildScenarioMetrics(scenario));
  assert.ok(
    metricKeys.includes('file-explorer.work.ipc.invoke.file-tree:roots'),
  );
  assert.deepEqual(
    metricKeys.filter(
      (key) => key.includes('.route.') || key.includes('files.'),
    ),
    [],
  );
});

test('scenario work covers the measured window and drops sources with any sampling error', () => {
  const summary = {
    transcriptStages: {
      turn_grouping: {
        count: 3,
        totalMs: 20,
        maxMs: 9,
        work: { messages: 120, groups: 0 },
      },
    },
    transcriptCounters: { page_installs: 2 },
    chromiumWork: { LayoutCount: 30, Nodes: -4 },
    workErrors: [],
  };
  assert.deepEqual(
    scenarioWorkCounters(summary, [
      { kind: 'open', status: 'ok', work: { transcript: {}, chromium: {} } },
    ]),
    {
      transcript: {
        'counters.page_installs': 2,
        'turn_grouping.count': 3,
        'turn_grouping.work.groups': 0,
        'turn_grouping.work.messages': 120,
      },
      chromium: { LayoutCount: 30, Nodes: -4 },
    },
  );

  const failed = scenarioWorkCounters(
    {
      ...summary,
      workErrors: [
        { source: 'chromium', message: 'Performance.enable failed' },
        { source: 'cleanup', message: 'detach: Error: gone' },
      ],
    },
    [
      {
        kind: 'open',
        status: 'ok',
        work: {
          transcript: {},
          errors: [{ source: 'transcript', message: 'accumulator missing' }],
        },
      },
    ],
  );
  assert.deepEqual(failed, {
    errors: [
      { source: 'chromium', message: 'Performance.enable failed' },
      { source: 'cleanup', message: 'detach: Error: gone' },
      { source: 'transcript', message: 'accumulator missing', task: 'open' },
    ],
  });
  // A cleanup-only error is reported without discarding collected counts.
  assert.deepEqual(
    Object.keys(
      scenarioWorkCounters(
        {
          ...summary,
          workErrors: [{ source: 'cleanup', message: 'detach: Error: gone' }],
        },
        [],
      ),
    ),
    ['transcript', 'chromium', 'errors'],
  );
});

test('task work brackets sample outside the timed window and keep the recorded task last', async () => {
  const tasks = [];
  const samples = [
    { transcript: { stages: {}, counters: {} }, chromium: { LayoutCount: 10 } },
    {
      transcript: { stages: {}, counters: { page_installs: 1 } },
      chromium: { LayoutCount: 13 },
    },
  ];
  let sampleCalls = 0;
  Object.defineProperty(tasks, 'workSample', {
    value: async () => {
      sampleCalls += 1;
      await delay(200);
      return { ...samples.shift(), errors: [] };
    },
  });

  const value = await recordResponsiveTask(
    tasks,
    'open_chat',
    async () => 'done',
    { iteration: 1 },
    5_000,
  );

  assert.equal(value, 'done');
  assert.equal(sampleCalls, 2);
  assert.equal(tasks.length, 1);
  assert.equal(tasks.at(-1).status, 'ok');
  assert.equal(tasks.at(-1).iteration, 1);
  assert.ok(tasks[0].durationMs < 150, `duration ${tasks[0].durationMs}`);
  assert.deepEqual(tasks[0].work, {
    transcript: { 'counters.page_installs': 1 },
    chromium: { LayoutCount: 3 },
  });
});

test('failed task operations and unsampled tasks record no work bracket', async () => {
  const tasks = [];
  let sampleCalls = 0;
  Object.defineProperty(tasks, 'workSample', {
    value: async () => {
      sampleCalls += 1;
      return { transcript: { stages: {}, counters: {} }, errors: [] };
    },
  });
  await assert.rejects(
    recordTask(tasks, 'open_chat', async () => {
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.equal(sampleCalls, 1);
  assert.equal(tasks[0].status, 'error');
  assert.equal('work' in tasks[0], false);

  const unsampled = [];
  await recordTask(unsampled, 'navigate', async () => undefined);
  assert.equal(unsampled[0].status, 'ok');
  assert.equal('work' in unsampled[0], false);
});

test('search indexing keeps large workloads within the canonical per-row limit', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'search-row-budget-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = prepareChatSearchIndexing(root, {
    chatSearchIndexBodyBytes: 17_000_000,
  });
  const file = JSON.parse(
    readFileSync(
      path.join(
        root,
        'workspaces',
        'demo-ts-pnpm-vite',
        'chats',
        'demo-main.json',
      ),
      'utf8',
    ),
  );
  const rows = file.tabs.find((tab) => tab.id === fixture.largeChatId).messages;
  assert.ok(
    rows.every(
      (row) => Buffer.byteLength(JSON.stringify(row)) < 16 * 1024 * 1024,
    ),
  );
  const text = rows.map((row) => row.blocks[0].text).join('');
  assert.equal(Buffer.byteLength(text), fixture.bodyBytes);
  assert.ok(text.endsWith(fixture.initialNeedle));
});

test('plugin picker durability checks use the native index after transcript migration', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'plugin-index-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const legacy = path.join(root, 'chats', 'worktree.json');
  const native = path.join(
    root,
    'chat-storage-v2',
    'worktree',
    'live-index.json',
  );
  const selections = {
    pluginRefs: [{ marketplaceId: 'local', name: 'example' }],
  };
  mkdirSync(path.dirname(native), { recursive: true });
  writeFileSync(
    native,
    JSON.stringify({
      tabs: [{ id: 'plugin-picker-chat', pluginSelections: selections }],
    }),
  );
  assert.equal(resolvePluginPickerChatIndex(legacy), native);
  assert.deepEqual(readPluginPickerSelections(legacy), selections);
});

test('plugin picker durability checks remain compatible with legacy baselines', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'plugin-legacy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const legacy = path.join(root, 'chats', 'worktree.json');
  mkdirSync(path.dirname(legacy), { recursive: true });
  writeFileSync(
    legacy,
    JSON.stringify({
      tabs: [
        { id: 'plugin-picker-chat', pluginSelections: { pluginRefs: [] } },
      ],
    }),
  );
  assert.equal(resolvePluginPickerChatIndex(legacy), legacy);
  assert.deepEqual(readPluginPickerSelections(legacy), { pluginRefs: [] });
});

test('performance workspaces seed a deterministic empty plugin cache', (t) => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-perf-plugin-cache-'),
  );
  t.after(() => rmSync(userDataDir, { recursive: true, force: true }));

  seedWorkspace(userDataDir);

  const cache = JSON.parse(
    readFileSync(path.join(userDataDir, 'plugins-cache.json'), 'utf8'),
  );
  assert.equal(cache.version, 2);
  assert.equal(typeof cache.lastRefreshed, 'string');
  assert.notEqual(cache.lastRefreshed, '');
  assert.equal(typeof cache.lastProviderRefreshAt, 'string');
  assert.deepEqual(cache.marketplaces, []);
});

test('transcript stream fixtures seed the workspace before launch', (t) => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-perf-transcript-workspace-'),
  );
  t.after(() => rmSync(userDataDir, { recursive: true, force: true }));

  prepareTranscriptStreamWorkspace(userDataDir);

  assert.ok(existsSync(path.join(userDataDir, 'workspaces', 'index.json')));
  assert.ok(existsSync(path.join(userDataDir, 'plugins-cache.json')));
});

test('transient item draining waits for a stable empty interval', async () => {
  const counts = [2, 1, 0, 2, 1, 0, 0, 0];
  let dismissals = 0;
  let nowMs = 0;

  const result = await drainTransientItems({
    count: async () => counts.shift() ?? 0,
    dismissFirst: async () => {
      dismissals += 1;
    },
    now: () => nowMs,
    pause: async (delayMs) => {
      nowMs += delayMs;
    },
    timeoutMs: 2_000,
    pollIntervalMs: 100,
    stableEmptyMs: 200,
  });

  assert.equal(result, 4);
  assert.equal(dismissals, 4);
  assert.ok(nowMs >= 200);
});

test('a completed provider request proves a fast later turn activated', () => {
  assert.equal(
    laterTurnActivationObserved({
      activeTurnCount: 0,
      requestCount: 2,
      requestsBeforeTurn: 1,
    }),
    true,
  );
  assert.equal(
    laterTurnActivationObserved({
      activeTurnCount: 0,
      requestCount: 1,
      requestsBeforeTurn: 1,
    }),
    false,
  );
});

test('provider request waits cover the configured stream plus queue drain', () => {
  assert.equal(providerRequestWaitTimeoutMs({ chatStreamMs: 30_000 }), 150_000);
});

test('worktree setup selection waits beyond a configured setup hold', () => {
  assert.equal(
    worktreeSetupSelectionTimeoutMs({ scriptHoldMs: 30_000 }),
    90_000,
  );
});

test('power-user idle shape preserves counts while bounding disk-heavy content', () => {
  const shape = powerUserIdleShape({
    powerUserWorkspaces: 25,
    powerUserWorktrees: 45,
    powerUserRepositories: 8,
    powerUserCoworkWorkspaces: 3,
    powerUserCoworkEntries: 17,
    powerUserChatTabs: 560,
    powerUserMessages: 100_000,
    powerUserPipelineExecutions: 482,
    powerUserPanelLayouts: 47,
    powerUserFiredWatchers: 1_108,
    powerUserAutomations: 34,
    powerUserAutomationRuns: 42,
    powerUserGraphFilesPerRepo: 600,
  });

  assert.equal(shape.chatContainerCount, 175);
  assert.equal(
    shape.chatTabsPerContainer.reduce((sum, count) => sum + count, 0) +
      shape.advisorChatTabCount,
    560,
  );
  assert.equal(
    shape.messagesPerTab.reduce((sum, count) => sum + count, 0) +
      shape.advisorMessagesPerTab.reduce((sum, count) => sum + count, 0),
    100_000,
  );
  assert.equal(shape.sourceBackedWorkspaceCount, 22);
  assert.equal(shape.coworkWorkspaceCount, 3);
  assert.equal(shape.visibleCoworkEntryCount, 17);
  assert.equal(shape.retainedChatContainerCount, 113);
  assert.equal(shape.panelLayoutCount, 47);
  assert.equal(shape.firedWatcherCount, 1_108);
  assert.equal(shape.automationCount, 34);
  assert.equal(shape.automationRunCount, 42);
  assert.equal(shape.graphSourceFileCount, 4_800);
});

test('power-user fixture writes exactly the configured pipeline history', () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-power-user-fixture-test-'),
  );
  const config = {
    ...PERFORMANCE_PROFILES.smoke,
    loadedChatTabs: 1,
    loadedTurnsPerChat: 1,
    loadedPipelineExecutions: 2,
    powerUserWorkspaces: 4,
    powerUserWorktrees: 3,
    powerUserRepositories: 1,
    powerUserCoworkWorkspaces: 1,
    powerUserCoworkEntries: 1,
    powerUserChatTabs: 4,
    powerUserMessages: 4,
    powerUserPipelineExecutions: 3,
    powerUserPipelineTotalBytes: 10_000,
    powerUserPanelLayouts: 1,
    powerUserFiredWatchers: 1,
    powerUserAutomations: 1,
    powerUserAutomationRuns: 1,
    powerUserGraphFilesPerRepo: 10,
  };

  try {
    const fixture = preparePowerUserIdle(userDataDir, config);
    const executionFiles = readdirSync(
      path.join(userDataDir, 'pipeline-executions'),
    ).filter((file) => file.endsWith('.json'));
    const chatFiles = [];
    for (const workspaceId of readdirSync(
      path.join(userDataDir, 'workspaces'),
    )) {
      const chatsDir = path.join(
        userDataDir,
        'workspaces',
        workspaceId,
        'chats',
      );
      if (!existsSync(chatsDir)) continue;
      for (const filename of readdirSync(chatsDir)) {
        if (filename.endsWith('.json')) {
          chatFiles.push(path.join(chatsDir, filename));
        }
      }
    }
    chatFiles.push(
      path.join(
        userDataDir,
        'app-workspaces',
        'app-advisor',
        'chats',
        'global.json',
      ),
    );
    const chats = chatFiles.map((filePath) =>
      JSON.parse(readFileSync(filePath, 'utf8')),
    );
    const realizedTabs = chats.flatMap((chat) => chat.tabs);
    const realizedMessages = realizedTabs.flatMap((tab) => tab.messages);

    assert.equal(fixture.pipeline.stateFiles, 3);
    assert.equal(executionFiles.length, fixture.pipeline.stateFiles);
    assert.equal(chatFiles.length, fixture.shape.chatContainerCount);
    assert.equal(realizedTabs.length, config.powerUserChatTabs);
    assert.equal(realizedMessages.length, config.powerUserMessages);
    const coworkWorkspace = JSON.parse(
      readFileSync(
        path.join(
          userDataDir,
          'workspaces',
          'cowork-default',
          'workspace.json',
        ),
        'utf8',
      ),
    );
    assert.equal('repos' in coworkWorkspace, false);
    assert.equal(
      existsSync(
        path.join(userDataDir, 'pipelines', 'performance-multi-review.yaml'),
      ),
      true,
    );
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
  }
});

test('Default cowork performance summaries match their transcript revisions', () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-perf-cowork-summary-'),
  );
  try {
    const fixture = prepareDefaultCoworkWorkspace(
      userDataDir,
      {
        coworkDefaultShortMessages: 1,
        coworkDefaultShortMessageBytes: 512,
        coworkDefaultLongMessages: 1,
        coworkDefaultLongMessageBytes: 512,
        coworkDefaultPipelineMessages: 1,
        coworkDefaultPipelineMessageBytes: 512,
      },
      1,
    );
    const entryId = fixture.entryIds[0];
    const workspaceDir = path.join(userDataDir, 'workspaces', 'cowork-default');
    const registry = JSON.parse(
      readFileSync(path.join(workspaceDir, 'work-entries.json'), 'utf8'),
    );
    const transcriptStats = statSync(
      path.join(workspaceDir, 'chats', `${entryId}.json`),
      { bigint: true },
    );

    assert.equal(
      registry.entries[0].summary.sourceMtimeNs,
      transcriptStats.mtimeNs.toString(),
    );
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('Home cold-history fixture leaves all legacy summaries unresolved', () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-perf-home-cold-'),
  );
  try {
    const fixture = prepareHomeCoworkLegacy(userDataDir, {
      coworkDefaultShortMessages: 1,
      coworkDefaultShortMessageBytes: 512,
      coworkDefaultLongMessages: 2,
      coworkDefaultLongMessageBytes: 512,
      coworkDefaultPipelineMessages: 1,
      coworkDefaultPipelineMessageBytes: 512,
    });
    const registry = JSON.parse(
      readFileSync(
        path.join(fixture.workspaceDir, 'work-entries.json'),
        'utf8',
      ),
    );
    assert.equal(registry.entries.length, 50);
    assert.ok(registry.entries.every((entry) => !entry.summary));
    assert.ok(
      fixture.entryIds.every((id) =>
        existsSync(path.join(fixture.workspaceDir, 'chats', `${id}.json`)),
      ),
    );
    assert.equal(
      existsSync(path.join(fixture.workspaceDir, 'chat-storage-manifests')),
      false,
    );
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('persisted assistant reply detection does not depend on rendered transcript rows', () => {
  const expected = 'Later foreground performance reply 1.';
  const tabs = [
    {
      messages: [
        {
          role: 'assistant',
          blocks: [{ type: 'text', text: 'Older virtualized reply.' }],
        },
      ],
    },
    {
      messages: [
        {
          role: 'user',
          blocks: [{ type: 'text', text: expected }],
        },
        {
          role: 'assistant',
          blocks: [{ type: 'text', text: `prefix ${expected} suffix` }],
        },
      ],
    },
  ];

  assert.equal(countPersistedAssistantReplies(tabs, expected), 1);
  assert.equal(countPersistedAssistantReplies(tabs, 'missing reply'), 0);
});

test('plugin picker DOM row count excludes virtualizer spacer rows', async () => {
  const dialog = {
    locator(selector) {
      assert.equal(selector, 'tbody tr[data-index]');
      return { count: async () => 17 };
    },
  };

  assert.equal(await pluginPickerDomRowCount(dialog), 17);
});

test('Browser partition handle parsing preserves distinct partition ownership', () => {
  const parsed = parseBrowserPartitionHandles(`
Canopy 123 user 10r REG 1,4 0 1 /tmp/Canopy (Internal)/Partitions/canopy-browser-canopy-goat/Cookies
Canopy 123 user 11r REG 1,4 0 2 /tmp/Canopy (Internal)/Partitions/canopy-browser-canopy-goat/Preferences
Canopy 124 user 12r REG 1,4 0 3 /tmp/Canopy (Internal)/Partitions/canopy-browser-canopy-yak/Preferences
`);
  assert.deepEqual(parsed, {
    handleCount: 3,
    partitionCount: 2,
    partitions: ['canopy-browser-canopy-goat', 'canopy-browser-canopy-yak'],
  });
});

test('Code Graph fixtures form a deterministic interconnected module ring', () => {
  const source = buildCodeGraphFixtureSource(3, 10);
  assert.match(source, /from '\.\/mod4'/);
  assert.match(source, /from '\.\/mod5'/);
  assert.match(source, /from '\.\/mod6'/);
  assert.match(source, /export function fn3_3/);
  assert.equal(source, buildCodeGraphFixtureSource(3, 10));
  assert.throws(
    () => buildCodeGraphFixtureSource(10, 10),
    /coordinates are invalid/,
  );
});

test('realistic startup topology concentrates sibling worktrees by repository', () => {
  assert.deepEqual(
    realisticStartupWorktreeDistribution(44, 8),
    [29, 5, 3, 2, 2, 1, 1, 1],
  );
  assert.equal(
    realisticStartupWorktreeDistribution(125, 9).reduce(
      (sum, count) => sum + count,
      0,
    ),
    125,
  );
  assert.throws(
    () => realisticStartupWorktreeDistribution(4, 8),
    /coordinates are invalid/,
  );
});

test('realistic startup requires Codex capability garbage collection to reach a terminal event', () => {
  const startupEventCounts = (codexEvents = {}) =>
    new Proxy(codexEvents, {
      get(target, event) {
        if (Reflect.has(target, event)) return Reflect.get(target, event);
        return String(event).startsWith('startup:codex-capability-gc:')
          ? undefined
          : 1;
      },
    });

  assert.deepEqual(
    missingRealisticStartupProcedureEvents(startupEventCounts()),
    [
      'startup:codex-capability-gc:requested',
      'startup:codex-capability-gc:{completed|failed}',
    ],
  );

  assert.deepEqual(
    missingRealisticStartupProcedureEvents(
      startupEventCounts({
        'startup:codex-capability-gc:requested': 1,
        'startup:codex-capability-gc:failed': 1,
      }),
    ),
    [],
  );

  assert.deepEqual(
    missingRealisticStartupProcedureEvents(
      startupEventCounts({
        'startup:codex-capability-gc:requested': 1,
        'startup:codex-capability-gc:completed': 1,
      }),
    ),
    [],
  );
});

test('Code Graph queue counters distinguish running from queued work', () => {
  assert.deepEqual(
    codeGraphQueueCounts({
      entries: [
        { status: 'running' },
        { status: 'running' },
        { status: 'queued' },
      ],
    }),
    { total: 3, running: 2, queued: 1 },
  );
  assert.deepEqual(codeGraphQueueCounts(null), {
    total: 0,
    running: 0,
    queued: 0,
  });
});

test('manual Code Graph overlap is confirmed once every request is admitted while builds overlap', () => {
  const requestedWorktreeIds = Array.from(
    { length: 9 },
    (_, index) => `graph-${index + 1}`,
  );
  // Each request's start fingerprint runs one at a time before its build is
  // queued, so on a quiet host the first builds finish before the last
  // request is admitted: all nine were admitted, two have finished, two run
  // and five wait.
  assert.equal(
    codeGraphManualOverlapConfirmed({
      counts: { total: 7, running: 2, queued: 5 },
      admittedWorktreeIds: requestedWorktreeIds,
      requestedWorktreeIds,
    }),
    true,
  );
  assert.equal(
    codeGraphManualOverlapConfirmed({
      counts: { total: 8, running: 2, queued: 6 },
      admittedWorktreeIds: requestedWorktreeIds.slice(0, 8),
      requestedWorktreeIds,
    }),
    false,
    'a request that has not entered the queue yet',
  );
  assert.equal(
    codeGraphManualOverlapConfirmed({
      counts: { total: 2, running: 2, queued: 0 },
      admittedWorktreeIds: requestedWorktreeIds,
      requestedWorktreeIds,
    }),
    false,
    'no queued build left to overlap the running ones',
  );
});

test('manual Code Graph builds drain the queue after their derived analysis', async () => {
  // A desktop worktree build answers when its graph is published, then its
  // worker keeps the queue slot while derived analysis finishes.
  const snapshots = [
    { total: 1, running: 1, queued: 0 },
    { total: 1, running: 1, queued: 0 },
    { total: 0, running: 0, queued: 0 },
  ];
  let reads = 0;
  const counts = await waitForCodeGraphQueueDrain(async () => {
    const current = snapshots[Math.min(reads, snapshots.length - 1)];
    reads += 1;
    return current;
  });

  assert.deepEqual(counts, { total: 0, running: 0, queued: 0 });
  assert.equal(reads, 3);
});

test('a Code Graph queue that never drains still fails', async () => {
  await assert.rejects(
    waitForCodeGraphQueueDrain(
      async () => ({ total: 1, running: 0, queued: 1 }),
      { timeoutMs: 50, intervalMs: 5 },
    ),
    /Code Graph queue retained 1 entries after all requests completed/,
  );
});

test('mixed-provider child streams finish before roots without shortening the requested load', async (t) => {
  const registrations = new Map();
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const { key, scenario } = JSON.parse(options.body);
    registrations.set(key, scenario);
    return Response.json({ ok: true, key });
  });
  const descriptors = ['claude', 'codex'].map((providerType) => ({
    id: providerType,
    providerType,
    marker: `root-${providerType}`,
    childMarker: `child-${providerType}`,
    usesSubagent: true,
  }));
  for (const config of Object.values(PERFORMANCE_PROFILES)) {
    await registerMixedProviderAgentScenarios(config, descriptors);
    for (const descriptor of descriptors) {
      const root = registrations.get(descriptor.marker).llm.steps.at(-1);
      const child = registrations.get(descriptor.childMarker).llm.steps[0];
      assert.ok(child.streamMs >= config.chatStreamMs);
      assert.ok(
        child.streamMs < root.streamMs,
        'Equal parent/child deadlines race a Claude continuation into the measurement',
      );
    }
  }
});

test('mixed-provider completion waits for every Codex child message', () => {
  const turns = { total: 0 };
  const events = {
    activeClaudeTaskCount: 0,
    codexChildAgentMessages: 1,
    codexChildAgentOrigins: { 'chat-1': true },
  };

  assert.equal(mixedProviderWorkCompleted(turns, events, 2), false);
  events.codexChildAgentMessages = 2;
  events.codexChildAgentOrigins['chat-2'] = true;
  assert.equal(mixedProviderWorkCompleted(turns, events, 2), true);
});

test('mixed-provider completion still waits for parent and Claude work', () => {
  const events = {
    activeClaudeTaskCount: 1,
    codexChildAgentMessages: 1,
    codexChildAgentOrigins: { 'chat-1': true },
  };

  assert.equal(mixedProviderWorkCompleted({ total: 0 }, events, 1), false);
  events.activeClaudeTaskCount = 0;
  assert.equal(mixedProviderWorkCompleted({ total: 1 }, events, 1), false);
  assert.equal(mixedProviderWorkCompleted({ total: 0 }, events, 1), true);
});

test('mixed-provider spawn guard accepts a native Codex subagent thread', () => {
  const events = {
    codexEventTypes: { 'turn.completed': 1 },
    codexSpawnStarted: 0,
    codexSubagentThreads: 0,
  };

  assert.equal(codexRootsCompletedWithoutSpawn(events, 1), true);
  events.codexSubagentThreads = 1;
  assert.equal(codexRootsCompletedWithoutSpawn(events, 1), false);
});

test('performance chat follow-up targets the panel represented by its tab', () => {
  assert.equal(
    panelIdFromTabTestId('panel-tab-performance-chat-1'),
    'performance-chat-1',
  );
  assert.throws(
    () => panelIdFromTabTestId('performance-chat-1'),
    /Invalid panel tab test id/,
  );
});

test('next-paint probes have a hard timeout', async () => {
  const page = {
    evaluate() {
      return new Promise(() => undefined);
    },
  };

  await assert.rejects(
    nextPaint(page, 5),
    /Timed out waiting 5ms for the renderer to paint/,
  );
});

test('next-paint probes preserve renderer evaluation failures', async () => {
  const failure = new Error('renderer unavailable');
  const page = {
    async evaluate() {
      throw failure;
    },
  };

  await assert.rejects(nextPaint(page, 5), (error) => error === failure);
});

test('successful next-paint probes cancel their timeout', async () => {
  const page = {
    async evaluate() {
      return undefined;
    },
  };

  const startedAt = Date.now();
  await nextPaint(page, 60_000);

  assert.ok(Date.now() - startedAt < 1_000);
});

test('worktree readiness rejects a rendered health warning', async () => {
  const healthWarning = {
    count: async () => 1,
    first: () => ({
      getAttribute: async () => 'Git setup failed',
    }),
  };
  const row = {
    isVisible: async () => true,
    getByRole: () => healthWarning,
  };

  assert.deepEqual(await readWorktreeSetupStatus(row), {
    ready: false,
    error: 'Git setup failed',
  });
});

test('worktree creation waits for the fixture rows before snapshotting existing worktrees', async () => {
  // The sidebar renders the project's worktrees after the main page opens.
  // A snapshot taken first would let the fixture row appear later and be
  // mistaken for the worktree the scenario creates.
  const snapshots = [[], [], ['demo-main']];
  let reads = 0;
  const initialIds = await readPreexistingWorktreeIds(async () => {
    const ids = snapshots[Math.min(reads, snapshots.length - 1)];
    reads += 1;
    return ids;
  });

  assert.deepEqual([...initialIds], ['demo-main']);
  assert.equal(reads, 3);
});

test('worktree row locators skip the hidden pinned copies of the selected row', () => {
  // The sidebar portals pinned copies of the selected worktree row
  // (`worktree-row-pin-top`, `worktree-row-pin-bottom`) ahead of the row in
  // the list. They carry the same data-worktree-id but stay hidden until the
  // row scrolls out of view, so they cannot be clicked or read as visible.
  const selectors = [];
  const page = {
    getByTestId(testId) {
      assert.equal(testId, 'app-sidebar');
      return {
        locator(selector) {
          selectors.push(selector);
          return { first: () => ({ selector }) };
        },
      };
    },
  };

  assert.deepEqual(sidebarWorktreeRow(page, 'dev-lynx'), {
    selector: '[data-testid="worktree-row"][data-worktree-id="dev-lynx"]',
  });
  assert.deepEqual(selectors, [
    '[data-testid="worktree-row"][data-worktree-id="dev-lynx"]',
  ]);
});

test('pipeline workloads require the requested peak concurrency', () => {
  assert.doesNotThrow(() => assertRequestedPipelineConcurrency(4, 4));
  assert.throws(
    () => assertRequestedPipelineConcurrency(3, 4),
    /reached 3 concurrent runs; expected 4/,
  );
});

test('pipeline workload mirrors a multi-review run without agent actions', () => {
  const pipeline = yaml.load(
    buildPerformancePipelineYaml({ pipelineHoldMs: 15_000 }),
  );
  const jobs = Object.values(pipeline.jobs);
  const steps = jobs.flatMap((job) => job.steps);
  const reviewerJobs = Object.entries(pipeline.jobs).filter(([id]) =>
    id.startsWith('synthetic_reviewer_'),
  );

  assert.equal(jobs.length, 18);
  assert.equal(steps.length, 44);
  assert.equal(reviewerJobs.length, PERFORMANCE_PIPELINE_REVIEWER_COUNT);
  assert.ok(
    PERFORMANCE_PIPELINE_OUTPUT_BYTES_PER_REVIEWER >= 900_000,
    'each reviewer should approximate a recent large review log',
  );
  assert.ok(steps.every((step) => typeof step.run === 'string'));
  assert.ok(steps.every((step) => step.uses === undefined));
  assert.ok(
    reviewerJobs.every(([, job]) => job.steps[0].run.startsWith('node -e')),
  );
});

test('large transcript fixtures model dense and rich persisted histories', () => {
  const dense = buildSyntheticTranscriptMessages({
    transcriptId: 'dense-fixture',
    messageCount: 12,
    messageBytes: 512,
    shape: 'dense',
  });
  const rich = buildSyntheticTranscriptMessages({
    transcriptId: 'rich-fixture',
    messageCount: 12,
    messageBytes: 1_024,
    shape: 'rich',
  });

  assert.equal(dense.length, 12);
  assert.equal(rich.length, 12);
  assert.ok(dense.every((message) => message.blocks.length === 1));
  assert.ok(
    rich.some((message) =>
      message.blocks.some((block) => block.type === 'tool_result'),
    ),
  );
  const richToolInputs = rich.flatMap((message) =>
    message.blocks
      .filter((block) => block.type === 'tool_use')
      .map((block) => block.input),
  );
  assert.ok(richToolInputs.length > 0);
  assert.ok(richToolInputs.every((input) => typeof input === 'string'));
  assert.deepEqual(JSON.parse(richToolInputs[0]), {
    file_path: 'synthetic/fixture-1.ts',
  });
  assert.ok(
    dense.some((message) =>
      message.blocks.some(
        (block) =>
          block.type === 'text' &&
          block.text.startsWith('## Synthetic transcript result'),
      ),
    ),
  );
  const transcriptText = [...dense, ...rich].flatMap((message) =>
    message.blocks
      .filter((block) => block.type === 'text')
      .map((block) => block.text),
  );
  const markdownText = transcriptText.filter((text) =>
    text.startsWith('## Synthetic transcript result'),
  );
  const plainText = transcriptText.filter(
    (text) => !text.startsWith('## Synthetic transcript result'),
  );
  assert.ok(markdownText.length > 0);
  assert.ok(plainText.length > 0);
  assert.ok(
    markdownText.some(
      (text) =>
        text.includes('> Profile renderer work with **semantic Markdown**.') &&
        text.includes('- [x] Preserve transcript behavior') &&
        text.includes('| Surface | Expected |') &&
        text.includes(
          '```ts\nconst benchmarkSection1 = {\n  surface: "transcript",\n  interaction: "copy-code",\n  status: "covered",\n};\n```',
        ) &&
        text.includes('[Open benchmark notes](https://example.com/perf)'),
    ),
  );
  const contentCounters = transcriptContentCounters([...dense, ...rich]);
  assert.ok(contentCounters.multiLineCodeBlocks > 0);
  assert.ok(
    contentCounters.multiLineCodeLines > contentCounters.multiLineCodeBlocks,
  );
  assert.ok(contentCounters.multiLineCodeBytes > 0);
  const allBlocks = [...dense, ...rich].flatMap((message) => message.blocks);
  assert.ok(allBlocks.some((block) => block.type === 'tool_use'));
  assert.ok(allBlocks.some((block) => block.type === 'tool_result'));
  assert.ok(
    Buffer.byteLength(JSON.stringify(rich)) >
      Buffer.byteLength(JSON.stringify(dense)),
  );
  assert.equal(new Set(rich.map((message) => message.id)).size, rich.length);
});

test('worktree Git-pending errors distinguish the start and end of the typing probe', () => {
  const ready = { gitFailed: {}, gitReadyIds: ['otter'] };
  assert.equal(
    worktreeGitPendingError(ready, 'otter', 'before'),
    'Worktree otter Git setup completed before its composer typing probe began',
  );
  assert.equal(
    worktreeGitPendingError(ready, 'otter', 'after'),
    'Worktree otter Git setup completed before its composer typing probe finished',
  );
  assert.equal(
    worktreeGitPendingError(
      { gitFailed: { otter: { error: 'boom' } }, gitReadyIds: [] },
      'otter',
      'before',
    ),
    'Worktree otter Git setup failed: boom',
  );
  assert.equal(
    worktreeGitPendingError(
      { gitFailed: {}, gitReadyIds: [] },
      'otter',
      'after',
    ),
    null,
  );
});

test('waitUntil stops at a FatalWaitError instead of retrying until the deadline', async () => {
  const startedAt = Date.now();
  let calls = 0;

  await assert.rejects(
    waitUntil(
      () => {
        calls += 1;
        throw new FatalWaitError('Git setup completed before overlap');
      },
      { timeoutMs: 5_000, label: 'overlap', intervalMs: 1 },
    ),
    /^FatalWaitError: Git setup completed before overlap$/,
  );
  assert.equal(calls, 1);
  assert.ok(Date.now() - startedAt < 1_000);
});

test('waitUntil enforces its deadline when a condition hangs', async () => {
  const startedAt = Date.now();

  await assert.rejects(
    waitUntil(() => new Promise(() => undefined), {
      timeoutMs: 10,
      label: 'hung condition',
      intervalMs: 1,
    }),
    /Timed out waiting for hung condition/,
  );
  assert.ok(Date.now() - startedAt < 1_000);
});

test('stress transcript has 25 oversized turns, mid-turn answers, and large final reports', async () => {
  const { buildStressTranscriptMessages } =
    await import('../electron/stress-transcript-fixture.mjs');
  const messages = buildStressTranscriptMessages();
  assert.equal(messages.length, 25 * 647);
  assert.equal(
    new Set(messages.map((message) => message.id)).size,
    messages.length,
  );
  for (let turn = 0; turn < 25; turn += 1) {
    const rows = messages.filter(
      (message) => message.codexTurnId === `stress-${turn}-agent-turn`,
    );
    assert.equal(rows.length, 647);
    const blocks = rows.flatMap((message) => message.blocks);
    assert.equal(
      blocks.filter((block) => block.type === 'tool_use').length,
      480,
    );
    assert.equal(
      blocks.filter((block) => block.asyncQuestionAnswer?.startsTurn === false)
        .length,
      3,
    );
    assert.ok(rows.at(-1).blocks[0].text.length >= 25_950);
    assert.match(rows.at(-1).blocks[0].text, /```typescript/);
  }
});

// ── Phase 05: scenarios, scaling inputs, and startup journeys ─────────────

const smokeStreaming = PERFORMANCE_PROFILES.smoke;

test('multi-chat streaming spreads five chats over five worktrees, alternating providers', () => {
  const chats = multiChatStreamingChats(smokeStreaming);
  assert.equal(chats.length, 5);
  assert.deepEqual(
    chats.map((chat) => chat.providerType),
    ['claude', 'codex', 'claude', 'codex', 'claude'],
  );
  assert.deepEqual(
    chats.map((chat) => chat.worktreeId),
    [
      'demo-main',
      'perf-existing-001',
      'perf-existing-002',
      'perf-existing-003',
      'perf-existing-004',
    ],
  );
  assert.equal(new Set(chats.map((chat) => chat.marker)).size, 5);
});

test('chat-switch catch-up uses distinct warm and never-selected cold Claude worktrees', () => {
  const plan = buildChatSwitchCatchUpPlan(smokeStreaming);
  assert.equal(plan.warmChat.key, 'chat-1');
  assert.equal(plan.coldChat.key, 'chat-3');
  assert.equal(plan.warmChat.providerType, 'claude');
  assert.equal(plan.coldChat.providerType, 'claude');
  assert.notEqual(plan.warmChat.worktreeId, plan.coldChat.worktreeId);
  assert.deepEqual(plan.warmHiddenStepIndexes, [1, 2, 3, 4]);
  assert.deepEqual(plan.coldHiddenStepIndexes, [0, 1, 2, 3]);
  assert.throws(
    () =>
      buildChatSwitchCatchUpPlan({
        ...smokeStreaming,
        multiChatStreamingChats: 3,
      }),
    /requires at least four stream chats/,
  );
  assert.throws(
    () =>
      buildChatSwitchCatchUpPlan({
        ...smokeStreaming,
        chatSwitchCatchUpEvents: 0,
      }),
    /chatSwitchCatchUpEvents must be a positive integer/,
  );
});

test('chat-switch catch-up plans with the prepared fixture chats and their gates', () => {
  const prepared = multiChatStreamingChats(smokeStreaming).map((chat) => ({
    ...chat,
    gateDir: `/runtime/gates/${chat.key}`,
    stepCount: 6,
  }));
  const plan = buildChatSwitchCatchUpPlan(smokeStreaming, prepared);
  assert.equal(plan.warmChat, prepared[0]);
  assert.equal(plan.coldChat, prepared[2]);
  assert.equal(plan.warmChat.gateDir, '/runtime/gates/chat-1');
  assert.equal(plan.coldChat.gateDir, '/runtime/gates/chat-3');
});

test('chat-switch counter summaries expose transcript-page invokes and estimated IPC bytes', () => {
  assert.deepEqual(
    chatSwitchTranscriptPageCounters({
      work: {
        ipc: {
          'invoke.chat:get-transcript-page': 1,
          'send.chat:state-changed.main.bytes': 512,
          'send.chat:state-changed.main.messages': 2,
          'send.other-channel.main.bytes': 64,
        },
      },
    }),
    {
      transcriptPageInvokes: 1,
      estimatedIpcSendBytes: 576,
      estimatedIpcSendBytesAvailable: true,
    },
  );
  assert.deepEqual(chatSwitchTranscriptPageCounters({}), {
    transcriptPageInvokes: 0,
    estimatedIpcSendBytes: 0,
    estimatedIpcSendBytesAvailable: false,
  });
});

test('a Claude streaming chat makes one gated tool call per step and some large reads', () => {
  const [chat] = multiChatStreamingChats(smokeStreaming);
  const { llm, stepCount, largeOutputSteps } = buildMultiChatClaudeConversation(
    {
      chat,
      config: smokeStreaming,
      gateScriptPath: '/tmp/gate.sh',
      gateDir: '/tmp/gates/chat-1',
      largeOutputPath: '/tmp/large-output.txt',
    },
  );
  // A tool call every ~300 ms over the script's duration.
  assert.equal(stepCount, multiChatClaudeStepCount(smokeStreaming));
  assert.equal(stepCount, Math.floor(20_000 / 300));
  // Longer scripts stop well short of Claude's 200-turn limit.
  assert.equal(
    multiChatClaudeStepCount({
      ...smokeStreaming,
      multiChatStreamingMs: 180_000,
    }),
    150,
  );
  assert.equal(llm.steps.length, stepCount + 1);
  assert.equal(
    largeOutputSteps.length,
    smokeStreaming.multiChatStreamingLargeOutputs,
  );
  for (const [index, step] of llm.steps.slice(0, -1).entries()) {
    const gate = step.toolCalls.at(-1);
    assert.equal(gate.name, 'Bash');
    assert.equal(
      gate.input.command,
      `sh '/tmp/gate.sh' '/tmp/gates/chat-1' ${index}`,
    );
    assert.equal(
      step.toolCalls.length,
      largeOutputSteps.includes(index) ? 2 : 1,
    );
  }
  // Every tool call of the turn has its own tool-use id, as a real model's do.
  const toolIds = llm.steps.flatMap((step) =>
    (step.toolCalls ?? []).map((call) => call.id),
  );
  assert.equal(new Set(toolIds).size, stepCount + largeOutputSteps.length);
  assert.ok(toolIds.every((id) => typeof id === 'string' && id.length > 0));
  assert.equal(llm.steps.at(-1).text, `${chat.marker} complete.`);
  // The mock serves step N after N assistant turns, whatever the variant.
  const userText = `[${chat.marker}] Stream the claude workload for ${chat.key}.`;
  for (const assistantTurns of [0, 7, stepCount]) {
    assert.equal(
      resolveCannedStep({
        userText,
        systemText: '',
        assistantTurns,
        scenario: { llm },
      }).step,
      llm.steps[assistantTurns],
    );
  }
});

/** Sends one Anthropic Messages request through the mock LLM route. */
async function mockAnthropicMessage(body) {
  const request = Readable.from([JSON.stringify(body)]);
  request.method = 'POST';
  request.headers = { 'content-type': 'application/json' };
  let text = '';
  const response = {
    writeHead() {},
    write(chunk) {
      text += chunk;
      return true;
    },
    end(chunk) {
      if (chunk) text += chunk;
    },
  };
  const handled = await handleLlmRequest(
    request,
    response,
    new URL('http://127.0.0.1/v1/messages'),
  );
  assert.equal(handled, true);
  return text;
}

test('the mock LLM keeps scripted tool-use ids and defaults the rest', async (t) => {
  const marker = 'Canopy-CTOOLIDS';
  registerMockScenario(marker, {
    llm: {
      steps: [
        {
          toolCalls: [
            { id: 'toolu_perf_turn_0', name: 'Bash', input: {} },
            { name: 'Read', input: {} },
          ],
          stopReason: 'tool_use',
        },
      ],
    },
  });
  t.after(() => clearScenario(marker));
  const messages = [{ role: 'user', content: `[${marker}] Run the tools.` }];

  const json = JSON.parse(
    await mockAnthropicMessage({ model: 'claude-test', messages }),
  );
  assert.deepEqual(
    json.content.map((block) => block.id),
    ['toolu_perf_turn_0', 'toolu_mock_1'],
  );

  const stream = await mockAnthropicMessage({
    model: 'claude-test',
    messages,
    stream: true,
  });
  const started = stream
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice('data: '.length)))
    .filter(
      (event) =>
        event.type === 'content_block_start' &&
        event.content_block.type === 'tool_use',
    )
    .map((event) => event.content_block.id);
  assert.deepEqual(started, ['toolu_perf_turn_0', 'toolu_mock_1']);
});

test('a Codex streaming chat replays a deterministic script around one long streamed command', () => {
  const chat = multiChatStreamingChats(smokeStreaming)[1];
  const build = () =>
    buildMultiChatCodexScript({
      chat,
      config: smokeStreaming,
      gateDir: '/tmp/gates/chat-2',
      cwd: '/tmp/worktree',
    });
  const script = build();
  assert.deepEqual(
    JSON.parse(JSON.stringify(build())),
    JSON.parse(JSON.stringify(script)),
  );
  const deltas = script.chunks.filter(
    (chunk) =>
      chunk.notifications[0].method === 'item/commandExecution/outputDelta',
  );
  assert.equal(
    deltas.length,
    smokeStreaming.multiChatStreamingCommandOutputDeltas,
  );
  for (const chunk of deltas) {
    assert.equal(
      Buffer.byteLength(chunk.notifications[0].params.delta),
      smokeStreaming.multiChatStreamingCommandOutputDeltaBytes,
    );
  }
  // The completed command output is above the 64 KiB inline limit.
  assert.ok(script.longCommandOutputBytes > 64 * 1024);
  const bracket = smokeStreaming.multiChatStreamingRatioBracketUpdates;
  const { early, late } = script.brackets;
  assert.equal(early[1] - early[0] + 1, bracket);
  assert.equal(late[1] - late[0] + 1, bracket);
  for (const index of [...early, ...late]) {
    assert.equal(
      script.chunks[index].notifications[0].method,
      'item/commandExecution/outputDelta',
    );
  }
  assert.ok(late[0] > early[1]);
  assert.deepEqual(
    script.chunks.at(-1).notifications.map((entry) => entry.method),
    [
      'item/started',
      'item/agentMessage/delta',
      'item/completed',
      'thread/tokenUsage/updated',
      'turn/completed',
    ],
  );
});

test('the fake Codex app-server replays a perf script one released chunk at a time', async (t) => {
  const { spawn } = await import('node:child_process');
  const { createInterface } = await import('node:readline');
  const root = mkdtempSync(path.join(os.tmpdir(), 'perf-codex-script-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const gateDir = path.join(root, 'gate');
  mkdirSync(gateDir);
  writeFileSync(path.join(gateDir, 'mode'), 'manual\n');
  const scriptDir = path.join(root, 'scripts');
  mkdirSync(scriptDir);
  writeFileSync(
    path.join(scriptDir, 'Canopy-CMCS2.json'),
    JSON.stringify({
      marker: 'Canopy-CMCS2',
      gateDir,
      chunks: [
        {
          delayMs: 0,
          notifications: [
            {
              method: 'item/commandExecution/outputDelta',
              params: { itemId: 'long', delta: 'first\n' },
            },
          ],
        },
        {
          delayMs: 0,
          notifications: [
            {
              method: 'turn/completed',
              params: { turn: { items: [], status: 'completed', error: null } },
            },
          ],
        },
      ],
    }),
  );
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(
        new URL(
          '../electron/fixtures/fake-codex-app-server.mjs',
          import.meta.url,
        ),
      ),
    ],
    {
      env: {
        ...process.env,
        CANOPY_E2E_CODEX_STATE_PATH: path.join(root, 'state.json'),
        CANOPY_E2E_CODEX_MODE: 'perf-script',
        CANOPY_E2E_CODEX_PERF_SCRIPT_DIR: scriptDir,
      },
      stdio: ['pipe', 'pipe', 'inherit'],
    },
  );
  t.after(() => child.kill());
  const messages = [];
  createInterface({ input: child.stdout }).on('line', (line) =>
    messages.push(JSON.parse(line)),
  );
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const waitFor = (predicate, label) =>
    waitUntil(() => messages.find(predicate), {
      timeoutMs: 10_000,
      label,
      intervalMs: 10,
    });
  send({ id: 1, method: 'thread/start', params: { cwd: root } });
  const thread = await waitFor((message) => message.id === 1, 'thread');
  const threadId = thread.result.thread.id;
  send({
    id: 2,
    method: 'turn/start',
    params: {
      threadId,
      input: [{ type: 'text', text: '[Canopy-CMCS2] stream' }],
    },
  });
  await waitFor((message) => message.method === 'turn/started', 'turn started');
  assert.ok(existsSync(path.join(gateDir, 'started')));
  // Nothing past the gate until the harness releases it.
  await delay(100);
  assert.equal(
    messages.some((message) => message.method?.startsWith('item/')),
    false,
  );
  writeFileSync(path.join(gateDir, 'release-0'), '');
  const delta = await waitFor(
    (message) => message.method === 'item/commandExecution/outputDelta',
    'the released delta',
  );
  assert.equal(delta.params.threadId, threadId);
  assert.equal(
    delta.params.turnId,
    messages.find((m) => m.id === 2).result.turn.id,
  );
  await waitUntil(() => existsSync(path.join(gateDir, 'emitted-0')), {
    timeoutMs: 10_000,
    label: 'emitted-0',
  });
  assert.equal(
    messages.some((message) => message.method === 'turn/completed'),
    false,
  );
  writeFileSync(path.join(gateDir, 'release-1'), '');
  const completed = await waitFor(
    (message) => message.method === 'turn/completed',
    'turn completion',
  );
  assert.equal(completed.params.turn.id, delta.params.turnId);
  await waitUntil(() => existsSync(path.join(gateDir, 'done')), {
    timeoutMs: 10_000,
    label: 'done',
  });
});

test('quiescence waits for an unchanged signature and reports a timeout instead of throwing', async () => {
  let clock = 0;
  const now = () => clock;
  const pause = async (ms) => {
    clock += ms;
  };
  const values = ['a', 'b', 'b', 'b', 'b', 'b', 'b', 'b'];
  let reads = 0;
  assert.equal(
    await waitForQuiescence({
      readSignature: async () => values[Math.min(reads++, values.length - 1)],
      quietMs: 100,
      pollMs: 25,
      now,
      pause,
    }),
    true,
  );
  assert.ok(clock >= 125);
  clock = 0;
  let counter = 0;
  assert.equal(
    await waitForQuiescence({
      readSignature: async () => String(counter++),
      quietMs: 100,
      timeoutMs: 1_000,
      pollMs: 25,
      now,
      pause,
    }),
    false,
  );
});

test('quiescence holds a quiet window back while main is busy or the step is not yet ingested', async () => {
  let clock = 0;
  const now = () => clock;
  const pause = async (ms) => {
    clock += ms;
  };
  // A sync in flight: no counter moves for 300 ms, then the commit lands.
  const reads = [
    { key: 'a', busy: false, events: 1 },
    ...Array.from({ length: 12 }, () => ({ key: 'a', busy: true, events: 1 })),
    { key: 'b', busy: false, events: 2 },
  ];
  let index = 0;
  let deferred = 0;
  assert.equal(
    await waitForQuiescence({
      readSignature: async () => reads[Math.min(index++, reads.length - 1)],
      quietMs: 100,
      pollMs: 25,
      ready: (current) => current.events > 1,
      onDeferred: () => {
        deferred += 1;
      },
      now,
      pause,
    }),
    true,
  );
  // It settled only after the commit and a full quiet window after it.
  assert.ok(index > reads.length);
  assert.ok(clock >= 12 * 25 + 100);
  assert.equal(deferred, 1);

  // A step whose events never arrive does not settle.
  clock = 0;
  assert.equal(
    await waitForQuiescence({
      readSignature: async () => ({ key: 'a', busy: false, events: 1 }),
      quietMs: 100,
      timeoutMs: 1_000,
      pollMs: 25,
      ready: (current) => current.events > 1,
      now,
      pause,
    }),
    false,
  );
});

test('a sequential step that never settles fails the run instead of being counted', async () => {
  let clock = 0;
  const now = () => clock;
  const pause = async (ms) => {
    clock += ms;
  };
  // Settled steps pass through.
  assert.equal(
    await requireQuiescence(
      {
        readSignature: async () => 'a',
        quietMs: 100,
        pollMs: 25,
        now,
        pause,
      },
      'chat-1 chunk 3',
    ),
    true,
  );
  // A step whose work never goes quiet would leave it to spill into the next
  // bracket, so it rejects with the step's name.
  clock = 0;
  let counter = 0;
  await assert.rejects(
    requireQuiescence(
      {
        readSignature: async () => String(counter++),
        quietMs: 100,
        timeoutMs: 1_000,
        pollMs: 25,
        now,
        pause,
      },
      'chat-1 chunk 4',
    ),
    /chat-1 chunk 4 did not settle within 1000 ms/,
  );
});

test('sized active turns are clean brackets named for the scaling ratios', () => {
  const sized = transcriptToolActiveTurnSizeFixtures([10, 100, 1_000]);
  assert.deepEqual(
    sized.map((fixture) => fixture.taskKind),
    [10, 100, 1_000].map((size) => toolActiveTurnTaskKind(size)),
  );
  assert.equal(new Set(sized.map((fixture) => fixture.marker)).size, 3);
  assert.equal(new Set(sized.map((fixture) => fixture.chatId)).size, 3);
  assert.ok(toolActiveTurnTimeoutMs(1_000) > toolActiveTurnTimeoutMs(10));
  // A sized turn grows by model steps of TOOL_ACTIVE_TURN_BATCH calls, each
  // with its own tool-use id, then streams the completion text.
  assert.equal(TOOL_ACTIVE_TURN_BATCH, 10);
  for (const fixture of sized) {
    const conversation = buildSizedToolActiveTurnConversation(
      fixture.marker,
      fixture.size,
      fixture.batch,
    );
    const toolSteps = conversation.steps.slice(0, -1);
    assert.equal(toolSteps.length, fixture.size / TOOL_ACTIVE_TURN_BATCH);
    assert.ok(
      toolSteps.every(
        (step) =>
          step.stopReason === 'tool_use' &&
          step.toolCalls.length === TOOL_ACTIVE_TURN_BATCH,
      ),
    );
    const ids = toolSteps.flatMap((step) =>
      step.toolCalls.map((call) => call.id),
    );
    assert.equal(new Set(ids).size, fixture.size);
    assert.equal(conversation.steps.at(-1).text, `${fixture.marker} complete.`);
  }
  // A size that is not a multiple of the batch ends with a short step.
  const uneven = buildSizedToolActiveTurnConversation('Canopy-CUNEVEN', 25, 10);
  assert.deepEqual(
    uneven.steps.slice(0, -1).map((step) => step.toolCalls.length),
    [10, 10, 5],
  );
});

test('code-graph edits are deterministic and build counts come from metadata and the diagnostic', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'perf-code-graph-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'graph-fixture'));
  for (let index = 0; index < 4; index += 1) {
    writeFileSync(
      path.join(root, 'graph-fixture', `mod${index}.ts`),
      buildCodeGraphFixtureSource(index, 4),
    );
  }
  const edited = applyCodeGraphFixtureEdit(root, 2, 3);
  assert.equal(edited.length, 2);
  assert.match(
    readFileSync(path.join(root, 'graph-fixture', 'mod1.ts'), 'utf8'),
    /export const perfEdit3_1 = 3;\n$/,
  );
  assert.doesNotMatch(
    readFileSync(path.join(root, 'graph-fixture', 'mod2.ts'), 'utf8'),
    /perfEdit/,
  );

  const dbPath = path.join(root, 'graph.db');
  const database = new DatabaseSync(dbPath);
  database.exec(
    'CREATE TABLE graph_metadata (key TEXT PRIMARY KEY, value TEXT)',
  );
  const insert = database.prepare(
    'INSERT INTO graph_metadata (key, value) VALUES (?, ?)',
  );
  for (const [key, value] of Object.entries({
    'build_timing:parse_ms': '12.5',
    'build_timing:resolve_calls_ms': '40',
    'build_timing:rows_written': '17137',
    'build_timing:wal_start_bytes': '1000',
    'build_timing:peak_wal_bytes': '5000',
    'build_timing:peak_rss_bytes': '169836544',
    'build_timing:fts_ms': '3',
    time_to_first_graph_ms: '10141',
    extractor_version: 'not a number',
  })) {
    insert.run(key, value);
  }
  database.close();
  const metadata = readCodeGraphBuildMetadata(dbPath);
  assert.equal(metadata.timeToFirstGraphMs, 10_141);
  assert.equal(metadata.build.rows_written, 17_137);
  assert.equal('time_to_first_graph_ms' in metadata.build, false);
  assert.deepEqual(
    codeGraphBuildWork(metadata.build, {
      codeGraphBuild: {
        filesScanned: 106,
        filesParsed: 1,
        timings: { resolveMs: { resetMs: 1, importsMs: 2, callsMs: 3 } },
      },
    }),
    {
      filesScanned: 106,
      filesParsed: 1,
      rowsWritten: 17_137,
      resolverPasses: 3,
      ftsRebuilds: 1,
      derivedRuns: 0,
      peakWalBytes: 5_000,
      walGrowthBytes: 4_000,
      peakRssBytes: 169_836_544,
    },
  );
  // Without a diagnostic, resolver passes come from the metadata keys.
  assert.equal(codeGraphBuildWork(metadata.build, null).resolverPasses, 1);
  assert.deepEqual(
    codeGraphBuildTimings(metadata.build, { main_total_ms: 9 }),
    {
      parse_ms: 12.5,
      resolve_calls_ms: 40,
      fts_ms: 3,
      main_total_ms: 9,
    },
  );

  const sessionEvents = path.join(
    root,
    'agent-observability',
    'diagnostics',
    'session-events',
  );
  mkdirSync(sessionEvents, { recursive: true });
  writeFileSync(
    path.join(sessionEvents, '2026-09-30.jsonl'),
    [
      JSON.stringify({ kind: 'turn_idle', worktreeId: 'perf-graph-small' }),
      JSON.stringify({
        kind: 'code_graph_build',
        worktreeId: 'perf-graph-small',
        codeGraphBuild: { filesParsed: 1 },
      }),
      JSON.stringify({
        kind: 'code_graph_build',
        worktreeId: 'perf-graph-large',
        codeGraphBuild: { filesParsed: 1 },
      }),
      '{"kind":"code_graph_build","worktreeId":"perf-graph-small"',
    ].join('\n'),
  );
  assert.equal(
    readCodeGraphBuildDiagnostics(root, 'perf-graph-small').length,
    1,
  );
});

test('the startup trace records V8 compile events as JSON for a bounded window', () => {
  assert.deepEqual(startupTraceElectronArgs('/tmp/trace.json'), [
    '--trace-startup=v8,devtools.timeline',
    '--trace-startup-file=/tmp/trace.json',
    '--trace-startup-duration=10',
    '--trace-startup-format=json',
  ]);
  const summary = summarizeV8CompileTrace({
    traceEvents: [
      {
        name: 'v8.compileModule',
        dur: 18,
        args: {
          data: {
            streamed: true,
            url: 'file:///app/out/renderer/assets/entry-DeBUH2Gn.js',
          },
        },
      },
      {
        name: 'v8.compile',
        dur: 11,
        args: {
          data: {
            streamed: false,
            notStreamedReason: 'inline script',
            url: '',
            consumedCacheSize: 2_048,
            cacheRejected: true,
          },
        },
      },
      { name: 'v8.produceModuleCache', dur: 2, args: {} },
      { name: 'V8.CompileCode', dur: 500, args: {} },
      { name: 'ParseHTML', dur: 50, args: {} },
    ],
  });
  assert.deepEqual(Object.keys(summary.events).sort(), [
    'v8.compile',
    'v8.compileModule',
    'v8.produceModuleCache',
  ]);
  assert.equal(summary.events['v8.compileModule'].durationMs, 0.018);
  assert.equal(summary.streamedCompiles, 1);
  assert.deepEqual(summary.notStreamedReasons, { 'inline script': 1 });
  assert.equal(summary.consumedCacheBytes, 2_048);
  assert.equal(summary.cacheRejections, 1);
  assert.equal(summary.slowestScripts[0].file, 'entry-DeBUH2Gn.js');
  assert.equal(summary.slowestScripts[1].file, '(inline)');
});

test("J1 milestones sit on main's clock from process start to the hydrated composer", () => {
  assert.deepEqual(STARTUP_JOURNEY_SCENARIO_NAMES, [
    'startup-settle',
    'startup-realistic',
  ]);
  const milestones = startupJourneyMilestones({
    launchEpochMs: 1_000,
    main: {
      timeOrigin: 1_080,
      bootstrapCompleteMs: 95,
      marks: { mainReady: 435 },
    },
    renderer: {
      timeOrigin: 2_230,
      domContentLoadedMs: 282,
      reactFirstCommitMs: 289,
    },
    composerReadyFromLaunchMs: 2_000,
    shellReadyFromLaunchMs: 1_900,
  });
  assert.deepEqual(milestones, {
    process_start_from_launch_ms: 80,
    node_bootstrap_ms: 95,
    main_ready_ms: 435,
    window_navigation_start_ms: 1_150,
    dom_content_loaded_ms: 1_432,
    react_mount_ms: 1_439,
    shell_ready_ms: 1_820,
    composer_ready_ms: 1_920,
    process_start_to_main_ready_ms: 435,
    main_ready_to_window_navigation_ms: 715,
    window_navigation_to_dom_content_loaded_ms: 282,
    dom_content_loaded_to_react_mount_ms: 7,
    react_mount_to_composer_ms: 481,
  });
  // A missing mark leaves its milestone and phases out rather than zero.
  const partial = startupJourneyMilestones({
    launchEpochMs: 1_000,
    main: { timeOrigin: 1_080, bootstrapCompleteMs: null, marks: null },
    renderer: { timeOrigin: 2_230, domContentLoadedMs: null },
  });
  assert.equal('main_ready_ms' in partial, false);
  assert.equal('react_mount_to_composer_ms' in partial, false);
  assert.equal(partial.window_navigation_start_ms, 1_150);
});

test('the disk accuracy check compares own-writer bytes with the OS counter for main', () => {
  const check = diskAccuracyCheck({
    chatStorage: {
      commits: 10,
      'written.journal.bytes': 600,
      'written.liveIndex.bytes': 250,
      'written.activeSidecar.bytes': 100,
      'serialized.journal.bytes': 600,
    },
    disk: { 'main.writtenBytes': 1_000 },
  });
  assert.equal(check.available, true);
  assert.equal(check.advisory, true);
  assert.equal(check.ownWriterBytes, 950);
  assert.equal(check.withinTenPercent, true);
  assert.equal(check.deviation, 0.05);
  assert.equal(check.dominantClass, 'journal');
  assert.equal(check.journalAndIndexBytes, 850);
  assert.equal(check.writtenBytesByClass.activeSidecar, 100);
  assert.equal(
    diskAccuracyCheck({ chatStorage: {}, disk: {} }).available,
    false,
  );
  assert.match(diskAccuracyCheck({}).reason, /chat-storage/);
  // Main's other large appender is estimated from its final file sizes.
  const withObservability = diskAccuracyCheck(
    {
      chatStorage: { 'written.journal.bytes': 600 },
      disk: { 'main.writtenBytes': 1_000 },
    },
    { observabilityFileBytes: 300 },
  );
  assert.equal(withObservability.observabilityFileBytes, 300);
  assert.equal(withObservability.ownWriterAndObservabilityShareOfMain, 0.9);
});

test('directory file bytes sum every file below a directory', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'perf-directory-bytes-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'diagnostics', 'session-events'), {
    recursive: true,
  });
  writeFileSync(path.join(root, 'snapshot.json'), 'x'.repeat(10));
  writeFileSync(
    path.join(root, 'diagnostics', 'session-events', 'day.jsonl'),
    'y'.repeat(32),
  );
  assert.equal(directoryFileBytes(root), 42);
  assert.equal(directoryFileBytes(path.join(root, 'missing')), null);
});

test('mixed-provider and large-transcript concurrency collect disk bytes and the app counters generically', () => {
  for (const name of [
    'mixed-provider-agent-concurrency',
    'large-transcript-concurrency',
    'multi-chat-streaming',
    'background-streaming',
    'chat-switch-catch-up',
  ]) {
    assert.deepEqual(scenarioWorkCollection(name, {}), {
      appCounters: true,
      chromiumCounters: true,
      diskBytes: true,
      frameBudgets: true,
      ipcBytes: false,
    });
  }
  // The hidden browser-profile study keeps its exact footprint.
  assert.equal(
    scenarioWorkCollection('browser-panels', { studyWindowMode: 'headless' })
      .diskBytes,
    false,
  );
});

test('only the counters profile estimates IPC payload bytes', () => {
  for (const profile of ['smoke', 'baseline', 'stress']) {
    assert.equal(
      scenarioWorkCollection('stress-transcript', { profile }).ipcBytes,
      false,
      profile,
    );
  }
  assert.equal(
    scenarioWorkCollection('multi-chat-streaming-sequential', {
      profile: 'counters',
    }).ipcBytes,
    true,
  );
  for (const name of ['background-streaming', 'chat-switch-catch-up']) {
    assert.equal(
      scenarioWorkCollection(name, { profile: 'counters' }).ipcBytes,
      true,
      `${name} retains IPC byte estimates in the counters profile`,
    );
  }
});

function planOpenFixture(profile) {
  const config = PERFORMANCE_PROFILES[profile];
  return buildLargePlanFixture({
    projectId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    sections: config.planOpenSections,
    tasksPerSection: config.planOpenTasksPerSection,
    paragraphBytes: config.planOpenParagraphBytes,
    diagramTasksPerSection: config.planOpenDiagramTasksPerSection,
    commentThreads: config.planOpenCommentThreads,
  });
}

test('plan-open builds a deterministic large plan with valid diagrams and anchored comments', () => {
  const sizes = [];
  for (const profile of ['smoke', 'baseline', 'stress']) {
    const config = PERFORMANCE_PROFILES[profile];
    const fixture = planOpenFixture(profile);
    assert.deepEqual(planOpenFixture(profile), fixture, profile);
    const { plan } = fixture;

    assert.equal(fixture.sentinel, LARGE_PLAN_SENTINEL);
    const headings = plan.content.match(/^## .+$/gm);
    assert.equal(headings.at(-1), `## ${LARGE_PLAN_SENTINEL}`);
    assert.equal(headings.length, config.planOpenSections + 1);
    assert.equal(fixture.contentBytes, Buffer.byteLength(plan.content, 'utf8'));
    assert.ok(
      fixture.contentBytes >
        config.planOpenSections * config.planOpenParagraphBytes,
      profile,
    );
    sizes.push(fixture.contentBytes);

    assert.ok(isPlanDiagramArtifacts(plan.diagrams), profile);
    for (const kind of ['sequence', 'logicDiff', 'dataModelDiff']) {
      assert.equal(plan.diagrams[kind].status, 'ready');
      assert.equal(
        plan.diagrams[kind].derivedFromRevision,
        plan.latestRevisionNumber,
      );
    }
    const sequence = plan.diagrams.sequence.data;
    const logic = plan.diagrams.logicDiff.data;
    assert.ok(isParsedPlanGraph(sequence));
    assert.ok(isLogicDiffDiagram(logic));
    assert.ok(isDataModelDiffDiagram(plan.diagrams.dataModelDiff.data));
    assert.equal(
      fixture.sequenceNodeCount,
      config.planOpenSections * (1 + config.planOpenDiagramTasksPerSection),
    );
    assert.equal(sequence.nodes.length, fixture.sequenceNodeCount);
    assert.equal(fixture.logicNodeCount, config.planOpenSections * 2);
    assert.ok(
      logic.planned.nodes.some((node) => node.id === fixture.logicNodeId),
    );
    for (const node of sequence.nodes.filter(
      (entry) => entry.kind === 'task',
    )) {
      assert.ok(plan.content.includes(node.planAnchor.quote), node.id);
    }

    assert.equal(fixture.commentThreadCount, config.planOpenCommentThreads);
    assert.equal(plan.commentThreads.length, config.planOpenCommentThreads);
    for (const thread of plan.commentThreads) {
      assert.equal(thread.anchorState, 'matched');
      assert.ok(plan.content.includes(thread.anchor.quote), thread.id);
    }
    assert.equal(plan.share, undefined);
  }
  assert.ok(sizes[0] < sizes[1] && sizes[1] < sizes[2]);
});

test('plan-open seeds the large plan beside small and hidden companions', (t) => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-perf-plan-open-'),
  );
  t.after(() => rmSync(userDataDir, { recursive: true, force: true }));
  const config = PERFORMANCE_PROFILES.smoke;

  const fixture = preparePlanOpen(userDataDir, config);

  const file = JSON.parse(
    readFileSync(
      path.join(
        userDataDir,
        'workspaces',
        'demo-ts-pnpm-vite',
        'plans',
        'demo-main.json',
      ),
      'utf8',
    ),
  );
  assert.equal(file.version, 1);
  assert.deepEqual(
    file.plans.map((plan) => [plan.id, plan.hidden === true]),
    [
      [fixture.planId, false],
      ['plan-open-small-1', false],
      ['plan-open-small-2', false],
      ['plan-open-hidden', true],
    ],
  );
  const large = file.plans[0];
  assert.equal(Buffer.byteLength(large.content, 'utf8'), fixture.contentBytes);
  assert.ok(large.content.includes(`## ${fixture.sentinel}`));
  assert.equal(large.commentThreads.length, config.planOpenCommentThreads);
  assert.equal(fixture.commentThreadCount, config.planOpenCommentThreads);
  assert.ok(existsSync(path.join(userDataDir, 'plugins-cache.json')));
});

test('release-like launches isolate Chromium storage before the product takes its single-instance lock', () => {
  const profile = path.join(os.tmpdir(), 'performance profile with spaces');
  const diagnosticArgs = ['--inspect=12345'];
  assert.deepEqual(performanceElectronArgs(true, profile, diagnosticArgs), [
    `--user-data-dir=${profile}`,
    '--inspect=12345',
  ]);
  assert.deepEqual(diagnosticArgs, ['--inspect=12345']);
  assert.deepEqual(performanceElectronArgs(false, profile, diagnosticArgs), [
    '--inspect=12345',
  ]);
});

test('managed-delegation-concurrency scripts two Claude and two Codex parents with three background delegates each', () => {
  const config = {
    managedDelegationChildSteps: 3,
    managedDelegationChildStepMs: 400,
    chatReplyCharacters: 200,
  };
  const descriptors = managedDelegationDescriptors();
  const scripts = managedDelegationScripts(
    config,
    descriptors,
    '/worktree/delegation-load-evidence.txt',
  );
  assert.deepEqual(
    descriptors.map((descriptor) => descriptor.providerType),
    ['claude', 'codex', 'claude', 'codex'],
  );
  for (const descriptor of descriptors) {
    const parent = scripts[descriptor.marker].llm;
    const [spawn, work] = parent.steps;
    assert.equal(spawn.toolCalls.length, 3);
    if (descriptor.providerType === 'claude') {
      assert.ok(
        spawn.toolCalls.every(
          (call) =>
            /^mcp__.+__DelegateTask$/.test(call.name) &&
            call.input.run_in_background === true,
        ),
      );
      assert.equal(parent.openAiStepCursor, undefined);
    } else {
      assert.ok(
        spawn.toolCalls.every(
          (call) =>
            /_spawn_delegate$/.test(call.name) &&
            call.input.execution_mode === 'background',
        ),
      );
      assert.equal(parent.openAiStepCursor, 'completed-scenario-tool-calls');
    }
    // The parent ends its turn after about two delegate steps.
    assert.equal(work.streamMs, 800);
    // One delegate per parent runs on the other harness.
    assert.deepEqual(
      descriptor.delegates.map((delegate) => delegate.harness),
      descriptor.providerType === 'claude'
        ? ['claude', 'codex', 'claude']
        : ['codex', 'claude', 'codex'],
    );
    for (const [index, delegate] of descriptor.delegates.entries()) {
      const prompt =
        spawn.toolCalls[index].input.prompt ??
        spawn.toolCalls[index].input.message;
      assert.ok(prompt.startsWith(`[${delegate.marker}]`));
      const steps = scripts[delegate.marker].llm.steps;
      assert.equal(steps.length, 4);
      for (const [step, scripted] of steps.slice(0, 3).entries()) {
        assert.equal(
          scripted.text,
          managedDelegationStepText(delegate.marker, step + 1),
        );
        assert.equal(scripted.toolCalls.length, 1);
        assert.equal(
          scripted.toolCalls[0].name,
          delegate.harness === 'claude' ? 'Read' : 'exec_command',
        );
      }
      assert.equal(steps[3].stopReason, 'end_turn');
    }
  }
});

test('the cost index scenario reports what the index read, and nothing for a build without one', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'perf-cost-checkpoint-'));
  try {
    const checkpointPath = path.join(root, 'cost-index', 'checkpoint.json');
    const files = ['2026-10-10.jsonl', '2026-10-11.jsonl'].map((name) =>
      path.join(root, 'agent-observability', 'audit', name),
    );
    assert.equal(costIndexCheckpointSummary(checkpointPath, files), null);

    mkdirSync(path.dirname(checkpointPath), { recursive: true });
    writeFileSync(
      checkpointPath,
      JSON.stringify({
        version: 1,
        audit: {
          '2026-10-10.jsonl': { offset: 900, size: 900, mtimeMs: 1 },
          '2026-10-11.jsonl': { offset: 400, size: 900, mtimeMs: 1 },
        },
        lastRefresh: {
          trigger: 'startup',
          startedAt: '2026-10-11T12:00:00.000Z',
          completedAt: '2026-10-11T12:00:04.000Z',
          linesRead: 1_234,
          durationMs: 4_000,
        },
      }),
    );
    assert.deepEqual(costIndexCheckpointSummary(checkpointPath, files), {
      costIndexFilesRead: 1,
      costIndexLastRefreshTrigger: 'startup',
      costIndexLastRefreshMs: 4_000,
      costIndexLastRefreshLines: 1_234,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the cost index scenario runs release-like: it needs no E2E-only hook', () => {
  assert.doesNotThrow(() =>
    assertReleaseLikeScenarioSupported('cost-index-first-build', true),
  );
});
