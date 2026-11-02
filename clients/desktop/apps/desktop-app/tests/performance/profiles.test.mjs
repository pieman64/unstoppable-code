import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_SCENARIO_NAMES,
  OPT_IN_SCENARIO_NAMES,
  PERFORMANCE_PROFILES,
  SCENARIO_NAMES,
  SCENARIO_SCOPED_CONFIG_KEYS,
  SCENARIO_SCOPED_OPTIONS,
  WORK_RATCHET_PROFILE,
  WORK_RATCHET_SCENARIO_NAMES,
  parsePerformanceArgs,
  performanceUsage,
} from './profiles.mjs';

test('the counters profile runs the fixed ratchet set at smoke size', () => {
  assert.equal(WORK_RATCHET_PROFILE, 'counters');
  assert.deepEqual(WORK_RATCHET_SCENARIO_NAMES, [
    'startup-settle',
    'loaded-ui',
    'stress-transcript',
    'transcript-streaming-tail',
    'plugin-picker',
    'file-explorer',
    'cowork-default-50',
  ]);
  for (const scenario of WORK_RATCHET_SCENARIO_NAMES) {
    assert.ok(SCENARIO_NAMES.includes(scenario), scenario);
  }
  assert.deepEqual(PERFORMANCE_PROFILES.counters, PERFORMANCE_PROFILES.smoke);

  const parsed = parsePerformanceArgs(['--profile', 'counters']);
  assert.equal(parsed.profile, 'counters');
  assert.deepEqual(parsed.scenarios, [...WORK_RATCHET_SCENARIO_NAMES]);
  assert.deepEqual(
    parsed.config,
    parsePerformanceArgs(['--profile', 'smoke']).config,
  );
  // Qualification runs narrow the fixed set explicitly.
  assert.deepEqual(
    parsePerformanceArgs([
      '--scenarios',
      'stress-transcript,transcript-streaming-tail',
      '--profile',
      'counters',
    ]).scenarios,
    ['stress-transcript', 'transcript-streaming-tail'],
  );
  // Other profiles keep the default suite.
  assert.deepEqual(parsePerformanceArgs(['--profile', 'smoke']).scenarios, [
    ...DEFAULT_SCENARIO_NAMES,
  ]);
  assert.match(
    performanceUsage(),
    /--profile <smoke\|baseline\|stress\|counters>/,
  );
});

test('stress transcript remains production-sized even in the smoke profile', () => {
  assert.ok(DEFAULT_SCENARIO_NAMES.includes('stress-transcript'));
  for (const profile of Object.values(PERFORMANCE_PROFILES)) {
    assert.ok(profile.stressTranscriptTurns >= 25);
    assert.ok(profile.stressTranscriptBatches >= 160);
    assert.ok(profile.stressTranscriptFinalBytes >= 26_000);
  }
});

test('performance suite exposes the inner panel collapse scenario', () => {
  assert.ok(SCENARIO_NAMES.includes('inner-panels-collapse'));
  assert.ok(!DEFAULT_SCENARIO_NAMES.includes('inner-panels-collapse'));
  assert.equal(PERFORMANCE_PROFILES.smoke.innerPanelCollapseWarmups, 1);
  assert.equal(PERFORMANCE_PROFILES.smoke.innerPanelCollapseIterations, 3);
  assert.equal(PERFORMANCE_PROFILES.baseline.innerPanelCollapseWarmups, 3);
  assert.equal(PERFORMANCE_PROFILES.baseline.innerPanelCollapseIterations, 20);
  assert.equal(PERFORMANCE_PROFILES.stress.innerPanelCollapseWarmups, 5);
  assert.equal(PERFORMANCE_PROFILES.stress.innerPanelCollapseIterations, 50);
});

test('plan open is an opt-in scenario with per-profile plan scale', () => {
  assert.ok(SCENARIO_NAMES.includes('plan-open'));
  assert.ok(!DEFAULT_SCENARIO_NAMES.includes('plan-open'));
  assert.match(performanceUsage(), /inner-panels-collapse,plan-open,chats/);
  const expected = {
    smoke: [12, 4, 480, 2, 6, 3],
    baseline: [40, 8, 1_200, 3, 24, 10],
    stress: [80, 12, 2_400, 4, 60, 20],
  };
  for (const [profile, values] of Object.entries(expected)) {
    const config = PERFORMANCE_PROFILES[profile];
    assert.deepEqual(
      [
        config.planOpenSections,
        config.planOpenTasksPerSection,
        config.planOpenParagraphBytes,
        config.planOpenDiagramTasksPerSection,
        config.planOpenCommentThreads,
        config.planOpenIterations,
      ],
      values,
      profile,
    );
    // Cold open plus at least one warm open, and every section keeps at least
    // one diagram task.
    assert.ok(config.planOpenIterations >= 2, profile);
    assert.ok(
      config.planOpenDiagramTasksPerSection <= config.planOpenTasksPerSection,
      profile,
    );
  }
  assert.deepEqual(
    parsePerformanceArgs(['--profile', 'smoke', '--scenarios', 'plan-open'])
      .scenarios,
    ['plan-open'],
  );
});

test('archive responsiveness is an opt-in mixed lifecycle workload', () => {
  assert.ok(SCENARIO_NAMES.includes('archive-responsiveness'));
  assert.ok(!DEFAULT_SCENARIO_NAMES.includes('archive-responsiveness'));
  assert.equal(PERFORMANCE_PROFILES.smoke.archivePayloadBytes, 8 * 1024 * 1024);
  assert.equal(
    PERFORMANCE_PROFILES.baseline.archivePayloadBytes,
    64 * 1024 * 1024,
  );
  assert.equal(
    PERFORMANCE_PROFILES.stress.archivePayloadBytes,
    256 * 1024 * 1024,
  );
});

test('performance runs are headless by default', () => {
  assert.equal(parsePerformanceArgs([]).showWindow, false);
  assert.equal(parsePerformanceArgs(['--headless']).showWindow, false);
});

test('headed mode requires an explicit opt-in', () => {
  assert.equal(parsePerformanceArgs(['--headed']).showWindow, true);
});

test('release-like production-bundle mode requires an explicit opt-in', () => {
  assert.equal(parsePerformanceArgs([]).releaseLike, false);
  assert.equal(parsePerformanceArgs(['--release-like']).releaseLike, true);
  assert.equal(
    parsePerformanceArgs(['--release-like', '--release-like-root', '/baseline'])
      .releaseLikeRoot,
    '/baseline',
  );
  assert.match(performanceUsage(), /--release-like/);
});

test('diagnostic replay profiles failures by default and supports overrides', () => {
  assert.equal(parsePerformanceArgs([]).diagnosticsMode, 'on-failure');
  assert.equal(parsePerformanceArgs(['--diagnose']).diagnosticsMode, 'always');
  assert.equal(
    parsePerformanceArgs(['--no-diagnostics']).diagnosticsMode,
    'off',
  );
});

test('live startup background work is explicit and startup-only', () => {
  const parsed = parsePerformanceArgs([
    '--scenarios',
    'startup-settle',
    '--live-startup-background',
    '--startup-settle-ms',
    '20000',
    '--startup-worktrees',
    '124',
    '--startup-workspaces',
    '42',
  ]);
  assert.equal(parsed.config.startupBackgroundMode, 'live');
  assert.equal(parsed.config.startupSettleMs, 20_000);
  assert.equal(parsed.config.startupWorktrees, 124);
  assert.equal(parsed.config.startupWorkspaces, 42);
  assert.throws(
    () =>
      parsePerformanceArgs([
        '--scenarios',
        'loaded-ui',
        '--live-startup-background',
      ]),
    /requires the startup-settle scenario/,
  );
});

test('realistic startup is opt-in and exposes its production-shaped scale', () => {
  assert.ok(SCENARIO_NAMES.includes('startup-realistic'));
  assert.ok(!DEFAULT_SCENARIO_NAMES.includes('startup-realistic'));
  const parsed = parsePerformanceArgs([
    '--scenarios',
    'startup-realistic',
    '--realistic-startup-worktrees',
    '44',
    '--realistic-startup-workspaces',
    '22',
    '--realistic-startup-repositories',
    '8',
    '--realistic-startup-graph-files',
    '1200',
    '--realistic-startup-observe-ms',
    '60000',
  ]);
  assert.equal(parsed.config.realisticStartupWorktrees, 44);
  assert.equal(parsed.config.realisticStartupWorkspaces, 22);
  assert.equal(parsed.config.realisticStartupRepositories, 8);
  assert.equal(parsed.config.realisticStartupGraphFilesPerRepo, 1_200);
  assert.equal(parsed.config.realisticStartupObserveMs, 60_000);
  assert.throws(
    () =>
      parsePerformanceArgs([
        '--scenarios',
        'startup-realistic',
        '--realistic-startup-repositories',
        '10',
      ]),
    /requires 1-9 repositories/,
  );
  assert.throws(
    () =>
      parsePerformanceArgs([
        '--scenarios',
        'startup-realistic',
        '--realistic-startup-repositories',
        '3',
        '--realistic-startup-workspaces',
        '3',
      ]),
    /workspace capacity.*cowork workspace/,
  );
});

test('power-user idle is opt-in and mirrors the measured desktop cardinalities', () => {
  assert.ok(SCENARIO_NAMES.includes('power-user-idle'));
  assert.ok(!DEFAULT_SCENARIO_NAMES.includes('power-user-idle'));

  const baseline = PERFORMANCE_PROFILES.baseline;
  assert.equal(baseline.powerUserWorkspaces, 25);
  assert.equal(baseline.powerUserWorktrees, 45);
  assert.equal(baseline.powerUserCoworkWorkspaces, 3);
  assert.equal(baseline.powerUserCoworkEntries, 17);
  assert.equal(baseline.powerUserChatTabs, 560);
  assert.equal(baseline.powerUserMessages, 100_000);
  assert.equal(baseline.powerUserPipelineExecutions, 482);
  assert.equal(baseline.powerUserPanelLayouts, 47);
  assert.equal(baseline.powerUserFiredWatchers, 1_108);
  assert.equal(baseline.powerUserAutomations, 34);
  assert.equal(baseline.powerUserAutomationRuns, 42);
  assert.ok(
    baseline.powerUserGraphFilesPerRepo <
      baseline.realisticStartupGraphFilesPerRepo,
  );
});

test('power-user active is opt-in and reuses supported foreground concurrency', () => {
  assert.ok(SCENARIO_NAMES.includes('power-user-active'));
  assert.ok(!DEFAULT_SCENARIO_NAMES.includes('power-user-active'));

  const baseline = PERFORMANCE_PROFILES.baseline;
  assert.equal(baseline.concurrentChats, 8);
  assert.equal(baseline.concurrentPipelines, 4);
  assert.equal(baseline.powerUserChatTabs, 560);
  assert.equal(baseline.powerUserPipelineExecutions, 482);
});

test('Git attribution is diagnostic-only and explicit', () => {
  assert.equal(parsePerformanceArgs([]).gitAttribution, false);
  assert.equal(
    parsePerformanceArgs(['--git-attribution']).gitAttribution,
    true,
  );
});

test('mixed-provider concurrency is part of the default suite', () => {
  assert.ok(SCENARIO_NAMES.includes('mixed-provider-agent-concurrency'));
  assert.ok(
    DEFAULT_SCENARIO_NAMES.includes('mixed-provider-agent-concurrency'),
  );
  assert.deepEqual(parsePerformanceArgs([]).scenarios, [
    ...DEFAULT_SCENARIO_NAMES,
  ]);
});

test('Cold Home send and Default cowork scale scenarios are separate opt-in workloads', () => {
  const scenarios = [
    'home-cowork-legacy',
    'cowork-default-50',
    'cowork-default-100',
    'cowork-default-500',
  ];
  for (const scenario of scenarios) {
    assert.ok(SCENARIO_NAMES.includes(scenario));
    assert.ok(!DEFAULT_SCENARIO_NAMES.includes(scenario));
  }
  assert.deepEqual(
    parsePerformanceArgs(['--scenarios', scenarios.join(',')]).scenarios,
    scenarios,
  );
  assert.ok(
    PERFORMANCE_PROFILES.baseline.coworkDefaultLongMessages >
      PERFORMANCE_PROFILES.baseline.coworkDefaultShortMessages,
  );
});

test('Code Graph concurrency is a default workload with explicit scale overrides', () => {
  assert.ok(SCENARIO_NAMES.includes('code-graph-concurrency'));
  assert.ok(SCENARIO_NAMES.includes('code-graph-background-concurrency'));
  assert.ok(DEFAULT_SCENARIO_NAMES.includes('code-graph-concurrency'));
  const parsed = parsePerformanceArgs([
    '--profile',
    'smoke',
    '--scenarios',
    'code-graph-concurrency',
    '--code-graph-worktrees',
    '7',
    '--code-graph-files',
    '2400',
  ]);
  assert.equal(parsed.config.codeGraphBuildWorktrees, 7);
  assert.equal(parsed.config.codeGraphFixtureFilesPerWorktree, 2_400);
  assert.throws(
    () =>
      parsePerformanceArgs([
        '--scenarios',
        'code-graph-concurrency',
        '--code-graph-worktrees',
        '2',
      ]),
    /requires at least three worktrees/,
  );
});

test('pipeline history is a default workload with explicit scale overrides', () => {
  assert.ok(SCENARIO_NAMES.includes('pipeline-history'));
  assert.ok(DEFAULT_SCENARIO_NAMES.includes('pipeline-history'));
  const parsed = parsePerformanceArgs([
    '--profile',
    'smoke',
    '--scenarios',
    'pipeline-history',
    '--pipeline-history-executions',
    '421',
    '--pipeline-history-bytes',
    '58700000',
  ]);
  assert.equal(parsed.config.pipelineHistoryExecutions, 421);
  assert.equal(parsed.config.pipelineHistoryTotalBytes, 58_700_000);
});

test('chat search indexing is a default workload with the observed 65 MB baseline tier', () => {
  assert.ok(SCENARIO_NAMES.includes('chat-search-indexing'));
  assert.ok(DEFAULT_SCENARIO_NAMES.includes('chat-search-indexing'));
  assert.equal(
    PERFORMANCE_PROFILES.baseline.chatSearchIndexBodyBytes,
    65_000_000,
  );
});

test('plugin picker is a default workload with a 1,000-item plugin-heavy baseline', () => {
  assert.ok(SCENARIO_NAMES.includes('plugin-picker'));
  assert.ok(DEFAULT_SCENARIO_NAMES.includes('plugin-picker'));
  const baseline = PERFORMANCE_PROFILES.baseline;
  assert.equal(
    baseline.pluginPickerPlugins +
      baseline.pluginPickerSkills +
      baseline.pluginPickerMcpServers,
    1_000,
  );
  assert.equal(baseline.pluginPickerPlugins, 850);
  assert.equal(baseline.pluginPickerSearchIterations, 8);

  const parsed = parsePerformanceArgs([
    '--profile',
    'smoke',
    '--scenarios',
    'plugin-picker',
    '--plugin-picker-plugins',
    '600',
    '--plugin-picker-skills',
    '70',
    '--plugin-picker-mcp-servers',
    '30',
  ]);
  assert.equal(parsed.config.pluginPickerPlugins, 600);
  assert.equal(parsed.config.pluginPickerSkills, 70);
  assert.equal(parsed.config.pluginPickerMcpServers, 30);

  const usage = performanceUsage();
  assert.match(usage, /--plugin-picker-plugins <count>/);
  assert.match(usage, /--plugin-picker-skills <count>/);
  assert.match(usage, /--plugin-picker-mcp-servers <n>/);

  assert.throws(
    () =>
      parsePerformanceArgs([
        '--scenarios',
        'plugin-picker',
        '--plugin-picker-mcp-servers',
        '1',
      ]),
    /at least two MCP rows/,
  );
});

test('mixed-provider agent concurrency requires both providers', () => {
  assert.equal(
    parsePerformanceArgs([
      '--profile',
      'smoke',
      '--scenarios',
      'mixed-provider-agent-concurrency',
      '--chats',
      '4',
    ]).config.concurrentChats,
    4,
  );
  assert.throws(
    () =>
      parsePerformanceArgs([
        '--scenarios',
        'mixed-provider-agent-concurrency',
        '--chats',
        '1',
      ]),
    /requires at least two chats/,
  );
});

test('every profile includes active-load typing and navigation probes', () => {
  for (const profile of Object.values(PERFORMANCE_PROFILES)) {
    assert.ok(profile.interactionIterations > 0);
    assert.ok(profile.navigationIterations >= profile.interactionIterations);
    assert.ok(profile.startupSettleMs >= 8_000);
    assert.equal(profile.startupTypingIntervalMs, 250);
    assert.ok(profile.startupBackgroundIdleDwellMs > 5_000);
    assert.ok(profile.startupBackgroundProbeMs > 0);
    assert.ok(profile.startupWorktrees >= 8);
    assert.ok(profile.startupWorkspaces >= 4);
    assert.ok(profile.startupWorkspaces <= profile.startupWorktrees);
    assert.ok(profile.largeTranscriptWorktrees >= 3);
    assert.ok(profile.largeTranscriptLiveChatsPerWorktree >= 2);
    assert.ok(profile.largeTranscriptArchivedChatsPerWorktree >= 3);
    assert.ok(
      profile.largeTranscriptNavigationIterations >=
        profile.largeTranscriptWorktrees,
    );
    assert.ok(profile.largeTranscriptArchiveViews > 0);
    assert.ok(profile.largeTranscriptDenseMessages > 0);
    assert.ok(profile.largeTranscriptDenseMessageBytes > 0);
    assert.ok(profile.largeTranscriptRichMessages > 0);
    assert.ok(profile.largeTranscriptRichMessageBytes > 0);
    assert.ok(profile.largeTranscriptArchiveMessages > 0);
    assert.ok(profile.largeTranscriptArchiveMessageBytes > 0);
    assert.ok(profile.mathTranscriptLightElements > 0);
    assert.ok(profile.mathTranscriptMediumElements > 0);
    assert.ok(profile.mathTranscriptHeavyElements > 0);
    assert.ok(profile.mathTranscriptNavigationIterations >= 3);
    assert.ok(profile.typingCharacters > 0);
    assert.ok(profile.responsivenessBudgetMs > 0);
    assert.ok(profile.responsivenessThresholds.rendererFrameDelayMaxMs > 0);
    assert.ok(profile.chatStreamMs > 0);
    assert.ok(profile.pipelineHoldMs > 0);
    assert.ok(profile.pipelineHistoryExecutions >= 60);
    assert.ok(profile.pipelineHistoryTotalBytes >= 8_000_000);
    assert.ok(profile.pipelineHistoryListIterations >= 2);
    assert.ok(profile.browserHistoricalPartitions >= 16);
    assert.ok(profile.browserPostCloseSettleMs >= 500);
    assert.ok(profile.chatSearchIndexBodyBytes >= 8_000_000);
    assert.ok(profile.pluginPickerPlugins > 0);
    assert.ok(profile.pluginPickerSkills > 0);
    // Two MCP rows minimum: the last is a search target, the first is the
    // full-list selection target.
    assert.ok(profile.pluginPickerMcpServers >= 2);
    assert.ok(profile.pluginPickerSearchIterations >= 3);
    assert.ok(
      profile.powerUserCoworkEntries >= profile.powerUserCoworkWorkspaces,
    );
    assert.ok(
      profile.powerUserCoworkEntries + profile.powerUserWorktrees <
        profile.powerUserChatTabs,
    );
    assert.ok(
      profile.pluginPickerPlugins >= profile.pluginPickerSearchIterations - 2,
    );
    assert.ok(profile.scriptHoldMs > 0);
    assert.ok(profile.scriptCpuWorkers > 0);
    assert.ok(profile.scriptOutputIntervalMs > 0);
    assert.ok(profile.scriptOutputLinesPerTick > 0);
    assert.ok(profile.scriptFilesPerTick > 0);
    assert.ok(profile.scriptFileBytes > 0);
    assert.ok(profile.scriptSpawnIntervalMs > 0);
    assert.ok(profile.gitCheckoutFiles >= 6_000);
    assert.ok(profile.gitCheckoutFileBytes > 0);
    assert.ok(profile.gitTypingCharacters > 0);
    assert.ok(profile.scriptHoldMs >= 10_000);
    assert.equal(profile.sustainedTypingIntervalMs, 500);
    assert.ok(
      Math.ceil(profile.scriptHoldMs / profile.scriptOutputIntervalMs) *
        profile.scriptFilesPerTick >=
        3_200,
    );
    assert.ok(
      Math.ceil(profile.scriptHoldMs / profile.scriptOutputIntervalMs) *
        profile.scriptOutputLinesPerTick >=
        10_000,
    );
    assert.ok(profile.preexistingWorktrees > 50);
    assert.ok(profile.codeGraphBuildWorktrees >= 3);
    assert.ok(profile.codeGraphFixtureFilesPerWorktree >= 1_200);
  }
});

test('smoke chat streams remain active through multi-tab setup and probes', () => {
  assert.ok(PERFORMANCE_PROFILES.smoke.chatStreamMs >= 60_000);
});

test('pre-existing worktree scale can be overridden for focused replays', () => {
  assert.equal(
    parsePerformanceArgs(['--preexisting-worktrees', '61']).config
      .preexistingWorktrees,
    61,
  );
  assert.throws(
    () => parsePerformanceArgs(['--preexisting-worktrees', '50']),
    /must be greater than 50/,
  );
});

test('browser profile study viewport is a closed headed-only preset', () => {
  const args = [
    '--scenarios',
    'browser-panels',
    '--headed',
    '--browser-panels-viewport',
    '1000x640',
  ];
  const options = parsePerformanceArgs(args);
  assert.deepEqual(options.viewport, { width: 1000, height: 640 });
  assert.equal(options.studyViewportPreset, 'headed-native-1000x640');
  for (const extra of [
    ['--headless'],
    ['--scenarios', 'browser-panels,startup-settle'],
    ['--browser-panels-viewport', '999x640'],
  ])
    assert.throws(() => parsePerformanceArgs([...args, ...extra]));
  assert.equal(
    parsePerformanceArgs(['--scenarios', 'browser-panels']).studyViewportPreset,
    undefined,
  );
});

test('explicit headless study requires headless browser-panels-only with canonical geometry', () => {
  const args = [
    '--scenarios',
    'browser-panels',
    '--headless',
    '--study-window-mode',
    'headless',
  ];
  const options = parsePerformanceArgs(args);
  assert.equal(options.studyWindowMode, 'hidden-native-1400x900-v1');
  assert.equal(options.studyViewportPreset, 'hidden-native-1400x900-v1');
  assert.deepEqual(options.viewport, { width: 1400, height: 900 });
  assert.equal(options.showWindow, false);
  assert.deepEqual(
    options.config,
    parsePerformanceArgs(['--scenarios', 'browser-panels']).config,
  );
  for (const extra of [
    ['--headed'],
    ['--headed', '--headless'],
    ['--scenarios', 'browser-panels,chats'],
    ['--browser-panels-viewport', '1000x640'],
    ['--study-window-mode', 'headed'],
    ['--study-window-mode', 'unknown'],
  ]) {
    assert.throws(() => parsePerformanceArgs([...args, ...extra]));
  }
  assert.throws(() =>
    parsePerformanceArgs(args.filter((x) => x !== '--headless')),
  );
  assert.equal(parsePerformanceArgs(['--headless']).studyWindowMode, undefined);
});

test('the Ledger scenarios run only when asked for, at the plan fixture size', () => {
  for (const scenario of ['ledger-panel', 'ledger-disabled-idle']) {
    assert.ok(SCENARIO_NAMES.includes(scenario));
    assert.ok(!DEFAULT_SCENARIO_NAMES.includes(scenario));
  }
  const baseline = PERFORMANCE_PROFILES.baseline;
  // 10,000 entries in the measured scope and 100,000 across 100 scopes.
  assert.equal(baseline.ledgerScopeEntries, 10_000);
  assert.equal(baseline.ledgerOtherScopes + 1, 100);
  assert.ok(
    baseline.ledgerScopeEntries +
      baseline.ledgerOtherScopes * baseline.ledgerOtherScopeEntries >=
      100_000,
  );
  for (const profile of Object.values(PERFORMANCE_PROFILES)) {
    assert.ok(profile.ledgerScopeEntries > 0);
    assert.ok(profile.ledgerRoundTrips > 0);
  }
});

test('the cost index scenario outlasts its startup delay over audit the app keeps', () => {
  // The cost index starts 60 seconds after launch (cost-index/bootstrap.ts).
  const COST_INDEX_STARTUP_DELAY_MS = 60_000;
  for (const [name, profile] of Object.entries(PERFORMANCE_PROFILES)) {
    assert.ok(
      profile.costIndexDwellMs > COST_INDEX_STARTUP_DELAY_MS + 10_000,
      name,
    );
    // Seven days is the default audit retention; older files are pruned.
    assert.ok(profile.costIndexAuditDays >= 1, name);
    assert.ok(profile.costIndexAuditDays <= 7, name);
    assert.ok(
      profile.costIndexAuditTurnsPerDay * 2 <=
        profile.costIndexAuditLinesPerDay,
      name,
    );
    assert.ok(
      profile.costIndexTypingIntervalMs < profile.costIndexDwellMs,
      name,
    );
  }
  // The stress profile matches a measured developer day (about 67,000 lines).
  assert.ok(PERFORMANCE_PROFILES.stress.costIndexAuditLinesPerDay >= 60_000);
  const smoke = parsePerformanceArgs(['--profile', 'smoke']).config;
  assert.equal(smoke.costIndexDwellMs, undefined);
  const selected = parsePerformanceArgs([
    '--profile',
    'smoke',
    '--scenarios',
    'cost-index-first-build',
  ]).config;
  assert.equal(
    selected.costIndexDwellMs,
    PERFORMANCE_PROFILES.smoke.costIndexDwellMs,
  );
});

test('opt-in scenarios stay out of the default suite and parse when requested', () => {
  assert.deepEqual(OPT_IN_SCENARIO_NAMES, [
    'sidebar-reorder',
    'browser-actions',
    'browser-agent-actions',
    'multi-chat-streaming',
    'multi-chat-streaming-sequential',
    'background-streaming',
    'chat-switch-catch-up',
    'managed-delegation-concurrency',
    'code-graph-new-worktree',
    'code-graph-small-edit',
    'claude-graph-orientation',
    'linear-reference-transcripts',
    'cost-index-first-build',
    'skill-suggestions-backfill',
    'code-review-registry-cleanup',
    'code-review-registry-cleanup-trace',
  ]);
  for (const scenario of OPT_IN_SCENARIO_NAMES) {
    assert.ok(SCENARIO_NAMES.includes(scenario), scenario);
    assert.ok(!DEFAULT_SCENARIO_NAMES.includes(scenario), scenario);
    assert.match(performanceUsage(), new RegExp(scenario));
  }
  assert.deepEqual(
    parsePerformanceArgs(['--scenarios', OPT_IN_SCENARIO_NAMES.join(',')])
      .scenarios,
    OPT_IN_SCENARIO_NAMES,
  );
});

test('browser actions have a scoped, adjustable measured count and release-like support', () => {
  const baseline = parsePerformanceArgs([
    '--profile',
    'baseline',
    '--scenarios',
    'browser-actions',
  ]);
  assert.equal(baseline.config.browserActionIterations, 50);
  assert.equal(baseline.config.browserActionWarmups, 3);
  assert.equal(
    parsePerformanceArgs([
      '--scenarios',
      'browser-actions',
      '--browser-actions-iterations',
      '7',
    ]).config.browserActionIterations,
    7,
  );
  assert.throws(() =>
    parsePerformanceArgs([
      '--scenarios',
      'browser-panels',
      '--browser-actions-iterations',
      '7',
    ]),
  );
  assert.equal(
    parsePerformanceArgs(['--release-like', '--scenarios', 'browser-actions'])
      .releaseLike,
    true,
  );
});

test('browser agent actions are opt-in with at least 30 baseline builds per group', () => {
  const baseline = parsePerformanceArgs([
    '--profile',
    'baseline',
    '--scenarios',
    'browser-agent-actions',
  ]);
  assert.deepEqual(baseline.scenarios, ['browser-agent-actions']);
  assert.equal(baseline.config.browserAgentActionsIterations, 30);
  assert.equal(baseline.config.browserAgentActionsWarmups, 3);
  assert.equal(
    parsePerformanceArgs([
      '--scenarios',
      'browser-agent-actions',
      '--browser-agent-actions-iterations',
      '7',
    ]).config.browserAgentActionsIterations,
    7,
  );
  for (const invalid of ['0', '-1', '1.5']) {
    assert.throws(() =>
      parsePerformanceArgs([
        '--scenarios',
        'browser-agent-actions',
        '--browser-agent-actions-iterations',
        invalid,
      ]),
    );
  }
  assert.throws(() =>
    parsePerformanceArgs([
      '--scenarios',
      'browser-panels',
      '--browser-agent-actions-iterations',
      '7',
    ]),
  );
  assert.ok(!DEFAULT_SCENARIO_NAMES.includes('browser-agent-actions'));
  assert.equal(
    parsePerformanceArgs([
      '--release-like',
      '--scenarios',
      'browser-agent-actions',
    ]).releaseLike,
    true,
  );
});

test('background streaming and chat catch-up share streaming sizing; catch-up also owns event count', () => {
  const streaming = parsePerformanceArgs([
    '--profile',
    'smoke',
    '--scenarios',
    'background-streaming',
  ]);
  assert.deepEqual(streaming.scenarios, ['background-streaming']);
  for (const key of Object.keys(SCENARIO_SCOPED_CONFIG_KEYS).filter((key) =>
    key.startsWith('multiChatStreaming'),
  )) {
    assert.equal(streaming.config[key], PERFORMANCE_PROFILES.smoke[key], key);
    assert.ok(
      SCENARIO_SCOPED_CONFIG_KEYS[key].includes('background-streaming'),
      key,
    );
  }
  assert.equal(
    parsePerformanceArgs([
      '--profile',
      'smoke',
      '--scenarios',
      'background-streaming',
      '--multi-chat-streaming-ms',
      '9000',
    ]).config.multiChatStreamingMs,
    9_000,
  );

  const chatSwitchCatchUp = parsePerformanceArgs([
    '--profile',
    'smoke',
    '--scenarios',
    'chat-switch-catch-up',
  ]);
  assert.deepEqual(chatSwitchCatchUp.scenarios, ['chat-switch-catch-up']);
  for (const key of Object.keys(SCENARIO_SCOPED_CONFIG_KEYS).filter((key) =>
    key.startsWith('multiChatStreaming'),
  )) {
    assert.equal(
      chatSwitchCatchUp.config[key],
      PERFORMANCE_PROFILES.smoke[key],
      key,
    );
    assert.ok(
      SCENARIO_SCOPED_CONFIG_KEYS[key].includes('chat-switch-catch-up'),
      key,
    );
  }
  assert.equal(chatSwitchCatchUp.config.chatSwitchCatchUpEvents, 4);
  assert.deepEqual(SCENARIO_SCOPED_CONFIG_KEYS.chatSwitchCatchUpEvents, [
    'chat-switch-catch-up',
  ]);
  for (const [profile, expectedEvents] of Object.entries({
    smoke: 4,
    baseline: 8,
    stress: 8,
  })) {
    assert.equal(
      parsePerformanceArgs([
        '--profile',
        profile,
        '--scenarios',
        'chat-switch-catch-up',
      ]).config.chatSwitchCatchUpEvents,
      expectedEvents,
      profile,
    );
  }
  const unrelated = parsePerformanceArgs([
    '--profile',
    'smoke',
    '--scenarios',
    'loaded-ui',
  ]);
  assert.equal('chatSwitchCatchUpEvents' in unrelated.config, false);
  assert.equal('chatSwitchCatchUpEvents' in streaming.config, false);
});

test('scenario-scoped sizing reaches only the runs that select its scenario', () => {
  const smoke = parsePerformanceArgs(['--profile', 'smoke']).config;
  for (const key of Object.keys(SCENARIO_SCOPED_CONFIG_KEYS)) {
    assert.equal(key in smoke, false, key);
    for (const profile of ['smoke', 'baseline', 'stress']) {
      assert.ok(key in PERFORMANCE_PROFILES[profile], `${profile} ${key}`);
    }
  }
  // The counters profile, and so the ratchet's recorded fingerprint, is
  // unchanged by the scoped keys.
  assert.deepEqual(
    parsePerformanceArgs(['--profile', 'counters']).config,
    smoke,
  );
  const streaming = parsePerformanceArgs([
    '--profile',
    'smoke',
    '--scenarios',
    'multi-chat-streaming-sequential',
  ]).config;
  assert.equal(streaming.multiChatStreamingChats, 5);
  assert.equal(streaming.multiChatStreamingMs, 20_000);
  assert.equal('codeGraphSmallEditLargeFiles' in streaming, false);
  const delegation = parsePerformanceArgs([
    '--profile',
    'smoke',
    '--scenarios',
    'managed-delegation-concurrency',
  ]).config;
  assert.equal(delegation.managedDelegationTranscriptBytes, 1024 * 1024);
  assert.equal(delegation.managedDelegationChildSteps, 6);
  assert.equal('multiChatStreamingMs' in delegation, false);
  assert.equal(
    PERFORMANCE_PROFILES.baseline.managedDelegationTranscriptBytes,
    8 * 1024 * 1024,
  );
  assert.deepEqual(
    parsePerformanceArgs([
      '--profile',
      'smoke',
      '--scenarios',
      'transcript-active-turn-tools',
    ]).config.transcriptToolActiveTurnSizes,
    [10, 100, 1_000],
  );
});

test('the phase 05 workloads keep their specified shape in every profile', () => {
  for (const profile of ['smoke', 'baseline', 'stress']) {
    const values = PERFORMANCE_PROFILES[profile];
    assert.deepEqual(values.transcriptToolActiveTurnSizes, [10, 100, 1_000]);
    assert.equal(values.multiChatStreamingChats, 5);
    assert.equal(values.multiChatStreamingToolIntervalMs, 300);
    // Some tool outputs exceed the 64 KiB inline limit.
    assert.ok(values.multiChatStreamingLargeOutputBytes > 64 * 1024);
    assert.ok(
      values.multiChatStreamingCommandOutputDeltas *
        values.multiChatStreamingCommandOutputDeltaBytes >
        64 * 1024,
    );
    // The large code-graph fixture is 13 times the small one.
    assert.equal(
      values.codeGraphSmallEditLargeFiles / values.codeGraphSmallEditSmallFiles,
      13,
    );
    assert.ok(values.codeGraphQueuedRefreshes >= 2);
  }
  // About three minutes of streaming at baseline; 1k/13k-file fixtures.
  assert.equal(PERFORMANCE_PROFILES.baseline.multiChatStreamingMs, 180_000);
  assert.equal(
    PERFORMANCE_PROFILES.baseline.codeGraphSmallEditSmallFiles,
    1_000,
  );
  assert.equal(
    PERFORMANCE_PROFILES.baseline.codeGraphSmallEditLargeFiles,
    13_000,
  );
});

test('phase 05 overrides and the startup trace require their scenarios', () => {
  const parsed = parsePerformanceArgs([
    '--profile',
    'smoke',
    '--scenarios',
    'multi-chat-streaming,code-graph-new-worktree',
    '--multi-chat-streaming-ms',
    '9000',
    '--code-graph-queued-refreshes',
    '4',
  ]);
  assert.equal(parsed.config.multiChatStreamingMs, 9_000);
  assert.equal(parsed.config.codeGraphQueuedRefreshes, 4);
  assert.throws(
    () => parsePerformanceArgs(['--multi-chat-streaming-ms', '9000']),
    /requires the multi-chat-streaming or multi-chat-streaming-sequential or background-streaming or chat-switch-catch-up scenario/,
  );
  assert.throws(
    () =>
      parsePerformanceArgs([
        '--scenarios',
        'multi-chat-streaming',
        '--multi-chat-streaming-ms',
        '1000',
      ]),
    /at least 5000/,
  );
  assert.throws(
    () =>
      parsePerformanceArgs([
        '--scenarios',
        'code-graph-new-worktree',
        '--code-graph-queued-refreshes',
        '1',
      ]),
    /at least two queued refreshes/,
  );
  assert.throws(
    () => parsePerformanceArgs(['--startup-trace', '--scenarios', 'loaded-ui']),
    /requires the startup-settle or startup-realistic scenario/,
  );
  const traced = parsePerformanceArgs([
    '--startup-trace',
    '--scenarios',
    'startup-settle',
  ]);
  assert.equal(traced.startupTrace, true);
  assert.equal(traced.config.startupTraceMode, 'v8-compile');
  assert.equal(
    'startupTraceMode' in
      parsePerformanceArgs(['--scenarios', 'startup-settle']).config,
    false,
  );
});

test('--renderer-code-cache-scheme seeds the experiment without changing the workload config', () => {
  const off = parsePerformanceArgs(['--scenarios', 'startup-settle']);
  assert.equal(off.rendererCodeCacheScheme, false);
  const on = parsePerformanceArgs([
    '--renderer-code-cache-scheme',
    '--scenarios',
    'startup-settle',
  ]);
  assert.equal(on.rendererCodeCacheScheme, true);
  assert.deepEqual(on.config, off.config);
});

test('--chat-switch-hover-ms applies only to chat-switch-catch-up', () => {
  const plain = parsePerformanceArgs(['--scenarios', 'chat-switch-catch-up']);
  assert.equal('chatSwitchHoverMs' in plain.config, false);
  const hovered = parsePerformanceArgs([
    '--chat-switch-hover-ms',
    '250',
    '--scenarios',
    'chat-switch-catch-up',
  ]);
  assert.equal(hovered.config.chatSwitchHoverMs, 250);
  assert.throws(
    () =>
      parsePerformanceArgs([
        '--chat-switch-hover-ms',
        '250',
        '--scenarios',
        'background-streaming',
      ]),
    /chatSwitchHoverMs override requires the chat-switch-catch-up scenario/,
  );
});

test('--cold-background-streams applies only to background-streaming', () => {
  const opened = parsePerformanceArgs(['--scenarios', 'background-streaming']);
  assert.equal('backgroundStreamingColdStart' in opened.config, false);
  const cold = parsePerformanceArgs([
    '--cold-background-streams',
    '--scenarios',
    'background-streaming',
  ]);
  assert.equal(cold.config.backgroundStreamingColdStart, true);
  assert.throws(
    () =>
      parsePerformanceArgs([
        '--cold-background-streams',
        '--scenarios',
        'chat-switch-catch-up',
      ]),
    /backgroundStreamingColdStart override requires the background-streaming scenario/,
  );
});

test('--warm-launches primes repeat-state startups on the same profile', () => {
  assert.equal(
    'startupWarmLaunches' in
      parsePerformanceArgs(['--scenarios', 'startup-settle']).config,
    false,
  );
  const warm = parsePerformanceArgs([
    '--warm-launches',
    '2',
    '--scenarios',
    'startup-settle',
  ]);
  assert.equal(warm.config.startupWarmLaunches, 2);
  assert.equal(
    parsePerformanceArgs([
      '--warm-launches=1',
      '--scenarios',
      'startup-realistic',
    ]).config.startupWarmLaunches,
    1,
  );
  assert.throws(
    () =>
      parsePerformanceArgs([
        '--warm-launches',
        '2',
        '--scenarios',
        'loaded-ui',
      ]),
    /requires the startup-settle or startup-realistic scenario/,
  );
  for (const value of ['0', '4', '1.5', 'x'])
    assert.throws(
      () =>
        parsePerformanceArgs([
          '--warm-launches',
          value,
          '--scenarios',
          'startup-settle',
        ]),
      /--warm-launches/,
    );
});

test('--repeat runs every scenario n times and stays out of the workload config', () => {
  const single = parsePerformanceArgs(['--profile', 'smoke']);
  assert.equal(single.repeat, 1);
  const repeated = parsePerformanceArgs([
    '--profile',
    'smoke',
    '--repeat',
    '5',
  ]);
  assert.equal(repeated.repeat, 5);
  assert.deepEqual(repeated.config, single.config);
  assert.equal(parsePerformanceArgs(['--repeat=3']).repeat, 3);
  for (const value of ['0', '-1', '2.5', 'many'])
    assert.throws(() => parsePerformanceArgs(['--repeat', value]), /--repeat/);
  assert.throws(() => parsePerformanceArgs(['--repeat', '101']), /exceed 100/);
  assert.throws(
    () => parsePerformanceArgs(['--profile', 'counters', '--repeat', '2']),
    /counters profile judges one run/,
  );
  assert.match(performanceUsage(), /--repeat <n>/);
});

test("--e2e-root names another checkout's E2E build and refuses release-like mode", () => {
  assert.equal(parsePerformanceArgs([]).e2eRoot, '');
  assert.equal(
    parsePerformanceArgs(['--e2e-root', '/baseline']).e2eRoot,
    '/baseline',
  );
  assert.throws(
    () => parsePerformanceArgs(['--release-like', '--e2e-root', '/baseline']),
    /--release-like-root/,
  );
  assert.match(performanceUsage(), /--e2e-root <path>/);
});

test('every scenario-scoped option names the override key its scenarios own', () => {
  assert.ok(Object.keys(SCENARIO_SCOPED_OPTIONS).length > 0);
  for (const [option, key] of Object.entries(SCENARIO_SCOPED_OPTIONS)) {
    const owners = SCENARIO_SCOPED_CONFIG_KEYS[key];
    assert.ok(owners, option);
    const parsed = parsePerformanceArgs([
      '--scenarios',
      owners[0],
      option,
      '9000',
    ]);
    assert.equal(parsed.overrides[key], 9000, option);
  }
});
