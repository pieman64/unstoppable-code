// Live browser-agent benchmark: sends real prompts to a real model in an E2E
// Canopy instance and scores correctness and efficiency. Manually run only;
// see README.md. Like the local-memory bench, it clears the build-gated LLM redirect and
// keeps the developer's provider login.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright-core';
import benchEvaluator from '../local-memory-bench-runtime.mjs';
import type { BenchProvider } from '../local-memory-bench-evaluator';
import {
  CanopyAppDriver,
  closeCanopy,
  launchCanopy,
  readChatStorageMessages,
  seedDemoWorkspaces,
  seedWorktreeChat,
} from './browser-agent-bench-harness.mjs';
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
  type ModelResult,
  type PersistedMessage,
  type Scenario,
  type ScenarioRun,
  type Scorecard,
  type TurnUsage,
} from './browser-agent-bench-evaluator';
import { allScenarios } from './scenarios';

const { modelProvider, providerAuthStatus } = benchEvaluator;

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, '../../../../..');
const scorecardDir = path.join(repoRoot, '.performance', 'browser-agent-bench');
const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CHAT_ID = 'browser-bench';
const DEFAULT_MODEL = 'haiku';
const OPENAI_PRICING: unknown = JSON.parse(
  readFileSync(
    path.join(
      repoRoot,
      'apps/web/src/lib/openai-pricing/openai-pricing.generated.json',
    ),
    'utf8',
  ),
);
// Without it agents often answer with curl, WebFetch, or a headless browser.
// Named by its actions: Codex's computer-use plugin has its own "in-app browser".
const PROMPT_SUFFIX =
  "Use Canopy's browser actions (browser.open and the other browser.* actions).";
const env = process.env;
const DEFAULT_TIMEOUT_MS = Number(
  env.CANOPY_BROWSER_BENCH_TIMEOUT_MS ?? '300000',
);
const REPEAT = Math.max(1, Number(env.CANOPY_BROWSER_BENCH_REPEAT ?? '1'));
const KEEP_DATA = env.CANOPY_BROWSER_BENCH_KEEP_DATA === '1';

function listEnv(name: string): string[] | undefined {
  const entries = env[name]
    ?.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries && entries.length > 0 ? entries : undefined;
}

function isScorecard(value: unknown): value is Scorecard {
  return (
    typeof value === 'object' &&
    value !== null &&
    'benchmark' in value &&
    value.benchmark === 'browser-agent'
  );
}

function readScorecard(file: string): Scorecard | undefined {
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  return isScorecard(parsed) ? parsed : undefined;
}

/** Earlier scorecards, newest first (file names are ISO timestamps). */
function loadScorecards(): Scorecard[] {
  if (!existsSync(scorecardDir)) return [];
  return readdirSync(scorecardDir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .reverse()
    .map((name) => {
      try {
        return readScorecard(path.join(scorecardDir, name));
      } catch {
        return undefined;
      }
    })
    .filter((card): card is Scorecard => card !== undefined);
}

function requireKnown(
  kind: string,
  requested: string[],
  known: string[],
): void {
  const unknown = requested.filter((entry) => !known.includes(entry));
  if (unknown.length > 0)
    throw new Error(`Unknown ${kind}: ${unknown.join(', ')}`);
}

/**
 * CANOPY_BROWSER_BENCH_RERUN=failed reruns what did not pass in the latest
 * scorecard for the model; a scorecard path picks that file instead.
 */
function selectScenarios(model: string, previous: Scorecard[]): Scenario[] {
  const ids = listEnv('CANOPY_BROWSER_BENCH_SCENARIOS');
  const packs = listEnv('CANOPY_BROWSER_BENCH_PACKS');
  if (ids)
    requireKnown(
      'CANOPY_BROWSER_BENCH_SCENARIOS',
      ids,
      allScenarios.map((scenario) => scenario.id),
    );
  if (packs)
    requireKnown(
      'CANOPY_BROWSER_BENCH_PACKS',
      packs,
      Array.from(new Set(allScenarios.map((scenario) => scenario.pack))),
    );
  let pool = allScenarios.filter(
    (scenario) =>
      (!ids || ids.includes(scenario.id)) &&
      (!packs || packs.includes(scenario.pack)),
  );
  const rerun = env.CANOPY_BROWSER_BENCH_RERUN?.trim();
  if (rerun) {
    const source =
      rerun === 'failed'
        ? previous.find((card) => card.models[model]?.status === 'completed')
        : readScorecard(path.resolve(rerun));
    if (!source)
      throw new Error(`No earlier scorecard for ${model} to rerun from.`);
    const failed = failedScenarioIds(source, model);
    pool = pool.filter((scenario) => failed.includes(scenario.id));
  }
  return pool;
}

function writePrivateFile(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 });
}

function seedScenario(
  userDataDir: string,
  scenario: Scenario,
  model: string,
  provider: BenchProvider,
): string {
  const demo = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = demo.workspaces[0]?.worktreePath;
  if (!worktreePath) throw new Error('The demo workspace has no worktree.');
  const modelSelection = { model, thinkingLevel: 'off' };
  writePrivateFile(
    path.join(userDataDir, 'preferences.json'),
    `${JSON.stringify(
      {
        version: 1,
        preferences: {
          defaultChatInterfaceMode: 'canopy',
          defaultWorktreeProvider: provider,
          defaultChatProvider: provider,
          defaultWorktreeModelByProvider: { [provider]: modelSelection },
          defaultChatModelByProvider: { [provider]: modelSelection },
          providerModelConfigDefaults: { [provider]: { thinkingLevel: 'off' } },
        },
      },
      null,
      2,
    )}\n`,
  );
  // The prices the web app serves, as its pricing cache: the app then prices
  // Codex turns as it does in production, with no network.
  writePrivateFile(
    path.join(userDataDir, 'openai-pricing-cache.json'),
    `${JSON.stringify({ payload: OPENAI_PRICING, fetchedAt: new Date().toISOString() })}\n`,
  );
  // The bench keeps the real provider state, so the one-time "Import projects"
  // toast would appear and, where it overlaps the Browser pane, hide the page.
  writePrivateFile(
    path.join(userDataDir, 'external-project-imports.json'),
    `${JSON.stringify({ version: 1, imports: {}, lastScanAt: null, inviteShownAt: new Date().toISOString() })}\n`,
  );
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: provider,
    activeTabId: CHAT_ID,
    tabs: [
      {
        id: CHAT_ID,
        title: scenario.title,
        providerType: provider,
        model,
        approvalMode: 'full-access',
      },
    ],
  });
  for (const [file, content] of Object.entries(
    scenario.setup?.workspaceFiles ?? {},
  ))
    writePrivateFile(path.join(worktreePath, file), content);
  return worktreePath;
}

/** Answers the native open dialog with these paths, as request_files needs. */
async function stubOpenDialog(
  electronApp: ElectronApplication,
  filePaths: string[],
): Promise<void> {
  await electronApp.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = (): Promise<Electron.OpenDialogReturnValue> =>
      Promise.resolve({ canceled: paths.length === 0, filePaths: paths });
  }, filePaths);
}

/** Runs JS in the newest tab whose URL contains `url`. */
async function readPage(
  electronApp: ElectronApplication,
  url: string,
  js: string,
): Promise<{ found: boolean; value?: unknown }> {
  return electronApp.evaluate(
    async ({ webContents }, input) => {
      const target = webContents
        .getAllWebContents()
        .filter(
          (contents) =>
            !contents.isDestroyed() && contents.getURL().includes(input.url),
        )
        .sort((left, right) => right.id - left.id)[0];
      if (!target) return { found: false };
      try {
        // A JavaScript dialog left open stops page scripts; never wait on it.
        const value: unknown = await Promise.race([
          target.executeJavaScript(input.js),
          new Promise((resolve) => {
            setTimeout(() => {
              resolve(
                'error: the page did not answer within 10 s (is a dialog open?)',
              );
            }, 10_000);
          }),
        ]);
        return { found: true, value };
      } catch (error) {
        return { found: true, value: `error: ${String(error)}` };
      }
    },
    { url, js },
  );
}

function fileReady(worktreePath: string, file: string): boolean {
  const target = path.join(worktreePath, file);
  if (!existsSync(target)) return false;
  // A trailing slash asks for a directory that is not empty.
  return file.endsWith('/')
    ? statSync(target).isDirectory() && readdirSync(target).length > 0
    : true;
}

interface TurnOutcome {
  askedUser: boolean;
  approvals: number;
  durationMs: number;
}

function readMessages(userDataDir: string): PersistedMessage[] {
  try {
    return (
      readChatStorageMessages(
        path.join(userDataDir, 'workspaces', WORKSPACE_ID),
        WORKTREE_ID,
        CHAT_ID,
      ) ?? []
    );
  } catch {
    return [];
  }
}

/**
 * Sends the prompt and answers cards until the persisted turn ends or the
 * agent asks the user a question. Cards are found anywhere in the window,
 * since a browser pane can cover the chat.
 */
async function runTurn(
  window: Page,
  scenario: Scenario,
  prompt: string,
  userDataDir: string,
): Promise<TurnOutcome> {
  const panel = window.locator('[data-testid="panel-content-chat"]:visible');
  const composer = panel.getByRole('textbox').first();
  await expect(composer).toBeVisible({ timeout: 30_000 });
  await composer.click();
  await composer.fill(prompt);
  const started = Date.now();
  // Enter, not a click: a pointer left on Send shows the Stop tooltip, which
  // overlaps the Browser pane and hides the page for the whole turn.
  await composer.press('Enter');
  const deadline = started + (scenario.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const card = window.getByTestId('tool-approval-card').first();
  const question = window.getByTestId('chat-question-prompt').first();
  let approvals = 0;
  while (Date.now() < deadline) {
    if (turnEnded(readMessages(userDataDir)))
      return { askedUser: false, approvals, durationMs: Date.now() - started };
    if (await card.isVisible().catch(() => false)) {
      const answer =
        scenario.setup?.approvals === 'deny'
          ? card
              .getByTestId('tool-approval-deny')
              .or(card.getByTestId('tool-approval-decline-files'))
          : card
              .getByTestId('tool-approval-allow')
              .or(card.getByTestId('tool-approval-choose-files'));
      await answer.first().click();
      approvals += 1;
      await window.waitForTimeout(500);
      continue;
    }
    if (await question.isVisible().catch(() => false))
      return { askedUser: true, approvals, durationMs: Date.now() - started };
    await window.waitForTimeout(1_000);
  }
  throw new Error(
    `The turn did not finish within ${String(scenario.timeoutMs ?? DEFAULT_TIMEOUT_MS)} ms.`,
  );
}

function readUsage(userDataDir: string): TurnUsage | undefined {
  const dir = path.join(userDataDir, 'agent-observability', 'audit');
  if (!existsSync(dir)) return undefined;
  const lines = readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .flatMap((name) =>
      readFileSync(path.join(dir, name), 'utf8').split('\n').filter(Boolean),
    );
  return parseAuditUsage(lines, CHAT_ID);
}

/** The audit record lands just after the turn; wait briefly for its usage. */
async function waitForUsage(
  userDataDir: string,
): Promise<TurnUsage | undefined> {
  let usage: TurnUsage | undefined;
  await expect
    .poll(
      () => {
        usage = readUsage(userDataDir);
        return (usage?.outputTokens ?? 0) > 0;
      },
      { timeout: 10_000 },
    )
    .toBe(true)
    .catch(() => undefined);
  return usage;
}

/** The persisted transcript, once the turn's final text is committed. */
async function readTranscript(
  userDataDir: string,
): Promise<PersistedMessage[]> {
  let messages: PersistedMessage[] = [];
  await expect
    .poll(
      () => {
        messages = readMessages(userDataDir);
        return replyText(messages).length > 0;
      },
      { timeout: 20_000 },
    )
    .toBe(true)
    .catch(() => undefined);
  return messages;
}

async function runScenario(
  scenario: Scenario,
  model: string,
  provider: BenchProvider,
  attempt: number,
): Promise<ScenarioRun> {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), `canopy-browser-bench-${scenario.id}-`),
  );
  const outsideDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-browser-bench-outside-'),
  );
  for (const [file, content] of Object.entries(
    scenario.setup?.outsideFiles ?? {},
  ))
    writePrivateFile(path.join(outsideDir, file), content);
  const run: ScenarioRun = {
    id: scenario.id,
    pack: scenario.pack,
    attempt,
    status: 'error',
    durationMs: 0,
    checks: [],
    reply: '',
    askedUser: false,
    approvals: 0,
  };
  let electronApp: ElectronApplication | undefined;
  let turnStarted: number | undefined;
  try {
    const worktreePath = seedScenario(userDataDir, scenario, model, provider);
    ({ electronApp } = await launchCanopy({
      userDataDir,
      preserveProviderState: true,
      env: {
        CANOPY_MOCK_LLM_BASE_URL: '',
        CANOPY_MOCK_API_KEY: '',
        CANOPY_GITHUB_API_BASE_URL: '',
        CANOPY_LINEAR_API_BASE_URL: '',
      },
    }));
    // Playwright dismisses a JavaScript dialog on any page without a dialog
    // listener, and the agent's tabs are pages too: leave dialogs to the app.
    const keepDialogs = (page: Page): void => {
      page.on('dialog', () => undefined);
    };
    electronApp.context().pages().forEach(keepDialogs);
    electronApp.context().on('page', keepDialogs);
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    if (scenario.setup?.pickFiles)
      await stubOpenDialog(
        electronApp,
        scenario.setup.pickFiles.map((file) =>
          path.resolve(worktreePath, file),
        ),
      );
    let turnError: unknown;
    const prompt = `${scenario.prompt.replaceAll('{outside}', outsideDir)} ${PROMPT_SUFFIX}`;
    turnStarted = Date.now();
    const turn = await runTurn(window, scenario, prompt, userDataDir).catch(
      (error: unknown) => {
        turnError = error;
        return undefined;
      },
    );
    await window
      .screenshot({ path: path.join(userDataDir, 'bench-window.png') })
      .catch(() => undefined);
    if (!turn) throw turnError;
    Object.assign(run, turn);
    const page = [];
    for (const check of scenario.expect.page ?? [])
      page.push(await readPage(electronApp, check.url, check.js));
    const messages = await readTranscript(userDataDir);
    const metrics = extractTurnMetrics(messages);
    const usage = await waitForUsage(userDataDir);
    if (usage) run.usage = usage;
    run.metrics = metrics;
    run.reply = replyText(messages);
    run.checks = evaluateScenario(scenario, {
      reply: run.reply,
      page,
      files: (scenario.expect.files ?? []).map((file) =>
        fileReady(worktreePath, file),
      ),
      metrics,
    });
    run.status = run.checks.every((check) => check.ok) ? 'passed' : 'failed';
  } catch (error) {
    run.error = error instanceof Error ? error.message : String(error);
    // A timed-out turn still has a transcript; keep what it shows.
    if (turnStarted !== undefined) run.durationMs = Date.now() - turnStarted;
    const messages = readMessages(userDataDir);
    run.metrics = extractTurnMetrics(messages);
    run.reply = replyText(messages);
    const usage = readUsage(userDataDir);
    if (usage) run.usage = usage;
  } finally {
    rmSync(outsideDir, { recursive: true, force: true });
    // Runs that did not pass keep their data for the digest to point at.
    const keep = KEEP_DATA || run.status !== 'passed';
    if (keep) {
      run.dataDir = userDataDir;
      process.stdout.write(`Kept ${scenario.id} userDataDir: ${userDataDir}\n`);
    }
    if (electronApp)
      await closeCanopy(electronApp, userDataDir, { keepUserData: keep });
    else if (!keep) {
      rmSync(userDataDir, { recursive: true, force: true });
      rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
    }
  }
  return run;
}

test('scores browser tooling with a live agent', async () => {
  const startedAt = new Date().toISOString();
  const stem = startedAt.replace(/[:.]/g, '-');
  const jsonPath = path.join(scorecardDir, `${stem}.json`);
  const reportPath = path.join(scorecardDir, `${stem}.md`);
  const previous = loadScorecards();
  const models = listEnv('CANOPY_BROWSER_BENCH_MODELS') ?? [DEFAULT_MODEL];
  const selection = new Map(
    models.map((model) => [model, selectScenarios(model, previous)]),
  );
  const scorecard: Scorecard = {
    schemaVersion: 1,
    benchmark: 'browser-agent',
    startedAt,
    status: 'RUNNING',
    selection: {
      models,
      scenarios: Array.from(
        new Set(
          Array.from(selection.values())
            .flat()
            .map((scenario) => scenario.id),
        ),
      ),
      repeat: REPEAT,
    },
    models: {},
  };
  const save = (): void => {
    mkdirSync(scorecardDir, { recursive: true });
    writeFileSync(jsonPath, `${JSON.stringify(scorecard, null, 2)}\n`);
    writeFileSync(
      reportPath,
      renderReport(scorecard, diffScorecards(previous, scorecard)),
    );
  };
  const authByProvider = new Map<
    BenchProvider,
    ReturnType<typeof providerAuthStatus>
  >();
  for (const [model, scenarios] of Array.from(selection)) {
    const provider = modelProvider(model);
    const auth =
      authByProvider.get(provider) ?? providerAuthStatus(provider, repoRoot);
    authByProvider.set(provider, auth);
    if (auth.kind !== 'available') {
      scorecard.models[model] = {
        provider,
        status: auth.kind === 'error' ? 'errored' : 'skipped',
        skipReason: auth.reason,
        runs: [],
      };
      save();
      continue;
    }
    const result: ModelResult = { provider, status: 'completed', runs: [] };
    scorecard.models[model] = result;
    for (const scenario of scenarios)
      for (let attempt = 1; attempt <= REPEAT; attempt += 1) {
        const run = await runScenario(scenario, model, provider, attempt);
        result.runs.push(run);
        process.stdout.write(
          `${model} ${scenario.id} #${String(attempt)}: ${run.status} in ${String(Math.round(run.durationMs / 1000))}s, ${String(run.metrics?.toolCalls ?? 0)} calls, ${String(run.metrics?.failedBrowserCalls ?? 0)} browser failed, ${String(run.usage?.outputTokens ?? 0)} tokens out${run.usage?.costUsd === undefined ? '' : `, $${run.usage.costUsd.toFixed(3)}`}${run.error ? ` (${run.error})` : ''}\n`,
        );
        save();
      }
  }
  scorecard.completedAt = new Date().toISOString();
  scorecard.status = scorecardStatus(scorecard.models);
  save();
  process.stdout.write(
    `\nBrowser agent bench: ${scorecard.status}\nScorecard: ${jsonPath}\nReport: ${reportPath}\n`,
  );
  expect(
    scorecard.status,
    `See ${reportPath}. Rerun what failed with CANOPY_BROWSER_BENCH_RERUN=failed.`,
  ).toBe('PASSED');
});
