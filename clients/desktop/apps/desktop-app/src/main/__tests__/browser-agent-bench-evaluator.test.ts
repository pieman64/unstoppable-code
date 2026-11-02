import {
  diffScorecards,
  evaluateScenario,
  extractTurnMetrics,
  failedScenarioIds,
  parseAuditUsage,
  renderReport,
  replyText,
  scorecardStatus,
  turnEnded,
  type PersistedBlock,
  type PersistedMessage,
  type Scenario,
  type ScenarioRun,
  type Scorecard,
} from '../../../tests/benchmark/browser-agent/browser-agent-bench-evaluator';
import { allScenarios } from '../../../tests/benchmark/browser-agent/scenarios';
import { theInternetScenarios } from '../../../tests/benchmark/browser-agent/scenarios/the-internet';

const T = Date.parse('2026-10-19T12:00:00.000Z');

function dispatch(
  index: number,
  action: Record<string, unknown>,
  output: unknown,
  isError = false,
  tool = 'mcp__canopy__DispatchAction',
): PersistedMessage {
  const toolUseId = `call-${String(index)}`;
  return {
    role: 'assistant',
    timestamp: T + index * 1_000,
    blocks: [
      {
        type: 'tool_use',
        toolUseId,
        toolName: tool,
        input: JSON.stringify({ action }),
      },
      {
        type: 'tool_result',
        toolUseId,
        toolName: tool,
        output: typeof output === 'string' ? output : JSON.stringify(output),
        isError,
      },
    ],
  };
}

const transcript: PersistedMessage[] = [
  { role: 'user', timestamp: T, blocks: [{ type: 'text', text: 'Go' }] },
  dispatch(
    1,
    { type: 'browser.open', url: 'https://x.test' },
    { ok: true, result: {} },
  ),
  dispatch(
    2,
    { type: 'browser.click', locator: 'page.getByText("A")' },
    { ok: false, error: { code: 'invalid_request', message: 'Bad locator' } },
  ),
  dispatch(
    4,
    { type: 'browser.click', locator: 'page.getByText("A")' },
    {
      ok: true,
      result: {
        receipt: {
          status: 'not_executed',
          error: { code: 'target_not_found' },
        },
      },
    },
  ),
  // MCP text content wrapping the same envelope.
  dispatch(5, { type: 'browser.press', key: 'Meta+V' }, [
    {
      type: 'text',
      text: JSON.stringify({
        ok: true,
        result: {
          receipt: { status: 'not_executed', error: { code: 'policy_denied' } },
        },
      }),
    },
  ]),
  dispatch(6, { type: 'browser.screenshot' }, 'tool crashed', true),
  {
    role: 'assistant',
    timestamp: T + 7_000,
    blocks: [{ type: 'text', text: 'Done: user1 and user2.' }],
  },
];

describe('extractTurnMetrics', () => {
  it('counts calls, failures by code, repeats, and approximate failed time', () => {
    const metrics = extractTurnMetrics(transcript);
    expect(metrics).toMatchObject({
      toolCalls: 5,
      failedCalls: 4,
      repeatedCalls: 1,
      screenshots: 1,
      actions: {
        'browser.open': 1,
        'browser.click': 2,
        'browser.press': 1,
        'browser.screenshot': 1,
      },
      errorCodes: {
        invalid_request: 1,
        target_not_found: 1,
        policy_denied: 1,
        tool_error: 1,
      },
      approxFailedMs: 5_000,
    });
    expect(metrics.calls[1]).toMatchObject({
      action: 'browser.click',
      failed: true,
      code: 'invalid_request',
      message: 'Bad locator',
    });
    expect(replyText(transcript)).toBe('Done: user1 and user2.');
    const timer = (completedAt?: number): PersistedMessage => ({
      role: 'system',
      blocks: [{ type: 'turn_timer', ...(completedAt ? { completedAt } : {}) }],
    });
    expect(turnEnded(transcript)).toBe(false);
    expect(turnEnded([timer(T)])).toBe(true);
    expect(turnEnded([timer(T), timer()])).toBe(false);
  });
});

describe('production transcript shapes', () => {
  it('names results by their tool use and finds failures nested in a result', () => {
    const message = dispatch(
      1,
      { type: 'browser.save_download', transferId: 't1' },
      {
        ok: true,
        result: { ok: false, error: { code: 'not_found', message: 'Gone' } },
      },
    );
    for (const block of message.blocks ?? [])
      if (block.type === 'tool_result') block.toolName = '';
    const { calls } = extractTurnMetrics([message]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      tool: 'mcp__canopy__DispatchAction',
      action: 'browser.save_download',
      failed: true,
      code: 'not_found',
    });
  });

  it('reads refusal codes from the receipt, Codex tool names, and transfer states', () => {
    const refused = dispatch(
      1,
      { type: 'browser.press', key: 'Meta+V' },
      {
        ok: false,
        error: {
          code: 'authorization_conflict',
          message: 'Refused',
          details: {
            status: 'not_executed',
            error: { code: 'policy_denied', message: 'Reserved shortcut' },
          },
        },
      },
    );
    const codex = dispatch(
      2,
      { type: 'browser.cancel_transfer', transferId: 't1' },
      {
        ok: true,
        result: { ok: true, transfer: { id: 't1', status: 'cancelled' } },
      },
      false,
      'canopy_dispatch_action',
    );
    const { calls } = extractTurnMetrics([refused, codex]);
    expect(calls[0]).toMatchObject({
      action: 'browser.press',
      code: 'policy_denied',
      message: 'Reserved shortcut',
    });
    expect(calls[1]).toMatchObject({
      action: 'browser.cancel_transfer',
      failed: false,
      transferStatus: 'cancelled',
    });
    const checks = evaluateScenario(
      {
        id: 'shapes',
        pack: 'demo',
        title: 'Shapes',
        prompt: 'Go',
        expect: {
          refusedWith: [{ action: 'browser.press', code: 'policy_denied' }],
          transferStatus: [
            { action: 'browser.cancel_transfer', status: 'cancelled' },
          ],
        },
      },
      {
        reply: '',
        page: [],
        files: [],
        metrics: extractTurnMetrics([refused, codex]),
      },
    );
    expect(checks.every((check) => check.ok)).toBe(true);
  });
});

describe('replyText', () => {
  it('grades only the text after the last tool result', () => {
    const turn: PersistedMessage[] = [
      {
        role: 'assistant',
        timestamp: T,
        blocks: [{ type: 'text', text: 'I expect user1, user2, and user3.' }],
      },
      dispatch(
        1,
        { type: 'browser.open', url: 'https://x.test' },
        'Failed',
        true,
      ),
      {
        role: 'assistant',
        timestamp: T + 2_000,
        blocks: [{ type: 'text', text: 'The page did not open.' }],
      },
    ];
    expect(replyText(turn)).toBe('The page did not open.');
    const curly = evaluateScenario(
      {
        id: 'quotes',
        pack: 'demo',
        title: 'Quotes',
        prompt: 'Go',
        allowWithoutBrowser: true,
        expect: { replyContains: ['Let\'s have "some"'] },
      },
      {
        reply: 'It says “Let’s have “some”',
        page: [],
        files: [],
        metrics: extractTurnMetrics([]),
      },
    );
    expect(curly.map((check) => check.ok)).toEqual([true]);
    const checks = evaluateScenario(
      {
        id: 'hovers',
        pack: 'demo',
        title: 'Hovers',
        prompt: 'Go',
        expect: { replyContains: ['user1', 'user2', 'user3'] },
      },
      {
        reply: replyText(turn),
        page: [],
        files: [],
        metrics: extractTurnMetrics(turn),
      },
    );
    expect(
      checks
        .filter((check) => check.name.startsWith('reply'))
        .some((check) => check.ok),
    ).toBe(false);
  });
});

describe('hovers', () => {
  it('fails when the hovers failed even if the reply names the users', () => {
    const hovers = theInternetScenarios.find(
      (scenario) => scenario.id === 'hovers',
    );
    if (!hovers) throw new Error('missing hovers scenario');
    const turn = [
      dispatch(
        1,
        { type: 'browser.hover', locator: '.figure img' },
        {
          ok: false,
          error: { code: 'invalid_target', message: 'Not shown' },
        },
      ),
      {
        role: 'assistant',
        timestamp: T + 2_000,
        blocks: [{ type: 'text', text: 'name: user1, user2, user3' }],
      },
    ];
    const checks = evaluateScenario(hovers, {
      reply: replyText(turn),
      page: [],
      files: [],
      metrics: extractTurnMetrics(turn),
    });
    expect(
      checks.find((check) => check.name === 'browser.hover succeeds')?.ok,
    ).toBe(false);
  });
});

describe('print requests', () => {
  const printScenario: Scenario = {
    id: 'print',
    pack: 'demo',
    title: 'Print',
    prompt: 'Go',
    expect: {
      transferStatus: [{ action: 'browser.handle_dialog', status: 'complete' }],
    },
  };
  const handled = (accept: boolean): PersistedMessage =>
    dispatch(
      1,
      { type: 'browser.handle_dialog', dialogId: 'p1', accept },
      {
        ok: true,
        result: {
          handled: {
            printRequestId: 'p1',
            accept,
            ...(accept ? { transfer: { id: 't1', status: 'complete' } } : {}),
          },
        },
      },
    );
  const passes = (message: PersistedMessage): boolean =>
    evaluateScenario(printScenario, {
      reply: 'Saved page.pdf',
      page: [],
      files: [],
      metrics: extractTurnMetrics([message]),
    }).every((check) => check.ok);

  it('passes only when the print was accepted and saved', () => {
    expect(passes(handled(true))).toBe(true);
    expect(passes(handled(false))).toBe(false);
  });
});

describe('usage and in-app browser checks', () => {
  it('reads the chat turn usage from the audit log, last record per id', () => {
    const line = (entry: Record<string, unknown>): string =>
      JSON.stringify(entry);
    const tokens = { input: 10, output: 300, cacheReadInputTokens: 5_000 };
    const usage = parseAuditUsage(
      [
        line({ id: 't1', chatId: 'c', eventType: 'worktree_chat', tokens: {} }),
        line({
          id: 't1',
          chatId: 'c',
          eventType: 'worktree_chat',
          tokens,
          sdkCumulativeCostUsd: 0.02,
        }),
        line({ id: 'h1', chatId: 'c', eventType: 'branch_naming', tokens }),
        line({ id: 'o1', chatId: 'other', eventType: 'worktree_chat', tokens }),
        'not json',
      ],
      'c',
    );
    expect(usage).toEqual({
      inputTokens: 5_010,
      outputTokens: 300,
      cacheReadTokens: 5_000,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      costUsd: 0.02,
    });
    expect(parseAuditUsage([], 'c')).toBeUndefined();
    const codex = parseAuditUsage(
      [
        line({
          id: 'x',
          chatId: 'c',
          provider: 'codex',
          eventType: 'worktree_chat',
          tokens: { input: 300, output: 4, cacheReadInputTokens: 250 },
        }),
      ],
      'c',
    );
    expect(codex).toMatchObject({ inputTokens: 300, cacheReadTokens: 250 });
    expect(codex).not.toHaveProperty('costUsd');
    const priced = parseAuditUsage(
      [
        line({
          id: 'x',
          chatId: 'c',
          provider: 'codex',
          eventType: 'worktree_chat',
          tokens: { input: 300, output: 4 },
          observedCost: { status: 'priced', totalUsd: 0.004 },
        }),
      ],
      'c',
    );
    expect(priced?.costUsd).toBe(0.004);
  });

  it('counts only browser actions as browser failures and requires one to work', () => {
    const turn = [
      dispatch(
        1,
        { type: 'browser.open', url: 'https://x.test' },
        'Failed',
        true,
      ),
      dispatch(2, {}, 'Bad input', true, 'Workflow'),
    ];
    const metrics = extractTurnMetrics(turn);
    expect(metrics).toMatchObject({
      failedCalls: 2,
      browserCalls: 1,
      failedBrowserCalls: 1,
      errorCodes: { tool_error: 1 },
    });
    const check = (allowWithoutBrowser?: boolean): boolean[] =>
      evaluateScenario(
        {
          id: 'x',
          pack: 'demo',
          title: 'X',
          prompt: 'Go',
          ...(allowWithoutBrowser ? { allowWithoutBrowser } : {}),
          expect: {},
        },
        { reply: '', page: [], files: [], metrics },
      ).map((result) => result.ok);
    expect(check()).toEqual([false, true]);
    expect(check(true)).toEqual([]);
  });

  it('fails a scenario answered around the in-app browser', () => {
    const shell = (
      index: number,
      tool: string,
      input: unknown,
    ): PersistedBlock[] =>
      dispatch(index, {}, 'ok', false, tool).blocks?.map((block) =>
        block.type === 'tool_use'
          ? { ...block, input: JSON.stringify(input) }
          : block,
      ) ?? [];
    const turn: PersistedMessage[] = [
      {
        role: 'assistant',
        blocks: [
          ...shell(1, 'Bash', { command: 'curl -s https://x.test/large' }),
          ...shell(2, 'WebFetch', { url: 'https://x.test' }),
          ...shell(3, 'command', '/bin/zsh -lc "wget https://x.test"'),
          ...shell(4, 'mcp__cua_repl__js', { code: 'cua.createBrowserTab()' }),
          ...shell(5, 'Bash', { command: 'ls tmp' }),
          // Codex's persisted search tool, and curl past the clipped input.
          ...shell(7, 'web_search', { query: 'the-internet large' }),
          ...shell(8, 'Bash', {
            command: `echo ${'x'.repeat(400)} && curl https://x.test`,
          }),
        ],
      },
      // An action sent as a JSON string is still a browser action.
      dispatch(6, {}, { ok: true, result: {} }),
    ];
    const last = turn[1]?.blocks?.[0];
    if (last)
      last.input = JSON.stringify({
        action: JSON.stringify({ type: 'browser.open', url: 'https://x.test' }),
      });
    const metrics = extractTurnMetrics(turn);
    expect(metrics).toMatchObject({ otherWebCalls: 6, browserCalls: 1 });
    expect(
      evaluateScenario(
        { id: 'x', pack: 'demo', title: 'X', prompt: 'Go', expect: {} },
        { reply: '', page: [], files: [], metrics },
      ),
    ).toEqual([
      { name: 'uses the in-app browser', ok: true },
      {
        name: 'reaches the web only through the in-app browser',
        ok: false,
        detail: 'Bash, WebFetch, command, mcp__cua_repl__js, web_search, Bash',
      },
    ]);
  });
});

describe('evaluateScenario', () => {
  const scenario: Scenario = {
    id: 'demo',
    pack: 'demo',
    title: 'Demo',
    prompt: 'Go',
    expect: {
      replyContains: ['USER1'],
      replyMatches: ['user\\d and'],
      page: [
        { url: 'x.test', js: 'checked', equals: [true, false] },
        { url: 'x.test/never', js: 'done', equals: false, passIfNoTab: true },
      ],
      files: ['tmp/out/'],
      actionsUsed: ['browser.press'],
      actionsSucceeded: ['browser.open'],
      actionsNotUsed: ['browser.drag'],
      refusedWith: [{ action: 'browser.press', code: 'policy_denied' }],
    },
  };

  it('passes every kind of check when the turn meets them', () => {
    const checks = evaluateScenario(scenario, {
      reply: replyText(transcript),
      page: [{ found: true, value: [true, false] }, { found: false }],
      files: [true],
      metrics: extractTurnMetrics(transcript),
    });
    expect(checks.filter((check) => !check.ok)).toEqual([]);
    expect(checks).toHaveLength(11);
  });

  it('fails a page check on a wrong value or a missing tab', () => {
    const checks = evaluateScenario(
      {
        ...scenario,
        allowWithoutBrowser: true,
        expect: { page: scenario.expect.page },
      },
      {
        reply: '',
        page: [
          { found: true, value: [false, false] },
          { found: true, value: true },
        ],
        files: [],
        metrics: extractTurnMetrics([]),
      },
    );
    expect(checks.map((check) => check.ok)).toEqual([false, false]);
    expect(checks[0]?.detail).toBe('got [false,false], want [true,false]');
  });

  it('fails a tab-count check when a link opened no tab or a second one', () => {
    const grade = (tabs: number): boolean[] =>
      evaluateScenario(
        {
          ...scenario,
          allowWithoutBrowser: true,
          expect: {
            page: [{ url: 'example.com', js: 'true', equals: true, tabs: 1 }],
          },
        },
        {
          reply: '',
          page: [{ found: tabs > 0, value: true, tabs }],
          files: [],
          metrics: extractTurnMetrics([]),
        },
      ).map((check) => check.ok);
    expect(grade(1)).toEqual([true, true]);
    expect(grade(2)).toEqual([true, false]);
    expect(grade(0)).toEqual([false, false]);
  });
});

function run(
  id: string,
  status: ScenarioRun['status'],
  toolCalls: number,
): ScenarioRun {
  return {
    id,
    pack: 'demo',
    attempt: 1,
    status,
    durationMs: 10_000,
    checks:
      status === 'passed' ? [] : [{ name: 'reply contains "x"', ok: false }],
    reply: 'reply',
    askedUser: false,
    approvals: 0,
    metrics: { ...extractTurnMetrics([]), toolCalls },
    usage: {
      inputTokens: 1_500,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      costUsd: 0.01,
    },
  };
}

function card(startedAt: string, runs: ScenarioRun[]): Scorecard {
  return {
    schemaVersion: 1,
    benchmark: 'browser-agent',
    startedAt,
    status: 'FAILED',
    selection: {
      models: ['haiku'],
      scenarios: runs.map((entry) => entry.id),
      repeat: 1,
    },
    models: { haiku: { provider: 'claude', status: 'completed', runs } },
  };
}

describe('scorecards', () => {
  const older = card('2026-10-18T00:00:00.000Z', [
    run('a', 'failed', 9),
    run('b', 'passed', 4),
  ]);
  const newer = card('2026-10-19T00:00:00.000Z', [run('a', 'passed', 5)]);

  it('diffs a targeted rerun against each scenario’s latest earlier run', () => {
    const diffs = diffScorecards([older], newer);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({
      id: 'a',
      previous: { passed: 0, toolCalls: 9 },
      current: { passed: 1, toolCalls: 5 },
    });
    const report = renderReport(newer, diffScorecards([older], newer));
    expect(report).toContain(
      '| a | 1/1 (was 0/1) | 10 | 5.0 | 0.0 | 0.0 | 1.5k/200 | 0.010 | 0 | -4.0 | 0.0 |',
    );
    expect(report).toContain('cost $0.01 (1 scenarios priced)');
  });

  it('counts failed browser actions in scorecards written before the count existed', () => {
    const metrics = extractTurnMetrics([
      dispatch(1, { type: 'browser.click', locator: '#x' }, 'Failed', true),
    ]);
    const { browserCalls, failedBrowserCalls, ...legacyMetrics } = metrics;
    expect([browserCalls, failedBrowserCalls]).toEqual([1, 1]);
    const legacy = card('2026-10-18T00:00:00.000Z', [
      { ...run('a', 'failed', 1), metrics: legacyMetrics },
    ]);
    const current = card('2026-10-19T00:00:00.000Z', [
      { ...run('a', 'failed', 1), metrics },
    ]);
    expect(diffScorecards([legacy], current)[0]).toMatchObject({
      previous: { failedBrowserCalls: 1 },
      current: { failedBrowserCalls: 1 },
    });
  });

  it('selects what failed and grades the run', () => {
    expect(failedScenarioIds(older, 'haiku')).toEqual(['a']);
    expect(failedScenarioIds(older, 'gpt-5.5')).toEqual([]);
    expect(scorecardStatus(older.models)).toBe('FAILED');
    expect(scorecardStatus(newer.models)).toBe('PASSED');
    expect(
      scorecardStatus({
        haiku: { provider: 'claude', status: 'skipped', runs: [] },
      }),
    ).toBe('SKIPPED');
  });
});

describe('scenarios', () => {
  it('have unique ids and at least one check each', () => {
    const ids = allScenarios.map((scenario) => scenario.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const scenario of allScenarios)
      expect(Object.keys(scenario.expect).length).toBeGreaterThan(0);
  });
});
