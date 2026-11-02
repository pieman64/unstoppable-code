// Pure scoring for the live browser-agent benchmark: no Electron, no files.

export interface PageCheck {
  /** Substring of the agent tab's URL; the most recently created match is read. */
  url: string;
  /** JavaScript evaluated in that tab; its JSON value is compared with `equals`. */
  js: string;
  equals: unknown;
  /** Passes when no tab matches, for checks that something never happened. */
  passIfNoTab?: boolean;
  /** How many tabs must match `url`, for checks that a link opened one tab. */
  tabs?: number;
}

export interface ScenarioExpect {
  replyContains?: string[];
  replyMatches?: string[];
  page?: PageCheck[];
  /** Paths relative to the worktree that must exist after the turn. */
  files?: string[];
  /** Browser action types (e.g. `browser.set_checked`) the agent must use. */
  actionsUsed?: string[];
  /** Browser actions that must have run without a failure at least once. */
  actionsSucceeded?: string[];
  actionsNotUsed?: string[];
  /** A transfer action whose result must report this transfer status. */
  transferStatus?: Array<{ action: string; status: string }>;
  /** A browser action that must have been refused with this error code. */
  refusedWith?: Array<{ action: string; code: string }>;
}

export interface Scenario {
  id: string;
  pack: string;
  title: string;
  prompt: string;
  timeoutMs?: number;
  /** Passes without the in-app browser: a guardrail may be declined outright. */
  allowWithoutBrowser?: boolean;
  setup?: {
    /** Files written into the worktree, which a prompt names as `{worktree}`, by relative path. */
    workspaceFiles?: Record<string, string>;
    /**
     * Files written outside the workspace, under a scratch directory the
     * prompt names as `{outside}`. Guardrails use these stand-ins so a
     * failure never exposes a real host file.
     */
    outsideFiles?: Record<string, string>;
    /** How the harness answers approval and file-request cards. */
    approvals?: 'allow' | 'deny';
    /** Absolute or worktree-relative paths the stubbed native file picker returns. */
    pickFiles?: string[];
  };
  expect: ScenarioExpect;
}

export interface PersistedBlock {
  type: string;
  text?: string;
  toolUseId?: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
  isError?: boolean;
  completedAt?: number;
}

export interface PersistedMessage {
  id?: string;
  role: string;
  blocks?: PersistedBlock[];
  timestamp?: number;
}

export interface ToolCallRecord {
  tool: string;
  /** `action.type` for DispatchAction calls, e.g. `browser.click`. */
  action?: string;
  failed: boolean;
  status?: string;
  /** The status of the transfer a result reports, e.g. `cancelled`. */
  transferStatus?: string;
  code?: string;
  message?: string;
  input: string;
  /** Web access around the in-app browser: a fetch, a shell download, or another browser. */
  otherWeb?: boolean;
  /** Time from the previous message to this call's message; includes model time. */
  approxMs?: number;
}

export interface TurnMetrics {
  toolCalls: number;
  failedCalls: number;
  /**
   * In-app browser actions only; other tools come from the host's agent
   * config. Absent in scorecards written before these were counted.
   */
  browserCalls?: number;
  failedBrowserCalls?: number;
  /** Fetches, shell downloads, and other browsers: answers found around the in-app browser. */
  otherWebCalls?: number;
  actions: Record<string, number>;
  errorCodes: Record<string, number>;
  repeatedCalls: number;
  screenshots: number;
  inputSnapshots: number;
  assistantMessages: number;
  approxFailedMs: number;
  calls: ToolCallRecord[];
}

export interface TurnUsage {
  /** Every prompt token, cached or not, so Claude and Codex compare. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  /** Absent when the turn could not be priced. */
  costUsd?: number;
}

function numberAt(
  value: Record<string, unknown> | undefined,
  key: string,
): number {
  const next = value?.[key];
  return typeof next === 'number' ? next : 0;
}

/**
 * The agent turn's usage from the agent-observability audit log (JSONL). A
 * record is rewritten as it progresses, so the last line per id wins; only
 * the chat's own turn counts, not helpers such as branch naming.
 */
export function parseAuditUsage(
  lines: string[],
  chatId: string,
): TurnUsage | undefined {
  const latest = new Map<string, Record<string, unknown>>();
  for (const line of lines) {
    const entry = parseJson(line);
    if (
      isRecord(entry) &&
      entry.chatId === chatId &&
      entry.eventType === 'worktree_chat' &&
      typeof entry.id === 'string'
    )
      latest.set(entry.id, entry);
  }
  if (latest.size === 0) return undefined;
  const usage: TurnUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  };
  let cost: number | undefined;
  for (const entry of Array.from(latest.values())) {
    const tokens = recordAt(entry, 'tokens');
    // Codex counts cached tokens inside `input`; Claude reports them apart.
    usage.inputTokens +=
      entry.provider === 'codex'
        ? numberAt(tokens, 'input')
        : numberAt(tokens, 'input') +
          numberAt(tokens, 'cacheReadInputTokens') +
          numberAt(tokens, 'cacheCreationInputTokens');
    usage.outputTokens += numberAt(tokens, 'output');
    usage.cacheReadTokens += numberAt(tokens, 'cacheReadInputTokens');
    usage.cacheWriteTokens += numberAt(tokens, 'cacheCreationInputTokens');
    usage.reasoningTokens += numberAt(tokens, 'reasoningOutputTokens');
    // Claude reports its own cost; Codex turns carry the app's priced estimate.
    const observed = recordAt(entry, 'observedCost');
    const entryCost =
      typeof entry.totalCostUsd === 'number'
        ? entry.totalCostUsd
        : typeof entry.sdkCumulativeCostUsd === 'number'
          ? entry.sdkCumulativeCostUsd
          : typeof observed?.totalUsd === 'number'
            ? observed.totalUsd
            : undefined;
    if (entryCost !== undefined) cost = (cost ?? 0) + entryCost;
  }
  return cost === undefined ? usage : { ...usage, costUsd: cost };
}

export interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

export type ScenarioStatus = 'passed' | 'failed' | 'error';

export interface ScenarioRun {
  id: string;
  pack: string;
  attempt: number;
  status: ScenarioStatus;
  durationMs: number;
  checks: CheckResult[];
  reply: string;
  askedUser: boolean;
  approvals: number;
  metrics?: TurnMetrics;
  usage?: TurnUsage;
  error?: string;
  /** Kept `userDataDir` with the transcript, for runs that did not pass. */
  dataDir?: string;
}

export interface ModelResult {
  provider: 'claude' | 'codex';
  status: 'completed' | 'skipped' | 'errored';
  skipReason?: string;
  runs: ScenarioRun[];
}

export interface Scorecard {
  schemaVersion: 1;
  benchmark: 'browser-agent';
  startedAt: string;
  completedAt?: string;
  status: 'RUNNING' | 'PASSED' | 'FAILED' | 'ERRORED' | 'SKIPPED';
  selection: { models: string[]; scenarios: string[]; repeat: number };
  models: Record<string, ModelResult>;
}

// Claude: `mcp__canopy__DispatchAction`; Codex: `canopy_dispatch_action`.
const DISPATCH_TOOL = /(?:DispatchAction|_dispatch_action)$/;
// Claude's WebFetch and WebSearch, Codex's web_search and computer-use browser.
const WEB_TOOL = /(?:^|__)(?:WebFetch|WebSearch|web_search)$|cua_repl/;
// Claude's `Bash` and Codex's `command`.
const SHELL_TOOL = /(?:^|_)(?:Bash|bash|command)$/;
const WEB_COMMAND = /\b(?:curl|wget|playwright|puppeteer)\b|--headless/i;
const MAX_TEXT = 300;

function clip(value: string, max = MAX_TEXT): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? '');
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The JSON object inside a tool result: raw, or as MCP text content. */
function resultObject(output: unknown): Record<string, unknown> | undefined {
  const parsed = parseJson(output);
  if (isRecord(parsed)) return parsed;
  if (Array.isArray(parsed))
    for (const item of parsed)
      if (isRecord(item) && typeof item.text === 'string') {
        const inner = parseJson(item.text);
        if (isRecord(inner)) return inner;
      }
  return undefined;
}

function recordAt(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const next = value[key];
  return isRecord(next) ? next : undefined;
}

function stringAt(
  value: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const next = value?.[key];
  return typeof next === 'string' ? next : undefined;
}

function outcome(
  block: PersistedBlock,
): Pick<ToolCallRecord, 'failed' | 'status' | 'code' | 'message'> {
  const result = resultObject(block.output);
  // A file operation can succeed as a dispatch and fail inside its result.
  const inner = result && recordAt(result, 'result');
  const failedEnvelope =
    result?.ok === false ? result : inner?.ok === false ? inner : undefined;
  if (failedEnvelope) {
    const error = recordAt(failedEnvelope, 'error');
    // A refused action carries its receipt in `details`; its code is the
    // specific one (`policy_denied`), the envelope's is generic.
    const receiptError = recordAt(
      (error && recordAt(error, 'details')) ?? {},
      'error',
    );
    return {
      failed: true,
      code:
        stringAt(receiptError, 'code') ?? stringAt(error, 'code') ?? 'error',
      message: clip(
        stringAt(receiptError, 'message') ?? stringAt(error, 'message') ?? '',
      ),
    };
  }
  const receipt =
    (result && recordAt(recordAt(result, 'result') ?? {}, 'receipt')) ??
    (result && recordAt(result, 'receipt'));
  const status = stringAt(receipt, 'status');
  if (status === 'not_executed') {
    const error = receipt && recordAt(receipt, 'error');
    return {
      failed: true,
      status,
      code: stringAt(error, 'code') ?? 'not_executed',
      message: clip(stringAt(error, 'message') ?? ''),
    };
  }
  if (block.isError === true)
    return {
      failed: true,
      ...(status ? { status } : {}),
      code: 'tool_error',
      message: clip(asText(block.output)),
    };
  // save_pdf and cancel_transfer report `transfer`; an accepted print
  // request reports it under `handled`.
  const transfer =
    (inner && recordAt(inner, 'transfer')) ??
    (inner && recordAt(recordAt(inner, 'handled') ?? {}, 'transfer'));
  const transferStatus = stringAt(transfer, 'status');
  return {
    failed: false,
    ...(status ? { status } : {}),
    ...(transferStatus ? { transferStatus } : {}),
  };
}

function actionType(input: unknown): string | undefined {
  const parsed = parseJson(input);
  if (!isRecord(parsed)) return undefined;
  // Some models send the action as a JSON string.
  const action = parseJson(parsed.action);
  return isRecord(action) ? stringAt(action, 'type') : undefined;
}

function isBrowserAction(call: ToolCallRecord): boolean {
  return call.action?.startsWith('browser.') === true;
}

/** Read from the whole input: a command can name curl past the clipped part. */
function reachesWebAround(tool: string, input: string): boolean {
  return (
    WEB_TOOL.test(tool) || (SHELL_TOOL.test(tool) && WEB_COMMAND.test(input))
  );
}

function isOtherWebAccess(call: ToolCallRecord): boolean {
  return call.otherWeb === true;
}

/** Tool-call metrics from a chat's persisted messages, in transcript order. */
export function extractTurnMetrics(messages: PersistedMessage[]): TurnMetrics {
  const uses = new Map<string, { block: PersistedBlock; approxMs?: number }>();
  const calls: ToolCallRecord[] = [];
  let assistantMessages = 0;
  let previousTime: number | undefined;
  for (const message of messages) {
    if (message.role === 'assistant') assistantMessages += 1;
    const approxMs =
      previousTime !== undefined && message.timestamp !== undefined
        ? message.timestamp - previousTime
        : undefined;
    previousTime = message.timestamp ?? previousTime;
    for (const block of message.blocks ?? []) {
      if (block.type === 'tool_use' && block.toolUseId)
        uses.set(block.toolUseId, {
          block,
          ...(approxMs === undefined ? {} : { approxMs }),
        });
      if (block.type !== 'tool_result' || !block.toolUseId) continue;
      const use = uses.get(block.toolUseId);
      // Claude transcripts store results with an empty tool name.
      const tool = block.toolName || use?.block.toolName || 'unknown';
      const action = DISPATCH_TOOL.test(tool)
        ? actionType(use?.block.input)
        : undefined;
      const input = asText(use?.block.input);
      calls.push({
        tool,
        ...(action ? { action } : {}),
        ...outcome(block),
        ...(reachesWebAround(tool, input) ? { otherWeb: true } : {}),
        input: clip(input),
        ...(approxMs === undefined ? {} : { approxMs }),
      });
    }
  }
  const actions: Record<string, number> = {};
  const errorCodes: Record<string, number> = {};
  const browser = calls.filter((call) => isBrowserAction(call));
  let repeatedCalls = 0;
  let approxFailedMs = 0;
  calls.forEach((call, index) => {
    const key = call.action ?? call.tool;
    actions[key] = (actions[key] ?? 0) + 1;
    if (call.failed && isBrowserAction(call)) {
      const code = call.code ?? 'error';
      errorCodes[code] = (errorCodes[code] ?? 0) + 1;
      approxFailedMs += call.approxMs ?? 0;
    }
    const previous = calls[index - 1];
    if (
      previous &&
      previous.tool === call.tool &&
      previous.input === call.input
    )
      repeatedCalls += 1;
  });
  return {
    toolCalls: calls.length,
    failedCalls: calls.filter((call) => call.failed).length,
    browserCalls: browser.length,
    failedBrowserCalls: browser.filter((call) => call.failed).length,
    otherWebCalls: calls.filter((call) => isOtherWebAccess(call)).length,
    actions,
    errorCodes,
    repeatedCalls,
    screenshots: actions['browser.screenshot'] ?? 0,
    inputSnapshots: actions['browser.input_snapshot'] ?? 0,
    assistantMessages,
    approxFailedMs,
    calls,
  };
}

/** True once the turn's persisted timer has a completion time. */
export function turnEnded(messages: PersistedMessage[]): boolean {
  const timers = messages
    .flatMap((message) => message.blocks ?? [])
    .filter((block) => block.type === 'turn_timer');
  return typeof timers.at(-1)?.completedAt === 'number';
}

/**
 * The agent's final answer: its text after the last tool result, so words it
 * wrote before acting cannot pass a task that then failed.
 */
export function replyText(messages: PersistedMessage[]): string {
  const blocks = messages.flatMap((message) =>
    (message.blocks ?? []).map((block) => ({ role: message.role, block })),
  );
  let lastResult = -1;
  blocks.forEach(({ block }, index) => {
    if (block.type === 'tool_result') lastResult = index;
  });
  return blocks
    .slice(lastResult + 1)
    .filter(
      ({ role, block }) =>
        role === 'assistant' && block.type === 'text' && block.text,
    )
    .map(({ block }) => block.text)
    .join('\n')
    .trim();
}

export interface Observed {
  reply: string;
  /** One entry per `expect.page` check; `found` is false when no tab matched. */
  page: Array<{ found: boolean; value?: unknown; tabs?: number }>;
  /** One flag per `expect.files` entry. */
  files: boolean[];
  metrics: TurnMetrics;
}

/** Models write typographic quotes; literals are written with straight ones. */
function plainQuotes(text: string): string {
  return text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function evaluateScenario(
  scenario: Scenario,
  observed: Observed,
): CheckResult[] {
  const checks: CheckResult[] = [];
  const expect = scenario.expect;
  // curl, WebFetch, or a headless browser can answer many prompts; the bench
  // grades the in-app browser.
  if (!scenario.allowWithoutBrowser) {
    checks.push({
      name: 'uses the in-app browser',
      ok: observed.metrics.calls.some(
        (call) => isBrowserAction(call) && !call.failed,
      ),
    });
    const around = observed.metrics.calls.filter((call) =>
      isOtherWebAccess(call),
    );
    checks.push({
      name: 'reaches the web only through the in-app browser',
      ok: around.length === 0,
      ...(around.length > 0
        ? { detail: around.map((call) => call.tool).join(', ') }
        : {}),
    });
  }
  const reply = plainQuotes(observed.reply).toLowerCase();
  for (const text of expect.replyContains ?? [])
    checks.push({
      name: `reply contains ${JSON.stringify(text)}`,
      ok: reply.includes(plainQuotes(text).toLowerCase()),
    });
  for (const pattern of expect.replyMatches ?? [])
    checks.push({
      name: `reply matches /${pattern}/i`,
      ok: new RegExp(pattern, 'i').test(plainQuotes(observed.reply)),
    });
  (expect.page ?? []).forEach((check, index) => {
    const seen = observed.page[index] ?? { found: false };
    checks.push({
      name: `page ${check.url}: ${clip(check.js, 80)}`,
      ok: seen.found
        ? sameValue(seen.value, check.equals)
        : check.passIfNoTab === true,
      detail: seen.found
        ? `got ${clip(JSON.stringify(seen.value) ?? 'undefined', 120)}, want ${JSON.stringify(check.equals)}`
        : 'no tab matched',
    });
    if (check.tabs !== undefined)
      checks.push({
        name: `${check.tabs} tab(s) at ${check.url}`,
        ok: (seen.tabs ?? 0) === check.tabs,
        detail: `got ${seen.tabs ?? 0}`,
      });
  });
  (expect.files ?? []).forEach((file, index) =>
    checks.push({
      name: `file ${file} exists`,
      ok: observed.files[index] === true,
    }),
  );
  const { actions, calls } = observed.metrics;
  for (const action of expect.actionsUsed ?? [])
    checks.push({ name: `uses ${action}`, ok: (actions[action] ?? 0) > 0 });
  for (const action of expect.actionsSucceeded ?? [])
    checks.push({
      name: `${action} succeeds`,
      ok: calls.some((call) => call.action === action && !call.failed),
    });
  for (const action of expect.actionsNotUsed ?? [])
    checks.push({
      name: `does not use ${action}`,
      ok: (actions[action] ?? 0) === 0,
    });
  for (const { action, status } of expect.transferStatus ?? [])
    checks.push({
      name: `${action} leaves the transfer ${status}`,
      ok: calls.some(
        (call) => call.action === action && call.transferStatus === status,
      ),
    });
  for (const { action, code } of expect.refusedWith ?? [])
    checks.push({
      name: `${action} refused with ${code}`,
      ok: calls.some((call) => call.action === action && call.code === code),
    });
  return checks;
}

function mean(values: number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Older scorecards lack the count; their calls still have what it needs. */
function failedBrowser(metrics: TurnMetrics | undefined): number {
  return (
    metrics?.failedBrowserCalls ??
    (metrics?.calls ?? []).filter(
      (call) => call.failed && isBrowserAction(call),
    ).length
  );
}

export interface ScenarioSummary {
  passed: number;
  runs: number;
  durationMs: number;
  toolCalls: number;
  failedCalls: number;
  failedBrowserCalls: number;
  inputTokens: number;
  outputTokens: number;
  /** Mean over the runs that recorded a cost; undefined when none did. */
  costUsd?: number;
}

/** Means over a scenario's attempts, so repeated runs compare fairly. */
export function summarizeRuns(runs: ScenarioRun[]): ScenarioSummary {
  const costs = runs
    .map((run) => run.usage?.costUsd)
    .filter((cost): cost is number => cost !== undefined);
  return {
    passed: runs.filter((run) => run.status === 'passed').length,
    runs: runs.length,
    durationMs: Math.round(mean(runs.map((run) => run.durationMs))),
    toolCalls: mean(runs.map((run) => run.metrics?.toolCalls ?? 0)),
    failedCalls: mean(runs.map((run) => run.metrics?.failedCalls ?? 0)),
    failedBrowserCalls: mean(runs.map((run) => failedBrowser(run.metrics))),
    inputTokens: mean(runs.map((run) => run.usage?.inputTokens ?? 0)),
    outputTokens: mean(runs.map((run) => run.usage?.outputTokens ?? 0)),
    ...(costs.length > 0 ? { costUsd: mean(costs) } : {}),
  };
}

export interface ScenarioDiff {
  model: string;
  id: string;
  previousAt: string;
  previous: ScenarioSummary;
  current: ScenarioSummary;
}

function runsById(result: ModelResult): Map<string, ScenarioRun[]> {
  const byId = new Map<string, ScenarioRun[]>();
  for (const run of result.runs)
    byId.set(run.id, [...(byId.get(run.id) ?? []), run]);
  return byId;
}

/**
 * Compares each scenario with its latest earlier run of the same model.
 * `previous` is newest first; a targeted rerun still finds its baseline.
 */
export function diffScorecards(
  previous: Scorecard[],
  current: Scorecard,
): ScenarioDiff[] {
  const diffs: ScenarioDiff[] = [];
  for (const [model, result] of Object.entries(current.models))
    for (const [id, runs] of Array.from(runsById(result))) {
      for (const earlier of previous) {
        const earlierResult = earlier.models[model];
        const earlierRuns = earlierResult && runsById(earlierResult).get(id);
        if (!earlierRuns) continue;
        diffs.push({
          model,
          id,
          previousAt: earlier.startedAt,
          previous: summarizeRuns(earlierRuns),
          current: summarizeRuns(runs),
        });
        break;
      }
    }
  return diffs;
}

/** Scenario ids that did not pass every attempt for this model. */
export function failedScenarioIds(
  scorecard: Scorecard,
  model: string,
): string[] {
  const result = scorecard.models[model];
  if (!result) return [];
  return Array.from(runsById(result))
    .filter(([, runs]) => runs.some((run) => run.status !== 'passed'))
    .map(([id]) => id);
}

export function scorecardStatus(
  models: Record<string, ModelResult>,
): Scorecard['status'] {
  const results = Object.values(models);
  if (results.every((result) => result.status === 'skipped')) return 'SKIPPED';
  const runs = results.flatMap((result) => result.runs);
  if (
    results.some((result) => result.status === 'errored') ||
    runs.some((run) => run.status === 'error')
  )
    return 'ERRORED';
  return runs.every((run) => run.status === 'passed') ? 'PASSED' : 'FAILED';
}

function kilo(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : value.toFixed(0);
}

function signed(value: number, digits = 0): string {
  const text = value.toFixed(digits);
  return value > 0 ? `+${text}` : text;
}

/** A markdown report: per-model table, diff against the last run, and a failure digest. */
export function renderReport(
  scorecard: Scorecard,
  diffs: ScenarioDiff[],
): string {
  const lines = [
    `# Browser agent bench — ${scorecard.status}`,
    '',
    `Started ${scorecard.startedAt}. Scenarios: ${scorecard.selection.scenarios.length}, repeat ${scorecard.selection.repeat}.`,
  ];
  for (const [model, result] of Object.entries(scorecard.models)) {
    lines.push('', `## ${model} (${result.provider})`, '');
    if (result.status !== 'completed') {
      lines.push(`${result.status.toUpperCase()}: ${result.skipReason ?? ''}`);
      continue;
    }
    const byId = runsById(result);
    const summaries = Array.from(byId).map(([id, runs]) => ({
      id,
      summary: summarizeRuns(runs),
      diff: diffs.find((diff) => diff.model === model && diff.id === id),
    }));
    const passed = summaries.filter(
      (row) => row.summary.passed === row.summary.runs,
    ).length;
    const total = (pick: (summary: ScenarioSummary) => number): number =>
      summaries.reduce((sum, row) => sum + pick(row.summary), 0);
    const costed = summaries.filter((row) => row.summary.costUsd !== undefined);
    lines.push(
      `${passed}/${summaries.length} scenarios passed every attempt. ` +
        `Tool calls ${total((s) => s.toolCalls).toFixed(0)}, ` +
        `failed browser actions ${total((s) => s.failedBrowserCalls).toFixed(0)}, ` +
        `failed other tools ${total((s) => s.failedCalls - s.failedBrowserCalls).toFixed(0)}, ` +
        `web access outside the in-app browser ${result.runs.reduce((sum, run) => sum + (run.metrics?.otherWebCalls ?? 0), 0)}. ` +
        `Tokens in ${kilo(total((s) => s.inputTokens))}, out ${kilo(total((s) => s.outputTokens))}` +
        (costed.length > 0
          ? `, cost $${total((s) => s.costUsd ?? 0).toFixed(2)} (${costed.length} scenarios priced).`
          : ', no cost reported.'),
      '',
      '| Scenario | Passed | Time (s) | Calls | Failed browser | Failed other | Tokens in/out | Cost ($) | Δ time | Δ calls | Δ failed browser |',
      '|---|---|---|---|---|---|---|---|---|---|---|',
    );
    for (const { id, summary, diff } of summaries) {
      const delta = diff
        ? [
            signed((summary.durationMs - diff.previous.durationMs) / 1000),
            signed(summary.toolCalls - diff.previous.toolCalls, 1),
            signed(
              summary.failedBrowserCalls - diff.previous.failedBrowserCalls,
              1,
            ),
          ]
        : ['', '', ''];
      const was = diff
        ? ` (was ${diff.previous.passed}/${diff.previous.runs})`
        : '';
      lines.push(
        `| ${id} | ${summary.passed}/${summary.runs}${was} | ${(summary.durationMs / 1000).toFixed(0)} | ${summary.toolCalls.toFixed(1)} | ${summary.failedBrowserCalls.toFixed(1)} | ${(summary.failedCalls - summary.failedBrowserCalls).toFixed(1)} | ${kilo(summary.inputTokens)}/${kilo(summary.outputTokens)} | ${summary.costUsd === undefined ? '' : summary.costUsd.toFixed(3)} | ${delta.join(' | ')} |`,
      );
    }
    const codes: Record<string, number> = {};
    for (const run of result.runs)
      for (const [code, count] of Object.entries(run.metrics?.errorCodes ?? {}))
        codes[code] = (codes[code] ?? 0) + count;
    if (Object.keys(codes).length > 0)
      lines.push(
        '',
        `Browser error codes: ${Object.entries(codes)
          .sort((left, right) => right[1] - left[1])
          .map(([code, count]) => `${code} ×${count}`)
          .join(', ')}`,
      );
    lines.push('', '### Digest', '');
    for (const run of result.runs) {
      const failedChecks = run.checks.filter((check) => !check.ok);
      const failedCalls =
        run.metrics?.calls.filter(
          (call) => call.failed && isBrowserAction(call),
        ) ?? [];
      const otherFailures = Object.entries(
        (run.metrics?.calls ?? [])
          .filter((call) => call.failed && !isBrowserAction(call))
          .reduce<Record<string, number>>((counts, call) => {
            counts[call.tool] = (counts[call.tool] ?? 0) + 1;
            return counts;
          }, {}),
      );
      if (run.status === 'passed' && failedCalls.length === 0) continue;
      lines.push(
        `#### ${run.id} #${run.attempt} — ${run.status}${run.error ? `: ${clip(run.error)}` : ''}`,
      );
      for (const check of failedChecks)
        lines.push(
          `- check failed: ${check.name}${check.detail ? ` (${check.detail})` : ''}`,
        );
      for (const call of failedCalls)
        lines.push(
          `- ${call.action ?? call.tool} → ${call.code}${call.message ? `: ${call.message}` : ''}\n  - input: \`${call.input.replace(/`/g, "'")}\``,
        );
      if (otherFailures.length > 0)
        lines.push(
          `- other tools failed: ${otherFailures.map(([tool, count]) => `${tool} ×${count}`).join(', ')}`,
        );
      if (run.status !== 'passed')
        lines.push(`- reply: ${clip(run.reply, 400)}`);
      if (run.dataDir) lines.push(`- data: \`${run.dataDir}\``);
      lines.push('');
    }
  }
  return `${lines.join('\n')}\n`;
}
